// Configuration for the local embedding service, and for which OpenCode model does the
// thinking.
//
// WHY THE SERVICE EXISTS
//   openclaw does not ship a GGUF runtime for memory: it reaches embeddings through a
//   provider plugin. mem-plus embeds with the official llama.cpp `llama-server`
//   binary, spawned as a child process by `serve/server.mjs` (a native binary cannot
//   run inside OpenCode's process at all — see that file's header), so vector search
//   needs nothing installed beyond the model file and the downloaded runtime.
//
// WHICH MODEL THINKS
//   The user's own OpenCode model, through `ctx.generate.text` (`plugin/src/llm.ts`).
//   `model.hostedModel` pins which one; omitting it keeps OpenCode's default. Note what
//   this does *not* decide: whether the requests cost anything. That depends entirely on
//   which provider the user's model points at, which is not this plugin's business to
//   characterise.
//
// BACKEND PRIORITY
//   discrete GPU > integrated GPU; CPU is not a supported backend. This option
//   names the class of card you have, not a backend: `GPU_PRIORITY` in
//   plugin/serve/server.mjs resolves it to a backend chain, tried in order, so
//   which backend actually won is observable in the log instead of guessed at.
//   When no GPU works the service refuses to start and the failure lands in the log.
//
// EVERYTHING IS OVERRIDABLE THROUGH `ctx.options`, because the model directory
// in particular is machine-local: it lives next to the checkout by default and
// has no business being hard-coded for anyone who installs this elsewhere.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { readConfigFile } from "../config-file.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stateRoot } from "../paths.js";

/**
 * Which class of GPU the inference service may drive.
 *
 * These name the *hardware*, not the backend, because that is the only thing a
 * user can answer without reading a driver list: "do I have a discrete card" is
 * knowable at a glance, "is this machine CUDA or Vulkan" is not. Each value is
 * resolved to a backend chain by `GPU_PRIORITY` in `plugin/serve/server.mjs`.
 *
 *   auto        - 独显优先，最后兜底核显
 *   discrete    - 只试独显后端（NVIDIA 的 cuda、Apple 的 metal），两条都不行就
 *                 拒绝启动，不回落
 *   integrated  - 只试 vulkan，核显只有它一个后端
 *
 * The asymmetry to know about: an AMD or Intel *discrete* card is driven by
 * vulkan, not by cuda, so it is served by `auto` and by `integrated` but not by
 * `discrete` -- which offers exactly the two backends whose vendors ship no
 * integrated GPU. That is why `discrete` is narrower than its name suggests, and
 * why `auto` is the default.
 */
export type GpuPreference = "auto" | "discrete" | "integrated";

/**
 * Values this option used to take, when it named a backend instead of a class of
 * card. They keep working so a config file written against the old spelling means
 * what it meant: `"cuda"` asked for exactly one backend and `"vulkan"` asked for
 * exactly one backend, which is what `discrete` and `integrated` ask for too.
 *
 * Kept in step with the same map in `plugin/serve/server.mjs`, which needs it
 * because `--gpu` is also a flag you can type by hand.
 */
const LEGACY_GPU: Readonly<Record<string, GpuPreference>> = {
  cuda: "discrete",
  vulkan: "integrated",
};

/**
 * An OpenCode model reference: the model that produces capture summaries and runs
 * promotion consolidation. Optional on purpose -- leaving it unset keeps OpenCode's own
 * model choice, which is the behavior without this option.
 *
 * Field names match `@opencode/client`'s `ModelRef` (`providerID` + `id`) so it
 * can be handed to `ctx.generate.text` without reshaping. Users still write the
 * familiar `"providerID/modelID"` string in `opencode.jsonc`; see `readHostedModel`.
 */
export type HostedModelRef = { readonly providerID: string; readonly id: string };

export type ModelConfig = {
  /**
   * Which OpenCode model `ctx.generate.text` should use. `undefined` = OpenCode's
   * default choice.
   */
  readonly hostedModel?: HostedModelRef;
  readonly gpu: GpuPreference;
  readonly modelDir: string;
  readonly embedModelPath: string;
  /**
   * 行身份里的嵌入器串（`docs/memory-chain.md` §2：chunk 行身份含 model），
   * 形如 `<embedModelPath>@llamacpp`。
   *
   * 与 `embedModelPath` 分开的原因：路径只说明"加载哪个文件"（`--embed`、
   * 存在性检查都用它），而行身份要钉住**哪个引擎家族算的向量**。
   *
   * 身份只到引擎家族为止，不带 nightly tag、不带 vulkan/cuda/cpu 后端
   * （2026-11-05 机主拍板，实测数据见 `embedderIdFor`）：tag/variant 进行
   * 身份会让每次自动对齐翻 tag、每次切后端都把全部 chunk 判 stale 触发
   * 全量重嵌，而实测根本不是不同批次的向量。
   *
   * 家族标记 `@llamacpp` 必须留：2026-11-04 换官方 llama.cpp 时，同一 GGUF
   * 在旧 node-llama-cpp 与新 llama.cpp 下向量 cos 0.93–0.98（spike 实测），
   * 两家族不能混用。更早的裸路径串（无 `@llamacpp`）属于旧家族，故意不被
   * 迁移改写——那些行该走一次真实重嵌。
   */
  readonly embedderId: string;
  /** `model.embed: false` = fts-only, the openclaw `provider: "none"` mode. */
  readonly embedEnabled: boolean;
  /**
   * Whether the user named an embedding file. An explicit path that is missing
   * is a broken configuration (reported); an absent default is just "no vectors
   * here", which degrades silently.
   */
  readonly embedPathExplicit: boolean;
  /** CPU threads for host-side work (inference itself runs on the GPU). */
  readonly threads: number;
  /**
   * Layers pushed to the GPU. `"auto"` sizes the offload to current VRAM and
   * reserves room for the KV cache -- safer than forcing every layer onto an
   * iGPU whose shared memory is already partly claimed by the desktop.
   */
  readonly gpuLayers: number | "auto";
  /**
   * 显存预留（GB），映射为 llama-server 的 `--fit-target`（MiB，×1024，
   * 见 server.mjs `childArgs`）。官方 llama.cpp 没有同名参数，语义最近的
   * 就是 fit 的每设备余量（缺省 1024 MiB）——数值同源但不逐字节等价。
   *
   * 这个字段存在的原始动机：旧引擎 node-llama-cpp 的 `"auto"` 按**当刻**
   * 空闲显存逐层模拟试装，算出到真正加载之间挤进来的显存需求会让整进程
   * 撞 CUDA SIGABRT（withcatai/node-llama-cpp#551），JS 层接不住，
   * memory search 拖着 OpenCode 一起没。`null` = 不传，引擎用自己的默认。
   * 2026-11-04 换官方 llama.cpp 后字段保留、映射改写，原因记
   * `docs/port-plan.md` 步骤1节的分歧清单。
   */
  readonly vramPadding: number | null;
  readonly logLevel: "silent" | "warn" | "info" | "debug";
};

/**
 * Where the GGUF models live.
 *
 * `<root>/models` when the tree ships a `models/` directory of its own (a git
 * checkout, where the user puts the weights next to the source). An installed
 * copy -- an npm cache dir or any read-only install -- cannot hold several
 * GB of weights, so it falls back to the user-writable state root:
 * `~/.config/opencode/mem-plus/models`, next to the memory home itself.
 *
 * Resolved from this file rather than from `process.cwd()` so it holds no
 * matter which project the plugin is loaded into.
 */
export function defaultModelDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // plugin/src/model -> plugin/src -> plugin -> <root>
  const inPackage = path.resolve(here, "..", "..", "..", "models");
  if (existsSync(inPackage)) return inPackage;
  return path.join(stateRoot(), "models");
}

/** Absolute path to the inference server's entry file, for the autostart spawn. */
export function serverEntryPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // plugin/src/model -> plugin -> serve/server.mjs
  return path.resolve(here, "..", "..", "serve", "server.mjs");
}

/**
 * 运行时 manifest（`plugin/serve/runtime.json`）里的 nightly tag，
 * 与 `plugin/serve/server.mjs` 的 `readRuntimeManifest` 读同一份文件——
 * 下载校验与路径拼接只有一个来源，换版本改一处。行身份不走 tag
 * （见 `embedderIdFor`）。
 *
 * 读不到（文件缺失、JSON 坏）返回 `"unknown"`：宁可让页面照实报坏安装，
 * 也不编一个假 tag——编出来的串会让坏安装看起来是好的。
 */
export function runtimeTag(): string {
  const file = path.join(path.dirname(serverEntryPath()), "runtime.json");
  try {
    const manifest = JSON.parse(readFileSync(file, "utf8")) as { tag?: unknown };
    if (typeof manifest.tag === "string" && manifest.tag.length > 0) return manifest.tag;
  } catch {
    // fall through
  }
  return "unknown";
}

/**
 * 运行时落地目录与 zip 的路径，命名与 `plugin/serve/server.mjs` 的
 * `runtimeDir()` / `runtimeAssetFile()` 一一对应（`llama-<tag>-win-<变体>-x64`
 * 与 `llama-<tag>-bin-win-<变体>-x64.zip`；CUDA 变体的文件名段取
 * runtime.json 的 `assets.cuda.variant`，如 `cuda-13.4`）——网页 Runtime 页用
 * 它报"下载了没有"，server.mjs 改名这里要跟着改（同 LEGACY_GPU 的约定）。
 * tag 为 `"unknown"` 时路径仍拼出来，但页面以 `runtimeTag()` 判坏安装。
 */
function variantFileSuffix(variant: RuntimeVariant): string {
  if (variant === "vulkan") return "vulkan";
  if (variant === "cpu") return "cpu";
  return readRuntimeManifest()?.cuda?.variant ?? "cuda";
}

export function runtimeDirPath(variant: RuntimeVariant = "vulkan"): string {
  return path.join(stateRoot(), "runtime", `llama-${runtimeTag()}-win-${variantFileSuffix(variant)}-x64`);
}

export function runtimeZipPath(variant: RuntimeVariant = "vulkan"): string {
  return path.join(stateRoot(), "runtime", `llama-${runtimeTag()}-bin-win-${variantFileSuffix(variant)}-x64.zip`);
}

/** CUDA 的第二个包（官方把 cudart 拆成独立 zip）。Vulkan/CPU 没有此物，调用方勿对其用。 */
export function runtimeCudartZipPath(): string {
  return path.join(stateRoot(), "runtime", `cudart-llama-bin-win-${variantFileSuffix("cuda")}-x64.zip`);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 同变体家族里「装过且还能跑」的最高 tag——LM 的 `localVersion` 维度（机主
 * 2026-11-05 拍板对齐 LM：装了旧版 ≠ 没装，两维要分开报）。钉死 tag 的目录
 * 在位则返回钉死值；否则扫 `llama-b<N>-win-<变体串>-x64` 里带
 * llama-server.exe 的最高 N；家族什么都没有 → null。与 server.mjs 的
 * `findInstalledVariantDir` 同一算法——那边是运行侧的回退，这里是报装侧的
 * 实况，两边不一致页面就会骗人（同 runtimeDirPath 改名要跟着改的约定）。
 */
export function installedRuntimeTag(variant: RuntimeVariant = "vulkan"): string | null {
  if (existsSync(path.join(runtimeDirPath(variant), "llama-server.exe"))) return runtimeTag();
  const re = new RegExp(`^llama-b(\\d+)-win-${escapeRegExp(variantFileSuffix(variant))}-x64$`);
  let best: number | null = null;
  try {
    for (const entry of readdirSync(runtimeFilesDir(), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const match = re.exec(entry.name);
      if (!match) continue;
      if (!existsSync(path.join(runtimeFilesDir(), entry.name, "llama-server.exe"))) continue;
      const n = Number(match[1]);
      if (best === null || n > best) best = n;
    }
  } catch {
    return null; // runtime/ 还没出生 = 该家族确实没装过
  }
  return best === null ? null : `b${best}`;
}

/**
 * 服务实际会用的运行时目录：钉死版在位用它，否则回退家族最新——与
 * server.mjs `ensureRuntime` 的正常启动回退一一对应。家族也空时返回钉死
 * 路径原样（调用方自己 existsSync，形状不变）。
 */
export function effectiveRuntimeDirPath(variant: RuntimeVariant = "vulkan"): string {
  const installed = installedRuntimeTag(variant);
  if (installed === null || installed === runtimeTag()) return runtimeDirPath(variant);
  return path.join(stateRoot(), "runtime", `llama-${installed}-win-${variantFileSuffix(variant)}-x64`);
}

/** runtime 落地目录本身（`<stateRoot>/runtime`）——「已下载文件」列表从这里枚举。 */
export function runtimeFilesDir(): string {
  return path.join(stateRoot(), "runtime");
}

/** 已下载文件列表的一行（Runtime 页「删除已下载文件」弹层的数据）。 */
export type RuntimeFileEntry = {
  /** 文件名，无路径分隔符（删除时原样传回，服务端再验一次）。 */
  name: string;
  kind: "directory" | "zip";
  /** 文件名里的 nightly tag（`b12121`）；cudart 包不带 tag → null。 */
  tag: string | null;
  sizeBytes: number | null;
};

/**
 * 某变体在盘上会出现的文件名模式，与 `serve/server.mjs` 的命名一一对应
 * （`runtimeDir()` / `runtimeAssetFile()` / `cudartAssetFile()`）。
 *
 * 按**家族**匹配而非当前 manifest 的精确后缀：CUDA 的后缀带官方版本串
 * （`cuda-13.4`），换版本后旧后缀的目录/zip 成为孤儿——列表按当前后缀
 * 过滤会恰好看不见最该删的东西。Vulkan/CPU 键名即串名，没有这个问题。
 */
function runtimeFilePatterns(variant: RuntimeVariant): { dir: RegExp; zip: RegExp[] } {
  if (variant === "cuda") {
    return {
      dir: /^llama-b\d+-win-cuda(?:-[\d.]+)?-x64$/,
      zip: [
        /^llama-b\d+-bin-win-cuda(?:-[\d.]+)?-x64\.zip$/,
        /^cudart-llama-bin-win-cuda(?:-[\d.]+)?-x64\.zip$/,
      ],
    };
  }
  return {
    dir: new RegExp(`^llama-b\\d+-win-${variant}-x64$`),
    zip: [new RegExp(`^llama-b\\d+-bin-win-${variant}-x64\\.zip$`)],
  };
}

/**
 * 枚举某变体在盘上的全部已下载文件（所有 tag：当前的、旧 tag 的孤儿、
 * 残留 zip 都在内）。目录不存在 → 空列表（temp 隔离与全新安装都走这里）。
 * 排序：新 tag 在前，同 tag 目录在 zip 前，cudart（无 tag）垫底。
 */
export function listRuntimeFiles(variant: RuntimeVariant): RuntimeFileEntry[] {
  const root = runtimeFilesDir();
  const patterns = runtimeFilePatterns(variant);
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  const out: RuntimeFileEntry[] = [];
  for (const name of names) {
    const isDir = patterns.dir.test(name);
    const isZip = !isDir && patterns.zip.some((re) => re.test(name));
    if (!isDir && !isZip) continue;
    try {
      const st = statSync(path.join(root, name));
      // 模式认了但形态不对（zip 名的目录等）→ 跳过，不猜。
      if (isDir !== st.isDirectory()) continue;
      out.push({
        name,
        kind: isDir ? "directory" : "zip",
        tag: /^llama-(b\d+)-/.exec(name)?.[1] ?? null,
        sizeBytes: st.isDirectory() ? dirSizeBytes(path.join(root, name)) : st.size,
      });
    } catch {
      // 并发删除/权限问题 → 这条看不见即可，列表不该整页失败。
    }
  }
  out.sort((a, b) => {
    const ta = a.tag ? Number(a.tag.slice(1)) : -1;
    const tb = b.tag ? Number(b.tag.slice(1)) : -1;
    if (ta !== tb) return tb - ta;
    if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return out;
}

/** 递归求目录字节数（运行时解压目录只有几十个文件，代价可忽略）；出错返回 null。 */
function dirSizeBytes(dir: string): number | null {
  let total = 0;
  const stack = [dir];
  try {
    while (stack.length > 0) {
      const current = stack.pop() as string;
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) stack.push(full);
        else total += statSync(full).size;
      }
    }
    return total;
  } catch {
    return null;
  }
}

/**
 * 单个已下载文件的落点：名字必须属于该变体的模式且不带路径分隔符，
 * 否则返回 null——**不猜、不拼**，删除接口只能删列表里会出现的东西。
 */
export function resolveRuntimeFile(
  variant: RuntimeVariant,
  name: string,
): { path: string; kind: "directory" | "zip" } | null {
  if (name.length === 0 || name.includes("/") || name.includes("\\") || name.includes("..")) return null;
  const patterns = runtimeFilePatterns(variant);
  if (patterns.dir.test(name)) return { path: path.join(runtimeFilesDir(), name), kind: "directory" };
  if (patterns.zip.some((re) => re.test(name))) return { path: path.join(runtimeFilesDir(), name), kind: "zip" };
  return null;
}

/**
 * 引擎变体（机主 2026-11-04 拍板：Runtime 页像 LM Studio 那样可选，CUDA 做成
 * 真可选；2026-11-05 拍板：允许 CPU 推理，无 GPU 的机器也能跑向量服务）。
 * `vulkan` 是默认与安装器预下载的那一个；`cuda` 的落地文件名带官方
 * CUDA 版本串（runtime.json `assets.cuda.variant`，如 `cuda-13.4`），下载时
 * 由 server.mjs 现取；`cpu` 文件名段就是 `cpu`。切换**即时生效**（机主
 * 2026-11-05 拍板，对齐 LM 的「选中即生效」）：select 写完配置立即重启
 * 推理服务，spawn 时活读配置（`readRuntimeSpawnFlags`），不再等 OpenCode
 * 重载（行身份不随后端走，见 embedderIdFor）。
 */
export type RuntimeVariant = "vulkan" | "cuda" | "cpu";

/** runtime.json 全文（比 runtimeTag 多带 assets）。坏/缺 → null，调用方按"未知安装"降级。 */
export type RuntimeManifest = {
  tag: string;
  vulkan: { sha256: string; sizeBytes: number };
  /** CPU 包可选（与 cuda 同规矩：没有它 cpu 行装不了，vulkan 照跑）。 */
  cpu?: { sha256: string; sizeBytes: number };
  cuda?: {
    variant: string;
    sha256: string;
    sizeBytes: number;
    cudartSha256: string;
    cudartSizeBytes: number;
  };
};

export function readRuntimeManifest(): RuntimeManifest | null {
  const file = path.join(path.dirname(serverEntryPath()), "runtime.json");
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as {
      tag?: unknown;
      assets?: { vulkan?: unknown; cuda?: unknown; cpu?: unknown };
    };
    if (typeof parsed.tag !== "string" || !/^b\d+$/.test(parsed.tag)) return null;
    const v = parsed.assets?.vulkan as { sha256?: unknown; sizeBytes?: unknown } | undefined;
    if (typeof v?.sha256 !== "string" || typeof v.sizeBytes !== "number") return null;
    const out: RuntimeManifest = {
      tag: parsed.tag,
      vulkan: { sha256: v.sha256, sizeBytes: v.sizeBytes },
    };
    const p = parsed.assets?.cpu as { sha256?: unknown; sizeBytes?: unknown } | undefined;
    if (typeof p?.sha256 === "string" && typeof p.sizeBytes === "number") {
      out.cpu = { sha256: p.sha256, sizeBytes: p.sizeBytes };
    }
    const c = parsed.assets?.cuda as
      | { variant?: unknown; sha256?: unknown; sizeBytes?: unknown; cudartSha256?: unknown; cudartSizeBytes?: unknown }
      | undefined;
    if (
      c &&
      typeof c.variant === "string" &&
      typeof c.sha256 === "string" &&
      typeof c.sizeBytes === "number" &&
      typeof c.cudartSha256 === "string" &&
      typeof c.cudartSizeBytes === "number"
    ) {
      out.cuda = {
        variant: c.variant,
        sha256: c.sha256,
        sizeBytes: c.sizeBytes,
        cudartSha256: c.cudartSha256,
        cudartSizeBytes: c.cudartSizeBytes,
      };
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * 行身份用的嵌入器串：`<模型路径>@llamacpp`。
 *
 * model 行的三处写入与 repair 的 stale 判定都必须经这一个函数，不能各自
 * 拼字符串。
 *
 * 不带 nightly tag、不带 vulkan/cuda/cpu 后端后缀（2026-11-05 机主拍板）。
 * 判据是实测：同模型同后端跨 nightly（b12098 vs b12119）5/5 条 cos
 * = 1.000000；cpu vs vulkan 30 条真实 index chunk min 0.999528 / mean
 * 0.999784 / max 0.999909——换 tag、换后端算出的都是同一批向量，进身份
 * 只会白烧全量重嵌（活区 2160 chunks 已被自动对齐翻 tag 烧过一轮）。
 * 旧设计"宁可全重嵌不可错认"的 `-cuda` 后缀随之作废；cuda vs vulkan 无
 * NVIDIA 卡未实测，按同家族假设接受（有反例再加后缀，记档于此）。
 *
 * 家族标记 `@llamacpp` 保留：新旧引擎家族 cos 0.93–0.98 不能混（见
 * `ModelConfig.embedderId` 字段注释）。
 */
export function embedderIdFor(embedModelPath: string): string {
  return `${embedModelPath}@llamacpp`;
}

/**
 * Where the inference service lives.
 *
 * 4748 rather than 4747 because opencode-mem already owns 4747 for its memory
 * management web UI; running both on one machine must not collide.
 */
export const DEFAULT_SERVICE_PORT = 4748;

export type ServiceConfig = {
  /** Set this to bypass discovery and autostart entirely (a service you started yourself). */
  readonly url?: string;
  readonly host: string;
  readonly port: number;
  /** Whether the plugin may start the service when nothing answers. */
  readonly autostart: boolean;
  /** How long the service may sit unused before it exits. `0` disables the reaper. */
  readonly idleMinutes: number;
  /** How long to wait for a freshly spawned service to report healthy. */
  readonly startTimeoutMs: number;
  /**
   * Which llama.cpp backend the service spawns（Runtime 页下拉写入）。
   * 装载期读入、随进程重载翻转（spawn 参数；行身份不走它，见 RuntimeVariant）。
   */
  readonly runtimeVariant: RuntimeVariant;
  /**
   * 运行时 zip 不在盘上时服务启动要不要自动联网补下（Runtime 页开关）。
   * 与 spawn 的其余开关一样 **spawn 时活读 config.jsonc**
   * （`readRuntimeSpawnFlags`），页面改完下次重启服务即生效，不必等插件
   * 重载——它与行身份无耦合。关着时缺 zip = 快速失败并指路网页按钮，
   * 不再自己联网；开着时**保持最新**也由它管（启动/准备时对齐上游最新
   * nightly，见 server.mjs applyLatestNightly 与 index.ts 的启动对齐）。
   */
  readonly autoPrepareRuntime: boolean;
};

export function readServiceConfig(options: unknown): ServiceConfig {
  const root =
    typeof options === "object" && options !== null ? (options as Record<string, unknown>) : {};
  const nested =
    typeof root["service"] === "object" && root["service"] !== null
      ? (root["service"] as Record<string, unknown>)
      : {};

  return {
    url: readString(nested["url"]),
    host: readString(nested["host"]) ?? "127.0.0.1",
    port: readNumber(nested["port"], DEFAULT_SERVICE_PORT, 1, 65_535),
    autostart: nested["autostart"] !== false,
    idleMinutes: readNumber(nested["idleMinutes"], 5, 0, 1_440),
    startTimeoutMs: readNumber(nested["startTimeoutMs"], 30_000, 1_000, 300_000),
    runtimeVariant: readRuntimeVariant(nested["runtimeVariant"]) ?? "vulkan",
    autoPrepareRuntime: nested["autoPrepareRuntime"] !== false,
  };
}

/**
 * spawn 时刻活读的开关（auto-prepare 与引擎变体）。装载期捕获值打底，
 * config.jsonc 里页面写过的值覆盖——页面改完**下次 spawn** 即生效，不必等
 * 插件重载。变体也活读：select 只写配置，服务已经在跑才顺手重启换引擎
 * （机主 2026-11-06 定，照 LM Studio：选中不等于起服务）。
 * 文件读失败（无 settings 文件）→ 原样返回捕获值。
 */
export function readRuntimeSpawnFlags(captured: ServiceConfig): {
  autoPrepareRuntime: boolean;
  runtimeVariant: RuntimeVariant;
} {
  try {
    const file = readConfigFile(stateRoot());
    const options = (file.options ?? {}) as { service?: unknown };
    const nested =
      typeof options.service === "object" && options.service !== null
        ? (options.service as Record<string, unknown>)
        : {};
    return {
      autoPrepareRuntime:
        nested["autoPrepareRuntime"] === undefined
          ? captured.autoPrepareRuntime
          : nested["autoPrepareRuntime"] !== false,
      runtimeVariant: readRuntimeVariant(nested["runtimeVariant"]) ?? captured.runtimeVariant,
    };
  } catch {
    return {
      autoPrepareRuntime: captured.autoPrepareRuntime,
      runtimeVariant: captured.runtimeVariant,
    };
  }
}

/** 配置里的变体字符串 → RuntimeVariant；不认识的值 → null（调用方给默认）。 */
function readRuntimeVariant(value: unknown): RuntimeVariant | null {
  return value === "cuda" ? "cuda" : value === "cpu" ? "cpu" : value === "vulkan" ? "vulkan" : null;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function readGpu(value: unknown): GpuPreference {
  if (value === "auto" || value === "discrete" || value === "integrated") return value;
  if (typeof value === "string" && LEGACY_GPU[value] !== undefined) return LEGACY_GPU[value];
  // CPU inference was removed (discrete > integrated, no fallback to CPU): a
  // legacy "cpu" value or anything else is demoted to "auto".
  return "auto";
}

function readLogLevel(value: unknown): ModelConfig["logLevel"] {
  if (value === "silent" || value === "warn" || value === "info" || value === "debug") return value;
  return "warn";
}

/**
 * `model.hostedModel` as the string users actually type in `opencode.jsonc`
 * (`"providerID/modelID"`), or as the object form `{ providerID, modelID }`.
 * Split on the first slash only: model ids carry slashes themselves
 * (`openrouter/anthropic/claude-sonnet-4`). A malformed value yields
 * `undefined` -- i.e. OpenCode's default choice, never a thrown config error.
 */
function readHostedModel(value: unknown): HostedModelRef | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    const slash = trimmed.indexOf("/");
    if (slash <= 0 || slash === trimmed.length - 1) return undefined;
    return { providerID: trimmed.slice(0, slash), id: trimmed.slice(slash + 1) };
  }
  if (typeof value === "object" && value !== null) {
    const ref = value as Record<string, unknown>;
    const providerID = readString(ref["providerID"]);
    const id = readString(ref["modelID"]) ?? readString(ref["id"]);
    if (providerID && id) return { providerID, id };
  }
  return undefined;
}

function readGpuLayers(value: unknown): number | "auto" {
  if (value === "auto") return "auto";
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.min(999, Math.max(0, Math.trunc(value)));
  }
  return "auto";
}

/** 显存预留（GB）：有限数字才收，钳在 0–64；null = 引擎自己的默认。 */
function readVramPadding(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.min(64, Math.max(0, value));
  }
  return null;
}

/**
 * Embedding requirement, ported from openclaw's
 * `MemoryEmbeddingProviderRequirement` (extensions/memory-core/src/memory/
 * manager-provider-lifecycle.ts): the two model slots fail independently, and a
 * missing embedding model degrades search to keyword-only instead of taking the
 * whole memory subsystem down with it.
 *
 * - `"required"`: the user pointed at a specific embedding model and it is not
 *   there -- report it, do not silently search worse than asked.
 * - `"optional"`: no explicit choice, or the model is simply absent (the common
 *   case: a text-only install). Vector search is off, everything else works.
 * - `"fts-only"`: `model.embed: false` -- embeddings were turned off on purpose.
 */
export type EmbedRequirementMode = "required" | "optional" | "fts-only";

export type EmbedAvailability = {
  readonly mode: EmbedRequirementMode;
  readonly missingPath?: string;
};

/**
 * Decide how the embedding slot behaves, openclaw-style: an explicit path is a
 * requirement, everything else is optional.
 */
export function resolveEmbedAvailability(config: ModelConfig): EmbedAvailability {
  if (!config.embedEnabled) return { mode: "fts-only" };
  if (existsSync(config.embedModelPath)) return { mode: "optional" };
  return config.embedPathExplicit
    ? { mode: "required", missingPath: config.embedModelPath }
    : { mode: "optional", missingPath: config.embedModelPath };
}

/** GGUF files that are not where the config says they should be. Embedding is the only slot. */
export function missingModelPaths(config: ModelConfig): string[] {
  return existsSync(config.embedModelPath) ? [] : [config.embedModelPath];
}

/** Permissive read: `ctx.options` is untyped JSON supplied by opencode.json(c). */
export function readModelConfig(options: unknown): ModelConfig {
  const root =
    typeof options === "object" && options !== null ? (options as Record<string, unknown>) : {};
  const nested =
    typeof root["model"] === "object" && root["model"] !== null
      ? (root["model"] as Record<string, unknown>)
      : {};

  const modelDir = readString(nested["dir"]) ?? readString(root["modelDir"]) ?? defaultModelDir();
  const embedModelPath = readString(nested["embedPath"]) ?? path.join(modelDir, "bge-m3-Q8_0.gguf");

  return {
    hostedModel: readHostedModel(nested["hostedModel"]),
    gpu: readGpu(nested["gpu"] ?? root["gpu"]),
    modelDir,
    embedModelPath,
    embedderId: embedderIdFor(embedModelPath),
    embedEnabled: nested["embed"] !== false,
    embedPathExplicit: readString(nested["embedPath"]) !== undefined,
    threads: readNumber(nested["threads"], 0, 0, 128),
    gpuLayers: readGpuLayers(nested["gpuLayers"]),
    vramPadding: readVramPadding(nested["vramPadding"]),
    logLevel: readLogLevel(nested["logLevel"]),
  };
}
