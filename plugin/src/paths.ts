// Where memory lives.
//
// LAYOUT (openclaw's agent-workspace model, unchanged)
//   openclaw keeps every memory file in the agent's single workspace:
//   `MEMORY.md`, `memory/YYYY-MM-DD.md`, `DREAMS.md` -- one home, never
//   inside the project the agent is working in. mem-plus does the same, with
//   that one home under the opencode config dir, next to the plugin's other
//   data: `~/.config/opencode/mem-plus/workspace/`. OpenCode's per-project
//   directory is not a home: projects appear in the home as directory
//   labels, not as separate stores.
//
//   <workspace-home>/MEMORY.md                promoted long-term memory (global)
//   <workspace-home>/DREAMS.md               dream diary (global, human review)
//   <workspace-home>/memory/<project-slug>/YYYY-MM-DD.md       extracted captures
//   <workspace-home>/memory/<project-slug>/YYYY-MM-DD-<slug>.md   session snapshots
//
//   The project directory is never written. What a project gets is a label:
//   its slug names the directory its captures live under, and it is the
//   `project` field on every index row.
//
//   ~/.config/opencode/mem-plus/index.db     one shared search index over the home
//
// The daily key comes from openclaw's own formatter so the file name this plugin
// writes is the same key `memory_search`'s date filter and the ingestion parser use.
import os from "node:os";
import path from "node:path";
import { formatMemoryDreamingDay } from "../../extensions/memory-core/src/capture/day.js";

export const MEMORY_DIR_NAME = "memory";
export const MEMORY_FILE_NAME = "MEMORY.md";
export const DREAMS_FILE_NAME = "DREAMS.md";

/**
 * The memory home -- the one workspace holding every memory file, openclaw's
 * agent-workspace shape, under the opencode config dir so all of mem-plus's
 * data (home, index, log, dreaming gate) lives in one place.
 */
export function memoryHomeDir(): string {
  return path.join(stateRoot(), "workspace");
}

/**
 * The project's slice of the home: `<home>/memory/<slug>`. Everything the plugin
 * writes for a project lands here, which is what keeps the project directory
 * itself untouched.
 */
export function homeProjectMemoryDir(workspaceDir: string): string {
  return path.join(memoryHomeDir(), MEMORY_DIR_NAME, projectSlug(workspaceDir));
}

/** Where a project's daily capture and snapshot files are written. */
export function memoryDir(workspaceDir: string): string {
  return homeProjectMemoryDir(workspaceDir);
}

/** Global long-term memory; dreaming's deep phase is the only writer. */
export function memoryFile(_workspaceDir: string): string {
  return path.join(memoryHomeDir(), MEMORY_FILE_NAME);
}

/** Global dream diary; dreaming's sweep summaries and reflections. */
export function dreamsFile(): string {
  return path.join(memoryHomeDir(), DREAMS_FILE_NAME);
}

export function dailyMemoryFile(workspaceDir: string, nowMs: number, timezone?: string): string {
  const day = formatMemoryDreamingDay(nowMs, timezone);
  return path.join(homeProjectMemoryDir(workspaceDir), `${day}.md`);
}

/**
 * One marker for the whole home, not one per project: the sweep is global, so
 * the gate is global. `dreaming/last-day` under the state root.
 */
export function dreamingMarker(): string {
  return path.join(stateRoot(), "dreaming", "last-day");
}

/**
 * The document corpus -- openclaw's `memory-wiki` vault, in mem-plus's layout.
 *
 * Everything the plugin writes lives under the memory home; this is the one tree
 * the *user* owns: markdown pages dropped in here (an Obsidian vault, notes,
 * exported documents) are indexed as the `wiki` corpus and stay readable without
 * the plugin. The ChatGPT importer writes its pages under `sources/`.
 */
export function wikiDir(): string {
  return path.join(stateRoot(), "wiki");
}

/**
 * `~/.config/opencode/mem-plus` -- the memory home, the shared index and the
 * plugin's own log.
 */
export function stateRoot(): string {
  return path.join(configHome(), "opencode", "mem-plus");
}

/** `$XDG_CONFIG_HOME`, else `~/.config`. On Windows that is `C:\Users\<you>\.config`. */
export function configHome(): string {
  const xdg = process.env["XDG_CONFIG_HOME"];
  return xdg && xdg.length > 0 ? xdg : path.join(os.homedir(), ".config");
}

/**
 * OpenCode's plugin API exposes no logger -- `Context` has no `log`, and
 * `console.log` from a plugin reaches neither `--print-logs` nor
 * `~/.local/share/opencode/log/opencode.log`. Without a file of its own,
 * "why was nothing remembered" has no evidence to work from.
 */
export function logFile(): string {
  return path.join(stateRoot(), "mem-plus.log");
}

/**
 * The project an indexed home file belongs to, read back out of its path.
 *
 * `<home>/memory/<project-slug>/<file>` puts the owning project in the
 * directory name, so the file already knows which project it is a copy of.
 * Deriving identity from that, rather than from whichever window happened to
 * index it, is what keeps one document from carrying a different `project`
 * in every project that touched it.
 *
 * Home-root files (`MEMORY.md` and friends) belong to no project: they
 * return `""`, which the search filter treats as "everywhere", so global
 * long-term memory stays reachable from a project-scoped search.
 *
 * Returns `""` for a path that is not under the home, so a caller can fall
 * back rather than record a bogus identity.
 */
export function homeProjectSlug(file: string): string {
  const relative = path.relative(memoryHomeDir(), path.resolve(file));
  // Outside the home, or escaping it via `..`.
  if (relative.length === 0 || relative.startsWith("..") || path.isAbsolute(relative)) return "";
  const segments = relative.split(/[\\/]+/).filter(Boolean);
  // `memory/<slug>/...` is the only per-project shape; everything else is global.
  if (segments[0] === MEMORY_DIR_NAME && segments[1]) return segments[1];
  return "";
}

/** `C:\work\repos\mem-plus` -> `mem-plus--4f2a1c` (stable, filesystem-safe). */
export function projectSlug(workspaceDir: string): string {
  const resolved = path.resolve(workspaceDir).replace(/\\/g, "/");
  const base = resolved.split("/").filter(Boolean).pop() ?? "project";
  const cleaned = base
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  // Short FNV-1a of the full path: distinguishes same-named directories without
  // leaking the rest of the path into the directory name.
  let hash = 0x811c9dc5;
  for (let i = 0; i < resolved.length; i++) {
    hash ^= resolved.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  const suffix = hash.toString(16).padStart(8, "0").slice(0, 6);
  return `${cleaned || "project"}--${suffix}`;
}

/** Turn a session title into a file-name slug; falls back to the session id. */
export function titleSlug(title: string | undefined, sessionId: string): string {
  const source = (title ?? "").trim();
  const base = source
    .toLowerCase()
    .replace(/[^a-z0-9一-鿿]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  if (base.length > 0) return base;
  return `session-${sessionId.slice(-8)}`;
}
