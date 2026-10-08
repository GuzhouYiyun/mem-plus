// HTTP Basic Auth for the memory browser.
//
// WHY IT EXISTS
//   The page reads the whole memory index and can rewrite the six injected
//   bootstrap files, `AGENTS.md` among them. Binding loopback keeps the LAN out,
//   but the moment `web.host` is anything else -- a LAN address, an SSH tunnel, a
//   container port -- everything that can reach the socket can read the memories
//   and edit the files that steer the agent. A password turns that into a login.
//
// SHAPE (ported from opencode-mem's `src/services/web-auth.ts`)
//   - `web.authPassword` set = enabled. Empty or absent disables it, which is the
//     default, so a loopback-only install is unaffected.
//   - `web.authUser` overrides the username; it defaults to the OS account that
//     launched OpenCode.
//   - Every request is challenged except `/api/health`, which has to stay
//     reachable: it is how a second OpenCode window decides whether the port it
//     found already belongs to a mem-plus page server (see `ownedByMemPlus`).
//   - Credentials are compared in constant time and the 401 carries
//     `Cache-Control: no-store`, so no cache can replay the challenge.
//
// This is the *network* half of the protection. The *browser* half -- a malicious
// page riding the credentials the browser just cached -- is `auth-token.ts`.
import { timingSafeEqual } from "node:crypto";
import { userInfo } from "node:os";

/** Realm string in the browser's login dialog. ASCII: some dialogs mangle it. */
export const WEB_AUTH_REALM = "mem-plus";

export type WebAuthOptions = {
  /**
   * Plain-text password, already resolved from `env://` / `file://` by
   * `readWebConfig`. Empty or whitespace = auth disabled.
   */
  password?: string;
  /** Plain-text username; defaults to the OS account name. */
  username?: string;
};

export type AuthCheckResult = {
  ok: boolean;
  /** Present only when `ok` is false: the 401 to send as-is. */
  response?: Response;
};

export class WebAuth {
  private readonly enabled: boolean;
  private readonly username: string;
  private readonly expectedUsername: Buffer;
  private readonly expectedPassword: Buffer;

  constructor(options: WebAuthOptions = {}) {
    const password = (options.password ?? "").trim();
    this.enabled = password.length > 0;
    this.username = (options.username ?? "").trim() || osUsername();
    this.expectedUsername = Buffer.from(this.username, "utf8");
    this.expectedPassword = Buffer.from(password, "utf8");
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /** The username the challenge expects; for the log line and `/api/health`. */
  getUsername(): string {
    return this.username;
  }

  /**
   * Validate the credentials on one request.
   *
   * `{ ok: true }` when auth is disabled, when the path is the health probe, or
   * when a matching `Authorization: Basic …` header is present. Otherwise the
   * 401 with its `WWW-Authenticate` challenge, so the browser pops its own login
   * dialog and caches the answer for the session.
   */
  check(request: Request, path: string): AuthCheckResult {
    if (!this.enabled) return { ok: true };
    // The ownership probe has no credentials to offer by design.
    if (path === "/api/health") return { ok: true };

    const header = request.headers.get("authorization");
    if (header) {
      const decoded = decodeBasicAuth(header);
      if (
        decoded &&
        constantTimeEquals(decoded.username, this.expectedUsername) &&
        constantTimeEquals(decoded.password, this.expectedPassword)
      ) {
        return { ok: true };
      }
    }
    return { ok: false, response: this.challenge() };
  }

  challenge(): Response {
    return new Response("Authentication required", {
      status: 401,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "www-authenticate": `Basic realm="${WEB_AUTH_REALM}", charset="UTF-8"`,
        "cache-control": "no-store",
      },
    });
  }
}

/** OS account name, with env fallbacks; `userInfo()` throws in some sandboxes. */
function osUsername(): string {
  try {
    const info = userInfo();
    if (info.username && info.username.length > 0) return info.username;
  } catch {
    // fall through to the env vars below
  }
  for (const name of ["USER", "USERNAME"]) {
    const value = process.env[name];
    if (value && value.length > 0) return value;
  }
  return "user";
}

/**
 * Compare without leaking the length through timing. A length mismatch still
 * runs a dummy compare so the call duration does not depend on the input.
 */
function constantTimeEquals(provided: string, expected: Buffer): boolean {
  const given = Buffer.from(provided ?? "", "utf8");
  if (given.length !== expected.length) {
    timingSafeEqual(expected, expected);
    return false;
  }
  return timingSafeEqual(given, expected);
}

function decodeBasicAuth(header: string): { username: string; password: string } | null {
  if (!header.toLowerCase().startsWith("basic ")) return null;
  const encoded = header.slice(6).trim();
  if (!encoded) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(encoded, "base64").toString("utf8");
  } catch {
    return null;
  }
  // Split on the FIRST colon: a password may contain colons, a username may not.
  const colon = decoded.indexOf(":");
  if (colon === -1) return null;
  return { username: decoded.slice(0, colon), password: decoded.slice(colon + 1) };
}
