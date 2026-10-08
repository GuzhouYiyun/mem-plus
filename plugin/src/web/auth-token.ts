// The per-install CSRF token, ported from opencode-mem's `src/services/auth-token.ts`.
//
// WHY IT IS ALWAYS ON, NOT A CONFIG FLAG
//   A password gates the network. It does not gate the *browser*: once the user
//   has typed it, the browser replays those credentials on every same-origin
//   request for the rest of the session, so any page on the internet can make
//   the user's browser issue an authenticated request -- including
//   `PUT /api/prompt-files`, which rewrites `AGENTS.md`. That is textbook CSRF.
//
//   The token closes it. It is a random secret that only script running inside
//   the served bundle can read: the server injects it into `index.html` as
//   `window.__MEM_PLUS_TOKEN__`, and a cross-origin page cannot get at it,
//   because the server sends no CORS headers, so reading the response fails as
//   an opaque response. It is required on every `/api/*` call except the health
//   probe, so `fetch` from a hostile page has nothing to send.
//
// WHERE IT LIVES
//   `<state root>/.auth-token`, mode 0600 -- next to `index.db` and the log, not
//   inside the memory home, because it is plugin state rather than memory.
//   Generated on first start; a user-only-readable file, so on POSIX the
//   `mode: 0o600` below plus an explicit `chmod` covers the umask gap.
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { platform } from "node:os";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { stateRoot } from "../paths.js";

const TOKEN_FILE = join(stateRoot(), ".auth-token");

/** Header the page sends it in. mem-plus names it after itself. */
export const AUTH_HEADER = "x-mem-plus-token";

let cached: string | null = null;

export function authTokenFile(): string {
  return TOKEN_FILE;
}

/**
 * The shared secret: read from disk, or generated and persisted on first use.
 *
 * Failures are not fatal. The page only reads memories on the user's own machine,
 * so a read-only or unwritable state root must not stop the server -- the token
 * just lives in memory for this process, which still stops a browser on another
 * site from forging API calls, and stops working again after a restart.
 */
export function getOrCreateAuthToken(): string {
  if (cached) return cached;

  try {
    if (existsSync(TOKEN_FILE)) {
      const existing = readFileSync(TOKEN_FILE, "utf-8").trim();
      if (existing) {
        cached = existing;
        return cached;
      }
    }
  } catch {
    // Unreadable file: fall through and mint a fresh in-memory token.
  }

  const token = randomBytes(32).toString("hex");
  try {
    mkdirSync(stateRoot(), { recursive: true });
    writeFileSync(TOKEN_FILE, token, { mode: 0o600 });
    // `mode` is masked by the umask on some POSIX systems; `chmod` is the
    // authoritative version. No-op meaning on Windows, which has no POSIX mode.
    if (platform() !== "win32") {
      try {
        chmodSync(TOKEN_FILE, 0o600);
      } catch {
        // best effort; the file was created 0600 above
      }
    }
  } catch {
    // Unwritable state root: keep the token in memory only.
  }
  cached = token;
  return cached;
}

/**
 * Whether this request carries the token. Constant-time: a wrong guess must not
 * be able to recover the token one byte at a time by timing the rejections.
 */
export function isAuthorizedApiRequest(request: Request): boolean {
  const expected = Buffer.from(getOrCreateAuthToken(), "utf8");
  const provided = Buffer.from(request.headers.get(AUTH_HEADER) ?? "", "utf8");
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}
