import { useEffect, useState, type MouseEvent } from "react";
import { Menu } from "lucide-react";
import { AppSidebar } from "$lib/components/explorer/AppSidebar";
import { PromptFilesView } from "$lib/components/explorer/PromptFilesView";
import { DreamsView } from "$lib/components/explorer/DreamsView";
import { ConfigView } from "$lib/components/explorer/ConfigView";
import { ConfigFileView } from "$lib/components/explorer/ConfigFileView";
import { Button } from "$lib/components/ui/button";
import { Toaster } from "$lib/components/ui/sonner";
import { useI18n } from "$lib/i18n";
import { initRouter, navigate, ROUTES, useAppView } from "$lib/router";

// Four tabs: the two surfaces openclaw writes for a person to read (the injected
// prompt files, the dream diary) and two takes on the plugin's own settings --
// 设置 is the form, 配置文件 is the same form beside a live preview of the JSON
// it writes. The transcript view is gone -- openclaw has no browsable session
// record by design, and a page built on the capture snapshots was showing
// something openclaw never meant to expose. The read-only status page went too:
// it was four rows of counters, and the settings page is where a person goes
// looking for what this thing is doing.
export default function App() {
  const { t } = useI18n();
  const currentView = useAppView();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  useEffect(() => {
    // Routing only. There is nothing to poll: every view derives from local state.
    return initRouter();
  }, []);

  const viewTitle =
    currentView === "dreams"
      ? t("tab-dreams")
      : currentView === "config"
        ? t("cfg-title")
        : currentView === "configFile"
          ? t("tab-config-file")
          : t("tab-prompt-files");

  function onHomeClick(event: MouseEvent) {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }
    event.preventDefault();
    navigate(ROUTES.promptFiles);
  }

  return (
    <>
      <Toaster richColors position="bottom-right" />

      {/* `h-svh` + `overflow-hidden`: the window itself never scrolls. Each view
          owns the scrolling inside itself -- the chrome around the text (title,
          tabs, file header, action bar) is `shrink-0` and stays put, and only the
          body scrolls. `overflow-y-auto` on the column is the fallback for a window
          too short to hold the chrome: then the whole column scrolls instead of the
          bottom being cut off. */}
      <div className="flex h-svh overflow-hidden bg-background text-foreground">
        <AppSidebar
          open={sidebarOpen}
          onOpenChange={setSidebarOpen}
          currentView={currentView}
          brand={t("brand")}
          promptFilesLabel={t("tab-prompt-files")}
          dreamsLabel={t("tab-dreams")}
          configLabel={t("cfg-title")}
          configFileLabel={t("tab-config-file")}
          themeLabel={t("nav-theme")}
          closeLabel={t("nav-close")}
        />

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="z-30 flex shrink-0 items-center gap-2 border-b border-border bg-background/95 px-3 py-2 backdrop-blur md:hidden">
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => setSidebarOpen(true)}
              aria-label={t("nav-menu")}
            >
              <Menu className="size-4" />
            </Button>
            <a
              href={ROUTES.promptFiles}
              className="truncate text-sm tracking-wide text-primary"
              onClick={onHomeClick}
            >
              {t("brand")}
            </a>
          </div>

          <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-4 overflow-y-auto overflow-x-hidden p-4 [scrollbar-gutter:stable] md:p-6">
            <div className="flex shrink-0 flex-wrap items-center justify-between gap-2">
              <h1 className="text-base tracking-wide text-primary">{viewTitle}</h1>
            </div>

            <div className="flex min-h-0 flex-1 flex-col">
              {currentView === "dreams" ? (
                <DreamsView />
              ) : currentView === "config" ? (
                <ConfigView />
              ) : currentView === "configFile" ? (
                <ConfigFileView />
              ) : (
                <PromptFilesView />
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
