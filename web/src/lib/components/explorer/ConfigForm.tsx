import { useCallback, useEffect, useMemo, useState } from "react";
import { Info, RefreshCw, ShieldCheck, TriangleAlert } from "lucide-react";
import { fetchAPI } from "$lib/api";
import { CONFIG_SECTIONS, isAction, isHeading, readPath, writePath, type ConfigField } from "$lib/config-schema";
import { ReindexRow } from "$lib/components/explorer/ReindexRow";
import { Alert, AlertDescription } from "$lib/components/ui/alert";
import { Badge } from "$lib/components/ui/badge";
import { Button } from "$lib/components/ui/button";
import { Input } from "$lib/components/ui/input";
import { Picker } from "$lib/components/ui/picker";
import { useI18n } from "$lib/i18n";
import { cn } from "$lib/utils";

// The plugin's settings: how they are read, how they are written, and the two
// shapes that write path is rendered in.
//
// WHERE THIS WRITES
//   `~/.config/opencode/mem-plus/config.jsonc` -- a file mem-plus owns, created on
//   first run with a commented template. It used to be the `options` object of
//   mem-plus's entry in OpenCode's `opencode.jsonc`, but that channel only exists
//   when the plugin is registered in `plugins[]` -- so anyone using directory
//   auto-discovery could not set anything at all, and registering a second copy to
//   gain settings meant two copies loaded. Owning the file removes the constraint.
//   This is the arrangement opencode-mem uses.
//
// WHAT IT WILL NOT DO
//   - Touch anything else in the file. The server edits one key at a time, so
//     comments and keys this form does not know survive a save.
//   - Send or receive the password. `web.authPassword` reads as "已设置" and saves
//     as an explicit clear.
//   - Register the plugin, or have an opinion about how it is loaded. That is a
//     separate concern with its own rule.
//   - Take effect immediately: the plugin resolves its settings when it loads, so
//     a save needs `opencode service restart`. The page says so after every save.
//
// TWO PAGES, ONE WRITE PATH
//   设置 renders the form alone. 配置文件 renders the same form beside a live
//   preview of the JSON it is about to PUT. The state, the save call and the field
//   controls therefore live here rather than in either page: the alternative is
//   two copies of a write path, and the day they disagree is the day one page
//   saves something the other would not.

/** One entry of `GET /api/models`: a model OpenCode can reach, already formatted. */
export type ModelOption = {
  value: string;
  label: string;
  providerID: string;
  modelID: string;
  enabled: boolean;
  status: string;
  context?: number;
};

export type ConfigResponse = {
  path: string;
  exists: boolean;
  sha256: string;
  bytes: number;
  modifiedAt?: string;
  options: Record<string, unknown> | null;
  secrets: Record<string, boolean>;
  parseErrors: { offset: number; length: number; message: string }[];
  error?: string;
};

/**
 * Everything a page needs to read and save the settings file.
 *
 * Two views mounted at once would each hold their own draft and clobber each
 * other's saves -- which is one more reason the settings exist on two pages that
 * are never open at the same time (one route), not two widgets on one screen.
 */
export function useConfigFile() {
  const { t } = useI18n();
  const [config, setConfig] = useState<ConfigResponse | null>(null);
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [models, setModels] = useState<ModelOption[] | null>(null);
  const [modelsAvailable, setModelsAvailable] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const result = await fetchAPI<ConfigResponse>("/api/config");
    setLoading(false);
    if (!result.success || !result.data) {
      setError(result.error ?? t("toast-update-failed"));
      return;
    }
    setConfig(result.data);
    setDraft(result.data.options ?? {});
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  // The model list is for the picker, so it is fetched once per mount rather than
  // per refresh: it changes when the user edits providers, and the picker is not
  // worth re-fetching every time the config file is re-read.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await fetchAPI<{ models?: ModelOption[]; available?: boolean }>("/api/models");
      if (cancelled) return;
      if (result.success && result.data) {
        setModels(result.data.models ?? []);
        setModelsAvailable(result.data.available !== false);
      } else {
        // The endpoint is missing or refused: fall back to typing the id, which is
        // worse but not broken.
        setModels(null);
        setModelsAvailable(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const exists = config?.exists === true;
  const parseErrors = config?.parseErrors ?? [];
  const secrets = config?.secrets ?? {};
  const dirty = useMemo(
    () => JSON.stringify(sortKeys(draft)) !== JSON.stringify(sortKeys(config?.options ?? {})),
    [draft, config]
  );

  function setField(key: string, value: unknown) {
    setDraft((previous) => writePath(previous, key, value));
    setSaved(null);
  }

  async function save(create = false) {
    if (!config) return;
    setSaving(true);
    setError(null);
    setSaved(null);
    const result = await fetchAPI<{ sha256: string; unchanged: boolean }>("/api/config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ options: draft, sha256: config.sha256, create }),
    });
    setSaving(false);
    if (!result.success) {
      setError(result.error ?? t("toast-update-failed"));
      return;
    }
    await load();
    setSaved(create ? t("cfg-created") : result.data?.unchanged ? t("cfg-saved-unchanged") : t("cfg-saved-restart"));
  }

  function discard() {
    setDraft(config?.options ?? {});
    setSaved(null);
  }

  return {
    config,
    draft,
    loading,
    saving,
    error,
    saved,
    models,
    modelsAvailable,
    exists,
    parseErrors,
    secrets,
    dirty,
    setField,
    save,
    discard,
    load,
  };
}

export type ConfigFileState = ReturnType<typeof useConfigFile>;

/** The two banners: a failure, and the confirmation that follows a save. */
export function ConfigAlerts({ error, saved }: { error: string | null; saved: string | null }) {
  return (
    <>
      {error ? (
        <Alert variant="destructive" className="mb-3 shrink-0">
          <TriangleAlert />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {saved ? (
        <Alert className="mb-3 shrink-0 border-[oklch(0.72_0.15_150)]/40 bg-[oklch(0.72_0.15_150)]/10">
          <Info className="text-[oklch(0.55_0.15_150)]" />
          <AlertDescription>{saved}</AlertDescription>
        </Alert>
      ) : null}
    </>
  );
}

/**
 * The file is not there. Same shape as a dead end with a way out: say what is
 * missing, say what creating it does, and put the button in the card rather than
 * in a sentence. The server reports the real reason if the path is not writable
 * -- a read-only install cannot be fixed from a page, and pretending otherwise
 * would just hide it.
 */
export function ConfigFileNotice({
  config,
  saving,
  onCreate,
}: {
  config: ConfigResponse | null;
  saving: boolean;
  onCreate: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="my-3 space-y-2 rounded-lg border border-dashed border-border p-3">
      <p className="text-sm">{t("cfg-file-absent")}</p>
      <p className="text-sm text-muted-foreground">{t("cfg-file-absent-hint")}</p>
      {config?.error ? (
        <p className="text-xs text-muted-foreground">{t("cfg-file-absent-reason", { reason: config.error })}</p>
      ) : null}
      <Button size="sm" disabled={saving} onClick={onCreate}>
        {saving ? t("btn-refresh") : t("cfg-create-file")}
      </Button>
    </div>
  );
}

/** Nothing can be edited until the file parses: writing over a syntax error is a guess. */
export function ConfigParseErrors({
  parseErrors,
}: {
  parseErrors: ConfigResponse["parseErrors"];
}) {
  const { t } = useI18n();
  return (
    <div className="space-y-2 py-3">
      <p className="text-sm text-destructive">{t("cfg-parse-errors", { count: parseErrors.length })}</p>
      <ul className="space-y-1">
        {parseErrors.slice(0, 8).map((problem, i) => (
          <li key={i} className="text-sm text-muted-foreground">
            {t("cfg-parse-error-at", { offset: String(problem.offset), what: problem.message })}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The form: every field the schema knows, in the order the schema gives, under
 * the headings that group it.
 *
 * There is no section header and no collapse. Each namespace's fields sit under
 * one 抽取/文件/运行/服务/网页/文档语料 heading, which is what actually carries
 * the grouping -- a header above the whole list bought a click and bought
 * nothing. A collapsible would also teach the reader that sections here are
 * optional, which is the opposite of true.
 */
export function ConfigFormFields({
  draft,
  secrets,
  models,
  modelsAvailable,
  disabled,
  onChange,
}: {
  draft: Record<string, unknown>;
  secrets: Record<string, boolean>;
  models: ModelOption[] | null;
  modelsAvailable: boolean;
  disabled: boolean;
  onChange: (key: string, value: unknown) => void;
}) {
  return (
    <div className="space-y-3 pb-2">
      {CONFIG_SECTIONS.flatMap((section) =>
        section.fields.map((item) =>
          isHeading(item) ? (
            // A divider, not a setting. `text-sm` rather than smaller: the
            // file header above is `text-base`, and a heading two steps
            // below that is all the weight it needs without going quiet.
            // Spacing is asymmetric on purpose -- more room above than
            // below, so the group it introduces reads as belonging to what
            // follows.
            <h4
              key={`${section.id}:h:${item.heading}`}
              className="pt-2 pb-0.5 text-sm font-medium text-muted-foreground"
            >
              {item.heading}
            </h4>
          ) : isAction(item) ? (
            <ReindexRow
              key={`${section.id}:${item.action}`}
              embedEnabled={readPath(draft, "model.embed") !== false}
            />
          ) : (
            <FieldRow
              key={`${section.id}:${item.key}`}
              field={item}
              value={readPath(draft, item.key)}
              secretSet={secrets[item.key] === true}
              models={models}
              modelsAvailable={modelsAvailable}
              disabled={disabled}
              onChange={(next) => onChange(item.key, next)}
              onReset={() => onChange(item.key, item.defaultValue)}
            />
          )
        )
      )}
    </div>
  );
}

/**
 * The action bar. It sits outside the scrolling body on purpose: save and
 * discard are the two things you want when you have scrolled to the bottom of a
 * form to change something, and a bar that scrolls away with the content makes
 * you scroll back to reach it.
 */
export function ConfigActions({
  saving,
  dirty,
  disabled,
  onSave,
  onDiscard,
}: {
  saving: boolean;
  dirty: boolean;
  disabled: boolean;
  onSave: () => void;
  onDiscard: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-border p-3">
      <Button size="sm" disabled={saving || !dirty || disabled} onClick={onSave}>
        {saving ? t("btn-refresh") : t("btn-save")}
      </Button>
      {dirty ? (
        <Button size="sm" variant="ghost" onClick={onDiscard}>
          {t("btn-discard")}
        </Button>
      ) : null}
      <span className="ms-auto text-sm text-muted-foreground">
        <ShieldCheck className="me-1 inline size-3 align-[-0.15em]" />
        {t("cfg-restart-note")}
      </span>
    </div>
  );
}

/**
 * The draft as it will be sent -- read-only, refreshed on every keystroke.
 *
 * This is the literal body of the save: `JSON.stringify(draft, null, 2)` is what
 * `PUT /api/config` receives as `options`, so the preview cannot drift from what
 * a save writes. What it cannot show is the file itself: the password never
 * crosses the wire, so a set `web.authPassword` is absent here rather than
 * starred, and a comment in the file is invisible to a form that does not carry
 * comments. Both are stated under the pane instead of implied by a blank.
 */
export function ConfigJsonPreview({ draft, className }: { draft: Record<string, unknown>; className?: string }) {
  const { t } = useI18n();
  const text = JSON.stringify(draft, null, 2);
  return (
    <section className={cn("flex min-h-0 flex-col rounded-xl border border-border bg-card", className)}>
      <div className="shrink-0 space-y-1 p-4 pb-2">
        <h4 className="text-sm font-medium text-muted-foreground">{t("cfg-preview-label")}</h4>
        <p className="text-sm leading-relaxed text-muted-foreground">{t("cfg-preview-hint")}</p>
        <p className="text-xs leading-relaxed text-muted-foreground/80">{t("cfg-preview-secret")}</p>
      </div>
      <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-all px-4 pb-4 font-mono text-xs leading-relaxed text-muted-foreground [scrollbar-gutter:stable]">
        {text}
      </pre>
    </section>
  );
}

/**
 * One setting: label, help, control, and whether it is still on its default.
 *
 * A field whose key is absent from the file is running on the plugin's default,
 * and that is shown rather than hidden: "4747" in the box does not tell you
 * whether you chose it or it was always true.
 */
function FieldRow({
  field,
  value,
  secretSet,
  models,
  modelsAvailable,
  disabled,
  onChange,
  onReset,
}: {
  field: ConfigField;
  value: unknown;
  secretSet: boolean;
  models: ModelOption[] | null;
  modelsAvailable: boolean;
  disabled: boolean;
  onChange: (next: unknown) => void;
  onReset: () => void;
}) {
  const { t } = useI18n();
  // "Is this the default?" is a comparison, not "is the key absent". Since a reset
  // writes the default value explicitly -- the server never deletes keys, because
  // it cannot know which ones the form manages -- absence is no longer the signal.
  const effective = value === undefined ? field.defaultValue : value;
  const isDefault = effective === field.defaultValue;

  return (
    <div className="grid gap-1.5 sm:grid-cols-[minmax(0,15rem)_minmax(0,1fr)] sm:items-start sm:gap-4">
      {/* Label and badge on one line, key underneath. Run inline they collided:
          `model.allowHostedFallback` is longer than the label column, so the key
          wrapped mid-identifier and the row read as noise. */}
      <div className="min-w-0 space-y-0.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <label className="text-sm font-medium" htmlFor={`cfg-${field.key}`}>
            {field.label}
          </label>
          {isDefault ? (
            <Badge variant="outline" className="text-xs text-muted-foreground">
              {t("cfg-default")}
            </Badge>
          ) : null}
        </div>
        <code className="block truncate text-xs text-muted-foreground/70">{field.key}</code>
      </div>

      <div className="min-w-0 space-y-1.5">
        <div className="flex items-center gap-2">
          <Control
            id={`cfg-${field.key}`}
            field={field}
            value={effective}
            secretSet={secretSet}
            models={models}
            modelsAvailable={modelsAvailable}
            disabled={disabled}
            onChange={onChange}
          />
          {!isDefault ? (
            <Button
              size="icon-xs"
              variant="ghost"
              onClick={onReset}
              disabled={disabled}
              aria-label={t("btn-reset-default")}
              title={t("btn-reset-default")}
            >
              <RefreshCw className="size-3" />
            </Button>
          ) : null}
        </div>
        {field.help ? <p className="text-sm leading-relaxed text-muted-foreground">{field.help}</p> : null}
      </div>
    </div>
  );
}

function Control({
  id,
  field,
  value,
  secretSet,
  models,
  modelsAvailable,
  disabled,
  onChange,
}: {
  id: string;
  field: ConfigField;
  value: unknown;
  secretSet: boolean;
  models: ModelOption[] | null;
  modelsAvailable: boolean;
  disabled: boolean;
  onChange: (next: unknown) => void;
}) {
  const { t } = useI18n();

  if (field.kind === "modelRef") {
    const current = typeof value === "string" ? value : "";
    // Only offer the picker once the list actually arrived and is non-empty; an
    // empty dropdown on a host that cannot list models is worse than a text box,
    // because it looks like there are no models.
    if (models && models.length > 0) {
      return (
        <Picker
          id={id}
          disabled={disabled}
          value={current}
          onChange={onChange}
          searchable
          // No max-width. A model reference is two names long -- `qwen3.5-4b-q4_k_m`
          // and `xiaomi/qwen3.5-4b-q4_k_m` -- and the list is where you read them,
          // so the popup (which is as wide as this control) has to be as wide as
          // the column allows. This one used to be capped at 42rem, which was a
          // *ceiling* dressed up as a size: it sat there looking deliberate while
          // throwing away the rest of the row.
          className="w-full"
          placeholder={t("cfg-model-search")}
          emptyResult={t("cfg-model-none")}
          emptyLabel={t("cfg-model-follow-default")}
          options={models.map((model) => ({
            value: model.value,
            label: model.enabled
              ? model.label
              : `${t("cfg-model-disabled")} ${model.providerID}/${model.modelID}`,
            hint: `${model.providerID}/${model.modelID}`,
            disabled: !model.enabled,
            group: model.providerID,
          }))}
        />
      );
    }
    return (
      <div className="w-full space-y-1">
        <Input
          id={id}
          disabled={disabled}
          placeholder="providerID/modelID"
          value={current}
          onChange={(event) => onChange(event.target.value)}
        />
        {modelsAvailable === false ? (
          <p className="text-sm text-muted-foreground">{t("cfg-model-no-list")}</p>
        ) : models && models.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("cfg-model-empty")}</p>
        ) : null}
      </div>
    );
  }

  if (field.kind === "boolean") {
    const on = value === true;
    return (
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={on}
        disabled={disabled}
        onClick={() => onChange(!on)}
        className={cn(
          "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors disabled:opacity-50",
          on ? "border-primary bg-primary" : "border-border bg-muted"
        )}
      >
        <span
          className={cn(
            "absolute size-3.5 rounded-full bg-background shadow transition-[left]",
            on ? "left-[1.15rem]" : "left-0.5"
          )}
        />
      </button>
    );
  }

  if (field.kind === "enum") {
    const current = typeof value === "string" ? value : String(field.defaultValue);
    return (
      <Picker
        id={id}
        disabled={disabled}
        value={current}
        onChange={onChange}
        className="sm:max-w-56"
        options={(field.choices ?? []).map((choice) => ({
          // The identifier is the primary text; the Chinese rides along muted.
          value: choice,
          label: choice,
          sublabel: field.choiceLabels?.[choice],
        }))}
      />
    );
  }

  if (field.kind === "secret") {
    return (
      <div className="flex w-full items-center gap-2 sm:max-w-md">
        <Input
          id={id}
          type="password"
          disabled={disabled}
          placeholder={secretSet ? t("cfg-secret-set") : t("cfg-secret-unset")}
          value={typeof value === "string" ? value : ""}
          onChange={(event) => onChange(event.target.value)}
          autoComplete="new-password"
        />
        {secretSet ? (
          <Button
            size="xs"
            variant="ghost"
            disabled={disabled}
            onClick={() => onChange("")}
          >
            {t("btn-clear-secret")}
          </Button>
        ) : null}
      </div>
    );
  }

  if (field.kind === "number") {
    // A numeric field may have one non-numeric value -- `gpuLayers` is `auto` by
    // default -- and it is declared by a string `defaultValue`, so there is no
    // flag to keep in step. The sentinel renders as an empty box showing `auto` as
    // its placeholder, which is what an absent key looks like anyway. Handing the
    // string straight to a `type="number"` would also leave the DOM blank, since a
    // browser treats a non-numeric value as invalid -- but relying on that makes
    // the display an accident of the browser instead of a decision.
    const sentinel = typeof field.defaultValue === "string" ? field.defaultValue : undefined;
    const text = value === undefined || value === "" || value === sentinel ? "" : String(value);
    return (
      <Input
        id={id}
        type="number"
        inputMode="numeric"
        disabled={disabled}
        className="sm:max-w-40"
        min={field.min}
        max={field.max}
        value={text}
        placeholder={String(field.defaultValue)}
        onChange={(event) => {
          const raw = event.target.value;
          if (raw === "") return onChange(field.allowZero ? 0 : undefined);
          const parsed = Number(raw);
          if (!Number.isFinite(parsed)) return;
          const clamped = Math.min(
            field.max ?? Infinity,
            Math.max(field.min ?? -Infinity, Math.trunc(parsed))
          );
          onChange(clamped);
        }}
      />
    );
  }

  return (
    <Input
      id={id}
      disabled={disabled}
      // Wide, because every text field left is a file path, and a truncated path
      // cannot be read back off the screen. (There used to be a per-field width
      // hint for the short-token ones; `model.gpuLayers` was the only one, and it
      // stopped being a text box once it became a number box.)
      className="sm:max-w-md"
      placeholder={String(field.defaultValue)}
      value={typeof value === "string" ? value : ""}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

/** Stable key order, so `dirty` compares content rather than property order. */
function sortKeys(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) out[key] = value;
  return out;
}
