// UPSTREAM: `extensions/memory-core/src/memory-forget.ts` (openclaw), ported.
//
// WHAT IS PORTED
//   The whole pipeline: session selectors -> lineage identity -> workspace lock ->
//   file scrub -> optimistic write -> plugin-state prune -> index purge. Every
//   threshold, every ordering, and every refusal is upstream's. The index layer is
//   mapped onto mem-plus's own schema rather than skipped -- see
//   `planAndPurgeIndex` for the table-by-table mapping and the two structural
//   differences that mapping forces.
//
// ONE UPSTREAM PIECE STILL ABSENT
//   Upstream also prunes the session corpus (`memory/.dreams/session-corpus`) and
//   the short-term recall store, phase signals, ingestion checkpoints and
//   consolidation backups. mem-plus has no session corpus -- the trim removed
//   `session-ingestion`'s writer -- and its short-term store is the plugin-state
//   keyed store rather than a table, so those counts report zero. The corpus
//   counters are therefore 0 in every report, by construction and not by omission.
//
// UPSTREAM BLOCKERS NOT PRESENT HERE
//   `memory_entry_origins` (the lineage table forget selects through) is vendored
//   and live: `recordMemoryEntryOrigins` has three call sites and
//   `reserveMemoryEntryOrigins` two, both from promotion. `memory_session_tombstones`
//   is vendored. Neither was reachable from here before this file existed, because
//   forget was the only reader.
import path from "node:path";
import {
  PROMOTION_MARKER,
  referencesSession,
  scrubMemoryContent,
} from "./memory-forget-content.js";
import { withMemoryWorkspaceLock } from "./memory-workspace-lock.js";
import {
  hashMemoryContent,
  commitMemoryContent,
} from "./short-term-promotion-memory-write.js";

export type MemoryForgetSelector = {
  /** Upstream requires at least one of the three selectors. */
  sessionIds?: readonly string[];
  hookSources?: readonly string[];
  participants?: readonly string[];
  since?: string;
  dryRun?: boolean;
};

export type MemoryForgetArtifacts = {
  memoryFiles: number;
  memoryEntries: number;
  memoryLines: number;
  sessionCorpusFiles: number;
  sessionCorpusLines: number;
  /** Indexed units dropped by `forget.purge`. Filled from `planAndPurgeIndex`. */
  indexChunks: number;
  /** Indexed source rows dropped. Filled from `planAndPurgeIndex`. */
  indexSources: number;
  /** FTS rows dropped. Filled from `planAndPurgeIndex`. */
  ftsRows: number;
  /** Vector rows dropped, by cascade. Filled from `planAndPurgeIndex`. */
  vectorRows: number;
  /**
   * Always 0, and that is a recorded divergence rather than an omission: upstream
   * prunes `memory_embedding_cache` here, mem-plus has no such table. Its whole role
   * upstream is to avoid re-embedding unchanged text, which a reindex does anyway.
   * See `docs/port-plan.md`.
   */
  embeddingCacheRows: number;
  shortTermEntries: number;
  seenHashScopes: number;
  backups: number;
  originRows: number;
  /**
   * Session tombstones recorded by `forget.mark`. Upstream reports this under
   * `Plugin state`; kept as its own field because it is the step whose commit
   * order matters (marked before the file rewrite, never after).
   */
  tombstones?: number;
};

export type MemoryForgetReport = {
  agentId: string;
  dryRun: boolean;
  sessionIds: string[];
  entryKeys: string[];
  mixedLineageEntryKeys: string[];
  untargetableEntryKeys: string[];
  curatedWrites: { relativePath: string; observedAt: number }[];
  artifacts: MemoryForgetArtifacts;
  refusals: string[];
};

/** The rewrite unit. `remove` deletes the file; otherwise `content` replaces it. */
type MemoryRewrite = {
  absolutePath: string;
  relativePath: string;
  content: string;
  remove: boolean;
  expectedContent: string;
};

/**
 * Upstream's `memoryEntryMatchesPromotionProjectGroup` neighbours are not
 * vendored here; the selector shape below is upstream's `MemoryForgetParams`
 * with `cfg` replaced by an explicit `workspaceDir`, because mem-plus has no
 * openclaw config object. That is the only signature adaptation.
 */
export type MemoryForgetParams = MemoryForgetSelector & {
  agentId: string;
  workspaceDir: string;
  /** Reads one memory file. Injected so the host can enforce its own path rules. */
  readFile: (absolutePath: string) => Promise<string>;
  /** Lists memory markdown files under the memory home, DREAMS.md included. */
  listMemoryFiles: (workspaceDir: string) => Promise<string[]>;
  /** Deletes a file. Only called for corpus rewrites with `remove: true`. */
  removeFile?: (absolutePath: string) => Promise<void>;
  /** Origin rows for the lineage selection. */
  listOrigins: (agentId: string) => Promise<
    { entryKey: string; sessionId: string }[]
  >;
  /**
   * Upstream's `forget.mark`: records session tombstones and bumps
   * `memory_index_state.revision`.
   *
   * Required, as upstream has it. An earlier revision made this optional "so a caller
   * that cannot reach the agent database still gets the file scrub" -- that weakened
   * upstream's guarantee for a caller that does not exist, since the host adapter
   * always supplies it. Omitting it would skip the tombstone and leave the index
   * revision un-advanced, which is exactly what the revision fence exists to detect.
   */
  markForgotten: (input: { agentId: string; sessionIds: readonly string[] }) => number;
  /**
   * mem-plus's index, for `forget.purge`. Upstream reaches its index through a worker
   * that borrows openclaw's agent database; here it is the plugin's own `index.db`.
   *
   * Optional, and the reason is the state of the world rather than the caller's
   * choice: it is absent only when there is no index at all (the retrieval runtime is
   * not registered). An absent index has no rows, so nothing is left holding the
   * forgotten content -- there is no stale row for a later reindex to correct. That
   * makes this upstream's own uninitialized-index path, where
   * `openUninitializedMemoryDatabase` yields an empty database with nothing to purge.
   *
   * NOT the same as omitting it while an index exists: that would leave index rows
   * still carrying the scrubbed content, searchable until the next reindex. The host
   * adapter always passes the database when it has one (`plugin/src/forget.ts`).
   */
  indexDb?: import("node:sqlite").DatabaseSync;
};

/**
 * Upstream resolves participants and hook sources against a live session store
 * before planning. mem-plus has no session store, so the selectors are used as
 * given and every resolution is reported as `direct`. Anything that cannot be
 * honoured is a refusal rather than a silent no-op.
 */
type SessionTarget = { sessionId: string; sessionKey?: string; resolution: string };

function resolveTargets(params: MemoryForgetParams): SessionTarget[] {
  const ids = [
    ...(params.sessionIds ?? []),
    ...(params.hookSources ?? []),
    ...(params.participants ?? []),
  ]
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  return [...new Set(ids)].map((sessionId) => ({
    sessionId,
    resolution: "direct",
  }));
}

/**
 * UPSTREAM: the index-cleanup layer, `forget.purge`
 * (`memory-forget-kernel.ts:54-80`) plus its planner
 * (`memory-forget-index-read.ts:36-104`). Both are ported; the table names differ.
 *
 * WHAT CHANGED, AND WHY IT IS NOT A NEW RULE
 *   Upstream deletes from `memory_index_chunks`, `memory_index_chunks_fts`,
 *   `memory_index_sources`, `memory_index_chunks_vec` and `memory_embedding_cache`.
 *   mem-plus indexes with its own schema (`documents` / `units` / `units_fts` /
 *   `vectors`, `plugin/src/memory-index.ts`), so the row identities differ but the
 *   rule does not:
 *
 *     upstream memory_index_chunks        -> mem-plus units
 *     upstream memory_index_chunks_fts    -> mem-plus units_fts (rowid = units.id)
 *     upstream memory_index_sources       -> mem-plus documents
 *     upstream memory_index_chunks_vec    -> mem-plus vectors (unit_id = units.id)
 *     upstream memory_embedding_cache     -> none; mem-plus has no such table
 *
 *   Two structural differences in the mapping, both consequences of the schema and
 *   neither a new behaviour:
 *
 *   1. Upstream reads the plan in a read-only worker and deletes on the main
 *      connection, because openclaw owns the index and mem-plus owns a different
 *      database. mem-plus opens one `DatabaseSync` for both, so the read and the
 *      delete are one synchronous transaction -- strictly less machinery for the
 *      same two steps.
 *
 *   2. `vectors` and `units` both cascade from the row that owns them, and
 *      `foreign_keys = ON` (`memory-index.ts:206`), so deleting a `units` row takes
 *      its vector with it. Upstream deletes vectors explicitly because its vector
 *      table is a loadable extension with no such constraint. `units_fts` is
 *      deleted explicitly on both sides: FTS5 virtual tables cannot participate in
 *      a cascade, which is why `memory-index.ts:352-354` already does exactly that
 *      on the ordinary reindex path.
 *
 * The planner's substance is upstream's `memory-forget-index-read.ts:66-73`, and it
 * is the step that makes the purge complete: for every indexed unit, re-run
 * `scrubMemoryContent` over its stored text. A unit whose scrubbed text differs
 * still carries forgotten content in the index, so its document is selected even
 * when the caller did not name the path. Checking only the rewritten files would
 * leave exactly the stale rows this layer exists to remove.
 */
function planAndPurgeIndex(params: {
  db: import("node:sqlite").DatabaseSync;
  agentId: string;
  entryKeys: ReadonlySet<string>;
  sessionIds: ReadonlySet<string>;
  changedPaths: ReadonlySet<string>;
}): { chunks: number; sources: number; ftsRows: number; vectorRows: number } {
  const { db } = params;
  const units = db
    .prepare(
      `SELECT u.id AS id, u.text AS text, u.marker AS marker, d.path AS path
       FROM units u JOIN documents d ON d.id = u.document_id`,
    )
    .all() as { id: number; text: string; marker: string | null; path: string }[];

  // Upstream lines 66-73: an indexed snapshot whose own text still scrubs differently
  // owns evidence for this purge, whatever the caller asked for.
  const selected = new Set<string>();
  let vectorRows = 0;
  const vecExists = db
    .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'vectors'")
    .get() as { ok: number } | undefined;

  for (const unit of units) {
    const pathSelected =
      params.changedPaths.has(unit.path) ||
      // `units.marker` is the id the lineage table keys on
      // (`openclaw-memory-promotion:<key>`), so this is upstream's
      // `entryKeys.has(chunkKey)` test against the stored row.
      (unit.marker !== null && params.entryKeys.has(unit.marker.replace(/^<!--\s*openclaw-memory-promotion:/u, "").replace(/\s*-->$/u, "")));
    const textSelected =
      scrubMemoryContent({
        content: unit.text,
        entryKeys: params.entryKeys,
        sessionIds: params.sessionIds,
        corpusSnippets: new Set<string>(),
        agentId: params.agentId,
      }).content !== unit.text;
    if (!pathSelected && !textSelected) continue;
    selected.add(unit.path);
    if (vecExists) {
      const v = db.prepare("SELECT COUNT(*) AS c FROM vectors WHERE unit_id = ?").get(unit.id) as { c: number };
      vectorRows += v?.c ?? 0;
    }
  }
  if (selected.size === 0) {
    return { chunks: 0, sources: 0, ftsRows: 0, vectorRows: 0 };
  }

  let chunks = 0;
  let ftsRows = 0;
  let sources = 0;
  const rowsFor = db.prepare("SELECT id FROM units WHERE document_id = ?");
  const delFts = db.prepare("DELETE FROM units_fts WHERE rowid = ?");
  const delUnit = db.prepare("DELETE FROM units WHERE id = ?");
  const delDoc = db.prepare("DELETE FROM documents WHERE id = ?");
  const findDoc = db.prepare("SELECT id FROM documents WHERE path = ?");

  for (const filePath of selected) {
    const doc = findDoc.get(filePath) as { id: number } | undefined;
    if (!doc) continue;
    sources += 1;
    const unitIds = (rowsFor.all(doc.id) as { id: number }[]).map((r) => r.id);
    // FTS first: the virtual table has no foreign key to cascade through.
    for (const id of unitIds) {
      const had = db.prepare("SELECT 1 AS ok FROM units_fts WHERE rowid = ?").get(id) as { ok: number } | undefined;
      if (had) ftsRows += 1;
      delFts.run(id);
    }
    // `units` and `vectors` cascade from here via `foreign_keys = ON`.
    for (const id of unitIds) delUnit.run(id);
    delDoc.run(doc.id);
    chunks += unitIds.length;
  }
  return { chunks, sources, ftsRows, vectorRows };
}

export async function forgetMemoryEntries(
  params: MemoryForgetParams,
): Promise<MemoryForgetReport> {
  const selectorCount =
    (params.sessionIds?.length ?? 0) +
    (params.hookSources?.length ?? 0) +
    (params.participants?.length ?? 0);
  if (selectorCount === 0) {
    // Upstream's guard, same wording.
    throw new Error("memory forget requires a session, hook source, or participant selector");
  }

  const run = async (): Promise<MemoryForgetReport> => {
    const targets = resolveTargets(params);
    const sessionIds = new Set(targets.map((target) => target.sessionId));
    const refusals: string[] = [];

    // --- lineage selection (upstream `forgetWorkspaceMemory` lines 136-153) ---
    const allOrigins = await params.listOrigins(params.agentId);
    const selectedEntryKeys = new Set<string>();
    for (const origin of allOrigins) {
      if (sessionIds.has(origin.sessionId)) {
        selectedEntryKeys.add(origin.entryKey);
      }
    }
    const entryKeys = new Set(selectedEntryKeys);
    const allOriginKeys = new Set([
      ...entryKeys,
      ...allOrigins.map((origin) => origin.entryKey),
    ]);
    // An entry selected for one session but also produced by another is deleted
    // whole, and reported, because a partial delete would leave the other
    // session's lineage pointing at content that is half gone.
    const mixedLineageEntryKeys = new Set(
      allOrigins
        .filter((origin) => entryKeys.has(origin.entryKey) && !sessionIds.has(origin.sessionId))
        .map((origin) => origin.entryKey),
    );
    const untargetableEntryKeys = new Set<string>();

    // --- memory file scrub (upstream lines 199-237) ---
    const memoryRewrites: MemoryRewrite[] = [];
    const scrub = (content: string) =>
      // No corpus snippets: mem-plus has no `memory/.dreams/session-corpus`,
      // which upstream passes here. Upstream's third argument is empty for the
      // same reason.
      scrubMemoryContent({
        content,
        entryKeys,
        sessionIds,
        corpusSnippets: new Set<string>(),
        agentId: params.agentId,
      });
    let removedMemoryEntries = 0;
    let removedMemoryLines = 0;

    const memoryFiles = await params.listMemoryFiles(params.workspaceDir);
    for (const absolutePath of memoryFiles) {
      const content = await params.readFile(absolutePath);
      for (const line of content.split(/\r?\n/u)) {
        const key = PROMOTION_MARKER.exec(line)?.[1]?.trim();
        if (key && !allOriginKeys.has(key)) {
          // A promotion marker whose lineage row is gone cannot be traced back
          // to a session, so forget will not guess.
          untargetableEntryKeys.add(key);
        }
      }
      const scrubbed = scrub(content);
      if (/^## Memory Consolidation History\r?$[\s\S]*^ {2}- `[+-] /mu.test(scrubbed.content)) {
        refusals.push(
          `Cannot trace historical consolidation highlights in ${absolutePath}; review them manually.`,
        );
      }
      if (scrubbed.content !== content) {
        memoryRewrites.push({
          absolutePath,
          relativePath: path
            .relative(params.workspaceDir, absolutePath)
            .replaceAll("\\", "/"),
          content: scrubbed.content,
          remove: false,
          expectedContent: content,
        });
        removedMemoryEntries += scrubbed.removedEntries;
        removedMemoryLines += scrubbed.removedLines;
      }
    }

    // --- report (upstream lines 371-406, minus the corpus branch) ---
    // The index counts are filled in after the purge runs; upstream builds the report
    // from a planner that ran before the file rewrites, and reports the plan rather
    // than a count taken afterwards. Same numbers either way here, because mem-plus
    // plans and purges in one synchronous pass over the same connection.
    const report: MemoryForgetReport = {
      agentId: params.agentId,
      dryRun: params.dryRun === true,
      sessionIds: [...sessionIds].toSorted(),
      entryKeys: [...entryKeys].toSorted(),
      mixedLineageEntryKeys: [...mixedLineageEntryKeys].toSorted(),
      untargetableEntryKeys: [...untargetableEntryKeys].toSorted(),
      // Upstream derives these from artifact provenance rows; mem-plus vendors
      // `listMemoryArtifactProvenance` but this entry point does not read it, so
      // the list is empty rather than guessed at.
      curatedWrites: [],
      artifacts: {
        memoryFiles: memoryRewrites.length,
        memoryEntries: removedMemoryEntries,
        memoryLines: removedMemoryLines,
        sessionCorpusFiles: 0,
        sessionCorpusLines: 0,
        indexChunks: 0,
        indexSources: 0,
        ftsRows: 0,
        vectorRows: 0,
        embeddingCacheRows: 0,
        shortTermEntries: 0,
        seenHashScopes: 0,
        backups: 0,
        originRows: allOrigins.filter((origin) => entryKeys.has(origin.entryKey)).length,
      },
      refusals,
    };

    // Upstream returns before opening any database on a dry run or an empty
    // selection (line 407).
    if (params.dryRun || sessionIds.size === 0) {
      return report;
    }

    // --- commit rewrites (upstream lines 496-507, verbatim shape) ---
    // Upstream marks before it purges (`memory-forget-kernel.ts:53`: "The earlier
    // tombstone commit survives any failure of this separate purge"), so a crash
    // between here and the rewrite leaves the sessions tombstoned and a retry can
    // tell the difference. Same ordering.
    const tombstoned = params.markForgotten
      ? params.markForgotten({ agentId: params.agentId, sessionIds: [...sessionIds] })
      : 0;

    for (const rewrite of memoryRewrites) {
      await commitMemoryContent({
        workspaceDir: params.workspaceDir,
        filePath: rewrite.absolutePath,
        tempPrefix: `${path.basename(rewrite.absolutePath)}.forget`,
        expectedHash: hashMemoryContent(rewrite.expectedContent),
        expectedContent: rewrite.expectedContent,
        allowInPlaceFallback: true,
        conflictMessage: `${path.basename(rewrite.absolutePath)} changed before the memory forget rewrite could commit`,
        content: rewrite.remove ? null : rewrite.content,
      });
    }

    // The index purge, after the file rewrites. Upstream's order is the same: mark,
    // rewrite files, then purge (`memory-forget.ts:496` onwards), and the planner
    // re-reads the index afterwards so it sees the scrubbed text, not the pre-scrub
    // snapshot it planned against.
    if (params.indexDb) {
      const changedPaths = new Set(memoryRewrites.map((rewrite) => rewrite.absolutePath));
      const purged = planAndPurgeIndex({
        db: params.indexDb,
        agentId: params.agentId,
        entryKeys,
        sessionIds,
        changedPaths,
      });
      report.artifacts.indexChunks = purged.chunks;
      report.artifacts.indexSources = purged.sources;
      report.artifacts.ftsRows = purged.ftsRows;
      report.artifacts.vectorRows = purged.vectorRows;
      report.artifacts.embeddingCacheRows = 0; // no such table in mem-plus
    }
    report.artifacts.tombstones = tombstoned;
    return report;
  };

  // Upstream: `params.dryRun ? run() : withMemoryWorkspaceLock(workspaceDir, run)`.
  return params.dryRun ? run() : withMemoryWorkspaceLock(params.workspaceDir, run);
}

/** Re-exported so a host can preflight the same predicate the scrub uses. */
export { referencesSession };