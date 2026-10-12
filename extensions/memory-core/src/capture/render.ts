// Rendering of one extracted summary into a daily memory entry.
//
// opencode-mem stores each capture as a discrete `memories` row. openclaw's durable
// store is file-backed, so a capture becomes one self-contained block appended to
// `memory/YYYY-MM-DD.md` — a heading the daily ingestion parser recognises, the
// summary itself, the tag line, and an idempotency marker.
import { CAPTURE_ENTRY_MARKER_KIND } from "./constants.js";
import type { CapturePromptRecord, CaptureSummary } from "./types.js";

/** Stable per-prompt key; also the idempotency token written into the daily file. */
export function captureEntryKey(record: CapturePromptRecord): string {
  return record.id;
}

/**
 * The exact comment written after every capture. `appendCaptureEntry` tests for this
 * string to keep retries idempotent, so renderers must emit it byte for byte and keep
 * anything variable outside of it.
 */
export function captureEntryMarker(entryKey: string): string {
  return `<!-- ${CAPTURE_ENTRY_MARKER_KIND}:${entryKey} -->`;
}

export function renderCaptureEntry(params: {
  summary: CaptureSummary;
  entryKey: string;
  nowMs: number;
  /**
   * openclaw's project identity for the repository this work happened in, written
   * as `<!-- project: KEY -->` so the entry is scoped rather than global.
   *
   * Why it has to be written here and not at promotion time: openclaw's gate reads
   * the annotation off the *source* entry. `short-term-promotion.ts:209` copies
   * `entry.projectKey` onto the candidate and `buildPromotionRecallAnnotations`
   * re-emits it into `MEMORY.md`, so an unannotated daily entry produces an
   * unannotated curated entry, which `extractCuratedEntryRecallMetadata` reports as
   * `projectKey: null`, which `isPromotedTrustedMemoryEntry` treats as global. The
   * whole chain then injects into every session regardless of repository.
   *
   * Placement: its own line, immediately before the idempotency marker and outside
   * it. `captureEntryMarker` is compared byte for byte on every append, so anything
   * variable has to stay off that line; `extractProjectKeysFromCuratedEntry` scans
   * the entry's joined text, so its position inside the block does not matter.
   */
  projectKey?: string | null;
}): string {
  const { summary, entryKey, nowMs, projectKey } = params;
  const parts: string[] = [
    `## ${new Date(nowMs).toISOString()} · auto-capture · ${summary.type}`,
    "",
    summary.summary.trim(),
  ];
  if (summary.tags.length > 0) {
    parts.push("", `Tags: ${summary.tags.join(", ")}`);
  }
  // `normalizeProjectAnnotationKey` rejects anything with a line break or an angle
  // bracket, and `resolveProjectKey` escapes those away already; the check here is
  // the last place a malformed key could be written into the daily file.
  const scoped = projectKey && !/[\r\n<>]/u.test(projectKey) ? projectKey.trim() : "";
  if (scoped) parts.push("", `<!-- project: ${scoped} -->`);
  parts.push("", captureEntryMarker(entryKey), "");
  return `${parts.join("\n")}\n`;
}
