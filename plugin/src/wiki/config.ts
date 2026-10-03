// The document corpus: which directory holds it and whether it is searched.
//
// WHY A SEPARATE CORPUS
//   openclaw reaches a document vault through its own `memory-wiki` plugin, whose
//   compile step writes into openclaw's memory store. mem-plus does not use that
//   store -- it has its own index (`documents`/`units`/`units_fts`/`vectors`) --
//   so the corpus here is the same idea on mem-plus's own storage: a directory
//   of markdown pages, indexed under `root = "wiki"`, retrievable through the
//   same three tools with `corpus: "wiki" | "all"`.
//
//   Nothing in this module writes. The pages are ordinary files the user can
//   read, edit or delete with any editor, which is what makes `memory_reindex`
//   a complete repair mechanism for the corpus as well.
import { wikiDir } from "../paths.js";

export type WikiConfig = {
  /**
   * `wiki.enabled: false` keeps the corpus out of the index entirely. The
   * directory may still hold pages; they are simply not searchable. Same shape
   * as openclaw's `memory.search.provider: "none"` (fts-only), and the same
   * reason: turning a corpus off should not require deleting its files.
   */
  readonly enabled: boolean;
  readonly dir: string;
};

/** Permissive read: `ctx.options` is untyped JSON supplied by opencode.json(c). */
export function readWikiConfig(options: unknown): WikiConfig {
  const root =
    typeof options === "object" && options !== null ? (options as Record<string, unknown>) : {};
  const nested =
    typeof root["wiki"] === "object" && root["wiki"] !== null
      ? (root["wiki"] as Record<string, unknown>)
      : {};
  const dir = typeof nested["dir"] === "string" && nested["dir"].trim().length > 0
    ? nested["dir"].trim()
    : wikiDir();
  return { enabled: nested["enabled"] !== false, dir };
}