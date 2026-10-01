// LLM structured extraction for auto-capture, ported from opencode-mem's `generateSummary`
// (opencode-mem/src/services/auto-capture.ts).
//
// Both of opencode-mem's provider paths are preserved:
//   1. schema-constrained structured output (its OpenCode provider path)
//   2. a `save_memory` tool call whose JSON arguments are parsed by hand
//      (its external API fallback)
// Neither is bound to an OpenCode runtime here — the caller injects the transport.
import { buildBoundedSummaryPrompt } from "./context.js";
import { detectCaptureLanguage, getCaptureLanguageName } from "./language.js";
import type {
  CaptureCompleteStructured,
  CaptureCompleteText,
  CapturePromptRecord,
  CaptureSummary,
} from "./types.js";

/** JSON Schema for the structured-output path (opencode-mem builds this from zod). */
export const CAPTURE_SUMMARY_JSON_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    type: { type: "string" },
    tags: { type: "array", items: { type: "string" } },
  },
  required: ["summary", "type", "tags"],
} as const;

/** Tool definition for the tool-call path (verbatim from opencode-mem). */
export const CAPTURE_TOOL_SCHEMA = {
  type: "function" as const,
  function: {
    name: "save_memory",
    description: "Save the conversation summary as a memory",
    parameters: {
      type: "object",
      properties: {
        summary: {
          type: "string",
          description: "Markdown-formatted summary of the conversation",
        },
        type: {
          type: "string",
          description:
            "Type of memory: 'skip' for non-technical conversations, or technical type (feature, bug-fix, refactor, analysis, configuration, discussion, other)",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "List of 2-4 technical tags related to the memory",
        },
      },
      required: ["summary", "type", "tags"],
    },
  },
};

export function buildCaptureSystemPrompt(languageName: string): string {
  return `You are a technical memory recorder for a software development project.

RULES:
1. ONLY capture technical work (code, bugs, features, architecture, config)
2. SKIP non-technical by returning type="skip"
3. NO meta-commentary or behavior analysis
4. Include specific file names, functions, technical details
5. Generate 2-4 technical tags (e.g., "react", "auth", "bug-fix")
6. You MUST write the summary in ${languageName}.

FORMAT:
## Request
[1-2 sentences: what was requested, in ${languageName}]

## Outcome
[1-2 sentences: what was done, include files/functions, in ${languageName}]

SKIP if: greetings, casual chat, no code/decisions made
CAPTURE if: code changed, bug fixed, feature added, decision made`;
}

/** System prompt for `record`'s prompt language (opencode-mem: `autoCaptureLanguage`). */
export function resolveCaptureSystemPrompt(record: CapturePromptRecord): string {
  return buildCaptureSystemPrompt(getCaptureLanguageName(detectCaptureLanguage(record.content)));
}

function normalizeCaptureSummary(raw: unknown): CaptureSummary | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const value = raw as Partial<CaptureSummary>;
  if (typeof value.summary !== "string" || typeof value.type !== "string") {
    return null;
  }
  const tags = Array.isArray(value.tags)
    ? value.tags
        .filter((tag): tag is string => typeof tag === "string")
        .map((tag) => tag.toLowerCase().trim())
        .filter((tag) => tag.length > 0)
    : [];
  return { summary: value.summary, type: value.type, tags };
}

/** Pull the first balanced JSON object/array out of a model response. */
function findJsonObject(text: string): string | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/iu);
  const candidate = fenced?.[1] ?? text;
  const start = candidate.search(/[{[]/u);
  if (start < 0) {
    return null;
  }
  const open = candidate[start]!;
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < candidate.length; i++) {
    const char = candidate[i]!;
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === open) {
      depth += 1;
    } else if (char === close) {
      depth -= 1;
      if (depth === 0) {
        return candidate.slice(start, i + 1);
      }
    }
  }
  return null;
}

function unwrapToolCallArguments(value: Record<string, unknown>): unknown {
  const toolCalls = value.tool_calls ?? value.toolCalls ?? value.tools;
  if (Array.isArray(toolCalls) && toolCalls.length > 0) {
    const first = toolCalls[0] as Record<string, unknown>;
    const fn = (first?.function ?? first) as Record<string, unknown>;
    const args = fn?.arguments ?? fn?.args ?? fn?.input;
    if (typeof args === "string") {
      return JSON.parse(args);
    }
    if (args && typeof args === "object") {
      return args;
    }
  }
  const content = value.content ?? value.text ?? value.output;
  if (typeof content === "string" && content.includes("{")) {
    const nested = findJsonObject(content);
    if (nested) {
      try {
        return JSON.parse(nested);
      } catch {
        return null;
      }
    }
  }
  return null;
}

/**
 * Parse a model response into a `CaptureSummary`.
 * Accepts a bare object, a fenced block, or a tool-call envelope — the three shapes
 * opencode-mem's provider factory normalizes before returning.
 */
export function parseCaptureSummary(raw: string): CaptureSummary | null {
  const jsonText = findJsonObject(raw);
  if (!jsonText) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return null;
  }
  const direct = normalizeCaptureSummary(parsed);
  if (direct) {
    return direct;
  }
  if (parsed && typeof parsed === "object") {
    const nested = unwrapToolCallArguments(parsed as Record<string, unknown>);
    if (nested && typeof nested === "object") {
      return normalizeCaptureSummary(nested);
    }
  }
  return null;
}

export type CaptureExtractionParams = {
  context: string;
  record: CapturePromptRecord;
  systemPrompt: string;
};

/**
 * Run one extraction attempt. The structured path is tried first; when it is absent
 * or fails, the text path parses the model's `save_memory` payload by hand — the
 * same precedence opencode-mem applies between its provider implementations.
 */
export async function extractCaptureSummary(
  params: CaptureExtractionParams & {
    completeStructured?: CaptureCompleteStructured;
    complete: CaptureCompleteText;
  },
): Promise<CaptureSummary> {
  const { context, record, systemPrompt } = params;
  const prompt = buildBoundedSummaryPrompt(
    context,
    systemPrompt,
    CAPTURE_SUMMARY_JSON_SCHEMA,
  );

  if (params.completeStructured) {
    try {
      const structured = await params.completeStructured({ systemPrompt, prompt, record });
      const normalized = normalizeCaptureSummary(structured);
      if (normalized) {
        return normalized;
      }
    } catch {
      // Fall through to the text path; opencode-mem reports this as a provider warning.
    }
  }

  const raw = await params.complete({ systemPrompt, prompt, record });
  const parsed = parseCaptureSummary(raw);
  if (!parsed) {
    throw new Error("Auto-capture extraction returned no parseable summary");
  }
  return parsed;
}
