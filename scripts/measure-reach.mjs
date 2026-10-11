// Measure the real dependency closure of the plugin entry point.
//
// Why this exists: `bun build` reports 39 "could not resolve" modules for imports
// that never run, and `tsc` reports 4254 errors for the same reason — a `.ts`
// tree that is only ever loaded by a runtime with lazy resolution. Neither number
// says how much code is genuinely reachable. This walks the graph the way Bun
// does: follow every import that resolves, stop at the ones that do not, and
// report both halves. The reachable count is what decides whether "keep only the
// memory subsystem" is extraction (cheap) or rewriting (expensive).
//
// Not shipped: a measurement tool, not part of the package.

import { readFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = path.join(root, "index.ts");

// External = anything resolved by the runtime rather than by us. These are what
// the package actually declares as dependencies.
const BUILTIN = /^(node|bun):/;
const BARE = /^[@a-z]/i;

const tsconfig = JSON.parse(
  readFileSync(path.join(root, "tsconfig.json"), "utf8")
    // strip comments so JSON.parse survives them
    .replace(/^\s*\/\/.*$/gm, ""),
);
const paths = tsconfig.compilerOptions?.paths ?? {};
const baseUrl = tsconfig.compilerOptions?.baseUrl ?? ".";

const reachable = new Map(); // absolute path -> kind
const unresolved = new Map(); // specifier -> importer
const external = new Set();

/** Resolve one specifier the way Bun does, including the .js -> .ts rewrite. */
function resolve(spec, importer) {
  if (BUILTIN.test(spec)) return { external: spec };
  if (BARE.test(spec)) {
    // A tsconfig paths alias wins over the bare name; that is how
    // `openclaw/plugin-sdk/*` resolves to the vendored tree.
    const hit = matchPath(spec);
    if (hit) return hit;
    return { external: spec };
  }

  const base = path.resolve(path.dirname(importer), spec);
  const candidates = [];
  // "./x.js" is the NodeNext spelling of "./x.ts" -- this rewrite is the single
  // most load-bearing detail here and the reason tsc cannot do this job.
  if (base.endsWith(".js")) candidates.push(base.slice(0, -3) + ".ts");
  candidates.push(base);
  if (!/\.[cm]?[jt]s$/.test(base)) {
    for (const ext of [".ts", ".js", ".tsx", ".jsx", "/index.ts", "/index.js"]) {
      candidates.push(base + ext);
    }
  }
  for (const c of candidates) {
    if (existsSync(c) && statSync(c).isFile()) return { file: c };
  }
  return null;
}

function matchPath(spec) {
  for (const [pattern, targets] of Object.entries(paths)) {
    const star = pattern.indexOf("*");
    if (star < 0) {
      if (pattern !== spec) continue;
      for (const t of targets) {
        const f = path.resolve(root, baseUrl, t);
        if (existsSync(f)) return { file: f };
      }
      continue;
    }
    const pre = pattern.slice(0, star);
    const post = pattern.slice(star + 1);
    if (!spec.startsWith(pre) || !spec.endsWith(post)) continue;
    const middle = spec.slice(pre.length, spec.length - post.length || undefined);
    for (const t of targets) {
      const f = path.resolve(root, baseUrl, t.replace("*", middle));
      if (existsSync(f) && statSync(f).isFile()) return { file: f };
    }
  }
  return null;
}

const IMPORT_RE =
  /(?:\bimport\s+(?:[\s\S]*?\bfrom\s*)?|\bexport\s+[\s\S]*?\bfrom\s*|\brequire\s*\(\s*|\bimport\s*\(\s*)(["'])([^"']+)\1/g;

function walk(file) {
  if (reachable.has(file)) return;
  reachable.set(file, "ts");
  let src;
  try {
    src = readFileSync(file, "utf8");
  } catch {
    return;
  }
  for (const m of src.matchAll(IMPORT_RE)) {
    const spec = m[2];
    // skip `node:test` style and type-only-from-erased paths the same way
    const hit = resolve(spec, file);
    if (hit?.file) walk(hit.file);
    else if (hit?.external) external.add(hit.external);
    else {
      if (!unresolved.has(spec)) unresolved.set(spec, []);
      unresolved.get(spec).push(path.relative(root, file));
    }
  }
}

walk(entry);

const rel = (f) => path.relative(root, f).replace(/\\/g, "/");
const byTop = new Map();
for (const f of reachable.keys()) {
  const top = rel(f).split("/")[0];
  byTop.set(top, (byTop.get(top) ?? 0) + 1);
}

console.log(`reachable files: ${reachable.size}`);
console.log("");
console.log("by top-level directory:");
for (const [k, v] of [...byTop].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(v).padStart(5)}  ${k}`);
}
console.log("");
console.log(`external specifiers: ${external.size}`);
const bare = [...external].filter((s) => BARE.test(s));
console.log(`  bare (${bare.length}): ${bare.sort().join(", ")}`);
console.log("");
console.log(`unresolved specifiers: ${unresolved.size}`);
for (const [spec, importers] of unresolved) {
  console.log(`  ${spec}  <- ${importers[0]}`);
}