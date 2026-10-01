// The reserved seam: everything OpenCode-specific that the capture pipeline needs.
//
// `CaptureDependencies` was deliberately shaped so this is the only file that has
// to know OpenCode exists. `pipeline.ts` calls `loadTurn` and `complete`; everything
// else (claiming, retrying, rendering, appending) stays in the ported module.
import fs from "node:fs/promises";
import { CAPTURE_LATEST_MEMORY_CHARS, CAPTURE_MAX_TOOL_INPUT_LENGTH } from "../../extensions/memory-core/src/capture/constants.js";
import { dailyMemoryFile, memoryFile } from "./paths.js";
import { asSessionMessage, type PluginContext, type SessionContentPart, type SessionMessageView } from "./opencode.js";
import type {
  CaptureDependencies,
  CapturePromptRecord,
  CaptureTurn,
  CaptureToolCall,
} from "../../extensions/memory-core/src/capture/types.js";

/** `ctx.session.context` result: the same messages, read structurally. */
function readMessages(ctx: PluginContext, sessionID: string): Promise<readonly unknown[]> {
  return ctx.session.context({ sessionID } as Parameters<PluginContext["session"]["context"]>[0]);
}

function sliceToolCall(part: SessionContentPart): CaptureToolCall | null {
  const name = part.name;
  if (typeof name !== "string" || name.length === 0) return null;
  const input = part.state?.input;
  let serialized = "";
  if (input !== undefined && input !== null) {
    try {
      serialized = JSON.stringify(input);
    } catch {
      serialized = String(input);
    }
  }
  if (serialized.length > CAPTURE_MAX_TOOL_INPUT_LENGTH) {
    serialized = `${serialized.slice(0, CAPTURE_MAX_TOOL_INPUT_LENGTH)}...`;
  }
  return { name, input: serialized };
}

/**
 * Pull the assistant turn that answers `record`'s prompt.
 *
 * The prompt's landing time is the lower bound: OpenCode appends the user message
 * and the assistant reply in order, so the first assistant message created at or
 * after `record.createdAt` is the reply. Returning `null` (no assistant message yet)
 * is what keeps a prompt pending instead of burning a retry -- the sweep runs after
 * `session.execution.succeeded`, so in practice the reply is already durable.
 */
export async function loadAssistantTurn(
  ctx: PluginContext,
  record: CapturePromptRecord,
): Promise<CaptureTurn | null> {
  let messages: readonly unknown[];
  try {
    messages = await readMessages(ctx, record.sessionId);
  } catch {
    // Session gone or not readable: the prompt can never be completed.
    return null;
  }

  for (const raw of messages) {
    const message: SessionMessageView = asSessionMessage(raw);
    if (message.type !== "assistant") continue;
    if ((message.time?.created ?? 0) < record.createdAt) continue;

    const textResponses: string[] = [];
    const toolCalls: CaptureToolCall[] = [];
    for (const part of message.content ?? []) {
      if (part?.type === "text" && typeof part.text === "string" && part.text.trim().length > 0) {
        textResponses.push(part.text);
      } else if (part?.type === "tool") {
        const call = sliceToolCall(part);
        if (call) toolCalls.push(call);
      }
    }
    if (textResponses.length === 0 && toolCalls.length === 0) continue;
    return { textResponses, toolCalls };
  }
  return null;
}

async function readTail(filePath: string, maxChars: number): Promise<string | null> {
  const text = await fs.readFile(filePath, "utf-8").catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (text === null || text.length === 0) return null;
  return text.length <= maxChars ? text : text.slice(text.length - maxChars);
}

/**
 * Replacement extraction transport. Normally the local GGUF runtime; the default
 * below is the OpenCode-hosted fallback, used when local inference is switched
 * off or its model files are absent.
 */
export type CaptureCompleteOverride = (params: {
  systemPrompt: string;
  prompt: string;
}) => Promise<string>;

/**
 * Build the host half of the capture pipeline.
 *
 * `complete` folds the system prompt into a single user prompt on the fallback
 * path, because `ctx.generate.text` has no system parameter:
 * `buildBoundedSummaryPrompt` emits the conversation body only, and
 * `extractCaptureSummary` hands the system prompt back out separately for the
 * host to place. A local runtime gets both separately and templates them itself.
 */
export function createCaptureDependencies(
  ctx: PluginContext,
  overrides: { complete?: CaptureCompleteOverride } = {},
): CaptureDependencies {
  const complete: CaptureCompleteOverride =
    overrides.complete ??
    (async ({ systemPrompt, prompt }) => {
      const result = await ctx.generate.text({ prompt: `${systemPrompt}\n\n${prompt}` });
      return result.text;
    });

  return {
    workspaceDir: ctx.location.directory,

    loadTurn: (record) => loadAssistantTurn(ctx, record),

    complete,

    loadLatestMemory: async (record) => {
      const daily = await readTail(dailyMemoryFile(ctx.location.directory, record.createdAt), CAPTURE_LATEST_MEMORY_CHARS);
      if (daily) return daily;
      return await readTail(memoryFile(ctx.location.directory), CAPTURE_LATEST_MEMORY_CHARS);
    },
  };
}
