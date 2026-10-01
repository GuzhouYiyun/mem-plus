// Persisting a capture into openclaw's storage.
//
// The index is file-derived: `memory/YYYY-MM-DD.md` is picked up by the memory file
// watcher, chunked into `memory_index_chunks`, indexed into FTS5 and vec0, and given
// its provenance/originClass by `resolveMemoryPathClassification`. Reimplementing
// that write here would fight the watcher, and synthetic rows with no backing file
// are removed by `deleteStaleRows` on the next sync — so the pipeline appends to the
// real daily file and lets openclaw own the embedding and the index.
import fs from "node:fs/promises";
import path from "node:path";
import { appendRegularFile } from "@openclaw/fs-safe/advanced";
import { formatMemoryDreamingDay } from "./day.js";
import { captureEntryMarker } from "./render.js";

export type CaptureWriteTarget = {
  day: string;
  relativePath: string;
  absolutePath: string;
};

export function resolveCaptureWriteTarget(params: {
  workspaceDir: string;
  nowMs: number;
  timezone?: string;
}): CaptureWriteTarget {
  const day = formatMemoryDreamingDay(params.nowMs, params.timezone);
  const relativePath = `memory/${day}.md`;
  return {
    day,
    relativePath,
    absolutePath: path.join(params.workspaceDir, "memory", `${day}.md`),
  };
}

export async function readCaptureTargetText(absolutePath: string): Promise<string> {
  return await fs.readFile(absolutePath, "utf-8").catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return "";
    }
    throw error;
  });
}

/**
 * Append `rendered` to the daily memory file. Returns false when the entry marker is
 * already present, so a retry between "written" and "marked captured" cannot duplicate.
 */
export async function appendCaptureEntry(params: {
  absolutePath: string;
  rendered: string;
  entryKey: string;
}): Promise<boolean> {
  const existing = await readCaptureTargetText(params.absolutePath);
  if (existing.includes(captureEntryMarker(params.entryKey))) {
    return false;
  }
  await fs.mkdir(path.dirname(params.absolutePath), { recursive: true });
  const separator = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  await appendRegularFile({
    filePath: params.absolutePath,
    content: `${separator}${params.rendered}`,
    rejectSymlinkParents: true,
  });
  return true;
}
