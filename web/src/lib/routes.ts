export const ROUTES = {
  home: "/",
  promptFiles: "/prompt-files",
  dreams: "/dreams",
  config: "/config",
} as const;

export type AppView = "promptFiles" | "dreams" | "config";

/** The path the read-only status page used to live at, kept so old links resolve. */
const REMOVED_SETTINGS = "/settings";

export function normalizePath(pathname: string): string {
  const path = pathname.replace(/\/+$/, "") || "/";
  return path.startsWith("/") ? path : `/${path}`;
}

export function viewFromPath(pathname: string): AppView {
  switch (normalizePath(pathname)) {
    case ROUTES.dreams:
      return "dreams";
    case ROUTES.config:
      return "config";
    default:
      return "promptFiles";
  }
}

export function pathForView(view: AppView): string {
  if (view === "dreams") return ROUTES.dreams;
  if (view === "config") return ROUTES.config;
  return ROUTES.promptFiles;
}

export function isAppPath(pathname: string): boolean {
  const path = normalizePath(pathname);
  return path === ROUTES.home || path === ROUTES.promptFiles || path === ROUTES.dreams || path === ROUTES.config;
}

/**
 * Canonical app path. `/` and anything unrecognised -- including the
 * `/project-memories` route the transcript view used to live at -- land on the
 * prompt files, which is the page that describes what the agent is being told.
 *
 * `/settings` is the exception, and it goes to the config page rather than to the
 * prompt files. The status page that lived there is gone, but the config page is
 * what a bookmarked "设置" meant by then, and the settings it offers now include
 * the index status those four rows used to be the only place to see. A stale link
 * that lands on an unrelated page reads as a broken site.
 */
export function resolveAppPath(pathname: string): string {
  const path = normalizePath(pathname);
  if (path === ROUTES.home) return ROUTES.promptFiles;
  if (path === REMOVED_SETTINGS) return ROUTES.config;
  if (isAppPath(path)) return path;
  return ROUTES.promptFiles;
}
