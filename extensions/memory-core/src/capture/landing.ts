// Landing zone for raw prompts, ported from opencode-mem's `user_prompts` table.
//
// opencode-mem keeps this in a dedicated SQLite file with a `captured` state machine
// (0 pending / 1 captured / 2 claimed) and an atomic `UPDATE ... WHERE captured = 0`
// claim. mem-plus stores it in SQLite-backed plugin state instead, which is the
// sanctioned plugin KV surface: same state machine, same retry accounting, claim
// expiry handled by timestamp rather than a row lock.
import { randomUUID } from "node:crypto";
import {
  deleteMemoryCoreWorkspaceEntry,
  openMemoryCoreStateStore,
  readMemoryCoreWorkspaceEntries,
  writeMemoryCoreWorkspaceEntry,
} from "../dreaming-state.js";
import { CAPTURE_CLAIM_TTL_MS, CAPTURE_PROMPTS_NAMESPACE } from "./constants.js";
import type { CapturePromptRecord } from "./types.js";

export type CapturePromptKey = {
  workspaceDir: string;
  sessionId: string;
  messageId: string;
};

/**
 * The record wrapper the state store writes around every value, restated here.
 *
 * `dreaming-state.ts` keeps an identical `WorkspaceValue<T>` private, and it is byte-identical to
 * the vendored upstream copy, so the shape is restated rather than the vendored file reopened. The
 * namespace-wide read below is the only reader that has to decode it without going through the
 * workspace-scoped accessors.
 */
type WorkspaceValue<T> = {
  version: 1;
  workspaceKey: string;
  workspaceDir: string;
  key: string;
  value: T;
};

/**
 * The ceiling this namespace is opened with: `DREAMING_WORKSPACE_STATE_MAX_ENTRIES` restated, for
 * the reason given above. It bounds how much the store keeps, not how much a read returns -- the
 * listing pages until the scan is exhausted -- so the prune sees every workspace either way.
 */
const CAPTURE_PROMPTS_MAX_ENTRIES = 50_000;

function logicalKey(key: CapturePromptKey): string {
  return `${key.sessionId}:${key.messageId}`;
}

async function readRecord(key: CapturePromptKey): Promise<CapturePromptRecord | null> {
  const entries = await readMemoryCoreWorkspaceEntries<CapturePromptRecord>({
    namespace: CAPTURE_PROMPTS_NAMESPACE,
    workspaceDir: key.workspaceDir,
  });
  const wanted = logicalKey(key);
  const found = entries.find((entry) => entry.key === wanted)?.value;
  return found && found.version === 1 ? found : null;
}

async function writeRecord(record: CapturePromptRecord): Promise<void> {
  await writeMemoryCoreWorkspaceEntry<CapturePromptRecord>({
    namespace: CAPTURE_PROMPTS_NAMESPACE,
    workspaceDir: record.workspaceDir,
    key: `${record.sessionId}:${record.messageId}`,
    value: record,
  });
}

/**
 * Lands a raw prompt. Repeated calls for the same (session, message) return the
 * existing record unchanged, so the caller can be a hook that fires more than once.
 */
export async function recordCapturePrompt(params: {
  workspaceDir: string;
  sessionId: string;
  messageId: string;
  content: string;
  nowMs?: number;
  providerId?: string | null;
  modelId?: string | null;
  /** openclaw's project identity for `workspaceDir`; see `CapturePromptRecord`. */
  projectKey?: string | null;
}): Promise<CapturePromptRecord> {
  const key: CapturePromptKey = {
    workspaceDir: params.workspaceDir,
    sessionId: params.sessionId,
    messageId: params.messageId,
  };
  const existing = await readRecord(key);
  if (existing) {
    return existing;
  }
  const record: CapturePromptRecord = {
    version: 1,
    id: `prompt_${params.nowMs ?? Date.now()}_${randomUUID().slice(0, 7)}`,
    sessionId: params.sessionId,
    messageId: params.messageId,
    workspaceDir: params.workspaceDir,
    content: params.content,
    createdAt: params.nowMs ?? Date.now(),
    captured: 0,
    captureAttempts: 0,
    claimedAt: null,
    linkedMemoryId: null,
    providerId: params.providerId ?? null,
    modelId: params.modelId ?? null,
    // Resolved by the host before landing, so the value is fixed at the moment the
    // prompt was recorded rather than at render time. A capture that settles late, in
    // a session that has since moved to another repository, must still be scoped to
    // where the work actually happened.
    projectKey: params.projectKey ?? null,
  };
  await writeRecord(record);
  return record;
}

/** Pending prompts, oldest first, excluding any that already exhausted their retries. */
export async function listPendingCapturePrompts(params: {
  workspaceDir: string;
  sessionId?: string;
  maxRetries: number;
}): Promise<CapturePromptRecord[]> {
  const entries = await readMemoryCoreWorkspaceEntries<CapturePromptRecord>({
    namespace: CAPTURE_PROMPTS_NAMESPACE,
    workspaceDir: params.workspaceDir,
  });
  return entries
    .map((entry) => entry.value)
    .filter(
      (record) =>
        record.version === 1 &&
        record.captured === 0 &&
        record.captureAttempts < params.maxRetries &&
        (!params.sessionId || record.sessionId === params.sessionId),
    )
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

/**
 * The same records, across every workspace the namespace holds.
 *
 * The workspace-scoped query above is the right shape for the sweep -- a capture belongs to the
 * project it was written in -- and the wrong one for an age prune, which has to reach records whose
 * project is not the one this process happens to be running in. `pruneStalePrompts` passed
 * `ctx.location.directory`, so a pending record anywhere else could not be named by it at all: the
 * 7-day ceiling was unreachable for every other project, which is the growth it exists to bound.
 * Two of the three keys holding those records were scratch directories left behind by this plugin's
 * own test runs. Measurements are in `docs/port-plan.md`, 2026-10-15.
 *
 * opencode-mem's counterpart is `deleteOldPrompts(cutoffTime)` in `user-prompt-manager.ts`, whose
 * statement is `DELETE FROM user_prompts WHERE created_at < ?` with no project filter anywhere in
 * it. The project scope was the divergence, not the age rule. Pending-only stays narrower than the
 * reference on purpose: a captured record is a completed one, which the caller's docstring does not
 * put in scope, and a deletion is the direction to differ in.
 */
export async function listAllPendingCapturePrompts(params: {
  maxRetries: number;
}): Promise<CapturePromptRecord[]> {
  const store = openMemoryCoreStateStore<WorkspaceValue<CapturePromptRecord>>({
    namespace: CAPTURE_PROMPTS_NAMESPACE,
    maxEntries: CAPTURE_PROMPTS_MAX_ENTRIES,
  });
  return (await store.entries())
    .map((entry) => entry.value.value)
    .filter(
      (record) =>
        record.version === 1 &&
        record.captured === 0 &&
        record.captureAttempts < params.maxRetries,
    )
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

/** Returns the record when the 0 -> 2 claim succeeded, otherwise null. */
export async function claimCapturePrompt(
  record: CapturePromptRecord,
  nowMs: number,
): Promise<CapturePromptRecord | null> {
  if (record.captured !== 0) {
    return null;
  }
  const claimed: CapturePromptRecord = { ...record, captured: 2, claimedAt: nowMs };
  await writeRecord(claimed);
  return claimed;
}

/** 2 -> 0. Called from the pipeline's `finally` so a crash cannot strand a claim. */
export async function releaseCaptureClaim(record: CapturePromptRecord): Promise<void> {
  if (record.captured !== 2) {
    return;
  }
  await writeRecord({ ...record, captured: 0, claimedAt: null });
}

export async function markCapturePromptCaptured(record: CapturePromptRecord): Promise<void> {
  await writeRecord({ ...record, captured: 1, claimedAt: null });
}

/**
 * Increments the attempt counter and returns the stored record.
 * The counter must accumulate across retries — opencode-mem does this with
 * `UPDATE ... SET capture_attempts = capture_attempts + 1`.
 */
export async function recordCaptureAttempt(
  record: CapturePromptRecord,
): Promise<CapturePromptRecord> {
  const next: CapturePromptRecord = {
    ...record,
    captureAttempts: record.captureAttempts + 1,
  };
  await writeRecord(next);
  return next;
}

export async function linkCapturePromptMemory(
  record: CapturePromptRecord,
  memoryId: string,
): Promise<void> {
  await writeRecord({ ...record, linkedMemoryId: memoryId });
}

export async function deleteCapturePrompt(record: CapturePromptRecord): Promise<void> {
  await deleteMemoryCoreWorkspaceEntry({
    namespace: CAPTURE_PROMPTS_NAMESPACE,
    workspaceDir: record.workspaceDir,
    key: `${record.sessionId}:${record.messageId}`,
  });
}

/**
 * Claims held longer than the TTL belong to a worker that died mid-capture. Return
 * them to pending so the next sweep retries instead of parking them forever.
 *
 * Namespace-wide, like `listAllPendingCapturePrompts` above and for the same reason.
 * opencode-mem's counterpart is `UPDATE user_prompts SET captured = 0 WHERE captured = 2`
 * in `initDatabase` (`user-prompt-manager.ts:94`): every startup returns every claim to
 * pending, with no project filter anywhere in the statement. Scoping this read to the
 * running workspace made the recovery unreachable rather than merely late, and a record
 * stuck at `captured = 2` is outside the age prune's pending-only filter too -- so a claim
 * orphaned in a project that is never reopened was stranded permanently, not for one TTL.
 * Measurements are in `docs/port-plan.md`, 2026-10-15.
 *
 * The TTL itself stays, and is mem-plus's divergence: opencode-mem can reset every claim
 * at startup because a single process owns its table, while mem-plus runs one instance per
 * OpenCode project against this same store, so "nothing can be in flight" is not knowable
 * there. The write-back is unaffected either way -- `writeRecord` keys each record under
 * its own `workspaceDir`, so a claim is released in place.
 */
export async function reclaimOrphanedCapturePrompts(params: {
  nowMs?: number;
  ttlMs?: number;
}): Promise<number> {
  const nowMs = params.nowMs ?? Date.now();
  const ttlMs = params.ttlMs ?? CAPTURE_CLAIM_TTL_MS;
  const store = openMemoryCoreStateStore<WorkspaceValue<CapturePromptRecord>>({
    namespace: CAPTURE_PROMPTS_NAMESPACE,
    maxEntries: CAPTURE_PROMPTS_MAX_ENTRIES,
  });
  const records = (await store.entries()).map((entry) => entry.value.value);
  let reclaimed = 0;
  for (const record of records) {
    if (
      record.version !== 1 ||
      record.captured !== 2 ||
      record.claimedAt === null ||
      nowMs - record.claimedAt < ttlMs
    ) {
      continue;
    }
    await writeRecord({ ...record, captured: 0, claimedAt: null });
    reclaimed += 1;
  }
  return reclaimed;
}
