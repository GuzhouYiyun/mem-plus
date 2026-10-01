// The search index: SQLite + FTS5 over the memory markdown.
//
// DERIVED DATA, NOT A SOURCE OF TRUTH
//   Every row here is reconstructible from a file on disk, so the index is
//   disposable by design. That is what makes `memory_reindex` a real repair tool
//   rather than a migration, and it is why this schema can stay small: it stores
//   what search needs and nothing else. If a field is not needed to find,
//   filter or quote something, it does not belong here -- the file has it.
//
// SHARED ACROSS PROJECTS
//   The database lives in the config directory, not the workspace, so one index
//   covers every project on the machine plus the global archive. That is what
//   makes "what did I do about postgres last month, anywhere" a single query.
//   Project identity is carried on `documents.project` for filtering, and
//   `documents.path` is unique because absolute paths are.
//
// FTS5 IS A PLAIN TABLE, NOT CONTENTLESS
//   `content=''` would store nothing and break `snippet()`, which is the whole
//   reason a hit is worth showing rather than just naming. The text is stored
//   twice; markdown measured in kilobytes, the cost is irrelevant and the
//   snippet is not.
import type { SQLInputValue } from "node:sqlite";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { stateRoot } from "./paths.js";
import { parseMemoryDocument, type MemoryUnit, type ParsedDocument } from "./memory-parse.js";

/** `~/.config/opencode/mem-plus/index.db`. */
export function indexPath(): string {
  return path.join(stateRoot(), "index.db");
}

export type IndexRoot = "project" | "archive";

export type SearchMode = "text" | "vector" | "hybrid";

export type SearchFilters = {
  readonly project?: string;
  readonly kind?: MemoryUnit["kind"];
  readonly entryType?: string;
  readonly tag?: string;
  readonly since?: string;
  readonly until?: string;
  /** Restrict to the project the tool call came from. Omit to search everything. */
  readonly currentProjectOnly?: boolean;
};

export type SearchHit = {
  readonly unitId: number;
  readonly score: number;
  readonly project: string;
  readonly path: string;
  readonly documentKind: string;
  readonly day: string | null;
  readonly entryType: string | null;
  readonly tags: readonly string[];
  readonly marker: string | null;
  readonly heading: string;
  readonly text: string;
  readonly ts: number | null;
};

export type IndexStats = {
  readonly documents: number;
  readonly units: number;
  readonly vectors: number;
  readonly bytes: number;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS documents (
  id          INTEGER PRIMARY KEY,
  path        TEXT    NOT NULL UNIQUE,
  root        TEXT    NOT NULL,
  project     TEXT    NOT NULL,
  kind        TEXT    NOT NULL,
  title       TEXT    NOT NULL DEFAULT '',
  day         TEXT,
  bytes       INTEGER NOT NULL DEFAULT 0,
  mtime       INTEGER NOT NULL DEFAULT 0,
  indexed_at  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS documents_root    ON documents(root);
CREATE INDEX IF NOT EXISTS documents_project ON documents(project);

CREATE TABLE IF NOT EXISTS units (
  id           INTEGER PRIMARY KEY,
  document_id  INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  ord          INTEGER NOT NULL,
  kind         TEXT    NOT NULL,
  ts           INTEGER,
  day          TEXT,
  entry_type   TEXT,
  tags         TEXT    NOT NULL DEFAULT '',
  marker       TEXT,
  heading      TEXT    NOT NULL DEFAULT '',
  text         TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS units_document ON units(document_id);
CREATE INDEX IF NOT EXISTS units_day      ON units(day);
CREATE INDEX IF NOT EXISTS units_kind     ON units(kind);
CREATE UNIQUE INDEX IF NOT EXISTS units_marker ON units(marker) WHERE marker IS NOT NULL;

CREATE VIRTUAL TABLE IF NOT EXISTS units_fts USING fts5(
  text, heading, tags,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TABLE IF NOT EXISTS vectors (
  unit_id  INTEGER PRIMARY KEY REFERENCES units(id) ON DELETE CASCADE,
  dim      INTEGER NOT NULL,
  vec      BLOB    NOT NULL
);
`;

/**
 * Open (creating if needed) the shared index.
 *
 * Returns `null` instead of throwing when `node:sqlite` is unavailable. This is
 * the one dependency that cannot be worked around and cannot be polyfilled, so a
 * runtime without it must still get snapshots and extraction -- retrieval is a
 * feature, not a prerequisite for the plugin loading at all.
 */
export function openIndex(): DatabaseSync | null {
  try {
    mkdirSync(stateRoot(), { recursive: true });
    const db = new DatabaseSync(indexPath());
    // WAL keeps a long search from blocking the writes that follow a capture.
    db.exec("PRAGMA journal_mode = WAL");
    // ON DELETE CASCADE below is what keeps orphans out; SQLite ignores it
    // unless asked.
    db.exec("PRAGMA foreign_keys = ON");
    db.exec(SCHEMA);
    return db;
  } catch {
    return null;
  }
}

/** Insert or replace one document and its units. Returns units written. */
export function indexDocument(params: {
  db: DatabaseSync;
  file: string;
  root: IndexRoot;
  project: string;
  text: string;
  bytes: number;
  mtime: number;
}): number {
  const { db, file, root, project, text, bytes, mtime } = params;
  const parsed: ParsedDocument = parseMemoryDocument(file, text);

  const drop = db.prepare("SELECT id FROM documents WHERE path = ?");
  const existing = drop.get(file) as { id: number } | undefined;
  if (existing) {
    // FTS rows are not covered by the foreign key (FTS5 virtual tables cannot
    // participate in cascades), so they are removed explicitly.
    const ftsRows = db.prepare("SELECT id FROM units WHERE document_id = ?").all(existing.id);
    const delFts = db.prepare("DELETE FROM units_fts WHERE rowid = ?");
    for (const row of ftsRows) delFts.run((row as { id: number }).id);
    db.prepare("DELETE FROM documents WHERE id = ?").run(existing.id);
  }

  const insertDoc = db.prepare(
    `INSERT INTO documents (path, root, project, kind, title, day, bytes, mtime, indexed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const docResult = insertDoc.run(
    file,
    root,
    project,
    parsed.kind,
    parsed.title,
    unitsDay(parsed.units),
    bytes,
    mtime,
    Date.now(),
  );
  const documentId = Number(docResult.lastInsertRowid);

  const insertUnit = db.prepare(
    `INSERT INTO units (document_id, ord, kind, ts, day, entry_type, tags, marker, heading, text)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertFts = db.prepare(
    "INSERT INTO units_fts (rowid, text, heading, tags) VALUES (?, ?, ?, ?)",
  );

  let written = 0;
  parsed.units.forEach((unit, ord) => {
    const result = insertUnit.run(
      documentId,
      ord,
      unit.kind,
      unit.ts,
      unit.day,
      unit.entryType,
      unit.tags.join(" "),
      unit.marker,
      unit.heading,
      unit.text,
    );
    const unitId = Number(result.lastInsertRowid);
    // A duplicate provenance marker means the same capture reached two files
    // (project copy plus archive mirror). The unique index on `marker` rejects
    // it, so the project copy wins by being indexed first.
    try {
      insertFts.run(unitId, unit.text, unit.heading, unit.tags.join(" "));
    } catch {
      /* duplicate marker: the unit row stands, its FTS row does not */
    }
    written += 1;
  });

  return written;
}

/** The date a document's units share, when they agree on one. */
function unitsDay(units: readonly MemoryUnit[]): string | null {
  const days = new Set(units.map((unit) => unit.day).filter(Boolean));
  return days.size === 1 ? [...days][0]! : null;
}

/** Drop documents under `root` that are no longer present on disk. */
export function pruneMissing(params: {
  db: DatabaseSync;
  root: IndexRoot;
  present: ReadonlySet<string>;
}): string[] {
  const rows = params.db.prepare("SELECT id, path FROM documents WHERE root = ?").all(params.root);
  const remove = params.db.prepare("DELETE FROM documents WHERE id = ?");
  const removeFts = params.db.prepare(
    "SELECT id FROM units WHERE document_id = ?",
  );
  const deleteFts = params.db.prepare("DELETE FROM units_fts WHERE rowid = ?");
  const removed: string[] = [];
  for (const row of rows) {
    const { id, path: file } = row as { id: number; path: string };
    if (params.present.has(file)) continue;
    for (const unit of removeFts.all(id)) deleteFts.run((unit as { id: number }).id);
    remove.run(id);
    removed.push(file);
  }
  return removed;
}

/**
 * Drop a document's units without touching its row.
 *
 * Used right after an append: the daily entry file grows on every capture, so
 * only the new tail needs indexing. Re-reading and re-inserting a day that
 * already holds fifty entries to pick up the fifty-first is wasted work, and the
 * unique index on `marker` would fight it.
 */
export function indexAppendedTail(params: {
  db: DatabaseSync;
  file: string;
  root: IndexRoot;
  project: string;
  /** Only units whose marker is not already indexed. */
  text: string;
  bytes: number;
  mtime: number;
}): number {
  const { db, file, root, project, text, bytes, mtime } = params;
  const parsed = parseMemoryDocument(file, text);
  const doc = db.prepare("SELECT id FROM documents WHERE path = ?").get(file) as
    | { id: number }
    | undefined;

  const documentId = doc?.id ?? Number(
    db
      .prepare(
        `INSERT INTO documents (path, root, project, kind, title, day, bytes, mtime, indexed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        file,
        root,
        project,
        parsed.kind,
        parsed.title,
        unitsDay(parsed.units),
        bytes,
        mtime,
        Date.now(),
      ).lastInsertRowid,
  );

  if (doc) {
    db.prepare("UPDATE documents SET bytes = ?, mtime = ?, indexed_at = ?, title = ? WHERE id = ?").run(
      bytes,
      mtime,
      Date.now(),
      parsed.title,
      documentId,
    );
  }

  const known = new Set(
    (
      db.prepare("SELECT marker FROM units WHERE document_id = ? AND marker IS NOT NULL").all(
        documentId,
      ) as { marker: string }[]
    ).map((row) => row.marker),
  );

  const insertUnit = db.prepare(
    `INSERT INTO units (document_id, ord, kind, ts, day, entry_type, tags, marker, heading, text)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertFts = db.prepare(
    "INSERT INTO units_fts (rowid, text, heading, tags) VALUES (?, ?, ?, ?)",
  );

  let written = 0;
  parsed.units.forEach((unit, ord) => {
    if (unit.marker && known.has(unit.marker)) return;
    const result = insertUnit.run(
      documentId,
      ord,
      unit.kind,
      unit.ts,
      unit.day,
      unit.entryType,
      unit.tags.join(" "),
      unit.marker,
      unit.heading,
      unit.text,
    );
    insertFts.run(Number(result.lastInsertRowid), unit.text, unit.heading, unit.tags.join(" "));
    written += 1;
  });
  return written;
}

// --- FTS query construction ------------------------------------------------

/**
 * FTS5's own query operators, as bare words.
 *
 * Quoting makes them literals, which is the safe behaviour -- an unquoted `OR`
 * would restructure the query -- but it means `postgres OR mysql` asks for
 * documents containing the word "or", and prose is full of that word. The result
 * is a zero-hit search whose cause is invisible, so these are dropped instead.
 * The remaining terms are still ANDed, which the tool description states plainly.
 */
const FTS_OPERATORS = new Set(["and", "or", "not", "near"]);

/**
 * Quote a user query for FTS5.
 *
 * FTS5 is not a search engine: it has no implicit escaping, so a stray quote,
 * `*`, `NEAR(` or bare `-` is a syntax error and the whole query fails. Every
 * term is therefore reduced to alphanumerics and re-quoted, which turns a query
 * like `don't crash` into `don t crash` (an implicit AND, i.e. narrower) and
 * never into an error. CJK is unaffected: unicode61 emits one token per run of
 * ideographs, so a Chinese phrase matches as a phrase.
 */
export function toMatchExpression(query: string): string | null {
  const terms = query
    .replace(/[^\p{L}\p{N}_]+/gu, " ")
    .split(/\s+/)
    .filter((term) => term.length > 0)
    .filter((term) => !FTS_OPERATORS.has(term.toLowerCase()));
  if (terms.length === 0) return null;
  return terms.map((term) => `"${term}"`).join(" AND ");
}

type FilterSql = { readonly clause: string; readonly params: readonly SQLInputValue[] };

function filtersSql(filters: SearchFilters, currentProject?: string): FilterSql {
  const parts: string[] = [];
  const params: SQLInputValue[] = [];

  const project = filters.currentProjectOnly ? currentProject : filters.project;
  if (project) {
    parts.push("d.project = ?");
    params.push(project);
  }
  if (filters.kind) {
    parts.push("u.kind = ?");
    params.push(filters.kind);
  }
  if (filters.entryType) {
    parts.push("u.entry_type = ?");
    params.push(filters.entryType);
  }
  if (filters.tag) {
    // Tags are a space-joined string, so an exact token match is what is meant
    // rather than a substring (which would make "api" match "apiary").
    parts.push("(',' || replace(u.tags, ' ', ',') || ',') LIKE ?");
    params.push(`%,${filters.tag},%`);
  }
  if (filters.since) {
    parts.push("u.day >= ?");
    params.push(filters.since);
  }
  if (filters.until) {
    parts.push("u.day <= ?");
    params.push(filters.until);
  }
  return { clause: parts.length > 0 ? ` AND ${parts.join(" AND ")}` : "", params };
}

// Columns only, no FROM. Each query supplies its own FROM/JOIN: an earlier
// version inlined a constant that ended in `JOIN documents`, then appended a
// second `FROM units_fts`, producing two FROM clauses. SQLite rejected the
// statement, and the `catch` around it turned a broken query into "0 results"
// -- indistinguishable from a genuine miss.
const HIT_COLUMNS = `
  u.id AS unitId,
  d.project AS project,
  d.path    AS path,
  d.kind    AS documentKind,
  u.day     AS day,
  u.ts      AS ts,
  u.entry_type AS entryType,
  u.tags    AS tags,
  u.marker  AS marker,
  u.heading AS heading,
  u.text    AS text
`;

/** Ranked text search. */
export function searchText(params: {
  db: DatabaseSync;
  query: string;
  filters: SearchFilters;
  limit: number;
  currentProject?: string;
  /** Receives a description when the statement itself fails. */
  onError?: (message: string) => void;
}): SearchHit[] {
  const match = toMatchExpression(params.query);
  if (!match) return [];
  const filter = filtersSql(params.filters, params.currentProject);
  const sql = `
    SELECT ${HIT_COLUMNS},
           bm25(units_fts, 0.0, 4.0, 3.0) AS rank
    FROM units_fts
    JOIN units u      ON u.id = units_fts.rowid
    JOIN documents d  ON d.id = u.document_id
    WHERE units_fts MATCH ?${filter.clause}
    ORDER BY rank
    LIMIT ?
  `;
  try {
    const rows = params.db.prepare(sql).all(match, ...filter.params, params.limit) as Record<
      string,
      unknown
    >[];
    return rows
      .map(rowToHit)
      // bm25() returns a negative number where more negative is better.
      .map((hit) => ({ ...hit, score: -hit.score }));
  } catch (error) {
    // Never swallowed. A broken query that reports "no matches" is the worst
    // possible failure mode for a search tool: the model concludes the memory
    // does not exist and stops looking.
    params.onError?.(`text search failed: ${describe(error)}`);
    return [];
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function rowToHit(row: Record<string, unknown>): SearchHit {
  const tags = typeof row["tags"] === "string" ? (row["tags"] as string) : "";
  return {
    unitId: Number(row["unitId"]),
    score: Number(row["rank"] ?? 0),
    project: String(row["project"] ?? ""),
    path: String(row["path"] ?? ""),
    documentKind: String(row["documentKind"] ?? ""),
    day: (row["day"] as string | null) ?? null,
    ts: (row["ts"] as number | null) ?? null,
    entryType: (row["entryType"] as string | null) ?? null,
    tags: tags.length > 0 ? tags.split(" ").filter(Boolean) : [],
    marker: (row["marker"] as string | null) ?? null,
    heading: String(row["heading"] ?? ""),
    text: String(row["text"] ?? ""),
  };
}

// --- vectors ---------------------------------------------------------------

export function storeVector(params: {
  db: DatabaseSync;
  unitId: number;
  vector: readonly number[];
}): void {
  // Float32 is half the bytes of the Float64 the service returns and loses
  // nothing that a cosine score would notice.
  const floats = Float32Array.from(params.vector);
  params.db
    .prepare("INSERT OR REPLACE INTO vectors (unit_id, dim, vec) VALUES (?, ?, ?)")
    .run(params.unitId, floats.length, new Uint8Array(floats.buffer));
}

/** Units with no vector yet, oldest document first so a rebuild is stable. */
export function unitsMissingVectors(db: DatabaseSync, limit: number): { id: number; text: string }[] {
  return (
    db
      .prepare(
        `SELECT u.id AS id, u.text AS text
         FROM units u
         LEFT JOIN vectors v ON v.unit_id = u.id
         WHERE v.unit_id IS NULL
         ORDER BY u.id
         LIMIT ?`,
      )
      .all(limit) as { id: number; text: string }[]
  );
}

export function vectorCount(db: DatabaseSync): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM vectors").get() as { n: number }).n;
}

/** Cosine similarity over stored vectors, honouring the same filters. */
export function searchVector(params: {
  db: DatabaseSync;
  query: readonly number[];
  filters: SearchFilters;
  limit: number;
  currentProject?: string;
  /** Candidates to consider before ranking; the whole corpus is scanned. */
  candidateLimit?: number;
}): SearchHit[] {
  const filter = filtersSql(params.filters, params.currentProject);
  const sql = `
    SELECT u.id AS unitId, d.project AS project, d.path AS path, d.kind AS documentKind,
           u.day AS day, u.ts AS ts, u.entry_type AS entryType, u.tags AS tags,
           u.marker AS marker, u.heading AS heading, u.text AS text, v.vec AS vec
    FROM vectors v
    JOIN units u     ON u.id = v.unit_id
    JOIN documents d ON d.id = u.document_id
    WHERE v.dim = ?${filter.clause}
    LIMIT ?
  `;
  const rows = params.db
    .prepare(sql)
    .all(
      params.query.length,
      ...filter.params,
      params.candidateLimit ?? 20_000,
    ) as Record<string, unknown>[];

  const target = Float32Array.from(params.query);
  let norm = 0;
  for (const value of target) norm += value * value;
  norm = Math.sqrt(norm);
  if (norm === 0) return [];

  return rows
    .map((row) => {
      const bytes = row["vec"] as Uint8Array;
      const stored = new Float32Array(
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      );
      let dot = 0;
      let storedNorm = 0;
      for (const [index, value] of stored.entries()) {
        dot += value * (target[index] ?? 0);
        storedNorm += value * value;
      }
      const score = dot / (Math.sqrt(storedNorm) * norm);
      return { ...rowToHit(row), score };
    })
    .filter((hit) => Number.isFinite(hit.score))
    // Negative cosine is possible for unrelated text; there is nothing to rank
    // against it, so it is dropped rather than shown as a weak match.
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, params.limit);
}

/**
 * Fuse several rankings with reciprocal rank fusion.
 *
 * RRF is what openclaw's own hybrid search uses, and the reason is scale: the
 * two rankings have no common unit. bm25 is unbounded and negative, cosine is
 * bounded in [-1, 1], so averaging or normalising them lets whichever channel
 * happens to emit larger numbers decide the winner. Fusing on *rank* makes each
 * list contribute on its own terms.
 *
 * Takes the lists separately rather than a pre-merged array on purpose: a merged
 * array has already lost which channel found what, and ranking the concatenation
 * is just a re-sort -- the thing RRF exists to avoid.
 */
export function fuseRankings(lists: readonly (readonly SearchHit[])[], limit: number): SearchHit[] {
  const k = 60;
  const scores = new Map<number, number>();
  const best = new Map<number, SearchHit>();
  for (const list of lists) {
    // FTS5 scores are negative (more negative is better) and get negated on the
    // way out, but a zero or negative bm25 can survive that. Rank only what
    // actually matched.
    const ranked = list.filter((hit) => Number.isFinite(hit.score));
    ranked.forEach((hit, rank) => {
      scores.set(hit.unitId, (scores.get(hit.unitId) ?? 0) + 1 / (k + rank + 1));
      const held = best.get(hit.unitId);
      // Same unit from two channels: keep whichever copy has more text
      // available, since both carry the same body but may differ in truncation.
      if (!held || held.text.length < hit.text.length) best.set(hit.unitId, hit);
    });
  }
  return [...best.values()]
    .map((hit) => ({ ...hit, score: scores.get(hit.unitId) ?? 0 }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export function search(params: {
  db: DatabaseSync;
  query: string;
  mode: SearchMode;
  filters: SearchFilters;
  limit: number;
  currentProject?: string;
  /** Required for `vector` and `hybrid`; omitted for `text`. */
  queryVector?: readonly number[];
  onError?: (message: string) => void;
}): SearchHit[] {
  if (params.mode === "text") {
    return searchText({ ...params, db: params.db });
  }
  if (!params.queryVector) return [];
  if (params.mode === "vector") {
    return searchVector({ ...params, db: params.db, query: params.queryVector });
  }
  const pool = Math.max(params.limit * 4, 20);
  const text = searchText({ ...params, db: params.db, limit: pool });
  const vector = searchVector({ ...params, db: params.db, query: params.queryVector, limit: pool });
  return fuseRankings([text, vector], params.limit);
}

/** One unit with its full text, for `memory_get`. */
export function getUnit(db: DatabaseSync, unitId: number): SearchHit | null {
  const row = db
    .prepare(
      `SELECT ${HIT_COLUMNS} FROM units u JOIN documents d ON d.id = u.document_id WHERE u.id = ?`,
    )
    .get(unitId) as Record<string, unknown> | undefined;
  return row ? rowToHit(row) : null;
}

export function indexStats(db: DatabaseSync): IndexStats {
  const count = (sql: string): number =>
    (db.prepare(sql).get() as { n: number }).n;
  let bytes = 0;
  try {
    bytes = statSync(indexPath()).size;
  } catch {
    // The database may not exist yet; a missing file is a size of zero, not an
    // error worth propagating into a tool result.
    bytes = 0;
  }
  return {
    documents: count("SELECT COUNT(*) AS n FROM documents"),
    units: count("SELECT COUNT(*) AS n FROM units"),
    vectors: count("SELECT COUNT(*) AS n FROM vectors"),
    bytes,
  };
}