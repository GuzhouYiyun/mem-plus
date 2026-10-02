# mem-plus

A persistent memory system for AI coding agents. All inference runs on local GGUF models — no external APIs, no per-use billing.

OpenCode itself has no memory: everything a session learns (which files changed, which bug hit, which approach failed) is gone when the tab closes. mem-plus gives OpenCode a real memory system:

- **Session snapshots** — every turn is automatically archived as `memory/YYYY-MM-DD-Title.md`
- **LLM extraction** — a local model distills each turn into a structured entry (what was done / outcome / tags), written to `memory/YYYY-MM-DD.md`
- **Hybrid search** — full-text + vector lanes; the model can automatically find old memories
- **Dreaming digest** — daily entries are compiled into `MEMORY.md` (long-term memory) and `DREAMS.md` (insights log)
- **Prompt injection** — workspace files like `AGENTS.md` and `MEMORY.md` are injected into the system prompt every turn, so the model always "remembers" them

## Prerequisites

- **OpenCode V2** (`@opencode/plugin` 2.0.20 or later; V1 is not supported)
- **Node 22.5+** (or Bun): the retrieval tools rely on `node:sqlite`. Without it, snapshots and extraction keep working; only the search tools are unavailable
- **Two local GGUF models** (~3.7 GB total, see [Local models](#local-models))

## Getting Started

### 1. Clone

```bash
git clone <this-repo> mem-plus
cd mem-plus
```

### 2. Install dependencies

```bash
npm install                  # repo root
cd plugin && npm install     # plugin directory
node plugin/scripts/link-openclaw-alias.mjs   # required — skipping this breaks plugin loading
```

`npm install` also pulls the prebuilt `node-llama-cpp` binary for your platform. Without the dependencies the plugin still loads and snapshots keep writing; only extraction stops.

### 3. Register the plugin

Edit `opencode.jsonc` (global `~/.config/opencode/opencode.jsonc`, or a project-level `opencode.jsonc`):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    "C:/full/path/to/mem-plus/plugin"
  ]
}
```

On Windows use forward slashes, and the path must point at the `plugin/` directory inside the repo (the plugin reads its engine from the repo root, so it cannot be copied out on its own).

### 4. Download the models

Put both files into `mem-plus/models/`:

| File | Size | Purpose | Download |
|---|---|---|---|
| `qwen3.5-4b-q4_k_m.gguf` | ~2.6 GB | extraction | [Hugging Face](https://huggingface.co/Qwen/Qwen3.5-4B-GGUF) |
| `bge-m3-f16.gguf` | ~1.1 GB | vector embedding | [Hugging Face](https://huggingface.co/BAAI/bge-m3-gguf) |

See [Local models](#local-models).

### 5. Build the index (first run)

After registering the plugin, have the model run once:

```
memory_reindex  {"scope": "all", "embed": true}
```

Only after this do `hybrid` / `vector` search modes return results.

## Day-to-day

### The three retrieval tools

The model calls them automatically; you can also name them directly in a conversation.

| Tool | What it does |
|---|---|
| `memory_search` | Search memories. Default is pure text search (fastest, no model needed); `mode: "hybrid"` blends vectors; `scope: "archive"` searches across projects |
| `memory_get` | Read a full entry by id |
| `memory_reindex` | Rebuild the index from markdown files; `embed: true` fills in vectors |

`memory_search` parameters:

- `query` (required)
- `scope` — `project` (default) / `all` / `archive`
- `mode` — `text` (default) / `hybrid` / `vector`
- `limit`, `kind` (`entry` / `snapshot` / `memory`), `tag`, `since`, `until`, `project`

Text search is **AND**-based: every word must match. Start specific, widen if nothing comes back.

### Where data lives

```
<your-project>/
├── MEMORY.md                  # long-term memory
└── memory/
    ├── 2026-10-02.md          # extracted entries
    ├── DREAMS.md              # dreaming digest log
    └── 2026-10-02-fix-bug-x.md # session snapshot
```

Shared data (one index for all projects):

```
~/.config/opencode/mem-plus/
├── index.db                   # search index (safe to delete — rebuild with memory_reindex)
├── mem-plus.log               # log
└── dreaming/<project>.last-day # dreaming marker (delete to force a re-run)
```

The markdown files are the source of truth; the index is a disposable projection.

### Inference service

The plugin starts a local inference service on `127.0.0.1:4748` (a separate process). Multiple OpenCode windows share one service, so VRAM is not duplicated per window. The service exits after 10 minutes idle — it will not keep burning CPU after you close OpenCode.

GPU priority: **dedicated GPU > integrated GPU > CPU**, falling back automatically on failure. The log reports the backend that was picked:

```
[mem-plus] [mem-plus:serve] llama backend = vulkan (gpu) build=prebuilt
```

## Local models

If you swap models:

- **The extraction model must be a completion-style (base) model, not an Instruct / Chat model.** Instruct models silently return empty extraction results. The default `qwen3.5-4b-q4_k_m.gguf` is a base model and works.
- If you only use text search, you can skip the embedding model (`bge-m3`).

## Configuration

Everything is optional. To pass options, use the object form:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "C:/full/path/to/mem-plus/plugin",
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

| Key | Default | Meaning |
|---|---|---|
| `model.content` | `"local"` | `"local"` = GGUF service; `"opencode"` = metered OpenCode model |
| `model.allowHostedFallback` | `false` | allow fallback to the metered model when local inference is down |
| `model.dir` | `<repo>/models` | directory holding the GGUF files |
| `model.contentPath` | `model.dir/qwen3.5-4b-q4_k_m.gguf` | extraction model path |
| `model.embedPath` | `model.dir/bge-m3-f16.gguf` | embedding model path |
| `model.gpu` | `"auto"` | `"auto"` / `"cuda"` / `"vulkan"` / `"cpu"` |
| `model.gpuLayers` | `"auto"` | layers kept in VRAM |
| `model.contextSize` | `16384` | extraction context window |
| `model.maxNewTokens` | `512` | max tokens per extraction |
| `model.threads` | `0` | CPU threads (only used for the CPU fallback) |
| `model.logLevel` | `"warn"` | `"silent"` / `"warn"` / `"info"` / `"debug"` |

### Service

| Key | Default | Meaning |
|---|---|---|
| `service.port` | `4748` | start port; increments up to 4758 if busy |
| `service.host` | `"127.0.0.1"` | bind address (loopback only) |
| `service.autostart` | `true` | start the service if it is not running |
| `service.idleMinutes` | `10` | auto-exit after this many idle minutes; `0` = never |
| `service.startTimeoutMs` | `30000` | how long to wait for the service to become ready |
| `service.url` | — | use an already-running service at this URL |

## Never silently billed

The whole point of this plugin is "inference stays local". When local inference is unavailable (missing models, missing dependencies, port busy, service crashed), the plugin **does not** silently switch to your metered model:

1. Snapshots keep writing (always free)
2. Extraction is deferred; nothing is lost
3. Once the service is back, pending captures are retried

To opt into metered inference, set `model.allowHostedFallback: true` or `model.content: "opencode"` explicitly.

## Dreaming

On the first settled turn of each calendar day, daily entries are digested into `MEMORY.md` and `DREAMS.md`, at most once per day. Delete the marker under `~/.config/opencode/mem-plus/dreaming/` to force a re-run. When the local service is unavailable, dreaming degrades to entries-only (no LLM narrative).

## Prompt injection

At the start of every turn, mem-plus loads the workspace files at the project root (`AGENTS.md`, `SOUL.md`, `IDENTITY.md`, `USER.md`, `BOOTSTRAP.md`, `MEMORY.md`) and injects them into the system prompt, so the long-term memory in `MEMORY.md` is visible to the model every turn.

## Troubleshooting

**Logs**: `~/.config/opencode/mem-plus/mem-plus.log` — check this first.

| Symptom | Cause / action |
|---|---|
| `extraction DISABLED (GGUF not found)` | model not in `models/`. Snapshots keep writing |
| `service did not become healthy ... within 30s` | service did not start. Run it manually: `cd plugin && node serve/server.mjs --port 4748` |
| `local service unavailable; deferring the sweep` | service temporarily down; records are kept and retried |
| empty extraction output (`summary=0 chars`) | extraction model is an Instruct-style model, see [Local models](#local-models) |
| `Index: 0 documents` | run `memory_reindex` |
| `hybrid` / `vector` returns 0 | run `memory_reindex {"embed": true}` and wait for it to finish |
| `memory/` directory never appears | one full turn is required (settled + 2s debounce) |

## License

MIT. This repository contains copies of the memory-related modules of [openclaw](https://github.com/openclaw/openclaw) (MIT, Copyright (c) 2026 OpenClaw Foundation). See [LICENSE](./LICENSE) and [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).
