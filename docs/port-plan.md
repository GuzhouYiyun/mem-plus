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

## P1 检索防自我放大的另一半

上游除 taint 外还在入库前 redact。mem-plus 无 redact 步骤。若 P0 的标记链成立,这一层
可能已被覆盖;若不成立则需补。**取决于 P0 的调查结果。**

## P2 索引层与上游对齐(可选,视目标)

mem-plus 的 `documents`/`units`/`units_fts`/`vectors` 是自建 schema,上游是
`memory_index_*`。行为等价(刚验证:forget 的清理已按同一规则落地),但结构不同。若目标
是"以后能持续对照上游",把 schema 对齐会让后续搬入零成本;若目标是"能跑就行",现状够用。
**这一条要你定,不是技术问题。**

## 已确认无法搬的(缺对应宿主接口,不需要改)

- CLI(`openclaw memory` 9 个子命令)—— OpenCode 无此运行时
- gateway RPC(`memory.search/get/status`)—— 同上
- doctor 6 项迁移与检查 —— 裁剪期整体删除
- cron 驱动的 dreaming —— OpenCode 无 cron,现为"新一天第一个 settle 的对话"
- 文件监听 —— 现为显式 `memory_reindex`
- worker 架构 —— 现为单进程同步

## 调研待做(本计划的事实基础)

1. OpenCode 是否有等价于 `turnTainted` 的轮次污染标记,或能否加
2. 上游 `turnTainted` 的写入点在哪一层,与 retrieval 投递的先后关系
3. 若 OpenCode 无此标记,P0 的最小可行形态是什么(例如:投递时记录本次注入的 unitId,
   快照写入时检查内容是否包含这些 unit 的文本)
4. mem-plus 快照 → 索引 → 晋升这条链路上,`origin_class` 目前实际取值与来源

## 验收口径(沿用 AGENTS.md)

不靠类型门。每一项必须有:真实数据走过该路径 + 可复核的落盘证据。
`MEMORY.md` 那层至今零验证 —— daily 层已实测(7 条真注解、reindex 后 `project_key`
落库),promotion 写 `MEMORY.md` 注解这条路还没被真实数据走过,而泄漏恰好发生在那一层。
**P0 完成前,这条不算验证过。**