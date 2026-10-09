// Compatibility and routing for the event stream.
//
// Two problems this solves, both learned from opencode-mem's V2 adapter:
//
// NAMES AND SHAPES MOVE. Events carry a version suffix and get renamed: the stream
// emits `session.compaction.ended.1`, and a name that was once
// `session.compacted` came back as something else. A plugin that compares
// `event.type` against one literal stops matching silently -- no error, just no
// capture. Names are therefore normalised before anything reads them, and the
// accepted aliases are spelled out so a future rename is a one-line edit here
// rather than a hunt through the capture path.
//
// NOT EVERY EVENT IS OURS. The index is shared by every project on the machine, and
// `ctx.event.subscribe()` is a machine-wide stream, not this window's. Without a
// check, a session started in another project is captured into this window's
// workspace: the snapshot lands under the wrong directory, the memory is attributed
// to the wrong project, and a `project` filter then returns the wrong set. That
// happened here -- every project's memories ended up under one slug.

import path from "node:path";
import type { EventView, PluginContext } from "./opencode.js";

/**
 * One event name, under every spelling it is known to arrive as.
 *
 * The keys are what arrives on the wire; the value is the canonical name the rest of
 * the plugin matches on. Version suffixes are stripped by `normaliseEventType`
 * before lookup, so they are not listed here.
 */
const EVENT_ALIASES: Readonly<Record<string, string>> = {
  "session.inbox.enqueued": "session.inbox.enqueued",
  // `started` is the pre-compaction signal the flush hangs off; `ended` keeps its
  // own name rather than collapsing into `session.compacted`, because "the
  // compaction finished" and "the compaction is about to start" are different
  // moments and the two are read differently.
  "session.compaction.started": "session.compaction.started",
  "session.compaction.ended": "session.compacted",
  "session.compacted": "session.compacted",
  "session.execution.succeeded": "session.execution.succeeded",
  "session.execution.failed": "session.execution.failed",
  "session.execution.interrupted": "session.execution.interrupted",
};

/** Terminal events: the turn is over, so the session is worth settling. */
const EXECUTION_ENDED = new Set([
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
]);

/**
 * The canonical name for an event type, or undefined when this plugin has no use for
 * it. Unknown types are dropped rather than passed through, so a new OpenCode event
 * cannot accidentally reach the capture path on a shape it was not written for.
 */
export function normaliseEventType(rawType: unknown): string | undefined {
  if (typeof rawType !== "string" || rawType.length === 0) return undefined;
  // `session.compaction.ended.1` and `session.compaction.ended` are the same event.
  const withoutVersion = rawType.replace(/\.\d+$/, "");
  return EVENT_ALIASES[withoutVersion];
}

/** Whether this event means the turn ended and the session should be settled. */
export function isExecutionEnded(canonicalType: string): boolean {
  return EXECUTION_ENDED.has(canonicalType);
}

/**
 * Unwrap an event envelope to the object that actually carries `type`/`data`.
 *
 * The stream has emitted more than one shape over time -- the event at the top level,
 * nested under `payload`, and wrapped again by a `sync` envelope. Each field this
 * plugin reads is looked for in all of them rather than in one fixed place.
 */
export function unwrapEvent(raw: unknown): EventView | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const outer = raw as Record<string, unknown>;

  // A `sync` envelope wraps the real event one level down.
  const payload = (outer.payload ?? outer) as Record<string, unknown>;
  const source =
    payload.type === "sync" && payload.syncEvent
      ? (payload.syncEvent as Record<string, unknown>)
      : payload;

  // `data` and `properties` have both carried the payload.
  const data =
    (source.data as Record<string, unknown> | undefined) ??
    (source.properties as Record<string, unknown> | undefined) ??
    {};

  return {
    type: typeof source.type === "string" ? source.type : undefined,
    id: typeof source.id === "string" ? source.id : undefined,
    data: {
      sessionID:
        (typeof data.sessionID === "string" && data.sessionID) ||
        (typeof (data.session as Record<string, unknown> | undefined)?.id === "string"
          ? ((data.session as Record<string, unknown>).id as string)
          : undefined) ||
        (typeof (data.info as Record<string, unknown> | undefined)?.id === "string"
          ? ((data.info as Record<string, unknown>).id as string)
          : undefined),
      inboxID: typeof data.inboxID === "string" ? data.inboxID : undefined,
      // Optional in the event's own schema, so both this and the envelope id are
      // read: the flush needs one stable id per compaction and either will do.
      inputID: typeof data.inputID === "string" ? data.inputID : undefined,
      item: data.item as EventView["data"] extends { item?: infer I } ? I : never,
    },
  };
}

/**
 * Whether this event belongs to the workspace this plugin instance serves.
 *
 * Resolved the way opencode-mem resolves it: prefer a directory carried on the event,
 * fall back to asking OpenCode about the session, and treat "cannot tell" as "not
 * ours" so an unresolvable event is never written to the wrong project.
 */
export async function eventBelongsToWorkspace(
  ctx: PluginContext,
  raw: unknown,
  event: EventView,
): Promise<boolean> {
  const here = sameDirectory(ctx.location.directory, ctx.location.directory);

  // Any of these has carried the directory across versions of the envelope.
  const outer = (raw ?? {}) as Record<string, unknown>;
  const payload = (outer.payload ?? {}) as Record<string, unknown>;
  const candidate =
    pickString(outer.location, "directory") ??
    pickString(outer, "directory") ??
    pickString(payload.location, "directory") ??
    pickString(payload, "directory") ??
    pickString(event.data?.item as Record<string, unknown> | undefined, "directory");
  if (candidate !== undefined) return sameDirectory(candidate, ctx.location.directory);

  // No directory on the event: ask OpenCode which workspace the session is in.
  const sessionID = event.data?.sessionID;
  if (!sessionID) return false;
  try {
    const session = (await ctx.session.get({ sessionID })) as unknown as Record<string, unknown>;
    const directory =
      pickString(session.location, "directory") ?? pickString(session, "directory");
    return directory !== undefined && sameDirectory(directory, ctx.location.directory);
  } catch {
    return false;
  }
}

/**
 * Whether two paths name the same directory.
 *
 * Compared through `path.resolve` so `..` segments, trailing separators and relative
 * paths are settled first, and case-insensitively on Windows, where `C:\Users` and
 * `c:\users` are one directory but two strings. Getting this wrong is not cosmetic:
 * it decides whether a memory is filed under the project the user is working in, so
 * a rejected event is a memory that is never captured and an accepted one is a memory
 * captured into somebody else's project.
 */
function sameDirectory(left: string, right: string): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function pickString(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const found = (value as Record<string, unknown>)[key];
  return typeof found === "string" && found.length > 0 ? found : undefined;
}