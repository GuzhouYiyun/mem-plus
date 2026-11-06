// mem-plus 推理服务 —— 独立 Node 进程，监听 127.0.0.1:4748。
//
// 为什么是独立进程（历史，仍然成立）
//   早期用 node-llama-cpp：它加载原生绑定时会 fork 子进程做兼容性自检，
//   OpenCode 插件跑在 bun 里，`process.execPath` 是 opencode 而非 node，
//   fork 必然失败。所以推理必须离开 bun 进程 —— 本服务就是那个进程。
//   2026-11 起运行时换成官方 llama.cpp 的 `llama-server` 子进程
//   （弃 node-llama-cpp 的原因见 docs/port-plan.md 当日节），
//   "独立进程"这层壳没变，里面多了一层：本服务是 llama-server 的
//   进程管理器 + 反向代理。
//
// 为什么是 HTTP 而不是 stdio IPC
//   - 一个模型实例被所有项目共享。四个项目各开一个插件，模型只加载一次。
//   - 用户可以手动起服务（多项目共用、常驻），也可以让插件按需拉起、用完退掉。
//   - 排障时能直接 curl，不用理解插件内部。
//
// 对外接口与换运行时之前逐字节一致（client.ts 零改动的契约）：
//   GET  /health  -> { ok, service:"mem-plus", port, backend, loaded, models,
//                      present, idleTimeoutMinutes, uptimeSeconds }
//   POST /embed   -> { input: string } -> { vector: number[] }
//   ok:true 的含义也与从前相同 = 后端可用（GPU 运行时已就绪），
//   不是模型已加载；`loaded.embed` 才是模型状态（llama-server 的 /health
//   返回 200 即就绪）。首跑下载运行时发生在监听之前，与旧代码
//   "先开 GPU 再 listen" 同序；下载慢于 client 的 startTimeoutMs 时
//   client 放弃一次，本进程继续下载，下一轮 ready() 扫到即自愈。
//
// 空闲退出
//   模型常驻约几 GB 内存。不做空闲回收的话，关掉 OpenCode 之后它还在，
//   CPU 和内存都被占着。用 --idle-minutes 控制，默认 5 分钟无请求就自己走，
//   连同 llama-server 子进程一起退。
//
// 用法（一般由插件自动拉起，无需手动执行）：
//   node server.mjs [--port 4748] [--idle-minutes 5] [--embed <gguf>]
//   端口被占用时自动顺延，最多尝试 11 个端口。

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, "..");

// ---------------------------------------------------------------- 运行时版本

/**
 * 钉死的官方 llama.cpp nightly 版本，单一来源是本文件旁的 `runtime.json`
 * —— tag 与 asset 名、sha256 一一对应（digest 取自 GitHub API 的 `digest`
 * 字段，b12098 实测 2026-11-04）。`plugin/src/model/config.ts` 读同一个
 * JSON 取 tag（运行时路径与页面状态用），两读者一文件，换版本只改一处。
 * nightly prerelease 才带二进制资产，`latest` release 只有 nightly-tag.txt。
 *
 * asset 文件名不在 JSON 里：`llama-<tag>-bin-win-<variant>-x64.zip` 由
 * tag 和变体拼出，JSON 里的 sha256 才是防漂移的那道锁。
 */
// let 而非 const：「保持最新」的对齐会解析新 nightly 并写回 runtime.json，
// 随后重读替换——tag、资产名、目录名全部跟着走（单源文件，进程内也要换到
// 新值，否则路径还拼旧 tag）。
let RUNTIME = readRuntimeManifest();

function readRuntimeManifest() {
  const file = path.join(HERE, "runtime.json");
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    log(`cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
  if (typeof manifest?.tag !== "string" || !/^b\d+$/.test(manifest.tag)) {
    log(`runtime.json: "tag" must look like "b12098", got ${JSON.stringify(manifest?.tag)}`);
    process.exit(1);
  }
  const vulkan = manifest?.assets?.vulkan;
  if (typeof vulkan?.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(vulkan.sha256)) {
    log("runtime.json: assets.vulkan.sha256 must be 64 lowercase hex chars");
    process.exit(1);
  }
  // cpu 块可选（同 cuda 的规矩）：没有它 cpu 行装不了，vulkan 照跑；给了
  // 就必须是 64 位十六进制 digest + 正整数字节数。
  const cpu = manifest?.assets?.cpu;
  if (cpu !== undefined) {
    const cpuOk =
      typeof cpu?.sha256 === "string" &&
      /^[0-9a-f]{64}$/.test(cpu.sha256) &&
      Number.isInteger(cpu?.sizeBytes) &&
      cpu.sizeBytes > 0;
    if (!cpuOk) {
      log("runtime.json: assets.cpu must be { sha256, sizeBytes } with a 64-hex digest");
      process.exit(1);
    }
  }
  // cuda 块是可选的（老 manifest 没有它照样能跑 vulkan），但给了就必须全对：
  // 文件名段、两个 64 位十六进制 digest、两个正整数字节数。半对的 manifest
  // 会让下载校验在半夜才炸，宁可启动时就退出。
  const cuda = manifest?.assets?.cuda;
  if (cuda !== undefined) {
    const shapeOk =
      typeof cuda?.variant === "string" &&
      /^[a-z0-9][a-z0-9.-]*$/.test(cuda.variant) &&
      typeof cuda?.sha256 === "string" &&
      /^[0-9a-f]{64}$/.test(cuda.sha256) &&
      Number.isInteger(cuda?.sizeBytes) &&
      cuda.sizeBytes > 0 &&
      typeof cuda?.cudartSha256 === "string" &&
      /^[0-9a-f]{64}$/.test(cuda.cudartSha256) &&
      Number.isInteger(cuda?.cudartSizeBytes) &&
      cuda.cudartSizeBytes > 0;
    if (!shapeOk) {
      log('runtime.json: assets.cuda must be { variant, sha256, sizeBytes, cudartSha256, cudartSizeBytes } with 64-hex digests');
      process.exit(1);
    }
  }
  return manifest;
}

/** asset 文件名：官方命名 `llama-<tag>-bin-win-<variant>-x64.zip`。 */
function runtimeAssetFile(variant) {
  return `llama-${RUNTIME.tag}-bin-win-${variant}-x64.zip`;
}

/** CUDA 的第二个包：官方把 cudart 拆成独立 zip（`cudart-llama-bin-win-<variant>-x64.zip`）。 */
function cudartAssetFile(variant) {
  return `cudart-llama-bin-win-${variant}-x64.zip`;
}

/**
 * 变体键（vulkan|cuda|cpu，配置与 --variant 用的短键）→ 官方发布用的变体串。
 * Vulkan 与 CPU 恰好键名即串名；CUDA 的文件名带官方版本（runtime.json
 * `assets.cuda.variant`，如 cuda-13.4），所以键与串必须分开一层。
 */
function releaseVariantString(key) {
  if (key === "cuda") return RUNTIME.assets.cuda?.variant ?? "cuda";
  if (key === "cpu") return "cpu";
  return "vulkan";
}

/**
 * `--gpu` 的三档偏好在此收敛为变体列表。换运行时前这里是
 * cuda → metal → vulkan 的后端链，由 node-llama-cpp 报告的 supported
 * 集合过滤；现在官方 llama.cpp 的 GPU 变体由 **`--variant` 显式选择**
 * （Runtime 页下拉 → 配置 → client spawn），三档 gpu 偏好只在
 * variant=vulkan 时还有意义（三档全映射 vulkan，行为与从前一致）；
 * variant=cuda 时 gpu 偏好被忽略，variant=cpu 时整个 GPU 概念不适用
 * —— 记档的分歧（port-plan）：`discrete` 旧语义"只要 cuda/metal、
 * 两者皆无则拒绝"不再复现，GPU 设备门由 --list-devices 检查守住，
 * 无 GPU 的机器改走 `--variant cpu`（2026-11-05 机主拍板允许 CPU 推理）。
 */
const GPU_VARIANTS = {
  auto: ["vulkan"],
  discrete: ["vulkan"],
  integrated: ["vulkan"],
};

/** Values `--gpu` used to take, when it named a backend. Same map as in
 *  plugin/src/model/config.ts, because this file is also run by hand. */
const LEGACY_GPU = {
  cuda: "discrete",
  vulkan: "integrated",
};

function normalizeGpu(value) {
  if (Object.hasOwn(GPU_VARIANTS, value)) return value;
  return LEGACY_GPU[value] ?? "auto";
}

/**
 * `--log-level` 到 llama-server `-lv`（log verbosity）的映射：
 * 1 error / 2 warning / 3 info / 5 debug。旧的 LlamaLogLevel 没了，
 * 语义按档位对齐；silent 只压子进程，本服务自己的 [mem-plus:serve] 行照写。
 */
const VERBOSITY = { silent: 1, warn: 2, info: 3, debug: 5 };

function log(message, detail) {
  const suffix = detail === undefined ? "" : ` :: ${detail instanceof Error ? detail.message : String(detail)}`;
  process.stdout.write(`[mem-plus:serve] ${message}${suffix}\n`);
}

// ---------------------------------------------------------------- 配置

function readArgs(argv) {
  const args = {
    port: 4748,
    idleMinutes: 5,
    gpu: "auto",
    threads: 0,
    gpuLayers: "auto",
    vramPadding: null,
    logLevel: "warn",
    variant: "vulkan",
    // 自动补下/保持最新开关：client spawn 传 --no-auto-prepare（Runtime 页关掉时）。
    autoPrepare: true,
    // 显式动作（网页下载按钮 / --ensure）无视上面的门——用户点了就不该被自己的开关拦住。
    forcePrepare: false,
    // 准备模式：ensure 完直接退出，不校验 GPU、不拉子进程、不监听。
    ensureOnly: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    switch (flag) {
      case "--port": args.port = Number(value); i++; break;
      case "--idle-minutes": args.idleMinutes = Number(value); i++; break;
      case "--gpu": args.gpu = value; i++; break;
      case "--ensure": args.ensureOnly = true; args.forcePrepare = true; break; // 无值开关
      case "--force-prepare": args.forcePrepare = true; break;
      case "--no-auto-prepare": args.autoPrepare = false; break;
      // 引擎变体（Runtime 页所选）。未知值退回 vulkan 并记日志：错拼的变体
      // 必须落在能跑的默认上，而不是拒绝启动整个记忆服务。
      case "--variant":
        if (value !== "vulkan" && value !== "cuda" && value !== "cpu") {
          log(`--variant must be "vulkan", "cuda" or "cpu", got ${JSON.stringify(value)}; using vulkan`);
          args.variant = "vulkan";
        } else {
          args.variant = value;
        }
        i++;
        break;
      case "--threads": args.threads = Number(value); i++; break;
      case "--gpu-layers": args.gpuLayers = value === "auto" ? "auto" : Number(value); i++; break;
      // 显存预留来自 client.ts，单位 GB；钳在 0–64，与插件侧 readVramPadding 同一收口。
      case "--vram-padding": {
        const gigabytes = Number(value);
        args.vramPadding = Number.isFinite(gigabytes) ? Math.min(64, Math.max(0, gigabytes)) : null;
        i++;
        break;
      }
      case "--log-level": args.logLevel = value; i++; break;
      case "--embed": args.embedPath = path.resolve(value); i++; break;
    }
  }
  if (!args.embedPath) args.embedPath = path.resolve(PLUGIN_ROOT, "..", "models", "bge-m3-Q8_0.gguf");
  return args;
}

const config = readArgs(process.argv.slice(2));

// 旧配置里 `--gpu cpu` 这个**偏好**已废（GPU 偏好只有 auto/discrete/
// integrated 三档），按 auto 处理；真要 CPU 推理走 `--variant cpu`。
if (config.gpu === "cpu") {
  log("gpu=cpu is no longer a GPU preference (use --variant cpu for the CPU runtime); using gpu=auto");
  config.gpu = "auto";
}

// ---------------------------------------------------------------- 路径

/**
 * 与 plugin/src/paths.ts 的 stateRoot()/configHome() 同一算法：
 * `$XDG_CONFIG_HOME` 否则 `~/.config`，再进 `opencode/mem-plus`。
 * 服务是独立进程，不 import 插件的 TS，这里手抄 —— 两边任何一处改了，
 * 另一处要跟着改（同 LEGACY_GPU 的约定）。
 */
function stateRoot() {
  const xdg = process.env["XDG_CONFIG_HOME"];
  const home = xdg && xdg.length > 0 ? xdg : path.join(os.homedir(), ".config");
  return path.join(home, "opencode", "mem-plus");
}

function runtimeDir() {
  return path.join(stateRoot(), "runtime", `llama-${RUNTIME.tag}-win-${releaseVariantString(config.variant)}-x64`);
}

// ---------------------------------------------------------------- 串行化
// 一个模型一个 context；两次抽取抢同一个 sequence 会交错写 KV cache。
// llama-server 有自己的 slot 调度，但对外仍是一次一个 /embed 语义，
// 互斥链保序，也顺带保证子进程不会被并发拉起两次。

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
  backend: "not loaded",
  child: null,
  childPort: null,
  /** Resolves once llama-server answers /health with 200 (model loaded). */
  childReady: null,
  childFailure: null,
  /** True once the child /health answered 200 — feeds health `loaded.embed`. */
  modelReady: false,
  embedPath: config.embedPath,
  lastUsedAt: Date.now(),
};

/** 建一个延迟对象，失败路径统一 reject（带空 catch 防 unhandled）。 */
function makeDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  promise.catch(() => {});
  return { promise, resolve, reject };
}

function describeGpu(preference) {
  // 后端只有一个（vulkan 变体），describe 报变体而非偏好 —— 日志里要的是
  // "实际赢的是谁"，与旧 describeGpu 同一原则。
  return "vulkan (official llama.cpp)";
}

// ---------------------------------------------------------------- 运行时下载与解压

function downloadUrl(file) {
  return `https://github.com/ggml-org/llama.cpp/releases/download/${RUNTIME.tag}/${file}`;
}

/**
 * CUDA 的下载/启动门。`nvidia-smi` 是驱动装没装的最直接证据（系统 PATH 里
 * 随驱动一起装），没有它 CUDA 版 llama-server 起不来 —— 所以门放在**下载之前**：
 * 没有驱动的机器不该为一个跑不了的引擎下 592 MB。Runtime 页的下拉可用性用
 * 同一条证据（api.ts 同源判定），两道门一个标准。
 */
function assertNvidiaForCuda() {
  const probe = spawnSync("nvidia-smi", ["--query-gpu=name", "--format=csv,noheader"], {
    stdio: "pipe",
    windowsHide: true,
    encoding: "utf8",
    timeout: 5000,
  });
  const ok = !probe.error && probe.status === 0 && (probe.stdout ?? "").trim().length > 0;
  if (!ok) {
    throw new Error(
      `variant "cuda" needs an NVIDIA driver: nvidia-smi is not usable on this machine ` +
        `(refusing to download ~592 MB that could not run; pick Vulkan on the Runtime page)`,
    );
  }
}

/**
 * 对齐上游最新 nightly 并写回 runtime.json——「一直保持最新」的唯一真相
 * 写入点（机主 2026-11-05 拍板：删掉稳定版/测试版选择，全自动保持最新）。
 * 代价照旧记档：版本与 sha256 改由 GitHub API 的 asset `digest` 提供，信任
 * 落在 TLS+API 上，不再是打包时钉死的仓库值。runtime.json 仍是单一来源——
 * 只是值的出处换了；写回后插件侧 runtimeTag() 与全部路径自动跟随，行身份
 * 不随 tag 变（embedderIdFor：跨 nightly 实测 cos=1.0），对齐不触发重嵌。
 * 只在准备动作里调用（--ensure / 缺件补下），服务正常启动不联网。
 */
async function applyLatestNightly() {
  let releases;
  try {
    const res = await fetch("https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=30", {
      headers: { accept: "application/vnd.github+json", "user-agent": "mem-plus" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`GitHub API HTTP ${res.status}`);
    releases = await res.json();
  } catch (error) {
    throw new Error(
      `latest alignment needs the network to resolve the newest nightly: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const release = Array.isArray(releases)
    ? releases.find((r) => typeof r?.tag_name === "string" && /^b\d+$/.test(r.tag_name))
    : null;
  if (!release) throw new Error("latest alignment: GitHub returned no b-tagged nightly release");
  const tag = release.tag_name;
  if (tag === RUNTIME.tag) return;
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const digestOf = (name) => {
    const a = assets.find((x) => x?.name === name);
    const raw = typeof a?.digest === "string" && a.digest.startsWith("sha256:") ? a.digest.slice(7) : null;
    if (!raw || !/^[0-9a-f]{64}$/.test(raw)) return null;
    return { sha256: raw, sizeBytes: a.size };
  };
  const vulkan = digestOf(`llama-${tag}-bin-win-vulkan-x64.zip`);
  if (!vulkan) {
    throw new Error(
      `latest alignment: GitHub published no verifiable sha256 digest for llama-${tag}-bin-win-vulkan-x64.zip -- refusing an unhashed download`,
    );
  }
  const manifest = { tag, assets: { vulkan } };
  // cpu 块尽力而为（与 cuda 同规矩）：官方哪天不发/不带 digest，vulkan 通道
  // 照走，引擎行如实报「runtime.json 未钉 CPU 资产」。
  const cpu = digestOf(`llama-${tag}-bin-win-cpu-x64.zip`);
  if (cpu) manifest.assets.cpu = cpu;
  // cuda 块尽力而为：官方哪天改名/不发，vulkan 通道照走，引擎行如实报
  // 「runtime.json 未钉 CUDA 资产」（既有文案）。
  const cudaAsset = assets.find(
    (x) => typeof x?.name === "string" && new RegExp(`^llama-${tag}-bin-win-cuda-[\\d.]+-x64\\.zip$`).test(x.name),
  );
  if (cudaAsset) {
    const version = cudaAsset.name.match(new RegExp(`^llama-${tag}-bin-win-(cuda-[\\d.]+)-x64\\.zip$`))[1];
    const cuda = digestOf(cudaAsset.name);
    const cudart = digestOf(`cudart-llama-bin-win-${version}-x64.zip`);
    if (cuda && cudart) {
      manifest.assets.cuda = {
        variant: version,
        ...cuda,
        cudartSha256: cudart.sha256,
        cudartSizeBytes: cudart.sizeBytes,
      };
    }
  }
  // tmp+rename 写回：崩在半路也不能让单源文件变半截。
  const file = path.join(HERE, "runtime.json");
  const tmpFile = `${file}.tmp`;
  writeFileSync(tmpFile, `${JSON.stringify(manifest, null, 2)}\n`);
  renameSync(tmpFile, file);
  RUNTIME = readRuntimeManifest();
  log(`runtime.json now pins ${tag} (digests from GitHub API, alignment)`);
}

/**
 * LM「扩展包」语义的收尾清理（机主 2026-11-05 拍板按 LM 的定义改）：zip 是
 * 暂存品不是公民——目录解压落位后 zip 没有任何消费者，整族的
 * `llama-b*-bin-win-<fam>-x64.zip`（**含当前 tag**）连同同家族的其他 tag
 * 目录（`llama-b*-win-<fam>-x64`）一起删。保留的只有：正在用的当前 tag
 * 目录、其他变体家族（用户可能切回去）、不带 tag 的 cudart 共享包（跨 tag
 * 复用，删了每次 nightly 更新都要重下 423 MB——它是缓存，不是暂存品）。
 * zip 删掉的代价 = 目录半截损坏时没有本地重解的自愈，改走重下载；这正是
 * LM 自己的行为（pack 装完即弃，修复 = 重新下载）。被运行中的 llama-server
 * 锁住就跳过记日志——best-effort，下次对齐再清，绝不让清理弄崩准备流程。
 */
function sweepRuntimeOrphans(dir) {
  const runtimeRoot = path.dirname(dir);
  const family = releaseVariantString(config.variant);
  const keep = new Set([path.basename(dir)]);
  // 孤儿两类、两个正则：目录 `llama-b<tag>-win-<family>-x64`，zip
  // `llama-b<tag>-bin-win-<family>-x64.zip`。isDir 决定按哪条式子匹配。
  const dirRe = new RegExp(`^llama-b\\d+-win-${family.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-x64$`);
  const zipRe = new RegExp(`^llama-b\\d+-bin-win-${family.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-x64\\.zip$`);
  let entries;
  try {
    entries = readdirSync(runtimeRoot);
  } catch (error) {
    log(`runtime sweep skipped: ${error.message}`);
    return;
  }
  let removed = 0;
  for (const entry of entries) {
    if (keep.has(entry)) continue;
    const full = path.join(runtimeRoot, entry);
    let isDir = false;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      continue; // 扫的刹那被删了，正合我意
    }
    if (!(isDir ? dirRe : zipRe).test(entry)) continue;
    try {
      rmSync(full, { recursive: true, force: true });
      removed += 1;
    } catch (error) {
      log(`runtime sweep skip ${entry}: ${error.message}`);
    }
  }
  if (removed > 0) log(`runtime sweep: removed ${removed} orphan(s) of ${family}`);
}

/**
 * 同变体家族里「装过且还能跑」的最高 tag 目录——LM 的 localVersion 维度
 * （机主 2026-11-05 拍板对齐 LM：装了旧版 ≠ 没装）。与 plugin/src/model/
 * config.ts 的 `installedRuntimeTag` 同一算法，那边报装、这边回退运行，
 * 不一致页面就会骗人。
 */
function findInstalledVariantDir(pinnedDir) {
  const family = releaseVariantString(config.variant).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const famRe = new RegExp(`^llama-b(\\d+)-win-${family}-x64$`);
  const runtimeRoot = path.dirname(pinnedDir);
  let entries;
  try {
    entries = readdirSync(runtimeRoot);
  } catch {
    return null;
  }
  let best = null;
  let bestTag = -1;
  for (const entry of entries) {
    const match = famRe.exec(entry);
    if (!match) continue;
    const n = Number(match[1]);
    if (n <= bestTag) continue;
    const full = path.join(runtimeRoot, entry);
    if (!existsSync(path.join(full, "llama-server.exe"))) continue;
    best = full;
    bestTag = n;
  }
  return best && path.basename(best) !== path.basename(pinnedDir) ? best : null;
}

async function ensureRuntime() {
  let dir = runtimeDir();
  const exe = path.join(dir, "llama-server.exe");
  // 服务正常启动的离线快路径：exe 在位 = 直接用，零网络动作。
  //（--ensure 等准备动作不走这里，它们存在的意义就是对齐最新。）
  if (!config.ensureOnly && existsSync(exe)) return dir;

  // cuda 先过 NVIDIA 门，再谈任何网络/写盘动作（见 assertNvidiaForCuda）。
  if (config.variant === "cuda") assertNvidiaForCuda();

  // 一直保持最新（机主 2026-11-05 拍板：通道选择删除，全自动对齐）：一切
  // 准备动作——行内按钮、插件启动的自动对齐、缺失补下——先对齐上游最新
  // nightly 并写回 runtime.json（sha256 取 API digest）。失败只告警并降级
  // 用当前 tag：离线时本地 zip 的校验解压自愈仍然成立；真需要下载时由
  // 下面的下载/门如实报网络错，不让一次探测失败堵死准备。
  try {
    await applyLatestNightly();
  } catch (error) {
    log(`latest alignment failed, continuing with ${RUNTIME.tag}`, error);
  }
  dir = runtimeDir(); // tag 可能已翻，路径必须重算
  if (existsSync(path.join(dir, "llama-server.exe"))) {
    sweepRuntimeOrphans(dir); // 新 tag 目录早就在盘上（比如上次下过），孤儿照样清
    return dir;
  }

  // LM 语义（机主 2026-11-05 拍板：「已装」与「装的是钉死版」是两个维度）：
  // 钉死版没在位、家族却有能跑的旧版 = 正常启动直接用它。不为一次 tag 漂移
  // 卡死服务、也不让半夜的启动被迫下载 24 MB——换最新是准备动作（--ensure /
  // 网页更新）的职责，启动对齐稍后自己把新版带来。回退目录不做 sweep：它
  // 自己就是用中的那个。
  if (!config.ensureOnly && !config.forcePrepare) {
    const fallback = findInstalledVariantDir(dir);
    if (fallback) {
      log(`runtime: ${path.basename(dir)} not installed, running installed ${path.basename(fallback)}`);
      return fallback;
    }
  }

  // 下载包清单：vulkan/cpu 各一个 zip；cuda 两个（官方把 cudart 拆成独立包，
  // 169 MB 构建 + 423 MB cudart，两个都要解到同一目录 llama-server 才能跑）。
  const packs =
    config.variant === "cuda"
      ? (() => {
          const cuda = RUNTIME.assets.cuda;
          if (!cuda) throw new Error('runtime.json has no assets.cuda but --variant cuda was requested');
          const release = cuda.variant;
          return [
            { file: runtimeAssetFile(release), sha256: cuda.sha256, sizeBytes: cuda.sizeBytes },
            { file: cudartAssetFile(release), sha256: cuda.cudartSha256, sizeBytes: cuda.cudartSizeBytes },
          ];
        })()
      : config.variant === "cpu"
        ? (() => {
            const cpu = RUNTIME.assets.cpu;
            if (!cpu) throw new Error("runtime.json has no assets.cpu but --variant cpu was requested");
            return [{ file: runtimeAssetFile("cpu"), sha256: cpu.sha256, sizeBytes: cpu.sizeBytes }];
          })()
        : [
          {
            file: runtimeAssetFile("vulkan"),
            sha256: RUNTIME.assets.vulkan.sha256,
            sizeBytes: RUNTIME.assets.vulkan.sizeBytes,
          },
        ];
  const runtimeRoot = path.join(stateRoot(), "runtime");
  mkdirSync(runtimeRoot, { recursive: true });

  // 自动补下门：开关关着时，zip 不在盘上 = 快速失败并指路网页按钮，
  // 不自己联网；zip 在盘上则照常校验解压（本地自愈不算「补下」）。
  // forcePrepare（网页下载按钮 / --ensure 的显式动作）与 ensureOnly 无视门。
  const missingZips = packs.filter((p) => {
    const zip = path.join(runtimeRoot, p.file);
    return !existsSync(zip) || statSync(zip).size === 0;
  });
  if (missingZips.length > 0 && !config.autoPrepare && !config.forcePrepare) {
    throw new Error(
      `auto-prepare is off and ${missingZips.map((p) => p.file).join(", ")} ${missingZips.length > 1 ? "are" : "is"} not on disk -- download from the Runtime page`,
    );
  }

  for (const pack of packs) {
    const zipPath = path.join(runtimeRoot, pack.file);
    if (!existsSync(zipPath) || statSync(zipPath).size === 0) {
      // 每进程独立 .part：一次启动按工作区装载 N 次、并发 N 个 --ensure，
      // 共用 .part 会互踩（实测 rename ENOENT）。
      const partPath = `${zipPath}.${process.pid}.part`;
      log(`downloading runtime ${pack.file} (${Math.round(pack.sizeBytes / 1e6)} MB) from GitHub releases`);
      await downloadTo(downloadUrl(pack.file), partPath);
      renameSync(partPath, zipPath);
      log(`runtime downloaded: ${zipPath}`);
    }
    const actual = await sha256File(zipPath);
    if (actual !== pack.sha256) {
      rmSync(zipPath, { force: true });
      throw new Error(
        `runtime sha256 mismatch: expected ${pack.sha256}, got ${actual}; zip deleted, retry will re-download (${pack.file})`,
      );
    }
  }

  // 解压到 .tmp 再改名：中途失败不会留下半截目录冒充可用运行时。
  // cuda 两个包顺序解（cudart 先、构建包后）：内容互不覆盖，顺序只求确定性。
  const tmp = `${dir}.tmp`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  for (const pack of packs) {
    await extractZip(path.join(runtimeRoot, pack.file), tmp);
  }
  if (!existsSync(path.join(tmp, "llama-server.exe"))) {
    throw new Error(`runtime zip extracted but llama-server.exe missing in ${tmp}`);
  }
  rmSync(dir, { recursive: true, force: true });
  renameSync(tmp, dir);
  log(`runtime ready: ${dir}`);
  sweepRuntimeOrphans(dir);
  return dir;
}

/**
 * 下载到 dest（半成品路径，成功后才 rename 成正式 zip）。
 *
 * 先试内置 fetch，失败换 curl.exe。不是保险写法，是本机实测
 * （2026-11-04）：这台机器上 github.com 被 SteamTools 的假根证书
 * 中间人，Windows 证书库信任它、Node 内置 CA 不信任，undici 直接
 * UNABLE_TO_VERIFY_LEAF_SIGNATURE；curl.exe（schannel，走系统证书库）
 * 能下。两路都过 sha256 校验，中间人也改不了钉死的 digest。
 */
async function downloadTo(url, dest) {
  let fetchFailure = "not attempted";
  try {
    // 快路径有界：undici 默认 300 s 才断，卡住的连接会让"准备运行时"哑等
    // 五分钟（2026-11-04 实测 A 段 300 s 无一字节）。180 s 内完不成就退给
    // curl——大文件（cuda 双包 592 MB）本来就该走下面那条耐心路。
    const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(180_000) });
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(dest));
    return;
  } catch (error) {
    fetchFailure = error instanceof Error ? error.message : String(error);
    log(`fetch download failed, falling back to curl.exe`, error);
  }
  // --ssl-no-revoke：本机 SteamTools 假根证书没有 CRL/OCSP，schannel 的
  // 吊销检查必然 CRYPT_E_NO_REVOCATION_CHECK 失败。完整性不靠证书链，
  // 靠上面钉死的 sha256 —— 中间人改一个字节就过不了校验。
  const curl = spawnSync(
    "curl.exe",
    [
      "-fsSL",
      "--ssl-no-revoke",
      "--retry", "3",
      // 失速地板：30 秒内平均 < 1 KB/s 判为卡死并中止（2026-11-04 实测的
      // 哑等下载走这里被及时掐掉、错误立刻可见）；慢但在动的下载不受影响。
      // --connect-timeout 20 同理掐死握手挂起。
      "--connect-timeout", "20",
      "--speed-time", "30",
      "--speed-limit", "1024",
      "-o", dest,
      url,
    ],
    { stdio: "pipe", windowsHide: true, encoding: "utf8" },
  );
  if (curl.status === 0 && existsSync(dest) && statSync(dest).size > 0) return;
  throw new Error(
    `runtime download failed: fetch (${fetchFailure}); curl exit ${curl.error ? curl.error.code : curl.status} ` +
      `${(curl.stderr ?? "").trim().slice(0, 200)}`,
  );
}

async function sha256File(file) {
  const { createReadStream } = await import("node:fs");
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), hash);
  return hash.digest("hex");
}

/**
 * 解 zip：Windows 10+ 自带的 bsdtar（tar.exe）认 zip，零依赖；
 * 没有 tar 或失败退回 PowerShell Expand-Archive。不引解压库 ——
 * 安装器同款取舍（helper 缺失时必须还能装），见 AGENTS.md。
 */
async function extractZip(zipPath, targetDir) {
  const tar = spawnSync("tar", ["-xf", zipPath, "-C", targetDir], { stdio: "pipe", windowsHide: true });
  if (tar.status === 0) return;
  const ps = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-Command", `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${targetDir}' -Force`],
    { stdio: "pipe", windowsHide: true },
  );
  if (ps.status === 0) return;
  throw new Error(
    `runtime extract failed: tar exit ${tar.error ? tar.error.code : tar.status}, ` +
      `Expand-Archive exit ${ps.error ? ps.error.code : ps.status}`,
  );
}

// ---------------------------------------------------------------- GPU 检查

/**
 * 官方 llama.cpp 的 `--list-devices` 打一行设备就退出，是现成的
 * "这台机器有没有可用 GPU" 探针 —— 换掉的是旧代码里
 * `getLlamaGpuTypes("supported")` 的过滤 + getLlama() 逐个试的循环。
 * 无设备 = 拒绝启动；`--variant cpu` 不做设备检查（CPU 构建没有 GPU
 * 概念，2026-11-05 起 CPU 推理是正门而非回落）。
 */
function validateGpuDevice(dir) {
  if (config.variant === "cpu") return "cpu (device check skipped)";
  const probe = spawnSync(path.join(dir, "llama-server.exe"), ["--list-devices"], {
    stdio: "pipe",
    windowsHide: true,
    encoding: "utf8",
  });
  const output = `${probe.stdout ?? ""}${probe.stderr ?? ""}`;
  // 按所选变体要它该有的那行：CUDA 版构建只报 CUDA 设备，Vulkan 版只报
  // Vulkan —— 拿到"别的后端的行"等于这个后端在这台机器上没有设备。
  const wantLine = config.variant === "cuda" ? /^CUDA\d+:/ : /^Vulkan\d+:/;
  const deviceLine = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => wantLine.test(line));
  if (probe.error) throw new Error(`--list-devices failed to run: ${probe.error.message}`);
  if (!deviceLine) {
    throw new Error(
      `variant "${config.variant}" needs ${config.variant === "cuda" ? "an NVIDIA CUDA device" : "a Vulkan device"} ` +
        `and this machine reports none (switch engines on the Runtime page — the CPU runtime needs no GPU — or check drivers) ` +
        `:: ${output.trim().split(/\r?\n/).slice(0, 3).join(" | ") || "no output"}`,
    );
  }
  return deviceLine;
}

// ---------------------------------------------------------------- llama-server 子进程

/** 子进程端口：与对外端口错开的固定带，占用则顺延，最多试 11 个。 */
const CHILD_PORT_BASE = 4848;
const CHILD_PORT_TRIES = 11;

function childArgs(port) {
  // -c 2048 对齐旧 createEmbeddingContext({ contextSize: 2048 })；
  // -np 1 单槽，互斥链已经串行化，槽多了只是白占 KV。
  const args = [
    "-m", state.embedPath,
    "--host", "127.0.0.1",
    "--port", String(port),
    "--embedding",
    "-c", "2048",
    "-np", "1",
    // -ub 2048 是实测补上的（2026-11-04）：llama-server 物理批大小默认 512，
    // 而 embeddings 启动时 n_batch(2048) > n_ubatch(512) 会被降到 512 ——
    // 于是 >512 token 的 chunk 全部 500「input (514 tokens) is too large to
    // process. increase the physical batch size」，E2E 实测 575 个 chunk 掉
    // 360 个（63%），旧 node-llama-cpp 没有这道帽。-ub 抬到 2048 与 -c 对齐，
    // -b 显式同值防默认漂移；启动那条 n_batch>n_ubatch 警告随之消失。
    // 内存代价是 ubatch 缓冲变大，2048 对 bge-m3（<1GB）在任何能跑它的卡上无感。
    "-b", "2048",
    "-ub", "2048",
    "-lv", String(VERBOSITY[config.logLevel] ?? 2),
  ];
  // gpu-layers：llama-server 缺省就是 auto（--fit 按当刻空闲显存装），
  // 与旧 "auto 不传、数字才传" 同形。数字是用户显式要的层数。
  // CPU 构建没有层可卸、没有 fit 目标：这两个参数不传（传了要么是 no-op
  // 要么被拒，语义上都不属于 cpu 变体）。
  if (config.variant !== "cpu" && config.gpuLayers !== "auto") args.push("-ngl", String(config.gpuLayers));
  if (config.threads > 0) args.push("-t", String(config.threads));
  // vramPadding(GB) → --fit-target(MiB)：官方 llama.cpp 没有同名参数，
  // 语义最近的是 fit 的每设备余量（缺省 1024 MiB）。换算是记档的分歧
  // （port-plan）：旧参数是引擎按字节收的加载预留，这里是 fit 目标余量，
  // 数值同源（用户配置的 GB）但不保证逐字节等价。
  if (config.variant !== "cpu" && config.vramPadding !== null) args.push("--fit-target", String(Math.round(config.vramPadding * 1024)));
  // pooling 不传：用模型元数据的 CLS（spike 实测双方都是 CLS，
  // 显式 --pooling mean 反而 cos 掉到 0.71–0.79）。
  return args;
}

async function findChildPort() {
  for (let i = 0; i < CHILD_PORT_TRIES; i++) {
    const port = CHILD_PORT_BASE + i;
    const free = await portFree(port);
    if (free) return port;
  }
  throw new Error(`llama-server ports ${CHILD_PORT_BASE}-${CHILD_PORT_BASE + CHILD_PORT_TRIES - 1} all in use`);
}

function portFree(port) {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
  });
}

function httpGet(url, timeoutMs) {
  return new Promise((resolve) => {
    const target = new URL(url);
    const req = httpRequest(
      { hostname: target.hostname, port: target.port, path: target.pathname, method: "GET" },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy());
    req.on("error", () => resolve(null));
    req.end();
  });
}

/**
 * 端口区间里找一个在答 /health 且 `service === "mem-plus"` 的端口；没有返回
 * null。`excludePort` 是自己刚绑上的端口（复检时否则会找到自己）。
 * 连接被拒与超时都算「这里没有」——httpGet 对两者都 resolve null。
 * 只认 service 字段：4748 被别的程序占着时不误退（那不是本服务，该顺延）。
 */
async function findMemPlusService(from, to, excludePort) {
  for (let port = from; port <= to; port++) {
    if (port === excludePort) continue;
    // 外层 700ms 硬超时兜底：httpGet 只在 'error' 时 resolve，而
    // req.destroy() 不带 error 未必触发它——区间里若有 accept 后不答的
    // 监听者，裸等会把启动挂死。
    const res = await Promise.race([
      httpGet(`http://127.0.0.1:${port}/health`, 500),
      new Promise((resolve) => setTimeout(() => resolve(null), 700)),
    ]);
    if (res === null || res.status !== 200) continue;
    try {
      const body = JSON.parse(res.body);
      if (body?.service === "mem-plus") return port;
    } catch {
      // 非 JSON 应答 = 不是本服务。
    }
  }
  return null;
}

function httpPost(url, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const payload = Buffer.from(JSON.stringify(body), "utf8");
    const req = httpRequest(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        method: "POST",
        headers: { "content-type": "application/json", "content-length": String(payload.byteLength) },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          try {
            resolve({ status: res.statusCode ?? 0, json: text.length > 0 ? JSON.parse(text) : {} });
          } catch {
            resolve({ status: res.statusCode ?? 0, json: { error: text.slice(0, 300) } });
          }
        });
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`request timed out after ${timeoutMs} ms`)));
    req.on("error", reject);
    req.end(payload);
  });
}

/**
 * 拉起 llama-server 并等到它 /health 200（模型装完）。后台跑，
 * 结果写进 state.childReady / state.childFailure —— /embed 等前者，
 * /health 的 loaded.embed 读它，失败原因从后者取。
 */
async function startChild(dir) {
  const deferred = makeDeferred();
  state.childReady = deferred.promise;

  const port = await findChildPort();
  state.childPort = port;
  const args = childArgs(port);
  log(`starting llama-server on127.0.0.1:${port} :: ${args.join(" ")}`);

  const child = spawn(path.join(dir, "llama-server.exe"), args, {
    detached: false,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  state.child = child;

  const NOISE = /model has unused tensor|ignoring wrong number of dims|llama_model_loader: n_\w+ = \d+|security: no API key/u;
  const relay = (stream, label) => {
    stream.on("data", (chunk) => {
      for (const line of chunk.toString("utf8").split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed.length === 0 || NOISE.test(trimmed)) continue;
        if (config.logLevel === "silent") continue;
        log(`${label} ${trimmed.slice(0, 300)}`);
      }
    });
  };
  relay(child.stdout, "llama-server");
  relay(child.stderr, "llama-server!");

  const fail = (reason) => {
    if (state.childFailure !== null) return;
    state.childFailure = reason instanceof Error ? reason : new Error(String(reason));
    deferred.reject(state.childFailure);
    log(state.childFailure.message);
  };

  let exited = false;
  child.on("exit", (code, signal) => {
    exited = true;
    state.modelReady = false;
    if (state.child === child) state.child = null;
    fail(`llama-server exited (code ${code}, signal ${signal ?? "none"})`);
  });

  // 等 /health 200：llama-server 加载模型期间返回 503，装完 200。
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (exited) return;
    const health = await httpGet(`http://127.0.0.1:${port}/health`, 1_500);
    if (health && health.status === 200) {
      state.modelReady = true;
      state.backend =
        config.variant === "cpu"
          ? `cpu build ${RUNTIME.tag}`
          : `${describeGpu(normalizeGpu(config.gpu))} build ${RUNTIME.tag}`;
      log(`llama backend = ${state.backend} (llama-server ready on ${port})`);
      deferred.resolve();
      return;
    }
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  if (!exited) {
    fail(`llama-server not healthy on ${port} within 60s`);
    try {
      child.kill();
    } catch {}
  }
}

/** /embed 入口：先等子进程就绪（首跑含模型加载），失败按 500 报原因。 */
async function awaitChildReady(timeoutMs) {
  if (state.childFailure) throw state.childFailure;
  if (!state.childReady) throw new Error("llama-server was never started");
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`llama-server not ready within ${timeoutMs} ms`)), timeoutMs);
  });
  try {
    await Promise.race([state.childReady, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------- 推理

async function embed(input) {
  await awaitChildReady(55_000);
  const response = await httpPost(
    `http://127.0.0.1:${state.childPort}/v1/embeddings`,
    { input },
    60_000,
  );
  if (response.status < 200 || response.status >= 300) {
    const detail = typeof response.json?.error === "string" ? response.json.error : JSON.stringify(response.json);
    throw new Error(`llama-server /v1/embeddings failed (${response.status}): ${detail.slice(0, 300)}`);
  }
  const vector = response.json?.data?.[0]?.embedding;
  if (!Array.isArray(vector)) throw new Error("/v1/embeddings returned no embedding");
  return vector;
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
    // ok:true = 运行时已就绪（走到这里必已通过 --list-devices 检查），
    // 与旧代码 "GPU 后端已开" 同义；模型状态看 loaded.embed。
    return sendJson(res, 200, {
      ok: true,
      service: "mem-plus",
      variant: config.variant,
      port: server.address()?.port ?? null,
      backend: state.backend,
      loaded: { embed: state.modelReady },
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
      // cannot be exceeded. 2048 = the -c/-b/-ub we spawn llama-server with.
      const maxChars = 2048;
      const cjk = (body.input.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/g) ?? []).length;
      if (cjk > maxChars) {
        return sendJson(res, 400, {
          error: `input is longer than the usable context size (${cjk} CJK characters > ${maxChars} tokens)`,
        });
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

// ---------------------------------------------------------------- 启动

// 顺延的上限：探测 + 监听 + 失败换下一个，各 11 次。
const MAX_PORT_TRIES = 11;

// join 守卫第一层（listen 之前）：区间里已经有活着的 mem-plus 服务，
// 直接退 0，不再下载运行时、不再起 llama-server。
// 为什么需要：插件按 workspace 装载，一次 opencode 启动会装载 N 次、两个
// opencode 进程就是 2N 个 client；每个 client spawn 前的扫描只有 250ms，
// 服务还没监听时全都扫不到，于是各自 spawn 一个 server.mjs——端口顺延让
// 它们各占一个端口，bge-m3 就被载两份，GPU 抢占下向量嵌入慢好几倍
// （2026-11-05 实测：一天 18 次 starting service、15 次 llama-server ready，
// 03:13/04:17/05:17 三轮全是双栈，05:17 那轮 641 个零向量 chunk 修了 11 分钟）。
// `--ensure` 与 `--force-prepare` 跳过：显式动作（Runtime 页「确保已安装」
// 与网页下载按钮）不能被「已有服务」吞掉。
if (!config.ensureOnly && !config.forcePrepare) {
  const existing = await findMemPlusService(config.port, config.port + MAX_PORT_TRIES - 1, null);
  if (existing !== null) {
    log(`join: mem-plus service already listening on ${existing}, exiting 0`);
    process.exit(0);
  }
}

// 顺序与旧代码一致：运行时下载 + GPU 检查全部在 listen 之前完成，
// 起不来就退出 1 —— 插件端看到启动失败会把抽取延后，快照照常写入。
// 首跑下载 37 MB 慢于 client 的 startTimeoutMs(30s) 时：client 放弃本轮，
// 本进程不退，下载完照常监听，下一轮 ready() 扫到即自愈（见文件头）。
let runtimeDirPath;
try {
  runtimeDirPath = await ensureRuntime();
} catch (error) {
  // 三类失败三种说法：网络下不动、校验不过、解不开。报错的作用是指出
  // 下一步 —— 说错方向比不说更糟（同旧 node-llama-cpp 缺包那条的教训）。
  const reason = error instanceof Error ? `${error.code ?? ""} ${error.message}` : String(error);
  if (/auto-prepare is off/i.test(reason)) {
    log("运行时自动准备已关闭，且 zip 不在磁盘上：到 Runtime 页点「安装/下载」，或把自动补下开关打开。未就绪时全文检索不受影响。", error);
  } else if (/download failed|fetch failed|ENOTFOUND|ETIMEDOUT|ECONN/i.test(reason)) {
    log("运行时下载失败：连不上 GitHub releases。修复：联网后重试；未就绪时全文检索不受影响，向量检索不可用。", error);
  } else if (/sha256 mismatch/i.test(reason)) {
    log("运行时校验失败：下载内容与钉死的 sha256 不符，已删除。修复：重试；若反复失败，检查网络劫持或磁盘。", error);
  } else {
    log("运行时准备失败", error);
  }
  process.exit(1);
}

// --ensure（网页的安装/重新下载动作，或行内按钮）：准备完就退，不校验
// GPU、不拉子进程、不监听——它是"取件"，不是"起服务"。
if (config.ensureOnly) {
  log(`runtime ready (ensure mode): ${runtimeDirPath}`);
  process.exit(0);
}

try {
  const device = validateGpuDevice(runtimeDirPath);
  log(`gpu device: ${device}`);
} catch (error) {
  // 与旧 openLlama() 的拒绝对齐：所选 GPU 变体无设备时不回落，服务不监听、
  // 直接报错退出（要 CPU 就在 Runtime 页选 cpu 变体，那是正门不是回落）。
  log("gpu backend unavailable; service will not start (discrete > integrated; switch engines on the Runtime page)", error);
  process.exit(1);
}

// 后台拉起子进程：不阻塞 listen，模型加载期间 /embed 等 state.childReady。
void startChild(runtimeDirPath).catch((error) => {
  log("failed to start llama-server", error);
  if (state.childFailure === null) {
    state.childFailure = error instanceof Error ? error : new Error(String(error));
    state.childReady = Promise.reject(state.childFailure);
    state.childReady.catch(() => {});
  }
});

// 端口被占用就顺延，和 opencode-mem 的做法一致（它用 4747-4757）。
// MAX_PORT_TRIES 声明在启动段（join 守卫要用），此处只留注释。
/**
 * 游标记「尝试过的端口」，不是「成功的端口」。旧写法
 * `(listeningPort ?? config.port) + 1` 在失败路径上 listeningPort 恒 null，
 * 于是游标永远等于 base+1：4748 与 4749 双占时（2026-11-04 装机窗两个实例
 * 并存实测）同一句「port 4748 busy, trying 4749」无限空转，mem-plus.log 被
 * 刷出 10083 行、stdout 高速写把行都撕碎了，而且封顶条件永不触发。
 * 现在每次尝试 +1 推进、11 次封顶；两个失败出口都走 shutdown(1) 而不是
 * process.exit——退出前把 llama-server 子进程收掉，否则监听失败的瞬间退出
 * 会把它留成孤儿（4 GB 常驻）。
 */
let attemptPort = null;
tryListen(config.port);

function tryListen(port) {
  attemptPort = port;
  server.once("error", onListenError);
  server.listen(port, "127.0.0.1", () => {
    // 两道守卫，都是实测踩出来的（2026-11-04，portwalk-test）：
    // 1) Node 的 listen 回调等价于 once("listening")，失败的尝试出错时并不
    //    摘掉已挂的回调——最终成功的那次会把前面每次的回调全部触发，日志
    //    连打 "listening on 4748/4749"，其实只监听了 4750。只认当前游标。
    // 2) 成功那次自己挂的 once("error") 永远没人触发，留着它，服务正常跑
    //    到后某天一个后发 error 就会进 onListenError 走"failed to start"
    //    自杀——成功即清。
    if (attemptPort !== port) return;
    server.removeAllListeners("error");
    // join 守卫第二层（listen 之后复检）：两个 server.mjs 同时起、各绑一个
    // 端口时，第一层来不及拦住彼此——这时两边各查一次区间，只有持有更
    // 低端口的留下，另一个退 0，保证最终恰剩一个。
    void findMemPlusService(config.port, config.port + MAX_PORT_TRIES - 1, port).then((other) => {
      if (other !== null && other < port) {
        log(`join: mem-plus service already on ${other} (lower port), exiting 0`);
        void shutdown(0);
      }
    });
    log(`listening on http://127.0.0.1:${port}`);
    log(`model: embed=${config.embedPath}`);
    log(`engine: ${config.variant} (${releaseVariantString(config.variant)})`);
    log(`idle timeout = ${config.idleMinutes} min` +
      (config.variant === "cpu" ? `; threads = ${config.threads > 0 ? config.threads : "auto"}` : `; gpu priority = ${normalizeGpu(config.gpu)}`));
  });
}

function onListenError(error) {
  const code = error?.code;
  if (code !== "EADDRINUSE") {
    log("failed to start", error);
    void shutdown(1);
    return;
  }
  const next = attemptPort + 1;
  if (next > config.port + MAX_PORT_TRIES - 1) {
    log(`ports ${config.port}-${next - 1} all in use`);
    void shutdown(1);
    return;
  }
  log(`port ${attemptPort} busy, trying ${next}`);
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
  // 子进程先走：给 3 秒自行退出，超时强杀。模型在子进程里，
  // 我们退了它不退就成孤儿（旧代码 dispose 的对应物）。
  const child = state.child;
  state.child = null;
  if (child && child.exitCode === null) {
    try {
      child.kill();
    } catch {}
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 3_000)),
    ]);
    if (child.exitCode === null) {
      try {
        child.kill();
      } catch {}
    }
  }
  server.close();
  process.exit(code);
}

process.on("SIGTERM", () => void shutdown(0));
process.on("SIGINT", () => void shutdown(0));

// Windows 上没有 SIGTERM，父进程消失时靠这个兜底。
process.on("message", (msg) => {
  if (msg === "shutdown") void shutdown(0);
});
