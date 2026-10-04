// Turning memory markdown into searchable units.
//
// WHY A SEPARATE PARSE STEP
//   Three files go into the index and they share nothing but being markdown:
//   the extracted entries, the full session snapshots, and promoted long-term
//   memory. Each has its own heading grammar, so each needs its own reader. The
//   index stores whatever comes out of here, which means the on-disk format can
//   change without a migration -- the index is rebuilt, not migrated.
//
// UNIT, NOT FILE
//   The searchable unit is one entry or one conversation turn, never a whole
//   file. A session snapshot is a transcript: searching it as one blob returns
//   the entire session and quotes four thousand lines back at the model. One
//   unit per turn keeps a hit quotable, which is the only reason to search at
//   all.
//
// THE MARKDOWN IS THE SOURCE OF TRUTH
//   Nothing here writes. Every unit can be reconstructed from the file it came
//   from, so `memory_reindex` is the repair mechanism for anything the index
//   gets wrong, and deleting the database loses no information.

// U+00B7 MIDDLE DOT, the separator openclaw's renderer writes between the
// timestamp, the literal `auto-capture`, and the capture type. Spelled as an
// escape rather than pasted from render.ts so the file stays ASCII and no editor
// or codepage can silently rewrite it. It is the one byte these patterns depend
// on, and it is `renderCaptureEntry`'s `·`.
const MIDDLE_DOT = "\\u00b7";

// openclaw's own chunking and embedding-limit functions. The plugin imports them
// rather than reimplementing the arithmetic: CHARS_PER_TOKEN_ESTIMATE is a CJK-weighted
// heuristic (4 for latin, weighted per range for ideographs), and getting that estimate
// wrong in either direction either wastes context or overflows it.
import { chunkMarkdown } from "openclaw/plugin-sdk/memory-core-host-engine-indexing";
import { enforceEmbeddingMaxInputTokens } from "openclaw/plugin-sdk/memory-core-host-engine-indexing";
import { estimateStringChars } from "../../packages/normalization-core/src/cjk-chars.js";
import { extractFrontmatterBlock } from "../../packages/markdown-core/src/frontmatter.js";
import YAML from "yaml";

/**
 * Which corpus a document belongs to.
 *
 * `home` is the memory home (`workspace/`) and carries everything the plugin
 * writes: capture diaries, session snapshots, promoted long-term memory. `wiki`
 * is the document corpus (`wiki/`, default `~/.config/opencode/mem-plus/wiki`)
 * imported or dropped in by the user. Both live in one index and one set of
 * tools; the root is what keeps them separable in search.
 *
 * Defined here rather than in memory-index.ts because the reader needs it, and
 * the index imports this module.
 */
export type IndexRoot = "home" | "wiki";

// THE `m` FLAG IS LOAD-BEARING
//   These patterns are used two ways: against a single line by `splitOn`, and
//   against a whole file by `parseMemoryDocument` to decide which reader to use.
//   Without `m`, `$` anchors to the end of the entire input, so testing a
//   thirteen-line entry file against a pattern whose heading sits on line one
//   can never match -- and the failure is silent, because a miss just falls
//   through to the generic reader. That is exactly what happened: every entry
//   file was indexed as long-term memory, and nothing errored. With `m` both
//   uses are correct and per-line matching is unaffected.

/** `## <ISO timestamp> · auto-capture · <type>` -- one extracted memory. */
const ENTRY_HEADING = new RegExp(
  `^##\\s+(\\d{4}-\\d{2}-\\d{2}T[\\d:.]+Z)\\s+${MIDDLE_DOT}\\s+auto-capture\\s+${MIDDLE_DOT}\\s+(\\S+)\\s*$`,
  "m",
);

/** `## <ISO timestamp> · user` / `· assistant` -- one turn of a snapshot. */
const TURN_HEADING = new RegExp(
  `^##\\s+(\\d{4}-\\d{2}-\\d{2}T[\\d:.]+Z)\\s+${MIDDLE_DOT}\\s+(user|assistant|tool)\\s*$`,
  "m",
);

/** `Tags: a, b, c` on its own line. */
const TAG_LINE = /^Tags:\s*(.+)$/;

/** openclaw's idempotency marker; its value is the prompt id. */
const CAPTURE_MARKER = new RegExp(`<!--\\s*openclaw-capture:([A-Za-z0-9_-]+)\\s*-->`);

/** The header snapshot.ts writes at the top of every session file. */
const SESSION_MARKER = /<!--\s*mem-plus-session:([A-Za-z0-9_-]+)\s*-->/;

export type MemoryUnit = {
  /** Which reader produced this unit. Recorded so search can filter by it. */
  readonly kind: "entry" | "turn" | "memory" | "wiki";
  /** Epoch ms from the heading, when it carries one. `null` for long-term memory. */
  readonly ts: number | null;
  /** `YYYY-MM-DD`, derived from `ts` so filters never re-parse a timestamp. */
  readonly day: string | null;
  /** openclaw's capture type: `feature`, `bug-fix`, `configuration`, `other`, ... */
  readonly entryType: string | null;
  readonly tags: readonly string[];
  /** openclaw's provenance id, carried through so a hit can be traced back. */
  readonly marker: string | null;
  /** First meaningful line, used as the hit's title. */
  readonly heading: string;
  /** The searchable body, headings flattened. */
  readonly text: string;
};

export type ParsedDocument = {
  readonly kind: "entry-day" | "snapshot" | "memory" | "wiki";
  readonly title: string;
  readonly units: readonly MemoryUnit[];
};

function parseIso(value: string): { ts: number; day: string } | null {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return { ts: ms, day: value.slice(0, 10) };
}

/**
 * Reduce markdown to searchable text.
 *
 * Fenced code is kept -- tool inputs and file contents are often the only
 * thing that makes a memory findable ("the postgres port was 5433") -- but the
 * fence markers and language tags go, since they are noise repeated on every
 * tool call.
 *
 * HTML comments are removed *before* the character strippers run, and that order
 * is not incidental. The emphasis stripper deletes `_` and `>`, which turned
 * openclaw's provenance marker `<!-- openclaw-capture:prompt_a1 -->` into
 * `openclaw-capture:prompta1` -- a corrupted id, in the one field whose entire
 * purpose is to be a faithful id. Comments are not prose and have no business in
 * a search index at all, so they go regardless of what the strippers would do to
 * them.
 *
 * `_` is deliberately *not* stripped. FTS5's unicode61 tokenizer treats it as a
 * separator, so `memory_search` is stored as the adjacent pair `memory` `search`
 * and a query for `"memory_search"` asks for exactly that pair -- a match. Strip
 * the underscore first and the stored text becomes the single token
 * `memorysearch`, which no identifier query can ever reach. Every identifier in
 * a coding conversation (`memory_search`, `openclaw_capture`, `pg_hba`) depends
 * on this, and the markdown emphasis it would otherwise serve is one asterisk.
 * `*` and backtick carry the emphasis and go; `>` is blockquote and, once comments
 * are gone, has nothing left to mark.
 */
/**
 * Inline base64 image payloads, wherever they appear in a snapshot.
 *
 * A session with a screenshot attached writes the whole image into the markdown --
 * tens of thousands of characters of PNG per image. That is not searchable text
 * and it is not embeddable: kept as a unit it overflows the embedding model's
 * context (2k tokens) and any excerpt quoting it is unreadable.
 *
 * Keyed on the JSON field rather than on a `data:` URI, because that is how it
 * actually appears. The attachment is written with `JSON.stringify(value, null, 2)`,
 * which breaks a long string across lines, so the literal text is
 * `"data": "<base64"` -- the `data:` and the payload are separated by a newline and
 * any scheme that followed it is gone. A pattern written for a complete data URL
 * matches nothing here. The sibling `"mime"` field supplies the media type.
 *
 * The write path elides these too (see snapshot.ts); this is the second line of
 * defence for snapshots captured before that, and for files moved in from outside.
 */
const INLINE_IMAGE_DATA =
  /"data":\s*"([A-Za-z0-9+/\n\r=]{200,}?)(?="\s*,?\s*\n\s*(?:"mime"|"[^"]+"\s*:))/g;

/**
 * Base64 for a single image is long. The floor keeps ordinary data in memory -- a
 * snippet of code, a hash, a small blob -- from being mistaken for an embedded
 * image and deleted.
 */
const MIN_INLINE_IMAGE_CHARS = 1_000;

function elideInlineData(text: string): string {
  return text.replace(INLINE_IMAGE_DATA, (match, payload: string) => {
    const compact = payload.replace(/\s+/g, "");
    if (compact.length < MIN_INLINE_IMAGE_CHARS) return match;
    const bytes = Math.round((compact.length * 3) / 4);
    // The type is whatever the sibling field says; it is only a label, so it is
    // worth reporting and not worth parsing precisely.
    return `"data": "[elided image, ~${bytes} bytes]"`;
  });
}

function flatten(body: string): string {
  return elideInlineData(
    body
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/```[\w+-]*\r?\n?/g, "\n")
      .replace(/^\s{0,3}#{1,6}\s+/gm, "")
      .replace(/[*`>]/g, "")
      .replace(/\r\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
  );
}

/** A short display title: the first non-empty line, trimmed to something sane. */
function firstLine(text: string, fallback: string): string {
  const line = text.split("\n").find((candidate) => candidate.trim().length > 0) ?? "";
  const trimmed = line.trim();
  if (trimmed.length === 0) return fallback;
  return trimmed.length > 120 ? `${trimmed.slice(0, 117)}...` : trimmed;
}

/**
 * Title for an extracted entry, skipping openclaw's structural labels.
 *
 * `renderCaptureEntry` writes `## Request` then `## Outcome`, so after heading
 * stripping every entry's first line is the bare word "Request" and all of them
 * get the same title -- which makes a result list useless for telling them
 * apart. The label lines carry no information, so the first line of actual
 * content is used instead.
 */
const STRUCTURAL_LABELS = new Set(["request", "outcome", "notes", "summary"]);

function entryTitle(text: string): string {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || STRUCTURAL_LABELS.has(trimmed.toLowerCase())) continue;
    return trimmed.length > 120 ? `${trimmed.slice(0, 117)}...` : trimmed;
  }
  return "capture";
}

/** Split on a heading pattern, keeping the heading with its body. */
function splitOn(
  text: string,
  heading: RegExp,
): { head: string; matches: { match: RegExpExecArray; body: string }[] } {
  const lines = text.split("\n");
  const head: string[] = [];
  const open: { match: RegExpExecArray; start: number }[] = [];
  for (const [index, line] of lines.entries()) {
    const match = heading.exec(line);
    if (match) open.push({ match, start: index });
    else if (open.length === 0) head.push(line);
  }
  return {
    head: head.join("\n"),
    matches: open.map((entry, position) => ({
      match: entry.match,
      body: lines.slice(entry.start + 1, open[position + 1]?.start ?? lines.length).join("\n"),
    })),
  };
}

function collectTags(body: string): string[] {
  const tags: string[] = [];
  for (const line of body.split("\n")) {
    const match = TAG_LINE.exec(line.trim());
    const value = match?.[1];
    if (!value) continue;
    tags.push(...value.split(",").map((tag) => tag.trim()).filter(Boolean));
  }
  return tags;
}

function collectMarker(body: string): string | null {
  return CAPTURE_MARKER.exec(body)?.[1] ?? null;
}

/**
 * Read one extracted-entry file (`memory/YYYY-MM-DD.md`).
 *
 * Heading order inside an entry is `## Request`, then `## Outcome`, then the
 * tag line and the provenance comment -- all flattened, because the heading
 * words themselves are worth far less than what is under them.
 */
function parseEntryDay(text: string, fallbackTitle: string): ParsedDocument {
  const { head, matches } = splitOn(text, ENTRY_HEADING);
  const units: MemoryUnit[] = matches.map(({ match, body }) => {
    const stamp = parseIso(match[1] as string);
    const tags = collectTags(body);
    // The tag line is metadata, and `renderHits` prints it as its own labelled
    // line. Leaving it in the body means every result shows it twice. Matched
    // unindented only, so a `Tags:` inside an indented code block survives.
    const flat = flatten(body)
      .split("\n")
      .filter((line) => !TAG_LINE.test(line))
      .join("\n")
      .trim();
    return {
      kind: "entry" as const,
      ts: stamp?.ts ?? null,
      day: stamp?.day ?? null,
      entryType: match[2] ?? null,
      tags,
      marker: collectMarker(body),
      heading: entryTitle(flat),
      text: flat,
    };
  });

  // An empty file with only front matter is normal (the plugin creates the day
  // before anything is captured). Indexing zero units beats rejecting the file:
  // the document row is what tells a later reindex the file was seen.
  return { kind: "entry-day", title: fallbackTitle, units };
}

/**
 * Read one session snapshot (`memory/<date>-<slug>.md`).
 *
 * Turns become units rather than one blob. Tool output is included because a
 * memory's distinguishing detail is usually a path, a port or an error string
 * that only appears inside a tool call.
 */
function parseSnapshot(text: string, fallbackTitle: string): ParsedDocument {
  const title = /^#\s+(.+)$/m.exec(text)?.[1]?.trim() ?? fallbackTitle;
  const { matches } = splitOn(text, TURN_HEADING);
  const units: MemoryUnit[] = matches.map(({ match, body }) => {
    const stamp = parseIso(match[1] as string);
    const flat = flatten(body);
    return {
      kind: "turn" as const,
      ts: stamp?.ts ?? null,
      day: stamp?.day ?? null,
      entryType: match[2] ?? null,
      tags: [],
      marker: null,
      heading: `${match[2] ?? "turn"} · ${firstLine(flat, "(empty)")}`,
      text: flat,
    };
  });
  return { kind: "snapshot", title, units };
}

/** Read promoted long-term memory (`MEMORY.md`). Sections are the units. */
function parseLongTerm(text: string, fallbackTitle: string): ParsedDocument {
  const title = /^#\s+(.+)$/m.exec(text)?.[1]?.trim() ?? fallbackTitle;
  const { matches } = splitOn(text, /^##\s+(.+)$/);
  if (matches.length === 0) {
    const flat = flatten(text);
    return flat.length === 0
      ? { kind: "memory", title, units: [] }
      : {
          kind: "memory",
          title,
          units: [
            {
              kind: "memory" as const,
              ts: null,
              day: null,
              entryType: null,
              tags: [],
              marker: null,
              heading: firstLine(flat, title),
              text: flat,
            },
          ],
        };
  }
  return {
    kind: "memory",
    title,
    units: matches.map(({ match, body }) => ({
      kind: "memory" as const,
      ts: null,
      day: null,
      entryType: null,
      tags: collectTags(body),
      marker: null,
      heading: (match[1] ?? "section").trim(),
      text: flatten(body),
    })),
  };
}

/**
 * Read one wiki page (a document under the wiki corpus directory).
 *
 * Ported in spirit from openclaw's `extensions/memory-wiki`, which compiles a
 * document vault into its memory store; here a page is an ordinary markdown file
 * with optional YAML frontmatter, and sections are the units. A page carries no
 * timestamps -- it is reference material, not a record of something that
 * happened -- so `ts` / `day` stay null and date filters never match it.
 *
 * Frontmatter is metadata rather than prose: `title` names the document,
 * `labels` become tags (so `memory_search`'s `tag` filter reaches imported
 * pages), and `sourceType` becomes the entry type. The block itself is dropped:
 * indexing YAML keys as searchable text would let a query match `status: draft`
 * on every single imported page.
 */
function parseWiki(text: string, fallbackTitle: string): ParsedDocument {
  const extracted = extractFrontmatterBlock(text);
  const body = extracted?.body ?? text;
  const meta = readFrontmatter(extracted?.block);
  const title =
    typeof meta["title"] === "string" && meta["title"].trim().length > 0
      ? meta["title"].trim()
      : (/^#\s+(.+)$/m.exec(body)?.[1]?.trim() ?? fallbackTitle);
  const tags = Array.isArray(meta["labels"])
    ? meta["labels"].filter((label): label is string => typeof label === "string" && label.length > 0)
    : typeof meta["tags"] === "string"
      ? meta["tags"].split(",").map((tag) => tag.trim()).filter(Boolean)
      : [];
  const entryType = typeof meta["sourceType"] === "string" ? meta["sourceType"] : null;

  const { head, matches } = splitOn(body, /^##\s+(.+)$/);

  // Content before the first `##` is its own unit rather than being dropped.
  // A wiki page typically opens with a title and an intro paragraph, and that
  // intro is often the answer to the question being asked ("the connection
  // string is in the vault, port 6543"); indexing only the sections below would
  // lose it. The H1 itself is metadata -- `title` already carries it.
  const headText = flatten(head.replace(/^[^\S\n]*#[^\S\n]+.*$/m, "")).trim();
  const headUnit: MemoryUnit[] =
    headText.length > 0
      ? [{ kind: "wiki", ts: null, day: null, entryType, tags, marker: null, heading: title, text: headText }]
      : [];

  const sectionUnits = matches.map(({ match, body: sectionBody }) => {
    const flat = flatten(sectionBody);
    return {
      kind: "wiki" as const,
      ts: null,
      day: null,
      entryType,
      tags,
      marker: null,
      heading: (match[1] ?? "section").trim(),
      text: flat,
    };
  });

  const units = [...headUnit, ...sectionUnits];
  if (units.length > 0) return { kind: "wiki", title, units };

  const flat = flatten(body);
  return {
    kind: "wiki",
    title,
    units:
      flat.length === 0
        ? []
        : [{ kind: "wiki", ts: null, day: null, entryType, tags, marker: null, heading: firstLine(flat, title), text: flat }],
  };
}

/** Parse a frontmatter block, tolerating anything that is not a YAML mapping. */
function readFrontmatter(block: string | undefined): Record<string, unknown> {
  if (!block) return {};
  try {
    const parsed: unknown = YAML.parse(block);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    // Malformed YAML in a user-authored page is not a reason to skip the page.
    return {};
  }
}

/**
 * Pick a reader from the file's *content* rather than its name.
 *
 * Name-based dispatch looks tidier and breaks on the first user who renames a
 * memory file or points the plugin at a symlinked tree. The marker comments are
 * written by this plugin's own writers, so they are the more reliable signal;
 * the filename is only the fallback for a file with nothing recognisable.
 *
 * `root` decides the corpus, because a wiki page is ordinary markdown that the
 * content probes cannot distinguish from a long-term memory file: the same text
 * under `wiki/` is reference material and under `workspace/` it is memory.
 */
export function parseMemoryDocument(file: string, text: string, root: IndexRoot = "home"): ParsedDocument {
  const base = file.replace(/\\/g, "/").split("/").pop() ?? file;
  if (root === "wiki") return withChunking(parseWiki(text, base));

  if (SESSION_MARKER.test(text)) return withChunking(parseSnapshot(text, base));
  if (ENTRY_HEADING.test(text)) return withChunking(parseEntryDay(text, base));
  if (base === "MEMORY.md" || base.toUpperCase() === "MEMORY.MD") {
    return withChunking(parseLongTerm(text, base));
  }
  // A snapshot whose session marker was stripped still has turn headings; an
  // entry file still has its entry headings. Checking the whole text rather
  // than only the first line matters, because a day file can be empty on top.
  if (TURN_HEADING.test(text)) return withChunking(parseSnapshot(text, base));
  return withChunking(parseLongTerm(text, base));
}

/** Chunking applies to every reader: any of them can hold a pasted file. */
function withChunking(parsed: ParsedDocument): ParsedDocument {
  return { ...parsed, units: applyChunking(parsed.units) };
}

/**
 * Split a unit whose body is too large for the embedding model into several units.
 *
 * WHY THIS EXISTS
 *   A turn carrying a pasted file or a long log becomes one enormous unit -- measured
 *   at 98k characters on real data. The embedding context is 2048 tokens, so such a
 *   unit can never be embedded: it is skipped at embedding time, stays invisible to
 *   semantic search, and remains findable only by keyword. The details that make it
 *   worth remembering (a path, a port, an error string) are usually in the part that
 *   got cut off.
 *
 * WHY openclaw's FUNCTIONS AND NOT LOCAL CODE
 *   `chunkMarkdown` and `enforceEmbeddingMaxInputTokens` are openclaw's own, used by its
 *   manager, and they solve this in two layers that are not redundant:
 *
 *     1. chunkMarkdown splits by a *token* budget (`tokens x CHARS_PER_TOKEN_ESTIMATE`,
 *        CJK-weighted) on line boundaries, carrying `overlap` characters so a fact on a
 *        boundary is not lost. It also splits a single over-long line by code point,
 *        keeping surrogate pairs and supplementary ideographs intact.
 *     2. enforceEmbeddingMaxInputTokens then re-splits whatever still exceeds the
 *        provider's real byte limit. openclaw runs with chunkTokens 4000 against a
 *        2048-token local provider, so layer 2 is the one that actually binds.
 *
 *   The parameters are openclaw's defaults: 4000 tokens for layer 1, and `local` for
 *   layer 2, which resolves to DEFAULT_LOCAL_EMBEDDING_MAX_INPUT_TOKENS = 2048.
 *
 * Text and metadata are carried onto every fragment, so a fragment still reports the
 * right turn type, day and marker -- a fragment is the same turn, not a new one.
 */
const CHUNK_TOKENS = 4000;
const CHUNK_OVERLAP = 0;
/** `local` resolves to openclaw's DEFAULT_LOCAL_EMBEDDING_MAX_INPUT_TOKENS (2048). */
const EMBED_PROVIDER_ID = "local";

function splitOversizedUnit(unit: MemoryUnit): MemoryUnit[] {
  // Gated on openclaw's own weighted estimator, not on character count. The two differ
  // by up to 4x for CJK: a 7700-character Chinese turn is roughly 7700 weighted units
  // and cannot be embedded in a 2048-token context, while a 7700-character English one
  // is about 1900 and fits comfortably. A character-count gate therefore either skips
  // Chinese turns that need splitting or splits English ones that do not.
  if (estimateStringChars(unit.text) <= EMBED_CONTEXT_TOKENS) return [unit];

  const fragments = enforceEmbeddingMaxInputTokens(
    { id: EMBED_PROVIDER_ID, maxInputTokens: undefined },
    chunkMarkdown(unit.text, { tokens: CHUNK_TOKENS, overlap: CHUNK_OVERLAP }),
  ).filter((fragment) => fragment.text.trim().length > 0);

  if (fragments.length <= 1) return [unit];

  return fragments.map((fragment, index) => ({
    ...unit,
    heading: fragments.length > 1 ? `${unit.heading} (${index + 1}/${fragments.length})` : unit.heading,
    text: fragment.text,
  }));
}

/**
 * The embedding context this plugin runs against.
 *
 * `DEFAULT_LOCAL_EMBEDDING_MAX_INPUT_TOKENS` from openclaw, for the `local` provider
 * the plugin actually uses. Compared in the estimator's own units, so the gate and the
 * limit cannot disagree about what fits.
 */
const EMBED_CONTEXT_TOKENS = 2048;

/** Split every oversized unit in a parsed document. */
function applyChunking(units: readonly MemoryUnit[]): MemoryUnit[] {
  return units.flatMap(splitOversizedUnit);
}