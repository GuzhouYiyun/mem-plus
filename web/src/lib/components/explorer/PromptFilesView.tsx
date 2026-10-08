import { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCw, Save, TriangleAlert, X } from "lucide-react";
import { toast } from "sonner";
import { fetchAPI } from "$lib/api";
import { Alert, AlertDescription } from "$lib/components/ui/alert";
import { Badge } from "$lib/components/ui/badge";
import { Button } from "$lib/components/ui/button";
import { Textarea } from "$lib/components/ui/textarea";
import { formatDate } from "$lib/format";
import { useI18n } from "$lib/i18n";
import { renderMarkdown } from "$lib/markdown";
import type { PromptFile } from "$lib/types";

// The prompt-injected files: one browser-style tab each, the selected file's
// content below, and an action bar pinned to the bottom of the visible page
// (sticky) -- EDIT alone, or SAVE + CANCEL once editing.
//
// Every user-facing string comes from the i18n table; this file is ASCII.
//
// Saves go through the plugin's write path: it sends the hash it read and
// refuses to overwrite a file that changed underneath.
export function PromptFilesView() {
  const { t } = useI18n();
  const [files, setFiles] = useState<PromptFile[]>([]);
  const [memoryHome, setMemoryHome] = useState("");
  const [workspaceDir, setWorkspaceDir] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const result = await fetchAPI<{
      files: PromptFile[];
      memoryHome: string;
      workspaceDir: string;
    }>("/api/prompt-files");
    setLoading(false);
    if (result.success && result.data) {
      const loaded = result.data.files ?? [];
      setFiles(loaded);
      setMemoryHome(result.data.memoryHome ?? "");
      setWorkspaceDir(result.data.workspaceDir ?? "");
      // Land on something useful: the first file that exists, else the first one.
      setSelected((prev) =>
        prev && loaded.some((file) => file.name === prev)
          ? prev
          : (loaded.find((file) => file.exists)?.name ?? loaded[0]?.name ?? null)
      );
    } else {
      setError(result.error ?? t("toast-update-failed"));
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const current = useMemo(
    () => files.find((file) => file.name === selected) ?? null,
    [files, selected]
  );
  const present = files.filter((file) => file.exists).length;
  const dirty = editing && draft !== (current?.content ?? "");

  function selectTab(name: string) {
    // Leaving a dirty editor silently would lose the edit; that is what CANCEL is for.
    if (dirty && !confirm(t("prompt-file-discard-confirm"))) return;
    setSelected(name);
    setEditing(false);
    setDraft("");
  }

  function startEdit() {
    if (!current) return;
    setDraft(current.content ?? "");
    setEditing(true);
  }

  function cancelEdit() {
    setEditing(false);
    setDraft("");
  }

  async function save() {
    if (!current) return;
    setSaving(true);
    const result = await fetchAPI<{ bytes: number; unchanged?: boolean }>(
      "/api/prompt-files",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: current.name,
          content: draft,
          baseSha256: current.sha256 ?? "",
        }),
      }
    );
    setSaving(false);
    if (result.success) {
      setEditing(false);
      toast.success(
        result.data?.unchanged
          ? t("prompt-file-save-noop")
          : t("prompt-file-save-ok", { bytes: result.data?.bytes ?? draft.length })
      );
      await load();
    } else {
      // 409 is the concurrency guard: reload and let the user re-apply.
      toast.error(result.error ?? t("toast-update-failed"));
    }
  }

  return (
    /* Flex column that fills the app's content area: the chrome (error alert, tab
       strip, file header, paths, note) is `shrink-0` so it never moves, the body
       takes the slack and is the only thing that scrolls, and the action bar sits
       at the bottom of the column. Nothing here needs `position: sticky` -- the
       window does not scroll at all (App gives the app `h-svh`). */
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      {error ? (
        <Alert variant="destructive" className="shrink-0">
          <TriangleAlert />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {/* Tab strip. It scrolls sideways on narrow windows but without scrollbar
          chrome -- `overflow-x: auto` also makes overflow-y compute to auto, which
          is what put that arrow widget at the end of the row. The count and the
          refresh button sit outside the scroller so they never slide away. */}
      <div className="flex shrink-0 items-center gap-2 border-b border-border">
        <div
          role="tablist"
          aria-label={t("tab-prompt-files")}
          className="flex flex-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {files.map((file) => {
            const active = file.name === current?.name;
            return (
              <button
                key={file.name}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => selectTab(file.name)}
                title={file.path}
                className={[
                  "-mb-px flex shrink-0 items-center gap-2 rounded-t-lg border px-4 py-2 text-xs font-medium transition-colors",
                  active
                    ? "border-border border-b-transparent bg-card text-foreground"
                    : "border-transparent bg-muted/40 text-muted-foreground hover:bg-muted hover:text-foreground",
                ].join(" ")}
              >
                <span
                  aria-hidden="true"
                  className={`size-2 shrink-0 rounded-full ${file.exists ? "bg-primary" : "bg-muted-foreground/40"}`}
                />
                <span className="whitespace-nowrap">{file.name}</span>
                <span className="whitespace-nowrap text-[0.6875rem] opacity-70">
                  {file.exists ? formatBytes(file.bytes ?? 0) : t("prompt-file-missing")}
                </span>
              </button>
            );
          })}
        </div>
        <div className="flex shrink-0 items-center gap-1.5 pe-1 text-xs text-muted-foreground">
          <span>{t("text-prompt-files-present", { present, total: files.length })}</span>
          <Button variant="outline" size="icon" onClick={load} aria-label={t("btn-refresh")}>
            <RefreshCw className={`size-4 ${loading ? "animate-spin" : ""}`} />
          </Button>
        </div>
      </div>

      {current ? (
        <section
          role="tabpanel"
          className="flex min-h-0 flex-1 flex-col rounded-b-xl border border-t-0 bg-card"
        >
          <div className="shrink-0 space-y-3 p-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-base font-medium">{current.name}</span>
              {current.exists ? (
                <Badge variant="secondary">{t("prompt-file-present")}</Badge>
              ) : (
                <Badge variant="outline" className="text-muted-foreground">
                  {t("prompt-file-missing")}
                </Badge>
              )}
              {current.exists ? (
                <span className="ms-auto text-sm tabular-nums text-muted-foreground">
                  {formatBytes(current.bytes ?? 0)}
                  {current.modifiedAt ? ` / ${formatDate(current.modifiedAt)}` : ""}
                </span>
              ) : null}
            </div>

            <p className="text-sm break-all text-muted-foreground">{current.path}</p>

            {memoryHome || workspaceDir ? (
              <p className="text-sm break-all text-muted-foreground">
                {t("label-injected-from", { workspace: workspaceDir, home: memoryHome })}
              </p>
            ) : null}

            {/* One plain sentence on what this file is for. Keyed by file name
                (prompt-file-note-agents, -soul, -identity, -user, -bootstrap,
                -memory) so the descriptions live with the other UI strings. */}
            <p className="text-sm text-muted-foreground">
              {t(`prompt-file-note-${current.name.replace(/\.md$/i, "").toLowerCase()}`)}
            </p>
          </div>

          {/* The only scrolling part of this view. `min-h-0` is what lets it shrink
              below its content size instead of pushing the action bar off. */}
          {/* `pr-4` past the shared `px-4` gives the scrollbar its own gap; see
              the note in MemoryList. */}
          <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-4 [scrollbar-gutter:stable]">
            {editing ? (
              <Textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                spellCheck={false}
                className="h-full min-h-64 resize-none font-mono text-sm leading-relaxed"
                aria-label={current.name}
              />
            ) : current.exists ? (
              current.truncated ? null : (
                <div
                  className="markdown-content prose max-w-none text-base leading-relaxed"
                  // The markdown is sanitized in renderMarkdown (DOMPurify).
                  dangerouslySetInnerHTML={{ __html: renderMarkdown(current.content ?? "") }}
                />
              )
            ) : (
              <p className="text-sm text-muted-foreground">{t("prompt-file-absent")}</p>
            )}
          </div>

          {/* The action bar is a sibling of the scroll area, not a sticky overlay:
              it is always the bottom row of the panel, whatever the text is doing. */}
          <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-border px-4 py-3">
            {current.truncated ? (
              <span className="text-xs text-muted-foreground">{t("prompt-file-truncated")}</span>
            ) : editing ? (
              <span className="text-xs tabular-nums text-muted-foreground">
                {t("prompt-file-draft-bytes", { bytes: new TextEncoder().encode(draft).length })}
              </span>
            ) : (
              <span />
            )}
            {editing ? (
              <>
                <Button size="sm" className="ms-auto" onClick={save} disabled={saving || !dirty}>
                  <Save className="size-3.5" />
                  {saving ? t("prompt-file-saving") : t("btn-save")}
                </Button>
                <Button size="sm" variant="outline" onClick={cancelEdit} disabled={saving}>
                  <X className="size-3.5" />
                  {t("btn-cancel")}
                </Button>
              </>
            ) : (
              <Button size="sm" variant="secondary" className="ms-auto" onClick={startEdit}>
                {t("btn-edit")}
              </Button>
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