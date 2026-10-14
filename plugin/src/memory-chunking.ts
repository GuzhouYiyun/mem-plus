// Upstream's chunking, reached through upstream's chunker.
//
// PORTED: nothing. The chunker is upstream's own `chunkMarkdown`
// (`packages/memory-host-sdk/src/host/markdown-chunks.ts`, 241 lines, vendored and
// byte-identical, previously unreferenced by `plugin/`). This file supplies its one
// argument and does not reimplement it.
//
// WHY THE CHUNKER, AND NOT mem-plus's `memory-parse.ts`
//   `memory-index.ts` indexes `MemoryUnit[]`, produced by mem-plus's own parser. Upstream
//   indexes `MemoryChunk[]`, produced by `chunkMarkdown`. The two are not the same
//   object: upstream's carries `startLine` / `endLine` / `hash` / `embeddingInput`, which
//   are exactly the columns `memory_index_chunks` stores. Translating `MemoryUnit` into
//   that row shape would be inventing a mapping upstream does not have.
//
// THE DEFAULTS ARE UPSTREAM'S, READ NOT GUESSED
//   `src/agents/memory-search.ts` resolves `chunking: { tokens: 400, overlap: 80 }`. Those
//   are the numbers the architecture documentation describes as "~400 token target,
//   80-token overlap". `MEMORY_CHUNKING_VERSION` is 5 and is part of index identity: when
//   the chunking rules change the whole index must be rebuilt, which is why both go
//   through this file rather than being passed around.
//
// TWO PIECES OF UPSTREAM SEMANTICS THAT ARE NOT OPTIONAL
//   `manager-index-preparation.ts:68-70` is upstream's only production call site:
//
//     const perEntry = source === "memory" && (normalizedEntryPath === "MEMORY.md" || normalizedEntryPath === "USER.md");
//     const indexingContent = source === "memory" ? stripMemoryAnnotationCarriers(content) : content;
//     const chunkOptions = { ...chunking, perEntry };
//     const baseChunks = chunkMarkdown(indexingContent, chunkOptions)
//
//   - `perEntry` decides the curated tier by SOURCE PLUS PATH, the same test as the
//     auto-injection whitelist at `memory-recall-metadata.ts:231`.
//   - `stripMemoryAnnotationCarriers` removes `<!-- trigger: ... -->` /
//     `<!-- importance: N -->` before indexing. mem-plus keeps those in the indexed text,
//     so today its FTS matches the annotation strings themselves and trigger hits are
//     perturbed by them. Skipping this step is not a stylistic difference: it changes what
//     `memory_search` returns.
import {
  chunkMarkdown,
  MEMORY_CHUNKING_VERSION,
  type MemoryChunk,
} from "../../packages/memory-host-sdk/src/host/markdown-chunks.js";
import { stripMemoryAnnotationCarriers } from "../../packages/memory-host-sdk/src/host/curated-annotations.js";
import { CURATED_SOURCE, type MemPlusSource } from "./memory-corpus.js";

/** Upstream's resolved defaults, verbatim from `src/agents/memory-search.ts`. */
export const DEFAULT_MEMORY_CHUNKING = { tokens: 400, overlap: 80 } as const;

/** Paths upstream treats as the curated tier, for per-entry chunking and for injection. */
const CURATED_PATHS: ReadonlySet<string> = new Set(["MEMORY.md", "USER.md"]);

/** Upstream's `perEntry` test: the curated corpus AND a curated path. */
function isCuratedPath(source: MemPlusSource, relativePath: string): boolean {
  return source === CURATED_SOURCE && CURATED_PATHS.has(relativePath);
}

/**
 * Upstream's chunking step, in upstream's order.
 *
 * The relative path is the workspace-relative one, because `perEntry` compares it against
 * `MEMORY.md` / `USER.md` literally; mem-plus's existing index stored absolute paths, which
 * is recorded as a divergence in `docs/port-plan.md`.
 */
export function chunkMemorySource(params: {
  readonly content: string;
  readonly source: MemPlusSource;
  /** Workspace-relative, POSIX separators. */
  readonly relativePath: string;
  readonly chunking?: { readonly tokens: number; readonly overlap: number };
}): MemoryChunk[] {
  const perEntry = isCuratedPath(params.source, params.relativePath);
  const indexingContent =
    params.source === CURATED_SOURCE ? stripMemoryAnnotationCarriers(params.content) : params.content;
  const chunks = chunkMarkdown(indexingContent, {
    ...(params.chunking ?? DEFAULT_MEMORY_CHUNKING),
    perEntry,
  });
  return chunks.filter((chunk) => chunk.text.trim().length > 0);
}

export { MEMORY_CHUNKING_VERSION };