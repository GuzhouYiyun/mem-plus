// The page's data layer: same-origin calls to the plugin's web server.
//
// Same origin because the plugin serves the bundle (127.0.0.1:4747 by default),
// so there is no CORS and no host list. Two things still ride along:
//
//   - The CSRF token. The server injects `window.__MEM_PLUS_TOKEN__` into
//     `index.html` and wants it back on every `/api/*` call. A page on another
//     origin cannot read it out of that document, which is the whole point: it
//     cannot make the user's browser replay the request. Sent empty when the
//     script tag is absent (`vite dev`, where there is no server to inject one),
//     and the API answers 401, which surfaces as a normal error message.
//
//   - `credentials: "same-origin"`, so the browser's cached Basic Auth answer
//     (when `web.authPassword` is set) is sent without turning the request into
//     a cross-origin one.
import type { ApiResult } from "./types";

declare global {
  interface Window {
    __MEM_PLUS_TOKEN__?: string;
  }
}

/** Header name the server checks. Kept in sync with plugin/src/web/auth-token.ts. */
export const AUTH_HEADER = "x-mem-plus-token";

export function authToken(): string {
  return typeof window === "undefined" ? "" : (window.__MEM_PLUS_TOKEN__ ?? "");
}

export async function fetchAPI<T = unknown>(
  endpoint: string,
  options: RequestInit & { timeout?: number } = {}
): Promise<ApiResult<T>> {
  const { timeout, headers, ...rest } = options;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout ?? 30_000);
  try {
    const response = await fetch(endpoint, {
      ...rest,
      credentials: "same-origin",
      headers: { ...(headers as Record<string, string> | undefined), [AUTH_HEADER]: authToken() },
      signal: controller.signal,
    });
    // A 401 body is JSON like any other failure, but the message would be a bare
    // "Unauthorized" -- say what to do about it instead.
    if (response.status === 401) {
      return { success: false, error: "无权访问：页面令牌缺失或不对，请刷新页面重试" };
    }
    return (await response.json()) as ApiResult<T>;
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timeoutId);
  }
}
