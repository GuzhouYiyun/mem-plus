// The background embedder repair pass, and its per-process single-flight state.
//
// Extracted from `index.ts` (where it was three loose pieces: a module-level
// flag pair, a 110-line `repairEmbedder`, and a closure rebuilding the
// single-flight runner on every call). The logic is moved verbatim; the only
// addition is `startEmbedderRepair` / `startEmbedderRepairOnce`, which are the
// closure and the flag check with their call-site wiring hoisted in.
//
// Why it lives alone: `repairEmbedder` is the one place in the plugin that
// loops model-reindex rounds with its own stall detection, and the two flags
// it depends on are process-global by design -- multiple project windows share
// one index.db, so one repair, not one per window.
import type { DatabaseSync } from "node:sqlite";
import type { RepairOutcome } from "./web/api.js";
import { missingVectorCount, staleEmbedderModels } from "./memory-index.js";
import type { RetrievalTools } from "./memory-tools.js";

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

export type EmbedderRepairParams = {
  readonly db: DatabaseSync;
  readonly retrieval: RetrievalTools;
  readonly embedderId: string;
  readonly serviceReady: () => Promise<boolean>;
  readonly log: (message: string, detail?: unknown) => void;
};

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
async function repairEmbedder(params: EmbedderRepairParams): Promise<RepairOutcome> {
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

/**
 * One repair at a time, process-wide. A second caller gets the in-flight
 * promise rather than a second pass (see `embedderRepairInFlight` above).
 */
export function startEmbedderRepair(params: EmbedderRepairParams): Promise<RepairOutcome> {
  if (embedderRepairInFlight) return embedderRepairInFlight;
  let pending: Promise<RepairOutcome>;
  pending = repairEmbedder(params).finally(() => {
    if (embedderRepairInFlight === pending) embedderRepairInFlight = null;
  });
  embedderRepairInFlight = pending;
  return pending;
}

/** Auto-trigger entry: the first window with real work starts it, once. */
export function startEmbedderRepairOnce(params: EmbedderRepairParams): void {
  if (embedderRepairStarted) return;
  embedderRepairStarted = true;
  void startEmbedderRepair(params).catch((error) => params.log("embedder repair failed", error));
}
