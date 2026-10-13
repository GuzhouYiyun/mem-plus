// Lane-one injection: pushing recalled memory into the outgoing request.
//
// UPSTREAM: `extensions/active-memory/trigger-recall.ts`'s `resolveTriggerRecall` result is
// handed to the host, which injects it as hidden context on every inbound message, plus
// `src/agents/project-memory-bootstrap.ts`'s `## Project Memory` block. This file is the
// host half of both.
//
// WHY TWO HOOKS, IN THIS ORDER
//   opencode-mem (`src/v2/adapter.ts:64,80`) settles this on the same host and uses the same
//   pair: `hook("prompt")` decides once per inbound user prompt, `hook("context")` delivers
//   on every agent-loop model call. The split matters twice over. Deciding per prompt means
//   one verdict per turn -- the agent loop issues one model call per tool round, so a
//   single turn would otherwise re-score the same message once per round. Delivering per
//   call is what puts the text in front of the model at all.
//
// WHY NOT EDIT `event.prompt.text`
//   The `prompt` hook's edits become the canonical persisted user input, so injected memory
//   would be stored as something the user said and replayed with it. `event.system` is
//   request-scoped context, which is what this is.
//
// WHY THE CACHE IS KEYED BY SESSION
//   Same reason opencode-mem keys it that way and clears it per prompt: it is the identity
//   both hooks agree on. Nothing is evicted by hand -- a prompt clears its own entry, and a
//   session that never prompts again holds one string.
import { resolveTriggerRecall } from "./trigger-recall.js";
import { prepareProjectMemoryBootstrap } from "./project-memory.js";
import { matchStandingIntentsForPrompt } from "./standing-intents.js";
import { runDeepRecall, readDeepRecallConfig } from "./deep-recall.js";
import { asSessionMessage, type PluginContext, type SessionMessageView } from "./opencode.js";
import { activeProjectKeys, prepareActiveProjectKey } from "./project-key.js";
import { noteDeepRecall } from "./recall-taint.js";

/** OpenCode's `SystemPart` text shape, as the hook's `system` array accepts it. */
type TextSystemPart = { readonly type: "text"; readonly text: string };

function pushSystemText(system: unknown[], text: string): void {
  if (Array.isArray(system)) system.push({ type: "text", text } satisfies TextSystemPart);
}

/**
 * The most recent user message in a request, as plain text.
 *
 * Structural on purpose: the hook's `messages` are the host's own types and the repo
 * already normalises them the same way for capture (`asSessionMessage`), so this reads the
 * same shape the capture pipeline does instead of importing the host's message types.
 *
 * Not the decision input any more -- the `prompt` hook supplies the inbound text directly,
 * which is authoritative where this is a reconstruction. Kept because the prompt hook does
 * not run for synthetic, shell, compaction and move messages, and this is the only way to
 * see those.
 */
export function lastUserText(messages: readonly unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message: SessionMessageView = asSessionMessage(messages[i]);
    if (message.type !== "user") continue;
    const chunks: string[] = [];
    for (const part of message.content ?? []) {
      if (part?.type === "text" && typeof part.text === "string" && part.text.trim()) {
        chunks.push(part.text);
      }
    }
    if (typeof message.text === "string" && message.text.trim()) chunks.push(message.text);
    if (chunks.length > 0) return chunks.join("\n");
  }
  return "";
}

/** The block decided for one inbound prompt, per session. */
type Verdict = {
  readonly trigger?: string;
  readonly project?: string;
  readonly standing?: string;
  readonly deep?: string;
};

/**
 * Install the injection. Returns the registrations so the caller can dispose them; the
 * plugin's cleanup disposes them too, and that is idempotent.
 */
export async function installMemoryInjection(params: {
  ctx: PluginContext;
  db: import("node:sqlite").DatabaseSync;
  workspaceDir: string;
  log: (message: string, detail?: unknown) => void;
  /** Lane 2's tool allowlist, resolved from the tools the agent already has. */
  recallTools?: () => readonly import("./memory-tools.js").MemoryTool[];
  options?: unknown;
}): Promise<{ dispose: () => Promise<void> }> {
  const verdicts = new Map<string, Verdict>();
  const recallConfig = readDeepRecallConfig(params.options);

  // Upstream's active repository keys, per session. Deliberately NOT the project slug:
  // `projectSlug` hashes the *path*, so two clones of one repository get different keys
  // and one repository opened at two paths gets two. Upstream's key is the normalised
  // `origin` remote (see project-key.ts), and the set is per session and never
  // persisted -- a fresh conversation starts with an empty set and therefore inherits
  // no curated memory from a repository it is not working in.
  const activeKeys = (sessionID: string): string[] => [...activeProjectKeys(sessionID)];

  // Stage 1 -- decide. Once per inbound user prompt.
  const prompt = await params.ctx.session.hook("prompt", async (event) => {
    // A new prompt retires the previous verdict first, so a turn that decides nothing
    // delivers nothing rather than re-serving the last turn's memory.
    verdicts.delete(event.sessionID);
    const message = event.prompt?.text ?? "";
    if (message.trim().length === 0) return;
    try {
      // Upstream prepares the repository when a turn runs in it, and that preparation
      // is what makes its entries eligible. Awaited rather than fired: the gate below
      // reads the set immediately, and reading it a tick early would return the
      // previous turn's keys.
      await prepareActiveProjectKey(event.sessionID, params.workspaceDir);
      const activeProjectKeys = activeKeys(event.sessionID);
      const trigger = await resolveTriggerRecall({
        db: params.db,
        message,
        activeProjectKeys,
        currentProject: activeProjectKeys[0],
        signal: undefined,
        onError: (why) => params.log("trigger recall query failed", why),
      });
      // Upstream's order: lane one first, then the escalation gate, then deep recall -- a
      // strong lane-one hit is what makes the gate skip lane two, so the two cannot be
      // resolved independently.
      const deep = await runDeepRecall({
        ctx: params.ctx,
        config: recallConfig,
        tools: params.recallTools?.() ?? [],
        message,
        conversationContext: message,
        searchQuery: message,
        hasStrongLaneOneHit: trigger.hasStrongHit,
        log: params.log,
      });
      verdicts.set(event.sessionID, {
        trigger: trigger.context,
        project: prepareProjectMemoryBootstrap({
          db: params.db,
          activeProjectKeys,
          log: params.log,
        }),
        deep: deep.context ?? undefined,
        standing: await matchStandingIntentsForPrompt({
          workspaceDir: params.workspaceDir,
          prompt: message,
          log: params.log,
        }),
      });
      // Upstream's turn taint, recorded at the seam where the recall is decided and keyed
      // by the same thing upstream keys it by: the user message that opens the turn. The
      // `prompt` hook carries that identity as `messageID`. The snapshot writer withholds
      // the whole turn on that key, which is upstream's exclusion at
      // `session-files.ts:788-794`. See `recall-taint.ts`.
      if (deep.context) {
        noteDeepRecall(event.messageID);
      }
    } catch (error) {
      // A failed lookup must never delay or break the turn it annotates.
      params.log("memory recall aborted", error);
    }
  });

  // Stage 2 -- deliver. On every agent-loop model call, including tool-driven continuations.
  const context = await params.ctx.session.hook("context", async (event) => {
    const verdict = verdicts.get(event.sessionID);
    if (!verdict) return;
    // Upstream's order on this seam is `[laneOneContext, recallContext]` (its
    // `extensions/active-memory/index.ts:556`): lane one, then whatever deep recall
    // decided. Project memory and standing intents are not upstream blocks on this
    // seam -- the first is upstream's bootstrap file, the second memory-core's -- so
    // they bracket that pair: project memory first, being what the host would have
    // injected before anything was decided, standing intents last, being the only
    // block that acts rather than informs.
    for (const text of [verdict.project, verdict.trigger, verdict.deep, verdict.standing]) {
      if (text) pushSystemText(event.system, text);
    }
  });

  return {
    dispose: async () => {
      await prompt.dispose();
      await context.dispose();
      verdicts.clear();
    },
  };
}
