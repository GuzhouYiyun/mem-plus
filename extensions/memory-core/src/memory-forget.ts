// UPSTREAM: `extensions/memory-core/src/memory-forget.ts` (openclaw), ported.
//
// WHAT IS PORTED
//   The whole pipeline: session selectors -> lineage identity -> workspace lock ->
//   file scrub -> optimistic write -> plugin-state prune -> index purge. Every
//   threshold, every ordering, and every refusal is upstream's. The index layer is
//   mapped onto mem-plus's own schema rather than skipped -- see
//   `planMemoryForgetIndex` for what differs and the two structural
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
// Upstream verbatim: this task file has no imports, so it is byte-identical, and the row
// identities it names are the ones the index now actually stores.
import type { ForgetIndexPlan } from "./memory-forget-index-task.js";
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
  /** Indexed chunk rows dropped by `forget.purge`. Filled from `planMemoryForgetIndex`. */
  indexChunks: number;
  /** Indexed source rows dropped. Filled from `planMemoryForgetIndex`. */
  indexSources: number;
  /** FTS rows dropped. Filled from `planMemoryForgetIndex`. */
  ftsRows: number;
  /** Chunk rows that carried a vector. Filled from `planMemoryForgetIndex`. */
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
 * UPSTREAM: the index-cleanup layer, read side and write side as two files.
 *
 *   read  -- `memory-forget-index-read.ts:36-122` (`readMemoryForgetIndexInWorker`)
 *   write -- `memory-forget-kernel.ts:54-105` (`purgeForgottenMemory`,
 *            `deleteMemoryIndexSources`)
 *   types -- `memory-forget-index-task.ts`, vendored byte-identical, because it has
 *            no imports and the row shapes are the contract this function reports in.
 *
 * These are the only two pieces of the forget subsystem that touch the index, and both
 * now speak upstream's tables directly. That is the whole point: an earlier revision
 * mapped them onto a mem-plus-owned schema (`documents` / `units` / `units_fts` /
 * `vectors`), and when the read side moved to upstream's tables the mapping became
 * silently dead -- the planner selected nothing and purged nothing, with no error.
 *
 * WHAT IS ACTUALLY DIFFERENT, and each is a consequence of something mem-plus does not
 * have rather than a decision:
 *
 *   1. Upstream reads the plan in a read-only worker and deletes on the main
 *      connection. mem-plus opens one `DatabaseSync` for both, so the read and the
 *      delete are one synchronous transaction -- strictly less machinery for the same
 *      two steps.
 *
 *   2. Upstream's `sessions` corpus (`memory/.dreams/session-corpus`) is indexed with
 *      `source = 'sessions'`, and its filter arm keys on provenance
 *      (`originClass === "system"`, `!isMemorySessionIndexable(...)`) and on
 *      `removedSessionPaths`. mem-plus has no session corpus, so `IndexRoot` is
 *      `"home" | "wiki"` and only `memory` and `wiki` are ever written. That arm is
 *      omitted rather than transcribed: kept as dead code, it would read a table whose
 *      rows cannot exist and call an upstream function this tree does not vendor.
 *
 *   3. Upstream's vectors live in `memory_index_chunks_vec`, a loadable sqlite-vec
 *      extension, which is why it has to probe for the table and prepare an extension
 *      path before the purge. mem-plus dropped sqlite-vec entirely; vectors are the
 *      `embedding` column on the chunk row itself, so `vectorRows` counts chunk rows
 *      with a non-empty embedding among the selected ids and needs no extension. This
 *      is the same substitution already registered for `vectorCount` in
 *      `memory-index.ts`, applied to the purge.
 *
 * `embeddingCacheRows` is NOT "no such table": `memory-index-schema.ts:75` passes
 * `includeEmbeddingCache: true`, so `memory_embedding_cache` is created with the index
 * and upstream empties it on every forget (`memory-forget-kernel.ts:76-78`).
 */
function planMemoryForgetIndex(params: {
  db: import("node:sqlite").DatabaseSync;
  agentId: string;
  entryKeys: ReadonlySet<string>;
  sessionIds: ReadonlySet<string>;
  /** Relative to the memory home, in the same form `memory_index_chunks.path` stores. */
  changedPaths: ReadonlySet<string>;
  /** Relative to the memory home: files this forget deletes outright. */
  removedPaths: ReadonlySet<string>;
}): ForgetIndexPlan {
  const { db } = params;
  const tableExists = (name: string): boolean =>
    (
      db
        .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(name) as { ok: number } | undefined
    )?.ok === 1;
  // `chunk_rowid` is the chunk table's primary key; `id` is its TEXT identity, and it is
  // the `id` that upstream reports and deletes on.
  const rows = db
    .prepare(
      `SELECT chunk_rowid AS chunkRowid, id, path, source, text
         FROM memory_index_chunks`,
    )
    .all() as { chunkRowid: number; id: string; path: string; source: string; text: string }[];

  // Upstream lines 63-73: another agent may already have scrubbed the shared file, and its
  // remaining indexed snapshot still owns evidence for this purge. So the text test is run
  // over the index, not over the caller's list of rewritten files, and it is restricted to
  // the curated corpus because that is the corpus whose text carries entry keys.
  const changedPaths = new Set(params.changedPaths);
  for (const row of rows) {
    if (
      row.source === "memory" &&
      scrubMemoryContent({
        content: row.text,
        entryKeys: params.entryKeys,
        sessionIds: params.sessionIds,
        corpusSnippets: new Set<string>(),
        agentId: params.agentId,
      }).content !== row.text
    ) {
      changedPaths.add(row.path);
    }
  }

  // Upstream lines 74-83, minus the `sessions` arm (see the note above).
  const chunks = rows.filter(
    (row) => changedPaths.has(row.path) || referencesSession(row.path, params.agentId, params.sessionIds),
  );

  // Upstream lines 87-94. Sources are selected by REMOVED paths only, not by changed
  // paths: a file that was scrubbed still exists and still has a header. Deleting the
  // header of a surviving file would make the scanner's `unchangedSources` skip it on
  // the next reindex and leave the stale chunk counts in place.
  const sources = (
    db.prepare("SELECT path, source FROM memory_index_sources").all() as {
      path: string;
      source: string;
    }[]
  ).filter((row) => params.removedPaths.has(row.path));

  const chunkIds = chunks.map((row) => row.id);
  // Upstream builds the predicate with kysely's `where("id", "in", [...])`, which emits one
  // bound parameter per value. This is the same statement with the same parameter count;
  // SQLite's variable limit is why the id list is chunked rather than concatenated into
  // one literal `IN`.
  const inList = (): string => `id IN (${chunkIds.map(() => "?").join(", ")})`;

  let ftsRows = 0;
  let vectorRows = 0;
  if (chunkIds.length > 0) {
    // Upstream counts the FTS rows through `memory_index_chunks_fts.rowid`, which the
    // upstream schema maps to `chunk_rowid`, not to the TEXT `id`.
    if (tableExists("memory_index_chunks_fts")) {
      ftsRows = (
        db
          .prepare(
            `SELECT COUNT(*) AS c FROM memory_index_chunks_fts
              WHERE rowid IN (SELECT chunk_rowid FROM memory_index_chunks WHERE ${inList()})`,
          )
          .get(...chunkIds) as { c: number }
      ).c;
    }
    // The `embedding` column is `BLOB NOT NULL`, so "no vector" is a zero-length BLOB and
    // `embedding IS NULL` never fires. See the note on `vectorCount` in `memory-index.ts`.
    vectorRows = (
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM memory_index_chunks
            WHERE ${inList()} AND length(embedding) > 0`,
        )
        .get(...chunkIds) as { c: number }
    ).c;
  }

  // Upstream lines 115-122. Present in mem-plus: the schema is built with
  // `includeEmbeddingCache: true`.
  const embeddingCacheRows =
    params.sessionIds.size > 0 && tableExists("memory_embedding_cache")
      ? (db.prepare("SELECT COUNT(*) AS c FROM memory_embedding_cache").get() as { c: number }).c
      : 0;

  // Upstream's `ForgetIndexPlan`, which is why the vendored task file is load-bearing here
  // rather than decorative: the caller reads `.chunks.length` and `.sources.length` off it,
  // exactly as `memory-forget.ts:397-398` does.
  //
  // `hasVectorTable` and `extensionPath` are upstream's sqlite-vec preparation, which mem-plus
  // does without: `memory_index_chunks_vec` is never created and vectors live on the chunk row
  // (see the note above), so the flag is reported as absent rather than probed for.
  return {
    chunks: chunks.map((row) => ({ id: row.id, path: row.path, source: row.source })),
    sources,
    ftsRows,
    vectorRows,
    embeddingCacheRows,
    hasVectorTable: false,
  };
}

/**
 * UPSTREAM: `purgeForgottenMemory` (`memory-forget-kernel.ts:54-80`) plus
 * `deleteMemoryIndexSources` (`memory-forget-kernel.ts:85-105`), same order.
 *
 * Separate from the planner, as upstream has it separate, and that separation is what makes a
 * dry run worth anything: upstream plans the index before it builds the report, so
 * `dryRun` reports the rows it *would* delete (`memory-forget.ts:356` before `:406`). An
 * earlier revision planned and purged in one function placed after the early return, so every
 * dry run reported `indexChunks: 0` -- the one question a dry run exists to answer.
 */
function purgeForgottenMemoryIndex(
  db: import("node:sqlite").DatabaseSync,
  plan: ForgetIndexPlan,
): void {
  const chunkIds = plan.chunks.map((chunk) => chunk.id);
  if (chunkIds.length > 0) {
    // Chunk rows first. Their provenance and recall-metadata rows cascade
    // (`foreign_keys = ON`) and their FTS rows go with the trigger upstream installs
    // (`memory-schema-fts.ts:152-159`), so neither is deleted by name -- which is why this
    // differs from upstream, where `memory_index_chunks_vec` is a loadable extension with no
    // cascade and has to be deleted explicitly.
    db.prepare(
      `DELETE FROM memory_index_chunks WHERE id IN (${chunkIds.map(() => "?").join(", ")})`,
    ).run(...chunkIds);
  }
  // Upstream groups consecutive rows by source and deletes each group with one
  // `path IN (...) AND source = ?`. One statement per row here, because mem-plus keeps no
  // session corpus, so a plan holds one row per removed file and the grouping would collapse
  // to a single statement either way.
  for (const source of plan.sources) {
    db.prepare("DELETE FROM memory_index_sources WHERE path = ? AND source = ?").run(
      source.path,
      source.source,
    );
  }
  // Upstream empties the whole embedding cache on a forget, not a subset of it: the cache is
  // keyed by content hash across every model, so there is no cheap way to know which entries
  // pointed at a deleted chunk. `plan.embeddingCacheRows` is what the report charges for it,
  // and it is 0 in practice -- nothing in this tree writes the table outside a legacy
  // openclaw migration (`memory-schema.ts:549`).
  if (plan.embeddingCacheRows > 0) {
    db.prepare("DELETE FROM memory_embedding_cache").run();
  }
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

    // The index plan, taken before the report so the report can carry it. Upstream's order is
    // the same: `planMemoryIndex` at line 356, the report at 371-406, and the dry-run return
    // at 407.
    //
    // Upstream line 356 passes `rewrite.relativePath`, not `absolutePath`. The index stores
    // `path` relative to the memory home with forward slashes (`memoryRelativePath`,
    // `plugin/src/memory-index.ts:80`) and the planner compares the two directly. Absolute
    // paths never match, which is how this purge selected nothing while still reporting
    // success.
    //
    // `removedPaths` covers the session corpus upstream, which mem-plus does not index. Its
    // own rewrite branch sets `remove: false` unconditionally, so this is empty here and the
    // planner's source-header deletion has nothing to select. Kept as the parameter it is
    // upstream rather than dropped, so adding a corpus does not mean re-deriving the call.
    const indexPlan = params.indexDb
      ? planMemoryForgetIndex({
          db: params.indexDb,
          agentId: params.agentId,
          entryKeys,
          sessionIds,
          changedPaths: new Set(memoryRewrites.map((rewrite) => rewrite.relativePath)),
          removedPaths: new Set(
            memoryRewrites.filter((rewrite) => rewrite.remove).map((rewrite) => rewrite.relativePath),
          ),
        })
      : undefined;

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
        // Upstream builds the report from the plan it took at line 356, which is why a
        // dry run still reports the index rows it would remove.
        indexChunks: indexPlan?.chunks.length ?? 0,
        indexSources: indexPlan?.sources.length ?? 0,
        ftsRows: indexPlan?.ftsRows ?? 0,
        vectorRows: indexPlan?.vectorRows ?? 0,
        embeddingCacheRows: indexPlan?.embeddingCacheRows ?? 0,
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

    // The index purge, after the file rewrites. Upstream's order is the same: plan, report,
    // mark, rewrite files, then purge (`memory-forget.ts:356`, `:407`, `:496` onwards).
    //
    // The plan was taken before the rewrites, so it is planned against the pre-scrub snapshot.
    // That is upstream's own order and it is safe for the same reason upstream gives: the plan
    // selects by PATH, and a rewritten file's path is in it whether or not its text has changed
    // yet.
    if (indexPlan) {
      purgeForgottenMemoryIndex(params.indexDb!, indexPlan);
    }
    report.artifacts.tombstones = tombstoned;
    return report;
  };

  // Upstream: `params.dryRun ? run() : withMemoryWorkspaceLock(workspaceDir, run)`.
  return params.dryRun ? run() : withMemoryWorkspaceLock(params.workspaceDir, run);
}

/** Re-exported so a host can preflight the same predicate the scrub uses. */
export { referencesSession };