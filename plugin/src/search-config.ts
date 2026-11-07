// Search policy: the knobs Phase 3 exposes for lane-1b ranking.
//
// WHY A TOP-LEVEL SECTION
//   Same reason `promotion` is one: `mergeOptions` in `config-file.ts` merges one
//   level deep, so a nested key under a shared object would be replaced wholesale by
//   a partial user config. A top-level `search` object merges per leaf.
//
// WHY THESE TWO KNOBS
//   `halfLifeDays` parametrizes the temporal decay openclaw hardcodes at 30 days
//   (`memory-search.ts:122`, mirrored in `memory-index.ts` `RANKING`). Companion
//   memory horizons are a matter of taste; the plan asked for it configurable
//   (companion-plan §3 Phase 3 item 2).
//   `timeExpansion` gates the deterministic time-window parser (`time-window.ts`).
//   It costs no model call, so unlike LongMemEval-style model expansion it carries
//   no weak-model caveat; it exists as a switch only so the old behaviour stays
//   reachable.
export type SearchConfig = {
  /** Temporal-decay half-life in days. openclaw's own default is 30. */
  readonly halfLifeDays: number;
  /** Derive a since/until window from temporal phrases in the query. Default on. */
  readonly timeExpansion: boolean;
};

const DEFAULT_HALF_LIFE_DAYS = 30;

function num(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function readSearchConfig(options: unknown): SearchConfig {
  const root =
    typeof options === "object" && options !== null ? (options as Record<string, unknown>) : {};
  const section =
    typeof root["search"] === "object" && root["search"] !== null
      ? (root["search"] as Record<string, unknown>)
      : {};
  const halfLifeDays = num(section["halfLifeDays"], DEFAULT_HALF_LIFE_DAYS);
  return {
    // A non-positive half-life would divide by zero in the decay exponent; the
    // upstream constant's own domain is positive days.
    halfLifeDays: halfLifeDays > 0 ? halfLifeDays : DEFAULT_HALF_LIFE_DAYS,
    timeExpansion: section["timeExpansion"] !== false,
  };
}
