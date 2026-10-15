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
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// The commit the memory subsystem was imported from: the last upstream commit of 2026-09-30.
const IMPORT_REF = "6daee6e4bd58a525ac6c958ad885d1431bda26e3";

const USAGE = `Usage: node scripts/audit-upstream-drift.mjs [options]

  --ref <sha>           upstream commit to compare against (default: ${IMPORT_REF}, 2026-09-30)
  --scope <regex>       only paths matching this (default: the memory paths)
  --stage <dir>         write each differing upstream file here for content diffing
  --all                 include every path, not just the ones the import touched
  --json <file>         write the machine-readable result
  --opencode-mem <dir>  also compare the files ported from this checkout
  --no-opencode-mem     skip that second reference tree
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

// --- second reference tree: opencode-mem
//
// Twenty files in this tree name opencode-mem in their header as the project they were ported
// from. openclaw is a different codebase with a different layout, so none of them has an
// openclaw counterpart at ANY path: against `--ref` they fall into "NO upstream counterpart",
// which reads like an omission and is not one. Without this section the memory *write* path is
// the one part of the tree the drift measure cannot see at all, and five of the twenty are the
// web surface.
//
// Blob SHAs are content-only -- `git hash-object` hashes "blob <len>\0<content>" -- so a SHA
// comparison is valid ACROSS repositories. There is no line-ending or normalisation question to
// disagree about, which is the only reason this works without vendoring anything.
//
// The map is explicit and deliberately partial. An entry is admitted only where the file's own
// header names the opencode-mem file it came from; several were checked path by path for that.
// Where a header names the project but not the file -- "ported from opencode-mem's `user_prompts`
// table", "ported from the opencode-mem ingestion pipeline" -- the file is reported as UNPINNED
// rather than matched to whatever path looks plausible. A guessed counterpart would be exactly
// the unmeasured claim this tool exists to refuse, and it would report "differs" or "identical"
// about a comparison nobody chose.
const OPENCODE_MEM_MAP = {
  "extensions/memory-core/src/capture/constants.ts": "src/services/auto-capture.ts",
  "extensions/memory-core/src/capture/context-limit.ts": "src/utils/context-limit.ts",
  "extensions/memory-core/src/capture/context.ts": "src/services/auto-capture.ts",
  "extensions/memory-core/src/capture/extract.ts": "src/services/auto-capture.ts",
  "extensions/memory-core/src/capture/language.ts": "src/services/language-detector.ts",
  "extensions/memory-core/src/capture/pipeline.ts": "src/services/auto-capture.ts",
  "plugin/src/event-compat.ts": "src/v2/adapter.ts",
  "plugin/src/recall-inject.ts": "src/v2/adapter.ts",
  "plugin/src/web/auth-token.ts": "src/services/auth-token.ts",
  "plugin/src/web/auth.ts": "src/services/web-auth.ts",
};

// The other ten files that name opencode-mem. Kept as a list so the report can say "declared but
// not pinned" with the names attached, which is the actionable part: each one is a decision
// waiting to be made, not a gap to be forgotten.
const OPENCODE_MEM_UNPINNED = [
  "extensions/memory-core/src/capture/index.ts",
  "extensions/memory-core/src/capture/landing.ts",
  "extensions/memory-core/src/capture/render.ts",
  "extensions/memory-core/src/capture/types.ts",
  "extensions/memory-core/src/standing-intents.ts",
  "plugin/src/config-file.ts",
  "plugin/src/model/config.ts",
  "plugin/src/web/config-file.ts",
  "plugin/src/web/config.ts",
  "plugin/src/web/server.ts",
];

const opencodeMemDefault = path.join(root, "..", "opencode-mem");
const opencodeMemFlag = flag("--no-opencode-mem")
  ? undefined
  : value("--opencode-mem", existsSync(opencodeMemDefault) ? opencodeMemDefault : undefined);

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
// A local path with NO upstream counterpart at this ref. It must never be counted as
// byte-identical: there is nothing to compare against, so "identical" would be a claim
// about a comparison that never ran. Measured on 2026-10-15 with `--scope deep-recall`:
// `plugin/src/deep-recall.ts` has no upstream path at all, and the summary printed
// "byte-identical to upstream: 1". Reported as its own category so a reader can see which
// files were actually compared.
const localOnly = [];
for (const p of localPaths) {
  if (!upstream.has(p)) {
    localOnly.push(p);
    continue;
  }
  if (atHead.get(p) !== upstream.get(p)) differs.push(p);
}
const compared = localPaths.length - localOnly.length;
// Upstream has the path and we do not: a file never vendored. Mostly tests, which this repo
// deliberately does not ship -- reported, never treated as drift to fix.
for (const p of upstream.keys()) {
  if (!atHead.has(p) && scope.test(p) && /\.(ts|mts|tsx|mjs|js)$/.test(p)) upstreamOnly.push(p);
}

if (stageDir) rmSync(stageDir, { recursive: true, force: true });

// --- second reference tree: opencode-mem, compared by blob SHA
//
// The checkout does not have to be a git repository -- this one is a plain directory copy, and
// requiring `.git` would have made the whole section silently skip. Blob SHAs are computed here
// with node:crypto rather than `git hash-object`, because two candidates have to be tried per
// file (raw bytes and LF-normalised) to survive a CRLF working tree, and a subprocess per file
// per variant is the wrong shape for that. The implementation is checked against git itself on
// a file this repo tracks, so "my SHA is wrong" cannot hide behind a real difference.
const om = {
  enabled: false,
  dir: undefined,
  identical: [],
  differing: [],
  unresolvable: [],
  unpinned: OPENCODE_MEM_UNPINNED,
  selfCheck: "not run",
};

// git stores "blob <byte length>\0<content>", length in bytes, hashed as SHA-1.
const blobSha = (buf) => {
  const header = Buffer.from(`blob ${buf.length}\0`, "latin1");
  return createHash("sha1").update(header).update(buf).digest("hex");
};

if (opencodeMemFlag) {
  om.dir = path.resolve(opencodeMemFlag);
  if (!existsSync(om.dir)) {
    process.stderr.write(`opencode-mem: nothing at ${om.dir}; that reference tree is skipped\n`);
  } else {
    om.enabled = true;
    // Self-check against git on a path this repository tracks. It compares the LF-normalised
    // form on purpose: `readFileSync` hands back the working-tree bytes, which on Windows carry
    // CRLF, while `atHead` holds the blob git committed -- so hashing the raw buffer would
    // mismatch and would make every file below look different. Hashing the normalised bytes is
    // also exactly what the comparison does to the opencode-mem side, so the check exercises
    // the real code path rather than a friendlier one.
    const probe = "extensions/memory-core/src/standing-intents.ts";
    const probeBytes = readFileSync(path.join(root, probe));
    const probeLf = blobSha(Buffer.from(probeBytes.toString("utf8").replace(/\r\n/g, "\n"), "utf8"));
    const probeRaw = blobSha(probeBytes);
    const gitSha = atHead.get(probe);
    om.selfCheck =
      probeLf === gitSha
        ? `ok (${probe.slice(-18)} LF-normalised == git's blob)`
        : probeRaw === gitSha
          ? `ok but this working tree is LF (raw matched)`
          : `MISMATCH ${probeLf} / ${probeRaw} vs git ${gitSha}`;
    if (probeLf !== gitSha && probeRaw !== gitSha) {
      process.stderr.write(`opencode-mem: blob hashing self-check failed; section is not trustworthy\n`);
    }

    for (const [local, source] of Object.entries(OPENCODE_MEM_MAP)) {
      const sourceFile = path.join(om.dir, source);
      if (!existsSync(sourceFile)) { om.unresolvable.push(`${local} -> ${source} (absent from that checkout)`); continue; }
      if (!atHead.has(local)) { om.unresolvable.push(`${local} (not in this tree)`); continue; }
      const raw = readFileSync(sourceFile);
      const rawSha = blobSha(raw);
      const lfSha = blobSha(Buffer.from(raw.toString("utf8").replace(/\r\n/g, "\n"), "utf8"));
      const localSha = atHead.get(local);
      if (localSha === rawSha || localSha === lfSha) {
        om.identical.push(local);
      } else {
        om.differing.push({
          path: local,
          source,
          bytes: statSync(path.join(root, local)).size,
          sourceBytes: raw.length,
          crlf: rawSha !== lfSha,
        });
      }
    }
  }
}

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
  `local paths in scope: ${localPaths.length}   compared against upstream: ${compared}   byte-identical: ${compared - differs.length}   differing: ${differs.length}`,
);
lines.push(
  `NO upstream counterpart (never compared, not counted as identical): ${localOnly.length}` +
    (localOnly.length ? ` -- ${localOnly.slice(0, 6).join(", ")}${localOnly.length > 6 ? ", ..." : ""}` : ""),
);
lines.push(`upstream has, this tree does not (mostly tests, deliberately not vendored): ${upstreamOnly.length}`);

// The second reference tree. It gets its own block because its categories mean something
// different: every file in it is one this project DID take from somewhere and rewrote, so
// "differs" there is the expected state, not an accusation -- what matters is that the file is
// now visible at all instead of sitting in the openclaw "no counterpart" bucket unexplained.
lines.push("");
if (om.enabled) {
  lines.push(`second reference: opencode-mem (${om.dir}) -- blob hashing self-check vs git: ${om.selfCheck}`);
  lines.push(
    `declared ported from opencode-mem: ${Object.keys(OPENCODE_MEM_MAP).length + om.unpinned.length}` +
      `   pinned to a named file: ${Object.keys(OPENCODE_MEM_MAP).length}` +
      `   byte-identical: ${om.identical.length}   differing: ${om.differing.length}`,
  );
  if (om.unresolvable.length) {
    lines.push(`  UNRESOLVABLE (mapping points at nothing): ${om.unresolvable.length} -- ${om.unresolvable.join(", ")}`);
  }
  for (const r of om.differing) {
    lines.push(
      `    ${String(r.bytes).padStart(8)} / ${String(r.sourceBytes).padStart(8)} B  ${r.path}  <-  ${r.source}${r.crlf ? "  [source is CRLF]" : ""}`,
    );
  }
  lines.push(
    `  DECLARED BUT NOT PINNED (header names the project, not the file; deliberately not guessed): ${om.unpinned.length}`,
  );
  for (const p of om.unpinned) lines.push(`    ${p}`);
} else if (opencodeMemFlag) {
  lines.push(`second reference: opencode-mem -- SKIPPED, no checkout at ${opencodeMemFlag}`);
} else {
  lines.push("second reference: opencode-mem -- not consulted (--no-opencode-mem)");
}
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
  writeFileSync(
    jsonOut,
    JSON.stringify(
      {
        ref,
        rows,
        upstreamOnly,
        differs,
        localOnly,
        opencodeMem: {
          enabled: om.enabled,
          dir: om.dir,
          selfCheck: om.selfCheck,
          map: OPENCODE_MEM_MAP,
          identical: om.identical,
          differing: om.differing,
          unresolvable: om.unresolvable,
          unpinned: om.unpinned,
        },
      },
      null,
      1,
    ),
  );
  process.stderr.write(`wrote ${jsonOut}\n`);
}