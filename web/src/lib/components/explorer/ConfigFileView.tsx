import { FileJson, RefreshCw } from "lucide-react";
import {
  ConfigActions,
  ConfigAlerts,
  ConfigFileNotice,
  ConfigFormFields,
  ConfigJsonPreview,
  ConfigParseErrors,
  useConfigFile,
} from "$lib/components/explorer/ConfigForm";
import { Button } from "$lib/components/ui/button";
import { formatDate } from "$lib/format";
import { useI18n } from "$lib/i18n";

// 配置文件: the settings file taking shape as the form is filled in.
//
// WHY A SECOND SETTINGS PAGE
//   设置 answers "what does this option do" -- labels, help, defaults. This one
//   answers "what is actually in my file": the JSON the save will PUT, rendered
//   from the same draft, so it cannot drift from what gets written. That is the
//   question the JSONC file itself answers and the form only implies, and it is
//   the arrangement openclaw's own config editor uses -- the file on one side,
//   the form on the other.
//
// READ-ONLY ON THE LEFT, BY DESIGN
//   Editing the text would mean a second write path: parsing free text into a
//   draft, merging it with the file, and keeping the two panes in agreement when
//   only one of them was touched. The server edits one key at a time precisely
//   so comments and unknown keys survive; typing into a text box that pretends
//   to be the file would put that at risk for a box nobody needs. If the text
//   view is not enough, the file is an ordinary file -- any editor can have it.
//
// The preview is above the form only on a narrow screen: with two columns the
// reading order is preview-then-form, and stacked the same order would push the
// form below a long block of JSON.
export function ConfigFileView() {
  const { t } = useI18n();
  const cfg = useConfigFile();

  // Same rule as 设置: a file with a syntax error is a document we do not fully
  // understand, and writing over it would be a guess.
  const blocked = !cfg.exists || cfg.parseErrors.length > 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <ConfigAlerts error={cfg.error} saved={cfg.saved} />

      <div className="flex shrink-0 flex-wrap items-center gap-2 rounded-xl border border-border bg-card px-4 py-2.5">
        <FileJson className="size-4 shrink-0 text-muted-foreground" />
        <span className="truncate text-sm text-muted-foreground">{cfg.config?.path ?? "-"}</span>
        {cfg.exists ? (
          <span className="text-xs text-muted-foreground/70">
            {t("cfg-file-meta", {
              bytes: String(cfg.config?.bytes ?? 0),
              when: cfg.config?.modifiedAt ? formatDate(cfg.config.modifiedAt) : "-",
            })}
          </span>
        ) : null}
        <Button variant="outline" size="icon" className="ms-auto" onClick={cfg.load} aria-label={t("btn-refresh")}>
          <RefreshCw className={`size-4 ${cfg.loading ? "animate-spin" : ""}`} />
        </Button>
      </div>

      {!cfg.exists ? (
        <div className="rounded-xl border border-border bg-card p-4">
          <ConfigFileNotice config={cfg.config} saving={cfg.saving} onCreate={() => void cfg.save(true)} />
        </div>
      ) : cfg.parseErrors.length > 0 ? (
        <div className="rounded-xl border border-border bg-card p-4">
          <ConfigParseErrors parseErrors={cfg.parseErrors} />
        </div>
      ) : (
        <>
          <div className="grid min-h-0 flex-1 gap-4 md:grid-cols-2">
            <ConfigJsonPreview draft={cfg.draft} className="order-2 max-h-[40vh] md:order-1 md:max-h-none" />
            <section className="order-1 flex min-h-0 flex-col rounded-xl border border-border bg-card md:order-2">
              <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-4 py-3 [scrollbar-gutter:stable]">
                <ConfigFormFields
                  draft={cfg.draft}
                  secrets={cfg.secrets}
                  models={cfg.models}
                  modelsAvailable={cfg.modelsAvailable}
                  disabled={blocked}
                  onChange={cfg.setField}
                />
              </div>
            </section>
          </div>

          <div className="shrink-0 rounded-xl border border-border bg-card">
            <ConfigActions
              saving={cfg.saving}
              dirty={cfg.dirty}
              disabled={blocked}
              onSave={() => void cfg.save()}
              onDiscard={cfg.discard}
            />
          </div>
        </>
      )}
    </div>
  );
}
