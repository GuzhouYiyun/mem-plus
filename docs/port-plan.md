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

**融入很深的同样要剔出来。** import 层面的接缝只是浅的一层;记忆逻辑与躯干逻辑缠在同一个
函数里、同一个数据结构里的地方,也得拆开。所以"剥"分三层,处理方式完全不同:

| 层 | 是什么 | 怎么处理 |
|---|---|---|
| **L1 接缝** | 一处 import 伸到记忆子系统外面 | **写转接头**:openclaw 的 X ← OpenCode 的 Y |
| **L2 剔** | 记忆逻辑与躯干逻辑缠在同一个函数/同一个数据结构里 | **拆开**:记忆那半搬走,躯干那半删掉 |
| **L3 血管改造** | 血管本身形状不兼容 —— 不是名字不同,是结构不同 | **改造**:改写依赖它的那段代码,转接头接不上 |

**L3 不能靠转接头。** 转接头的前提是两边形状对得上、只是叫法不同。形状不兼容时只能改
依赖方。已知的候选(尚未逐个验证):

- openclaw 的会话存储是 SQLite 支撑的,带 `session-cold-storage-read`、`session-history`、
  `session-archive-compression`、`session-canonical-key`、`session-incognito-binding`、
  `transcript-target-binding` 这一整套;OpenCode 的 `ctx.session` 不是这个形状。
- openclaw 的工具注册与来源声明是一张表;OpenCode 的 `ctx.tool.list()` 是运行时列表,
  `ctx.websearch` 是另一个 domain。
- openclaw 的 cron 驱动的 dreaming;OpenCode 没有 cron,只有钩子。

**目前只量了 L1。** L2 和 L3 一个都没数。找法不同:L1 是机械的(数 import),L2 要打开函数
看 —— 找记忆子系统里"外部依赖少但文件大"的文件,那通常是缠在一起的;L3 要对每个接缝问
"两边形状一样吗",一样归 L1,不一样归 L3。**在数清 L2/L3 之前,接缝数量是下限不是总数。**

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

## 记忆框架(2026-10-13 联网查证,docs.openclaw.ai/concepts/memory-architecture)

**五层模型**,边界在 curated 与 episodic 之间:

| 层 | 面 | 谁写 | 注入 |
|---|---|---|---|
| Instructions | `AGENTS.md` | 仅人 | 总是,会话开始 |
| Curated core | `MEMORY.md`、`USER.md` | dreaming consolidation;或用户直接要求 | 会话开始,provenance 合格时,受预算限制 |
| Episodic | `memory/YYYY-MM-DD.md`、会话 transcript | agent 工作中;memory flush;transcript capture | **从不**;只能按需检索 |
| Prospective | standing intents(SQLite)、cron | `intent` 工具;调度任务 | 只在触发时 |
| Review | `DREAMS.md`、dreaming 报告 | dreaming 各阶段 | 从不;给人读 |

**关键安全性质:自动注入只限 curated 层。** 原文:「This restriction is a security property,
not a tuning choice」。`MEMORY.md` 与 `USER.md` 合格;daily notes 与 transcript **永不**自动注入,
无论匹配强度多高。这是防投毒的**结构性**防线,不是调参。

**长期记忆只有一个主写者:dreaming consolidation pass。** 其余一切都是它的输入。

**Dreaming 三阶段**(light / deep / REM,调度 sweep)。Deep 过两道闸:

1. **确定性闸** —— 候选按加权信号排序(检索相关性、召回频次、查询多样性、时效、多日复现、
   概念丰富度),须过全部阈值。`untrusted` / `system` **在构造任何 prompt 之前**就被结构性
   排除:「This is a precondition, not a score penalty」。
2. **consolidation 步** —— 门控候选 + 当前 `MEMORY.md` 交给一次模型轮次产出修订文件。
   输出须过结构校验、不超 bootstrap 预算、不丢失超过有界比例的既有条目,否则回退 append-only。

**写入安全**:替换 `MEMORY.md` 用乐观并发 —— 构造输入时捕获的内容哈希在原子 rename 前重新
校验;期间被改动则本轮放弃重写、走 append 回退。

**两条召回通道**:Lane 1 零模型调用(bootstrap 注入 / 排序检索 / trigger 注入,每轮至多 3 条);
Lane 2 是真实子 agent 轮次,**阻塞式**,默认只在两个确定性条件同时成立时跑。

**只有三个工具**:`memory_search`、`memory_get`、`intent`。

**检索**:hybrid = 向量余弦 + BM25,`finalScore = vectorWeight * vectorScore + textWeight *
textScore`;30 天召回半衰期;importance 1–10 写入时定一次;MMR λ=0.7 做多样性重排。

**索引是可重建缓存** —— 删了会从文件重建。这是设计里最要紧的一个决定(文档明确:source of
truth 是文件)。

### 文档与代码的十处核对(2026-10-13 通读代码后)

| # | 文档说法 | 代码真值 | 判定 |
|---|---|---|---|
| 1 | trigger 阈值 0.65 | `trigger-recall.ts:26` = **0.65** | ✅ 一致。**上一版记的"文档 0.65/0.72 并存"是错的** —— 0.72 在本 checkout 的任何文档里都不存在,只出现在 `trigger-recall.ts:22` 的注释里,说明它被否决过 |
| 2 | "长期记忆只有一个主写者:dreaming consolidation" | `dreaming.ts:221` 是唯一调用者,但 `memory-forget.ts:497` 是第二个 `commitMemoryContent` 调用者 | ⚠️ **对自动流水线成立,但不是结构性强制** |
| 3 | 30 天召回半衰期 | `memory-search.ts:122` `{enabled:true, halfLifeDays:30}` 正确,但 `temporal-decay.ts:8` 的文件内默认值是 `enabled:false` | ⚠️ 出货路径对,**代码内部自相矛盾** |
| 4 | importance 乘数 | `importance.ts:6` `0.75 + i*0.05` | ✅ 一致(文档漏了 `0.75` 这个底) |
| 5 | 三阶段顺序 light/deep/REM | `dreaming-phases.ts:1405-1406` 是 **light→REM,deep 在后** | ⚠️ **文档的顺序不对** |
| 6 | episodic 永不自动注入 | `memory-recall-metadata.ts:231-232` SQL 路径白名单 + origin class | ✅ 一致,且**比文档说的更强** |
| 7 | standing intents 有"可选的 trigger embedding" | `standing-intents.ts:103` 存的是字面 `null`;匹配只用 FTS | ⚠️ 字段存在但未使用,文档是 aspirational |
| 8 | Lane 2 的"两个确定性条件" | `escalation.ts:82-97`:条件一 = lane 1 无强命中(第 93 行短路),条件二 = `hasRecallIntent(message)`(第 96 行)。纯函数,无模型无 I/O | ✅ 一致 |
| 9 | untrusted/system 在构造 prompt 前排除 | `short-term-promotion.ts:124` 评分前;`dreaming-consolidation.ts:407` prompt 前 | ✅ 一致,两处 |
| 10 | 会话种类门控 | `session-ingestion.ts:132` 对非 `interactive` 返回 null | ✅ 一致,机制不同 |

## 融合深浅:逐处实测(2026-10-13 通读代码后)

这是 L1/L2/L3 的判定依据,不是推测。

### (a) 会话存储 —— **L3,接缝接不上**

`session-files.ts:77-97` 的 `SessionFileEntry` 不是"读个 transcript",是**openclaw 会话库的
记忆投影**:

```ts
  lineMap: number[];              // 每个内容行 → 1-indexed JSONL 源行号
  messageTimestampsMs: number[];  // 每个内容行 → epoch ms,0 表示未知
  lineProvenance: MemoryEntryProvenance[];  // 与内容行一一对应
```

`buildSessionEntry`(`:516-567`)的选项里有 `sessionKey` / `agentId` / `sessionId` /
`storePath` —— 是**活的 SQLite 身份**,不是文件路径。一个函数里七个 openclaw 专有概念:incognito
绑定、SQLite 会话身份、worker admission、secret-redaction registry 版本、冷存储恢复、
`resetRecallCutoff` 符号、平台语义环境变量克隆。

**判定:改写依赖方**。要自己实现 `content`/`lineMap`/`messageTimestampsMs`/`lineProvenance`。
下游全部消费这个形状(`buildDailyIngestionResults`、`DAILY_INGESTION_SCORE = 0.62`、
`SESSION_INGESTION_SCORE = 0.58`),所以它是**承重接口**。这也是 OpenCode 侧唯一能对上位的
两个入口:`readSessionTranscriptCorpusInWorker`(异步)与
`listSessionTranscriptCorpusEntriesForAgentSync`(同步)。

**这一条改变了 P3 的性质**:`extensions/active-memory/` 的 `session.ts` / `transcript.ts` /
`recall-run.ts` 都建立在这个接口上,所以 Lane 2 的搬入不是"补个 adapter",是 L3。

### (b) cron 驱动 —— 接口可接,但**不接就跑不起来**

`dreaming-cron.ts:81-87` 把整个需求定义成一个结构类型,鸭子类型判定在 `:193-207`:
`{isEnabled?, list, add, update, remove}`。所以**接口是 L1**。

但两个 openclaw 语义漏进了**行为**里:`sessionTarget: "isolated"` + `wakeMode: "now"`;
以及 `before_agent_reply` 带 `ctx.trigger === "cron"` 与 `event.cleanedBody` 的 token 匹配。

**判定:最省事的移植是砍掉 cron 那条臂** —— 换成普通 interval 直接调
`runDreamingSweepPhases` + `runShortTermDreamingPromotion`,
`reconcileShortTermDreamingCronJob` 整个丢掉(它只为迁移旧的 light/REM job 而存在,
`dreaming-cron.ts:24-34`)。

### (c) 工具注册 + 嵌入 provider —— **L1**

`index.ts:250-274` 三次 `api.registerTool`。唯一 openclaw 类型依赖是
`OpenClawPluginToolContext`,而实际消费的字段只有 8 个(`:157-167`)。嵌入 provider 是干净的
工厂接口(`create` / `supportsMultimodalEmbeddings` / `shouldContinueAutoSelection`)。
`acquireLocalService` **可以是 undefined** —— 纯 FTS 路径完全支持
(`manager-search-orchestration.ts:408-412`)。

### (d) 索引 schema —— SQL 可搬,**位置**是难点

`memory_index_*` 的 SQL 是标准的(STRICT 表、FTS5、revision 计数器)。难点在
**记忆索引住在 openclaw 每 agent 的共享 SQLite 里,与会话库同一个文件**
(`openclaw-agent-db.paths.ts:53`),因而共享 WAL、共享 schema contract、共享 reader admission。
`manager-db.ts:215-219` 还在这个共享文件上配记忆专属的 WAL 维护。

**移植判定:让索引拥有自己的 `memory.sqlite`,丢掉
`openOpenClawAgentDatabaseReadOnly`(`:247`)换成普通 open。** 这顺带解决 P2 里担心的
schema-contract 读取器。搬不走的只剩三样:与共享文件的 WAL 协调、schema-contract 读取器、
sqlite-vec 依赖(后者可选,缺了会退回进程内余弦)。

### (e) 配置 —— L1,但形状是 openclaw 的

两个配置面都要走:顶层 `cfg.memory.search` + per-agent 覆盖;以及
`plugins.entries.<memorySlot>.config` —— 而 dreaming 配置是**相对 slot 解析**的
(`dreaming.ts:340-349`,`slots.memory` 为 `"none"` 或未设时回落到 `"memory-core"`)。
单 provider 移植可以硬编码,但多插件场景会静默读错对象。

## 对照:上游 288 个记忆生产文件 vs mem-plus 现有(2026-10-13 实测)

上游记忆子系统 **288 个生产文件,52680 行**(排除 `.test.ts` 与 plugin 入口 `index.ts`)。
逐文件按内容哈希比对,再对同名的按"上游有多少行在 mem-plus 里原样存在"估算改写幅度:

| 状态 | 文件 | 行 | 占比 |
|---|---|---|---|
| **逐字节等于上游** | 36 | 3143 | **6%** |
| 有同名文件但已改写 | 73 | 17285 | 33% |
| **mem-plus 里没有** | **179** | **32252** | **61%** |

**已搬进来的行只占 39%。** 换句话说:上游记忆逻辑的六成在 mem-plus 里根本不存在,而
存在的那三分之一里又有三分之二被改写过。

### 分子系统

| 子系统 | 照抄 | 改写 | 缺失 | 已搬/总 |
|---|---|---|---|---|
| `short-term-promotion*`(晋升判定与应用) | 0 | 11 | 0 | **100%** |
| `memory-host-sdk`(宿主 SDK:文件发现、schema、会话导出) | 21 | 36 | 28 | **82%** |
| `dreaming*`(三阶段 sweep) | 3 | 8 | 6 | **72%** |
| `memory-core/其余` | 9 | 7 | 59 | **24%** |
| `memory-core/memory/`(**索引与检索**) | 2 | 8 | 75 | **5%** |
| `active-memory`(Lane 2) | — | — | 11 | 见 P3 |

**索引与检索层是空的** —— 上游 85 个文件,mem-plus 只有 10 个(2 照抄 + 8 改写),75 个缺失。
这就是为什么 `plugin/src/memory-index.ts` 是自创的 1120 行:自创不是因为没得搬,是因为**只搬了
十分之一,剩下的用一套自己的 schema 顶上**。上游的 `memory_index_*` schema 模块逐字节在树里
却没人调(P2 已记)。

`short-term-promotion*` 反而是 100% —— 11 个文件全部改写搬入,一行没漏。这是目前最干净的一块,
也是判断"照搬能做到什么程度"的样本:它证明记忆逻辑本身可以整体搬过来。

### 改写幅度最大的(上游行保留率最低)

| 保留率 | 行 | 文件 | 性质 |
|---|---|---|---|
| 10% | 287 | `active-memory/config.ts` | L3 候选(配置解析) |
| 16% | 520 | `memory-core/memory-forget.ts` | 我刚搬的,只 16% |
| 17% | 6 | `memory-core/memory/index.ts` | 只是个 re-export 门面 |
| 25% | 16 | `host/openclaw-runtime-sqlite.ts` | 躯干转接 |
| 32% | 307 | `memory-entry-origins.ts` | |
| 37% | 443 | `active-memory/trigger-recall.ts` | 我搬的,37% |
| 42% | 387 | `host/openclaw-runtime-session.ts` | 躯干转接 |
| 48% | 165 | `host/session-entry-projection.ts` | **L3 承重接口那一块** |
| 67% | 598 | `host/session-transcript-corpus.ts` | **L3** |

`session-entry-projection.ts` 与 `session-transcript-corpus.ts` 保留率低、又在 L3 承重路径上 ——
这两处是 Lane 2 搬不动的真正原因,和 P3 的结论对上了。

### 没有"100% 照抄的目录"

不存在任何一个目录是整目录逐字节等于上游的。照抄率最高的 `short-term-promotion*` 也是 11 个
文件全部**改写**后搬入(0 个照抄)。**所以"逐字节抄"在这个仓库里目前没有先例**,现有 36 个
照抄文件是单个零散文件,不是成块的子系统。

## 读侧收缩:字段映射表(2026-10-14 已核实)

上游 `MemorySearchResult`(`packages/memory-host-sdk/src/host/types.ts`)全部 15 个字段:
`path` / `startLine` / `endLine` / `score` / `vectorScore?` / `textScore?` / `snippet` /
`source` / `importance?` / `triggers?` / `projectKey?` / `originClass?`(deprecated)/
`citation?` / `provenance?`。

**没有 `heading` / `tags` / `marker` / `entryType` / `ts` / `documentKind`。**上游不是缺这些,
是从来没有过 —— mem-plus 的 `SearchHit` 是它的**超集**,多出 8 个字段。

> 我第一次说「上游没有 heading/tags」时,理由是从 chunk 表的列**推**出来的,那是错的依据。
> AGENTS.md 新写的硬门槛就是为了这条:推的不算,读类型定义才算。

### 收缩映射

| `SearchHit`(现) | 上游对应 | 来源列 | 处置 |
|---|---|---|---|
| `unitId: number` | `id` | `memory_index_chunks.id`(TEXT) | 改 `chunkId: string`,六字段哈希 |
| `path`(绝对) | `path` | `c.path` | 改相对路径(已验:上游那条字面白名单能命中) |
| `startLine`/`endLine`(**硬写 0**) | 同名 | `c.start_line`/`c.end_line` | **首次真正有数据** —— 闭合「引用行号无数据支撑」那条偏离 |
| `root` | `source` | `c.source` | 换成上游的值域 `memory`/`sessions`/`wiki` |
| `documentKind` | 无 | — | **删** |
| `day` | 无 | basename 日期 | 由路径派生,保留为过滤用 |
| `ts` | 无 | — | **删** |
| `entryType` | 无 | — | **删** |
| `tags` | 无 | — | **删**,`filters.tag` 一并消失 |
| `marker` | 无 | — | **删**(已退役,见 P2) |
| `heading` | 无 | — | **删** |
| `triggers`/`importance`/`projectKey` | 同名 | `memory_index_chunk_recall_metadata` | JOIN 取 |
| `provenance.*` | 同名 | `memory_index_chunk_provenance` | JOIN 取,**逐块**,粒度变细 |
| `curatedRoot` | 无 | `c.path IN ('MEMORY.md','USER.md')` | 改为上游那条字面判定 |
| `project`(目录 slug) | 无 | `memory/` 后的段 | 保留为过滤用 |
| (无) | `citation` | `path#L{start}-L{end}` | **新增**,替掉自创的来源行 |
| (无) | `snippet` | `c.text` 截断 | 现由 `text` 顶,改为上游的截断 |

### 收缩的真实代价(如实记)

每条命中不再有 `### N.<heading>` 标题行,不再有 `Tags: a, b, c`,来源行从
`Source: <path> (unit N, <marker>)` 变为上游的 `citation`,而
`filters.kind`/`filters.entryType`/`filters.tag` 三个过滤维度消失。

**换来 2 个真实字段**:`startLine`/`endLine` 上游 chunk 表真有,mem-plus 硬写 0 —— 所以模型
第一次能拿到真实行号,`memory_get` 的引用才第一次指得准。**用 8 个自创字段换 2 个真实字段。**

### 不要做的事

**不要自己写一个「从 chunk 文本里把 heading 解析出来」的解析器。** 那是把上游**没有**的东西自己补
回来,属于偏离,不属于「血管不兼容的接缝」。按目的答案从一开始就是收缩,不需要问。

## 读侧收缩 —— 已完成(2026-10-14)

索引读写两侧现在完全走上游的表。mem-plus 的 `documents` / `units` / `units_fts` / `vectors`
四张表不再被创建、不再被写入、不再被读取;若存在于旧库中会被原样忽略(`DROP TABLE`
不是打开索引时该对别人创建的文件做的事)。

### 换上的上游原件(全部调用,零抄写)

| 用途 | 上游函数 | 位置 |
|---|---|---|
| 六列 chunk 投影 | `projectMemorySearchRow` | `manager-search-shared.ts:15` —— **未 vendored,按原文誊写** |
| citation | `formatCitation` | `tools.citations.ts:41` —— **未 vendored,按原文誊写** |
| provenance + 召回标注 | `readMemoryRecallMetadata` | `memory-recall-metadata.ts:71` |
| trigger 候选 | `readCuratedMemoryTriggerCandidates` | `memory-recall-metadata.ts:113` |
| 项目记忆候选 | `readCuratedProjectMemoryCandidates` | `memory-recall-metadata.ts:127` |
| 逐块召回标注提取 | `extractCuratedEntryRecallMetadata` | `curated-annotations.ts:114` |
| 向量编解码 + 余弦 | `encode`/`decodeMemoryEmbedding`、`cosineSimilarity` | `embedding-vector.ts` |
| snippet 截断 | `truncateUtf16Safe` | `normalization-core/src/utf16-slice.ts` |

只有前两行是誊写:`extensions/memory-core/src/memory/` 在本树只有 8 个文件
(`hybrid`/`importance`/`keyword-query`/`manager-cpu-entrypoints`/`mmr`/`project-ranking`/
`temporal-decay`/`tokenize`),`manager-search-shared.ts` 与 `tools.citations.ts` 都不在其中。

### 读侧映射(照上表执行完毕)

| 旧(自创) | 新(上游) |
|---|---|
| `unitId: number` | `chunkId: string`(六字段哈希) |
| `text` | `snippet`(`truncateUtf16Safe(text, 600)`) |
| `heading` / `tags` / `marker` / `entryType` / `ts` / `documentKind` / `curatedRoot` / `root` | **全部删除** |
| `startLine`/`endLine` 硬写 0 | **真数据**,首次真正选出 |
| `HIT_COLUMNS` 自选 20 列 | `hitColumns()` 六列,与 `manager-search.ts:348` 同 |
| `filtersSql` 用 `d.`/`u.` 列 | 全部从 `path` 与 `source` 派生 |
| 手写 JOIN provenance | `readMemoryRecallMetadata(ids)` 一次批查 |
| 手写候选 SQL | 上游三个 reader |
| `vectors(unit_id,dim,vec)` | `memory_index_chunks.embedding` |
| 余弦手写点积循环 | 上游 `cosineSimilarity` |
| `byId: Map<number,hit>` + `entry.startLine` 当行 id 载体 | `source:path:startLine:endLine` 范围键 |

`filters.kind` / `filters.entryType` / `filters.tag` 三个过滤维度随字段一起消失。
`fuseRankings` 的注释此前说「上游按 `source:path:startLine:endLine` 合并」——**那是错的**,
读 `hybrid.ts:90` 才知道合并键是 `id`,范围键只用于 `selectHybridSearchResults` 去重。
现在两条都用对了。

## 本刀暴露的三件事(都不是想出来的,是查出来的)

**1. FTS5 虚拟表不能起别名。** 第一版 `hitColumns("f")` + `FROM memory_index_chunks_fts f`
让**每一次搜索都返回 0 条**,只报 `text search failed`。实测:`f.source = 'memory'` 这种同一条
SELECT 里最平凡的列引用都报 `no such column: f`。必须用表名 —— 这就是上游
`manager-search.ts` 一律写 `${params.ftsTable}` 而从不 `AS` 的原因。

**2. `memory_index_chunks.embedding` 是 `BLOB NOT NULL`,而且表是 `STRICT`。**
「没有向量」是**零长 BLOB**,不是 NULL。第一版写的 `WHERE embedding IS NULL` 永远匹配不到,
会把整个索引报成「已嵌入」—— 和上一刀那个静默失效的 revision 栅栏同一类错误。
无模型时的 `model` 值是上游的字面量 **`"fts-only"`**(`manager-reindex-state.ts:164`),
不是我原来写的空串。

**3. `substr('MEMORY.md', -13, 10)` = `'MEMORY.md'`,而 `'M' > '2'`。**
没有日期的 curated 文件**通过了每一次 `since`/`until` 过滤**。原先注释里写的
「非日期会自然被排除」是错的,探针跑出来才发现。加了
`GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'`,与 TS 侧的 `dayOf` 同一谓词。

### 一处刻意的偏离:`vectorCount`

上游 `hasSemanticChunks` 是 `WHERE model != 'fts-only'`(`manager-sync-base.ts:330`),
**这里用的是 `length(embedding) > 0`**。理由:上游 reindex 时顺手嵌入
(`manager-index-preparation.ts:79`),两个条件恒等;mem-plus 的嵌入是单独的预算批次
(`embedMissing`,一次一个 tool call),所以 reindex 之后、embed 之前存在一个真实状态 ——
chunk 带着 provider 的 `model` 而 embedding 还是空的。按 `model` 数会把这些算成可向量检索,
而 `describeMissingVectors` 的职责正是告诉模型「语义检索还没生效」,那时它会闭嘴,
`vector` 与 `hybrid` 却返回空。

## 要改什么(对照结论,不是推测)

按"能整体搬 / 要搬但需接缝 / 是 L3"三档,对照上面的表:

1. **`short-term-promotion*` 已经做到的目标形态** —— 11 个文件全部搬入、一行没漏、0 个缺失。
   这是**可复制的样板**:先搬一块完整子系统,不改写。
2. **索引与检索层(75 个缺失)** —— 最大的一块空缺。schema 原件已在树里可调(P2),但
   `memory/` 下 75 个文件要逐个判断:哪些是记忆逻辑(搬),哪些依赖共享 SQLite 的
   WAL 协调与 reader admission(L3,解法是独立 `memory.sqlite`)。
3. **`memory-core/其余` 59 个缺失** —— 含 `migration/`(8 个)与 `remote/`(1 个)。要先分清
   哪些是记忆语义、哪些是 openclaw 的 doctor/setup 控制面。
4. **L3 两处**(`session-entry-projection.ts`、`session-transcript-corpus.ts`)—— 不是"搬不过来",
   是"改写依赖方"。这一档要先决定改写策略,再动手。
5. **改写幅度低的已搬文件要复核** —— `memory-forget.ts` 只有 16% 上游行留在 mem-plus,
   `trigger-recall.ts` 37%。这两个是**我或前人搬的**,要逐行看剩下那 84%/63% 是什么:
   是接缝(合理)还是自创(要换回上游)。

### L3 接缝:第二个语料(wiki)—— 已落地并验过功能等价

上游 `MemorySource` 是封闭两值联合 `"memory" | "sessions"`(`host/types.ts`),mem-plus 有第二
套语料(wiki)没有值可放。**这不是接缝能桥的命名差异,联合里没有它的位置** —— 属 L3。

但它小,原因实测得到:联合是 TypeScript 收窄,不是存储约束。`memory_index_sources.source` 是
`TEXT NOT NULL DEFAULT 'memory'`,数据库本来就能收第三个值并分开。落地在
`plugin/src/memory-corpus.ts`,只做一件事:在 mem-plus 调上游的边界上把类型放宽一格。
`memory` 用上游自己的值,所以上游每一个比较 `"memory"` 的查询、过滤与索引一行都不用改。

**功能等价由六项实测支撑**(真实建库,非推演):存储接受第三值;两套语料各存一行互不覆盖
(`UNIQUE (path, source)`);curated 白名单 `path IN ('MEMORY.md','USER.md')` 有 wiki 行在场
时仍只认 1 行;按 `source` 过滤能单独取到 wiki;逐块 provenance 让 memory=agent、wiki=untrusted;
`origin_class IN ('owner','agent')` 的可晋升计数为 1,wiki 被闸门挡住。

**最后两条是这条接缝的关键**:架构文档称"untrusted 不得洗进 MEMORY.md"为结构性安全性质,
而它成立靠的正是**逐块** provenance —— 这恰是 mem-plus 现在的逐文件 provenance 做不到的。

**这条接缝顺带解掉登记在册的两项**:P1 的网络来源防线与 curated 层闸门,两者都因为逐块
provenance 而从"不可做"变成"可做"。

### 顺带查出的第四处「搬下来了在旁边另写一套」:路径约定

第一遍测白名单得 n=0 而非 1,原因是路径形状不对。查实:**上游的 `memory_index_sources.path`
存工作区相对路径**(curated 白名单字面就是 `path IN ('MEMORY.md','USER.md')`,配
`UNIQUE (path, source)`),而 mem-plus 的 `documents.path` 是绝对路径。

前三次是 schema、chunker、会话投影,这是第四次。**这个模式不是个别失误**,而是裁剪期的
系统性做法:原件搬下来留着,旁边另写一套顶上。

### 上游原件在树里没人用 —— 一次查完(2026-10-13)

`packages/memory-host-sdk` 59 个文件、8071 行,静态扫描:

| | 文件 |
|---|---|
| `plugin/`/`extensions/`/`web/` 直接用 | **7** |
| 只有 SDK 内部引用 | **42** |
| **完全无人引用** | **10 个,1919 行** |

死的 10 个含两个大的:`host/session-files.ts`(924 行,**P1 那条 L3 承重接口本身**)、
`host/memory-schema.ts`(727 行,上游的 schema 迁移与严格校验)。其余:`embedding-chunk-limits.ts`、
`embedding-vectors.ts`、`remote-http.ts`、`runtime-core.ts`、`engine-sessions.ts`、
`runtime-files.ts`、`status.ts`、`multimodal.ts`。

**这修正了一个一直被持有的说法。** 我之前把 mem-plus 描述成"上面薄适配、底下平行实现";
实测更准确的是:**上游原件整片搬下来、放着不用,旁边另写一套顶替。** schema、chunker、
会话投影三次命中同一件事。

**方向因此与"缺功能"相反**:大块原件在仓库里,只是没接。所以工作的框架不是"往里加功能",
而是"把已经在的东西接上"。

### 接线时必须照抄的三处 chunking 细节

上游唯一的生产调用点是 `manager-index-preparation.ts:70`,其参数准备有三处不可省的语义:

```ts
const perEntry =
  source === "memory" && (normalizedEntryPath === "MEMORY.md" || normalizedEntryPath === "USER.md");
const indexingContent = source === "memory" ? stripMemoryAnnotationCarriers(content) : content;
const chunkOptions = { ...chunking, perEntry };
```

- `perEntry` 按 **source + 路径**判,与 `memory-recall-metadata.ts:231` 的 curated 白名单同一
  判据。印证了"上游按路径判候选层"。
- **`stripMemoryAnnotationCarriers(content)`** —— memory 语料在进 chunker 前先剥掉注解载体。
  mem-plus 把 `<!-- trigger: ... -->` / `<!-- importance: N -->` 原样留在 `unit.text` 里并进
  FTS,所以 mem-plus 的索引里能搜到注解、trigger 命中会被注解文本干扰。**这是一处新的偏离,
  接线时必须一并照抄,否则检索行为不等价。**
- `MEMORY_CHUNKING_VERSION = 5` 是索引身份的一部分:切块规则变了要整库重建。

分词器另有两处,已登记在下面的偏离表:`remove_diacritics` 取值不同,以及 CJK 分词两边相同。
理由",这就是那个理由的位置。**「依赖 P2」是必填项**:凡是不搬是为了 P2 的粒度不够,就要
写明它随 P2 一起回来,不能变成永久的自创。

| 上游行为 | mem-plus | 原因 | 风险 | 依赖 |
|---|---|---|---|---|
| **curated 层限定**:`isPromotedTrustedMemoryEntry` 读该 entry 自己的 provenance 行,所以一个文件里合格与不合格的条目可以共存,只有合格的过闸 | `entry.provenance.originClass` 来自 `documents.origin_class`,**一个文件一个值**(按路径判定)。混合文件里**全部**条目都过闸 | mem-plus 的 provenance 粒度是文件,不是块 | **真实削弱。** 架构文档称这条为 security property 而非调参选择 | **P2** —— provenance 换成上游的逐块(`memory_index_chunk_provenance`)后自动恢复 |
| **FTS 分词器 `remove_diacritics`** | `units_fts` 声明 `unicode61 remove_diacritics 2`(完整 Unicode 去变音符);上游传的是**空子句**,即 `unicode61` 的默认 `remove_diacritics 1`(仅拉丁-1) | 照抄上游即用默认值 | **真实差异,影响非拉丁文字检索。**带变音符的拉丁扩展词表现会不同 | 无。属照抄带来的行为变化,不是接缝 |
| **CJK 分词** | 两边相同:`unicode61` 把**连续汉字当一个 token** | 相同 | 相同。实测 `MATCH '"索引是磁盘文件的缓存"'` 命中而 `MATCH '"索引"'` 不命中 | 无 |
| `forget.purge` 顺带清理 `memory_embedding_cache` | 报告里 `embeddingCacheRows` 恒为 0 | mem-plus 无此表。它在上游的唯一作用是不重复嵌入未变文本,重新 reindex 本来就会做 | 无。reindex 收敛 | 无 |
| 上游的语料计数(`sessionCorpusFiles`/`Lines`、`shortTermEntries`、`backups`、`seenHashScopes`) | 恒为 0 | 裁剪期删掉了 `session-ingestion` 的写端,mem-plus 没有会话语料;短期召回库是 plugin-state keyed store 而非表 | 无。这些计数描述的是不存在的存储 | 无 |
| `forget` 的参与者/hook 来源解析(`resolveMemorySessionTargetsAsync` 查活的会话库) | 选择器按给定值使用,每个都记 `resolution: "direct"` | OpenCode 无 openclaw 的会话库可查 | 无法兑现的项会进 `refusals` 而非静默失败 | 无 |
| `forget` 的索引清理经 worker 借用 openclaw agent 数据库 | 索引是插件自己的 `index.db`,直接传入 | 见 P2:让索引拥有自己的库,顺带丢掉 reader admission | 无 | 无 |

### trigger-recall 的双后端分支消失 —— 判定为接缝,非自创

上游 `trigger-recall.ts` 有两套候选加载:`loadNativeTriggerRecallCandidates`(新
`memory_index_*`,带 provider facts)与 `loadLegacyTriggerRecallCandidates`(旧 manager 路径),
外加 `toLegacyTriggerRecallHit` 转换、`assertTriggerSourceCurrent`、run 缓存与
`forgetTriggerRecallRun`。上游注释说明 run 缓存存在是因为「Native lookups run under caller
authority that can lapse」。

mem-plus 只有一个索引,合并成一路是必然结果。**判定内核逐字保留**:五个常量与值全同
(`TRIGGER_CANDIDATE_LIMIT=24`、`TRIGGER_INJECTION_LIMIT=3`、
`MAX_TRIGGER_CONTEXT_CHARS=1800`、`STRONG_TRIGGER_MATCH_SCORE=0.65`、`WORD_RE`),
`prepareTriggerScorer` / `isPromotedTrustedMemoryEntry` / `selectStrongTriggerMatches` /
`buildTriggerRecallContext` 全在。**唯一真丢失的是 `isPromotedTrustedMemoryEntry` 的输入粒度**,
见上表第一行。

## 宿主集成最小契约(通读后整理)

openclaw 宿主必须提供、而记忆侧实际消费的:

`getRuntimeConfig`/`runtimeConfig`/`config` · `agentId` · `sessionKey` · `sessionId` ·
`sandboxed` · `oneShotCliRun` · `conversationRecall` · `activeProjectKeys` ·
`messageChannel` · `senderId` · `senderIsOwner` · `assertInvocationCurrent` ·
`availableTools` · `citationsMode` · `contextWindowTokens` · `resolveSessionAgentIdStrict` ·
`authorizeSearchHits` 往返 · cron 服务 · `subagent.complete({agentId, message,
extraSystemPrompt, model?, timeoutMs})` · `openKeyedStore` CAS 存储(短期召回库)·
每 agent 的 `workspaceDir` · `before_agent_reply` 带 `heartbeat`/`cron` 触发与 `cleanedBody`。

**对应的 OpenCode 侧接缝**:`tool.execute.before/after`(`promise/tool.d.ts:38-53`)、
`SessionMetadata`(durable、fork 继承)、`session.fork`、`ctx.websearch`、`ctx.mcp`、
`ctx.storage`、`ctx.rpc`、`Tool.Result.metadata`。

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

1. **分类这 174 个模块**:记忆逻辑 / openclaw 躯干 / 纯工具库,并对每个躯干接缝判 L1 还是
   L3(两边形状一样吗)。产出物是本文件的表。
2. **数 L2**:打开记忆子系统的函数,找记忆逻辑与躯干逻辑缠在一起的地方。数法是找"外部依赖
   少但文件大"的那些 —— 依赖少说明它没伸出去,文件大说明东西在体内。L2 的数量决定剔的
   工作量,现在未知。
3. **把躯干归并成接缝**:每个接缝写"openclaw 的 X ← OpenCode 的 Y"。OpenCode 侧没有对应
   物的不是写胶水,是走 L3 改造依赖方。A/B/C 共约 80 个模块,真正独立的接缝估计十几个。
4. **逐个把自创实现换成对上游的调用**,自己那份收缩成接缝。先清点、再替换,不做半成品:
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

## P3 `extensions/active-memory/` —— 两堵墙,都撞过了,都不该再试

### 第一堵(2026-10-13):打包带不走

**已验证**:15 个文件逐字节从 openclaw 复制进 `extensions/active-memory/` 后,

- 相对 import 全部可解析 —— `index.ts` 缺的 `./trigger-recall.js` 有了,当初那两处断裂
  是同一次删除造成的
- 19 个 `openclaw/plugin-sdk/*` 依赖全部存在(`src/plugin-sdk/` 有,生成的 alias 树也有)
- `tsc -p tsconfig.plugin.json`:0 条新错误,总数仍 4240,`active-memory` 内 0 条

**所以"裁剪期删掉它们"在类型门上找不到任何依据。**

**但直接搬回来是错的**:`package.json` 的 `files` 是**逐文件列举**,`extensions/active-memory/`
下只有 `escalation.ts` 和 `types.ts` 被手工加进去。那 15 个文件不在 `files` 里 = 打包带不走
= 装到用户机器上就是死的,与当初被删时的处境一模一样。**已 `git clean` 撤回,不留半成品。**

### 第二堵(2026-10-14):运行期装不进来 —— 而类型门是绿的

这一堵只针对 `prompt.ts`(14421 字节)与 `query.ts`(7753 字节)。两个文件逐字节复制进来后,
`tsc` 报**自有路径 0 错**,与第一堵那次一样。**但 `import` 一次就抛:**

```
Cannot find module 'C:\...\src\agents\model-thinking-default.js'
  imported from C:\...\src\plugin-sdk\agent-runtime.ts
```

链是:`prompt.ts` → `./query.js`(只为一个 20 行的 `extractTextContentParts`)→
顶层 `import ... from "openclaw/plugin-sdk/agent-runtime"`(为一个**无关**的 `getModelRef`)→
alias shim `export * from "../../../src/plugin-sdk/agent-runtime.ts"` →
import 12 个 `../agents/*.js` 与 `../tts/tts.js`,这些**上游有、这棵树没 vendor**。

顺着再走上游树,传递闭包 **8794 个文件**。

**为什么这堵墙更该被记住**:它与第一堵的性质不同。第一堵是"门绿但打包不带",这一堵是
**"门绿但模块加载不了"** —— 而 `tsconfig.plugin.json` 验的是**类型**,验不出**加载**。
新增的 17 条类型错误全在 `src/plugin-sdk/agent-runtime.ts` 的 `TS2307`,落在 AGENTS.md 记的
那 434 个不可解析 specifier 之内,看起来像裁剪的正常产物,极易被当成无害噪声放过去。

> 上一条里"19 个 `openclaw/plugin-sdk/*` 依赖全部存在"这句是对的,但它只验了 **shim 存在**。
> **shim 存在 ≠ shim 能加载** —— shim 的转发目标才是真正要能解析的东西。

**结论:按规则(`openclaw 有源码就不许自己改`),这两份保持不搬**,`deep-recall.ts` 与
`trigger-recall.ts` 里那份誊写保留,理由写在代码里。绕过只有两条路,都不允许:改它们的
import,或补出 8794 个模块。**解除阻塞的判据是清楚的**:要么这棵树补齐 `src/agents/*` 与
`src/tts/*`(取消裁剪),要么上游把 `extractTextContentParts` 拆到不依赖 agent-runtime 的模块。
两者都不是 mem-plus 该单方面做的。

**能搬的已经搬了**:`types.ts` 的依赖闭包是 **0 个新文件**,十三个常量已从上游那份读。

### 按运行期闭包排序(2026-10-14 实测,17 个文件逐个走)

量法:只走**值 import**。`import type` 运行期被擦掉,不可能让模块加载失败,而这正是分界线 ——
`types.ts` 的两个 import 都是 type-only(所以加载正常),`query.ts` 的 agent-runtime 是值 import
(所以加载抛错)。走 type-only 边会把 `plugin-entry` 那个 barrel 整个拖进来,数字虚高。

| 上游文件 | 需新搬 | 装得下吗 |
|---|---|---|
| `doctor-contract-api.ts` | **0** | 能(但 mem-plus 无对应物) |
| `session.ts` | **0** | 能 |
| `config.ts` | 5 | 能 |
| `session-policy.ts` | 9 | 能 |
| `recall-state.ts` | 21 | 能 |
| `query.ts` | 7904 | 不能 |
| `prompt.ts` | 7905 | 不能 |
| `trigger-recall.ts` | 7910 | 不能 |
| `transcript.ts` / `watch` / `result` | 7911–7914 | 不能 |
| `recall-run.ts` / `recall.ts` / `index.ts` | 7921–7927 | 不能 |

**分界线正好落在「recall 的运行机构」与「recall 的配置/状态/策略」之间**:

- 小的四个(`config` / `session-policy` / `recall-state` / `session`)**不碰 agent-runtime 与
  会话存储**,所以闭包是个位数到二十几。`config.ts` 是上游那份
  `resolveActiveRecallPluginConfig`,也就是 `DeepRecallConfig` 该长的样子;`recall-state.ts` 是
  上游的召回结果缓存与断路器状态。**合计 35 个文件。**
- 大的那些(`prompt` / `recall` / `recall-run` / `transcript*` / `index`)都要 agent runtime、
  会话存储或转录镜像,闭包直接到 7900+。

**下一刀据此定为:搬 `config.ts` + `session-policy.ts` + `recall-state.ts`,用上游那份替换
`deep-recall.ts` 里的 `readDeepRecallConfig`、`DeepRecallConfig` 与自写的断路器 map。**
这是剩下最大的一块「我们自己改造的器官」,而且它装得下。

### `config.ts` 已搬(2026-10-14),闭包真的是 0

`extensions/active-memory/config.ts`(10 308 字节)与上游**逐字节相同**,`files` 已加,
运行期加载通过(11 个导出)。`readDeepRecallConfig` 现在只做一件事:把 `options.recall` 拆出来
交给上游的 `normalizePluginConfig(section)`。`DeepRecallConfig` 直接是上游的
`ResolvedActiveRecallPluginConfig` 类型,不是本地子集。

**键名不需要翻译**:上游把自己的输入类型为 `Partial<ResolvedActiveRecallPluginConfig>`
(`types.ts:135`),所以 `promptStyle` / `toolsAllow` / `timeoutMs` / `maxSummaryChars` /
`circuitBreaker*` / `promptOverride` / `promptAppend` 就是 mem-plus 原来那套键。

**换掉之后多出来的字段**(本地 reader 从前没有,现在由上游 resolver 填):
`queryMode`(且它带一条上游规则:`queryMode=message` → `promptStyle` 默认 `strict`,
`=full` → `contextual`)、`cacheTtlMs`、`timeoutMsIsDefault`、`transcriptDir`、
`thinking`、`fastMode`、`agents`、`allowedChatTypes/Ids`、`deniedChatIds`、`model`、
`modelFallback`、`setupGraceTimeoutMs`、`recent*`、`logging`、`persistTranscripts`。

**旧 reader 的两个缺陷,删掉即修**:
- **不夹取**。`timeoutMs: 999999` 会被原样接受,现在夹到 `MAX_TIMEOUT_MS` = 120000;
  `timeoutMs: 5` 夹到 `DEFAULT_MIN_TIMEOUT_MS` = 250;`circuitBreakerMaxTimeouts: 0` 夹到 1;
  `circuitBreakerCooldownMs: 1` 夹到 5000。
- **漏了一个 promptStyle 取值**。上游列六个(含 `preference-only`),本地只校验五个,所以用户写
  `preference-only` 会被静默变成 `balanced`。

顺带测出上游取值的三条分界(探针实测,不是推测):`>0` 走夹取;`<=0` 走
`parseOptionalPositiveInt` 回落默认 15000;**数字字符串会被接受**(`"9000"` → 9000)——
`opencode.jsonc` 是带注释的 JSON,`"timeoutMs": "9000"` 是很可能出现的写法,旧 reader 不认。

**一处顺带修掉的提示词缺陷**:`buildRecallPrompt` 此前把 `DEFAULT_MAX_SUMMARY_CHARS` 写死在
提示词里,而上游那份读的是 `params.config.maxSummaryChars`。用户设 `maxSummaryChars: 400`
时提示词仍说「under 220」。现在它接的是 `config.maxSummaryChars`。

### 量闭包时我犯的错,记下来

第一次量 `config.ts` 报「需新搬 5 个文件」(`src/infra/fs-observation-*`、
`file-watch-notifier`、`media/remote-workspace-file`)。**那是一次走三个起点**,
`query.ts` 的 agent-runtime 依赖被算到了 `config.ts` 头上。单独量 `config.ts` 是 0。

但真正让我发现的是另一件事:`audit-npm-pack` 报 **no drift**,而那 5 个文件既不在 `files`
也不被任何前缀覆盖 —— 按 P3 记的 2026-10-13 那一课,那就该是「打包带不走 = 装到用户机器上
是死的」。于是我手工把它们加进 `files`,audit 立刻报 DRIFT 并要 `--write` 删掉它们。

**做决定的是一次实验,不是推理**:把那 5 个移开再 `import` 一次 `config.ts`,照样加载。
所以 audit 是对的、我的测量是错的,那 5 个已从树里删掉。

> 这里还牵出一件更该记的事:树里当时有 **13 个我没建过的 10 字节文件**
> (`src/agents/*.ts`、`src/tts/tts.ts`、`src/plugins/plugin-metadata-snapshot.types.ts`),
> 内容全是 `export {};`,创建时间同一秒,未进 git。它们恰好是 tsc 报 `TS2307` 的那批缺失模块 ——
> **`export {};` 让缺失的模块「存在且为空」**:tsc 的错误消失,`import` 也不再抛,可任何从它
> import 真实绑定的代码运行期拿到的是 `undefined` 而不是一句清楚的 "Cannot find module"。
> 我查了 `link-openclaw-alias.mjs`(只写 `node_modules`)与 `bootstrap.ts`(不碰 `src/`),
> 都没有创建它们的代码,来源不明。**已全部删除**,并确认删掉后 `config.ts` 仍能加载、门仍
> 4240 = 基线。留一个来源不明的桩在树里,比留着 17 条明确的 `TS2307` 更糟 —— 后者至少
> 说清了缺什么。

## sqlite-vec:那段分支已删,因为它不是取舍(2026-10-14)

我先把它写成「需要用户拍板的取舍」,那是**没看活区数据就提问**,该纠正。

`memory-index-write.ts` 里那段手写的 `vectorReady` / `vectorUnavailable` 门已删。删之前把四件事
都测了:

- `sqlite-vec` **未安装**,也**不在 `dependencies` 里**;
- 上游的加载器 `packages/memory-host-sdk/src/host/sqlite-vec.ts` 在树里且逐字节相同,导出
  `loadSqliteVecExtensionFromPath` 与 `loadSqliteVecExtension`,但它要那个 npm 包;
- 上游的配置键(`memory.search.store.vector.extensionPath`)在 mem-plus 里**零出现**;
- 于是 `memory_index_chunks_vec` 不存在,对它的 `db.prepare` **确实抛错**,而旧代码把那个错吞掉
  —— **源码里那段分支看着是活的,运行期一次都没成功过。**

**为什么删掉不算功能损失**,三条都是量的:

1. 上游的 schema 声明 `embedding BLOB NOT NULL`,`buildMemoryIndexStrictSchema` 也不建那个
   vec 表 —— embedding 本来就存在 chunk 行上。探针:vec 表缺席时写入照常成功(`written=2`),
   `storeVector` 写那个列,`searchVector` 读那个列并返回命中。
2. **活区索引 1 996 行、24 个文件**(2026-10-14 实测)。有界扫描(`candidateLimit` 默认 20 000)
   在这个量级上花不掉可测量的时间,近邻索引换不来什么。
3. **活区有向量的行数是 0** —— 按 AGENTS.md,没有 `bge-m3` 模型时向量检索一直是关的。

所以缺的只是一个索引形态,代价是一个可选原生扩展加一个新设置项。删。

`clearSource` 里那段逐行删 vec 表的循环一起去掉了:那张表里从来没有东西可清。

## forget 的索引清理层:一次自创器官,查出来是三处死代码(2026-10-14)

`extensions/memory-core/src/memory-forget.ts`(20 147 字节)自称「ported」,注释里画了一张
上游表 → mem-plus 表的映射表。读代码才发现:**它查的 `documents`(5 处)、`units`(17 处)、
`units_fts`(5 处)、`vectors`(7 处)正是读侧切换(`e69541e9`)停写的那套表**,而且它用
`units.marker` 做血缘键 —— `marker` 两笔提交前刚退役。

结论:**读侧切过去之后,`memory_forget` 一条都删不掉,而报告照样是「成功」。** 活区还是旧版
表,所以这个缺陷在重新索引之前不可见。这不是取舍,是我上一刀漏了它。

照上游原件重写,搬进来一个文件、加了三处修正:

**搬入(逐字节)**

`extensions/memory-core/src/memory-forget-index-task.ts`,1325 字节,SHA256 与 openclaw 的
同名文件相同。它是**纯类型、零 import**,所以「照抄」没有成本可言;而 `ForgetIndexPlan`
的形状(`chunks: Array<{id, path, source}>`、`sources`、`ftsRows`、`vectorRows`)是报告要读的
契约,让它承重而不是当摆设。

**修的三处**(前两处是缺陷,第三处是顺带查出的旧错)

1. **`changedPaths` 用了 `absolutePath`。** 上游 `memory-forget.ts:356` 用的是
   `rewrite.relativePath`,因为索引里 `path` 是**相对记忆家目录**的正斜杠路径
   (`memoryRelativePath`,`plugin/src/memory-index.ts:80`),planner 直接 `has()` 比对。
   绝对路径永远匹配不上 —— 这是「删不掉」的第二重原因,和旧表那重独立。
2. **按 `(path, source)` 整源删除 → 按上游的 chunk id 删。** 照抄
   `memory-forget-index-read.ts:66-83` 的选法:文本 scrub 变了的 `memory` 语料 chunk 把自己的
   path 并进 `changedPaths`;筛选用 `changedPaths.has(path) || referencesSession(path, ...)`;
   删 `id IN (...)`。**`memory_index_sources` 只按 `removedPaths` 删,不按 changedPaths** ——
   被 scrub 过的文件还存在,它的表头也该留着。
3. **`embeddingCacheRows` 原注释写「no such table in mem-plus」,是错的。**
   `memory-index-schema.ts:75` 传 `includeEmbeddingCache: true`,表是建出来的。上游
   `memory-forget-kernel.ts:76-78` 每次 forget 都清空它。这棵树里没有运行期写者(只有
   `memory-schema.ts:549` 从旧 openclaw 库迁移),所以计数是 0 —— 但那是**如实报 0**,不是
   「表不存在」。

**顺带修的第四处:dry run 的索引计数恒为 0。** 旧代码把 plan 和 purge 合成一个函数,放在
dry run 的提前返回**之后**,所以 `dryRun` 永远报 `indexChunks: 0` —— 恰恰是 dry run 唯一该回答
的问题。上游是 plan 在 `:356`、report 在 `:371`、提前返回在 `:407`。现在拆成
`planMemoryForgetIndex` 与 `purgeForgottenMemoryIndex` 两个函数,和上游一样两个文件两个函数。

**记下来的三处真偏离**(都是「mem-plus 没有这个东西」,不是选择)

| 上游 | mem-plus | 为什么 |
|---|---|---|
| `sessions` 语料的 provenance 分支(`originClass === "system"`、`!isMemorySessionIndexable`) | 删掉,不誊写 | mem-plus 没有 session 语料,`IndexRoot` 只有 `home \| wiki`;誊过来就是读一张行不可能存在的表,还要引入本树没 vendor 的 `isMemorySessionIndexable` |
| `memory_index_chunks_vec` + `extensionPath` 准备 | `hasVectorTable: false`,向量数按 chunk 行 `length(embedding) > 0` 计 | 与已登记的 `vectorCount` 同一处替换;`embedding` 是 `BLOB NOT NULL`,「没有向量」是零长 BLOB |
| plan 在只读 worker、purge 在主连接 | 一个 `DatabaseSync` 上同步做完 | 上游那个 worker 是为了跨进程拿 openclaw 的 agent 库;mem-plus 自己开连接,少一层机器、同两步动作 |

`deleteMemoryIndexSources` 的分组(按 source 分组、每组一条 `path IN (...)`)也没抄:mem-plus
不留 session 语料,一份 plan 里每个被删文件一行,分组会塌成一条语句,逐行写等价。

**验证**:26 条断言全过,走真实入口 `forget()`(`plugin/src/forget.ts`)。包括 —— 旧表/`marker`
的引用在代码里归零(剥注释后正则)、vendored 文件 SHA256 与上游相同、dry run 报出计划值 1 且
真跑报同一个值、真跑删掉 1 行且报告数字对得上、含空格路径的源被删而**同名的 `wiki` 语料文件
没被删**(`source` 列分开,不是按路径)、FTS 行随触发器消失、provenance 行级联、文件内容里
promotion 条目被 scrub 掉、`searchText` 搜不到已删内容。

**踩到的一件事,记下来**:血缘数据库**不受 `XDG_CONFIG_HOME` 管**。`openMemoryOriginDatabase`
→ `resolveStateDir`(`src/config/state-dir.ts:28`)读 `OPENCLAW_STATE_DIR`,读不到就落到
`$HOME/.openclaw`。探针只设 `XDG_CONFIG_HOME` 时,它指向的是**用户真实的
`.openclaw\agents\main\agent\openclaw-agent.sqlite`**。这次它在写入前就因 schema 版本 0 抛错,
没造成改动,但下一次不一定。两个根都要指走:`XDG_CONFIG_HOME` 给配置,`OPENCLAW_STATE_DIR` 给
状态。

## 参照物本身会过期:三次量「与上游的差异」都量错了对象(2026-10-14)

这一节记的是一个**测量方法**的错,不是代码的错 —— 它污染了前面几笔的判断,所以放前面。

起因:扫全树找「自称是 port、上游却有原件」的文件时,`extensions/memory-core/src/
dreaming-phases.ts`(52 714 字节)排第一,看起来有 58 个 hunk 的本地改动,而且**文件头没有一句
说明,`docs/port-plan.md` 里也没有登记**。按「照搬上游」的判据,这是最该清理的一处。

三个日期放在一起才看清真相:

| | 日期 |
|---|---|
| 本树 vendored 这份文件 | **2026-09-30**(`df09d576 Import memory subsystem from openclaw`) |
| 本地 openclaw 检出 `d1ebf36cd` | **2026-10-08** |
| 上游真实 HEAD 改这个文件 | **2026-10-13**(`c8c0e6fbc refactor(plugins): consolidate lifecycle and policy paths (#170596)`) |

也就是说:那 58 个 hunk 里**大部分是上游自己 09-30→10-08 的改动**,mem-plus 只是没收到。而我
用来当尺子的那个检出,本身也落后真实 HEAD 五天。

(`github.com:443` 对 git 协议时通时不通,所以取历史用 `gh api`:`repos/openclaw/openclaw/
commits?path=<file>` 拿提交列表,`contents/<file>?ref=<sha>` 拿那天的字节。本地检出是浅克隆,
`--deepen` 在列 ref 阶段就断,只有 api 走得通。)

**怎么定案的**:`gh api` 取回 09-30 那天的两个文件,和本树逐行比 —— 差异只有 119 行,不是 58 个
hunk。分类之后,绝大部分是**无理由的风格改写**。

### 撤掉的本地改写(以 09-30 上游为底重建,两份文件现在逐字节等于上游)

`dreaming-phases.ts`:

1. **`lines[index]!` → `typeof line !== "string"` 运行期检查(2 处)。** 两边 tsconfig 都开着
   `noUncheckedIndexedAccess`(本树 `tsconfig.json` 与上游 `tsconfig.json` 都验过),所以上游的
   `!` 是必需的,不是可以省的写法。改掉之后数组里有洞就从「抛错」变成「静默丢行」。
2. **`flatMap` → `for` 循环**(3 处:`buildLightDreamingBody`、`buildRemReflections`、
   `collectDailyIngestionBatches`)加 `.filter().map()` 类型守卫重构。纯风格,输出相同。
3. **`collectSessionIngestionBatches({ ...params, state })` → 逐字段列举。** 展开写法不会被
   漏字段,列举写法会。
4. **`Math.max(1, Math.max(files.length, 1))`** —— 多套一层,等价。
5. **两句自己加的注释。** 其中「Use the shared CJK-aware similarity helper so close-but-not-
   identical CJK snippets do not slip past the dedupe threshold via the old ASCII-only path」
   底下**根本没有代码差异**:`dedupeEntries` 的函数体与上游逐字节相同,上游本来就在调
   `snippetSimilarity`。那句注释描述的是一个不存在的本地改动。
6. **`primaryWorkspaceDir` 与 `nowMs?` 不是本地加的** —— 09-30 上游本来就有;10-08 上游把
   `nowMs` 收紧成必填。差点照着 10-08 去「修」,那就是把上游的收紧当成自己的漏洞。

`session-ingestion.ts`:**把 `sessionExclusionReason` 的 `policy` 与 `forgottenSessionIds`
改成可选,并在没传时自己去查 `listMemorySessionTombstones`。** 上游两个参数都是必填,唯一的
调用方(`dreaming-phases.ts`)两个都传,那条回退分支是死路 —— 而且它每次调用多一次数据库查询。
一并撤掉,`listMemorySessionTombstones` 的 import 也随之消失(上游没有这条边)。

### 一个我**没有**照搬的上游缺口,登记在此等人拍板

本地被撤掉的一处是真实行为差异,不是风格:

```ts
// 本树(已撤):分块时除了行数上限,还看拼出来的 snippet 是否超长
const shouldSplit = chunkLines.length > 0 &&
  (chunkLines.length >= DAILY_INGESTION_MAX_CHUNK_LINES ||
   candidateSnippet.length > DAILY_INGESTION_MAX_SNIPPET_CHARS);
// 上游 09-30 与 10-08 都只有行数上限,所以单个块可以超出 snippet 上限
if (chunkLines.length >= DAILY_INGESTION_MAX_CHUNK_LINES) { flushChunk(); }
```

按「照搬上游、不许自创」这条,现在代码是上游的形状,代价是每日语料的单块可能超过
`DAILY_INGESTION_MAX_SNIPPET_CHARS`。要恢复那个上限,得先确认它进不进 `docs/memory-chain.md`
的已知缺陷表 —— AGENTS.md 写的是「不静默修上游的已知缺陷」,而这一条没人记过,所以这次按规矩
照搬并登记,而不是顺手留着。

### 为什么不能直接跳到 10-08 或 HEAD

上游 10-08 的 `dreaming-phases.ts` 已经在调 `resolveSessionIngestionFileCap`,而 10-08 的
`session-ingestion.ts` 才导出它。追上去要连带把 `src/config/sessions` 整层同步到上游版本,而实测:

- **3 个生产模块完全不在树里**:`session-memory-targets.ts`、`session-memory-targets.types.ts`、
  `session-transcript-inventory-runtime.ts`;
- **6 个在树里但内容不同**:`session-accessor.sqlite-contract.ts`(7 418 字节,树里**没有**)、
  `session-accessor.sqlite-entry.ts`、`session-accessor.sqlite-history.ts`、
  `session-accessor.sqlite-participant-read.ts`、`session-canonical-key.ts`、
  `session-entry-read-runtime.ts`、`session-store-path.ts`。

本树的 `src/plugin-sdk/memory-core-host-engine-sessions.ts` **与 09-30 上游逐字节相同**(一度被
我误判成手写门面),它没有 `loadMemorySessionMetadataBatch` 是因为 09-30 的上游也没有 —— 那不是
本地缺失。

所以这和 `prompt.ts`、`trigger-recall.ts` 是同一类墙,但原因写下来了:**vendored 快照是 09-30,
本地上游检出是 10-08,真实 HEAD 是 10-13;追上任何一档都要连带搬 openclaw 的会话存储层。**
判定仍是「先量需求侧」:mem-plus 没有 session 语料、没有 agent 数据库的 worker 写入通道。

验证:16 条断言全过,走真实入口 `runDreamingSweepPhases`。store 用宿主自己的
`createStorageOpenKeyedStore`(`plugin/src/kv.ts:225`)包一个 Map 背的 `ctx.storage` ——
`plugin/src/index.ts:155` 就是这么接线的,所以 keyed store、`observe`/`compareAndApply` 和
workspace lock 跑的都是真代码,只有最外一圈被替掉。含:两份文件与 09-30 上游 SHA256 相同、
`!` 断言回到两处、`flatMap` 三处回来、`{ ...params, state }` 回来、`session-ingestion` 不再自查
tombstone、sweep 不抛错、返回形状就是上游的 `{ degradedPhases, pendingNarratives }` 且
`degradedPhases === 0`(两个 phase 都没降级)、`MEMORY.md` 没被写坏。

`ctx.storage` 需要四个方法而不是三个(`get`/`set`/`remove`/`scan`),`scan` 的分页形状是
`{ entries, next }`(`plugin/src/kv.ts:72`)—— 记下来,下次接这个 store 不用再撞。

## 「按 09-30 完成」的全量普查(2026-10-14 实测)

上一节查明参照物会过期之后,顺手把整棵记忆树量了一遍 —— 不再是一个文件一个文件地撞。

量具:`node scripts/audit-upstream-drift.mjs [--ref <sha>] [--stage <dir>] [--json <file>]`。
判据是**逐字节**:git blob SHA 是文件字节的哈希,拿上游整棵树(`gh api
repos/openclaw/openclaw/git/trees/<sha>?recursive=1`,一次调用)的 SHA 和本树的 SHA 对比,不用
下载任何文件内容。自检过:三个已知逐字节相同的文件
(`src/plugin-sdk/memory-core-host-engine-sessions.ts`、`extensions/active-memory/types.ts`、
`extensions/memory-core/src/memory-forget-content.ts`)全部判为相同,零假阳性 —— 两边行尾归一化
若有差异,这里会暴露成假的「不同」。

排序按**真实差异行数**,不按文件大小。这一点是量出来的:记忆路径上最大的那个文件对快照只差
+2/-2 行,而 33 KB 的文件可能只差一行;按大小排会把活派到错的文件上。

### 结果(参照 `6daee6e4bd`,2026-09-30)

| | |
|---|---|
| 记忆路径本地文件 | **177** |
| 与 09-30 上游逐字节相同 | **111**(62%) |
| 有差异 | **66** |
| 差异总量 | **+1989 / -2151 行** |
| 上游有、本树没有 | 1241 个代码文件(绝大多数是测试文件,本仓库有意不搬,**不是偏离**) |

前 20 名(这一栏就是接下来要做的活,按顺序):

| +行 | -行 | 文件 |
|---|---|---|
| 537 | 477 | `extensions/memory-core/src/memory-forget.ts` |
| 37 | 651 | `src/plugin-sdk/session-transcript-runtime.ts` |
| 303 | 209 | `extensions/memory-core/src/memory-entry-origins.ts` |
| 84 | 86 | `packages/memory-host-sdk/src/host/internal.ts` |
| 50 | 80 | `src/plugin-sdk/memory-host-core.ts` |
| 91 | 37 | `packages/memory-host-sdk/src/host/query-expansion.ts` |
| 69 | 43 | `extensions/memory-core/src/standing-intents.ts` |
| 79 | 19 | `extensions/memory-core/src/memory-budget.ts` |
| 9 | 68 | `extensions/memory-core/src/memory-session-tombstones.ts` |
| 53 | 20 | `extensions/memory-core/src/dreaming-dreams-file.ts` |
| 36 | 29 | `extensions/memory-core/src/short-term-promotion-artifacts.ts` |
| 19 | 42 | `extensions/memory-core/src/memory/manager-cpu-entrypoints.ts` |
| 40 | 20 | `extensions/memory-core/src/short-term-promotion.ts` |
| 36 | 22 | `extensions/memory-core/src/short-term-promotion-stats.ts` |
| 36 | 13 | `extensions/memory-core/src/dreaming-narrative.ts` |
| 37 | 8 | `packages/memory-host-sdk/src/host/session-files.ts` |
| 21 | 23 | `packages/memory-host-sdk/src/runtime-core.ts` |
| 13 | 28 | `extensions/memory-core/src/dreaming-state.ts` |
| 31 | 6 | `extensions/memory-core/src/concept-vocabulary.ts` |
| 26 | 11 | `extensions/memory-core/src/short-term-promotion-utils.ts` |

### 第五批:回退 20 个文件,以及六个「回退会引入断链」而保留的

这一批把剩下的文件扫完,分三处发现。

**一、两处是真的丢了东西,回退。**

`src/memory/memory-artifact-provenance.ts` 与(上一批的)`dreaming-state.ts` 是同一个错:
上游用 `store.entriesInKeyRange({ keyStartInclusive: "<wsKey>:", keyEndExclusive: "<wsKey>;" })`
做范围读,并**按 `createdAt` 稳定排序**(上游注释:「Stable sorting preserves the store's key
order when creation times tie」);本树两处都换成了 `entries()` 全量读再在 JS 里按前缀过滤,
排序也没了。

`extensions/memory-core/src/dreaming-ingestion-state.ts` 删掉了
`try { await Promise.all(writes) } finally { await Promise.allSettled(writes) }`,换成裸
`await Promise.all([...])`。上游那句注释就是这件事的理由:「Checkpoint writes must settle
before a failed sweep releases its workspace lock.」—— 裸 `Promise.all` 在第一个失败处就 reject,
剩下的写入可能还没落定,而 workspace 锁已经被释放了。

**二、六处「把上游的共享 helper 内联重写」,回退。** `resolveIntegerOption`(multimodal)、
`avoidTrailingHighSurrogateBreak`(embedding-input-limits,这是第二次 —— `session-files.ts` 那次
已回退)、`escapeRegExp`(memory-host-markdown)、`resolveGlobalMap`(runtime-store-registry)。
`extensions/memory-core/src/short-term-promotion-types.ts` 把
`PromotionCandidate = Omit<ShortTermRecallEntry, ...> & {...}` 展开成手写字段清单 —— 派生写法
会自动跟随上游,清单不会。

**三、六个文件回退会重新引入断链,保留并登记。** 实测:把这六个换回上游版本,plugin 门从 4240
变成 4241,新增的那一条每次都落在它们引用的、trim 时已被删掉的类型模块上:

| 文件 | 上游引用但本树没有的东西 |
|---|---|
| `src/plugin-sdk/access-groups.ts` | `../channels/plugins/types.public.js`、`../config/types.access-groups.js`、`../config/types.openclaw.js` |
| `src/plugin-sdk/facade-loader.ts` | 同上(`PluginInstanceHandle` 的形状来自其中之一) |
| `src/plugin-sdk/plugin-state-runtime.ts` | `../config/sessions/session-entry-current.types.js` |
| `src/plugin-sdk/plugin-entry.ts` | `../plugins/types.js` 的三个成员、`../plugins/capability-catalog-context.types.js` |
| `src/plugin-sdk/memory-core-host-runtime-core.ts` | `../config/config.js` 的 `OpenClawConfig`、`../config/types.memory.js` |
| `src/memory-host-sdk/dreaming.ts` | `../config/types.openclaw.js` |

**回退它们只换来删掉几行类型导出与注释,却把断链引回来,收益与风险不成比例**,所以保留本树
版本。这一条也是 AGENTS.md 那个判据的正面使用:「`src/` 或 `packages/` 下新出现的错误通常意味
着一条新的断链」—— 逐个二分定位,不是靠猜。

另两处同类、代码内已有说明:`packages/memory-host-sdk/src/host/embedding-chunk-limits.ts` 与
`embedding-model-limits.ts` 把 `EmbeddingProvider` **内联声明**成
`{ id: string; maxInputTokens?: number }`,理由是别名模块与其目标
`src/plugins/embedding-provider-types.ts` 都被 trim 删了(`3b4f6b6d`);两个文件用的正是上游契约里
那一个字段,且两处都已被 `Pick` 收窄。

Validation: 20 个回退文件与 09-30 上游逐字节相同(20/20)。逐个确认被撤的改写回来:两处范围读与
`createdAt` 排序、`allSettled` 兜底与它那句注释、四处共享 helper、派生类型写法。运行期:经宿主
自己的 `createStorageOpenKeyedStore` 写入三条再读回三条;五个改过 import 图的模块逐个真导入
通过(不是只做正则匹配)。门:plugin 4240(基线 4240,自有路径 0 错)、capture 331、`no drift`。

**过程中撞到并记下两件事。** 一是二分定位时用 `git checkout HEAD -- <files>` 做隔离,那会把
已回退的文件还原回本树版本,重做批次时漏了两个,靠「审计数没变」才发现 —— 回退后必须用漂移
审计复核,不能只看类型门。二是探针结尾 `fs.rmSync(TMP)` 把探针自己删了(它在 TMP 里),下一轮
直接 `ERR_MODULE_NOT_FOUND`。

### 第六批:剩下 16 个回退,以及最后两处保留

收尾这一批仍是三类。

**回退(16 个)。** 多数是等价重写:`file-lock.ts`(把 `asNullableRecord` 包一层
`asLockPayload`)、`session-transcript-corpus.ts`(上游的 `resolveSessionOwnership` 闭包在两个
调用点被原样内联,逻辑一致,顺带那个内联的 `normalizeComparablePath` 也能去掉了 ——
`fs-utils.ts` 上一批已回退,那个导出回来了)、`short-term-promotion-rehydrate.ts`(把「目标
snippet 为空」单独拆一支;上游 `!targetSnippet` 分支返回的本来就是 `exactSnippet`,等价)、
`mmr.ts`(`[...items].toSorted` 里的拷贝是多余的,`toSorted` 本身就返回新数组)、
`embedding-vector.ts`(空数组的提前返回)、`windows-spawn.ts` 之外的
`retry-runtime` / `concurrency-runtime` / `time-runtime` / `sqlite-worker-runtime` /
`session-store-runtime` / `host/sqlite.ts`(挪了一个 import 或加了一行注释)。

两个是**死代码**,回退等于删除:`extensions/active-memory/config.ts` 给
`resolveDefaultToolsAllow` 加了 `recallToolNames` 参数,而全树**没有任何调用方**传它 ——
`deep-recall.ts` 的注释还明说「`cfg` 与 `recallToolNames` 被省略,这正是上游自己的调用形状」。
`src/plugin-sdk/memory-host-search.ts` 加了 9 个导出,其中 `isActiveMemoryProviderNative`、
`MemoryCallerAuthority`、`MemoryHealth`、`MemoryReference`、`ActiveMemoryProviderResult`
**零外部引用**,而且它 re-export 与动态 import 的两个目标
(`src/plugins/memory-provider-types.ts`、`src/plugin-sdk/memory-host-search.runtime.ts`)
**在本树都不存在**;这个门面本身也没有任何调用方。

**保留(2 个),登记在此。**

`src/plugin-sdk/file-access-runtime.ts`(+0/-20)看着像「删了上游 20 行 re-export」,实际不是:
上游那 20 行 re-export 的**五个目标在本树全部不存在**(`@openclaw/fs-safe/watch.ts`、
`src/infra/fs-observation-mode.ts`、`file-watch-notifier.ts`、`fs-observation-root.ts`、
`fs-observation-snapshot.ts`),而本树同名文件是一个**完全不同的 FS 安全门面**,被
`src/plugin-sdk/config.ts`、`extensions/memory-core/src/short-term-promotion-memory-write.ts`、
`src/plugin-sdk/security-runtime.ts` 三处引用。回退会直接弄坏这三个调用方,保留并登记。

`extensions/active-memory/escalation.ts`(+12/-0)是**只增不改**:在语言表里加了一组葡萄牙语
模式(`intent` / `future` / `retrospective` 三条正则与一段说明 `-amos` 动词现在时/过去时同形、
所以 `lembra` 需要一个回指疑问词而不是裸问号)。上游那个文件本身没被改动一行,这是往一张表里
加一条语言,不是改上游的行为。保留并登记 —— 它是**功能新增**而不是形态偏离,若要收敛只能是把
葡语拿掉或推给上游,那是产品决定不是搬运决定。

### 收尾时探针逮到的三处:不是回退,是既有状态(2026-10-14)

收尾探针逐个真导入本轮动过的模块,`retry-runtime.ts` / `time-runtime.ts` /
`concurrency-runtime.ts` 三个报 `ERR_MODULE_NOT_FOUND`。查下来**不是这一批回退造成的**:

| 文件 | 缺失的目标 | 本树版本 | 上游 09-30 版本 | 调用方 |
|---|---|---|---|---|
| `src/plugin-sdk/retry-runtime.ts` | `src/infra/retry-policy.ts` | 同样引用(L50) | 同样引用 | 1 处 |
| `src/plugin-sdk/time-runtime.ts` | `src/infra/format-time/format-datetime.ts` | 同样引用 | 同样引用 | 0 |
| `src/plugin-sdk/concurrency-runtime.ts` | `src/shared/permit-pool.ts` | 同样引用 | 同样引用 | 0 |

**两个版本在本树都 import 不了**,因为它们指向的模块都被 trim 删了。所以这三个文件与上游的
1-4 行差异在运行期没有意义(文件根本加载不起来),保留本树版本(未知的 delta 更少)并登记。
那 1 处 `retry-runtime` 的引用来自 `src/`,是 openclaw 自己的路径,不在本插件的加载链上。

**这一条是探针的价值所在**:类型门对这三个文件一直是绿的(缺失模块的报错在别的路径下被算进
`src/` 的 4240 基线里),只有真 `import` 才会炸。AGENTS.md 那条「门只覆盖类型,不覆盖加载」
在这一批又兑现了一次 —— 如果这一批没跑导入测试,这三个门面就会带着断链进下一轮。

## 第二类「血管」的集中登记:上游的 async-worker 在本树是 sync 直连(2026-10-14)

这一类不用回退 —— 形态差异是宿主决定的,不是抄错了。但按规矩必须登记在此,而不是只写在
代码注释里。三处,逐个都量过:

| 文件 | 差异 | 证据 |
|---|---|---|
| `extensions/memory-core/src/memory-entry-origins.ts`(+303/-209) | 上游**全 async 走 worker**(`createLazyRuntimeModule` / `resolveRuntimeWorkerUrl` / `openOpenClawAgentSqliteWorkerStore` / `runOpenClawAgentWriteAdmission` / `withOpenClawAgentDatabaseAsync`),本树**全 sync 直连 `DatabaseSync`**;并多导出 `recordMemorySessionTombstonesInDatabase`、`recordMemorySessionTombstones`、`deleteMemoryEntryOriginsInDatabase` 三个 `...InDatabase` | 上游把 `recordMemorySessionTombstonesInDatabase` 放在 `memory-entry-origins.worker.ts:76` 里调,worker 是它的调用边界;mem-plus 没有 worker,而 `memory-forget.ts`(上游经 `withMemoryForgetWorker` 跑)要直接调。**连带效果**:`memory-session-tombstones.ts` 本树比 09-30 上游小 1940 字节,因为那个函数整段搬到了这里 —— 逐行读过,分批插入(128 个绑定一批)、`runSqliteImmediateTransactionSync`、`memory_index_state.revision` 栅栏、上游那句「A shadow index can have no published chunks yet」的注释全都在。搬,不是丢 |
| `extensions/memory-core/src/memory-forget.ts`(+537/-477) | 同上(上游经 `withMemoryForgetWorker`);另外上游把索引清理拆成 `memory-forget-index-read.ts` / `memory-forget-kernel.ts` / `memory-forget-index-sources.ts` 三个文件,本树在 `memory-forget.ts` 里内联 | 已照抄上游的**选法与删法**(`memory-forget-index-read.ts:66-83` 的筛、`memory-forget-kernel.ts:54-105` 的删),详见本文件「forget 的索引清理层」一节;内联是因为没有 worker 可拆。`memory-forget-index-task.ts`(纯类型、零 import)已逐字节搬入 |
| `src/plugin-sdk/session-transcript-runtime.ts`(本树 1945 字节 / 上游 24267) | 上游 re-export 一批会话转录**函数**,本树只留**一个类型** | 对 09-30 快照实测:它的 16 个相对说明符里**8 个在本树解析不到**(`../agents/sessions-yield-context`、`../config/types.openclaw`、`../gateway/session-catalog-identity`、`../gateway/session-transcript-catalog`、`../media/prompt-image-input`、`./agent-core`、`./session-transcript-lock-runtime`、`./session-transcript-memory-hit`),所以整模块不可打包。那个类型是承重的:`extensions/active-memory/types.ts`(与上游逐字节相同)第 2 行导入它、224 行 `export type ActiveMemoryTranscriptSource = SessionTranscriptTargetParams`。**代码注释原来写「seven imports」,数字错了,已改成 eight 并列出清单** |

同类里还有 `standing-intents.ts`(+69/-43),那一处代码里本来就有 `MEM-PLUS DEVIATION (open +
dispatch)` 说明,登记在此即可:去掉了 admission owner 与 worker 线程,直接调上游的
`bindSqliteWorkerBackend` 并传一个空 `admit`(`plugin/src/kv.ts:83` 那段注释解释了 OpenCode
的 `ctx.storage` 是 last-writer-wins,CAS 只能是尽力而为)。

**共同点**:上游的 `async` 不是为了异步 IO,而是为了把写入关进一个**有 admission 与事务边界的
worker 进程**。本树是单进程同步写入,那道边界在 `plugin/src/kv.ts` 与
`memory-workspace-lock.ts` 里以另一种形式保留(workspace lock + CAS)。所以形态变了,保证没有
变少 —— 但这是**论证**,不是**照抄**,写在这里备查。

### 逐个看下来,漂移分三类(2026-10-14;第三类的定性后来被推翻,见下)

**一、注释与风格噪音。** 回退。`memory-budget.ts` 把上游的一行注释扩成了三段文件头;
`dreaming-phases.ts` 的 `flatMap` 换循环(上一节已撤)。

**二、血管。** 保留并登记。`memory-entry-origins.ts` 的 303 行主要是:**上游全 async 走 worker
(`createLazyRuntimeModule` / `resolveRuntimeWorkerUrl` / `resolveStateDir`),本树全 sync 直连
`DatabaseSync`**,并多导出 `recordMemorySessionTombstonesInDatabase`、
`recordMemorySessionTombstones`、`deleteMemoryEntryOriginsInDatabase` 三个 `...InDatabase`
函数 —— 上游把它们关在 worker 里,而 mem-plus 没有 worker,`memory-forget.ts`(上游经 worker 跑)
要直接调。`memory-session-tombstones.ts` 本树小 1940 字节,是因为 `recordMemorySessionTombstonesInDatabase`
**整段原样搬到了 `memory-entry-origins.ts`** —— 逐行读过,分批插入(128 个绑定一批)、事务、
`memory_index_state.revision` 栅栏、上游那句「A shadow index can have no published chunks yet」
的注释,全都在。搬,不是丢。

**三、多余的防御性改写 —— 读代码时我把它误判成了「本地修了上游的 bug」。**

`memory-budget.ts` 的 `parseMemoryBlocks`:本树多了一个 `currentKind` 标记,和上游的
`currentDate` 一起出现在每个条件里(`currentKind === "promotion" && currentDate && ...`)。
我当时判断:上游只看 `currentDate`,所以「见过日期标题之后紧跟的任何 setext 标题都可能被当成
promotion 段,而 compaction 会丢最旧的自动提升段」—— 于是一段不是自动提升的内容可能被丢掉,
本树的版本不会。**那个判断是错的。**

错在哪:两个变量只在**同两个地方**被赋值 —— `flush()` 里一起重置,遇到
`## Promoted From Short-Term Memory (...)` 时一起设置。于是恒有
`currentKind === "promotion"` ⟺ `currentDate !== undefined`,本树多写的那一半判断从头到尾没有
独立作用。差分实测也证实:把两份文件同时加载,10 组输入 × 10 档预算 = 101 例,
`compacted` 与 `droppedDates` **逐例一致**;并且先确认丢弃分支真的触发过(预算 40 时丢
`["2026-10-01"]`,三段的全丢),否则这个差分测法是空的 —— 全都不丢东西时输出一致是必然的。

所以它属于**第一类**(没有理由的多余改写),已在上下一批回退。教训是:我又一次凭读到的代码下了
结论,没有实测。AGENTS.md 那条硬规矩(「凭假设改而不是凭读到的代码」)和「绿色的检查如果没有
走到出错路径,比没有检查更糟」,这里两条都撞上了。

`extensions/active-memory/escalation.ts` +12/-0、只增不改,看着像加了新逻辑 —— 这条**还没查**,
不许照着「只增不改」就判定性质。

**第四类是否存在,目前没有证据。** 我原先说有第三类(本地修上游的 bug),现在这个例子被推翻了;
剩下的文件里是否还有真修了上游 bug 的,只能一个一个读 + 差分实测才知道,不能先立一个类目再
往里塞。

`src/plugin-sdk/session-transcript-runtime.ts` 单独记一笔:本树 1945 字节,上游 24 267 字节
(-651 行)。这是有意砍掉的一整块(会话转录的运行时),不是逐行改写,判定为「宿主不需要所以没搬」——
同样**还没验证**。

### 第二批:回退 6 个文件,差异 +1989/-2151 → +1673/-1912

按上表顺序往下走,这一批回退 6 个,全部换成 09-30 上游原件(逐字节相同)。逐个读出来的原因:

**`packages/memory-host-sdk/src/host/internal.ts`(+84/-86)—— 删掉了两样能力,不是简化。**

1. `matchesExtraMemoryPathEntry` 的 `options?: { directory?: boolean }` 参数和配套的目录感知
   匹配器(`segments.slice(0, length)` 那段前缀匹配)被删了,而**上游自己的
   `internal.ts:247` 就在用 `{ directory: true }` 调它**,本树把自己的调用点改成了不传。
2. 额外路径**按根目录归组**的 `extraPathsByRoot: Map<string, NormalizedExtraMemoryPath[]>`
   被换成逐条循环:同一个根扫 N 遍,`collectMemoryFilesFromDir` 的参数从数组变成单个条目。

后果是用户可见的:额外记忆路径按目录配置时不再按上游语义匹配,同根多 pattern 会重复遍历、
可能重复收录。

**`packages/memory-host-sdk/src/host/fs-utils.ts`(+1/-8)—— 是根。** 上游的
`normalizeComparablePath`(以及 `path` 的 import)被删了,所以
`session-files.ts` 才不得不把它内联。**先回退这个,后面那个才回退得掉** —— 顺序反过来会
留下一个内联副本。

**`packages/memory-host-sdk/src/host/session-files.ts`(+37/-8)—— 内联重写了上游的共享工具。**
`avoidTrailingHighSurrogateBreak`(上游从 `@openclaw/normalization-core/utf16-slice` 拿)被换成
自己写的 `isHighSurrogate`/`isLowSurrogate` 配对判断。查过那个子路径:
`node_modules/@openclaw/normalization-core/utf16-slice.ts` **存在**,桩包的 `exports` 里也有
`"./utf16-slice"` —— 所以没有借口。另外 `normalizeSessionText` 前面多加的
`.replace(/\s*\n+\s*/g, " ")` 是多余的,后面那句 `replace(/\s+/g, " ")` 已经把换行折成空格。

**`src/plugin-sdk/memory-host-core.ts`(+50/-80)—— 丢了两样。** 事件导出的两阶段发布协议里,
`{ kind: "pending-missing" }` 这个归属状态和识别它的 `pendingContentSha256` 判断被删了;以及
`listMemoryWorkspacePublicArtifacts` 里按 `${workspaceDir}\0${relativePath}\0${kind}` 去重的
`Map` 被删了,改成直接返回原数组(于是可能返回重复产物)。
**修正一处我自己的误读**:那版把「owner 标 pending → 写产物 → owner 清 pending」的两个分支合并成
了一条序列,finalize 那一步**并没有丢**,所以回退的理由是上面两样,不是「少了一步」。

**`packages/memory-host-sdk/src/host/query-expansion.ts`(+91/-37)—— 纯风格。**
`isValidKeyword` 从上游的一个布尔表达式拆成四个 if(逐条核对,逻辑等价),外加一个文件头注释。

**`extensions/memory-core/src/dreaming-dreams-file.ts`(+53/-20)—— 删掉了去重。**
`dedupeDiaryBlocks`(按 `normalizeDiaryBlockFingerprint` 去重梦日志段落)整个没了;
`joinDiaryBlocks` 前面加的 `if (blocks.length === 0) return ""` 也是多余的,
`[].map(...).join("")` 本来就是 `""`。

**保留的(血管,已有代码内登记)**:`standing-intents.ts`(+69/-43)有一句明确的
`MEM-PLUS DEVIATION (open + dispatch)`,说明去掉了 admission owner 和 worker 线程、直接调
`bindSqliteWorkerBackend` 并传一个空 `admit`,并说明 dispatch 本身是上游的。这属于血管,登记即可。

验证:22 条断言全过。含六个文件与 09-30 上游逐字节相同;被删的能力逐个用正则确认回来了
(directory 选项、目录前缀匹配、`extraPathsByRoot`、`pending-missing`、去重 Map、
`dedupeDiaryBlocks`、surrogate 边界改回共享 helper);以及**走真实入口 `listMemoryFiles` 的运行期**
—— 额外记忆目录被收进来、工作区自己的文件也在、**同一根下两个 pattern 合起来正好两个文件且
不重复**(4 条 / 4 个不同,回退前那个版本每个 pattern 各走一遍)、不匹配的嵌套 pattern 被排除。

## 三个血管文件的归属(2026-10-14 逐个查过)

`recall-inject.ts` / `recall-intent.ts` / `recall-taint.ts` 都**不是**可搬的自创器官:

| 文件 | 归属 | 依据 |
|---|---|---|
| `recall-inject.ts` 177 行 | **血管**。自述「the host half of both」 | OpenCode 的 `prompt` / `context` 两个 hook 是宿主形状,上游没有;而它复用的 `resolveTriggerRecall` 与 `prepareProjectMemoryBootstrap` 都已走上游 |
| `recall-intent.ts` 98 行 | **血管**。宿主能力(翻译) | 上游的 `hasRecallIntent` 保持逐字不变并被直接调用,前面只加一步翻译。这是上游没有的能力,不是它的重写 |
| `recall-taint.ts` 116 行 | **誊写,而且搬不了** | 见下 |

**`recall-taint.ts` 有第二个独立理由不能搬**(第一个是 P0 记的「上游那个标记没有生产者」):
`isRecalledMemoryMessage` 在 `session-files.ts:544` 是 `function`,**没有 `export`** —— 它是该文件
私有的。那份文件确实在树里(924 行)、7 个兄弟模块也都在树里,但它的 8 个导出里没有一个是 taint
守卫:

```
readSessionEntryResetRecallCutoff / matchesSessionEntryPrefixHash / sessionPathForFile /
sessionPathForSessionIdentity / parseCanonicalSessionSyncTargetFromPath /
statSessionEntrySync / buildSessionEntry / buildSessionEntryInProcess
```

**所以就算把 `session-files.ts` 整个搬进来,也拿不到那段排除逻辑。** 需要的是上游把那个函数导出,
那是改上游源码。

## 树里已 vendor 但无人引用的上游文件:21 个 / 25.9 KB

扫出来按大小排,前几个:`sqlite-vec.ts` 4546、`memory-schema-recall.ts` 3197、
`memory-schema-provenance.ts` 2612、`embedding-vectors.ts` 1985、`remote-http.ts` 1750、
`status-format.ts` 1529、`sqlite-vec-platform-variant.ts` 1263、`openclaw-runtime-io.ts` 1210。

**注意这个「无人引用」是「无人直接引用」**:`memory-schema-recall.ts` 与
`memory-schema-provenance.ts` 是被 `buildMemoryIndexStrictSchema` 间接调到的(那个函数就在
`memory-index-schema.ts` 里),所以它们不是孤儿。扫的时候必须区分直接与间接,否则会把已接上的
器官当成没接。

**先量需求侧,再量供给侧。** 两个文件的闭包都不大(9 与 15 个文件),但先要问「mem-plus 有没有
这个概念」:

| 上游导出 | mem-plus 有没有对应物 |
|---|---|
| `resolveChatType` / `isAllowedChatId` / `isActiveMemoryGloballyEnabled(cfg)` | **无**。mem-plus 不是聊天客户端,没有 channel/telegram/discord 概念,也没有 `OpenClawConfig` |
| `resolveCommandSessionKey` / `formatActiveMemoryCommandHelp` | **无**。全树搜不到任何命令注册 |
| `isSessionActiveMemoryDisabled` / `setSessionActiveMemoryDisabled` | **无**。没有按会话禁用的概念 |
| `shouldSkipActiveMemoryForHarnessSession` | **无**。OpenCode 没有 harness 会话 |
| `buildCircuitBreakerKey` / `isCircuitBreakerOpen` / `recordCircuitBreakerTimeout` / `resetCircuitBreaker` | **有** —— 对着 `deep-recall.ts` 里手写的 `breakers` map |
| `buildCacheKey` / `getCachedResult` / `setCachedResult` / `shouldCacheResult` | **无**。mem-plus 的 recall 没有 run 身份,没有可键的请求内复用(trigger-recall 头部已记同一原因) |
| `resolveActiveRecallForRun` / `forgetActiveRecallRun` / `buildMemoryAudienceCacheIdentity` | **无**。同上,且没有 audience 概念 |

`session-policy.ts` 17 个导出里**零个**有对应物;`recall-state.ts` 17 个里 4 个有。

**结论:两个都不搬。** 搬 `session-policy.ts` 是加 9 个文件没人调 —— 正是 P3 记过的那 13 个死文件
那一类。搬 `recall-state.ts` 是加 15 个文件 / 134.5 KB,其中 11 个是 openclaw 的会话访问器
(`src/config/sessions/session-accessor.sqlite-*`、`session-delivery-generation.ts`、
`session-incognito-binding.ts`)与 memory provider 运行时(`src/plugins/memory-audience.ts`、
`memory-provider-adapter.ts`、`memory-runtime.ts`)—— 那是 L3 边界,OpenCode 有自己的会话模型
也没有 memory 插件槽。为四个小函数背 134.5 KB 的死机构不划算。

**那四个函数改为「誊写但补齐上游行为」**,这一刀做完了(见下)。

### 断路器:誊写的那份丢了三条上游行为,已补

| | 上游 | 誊写版原来 | 现在 |
|---|---|---|---|
| 冷却到期 | `isCircuitBreakerOpen` **删条目**并返回 false | 只比较,**计数残留** | 删条目 |
| 记录时 | 扫一遍,删掉所有冷却已过的键 | 不扫,只增长 | 扫 |
| 容量 | 超 `DEFAULT_MAX_CACHE_ENTRIES` 删最旧,且**重插**被写的键 | 无上限 | 有,且重插 |

第一条是真实的行为差异:冷却过去后旧计数还在,下一次失败从它往上加,于是**第一次重试就重新
打开断路器**,而不是要攒够 `circuitBreakerMaxTimeouts` 次。恢复后第一次成功会 `noteSuccess`
清掉它,所以只在「冷却后第一次又失败」时暴露 —— 不容易发现,但确实是错的方向。

`nowMs` 仍是参数而上游内联 `Date.now()`,这是**反方向的刻意偏离**:断路器与时间衰减都是时间相关
的,可注入的时钟才能让探针断言它们,而不是去睡。

**剩下的一处偏离:键没有 agent 段。** 上游是
`buildCircuitBreakerKey(agentId, provider?, model?)` = `` `${agentId}:${provider ?? "unknown"}/${model ?? "unknown"}``,
即按 (agent, provider, model) 三元组;这里是 `` `${providerID}/${id}` ``。

原因是调用路径上没有 agent 身份,**不是没去找**:`runDeepRecall` 收到的是 `ctx`、`model` 与消息
文本;`SessionMessageView.agent` 确实存在,但那是**消息**上的字段,而 `recall-inject.ts` 的调用点
拿到的是 `event` 与 `message` 字符串,没有那条 `SessionMessageView`。所以一个 agent 的超时可能
把另一个 agent 的断路器打开。**修法是把 agent 接进来,不是猜一个值填上去。**

### 双份 `trigger-recall`

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

## 自查记录:一次改错与它揭示的东西(2026-10-13)

`f954e17e` 把 `fuseRankings` 里的 `startLine: hit.unitId` 改成了 `hit.startLine`,理由是
「unitId 是自增主键,填进行号是缺陷」。**这个改动是错的,已回退。**

真实检索路径上的探针(而不是手工造的 hit)显示 `hit.startLine` 恒为 **0**,于是查出:

- mem-plus 的 `units` 表**没有行号列**,`HIT_COLUMNS` 也从未选过,`rowToHit` 硬写
  `startLine: 0`(`memory-index.ts:788-789`)
- 所以原代码用 `unitId` 顶替是**刻意的** —— `mergeHybridResults` 需要一个合并键,而
  `memory-index.ts:1035-1038` 的注释早就写明「它是一个载体,不是行号」
- 我改的那一刀只是从「填了个假行号」变成「填了 0」,没有修好任何东西

**根因登记为偏离**:引用行号在 mem-plus 的 schema 下**没有数据支撑**,不是接线疏漏而是自创
schema 少了这一整类信息。上游的 chunk 有 `start_line` / `end_line`,`memory-recall-metadata.ts`
同时选出这两列 —— 这是第五处「上游搬下来了、在旁边另写了一套,而自创那套少了一类信息」。

**教训与 AGENTS.md 那条一致**:我第一版探针手工构造了一个 `startLine: 5` 的 hit,于是问题被
整个绕过去还「通过」了。改用真实路径(建索引 → 索引文件 → 检索 → 融合)才撞出来。**夹具造的
字段永远验不出「那个字段根本没有数据」这类缺陷。**
