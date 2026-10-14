// Upstream's chunking, reached through upstream's chunker.
//
// PORTED: nothing. The chunker is upstream's own `chunkMarkdown`
// (`packages/memory-host-sdk/src/host/markdown-chunks.ts`, 241 lines, vendored and
// byte-identical, previously unreferenced by `plugin/`). This file supplies its one
// argument and does not reimplement it.
//
// WHY THE CHUNKER, AND NOT A PARSER OF OUR OWN
//   This host used to index `MemoryUnit[]`, produced by a mem-plus parser of its own. That
//   parser is deleted: the read side moved to `memory_index_chunks` and nothing reads the
//   other shape. The two were not the same object -- upstream's `MemoryChunk` carries
//   `startLine` / `endLine` / `hash` / `embeddingInput`, which are exactly the columns
//   `memory_index_chunks` stores, so translating `MemoryUnit` into that row shape would have
//   been inventing a mapping upstream does not have.
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
import {
  extractCuratedEntryRecallMetadata,
  stripMemoryAnnotationCarriers,
} from "../../packages/memory-host-sdk/src/host/curated-annotations.js";
import { CURATED_SOURCE, type MemPlusSource } from "./memory-corpus.js";

/** A chunk plus the recall annotations upstream reads from the lines it spans. */
export type ChunkWithRecall = MemoryChunk & {
  readonly importance: number | null;
  readonly triggers: string | null;
  readonly projectKey: string | null;
};

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
 * `MEMORY.md` / `USER.md` literally; mem-plus's old index stored absolute paths, which is
 * recorded as a divergence in `docs/port-plan.md`.
 *
 * The recall metadata is extracted per chunk span, from upstream's
 * `manager-index-preparation.ts:82-97`:
 *
 *   const start = chunk.entryStartLine ?? chunk.startLine;
 *   const end   = chunk.entryEndLine   ?? chunk.endLine;
 *   metadata = extractCuratedEntryRecallMetadata({
 *     curatedRoot:        pathClassification.curatedRoot,
 *     projectScopeEligible: source === "memory" && normalizedEntryPath.toUpperCase() !== "USER.MD",
 *     sourceLines: sourceLines.slice(start - 1, end),
 *   });
 *
 * Three details that are upstream's and are kept:
 *   - `entryStartLine` / `entryEndLine` are preferred over `startLine` / `endLine`. Under
 *     `perEntry` the chunker reports the entry's span rather than the fragment's, which is
 *     what makes an annotation anywhere in the entry reach every fragment of it.
 *   - `sourceLines` is `[]` for any source other than `memory` (`manager-index-preparation.ts:60`),
 *     so a wiki or session chunk never acquires recall metadata.
 *   - `USER.md` is excluded from project scoping (`toUpperCase() !== "USER.MD"`), which is
 *     not a typo in the transcription: it is upstream's rule, and it is why a project key in
 *     `USER.md` does not scope to the project.
 *
 * The per-span cache is upstream's too (`:77`) and is not merely an optimisation here: a long
 * entry produces many fragments that share one span, and parsing the annotations once per
 * fragment is what upstream avoids.
 */
export function chunkMemorySource(params: {
  readonly content: string;
  readonly source: MemPlusSource;
  /** Workspace-relative, POSIX separators. */
  readonly relativePath: string;
  readonly chunking?: { readonly tokens: number; readonly overlap: number };
}): ChunkWithRecall[] {
  const perEntry = isCuratedPath(params.source, params.relativePath);
  const indexingContent =
    params.source === CURATED_SOURCE ? stripMemoryAnnotationCarriers(params.content) : params.content;
  const baseChunks = chunkMarkdown(indexingContent, {
    ...(params.chunking ?? DEFAULT_MEMORY_CHUNKING),
    perEntry,
  }).filter((chunk) => chunk.text.trim().length > 0);
  const sourceLines =
    params.source === CURATED_SOURCE ? params.content.replace(/\r\n/gu, "\n").split("\n") : [];
  const bySpan = new Map<string, ReturnType<typeof extractCuratedEntryRecallMetadata>>();
  return baseChunks.map((chunk) => {
    const start = chunk.entryStartLine ?? chunk.startLine;
    const end = chunk.entryEndLine ?? chunk.endLine;
    const span = `${start}:${end}`;
    let metadata = bySpan.get(span);
    if (!metadata) {
      metadata = extractCuratedEntryRecallMetadata({
        curatedRoot: perEntry,
        projectScopeEligible:
          params.source === CURATED_SOURCE && params.relativePath.toUpperCase() !== "USER.MD",
        sourceLines: sourceLines.slice(start - 1, end),
      });
      bySpan.set(span, metadata);
    }
    return Object.assign(chunk, metadata);
  });
}

export { MEMORY_CHUNKING_VERSION };