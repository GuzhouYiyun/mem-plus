// Finding memory files and keeping the index in step with them.
//
// WHY SCAN RATHER THAN TRACK
//   Every event that writes memory would have to remember to notify the index,
//   and any one of them forgetting leaves a file invisible to search with no
//   error anywhere -- the worst failure mode for a search tool. Scanning the two
//   known roots is a few hundred `readdir` calls on a tree that grows by a file
//   per day, and it is correct regardless of who wrote what. Change detection
//   is by size and mtime, so the common case is a stat rather than a read.
//
// SCOPE IS THE PROJECT TREE PLUS THE ARCHIVE
//   Both are indexed into one database, which is what makes a cross-project
//   question ("what did I do about the postgres migration?") a single query. The
//   archive copy and the project copy of the same session are separate documents
//   on purpose: they live at different paths and the project copy is the one the
//   user edits, so if either is deleted the other still serves the search.
import { readdir, readFile, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { archiveRoot, MEMORY_DIR_NAME, MEMORY_FILE_NAME, projectSlug } from "./paths.js";
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

/** Every markdown file under the workspace's memory directory, plus `MEMORY.md`. */
export async function discoverProjectFiles(workspaceDir: string): Promise<DiscoveredFile[]> {
  const files: string[] = [];
  const memoryDir = path.join(workspaceDir, MEMORY_DIR_NAME);
  await walk(memoryDir, files);
  const longTerm = path.join(workspaceDir, MEMORY_FILE_NAME);
  try {
    await stat(longTerm);
    files.push(longTerm);
  } catch {
    // Promoted long-term memory only exists once something has been promoted.
  }

  const slug = projectSlug(workspaceDir);
  const found: DiscoveredFile[] = [];
  for (const file of files) {
    try {
      const info = await stat(file);
      found.push({
        file,
        root: "project",
        // The slug rather than the raw path: it is already a stable, readable,
        // filesystem-safe identity, and a search result is more useful naming a
        // project than naming `C:\Users\...\repos\thing`.
        project: slug,
        bytes: info.size,
        mtime: Math.trunc(info.mtimeMs),
      });
    } catch {
      // Raced with a delete.
    }
  }
  return found;
}

/** Every project mirrored under the global archive. */
export async function discoverArchiveFiles(): Promise<DiscoveredFile[]> {
  const root = archiveRoot();
  let projects: Dirent[];
  try {
    projects = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: DiscoveredFile[] = [];
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const files: string[] = [];
    await walk(path.join(root, project.name), files);
    const indexFile = path.join(root, project.name, "INDEX.md");
    try {
      await stat(indexFile);
      files.push(indexFile);
    } catch {
      // Not every archived project has an index yet.
    }
    for (const file of files) {
      try {
        const info = await stat(file);
        found.push({
          file,
          root: "archive",
          project: project.name,
          bytes: info.size,
          mtime: Math.trunc(info.mtimeMs),
        });
      } catch {
        /* raced */
      }
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
   * Non-zero is normal and correct: every capture writes the project copy and
   * the archive mirror, and only one of them should be searchable.
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

/** The project slug a workspace maps to; also the identity carried in the index. */
export { projectSlug };