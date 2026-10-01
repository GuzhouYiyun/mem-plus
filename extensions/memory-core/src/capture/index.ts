// Auto-capture ingestion, ported from opencode-mem.
//
// WHAT CHANGED vs openclaw
//   openclaw reached memory through four paths: the file watcher, dreaming's
//   heuristic ingest (sha1 dedupe + length filters, no model), deep promotion into
//   MEMORY.md, and the pre-compaction flush turn. This module replaces the *capture*
//   half of that with opencode-mem's design:
//
//     raw prompt → landing zone → claim → slice assistant turn → bounded markdown
//     context → LLM structured extraction {summary, type, tags} → type="skip" filter
//     → render → append memory/YYYY-MM-DD.md
//
// WHAT DID NOT CHANGE
//   Storage is still openclaw's. The appended daily file is chunked, embedded,
//   FTS5/vec0 indexed and provenance-tagged by the existing indexer, so
//   `memory_search`, `memory_get` and the MEMORY.md promotion write-back keep working.
//   No libSQL sharding and no nomic embedding was introduced.
//
// WHAT IS NOT WIRED YET
//   opencode-mem triggers from OpenCode hooks (`chat.message` lands the prompt,
//   `session.idle` runs the sweep). Nothing here registers a hook: `createMemoryCapture`
//   returns the two callbacks, and the host decides later when to attach them.
import { performCapture } from "./pipeline.js";
import { recordCapturePrompt } from "./landing.js";
import type { CaptureDependencies, CaptureOutcome, CapturePromptRecord } from "./types.js";

export {
  CAPTURE_CLAIM_TTL_MS,
  CAPTURE_CONTEXT_TRUNCATION_MARKER,
  CAPTURE_DEFAULT_MAX_CONTEXT_BYTES,
  CAPTURE_DEFAULT_MAX_RETRIES,
  CAPTURE_MAX_TOOL_INPUT_LENGTH,
  CAPTURE_PROMPTS_NAMESPACE,
  CAPTURE_RETRY_BASE_DELAY_MS,
} from "./constants.js";
export {
  buildBoundedSummaryPrompt,
  buildCaptureMarkdownContext,
  getCaptureMarkdownBudget,
} from "./context.js";
export {
  buildCaptureSystemPrompt,
  CAPTURE_SUMMARY_JSON_SCHEMA,
  CAPTURE_TOOL_SCHEMA,
  extractCaptureSummary,
  parseCaptureSummary,
  resolveCaptureSystemPrompt,
} from "./extract.js";
export {
  configureCaptureLanguageDetector,
  detectCaptureLanguage,
  getCaptureLanguageName,
} from "./language.js";
export { captureUtf8ByteLength, truncateCaptureToMaxBytes } from "./context-limit.js";
export {
  claimCapturePrompt,
  deleteCapturePrompt,
  listPendingCapturePrompts,
  markCapturePromptCaptured,
  recordCapturePrompt,
  reclaimOrphanedCapturePrompts,
  releaseCaptureClaim,
} from "./landing.js";
export { performCapture } from "./pipeline.js";
export { captureEntryKey, captureEntryMarker, renderCaptureEntry } from "./render.js";
export { appendCaptureEntry, resolveCaptureWriteTarget } from "./write.js";
export type {
  CaptureCompleteStructured,
  CaptureCompleteText,
  CaptureDependencies,
  CaptureOutcome,
  CaptureOutcomeKind,
  CapturePromptRecord,
  CaptureSummary,
  CaptureToolCall,
  CaptureTurn,
} from "./types.js";

/** Result of landing a prompt. `recordCapturePrompt` always returns the stored row. */
export type CapturePromptResult = CapturePromptRecord;

/**
 * The reserved attachment surface.
 *
 * `onUserPrompt` is the `chat.message` equivalent; `runSweep` is the `session.idle`
 * equivalent. Both are plain functions with no host import, so connecting OpenCode
 * later is a two-line assignment on the plugin object and needs no change here.
 */
export type CaptureAttachment = {
  onUserPrompt: (params: {
    sessionId: string;
    messageId: string;
    content: string;
    providerId?: string | null;
    modelId?: string | null;
    nowMs?: number;
  }) => Promise<CapturePromptResult>;
  runSweep: (params?: { sessionId?: string; nowMs?: number }) => Promise<CaptureOutcome[]>;
};

/**
 * Build the capture attachment for a host. Calling this only creates the callbacks;
 * no hook is registered and no capture runs until the host invokes them.
 */
export function createMemoryCapture(deps: CaptureDependencies): CaptureAttachment {
  return {
    onUserPrompt: (params) =>
      recordCapturePrompt({
        workspaceDir: deps.workspaceDir,
        sessionId: params.sessionId,
        messageId: params.messageId,
        content: params.content,
        providerId: params.providerId,
        modelId: params.modelId,
        nowMs: params.nowMs,
      }),
    runSweep: (params) =>
      performCapture({
        deps,
        sessionId: params?.sessionId,
        nowMs: params?.nowMs,
      }),
  };
}
