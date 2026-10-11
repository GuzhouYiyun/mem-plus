// mem-plus 推理服务 —— 独立 Node 进程，监听 127.0.0.1:4748。
//
// 为什么必须独立进程
//   node-llama-cpp 加载原生绑定时会 fork 一个子进程做兼容性自检
//   (testBindingBinary.js)。OpenCode 插件运行在 bun 里，`process.execPath`
//   是 opencode 可执行文件而非 node，这个 fork 必然失败，于是绑定加载不了、
//   又没有编译器可以退回源码构建。实测：同环境下独立 node / bun 进程都
//   build=prebuilt 正常，只有嵌在 OpenCode 里失败。
//   所以推理必须离开 bun 进程 —— 本服务就是那个进程。
//
// 为什么是 HTTP 而不是 stdio IPC
//   - 一个模型实例被所有项目共享。四个项目各开一个插件，模型只加载一次。
//   - 用户可以手动起服务（多项目共用、常驻），也可以让插件按需拉起、用完退掉。
//   - 排障时能直接 curl，不用理解插件内部。
//
// 空闲退出
//   模型常驻约 4 GB 内存。不做空闲回收的话，关掉 OpenCode 之后它还在，
//   CPU 和内存都被占着。用 --idle-minutes 控制，默认 10 分钟无请求就自己走。
//
// 用法（一般由插件自动拉起，无需手动执行）：
//   node server.mjs [--port 4748] [--idle-minutes 10] [--content <gguf>] [--embed <gguf>]
//   端口被占用时自动顺延，最多尝试 11 个端口。

import { createServer } from "node:http";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, "..");

/**
 * The `--gpu` value names a class of card, not a backend. Each maps to the
 * backends to try, in order; the ones this machine does not support are filtered
 * out against what node-llama-cpp reports, and if nothing is left the service
 * refuses to start rather than falling back to the CPU (which was removed).
 *
 *   auto        - 独显优先，最后兜底核显
 *   discrete    - 只试独显后端：NVIDIA 走 cuda，Apple 走 metal。这两家都不做核显，
 *                 所以对它们来说"独显"是唯一的可能。两条都不可用就拒绝启动。
 *                 注意：AMD/Intel 的独显走 vulkan，不在这条链上，那种卡用 auto。
 *   integrated  - 只试 vulkan。核显只有它一个后端。
 *
 * `describeGpu` still names the backend that actually won, because that -- not
 * the preference -- is what belongs in the log.
 */
const GPU_PRIORITY = {
  auto: ["cuda", "metal", "vulkan"],
  discrete: ["cuda", "metal"],
  integrated: ["vulkan"],
};

/** Values `--gpu` used to take, when it named a backend. Same map as in
 *  plugin/src/model/config.ts, because this file is also run by hand. */
const LEGACY_GPU = {
  cuda: "discrete",
  vulkan: "integrated",
};

function normalizeGpu(value) {
  if (Object.hasOwn(GPU_PRIORITY, value)) return value;
  return LEGACY_GPU[value] ?? "auto";
}

const LOG_LEVELS = (mod) => ({
  silent: mod.LlamaLogLevel.disabled,
  warn: mod.LlamaLogLevel.warn,
  info: mod.LlamaLogLevel.info,
  debug: mod.LlamaLogLevel.debug,
});

function log(message, detail) {
  const suffix = detail === undefined ? "" : ` :: ${detail instanceof Error ? detail.message : String(detail)}`;
  process.stdout.write(`[mem-plus:serve] ${message}${suffix}\n`);
}

// ---------------------------------------------------------------- 配置

function readArgs(argv) {
  const args = { port: 4748, idleMinutes: 10, gpu: "auto", threads: 0, gpuLayers: "auto", contextSize: 16384, maxTokens: 512, logLevel: "warn" };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    switch (flag) {
      case "--port": args.port = Number(value); i++; break;
      case "--idle-minutes": args.idleMinutes = Number(value); i++; break;
      case "--gpu": args.gpu = value; i++; break;
      case "--threads": args.threads = Number(value); i++; break;
      case "--gpu-layers": args.gpuLayers = value === "auto" ? "auto" : Number(value); i++; break;
      case "--context-size": args.contextSize = Number(value); i++; break;
      case "--max-tokens": args.maxTokens = Number(value); i++; break;
      case "--log-level": args.logLevel = value; i++; break;
      case "--embed": args.embedPath = path.resolve(value); i++; break;
    }
  }
  if (!args.embedPath) args.embedPath = path.resolve(PLUGIN_ROOT, "..", "models", "bge-m3-FP16.gguf");
  return args;
}

const config = readArgs(process.argv.slice(2));

// CPU 推理已移除：旧配置里 gpu=cpu 不再支持，记一条日志后按 auto（独显 > 核显）处理。
if (config.gpu === "cpu") {
  log("gpu=cpu is no longer supported (dedicated > integrated, CPU is not a fallback); using gpu=auto");
  config.gpu = "auto";
}

// ---------------------------------------------------------------- 串行化
// 一个模型一个 context；两次抽取抢同一个 sequence 会交错写 KV cache。
// 互斥链顺带保证模型不会被并发加载两次。

function createMutex() {
  let tail = Promise.resolve();
  return (task) => {
    const run = tail.then(task, task);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}

const runEmbed = createMutex();

// ---------------------------------------------------------------- 模型状态

const state = {
  llama: null,
  backend: "not loaded",
  content: null,
  grammar: null,
  completion: null,
  embed: null,
  lastUsedAt: Date.now(),
};

let nodeLlamaPromise = undefined;

function loadNodeLlama() {
  nodeLlamaPromise ??= import("node-llama-cpp");
  return nodeLlamaPromise;
}

function describeGpu(gpu) {
  if (gpu === "cuda") return "cuda (discrete)";
  if (gpu === "vulkan") return "vulkan (discrete or integrated)";
  if (gpu === "metal") return "metal (apple gpu)";
  if (gpu === false) return "cpu (legacy value; no longer selected)";
  return String(gpu);
}

async function openLlama() {
  const mod = await loadNodeLlama();
  const levels = LOG_LEVELS(mod);
  const supported = new Set(await mod.getLlamaGpuTypes("supported"));
  const preference = normalizeGpu(config.gpu);
  const order = GPU_PRIORITY[preference];
  const candidates = order.filter((gpu) => supported.has(gpu));

  const failures = [];
  for (const gpu of candidates) {
    try {
      const llama = await mod.getLlama({
        gpu,
        logLevel: levels[config.logLevel],
        ...(config.threads > 0 ? { maxThreads: config.threads } : {}),
      });
      state.llama = llama;
      state.backend = describeGpu(llama.gpu);
      log(`llama backend = ${state.backend} build=${llama.buildType}`);
      return llama;
    } catch (error) {
      const reason = error instanceof Error ? error.message.split("\n")[0] : String(error);
      failures.push(`${describeGpu(gpu)}: ${reason}`);
      log(`backend ${describeGpu(gpu)} unavailable, trying next (CPU is not an option)`, reason);
    }
  }

  // Two different dead ends need two different sentences. When the chain was
  // emptied by the *filter* there is no failure text at all -- that is the
  // `discrete` preference on an AMD or Intel card, which offers only cuda and
  // metal and this machine supports neither -- and a message listing an empty
  // failure list explains nothing. So name what was wanted, and name the way out.
  const wanted = order.join(" → ");
  if (candidates.length === 0) {
    // `false` is node-llama-cpp's CPU pseudo-value and it is always in the
    // supported set. Listing it reads as an offer, and it is not one -- the CPU
    // backend was removed -- so it is named as excluded rather than shown.
    const real = [...supported].filter((gpu) => gpu !== false);
    throw new Error(
      `gpu "${preference}" wants [${wanted}] and this machine supports none of them ` +
        `(available: ${real.join(", ") || "none"}; CPU is not an option; try "auto")`,
    );
  }
  throw new Error(`no usable GPU backend (gpu "${preference}" tried [${wanted}]) :: ${failures.join(" | ")}`);
}

async function getEmbedModel() {
  if (state.embed) return state.embed;
  const llama = state.llama ?? (await openLlama());
  if (!existsSync(config.embedPath)) throw new Error(`embed model not found: ${config.embedPath}`);
  const gpuLayers = llama.gpu === false ? 0 : config.gpuLayers;
  const model = await llama.loadModel({ modelPath: config.embedPath, gpuLayers });
  // 记忆块就几 KB，2048 token 足够，不必占 bge-m3 的完整 8192 窗口。
  const contextSize = 2048;
  const context = await model.createEmbeddingContext({ contextSize });
  // Reported so the caller can reject an over-long input instead of letting the
  // model throw. bge-m3 tokenises roughly one token per CJK character and per four
  // latin characters, so the conservative bound is CJK characters: a text of which
  // this many are CJK cannot exceed the context.
  state.embed = { model, context, maxChars: contextSize };
  log(`embedding model loaded: ${config.embedPath}`);
  return state.embed;
}

// ---------------------------------------------------------------- 推理

async function embed(input) {
  const { context } = await getEmbedModel();
  const embedding = await context.getEmbeddingFor(input);
  return embedding.vector;
}

// ---------------------------------------------------------------- HTTP

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readBody(req, limitBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    // 抽取的输入就是一段有界的对话上下文，给个宽松但有限的上限，
    // 免得一个畸形请求把内存吃光。
    if (total > limitBytes) throw new Error(`request body over ${limitBytes} bytes`);
    chunks.push(chunk);
  }
  if (total === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const server = createServer((req, res) => {
  state.lastUsedAt = Date.now();

  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);

  if (req.method === "GET" && url.pathname === "/health") {
    return sendJson(res, 200, {
      ok: true,
      service: "mem-plus",
      port: server.address()?.port ?? null,
      backend: state.backend,
      loaded: { embed: state.embed !== null },
      models: { embed: config.embedPath },
      present: { embed: existsSync(config.embedPath) },
      idleTimeoutMinutes: config.idleMinutes,
      uptimeSeconds: Math.round(process.uptime()),
    });
  }


  if (req.method === "POST" && url.pathname === "/embed") {
    return runEmbed(async () => {
      const body = await readBody(req, 1024 * 1024);
      if (typeof body.input !== "string" || body.input.length === 0) {
        return sendJson(res, 400, { error: "input is required" });
      }
      // Reject an input the context cannot hold, as a 400 naming the limit.
      //
      // Left to the model this surfaces as a 500, which reads as "the service is
      // broken" and makes a caller stop embedding anything at all. A 400 is a
      // statement about this one request, so the caller can skip that unit and
      // continue. Checked against a conservative bound -- bge-m3 costs about a token
      // per CJK character and per four latin ones, so the CJK count is the limit that
      // cannot be exceeded.
      const { maxChars } = state.embed ?? {};
      if (maxChars !== undefined) {
        const cjk = (body.input.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/g) ?? []).length;
        if (cjk > maxChars) {
          return sendJson(res, 400, {
            error: `input is longer than the usable context size (${cjk} CJK characters > ${maxChars} tokens)`,
          });
        }
      }
      const vector = await embed(body.input);
      return sendJson(res, 200, { vector });
    }).catch((error) => sendJson(res, 500, { error: message(error) }));
  }

  return sendJson(res, 404, { error: `no route for ${req.method} ${url.pathname}` });
});

function message(error) {
  return error instanceof Error ? error.message.split("\n")[0] : String(error);
}

// 启动前先确认 GPU 后端：独显 > 核显，CPU 已禁用。任何一层都起不来的话，
// 服务不监听、直接报错退出——插件端看到启动失败会把抽取延后，快照照常写入。
try {
  await openLlama();
} catch (error) {
  // openLlama() 有三种互不相干的失败，其中只有两种跟显卡有关。第三种是
  // node-llama-cpp 这个包根本没装——它在 package.json 的 optionalDependencies
  // 里。安装器每次都会装它（2026-10-12 取消了「本地向量检索依赖」这个可选项），
// 所以走到这个分支基本意味着包在更新过程中被删掉了。
  //
  // 以前这三种都报成 "gpu backend unavailable"，于是 2026-10-11 一次真实的
  // 更新事故里：包被更新过程删掉了，日志却在讲显卡不够。这条消息会把人送去
  // 查驱动、查设备管理器、查 model.gpu——为一个从没落到磁盘上的包。报错的
  // 作用是指出下一步，说错方向比不说更糟。
  //
  // 同时匹配 code 和消息文本：ERR_MODULE_NOT_FOUND 是 Node 动态 import 失败
  // 的标准 code，而 "Cannot find package" 也覆盖打包器改写过的变体。
  const reason = error instanceof Error ? `${error.code ?? ""} ${error.message}` : String(error);
  if (error?.code === "ERR_MODULE_NOT_FOUND" || /cannot find package/i.test(reason)) {
    log("推理依赖未安装：找不到 node-llama-cpp", error);
    log("修复：用安装器重新运行一遍。未安装时全文检索不受影响，向量检索不可用。");
  } else {
    log("gpu backend unavailable; service will not start (discrete > integrated, CPU is not allowed)", error);
  }
  process.exit(1);
}

// 端口被占用就顺延，和 opencode-mem 的做法一致（它用 4747-4757）。
const MAX_PORT_TRIES = 11;
let listeningPort = null;
tryListen(config.port);

function tryListen(port) {
  server.once("error", onListenError);
  server.listen(port, "127.0.0.1", () => {
    listeningPort = port;
    log(`listening on http://127.0.0.1:${port}`);
    log(`model: embed=${config.embedPath}`);
    log(`idle timeout = ${config.idleMinutes} min; gpu priority = ${normalizeGpu(config.gpu)}`);
  });
}

function onListenError(error) {
  const code = error?.code;
  if (code !== "EADDRINUSE") {
    log("failed to start", error);
    process.exit(1);
  }
  const next = (listeningPort ?? config.port) + 1;
  if (next > config.port + MAX_PORT_TRIES - 1) {
    log(`ports ${config.port}-${next - 1} all in use`);
    process.exit(1);
  }
  log(`port ${listeningPort ?? config.port} busy, trying ${next}`);
  tryListen(next);
}

// ---------------------------------------------------------------- 空闲回收

const idleTimer = setInterval(() => {
  if (config.idleMinutes <= 0) return;
  const idleMs = Date.now() - state.lastUsedAt;
  if (idleMs < config.idleMinutes * 60_000) return;
  log(`idle ${Math.round(idleMs / 60000)} min, shutting down`);
  void shutdown(0);
}, 30_000);
idleTimer.unref();

async function shutdown(code) {
  clearInterval(idleTimer);
  try {
    await state.completion?.dispose();
  } catch {}
  try {
    } catch {}
  try {
    await state.embed?.context.dispose();
  } catch {}
  try {
    } catch {}
  try {
    await state.embed?.model.dispose();
  } catch {}
  try {
    await state.llama?.dispose();
  } catch {}
  server.close();
  process.exit(code);
}

process.on("SIGTERM", () => void shutdown(0));
process.on("SIGINT", () => void shutdown(0));

// Windows 上没有 SIGTERM，父进程消失时靠这个兜底。
process.on("message", (msg) => {
  if (msg === "shutdown") void shutdown(0);
});
