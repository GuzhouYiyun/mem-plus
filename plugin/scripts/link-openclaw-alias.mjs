// Generate the `openclaw/plugin-sdk/*` module alias the plugin needs at runtime.
//
// WHY THIS EXISTS
//   openclaw's own sources refer to each other by the bare specifier
//   `openclaw/plugin-sdk/<name>`. Inside openclaw that resolves through a
//   workspace link plus `tsconfig.json`'s `paths`, which is enough for `tsc`.
//   Neither mechanism exists here: this repository *is* openclaw's tree, cut
//   down and renamed, with no workspace to link against. And the plugin is not
//   type-checked when OpenCode loads it -- bun and node resolve modules at
//   runtime and neither reads `tsconfig.json`. So the alias has to exist as real
//   files on disk.
//
//   A package at `node_modules/openclaw` whose `exports` map points back into
//   `src/plugin-sdk/` is the one shape that works for both: node's resolver
//   finds it by walking up from the importing file, and nothing in openclaw's
//   source has to change.
//
// WHY IT IS GENERATED
//   The previous copy was 351 hand-written re-export files against a 359-file
//   source directory, so it was already out of date and nothing would have said
//   so. Generating it from the source listing means a new `src/plugin-sdk/*.ts`
//   is picked up by re-running this script, and a deleted one disappears.
//
// USAGE
//   node plugin/scripts/link-openclaw-alias.mjs          # write the alias
//   node plugin/scripts/link-openclaw-alias.mjs --check  # verify, write nothing
//
// The alias lives in `node_modules/`, which `.gitignore` already excludes, so
// this is a setup step rather than committed content. It must be run once after
// cloning, alongside `npm install`.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const sourceDir = path.join(repoRoot, "src", "plugin-sdk");
const targetDir = path.join(repoRoot, "node_modules", "openclaw");

const checkOnly = process.argv.includes("--check");

/**
 * Source files that must not get a runtime alias.
 *
 * Test files are excluded because re-exporting them would pull their imports
 * and their top-level side effects into the plugin's module graph. Declarations
 * have no runtime shape to re-export.
 */
function isPublishable(name) {
  return name.endsWith(".ts") && !name.endsWith(".d.ts") && !name.endsWith(".test.ts");
}

function listSources(dir, prefix = "") {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      found.push(...listSources(path.join(dir, entry.name), rel));
      continue;
    }
    if (!isPublishable(entry.name)) continue;
    // `foo.ts` is reached as `openclaw/plugin-sdk/foo`, so the alias is named
    // for the path with the extension stripped.
    found.push({ alias: rel.replace(/\.ts$/, ""), source: path.join(dir, entry.name) });
  }
  return found;
}

if (!existsSync(sourceDir)) {
  console.error(`Cannot find ${path.relative(repoRoot, sourceDir)}. Is this the repository root?`);
  process.exit(1);
}

const sources = listSources(sourceDir);
if (sources.length === 0) {
  console.error(`No publishable modules under ${path.relative(repoRoot, sourceDir)}.`);
  process.exit(1);
}

// The re-export path is written relative to the emitted file's own directory,
// so it stays correct at any nesting depth. Measured from
// `node_modules/openclaw/plugin-sdk/` for a top-level alias (three levels up) and
// from `node_modules/openclaw/plugin-sdk/test-helpers/agents/` for a nested one
// (five up). Fixing the base at `plugin-sdk/` gets the first case right and every
// nested alias wrong.
const aliasDir = path.join(targetDir, "plugin-sdk");
const relPathToSource = (alias) =>
  path
    .relative(path.join(aliasDir, path.dirname(alias)), path.join(sourceDir, `${alias}.ts`))
    .split(path.sep)
    .join("/");

// Only advertise the bare `openclaw/plugin-sdk` specifier when there is an
// `index.ts` to land on. `src/plugin-sdk/` has none, and an exports entry
// pointing at a missing file is a trap that only fails at resolve time.
const exportsMap = { "./plugin-sdk/*": "./plugin-sdk/*.ts" };
if (existsSync(path.join(sourceDir, "index.ts"))) {
  exportsMap["./plugin-sdk"] = "./plugin-sdk/index.ts";
}

const manifest = `${JSON.stringify(
  {
    name: "openclaw",
    version: "0.0.0-local-alias",
    type: "module",
    private: true,
    exports: exportsMap,
  },
  null,
  2,
)}\n`;

const written = [];
const missing = [];
for (const { alias, source } of sources) {
  if (!existsSync(source)) {
    missing.push(alias);
    continue;
  }
  const out = path.join(targetDir, "plugin-sdk", `${alias}.ts`);
  const body = `export * from "${relPathToSource(alias)}";\n`;
  let current = null;
  try {
    current = readFileSync(out, "utf8");
  } catch {
    /* not written yet */
  }
  if (current === body) continue;
  if (!checkOnly) {
    mkdirSync(path.dirname(out), { recursive: true });
    writeFileSync(out, body, "utf8");
  }
  written.push(alias);
}

if (missing.length > 0) {
  console.error(`Source disappeared under the alias list: ${missing.join(", ")}`);
  process.exit(1);
}

// Drop alias files whose source no longer exists, so a rename cannot leave a
// stale module that still resolves and shadows the real one.
const stale = [];
if (existsSync(path.join(targetDir, "plugin-sdk"))) {
  const live = new Set(sources.map((s) => `${s.alias}.ts`));
  for (const entry of readdirSync(path.join(targetDir, "plugin-sdk"), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(targetDir, "plugin-sdk", entry.name);
    for (const child of readdirSync(dir, { withFileTypes: true })) {
      if (!child.isFile()) continue;
      const rel = `${entry.name}/${child.name}`;
      if (live.has(rel)) continue;
      stale.push(rel);
      if (!checkOnly) rmSync(path.join(dir, child.name), { force: true });
    }
    if (!checkOnly && readdirSync(dir).length === 0) rmSync(dir, { recursive: true, force: true });
  }
}

const manifestPath = path.join(targetDir, "package.json");
let manifestCurrent = null;
try {
  manifestCurrent = readFileSync(manifestPath, "utf8");
} catch {
  /* not written yet */
}
if (manifestCurrent !== manifest) {
  if (checkOnly) {
    console.error("node_modules/openclaw/package.json is missing or out of date.");
    process.exit(1);
  }
  mkdirSync(targetDir, { recursive: true });
  writeFileSync(manifestPath, manifest, "utf8");
}

// Structural verification, deliberately not an `import()`.
//
// The alias points at `.ts` files inside `node_modules`, which node refuses to
// type-strip -- by design, since it will not run untrusted TS from there. bun,
// which is what OpenCode actually loads plugins with, has no such rule. So an
// import check would report a working alias as broken under node and a broken one
// as fine under bun, and would tell the user nothing true either way.
//
// What can be checked without a runtime is the whole point of the thing: that
// every alias file exists, re-exports exactly one module, and that module is
// really there. Whether those modules then load is proven by running the plugin,
// not by this script.
const PROBE = "memory-core-host-engine-storage";
const problems = [];
for (const { alias, source } of sources) {
  const out = path.join(targetDir, "plugin-sdk", `${alias}.ts`);
  if (!existsSync(out)) {
    problems.push(`${alias}: alias file missing`);
    continue;
  }
  if (!existsSync(source)) {
    problems.push(`${alias}: source missing at ${path.relative(repoRoot, source)}`);
    continue;
  }
  const body = readFileSync(out, "utf8");
  const expected = relPathToSource(alias);
  if (body.trim() !== `export * from "${expected}";`) {
    problems.push(`${alias}: expected a single re-export of "${expected}"`);
    continue;
  }
  // The re-export has to point at a file, not at a directory or a phantom.
  const resolved = path.resolve(path.dirname(out), expected);
  if (!existsSync(resolved)) problems.push(`${alias}: re-export target "${expected}" does not resolve`);
}
if (!existsSync(path.join(targetDir, "plugin-sdk", `${PROBE}.ts`))) {
  problems.push(`probe module ${PROBE}.ts is not aliased`);
}
if (!existsSync(manifestPath)) problems.push("node_modules/openclaw/package.json is missing");

if (problems.length > 0) {
  console.error(`Alias is broken:\n  ${problems.slice(0, 10).join("\n  ")}`);
  if (problems.length > 10) console.error(`  ...and ${problems.length - 10} more`);
  process.exit(1);
}

if (checkOnly) {
  if (written.length > 0 || stale.length > 0) {
    console.error(
      `Alias is stale: ${written.length} module(s) missing or different, ${stale.length} orphaned. ` +
        `Run: node plugin/scripts/link-openclaw-alias.mjs`,
    );
    process.exit(1);
  }
  console.log(`Alias is current: ${sources.length} modules, all re-exports resolve.`);
} else {
  console.log(
    `Wrote ${sources.length} alias module(s) to ${path.relative(repoRoot, targetDir)} ` +
      `(${written.length} changed, ${stale.length} orphaned removed).`,
  );
  console.log(`Verified: every alias re-exports a file that exists, including ${PROBE}.`);
}