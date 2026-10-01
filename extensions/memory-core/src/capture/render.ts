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
}): string {
  const { summary, entryKey, nowMs } = params;
  const parts: string[] = [
    `## ${new Date(nowMs).toISOString()} · auto-capture · ${summary.type}`,
    "",
    summary.summary.trim(),
  ];
  if (summary.tags.length > 0) {
    parts.push("", `Tags: ${summary.tags.join(", ")}`);
  }
  parts.push("", captureEntryMarker(entryKey), "");
  return `${parts.join("\n")}\n`;
}
