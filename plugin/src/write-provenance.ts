// Recording provenance around mem-plus's own memory writes.
//
// UPSTREAM: `recordMemoryArtifactWriteProvenance` is called by openclaw's wrapped write
// tool with the bytes before and after the mutation. mem-plus has no wrapped tool (see
// the host-surface notes in AGENTS.md), but it owns every memory write, so the same record
// is taken here instead — at the writer, which is where upstream takes it too.
//
// WHY IT READS THE FILE TWICE
//   The recorded `fileHash` is compared against the file's bytes on the next index pass to
//   decide whether the writer still owns the file. Deriving `contentAfter` by recomputing
//   the separator would be a second implementation of `appendCaptureEntry`'s logic, and the
//   day it drifts, every future append on that file is misclassified. Reading it back makes
//   the record correct by construction.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { recordMemoryArtifactWriteProvenance, type MemoryArtifactOriginClass } from "./memory-artifact-provenance.js";

async function readIfPresent(file: string): Promise<string> {
  return await readFile(file, "utf-8").catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  });
}

/** Run `append`, then record who wrote the result. A failed append records nothing. */
export async function withWriteProvenance(params: {
  /** The memory home: provenance is keyed relative to it, as upstream keys off the workspace. */
  memoryHome: string;
  absolutePath: string;
  append: () => Promise<void>;
  originClass?: MemoryArtifactOriginClass;
  observedAt?: number;
  sessionId?: string;
}): Promise<void> {
  const contentBefore = await readIfPresent(params.absolutePath);
  await params.append();
  const relativePath = path
    .relative(params.memoryHome, params.absolutePath)
    .replaceAll(path.sep, "/");
  await recordMemoryArtifactWriteProvenance({
    workspaceDir: params.memoryHome,
    relativePath,
    contentBefore,
    contentAfter: await readIfPresent(params.absolutePath),
    originClass: params.originClass ?? "agent",
    observedAt: params.observedAt ?? Date.now(),
    ...(params.sessionId ? { sessionId: params.sessionId } : {}),
  });
}
