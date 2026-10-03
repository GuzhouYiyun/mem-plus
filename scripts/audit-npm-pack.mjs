#!/usr/bin/env node
// Audit the runtime import closure of the published `mem-plus` npm package.
//
// The OpenCode plugin entry (`index.ts`) pulls in vendored openclaw sources
// (`src/**`, `packages/**`, `extensions/**`) through relative imports and
// `openclaw/plugin-sdk/*` / `@openclaw/*` specifiers. Those internal
// specifiers resolve in development via `tsconfig.json` `paths` (the OpenCode
// loader honors them); they are NOT npm packages. A published tarball must
// therefore:
//   1. ship exactly the closure files (root `files` allowlist),
//   2. carry the external npm deps the closure needs in root `dependencies`,
//   3. regenerate `node_modules/openclaw` (alias) and
//      `node_modules/@openclaw/*` stub packages at install time.
//
// This script computes (1)+(2) and, with `--write`, rewrites
// `package.json` (`files` + `dependencies`) and
// `plugin/scripts/openclaw-alias-spec.json` (the list of @openclaw/* stubs
// that `link-openclaw-alias.mjs` materializes in postinstall).
//
// Usage:
//   node scripts/audit-npm-pack.mjs          # report
//   node scripts/audit-npm-pack.mjs --check  # report; exit 1 on drift (prepack)
//   node scripts/audit-npm-pack.mjs --write  # rewrite package.json + spec
//
// The closure is static (regex import scan); the tsx import smoke test after
// `npm pack` is the runtime proof.

import { readFileSync, readdirSync, existsSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const relPosix = (p) => path.relative(ROOT, p).split(path.sep).join("/");
const args = new Set(process.argv.slice(2));
const writeMode = args.has("--write");
const checkMode = args.has("--check");
const trace = args.has("--trace");

const rootPkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
const pluginPkg = JSON.parse(readFileSync(path.join(ROOT, "plugin", "package.json"), "utf8"));
const tsconfig = JSON.parse(readFileSync(path.join(ROOT, "tsconfig.json"), "utf8"));
const pathsMap = tsconfig.compilerOptions?.paths ?? {};

// --- workspace manifests, for version lookups of external deps ----------------
const wsManifests = [];
for (const sub of ["packages", "extensions"]) {
  const dir = path.join(ROOT, sub);
  if (!existsSync(dir)) continue;
  for (const name of readdirSync(dir)) {
    const pj = path.join(dir, name, "package.json");
    if (existsSync(pj) && statSync(pj).isFile()) {
      const m = JSON.parse(readFileSync(pj, "utf8"));
      wsManifests.push({ name: m.name, dir: sub + "/" + name, deps: m.dependencies ?? {} });
    }
  }
}

// --- entry points --------------------------------------------------------------
// Everything shipped under plugin/ is loadable, so start the walk from all of
// it, plus the root entry files.
function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (/\.(ts|mts|js|mjs)$/.test(e.name) && !/\.(d\.ts|test\.ts)$/.test(e.name)) out.push(p);
  }
  return out;
}
const entries = [
  path.join(ROOT, "index.ts"),
  ...(existsSync(path.join(ROOT, "bootstrap.ts")) ? [path.join(ROOT, "bootstrap.ts")] : []),
  ...walk(path.join(ROOT, "plugin", "src")),
  ...walk(path.join(ROOT, "plugin", "serve")),
  ...walk(path.join(ROOT, "plugin", "scripts")),
];

// --- import scanning -----------------------------------------------------------
// Precise scanning: strip comments first (string-literal aware), then match
// statement-anchored import/export/dynamic-import forms. JSDoc examples that
// look like `import { x } from "y"` are comments and must not count.
const unresolvable = []; // { file, spec, why }

// Character-level scanner: walks the source once, tracking strings and
// comments so that import/export/require keywords are only recognized in
// statement code. JSDoc/template-literal examples look like imports but are
// skipped because their contents are inside a string or comment context.
// Not a full parser (regex literals containing `//` may confuse it);
// acceptable for import scanning.
function extractSpecs(code) {
  const found = []; // { spec, kind: import | export | dynamic }
  const n = code.length;
  let i = 0;

  const isIdent = (ch) => ch >= "a" && ch <= "z" || ch >= "A" && ch <= "Z" || ch >= "0" && ch <= "9" || ch === "_" || ch === "$";

  // Position p is at a statement start if the previous non-space char allows it.
  const stmtStart = (p) => {
    let j = p - 1;
    while (j >= 0 && (code[j] === " " || code[j] === "\t" || code[j] === "\n" || code[j] === "\r")) j--;
    if (j < 0) return true;
    const c = code[j];
    return c === ";" || c === "{" || c === "}" || c === "(" || c === ")" || c === "," || c === "!" || c === "&" || c === "|" || c === "?" || c === ":" || c === "=" || c === ">" || c === "\n";
  };

  // Returns index just past the string literal starting at i (opening quote).
  const pastString = (start) => {
    const q = code[start];
    let j = start + 1;
    while (j < n) {
      const d = code[j];
      if (d === "\\") {
        j += 2;
        continue;
      }
      j++;
      if (d === q) return j;
      if (d === "\n" && q !== "`") return j;
    }
    return j;
  };

  // Scan forward from j for a `from "spec"` clause (value or type). Returns
  // { spec, fromIndex, endIndex } or null when the statement has no from.
  const findFrom = (j) => {
    let k = j;
    while (k < n) {
      const c = code[k];
      if (c === '"' || c === "'" || c === "`") {
        const end = pastString(k);
        return { spec: code.slice(k + 1, end - 1 < n ? end - 1 : n + 1), qStart: k, end };
      }
      if (code.startsWith("from", k) && (k === 0 || !isIdent(code[k - 1])) && !isIdent(code[k + 4] ?? "")) {
        let m = k + 4;
        while (m < n && (code[m] === " " || code[m] === "\t")) m++;
        if (code[m] === '"' || code[m] === "'") {
          const end = pastString(m);
          return { spec: code.slice(m + 1, end - 1), qStart: m, end };
        }
      }
      if (c === ";" || (c === "\n" && code[k - 1] !== "\\")) {
        // statement ended without a from clause
        return null;
      }
      k++;
    }
    return null;
  };

  while (i < n) {
    const c = code[i];
    if (c === '"' || c === "'" || c === "`") {
      i = pastString(i) + 1;
      continue;
    }
    if (c === "/" && code[i + 1] === "/") {
      while (i < n && code[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && code[i + 1] === "*") {
      i += 2;
      while (i < n && !(code[i] === "*" && code[i + 1] === "/")) i++;
      i += 2;
      continue;
    }

    // A keyword occurrence is only an import keyword if the char before it is
    // not an identifier char or `.` (rules out `obj.import` / `myImport`), and
    // the char after it is not an identifier char (rules out `imports`).
    const prev = i > 0 ? code[i - 1] : "";
    const nextCh = code[i + 6] ?? "";
    if (code.startsWith("import", i) && !isIdent(prev) && prev !== "." && !isIdent(nextCh)) {
      let j = i + 6;
      while (j < n && (code[j] === " " || code[j] === "\t" || code[j] === "\n" || code[j] === "\r")) j++;
      if (code[j] === ".") {
        // `import.meta` -- not an import statement; resume char-by-char scan
        i++;
        continue;
      }
      if (code[j] === "(") {
        // dynamic import("spec") [ , "name" ]
        let k = j + 1;
        while (k < n && (code[k] === " " || code[k] === "\t" || code[k] === "\n")) k++;
        if (code[k] === '"' || code[k] === "'") {
          // Skip `typeof import("x")`: a type query, erased at load time.
          let b = i - 1;
          while (b >= 0 && (code[b] === " " || code[b] === "\t" || code[b] === "\n")) b--;
          const isTypeQuery = b >= 5 && code.slice(b - 5, b + 1) === "typeof";
          if (!isTypeQuery) {
            const end = pastString(k);
            found.push({ spec: code.slice(k + 1, end - 1), kind: "dynamic" });
          }
        }
        // advance to the closing paren (string-aware). pastString lands just
        // past the closing quote, so no extra step -- skipping the next char
        // would swallow the `)` that closes a bare `import("spec")` and the
        // depth count would run away to EOF.
        let depth = 1;
        k = j + 1;
        while (k < n && depth > 0) {
          const d = code[k];
          if (d === '"' || d === "'" || d === "`") k = pastString(k);
          else {
            if (d === "(") depth++;
            else if (d === ")") depth--;
            k++;
          }
        }
        i = k;
        continue;
      }
      if (code.startsWith("type", j) && !isIdent(code[j + 4] ?? "")) {
        // `import type ...` -- erased, never force-loads the target.
        found.push({ spec: null, kind: "type", at: i });
        i = findFrom(j + 4) ? findFrom(j + 4).end + 1 : j + 4;
        continue;
      }
      if (code[j] === '"' || code[j] === "'") {
        // side-effect import "spec"
        const end = pastString(j);
        found.push({ spec: code.slice(j + 1, end - 1), kind: "import" });
        i = end;
        continue;
      }
      if (code[j] === "{") {
        // named clause (possibly multi-line): consume to matching }.
        // pastString lands just past the closing quote -- stepping one
        // further would skip a `}` that directly closes `import { "a" }`.
        let depth = 0;
        let k = j;
        while (k < n) {
          const d = code[k];
          if (d === '"') {
            k = pastString(k);
            continue;
          }
          if (d === "{") depth++;
          else if (d === "}") {
            depth--;
            if (depth === 0) {
              k++;
              break;
            }
          }
          k++;
        }
        const f = findFrom(k);
        if (f) found.push({ spec: f.spec, kind: "import" });
        i = f ? f.end + 1 : k;
        continue;
      }
      // default / namespace clause: skip identifier or `* as ns`
      let k = j;
      while (k < n && (isIdent(code[k]) || code[k] === "*")) k++;
      while (k < n && (code[k] === " " || code[k] === "\t" || code[k] === "," || code[k] === "}" || code[k] === "{")) {
        if (code[k] === "{" ) {
          // trailing named clause
          let depth = 0;
          let m = k;
          while (m < n) {
            const d = code[m];
            if (d === "{") depth++;
            else if (d === "}") {
              depth--;
              if (depth === 0) {
                m++;
                break;
              }
            }
            m++;
          }
          k = m;
          break;
        }
        k++;
      }
      const f = findFrom(k);
      if (f) found.push({ spec: f.spec, kind: "import" });
      i = f ? f.end + 1 : k;
      continue;
    }

    if (code.startsWith("export", i) && !isIdent(prev) && prev !== "." && !isIdent(code[i + 6] ?? "")) {
      let j = i + 6;
      while (j < n && (code[j] === " " || code[j] === "\t" || code[j] === "\n")) j++;
      if (code.startsWith("type", j) && !isIdent(code[j + 4] ?? "")) {
        j += 4;
        while (j < n && (code[j] === " " || code[j] === "\t")) j++;
        if (code[j] === "{") {
          let depth = 0;
          let k = j;
          while (k < n) {
            const d = code[k];
            if (d === "{") depth++;
            else if (d === "}") {
              depth--;
              if (depth === 0) {
                k++;
                break;
              }
            }
            k++;
          }
          const f = findFrom(k);
          // type-only: do NOT follow
          i = f ? f.end + 1 : k;
        } else {
          i = j;
        }
        continue;
      }
      if (code[j] === "*") {
        // export * from "x" / export * as ns from "x"
        let k = j + 1;
        while (k < n && (isIdent(code[k]) || code[k] === " ")) k++;
        const f = findFrom(k);
        if (f) found.push({ spec: f.spec, kind: "export" });
        i = f ? f.end + 1 : k;
        continue;
      }
      if (code[j] === "{") {
        let depth = 0;
        let k = j;
        while (k < n) {
          const d = code[k];
          if (d === "{") depth++;
          else if (d === "}") {
            depth--;
            if (depth === 0) {
              k++;
              break;
            }
          }
          k++;
        }
        const f = findFrom(k);
        if (f) found.push({ spec: f.spec, kind: "export" });
        i = f ? f.end + 1 : k;
        continue;
      }
      // declaration export (export const/func/class/interface...) -- no from.
      i = j;
      continue;
    }

    if (code.startsWith("require", i) && !isIdent(prev) && prev !== "." && !isIdent(code[i + 7] ?? "")) {
      let j = i + 7;
      while (j < n && (code[j] === " " || code[j] === "\t")) j++;
      if (code[j] === "(") {
        let k = j + 1;
        while (k < n && (code[k] === " " || code[k] === "\t")) k++;
        if (code[k] === '"' || code[k] === "'") {
          const end = pastString(k);
          found.push({ spec: code.slice(k + 1, end - 1), kind: "require" });
        }
      }
      i = j;
      continue;
    }

    i++;
  }
  return found.filter((x) => x.spec !== null && x.kind !== "type");
}

// Returns [{ spec, kind }] for one file.
function scan(file) {
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  return extractSpecs(raw);
}

// --scan <relpath>: dump what the scanner sees in one file, then exit.
if (process.argv.includes("--scan")) {
  const rel = process.argv[process.argv.indexOf("--scan") + 1];
  const found = scan(path.join(ROOT, rel));
  console.log(`${rel}: ${found.length} specs`);
  for (const s of found) console.log(`  ${s.kind.padEnd(7)} ${s.spec}`);
  process.exit(0);
}

// --- resolution ----------------------------------------------------------------
function resolveRelative(baseDir, spec) {
  const base = path.resolve(baseDir, spec);
  let cands;
  if (spec.endsWith(".ts")) cands = [base];
  else if (spec.endsWith(".js")) cands = [base.slice(0, -3) + ".ts", base];
  else if (spec.endsWith(".mjs")) cands = [base];
  else if (spec.endsWith(".json")) cands = [base];
  else cands = [base + ".ts", base + ".js", base + ".mjs", path.join(base, "index.ts"), path.join(base, "index.js")];
  for (const c of cands) {
    if (existsSync(c) && statSync(c).isFile()) return c;
  }
  return null;
}

// tsconfig `paths` lookup: longest matching key wins; `*` is a suffix wildcard.
function tsconfigTarget(spec) {
  let bestKey = null;
  let bestLen = -1;
  for (const key of Object.keys(pathsMap)) {
    if (key.endsWith("*")) {
      const prefix = key.slice(0, -1);
      if (spec === key || spec.startsWith(prefix)) {
        if (key.length > bestLen) {
          bestKey = key;
          bestLen = key.length;
        }
      }
    } else if (key === spec && key.length > bestLen) {
      bestKey = key;
      bestLen = key.length;
    }
  }
  if (!bestKey) return null;
  const target = pathsMap[bestKey][0];
  const suffix = spec.slice(bestKey.length - (bestKey.endsWith("*") ? 1 : 0));
  const raw = target.replace("*", suffix);
  const abs = path.resolve(ROOT, raw);
  const cands = abs.endsWith(".ts") ? [abs, abs.slice(0, -3) + ".js"] : [abs, abs.slice(0, -3) + ".ts"];
  for (const c of cands) if (existsSync(c) && statSync(c).isFile()) return c;
  return null; // target missing on disk -> fall through to external
}

const externalName = (spec) =>
  spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];

const closure = new Set(entries.filter(existsSync));
const missingEntries = entries.filter((e) => !existsSync(e));
if (missingEntries.length) unresolvable.push({ file: "-", spec: "", why: "missing entry " + missingEntries.map(relPosix).join(",") });

const externals = new Set(); // npm packages needed by the STATIC closure
const externalSources = new Map(); // external name -> [{ file, spec, kind, why }] (first few)
const dynamicExternals = new Set(); // only behind dynamic import() -- reported, not deps
const dynamicTargets = new Set(); // repo files only reachable via dynamic import()
const internalSpecs = new Map(); // @openclaw pkg name -> Set<resolved spec> (stub targets)
const warnings = [];

// Node builtins reachable without the `node:` prefix.
const BUILTINS = new Set(
  "assert async_hooks buffer child_process cluster console crypto dgram diagnostics_channel dns domain events fs http http2 https inspector module net os path perf_hooks process punycode querystring readline repl stream string_decoder sys timers tls trace_events tty url util vm worker_threads zlib".split(" "),
);

const queue = [...closure];
while (queue.length) {
  const file = queue.shift();
  if (file.endsWith(".d.ts")) continue;
  for (const { spec, kind } of scan(file)) {
    if (spec.startsWith("node:") || spec.startsWith("bun:") || spec.startsWith("data:") || spec.startsWith("file:")) continue;

    // Dynamic imports: do NOT extend the static closure (they are lazy, and in
    // the mem-plus use case most openclaw provider/cli paths behind them never
    // fire). Record them for review; their externals stay out of dependencies.
    if (kind === "dynamic") {
      const nm = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.startsWith("./") || spec.startsWith("../") ? null : spec.split("/")[0];
      if (nm) dynamicExternals.add(nm);
      else if (spec.startsWith("./") || spec.startsWith("../")) {
        const t = resolveRelative(path.dirname(file), spec.replace(/\\/g, "/"));
        if (t && t.startsWith(ROOT + path.sep)) dynamicTargets.add(relPosix(t));
      }
      continue;
    }

    let target = null;
    let external = null;
    const recordExternal = (name, why) => {
      externals.add(name);
      if (!externalSources.has(name)) externalSources.set(name, []);
      const src = { file: relPosix(file), spec, kind, why };
      if (externalSources.get(name).length < 4) externalSources.get(name).push(src);
    };
    if (spec.startsWith("./") || spec.startsWith("../") || spec.startsWith(".\\")) {
      target = resolveRelative(path.dirname(file), spec.replace(/\\/g, "/"));
      if (!target) unresolvable.push({ file, spec, why: "relative target not found" });
      if (target && !target.startsWith(ROOT + path.sep)) {
        unresolvable.push({ file, spec, why: "escapes repo: " + target });
        target = null;
      }
    } else if (spec.startsWith("@openclaw/") || spec.startsWith("openclaw/")) {
      target = tsconfigTarget(spec);
      if (target) {
        // Record the @openclaw/* ones for the postinstall stub generator.
        // The unscoped `openclaw/*` alias is already handled by the existing
        // link-openclaw-alias.mjs directory scan, no spec needed.
        if (spec.startsWith("@openclaw/")) {
          const raw = relPosix(target);
          const pkgDir = raw.split("/").slice(0, 2).join("/");
          const pkgJson = path.join(ROOT, pkgDir, "package.json");
          const pkgName = existsSync(pkgJson) ? JSON.parse(readFileSync(pkgJson, "utf8")).name : null;
          if (pkgName) {
            if (!internalSpecs.has(pkgName)) internalSpecs.set(pkgName, new Set());
            internalSpecs.get(pkgName).add(spec);
          } else warnings.push(`no package.json name for ${pkgDir} (spec ${spec})`);
        }
      } else {
        external = externalName(spec); // e.g. @openclaw/fs-safe -> external
      }
    } else if (spec.startsWith("@")) {
      external = externalName(spec);
    } else if (BUILTINS.has(spec)) {
      continue; // bare builtin
    } else if (/^[a-z]/.test(spec)) {
      external = externalName(spec);
    } else {
      unresolvable.push({ file, spec, why: "unclassified specifier" });
      continue;
    }
    if (target) {
      if (trace && (
        target.endsWith(`${path.sep}packages${path.sep}ai${path.sep}src${path.sep}index.ts`) ||
        target.endsWith(`${path.sep}packages${path.sep}agent-core${path.sep}src${path.sep}index.ts`) ||
        target.endsWith(`${path.sep}packages${path.sep}acp-core${path.sep}src${path.sep}index.ts`) ||
        target.endsWith("sqlite-wal.ts") ||
        target.endsWith("ai-transport-host.ts") ||
        target.endsWith("ai-transport-runtime-host.ts") ||
        target.endsWith("model-registry-runtime.ts") ||
        target.endsWith(`${path.sep}src${path.sep}acp${path.sep}runtime${path.sep}errors.ts`) ||
        target.endsWith(`${path.sep}src${path.sep}plugin-sdk${path.sep}agent-core.ts`)
      )) {
        console.error(`TRACE ${relPosix(file)} --${kind}--> ${relPosix(target)}  (spec ${spec})`);
      }
      if (!closure.has(target)) {
        if (target.includes(`${path.sep}__tests__${path.sep}`) || target.endsWith(".test.ts")) {
          warnings.push(`test file reached at runtime: ${relPosix(target)} (from ${relPosix(file)})`);
        }
        closure.add(target);
        queue.push(target);
      }
    } else if (external) {
      recordExternal(external);
    }
  }
}

// --- data-file pass --------------------------------------------------------------
// The import scanner only sees static import/export edges. Some closure files
// read data assets at module load via `new URL("./file.sql", import.meta.url)`
// (notably src/state/openclaw-{agent,state}-schema.ts). Those assets must ship
// next to their loader, so resolve them explicitly.
const CODE_FILE = /\.(ts|mts|cts|js|mjs|cjs|d\.tsx?|tsx)$/;
const newUrlRe = /new URL\(\s*["'`](\.{1,2}\/[^"'`\n]+)["'`]\s*,/g;
const dataFiles = [];
for (const file of [...closure]) {
  if (CODE_FILE.test(file)) {
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const m of text.matchAll(newUrlRe)) {
      const spec = m[1].replace(/\\/g, "/");
      if (spec.includes("$")) continue; // template-literal (dynamic) spec -- unresolvable
      let target = path.resolve(path.dirname(file), spec);
      if (spec.endsWith(".js") && !existsSync(target)) target = target.slice(0, -3) + ".ts";
      if (!target.startsWith(ROOT + path.sep)) {
        continue;
      }
      if (CODE_FILE.test(target)) continue; // code refs are handled by import scanning
      if (!existsSync(target)) {
        warnings.push(`data file referenced by closure file is missing: ${relPosix(target)} (from ${relPosix(file)}, spec ${spec})`);
        continue;
      }
      if (!closure.has(target)) {
        closure.add(target);
        dataFiles.push(relPosix(target));
      }
    }
  }
}
if (dataFiles.length) console.log(`data files added: ${dataFiles.join(", ")}`);

// --- dependency assembly ---------------------------------------------------------
const mergedDeps = {};
const depNotes = {};
for (const [k, v] of Object.entries(rootPkg.dependencies ?? {})) {
  mergedDeps[k] = v;
  depNotes[k] = "root";
}
for (const [k, v] of Object.entries(pluginPkg.dependencies ?? {})) {
  if (k in mergedDeps) {
    if (mergedDeps[k] !== v) warnings.push(`dep conflict ${k}: root ${mergedDeps[k]} vs plugin ${v} (keeping root)`);
  } else {
    mergedDeps[k] = v;
    depNotes[k] = "plugin";
  }
}
for (const pkg of externals) {
  if (pkg in mergedDeps) continue;
  // is it a private workspace package that slipped through?
  const ws = wsManifests.find((m) => m.name === pkg);
  if (ws) {
    warnings.push(`${pkg} is a private workspace package (${ws.dir}) but resolved as external -- closure bug?`);
    continue;
  }
  let range = null;
  const wsDecl = wsManifests.find((m) => m.deps[pkg]);
  if (wsDecl) {
    range = wsDecl.deps[pkg];
    depNotes[pkg] = `${wsDecl.dir} declares ${range}`;
  } else {
    // fall back to the installed version
    const nmPj = path.join(ROOT, "node_modules", pkg, "package.json");
    if (existsSync(nmPj)) {
      range = "^" + JSON.parse(readFileSync(nmPj, "utf8")).version;
      depNotes[pkg] = "installed version, ^-pinned";
    }
  }
  if (!range) {
    warnings.push(`no version source for external dep ${pkg} -- add manually`);
    continue;
  }
  mergedDeps[pkg] = range;
}

// --- files allowlist -------------------------------------------------------------
// Fixed files (only those that exist), whole plugin dirs, and every closure
// file outside of plugin/.
const fixedFiles = ["index.ts", "bootstrap.ts", "LICENSE", "README.md", "README_en.md", "plugin/package.json", "plugin/scripts/openclaw-alias-spec.json"].filter((f) =>
  existsSync(path.join(ROOT, f)),
);
const pluginDirs = ["plugin/src", "plugin/serve", "plugin/scripts"];
const closureFiles = [...closure]
  .filter((f) => !f.startsWith(path.join(ROOT, "plugin") + path.sep))
  .filter((f) => f !== path.join(ROOT, "index.ts") && f !== path.join(ROOT, "bootstrap.ts"))
  .map(relPosix)
  .sort();
const computedFiles = [...fixedFiles, ...pluginDirs, ...closureFiles].sort();

// --- alias spec ------------------------------------------------------------------
// node_modules/@openclaw/<pkg> stubs generated in postinstall (see
// plugin/scripts/link-openclaw-alias.mjs): a package.json whose exports map
// each subpath onto an in-stub re-export .ts file, which pulls the module
// from the shipped source tree. Values are relative to the stub dir.
const aliasSpec = {};
for (const [pkgName, specs] of internalSpecs) {
  const entries = {};
  for (const spec of specs) {
    const sub = spec.replace(pkgName, "").replace(/^\//, "");
    const target = tsconfigTarget(spec);
    if (!target) continue;
    // The re-export file lives in the stub dir (one level deeper for nested
    // subpaths), and the link script writes the relative `../` chain per file,
    // so record the source path relative to the package root only.
    entries[sub === "" ? "." : "/" + sub] = relPosix(target);
  }
  if (Object.keys(entries).length) aliasSpec[pkgName] = entries;
}

// --- report ----------------------------------------------------------------------
const currentFiles = new Set(rootPkg.files ?? []);
const currentDeps = new Set(Object.keys(rootPkg.dependencies ?? {}));
const missingFiles = computedFiles.filter((f) => !currentFiles.has(f));
const extraFiles = [...currentFiles].filter((f) => !computedFiles.includes(f));
const missingDeps = Object.keys(mergedDeps).filter((d) => !currentDeps.has(d));

console.log(`closure (static): ${closure.size} files (${closureFiles.length} outside plugin/)`);
console.log(`externals: ${[...externals].sort().join(", ") || "(none)"}`);
console.log(`dynamic-only externals (NOT deps): ${[...dynamicExternals].sort().join(", ") || "(none)"}`);
if (dynamicTargets.size) console.log(`dynamic-only targets (${dynamicTargets.size}, not shipped): ${[...dynamicTargets].slice(0, 12).join(", ")}`);
console.log(`internal stubs: ${Object.keys(aliasSpec).sort().join(", ") || "(none)"}`);
const sourceless = [...externals].filter((e) => !externalSources.has(e));
if (sourceless.length) console.log(`externals with NO recorded source (scanner noise?): ${sourceless.join(", ")}`);
if (trace) {
  for (const [name, srcs] of externalSources) {
    if (!(name in mergedDeps)) {
      console.log(`external ${name} (not a dep) sources:`);
      for (const s of srcs) console.log(`  ${s.file}  spec=${s.spec}  kind=${s.kind}`);
    }
  }
}
if (missingFiles.length) console.log(`files not in package.json:\n  ${missingFiles.join("\n  ")}`);
if (extraFiles.length) console.log(`files in package.json not computed:\n  ${extraFiles.join("\n  ")}`);
if (missingDeps.length) console.log(`deps not in package.json:\n  ${missingDeps.map((d) => `  ${d} ${mergedDeps[d]} (${depNotes[d] ?? "?"})`).join("\n")}`);
if (unresolvable.length) {
  console.log("unresolvable imports:");
  for (const u of unresolvable.slice(0, 40)) console.log(`  ${relPosix(u.file)}  ${u.spec}  [${u.why}]`);
}
if (warnings.length) {
  console.log("warnings:");
  for (const w of warnings.slice(0, 40)) console.log("  " + w);
}

// --- write / check ----------------------------------------------------------------
if (writeMode) {
  const pkg = { ...rootPkg };
  // The spec is (re)generated below; on a first run it is not on disk yet and
  // therefore not in computedFiles -- make sure the manifest lists it either way.
  const specRel = "plugin/scripts/openclaw-alias-spec.json";
  pkg.files = computedFiles.includes(specRel) ? computedFiles : [...computedFiles, specRel].sort();
  pkg.dependencies = Object.fromEntries(Object.entries(mergedDeps).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(path.join(ROOT, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
  const spec = {
    note: "Generated by scripts/audit-npm-pack.mjs --write. Do not edit by hand.",
    stubs: aliasSpec,
  };
  writeFileSync(path.join(ROOT, "plugin", "scripts", "openclaw-alias-spec.json"), JSON.stringify(spec, null, 2) + "\n");
  console.log("wrote package.json (files+dependencies) and plugin/scripts/openclaw-alias-spec.json");
}

const drift = missingFiles.length || extraFiles.length || missingDeps.length || unresolvable.length;
if (checkMode) {
  if (drift) {
    console.error("DRIFT detected (run: node scripts/audit-npm-pack.mjs --write)");
    process.exit(1);
  }
  console.log("no drift");
}
