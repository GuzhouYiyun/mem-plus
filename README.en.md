# mem-plus (English)

**openclaw's memory system, wired into OpenCode, with all inference running on local GGUF models.**

OpenCode does not remember: what a session figured out, which files it touched, which dead ends it hit — all of it collapses into an orphaned session id when the window closes. mem-plus writes it down.

- **The memory engine is openclaw's own** (`extensions/memory-core/src/capture/`), not a rewrite — landing zone → extraction → render → file is preserved intact
- **Only the host changes**: openclaw's `chat.message` hook becomes OpenCode V2 events, and model calls become direct GGUF loads
- **Nothing leaves the machine**: models load from local files, no Ollama, no remote endpoint

> **中文文档见 [`README.md`](./README.md)。**

---

## Status — read this first

**Working, verified end to end**

| Capability | Notes |
|---|---|
| Session snapshots | Every turn re-renders the whole session to `memory/<date>-<title>.md`, tool calls and outputs included |
| LLM extraction | openclaw's original pipeline; emits `## Request` / `## Outcome` plus `Tags`, filters `type="skip"`, keeps openclaw's idempotency marker |
| Global archive | Every project's sessions mirrored to `~/.config/opencode/mem-plus/archive/<project>/` |
| Local models | Measured on a Vulkan iGPU: ~14 s from cold start to written, 4–12 s per extraction |
| **Never bills you** | When local inference is unavailable the plugin does **not** silently switch to your paid OpenCode model. Snapshots keep landing; extraction is deferred until the service is back |
| **Retrieval** | `memory_search` / `memory_get` / `memory_reindex` are registered; SQLite + FTS5 full text, `bge-m3` vectors, hybrid ranking delegated to openclaw's `mergeHybridResults` (0.7 vector / 0.3 text, plus temporal decay and MMR) |

Both halves work: memory is written, and it can be found again.

### The three retrieval tools

The model calls these on its own; you can also ask for them by name.

| Tool | What it does |
|---|---|
| `memory_search` | Search. Defaults to text only (no model load, so it is instant); `mode: "hybrid"` ranks by openclaw's weighted fusion — 200 candidates per lane, 0.7 vector / 0.3 text, then temporal decay, MMR for diversity, then a 0.35 floor; `scope: "archive"` widens the range to the global archive |
| `memory_get` | Read one memory in full, by the unit id a `memory_search` result reported |
| `memory_reindex` | Rebuild the index from the markdown. `embed: true` also embeds everything not embedded yet — **this is the only switch that turns on semantic search** |

Arguments: `query` (required), `scope` (`project` by default / `all` / `archive`), `mode` (`text` by default / `hybrid` / `vector`), `limit`, `kind` (`entry` / `snapshot` / `memory`), `type`, `tag`, `since`, `until`, `project`.

Full-text search is **AND**: every term must appear. Start with the one specific word and widen if nothing comes back.

The index lives at `~/.config/opencode/mem-plus/index.db` and is **shared by every project**, so one search spans both the current project and the global archive. The markdown stays the source of truth; the index can be deleted and rebuilt at any time.

---

## Install

**1. Clone**

```bash
git clone <this-repo> mem-plus
cd mem-plus
```

**2. Install dependencies**

```bash
cd plugin
npm install
```

This pulls `node-llama-cpp` with your platform's prebuilt binaries. **Skipping it still loads the plugin** — extraction simply does not run (snapshots keep working, pending captures stay parked in the landing zone and resume once the service is back). You only need it for local GGUF. See [You are never silently billed](#you-are-never-silently-billed).

**3. Generate the module alias (required)**

```bash
node plugin/scripts/link-openclaw-alias.mjs
```

openclaw's sources refer to each other by the bare specifier `openclaw/plugin-sdk/<name>`. Inside openclaw that resolves through a workspace link plus `tsconfig.json`'s `paths`, which is enough for `tsc` but **not at runtime**: OpenCode loads plugins with bun, and neither bun nor node reads `tsconfig.json`. This repository is a trimmed copy of openclaw's tree with no workspace to link against, so the alias has to exist as real files under `node_modules/`.

The script **generates** `node_modules/openclaw/` from `src/plugin-sdk/*.ts` (about 400 one-line re-export files) rather than vendoring it by hand. The hand-written copy was already 8 files out of date and nothing would have said so. Running it again is a no-op:

```
node plugin/scripts/link-openclaw-alias.mjs --check   # verify only, write nothing
```

The alias lives in `node_modules/`, which `.gitignore` already excludes, so this is a setup step rather than committed content. **Skipping it makes the plugin fail to load** — the symptom is the retrieval tools never appearing.

**4. Register the plugin**

Edit `opencode.jsonc` (project-level, or global at `~/.config/opencode/opencode.jsonc`):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    "C:/Users/you/repos/mem-plus/plugin"
  ]
}
```

Three forms are accepted. On Windows, **prefer forward slashes** to dodge escaping:

```jsonc
"plugins": [
  "/absolute/path/to/mem-plus/plugin",
  "../shared/mem-plus/plugin",
  "file:///home/you/mem-plus/plugin"
]
```

> Point at the **`plugin/` directory inside the repo**, not the repo root — the plugin reads its memory engine from `../extensions/memory-core/`, so copying `plugin/` out on its own will not work.

**5. (Optional) Models**

```bash
mem-plus/models/qwen3.5-4b-q4_k_m.gguf
mem-plus/models/bge-m3-f16.gguf
```

`models/` is gitignored. See [Local models](#local-models).

---

## Configuration

All options go in the `plugins` array of `opencode.jsonc`, using the object form. **Every option is optional.**

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "C:/Users/you/repos/mem-plus/plugin",
      "options": {
        "model": { "gpu": "auto" },
        "service": { "port": 4748 }
      }
    }
  ]
}
```

Full example: [`opencode.example.jsonc`](./opencode.example.jsonc).

### Model

| Option | Default | Meaning |
|---|---|---|
| `model.content` | `"local"` | `"local"` uses local GGUF; `"opencode"` **actively asks** for your metered OpenCode model |
| `model.allowHostedFallback` | `false` | Whether an *unavailable local service* may be covered by the metered model. Default `false` — see [You are never silently billed](#you-are-never-silently-billed) |
| `model.dir` | `<repo>/models` | Directory holding the GGUF files |
| `model.contentPath` | `<model.dir>/qwen3.5-4b-q4_k_m.gguf` | Extraction model |
| `model.embedPath` | `<model.dir>/bge-m3-f16.gguf` | Embedding model |
| `model.gpu` | `"auto"` | `"auto"` / `"cuda"` / `"vulkan"` / `"cpu"` |
| `model.gpuLayers` | `"auto"` | Layers to offload; `"auto"` sizes to current VRAM |
| `model.contextSize` | `16384` | Extraction context length |
| `model.maxNewTokens` | `512` | Cap on tokens generated per extraction |
| `model.threads` | `0` | CPU threads, `0` = unlimited (CPU fallback only) |
| `model.logLevel` | `"warn"` | `"silent"` / `"warn"` / `"info"` / `"debug"` |

### You are never silently billed

The entire point of this plugin is that inference stays local. So when local inference is **unavailable** — GGUF in the wrong directory, dependencies not installed, port taken, service crashed — the plugin does **not** route extraction to your metered OpenCode model. The default is:

1. Snapshots keep landing (this part is free)
2. **Extraction is skipped**; the pending record stays in the landing zone with its retry count untouched
3. When the service is back, the next sweep extracts normally

The log says so:

```
[mem-plus] local service unavailable; deferring the sweep. Snapshots keep working
           and pending captures are retried once the service is back
```

**Why not "fall back on failure"?** Two reasons, both measured rather than argued.

**One: falling back burns money quietly.** An earlier version did fall back by default, so the one extraction that ran while the local service was down went through your paid model — visible nowhere but a log line. A plugin that advertises free local inference has no business turning a configuration mistake into an API bill.

**Two: throwing is worse than billing.** openclaw's pipeline retries a failed extraction 3 times with a 2 s base delay, then parks the record permanently. Running the real pipeline against a transport that always throws:

```
complete() called 3 times → outcome = exhausted → still pending = 0
```

A ten-second outage and the memory is gone. So the plugin probes the service *before* the sweep claims anything:

```
service down → sweep skipped, complete() never called, attempts still 0, record kept
service back → captured on the first attempt, complete() called once
```

To opt into metered extraction, either way:

```jsonc
{
  "model": {
    "allowHostedFallback": true   // cover an unavailable local service
  }
}
```

```jsonc
{
  "model": {
    "content": "opencode"        // always use the metered model
  }
}
```

### Inference service

| Option | Default | Meaning |
|---|---|---|
| `service.port` | `4748` | Base port; walks forward when busy, up to `4758` |
| `service.host` | `"127.0.0.1"` | Loopback only |
| `service.autostart` | `true` | Let the plugin start it; `false` connects only |
| `service.idleMinutes` | `10` | Self-exit after this long idle; `0` disables the reaper |
| `service.startTimeoutMs` | `30000` | How long to wait for a fresh spawn |
| `service.url` | — | Point at a full address to bypass discovery and autostart |

Run one yourself if you want it warm:

```bash
cd plugin
node serve/server.mjs --port 4748 --idle-minutes 0
curl http://127.0.0.1:4748/health
```

A service you started is yours to stop — `dispose` only reclaims one the plugin spawned.

### GPU priority

Backends are tried **discrete GPU > integrated GPU > CPU**, explicitly rather than by letting the library guess:

| Order | Value | Hardware |
|---|---|---|
| 1 | `cuda` | NVIDIA discrete |
| 2 | `metal` | Apple discrete / unified memory |
| 3 | `vulkan` | AMD / Intel discrete, every iGPU (llama.cpp then picks the strongest Vulkan device) |
| 4 | `false` | CPU only |

A backend that fails to load degrades to the next one instead of taking the plugin down. The log names the winner:

```
[mem-plus] [mem-plus:serve] llama backend = vulkan (gpu) build=prebuilt
```

---

## Using retrieval

### The three modes

| Mode | Needs the model | Notes |
|---|---|---|
| `text` | no | FTS5 full text + bm25. **Default**, and the only one that works with the service down |
| `hybrid` | yes | Full text and vectors fused at 0.7 / 0.3 by openclaw's `mergeHybridResults`. A unit that hits **both** ways ranks first |
| `vector` | yes | Pure semantics — matches with no shared keywords, but nothing literal at all |

Text is the default not out of caution but because it costs **nothing**: the first `bge-m3` load takes seconds. Only once the model is warm is the vector channel worth it.

Two details of hybrid ranking that are easy to be surprised by:

- **The text score is mapped before anything is fused.** bm25 is a negative number with no upper bound, so it cannot be added to a cosine as-is. openclaw's `bm25RankToScore` saturates it to `r / (1 + r)`, which lands in `[0, 1)` and makes the two lanes commensurable.
- **Text-only hits fall under the 0.35 floor, on purpose.** A hit with no vector-side evidence can score at most `0.3 x textScore`, about 0.23. That is below the floor, and `selectHybridSearchResults` fills the remaining slots from the keyword lane so a plain text query does not come back empty. So a hybrid result whose order looks wrong is usually not a bug — there was nothing to vector-search.

### First run: build the index

The plugin does **not** index existing memory files at startup. The only two lines it logs are:

```
[mem-plus] index C:\Users\you\.config\opencode\mem-plus\index.db
[mem-plus] retrieval tools ready: memory_search, memory_get, memory_reindex
```

(There is a startup sweep, but it processes prompts that have not been extracted yet — it is not a reindex of what is already on disk.)

Trigger it once yourself:

```
memory_reindex  {"scope": "all", "embed": true}
```

Until that finishes, `mode: "hybrid"` and `mode: "vector"` have nothing to search. `embedBudget` caps how many units one call embeds (40 by default, 500 maximum).

### Rebuilding by hand

Markdown is the source of truth; the index can be thrown away and rebuilt whenever you like. After editing files by hand, after copying memories from another machine, or when results are obviously wrong:

```
memory_reindex  {"scope": "all"}
```

- Files are judged by **size + mtime**, so untouched files are skipped
- Files deleted from disk have their index rows pruned (`Removed N document(s) deleted from disk`)
- Running it twice is idempotent — no duplicate units

### The index needs `node:sqlite`

Node 22.5+ or Bun. **Its absence is not fatal**: snapshots and extraction keep working, the three tools simply are not registered, and the log says:

```
[mem-plus] index unavailable (no node:sqlite in this runtime) -- capture continues, search will not work
```

### When a search finds nothing

1. **`Index: 0 documents`** → the index is empty; run `memory_reindex`
2. **Text finds it, hybrid does not** → the vector channel was never built; run `memory_reindex {"embed": true}`
3. **`**Search degraded:**` in the output** → the SQL itself failed, this is not "no matches". The reason is in the log
4. **`Vector search needs the local inference service`** → the service is down; `text` still works
5. **A word you know is there returns nothing** → full-text search is AND, so drop to a single term

---

## Architecture: why there is a 4748 service

```
OpenCode plugin (bun process)
   │  events, files, HTTP calls; autostarts and reaps the service
   ▼
127.0.0.1:4748  ← separate Node process
   ├─ node-llama-cpp (native binding loads normally here)
   ├─ qwen extraction + bge-m3 embeddings, both held warm
   └─ /health  /extract  /embed
```

**Why it cannot run inside the plugin process**

node-llama-cpp self-tests its native binding by forking a child process (`testBindingBinary.js`). OpenCode plugins run under bun, where `process.execPath` is the opencode binary rather than node — so the fork always fails, the binding never loads, and there is no compiler to fall back to. Measured: standalone `node` and standalone `bun` both load it fine (`build=prebuilt`); only the plugin host fails. No environment variable skips the test.

**What the split buys**

- **One model instance shared by every project** — four OpenCode windows cost one 4 GB load, not four
- The 4 GB stays in its own process; a llama.cpp crash cannot take down the OpenCode server
- Models stay warm between extractions
- When something breaks you `curl` it instead of reading plugin internals

**4748 rather than 4747**: opencode-mem already owns 4747 for its memory management web UI, and two things must not collide on one machine.

**Idle reaping**: the models hold ~4 GB. The service exits by default after 10 idle minutes so it is not still sitting on CPU and memory after you close OpenCode.

---

## Local models

| Purpose | Default filename | Size | Role |
|---|---|---|---|
| Extraction | `qwen3.5-4b-q4_k_m.gguf` | ~2.6 GB | Summarizes one assistant turn into a structured entry |
| Embedding | `bge-m3-f16.gguf` | ~1.1 GB | Embeds memory chunks; the foundation for `hybrid` / `vector` retrieval |

Elsewhere is fine — point `model.dir` / `model.contentPath` / `model.embedPath` wherever they live. Models load lazily, so a project that never extracts never pays the ~4 GB.

> **Required?** Both files live in `models/` (gitignored, ~3.7 GB — too big for the repo). Without them the plugin still runs, but extraction does not execute and vector retrieval is unavailable: you are left with snapshot-writing plus pure-text search. If you only need text search, the embedding model can be skipped.
>
> **Where to download**: both are GGUF weights on Hugging Face — search `qwen3.5 4b q4_k_m gguf` and `bge-m3 f16 gguf` by filename. With the CLI: `huggingface-cli download <repo> <filename> --local-dir models`.

> **Windows note**: Defender real-time scanning slows GGUF inference down badly. If extraction crawls, exclude the `models/` directory from Defender (needs administrator).

### The extraction model must be a completion model

This is worth its own section, because it fails silently: no error, just an empty string.

`Qwen3.5 4b **Src**` — Src means source, i.e. **pretrained weights, not Instruct**. It ships a `chat_template`, but the weights were never instruction-tuned. Hand it `LlamaChatSession`'s chat template and it emits EOS immediately:

```
extract done in 12946 ms (0 chars)
```

The streaming callback never fires either — it looks like a crash, but the model is correctly saying nothing.

So extraction uses **`LlamaCompletion` + few-shot + a GBNF grammar**, each layer doing one job:

| Layer | Job |
|---|---|
| openclaw's original system prompt | Owns the language choice and the `## Request` / `## Outcome` format |
| 5 few-shot examples | Teaches a base model the shape — 2 skips, 3 technical, covering several `type` values |
| GBNF grammar | Generated from openclaw's `CAPTURE_SUMMARY_JSON_SCHEMA`; a malformed reply becomes structurally impossible |

The skip examples must keep `tags: []`, so the grammar layer **cannot** add `minItems` — that would make "skip" itself an illegal output.

`type` is additionally reconciled in both directions against summary presence: a source checkpoint will write a real summary and then label it `skip`, and will skip content that deserved a memory. **The summary is the signal** — an empty summary is always `skip`, and a non-empty summary is never discarded over one mislabelled token.

**If you swap in an Instruct model**: `LlamaChatSession` will be more accurate, but few-shot + grammar keeps working, so no config change is needed.

---

## Logs

OpenCode's plugin API **has no logging interface**, and a plugin's `console.log` reaches neither `--print-logs` nor `~/.local/share/opencode/log/opencode.log` (verified 2026-10-01). So the plugin writes its own:

```
~/.config/opencode/mem-plus/mem-plus.log
```

Rotates past 2 MB, keeping one `.1`. A healthy run:

```
2026-10-01T09:27:40.333Z [mem-plus] snapshot 904 B -> ...\memory\2026-10-01-creating-and-verifying-hello-txt-with-memplus.md
2026-10-01T09:27:40.671Z [mem-plus] starting service: node ...\serve\server.mjs --port 4748
2026-10-01T09:27:40.756Z [mem-plus] [mem-plus:serve] listening on http://127.0.0.1:4748
2026-10-01T09:27:41.683Z [mem-plus] [mem-plus:serve] llama backend = vulkan (gpu) build=prebuilt
2026-10-01T09:27:46.111Z [mem-plus] [mem-plus:serve] content model loaded: ...\qwen3.5-4b-q4_k_m.gguf
2026-10-01T09:27:54.079Z [mem-plus] [mem-plus:serve] extract done in 7965 ms (type=feature, tags=2, summary=184 chars)
2026-10-01T09:27:54.095Z [mem-plus] captured prompt_1790846851535_8df77c4 -> memory/2026-10-01.md
```

The service's own output is relayed into the same file, so anything prefixed `[mem-plus:serve]` came from port 4748.

---

## Files it produces

### In your project

```
<your-project>/
├── MEMORY.md                            # promoted long-term memory
└── memory/
    ├── 2026-10-01.md                    # extracted entries, one file per day
    └── 2026-10-01-create-and-verify-hello-txt.md   # full session snapshot
```

A real extracted entry:

```markdown
## 2026-10-01T09:27:40.333Z · auto-capture · feature

## Request
Create a file named hello.txt containing the word memplus, then read it back to verify.

## Outcome
Created hello.txt with content 'memplus' and verified by reading it back.

Tags: file-creation, verification
<!-- openclaw-capture:prompt_1790846851535_8df77c4 -->
```

That trailing comment is openclaw's original provenance marker — it is what makes re-delivery idempotent and keeps the entry traceable.

### Global archive

```
~/.config/opencode/mem-plus/archive/<project>--<path-hash>/
├── INDEX.md
└── memory/
```

The path hash keeps same-named projects from colliding. On Windows, `~/.config` is `C:\Users\<you>\.config`.

### The index

```
~/.config/opencode/mem-plus/
├── index.db           # SQLite + FTS5, shared by every project
├── index.db-wal
├── index.db-shm
├── archive/           # the global archive above
└── mem-plus.log
```

`index.db` holds three tables: units, the full-text index (FTS5), and vectors (1024-dim Float32 BLOBs). **It is not the source of truth** — the markdown is. Deleting the index loses no memory; `memory_reindex` rebuilds it.

---

## How it works

```
you type a prompt
   │
   ├─ session.inbox.enqueued ──► landing zone (captured 0/1/2)
   │                              inboxID makes re-delivery idempotent
   │
   ├─ assistant turn runs
   │
   └─ session.execution.succeeded ──► wait 2 s for the turn to settle
                                     │
                                     ├─► re-render the session → snapshot + archive mirror
                                     │     └─► re-index the whole file into SQLite
                                     │
                                     └─► extraction pipeline:
                                          claim → slice the assistant turn
                                                → bounded markdown context
                                                → LLM extraction
                                                → filter type="skip"
                                                → render
                                                → append memory/<date>.md
                                                └─► index only the appended block

when you search
   │
   └─► memory_search
         ├─ split into retrieval units (entry / snapshot turn / long-term section)
         ├─ FTS5 full text, bm25 ranked
         ├─ bge-m3 vector, cosine ranked          ← hybrid and vector only
         └─ openclaw mergeHybridResults: 0.7/0.3 weighted fusion → temporal decay
             → project boost → MMR → 0.35 floor
```

Design calls worth knowing:

- **`session.inbox.enqueued` over `session.hook("prompt")`** — the former is the *durable* admission boundary and carries a stable `inboxID`; the latter fires before admission, so the text may not be final.
- **Inference in a separate process** — see [Architecture](#architecture-why-there-is-a-4748-service)
- **Snapshots upsert every turn** — OpenCode V2 has no session-leave hook
- **2 s debounce** — one turn fires several completion events; coalescing them avoids duplicate extraction
- **Extraction runs in the background** and never blocks you
- **The write path never depends on the index** — markdown lands first and the index projects it. A broken search cannot cost you a memory, and a lost index is rebuilt by `memory_reindex`
- **Append-only files parse only the new block; snapshots are re-read whole** — the former only grows, the latter is rewritten every turn. Taking the cheap path on a snapshot would leave the previous turn's turns behind as duplicate hits
- **Weighted fusion, not RRF** — an earlier version used reciprocal rank fusion, on the reasoning that bm25 is an unbounded negative number while cosine is 0–1 so there is no common scale. That reasoning does not hold: openclaw's `bm25RankToScore` saturates bm25 to `r / (1 + r)` in `[0, 1)`, so the scale problem is already solved. And RRF looks only at positions, which throws away exactly the magnitudes the 0.7/0.3 split exists to weigh. It now calls openclaw's `mergeHybridResults` directly
- **Only one copy of the project/archive mirror is indexed** — every capture writes the snapshot to both the project directory and the global archive, and the two files are byte-identical. De-duplication keys on the **document content hash** and the project copy wins; the archive document row is kept but gets no units. If the project copy is deleted, the archive takes the content back. Rows indexed before this existed need one `memory_reindex` to acquire a hash and heal

---

## Troubleshooting

**Where are the logs?** `~/.config/opencode/mem-plus/mem-plus.log`. Start there — it is more useful than OpenCode's own.

**Extraction comes back empty / `summary=0 chars` with `type=skip`** — most likely the content model is instruction-tuned (Instruct/Chat) but is being driven like a base model, or the reverse. Read the `summary` length in parentheses after `extract done in Xms`; a persistent 0 means the model is not a fit, see [The extraction model must be a completion model](#the-extraction-model-must-be-a-completion-model).

**`service did not become healthy ... within 30s`** — the service did not start. Look for the `[mem-plus:serve]` lines: missing model file, every port taken, or dependencies not installed. Run it by hand to see the error:

```bash
cd plugin
node serve/server.mjs --port 4748
```

**`extraction DISABLED (GGUF not found)`** — the model files are not where the config says; the log names the exact missing path. Snapshots still land, there is just no extraction.

**`local service unavailable; deferring the sweep`** — the service is temporarily unavailable. Records are kept pending until it returns. Not an error.

**`using the OpenCode model ... (metered)`** — you enabled `model.allowHostedFallback`, so that extraction cost money.

**Extraction is very slow** — hardware-dependent. Keep `model.gpu: "auto"` and read the backend and per-call timings from the log. To route to OpenCode's hosted model for now: `"model": { "content": "opencode" }` (**metered**).

**`memory/` never appears** — a session needs at least one *completed* turn. Then allow the 2 s debounce plus the extraction run. Search the log for the `snapshot` and `captured` lines to confirm.

**Log shows `sweep: nothing pending`** — snapshots are being written but extraction has nothing to do, meaning the landing zone never received the prompt (usually the event is not arriving).

### Retrieval

**Nothing is findable (`Index: 0 documents`)** — the index is empty. Run `memory_reindex`.

**Files exist under `memory/` but the model reports nothing** — check `scope`. The default is `project`, so it only covers the current project; cross-project search needs `scope: "all"` explicitly.

**`mode: "hybrid"` and `"vector"` return 0 while text works** — the vector channel was never built. A fresh clone has nothing embedded; run `memory_reindex {"embed": true}` and let it finish.

**`**Search degraded:**` in the output** — not "no matches": the SQL itself failed. `searchText` reports the reason in the result instead of silently returning nothing, and the log has the full error.

**Searching an identifier with an underscore (`memory_search`) finds nothing** — an early version stripped `_` as a markdown emphasis marker, turning `memory_search` into `memorysearch`. Fixed: FTS5's unicode61 already treats `_` as a separator, and both sides have to agree.

**`node:sqlite` is unavailable** — needs Node 22.5+ or Bun. Without it snapshots and extraction continue normally; only the three tools go unregistered, and the log reads `index unavailable (no node:sqlite in this runtime)`.

---

## License and provenance

This repository contains openclaw's memory subsystem under its original license.

- **openclaw** — MIT License, Copyright (c) 2026 OpenClaw Foundation (see [`LICENSE`](./LICENSE))
- **Pi / pi-mono** and other third-party portions — see [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md)
- Sub-packages carrying their own notices keep them in-tree (`packages/ai/LICENSE`, `packages/gateway-client/LICENSE`, `packages/gateway-protocol/LICENSE`, `extensions/facetime/LICENSE`, `extensions/typesafe/LICENSE`)

Everything under `plugin/` is new: the OpenCode adapter, the HTTP client, and the local inference service.