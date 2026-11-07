// Check whether a newer mem-plus release exists on GitHub.
//
// WHY THIS IS IN THE PLUGIN AND NOT THE INSTALLER
//   The installer is a self-contained exe with the payload embedded; it has no
//   network path to a new release and no version of itself to compare against at
//   install time. The plugin, by contrast, already runs an HTTP server and already
//   talks to the network (the runtime-update check in api.ts hits the same API).
//   So the "is there a newer version" question belongs here, and the answer reaches
//   the user through the settings page rather than through a separate updater.
//
// WHAT IT DOES NOT DO
//   It does not download or apply anything. The installer is the only artifact a
//   user can run, so the loop closes on a click to the Releases page -- the same
//   page the banner links to. This is the deliberate shape: notify, let the person
//   decide, never swap files silently.
//
// VERSION SOURCE
//   `package.json` at the plugin root, read at check time rather than captured at
//   load: a dev-loop mirror that updates the live zone changes the file under a
//   running plugin, and a captured value would report the version that was
//   *loaded*, not the one that is *installed*.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
// plugin/src/update-check.ts -> plugin -> <root>/package.json
const PACKAGE_JSON = path.resolve(HERE, "..", "..", "package.json");

export type UpdateCheckResult = {
  /** The version the running plugin reports from its own package.json. */
  current: string;
  /** The newest non-prerelease tag on the repo, or null when the API did not say. */
  latest: string | null;
  /** True when `latest` is a strictly higher semver than `current`. */
  updateAvailable: boolean;
  /** The URL the user clicks to download the newer installer. */
  releaseUrl: string;
};

/**
 * Read the plugin's own version. Returns the empty string when the file is
 * unreadable (a dev build with no package.json) rather than throwing: a missing
 * version is a degraded check, not a plugin failure.
 */
export function readPluginVersion(): string {
  try {
    const parsed = JSON.parse(readFileSync(PACKAGE_JSON, "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version.trim() : "";
  } catch {
    return "";
  }
}

/** Parse a `X.Y.Z` string into a comparable triple; unparseable -> null. */
function parseSemver(version: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** True when `a` is strictly greater than `b`, both parseable. */
function newerThan(a: string, b: string): boolean {
  const va = parseSemver(a);
  const vb = parseSemver(b);
  if (!va || !vb) return false;
  return va[0] > vb[0] || (va[0] === vb[0] && (va[1] > vb[1] || (va[1] === vb[1] && va[2] > vb[2])));
}

/**
 * One anonymous GitHub API call for the newest release tag. Unauthenticated
 * calls share the per-IP 60/hour budget with everything else on the network, so
 * the result is cached and the failure path is silent: a refused check shows
 * nothing, which is the right answer for a network blip.
 *
 * The cache is keyed on the current version rather than time-based, because
 * what changes between checks is rarely the version: a page refresh or a
 * second OpenCode window hitting the same plugin process would otherwise spend
 * two of the budget. A `force` flag busts it for the manual refresh button.
 * Successes only -- a failed call leaves nothing cached, so the next page load
 * retries instead of replaying the null.
 */
let cache: { version: string; result: UpdateCheckResult } | null = null;

export async function checkForUpdate(force = false): Promise<UpdateCheckResult> {
  const current = readPluginVersion();
  const releaseUrl = "https://github.com/GuzhouYiyun/mem-plus/releases";
  if (!current) {
    return { current: "", latest: null, updateAvailable: false, releaseUrl };
  }

  if (!force && cache && cache.version === current) return cache.result;

  let latest: string | null = null;
  try {
    const res = await fetch("https://api.github.com/repos/GuzhouYiyun/mem-plus/releases?per_page=20", {
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "mem-plus",
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) {
      const items = (await res.json()) as Array<{ tag_name?: unknown; prerelease?: unknown }>;
      // Pick the newest non-prerelease tag. GitHub's list is newest-first, so the
      // first match is the answer -- but a prerelease must not shadow a stable one
      // further down, hence the filter rather than a first-wins.
      for (const item of items) {
        if (typeof item.tag_name !== "string") continue;
        if (item.prerelease === true) continue;
        const tag = item.tag_name.replace(/^v/, "");
        if (parseSemver(tag)) {
          latest = tag;
          break;
        }
      }
    }
  } catch {
    // fall through: latest stays null, updateAvailable false
  }

  const result: UpdateCheckResult = {
    current,
    latest,
    updateAvailable: latest !== null && newerThan(latest, current),
    releaseUrl,
  };
  // Cache successes only. A mortal GitHub blip (the repo's own notes list the
  // intermittently blocked 443 with api.github.com answering) must not be
  // pinned to the current version forever: the next page load retries, and the
  // version key keeps spending the anonymous 60/h budget only on answers.
  if (latest !== null) {
    cache = { version: current, result };
  }
  return result;
}