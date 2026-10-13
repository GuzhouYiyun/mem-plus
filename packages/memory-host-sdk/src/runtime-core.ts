// Focused runtime contract for memory plugin config/state/helpers.
//
// TWO HOST-SEAM MODULES DROPPED, AND WHY
//   `./host/openclaw-runtime-config.js` and `./host/openclaw-runtime-memory.js` were
//   the two facades that re-exported openclaw's `src/config/*` and `src/plugins/*`
//   into the SDK. Both had already lost their targets to the trim, so both imported
//   specifiers that resolve to nothing in this tree:
//
//     openclaw-runtime-config.ts  -> src/config/types.openclaw.js, src/config/types.memory.js
//     openclaw-runtime-memory.ts  -> src/plugins/memory-embedding-providers.js
//
//   They were removed with their ten re-exports below rather than restored. Restoring
//   them would have meant also vendoring `src/config/types.openclaw.ts` and
//   `src/plugins/memory-embedding-providers.ts`, i.e. pulling openclaw's config and
//   provider layers back in for symbols nothing reads. Every symbol that came through
//   the two facades was checked against `plugin/src/**` and `extensions/**` first and
//   had zero uses there, so the re-exports were already unreachable from live code.
//
//   `SILENT_REPLY_TOKEN` is deliberately NOT one of them: `flush-config.ts` uses it,
//   and it reaches here through `./host/openclaw-runtime-session.js` (line 14), which
//   is a different module with its own working seam.
export type { AnyAgentTool } from "./host/openclaw-runtime-agent.js";
export { resolveCronStyleNow } from "./host/openclaw-runtime-agent.js";
export { DEFAULT_AGENT_COMPACTION_RESERVE_TOKENS_FLOOR } from "./host/openclaw-runtime-agent.js";
export { resolveDefaultAgentId, resolveSessionAgentId } from "./host/openclaw-runtime-agent.js";
export { resolveMemorySearchConfig } from "./host/openclaw-runtime-agent.js";
export {
  asToolParamsRecord,
  jsonResult,
  readNumberParam,
  readStringParam,
} from "./host/openclaw-runtime-agent.js";
export { SILENT_REPLY_TOKEN } from "./host/openclaw-runtime-session.js";
export {
  getRuntimeConfig,
  /** @deprecated Use getRuntimeConfig(), or pass the already loaded config through the call path. */
  loadConfig,
} from "./host/openclaw-runtime-session.js";
export { parseAgentSessionKey } from "./host/openclaw-runtime-agent.js";