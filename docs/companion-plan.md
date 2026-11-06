# mem-plus 陪伴者化规划（Companion Plan）

机主 2026-11-06 拍板：「装了记忆插件，要像人一样，像一个陪伴者。」
本文只规划，不动代码；待机主确认范围再动。

## 0. 目标与边界

**目标**：装上 mem-plus 后，Agent 的记忆行为像一个长期陪伴者——
跨会话连续、记住偏好与经历、按情境主动想起、 consolidation 而非死记、
会遗忘不重要的、不会在用户不知情下静默 degraded。

**不是目标**：
- 不动模型权重（Sleep 论文的参数级 consolidation 不在范围内；本仓是文件/索引 organs，保持非参数化）。
- 不修 openclaw 上游的四个已知缺陷为"bug"——按 `docs/memory-chain.md` §3 第 3 条，
  修它们是**有意的分歧**，必须在 `port-plan.md` 记为 DIVERGENCE，不可静默。
- 不追新 nightly / 不换 Q4（已定）。

**参照**：
- `docs/memory-chain.md`（器官生理，不可违反的常量/门控）
- `docs/port-plan.md`（移植现状与分歧记录）
- `docs/papers/2606.03979-Language-Models-Need-Sleep.pdf`（睡眠/巩固/梦的工程定理化）

## 1. 现状：什么在跑，什么在拖

### 1.1 已在跑（日志证据）

```
llm capture extract: ok → snapshot *.md → indexed N unit(s) → auto-embed N chunk(s)
```

capture → index → auto-embed → search 全链路活着；工具 `memory_search / memory_reindex / standing_intent` 可用。

### 1.2 拖着「陪伴者」体验的四件事（全部是 §11 已知缺陷）

| # | 缺陷 | 陪伴者视角的伤害 | 上游 issue |
|---|---|---|---|
| D1 | 并发 flush 竞争（无锁 RMW，仍回 `appendOnly: true`） | 用户在关键节点说的话可能静默丢失 | #131604 |
| D2 | 出处棘轮 | `USER.md` 静默降级 6 天，健康信号全绿——陪伴者「忘了你是谁」且不说 | #153426 |
| D3 | 逐字提升 | dreaming deep 把日志原行照抄进 `MEMORY.md`， never synthesizes —— 记忆不会「消化」 | #67363 |
| D4 | 索引无上界 | 生产 38,985 行 / 3.3 GB，无保留策略 —— 记忆只增不减，检索退化 | #114612 |

### 1.3 缺失的陪伴者能力（上游有设计、本仓未落地或未验证）

- **偏好连续性**：`USER.md` 存在（精选层），但 provenance ratchet (D2) 能静默降级它——偏好追踪不可靠。
- **时间感知召回**：LongMemEval 风格 time-aware expansion；上游 `memory_search` 不做时间衰减，旧事实与新事实等权。
- **主动想起**：trigger injection（§1c）存在，但 mem-plus 是否 faithfully ported 未验证。
- **遗忘**：无 importance/recency 驱动的淘汰；索引只增。
- **消化**：dreaming deep 逐字复制（D3）；没有「自生成 rehearsal + 筛选」（Sleep 论文 dreaming 部分）。
- **评估**：无个人记忆基准；无法衡量「陪伴者」是否变好。

## 2. 跨器官对照：Sleep 论文 → mem-plus

Sleep 论文的两阶段与本仓 organs 的映射（保持文件/索引非参数化，只借原则）：

| Sleep 论文 | mem-plus / openclaw 现状 | 差距 |
|---|---|---|
| Wake：短期记忆（高频块），新输入暂存 | pre-compaction flush → `memory/YYYY-MM-DD.md`（情景层） | 已有 |
| Sleep consolidation：蒸馏短期→长期，激活新低秩专家，提供容量 | dreaming deep → `MEMORY.md`（精选层） | **D3：只复制不蒸馏** |
| Dreaming：RL 自生成课程 + 复习 + 语义筛选 | dreaming phases 的 dreaming ingestion（daily notes + sessions） | **无自生成 QA / 无语义 reward** |
| Prune：剪掉变化过频的参数 | 无 | **D4：无淘汰** |
| Capacity：预分配专家块，不改维度 | 索引无上限 | **D4** |

消融数据（论文 Table 3）：无 dreaming，事实学习 48.9% → 35.7%（基线 31.9%）；
dreaming 承担 70–78% 的事实学习增益。→ **梦不是装饰，是主要增益来源**。这给 mem-plus 的 dreaming 阶段升级以证据支持。

## 3. 分阶段规划

### Phase 0 — 基线与度量（不动代码，先能测）

- 建立个人记忆基准：从现有 workspace 抽 30–50 条「用户偏好/经历/决策」真值，
  构造 query→expected 记忆对；测 recall@k、MRR、时间正确性。
- 记录当前四缺陷的复现脚本（flush race 并发写、ratchet 降级、unbounded 增长），
  作为 before/after 对照。
- 产出：`docs/benchmarks/companion-baseline.md`（数字）。

### Phase 1 — 信任修复（D1, D2, D4 的保留策略）【高优先】

目标：陪伴者不再静默 degraded；记忆有上限。

1. **D1 flush race**：pre-compaction flush 加文件级锁（或原子 RMW），并发时串行化；
   失败时 honest 报错，不回 `appendOnly: true`。
   - 记录：DIVERGENCE，对应 §11 #131604。
2. **D2 provenance ratchet**：provenance 降级必须显式（日志 + 可见状态），不静默；
   `USER.md` 偏好字段的 provenance 保护（ companion 的「你是谁」不能被 agent 覆盖）。
   - 记录：DIVERGENCE，对应 §11 #153426。
3. **D4 保留策略**：索引按 importance/recency 淘汰；设上限（如 50k chunks 或按磁盘）；
   DREAMS.md / MEMORY.md 体积上限（对应 #45415 的 20K 截断问题）。
   - 记录：DIVERGENCE，对应 §11 #114612/#45415。

验收：Phase 0 基准下，flush race 复现脚本 0 丢失；ratchet 降级 100% 可见；
索引在 60 天模拟负载下不超上限。

### Phase 2 — 消化质量（D3 + Sleep dreaming）【核心体验】

目标：记忆从「复制」变成「消化」。

1. **dreaming deep：合成而非复制**：把 `lines.push(\`- ${snippet} [score=...]\`)` 改为
   LLM 合成条目（带 provenance + 时间 + 来源），分数决定「进不进」，LLM 决定「怎么写」
   （Sleep 论文 dreaming 的 curated rehearsal 思路）。
   - 需要 LLM 调用预算（`completeThroughHost`），超时/失败回退到复制（原则 5：失败不阻断）。
2. **自生成 rehearsal**：dreaming 阶段生成 QA 对并自评（Sleep 的 dreaming 机制），
   把高分 QA 写入 DREAMS.md 供人类审阅（Tier 5 Review）。
3. **语义 reward**：保留方向 = 任务相关性，不只 token 概率（Sleep 论文 semantic reward）。
   - 本仓已有 `completeThroughHost`，可做轻量打分。

验收：Phase 0 基准 recall@k 提升；DREAMS.md 人工审阅：合成条目可读、无逐字垃圾。

### Phase 3 — 陪伴者连续性

1. **偏好追踪**：`USER.md` 增量更新（从 capture 中抽取偏好，带 provenance `owner`）；
   provenance 保护（Phase 1 D2）。
2. **时间感知召回**：`memory_search` 增加 recency 衰减（可配置半衰期）；
   time-aware query expansion（LongMemEval 风格，注意 §11 的 caveat：弱模型上会变差，
   用模型能力分级）。
3. **主动想起**：trigger injection（§1c）验证 port 完整度；standing intents 与记忆联动
   （「你上次说 X，现在 Y 发生了」）。
4. **Bootstrap 注入预算**：MEMORY.md 预算化（§1a），避免 §11 #45415 截断。

验收：跨会话偏好召回 ≥ 90%；主动想起在 5 个真实场景下有用（人工评）。

### Phase 4 — 遗忘与整理

1. **淘汰策略**：importance < 阈值 且 超过 N 天未召回 → 归档到 `memory/archive/`，
   不删（可恢复，符合「No hidden state / index rebuildable」）。
2. **整理（consolidation）**：定期把多条情景合并为一条精选（Sleep consolidation 的
   非参数化版）；保留来源链（provenance supersedes_key）。
3. **人类审阅入口**：DREAMS.md + 记忆浏览器的删除/合并 UI（已有 `/api/runtime` 风格）。

验收：60 天模拟负载下索引体积有界；人工审阅可恢复误删。

### Phase 5 — 评估与发布

- 个人记忆基准 v2（含时间、偏好、主动想起、遗忘四类）。
- 对比上游：明确列出「修了 D1-D4」作为 DIVERGENCE，不 pretend 是上游行为。
- 用户体验验收：机主装上后，连续使用 2 周，主观「像陪伴者」评分。

## 4. 风险与取舍

- ** scope**：Phase 1–2 是信任+消化，直接影响「陪伴者」；Phase 3–4 是体验 polish。
  建议先做 1+2，用机主真实 2 周使用反馈决定 3+4。
- **模型能力**：free tier 提取已知弱（§ port-plan：70 ok / 229 failed）；
  陪伴者化更依赖 LLM 合成质量。建议 companion 模式要求 `model.hostedModel` 指向强模型，
  否则回退到复制（D3 回退）。
- **评估困难**：无 ground truth；Phase 0 基准靠机主手标 30–50 条，小而真实 > 大而合成。
- **Sleep 论文不直接适用**：它是参数级 consolidation；本仓是非参数化文件 organs。
  只借原则（巩固而非复制、梦/复习、淘汰、容量），不搬机制。记录为 DESIGN NOTE。

## 5. 开放问题（需机主决定）

1. Phase 范围：先 1+2，还是 1–4 一并？
2. 陪伴者模式是否要求强模型（hostedModel）？弱模型下回退到复制，体验差异大。
3. 是否把 `USER.md` 偏好抽取做成默认开（上游 `flush.enabled` 默认开，本仓已不可关）？
4. 评估基准由机主手标，还是先用合成数据？
5. Phase 1 的 D1/D2/D4 修法是否接受作为 DIVERGENCE 记入 port-plan？

## 6. 与现有规则的对齐

- 每条分歧写入 `docs/port-plan.md`（AGENTS.md 记录风格：结果/经验/设计理念，不记改动）。
- 每个新行为 cites `docs/memory-chain.md` 对应 §（AGENTS.md §"The memory chain" 第 1 条）。
- 不静默修缺陷（第 3 条）：D1–D4 的修复在 port-plan 中明确标为 DIVERGENCE + 原因。
- 代码注释写明对应 openclaw 段落与移植后差异（AGENTS.md 总目标）。

---
*规划稿，待机主审阅。确认后按 Phase 顺序落地，每 Phase 一个 commit（中文主体式，格式照 openclaw 上游）。*
