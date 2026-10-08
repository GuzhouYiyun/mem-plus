// mem-plus: an OpenCode memory plugin built from openclaw's memory subsystem.
//
// WHAT IT DOES
//   1. Lands every admitted user prompt in a landing zone (OpenCode has no
//      `chat.message` hook in V2, so the durable `session.inbox.enqueued` event is
//      the admission boundary: it carries the canonical persisted text and a stable
//      `inboxID` that makes re-delivery idempotent).
//   2. After each turn (`session.execution.succeeded`) runs the ported capture
//      pipeline: claim -> slice the assistant turn -> bounded markdown context ->
//      LLM structured extraction -> filter `type="skip"` -> append the daily
//      file in the memory home: `~/.config/opencode/mem-plus/workspace/memory/
//      <project-slug>/YYYY-MM-DD.md`. The project directory is never written.
//   3. Re-renders the whole session as `<...>/memory/<project-slug>/<YYYY-MM-DD>-
//      <slug>.md` in the same home, and a once-a-day global dreaming sweep
//      distills the home into `MEMORY.md` and `DREAMS.md` at its root --
//      openclaw's single-agent-workspace model, with projects as directory
//      labels rather than separate stores.
//   4. Indexes the home tree into SQLite + FTS5 and exposes `memory_search`,
//      `memory_get` and `memory_reindex`, so what was written can be found
//      again from every project on the machine.
//
// WHY THE INDEX IS SEPARATE FROM THE WRITE PATH
//   Writes land as plain markdown first and the index is a projection of those
//   files, exactly as in openclaw where a file watcher owns it. Nothing about
//   capture depends on the index existing: if `node:sqlite` is missing the
//   plugin still records everything, it just cannot search it. The other
//   direction also holds -- a broken or deleted index is repaired by
//   `memory_reindex`, and no memory is ever lost with it.
import path from "node:path";
import { readFile } from "node:fs/promises";
import { Plugin } from "@opencode/plugin";
import {
  createMemoryCapture,
  deleteCapturePrompt,
  listPendingCapturePrompts,
} from "../../extensions/memory-core/src/capture/index.js";
import { configureMemoryCoreDreamingState } from "../../extensions/memory-core/src/dreaming-state.js";
import { runDreamingSweepPhases } from "../../extensions/memory-core/src/dreaming-phases.js";
import { formatMemoryDreamingDay } from "../../extensions/memory-core/src/capture/day.js";
import {
  createCaptureDependencies,
  disabledComplete,
  hostedComplete,
} from "./capture-deps.js";
import { createStorageOpenKeyedStore } from "./kv.js";
import { missingContentPaths, readModelConfig, readServiceConfig, resolveEmbedAvailability } from "./model/config.js";
import { readWikiConfig } from "./wiki/config.js";
import { readWebConfig } from "./web/config.js";
import { startWebServer } from "./web/server.js";
import { createServiceClient, type MemPlusService } from "./model/client.js";
import { createLogger } from "./log.js";
import { indexPath, openIndex } from "./memory-index.js";
import { indexWrittenFile, indexTail } from "./memory-scan.js";
import { buildMemoryTools } from "./memory-tools.js";
import { resolveOptions } from "./config-file.js";
import { dreamingMarker, homeProjectMemoryDir, homeProjectSlug, logFile, memoryHomeDir, stateRoot } from "./paths.js";
import {
  DEFAULT_MEMORY_FILENAME,
  WORKSPACE_BOOTSTRAP_FILENAMES,
} from "../../src/agents/workspace-bootstrap-policy.js";
import {
  eventBelongsToWorkspace,
  isExecutionEnded,
  normaliseEventType,
  unwrapEvent,
} from "./event-compat.js";
import type { PluginContext } from "./opencode.js";
import { writeSessionSnapshot } from "./snapshot.js";
import { loadWorkspaceBootstrapFiles } from "../../src/agents/workspace.js";
import { buildBootstrapContextFiles } from "../../src/agents/embedded-agent-helpers/bootstrap.js";
import {
  prepareContextFilesForPrompt,
  buildProjectContextSection,
} from "../../src/agents/system-prompt-context-files.js";

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
    // to the OpenCode model -- see `allowHostedFallback` in model/config.ts.
    // Snapshots keep working either way, and openclaw's landing zone leaves the
    // record pending so it is retried once the service is back.
    // Settings resolution happens once, here, so the precedence
    // (built-in defaults < `ctx.options` < `~/.config/opencode/mem-plus/config.jsonc`)
    // is stated in exactly one place and every reader below sees the same object.
    // Merging it here rather than inside each `read*Config()` is what makes the
    // settings file work under directory auto-discovery too -- see config-file.ts.
    const resolved = resolveOptions(ctx.options, stateRoot());
    if (resolved.error) log(`config file unusable, falling back to plugin options -- ${resolved.error}`);
    else if (!resolved.hasFile) log(`no settings file yet; created ${resolved.file}`);
    const options = resolved.options;

    const modelConfig = readModelConfig(options);
    const serviceConfig = readServiceConfig(options);
    const wikiConfig = readWikiConfig(options);
    // openclaw treats the two model slots independently
    // (manager-provider-lifecycle.ts): extraction needs the content model, and
    // only extraction. A missing embedding model degrades search to
    // keyword-only -- it must not take extraction down with it.
    const missingContent = missingContentPaths(modelConfig);
    const embedAvailability = resolveEmbedAvailability(modelConfig);
    const vectorsUsable = embedAvailability.mode !== "fts-only" && !embedAvailability.missingPath;
    const allowHosted = modelConfig.allowHostedFallback;
    const hostedLabel = modelConfig.hostedModel
      ? `${modelConfig.hostedModel.providerID}/${modelConfig.hostedModel.id}`
      : "opencode default";

    // The local service answers whichever slots need it, and they are different
    // slots: `model.content` picks the summarising model, `model.embed` picks the
    // embedding one. With `content` defaulting to `opencode` the service is no
    // longer implied by extraction -- but embeddings still need it, so creating it
    // only on the `local` branch would quietly turn vector search off for everyone
    // who left `model.content` alone.
    const wantsLocalContent = modelConfig.contentBackend !== "opencode" && missingContent.length === 0;
    let service: MemPlusService | null = null;
    if (wantsLocalContent || vectorsUsable) {
      service = createServiceClient(serviceConfig, modelConfig, log);
    }

    if (modelConfig.contentBackend === "opencode") {
      log(`extraction model = opencode (model = ${hostedLabel})`);
    } else if (missingContent.length > 0) {
      for (const file of missingContent) log(`  missing ${file} -- see README "本地模型"`);
      if (allowHosted) {
        log(
          "extraction model = opencode (fallback: GGUF not found, model.allowHostedFallback = true) " +
            `(model = ${hostedLabel})`,
        );
      } else {
        log(
          "extraction DISABLED (GGUF not found; snapshots still written). " +
            'Fix the paths, set options.model.allowHostedFallback = true, or set ' +
            'options.model.content = "opencode" to summarise on the OpenCode model.',
        );
      }
    } else {
      log(
        `extraction model = local gguf via ${serviceConfig.host}:${serviceConfig.port} ` +
          `(gpu priority ${modelConfig.gpu}, idle ${serviceConfig.idleMinutes} min)`,
      );
    }

    // Vector search degrades on its own: openclaw's `optional` embed requirement
    // ("Semantic memory recall is degraded..."), not a subsystem failure. The
    // retrieval tools take a null service as "vector modes disabled", so text
    // search keeps working and `hybrid` / `vector` report themselves unavailable.
    if (embedAvailability.mode === "fts-only") {
      log("vector search off (model.embed = false) -- text search only");
    } else if (embedAvailability.missingPath) {
      if (embedAvailability.mode === "required") {
        log(
          `  missing ${embedAvailability.missingPath} (model.embedPath) -- vector search stays off; ` +
            "fix the path or remove the option to fall back silently",
        );
      } else {
        log(
          `  no embedding model at ${embedAvailability.missingPath} -- vector search off, ` +
            "text search unaffected",
        );
      }
    }

    const localService = service;
    const capture = createMemoryCapture(
      createCaptureDependencies(
        ctx,
        // `model.content` decides this, and nothing else does.
        //
        // It used to be the other way round: the check was "does a service object
        // exist", and because embeddings and summarising share one service, having
        // the embedding GGUF installed created that object and handed *extraction*
        // to the local model as well. So `"content": "opencode"` silently meant
        // "local, whenever a GGUF happens to be present" -- and it broke the worst
        // possible way, because the local model was missing on exactly those
        // machines, so extraction stalled and the records piled up pending. The page's
        // own help text for the setting ("不需要下载 GGUF、不需要显卡") was false.
        //
        // The service is still created when `vectorsUsable`: that is the embedding
        // slot, a separate need, and it must not depend on the extraction setting.
        modelConfig.contentBackend === "opencode"
          ? hostedComplete(ctx, modelConfig.hostedModel)
          : localService
            ? async ({ systemPrompt, prompt }) => {
              try {
                return await localService.extract({ systemPrompt, prompt });
              } catch (error) {
                if (!allowHosted) {
                  // Throw rather than degrade. The sweep records the failure and
                  // the record stays pending, so the memory is written later
                  // instead of the model silently changing for as long as the
                  // outage lasts.
                  log(
                    "local service unavailable; skipping extraction and leaving the " +
                      "record pending (no OpenCode fallback -- " +
                      'set options.model.allowHostedFallback = true to change this)',
                    error,
                  );
                  throw error;
                }
                log(
                  "local service unavailable, using the OpenCode model for this turn " +
                    "(model.allowHostedFallback = true)",
                  error,
                );
                return await hostedComplete(ctx, modelConfig.hostedModel)({ systemPrompt, prompt });
              }
            }
          : disabledComplete(
              missingContent.length > 0
                ? `GGUF not found: ${missingContent.join(", ")}`
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

      // The memory browser, started here because this is where the index becomes
      // available: the page's data endpoints read it through the same open
      // connection the tools use, so there is exactly one reader of index.db.
      // Fire-and-forget -- static files plus a loopback socket must not delay
      // plugin loading, and the URL lands in the log either way.
      const retrieval = buildMemoryTools({
        db: index,
        workspaceDir,
        // Null service = vector modes off (see the note above); extraction above
        // keeps its own reference either way.
        service: vectorsUsable ? localService : null,
        options,
        log,
      });
      void startWebServer(
        readWebConfig(options),
        {
          db: index,
          workspaceDir,
          // Read per request rather than snapshotted here: the model list changes
          // when the user edits providers, and a picker holding a stale list is
          // worse than one that costs a call.
          listModels: () => ctx.model.list() as Promise<{ data?: unknown[] }>,
          // The page's "rebuild with vectors" button runs the *tool's* execute,
          // not a second implementation of the same walk. The tool object already
          // carries the db, the embedding service and the report text, so reusing
          // it is both less code and impossible to drift from what an agent gets.
          // What the page needs to tell "no model" apart from "nothing to embed",
          // resolved here because this is where the embedding model and the service
          // that loads it were already decided. `explicit` separates a path the user
          // named in settings (a misconfiguration, worth naming) from the default
          // location simply being empty (nothing installed yet).
          embedReady: {
            enabled: modelConfig.embedEnabled,
            usable: vectorsUsable,
            ...(embedAvailability.missingPath ? { missingPath: embedAvailability.missingPath } : {}),
            explicit: modelConfig.embedPathExplicit,
          },
          reindex: retrieval.available
            ? async ({ embed, embedBudget }) => {
                const tool = retrieval.tools.find((candidate) => candidate.name === "memory_reindex");
                if (!tool) throw new Error("memory_reindex is not registered");
                // `execute` returns OpenCode's tool result shape, whose `content` is a
                // string *or* a list of content blocks. The reindex tool always writes
                // the string form; normalise anyway rather than handing the page a
                // union it has to understand.
                // The reindex tool reads only `context?.signal`, but `execute`'s context type
                // demands a whole ToolContext whose id fields are branded. An HTTP
                // request has no agent, session, message or call behind it, so the
                // branded fields are given the one cast they need and the rest is
                // spelled out for real -- if the tool ever starts reading a field it
                // does not have, the compiler says so here rather than at runtime.
                const result = await tool.execute(
                  { embed, embedBudget },
                  {
                    agent: "mem-plus-web" as never,
                    signal: new AbortController().signal,
                    progress: async () => {},
                    sessionID: "web" as never,
                    messageID: "web" as never,
                    id: "web" as never,
                  },
                );
                const content = typeof result.content === "string" ? result.content : JSON.stringify(result.content);
                return { content, metadata: (result.metadata ?? {}) as Record<string, unknown> };
              }
            : undefined,
        },
        (message) => log(message)
      );
      log(
        wikiConfig.enabled
          ? `wiki corpus ${wikiConfig.dir} (search it with memory_search corpus "wiki")`
          : "wiki corpus disabled (options.wiki.enabled = false)",
      );
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

    /**
     * Index a file the write path just replaced in full.
     *
     * Snapshots rewrite their whole file every turn, so the cheap tail path would
     * leave last turn's turns behind as duplicate search hits. Never throws: the
     * index is derived data, and a failed update is repaired by
     * `memory_reindex` without the user needing to know it happened.
     */
    const indexReplaced = async (files: readonly string[]): Promise<void> => {
      if (!index) return;
      for (const file of files) {
        // Project identity comes from where the file sits under the home, not
        // from this window: the index is shared by every project on the machine,
        // so a document's project must be readable from its own path.
        const written = await indexWrittenFile({
          db: index,
          file,
          root: "home",
          project: homeProjectSlug(file),
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
    const indexAppended = async (file: string): Promise<void> => {
      if (!index) return;
      const written = await indexTail({
        db: index,
        file,
        root: "home",
        project: homeProjectSlug(file),
      });
      if (written > 0) log(`indexed ${written} new unit(s) from ${file}`);
    };

    const controller = new AbortController();
    const settleTimers = new Map<string, ReturnType<typeof setTimeout>>();
    let closed = false;

    // Inject bootstrap files into the session system prompt -- the same mechanism
    // openclaw uses for its embedded agents. The files are read fresh on every
    // model request because the owner may edit them between turns.
    //
    // The five instruction files are the user's own and stay in the project;
    // MEMORY.md is openclaw's home file, so it is read from the memory home and
    // appended last (canonical order). It only exists once dreaming has
    // promoted something into it, so absence is the normal state and is not a
    // `[MISSING]` worth showing the model.
    const instructionFileNames = WORKSPACE_BOOTSTRAP_FILENAMES.filter(
      (name) => name !== DEFAULT_MEMORY_FILENAME,
    );
    await ctx.session.hook("context", async (event) => {
      try {
        const files = await loadWorkspaceBootstrapFiles(workspaceDir, instructionFileNames);
        const homeMemoryPath = path.join(memoryHomeDir(), DEFAULT_MEMORY_FILENAME);
        try {
          files.push({
            name: DEFAULT_MEMORY_FILENAME,
            path: homeMemoryPath,
            content: await readFile(homeMemoryPath, "utf8"),
            missing: false,
          });
        } catch {
          // No global long-term memory yet; nothing to inject.
        }
        const contextFiles = buildBootstrapContextFiles(files);
        const preparedFiles = prepareContextFilesForPrompt(contextFiles);
        const lines = buildProjectContextSection(preparedFiles);
        if (lines.length > 0) {
          event.system.push({ type: "text", text: lines.join("\n") });
        }
      } catch (error) {
        log("bootstrap injection failed", error);
      }
    });

    /**
     * Daily dreaming sweep, gated to once per calendar day. openclaw schedules this
     * with its own cron daemon (`dreaming-cron.ts`); mem-plus has no cron host, so
     * the equivalent trigger is the first settled turn of a new day.
     *
     * The sweep is global: it runs over the whole memory home (every project's
     * captures, the one MEMORY.md and DREAMS.md), exactly openclaw's one-agent
     * one-home model. So the marker is one for the whole home -- any window that
     * settles first on a new day runs the sweep, and the marker keeps the other
     * windows out. The marker file is the only state: a day boundary means "run
     * once", and writing the marker before waiting means a crash mid-sweep
     * re-runs at most once.
     */
    const maybeRunDreaming = async (): Promise<void> => {
      try {
        const now = Date.now();
        const today = formatMemoryDreamingDay(now);
        const marker = dreamingMarker();
        let last = "";
        try {
          const fs = await import("node:fs/promises");
          last = (await fs.readFile(marker, "utf8")).trim();
        } catch {
          // First run: no marker yet, treat as a new day.
        }
        if (last === today) return;
        // Record the attempt first so a failed sweep does not retrigger every turn.
        const { mkdir, writeFile } = await import("node:fs/promises");
        await mkdir(path.dirname(marker), { recursive: true });
        await writeFile(marker, today, "utf8");

        const subagent =
          localService && (await localService.ready())
            ? {
                complete: async ({
                  message,
                  extraSystemPrompt,
                }: {
                  message: string;
                  extraSystemPrompt?: string;
                }) => ({
                  text: await localService.generate({
                    systemPrompt: extraSystemPrompt,
                    prompt: message,
                  }),
                }),
              }
            : undefined;
        const result = await runDreamingSweepPhases({
          agentId: "main",
          workspaceDir: memoryHomeDir(),
          pluginConfig: {
            dreaming: {
              enabled: true,
              storage: { mode: "inline", separateReports: false },
            },
          },
          logger: {
            info: (msg: string) => log(`dreaming: ${msg}`),
            warn: (msg: string) => log(`dreaming: ${msg}`),
            error: (msg: string) => log(`dreaming: ${msg}`),
          },
          subagent,
          nowMs: now,
        } as unknown as Parameters<typeof runDreamingSweepPhases>[0]);
        log(
          `dreaming sweep done: light+rem+deep over ${memoryHomeDir()} ` +
            `(degradedPhases=${result?.degradedPhases ?? 0}, pendingNarratives=${result?.pendingNarratives ?? 0})`,
        );
      } catch (error) {
        log("dreaming sweep failed", error);
      }
    };

    /** Snapshot, then sweep, for one session. Kept sequential so a slow LLM call
     *  cannot outlive the next turn's snapshot of the same session. */
    const settle = async (sessionID: string): Promise<void> => {
      if (closed) return;
      let snapshot: Awaited<ReturnType<typeof writeSessionSnapshot>> = null;
      try {
        snapshot = await writeSessionSnapshot(ctx, sessionID);
        if (snapshot) {
          log(`snapshot ${snapshot.bytes} B -> ${snapshot.path}`);
          // One file, in the session's own project slice of the home: a
          // cross-project search finds it under the project that had it.
          await indexReplaced([snapshot.path]);
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
            // `relativePath` is the pipeline's own key -- `memory/<day>.md`,
            // relative to the project it came from. The file itself lives in
            // this window's slice of the home, so index that path; using the
            // key rather than today's date keeps a capture written for
            // another day (a pipeline clock change) indexing the file it
            // actually wrote.
            if (outcome.relativePath) {
              const day = path.basename(outcome.relativePath, ".md");
              await indexAppended(path.join(homeProjectMemoryDir(workspaceDir), `${day}.md`));
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

      // Dreaming runs at most once per day; every settled turn checks the clock.
      void maybeRunDreaming();
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

    // `ctx.event.subscribe()` is machine-wide, not this window's. Without the
    // workspace check below, a session that ended in another project settles
    // here: its captures would land in this window's slice of the home and
    // carry this project's label. The index is shared, the event stream is not
    // per-workspace -- only the window that ran the turn may settle it.
    const onEvent = async (raw: unknown): Promise<void> => {
      const event = unwrapEvent(raw);
      const canonicalType = normaliseEventType(event?.type);
      if (!event || !canonicalType) return;
      const sessionID = event.data?.sessionID;
      if (typeof sessionID !== "string" || sessionID.length === 0) return;
      if (!(await eventBelongsToWorkspace(ctx, raw, event))) return;

      if (canonicalType === "session.inbox.enqueued") {
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

      if (isExecutionEnded(canonicalType)) scheduleSettle(sessionID);
    };

    void (async () => {
      try {
        for await (const raw of ctx.event.subscribe({ signal: controller.signal })) {
          // Not awaited: the stream must keep draining while a workspace lookup is in
          // flight, or one slow `session.get` stalls every later event.
          void onEvent(raw);
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
