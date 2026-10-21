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
import { memoryHomeDir, stateRoot } from "./paths.js";
import { clearSource, writeSourceChunks } from "./memory-index-write.js";
import { ensureMemoryIndexSchema } from "./memory-index-schema.js";
import { sourceOf, WIKI_SOURCE, type IndexRoot } from "./memory-corpus.js";
import type { MemoryEntryProvenance, MemorySearchResult } from "../../packages/memory-host-sdk/src/host/types.js";
import {
  readCuratedMemoryTriggerCandidates,
  readCuratedProjectMemoryCandidates,
  readMemoryRecallMetadata,
} from "../../packages/memory-host-sdk/src/host/memory-recall-metadata.js";
import { truncateUtf16Safe } from "../../packages/normalization-core/src/utf16-slice.js";
import {
  cosineSimilarity,
  decodeMemoryEmbedding,
  encodeMemoryEmbedding,
} from "../../packages/memory-host-sdk/src/host/embedding-vector.js";

/**
 * The path upstream stores, relative to the memory home.
 *
 * Upstream indexes workspace-relative paths -- its curated whitelist is literally
 * `path IN ('MEMORY.md','USER.md')` -- while mem-plus's `documents.path` is absolute and
 * unique because absolute paths are. The relative form has to carry everything the filters
 * need, and every one of them is derivable from it:
 *
 *   curated tier   -> the path IS `MEMORY.md` or `USER.md`
 *   project scope  -> the slug is the segment under `memory/`
 *   day range      -> the date in the basename
 *   corpus         -> the `source` column, not the path
 *
 * TWO REVISIONS OF THIS FUNCTION WERE WRONG, and both only a probe over the real path
 * shapes could have caught.
 *
 * The first sliced everything after the last `memory` segment, which silently dropped the
 * project slug and left `filters.project` with nothing to match.
 *
 * The second kept that slice but had no fallback for files that live at the memory-home
 * ROOT -- which is exactly where `MEMORY.md`, `USER.md` and the wiki pages live, because
 * they have no `memory` segment. Those came out as absolute paths, so upstream's literal
 * curated whitelist `path IN ('MEMORY.md','USER.md')` would never have matched the single
 * most important file in the system. Deriving the base by looking for a `memory` segment
 * was the wrong approach twice: relativise against the memory home, which is known.
 *
 * Exported because `memory-scan.ts` needs the same relativisation to look a discovered
 * absolute path up in `memory_index_sources`. Two copies of this function would be two
 * chances to reintroduce the bug above.
 */
export function memoryRelativePath(file: string, _root?: IndexRoot): string {
  const home = memoryHomeDir().replaceAll("\\", "/").replace(/\/+$/, "");
  const normalized = file.replaceAll("\\", "/");
  if (normalized.startsWith(`${home}/`)) return normalized.slice(home.length + 1);
  // Outside the memory home -- an explicitly configured extra path. Upstream's curated
  // test is a literal path comparison, so a path outside the home is simply not curated.
  return normalized.replace(/^\/+/, "");
}

/**
 * Upstream's per-chunk provenance, which is what the curated gate and the promotion gate
 * both read. A mem-plus document with no classification produces NO provenance row rather
 * than a permissive one: upstream's gate fails closed on an absent row, and a row
 * defaulting to `agent` would silently make unclassified content promotable.
 */
function upstreamProvenance(provenance: DocumentProvenance | undefined): {
  originClass: "owner" | "agent" | "untrusted" | "system";
  sessionKind: "interactive" | "cron" | "heartbeat" | "subagent" | "unknown";
  observedAt: number;
} {
  if (!provenance) return { originClass: "untrusted", sessionKind: "unknown", observedAt: Date.now() };
  return {
    originClass: provenance.originClass as MemoryEntryProvenance["originClass"],
    sessionKind: provenance.sessionKind as MemoryEntryProvenance["sessionKind"],
    observedAt: provenance.observedAt,
  };
}

/** `~/.config/opencode/mem-plus/index.db`. */
export function indexPath(): string {
  return path.join(stateRoot(), "index.db");
}

export type { IndexRoot } from "./memory-corpus.js";

export type SearchMode = "text" | "vector" | "hybrid";

/** Which corpora a search may return. `memory` is the default so existing queries are unchanged. */
export type CorpusFilter = "memory" | "wiki" | "all";

export type SearchFilters = {
  readonly corpus?: CorpusFilter;
  readonly project?: string;
  readonly since?: string;
  readonly until?: string;
  /** Restrict to the project the tool call came from. Omit to search everything. */
  readonly currentProjectOnly?: boolean;
};

/**
 * Upstream's `MemorySearchResult`, plus three things and no more.
 *
 * THE FIFTEEN FIELDS ARE UPSTREAM'S
 *   `MemorySearchResult` (`packages/memory-host-sdk/src/host/types.ts:21`) is the whole
 *   public search shape: `path` / `startLine` / `endLine` / `score` / `vectorScore?` /
 *   `textScore?` / `snippet` / `source` / `importance?` / `triggers?` / `projectKey?` /
 *   `originClass?` (deprecated upstream) / `citation?` / `provenance?`.
 *
 *   This type used to be a strict superset of it, adding eight fields that upstream has
 *   never had -- `heading`, `tags`, `marker`, `entryType`, `ts`, `documentKind`, `text`,
 *   `root`, `project`, `day`, `curatedRoot`. Seven are gone; three survive because they
 *   are *not* search results but facts about a hit this host needs in order to filter.
 *
 *   `heading` and `tags` are gone rather than derived: upstream's chunk text has no
 *   heading structure, and writing a parser to re-extract one would be adding back
 *   something upstream does not have. See `docs/port-plan.md`, "读侧收缩".
 *
 * `startLine` / `endLine` ARE REAL DATA NOW
 *   They used to be hard-coded to 0 by `rowToHit`, because mem-plus's own `units` table
 *   has no line columns and `HIT_COLUMNS` never selected any. Upstream's chunk table has
 *   both, `chunkMarkdown` fills them, and `memory-recall-metadata.ts:219-220` selects both.
 *   So `memory_get` can be cited precisely for the first time, which is what
 *   `trigger-recall.ts:277` (`citations: [{ label: ${entry.path}#L${entry.startLine} }]`)
 *   and `project-memory.ts:119` already assumed.
 *
 * THE THREE ADDITIONS, AND WHY EACH IS NOT A SEARCH RESULT
 *   `chunkId` -- the index row identity, a six-field hash over
 *     `(source, path, startLine, endLine, chunk.hash, model)`. Not model-facing: upstream's
 *     `memory_get` takes `path`, which is why `unitId` was deleted from the tool contract.
 *     Internal joins and de-duplication need it.
 *   `project` -- the on-disk directory slug under `memory/`. This host's layout, not a
 *     search result: it partitions files, it says nothing about openclaw's project identity
 *     (which is the normalised `origin` remote and arrives separately as `projectKey`).
 *     Only used to filter and to count projects in the tool header.
 *   `day` -- the `YYYY-MM-DD` in the basename, derived. Upstream has no date on a search
 *     result; recency is temporal decay (`halfLifeDays`), which reads file mtimes. This
 *     exists solely so `since`/`until` can be applied, and for the tool header.
 */
export type SearchHit = MemorySearchResult & {
  /** The chunk row id. Never shown to the model; see the note above. */
  readonly chunkId: string;
  /** Directory slug under `memory/`. Not openclaw's project identity. */
  readonly project: string;
  /** `YYYY-MM-DD` from the basename, or null. Filter/display only. */
  readonly day: string | null;
};

export type IndexStats = {
  /** Rows in `memory_index_sources` -- one per indexed file, per corpus. */
  readonly sources: number;
  /** Rows in `memory_index_chunks`. This is what search returns. */
  readonly chunks: number;
  readonly vectors: number;
  readonly bytes: number;
};

/**
 * Open (creating if needed) the shared index.
 *
 * Returns `null` instead of throwing when the index cannot be opened, so a
 * runtime that cannot provide it still gets snapshots and extraction --
 * retrieval is a feature, not a prerequisite for the plugin loading at all.
 *
 * The cause reaches `log`. It is not always a missing `node:sqlite`: a locked
 * file or a schema this build cannot open both fail here, and a bare catch
 * reported every one of them as a missing runtime.
 */
export function openIndex(options?: { log?: (message: string) => void }): DatabaseSync | null {
  return openIndexAt(indexPath(), options?.log);
}

/**
 * Open (creating if needed) an index at an explicit path, applying the same schema
 * as the shared one.
 *
 * Exists so an evaluation or a repair can run against a scratch database without
 * touching the user's real index. Duplicating the schema here instead would let the
 * two drift, and a test that indexes through a different schema than production is
 * testing the wrong thing.
 *
 * THERE IS NO SCHEMA IN THIS FILE ANY MORE. It used to declare `documents`, `units`,
 * `units_fts` and `vectors` inline, plus a column-migration table and seven indexes.
 * Every one of those is gone and `ensureMemoryIndexSchema` is the only thing that
 * decides what a database contains -- it calls upstream's `buildMemoryIndexStrictSchema`,
 * which is upstream's own DDL. Keeping a second copy of the schema here is exactly the
 * kind of drift this port exists to remove: two sources of truth, and the search layer
 * reading whichever one was written last.
 *
 * A database carrying the old tables opens fine and simply ignores them. They are left
 * on disk rather than dropped: `DROP TABLE` is not something an index open should do to a
 * file it did not create, and the tables are read by nothing.
 */
export function openIndexAt(
  file: string,
  log?: (message: string) => void,
): DatabaseSync | null {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    const db = new DatabaseSync(file);
    // WAL keeps a long search from blocking the writes that follow a capture.
    db.exec("PRAGMA journal_mode = WAL");
    // The declared cascades are what keeps orphaned chunk rows out; SQLite ignores them
    // unless asked. `memory_index_chunks_vec` and the FTS tables are virtual and cannot
    // cascade at all, which is why `clearSource` deletes those rows explicitly.
    db.exec("PRAGMA foreign_keys = ON");
    ensureMemoryIndexSchema(db);
    return db;
  } catch (error) {
    log?.(
      `index open failed: ${file}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
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
 * openclaw's per-file classification, as `resolveMemoryPathClassification` returns it.

/**
 * openclaw's per-file classification, as `resolveMemoryPathClassification` returns it.
 * `sessionKind` and `observedAt` come from the write that produced the file; both are
 * absent when the file has no recorded provenance, which leaves the hit ineligible for
 * automatic injection -- the fail-closed default.
 */
export type DocumentProvenance = {
  readonly originClass: string;
  readonly sessionKind: string;
  readonly observedAt: number;
  readonly curatedRoot: boolean;
};

/** Insert or replace one document and its units. */
/**
 * Index one file. This is upstream's write path, whole.
 *
 * WHAT WAS REMOVED, AND WHY IT WAS EVER THERE
 *   This used to write `documents` / `units` / `units_fts` / `vectors` as well, as a dual
 *   write, while the readers still read those tables. Both halves are gone now: the readers
 *   read `memory_index_chunks`, and mem-plus's own tables have no reader left.
 *
 *   Two of the deleted behaviours were mem-plus inventions that the removal restores to
 *   upstream's shape rather than losing:
 *   - `holder` / `mirrored` suppression is gone. mem-plus picked one document to hold a set of
 *     bytes and gave the duplicate none. Upstream stores both and separates the corpora with
 *     the `source` column, which `filtersSql` filters on.
 *   - `marker` is gone. It existed to stop one capture being written twice, enforced by a
 *     unique index. Upstream's `clear(entry.path, source)` before the insert is the same
 *     guarantee, structurally.
 *
 * `contentHash` stays: upstream stores it too, in `memory_index_sources.hash`, and it is what
 * `pruneMissing` compares against to decide a file is unchanged.
 */
export function indexDocument(params: {
  db: DatabaseSync;
  file: string;
  root: IndexRoot;
  /** Unused on the upstream path; kept so callers do not have to change. */
  project?: string;
  text: string;
  bytes: number;
  mtime: number;
  /**
   * Omitted when the caller has no classifier available; the row then stores no
   * provenance and every hit from it reports `undefined`, so nothing it contains can
   * be injected automatically.
   */
  provenance?: DocumentProvenance;
  /**
   * The embedding model whose vectors these chunks may carry. Part of the row identity
   * upstream (`manager-source-index-kernel.ts:72`), so it must be the same string the embed
   * and search passes use. Omitted means `fts-only` (`memory-index-write.ts` NO_MODEL), which
   * is what a keyword-only install uses.
   */
  model?: string;
}): DocumentIndex {
  const { db, file, root, text, bytes, mtime } = params;
  const hash = contentHash(text);
  const result = writeSourceChunks({
    db,
    relativePath: memoryRelativePath(file, root),
    source: sourceOf(root),
    content: text,
    hash,
    bytes,
    mtime,
    provenance: upstreamProvenance(params.provenance),
    ...(params.model ? { model: params.model } : {}),
  });
  return { written: result.written, mirrored: false };
}

/**
 * Drop indexed sources under `root` that are no longer present on disk.
 *
 * Over upstream's tables. The `present` set holds ABSOLUTE paths, because that is what the
 * scanner walks with, while the index stores memory-home-relative paths -- so each candidate
 * is relativised before it is compared. Getting this wrong is silent in one direction and
 * loud in the other: comparing an absolute path against a relative column matches nothing,
 * so every source would be pruned on the first scan.
 *
 * Removal goes through `clearSource`, which is upstream's own `(path, source)` clear and
 * which also deletes the vectors behind the chunks. A plain `DELETE FROM
 * memory_index_sources` would leave `memory_index_chunks` rows behind: the foreign keys are
 * declared, but `memory_index_chunks_vec` is a virtual table and cannot participate in a
 * cascade -- the same reason upstream's own comment notes FTS rows are removed explicitly.
 */
export function pruneMissing(params: {
  db: DatabaseSync;
  root: IndexRoot;
  present: ReadonlySet<string>;
}): string[] {
  const source = sourceOf(params.root);
  const indexed = params.db
    .prepare("SELECT path FROM memory_index_sources WHERE source = ?")
    .all(source) as { path: string }[];
  const presentRelative = new Set<string>();
  for (const absolute of params.present) {
    presentRelative.add(memoryRelativePath(absolute, params.root));
  }
  const removed: string[] = [];
  for (const row of indexed) {
    if (presentRelative.has(row.path)) continue;
    clearSource(params.db, row.path, source);
    removed.push(row.path);
  }
  return removed;
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

/**
 * The three filters that survive, all derived from the columns upstream actually has.
 *
 * `kind`, `entryType` and `tag` are gone. They were predicates on mem-plus's own `units`
 * columns; upstream's chunk table has no equivalent, and inventing one would be a
 * self-invented filter over self-invented data. The three that remain are the three
 * upstream's shape *can* express:
 *
 *   corpus   -> the `source` column, which is exactly what upstream's own `sourceFilter`
 *               filters on (`manager-search.ts:230`, `where("chunk.source", "=", "memory")`).
 *   project  -> the directory slug under `memory/`. This host's on-disk layout, not an
 *               upstream concept, so it is a path predicate. The slug is escaped as a LIKE
 *               pattern because a project directory name can contain `_`, which is a LIKE
 *               wildcard -- without the escape, project `a_b` would also match `aXb`.
 *   day      -> the date in the basename. `YYYY-MM-DD.md` is 13 characters, so the date is
 *               `substr(path, -13, 10)` and ISO dates order lexicographically.
 *
 * THE GLOB IS LOAD-BEARING, AND A PROBE FOUND IT
 *   Without it, `substr('MEMORY.md', -13, 10)` is the whole string `MEMORY.md` -- only 9
 *   characters exist -- and `'MEMORY.md' >= '2026-11-01'` is TRUE, because `'M'` (0x4D)
 *   sorts above `'2'` (0x32). So every curated file, the ones with no date at all, passed
 *   every `since` and `until` filter ever asked for. A date filter that silently admits
 *   undated content is worse than no filter: the result looks filtered and is not.
 *
 *   The GLOB is the SQL twin of `dayOf` below, which is the same predicate in TypeScript:
 *   ten digits around two dashes, and nothing else. Both must agree, or a chunk read back
 *   through one path carries a `day` the other path would have filtered away.
 *
 * `currentProjectOnly` keeps the old semantics: this project's files plus the global ones
 * at the memory-home root, which are not under `memory/` and so carry no slug.
 */
function filtersSql(
  filters: SearchFilters,
  prefix: string,
  currentProject?: string,
): FilterSql {
  const parts: string[] = [];
  const params: SQLInputValue[] = [];

  // Corpus first and unconditionally: it is the one filter that decides which
  // half of the corpus a query may see at all, so it must not be skipped by the
  // project branch below.
  if (filters.corpus === "memory") parts.push(`${prefix}.source = 'memory'`);
  else if (filters.corpus === "wiki") parts.push(`${prefix}.source = '${WIKI_SOURCE}'`);

  if (filters.currentProjectOnly) {
    if (currentProject) {
      // The global long-term memory lives at the memory-home root (`MEMORY.md`, `USER.md`,
      // wiki pages) and has no `memory/` segment, so it stays reachable from a
      // project-scoped search -- which is what the old `d.project = ''` half meant.
      parts.push(`(${prefix}.path NOT LIKE 'memory/%' OR ${prefix}.path LIKE ? ESCAPE '\\')`);
      params.push(`${escapeLike(`memory/${currentProject}/`)}%`);
    }
  } else if (filters.project) {
    parts.push(`${prefix}.path LIKE ? ESCAPE '\\'`);
    params.push(`${escapeLike(`memory/${filters.project}/`)}%`);
  }
  if (filters.since) {
    parts.push(`(${dateBasenameGlob(prefix)} AND substr(${prefix}.path, -13, 10) >= ?)`);
    params.push(filters.since);
  }
  if (filters.until) {
    parts.push(`(${dateBasenameGlob(prefix)} AND substr(${prefix}.path, -13, 10) <= ?)`);
    params.push(filters.until);
  }
  return { clause: parts.length > 0 ? ` AND ${parts.join(" AND ")}` : "", params };
}

/**
 * A basename of exactly `YYYY-MM-DD.md`, as a SQL predicate over `path`.
 *
 * The SQL twin of {@link dayOf}, and it has to agree with it exactly: a chunk read back
 * through one path carries a `day` the other path would have filtered away.
 */
function dateBasenameGlob(prefix: string): string {
  return `substr(${prefix}.path, -13, 10) GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'`;
}

/** `_` and `%` are LIKE wildcards; a project slug may legitimately contain either. */
function escapeLike(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

/** The directory slug under `memory/`, or "" for anything at the memory-home root. */
function projectOf(relativePath: string): string {
  const match = /^memory\/([^/]+)\//u.exec(relativePath);
  return match?.[1] ?? "";
}

/** The `YYYY-MM-DD` in a day file's basename, or null when the name has no date. */
function dayOf(relativePath: string): string | null {
  const base = relativePath.slice(relativePath.lastIndexOf("/") + 1);
  const match = /^(\d{4}-\d{2}-\d{2})\.md$/u.exec(base);
  return match?.[1] ?? null;
}

/**
 * Columns only, no FROM. Each query supplies its own FROM/JOIN: an earlier
 * version inlined a constant that ended in `JOIN documents`, then appended a
 * second `FROM units_fts`, producing two FROM clauses. SQLite rejected the
 * statement, and the `catch` around it turned a broken query into "0 results"
 * -- indistinguishable from a genuine miss.
 *
 * These six are upstream's own chunk columns and no more. Upstream's primary keyword
 * loader selects exactly this set -- `manager-search.ts:348`:
 *
 *   SELECT id, path, source, start_line, end_line, text, <rank> AS rank
 *     FROM memory_index_chunks_fts
 *
 * `start_line` and `end_line` are the pair mem-plus never had: `rowToHit` used to
 * hard-code both to 0. They are selected here for the first time.
 *
 * `rank` is supplied by the caller, because FTS supplies it and a non-FTS reader does not.
 *
 * THE PREFIX IS THE TABLE NAME, NOT AN ALIAS, AND IT CANNOT BE AN ALIAS. Measured: with
 * `FROM memory_index_chunks_fts f`, every one of these fails with `no such column: f` --
 *
 *   f.source = 'memory'
 *   EXISTS (SELECT 1 FROM memory_index_chunks c WHERE c.id = f.id)
 *
 * including the trivial column reference in the same SELECT that names `f`. An FTS5 virtual
 * table does not register its alias, so the table name is the only way to qualify its
 * columns. That is why upstream writes `${params.ftsTable}` everywhere in
 * `manager-search.ts` and never binds an alias. This function took an alias on the first
 * attempt and every search returned zero hits while reporting only `text search failed`.
 *
 * The prefix is a parameter because the two lanes read different tables: the keyword lane
 * reads the FTS table, which carries all six columns UNINDEXED, while the vector lane reads
 * the chunk table directly -- a chunk with an embedding has no reason to lack an FTS row,
 * and a `LEFT JOIN` would only make its columns nullable.
 */
const hitColumns = (prefix: string): string => `
  ${prefix}.id AS id,
  ${prefix}.path AS path,
  ${prefix}.source AS source,
  ${prefix}.start_line AS start_line,
  ${prefix}.end_line AS end_line,
  ${prefix}.text AS text
`;

/** Upstream's FTS table name. Never alias it; see {@link hitColumns}. */
const CHUNK_FTS = "memory_index_chunks_fts";
/** Upstream's chunk table name. */
const CHUNKS = "memory_index_chunks";

/**
 * Upstream's `projectMemorySearchRow` plus `formatCitation`, transcribed.
 *
 * `manager-search-shared.ts` and `tools.citations.ts` are NOT vendored into this tree --
 * `extensions/memory-core/src/memory/` holds only `hybrid`, `importance`,
 * `keyword-query`, `manager-cpu-entrypoints`, `mmr`, `project-ranking`, `temporal-decay`
 * and `tokenize`. So these two are written out rather than called, which is the one
 * transcription in this read path and it is kept to the upstream text:
 *
 *   projectMemorySearchRow: { id, path, startLine, endLine, score,
 *                            snippet: truncateUtf16Safe(text, max), source }
 *   formatCitation:        startLine === endLine ? `path#L${start}`
 *                                          : `path#L${start}-L${end}`
 *
 * The recall metadata is NOT projected here. Upstream reads it in a second query --
 * `readMemoryRecallMetadata(db, ids)` -- because the FTS loader selects only six columns,
 * so this calls that rather than inventing a wider SELECT with two LEFT JOINs.
 */
const SNIPPET_MAX_CHARS = 600;

/** Upstream `tools.citations.ts:41`, verbatim. */
function formatCitation(hit: {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
}): string {
  const lineRange =
    hit.startLine === hit.endLine ? `#L${hit.startLine}` : `#L${hit.startLine}-L${hit.endLine}`;
  return `${hit.path}${lineRange}`;
}

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
  const filter = filtersSql(params.filters, CHUNK_FTS, params.currentProject);
  // Upstream's `liveChunkClause` (`manager-search.ts:332`) is kept: FTS rows are
  // maintained by triggers, and a row whose chunk has been cleared must not be
  // returned as a live hit.
  const sql = `
    SELECT ${hitColumns(CHUNK_FTS)},
           ${CHUNK_FTS}.rank AS rank
    FROM ${CHUNK_FTS}
    WHERE ${CHUNK_FTS} MATCH ?
      AND ${CHUNK_FTS}.rank MATCH 'bm25()'
      AND EXISTS (SELECT 1 FROM ${CHUNKS} c WHERE c.id = ${CHUNK_FTS}.id)${filter.clause}
    ORDER BY ${CHUNK_FTS}.rank
    LIMIT ?
  `;
  try {
    const rows = params.db.prepare(sql).all(match, ...filter.params, params.limit) as Record<
      string,
      unknown
    >[];
    // bm25() returns a negative number where more negative is better, and
    // openclaw's bm25RankToScore saturates it into [0, 1): r / (1 + r) where
    // r = -rank. That absolute, monotone map is what lets the 0.7 / 0.3 lane
    // weights mean anything -- an earlier version of this file fused by rank
    // (RRF) instead, which threw the magnitudes away and is not what openclaw
    // does.
    //
    // No column weights, deliberately: the old `units_fts` had a `heading` and a `tags`
    // column, and `bm25(units_fts, 0.0, 4.0, 3.0)` gave the body a weight of zero, so
    // only headings and tags scored. Upstream's chunk FTS indexes `text` alone and
    // weights it equally, which is what this statement does.
    return rowsToHits(params.db, rows).map((hit) => ({
      ...hit,
      score: bm25RankToScore(hit.score),
    }));
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

/**
 * Project one chunk row into a `SearchHit`, with the recall metadata merged in.
 *
 * TWO UPSTREAM CALLS, NOT A WIDER SELECT
 *   Upstream loads the six chunk columns in the keyword query (`manager-search.ts:348`)
 *   and then reads provenance and annotations in a second query keyed by id
 *   (`readMemoryRecallMetadata(db, ids)`, `memory-recall-metadata.ts:71`). That second call
 *   is made here rather than hand-rolled as two `LEFT JOIN`s, because it is already in the
 *   tree and it does three things a join would not: it validates `origin_class` and
 *   `session_kind` against the closed sets and yields `undefined` for anything else
 *   (`decodeChunkProvenance`, line 44), it omits `supersedesKey` when blank, and it
 *   `LEFT JOIN`s, so a chunk with no metadata row still comes back.
 *
 *   That last point is the security-relevant one: `provenance` stays `undefined` for an
 *   unclassified chunk, and `isAutomaticMemoryEntryEligible` fails closed on `undefined`.
 *   An absent row therefore cannot be promoted; a defaulted row could.
 *
 * `project` and `day` are derived from `path`, per the note on {@link SearchHit}.
 *
 * ONE CALL FOR THE WHOLE RESULT SET
 *   `readMemoryRecallMetadata` takes the full id list and returns a `Map`, which is how its
 *   one caller uses it. Calling it per row would be a query per hit -- up to 200 for the
 *   hybrid keyword lane, where `topKPerLane` is 200. So the ids are collected first and the
 *   map is built once.
 */
function rowsToHits(db: DatabaseSync, rows: readonly Record<string, unknown>[]): SearchHit[] {
  const base = rows.map((row) => {
    const path = String(row["path"] ?? "");
    return {
      chunkId: String(row["id"] ?? ""),
      path,
      startLine: Number(row["start_line"] ?? 0),
      endLine: Number(row["end_line"] ?? 0),
      score: Number(row["rank"] ?? 0),
      snippet: truncateUtf16Safe(String(row["text"] ?? ""), SNIPPET_MAX_CHARS),
      source: String(row["source"] ?? "memory") as MemorySearchResult["source"],
      project: projectOf(path),
      day: dayOf(path),
    };
  });
  const metadata = readMemoryRecallMetadata(db, base.map((hit) => hit.chunkId));
  return base.map((hit) => {
    const row = metadata.get(hit.chunkId);
    return {
      ...hit,
      citation: formatCitation(hit),
      ...(row?.importance != null ? { importance: row.importance } : {}),
      ...(row?.triggers != null ? { triggers: row.triggers } : {}),
      ...(row?.project_key != null ? { projectKey: row.project_key } : {}),
      // Absent for an unclassified chunk, which is the fail-closed direction.
      ...(row?.provenance ? { provenance: row.provenance } : {}),
    };
  });
}

// --- trigger candidates ----------------------------------------------------

/**
 * Curated entries that carry trigger phrases -- the unscored half of
 * `resolveTriggerRecall`'s two queries.
 *
 * UPSTREAM: `MemorySearchManager.listTriggerCandidates({ activeProjectKeys })`,
 * called alongside a scored search so an entry that matches nothing lexically is
 * still a candidate when its trigger phrases match. This is that query.
 *
 * WHY THE ELIGIBILITY FILTERS ARE NOT HERE
 *   Upstream filters by `activeProjectKeys` in the manager and again in
 *   `isPromotedTrustedMemoryEntry`, and its provenance gate
 *   (`isAutomaticMemoryEntryEligible`) is part of that second predicate. The selector is
 *   where those checks decide, so they live there; this query only narrows to the memory
 *   source, which is what `sources: ["memory"]` does upstream.
 *
 * WHY THE BASENAME CHECK IS GONE
 *   It stood in for the provenance gate while the index carried no provenance. That gate
 *   is `isAutomaticMemoryEntryEligible`, called from the selector now that every hit
 *   reports `provenance`. The old check keyed on the file being `MEMORY.md`, which was
 *   a structural approximation of "curated tier"; the provenance class is the rule
 *   itself, and it also survives a day file that the parser mis-dispatched.
 *
 * The limit is optional and defaults to 512, clamped to `[1, 512]`, exactly as upstream's
 * `MemoryKeywordRetrieval.listTriggerCandidates` does -- and upstream's `trigger-recall.ts`
 * call site passes only `activeProjectKeys`, so 512 is what upstream actually runs. The
 * per-message candidate budget (`TRIGGER_CANDIDATE_LIMIT`) applies to the *scored* half,
 * which is a different query; this one is the curated tier, and a second cap here would
 * silently drop trigger phrases from entries the block budget would have admitted.
 */
export function listTriggerCandidates(params: {
  db: DatabaseSync;
  limit?: number;
  onError?: (message: string) => void;
}): SearchHit[] {
  const limit = Math.max(1, Math.min(512, Math.floor(params.limit ?? 512)));
  try {
    // Upstream `readCuratedMemoryTriggerCandidates` (`memory-recall-metadata.ts:113`).
    // The predicate mem-plus wrote by hand here is upstream's, verbatim:
    //
    //   where("chunk.source", "=", "memory")
    //   where("chunk.path",   "in", ["MEMORY.md", "USER.md"])
    //   where("provenance.origin_class", "in", ["owner", "agent"])
    //   where("metadata.triggers", "is not", null)
    //
    // That third clause is the one mem-plus could not express: it INNER JOINs provenance, so
    // a curated chunk with no classification is not a candidate at all. mem-plus's query
    // selected on `d.root = 'home'`, which admitted unclassified content and relied on the
    // caller to gate it. Upstream puts the gate in the query.
    return curatedRowsToHits(
      params.db,
      readCuratedMemoryTriggerCandidates(params.db, limit),
    );
  } catch (error) {
    params.onError?.(describe(error));
    return [];
  }
}

/**
 * Curated entries that carry at least one `<!-- project: ... -->` annotation.
 *
 * UPSTREAM: `MemoryKeywordRetrieval.listCuratedProjectCandidates({ activeProjectKeys,
 * limit })` -- the same reader as {@link listTriggerCandidates} with `projectsOnly: true`,
 * which is what the project-memory bootstrap draws from. Upstream's default limit is 48
 * (clamped `[1, 512]`) and its call site passes 48 explicitly.
 *
 * "Projects only" means *annotated*: upstream's `buildProjectMemoryBootstrap` admits an
 * entry only when its `automaticRecall.projectKeys` is non-empty and every key is active,
 * so an unannotated curated entry is global and never arrives through here. That is why
 * this query requires `project_key IS NOT NULL` rather than filtering in the caller.
 */
export function listCuratedProjectCandidates(params: {
  db: DatabaseSync;
  limit?: number;
  /**
   * Upstream's second argument, and it is required: upstream returns `[]` when the list is
   * empty (`memory-recall-metadata.ts:134`), because an entry annotated with project keys can
   * only be recalled inside a project that is active. mem-plus's version had no such
   * argument and returned every annotated curated chunk, so the database was asked for rows
   * that were then discarded in JS.
   */
  activeProjectKeys: readonly string[];
  onError?: (message: string) => void;
}): SearchHit[] {
  const limit = Math.max(1, Math.min(512, Math.floor(params.limit ?? 48)));
  try {
    // Upstream `readCuratedProjectMemoryCandidates` (`memory-recall-metadata.ts:127`). It
    // returns `[]` when `activeProjectKeys` is empty, which is the fail-closed direction:
    // an entry annotated with project keys can only be recalled inside those projects.
    //
    // The signature change is real: upstream takes `activeProjectKeys` and does the
    // eligibility filtering itself, including keyset batching so foreign rows cannot starve
    // the window. mem-plus's version had no such argument and returned every annotated
    // curated chunk, leaving `buildProjectMemoryBootstrap` to filter in JS -- which it does,
    // but only after the database had already been asked for the wrong rows.
    return curatedRowsToHits(
      params.db,
      readCuratedProjectMemoryCandidates(params.db, limit, params.activeProjectKeys),
    );
  } catch (error) {
    params.onError?.(describe(error));
    return [];
  }
}

/**
 * Upstream's curated-candidate rows are snake_case and already carry provenance, so they do
 * not go through {@link rowsToHits} -- that path exists for the six-column FTS shape and
 * would re-read the metadata this query just joined.
 */
function curatedRowsToHits(
  db: DatabaseSync,
  rows: readonly {
    id: string;
    path: string;
    source: string;
    start_line: number;
    end_line: number;
    text: string;
    importance: number | null;
    triggers: string | null;
    project_key: string | null;
    origin_class: unknown;
    session_kind: unknown;
    observed_at: unknown;
    supersedes_key: unknown;
  }[],
): SearchHit[] {
  void db;
  return rows.map((row) => {
    const hit = {
      chunkId: row.id,
      path: row.path,
      startLine: row.start_line,
      endLine: row.end_line,
      score: 0,
      snippet: truncateUtf16Safe(row.text, SNIPPET_MAX_CHARS),
      source: row.source as MemorySearchResult["source"],
      project: projectOf(row.path),
      day: dayOf(row.path),
    };
    return {
      ...hit,
      citation: formatCitation(hit),
      ...(row.importance != null ? { importance: row.importance } : {}),
      ...(row.triggers != null ? { triggers: row.triggers } : {}),
      ...(row.project_key != null ? { projectKey: row.project_key } : {}),
      ...(row.origin_class != null && row.session_kind != null && row.observed_at != null
        ? {
            provenance: {
              originClass: row.origin_class as MemoryEntryProvenance["originClass"],
              sessionKind: row.session_kind as MemoryEntryProvenance["sessionKind"],
              observedAt: row.observed_at as number,
              ...(typeof row.supersedes_key === "string" && row.supersedes_key.trim()
                ? { supersedesKey: row.supersedes_key }
                : {}),
            } satisfies MemoryEntryProvenance,
          }
        : {}),
    };
  });
}

// --- vectors ---------------------------------------------------------------

/**
 * Write an embedding onto the chunk row.
 *
 * Upstream stores it in `memory_index_chunks.embedding` (`manager-chunk-writer.ts:48`) and
 * mirrors it into the `memory_index_chunks_vec` virtual table when sqlite-vec is loaded.
 * mem-plus had a `vectors(unit_id, dim, vec)` table of its own; this is that table, gone.
 *
 * A row's identity includes `model` (see `memory-index-write.ts`), so writing here without a
 * model argument would store a vector that the next reindex with a model present re-ids and
 * discards. `model` is therefore required rather than defaulted to "".
 */
export function storeVector(params: {
  db: DatabaseSync;
  chunkId: string;
  model: string;
  vector: readonly number[];
}): void {
  params.db
    .prepare("UPDATE memory_index_chunks SET embedding = ? WHERE id = ? AND model = ?")
    .run(encodeMemoryEmbedding(params.vector), params.chunkId, params.model);
}

/**
 * Chunks with no embedding yet.
 *
 * "No embedding" IS NOT NULL -- upstream declares the column `embedding BLOB NOT NULL` in a
 * `STRICT` table (`memory-schema-base.ts`), so an absent vector is a ZERO-LENGTH BLOB, which
 * is what `encodeMemoryEmbedding([])` returns and what `chunkEmbeddingColumn` writes when the
 * caller has no provider. A `WHERE embedding IS NULL` predicate here would match nothing and
 * silently report the whole index as embedded; that is what the first version of this
 * function did, and it is why the DDL was read rather than assumed.
 *
 * The `model` test is upstream's own, and it is the reliable signal:
 * `manager-sync-base.ts:330` decides whether the index holds semantic chunks with
 * `SELECT 1 FROM memory_index_chunks WHERE model != 'fts-only'`. A row is semantic because it
 * was written by a provider, not because its blob happens to be non-empty.
 */
export function chunksMissingVectors(
  db: DatabaseSync,
  model: string,
  limit: number,
): { id: string; text: string }[] {
  return db
    .prepare(
      `SELECT id, text
         FROM memory_index_chunks
        WHERE length(embedding) = 0 AND model = ?
        ORDER BY id
        LIMIT ?`,
    )
    .all(model, limit) as { id: string; text: string }[];
}

/**
 * How many chunks the vector lane could actually score.
 *
 * DIVERGES FROM UPSTREAM'S `hasSemanticChunks`, and the reason is a state upstream cannot be
 * in. Upstream tests `WHERE model != 'fts-only'` (`manager-sync-base.ts:330`): a chunk
 * written by a provider always has its embedding in the same pass, because upstream computes
 * embeddings inside the reindex (`enforceEmbeddingMaxInputTokens(provider, baseChunks, ...)`
 * and `prepareChunks`, `manager-index-preparation.ts:79`), so the two conditions coincide.
 *
 * mem-plus's embedding is a separate budgeted pass (`embedMissing`, one tool call at a time).
 * So a chunk can legitimately carry the provider's `model` while its `embedding` blob is
 * still empty, between a reindex and the embed call. Counting on `model` would report those
 * as vector-searchable, and `describeMissingVectors` -- whose whole job is to tell the model
 * "semantic search is not active yet" -- would stay silent while every `vector` and `hybrid`
 * query returned nothing. Counting the blob is what the question actually is.
 */
export function vectorCount(db: DatabaseSync): number {
  return (
    db
      .prepare("SELECT COUNT(*) AS n FROM memory_index_chunks WHERE length(embedding) > 0")
      .get() as { n: number }
  ).n;
}

/**
 * Cosine similarity over `memory_index_chunks.embedding`, honouring the same filters.
 *
 * Scored with upstream's `cosineSimilarity` (`embedding-vector.ts:42`) rather than the
 * hand-written dot-product loop this used to have, so the ranking is upstream's.
 */
export function searchVector(params: {
  db: DatabaseSync;
  query: readonly number[];
  filters: SearchFilters;
  limit: number;
  currentProject?: string;
  model: string;
  /** Candidates to consider before ranking; the whole corpus is scanned. */
  candidateLimit?: number;
}): SearchHit[] {
  if (params.query.length === 0) return [];
  const filter = filtersSql(params.filters, CHUNKS, params.currentProject);
  // Upstream's `searchChunksByEmbedding` fallback scan, over the same column it reads.
  const sql = `
    SELECT ${hitColumns(CHUNKS)},
           ${CHUNKS}.embedding AS embedding,
           0 AS rank
    FROM ${CHUNKS}
    WHERE length(${CHUNKS}.embedding) > 0
      AND ${CHUNKS}.model = ?${filter.clause}
    LIMIT ?
  `;
  const rows = params.db
    .prepare(sql)
    .all(params.model, ...filter.params, params.candidateLimit ?? 20_000) as Record<
      string,
      unknown
    >[];

  // Scored row-by-row against the projection of the same row, so index alignment holds by
  // construction: `rowsToHits` maps in order and does not drop or reorder anything.
  // `decodeMemoryEmbedding` returns `[]` for a blob whose length is not a multiple of 8, and
  // `cosineSimilarity` on an empty vector is 0 -- so a corrupt row drops out on the score
  // filter below rather than reaching the model as a hit.
  const scored = rowsToHits(params.db, rows).map((hit, index) => ({
    ...hit,
    score: cosineSimilarity(
      params.query as number[],
      decodeMemoryEmbedding(rows[index]!["embedding"] as Uint8Array),
    ),
  }));
  return scored
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
 * Identity, read from the code rather than assumed:
 *
 *   - `mergeHybridResults` keys its lanes on `id` (`hybrid.ts:90`, `:114`) -- the chunk id,
 *     which is exactly what upstream passes. It does NOT key on a range, and an earlier
 *     comment here said it did; that was wrong.
 *   - `mergeHybridResults` drops `id` from its output (`hybrid.ts:190-208` projects
 *     `path`/`startLine`/`endLine`/scores/`snippet`/`source`/annotations and nothing else).
 *   - `selectHybridSearchResults` de-duplicates on `source:path:startLine:endLine`
 *     (`hybrid.ts:297`, `hybridResultRangeKey`).
 *
 * So the mapping back is by that same range key. Which is only correct now that
 * `startLine`/`endLine` are real: this used to overload them with the unit id as a carrier,
 * and look results up by `byId.get(entry.startLine)` -- a number that was a row id wearing a
 * line-number's name. Both lanes now carry upstream's own values, and `hit.chunkId` is the
 * `id` upstream wants.
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
  // Upstream's own result identity (`hybrid.ts:297`).
  const rangeKey = (hit: {
    readonly source: string;
    readonly path: string;
    readonly startLine: number;
    readonly endLine: number;
  }): string => `${hit.source}:${hit.path}:${hit.startLine}:${hit.endLine}`;

  const byRange = new Map<string, SearchHit>();
  const keyword: KeywordLane[] = [];
  const vector: VectorLane[] = [];

  for (const hit of params.text) {
    byRange.set(rangeKey(hit), hit);
    keyword.push({
      id: hit.chunkId,
      path: hit.path,
      startLine: hit.startLine,
      endLine: hit.endLine,
      source: hit.source,
      snippet: hit.snippet,
      // The chunk's `<!-- project: ... -->` keys, not `hit.project`. `project` is the
      // directory slug -- it partitions `memory/<slug>/` on disk and has nothing to do
      // with openclaw's project identity, which is the repository's normalised `origin`
      // remote. Passing the slug here stamped curated entries with `mem-plus--83e5df`
      // while the injection gate compares against `github.com/...`, so every such entry
      // was annotated-and-never-active: dropped fail-closed, which hides a memory
      // permanently rather than merely scoping it.
      projectKey: hit.projectKey,
      textScore: hit.score,
      ...(hit.provenance ? { provenance: hit.provenance } : {}),
    });
  }
  for (const hit of params.vector) {
    byRange.set(rangeKey(hit), hit);
    vector.push({
      id: hit.chunkId,
      path: hit.path,
      startLine: hit.startLine,
      endLine: hit.endLine,
      source: hit.source,
      snippet: hit.snippet,
      projectKey: hit.projectKey,
      vectorScore: hit.score,
      ...(hit.provenance ? { provenance: hit.provenance } : {}),
    });
  }
  if (byRange.size === 0) return [];

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
    const hit = byRange.get(rangeKey(entry));
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
  /**
   * The embedding model whose vectors the vector lane may read.
   *
   * Required rather than optional because `model` is part of a chunk's row identity: a
   * vector computed by `bge-m3` is meaningless under a different model, so the vector lane
   * has to be told which model's rows it is allowed to score against. Upstream does the same
   * thing with `buildMemoryModelFilter(column, models)`
   * (`manager-search-shared.ts:31`) and resolves aliases before querying
   * (`manager-search-vector.ts:19`).
   */
  model: string;
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

export function indexStats(db: DatabaseSync): IndexStats {
  const count = (sql: string): number => (db.prepare(sql).get() as { n: number }).n;
  let bytes = 0;
  try {
    bytes = statSync(indexPath()).size;
  } catch {
    // The database may not exist yet; a missing file is a size of zero, not an
    // error worth propagating into a tool result.
    bytes = 0;
  }
  return {
    // Upstream's own tables. `documents`/`units`/`vectors` were mem-plus's; they are gone.
    sources: count("SELECT COUNT(*) AS n FROM memory_index_sources"),
    chunks: count("SELECT COUNT(*) AS n FROM memory_index_chunks"),
    vectors: vectorCount(db),
    bytes,
  };
}
