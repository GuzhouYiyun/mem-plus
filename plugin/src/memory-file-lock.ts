// Serialising mem-plus's memory-file appends across processes and sessions.
//
// UPSTREAM, and why this is not a copy of it
//   openclaw serialises memory-file writes two ways: `withMemoryWorkspaceLock`
//   (`extensions/memory-core/src/memory-workspace-lock.ts`, a plugin-state store lease) and
//   `withFileLock` (`src/plugin-sdk/file-lock.ts`, a `.lock` sidecar). Both are vendored in
//   this tree; `short-term-promotion-apply.ts:398` uses them to lock, hash and conflict-check
//   the promotion write before it commits, telling the caller the write was skipped rather
//   than told `true`.
//
//   UPSTREAM ISSUE HISTORY, checked 2026-11-16: `#131604` was the *flush/sandbox-bridge*
//   race (a read-modify-write with no serialisation), not the promotion path -- the
//   promotion lock above pre-existed it. Upstream fixed `#131604` in PR `#188872`
//   ("preserve concurrent sandbox flush notes", merged 2026-10-31) by serialising the
//   sandbox-bridge read-modify-write through `withFileMutationQueueKeyResolution`. An
//   earlier comment here credited `#131604` to the promotion path; that attribution was
//   wrong and is corrected here.
//
//   mem-plus has no sandbox bridge. Its capture and flush writes went through
//   `appendCaptureEntry` with no lock at all (`extensions/memory-core/src/capture/write.ts`),
//   which is the same read-modify-write shape upstream serialised in `#188872`. That is
//   the defect being fixed here: the same serialisation, taken from the same upstream
//   module, applied to mem-plus's own append paths. Result (checked 2026-11-16): the
//   equivalent fix is in place on all four append sites, so `#188872` needs no further
//   port -- this comment is the record.
//
// WHAT IS DELIBERATELY NOT COPIED
//   `withMemoryWorkspaceLock` is not used. It keys off the *memory home*, but the capture
//   write target is `<home>/memory/<project-slug>/<day>.md`, and upstream's own promotion
//   lock is per-file too (`resolveMemoryPromotionLockTarget` hashes the workspace, then
//   `withFileLock` takes that one path). Locking the whole home would serialise three
//   projects' writes for no safety gain, and would make a slow project's flush hold the
//   other two projects' captures. So the lock is per target file, which is the granularity
//   upstream's promotion path uses.
//
// WHY THE LOCK PATH IS A SIDECAR AND NOT THE FILE ITSELF
//   `appendCaptureEntry` appends; a `.lock` sidecar next to the target is what fs-safe's
//   sidecar lock provider creates. The sidecar lives beside the daily file it guards
//   (`<day>.md.lock`), so it is per-project and per-day by construction, and it cannot
//   collide with the promotion lock, which lives under the state dir.
//
// FAIL-CLOSED, BECAUSE A FAILED LOCK IS A FAILED WRITE
//   Upstream's promotion lock is `staleRecovery: "fail-closed"` (`MEMORY_WRITE_LOCK_OPTIONS`,
//   short-term-promotion-apply.ts:64). Same here: if the lock cannot be acquired, the write
//   is refused and the caller sees a failure -- never a silent success that dropped the
//   entry. The marker check inside `appendCaptureEntry` still holds as a second line, but it
//   is no longer the only thing standing between a race and a duplicated append.
import { withFileLock } from "openclaw/plugin-sdk/file-lock";

/**
 * Retry/stale policy for one memory-file lock.
 *
 * The numbers are upstream's own (`MEMORY_WRITE_LOCK_OPTIONS`,
 * `short-term-promotion-apply.ts:64-68`): 100 retries at 25-250ms with a 1.2 factor covers
 * a peer holding the lock for ~6s of wall time, and `stale: 120_000` means a sidecar only
 * becomes reclaimable after two minutes -- long enough that a live writer is never stolen
 * from, short enough that a crashed process does not block memory for the rest of the day.
 */
const MEMORY_FILE_LOCK_OPTIONS = {
  retries: { retries: 100, factor: 1.2, minTimeout: 25, maxTimeout: 250 },
  stale: 120_000,
  staleRecovery: "fail-closed" as const,
};

/**
 * Run `append` while holding the target file's lock.
 *
 * The lock is taken on the *absolute target path*: `withFileLock` derives the sidecar from
 * it (`<path>.lock`), so the lock identity is the file identity and no second path has to
 * stay in step with the write path.
 *
 * Errors propagate. A caller that wants "never throws" wraps this, the same way
 * `runFlush` wraps the append it already does.
 */
export async function withMemoryFileLock<T>(
  absolutePath: string,
  append: () => Promise<T>,
): Promise<T> {
  return await withFileLock(absolutePath, MEMORY_FILE_LOCK_OPTIONS, append);
}
