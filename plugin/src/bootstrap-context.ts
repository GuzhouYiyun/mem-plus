import { readFile, stat } from "node:fs/promises";
import type { Stats } from "node:fs";
import path from "node:path";
import { compactMemoryForBudget } from "../../extensions/memory-core/src/memory-budget.js";
import { isMemoryOriginEligibleForAutomaticInjection } from "../../packages/memory-host-sdk/src/host/types.js";
import { resolveMemoryPathClassification } from "./memory-path-provenance.js";
import { readWorkspaceFileCache, writeWorkspaceFileCache } from "./workspace-file-cache.js";

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
 * the section text -- is preserved byte for byte. One deliberate addition sits on
 * top: curated files (`MEMORY.md`, `USER.md`) are fitted to the per-file budget by
 * whole generated blocks instead of a raw character slice, which is the fix for
 * openclaw's #45415 (a MEMORY.md past 20k was cut mid-entry, silently). The
 * budgets themselves -- 20_000 per file, 60_000 total -- are unchanged.
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
 * Upstream's `workspaceFileIdentity` (`src/agents/workspace-file-read.ts:32`), verbatim.
 *
 * `ctimeMs` catches in-place edits that restore mtime (sync/restore/editor tooling);
 * matches the freshness pattern in assistant-avatar-cache.ts and plugin-registry-snapshot.ts.
 */
function workspaceFileIdentity(stat: Stats, canonicalPath: string): string {
  // ctimeMs catches in-place edits that restore mtime (sync/restore/editor tooling);
  // matches the freshness pattern in assistant-avatar-cache.ts and plugin-registry-snapshot.ts.
  return `${canonicalPath}|${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
}

/**
 * Read one context file through upstream's identity cache
 * (`workspace-file-cache.ts`, copied from `src/agents/workspace-file-cache.ts`).
 *
 * The upstream equivalent is `workspace-file-read.ts`'s fd dance: stat, build the
 * identity, serve from cache on a hit, read and store on a miss. The path guards and
 * fd pinning that surround it upstream are absent here for the reason this whole file
 * exists (see the header: OpenCode's workspace is the trust boundary), so this is
 * stat -> identity -> cache -> readFile. A missing file is a miss with no cache write,
 * as upstream's ENOENT branch is.
 *
 * Why it matters: the context hook fires on every model request, and without this each
 * request re-read AGENTS.md / SOUL.md / MEMORY.md from disk. An edit is picked up on
 * the very next request -- identity includes size, mtime and ctime -- so freshness is
 * unchanged from reading the file every time.
 */
export async function readContextFile(filePath: string): Promise<string | undefined> {
  let info: Stats;
  try {
    info = await stat(filePath);
  } catch {
    return undefined;
  }
  const identity = workspaceFileIdentity(info, filePath);
  const cached = readWorkspaceFileCache(filePath, identity);
  if (cached !== undefined) return cached;
  let content: string;
  try {
    content = await readFile(filePath, "utf8");
  } catch {
    return undefined;
  }
  writeWorkspaceFileCache({ filePath, content, identity });
  return content;
}

/**
 * Fit one curated file's content into the per-file injection budget (#45415,
 * companion-plan §3 Phase 3 item 4).
 *
 * Uses upstream's own compaction rule (`compactMemoryForBudget`,
 * `memory-budget.ts:180`): only *fully generated* promotion blocks are droppable,
 * oldest first, and owner/human text is never evicted by the compactor. The
 * `newSection: ""` shape is the write-side contract's read-side mirror -- the
 * injection side owns no new content, it only asks "what fits".
 *
 * When even the preserved blocks exceed the budget the compactor honestly
 * returns oversized content; the last resort is a cut at a line boundary, not at
 * an arbitrary character, so an entry can never be delivered half-written.
 */
const budgetFitWarned = new Set<string>();

export function fitCuratedToBudget(
  name: string,
  content: string,
  log: (message: string, detail?: unknown) => void,
): string {
  if (content.length <= MAX_CHARS_PER_FILE) return content;
  const compacted = compactMemoryForBudget({
    existingMemory: content,
    newSection: "",
    budgetChars: MAX_CHARS_PER_FILE,
  });
  if (compacted.compacted.length <= MAX_CHARS_PER_FILE) {
    const key = `${name}:blocks:${compacted.compacted.length}`;
    if (!budgetFitWarned.has(key)) {
      budgetFitWarned.add(key);
      log(
        `injection budget: ${name} over ${MAX_CHARS_PER_FILE} chars, ${compacted.droppedDates.length} generated block(s) withheld from injection`,
      );
    }
    return compacted.compacted;
  }
  const cut = compacted.compacted.slice(0, MAX_CHARS_PER_FILE);
  const lineBreak = cut.lastIndexOf("\n");
  const clipped = lineBreak > 0 ? cut.slice(0, lineBreak) : cut;
  const key = `${name}:clip:${clipped.length}`;
  if (!budgetFitWarned.has(key)) {
    budgetFitWarned.add(key);
    log(
      `injection budget: ${name} exceeds ${MAX_CHARS_PER_FILE} chars of non-generated content; injected up to a line boundary`,
    );
  }
  return clipped;
}

/**
 * Read the bootstrap files that exist in `dir`, in prompt order, honouring both
 * character budgets. Missing files are skipped rather than rendered as empty
 * headings. Reads go through `readContextFile` (upstream's identity cache).
 */
export async function loadBootstrapContextFiles(
  dir: string,
  names: readonly string[] = BOOTSTRAP_FILENAMES,
  log?: (message: string, detail?: unknown) => void,
): Promise<ContextFile[]> {
  const wanted = BOOTSTRAP_FILENAMES.filter((name) => names.includes(name));
  const result: ContextFile[] = [];
  let remainingTotal = MAX_CHARS_TOTAL;

  for (const name of wanted) {
    if (remainingTotal <= 0) break;
    const fullPath = path.join(dir, name);
    const content = await readContextFile(fullPath);
    if (content === undefined) continue; // absent, unreadable, or a directory: nothing to inject
    const truncated =
      content.length > MAX_CHARS_PER_FILE
        ? name === "MEMORY.md" || name === "USER.md"
          ? fitCuratedToBudget(name, content, log ?? (() => {}))
          : content.slice(0, MAX_CHARS_PER_FILE)
        : content;
    if (truncated.length === 0) continue;
    remainingTotal -= truncated.length;
    result.push({ name, path: fullPath, content: truncated });
  }
  return result;
}

/**
 * Provenance gate for the memory file injected from the memory home (openclaw
 * PR #189727, "bootstrap provenance visibility", merged 2026-11-02; chain
 * `docs/memory-chain.md` §8): a curated root file whose recorded provenance was
 * ratcheted down to `untrusted` must not ride into the system prompt -- it is
 * still searchable, but automatic injection is reserved for `owner` / `agent`
 * content.
 *
 * Upstream does this in `resolveIneligibleAutomaticMemoryFiles`
 * (`src/agents/bootstrap-files.ts`), classifying every candidate and filtering
 * the ineligible ones, warning once per process per file. mem-plus has exactly
 * one such candidate (the home `MEMORY.md`; the project instruction files are
 * not memory sources and never enter this classification), so the same rule is
 * one call instead of a filter.
 *
 * TWO ADAPTATIONS:
 *   - Upstream's warning ends with "run `openclaw doctor` for the last recorded
 *     write". mem-plus has no doctor command and no provenance viewer in the
 *     memory browser, so the warning is the bare exclusion line; the record
 *     itself lives in the plugin state store (`workspace-files` namespace).
 *   - Upstream's classifier reports `unavailable` and skips the gate rather
 *     than failing closed. Here a classification error (a broken state store)
 *     does the same: inject, because silently dropping all long-term memory is
 *     the worse failure -- the same reasoning as the missing-session-id warning
 *     at the call site. A missing file returns `untrusted`, but the caller
 *     only reaches this helper after `readContextFile` saw content, so the
 *     window for that is a delete racing the read. The unavailable branch warns
 *     once per file, because the context hook fires on every model request.
 *
 * The once-per-process key follows upstream's
 * `memory-provenance-exclusion\0<workspace>\0<path>\0<originClass>` shape. The
 * set needs no bound: the key space is one file path per memory home.
 */
const provenanceExclusionWarned = new Set<string>();

export async function isHomeMemoryInjectionAllowed(params: {
  /** Absolute path of the curated-root file being considered for injection. */
  absolutePath: string;
  /** The memory home the file lives in -- the provenance workspace key. */
  memoryHome: string;
  log: (message: string, detail?: unknown) => void;
}): Promise<boolean> {
  let originClass: string;
  try {
    const classification = await resolveMemoryPathClassification({
      absolutePath: params.absolutePath,
      source: "memory",
      workspaceDir: params.memoryHome,
    });
    originClass = classification.originClass;
  } catch (error) {
    // Once per file, not per request: the context hook fires on every model
    // call, and a broken state store would otherwise stampede the log.
    const unavailableKey = `memory-provenance-unavailable\0${params.absolutePath}`;
    if (!provenanceExclusionWarned.has(unavailableKey)) {
      provenanceExclusionWarned.add(unavailableKey);
      params.log("memory provenance classification unavailable; injecting anyway", error);
    }
    return true;
  }
  if (isMemoryOriginEligibleForAutomaticInjection(originClass)) return true;
  const relativePath = path.basename(params.absolutePath);
  const key = `memory-provenance-exclusion\0${params.memoryHome}\0${relativePath}\0${originClass}`;
  if (!provenanceExclusionWarned.has(key)) {
    provenanceExclusionWarned.add(key);
    params.log(
      `excluding ${relativePath} from automatic memory context: memory provenance is ${originClass}`,
    );
  }
  return false;
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
