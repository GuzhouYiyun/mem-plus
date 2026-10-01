// Markdown context assembly for the extraction call, ported from opencode-mem's
// `buildMarkdownContext` / `buildBoundedSummaryPrompt` / `getAutoCaptureMarkdownBudget`
// (opencode-mem/src/services/auto-capture.ts). Budgets are UTF-8 bytes throughout.
import {
  CAPTURE_CONTEXT_TRUNCATION_MARKER,
  CAPTURE_DEFAULT_MAX_CONTEXT_BYTES,
  CAPTURE_SUMMARY_ANALYSIS_SUFFIX,
  CAPTURE_SUMMARY_OUTPUT_RESERVE_BYTES,
  CAPTURE_SUMMARY_REQUEST_OVERHEAD_BYTES,
} from "./constants.js";
import { captureUtf8ByteLength, truncateCaptureToMaxBytes } from "./context-limit.js";
import type { CaptureToolCall } from "./types.js";

function joinSections(sections: string[]): string {
  return sections.join("\n");
}

/** Room left for the conversation body once the request reserve is set aside. */
export function getCaptureMarkdownBudget(
  totalRequestBytes: number = CAPTURE_DEFAULT_MAX_CONTEXT_BYTES,
): number {
  const requestReserve = Math.min(24_576, Math.floor(totalRequestBytes * 0.25));
  return Math.max(4096, totalRequestBytes - requestReserve);
}

/** Truncate the assembled context so system prompt + schema + output still fit. */
export function buildBoundedSummaryPrompt(
  context: string,
  systemPrompt: string,
  schema: unknown,
  totalRequestBytes: number = CAPTURE_DEFAULT_MAX_CONTEXT_BYTES,
): string {
  const schemaBytes = captureUtf8ByteLength(JSON.stringify(schema));
  const outputReserve = Math.min(
    CAPTURE_SUMMARY_OUTPUT_RESERVE_BYTES,
    Math.floor(totalRequestBytes * 0.125),
  );
  const userBudget = Math.max(
    0,
    totalRequestBytes -
      captureUtf8ByteLength(systemPrompt) -
      schemaBytes -
      outputReserve -
      CAPTURE_SUMMARY_REQUEST_OVERHEAD_BYTES,
  );
  return truncateCaptureToMaxBytes(
    `${context}\n\n${CAPTURE_SUMMARY_ANALYSIS_SUFFIX}`,
    userBudget,
    CAPTURE_CONTEXT_TRUNCATION_MARKER,
  );
}

/** Keep the newest assistant turns; older ones are dropped or head/tail truncated first. */
function fitTextResponses(textResponses: string[], maxBytes: number): string {
  if (textResponses.length === 0 || maxBytes <= 0) return "";

  const separator = "\n\n";
  const separatorBytes = captureUtf8ByteLength(separator);
  const joined = textResponses.join(separator);
  if (captureUtf8ByteLength(joined) <= maxBytes) return joined;

  // Prefer newest assistant turns; truncate older content first.
  const kept: string[] = [];
  let usedBytes = 0;

  for (let i = textResponses.length - 1; i >= 0; i--) {
    const response = textResponses[i] ?? "";
    const responseBytes = captureUtf8ByteLength(response);
    const extraSeparator = kept.length > 0 ? separatorBytes : 0;
    const needed = responseBytes + extraSeparator;

    if (usedBytes + needed <= maxBytes) {
      kept.unshift(response);
      usedBytes += needed;
      continue;
    }

    const remaining = maxBytes - usedBytes - extraSeparator;
    if (remaining > captureUtf8ByteLength(CAPTURE_CONTEXT_TRUNCATION_MARKER)) {
      kept.unshift(
        truncateCaptureToMaxBytes(response, remaining, CAPTURE_CONTEXT_TRUNCATION_MARKER),
      );
    }
    break;
  }

  return kept.join(separator);
}

/** Build auto-capture markdown context, capped to `maxContextBytes` (UTF-8). */
export function buildCaptureMarkdownContext(params: {
  userPrompt: string;
  textResponses: string[];
  toolCalls: CaptureToolCall[];
  latestMemory: string | null;
  maxContextBytes?: number;
}): string {
  const maxContextBytes = params.maxContextBytes ?? CAPTURE_DEFAULT_MAX_CONTEXT_BYTES;
  const { userPrompt, textResponses, toolCalls, latestMemory } = params;

  const memorySections: string[] = [];
  if (latestMemory) {
    memorySections.push(`## Previous Memory Context`);
    memorySections.push(`---`);
    memorySections.push(latestMemory);
    memorySections.push(`---\n`);
  }

  const toolsSections: string[] = [];
  if (toolCalls.length > 0) {
    toolsSections.push(`## Tools Used`);
    toolsSections.push(`---`);
    for (const tool of toolCalls) {
      if (tool.input) {
        toolsSections.push(`- ${tool.name}(${tool.input})`);
      } else {
        toolsSections.push(`- ${tool.name}`);
      }
    }
    toolsSections.push(`---\n`);
  }

  const skeletonWithoutBodies = joinSections([
    ...memorySections,
    "## User Request",
    "---",
    "",
    "---\n",
    ...(textResponses.length > 0 ? ["## AI Response", "---", "", "---\n"] : []),
    ...toolsSections,
  ]);
  const skeletonBytes = captureUtf8ByteLength(skeletonWithoutBodies);

  let userBudget = Math.max(0, maxContextBytes - skeletonBytes);
  if (textResponses.length > 0 && userBudget > 1024) {
    const preferredAiFloor = Math.min(4096, Math.floor(maxContextBytes * 0.25));
    userBudget = Math.max(256, userBudget - preferredAiFloor);
  }

  const boundedUser =
    captureUtf8ByteLength(userPrompt) <= userBudget
      ? userPrompt
      : truncateCaptureToMaxBytes(userPrompt, userBudget, CAPTURE_CONTEXT_TRUNCATION_MARKER);

  const prefix = joinSections([
    ...memorySections,
    "## User Request",
    "---",
    boundedUser,
    "---\n",
    ...toolsSections,
  ]);

  if (textResponses.length === 0) {
    if (captureUtf8ByteLength(prefix) <= maxContextBytes) return prefix;
    return truncateCaptureToMaxBytes(prefix, maxContextBytes, CAPTURE_CONTEXT_TRUNCATION_MARKER);
  }

  // Insert AI section before tools to preserve the historical section order.
  const prefixWithoutTools = joinSections([
    ...memorySections,
    "## User Request",
    "---",
    boundedUser,
    "---\n",
  ]);
  const toolsBlock = toolsSections.length > 0 ? "\n" + joinSections(toolsSections) : "";
  const aiWrapperBytes = captureUtf8ByteLength(joinSections(["## AI Response", "---", "", "---\n"]));
  const aiBudget = Math.max(
    0,
    maxContextBytes -
      captureUtf8ByteLength(prefixWithoutTools) -
      captureUtf8ByteLength(toolsBlock) -
      aiWrapperBytes,
  );
  const boundedAi = fitTextResponses(textResponses, aiBudget);

  const result = joinSections([
    ...memorySections,
    "## User Request",
    "---",
    boundedUser,
    "---\n",
    "## AI Response",
    "---",
    boundedAi,
    "---\n",
    ...toolsSections,
  ]);

  if (captureUtf8ByteLength(result) <= maxContextBytes) return result;
  return truncateCaptureToMaxBytes(result, maxContextBytes, CAPTURE_CONTEXT_TRUNCATION_MARKER);
}
