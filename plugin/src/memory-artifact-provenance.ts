// Per-file write provenance: the record that makes "who wrote this" unforgeable.
//
// PORTED from openclaw `src/memory/memory-artifact-provenance.ts` (232 lines).
//
// WHY THIS EXISTS
//   Provenance is the security boundary of the whole memory system, and it has to be
//   stored somewhere the model cannot reach. Upstream keeps one record per memory
//   artifact, keyed by the file's content hash, in the plugin-state keyed store, and the
//   classifier reads it back at index time. Nothing in a markdown file can change it.
//
// THE DOWNGRADE RULE IS THE POINT
//   `recordMemoryArtifactWriteProvenance` keeps a write's `agent` class only when the file
//   it is extending is byte-identical to what the agent last wrote. A human edit in
//   between -- or anything else touching the file -- and the next agent append is recorded
//   as `untrusted`. That single comparison is what stops an agent from claiming ownership
//   of content it did not write.
//
// ONE ADAPTATION: the project prefix in memory paths
//   Upstream's memory lives at `<workspace>/memory/<date>.md`. mem-plus keeps one home per
//   project under `<memory home>/<project-slug>/memory/<date>.md`, so a path segment
//   precedes `memory/`. `isMemorySubtreePath` accepts both shapes; that is the only
//   behavioural difference from upstream, and it exists because of the layout, not because
//   of the host.
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import path from "node:path";
import { sha256Hex } from "../../packages/normalization-core/src/node-crypto.js";
import { isMissingPathError } from "../../src/infra/errno.js";
import { openMemoryCoreStateStore } from "../../extensions/memory-core/src/dreaming-state.js";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";

const MEMORY_ARTIFACT_PROVENANCE_NAMESPACE = "workspace-files";
const MEMORY_ARTIFACT_PROVENANCE_MAX_ENTRIES = 50_000;

export type MemoryArtifactOriginClass = "agent" | "untrusted";

export type MemoryArtifactProvenance = {
  fileHash: string;
  originClass: MemoryArtifactOriginClass;
  observedAt: number;
  sessionId?: string;
  sessionKey?: string;
};

type StoredMemoryArtifactProvenance = MemoryArtifactProvenance & {
  version: 1;
  workspaceKey: string;
  relativePath: string;
  reservationId: string;
};

type MemoryArtifactAddress = {
  workspaceKey: string;
  relativePath: string;
  storeKey: string;
};

function normalizeWorkspaceKey(workspaceDir: string): string {
  const resolved = path.resolve(workspaceDir);
  let canonical = resolved;
  try {
    // Provenance follows the physical workspace so symlink or junction aliases
    // cannot split the writer and reader into different trust records.
    canonical = realpathSync.native(resolved);
  } catch (error) {
    if (!isMissingPathError(error)) {
      throw error;
    }
  }
  const normalized = canonical.replaceAll("\\", "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

/**
 * `memory/<date>.md` (upstream) or `<project>/memory/<date>.md` (mem-plus's home layout).
 * The dreaming directories are excluded upstream and stay excluded.
 */
function isMemorySubtreePath(normalized: string): boolean {
  if (!normalized.endsWith(".md")) return false;
  const segments = normalized.split("/");
  const start = segments[0] === "memory" ? 0 : segments.length >= 2 && segments[1] === "memory" ? 1 : -1;
  if (start < 0) return false;
  if (normalized.startsWith("memory/dreaming/") || normalized.startsWith("memory/.dreams/")) {
    return false;
  }
  return segments.length > start + 1;
}

export function normalizeMemoryArtifactRelativePath(relativePath: string): string | undefined {
  const normalized = relativePath.replaceAll("\\", "/");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    normalized.split("/").some((segment) => segment === "..")
  ) {
    return undefined;
  }
  if (["MEMORY.md", "memory.md", "USER.md"].includes(normalized)) {
    return normalized;
  }
  if (/^users\/[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}\/USER\.md$/.test(normalized)) {
    return normalized;
  }
  if (!normalized.startsWith("memory/") && !isMemorySubtreePath(normalized)) {
    return undefined;
  }
  if (normalized.startsWith("memory/dreaming/") || normalized.startsWith("memory/.dreams/")) {
    return undefined;
  }
  return normalized;
}

function resolveAddress(params: {
  workspaceDir: string;
  relativePath: string;
}): MemoryArtifactAddress | undefined {
  const relativePath = normalizeMemoryArtifactRelativePath(params.relativePath);
  if (!relativePath) {
    return undefined;
  }
  const workspaceKey = sha256Hex(normalizeWorkspaceKey(params.workspaceDir));
  return {
    workspaceKey,
    relativePath,
    storeKey: `${workspaceKey}:${sha256Hex(relativePath)}`,
  };
}

function openStore(): Required<PluginStateKeyedStore<StoredMemoryArtifactProvenance>> {
  // The same opener the dreaming state uses, i.e. the same host store. Upstream calls
  // `createCorePluginStateKeyedStore`, whose backend is openclaw's plugin-state SQLite
  // database; mem-plus's plugin state *is* `ctx.storage` (see `kv.ts`), which is already
  // bridged to this exact `OpenKeyedStoreOptions` contract. One store, one configuration
  // point. What is lost is only the `ownerId` wrapper, which `openKeyedStore` does not
  // take -- the namespace below carries the same separation.
  //
  // The cast is what openclaw's own core store does by returning `Required<...>`:
  // `PluginStateKeyedStore` marks `update`/`deleteIf`/`lookup` optional because a backend
  // may omit them, and the `ctx.storage` bridge implements all three.
  return openMemoryCoreStateStore<StoredMemoryArtifactProvenance>({
    namespace: MEMORY_ARTIFACT_PROVENANCE_NAMESPACE,
    maxEntries: MEMORY_ARTIFACT_PROVENANCE_MAX_ENTRIES,
    overflowPolicy: "reject-new",
  }) as Required<PluginStateKeyedStore<StoredMemoryArtifactProvenance>>;
}

function normalizeStoredProvenance(
  value: StoredMemoryArtifactProvenance | undefined,
  address: MemoryArtifactAddress,
): StoredMemoryArtifactProvenance | undefined {
  if (
    value?.version !== 1 ||
    value.workspaceKey !== address.workspaceKey ||
    value.relativePath !== address.relativePath ||
    !/^[a-f0-9]{64}$/u.test(value.fileHash) ||
    (value.originClass !== "agent" && value.originClass !== "untrusted") ||
    !Number.isSafeInteger(value.observedAt) ||
    typeof value.reservationId !== "string" ||
    value.reservationId.length === 0
  ) {
    return undefined;
  }
  return value;
}

function toPublicProvenance(stored: StoredMemoryArtifactProvenance): MemoryArtifactProvenance {
  return {
    fileHash: stored.fileHash,
    originClass: stored.originClass,
    observedAt: stored.observedAt,
    ...(stored.sessionId ? { sessionId: stored.sessionId } : {}),
    ...(stored.sessionKey ? { sessionKey: stored.sessionKey } : {}),
  };
}

export async function recordMemoryArtifactWriteProvenance(params: {
  workspaceDir: string;
  relativePath: string;
  contentBefore: string;
  contentAfter: string;
  originClass: MemoryArtifactOriginClass;
  observedAt: number;
  sessionId?: string;
  sessionKey?: string;
}): Promise<(() => Promise<void>) | undefined> {
  const address = resolveAddress(params);
  if (!address) {
    return undefined;
  }
  const store = openStore();
  const reservationId = randomUUID();
  let previous: StoredMemoryArtifactProvenance | undefined;
  await store.update(address.storeKey, (current) => {
    previous = normalizeStoredProvenance(current, address);
    const originClass =
      params.originClass === "agent" &&
      (!previous ||
        (previous.originClass === "agent" && previous.fileHash === sha256Hex(params.contentBefore)))
        ? "agent"
        : "untrusted";
    return {
      version: 1,
      workspaceKey: address.workspaceKey,
      relativePath: address.relativePath,
      fileHash: sha256Hex(params.contentAfter),
      originClass,
      observedAt: params.observedAt,
      ...(params.sessionId ? { sessionId: params.sessionId } : {}),
      ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
      reservationId,
    };
  });

  return async () => {
    const rollbackStore = openStore();
    if (previous) {
      await rollbackStore.update(address.storeKey, (current) =>
        current?.reservationId === reservationId ? previous : undefined,
      );
      return;
    }
    await rollbackStore.deleteIf(
      address.storeKey,
      (current) => current.reservationId === reservationId,
    );
  };
}

export async function clearMemoryArtifactProvenance(params: {
  workspaceDir: string;
  relativePath: string;
  contentBefore: string;
}): Promise<void> {
  const address = resolveAddress(params);
  if (!address) {
    return;
  }
  const expectedHash = sha256Hex(params.contentBefore);
  await openStore().deleteIf(address.storeKey, (current) => current.fileHash === expectedHash);
}

export async function readMemoryArtifactProvenance(params: {
  workspaceDir: string;
  relativePath: string;
}): Promise<MemoryArtifactProvenance | undefined> {
  const address = resolveAddress(params);
  if (!address) {
    return undefined;
  }
  const stored = normalizeStoredProvenance(await openStore().lookup(address.storeKey), address);
  return stored ? toPublicProvenance(stored) : undefined;
}

export async function listMemoryArtifactProvenance(params: {
  workspaceDir: string;
}): Promise<Array<{ relativePath: string; provenance: MemoryArtifactProvenance }>> {
  const workspaceKey = sha256Hex(normalizeWorkspaceKey(params.workspaceDir));
  // The adjacent ASCII separators bound exactly this workspace's key prefix.
  const entries = await openStore().entriesInKeyRange({
    keyStartInclusive: `${workspaceKey}:`,
    keyEndExclusive: `${workspaceKey};`,
    limit: Number.MAX_SAFE_INTEGER,
    order: "asc",
  });
  // Stable sorting preserves the store's key order when creation times tie.
  return entries
    .toSorted((left, right) => left.createdAt - right.createdAt)
    .flatMap((entry) => {
      const address = {
        workspaceKey,
        relativePath: entry.value.relativePath,
        storeKey: entry.key,
      };
      const stored = normalizeStoredProvenance(entry.value, address);
      return stored
        ? [{ relativePath: stored.relativePath, provenance: toPublicProvenance(stored) }]
        : [];
    });
}
