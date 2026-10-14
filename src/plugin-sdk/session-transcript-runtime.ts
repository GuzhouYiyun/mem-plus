// The one type Lane 2 needs from openclaw's session-transcript runtime, and nothing else.
//
// WHY THIS FILE IS NOT UPSTREAM'S MODULE
//   Upstream's `src/plugin-sdk/session-transcript-runtime.ts` re-exports the session
//   transcript *functions* -- `readSessionTranscriptEvents`, `readSessionTranscriptRawDelta`
//   and friends -- which resolve into `src/config/sessions/**`,
//   `src/gateway/session-transcript-catalog`, `src/agents/sessions-yield-context` and
//   `src/routing/session-key`. Half of those were removed by the trim, so the module cannot
//   be shipped: measured against the 2026-09-30 snapshot, 8 of its 16 relative specifiers
//   resolve to nothing (`../agents/sessions-yield-context`, `../config/types.openclaw`,
//   `../gateway/session-catalog-identity`, `../gateway/session-transcript-catalog`,
//   `../media/prompt-image-input`, `./agent-core`, `./session-transcript-lock-runtime`,
//   `./session-transcript-memory-hit`), and `audit-npm-pack --check` rightly refuses to call
//   that a packageable closure. An earlier version of this comment said "seven"; it is eight.
//
// WHAT IS ACTUALLY NEEDED
//   One type. `extensions/active-memory/types.ts:224` aliases
//   `ActiveMemoryTranscriptSource` to it, and that alias is what upstream's
//   `transcript-result.ts` types its transcript readers with.
//
//   Nothing in mem-plus consumes it: the transcript upstream's readers would return is the
//   recall sub-agent's own transcript, and mem-plus has no sub-agent session -- its recall
//   runs on `ctx.generate.text` inside this process (see `plugin/src/deep-recall.ts`). The
//   type is here so upstream's file compiles unmodified, not because anything reads a
//   transcript through it.
//
//   The field list is openclaw's own (`SessionTranscriptReadParams` in
//   `src/plugin-sdk/session-transcript-memory-hit.ts`), reproduced so a future port that
//   does need the runtime has the shape to match.
export type SessionTranscriptTargetParams = {
  agentId?: string;
  env?: Record<string, string | undefined>;
  hydrateSkillPromptRefs?: boolean;
  sessionId: string;
  sessionKey: string;
  storePath?: string;
  threadId?: string;
};

/** Upstream's name for the same shape, kept so either spelling resolves. */
export type SessionTranscriptReadParams = SessionTranscriptTargetParams;