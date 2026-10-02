// Package entrypoint.
//
// OpenCode resolves a `plugins` directory entry (and every auto-discovered
// plugin package directory under `~/.config/opencode/plugins/`) to
// `<dir>/index.ts`; `package.json`'s `"main"`/`"exports"` only cover
// npm-package installs. Keeping a one-line root entry makes the plugin
// loadable both ways -- as a discovered / path directory and as an
// installed package -- without moving the implementation out of
// `plugin/src/`.
export { default } from "./plugin/src/index.js";
