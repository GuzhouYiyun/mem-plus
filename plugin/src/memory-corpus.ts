// mem-plus's second corpus, added to upstream's schema. An L3 seam.
//
// WHY THIS FILE EXISTS
//   Upstream's `MemorySource` is a closed two-value union, `"memory" | "sessions"`
//   (`packages/memory-host-sdk/src/host/types.ts`). mem-plus indexes a second corpus --
//   the wiki -- and has no value to put it under. That is not a naming difference an
//   adapter can bridge: the union has no room for it.
//
//   What makes it small rather than a rewrite: the union is a TypeScript narrowing, not
//   a storage constraint. `memory_index_sources.source` is `TEXT NOT NULL DEFAULT
//   'memory'` and `memory_index_chunks.source` is `TEXT NOT NULL`, so the database
//   already accepts and separates a third value. Measured on a real database built by
//   `ensureMemoryIndexSchema`: two corpora coexist, `WHERE source = 'wiki'` returns only
//   the wiki rows, and the curated whitelist `path IN ('MEMORY.md','USER.md')` still
//   admits exactly the curated rows and no wiki row.
//
// FUNCTIONAL EQUIVALENCE, NOT A NEW SUBSYSTEM
//   Nothing here reimplements upstream behaviour. It widens the type at the boundary
//   where mem-plus calls upstream, and relies on three upstream behaviours that are
//   already proven to hold with a third source value:
//     - `memory_index_sources` is `UNIQUE (path, source)`, so the two corpora keep
//       separate rows instead of overwriting each other.
//     - Curated auto-injection is gated on the PATH whitelist, not on the source, so a
//       wiki path never qualifies. Verified: whitelist count stays 1 with a wiki row
//       present.
//     - Promotion is gated on `memory_index_chunk_provenance.origin_class`, which is PER
//       CHUNK. That is the capability mem-plus's own per-FILE provenance lacks, and it
//       is what lets wiki rows carry `untrusted` while curated rows carry `agent` in the
//       same database. Verified by reading both back after writing.
//   The security property the architecture documents as structural -- untrusted content
//   cannot launder itself into `MEMORY.md` -- therefore holds for the wiki corpus for
//   the same reason it holds upstream.
//
// WHAT THIS DOES NOT REPLACE
//   mem-plus's mirror de-duplication. `memory-index.ts` picks a single `holder` when the
//   same bytes appear under two roots, and records the other as a mirror with no units.
//   Upstream has no equivalent and does not need one, because its corpora are separated
//   BY `source` rather than by precedence: the same file under `memory` and under `wiki`
//   is two rows by design, and queries filter by corpus. Porting upstream's model
//   therefore means giving that mechanism up, not translating it.
import type { MemorySource } from "../../packages/memory-host-sdk/src/host/types.js";

/**
 * mem-plus's corpora, as written to upstream's `source` column.
 *
 * `memory` is upstream's own value and is used unchanged, so every upstream query, filter
 * and index that compares against `"memory"` keeps working without a single edit. Only the
 * second corpus needs a value of our own.
 */
export type MemPlusSource = MemorySource | "wiki";

/** The value the wiki corpus is stored under. */
export const WIKI_SOURCE = "wiki" satisfies MemPlusSource;

/** Every value the index may hold, in query-filter order. */
export const MEM_PLUS_SOURCES: readonly MemPlusSource[] = ["memory", "sessions", WIKI_SOURCE];

/**
 * Upstream's `MemorySource`, widened by exactly one member.
 *
 * This is the whole adapter. Callers that only ever see upstream's two values keep
 * upstream's type; callers holding a `MemPlusSource` narrow it before handing it to
 * upstream code, so nothing inside the vendored tree has to change.
 */
export function asMemorySource(source: MemPlusSource): MemorySource | undefined {
  return source === "wiki" ? undefined : source;
}

/** The curated corpus, which is also the only one eligible for automatic injection. */
export const CURATED_SOURCE: MemPlusSource = "memory";

/** True for corpora whose chunks may be auto-injected on an ordinary turn. */
export function isAutoInjectableSource(source: MemPlusSource): boolean {
  return source === CURATED_SOURCE;
}