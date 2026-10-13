// UPSTREAM: `./embeddings.types.js`. See the same declaration and the same reason in
// `embedding-chunk-limits.ts` -- the alias module and its target were both removed by
// the trim, and this file uses the two fields upstream's contract would have given it.
type EmbeddingProvider = { id: string; maxInputTokens?: number };

// Provider input limits are byte-based approximations for pre-embedding chunk splitting.

const DEFAULT_EMBEDDING_MAX_INPUT_TOKENS = 8192;
const DEFAULT_LOCAL_EMBEDDING_MAX_INPUT_TOKENS = 2048;

/** Resolve the effective embedding input limit for a provider. */
export function resolveEmbeddingMaxInputTokens(
  provider: Pick<EmbeddingProvider, "id" | "maxInputTokens">,
): number {
  if (typeof provider.maxInputTokens === "number") {
    return provider.maxInputTokens;
  }

  if (provider.id === "local") {
    return DEFAULT_LOCAL_EMBEDDING_MAX_INPUT_TOKENS;
  }

  return DEFAULT_EMBEDDING_MAX_INPUT_TOKENS;
}
