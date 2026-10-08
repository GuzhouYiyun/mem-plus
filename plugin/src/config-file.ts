// mem-plus's own settings file -- the arrangement opencode-mem uses, and the
// reason this file exists at all.
//
// THE PROBLEM IT REMOVES
//   OpenCode's only per-plugin configuration channel is `ctx.options`, which is
//   the `options` object of an entry in the config file's `plugins[]` array. That
//   channel exists only if the plugin is registered there. Register there *and*
//   keep the plugin directory under `~/.config/opencode/plugins/`, and OpenCode
//   loads two copies: tools registered twice, one turn captured twice, a page
//   server racing itself for a port. So the user must choose -- and choosing
//   directory discovery (the zero-maintenance option) silently costs them every
//   setting, because there is nowhere to put one.
//
// THE ARRANGEMENT
//   Own the file. `~/.config/opencode/mem-plus/config.jsonc` holds the settings and
//   works no matter which load mechanism fired. Registration and configuration are
//   decoupled, which is exactly what opencode-mem does: its settings live in
//   `~/.config/opencode/opencode-mem.jsonc` (created at module load with a
//   commented template) and it never reads `ctx.options` at all
//   (`opencode-mem/src/config.ts:8-13`, `:563-577`).
//
// PRECEDENCE
//   built-in defaults  <  `ctx.options`  <  this file
//
//   `ctx.options` keeps working so an existing `plugins[]` entry does not break the
//   moment this lands. This file wins, because the whole point is that it is the
//   source of truth regardless of how the plugin was loaded -- a setting that
//   changes meaning when you switch load mechanism is not a source of truth.
//
// NOT A SUBSTITUTE FOR THE LOADING RULE
//   Two copies still means two copies. This file makes *configuration* work under
//   either mechanism; it does not make double loading safe. That is a separate,
//   documented rule, and this file is not where it lives.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  applyEdits,
  findNodeAtLocation,
  parse,
  parseTree,
  printParseErrorCode,
  type Node,
  type ParseError,
} from "jsonc-parser";

const CONFIG_FILE_NAME = "config.jsonc";

/** Refuse anything larger; the real file is a few KB of commented template. */
const MAX_CONFIG_BYTES = 1024 * 1024;

const CONFIG_TEMPLATE = `{
  // mem-plus 的设置。删掉任何一项 = 用该项的默认值。
  //
  // 放在这里、而不是 opencode.jsonc 的 plugins[].options 里，是为了让「自动发现」
  // 和「配置条目」两种加载方式都能配得上 —— 后者只有写了 plugins[] 条目才存在。
  //
  // 改完需要 opencode service restart 生效。

  "model": {
    // 抽取用哪个模型："opencode"（用你在 OpenCode 里配好的模型）或 "local"（本地 GGUF）
    "content": "opencode",

    // 用 OpenCode 时指定哪一个，格式 "providerID/modelID"；删掉这一行 = OpenCode 当前的默认模型
    // "hostedModel": "anthropic/claude-sonnet-4-5",

    // 只在 "content": "local" 时有意义：本地服务起不来时是否改用 OpenCode 模型
    "allowHostedFallback": false,

    // 本地 GGUF 相关。删掉 = 用模型目录下的默认文件名。
    // "dir": "C:/Users/你的用户名/models",
    // "contentPath": "…/models/Qwen3.5-4B-Q4_K_M.gguf",
    // "embedPath": "…/models/bge-m3-FP16.gguf",

    "embed": true,
    // "auto"（独显优先）/ "discrete"（仅 NVIDIA·Apple 独显）/ "integrated"（vulkan，核显）
    // 旧的 "cuda" / "vulkan" 值按 "discrete" / "integrated" 处理
    "gpu": "auto",
    "contextSize": 16384,
    "maxNewTokens": 512,
    "logLevel": "warn"
  },

  "service": {
    // 删掉 "url" = 自动发现并按需拉起
    // "url": "",
    "port": 4748,
    "autostart": true,
    "idleMinutes": 10,
    "startTimeoutMs": 30000
  },

  "web": {
    "enabled": true,
    "port": 4747,
    "host": "127.0.0.1",
    "authUser": "",
    // 支持字面量、env://变量名、file://绝对路径
    // "authPassword": "env://MEM_PLUS_WEB_PASSWORD"
  },

  "wiki": {
    "enabled": true
    // "dir": "C:/Users/你的用户名/vault"
  }
}
`;

/** `<stateRoot>/config.jsonc` -- beside the memory home, the index and the log. */
export function configFilePath(stateRoot: string): string {
  return path.join(stateRoot, CONFIG_FILE_NAME);
}

/** Where it lives when nobody says otherwise. */
export function defaultConfigFilePath(): string {
  return configFilePath(path.join(os.homedir(), ".config", "opencode", "mem-plus"));
}

/**
 * Deep structural equality for JSON-shaped values.
 *
 * Used to decide "is this edit worth making at all". Writing a byte-identical
 * value in a different shape is still an edit, and it churns the file, loses the
 * `unchanged` signal the page reports, and needlessly reformats someone's file.
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, b[i]));
  }
  if (typeof a !== "object" || a === null || typeof b !== "object" || b === null) return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    if (!deepEqual(left[key], right[key])) return false;
  }
  return true;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Merge `over` onto `base`, one level deep inside nested objects.
 *
 * One level is enough and deliberately stops there: the settings are grouped
 * `model` / `service` / `web` / `wiki`, and merging deeper would make it possible
 * to shadow a sub-object with a partial one and silently drop the rest.
 */
export function mergeOptions(
  base: Record<string, unknown>,
  over: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(over)) {
    const before = base[key];
    if (
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      typeof before === "object" &&
      before !== null &&
      !Array.isArray(before)
    ) {
      out[key] = { ...(before as Record<string, unknown>), ...(value as Record<string, unknown>) };
      continue;
    }
    out[key] = value;
  }
  return out;
}

/** A settings file that exists but does not parse. Never written over. */
export class ConfigFileError extends Error {
  constructor(
    message: string,
    readonly file: string,
    readonly errors: ParseError[]
  ) {
    super(message);
    this.name = "ConfigFileError";
  }
}

export type ConfigRead = {
  path: string;
  exists: boolean;
  /** sha256 of the raw text; the concurrency base for a write. */
  sha256: string;
  bytes: number;
  modifiedAt?: string;
  options: Record<string, unknown>;
  parseErrors: { offset: number; length: number; message: string }[];
  error?: string;
};

/**
 * Read the settings file.
 *
 * `createIfMissing` is true only on the plugin's startup path, where creating the
 * template is the point: someone who wants to know what can be set should be able
 * to open the file and read it, instead of running the plugin and guessing
 * (this is what opencode-mem does at module load). A GET from the page does not
 * pass it, because a read should not have a side effect -- and because if the
 * file really is absent, the page offers a button to create it rather than
 * silently conjuring one.
 */
export function readConfigFile(stateRoot: string, createIfMissing = false): ConfigRead {
  const file = configFilePath(stateRoot);
  const base: ConfigRead = {
    path: file,
    exists: false,
    sha256: "",
    bytes: 0,
    options: {},
    parseErrors: [],
  };

  let text = "";
  try {
    text = readFileSync(file, "utf-8");
  } catch {
    if (!createIfMissing) return { ...base, error: "not found" };
    try {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, CONFIG_TEMPLATE, "utf-8");
      // Parse what was just written, so the first read reports the template's
      // values instead of an empty object. A file that exists but reads as "no
      // settings" is indistinguishable from a bug.
      return parseConfigText(CONFIG_TEMPLATE, file);
    } catch (error) {
      // Read-only install. Defaults and `ctx.options` it is -- and the page's
      // "create" button will report the real reason when it is pressed.
      return { ...base, error: `not found (${messageOf(error)})` };
    }
  }

  const mtime = safeMtime(file);
  if (Buffer.byteLength(text, "utf-8") > MAX_CONFIG_BYTES) {
    return { ...base, error: "file too large" };
  }
  return parseConfigText(text, file, mtime);
}

type ParsedText = {
  path: string;
  exists: boolean;
  sha256: string;
  bytes: number;
  modifiedAt?: string;
  options: Record<string, unknown>;
  parseErrors: { offset: number; length: number; message: string }[];
  error?: string;
};

/**
 * Parse settings text into a full read.
 *
 * `path` and `exists` are part of the result, not added by the caller: an earlier
 * version returned a shape without them, and every caller that branched on
 * `read.exists` silently took the "no file" path -- which made writes hash an
 * empty string and refuse themselves with a 409.
 */
function parseConfigText(text: string, file: string, mtime?: string): ParsedText {
  const errors: ParseError[] = [];
  const parsed = parse(text, errors, { allowTrailingComma: true, disallowComments: false });
  const common = {
    path: file,
    exists: true,
    sha256: hashOf(text),
    bytes: Buffer.byteLength(text, "utf-8"),
    ...(mtime ? { modifiedAt: mtime } : {}),
    parseErrors: errors.map((e) => ({
      offset: e.offset,
      length: e.length,
      message: printParseErrorCode(e.error),
    })),
  };
  if (errors.length > 0 || !parsed || typeof parsed !== "object") {
    return { ...common, options: {}, error: "not valid JSON/JSONC" };
  }
  return { ...common, options: asRecord(parsed) };
}

function safeMtime(file: string): string | undefined {
  try {
    return new Date(statSync(file).mtimeMs).toISOString();
  } catch {
    return undefined;
  }
}

export type ResolvedOptions = {
  /** What every `read*Config()` should be given. */
  options: Record<string, unknown>;
  file: string;
  hasFile: boolean;
  /** Set when the file exists but does not parse; `options` fell back to ctx. */
  error?: string;
};

/**
 * The options object for this process: defaults < `ctx.options` < settings file.
 *
 * One call in the plugin's setup, so the precedence is stated in one place and
 * every reader downstream sees the same thing.
 */
export function resolveOptions(ctxOptions: unknown, stateRoot: string): ResolvedOptions {
  const file = configFilePath(stateRoot);
  const fallback = asRecord(ctxOptions);
  // `createIfMissing`: this is the startup path, so the template gets written here.
  const read = readConfigFile(stateRoot, true);
  if (read.error === "not found" || read.error?.startsWith("not found")) {
    return { options: fallback, file, hasFile: false };
  }
  if (read.error) {
    // A broken settings file must not take memory capture down with it. Fall back
    // to `ctx.options` and let the log say why -- the alternative is refusing to
    // load because of a typo in a comment.
    return { options: fallback, file, hasFile: true, error: `${read.path}: ${read.error}` };
  }
  return { options: mergeOptions(fallback, read.options), file, hasFile: true };
}

export type ConfigWrite =
  | { ok: true; path: string; sha256: string; unchanged: boolean }
  | { ok: false; status: number; error: string; detail?: string };

/**
 * Write the settings, editing one key at a time so comments survive.
 *
 * Same span discipline the config page uses elsewhere, kept because it is cheap and
 * because a comment someone wrote should survive a save from the page. It is no
 * longer a safety requirement -- this is our file -- but rewriting the whole
 * document to change one number is rude either way.
 */
export function writeConfigFile(params: {
  stateRoot: string;
  options: Record<string, unknown>;
  sha256: string;
  /**
   * Dotted paths to delete outright.
   *
   * The only caller of this is secret clearing, and it is the only case that
   * *needs* a deletion: a secret never round-trips (the page is never given the
   * value), so "remove it" cannot be expressed by writing an empty value. Every
   * other field resets by writing the default explicitly, which keeps the server
   * from needing to know which keys the form manages.
   */
  remove?: readonly string[];
  /**
   * Create the file when it is absent.
   *
   * The page sends this when the reader reported no file and the user pressed the
   * create button. Without it an absent file is a 409, because the page's `sha256`
   * is empty and cannot match the hash of a file that does not exist -- which is
   * the right answer for a *stale* read and the wrong one for *no* read.
   */
  create?: boolean;
}): ConfigWrite {
  const file = configFilePath(params.stateRoot);
  const read = readConfigFile(params.stateRoot, false);
  const absent = read.error?.startsWith("not found") === true;

  if (read.error && !absent) {
    return { ok: false, status: 422, error: `${read.path}: ${read.error}` };
  }
  if (absent && params.create !== true) {
    return { ok: false, status: 404, error: `${file} 还不存在` };
  }

  const current = absent ? "" : readFileSyncSafe(file);
  if (!absent && hashOf(current) !== params.sha256) {
    return {
      ok: false,
      status: 409,
      error: "配置文件已被改动，请刷新后重试",
      detail: `${params.sha256.slice(0, 12)} != ${hashOf(current).slice(0, 12)}`,
    };
  }

  if (current.trim().length === 0) {
    // Nothing to preserve. When creating, the template is the better content: it
    // documents every key in Chinese, which a bare `{}` from an empty form does not.
    const text =
      absent && Object.keys(params.options).length === 0
        ? CONFIG_TEMPLATE
        : `${JSON.stringify(params.options, null, 2)}\n`;
    try {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, text, "utf-8");
    } catch (error) {
      return { ok: false, status: 500, error: "写文件失败", detail: messageOf(error) };
    }
    return { ok: true, path: file, sha256: hashOf(text), unchanged: false };
  }

  const errorsBefore: ParseError[] = [];
  const root = parseTree(current, errorsBefore, { allowTrailingComma: true, disallowComments: false });
  if (!root || root.type !== "object") {
    return { ok: false, status: 422, error: "配置文件不是一个 JSON 对象" };
  }
  if (errorsBefore.length > 0) {
    const first = errorsBefore[0] as ParseError;
    return {
      ok: false,
      status: 422,
      error: `配置文件有 ${errorsBefore.length} 处语法错误，先用编辑器修好`,
      detail: `第 ${first.offset} 字符：${printParseErrorCode(first.error)}`,
    };
  }

  let next: string;
  try {
    const edits: Edit[] = [];
    for (const dotted of params.remove ?? []) {
      const removal = planRemoval(root, current, dotted.split("."));
      if (removal) edits.push(removal);
    }
    for (const [key, value] of Object.entries(params.options)) {
      const node = findNodeAtLocation(root, [key]);
      const existing = node ? parse(current.slice(node.offset, node.offset + node.length)) : undefined;
      // Nothing to do: leaving the bytes alone is what keeps a comment sitting
      // next to that key, and what makes a no-op save report `unchanged` instead
      // of silently reformatting the file.
      if (deepEqual(existing, value)) continue;
      planEdits(root, current, [key], value, edits);
    }
    if (edits.length === 0) {
      return { ok: true, path: file, sha256: hashOf(current), unchanged: true };
    }
    next = applyEdits(current, edits);
  } catch (error) {
    return { ok: false, status: 500, error: "写入失败", detail: messageOf(error) };
  }

  const verify = parse(next, [], { allowTrailingComma: true, disallowComments: false });
  if (!verify || typeof verify !== "object") {
    return { ok: false, status: 500, error: "写入后的文件无法解析，已放弃写入" };
  }

  const finalSha = hashOf(next);
  if (finalSha === params.sha256) {
    return { ok: true, path: file, sha256: finalSha, unchanged: true };
  }
  const temp = `${file}.mem-plus-${process.pid}.tmp`;
  try {
    writeFileSync(temp, next, "utf-8");
    // Rename over the target: a crash mid-write cannot truncate the settings.
    renameSync(temp, file);
  } catch (error) {
    return { ok: false, status: 500, error: "写文件失败", detail: messageOf(error) };
  }
  return { ok: true, path: file, sha256: finalSha, unchanged: false };
}

type Edit = { offset: number; length: number; content: string };

/**
 * Delete one property, comma and all.
 *
 * `findNodeAtLocation` gives back the property's *value*, which is not enough:
 * removing just the value would leave `"authPassword": ,` behind. So the parent's
 * property node is located instead, and the following comma is taken with it when
 * there is one -- leaving a trailing comma before `}` is legal JSONC but reads
 * like a mistake.
 */
function planRemoval(root: Node, raw: string, at: string[]): Edit | null {
  const key = at[at.length - 1] as string;
  const parent = findNodeAtLocation(root, at.slice(0, -1));
  if (!parent || parent.type !== "object" || !parent.children) return null;
  const property = parent.children.find(
    (child) => child.type === "property" && child.children?.[0]?.value === key
  );
  if (!property) return null;

  const index = parent.children.indexOf(property);
  const next = parent.children[index + 1];
  const start = property.offset;
  const end = property.offset + property.length;
  if (next) {
    // Not the last member: take the comma that follows, and the line it ends.
    const comma = raw.indexOf(",", end);
    if (comma >= 0 && !/[^)\]}\s]/.test(raw.slice(end, comma))) {
      const lineEnd = raw.indexOf("\n", comma);
      return { offset: start, length: (lineEnd >= 0 ? lineEnd + 1 : comma + 1) - start, content: "" };
    }
    return { offset: start, length: comma - start, content: "" };
  }
  // Last member: eat the comma *before* it instead.
  const before = raw.lastIndexOf(",", start - 1);
  const lineStart = raw.lastIndexOf("\n", start - 1) + 1;
  if (before >= lineStart && before < start) {
    return { offset: before, length: start - before, content: "" };
  }
  // Only member: leave the braces, drop just the property and its line.
  const lineEnd = raw.indexOf("\n", end);
  return { offset: start, length: (lineEnd >= 0 ? lineEnd + 1 : end) - start, content: "" };
}

/**
 * Edits that turn the value at `at` into `value`, as small as possible.
 *
 * Leaf-by-leaf rather than replacing the whole branch, because a branch is where
 * the comments live: overwriting `model` wholesale to change one number threw
 * away the comment sitting next to it. Insertions (a key the file does not have
 * yet) necessarily replace their parent, since there is nothing to preserve.
 *
 * A key present in the file but absent from `value` is left alone. Deletion would
 * mean the server had to know which keys the form manages, and guessing wrong
 * either drops a setting or resurrects a deleted one; the form expresses "back to
 * the default" by writing the default value explicitly instead.
 */
function planEdits(
  root: Node,
  raw: string,
  at: string[],
  value: unknown,
  edits: Edit[]
): void {
  const record = asRecord(value);
  const node = findNodeAtLocation(root, at);
  const isBranch = typeof value === "object" && value !== null && !Array.isArray(value);

  if (!node || !isBranch || node.type !== "object" || !node.children) {
    if (node) {
      edits.push({
        offset: node.offset,
        length: node.length,
        content: indentLike(JSON.stringify(value, null, 2), raw, node.offset),
      });
      return;
    }
    insertBranch(root, raw, at, value, edits);
    return;
  }

  // Every key we know about in this branch gets its own edit.
  for (const [key, child] of Object.entries(record)) {
    const childNode = findNodeAtLocation(root, [...at, key]);
    const existing = childNode
      ? parse(raw.slice(childNode.offset, childNode.offset + childNode.length))
      : undefined;
    if (deepEqual(existing, child)) continue;
    planEdits(root, raw, [...at, key], child, edits);
  }
}

/**
 * Insert a value at `at`, creating the objects along the way.
 *
 * When the parent exists but the key does not, the edit lands between the parent's
 * braces. When an ancestor is missing entirely, the whole branch is written in one
 * go -- there is nothing there to preserve.
 */
function insertBranch(
  root: Node,
  raw: string,
  at: string[],
  value: unknown,
  edits: Edit[]
): void {
  const parentPath = at.slice(0, -1);
  const key = at[at.length - 1] as string;
  const parent = findNodeAtLocation(root, parentPath);

  if (!parent || parent.type !== "object") {
    // No usable parent: rebuild the closest existing ancestor with the branch added.
    const rebuilt = setAt(asRecord(parse(raw.slice(root.offset, root.offset + root.length)) ?? {}), at, value);
    edits.push({
      offset: root.offset,
      length: root.length,
      content: indentLike(JSON.stringify(rebuilt, null, 2), raw, root.offset),
    });
    return;
  }

  const last = parent.children?.[parent.children.length - 1] as Node | undefined;
  const memberIndent = indentOf(raw, parent.offset) + "  ";
  // `indentLike` adds the member's own indent to every line after the first. The
  // serialized value already carries JSON.stringify's two-space interior, so
  // passing `memberIndent + "  "` here double-counted it: `"enabled"` landed six
  // columns in and the closing brace at column zero.
  const member = `${JSON.stringify(key)}: ${indentWith(JSON.stringify(value, null, 2), memberIndent)}`;
  const offset = last ? last.offset + last.length : parent.offset + 1;
  edits.push({ offset, length: 0, content: `${last ? ",\n" : "\n"}${memberIndent}${member}` });
}

/** `setAt` on a plain object: the parsed-and-rebuilt fallback path. */
function setAt(
  source: Record<string, unknown>,
  at: string[],
  value: unknown
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...source };
  let cursor = out;
  for (let i = 0; i < at.length - 1; i++) {
    const part = at[i] as string;
    const before = cursor[part];
    const next: Record<string, unknown> =
      typeof before === "object" && before !== null && !Array.isArray(before)
        ? { ...(before as Record<string, unknown>) }
        : {};
    cursor[part] = next;
    cursor = next;
  }
  cursor[at[at.length - 1] as string] = value;
  return out;
}

function readFileSyncSafe(file: string): string {
  try {
    return readFileSync(file, "utf-8");
  } catch {
    return "";
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Re-indent a serialized value so every line after the first carries `indent`. */
function indentLike(text: string, _raw: string, offset: number): string {
  return indentWith(text, indentOf(_raw, offset));
}

function indentWith(text: string, indent: string): string {
  if (indent.length === 0) return text;
  return text
    .split("\n")
    .map((line, i) => (i === 0 ? line : indent + line))
    .join("\n");
}

function indentOf(raw: string, offset: number): string {
  const lineStart = raw.lastIndexOf("\n", Math.max(0, offset - 1)) + 1;
  return raw.slice(lineStart, offset).match(/^[ \t]*/)?.[0] ?? "";
}

function hashOf(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}