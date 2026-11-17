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
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { Plugin } from "@opencode/plugin";
import {
  createMemoryCapture,
  deleteCapturePrompt,
  listAllPendingCapturePrompts,
} from "../../extensions/memory-core/src/capture/index.js";
import { configureMemoryCoreDreamingState } from "../../extensions/memory-core/src/dreaming-state.js";
import {
  createCaptureDependencies,
  hostedComplete,
  type CaptureCompleteOverride,
} from "./capture-deps.js";
import { createStorageOpenKeyedStore } from "./kv.js";
import { readModelConfig, readRuntimeSpawnFlags, readServiceConfig, resolveEmbedAvailability, runtimeTag, serverEntryPath, type RuntimeVariant } from "./model/config.js";
import { isBatteryPaused } from "./model/power.js";
import { readWikiConfig } from "./wiki/config.js";
import { readWebConfig } from "./web/config.js";
import { startWebServer } from "./web/server.js";
import type { RepairOutcome } from "./web/api.js";
import { forget as forgetHost } from "./forget.js";
import { createServiceClient, nodeSystemCaArgs, probeService, type MemPlusService } from "./model/client.js";
import { createLogger } from "./log.js";
import { startEmbedderRepair, startEmbedderRepairOnce } from "./embedder-repair.js";
import { createDreamingRun } from "./dreaming-run.js";
import { createRuntimeActions } from "./web-runtime-actions.js";
import { indexPath, memoryRelativePath, missingVectorCount, openIndex, rewriteLegacyEmbedderModels } from "./memory-index.js";
import { buildMemoryTools, EMBED_BUDGET } from "./memory-tools.js";
import { createAutoEmbedScheduler } from "./auto-embed.js";
import { createIndexWrites } from "./index-writes.js";
import { createIndexReconciler } from "./index-reconcile.js";
import { buildStandingIntentTool } from "./standing-intents.js";
import { maybeCapturePreferences } from "./preference-capture.js";
import { installMemoryInjection } from "./recall-inject.js";
import { createRecallPushLane } from "./recall-push.js";
import { createRecallIntentGate } from "./recall-intent-embed.js";
import { recallToolsFor, readDeepRecallConfig } from "./deep-recall.js";
import { resolveOptions } from "./config-file.js";
import { adoptOpenclawStateDir, logFile, stateRoot } from "./paths.js";
import { clearActiveProjectKeys } from "./project-key.js";
import { createContextHooks } from "./context-hooks.js";
import {
  eventBelongsToWorkspace,
  isExecutionEnded,
  normaliseEventType,
  unwrapEvent,
} from "./event-compat.js";
import { writeSessionSnapshot } from "./snapshot.js";
import { createFlushHooks } from "./flush-hooks.js";

/** Settle time after a turn completes before snapshot + sweep run. */
const TURN_SETTLE_MS = 2_000;

/** Pending prompts older than this are stale (session deleted or never answered). */
const PROMPT_MAX_AGE_MS = 7 * 24 * 60 * 60_000;

/** The listing filters by attempts; pass a huge ceiling to see every pending record. */
const NO_RETRY_LIMIT = Number.MAX_SAFE_INTEGER;

/**
 * Drop landing records nobody will ever complete. Without this the namespace grows
 * forever: a prompt whose session was deleted, or whose assistant reply never
 * arrived, stays `captured = 0` indefinitely and is invisible to the age-blind
 * pending query.
 *
 * Namespace-wide, not per-project. The pending query is scoped to one workspace and this
 * used to inherit that scope through `ctx.location.directory`, which left the ceiling
 * unreachable for every project the process was not currently in -- precisely the growth
 * the paragraph above exists to prevent. Its reference prunes by age with no project
 * filter in it at all, so the scope, not the age rule, was the deviation.
 */
async function pruneStalePrompts(): Promise<number> {
  const cutoff = Date.now() - PROMPT_MAX_AGE_MS;
  const all = await listAllPendingCapturePrompts({ maxRetries: NO_RETRY_LIMIT });
  let pruned = 0;
  for (const record of all) {
    if (record.createdAt >= cutoff) continue;
    await deleteCapturePrompt(record);
    pruned += 1;
  }
  return pruned;
}

// 保持最新的启动对齐每**进程**只跑一次：setup 按工作区进来三次，各跑一遍
// 就是三次下载（.part 互踩）。放模块级，与 embedder repair 的单飞状态同款
// （那组状态已随 repair 本体移进 embedder-repair.ts）。
let runtimeAlignStarted = false;

export default Plugin.define({
  id: "mem-plus",
  async setup(ctx) {
    // First thing, before anything reads a path: the vendored openclaw code resolves its
    // state directory from `OPENCLAW_STATE_DIR` and otherwise lands in `~/.openclaw`.
    // Everything it owns -- the agent database, the global state database, `locks/` -- is
    // mem-plus's, so it has to resolve into the state root above. See `adoptOpenclawStateDir`.
    adoptOpenclawStateDir();
    const log = createLogger("[mem-plus]");
    const workspaceDir = ctx.location.directory;
    // Lane-one injection (trigger recall + project memory), once the index exists.
    let memoryInjection: { dispose: () => Promise<void> } | undefined;
    // First line in the log file, so an empty or stale log is unambiguous.
    log(`plugin loaded, workspace ${workspaceDir}`);
    log(`log file ${logFile()}`);

    // Landing zone storage: the pipeline's only remaining host dependency.
    configureMemoryCoreDreamingState(createStorageOpenKeyedStore(ctx));

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
    // 装载时的运行时 tag：自动对齐把 runtime.json 写新后，status 用它算
    // tagPending（=旧值≠现值），与变体 pending 同款「重启生效」语义。
    const runtimeTagAtLoad = runtimeTag();
    const wikiConfig = readWikiConfig(options);
    // Only one model slot is left on this machine: the embedding model. Extraction,
    // promotion consolidation and dreaming all run on the user's OpenCode model, so a
    // missing embedding model degrades search to keyword-only and nothing else -- it must
    // never take capture or consolidation down with it.
    const embedAvailability = resolveEmbedAvailability(modelConfig);
    const vectorsUsable = embedAvailability.mode !== "fts-only" && !embedAvailability.missingPath;
    const hostedLabel = modelConfig.hostedModel
      ? `${modelConfig.hostedModel.providerID}/${modelConfig.hostedModel.id}`
      : "opencode default";

    // The service is embedding-only, so it is created for that slot alone.
    const service: MemPlusService | null = vectorsUsable
      ? createServiceClient(serviceConfig, modelConfig, log)
      : null;

    // 保持最新（机主 2026-11-05 拍板：删掉稳定版/测试版选择，全自动）：
    // 装载后后台对齐一次上游最新 nightly——server.mjs `--ensure`：解析→
    // 写回 runtime.json→缺则下载→完即退，不监听。开关关着不跑；离线时
    // server.mjs 内部降级继续（10s 探测上限，只落日志），不碰服务与索引。
    // 下一次 OpenCode 启动会带着新 tag 装载（行身份不变，重启只为让
    // spawn 用上新 tag 的运行时目录）。
    if (vectorsUsable && serviceConfig.autoPrepareRuntime && !runtimeAlignStarted) {
      const alignEntry = serverEntryPath();
      if (existsSync(alignEntry)) {
        runtimeAlignStarted = true;
        const align = spawn(
          process.execPath.startsWith("node") ? process.execPath : "node",
          [...nodeSystemCaArgs(), alignEntry, "--variant", serviceConfig.runtimeVariant, "--ensure"],
          { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
        );
        const relayAlign = (chunk: Buffer) => {
          for (const line of chunk.toString("utf8").split(/\r?\n/)) {
            if (line.trim().length > 0) log(`[align] ${line}`);
          }
        };
        align.stdout?.on("data", relayAlign);
        align.stderr?.on("data", relayAlign);
        align.on("error", (error) => log("runtime align spawn failed", error));
        align.on("exit", (code) =>
          log(`runtime align ${code === 0 ? "finished" : `failed (exit ${code})`}`),
        );
        log("runtime align started (keep-latest, background)");
      }
    }

    log(`extraction model = opencode (model = ${hostedLabel})`);

    // The extraction transport, named once because the pre-compaction flush reuses it.
    // It always runs on the user's own OpenCode model. `hostedComplete` throws on
    // failure, which keeps openclaw's landing zone honest: the record stays pending
    // and is retried, so a memory is written later rather than dropped.
    const complete: CaptureCompleteOverride = hostedComplete(ctx, modelConfig.hostedModel, log);

    const captureDeps = createCaptureDependencies(ctx, complete);
    const capture = createMemoryCapture(captureDeps);

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

    // 嵌入兜底门（2026-11-08，memory-chain §Lane 2）：只在正则落空时被判一次。
    // 向量化不可用（无模型/fts-only）就没有这个门——召回退回上游 4/13 的覆盖面。
    // prepare 走后台：URL 来自 probeService，绝不自启 llama-server（撤翻译门时
    // 定下的关键路径纪律，见 recall-intent-embed.ts 头注）。
    const recallIntentGate =
      service && vectorsUsable
        ? createRecallIntentGate({
            service: serviceConfig,
            embedModelPath: modelConfig.embedModelPath,
            log,
          })
        : null;
    void recallIntentGate?.prepare().catch((error) => log("recall-intent gate prepare failed", error));

    /**
     * 正在跑的引擎变体：本插件 spawn 的真身（client 活读配置后记录，仅子进程
     * 活着时有值）；服务没在跑时回落到活读配置 = 下次 spawn 会用的值。
     * 生效判定与文件占用守卫都按它算——select 即时生效（2026-11-05 拍板）
     * 后，装载期捕获的 `serviceConfig.runtimeVariant` 不再是真身。
     */
    const runningVariant = (): RuntimeVariant =>
      localService?.spawnedVariant ?? readRuntimeSpawnFlags(serviceConfig).runtimeVariant;

    /**
     * Installed by the retrieval block when the index and vector lane are
     * available. The write-path closures below also run when they are not, so
     * they call these no-ops instead of branching on `index`/`retrieval`.
     */
    let scheduleAutoEmbed: (file: string) => void = () => {};
    let disposeAutoEmbed: () => void = () => {};
    /** openclaw's 5-minute recovery scan: files the write path never named. */
    let disposeIndexReconcile: () => void = () => {};
    /**
     * Whole-index background embed pass, driven by the recovery scan.
     *
     * Bound by the retrieval block, which is the only place with a live
     * `retrieval` object; calling it before that is a no-op. `closed` is read
     * per batch so a plugin unload stops the loop between chunks rather than
     * running to the end of a long index.
     */
    let embedWholeIndex: (budget: number) => Promise<number> = async () => 0;

    // The extraction transport. `model.content` decides this, and nothing else does.
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
    const index = openIndex({ log });
    if (index) {
      log(`index ${indexPath()}`);

      // 旧身份行（带 nightly tag / `-cuda` 后缀）一次性改写成当前身份，
      // 必须在 repair 扫描与任何检索之前——同一批向量不值得为身份串白烧
      // 全量重嵌（实测 cos≈1，见 embedderIdFor）。0 行可改时零开销。
      const rewritten = rewriteLegacyEmbedderModels(index, modelConfig.embedderId);
      if (rewritten > 0) log(`rewrote ${rewritten} chunk(s) to embedder id ${modelConfig.embedderId}`);

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
        // The same string the index write and the embed pass use: `embedderId`
        // (model path + engine family `@llamacpp`). `model` is part of a chunk's row identity,
        // so these three must agree exactly -- see the note on `ModelConfig.embedderId`
        // and on `RetrievalDeps.model`.
        model: modelConfig.embedderId,
        options,
        log,
      });

      // openclaw embeds inside its reindex (`manager-index-preparation.ts:79`);
      // mem-plus has a separate budgeted pass, so the write path must schedule
      // it. Only the documents that pass names are queued -- snapshots rewrite
      // every turn and stay on-demand.
      const autoEmbed = createAutoEmbedScheduler({
        embedMissing: (budget, signal, paths) =>
          retrieval.embedMissing(budget, signal, paths),
        log,
        enabled: retrieval.available && vectorsUsable,
        budget: EMBED_BUDGET,
        // 电池暂停：队列原地保留（auto-embed.ts 的 run() 预检）。
        pausedOnBattery: () => isBatteryPaused(serviceConfig),
      });
      scheduleAutoEmbed = (file) => autoEmbed.schedule(memoryRelativePath(file));
      disposeAutoEmbed = autoEmbed.dispose;

      // The whole-index embed pass. Loops while a batch fills its budget, because
      // the recovery scan asks it to drain everything that is missing rather
      // than take one slice of it; a batch that did not fill the budget means
      // nothing is left. Single-flight by construction: `embedMissing` is
      // `RetrievalTools`'s own, which is bound once here, and the reconcile pass
      // is the only caller -- `repairEmbedder` has its own loop and its own
      // in-flight promise.
      embedWholeIndex = async (budget: number): Promise<number> => {
        let total = 0;
        for (;;) {
          if (closed) break;
          // No `paths`: the whole index. No `signal`: this is a background loop
          // with no request to cancel, same as `repairEmbedder`.
          const written = await retrieval.embedMissing(budget);
          total += written;
          if (written < budget) break;
        }
        return total;
      };

      // Upstream's recovery pass, at its own five-minute cadence. Covers what
      // the write path cannot name -- a hand-edited MEMORY.md, a wiki page -- and
      // so makes `memory_reindex` a repair tool rather than the only way a file
      // becomes visible. It does not replace `memory_reindex`: that still rebuilds
      // everything explicitly.
      //
      // Deliberately placed BEFORE the embedder repair below: the repair looks
      // for stale rows, which is a different question from "is anything missing",
      // and the two must not race over the same chunks.
      const reconcile = createIndexReconciler({
        db: index,
        ...(modelConfig.embedderId ? { model: modelConfig.embedderId } : {}),
        options,
        log,
        vectorsEnabled: vectorsUsable,
        missingVectors: () => missingVectorCount(index, modelConfig.embedderId),
        // Probe only. A recovery pass must never be the thing that pulls a
        // multi-GB model into memory, so the question is "is one already up",
        // answered by the same `probeService` the Runtime page uses.
        serviceUp: async () => (await probeService(serviceConfig)) !== null,
        // 电池暂停：门在 serviceUp 探测之前（探测会刷 lastUsedAt，见
        // IndexReconcileOptions.pausedOnBattery 的注释）。
        pausedOnBattery: () => isBatteryPaused(serviceConfig),
        scheduleEmbed: () => {
          // Fire-and-forget: the pass that scheduled it has nothing to report to.
          void embedWholeIndex(EMBED_BUDGET).catch((error) =>
            log("index reconcile embed failed", error),
          );
        },
      });
      disposeIndexReconcile = reconcile.dispose;

      // 换嵌入运行时/模型后，旧行的向量已失效且向量 lane 查不到它们
      // （`searchVector` 只查 `model = embedderId`）——后台按需全重嵌。
      // 只在真有活时开跑（函数内部先查 stale/missing，零活即返回，
      // 不碰服务不发请求）；`ready()` 失败只推迟不重试，下次启动自愈。
      // 手动入口（Runtime 页按钮）走同一个 runner，并发时合流到在跑的那次。
      // 单飞状态与轮询循环本体在 embedder-repair.ts；这里只留宿主接线。
      const repairParams = {
        db: index,
        retrieval,
        embedderId: modelConfig.embedderId,
        // 电池暂停也走 false：热服务上 ready() 会成功，修复是后台批量
        // 重嵌，电池上不开跑（postponed 到下次启动/插电后的手动触发）。
        serviceReady: async (): Promise<boolean> => {
          if (await isBatteryPaused(serviceConfig)) {
            log("embedder repair postponed: paused on battery (service.pauseOnBattery)");
            return false;
          }
          return localService?.ready() ?? false;
        },
        log,
      };
      const runEmbedderRepair = (): Promise<RepairOutcome> =>
        startEmbedderRepair(repairParams);
      if (vectorsUsable && retrieval.available) {
        startEmbedderRepairOnce(repairParams);
      }

      // Lane one, upstream's way: the matched curated entries ride along as
      // request-scoped system context on every agent-loop model call. Registered
      // here because this is where the index becomes available.
      //
      // Lane 2 gets its tools from the same `buildMemoryTools` output rather than a second
      // implementation: upstream resolves `toolsAllow` against the host's memory tool
      // registry at run time, and that registry is here.
      //
      // Relevance push (`recall-push.ts`, no upstream counterpart): warm-only —
      // probeService never spawns, so a cold service means this lane stays quiet
      // instead of putting a llama-server cold start on the prompt path.
      const recallPush =
        service && vectorsUsable
          ? createRecallPushLane({
              service: serviceConfig,
              model: modelConfig.embedderId,
              options,
              log,
            })
          : undefined;
      const injection = await installMemoryInjection({
        ctx,
        db: index,
        workspaceDir,
        log,
        options,
        intentEmbedGate: recallIntentGate ?? undefined,
        recallPush,
        recallTools: () => recallToolsFor(readDeepRecallConfig(options), retrieval),
      });
      memoryInjection = injection;

      // Standing intents: openclaw's own tool and matcher behind OpenCode's tool shape
      // and session identity (see `standing-intents.ts`). Registered apart from the
      // retrieval tools because it reads its own database, not the index.
      await ctx.tool.transform((editor) => {
        editor.add(buildStandingIntentTool({ workspaceDir, log }));
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
          // Upstream's `openclaw memory forget`. Exposed on the browser rather than
          // as a tool, because upstream deliberately keeps it out of the model's
          // reach: it rewrites the user's memory files irreversibly. `forget()`
          // defaults `dryRun`, so this route previews unless asked otherwise.
          forget: async (input) =>
            (await forgetHost(input, index)) as unknown as Record<string, unknown>,
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
          // Runtime 页：状态读取走 handleRuntimeStatus（它自己读文件与索引），
          // 这里只给动作与服务探针。三个动作都要服务对象，向量不可用时整块
          // 不给，页面按 503 显示"不可用"。动作本体在 web-runtime-actions.ts。
          runtime: createRuntimeActions({
            vectorsUsable,
            localService,
            serviceConfig,
            runningVariant,
            activeTag: runtimeTagAtLoad,
            repair: runEmbedderRepair,
            log,
          }),
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
        "index unavailable (reason logged above) -- capture continues, search will not work",
      );
    }

    const { indexReplaced, indexAppended, indexCapturedOutcomes } = createIndexWrites({
      db: index,
      embedderId: modelConfig.embedderId,
      workspaceDir,
      log,
      // Trampoline, not the value: the retrieval block rebinds `scheduleAutoEmbed`
      // after this line, and the no-op case (no index) must stay no-op.
      queueEmbed: (file) => scheduleAutoEmbed(file),
    });

    const controller = new AbortController();
    const settleTimers = new Map<string, ReturnType<typeof setTimeout>>();
    let closed = false;

    // --- pre-compaction flush ------------------------------------------------
    // openclaw's fourth write path. Body, both triggers and the single-flight
    // gate live in flush-hooks.ts; this is the host wiring (ctx, options, the
    // closed flag, capture deps, the index tail path). Registers the occupancy
    // `prompt` hook itself; the compaction backstop in the event handler below
    // uses the returned `maybeFlush`.
    const { maybeFlush } = await createFlushHooks({
      ctx,
      options,
      isClosed: () => closed,
      captureDeps,
      indexAppended,
      log,
    });

    // Bootstrap injection into the session system prompt: body lives in
    // context-hooks.ts (file list + home MEMORY.md provenance gate +
    // missing-session-id warning); this is only the host wiring.
    await createContextHooks({ ctx, workspaceDir, log });

    /**
     * Daily dreaming sweep, gated to once per calendar day. The body lives in
     * `dreaming-run.ts` (marker claim + light/REM sweep + rehearsal + promotion);
     * this is only the host wiring -- ctx, resolved options, the pinned hosted
     * model and the write path back into the index.
     */
    const maybeRunDreaming = createDreamingRun({
      ctx,
      options,
      hostedModel: modelConfig.hostedModel,
      log,
      indexMemoryFile: indexReplaced,
    });

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
          // autoEmbed: a changed snapshot re-ids its chunks (hash over text +
          // span), leaving zero-length vectors behind; without this they pile
          // up until the next startup's repair — 641 once, 11 minutes of
          // double-stack GPU contention (2026-11-05). `embedMissing` only
          // fills what is missing, so an unchanged settle costs one query.
          await indexReplaced([snapshot.path], { autoEmbed: true });
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
      // STAGE 2: extraction no longer runs on the local service, so its availability is
      // not a precondition for sweeping. The gate used to exist because a dead local
      // model would fail inside the pipeline and burn a memory per outage; that failure
      // mode is gone with the branch. The sweep now runs regardless, and a capture whose
      // model call fails stays pending on its own.
      void localService;

      try {
        const outcomes = await capture.runSweep({ sessionId: sessionID });
        await indexCapturedOutcomes(outcomes);
        for (const outcome of outcomes) {
          if (outcome.kind === "captured") {
            log(`captured ${outcome.promptId} -> ${outcome.relativePath ?? "?"}`);
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
        // Phase 3 item 1: the preference pass. Detached like capture -- the gate
        // is regex-only, so an ordinary message costs nothing and a durable one
        // costs one small model call that can fail silently. Never awaited here:
        // the inbox handler runs on the turn's own critical path.
        void maybeCapturePreferences({
          ctx,
          workspaceDir,
          text,
          model: modelConfig.hostedModel,
          log,
        });
        return;
      }

      if (canonicalType === "session.compaction.started") {
        // The backstop trigger. The context hook normally gets there first; this
        // covers a manual `/compact` and a turn that outgrew the window without
        // returning to the hook. The event's own id is what keeps two compactions
        // in one day from sharing a marker.
        void maybeFlush(sessionID, "compaction", {
          compactionID: event.data?.inputID ?? event.id,
        });
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
        const pruned = await pruneStalePrompts();
        if (pruned > 0) log(`pruned ${pruned} stale prompt(s)`);
        const outcomes = await capture.runSweep();
        if (outcomes.length > 0) log(`startup sweep processed ${outcomes.length} prompt(s)`);
        await indexCapturedOutcomes(outcomes);
      } catch (error) {
        log("startup sweep failed", error);
      }
    })();

    log(`ready in ${workspaceDir}`);

    return () => {
      closed = true;
      disposeAutoEmbed();
      disposeIndexReconcile();
      controller.abort();
      for (const timer of settleTimers.values()) clearTimeout(timer);
      settleTimers.clear();
      // Upstream keeps the active repository keys in session runtime state and never
      // persists them. A reload is a new runtime, so the sets go with it -- otherwise a
      // session that ran before the reload would keep its scope, which is exactly the
      // "new session inherits old scope" behaviour the set exists to prevent.
      clearActiveProjectKeys();
      void memoryInjection?.dispose();
      void localService?.dispose();
    };
  },
});
