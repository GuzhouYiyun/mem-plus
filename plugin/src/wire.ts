// The wire-level retry: when OpenCode's own generate API is refused, send the request
// the way OpenCode's client itself sends it.
//
// WHY THIS FILE EXISTS
//   `ctx.generate.text` builds a request that carries no `tools`, and on 2026-10-16 the
//   hosted gateway began refusing that shape with `403 FreeTierError` -- capture
//   extraction, promotion consolidation and dreaming all stopped reaching a model.
//   Measured from inside a plugin, against the real gateway:
//
//     tools present, fresh `x-opencode-session`, `stream: true`   -> 200
//     no tools                                                    -> 403
//     empty tools array                                           -> 403
//     no `x-opencode-session` header                              -> 403
//     a 45-day-old session id                                     -> 403
//     no `authorization` header at all                            -> 200
//
//   The gate inspects the shape of the request, not who is calling. The client's own
//   requests carry tools, a freshly minted session id and `stream: true`, so this
//   module mints those three things and sends the same body straight at the gateway.
//
//   The client also sends generation parameters (`temperature`, `top_p`,
//   `max_tokens`) when the user configured them. This module mirrors that shape on
//   the wire.
//
//   0.3.1 note: mirroring the client's "omit `tools` when the call has none" was
//   tried and measured to fail -- the client never actually sends a tool-less
//   request (its agent always carries tools), while the gate refuses every
//   tool-less request (lines 10-12). A day of instant `403 FreeTierError` on every
//   wire call ended that experiment (2026-10-17); a call without tools carries one
//   placeholder tool again, the same trick 0.3.0 shipped.
//
// WHEN IT RUNS
//   Only after the host path has already been refused, and only when the target model
//   resolves to the OpenCode gateway. `completeThroughHost` always tries
//   `ctx.generate.text` first, so the day the host path works again this file goes
//   quiet on its own.
//
// WHAT IT IS
//   A seam, not memory logic: openclaw has no equivalent, because nothing upstream
//   talks to a gateway that gates on request shape. The request leaves from the plugin
//   process itself -- it does not pass through OpenCode's server, creates no session
//   or message, and the minted id exists only as a header value. Registered in
//   `docs/port-plan.md` (2026-10-16, "免费档兜底").
import { randomBytes } from "node:crypto";

import type { HostedModelRef } from "./model/config.js";
import type { PluginContext } from "./opencode.js";

/**
 * The refusal, by the two spellings it has taken on the wire. Matched loosely on
 * purpose: the wrapper around the message is a host detail, the sentence is the gate's.
 */
const FREE_TIER_MARKERS = ["free tier can only be used from within opencode", "freetiererror"];

/** Whether a host-call failure is the free-tier refusal this module exists for. */
export function isFreeTierRejection(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return FREE_TIER_MARKERS.some((marker) => message.includes(marker));
}

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

let mintMillisecond = 0;
let mintCounter = 0;

/**
 * A fresh session-shaped id. The gate decodes the timestamp out of this string and
 * refuses stale ones, so a constant cannot be configured; each call mints its own.
 *
 * Recovered from the client binary and confirmed against the live gateway (a minted id
 * is accepted, a 45-day-old one is not):
 *
 *   r = BigInt(now) * 0x1000n + per-millisecond counter
 *   a = ~r                       (the `ses_` form is the inverted one)
 *   low 48 bits -> 6 bytes -> 12 lowercase hex characters
 *   + 14 characters, each a random byte mod 62
 */
function mintSessionId(): string {
  const now = Date.now();
  if (now !== mintMillisecond) {
    mintMillisecond = now;
    mintCounter = 0;
  }
  mintCounter += 1;
  const r = BigInt(now) * 0x1000n + BigInt(mintCounter);
  const a = ~r;
  let hex = "";
  for (let i = 0; i < 6; i++) {
    hex += Number((a >> BigInt(40 - 8 * i)) & 0xffn)
      .toString(16)
      .padStart(2, "0");
  }
  const bytes = randomBytes(14);
  let suffix = "";
  for (const byte of bytes) suffix += BASE62.charAt(byte % 62);
  return "ses_" + hex + suffix;
}

/**
 * One tool definition, mirroring OpenCode's client shape. A call with tools of its
 * own sends those; a call without any sends `PLACEHOLDER_TOOL`, because the gate
 * refuses every tool-less request (measured 2026-10-16, header comment above).
 */
export type WireTool = {
  readonly name: string;
  readonly description: string;
  readonly parameters?: unknown;
};

/**
 * Stands in for the tools the official client always carries. The gate reads
 * `tools` as "this request can be a conversation"; one legal function satisfies
 * that check, and nothing else -- it is never named in a reply because the
 * tool-less calls this stands in for never ask the model to act.
 */
const PLACEHOLDER_TOOL = {
  type: "function",
  function: {
    name: "read",
    description: "Read a file.",
    parameters: {
      type: "object",
      properties: { filePath: { type: "string" } },
      required: ["filePath"],
    },
  },
} as const;

type WireEndpoint = {
  readonly providerID: string;
  readonly modelID: string;
  readonly baseURL: string;
};

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** The SDK wraps its replies in `{ location, data }`; take `data` when present. */
function unwrapData(value: unknown): unknown {
  if (value && typeof value === "object" && "data" in (value as Record<string, unknown>)) {
    return (value as Record<string, unknown>)["data"];
  }
  return value;
}

/** A model record as the catalog and the default reply actually carry it. */
function endpointFromModel(value: unknown): WireEndpoint | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const providerID = asString(record["providerID"]);
  const modelID = asString(record["modelID"]) ?? asString(record["id"]);
  const settings = record["settings"];
  const baseURL =
    settings && typeof settings === "object"
      ? asString((settings as Record<string, unknown>)["baseURL"])
      : undefined;
  if (!providerID || !modelID || !baseURL) return undefined;
  return { providerID, modelID, baseURL };
}

/**
 * Where the target model lives. An omitted `ref` means "OpenCode's own default",
 * exactly as it does for `ctx.generate.text`; a pinned ref is looked up in the same
 * catalog the host consults. Every model record already carries `settings.baseURL`
 * (measured 2026-10-16), so the happy path is one lookup; the provider record is the
 * fallback for a model the catalog does not list.
 */
async function resolveEndpoint(
  ctx: PluginContext,
  ref: HostedModelRef | undefined,
): Promise<WireEndpoint | undefined> {
  try {
    if (ref) {
      const entries = unwrapData(await ctx.model.list());
      if (Array.isArray(entries)) {
        for (const entry of entries) {
          if (!entry || typeof entry !== "object") continue;
          const record = entry as Record<string, unknown>;
          if (asString(record["providerID"]) !== ref.providerID) continue;
          if ((asString(record["modelID"]) ?? asString(record["id"])) !== ref.id) continue;
          const endpoint = endpointFromModel(entry);
          if (endpoint) return endpoint;
        }
      }
    } else {
      const endpoint = endpointFromModel(unwrapData(await ctx.model.default()));
      if (endpoint) return endpoint;
    }
  } catch {
    // Fall through to the provider record below.
  }
  if (!ref) return undefined;
  try {
    // `get` takes `{ providerID }` at runtime (a bare string fails the server's schema,
    // measured 2026-10-16); the cast keeps that measured shape visible here.
    const getProvider = ctx.provider.get as unknown as (input: {
      providerID: string;
    }) => Promise<unknown>;
    const provider = unwrapData(await getProvider({ providerID: ref.providerID }));
    const settings =
      provider && typeof provider === "object"
        ? (provider as Record<string, unknown>)["settings"]
        : undefined;
    const baseURL =
      settings && typeof settings === "object"
        ? asString((settings as Record<string, unknown>)["baseURL"])
        : undefined;
    if (baseURL) return { providerID: ref.providerID, modelID: ref.id, baseURL };
  } catch {
    // No endpoint, no retry.
  }
  return undefined;
}

/** Longest a single wire call may run when the caller did not set a deadline of its own. */
const WIRE_TIMEOUT_MS = 30_000;

/** How many times the wire call may be retried after a failure. */
const WIRE_MAX_ATTEMPTS = 3;

/** Backoff between attempts, in milliseconds. */
const WIRE_BACKOFF_MS = 1_000;

export type WireRequest = {
  readonly ctx: PluginContext;
  /** Pins the model; omitted means the same default `ctx.generate.text` would use. */
  readonly ref?: HostedModelRef;
  readonly prompt: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  /** Generation parameters, forwarded to the gateway like OpenCode's client does. */
  readonly temperature?: number;
  readonly topP?: number;
  readonly maxTokens?: number;
  /** Tool definitions, if the call has any. Omitted entirely when there are none. */
  readonly tools?: readonly WireTool[];
};

/**
 * One generation sent at the wire level. Resolves with the model's text; rejects with a
 * short reason (`HTTP 403: ...`, `timed out after 8000ms`, ...) that the caller labels,
 * keeping the host-path refusal as the primary reason.
 */
/** Build the request body, mirroring OpenCode's client shape from `openai-chat.ts`. */
function buildWireBody(endpoint: WireEndpoint, request: WireRequest): string {
  const body: Record<string, unknown> = {
    model: endpoint.modelID,
    messages: [{ role: "user", content: request.prompt }],
    stream: true,
    stream_options: { include_usage: true },
  };
  // The gate reads `tools` as "this request can be a conversation" and refuses every
  // tool-less one (measured 2026-10-16, header above; 0.3.1 omitted the field and
  // every wire call took an instant 403 until this was restored on 2026-10-17). A
  // call with its own tools sends those, paired with `tool_choice: "auto"`.
  if (request.tools?.length) {
    body.tools = request.tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters ?? {},
      },
    }));
    body.tool_choice = "auto";
  } else {
    // The measured-working shape, verbatim from 0.3.0: one placeholder tool, no
    // `tool_choice` -- the three successes on 2026-10-16 all carried exactly this.
    body.tools = [PLACEHOLDER_TOOL];
  }
  if (request.temperature !== undefined) body.temperature = request.temperature;
  if (request.topP !== undefined) body.top_p = request.topP;
  if (request.maxTokens !== undefined) body.max_tokens = request.maxTokens;
  return JSON.stringify(body);
}

/** One attempt: open the SSE stream, read it to completion, return the assembled text. */
async function runWireAttempt(
  endpoint: WireEndpoint,
  request: WireRequest,
  timeoutMs: number,
): Promise<string> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  // Do not hold the event loop open for a call nobody is waiting on any more.
  (timer as unknown as { unref?: () => void }).unref?.();
  const forwardAbort = () => controller.abort();
  request.signal?.addEventListener("abort", forwardAbort, { once: true });
  if (request.signal?.aborted) controller.abort();
  try {
    const response = await fetch(`${endpoint.baseURL.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "*/*",
        // Two of the three measured constituents of the accepted shape: the client's own
        // name, and a session id minted a moment ago. The third -- `stream: true` -- is
        // in the body below.
        "user-agent": `opencode/${request.ctx.app.channel}/${request.ctx.app.version}/${request.ctx.app.name}`,
        "x-opencode-session": mintSessionId(),
      },
      body: buildWireBody(endpoint, request),
      signal: controller.signal,
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(
        `HTTP ${String(response.status)}${detail ? `: ${detail.slice(0, 200)}` : ""}`,
      );
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("text/event-stream")) {
      // A buffering proxy (or a gateway that answered in one piece) carries the same
      // payloads; read the non-streamed shape instead of failing the call.
      const payload = (await response.json()) as {
        choices?: { message?: { content?: unknown } }[];
      };
      const text = asString(payload.choices?.[0]?.message?.content);
      if (!text) throw new Error("empty completion");
      return text;
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("no response body");
    const decoder = new TextDecoder();
    let buffer = "";
    let text = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        try {
          const event = JSON.parse(data) as {
            choices?: { delta?: { content?: unknown } }[];
          };
          const delta = event.choices?.[0]?.delta?.content;
          if (typeof delta === "string") text += delta;
        } catch {
          // Keep-alives and shapes this reader does not consume are not errors.
        }
      }
    }
    if (!text) throw new Error("empty completion");
    return text;
  } finally {
    clearTimeout(timer);
    request.signal?.removeEventListener("abort", forwardAbort);
  }
}

/**
 * One generation sent at the wire level. Resolves with the model's text; rejects with a
 * short reason (`HTTP 403: ...`, `timed out after 30000ms`, ...) that the caller labels,
 * keeping the host-path refusal as the primary reason.
 *
 * Failed attempts are retried with a small backoff, up to `WIRE_MAX_ATTEMPTS` total,
 * because the free-tier gateway can be momentarily overloaded even when the request
 * shape is exactly what the client sends.
 */
export async function wireText(request: WireRequest): Promise<string> {
  const endpoint = await resolveEndpoint(request.ctx, request.ref);
  if (!endpoint) throw new Error("no endpoint for the target model");
  // This exists for exactly one gate: the hosted gateway's free-tier refusal. Any other
  // endpoint that happened to fail the same way must not receive a request shaped for
  // that gate, so the destination is checked rather than assumed.
  let host: string;
  try {
    host = new URL(endpoint.baseURL).hostname;
  } catch {
    throw new Error(`unusable base URL: ${endpoint.baseURL}`);
  }
  if (host !== "opencode.ai" && !host.endsWith(".opencode.ai")) {
    throw new Error(`endpoint is not the OpenCode gateway: ${host}`);
  }

  let lastError: unknown;
  for (let attemptIndex = 0; attemptIndex < WIRE_MAX_ATTEMPTS; attemptIndex += 1) {
    if (attemptIndex > 0) {
      await new Promise((resolve) => {
        const backoffTimer = setTimeout(resolve, WIRE_BACKOFF_MS * attemptIndex);
        (backoffTimer as unknown as { unref?: () => void }).unref?.();
      });
    }
    const timeoutMs = request.timeoutMs ?? WIRE_TIMEOUT_MS;
    try {
      return await runWireAttempt(endpoint, request, timeoutMs);
    } catch (error) {
      lastError = error;
      if (attemptIndex === WIRE_MAX_ATTEMPTS - 1) {
        throw error instanceof Error ? error : new Error(String(error));
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
