import type { MouseEvent } from "react";
import { Cpu, FileCog, FileJson, FileText, Moon, Sparkles, Sun, X } from "lucide-react";
import { GithubIcon } from "$lib/components/icons/GithubIcon";
import { Button } from "$lib/components/ui/button";
import { Separator } from "$lib/components/ui/separator";
import { navigate, ROUTES, type AppView } from "$lib/router";
import { toggleTheme, useTheme } from "$lib/theme";
import { cn } from "$lib/utils";

type Props = {
  open?: boolean;
  currentView: AppView;
  brand: string;
  promptFilesLabel: string;
  configLabel: string;
  configFileLabel: string;
  dreamsLabel: string;
  runtimeLabel: string;
  themeLabel: string;
  closeLabel: string;
  memoryGroupLabel: string;
  configGroupLabel: string;
  systemGroupLabel: string;
  onOpenChange?: (open: boolean) => void;
};

export function AppSidebar({
  open = false,
  currentView,
  brand,
  promptFilesLabel,
  configLabel,
  configFileLabel,
  dreamsLabel,
  runtimeLabel,
  themeLabel,
  closeLabel,
  memoryGroupLabel,
  configGroupLabel,
  systemGroupLabel,
  onOpenChange,
}: Props) {
  const theme = useTheme();
  const isDark = theme === "dark";

  function setOpen(next: boolean) {
    onOpenChange?.(next);
  }

  function onNavClick(event: MouseEvent, to: string) {
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
    navigate(to);
    setOpen(false);
  }

  function navClass(active: boolean) {
    return cn(
      "flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] transition-colors",
      active
        ? "bg-sidebar-accent text-sidebar-accent-foreground shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--sidebar-border)_80%,transparent)]"
        : "text-sidebar-foreground/78 hover:bg-sidebar-accent/65 hover:text-sidebar-accent-foreground"
    );
  }

  function groupLabel(text: string) {
    return (
      <div className="px-3 pb-1 pt-3 text-[11px] font-medium tracking-wide text-sidebar-foreground/45">
        {text}
      </div>
    );
  }

  return (
    <>
      {open ? (
        <button
          type="button"
          className="fixed inset-0 z-40 bg-black/45 backdrop-blur-[1px] md:hidden"
          aria-label={closeLabel}
          onClick={() => setOpen(false)}
        />
      ) : null}

      <aside
        className={cn(
          "inset-y-0 start-0 z-50 flex h-svh w-[15.5rem] shrink-0 flex-col border-e border-sidebar-border bg-sidebar/95 text-sidebar-foreground backdrop-blur transition-transform duration-200",
          "fixed md:sticky md:top-0 md:translate-x-0!",
          open ? "translate-x-0" : "max-md:-translate-x-full max-md:rtl:translate-x-full"
        )}
      >
        <div className="flex items-center gap-2 px-4 py-4">
          <a
            href={ROUTES.home}
            className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg transition-opacity hover:opacity-90"
            onClick={(e) => onNavClick(e, ROUTES.home)}
          >
            <span className="grid size-7 place-items-center rounded-lg border border-sidebar-border bg-sidebar-accent/60 text-sidebar-primary">
              <Sparkles className="size-3.5" />
            </span>
            <span className="truncate text-[13px] font-semibold tracking-wide text-sidebar-foreground">
              {brand}
            </span>
          </a>
          <Button
            variant="ghost"
            size="icon-sm"
            className="md:hidden shrink-0"
            onClick={() => setOpen(false)}
            aria-label={closeLabel}
          >
            <X className="size-4" />
          </Button>
        </div>

        <Separator className="bg-sidebar-border/80" />

        <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto p-2.5" aria-label="Main">
          {groupLabel(memoryGroupLabel)}
          <a
            href={ROUTES.promptFiles}
            className={navClass(currentView === "promptFiles")}
            aria-current={currentView === "promptFiles" ? "page" : undefined}
            onClick={(e) => onNavClick(e, ROUTES.promptFiles)}
          >
            <FileText className="size-4 shrink-0 opacity-80" />
            <span className="truncate text-start">{promptFilesLabel}</span>
          </a>
          <a
            href={ROUTES.dreams}
            className={navClass(currentView === "dreams")}
            aria-current={currentView === "dreams" ? "page" : undefined}
            onClick={(e) => onNavClick(e, ROUTES.dreams)}
          >
            <Moon className="size-4 shrink-0 opacity-80" />
            <span className="truncate text-start">{dreamsLabel}</span>
          </a>

          {groupLabel(configGroupLabel)}
          <a
            href={ROUTES.config}
            className={navClass(currentView === "config")}
            aria-current={currentView === "config" ? "page" : undefined}
            onClick={(e) => onNavClick(e, ROUTES.config)}
          >
            <FileCog className="size-4 shrink-0 opacity-80" />
            <span className="truncate text-start">{configLabel}</span>
          </a>
          <a
            href={ROUTES.configFile}
            className={navClass(currentView === "configFile")}
            aria-current={currentView === "configFile" ? "page" : undefined}
            onClick={(e) => onNavClick(e, ROUTES.configFile)}
          >
            <FileJson className="size-4 shrink-0 opacity-80" />
            <span className="truncate text-start">{configFileLabel}</span>
          </a>

          {groupLabel(systemGroupLabel)}
          {/* Runtime diagnostics: route/view unchanged. */}
          <a
            href={ROUTES.runtime}
            className={navClass(currentView === "runtime")}
            aria-current={currentView === "runtime" ? "page" : undefined}
            onClick={(e) => onNavClick(e, ROUTES.runtime)}
          >
            <Cpu className="size-4 shrink-0 opacity-80" />
            <span className="truncate text-start">{runtimeLabel}</span>
          </a>
        </nav>

        <div className="mt-auto flex items-center justify-end border-t border-sidebar-border/70 p-3">
          <div className="flex items-center rounded-lg border border-sidebar-border/80 bg-background/35">
            <button
              type="button"
              className="inline-flex size-8 items-center justify-center rounded-s-lg text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
              onClick={() => toggleTheme()}
              aria-label={themeLabel}
              title={themeLabel}
            >
              {isDark ? <Moon className="size-4" /> : <Sun className="size-4" />}
            </button>
            <a
              href="https://github.com/GuzhouYiyun/mem-plus"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex size-8 items-center justify-center rounded-e-lg border-s border-sidebar-border text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
              title="GitHub"
              aria-label="GitHub"
            >
              <GithubIcon className="size-4" />
            </a>
          </div>
        </div>
      </aside>
    </>
  );
}
