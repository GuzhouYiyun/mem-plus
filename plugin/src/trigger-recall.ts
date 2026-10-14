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
// WHAT IS UPSTREAM'S, VERBATIM
//   The whole scoring half, unchanged and unchanged in shape: `TRIGGER_CANDIDATE_LIMIT` 24,
//   `TRIGGER_INJECTION_LIMIT` 3, `MAX_TRIGGER_CONTEXT_CHARS` 1800,
//   `STRONG_TRIGGER_MATCH_SCORE` 0.65, `normalizeWords`, `splitTriggerPhrases`,
//   `prepareTriggerScorer` (0.85 for a single-word hit; otherwise
//   `coverage * 0.8 + min(1, overlap / 2) * 0.2`, then `triggerScore * 0.8 + relevance * 0.2`),
//   `isPromotedTrustedMemoryEntry`, `selectStrongTriggerMatches` and `buildTriggerRecallContext`.
//   The predicates are upstream's term for term -- including the non-obvious
//   `projectKeys?.length !== 0`, which *excludes* an annotated entry from the base lane
//   because an annotated entry belongs to a project and may not be active here.
//   The legacy lane's dedupe key is upstream's too:
//   `${source}:${path}:${startLine}:${endLine}` (upstream `:326`) -- the RANGE, not the row id.
//
// TWO THINGS THAT WERE WRONG AND ARE NOW RIGHT
//   1. The eligibility gate. An earlier version of this file said in a comment that mem-plus's
//      index had no provenance column and that the gate had to be a structural stand-in. That
//      was true then and is false now: provenance is per chunk in
//      `memory_index_chunk_provenance`, `readMemoryRecallMetadata` returns it, and
//      `isAutomaticMemoryEntryEligible` reads upstream's own values. A comment claiming a
//      capability is missing is worse than no comment, because it is a licence to stop looking.
//   2. The annotation carriers. Upstream's `toLegacyTriggerRecallHit` sets
//      `excerpt: stripMemoryAnnotationCarriers(entry.snippet)`. That call is now here too, and
//      it was measured to be a no-op: the chunker already strips carriers before chunking, and
//      a probe over the real path found them absent from the candidate snippet. Kept because
//      upstream's invariant is at this boundary and ours is two files away — see the note on
//      `buildTriggerRecallContext`.
//
// WHAT MOVED, AND WHY -- each of these has no host contract, not a preference
//   1. The two loaders. Upstream resolves a memory *provider* or a *search manager* from its
//      own config surface and issues `search(..., lexicalOnly)` plus
//      `listTriggerCandidates(...)`. mem-plus has its own index, so the two queries are
//      `searchText` and `listTriggerCandidates` in `memory-index.ts`.
//   2. The native lane, not written. `loadNativeTriggerRecallCandidates` needs
//      `getActiveMemoryProvider`, `MemoryCallerContext`, `buildMemoryAudienceCacheIdentity`
//      and the `MemoryProviderHit` contract. None of the four exists in this tree and none has
//      a counterpart in OpenCode's plugin surface: there is no memory-plugin slot to select
//      from, no caller-authority object to assert against, and no audience identity to cache on.
//      Writing a single-lane version of a two-lane dispatcher would be a reimplementation, not a
//      port, so the dispatcher is absent and `resolveTriggerRecall` goes straight to the lane
//      that exists.
//   3. The run cache. Upstream memoises candidates per `runId` because several recall paths
//      consult lane one within one agent run, keyed by `authorityFingerprint` +
//      `requestKey` + audience identity. mem-plus has no run identity and no request-local
//      reuse to key on.
//   4. Delivery. Upstream injects the block into the system prompt of the turn that is already
//      running. OpenCode V2's plugin type is `{ id, setup }` with no prompt hook,
//      `ctx.agent.transform` takes a *synchronous* callback that receives only an agent editor
//      (so it can neither await a search nor see the message), and `ctx.aisdk.hook` only wraps
//      model *construction*. There is no per-request seam a plugin can push context through, so
//      this is a pull: the caller asks.
import type { SearchHit } from "./memory-index.js";
import { listTriggerCandidates, searchText, type SearchFilters } from "./memory-index.js";
import { isAutomaticMemoryEntryEligible } from "../../packages/memory-host-sdk/src/host/types.js";
import { stripMemoryAnnotationCarriers } from "../../packages/memory-host-sdk/src/host/curated-annotations.js";
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
  // Upstream's own line (`active-memory/trigger-recall.ts:113`): the excerpt, then the source
  // label, where `excerpt` is the projection produced by `toLegacyTriggerRecallHit`:
  //
  //   excerpt: stripMemoryAnnotationCarriers(entry.snippet)
  //
  // MEASURED: this call is a no-op today, and it is kept anyway. The chunker already strips the
  // carriers before chunking (`memory-chunking.ts`, upstream
  // `manager-index-preparation.ts:69`), and the recall metadata is extracted from the RAW lines
  // while the chunk text is the stripped one -- so a candidate's `snippet` arrives here with
  // no `<!-- trigger: ... -->` on it. A probe over the real path confirmed it: the candidate
  // snippet was `"- Rolling deploys pause on the canary for ten minutes\n"`, carriers absent.
  //
  // It is kept rather than dropped for one reason: upstream's invariant lives at THIS boundary
  // and ours currently lives two files away in the chunker. Upstream needs the strip here
  // because a memory *provider* may hand back unstripped text. Deleting the call would make
  // this file's correctness depend on a change nobody has made yet, in a module whose whole
  // job is that strip. If the chunker's strip is ever removed, this still holds.
  //
  // It lives here rather than in a projection step because mem-plus has no `MemoryProviderHit`
  // projection to strip in; this is the same value read at the same place upstream reads it.
  //
  // `citation` replaces the hand-built `#L${startLine}` and now carries a real line range.
  const summary = matches
    .map(
      (entry) =>
        `- ${stripMemoryAnnotationCarriers(entry.snippet).trim()} (Source: ${entry.citation ?? entry.path})`,
    )
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
      // Upstream's dedupe, verbatim from `active-memory/trigger-recall.ts:323-330`:
      //
      //   new Map([...triggerCandidates, ...retrieved].map((entry) => [
      //     `${entry.source}:${entry.path}:${String(entry.startLine)}:${String(entry.endLine)}`,
      //     entry,
      //   ])).values()
      //
      // The RANGE is the identity, not the row id. That distinction became load-bearing with
      // the read switch: `chunkId` is a hash over `(source, path, startLine, endLine, text,
      // model)`, so the same range written under two different models is two rows with two ids,
      // and keying on the id would inject the same memory twice. `source` is in the key, so
      // the same bytes under two corpora stay separate -- which is upstream's model, and the
      // reason corpora are separated by the column rather than by precedence.
      const entries = new Map<string, SearchHit>();
      for (const entry of [...triggerCandidates, ...retrieved]) {
        const key = `${entry.source}:${entry.path}:${String(entry.startLine)}:${String(entry.endLine)}`;
        // "the scored retrieval copy of a chunk replaces its unscored trigger candidate",
        // upstream's comment. The scored copy comes second, so it wins.
        if (!entries.has(key) || (entries.get(key)?.triggers ?? null) === null) {
          entries.set(key, entry);
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