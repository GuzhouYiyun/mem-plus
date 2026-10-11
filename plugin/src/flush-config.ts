// Pre-compaction memory flush: the admission policy.
//
// WHAT THIS IS
//   openclaw flushes memory before the context is compacted -- a hidden agent
//   turn that writes whatever is worth keeping into `memory/YYYY-MM-DD.md`, so the
//   words a compaction is about to discard are already on disk. Ported from
//   `extensions/memory-core/src/flush-plan.ts` (prompt, thresholds) and
//   `src/auto-reply/reply/memory-flush.ts` (the gate).
//
// WHAT MOVED AND WHY
//   `resolveEffectivePromptTokens` and `estimatePromptTokensForMemoryFlush` are
//   upstream's own estimate of the *next* prompt's cost, used to trigger a flush
//   before the request that would cross the threshold. mem-plus gates on the
//   last observed usage instead: OpenCode reports real token counts per assistant
//   message, so there is nothing left to estimate, and an estimate of a request
//   that has not been sent is a number nobody can check.
//
//   `resolveResponsesServerCompactionThreshold` (Anthropic / OpenAI Responses
//   server-side compaction plans) is not ported: those are provider-internal
//   thresholds, and mem-plus reads OpenCode's own `Model.Info.limit.context`.
//
// THE THRESHOLD IS A RATIO, NOT A TOKEN COUNT
//   Upstream defaults to `softThresholdTokens = 4000` but caps the reserved
//   compaction space at a quarter of the window, so the flush effectively runs at
//   75% of the window on every model whose window is large enough for the cap to
//   bind, and at `window - 4000` on the small ones. Writing the ratio directly is
//   the same policy with one fewer knob, and `flush.contextRatio` is that 0.75.
//
// COPIED VERBATIM FROM `flush-plan.ts`
//   The four prompt clauses, both prompt texts, and the `enabled` / `model`
//   knobs. `SILENT_REPLY_TOKEN` is imported from the vendored openclaw tree
//   rather than retyped, so the token stays the host's single definition.
//
// NOT PORTED: `forceFlushTranscriptBytes`
//   Upstream's second trigger is the transcript's own size (2 MB default), read at
//   gate time from the session entry. OpenCode's compaction event carries
//   `reason`, `recent` and an optional `inputID` and no byte count, and the flush
//   gate reads real token usage off assistant messages, so there is no equivalent
//   number to compare. A knob nothing feeds would be a lie in `config.jsonc`.
import { buildCaptureSystemPrompt } from "../../extensions/memory-core/src/capture/extract.js";
import { detectCaptureLanguage, getCaptureLanguageName } from "../../extensions/memory-core/src/capture/language.js";
import { SILENT_REPLY_TOKEN } from "../../src/auto-reply/tokens.js";
import type { HostedModelRef } from "./model/config.js";

/**
 * The occupancy that opens the gate: openclaw's `MAX_COMPACTION_RESERVE_RATIO` is
 * 0.25, so the flush runs at the complement, 0.75. One constant, because it is both
 * the default `flush.contextRatio` and the gate's own fallback -- a second name for
 * the same number is a second place for it to change.
 */
const DEFAULT_CONTEXT_RATIO = 0.75;

export type FlushConfig = {
  /** `flush.enabled: false` turns the flush off; nothing else changes. */
  readonly enabled: boolean;
  /**
   * Context occupancy that triggers a flush, as a fraction of the model's window.
   * Upstream's effective 0.75, stated directly.
   */
  readonly contextRatio: number;
  /** Which model answers the flush turn; unset = the session's own model. */
  readonly hostedModel?: HostedModelRef;
};

export function readFlushConfig(options: unknown): FlushConfig {
  const root =
    typeof options === "object" && options !== null ? (options as Record<string, unknown>) : {};
  const nested =
    typeof root["flush"] === "object" && root["flush"] !== null
      ? (root["flush"] as Record<string, unknown>)
      : {};

  const ratio = nested["contextRatio"];
  const contextRatio =
    typeof ratio === "number" && Number.isFinite(ratio) && ratio > 0 && ratio < 1
      ? ratio
      : DEFAULT_CONTEXT_RATIO;

  return {
    enabled: nested["enabled"] !== false,
    contextRatio,
    ...readHostedModel(nested["model"]),
  };
}

function readHostedModel(value: unknown): { hostedModel?: HostedModelRef } {
  if (typeof value !== "string") return {};
  const trimmed = value.trim();
  // Split on the first slash only: model ids carry slashes themselves
  // (`openrouter/anthropic/claude-sonnet-4`).
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) return {};
  return { hostedModel: { providerID: trimmed.slice(0, slash), id: trimmed.slice(slash + 1) } };
}

/**
 * The window the current model advertises, or 0 when it is unknown.
 *
 * 0 is the honest "cannot compute a ratio" answer, and it makes the gate refuse
 * rather than guess: a session whose model reports no context window is not
 * flushed on occupancy, and the compaction event remains as the only trigger.
 */
export function resolveContextWindow(limit: unknown): number {
  if (typeof limit !== "object" || limit === null) return 0;
  const context = (limit as { context?: unknown }).context;
  return typeof context === "number" && Number.isFinite(context) && context > 0
    ? Math.floor(context)
    : 0;
}

/**
 * The gate, in openclaw's shape: occupancy at or above the ratio.
 *
 * `shouldRunPreflightCompaction` upstream compares projected tokens against
 * `window - reserve`; with the reserve expressed as a ratio, that comparison is
 * `occupancy >= 1 - reserveRatio`.
 */
export function shouldFlushForOccupancy(params: {
  readonly totalTokens: number;
  readonly contextWindowTokens: number;
  readonly contextRatio: number;
}): boolean {
  const used = params.totalTokens;
  const window = params.contextWindowTokens;
  if (!(used > 0) || !(window > 0)) return false;
  const ratio =
    params.contextRatio > 0 && params.contextRatio < 1
      ? params.contextRatio
      : DEFAULT_CONTEXT_RATIO;
  const threshold = Math.floor(window * ratio);
  return threshold > 0 && used >= threshold;
}

/**
 * openclaw's three hint clauses, verbatim from `flush-plan.ts`.
 *
 * They describe a store the model cannot reach: mem-plus's flush has no file
 * handle and no tools. They are kept anyway because they are the contract -- what
 * the durable store is, that only new content belongs in it, and that the curated
 * and bootstrap files are not part of this write -- and because the target path
 * they name is the same path `ensureFlushTargetFile` validates.
 */
const MEMORY_FLUSH_TARGET_HINT =
  "Store durable memories only in memory/YYYY-MM-DD.md (create memory/ if needed).";
const MEMORY_FLUSH_APPEND_ONLY_HINT =
  "If memory/YYYY-MM-DD.md already exists, APPEND new content only and do not overwrite existing entries.";
const MEMORY_FLUSH_READ_ONLY_HINT =
  "Treat workspace bootstrap/reference files such as MEMORY.md, DREAMS.md, SOUL.md, and AGENTS.md as read-only during this flush; never overwrite, replace, or edit them.";

/**
 * Upstream's user-prompt text, verbatim, with the date stamped in.
 *
 * It becomes the "## User Request" section of the extraction context: the request
 * the flush models. The `replaceAll` is upstream's too, and it rewrites the
 * example in the variant-file clause as well -- `2026-10-10-HHMM.md` is what
 * upstream tells the model not to create.
 */
export function buildFlushPrompt(dateStamp: string): string {
  return [
    "Pre-compaction memory flush.",
    MEMORY_FLUSH_TARGET_HINT,
    MEMORY_FLUSH_READ_ONLY_HINT,
    MEMORY_FLUSH_APPEND_ONLY_HINT,
    "Do NOT create timestamped variant files (e.g., YYYY-MM-DD-HHMM.md); always use the canonical YYYY-MM-DD.md filename.",
    `If nothing to store, reply with ${SILENT_REPLY_TOKEN}.`,
  ]
    .join(" ")
    .replaceAll("YYYY-MM-DD", dateStamp);
}

/** Upstream's system-prompt text, verbatim, with the date stamped in. */
function flushSystemPrompt(dateStamp: string): string {
  return [
    "Pre-compaction memory flush turn.",
    "The session is near auto-compaction; capture durable memories to disk.",
    MEMORY_FLUSH_TARGET_HINT,
    MEMORY_FLUSH_READ_ONLY_HINT,
    MEMORY_FLUSH_APPEND_ONLY_HINT,
    `You may reply, but usually ${SILENT_REPLY_TOKEN} is correct.`,
  ]
    .join(" ")
    .replaceAll("YYYY-MM-DD", dateStamp);
}

/**
 * The flush extraction's system prompt: the capture recorder framing in the
 * conversation's own language, upstream's flush prompt, and an explicit envelope
 * contract.
 *
 * THE ENVELOPE CLAUSE IS THE ONE DEVIATION, and it is forced by the host: the
 * flush runs through `ctx.generate.text`, which takes `{prompt, model}` and no
 * tools, so there is no tool call to parse and the JSON shape has to live in the
 * prompt. Telling the model to "store durable memories in memory/<day>.md" with
 * no way to act on it produces file content instead of the JSON the extractor
 * reads, which is why upstream's clauses are kept as the contract and the
 * envelope is appended rather than replacing them.
 *
 * `SILENT_REPLY_TOKEN` is therefore not the operative skip here: `"type": "skip"`
 * is. A model that obeys the clause literally answers `NO_REPLY`, that reply does
 * not parse as JSON, `extractCaptureSummary` returns null, and the flush reports
 * `skipped` -- the same outcome upstream gets from a silent reply, reached one
 * step later.
 */
export function buildFlushSystemPrompt(dateStamp: string, conversation: string): string {
  const languageName = getCaptureLanguageName(detectCaptureLanguage(conversation));
  return [
    buildCaptureSystemPrompt(languageName),
    flushSystemPrompt(dateStamp),
    'Reply with a single JSON object and nothing else -- no prose, no code fence: {"summary": "<the FORMAT body above>", "type": "one of feature, bug-fix, refactor, analysis, configuration, discussion, other, or skip", "tags": ["2 to 4 lowercase tags"]}. For a skip, summary is "" and tags is [].',
  ].join("\n");
}