// Keeping the index in step with files nobody told us about.
//
// UPSTREAM: openclaw's memory manager runs one indexing timer that both reacts to
// watcher events and, every five minutes, "checks for missed file and transcript
// events" -- the recovery pass. It runs even during an active turn and keeps the
// published index available to searches, and a missed native event can therefore
// take that long to be detected.
//
// WHY MEM-PLUS NEEDS IT MORE THAN UPSTREAM DOES
//   mem-plus has no watcher at all. The write path names the documents it wrote
//   (`indexReplaced` / `indexAppended` -> `scheduleAutoEmbed`, index.ts), so
//   anything written by anything else stayed invisible to search until someone ran
//   `memory_reindex`: a hand edit of `MEMORY.md`, a daily file touched in an
//   editor, a wiki page. The failure is silent in the worst direction -- the old
//   text keeps being returned and the new text is simply absent.
//
//   openclaw's chokidar covers those cases live; this pass is the substitute, at
//   upstream's own cadence. It is also why the interval is not configurable here:
//   `resolveSyncConfig` (`src/agents/memory-search.ts:280-294`) returns hardcoded
//   constants and reads no config, and `memory.search.sync.watchDebounceMs` only
//   survives in doctor's retired-path list.
//
// WHAT ONE PASS COSTS WHEN NOTHING CHANGED
//   `reindexFiles` skips a source whose bytes, mtime, provenance class and model
//   all match (`unchangedSources`, memory-scan.ts), so an unchanged tree costs one
//   SQL aggregate plus one `stat` per file and no read. The live home holds a few
//   dozen documents.
//
// Chain: docs/memory-chain.md §2 (chunk identity: the skip key is bytes + mtime +
// model, and an unchanged chunk keeps its vector) and §5 (the vector lane, which
// only sees chunks embedded under the current model).
import type { DatabaseSync } from "node:sqlite";
import { memoryHomeDir } from "./paths.js";
import { discoverHomeFiles, discoverWikiFiles, reindexFiles } from "./memory-scan.js";
import { pruneIndexRetention, INDEX_RETENTION_MAX_CHUNKS } from "./memory-index.js";
import { readWikiConfig } from "./wiki/config.js";

/** Upstream's recovery interval: the indexing timer re-checks sources every 5 min. */
const RECONCILE_INTERVAL_MS = 5 * 60_000;

export type IndexReconcileOptions = {
  db: DatabaseSync;
  /**
   * The embedding model for re-chunked home rows, the same string the embed and
   * search passes use. Omitted means `fts-only`, which is what `runReindex` does
   * for a keyword-only install.
   */
  model?: string;
  /** Merged plugin options, read for `wiki.enabled` / `wiki.dir` exactly as `runReindex` does. */
  options: unknown;
  log: (message: string, detail?: unknown) => void;
  /**
   * False when the vector lane is off. The pass then only syncs the index and
   * never asks about the service, so a keyword-only install pays nothing.
   */
  vectorsEnabled: boolean;
  /** Chunks still without a vector under `model`. One COUNT; read per pass. */
  missingVectors: () => number;
  /**
   * Whether a service is already up, WITHOUT starting one. This is the gate that
   * keeps the timer from spawning a multi-GB model: `embedMissing` reaches the
   * service through `call()` -> `ensureConnected()` -> `connect()`, and `connect()`
   * autostarts when nothing is listening.
   */
  serviceUp: () => Promise<boolean>;
  /** Queue a background embed pass over the whole index. */
  scheduleEmbed: () => void;
  /**
   * 电池暂停判定（`isBatteryPaused`，见 model/power.ts）。缺省 = 不检查。
   * 门在 `serviceUp` **之前**：探测会刷新服务的 `lastUsedAt`（server.mjs 对
   * 每个请求都刷），先探测再判门的话热服务在电池上永远退不掉，VRAM/内存
   * 一直被占。暂停时整段返回，日志与「no service running」同形。
   */
  pausedOnBattery?: () => Promise<boolean>;
};

export type IndexReconciler = {
  /** Stop the timer. An in-flight pass finishes on its own and is never awaited. */
  dispose(): void;
  /**
   * Run one pass now, without waiting for the interval. The same skip test
   * applies, so calling this on an unchanged index costs one aggregate and a few
   * stats. Exposed so the browser can offer a "sync now" that is the recovery
   * pass rather than the full rebuild `memory_reindex` runs.
   */
  runNow(): Promise<void>;
};

export function createIndexReconciler(options: IndexReconcileOptions): IndexReconciler {
  let disposed = false;
  let inFlight = false;

  async function pass(): Promise<void> {
    // A pass that overlaps itself would clear and rewrite the same rows twice for
    // one change. Skipping is safe: the next pass is five minutes away and the
    // skip test is by bytes and mtime, so nothing is lost by arriving late.
    if (disposed || inFlight) return;
    inFlight = true;
    try {
      const home = await discoverHomeFiles();
      const homeReport = await reindexFiles({
        db: options.db,
        files: home,
        root: "home",
        // Without the home the classifier is never consulted and every document
        // is stored with no provenance at all, which the promotion gate and lane
        // 1c both reject (memory-tools.ts says so at length).
        memoryHome: memoryHomeDir(),
        ...(options.model ? { model: options.model } : {}),
      });
      const wiki = readWikiConfig(options.options);
      // Gated on `wiki.enabled`, NOT on the scan finding anything -- the same
      // reason `runReindex` gives: the prune at the end of `reindexFiles` is the
      // only thing that removes a wiki page deleted from disk. No `model`, also
      // as `runReindex` does it, so the corpus stays keyword-only by design and
      // this pass does not quietly start embedding it.
      const wikiReport = wiki.enabled
        ? await reindexFiles({
            db: options.db,
            files: await discoverWikiFiles(wiki.dir),
            root: "wiki",
          })
        : null;

      const pruned = homeReport.pruned + (wikiReport?.pruned ?? 0);
      const retained = pruneIndexRetention(options.db, INDEX_RETENTION_MAX_CHUNKS, memoryHomeDir());
      if (homeReport.indexed > 0 || pruned > 0 || retained > 0) {
        options.log(
          `index reconcile: ${homeReport.indexed} memory file(s) re-indexed` +
            (wikiReport ? `, ${wikiReport.indexed} wiki page(s)` : "") +
            (pruned > 0 ? `, ${pruned} document(s) removed from disk` : "") +
            (retained > 0 ? `, ${retained} chunk(s) pruned for retention` : ""),
        );
      }

      if (!options.vectorsEnabled) return;
      // Ask about the service only when there is something to embed: a clean pass
      // costs one COUNT and no HTTP at all.
      const missing = options.missingVectors();
      if (missing === 0) return;
      // 电池暂停：见 IndexReconcileOptions.pausedOnBattery——门必须在探测之前。
      if (options.pausedOnBattery && (await options.pausedOnBattery())) {
        options.log(`index reconcile: ${missing} chunk(s) without vectors, paused on battery`);
        return;
      }
      if (!(await options.serviceUp())) {
        // Honest about why nothing happened, and it is not an error: the next
        // pass asks again, which is what makes a service that was down during a
        // burst of writes self-heal without anybody running `memory_reindex`.
        options.log(`index reconcile: ${missing} chunk(s) without vectors, no service running`);
        return;
      }
      options.scheduleEmbed();
    } catch (error) {
      // Derived data: a failed pass is retried in five minutes and never fails a
      // turn, which is the same contract `indexWrittenFile` runs under.
      if (!disposed) options.log("index reconcile failed", error);
    } finally {
      inFlight = false;
    }
  }

  const timer = setInterval(() => {
    void pass();
  }, RECONCILE_INTERVAL_MS);
  // The timer must not hold the process open on its own: OpenCode exits while the
  // plugin is still loaded, and an interval that keeps the event loop alive turns
  // that into a hang.
  timer.unref();

  return {
    dispose(): void {
      disposed = true;
      clearInterval(timer);
    },
    async runNow(): Promise<void> {
      await pass();
    },
  };
}
