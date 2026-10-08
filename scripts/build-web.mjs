// Build the memory-browser bundle before `npm pack`.
//
// The tarball ships `web/dist` (audit-npm-pack.mjs treats a missing bundle as
// drift), and the page is TSX, so packing without a build would produce an
// install whose web server has nothing to serve. Skips the work when the bundle
// is already there -- the point is to ship what you tested, not to rebuild it
// behind your back.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WEB = path.join(ROOT, "web");
const BUNDLE = path.join(WEB, "dist", "index.html");

function fail(message) {
  process.stderr.write(`[build-web] ${message}\n`);
  process.exit(1);
}

if (!existsSync(WEB)) {
  // A checkout without the UI at all: nothing to build, and the audit stays happy
  // only if web/dist is absent from `files` too.
  process.stdout.write("[build-web] no web/ directory, skipping\n");
  process.exit(0);
}

if (existsSync(BUNDLE)) {
  process.stdout.write("[build-web] web/dist/index.html already present, skipping build\n");
  process.exit(0);
}

if (!existsSync(path.join(WEB, "node_modules"))) {
  fail("web/node_modules missing -- run `npm --prefix web install` first");
}

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const result = spawnSync(npm, ["run", "build"], { cwd: WEB, stdio: "inherit", shell: process.platform === "win32" });
if (result.status !== 0) fail("`npm --prefix web run build` failed");
if (!existsSync(BUNDLE)) fail("build finished but web/dist/index.html is missing");
process.stdout.write("[build-web] web/dist ready\n");