import { FileCog, RefreshCw } from "lucide-react";
import {
  ConfigActions,
  ConfigAlerts,
  ConfigFileNotice,
  ConfigFormFields,
  ConfigParseErrors,
  useConfigFile,
} from "$lib/components/explorer/ConfigForm";
import { UpdateCheck } from "$lib/components/explorer/UpdateCheck";
import { Badge } from "$lib/components/ui/badge";
import { Button } from "$lib/components/ui/button";
import { formatDate } from "$lib/format";
import { useI18n } from "$lib/i18n";

// 设置: the form, and nothing but the form. For the same settings with the file
// taking shape beside the form, see ConfigFileView -- the read/save machinery
// they share lives in ConfigForm.tsx, because a write path in two places is a
// write path that can disagree with itself.
//
// Same shape as the other tabs: chrome pinned by layout, body scrolls.
export function ConfigView() {
  const { t } = useI18n();
  const cfg = useConfigFile();

  // Nothing can be edited until the file parses: a settings file with a syntax
  // error is a document we do not fully understand, and writing over it would be
  // a guess.
  const blocked = !cfg.exists || cfg.parseErrors.length > 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ConfigAlerts error={cfg.error} saved={cfg.saved} restartNeeded={cfg.config?.restartNeeded === true} />

      <UpdateCheck />

      <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-card shadow-[0_1px_0_color-mix(in_oklab,var(--border)_55%,transparent)]">
        <div className="shrink-0 space-y-2 border-b border-border/70 bg-muted/20 px-4 py-4 md:px-5">
          <div className="flex flex-wrap items-center gap-2">
            <FileCog className="size-4 shrink-0 text-muted-foreground" />
            <Badge variant="secondary">{t("cfg-own-file")}</Badge>
            <Button variant="ghost" size="icon" className="ms-auto" onClick={cfg.load} aria-label={t("btn-refresh")}>
              <RefreshCw className={`size-4 ${cfg.loading ? "animate-spin" : ""}`} />
            </Button>
          </div>

          <p className="text-[12px] break-all text-muted-foreground/90">{cfg.config?.path ?? "-"}</p>
          {cfg.exists ? (
            <p className="text-[12px] break-all text-muted-foreground/80">
              {t("cfg-file-meta", {
                bytes: String(cfg.config?.bytes ?? 0),
                when: cfg.config?.modifiedAt ? formatDate(cfg.config.modifiedAt) : "-",
              })}
            </p>
          ) : null}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-4 pb-3 pt-3 [scrollbar-gutter:stable] md:px-5">
          {cfg.loadFailed ? null : !cfg.exists ? (
            <ConfigFileNotice config={cfg.config} saving={cfg.saving} onCreate={() => void cfg.save(true)} />
          ) : cfg.parseErrors.length > 0 ? (
            <ConfigParseErrors parseErrors={cfg.parseErrors} />
          ) : (
            <ConfigFormFields
              draft={cfg.draft}
              secrets={cfg.secrets}
              models={cfg.models}
              modelsAvailable={cfg.modelsAvailable}
              modelFiles={cfg.modelFiles}
              resolvedPaths={cfg.resolvedPaths}
              disabled={blocked}
              onChange={cfg.setField}
            />
          )}
        </div>

        {cfg.exists && cfg.parseErrors.length === 0 ? (
          <ConfigActions
            saving={cfg.saving}
            dirty={cfg.dirty}
            disabled={blocked}
            onSave={() => void cfg.save()}
            onDiscard={cfg.discard}
          />
        ) : null}
      </section>
    </div>
  );
}
