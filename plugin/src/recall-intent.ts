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

/**
 * A short translation is cheap; cap it well below the recall tool loop's budget.
 *
 * Raised from 3 000 ms on 2026-10-15. The original value was a guess, and the measured
 * distribution says it was wrong: over the eight Han-character turns in the live log, five
 * succeeded at 1951 / 2047 / 2173 / 2228 / 2267 ms and three hit the ceiling at 3003 /
 * 3003 / 3004 ms -- a 38% failure rate, with every success bunched just under the limit.
 * A timeout here does not announce itself: the original text is used, `hasRecallIntent` sees
 * a Chinese sentence, upstream's own zh-Hans group matches 4 of 13, and the turn silently
 * recalls as badly as openclaw instead of as well as this module makes it possible.
 *
 * 8 s is chosen against the observed latency, not against a round number: the slowest success
 * was 2.3 s, and the failures are all "exceeded 3 s" with no recorded tail, so this buys
 * headroom without letting one slow provider stall a turn unboundedly. For scale, a capture
 * extraction on this machine took 43.8 s -- the host model's latency is not small, and a
 * translation of one sentence should not be the tightest budget in the chain.
 *
 * Not an upstream divergence: `plugin/src/recall-intent.ts` has no upstream counterpart at
 * any ref (`scripts/audit-upstream-drift.mjs --scope recall-intent` reports
 * "NO upstream counterpart: 1"), so this constant is this tree's own. The divergence already
 * registered in `docs/port-plan.md` §5 is the localisation step itself.
 */
const LOCALIZE_TIMEOUT_MS = 8_000;

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
  "Output the translation and nothing else: no preamble, no quotes, no explanation, no notes.",
  // Scope, as distinct from format above: nothing may appear that the user's own message
  // did not contain. The failure this prevents is not a mistranslation -- it is the model
  // answering the question it was handed, or asking one back, which turns the gate's input
  // into prose the English recall patterns were never written for. "As written rather than
  // resolving them" is the operative half: an ambiguous fragment is translated literally
  // instead of being interpreted.
  "Add nothing that is not in the user's message. Do not answer it, comment on it, or ask about it -- translate unclear or ambiguous parts as written rather than resolving them.",
  // Spelled out as a mapping rather than "use English punctuation": the model already knows
  // what English punctuation is, and what it does not do without being told is the mechanical
  // conversion of a string it is copying character by character. Left unconverted, the reply
  // trips the runtime guard below and the whole localisation is thrown away -- the turn falls
  // back to the Chinese original and recalls as badly as openclaw.
  "Convert Chinese punctuation to its English equivalent: ？→ ?, 。→ ., ，→ ,, 、→ ,, ；→ ;, ：→ :, 「」→ \"\", （）→ (), and full-width spaces → ordinary spaces.",
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
  //
  // The punctuation half used to test `[。？！，、]` -- five characters -- while the prompt
  // asks for the whole class converted. Everything the old test missed therefore passed
  // straight into the gate with Chinese punctuation intact: ；(U+FF1B), ：(U+FF1A),
  // 「」(U+300C/300D), （）(U+FF08/FF09), and the ideographic space (U+3000). A reply like
  // 「How did we decide on the vector model?」 is a plausible English translation that would
  // have been accepted, and quoted brackets are not what the 14 English patterns were written
  // against. The range below is CJK symbols and punctuation (U+3000-303F) plus the fullwidth
  // forms (U+FF01-FF65, which also catches fullwidth Latin and digits -- a reply containing
  // those is not English either).
  //
  // Em dash (U+2014) and ellipsis (U+2026) are deliberately NOT rejected: both are ordinary
  // English typography, and there is no reason to throw a translation away over them.
  if (translated.length < 2 || /[\u3000-\u303F\uFF01-\uFF65]/u.test(translated)) {
    params.log("recall localisation: reply is not a translation, using the original text");
    return { text: original, localised: false };
  }

  params.log(`recall localisation: "${original}" -> "${translated}"`);
  return { text: translated, localised: true };
}