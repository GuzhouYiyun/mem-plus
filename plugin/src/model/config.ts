// Configuration for the local GGUF inference the plugin drives.
//
// WHY LOCAL INFERENCE EXISTS AT ALL
//   openclaw does not ship a GGUF runtime: it reaches one through either the
//   `@openclaw/llama-cpp-provider` plugin (a managed llama-server) or an Ollama
//   endpoint. mem-plus offers the same thing itself -- the models are loaded from
//   disk by `node-llama-cpp` in a separate Node process (see `serve/server.mjs`
//   for why the plugin process cannot host them) -- so a `model.content: "local"`
//   install never sends anything off the machine.
//
// WHICH MODEL SUMMARISES, BY DEFAULT
//   `opencode`. The alternative is `ctx.generate.text`, which runs the prompt on
//   whichever OpenCode model the user has configured: no GGUF to download, no GPU
//   to have, and the summary comes from a model that is usually better at
//   following the extraction schema than a 4B local one. Someone who wants the
//   local path says `"local"` and gets a machine-local pipeline.
//
//   Note what this default does *not* decide: whether the requests cost anything.
//   That depends entirely on which provider the user's OpenCode model is pointed
//   at, which is not this plugin's business to characterise.
//
// FALLBACK IS STILL OPT-IN
//   `model.allowHostedFallback` is about the *local* path failing, and it defaults
//   to false: a missing GGUF, an uninstalled dependency or a busy port would
//   otherwise silently change which model is answering, with nothing but a log
//   line to show for it. Off means extraction is skipped, the snapshot is kept,
//   and the landing zone retries when the service is back.
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
import { existsSync } from "node:fs";
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

/** Which model produces capture summaries. `opencode` routes to `ctx.generate.text`. */
export type ContentBackend = "local" | "opencode";

/**
 * An OpenCode model reference: the model that produces capture summaries when
 * `model.content` is `"opencode"` (the default). Optional on purpose -- leaving it
 * unset keeps OpenCode's own model choice, which is the behavior without this option.
 *
 * Field names match `@opencode/client`'s `ModelRef` (`providerID` + `id`) so it
 * can be handed to `ctx.generate.text` without reshaping. Users still write the
 * familiar `"providerID/modelID"` string in `opencode.jsonc`; see `readHostedModel`.
 */
export type HostedModelRef = { readonly providerID: string; readonly id: string };

export type ModelConfig = {
  /**
   * `"opencode"` (the default) sends extraction to `ctx.generate.text`. `"local"`
   * runs it on the GGUF through the inference service instead.
   */
  readonly contentBackend: ContentBackend;
  /**
   * Which OpenCode model `ctx.generate.text` should use. `undefined` = OpenCode's
   * default choice.
   */
  readonly hostedModel?: HostedModelRef;
  /**
   * Whether an *unavailable local service* may be covered by the OpenCode model.
   * Defaults to `false`: with it off, a local failure skips the extraction for that
   * turn and leaves the record pending for retry, rather than silently switching
   * which model is answering for as long as the problem lasts.
   */
  readonly allowHostedFallback: boolean;
  readonly gpu: GpuPreference;
  readonly modelDir: string;
  readonly contentModelPath: string;
  readonly embedModelPath: string;
  /** `model.embed: false` = fts-only, the openclaw `provider: "none"` mode. */
  readonly embedEnabled: boolean;
  /**
   * Whether the user named an embedding file. An explicit path that is missing
   * is a broken configuration (reported); an absent default is just "no vectors
   * here", which degrades silently.
   */
  readonly embedPathExplicit: boolean;
  /** KV-cache size for the extraction session. The capture prompt is bounded at 128 KB. */
  readonly contextSize: number;
  readonly maxNewTokens: number;
  /** CPU threads for host-side work (inference itself runs on the GPU). */
  readonly threads: number;
  /**
   * Layers pushed to the GPU. `"auto"` sizes the offload to current VRAM and
   * reserves room for the KV cache -- safer than forcing every layer onto an
   * iGPU whose shared memory is already partly claimed by the desktop.
   */
  readonly gpuLayers: number | "auto";
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
    idleMinutes: readNumber(nested["idleMinutes"], 10, 0, 1_440),
    startTimeoutMs: readNumber(nested["startTimeoutMs"], 30_000, 1_000, 300_000),
  };
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
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

/** GGUF files that are not where the config says they should be (both slots). */
export function missingModelPaths(config: ModelConfig): string[] {
  const missing: string[] = [];
  if (!existsSync(config.contentModelPath)) missing.push(config.contentModelPath);
  if (!existsSync(config.embedModelPath)) missing.push(config.embedModelPath);
  return missing;
}

/** Only the extraction slot: extraction cannot run without it. */
export function missingContentPaths(config: ModelConfig): string[] {
  return existsSync(config.contentModelPath) ? [] : [config.contentModelPath];
}

/** Permissive read: `ctx.options` is untyped JSON supplied by opencode.json(c). */
export function readModelConfig(options: unknown): ModelConfig {
  const root =
    typeof options === "object" && options !== null ? (options as Record<string, unknown>) : {};
  const nested =
    typeof root["model"] === "object" && root["model"] !== null
      ? (root["model"] as Record<string, unknown>)
      : {};

  // `opencode` is the default: no GGUF to fetch, no GPU to need, and the model the
  // user already configured. `"local"` opts into the on-machine pipeline.
  const rawBackend = readString(nested["content"]) ?? readString(root["contentModel"]);
  const contentBackend: ContentBackend = rawBackend === "local" ? "local" : "opencode";

  const modelDir = readString(nested["dir"]) ?? readString(root["modelDir"]) ?? defaultModelDir();

  return {
    contentBackend,
    hostedModel: readHostedModel(nested["hostedModel"]),
    allowHostedFallback: readBoolean(nested["allowHostedFallback"]) ?? false,
    gpu: readGpu(nested["gpu"] ?? root["gpu"]),
    modelDir,
    contentModelPath:
      readString(nested["contentPath"]) ?? path.join(modelDir, "Qwen3.5-4B-Q4_K_M.gguf"),
    embedModelPath: readString(nested["embedPath"]) ?? path.join(modelDir, "bge-m3-FP16.gguf"),
    embedEnabled: nested["embed"] !== false,
    embedPathExplicit: readString(nested["embedPath"]) !== undefined,
    contextSize: readNumber(nested["contextSize"], 16_384, 512, 262_144),
    maxNewTokens: readNumber(nested["maxNewTokens"], 512, 32, 8_192),
    threads: readNumber(nested["threads"], 0, 0, 128),
    gpuLayers: readGpuLayers(nested["gpuLayers"]),
    logLevel: readLogLevel(nested["logLevel"]),
  };
}
