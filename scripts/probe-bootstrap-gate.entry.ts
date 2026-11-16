// Bootstrap provenance gate probe, entry (bundled by probe-bootstrap-gate.mjs).
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  configureMemoryCoreDreamingState,
  type MemoryCoreOpenKeyedStore,
} from "../extensions/memory-core/src/dreaming-state.js";
import { recordMemoryArtifactWriteProvenance } from "../plugin/src/memory-artifact-provenance.js";
import { isHomeMemoryInjectionAllowed } from "../plugin/src/bootstrap-context.js";

// In-memory keyed store standing in for ctx.storage.
const map = new Map<string, unknown>();
let failStore = false;
const fakeStore = (options: { namespace: string }) => ({
  async lookup(key: string) {
    if (failStore) throw new Error("state store unavailable (probe)");
    return map.get(`${options.namespace}:${key}`);
  },
  async update(key: string, fn: (current: unknown) => unknown) {
    if (failStore) throw new Error("state store unavailable (probe)");
    const k = `${options.namespace}:${key}`;
    const next = await fn(map.get(k));
    if (next === undefined) map.delete(k);
    else map.set(k, next);
  },
  async deleteIf(key: string, pred: (current: unknown) => boolean) {
    if (failStore) throw new Error("state store unavailable (probe)");
    const k = `${options.namespace}:${key}`;
    const current = map.get(k);
    if (current !== undefined && (await pred(current))) {
      map.delete(k);
      return true;
    }
    return false;
  },
});
configureMemoryCoreDreamingState(fakeStore as unknown as MemoryCoreOpenKeyedStore);

const warnings: string[] = [];
const log = (message: string) => {
  warnings.push(message);
};

let failures = 0;
function check(name: string, condition: boolean): void {
  console.log(`${condition ? "ok  " : "FAIL"} ${name}`);
  if (!condition) failures += 1;
}

const tmp = mkdtempSync(path.join(os.tmpdir(), "gate-probe-"));
const homeA = path.join(tmp, "home-a");
const homeB = path.join(tmp, "home-b");
mkdirSync(homeA, { recursive: true });
mkdirSync(homeB, { recursive: true });
const memoryA = path.join(homeA, "MEMORY.md");
const memoryB = path.join(homeB, "MEMORY.md");
writeFileSync(memoryA, "v1", "utf8");
writeFileSync(memoryB, "quarantined", "utf8");

const expectWarning =
  "excluding MEMORY.md from automatic memory context: memory provenance is untrusted";

const main = async () => {
  // 1. No provenance record at all: default stays eligible, no warning.
  const first = await isHomeMemoryInjectionAllowed({
    absolutePath: memoryA,
    memoryHome: homeA,
    log,
  });
  check("no record: injected", first === true);
  check("no record: silent", warnings.length === 0);

  // 2. An intact agent-owned chain stays eligible.
  await recordMemoryArtifactWriteProvenance({
    workspaceDir: homeA,
    relativePath: "MEMORY.md",
    contentBefore: "",
    contentAfter: "v1",
    originClass: "agent",
    observedAt: Date.now(),
  });
  const second = await isHomeMemoryInjectionAllowed({
    absolutePath: memoryA,
    memoryHome: homeA,
    log,
  });
  check("agent chain: injected", second === true);
  check("agent chain: silent", warnings.length === 0);

  // 3. A human edit breaks the chain: the next record ratchets to untrusted,
  //    the gate excludes, and the warning fires once across repeated calls.
  await recordMemoryArtifactWriteProvenance({
    workspaceDir: homeA,
    relativePath: "MEMORY.md",
    contentBefore: "human edit in between",
    contentAfter: "v1 + human edit",
    originClass: "agent",
    observedAt: Date.now(),
  });
  const third = await isHomeMemoryInjectionAllowed({
    absolutePath: memoryA,
    memoryHome: homeA,
    log,
  });
  const fourth = await isHomeMemoryInjectionAllowed({
    absolutePath: memoryA,
    memoryHome: homeA,
    log,
  });
  check("ratchet: excluded", third === false && fourth === false);
  check(
    "ratchet: exactly one warning",
    warnings.length === 1 && warnings[0] === expectWarning,
  );

  // 4. Classifier error fails open (inject) with one warning, not per request.
  failStore = true;
  const fifth = await isHomeMemoryInjectionAllowed({
    absolutePath: memoryB,
    memoryHome: homeB,
    log,
  });
  const sixth = await isHomeMemoryInjectionAllowed({
    absolutePath: memoryB,
    memoryHome: homeB,
    log,
  });
  failStore = false;
  check("unavailable: injected", fifth === true && sixth === true);
  check(
    "unavailable: exactly one warning",
    warnings.filter((w) => w.includes("classification unavailable")).length === 1,
  );
  check(
    "total warnings: 2",
    warnings.length === 2,
  );

  if (failures > 0) {
    console.error(`${failures} check(s) failed`);
    process.exitCode = 1;
  } else {
    console.log("all checks passed");
  }
  // The state store and classifier hold no other process state; temp files
  // clean themselves up with the OS temp sweep.
};

export const done = main();
