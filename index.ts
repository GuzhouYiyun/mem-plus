// Package entrypoint.
//
// OpenCode resolves a `plugins` directory entry (and every auto-discovered
// plugin package directory under `~/.config/opencode/plugins/`) to
// `<dir>/index.ts`; `package.json`'s `"main"`/`"exports"` only cover
// npm-package installs. Keeping a one-line root entry makes the plugin
// loadable both ways -- as a discovered / path directory and as an
// installed package -- without moving the implementation out of
// `plugin/src/`.
//
// The bootstrap import runs first (ESM evaluates imports in order): it
// self-heals the generated `node_modules/openclaw` alias and the
// `@openclaw/*` stub packages when they are missing, so that the re-export
// below and its whole module graph can resolve.
import "./bootstrap.js";
export { default } from "./plugin/src/index.js";
