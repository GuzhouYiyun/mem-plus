// Language routing for auto-capture, ported from opencode-mem/src/services/language-detector.ts.
// opencode-mem backs this with franc-min + iso-639-3. mem-plus keeps the same contract —
// an ISO 639-1 code in, an English display name out — but stays dependency-free: the
// extraction prompt only needs to know which language to write the summary in, and a
// script/family heuristic answers that without shipping trigram tables.
//
// Install a stronger detector when one is available:
//   configureCaptureLanguageDetector((text) => iso6393To1[franc(text, { minLength: 5 })] ?? "en");

export type CaptureLanguageDetector = (text: string) => string;

/** ISO 639-1 codes the extraction prompt knows how to name. */
const LANGUAGE_NAMES: Record<string, string> = {
  en: "English",
  zh: "Chinese",
  ja: "Japanese",
  ko: "Korean",
  ru: "Russian",
  de: "German",
  fr: "French",
  es: "Spanish",
  pt: "Portuguese",
  it: "Italian",
  nl: "Dutch",
  pl: "Polish",
  tr: "Turkish",
  vi: "Vietnamese",
  th: "Thai",
  ar: "Arabic",
  he: "Hebrew",
  hi: "Hindi",
  id: "Indonesian",
  uk: "Ukrainian",
};

let configuredCaptureDetector: CaptureLanguageDetector | undefined;

export function configureCaptureLanguageDetector(detector?: CaptureLanguageDetector): void {
  configuredCaptureDetector = detector;
}

/**
 * Detect the dominant language of `text` as an ISO 639-1 code.
 * Returns "en" for empty input and for anything the heuristic cannot classify.
 */
export function detectCaptureLanguage(text: string): string {
  if (configuredCaptureDetector) {
    return configuredCaptureDetector(text);
  }
  if (!text || text.trim().length === 0) {
    return "en";
  }

  const counts = new Map<string, number>();
  for (const char of text) {
    const code = char.codePointAt(0)!;
    let script: string | undefined;
    if (code >= 0x4e00 && code <= 0x9fff) {
      script = "zh";
    } else if (code >= 0x3040 && code <= 0x30ff) {
      script = "ja";
    } else if (code >= 0xac00 && code <= 0xd7af) {
      script = "ko";
    } else if (code >= 0x0400 && code <= 0x04ff) {
      script = "ru";
    } else if (code >= 0x0600 && code <= 0x06ff) {
      script = "ar";
    } else if (code >= 0x0590 && code <= 0x05ff) {
      script = "he";
    } else if (code >= 0x0900 && code <= 0x097f) {
      script = "hi";
    } else if (code >= 0x0e00 && code <= 0x0e7f) {
      script = "th";
    } else if (code >= 0x1100 && code <= 0x11ff) {
      script = "ko";
    }
    if (script) {
      counts.set(script, (counts.get(script) ?? 0) + 1);
    }
  }

  let best: string | undefined;
  let bestCount = 0;
  for (const [script, count] of counts) {
    if (count > bestCount) {
      best = script;
      bestCount = count;
    }
  }
  // A handful of stray CJK characters must not reclassify an English prompt.
  if (!best || bestCount < 8) {
    return "en";
  }
  return best;
}

/** English display name for an ISO 639-1 code; falls back to the caller's assumption. */
export function getCaptureLanguageName(code: string): string {
  return LANGUAGE_NAMES[code] ?? LANGUAGE_NAMES[code.slice(0, 2)] ?? "English";
}
