// Memory Core tests cover the auto-capture ingestion pipeline ported from opencode-mem.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configureMemoryCoreDreamingState, clearMemoryCoreWorkspaceNamespace } from "../dreaming-state.js";
import {
  buildCaptureSystemPrompt,
  buildBoundedSummaryPrompt,
  buildCaptureMarkdownContext,
  captureEntryMarker,
  createMemoryCapture,
  detectCaptureLanguage,
  extractCaptureSummary,
  getCaptureLanguageName,
  getCaptureMarkdownBudget,
  listPendingCapturePrompts,
  parseCaptureSummary,
  reclaimOrphanedCapturePrompts,
  renderCaptureEntry,
  recordCapturePrompt,
  CAPTURE_CLAIM_TTL_MS,
  CAPTURE_PROMPTS_NAMESPACE,
  CAPTURE_TOOL_SCHEMA,
} from "./index.js";
import type { CapturePromptRecord } from "./types.js";

const DAY_MS = Date.UTC(2026, 9, 1, 12, 0, 0);
const DAY = "2026-10-01";

function createFakeKeyedStore(backing: Map<string, Map<string, unknown>>) {
  return <T,>(options: { namespace: string }) => {
    if (!backing.has(options.namespace)) {
      backing.set(options.namespace, new Map());
    }
    const rows = backing.get(options.namespace)!;
    return {
      async register(key: string, value: T) {
        rows.set(key, value);
      },
      async registerIfAbsent(key: string, value: T) {
        if (rows.has(key)) return false;
        rows.set(key, value);
        return true;
      },
      async lookup(key: string) {
        return rows.get(key) as T | undefined;
      },
      async delete(key: string) {
        return rows.delete(key);
      },
      async entries(): Promise<Array<{ key: string; value: T }>> {
        return [...rows].map(([key, value]) => ({ key, value: value as T }));
      },
      async clear() {
        rows.clear();
      },
    };
  };
}

describe("capture context budgeting", () => {
  it("keeps every section and respects the UTF-8 cap", () => {
    const context = buildCaptureMarkdownContext({
      userPrompt: "do the thing",
      textResponses: ["x".repeat(200_000), "second turn"],
      toolCalls: [{ name: "edit", input: "file.ts" }],
      latestMemory: "prior note",
    });

    expect(context).toContain("## User Request");
    expect(context).toContain("## AI Response");
    expect(context).toContain("## Tools Used");
    expect(context).toContain("## Previous Memory Context");
    expect(context).toContain("- edit(file.ts)");
    expect(Buffer.byteLength(context, "utf-8")).toBeLessThanOrEqual(131_072);
  });

  it("bounds the summary prompt inside the request budget", () => {
    const prompt = buildBoundedSummaryPrompt(
      "c".repeat(400_000),
      buildCaptureSystemPrompt("English"),
      CAPTURE_TOOL_SCHEMA,
      131_072,
    );

    expect(Buffer.byteLength(prompt, "utf-8")).toBeLessThanOrEqual(131_072);
    expect(prompt).toContain("Analyze this conversation");
  });

  it("never returns a budget below the floor", () => {
    expect(getCaptureMarkdownBudget(131_072)).toBeGreaterThanOrEqual(4_096);
    expect(getCaptureMarkdownBudget(1)).toBe(4_096);
  });

  it("names the target language in the system prompt", () => {
    expect(buildCaptureSystemPrompt("Chinese")).toContain("write the summary in Chinese");
  });
});

describe("capture extraction", () => {
  it("parses bare JSON and normalises tags", () => {
    expect(
      parseCaptureSummary(
        JSON.stringify({ summary: "s", type: "feature", tags: ["React", " auth "] }),
      ),
    ).toEqual({ summary: "s", type: "feature", tags: ["react", "auth"] });
  });

  it("parses a fenced JSON block", () => {
    expect(parseCaptureSummary('```json\n{"summary":"s","type":"skip","tags":[]}\n```')).toEqual({
      summary: "s",
      type: "skip",
      tags: [],
    });
  });

  it("parses a tool-call envelope with string arguments", () => {
    expect(
      parseCaptureSummary(
        JSON.stringify({
          tool_calls: [
            {
              function: {
                name: "save_memory",
                arguments: JSON.stringify({ summary: "s", type: "bug-fix", tags: ["sqlite"] }),
              },
            },
          ],
        }),
      ),
    ).toEqual({ summary: "s", type: "bug-fix", tags: ["sqlite"] });
  });

  it("returns null instead of throwing on unparseable output", () => {
    expect(parseCaptureSummary("I cannot summarize that.")).toBeNull();
    expect(parseCaptureSummary("{ truncated")).toBeNull();
  });

  it("prefers structured output and falls back to the text path", async () => {
    const record = { id: "prompt_1" } as CapturePromptRecord;
    const systemPrompt = buildCaptureSystemPrompt("English");

    const structured = await extractCaptureSummary({
      context: "ctx",
      record,
      systemPrompt,
      completeStructured: async () => ({ summary: "a", type: "feature", tags: [] }),
      complete: async () => {
        throw new Error("must not be called");
      },
    });
    expect(structured.summary).toBe("a");

    const fallback = await extractCaptureSummary({
      context: "ctx",
      record,
      systemPrompt,
      completeStructured: async () => {
        throw new Error("schema unsupported");
      },
      complete: async () => JSON.stringify({ summary: "b", type: "refactor", tags: [] }),
    });
    expect(fallback.summary).toBe("b");
  });

  it("raises a clear error when nothing can be parsed", async () => {
    await expect(
      extractCaptureSummary({
        context: "ctx",
        record: { id: "prompt_1" } as CapturePromptRecord,
        systemPrompt: buildCaptureSystemPrompt("English"),
        complete: async () => "no json here",
      }),
    ).rejects.toThrow(/no parseable summary/u);
  });
});

describe("capture language routing", () => {
  it("classifies by script and defaults to English", () => {
    expect(detectCaptureLanguage("这个函数需要处理中文输入的边界情况，很好")).toBe("zh");
    expect(detectCaptureLanguage("эта функция должна обрабатывать кириллицу корректно")).toBe("ru");
    expect(detectCaptureLanguage("just an ordinary english prompt")).toBe("en");
    expect(detectCaptureLanguage("")).toBe("en");
    expect(getCaptureLanguageName("zh")).toBe("Chinese");
    expect(getCaptureLanguageName("xx")).toBe("English");
  });
});

describe("capture render", () => {
  it("emits a heading, tags, and the exact idempotency marker", () => {
    const rendered = renderCaptureEntry({
      summary: { summary: "body", type: "feature", tags: ["auth"] },
      entryKey: "prompt_1_abc",
      nowMs: DAY_MS,
    });

    expect(rendered).toMatch(/^## 2026-10-01T12:00:00\.000Z · auto-capture · feature$/mu);
    expect(rendered).toContain("Tags: auth");
    expect(rendered).toContain(captureEntryMarker("prompt_1_abc"));
    // Curated trigger/importance annotations only apply to MEMORY.md / USER.md roots.
    expect(rendered).not.toMatch(/<!--\s*(trigger|importance|project)\s*:/iu);
    expect(rendered.endsWith("\n")).toBe(true);
  });
});

describe("capture pipeline", () => {
  let backing: Map<string, Map<string, unknown>>;
  let workspaceDir: string;
  let nextTurn: () => {
    textResponses: string[];
    toolCalls: Array<{ name: string; input: string }>;
  } | null;
  let nextSummary: () => { summary: string; type: string; tags: string[] };

  const pending = () =>
    listPendingCapturePrompts({ workspaceDir, maxRetries: 3 });

  const rows = () => [...(backing.get(CAPTURE_PROMPTS_NAMESPACE) ?? new Map()).values()];

  const storedRecord = (messageId: string) =>
    rows()
      .map((entry) => (entry as { value: CapturePromptRecord }).value)
      .find((value) => value?.messageId === messageId);

  const dailyPath = () => path.join(workspaceDir, "memory", `${DAY}.md`);

  const makeCapture = () =>
    createMemoryCapture({
      workspaceDir,
      delay: async () => {},
      loadTurn: async () => nextTurn(),
      complete: async () => JSON.stringify(nextSummary()),
    });

  beforeEach(async () => {
    backing = new Map();
    configureMemoryCoreDreamingState(createFakeKeyedStore(backing));
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-capture-"));
    nextTurn = () => ({
      textResponses: ["Added exponential backoff to the ingest worker."],
      toolCalls: [{ name: "edit", input: "src/ingest.ts" }],
    });
    nextSummary = () => ({
      summary: "## Request\nAdd backoff\n\n## Outcome\nEdited src/ingest.ts",
      type: "feature",
      tags: ["Retry", "Ingest"],
    });
  });

  afterEach(async () => {
    await clearMemoryCoreWorkspaceNamespace({
      namespace: CAPTURE_PROMPTS_NAMESPACE,
      workspaceDir,
    }).catch(() => {});
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  it("lands a prompt once, even when the hook fires twice", async () => {
    const capture = makeCapture();
    const first = await capture.onUserPrompt({
      sessionId: "s1",
      messageId: "m1",
      content: "do it",
      nowMs: DAY_MS,
    });
    const second = await capture.onUserPrompt({
      sessionId: "s1",
      messageId: "m1",
      content: "do it again",
      nowMs: DAY_MS,
    });

    expect(second.id).toBe(first.id);
    expect(first.captured).toBe(0);
    expect(await pending()).toHaveLength(1);
  });

  it("captures into memory/<day>.md with tags and a marker", async () => {
    const capture = makeCapture();
    await capture.onUserPrompt({
      sessionId: "s1",
      messageId: "m1",
      content: "add backoff",
      nowMs: DAY_MS,
    });

    const outcomes = await capture.runSweep({ nowMs: DAY_MS });
    expect(outcomes).toEqual([
      {
        kind: "captured",
        promptId: outcomes[0]!.promptId,
        relativePath: `memory/${DAY}.md`,
      },
    ]);

    const file = await fs.readFile(dailyPath(), "utf-8");
    expect(file).toMatch(/## Outcome\nEdited src\/ingest\.ts/u);
    expect(file).toContain("Tags: retry, ingest");
    expect(file).toContain(captureEntryMarker(outcomes[0]!.promptId));
    expect(await pending()).toHaveLength(0);
  });

  it("does not duplicate the block on a second sweep", async () => {
    const capture = makeCapture();
    await capture.onUserPrompt({
      sessionId: "s1",
      messageId: "m1",
      content: "add backoff",
      nowMs: DAY_MS,
    });
    await capture.runSweep({ nowMs: DAY_MS });
    const before = await fs.readFile(dailyPath(), "utf-8");

    expect(await capture.runSweep({ nowMs: DAY_MS })).toEqual([]);
    expect(await fs.readFile(dailyPath(), "utf-8")).toBe(before);
  });

  it("accumulates the attempt counter across failures", async () => {
    let calls = 0;
    nextSummary = () => {
      calls += 1;
      if (calls < 3) {
        throw new Error("model unavailable");
      }
      return { summary: "Recovered", type: "feature", tags: [] };
    };
    const capture = makeCapture();
    await capture.onUserPrompt({
      sessionId: "s1",
      messageId: "m1",
      content: "x",
      nowMs: DAY_MS,
    });

    const outcomes = await capture.runSweep({ nowMs: DAY_MS });
    expect(outcomes[0]!.kind).toBe("captured");
    expect(calls).toBe(3);
    expect(storedRecord("m1")).toMatchObject({ captured: 1, captureAttempts: 2 });
  });

  it("stops retrying once maxRetries is reached", async () => {
    let calls = 0;
    nextSummary = () => {
      calls += 1;
      throw new Error("model unavailable");
    };
    const capture = makeCapture();
    await capture.onUserPrompt({
      sessionId: "s1",
      messageId: "m1",
      content: "x",
      nowMs: DAY_MS,
    });

    const outcomes = await capture.runSweep({ nowMs: DAY_MS });
    expect(outcomes[0]).toMatchObject({ kind: "exhausted" });
    expect(calls).toBe(3);
    expect(storedRecord("m1")).toMatchObject({ captured: 0, captureAttempts: 3 });

    expect(await pending()).toHaveLength(0);
    expect(await capture.runSweep({ nowMs: DAY_MS })).toEqual([]);
    expect(calls).toBe(3);
  });

  it("drops a prompt whose extraction returns type=skip", async () => {
    nextSummary = () => ({ summary: "", type: "skip", tags: [] });
    const capture = makeCapture();
    await capture.onUserPrompt({
      sessionId: "s1",
      messageId: "m1",
      content: "hello",
      nowMs: DAY_MS,
    });

    expect((await capture.runSweep({ nowMs: DAY_MS }))[0]).toMatchObject({ kind: "skipped" });
    expect(await pending()).toHaveLength(0);
    expect(storedRecord("m1")).toBeUndefined();
    await expect(fs.access(dailyPath())).rejects.toThrow(/ENOENT/u);
  });

  it("keeps a prompt queued when no assistant turn exists yet", async () => {
    nextTurn = () => null;
    const capture = makeCapture();
    await capture.onUserPrompt({
      sessionId: "s1",
      messageId: "m1",
      content: "x",
      nowMs: DAY_MS,
    });

    expect((await capture.runSweep({ nowMs: DAY_MS }))[0]).toMatchObject({ kind: "pending" });
    expect(await pending()).toHaveLength(1);
    // A missing turn is not a failed extraction, so no attempt is consumed.
    expect(storedRecord("m1")).toMatchObject({ captured: 0, captureAttempts: 0 });
  });

  it("reclaims a claim orphaned by a crashed worker", async () => {
    const staleMs = DAY_MS - CAPTURE_CLAIM_TTL_MS - 1_000;
    const record = await recordCapturePrompt({
      workspaceDir,
      sessionId: "s1",
      messageId: "m1",
      content: "x",
      nowMs: staleMs,
    });
    const key = [...(backing.get(CAPTURE_PROMPTS_NAMESPACE) ?? new Map()).entries()].find(
      ([, value]) => (value as { value: CapturePromptRecord }).value?.messageId === "m1",
    )![0];
    const store = backing.get(CAPTURE_PROMPTS_NAMESPACE)!;
    store.set(key, {
      ...(store.get(key) as object),
      value: { ...record, captured: 2, claimedAt: staleMs },
    });

    expect(await pending()).toHaveLength(0);
    expect(
      await reclaimOrphanedCapturePrompts({ workspaceDir, nowMs: DAY_MS }),
    ).toBe(1);
    expect(await pending()).toHaveLength(1);
    expect((await makeCapture().runSweep({ nowMs: DAY_MS }))[0]).toMatchObject({
      kind: "captured",
    });
  });
});
