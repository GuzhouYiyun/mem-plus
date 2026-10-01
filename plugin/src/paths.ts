// Where memory lives.
//
// LAYOUT (openclaw's conventions, unchanged)
//   <workspace>/MEMORY.md                 promoted long-term memory
//   <workspace>/memory/YYYY-MM-DD.md      extracted captures, one block per prompt
//   <workspace>/memory/YYYY-MM-DD-<slug>.md   full session snapshot
//
//   ~/.config/opencode/mem-plus/archive/<project>/memory/<same names>
//                                       cross-project copy of every snapshot
//
// The daily key comes from openclaw's own formatter so the file name this plugin
// writes is the same key `memory_search`'s date filter and the ingestion parser use.
import os from "node:os";
import path from "node:path";
import { formatMemoryDreamingDay } from "../../extensions/memory-core/src/capture/day.js";

export const MEMORY_DIR_NAME = "memory";
export const MEMORY_FILE_NAME = "MEMORY.md";

export function memoryDir(workspaceDir: string): string {
  return path.join(workspaceDir, MEMORY_DIR_NAME);
}

export function memoryFile(workspaceDir: string): string {
  return path.join(workspaceDir, MEMORY_FILE_NAME);
}

export function dailyMemoryFile(workspaceDir: string, nowMs: number, timezone?: string): string {
  const day = formatMemoryDreamingDay(nowMs, timezone);
  return path.join(memoryDir(workspaceDir), `${day}.md`);
}

/**
 * Per-project archive under the OpenCode config directory.
 * `sanitizeProjectSlug` keeps two projects with the same basename apart.
 */
export function archiveProjectDir(workspaceDir: string): string {
  return path.join(archiveRoot(), projectSlug(workspaceDir), MEMORY_DIR_NAME);
}

export function archiveRoot(): string {
  return path.join(stateRoot(), "archive");
}

/** `~/.config/opencode/mem-plus` -- the archive plus the plugin's own log. */
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
