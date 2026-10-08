// Shapes the UI renders.
//
// These mirror what the plugin's web API returns (see `plugin/src/web/api.ts`):
// the injected files and the dream diary. Types, not schemas: nothing here
// validates a response, so a field the plugin does not send is simply absent.
//
// The transcript shapes (`MemoryItem` / `MemoryHalf` / `MemoryPage` / `TagInfo`)
// were deleted with the session-history page -- there is no API returning them
// any more, so keeping them would only invite someone to render the capture
// snapshots openclaw never means to expose. `MemoryStats` went with the status
// page, for the same reason. (`/api/stats` itself is still served; nothing in the
// page asks for it, and dropping an endpoint from the plugin's HTTP surface is a
// separate decision from dropping the tab that read it.)

/** Envelope every `/api/*` response uses. */
export type ApiResult<T = unknown> = {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
};

/** One prompt-injected file, as `/api/prompt-files` reports it. */
export type PromptFile = {
  name: string;
  path: string;
  exists: boolean;
  bytes?: number;
  content?: string;
  truncated?: boolean;
  modifiedAt?: string;
  /** sha256 of `content`; sent back on save as the concurrency base. */
  sha256?: string;
};