// Episodic -> curated: the short-term promotion round.
//
// UPSTREAM: `extensions/memory-core/src/dreaming.ts` calls `rankShortTermPromotionCandidates`
// and then `applyShortTermPromotions` inside its sweep, and both functions are vendored here
// unchanged. What was missing was the call site -- mem-plus ran the light/REM/deep dreaming
// phases but never promoted anything, so `MEMORY.md` was never written, no entry ever
// carried `<!-- trigger: -->` or `<!-- importance: -->`, and lane-one recall had an empty
// curated tier to draw from. This file is that call site, ported.
//
// THRESHOLDS COME FROM CONFIG, LIKE UPSTREAM
//   Upstream forwards `params.config.*` into both calls. Omitting them would yield the
//   same numbers (both functions fall back to `DEFAULT_PROMOTION_MIN_*`) while deleting
//   the knobs, and 0.75 is unreachable for a small corpus. The values are read by
//   `readPromotionConfig`; only the defaults live in openclaw.
import { applyShortTermPromotions } from "../../extensions/memory-core/src/short-term-promotion-apply.js";
import { rankShortTermPromotionCandidates } from "../../extensions/memory-core/src/short-term-promotion.js";
import { recordShortTermRecalls } from "../../extensions/memory-core/src/short-term-promotion-record.js";
import type { DreamingCompletion } from "../../extensions/memory-core/src/dreaming-narrative.js";
import type { MemorySearchResult } from "../../packages/memory-host-sdk/src/host/types.js";
import { readPromotionConfig } from "./promotion-config.js";

export type PromotionRound = {
  readonly candidates: number;
  readonly applied: number;
  readonly rejected: number;
};

/**
 * One promotion round: rank the recalled episodic entries, then write the winners into
 * `MEMORY.md`. Never throws -- a failed promotion must not take the dreaming sweep, or the
 * session, down with it.
 *
 * ORDERING: called before the dreaming sweep, so the deep consolidation phase sees what
 * this round promoted. Upstream runs both inside one sweep; splitting them leaves
 * mem-plus's existing sweep call untouched.
 */
export async function runPromotionRound(params: {
  memoryHome: string;
  options?: unknown;
  subagent?: DreamingCompletion;
  log: (message: string, detail?: unknown) => void;
  nowMs?: number;
}): Promise<PromotionRound | null> {
  const config = readPromotionConfig(params.options);
  if (!config.enabled) return null;
  try {
    const thresholds = {
      limit: config.limit,
      minScore: config.minScore,
      minRecallCount: config.minRecallCount,
      minUniqueQueries: config.minUniqueQueries,
      maxAgeDays: config.maxAgeDays,
    };
    const candidates = await rankShortTermPromotionCandidates({
      workspaceDir: params.memoryHome,
      ...thresholds,
      ...(params.nowMs === undefined ? {} : { nowMs: params.nowMs }),
    });
    if (candidates.length === 0) {
      return { candidates: 0, applied: 0, rejected: 0 };
    }
    const applied = await applyShortTermPromotions({
      // Upstream's call site passes both; they scope the promotion to the agent whose
      // workspace the entries came from.
      agentId: "main",
      workspaceAgentIds: ["main"],
      workspaceDir: params.memoryHome,
      candidates,
      ...thresholds,
      ...(params.nowMs === undefined ? {} : { nowMs: params.nowMs }),
      consolidation: {
        ...(params.subagent ? { subagent: params.subagent } : {}),
        logger: {
          info: (message: string) => params.log(`promotion: ${message}`),
          warn: (message: string) => params.log(`promotion: ${message}`),
        },
      },
    });
    return {
      candidates: candidates.length,
      applied: applied.applied,
      rejected: applied.rejectedCandidates.length,
    };
  } catch (error) {
    params.log("promotion round failed", error);
    return null;
  }
}

/**
 * openclaw's recall tracking: a retrieval is the input the promotion ranking scores.
 *
 * Upstream records it from the memory tools' execution path (`tools.recall-tracking.ts`).
 * Without it the promotion store stays empty no matter how much is retrieved, which is why
 * this is part of the same port rather than an optimisation: `minRecallCount` and
 * `minUniqueQueries` are both counted from these records.
 *
 * `dedupeByQueryPerDay` matches upstream's tool-path call, so repeated searches for the
 * same words on the same day strengthen one signal rather than many.
 */
export async function recordRetrievalRecalls(params: {
  memoryHome: string;
  query: string;
  results: readonly MemorySearchResult[];
  nowMs?: number;
}): Promise<void> {
  if (params.results.length === 0) return;
  try {
    await recordShortTermRecalls({
      workspaceDir: params.memoryHome,
      query: params.query,
      results: [...params.results],
      signalType: "recall",
      dedupeByQueryPerDay: true,
      ...(params.nowMs === undefined ? {} : { nowMs: params.nowMs }),
    });
  } catch (error) {
    // Recall tracking is an input to tomorrow's ranking; failing to note one retrieval
    // must not fail the retrieval the model is waiting on.
  }
}
