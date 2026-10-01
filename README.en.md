# mem-plus (English)

**openclaw's memory system, wired into OpenCode, with all inference running on local GGUF models.**

OpenCode does not remember: what a session figured out, which files it touched, which dead ends it hit — all of it collapses into an orphaned session id when the window closes. mem-plus writes it down.

- **The memory engine is openclaw's own** (`extensions/memory-core/src/capture/`), not a rewrite — landing zone → extraction → render → file is preserved intact
- **Only the host changes**: openclaw's `chat.message` hook becomes OpenCode V2 events, and model calls become direct GGUF loads
- **Nothing leaves the machine**: models load from local files, no Ollama, no remote endpoint

> **中文文档见 [`README.md`](./README.md)。**

---

## Status — read this first

**Working**

| Capability | Notes |
|---|---|
| Session snapshots | Every turn re-renders the whole session to `memory/<date>-<title>.md`, tool calls and outputs included |
| LLM extraction | openclaw's original pipeline; emits `{summary, type, tags}` and filters `type="skip"` |
| Global archive | Every project's sessions mirrored to `~/.config/opencode/mem-plus/archive/<project>/` |
| Local models | `node-llama-cpp` loads GGUF directly; discrete GPU > integrated GPU > CPU |
| Graceful fallback | Missing model files or uninstalled deps → falls back to OpenCode's own model, capture keeps working |

**Not built yet**

- ❌ **Retrieval tools**: `memory_search` / `memory_get` are not wired up. **This version can write memory but cannot search it.**
- ❌ SQLite + FTS5 index, the vector channel (`bge-m3` embeddings + hybrid search), and cross-project archive search

Writes land as plain markdown first; the index is meant to be a rebuildable projection of those files — the same layering openclaw uses, where a file watcher owns it. An index is derived data, never the source of truth.

---

## Install

**1. Clone**

```bash
git clone <this-repo> mem-plus
cd mem-plus
```

**2. Install plugin dependencies**

```bash
cd plugin
npm install
```

This pulls `node-llama-cpp` with your platform's prebuilt binaries. **Skipping it still works** — the plugin loads and extraction falls back to OpenCode's own model. You only need it for local GGUF.

**3. Register the plugin**

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

On startup you should see:

```
[mem-plus] extraction model = local gguf, gpu priority auto
```

---

## Configuration

All options go in the `plugins` array of `opencode.jsonc`, using the object form:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "C:/Users/you/repos/mem-plus/plugin",
      "options": {
        "model": {
          "dir": "C:/Users/you/models",
          "gpu": "auto"
        }
      }
    }
  ]
}
```

**Every option is optional** — the defaults work with an empty config:

| Option | Default | Meaning |
|---|---|---|
| `model.content` | `"local"` | `"local"` uses local GGUF; `"opencode"` forces OpenCode's own model |
| `model.dir` | `<repo>/models` | Directory holding the GGUF files |
| `model.contentPath` | `<model.dir>/qwen3.5-4b-q4_k_m.gguf` | Extraction model |
| `model.embedPath` | `<model.dir>/bge-m3-f16.gguf` | Embedding model |
| `model.gpu` | `"auto"` | `"auto"` / `"cuda"` / `"vulkan"` / `"cpu"` |
| `model.gpuLayers` | `"auto"` | Layers to offload; `"auto"` sizes to current VRAM |
| `model.contextSize` | `16384` | Extraction session context length |
| `model.maxNewTokens` | `512` | Cap on tokens generated per extraction |
| `model.threads` | `0` | CPU threads, `0` = unlimited (CPU fallback only) |
| `model.logLevel` | `"warn"` | `"silent"` / `"warn"` / `"info"` / `"debug"` |

### GPU priority

Backends are tried **discrete GPU > integrated GPU > CPU**, explicitly rather than by letting the library guess:

| Order | Value | Hardware |
|---|---|---|
| 1 | `cuda` | NVIDIA discrete |
| 2 | `vulkan` | AMD / Intel discrete, every iGPU (llama.cpp then picks the strongest Vulkan device) |
| 3 | `false` | CPU only |

A backend that fails to load (a broken Vulkan driver, say) degrades to the next one instead of taking the plugin down. The log states which one won:

```
[mem-plus] llama backend = vulkan (gpu) build=prebuilt
```

---

## Local models

`models/` is gitignored (several GB doesn't belong in a repo). Put two files there:

| Purpose | Default filename | Size | Role |
|---|---|---|---|
| Extraction | `qwen3.5-4b-q4_k_m.gguf` | ~2.6 GB | Summarizes one assistant turn into a structured entry |
| Embedding | `bge-m3-f16.gguf` | ~1.1 GB | Embeds memory chunks (**for the retrieval layer, not wired yet**) |

Dropping them into `models/` is enough. Otherwise point `model.dir` / `model.contentPath` / `model.embedPath` wherever they live.

Models load lazily — a project that never triggers extraction never pays the ~4 GB.

> **Windows note**: Defender real-time scanning slows GGUF inference down badly. If extraction crawls, exclude the `models/` directory from Defender (needs administrator).

---

## Files it produces

### In your project

```
<your-project>/
├── MEMORY.md                            # promoted long-term memory
└── memory/
    ├── 2026-10-01.md                    # extracted entries, one file per day
    └── 2026-10-01-fix-snapshot-sync.md  # full session snapshot
```

An extracted entry looks like this:

```markdown
## Request
Create a file named feature.txt containing the word enabled

## Outcome
Created feature.txt and verified it exists on disk.

Tags: file-operations, verification
<!-- openclaw-capture:{"id":"ses_...","inboxID":"...","ts":"..."}-->
```

That trailing comment is openclaw's original provenance marker — it is what makes re-delivery idempotent and keeps the entry traceable.

Snapshot files hold the whole session: every user turn, `patch`/`shell` calls with their inputs and outputs, and the final prose answer.

### Global archive

```
~/.config/opencode/mem-plus/archive/<project>--<path-hash>/
├── INDEX.md
└── memory/
```

Every project keeps a cross-project copy. The path hash keeps same-named projects from colliding. On Windows, `~/.config` is `C:\Users\<you>\.config`.

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
                                     │
                                     └─► extraction pipeline:
                                          claim → slice the assistant turn
                                                → bounded markdown context
                                                → LLM extraction {summary, type, tags}
                                                → filter type="skip"
                                                → render
                                                → append memory/<date>.md
```

Design calls worth knowing:

- **`session.inbox.enqueued` over `session.hook("prompt")`** — the former is the *durable* admission boundary and carries a stable `inboxID`; the latter fires before admission, so the text may not be final.
- **Snapshots upsert every turn** rather than on session exit — OpenCode V2 has no session-leave hook.
- **2 s debounce** — one turn fires several completion events; coalescing them avoids duplicate extraction.
- **Extraction runs in the background** and never blocks you from continuing.

---

## Troubleshooting

**No `[mem-plus]` in the log** — turn on logging with `opencode --print-logs --log-level debug`.

**`extraction model = opencode (fallback: GGUF not found)`** — check `model.dir` and that both GGUF files are present. The log names the exact missing path.

**`extraction model = opencode (fallback: node-llama-cpp unavailable)`** — run `npm install` in `plugin/`.

**Extraction is very slow** — hardware-dependent. Keep `model.gpu` at `"auto"`. `opencode --print-logs --log-level debug` shows the backend that won and how long each extraction took:

```
[mem-plus] llama backend = vulkan (gpu) build=prebuilt
[mem-plus] content model loaded: .../qwen3.5-4b-q4_k_m.gguf
[mem-plus] extract done in 1234 ms (210 chars)
```

To route back to OpenCode's hosted model for now: `"model": { "content": "opencode" }`.

**`memory/` never appears** — a session needs at least one *completed* turn. Then allow the 2 s debounce plus the extraction run.

---

## License and provenance

This repository contains openclaw's memory subsystem under its original license.

- **openclaw** — MIT License, Copyright (c) 2026 OpenClaw Foundation (see [`LICENSE`](./LICENSE))
- **Pi / pi-mono** and other third-party portions — see [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md)
- Sub-packages carrying their own notices keep them in-tree (`packages/ai/LICENSE`, `packages/gateway-client/LICENSE`, `packages/gateway-protocol/LICENSE`, `extensions/facetime/LICENSE`, `extensions/typesafe/LICENSE`)

Everything under `plugin/` is new: the OpenCode adapter and the local model runtime.