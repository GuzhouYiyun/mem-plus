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
  
  indexStats,
  search,
  chunksMissingVectors,
  storeVector,
  toMatchExpression,
  vectorCount,
  type CorpusFilter,
  type SearchFilters,
  type SearchHit,
  type SearchMode,
} from "./memory-index.js";
import { discoverHomeFiles, discoverWikiFiles, reindexFiles } from "./memory-scan.js";
import { memoryHomeDir } from "./paths.js";
import { recordRetrievalRecalls } from "./promotion.js";
import type { MemorySearchResult } from "../../packages/memory-host-sdk/src/host/types.js";
import { isPathStrictlyInside } from "../../src/infra/path-guards.js";
import { projectSlug } from "./paths.js";
import { readWikiConfig } from "./wiki/config.js";
import { importChatGptExport } from "./wiki/chatgpt.js";
import { readFileSync } from "node:fs";
import path from "node:path";

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

/** What an executor returns. */
type ToolResult = Awaited<ReturnType<MemoryTool["execute"]>>;

export type RetrievalDeps = {
  /** `null` when `node:sqlite` is unavailable; retrieval is then simply absent. */
  readonly db: DatabaseSync | null;
  readonly workspaceDir: string;
  /** The inference service, for `/embed`. `null` disables vector modes. */
  readonly service: MemPlusService | null;
  /**
   * The embedding model name, recorded as `model` on every chunk row.
   *
   * It has to be the same string at three points -- the index write, the embed pass and the
   * vector lane -- because `model` is part of a chunk's row identity upstream
   * (`manager-source-index-kernel.ts:72`). A mismatch is not a type error anywhere; it is a
   * vector that is written and then never found, because `storeVector` updates
   * `WHERE id = ? AND model = ?` and matches nothing. Hence a required field rather than
   * something read off the service.
   */
  readonly model?: string;
  readonly log: (message: string, detail?: unknown) => void;
  /** How many units to embed per reindex pass. Keeps one tool call bounded. */
  readonly embedBatch?: number;
  /** Raw `opencode.jsonc` options, for the wiki corpus settings. */
  readonly options?: unknown;
};

const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 25;
/** Characters of a hit quoted back. Enough to be useful, short enough to read. */
const EXCERPT_CHARS = 700;
/** Upper bound on embedding work per `memory_reindex` call. */
const EMBED_BUDGET = 64;

const SCOPE_ALL = "all";
const SCOPE_PROJECT = "project";

/**
 * Which corpus a search may return.
 *
 * Defaults to `memory` so every existing query behaves exactly as before: the
 * document corpus is opt-in per call, and `all` is the only way to mix it with
 * memory hits. An unrecognised value falls back to the default rather than
 * failing the call -- a typo narrowing to nothing would look like data loss.
 */
function readCorpus(input: RawInput): CorpusFilter {
  const value = str(input, "corpus");
  return value === "wiki" || value === "all" ? value : "memory";
}

/**
 * Warn-once latch for the degraded-vector notice, per mode.
 *
 * Module-level rather than per-call, mirroring openclaw's `warningShown`: the
 * condition is a property of the index, not of one query, so repeating it on every
 * search would bury the results. Keyed by mode because `vector` and `hybrid` fail
 * differently -- `vector` has no keyword lane and answers "No memory matched", which
 * is strictly worse -- so a user who searched `hybrid` first has still never been
 * told what `vector` is doing.
 */
const degradedVectorWarnedFor = new Set<SearchMode>();

const VECTOR_DEGRADED_NOTICE =
  "\n**Semantic search is not active:** this index has no embeddings, so this " +
  "result came from the keyword lane only and will miss anything without shared " +
  "words. Run memory_reindex with {\"embed\": true} once to enable it.";

/** The vector-only variant: there is no keyword lane to have produced the result. */
const VECTOR_ONLY_NOTICE =
  "\n**Semantic search is not active:** this index has no embeddings, so there is " +
  "nothing for a vector search to match -- which is why this looks empty rather " +
  'than wrong. Run memory_reindex with {"embed": true} once, or use mode "text".';

/**
 * Whether the index has searchable chunks but no vectors for them.
 *
 * Both halves matter: an empty index has nothing to degrade, and a fully embedded one
 * has nothing to report.
 */
function describeMissingVectors(db: DatabaseSync): boolean {
  const chunks = db
    .prepare("SELECT count(*) AS n FROM memory_index_chunks")
    .get() as { n: number };
  if (chunks.n === 0) return false;
  return vectorCount(db) === 0;
}

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

/** A caller-supplied score floor. `undefined` means "the index's own floor applies". */
function num(input: RawInput, key: string): number | undefined {
  const value = input[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Upstream's "bounded excerpt": an omitted `lines` is a cap, not "the whole file". */
const GET_DEFAULT_LINES = 120;
const GET_MAX_LINES = 2_000;

/**
 * Read one memory file for `memory_get`.
 *
 * The `path` is whatever `memory_search` reported, so it is index-relative (a wiki page
 * can be outside the memory home) -- so the guard is openclaw's own
 * `isPathStrictlyInside`, and anything outside is refused rather than read. Upstream can
 * hand this to a host that already owns the path; mem-plus has to open the file itself,
 * which is the whole reason the check exists.
 */
function readMemoryFile(
  relative: string,
): { ok: true; lines: string[] } | { ok: false; reason: "outside" | "missing" } {
  const home = memoryHomeDir();
  const resolved = path.resolve(home, relative);
  if (!isPathStrictlyInside(home, resolved)) return { ok: false, reason: "outside" };
  try {
    return { ok: true, lines: readFileSync(resolved, "utf8").split(/\r?\n/) };
  } catch {
    return { ok: false, reason: "missing" };
  }
}

/** Truncate on a word boundary where one is close by. */
function excerpt(text: string, limit = EXCERPT_CHARS): string {
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  const boundary = cut.lastIndexOf(" ");
  return `${(boundary > limit * 0.6 ? cut.slice(0, boundary) : cut).trimEnd()}...`;
}

function dayOf(hit: SearchHit): string {
  return hit.day ?? "undated";
}

/**
 * Render one hit the way upstream does.
 *
 * Upstream's shape, from `tools.citations.ts:34`:
 *
 *   presented.snippet = `${presented.snippet.trimEnd()}\n\nSource: ${presented.citation}`
 *
 * and `memory-tool-contract.ts:166` tells the model to include `Source: <path#line>`.
 *
 * What changed, and why it is a contraction rather than a regression:
 *   - `### N. <heading>` is gone. Upstream's chunk has no heading field; the parser that
 *     produced mem-plus's headings is a parser that is now deleted. Writing a
 *     new parser to recover headings from chunk text would be adding back something upstream
 *     does not have, which is a divergence, not a seam.
 *   - `Tags: a, b, c` is gone, for the same reason: tags were a `units` column.
 *   - `Source: <path> (unit N, <marker>)` becomes `Source: <citation>`, and the citation is
 *     now a real line range into the file rather than a synthetic unit id. Upstream's
 *     `memory_get` takes `path`, so `path#L4-L9` is both the human-readable pointer and the
 *     argument the follow-up call needs.
 */
function renderHit(hit: SearchHit, index: number): string[] {
  const label = [hit.source, dayOf(hit), hit.project].filter(Boolean).join(" · ");
  const lines = [`### ${index + 1}. ${hit.path}`];
  // Only the label is conditional. The blank lines around the snippet are structural --
  // upstream's `${snippet}\n\nSource: ${citation}` (`tools.citations.ts:34`) is the same
  // shape, and filtering every empty string would collapse them.
  if (label.length > 0) lines.push(`\`${label}\``);
  lines.push("", excerpt(hit.snippet), "", `Source: ${hit.citation ?? hit.path}`, "");
  return lines;
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
    lines.push(...renderHit(hit, index + 1));
  });

  lines.push("Use memory_get with a `path` to read one in full.");
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

/**
 * Whether the embedding service refused this one input, rather than being unable
 * to serve any request.
 *
 * The service reports an over-long input as a 400/500 whose body says the input is
 * longer than the usable context; that is a property of the payload. Anything else
 * -- a refused connection, a model that failed to load, a timeout -- is a property
 * of the service, and no payload will fix it.
 */
export function isUnitInputRejected(error: unknown): boolean {
  const text = error instanceof Error ? `${error.message}` : String(error);
  return /longer than the usable context|input.{0,20}(?:too|exceed)/i.test(text);
}

/**
 * Fill in vectors for units that do not have one. Returns how many were added.
 *
 * Exported so an index can be repaired without going through `memory_reindex`:
 * reindexing prunes whatever it did not scan, so it cannot rebuild one root while
 * leaving the others alone, whereas embedding is purely additive and always safe.
 */
export async function embedMissing(
  deps: RetrievalDeps,
  budget: number,
  signal: AbortSignal | undefined,
): Promise<number> {
  const db = deps.db;
  if (!db || !deps.service || budget <= 0) return 0;
  // `model` is part of a chunk's row identity, so a chunk written without one cannot be
  // given a vector later: writing `embedding` under a `model` the row does not carry would
  // make the `WHERE id = ? AND model = ?` update in `storeVector` match nothing, silently.
  const model = deps.model;
  if (!model) return 0;
  let written = 0;
  const rejected: { id: string; chars: number }[] = [];
  for (const chunk of chunksMissingVectors(db, model, budget)) {
    // Checked before each chunk, not just once: this loop is the longest-running
    // thing a tool call can do here, so a stop request that arrives halfway
    // through must not be ignored until the whole budget is spent.
    if (signal?.aborted) break;
    try {
      const vector = await deps.service.embed(chunk.text, signal);
      storeVector({ db, chunkId: chunk.id, model, vector });
      written += 1;
    } catch (error) {
      if (signal?.aborted) break;
      // Whether to keep going depends on why it failed, and the two cases need
      // opposite handling.
      //
      // A service that is gone fails every chunk identically, so continuing would
      // spend the whole budget rediscovering that. Stop.
      //
      // One input the model cannot accept -- it overflows the context, or it is
      // rejected outright -- fails alone and would fail identically on every later
      // pass, because the queue is `ORDER BY id` and the offending chunk keeps
      // coming back first. Breaking here therefore strands it permanently: it blocks
      // every chunk behind it and no future call can get past it. Skipping and
      // reporting is the only way the rest of the index ever gets embedded.
      if (!isUnitInputRejected(error)) {
        deps.log(`embedding chunk ${chunk.id} failed`, error);
        break;
      }
      const chars = chunk.text.length;
      rejected.push({ id: chunk.id, chars });
      deps.log(
        `embedding chunk ${chunk.id} skipped: ${chars} characters exceeds the model's input limit`,
      );
    }
  }
  if (rejected.length > 0) {
    deps.log(
      `${written} embedded, ${rejected.length} skipped for exceeding the model input limit ` +
        `(chunk ids ${rejected.map((r) => r.id).join(", ")}). These are not searchable by ` +
        "meaning; they remain findable by keyword.",
    );
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
  // Upstream's `maxResults` is canonical; `limit` is this plugin's older name, kept so an
  // existing transcript still works. `maxResults` wins when both are present.
  const limit = int(
    input,
    Object.hasOwn(input, "maxResults") ? "maxResults" : "limit",
    DEFAULT_LIMIT,
    MAX_LIMIT,
  );
  // Upstream's `minScore` has no default in the schema either: absent means "keep the
  // index's own floor", which is `RANKING.minScore`, applied during ranking.
  const minScore = num(input, "minScore");
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
    since: str(input, "since"),
    until: str(input, "until"),
    project: projectFilter,
    currentProjectOnly: scope === SCOPE_PROJECT,
    corpus: readCorpus(input),
  };

  const errors: string[] = [];
  const ranked = await search({
    db,
    query,
    mode,
    filters,
    limit,
    currentProject: projectSlug(deps.workspaceDir),
    queryVector,
    model: deps.model ?? "fts-only",
    onError: (message: string) => errors.push(message),
  });

  // Upstream's `minScore`, applied where a caller's floor is stricter than the index's
  // own (`RANKING.minScore`). It is a post-ranking filter rather than a ranking input
  // because that is what upstream's contract describes -- a floor on what comes back,
  // not a change to how candidates are scored. Applied before recall tracking so the
  // promotion store counts what the model actually saw, and before `limit` so a floor
  // that admits fewer hits is not masked by the cap.
  const hits = (minScore === undefined ? ranked : ranked.filter((hit) => hit.score >= minScore)).slice(0, limit);

  // openclaw's recall tracking. `SearchHit` already carries everything
  // `MemorySearchResult` asks for, so this is a shape change rather than a
  // translation -- and skipping it leaves the promotion store empty, which is why
  // nothing has ever reached `MEMORY.md`.
  void recordRetrievalRecalls({
    memoryHome: memoryHomeDir(),
    query,
    results: hits as unknown as MemorySearchResult[],
  });

  // Semantic recall is only actually available when the corpus has vectors. The
  // conditions and the warn-once behaviour follow openclaw's
  // logMemoryVectorDegradedWrite: enabled, not ready, content present, and not
  // already reported. Its trigger differs -- openclaw warns when a write of a vector
  // fails, this warns when nothing ever wrote one -- but a hybrid search over an
  // unembedded index is the same class of silent degradation.
  //
  // Both vector modes are covered, and `vector` especially needs it: with no keyword
  // lane to fall back on, an unembedded index answers "No memory matched." That is the
  // single most misleading thing this tool can say -- it teaches the model that no
  // memories exist, when in fact none of them were ever embedded.
  const degradedNote =
    mode !== "text" &&
    !degradedVectorWarnedFor.has(mode) &&
    describeMissingVectors(db)
      ? (degradedVectorWarnedFor.add(mode),
        mode === "vector" ? VECTOR_ONLY_NOTICE : VECTOR_DEGRADED_NOTICE)
      : "";

  // Global home documents carry the empty project; the header counts projects,
  // not documents, so the global side is excluded from the count.
  const projects = new Set(hits.map((hit) => hit.project).filter(Boolean)).size;
  const content = [
    renderHits(hits, mode, projects),
    // Stated explicitly, because a silently degraded search teaches the model
    // that memories do not exist.
    errors.length > 0 ? `\n**Search degraded:** ${errors.join("; ")}` : "",
    // A vector search over a corpus with no vectors still returns hits -- the
    // keyword lane fills them -- so nothing else reports that semantic recall is
    // simply absent. Without this, a user who has not run `memory_reindex {"embed": true}`
    // sees plausible-looking results from `mode: "hybrid"` and concludes semantic
    // search works. Measured: hybrid 26/203 against text 179/203 on the same
    // queries, with only the first 26 units embedded.
    degradedNote,
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
      // Upstream's fields, so the metadata block is a projection of `MemorySearchResult`
      // rather than a parallel vocabulary. `citation` is included because it is what the
      // model should pass back to `memory_get`, and `chunkId` is not: it is a row hash and
      // has no model-facing use.
      chunks: hits.map((hit) => ({
        path: hit.path,
        citation: hit.citation,
        startLine: hit.startLine,
        endLine: hit.endLine,
        source: hit.source,
        day: hit.day,
        project: hit.project,
        score: hit.score,
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
  // Upstream's `memory_get` takes `path` and nothing else that identifies a chunk: its index
  // is chunk-keyed and those ids are not model-facing, so a self-invented `unitId` parameter
  // was the one thing here with no upstream counterpart. It was already marked Deprecated
  // and is now gone rather than kept, along with `runGetByUnit` and `index.getUnit`, which
  // existed only to serve it. A transcript that learned the old contract has to go through
  // `path` now, which is what upstream requires.
  const path = str(input, "path");
  if (path === undefined) {
    return {
      content:
        "A `path` is required -- take it from a memory_search result.",
      metadata: { error: "missing path" },
    };
  }
  const read = readMemoryFile(path);
  if (!read.ok) {
    return {
      content:
        read.reason === "outside"
          ? `\`${path}\` is outside the memory home. Read it with your own tools.`
          : `No memory file at \`${path}\`. It may have been reindexed away; ` +
            "run memory_reindex and search again.",
      metadata: { error: read.reason, path },
    };
  }
  const from = int(input, "from", 1, Number.MAX_SAFE_INTEGER);
  const lines = read.lines;
  const start = Math.min(Math.max(1, from), lines.length + 1);
  // Upstream: "Defaults to a bounded excerpt when lines are omitted", so an omitted
  // `lines` is a cap rather than "the rest of the file".
  const count = Math.min(int(input, "lines", GET_DEFAULT_LINES, GET_MAX_LINES), lines.length);
  const slice = lines.slice(start - 1, start - 1 + count);
  const hasMore = start - 1 + slice.length < lines.length;

  const body: string[] = [`# ${path}`, ""];
  body.push(`\`lines ${start}-${start - 1 + slice.length} of ${lines.length}\``);
  body.push("", slice.join("\n"));
  if (hasMore) {
    body.push("", `_More content follows: memory_get { path: "${path}", from: ${start + slice.length} }._`);
  }

  return {
    content: body.join("\n"),
    metadata: {
      path,
      from: start,
      lines: slice.length,
      totalLines: lines.length,
      hasMore,
    },
  };
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
  const wantVectors = bool(input, "embed", false);
  const started = Date.now();

  // Each corpus is scanned and pruned on its own, and both are scanned in full:
  // pruning a subset of a corpus would delete documents that are still on disk,
  // and pruning must always run against the complete set for that root.
  const files = await discoverHomeFiles();
  // `memoryHome` is what makes `classify()` return anything: its first line is
  // `if (!memoryHome) return undefined`. Omitting it here left every home
  // document with `origin_class = NULL`, and `isPromotedTrustedMemoryEntry`
  // rejects a null provenance class -- so lane 1c (trigger injection) filtered
  // out 100% of its candidates and could never fire. Measured 2026-10-11:
  // 15 documents, 1244 units, all NULL.
  const report = await reindexFiles({
    db,
    files,
    root: "home",
    memoryHome: memoryHomeDir(),
    // Same string `embedMissing` below uses. A reindex that wrote a different `model` would
    // re-id every chunk and orphan every vector already stored.
    ...(deps.model ? { model: deps.model } : {}),
  });
  const wiki = readWikiConfig(deps.options);
  const wikiFiles = wiki.enabled ? await discoverWikiFiles(wiki.dir) : [];
  // The wiki is deliberately NOT given a memoryHome: `classify` maps any non-`memory`
  // source to `untrusted`, which keeps imported reference material out of automatic
  // injection. That is the point of the corpus, so it stays unclassified on purpose.
  //
  // Gated on `wiki.enabled`, NOT on `wikiFiles.length > 0`. `reindexFiles` ends in
  // `pruneMissing({ present })`, and that prune is the only thing that removes a wiki
  // document that has been deleted from disk -- so skipping the call because the scan found
  // nothing also skips the only cleanup that root has. Measured 2026-10-15: deleting the last
  // wiki page and running `memory_reindex` left its 29th source row and its chunk in place,
  // still returned by `memory_search {"corpus": "wiki"}`, and `pruned` reported 0. The home
  // root above is reindexed unconditionally for the same reason, and its own comment says why:
  // pruning has to run against the complete set for the root.
  //
  // `reindexFiles` with an empty list is a pure prune -- the loop body never runs, `seen` is
  // empty, and every row of that `source` is cleared. Passing `[]` when the wiki is enabled
  // and empty is exactly the "there is nothing on disk" answer.
  const wikiReport =
    wiki.enabled ? await reindexFiles({ db, files: wikiFiles, root: "wiki" }) : null;

  // A first reindex has nothing embedded yet, so vector mode would return
  // nothing at all. Filling the budget here means one tool call is enough to
  // make semantic search usable.
  const embedded = wantVectors
    ? await embedMissing(deps, int(input, "embedBudget", EMBED_BUDGET, 500), signal)
    : 0;

  const stats = indexStats(db);

  return {
    content: [
      `Reindexed ${report.indexed} of ${report.scanned} file(s) (${report.skipped} unchanged).`,
      report.pruned > 0 ? `Removed ${report.pruned} document(s) deleted from disk.` : "",
      wikiReport
        ? `Wiki corpus: ${wikiReport.indexed} of ${wikiReport.scanned} page(s) (${wikiReport.skipped} unchanged).`
        : "",
      embedded > 0 ? `Embedded ${embedded} chunk(s).` : "",
      "",
      `Index: ${stats.sources} source(s), ${stats.chunks} searchable chunk(s), ${stats.vectors} vector(s).`,
      wantVectors && embedded === 0 && stats.vectors === 0
        ? "Nothing embedded -- vector search stays unavailable until some are."
        : "",
      `Took ${((Date.now() - started) / 1000).toFixed(1)}s.`,
    ]
      .filter((line) => line !== "")
      .join("\n"),
    metadata: { ...report, wiki: wikiReport, embedded, ...stats },
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
  "Default scope is this project only, plus the global long-term memory. Pass",
  "scope \"all\" to include every other project. corpus \"memory\" (default) searches",
  "only what mem-plus recorded; corpus \"wiki\" searches the document corpus",
  "(imported pages such as a ChatGPT export, or notes you dropped in the wiki",
  "directory); corpus \"all\" searches both. mode \"hybrid\" (text plus",
  "embeddings) is the most useful; it needs the local inference service. Dates",
  "are YYYY-MM-DD.",
].join("\n");

/**
 * Upstream's `MEMORY_SEARCH_TOOL_CONTRACT.prepareArguments`, verbatim in behaviour.
 *
 * Models emit `min_score` and `max_results` about as often as the camelCase names, so
 * upstream accepts both and deletes the alias. Explicit camelCase values win -- including
 * invalid ones, which validation then rejects rather than silently repairing.
 */
function normalizeSearchArgs(args: unknown): unknown {
  const params = raw(args);
  if (!Object.hasOwn(params, "min_score") && !Object.hasOwn(params, "max_results")) {
    return args;
  }
  const normalized: RawInput = { ...params };
  for (const [alias, key] of [
    ["min_score", "minScore"],
    ["max_results", "maxResults"],
  ] as const) {
    if (Object.hasOwn(normalized, alias)) {
      if (!Object.hasOwn(normalized, key)) normalized[key] = normalized[alias];
      delete normalized[alias];
    }
  }
  return normalized;
}

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
      enum: [SCOPE_PROJECT, SCOPE_ALL],
      description:
        `"${SCOPE_PROJECT}" (default) is this project only, plus the global long-term memory. "${SCOPE_ALL}" covers every project and the global long-term memory.`,
    },
    mode: {
      type: "string",
      enum: ["text", "vector", "hybrid"],
      description:
        '"text" is fast and needs no model. "hybrid" blends keyword and semantic ranking (recommended). "vector" is semantic only.',
    },
    kind: {
      type: "string",
      enum: ["entry", "turn", "memory", "wiki"],
      description:
        '"entry" is a distilled memory, "turn" is one exchange from a session transcript, "memory" is promoted long-term memory, "wiki" is a section of a document from the wiki corpus. Omit for all.',
    },
    corpus: {
      type: "string",
      enum: ["memory", "wiki", "all"],
      description:
        '"memory" (default) searches what mem-plus recorded from your sessions. "wiki" searches the document corpus (imported pages, notes). "all" searches both.',
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
    // Upstream's names (`memory-tool-contract.ts`). `min_score` / `max_results` are
    // accepted as aliases by `normalizeSearchArgs`, exactly as upstream does.
    maxResults: {
      type: "integer",
      minimum: 1,
      description: `How many hits to return, 1-${MAX_LIMIT}. Default ${DEFAULT_LIMIT}.`,
    },
    minScore: {
      type: "number",
      description: "Drop hits scoring below this. Omit to keep the index's own floor.",
    },
    limit: {
      type: "number",
      description: `Deprecated alias for maxResults; use maxResults. 1-${MAX_LIMIT}, default ${DEFAULT_LIMIT}.`,
    },
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
        const { content, metadata } = await runSearch(
          deps,
          raw(normalizeSearchArgs(input)),
          context?.signal,
        );
      return { content, metadata } satisfies ToolResult;
    },
  };

  const get: MemoryTool = {
    name: "memory_get",
    description: [
      "Read an exact excerpt from a memory file, by the path a memory_search result reported.",
      "",
      "Use it when a hit looks relevant but was truncated, or when you need the exact",
      "detail -- a path, a command, a config value -- rather than the summary.",
    ].join("\n"),
    input: {
      type: "object",
      properties: {
        // Upstream's contract (`memory-tool-contract.ts`): `path` is required and
        // `from`/`lines` are the optional bounded excerpt.
        path: { type: "string", description: "The memory file path a memory_search result reported." },
        from: { type: "integer", minimum: 1, description: "First line to read. Default 1." },
        lines: { type: "integer", minimum: 1, description: "How many lines to read." },
        },
      required: ["path"],
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

  // The wiki importer is the one tool that writes outside the memory home, so it
  // is opt-in twice: `wiki.enabled` must not be false, and it can always be
  // dry-run first. With the corpus disabled the tool is not registered at all --
  // a tool that always answers "disabled" is one the model keeps calling.
  const wiki = readWikiConfig(deps.options);
  const wikiImport: MemoryTool = {
    name: "memory_wiki_import",
    description: [
      "Import a ChatGPT data export into the wiki corpus (the searchable document",
      "directory), one markdown page per conversation, then index them.",
      "",
      "Use it when the user asks to bring their ChatGPT history or exported notes",
      "into memory. Ask for the export directory first: ChatGPT's \"Export data\"",
      "produces a zip containing conversations.json.",
      "",
      "Dry-run first to see how many conversations would be written. Re-importing",
      "the same export is safe and idempotent -- unchanged conversations are left",
      "alone.",
    ].join("\n"),
    input: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Path to the export directory or to its conversations.json. This is a local file path, not a URL.",
        },
        dryRun: {
          type: "boolean",
          description: "Report what would be written without writing anything.",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
    execute: async (input) => {
      const { content, metadata } = await runWikiImport(deps, raw(input));
      return { content, metadata } satisfies ToolResult;
    },
  };

  const tools: readonly MemoryTool[] = wiki.enabled
    ? [search, get, reindex, wikiImport]
    : [search, get, reindex];
  deps.log(`retrieval tools ready: ${tools.map((tool) => tool.name).join(", ")}`);
  return { available: true, tools };
}

async function runWikiImport(
  deps: RetrievalDeps,
  input: RawInput,
): Promise<{ content: string; metadata: Record<string, unknown> }> {
  const db = deps.db;
  if (!db) {
    return {
      content: "Import is unavailable: no `node:sqlite` in this runtime.",
      metadata: {},
    };
  }
  const target = str(input, "path");
  if (!target) {
    return {
      content: "A `path` is required: the ChatGPT export directory or its conversations.json.",
      metadata: { available: true, error: "missing path" },
    };
  }
  const wiki = readWikiConfig(deps.options);
  try {
    const report = await importChatGptExport({
      wikiDir: wiki.dir,
      exportPath: target,
      dryRun: bool(input, "dryRun", false),
    });
    // Index what was written immediately, so the pages are searchable in this
    // session rather than at the next startup reindex.
    let indexed = 0;
    if (!report.dryRun && report.written > 0) {
      const files = await discoverWikiFiles(wiki.dir);
      const reindex = await reindexFiles({ db, files, root: "wiki" });
      indexed = reindex.indexed;
    }
    const lines = [
      report.dryRun
        ? `Would import ${report.conversations} conversation(s) from ${report.exportPath} into ${wiki.dir}.`
        : `Imported ${report.written} of ${report.conversations} conversation(s) from ${report.exportPath}.`,
      !report.dryRun && report.unchanged > 0
        ? `${report.unchanged} unchanged (already imported).`
        : "",
      report.skipped > 0 ? `${report.skipped} could not be written.` : "",
      indexed > 0
        ? `Indexed ${indexed} new page(s); search them with memory_search {"corpus": "wiki"}.`
        : "",
      report.dryRun
        ? "Nothing was written. Repeat without dryRun to import."
        : "Search them with memory_search and corpus \"wiki\" (or \"all\").",
    ];
    return {
      content: lines.filter((line) => line !== "").join("\n"),
      metadata: { ...report, indexed },
    };
  } catch (error) {
    return {
      content: `Import failed: ${error instanceof Error ? error.message : String(error)}`,
      metadata: { available: true, error: "import failed" },
    };
  }
}

/** Narrow an unvalidated tool input to the string-keyed object the handlers read. */
function raw(input: ToolInput): RawInput {
  return typeof input === "object" && input !== null ? (input as RawInput) : {};
}
