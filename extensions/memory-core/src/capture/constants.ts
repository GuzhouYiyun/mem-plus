// Auto-capture thresholds ported from the opencode-mem ingestion pipeline.
// Source of truth: opencode-mem/src/services/auto-capture.ts

/** Tool inputs are truncated to this many characters before entering the LLM context. */
export const CAPTURE_MAX_TOOL_INPUT_LENGTH = 100;

/** First retry waits this long, then doubles (2s, 4s, 8s ...). */
export const CAPTURE_RETRY_BASE_DELAY_MS = 2_000;

export const CAPTURE_DEFAULT_MAX_RETRIES = 3;

/** Total request budget for one extraction call (context + system prompt + schema + output). */
export const CAPTURE_DEFAULT_MAX_CONTEXT_BYTES = 131_072;

export const CAPTURE_CONTEXT_TRUNCATION_MARKER =
  "\n[... truncated to autoCaptureMaxContextBytes ...]\n";

export const CAPTURE_SUMMARY_REQUEST_OVERHEAD_BYTES = 1_024;
export const CAPTURE_SUMMARY_OUTPUT_RESERVE_BYTES = 16_384;

export const CAPTURE_SUMMARY_ANALYSIS_SUFFIX =
  'Analyze this conversation. If it contains technical work (code, bugs, features, decisions), create a concise summary and relevant tags. If it\'s non-technical (greetings, casual chat, incomplete requests), return type="skip" with empty summary.';

/** Prior memory context feeding the extractor is capped at this many characters. */
export const CAPTURE_LATEST_MEMORY_CHARS = 500;

/**
 * A claim older than this is treated as orphaned by a crashed worker and returns to
 * pending. opencode-mem relies on a SQL row lock release in `finally`; keyed plugin
 * state has no equivalent, so the claim carries its own expiry instead.
 */
export const CAPTURE_CLAIM_TTL_MS = 5 * 60_000;

/** Landing-zone namespace in SQLite-backed plugin state (opencode-mem: `user_prompts`). */
export const CAPTURE_PROMPTS_NAMESPACE = "capture-prompts";

/** Identifier marker written next to each persisted capture so retries stay idempotent. */
export const CAPTURE_ENTRY_MARKER_KIND = "openclaw-capture";
