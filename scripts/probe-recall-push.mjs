// 校准探针:相关性记忆推送通道（recall-push.ts）。
// 动机:上游两条召回通道都要求"拉"（trigger 词面命中 / 回忆意图）；本通道按相关性
// 每轮推,门槛宁漏不错推。探针量的是:同一会话连续推会不会重复（防重复）、服务冷
// 是否静默、嵌入失败是否静默、阈值是否能分离正例/反例。
// 运行:node scripts/probe-recall-push.mjs [http://127.0.0.1:4748]
// 探针只读探活;语料写在临时目录,不碰活区。XDG_CONFIG_HOME 重定向到临时目录。
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const BASE = process.argv[2] ?? "http://127.0.0.1:4748";
// 转译闭包（tsc 出来的镜像树），不是源码树：源码里 `.js` 说明符指向 `.ts`，
// node 直跑加载不了。构建见 docs/port-plan.md 直驱配方。
const ROOT = process.env["RPUSH_BUILD"] ?? path.join(tmpdir(), "opencode", "rpush-build");
const PLUGIN = path.join(ROOT, "plugin", "src");
const TEMP = mkdtempSync(path.join(tmpdir(), "recall-push-cal-"));
process.env["XDG_CONFIG_HOME"] = TEMP;
const MODEL = process.env["RECALL_PUSH_MODEL"] ?? "bge-m3@llamacpp";
const HOME = path.join(TEMP, "opencode", "mem-plus", "workspace");
const PROJECT = path.join(HOME, "memory", "proj");

const logLines = [];
const log = (message, detail) => logLines.push(String(detail ?? detail === "" ? `${message}: ${detail}` : message));

function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

async function fetchJson(url, body) {
  const response = await fetch(url, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
  if (!response.ok) throw new Error(`POST ${response.status}`);
  return response.json();
}

const memoryFiles = [
  ["push-a.md", `## 部署脚本\n\n项目部署脚本在 scripts/deploy.sh，使用 bash。改配置前先看脚本参数。\n`, "部署脚本的配置在 deploy.sh，改配置前先看参数。"],
  ["push-b.md", `## 向量服务\n\nbge-m3 走本地 llama.cpp，端口 4748，电池上暂停。\n`, "向量服务端口是多少？"],
  ["push-c.md", `## 插件装载\n\nmem-plus 装到 ~/.config/opencode/plugins/mem-plus，装载日志看 mem-plus.log。\n`, "插件装载失败时看什么日志？"],
  ["push-d.md", `## 会话数据库\n\nopencode.db 是 SQLite WAL，先 VACUUM INTO 快照再读。\n`, "会话数据库怎么读不撕裂？"],
  ["push-e.md", `## NSIS 安装包\n\n安装器用 NSIS MUI2，升级按 SHA-256 只删差异文件。\n`, "安装器升级时怎么避免误删用户文件？"],
  ["push-f.md", `## 免费档\n\n免费模型 UA 要求 semver ≥1.18.0，会话 id 只验格式。\n`, "免费档为什么报 403？"],
];

const positives = [
  "改下部署脚本的配置吧",
  "把 deploy.sh 里的参数换一下",
  "向量服务的端口是多少来着",
  "插件装载失败要查哪个日志",
  "opencode.db 是 WAL，怎么读才安全",
  "NSIS 安装包升级会删用户文件吗",
];
const negatives = [
  "修一下登录页的样式 bug",
  "今天天气不错，写首诗",
  "给这个函数加个单元测试",
  "把 README 的错别字改掉",
  "解释一下这个正则表达式",
  "帮我查一下 npm 包的版本",
  "把 CSS 的颜色变量统一一下",
  "这个报错的堆栈是什么意思",
  "创建一个新的分支并提交",
  "把接口文档更新一下",
];

async function build() {
  mkdirSync(PROJECT, { recursive: true });
  for (const [name, content] of memoryFiles) writeFileSync(path.join(PROJECT, name), content, "utf8");
  const mod = await import(pathToFileURL(path.join(ROOT, "rpush.mjs")).href);
  const { openIndex, writeSourceChunks, hashText } = mod;
  const db = openIndex({ log });
  if (!db) throw new Error("openIndex returned null");
  const embeds = new Map();
  const chunks = [];
  for (const [name, content, query] of memoryFiles) {
    const rows = db.prepare("SELECT id FROM memory_index_chunks WHERE path = ? AND source = 'memory'").all(name);
    const result = writeSourceChunks({
      db,
      relativePath: `memory/proj/${name}`,
      source: "memory",
      content,
      hash: hashText(content),
      bytes: Buffer.byteLength(content),
      mtime: Date.now(),
      provenance: { originClass: "owner", sessionKind: "interactive", observedAt: Date.now() },
      model: MODEL,
    });
    chunks.push({ name, query, result });
  }
  const all = db.prepare("SELECT id, text FROM memory_index_chunks WHERE source = 'memory' ORDER BY id").all();
  for (const row of all) embeds.set(row.id, row.text);
  return { db, embeds };
}

async function main() {
  let db;
  let embeds;
  try {
    ({ db, embeds } = await build());
  } catch (error) {
    console.error("build failed:", error);
    process.exitCode = 1;
    return;
  }
  try {
  const { createRecallPushLane, search, storeVector } = await import(pathToFileURL(path.join(ROOT, "rpush.mjs")).href);
  // 1) 服务冷:URL 无效,probeService 不 spawn,应静默。
  const cold = createRecallPushLane({ service: { url: "http://127.0.0.1:1", host: "127.0.0.1", port: 1, autostart: false, idleMinutes: 0, startTimeoutMs: 0 }, model: MODEL, options: {}, log });
  const coldOut = await cold.evaluate({ db, sessionID: "s-cold", message: positives[0], activeProjectKeys: ["proj"] });
  console.log(`cold service: ${coldOut === undefined ? "quiet" : "UNEXPECTED BLOCK"}`);
  if (coldOut !== undefined) process.exitCode = 1;

  // 2) 嵌入失败:服务端口有东西但不返回向量,应静默且不挂。
  const broken = createServer((req, res) => {
    res.writeHead(500);
    res.end("{}");
  }).listen(0, "127.0.0.1");
  await new Promise((resolve) => broken.once("listening", resolve));
  const brokenPort = broken.address().port;
  const badLane = createRecallPushLane({ service: { url: `http://127.0.0.1:${brokenPort}`, host: "127.0.0.1", port: brokenPort, autostart: false, idleMinutes: 0, startTimeoutMs: 0 }, model: MODEL, options: {}, log });
  const badOut = await badLane.evaluate({ db, sessionID: "s-bad", message: positives[0], activeProjectKeys: ["proj"] });
  broken.close();
  console.log(`embed failure: ${badOut === undefined ? "quiet" : "UNEXPECTED BLOCK"}`);
  if (badOut !== undefined) process.exitCode = 1;

  // 3) 有向量的语料:用 /embed 的真实向量建索引,再跑阈值扫描与同会话去重。
  const live = await fetch(`${BASE}/health`).then((r) => r.json()).catch(() => null);
  if (!live?.ok) {
    console.log(`embed service unavailable at ${BASE}; threshold sweep skipped`);
    return;
  }
  const embed = async (text) => (await fetchJson(`${BASE}/embed`, { input: text })).vector;
  for (const [id, text] of embeds) {
    const vector = await embed(text);
    // 必须走 storeVector:持久向量是 little-endian float64(encodeMemoryEmbedding),
    // 手写 Float32Array 会让 decodeMemoryEmbedding 返回 [](长度不是 8 的倍数)。
    storeVector({ db, chunkId: id, model: MODEL, vector });
  }
  const scores = new Map();
  let posPushed = 0;
  let negPushed = 0;
  for (const message of [...positives, ...negatives]) {
    const vector = await embed(message);
    const hits = await search({ db, query: message, mode: "hybrid", filters: {}, limit: 8, currentProject: "proj", queryVector: vector, model: MODEL, log });
    const top = hits[0]?.score ?? 0;
    scores.set(message, { top, hits: hits.length });
    const isPositive = positives.includes(message);
    if (top >= 0.45) isPositive ? posPushed++ : negPushed++;
    console.log(`${top >= 0.45 ? "PUSH" : "quiet"} ${top.toFixed(3)} ${message} (${hits.length} hits)`);
  }
  console.log(`summary@0.45: positives pushed ${posPushed}/${positives.length}, negatives pushed ${negPushed}/${negatives.length}`);
  for (const message of positives) {
    const vector = await embed(message);
    const hits = await search({ db, query: message, mode: "hybrid", filters: {}, limit: 8, currentProject: "proj", queryVector: vector, model: MODEL, log });
    const eligible = hits.filter((hit) => (hit.score ?? 0) >= 0.45 && hit.provenance?.originClass === "owner").length;
    console.log(`eligible ${message}: ${eligible}`);
  }
  const realLane = createRecallPushLane({ service: { url: BASE, host: "127.0.0.1", port: 4748, autostart: false, idleMinutes: 0, startTimeoutMs: 0 }, model: MODEL, options: {}, log });
  const first = await realLane.evaluate({ db, sessionID: "s-real", message: positives[0], activeProjectKeys: ["proj"] });
  const second = await realLane.evaluate({ db, sessionID: "s-real", message: positives[0], activeProjectKeys: ["proj"] });
  const other = await realLane.evaluate({ db, sessionID: "s-other", message: positives[0], activeProjectKeys: ["proj"] });
  console.log(`same session repeat: ${first && !second ? "first block, second quiet" : "UNEXPECTED"}`);
  console.log(`different session: ${other ? "new block" : "quiet"}`);
  if (!first || second || !other) process.exitCode = 1;
  realLane.clear();

  // 4) 装配:prompt 钩子决定、context 钩子交付。四条路径:
  //    a) 无回忆意图 → deep 给 skip 前缀 → 推送块交付;
  //    b) 有回忆意图、无 lane-2 工具 → deep 给 unavailable → 不推(deep 已发言);
  //    c) lane-1 强命中 → trigger 块交付、deep 让路 → 不推;
  //    d) recall.mode="off" → deep 仍返回 skip 前缀 → 推送照跑(记录在案的行为)。
  const mod = await import(pathToFileURL(path.join(ROOT, "rpush.mjs")).href);
  const { installMemoryInjection, buildRecallOutcomePrefix, writeSourceChunks, hashText } = mod;
  const PUSH_MARK = "reference context retrieved from the memory system";
  const hooks = new Map();
  const fakeCtx = {
    session: {
      hook: (name, cb) => {
        hooks.set(name, cb);
        return { dispose: async () => {} };
      },
    },
  };
  const fire = async (sessionID, text) => {
    await hooks.get("prompt")({ sessionID, prompt: { text }, messageID: `${sessionID}-m1` });
    const system = [];
    await hooks.get("context")({ sessionID, system });
    return system;
  };
  const hasText = (system, needle) =>
    system.some((p) => typeof p?.text === "string" && p.text.includes(needle));
  const expect = (cond, label) => {
    console.log(`${cond ? "PASS" : "FAIL"} ${label}`);
    if (!cond) process.exitCode = 1;
  };

  // lane-1 语料:curated 触发注解。两个字面要求:路径必须是 MEMORY.md(生产
  // memoryRelativePath 去掉 memory/ 前缀后的输出,trigger 候选查询按字面比对);
  // 注解必须在标题之后 —— chunkMarkdown 的 entryStartLine 是标题行,标题前的
  // 注解落在 span 外,extractCuratedEntryRecallMetadata 取不到(triggers 存 null)。
  const memContent = `## 部署\n<!-- trigger: deploy script -->\n部署脚本是 scripts/deploy.sh。\n`;
  writeSourceChunks({
    db,
    relativePath: "MEMORY.md",
    source: "memory",
    content: memContent,
    hash: hashText(memContent),
    bytes: Buffer.byteLength(memContent),
    mtime: Date.now(),
    provenance: { originClass: "owner", sessionKind: "interactive", observedAt: Date.now() },
    model: MODEL,
  });

  const lane2 = createRecallPushLane({ service: { url: BASE, host: "127.0.0.1", port: 4748, autostart: false, idleMinutes: 0, startTimeoutMs: 0 }, model: MODEL, options: {}, log });
  const injection = await installMemoryInjection({ ctx: fakeCtx, db, workspaceDir: HOME, log, recallPush: lane2 });

  // a) 无回忆意图。
  const a = await fire("s-asm-a", positives[0]);
  expect(hasText(a, "intentionally skipped deep recall"), "a deep declined with skip note");
  expect(hasText(a, PUSH_MARK), "a push block delivered");

  // b) 有回忆意图("what did we decide ..."),不撞 deploy/script 触发词。
  const b = await fire("s-asm-b", "what did we decide about the release notes");
  expect(hasText(b, "could not retrieve memory"), "b deep fired (unavailable, no tools)");
  expect(!hasText(b, PUSH_MARK), "b no push when deep spoke");

  // c) lane-1 强命中:deploy + script 双词命中 → matchScore ≥0.8。
  const c = await fire("s-asm-c", "check the deploy script status");
  expect(hasText(c, "scripts/deploy.sh"), "c trigger block delivered");
  expect(!hasText(c, PUSH_MARK), "c no push on strong lane-1 hit");

  await injection.dispose();

  // d) mode="off"。第二次 install 覆盖同一 fake ctx 的钩子回调。
  const off = await installMemoryInjection({
    ctx: fakeCtx,
    db,
    workspaceDir: HOME,
    log,
    recallPush: lane2,
    options: { recall: { mode: "off" } },
  });
  const d = await fire("s-asm-d", positives[0]);
  expect(hasText(d, "intentionally skipped deep recall"), "d mode-off deep declines");
  expect(hasText(d, PUSH_MARK), "d push runs on mode-off (recorded behaviour)");
  await off.dispose();
  lane2.clear();
  } finally {
    db.close();
  }
}

try {
  await main();
} finally {
  try {
    rmSync(TEMP, { recursive: true, force: true });
  } catch (error) {
    // Windows 下 SQLite 句柄/杀软可能还占着;清理失败不影响结论。
    console.error(`temp cleanup failed: ${error.message}`);
  }
}
