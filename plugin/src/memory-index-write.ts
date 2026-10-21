// Upstream's chunk write path, in upstream's shape.
//
// UPSTREAM: `extensions/memory-core/src/memory/manager-source-index-kernel.ts:70-95`
// (`replaceRows`) plus the row shape of `manager-chunk-writer.ts:48`
// (`createMemoryChunkWriter`). The chunker that produces `chunk` is upstream's own; see
// `memory-chunking.ts`.
//
// WHY CLEAR-THEN-WRITE AND NOT AN UPSERT
//   Upstream deletes every row for `(path, source)` before inserting the new set, and the
//   identity of a row is a hash of six fields:
//
//     const id = hashText(
//       `${source}:${entry.path}:${chunk.startLine}:${chunk.endLine}:${chunk.hash}:${model}`
//     );
//
//   That combination is what replaces mem-plus's `units.marker`. `marker` existed to stop
//   the same capture being written twice, enforced by a unique index; upstream gets the
//   same guarantee structurally, because a re-index of a file cannot leave a previous
//   generation of that file behind. Two consequences that are upstream's behaviour and
//   are therefore kept:
//     - `marker` retires. Nothing in this file or in `memory-corpus.ts` reintroduces it.
//     - Mirror de-duplication retires with it. Upstream does not pick a `holder` when the
//       same bytes appear under two roots; the corpora are separated by the `source`
//       column and queries filter by corpus, so both copies are stored by design.
//
// THE FIELD THAT DECIDES EVERYTHING ELSE
//   `model` is part of the row identity, so changing the embedding model re-ids every
//   chunk instead of reusing vectors computed by a different model. Passing upstream's
//   literal "fts-only" for the no-provider case keeps that property: a keyword-only
//   install re-ids when a model appears rather than inheriting incompatible vectors.
//   The literal is also what `hasSemanticChunks` tests against -- see NO_MODEL below.
//
// PER-CHUNK PROVENANCE IS THE POINT OF THE EXERCISE
//   mem-plus's own index carried `origin_class` on the DOCUMENT, one value per file, so a
//   curated file holding both qualified and unqualified entries could not be split. Here
//   every chunk gets its own row in `memory_index_chunk_provenance`, which is what makes
//   the architecture's structural security property -- untrusted content cannot launder
//   itself into `MEMORY.md` -- decidable at chunk grain, and what lets the second corpus
//   carry `untrusted` while the curated rows carry `agent` in the same database.
import type { DatabaseSync } from "node:sqlite";
import { hashText } from "../../packages/memory-host-sdk/src/host/hash.js";
import { chunkEmbeddingColumn } from "./memory-index-schema.js";
import { chunkMemorySource, DEFAULT_MEMORY_CHUNKING } from "./memory-chunking.js";
import type { MemPlusSource } from "./memory-corpus.js";

/**
 * The `model` recorded on every chunk when there is no embedding provider.
 *
 * Upstream's own value, read from `manager-reindex-state.ts:164`:
 *
 *     const model = params.provider?.model?.trim() || "fts-only";
 *
 * and confirmed by `manager-sync-base.ts:330`, which decides whether the index holds any
 * semantic chunks with `SELECT 1 FROM memory_index_chunks WHERE model != 'fts-only'`. So the
 * literal is load-bearing in two places, and an empty string would have made every chunk
 * look semantic while `hasSemanticChunks` reported none. It also has to differ from every
 * real model name, which is why it is a word and not a null.
 */
const NO_MODEL = "fts-only";

type ChunkProvenance = {
  readonly originClass: "owner" | "agent" | "untrusted" | "system";
  readonly sessionKind: "interactive" | "cron" | "heartbeat" | "subagent" | "unknown";
  readonly observedAt: number;
  readonly supersedesKey?: string | null;
};

/** Per-chunk annotations upstream stores in `memory_index_chunk_recall_metadata`. */
type WriteSourceResult = {
  readonly path: string;
  readonly source: MemPlusSource;
  readonly cleared: number;
  readonly written: number;
};

/**
 * Upstream's `replaceRows`: clear `(path, source)`, then write the chunks whole.
 *
 * FTS is not written here. Upstream maintains both FTS indexes with triggers
 * (`memory-schema-fts.ts:145-181`), so inserting a chunk is enough.
 */
export function writeSourceChunks(params: {
  readonly db: DatabaseSync;
  /** Workspace-relative, POSIX separators. Upstream stores relative paths. */
  readonly relativePath: string;
  readonly source: MemPlusSource;
  readonly content: string;
  readonly hash: string;
  readonly bytes: number;
  readonly mtime: number;
  readonly provenance: ChunkProvenance;
  /** Embeddings by chunk id; absent when there is no embedding provider. */
  readonly embeddings?: ReadonlyMap<string, readonly number[]>;
  readonly model?: string;
  readonly chunking?: { readonly tokens: number; readonly overlap: number };
}): WriteSourceResult {
  const { db, relativePath, source, provenance } = params;
  const model = params.model ?? NO_MODEL;

  // A re-index must not erase vectors for chunks that did not change.
  //
  // Upstream computes embeddings inside the same reindex that replaces the rows
  // (`manager-index-preparation.ts:79`), so it never has to carry them across a
  // clear. mem-plus embeds in a separate pass (`embedMissing`); a re-index without
  // that pass -- every session snapshot rewrite, per `index.ts` -- would otherwise
  // leave the whole file fts-only. The row id already contains the source, path,
  // span, text hash and model (`docs/memory-chain.md` §2), so an unchanged chunk has
  // the same id and can keep its old blob. A changed chunk gets a new id and
  // correctly starts with no vector.
  const preserved = new Map<string, Uint8Array>();
  {
    const rows = db
      .prepare(
        "SELECT id, embedding FROM memory_index_chunks WHERE path = ? AND source = ? AND model = ? AND length(embedding) > 0",
      )
      .all(relativePath, source, model) as { id: string; embedding: Uint8Array }[];
    for (const row of rows) preserved.set(row.id, row.embedding);
  }

  // Upstream: `this.clear(entry.path, source)` -- the whole de-duplication story.
  const cleared = clearSource(db, relativePath, source);

  const chunks = chunkMemorySource({
    content: params.content,
    source,
    relativePath,
    ...(params.chunking ? { chunking: params.chunking } : {}),
  });

  const insertChunk = db.prepare(
    `INSERT INTO memory_index_chunks
       (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertProvenance = db.prepare(
    `INSERT OR REPLACE INTO memory_index_chunk_provenance
       (chunk_id, origin_class, session_kind, observed_at, supersedes_key)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const insertRecall = db.prepare(
    `INSERT OR REPLACE INTO memory_index_chunk_recall_metadata
       (chunk_id, importance, triggers, project_key)
     VALUES (?, ?, ?, ?)`,
  );
  // Chunks with no annotations still get a row, with three NULLs. Upstream writes the
  // metadata unconditionally for the same reason its candidate query can then say
  // `metadata.triggers is not null` instead of having to distinguish "no row" from "no
  // triggers" -- which would be indistinguishable anyway.
  //
  // `memory_index_chunks_vec` IS NOT WRITTEN, AND THAT IS MEASURED RATHER THAN ASSUMED.
  //   It is a virtual table from the optional `sqlite-vec` extension, which upstream loads
  //   through `packages/memory-host-sdk/src/host/sqlite-vec.ts` (vendored here, byte-identical,
  //   exporting `loadSqliteVecExtension`). That loader needs the `sqlite-vec` npm package plus
  //   upstream's `memory.search.store.vector.extensionPath` setting. Measured 2026-10-14:
  //   the package is not installed, not a dependency, and the setting has no counterpart in this
  //   project. So the table does not exist, every `prepare` on it throws, and an earlier version
  //   of this function carried a hand-written `vectorReady` / `vectorUnavailable` gate that
  //   swallowed the throw -- a branch that looked alive in the source and had never once
  //   succeeded. It is deleted rather than wired up.
  //
  //   WHY DELETING IS RIGHT, MEASURED: nothing is lost but an index shape. Upstream's schema
  //   declares `embedding BLOB NOT NULL` on `memory_index_chunks` and `buildMemoryIndexStrictSchema`
  //   does not create the vec table, so the embedding is stored on the chunk row either way --
  //   which is what `storeVector` writes and what `searchVector` reads. Vector search works
  //   without the extension; it does a bounded scan (`candidateLimit`, default 20 000) instead of
  //   a KNN lookup. The live index holds 1 996 units across 24 documents, and a bounded scan over
  //   that is not a cost worth a native extension and a new setting. If that ever changes, the
  //   fix is upstream's own loader plus a dependency decision, not a revived local branch.
  const upsertSource = db.prepare(
    `INSERT INTO memory_index_sources (path, source, hash, mtime, size)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (path, source) DO UPDATE SET hash = excluded.hash,
       mtime = excluded.mtime, size = excluded.size`,
  );

  const now = params.mtime || Date.now();
  let written = 0;
  // Upstream's own guard, from `memory-schema-provenance.ts:41-46`: the writer may be
  // called from inside a caller's transaction, and a bare `BEGIN` there is "cannot start a
  // transaction within a transaction" -- which would abort the caller's whole unit of work
  // over a detail of ours. Joining an open transaction is what "atomic" means here anyway.
  const own = !db.isTransaction;
  if (own) db.exec("BEGIN");
  try {
    for (const chunk of chunks) {
      // Upstream's row identity, verbatim.
      const id = hashText(
        `${source}:${relativePath}:${chunk.startLine}:${chunk.endLine}:${chunk.hash}:${model}`,
      );
      const fresh = params.embeddings?.get(id);
      const embedding =
        fresh !== undefined ? chunkEmbeddingColumn(fresh) : (preserved.get(id) ?? chunkEmbeddingColumn(undefined));
      insertChunk.run(
        id,
        relativePath,
        source,
        chunk.startLine,
        chunk.endLine,
        chunk.hash,
        model,
        chunk.text,
        embedding,
        now,
      );
      insertProvenance.run(
        id,
        provenance.originClass,
        provenance.sessionKind,
        provenance.observedAt,
        provenance.supersedesKey ?? null,
      );
      insertRecall.run(id, chunk.importance, chunk.triggers, chunk.projectKey);
      written += 1;
    }
    upsertSource.run(relativePath, source, params.hash, params.mtime, params.bytes);
    if (own) db.exec("COMMIT");
  } catch (error) {
    if (own) db.exec("ROLLBACK");
    throw error;
  }
  return { path: relativePath, source, cleared, written };
}

/** Remove every row for one `(path, source)`, including the vectors behind them. */
export function clearSource(db: DatabaseSync, relativePath: string, source: MemPlusSource): number {
  // No per-row vector deletes: `memory_index_chunks_vec` is never written, so there is nothing
  // in it to clear. See the note in `writeSourceChunks` for why that is a measured fact rather
  // than a gap. The chunk rows carry the embedding on themselves and go with the DELETE below.
  const ids = (
    db.prepare("SELECT id FROM memory_index_chunks WHERE path = ? AND source = ?").all(relativePath, source) as {
      id: string;
    }[]
  ).map((row) => row.id);
  // Same guard as in `writeSourceChunks`: join an open transaction rather than starting a
  // nested one. See upstream `memory-schema-provenance.ts:41-46`.
  const own = !db.isTransaction;
  if (own) db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM memory_index_chunks WHERE path = ? AND source = ?").run(relativePath, source);
    db.prepare("DELETE FROM memory_index_sources WHERE path = ? AND source = ?").run(relativePath, source);
    if (own) db.exec("COMMIT");
  } catch (error) {
    if (own) db.exec("ROLLBACK");
    throw error;
  }
  return ids.length;
}

export { DEFAULT_MEMORY_CHUNKING };