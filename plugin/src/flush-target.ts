// The one path a flush is allowed to write, validated and pre-created.
//
// PORTED VERBATIM from openclaw's `ensureMemoryFlushTargetFile`
// (`src/auto-reply/reply/memory-flush-session.ts`, 91 lines).
//
// WHY IT EXISTS SEPARATELY FROM THE WRITER
//   Upstream calls this before the flush turn runs, not at write time, so the
//   append-only write tool never has to create anything: the file exists before
//   the model decides whether there is anything to say. The three checks are the
//   contract -- the path is relative, it resolves inside the workspace root, and
//   it does not escape through `..` -- and they are what makes "append to
//   memory/<day>.md" a property of the code rather than a promise in a prompt.
//
// ONE PARAMETER DROPPED: `assertCurrent`
//   Upstream threads it through the whole write path because their flush runs
//   inside a cancellable embedded agent turn, and every step re-checks the abort
//   signal before touching the disk. mem-plus runs the flush as a fire-and-forget
//   promise off an event hook with no AbortSignal to honour, so the guard would
//   have nothing to assert and would read as protection that does not exist.
//   Dropping it is a contract difference, not a preference.
import fs from "node:fs/promises";
import path from "node:path";

/**
 * Validate the flush target, create `memory/`, and pre-create the file with an
 * append-mode handle. Returns the absolute path that was prepared.
 *
 * Throws rather than clamping: a target outside the workspace is a bug in the
 * caller, and silently writing somewhere else is the one outcome this function
 * exists to prevent.
 */
export async function ensureFlushTargetFile(params: {
  workspaceDir: string;
  relativePath: string;
}): Promise<string> {
  const workspaceDir = params.workspaceDir.trim();
  const relativePath = params.relativePath.trim();
  if (!workspaceDir || !relativePath || path.isAbsolute(relativePath)) {
    throw new Error("Invalid memory flush target path");
  }
  const workspaceRoot = path.resolve(workspaceDir);
  const targetPath = path.resolve(workspaceRoot, relativePath);
  const targetRelativePath = path.relative(workspaceRoot, targetPath);
  if (
    !targetRelativePath ||
    targetRelativePath.startsWith("..") ||
    path.isAbsolute(targetRelativePath)
  ) {
    throw new Error("Memory flush target path must stay inside the workspace");
  }
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  const handle = await fs.open(targetPath, "a");
  try {
    // Upstream re-asserts the abort guard between open and close; see the note
    // above on why there is nothing to assert here.
  } finally {
    await handle.close();
  }
  return targetPath;
}