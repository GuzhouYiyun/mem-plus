# OpenClaw memory: the complete chain

Read before changing memory behaviour, and before reimplementing any part of it.
Every constant below was read from code on 2026-10-11 with the file and function
that owns it. **Docs and code disagree in ten places (§9); the code wins.** Where
this file says "doc" it means `openclaw/docs/concepts/memory-architecture.md`.

Scope note that matters more than it looks: `extensions/memory-core/` owns
dreaming, promotion and the search engine, but **capture triggers, compaction
gating, provenance assignment, bootstrap filtering and the entire two-lane recall
system live outside it** (§10). Any reimplementation that assumes memory-core is
the whole subsystem will be wrong about the parts that decide what is trusted.

## The five tiers

| Tier | Surface | Written by | Injected |
|---|---|---|---|
| Instructions | `AGENTS.md`, workspace instructions | human only | every session start |
| Curated core | `MEMORY.md`, `USER.md` | dreaming deep; direct user request | session start, provenance-eligible, budgeted |
| Episodic | `memory/YYYY-MM-DD.md`, transcripts | agent during work, pre-compaction flush, transcript capture | on recall only, never at session start |
| Prospective | standing intents (SQLite), cron jobs | `intent` tool | only when a trigger fires |
| Review | `DREAMS.md`, phase reports | dreaming phases | never; for humans |

The load-bearing boundary is **curated vs episodic**. Nothing crosses from
episodic into curated except through the promotion gates in §4. `USER.md` and
standing intents are user-level and never project-scoped.

## Design principles (the five rules everything else follows from)

1. **No hidden state.** The model remembers only what is in files under the
   workspace; the SQLite index is derived and rebuildable.
2. **Writing is the hard part.** Retrieval over notes is competitive with far
   heavier designs; what degrades memory is unreliable write-time curation. This is
   why curation runs in a background pass instead of on the reply path.
3. **The write path is the security boundary.** Content-level scanning cannot
   catch poisoned facts, so provenance is enforced at write time and promotion is
   gated structurally.
4. **Deterministic gates, model judgment inside them.** Scoring, thresholds,
   eligibility and lifecycle are code; the model is used only where language
   judgment is needed, inside bounds code enforces.
5. **Failures never block replies.** Every memory step has a timeout or fallback.
   §9 D1 and issue #131604 are what this principle costs when it is taken literally.

## 1. Capture — every path that writes a candidate

**Pre-compaction flush.** Gate is `shouldRunMemoryFlush()`,
`src/auto-reply/reply/memory-flush.ts:104`:
`shouldRunPreflightCompaction(params) && params.entry && !hasAlreadyFlushedForCurrentCompaction(entry)`.
`shouldRunPreflightCompaction` (line 124) is
`typeof totalTokens === "number" && totalTokens > 0 && params.threshold > 0 && totalTokens >= params.threshold`.
One flush per compaction cycle (`lastFlushAt === entry.compactionCount`, line 151).
Threshold = `max(0, contextWindow - reserveTokensFloor, minimumThresholdTokens ?? 0)` (line 40).
Soft tokens default 4000, transcript cap 2 MB (`extensions/memory-core/src/flush-plan.ts:12-13`);
when a context window is known the soft threshold is clamped to
`min(soft, floor((contextWindow - reserveTokensFloor) / 2))` (line 89).
Target `memory/${dateStamp}.md` in `agents.defaults.userTimezone`.
`defaults.enabled === false` returns `null` — no flush at all (`flush-plan.ts:73`).

**Session-memory hook**, outside the extension: `src/hooks/bundled/session-memory/`
on `command:new`, `command:reset`, `session:auto-reset`. Writes
`memory/YYYY-MM-DD-HHMM.md` from the last 15 messages (`transcript.ts:147`).

**Dreaming ingestion**, two sources, both at the top of every light and REM phase
(`ingestDreamingPhaseSignals()`, `dreaming-phases.ts:1167`):
- Daily notes — lookback `max(14, phaseLookbackDays)` (line 670), total cap
  `max(20, limit*4)`, per-file cap `max(6, ceil(total/fileCount))` (lines 717-718),
  fixed score `DAILY_INGESTION_SCORE = 0.62` (line 91), snippet 8–280 chars, max 4 lines.
- Session transcripts — `sessionIngestionSourceFromCorpus()`
  (`src/session-ingestion.ts:128`) returns null unless `sessionKind === "interactive"`;
  cron/heartbeat/subagent/unknown are structurally excluded. Caps: 240 messages per
  sweep, 80 per file, floor 12.

**Search feedback.** After `memory_search`, fire-and-forget
`recordShortTermRecalls(recall)` (`extensions/memory-core/src/tools.ts:477`), gated on
`outcome === "ok" || "partial"` and `dreaming.enabled`. Only **surfaced** results
earn a signal (intersection with the rendered results, lines 461-464).

All of it lands in `ShortTermRecallStore` — SQLite-backed plugin state, not a JSON
file. Caps: 512 entries, 32 query hashes, 16 days, 800 chars per snippet
(`short-term-promotion-utils.ts:26-29`).

## 2. Index — schema and what is actually stored

DDL: `src/state/openclaw-agent-schema.sql:764-841`. Nine tables. The two that carry
the design:

```sql
-- memory_index_chunk_recall_metadata
chunk_id, importance, triggers, project_key
-- memory_index_chunk_provenance
chunk_id, origin_class, session_kind, observed_at, supersedes_key
```

with hard CHECK constraints:
`origin_class IN ('owner','agent','untrusted','system')`,
`session_kind IN ('interactive','cron','heartbeat','subagent','unknown')`.

**There is no score column.** `memory_index_chunks` stores the embedding BLOB only;
keyword relevance is FTS5 BM25 computed per query, and the combined score is
assembled at query time (§5.2). The only persisted numeric quality facts live in
the recall store. A reimplementation that adds a score column will diverge.

Default when nothing classified a chunk:
`{ originClass: "untrusted", sessionKind: "unknown" }` (`manager-chunk-writer.ts:127-130`).

## 3. Dreaming — three phases, coded defaults

Order is **light → REM → deep**, all `enabled: true`
(`src/memory-host-sdk/dreaming.ts:380-460`; order at
`dreaming-phases.ts:1405-1406` then `dreaming.ts:166`). Cadence `0 3 * * *`.
Trigger is a `before_agent_reply` hook on `heartbeat`/`cron` carrying the magic
token `__openclaw_memory_core_short_term_promotion_dream__`
(`dreaming.ts:585-593`) — so an ordinary cron entry cannot start a sweep.

| | light | REM | deep |
|---|---|---|---|
| lookbackDays | 2 | 7 | — |
| limit | 100 | 10 | **10** |
| gate | none | `minPatternStrength` **0.75** | score **0.75**, recallCount **3**, uniqueQueries **3** |
| recencyHalfLifeDays | — | — | **14** |
| maxAgeDays | — | — | **30** |
| execution | fast/low/cheap | slow/high/expensive | balanced/high/medium |

**Light** reads the lookback window, filters `!isPromotionOriginBlocked(entry)`,
dedupes at similarity **0.9**, slices to the limit. Stages everything; no threshold.

**REM** builds theme reflections, `strength = min(1, count/entries*2)`, keeps those
≥ 0.75. Candidate truths are deduped at 0.88, confidence =
`avgScore*0.45 + recallStrength*0.25 + consolidation*0.2 + conceptual*0.1`
(recallStrength `= min(1, log1p(count)/log1p(6))`, consolidation `= min(1, days/3)`,
conceptual `= min(1, tags/6)`), keep ≥ **0.45**, cap `max(1, min(3, limit))` = **3**.

**Deep** has three filters, not the two the docs describe (§9 D4):
1. ranking gate — `rankShortTermPromotionCandidates()` (`short-term-promotion.ts:88`)
2. apply-time eligibility — `short-term-promotion-apply.ts:248-293`
3. lock-time revalidation — `short-term-promotion-apply.ts:402-439`

Ranking weights (`short-term-promotion.ts:32-39`, these match the doc):

```js
frequency 0.24  relevance 0.30  diversity 0.15
recency   0.15  consolidation 0.10  conceptual 0.06
// plus phaseBoost ≤ 0.06 (light) + 0.09 (REM), each
//   × log1p(hits)/log1p(6) × recency(14d)
```

Component formulas: `frequency = clamp(log1p(signalCount)/log1p(10))`,
`diversity = clamp(uniqueQueries/5)`, `recency = exp(-ln2/halfLife * ageDays)`,
`consolidation = clamp(0.55*spacing + 0.45*span)` where
`spacing = clamp(log1p(n-1)/log1p(4))` and `span = clamp(spanDays/7)`,
`conceptual = clamp(tags/6)`.

## 4. Promotion gates — the exact conditions

Pre-scoring skips (`short-term-promotion.ts:120-158`): not a short-term memory path;
origin blocked; contaminated snippet; already promoted; `signalCount < minRecallCount`;
`uniqueQueries < minUniqueQueries`; `ageDays > maxAgeDays`; `score < minScore`.

Apply-time chain (`short-term-promotion-apply.ts:248-293`), each with a recorded
rejection reason: origin → consolidation origin/session → contamination →
already promoted → score → signal → query → age.

**Bug worth knowing about** (`short-term-promotion-apply.ts:256`): when
`options.consolidation` is set and `latest` is undefined, the expression evaluates
to `false` and the candidate is dropped **without being recorded in `rejections`** —
it is invisible in the rejection report. Do not use the rejection counts to reason
about why candidates were skipped.

**The two structural trust gates** (`dreaming-consolidation-candidates.ts`):

```js
isPromotionOriginBlocked(c)      → c.provenance?.originClass is "untrusted" | "system"
isConsolidationCandidateEligible(c) →
    (originClass is "owner" | "agent")
    && (!isSessionDerivedPath(c.path) || c.provenance?.sessionKind === "interactive")
```

Applied at **five** call sites: ranking (`:124`), light+REM entry read
(`dreaming-phases.ts:1206`), consolidation prompt build
(`dreaming-consolidation.ts:407`), apply (`:254`), lock revalidation (`:433`).

The doc's claim that origin filtering happens "before any prompt is built" is
**accurate** — `filterConsolidationCandidates()` is the first statement of
`consolidateMemory()`. It is also enforced again afterwards.

**Contamination filter** (`short-term-promotion-utils.ts:181-211`) rejects snippets
containing promotion markers, dreaming transcript prompt lines, raw session
metadata, raw conversation summaries, memory-flush prompt text, or score metadata —
plus a narrative-shaped composite (lead + confidence + evidence + status + recalls +
reflection note). This is what stops the diary from becoming a promotion source.

## 5. Recall — two lanes

### Lane 1a: bootstrap injection

`src/agents/bootstrap-files.ts:269` filters candidates through
`isMemoryOriginEligibleForAutomaticInjection()` (`packages/memory-host-sdk/src/host/types.ts:40-44`),
which admits **only `owner` and `agent`**. `unavailable` → inject nothing;
`unsupported` or error → inject everything, with a warning.

Classification order (`memory/memory-path-provenance.ts:15`): non-`memory` source →
`untrusted`; path escape or realpath failure → `untrusted`; `DREAMS.md`,
`dreams.md`, `memory/dreaming/**`, `memory/.dreams/**` → **`system`**; recorded
artifact provenance exists → use it; workspace memory markdown → `agent`;
everything else → `untrusted`. **Never defaults to `owner`.**

### Lane 1b: ranked search

Six steps, all constants coded (`src/agents/memory-search.ts:116-123`):
1. hybrid blend `vectorWeight*vectorScore + textWeight*keywordScore` = **0.7 / 0.3**
2. temporal decay `score * exp(-ln2/30 * ageDays)`, **30-day half-life**;
   `MEMORY.md`, `USER.md` and non-dated `memory/**` are exempt (no timestamp → no decay)
3. importance multiplier `0.75 + clamp(1..10) * 0.05` → **0.80…1.25**, `NULL` → 1.0
   neutral (`memory/importance.ts:1-7`)
4. project boost: every stored key active → **1.15**, otherwise **0.9**; no key → 1.0
5. MMR with `lambda: 0.7`
6. `score >= minScore` (**0.35**), then a keyword-only backfill that never displaces
   a qualifying result. `maxResults` **6**. Chunking 400 tokens / 80 overlap.

⚠️ `DEFAULT_TEMPORAL_DECAY_CONFIG` inside memory-core is `{ enabled: false }`
(`memory/temporal-decay.ts:7-10`); the effective `true` comes from `memory-search.ts:122`.
Resolving the module default in isolation gives decay **off**.

### Lane 1c: trigger injection

Lives in `extensions/active-memory/trigger-recall.ts`, **not** memory-core.
`STRONG_TRIGGER_MATCH_SCORE = 0.65`, `TRIGGER_INJECTION_LIMIT = 3`,
`MAX_TRIGGER_CONTEXT_CHARS = 1800`, `TRIGGER_CANDIDATE_LIMIT = 24`.
Calibration is documented in the source: zero false positives down to 0.60; 0.72
rejected legitimate paraphrases; 0.68 is the ceiling for single-word triggers
(`0.85 * 0.8`). Scoring: single word 0.85 exact / 0; multi-word
`coverage*0.8 + min(1, overlap/2)*0.2`; final `triggerScore*0.8 + relevance*0.2`.
Requires `automaticRecall.eligible === true` **and** all its project keys active.

### Lane 2: escalation (`extensions/active-memory/escalation.ts`)

`resolveRecallEscalationDecision()` (line 82) returns `mode-off` / `recall` /
`strong-lane-one-hit` / `no-recall-intent`. Default mode requires **both**:
1. lane 1 produced no match at ≥ 0.65, and
2. `hasRecallIntent(message)` (line 68) — 14 regexes plus 5 locales
   (zh-Hans, zh-Hant, ja, ko, ru, es); a future-reminder phrasing suppresses
   escalation unless a retrospective marker co-occurs.

## 6. Consolidation safety

**Optimistic concurrency at the rename boundary**, not a lock held during the model
call (`short-term-promotion-memory-write.ts:190-199`): `replaceFileAtomic` takes a
`beforeRename` hook that re-hashes the file and throws `MemoryWriteConflictError`
on mismatch. Second CAS before the plan is applied
(`short-term-promotion-apply.ts:462-464`) plus per-candidate fingerprint checks.

Two nested locks: `withFileLock(sha256(realpath(workspaceDir)))` under
`<stateDir>/locks/memory-promotion-<hash>`, 100 retries, factor 1.2, 25–250 ms,
stale 120 s, `staleRecovery: "fail-closed"`; plus `withMemoryWorkspaceLock`.

Budget: `DEFAULT_MEMORY_FILE_MAX_CHARS = 10_000`, deliberately below bootstrap's
per-file injection cap so promotion stays visible (`memory-budget.ts:15`);
effective value is the **smallest configured bootstrap limit** among workspace agents.
`WRITE_OVERHEAD_RESERVE = 21`.

Loss fraction: consolidation rejects if
`removedEntryCount / currentEntries.length > maxPriorEntryLossFraction` (default
**0.25**). The append/compaction path uses a different fallback (**1**), not 0.25 —
`memory-budget.ts:214`. Only fully-generated promotion blocks are droppable; a block
with any hand-written line is preserved (oldest-first).

Append fallback is entered when the model is absent, the plan is unparseable,
validation rejected, the hash conflicts, or permission failed. It commits with
`allowInPlaceFallback: true`, which the comment at
`short-term-promotion-memory-write.ts:237` notes **consolidation never uses**.

Uncertain-publication tracking: a custom `rename` wrapper marks state `"uncertain"`
before and `"committed"` after, reconciles the target hash on
EACCES/EPERM/EEXIST/EROFS, and raises `MemoryAtomicPublicationError` which
**rethrows without falling back** — the caller must not silently append over a
possibly-committed write.

## 7. Standing intents

Table `standing_intents` (`src/state/openclaw-agent-schema.sql:843-896`), STRICT,
with FTS5 on `trigger_keywords` and indexes on `(status, expires_at, last_fired_at)`
and `(status, channel_scope, sender_scope)`.

Lifecycle: `pending | armed | fired | done | cancelled | expired`. Creation inserts
`armed` directly — **`pending` is unreachable** in practice; it exists only as a DB
enum value.

Anti-nagging constants (`extensions/memory-core/src/standing-intents-model.ts:1-5`),
all four verified: cooldown **86400 s**, max fires **3**, expiry
**7,776,000,000 ms** (90 d), max injected per turn **3**. Two more exist that the
doc omits: `INTENT_INJECTION_MAX_CHARS = 1_200`, and `INTENT_MATCH_CANDIDATE_LIMIT
= 256` with batch 32.

Matching is **zero model calls**: FTS5 prefilter then exact-token confirmation on
a `before_prompt_build` hook restricted to `webchat` or an explicit
channel/chat id. The `intent` tool is owner-only (`ctx.senderIsOwner !== true` → null).

## 8. Trust and propagation

**Classification** (`packages/memory-host-sdk/src/host/session-provenance.ts:4`):
assistant + turn tainted → `untrusted`; else `turnOrigin === "owner" ? "agent" : turnOrigin`;
`provenance.kind === "internal_system"` → `system`; `senderIsOwner` → `owner`; else
`untrusted`.

**File-write provenance** (`src/agents/agent-tools.ts:215`) can produce **only**
`agent` or `untrusted`. The downgrade rule (`src/memory/memory-artifact-provenance.ts:146-153`):

```js
const originClass = params.originClass === "agent" &&
  (!previous || (previous.originClass === "agent" &&
                 previous.fileHash === sha256Hex(params.contentBefore)))
    ? "agent" : "untrusted";
```

An `agent` write onto an already-`untrusted` file, **or onto content changed since
last observation**, downgrades to `untrusted` — sticky. This is issue #153426: one
`web_search` in the same turn as a memory write demotes `MEMORY.md` permanently,
and an out-of-band owner hand-edit (the documented workflow) does the same.
Nothing in the health checks notices.

**Turn taint** (`src/agents/embedded-agent-runner/run/turn-taint-state.ts:4`):
sticky once any non-presentation tool result has `resultContentSource === "network"`,
never cleared within a run — it resets because each user turn is a new run. Seeded
from history so a compaction cannot launder a tainted turn. Taint reaches file
writes via `isTurnTainted` → `agent-tools.ts:216`.

Transcript projection starts at `untrusted` and any untrusted/system record
downgrades the **whole file** (`transcript.ts:159-163`).

## 9. Where the docs are wrong

Ten verified discrepancies. Each one is a place a reimplementation would follow the
doc and diverge from the code.

| | doc says | code does |
|---|---|---|
| D1 | trigger prefilter is "lexical **and vector**" | `lexicalOnly: true` (`trigger-recall.ts:216,313`). `trigger_embedding` column exists and is **always null** |
| D2 | 30-day decay is a property of ranking | module default is `enabled: false`; `true` comes from `memory-search.ts:122` |
| D3 | trigger phrases are comma- **or** semicolon-separated | writer splits `/[,;]/u`, reader splits `/[\n;|]+/u` — **no comma** in the reader |
| D4 | deep has "two gates" | three filters (§3) with distinct rejection categories |
| D5 | origin filter happens "before any prompt is built" | true, and also enforced again post-hoc at `:254` and `:433` |
| D6 | project bootstrap covers `MEMORY.md` and `USER.md` | project block is **`MEMORY.md`-only** (`project-memory-bootstrap.ts:145`) |
| D7 | four anti-nagging constants | six; `INTENT_INJECTION_MAX_CHARS = 1200` and the candidate scan bound are undocumented |
| D8 | cron/heartbeat/subagent produce no durable candidates | true for transcripts; for **daily-note** candidates the session-kind check does not apply |
| D9 | trigger recall is part of memory-core lane 1 | it is in `extensions/active-memory/` — a different plugin |
| D10 | `MEMORY.md` written "only by dreaming consolidation" | also by the append path, and it can be **unlinked** (`memory-write.ts:165-172`) |

Verified **accurate** despite doc distrust: 0.65 trigger threshold; 3 injections per
turn; importance 1–10 with `NULL` neutral; 24 h / 3 fires / 90 d / 3 injected;
the six lifecycle states; phase order; supersession key as a column; atomic-rename
re-hash; all three deep thresholds must pass.

## 10. What lives outside memory-core

This is the coupling map. A reimplementation scoped to `extensions/memory-core/`
misses the parts that decide what is trusted.

- **`src/` core** — all dreaming config defaults (`src/memory-host-sdk/dreaming.ts`),
  standing-intents DDL and memory-index DDL, the flush trigger
  (`src/auto-reply/reply/memory-flush.ts`), the taint state machine, the
  write-provenance observer, bootstrap filtering (`src/agents/bootstrap-files.ts`),
  search config defaults, the session capture hook.
- **`packages/memory-host-sdk/src/host/`** — the real implementations; `src/memory-host-sdk/*`
  are thin re-export shims. Owns `isMemoryOriginEligibleForAutomaticInjection`,
  `classifySessionMessageOrigin`, the annotation parsers, FTS schema.
- **`extensions/active-memory/`** — the **entire** two-lane recall system:
  `escalation.ts` (lane 2) and `trigger-recall.ts` (lane 1c).

## 11. Independent assessment

The chain above is the design of record. What outsiders found when they measured it:

**A peer-reviewed systems evaluation** — ClawVM, EuroMLSys '26
(arXiv:2604.10352), treating OpenClaw's harness as its object of study, with the
"distilled from OpenClaw documentation" configuration as its baseline: explicit
lifecycle faults 1.5 → 0.0, and **76.7% task success at a 180-token budget where
the evaluated policy reaches 100%**. All seven failures are bootstrap pages lost to
mid-task compaction. Their summary: these harnesses "improve recall quality, but
none provides an enforceable contract over residency, durability, or
auditability." Scoped by the authors to **structural lifecycle faults, not semantic
correctness**.

**Open issues with code quoted in them**, which are stronger evidence than any blog:
- `#153426` (open) — the provenance ratchet of §8, with production impact: a
  `USER.md` silently degraded for six days with all health signals green
- `#67363` — deep phase copies raw daily-log lines verbatim into `MEMORY.md`
  (`` lines.push(`- ${snippet} [score=...] `) ``); scoring decides *whether*, nothing
  decides *how*
- `#131604` (open) — concurrent pre-compaction flushes read-modify-write with no
  lock; the caller still receives `appendOnly: true` success
- `#114612` (open) — `memory_index_chunks` unbounded: 38,985 rows / 3.3 GB on a
  production instance, no retention policy
- `#45415` (open) — `MEMORY.md` silently truncated near 20 K chars

**The project's own declared limits** (`docs/start/why-openclaw.md`): promoted
memories have no time-based retention bound; admission exclusions do not cover
direct writes or hooks; turn taint covers network-sourced tool output only.

**A co-founder's assessment**, quoted in issue #83126: OpenClaw "does a TERRIBLE
job at deciding what to store in long-term memory." Not independently verifiable
outside the issue body — treat as UNVERIFIED, but note the issue author is a
production user reporting community feedback.

**Production evidence for the memory subsystem specifically: none.** The named
deployments (OpenAI, Red Hat) speak to agent capability, not memory. The
independent evidence that exists points the other way: a widely-adopted workaround
replaces OpenClaw memory with PostgreSQL + pgvector, and users report stripping
`MEMORY.md` down to a pointer index.

**Citation caveats the docs omit**, each of which changes how much weight a
reimplementation should put on the claim:
- LongMemEval's time-aware query expansion only helps with a strong model;
  Llama-3.1-8B made it **worse** (recall@k 0.421 → 0.384). OpenClaw's analogue —
  importance assigned at write time — has the same failure mode.
- Sleep-time compute's gain is conditional on **query predictability**, and the
  paper reports plain test-time compute winning at high budgets. OpenClaw's
  dreaming is the low-budget regime: right for latency, not obviously quality-maximizing.
- MINJA's 98.2% injection rate assumes a **shared** memory bank. OpenClaw's default
  is single-owner, so that number does not transfer except for group chats.
- TriggerBench is the one tight match: prospective recall degrading sharply with
  context length while retrospective recall stays near perfect is exactly what
  justifies compiling intentions out of the model.
- PrefEval backs `USER.md` as a separate file with a separate budget (preference
  adherence falls below 10% within 10 turns), but the reminder effect holds only on
  capable models — GPT-4o 0.05 → 0.23 at 300 turns.

## 12. What a rewrite owes this

If any of this is reimplemented rather than copied:

1. **Every constant in §1–§8 is a contract.** They were read from code, not from
   the doc, and several contradict what the doc says. A different number is a
   behaviour change, not an implementation detail.
2. **Every gate in §4 is a security boundary, not a filter.** Dropping one silently
   re-opens the poisoning path MINJA documents.
3. **The five points where code and doc disagree (§9) must be resolved toward the
   code**, and the resolution recorded.
4. **The known defects in §11 are known.** Reproducing them is not a regression.
   Fixing them silently is: a rewrite that "fixes" them without saying so cannot be
   compared against the original.
5. **"Failures never block replies" (§ principle 5) is a double-edged choice.**
   It is why the plugin stays available when memory breaks, and also why the flush
   race and the silent provenance downgrade produce no error. Whatever a rewrite
   does here, it is a trade — state which side it took.