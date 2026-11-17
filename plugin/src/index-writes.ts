// The write path's three index-entry helpers: what happens to the index after
// a file is written (replaced in full, appended to, or produced by a capture
// sweep). The index is a projection of the memory files -- none of these throw;
// `memory_reindex` repairs a missed one without the user needing to know.
//
// Extracted from `index.ts` (structure pass, 2026-11-17); bodies and their doc
// comments moved verbatim. Two binding renames the extraction forces:
// `modelConfig.embedderId` arrives as the `embedderId` param, and
// `scheduleAutoEmbed(file)` becomes `queueEmbed(file)` -- index.ts passes a
// trampoline over its own `let scheduleAutoEmbed`, so late binding to whichever
// the retrieval block installed (or the no-op when there is no index) is
// preserved exactly.
//
// Why one file: the three helpers are one concern (file -> index units) and two
// of them call the third; splitting them would export the plumbing between them.

import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { CaptureOutcome } from "../../extensions/memory-core/src/capture/index.js";
import { indexWrittenFile } from "./memory-scan.js";
import { homeProjectMemoryDir, homeProjectSlug, memoryHomeDir } from "./paths.js";

export type IndexWritesParams = {
  /** Shared index.db; null (no node:sqlite / no index) makes every helper a no-op. */
  readonly db: DatabaseSync | null;
  /** Chunk model string; omitted chunks are written fts-only (see the calls). */
  readonly embedderId: string;
  readonly workspaceDir: string;
  readonly log: (message: string, detail?: unknown) => void;
  /** Trampoline for index.ts's late-bound `scheduleAutoEmbed`. */
  readonly queueEmbed: (file: string) => void;
};

export function createIndexWrites(params: IndexWritesParams): {
  indexReplaced: (files: readonly string[], options?: { readonly autoEmbed?: boolean }) => Promise<void>;
  indexAppended: (file: string) => Promise<void>;
  indexCapturedOutcomes: (outcomes: readonly CaptureOutcome[]) => Promise<void>;
} {
  const { db: index, embedderId, workspaceDir, log, queueEmbed } = params;
  /**
   * Index files the write path rewrote in full: a session snapshot every turn,
   * and `MEMORY.md` after a promotion round.
   *
   * A snapshot rewrites its whole file every turn, so the previous turn's units
   * must go; re-reading and re-chunking is also what an appended daily file
   * needs (see `indexAppended`). Never throws: the index is derived data, and a
   * failed update is repaired by `memory_reindex` without the user needing to
   * know it happened.
   *
   * `autoEmbed` queues the file for the background pass. It is safe on every
   * full-file write, snapshots included: `embedMissing` only fills chunks
   * whose vector is zero-length (auto-embed.ts says so), so an unchanged
   * settle costs one indexed query and no embed call — the old fear that
   * auto-embedding would re-embed the same transcript every turn was wrong,
   * and skipping it let changed snapshots accumulate missing vectors until
   * the next startup's repair (641 chunks, 11 min, 2026-11-05).
   */
  const indexReplaced = async (
    files: readonly string[],
    options?: { readonly autoEmbed?: boolean },
  ): Promise<void> => {
    if (!index) return;
    for (const file of files) {
      // Project identity comes from where the file sits under the home, not
      // from this window: the index is shared by every project on the machine,
      // so a document's project must be readable from its own path.
      const written = await indexWrittenFile({
        db: index,
        file,
        root: "home",
        project: homeProjectSlug(file),
        // Snapshots only ever reach the index through this call, so this is the only
        // place their provenance can be recorded. Without it every snapshot document
        // is stored with a NULL provenance class and the trigger-injection gate
        // (`isPromotedTrustedMemoryEntry`) rejects all of them.
        memoryHome: memoryHomeDir(),
        // The chunks are only eligible for vectors if they carry the same model
        // string the embed/search passes use; `indexWrittenFile` defaults to
        // fts-only when this is omitted.
        model: embedderId,
        log,
      });
      if (written > 0) {
        log(`indexed ${written} unit(s) from ${file}`);
        if (options?.autoEmbed) queueEmbed(file);
      }
    }
  };

  /**
   * Index a file the write path just appended to.
   *
   * This used to take a tail-only path (`indexTail` -> `indexAppendedTail`), and
   * that path never classified provenance: `indexDocument` then stored the
   * document as `untrusted` (`upstreamProvenance(undefined)`), which the
   * promotion gate rejects. Every captured daily entry was therefore ineligible
   * the moment it was written, and `MEMORY.md` could never be produced no matter
   * how often an entry was recalled.
   *
   * It now goes through the same full re-index as a replaced file, which is
   * upstream's shape anyway: a chunk's identity is a hash over its text and
   * span, so there is no stable way to add only the new fragments, and upstream
   * clears `(path, source)` and re-chunks the whole file for an append too. One
   * capture re-chunks its whole day file; that file is a day, not `MEMORY.md`.
   */
  const indexAppended = async (file: string): Promise<void> => {
    if (!index) return;
    const written = await indexWrittenFile({
      db: index,
      file,
      root: "home",
      project: homeProjectSlug(file),
      // The write path records provenance for every artifact it writes; without
      // the home the classifier is never consulted and the document is stored
      // with no provenance at all.
      memoryHome: memoryHomeDir(),
      // Same reason as `indexReplaced`: without the model the chunks are written
      // fts-only and no embed pass will ever select them.
      model: embedderId,
      log,
    });
    if (written > 0) {
      log(`indexed ${written} new unit(s) from ${file}`);
      // The capture is searchable by keyword immediately; let the background
      // pass make the same chunks searchable by meaning too.
      queueEmbed(file);
    }
  };

  /**
   * Index the daily files a capture sweep wrote.
   *
   * Both the per-turn sweep and the startup drain write through
   * `capture.runSweep`; without this, a capture recovered at startup was
   * written to disk but never indexed, so it stayed invisible until the next
   * reindex -- and never reached the automatic embed pass either.
   */
  const indexCapturedOutcomes = async (
    outcomes: readonly CaptureOutcome[],
  ): Promise<void> => {
    for (const outcome of outcomes) {
      if (outcome.kind !== "captured" || !outcome.relativePath) continue;
      // `relativePath` is the pipeline's own key (`memory/<day>.md`), relative
      // to the project it came from. The file lives in this window's slice of
      // the home, so use the key's day rather than today's date.
      const day = path.basename(outcome.relativePath, ".md");
      await indexAppended(path.join(homeProjectMemoryDir(workspaceDir), `${day}.md`));
    }
  };
  return { indexReplaced, indexAppended, indexCapturedOutcomes };
}
