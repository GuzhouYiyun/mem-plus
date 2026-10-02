# mem-plus

面向 AI 编码代理的持久记忆系统。所有推理都在本地 GGUF 模型上运行——不调外部 API，不按量计费。

OpenCode 本身没有记忆：会话里学到的东西（改了什么文件、踩了什么坑、哪种方案失败过），关掉标签页就没了。mem-plus 给 OpenCode 加上真正的记忆系统：

- **会话快照** — 每轮对话自动归档为 `memory/YYYY-MM-DD-标题.md`
- **LLM 抽取** — 本地模型把每轮工作提炼成结构化条目（做了什么 / 结果如何 / 标签），写入 `memory/YYYY-MM-DD.md`
- **混合检索** — 全文 + 向量双通道，模型可以自动搜到旧记忆
- **睡眠整理** — 每天把当日条目汇编进 `MEMORY.md`（长期记忆）和 `DREAMS.md`（洞察日志）
- **提示词注入** — `AGENTS.md`、`MEMORY.md` 等工作区文件每轮注入系统提示词，模型始终"记得"它们

## 环境要求

- **OpenCode V2**（`@opencode/plugin` 2.0.20 或更高；不支持 V1）
- **Node 22.5+**（或 Bun）：检索工具依赖 `node:sqlite`。没有它，快照和抽取照常工作，只是检索工具不可用
- **两个本地 GGUF 模型**（共约 3.7 GB，见 [本地模型](#本地模型)）

## 快速开始

### 1. 克隆仓库

```bash
git clone <this-repo> mem-plus
cd mem-plus
```

### 2. 安装依赖

```bash
npm install                  # 仓库根目录
cd plugin && npm install     # 插件目录
node plugin/scripts/link-openclaw-alias.mjs   # 必需，跳过会导致插件加载失败
```

`npm install` 会同时安装 `node-llama-cpp` 对应平台的预编译二进制。没装依赖的话插件仍可加载、快照照写，只是抽取不会运行。

### 3. 注册插件

编辑 `opencode.jsonc`（全局 `~/.config/opencode/opencode.jsonc`，或项目目录下的 `opencode.jsonc`）：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    "C:/full/path/to/mem-plus/plugin"
  ]
}
```

Windows 下路径用正斜杠，且必须指向仓库内的 `plugin/` 目录（插件要从仓库根目录读取引擎，不能单独拷出去用）。

### 4. 下载模型

把两个文件放进 `mem-plus/models/`：

| 文件 | 大小 | 用途 | 下载 |
|---|---|---|---|
| `qwen3.5-4b-q4_k_m.gguf` | ~2.6 GB | 抽取 | [Hugging Face](https://huggingface.co/Qwen/Qwen3.5-4B-GGUF) |
| `bge-m3-f16.gguf` | ~1.1 GB | 向量嵌入 | [Hugging Face](https://huggingface.co/BAAI/bge-m3-gguf) |

详见 [本地模型](#本地模型)。

### 5. 首次建索引

注册插件后，在对话里让模型执行一次：

```
memory_reindex  {"scope": "all", "embed": true}
```

跑完后 `hybrid` / `vector` 检索才有结果。

## 日常使用

### 三个检索工具

模型会自动调用，你也可以在对话里直接点名。

| 工具 | 作用 |
|---|---|
| `memory_search` | 检索记忆。默认纯文本检索（最快、不需要模型）；`mode: "hybrid"` 融合向量；`scope: "archive"` 跨项目搜索 |
| `memory_get` | 按 id 读取完整条目 |
| `memory_reindex` | 从 markdown 文件重建索引；`embed: true` 补齐向量 |

`memory_search` 参数：

- `query`（必填）
- `scope` — `project`（默认）/ `all` / `archive`
- `mode` — `text`（默认）/ `hybrid` / `vector`
- `limit`、`kind`（`entry` / `snapshot` / `memory`）、`tag`、`since`、`until`、`project`

文本检索是 **AND**：所有词都要命中。先用具体词搜，没结果再放宽。

### 数据放在哪里

```
<你的项目>/
├── MEMORY.md                  # 长期记忆
└── memory/
    ├── 2026-10-02.md          # 抽取条目
    ├── DREAMS.md              # 睡眠整理日志
    └── 2026-10-02-fix-bug-x.md # 会话快照
```

共享数据（所有项目共一个索引）：

```
~/.config/opencode/mem-plus/
├── index.db                   # 检索索引（可随时删，用 memory_reindex 重建）
├── mem-plus.log               # 日志
└── dreaming/<项目名>.last-day # 睡眠整理标记（删掉可强制重跑）
```

markdown 文件是唯一的真相来源，索引是可丢弃的投影。

### 推理服务

插件在 `127.0.0.1:4748` 启动本地推理服务（独立进程）。多个 OpenCode 窗口共享这一个服务，不会各占一份显存。服务空闲 10 分钟后自动退出，关掉 OpenCode 之后不会持续占 CPU。

GPU 优先级：**独显 > 核显 > CPU**，某级失败自动降级。日志会报告最终用的后端：

```
[mem-plus] [mem-plus:serve] llama backend = vulkan (gpu) build=prebuilt
```

## 本地模型

要换模型的话：

- **抽取模型必须用 completion 风格（base）的模型，不要用 Instruct / Chat 模型**。Instruct 模型做抽取会静默返回空结果。默认的 `qwen3.5-4b-q4_k_m.gguf` 是 base 模型，适用。
- 只用文本检索的话，嵌入模型（`bge-m3`）可以不下载。

## 配置

全部可选。需要传选项时用对象形式：

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

完整示例见 [`opencode.example.jsonc`](./opencode.example.jsonc)。

### 模型

| 键 | 默认值 | 说明 |
|---|---|---|
| `model.content` | `"local"` | `"local"` = 本地 GGUF 服务；`"opencode"` = 用 OpenCode 的（计费的）模型 |
| `model.allowHostedFallback` | `false` | 本地推理不可用时是否允许退回计费模型 |
| `model.dir` | `<repo>/models` | GGUF 文件所在目录 |
| `model.contentPath` | `model.dir/qwen3.5-4b-q4_k_m.gguf` | 抽取模型路径 |
| `model.embedPath` | `model.dir/bge-m3-f16.gguf` | 嵌入模型路径 |
| `model.gpu` | `"auto"` | `"auto"` / `"cuda"` / `"vulkan"` / `"cpu"` |
| `model.gpuLayers` | `"auto"` | 放进显存的层数 |
| `model.contextSize` | `16384` | 抽取上下文窗口 |
| `model.maxNewTokens` | `512` | 单次抽取最大 token 数 |
| `model.threads` | `0` | CPU 线程数（仅 CPU 回退时生效） |
| `model.logLevel` | `"warn"` | `"silent"` / `"warn"` / `"info"` / `"debug"` |

### 服务

| 键 | 默认值 | 说明 |
|---|---|---|
| `service.port` | `4748` | 起始端口；被占用时自动递增到 4758 |
| `service.host` | `"127.0.0.1"` | 绑定地址（仅本机） |
| `service.autostart` | `true` | 服务没在跑时自动启动 |
| `service.idleMinutes` | `10` | 空闲多少分钟后自动退出；`0` = 永不退出 |
| `service.startTimeoutMs` | `30000` | 等服务就绪的最长时间 |
| `service.url` | — | 直接用已在该地址运行的服务 |

## 绝不悄悄计费

这个插件的意义就是"推理全本地"。本地推理不可用时（没模型、没装依赖、端口被占、服务崩了），插件**不会**悄悄改用你的计费模型：

1. 快照照写（永远免费）
2. 抽取暂缓，记录不丢
3. 服务恢复后自动补抽取

想改用计费模型，显式设置 `model.allowHostedFallback: true` 或 `model.content: "opencode"`。

## 睡眠整理

每个日历日的第一次完成 turn，把当日条目汇编进 `MEMORY.md` 和 `DREAMS.md`，每天最多跑一次。删除 `~/.config/opencode/mem-plus/dreaming/` 下的标记可强制重跑。本地服务不可用时，整理降级为"只写条目、不生成叙述"。

## 提示词注入

每轮开始时，mem-plus 把项目根目录下的工作区文件（`AGENTS.md`、`SOUL.md`、`IDENTITY.md`、`USER.md`、`BOOTSTRAP.md`、`MEMORY.md`）读进来注入系统提示词，所以 `MEMORY.md` 里的长期记忆模型每轮都看得到。

## 故障排除

**日志**：`~/.config/opencode/mem-plus/mem-plus.log`，先看这个。

| 现象 | 原因 / 处理 |
|---|---|
| `extraction DISABLED (GGUF not found)` | 模型不在 `models/` 下。快照照写 |
| `service did not become healthy ... within 30s` | 服务没起来。手动启动：`cd plugin && node serve/server.mjs --port 4748` |
| `local service unavailable; deferring the sweep` | 服务暂时不可用，记录不丢，恢复后自动重试 |
| 抽取输出是空的（`summary=0 chars`） | 抽取模型是 Instruct 风格，见 [本地模型](#本地模型) |
| `Index: 0 documents` | 运行 `memory_reindex` |
| `hybrid` / `vector` 返回 0 条 | 运行 `memory_reindex {"embed": true}` 并等它跑完 |
| `memory/` 目录不出现 | 需要跑完一个完整 turn（结算 + 2 秒防抖） |

## 许可证

MIT。本仓库包含 [openclaw](https://github.com/openclaw/openclaw) 记忆相关模块的副本（MIT，Copyright (c) 2026 OpenClaw Foundation）。详见 [LICENSE](./LICENSE) 和 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。
