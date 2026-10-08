import { createContext, createElement, useContext, useMemo, type ReactNode } from "react";
import { translations, type Lang, type TranslationKey } from "./translations";

// Single-locale build: the upstream table had en/zh/ar plus a cycling toggle in
// the sidebar and a `opencode-mem-lang` localStorage key. mem-plus is
// Chinese-only, so there is nothing to switch -- no store, no subscribers, no
// persisted preference. `getLanguage()` stays because the date formatter reads
// the locale from it.
const LANG: Lang = "zh";

export type TranslateFn = (key: TranslationKey | string, params?: Record<string, string | number>) => string;

export function getLanguage(): Lang {
  return LANG;
}

export function t(
  key: TranslationKey | string,
  params: Record<string, string | number> = {}
): string {
  let text = (translations[LANG] as Record<string, string>)[key] || key;

  for (const [k, v] of Object.entries(params)) {
    text = text.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
  }
  return text;
}

type I18nContextValue = {
  language: Lang;
  t: TranslateFn;
};

const I18nContext = createContext<I18nContextValue | null>(null);

const VALUE: I18nContextValue = { language: LANG, t };

export function I18nProvider({ children }: { children: ReactNode }) {
  // No dependency array contents to track: the value is constant.
  const value = useMemo<I18nContextValue>(() => VALUE, []);
  return createElement(I18nContext.Provider, { value }, children);
}

export function useI18n(): I18nContextValue {
  // Components rendered outside the provider (tests, isolated widgets) still get
  // working translations.
  return useContext(I18nContext) ?? VALUE;
}

if (typeof document !== "undefined") {
  document.documentElement.lang = LANG;
}