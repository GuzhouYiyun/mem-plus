// Localising a message for openclaw's own recall gate.
//
// WHY THIS EXISTS
//
//   Upstream decides whether a turn deserves deep recall with `hasRecallIntent`
//   (`extensions/active-memory/escalation.ts`): fourteen English regexes plus six
//   localized groups. Measured 2026-10-11 on thirteen ordinary recall questions:
//   the English patterns match 13/13, the zh-Hans group matches 4/13. Its lookahead
//   requires the recall verb to be immediately followed by 过 or 了, so it only fires
//   when the verb phrase ENDS there -- "上次我们决定了什么？" matches, "我们之前讨论过
//   向量模型吗？" does not, because the character after 过 begins the object.
//   The user's own questions ("我最开始想做什么东西？", "一开始你打算做的是什么？") miss
//   both upstream and a hand-widened Chinese table.
//
//   The English patterns are the good ones. So rather than rewrite the decision -- which
//   would fork upstream's logic and need its own tuning forever -- this translates the
//   message and hands the SAME function the text it was written for. `hasRecallIntent`
//   stays byte-identical to upstream; the only addition is one step in front of it.
//
// WHAT IT IS NOT
//
//   Not a classifier, and not a rewrite. An earlier version of this file asked the model
//   to decide DEMAND/NO_DEMAND and to rewrite the query. That was dropped: it forked
//   upstream's decision logic, scored 11/13 (missing the exact sentences above), and
//   never ran on the messages it was built for, because the regex gate in front of it
//   returned `no-recall-intent` first. Translation covers more and diverges less.
//
// FAILURE
//
//   Translation is best-effort. If the call fails, times out, or comes back empty, the
//   ORIGINAL text is used, so behaviour degrades to exactly upstream's -- never worse.

import { completeThroughHost } from "./llm.js";
import type { HostedModelRef } from "./model/config.js";
import type { PluginContext } from "./opencode.js";

/** A short translation is cheap; cap it well below the recall tool loop's budget. */
const LOCALIZE_TIMEOUT_MS = 3_000;

/**
 * Scripts that need no help to reach the English patterns. Anything with Han, Kana or
 * Hangul goes through the model; Latin, Cyrillic and Arabic are already covered by
 * upstream's own patterns and are passed through untouched so no turn pays for a
 * translation it does not need.
 */
const NEEDS_LOCALISATION = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

export function needsLocalisation(message: string): boolean {
  return NEEDS_LOCALISATION.test(message);
}

const SYSTEM_PROMPT = [
  "Translate the user's message into English.",
  "Output ONLY the translation -- no preamble, no quotes, no explanation, no notes.",
  "Keep file names, paths, identifiers, error text, flags and commands exactly as written.",
  "Keep the question mark. If the message is a request or a command rather than a question, translate it as such.",
].join("\n");

export type LocalisedMessage = {
  /** What the gate and the search should read. The translation, or the original. */
  readonly text: string;
  /** True only when a translation actually happened and succeeded. */
  readonly localised: boolean;
};

/**
 * Translate `message` into English when it is in a script upstream's English patterns
 * expect. Never throws: a failed translation yields the original text, so the caller's
 * gate behaves exactly as it did before this module existed.
 */
export async function localiseForRecall(params: {
  ctx: PluginContext;
  message: string;
  model?: HostedModelRef;
  log: (message: string, detail?: unknown) => void;
}): Promise<LocalisedMessage> {
  const original = params.message.trim();
  if (original.length === 0 || !needsLocalisation(original)) {
    return { text: original, localised: false };
  }

  const result = await completeThroughHost(
    params.ctx,
    {
      purpose: "recall message localisation",
      prompt: original,
      systemPrompt: SYSTEM_PROMPT,
      timeoutMs: LOCALIZE_TIMEOUT_MS,
      ...(params.model ? { model: params.model } : {}),
    },
    params.log,
  );

  if (result.text === null) {
    params.log("recall localisation: unavailable, using the original text");
    return { text: original, localised: false };
  }

  const translated = result.text.trim();
  // A refusal, an apology preamble or a copied-back echo means we got prose, not a
  // translation. The one-character case is almost always a stray quote or newline.
  if (translated.length < 2 || /[。？！，、]/.test(translated)) {
    params.log("recall localisation: reply is not a translation, using the original text");
    return { text: original, localised: false };
  }

  params.log(`recall localisation: "${original}" -> "${translated}"`);
  return { text: translated, localised: true };
}