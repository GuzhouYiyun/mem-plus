// Finding memory files and keeping the index in step with them.
//
// WHY SCAN RATHER THAN TRACK
//   Every event that writes memory would have to remember to notify the index,
//   and any one of them forgetting leaves a file invisible to search with no
//   error anywhere -- the worst failure mode for a search tool. Scanning the one
//   known root is a few hundred `readdir` calls on a tree that grows by a file
//   a day, and it is correct regardless of who wrote what. Change detection
//   is by size and mtime, so the common case is a stat rather than a read.
//
// SCOPE IS THE MEMORY HOME
//   Every project's captures and snapshots live under one home
//   (`<state>/workspace`), so the home tree is the whole searchable corpus and
//   one index covers every project on the machine. Project identity comes from
//   the directory the file sits under, so a cross-project question ("what did I
//   do about the postgres migration?") is a single query.
import { readdir, readFile, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { homeProjectSlug, memoryFile, MEMORY_DIR_NAME, memoryHomeDir } from "./paths.js";
import { indexDocument, indexAppendedTail, pruneMissing, type IndexRoot } from "./memory-index.js";

/** Guard against a pathological tree; a memory directory is never this large. */
const MAX_FILES = 20_000;

export type DiscoveredFile = {
  readonly file: string;
  readonly root: IndexRoot;
  readonly project: string;
  readonly bytes: number;
  readonly mtime: number;
};

async function walk(dir: string, out: string[], depth = 0): Promise<void> {
  if (out.length >= MAX_FILES || depth > 8) return;
  // Spelled as `Dirent[]` rather than inferred from `readdir`: its overloads
  // resolve to `Dirent<Buffer>` without an explicit annotation, and the generic
  // parameter then leaks Buffer into `entry.name`.
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    // A missing directory is the normal state for a project with no memory yet.
    return;
  }
  for (const entry of entries) {
    if (out.length >= MAX_FILES) return;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // node_modules inside a project would otherwise pull in every README on
      // the machine; a memory directory never contains one.
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      await walk(full, out, depth + 1);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      out.push(full);
    }
  }
}

/**
 * Every markdown file in the memory home: `MEMORY.md` at the root plus the
 * whole `memory/<project>/` tree. DREAMS.md is deliberately excluded -- it is
 * a human review surface, not a search corpus.
 */
export async function discoverHomeFiles(): Promise<DiscoveredFile[]> {
  const home = memoryHomeDir();
  const files: string[] = [];
  await walk(path.join(home, MEMORY_DIR_NAME), files);
  const longTerm = memoryFile("");
  try {
    await stat(longTerm);
    files.push(longTerm);
  } catch {
    // Promoted long-term memory only exists once something has been promoted.
  }

  const found: DiscoveredFile[] = [];
  for (const file of files) {
    try {
      const info = await stat(file);
      found.push({
        file,
        root: "home",
        // The slug rather than the raw path: it is already a stable, readable,
        // filesystem-safe identity, and a search result is more useful naming a
        // project than naming `C:\Users\...\repos\thing`. Home-root files carry
        // the empty identity, which search treats as "everywhere".
        project: homeProjectSlug(file),
        bytes: info.size,
        mtime: Math.trunc(info.mtimeMs),
      });
    } catch {
      // Raced with a delete.
    }
  }
  return found;
}

export type ReindexReport = {
  readonly scanned: number;
  readonly indexed: number;
  readonly skipped: number;
  readonly pruned: number;
  readonly units: number;
  /**
   * Files skipped because an indexed document already holds their exact bytes.
   * With one tree a non-zero count means a byte-identical duplicate file exists
   * on disk; the earlier-indexed one carries the units and the later one is
   * recorded so pruning knows about it.
   */
  readonly mirrored: number;
};

/**
 * Documents whose size and mtime match what was indexed last time.
 *
 * A NULL `content` means the row predates the mirror-hash migration, so it is
 * reported as changed even when size and mtime agree. That costs one extra read
 * per legacy document, once, and it is what lets a single `memory_reindex`
 * repair an index that already holds duplicates.
 */
function unchangedDocuments(db: DatabaseSync, root: IndexRoot): Map<string, { bytes: number; mtime: number }> {
  const rows = db
    .prepare("SELECT path, bytes, mtime, content FROM documents WHERE root = ?")
    .all(root) as { path: string; bytes: number; mtime: number; content: string | null }[];
  return new Map(
    rows
      .filter((row) => row.content !== null)
      .map((row) => [row.path, { bytes: row.bytes, mtime: row.mtime }]),
  );
}

/**
 * Bring the index in line with what is on disk.
 *
 * Reads each changed file once, parses it, and writes the result in a single
 * transaction per file so a crash mid-reindex cannot leave half a document
 * indexed.
 */
export async function reindexFiles(params: {
  db: DatabaseSync;
  files: readonly DiscoveredFile[];
  root: IndexRoot;
}): Promise<ReindexReport> {
  const known = unchangedDocuments(params.db, params.root);
  const seen = new Set<string>();
  let indexed = 0;
  let skipped = 0;
  let units = 0;
  let mirrored = 0;

  for (const entry of params.files) {
    seen.add(entry.file);
    const previous = known.get(entry.file);
    if (previous && previous.bytes === entry.bytes && previous.mtime === entry.mtime) {
      skipped += 1;
      continue;
    }
    try {
      const text = await readFile(entry.file, "utf-8");
      const result = indexDocument({
        db: params.db,
        file: entry.file,
        root: entry.root,
        project: entry.project,
        text,
        bytes: entry.bytes,
        mtime: entry.mtime,
      });
      units += result.written;
      if (result.mirrored) mirrored += 1;
      indexed += 1;
    } catch {
      // Unreadable file: leave whatever was indexed before alone.
    }
  }

  const pruned = pruneMissing({ db: params.db, root: params.root, present: seen });
  return {
    scanned: params.files.length,
    indexed,
    skipped,
    pruned: pruned.length,
    units,
    mirrored,
  };
}

/**
 * Index the new tail of a file the plugin just appended to.
 *
 * The daily entry file is append-only, so a capture that adds one block does not
 * need the file's other fifty blocks re-read. Units already present are skipped
 * by provenance marker, which is the same idempotency the write path uses.
 */
export async function indexTail(params: {
  db: DatabaseSync;
  file: string;
  root: IndexRoot;
  project: string;
}): Promise<number> {
  try {
    const info = await stat(params.file);
    const text = await readFile(params.file, "utf-8");
    return indexAppendedTail({
      db: params.db,
      file: params.file,
      root: params.root,
      project: params.project,
      text,
      bytes: info.size,
      mtime: Math.trunc(info.mtimeMs),
    });
  } catch {
    return 0;
  }
}

/**
 * Index one file that was just rewritten in full.
 *
 * Snapshots replace their whole file every turn, so the tail path would leave
 * stale units from the previous turn behind. This re-reads and re-parses, which
 * is what a replaced file requires.
 *
 * Failures are logged and swallowed: the index is derived data, so a failed
 * update is recoverable with `memory_reindex` and must never fail the turn that
 * triggered it.
 */
export async function indexWrittenFile(params: {
  db: DatabaseSync;
  file: string;
  root: IndexRoot;
  project: string;
  log: (message: string, detail?: unknown) => void;
}): Promise<number> {
  try {
    const info = await stat(params.file);
    const text = await readFile(params.file, "utf-8");
    return indexDocument({
      db: params.db,
      file: params.file,
      root: params.root,
      project: params.project,
      text,
      bytes: info.size,
      mtime: Math.trunc(info.mtimeMs),
    }).written;
  } catch (error) {
    params.log(`index update skipped for ${params.file}`, error);
    return 0;
  }
}