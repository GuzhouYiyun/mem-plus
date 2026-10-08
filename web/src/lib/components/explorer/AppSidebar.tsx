import type { MouseEvent } from "react";
import { FileCog, FileText, Moon, Sparkles, Sun, X } from "lucide-react";
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
  dreamsLabel: string;
  themeLabel: string;
  closeLabel: string;
  onOpenChange?: (open: boolean) => void;
};

export function AppSidebar({
  open = false,
  currentView,
  brand,
  promptFilesLabel,
  configLabel,
  dreamsLabel,
  themeLabel,
  closeLabel,
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
      "flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-sm transition-colors",
      active
        ? "bg-sidebar-accent text-sidebar-accent-foreground"
        : "text-sidebar-foreground/80 hover:bg-sidebar-accent/70 hover:text-sidebar-accent-foreground"
    );
  }

  return (
    <>
      {open ? (
        <button
          type="button"
          className="fixed inset-0 z-40 bg-black/50 md:hidden"
          aria-label={closeLabel}
          onClick={() => setOpen(false)}
        />
      ) : null}

      <aside
        className={cn(
          "inset-y-0 start-0 z-50 flex h-svh w-64 shrink-0 flex-col border-e border-sidebar-border bg-sidebar text-sidebar-foreground transition-transform duration-200",
          "fixed md:sticky md:top-0 md:translate-x-0!",
          open ? "translate-x-0" : "max-md:-translate-x-full max-md:rtl:translate-x-full"
        )}
      >
        <div className="flex items-center gap-2 px-4 py-4">
          <a
            href={ROUTES.home}
            className="flex min-w-0 flex-1 items-center gap-2 rounded-lg transition-colors hover:opacity-90"
            onClick={(e) => onNavClick(e, ROUTES.home)}
          >
            <span className="truncate text-sm font-medium tracking-wide text-sidebar-primary">
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

        <Separator className="bg-sidebar-border" />

        <nav className="flex flex-1 flex-col gap-1 p-3" aria-label="Main">
          <a
            href={ROUTES.promptFiles}
            className={navClass(currentView === "promptFiles")}
            aria-current={currentView === "promptFiles" ? "page" : undefined}
            onClick={(e) => onNavClick(e, ROUTES.promptFiles)}
          >
            <FileText className="size-4 shrink-0" />
            <span className="truncate text-start">{promptFilesLabel}</span>
          </a>
          <a
            href={ROUTES.dreams}
            className={navClass(currentView === "dreams")}
            aria-current={currentView === "dreams" ? "page" : undefined}
            onClick={(e) => onNavClick(e, ROUTES.dreams)}
          >
            <Sparkles className="size-4 shrink-0" />
            <span className="truncate text-start">{dreamsLabel}</span>
          </a>
          <a
            href={ROUTES.config}
            className={navClass(currentView === "config")}
            aria-current={currentView === "config" ? "page" : undefined}
            onClick={(e) => onNavClick(e, ROUTES.config)}
          >
            <FileCog className="size-4 shrink-0" />
            <span className="truncate text-start">{configLabel}</span>
          </a>
        </nav>

        {/* Bottom row: just the theme/GitHub pair, on the right. */}
        <div className="mt-auto flex items-center justify-end p-3">
          <div className="flex items-center rounded-lg border border-sidebar-border/80 bg-card/70">

            <button
              type="button"
              className="inline-flex size-8 items-center justify-center rounded-s-lg text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
              onClick={() => toggleTheme()}
              aria-label={themeLabel}
              title={themeLabel}
            >
              {isDark ? (
                <Moon className="size-4 rounded-md p-0.5" />
              ) : (
                <Sun className="size-4 rounded-md p-0.5" />
              )}
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
