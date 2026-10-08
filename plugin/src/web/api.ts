// The read side of the memory browser's API: the same index the retrieval tools
// query, exposed over HTTP so the page can show what the plugin actually wrote.
//
// WHY THE PLUGIN AND NOT THE INFERENCE SERVICE
//   The index is a SQLite file the plugin already holds open (`node:sqlite`, in
//   this process). The inference service is a separate Node process that exists
//   only for node-llama-cpp; it has no business owning the index, and a second
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
import { open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { indexDocument, indexStats } from "../memory-index.js";
import { readPluginConfig, savePluginConfig } from "./config-file.js";
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

/** JSON envelope every route uses; `fetchAPI` reads `data` unconditionally. */
function ok(data: unknown): Response {
  return Response.json({ success: true, data });
}

function fail(error: string, status = 400): Response {
  return Response.json({ success: false, error }, { status });
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
  const countFor = (root: string): number =>
    (
      db
        .prepare(
          "SELECT count(*) AS n FROM units u JOIN documents d ON d.id = u.document_id WHERE d.root = ?"
        )
        .get(root) as { n: number }
    ).n;
  return ok({
    total: countFor("home"),
    wiki: countFor("wiki"),
    documents: stats.documents,
    units: stats.units,
    vectors: stats.vectors,
    bytes: stats.bytes,
  });
}
