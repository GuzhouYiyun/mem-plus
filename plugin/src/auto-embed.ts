// Background embedding for memory written after startup.
//
// UPSTREAM: `manager-index-preparation.ts:79` computes embeddings inside the
// reindex, so in openclaw a file change is searchable by meaning as soon as the
// sync finishes. mem-plus's embedding is a separate budgeted call
// (`memory-tools.ts`'s `embedMissing`), so the write path has to schedule it.
// This scheduler is deliberately narrow: it embeds only the documents the write
// path names, not the whole index, so a per-turn session snapshot is not
// re-embedded on every capture.
//
// The debounce coalesces a burst of captures. A batch that fills its budget
// requeues its documents: one with missing chunks continues on the next pass,
// while one already complete costs one indexed query and no embed call.
//
// Chain: docs/memory-chain.md §2 (chunk identity, model, embedding BLOB) and §5
// (the vector lane that only sees chunks embedded under the current model).

export type AutoEmbedScheduler = {
  /** Queue one memory-home-relative document for the next background pass. */
  schedule(file: string): void;
  /** Stop the timer and abort an in-flight pass. */
  dispose(): void;
};

export type AutoEmbedOptions = {
  /** `memory-tools`'s `embedMissing`, already bound to the index/model/service. */
  embedMissing: (
    budget: number,
    signal: AbortSignal,
    paths: readonly string[],
  ) => Promise<number>;
  log: (message: string, detail?: unknown) => void;
  /** False when the vector lane is off; scheduling then does nothing. */
  enabled: boolean;
  debounceMs?: number;
  budget?: number;
  maxPaths?: number;
};

const DEFAULT_DEBOUNCE_MS = 1500;
const DEFAULT_BUDGET = 64;
const DEFAULT_MAX_PATHS = 64;

export function createAutoEmbedScheduler(options: AutoEmbedOptions): AutoEmbedScheduler {
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const budget = options.budget ?? DEFAULT_BUDGET;
  const maxPaths = options.maxPaths ?? DEFAULT_MAX_PATHS;
  const controller = new AbortController();
  const paths = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight = false;
  let again = false;
  let disposed = false;

  async function run(): Promise<void> {
    if (disposed || inFlight || controller.signal.aborted) return;
    const batch = [...paths];
    paths.clear();
    if (batch.length === 0) return;
    inFlight = true;
    try {
      const embedded = await options.embedMissing(budget, controller.signal, batch);
      if (embedded > 0) options.log(`auto-embed: ${embedded} chunk(s) from new memory`);
      // A full batch means at least one document still has missing chunks.
      // Requeue the batch: documents already complete cost one indexed query
      // and no embed call, while a large day file drains over several passes.
      if (embedded >= budget) {
        for (const path of batch) paths.add(path);
        again = true;
      }
    } catch (error) {
      if (!disposed) options.log("auto-embed failed", error);
    } finally {
      inFlight = false;
      if (again && !disposed) {
        again = false;
        scheduleAgain();
      }
    }
  }

  function scheduleAgain(): void {
    if (!options.enabled || disposed || controller.signal.aborted) return;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void run();
    }, debounceMs);
  }

  return {
    schedule(file: string): void {
      if (!options.enabled || disposed || controller.signal.aborted) return;
      if (file) paths.add(file);
      if (paths.size === 0) return;
      // A burst larger than this is a bulk import; leave the remainder to the
      // manual reindex rather than building an unbounded IN list.
      while (paths.size > maxPaths) {
        const oldest = paths.values().next().value;
        if (oldest === undefined) break;
        paths.delete(oldest);
      }
      if (inFlight) {
        again = true;
        // A timer should not fire into an in-flight pass; the finally block
        // reschedules for anything that arrived while it ran.
        if (timer !== undefined) {
          clearTimeout(timer);
          timer = undefined;
        }
        return;
      }
      scheduleAgain();
    },
    dispose(): void {
      disposed = true;
      controller.abort();
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
  };
}
