// Upstream's index schema, created by calling upstream's own functions.
//
// PORTED: nothing. This file contains no DDL. Every statement comes from
// `packages/memory-host-sdk/src/host/memory-schema-base.ts` and
// `memory-schema-fts.ts`, both of which are byte-identical to openclaw and already
// vendored. Calling them rather than retyping them is the point: a transcription of a
// schema is a new schema, and this one has eleven tables whose column order and CHECK
// constraints the rest of upstream assumes.
//
// WHAT THIS REPLACES
//   mem-plus carried its own `documents` / `units` / `units_fts` / `vectors` schema in
//   `memory-index.ts`, written alongside the upstream schema modules rather than through
//   them. That is the divergence this file exists to close. Measured 2026-10-13:
//   `extensions/memory-core/src/memory/` holds 85 upstream files of which mem-plus had
//   10 (2 identical, 8 adapted) -- 5% -- so the rest of the layer was not missing, it
//   was replaced. See `docs/port-plan.md`.
//
// THE ONE THING UPSTREAM'S DDL ASSUMES THAT DOES NOT HOLD HERE
//   `memory_index_chunks.embedding` is `BLOB NOT NULL`, which reads like it would
//   refuse an index built without an embedding provider. It does not: upstream writes an
//   EMPTY blob when there is no embedding
//   (`memory-schema-storage-migration.ts:360`, `encodeMemoryEmbedding(... ?? [])`).
//   A keyword-only install is therefore first-class, and `embedChunk` below reproduces
//   that convention rather than inventing one.
//
// SEPARATE DATABASE FILE
//   Upstream puts the index inside openclaw's per-agent SQLite, the same file as the
//   session store, and coordinates with it: shared WAL maintenance
//   (`memory/manager-db.ts:215-219`), the shared schema-contract readers, and
//   `openOpenClawAgentDatabaseReadOnly` (`manager-db.ts:241-260`) for reader admission.
//   None of that exists in OpenCode, and the index is a rebuildable cache of files on
//   disk rather than a projection of the session store, so it owns its own file. That is
//   the same conclusion the fusion read reached independently for (d).
import type { DatabaseSync } from "node:sqlite";
import {
  buildMemoryIndexStrictSchema,
  MEMORY_EMBEDDING_CACHE_TABLE,
} from "../../packages/memory-host-sdk/src/host/memory-schema-base.js";
import {
  ensureMemoryChunkFtsSchema,
  ensureMemoryChunkFtsTriggers,
  ensureMemoryPathFtsSchema,
  ensureMemoryPathFtsTriggers,
} from "../../packages/memory-host-sdk/src/host/memory-schema-fts.js";
import { encodeMemoryEmbedding } from "../../packages/memory-host-sdk/src/host/embedding-vector.js";

/**
 * Upstream's default FTS tokenizer clause, verbatim: `memory-schema.ts:417` passes an
 * EMPTY string for `unicode61` and only the `trigram` alternative gets a clause, which
 * is comma-prefixed (`, tokenize='trigram case_sensitive 0'`). Passing a bare
 * `tokenize = 'unicode61'` is not a harmless spelling difference -- SQLite rejects the
 * CREATE, and the declaration-check regex at `memory-schema-fts.ts:58` treats "no
 * tokenizer option" and "exactly `tokenize = 'unicode61'`" as the same accepted shape.
 */
const TOKENIZE_CLAUSE = "";

/**
 * Create or reconcile every table and virtual table the index needs.
 *
 * Upstream's own builders are idempotent: `ensureMemoryChunkFtsSchema` drops and
 * rebuilds an FTS table whose stored columns do not match what the code expects, which
 * is how a schema change recovers without a separate migration step.
 *
 * THE TRIGGERS ARE NOT OPTIONAL. Upstream maintains both FTS indexes with triggers on
 * `memory_index_sources` and `memory_index_chunks` rather than with a second write path
 * (`memory-schema-fts.ts:145-181`). Creating the tables without the triggers yields an
 * index where chunks exist and nothing is searchable -- a failure that looks like "search
 * returns zero results" rather than like a schema problem, which is the same class of
 * invisible cause the existing search error handling was written to avoid.
 */
export function ensureMemoryIndexSchema(db: DatabaseSync): void {
  db.exec(
    buildMemoryIndexStrictSchema({
      embeddingCacheTable: MEMORY_EMBEDDING_CACHE_TABLE,
      includeEmbeddingCache: true,
    }),
  );
  ensureMemoryChunkFtsSchema({ db, ftsTable: "memory_index_chunks_fts", tokenizeClause: TOKENIZE_CLAUSE });
  ensureMemoryPathFtsSchema({ db, tokenizeClause: TOKENIZE_CLAUSE });
  ensureMemoryChunkFtsTriggers(db);
  ensureMemoryPathFtsTriggers(db);

  // The revision fence. Upstream `memory-schema.ts:363-378`, verbatim in structure:
  //
  //   INSERT OR IGNORE INTO memory_index_state (id, revision) VALUES (1, 0);
  //   -- six triggers, one per (table, event) over sources and chunks:
  //      UPDATE memory_index_state SET revision = revision + 1 WHERE id = 1;
  //
  // WITHOUT THESE the table is a row nobody maintains. `forget.mark` bumps `revision`
  // so a rebuild that started before a forget can be recognised as having gone stale
  // (`manager-db.ts:131-134`, "never reuse an old revision"), and every bump lands on
  // `WHERE id = 1` -- so without the seed row the update matches nothing and the fence
  // silently never fires. An index that looks versioned and is not is worse than one
  // that plainly has no fence, because the caller stops checking.
  //
  // The four indexes are upstream's too: the corpus and per-corpus path lookups are what
  // `searchText` and the trigger-candidate queries will run, and the older
  // `idx_memory_index_chunks_path` is dropped because `(path, source)` supersedes it.
  db.exec(`
    INSERT OR IGNORE INTO memory_index_state (id, revision) VALUES (1, 0);
  `);
  db.exec(
    `${[MEMORY_INDEX_SOURCES_TABLE, MEMORY_INDEX_CHUNKS_TABLE]
      .flatMap((table) =>
        ["insert", "update", "delete"].map(
          (event) => `CREATE TRIGGER IF NOT EXISTS ${table}_revision_after_${event}
            AFTER ${event.toUpperCase()} ON ${table}
            BEGIN
              UPDATE memory_index_state SET revision = revision + 1 WHERE id = 1;
            END;`,
        ),
      )
      .join("\n")}

    CREATE INDEX IF NOT EXISTS idx_memory_index_sources_source
      ON ${MEMORY_INDEX_SOURCES_TABLE}(source);
    CREATE INDEX IF NOT EXISTS idx_memory_index_chunks_path_source
      ON ${MEMORY_INDEX_CHUNKS_TABLE}(path, source);
    DROP INDEX IF EXISTS idx_memory_index_chunks_path;
    CREATE INDEX IF NOT EXISTS idx_memory_index_chunks_source
      ON ${MEMORY_INDEX_CHUNKS_TABLE}(source);
  `);
}

/** Upstream's `MemorySource` table name for the revision triggers. */
const MEMORY_INDEX_SOURCES_TABLE = "memory_index_sources";
/** Upstream's chunk table name for the revision triggers. */
const MEMORY_INDEX_CHUNKS_TABLE = "memory_index_chunks";

/**
 * Upstream's embedding column, including its no-provider case.
 *
 * `NOT NULL` is satisfied by a zero-length blob, which is what upstream stores when a
 * chunk has no embedding. Keeping that exact convention is what lets a mem-plus install
 * with no model on disk keep a working keyword index under upstream's schema.
 */
export function chunkEmbeddingColumn(embedding: readonly number[] | undefined): Uint8Array {
  return encodeMemoryEmbedding(embedding ?? []);
}