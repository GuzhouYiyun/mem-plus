// The daily dreaming sweep and the promotion round behind it: mem-plus's
// once-a-day digest of the whole memory home (capture -> short term -> MEMORY.md
// and DREAMS.md), plus the self-generated rehearsal pass in between.
//
// Extracted from `index.ts` (structure pass, 2026-11-17); bodies moved verbatim.
// Three binding renames the extraction forces: `modelConfig.hostedModel` arrives
// as the `hostedModel` param, the setup-local `indexReplaced` as
// `indexMemoryFile`, and the setup-local `DEFAULT_MEMORY_FILENAME` as the
// canonical `MEMORY_FILE_NAME` from `paths.ts` (same value, "MEMORY.md").
//
// Why one file: the marker claim, the sweep, the rehearsal and the promotion
// round are one sequential pass behind one once-a-day gate -- splitting them
// would restate the shared `subagent`, `now`, `ctx` and `log` in each piece.

import path from "node:path";
import { runDreamingSweepPhases } from "../../extensions/memory-core/src/dreaming-phases.js";
import { formatMemoryDreamingDay } from "../../extensions/memory-core/src/capture/day.js";
import { completeThroughHost, type HostedModelRef } from "./llm.js";
import { withMemoryFileLock } from "./memory-file-lock.js";
import { runPromotionRound } from "./promotion.js";
import { runSelfGeneratedRehearsalRound } from "./rehearsal.js";
import { applySemanticRewardGate } from "./semantic-reward.js";
import { dreamingMarker, memoryHomeDir, MEMORY_FILE_NAME } from "./paths.js";
import type { PluginContext } from "./opencode.js";

export type DreamingRunDeps = {
  readonly ctx: PluginContext;
  readonly options: unknown;
  /** `modelConfig.hostedModel` from index.ts: pin consolidation/dreaming to it. */
  readonly hostedModel?: HostedModelRef;
  readonly log: (message: string, detail?: unknown) => void;
  /**
   * The setup-local `indexReplaced` from index.ts. Promotion rewrites MEMORY.md
   * in place and nothing else re-indexes it, so the round calls this through
   * the same path as every other full-file write (`autoEmbed` included).
   */
  readonly indexMemoryFile: (
    files: readonly string[],
    options?: { readonly autoEmbed?: boolean },
  ) => Promise<void>;
};

export function createDreamingRun(deps: DreamingRunDeps): () => Promise<void> {
  const { ctx, options, hostedModel, log, indexMemoryFile } = deps;
  /**
   * Daily dreaming sweep, gated to once per calendar day. openclaw schedules this
   * with its own cron daemon (`dreaming-cron.ts`); mem-plus has no cron host, so
   * the equivalent trigger is the first settled turn of a new day.
   *
   * The sweep is global: it runs over the whole memory home (every project's
   * captures, the one MEMORY.md and DREAMS.md), exactly openclaw's one-agent
   * one-home model. So the marker is one for the whole home -- any window that
   * settles first on a new day runs the sweep, and the marker keeps the other
   * windows out. The marker file is the only state: a day boundary means "run
   * once", and writing the marker before waiting means a crash mid-sweep
   * re-runs at most once.
   */
  const maybeRunDreaming = async (): Promise<void> => {
    try {
      const now = Date.now();
      const today = formatMemoryDreamingDay(now);
      const marker = dreamingMarker();
      // 2026-11-08：领取代次必须原子。原先是"读 marker → 写 marker"，两个
      // 窗口同时跨过日界时都读到昨天，于是各跑一遍 sweep、各写一篇日记
      // （DREAMS.md 里同一天两篇的成因）。现在读与写都在同一个文件锁里，
      // 只有一个窗口能把 marker 从昨天改成今天，另一个直接返回。锁只罩住
      // "读 + 改"，不罩 sweep 本身：sweep 要调模型，可达分钟级，占锁会挡住
      // 另一个窗口的正常写入。中途崩溃仍按原语义"当天不再重试"。
      const { mkdir } = await import("node:fs/promises");
      await mkdir(path.dirname(marker), { recursive: true });
      const claimed = await withMemoryFileLock(marker, async () => {
        const fs = await import("node:fs/promises");
        let last = "";
        try {
          last = (await fs.readFile(marker, "utf8")).trim();
        } catch {
          // First run: no marker yet, treat as a new day.
        }
        if (last === today) return false;
        // Record the attempt first so a failed sweep does not retrigger every turn.
        await fs.writeFile(marker, today, "utf8");
        return true;
      });
      if (!claimed) return;

      // STAGE 2: consolidation's model call also moves to the user's OpenCode model, so
      // it no longer waits on `localService.ready()` -- a promotion round used to be
      // skipped entirely whenever the local model was down, even though a model was
      // available. `completeThroughHost` never throws, so a failure here is turned back
      // into a rejection: upstream's `applyShortTermPromotions` catches a consolidation
      // failure and degrades, and it can only do that if something throws.
      const subagent = {
        complete: async ({
          message,
          extraSystemPrompt,
        }: {
          message: string;
          extraSystemPrompt?: string;
        }) => {
          const result = await completeThroughHost(
            ctx,
            {
              purpose: "promotion consolidation",
              prompt: message,
              ...(extraSystemPrompt ? { systemPrompt: extraSystemPrompt } : {}),
              ...(hostedModel ? { model: hostedModel } : {}),
            },
            log,
          );
          if (result.text === null) throw new Error(result.reason);
          return { text: result.text };
        },
      };
      // light -> REM -> deep, in that order, inside one trigger. Upstream's
      // `runShortTermDreamingPromotion` runs `runDreamingSweepPhases` at
      // `dreaming.ts:166` and only ranks/applies at `:195`/`:221`, so deep is
      // strictly last and reads the same `sweepNowMs`. A sweep that throws hits
      // `continue` at `dreaming.ts:183` and skips deep for that workspace; the
      // catch below reproduces that, since the home is a single workspace.
      //
      // This used to run promotion first, on the claim that deep's output feeds
      // the sweep. Upstream has no such dependency -- nothing light or REM do
      // reaches MEMORY.md -- so the old order was a local invention that
      // inverted the phases. `docs/memory-chain.md` §3 had it right all along.
      const result = await runDreamingSweepPhases({
        agentId: "main",
        workspaceDir: memoryHomeDir(),
        pluginConfig: {
          dreaming: {
            enabled: true,
            storage: { mode: "inline", separateReports: false },
          },
        },
        logger: {
          info: (msg: string) => log(`dreaming: ${msg}`),
          warn: (msg: string) => log(`dreaming: ${msg}`),
          error: (msg: string) => log(`dreaming: ${msg}`),
        },
        subagent,
        nowMs: now,
      } as unknown as Parameters<typeof runDreamingSweepPhases>[0]);
      log(
        // light+REM is what this sweep runs; deep is the promotion round below,
        // not a third phase here.
        `dreaming sweep done: light+rem over ${memoryHomeDir()} ` +
          `(degradedPhases=${result?.degradedPhases ?? 0}, pendingNarratives=${result?.pendingNarratives ?? 0})`,
      );

      // Self-generated rehearsal is a human-review DREAMS.md pass. It stays
      // curated-free: QA pairs are never promoted directly into MEMORY.md.
      const rehearsal = await runSelfGeneratedRehearsalRound({
        ctx,
        memoryHome: memoryHomeDir(),
        ...(hostedModel ? { model: hostedModel } : {}),
        log,
        nowMs: now,
      });
      if (rehearsal.retained > 0) {
        log(
          `dreaming rehearsal: kept ${rehearsal.retained}/${rehearsal.generated} QA pair(s) ` +
            `from ${rehearsal.candidates} candidate(s)`,
        );
      } else if (!rehearsal.skipped) {
        log("dreaming rehearsal: no retained QA pairs");
      } else if (rehearsal.candidates > 0 && rehearsal.reason) {
        log(`dreaming rehearsal skipped: ${rehearsal.reason}`);
      }

      // deep: episodic -> curated. Reached only when the sweep returned, matching
      // upstream's `continue` on sweep failure.
      const promotion = await runPromotionRound({
        memoryHome: memoryHomeDir(),
        options,
        subagent,
        log,
        nowMs: now,
        // Phase 2 item 3: semantic-reward veto between the deterministic gates and
        // the write. Fail-open -- without an answering strong model this reduces to
        // the Phase-1 behaviour exactly (companion-plan §5 decision 2).
        reward: async (candidates) => {
          const gated = await applySemanticRewardGate({
            ctx,
            ...(hostedModel ? { model: hostedModel } : {}),
            candidates,
            log,
          });
          if (!gated.outcome.skipped) {
            log(
              `promotion: semantic reward kept ${String(gated.keep.length)}/${String(gated.outcome.candidates)} ` +
                `candidate(s) (${String(gated.outcome.vetoed)} delayed, ` +
                `${String(gated.outcome.scored)} scored)`,
            );
          } else if (gated.outcome.candidates > 0 && gated.outcome.reason) {
            log(`promotion: semantic reward skipped: ${gated.outcome.reason}`);
          }
          return gated.keep;
        },
      });
      if (promotion && promotion.applied > 0) {
        log(
          `promotion: applied ${promotion.applied}/${promotion.candidates} candidate(s) ` +
            `into MEMORY.md (${promotion.rejected} rejected)`,
        );
        // Promotion rewrites MEMORY.md in place, and nothing re-indexed it: the
        // file is only discovered by a full scan, so lane 1c
        // (`listTriggerCandidates`) and `memory_search` kept serving the
        // pre-promotion text until the next `memory_reindex`. Index it here,
        // through the same path as every other full-file write. This is a
        // once-a-day long-term write, so let the background pass embed it too;
        // per-turn snapshots also embed, but only their missing chunks (see
        // `indexReplaced` in index.ts).
        await indexMemoryFile([path.join(memoryHomeDir(), MEMORY_FILE_NAME)], {
          autoEmbed: true,
        });
      }
    } catch (error) {
      log("dreaming sweep failed", error);
    }
  };
  return maybeRunDreaming;
}
