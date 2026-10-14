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
//   chunk instead of reusing vectors computed by a different model. Passing an empty
//   string for the no-provider case keeps that property: a keyword-only install re-ids
//   when a model appears rather than inheriting incompatible vectors.
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
import { encodeMemoryEmbedding } from "../../packages/memory-host-sdk/src/host/embedding-vector.js";
import { chunkEmbeddingColumn } from "./memory-index-schema.js";
import { chunkMemorySource, DEFAULT_MEMORY_CHUNKING } from "./memory-chunking.js";
import type { MemPlusSource } from "./memory-corpus.js";

/** The model name recorded on every chunk; part of the row identity. */
const NO_MODEL = "";

export type ChunkProvenance = {
  readonly originClass: "owner" | "agent" | "untrusted" | "system";
  readonly sessionKind: "interactive" | "cron" | "heartbeat" | "subagent" | "unknown";
  readonly observedAt: number;
  readonly supersedesKey?: string | null;
};

/** Per-chunk annotations upstream stores in `memory_index_chunk_recall_metadata`. */
export type ChunkRecallMetadata = {
  readonly importance?: number | null;
  readonly triggers?: string | null;
  readonly projectKey?: string | null;
};

export type WriteSourceResult = {
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
  readonly recall?: ChunkRecallMetadata;
  /** Embeddings by chunk id; absent when there is no embedding provider. */
  readonly embeddings?: ReadonlyMap<string, readonly number[]>;
  readonly model?: string;
  readonly chunking?: { readonly tokens: number; readonly overlap: number };
}): WriteSourceResult {
  const { db, relativePath, source, provenance } = params;
  const model = params.model ?? NO_MODEL;

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
  // `memory_index_chunks_vec` is a virtual table from the optional sqlite-vec extension,
  // so it does not exist until the extension is loaded -- upstream's `vectorReady` flag is
  // exactly this, and `buildMemoryIndexStrictSchema` deliberately does not create it. The
  // statement is therefore prepared lazily on the first embedding and skipped entirely when
  // there is none, which is what makes a keyword-only install work under upstream's schema.
  let insertVector: ReturnType<DatabaseSync["prepare"]> | undefined;
  let vectorReady = false;
  let vectorUnavailable = false;
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
      const embedding = params.embeddings?.get(id);
      insertChunk.run(
        id,
        relativePath,
        source,
        chunk.startLine,
        chunk.endLine,
        chunk.hash,
        model,
        chunk.text,
        chunkEmbeddingColumn(embedding),
        now,
      );
      insertProvenance.run(
        id,
        provenance.originClass,
        provenance.sessionKind,
        provenance.observedAt,
        provenance.supersedesKey ?? null,
      );
      if (params.recall) {
        insertRecall.run(
          id,
          params.recall.importance ?? null,
          params.recall.triggers ?? null,
          params.recall.projectKey ?? null,
        );
      }
      if (embedding && embedding.length > 0) {
        if (!vectorReady && !vectorUnavailable) {
          try {
            insertVector = db.prepare(
              "INSERT OR REPLACE INTO memory_index_chunks_vec (id, embedding) VALUES (?, ?)",
            );
            vectorReady = true;
          } catch {
            // The extension is absent. Upstream reports this as "vector index
            // unavailable" and keeps the chunk row; the embedding column already holds
            // the bytes, so a later reindex with the extension loaded can pick them up.
            // Failing the whole write here would be strictly worse than losing the vector.
            vectorUnavailable = true;
          }
        }
        if (insertVector) insertVector.run(id, encodeMemoryEmbedding(embedding));
      }
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
    for (const id of ids) {
      // Same extension gating as the insert: the table may not exist in this build.
      try {
        db.prepare("DELETE FROM memory_index_chunks_vec WHERE id = ?").run(id);
      } catch {
        /* vector table not present */
      }
    }
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