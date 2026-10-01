// Package entrypoint.
//
// OpenCode resolves a `plugins` array directory entry to `<dir>/index.ts`; the
// publish docs' `"exports": { ".": "./src/index.ts" }` covers npm-package installs,
// but a path entry never reads `exports`. Keeping a one-line root entry makes the
// plugin loadable both ways -- as `plugins: ["./path/to/plugin"]` and as an
// installed package -- without moving the implementation out of `src/`.
export { default } from "./src/index.js";
