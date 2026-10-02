# mem-plus

A persistent memory system for AI coding agents that enables long-term context retention across sessions, with all inference running locally on GGUF models.

[![npm version](https://img.shields.io/npm/v/mem-plus.svg)](https://www.npmjs.com/package/mem-plus)
[![license](https://img.shields.io/npm/l/mem-plus.svg)](https://www.npmjs.com/package/mem-plus)

OpenCode itself has no memory: whatever a session learns — which files were changed, what the bug was, which approach failed — is discarded when the tab closes. mem-plus fixes this by giving OpenCode a real memory system: session snapshots, LLM extraction, search, dreaming, and prompt injection, all powered by local GGUF models through a bundled local inference server.

## Core Features

- **Session snapshots**: every turn's full transcript (messages, tool calls, outputs) is rendered as `memory/YYYY-MM-DD-Title.md`
- **Automatic capture**: after each assistant turn, an LLM summarizes what was done (Request / Outcome / Tags)
- **SQLite + FTS5 + vector hybrid index**: entries, snapshots, and MEMORY.md are indexed with `node:sqlite`; FTS5 full-text + bge-m3 cosine vectors fused via openclaw's `mergeHybridResults`
- **Three retrieval tools**: `memory_search`, `memory_get`, `memory_reindex`
- **Dreaming weekly summary**: a nightly sweep consolidates daily entries, rewrites Dreams into `MEMORY.md`
- **Prompt injection**: workspace bootstrap files (`AGENTS.md`, `SOUL.md`, `IDENTITY.md`, `USER.md`, `BOOTSTRAP.md`, `MEMORY.md`) are loaded and injected into the session's system prompt before each model request
- **Zero billing**: all inference runs on your hardware (local GGUF via bundled `server.mjs` on port 4748). No usage-based API calls, no metered fallback.

## Prerequisites

- **OpenCode V2** (`@opencode/plugin` 2.0.20+). V1 is not supported.
- **Node 22.5+** (for `node:sqlite`) or **Bun**.
- **Two local GGUF models** (see [Local Models](#local-models)).
- **2 GB+ free disk** for the models.

## Getting Started

### 1. Clone

```bash
git clone <this-repo> mem-plus
cd mem-plus
```

### 2. Install dependencies

```bash
npm install
cd plugin && npm install && cd ..
node plugin/scripts/link-openclaw-alias.mjs
```

### 3. Register the plugin

Edit `~/.config/opencode/opencode.jsonc`:

```jsonc
{
  "plugins": ["<absolute-path-to>/mem-plus/plugin"]
}
```

### 4. Place local models

Download both files into `mem-plus/models/`:

| File | Size | Download |
| --- | --- | --- |
| `qwen3.5-4b-q4_k_m.gguf` | ~2.6 GB | [Hugging Face](https://huggingface.co/Qwen/Qwen3.5-4B-GGUF) |
| `bge-m3-f16.gguf` | ~1.1 GB | [Hugging Face](https://huggingface.co/BAAI/bge-m3-gguf) |

### 5. Build the index

Inside OpenCode, run:

```
memory_reindex  {"scope": "all", "embed": true}
```

## How to use day-to-day

### The three retrieval tools

The model calls these automatically; you can also name them in conversation.

| Tool | What it does |
|---|---|
| `memory_search` | Retrieve memories. Default: pure text (FTS5, no model needed, fastest). `mode: "hybrid"` fuses FTS5 + vector hits (0.7/0.3 weighted, openclaw's `mergeHybridResults`, temporal decay, MMR de-duplication, 0.35 floor). `scope: "archive"` searches the global cross-project archive. |
| `memory_get` | Read one memory in full by unit id from a `memory_search` result. |
| `memory_reindex` | Rebuild the index from markdown files. `embed: true` also embeds all entries that have not been embedded yet — this is the **only way to enable vector search**. |

Parameters:

- `query` (required)
- `scope` — `project` (default) / `all` / `archive`
- `mode` — `text` (default) / `hybrid` / `vector`
- `limit`, `kind` (`entry` / `snapshot` / `memory`), `type`, `tag`, `since`, `until`, `project`

Full-text search is **AND**: all terms must appear. Start with a specific word; widen if you get nothing.

The index lives at `~/.config/opencode/mem-plus/index.db`, shared across all projects. Markdown is the source of truth — the index is a disposable projection; delete it and rebuild with `memory_reindex`.

### First time: build the index

The plugin does not index existing files at startup. After registration, run:

```
memory_reindex  {"scope": "all", "embed": true}
```

Only after this do `hybrid` and `vector` modes return results. Set `embedBudget` to raise the embedding cap in one run (default 40, max 500).

### Manual index rebuild

Run:

```
memory_reindex  {"scope": "all"}
```

- Files are identified by size + mtime — unchanged files are skipped.
- Files deleted from disk are pruned from the index (`Removed N document(s) deleted from disk`).
- Re-running is idempotent.

### node:sqlite in the runtime

Requires Node 22.5+ or Bun. Without it, snapshotting and extraction keep working, retrieval tools are not registered, and the log says `index unavailable (no node:sqlite in this runtime)`.

## Architecture

```
OpenCode plugin (Bun process)
  │
  │  events (inbox → execution succeeded)
  │  write snapshot · run capture · index
  │  HTTP to 127.0.0.1:4748
  ▼
127.0.0.1:4748  --  standalone Node process
  ├─ node-llama-cpp
  ├─ qwen3.5-4b (extraction) + bge-m3 (embedding) both resident
  └─ /health  /extract  /generate  /embed
```

**Why the 4748 server?** `node-llama-cpp`'s native binding fails to load inside OpenCode's Bun host (its fork-based self-test can't resolve `node`). A standalone Node process loads the binding fine. Splitting also means one ~4 GB model instance is shared across all OpenCode windows rather than one per window.

**Why 4748?** opencode-mem's web UI occupies 4747. No conflict.

**Idle auto-exit:** the service has a 10-minute idle timeout (`service.idleMinutes`) so it does not burn CPU after you close OpenCode.

## Local Models

`models/` is gitignored (~3.7 GB). You must place two files yourself:

| Purpose | Default filename | Size | Role |
|---|---|---|---|
| Extraction | `qwen3.5-4b-q4_k_m.gguf` | ~2.6 GB | Summarizes one assistant turn into a structured entry |
| Embedding | `bge-m3-f16.gguf` | ~1.1 GB | Embeds memory chunks for `hybrid` / `vector` search |

### Where to download

Both are GGUF weights available on Hugging Face. Search by filename:

- `qwen3.5 4b q4_k_m gguf`
- `bge-m3 f16 gguf`

CLI:

```bash
huggingface-cli download <repo> <file> --local-dir models
```

If you only need text-mode retrieval, the embedding model can be skipped. Both models load lazily; a project that triggers no extraction never holds the ~4 GB.

**Extraction model requires a completion-style model (not an Instruct/Chat one).** Using an Instruct model makes extraction silently return empty output. The default `qwen3.5-4b-q4_k_m.gguf` is a base (Src) model and works. The extraction pipeline uses `LlamaCompletion` + few-shot examples + GBNF grammar constraint, so the model's native chat template is irrelevant.

## Configuration

All configuration is optional. Set it in the `plugins` array of `opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "C:/full/path/to/mem-plus/plugin",
      "options": {
        "model": {
          "gpu": "auto"
        },
        "service": {
          "port": 4748
        }
      }
    }
  ]
}
```

See [`opencode.example.jsonc`](./opencode.example.jsonc) for a full example.

### Model

| Key | Default | Description |
|---|---|---|
| `model.content` | `"local"` | `"local"` = GGUF service; `"opencode"` = use OpenCode's (metered) model |
| `model.allowHostedFallback` | `false` | Allow metered OpenCode model when local inference is unavailable |
| `model.dir` | `<repo>/models` | Directory containing the GGUF files |
| `model.contentPath` | `model.dir/qwen3.5-4b-q4_k_m.gguf` | Extraction model path |
| `model.embedPath` | `model.dir/bge-m3-f16.gguf` | Embedding model path |
| `model.gpu` | `"auto"` | `"auto"` / `"cuda"` / `"vulkan"` / `"cpu"` |
| `model.gpuLayers` | `"auto"` | Layers in VRAM |
| `model.contextSize` | `16384` | Context window for extraction |
| `model.maxNewTokens` | `512` | Max tokens per extraction |
| `model.threads` | `0` | CPU thread count (0 = unlimited, only for CPU fallback) |
| `model.logLevel` | `"warn"` | `"silent"` / `"warn"` / `"info"` / `"debug"` |

### Service

| Key | Default | Description |
|---|---|---|
| `service.port` | `4748` | Start port; auto-increment if busy, max `4758` |
| `service.host` | `"127.0.0.1"` | Bind address (loopback only) |
| `service.autostart` | `true` | Start the service if not already running |
| `service.idleMinutes` | `10` | Shut down after this many idle minutes; `0` = never |
| `service.startTimeoutMs` | `30000` | Time budget for the service to become ready |
| `service.url` | — | Use an already-running service at this URL |

### GPU priority

The service tries backends in order: dedicated GPU > recommended GPU > CPU:

| Order | Value | Hardware |
|---|---|---|
| 1 | `cuda` | NVIDIA dGPU |
| 2 | `metal` | Apple dGPU / unified memory |
| 3 | `vulkan` | AMD / Intel dGPU or iGPU |
| 4 | `false` | CPU only |

If one backend fails, it falls back to the next. The log reports the final choice:

```
[mem-plus] [mem-plus:serve] llama backend = vulkan (gpu) build=prebuilt
```

## Never silently billed

The whole point of this plugin is "all inference is local". If local inference is **unavailable** (GGUF missing, deps not installed, port busy, service crashed), the plugin does **not** silently use your paid OpenCode model. Default behavior:

1. Snapshots still write (always free).
2. Extraction is **skipped**; the record stays in the landing zone with its retry counter untouched.
3. When the service is back, the next sweep extracts normally.

The log records:

```
[mem-plus] local service unavailable; deferring the sweep. Snapshots keep working
           and pending captures are retried once the service is back
```

To opt into billed behavior, set `model.allowHostedFallback: true` or `model.content: "opencode"`.

## Dreaming

Dreaming is a periodic consolidation pass that distills daily entries into a `MEMORY.md` long-term memory file and a `DREAMS.md` insight log. In openclaw, it runs on a cron schedule. mem-plus has no cron; it triggers at most once per calendar day on the first settled turn.

The marker for the last run is at `~/.config/opencode/mem-plus/dreaming/<slug>.last-day`. Delete this directory to force a re-run on the next turn.

When the local service is down, dreaming falls back to writing entries without LLM narrative.

## Prompt injection

On each `session.hook("context")` call, mem-plus loads workspace bootstrap files — `AGENTS.md`, `SOUL.md`, `IDENTITY.md`, `USER.md`, `BOOTSTRAP.md`, `MEMORY.md` — from the project root, applies openclaw's per-file and total character budget, and prepends the formatted `# Project Context` block to the system prompt. This makes `MEMORY.md` and the other workspace context files visible to every turn.

## File layout

```
<your-project>/
├── MEMORY.md                      # promoted long-term memory
├── memory/
│   ├── 2026-10-02.md              # extracted entries (one block per prompt)
│   ├── DREAMS.md                  # dreaming log
│   └── 2026-10-02-fix-bug-x.md    # full session snapshot
└── (openclaw source vendored at)
    extensions/memory-core/        # capture pipeline, ranking, dreaming
    src/agents/                    # workspace bootstrap loader, system prompt
```

```
~/.config/opencode/mem-plus/
├── index.db                       # SQLite + FTS5 index, all projects share this one
├── index.db-wal
├── index.db-shm
├── archive/<project>--<hash>/     # cross-project snapshot mirror
├── mem-plus.log                   # plugin log (rotates at 2 MB)
└── dreaming/<slug>.last-day       # dreaming marker
```

Markdown is the source of truth; the index is a projection. Dropping `index.db` is safe — rebuild with `memory_reindex`.

## Troubleshooting

**Log?** `~/.config/opencode/mem-plus/mem-plus.log`. Always check this first.

**No extraction output / `summary=0 chars` + `type=skip`?** Almost certainly the content model is instruction-tuned but being used as a base model (or vice versa). Check the `summary` length in `extract done in Xms ...` log lines; persistent 0 means the model is unsuitable — see [Local Models](#local-models).

**`service did not become healthy ... within 30s`** Service did not start. Run manually:

```bash
cd plugin
node serve/server.mjs --port 4748
```

**`extraction DISABLED (GGUF not found)`** Models not in `models/`. Snapshots keep working.

**`local service unavailable; deferring the sweep`** Service temporarily down. Records are preserved, not lost.

**`memory/` directory never appears** A completed turn is required (settle + 2s debounce).

**`Index: 0 documents`** Run `memory_reindex`.

**Hybrid/vector mode returns 0** Run `memory_reindex {"embed": true}` and wait for it.

**`**Search degraded:**` in output** SQL failure, not "no results". Check logs.

## Vendored source and license

mem-plus ships a partial copy of [openclaw](https://github.com/openclaw/openclaw) (MIT License, Copyright (c) 2026 OpenClaw Foundation) in `src/`, `extensions/`, and `packages/`. Only memory-relevant modules are retained. See [LICENSE](./LICENSE) and [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).

The plugin adaptation layer (`plugin/src/`, `plugin/serve/`, `plugin/scripts/`) is new code.
