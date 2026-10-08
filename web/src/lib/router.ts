import { useSyncExternalStore } from "react";
import {
  normalizePath,
  pathForView,
  resolveAppPath,
  ROUTES,
  type AppView,
  viewFromPath,
} from "./routes";

let currentPath = resolveAppPath(
  typeof window !== "undefined" ? window.location.pathname : ROUTES.promptFiles
);
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function setPath(next: string) {
  if (currentPath === next) return;
  currentPath = next;
  emit();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot() {
  return currentPath;
}

function getServerSnapshot() {
  return ROUTES.promptFiles;
}

export function navigate(to: string, replace = false) {
  const next = resolveAppPath(to);
  if (normalizePath(window.location.pathname) === next) {
    setPath(next);
    return;
  }
  if (replace) window.history.replaceState({}, "", next);
  else window.history.pushState({}, "", next);
  setPath(next);
}

export function navigateView(view: AppView, replace = false) {
  navigate(pathForView(view), replace);
}

export function currentView(): AppView {
  return viewFromPath(window.location.pathname);
}

/** Sync store with history; `/` and unknown paths resolve to project memories. */
export function initRouter(): () => void {
  const sync = () => {
    const current = normalizePath(window.location.pathname);
    const resolved = resolveAppPath(current);
    if (current !== resolved) {
      window.history.replaceState({}, "", resolved);
    }
    setPath(resolved);
  };

  sync();
  window.addEventListener("popstate", sync);
  return () => window.removeEventListener("popstate", sync);
}

export function usePath(): string {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

export function useAppView(): AppView {
  return viewFromPath(usePath());
}

export { ROUTES, pathForView, viewFromPath };
export type { AppView };
