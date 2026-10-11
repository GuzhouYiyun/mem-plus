// Standing intents on OpenCode: the host adapter around openclaw's tool and matcher.
//
// UPSTREAM
//   `extensions/memory-core/src/standing-intents-tool.ts` (`createStandingIntentExecutor`)
//   and `standing-intents.ts` (`matchStandingIntents`), copied verbatim except for the
//   database open, which is documented where it deviates. openclaw registers the tool from
//   its *channel* layer -- nothing in `memory-core` calls it except tests -- and its `create`
//   action throws unless both `provider` and `senderId` are present ("authenticated channel
//   identity is unavailable for this turn"). OpenCode has no channels and no authenticated
//   sender, so this file answers that question instead of reimplementing any of it.
//
// THE IDENTITY MAPPING, AND WHY
//   Upstream's two identity fields mean "which conversation is this" and "who is asking".
//   OpenCode's equivalents are the workspace and the local user:
//
//     provider       = "opencode"     the host transport. A constant, which is exactly
//                                     upstream's assumption for a single channel.
//     conversationId = project slug   so `scope: "channel"` means *this project* and
//                                     `scope: "anywhere"` keeps its machine-wide meaning.
//                                     All three of upstream's scopes therefore survive.
//     senderId       = OS user name   so `senderScope: "sender"` still means "only me". A
//                                     local plugin serves one user and authenticates nobody;
//                                     pretending otherwise would fire a private reminder at
//                                     whoever opens the repository.
//
//   This is the one place the contract genuinely differs, so it is written down here rather
//   than guessed at each call site.
//
// THE TOOL SHAPE
//   openclaw's executor is `AnyAgentTool["execute"]` -- `(toolCallId, params)` returning an
//   `AgentToolResult`. OpenCode's is `(input, context)` returning `{ content, metadata }`.
//   `jsonResult` already produced the text half; this only re-labels it.
import os from "node:os";
import { createStandingIntentExecutor } from "../../extensions/memory-core/src/standing-intents-tool.js";
import { matchStandingIntents } from "../../extensions/memory-core/src/standing-intents.js";
import { buildStandingIntentContext } from "../../extensions/memory-core/src/standing-intents-model.js";
import type { MemoryTool } from "./memory-tools.js";
import { projectSlug } from "./paths.js";

/** openclaw keys intents by agent; OpenCode runs one agent per plugin instance. */
const AGENT_ID = "main";
/** The host transport name, standing in for openclaw's channel provider id. */
const PROVIDER = "opencode";

function localUser(): string {
  try {
    return os.userInfo().username || "local";
  } catch {
    return "local";
  }
}

/** Upstream's params, verbatim. `action` discriminates; upstream throws on anything else. */
const STANDING_INTENT_INPUT = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["create", "list", "cancel"],
      description: "create arms a reminder, list shows armed ones, cancel disarms by id.",
    },
    description: { type: "string", description: "The reminder text, at most 500 characters." },
    triggerKeywords: {
      type: "array",
      items: { type: "string" },
      description: "Words that fire it: at most 24 entries, 120 characters each.",
    },
    scope: {
      type: "string",
      enum: ["conversation", "channel", "anywhere"],
      description:
        "`channel` (default) is this project, `conversation` is this session, `anywhere` is every project on this machine.",
    },
    senderScope: {
      type: "string",
      enum: ["sender", "anyone"],
      description: "`sender` (default) fires only for you.",
    },
    expiresAt: { type: "string", description: "ISO 8601 timestamp after which it stops firing." },
    maxFires: { type: "integer", minimum: 1, description: "How many times it may fire." },
    cooldownSeconds: { type: "integer", minimum: 0, description: "Minimum gap between firings." },
    id: { type: "string", description: "Intent id, for `cancel`." },
    status: {
      type: "string",
      enum: ["pending", "armed", "fired", "done", "cancelled", "expired"],
      description: "Filter for `list`. Omit for all.",
    },
  },
  additionalProperties: false,
} as const;

const STANDING_INTENT_DESCRIPTION = [
  "Arm a reminder that fires by itself later, instead of relying on you to remember it.",
  "",
  "Create one with a description and trigger keywords; it is injected automatically the",
  "next time a message matches. Do not deliver it early and do not cancel it unless asked.",
].join("\n");

/** The tool as OpenCode sees it: upstream's executor behind OpenCode's signature. */
export function buildStandingIntentTool(params: {
  workspaceDir: string;
  log: (message: string, detail?: unknown) => void;
}): MemoryTool {
  return {
    name: "standing_intent",
    description: STANDING_INTENT_DESCRIPTION,
    input: STANDING_INTENT_INPUT,
    execute: async (input) => {
      const execute = createStandingIntentExecutor({
        agentId: AGENT_ID,
        provider: PROVIDER,
        senderId: localUser(),
        conversationId: projectSlug(params.workspaceDir),
      });
      try {
        // `_toolCallId` has no counterpart: OpenCode hands the tool no call id, and
        // upstream's executor does not read it.
        const result = await execute("", input as Record<string, unknown>);
        const text = (result as { content?: unknown }).content;
        return {
          content: typeof text === "string" ? text : JSON.stringify(result, null, 2),
          metadata: ((result as { metadata?: unknown }).metadata ?? {}) as Record<string, unknown>,
        };
      } catch (error) {
        // The plugin's tool convention: errors come back as text the model can act on,
        // never as a rejection it cannot reason about.
        return {
          content: error instanceof Error ? error.message : String(error),
          metadata: { error: true },
        };
      }
    },
  };
}

/**
 * The block for this prompt, or an empty string when nothing fires.
 *
 * The rendering is **upstream's**, not this file's: `buildStandingIntentContext` (with its
 * `INTENT_INJECTION_MAX_COUNT` cap and its context-budget check) ships in
 * `extensions/memory-core/src/standing-intents-model.ts`, which was copied verbatim. An
 * earlier version of this file had its own `## Standing intents` renderer; that was a
 * needless second format and it is gone.
 *
 * Upstream's call site is `extensions/memory-core/index.ts:296`, which matches on
 * `before_prompt_build` and prepends the result. The arguments below are that call's, with
 * OpenCode's equivalents for the four channel fields.
 *
 * Never throws: a failed lookup omits the block rather than the turn, which is the
 * degradation upstream's own catch relies on.
 */
export async function matchStandingIntentsForPrompt(params: {
  workspaceDir: string;
  prompt: string;
  log: (message: string, detail?: unknown) => void;
}): Promise<string> {
  try {
    const fired = await matchStandingIntents({
      agentId: AGENT_ID,
      prompt: params.prompt,
      provider: PROVIDER,
      senderId: localUser(),
      channel: projectSlug(params.workspaceDir),
    });
    return buildStandingIntentContext(fired) ?? "";
  } catch (error) {
    params.log("standing intent match failed", error);
    return "";
  }
}
