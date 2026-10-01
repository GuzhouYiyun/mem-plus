// A log file the plugin owns.
//
// WHY THIS EXISTS
//   OpenCode V2's plugin `Context` has no logging API, and a plugin's
//   `console.log` reaches neither `--print-logs` nor
//   `~/.local/share/opencode/log/opencode.log`. Verified on 2026-10-01 against
//   a plugin that loads models and writes files: zero of its output appeared
//   anywhere. So without a file of its own, "why was nothing remembered" has no
//   evidence to work from, and the only way to find out is to add print
//   statements and re-run.
//
//   `~/.config/opencode/mem-plus/mem-plus.log` is documented in the README for
//   exactly this.
//
// FAILURE POLICY
//   Logging must never be able to break memory capture. Every write is wrapped:
//   if the log cannot be opened, appended to, or rotated, the message goes to
//   the console instead and nothing throws.
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import path from "node:path";
import { logFile } from "./paths.js";

/** Rotate past this so the log cannot grow without bound on a long-lived install. */
const MAX_BYTES = 2 * 1024 * 1024;

/** Keep the rotated file rather than an unbounded `.1`, `.2`, ... chain. */
const ROTATED_SUFFIX = ".1";

let directoryReady = false;
let broken = false;

function ensureDirectory(file: string): boolean {
  if (directoryReady) return true;
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    directoryReady = true;
    return true;
  } catch {
    return false;
  }
}

function rotateIfOversized(file: string): void {
  try {
    const stats = statSync(file);
    if (stats.size < MAX_BYTES) return;
    // Rename first: losing the oldest log is better than interleaving a
    // half-written line if the process dies mid-rotation.
    renameSync(file, file + ROTATED_SUFFIX);
  } catch {
    // No file yet, or it vanished under us -- either way there is nothing to do.
  }
}

function render(detail: unknown): string {
  if (detail === undefined) return "";
  if (detail instanceof Error) return ` :: ${detail.message}`;
  if (typeof detail === "string") return ` :: ${detail}`;
  try {
    return ` :: ${JSON.stringify(detail)}`;
  } catch {
    return ` :: ${String(detail)}`;
  }
}

/**
 * @param prefix Tag every line with this, so interleaved output from several
 *   plugins or several project windows stays attributable.
 */
export function createLogger(prefix: string): (message: string, detail?: unknown) => void {
  const file = logFile();
  return (message: string, detail?: unknown) => {
    const line = `${new Date().toISOString()} ${prefix} ${message}${render(detail)}`;
    // The console copy is best-effort and mostly ignored: it shows up when
    // OpenCode happens to forward stdout, and costs nothing when it does not.
    try {
      console.log(line);
    } catch {
      /* stdout closed */
    }
    if (broken) return;
    try {
      if (!ensureDirectory(file)) {
        broken = true;
        return;
      }
      rotateIfOversized(file);
      appendFileSync(file, `${line}\n`, "utf8");
    } catch {
      // One failed write means the path is unusable (read-only home, permission
      // change). Stop trying rather than paying a syscall per log line.
      broken = true;
    }
  };
}

/** Absolute path, for the README and for "where do I look?" messages. */
export { logFile };