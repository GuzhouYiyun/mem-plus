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

### 源码断裂(非偏离,是裁剪留下的坏引用;2026-10-13 全部闭环)

四条都是逐字搬来的代码**依赖一个被裁掉的邻居**。性质与 `memory_index_state` 缺表相同:
代码本身没搬错,被依赖的文件或 alias 没跟过来,且现有类型门覆盖不到 —— 只有静态
导入扫描能稳定检出,运行时不会触发。

| | 断裂点 | 缺失的依赖 | 处置 |
|---|---|---|---|
| **B1** | `extensions/active-memory/index.ts:47` 导入 `./trigger-recall.js` | `extensions/active-memory/trigger-recall.ts` | **删文件**,理由见下方 |
| **B2** | `packages/memory-host-sdk/src/host/embedding-chunk-limits.ts:4` 导入 `./embeddings.types.js` | `embeddings.types.ts` | **改一行**,理由见下方 |
| **B3** | 同 B2,`embedding-model-limits.ts:1` | 同 B2 | 同 B2 |
| **B4** | `extensions/active-memory/doctor-contract-api.ts:2` 导入 `runtime-doctor-migrations` | 该 alias(`src/plugin-sdk/` 与 `node_modules/openclaw/plugin-sdk/` 均无) | **删文件**,同 B1 |

#### 为什么 B1/B4 是删文件而不是补齐

`extensions/active-memory/` 原有 15 个文件,其中 **13 个(3718 行)不在 `package.json` 的
`files` 里** —— 安装后根本不存在于用户机器。它们是 openclaw 的插件入口与宿主适配层,而
mem-plus 走 OpenCode 的插件系统,永不加载 openclaw 的插件机制;该目录只有 `escalation.ts`
与 `types.ts` 被 `plugin/src/deep-recall.ts` 引用。删除前已核实:13 个文件无人引用,两个存活
文件也不依赖它们。

补齐也编译不过:上游 `trigger-recall.ts` 导出 7 个符号,mem-plus 的
`plugin/src/trigger-recall.ts` 只有 5 个,缺的恰是 index.ts 唯一用到的两个
(`forgetTriggerRecallRun`、`TriggerRecallSource`);两个 `resolveTriggerRecall` 的签名不可
通约(上游收 `cfg/agentId/source/runId/requestKey/authorityFingerprint`,mem-plus 收
`db/message/filters`)。所以这不是"缺东西",是**源码树比发布闭包多了 13 个从不参与运行
的文件**。

#### 为什么 B2/B3 是改一行而不是补文件

`embeddings.types.ts` 是 6 行 re-export,转自 `src/plugins/embedding-provider-types.js`,
而那个文件也被裁掉了 —— 补回来等于用一条断裂换另一条。两个文件只用 `id` 与
`maxInputTokens`,且都已用 `Pick<EmbeddingProvider, "id" | "maxInputTokens">` 收窄,故就地
声明这两个字段,字段名与可选性均照上游。

`enforceEmbeddingMaxInputTokens` 是**活代码**:经
`src/plugin-sdk/memory-core-host-engine-indexing.ts:9` 的 alias 被
`plugin/src/memory-parse.ts` 调用 5 次。它打在这两个坏导入上 —— 类型门覆盖不到
(`tsconfig.plugin.json` 只看 `plugin/`+`extensions/`+`bootstrap`,不含 `packages/`),
运行时又只因类型擦除才没崩。验证:`probe-chunk-limits` 9 项(20 万字符切 98 块、零丢失、
`hardMaxInputTokens` 只能收紧不能放宽)。
