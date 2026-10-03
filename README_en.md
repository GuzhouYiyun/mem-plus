<div align="center">

# mem-plus

[中文](./README.md)

</div>

A persistent memory system for OpenCode, built on OpenClaw. All inference runs on local GGUF models; no external API calls, no usage-based billing.

More than memory: put a persona into `SOUL.md` / `IDENTITY.md` (role-play, a dedicated assistant, a strict code reviewer…), and the agent acts and speaks as that character every turn; as long-term memory accumulates day by day, it comes to know you and your project better and better (see [Prompt injection](#prompt-injection)).

OpenCode itself retains no memory: information gained within a session (files modified, problems encountered, approaches that failed) is lost when the session ends. mem-plus provides OpenCode with a persistent memory system:

- **Session snapshots** — each turn is automatically archived as `memory/YYYY-MM-DD-Title.md`
- **LLM extraction** — a local model distills each turn into a structured entry (request / outcome / tags), written to `memory/YYYY-MM-DD.md`
- **Hybrid search** — full-text and vector lanes; the model retrieves historical memories automatically
- **Dreaming digest** — daily entries are compiled into `MEMORY.md` (long-term memory) and `DREAMS.md` (insights log)
- **Prompt injection** — workspace files such as `AGENTS.md` and `MEMORY.md` are injected into the system prompt before every turn, so their content is always visible to the model
- **Persona & growth** — `SOUL.md`, `IDENTITY.md`, and `USER.md` define the agent's character, identity, and user profile, and can be edited at any time; together with long-term memory that grows day by day, the agent matures over time into the assistant you expect

## Contents

- [Prerequisites](#prerequisites)
- [Getting started](#getting-started)
  - [1. Clone into the OpenCode plugins directory](#1-clone-into-the-opencode-plugins-directory)
  - [2. Install dependencies](#2-install-dependencies)
  - [3. Register the plugin (not needed for the default install)](#3-register-the-plugin-not-needed-for-the-default-install)
  - [4. Download the models](#4-download-the-models)
  - [5. Restart OpenCode and verify](#5-restart-opencode-and-verify)
  - [6. Index existing files (optional)](#6-index-existing-files-optional)
- [Day-to-day usage](#day-to-day-usage)
  - [The three retrieval tools](#the-three-retrieval-tools)
  - [Where the data lives](#where-the-data-lives)
  - [Inference service](#inference-service)
- [Model](#model)
- [Configuration](#configuration)
  - [Model options](#model-options)
  - [Service](#service)
- [Dreaming](#dreaming)
- [Prompt injection](#prompt-injection)
- [Troubleshooting](#troubleshooting)
- [Uninstalling](#uninstalling)
- [License](#license)

## Prerequisites

- **OpenCode V2** (`@opencode/plugin` 2.0.20 or later; V1 is not supported)
- **Node 22.5+** (or Bun): the retrieval tools depend on `node:sqlite`. If unavailable, snapshots and extraction continue to work; only the search tools are missing. Check the version with `node -v`; upgrade first if it is below 22.5
- **Two local GGUF models** (~3.7 GB total, see [Model](#model))

## Getting Started

Two installation routes are available: **clone** (steps 1–6 below, the default in this document) or **npm install** (see [Option B](#option-b-npm-install-no-clone)). The npm route ships only the runtime closure (~4.2 MB) and avoids the ~116 MB source checkout, and suits users who only run the plugin.

### 1. Clone into the OpenCode plugins directory

Clone mem-plus into OpenCode's global plugins directory `~/.config/opencode/plugins/` so it is managed alongside your other plugins:

```powershell
# Windows
git clone https://github.com/GuzhouYiyun/mem-plus.git "$env:USERPROFILE\.config\opencode\plugins\mem-plus"
cd "$env:USERPROFILE\.config\opencode\plugins\mem-plus"
```

```bash
# Linux / macOS
git clone https://github.com/GuzhouYiyun/mem-plus.git ~/.config/opencode/plugins/mem-plus
cd ~/.config/opencode/plugins/mem-plus
```

Cloning is not required: you can also download the source archive from the repository page on GitHub (Code → Download ZIP). Extract it, rename the folder to `mem-plus`, and place it in the global plugins directory `~/.config/opencode/plugins/`. Keeping the folder name consistent is what keeps the paths in every later step the same.

### 2. Install dependencies

```bash
npm install                  # repository root
cd plugin                    # enter the plugin directory
npm install                  # plugin directory
```

The root `npm install` generates the runtime module alias automatically via postinstall (idempotent; safe to re-run). If you install with scripts disabled (e.g. `npm install --ignore-scripts`), run `node plugin/scripts/link-openclaw-alias.mjs` manually, otherwise the plugin cannot load.

`npm install` also pulls the prebuilt `node-llama-cpp` binary for the platform. Without the dependencies, the plugin still loads and session snapshots keep writing; LLM extraction is not performed.

### 3. Register the plugin (not needed for the default install)

When step 1 cloned into the global plugins directory `~/.config/opencode/plugins/`, OpenCode discovers and loads it automatically at startup — no registration required; skip this section.

Write into `opencode.jsonc` (the global `~/.config/opencode/opencode.jsonc`, or a project-level `opencode.jsonc`) only when:

- you cloned somewhere other than the global plugins directory,
- you need to pass configuration options to the plugin, or
- `plugin loaded` is missing from the log after restarting (step 5) — i.e. auto-discovery did not take effect.

Minimal example (just tell OpenCode where the plugin lives; no options):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    "/path/to/where/you/cloned/mem-plus"
  ]
}
```

Path rules:

- The path is wherever you actually cloned (or unzipped) it in step 1, and it must point at the **root of the mem-plus repository** — the level containing `package.json`, `index.ts`, and `plugin/` (the entry is declared in the root `package.json`), not the inner `plugin/` subdirectory
- Use forward slashes on Windows; an absolute path is recommended, relative paths resolve from the directory containing the config file
- Each `plugins` entry can be written two ways: a plain string (path only, as in the example above — no options) or an object with the path under `"package"` and any options under `"options"` (i.e. `{ "package": "...", "options": { ... } }`). Use the object form when you need to pass options; all available options are listed in [Configuration](#configuration)
- Save the file, then restart OpenCode (`opencode service restart`)

### 4. Download the models

Create a `models/` directory at the repository root (it is not included in the clone), then download both files into `mem-plus/models/`:

| File name | Size | Purpose | ModelScope (China) | Hugging Face (international) |
|---|---|---|---|---|
| `Qwen3.5-4B-Q4_K_M.gguf` | ~2.7 GB | extraction | [Qwen3.5-4B-Q4_K_M.gguf](https://modelscope.cn/models/unsloth/Qwen3.5-4B-GGUF/resolve/main/Qwen3.5-4B-Q4_K_M.gguf) | [Qwen3.5-4B-Q4_K_M.gguf](https://huggingface.co/unsloth/Qwen3.5-4B-GGUF/resolve/main/Qwen3.5-4B-Q4_K_M.gguf) |
| `bge-m3-FP16.gguf` | ~1.2 GB | vector embedding | [bge-m3-FP16.gguf](https://modelscope.cn/models/gpustack/bge-m3-GGUF/resolve/main/bge-m3-FP16.gguf) | [bge-m3-FP16.gguf](https://huggingface.co/gpustack/bge-m3-GGUF/resolve/main/bge-m3-FP16.gguf) |

Notes:

- The repositories also host other quantizations; those are not part of the default configuration.
- To use a different model, note that the two slots are not interchangeable: the extraction slot requires a completion-style (base) language model, and the embedding slot requires a model with an embedding head. To replace without touching the configuration, rename the new model to the exact file names in the table above (`Qwen3.5-4B-Q4_K_M.gguf` / `bge-m3-FP16.gguf`) and drop it into `models/`; or keep its original name and point `model.contentPath` / `model.embedPath` at the actual paths (see [Configuration](#configuration)).
- See [Model](#model).

### 5. Restart OpenCode and verify

Restart OpenCode so the plugin takes effect (the command is the same on Windows and Linux / macOS):

```bash
opencode service restart
```

Verify the installation succeeded (both should appear):

```powershell
# Windows: the log's last lines should show `plugin loaded`
Get-Content "$env:USERPROFILE\.config\opencode\mem-plus\mem-plus.log" -Tail 5
```

```bash
# Linux / macOS
tail -n 5 ~/.config/opencode/mem-plus/mem-plus.log
```

Then complete one conversation turn in any project; the day's files should appear under the memory home `~/.config/opencode/mem-plus/workspace/memory/` (see [Where the data lives](#where-the-data-lives)).

If `plugin loaded` is missing from the log: first register the plugin with the path form from step 3 and restart again; if it is still missing, see [Troubleshooting](#troubleshooting).

### 6. Index existing files (optional)

Memory entries written after registration are added to the retrieval index automatically. A full index pass is required only if the memory home (`workspace/`) holds memory files that pre-date the plugin registration (e.g. manually written session logs, or files migrated from elsewhere) — those are not scanned automatically:

```
memory_reindex  {"embed": true}
```

- Scans every file in the memory home and rebuilds the index. Idempotent; safe to repeat.
- `embed: true` computes a vector for each chunk via the embedding model, enabling `hybrid` / `vector` semantic search. For full-text search only, run `memory_reindex` without options.

### Option B: npm install (no clone)

If you prefer not to clone the source, use the npm package from Releases. The package carries only the runtime closure (~4.2 MB); dependencies are installed by npm automatically. The two GGUF models still need a separate download (see [Model](#model)).

Download the latest `mem-plus-<version>.tgz` from the **Releases** page, then:

```bash
npm i <path-to-the-downloaded-mem-plus-0.1.0.tgz>
```

The package lands in `node_modules/mem-plus/`. OpenCode auto-discovery only scans direct children of the global plugins directory, so a package inside `node_modules/` needs explicit registration (the object form from step 3):

```jsonc
{
  "plugins": [
    {
      "package": "C:/path/to/node_modules/mem-plus",
      "options": {}
    }
  ]
}
```

Notes:

- The entry is the package's `index.ts` (declared in its root `package.json` `main`/`exports`), not an inner directory.
- Memory home, index, and log still live in `~/.config/opencode/mem-plus/`, regardless of how the plugin was installed.
- When the installed `node_modules/mem-plus/` has no `models/` directory, the plugin falls back to `~/.config/opencode/mem-plus/models/`; or point `model.dir` at a directory of your choice.
- Restart and verification are the same as step 5; without `models/`, extraction stays disabled while snapshots keep writing — see [Troubleshooting](#troubleshooting).

## Day-to-day usage

### The three retrieval tools

The model invokes them automatically; users may also invoke them explicitly in a session.

| Tool | Purpose |
|---|---|
| `memory_search` | Search memories. Default is pure full-text search (fastest, no model required); `mode: "hybrid"` blends in vectors; `scope: "all"` searches across projects |
| `memory_get` | Read a full entry by id |
| `memory_reindex` | Rebuild the index from the memory home's markdown files; `embed: true` fills in vectors |

`memory_search` parameters:

- `query` (required)
- `scope` — `project` (default: this project plus the global long-term memory) / `all` (every project)
- `mode` — `text` (default) / `hybrid` / `vector`
- `limit`, `kind` (`entry` / `snapshot` / `memory`), `tag`, `since`, `until`, `project`

Full-text search is **AND**-based: every query term must match. Start with specific terms and broaden the query if no results are returned.

### Where the data lives

The project directory is never written to. Every memory file lives in one fixed "memory home":

```
~/.config/opencode/mem-plus/workspace/
├── MEMORY.md                        # long-term memory (global, compiled daily by dreaming)
├── DREAMS.md                        # dreaming digest log (global, human review; not indexed)
└── memory/
    └── <project>--<hash>/          # one subdirectory per project (a label, not a separate store)
        ├── 2026-10-02.md           # extracted entries
        └── 2026-10-02-fix-bug-x.md # session snapshot
```

The remaining data sits next to the memory home (one index for all projects):

```
~/.config/opencode/mem-plus/
├── workspace/                       # the memory home (above)
├── index.db                         # retrieval index (safe to delete; rebuild with memory_reindex)
├── mem-plus.log                     # log
└── dreaming/last-day                # dreaming marker (a single global one; delete to force a re-run)
```

The markdown files are the source of truth; the index is regenerable data.

### Inference service

The plugin starts a local inference service on `127.0.0.1:4748` (a separate process). Multiple OpenCode windows share a single service, so VRAM is not duplicated. The service exits after 10 minutes of idle time; it will not keep consuming CPU after OpenCode is closed.

GPU priority: **dedicated GPU > integrated GPU**; the CPU is never used. When the dedicated GPU is unavailable the integrated one is tried; when no GPU can run, the inference service does not start and the log reports the error (snapshots keep writing, extraction stays deferred until a GPU is available). The log reports the backend that was selected:

```
[mem-plus] [mem-plus:serve] llama backend = vulkan (discrete or integrated) build=prebuilt
```

## Model

By default, mem-plus uses two local GGUF models: the extraction model `Qwen3.5-4B-Q4_K_M.gguf` and the embedding model `bge-m3-FP16.gguf`. Switching models is done through the `model.*` options in `opencode.jsonc` (full key table: [Model options](#model-options)):

- Swap in local GGUF files: `model.contentPath` / `model.embedPath` (or change the whole directory with `model.dir`)
- Use OpenCode's metered model instead: `model.content: "opencode"`
- Whether to allow falling back to the metered model when local inference is unavailable: `model.allowHostedFallback` (default `false`, i.e. no silent fallback)

When replacing the models:

- **The extraction model must be a completion-style (base) model; Instruct / Chat models must not be used.** Instruct models silently return empty extraction results. The default `Qwen3.5-4B-Q4_K_M.gguf` is a base model and is suitable.
- **The embedding model must have an embedding head.** The default `bge-m3-FP16.gguf` satisfies this; a language model placed in the embedding slot fails on first use.
- If only full-text search is used, the embedding model (`bge-m3`) may be omitted.
- After swapping the embedding model, run `memory_reindex {"embed": true}` to rebuild the vectors. Vectors computed by the previous model are in a different space; mixing them produces wrong hybrid / vector results.

**Billing principle**: all inference in this plugin is fully local. When local inference is unavailable (missing models, missing dependencies, a busy port, a crashed service), the plugin does **not** silently fall back to a metered model:

1. Snapshots keep writing (no cost incurred)
2. Extraction is deferred; pending records are retained
3. When the service recovers, pending extractions run automatically: on every settled turn the plugin probes the local service first and only runs extraction when it is reachable; otherwise the turn is skipped and the pending records are left intact, so the next turn after the service comes back picks them up — no manual action needed

To opt into a metered fallback, set `model.allowHostedFallback: true` or `model.content: "opencode"` explicitly.

## Configuration

All options are optional. To pass options, use the object form in `opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "./plugins/mem-plus",
      "options": {
        "model": { "gpu": "auto" },
        "service": { "port": 4748 }
      }
    }
  ]
}
```

Full example: [`opencode.example.jsonc`](./opencode.example.jsonc).

### Model options

| Key | Default | Description |
|---|---|---|
| `model.content` | `"local"` | `"local"` = local GGUF service; `"opencode"` = OpenCode's metered model |
| `model.allowHostedFallback` | `false` | allow fallback to the metered model when local inference is unavailable |
| `model.dir` | `<repo>/models` | directory holding the GGUF files |
| `model.contentPath` | `model.dir/Qwen3.5-4B-Q4_K_M.gguf` | extraction model path |
| `model.embedPath` | `model.dir/bge-m3-FP16.gguf` | embedding model path |
| `model.gpu` | `"auto"` | `"auto"` (dedicated > integrated, no CPU fallback) / `"cuda"` / `"vulkan"`. CPU inference was removed; a legacy `"cpu"` value is treated as `"auto"` |
| `model.gpuLayers` | `"auto"` | layers placed in VRAM |
| `model.contextSize` | `16384` | extraction context window |
| `model.maxNewTokens` | `512` | maximum tokens per extraction |
| `model.threads` | `0` | CPU threads for host-side work (inference itself runs on the GPU) |
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

## Dreaming

Triggered by the first settled turn of each calendar day (a single global gate: at most one sweep per day across all projects), it compiles that day's entries into `MEMORY.md` (long-term memory) and `DREAMS.md` (insights log) at the memory home's root. Delete the global marker `~/.config/opencode/mem-plus/dreaming/last-day` to force a re-run on the next turn. When the local service is unavailable, the digest degrades to entries only (no LLM narrative).

## Prompt injection

Before each model call, mem-plus reads the workspace files at the project root and injects them into the system prompt, then appends the global `MEMORY.md` at the memory home's root (`~/.config/opencode/mem-plus/workspace/`). The file names and their meanings follow openclaw's conventions; missing files are skipped, and edits take effect from the next turn:

| File | Purpose |
|---|---|
| `AGENTS.md` | project conventions (working rules, code style, preferences) |
| `SOUL.md` | the agent's persona: character, values, code of conduct (openclaw's "soul" file) |
| `IDENTITY.md` | identity: name, role, self-reference and tone |
| `USER.md` | your profile: how to address you, preferences, background |
| `BOOTSTRAP.md` | startup / bootstrap instructions |

The global `MEMORY.md` is shared by every project and compiled daily by the dreaming digest. Writing a `SOUL.md` / `IDENTITY.md` gives the agent that character and identity; day by day, the LLM extraction and dreaming digest distill lessons — mistakes, dead ends, hard-won fixes — into `MEMORY.md`, so the injected context accumulates and the agent's understanding of your project evolves with use. The evolution happens at the prompt-and-memory level (injected files, retrieval index), not in the model's weights.

## Troubleshooting

The log file is at `~/.config/opencode/mem-plus/mem-plus.log`; consult it first when diagnosing a problem.

| Symptom | Cause / action |
|---|---|
| `extraction DISABLED (GGUF not found)` | the model is not in `models/`. Snapshot writing is unaffected |
| `service did not become healthy ... within 30s` | the service did not start. Start it manually: `cd plugin && node serve/server.mjs --port 4748` and check the log for the reason |
| `gpu backend unavailable; service will not start` | no usable GPU (dedicated > integrated, CPU is disabled). The service does not start; extraction stays deferred until a GPU becomes available |
| `local service unavailable; deferring the sweep` | the service is temporarily unavailable; records are retained and retried automatically |
| empty extraction output (`summary=0 chars`) | the extraction model is Instruct-style; see [Model](#model) |
| `Index: 0 documents` | run `memory_reindex` |
| `hybrid` / `vector` returns 0 | run `memory_reindex {"embed": true}` and wait for it to complete |
| no day files appear under `workspace/memory/` | they are created after one full turn (settled + 2 s debounce) |

## Uninstalling

Remove the plugin and all of its data (in order):

1. Close OpenCode, and stop the local inference service (the command is the same on Windows and Linux / macOS):

   ```bash
   opencode service stop
   ```

2. Delete the data directory (the memory home `workspace/`, the index, the log, the dreaming marker):

   ```powershell
   # Windows
   Remove-Item -Recurse -Force "$env:USERPROFILE\.config\opencode\mem-plus"
   ```

   ```bash
   # Linux / macOS
   rm -rf ~/.config/opencode/mem-plus
   ```

   It holds the memory itself plus regenerable data; back up `workspace/` first if you want to keep your memories, otherwise delete it outright
3. Delete the plugin directory (its `models/` folder holds the ~3.7 GB of model files):

   ```powershell
   # Windows
   Remove-Item -Recurse -Force "$env:USERPROFILE\.config\opencode\plugins\mem-plus"
   ```

   ```bash
   # Linux / macOS
   rm -rf ~/.config/opencode/plugins/mem-plus
   ```

   If you cloned it somewhere else, delete that directory instead
4. If you registered the plugin in `opencode.jsonc`, remove that entry; auto-discovery from the global plugins directory needs no such step
5. Restart OpenCode; the uninstall is complete

## License

This repository is licensed under MIT. Third-party code incorporated:

| Source | Scope | License | Copyright |
|---|---|---|---|
| [openclaw](https://github.com/openclaw/openclaw) | copies of the memory-related modules under `src/`, `extensions/`, `packages/` | MIT | Copyright (c) 2026 OpenClaw Foundation |
| [opencode-mem](https://github.com/tickernelz/opencode-mem) | web admin UI layout (planned integration) | MIT | Copyright (c) 2025 Zhafron Adani Kautsar |

Full license texts for each source: [LICENSE](./LICENSE) and [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).
