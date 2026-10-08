// mem-plus's settings, read and written where they now live: the plugin's own
// `~/.config/opencode/mem-plus/config.jsonc`.
//
// This module used to edit one node span inside OpenCode's `opencode.jsonc`.
// That arrangement is gone for a reason worth keeping in mind: `plugins[].options`
// only exists when the plugin is registered there, so anyone using directory
// auto-discovery had nowhere to set anything -- and registering a second copy to
// get settings meant two copies loaded. Owning the file removes the constraint.
// See `plugin/src/config-file.ts` for the precedence and the opencode-mem precedent.
//
// What survives of the old discipline, and why:
//   - sha256 optimistic concurrency, so two windows cannot clobber each other.
//   - Refusing a file with syntax errors rather than writing over it.
//   - Per-key span edits, so a comment the user wrote survives a save from the
//     page. That one is politeness rather than safety -- this is our file -- but
//     rewriting a commented document to change one number is rude either way.
//   - Secrets never cross the wire: `authPassword` reads back as "is it set".
import { readConfigFile, writeConfigFile } from "../config-file.js";
import { stateRoot } from "../paths.js";

/** Options that are secrets: reported as set / not set, never returned. */
const SECRET_KEYS = ["authPassword"] as const;

export type PluginSettingsRead = {
  path: string;
  exists: boolean;
  sha256: string;
  bytes: number;
  modifiedAt?: string;
  /** The options as written, minus the secrets. */
  options: Record<string, unknown> | null;
  /** Which secret paths are set, at any depth, without their values. */
  secrets: Record<string, boolean>;
  parseErrors: { offset: number; length: number; message: string }[];
  error?: string;
};

/**
 * Redact secret values at any depth, keeping the path so the form can show
 * "已设置" instead of an empty box it might overwrite.
 *
 * Depth matters: it is `web.authPassword`, not `authPassword`, and a shallow pass
 * would happily ship the password to the browser.
 */
function redactSecrets(
  options: Record<string, unknown>,
  prefix = "",
  secrets: Record<string, boolean> = {}
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(options)) {
    const at = prefix ? `${prefix}.${key}` : key;
    if ((SECRET_KEYS as readonly string[]).includes(key)) {
      secrets[at] = typeof value === "string" && value.length > 0;
      continue;
    }
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      out[key] = redactSecrets(value as Record<string, unknown>, at, secrets);
      continue;
    }
    out[key] = value;
  }
  return out;
}

export function readPluginConfig(): PluginSettingsRead {
  const read = readConfigFile(stateRoot());
  const base: PluginSettingsRead = {
    path: read.path,
    exists: read.exists,
    sha256: read.sha256,
    bytes: read.bytes,
    ...(read.modifiedAt ? { modifiedAt: read.modifiedAt } : {}),
    options: null,
    secrets: {},
    parseErrors: read.parseErrors,
    ...(read.error ? { error: read.error } : {}),
  };
  if (!read.exists || read.error) return base;

  // `redactSecrets` fills the map as it walks, so it is only meaningful after the
  // call. Reading its return value instead silently yields the options.
  const secrets: Record<string, boolean> = {};
  const redacted = redactSecrets(read.options, "", secrets);
  return { ...base, options: redacted, secrets };
}

export type SettingsWriteResult =
  | { ok: true; path: string; sha256: string; unchanged: boolean }
  | { ok: false; status: number; error: string; detail?: string };

/**
 * Save the settings.
 *
 * A secret the page never received must survive: the form shows "已设置" and sends
 * back nothing, so a round trip through the page must not delete the password.
 * Only an explicit empty string clears one.
 */
export function savePluginConfig(params: {
  options: unknown;
  sha256?: string;
  /** Create the file when it is absent -- the page's "create" button. */
  create?: boolean;
}): SettingsWriteResult {
  const { options, sha256, create } = params;
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    return { ok: false, status: 400, error: "options must be a JSON object" };
  }
  const incoming = options as Record<string, unknown>;
  const existing = readPluginConfig().options ?? {};
  const merged = mergePreservingSecrets(existing, incoming);

  // A secret the page was never given cannot be cleared by writing an empty value
  // -- the key is absent from `existing` (it was redacted), so "delete" is the only
  // way to express it. Collected here, applied by the writer.
  const remove: string[] = [];
  collectSecretClears(incoming, "", remove);

  return writeConfigFile({
    stateRoot: stateRoot(),
    options: merged,
    sha256: sha256 ?? "",
    remove,
    ...(create === true ? { create: true } : {}),
  });
}

/** Dotted paths where a secret was explicitly set to `""`. */
function collectSecretClears(value: unknown, prefix: string, out: string[]): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const at = prefix ? `${prefix}.${key}` : key;
    if ((SECRET_KEYS as readonly string[]).includes(key)) {
      if (child === "") out.push(at);
      continue;
    }
    collectSecretClears(child, at, out);
  }
}

function mergePreservingSecrets(
  existing: Record<string, unknown>,
  incoming: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...existing };
  for (const [key, value] of Object.entries(incoming)) {
    const before = existing[key];
    if (
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      typeof before === "object" &&
      before !== null &&
      !Array.isArray(before)
    ) {
      out[key] = mergePreservingSecrets(
        before as Record<string, unknown>,
        value as Record<string, unknown>
      );
      continue;
    }
    if (value === "" && (SECRET_KEYS as readonly string[]).includes(key)) {
      delete out[key];
      continue;
    }
    out[key] = value;
  }
  return out;
}
