// Configuration for the local GGUF inference the plugin drives.
//
// WHY LOCAL INFERENCE
//   openclaw does not ship a GGUF runtime: it reaches one through either the
//   `@openclaw/llama-cpp-provider` plugin (a managed llama-server) or an Ollama
//   endpoint. mem-plus does neither -- the models are loaded from disk by
//   `node-llama-cpp` in a separate Node process (see `serve/server.mjs` for why
//   the plugin process cannot host them), so extraction and embedding never
//   leave the machine.
//
// COST OF FAILURE IS THE POINT OF `allowHostedFallback`
//   When local inference is unavailable, the alternative transport is
//   `ctx.generate.text` -- the user's own paid OpenCode model. Defaulting to it
//   means a missing GGUF, an uninstalled dependency or a busy port quietly
//   converts a free local pipeline into metered API calls, with nothing but a
//   log line to show for it. That is the opposite of what this plugin promises,
//   so the fallback is opt-in (`model.allowHostedFallback`). The default is to
//   skip extraction, keep the snapshot, and let the landing zone retry when the
//   service is back -- a lost summary is recoverable, silent billing is not.
//
// BACKEND PRIORITY
//   discrete GPU > integrated GPU > CPU, resolved explicitly rather than handed
//   to `gpu: "auto"`, so which one won is observable in the log instead of
//   guessed at.
//
// EVERYTHING IS OVERRIDABLE THROUGH `ctx.options`, because the model directory
// in particular is machine-local: it lives next to the checkout by default and
// has no business being hard-coded for anyone who installs this elsewhere.
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type GpuPreference = "auto" | "cuda" | "vulkan" | "cpu";

/** Which model produces capture summaries. `opencode` routes to `ctx.generate.text`. */
export type ContentBackend = "local" | "opencode";

export type ModelConfig = {
  /**
   * `"opencode"` sends extraction to `ctx.generate.text` on purpose, by explicit
   * configuration. This is an opt-in, not a failure mode.
   */
  readonly contentBackend: ContentBackend;
  /**
   * Whether an *unavailable local service* may be covered by the user's paid
   * OpenCode model. Defaults to `false`: with it off, a local failure skips the
   * extraction for that turn and leaves the record pending for retry, which
   * costs nothing, whereas falling back spends money on every turn for as long
   * as the problem lasts.
   */
  readonly allowHostedFallback: boolean;
  readonly gpu: GpuPreference;
  readonly modelDir: string;
  readonly contentModelPath: string;
  readonly embedModelPath: string;
  /** KV-cache size for the extraction session. The capture prompt is bounded at 128 KB. */
  readonly contextSize: number;
  readonly maxNewTokens: number;
  /** CPU threads; only consulted by the CPU fallback backend. */
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
 * `<checkout>/models` -- resolved from this file rather than from `process.cwd()`
 * so it holds no matter which project the plugin is loaded into.
 */
export function defaultModelDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // plugin/src/model -> plugin/src -> plugin -> <checkout>
  return path.resolve(here, "..", "..", "..", "models");
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
  if (value === "auto" || value === "cuda" || value === "vulkan" || value === "cpu") return value;
  return "auto";
}

function readLogLevel(value: unknown): ModelConfig["logLevel"] {
  if (value === "silent" || value === "warn" || value === "info" || value === "debug") return value;
  return "warn";
}

function readGpuLayers(value: unknown): number | "auto" {
  if (value === "auto") return "auto";
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.min(999, Math.max(0, Math.trunc(value)));
  }
  return "auto";
}

/** GGUF files that are not where the config says they should be. */
export function missingModelPaths(config: ModelConfig): string[] {
  const missing: string[] = [];
  if (!existsSync(config.contentModelPath)) missing.push(config.contentModelPath);
  if (!existsSync(config.embedModelPath)) missing.push(config.embedModelPath);
  return missing;
}

/** Permissive read: `ctx.options` is untyped JSON supplied by opencode.json(c). */
export function readModelConfig(options: unknown): ModelConfig {
  const root =
    typeof options === "object" && options !== null ? (options as Record<string, unknown>) : {};
  const nested =
    typeof root["model"] === "object" && root["model"] !== null
      ? (root["model"] as Record<string, unknown>)
      : {};

  const rawBackend = readString(nested["content"]) ?? readString(root["contentModel"]);
  const contentBackend: ContentBackend = rawBackend === "opencode" ? "opencode" : "local";

  const modelDir = readString(nested["dir"]) ?? readString(root["modelDir"]) ?? defaultModelDir();

  return {
    contentBackend,
    allowHostedFallback: readBoolean(nested["allowHostedFallback"]) ?? false,
    gpu: readGpu(nested["gpu"] ?? root["gpu"]),
    modelDir,
    contentModelPath:
      readString(nested["contentPath"]) ?? path.join(modelDir, "qwen3.5-4b-q4_k_m.gguf"),
    embedModelPath: readString(nested["embedPath"]) ?? path.join(modelDir, "bge-m3-f16.gguf"),
    contextSize: readNumber(nested["contextSize"], 16_384, 512, 262_144),
    maxNewTokens: readNumber(nested["maxNewTokens"], 512, 32, 8_192),
    threads: readNumber(nested["threads"], 0, 0, 128),
    gpuLayers: readGpuLayers(nested["gpuLayers"]),
    logLevel: readLogLevel(nested["logLevel"]),
  };
}
