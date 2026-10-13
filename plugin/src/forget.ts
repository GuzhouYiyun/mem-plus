// Host wiring for upstream's `forgetMemoryEntries`.
//
// UPSTREAM: `extensions/memory-core/src/memory-forget.ts` provides the decision layer;
// this file supplies the four things it takes as parameters, because each one is a
// host concern in mem-plus where upstream reads it out of its own config object.
//
//   readFile       -- upstream reads through `readWorkspaceText`, which enforces
//                     openclaw's workspace sandbox. mem-plus's equivalent is the
//                     memory-home walk below, so the path never comes from a request.
//   listMemoryFiles-- upstream `listWorkspaceMemoryFiles` over the workspace.
//                     `discoverHomeFiles` already produces exactly that set for the
//                     memory home, including `MEMORY.md` and the daily files.
//   listOrigins    -- the lineage table forget selects through.
//   markForgotten  -- upstream's `forget.mark`: session tombstones + the
//                     `memory_index_state.revision` bump. mem-plus has no forget
//                     worker, so the connection is opened inside memory-core.
//
// AGENT ID
//   Upstream's forget is per-agent. mem-plus has one agent, `"main"`, the same id
//   `plugin/src/standing-intents.ts` already writes under. It is named here once so
//   the lineage rows a forget selects are the rows promotion wrote.
import fs from "node:fs/promises";
import { listMemoryEntryOrigins, recordMemorySessionTombstones } from "../../extensions/memory-core/src/memory-entry-origins.js";
import { forgetMemoryEntries, type MemoryForgetReport } from "../../extensions/memory-core/src/memory-forget.js";
import { discoverHomeFiles } from "./memory-scan.js";
import { memoryHomeDir } from "./paths.js";
import type { DatabaseSync } from "node:sqlite";

/** The single agent mem-plus runs. Matches `standing-intents.ts`. */
const AGENT_ID = "main";

export type ForgetInput = {
  sessionIds?: string[];
  hookSources?: string[];
  participants?: string[];
  since?: string;
  dryRun: boolean;
};

/**
 * `DREAMS.md` is upstream's `DREAMS_FILENAMES`, which `listWorkspaceMemoryFiles`
 * adds on top of the workspace walk. mem-plus's `discoverHomeFiles` deliberately
 * leaves `DREAMS.md` out of the index (it is a review surface, not a promotion
 * source), but forget still has to be able to scrub it: upstream scrubs every
 * memory file it finds, and a session reference inside the diary is still a
 * reference. Added here rather than to the indexer, which must keep excluding it.
 */
const DREAMS_FILENAME = "DREAMS.md";

async function listForgetableFiles(memoryHome: string): Promise<string[]> {
  const discovered = await discoverHomeFiles();
  const files = discovered.map((entry) => entry.file);
  try {
    const dreams = `${memoryHome}\\${DREAMS_FILENAME}`.replace(/\\/g, "/");
    await fs.stat(dreams);
    files.push(dreams.replace(/\//g, "\\"));
  } catch {
    // No dream diary yet, which is the normal state for a fresh install.
  }
  return files;
}

export async function forget(
  input: ForgetInput,
  index: DatabaseSync | null,
): Promise<MemoryForgetReport> {
  const memoryHome = memoryHomeDir();
  return forgetMemoryEntries({
    agentId: AGENT_ID,
    workspaceDir: memoryHome,
    ...(input.sessionIds ? { sessionIds: input.sessionIds } : {}),
    ...(input.hookSources ? { hookSources: input.hookSources } : {}),
    ...(input.participants ? { participants: input.participants } : {}),
    ...(input.since ? { since: input.since } : {}),
    dryRun: input.dryRun,
    readFile: (absolutePath) => fs.readFile(absolutePath, "utf8"),
    listMemoryFiles: () => listForgetableFiles(memoryHome),
    listOrigins: async (agentId) => listMemoryEntryOrigins({ agentId }),
    markForgotten: ({ agentId, sessionIds }) =>
      recordMemorySessionTombstones({ agentId, sessionIds }),
    // Upstream's purge reaches its index through a worker borrowing openclaw's agent
    // database. mem-plus's index is the plugin's own `index.db`, so it is handed over
    // directly. Null when the retrieval runtime is not registered -- the file scrub
    // still runs, and the next reindex converges the index.
    ...(index ? { indexDb: index } : {}),
  });
}