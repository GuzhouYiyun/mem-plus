// The fields the config form shows, and what each one does.
//
// WHERE THIS TABLE COMES FROM
//   Every entry mirrors a key that a `read*Config()` in the plugin actually
//   reads, with that function's own default and bounds:
//
//     web.*      plugin/src/web/config.ts        readWebConfig
//     model.*    plugin/src/model/config.ts     readModelConfig
//     service.*  plugin/src/model/config.ts     readServiceConfig
//     wiki.*     plugin/src/wiki/config.ts      readWikiConfig
//
//   That is the whole documented configuration surface -- there is no other place
//   the plugin looks for a setting. A field that is not in one of those functions
//   does not belong here, and a key the form does not know is still preserved on
//   save (the write merges; it never rebuilds the object from this table), so the
//   table being incomplete would lose nothing. It is a view, not a schema.
//
// THE CONTRACT WITH THE CONFIG FILE
//   A field absent from the file is running on its default. The form shows the
//   effective value and marks it as a default; changing it writes the key
//   explicitly, and "恢复默认" deletes the key again. So the file stays as small
//   as the user keeps it.

export type FieldKind = "boolean" | "number" | "text" | "secret" | "enum" | "modelRef";

export type ConfigField = {
  /** Path inside the options object, e.g. `web.port`. */
  key: string;
  /**
   * Short. The row already prints `key` beside it in code, so the label only has
   * to name the thing -- not spell out the namespace the key is showing anyway.
   * `抽取模型` + `model.contentPath` says it once; `抽取模型文件` says it twice.
   */
  label: string;
  kind: FieldKind;
  /** The plugin's own default, as its reader spells it. */
  defaultValue: string | number | boolean;
  /** One line on what it does and why it exists. Long is fine here. */
  help?: string;
  choices?: readonly string[];
  /**
   * A Chinese gloss for each `choices` value, shown after the identifier in muted
   * text. The identifier stays the primary text on the row: it is what goes in the
   * config file and what the plugin's reader matches on, so it is what you want in
   * front of you. A choice with no entry here is shown bare, so a field can be
   * glossed one value at a time.
   */
  choiceLabels?: Readonly<Record<string, string>>;
  min?: number;
  max?: number;
  /** Numeric fields where the empty string is meaningful (0 = auto). */
  allowZero?: boolean;
};

export type ConfigSection = {
  /**
   * Namespace, used to key React lists. Not shown: there is one section and it has
   * no header, so a title for it would be a string nobody reads. `label` and
   * `summary` used to live here for the collapsible header that wrapped it; both
   * went with the header, and adding a second namespace is the moment to decide
   * what its header says.
   */
  id: string;
  fields: readonly ConfigItem[];
};

/**
 * One entry in a section's list: a setting, a heading that divides the settings
 * above it from the ones below, or a control the page supplies itself.
 *
 * A heading is data rather than styling so the grouping is written once, next to
 * the fields it groups. The alternative -- deriving the groups from adjacent
 * keys, or from a parallel `groups` list -- puts the order in two places, and the
 * two places are free to disagree. An action is here for the same reason: where
 * the "rebuild with vectors" button sits is a decision about the form's reading
 * order, so it belongs beside the switch it depends on.
 */
export type ConfigItem = ConfigField | ConfigHeading | ConfigAction;

export type ConfigHeading = { readonly heading: string };

/** A control the page renders itself. Not a setting: there is no key and no value. */
export type ConfigAction = {
  /** Rebuild the index and embed everything, via the same path `memory_reindex` takes. */
  readonly action: "reindexWithVectors";
};

/** True for a heading entry, which carries no setting. */
export function isHeading(item: ConfigItem): item is ConfigHeading {
  return "heading" in item;
}

/** True for a page-supplied control. */
export function isAction(item: ConfigItem): item is ConfigAction {
  return "action" in item;
}

export const CONFIG_SECTIONS: readonly ConfigSection[] = [
  {
    id: "settings",
    // Ordered by what you have to decide before what: what does the extraction
    // run on, which files is that, and only then how the machine runs it. The
    // hardware settings used to sit above the file paths, which reads backwards --
    // you cannot pick a GPU before you have said which model is loading onto it.
    fields: [
      { heading: "抽取" },
      {
        key: "model.content",
        label: "推理来源",
        kind: "enum",
        choices: ["opencode", "local"],
        defaultValue: "opencode",
        help: "opencode（默认）= 用你在 OpenCode 里配好的模型，不需要下载 GGUF、不需要显卡。local = 走本地 GGUF，全程不出机器。",
      },
      {
        key: "model.hostedModel",
        label: "OpenCode 模型",
        // A picker, not a text box: the value is `providerID/modelID`, and there
        // is no way to guess it. OpenCode can list what it has, so the page asks.
        kind: "modelRef",
        defaultValue: "",
        help: "留空 = 用 OpenCode 当前的默认模型。",
      },
      {
        key: "model.allowHostedFallback",
        label: "回退到 OpenCode",
        kind: "boolean",
        defaultValue: false,
        help: "若启用，当推理来源选择 local 时，如果本地无法推理，则会自动使用 opencode 进行推理。",
      },
      { heading: "文件" },
      {
        key: "model.dir",
        label: "模型目录",
        kind: "text",
        defaultValue: "",
        help: "留空 = 仓库里的 models/，安装版则用记忆库目录下的 models/。",
      },
      {
        key: "model.contentPath",
        label: "抽取模型",
        kind: "text",
        defaultValue: "",
        help: "留空 = 模型目录下的 Qwen3.5-4B-Q4_K_M.gguf。",
      },
      {
        key: "model.embedPath",
        label: "嵌入模型",
        kind: "text",
        defaultValue: "",
        help: "留空 = 模型目录下的 bge-m3-FP16.gguf。写了路径又找不到 = 明确的坏配置。",
      },
      {
        key: "model.embed",
        label: "向量检索",
        kind: "boolean",
        defaultValue: true,
        help: "关掉就是纯关键词检索（索引里没有向量）。",
      },
      {
        // Not a setting: a control the page draws, placed right after the switch that
        // decides whether it can work. In the 文件 group because that is where the
        // embedding model lives, and a button about the model belongs next to it.
        action: "reindexWithVectors",
      },
      { heading: "运行" },
      {
        key: "model.gpu",
        label: "GPU 后端",
        kind: "enum",
        choices: ["auto", "discrete", "integrated"],
        // The values name the class of card, not a backend: "do I have a discrete
        // GPU" is answerable at a glance, "is this machine CUDA or Vulkan" is not.
        // `GPU_PRIORITY` in plugin/serve/server.mjs turns each into the backend
        // chain to try, so the server -- not this table -- is where the mapping
        // lives.
        choiceLabels: {
          auto: "自动",
          discrete: "独显",
          integrated: "核显",
        },
        defaultValue: "auto",
        help: "没有 CPU 回退：独显 > 核显，都不行时服务拒绝启动。独显只试 NVIDIA·Apple 的后端，AMD/Intel 的独显走 vulkan，请选「自动」。",
      },
      {
        key: "model.gpuLayers",
        label: "GPU 层数",
        // A number box, not a text box. The reader (`readGpuLayers`) accepts the
        // string `"auto"` or a number clamped to 0-999, and demotes *everything
        // else* to `"auto"` without a word. A free-text box therefore wrote `abc`
        // or `"800"` or `1500` into the file and ran something else entirely --
        // the file said one thing, the service did another, silently. `type=
        // "number"` rejects the letters and the clamp below matches the reader's
        // own, so the file can only ever hold what the reader will honour.
        //
        // `defaultValue` is the string `"auto"`, which is how the one non-numeric
        // value this field takes is declared: a number field with a string default
        // has exactly one sentinel and it is the default. The box reads empty with
        // `auto` as its placeholder, which is the same as an absent key.
        kind: "number",
        defaultValue: "auto",
        min: 0,
        max: 999,
        help: "留空 = auto（按当前显存算）。也可以直接写 0–999 的整数。",
      },
      {
        key: "model.contextSize",
        label: "上下文",
        kind: "number",
        defaultValue: 16384,
        min: 512,
        max: 262144,
      },
      {
        key: "model.maxNewTokens",
        label: "生成上限",
        kind: "number",
        defaultValue: 512,
        min: 32,
        max: 8192,
      },
      {
        key: "model.threads",
        label: "CPU 线程",
        kind: "number",
        defaultValue: 0,
        min: 0,
        max: 128,
        allowZero: true,
        help: "0 = 由运行时决定。推理本身跑在 GPU 上，这里是主机侧工作。",
      },
      {
        key: "model.logLevel",
        label: "日志级别",
        kind: "enum",
        choices: ["silent", "warn", "info", "debug"],
        defaultValue: "warn",
      },
      // The other three namespaces, in the same form. They were config-file-only
      // edits for as long as the page drew one section, but there was never a
      // structural reason for that: a save merges per key, so a key this table
      // does not draw has always been *writable*, just un-formatted. What the
      // page adds is the same thing it added for `model.*` -- the reader's own
      // default and bounds, an is-default badge, and no way to typo a key name
      // into the file and have it silently mean nothing.
      { heading: "服务" },
      {
        key: "service.url",
        label: "服务地址",
        kind: "text",
        defaultValue: "",
        help: "留空 = 发现端口上的推理服务，没有就自己启动一个。填了它 = 用你自己起的服务，插件不再启动。",
      },
      {
        key: "service.host",
        label: "监听地址",
        kind: "text",
        defaultValue: "127.0.0.1",
      },
      {
        key: "service.port",
        label: "端口",
        kind: "number",
        defaultValue: 4748,
        min: 1,
        max: 65535,
        help: "推理服务的起始端口，被占用时递增。网页占 4747，两者不会撞。",
      },
      {
        key: "service.autostart",
        label: "自动启动",
        kind: "boolean",
        defaultValue: true,
        help: "关掉后，没有服务在听时插件不会自己拉起推理进程。",
      },
      {
        key: "service.idleMinutes",
        label: "空闲退出",
        kind: "number",
        defaultValue: 10,
        min: 0,
        max: 1440,
        help: "空闲多少分钟后推理进程退出，0 = 不退出。",
      },
      {
        key: "service.startTimeoutMs",
        label: "启动超时",
        kind: "number",
        defaultValue: 30000,
        min: 1000,
        max: 300000,
        help: "等新启动的服务报健康的最长时间，毫秒。超时日志报 `service did not become healthy`。",
      },
      { heading: "网页" },
      // `web.enabled` is deliberately not a field. The memory browser is where the
      // settings are edited, so a switch that turns off the page it lives on is a
      // way to lose the only surface that can turn it back on. `readWebConfig` still
      // honours a hand-written `web.enabled: false`, and the form preserves the key
      // either way -- it just does not offer it.
      {
        key: "web.port",
        label: "端口",
        kind: "number",
        defaultValue: 4747,
        min: 1,
        max: 65535,
        help: "被占用时自动往上找，实际端口见日志 `memory browser at` 一行。",
      },
      {
        key: "web.host",
        label: "监听地址",
        kind: "text",
        defaultValue: "127.0.0.1",
        help: "只听本机即可。改成非回环地址必须同时设密码，否则任何能连上这个端口的人都能读记忆、改注入文件。",
      },
      {
        key: "web.dir",
        label: "前端目录",
        kind: "text",
        defaultValue: "",
        help: "留空 = 插件目录旁的 web/dist。",
      },
      {
        key: "web.authUser",
        label: "登录名",
        kind: "text",
        defaultValue: "",
        help: "留空 = 系统账户名。只在设置了密码时生效。",
      },
      {
        key: "web.authPassword",
        label: "密码",
        kind: "secret",
        defaultValue: "",
        help: "留空 = 不认证（仅在本机收听时安全）。支持 env://NAME 与 file:///path。值不会回传到页面，只显示「已设置」。",
      },
      { heading: "文档语料" },
      {
        key: "wiki.enabled",
        label: "启用语料",
        kind: "boolean",
        defaultValue: true,
        help: "关掉 = wiki 目录的文件不进索引，memory_wiki_import 不再注册。",
      },
      {
        key: "wiki.dir",
        label: "目录",
        kind: "text",
        defaultValue: "",
        help: "留空 = ~/.config/opencode/mem-plus/wiki。",
      },
    ],
  },
];

// One section, six groups. The form used to draw `model.*` only: the other three
// namespaces still worked, still had real defaults, and were still preserved on
// save -- they were simply not editable here, and `web.*` in particular was
// config-file-only. They are in the form now. The section id stays a single
// React-key prefix (`${section.id}:${item.key}`); it is not a namespace symbol
// and is not persisted anywhere, so it names the form, not the fields under it.

/** Every key the form knows, for the "no such key" check on save. */
export const CONFIG_KEYS: readonly string[] = CONFIG_SECTIONS.flatMap((s) =>
  s.fields.filter((f): f is ConfigField => !isHeading(f) && !isAction(f)).map((f) => f.key)
);

/** Read a dotted path out of an object, or `undefined`. */
export function readPath(
  source: Record<string, unknown> | null,
  dotted: string
): unknown {
  if (!source) return undefined;
  let current: unknown = source;
  for (const part of dotted.split(".")) {
    if (typeof current !== "object" || current === null || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * Write a dotted path, creating the objects on the way, and **delete** the key
 * when `value` is `undefined` -- that is how "恢复默认" works: remove the key and
 * the plugin's reader falls back to its own default again.
 */
export function writePath(
  source: Record<string, unknown>,
  dotted: string,
  value: unknown
): Record<string, unknown> {
  const parts = dotted.split(".");
  const out: Record<string, unknown> = { ...source };
  let cursor = out;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i] as string;
    const existing = cursor[part];
    const next: Record<string, unknown> =
      typeof existing === "object" && existing !== null && !Array.isArray(existing)
        ? { ...(existing as Record<string, unknown>) }
        : {};
    cursor[part] = next;
    cursor = next;
  }
  const last = parts[parts.length - 1] as string;
  if (value === undefined) delete cursor[last];
  else cursor[last] = value;
  return out;
}