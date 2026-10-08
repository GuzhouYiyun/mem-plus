// Split a DREAMS.md into the entries openclaw writes into it, so the page can show
// one card per sleep session instead of one wall of markdown.
//
// The file's shape is fixed by `extensions/memory-core/src/dreaming-dreams-file.ts`:
// `appendNarrativeEntry` inserts `\n---\n\n*<date>*\n\n<narrative>\n` immediately
// before the diary end marker on every run, so entries accumulate in write order
// with the newest last. The Deep Sleep block is a summary of what the deep phase
// promoted, not a dated entry, so it is reported on its own.
//
//   # Dream Diary
//   <!-- openclaw:dreaming:diary:start -->
//   ---
//   *October 3, 2026 at 09:57 AM GMT+8*
//
//   narrative
//   ---
//   <!-- openclaw:dreaming:diary:end -->
//
//   ## Deep Sleep
//   <!-- openclaw:dreaming:deep:start -->
//   ...
//
// Entries are cut on the date line rather than on `---`. A narrative may contain a
// `---` of its own (it is markdown, and a horizontal rule is ordinary writing), and
// splitting on that turns one night into two -- measured, not hypothetical.
// `formatNarrativeDate` puts the date in `*...*` on its own line, so that line is
// the reliable boundary and `---` is only used to skip over.
export type DreamEntry = {
  /** The `*October 3, 2026 at 09:57 AM GMT+8*` line, minus the asterisks. Empty when the entry has none. */
  date: string;
  narrative: string;
};

const DIARY_START = "<!-- openclaw:dreaming:diary:start -->";
const DIARY_END = "<!-- openclaw:dreaming:diary:end -->";
const DEEP_START = "<!-- openclaw:dreaming:deep:start -->";
const DEEP_END = "<!-- openclaw:dreaming:deep:end -->";

/** A standalone `*...*` line: the date `formatNarrativeDate` writes. */
const DATE_LINE = /^\*([^*\n]+)\*$/;

export type ParsedDreams = {
  /** Newest first, because the file appends and the page reads top-down. */
  entries: DreamEntry[];
  /** The `## Deep Sleep` block's contents, or null when there is none. */
  deepSleep: string | null;
  /** Text outside both managed blocks, kept for display. */
  preamble: string;
};

/** The span between `start` and `end`, or null when either marker is absent. */
function sliceBetween(text: string, start: string, end: string): string | null {
  const from = text.indexOf(start);
  if (from < 0) return null;
  const to = text.indexOf(end, from + start.length);
  if (to < 0) return null;
  return text.slice(from + start.length, to);
}

export function parseDreams(markdown: string): ParsedDreams {
  const diary = sliceBetween(markdown, DIARY_START, DIARY_END);
  const deepSleep = sliceBetween(markdown, DEEP_START, DEEP_END);

  // Cut on the date lines. `diary` is null for a file the dreaming phase never
  // wrote (hand-made, or not yet run) -- then whatever text is there is a single
  // undated entry, because showing the file is better than showing nothing.
  const source = diary ?? markdown;
  const lines = source.split("\n");
  const entries: DreamEntry[] = [];
  let current: { date: string; body: string[] } | null = null;

  const flush = () => {
    if (!current) return;
    const narrative = current.body.join("\n").trim();
    // An entry with no body is an artefact of the leading `---`, not content.
    if (narrative) entries.push({ date: current.date, narrative });
    current = null;
  };

  for (const line of lines) {
    const match = DATE_LINE.exec(line.trim());
    if (match) {
      flush();
      current = { date: match[1].trim(), body: [] };
      continue;
    }
    if (!current) continue;
    // The `---` that introduces the next entry is dropped rather than kept.
    if (/^-{3,}$/.test(line.trim())) continue;
    current.body.push(line);
  }
  flush();

  // No date line anywhere: the file predates the format or was written by hand.
  // Everything is one undated entry -- showing it beats showing an empty page.
  if (entries.length === 0) {
    const body = source
      .replace(/^#{1,6}\s.*$/gm, "")
      .replace(/^-{3,}$/gm, "")
      .trim();
    if (body) entries.push({ date: "", narrative: body });
  }

  entries.reverse();

  let preamble = markdown;
  for (const marker of [DIARY_START, DIARY_END, DEEP_START, DEEP_END]) {
    preamble = preamble.split(marker).join("");
  }
  if (diary !== null) {
    // Remove the whole diary body too: `preamble` is what surrounds the entries,
    // not the entries again.
    preamble = preamble.split(diary).join("");
  }
  if (deepSleep !== null) {
    preamble = preamble.split(deepSleep).join("");
  }
  preamble = preamble
    .replace(/^#\s*Dream Diary\s*$/m, "")
    .replace(/^##\s*Deep Sleep\s*$/m, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { entries, deepSleep: deepSleep?.trim() || null, preamble };
}
