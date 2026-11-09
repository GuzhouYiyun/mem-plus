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
import { existsSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import type { DatabaseSync } from "node:sqlite";
import { Plugin } from "@opencode/plugin";
import {
  createMemoryCapture,
  deleteCapturePrompt,
  listAllPendingCapturePrompts,
  type CaptureOutcome,
} from "../../extensions/memory-core/src/capture/index.js";
import { configureMemoryCoreDreamingState } from "../../extensions/memory-core/src/dreaming-state.js";
import { runDreamingSweepPhases } from "../../extensions/memory-core/src/dreaming-phases.js";
import { formatMemoryDreamingDay } from "../../extensions/memory-core/src/capture/day.js";
import {
  createCaptureDependencies,
  hostedComplete,
  type CaptureCompleteOverride,
} from "./capture-deps.js";
import { createStorageOpenKeyedStore } from "./kv.js";
import { readModelConfig, readRuntimeSpawnFlags, readServiceConfig, resolveEmbedAvailability, resolveRuntimeFile, runtimeCudartZipPath, runtimeDirPath, runtimeTag, runtimeZipPath, serverEntryPath, effectiveRuntimeDirPath, type RuntimeVariant } from "./model/config.js";
import { isBatteryPaused } from "./model/power.js";
import { readWikiConfig } from "./wiki/config.js";
import { readWebConfig } from "./web/config.js";
import { startWebServer } from "./web/server.js";
import type { RepairOutcome, RuntimeAction } from "./web/api.js";
import { forget as forgetHost } from "./forget.js";
import { createServiceClient, nodeSystemCaArgs, probeService, type MemPlusService } from "./model/client.js";
import { createLogger } from "./log.js";
import { indexPath, memoryRelativePath, missingVectorCount, openIndex, rewriteLegacyEmbedderModels, staleEmbedderModels } from "./memory-index.js";
import { indexWrittenFile } from "./memory-scan.js";
import { buildMemoryTools, EMBED_BUDGET, type RetrievalTools } from "./memory-tools.js";
import { createAutoEmbedScheduler } from "./auto-embed.js";
import { createIndexReconciler } from "./index-reconcile.js";
import { completeThroughHost } from "./llm.js";
import { buildStandingIntentTool } from "./standing-intents.js";
import { maybeCapturePreferences } from "./preference-capture.js";
import { installMemoryInjection } from "./recall-inject.js";
import { createRecallPushLane } from "./recall-push.js";
import { createRecallIntentGate } from "./recall-intent-embed.js";
import { withMemoryFileLock } from "./memory-file-lock.js";
import { recallToolsFor, readDeepRecallConfig } from "./deep-recall.js";
import { runPromotionRound } from "./promotion.js";
import { runSelfGeneratedRehearsalRound } from "./rehearsal.js";
import { applySemanticRewardGate } from "./semantic-reward.js";
import { resolveOptions } from "./config-file.js";
import { adoptOpenclawStateDir, dreamingMarker, homeProjectMemoryDir, homeProjectSlug, logFile, memoryHomeDir, stateRoot } from "./paths.js";
import {
  activeProjectKeys,
  clearActiveProjectKeys,
  filterProjectScopedCuratedContext,
  prepareActiveProjectKey,
} from "./project-key.js";
import {
  BOOTSTRAP_FILENAMES,
  buildProjectContextSection,
  fitCuratedToBudget,
  loadBootstrapContextFiles,
  readContextFile,
} from "./bootstrap-context.js";
import {
  eventBelongsToWorkspace,
  isExecutionEnded,
  normaliseEventType,
  unwrapEvent,
} from "./event-compat.js";
import { asSessionMessage, type PluginContext, type SessionMessageView } from "./opencode.js";
import { writeSessionSnapshot } from "./snapshot.js";
import {
  readFlushConfig,
  resolveContextWindow,
  shouldFlushForOccupancy,
} from "./flush-config.js";
import { runFlush, type FlushTrigger } from "./flush-run.js";

/** Settle time after a turn completes before snapshot + sweep run. */
const TURN_SETTLE_MS = 2_000;

/** Pending prompts older than this are stale (session deleted or never answered). */
const PROMPT_MAX_AGE_MS = 7 * 24 * 60 * 60_000;

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

/**
 * embedder repair 每进程只开一次。多个项目窗口共享一个 OpenCode 进程和
 * 一个 index.db：第一处发现 stale 就开修，其余窗口再各开一遍只会并发重复
 * 同一批 /embed（幂等，但双倍流量、双倍日志）。
 */
let embedderRepairStarted = false;

/**
 * 正在跑的那次 repair。自动触发与网页「触发向量修复」共用一个入口
 * （`startEmbedderRepair`）：同时来两次只跑一次——第二次拿到的是同一个
 * promise，等它出结果，而不是并发再嵌一批。
 */
let embedderRepairInFlight: Promise<RepairOutcome> | null = null;

/**
 * embedder 身份切换后的全重嵌：把 stale 行按当前 `embedderId` 重写并补嵌，
 * 直到 index 干净（`docs/port-plan.md` 2026-11-04「推理服务换官方 llama.cpp」
 * 的步骤 3，行为变化记档在那里）。
 *
 * 走的是用户手动 `memory_reindex {embed:true}` 的同一条路——同一个工具
 * execute、同一个 runReindex，没有第二套写路径：`reindexFiles` 的 skip 键含
 * model（`unchangedSources` 按 chunk model 聚合，混模也算变），旧行按身份
 * 不匹配被整文件重写；`writeSourceChunks` 的 preserved SELECT 只保留
 * `model = 目标` 的向量，旧行向量不会被错留。
 *
 * 上限 20 轮 × embedBudget 500（工具自己的上限；活区 533 chunks，一轮装
 * 不下也不至于烧不完）。每轮之间从 db 复检 stale/missing，先停的是**没
 * 进展**而不是没轮数：进展 = stale 或 missing 至少一个下降（reindex 第一轮
 * 会把 stale 换成 missing，所以两个计数要分别比，不能加起来比）。
 * 超上下文被 `embedMissing` 跳过的 chunk 让 missing 永远到不了 0——那种
 * index 走 stalled 出口，诚实报 incomplete，不假装修好。
 *
 * 全程后台，不挡插件加载。门控在调用点：`vectorsUsable`（embed 关闭时旧行
 * 不是 stale，是配置）+ `retrieval.available` + 先查出有活才干——没活时
 * 一个请求都不发，`ready()` 可能触发的 autostart（spawn llama-server）不会
 * 因为每次启动白跑一遍。
 *
 * 返回值（`RepairOutcome`）只给网页 Runtime 页的「触发向量修复」按钮：
 * 自动触发那路忽略它，照旧只写日志。自动与手动共用
 * `startEmbedderRepair`，并发来两次只跑一次。
 */
async function repairEmbedder(params: {
  readonly db: DatabaseSync;
  readonly retrieval: RetrievalTools;
  readonly embedderId: string;
  readonly serviceReady: () => Promise<boolean>;
  readonly log: (message: string, detail?: unknown) => void;
}): Promise<RepairOutcome> {
  const { db, retrieval, embedderId, serviceReady, log } = params;
  let stale = staleEmbedderModels(db, embedderId);
  let missing = missingVectorCount(db, embedderId);
  if (stale.length === 0 && missing === 0) return { status: "clean", rounds: 0, stale: 0, missing: 0 };

  const tool = retrieval.tools.find((candidate) => candidate.name === "memory_reindex");
  if (!tool) {
    log("embedder repair skipped: memory_reindex not registered");
    return { status: "skipped", rounds: 0, stale: stale.length, missing };
  }

  log(
    `embedder id is ${embedderId}: ${stale.length} stale model group(s)` +
      (stale.length > 0 ? ` under ${stale.join(", ")}` : "") +
      `, ${missing} chunk(s) without vectors -- background re-embed starting`,
  );

  if (!(await serviceReady())) {
    log(
      "embedder repair postponed: embedding service not ready -- stale rows stay " +
        "invisible to vector search until a later start repairs them",
    );
    return { status: "postponed", rounds: 0, stale: stale.length, missing };
  }

  const MAX_ROUNDS = 20;
  const BUDGET = 500;
  let rounds = 0;
  while (rounds < MAX_ROUNDS && (stale.length > 0 || missing > 0)) {
    const prevStale = stale.length;
    const prevMissing = missing;
    rounds += 1;
    // `execute` 只读 `context?.signal`，但其 context 类型要整个 ToolContext：
    // 后台修复没有 agent/session/message/call，branded id 字段给一次 cast，
    // 其余字段照实拼——同 web 端 reindex 包装的取舍（工具将来多读一个字段
    // 会先在编译期在这里报错）。
    await tool.execute(
      { embed: true, embedBudget: BUDGET },
      {
        agent: "mem-plus-repair" as never,
        signal: new AbortController().signal,
        progress: async () => {},
        sessionID: "repair" as never,
        messageID: "repair" as never,
        id: "repair" as never,
      },
    );
    stale = staleEmbedderModels(db, embedderId);
    missing = missingVectorCount(db, embedderId);
    if (stale.length === 0 && missing === 0) break;
    if (stale.length >= prevStale && missing >= prevMissing) {
      log(
        `embedder repair stalled after round ${rounds}: stale=${stale.length} ` +
          `missing=${missing} -- not retrying; those counts name what is left`,
      );
      return { status: "stalled", rounds, stale: stale.length, missing };
    }
  }
  if (stale.length === 0 && missing === 0) {
    log(`embedder repair done in ${rounds} round(s): all vectors now under ${embedderId}`);
    return { status: "done", rounds, stale: 0, missing: 0 };
  }
  log(
    `embedder repair incomplete after ${rounds} round(s): stale=${stale.length} ` +
      `missing=${missing} under ${embedderId}`,
  );
  return { status: "incomplete", rounds, stale: stale.length, missing };
}

// 保持最新的启动对齐每**进程**只跑一次：setup 按工作区进来三次，各跑一遍
// 就是三次下载（.part 互踩）。放模块级，与 embedderRepairInFlight 同款。
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
    // Runtime 页「准备中」灯：prepare 是火速返回（592 MB 超页面超时），
    // 靠这组集合让引擎行显示进度、并防同一变体双开下载。
    const preparingVariants = new Set<RuntimeVariant>();
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
      const runEmbedderRepair = (): Promise<RepairOutcome> => {
        if (embedderRepairInFlight) return embedderRepairInFlight;
        let pending: Promise<RepairOutcome>;
        pending = repairEmbedder({
          db: index,
          retrieval,
          embedderId: modelConfig.embedderId,
          // 电池暂停也走 false：热服务上 ready() 会成功，修复是后台批量
          // 重嵌，电池上不开跑（postponed 到下次启动/插电后的手动触发）。
          serviceReady: async () => {
            if (await isBatteryPaused(serviceConfig)) {
              log("embedder repair postponed: paused on battery (service.pauseOnBattery)");
              return false;
            }
            return localService?.ready() ?? false;
          },
          log,
        }).finally(() => {
          if (embedderRepairInFlight === pending) embedderRepairInFlight = null;
        });
        embedderRepairInFlight = pending;
        return pending;
      };
      if (vectorsUsable && retrieval.available && !embedderRepairStarted) {
        embedderRepairStarted = true;
        void runEmbedderRepair().catch((error) => log("embedder repair failed", error));
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
          // 不给，页面按 503 显示"不可用"。
          runtime:
            vectorsUsable && localService
              ? {
                  // 生效引擎 = spawn 真身（活读），不是装载期捕获值——见
                  // runningVariant 的注释。
                  get activeVariant(): RuntimeVariant {
                    return runningVariant();
                  },
                  activeTag: runtimeTagAtLoad,
                  probe: () => probeService(serviceConfig),
                  download: async (force: boolean): Promise<RuntimeAction> => {
                    // 电池暂停预检放在最前：不能先拆了运行时再拒绝启动
                    // （force 分支第一步就是 dispose + 删 zip）。文案必须
                    // 明说原因——落到下面 ready() 的通用超时话术就是假话。
                    if (await isBatteryPaused(serviceConfig)) {
                      return {
                        ok: false,
                        detail: "电池暂停中（service.pauseOnBattery）：插电或关闭该设置后再启动服务",
                      };
                    }
                    // 擦的对象 = 会用到它的那一个变体；在 dispose 之前取值
                    // （dispose 后 spawn 真身消失，只剩活读配置）。
                    const variant = runningVariant();
                    if (force) {
                      // 先停再删：llama-server.exe 正在跑时 Windows 锁着文件，删不掉。
                      await localService.dispose();
                      try {
                        rmSync(runtimeDirPath(variant), { recursive: true, force: true });
                        rmSync(runtimeZipPath(variant), { force: true });
                        if (variant === "cuda") {
                          rmSync(runtimeCudartZipPath(), { force: true });
                        }
                      } catch (error) {
                        return {
                          ok: false,
                          detail: `删除旧运行时失败（可能仍被占用）：${error instanceof Error ? error.message : String(error)}`,
                        };
                      }
                    }
                    const started = await localService.ready({ forcePrepare: true });
                    if (started) return { ok: true, detail: `运行时就绪，服务已启动：${localService.url ?? ""}` };
                    return {
                      ok: false,
                      detail: force
                        ? "重新下载已触发，但服务 30 秒内未就绪——下载在后台继续，完成后自动恢复，稍后刷新本页"
                        : "启动已触发（首次包含运行时下载），但服务 30 秒内未就绪——下载在后台继续，完成后自动恢复，稍后刷新本页",
                    };
                  },
                  restart: async (): Promise<RuntimeAction> => {
                    // 电池暂停预检：同 download，先于 dispose，且给明确文案。
                    if (await isBatteryPaused(serviceConfig)) {
                      return {
                        ok: false,
                        detail: "电池暂停中（service.pauseOnBattery）：插电或关闭该设置后再重启服务",
                      };
                    }
                    const before = await probeService(serviceConfig);
                    await localService.dispose();
                    const started = await localService.ready();
                    if (!started) return { ok: false, detail: "服务未能就绪：30 秒内没有响应，稍后重试或查看日志" };
                    const after = await probeService(serviceConfig);
                    const url = after?.url ?? localService.url ?? "";
                    if (!before) return { ok: true, detail: `服务未在运行，已启动：${url}` };
                    const prev = before.health.uptimeSeconds;
                    const now = after?.health.uptimeSeconds;
                    // uptime 变小 = 换了进程 = 真重启了。没变说明服务是别的
                    // 实例启动的（dispose 只回收本插件拉起的子进程），如实说没重启。
                    return prev === undefined || now === undefined || now < prev
                      ? { ok: true, detail: `服务已重启：${url}` }
                      : { ok: true, detail: `服务由其他实例持有（本窗口没有启动它），未重启、已重新连接：${url}` };
                  },
                  repair: runEmbedderRepair,
                  preparing: () => [...preparingVariants],
                  prepare: async (variant: RuntimeVariant, force: boolean): Promise<RuntimeAction> => {
                    if (preparingVariants.has(variant)) {
                      return { ok: true, detail: `${variant} 引擎已在后台准备中，完成后引擎列表会显示已安装` };
                    }
                    // 生效变体的 exe 被子进程握着：先停再删（与 download force
                    // 同一条规矩）；非生效变体没人占，直接删。生效 = spawn 真身。
                    if (variant === runningVariant()) await localService.dispose();
                    if (force) {
                      try {
                        rmSync(runtimeDirPath(variant), { recursive: true, force: true });
                        rmSync(runtimeZipPath(variant), { force: true });
                        if (variant === "cuda") rmSync(runtimeCudartZipPath(), { force: true });
                      } catch (error) {
                        return {
                          ok: false,
                          detail: `删除旧运行时失败（可能仍被占用）：${error instanceof Error ? error.message : String(error)}`,
                        };
                      }
                    }
                    const entry = serverEntryPath();
                    if (!existsSync(entry)) return { ok: false, detail: `找不到 ${entry}` };
                    // 火速后台模式：--ensure 准备完即退，不起服务、不校验 GPU；
                    // 日志转进 mem-plus.log，进度由 preparing 集合驱动页面灯。
                    const child = spawn(
                      process.execPath.startsWith("node") ? process.execPath : "node",
                      [...nodeSystemCaArgs(), entry, "--variant", variant, "--ensure"],
                      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
                    );
                    preparingVariants.add(variant);
                    const relay = (chunk: Buffer) => {
                      for (const line of chunk.toString("utf8").split(/\r?\n/)) {
                        if (line.trim().length > 0) log(`[prepare:${variant}] ${line}`);
                      }
                    };
                    child.stdout?.on("data", relay);
                    child.stderr?.on("data", relay);
                    child.on("error", (error) => {
                      preparingVariants.delete(variant);
                      log(`prepare ${variant} spawn failed`, error);
                    });
                    child.on("exit", (code) => {
                      preparingVariants.delete(variant);
                      log(`prepare ${variant} ${code === 0 ? "finished" : `failed (exit ${code})`}`);
                    });
                    return {
                      ok: true,
                      detail: `${force ? "重新" : ""}准备 ${variant} 引擎已在后台开始（下载→sha 校验→解压），完成后引擎列表自动显示已安装；体积大时可能要几分钟`,
                    };
                  },
                  /**
                   * 删除**一个**已下载文件（列表式：点开列表选具体文件删，
                   * 机主 2026-11-05 拍板，不一键清空整个变体）。三道守卫：
                   * 准备中不删；名字必须属于该变体的模式（resolveRuntimeFile
                   * 不猜路径，删不掉列表外的东西）；生效引擎正在用的当前
                   * tag 目录不删（API 层另有一道同语义兜底）。旧 tag 孤儿与
                   * zip 可以删——那正是这功能要清理的东西。
                   */
                  release: async (variant: RuntimeVariant, name: string): Promise<RuntimeAction> => {
                    if (preparingVariants.has(variant)) {
                      return { ok: false, detail: `${variant} 正在后台准备中，等它结束再删` };
                    }
                    const target = resolveRuntimeFile(variant, name);
                    if (!target) {
                      return { ok: false, detail: `不认识的文件：${name}` };
                    }
                    if (variant === runningVariant() && name === path.basename(effectiveRuntimeDirPath(variant))) {
                      return {
                        ok: false,
                        detail: "这是当前生效引擎正在使用的文件：先在下拉里切走，再删除它",
                      };
                    }
                    try {
                      rmSync(target.path, { recursive: target.kind === "directory", force: true });
                      return { ok: true, detail: `已删除 ${name}` };
                    } catch (error) {
                      return {
                        ok: false,
                        detail: `删除失败（可能仍被占用）：${error instanceof Error ? error.message : String(error)}`,
                      };
                    }
                  },
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
        "index unavailable (reason logged above) -- capture continues, search will not work",
      );
    }

    /**
     * Index files the write path rewrote in full: a session snapshot every turn,
     * and `MEMORY.md` after a promotion round.
     *
     * A snapshot rewrites its whole file every turn, so the previous turn's units
     * must go; re-reading and re-chunking is also what an appended daily file
     * needs (see `indexAppended`). Never throws: the index is derived data, and a
     * failed update is repaired by `memory_reindex` without the user needing to
     * know it happened.
     *
     * `autoEmbed` queues the file for the background pass. It is safe on every
     * full-file write, snapshots included: `embedMissing` only fills chunks
     * whose vector is zero-length (auto-embed.ts says so), so an unchanged
     * settle costs one indexed query and no embed call — the old fear that
     * auto-embedding would re-embed the same transcript every turn was wrong,
     * and skipping it let changed snapshots accumulate missing vectors until
     * the next startup's repair (641 chunks, 11 min, 2026-11-05).
     */
    const indexReplaced = async (
      files: readonly string[],
      options?: { readonly autoEmbed?: boolean },
    ): Promise<void> => {
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
          // Snapshots only ever reach the index through this call, so this is the only
          // place their provenance can be recorded. Without it every snapshot document
          // is stored with a NULL provenance class and the trigger-injection gate
          // (`isPromotedTrustedMemoryEntry`) rejects all of them.
          memoryHome: memoryHomeDir(),
          // The chunks are only eligible for vectors if they carry the same model
          // string the embed/search passes use; `indexWrittenFile` defaults to
          // fts-only when this is omitted.
          model: modelConfig.embedderId,
          log,
        });
        if (written > 0) {
          log(`indexed ${written} unit(s) from ${file}`);
          if (options?.autoEmbed) scheduleAutoEmbed(file);
        }
      }
    };

    /**
     * Index a file the write path just appended to.
     *
     * This used to take a tail-only path (`indexTail` -> `indexAppendedTail`), and
     * that path never classified provenance: `indexDocument` then stored the
     * document as `untrusted` (`upstreamProvenance(undefined)`), which the
     * promotion gate rejects. Every captured daily entry was therefore ineligible
     * the moment it was written, and `MEMORY.md` could never be produced no matter
     * how often an entry was recalled.
     *
     * It now goes through the same full re-index as a replaced file, which is
     * upstream's shape anyway: a chunk's identity is a hash over its text and
     * span, so there is no stable way to add only the new fragments, and upstream
     * clears `(path, source)` and re-chunks the whole file for an append too. One
     * capture re-chunks its whole day file; that file is a day, not `MEMORY.md`.
     */
    const indexAppended = async (file: string): Promise<void> => {
      if (!index) return;
      const written = await indexWrittenFile({
        db: index,
        file,
        root: "home",
        project: homeProjectSlug(file),
        // The write path records provenance for every artifact it writes; without
        // the home the classifier is never consulted and the document is stored
        // with no provenance at all.
        memoryHome: memoryHomeDir(),
        // Same reason as `indexReplaced`: without the model the chunks are written
        // fts-only and no embed pass will ever select them.
        model: modelConfig.embedderId,
        log,
      });
      if (written > 0) {
        log(`indexed ${written} new unit(s) from ${file}`);
        // The capture is searchable by keyword immediately; let the background
        // pass make the same chunks searchable by meaning too.
        scheduleAutoEmbed(file);
      }
    };

    /**
     * Index the daily files a capture sweep wrote.
     *
     * Both the per-turn sweep and the startup drain write through
     * `capture.runSweep`; without this, a capture recovered at startup was
     * written to disk but never indexed, so it stayed invisible until the next
     * reindex -- and never reached the automatic embed pass either.
     */
    const indexCapturedOutcomes = async (
      outcomes: readonly CaptureOutcome[],
    ): Promise<void> => {
      for (const outcome of outcomes) {
        if (outcome.kind !== "captured" || !outcome.relativePath) continue;
        // `relativePath` is the pipeline's own key (`memory/<day>.md`), relative
        // to the project it came from. The file lives in this window's slice of
        // the home, so use the key's day rather than today's date.
        const day = path.basename(outcome.relativePath, ".md");
        await indexAppended(path.join(homeProjectMemoryDir(workspaceDir), `${day}.md`));
      }
    };

    const controller = new AbortController();
    const settleTimers = new Map<string, ReturnType<typeof setTimeout>>();
    let closed = false;

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
      if (closed || flushInFlight) return;
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

    // Inject bootstrap files into the session system prompt -- the same mechanism
    // openclaw uses for its embedded agents. Reads go through upstream's identity
    // cache (`readContextFile`): an edit between turns is picked up on the next
    // model request, while an unchanged file costs a stat instead of a re-read.
    //
    // The five instruction files are the user's own and stay in the project;
    // MEMORY.md is openclaw's home file, so it is read from the memory home and
    // appended last (canonical order). It only exists once dreaming has
    // promoted something into it, so absence is the normal state and is not a
    // `[MISSING]` worth showing the model.
    //
    // Its entries are filtered by this session's active repository keys before they
    // reach the prompt. Without a session id there is no way to know what is in scope,
    // so nothing is injected -- see `filterProjectScopedCuratedContext`.
    const DEFAULT_MEMORY_FILENAME = "MEMORY.md";
    const instructionFileNames = BOOTSTRAP_FILENAMES.filter(
      (name) => name !== DEFAULT_MEMORY_FILENAME,
    );
    // One-shot, not per request: see the branch in the hook below. The `context` hook
    // fires on every model request, and a missing session id is a property of how the
    // host wired the hook rather than of any one turn.
    let warnedMissingSessionID = false;
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

    await ctx.session.hook("context", async (event) => {
      const sessionID = (event as { sessionID?: string }).sessionID;
      try {
        const files = await loadBootstrapContextFiles(workspaceDir, instructionFileNames, log);
        const homeMemoryPath = path.join(memoryHomeDir(), DEFAULT_MEMORY_FILENAME);
        if (typeof sessionID === "string" && sessionID.length > 0) {
          // Upstream's `filterProjectScopedCuratedContextFiles`, applied to the file
          // rather than to a provider's hits. Entries carrying `<!-- project: ... -->`
          // keys survive only when every key is active for this session; unannotated
          // ones stay, because upstream defines an unannotated entry as global.
          //
          // This is the seam the cross-session leak actually crossed. Dropping this
          // filter is what let a curated entry written while working in one repository
          // sit verbatim in the system prompt of a session working in another.
          await prepareActiveProjectKey(sessionID, workspaceDir);
          try {
            // Through upstream's identity cache (`readContextFile`): a stat per model
            // request, a read only when the file actually changed.
            const rawMemory = await readContextFile(homeMemoryPath);
            // Upstream's #45415 -- a global MEMORY.md past the injection budget was
            // silently cut mid-entry. The whole file used to ride into the prompt
            // unfiltered here; now it is fitted the same block-safe way the
            // workspace files are (see `fitCuratedToBudget`).
            const memoryContent =
              rawMemory === undefined
                ? ""
                : fitCuratedToBudget(
                    DEFAULT_MEMORY_FILENAME,
                    filterProjectScopedCuratedContext(rawMemory, activeProjectKeys(sessionID)),
                    log,
                  );
            if (memoryContent.trim().length > 0) {
              files.push({
                name: DEFAULT_MEMORY_FILENAME,
                path: homeMemoryPath,
                content: memoryContent,
              });
            }
          } catch {
            // No global long-term memory yet; nothing to inject. The normal state for
            // a fresh install, and expected until dreaming promotes something -- so it
            // stays silent, unlike the case below.
          }
        } else if (!warnedMissingSessionID) {
          // This branch is mem-plus-specific and was previously silent. Upstream cannot
          // reach it: `prepareAgentPromptProjects` takes `sessionId` as a required
          // parameter (`prompt-projects.ts:6`), so there is no "no session id" state to
          // arrive with. Here the host's `context` event carries an optional
          // `sessionID`, and when it is absent every curated entry would be unfiltered
          // -- so the whole file is withheld instead. That is the right call (see
          // `filterProjectScopedCuratedContext`), but it must not be invisible: the
          // symptom is all long-term memory silently disappearing from every prompt.
          // openclaw's convention on this path is to warn and carry on
          // (`bootstrap-files.ts:254`), so this does too, once per process.
          warnedMissingSessionID = true;
          log(`${DEFAULT_MEMORY_FILENAME} withheld: context hook carried no session id`);
        }
        const lines = buildProjectContextSection(files);
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
        // 2026-11-08：领取代次必须原子。原先是"读 marker → 写 marker"，两个
        // 窗口同时跨过日界时都读到昨天，于是各跑一遍 sweep、各写一篇日记
        // （DREAMS.md 里同一天两篇的成因）。现在读与写都在同一个文件锁里，
        // 只有一个窗口能把 marker 从昨天改成今天，另一个直接返回。锁只罩住
        // "读 + 改"，不罩 sweep 本身：sweep 要调模型，可达分钟级，占锁会挡住
        // 另一个窗口的正常写入。中途崩溃仍按原语义"当天不再重试"。
        const { mkdir } = await import("node:fs/promises");
        await mkdir(path.dirname(marker), { recursive: true });
        const claimed = await withMemoryFileLock(marker, async () => {
          const fs = await import("node:fs/promises");
          let last = "";
          try {
            last = (await fs.readFile(marker, "utf8")).trim();
          } catch {
            // First run: no marker yet, treat as a new day.
          }
          if (last === today) return false;
          // Record the attempt first so a failed sweep does not retrigger every turn.
          await fs.writeFile(marker, today, "utf8");
          return true;
        });
        if (!claimed) return;

        // STAGE 2: consolidation's model call also moves to the user's OpenCode model, so
        // it no longer waits on `localService.ready()` -- a promotion round used to be
        // skipped entirely whenever the local model was down, even though a model was
        // available. `completeThroughHost` never throws, so a failure here is turned back
        // into a rejection: upstream's `applyShortTermPromotions` catches a consolidation
        // failure and degrades, and it can only do that if something throws.
        const subagent = {
          complete: async ({
            message,
            extraSystemPrompt,
          }: {
            message: string;
            extraSystemPrompt?: string;
          }) => {
            const result = await completeThroughHost(
              ctx,
              {
                purpose: "promotion consolidation",
                prompt: message,
                ...(extraSystemPrompt ? { systemPrompt: extraSystemPrompt } : {}),
                ...(modelConfig.hostedModel ? { model: modelConfig.hostedModel } : {}),
              },
              log,
            );
            if (result.text === null) throw new Error(result.reason);
            return { text: result.text };
          },
        };
        // light -> REM -> deep, in that order, inside one trigger. Upstream's
        // `runShortTermDreamingPromotion` runs `runDreamingSweepPhases` at
        // `dreaming.ts:166` and only ranks/applies at `:195`/`:221`, so deep is
        // strictly last and reads the same `sweepNowMs`. A sweep that throws hits
        // `continue` at `dreaming.ts:183` and skips deep for that workspace; the
        // catch below reproduces that, since the home is a single workspace.
        //
        // This used to run promotion first, on the claim that deep's output feeds
        // the sweep. Upstream has no such dependency -- nothing light or REM do
        // reaches MEMORY.md -- so the old order was a local invention that
        // inverted the phases. `docs/memory-chain.md` §3 had it right all along.
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
          // light+REM is what this sweep runs; deep is the promotion round below,
          // not a third phase here.
          `dreaming sweep done: light+rem over ${memoryHomeDir()} ` +
            `(degradedPhases=${result?.degradedPhases ?? 0}, pendingNarratives=${result?.pendingNarratives ?? 0})`,
        );

        // Self-generated rehearsal is a human-review DREAMS.md pass. It stays
        // curated-free: QA pairs are never promoted directly into MEMORY.md.
        const rehearsal = await runSelfGeneratedRehearsalRound({
          ctx,
          memoryHome: memoryHomeDir(),
          ...(modelConfig.hostedModel ? { model: modelConfig.hostedModel } : {}),
          log,
          nowMs: now,
        });
        if (rehearsal.retained > 0) {
          log(
            `dreaming rehearsal: kept ${rehearsal.retained}/${rehearsal.generated} QA pair(s) ` +
              `from ${rehearsal.candidates} candidate(s)`,
          );
        } else if (!rehearsal.skipped) {
          log("dreaming rehearsal: no retained QA pairs");
        } else if (rehearsal.candidates > 0 && rehearsal.reason) {
          log(`dreaming rehearsal skipped: ${rehearsal.reason}`);
        }

        // deep: episodic -> curated. Reached only when the sweep returned, matching
        // upstream's `continue` on sweep failure.
        const promotion = await runPromotionRound({
          memoryHome: memoryHomeDir(),
          options,
          subagent,
          log,
          nowMs: now,
          // Phase 2 item 3: semantic-reward veto between the deterministic gates and
          // the write. Fail-open -- without an answering strong model this reduces to
          // the Phase-1 behaviour exactly (companion-plan §5 decision 2).
          reward: async (candidates) => {
            const gated = await applySemanticRewardGate({
              ctx,
              ...(modelConfig.hostedModel ? { model: modelConfig.hostedModel } : {}),
              candidates,
              log,
            });
            if (!gated.outcome.skipped) {
              log(
                `promotion: semantic reward kept ${String(gated.keep.length)}/${String(gated.outcome.candidates)} ` +
                  `candidate(s) (${String(gated.outcome.vetoed)} delayed, ` +
                  `${String(gated.outcome.scored)} scored)`,
              );
            } else if (gated.outcome.candidates > 0 && gated.outcome.reason) {
              log(`promotion: semantic reward skipped: ${gated.outcome.reason}`);
            }
            return gated.keep;
          },
        });
        if (promotion && promotion.applied > 0) {
          log(
            `promotion: applied ${promotion.applied}/${promotion.candidates} candidate(s) ` +
              `into MEMORY.md (${promotion.rejected} rejected)`,
          );
          // Promotion rewrites MEMORY.md in place, and nothing re-indexed it: the
          // file is only discovered by a full scan, so lane 1c
          // (`listTriggerCandidates`) and `memory_search` kept serving the
          // pre-promotion text until the next `memory_reindex`. Index it here,
          // through the same path as every other full-file write. This is a
          // once-a-day long-term write, so let the background pass embed it too;
          // per-turn snapshots also embed, but only their missing chunks (see
          // `indexReplaced` below).
          await indexReplaced([path.join(memoryHomeDir(), DEFAULT_MEMORY_FILENAME)], {
            autoEmbed: true,
          });
        }
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
