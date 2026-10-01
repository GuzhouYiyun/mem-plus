// Plugin half of the local inference path.
//
// The GGUF runtime lives in a separate Node process (`serve/server.mjs`) because
// node-llama-cpp self-tests its native binding by forking `process.execPath`, and
// inside OpenCode that path is the bun binary rather than node -- the fork always
// fails, the binding never loads, and there is no compiler to fall back to. See
// the header of server.mjs for the full reasoning.
//
// This file only speaks HTTP. That boundary is what makes the arrangement
// pleasant rather than merely possible:
//
//   - one model instance is shared by every project, so four OpenCode windows
//     cost one 4 GB load instead of four;
//   - the service can outlive a single `opencode run` if you want it warm, or be
//     started on demand and reaped on idle if you do not;
//   - when something goes wrong you can curl it instead of reading plugin internals.
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { request as httpRequest } from "node:http";
import type { ModelConfig, ServiceConfig } from "./config.js";
import { serverEntryPath } from "./config.js";

export type ClientLog = (message: string, detail?: unknown) => void;

export type ServiceHealth = {
  ok: boolean;
  service?: string;
  port?: number | null;
  backend?: string;
  loaded?: { content?: boolean; embed?: boolean };
  present?: { content?: boolean; embed?: boolean };
};

export type MemPlusService = {
  /** Base URL once known, e.g. `http://127.0.0.1:4748`. `null` before first use. */
  readonly url: string | null;
  /** What `/health` said the last time we asked; `null` if never reachable. */
  readonly health: ServiceHealth | null;
  /**
   * Whether extraction is possible right now, starting the service if needed.
   *
   * Called *before* a sweep claims any work. `maxRetries` is 3 with a 2 s base
   * delay, so letting an unreachable service fail inside the pipeline burns the
   * whole retry budget in about six seconds and then parks the record for good --
   * a ten-second outage would cost a memory permanently. Gating here means an
   * outage leaves every prompt untouched and pending instead.
   */
  ready(): Promise<boolean>;
  extract(params: { systemPrompt: string; prompt: string }): Promise<string>;
  /**
   * `signal` comes from the tool call's context, so stopping a session also stops
   * the embed request it started. On this hardware an embed takes seconds, so
   * that is the difference between an interrupt and a visible stall.
   */
  embed(input: string, signal?: AbortSignal): Promise<readonly number[]>;
  /** Stops the service, but only if this plugin was the one that started it. */
  dispose(): Promise<void>;
};

/**
 * Minimal JSON POST. Bun's `fetch` works here, but `node:http` avoids a 100 ms DNS
 * hop per call.
 *
 * `signal` is honoured because a tool call made on behalf of a session must stop
 * when that session is stopped. Without it, interrupting a `memory_search` that
 * is waiting on the embed model would leave the request running to completion --
 * and an embed on this hardware is seconds, not milliseconds.
 */
function postJson(
  url: string,
  body: unknown,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const payload = Buffer.from(JSON.stringify(body), "utf8");
    const req = httpRequest(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname + target.search,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(payload.byteLength),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          try {
            resolve({ status: res.statusCode ?? 0, json: text.length > 0 ? JSON.parse(text) : {} });
          } catch {
            resolve({ status: res.statusCode ?? 0, json: { error: text.slice(0, 200) } });
          }
        });
      },
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`request timed out after ${timeoutMs} ms`));
    });
    req.on("error", reject);
    // Aborting must also unhook, or a later abort on an already-settled request
    // would try to touch a destroyed socket and surface as an unhandled error.
    const onAbort = (): void => {
      req.destroy(new Error("aborted"));
    };
    if (signal) {
      if (signal.aborted) {
        onAbort();
        reject(new Error("aborted"));
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      req.on("close", () => signal.removeEventListener("abort", onAbort));
    }
    req.end(payload);
  });
}

function getJson(url: string, timeoutMs: number): Promise<ServiceHealth | null> {
  return new Promise((resolve) => {
    const target = new URL(url);
    const req = httpRequest(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname + target.search,
        method: "GET",
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as ServiceHealth);
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy());
    req.on("error", () => resolve(null));
    req.end();
  });
}

function describeError(value: unknown): string {
  if (value && typeof value === "object" && "error" in value) {
    return String((value as { error: unknown }).error);
  }
  return String(value);
}

/**
 * The port the server will actually settle on cannot be known in advance (it
 * walks forward off the base port when busy), so readiness is found by polling
 * the candidate range until the deadline.
 *
 * The retry loop is the whole point. A freshly spawned server needs ~80 ms to
 * reach `listen`, while on Windows a refused connection returns in ~1 ms, so a
 * single sweep of the range finishes long before the service is up -- with one
 * pass this timed out 14 ms after spawn and every extraction silently fell back
 * to the OpenCode-hosted model.
 */
async function findRunningService(
  config: ServiceConfig,
  rangeSize: number,
  timeoutMs: number,
): Promise<{ url: string; health: ServiceHealth } | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    for (let offset = 0; offset < rangeSize; offset++) {
      const url = `http://${config.host}:${config.port + offset}`;
      const health = await getJson(`${url}/health`, 1_500);
      if (health?.ok && health.service === "mem-plus") return { url, health };
    }
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * llama.cpp warns about `blk.32.*` on this checkpoint: block 32 is the
 * multi-token-prediction head, which single-token decoding never touches.
 * Harmless, but it arrives one line at a time and buries the lines that
 * matter, so it is dropped at the relay rather than silenced at the source --
 * `model.logLevel` stays available for anyone who wants the full output.
 */
const NOISE = /model has unused tensor|ignoring wrong number of dims|llama_model_loader: n_\w+ = \d+/u;

function relayServiceLine(log: ClientLog, line: string): void {
  const trimmed = line.trim();
  if (trimmed.length === 0 || NOISE.test(trimmed)) return;
  log(trimmed);
}

/** Ports the server may occupy: the base plus its forward-walk allowance. */
const PORT_SCAN_RANGE = 11;

export function createServiceClient(
  service: ServiceConfig,
  models: ModelConfig,
  log: ClientLog,
): MemPlusService {
  let resolvedUrl: string | null = service.url ?? null;
  let lastHealth: ServiceHealth | null = null;
  let child: ChildProcess | null = null;
  /** Serialises discovery so concurrent sweeps don't both spawn a server. */
  let connecting: Promise<{ url: string; health: ServiceHealth }> | null = null;

  async function connect(): Promise<{ url: string; health: ServiceHealth }> {
    if (resolvedUrl) {
      const health = await getJson(`${resolvedUrl}/health`, 2_000);
      if (health?.ok) {
        lastHealth = health;
        return { url: resolvedUrl, health };
      }
      throw new Error(`no mem-plus service at ${resolvedUrl}`);
    }

    // Short deadline: this runs before the autostart decision, so a generous
    // wait here would delay every capture on a machine with no service running.
    const running = await findRunningService(service, PORT_SCAN_RANGE, 250);
    if (running) {
      resolvedUrl = running.url;
      lastHealth = running.health;
      log(`using running service ${running.url} (backend ${running.health.backend ?? "?"})`);
      return running;
    }

    if (!service.autostart) {
      throw new Error(
        `no mem-plus service on ${service.host}:${service.port}-${service.port + PORT_SCAN_RANGE - 1} and autostart is off`,
      );
    }

    const entry = serverEntryPath();
    if (!existsSync(entry)) {
      throw new Error(`service entry missing: ${entry}`);
    }

    log(`starting service: node ${entry} --port ${service.port}`);
    child = spawn(
      process.execPath.startsWith("node") ? process.execPath : "node",
      [
        entry,
        "--port", String(service.port),
        "--idle-minutes", String(service.idleMinutes),
        "--gpu", models.gpu,
        "--context-size", String(models.contextSize),
        "--max-tokens", String(models.maxNewTokens),
        "--content", models.contentModelPath,
        "--embed", models.embedModelPath,
        ...(models.threads > 0 ? ["--threads", String(models.threads)] : []),
        ...(models.gpuLayers !== "auto" ? ["--gpu-layers", String(models.gpuLayers)] : []),
        "--log-level", models.logLevel,
      ],
      {
        // Own process group: when OpenCode exits we can take the server with it
        // rather than orphaning a 4 GB process on the user's machine.
        detached: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );

    child.stdout?.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split(/\r?\n/)) {
        relayServiceLine(log, line);
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed.length === 0 || NOISE.test(trimmed)) continue;
        log("service stderr", trimmed.slice(0, 300));
      }
    });
    child.on("exit", (code) => {
      child = null;
      log(`service exited (code ${code})`);
    });

    const started = await findRunningService(service, PORT_SCAN_RANGE, service.startTimeoutMs);
    if (!started) {
      throw new Error(
        `service did not become healthy on ${service.host}:${service.port}-${service.port + PORT_SCAN_RANGE - 1} within ${Math.round(service.startTimeoutMs / 1000)}s`,
      );
    }
    resolvedUrl = started.url;
    lastHealth = started.health;
    return started;
  }

  function ensureConnected(): Promise<{ url: string; health: ServiceHealth }> {
    connecting ??= connect();
    // Cleared on settle rather than in a finally, so a rejected attempt does not
    // leave an unhandled rejection behind and the next sweep may retry.
    const current = connecting;
    const clear = () => {
      if (connecting === current) connecting = null;
    };
    return current.then(
      (value) => {
        clear();
        return value;
      },
      (error) => {
        clear();
        throw error;
      },
    );
  }

  async function call(
    path: string,
    body: unknown,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const { url } = await ensureConnected();
    const response = await postJson(`${url}${path}`, body, timeoutMs, signal);
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`${path} failed (${response.status}): ${describeError(response.json)}`);
    }
    return response.json;
  }

  return {
    get url(): string | null {
      return resolvedUrl;
    },
    get health(): ServiceHealth | null {
      return lastHealth;
    },

    ready: async () => {
      try {
        await ensureConnected();
        return true;
      } catch (error) {
        log(`service not ready: ${describeError(error)}`);
        return false;
      }
    },

    extract: ({ systemPrompt, prompt }) =>
      call("/extract", { systemPrompt, prompt }, 10 * 60_000).then((json) => {
        const text = (json as { text?: unknown }).text;
        if (typeof text !== "string") throw new Error("/extract returned no text");
        return text;
      }),

    embed: (input, signal) =>
      call("/embed", { input }, 60_000, signal).then((json) => {
        const vector = (json as { vector?: unknown }).vector;
        if (!Array.isArray(vector)) throw new Error("/embed returned no vector");
        return vector as number[];
      }),

    dispose: async () => {
      // A service the user started themselves is theirs to stop; only reclaim
      // what this plugin spawned.
      if (!child) return;
      const proc = child;
      child = null;
      try {
        if (proc.connected) proc.send("shutdown");
        else proc.kill();
        await Promise.race([once(proc, "exit"), new Promise((r) => setTimeout(r, 3_000))]);
        if (proc.exitCode === null) proc.kill();
      } catch {
        proc.kill();
      }
    },
  };
}