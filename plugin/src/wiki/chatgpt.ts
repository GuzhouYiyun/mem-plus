// Import a ChatGPT data export into the document corpus.
//
// PORTED FROM OPENCLAW, NOT COPIED
//   openclaw's importer is `extensions/memory-wiki/src/chatgpt-import.ts`
//   (~1200 lines). What is kept here is the part that decides *what a page
//   says*: the active-branch walk over `conversations.json`, message text
//   extraction, the risk/labels triage and the page rendering. What is left out
//   is everything that exists to serve openclaw's store and host runtime:
//
//     - `query.ts` / `compile.ts` storage calls (openclaw's memory_index_chunks;
//       mem-plus indexes files through its own pipeline instead)
//     - the import-run ledger, fs-safe recovery slots and `rollbackChatGptImport`
//       (openclaw's transactional bookkeeping across a live vault)
//     - `bridge.ts` routing, the CLI, the gateway routes, doctor contracts and
//       the prompt section (no OpenCode counterpart for any of them)
//
//   Idempotency is not lost with the run ledger: pages are named after the
//   conversation id, written atomically, and the index deduplicates by content
//   hash, so re-importing the same export rewrites the same bytes over the same
//   paths and changes nothing downstream.
//
// WHY AN IMPORT TOOL AND NOT A BUILT-IN SYNC
//   The corpus is the user's directory. Importing is the one write this plugin
//   performs outside the memory home, so it is explicit, takes a path, and can
//   be dry-run first.
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";

// --- export reading ---------------------------------------------------------

type ChatGptMessage = { role: string; text: string };

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function isoFromUnix(raw: unknown): string | undefined {
  if (typeof raw !== "number" && typeof raw !== "string") return undefined;
  const numeric = Number(raw);
  if (!Number.isFinite(numeric)) return undefined;
  return new Date(numeric * 1000).toISOString();
}

/**
 * Drop the asset payloads a ChatGPT export carries inline.
 *
 * `asset_pointer` / `image_asset_pointer` parts are file references, not text;
 * keeping them puts a JSON blob in the middle of every sentence that mentioned
 * an image.
 */
function cleanMessageText(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (
    trimmed.includes("asset_pointer") ||
    trimmed.includes("image_asset_pointer") ||
    trimmed.includes("file_asset_pointer")
  ) {
    return "";
  }
  return trimmed;
}

function extractMessageText(message: Record<string, unknown>): string {
  const content = message["content"];
  if (typeof content === "object" && content !== null) {
    const parts = (content as Record<string, unknown>)["parts"];
    if (Array.isArray(parts)) {
      const collected: string[] = [];
      for (const part of parts) {
        if (typeof part === "string") {
          const cleaned = cleanMessageText(part);
          if (cleaned) collected.push(cleaned);
          continue;
        }
        const partRecord = asRecord(part);
        if (partRecord && typeof partRecord["text"] === "string" && partRecord["text"].trim()) {
          collected.push(partRecord["text"].trim());
        }
      }
      return collected.join("\n").trim();
    }
    if (typeof (content as Record<string, unknown>)["text"] === "string") {
      return cleanMessageText((content as Record<string, unknown>)["text"] as string);
    }
  }
  return typeof message["text"] === "string" ? cleanMessageText(message["text"] as string) : "";
}

/**
 * The branch the conversation actually ended on.
 *
 * A ChatGPT export stores every regenerated answer as sibling nodes in
 * `mapping`; only the chain from `current_node` back to the root is the
 * conversation the user saw. Walking the whole tree would import answers that
 * were thrown away.
 */
function activeBranchMessages(conversation: Record<string, unknown>): ChatGptMessage[] {
  const mapping = asRecord(conversation["mapping"]);
  if (!mapping) return [];
  let currentNode =
    typeof conversation["current_node"] === "string" ? conversation["current_node"] : undefined;
  const seen = new Set<string>();
  const chain: ChatGptMessage[] = [];
  while (currentNode && !seen.has(currentNode)) {
    seen.add(currentNode);
    const node = asRecord(mapping[currentNode]);
    if (!node) break;
    const message = asRecord(node["message"]);
    if (message) {
      const role =
        typeof asRecord(message["author"])?.["role"] === "string"
          ? (asRecord(message["author"])?.["role"] as string)
          : "unknown";
      const text = extractMessageText(message);
      if (text) chain.push({ role, text });
    }
    currentNode = typeof node["parent"] === "string" ? node["parent"] : undefined;
  }
  return chain.reverse();
}

// --- triage -----------------------------------------------------------------

const RISK_RULES: { label: string; pattern: RegExp }[] = [
  {
    label: "relationships",
    pattern:
      /\b(relationship|dating|breakup|jealous|intimacy|partner|apology|trust|boyfriend|girlfriend|husband|wife)\b/i,
  },
  {
    label: "health",
    pattern:
      /\b(supplement|medication|diagnosis|symptom|therapy|depression|anxiety|mri|migraine|injury|pain|sleep)\b/i,
  },
  {
    label: "legal_tax",
    pattern:
      /\b(contract|tax|legal|law|lawsuit|visa|immigration|license|insurance|claim|residency)\b/i,
  },
];

const PREFERENCE_SIGNAL_RE =
  /\b(prefer|prefers|preference|want|wants|need|needs|avoid|avoids|hate|hates|love|loves|default to|should default to|always use|don't want|does not want|likes|dislikes)\b/i;

/**
 * Flag a conversation as sensitive instead of digesting it.
 *
 * A risk hit withholds the auto digest: the page is still written and still
 * searchable (the transcript is the user's own data), but nothing that looks
 * like a durable candidate is derived from it without a human looking first.
 */
function inferRisk(title: string, sample: string): { level: "low" | "medium" | "high"; reasons: string[] } {
  const blob = `${title}\n${sample}`;
  const reasons = RISK_RULES.filter((rule) => rule.pattern.test(blob)).map((rule) => rule.label);
  if (reasons.length > 0) return { level: "high", reasons };
  if (/\b(career|job|salary|interview|offer|resume|cover letter)\b/i.test(blob)) {
    return { level: "medium", reasons: ["work_career"] };
  }
  return { level: "low", reasons: [] };
}

const LABEL_PATTERNS: { label: string; pattern: RegExp }[] = [
  { label: "topic/translation", pattern: /\b(translate|translation|traduc\w*|traduç\w*|traduzione)\b/i },
  {
    label: "area/language-learning",
    pattern: /\b(anki|flashcards?|grammar|vocab|lesson|tutor|jlpt|kanji|hiragana|katakana|study|learn)\b/i,
  },
  { label: "area/travel", pattern: /\b(hike|trail|hotel|flight|trip|travel|airport|itinerary|booking|airbnb|train)\b/i },
  { label: "topic/cooking", pattern: /\b(recipe|cook|cooking|bread|sourdough|pizza|espresso|coffee|meatballs?)\b/i },
  { label: "topic/gardening", pattern: /\b(garden|orchard|plant|soil|compost|permaculture|irrigation|seeds?)\b/i },
  { label: "topic/relationships", pattern: /\b(dating|relationship|partner|jealous|breakup)\b/i },
  {
    label: "area/finance",
    pattern: /\b(investment|invest|portfolio|dividend|yield|mortgage|loan|crypto|stocks?)\b/i,
  },
  { label: "area/legal", pattern: /\b(contract|tax|impuesto|legal|visa|immigration|insurance|residency)\b/i },
  { label: "area/health", pattern: /\b(symptom|diagnosis|therapy|medication|sleep|migraine)\b/i },
  { label: "area/technology", pattern: /\b(javascript|typescript|python|rust|golang|docker|kubernetes|api|database)\b/i },
];

function inferLabels(title: string, sample: string): string[] {
  const blob = `${title}\n${sample}`;
  const labels = new Set<string>(["source/chatgpt"]);
  for (const rule of LABEL_PATTERNS) {
    if (rule.pattern.test(blob)) labels.add(rule.label);
  }
  return [...labels];
}

function collectPreferenceSignals(userTexts: readonly string[]): string[] {
  const signals: string[] = [];
  for (const text of userTexts) {
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.length === 0 || trimmed.length > 200) continue;
      if (!PREFERENCE_SIGNAL_RE.test(trimmed)) continue;
      signals.push(trimmed);
      if (signals.length >= 10) return signals;
    }
  }
  return signals;
}

function buildTranscript(messages: readonly ChatGptMessage[]): string {
  if (messages.length === 0) return "_No active-branch transcript could be reconstructed._";
  return messages
    .flatMap((message) => [
      `### ${message.role[0]?.toUpperCase() ?? "U"}${message.role.slice(1)}`,
      "",
      message.text,
      "",
    ])
    .join("\n")
    .trim();
}

// --- page rendering ---------------------------------------------------------

type ConversationRecord = {
  conversationId: string;
  title: string;
  createdAt?: string;
  updatedAt?: string;
  labels: string[];
  risk: { level: "low" | "medium" | "high"; reasons: string[] };
  userMessageCount: number;
  assistantMessageCount: number;
  preferenceSignals: string[];
  firstUserLine?: string;
  lastUserLine?: string;
  transcript: ChatGptMessage[];
  pagePath: string;
};

/**
 * `chatgpt-<date>-<slug>.md` under `sources/`.
 *
 * The conversation id decides the name, so re-importing the same export lands on
 * the same paths instead of accumulating near-duplicates.
 */
function pagePathFor(conversationId: string, createdAt: string | undefined): string {
  const slug =
    conversationId.replace(/[^a-zA-Z0-9]/g, "").toLowerCase() ||
    createHash("sha1").update(conversationId).digest("hex").slice(0, 12);
  const datePrefix = createdAt?.slice(0, 10) ?? "undated";
  return path.posix.join("sources", `chatgpt-${datePrefix}-${slug.slice(0, 60)}.md`);
}

function toRecord(conversation: Record<string, unknown>): ConversationRecord | null {
  const conversationId =
    typeof conversation["conversation_id"] === "string"
      ? (conversation["conversation_id"] as string).trim()
      : "";
  if (!conversationId) return null;
  const title =
    typeof conversation["title"] === "string" && (conversation["title"] as string).trim()
      ? (conversation["title"] as string).trim()
      : "Untitled conversation";
  const createdAt = isoFromUnix(conversation["create_time"]);
  const transcript = activeBranchMessages(conversation);
  const userTexts = transcript.filter((entry) => entry.role === "user").map((entry) => entry.text);
  const sample = userTexts.slice(0, 6).join("\n");
  const risk = inferRisk(title, sample);
  return {
    conversationId,
    title,
    createdAt,
    updatedAt: isoFromUnix(conversation["update_time"]) ?? createdAt,
    labels: inferLabels(title, sample),
    risk,
    userMessageCount: userTexts.length,
    assistantMessageCount: transcript.filter((entry) => entry.role === "assistant").length,
    preferenceSignals: risk.level === "low" ? collectPreferenceSignals(userTexts) : [],
    firstUserLine: userTexts[0]?.split(/\r?\n/)[0]?.trim(),
    lastUserLine: userTexts.at(-1)?.split(/\r?\n/)[0]?.trim(),
    transcript,
    pagePath: pagePathFor(conversationId, createdAt),
  };
}

/**
 * Render one page.
 *
 * The frontmatter is what the wiki reader turns into a title, tags and an entry
 * type (`plugin/src/memory-parse.ts`), so it carries the triage metadata rather
 * than repeating it in prose. `status: draft` is openclaw's marker for "imported,
 * not yet reviewed" and is kept so the provenance of an imported page stays
 * visible in the file itself.
 */
function renderPage(record: ConversationRecord, sourcePath: string): string {
  const frontmatter = YAML.stringify({
    pageType: "source",
    title: `ChatGPT Export: ${record.title}`,
    sourceType: "chatgpt-export",
    sourceSystem: "chatgpt",
    sourcePath,
    conversationId: record.conversationId,
    riskLevel: record.risk.level,
    riskReasons: record.risk.reasons,
    labels: record.labels,
    status: "draft",
    ...(record.createdAt ? { createdAt: record.createdAt } : {}),
    ...(record.updatedAt ? { updatedAt: record.updatedAt } : {}),
  }).trimEnd();

  const digestLines =
    record.risk.level === "low"
      ? [
          `- User messages: ${record.userMessageCount}`,
          `- Assistant messages: ${record.assistantMessageCount}`,
          ...(record.firstUserLine ? [`- First user line: ${record.firstUserLine}`] : []),
          ...(record.lastUserLine ? [`- Last user line: ${record.lastUserLine}`] : []),
          ...(record.preferenceSignals.length > 0
            ? ["- Preference signals:", ...record.preferenceSignals.map((line) => `  - ${line}`)]
            : ["- Preference signals: none detected"]),
        ]
      : [
          "- Auto digest withheld from durable-candidate generation until reviewed.",
          `- Risk reasons: ${record.risk.reasons.length > 0 ? record.risk.reasons.join(", ") : "none recorded"}`,
        ];

  return [
    "---",
    frontmatter,
    "---",
    "",
    `# ChatGPT Export: ${record.title}`,
    "",
    "## Source",
    `- Conversation id: \`${record.conversationId}\``,
    `- Export file: \`${sourcePath}\``,
    ...(record.createdAt ? [`- Created: ${record.createdAt}`] : []),
    ...(record.updatedAt ? [`- Updated: ${record.updatedAt}`] : []),
    "",
    "## Auto Triage",
    `- Risk level: \`${record.risk.level}\``,
    `- Labels: ${record.labels.join(", ")}`,
    `- Active-branch messages: ${record.transcript.length}`,
    "",
    "## Auto Digest",
    ...digestLines,
    "",
    "## Active Branch Transcript",
    buildTranscript(record.transcript),
    "",
  ].join("\n");
}

// --- import -----------------------------------------------------------------

export type ChatGptImportReport = {
  readonly dryRun: boolean;
  readonly exportPath: string;
  readonly conversations: number;
  readonly written: number;
  readonly unchanged: number;
  readonly skipped: number;
  readonly pages: readonly string[];
};

/** Accept either `conversations.json` itself or the export directory holding it. */
function resolveConversationsPath(exportInputPath: string): { exportPath: string; conversationsPath: string } {
  const resolved = path.resolve(exportInputPath);
  const conversationsPath = resolved.toLowerCase().endsWith(".json")
    ? resolved
    : path.join(resolved, "conversations.json");
  return { exportPath: resolved, conversationsPath };
}

async function loadConversations(
  exportInputPath: string,
): Promise<{ exportPath: string; conversationsPath: string; conversations: Record<string, unknown>[] }> {
  const { exportPath, conversationsPath } = resolveConversationsPath(exportInputPath);
  const raw = await fs.readFile(conversationsPath, "utf8");
  const parsed: unknown = JSON.parse(raw);
  const conversations = Array.isArray(parsed)
    ? parsed
    : Object.values(asRecord(parsed) ?? {}).find(Array.isArray);
  if (!conversations) {
    throw new Error(`Unrecognized ChatGPT conversations export format: ${conversationsPath}`);
  }
  return {
    exportPath,
    conversationsPath,
    conversations: (conversations as unknown[]).filter((entry): entry is Record<string, unknown> =>
      asRecord(entry) !== undefined,
    ),
  };
}

/**
 * Write via a temporary file and rename.
 *
 * The indexer may be reading this directory at any moment; a half-written page
 * would be indexed as a truncated document. Rename is atomic within a
 * filesystem, so a reader sees either the old page or the new one.
 */
async function writeAtomic(target: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.${randomUUID().slice(0, 8)}.tmp`;
  await fs.writeFile(temp, content, "utf8");
  await fs.rename(temp, target);
}

export async function importChatGptExport(params: {
  wikiDir: string;
  exportPath: string;
  dryRun?: boolean;
}): Promise<ChatGptImportReport> {
  const { exportPath, conversationsPath, conversations } = await loadConversations(params.exportPath);
  const dryRun = params.dryRun === true;
  const records = conversations
    .map((conversation) => toRecord(conversation))
    .filter((record): record is ConversationRecord => record !== null);

  let written = 0;
  let unchanged = 0;
  let skipped = 0;
  const pages: string[] = [];

  for (const record of records) {
    const target = path.join(params.wikiDir, ...record.pagePath.split("/"));
    const content = renderPage(record, conversationsPath);
    pages.push(target);
    if (dryRun) continue;
    let existing: string | null = null;
    try {
      existing = await fs.readFile(target, "utf8");
    } catch {
      existing = null;
    }
    if (existing === content) {
      // Byte-identical: the conversation has not changed since the last import.
      // Skipping the write keeps mtime stable, which is what lets the indexer
      // skip the file instead of re-parsing the whole export every time.
      unchanged += 1;
      continue;
    }
    try {
      await writeAtomic(target, content);
      written += 1;
    } catch (error) {
      skipped += 1;
      void error;
    }
  }

  return {
    dryRun,
    exportPath,
    conversations: records.length,
    written,
    unchanged,
    skipped,
    pages,
  };
}