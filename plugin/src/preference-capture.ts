// Preference capture: durable user preferences, written into the workspace
// `USER.md` managed block (companion-plan §3 Phase 3 item 1).
//
// WHY A SEPARATE PASS
//   The capture extractor (`extensions/memory-core/src/capture/extract.ts`) is
//   prompt-bound to technical memory and its system prompt explicitly forbids
//   meta-commentary or behaviour analysis -- preferences can never come from its
//   records, so a companion that learns "who you are" needs its own channel.
//   The channel upstream would use (the agent authoring curated entries during a
//   turn, `buildProjectMemoryWriteInstruction`) is not exposed by mem-plus's host,
//   so this is a from-scratch piece built to openclaw's intent for USER.md:
//   durable profile directives, injected every session through the provenance
//   gate as an `agent`-origin workspace file (memory-chain §1a; classification
//   order in memory-artifact-provenance.ts leaves unannotated workspace markdown
//   to `agent`, which this write produces).
//
// COST MODEL
//   One regex gate on the raw user text (zero cost) decides whether the message
//   even mentions a preference; only gated messages pay one small LLM call.
//   Default-on with no kill-switch (owner decision 2026-11-07): a companion that
//   can be silently muzzled on identity learning is not the organ that was
//   transplanted. `model.hostedModel` still redirects the call when configured.
//
// NEVER BLOCKS THE TURN
//   Runs detached from the event handler; every failure path ends in a log line.
//   A missed preference costs nothing it cannot recover on the next phrasing.
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PluginContext } from "./opencode.js";
import type { HostedModelRef } from "./model/config.js";
import { completeThroughHost } from "./llm.js";
import { withMemoryFileLock } from "./memory-file-lock.js";

const BLOCK_BEGIN = "<!-- mem-plus:user-preferences begin -->";
const BLOCK_END = "<!-- mem-plus:user-preferences end -->";
/** The managed block's ceiling: USER.md is injected whole each session, so the
 * block must stay far below the bootstrap per-file cap (20k) and short enough to
 * read as a profile rather than a diary. */
const BLOCK_MAX_CHARS = 4_000;
const MAX_ENTRIES_PER_CALL = 6;
const ENTRY_MAX_CHARS = 160;
const EXTRACT_TIMEOUT_MS = 45_000;

/**
 * Cheap gate over the raw user message. Phrases that state a standing preference
 * in zh-Hans or en -- anything matched here may cost one extraction call that
 * answers "nothing", which is why the list is allowed to be over-eager; a phrase
 * not listed here simply defers to the next time the user says it differently.
 * Length window: shorter than 4 chars cannot carry a preference; longer than
 * 600 is a task description, not a profile utterance.
 */
const PREFERENCE_GATE =
  /我(?:更)?(?:喜欢|偏好|习惯|倾向|希望|想要|讨厌|不喜欢|不太想|以后)|以后(?:都|就|请|别|不再)|从(?:现|今)以?后起?|再也别|别再|不要再|不再用|请(?:记住|直接|以后|保持)|记住[：:,，]?(?:我|以后)|用[^\s，。,.]{1,20}(?:别|不用|不要|而非|而不是)|别用|(?:prefer|would rather|I like|I hate|from now on|always use|never use|don't use|stop using|remember (?:to|that|I)|my (?:name|shell|editor|browser|package manager|default)\b)/iu;

function gatePasses(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 4 || trimmed.length > 600) return false;
  return PREFERENCE_GATE.test(trimmed);
}

export type PreferenceEntry = {
  readonly text: string;
  /** An earlier line this one replaces, by (a fragment of) its text; null/absent
   * when nothing it touches. */
  readonly supersedes?: string | null;
};

/** Normalize a rendered line or an entry to its preference text for dedupe and
 * supersede matching: strip the `- ` bullet, the date, and a supersede tag,
 * collapse whitespace, lowercase. */
function preferenceText(value: string): string {
  return value
    .replace(/^-\s*/, "")
    .replace(/^\d{4}-\d{2}-\d{2}:\s*/, "")
    .replace(/\[superseded\]\s*/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function sanitizeEntryText(value: string): string {
  return value.replace(/\s+/g, " ").replace(/[<>`]/g, "").trim().slice(0, ENTRY_MAX_CHARS);
}

/**
 * Merge new entries into the existing managed lines. Pure: probes drive it
 * directly. Rules:
 *  - an exact active duplicate is skipped ("changed" stays false);
 *  - a `supersedes` fragment marks the matching active line `[superseded]` --
 *    history is kept, never deleted (owner decision: supersede tagging);
 *  - cap: overflow evicts the oldest superseded lines first, then the oldest
 *    active ones, so the block stays bounded (the unbounded-index failure mode
 *    at memory-chain §11 applies to injected profile files too);
 *  - lines stay in chronological order of first appearance.
 */
export function mergePreferenceLines(
  existing: readonly string[],
  entries: readonly PreferenceEntry[],
  today: string,
): { lines: string[]; changed: boolean; added: number; superseded: number; dropped: string[] } {
  const lines = [...existing];
  let changed = false;
  let added = 0;
  let supersededCount = 0;

  for (const entry of entries) {
    const text = sanitizeEntryText(entry.text ?? "");
    if (text.length === 0) continue;
    const norm = preferenceText(text);
    if (norm.length === 0) continue;

    const activeIndex = lines.findIndex(
      (line) => !/\[superseded\]/i.test(line) && preferenceText(line) === norm,
    );
    if (activeIndex >= 0) continue; // already the standing preference

    const needle = sanitizeEntryText(entry.supersedes ?? "").toLowerCase();
    // A fragment shorter than this could mark an unrelated line; fragments are
    // the model quoting a piece of the old preference, so 3 covers "npm" and
    // "bun" while the marker scan only ever touches active lines.
    if (needle.length >= 3) {
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i] ?? "";
        if (/\[superseded\]/i.test(line)) continue;
        if (preferenceText(line).includes(needle)) {
          const replacement = line.replace(/:\s*/, ": [superseded] ");
          if (replacement !== line) {
            lines[i] = replacement;
            changed = true;
            supersededCount += 1;
          }
          break;
        }
      }
    }

    lines.push(`- ${today}: ${text}`);
    added += 1;
    changed = true;
  }

  const dropped: string[] = [];
  const overBudget = () => blockChars(lines) > BLOCK_MAX_CHARS;
  while (overBudget()) {
    // Oldest superseded lines first: they are history, not policy.
    const evict =
      lines.findIndex((line) => /\[superseded\]/i.test(line)) ?? -1;
    const index = evict >= 0 ? evict : lines.findIndex(() => true);
    if (index < 0) break;
    dropped.push(lines.splice(index, 1)[0] ?? "");
    changed = true;
  }

  return { lines, changed, added, superseded: supersededCount, dropped };
}

function blockChars(lines: readonly string[]): number {
  return lines.reduce((total, line) => total + line.length + 1, 0);
}

/** Split a USER.md into (before, managed lines, after). The owner's own text
 * outside the markers is carried through untouched on every rewrite. */
export function extractPreferenceBlock(content: string): {
  before: string;
  lines: string[];
  after: string;
} {
  const begin = content.indexOf(BLOCK_BEGIN);
  const end = content.indexOf(BLOCK_END);
  if (begin < 0 || end < 0 || end < begin) return { before: content, lines: [], after: "" };
  const inner = content.slice(begin + BLOCK_BEGIN.length, end);
  const lines = inner
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "));
  return { before: content.slice(0, begin), lines, after: content.slice(end + BLOCK_END.length) };
}

function renderBlock(lines: readonly string[]): string {
  const body = lines.length > 0 ? `${lines.join("\n")}\n` : "";
  return `${BLOCK_BEGIN}\n${body}${BLOCK_END}\n`;
}

/**
 * Apply entries to the workspace USER.md under the file lock. Returns false when
 * nothing changed (the common case: gate passed, model found nothing durable).
 */
export async function applyPreferenceEntries(params: {
  userMdPath: string;
  entries: readonly PreferenceEntry[];
  today: string;
  log: (message: string, detail?: unknown) => void;
}): Promise<boolean> {
  const { userMdPath, entries, today, log } = params;
  return await withMemoryFileLock(userMdPath, async () => {
    const exists = existsSync(userMdPath);
    const content = exists ? await readFile(userMdPath, "utf8") : "";
    const { before, lines, after } = extractPreferenceBlock(content);
    const merged = mergePreferenceLines(lines, entries, today);
    if (!merged.changed) return false;
    const heading = exists || before.trim().length > 0 ? "" : "# User preferences\n\n";
    const rebuilt = `${heading}${before}${renderBlock(merged.lines)}${
      after.trim().length > 0 ? after.replace(/^\s*\n/, "\n") : ""
    }`;
    await writeFile(userMdPath, rebuilt.endsWith("\n") ? rebuilt : `${rebuilt}\n`, "utf8");
    log(
      `preferences: USER.md updated (+${merged.added} superseded ${merged.superseded}` +
        `${merged.dropped.length > 0 ? ` evicted ${merged.dropped.length}` : ""})`,
    );
    return true;
  });
}

const SYSTEM_PROMPT =
  "You extract durable user preferences from one chat message. A durable " +
  "preference is a standing statement about who the user is or how work " +
  "should always be done (tools, tone, format, routines, naming). One-off " +
  "task instructions are NOT preferences. Answer with JSON only, of the form " +
  '{"entries":[{"text":"...","supersedes":"fragment of an older preference this replaces, or null"}]}. ' +
  "Keep each text under 160 characters, in the language the user wrote, " +
  "phrased as a standing directive. Return {\"entries\":[]} when the message " +
  "states nothing durable.";

/** Tolerant JSON-object grab: models wrap the object in fences or prose. */
function parseEntries(raw: string): PreferenceEntry[] {
  const start = raw.indexOf("{");
  const finish = raw.lastIndexOf("}");
  if (start < 0 || finish <= start) return [];
  let value: unknown;
  try {
    value = JSON.parse(raw.slice(start, finish + 1));
  } catch {
    return [];
  }
  const list = (value as { entries?: unknown })?.entries;
  if (!Array.isArray(list)) return [];
  const out: PreferenceEntry[] = [];
  for (const item of list.slice(0, MAX_ENTRIES_PER_CALL)) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    const text = typeof record.text === "string" ? sanitizeEntryText(record.text) : "";
    if (text.length === 0) continue;
    const supersedes = typeof record.supersedes === "string" ? record.supersedes : null;
    out.push({ text, supersedes });
  }
  return out;
}

export function localToday(nowMs: number = Date.now()): string {
  const date = new Date(nowMs);
  const y = String(date.getFullYear()).padStart(4, "0");
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * The detached entry point, fired from the inbox-enqueued handler. Never throws,
 * never blocks: gate miss, model failure, and empty extraction all return quietly
 * (the model's own failures are logged by `completeThroughHost` itself).
 */
export async function maybeCapturePreferences(params: {
  ctx: PluginContext;
  workspaceDir: string;
  text: string;
  model?: HostedModelRef;
  log: (message: string, detail?: unknown) => void;
}): Promise<void> {
  try {
    const { ctx, workspaceDir, text, model, log } = params;
    if (!gatePasses(text)) return;
    const result = await completeThroughHost(
      ctx,
      {
        purpose: "preference extract",
        systemPrompt: SYSTEM_PROMPT,
        prompt: `Message:\n"""${text.slice(0, 1200)}"""`,
        timeoutMs: EXTRACT_TIMEOUT_MS,
        ...(model ? { model } : {}),
      },
      log,
    );
    if (result.text === null) return;
    const entries = parseEntries(result.text);
    if (entries.length === 0) return;
    await applyPreferenceEntries({
      userMdPath: path.join(workspaceDir, "USER.md"),
      entries,
      today: localToday(),
      log,
    });
  } catch (error) {
    params.log("preference capture failed", error);
  }
}
