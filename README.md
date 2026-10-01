# mem-plus

**把 openclaw 的记忆系统接到 OpenCode 上，推理全部走本地 GGUF 模型。**

OpenCode 本身不记事：这个会话解决了什么、改了哪些文件、踩过什么坑，关掉窗口就只剩一个孤立的会话 id。mem-plus 让它把这些写下来。

- **记忆引擎直接来自 openclaw**（`extensions/memory-core/src/capture/`），不是重写 —— landing zone → 抽取 → 渲染 → 落盘的整条管线原样保留
- **只换宿主**：把 openclaw 的 `chat.message` 钩子换成 OpenCode V2 的事件，把模型调用换成直接加载本地 GGUF
- **不出网**：模型从本地文件加载，不经过 Ollama，也不连任何远端服务

---

## 目录

- [当前状态](#当前状态)
- [安装](#安装)
- [配置](#配置)
- [本地模型](#本地模型)
- [产出什么文件](#产出什么文件)
- [工作原理](#工作原理)
- [故障排除](#故障排除)
- [许可与来源](#许可与来源)

---

## 当前状态

请先读这一节，避免期望和现实对不上。

**已实现**

| 能力 | 说明 |
|---|---|
| 会话快照 | 每次回合把整个会话重新渲染成 `memory/<日期>-<标题>.md`，含工具调用与输出 |
| LLM 抽取 | 走 openclaw 原管线，产出 `{summary, type, tags}`，`type="skip"` 自动过滤 |
| 全局档案 | 每个项目的会话镜像到 `~/.config/opencode/mem-plus/archive/<项目>/` |
| 本地模型 | `node-llama-cpp` 直接加载 GGUF，独显 > 核显 > CPU |
| 自动回落 | 模型文件缺失或依赖没装 → 退回 OpenCode 自己的模型，捕获照常工作 |

**还没实现**

- ❌ **检索工具**：`memory_search` / `memory_get` 还没接。**现在能把记忆写下来，但还不能搜回来看。**
- ❌ SQLite + FTS5 索引、向量通道（`bge-m3` 嵌入 + hybrid 混合检索）、全局档案搜索

> 关于顺序：写入层先落地成普通 markdown，索引层再从这些文件重建投影 —— 和 openclaw 本身的架构一致（那边由文件监听器负责）。所以索引是可丢弃的重建产物，不是数据本体。

如果你要的是"能记 **且** 能搜"，还需要等检索层。**要记住的是：目前这版只完成了写，没有完成读。**

---

## 安装

### 1. 克隆

```bash
git clone <this-repo> mem-plus
cd mem-plus
```

### 2. 安装插件依赖

```bash
cd plugin
npm install
```

这一步会装上 `node-llama-cpp`（含你平台的原生二进制）。
**不装也能用** —— 插件会加载，抽取自动改用 OpenCode 自己的模型。只有想用本地 GGUF 才必须装。

### 3. 注册插件

编辑 `opencode.jsonc`（项目级或全局 `~/.config/opencode/opencode.jsonc`）：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    "C:/Users/你的用户名/repos/mem-plus/plugin"
  ]
}
```

路径支持三种写法，Windows 上**建议用正斜杠**，免得转义麻烦：

```jsonc
"plugins": [
  "/absolute/path/to/mem-plus/plugin",
  "../shared/mem-plus/plugin",
  "file:///home/you/mem-plus/plugin"
]
```

> 注意：这里填的是**仓库里的 `plugin/` 目录**，不是仓库根目录。插件会从 `../extensions/memory-core/` 读取记忆引擎，所以不要只复制 `plugin/` 出去。

装完启动 OpenCode，日志里应该出现：

```
[mem-plus] extraction model = local gguf, gpu priority auto
```

看到这行就说明本地模型生效了。没看到就翻到 [故障排除](#故障排除)。

---

## 配置

所有配置都写在 `opencode.jsonc` 的 `plugins` 数组里，用对象形式：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "C:/Users/你的用户名/repos/mem-plus/plugin",
      "options": {
        "model": {
          "dir": "C:/Users/你的用户名/models",
          "gpu": "auto"
        }
      }
    }
  ]
}
```

**全部可选项**（不写就用默认值，一个都不用改）：

| 选项 | 默认值 | 说明 |
|---|---|---|
| `model.content` | `"local"` | `"local"` 用本地 GGUF；`"opencode"` 强制用 OpenCode 自己的模型 |
| `model.dir` | `<仓库>/models` | GGUF 所在目录 |
| `model.contentPath` | `<model.dir>/qwen3.5-4b-q4_k_m.gguf` | 抽取模型完整路径 |
| `model.embedPath` | `<model.dir>/bge-m3-f16.gguf` | 向量模型完整路径 |
| `model.gpu` | `"auto"` | `"auto"` / `"cuda"` / `"vulkan"` / `"cpu"` |
| `model.gpuLayers` | `"auto"` | 放多少层到显存；`"auto"` 按当前显存自适应 |
| `model.contextSize` | `16384` | 抽取会话的上下文长度 |
| `model.maxNewTokens` | `512` | 单次抽取最多生成多少 token |
| `model.threads` | `0` | CPU 线程数，`0` = 不限制（仅 CPU 回退时生效） |
| `model.logLevel` | `"warn"` | `"silent"` / `"warn"` / `"info"` / `"debug"` |

### GPU 优先级

按 **独显 > 核显 > CPU** 顺序显式尝试，**不是**交给库自己猜：

| 优先级 | 枚举值 | 对应硬件 |
|---|---|---|
| 1 | `cuda` | NVIDIA 独显 |
| 2 | `vulkan` | AMD / Intel 独显、所有核显（llama.cpp 内部会挑最强的 Vulkan 设备） |
| 3 | `false` | 纯 CPU |

某一档加载失败（比如 Vulkan 驱动有问题）会自动降级到下一档，**不会整个插件挂掉**。日志里会写明最终选中的是哪个：

```
[mem-plus] llama backend = vulkan (gpu) build=prebuilt
```

---

## 本地模型

`models/` 目录在 `.gitignore` 里（几个 GB，不适合进仓库），需要你自己放两个文件：

| 用途 | 默认文件名 | 体积 | 干什么 |
|---|---|---|---|
| 抽取 | `qwen3.5-4b-q4_k_m.gguf` | ~2.6 GB | 把一次助手回合总结成结构化条目 |
| 向量 | `bge-m3-f16.gguf` | ~1.1 GB | 给记忆块算嵌入（**检索层用到，现在还没接**） |

放到 `models/` 下就直接被认出来。或者放到别处，用 `model.dir` / `model.contentPath` / `model.embedPath` 指过去。

模型是懒加载的 —— 不触发抽取的项目不会占那 4 GB 内存。

> **Windows 建议**：Defender 实时扫描会显著拖慢 GGUF 推理。如果抽取明显卡，把 `models/` 目录加进 Defender 排除项（需要管理员权限）。

---

## 产出什么文件

### 项目内

```
<你的项目>/
├── MEMORY.md                            # 提升后的长期记忆
└── memory/
    ├── 2026-10-01.md                    # 抽取出来的条目，每天一个
    └── 2026-10-01-修复快照同步.md         # 完整会话快照
```

`2026-10-01.md` 里的条目长这样：

```markdown
## Request
Create a file named feature.txt containing the word enabled

## Outcome
Created feature.txt and verified it exists on disk.

Tags: file-operations, verification
<!-- openclaw-capture:{"id":"ses_...","inboxID":"...","ts":"..."}-->
```

末尾那串注释是 openclaw 原格式的来源标记 —— 幂等去重和溯源都靠它。

快照文件则包含整个会话：你的每一轮提问、`patch`/`shell` 等工具的调用与输出、最后的回复结论。

### 全局档案

```
~/.config/opencode/mem-plus/archive/<项目名>--<路径哈希>/
├── INDEX.md
└── memory/
    └── ...
```

每个项目的会话都会在这里留一份跨项目副本。项目目录名带路径哈希，所以两个同名项目不会撞。Windows 上 `~/.config` 就是 `C:\Users\<你>\.config`。

---

## 工作原理

```
用户提问
   │
   ├─ session.inbox.enqueued ──► 落地到 landing zone（captured 0/1/2）
   │                              用 inboxID 保证重复投递是幂等的
   │
   ├─ 助手回合进行中
   │
   └─ session.execution.succeeded ──► 等 2 秒让回合落定
                                     │
                                     ├─► 重新渲染整个会话 → 快照 + 档案镜像
                                     │
                                     └─► 跑抽取管线：
                                          claim → 切出助手回合
                                                → 截断成有界的 markdown 上下文
                                                → LLM 结构化抽取 {summary, type, tags}
                                                → 过滤 type="skip"
                                                → 渲染
                                                → 追加 memory/<日期>.md
```

几个设计取舍：

- **用 `session.inbox.enqueued` 而不是 `session.hook("prompt")`** —— 前者是**已持久化**的准入边界，带着稳定的 `inboxID`；后者在准入之前就触发了，拿到的文本可能是最终形态的前一版。
- **快照每次回合都 upsert**，而不是等会话结束 —— OpenCode V2 没有会话离开钩子。
- **2 秒防抖**：一个回合会触发多个完成事件，聚合一下再跑，避免重复抽取。
- **抽取在后台跑**，不阻塞你继续对话。

---

## 故障排除

### 日志里没有 `[mem-plus]`

用 `--print-logs` 打开日志：

```bash
opencode --print-logs --log-level debug
```

### `extraction model = opencode (fallback: GGUF not found)`

模型文件不在。确认 `model.dir` 指对了，且两个 GGUF 都在里面。日志会打印具体缺哪个路径。

### `extraction model = opencode (fallback: node-llama-cpp unavailable)`

依赖没装。在 `plugin/` 目录下跑 `npm install`。

### 抽取特别慢

正常现象，具体取决于你的硬件。把 `model.gpu` 设成 `"auto"`（默认值）让它用 GPU；`opencode --print-logs --log-level debug` 能看到最终选中的后端和每次抽取的耗时：

```
[mem-plus] llama backend = vulkan (gpu) build=prebuilt
[mem-plus] content model loaded: .../qwen3.5-4b-q4_k_m.gguf
[mem-plus] extract done in 1234 ms (210 chars)
```

嫌慢就临时切回 OpenCode 托管的模型：`"model": { "content": "opencode" }`。

### `memory/` 目录一直不出现

会话得至少有一个**完成的回合**才会触发写入。落地之后还要等 2 秒防抖 + 抽取跑完。

---

## 许可与来源

本项目包含 openclaw 的记忆子系统代码，遵循其原有许可。

- **openclaw** —— MIT License，Copyright (c) 2026 OpenClaw Foundation（见 [`LICENSE`](./LICENSE)）
- **Pi / pi-mono** 等第三方部分 —— 见 [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md)
- 闭包内各子包自带声明的，已随目录保留（`packages/ai/LICENSE`、`packages/gateway-client/LICENSE`、`packages/gateway-protocol/LICENSE`、`extensions/facetime/LICENSE`、`extensions/typesafe/LICENSE`）

`plugin/` 目录下是 mem-plus 新增的 OpenCode 适配层与本地模型运行时。