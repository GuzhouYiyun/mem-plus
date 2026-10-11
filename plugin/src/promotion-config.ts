// Promotion policy: the thresholds openclaw's dreaming sweep forwards into the
// short-term promotion round.
//
// WHY THIS IS A READER AND NOT A CONSTANT
//   Upstream's call site (`extensions/memory-core/src/dreaming.ts`) passes
//   `params.config.minScore`, `.limit`, `.minRecallCount`, `.minUniqueQueries`,
//   `.maxAgeDays` and `.recencyHalfLifeDays` -- config, not literals. Omitting them
//   would produce the same *numbers* (both ranking functions fall back to
//   `DEFAULT_PROMOTION_MIN_*`) while deleting the knobs, and 0.75 is unreachable for a
//   small corpus.
//
// WHY IT IS A TOP-LEVEL SECTION
//   `mergeOptions` in `config-file.ts` merges exactly one level deep inside nested
//   objects, so a nested `dreaming.promotion` block would be replaced wholesale by a
//   partial one -- the silent field-dropping that merge depth exists to prevent. A
//   top-level `promotion` object gets per-leaf merging, like `model` and `web`.
//
// WHERE THE DEFAULTS COME FROM
//   The thresholds are imported from openclaw's own module rather than restated, so
//   there is one definition of each.
import {
  DEFAULT_MEMORY_DEEP_DREAMING_MIN_RECALL_COUNT,
  DEFAULT_MEMORY_DEEP_DREAMING_MIN_SCORE,
  DEFAULT_MEMORY_DEEP_DREAMING_MIN_UNIQUE_QUERIES,
} from "openclaw/plugin-sdk/memory-core-host-status";

/** What `rankShortTermPromotionCandidates` uses when `limit` is not finite: every candidate. */
const UNLIMITED = Number.POSITIVE_INFINITY;
/** `-1` is upstream's "no age limit" sentinel (`toFiniteNonNegativeInt(options.maxAgeDays, -1)`). */
const NO_AGE_LIMIT = -1;

/**
 * Which recalled episodic entries may enter `MEMORY.md`, and how many. These are the knobs
 * upstream forwards to `rankShortTermPromotionCandidates` and `applyShortTermPromotions`.
 */
export type PromotionConfig = {
  readonly enabled: boolean;
  /** Composite score a candidate must reach. openclaw's default is 0.75. */
  readonly minScore: number;
  /** How many times an entry must have been recalled. openclaw's default is 3. */
  readonly minRecallCount: number;
  /** How many distinct queries must have surfaced it. */
  readonly minUniqueQueries: number;
  /** Most promotions per round. Upstream's own default is "no limit". */
  readonly limit: number;
  /** Ignore entries older than this many days. Upstream's own default is unbounded. */
  readonly maxAgeDays: number;
};

function num(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** Permissive read: `ctx.options` is untyped JSON, exactly as for every other section. */
export function readPromotionConfig(options: unknown): PromotionConfig {
  const root =
    typeof options === "object" && options !== null ? (options as Record<string, unknown>) : {};
  const section =
    typeof root["promotion"] === "object" && root["promotion"] !== null
      ? (root["promotion"] as Record<string, unknown>)
      : {};

  return {
    enabled: section["enabled"] !== false,
    minScore: num(section["minScore"], DEFAULT_MEMORY_DEEP_DREAMING_MIN_SCORE),
    minRecallCount: num(section["minRecallCount"], DEFAULT_MEMORY_DEEP_DREAMING_MIN_RECALL_COUNT),
    minUniqueQueries: num(
      section["minUniqueQueries"],
      DEFAULT_MEMORY_DEEP_DREAMING_MIN_UNIQUE_QUERIES,
    ),
    limit: num(section["limit"], UNLIMITED),
    maxAgeDays: num(section["maxAgeDays"], NO_AGE_LIMIT),
  };
}