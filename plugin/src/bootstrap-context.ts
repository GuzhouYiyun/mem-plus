import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * Bootstrap context injection, local implementation.
 *
 * This replaces four imports out of openclaw's agent runtime --
 * `src/agents/workspace.js`, `workspace-bootstrap-policy.js`,
 * `embedded-agent-helpers/bootstrap.js` and `system-prompt-context-files.js` --
 * which together dragged 1,800 vendored files into the plugin's import graph.
 * Measured 2026-10-11: the graph was 1,848 files, of which 55 were
 * `extensions/memory-core` (the actual memory logic). OpenCode registers a file
 * watcher per imported file, and 3,011 of them were live on the plugin install
 * directory.
 *
 * What was dropped, and why each is dead weight on OpenCode:
 *
 * - `getAgentWorkspaceAccess` / `readWorkspaceFileWithGuards` / `exactWorkspaceEntryExists`
 *   are openclaw's path-traversal guards, and `readWorkspaceFileWithGuards`
 *   carries `setWorkspaceFileSourceIdentity` bookkeeping for openclaw's own
 *   audit layer. On OpenCode the operator's own workspace is the trust boundary
 *   (the security layer was cut deliberately -- see the deviation list), so the
 *   guard has nothing to check and its bookkeeping has no reader.
 * - `buildBootstrapContextFiles`' config lookup (`resolveBootstrapCharLimit`)
 *   reads openclaw's config schema. mem-plus has its own config file, and the
 *   defaults below are the same numbers it resolved to.
 * - `buildBootstrapContextFiles`' `personalUser` flag and
 *   `PERSONAL_USER_CONTEXT_INSTRUCTIONS` describe openclaw's multi-account user
 *   model. mem-plus has one operator and no `users/<profile-id>/` overlay, so
 *   that branch can never be true here.
 * - `prepareContextFilesForPrompt`'s `user.md` tie-break exists to give the
 *   personal overlay precedence over the shared file. With no overlay there is
 *   nothing to break the tie between, so the sort falls through to path order.
 *
 * Everything the memory plugin actually depends on -- the filename list and
 * order, the per-file and total character budgets, the heartbeat-block scrub, and
 * the section text -- is preserved byte for byte.
 */

/** Canonical bootstrap filenames in prompt order. */
export const BOOTSTRAP_FILENAMES = [
  "AGENTS.md",
  "SOUL.md",
  "IDENTITY.md",
  "USER.md",
  "BOOTSTRAP.md",
  "MEMORY.md",
] as const;

export type BootstrapFilename = (typeof BOOTSTRAP_FILENAMES)[number];

/** Per-file and total character budgets; openclaw's resolved defaults. */
const MAX_CHARS_PER_FILE = 20_000;
const MAX_CHARS_TOTAL = 60_000;

const CONTEXT_FILE_ORDER = new Map<string, number>([
  ["agents.md", 10],
  ["soul.md", 20],
  ["identity.md", 30],
  ["user.md", 40],
  ["tools.md", 50],
  ["bootstrap.md", 60],
  ["memory.md", 70],
]);

/**
 * Old workspace templates route Claude subscriptions to paid extra usage, and the
 * heartbeat block is only meaningful in the real scheduled turn.
 */
const HEARTBEAT_PROMPT_CONTEXT_BLOCK =
  /Default heartbeat prompt:\r?\n`(?:Read HEARTBEAT\.md if it exists|Follow the heartbeat monitor scratch context when provided\.)[^`\r\n]*HEARTBEAT_OK\.`/gu;

function sanitizeContent(content: string): string {
  return content.replaceAll(HEARTBEAT_PROMPT_CONTEXT_BLOCK, "").replace(/\n{3,}/g, "\n\n");
}

function normalizePath(value: string): string {
  return value.trim().replace(/\\/g, "/");
}

function basenameOf(normalized: string): string {
  return normalized.slice(normalized.lastIndexOf("/") + 1).toLowerCase();
}

export type ContextFile = {
  readonly name: string;
  readonly path: string;
  readonly content: string;
};

/**
 * Read the bootstrap files that exist in `dir`, in prompt order, honouring both
 * character budgets. Missing files are skipped rather than rendered as empty
 * headings.
 */
export async function loadBootstrapContextFiles(
  dir: string,
  names: readonly string[] = BOOTSTRAP_FILENAMES,
): Promise<ContextFile[]> {
  const wanted = BOOTSTRAP_FILENAMES.filter((name) => names.includes(name));
  const result: ContextFile[] = [];
  let remainingTotal = MAX_CHARS_TOTAL;

  for (const name of wanted) {
    if (remainingTotal <= 0) break;
    let content: string;
    try {
      content = await readFile(path.join(dir, name), "utf8");
    } catch {
      continue; // absent, unreadable, or a directory: nothing to inject
    }
    const truncated =
      content.length > MAX_CHARS_PER_FILE ? content.slice(0, MAX_CHARS_PER_FILE) : content;
    if (truncated.length === 0) continue;
    remainingTotal -= truncated.length;
    result.push({ name, path: path.join(dir, name), content: truncated });
  }
  return result;
}

/** Render the loaded files as the "# Project Context" system block. */
export function buildProjectContextSection(files: readonly ContextFile[]): string[] {
  if (files.length === 0) return [];

  const ordered = files
    .map((file) => {
      const normalized = normalizePath(file.path);
      const basename = basenameOf(normalized);
      return { file, normalized, basename, order: CONTEXT_FILE_ORDER.get(basename) ?? Number.MAX_SAFE_INTEGER };
    })
    .toSorted((a, b) => {
      if (a.order !== b.order) return a.order - b.order;
      if (a.basename !== b.basename) return a.basename.localeCompare(b.basename);
      return a.normalized.localeCompare(b.normalized);
    });

  const lines = ["# Project Context", "", "Loaded project context:"];
  const has = (name: string) => ordered.some((entry) => entry.basename === name);
  if (has("soul.md")) {
    lines.push("SOUL.md: persona/tone. Follow it unless higher-priority instructions override.");
  }
  if (has("memory.md")) {
    lines.push(
      "MEMORY.md: durable non-profile facts and decisions; use when relevant unless higher-priority instructions override.",
    );
  }
  if (has("user.md")) {
    lines.push(
      "USER.md: durable user preferences and profile directives; follow unless higher-priority instructions override.",
    );
  }
  lines.push("");
  for (const { file, normalized } of ordered) {
    lines.push(`## ${normalized}`, "", sanitizeContent(file.content), "");
  }
  return lines;
}
