# 计划:把 openclaw 的记忆模块完整接进 OpenCode(2026-10-13)

**方向已定:不再是"裁剪到只剩记忆",而是"把 openclaw 的记忆插件整体拔下来、换掉接口、
插入 OpenCode",实现与 openclaw 等价的行为。** 本文件取代 `trim-plan.md` 的 S2–S6
裁剪路线 —— 那条路线是为"最小可用"设计的,与本计划的目标相反。`trim-plan.md` 保留为
裁剪期的历史记录。

## 已完成(截至 2026-10-13,均在 git 内)

| | 提交 |
|---|---|
| 项目作用域写端+读端+注入过滤(跨仓库泄漏) | `6f48c887` |
| `memory_index_state` 补表 + 4 处裁剪断裂 | `2ab81096` |
| `memory forget` 全链 + 索引清理 | `80408f77` |
| 配置表单 24→39 键 + 网页「忘记」入口 | `ea8e47b3` |
| 全量导入扫描:记忆链 0 断裂 | 验证手段,非提交 |

## P0 自我学习回路(功能不等价,且会累积)

**上游为什么要有 session corpus。** 上游有 Lane 2(active-memory escalation):提问含召回
意图时,agent 带 `memory_search` 跑一轮检索,结果拼进上下文。于是记忆会进对话。三层防线
切断自我放大:

1. `classifySessionMessageOrigin`(`session-provenance.ts:9-11`)—— 被召回污染的轮次,
   消息判 `untrusted`
2. `isPromotionOriginBlocked`(`dreaming-consolidation-candidates.ts:11-16`)——
   `untrusted` / `system` **结构性禁止**晋升,不是扣分
3. 入库前 redact,并删除"运行时标记为召回的上下文"

**mem-plus 的回路是通的。** `isShortTermMemoryPath` 的规则
`memory/<proj>/<日期>-<任意后缀>.md` 同时匹配 daily entry 与 **session snapshot**;快照
是完整对话原文(`snapshot.ts:189`),含 assistant 回复,因而含 Lane 2 检索出来的记忆:

```
memory_search 召回旧记忆 → 拼进提示词 → assistant 复述 → 快照落盘 → 索引为 kind=turn
  → isShortTermMemoryPath 判定为候选 → recordShortTermRecalls 记录 → 进晋升候选池 → 晋升进 MEMORY.md
```

后果:一次检索被固化成永久记忆,之后每轮都在提示词里。且与项目作用域叠加 —— 晋升时
`projectKey` 会带上,于是这条自我生成的记忆还被限定到那个仓库,更难被发现。

**现状:三层防线 mem-plus 一层都没有。** capture 只收用户输入挡不住它(路径是快照不是
capture);快照 unit 的 `kind` 是 `turn`,`origin_class` 由 `memory-path-provenance.ts` 按
**路径**判定,不看内容是否含召回结果。

**要做的事(全部照抄上游,不自创):**
- 引入 `classifySessionMessageOrigin` 及其依赖的 `__openclaw.turnTainted` 判定
- 在 OpenCode 的消息通路上找到等价于 `turnTainted` 的落点 —— **这是关键未知项**,可能
  需要 OpenCode 侧提供轮次污染标记,也可能存在已有字段可复用
- 检索投递时给被注入的轮次打标,使写快照时能识别
- 确认 `MEMORY.md` 晋升链路上 `originClass = "untrusted"` 会被
  `isPromotionOriginBlocked` 拦住

## P0 自我学习回路 —— 已闭合(2026-10-13)

**上游的机制不是"标记后拦晋升",是入库时直接不存。** 这一条纠正了本文件初稿的
判断。初稿写的是"`turnTainted` → `untrusted` → `isPromotionOriginBlocked` 三层",
调研后两层的前提都不成立:

- `turnTainted` 是**网络来源位**,不是记忆污染位。它的 `ToolResultContentSource`
  联合类型只有一个成员 `"network"`(`packages/agent-core/src/types.ts:487`),web-search
  / web-fetch / 全部 MCP 工具都声明它,而 `memory_search` / `memory_get` **明确不声明**
  —— 有断言(`src/agents/cli-runner/prepare.test.ts:2654`)。`extensions/active-memory/`
  对 `turnTainted` 零命中。
- 上游真正的防线是 `isRecalledMemoryMessage`(`session-files.ts:453`),它读
  `provenance.kind === "internal_system"` + `sourceTool ∈ {memory_search, memory_get}`。
  **这个标记在 2026.9.9 全树没有生产者**:`InternalTurnSource` 是封闭联合类型,塞不进
  `memory_search`(`src/auto-reply/templating.ts:316`),唯一出现处是测试 fixture。所以
  上游这条保证目前是空的,`insideRecalledMemoryTurn` 运行时恒为 false。
- 而它做的事是 `continue`(`session-files.ts:788-794`),不是打标:被污染轮次的全部
  消息**根本不写进语料**。粒度是整轮,连触发它的那条 user 消息本身也不存(标记在
  :781 置位,排除测试在 :788)。因此它不需要 provenance 列、不需要 origin class、
  不需要晋升闸门 —— 没写过的东西无法被检索、晋升或重放。

**照抄这个形状,不照抄缺失的生产者。** 落地:`plugin/src/recall-taint.ts` 按上游
`session-files.ts:453,781,788-794` 的结构实现排除,`snapshot.ts` 在渲染时套用,
`recall-inject.ts` 在 `prompt` 钩子里记录"这条提问触发了深召回"。判据挂在**开启该轮的
user 消息**上,与上游同一位置;OpenCode 的 `ctx.session.message` 只读,插件无法给已发出
的消息打标,故用提问文本作键 —— 这是该位置在 mem-plus 里唯一可区分的属性。

**验证(探针已删):** 单测 12 项 + 端到端经 `renderSessionSnapshot` 10 项,全过。端到端
读到落盘 markdown:污染轮的提问与 assistant 复述**都不在文件里**,同会话其余轮次完整保留,
重复渲染结果一致(标记不在写快照时清空,否则下一次快照会把旧轮次当成干净的写回去)。
`tsc plugin` 改动前后同为 4240 错、全在 `src/`(4097)与 `packages/`(143),`plugin/` 与
`extensions/` 各 0,未引入新错。

**为什么 mem-plus 更容易踩:** 上游 Lane 2 跑在**子会话**(`recall-run.ts:141` 给
session key 加 `active-memory:` 前缀),污染的是子会话的 transcript,父对话干净。mem-plus
的 Lane 2 直接用 `ctx.generate.text` 在**当前会话**跑(`deep-recall.ts`),结果和模型的
复述一起落在本轮里,被 `snapshot.ts` 捕获。这不是 mem-plus 缺了上游的防线,而是同一个
上游漏洞在 mem-plus 的架构下更容易踩到。

## P1 上游的第二道防线:`turnTainted`(网络来源)—— 仍未搬,需要先定 schema

上游还有一条**独立**的防线,mem-plus 没有:某个工具结果来自网络时,该 assistant 消息判
`untrusted`(`classifySessionMessageOrigin`,`session-provenance.ts:9-11`),于是被
`isPromotionOriginBlocked`(`dreaming-consolidation-candidates.ts:11-16`)结构性禁止晋升。
后果是"网页上抓来的一句话不会被固化成永久记忆"。

**mem-plus 搬不了这一条,原因是粒度。** mem-plus 的 `origin_class` 是
`documents.origin_class`,**一个文件一个值**,由 `memory-path-provenance.ts` 按路径判定。
一条快照里混着抓来的内容和自己的话,无法只标其中一条。上游是
`memory_index_chunk_provenance` 按 `chunk_id`,**逐块**。

补这一条要先给 `units` 加 `origin_class`,即 P2 的 schema 决定先于 P1。**不静默跳过,
也不擅自改 schema** —— 记在这里等你定。

## P2 索引层换成上游 `memory_index_*` —— 已勘察,未动手

上游六个 schema 模块**全部已在 vendored 树里**(`packages/memory-host-sdk/src/host/`),
import 全是本地的,断裂扫描 0:`memory-schema-base.ts`(92 行)、
`memory-schema-fts.ts`(311)、`memory-schema-provenance.ts`(60)、
`memory-schema-recall.ts`(78)、`memory-schema.ts`(691)、
`memory-schema-storage-migration.ts`(419)。

**因此 schema 层不需要手写一行 DDL**:直接调 `buildMemoryIndexStrictSchema({
embeddingCacheTable, includeEmbeddingCache })`,FTS 调 `ensureMemoryChunkFtsSchema` /
`ensureMemoryPathFtsSchema`。这比"照着抄"更可靠 —— 抄也会抄错。

### 表的对应

| 上游 | mem-plus 现状 | 备注 |
|---|---|---|
| `memory_index_meta` (key/value) | — | 新增 |
| `memory_index_sources` (id, path, source, hash, mtime, size) | `documents` | chunk 按 path+source 归属,**无 FK** |
| `memory_index_chunks` (id TEXT UNIQUE, path, source, start_line, end_line, hash, model, text, **embedding BLOB NOT NULL**, updated_at) | `units` | `id` 从 INTEGER 变 TEXT |
| `memory_index_chunk_provenance` (chunk_id, origin_class, session_kind, observed_at, supersedes_key) | `documents.origin_class/session_kind/observed_at/supersedes_key` | **粒度从文件变块,更细** —— P3 网络来源防线靠它 |
| `memory_index_chunk_recall_metadata` (chunk_id, importance, triggers, project_key) | `units` 上的同名列 | 拆成侧表 |
| `memory_index_chunks_fts` | `units_fts` | 见下,列不同 |
| `memory_index_paths_fts` | — | 新增 |
| `memory_index_chunks_vec` | `vectors` | |
| `memory_index_state` | 已补 | |
| `memory_embedding_cache` | — | 新增,可选 |

**嵌入列的坑**:`embedding BLOB NOT NULL` 看着会掐死无模型的全文安装,但上游在无向量时写
**空 blob**(`memory-schema-storage-migration.ts:360` 的 `encodeMemoryEmbedding(... ?? [])`)。
照抄这个约定即可,全文-only 不受影响。

### 上游的 schema 装不下的东西(逐条核对过)

| mem-plus | 上游有无 | 判断 |
|---|---|---|
| `documents.root` (home/wiki) | **无**。`MemorySource` 是封闭联合 `memory \| sessions`(`host/types.ts`),wiki 语料塞不进 `source` | 可从 `path` 推出(wiki 在另一个根下),无需列 |
| `documents.project` (项目 slug) | **无**。上游只有 `recall_metadata.project_key`(来自注解的仓库身份,是另一回事) | 可从 `path` 相对 memory home 推出 |
| `units.kind` (entry/turn/memory/wiki) | **无**。上游按路径判候选(`chunk.path IN ('MEMORY.md','USER.md')`、`isShortTermMemoryPath`) | 照上游改成按路径判 |
| `units.entry_type` | **无** | 从条目正文注解里取,与上游 `extractCuratedEntryRecallMetadata` 读 trigger/importance 同一手法 |
| `units.day` / `ts` | **无** | 从 heading 文本与路径日期推出 |
| `units.marker` | **无** | 上游无此概念。dedup 需另寻(chunk `id` 或 hash) |
| `units.tags` / `heading` 在 FTS 里可搜 | **无**。上游 FTS 列是 `text, id, path, source, model, start_line, end_line` | **真实功能损失**:`filters.tag` 全文搜标签会失效 |

### 为什么不能分步做

只建表不切换读写 = 发出一批没人读的死表,正是 AGENTS.md 记的那个坑
(`extensions/active-memory/` 13 个死文件,3718 行,不进 `files`、永不加载)。
反过来先切读再写 = 索引直接坏。所以这是一次改动:schema + writer + reader + 派生概念
一起换。

### 好消息:不需要数据迁移

`index.db` 全部可从磁盘重建 —— 正文在 memory 文件里,血缘在 `memory-artifact-provenance`
的 sidecar 文件里。建新表、全量重写、丢旧表,首次打开时强制一次 reindex 即可。
用户侧的代价是一次重建,不是一段迁移代码。

### 触及面(实测)

`plugin/src/` 下 14 个文件:`memory-index.ts`(1120 行,88 处引用)、`memory-parse.ts`(22)、
`memory-forget.ts`(19)、`memory-tools.ts`(14)、`memory-scan.ts`(10)、`web/api.ts`(3)、
`project-memory.ts`(2),加 `index.ts` / `paths.ts` / `project-key.ts` /
`config-file.ts` / `wiki/config.ts` / `trigger-recall.ts` / `ReindexRow.tsx` /
`translations.ts`。

### 开工前需要定的两件事

1. **`units.tags` 的全文搜索**:上游 FTS 没有 tags 列。照上游 = 标签搜不了。是接受这个
   损失,还是把 tags 拼进 `text` 索引(等于偏离上游)?
2. **`units.marker` 的 dedup**:上游没有这个概念,而 mem-plus 的 capture 靠它防重复。
   换成 chunk `id` 的生成规则,还是要另设?

这两条是"照抄上游"会真的**删掉现有功能**的地方,不是我拿它当借口。

## 已确认无法搬的(缺对应宿主接口,不需要改)

- CLI(`openclaw memory` 9 个子命令)—— OpenCode 无此运行时
- gateway RPC(`memory.search/get/status`)—— 同上
- doctor 6 项迁移与检查 —— 裁剪期整体删除
- cron 驱动的 dreaming —— OpenCode 无 cron,现为"新一天第一个 settle 的对话"
- 文件监听 —— 现为显式 `memory_reindex`
- worker 架构 —— 现为单进程同步

## 调研已完成(2026-10-13)

1. **OpenCode 有无 `turnTainted` 等价物** —— 无。二进制(`@opencode/cli` 2.0.27)与
   `@opencode/schema` / `@opencode/plugin` 2.0.20 的类型定义里,`taint` / `provenance` /
   `recalled` / `injected` / `fromMemory` 全部零命中。可用的落点有三个:`ctx.storage`
   插件私有 KV、`ctx.session.update({metadata})`、消息创建时的 `metadata`;**给已发出的
   assistant 消息打标不可行**,`session.message` 只读。结构性障碍:`context` 钩子不带
   `messageID`,投递时不知道是哪个用户消息触发了这一轮 —— 这正是 P0 改用提问文本作键的
   原因。
2. **上游 `turnTainted` 的写入点** —— `packages/agent-core/src/turn-taint.ts:41-53`
   `withAssistantTurnTaint`,四处写入,语义统一为"本轮有 `resultContentSource: "network"`
   的工具结果"。与记忆召回无关。
3. **P0 的最小可行形态** —— 已落地,见上。选的是上游自己的形状(整轮排除),不是
   "检查内容是否包含注入文本",因为后者粒度更细但会漏掉改写过的复述。

## 验收口径(沿用 AGENTS.md)

不靠类型门。每一项必须有:真实数据走过该路径 + 可复核的落盘证据。
`MEMORY.md` 那层至今零验证 —— daily 层已实测(7 条真注解、reindex 后 `project_key`
落库),promotion 写 `MEMORY.md` 注解这条路还没被真实数据走过,而泄漏恰好发生在那一层。

**P0 已闭合,但只在探针数据上验证过,尚未经真实会话走一遍。** 真实验证需要一个
"提问触发深召回 → 该轮快照落盘"的会话,并复核落盘文件里没有那轮内容。**这一条没做完
之前,P0 不算验证过。**