// The auto-capture ingestion pipeline, ported from opencode-mem's
// `performAutoCapture` / `capturePrompt` (opencode-mem/src/services/auto-capture.ts).
//
//   landing → claim → slice turn → bounded markdown context → LLM structured
//   extraction → filter type="skip" → render → append memory/YYYY-MM-DD.md
//
// Storage stays openclaw's: the appended file is chunked, embedded, FTS-indexed and
// provenance-tagged by the memory indexer. Only *how text enters* the system changed.
import {
  CAPTURE_CLAIM_TTL_MS,
  CAPTURE_DEFAULT_MAX_CONTEXT_BYTES,
  CAPTURE_DEFAULT_MAX_RETRIES,
  CAPTURE_LATEST_MEMORY_CHARS,
  CAPTURE_RETRY_BASE_DELAY_MS,
} from "./constants.js";
import { getCaptureMarkdownBudget, buildCaptureMarkdownContext } from "./context.js";
import { extractCaptureSummary, resolveCaptureSystemPrompt } from "./extract.js";
import {
  claimCapturePrompt,
  listPendingCapturePrompts,
  markCapturePromptCaptured,
  linkCapturePromptMemory,
  recordCaptureAttempt,
  reclaimOrphanedCapturePrompts,
  releaseCaptureClaim,
  deleteCapturePrompt,
} from "./landing.js";
import { captureEntryKey, renderCaptureEntry } from "./render.js";
import type {
  CaptureDependencies,
  CaptureOutcome,
  CapturePromptRecord,
} from "./types.js";
import { appendCaptureEntry, resolveCaptureWriteTarget } from "./write.js";

/** Guards against overlapping sweeps, exactly as opencode-mem's module flag does. */
let isCaptureRunning = false;

const defaultDelay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function writeDefaultEntry(params: {
  deps: CaptureDependencies;
  record: CapturePromptRecord;
  rendered: string;
  entryKey: string;
  nowMs: number;
}): Promise<{ relativePath: string }> {
  const target = resolveCaptureWriteTarget({
    workspaceDir: params.deps.workspaceDir,
    nowMs: params.nowMs,
    timezone: params.deps.timezone,
  });
  if (params.deps.writeEntry) {
    await params.deps.writeEntry({
      record: params.record,
      day: target.day,
      relativePath: target.relativePath,
      rendered: params.rendered,
      entryKey: params.entryKey,
    });
  } else {
    await appendCaptureEntry({
      absolutePath: target.absolutePath,
      rendered: params.rendered,
      entryKey: params.entryKey,
    });
  }
  return { relativePath: target.relativePath };
}

async function capturePrompt(params: {
  deps: CaptureDependencies;
  record: CapturePromptRecord;
  maxRetries: number;
  nowMs: number;
}): Promise<CaptureOutcome> {
  const { deps, record } = params;
  const promptId = record.id;
  // Tracks the record whose claim must be released when this function unwinds, so a
  // throw between "claimed" and "captured" cannot strand the prompt at state 2.
  const claim: { current: CapturePromptRecord | null } = { current: null };
  let attempt = record.captureAttempts || 0;
  let outcome: CaptureOutcome = { kind: "pending", promptId };

  try {
    const first = await claimCapturePrompt(record, params.nowMs);
    if (!first) {
      return { kind: "claimed", promptId };
    }
    claim.current = first;
    let active = first;

    while (attempt < params.maxRetries) {
      attempt += 1;
      try {
        const turn = await deps.loadTurn(active);
        if (!turn || (turn.textResponses.length === 0 && turn.toolCalls.length === 0)) {
          // Nothing to summarise yet: leave the prompt pending for the next sweep.
          return { kind: "pending", promptId };
        }

        const latestMemory = deps.loadLatestMemory
          ? ((await deps.loadLatestMemory(active).catch(() => null)) ?? null).slice(
              0,
              CAPTURE_LATEST_MEMORY_CHARS,
            )
          : null;

        const context = buildCaptureMarkdownContext({
          userPrompt: active.content,
          textResponses: turn.textResponses,
          toolCalls: turn.toolCalls,
          latestMemory,
          maxContextBytes: getCaptureMarkdownBudget(CAPTURE_DEFAULT_MAX_CONTEXT_BYTES),
        });

        const systemPrompt = resolveCaptureSystemPrompt(active);
        const summary = await extractCaptureSummary({
          context,
          record: active,
          systemPrompt,
          completeStructured: deps.completeStructured,
          complete: deps.complete,
        });

        if (!summary || summary.type === "skip") {
          await deleteCapturePrompt(active);
          claim.current = null;
          return { kind: "skipped", promptId };
        }

        const entryKey = captureEntryKey(record);
        const rendered = renderCaptureEntry({
          summary,
          entryKey,
          nowMs: params.nowMs,
        });
        const written = await writeDefaultEntry({
          deps,
          record: active,
          rendered,
          entryKey,
          nowMs: params.nowMs,
        });

        await linkCapturePromptMemory(active, entryKey);
        await markCapturePromptCaptured(active);
        claim.current = null;
        return { kind: "captured", promptId, relativePath: written.relativePath };
      } catch (error) {
        const message = describeError(error);
        active = await recordCaptureAttempt(active);
        claim.current = active;

        if (attempt < params.maxRetries) {
          await (deps.delay ?? defaultDelay)(
            CAPTURE_RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1),
          );
        } else {
          outcome = { kind: "exhausted", promptId, error: message };
          break;
        }
      }
    }
  } catch (error) {
    outcome = { kind: "failed", promptId, error: describeError(error) };
  } finally {
    const held = claim.current;
    if (held && held.captured === 2) {
      try {
        await releaseCaptureClaim(held);
      } catch {
        // A stuck claim is recovered by `reclaimOrphanedCapturePrompts` after the TTL.
      }
    }
  }
  return outcome;
}

/**
 * Run one capture sweep: reclaim orphaned claims, then drain pending prompts for
 * `sessionId` (or every session when omitted).
 */
export async function performCapture(params: {
  deps: CaptureDependencies;
  sessionId?: string;
  maxRetries?: number;
  nowMs?: number;
}): Promise<CaptureOutcome[]> {
  if (isCaptureRunning) {
    return [];
  }
  isCaptureRunning = true;
  try {
    const nowMs = params.nowMs ?? Date.now();
    const maxRetries = params.maxRetries ?? CAPTURE_DEFAULT_MAX_RETRIES;
    await reclaimOrphanedCapturePrompts({
      workspaceDir: params.deps.workspaceDir,
      nowMs,
      ttlMs: CAPTURE_CLAIM_TTL_MS,
    });

    const prompts = await listPendingCapturePrompts({
      workspaceDir: params.deps.workspaceDir,
      sessionId: params.sessionId,
      maxRetries,
    });
    if (prompts.length === 0) {
      return [];
    }

    const outcomes: CaptureOutcome[] = [];
    for (const prompt of prompts) {
      outcomes.push(await capturePrompt({ deps: params.deps, record: prompt, maxRetries, nowMs }));
    }
    return outcomes;
  } finally {
    isCaptureRunning = false;
  }
}
