import { useState } from "react";
import { AlertTriangle, Eraser } from "lucide-react";
import { toast } from "sonner";
import { fetchAPI } from "$lib/api";
import { Button } from "$lib/components/ui/button";
import { Input } from "$lib/components/ui/input";
import { useI18n } from "$lib/i18n";

/**
 * 上游 `openclaw memory forget` 的网页入口。
 *
 * 为什么放在这里而不是做成工具：上游刻意把 forget 留在 CLI 里，不交给模型，理由是它
 * 会不可逆地改写用户的记忆文件 —— 这属于人做一个明确决定，不是 agent 自己决定要忘掉
 * 什么。`memory_reindex` 有工具是因为重建索引不丢东西，这个会。
 *
 * 两步：先预览（`dryRun`，上游自己的安全阀，也是这个端点的默认值），确认数字之后再点
 * 一次执行。两次之间不缓存任何东西 —— 预览与执行之间文件可能变，所以执行时服务端会
 * 重新读一遍并做哈希校验。
 *
 * 判据是会话标识，跟上游一致：血���表 `memory_entry_origins` 记录每条长期记忆是由哪个
 * 会话产生的，forget 靠它反查。**没有血缘行的条目删不掉** —— 它们会被列进
 * `untargetableEntryKeys`，因为无法确定归属。这是上游同款限制，不是本页的取舍。
 */
type ForgetReport = {
  dryRun?: boolean;
  sessionIds?: string[];
  entryKeys?: string[];
  mixedLineageEntryKeys?: string[];
  untargetableEntryKeys?: string[];
  artifacts?: {
    memoryFiles?: number;
    memoryEntries?: number;
    memoryLines?: number;
    originRows?: number;
    tombstones?: number;
  };
  refusals?: string[];
};

function describe(t: (key: string, vars?: Record<string, string>) => string, r: ForgetReport): string {
  const a = r.artifacts ?? {};
  const n = (v: unknown) => String(v ?? 0);
  const lines: string[] = [];
  lines.push(
    t(r.dryRun ? "forget-preview-found" : "forget-applied-found", {
      files: n(a.memoryFiles),
      entries: n(a.memoryEntries),
      keys: n(r.entryKeys?.length),
    })
  );
  const untargetable = r.untargetableEntryKeys?.length ?? 0;
  if (untargetable > 0) lines.push(t("forget-untargetable", { count: n(untargetable) }));
  const mixed = r.mixedLineageEntryKeys?.length ?? 0;
  if (mixed > 0) lines.push(t("forget-mixed", { count: n(mixed) }));
  for (const refusal of r.refusals ?? []) lines.push(`${t("forget-refusal")} ${refusal}`);
  return lines.join("\n");
}

export function ForgetRow() {
  const { t } = useI18n();
  const [session, setSession] = useState("");
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const sessions = session
    .split(/[\s,]+/u)
    .map((value) => value.trim())
    .filter(Boolean);

  async function call(dryRun: boolean) {
    setBusy(true);
    setError(null);
    if (!dryRun) setPreview(null);
    try {
      const result = await fetchAPI<ForgetReport>("/api/forget", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionIds: sessions, dryRun }),
      });
      if (result.success && result.data) {
        setPreview(describe(t, result.data));
        if (!dryRun) {
          setSession("");
          toast.success(t("forget-done-title"));
        }
      } else {
        const message = result.error ?? t("forget-failed");
        setError(message);
        toast.error(t("forget-failed-title"), { description: message });
      }
    } finally {
      setBusy(false);
    }
  }

  const canRun = sessions.length > 0 && !busy;

  return (
    <div className="grid gap-1.5 sm:grid-cols-[minmax(0,15rem)_minmax(0,1fr)] sm:items-start sm:gap-4">
      <div className="min-w-0 space-y-0.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-sm font-medium">{t("forget-label")}</span>
        </div>
        <p className="truncate font-mono text-xs text-muted-foreground/70">POST /api/forget</p>
      </div>

      <div className="min-w-0 space-y-1.5">
        <p className="text-sm text-muted-foreground">{t("forget-help")}</p>
        <Input
          value={session}
          onChange={(event) => setSession(event.target.value)}
          placeholder={t("forget-session-placeholder")}
          disabled={busy}
        />

        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={!canRun} onClick={() => void call(true)}>
            {t("forget-preview")}
          </Button>
          {/* Kept enabled after a preview so the numbers can be read before the
              irreversible step, which is the whole reason the preview exists. */}
          <Button
            size="sm"
            variant="destructive"
            disabled={!canRun}
            onClick={() => void call(false)}
          >
            <Eraser className="me-1.5 inline size-3" />
            {t("forget-execute")}
          </Button>
        </div>

        {sessions.length === 0 && !busy ? (
          <p className="flex items-start gap-1.5 text-sm text-muted-foreground">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            {t("forget-needs-session")}
          </p>
        ) : null}

        {error ? (
          <p className="rounded-lg border border-destructive/40 bg-destructive/10 p-2.5 text-sm">
            {error}
          </p>
        ) : null}

        {preview ? (
          <pre className="overflow-x-auto rounded-lg border border-border bg-muted/40 p-2.5 text-sm whitespace-pre-wrap">
            {preview}
          </pre>
        ) : null}
      </div>
    </div>
  );
}