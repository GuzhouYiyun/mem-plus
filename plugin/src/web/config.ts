// Where the memory browser is served from, whether it is served at all, and who
// has to log in to see it.
//
// Mirrors opencode-mem's `webServerEnabled` / `webServerPort` / `webServerHost` /
// `webServerAuthPassword` / `webServerAuthUsername` keys, under mem-plus's names:
//
//   "plugins": [{ "package": "mem-plus", "options": {
//     "web": {
//       "enabled": true, "port": 4747, "host": "127.0.0.1", "dir": "...",
//       "authPassword": "env://MEM_PLUS_WEB_PASSWORD", "authUser": "me"
//     }
//   }}]
//
// `dir` points at a built bundle (`npm --prefix web run build`). Unset means
// "look next to the package", which is where it lives in an install and in a
// checkout alike.
//
// `authPassword` takes the same secret forms opencode-mem's `webServerAuthPassword`
// does: a literal, `env://NAME`, or `file:///path/to/secret`.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export type WebConfig = {
  /** `web.enabled: false` keeps the port closed. The page is never needed by the agent. */
  readonly enabled: boolean;
  readonly port: number;
  readonly host: string;
  /** Bundle directory override; empty string = auto-detect. */
  readonly dir: string;
  /** HTTP Basic Auth password; empty string = open, which is the default. */
  readonly authPassword: string;
  /** Basic Auth username; empty string = the OS account name. */
  readonly authUser: string;
};

export const DEFAULT_WEB_PORT = 4747;

/** Permissive read: `ctx.options` is untyped JSON supplied by opencode.json(c). */
export function readWebConfig(options: unknown): WebConfig {
  const root =
    typeof options === "object" && options !== null ? (options as Record<string, unknown>) : {};
  const nested =
    typeof root["web"] === "object" && root["web"] !== null
      ? (root["web"] as Record<string, unknown>)
      : {};
  const port = typeof nested["port"] === "number" && Number.isInteger(nested["port"])
    ? (nested["port"] as number)
    : DEFAULT_WEB_PORT;
  const host = typeof nested["host"] === "string" && nested["host"].trim().length > 0
    ? nested["host"].trim()
    : "127.0.0.1";
  const dir = typeof nested["dir"] === "string" ? nested["dir"].trim() : "";
  return {
    enabled: nested["enabled"] !== false,
    port,
    host,
    dir,
    authPassword: readSecret(nested["authPassword"]),
    authUser: typeof nested["authUser"] === "string" ? nested["authUser"].trim() : "",
  };
}

/**
 * A secret from config: literal, `env://NAME`, or `file:///path`.
 *
 * Same three forms opencode-mem accepts for `memoryApiKey` and
 * `webServerAuthPassword`, so a config written for either plugin works here. An
 * unreadable env var or file yields an empty string, which reads as "auth
 * disabled" -- and `startWebServer` logs that, because silently serving an
 * unprotected page because a path was wrong is the worse failure.
 */
function readSecret(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const value = raw.trim();
  if (value.length === 0) return "";

  if (value.startsWith("env://")) {
    const name = value.slice("env://".length).trim();
    return (process.env[name] ?? "").trim();
  }

  if (value.startsWith("file://")) {
    try {
      // `fileURLToPath` handles percent-escapes and Windows drive letters, which
      // a bare `new URL().pathname` gets wrong.
      return readFileSync(fileURLToPath(value), "utf-8").trim();
    } catch {
      return "";
    }
  }

  return value;
}

/**
 * What the log should say about the auth state, without leaking the secret.
 * Returns a warning to print, or null when there is nothing to say.
 */
export function describeAuth(config: WebConfig): string | null {
  if (config.authPassword) return null;
  if (isLoopbackHost(config.host)) return null;
  return (
    `"web.host" is ${config.host} (not loopback) and no "web.authPassword" is set: ` +
    `anyone who can reach this port can read your memories and edit the injected files`
  );
}

/** True for 127.0.0.0/8, ::1, `localhost` and the empty host. */
export function isLoopbackHost(host: string): boolean {
  if (host === "" || host === "localhost" || host === "::1" || host === "[::1]") return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}
