// Measure how far this tree has drifted from a chosen openclaw snapshot, file by file.
//
// Why this exists: the port's rule is "copy what openclaw has; only the seams may differ", and
// that rule is unmeasurable by reading. It became unmeasurable in practice because the reference
// kept moving. The memory subsystem was imported on 2026-09-30 (`df09d576`); the local openclaw
// checkout sat at 2026-10-08; upstream's real HEAD for those files is later still. A diff taken
// against the checkout therefore mixes three different things -- upstream's own work, our work,
// and the checkout's own staleness -- and cannot be read as "our drift". This script fixes the
// reference to an explicit commit and reports only the last of those three.
//
// How it judges: a git blob SHA is a hash of the exact bytes, so comparing SHA-to-SHA is a
// byte-exact verdict that needs no content download. One `gh api` call gets the whole upstream
// tree; nothing else touches the network. Verified against files already known byte-identical
// (`src/plugin-sdk/memory-core-host-engine-sessions.ts`, `extensions/active-memory/types.ts`,
// `extensions/memory-core/src/memory-forget-content.ts`) so a normalization mismatch between the
// two repos would have shown up as a false "differs".
//
// Ranking is by real divergence (`--numstat` added+removed), not by file size: the largest
// memory-path file is only +2/-2 lines against the snapshot, and a 33 KB file can differ by one
// line. Ranking by size would send the work to the wrong files.
//
// Not shipped: a measurement tool, not part of the package.

import { readFileSync, existsSync, statSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// The commit the memory subsystem was imported from: the last upstream commit of 2026-09-30.
const IMPORT_REF = "6daee6e4bd58a525ac6c958ad885d1431bda26e3";

const USAGE = `Usage: node scripts/audit-upstream-drift.mjs [options]

  --ref <sha>       upstream commit to compare against (default: ${IMPORT_REF}, 2026-09-30)
  --scope <regex>   only paths matching this (default: the memory paths)
  --stage <dir>     write each differing upstream file here for content diffing
  --all             include every path, not just the ones the import touched
  --json <file>     write the machine-readable result
`;

// The memory paths: the subsystems this repo exists to carry, plus the plugin-sdk facades they
// import through. The session layer under src/config is deliberately out of scope -- see
// docs/port-plan.md, "为什么不能直接跳到 10-08 或 HEAD".
const DEFAULT_SCOPE =
  "^(extensions/(memory-core|memory-wiki|memory-lancedb|active-memory)|packages/memory-host-sdk|src/memory|src/memory-host-sdk|src/plugin-sdk)";

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

if (flag("--help")) {
  process.stdout.write(USAGE);
  process.exit(0);
}

const ref = value("--ref", IMPORT_REF);
const scope = new RegExp(value("--scope", DEFAULT_SCOPE));
const stageDir = value("--stage", undefined);
const jsonOut = value("--json", undefined);

const git = (args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 1 << 28 });

const lsTree = (rev) => {
  const out = new Map();
  for (const line of git(["ls-tree", "-r", rev]).split("\n")) {
    const m = /^(\d{6}) blob ([0-9a-f]{40})\t(.+)$/.exec(line);
    if (m) out.set(m[3], m[2]);
  }
  return out;
};

const gh = (args) => JSON.parse(execFileSync("gh", args, { encoding: "utf8", maxBuffer: 1 << 30 }));

// --- upstream tree at the reference commit
process.stderr.write(`fetching openclaw tree at ${ref.slice(0, 10)} ...\n`);
const tree = gh(["api", `repos/openclaw/openclaw/git/trees/${ref}?recursive=1`]);
if (tree.truncated) {
  process.stderr.write("upstream tree came back truncated; the counts below would be wrong\n");
  process.exit(1);
}
const upstream = new Map(tree.tree.filter((e) => e.type === "blob").map((e) => [e.path, e.sha]));

const atHead = lsTree("HEAD");
const atImport = lsTree("df09d576");

// --- which local paths are in scope
const localPaths = [...atHead.keys()].filter((p) => scope.test(p));
const codePaths = localPaths.filter((p) => /\.(ts|mts|tsx|mjs|js)$/.test(p));

// --- byte-exact verdicts
const differs = [];
const upstreamOnly = [];
for (const p of localPaths) {
  if (!upstream.has(p)) continue;
  if (atHead.get(p) !== upstream.get(p)) differs.push(p);
}
// Upstream has the path and we do not: a file never vendored. Mostly tests, which this repo
// deliberately does not ship -- reported, never treated as drift to fix.
for (const p of upstream.keys()) {
  if (!atHead.has(p) && scope.test(p) && /\.(ts|mts|tsx|mjs|js)$/.test(p)) upstreamOnly.push(p);
}

if (stageDir) rmSync(stageDir, { recursive: true, force: true });

const rows = [];
for (const p of differs.filter((x) => /\.(ts|mts|tsx|mjs|js)$/.test(x) && existsSync(path.join(root, x)))) {
  const local = path.join(root, p);
  const localSize = statSync(local).size;
  let upSize = 0;
  if (stageDir) {
    const out = path.join(stageDir, p);
    mkdirSync(path.dirname(out), { recursive: true });
    const content = gh(["api", `repos/openclaw/openclaw/contents/${p}?ref=${ref}`]).content;
    writeFileSync(out, Buffer.from(content.replace(/\n/g, ""), "base64"));
    upSize = statSync(out).size;
  }
  rows.push({ path: p, localSize, upSize, added: null, removed: null });
}

// --numstat: `git diff --no-index` exits 1 when the files differ, and execFileSync throws on a
// non-zero exit, so the numbers have to come off the exception's stdout.
const numstat = (a, b) => {
  let out = "";
  try {
    out = execFileSync("git", ["diff", "--no-index", "-U0", "--numstat", a, b], {
      encoding: "utf8",
      maxBuffer: 1 << 28,
      cwd: root,
    });
  } catch (e) {
    out = String(e.stdout ?? "");
  }
  const line = out.split("\n").find((l) => /^\d+\t\d+\t/.test(l));
  if (!line) return [0, 0];
  const [add, del] = line.split("\t");
  return [Number(add), Number(del)];
};

for (const row of rows) {
  const up = stageDir ? path.join(stageDir, row.path) : null;
  if (up && existsSync(up)) {
    const [add, del] = numstat(up, path.join(root, row.path));
    row.added = add;
    row.removed = del;
  }
}

rows.sort((a, b) => (b.added ?? 0) + (b.removed ?? 0) - ((a.added ?? 0) + (a.removed ?? 0)));

const totalAdd = rows.reduce((s, r) => s + (r.added ?? 0), 0);
const totalDel = rows.reduce((s, r) => s + (r.removed ?? 0), 0);

const lines = [];
lines.push(`reference: openclaw@${ref.slice(0, 10)}`);
lines.push(`scope: ${scope.source}`);
lines.push(
  `local paths in scope: ${localPaths.length}   byte-identical to upstream: ${localPaths.length - differs.length}   differing: ${differs.length}`,
);
lines.push(`upstream has, this tree does not (mostly tests, deliberately not vendored): ${upstreamOnly.length}`);
if (rows.some((r) => r.added === null)) {
  lines.push("(line counts unavailable: pass --stage <dir> to fetch upstream bytes)");
} else {
  lines.push(`total divergence: +${totalAdd} / -${totalDel} lines across ${rows.length} files`);
}
lines.push("");
lines.push("    +line   -line   local  upstream  path");
for (const r of rows) {
  if ((r.added ?? 0) + (r.removed ?? 0) === 0 && !stageDir) continue;
  lines.push(
    `  ${String(r.added ?? "?").padStart(6)} ${String(r.removed ?? "?").padStart(6)} ${String(r.localSize).padStart(8)} ${String(r.upSize || "?").padStart(9)}  ${r.path}`,
  );
}
process.stdout.write(`${lines.join("\n")}\n`);

if (jsonOut) {
  writeFileSync(jsonOut, JSON.stringify({ ref, rows, upstreamOnly, differs }, null, 1));
  process.stderr.write(`wrote ${jsonOut}\n`);
}