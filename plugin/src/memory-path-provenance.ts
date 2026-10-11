// Deciding where a memory file came from, from its path plus its recorded provenance.
//
// PORTED from openclaw `extensions/memory-core/src/memory/memory-path-provenance.ts`
// (82 lines). The rules are upstream's, in upstream's order:
//
//   not a memory source                      -> untrusted
//   outside the workspace (realpath compare) -> untrusted
//   DREAMS.md / memory/dreaming / memory/.dreams -> system
//   recorded provenance for the file         -> that record's class
//   workspace memory markdown                -> agent
//   anything else                            -> untrusted
//
// The default for workspace memory markdown is deliberately `agent` and not `owner`: a
// human hand-editing a memory file gets no record, and failing closed on the whole
// workspace would make curated memory permanently ineligible for automatic recall.
//
// ONE ADAPTATION: the project prefix
//   mem-plus nests each project's diary under `<memory home>/<project-slug>/memory/`, so
//   "the path is inside the memory subtree" has to tolerate one leading segment. Same
//   reason as in `memory-artifact-provenance.ts`, and the same single helper.
import fs from "node:fs/promises";
import path from "node:path";
import { isPathStrictlyInside } from "../../src/infra/path-guards.js";
import type { MemoryEntryProvenance, MemorySource } from "../../packages/memory-host-sdk/src/host/types.js";
import { readMemoryArtifactProvenance } from "./memory-artifact-provenance.js";

type MemoryPathClassification = {
  curatedRoot: boolean;
  originClass: MemoryEntryProvenance["originClass"];
};

/** `memory/<file>.md`, with or without a project-home prefix. Upstream allows neither. */
function isMemorySubtree(relativePath: string, segments: readonly string[]): boolean {
  if (!relativePath.endsWith(".md")) return false;
  if (segments[0] === "memory") return segments.length > 1;
  return segments.length > 2 && segments[1] === "memory";
}

export async function resolveMemoryPathClassification(params: {
  absolutePath: string;
  source: MemorySource;
  workspaceDir: string;
  readSource?: { canonicalRelativePath?: string };
}): Promise<MemoryPathClassification> {
  if (params.source !== "memory") {
    return { curatedRoot: false, originClass: "untrusted" };
  }
  let relativePath: string;
  if (params.readSource !== undefined) {
    const sourcePath = params.readSource.canonicalRelativePath;
    if (
      !sourcePath ||
      sourcePath === "." ||
      sourcePath === ".." ||
      sourcePath.startsWith("../") ||
      path.posix.isAbsolute(sourcePath) ||
      path.win32.isAbsolute(sourcePath) ||
      sourcePath.includes("\\") ||
      sourcePath.includes("\0") ||
      path.posix.normalize(sourcePath) !== sourcePath
    ) {
      return { curatedRoot: false, originClass: "untrusted" };
    }
    relativePath = sourcePath;
  } else {
    let workspacePath: string;
    let filePath: string;
    try {
      [workspacePath, filePath] = await Promise.all([
        fs.realpath(params.workspaceDir),
        fs.realpath(params.absolutePath),
      ]);
    } catch {
      return { curatedRoot: false, originClass: "untrusted" };
    }
    if (!isPathStrictlyInside(workspacePath, filePath)) {
      return { curatedRoot: false, originClass: "untrusted" };
    }
    relativePath = path.relative(workspacePath, filePath).replaceAll(path.sep, "/");
  }
  const segments = relativePath.split("/");
  const curatedRoot =
    segments.length === 1 &&
    (segments[0] === "MEMORY.md" || segments[0] === "memory.md" || segments[0] === "USER.md");
  if (
    (segments.length === 1 && (segments[0] === "DREAMS.md" || segments[0] === "dreams.md")) ||
    relativePath.includes("memory/dreaming/") ||
    relativePath.includes("memory/.dreams/")
  ) {
    return { curatedRoot, originClass: "system" };
  }
  const isWorkspaceMemory =
    curatedRoot ||
    /^users\/[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}\/USER\.md$/.test(relativePath) ||
    isMemorySubtree(relativePath, segments);
  const recorded = isWorkspaceMemory
    ? await readMemoryArtifactProvenance({
        workspaceDir: params.workspaceDir,
        relativePath,
      })
    : undefined;
  if (recorded) {
    return { curatedRoot, originClass: recorded.originClass };
  }
  // Workspace memory Markdown is owner-controlled. Flush-recorded provenance
  // still downgrades machine-written untrusted material during ingestion; the
  // index default must not fail closed the entire workspace.
  return { curatedRoot, originClass: isWorkspaceMemory ? "agent" : "untrusted" };
}
