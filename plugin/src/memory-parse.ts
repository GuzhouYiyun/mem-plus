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
  readonly kind: "entry" | "turn" | "memory";
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
  readonly kind: "entry-day" | "snapshot" | "memory";
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
function flatten(body: string): string {
  return body
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/```[\w+-]*\r?\n?/g, "\n")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/[*`>]/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
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
 * Pick a reader from the file's *content* rather than its name.
 *
 * Name-based dispatch looks tidier and breaks on the first user who renames a
 * memory file or points the plugin at a symlinked tree. The marker comments are
 * written by this plugin's own writers, so they are the more reliable signal;
 * the filename is only the fallback for a file with nothing recognisable.
 */
export function parseMemoryDocument(file: string, text: string): ParsedDocument {
  const base = file.replace(/\\/g, "/").split("/").pop() ?? file;

  if (SESSION_MARKER.test(text)) return parseSnapshot(text, base);
  if (ENTRY_HEADING.test(text)) return parseEntryDay(text, base);
  if (base === "MEMORY.md" || base.toUpperCase() === "MEMORY.MD") {
    return parseLongTerm(text, base);
  }
  // A snapshot whose session marker was stripped still has turn headings; an
  // entry file still has its entry headings. Checking the whole text rather
  // than only the first line matters, because a day file can be empty on top.
  if (TURN_HEADING.test(text)) return parseSnapshot(text, base);
  return parseLongTerm(text, base);
}