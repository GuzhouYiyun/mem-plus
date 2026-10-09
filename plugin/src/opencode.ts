// Structural views of the OpenCode plugin surface this plugin consumes.
//
// WHY A LOCAL SHAPE FOR SESSION MESSAGES
//   `SessionMessage.Info` in `@opencode/schema` is an Effect `Schema.Struct` union
//   whose every field is branded (`Session.ID`, `Agent.ID`, `Model.ID`, ...). Those
//   brands are useful to OpenCode internally but make discriminating a user message
//   from an assistant message inside a plugin noisy for no safety gain: the plugin
//   only reads `type`, `time.created`, `text` and `content`, all of which are plain
//   at runtime. Narrowing structurally on the runtime tag is both shorter and honest
//   about what is actually guaranteed.
//
// Everything else uses `@opencode/plugin`'s own types directly.
import type { Plugin } from "@opencode/plugin";

export type PluginContext = Plugin.Context;

/** One `SessionMessage.Info` as it actually arrives on the wire. */
export type SessionMessageView = {
  readonly id?: string;
  readonly type?: string;
  readonly time?: { readonly created?: number };
  readonly title?: string;
  readonly text?: string;
  readonly files?: readonly unknown[];
  readonly agent?: string;
  readonly model?: { readonly id?: string; readonly providerID?: string };
  readonly content?: readonly SessionContentPart[];
};

/** Assistant message parts: prose blocks and executed tool calls. */
export type SessionContentPart = {
  readonly type?: string;
  readonly text?: string;
  readonly name?: string;
  readonly state?: {
    readonly status?: string;
    readonly input?: unknown;
    readonly content?: readonly { readonly type?: string; readonly text?: string }[];
  };
};

/** The session fields the snapshot writer records. */
export type SessionInfoView = {
  readonly id?: string;
  readonly title?: string;
  readonly time?: { readonly created?: number; readonly updated?: number };
  readonly location?: { readonly directory?: string };
};

/** `ctx.event.subscribe` yields `OpenCodeEvent`; we only need type + session payload. */
export type EventView = {
  readonly type?: string;
  /** Envelope id (`evt_...`). A compaction event's own identity when it carries no `inputID`. */
  readonly id?: string;
  readonly data?: {
    readonly sessionID?: string;
    readonly inboxID?: string;
    /** `session.compaction.started` names the message the compaction will produce. */
    readonly inputID?: string;
    readonly item?: {
      readonly type?: string;
      readonly payload?: { readonly text?: string; readonly files?: readonly unknown[] };
      readonly delivery?: string;
    };
  };
};

/** Coerce an unknown message to the readable view. Never throws. */
export function asSessionMessage(value: unknown): SessionMessageView {
  return (value ?? {}) as SessionMessageView;
}
