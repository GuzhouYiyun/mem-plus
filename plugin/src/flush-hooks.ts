// The pre-compaction flush: openclaw's fourth write path, ported from
// `extensions/memory-core/src/flush-plan.ts` and
// `src/auto-reply/reply/memory-flush.ts`. The gap it fills: mem-plus writes
// memory at *turn* boundaries (snapshot on settle, extraction in the sweep,
// dreaming once a day). A single long turn that compacts halfway through loses
// everything between its last settle and the compaction -- and the extractor
// cannot even recover it afterwards, because `ctx.session.context()` returns
// the post-compaction view and `loadAssistantTurn` then finds no reply to work
// from.
//
// Extracted from `index.ts` (structure pass, 2026-11-17); bodies and their doc
// comments moved verbatim. One forced rewrite: the setup-local `closed` flag
// arrives as the `isClosed()` getter. Also moved with it: the module-level
// `resolveFlushWindow` (only caller was `readOccupancy`).
//
// Why one file: two triggers (occupancy hook + compaction event), one
// single-flight gate and two session reads share `flushConfig`, `closed` and
// `maybeFlush`; splitting them would restate that state per piece.
//
// The `prompt` hook registration happens inside the factory; index.ts keeps
// only the compaction backstop's `maybeFlush` handle.

import {
  readFlushConfig,
  resolveContextWindow,
  shouldFlushForOccupancy,
} from "./flush-config.js";
import { runFlush, type FlushTrigger } from "./flush-run.js";
import { asSessionMessage, type PluginContext, type SessionMessageView } from "./opencode.js";
import type { createCaptureDependencies } from "./capture-deps.js";

/**
 * The context window of the model that produced a message, or 0 when unknown.
 *
 * `limit.context` is the same number the TUI's percentage is computed from, so the
 * occupancy the flush gates on is the occupancy the user is looking at. The model
 * catalog (`ctx.model.list`) is the source: the provider payload carries provider
 * settings only and has no model list, so a lookup through it always returns 0.
 */
async function resolveFlushWindow(
  ctx: PluginContext,
  model: { id?: string; providerID?: string } | undefined,
): Promise<number> {
  if (!model?.id || !model.providerID) return 0;
  const response = await ctx.model.list().catch(() => null);
  const models = response?.data;
  if (!Array.isArray(models)) return 0;
  for (const entry of models) {
    if (entry.providerID === model.providerID && entry.modelID === model.id) {
      return resolveContextWindow(entry.limit);
    }
  }
  return 0;
}

export type FlushHooksParams = {
  readonly ctx: PluginContext;
  readonly options: Record<string, unknown>;
  /** The setup-local `closed` flag, read at gate time (index.ts owns disposal). */
  readonly isClosed: () => boolean;
  readonly captureDeps: ReturnType<typeof createCaptureDependencies>;
  /** The setup-local `indexAppended` (daily-file tail path, index-writes.ts). */
  readonly indexAppended: (file: string) => Promise<void>;
  readonly log: (message: string, detail?: unknown) => void;
};

/**
 * Registers the occupancy `prompt` hook and returns `maybeFlush` for the
 * compaction backstop in index.ts's event handler.
 */
export async function createFlushHooks(params: FlushHooksParams): Promise<{
  maybeFlush: (
    sessionID: string,
    trigger: FlushTrigger,
    options?: { readonly compactionID?: string; readonly note?: string },
  ) => Promise<void>;
}> {
  const { ctx, options, isClosed, captureDeps, indexAppended, log } = params;
  // --- pre-compaction flush ------------------------------------------------
  //
  // openclaw's fourth write path, ported from `extensions/memory-core/src/
  // flush-plan.ts` and `src/auto-reply/reply/memory-flush.ts`. The gap it fills:
  // mem-plus writes memory at *turn* boundaries (snapshot on settle, extraction
  // in the sweep, dreaming once a day). A single long turn that compacts halfway
  // through loses everything between its last settle and the compaction -- and
  // the extractor cannot even recover it afterwards, because
  // `ctx.session.context()` returns the post-compaction view and
  // `loadAssistantTurn` then finds no reply to work from.
  //
  // Two triggers, because one is not enough:
  //   occupancy -- the prompt hook below, on the last observed token usage.
  //     This is the one that runs *before* the compaction, which is the whole
  //     point of the upstream mechanism. Once per inbound user prompt, matching
  //     upstream's per-turn gate in reply preparation.
  //   compaction -- `session.compaction.started`, as the backstop for a
  //     compaction the hook did not see coming (a manual `/compact`, or a turn
  //     that outgrew the window without ever returning to the hook).
  const flushConfig = readFlushConfig(options);

  /** Token usage of the newest assistant message, and that model's window. */
  const readOccupancy = async (
    sessionID: string,
  ): Promise<{ used: number; window: number } | null> => {
    const messages = await ctx.session
      .context({ sessionID } as Parameters<typeof ctx.session.context>[0])
      .catch(() => null);
    if (!messages) return null;
    let newest: {
      created: number;
      used: number;
      model?: { id?: string; providerID?: string };
    } | null = null;
    for (const raw of messages) {
      const message = asSessionMessage(raw) as SessionMessageView & {
        readonly tokens?: {
          readonly input?: number;
          readonly output?: number;
          readonly reasoning?: number;
          readonly cache?: { readonly read?: number; readonly write?: number };
        };
      };
      if (message.type !== "assistant" || !message.tokens) continue;
      const usage = message.tokens;
      const used =
        (usage.input ?? 0) +
        (usage.output ?? 0) +
        (usage.reasoning ?? 0) +
        (usage.cache?.read ?? 0) +
        (usage.cache?.write ?? 0);
      const created = message.time?.created ?? 0;
      if (!newest || created > newest.created) {
        newest = { created, used, model: message.model };
      }
    }
    if (!newest) return null;
    const window = await resolveFlushWindow(ctx, newest.model);
    return { used: newest.used, window };
  };

  /**
   * The conversation a flush distils: the most recent assistant text, newest
   * last. A compaction discards the tail, and the tail is what an earlier
   * capture has not already extracted, so the budget is spent on the newest
   * exchanges and `buildCaptureMarkdownContext` does the bounding.
   */
  const loadRecentTurn = async (
    sessionID: string,
  ): Promise<{ textResponses: string[]; toolCalls: never[] } | null> => {
    const messages = await ctx.session
      .context({ sessionID } as Parameters<typeof ctx.session.context>[0])
      .catch(() => null);
    if (!messages) return null;
    const textResponses: string[] = [];
    for (const raw of messages) {
      const message = asSessionMessage(raw);
      if (message.type !== "assistant") continue;
      for (const part of message.content ?? []) {
        if (
          part?.type === "text" &&
          typeof part.text === "string" &&
          part.text.trim().length > 0
        ) {
          textResponses.push(part.text);
        }
      }
    }
    if (textResponses.length === 0) return null;
    return { textResponses, toolCalls: [] };
  };

  /**
   * One flush at a time. The gate can fire from two places within milliseconds of
   * each other (the hook and a compaction), and two concurrent flushes would run
   * the same extraction twice and race on the same daily file -- the marker makes
   * the second append a no-op, but only after both models have answered.
   */
  let flushInFlight = false;
  const maybeFlush = async (
    sessionID: string,
    trigger: FlushTrigger,
    options?: { readonly compactionID?: string; readonly note?: string },
  ): Promise<void> => {
    if (isClosed() || flushInFlight) return;
    flushInFlight = true;
    const note = options?.note ? ` (${options.note})` : "";
    try {
      const result = await runFlush({
        deps: captureDeps,
        trigger,
        compactionID: options?.compactionID,
        loadRecentTurn: () => loadRecentTurn(sessionID),
        log,
      });
      if (result.kind === "captured" && result.path) {
        log(`flush ${trigger}: appended -> ${result.path}${note}`);
        // The daily file only grows, so only its new block needs indexing -- the
        // same tail path the ordinary capture uses.
        await indexAppended(result.path);
      } else if (result.kind === "failed") {
        log(`flush ${trigger}: failed -- ${result.detail ?? "?"}${note}`);
      } else if (result.kind !== "already") {
        log(`flush ${trigger}: skipped (${result.detail ?? "?"})`);
      }
      // `already` stays silent on purpose: the occupancy gate is re-evaluated on
      // every turn for as long as the session runs above the threshold, and a
      // marker hit is the expected answer to all but the first of them.
    } catch (error) {
      log(`flush ${trigger}: threw`, error);
    } finally {
      flushInFlight = false;
    }
  };
  // The flush occupancy gate runs once per inbound user prompt. Upstream runs it once
  // per user turn, in reply preparation (`reply-agent-turn-preparation.ts:568`,
  // openclaw main f38495f7d) -- never on every model request. It used to live in the
  // `context` hook below, which fires once per agent-loop model call, so a long
  // session paid a full `ctx.session.context()` read (the whole message list) on
  // every model request instead of once per turn.
  //
  // Off the critical path, the same rule as `scheduleSettle`: a flush costs a model
  // request, so it is started and not awaited -- the turn that noticed the threshold
  // must not wait for it.
  await ctx.session.hook("prompt", async (event) => {
    const sessionID = event.sessionID;
    if (typeof sessionID !== "string" || sessionID.length === 0) return;
    void (async () => {
      const occupancy = await readOccupancy(sessionID);
      if (!occupancy || occupancy.window <= 0) return;
      if (
        shouldFlushForOccupancy({
          totalTokens: occupancy.used,
          contextWindowTokens: occupancy.window,
          contextRatio: flushConfig.contextRatio,
        })
      ) {
        await maybeFlush(sessionID, "occupancy", {
          note:
            `context ${Math.round((occupancy.used / occupancy.window) * 100)}% of ` +
            `${occupancy.window} tokens`,
        });
      }
    })();
  });
  return { maybeFlush };
}
