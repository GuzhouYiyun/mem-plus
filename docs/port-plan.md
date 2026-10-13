# 计划:剥出 openclaw 的记忆子系统,插入 OpenCode(2026-10-13)

## 目的(用户原话校准,2026-10-13)

> 把 openclaw 的记忆插件拔下来装在 opencode 上。不是原封不动 —— 对 openclaw 来说这个
> 记忆是它**体内的一个部件,融合在一起了**。我们做的是**把它剥干净,然后插入 opencode**。

这修正了此前"整体照搬"的说法。三条判据:

1. **逻辑、行为、常量、schema 都是 openclaw 的。** 能逐字节抄就逐字节抄;抄不进来的
   写出理由。
2. **自己写的代码只允许是接缝。** OpenCode 的插件钩子、文件路径、会话读写、模型调用、
   配置、SQLite 运行时 —— 这些位置写适配层,除此之外不该有自己的实现。
3. **任何一段行为都能指到出处**:openclaw 哪个文件哪一行,或者"这是接缝所以必须自己写"。

**"剥"的单位不是文件,是接缝。** 每一处 import、每一次调用都要判:记忆逻辑(搬)还是
openclaw 躯干(换掉)。同一个文件里两种都有 —— `recall.ts` 里"该不该召回"是记忆逻辑,
"怎么开子会话、怎么读 transcript"是躯干。所以转接头不是一个顶层薄层,而是分散在搬进来
的代码里的很多小接缝,每个接缝一个。

## 现状与目的相反(2026-10-13 实测)

mem-plus 今天的形状是**上面一层薄适配、底下一整套平行实现**:

| | 实测 |
|---|---|
| 记忆子系统生产文件(openclaw 侧) | 308 |
| 其中逐字节等于上游的文件 | **37** / 194 |
| `plugin/src/memory-index.ts` | 1120 行自创,openclaw 无同名文件 |
| `plugin/src/deep-recall.ts` | 25 KB 自创,顶替上游 `extensions/active-memory/` 17 文件 184 KB,原件已被删 |
| `extensions/active-memory/` | 只剩 2 个文件(`escalation.ts`/`types.ts`,均逐字节等于上游),且是 `files` 里唯二被手工加进去的 |

自创的部分在下面,转接头混在上面某一层 —— 与判据 2 相反。

## 接缝地图(2026-10-13 实测,308 个生产文件的外部 import)

**174 个不同的外部模块。** 这是转接头工作量的真实规模,此前一直低估。

### E 类:纯工具库(~12 个)—— 不需要接缝,原样抄

`@openclaw/normalization-core` 8 个子路径(agent-id / cjk-chars / error-coercion /
node-crypto / number-coercion / record-coerce / string-coerce / utf16-slice)、
`@openclaw/fs-safe` 4 个、`@openclaw/media-core/mime`、`@openclaw/retry`、
`p-limit`、`p-map`、`typebox`。

### D 类:plugin-sdk 门面(约 60 个)

多数是 A/B/C 三类在 plugin-sdk 上的转发。其中 `memory-core-host-engine-*`(foundation /
schema / indexing / storage / curated / embeddings / knn / fs / sessions)、
`memory-host-search`、`memory-host-markdown`、`memory-host-core` —— **这些是记忆本身,
不是躯干**,属于"原封不动"的部分。

### A 类:openclaw 配置系统(~35 个)

`config/config`、`config/paths`、`config/state-dir`、`config/types.memory`、
`config/types.openclaw`、`config/types.secrets`、`config/types.tools`、
`config/sessions/*`(11 个:accessor / paths / archive-compression / artifacts /
main-session / session-accessor / session-canonical-key / session-cold-storage-read /
session-cold-storage-state / session-history / session-incognito-binding /
transcript-target-binding)、`config/byte-size`、`config/config-env-vars`、
`plugins/config-schema`、`state/openclaw-agent-db.paths`、`plugin-state-runtime`。

### B 类:openclaw 会话存储(~22 个)

`config/sessions/session-accessor`、`session-cold-storage-read`、
`transcript-target-binding`、`sessions/transcript-events`、`sessions/input-provenance`、
`sessions/session-key-utils`、`routing/session-key`、`session-store-runtime`、
`session-store-paths`、`session-transcript-runtime`、`session-transcript-hit`、
`session-visibility`。

### C 类:openclaw 运行时底座(~25 个)

`infra/sqlite-wal` / `sqlite-strict` / `sqlite-transaction` / `sqlite-schema-contract` /
`sqlite-schema-facts` / `kysely-sync`、`infra/net/ssrf` / `fetch-guard` / `proxy-env`、
`logging/redact` / `secret-redaction-registry` / `subsystem`、
`utils/run-with-concurrency` / `shell-argv`、`shared/global-singleton`、
`infra/home-dir`、`infra/warning-filter`、`agents/current-time`。

### 其他

`agents/agent-roster` / `agent-scope` / `agent-settings` / `internal-runtime-context` /
`memory-search` / `model-auth` / `workspace-access` / `workspace-default-path`、
`auto-reply/heartbeat` / `strip-inbound-meta`、`cli/parse-duration`、
`plugins/embedding-provider-types`、`plugins/memory-state`、`plugins/types`、
`memory/root-memory-files`、`gateway-client/timeouts`、`auto`、`commander`。

**注意:逃出包根的相对引用 0 个**(全是包说明符或同包相对),所以剥的时候不存在
"记忆子系统偷偷用 openclaw 私有文件"的情况 —— 每一条都在上面列出了。

## 施工顺序(按判据,不按子系统排队)

1. **分类这 174 个模块**:记忆逻辑 / openclaw 躯干 / 纯工具库。产出物是本文件的表。
2. **把躯干归并成接缝**:每个接缝写"openclaw 的 X ← OpenCode 的 Y",OpenCode 侧没有
   对应物的才需要自己写胶水。A/B/C 共约 80 个模块,真正独立的接缝估计十几个。
3. **逐个把自创实现换成对上游的调用**,自己那份收缩成接缝。先清点、再替换,不做半成品:
   - 半成品的形态是"文件在但没人调"或"调用方指向不存在的导出",后者正是当初触发删除
     `extensions/active-memory/` 的原因。
   - `package.json` 的 `files` 是**逐文件列举**(全表 66 个 `extensions/*` 条目),搬回来的
     每个文件都要单独加进去,否则装到用户机器上就是死的。

## 已完成(截至 2026-10-13,均在 git 内)

| | 提交 |
|---|---|
| 项目作用域写端+读端+注入过滤(跨仓库泄漏) | `6f48c887` |
| `memory_index_state` 补表 + 4 处裁剪断裂 | `2ab81096` |
| `memory forget` 全链 + 索引清理(照抄上游,`memory-forget-content.ts` 逐字节) | `80408f77` |
| 配置表单 24→39 键 + 网页「忘记」入口 | `ea8e47b3` |
| 召回过的轮次不进快照(照 `session-files.ts:453,781,788-794` 的形状) | `f3895764` |
| 召回标记改用 `messageID`(修正上一条用文本摘要的妥协键) | `c7f3d459` |

**两个判断错误的更正**,都写进了代码注释:`turnTainted` 是网络来源位不是记忆污染位;
上游 `isRecalledMemoryMessage` 的标记全树没有生产者。详见下面 P0。

## P0 自我学习回路 —— 已闭合

**上游的机制不是"标记后拦晋升",是入库时直接不存。** 逐条核实:

- `turnTainted` 是**网络来源位**(`ToolResultContentSource` 唯一成员 `"network"`),
  `memory_search` 明确不声明它,断言在 `prepare.test.ts:2654`;
  `extensions/active-memory/` 对它零命中。
- 上游真正的防线 `isRecalledMemoryMessage`(`session-files.ts:453`)读
  `provenance.sourceTool ∈ {memory_search, memory_get}`,但 `InternalTurnSource` 是封闭
  联合类型塞不进去,全树唯一出现处是测试 fixture —— **上游这条保证运行时恒不触发**。
- 它做的事是 `continue`(`:788-794`),不是打标:被污染轮次的全部消息根本不写进语料,
  粒度是整轮,连触发它的那条 user 消息本身也不存(标记在 `:781` 置位、排除测试在 `:788`)。

**照抄这个形状,不照抄缺失的生产者。** 落地在 `plugin/src/recall-taint.ts` 与
`snapshot.ts`,判据挂在开启该轮的 user 消息上(上游同一位置)。探针 22 项全过。

## P1 上游的第二道防线:`turnTainted`(网络来源)—— 依赖 P2

某工具结果来自网络时该 assistant 消息判 `untrusted`
(`session-provenance.ts:9-11`),被 `isPromotionOriginBlocked`
(`dreaming-consolidation-candidates.ts:11-16`)结构性禁止晋升。效果是"网页抓来的一句话不会
被固化成永久记忆"。

**它同时卡在两处**:

- 粒度:mem-plus 的 `origin_class` 是 `documents.origin_class`,**一个文件一个值**;上游是
  `memory_index_chunk_provenance` 按 `chunk_id`,**逐块**。一条快照里混着抓来的内容和自己的
  话,无法只标其中一条。
- 来源判定:上游靠自己的工具注册表逐个声明 `resultContentSource`,mem-plus 没有那张表。

**OpenCode 侧的落点已找到**(上一轮的调研结论,当时被我以"OpenCode 没有"草草否定):

| 上游 | OpenCode 对应 |
|---|---|
| 工具结果的网络来源 | `ctx.tool.hook("execute.after")`,带 `tool` + `sessionID` + `agent` + **`messageID`** + `id`,`after` 还给 `result: Tool.Result`(`@opencode/plugin` `promise/tool.d.ts:38-53`) |
| 网络内容的身份 | `ctx.websearch` 是一等 domain,结果自带 `url` |
| `message.provenance` | `SessionMetadata`:durable、任意键、JSON 值、**fork 时继承**(`schema/dist/session-metadata.d.ts`) |
| Lane 2 的子会话 | `session.fork(input: SessionForkInput)`,`SessionFork.Boundary` 是 `{type:"before"\|"through", messageID}`(`client.d.ts:42`) |

`Tool.Result.metadata` 也是一条通道。`ctx.session` 目前的 `SessionDomain` Pick 未暴露
`fork`,但 `ctx.rpc` 是通用 RPC 面。

**仍未定**:哪些工具算"网络来源"。上游自己的注册表规定 web-search/web-fetch/browser/
firecrawl/全部 MCP 都算。OpenCode 侧可从 `ctx.websearch` 与 `ctx.mcp` 取,但"其它插件注册
的工具"上游没规定 —— 不自己发明。

## P2 索引层 —— 上游原件已在树里,只是没人调

上游六个 schema 模块**逐字节已在 vendored 树中**,import 全本地:
`memory-schema-base.ts`(92)、`memory-schema-fts.ts`(311)、
`memory-schema-provenance.ts`(60)、`memory-schema-recall.ts`(78)、`memory-schema.ts`(691)、
`memory-schema-storage-migration.ts`(419)。

**因此 schema 层不需要手写一行 DDL** —— 直接调 `buildMemoryIndexStrictSchema({
embeddingCacheTable, includeEmbeddingCache })`,FTS 调 `ensureMemoryChunkFtsSchema` /
`ensureMemoryPathFtsSchema`。比"照着抄"更可靠,抄也会抄错。

现状是它们只被 `packages/memory-host-sdk` 内部三个文件引用,`plugin/src/**` 零引用,同时
另写了一套 `documents`/`units`/`units_fts`/`vectors`。**schema 搬下来了,在它旁边另起了一套。**

`index.db` 全部可从磁盘重建(正文在 memory 文件里,血缘在 sidecar 文件里),所以**不需要数据
迁移**,代价是一次 reindex。

`embedding BLOB NOT NULL` 看着会掐死无模型的全文安装,但上游无向量时写**空 blob**
(`memory-schema-storage-migration.ts:360` 的 `encodeMemoryEmbedding(... ?? [])`),
照抄即可。

**照抄会真的删掉两样现在能用的东西**:

- `units.tags` / `units.heading` 在 mem-plus 的 FTS 里可搜;上游 FTS 列是
  `text, id, path, source, model, start_line, end_line`,**没有 tags 也没有 heading**。
- `units.marker` 无对应概念,而 mem-plus 的 capture 靠它防重复写入,还有唯一索引兜着。

**上游 schema 装不下的六项**(可从前四项推出,后两项不行):
`documents.root`(home/wiki,`MemorySource` 是封闭联合 `memory | sessions`)、
`documents.project`、`units.kind`、`units.entry_type`、`units.day`/`ts`、`units.marker`。

## P3 `extensions/active-memory/` 15 个文件 —— 试搬过,能编译,但不能只搬

**已验证**(2026-10-13):15 个文件逐字节从 openclaw 复制进 `extensions/active-memory/` 后,

- 相对 import 全部可解析 —— `index.ts` 缺的 `./trigger-recall.js` 有了,当初那两处断裂
  是同一次删除造成的
- 19 个 `openclaw/plugin-sdk/*` 依赖全部存在(`src/plugin-sdk/` 有,生成的 alias 树也有)
- `tsc -p tsconfig.plugin.json`:0 条新错误,总数仍 4240,`active-memory` 内 0 条

**所以"裁剪期删掉它们"在类型门上找不到任何依据。**

**但直接搬回来是错的**:`package.json` 的 `files` 是**逐文件列举**,`extensions/active-memory/`
下只有 `escalation.ts` 和 `types.ts` 被手工加进去。那 15 个文件不在 `files` 里 = 打包带不走
= 装到用户机器上就是死的,与当初被删时的处境一模一样。**已 `git clean` 撤回,不留半成品。**

真正要处理的是双份 `trigger-recall`:

| | |
|---|---|
| `plugin/src/trigger-recall.ts` | 声明 `PORTED from openclaw extensions/active-memory/trigger-recall.ts (418 行)`,**已改写**,导 5 个符号 |
| `extensions/active-memory/trigger-recall.ts` | 上游原件,导 7 个符号 |

差的是 `index.ts` 唯一要用的两个:`forgetTriggerRecallRun`、`TriggerRecallSource`。所以不是
"改 import 指过去"就行 —— 得让 `plugin/src/` 那份改成转接上游,或直接删掉全部改用上游。

## 已确认无法搬的(缺对应宿主接口)

- CLI(`openclaw memory` 9 个子命令)—— OpenCode 无此运行时
- gateway RPC(`memory.search/get/status`)—— 同上
- cron 驱动的 dreaming —— OpenCode 无 cron,现为"新一天第一个 settle 的对话"(用户已确认可接受)
- doctor 6 项迁移与检查 —— 裁剪期整体删除
- worker 架构 —— 现为单进程同步

## 验收口径(沿用 AGENTS.md)

不靠类型门。每一项必须有:真实数据走过该路径 + 可复核的落盘证据。
`MEMORY.md` 那层至今零验证 —— daily 层已实测(7 条真注解、reindex 后 `project_key` 落库),
promotion 写 `MEMORY.md` 注解这条路还没被真实数据走过,而泄漏恰好发生在那一层。

**P0 已闭合,但只在探针数据上验证过,尚未经真实会话走一遍。** 真实验证需要一个"提问触发深
召回 → 该轮快照落盘"的会话,并复核落盘文件里没有那轮内容。**这条没做完之前,P0 不算验证过。**
