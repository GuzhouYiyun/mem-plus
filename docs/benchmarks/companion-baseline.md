# Companion Baseline (Phase 0) — mem-plus

日期：2026-11-07。测量自本机活区 `~/.config/opencode/mem-plus/`（VACUUM INTO 快照，非直接拷贝）。

## 0.1 索引现状

| 指标 | 值 |
|---|---|
| chunks | 609 |
| 文件数 | 350 |
| curated (`MEMORY.md`/`USER.md`) chunks | 0 |
| origin_class 分布 | agent 609 (100%) |
| DREAMS.md | 6485 B |
| 项目 slug 数 | ≥ 6（mem-plus, harmony_oldman, 21991, …） |

结论：** curated 层为空，记忆全在 episodic 层**。陪伴者「长期记忆」目前不存在。

## 0.2 Capture 覆盖率（日志统计）

| 指标 | 值 |
|---|---|
| `capture extract: ok` | 869 |
| `failed` | 146 |
| `exhausted` | 245 |
| `captured` outcome | 10 |
| `plugin loaded` | 137 |

成功率 ≈ 869/(869+146) ≈ 85.6%，但 `exhausted` 245 条被 parked（3 次失败后 7 天不重试），
`captured` 仅 10 —— **抽取成功 ≠ 落地**，中间有断点。

## 0.3 四缺陷复现状态

| 缺陷 | 复现脚本 | 状态 |
|---|---|---|
| D1 flush race | 待写（并发 flush RMW） | 未复现 |
| D2 provenance ratchet | 待写（owner 手改 → untrusted） | 未复现 |
| D3 verbatim promotion | 待写（dreaming deep 复制） | 未复现 |
| D4 unbounded index | 已有数据：609 chunks / 30 MB index.db | 部分 |

## 0.4 基准数据集（待机主手标）

目标：30–50 条「偏好/经历/决策」真值，格式：

```json
{ "query": "...", "expected": ["memory/...md#Lx"], "kind": "preference|experience|decision" }
```

候选 40 条已自动生成：`docs/benchmarks/companion-truth.candidates.json`（query=捕获请求首行，expected=来源 daily 文件）。
机主审阅后改名为 `companion-truth.json` 并修正 expected/label。

验收指标：recall@k、MRR、时间正确性。

## 0.5 覆盖策略（§8）

四层：L1 LLM 抽取（主）+ L2 启发式兜底 + L3 会话结束 hook + L4 reconciler（已有）。
覆盖率进本基准：触发率、成功率、漏掉的会话数。

## 待办

1. 机主手标 30–50 条真值 → `docs/benchmarks/companion-truth.json`
2. 写 D1/D2/D3 复现脚本 → `docs/benchmarks/repro/`
3. Phase 1 开工前重跑本文件，填 §0.3 全部状态