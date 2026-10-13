import { estimateUtf8Bytes, splitTextToUtf8ByteLimit } from "./embedding-input-limits.js";
import { hasNonTextEmbeddingParts } from "./embedding-inputs.js";
import { resolveEmbeddingMaxInputTokens } from "./embedding-model-limits.js";
// UPSTREAM: `./embeddings.types.js`, a 6-line re-export of openclaw's canonical
// `src/plugins/embedding-provider-types.js`.
//
// WHY IT IS DECLARED INLINE INSTEAD. The alias module was removed by the trim
// (3b4f6b6d, 2026-10-04) together with its own target: mem-plus has no
// `src/plugins/embedding-provider-types.ts`, so restoring the alias verbatim would
// trade one unresolved specifier for another. This file used only two of that
// contract's fields, and both uses already narrow with
// `Pick<..., "id" | "maxInputTokens">`, so the imported shape is exactly this.
// Every field is upstream's, with upstream's optionality: `maxInputTokens` is
// absent when the provider does not declare a limit, which is the branch
// `resolveEmbeddingMaxInputTokens` below is written around.
type EmbeddingProvider = { id: string; maxInputTokens?: number };
import { hashText } from "./hash.js";
import type { MemoryChunk } from "./internal.js";

// Enforces provider byte budgets before chunks reach embedding workers.

/**
 * Split text-only chunks to the provider's effective input limit.
 *
 * Structured multimodal chunks are preserved because only the provider can decide how to count
 * non-text parts.
 */
export function enforceEmbeddingMaxInputTokens(
  provider: Pick<EmbeddingProvider, "id" | "maxInputTokens">,
  chunks: MemoryChunk[],
  hardMaxInputTokens?: number,
): MemoryChunk[] {
  const providerMaxInputTokens = resolveEmbeddingMaxInputTokens(provider);
  const maxInputTokens =
    typeof hardMaxInputTokens === "number" && hardMaxInputTokens > 0
      ? Math.min(providerMaxInputTokens, hardMaxInputTokens)
      : providerMaxInputTokens;
  const out: MemoryChunk[] = [];

  for (const chunk of chunks) {
    if (hasNonTextEmbeddingParts(chunk.embeddingInput)) {
      out.push(chunk);
      continue;
    }
    if (estimateUtf8Bytes(chunk.text) <= maxInputTokens) {
      out.push(chunk);
      continue;
    }

    for (const text of splitTextToUtf8ByteLimit(chunk.text, maxInputTokens)) {
      out.push({
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        ...(chunk.entryStartLine !== undefined
          ? { entryStartLine: chunk.entryStartLine, entryEndLine: chunk.entryEndLine }
          : {}),
        text,
        hash: hashText(text),
        embeddingInput: { text },
        ...(chunk.provenance ? { provenance: chunk.provenance } : {}),
      });
    }
  }

  return out;
}
