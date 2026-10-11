# 裁剪:只留记忆功能(2026-10-11)

用户指令:把仓库裁到只剩记忆功能,剔除 openclaw 自己的功能与宿主适配。
范围定义 = `docs/memory-chain.md` 的行为清单;每条偏离在此登记,可对照原版比较。
**验收 = 两个类型门 0 错 + `audit-npm-pack --check` + 安装后 OpenCode 日志读到
`plugin loaded`。类型门绿了但没走失败路径的不算数。**

## 保留(记忆本体)

| 路径 | 内容 | 处置 |
|---|---|---|
| `plugin/` | 宿主适配层(事件挂钩、索引、web 浏览器、serve/) | 保留;直接 import 的 vendored 叶子改本地实现(S2) |
| `extensions/memory-core/` | capture/dreaming/promotion/provenance/standing intents | 保留,逐字不动 |
| `extensions/active-memory/` | Lane 2 深度召回 | 保留,逐字不动 |
| `packages/memory-host-sdk/` | host/ 纯实现(types、curated-annotations、FTS 解析) | 保留纯实现;`openclaw-runtime-*` 10 个适配器改写为最小本地实现(S4) |
| `packages/normalization-core`、`markdown-core`、`retry` | 纯工具包,无 openclaw 功能 | 原样保留 |
| `packages/media-core`(5 文件) | mime 工具,被 memory-host-sdk 用到 | 原样保留(工具非功能) |
| 根 `index.ts` / `bootstrap.ts` / `*.mjs` shim | 入口 | bootstrap 改写(S5) |

## 删除(openclaw 自己的功能)

`src/` 全部,例外是 `src/plugin-sdk/` 目录:其中被记忆引用的 ~40 个模块**就地改写**为
最小实现(保持路径与导出名,切断对 `src/state|infra|config|plugins|sessions|…` 的
re-export);其余(42 个可达之外的、以及 plugin-sdk 里记忆不用的)删除。
`packages/{ai,llm-core,agent-core,gateway-protocol,gateway-client,model-catalog-core,
session-url-contract,net-policy,terminal-core,tool-call-repair,acp-core,
plugin-package-contract}` 全删。`node_modules/openclaw`(42 别名模块)+
`@openclaw/*`(8 桩)+ 生成脚本 `plugin/scripts/link-openclaw-alias.mjs` 删除——
改写后的 plugin-sdk 不再需要它们。

## 阶段

- **S1 计划**(本文件)+ 基线提交 ✅
- **S2 插件叶子本地化**:plugin 直接 import 的 7 个 vendored 叶子
  (`workspace.ts`、`workspace-bootstrap-policy.ts`、`embedded-agent-helpers/bootstrap.ts`、
  `system-prompt-context-files.ts`、`infra/path-guards.ts`、`infra/errno.ts`、
  `auto-reply/tokens.ts`)→ 提取进 `plugin/src/`,逐函数照抄,注明来源;改 plugin import。
- **S3 plugin-sdk 改写**:`src/plugin-sdk/*` 被记忆引用的模块改为最小实现,只依赖
  node 内建 + 保留的 packages;删其余全部 src/。
- **S4 openclaw-runtime 适配器改写**:`packages/memory-host-sdk/src/host/
  openclaw-runtime-*.ts` 10 个文件改为最小实现(路径/配置从 env 或显参,会话转录源
  结构性 null——与 memory-chain §1 一致:mem-plus 无 openclaw 会话存储)。
- **S5 根层清理**:bootstrap.ts、package.json 依赖(删 openai/anthropic/google/typebox
  /kysely/ws/undici/… 等非闭包依赖,保留 @opencode/plugin、node-llama-cpp、yaml、
  jsonc-parser、p-limit、p-map、mdast 系、typebox?)、tsconfig paths、audit-npm-pack
  闭包重算、链接脚本删除。
- **S6 门**:`tsc plugin` + `tsc capture` 0 错;`node --check serve`;audit;
  临时 bun 加载冒烟;安装 + `plugin loaded` 日志(最终门)。

## 偏离登记(执行中逐条追加)

每条格式:`[D<n>] 上游行为 → 裁剪后行为(文件, 理由, memory-chain 章节对照)`。
