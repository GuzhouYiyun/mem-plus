// Lane 2: deep recall, on OpenCode.
//
// WHAT UPSTREAM DOES
//   `extensions/active-memory/{escalation,recall,recall-run,prompt,transcript-result,
//   recall-state}.ts`, copied verbatim into this tree. Read together they do one thing:
//   when the escalation gate says this turn is asking about the past, open a *nested agent*
//   (`runEmbeddedAgent`) whose tool allowlist is `memory_search` / `memory_get`, let it
//   search memory, and inject the summary it returns. The transcript upstream reads is that
//   sub-agent's own transcript -- it is how a timeout still yields partial text and how a
//   dead memory tool is noticed -- not the user's conversation history.
//
// WHAT IS CALLED DIRECTLY HERE
//   `escalation.ts` imports and runs unchanged (it has zero SDK dependencies), so
//   `resolveRecallEscalationDecision` and `hasRecallIntent` are upstream's own functions.
//   The text of the recall prompt and the summary normalisation below are copied verbatim out
//   of `prompt.ts`, because that *module* cannot be imported here: it reaches
//   `openclaw/plugin-sdk/agent-runtime`, whose `../agents/model-thinking-default.js` the trim
//   removed. The prompt text is the part that carries policy; the module plumbing around it
//   is not reachable. The constants it needs (`NO_RECALL_VALUES`,
//   `TIMEOUT_BOILERPLATE_PATTERNS`, the tag names, the outcome texts) come from `types.ts` and
//   are reproduced with upstream's values.
//
// WHY THE LOOP IS WRITTEN HERE
//   Upstream gets a real tool loop because `runEmbeddedAgent` dispatches to the host's agent
//   runtime. OpenCode's `ctx.generate.text` is text-only: no `tools`, no tool-call channel, no
//   system prompt. So the loop that upstream gets for free is written by hand here, and the
//   one thing that would be most wasteful to reimplement -- the memory tools -- is NOT
//   reimplemented: `buildMemoryTools` hands back the very `memory_search` and `memory_get`
//   the agent sees, and this calls them. Only the dispatch around them is new.
//
// THE TOOL-CALL ENVELOPE
//   Because there is no tool-call channel, the model is asked for one JSON object per turn:
//   `{"tool":"memory_search","args":{...}}` to call a tool, or `{"summary":"..."}` / `NONE` to
//   finish. That is a deviation forced by the host and has no upstream counterpart; the
//   behaviour it wraps -- which tools, how many rounds, what counts as a usable answer --
//   follows upstream's settings.
import { resolveRecallEscalationDecision } from "../../extensions/active-memory/escalation.js";
import { completeThroughHost } from "./llm.js";
import type { MemoryTool } from "./memory-tools.js";
import { truncateUtf16Safe } from "../../packages/normalization-core/src/utf16-slice.js";
import type { HostedModelRef } from "./model/config.js";
import type { PluginContext } from "./opencode.js";

// --- upstream constants, verbatim ------------------------------------------------

const ACTIVE_MEMORY_CONTEXT_HEADER = "Context:";
const ACTIVE_MEMORY_PLUGIN_TAG = "active_memory_plugin";
const ACTIVE_MEMORY_OPEN_TAG = `<${ACTIVE_MEMORY_PLUGIN_TAG}>`;
const ACTIVE_MEMORY_CLOSE_TAG = `</${ACTIVE_MEMORY_PLUGIN_TAG}>`;

const NO_RECALL_VALUES = new Set([
  "",
  "none",
  "no_reply",
  "no reply",
  "nothing useful",
  "no relevant memory",
  "no relevant memories",
  "timeout",
  "timed out",
  "request timed out",
  "llm request timed out",
  "the llm request timed out",
  "[]",
  "{}",
  "null",
  "n/a",
]);

const TIMEOUT_BOILERPLATE_PATTERNS = [
  /^(?:error:\s*)?(?:the\s+)?(?:llm|model|request|operation|agent)\s+(?:request\s+)?timed out\b/i,
  /^(?:error:\s*)?active-memory timeout after \d+ms\b/i,
];

const ASSISTANT_CHITCHAT_PATTERNS = [
  /^(?:hello|hi|hey|greetings)\b(?=.{0,120}(?:\b(?:help|assist|message|question|need)\b|\b(?:how|what)\s+(?:can|may|do)\b|cut off|come through))/i,
  /^(?:hello|hi|hey|greetings)[!.,?]?\s*$/i,
  /^(?:it\s+)?(?:seems?|looks?)\s+like\s+(?:your\s+)?(?:message|text|input|query).{0,40}(?:cut\s+off|incomplete|didn'?t\s+come\s+through|missing)/i,
  /^(?:could|can|would|please).{0,20}(?:provide|share|give|clarify|elaborate|repeat).{0,20}(?:details|information|context)/i,
  /^(?:(?:i(?:'?m|\s+am)\s+(?:here|happy|ready|glad)\s+to|i\s+can)\s+(?:help|assist)|(?:please\s+)?(?:let\s+me\s+know|tell\s+me|feel\s+free).{0,30}(?:help|assist|question|need))/i,
  /^(?:您好|你好|嗨)(?:[！!？?，,\s]*$|(?=.{0,120}(?:帮助|请问|问题|需要|消息|请求)))/u,
  /^(?:看起来|似乎).{0,20}(?:消息|信息).{0,20}(?:没有|未|截断|不完整)/u,
  /^(?:当前模型|当前日期|当前时间|今天).{0,100}(?:帮助|请|如果)/u,
];

const ACTIVE_MEMORY_RECALL_OUTCOME_TEXT = {
  "skipped-no-recall-intent":
    "Active Memory intentionally skipped deep recall because this turn did not ask for past context.",
  unavailable:
    "Active Memory could not retrieve memory for this turn. Do not assume that no relevant memory exists.",
} as const;

/** Upstream's `types.ts` defaults (`DEFAULT_TIMEOUT_MS` and friends). */
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_SUMMARY_CHARS = 220;
const DEFAULT_CIRCUIT_BREAKER_MAX_TIMEOUTS = 3;
const DEFAULT_CIRCUIT_BREAKER_COOLDOWN_MS = 60_000;
const DEFAULT_TOOLS_ALLOW = ["memory_search", "memory_get"] as const;

/**
 * Rounds of tool use before the answer is taken as final. Upstream has no such counter -- the
 * host's agent loop ends when the model stops calling tools -- so this bounds a loop the model
 * cannot end on its own. It is a ceiling on a runaway, not a policy: a normal recall answers
 * in one or two rounds.
 */
const MAX_TOOL_ROUNDS = 4;

// --- upstream prompt / summary text, copied verbatim ------------------------------

type PromptStyle = "balanced" | "strict" | "contextual" | "recall-heavy" | "precision-heavy" | "preference-only";

/** Upstream's `buildPromptStyleLines`. */
function buildPromptStyleLines(style: PromptStyle): string[] {
  switch (style) {
    case "strict":
      return [
        "Treat the latest user message as the only primary query.",
        "Use any additional context only for narrow disambiguation.",
        "Do not return memory just because it matches the broader conversation topic.",
        "Return memory only if it clearly helps with the latest user message itself.",
        "If the latest user message does not strongly call for memory, reply with NONE.",
        "If the connection is weak, indirect, or speculative, reply with NONE.",
      ];
    case "contextual":
      return [
        "Treat the latest user message as the primary query.",
        "Use recent conversation to understand continuity and intent, but do not let older context override the latest user message.",
        "When the latest message shifts domains, prefer memory that matches the new domain.",
        "Return memory when it materially helps the other model answer the latest user message or maintain clear conversational continuity.",
      ];
    case "recall-heavy":
      return [
        "Treat the latest user message as the primary query, but be willing to surface memory on softer plausible matches when it would add useful continuity or personalization.",
        "If there is a credible recurring preference, habit, or user-context match, lean toward returning memory instead of NONE.",
        "Still prefer the memory domain that best matches the latest user message.",
      ];
    case "precision-heavy":
      return [
        "Treat the latest user message as the primary query.",
        "Use recent conversation only for narrow disambiguation.",
        "Aggressively prefer NONE unless the memory clearly and directly helps with the latest user message.",
        "Do not return memory for soft, speculative, or loosely adjacent matches.",
      ];
    case "balanced":
    case "preference-only":
    default:
      return [];
  }
}

/** Upstream's `buildRecallPrompt`, with the envelope for tool use appended. */
export function buildRecallPrompt(params: {
  query: string;
  searchQuery: string;
  promptStyle: PromptStyle;
  toolsAllow: readonly string[];
  promptOverride?: string;
  promptAppend?: string;
}): string {
  const defaultInstructions = [
    "You are a memory search agent.",
    "Another model is preparing the final user-facing answer.",
    "Your job is to search memory and return only the most relevant memory context for that model.",
    "You receive a bounded search query plus conversation context, including the user's latest message.",
    "Use only the available memory tools.",
    "Use the bounded search query with the configured memory tools.",
    `Configured memory tools: ${params.toolsAllow.join(", ")}.`,
    "Do not use channel metadata, provider metadata, debug output, or the full conversation context as the memory tool query.",
    "If the available memory tools find nothing useful, reply with NONE.",
    "When searching for preference or habit recall, use permissive search limits or thresholds before deciding that no useful memory exists.",
    "Do not answer the user directly.",
    `Prompt style: ${params.promptStyle}.`,
    ...buildPromptStyleLines(params.promptStyle),
    "If the user is directly asking about favorites, preferences, habits, routines, or personal facts, treat that as a strong recall signal.",
    "Questions like 'what is my favorite food', 'do you remember my flight preferences', or 'what do i usually get' should normally return memory when relevant results exist.",
    "If the provided conversation context already contains recalled-memory summaries, debug output, or prior memory/tool traces, ignore that surfaced text unless the latest user message clearly requires re-checking it.",
    "Return memory only when it would materially help the other model answer the user's latest message.",
    "Mutable operational facts (cron/job health, automation status, deployments, incidents, service availability) go stale quickly: include the source timestamp when available, say when the memory may be stale, and tell the answering model to verify live before relying on it.",
    "Do not summarize mutable operational facts as simply current/running/healthy unless the memory result itself contains a current source timestamp and matching health state.",
    "If the connection is weak, broad, or only vaguely related, reply with NONE.",
    "If nothing clearly useful is found, reply with NONE.",
    "",
    // The envelope. Upstream gets a tool channel from the host; this asks for the same
    // decision as one JSON object, and nothing else is accepted.
    "Reply with exactly one JSON object and nothing else:",
    `{"tool":"<one of: ${params.toolsAllow.join(", ")}>","args":{...}} to use a memory tool,`,
    '{"summary":"..."} when you have the memory context worth passing on,',
    '{"summary":"NONE"} when you do not.',
    `Keep the summary under ${DEFAULT_MAX_SUMMARY_CHARS} characters.`,
    "Write the summary as a memory note about the user, not as a reply to the user.",
    "Do not explain your reasoning.",
    "Do not return bullets, numbering, labels, XML, JSON, or markdown list formatting outside the object.",
    "Do not prefix the summary with 'Memory:' or any other label.",
    "",
    "Good examples:",
    'Reply: {"summary":"User\'s favorite food is ramen; tacos also come up often."}',
    'Reply: {"summary":"User prefers aisle seats and extra buffer over tight connections."}',
    'Reply: {"summary":"NONE"}',
    "",
    "Bad examples:",
    'Reply: - Favorite food is ramen',
    'Reply: 1. Favorite food is ramen',
    'Reply: Memory: Favorite food is ramen',
    'Reply: Ramen seems to be your favorite food.',
    'Reply: You like aisle seats and extra buffer.',
  ];
  const instructionBlock = [
    params.promptOverride ?? defaultInstructions,
    params.promptAppend ? `Additional operator instructions:\n${params.promptAppend}` : "",
  ]
    .filter((section) => section.length > 0)
    .join("\n\n");
  return [
    instructionBlock,
    `Bounded memory search query:\n${params.searchQuery}`,
    `Conversation context:\n${params.query}`,
  ].join("\n\n");
}

/** Upstream's `normalizeActiveSummary`. */
export function normalizeActiveSummary(rawReply: string): string | null {
  const singleLine = rawReply.replace(/\s+/g, " ").trim();
  if (
    NO_RECALL_VALUES.has(singleLine.toLowerCase()) ||
    TIMEOUT_BOILERPLATE_PATTERNS.some((pattern) => pattern.test(singleLine)) ||
    ASSISTANT_CHITCHAT_PATTERNS.some((pattern) => pattern.test(singleLine))
  ) {
    return null;
  }
  return singleLine;
}

/** Upstream's `truncateSummary`. */
export function truncateSummary(summary: string, maxSummaryChars: number): string {
  const trimmed = summary.trim();
  if (trimmed.length <= maxSummaryChars) return trimmed;
  const ellipsis = "…";
  if (maxSummaryChars <= ellipsis.length) return ellipsis.slice(0, Math.max(0, maxSummaryChars));
  const contentMaxChars = maxSummaryChars - ellipsis.length;
  const rawBounded = trimmed.slice(0, contentMaxChars).trimEnd();
  const bounded = truncateUtf16Safe(trimmed, contentMaxChars).trimEnd();
  const nextChar = trimmed.charAt(contentMaxChars);
  if (!nextChar || /\s/.test(nextChar)) return `${bounded}${ellipsis}`;
  const lastBoundary = rawBounded.search(/\s\S*$/);
  if (lastBoundary > 0) return `${truncateUtf16Safe(trimmed, lastBoundary).trimEnd()}${ellipsis}`;
  return `${bounded}${ellipsis}`;
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Upstream's `buildPromptPrefix` / `buildRecallOutcomePrefix`. */
export function buildPromptPrefix(summary: string): string {
  return [
    ACTIVE_MEMORY_CONTEXT_HEADER,
    ACTIVE_MEMORY_OPEN_TAG,
    escapeXml(summary),
    ACTIVE_MEMORY_CLOSE_TAG,
  ].join("\n");
}

export function buildRecallOutcomePrefix(outcome: keyof typeof ACTIVE_MEMORY_RECALL_OUTCOME_TEXT): string {
  return buildPromptPrefix(ACTIVE_MEMORY_RECALL_OUTCOME_TEXT[outcome]);
}

// --- the runner -------------------------------------------------------------------

/** The config this port reads; every default is upstream's. */
export type DeepRecallConfig = {
  readonly enabled: boolean;
  readonly mode: "off" | "escalate" | "always";
  readonly promptStyle: PromptStyle;
  readonly toolsAllow: readonly string[];
  readonly timeoutMs: number;
  readonly maxSummaryChars: number;
  readonly circuitBreakerMaxTimeouts: number;
  readonly circuitBreakerCooldownMs: number;
  readonly promptOverride?: string;
  readonly promptAppend?: string;
};

/** Permissive read, like every other section: `ctx.options` is untyped JSON. */
export function readDeepRecallConfig(options: unknown): DeepRecallConfig {
  const root =
    typeof options === "object" && options !== null ? (options as Record<string, unknown>) : {};
  const section =
    typeof root["recall"] === "object" && root["recall"] !== null
      ? (root["recall"] as Record<string, unknown>)
      : {};
  const num = (value: unknown, fallback: number): number =>
    typeof value === "number" && Number.isFinite(value) ? value : fallback;
  const mode = section["mode"];
  return {
    enabled: section["enabled"] !== false,
    mode: mode === "off" || mode === "always" ? mode : "escalate",
    promptStyle:
      section["promptStyle"] === "strict" ||
      section["promptStyle"] === "contextual" ||
      section["promptStyle"] === "recall-heavy" ||
      section["promptStyle"] === "precision-heavy"
        ? section["promptStyle"]
        : "balanced",
    toolsAllow: Array.isArray(section["toolsAllow"])
      ? (section["toolsAllow"] as string[])
      : [...DEFAULT_TOOLS_ALLOW],
    timeoutMs: num(section["timeoutMs"], DEFAULT_TIMEOUT_MS),
    maxSummaryChars: num(section["maxSummaryChars"], DEFAULT_MAX_SUMMARY_CHARS),
    circuitBreakerMaxTimeouts: num(
      section["circuitBreakerMaxTimeouts"],
      DEFAULT_CIRCUIT_BREAKER_MAX_TIMEOUTS,
    ),
    circuitBreakerCooldownMs: num(
      section["circuitBreakerCooldownMs"],
      DEFAULT_CIRCUIT_BREAKER_COOLDOWN_MS,
    ),
    ...(typeof section["promptOverride"] === "string" ? { promptOverride: section["promptOverride"] } : {}),
    ...(typeof section["promptAppend"] === "string" ? { promptAppend: section["promptAppend"] } : {}),
  };
}

export type DeepRecallOutcome = { readonly context: string } | { readonly context: null; readonly reason: string };

/** Upstream's circuit breaker, keyed as it is: model, not session. */
const breakers = new Map<string, { consecutiveTimeouts: number; lastTimeoutAt: number }>();

function breakerOpen(key: string, config: DeepRecallConfig, nowMs: number): boolean {
  const entry = breakers.get(key);
  if (!entry) return false;
  return (
    entry.consecutiveTimeouts >= config.circuitBreakerMaxTimeouts &&
    nowMs - entry.lastTimeoutAt < config.circuitBreakerCooldownMs
  );
}

function noteTimeout(key: string, nowMs: number): void {
  const entry = breakers.get(key);
  breakers.set(key, {
    consecutiveTimeouts: (entry?.consecutiveTimeouts ?? 0) + 1,
    lastTimeoutAt: nowMs,
  });
}

function noteSuccess(key: string): void {
  breakers.delete(key);
}

/** One tool turn's parsed answer. */
type Turn =
  | { readonly kind: "tool"; readonly tool: string; readonly args: Record<string, unknown> }
  | { readonly kind: "summary"; readonly summary: string }
  | { readonly kind: "unparsable"; readonly raw: string };

function parseTurn(raw: string): Turn {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return { kind: "unparsable", raw };
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
    if (typeof parsed["tool"] === "string") {
      return {
        kind: "tool",
        tool: parsed["tool"],
        args:
          typeof parsed["args"] === "object" && parsed["args"] !== null
            ? (parsed["args"] as Record<string, unknown>)
            : {},
      };
    }
    if (typeof parsed["summary"] === "string") {
      return { kind: "summary", summary: parsed["summary"] };
    }
  } catch {
    // Falls through to the unparsable branch: one more round is cheaper than a failure.
  }
  return { kind: "unparsable", raw };
}

/**
 * Deep recall for one turn.
 *
 * Never throws. Upstream's own guarantee is that a failed recall omits the block rather than
 * the turn, so every failure here is a value the caller turns into "no block".
 */
export async function runDeepRecall(params: {
  ctx: PluginContext;
  config: DeepRecallConfig;
  /** The tools the allowlist names, resolved from the ones the agent already has. */
  tools: readonly MemoryTool[];
  message: string;
  conversationContext: string;
  searchQuery: string;
  hasStrongLaneOneHit: boolean;
  model?: HostedModelRef;
  log: (message: string, detail?: unknown) => void;
}): Promise<DeepRecallOutcome> {
  const { config } = params;
  if (!config.enabled) return { context: null, reason: "disabled" };
  // Upstream's gate, upstream's function: `mode: "off"` never runs, `"always"` always does,
  // and a strong lane-one hit short-circuits before a second lookup is paid for.
  const decision = resolveRecallEscalationDecision({
    mode: config.mode,
    message: params.message,
    hasStrongLaneOneHit: params.hasStrongLaneOneHit,
  });
  if (decision === "mode-off") return { context: buildRecallOutcomePrefix("skipped-no-recall-intent") };
  if (decision === "strong-lane-one-hit") return { context: null, reason: decision };
  if (decision !== "recall") return { context: buildRecallOutcomePrefix("skipped-no-recall-intent") };

  const breakerKey = params.model ? `${params.model.providerID}/${params.model.id}` : "opencode-default";
  const startedAt = Date.now();
  if (breakerOpen(breakerKey, config, startedAt)) {
    params.log("deep recall skipped: circuit breaker open for the model");
    return { context: buildRecallOutcomePrefix("unavailable") };
  }

  const byName = new Map(params.tools.map((tool) => [tool.name, tool]));
  const usable = config.toolsAllow.filter((name) => byName.has(name));
  if (usable.length === 0) {
    params.log("deep recall skipped: none of the allowed memory tools are registered");
    return { context: buildRecallOutcomePrefix("unavailable") };
  }

  let prompt = buildRecallPrompt({
    query: params.conversationContext,
    searchQuery: params.searchQuery,
    promptStyle: config.promptStyle,
    toolsAllow: usable,
    ...(config.promptOverride ? { promptOverride: config.promptOverride } : {}),
    ...(config.promptAppend ? { promptAppend: config.promptAppend } : {}),
  });
  let finalRaw: string | undefined;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    const reply = await completeThroughHost(
      params.ctx,
      {
        purpose: "deep recall",
        prompt,
        timeoutMs: config.timeoutMs,
        ...(params.model ? { model: params.model } : {}),
      },
      params.log,
    );
    if (reply.text === null) {
      // Upstream's outcome for a recall that did not finish in time: say so rather than
      // pretend there is no memory.
      noteTimeout(breakerKey, Date.now());
      return { context: buildRecallOutcomePrefix("unavailable") };
    }
    const turn = parseTurn(reply.text);
    if (turn.kind === "summary") {
      finalRaw = turn.summary;
      break;
    }
    if (turn.kind === "unparsable") {
      finalRaw = turn.raw;
      break;
    }
    if (!usable.includes(turn.tool)) {
      // Upstream's allowlist is authoritative and the host enforces it; here the model chose
      // a name, so it is checked rather than trusted.
      prompt = `${prompt}\n\nTool "${turn.tool}" is not available. Use one of: ${usable.join(", ")}.`;
      continue;
    }
    const tool = byName.get(turn.tool);
    if (!tool) continue;
    let observation: string;
    try {
      const result = await tool.execute(turn.args as never, {
        sessionID: "deep-recall",
        messageID: "deep-recall",
      } as never);
      observation = typeof result.content === "string" ? result.content : JSON.stringify(result.content);
    } catch (error) {
      observation = `Tool failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    prompt = [
      prompt,
      `Tool result (${turn.tool}):`,
      observation,
      "",
      "Reply with the next single JSON object.",
    ].join("\n\n");
  }

  if (finalRaw === undefined) {
    // The model kept asking for tools. Upstream's loop would keep going too; this stops and
    // says nothing was concluded, which is the same answer as "no useful memory".
    params.log("deep recall hit the tool-round ceiling without a summary");
    return { context: buildRecallOutcomePrefix("unavailable") };
  }

  const normalized = normalizeActiveSummary(finalRaw);
  if (normalized === null) {
    noteSuccess(breakerKey);
    return { context: null, reason: "no memory" };
  }
  noteSuccess(breakerKey);
  params.log(`deep recall: ${truncateSummary(normalized, config.maxSummaryChars).length} chars`);
  return { context: buildPromptPrefix(truncateSummary(normalized, config.maxSummaryChars)) };
}

/**
 * The recall tools, taken from the ones the agent already has rather than rebuilt.
 *
 * Upstream resolves `toolsAllow` against the host's memory tool registry at run time; on
 * OpenCode the registry is `buildMemoryTools`, so this filters its output to the allowlist.
 */
export function recallToolsFor(
  config: DeepRecallConfig,
  built: { readonly available: boolean; readonly tools: readonly MemoryTool[] },
): readonly MemoryTool[] {
  if (!built.available) return [];
  const names = new Set(config.toolsAllow);
  return built.tools.filter((tool) => names.has(tool.name));
}