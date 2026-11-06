import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Cpu, HardDrive, MoreVertical, RefreshCw, Search, Trash2, TriangleAlert, X, Zap } from "lucide-react";
import { toast } from "sonner";
import { fetchAPI } from "$lib/api";
import { Badge } from "$lib/components/ui/badge";
import { Button } from "$lib/components/ui/button";
import { Input } from "$lib/components/ui/input";
import { Picker, type PickerOption } from "$lib/components/ui/picker";
import { Switch } from "$lib/components/ui/switch";
import { useI18n } from "$lib/i18n";

type RuntimeVariant = "vulkan" | "cuda" | "cpu";
/** 列表行的 id：三个真变体（harmony/office 行已按机主 2026-11-05 指令删除）。 */
type EngineId = RuntimeVariant;

/** `/api/runtime` 载荷里每个引擎/框架的行（LM 引擎列表的对应物）。 */
type VariantInfo = {
  id: EngineId;
  kind: "engine" | "framework";
  label: string;
  sizeBytes: number | null;
  installed: boolean;
  /** LM localVersion 维度：家族里实际装着的最高 tag；没装过 = null。 */
  installedVersion: string | null;
  /** installedVersion 有值但不是钉死 tag——「已装 · 可更新」，不是「没装」。 */
  updateAvailable: boolean;
  compatible: boolean;
  reason: string | null;
  preparing: boolean;
  /** true = 真变体（可下拉选择、可准备、有菜单）；false = 只列不卖。 */
  selectable: boolean;
};

/** GET /api/runtime/files 的一行：一个已下载文件（解压目录或 zip）。 */
type RuntimeFileEntry = {
  name: string;
  kind: "directory" | "zip";
  tag: string | null;
  sizeBytes: number | null;
  /** true = 生效引擎正在用的当前 tag 目录，不能删（服务端也拦）。 */
  inUse: boolean;
};

/**
 * `/api/runtime` 的载荷，字段与 `handleRuntimeStatus` 一一对应。
 * 类型不是 schema：插件不发的字段就是没有，页面按没有渲染。
 */
type RuntimeStatus = {
  tag: string;
  tagKnown: boolean;
  runtimeDir: string;
  runtimeZip: string;
  downloaded: boolean;
  zipPresent: boolean;
  device: string | null;
  embedderId: string;
  embedEnabled: boolean;
  embedModelPath: string;
  embedModelPresent: boolean;
  stale: string[];
  missing: number;
  actionsAvailable: boolean;
  variantSelected: RuntimeVariant;
  variantActive: RuntimeVariant;
  variantPending: boolean;
  /** 自动对齐把 runtime.json 写新后：重启 OpenCode 生效（换 spawn 用的运行时）。 */
  tagPending: boolean;
  autoPrepareRuntime: boolean;
  variants: VariantInfo[];
  service: {
    url: string;
    variant: string | null;
    backend: string | null;
    loadedEmbed: boolean;
    port: number | null;
    uptimeSeconds: number | null;
  } | null;
};

type RuntimeAction = { ok: boolean; detail: string };
type UpdatesResult = { pinned: string; latest: string | null; newer: boolean; note: string };
type Busy = "select" | "toggle" | "prepare" | "release" | null;

/** 十进制 MB（LM Studio 的口径：7.65 MB / 236.17 MB 都是 /1e6）。 */
function mb(bytes: number): string {
  return String(Math.round(bytes / 1e6));
}

// Row/Section 两个助手随底部状态区一并删除——LM 没有那块（机主 2026-11-05 指令）。
/** 区标题（卡上方的正文行，LM「Runtime Selections」的位置与字号）。 */
function Heading({ children }: { children: ReactNode }) {
  return <div className="px-4 pt-1 pb-2 text-sm font-medium text-foreground/90">{children}</div>;
}

/** LM 式卡：圆角描边容器，行间细分隔。不裁剪（行内菜单要伸出）。 */
function Card({ children }: { children: ReactNode }) {
  return <div className="mx-4 divide-y divide-border/50 rounded-xl border border-border bg-background/40">{children}</div>;
}

/** 卡内行：左标签，右控件（LM 的 SettingsRow 无 subtitle，故不带提示行）。 */
function CardRow({
  label,
  children,
}: {
  label: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3 px-3.5 py-2.5">
      <div className="min-w-0">
        <div className="flex items-center gap-1.5 text-sm text-foreground/90">{label}</div>
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}

/**
 * 运行时页：LM Studio Runtime 设置页的布局移植（机主 2026-11-04 拍板：
 * 「布局格式功能一致，配色风格用我们的」，且三件被砍过的件逐件做真功能——
 * 自动补下开关、更新通道、搜索/过滤都接真配置与真过滤）。蓝本来自本机
 * LM Studio 的字符串定点抽取（REA 对 36.9MB 单行 webpack 包解析失败，
 * 见 port-plan）。
 *
 * 状态每次 GET 现读；准备（下载 592 MB 级文件）是火速返回 + 引擎行
 * 「准备中」灯 + 4 秒轮询直到完成——页面超时不该等于任务失败。
 */
export function RuntimeView() {
  const { t } = useI18n();
  const [status, setStatus] = useState<RuntimeStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<Busy>(null);
  const [checking, setChecking] = useState(false);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [filterQuery, setFilterQuery] = useState("");
  const [filterCompat, setFilterCompat] = useState("all");
  const [filterType, setFilterType] = useState("all");
  // 「删除已下载文件」弹层：点开列表选具体文件删（机主 2026-11-05 拍板，
  // 不一键清空整个引擎）。
  const [filesFor, setFilesFor] = useState<VariantInfo | null>(null);
  const [files, setFiles] = useState<RuntimeFileEntry[] | null>(null);
  const [filesError, setFilesError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await fetchAPI<RuntimeStatus>("/api/runtime");
      if (result.success && result.data) {
        setStatus(result.data);
        setError(null);
      } else {
        setError(result.error ?? t("rt-status-unavailable"));
      }
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  // 准备灯亮着就轮询（4 秒）：--ensure 在后台跑，页面跟着它走到「已安装」。
  const anyPreparing = status?.variants.some((v) => v.preparing) === true;
  useEffect(() => {
    if (!anyPreparing) return;
    const timer = setInterval(() => void load(), 4000);
    return () => clearInterval(timer);
  }, [anyPreparing, load]);

  async function post<T>(
    endpoint: string,
    body: unknown,
    timeout?: number,
  ): Promise<{ ok: boolean; data?: T; error?: string }> {
    const result = await fetchAPI<T>(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      ...(timeout !== undefined ? { timeout } : {}),
    });
    return { ok: result.success && !!result.data, data: result.data, error: result.error };
  }

  /**
   * 下拉换引擎：**只写配置，不因此起服务**（照 LM Studio 的 Runtime 设置，
   * 本机 0.4.28 实测：选中只发 `selectBackend` RPC 写默认引擎）。服务已经在
   * 跑时后端顺手重启换引擎；没在跑就等下次启动——选 CPU 不再替人拉起慢服务
   * （机主 2026-11-06 定）。
   */
  async function selectVariant(value: string) {
    if (!status || value === status.variantSelected) return;
    setBusy("select");
    try {
      const r = await post<{
        variant: string;
        active: string | null;
        pending: boolean;
        restartAttempted: boolean;
        restartOk: boolean | null;
        detail?: string;
      }>("/api/runtime/select", { variant: value }, 60_000);
      if (r.ok && r.data) {
        const label = status.variants.find((v) => v.id === value)?.label ?? value;
        if (!r.data.restartAttempted) {
          // 服务没在跑：配置已写，下次启动生效。不起服务。
          toast.info(t("rt-select-pending", { variant: label }), { description: r.data.detail });
        } else if (r.data.restartOk === false || r.data.pending) {
          // 重启没成（服务由别的实例持有 / 30 秒没就绪）——如实说，别把
          // 没生效说成顺利切换。
          toast.warning(t("rt-select-ok", { variant: label }), { description: r.data.detail });
        } else {
          toast.success(t("rt-select-ok", { variant: label }), { description: r.data.detail });
        }
        await load();
      } else {
        toast.error(t("rt-select-failed"), { description: r.error });
      }
    } finally {
      setBusy(null);
    }
  }

  /** 自动补下开关：只写配置，spawn 时活读——重启推理服务生效。 */
  async function toggleAutoPrepare(next: boolean) {
    setBusy("toggle");
    try {
      const r = await post<{ enabled: boolean }>("/api/runtime/auto-prepare", { enabled: next });
      if (r.ok) {
        toast.success(next ? t("rt-auto-saved-on") : t("rt-auto-saved-off"));
        await load();
      } else {
        toast.error(t("rt-action-failed"), { description: r.error });
      }
    } finally {
      setBusy(null);
    }
  }

  /** 行内「安装 / 重新下载」：火速后台取件，灯亮后轮询。 */
  async function prepareRow(v: VariantInfo, force: boolean) {
    setBusy("prepare");
    setMenuFor(null);
    try {
      const r = await post<RuntimeAction>("/api/runtime/prepare", { variant: v.id, force });
      if (r.ok && r.data) {
        toast[r.data.ok ? "success" : "error"](r.data.detail);
      } else {
        toast.error(t("rt-action-failed"), { description: r.error });
      }
      await load();
    } finally {
      setBusy(null);
    }
  }

  /** 打开「已下载文件」列表（列表式删除：选哪条删哪条，不一键清空）。 */
  async function openFiles(v: VariantInfo) {
    setMenuFor(null);
    setFilesFor(v);
    setFiles(null);
    setFilesError(null);
    const result = await fetchAPI<{ files: RuntimeFileEntry[] }>(`/api/runtime/files?variant=${v.id}`);
    if (result.success && result.data) {
      setFiles(result.data.files);
    } else {
      setFilesError(result.error ?? t("rt-action-failed"));
      setFiles([]);
    }
  }

  /** 删完一条后刷新列表与引擎状态。 */
  async function refreshFiles() {
    if (!filesFor) return;
    const result = await fetchAPI<{ files: RuntimeFileEntry[] }>(`/api/runtime/files?variant=${filesFor.id}`);
    if (result.success && result.data) setFiles(result.data.files);
  }

  /** 列表里删一个文件：服务端三道守卫（模式、生效占用、准备中），失败照实弹。 */
  async function releaseFile(name: string) {
    if (!filesFor) return;
    setBusy("release");
    try {
      const r = await post<RuntimeAction>("/api/runtime/release", { variant: filesFor.id, name });
      if (r.ok && r.data) toast[r.data.ok ? "success" : "error"](r.data.detail);
      else toast.error(t("rt-action-failed"), { description: r.error });
      await refreshFiles();
      await load();
    } finally {
      setBusy(null);
    }
  }

  function closeFiles() {
    setFilesFor(null);
    setFiles(null);
    setFilesError(null);
  }

  async function checkUpdates() {
    setChecking(true);
    try {
      const r = await post<UpdatesResult>("/api/runtime/updates", {});
      if (r.ok && r.data) {
        const msg =
          r.data.latest === null
            ? t("rt-updates-none")
            : r.data.newer
              ? t("rt-updates-behind", { latest: r.data.latest })
              : t("rt-updates-same");
        toast.success(msg);
      } else {
        toast.error(t("rt-updates-failed"), { description: r.error });
      }
    } finally {
      setChecking(false);
    }
  }

  const usable = status?.actionsAvailable === true;
  const busyAny = busy !== null;

  // 引擎下拉（GGUF 行）：只列真变体，不适配的项禁用，hint = 当前 tag。
  const engineOptions: PickerOption[] = (status?.variants ?? [])
    .filter((v) => v.selectable)
    .map((v) => ({
      value: v.id,
      label: v.label,
      hint: status?.tag ?? "",
      disabled: !v.compatible,
    }));

  // 真过滤（LM 的搜索/仅兼容/类型三件，对真数据生效）。类型枚举照 LM 三选
  // 保留 Engines/Frameworks/All types；framework 行已删，「框架」选出来是
  // 空态 + 清除筛选（格式与 LM 一致，数据如实为空）。
  const shownVariants = (status?.variants ?? []).filter((v) => {
    if (filterCompat === "compatible" && !v.compatible) return false;
    if (filterType !== "all" && v.kind !== filterType) return false;
    const needle = filterQuery.trim().toLowerCase();
    if (needle.length > 0) {
      const haystack = `${v.label} ${v.reason ?? ""} ${v.id}`.toLowerCase();
      if (!haystack.includes(needle)) return false;
    }
    return true;
  });

  // 引擎行的 label（横幅与 toast 用整名，不露 id）。
  const variantLabel = (id: string | null): string =>
    (status?.variants ?? []).find((v) => v.id === id)?.label ?? id ?? "";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {error ? (
        <div className="mb-3 rounded-lg border border-destructive/40 bg-destructive/10 p-2.5 text-sm">{error}</div>
      ) : null}

      <section className="flex min-h-0 flex-1 flex-col rounded-xl border border-border bg-card">
        <div className="shrink-0 space-y-2 p-4">
          <div className="flex flex-wrap items-center gap-2">
            {status && !status.tagKnown ? <Badge variant="secondary">{t("rt-runtime-tag-bad")}</Badge> : null}
            <Button
              variant="outline"
              size="icon"
              className="ms-auto"
              onClick={() => void load()}
              aria-label={t("btn-refresh")}
              disabled={loading}
            >
              <RefreshCw className={`size-4 ${loading ? "animate-spin" : ""}`} />
            </Button>
          </div>
          {/* 变体「待重启」横幅回来了（2026-11-06：选中不再起服务，服务在跑且
              引擎还是旧的时，只有重启 OpenCode 才能换过来）。tagPending 仍在：
              自动对齐写新 runtime.json 后要重载才换 spawn 用的目录。 */}
          {status?.variantPending ? (
            <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-2.5 text-sm text-amber-700 dark:text-amber-300">
              <TriangleAlert className="mt-0.5 size-4 shrink-0" />
              <span>
                {t("rt-variant-pending", {
                  variant: variantLabel(status.variantSelected),
                  active: variantLabel(status.variantActive),
                })}
              </span>
            </div>
          ) : null}
          {status?.tagPending ? (
            <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-2.5 text-sm text-amber-700 dark:text-amber-300">
              <TriangleAlert className="mt-0.5 size-4 shrink-0" />
              <span>{t("rt-tag-pending", { tag: status.tag })}</span>
            </div>
          ) : null}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden pb-2 [scrollbar-gutter:stable]">
          {!status && !error ? (
            <div className="px-4 py-3 text-sm text-muted-foreground">…</div>
          ) : status ? (
            <>
              {/* LM「Runtime Selections」：GGUF 行 + 开关行，同一张卡。 */}
              <Heading>{t("rt-sel-heading")}</Heading>
              <Card>
                <CardRow
                  label="GGUF"
                  children={
                    <Picker
                      className="w-full sm:w-80"
                      value={status.variantSelected}
                      options={engineOptions}
                      onChange={(value) => void selectVariant(value)}
                      disabled={busyAny}
                    />
                  }
                />
                <CardRow
                  label={t("rt-sel-auto")}
                  children={
                    <Switch
                      checked={status.autoPrepareRuntime}
                      onCheckedChange={(next) => void toggleAutoPrepare(next)}
                      disabled={busyAny}
                      aria-label={t("rt-sel-auto")}
                    />
                  }
                />
              </Card>

              <div className="mt-4">
                {/* 机主 2026-11-06 指令：搜索栏放回本区（缩短到 w-48，不占整行），
                    「运行时更新」段落整段删除，检查更新按钮并入本行最右。 */}
                <Heading>{t("rt-engines-heading")}</Heading>
                <div className="flex flex-wrap items-center gap-2 px-4 pb-2">
                  <div className="relative w-48">
                    <Search className="pointer-events-none absolute start-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      className="ps-8"
                      placeholder={t("rt-filter-search")}
                      value={filterQuery}
                      onChange={(event) => setFilterQuery(event.target.value)}
                    />
                  </div>
                  <Picker
                    className="w-32"
                    value={filterCompat}
                    options={[
                      { value: "compatible", label: t("rt-filter-compatible") },
                      { value: "all", label: t("rt-filter-all") },
                    ]}
                    onChange={setFilterCompat}
                  />
                  <Picker
                    className="w-32"
                    value={filterType}
                    options={[
                      { value: "engine", label: t("rt-filter-type-engine") },
                      { value: "framework", label: t("rt-filter-type-framework") },
                      { value: "all", label: t("rt-filter-type-all") },
                    ]}
                    onChange={setFilterType}
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    className="ms-auto"
                    disabled={checking}
                    onClick={() => void checkUpdates()}
                  >
                    <RefreshCw className={`me-1.5 inline size-3 ${checking ? "animate-spin" : ""}`} />
                    {checking ? t("rt-updates-checking") : t("rt-updates-check")}
                  </Button>
                </div>
                <Card>
                  {shownVariants.length === 0 ? (
                    /* LM 空态：说明 + 「Clear Filters」按钮，点回默认三过滤。 */
                    <div className="flex flex-col items-center gap-3 p-4 py-8 text-sm text-muted-foreground">
                      <span>{t("rt-filter-empty")}</span>
                      <Button
                        variant="outline"
                        onClick={() => {
                          setFilterCompat("all");
                          setFilterType("all");
                          setFilterQuery("");
                        }}
                      >
                        {t("rt-filter-clear")}
                      </Button>
                    </div>
                  ) : (
                    shownVariants.map((v) => (
                      <div key={v.id} className="flex items-start justify-between gap-3 px-3.5 py-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-1.5">
                            {v.id === "vulkan" ? (
                              <Cpu className="size-3.5 shrink-0 text-muted-foreground" />
                            ) : v.id === "cuda" ? (
                              <Zap className="size-3.5 shrink-0 text-muted-foreground" />
                            ) : (
                              <HardDrive className="size-3.5 shrink-0 text-muted-foreground" />
                            )}
                            <span className="text-sm font-medium">{v.label}</span>
                            {/* LM 的 RuntimeVersionBadge 对（bundle 字面：
                                `version:a.remoteVersion` 先挂，装了且与钉死值不
                                等才 `→ 已装版`）：钉死 tag → 已装旧版。机主
                                2026-11-05 指令「5 缩短点、更新按钮放 5 右边」
                                = 本行右端。 */}
                            {status.tagKnown ? (
                              <Badge variant="outline" className="px-1.5 py-0 text-[11px] font-normal">
                                {v.installedVersion === status.tag
                                  ? t("rt-badge-installed", { tag: status.tag })
                                  : t("rt-badge-latest", { tag: status.tag })}
                              </Badge>
                            ) : null}
                            {v.installedVersion && v.installedVersion !== status.tag ? (
                              <>
                                <span className="text-xs text-muted-foreground">→</span>
                                <Badge variant="outline" className="px-1.5 py-0 text-[11px] font-normal">
                                  {t("rt-badge-installed", { tag: v.installedVersion })}
                                </Badge>
                              </>
                            ) : null}
                            {v.selectable && (!v.installed || v.updateAvailable) ? (
                              <Button
                                size="sm"
                                className="ms-1 h-6 px-2 text-xs"
                                disabled={!usable || v.preparing || busyAny}
                                onClick={() => void prepareRow(v, false)}
                              >
                                {v.preparing ? (
                                  <>
                                    <RefreshCw className="me-1 inline size-3 animate-spin" />
                                    {t("rt-act-preparing")}
                                  </>
                                ) : v.updateAvailable ? (
                                  t("rt-act-update-plain")
                                ) : (
                                  t("rt-act-install-plain")
                                )}
                              </Button>
                            ) : null}
                          </div>
                          <p className="mt-0.5 truncate text-xs text-muted-foreground">
                            {v.id === "cuda"
                              ? t("rt-engine-cuda-desc")
                              : v.id === "vulkan"
                                ? t("rt-engine-vulkan-desc")
                                : t("rt-engine-cpu-desc")}
                          </p>
                          {/* 不适配（cuda 无卡等）→ 红字照实报，位置同 LM 的
                              destructive description 行。 */}
                          {!v.compatible && v.reason !== null ? (
                            <p className="mt-0.5 text-xs text-destructive">{v.reason}</p>
                          ) : null}
                          {v.preparing ? (
                            <p className="mt-0.5 text-xs text-primary">{t("rt-engine-downloading")}</p>
                          ) : null}
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          {/* LM 行右侧只有三件：不适配红字 chip、下载/更新按钮、
                              ⋮ 菜单。「已安装/可更新/未下载」药丸已删（机主
                              2026-11-05 截图比对：LM 的安装态由版本徽章对表达，
                              不重复挂药丸）。 */}
                          {!v.compatible ? (
                            <span
                              className="inline-flex shrink-0 cursor-help items-center gap-1 rounded-full border border-destructive/40 bg-destructive/10 px-2 py-0.5 text-[11px] leading-[1.3] text-destructive"
                              title={v.reason ?? undefined}
                            >
                              <TriangleAlert className="size-3" />
                              {t("rt-engine-incompatible")}
                            </span>
                          ) : null}
                          {v.selectable ? (
                          <div className="relative">
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-8"
                              aria-label="更多操作"
                              disabled={!usable}
                              onClick={() => setMenuFor(menuFor === v.id ? null : v.id)}
                            >
                              <MoreVertical className="size-4" />
                            </Button>
                            {menuFor === v.id ? (
                              <>
                                <div className="fixed inset-0 z-40" onClick={() => setMenuFor(null)} />
                                <div className="absolute end-0 bottom-full z-50 mb-1 w-44 overflow-hidden rounded-lg border border-border bg-popover py-1 shadow-lg">
                                  <button
                                    type="button"
                                    className="w-full px-3 py-1.5 text-start text-sm hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                                    disabled={v.preparing || busyAny}
                                    onClick={() => void prepareRow(v, true)}
                                  >
                                    {t("rt-menu-redownload")}
                                  </button>
                                  <button
                                    type="button"
                                    className="w-full px-3 py-1.5 text-start text-sm text-destructive hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                                    disabled={v.preparing || busyAny}
                                    onClick={() => void openFiles(v)}
                                  >
                                    {t("rt-menu-release")}
                                  </button>
                                </div>
                              </>
                            ) : null}
                          </div>
                          ) : null}
                        </div>
                      </div>
                    ))
                  )}
                </Card>
              </div>

              {/* 「已下载文件」弹层（LM「管理版本」弹窗的对应物）：该引擎
                  全部 tag 的目录/zip 逐条列出，选哪条删哪条（机主 2026-11-05
                  拍板，不一键清空）；生效引擎正在用的当前 tag 目录禁删，
                  服务端另有一道 409。 */}
              {filesFor ? (
                <>
                  <div className="fixed inset-0 z-50 bg-black/40" onClick={closeFiles} />
                  <div
                    role="dialog"
                    aria-modal="true"
                    aria-label={t("rt-files-title", { variant: filesFor.label })}
                    className="fixed left-1/2 top-1/2 z-50 flex max-h-[80vh] w-[min(92vw,28rem)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-border bg-popover shadow-2xl"
                  >
                    <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
                      <span className="min-w-0 truncate text-sm font-medium">
                        {t("rt-files-title", { variant: filesFor.label })}
                      </span>
                      <button
                        type="button"
                        className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-muted"
                        aria-label={t("rt-files-close")}
                        onClick={closeFiles}
                      >
                        <X className="size-4" />
                      </button>
                    </div>
                    <div className="min-h-0 flex-1 overflow-y-auto p-2">
                      {filesError ? (
                        <p className="px-2 py-6 text-center text-sm text-destructive">{filesError}</p>
                      ) : files === null ? (
                        <p className="px-2 py-6 text-center text-sm text-muted-foreground">
                          {t("rt-files-loading")}
                        </p>
                      ) : files.length === 0 ? (
                        <p className="px-2 py-6 text-center text-sm text-muted-foreground">
                          {t("rt-files-empty")}
                        </p>
                      ) : (
                        files.map((f) => (
                          <div key={f.name} className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-muted">
                            <div className="min-w-0 flex-1">
                              <p className="truncate font-mono text-xs" title={f.name}>
                                {f.name}
                              </p>
                              <p className="truncate text-[11px] text-muted-foreground">
                                {[
                                  f.sizeBytes !== null ? `${mb(f.sizeBytes)} MB` : "",
                                  f.tag ?? "",
                                  f.inUse ? t("rt-file-in-use") : "",
                                ]
                                  .filter((piece) => piece.length > 0)
                                  .join(" · ")}
                              </p>
                            </div>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-7 shrink-0 text-destructive"
                              disabled={f.inUse || busyAny}
                              title={f.inUse ? t("rt-file-in-use") : undefined}
                              aria-label={t("rt-file-delete")}
                              onClick={() => void releaseFile(f.name)}
                            >
                              <Trash2 className="size-3.5" />
                            </Button>
                          </div>
                        ))
                      )}
                    </div>
                    <div className="flex justify-end border-t border-border px-4 py-2.5">
                      <Button size="sm" variant="outline" onClick={closeFiles}>
                        {t("rt-files-close")}
                      </Button>
                    </div>
                  </div>
                </>
              ) : null}

            </>
          ) : null}
        </div>
      </section>
    </div>
  );
}
