// Shared types for the auto-capture ingestion pipeline ported from opencode-mem.

/**
 * A raw prompt waiting to be turned into a memory. Field names mirror opencode-mem's
 * `user_prompts` row so the state machine reads the same in both codebases.
 *
 * `captured` is the claim state machine: 0 pending, 1 captured, 2 claimed.
 */
export type CapturePromptRecord = {
  version: 1;
  id: string;
  sessionId: string;
  messageId: string;
  workspaceDir: string;
  content: string;
  createdAt: number;
  captured: 0 | 1 | 2;
  captureAttempts: number;
  claimedAt: number | null;
  linkedMemoryId: string | null;
  providerId: string | null;
  modelId: string | null;
  /**
   * openclaw's project identity for the repository this prompt was worked on
   * (`resolveProjectKey`: normalised `origin` remote, else the canonical local
   * root). It rides on the record because the daily entry is the only place the
   * value is captured before dreaming stages a candidate, and a candidate without
   * one is promoted into `MEMORY.md` unannotated -- which openclaw defines as
   * *global*, so it reaches every later session. The host resolves it; this layer
   * only carries it.
   */
  projectKey?: string | null;
};

export type CaptureToolCall = {
  name: string;
  input: string;
};

/** One assistant turn, already sliced out of the transcript by the caller. */
export type CaptureTurn = {
  textResponses: string[];
  toolCalls: CaptureToolCall[];
};

/** Structured output of the extraction model. `type === "skip"` drops the capture. */
export type CaptureSummary = {
  summary: string;
  type: string;
  tags: string[];
};

/**
 * How the extraction call reaches a model. opencode-mem keeps two paths: a
 * schema-constrained structured-output call (its OpenCode provider) and a plain
 * tool/text call whose JSON is parsed by hand (its external API provider). Both
 * are preserved here behind one interface so neither has to be wired to OpenCode.
 */
export type CaptureCompleteStructured = (params: {
  systemPrompt: string;
  prompt: string;
  record: CapturePromptRecord;
}) => Promise<CaptureSummary>;

export type CaptureCompleteText = (params: {
  systemPrompt: string;
  prompt: string;
  record: CapturePromptRecord;
}) => Promise<string>;

export type CaptureDependencies = {
  /**
   * Resolves the assistant turn for a pending prompt.
   * Returns `null` when the turn is not available yet (the prompt stays pending).
   *
   * This is the reserved seam: opencode-mem fills it from `ctx.client.session.messages`,
   * and it is the one call site to replace when OpenCode hooks are connected later.
   */
  loadTurn: (record: CapturePromptRecord) => Promise<CaptureTurn | null>;
  /** Structured-output extraction path; preferred when the host can supply one. */
  completeStructured?: CaptureCompleteStructured;
  /** Tool-call / plain-text extraction path; used when structured output is unavailable. */
  complete: CaptureCompleteText;
  /** Optional prior-memory snippet fed to the extractor as context. */
  loadLatestMemory?: (record: CapturePromptRecord) => Promise<string | null>;
  /**
   * Persists one rendered capture. Must be idempotent per `record.id`.
   * Defaults to appending `memory/YYYY-MM-DD.md` (see write.ts). Returns the
   * absolute path it wrote so callers can index/report the real location.
   */
  writeEntry?: (params: {
    record: CapturePromptRecord;
    day: string;
    relativePath: string;
    rendered: string;
    entryKey: string;
  }) => Promise<string>;
  /**
   * Reports whether the day's file already carries `entryKey`, so a caller that
   * would otherwise pay for an extraction to find out can ask first. `writeEntry`
   * makes a repeated write a no-op, but by then the expensive half has run.
   */
  hasEntry?: (params: {
    record: CapturePromptRecord;
    day: string;
    entryKey: string;
  }) => Promise<boolean>;
  /** Workspace the capture lands in. */
  workspaceDir: string;
  /**
   * openclaw's project identity for a workspace (normalised `origin` remote, else
   * the canonical local root). The host owns it because it needs Git and a cache;
   * this layer only carries the value onto the record and into the rendered entry.
   *
   * Optional because a host that cannot answer must still be able to capture -- and
   * an unresolved key produces an unannotated entry, which openclaw defines as
   * global. That is a leak, not a failure, so it degrades rather than throws.
   */
  resolveProjectKey?: (workspaceDir: string) => Promise<string>;
  /** Overrides the day used for `memory/YYYY-MM-DD.md`. */
  timezone?: string;
  /** Delays between retries; injectable so tests never sleep. */
  delay?: (ms: number) => Promise<void>;
};

export type CaptureOutcomeKind =
  | "captured"
  | "skipped"
  | "pending"
  | "exhausted"
  | "claimed"
  | "failed";

export type CaptureOutcome = {
  kind: CaptureOutcomeKind;
  promptId: string;
  /** Memory path written for `captured`, when one was produced. */
  relativePath?: string;
  error?: string;
};
