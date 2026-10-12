// Project scoping for recall: which repository a memory belongs to, and which
// repositories the current session is working in.
//
// UPSTREAM: `src/agents/project-memory-scope.ts` (openclaw), ported whole. That file
// is not vendored here, and neither is its one missing dependency
// (`src/infra/lru-cache.ts`); `src/plugins/plugin-lru-cache.ts` exposes the same
// `get`/`set` surface and is used instead.
//
// WHAT THIS IS FOR
//   Upstream does not partition memory files by repository. It annotates each entry
//   with `<!-- project: KEY -->` and filters at injection and ranking time, so a new
//   session starts with an empty active-key set and therefore sees nothing scoped to
//   another repository. mem-plus had the reader half (`extractProjectKeysFromCuratedEntry`
//   feeding `units.project_key`, the trigger gate, and `buildProjectMemoryBootstrap`)
//   and no writer, so every entry was unannotated, which upstream defines as *global*.
//   That is the shape of the cross-session leak: a curated entry from one repository
//   injected into a session working in another.
//
// KEY IDENTITY
//   `resolveUncachedProjectKey` is upstream verbatim in behaviour: the normalised
//   `origin` remote when there is one, so ordinary clones and linked worktrees of the
//   same repository converge and forks (different remotes) stay apart; the canonical
//   local root otherwise. Host is lower-cased, remote path case is preserved — see the
//   upstream comments for why folding either way is the wrong trade.
//
// ACTIVE KEYS
//   Upstream keeps at most four, most-recent-first, per session, and never persists
//   them. A session's directory can change under it (OpenCode emits `location-switched`),
//   so a session legitimately holds more than one key over its life; that is why this
//   is a set with an eviction policy rather than a single value.
import path from "node:path";
import { PluginLruCache } from "../../src/plugins/plugin-lru-cache.js";
import { runCommandWithTimeout } from "../../src/process/exec.js";
import { parseGitUrl } from "../../src/agents/utils/git.js";
import {
  extractProjectKeysFromCuratedEntry,
  normalizeProjectAnnotationKey,
  splitCuratedMarkdownEntries,
} from "../../packages/memory-host-sdk/src/engine-storage.js";

/** Upstream's `MAX_PROJECT_KEY_CACHE_ENTRIES`. */
const MAX_PROJECT_KEY_CACHE_ENTRIES = 128;
/** Upstream's `GIT_CONFIG_TIMEOUT_MS`; matches its note about cheap git reads. */
const GIT_CONFIG_TIMEOUT_MS = 4_000;
/** Upstream's per-session cap on recently active repository keys. */
const MAX_ACTIVE_PROJECT_KEYS = 4;

const projectKeyByRepoRoot = new PluginLruCache<Promise<string>>(
  MAX_PROJECT_KEY_CACHE_ENTRIES,
);

/**
 * Upstream's `escapeProjectKeyForAnnotation`. `%` first: it is the escape character
 * for the rest, so escaping it late would produce keys that unescape to something else.
 */
function escapeProjectKeyForAnnotation(value: string): string {
  return value
    .replaceAll("%", "%25")
    .replaceAll(";", "%3b")
    .replaceAll("<", "%3c")
    .replaceAll(">", "%3e")
    .replaceAll("\r", "%0d")
    .replaceAll("\n", "%0a");
}

/**
 * Upstream's `resolveUncachedProjectKey`. Userinfo is deliberately folded out so SSH
 * and HTTPS clones of one repository agree; upstream accepts the resulting rare
 * same-host/same-path collision across SSH accounts as the lesser evil.
 */
async function resolveUncachedProjectKey(repoRoot: string): Promise<string> {
  try {
    const result = await runCommandWithTimeout(
      ["git", "-C", repoRoot, "config", "--get", "remote.origin.url"],
      { timeoutMs: GIT_CONFIG_TIMEOUT_MS },
    );
    if (result.code === 0) {
      const source = parseGitUrl(`git:${result.stdout.trim()}`);
      if (source) {
        return escapeProjectKeyForAnnotation(
          `${source.host.toLowerCase()}/${source.path}`,
        );
      }
    }
  } catch {
    // Repositories without an origin intentionally use their canonical local root.
  }
  return `path:${escapeProjectKeyForAnnotation(repoRoot)}`;
}

/** Upstream's `resolveProjectKey`: one stable identity per root, git spawned once. */
export function resolveProjectKey(repoRoot: string): Promise<string> {
  const canonicalRoot = path.resolve(repoRoot);
  const cached = projectKeyByRepoRoot.get(canonicalRoot);
  if (cached) return cached;
  const pending = resolveUncachedProjectKey(canonicalRoot);
  projectKeyByRepoRoot.set(canonicalRoot, pending);
  return pending;
}

/**
 * The active-key sets, one per session.
 *
 * Upstream holds this in session runtime state that is never persisted: a new session
 * or a new process begins with an empty set, which is precisely what makes a fresh
 * conversation inherit nothing scoped to another repository. Keyed by session so a
 * session that moves between directories accumulates keys without any other session
 * seeing them.
 */
const activeKeysBySession = new Map<string, string[]>();

/** Remember a repository as one this session is working in, most recent first. */
export async function prepareActiveProjectKey(
  sessionID: string,
  repoRoot: string,
): Promise<string> {
  const resolved = await resolveProjectKey(repoRoot);
  const existing = activeKeysBySession.get(sessionID) ?? [];
  const next = [resolved, ...existing.filter((entry) => entry !== resolved)];
  activeKeysBySession.set(sessionID, next.slice(0, MAX_ACTIVE_PROJECT_KEYS));
  return resolved;
}

/** The session's active keys, most recent first. Empty for a session never prepared. */
export function activeProjectKeys(sessionID: string): readonly string[] {
  return activeKeysBySession.get(sessionID) ?? [];
}

/** Drop a session's set. Called on plugin dispose so a reload does not leak them. */
export function clearActiveProjectKeys(sessionID?: string): void {
  if (sessionID === undefined) activeKeysBySession.clear();
  else activeKeysBySession.delete(sessionID);
}

/**
 * Upstream's `filterProjectScopedCuratedContextFiles`, narrowed to one file's text.
 *
 * Upstream applies it to the curated context files the host is about to inject; the
 * rule is unchanged here. An entry survives when it carries no `project` annotation
 * (upstream's "unannotated means global") or when it is annotated, valid, and every
 * one of its keys is active. An entry that is annotated but malformed is dropped --
 * `extractProjectKeysFromCuratedEntry` reports `valid: false` for a key count that
 * disagrees with the marker count, and upstream's filter requires `valid` before it
 * admits anything.
 *
 * Splitting is upstream's `splitCuratedMarkdownEntries`; it is imported rather than
 * reimplemented because the entry boundary decides which annotations belong to which
 * entry, and a second boundary rule here would silently scope the wrong lines.
 */
export function filterProjectScopedCuratedContext(
  content: string,
  keys: readonly string[],
): string {
  const active = new Set(
    keys.map((key) => normalizeProjectAnnotationKey(key)).filter((key): key is string => Boolean(key)),
  );
  if (active.size === 0) {
    // No repository is active for this session. Upstream's filter would keep every
    // unannotated entry, but it is only ever reached with a prepared repository, and
    // injecting a curated file wholesale into a session that has not prepared one is
    // exactly the leak this function exists to close.
    return "";
  }
  return splitCuratedMarkdownEntries(content)
    .filter((entry) => {
      const annotations = extractProjectKeysFromCuratedEntry(entry.text);
      return (
        !annotations.annotated ||
        (annotations.valid && annotations.keys.every((key) => active.has(key)))
      );
    })
    .map((entry) => entry.text)
    .join("\n");
}