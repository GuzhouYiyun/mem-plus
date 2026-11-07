import { useEffect, useState, type MouseEvent } from "react";
import { Menu } from "lucide-react";
import { AppSidebar } from "$lib/components/explorer/AppSidebar";
import { PromptFilesView } from "$lib/components/explorer/PromptFilesView";
import { DreamsView } from "$lib/components/explorer/DreamsView";
import { ConfigView } from "$lib/components/explorer/ConfigView";
import { ConfigFileView } from "$lib/components/explorer/ConfigFileView";
import { RuntimeView } from "$lib/components/explorer/RuntimeView";
import { Button } from "$lib/components/ui/button";
import { Toaster } from "$lib/components/ui/sonner";
import { useI18n } from "$lib/i18n";
import { initRouter, navigate, ROUTES, useAppView } from "$lib/router";

// Five tabs: the two surfaces openclaw writes for a person to read (the injected
// prompt files, the dream diary), two takes on the plugin's own settings --
// 设置 is the form, 配置文件 is the same form beside a live preview of the JSON
// it writes -- and 运行时, the diagnostics page for the llama.cpp runtime and
// the inference service (status rows plus download / restart / repair actions).
// The transcript view is gone -- openclaw has no browsable session
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
          : currentView === "runtime"
            ? t("tab-runtime")
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
          runtimeLabel={t("tab-runtime")}
          themeLabel={t("nav-theme")}
          closeLabel={t("nav-close")}
          memoryGroupLabel={t("nav-group-memory")}
          configGroupLabel={t("nav-group-config")}
          systemGroupLabel={t("nav-group-system")}
        />

        <div className="flex min-w-0 flex-1 flex-col bg-[radial-gradient(1200px_400px_at_20%_-10%,color-mix(in_oklab,var(--primary)_8%,transparent),transparent_60%)]">
          <div className="z-30 flex shrink-0 items-center gap-2 border-b border-border/80 bg-background/90 px-3 py-2 backdrop-blur md:hidden">
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
              className="truncate text-[13px] font-medium text-foreground"
              onClick={onHomeClick}
            >
              {t("brand")}
            </a>
          </div>

          <div className="mx-auto flex w-full max-w-[76rem] flex-1 flex-col gap-5 overflow-y-auto overflow-x-hidden px-4 py-5 [scrollbar-gutter:stable] md:px-8 md:py-7">
            <header className="flex shrink-0 items-end justify-between gap-3 border-b border-border/60 pb-3">
              <div className="min-w-0">
                <h1 className="truncate text-[1.05rem] font-semibold tracking-tight text-foreground">{viewTitle}</h1>
              </div>
            </header>

            <div className="flex min-h-0 flex-1 flex-col">
              {currentView === "dreams" ? (
                <DreamsView />
              ) : currentView === "config" ? (
                <ConfigView />
              ) : currentView === "configFile" ? (
                <ConfigFileView />
              ) : currentView === "runtime" ? (
                <RuntimeView />
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
