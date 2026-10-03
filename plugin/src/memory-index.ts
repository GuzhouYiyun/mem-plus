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
//   covers the whole memory home -- every project's captures and snapshots plus
//   the global long-term memory. That is what makes "what did I do about postgres
//   last month, anywhere" a single query. Project identity is carried on
//   `documents.project` for filtering, and `documents.path` is unique because
//   absolute paths are.
//
// FTS5 IS A PLAIN TABLE, NOT CONTENTLESS
//   `content=''` would store nothing and break `snippet()`, which is the whole
//   reason a hit is worth showing rather than just naming. The text is stored
//   twice; markdown measured in kilobytes, the cost is irrelevant and the
//   snippet is not.
import type { SQLInputValue } from "node:sqlite";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { bm25RankToScore } from "../../extensions/memory-core/src/memory/keyword-query.js";
import {
  mergeHybridResults,
  selectHybridSearchResults,
} from "../../extensions/memory-core/src/memory/hybrid.js";
import { stateRoot } from "./paths.js";
import { parseMemoryDocument, type MemoryUnit, type ParsedDocument } from "./memory-parse.js";

/** `~/.config/opencode/mem-plus/index.db`. */
export function indexPath(): string {
  return path.join(stateRoot(), "index.db");
}

/**
 * The one searchable tree. There is exactly one -- the memory home -- so the
 * value exists for schema stability, not for choosing between two.
 */
export type IndexRoot = "home";

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
  readonly startLine: number;
  readonly endLine: number;
  readonly source: string;
  readonly snippet: string;
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
  content     TEXT,
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
  return openIndexAt(indexPath());
}

/**
 * Open (creating if needed) an index at an explicit path, applying the same schema
 * and migrations as the shared one.
 *
 * Exists so an evaluation or a repair can run against a scratch database without
 * touching the user's real index. Duplicating the schema here instead would let the
 * two drift, and a test that indexes through a different schema than production is
 * testing the wrong thing.
 */
export function openIndexAt(file: string): DatabaseSync | null {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    const db = new DatabaseSync(file);
    // WAL keeps a long search from blocking the writes that follow a capture.
    db.exec("PRAGMA journal_mode = WAL");
    // ON DELETE CASCADE below is what keeps orphans out; SQLite ignores it
    // unless asked.
    db.exec("PRAGMA foreign_keys = ON");
    // Schema first, then additive column migrations: CREATE TABLE IF NOT EXISTS is
    // a no-op against an index that already exists, so an existing database would
    // otherwise be left without columns the current code reads. The order matters
    // in the other direction too -- ALTER TABLE on a table that does not exist yet
    // throws, which would make openIndex() return null on a first run.
    db.exec(SCHEMA);
    for (const [table, column, ddl] of MIGRATIONS) {
      if (hasColumn(db, table, column)) continue;
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    }
    return db;
  } catch {
    return null;
  }
}

/**
 * `documents.content` is the sha256 of the file text. It was added as a mirror
 * key when snapshots lived in two places; the layout has since collapsed to one
 * tree, but the hash is still written because the column is part of the
 * persisted schema and `unchangedDocuments` treats a NULL one as "needs a look".
 */
const MIGRATIONS: readonly (readonly [string, string, string])[] = [
  ["documents", "content", "content TEXT"],
];

function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  try {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    return rows.some((row) => row.name === column);
  } catch {
    return false;
  }
}

/** What indexing one file did. */
export type DocumentIndex = {
  /** Units actually inserted. */
  readonly written: number;
  /**
   * True when this file is a byte-identical copy of another indexed document
   * and its units were skipped. The document row is still recorded, so pruning
   * still knows the file exists.
   */
  readonly mirrored: boolean;
};

/** The sha256 of a document's text, as lowercase hex. */
function contentHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Which root owns a given content when two files hold identical bytes.
 *
 * With a single tree the comparison is always equal, which degrades to
 * "the earlier-indexed document keeps its units and the byte-identical
 * later one is recorded without them" -- a safety net against an accidental
 * duplicate file, not a layout feature.
 */
const ROOT_PRECEDENCE: Record<IndexRoot, number> = { home: 0 };

/** Insert or replace one document and its units. */
export function indexDocument(params: {
  db: DatabaseSync;
  file: string;
  root: IndexRoot;
  project: string;
  text: string;
  bytes: number;
  mtime: number;
}): DocumentIndex {
  const { db, file, root, project, text, bytes, mtime } = params;
  const parsed: ParsedDocument = parseMemoryDocument(file, text);
  const hash = contentHash(text);

  // Which document, if any, already holds these exact bytes. Excluding this
  // path is what lets an unchanged file re-index itself instead of shadowing.
  const holder = db
    .prepare(
      "SELECT id, root FROM documents WHERE content = ? AND path <> ? ORDER BY id LIMIT 1",
    )
    .get(hash, file) as { id: number; root: IndexRoot } | undefined;

  // This file is a mirror when something else with equal or better standing
  // already holds the content. Recorded, but with no units: the units live
  // under the holder, and a second copy is exactly the duplicate this removes.
  const mirrored =
    holder !== undefined && ROOT_PRECEDENCE[holder.root] <= ROOT_PRECEDENCE[root];

  const drop = db.prepare("SELECT id FROM documents WHERE path = ?");
  const existing = drop.get(file) as { id: number } | undefined;
  // Vectors are dropped by the delete below (units cascade, vectors cascade after
  // them), and computing them again costs a model load. Carry them across a
  // re-index by `ord`, which is stable for a given file layout.
  const carriedVectors =
    existing === undefined
      ? []
      : (db
          .prepare(
            `SELECT u.ord AS ord, v.dim AS dim, v.vec AS vec
             FROM units u JOIN vectors v ON v.unit_id = u.id
             WHERE u.document_id = ?`,
          )
          .all(existing.id) as { ord: number; dim: number; vec: Uint8Array }[]);
  if (existing) {
    // FTS rows are not covered by the foreign key (FTS5 virtual tables cannot
    // participate in cascades), so they are removed explicitly.
    const ftsRows = db.prepare("SELECT id FROM units WHERE document_id = ?").all(existing.id);
    const delFts = db.prepare("DELETE FROM units_fts WHERE rowid = ?");
    for (const row of ftsRows) delFts.run((row as { id: number }).id);
    db.prepare("DELETE FROM documents WHERE id = ?").run(existing.id);
  }

  // The holder lost its claim: this file is the better copy, so the mirror's
  // stale units have to go before they start competing with it.
  if (holder !== undefined && holder.id !== existing?.id && !mirrored) {
    const holderUnits = db
      .prepare("SELECT id FROM units WHERE document_id = ?")
      .all(holder.id) as { id: number }[];
    const delHolderFts = db.prepare("DELETE FROM units_fts WHERE rowid = ?");
    for (const row of holderUnits) delHolderFts.run(row.id);
    db.prepare("DELETE FROM documents WHERE id = ?").run(holder.id);
  }

  const insertDoc = db.prepare(
    `INSERT INTO documents (path, root, project, kind, title, day, content, bytes, mtime, indexed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const docResult = insertDoc.run(
    file,
    root,
    project,
    parsed.kind,
    parsed.title,
    unitsDay(parsed.units),
    hash,
    bytes,
    mtime,
    Date.now(),
  );
  const documentId = Number(docResult.lastInsertRowid);

  if (mirrored) {
    return { written: 0, mirrored: true };
  }

  const insertUnit = db.prepare(
    `INSERT INTO units (document_id, ord, kind, ts, day, entry_type, tags, marker, heading, text)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertFts = db.prepare(
    "INSERT INTO units_fts (rowid, text, heading, tags) VALUES (?, ?, ?, ?)",
  );
  const insertVector = db.prepare("INSERT INTO vectors (unit_id, dim, vec) VALUES (?, ?, ?)");
  const vectorsByOrd = new Map(carriedVectors.map((v) => [v.ord, v]));

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
    // A duplicate provenance marker means the same capture reached two files.
    // The unique index on `marker` rejects it, so the first copy wins.
    try {
      insertFts.run(unitId, unit.text, unit.heading, unit.tags.join(" "));
    } catch {
      /* duplicate marker: the unit row stands, its FTS row does not */
    }
    const vector = vectorsByOrd.get(ord);
    if (vector) insertVector.run(unitId, vector.dim, vector.vec);
    written += 1;
  });

  return { written, mirrored: false };
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
  const hash = contentHash(text);
  const doc = db.prepare("SELECT id FROM documents WHERE path = ?").get(file) as
    | { id: number }
    | undefined;

  const documentId =
    doc?.id ??
    Number(
      db
        .prepare(
          `INSERT INTO documents (path, root, project, kind, title, day, content, bytes, mtime, indexed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          file,
          root,
          project,
          parsed.kind,
          parsed.title,
          unitsDay(parsed.units),
          // The tail path only ever sees a daily entry, which is written once and
          // appended to. The hash covers the text as read now, so a mirror of it
          // is still recognised while it is being appended.
          hash,
          bytes,
          mtime,
          Date.now(),
        ).lastInsertRowid,
    );

  if (doc) {
    db.prepare(
      "UPDATE documents SET bytes = ?, mtime = ?, indexed_at = ?, title = ?, content = ? WHERE id = ?",
    ).run(bytes, mtime, Date.now(), parsed.title, hash, documentId);
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

  if (filters.currentProjectOnly) {
    if (currentProject) {
      // Home-root documents (the global MEMORY.md) carry the empty project,
      // and global long-term memory stays reachable from a project-scoped
      // search.
      parts.push("(d.project = ? OR d.project = '')");
      params.push(currentProject);
    }
  } else if (filters.project) {
    parts.push("d.project = ?");
    params.push(filters.project);
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
           units_fts.rank AS rank
    FROM units_fts
    JOIN units u      ON u.id = units_fts.rowid
    JOIN documents d  ON d.id = u.document_id
    WHERE units_fts MATCH ?
      AND units_fts.rank MATCH 'bm25()'${filter.clause}
    ORDER BY units_fts.rank
    LIMIT ?
  `;
  try {
    const rows = params.db.prepare(sql).all(match, ...filter.params, params.limit) as Record<
      string,
      unknown
    >[];
    return rows
      .map(rowToHit)
      // bm25() returns a negative number where more negative is better, and
      // openclaw's bm25RankToScore saturates it into [0, 1): r / (1 + r) where
      // r = -rank. That absolute, monotone map is what lets the 0.7 / 0.3 lane
      // weights mean anything -- an earlier version of this file fused by rank
      // (RRF) instead, which threw the magnitudes away and is not what openclaw
      // does.
      //
      // No column weights, deliberately: `bm25(units_fts, 0.0, 4.0, 3.0)` gave the
      // body a weight of zero, so only headings and tags scored and a body-only
      // match came back as rank 0 -- which bm25RankToScore maps to 1.0, the best
      // possible score. Equal weighting is also what openclaw does.
      .map((hit) => ({ ...hit, score: bm25RankToScore(hit.score) }));
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
  const text = String(row["text"] ?? "");
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
    text,
    startLine: 0,
    endLine: 0,
    source: "memory",
    snippet: text,
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
 * Ranking constants.
 *
 * These are transcribed, not tuned. `recall-verify.mjs` (the harness in
 * `~/Desktop/training`) pins each one and cites the PLAN.md line it came from --
 * TOP_K_PER_LANE=200 is PLAN:112, the 0.7/0.3 weights are the openclaw hybrid
 * split, HALF_LIFE_DAYS=30 is PLAN:114, MIN_SCORE=0.35 is PLAN:118 and
 * MMR_LAMBDA=0.7 is PLAN:122. Changing a number here means the spec moved.
 */
export const RANKING = {
  /** openclaw hybrid weights. Must sum to 1. */
  vectorWeight: 0.7,
  textWeight: 0.3,
  /** Candidates fetched per lane before fusion. */
  topKPerLane: 200,
  /**
   * Strict-recall floor. A keyword-only hit scores 0.3 * textScore, so a decent
   * one lands near 0.27 and falls under this. That is deliberate and is why
   * `selectHybridSearchResults` has the fallback below -- without it, plain text
   * search would return nothing at all.
   */
  minScore: 0.35,
  /** Temporal decay half-life, in days. */
  halfLifeDays: 30,
  /** Carbonell & Goldstein: 1 = pure relevance, 0 = pure diversity. */
  mmrLambda: 0.7,
} as const;

/**
 * Lane shapes for `mergeHybridResults`, inferred from its own signature.
 *
 * `hybrid.ts` does not export `HybridKeywordResult` / `HybridVectorResult`, and
 * re-declaring them here would be a second copy of openclaw's contract that can
 * drift. Deriving them from the function keeps one source of truth.
 */
type MergeParams = Parameters<typeof mergeHybridResults>[0];
type KeywordLane = NonNullable<MergeParams["keyword"]>[number];
type VectorLane = NonNullable<MergeParams["vector"]>[number];

/**
 * Fuse the text and vector lanes into a single ranking.
 *
 * This delegates to openclaw's `mergeHybridResults` + `selectHybridSearchResults`
 * rather than reimplementing fusion, because that pair encodes the whole tuned
 * pipeline in order: weighted hybrid score (0.7 vector / 0.3 text), temporal
 * decay, importance, project ranking, MMR re-ranking, then the strict-recall
 * floor with a keyword-only fallback for spare capacity.
 *
 * Identity: openclaw keys a hit by `source:path:startLine:endLine`, and
 * `mergeHybridResults` emits only its own field set, so the incoming `id` does
 * not survive. This index has no line granularity, so the unit id rides in
 * `startLine`/`endLine`. It is a carrier, not a line number -- and it also gives
 * the tie-break a stable order.
 *
 * An earlier version of this file fused by reciprocal rank instead. That was
 * wrong twice over: RRF is not what openclaw does, and by weighting ranks rather
 * than scores it discards exactly the magnitudes the 0.7/0.3 split exists to
 * weigh.
 */
export async function fuseRankings(params: {
  text: readonly SearchHit[];
  vector: readonly SearchHit[];
  limit: number;
  currentProject?: string;
  /** Test hook for the time-dependent decay. */
  nowMs?: number;
}): Promise<SearchHit[]> {
  const byId = new Map<number, SearchHit>();
  const keyword: KeywordLane[] = [];
  const vector: VectorLane[] = [];

  for (const hit of params.text) {
    byId.set(hit.unitId, hit);
    keyword.push({
      id: String(hit.unitId),
      path: hit.path,
      startLine: hit.unitId,
      endLine: hit.unitId,
      source: hit.source,
      snippet: hit.text,
      projectKey: hit.project,
      textScore: hit.score,
    });
  }
  for (const hit of params.vector) {
    byId.set(hit.unitId, hit);
    vector.push({
      id: String(hit.unitId),
      path: hit.path,
      startLine: hit.unitId,
      endLine: hit.unitId,
      source: hit.source,
      snippet: hit.text,
      projectKey: hit.project,
      vectorScore: hit.score,
    });
  }
  if (byId.size === 0) return [];

  const merged = await mergeHybridResults({
    vector,
    keyword,
    vectorWeight: RANKING.vectorWeight,
    textWeight: RANKING.textWeight,
    temporalDecay: { enabled: true, halfLifeDays: RANKING.halfLifeDays },
    mmr: { enabled: true, lambda: RANKING.mmrLambda },
    // The current project ranks above other projects (x1.15) and below nothing
    // (x0.9). Cross-project search stays the default because the index is shared.
    activeProjectKeys: params.currentProject ? [params.currentProject] : undefined,
    nowMs: params.nowMs,
  });
  const selected = selectHybridSearchResults({
    merged,
    keyword,
    maxResults: params.limit,
    minScore: RANKING.minScore,
  });

  return selected.flatMap((entry) => {
    const hit = byId.get(entry.startLine);
    if (!hit) return [];
    return [{ ...hit, score: entry.score }];
  });
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
  /** Test hook for the time-dependent decay. */
  nowMs?: number;
}): Promise<SearchHit[]> {
  if (params.mode === "text") {
    // Plain text search is already a single lane, so it keeps the caller's limit
    // and is not subject to the hybrid floor: the user asked for text matches,
    // not "the best text match".
    return Promise.resolve(searchText({ ...params, db: params.db }));
  }
  if (!params.queryVector) return Promise.resolve([]);
  if (params.mode === "vector") {
    return Promise.resolve(
      searchVector({ ...params, db: params.db, query: params.queryVector }),
    );
  }
  // TOP_K_PER_LANE: both lanes are fetched wide, because the fusion weights
  // reward depth -- a hit ranked 150th by text can still win on the vector lane.
  const text = searchText({ ...params, db: params.db, limit: RANKING.topKPerLane });
  const vector = searchVector({
    ...params,
    db: params.db,
    query: params.queryVector,
    limit: RANKING.topKPerLane,
  });
  return fuseRankings({
    text,
    vector,
    limit: params.limit,
    currentProject: params.currentProject,
    nowMs: params.nowMs,
  });
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