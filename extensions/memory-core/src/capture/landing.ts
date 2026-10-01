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
 */
export async function reclaimOrphanedCapturePrompts(params: {
  workspaceDir: string;
  nowMs?: number;
  ttlMs?: number;
}): Promise<number> {
  const nowMs = params.nowMs ?? Date.now();
  const ttlMs = params.ttlMs ?? CAPTURE_CLAIM_TTL_MS;
  const entries = await readMemoryCoreWorkspaceEntries<CapturePromptRecord>({
    namespace: CAPTURE_PROMPTS_NAMESPACE,
    workspaceDir: params.workspaceDir,
  });
  let reclaimed = 0;
  for (const entry of entries) {
    const record = entry.value;
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
