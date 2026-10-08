import { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCw, Sparkles, Moon, TriangleAlert } from "lucide-react";
import { fetchAPI } from "$lib/api";
import { Alert, AlertDescription } from "$lib/components/ui/alert";
import { Badge } from "$lib/components/ui/badge";
import { Button } from "$lib/components/ui/button";
import { formatDate } from "$lib/format";
import { useI18n } from "$lib/i18n";
import { renderMarkdown } from "$lib/markdown";
import { parseDreams } from "$lib/dream-diary";
import type { PromptFile } from "$lib/types";

// The dream diary, read-only.
//
// `DREAMS.md` is the one surface openclaw writes for a human to read: the
// dreaming sweep appends one dated entry per night saying what it consolidated,
// and the deep phase's summary of what it promoted. Nothing injects it back into
// a prompt and there is no writer here, so this page only shows what is there.
//
// The file is a managed markdown document with two marker-delimited blocks, so it
// is split into entries (`parseDreams`) and each night becomes its own card --
// otherwise a few months of nights is one scroll of undifferentiated prose.
export function DreamsView() {
  const { t } = useI18n();
  const [file, setFile] = useState<PromptFile | null>(null);
  const [memoryHome, setMemoryHome] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const result = await fetchAPI<{ file: PromptFile; memoryHome: string }>("/api/dreams");
    setLoading(false);
    if (result.success && result.data) {
      setFile(result.data.file ?? null);
      setMemoryHome(result.data.memoryHome ?? "");
    } else {
      setError(result.error ?? t("toast-update-failed"));
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const parsed = useMemo(
    () => parseDreams(file?.exists ? (file.content ?? "") : ""),
    [file]
  );
  const entries = parsed.entries;
  const exists = file?.exists === true;

  return (
    /* Same shape as PromptFilesView: chrome pinned by layout, body the only
       thing that scrolls. */
    <div className="flex min-h-0 flex-1 flex-col">
      {error ? (
        <Alert variant="destructive" className="mb-3 shrink-0">
          <TriangleAlert />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {file ? (
        <section className="flex min-h-0 flex-1 flex-col rounded-xl border border-border bg-card">
          <div className="shrink-0 space-y-3 p-4">
            <div className="flex flex-wrap items-center gap-2">
              <Moon className="size-4 shrink-0 text-muted-foreground" />
              <span className="text-base font-medium">{file.name}</span>
              {exists ? (
                <Badge variant="secondary">{t("dreams-present")}</Badge>
              ) : (
                <Badge variant="outline" className="text-muted-foreground">
                  {t("dreams-absent-short")}
                </Badge>
              )}
              {entries.length > 0 ? (
                <span className="text-sm tabular-nums text-muted-foreground">
                  {t("text-dream-entries", { count: entries.length })}
                </span>
              ) : null}
              {exists ? (
                <span className="ms-auto text-sm tabular-nums text-muted-foreground">
                  {formatBytes(file.bytes ?? 0)}
                  {file.modifiedAt ? ` / ${formatDate(file.modifiedAt)}` : ""}
                </span>
              ) : null}
              <Button
                variant="outline"
                size="icon"
                onClick={load}
                aria-label={t("btn-refresh")}
                className={exists || entries.length > 0 ? "" : "ms-auto"}
              >
                <RefreshCw className={`size-4 ${loading ? "animate-spin" : ""}`} />
              </Button>
            </div>

            <p className="text-sm break-all text-muted-foreground">{file.path}</p>

            <p className="text-sm break-all text-muted-foreground">
              {t("label-injected-from", { workspace: "-", home: memoryHome })}
            </p>

            <p className="text-sm text-muted-foreground">{t("prompt-file-note-dreams")}</p>
          </div>

          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overflow-x-hidden px-4 [scrollbar-gutter:stable]">
            {!exists ? (
              <p className="text-sm text-muted-foreground">{t("dreams-absent")}</p>
            ) : file.truncated ? (
              <p className="text-sm text-muted-foreground">{t("prompt-file-truncated")}</p>
            ) : entries.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("dreams-no-entries")}</p>
            ) : (
              <>
                {entries.map((entry, i) => (
                  <article
                    key={`${entry.date}-${i}`}
                    className="space-y-2 rounded-lg border border-border bg-background/40 p-3"
                  >
                    <div className="flex items-center gap-1.5">
                      <Sparkles className="size-3.5 shrink-0 text-muted-foreground" />
                      {entry.date ? (
                        <span className="text-sm">{entry.date}</span>
                      ) : (
                        <span className="text-sm text-muted-foreground">
                          {t("dreams-undated")}
                        </span>
                      )}
                    </div>
                    <div
                      className="markdown-content prose max-w-none text-base leading-relaxed"
                      // The markdown is sanitized in renderMarkdown (DOMPurify).
                      dangerouslySetInnerHTML={{ __html: renderMarkdown(entry.narrative) }}
                    />
                  </article>
                ))}

                {parsed.deepSleep ? (
                  <article className="space-y-2 rounded-lg border border-border bg-background/40 p-3">
                    <div className="flex items-center gap-1.5">
                      <Moon className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="text-sm">{t("dreams-deep-heading")}</span>
                    </div>
                    <div
                      className="markdown-content prose max-w-none text-base leading-relaxed"
                      // The markdown is sanitized in renderMarkdown (DOMPurify).
                      dangerouslySetInnerHTML={{ __html: renderMarkdown(parsed.deepSleep) }}
                    />
                  </article>
                ) : null}
              </>
            )}
          </div>
        </section>
      ) : null}
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
