// The flush turn: what runs when the gate opens.
//
// WHY THIS EXISTS SEPARATELY FROM flush-config.ts
//   The policy file answers "should we flush". This one answers "flush what, and
//   where does it land". The split mirrors openclaw's own
//   `memory-flush-prepare.ts` (session/prompt) and `memory-flush-session.ts`
//   (idempotency + target file).
//
// THE IDEMPOTENCY KEY IS THE SAME ONE CAPTURE USES
//   Upstream gates on `memoryFlush.compactionCount === compactionCount`: one flush
//   per compaction cycle, tracked in the session entry. OpenCode keeps no
//   compaction counter -- the compaction event carries `inputID` but no count -- so
//   the key is derived from the trigger, the day, and (for a compaction) the event
//   id. `appendCaptureEntry` short-circuits on a marker already in the file
//   (`<!-- openclaw-capture:<key> -->`), and `deps.hasEntry` asks the same question
//   *before* the extraction: the context hook fires on every turn, so a session
//   that stays above the occupancy threshold would otherwise pay for a full
//   extraction per turn and throw all but the first away.
//
// NO LANDING RECORD, NO SWEEP
//   The capture pipeline drains *pending landing records*, and a flush has none --
//   there is no user prompt to land. So the flush does not call `performCapture`:
//   it calls the same extraction and the same writer directly, which is also what
//   keeps a flush from being swept twice by the turn-end sweep.
//
// THE TARGET FILE IS PREPARED BEFORE THE MODEL RUNS
//   Upstream's `prepareMemoryFlushSession` opens the bounded conversation view
//   and then calls `ensureMemoryFlushTargetFile`, so by the time the flush turn
//   can decide there is nothing to write, `memory/<day>.md` already exists. Same
//   order here: the flush turn is the expensive, irreversible part, and a target
//   that cannot be prepared should cost nothing.
//
// A BOUNDED VIEW THAT DOES NOT FIT IS TRUNCATED, NOT REFUSED
//   This used to refuse, and it made the flush dead: `buildCaptureMarkdownContext`
//   truncates whenever the conversation outgrows the capture budget, and a flush
//   fires at 75% of the window, so on this machine it triggered twice and failed
//   twice (2026-10-11, 09:24 and 16:05) with "flush exceeds the bounded conversation
//   view". A safety net that only works in short conversations is not a safety net.
//
//   The refusal rested on a claim about upstream that is not true. It said upstream
//   throws `Memory flush exceeds the bounded conversation view.` Read on 2026-10-12,
//   upstream's flush is an agentic turn in a DETACHED session
//   (`src/auto-reply/reply/memory-flush-prepare.ts`: "The detached transcript keeps
//   maintenance messages out of the source session"), so it never assembles the
//   transcript into one prompt and never checks whether it fit. There is no such
//   error string in upstream's flush sources; `src/auto-reply/reply/` is not vendored
//   here, which is why the claim survived unexamined.
//
//   Truncating is also the smaller loss. `fitTextResponses` keeps the newest turns,
//   and the oldest ones this drops are exactly what per-turn capture already wrote to
//   the day file after each turn -- the flush is the second line of defence, not the
//   only one. Refusing saved nothing and cost everything.
import {
  buildCaptureMarkdownContext,
  getCaptureMarkdownBudget,
} from "../../extensions/memory-core/src/capture/context.js";
import { CAPTURE_DEFAULT_MAX_CONTEXT_BYTES } from "../../extensions/memory-core/src/capture/constants.js";
import { extractCaptureSummary } from "../../extensions/memory-core/src/capture/extract.js";
import { captureEntryMarker, renderCaptureEntry } from "../../extensions/memory-core/src/capture/render.js";
import { appendCaptureEntry, resolveCaptureWriteTarget } from "../../extensions/memory-core/src/capture/write.js";
import { formatMemoryDreamingDay } from "../../extensions/memory-core/src/capture/day.js";
import type {
  CaptureDependencies,
  CapturePromptRecord,
  CaptureTurn,
} from "../../extensions/memory-core/src/capture/types.js";
import { buildFlushPrompt, buildFlushSystemPrompt } from "./flush-config.js";
import { ensureFlushTargetFile } from "./flush-target.js";
import { withWriteProvenance } from "./write-provenance.js";

/** Which layer opened the gate. Both share one idempotency key per day. */
export type FlushTrigger = "occupancy" | "compaction";

export type FlushResult = {
  readonly trigger: FlushTrigger;
  /** `already` is the marker hit: this exact flush is on disk, nothing was spent. */
  readonly kind: "captured" | "skipped" | "already" | "failed";
  readonly path?: string;
  readonly detail?: string;
};

/**
 * A flush key that is stable across runs and unique per trigger+day.
 *
 * `sessionID` is deliberately absent: the daily file is per project, and one
 * project's flush must not be suppressed by another project's session. Trigger and
 * day make a genuine repeat look like a repeat.
 */
export function flushEntryKey(params: {
  trigger: FlushTrigger;
  nowMs: number;
  /**
   * Identity of the compaction that opened the gate. Upstream flushes once per
   * compaction because its key carries the compaction count; without a per-event
   * component, the second compaction of a day would find the first one's marker
   * and drop everything said since.
   */
  compactionID?: string;
}): string {
  const day = formatMemoryDreamingDay(params.nowMs);
  const base = `flush:${params.trigger}:${day}`;
  return params.compactionID ? `${base}:${params.compactionID}` : base;
}

/**
 * Run one flush: extract from the recent conversation, append to the daily file.
 *
 * Never throws. The gate is advisory, and a flush that fails must not take the
 * turn that opened it down with it -- the snapshot and the ordinary sweep are
 * still worth running.
 */
export async function runFlush(params: {
  deps: CaptureDependencies;
  trigger: FlushTrigger;
  /** The conversation to distil. `null` when nothing is worth reading. */
  loadRecentTurn: () => Promise<CaptureTurn | null>;
  /** Compaction identity, when the gate was opened by a compaction event. */
  compactionID?: string;
  nowMs?: number;
  log: (message: string) => void;
}): Promise<FlushResult> {
  const nowMs = params.nowMs ?? Date.now();
  const day = formatMemoryDreamingDay(nowMs);
  const entryKey = flushEntryKey({
    trigger: params.trigger,
    nowMs,
    compactionID: params.compactionID,
  });

  // The record is the pipeline's own currency: `writeEntry`, `hasEntry` and
  // `extractCaptureSummary` read `record.workspaceDir` and `record.id`, and there
  // is no landed prompt to supply one. A synthetic record keeps that contract
  // intact without landing anything -- a flush writes nothing to the plugin-state
  // namespace, so there is no state to clean up if it never completes.
  const record: CapturePromptRecord = {
    version: 1,
    id: entryKey,
    sessionId: "",
    messageId: "",
    workspaceDir: params.deps.workspaceDir,
    content: buildFlushPrompt(day),
    createdAt: nowMs,
    captured: 0,
    captureAttempts: 0,
    claimedAt: null,
    linkedMemoryId: null,
    providerId: null,
    modelId: null,
  };

  // Idempotency is settled here, before anything is spent. `appendCaptureEntry`
  // would make the write itself a no-op, but by then the turn has been read and the
  // model has answered -- and the occupancy gate is re-evaluated on every turn for
  // as long as the session stays above the threshold.
  if (params.deps.hasEntry) {
    try {
      if (await params.deps.hasEntry({ record, day, entryKey })) {
        return { trigger: params.trigger, kind: "already", detail: entryKey };
      }
    } catch (error) {
      // A failed read is not a failed flush: the writer's marker check still holds,
      // so the flush proceeds and simply costs one extraction it may not need.
      const detail = error instanceof Error ? error.message : String(error);
      params.log(`flush ${params.trigger}: marker check failed -- ${detail}`);
    }
  }

  let turn: CaptureTurn | null = null;
  try {
    turn = await params.loadRecentTurn();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    params.log(`flush ${params.trigger}: cannot read the recent turn -- ${detail}`);
    return { trigger: params.trigger, kind: "failed", detail };
  }
  if (!turn || (turn.textResponses.length === 0 && turn.toolCalls.length === 0)) {
    return { trigger: params.trigger, kind: "skipped", detail: "no recent turn" };
  }

  // Upstream prepares the target before the turn runs (see the header note). The
  // returned path is the same one `resolveCaptureWriteTarget` names; asking the
  // guard for it is what proves the two agree.
  const target = resolveCaptureWriteTarget({
    workspaceDir: params.deps.workspaceDir,
    nowMs,
    timezone: params.deps.timezone,
  });
  try {
    await ensureFlushTargetFile({
      workspaceDir: params.deps.workspaceDir,
      relativePath: target.relativePath,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    params.log(`flush ${params.trigger}: target file unavailable -- ${detail}`);
    return { trigger: params.trigger, kind: "failed", detail };
  }

  const latestMemory = params.deps.loadLatestMemory
    ? await params.deps.loadLatestMemory(record).catch(() => null)
    : null;

  const context = buildCaptureMarkdownContext({
    userPrompt: record.content,
    textResponses: turn.textResponses,
    toolCalls: turn.toolCalls,
    latestMemory,
    maxContextBytes: getCaptureMarkdownBudget(CAPTURE_DEFAULT_MAX_CONTEXT_BYTES),
  });

  let summary: Awaited<ReturnType<typeof extractCaptureSummary>> | null = null;
  try {
    summary = await extractCaptureSummary({
      context,
      record,
      // The flush contract replaces the ordinary capture framing: this extraction
      // runs because the context is about to be compacted, not because a prompt
      // was answered. Language is detected from the conversation, not the flush
      // instruction (which is English boilerplate).
      systemPrompt: buildFlushSystemPrompt(day, turn.textResponses.join("\n")),
      completeStructured: params.deps.completeStructured,
      complete: params.deps.complete,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    params.log(`flush ${params.trigger}: extraction failed -- ${detail}`);
    return { trigger: params.trigger, kind: "failed", detail };
  }

  if (!summary || summary.type === "skip") {
    return { trigger: params.trigger, kind: "skipped", detail: "nothing durable" };
  }

  // Upstream renders the entry itself. mem-plus reuses `renderCaptureEntry` so a
  // flush and an ordinary capture produce the same shape in the same file, carry
  // the same marker, and one reader handles both. The target was resolved and
  // prepared before the extraction ran.
  const rendered = renderCaptureEntry({ summary, entryKey, nowMs });

  let writtenPath: string;
  try {
    if (params.deps.writeEntry) {
      writtenPath = await params.deps.writeEntry({
        record,
        day: target.day,
        relativePath: target.relativePath,
        rendered,
        entryKey,
      });
    } else {
      // Same provenance the capture path records: the flush is another agent
      // append to the same file, and a human edit in between must downgrade it
      // exactly as it would downgrade a capture.
      await withWriteProvenance({
        memoryHome: params.deps.workspaceDir,
        absolutePath: target.absolutePath,
        append: async () => {
          await appendCaptureEntry({ absolutePath: target.absolutePath, rendered, entryKey });
        },
      });
      writtenPath = target.absolutePath;
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    params.log(`flush ${params.trigger}: append failed -- ${detail}`);
    return { trigger: params.trigger, kind: "failed", detail };
  }

  return { trigger: params.trigger, kind: "captured", path: writtenPath };
}

export { captureEntryMarker };