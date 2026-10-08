import { FileCog, RefreshCw } from "lucide-react";
import {
  ConfigActions,
  ConfigAlerts,
  ConfigFileNotice,
  ConfigFormFields,
  ConfigParseErrors,
  useConfigFile,
} from "$lib/components/explorer/ConfigForm";
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
      <ConfigAlerts error={cfg.error} saved={cfg.saved} />

      <section className="flex min-h-0 flex-1 flex-col rounded-xl border border-border bg-card">
        <div className="shrink-0 space-y-2 p-4">
          <div className="flex flex-wrap items-center gap-2">
            {/* No heading here. The page title above and the nav item both already
                say 设置, and this card used to repeat it a third time -- three
                copies of one word on one screen, two of them within 200px. The
                badge is what the card is actually about: the file it edits. */}
            <FileCog className="size-4 shrink-0 text-muted-foreground" />
            <Badge variant="secondary">{t("cfg-own-file")}</Badge>
            <Button variant="outline" size="icon" className="ms-auto" onClick={cfg.load} aria-label={t("btn-refresh")}>
              <RefreshCw className={`size-4 ${cfg.loading ? "animate-spin" : ""}`} />
            </Button>
          </div>

          <p className="text-sm break-all text-muted-foreground">{cfg.config?.path ?? "-"}</p>
          {cfg.exists ? (
            <p className="text-sm break-all text-muted-foreground">
              {t("cfg-file-meta", {
                bytes: String(cfg.config?.bytes ?? 0),
                when: cfg.config?.modifiedAt ? formatDate(cfg.config.modifiedAt) : "-",
              })}
            </p>
          ) : null}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-4 pb-2 [scrollbar-gutter:stable]">
          {!cfg.exists ? (
            <ConfigFileNotice config={cfg.config} saving={cfg.saving} onCreate={() => void cfg.save(true)} />
          ) : cfg.parseErrors.length > 0 ? (
            <ConfigParseErrors parseErrors={cfg.parseErrors} />
          ) : (
            <ConfigFormFields
              draft={cfg.draft}
              secrets={cfg.secrets}
              models={cfg.models}
              modelsAvailable={cfg.modelsAvailable}
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
