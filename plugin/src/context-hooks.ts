// The `context` hook: inject bootstrap files into the session system prompt --
// the same mechanism openclaw uses for its embedded agents.
//
// Extracted from `index.ts` (structure pass, 2026-11-17); body moved verbatim.
// No binding renames: everything the hook reads arrives as a constructor param,
// and the two pieces of setup-local state (`instructionFileNames`,
// `warnedMissingSessionID`) move into the factory closure -- one factory per
// workspace, so "once per process" keeps its meaning.
//
// Why one file: the file list, the home MEMORY.md provenance gate and the
// missing-session-id warning are one injection path; splitting them would
// restate `workspaceDir` and `log` per piece.

import path from "node:path";
import {
  activeProjectKeys,
  filterProjectScopedCuratedContext,
  prepareActiveProjectKey,
} from "./project-key.js";
import {
  BOOTSTRAP_FILENAMES,
  buildProjectContextSection,
  fitCuratedToBudget,
  isHomeMemoryInjectionAllowed,
  loadBootstrapContextFiles,
  readContextFile,
} from "./bootstrap-context.js";
import { memoryHomeDir } from "./paths.js";
import type { PluginContext } from "./opencode.js";

export type ContextHooksParams = {
  readonly ctx: PluginContext;
  readonly workspaceDir: string;
  readonly log: (message: string, detail?: unknown) => void;
};

export async function createContextHooks(params: ContextHooksParams): Promise<void> {
  const { ctx, workspaceDir, log } = params;
  // Inject bootstrap files into the session system prompt -- the same mechanism
  // openclaw uses for its embedded agents. Reads go through upstream's identity
  // cache (`readContextFile`): an edit between turns is picked up on the next
  // model request, while an unchanged file costs a stat instead of a re-read.
  //
  // The five instruction files are the user's own and stay in the project;
  // MEMORY.md is openclaw's home file, so it is read from the memory home and
  // appended last (canonical order). It only exists once dreaming has
  // promoted something into it, so absence is the normal state and is not a
  // `[MISSING]` worth showing the model.
  //
  // Its entries are filtered by this session's active repository keys before they
  // reach the prompt. Without a session id there is no way to know what is in scope,
  // so nothing is injected -- see `filterProjectScopedCuratedContext`.
  const DEFAULT_MEMORY_FILENAME = "MEMORY.md";
  const instructionFileNames = BOOTSTRAP_FILENAMES.filter(
    (name) => name !== DEFAULT_MEMORY_FILENAME,
  );
  // One-shot, not per request: see the branch in the hook below. The `context` hook
  // fires on every model request, and a missing session id is a property of how the
  // host wired the hook rather than of any one turn.
  let warnedMissingSessionID = false;

  await ctx.session.hook("context", async (event) => {
    const sessionID = (event as { sessionID?: string }).sessionID;
    try {
      const files = await loadBootstrapContextFiles(workspaceDir, instructionFileNames, log);
      const homeMemoryPath = path.join(memoryHomeDir(), DEFAULT_MEMORY_FILENAME);
      if (typeof sessionID === "string" && sessionID.length > 0) {
        // Upstream's `filterProjectScopedCuratedContextFiles`, applied to the file
        // rather than to a provider's hits. Entries carrying `<!-- project: ... -->`
        // keys survive only when every key is active for this session; unannotated
        // ones stay, because upstream defines an unannotated entry as global.
        //
        // This is the seam the cross-session leak actually crossed. Dropping this
        // filter is what let a curated entry written while working in one repository
        // sit verbatim in the system prompt of a session working in another.
        await prepareActiveProjectKey(sessionID, workspaceDir);
        try {
          // Through upstream's identity cache (`readContextFile`): a stat per model
          // request, a read only when the file actually changed.
          const rawMemory = await readContextFile(homeMemoryPath);
          // Provenance gate (openclaw PR #189727; chain §8): when the
          // ratchet has downgraded the home MEMORY.md to `untrusted`, it
          // stays out of the prompt -- searchable, but never injected
          // automatically. Warned once per process inside the helper.
          const allowed =
            rawMemory === undefined ||
            (await isHomeMemoryInjectionAllowed({
              absolutePath: homeMemoryPath,
              memoryHome: memoryHomeDir(),
              log,
            }));
          // Upstream's #45415 -- a global MEMORY.md past the injection budget was
          // silently cut mid-entry. The whole file used to ride into the prompt
          // unfiltered here; now it is fitted the same block-safe way the
          // workspace files are (see `fitCuratedToBudget`).
          const memoryContent =
            !allowed || rawMemory === undefined
              ? ""
              : fitCuratedToBudget(
                  DEFAULT_MEMORY_FILENAME,
                  filterProjectScopedCuratedContext(rawMemory, activeProjectKeys(sessionID)),
                  log,
                );
          if (memoryContent.trim().length > 0) {
            files.push({
              name: DEFAULT_MEMORY_FILENAME,
              path: homeMemoryPath,
              content: memoryContent,
            });
          }
        } catch {
          // No global long-term memory yet; nothing to inject. The normal state for
          // a fresh install, and expected until dreaming promotes something -- so it
          // stays silent, unlike the case below.
        }
      } else if (!warnedMissingSessionID) {
        // This branch is mem-plus-specific and was previously silent. Upstream cannot
        // reach it: `prepareAgentPromptProjects` takes `sessionId` as a required
        // parameter (`prompt-projects.ts:6`), so there is no "no session id" state to
        // arrive with. Here the host's `context` event carries an optional
        // `sessionID`, and when it is absent every curated entry would be unfiltered
        // -- so the whole file is withheld instead. That is the right call (see
        // `filterProjectScopedCuratedContext`), but it must not be invisible: the
        // symptom is all long-term memory silently disappearing from every prompt.
        // openclaw's convention on this path is to warn and carry on
        // (`bootstrap-files.ts:254`), so this does too, once per process.
        warnedMissingSessionID = true;
        log(`${DEFAULT_MEMORY_FILENAME} withheld: context hook carried no session id`);
      }
      const lines = buildProjectContextSection(files);
      if (lines.length > 0) {
        event.system.push({ type: "text", text: lines.join("\n") });
      }
    } catch (error) {
      log("bootstrap injection failed", error);
    }
  });
}
