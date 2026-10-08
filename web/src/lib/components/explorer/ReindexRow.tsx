import { useState } from "react";
import { RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { fetchAPI } from "$lib/api";
import { Button } from "$lib/components/ui/button";
import { useI18n } from "$lib/i18n";

/**
 * The counts `runReindex` returns, which is what this row reads.
 *
 * Deliberately not the tool's own report text. That text is English and written for
 * the *model* reading a tool result; this page is Chinese-only, and translating it
 * would mean keeping a second phrasing of the same numbers in step by hand. The
 * structured counts come from the same function, so they cannot drift from what the
 * tool would say.
 *
 * There is no standing "N vectors" readout, and `/api/stats` is not consulted here.
 * It was, and it was wrong twice over: it only refreshes when the row mounts or when
 * a rebuild finishes, so a background sweep indexing new memories leaves a number on
 * screen that is quietly out of date -- a stale figure with no marker saying it is
 * stale is worse than no figure. The counts that matter appear in the report below,
 * written at the moment they were true.
 */
type ReindexCounts = {
  scanned?: number;
  indexed?: number;
  skipped?: number;
  pruned?: number;
  embedded?: number;
  documents?: number;
  units?: number;
  vectors?: number;
};

/** One Chinese line per thing that happened, skipping the ones that did not. */
function describe(t: (key: string, vars?: Record<string, string>) => string, m: ReindexCounts): string[] {
  const n = (v: unknown) => String(v ?? 0);
  const lines: string[] = [];
  lines.push(t("reindex-scanned", { scanned: n(m.scanned), indexed: n(m.indexed) }));
  if ((m.skipped ?? 0) > 0) lines.push(t("reindex-unchanged", { count: n(m.skipped) }));
  if ((m.pruned ?? 0) > 0) lines.push(t("reindex-pruned", { count: n(m.pruned) }));
  lines.push(t("reindex-embedded", { count: n(m.embedded) }));
  lines.push(t("reindex-index-now", { documents: n(m.documents), units: n(m.units), vectors: n(m.vectors) }));
  return lines;
}

/**
 * "Rebuild the index with the embedding model."
 *
 * It calls `/api/reindex`, which runs the *same* code path as the `memory_reindex`
 * tool rather than a page-side reimplementation -- so what the button reports and
 * what an agent would get cannot drift apart.
 *
 * A click with no usable embedding model is refused by the server, which names which
 * of the three reasons applies (switch off / a configured path that does not exist /
 * the default location empty). That message is shown as a toast and kept inline: a
 * toast alone fades before you have read the path out of it.
 */
export function ReindexRow({ embedEnabled }: { embedEnabled: boolean }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    setReport(null);
    try {
      const result = await fetchAPI<{ content: string; metadata?: ReindexCounts }>("/api/reindex", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ embed: true }),
        // The walk plus embedding is minutes of work on a real memory store, well
        // past the 30s default -- and the request must not be cut off halfway,
        // because a half-embedded index is the confusing outcome.
        timeout: 30 * 60_000,
      });
      if (result.success && result.data) {
        setReport(describe(t, result.data.metadata ?? {}).join("\n"));
      } else {
        const message = result.error ?? t("reindex-failed");
        setError(message);
        toast.error(t("reindex-no-model-title"), { description: message });
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-1.5 sm:grid-cols-[minmax(0,15rem)_minmax(0,1fr)] sm:items-start sm:gap-4">
      <div className="min-w-0 space-y-0.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-sm font-medium">{t("reindex-label")}</span>
        </div>
        <p className="truncate font-mono text-xs text-muted-foreground">POST /api/reindex</p>
      </div>

      <div className="min-w-0 space-y-1.5">
        <Button size="sm" disabled={busy} onClick={() => void run()}>
          {busy ? (
            <>
              <RefreshCw className="me-1.5 inline size-3 animate-spin" />
              {t("reindex-running")}
            </>
          ) : (
            t("reindex-run")
          )}
        </Button>

        {!embedEnabled ? (
          <p className="text-sm text-muted-foreground">{t("reindex-needs-embed")}</p>
        ) : null}
        {error ? (
          <p className="rounded-lg border border-destructive/40 bg-destructive/10 p-2.5 text-sm">
            {error}
          </p>
        ) : null}

        {report ? (
          <pre className="overflow-x-auto rounded-lg border border-border bg-muted/40 p-2.5 text-sm whitespace-pre-wrap">
            {report}
          </pre>
        ) : null}
      </div>
    </div>
  );
}