// The one place the plugin asks a model to think.
//
// WHY THIS FILE
//   mem-plus is shedding its local GGUF inference path: the content model moves to the
//   user's own OpenCode model, which is `ctx.generate.text`. Three call sites need it --
//   capture extraction, promotion consolidation, dreaming narrative -- and each wants the
//   same three things OpenCode's call does not give them: a system prompt, a timeout, and
//   failure that degrades instead of throwing. That is this wrapper.
//
// WHAT UPSTREAM DOES INSTEAD
//   openclaw runs these through `conversationRecall` / `api.runtime.agent`, i.e. its own
//   agent runtime, which resolves a model from the agent's config. On OpenCode the resolved
//   model *is* whatever the user configured, so `ctx.generate.text` with no `model` argument
//   is the same decision made one layer up. Passing `model` pins it, which is what
//   `model.hostedModel` did before.
//
// THE ONE REAL LIMITATION
//   `ctx.generate.text` takes a single `prompt` and has no system parameter, so the system
//   prompt is folded in ahead of the body. That is not a workaround invented here -- it is
//   what `hostedComplete` already did, and the capture prompts are written for it
//   (`buildBoundedSummaryPrompt` emits the body only precisely because of this).
//
// WHEN THE HOST REFUSES
//   One failure is not like the others: the free-tier gate refuses the request shape
//   itself (last confirmed 2026-10-16), which every plugin call hits no matter what it
//   asks for. That refusal -- and only that one -- is retried once at the wire level;
//   see `wire.ts`. Everything else keeps the degrade-as-data behavior below.
import type { PluginContext } from "./opencode.js";
// The canonical shape, read from `config.jsonc`'s `model.hostedModel` and already the
// argument `ctx.generate.text` takes. Redefining it here would be a second source of truth
// for the same field.
import type { HostedModelRef } from "./model/config.js";
// The retry path for the one host failure that means "wrong request shape", not "wrong
// request". See the header of `wire.ts` for what it does and when it is reached.
import { isFreeTierRejection, wireText } from "./wire.js";

export type { HostedModelRef };

/** What a caller gets back: the text, or null when the model could not be reached. */
export type LlmResult = { readonly text: string } | { readonly text: null; readonly reason: string };

export type LlmRequest = {
  /** Instructions. Folded ahead of `prompt` because the host has no system channel. */
  readonly systemPrompt?: string;
  readonly prompt: string;
  /** Pins the model; omitted means "OpenCode's own default". */
  readonly model?: HostedModelRef;
  /** Give up after this long. Recall and dreaming run inside a hook deadline. */
  readonly timeoutMs?: number;
  /** For the log line: what this call was for. */
  readonly purpose: string;
  readonly signal?: AbortSignal;
};

/**
 * One model call through OpenCode. Never throws.
 *
 * Every caller here is on a path where a failure must cost recall, not the turn: capture
 * falls back to leaving its record pending, dreaming skips its narrative, promotion skips
 * consolidation. A rejected promise in those places surfaces as an opaque fault instead.
 */
export async function completeThroughHost(
  ctx: PluginContext,
  request: LlmRequest,
  log: (message: string, detail?: unknown) => void,
): Promise<LlmResult> {
  const started = Date.now();
  const prompt = request.systemPrompt
    ? `${request.systemPrompt}\n\n${request.prompt}`
    : request.prompt;
  try {
    // `ctx.generate.text` takes no signal, so the timeout races the call rather than
    // aborting it. An abandoned call still costs the provider the tokens; what the timeout
    // buys is that the hook's own deadline is not blown while we wait.
    const call = ctx.generate.text({
      prompt,
      ...(request.model ? { model: request.model } : {}),
    });
    const result = request.timeoutMs
      ? await Promise.race([
          call,
          new Promise<never>((_, reject) => {
            const timer = setTimeout(
              () => reject(new Error(`timed out after ${String(request.timeoutMs)}ms`)),
              request.timeoutMs,
            );
            // Do not hold the event loop open for a timer nobody is waiting on any more.
            (timer as unknown as { unref?: () => void }).unref?.();
          }),
        ])
      : await call;
    log(`llm ${request.purpose}: ok in ${String(Date.now() - started)}ms`);
    return { text: result.text };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    // The free-tier gate refuses the shape `ctx.generate.text` sends; retry once at the
    // wire level before giving up. When the host path recovers, this branch stops being
    // reached and the log line loses its suffix.
    if (isFreeTierRejection(error)) {
      try {
        const text = await wireText({
          ctx,
          prompt,
          ...(request.model ? { ref: request.model } : {}),
          ...(request.timeoutMs ? { timeoutMs: request.timeoutMs } : {}),
          ...(request.signal ? { signal: request.signal } : {}),
        });
        log(`llm ${request.purpose}: ok in ${String(Date.now() - started)}ms (wire fallback)`);
        return { text };
      } catch (fallbackError) {
        const fallbackReason =
          fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
        log(
          `llm ${request.purpose}: failed after ${String(Date.now() - started)}ms -- ${reason} (wire fallback: ${fallbackReason})`,
        );
        return { text: null, reason };
      }
    }
    log(`llm ${request.purpose}: failed after ${String(Date.now() - started)}ms -- ${reason}`);
    return { text: null, reason };
  }
}
