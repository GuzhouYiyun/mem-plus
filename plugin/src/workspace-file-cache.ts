// Copied from upstream `src/agents/workspace-file-cache.ts` (openclaw main f38495f7d,
// 2026-11-04). Body is verbatim; only the three import paths change, because the file
// now lives in `plugin/src/` -- `src/infra/lru-cache.ts` and `src/agents/
// workspace-bootstrap-read.ts` are themselves upstream copies in this tree, and
// `src/infra/path-guards.ts` re-exports the same `isPathInside`.
//
// WHY IT IS HERE: the context hook used to re-read AGENTS.md / MEMORY.md on every model
// request; upstream reads through this cache instead, keyed by file identity, so an
// unchanged file costs a stat and an edited one is visible immediately.
import { LruCache } from "../../src/infra/lru-cache.js";
import { isPathInside } from "../../src/infra/path-guards.js";
import { MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES } from "../../src/agents/workspace-bootstrap-read.js";

type WorkspaceFileCacheEntry = {
  content: string;
  identity: string;
  sizeBytes: number;
};

// One fully populated workspace fits without eviction; the entry cap also
// bounds empty files and high workspace fan-out.
const MAX_WORKSPACE_FILE_CACHE_BYTES = 6 * MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES;
const MAX_WORKSPACE_FILE_CACHE_ENTRIES = 64;
const workspaceFileCache = new LruCache<WorkspaceFileCacheEntry>(MAX_WORKSPACE_FILE_CACHE_ENTRIES, {
  maxBytes: MAX_WORKSPACE_FILE_CACHE_BYTES,
  sizeOf: (entry) => entry.sizeBytes,
});

export function readWorkspaceFileCache(filePath: string, identity: string): string | undefined {
  const entry = workspaceFileCache.get(filePath);
  if (!entry) {
    return undefined;
  }
  if (entry.identity !== identity) {
    workspaceFileCache.delete(filePath);
    return undefined;
  }
  return entry.content;
}

export function writeWorkspaceFileCache(params: {
  filePath: string;
  content: string;
  identity: string;
}): void {
  workspaceFileCache.set(params.filePath, {
    content: params.content,
    identity: params.identity,
    sizeBytes: Buffer.byteLength(params.content, "utf8"),
  });
}

export function retireWorkspaceFileCache(workspaceRoot: string): void {
  // SQLite identities are NFC even when the vanished filesystem path was not.
  // Normalize only retirement comparisons; cache reads keep raw paths distinct.
  const rootIdentityPath = workspaceRoot.normalize("NFC");
  for (const filePath of workspaceFileCache.keys()) {
    if (isPathInside(rootIdentityPath, filePath.normalize("NFC"))) {
      workspaceFileCache.delete(filePath);
    }
  }
}
