// The memory browser page, served by the plugin.
//
// WHY A SERVER IN THE PLUGIN
//   The explorer is a Vite app: TypeScript/TSX in, a static bundle out. Nothing
//   about it needs a backend, but it does need *an* origin to be served from --
//   the bundle references its assets as `/assets/...`, so opening
//   `web/dist/index.html` off the filesystem does not work. This module is that
//   origin: a loopback HTTP server that hands out the built files and answers
//   the handful of `/api/*` routes the page needs. Same shape as opencode-mem's
//   `web-server.ts`, minus its CORS layer (nothing here is cross-origin: the
//   bundle is served from the same socket that answers the API).
//
// PORT
//   4747 by default, matching opencode-mem, and shifting upward when taken --
//   several OpenCode windows each load this plugin. A port held by a *responsive*
//   mem-plus instance is reused instead of duplicated: the page is identical
//   either way, so one server is enough and the log says where it is.
//
// NOT THE INFERENCE SERVICE
//   That one is a separate Node process (`serve/server.mjs`) because
//   node-llama-cpp cannot load inside OpenCode's runtime. This one has no native
//   dependency, so it runs in-process.
//
// ACCESS CONTROL (ported from opencode-mem)
//   Two independent layers, both in this file's request path:
//   - `WebAuth` -- HTTP Basic Auth, on only when `web.authPassword` is set. It is
//     what stands between the memory index and a LAN.
//   - `getOrCreateAuthToken` -- a per-install secret required on every `/api/*`
//     call and injected into `index.html`. A password cannot do this job: the
//     browser caches Basic credentials for the session, so any page on the
//     internet can make the user's browser issue an authenticated write. The
//     token is readable only from inside the bundle.
//   `/api/health` stays open to both: it is the port-ownership probe.
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger } from "../log.js";
import {
  handleDreams,
  handleMemoryApi,
  handleMemoryStats,
  handleModelList,
  handlePluginConfig,
  handlePromptFiles,
  saveSettings,
  reindexMemory,
  savePromptFile,
  type MemoryApiDeps,
} from "./api.js";
import { WebAuth } from "./auth.js";
import { AUTH_HEADER, getOrCreateAuthToken, isAuthorizedApiRequest } from "./auth-token.js";
import { describeAuth, readWebConfig, type WebConfig } from "./config.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));

/** Built bundle locations, first existing wins. Matches opencode-mem's lookup. */
export function webDistDirs(): string[] {
  return [
    // plugin/src/web/ -> package root: the shipped layout (web/dist).
    join(HERE, "..", "..", "..", "web", "dist"),
    // plugin/src/web/ -> repo root when running from a checkout.
    join(HERE, "..", "..", "..", "..", "web", "dist"),
  ];
}

export function resolveWebDir(configured?: string): string | null {
  const candidates = configured ? [configured] : webDistDirs();
  for (const dir of candidates) {
    const abs = normalize(dir);
    if (existsSync(join(abs, "index.html"))) return abs;
  }
  return null;
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
};

type RunningServer = {
  readonly url: string;
  stop(): void;
};

type BunGlobal = {
  serve(options: unknown): { port: number; stop(closeActiveConnections?: boolean): void };
};

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";

function serveWithBun(options: {
  port: number;
  host: string;
  handler: (request: Request) => Response | Promise<Response>;
}): RunningServer {
  const handle = (
    globalThis as unknown as { Bun: BunGlobal }
  ).Bun.serve({
    port: options.port,
    hostname: options.host,
    fetch: options.handler,
  });
  return { url: `http://${options.host}:${handle.port}`, stop: () => handle.stop(true) };
}

async function serveWithNode(options: {
  port: number;
  host: string;
  handler: (request: Request) => Response | Promise<Response>;
}): Promise<RunningServer> {
  const { createServer } = await import("node:http");
  const { Readable } = await import("node:stream");
  let boundPort = options.port;

  const server = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = Buffer.concat(chunks);
      const request = new Request(`http://${req.headers.host ?? `${options.host}:${options.port}`}${req.url ?? "/"}`, {
        method: req.method ?? "GET",
        headers: req.headers as Record<string, string>,
        ...(body.length > 0 ? { body } : {}),
      });
      const response = await options.handler(request);
      res.statusCode = response.status;
      response.headers.forEach((value, name) => res.setHeader(name, value));
      if (response.body) {
        Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]).pipe(res);
      } else {
        res.end();
      }
    })().catch((error) => {
      if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      res.end(String(error instanceof Error ? error.message : error));
    });
  });

  await new Promise<void>((resolve, reject) => {
    // `exclusive: false` drops SO_EXCLUSIVEADDRUSE on Windows so a port held by
    // a crashed predecessor's orphaned socket can still be rebound.
    server.listen({ port: options.port, host: options.host, reuseAddr: true, exclusive: false }, () =>
      resolve(),
    );
    server.once("error", reject);
  });
  const address = server.address();
  if (address && typeof address === "object") boundPort = address.port;

  return {
    url: `http://${options.host}:${boundPort}`,
    stop: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

function notFound(): Response {
  return new Response("Not Found", { status: 404 });
}

function contentTypeFor(path: string): string {
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}

function serveStatic(webDir: string, pathname: string, token: string): Response {
  const relative = pathname.replace(/^\/+/, "");
  // SPA fallback: a route without a file extension is a client-side path.
  const wanted = relative && !relative.includes("..") ? relative : "index.html";
  const filePath = normalize(join(webDir, wanted));
  // Traversal guard: never serve anything outside the bundle directory.
  if (filePath !== webDir && !filePath.startsWith(`${webDir}${sep}`)) return notFound();
  if (!existsSync(filePath)) {
    if (extname(relative)) return notFound();
    return serveStatic(webDir, "/index.html", token);
  }
  // A directory inside the bundle (`/assets/`, and `/` itself) passes the
  // existence check above and then blows up in `readFileSync` as EISDIR, which
  // surfaces as a 500 with a stack trace instead of a 404. Not a file, no route.
  if (!statSync(filePath).isFile()) return notFound();
  const contentType = contentTypeFor(filePath);
  const cacheControl =
    relative.startsWith("assets/") || contentType.startsWith("font/")
      ? "public, max-age=31536000, immutable"
      : "no-cache";
  const isText = contentType.startsWith("text/") || contentType.includes("javascript") || contentType.includes("json");
  // The document is the one file that carries the CSRF token. `no-cache` above
  // means the browser revalidates it every load, so a rotated token (or a
  // rebuilt bundle) takes effect on the next open.
  const inject = token.length > 0 && basename(filePath) === "index.html";
  const body = isText || inject
    ? inject
      ? injectToken(readFileSync(filePath, "utf-8"), token)
      : readFileSync(filePath, "utf-8")
    : readFileSync(filePath);
  return new Response(body, {
    headers: {
      "content-type": contentType,
      "cache-control": cacheControl,
      "x-content-type-options": "nosniff",
    },
  });
}

/**
 * Put the API token on `window` before the bundle runs.
 *
 * Inlined rather than fetched: a fetch could be beaten by a race, and a separate
 * endpoint would leak the token to any cross-origin reader that could reach it.
 * The script sits ahead of the app's own entry so `fetchAPI` sees it on the first
 * call. `JSON.stringify` escapes a token that somehow contained a quote.
 */
function injectToken(html: string, token: string): string {
  if (!token) return html;
  const script = `<script>window.__MEM_PLUS_TOKEN__=${JSON.stringify(token)};</script>`;
  const at = html.indexOf("</head>");
  if (at < 0) return script + html;
  return html.slice(0, at) + script + html.slice(at);
}

/** True when something already serving our health envelope holds this port. */
async function ownedByMemPlus(url: string): Promise<boolean> {
  try {
    const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1_500) });
    if (!response.ok) return false;
    // Every route is enveloped, health included, so the service name is under
    // `data`. `status` is checked too because a foreign server could answer 200
    // with a `service` field of its own.
    const body = (await response.json()) as {
      success?: boolean;
      data?: { status?: string; service?: string };
    };
    return (
      body.success === true &&
      (body.data?.service === "mem-plus" || body.data?.status === "ok")
    );
  } catch {
    return false;
  }
}

export type WebUiHandle = {
  /** Where the page is, or null when it could not be served. */
  readonly url: string | null;
  readonly dir: string | null;
  stop(): void;
};

/**
 * Start the page server. Never throws: a UI that fails to bind must not take the
 * plugin down with it, so every failure becomes a log line and a null URL.
 */
export async function startWebServer(
  config: WebConfig,
  api: MemoryApiDeps,
  log: (message: string, detail?: unknown) => void = createLogger("[mem-plus:web]"),
): Promise<WebUiHandle> {
  const inert: WebUiHandle = { url: null, dir: null, stop: () => {} };
  if (!config.enabled) return inert;

  const webDir = resolveWebDir(config.dir);
  if (!webDir) {
    log("page not built -- run `npm --prefix web install && npm --prefix web run build`");
    log(`looked in: ${webDistDirs().join(", ")}`);
    return inert;
  }

  // Minted once per process: every HTML response injects the same value, and the
  // file behind it is what a second OpenCode window reads when it probes.
  const token = getOrCreateAuthToken();
  const auth = new WebAuth({ password: config.authPassword, username: config.authUser });
  const warning = describeAuth(config);
  if (warning) log(`WARNING ${warning}`);

  const handler = async (request: Request): Promise<Response> => {
    const { pathname } = new URL(request.url);
    // Layer 1: HTTP Basic Auth, when a password is configured. Deliberately
    // ahead of everything, static files included -- a page that renders an
    // unauthorized shell is worse than a 401 in the browser's login dialog.
    const authCheck = auth.check(request, pathname);
    if (!authCheck.ok && authCheck.response) return authCheck.response;
    // Data routes first: they own `/api/*`, including `/api/health`, which
    // doubles as the ownership probe this module relies on.
    if (pathname === "/api" || pathname.startsWith("/api/")) {
      // Layer 2: the CSRF token, on the API only. Static files need it inlined
      // but do not require it -- they carry nothing a caller can forge, and the
      // Basic Auth layer already guards them when it is on. `/api/health` is
      // exempt so a second window can probe the port.
      if (pathname !== "/api/health" && !isAuthorizedApiRequest(request)) {
        return new Response(
          JSON.stringify({ success: false, error: `Unauthorized: send the ${AUTH_HEADER} header` }),
          {
            status: 401,
            headers: {
              "content-type": "application/json; charset=utf-8",
              "cache-control": "no-store",
            },
          }
        );
      }
      // Writes are confined to three routes; everything else here is a read.
      if (pathname === "/api/reindex" && request.method === "POST") {
        try {
          const body = (await request.json().catch(() => ({}))) as { embed?: unknown; embedBudget?: unknown };
          return await reindexMemory({
            reindex: api.reindex,
            embedReady: api.embedReady,
            embed: body.embed === true,
            embedBudget: typeof body.embedBudget === "number" ? body.embedBudget : undefined,
            log,
          });
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          log("api POST /api/reindex failed", detail);
          return new Response(JSON.stringify({ success: false, error: detail }), {
            status: 500,
            headers: { "content-type": "application/json; charset=utf-8" },
          });
        }
      }
      if (pathname === "/api/config" && request.method === "PUT") {
        try {
          const body = (await request.json().catch(() => ({}))) as {
            options?: unknown;
            sha256?: unknown;
            create?: unknown;
          };
          return await saveSettings({
            options: body.options,
            sha256: typeof body.sha256 === "string" ? body.sha256 : "",
            create: body.create === true,
            log,
          });
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          log("api PUT /api/config failed", detail);
          return new Response(JSON.stringify({ success: false, error: detail }), {
            status: 500,
            headers: { "content-type": "application/json; charset=utf-8" },
          });
        }
      }
      if (pathname === "/api/prompt-files" && request.method === "PUT") {
        try {
          const body = (await request.json().catch(() => ({}))) as {
            name?: unknown;
            content?: unknown;
            baseSha256?: unknown;
          };
          return await savePromptFile({
            name: typeof body.name === "string" ? body.name : "",
            content: typeof body.content === "string" ? body.content : "",
            baseSha256: typeof body.baseSha256 === "string" ? body.baseSha256 : "",
            db: api.db,
            workspaceDir: api.workspaceDir,
            log,
          });
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          log("api PUT /api/prompt-files failed", detail);
          return new Response(JSON.stringify({ success: false, error: detail }), {
            status: 500,
            headers: { "content-type": "application/json; charset=utf-8" },
          });
        }
      }
      if (request.method !== "GET") return notFound();
      // A failed query must not answer with an HTML error page: the page reads
      // every response as the JSON envelope and would render the stack trace.
      try {
        if (pathname === "/api/stats") return handleMemoryStats(api.db);
        if (pathname === "/api/prompt-files") return handlePromptFiles(api.workspaceDir);
        if (pathname === "/api/dreams") return handleDreams();
        if (pathname === "/api/config") return handlePluginConfig();
        if (pathname === "/api/models") return handleModelList(api.listModels);
        const routed = await handleMemoryApi(request, { ...api, authEnabled: auth.isEnabled() });
        if (routed) return routed;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        log(`api ${pathname} failed`, detail);
        return new Response(JSON.stringify({ success: false, error: detail }), {
          status: 500,
          headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-cache" },
        });
      }
      return new Response(JSON.stringify({ success: false, error: "no such endpoint" }), {
        status: 404,
        headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-cache" },
      });
    }
    if (request.method !== "GET" && request.method !== "HEAD") return notFound();
    return serveStatic(webDir, pathname, token);
  };

  const maxTries = 10;
  for (let attempt = 0; attempt <= maxTries; attempt++) {
    const port = config.port + attempt;
    const url = `http://${config.host}:${port}`;
    try {
      const server = isBun
        ? serveWithBun({ port, host: config.host, handler })
        : await serveWithNode({ port, host: config.host, handler });
      log(`memory browser at ${server.url}/ (serving ${webDir})`);
      if (auth.isEnabled()) {
        log(`http basic auth on (user "${auth.getUsername()}")`);
      }
      log(`api token required (${AUTH_HEADER}, exempting /api/health)`);
      return { url: server.url, dir: webDir, stop: server.stop };
    } catch (error) {
      const code = (error as { code?: string } | null)?.code;
      if (code !== "EADDRINUSE") {
        log(`failed to bind ${url}`, error);
        return inert;
      }
      if (await ownedByMemPlus(url)) {
        // Another window's plugin already serves the same bundle.
        log(`memory browser already served at ${url}/ (another instance owns the port)`);
        return { url, dir: webDir, stop: () => {} };
      }
      log(`port ${port} busy (not a mem-plus page server), trying ${port + 1}`);
    }
  }
  log(`no free port in ${config.port}-${config.port + maxTries}`);
  return inert;
}