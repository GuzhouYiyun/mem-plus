// 引导注入来源门探针(openclaw PR #189727 的移植)。动机:来源被棘轮降级为
// untrusted 的 curated 根文件(MEMORY.md)不得进系统提示;分类器故障时要放行,
// 且两种警告各只报一次(上下文钩子每次模型请求都会跑)。探针量的是:无记录放行、
// agent 链放行、降级拦截且警告唯一、故障放行且警告唯一。
// 运行:node scripts/probe-bootstrap-gate.mjs
// 打包走 esbuild 直驱;XDG_CONFIG_HOME 与状态库都在临时目录,不碰活区。
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUILD = mkdtempSync(path.join(tmpdir(), "gate-build-"));
const OUT = path.join(BUILD, "gate.mjs");
const ENTRY = path.join(HERE, "probe-bootstrap-gate.entry.ts");

execSync(
  `npx -y esbuild "${ENTRY}" --bundle --format=esm --platform=node ` +
    `--main-fields=module,main --outfile="${OUT}" ` +
    `--banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);"`,
  { stdio: "inherit" },
);

// 日志器在加载时从 XDG_CONFIG_HOME 解析路径,必须在 import 之前重定向。
process.env["XDG_CONFIG_HOME"] = mkdtempSync(path.join(tmpdir(), "gate-cfg-"));
const mod = await import(pathToFileURL(OUT).href);
await mod.done;
rmSync(BUILD, { recursive: true, force: true });
