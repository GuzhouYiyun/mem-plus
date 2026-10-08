// Start the memory browser against the REAL environment: real index, real settings
// file (created by the same resolution the plugin does on load), and the real model
// list read from `opencode models`.
//
// The plugin is not loaded -- the live zone is empty -- so `ctx.model.list()` is not
// available to call. Shelling out to the CLI reads the same catalogue OpenCode
// resolved from the user's providers, which makes the preview honest instead of
// showing three made-up models.
import { execFileSync } from "node:child_process";

const { resolveOptions } = await import("../plugin/src/config-file.ts");
const { stateRoot } = await import("../plugin/src/paths.ts");

const settings = resolveOptions(undefined, stateRoot());
console.log("[settings]", settings.file, "hasFile=" + settings.hasFile);

let catalogue = [];
try {
  const out = execFileSync("opencode", ["models"], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  catalogue = out
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.includes("/"))
    .map((line) => {
      const slash = line.indexOf("/");
      const providerID = line.slice(0, slash);
      const modelID = line.slice(slash + 1);
      return {
        providerID,
        modelID,
        // `opencode models` prints ids only, so the label is the id. The real
        // `ctx.model.list()` also carries `name`; this preview just does not have it.
        name: modelID,
        enabled: true,
        status: "active",
      };
    });
} catch (error) {
  console.log("[models] could not read `opencode models`:", error instanceof Error ? error.message : error);
}
console.log(`[models] ${catalogue.length} models`);

const { openIndex } = await import("../plugin/src/memory-index.ts");
const { startWebServer } = await import("../plugin/src/web/server.ts");
const { readWebConfig } = await import("../plugin/src/web/config.ts");

const db = openIndex();
const handle = await startWebServer(
  readWebConfig({}),
  { db, workspaceDir: process.cwd(), listModels: async () => ({ location: {}, data: catalogue }) },
  (message) => console.log("[mem-plus:web]", message)
);
console.log("url", handle.url);