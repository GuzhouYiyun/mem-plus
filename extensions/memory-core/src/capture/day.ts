// Day-key formatting for memory file names, vendored from openclaw's
// `src/memory-host-sdk/dreaming.ts` (`formatMemoryDreamingDay` / `formatLocalIsoDay`),
// verbatim.
//
// WHY IT LIVES HERE
//   `write.ts` must turn a timestamp into `memory/YYYY-MM-DD.md`. Importing
//   `openclaw/plugin-sdk/memory-core-host-status` for that would drag in the whole
//   openclaw config surface (`workspace-state-identity`, `types.openclaw`, the
//   `@openclaw/normalization-core` coercion helpers) through a tsconfig path alias —
//   an alias that a bundler outside the openclaw workspace does not honour, so the
//   capture pipeline could not be imported by a host at all. The two functions below
//   are self-contained (Intl + Date only), so vendoring them keeps the emitted day
//   byte-identical to openclaw's while leaving `capture/` with no openclaw import.
//
// KEEP IN SYNC with openclaw's `formatMemoryDreamingDay`: the daily file name is the
// join key between this pipeline, the file watcher and `memory_search`'s date filter.

let memoryDreamingDayFormatter: { timezone: string; formatter: Intl.DateTimeFormat } | undefined;

function formatLocalIsoDay(epochMs: number): string {
  const date = new Date(epochMs);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function formatMemoryDreamingDay(epochMs: number, timezone?: string): string {
  if (!timezone) {
    return formatLocalIsoDay(epochMs);
  }
  try {
    // Cache only explicit timezones so host-local fallback follows timezone changes.
    if (memoryDreamingDayFormatter?.timezone !== timezone) {
      memoryDreamingDayFormatter = {
        timezone,
        formatter: new Intl.DateTimeFormat("en-CA", {
          timeZone: timezone,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        }),
      };
    }
    const parts = memoryDreamingDayFormatter.formatter.formatToParts(new Date(epochMs));
    const values = new Map(parts.map((part) => [part.type, part.value]));
    const year = values.get("year");
    const month = values.get("month");
    const day = values.get("day");
    if (year && month && day) {
      return `${year}-${month}-${day}`;
    }
  } catch {
    // Fall back to host-local day for invalid or unsupported timezones.
  }
  return formatLocalIsoDay(epochMs);
}

export function isSameMemoryDreamingDay(
  firstEpochMs: number,
  secondEpochMs: number,
  timezone?: string,
): boolean {
  return (
    formatMemoryDreamingDay(firstEpochMs, timezone) ===
    formatMemoryDreamingDay(secondEpochMs, timezone)
  );
}
