// The read side of the memory browser's API: the same index the retrieval tools
// query, exposed over HTTP so the page can show what the plugin actually wrote.
//
// WHY THE PLUGIN AND NOT THE INFERENCE SERVICE
//   The index is a SQLite file the plugin already holds open (`node:sqlite`, in
//   this process). The inference service is a separate Node process that exists
//   only to spawn and proxy the llama-server child; it has no business owning the
//   index, and a second
//   writer on `index.db` is a corruption risk. So the page's data endpoints live
//   here, next to `serveStatic`.
//
// WHAT IS HERE
//   Two read routes over files the plugin already owns -- the injected prompt
//   files and the dream diary -- plus one write route for the injected files, and
//   the health probe. There is deliberately no route over the memory index: the
//   index backs `memory_search`, and a browsable transcript of it would show the
//   raw capture snapshots, which openclaw never intends to expose.
import type { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { indexDocument, indexStats, missingVectorCount, staleEmbedderModels } from "../memory-index.js";
import { listRuntimeFiles, readModelConfig, readRuntimeManifest, readServiceConfig, resolveRuntimeFile, runtimeTag, runtimeZipPath, installedRuntimeTag, effectiveRuntimeDirPath } from "../model/config.js";
import type { RuntimeVariant } from "../model/config.js";
import type { ServiceHealth } from "../model/client.js";
import { markConfigRestartNeeded, readPluginConfig, savePluginConfig } from "./config-file.js";
import { readWebConfig } from "./config.js";
import { readWikiConfig } from "../wiki/config.js";
import { DREAMS_FILE_NAME, MEMORY_FILE_NAME, memoryHomeDir, projectSlug } from "../paths.js";

export type MemoryApiDeps = {
  /** The plugin's open index, or null when this OpenCode build has no node:sqlite. */
  db: DatabaseSync | null;
  workspaceDir: string;
  /** Whether `web.authPassword` is set; reported by the health probe. */
  authEnabled?: boolean;
  /**
   * `ctx.model.list()`, for the config form's model picker. Optional: a plugin
   * context without a model directory is an older host, and the form then falls
   * back to a text box rather than pretending there are no models.
   */
  listModels?: () => Promise<{ data?: unknown[] } | unknown[]>;
  /**
   * Runs the same code path as the `memory_reindex` tool, for the page's
   * "rebuild with vectors" button. Optional: absent when the retrieval tools were
   * not registered (no `node:sqlite`), and the endpoint then says so rather than
   * pretending the rebuild happened.
   */
  reindex?: (input: { embed: boolean; embedBudget?: number }) => Promise<ReindexOutcome>;
  /**
   * Whether embedding is possible at all, resolved once at startup by
   * `resolveEmbedAvailability`. The page needs it because the alternative is
   * discovering it by clicking: `runReindex` with no embedding service returns
   * `embedded = 0`, which reads the same whether the model is missing or there was
   * simply nothing to embed.
   */
  embedReady?: EmbedReadiness;
  /**
   * The Runtime page's actions (download / restart / repair) plus the live
   * service probe. Built only when the vector lane exists — see `RuntimeApi`.
   */
  runtime?: RuntimeApi;
  /**
   * Upstream's `forgetMemoryEntries`, wired to the memory home. Only present when
   * the plugin registered its retrieval runtime, same as `reindex`.
   */
  forget?: (input: {
    sessionIds?: string[];
    hookSources?: string[];
    participants?: string[];
    since?: string;
    dryRun: boolean;
  }) => Promise<Record<string, unknown>>;
};

/**
 * The three reasons embedding cannot run, kept apart because they need different
 * words: a switch that is off, a path the user named that does not exist (a plain
 * misconfiguration), and the default path being empty (nothing has been installed).
 */
export type EmbedReadiness = {
  /** `model.embed` is on. */
  enabled: boolean;
  /** On *and* the model file is there. */
  usable: boolean;
  /** Where the model was expected, when it is not usable. */
  missingPath?: string;
  /** The user named this path explicitly in settings, so it being absent is a mistake. */
  explicit: boolean;
};

/** What the `memory_reindex` tool returns, reused verbatim so the two agree. */
export type ReindexOutcome = { content: string; metadata: Record<string, unknown> };

/** One action's answer on the Runtime page: whether it worked, in one sentence. */
export type RuntimeAction = { ok: boolean; detail: string };

/** What a manual `repairEmbedder` run reports back (see index.ts). */
export type RepairOutcome = {
  status: "clean" | "done" | "postponed" | "stalled" | "incomplete" | "skipped";
  rounds: number;
  stale: number;
  missing: number;
};

/**
 * The Runtime page's action half, wired in index.ts where the service client,
 * the service config and the repair closure already live. Absent when vectors
 * are not usable (no embedding model / `model.embed = false`) — the status
 * route then reports what it can and the action routes answer 503.
 */
export type RuntimeApi = {
  /** Live `/health` probe; never starts anything. */
  probe(): Promise<{ url: string; health: ServiceHealth } | null>;
  /** `force` wipes the current tag's runtime dir + zip first, then starts. */
  download(force: boolean): Promise<RuntimeAction>;
  /** Stop what this plugin started (if anything) and bring the service back. */
  restart(): Promise<RuntimeAction>;
  /** One manual `embedder repair` pass; coalesces with an in-flight run. */
  repair(): Promise<RepairOutcome>;
  /**
   * 生效的变体：服务在跑时是 spawn 真身（活读，`spawnedVariant`）；没在跑时
   * 回落到活读配置 = 下次 spawn 会用的值。select 只在服务跑着时顺手重启
   * （2026-11-06），没跑就只落配置——见 `selectRuntimeVariant`。
   */
  activeVariant: RuntimeVariant;
  /**
   * 装载期的运行时 tag（runtimeTag() 的装载值）。页面用它与盘上 manifest 的
   * 现值比对：自动对齐把 runtime.json 写新后，status 立刻报 tagPending——
   * 「重启 OpenCode 生效」语义（spawn 换新 tag 的运行时；行身份不随 tag 变，
   * 见 embedderIdFor）。
   */
  activeTag: string;
  /** 正在后台准备（--ensure 下载/解压中）的变体；状态页行内显示「准备中」。 */
  preparing(): readonly RuntimeVariant[];
  /**
   * 后台准备一个引擎的运行时文件（server.mjs `--variant X --ensure`：下载→
   * 校验→解压即退，不起服务）。`force` 先删现有文件再取（行内「重新下载」）。
   * CUDA 在无 NVIDIA 驱动的机器上由服务端的门拒绝——页面侧也先拦一次。
   */
  prepare(variant: RuntimeVariant, force: boolean): Promise<RuntimeAction>;
  /**
   * 删除**一个**已下载文件（`name` 是 runtime 目录里的文件名，列表式删除）。
   * 生效引擎正在用的当前 tag 目录拒绝；准备中拒绝；名字不属该变体拒绝
   * （index 闭包里 resolveRuntimeFile 验模式，这里 API 层先拦生效守卫）。
   */
  release(variant: RuntimeVariant, name: string): Promise<RuntimeAction>;
};

/** JSON envelope every route uses; `fetchAPI` reads `data` unconditionally. */
function ok(data: unknown): Response {
  return Response.json({ success: true, data });
}

function fail(error: string, status = 400): Response {
  return Response.json({ success: false, error }, { status });
}

/**
 * What upstream exposes as `openclaw memory forget`, on the one surface mem-plus
 * has. Upstream keeps it in the CLI and out of the model's reach on purpose: it
 * rewrites the user's memory files irreversibly, so it belongs to a person making
 * a deliberate choice, not to an agent that decides it wants to forget something.
 * This endpoint is that person. It is deliberately NOT registered as a tool --
 * `memory_reindex` has a tool because rebuilding an index loses nothing, and this
 * does.
 *
 * `dryRun` is upstream's own safety valve and is required here: the default is a
 * preview, and a caller must pass `dryRun: false` to actually delete.
 */
export async function forgetMemory(params: {
  forget?: (input: {
    sessionIds?: string[];
    hookSources?: string[];
    participants?: string[];
    since?: string;
    dryRun: boolean;
  }) => Promise<Record<string, unknown>>;
  log: (message: string, detail?: unknown) => void;
  body: unknown;
}): Promise<Response> {
  const { forget, log, body } = params;
  if (!forget) {
    return fail(
      "忘记功能不可用：本次运行未注册检索运行时。",
      503,
    );
  }
  const raw = (body ?? {}) as {
    sessionIds?: unknown;
    hookSources?: unknown;
    participants?: unknown;
    since?: unknown;
    dryRun?: unknown;
  };
  // Upstream's guard is "at least one selector", and it is a hard error rather
  // than an empty result -- forgetting with no selector would be a no-op that
  // reads as a success. Enforced here too, before any work.
  const readList = (value: unknown): string[] | null => {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) return null;
    if (!value.every((entry) => typeof entry === "string")) return null;
    return value as string[];
  };
  const sessionIds = readList(raw.sessionIds);
  const hookSources = readList(raw.hookSources);
  const participants = readList(raw.participants);
  if (sessionIds === null || hookSources === null || participants === null) {
    return fail("sessionIds / hookSources / participants 必须是字符串数组。", 400);
  }
  if (sessionIds.length + hookSources.length + participants.length === 0) {
    return fail("请至少提供一个会话标识：sessionIds、hookSources 或 participants 之一。", 400);
  }
  const since = raw.since === undefined || raw.since === null ? undefined : String(raw.since);
  const dryRun = raw.dryRun !== false;
  try {
    const report = await forget({
      ...(sessionIds.length > 0 ? { sessionIds } : {}),
      ...(hookSources.length > 0 ? { hookSources } : {}),
      ...(participants.length > 0 ? { participants } : {}),
      ...(since ? { since } : {}),
      dryRun,
    });
    const artifacts = (report.artifacts ?? {}) as Record<string, number>;
    const files = artifacts.memoryFiles ?? 0;
    const entries = artifacts.memoryEntries ?? 0;
    const keys = Array.isArray(report.entryKeys) ? report.entryKeys.length : 0;
    log(
      dryRun
        ? `api forget preview: ${files} file(s), ${entries} entry(ies), ${keys} key(s)`
        : `api forget applied: ${files} file(s), ${entries} entry(ies)`,
    );
    return ok(report);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    log("api POST /api/forget failed", detail);
    return fail(detail, 500);
  }
}

/**
 * The injected files. One resolver for the reader and the writer: a name that
 * reads must be a name that writes, and neither may resolve outside these six
 * paths (`indexed` marks the ones the search index knows about).
 */
function promptFileTarget(
  name: string,
  workspaceDir: string
): { file: string; indexed: boolean } | null {
  switch (name) {
    case "AGENTS.md":
    case "SOUL.md":
    case "IDENTITY.md":
    case "USER.md":
    case "BOOTSTRAP.md":
      // Workspace bootstrap files: injected, but not part of the index.
      return { file: path.join(workspaceDir, name), indexed: false };
    case MEMORY_FILE_NAME:
      // Global long-term memory: indexed, and the file dreaming writes to.
      return { file: path.join(memoryHomeDir(), MEMORY_FILE_NAME), indexed: true };
    default:
      return null;
  }
}

/**
 * The health probe, and the only route left on the index.
 *
 * Both auth layers exempt it, because a second OpenCode window uses it to decide
 * whether the port it found already belongs to a mem-plus page server -- that
 * request carries no credentials, so it has to be able to answer. Enveloped like
 * every other route: `fetchAPI` reads `data` unconditionally, and a bare object
 * here is a null in the page for no gain.
 */
export async function handleMemoryApi(
  request: Request,
  deps: MemoryApiDeps
): Promise<Response | null> {
  if (new URL(request.url).pathname !== "/api/health") return null;
  return ok({
    status: "ok",
    service: "mem-plus",
    web: true,
    index: deps.db !== null,
    authEnabled: deps.authEnabled === true,
  });
}

/**
 * The files the `context` hook injects into the prompt, and what is in them.
 *
 * Same list and same paths as the injector (see `plugin/src/index.ts`): the
 * workspace bootstrap files, minus the ones it skips, plus the global
 * `MEMORY.md` from the memory home. Every entry is reported whether or not the
 * file exists -- the point of the view is to answer "what is the agent being told
 * right now, and what is it not being told", so a missing file is information,
 * not an empty list.
 *
 * Content is capped at the same bound the injector reads with
 * (`MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES`); beyond it, `truncated` says so instead
 * of sending a megabyte to a browser tab.
 */
export type PromptFile = {
  name: string;
  path: string;
  exists: boolean;
  bytes?: number;
  content?: string;
  truncated?: boolean;
  modifiedAt?: string;
  /** sha256 of `content`; the save call sends it back as its concurrency base. */
  sha256?: string;
};

const MAX_PROMPT_FILE_BYTES = 2 * 1024 * 1024;

async function readPromptFile(name: string, file: string): Promise<PromptFile> {
  try {
    // Named `info`, not `stat`: shadowing the import would make the call below a
    // call on a Stats object, and the catch would report every file as missing.
    const info = await stat(file);
    if (!info.isFile()) return { name, path: file, exists: false };
    const handle = await open(file, "r");
    try {
      const buffer = Buffer.alloc(Math.min(info.size, MAX_PROMPT_FILE_BYTES));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const content = buffer.subarray(0, bytesRead).toString("utf8");
      return {
        name,
        path: file,
        exists: true,
        bytes: info.size,
        content,
        sha256: createHash("sha256").update(content, "utf8").digest("hex"),
        truncated: info.size > bytesRead,
        modifiedAt: new Date(info.mtimeMs).toISOString(),
      };
    } finally {
      await handle.close();
    }
  } catch {
    return { name, path: file, exists: false, sha256: "" };
  }
}

/**
 * The dream diary, read-only.
 *
 * `DREAMS.md` is the review tier: the dreaming sweep appends a summary and a
 * pre-image per day and nothing injects it back into a prompt, so it has no
 * reason to be editable from a page. Same reader as the injected files, no
 * writer -- there is deliberately no PUT route for it.
 */
export async function handleDreams(): Promise<Response> {
  const file = path.join(memoryHomeDir(), DREAMS_FILE_NAME);
  return ok({ file: await readPromptFile(DREAMS_FILE_NAME, file), memoryHome: memoryHomeDir() });
}

export async function handlePromptFiles(workspaceDir: string): Promise<Response> {
  const names = [
    "AGENTS.md",
    "SOUL.md",
    "IDENTITY.md",
    "USER.md",
    "BOOTSTRAP.md",
    MEMORY_FILE_NAME,
  ];
  const files = await Promise.all(
    names.map((name) => {
      const target = promptFileTarget(name, workspaceDir);
      return target ? readPromptFile(name, target.file) : null;
    })
  );
  return ok({
    files: files.filter((file): file is PromptFile => file !== null),
    memoryHome: memoryHomeDir(),
    workspaceDir,
  });
}

/**
 * The models OpenCode can reach, for the config form's model picker.
 *
 * A text box asking for `"providerID/modelID"` means either reading
 * `opencode models` and copying a line, or guessing. This is that list, already
 * formatted the way `readHostedModel` parses it back.
 *
 * `value` is `${providerID}/${modelID}` -- the pair OpenCode's own model editor
 * and default selector address a model by (`ModelEditor.get(providerID, modelID)`,
 * `ModelDomain.default.set(providerID, modelID)`), which is also the documented
 * form of `model.hostedModel`. `enabled: false` and non-`active` models are
 * returned but flagged rather than hidden: a model you have configured but
 * disabled is exactly the one you want to see in a picker.
 *
 * The list is read per request, not cached at setup: it changes when the user
 * edits providers in `opencode.jsonc`, and a stale picker is worse than a slow
 * one.
 */
export async function handleModelList(
  listModels?: () => Promise<{ data?: unknown[] } | unknown[]>
): Promise<Response> {
  if (!listModels) {
    // This OpenCode build's plugin context has no model directory. Say so rather
    // than returning an empty list, which reads as "you have no models".
    return ok({ models: [], default: null, available: false });
  }
  let raw: unknown;
  try {
    raw = await listModels();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return fail(`could not list models: ${detail}`, 502);
  }

  // The HTTP surface wraps the array in `{ location, data }`; a direct call may
  // hand back the array itself.
  const list = Array.isArray(raw) ? raw : Array.isArray((raw as { data?: unknown[] })?.data) ? (raw as { data: unknown[] }).data : [];

  const models: {
    value: string;
    label: string;
    providerID: string;
    modelID: string;
    enabled: boolean;
    status: string;
    context?: number;
  }[] = [];
  const seen = new Set<string>();
  for (const entry of list) {
    if (typeof entry !== "object" || entry === null) continue;
    const info = entry as {
      providerID?: unknown;
      modelID?: unknown;
      id?: unknown;
      name?: unknown;
      enabled?: unknown;
      status?: unknown;
      limit?: { context?: unknown };
    };
    const providerID = typeof info.providerID === "string" ? info.providerID.trim() : "";
    const modelID = typeof info.modelID === "string" ? info.modelID.trim() : "";
    if (!providerID || !modelID) continue;
    const value = `${providerID}/${modelID}`;
    // The same model can arrive twice (a provider and a template both listing
    // it); a picker with duplicates is a picker nobody trusts.
    if (seen.has(value)) continue;
    seen.add(value);
    models.push({
      value,
      label: typeof info.name === "string" && info.name.trim() ? info.name.trim() : modelID,
      providerID,
      modelID,
      enabled: info.enabled !== false,
      status: typeof info.status === "string" ? info.status : "active",
      context:
        typeof info.limit?.context === "number" && Number.isFinite(info.limit.context)
          ? info.limit.context
          : undefined,
    });
  }
  models.sort((a, b) => a.providerID.localeCompare(b.providerID) || a.modelID.localeCompare(b.modelID));
  return ok({ models, default: null, available: true });
}

/**
 * Mem-plus's own settings, out of the plugin's settings file.
 *
 * `options` comes back with secrets removed; `secrets` says which secret paths
 * are set so the form can show "已设置" without ever holding the value.
 */
export async function handlePluginConfig(): Promise<Response> {
  return ok(readPluginConfig());
}

/**
 * Resolved on-disk locations for the settings whose default is "somewhere the
 * plugin picks". The form shows these beside the (possibly empty) value so a
 * blank field no longer reads as "unset" -- it names the folder the plugin will
 * actually use. Computed here because the defaults live in the plugin process
 * (model dir, wiki dir, web bundle dir), not in the browser.
 */
export async function handleResolvedPaths(): Promise<Response> {
  const settings = readPluginConfig();
  const options = settings.options ?? {};
  const model = readModelConfig(options);
  const web = readWebConfig(options);
  const wiki = readWikiConfig(options);
  const webDir = (() => {
    if (web.dir && web.dir.trim().length > 0) return web.dir.trim();
    const here = path.dirname(fileURLToPath(import.meta.url));
    const candidates = [
      path.resolve(here, "..", "..", "..", "web", "dist"),
      path.resolve(here, "..", "..", "..", "..", "web", "dist"),
    ];
    for (const candidate of candidates) {
      if (existsSync(path.join(candidate, "index.html"))) return candidate;
    }
    return candidates[0];
  })();
  return ok({
    modelDir: model.modelDir,
    webDir,
    wikiDir: wiki.dir,
  });
}

/**
 * Open a native Windows folder picker and return the chosen path (or an empty
 * string when the user cancels). The browser cannot raise a real OS folder
 * dialog for a text field, so the plugin does it on the host's side.
 */
export async function handlePickDirectory(): Promise<Response> {
  const script =
    "Add-Type -AssemblyName System.Windows.Forms; " +
    "$f = New-Object System.Windows.Forms.FolderBrowserDialog; " +
    "$f.Description = '选择目录'; " +
    "$f.ShowNewFolderButton = $true; " +
    "if ($f.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $f.SelectedPath }";
  const result = spawnSync("pwsh", ["-STA", "-NoProfile", "-Command", script], {
    encoding: "utf8",
    timeout: 300000,
    windowsHide: false,
  });
  const selected = (result.stdout ?? "").trim();
  return ok({ path: selected });
}

/**
 * The model files the settings page offers for `model.embedPath`.
 *
 * The list is the resolved models directory -- `readModelConfig` answers for the
 * same precedence the runtime uses (`model.dir`, else the default) -- filtered to
 * `.gguf` and sorted by name. The page renders it as a dropdown; a directory
 * that is missing or unreadable comes back `available: false` and the page
 * falls back to a plain path box, the same trade `handleModelList` makes.
 *
 * `dir` is also what the page shows under the box: the folder the names come
 * from, as the bare path with no words around it.
 */
export async function handleModelFiles(): Promise<Response> {
  const settings = readPluginConfig();
  const model = readModelConfig(settings.options ?? {});
  let entries: { name: string; path: string }[] = [];
  let available = false;
  try {
    const dirents = await readdir(model.modelDir, { withFileTypes: true });
    available = true;
    entries = dirents
      .filter((d) => d.isFile() && d.name.toLowerCase().endsWith(".gguf"))
      .map((d) => ({ name: d.name, path: path.join(model.modelDir, d.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    // Missing or unreadable directory: stay quiet and let the page fall back
    // to the path box, the same degraded-but-honest shape the other picker uses.
  }
  return ok({ dir: model.modelDir, entries, available });
}

/**
 * Save the settings back.
 *
 * The page passes `sha256` -- what it read. A mismatch is a 409, not a merge.
 *
 * Takes effect on the next `opencode service restart`: the plugin resolves its
 * settings when it loads.
 */
export async function saveSettings(params: {
  options: unknown;
  sha256?: string;
  create?: boolean;
  log: (message: string, detail?: unknown) => void;
}): Promise<Response> {
  const { options, sha256, create, log } = params;
  const result = savePluginConfig({
    options,
    sha256: typeof sha256 === "string" ? sha256 : "",
    ...(create === true ? { create: true } : {}),
  });
  if (!result.ok) {
    log(`settings save refused (${result.status}): ${result.error}`, result.detail);
    return fail(result.error, result.status);
  }
  // A save that actually changed something needs an OpenCode restart to take
  // effect; record that on the server so the reminder survives a page refresh
  // instead of living only in React state. An unchanged save clears nothing
  // (the previous changed-save's reminder still stands until restart).
  if (!result.unchanged) markConfigRestartNeeded(true);
  log(
    result.unchanged
      ? `settings unchanged: ${result.path}`
      : `settings saved: ${result.path}`
  );
  return ok(result);
}

export async function reindexMemory(params: {
  reindex: MemoryApiDeps["reindex"];
  embedReady?: EmbedReadiness;
  embed: boolean;
  embedBudget?: number;
  log: (message: string, detail?: unknown) => void;
}): Promise<Response> {
  const { reindex, embedReady, embed, embedBudget, log } = params;
  if (!reindex) {
    return fail("Rebuilding is unavailable: the retrieval tools were not registered in this runtime.", 503);
  }
  // Refuse before doing any work, and say which of the three reasons it is. Running
  // the walk and then reporting `embedded = 0` costs minutes and tells the user
  // nothing they can act on -- the same sentence covers a missing model, a path that
  // does not exist, and an empty memory store.
  if (embed && embedReady && !embedReady.usable) {
    const why = !embedReady.enabled
      ? "向量检索已关闭（model.embed = false）"
      : embedReady.explicit
        ? `设置里指定的嵌入模型不存在：${embedReady.missingPath ?? "(未设置)"}`
        : `没有找到嵌入模型，放在这里：${embedReady.missingPath ?? "(未知路径)"}`;
    log(`api reindex refused: ${why}`);
    return fail(`没有可使用的向量模型：${why}`, 409);
  }
  try {
    const outcome = await reindex({ embed, ...(embedBudget === undefined ? {} : { embedBudget }) });
    log(`api reindex (embed=${embed}): ${outcome.content.split("\n")[0]}`, outcome.metadata);
    return ok(outcome);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    log("api POST /api/reindex failed", detail);
    return fail(detail, 500);
  }
}

/**
 * GPU 探针：`llama-server.exe --list-devices` 打一行设备就退出（server.mjs
 * 启动时用的同一条）。页面每次 GET 跑一次——只在运行时已下载时才跑，
 * 拿不到输出返回 null（"无可用设备"与"没装运行时"页面上分开显示）。
 */
function probeGpuDevice(exe: string): string | null {
  try {
    const probe = spawnSync(exe, ["--list-devices"], {
      stdio: "pipe",
      windowsHide: true,
      encoding: "utf8",
      timeout: 10_000,
    });
    const output = `${probe.stdout ?? ""}${probe.stderr ?? ""}`;
    return (
      output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => /^Vulkan\d+:|^CUDA\d+:|^Metal:/.test(line)) ?? null
    );
  } catch {
    return null;
  }
}

/**
 * NVIDIA 驱动在不在。与 server.mjs `assertNvidiaForCuda` 同一条证据
 * （`nvidia-smi` 可用 = 驱动在），两道门一个标准：页面用它决定 CUDA 行
 * 可不可选，服务用它决定下不下载。60 秒缓存——状态页每次渲染都探一遍没意义。
 */
let nvidiaCache: { at: number; ok: boolean } | null = null;
function nvidiaPresent(): boolean {
  if (nvidiaCache && Date.now() - nvidiaCache.at < 60_000) return nvidiaCache.ok;
  const probe = spawnSync("nvidia-smi", ["--query-gpu=name", "--format=csv,noheader"], {
    stdio: "pipe",
    windowsHide: true,
    encoding: "utf8",
    timeout: 5000,
  });
  const ok =
    !probe.error && probe.status === 0 && (probe.stdout ?? "").trim().length > 0;
  nvidiaCache = { at: Date.now(), ok };
  return ok;
}

/**
 * The Runtime page's status: runtime on disk, live service health, the index's
 * embedder identity and its stale/missing counts, and the embedding model.
 *
 * Everything here is a read — the device probe is a `--list-devices` call that
 * prints and exits, and the service probe never autostarts (see `probeService`).
 * Stale/missing come from the same two functions `repairEmbedder` checks, so
 * the page and the repair cannot disagree about whether there is work.
 *
 * 变体三件套：`variantSelected`（配置所选，下拉框）、`variantActive`（生效 =
 * 服务 /health 自报的引擎，没服务在跑时是下次启动会用的值）、`variantPending`
 * （服务在跑且引擎与所选不同 = 选中还没换过来；没服务在跑时恒 false）。见
 * `selectRuntimeVariant`：选中只在服务已经跑着时才顺手重启。stale/missing 按
 * 当前行身份算——身份只
 * 到引擎家族（embedderIdFor），不随变体/tag 走，所选与生效值不同时也不会
 * 把整库误报成 stale。
 */
export async function handleRuntimeStatus(deps: MemoryApiDeps): Promise<Response> {
  const rawOptions = readPluginConfig().options ?? {};
  const serviceCfg = readServiceConfig(rawOptions);
  const selected = serviceCfg.runtimeVariant;
  // 生效引擎在 `probed` 之后才算：服务 /health 自报的变体最可信（别的实例起的
  // 服务也说得清），没服务在跑才回落到 spawn 真身 / 活读配置 = 下次启动会用的值。
  // 身份不随变体走（embedderIdFor），所选/装载值不同时这里也不必再改写
  // 配置重读——stale/missing 与页面看到的是同一个身份串。
  const model = readModelConfig(rawOptions);
  const tag = runtimeTag();
  // LM 的 localVersion：页面报的目录是服务**实际会用**的那个——钉死版在位
  // 是钉死版，否则家族里最新的旧版（server.mjs 正常启动同款回退）。
  const dir = effectiveRuntimeDirPath(selected);
  const zip = runtimeZipPath(selected);
  const exe = path.join(dir, "llama-server.exe");
  const downloaded = existsSync(exe);
  const stale = deps.db ? staleEmbedderModels(deps.db, model.embedderId) : [];
  const missing = deps.db ? missingVectorCount(deps.db, model.embedderId) : 0;
  const probed = deps.runtime ? await deps.runtime.probe() : null;
  // 服务在跑时以它自报的变体为「生效」；没在跑就是空，回落到下次启动会用的值。
  const servedVariant = (probed?.health.variant ?? null) as "cpu" | "vulkan" | "cuda" | null;
  const active = servedVariant ?? deps.runtime?.activeVariant ?? selected;
  const manifest = readRuntimeManifest();
  const cuda = manifest?.cuda;
  const nvidia = nvidiaPresent();
  // LM 两维状态：installedTags.<v> !== null 是「装过」（localVersion，含旧
  // tag 家族目录），与钉死 tag 不等 = 「可更新」。与 server.mjs 的回退运行
  // 同一算法，页面不骗人。
  const installedTags: Record<"cpu" | "vulkan" | "cuda", string | null> = {
    cpu: installedRuntimeTag("cpu"),
    vulkan: installedRuntimeTag("vulkan"),
    cuda: installedRuntimeTag("cuda"),
  };
  return ok({
    tag,
    tagKnown: tag !== "unknown",
    runtimeDir: dir,
    runtimeZip: zip,
    downloaded,
    zipPresent: existsSync(zip),
    // cpu 变体没有 GPU 概念：不跑 --list-devices（CPU 构建上它没意义）。
    device: downloaded && selected !== "cpu" ? probeGpuDevice(exe) : null,
    embedderId: model.embedderId,
    embedEnabled: model.embedEnabled,
    embedModelPath: model.embedModelPath,
    embedModelPresent: existsSync(model.embedModelPath),
    stale,
    missing,
    actionsAvailable: deps.runtime !== undefined,
    variantSelected: selected,
    variantActive: active,
    // pending 只在服务在跑、且它报的引擎与所选不同时为 true：没服务在跑不是
    // 「待重启」，是「下次启动用它」——选中的值背后没有在跑的实例可落后。
    variantPending: servedVariant !== null && servedVariant !== selected,
    autoPrepareRuntime: serviceCfg.autoPrepareRuntime,
    // 自动对齐（一直保持最新）把 runtime.json 写新后，装载期 tag 与现值不等：
    // 与变体 pending 同款语义，横幅提示重启（行身份不变，重启只为换 spawn
    // 用的运行时）。
    // 判据改为「在跑的进程」而非装载期读到的文件：服务 /health 的 backend 带
    // `build bNNNNN`，与该变体实际会用的已装 tag 不等才提示重启。装载期 tag
    // 比对会在每次重装（内嵌 zip 旧于上游）后误报一次。
    tagPending: (() => {
      const served = /build (b\d+)/.exec(probed?.health.backend ?? "")?.[1];
      const installed = installedTags[selected];
      return served !== undefined && installed !== null && served !== installed;
    })(),
    // 下拉与引擎列表的数据。三行（cpu/vulkan/cuda，LM 顺序的子集；harmony/
    // office 两行按机主 2026-11-05 指令删除——它们不是 llama.cpp、也装不了，
    // 行尾版本 badge 对它们还是错配）。服务端 prepare/release 只认
    // vulkan/cuda/cpu。（`tested` 字段与「未测」badge 一并删除：给用户看的
    // 界面不露开发者痕迹，机主 2026-11-05 指令；CUDA 无卡的拒绝路径照旧由
    // `compatible`/`reason` 如实报。）
    variants: [
      {
        id: "cpu",
        kind: "engine",
        label: "CPU llama.cpp (Windows)",
        sizeBytes: manifest?.cpu?.sizeBytes ?? null,
        installed: installedTags.cpu !== null,
        installedVersion: installedTags.cpu,
        updateAvailable: installedTags.cpu !== null && installedTags.cpu !== tag,
        // 可跑的条件：盘上有运行时（离线直跑，不需要钉；旧 tag 目录同样能跑，
        // server.mjs 会回退用它），或 manifest 钉了 CPU 资产（能下载校验）。
        // 两者都没有 = 装不了，如实标不适配。
        compatible: installedTags.cpu !== null || manifest?.cpu !== undefined,
        // cpu 变体真机实测过：b12119 CPU 包下载、起服务、嵌入全通过
        // （2026-11-05，30 条真实 chunk 与 vulkan 对比 cos min 0.999528）。
        reason:
          installedTags.cpu !== null || manifest?.cpu !== undefined
            ? null
            : "runtime.json 未钉 CPU 资产",
        preparing: deps.runtime?.preparing().includes("cpu") ?? false,
        selectable: true,
      },
      {
        id: "vulkan",
        kind: "engine",
        label: "Vulkan llama.cpp (Windows)",
        sizeBytes: manifest?.vulkan?.sizeBytes ?? null,
        installed: installedTags.vulkan !== null,
        installedVersion: installedTags.vulkan,
        updateAvailable: installedTags.vulkan !== null && installedTags.vulkan !== tag,
        compatible: true,
        reason: null,
        preparing: deps.runtime?.preparing().includes("vulkan") ?? false,
        selectable: true,
      },
      {
        id: "cuda",
        kind: "engine",
        label: "CUDA llama.cpp (Windows)",
        sizeBytes: cuda ? cuda.sizeBytes + cuda.cudartSizeBytes : null,
        installed: installedTags.cuda !== null,
        installedVersion: installedTags.cuda,
        updateAvailable: installedTags.cuda !== null && installedTags.cuda !== tag,
        compatible: nvidia && cuda !== undefined,
        reason: !cuda
          ? "runtime.json 未钉 CUDA 资产"
          : nvidia
            ? null
            : "未检测到 NVIDIA 驱动（nvidia-smi 不可用）",
        preparing: deps.runtime?.preparing().includes("cuda") ?? false,
        selectable: true,
      },
    ],
    service: probed
      ? {
          url: probed.url,
          variant: probed.health.variant ?? null,
          backend: probed.health.backend ?? null,
          loadedEmbed: probed.health.loaded?.embed === true,
          port: probed.health.port ?? null,
          uptimeSeconds: probed.health.uptimeSeconds ?? null,
        }
      : null,
  });
}

/**
 * POST /api/runtime/download — ensure the runtime is there, `force` wiping the
 * current tag's dir + zip first so the download actually runs again.
 *
 * The download itself is not reimplemented here: starting the service runs
 * `server.mjs`'s own `ensureRuntime` (same sha256 pin, same fetch→curl
 * fallback). That is why a first-time download usually answers `ok:false` with
 * a "still going in the background" sentence — 37 MB is routinely slower than
 * the client's 30 s start timeout, and the next `ready()` heals it.
 */
export async function downloadRuntime(params: {
  runtime?: RuntimeApi;
  force: boolean;
  log: (message: string, detail?: unknown) => void;
}): Promise<Response> {
  const { runtime, force, log } = params;
  if (!runtime) return fail("运行时操作不可用：向量检索未启用（没有可用的嵌入模型或 model.embed = false）。", 503);
  // 待重启窗口里所选 ≠ 生效：下载按钮此刻会作用在"生效"那一个上，报的
  // 却是"所选"的状态——与其说一句含糊的成功，不如说清还没生效。
  const selected = readServiceConfig(readPluginConfig().options ?? {}).runtimeVariant;
  if (runtime.activeVariant !== selected) {
    return fail(
      `已选择 ${selected}（待生效），当前服务仍是 ${runtime.activeVariant}。重启 OpenCode 后再下载/重下。`,
      409,
    );
  }
  try {
    const result = await runtime.download(force);
    log(`api POST /api/runtime/download (force=${force}): ${result.detail}`);
    return ok(result);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    log("api POST /api/runtime/download failed", detail);
    return fail(detail, 500);
  }
}

/** POST /api/runtime/restart — dispose what we own, bring the service back. */
export async function restartRuntime(params: {
  runtime?: RuntimeApi;
  log: (message: string, detail?: unknown) => void;
}): Promise<Response> {
  const { runtime, log } = params;
  if (!runtime) return fail("重启不可用：向量检索未启用（没有可用的嵌入模型或 model.embed = false）。", 503);
  try {
    const result = await runtime.restart();
    log(`api POST /api/runtime/restart: ${result.detail}`);
    return ok(result);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    log("api POST /api/runtime/restart failed", detail);
    return fail(detail, 500);
  }
}

/**
 * POST /api/repair — one manual embedder-repair pass, the same function the
 * startup trigger runs (coalesced in index.ts, so a click during an automatic
 * run joins it instead of starting a second one). Minutes on a real store;
 * the page's timeout matches the reindex button's 30 minutes.
 */
export async function repairVectors(params: {
  runtime?: RuntimeApi;
  log: (message: string, detail?: unknown) => void;
}): Promise<Response> {
  const { runtime, log } = params;
  if (!runtime) return fail("向量修复不可用：向量检索未启用（没有可用的嵌入模型或 model.embed = false）。", 503);
  try {
    const outcome = await runtime.repair();
    log(`api POST /api/repair: ${outcome.status} rounds=${outcome.rounds} stale=${outcome.stale} missing=${outcome.missing}`);
    return ok(outcome);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    log("api POST /api/repair failed", detail);
    return fail(detail, 500);
  }
}

/**
 * POST /api/runtime/select — 写 `service.runtimeVariant`，**不因此启动服务**。
 *
 * 照 LM Studio 的 Runtime 设置（本机 0.4.28+2 实测：选中只发 `selectBackend`
 * RPC 写默认引擎，不 reload、不 restart、不起服务；按钮文案是 "Select as
 * default for <format>"）。机主 2026-11-06 定：我们多走半步——服务**已经在
 * 跑**就顺手重启换成新引擎（只有本插件拉起的子进程回收得掉），没在跑就只落
 * 配置，下次启动服务时生效。旧行为（2026-11-05「选中即生效」）选一次 CPU
 * 就替人拉起一个慢服务，那是副作用，不是选择。
 *
 * 别人（另一个 OpenCode 实例）起的服务本进程回收不了，restart 会如实报
 * 「服务由其他实例持有」；重启失败同样经 `detail` 原样回页面。行身份不随
 * 变体走（cpu/vulkan 实测同批向量，见 embedderIdFor），切换本身不触发重嵌。
 */
export async function selectRuntimeVariant(
  deps: MemoryApiDeps,
  body: unknown,
  log: (message: string, detail?: unknown) => void,
): Promise<Response> {
  const variant = (body as { variant?: unknown } | null)?.variant;
  if (variant !== "vulkan" && variant !== "cuda" && variant !== "cpu") {
    return fail("未知引擎变体（只支持 vulkan / cuda / cpu）", 400);
  }
  if (variant === "cuda" && !nvidiaPresent()) {
    return fail("本机未检测到 NVIDIA 驱动（nvidia-smi 不可用），CUDA 变体不可选。", 409);
  }
  const current = readPluginConfig();
  const options = { ...(current.options ?? {}) } as Record<string, unknown>;
  const existing =
    typeof options.service === "object" && options.service !== null && !Array.isArray(options.service)
      ? (options.service as Record<string, unknown>)
      : {};
  options.service = { ...existing, runtimeVariant: variant };
  const saved = savePluginConfig({
    options,
    ...(current.exists ? { sha256: current.sha256 } : { create: true }),
  });
  if (!saved.ok) return fail(saved.error, saved.status);
  // 手不伸到没开的服务上：probe() 只探活、不启动（probeService），没有服务
  // 在跑就没有可换的引擎，也没有理由替用户拉起一个。
  let running = null;
  if (deps.runtime) {
    try {
      running = await deps.runtime.probe();
    } catch (error) {
      log("api POST /api/runtime/select probe failed", error instanceof Error ? error.message : String(error));
    }
  }
  let restartAttempted = false;
  let restartOk: boolean | null = null;
  let detail: string | undefined;
  if (deps.runtime && running) {
    restartAttempted = true;
    try {
      const outcome = await deps.runtime.restart();
      restartOk = outcome.ok;
      detail = outcome.detail;
      log(`api POST /api/runtime/select variant=${variant}: restart ${outcome.ok ? "ok" : "failed"} -- ${outcome.detail}`);
    } catch (error) {
      restartOk = false;
      detail = error instanceof Error ? error.message : String(error);
      log("api POST /api/runtime/select restart failed", detail);
    }
    // 重启后再探一次：真换过来了没有，只有服务自己报的变体说得准（尤其是
    // 服务由别的实例持有、我们回收不掉它的场合）。探测失败不判成失败，
    // 页面下次 load() 会再问一次。
    try {
      running = await deps.runtime.probe();
    } catch {
      running = null;
    }
  } else {
    detail = "服务未在运行：配置已写入，下次启动服务时使用该引擎。";
    log(`api POST /api/runtime/select variant=${variant}: saved, service not running`);
  }
  // 生效值：服务在跑就以它自报的变体为准；没在跑回落到「下次启动会用的值」。
  const served = (running?.health.variant ?? null) as "cpu" | "vulkan" | "cuda" | null;
  const active = served ?? deps.runtime?.activeVariant ?? null;
  return ok({
    variant,
    active,
    // 服务在跑且自报的引擎仍不是所选 = 没换过来（别的实例持有 / 重启失败）。
    // 没服务在跑不是「待重启」——选中的值背后没有在跑的实例可落后。
    pending: served !== null && served !== variant,
    restartAttempted,
    restartOk,
    detail,
  });
}

/**
 * POST /api/runtime/updates — 当前 runtime.json tag 与 GitHub 最新 nightly 的
 * **只读比对**（LM「Check for updates」的对应物，机主 2026-11-05 定：
 * 通道下拉删掉、这个按钮保留）。真正的"保持最新"不靠它——由「自动更新」
 * 开关在启动/准备时对齐并写回 runtime.json（见 server.mjs
 * applyLatestNightly），这里只负责报告现状。
 */
export async function checkRuntimeUpdates(): Promise<Response> {
  try {
    const res = await fetch(
      "https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=20",
      {
        headers: { accept: "application/vnd.github+json", "user-agent": "mem-plus" },
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!res.ok) return fail(`GitHub API 返回 ${res.status}`, 502);
    const items = (await res.json()) as Array<{ tag_name?: unknown }>;
    const latest =
      items.map((r) => (typeof r.tag_name === "string" ? r.tag_name : "")).find((t) => /^b\d+$/.test(t)) ??
      null;
    const pinned = runtimeTag();
    return ok({
      pinned,
      latest,
      newer: latest !== null && latest !== pinned,
      note: "运行时由「自动更新」开关保持最新：启动/准备时对齐上游最新 nightly 并写回 runtime.json（sha256 同步取自 API digest）。",
    });
  } catch (error) {
    return fail(
      `检查更新失败：${error instanceof Error ? error.message : String(error)}`,
      502,
    );
  }
}

/** 合并写 `service.*` 进 config.jsonc（开关与 select 同一条路，sha 乐观并发）。 */
function saveServiceOptions(patch: Record<string, unknown>): { ok: boolean; status?: number; error?: string } {
  const current = readPluginConfig();
  const options = { ...(current.options ?? {}) } as Record<string, unknown>;
  const existing =
    typeof options.service === "object" && options.service !== null && !Array.isArray(options.service)
      ? (options.service as Record<string, unknown>)
      : {};
  options.service = { ...existing, ...patch };
  const saved = savePluginConfig({
    options,
    ...(current.exists ? { sha256: current.sha256 } : { create: true }),
  });
  return saved.ok ? { ok: true } : { ok: false, status: saved.status, error: saved.error };
}

/**
 * POST /api/runtime/auto-prepare { enabled } — 「运行时缺失/损坏时自动补下」
 * 开关。只写配置：值在 spawn 时活读（`readRuntimeSpawnFlags`），下次服务
 * 重启生效——它与行身份无耦合，不必等插件重载。
 */
export function setAutoPrepareRuntime(body: unknown): Response {
  const enabled = (body as { enabled?: unknown } | null)?.enabled;
  if (typeof enabled !== "boolean") return fail("enabled 必须是 true 或 false", 400);
  const saved = saveServiceOptions({ autoPrepareRuntime: enabled });
  if (!saved.ok) return fail(saved.error ?? "保存失败", saved.status ?? 500);
  return ok({ enabled });
}

/**
 * POST /api/runtime/prepare { variant, force? } — 后台取件：server.mjs
 * `--variant X --ensure`（下载→sha 校验→解压即退，不起服务、不校验 GPU）。
 * 592 MB 的 CUDA 常常超过页面超时，所以是火速返回 + 引擎行「准备中」轮询。
 */
export async function prepareRuntimeVariant(
  deps: MemoryApiDeps,
  body: unknown,
  log: (message: string, detail?: unknown) => void,
): Promise<Response> {
  const variant = (body as { variant?: unknown } | null)?.variant;
  if (variant !== "vulkan" && variant !== "cuda" && variant !== "cpu") return fail("未知引擎变体（只支持 vulkan / cuda / cpu）", 400);
  if (!deps.runtime) {
    return fail("运行时操作不可用：向量检索未启用（没有可用的嵌入模型或 model.embed = false）。", 503);
  }
  if (variant === "cuda" && !nvidiaPresent()) {
    return fail("本机未检测到 NVIDIA 驱动（nvidia-smi 不可用），不能下载 CUDA 运行时。", 409);
  }
  const force = (body as { force?: unknown } | null)?.force === true;
  try {
    const result = await deps.runtime.prepare(variant, force);
    log(`api POST /api/runtime/prepare variant=${variant} force=${force}: ${result.detail}`);
    return ok(result);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    log("api POST /api/runtime/prepare failed", detail);
    return fail(detail, 500);
  }
}

/**
 * GET /api/runtime/files?variant=X — 该变体在盘上的全部已下载文件（所有
 * tag：当前的、旧 tag 孤儿、残留 zip 都在）。`inUse` = 生效引擎正在用的
 * 当前 tag 目录：页面据此禁用那一行的删除按钮，删除接口还有一道 409。
 */
export function listRuntimeFilesApi(deps: MemoryApiDeps, requestUrl: string): Response {
  const variant = new URL(requestUrl).searchParams.get("variant");
  if (variant !== "vulkan" && variant !== "cuda" && variant !== "cpu") {
    return fail("未知引擎变体（只支持 vulkan / cuda / cpu）", 400);
  }
  if (!deps.runtime) {
    return fail("运行时操作不可用：向量检索未启用（没有可用的嵌入模型或 model.embed = false）。", 503);
  }
  // inUse 标记的是服务**实际在用**的目录（钉死版缺时会回退旧版，见
  // handleRuntimeStatus），不是名义上的钉死版——否则回退运行中还能从列表
  // 里删掉正在跑的 exe 本体。
  const currentDir = path.basename(effectiveRuntimeDirPath(variant));
  const active = deps.runtime.activeVariant;
  return ok({
    files: listRuntimeFiles(variant).map((entry) => ({
      ...entry,
      inUse: variant === active && entry.name === currentDir,
    })),
  });
}

/**
 * POST /api/runtime/release { variant, name } — 删掉**一个**已下载文件
 * （列表式删除：点开列表选具体文件删，不一键清空整个变体，机主 2026-11-05
 * 拍板）。三道门都在：名字必须属于该变体的模式（resolveRuntimeFile 不猜
 * 路径）；生效引擎正在用的当前 tag 目录 409（页面也按 inUse 禁用）；
 * index 闭包里准备中/生效/模式还各有一道同语义兜底。
 */
export async function releaseRuntimeVariant(
  deps: MemoryApiDeps,
  body: unknown,
  log: (message: string, detail?: unknown) => void,
): Promise<Response> {
  const variant = (body as { variant?: unknown } | null)?.variant;
  if (variant !== "vulkan" && variant !== "cuda" && variant !== "cpu") return fail("未知引擎变体（只支持 vulkan / cuda / cpu）", 400);
  const name = (body as { name?: unknown } | null)?.name;
  if (typeof name !== "string" || name.length === 0) return fail("缺少要删除的文件名（name）", 400);
  if (!resolveRuntimeFile(variant, name)) return fail(`不认识的文件：${name}`, 400);
  if (!deps.runtime) {
    return fail("运行时操作不可用：向量检索未启用（没有可用的嵌入模型或 model.embed = false）。", 503);
  }
  // 生效引擎正在用的目录（含回退运行的旧版）：exe 被子进程握着，先拦。
  // 其余旧 tag 孤儿与 zip 放行——那正是列表式删除要清理的东西。
  if (variant === deps.runtime.activeVariant && name === path.basename(effectiveRuntimeDirPath(variant))) {
    return fail("这是当前生效引擎正在使用的文件：先在下拉里切走，再删除它", 409);
  }
  try {
    const result = await deps.runtime.release(variant, name);
    log(`api POST /api/runtime/release variant=${variant} name=${name}: ${result.detail}`);
    return ok(result);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    log("api POST /api/runtime/release failed", detail);
    return fail(detail, 500);
  }
}

/**
 * Write one of the injected files.
 *
 * This is the write path, so it is guarded the way the rest of the codebase
 * guards writes:
 *   - **Optimistic concurrency.** The client sends the hash it read; if the file
 *     changed since (dreaming promoted something, the user edited it elsewhere)
 *     the save is refused instead of clobbering it.
 *   - **Atomic replace.** Write a sibling temp file and rename it, so a crash
 *     mid-write cannot truncate `MEMORY.md`.
 *   - **Reindex after write.** The index is derived data; a file it knows about
 *     must be refreshed or search would answer from the old bytes.
 *   - **Name allowlist.** Only the six injected names resolve, so a request can
 *     never name a path.
 */
export async function savePromptFile(params: {
  name: string;
  content: string;
  /** sha256 of what the client read; empty string when the file did not exist. */
  baseSha256?: string;
  db: DatabaseSync | null;
  workspaceDir: string;
  log: (message: string, detail?: unknown) => void;
}): Promise<Response> {
  const { name, content, baseSha256, db, workspaceDir, log } = params;
  if (typeof content !== "string") return fail("content must be a string");
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > MAX_PROMPT_FILE_BYTES) {
    return fail(`content is larger than the ${MAX_PROMPT_FILE_BYTES}-byte injection cap`, 413);
  }

  const target = promptFileTarget(name, workspaceDir);
  if (!target) return fail(`"${name}" is not an injected file`, 404);

  // Optimistic concurrency: what the client saw must still be what is on disk.
  let currentSha = "";
  let existed = false;
  try {
    currentSha = createHash("sha256").update(await readFile(target.file, "utf8")).digest("hex");
    existed = true;
  } catch {
    existed = false;
  }
  if ((baseSha256 ?? "") !== currentSha) {
    return fail(
      existed
        ? "file changed on disk since you loaded it -- reload and re-apply your edit"
        : "file appeared on disk since you loaded it -- reload before saving",
      409
    );
  }

  const nextSha = createHash("sha256").update(content, "utf8").digest("hex");
  if (nextSha === currentSha) {
    return ok({ name, path: target.file, bytes, unchanged: true, indexed: false });
  }

  const temp = `${target.file}.mem-plus-${process.pid}.tmp`;
  try {
    await writeFile(temp, content, "utf8");
    await rename(temp, target.file);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    const detail = error instanceof Error ? error.message : String(error);
    log(`write failed for ${target.file}`, detail);
    return fail(`could not write ${target.file}: ${detail}`, 500);
  }

  // Only home-corpus files are indexed; the workspace bootstrap files are not.
  let indexed = false;
  if (db && target.indexed) {
    try {
      const info = await stat(target.file);
      indexDocument({
        db,
        file: target.file,
        root: "home",
        project: projectSlug(workspaceDir),
        text: content,
        bytes: info.size,
        mtime: Math.trunc(info.mtimeMs),
      });
      indexed = true;
    } catch (error) {
      // The write already landed; a stale index is repairable with memory_reindex.
      log(`reindex after write failed for ${target.file}`, error);
    }
  }

  log(`prompt file updated: ${target.file} (${bytes} bytes, indexed=${indexed})`);
  return ok({ name, path: target.file, bytes, sha256: nextSha, existed, indexed });
}

/**
 * Index counters for the settings dialog: is the index populated, and are the
 * vectors there.
 *
 * Whole-index counts with no project or scope filter. The transcript view that
 * used to offer a scope picker is gone, and the question the dialog asks -- "is
 * anything indexed at all" -- is about the whole memory home.
 */
export function handleMemoryStats(db: DatabaseSync | null): Response {
  if (!db) return fail("index unavailable: no node:sqlite in this OpenCode build", 503);
  const stats = indexStats(db);
  // Upstream's `source` column, not a mem-plus `documents.root`. The corpus split is a
  // column on the chunk row, so this is a `GROUP BY source` rather than a join to a
  // documents table that no longer exists.
  const bySource = db
    .prepare("SELECT source, COUNT(*) AS n FROM memory_index_chunks GROUP BY source")
    .all() as { source: string; n: number }[];
  const countFor = (source: string): number =>
    bySource.find((row) => row.source === source)?.n ?? 0;
  return ok({
    total: countFor("memory"),
    wiki: countFor("wiki"),
    sources: stats.sources,
    chunks: stats.chunks,
    vectors: stats.vectors,
    bytes: stats.bytes,
  });
}


