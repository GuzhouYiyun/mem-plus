// mem-plus: an OpenCode memory plugin built from openclaw's memory subsystem.
//
// WHAT IT DOES
//   1. Lands every admitted user prompt in a landing zone (OpenCode has no
//      `chat.message` hook in V2, so the durable `session.inbox.enqueued` event is
//      the admission boundary: it carries the canonical persisted text and a stable
//      `inboxID` that makes re-delivery idempotent).
//   2. After each turn (`session.execution.succeeded`) runs the ported capture
//      pipeline: claim -> slice the assistant turn -> bounded markdown context ->
//      LLM structured extraction -> filter `type="skip"` -> append
//      `memory/YYYY-MM-DD.md`.
//   3. Re-renders the whole session as `memory/<YYYY-MM-DD>-<slug>.md` and mirrors
//      it into `~/.config/opencode/mem-plus/archive/<project>/`, which is the
//      cross-project copy of every session.
//
// WHAT IT DELIBERATELY DOES NOT DO YET
//   No `memory_search` / `memory_get` tools and no SQLite/FTS5 index: writes land as
//   plain markdown first, and the index is a rebuildable projection of those files,
//   exactly as it is in openclaw (where the file watcher owns it).
import { Plugin } from "@opencode/plugin";
import {
  createMemoryCapture,
  deleteCapturePrompt,
  listPendingCapturePrompts,
} from "../../extensions/memory-core/src/capture/index.js";
import { configureMemoryCoreDreamingState } from "../../extensions/memory-core/src/dreaming-state.js";
import { createCaptureDependencies } from "./capture-deps.js";
import { createStorageOpenKeyedStore } from "./kv.js";
import type { EventView, PluginContext } from "./opencode.js";
import { writeSessionSnapshot } from "./snapshot.js";

/** Settle time after a turn completes before snapshot + sweep run. */
const TURN_SETTLE_MS = 2_000;

/** Pending prompts older than this are stale (session deleted or never answered). */
const PROMPT_MAX_AGE_MS = 7 * 24 * 60 * 60_000;

/** `listPendingCapturePrompts` filters by attempts; pass a huge ceiling to see them all. */
const NO_RETRY_LIMIT = Number.MAX_SAFE_INTEGER;

type Logger = (message: string, detail?: unknown) => void;

function createLogger(prefix: string): Logger {
  return (message: string, detail?: unknown) => {
    if (detail === undefined) {
      console.log(prefix + " " + message);
      return;
    }
    const text = detail instanceof Error ? detail.message : String(detail);
    console.log(prefix + " " + message + " :: " + text);
  };
}

/**
 * Drop landing records nobody will ever complete. Without this the namespace grows
 * forever: a prompt whose session was deleted, or whose assistant reply never
 * arrived, stays `captured = 0` indefinitely and is invisible to the age-blind
 * pending query.
 */
async function pruneStalePrompts(ctx: PluginContext): Promise<number> {
  const cutoff = Date.now() - PROMPT_MAX_AGE_MS;
  const all = await listPendingCapturePrompts({
    workspaceDir: ctx.location.directory,
    maxRetries: NO_RETRY_LIMIT,
  });
  let pruned = 0;
  for (const record of all) {
    if (record.createdAt >= cutoff) continue;
    await deleteCapturePrompt(record);
    pruned += 1;
  }
  return pruned;
}

export default Plugin.define({
  id: "mem-plus",
  async setup(ctx) {
    const log = createLogger("[mem-plus]");
    const workspaceDir = ctx.location.directory;

    // Landing zone storage: the pipeline's only remaining host dependency.
    configureMemoryCoreDreamingState(createStorageOpenKeyedStore(ctx));
    const capture = createMemoryCapture(createCaptureDependencies(ctx));

    const controller = new AbortController();
    const settleTimers = new Map<string, ReturnType<typeof setTimeout>>();
    let closed = false;

    /** Snapshot, then sweep, for one session. Kept sequential so a slow LLM call
     *  cannot outlive the next turn's snapshot of the same session. */
    const settle = async (sessionID: string): Promise<void> => {
      if (closed) return;
      try {
        const snapshot = await writeSessionSnapshot(ctx, sessionID);
        if (snapshot) {
          log(`snapshot ${snapshot.bytes} B -> ${snapshot.projectPath}`);
        }
      } catch (error) {
        log("snapshot failed", error);
      }
      if (closed) return;
      try {
        const outcomes = await capture.runSweep({ sessionId: sessionID });
        for (const outcome of outcomes) {
          if (outcome.kind === "captured") {
            log(`captured ${outcome.promptId} -> ${outcome.relativePath ?? "?"}`);
          } else if (outcome.kind === "failed" || outcome.kind === "exhausted") {
            log(`${outcome.kind} ${outcome.promptId}`, outcome.error);
          }
        }
      } catch (error) {
        log("sweep failed", error);
      }
    };

    const scheduleSettle = (sessionID: string): void => {
      const pending = settleTimers.get(sessionID);
      if (pending !== undefined) clearTimeout(pending);
      settleTimers.set(
        sessionID,
        setTimeout(() => {
          settleTimers.delete(sessionID);
          void settle(sessionID);
        }, TURN_SETTLE_MS),
      );
    };

    const onEvent = (event: EventView): void => {
      const sessionID = event.data?.sessionID;
      if (typeof sessionID !== "string" || sessionID.length === 0) return;

      if (event.type === "session.inbox.enqueued") {
        const inboxID = event.data?.inboxID;
        const text = event.data?.item?.payload?.text;
        if (typeof inboxID !== "string" || typeof text !== "string" || text.length === 0) return;
        // `inboxID` is the durable message id, so a redelivered event is a no-op:
        // `recordCapturePrompt` returns the existing record unchanged.
        void capture
          .onUserPrompt({ sessionId: sessionID, messageId: inboxID, content: text })
          .catch((error: unknown) => log("landing failed", error));
        return;
      }

      if (
        event.type === "session.execution.succeeded" ||
        event.type === "session.execution.failed" ||
        event.type === "session.execution.interrupted"
      ) {
        scheduleSettle(sessionID);
      }
    };

    void (async () => {
      try {
        for await (const raw of ctx.event.subscribe({ signal: controller.signal })) {
          onEvent(raw as EventView);
        }
      } catch (error) {
        if (!closed) log("event stream ended", error);
      }
    })();

    // Drain anything a previous process left behind before its settle timer fired.
    void (async () => {
      try {
        const pruned = await pruneStalePrompts(ctx);
        if (pruned > 0) log(`pruned ${pruned} stale prompt(s)`);
        const outcomes = await capture.runSweep();
        if (outcomes.length > 0) log(`startup sweep processed ${outcomes.length} prompt(s)`);
      } catch (error) {
        log("startup sweep failed", error);
      }
    })();

    log(`ready in ${workspaceDir}`);

    return () => {
      closed = true;
      controller.abort();
      for (const timer of settleTimers.values()) clearTimeout(timer);
      settleTimers.clear();
    };
  },
});
