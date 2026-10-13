// UPSTREAM: `packages/memory-host-sdk/src/host/session-files.ts:453,781,788-794`.
//
// WHAT UPSTREAM ACTUALLY DOES -- EXCLUSION, NOT MARKING
//   Upstream does not mark a recalled turn and later refuse to promote it. It drops the
//   turn from the corpus text entirely. `buildSessionEntryFromSource` recomputes the flag
//   on every user message and then `continue`s past every message while it holds:
//
//     if (message.role === "user") {
//       insideRecalledMemoryTurn = isRecalledMemoryMessage(message);   // :781
//     }
//     if (insideHeartbeatTurn || insideRecalledMemoryTurn || ...) continue;  // :788-794
//
//   Three consequences that matter, all of them deliberate:
//     - The granularity is the WHOLE TURN, not the recalled fragment. The assistant's
//       reply is dropped along with the prompt, because the reply is where a paraphrase
//       of the recall lands and a substring test on the recall alone would miss it.
//     - The triggering user message is dropped too. The flag is set at :781, before the
//       exclusion test, so the very message that caused the recall does not get stored.
//     - It needs no provenance column, no origin class and no promotion gate. Content
//       that is never written cannot be recalled, promoted or replayed, which is why
//       this is a strictly stronger shape than marking and is the one to copy.
//
// WHAT UPSTREAM'S MARKER IS, AND WHY THE MARKER IS MISSING HERE
//   `isRecalledMemoryMessage` reads `message.provenance.kind === "internal_system"` with
//   `sourceTool` of `memory_search` / `memory_get`. That reader has NO producer in the
//   2026.9.9 tree: `InternalTurnSource` is a closed union that cannot hold those tool
//   names (`src/auto-reply/templating.ts:316`) and the only occurrence of the marker is a
//   test fixture, so upstream's guarantee is currently vacuous. Copying the marker would
//   have copied a guard that never fires. The design is what is ported; the producer is
//   the part upstream lost and this file supplies it.
//
//   OpenCode gives a plugin no writable per-message metadata (`ctx.session.message` is
//   GET-only), so there is no `provenance` field to carry the flag either way. The
//   decision is therefore made on the message that STARTS the turn -- the user prompt --
//   which is the same message upstream keys on, and which mem-plus knows the recall
//   verdict for at the moment it runs.
//
// WHY THE KEY IS PROMPT TEXT
//   Upstream's flag rides on the user message. The only property of a mem-plus user
//   message that differs between a tainted turn and a clean one is its text, because
//   whether Lane 2 ran is decided for that prompt and nowhere else. Keying on it keeps
//   upstream's placement (the turn-opening message) and its granularity (the whole turn).
//
//   Two identical prompts in one session share a verdict: if the text triggered recall on
//   one turn it is excluded on both. The error is one-sided. Under-inclusion is the
//   failure this whole file exists to prevent; over-inclusion costs one unstored turn.
//
// STICKINESS AND SCOPE
//   A tainted prompt stays recorded for the life of the session and is never cleared.
//   Upstream's flag resets at the next user message, which is automatic here because the
//   snapshot renderer walks messages in order and recomputes at each one. Clearing on
//   snapshot write would be wrong: the next snapshot re-renders the whole transcript, so
//   a cleared prompt would come back as clean and the earlier turn would be written then.
//   The set is at most one entry per prompt that actually triggered recall.

import { hashText } from "../../packages/memory-host-sdk/src/host/hash.js";

/**
 * sessionID -> digests of the user prompts whose turn had recall injected.
 *
 * Never persisted. Persistence is not wanted: the snapshot is written milliseconds after
 * the turn ends, and a session's taint set is exactly the set of prompts still visible in
 * its own transcript. A restart loses it, which costs the exclusion for turns already
 * snapshotted -- the same window upstream has, since its marker lives on the message and
 * is read while the same messages are being walked.
 */
const taintedPrompts = new Map<string, Set<string>>();

/** Prompt comparison ignores surrounding whitespace only, and nothing else. */
function promptKey(text: string): string {
  return hashText(text.trim());
}

/**
 * Record that Lane 2 injected `recallText` into the turn opened by `prompt`.
 *
 * Called once per prompt that produced a deep-recall block. Upstream excludes recalled
 * *results* from re-ingestion; the trigger and project blocks are not excluded, because
 * upstream ships those as bootstrap/context rather than as assistant-visible text to be
 * re-learned, and the trigger block is a filtered view of curated entries rather than a
 * new claim.
 */
export function noteDeepRecall(sessionID: string, prompt: string, recallText: string): void {
  if (recallText.trim().length === 0) return;
  let keys = taintedPrompts.get(sessionID);
  if (!keys) {
    keys = new Set<string>();
    taintedPrompts.set(sessionID, keys);
  }
  keys.add(promptKey(prompt));
}

/**
 * Upstream's `insideRecalledMemoryTurn`, for the turn that `prompt` opens.
 *
 * `prompt` is the text of a user message as it appears in the transcript being rendered.
 */
export function isRecalledMemoryTurn(sessionID: string, prompt: string): boolean {
  return taintedPrompts.get(sessionID)?.has(promptKey(prompt)) === true;
}

/**
 * Upstream's `buildSessionEntryFromSource` exclusion test, over one transcript.
 *
 * Returns every message that survives: an entire turn is withheld when its opening user
 * message was one that triggered recall, and the next user message reopens the export.
 * Tool calls are excluded with the rest of their turn, matching upstream, which tests the
 * flag before it collects any message content.
 */
export function excludeRecalledMemoryTurns<T>(
  sessionID: string,
  messages: readonly T[],
  promptOf: (message: T) => string | undefined,
): T[] {
  const kept: T[] = [];
  let insideRecalledMemoryTurn = false;
  for (const message of messages) {
    const prompt = promptOf(message);
    if (prompt !== undefined) {
      insideRecalledMemoryTurn = isRecalledMemoryTurn(sessionID, prompt);
    }
    if (insideRecalledMemoryTurn) continue;
    kept.push(message);
  }
  return kept;
}

/** For dispose, and for a session id that OpenCode will not hand back. */
export function clearAllTurnTaints(sessionID?: string): void {
  if (sessionID === undefined) taintedPrompts.clear();
  else taintedPrompts.delete(sessionID);
}
