// The retrieval tools: memory_search, memory_get, memory_reindex.
//
// WHY THE MODEL NEEDS THESE AT ALL
//   Snapshots and entries are written whether or not anything looks for them, so
//   the corpus is only useful if the model can reach it. Registering them as
//   tools rather than injecting a block into every prompt is the difference
//   between memory that costs nothing when unused and memory that taxes every
//   single request.
//
// A PLAIN ASYNC FUNCTION, AND `content` IS WHAT THE MODEL SEES
//   `@opencode/plugin`'s promise layer defines `execute` as returning
//   `Promise<Tool.Result>`, where `content` is the rendered text. The Effect
//   signature in `@opencode/schema` is the layer underneath and is not the one
//   this plugin imports, so nothing here needs Effect or a `Schema.Codec`.
//
//   Errors are returned as content rather than thrown. A thrown rejection reaches
//   the model as an opaque fault it cannot reason about, whereas "no match" or
//   "the service is down" are things it can act on -- retry in text mode, run
//   memory_reindex, move on.
//
// OUTPUT IS MARKDOWN, NOT JSON
//   The result is read by the model, not parsed by code. Metadata carries the
//   structured fields for anything programmatic; the string carries the content
//   in the form that reads back usefully.
import type { DatabaseSync } from "node:sqlite";
import type { Plugin } from "@opencode/plugin";
import type { MemPlusService } from "./model/client.js";
import {
  getUnit,
  indexStats,
  search,
  storeVector,
  toMatchExpression,
  unitsMissingVectors,
  type SearchFilters,
  type SearchHit,
  type SearchMode,
} from "./memory-index.js";
import {
  discoverArchiveFiles,
  discoverProjectFiles,
  reindexFiles,
  type DiscoveredFile,
} from "./memory-scan.js";
import { projectSlug } from "./paths.js";

/**
 * The exact shape `editor.add` accepts, derived from the context rather than
 * imported.
 *
 * `@opencode/plugin` does not re-export `Tool` from its main entry point, and
 * `@opencode/schema` is only a transitive dependency. Reaching the type through
 * `Plugin.Context["tool"]` needs no extra package and cannot drift from the
 * installed version: if OpenCode changes `Tool.Info`, this file stops compiling
 * instead of silently registering a tool nothing will call.
 */
type ToolEditor = Parameters<Parameters<Plugin.Context["tool"]["transform"]>[0]>[0];

export type MemoryTool = Parameters<ToolEditor["add"]>[0];

/** What a tool executor is handed: unvalidated input plus a cancellation signal. */
type ToolInput = Parameters<MemoryTool["execute"]>[0];
type ToolContext = Parameters<MemoryTool["execute"]>[1];
/** What an executor returns. */
type ToolResult = Awaited<ReturnType<MemoryTool["execute"]>>;

export type RetrievalDeps = {
  /** `null` when `node:sqlite` is unavailable; retrieval is then simply absent. */
  readonly db: DatabaseSync | null;
  readonly workspaceDir: string;
  /** The inference service, for `/embed`. `null` disables vector modes. */
  readonly service: MemPlusService | null;
  readonly log: (message: string, detail?: unknown) => void;
  /** How many units to embed per reindex pass. Keeps one tool call bounded. */
  readonly embedBatch?: number;
};

const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 25;
/** Characters of a hit quoted back. Enough to be useful, short enough to read. */
const EXCERPT_CHARS = 700;
/** Upper bound on embedding work per `memory_reindex` call. */
const EMBED_BUDGET = 64;

const SCOPE_ALL = "all";
const SCOPE_PROJECT = "project";
const SCOPE_ARCHIVE = "archive";

type RawInput = Record<string, unknown>;

function str(input: RawInput, key: string): string | undefined {
  const value = input[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function int(input: RawInput, key: string, fallback: number, max: number): number {
  const value = input[key];
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(1, Math.trunc(value)));
}

function bool(input: RawInput, key: string, fallback: boolean): boolean {
  const value = input[key];
  return typeof value === "boolean" ? value : fallback;
}

/** Truncate on a word boundary where one is close by. */
function excerpt(text: string, limit = EXCERPT_CHARS): string {
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  const boundary = cut.lastIndexOf(" ");
  return `${(boundary > limit * 0.6 ? cut.slice(0, boundary) : cut).trimEnd()}...`;
}

function dayOf(hit: SearchHit): string {
  return hit.day ?? (hit.ts ? new Date(hit.ts).toISOString().slice(0, 10) : "undated");
}

function renderHits(hits: readonly SearchHit[], mode: SearchMode, projects: number): string {
  if (hits.length === 0) {
    return [
      "No memory matched.",
      "",
      "Nothing has been forgotten -- the query simply found nothing. Try: fewer or",
      "more general terms, drop the filters, or `memory_reindex` if files were",
      "written outside the plugin.",
    ].join("\n");
  }

  const lines: string[] = [
    `${hits.length} ${hits.length === 1 ? "memory" : "memories"} (${mode} search, ${projects} ${
      projects === 1 ? "project" : "projects"
    })`,
    "",
  ];

  hits.forEach((hit, index) => {
    const label = [hit.entryType, dayOf(hit), hit.project].filter(Boolean).join(" · ");
    lines.push(`### ${index + 1}. ${hit.heading || "(untitled)"}`);
    lines.push(`\`${label}\``);
    lines.push("");
    lines.push(excerpt(hit.text));
    if (hit.tags.length > 0) lines.push("", `Tags: ${hit.tags.join(", ")}`);
    // The unit id is the handle `memory_get` takes; without it a hit cannot be
    // expanded, which would make the tools useless in combination.
    lines.push("", `Source: ${hit.path} (unit ${hit.unitId}${hit.marker ? `, ${hit.marker}` : ""})`);
    lines.push("");
  });

  lines.push(`Use memory_get with a unit id to read one in full.`);
  return lines.join("\n");
}

async function embedQuery(
  deps: RetrievalDeps,
  query: string,
  signal: AbortSignal | undefined,
): Promise<readonly number[] | undefined> {
  if (!deps.service) return undefined;
  try {
    return await deps.service.embed(query, signal);
  } catch (error) {
    // A vector query that degrades to text beats a failed tool call, but the
    // caller has to know the ranking is weaker.
    if (signal?.aborted) throw error;
    deps.log("query embedding failed, falling back to text ranking", error);
    return undefined;
  }
}

/** Fill in vectors for units that do not have one. Returns how many were added. */
async function embedMissing(
  deps: RetrievalDeps,
  budget: number,
  signal: AbortSignal | undefined,
): Promise<number> {
  const db = deps.db;
  if (!db || !deps.service || budget <= 0) return 0;
  let written = 0;
  for (const unit of unitsMissingVectors(db, budget)) {
    // Checked before each unit, not just once: this loop is the longest-running
    // thing a tool call can do here, so a stop request that arrives halfway
    // through must not be ignored until the whole budget is spent.
    if (signal?.aborted) break;
    try {
      const vector = await deps.service.embed(unit.text, signal);
      storeVector({ db, unitId: unit.id, vector });
      written += 1;
    } catch (error) {
      if (signal?.aborted) break;
      deps.log(`embedding unit ${unit.id} failed`, error);
      // One failure usually means the model is gone; stop rather than burning
      // the rest of the budget on the same error.
      break;
    }
  }
  return written;
}

async function runSearch(
  deps: RetrievalDeps,
  input: RawInput,
  signal: AbortSignal | undefined,
): Promise<{
  content: string;
  metadata: Record<string, unknown>;
}> {
  const db = deps.db;
  const query = str(input, "query");
  if (!db) {
    return {
      content:
        "Memory search is unavailable: this OpenCode build has no `node:sqlite`, " +
        "which the index requires. Snapshots and extraction are unaffected.",
      metadata: { available: false, reason: "node:sqlite unavailable" },
    };
  }
  if (!query) {
    return {
      content: "A `query` is required. Pass the words you remember, not a sentence of instructions.",
      metadata: { available: true, error: "missing query" },
    };
  }

  const scope = str(input, "scope") ?? SCOPE_PROJECT;
  const requested = str(input, "mode");
  const limit = int(input, "limit", DEFAULT_LIMIT, MAX_LIMIT);
  const projectFilter = str(input, "project");

  // Text is the default because it needs no model and no warm service. Asking for
  // a mode that cannot work is reported rather than silently downgraded, so the
  // caller is not misled about which ranking produced the answer.
  let mode: SearchMode = "text";
  if (requested === "vector" || requested === "hybrid") {
    if (deps.service) {
      mode = requested;
    } else {
      return {
        content:
          "Vector search needs the local inference service, which is not running. " +
          'Use mode "text", or start the service and retry.',
        metadata: { available: true, error: "no inference service" },
      };
    }
  }

  let queryVector: readonly number[] | undefined;
  if (mode !== "text") {
    // Fall back rather than fail if the model will not load; the note below tells
    // the caller which ranking actually ran.
    queryVector = await embedQuery(deps, query, signal);
    if (!queryVector) {
      if (requested === "vector") {
        return {
          content:
            "Could not embed the query (the inference service did not respond), and " +
            'vector mode has no text fallback by design. Retry with mode "text" or "hybrid".',
          metadata: { available: true, error: "query embedding failed" },
        };
      }
      mode = "text";
    }
  }

  // Text mode needs at least one word FTS5 can look up. A query of nothing but
  // punctuation or bare operators is not an empty corpus, and reporting it as
  // "no memory matched" is the one answer that teaches the model that memories
  // are gone. Checked after the mode is settled, because a keywordless query is
  // perfectly valid in vector mode.
  if (mode === "text" && !toMatchExpression(query)) {
    return {
      content:
        `The query "${query}" has no searchable words in it. ` +
        'Use mode "hybrid" or "vector" for a query with no keywords, or pass real words ' +
        "(punctuation and the bare words AND / OR / NOT are dropped).",
      metadata: { available: true, error: "no searchable terms" },
    };
  }

  const filters: SearchFilters = {
    kind: str(input, "kind") as SearchFilters["kind"],
    entryType: str(input, "type"),
    tag: str(input, "tag"),
    since: str(input, "since"),
    until: str(input, "until"),
    project: projectFilter,
    currentProjectOnly: scope === SCOPE_PROJECT,
  };

  const errors: string[] = [];
  const hits = await search({
    db,
    query,
    mode,
    filters,
    limit,
    currentProject: projectSlug(deps.workspaceDir),
    queryVector,
    onError: (message: string) => errors.push(message),
  });

  const projects = new Set(hits.map((hit) => hit.project)).size;
  const content = [
    renderHits(hits, mode, projects),
    // Stated explicitly, because a silently degraded search teaches the model
    // that memories do not exist.
    errors.length > 0 ? `\n**Search degraded:** ${errors.join("; ")}` : "",
  ]
    .filter((part) => part.length > 0)
    .join("\n");

  return {
    content,
    metadata: {
      available: true,
      mode,
      requestedMode: requested ?? "text",
      limit,
      hits: hits.length,
      projects,
      units: hits.map((hit) => ({
        unitId: hit.unitId,
        project: hit.project,
        path: hit.path,
        day: hit.day,
        type: hit.entryType,
        tags: hit.tags,
        marker: hit.marker,
      })),
      ...(errors.length > 0 ? { errors } : {}),
    },
  };
}

async function runGet(deps: RetrievalDeps, input: RawInput): Promise<{
  content: string;
  metadata: Record<string, unknown>;
}> {
  const db = deps.db;
  if (!db) {
    return { content: "Memory search is unavailable: no `node:sqlite` in this runtime.", metadata: {} };
  }
  const id = input["unitId"];
  if (typeof id !== "number" || !Number.isFinite(id)) {
    return {
      content: "A numeric `unitId` is required -- take it from a memory_search result.",
      metadata: { error: "missing unitId" },
    };
  }
  const hit = getUnit(db, Math.trunc(id));
  if (!hit) {
    return {
      content:
        `No unit ${Math.trunc(id)}. It may have been reindexed away; ` +
        "run memory_reindex and search again.",
      metadata: { error: "not found", unitId: Math.trunc(id) },
    };
  }
  // Built by appending rather than by filtering a literal array: the blank lines
  // are what markdown needs between a heading, a label and a body, and a
  // `filter(part !== "")` sweep removes exactly the separators it should keep.
  const body: string[] = [`# ${hit.heading || "(untitled)"}`, ""];
  const label = [hit.entryType, dayOf(hit), hit.project, hit.path].filter(Boolean).join(" · ");
  if (label) body.push(`\`${label}\``);
  if (hit.tags.length > 0) body.push(`Tags: ${hit.tags.join(", ")}`);
  body.push("", hit.text);

  return {
    content: body.join("\n"),
    metadata: {
      unitId: hit.unitId,
      project: hit.project,
      path: hit.path,
      day: hit.day,
      type: hit.entryType,
      tags: hit.tags,
      marker: hit.marker,
    },
  };
}

/** Files in scope for a reindex call. */
async function filesInScope(
  deps: RetrievalDeps,
  scope: string,
): Promise<{ project: DiscoveredFile[]; archive: DiscoveredFile[] }> {
  const project = scope === SCOPE_ARCHIVE ? [] : await discoverProjectFiles(deps.workspaceDir);
  const archive = scope === SCOPE_PROJECT ? [] : await discoverArchiveFiles();
  return { project, archive };
}

async function runReindex(
  deps: RetrievalDeps,
  input: RawInput,
  signal: AbortSignal | undefined,
): Promise<{
  content: string;
  metadata: Record<string, unknown>;
}> {
  const db = deps.db;
  if (!db) {
    return { content: "Reindexing is unavailable: no `node:sqlite` in this runtime.", metadata: {} };
  }
  const scope = str(input, "scope") ?? SCOPE_ALL;
  const wantVectors = bool(input, "embed", false);
  const started = Date.now();

  const files = await filesInScope(deps, scope);
  const projectReport = await reindexFiles({ db, files: files.project, root: "project" });
  const archiveReport =
    files.archive.length > 0
      ? await reindexFiles({ db, files: files.archive, root: "archive" })
      : { scanned: 0, indexed: 0, skipped: 0, pruned: 0, units: 0, mirrored: 0 };

  // A first reindex has nothing embedded yet, so vector mode would return
  // nothing at all. Filling the budget here means one tool call is enough to
  // make semantic search usable.
  const embedded = wantVectors
    ? await embedMissing(deps, int(input, "embedBudget", EMBED_BUDGET, 500), signal)
    : 0;

  const stats = indexStats(db);
  const totals = {
    scanned: projectReport.scanned + archiveReport.scanned,
    indexed: projectReport.indexed + archiveReport.indexed,
    skipped: projectReport.skipped + archiveReport.skipped,
    pruned: projectReport.pruned + archiveReport.pruned,
    units: projectReport.units + archiveReport.units,
    mirrored: projectReport.mirrored + archiveReport.mirrored,
  };

  return {
    content: [
      `Reindexed ${totals.indexed} of ${totals.scanned} file(s) (${totals.skipped} unchanged).`,
      totals.pruned > 0 ? `Removed ${totals.pruned} document(s) deleted from disk.` : "",
      // Stated rather than hidden: a non-zero count means the archive mirror was
      // recognised and skipped, which is the intended behaviour, not lost data.
      totals.mirrored > 0
        ? `${totals.mirrored} file(s) were byte-identical copies of an indexed document and were indexed once.`
        : "",
      embedded > 0 ? `Embedded ${embedded} unit(s).` : "",
      "",
      `Index: ${stats.documents} documents, ${stats.units} searchable units, ${stats.vectors} vectors.`,
      wantVectors && embedded === 0 && stats.vectors === 0
        ? "Nothing embedded -- vector search stays unavailable until some are."
        : "",
      `Took ${((Date.now() - started) / 1000).toFixed(1)}s.`,
    ]
      .filter((line) => line !== "")
      .join("\n"),
    metadata: { scope, ...totals, embedded, ...stats },
  };
}

const SEARCH_DESCRIPTION = [
  "Search your own memory: everything mem-plus has recorded from earlier sessions.",
  "",
  "Use it when the user refers to past work (\"what did we decide about X\", \"the",
  "port we set\", \"fix that bug again\"), when you need a decision or a path you",
  "were given earlier, or when starting work in a repository you have touched before.",
  "Prefer it over asking: the answer is usually already here.",
  "",
  "Default scope is this project only. Pass scope \"all\" to include every other",
  "project and the global archive. mode \"hybrid\" (text plus embeddings) is the",
  "most useful; it needs the local inference service. Dates are YYYY-MM-DD.",
].join("\n");

const SEARCH_INPUT = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description:
        "Words you remember, not instructions. Several terms are combined with AND, so start specific and relax if nothing matches.",
    },
    scope: {
      type: "string",
      enum: [SCOPE_PROJECT, SCOPE_ALL, SCOPE_ARCHIVE],
      description: `"${SCOPE_PROJECT}" (default) is this project only. "${SCOPE_ALL}" covers every project. "${SCOPE_ARCHIVE}" is the global archive alone.`,
    },
    mode: {
      type: "string",
      enum: ["text", "vector", "hybrid"],
      description:
        '"text" is fast and needs no model. "hybrid" blends keyword and semantic ranking (recommended). "vector" is semantic only.',
    },
    kind: {
      type: "string",
      enum: ["entry", "turn", "memory"],
      description:
        '"entry" is a distilled memory, "turn" is one exchange from a session transcript, "memory" is promoted long-term memory. Omit for all.',
    },
    type: {
      type: "string",
      description:
        "Filter by openclaw's capture type: feature, bug-fix, configuration, refactor, research, decision, other.",
    },
    tag: { type: "string", description: "Exact tag, e.g. \"postgres\"." },
    project: { type: "string", description: "Project slug, e.g. \"my-app--4f2a1c\"." },
    since: { type: "string", description: "Only entries on or after this YYYY-MM-DD." },
    until: { type: "string", description: "Only entries on or before this YYYY-MM-DD." },
    limit: { type: "number", description: `1-${MAX_LIMIT}, default ${DEFAULT_LIMIT}.` },
  },
  required: ["query"],
  additionalProperties: false,
} as const;

const REINDEX_DESCRIPTION = [
  "Rebuild the search index from the memory markdown on disk, and optionally embed",
  "new entries so semantic search becomes available.",
  "",
  "Run it when memory_search returns nothing you know should exist -- for example",
  "after importing memory written by another machine, after hand-editing files, or",
  "when you want semantic search enabled for the first time. The markdown is the",
  "source of truth, so this is always safe to run and never loses a memory.",
].join("\n");

const REINDEX_INPUT = {
  type: "object",
  properties: {
    scope: {
      type: "string",
      enum: [SCOPE_ALL, SCOPE_PROJECT, SCOPE_ARCHIVE],
      description: `Default "${SCOPE_ALL}".`,
    },
    embed: {
      type: "boolean",
      description:
        "Also embed units that have no vector yet. This is what turns on semantic search; it takes a few seconds per unit locally.",
    },
    embedBudget: {
      type: "number",
      description: `Maximum units to embed this call (1-500, default ${EMBED_BUDGET}).`,
    },
  },
  additionalProperties: false,
} as const;

export type RetrievalTools = {
  readonly available: boolean;
  readonly reason?: string;
  readonly tools: readonly MemoryTool[];
};

/**
 * Build the retrieval tool definitions.
 *
 * Returns `available: false` and an empty list when there is no index to search.
 * The caller registers nothing in that case: a tool that always answers
 * "unavailable" is worse than no tool, because the model keeps calling it.
 *
 * No namespace is declared, so the names below are the names the model sees.
 * Grouping them under a `memory` namespace would produce `memory_memory_search`,
 * which reads as a typo.
 */
export function buildMemoryTools(deps: RetrievalDeps): RetrievalTools {
  if (!deps.db) {
    deps.log("retrieval tools not built: node:sqlite is unavailable in this runtime");
    return { available: false, reason: "node:sqlite unavailable", tools: [] };
  }

  // `input` arrives as `unknown` because the JSON Schema is OpenCode's to
  // validate, not ours. Every accessor below re-checks its own type, so a
  // malformed or hand-rolled call degrades to a default instead of throwing.
  const search: MemoryTool = {
    name: "memory_search",
    description: SEARCH_DESCRIPTION,
    input: SEARCH_INPUT,
    execute: async (input, context) => {
      const { content, metadata } = await runSearch(deps, raw(input), context?.signal);
      return { content, metadata } satisfies ToolResult;
    },
  };

  const get: MemoryTool = {
    name: "memory_get",
    description: [
      "Read one memory in full, by the unit id a memory_search result reported.",
      "",
      "Use it when a hit looks relevant but was truncated, or when you need the exact",
      "detail -- a path, a command, a config value -- rather than the summary.",
    ].join("\n"),
    input: {
      type: "object",
      properties: {
        unitId: { type: "number", description: "The unit id from a memory_search result." },
      },
      required: ["unitId"],
      additionalProperties: false,
    },
    execute: async (input) => {
      const { content, metadata } = await runGet(deps, raw(input));
      return { content, metadata } satisfies ToolResult;
    },
  };

  const reindex: MemoryTool = {
    name: "memory_reindex",
    description: REINDEX_DESCRIPTION,
    input: REINDEX_INPUT,
    execute: async (input, context) => {
      const { content, metadata } = await runReindex(deps, raw(input), context?.signal);
      return { content, metadata } satisfies ToolResult;
    },
  };

  const tools: readonly MemoryTool[] = [search, get, reindex];
  deps.log(`retrieval tools ready: ${tools.map((tool) => tool.name).join(", ")}`);
  return { available: true, tools };
}

/** Narrow an unvalidated tool input to the string-keyed object the handlers read. */
function raw(input: ToolInput): RawInput {
  return typeof input === "object" && input !== null ? (input as RawInput) : {};
}