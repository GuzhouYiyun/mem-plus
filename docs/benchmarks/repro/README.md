# 复现脚本（Phase 0）

## D1 flush race
- 路径：`plugin/src/flush-run.ts` RMW 无锁
- 复现：同一会话并发触发两次 compaction flush，检查 `memory/YYYY-MM-DD.md` 是否丢行。
- 对照：`docs/memory-chain.md` §1 / #131604。

## D2 provenance ratchet
- 路径：`src/memory/memory-artifact-provenance.ts:146-153`
- 复现：owner 手改 `MEMORY.md` 或同 turn 有 network tool，观察 origin_class 是否从 agent 降到 untrusted 且不可恢复。
- 对照：`docs/memory-chain.md` §8 / #153426。

## D3 verbatim promotion
- 路径：`extensions/memory-core/src/.../short-term-promotion` deep phase `lines.push(\`- ${snippet} [score=...]\`)`
- 复现：跑 dreaming deep，检查 `MEMORY.md` 新增条目是否原样复制 daily 行。
- 对照：`docs/memory-chain.md` §3 / #67363。

## D4 unbounded index
- 路径：`memory_index_chunks` 无淘汰
- 复现：统计 chunks/files/size 增长曲线；60 天模拟负载。
- 对照：`docs/memory-chain.md` §11 / #114612。