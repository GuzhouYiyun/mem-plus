# mem-plus

面向 AI 编码代理的持久记忆系统，支持跨会话长期上下文保留，所有推理均在本地 GGUF 模型上运行。

[![npm version](https://img.shields.io/npm/v/mem-plus.svg)](https://www.npmjs.com/package/mem-plus)
[![license](https://img.shields.io/npm/l/mem-plus.svg)](https://www.npmjs.com/package/mem-plus)

OpenCode 本身没有记忆功能：关掉会话后，它学到的一切（改了哪些文件、什么 bug、哪种方案失败了）全都丢失了。mem-plus 通过为 OpenCode 提供真正的记忆系统来解决这个问题：会话快照、LLM 抽取、搜索、睡眠整理和提示词注入，全部由本地 GGUF 模型通过内置的推理服务驱动。

## 核心特性

- **会话快照**：每轮对话的完整 transcript（消息、工具调用、输出）都渲染为 `memory/YYYY-MM-DD-Title.md`
- **自动捕获**：每轮助手回复后，LLM 会总结本次工作（Request / Outcome / Tags）
- **SQLite + FTS5 + 向量混合索引**：条目、快照和 MEMORY.md 都用 `node:sqlite` 索引；FTS5 全文 + bge-m3 余弦向量，由 openclaw 的 `mergeHybridResults` 融合
- **三个检索工具**：`memory_search`、`memory_get`、`memory_reindex`
- **睡眠周报**：夜间的整理流程将每日条目汇编为 `MEMORY.md` 长期记忆和 `DREAMS.md` 洞察日志
- **提示词注入**：工作区引导文件（`AGENTS.md`、`SOUL.md`、`IDENTITY.md`、`USER.md`、`BOOTSTRAP.md`、`MEMORY.md`）在每次模型请求前加载并注入会话的系统提示词
- **零费用**：所有推理都在你的硬件上运行。没有基于用量的 API 调用，也没有按量回退。

## 环境要求

- **OpenCode V2**（`@opencode/plugin` 2.0.20+）。不支持 V1。
- **Node 22.5+**（用于 `node:sqlite`）或 **Bun**。
- **两个本地 GGUF 模型**（参见 [本地模型](#本地模型)）。
- **2 GB+ 可用磁盘空间**（模型用）。

## 快速开始

### 1. 克隆

```bash
git clone <this-repo> mem-plus
cd mem-plus
```

### 2. 安装依赖

```bash
npm install        # 安装 vendored openclaw 运行时依赖（28 个包）
cd plugin && npm install   # 安装 @opencode/plugin + node-llama-cpp
```

这会同时安装 `node-llama-cpp` 对应平台的预编译二进制。

**跳过这一步的话**，插件仍可加载，但抽取不运行（快照照写，待处理捕获在服务恢复后重试）。

### 3. 生成模块别名（必需）

```bash
node plugin/scripts/link-openclaw-alias.mjs
```

Openclaw 的源码通过 `openclaw/plugin-sdk/<name>` 导入自身。在自己的仓库中，这些通过 workspace 链接和 tsconfig paths 解析——对 `tsc` 有效，但**对运行时无效**：OpenCode 通过 Bun 加载插件，Bun 和 Node 一样不读 `tsconfig.json` 的 paths。本仓库是 openclaw 树的 vendored 副本，没有 workspace 可链接，所以这些别名必须作为真实文件存在于 `node_modules/openclaw/` 下。

该脚本生成 `node_modules/openclaw/`（~400 个单行 re-export 文件），幂等，`--check` 可校验结果：

```
node plugin/scripts/link-openclaw-alias.mjs --check
```

跳过这一步会导致插件加载失败。

### 4. 注册插件

编辑 `opencode.jsonc`（项目级或全局 `~/.config/opencode/opencode.jsonc`）：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    "C:/full/path/to/mem-plus/plugin"
  ]
}
```

Windows 下优先用正斜杠。路径必须指向仓库内的 `plugin/` 目录——插件从 `../../extensions/` 和 `../../src/` 读取 vendored openclaw 引擎，所以不能单独复制出去。

### 5. 放置本地模型

```bash
# 下载两个 GGUF 文件放进 mem-plus/models/：
mem-plus/models/qwen3.5-4b-q4_k_m.gguf   # 抽取模型（~2.6 GB）
mem-plus/models/bge-m3-f16.gguf            # 嵌入模型（~1.1 GB）
```

参见 [本地模型](#本地模型) 获取下载来源。

## 日常使用

### 三个检索工具

模型会自动调用它们，你也可以在对话中直接点名。

| 工具 | 作用 |
|---|---|
| `memory_search` | 检索记忆。默认纯文本（FTS5，不需要模型，最快）。`mode: "hybrid"` 融合 FTS5 + 向量命中（0.7/0.3 加权，openclaw 的 `mergeHybridResults`，时序衰减，MMR 去重，0.35 阈值）。`scope: "archive"` 跨项目全局搜索。 |
| `memory_get` | 按 `memory_search` 结果中的 unit id 读取完整条目。 |
| `memory_reindex` | 从 markdown 文件重建索引。`embed: true` 还会为所有未嵌入的条目补嵌入——这是**启用语义检索的唯一途径**。 |

参数：

- `query`（必填）
- `scope` — `project`（默认）/ `all` / `archive`
- `mode` — `text`（默认）/ `hybrid` / `vector`
- `limit`, `kind`（`entry` / `snapshot` / `memory`），`type`, `tag`, `since`, `until`, `project`

全文检索是 **AND**：所有词都必须命中。先用具体词开头，没结果再放宽。

索引文件在 `~/.config/opencode/mem-plus/index.db`，所有项目共享一个。markdown 是真相来源——索引是可丢弃的投影。删掉它，用 `memory_reindex` 重建即可。

### 首次使用：构建索引

插件启动时不会索引已有文件。注册后运行：

```
memory_reindex  {"scope": "all", "embed": true}
```

只有之后 `hybrid` 和 `vector` 模式才会返回结果。`embedBudget` 可提高单次嵌入上限（默认 40，最大 500）。

### 手动重建索引

运行：

```
memory_reindex  {"scope": "all"}
```

- 文件按大小 + mtime 识别——未修改的跳过。
- 磁盘上已删除的文件会从索引中清除（`Removed N document(s) deleted from disk`）。
- 重复运行是幂等的。

### 运行时中的 node:sqlite

需要 Node 22.5+ 或 Bun。没有它快照和抽取照常工作，但检索工具不注册，日志输出 `index unavailable (no node:sqlite in this runtime)`。

## 架构

```
OpenCode 插件（Bun 进程）
  │
  │  事件（inbox → execution succeeded）
  │  写快照 · 运行捕获 · 索引
  │  调用 127.0.0.1:4748
  ▼
127.0.0.1:4748  --  独立 Node 进程
  ├─ node-llama-cpp
  ├─ qwen3.5-4b（抽取）+ bge-m3（嵌入）常驻
  └─ /health  /extract  /generate  /embed
```

**为什么用 4748 服务？** `node-llama-cpp` 的原生绑定在 OpenCode 的 Bun 宿主进程中无法加载（其自检 fork 无法解析 `node`）。独立 Node 进程则可正常加载。拆分后多个 OpenCode 窗口共享一个 ~4 GB 的模型实例，而不是每个窗口各持一份。

**为什么是 4748？** opencode-mem 的 Web UI 占了 4747。互不冲突。

**空闲自动退出：** 服务有 10 分钟空闲超时（`service.idleMinutes`），关闭 OpenCode 后不会持续烧 CPU。

## 本地模型

`models/` 已被 .gitignore（~3.7 GB）。你需要自行放入两个文件：

| 用途 | 默认文件名 | 大小 | 作用 |
|---|---|---|---|
| 抽取 | `qwen3.5-4b-q4_k_m.gguf` | ~2.6 GB | 把一轮助手回复总结为结构化条目 |
| 嵌入 | `bge-m3-f16.gguf` | ~1.1 GB | 为 `hybrid` / `vector` 检索嵌入记忆块 |

### 从哪下载

两个文件都可从 Hugging Face 下载，按文件名搜索：

- `qwen3.5 4b q4_k_m gguf`
- `bge-m3 f16 gguf`

CLI 方式：

```bash
huggingface-cli download <repo> <file> --local-dir models
```

如果只需要文本检索模式，嵌入模型可以跳过。两个模型都是懒加载——不触发抽取的项目不驻留那 ~4 GB。

**抽取模型需要是 completion 风格的模型（不是 Instruct/Chat）。** 用 Instruct 模型做抽取会静默返回空结果。默认的 `qwen3.5-4b-q4_k_m.gguf` 是 base（Src）模型，适用于此。抽取管线使用 `LlamaCompletion` + few-shot 示例 + GBNF grammar 约束，模型原生 chat template 不参与。

## 配置

所有配置均为可选。在 `opencode.jsonc` 的 `plugins` 数组中设置：

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

完整示例见 [`opencode.example.jsonc`](./opencode.example.jsonc)。

### 模型

| 键 | 默认值 | 说明 |
|---|---|---|
| `model.content` | `"local"` | `"local"` = GGUF 服务；`"opencode"` = 使用 OpenCode 的（计费）模型 |
| `model.allowHostedFallback` | `false` | 本地推理不可用时允许使用计费的 OpenCode 模型 |
| `model.dir` | `<repo>/models` | GGUF 文件所在目录 |
| `model.contentPath` | `model.dir/qwen3.5-4b-q4_k_m.gguf` | 抽取模型路径 |
| `model.embedPath` | `model.dir/bge-m3-f16.gguf` | 嵌入模型路径 |
| `model.gpu` | `"auto"` | `"auto"` / `"cuda"` / `"vulkan"` / `"cpu"` |
| `model.gpuLayers` | `"auto"` | VRAM 中的层数 |
| `model.contextSize` | `16384` | 抽取的上下文窗口 |
| `model.maxNewTokens` | `512` | 单次抽取的最大 token 数 |
| `model.threads` | `0` | CPU 线程数（0 = 不限制，仅 CPU 回退时生效） |
| `model.logLevel` | `"warn"` | `"silent"` / `"warn"` / `"info"` / `"debug"` |

### 服务

| 键 | 默认值 | 说明 |
|---|---|---|
| `service.port` | `4748` | 起始端口；忙时自动递增，最大 `4758` |
| `service.host` | `"127.0.0.1"` | 绑定地址（仅 loopback） |
| `service.autostart` | `true` | 服务未运行时自动启动 |
| `service.idleMinutes` | `10` | 空闲后多少分钟自动退出；`0` = 永不退出 |
| `service.startTimeoutMs` | `30000` | 等待服务就绪的最长时间 |
| `service.url` | — | 使用已在此 URL 运行的服务 |

### GPU 优先级

服务按以下顺序尝试后端：独显 > 核显 > CPU：

| 顺序 | 值 | 硬件 |
|---|---|---|
| 1 | `cuda` | NVIDIA 独显 |
| 2 | `metal` | Apple 独显 / 统一内存 |
| 3 | `vulkan` | AMD / Intel 独显或核显 |
| 4 | `false` | 仅 CPU |

某个后端失败时自动回退到下一个。日志会报告最终选择：

```
[mem-plus] [mem-plus:serve] llama backend = vulkan (gpu) build=prebuilt
```

## 绝不静默扣费

本插件的全部意义就是「推理全本地」。如果本地推理**不可用**（缺模型、依赖未装、端口被占、服务崩溃），插件**不会**静默使用你的付费 OpenCode 模型。默认行为：

1. 快照照写（永远免费）。
2. 抽取**跳过**；记录留在 landing zone 里，重试计数不变。
3. 服务恢复后，下一轮 sweep 正常抽取。

日志记录：

```
[mem-plus] local service unavailable; deferring the sweep. Snapshots keep working
           and pending captures are retried once the service is back
```

要启用计费行为，设置 `model.allowHostedFallback: true` 或 `model.content: "opencode"`。

## 睡眠整理

睡眠是一种定期的整理流程，将每日条目提炼为 `MEMORY.md` 长期记忆文件和 `DREAMS.md` 洞察日志。在 openclaw 中它按 cron 计划运行。mem-plus 没有 cron；它在每个日历日的第一次已完成 turn 时最多触发一次。

上次运行标记在 `~/.config/opencode/mem-plus/dreaming/<slug>.last-day`。删除此目录可在下一 turn 强制重跑。

本地服务不可用时，睡眠回退为仅写入条目，不生成 LLM 叙述。

## 提示词注入

每次 `session.hook("context")` 调用时，mem-plus 从项目根目录加载工作区引导文件——`AGENTS.md`、`SOUL.md`、`IDENTITY.md`、`USER.md`、`BOOTSTRAP.md`、`MEMORY.md`——应用 openclaw 的每文件和总字符预算，并将格式化后的 `# Project Context` 块前置到系统提示词中。这让 `MEMORY.md` 和其他工作区上下文文件在每一 turn 都可见。

## 文件布局

```
<your-project>/
├── MEMORY.md                      # 提升后的长期记忆
├── memory/
│   ├── 2026-10-02.md              # 已抽取条目（每条一条）
│   ├── DREAMS.md                  # 睡眠整理日志
│   └── 2026-10-02-fix-bug-x.md    # 完整会话快照
└── (vendored openclaw 源码位于)
    extensions/memory-core/        # 捕获管线、排序算法、睡眠整理
    src/agents/                    # 工作区引导加载器、系统提示词
```

```
~/.config/opencode/mem-plus/
├── index.db                       # SQLite + FTS5 索引，所有项目共享
├── index.db-wal
├── index.db-shm
├── archive/<project>--<hash>/     # 跨项目快照镜像
├── mem-plus.log                   # 插件日志（2 MB 轮转）
└── dreaming/<slug>.last-day       # 睡眠标记
```

Markdown 是真相来源；索引是投影。删掉 `index.db` 是安全的——用 `memory_reindex` 重建。

## 故障排除

**日志？** `~/.config/opencode/mem-plus/mem-plus.log`。先看这个。

**没有抽取输出 / `summary=0 chars` + `type=skip`？** 几乎可以断定内容模型是 instruction-tuned 但被当作 base 模型使用了（或反之）。检查日志行中 `extract done in Xms ...` 后 `summary` 的长度；持续为 0 表示模型不适用——参见 [本地模型](#本地模型)。

**`service did not become healthy ... within 30s`** 服务未启动。手动运行：

```bash
cd plugin
node serve/server.mjs --port 4748
```

**`extraction DISABLED (GGUF not found)`** 模型不在 `models/` 下。快照照写。

**`local service unavailable; deferring the sweep`** 服务暂时不可用。记录保留，不丢失。

**`memory/` 目录从不出现** 需要一个完整 turn（settle + 2s debounce）。

**`Index: 0 documents`** 运行 `memory_reindex`。

**Hybrid/vector 模式返回 0** 运行 `memory_reindex {"embed": true}` 并等它跑完。

**输出中有 `**Search degraded:**`** SQL 失败，不是「无结果」。检查日志。

## Vendored 源码和许可证

mem-plus 在 `src/`、`extensions/`、`packages/` 目录下包含 [openclaw](https://github.com/openclaw/openclaw) 的部分副本（MIT License, Copyright (c) 2026 OpenClaw Foundation）。仅保留与记忆相关的模块。参见 [LICENSE](./LICENSE) 和 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。

插件适配层（`plugin/src/`、`plugin/serve/`、`plugin/scripts/`）是新代码。
