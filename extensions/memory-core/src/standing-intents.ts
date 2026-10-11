import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { resolveOpenClawAgentSqlitePath } from "openclaw/plugin-sdk/sqlite-runtime";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import type {
  SqliteWorkerBackend,
  SqliteWorkerCommand,
} from "openclaw/plugin-sdk/sqlite-worker-runtime";
import { bindSqliteWorkerBackend } from "./standing-intents.worker.js";
import {
  DEFAULT_INTENT_COOLDOWN_SECONDS,
  DEFAULT_INTENT_EXPIRY_MS,
  DEFAULT_INTENT_MAX_FIRES,
  normalizeCreatorSender,
  prepareStandingIntentMatch,
  type StandingIntent,
  type StandingIntentOperations,
  type StandingIntentRow,
  type StandingIntentStatus,
} from "./standing-intents-model.js";

export {
  DEFAULT_INTENT_COOLDOWN_SECONDS,
  DEFAULT_INTENT_EXPIRY_MS,
  DEFAULT_INTENT_MAX_FIRES,
  INTENT_INJECTION_MAX_CHARS,
  buildStandingIntentContext,
  encodeStandingIntentChannelScope,
  encodeStandingIntentSenderScope,
  isEligibleStandingIntentTurn,
  type IntentScope,
  type StandingIntent,
  type StandingIntentStatus,
} from "./standing-intents-model.js";

// MEM-PLUS DEVIATION (open + dispatch). See the note in `executeStandingIntent` for why the
// admission owner and the worker thread are gone. The dispatch itself is upstream's: it is
// `bindSqliteWorkerBackend`'s, called directly with a no-op admission hook, so the
// transaction wrapper and the five operations are the same code the worker runs.

function openStandingIntentsDatabase(dbPath: string): DatabaseSync {
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  // Upstream's worker holds a WAL connection; a single in-process writer wants the same.
  db.exec("PRAGMA journal_mode = WAL");
  return db;
}

function createStandingIntentScope(
  db: DatabaseSync,
): SqliteWorkerBackend<StandingIntentOperations> {
  // `admit` is a no-op because there is no admission state machine to advance: it exists
  // upstream to order a write against the database's lease, not to guard the transaction.
  return bindSqliteWorkerBackend(undefined, { database: db, admit: () => {} });
}

function closeStandingIntentsDatabase(db: DatabaseSync): void {
  db.close();
}

async function executeStandingIntent<Key extends keyof StandingIntentOperations>(
  params: { agentId: string; assertCurrent?: () => void },
  command: { type: Key; input: StandingIntentOperations[Key]["input"] },
): Promise<StandingIntentOperations[Key]["output"]> {
  const assertCurrent = params.assertCurrent;
  assertCurrent?.();
  const env = { ...process.env, OPENCLAW_STATE_DIR: resolveStateDir() };
  const options = {
    agentId: params.agentId,
    env,
    path: resolveOpenClawAgentSqlitePath({ agentId: params.agentId, env }),
  };
  // MEM-PLUS DEVIATION: openclaw's agent-database open is not available here.
  //
  // Upstream wraps this call in two things, both of which live in the admission owner that
  // the trim removed from `src/state/openclaw-agent-db.ts`:
  //
  //   runOpenClawAgentWriteAdmission(options, ...)  -- single-writer admission, leases
  //   withOpenClawAgentDatabaseRuntime(options, ...) -- the open itself
  //
  // and then hands the operation to a worker thread. Neither has an implementation in this
  // tree, so the call is replaced with a direct `node:sqlite` open of the *same* path
  // upstream resolves, running the operation in-process.
  //
  // Why that is sound rather than a shortcut: the admission machinery exists to arbitrate
  // a database that several runtimes open. This one is opened by exactly one writer -- the
  // plugin process -- inside mem-plus's own state root, so there is no lease to take and no
  // host database to share. opencode-mem reaches the same conclusion on this same host: its
  // `AISessionManager` opens `ai-sessions.db` in its own data directory with no admission
  // layer and no worker.
  //
  // Everything that decides behaviour -- the path, the schema, the lifecycle kernel, the
  // matcher, the tool -- is upstream's and untouched.
  const db = openStandingIntentsDatabase(options.path);
  try {
    assertCurrent?.();
    const scope = createStandingIntentScope(db);
    // Upstream hands the same command to `worker.run((scope) => scope.execute(command))`,
    // which is where the discriminated union gets its type. Calling the scope directly is
    // the same call with the worker's generic wrapper removed, so the command is restated
    // as the union the backend declares.
    return await scope.execute(command as SqliteWorkerCommand<StandingIntentOperations>);
  } finally {
    closeStandingIntentsDatabase(db);
  }
}

export async function createStandingIntent(params: {
  agentId: string;
  assertCurrent?: () => void;
  description: string;
  triggerKeywords: string[];
  channelScope?: string | null;
  senderScope?: string | null;
  creatorSender: string;
  expiresAt?: number;
  maxFires?: number;
  cooldownSeconds?: number;
  sourceSessionId?: string | null;
  nowMs?: number;
}): Promise<StandingIntent> {
  const nowMs = params.nowMs ?? Date.now();
  const row: StandingIntentRow = {
    id: randomUUID(),
    description: params.description,
    trigger_keywords: JSON.stringify(params.triggerKeywords),
    trigger_embedding: null,
    channel_scope: params.channelScope ?? null,
    sender_scope: params.senderScope ?? null,
    creator_sender: normalizeCreatorSender(params.creatorSender),
    status: "armed",
    expires_at: params.expiresAt ?? nowMs + DEFAULT_INTENT_EXPIRY_MS,
    max_fires: params.maxFires ?? DEFAULT_INTENT_MAX_FIRES,
    fire_count: 0,
    cooldown_seconds: params.cooldownSeconds ?? DEFAULT_INTENT_COOLDOWN_SECONDS,
    last_fired_at: null,
    created_at: nowMs,
    source_session_id: params.sourceSessionId ?? null,
  };
  return executeStandingIntent(params, { type: "create", input: row });
}

export async function listStandingIntents(params: {
  agentId: string;
  assertCurrent?: () => void;
  status?: StandingIntentStatus;
  nowMs?: number;
}): Promise<StandingIntent[]> {
  return executeStandingIntent(params, {
    type: "list",
    input: { status: params.status, nowMs: params.nowMs },
  });
}

export async function sweepStandingIntents(params: {
  agentId: string;
  nowMs?: number;
}): Promise<void> {
  return executeStandingIntent(params, { type: "sweep", input: { nowMs: params.nowMs } });
}

export async function cancelStandingIntent(params: {
  agentId: string;
  assertCurrent?: () => void;
  id: string;
}): Promise<StandingIntent | null> {
  return executeStandingIntent(params, { type: "cancel", input: { id: params.id } });
}

export async function matchStandingIntents(params: {
  agentId: string;
  prompt: string;
  channel?: string;
  provider?: string;
  accountId?: string;
  senderId?: string;
  nowMs?: number;
  assertCurrent?: () => void;
}): Promise<StandingIntent[]> {
  const input = prepareStandingIntentMatch(params);
  return input ? executeStandingIntent(params, { type: "match", input }) : [];
}
