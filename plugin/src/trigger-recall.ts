// Lane-one trigger recall: openclaw's per-message hidden-context injection.
//
// PORTED from openclaw `extensions/active-memory/trigger-recall.ts` (418 lines)
// and the `buildPromptPrefix` half of its `prompt.ts`.
//
// WHAT THIS DOES
//   An inbound message is scored against the `<!-- trigger: ... -->` phrases that
//   curated entries carry. Above `STRONG_TRIGGER_MATCH_SCORE`, the top
//   `TRIGGER_INJECTION_LIMIT` entries are rendered as one compact hidden block and
//   handed back to the caller. That is upstream's whole lane one: a lexical pre-filter
//   (no query embedding), a hand-rolled phrase-overlap score, a hard cap, and a
//   character budget on the block.
//
// WHAT MOVED, AND WHY
//   1. The two loader functions. Upstream resolves a memory *provider* or a *search
//      manager* from its own config surface and issues `search(..., lexicalOnly)` plus
//      `listTriggerCandidates(...)`. mem-plus has its own index, so the two queries are
//      `searchText` and `listTriggerCandidates` in `memory-index.ts`. The scoring,
//      filtering, ordering and cap below are untouched.
//   2. Delivery. Upstream injects the block into the system prompt of the turn that is
//      already running. OpenCode V2's plugin type is `{ id, setup }` with no prompt hook,
//      `ctx.agent.transform` takes a *synchronous* callback that receives only an agent
//      editor (so it can neither await a search nor see the message), and
//      `ctx.aisdk.hook` only wraps model *construction*. There is no per-request seam a
//      plugin can push context through, so this is a pull: the caller asks.
//   3. The run cache. Upstream memoises candidates per `runId` because several recall
//      paths consult lane one within one agent run. mem-plus has no run identity, so
//      there is nothing to memoise against and the map is gone.
//
// NOT PORTED: the origin-class eligibility gate
//   `isPromotedTrustedMemoryEntry` keeps `automaticRecall.eligible`, which upstream
//   computes from the entry's stored provenance. mem-plus's index has no provenance
//   column, so the check here is the structural equivalent -- only curated `MEMORY.md`
//   units reach this file at all (see `listTriggerCandidates`) -- and the project-key
//   half of the same predicate is verbatim.
import type { SearchHit } from "./memory-index.js";
import { listTriggerCandidates, searchText, type SearchFilters } from "./memory-index.js";
import { isAutomaticMemoryEntryEligible } from "../../packages/memory-host-sdk/src/host/types.js";
import { truncateUtf16Safe } from "../../packages/normalization-core/src/utf16-slice.js";

const TRIGGER_CANDIDATE_LIMIT = 24;
const TRIGGER_INJECTION_LIMIT = 3;
const MAX_TRIGGER_CONTEXT_CHARS = 1800;
// 0.65 measured on a 20-trigger/50-unrelated synthetic corpus: zero false
// positives down to 0.60, while 0.72 rejected legitimate paraphrases and the
// 0.68 ceiling of single-word concept triggers (0.85 * 0.8 phrase weight) that
// the promotion writer emits. Raising this silently disables trigger recall
// for promoted entries; lowering it below ~0.6 starts admitting topic drift.
const STRONG_TRIGGER_MATCH_SCORE = 0.65;
const WORD_RE = /[\p{L}\p{N}_]+/gu;

// openclaw's `prompt.ts` tag triple, verbatim.
const ACTIVE_MEMORY_PLUGIN_TAG = "active_memory_plugin";
const ACTIVE_MEMORY_CONTEXT_HEADER = "Context:";
const ACTIVE_MEMORY_OPEN_TAG = `<${ACTIVE_MEMORY_PLUGIN_TAG}>`;
const ACTIVE_MEMORY_CLOSE_TAG = `</${ACTIVE_MEMORY_PLUGIN_TAG}>`;

export type TriggerRecallMatch = SearchHit & { matchScore: number };

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** openclaw's `buildPromptPrefix`, verbatim. */
export function buildPromptPrefix(summary: string): string {
  return [
    ACTIVE_MEMORY_CONTEXT_HEADER,
    ACTIVE_MEMORY_OPEN_TAG,
    escapeXml(summary),
    ACTIVE_MEMORY_CLOSE_TAG,
  ].join("\n");
}

function normalizeWords(value: string): string[] {
  return (value.toLowerCase().match(WORD_RE) ?? []).filter((word) => word.length > 1);
}

function splitTriggerPhrases(value: string): string[] {
  return value
    .split(/[\n;|]+/u)
    .map((phrase) => phrase.trim())
    .filter(Boolean);
}

function prepareTriggerScorer(message: string): (entry: SearchHit) => number {
  let messageWordSet: Set<string> | undefined;
  const scorePhrase = (phrase: string): number => {
    const triggerWords = [...new Set(normalizeWords(phrase))];
    if (triggerWords.length === 0) {
      return 0;
    }
    const words = (messageWordSet ??= new Set(normalizeWords(message)));
    if (triggerWords.length === 1) {
      return words.has(triggerWords[0] ?? "") ? 0.85 : 0;
    }
    const overlap = triggerWords.filter((word) => words.has(word)).length;
    if (overlap === 0) {
      return 0;
    }
    const coverage = overlap / triggerWords.length;
    return coverage * 0.8 + Math.min(1, overlap / 2) * 0.2;
  };
  return (entry) => {
    if (!entry.triggers) {
      return 0;
    }
    const triggerScore = Math.max(
      0,
      ...splitTriggerPhrases(entry.triggers).map(scorePhrase),
    );
    const relevance = Math.max(0, Math.min(1, entry.score ?? 0));
    return triggerScore * 0.8 + relevance * 0.2;
  };
}

/**
 * Upstream's `isPromotedTrustedMemoryEntry`, in full.
 *
 * `automaticRecall.eligible` upstream is computed in `toLegacyTriggerRecallHit` as
 * `source === "memory" && isAutomaticMemoryEntryEligible(entry) && projectKeys?.length !== 0`.
 * The middle term is openclaw's own `originClass ∈ {owner, agent}` gate and it now reads a
 * real stored value; the last term is why a scoped-but-broken project annotation never
 * matches, which is why the empty-key case needs no separate branch here — an unannotated
 * entry has no keys, so the all-of check is vacuously true and it stays global.
 */
/**
 * Upstream's curated-tier gate, with a coarser input.
 *
 * Upstream reads the entry's own provenance row, so one file can hold both eligible and
 * ineligible entries and only the eligible ones pass. Here `entry.provenance.originClass`
 * comes from `documents.origin_class`, which is ONE value per FILE (`memory-path-provenance.ts`
 * decides it by path). So when a curated file mixes qualified and unqualified entries, every
 * entry in it passes where upstream would admit only some.
 *
 * That is a weakened version of a property the architecture docs name as a security
 * boundary rather than a tuning choice, so it is registered as a divergence in
 * `docs/port-plan.md` and pinned to P2: the gate cannot have upstream's input until
 * provenance is per chunk, which is what upstream's `memory_index_chunk_provenance` is.
 *
 * `isAutomaticMemoryEntryEligible` and the project-key term are upstream's, verbatim.
 */
function isPromotedTrustedMemoryEntry(
  entry: SearchHit,
  activeProjectKeys: readonly string[] = [],
): boolean {
  const projectKeys = entry.projectKey
    ? entry.projectKey
        .split(";")
        .map((key) => key.trim())
        .filter(Boolean)
    : undefined;
  const eligible =
    entry.source === "memory" &&
    isAutomaticMemoryEntryEligible({ provenance: entry.provenance }) &&
    projectKeys?.length !== 0;
  return (
    eligible && (!projectKeys || projectKeys.every((key) => activeProjectKeys.includes(key)))
  );
}

export function selectStrongTriggerMatches(
  message: string,
  entries: SearchHit[],
  activeProjectKeys: readonly string[] = [],
): TriggerRecallMatch[] {
  const scoreTriggerMatch = prepareTriggerScorer(message);
  return entries
    .filter((entry) => isPromotedTrustedMemoryEntry(entry, activeProjectKeys))
    .map((entry) => Object.assign({}, entry, { matchScore: scoreTriggerMatch(entry) }))
    .filter((entry) => entry.matchScore >= STRONG_TRIGGER_MATCH_SCORE)
    .toSorted(
      (left, right) =>
        right.matchScore - left.matchScore ||
        left.path.localeCompare(right.path) ||
        left.startLine - right.startLine ||
        left.chunkId.localeCompare(right.chunkId),
    )
    .slice(0, TRIGGER_INJECTION_LIMIT);
}

export function buildTriggerRecallContext(matches: TriggerRecallMatch[]): string | undefined {
  if (matches.length === 0) {
    return undefined;
  }
  // Upstream's own line (`active-memory/trigger-recall.ts:113` in the upstream repo, and
  // `:277` for the citation form): the excerpt, then the source label. `snippet` replaces
  // the `text` field this used, and `citation` replaces the hand-built `#L${startLine}` --
  // which now carries a real line range instead of a unit id wearing one.
  const summary = matches
    .map((entry) => `- ${entry.snippet.trim()} (Source: ${entry.citation ?? entry.path})`)
    .join("\n");
  return buildPromptPrefix(truncateUtf16Safe(summary, MAX_TRIGGER_CONTEXT_CHARS));
}

function waitForTriggerLookup<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) {
    return work;
  }
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () =>
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new Error("active-memory trigger recall aborted", { cause: signal.reason }),
      );
    signal.addEventListener("abort", onAbort, { once: true });
    void work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

export type TriggerRecallResult = {
  /** The hidden block, or undefined when nothing cleared the bar. */
  readonly context?: string;
  readonly hasStrongHit: boolean;
  readonly injectedCount: number;
};

/**
 * Upstream's `resolveTriggerRecall`, wired to mem-plus's index.
 *
 * `db` is the open index; `filters`/`currentProject` are the same narrowing the
 * `memory_search` tool uses, so a caller that scoped its search also scopes its
 * trigger candidates.
 */
export async function resolveTriggerRecall(params: {
  db: import("node:sqlite").DatabaseSync;
  message: string;
  filters?: SearchFilters;
  currentProject?: string;
  activeProjectKeys?: string[];
  signal?: AbortSignal;
  onError?: (message: string) => void;
}): Promise<TriggerRecallResult> {
  params.signal?.throwIfAborted();
  const activeProjectKeys = params.activeProjectKeys ?? [];
  // Lane one stays local and deterministic; do not embed the query. This is
  // upstream's `lexicalOnly: true`, which is what `searchText` already is.
  const candidates = await waitForTriggerLookup(
    (async () => {
      const retrieved = searchText({
        db: params.db,
        query: params.message,
        filters: params.filters ?? {},
        limit: TRIGGER_CANDIDATE_LIMIT,
        currentProject: params.currentProject,
        onError: params.onError,
      });
      // No `limit`: upstream's call site passes only `activeProjectKeys`, so the query's
      // own default of 512 is what upstream runs.
      const triggerCandidates = listTriggerCandidates({
        db: params.db,
        onError: params.onError,
      });
      // Upstream keys this dedupe on the provider reference; the index's identity is the
      // chunk row id, which is a hash over `(source, path, startLine, endLine, text, model)`
      // -- so two corpora holding the same bytes get different ids and both survive, which is
      // what separating them by `source` is for.
      const entries = new Map<string, SearchHit>();
      for (const entry of [...triggerCandidates, ...retrieved]) {
        const existing = entries.get(entry.chunkId);
        if (!existing || (existing.triggers ?? null) === null) {
          entries.set(entry.chunkId, entry);
        }
      }
      return [...entries.values()];
    })(),
    params.signal,
  );
  params.signal?.throwIfAborted();
  const matches = selectStrongTriggerMatches(params.message, candidates, activeProjectKeys);
  const context = buildTriggerRecallContext(matches);
  return {
    ...(context ? { context } : {}),
    hasStrongHit: matches.length > 0,
    injectedCount: matches.length,
  };
}

export { TRIGGER_CANDIDATE_LIMIT, TRIGGER_INJECTION_LIMIT, MAX_TRIGGER_CONTEXT_CHARS, STRONG_TRIGGER_MATCH_SCORE };