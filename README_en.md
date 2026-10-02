# mem-plus

A persistent memory system for AI coding agents. All inference runs on local GGUF models; no external API calls, no usage-based billing.

OpenCode itself retains no memory: information gained within a session (files modified, problems encountered, approaches that failed) is lost when the session ends. mem-plus provides OpenCode with a persistent memory system:

- **Session snapshots** — each turn is automatically archived as `memory/YYYY-MM-DD-Title.md`
- **LLM extraction** — a local model distills each turn into a structured entry (request / outcome / tags), written to `memory/YYYY-MM-DD.md`
- **Hybrid search** — full-text and vector lanes; the model retrieves historical memories automatically
- **Dreaming digest** — daily entries are compiled into `MEMORY.md` (long-term memory) and `DREAMS.md` (insights log)
- **Prompt injection** — workspace files such as `AGENTS.md` and `MEMORY.md` are injected into the system prompt before every turn, so their content is always visible to the model

## Prerequisites

- **OpenCode V2** (`@opencode/plugin` 2.0.20 or later; V1 is not supported)
- **Node 22.5+** (or Bun): the retrieval tools depend on `node:sqlite`. If unavailable, snapshots and extraction continue to work; only the search tools are missing
- **Two local GGUF models** (~3.7 GB total, see [Local models](#local-models))

## Getting Started

### 1. Clone into the OpenCode plugins directory

Clone mem-plus into OpenCode's global plugins directory `~/.config/opencode/plugins/` so it is managed alongside your other plugins:

```bash
# Linux / macOS
mkdir -p ~/.config/opencode/plugins
git clone <this-repo> ~/.config/opencode/plugins/mem-plus
cd ~/.config/opencode/plugins/mem-plus
```

```powershell
# Windows
New-Item -ItemType Directory -Force "$env:USERPROFILE\.config\opencode\plugins"
git clone <this-repo> "$env:USERPROFILE\.config\opencode\plugins\mem-plus"
cd "$env:USERPROFILE\.config\opencode\plugins\mem-plus"
```

### 2. Install dependencies

```bash
npm install                  # repository root
cd plugin && npm install     # plugin directory
node plugin/scripts/link-openclaw-alias.mjs   # required; skipping it prevents the plugin from loading
```

`npm install` also pulls the prebuilt `node-llama-cpp` binary for the platform. Without the dependencies, the plugin still loads and session snapshots keep writing; LLM extraction is not performed.

### 3. Register the plugin

Edit `opencode.jsonc` (the global `~/.config/opencode/opencode.jsonc`, or a project-level `opencode.jsonc`):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    "C:/full/path/to/mem-plus/plugin"
  ]
}
```

On Windows, paths must use forward slashes and must point at the `plugin/` directory inside the repository (the plugin reads its engine from the repository root and cannot be copied out on its own).

### 4. Download the models

Place both files in `mem-plus/models/`:

| File | Size | Purpose | Download |
|---|---|---|---|
| `qwen3.5-4b-q4_k_m.gguf` | ~2.6 GB | extraction | [Hugging Face](https://huggingface.co/Qwen/Qwen3.5-4B-GGUF) |
| `bge-m3-f16.gguf` | ~1.1 GB | vector embedding | [Hugging Face](https://huggingface.co/BAAI/bge-m3-gguf) |

See [Local models](#local-models).

### 5. Index existing files (optional)

Memory entries written after registration are added to the retrieval index automatically. A full index pass is required only if `memory/` or `MEMORY.md` files pre-date the plugin registration (e.g. manually written session logs, or files migrated from another project) — those are not scanned automatically:

```
memory_reindex  {"scope": "all", "embed": true}
```

- Scans all existing memory files and rebuilds the index. Idempotent; safe to repeat.
- `embed: true` computes a vector for each chunk via the embedding model, enabling `hybrid` / `vector` semantic search. For full-text search only, run `{"scope": "all"}`.

## Day-to-day usage

### The three retrieval tools

The model invokes them automatically; users may also invoke them explicitly in a session.

| Tool | Purpose |
|---|---|
| `memory_search` | Search memories. Default is pure full-text search (fastest, no model required); `mode: "hybrid"` blends in vectors; `scope: "archive"` searches across projects |
| `memory_get` | Read a full entry by id |
| `memory_reindex` | Rebuild the index from markdown files; `embed: true` fills in vectors |

`memory_search` parameters:

- `query` (required)
- `scope` — `project` (default) / `all` / `archive`
- `mode` — `text` (default) / `hybrid` / `vector`
- `limit`, `kind` (`entry` / `snapshot` / `memory`), `tag`, `since`, `until`, `project`

Full-text search is **AND**-based: every query term must match. Start with specific terms and broaden the query if no results are returned.

### Where the data lives

Project data:

```
<project>/
├── MEMORY.md                  # long-term memory
└── memory/
    ├── 2026-10-02.md          # extracted entries
    ├── DREAMS.md              # dreaming digest log
    └── 2026-10-02-fix-bug-x.md # session snapshot
```

Shared data (one index for all projects):

```
~/.config/opencode/mem-plus/
├── index.db                   # retrieval index (safe to delete; rebuild with memory_reindex)
├── mem-plus.log               # log
└── dreaming/<project>.last-day # dreaming marker (delete to force a re-run)
```

The markdown files are the source of truth; the index is regenerable data.

### Inference service

The plugin starts a local inference service on `127.0.0.1:4748` (a separate process). Multiple OpenCode windows share a single service, so VRAM is not duplicated. The service exits after 10 minutes of idle time; it will not keep consuming CPU after OpenCode is closed.

GPU priority: **dedicated GPU > integrated GPU > CPU**, falling back to the next tier automatically. The log reports the backend that was selected:

```
[mem-plus] [mem-plus:serve] llama backend = vulkan (gpu) build=prebuilt
```

## Local models

When replacing the models:

- **The extraction model must be a completion-style (base) model; Instruct / Chat models must not be used.** Instruct models silently return empty extraction results. The default `qwen3.5-4b-q4_k_m.gguf` is a base model and is suitable.
- If only full-text search is used, the embedding model (`bge-m3`) may be omitted.

## Configuration

All options are optional. To pass options, use the object form in `opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "./plugins/mem-plus/plugin",
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

| Key | Default | Description |
|---|---|---|
| `model.content` | `"local"` | `"local"` = local GGUF service; `"opencode"` = OpenCode's metered model |
| `model.allowHostedFallback` | `false` | allow fallback to the metered model when local inference is unavailable |
| `model.dir` | `<repo>/models` | directory holding the GGUF files |
| `model.contentPath` | `model.dir/qwen3.5-4b-q4_k_m.gguf` | extraction model path |
| `model.embedPath` | `model.dir/bge-m3-f16.gguf` | embedding model path |
| `model.gpu` | `"auto"` | `"auto"` / `"cuda"` / `"vulkan"` / `"cpu"` |
| `model.gpuLayers` | `"auto"` | layers placed in VRAM |
| `model.contextSize` | `16384` | extraction context window |
| `model.maxNewTokens` | `512` | maximum tokens per extraction |
| `model.threads` | `0` | CPU threads (effective only in the CPU fallback) |
| `model.logLevel` | `"warn"` | `"silent"` / `"warn"` / `"info"` / `"debug"` |

### Service

| Key | Default | Description |
|---|---|---|
| `service.port` | `4748` | start port; increments automatically up to 4758 when busy |
| `service.host` | `"127.0.0.1"` | bind address (loopback only) |
| `service.autostart` | `true` | start the service automatically when it is not running |
| `service.idleMinutes` | `10` | auto-exit after this many idle minutes; `0` disables auto-exit |
| `service.startTimeoutMs` | `30000` | maximum wait time for the service to become ready |
| `service.url` | — | use a service already running at this URL |

## No silent billing

The design principle of this plugin is fully local inference. When local inference is unavailable (missing models, missing dependencies, a busy port, a crashed service), the plugin does **not** silently fall back to a metered model:

1. Snapshots keep writing (no cost incurred)
2. Extraction is deferred; pending records are retained
3. When the service recovers, pending extractions run automatically

To opt into a metered fallback, set `model.allowHostedFallback: true` or `model.content: "opencode"` explicitly.

## Dreaming

Triggered by the first settled turn of each calendar day (at most once per day), it compiles that day's entries into `MEMORY.md` and `DREAMS.md`. Delete the marker under `~/.config/opencode/mem-plus/dreaming/` to force a re-run on the next turn. When the local service is unavailable, the digest degrades to entries only (no LLM narrative).

## Prompt injection

Before each model call, mem-plus reads the workspace files at the project root (`AGENTS.md`, `SOUL.md`, `IDENTITY.md`, `USER.md`, `BOOTSTRAP.md`, `MEMORY.md`) and injects them into the system prompt. The long-term memory in `MEMORY.md` is therefore visible to the model on every turn.

## Troubleshooting

The log file is at `~/.config/opencode/mem-plus/mem-plus.log`; consult it first when diagnosing a problem.

| Symptom | Cause / action |
|---|---|
| `extraction DISABLED (GGUF not found)` | the model is not in `models/`. Snapshot writing is unaffected |
| `service did not become healthy ... within 30s` | the service did not start. Start it manually: `cd plugin && node serve/server.mjs --port 4748` |
| `local service unavailable; deferring the sweep` | the service is temporarily unavailable; records are retained and retried automatically |
| empty extraction output (`summary=0 chars`) | the extraction model is Instruct-style; see [Local models](#local-models) |
| `Index: 0 documents` | run `memory_reindex` |
| `hybrid` / `vector` returns 0 | run `memory_reindex {"embed": true}` and wait for it to complete |
| the `memory/` directory never appears | it is created after one full turn (settled + 2 s debounce) |

## License

This repository is licensed under MIT. Third-party code incorporated:

| Source | Scope | License | Copyright |
|---|---|---|---|
| [openclaw](https://github.com/openclaw/openclaw) | copies of the memory-related modules under `src/`, `extensions/`, `packages/` | MIT | Copyright (c) 2026 OpenClaw Foundation |
| [opencode-mem](https://github.com/tickernelz/opencode-mem) | web admin UI layout (planned integration) | MIT | Copyright (c) 2025 Zhafron Adani Kautsar |

Full license texts for each source: [LICENSE](./LICENSE) and [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).
