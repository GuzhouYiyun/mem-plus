// Recall-intent 嵌入兜底门 —— 上游正则门落空时的第二判据。
//
// 为什么存在（memory-chain §Lane 2；docs/port-plan.md 2026-11-08 校准节）：
//   上游 escalation.ts 的 zh-Hans 组实测 13 题只中 4；翻译门（曾为本树插件
//   recall-intent.ts）2026-11-04 已撤——它把一次远端模型调用放上每条消息的
//   关键路径。本门是第三条路：本地 bge-m3 嵌入一次消息（实测 p50≈69ms /
//   p95≈76ms，GPU 常驻，不走网络、不生成），与冻结例句库比 cosine。
//   escalation.ts 保持逐字节不动；正则命中的消息到不了这里。
//
// 判据（scripts/probe-recall-gate.mjs 校准，例句库 41 / 锚点 12 / 测试正例 24 /
//   测试负例 22，例句与测试集分离防背书）：
//   max(exemplar cosine) >= 0.65 且 max(exemplar) >= max(anchor)
//   —— 锚点库是现在时/操作型句式，用来挡「这段代码是干什么的」这类与回忆句
//   在嵌入空间天然接近的提问（纯 max 0.65 时它是唯一误报；对比分归零）。
//   实测 22/24 召回（zh 16/18）、0/22 误报。漏的两条是长复合句（0.566/0.610），
//   宁漏不误召：误召的代价是每条普通消息多注入一段无关记忆。
//
// 关键路径纪律（这是撤翻译门的教训，不是建议）：
//   - 绝不自启服务：URL 只来自 probeService（只读探测）；探测不到 = 门静默。
//   - 例句向量在启动时后台 prepare()，缓存落 stateRoot()/intent/exemplars.json，
//     键 = embedderId + 库内容哈希；换模型或改库自动失效重嵌。
//   - 未就绪时 evaluate 立即 false 并踢一次后台 prepare，不等。
//   - 单条嵌入 1200ms 硬超时；超时/失败只回 false，绝不让一轮挂起。
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

import { stateRoot } from "./paths.js";
import { probeService, postJson } from "./model/client.js";
import { embedderIdFor, type ServiceConfig } from "./model/config.js";
import { isBatteryPaused } from "./model/power.js";

/** 高于此且过锚点对比才升级深召回。0.65 是校准拐点：再降 FP 抬头。 */
const THRESHOLD = 0.65;
/** 一次 /embed 的预算。p95 是 76ms，1200ms 已是 15 倍余量，只兜底 GPU 排队。 */
const EMBED_TIMEOUT_MS = 1_200;

// 例句库：上游 14 条英文正则的句式改写 + 各语言回忆问句模板。冻结；改动会
// 使缓存失效并重嵌（哈希键），所以这里必须是内容即版本。
const EXEMPLARS: readonly string[] = [
  // en —— 上游正则句式的自然拼写
  "what did we decide about this?",
  "do you remember when we chose it?",
  "last time we talked about this",
  "previously we agreed on a plan",
  "what did I ask you to do before?",
  "have we discussed this already?",
  "summarize our past conversations",
  "remind me what we picked",
  "where did we leave off?",
  "earlier you said something about this",
  "what was our original goal?",
  "how did we solve this yesterday?",
  // zh —— 上游组漏掉的句式为主（…来着 / 之前…过的疑问形 / 最开始…什么）
  "我们之前聊了什么？",
  "上次我们是怎么决定的？",
  "你还记得我说过什么吗？",
  "我们最开始是要做什么来着？",
  "我最开始让你做的是什么？",
  "之前的方案是哪个来着？",
  "上次我们做了什么？",
  "这个问题以前怎么讨论的？",
  "昨天我们说到哪了，再说一遍",
  "之前测试结果怎么样？",
  "我们选的是哪个模型？",
  "以前的结论还记得吗？",
  "这个我们之前配置过吗？",
  "刚才说的内容是什么？",
  "之前是怎么解决这个问题的？",
  "这类问题以前是怎么处理的？",
  // ja
  "前回何を話しましたか？",
  "覚えていますか？",
  "前にどう決めましたっけ？",
  // ko
  "지난번에 뭐 논의했죠?",
  "기억나세요?",
  // ru
  "что мы обсуждали вчера?",
  "напомни, что мы решили?",
  // es
  "¿qué hablamos antes?",
  "¿recuerdas lo que elegimos?",
  // fr
  "de quoi on a parlé ?",
  "tu te souviens de la dernière fois ?",
  // pt
  "o que a gente discutiu antes?",
  "você lembra o que decidimos?",
];

// 锚点库：现在时/操作型句式。它们和回忆句共享疑问外壳（这是什么/在哪/为什么），
// 对比分把这类提问从门里剔除。同样冻结，同入哈希。
const ANCHORS: readonly string[] = [
  "what is this code doing?",
  "explain what this regex does",
  "how do I configure this option?",
  "where is git installed?",
  "fix the bug in the login page",
  "run the tests and report failures",
  "这段代码是干什么的？",
  "这个函数怎么写的？",
  "为什么构建失败了？",
  "把这个参数改成另一个",
  "这个选项在哪里设置？",
  "今天有什么安排",
];

export type RecallIntentGate = {
  /** 后台预热：探测服务 + 载缓存 / 嵌例句库。可重入，失败留下次再试。 */
  prepare: () => Promise<boolean>;
  /** 正则落空的消息走这里；true = 判为回忆意图，调用方升级深召回。绝不抛。 */
  evaluate: (message: string) => Promise<boolean>;
};

function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

function maxCosine(vector: readonly number[], bank: readonly (readonly number[])[]): number {
  let best = -1;
  for (const e of bank) best = Math.max(best, cosine(vector, e));
  return best;
}

function bankHash(): string {
  return createHash("sha256")
    .update(EXEMPLARS.join("\n") + "\n\u0000\n" + ANCHORS.join("\n"), "utf8")
    .digest("hex")
    .slice(0, 16);
}

function cacheFile(): string {
  return path.join(stateRoot(), "intent", "exemplars.json");
}

type CacheShape = {
  key: { embedderId: string; bank: string };
  exemplars: number[][];
  anchors: number[][];
};

function loadCache(embedderId: string): { exemplars: number[][]; anchors: number[][] } | null {
  try {
    const parsed = JSON.parse(readFileSync(cacheFile(), "utf8")) as CacheShape;
    if (parsed.key?.embedderId !== embedderId || parsed.key?.bank !== bankHash()) return null;
    if (!Array.isArray(parsed.exemplars) || !Array.isArray(parsed.anchors)) return null;
    if (parsed.exemplars.length !== EXEMPLARS.length || parsed.anchors.length !== ANCHORS.length) {
      return null;
    }
    const dim = parsed.exemplars[0]?.length ?? 0;
    if (dim === 0) return null;
    const all = [...parsed.exemplars, ...parsed.anchors];
    if (!all.every((v) => Array.isArray(v) && v.length === dim)) return null;
    return { exemplars: parsed.exemplars, anchors: parsed.anchors };
  } catch {
    return null;
  }
}

function saveCache(embedderId: string, vectors: { exemplars: number[][]; anchors: number[][] }): void {
  try {
    mkdirSync(path.dirname(cacheFile()), { recursive: true });
    const payload: CacheShape = { key: { embedderId, bank: bankHash() }, ...vectors };
    writeFileSync(cacheFile(), JSON.stringify(payload), "utf8");
  } catch (error) {
    // 缓存只是启动加速，写失败下次重嵌，不在关键路径上报错。
  }
}

export function createRecallIntentGate(params: {
  service: ServiceConfig;
  embedModelPath: string;
  log: (message: string, detail?: unknown) => void;
}): RecallIntentGate {
  const embedderId = embedderIdFor(params.embedModelPath);
  let exemplarVecs: readonly (readonly number[])[] | null = null;
  let anchorVecs: readonly (readonly number[])[] | null = null;
  let url: string | null = params.service.url ?? null;
  let preparing: Promise<boolean> | null = null;
  let lastFailureLogged = false;
  let pauseLogged = false;

  async function embedText(text: string): Promise<readonly number[]> {
    if (!url) throw new Error("intent gate: no service url");
    const response = await postJson(`${url}/embed`, { input: text }, EMBED_TIMEOUT_MS);
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`/embed ${response.status}`);
    }
    const vector = (response.json as { vector?: unknown }).vector;
    if (!Array.isArray(vector)) throw new Error("/embed returned no vector");
    return vector as number[];
  }

  async function build(): Promise<boolean> {
    const cached = loadCache(embedderId);
    if (cached) {
      exemplarVecs = cached.exemplars;
      anchorVecs = cached.anchors;
      return true;
    }
    if (!url) return false;
    // 冷嵌 53 条 ≈ 4 s，只在后台跑（prepare 的调用方从不 await 在消息路径上）。
    const texts = [...EXEMPLARS, ...ANCHORS];
    const vectors: number[][] = [];
    for (const text of texts) vectors.push([...(await embedText(text))]);
    const next = {
      exemplars: vectors.slice(0, EXEMPLARS.length),
      anchors: vectors.slice(EXEMPLARS.length),
    };
    exemplarVecs = next.exemplars;
    anchorVecs = next.anchors;
    saveCache(embedderId, next);
    params.log("recall-intent gate: exemplar bank embedded", {
      embedderId,
      count: texts.length,
    });
    return true;
  }

  const prepare = (): Promise<boolean> => {
    if (exemplarVecs && anchorVecs) return Promise.resolve(true);
    if (preparing) return preparing;
    preparing = (async () => {
      try {
        // 电池暂停门（model/power.ts，fail-open）：例句库冷建是 53 条 ≈4 s
        // 的批量 GPU 活，不在电池上烧；`evaluate` 的单条消息嵌入不走这里
        // （热服务上 ~70 ms，放行，且它在消息路径上——这里只拦后台 prepare，
        // 每回合一记日志，不逐条刷）。
        if (await isBatteryPaused(params.service)) {
          if (!pauseLogged) {
            pauseLogged = true;
            params.log(
              "recall-intent gate: paused on battery, exemplar bank deferred (service.pauseOnBattery)",
            );
          }
          return false;
        }
        pauseLogged = false;
        if (!url) {
          const found = await probeService(params.service);
          if (!found) return false;
          url = found.url;
        }
        return await build();
      } catch (error) {
        url = null;
        if (!lastFailureLogged) {
          lastFailureLogged = true;
          params.log("recall-intent gate offline (embed service unreachable)", error);
        }
        return false;
      } finally {
        preparing = null;
      }
    })();
    return preparing;
  };

  return {
    prepare,
    evaluate: async (message: string) => {
      // 未就绪：立刻 false，后台再踢一次 prepare。绝不在关键路径上等例句库。
      if (!exemplarVecs || !anchorVecs || !url) {
        void prepare();
        return false;
      }
      try {
        const vector = await embedText(message);
        const pos = maxCosine(vector, exemplarVecs);
        const anchor = maxCosine(vector, anchorVecs);
        const hit = pos >= THRESHOLD && pos >= anchor;
        if (hit) {
          params.log("recall-intent embed gate: escalate", {
            pos: Number(pos.toFixed(3)),
            anchor: Number(anchor.toFixed(3)),
          });
        }
        return hit;
      } catch (error) {
        // 服务死了：URL 作废，本条 false，后台重探。
        url = null;
        if (!lastFailureLogged) {
          lastFailureLogged = true;
          params.log("recall-intent gate: embed failed, gate off until re-probe", error);
        }
        void prepare();
        return false;
      }
    },
  };
}
