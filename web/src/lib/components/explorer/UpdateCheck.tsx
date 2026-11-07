import { Download, ExternalLink, RefreshCw, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { fetchAPI } from "$lib/api";
import { Alert, AlertDescription } from "$lib/components/ui/alert";
import { Badge } from "$lib/components/ui/badge";
import { Button } from "$lib/components/ui/button";
import { useI18n } from "$lib/i18n";

export type UpdateCheckData = {
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  releaseUrl: string;
};

/**
 * One check, one result, one action. The banner sits above the settings form
 * because that is where a person opens this page to see what the plugin is
 * doing, and an update is something they act on from there -- not from a
 * toast that vanishes, and not from a separate page.
 *
 * Nothing here downloads or installs. The installer is the only artifact a
 * user can run, so the loop closes on the Releases URL.
 */
export function UpdateCheck() {
  const { t } = useI18n();
  const [data, setData] = useState<UpdateCheckData | null>(null);
  const [checking, setChecking] = useState(true);

  async function check() {
    setChecking(true);
    const result = await fetchAPI<UpdateCheckData>("/api/update-check");
    setChecking(false);
    if (result.success && result.data) {
      setData(result.data);
    } else {
      // Leave data null: the render handles it as a visible failure line,
      // not as a vanishing banner.
    }
  }

  useEffect(() => {
    void check();
  }, []);

  if (checking) {
    return (
      <Alert className="shrink-0">
        <RefreshCw className="size-4 animate-spin" />
        <AlertDescription>{t("update-checking")}</AlertDescription>
      </Alert>
    );
  }

  if (!data) {
    return (
      <Alert variant="destructive" className="shrink-0">
        <TriangleAlert />
        <AlertDescription>
          <span>{t("update-check-failed")}</span>
          <Button
            size="sm"
            variant="ghost"
            className="ms-2"
            onClick={check}
            disabled={checking}
          >
            <RefreshCw className={`size-4 ${checking ? "animate-spin" : ""}`} />
            {t("btn-refresh")}
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  if (data.updateAvailable) {
    return (
      <Alert className="shrink-0 border-[oklch(0.72_0.15_150)]/40 bg-[oklch(0.72_0.15_150)]/10">
        <TriangleAlert />
        <AlertDescription className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span>{t("update-available", { current: data.current, latest: data.latest ?? "?" })}</span>
          <Button asChild size="sm" variant="outline">
            <a href={data.releaseUrl} target="_blank" rel="noopener noreferrer">
              <Download className="size-4" />
              {t("update-download")}
              <ExternalLink className="size-3.5" />
            </a>
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 text-sm text-muted-foreground">
      <Badge variant="secondary" className="font-mono tabular-nums">{data.current || "?"}</Badge>
      <span>{t("update-current")}</span>
      <Button size="sm" variant="ghost" onClick={check} disabled={checking}>
        <RefreshCw className={`size-4 ${checking ? "animate-spin" : ""}`} />
        {t("btn-refresh")}
      </Button>
    </div>
  );
}