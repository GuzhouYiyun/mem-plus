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
//   4. Indexes both trees into SQLite + FTS5 and exposes `memory_search`,
//      `memory_get` and `memory_reindex`, so what was written can be found again.
//
// WHY THE INDEX IS SEPARATE FROM THE WRITE PATH
//   Writes land as plain markdown first and the index is a projection of those
//   files, exactly as in openclaw where a file watcher owns it. Nothing about
//   capture depends on the index existing: if `node:sqlite` is missing the
//   plugin still records everything, it just cannot search it. The other
//   direction also holds -- a broken or deleted index is repaired by
//   `memory_reindex`, and no memory is ever lost with it.
import path from "node:path";
import { Plugin } from "@opencode/plugin";
import {
  createMemoryCapture,
  deleteCapturePrompt,
  listPendingCapturePrompts,
} from "../../extensions/memory-core/src/capture/index.js";
import { configureMemoryCoreDreamingState } from "../../extensions/memory-core/src/dreaming-state.js";
import {
  createCaptureDependencies,
  disabledComplete,
  hostedComplete,
} from "./capture-deps.js";
import { createStorageOpenKeyedStore } from "./kv.js";
import { missingModelPaths, readModelConfig, readServiceConfig } from "./model/config.js";
import { createServiceClient, type MemPlusService } from "./model/client.js";
import { createLogger } from "./log.js";
import { indexPath, openIndex } from "./memory-index.js";
import { indexWrittenFile, indexTail } from "./memory-scan.js";
import { buildMemoryTools } from "./memory-tools.js";
import { logFile, projectSlug } from "./paths.js";
import type { EventView, PluginContext } from "./opencode.js";
import { writeSessionSnapshot } from "./snapshot.js";

/** Settle time after a turn completes before snapshot + sweep run. */
const TURN_SETTLE_MS = 2_000;

/** Pending prompts older than this are stale (session deleted or never answered). */
const PROMPT_MAX_AGE_MS = 7 * 24 * 60 * 60_000;

/** `listPendingCapturePrompts` filters by attempts; pass a huge ceiling to see them all. */
const NO_RETRY_LIMIT = Number.MAX_SAFE_INTEGER;

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
    // First line in the log file, so an empty or stale log is unambiguous.
    log(`plugin loaded, workspace ${workspaceDir}`);
    log(`log file ${logFile()}`);

    // Landing zone storage: the pipeline's only remaining host dependency.
    configureMemoryCoreDreamingState(createStorageOpenKeyedStore(ctx));

    // Extraction goes through the local inference service (see serve/server.mjs
    // for why it cannot run inside OpenCode's own process). The service is
    // contacted lazily: probing it during setup would stall plugin loading behind
    // a ~3 s model load in every window, whether or not anything needs extracting.
    //
    // If local inference is unusable, extraction is skipped rather than rerouted
    // to the user's paid model -- see `allowHostedFallback` in model/config.ts.
    // Snapshots keep working either way, and openclaw's landing zone leaves the
    // record pending so it is retried once the service is back.
    const modelConfig = readModelConfig(ctx.options);
    const serviceConfig = readServiceConfig(ctx.options);
    const missing = missingModelPaths(modelConfig);
    const allowHosted = modelConfig.allowHostedFallback;
    let service: MemPlusService | null = null;
    if (modelConfig.contentBackend === "opencode") {
      // Explicit configuration, not a failure mode.
      log('extraction model = opencode (options.model.content = "opencode") -- metered, by request');
    } else if (missing.length > 0) {
      for (const file of missing) log(`  missing ${file} -- see README "本地模型"`);
      if (allowHosted) {
        log("extraction model = opencode (fallback: GGUF not found, model.allowHostedFallback = true)");
      } else {
        log(
          "extraction DISABLED (GGUF not found; snapshots still written). " +
            'Fix the paths, or set options.model.allowHostedFallback = true to ' +
            "accept metered extraction via the OpenCode model.",
        );
      }
    } else {
      service = createServiceClient(serviceConfig, modelConfig, log);
      log(
        `extraction model = local gguf via ${serviceConfig.host}:${serviceConfig.port} ` +
          `(gpu priority ${modelConfig.gpu}, idle ${serviceConfig.idleMinutes} min)`,
      );
    }

    const localService = service;
    const capture = createMemoryCapture(
      createCaptureDependencies(
        ctx,
        localService
          ? async ({ systemPrompt, prompt }) => {
              try {
                return await localService.extract({ systemPrompt, prompt });
              } catch (error) {
                if (!allowHosted) {
                  // Throw rather than degrade. The sweep records the failure and
                  // the record stays pending, so the memory is written later for
                  // free instead of now at the user's expense.
                  log(
                    "local service unavailable; skipping extraction and leaving the " +
                      "record pending (no metered fallback -- " +
                      'set options.model.allowHostedFallback = true to change this)',
                    error,
                  );
                  throw error;
                }
                log(
                  "local service unavailable, using the OpenCode model for this turn " +
                    "(model.allowHostedFallback = true -- metered)",
                  error,
                );
                return await hostedComplete(ctx)({ systemPrompt, prompt });
              }
            }
          : modelConfig.contentBackend === "opencode"
            // Explicit opt-in, so this one is not a fallback.
            ? hostedComplete(ctx)
            : disabledComplete(
                missing.length > 0
                  ? `GGUF not found: ${missing.join(", ")}`
                  : "no local service and no hosted opt-in",
              ),
      ),
    );

    // --- retrieval -----------------------------------------------------------
    //
    // The index opens once and is shared by every turn and every project window:
    // it lives in the config directory, and SQLite handles the concurrency. When
    // it cannot be opened the tools are simply not registered, because a tool
    // that always answers "unavailable" is worse than no tool -- the model would
    // keep calling it.
    //
    // Nothing here loads a model. Vector search fills in lazily, on the first
    // reindex that asks for it, so opening a project does not pay for bge-m3.
    const index = openIndex();
    if (index) {
      log(`index ${indexPath()}`);
      const retrieval = buildMemoryTools({
        db: index,
        workspaceDir,
        service: localService,
        log,
      });
      if (retrieval.available) {
        await ctx.tool.transform((editor) => {
          for (const tool of retrieval.tools) editor.add(tool);
        });
      } else {
        log(`retrieval unavailable: ${retrieval.reason ?? "unknown"}`);
      }
    } else {
      log(
        "index unavailable (no node:sqlite in this runtime) -- capture continues, search will not work",
      );
    }

    // Identity used for the index and for the default "this project" filter.
    const slug = projectSlug(workspaceDir);

    /**
     * Index a file the write path just replaced in full.
     *
     * Snapshots rewrite their whole file every turn, so the cheap tail path would
     * leave last turn's turns behind as duplicate search hits. Never throws: the
     * index is derived data, and a failed update is repaired by
     * `memory_reindex` without the user needing to know it happened.
     */
    const indexReplaced = async (
      files: readonly string[],
      root: "project" | "archive",
    ): Promise<void> => {
      if (!index) return;
      for (const file of files) {
        const written = await indexWrittenFile({
          db: index,
          file,
          root,
          project: slug,
          log,
        });
        if (written > 0) log(`indexed ${written} unit(s) from ${file}`);
      }
    };

    /**
     * Index the tail of a file the write path just appended to.
     *
     * The daily entry file only ever grows, so only its new block needs parsing.
     * Units already in the index are recognised by provenance marker, which is
     * the same idempotency openclaw's write path uses -- so a re-run costs one
     * read and inserts nothing.
     */
    const indexAppended = async (file: string, root: "project" | "archive"): Promise<void> => {
      if (!index) return;
      const written = await indexTail({ db: index, file, root, project: slug });
      if (written > 0) log(`indexed ${written} new unit(s) from ${file}`);
    };

    const controller = new AbortController();
    const settleTimers = new Map<string, ReturnType<typeof setTimeout>>();
    let closed = false;

    /** Snapshot, then sweep, for one session. Kept sequential so a slow LLM call
     *  cannot outlive the next turn's snapshot of the same session. */
    const settle = async (sessionID: string): Promise<void> => {
      if (closed) return;
      let snapshot: Awaited<ReturnType<typeof writeSessionSnapshot>> = null;
      try {
        snapshot = await writeSessionSnapshot(ctx, sessionID);
        if (snapshot) {
          log(`snapshot ${snapshot.bytes} B -> ${snapshot.projectPath}`);
          // Both copies, so a cross-project search finds the session under the
          // project that had it as well as under the global archive.
          await indexReplaced([snapshot.projectPath], "project");
          await indexReplaced([snapshot.archivePath], "archive");
        }
      } catch (error) {
        log("snapshot failed", error);
      }
      if (closed) return;

      // Gate the sweep on local inference being reachable.
      //
      // This has to happen *before* the sweep claims anything. openclaw's
      // pipeline retries a failing extraction three times with a 2 s base delay
      // and then parks the record permanently, so an unreachable service that is
      // allowed to fail inside the pipeline destroys a memory per outage instead
      // of deferring it. Checking here leaves every prompt pending and its retry
      // count untouched, which is the same thing `loadTurn` returning no turn
      // does. The snapshot above still lands either way.
      //
      // Nothing to check when extraction is not routed to the local service.
      if (localService && !(await localService.ready())) {
        log(
          "local service unavailable; deferring the sweep. Snapshots keep working " +
            "and pending captures are retried once the service is back" +
            (allowHosted ? " -- or set model.allowHostedFallback = false to fail fast" : ""),
        );
        return;
      }

      try {
        const outcomes = await capture.runSweep({ sessionId: sessionID });
        for (const outcome of outcomes) {
          if (outcome.kind === "captured") {
            log(`captured ${outcome.promptId} -> ${outcome.relativePath ?? "?"}`);
            // `relativePath` is openclaw's own workspace-relative key, so the
            // file it names is the one to index -- not today's daily file, which
            // is a guess that would silently miss a capture written for another
            // day by a change in the pipeline's clock handling.
            if (outcome.relativePath) {
              await indexAppended(path.join(workspaceDir, outcome.relativePath), "project");
            }
          } else if (outcome.kind === "failed" || outcome.kind === "exhausted") {
            log(`${outcome.kind} ${outcome.promptId}`, outcome.error);
          } else {
            log(`${outcome.kind} ${outcome.promptId}`);
          }
        }
        // Distinguish "nothing was pending" from "everything was pending but
        // silently dropped" -- both look identical without this line.
        if (outcomes.length === 0) log("sweep: nothing pending");
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
      void localService?.dispose();
    };
  },
});
