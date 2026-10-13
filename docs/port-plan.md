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

## 偏离登记(照搬过程中确认的每一处)

偏离必须写在这里,不留在代码注释里 —— 注释会过期,而且没人会读。判据 1 要求"抄不进来的写出
理由",这就是那个理由的位置。**「依赖 P2」是必填项**:凡是不搬是为了 P2 的粒度不够,就要
写明它随 P2 一起回来,不能变成永久的自创。

| 上游行为 | mem-plus | 原因 | 风险 | 依赖 |
|---|---|---|---|---|
| **curated 层限定**:`isPromotedTrustedMemoryEntry` 读该 entry 自己的 provenance 行,所以一个文件里合格与不合格的条目可以共存,只有合格的过闸 | `entry.provenance.originClass` 来自 `documents.origin_class`,**一个文件一个值**(按路径判定)。混合文件里**全部**条目都过闸 | mem-plus 的 provenance 粒度是文件,不是块 | **真实削弱。** 架构文档称这条为 security property 而非调参选择 | **P2** —— provenance 换成上游的逐块(`memory_index_chunk_provenance`)后自动恢复 |
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
