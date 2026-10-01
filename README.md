# mem-plus

**把 openclaw 的记忆系统接到 OpenCode 上，推理全部跑在本地 GGUF 模型上。**

OpenCode 本身不记事：这个会话查清了什么、改了哪些文件、走过哪些弯路，关掉窗口就只剩一个孤立的会话 id。mem-plus 让它把这些写下来。

- **记忆引擎直接来自 openclaw**（`extensions/memory-core/src/capture/`），不是重写 —— landing zone → 抽取 → 渲染 → 落盘，整条管线原样保留
- **只换宿主**：openclaw 的 `chat.message` 钩子换成 OpenCode V2 的事件，模型调用换成本地 GGUF
- **不出网**：模型从本地文件加载，不经过 Ollama，也不连任何远端服务

---

## 目录

- [当前状态](#当前状态)
- [安装](#安装)
- [配置](#配置)
- [架构：为什么有个 4748 服务](#架构为什么有个-4748-服务)
- [本地模型](#本地模型)
- [日志](#日志)
- [产出什么文件](#产出什么文件)
- [工作原理](#工作原理)
- [故障排除](#故障排除)
- [许可与来源](#许可与来源)

---

## 当前状态

请先读这一节，避免期望和现实对不上。

**已实现，端到端验证过**

| 能力 | 说明 |
|---|---|
| 会话快照 | 每次回合把整个会话重新渲染成 `memory/<日期>-<标题>.md`，含工具调用与输出 |
| LLM 抽取 | 走 openclaw 原管线，产出 `## Request` / `## Outcome` 摘要 + `Tags`，`type="skip"` 自动过滤，带幂等来源标记 |
| 全局档案 | 每个项目的会话镜像到 `~/.config/opencode/mem-plus/archive/<项目>/` |
| 本地模型 | 本机 Vulkan 核显实测：从冷启动到写入完成约 14 秒，单次抽取 4–12 秒 |
| **绝不计费** | 本地推理不可用时**不会**偷偷改用你的 OpenCode 付费模型。快照照写，抽取推迟到服务恢复 |

**还没实现**

- ❌ **检索**：`memory_search` / `memory_get` 没接。**现在能把记忆写下来，但搜不回来。**
- ❌ SQLite + FTS5 索引、向量通道（`bge-m3` 嵌入 + hybrid 混合检索）、跨项目档案搜索

> 顺序是刻意的：写入层先落地成普通 markdown，索引层再从这些文件重建投影 —— 和 openclaw 本身的分层一致。索引是可丢弃的重建产物，不是数据本体。

要"能记**且**能搜"，还差检索层。

---

## 安装

### 1. 克隆

```bash
git clone <this-repo> mem-plus
cd mem-plus
```

### 2. 安装依赖

```bash
cd plugin
npm install
```

会装上 `node-llama-cpp`（含你平台的原生二进制）。

**不装也能用** —— 插件照常加载，抽取自动改用 OpenCode 自己的模型。只有想用本地 GGUF 才必须装。

### 3. 注册插件

编辑 `opencode.jsonc`（项目级，或全局 `~/.config/opencode/opencode.jsonc`）：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    "C:/Users/你的用户名/repos/mem-plus/plugin"
  ]
}
```

路径支持三种写法。Windows 上**建议用正斜杠**，免得转义麻烦：

```jsonc
"plugins": [
  "/absolute/path/to/mem-plus/plugin",
  "../shared/mem-plus/plugin",
  "file:///home/you/mem-plus/plugin"
]
```

> 注意：填的是**仓库里的 `plugin/` 目录**，不是仓库根目录。插件要从 `../extensions/memory-core/` 读记忆引擎，所以不能只把 `plugin/` 复制出去。

### 4.（可选）放模型

```bash
# 放进仓库的 models/ 就会被自动认出来
mem-plus/models/qwen3.5-4b-q4_k_m.gguf
mem-plus/models/bge-m3-f16.gguf
```

`models/` 在 `.gitignore` 里（约 3.7 GB，不适合进仓库）。细节见 [本地模型](#本地模型)。

---

## 配置

所有配置写在 `opencode.jsonc` 的 `plugins` 数组里，用对象形式。**全部可选项，一个都不用改。**

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "C:/Users/你的用户名/repos/mem-plus/plugin",
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

完整样例见 [`opencode.example.jsonc`](./opencode.example.jsonc)。

### 模型

| 选项 | 默认值 | 说明 |
|---|---|---|
| `model.content` | `"local"` | `"local"` 用本地 GGUF；`"opencode"` **主动要求**改用 OpenCode 自己的计费模型 |
| `model.allowHostedFallback` | `false` | 本地推理**不可用时**是否改用计费模型。默认 `false`，见 [不会偷偷扣费](#不会偷偷扣费) |
| `model.dir` | `<仓库>/models` | GGUF 所在目录 |
| `model.contentPath` | `<model.dir>/qwen3.5-4b-q4_k_m.gguf` | 抽取模型完整路径 |
| `model.embedPath` | `<model.dir>/bge-m3-f16.gguf` | 向量模型完整路径 |
| `model.gpu` | `"auto"` | `"auto"` / `"cuda"` / `"vulkan"` / `"cpu"` |
| `model.gpuLayers` | `"auto"` | 放多少层到显存；`"auto"` 按当前显存自适应 |
| `model.contextSize` | `16384` | 抽取会话的上下文长度 |
| `model.maxNewTokens` | `512` | 单次抽取最多生成多少 token |
| `model.threads` | `0` | CPU 线程数，`0` = 不限制（仅 CPU 回退时生效） |
| `model.logLevel` | `"warn"` | `"silent"` / `"warn"` / `"info"` / `"debug"` |

### 不会偷偷扣费

这个项目的全部意义就是"推理跑在本地"。所以当本地推理**不可用**时（GGUF 放错目录、依赖没装、端口被占、服务崩了），插件**不会**改用你的 OpenCode 计费模型 —— 默认行为是：

1. 快照照常写入（这部分完全不花钱）
2. **跳过抽取**，待处理记录原样留在 landing zone，重试次数不变
3. 服务恢复后，下一次 sweep 正常抽取

日志里会写明：

```
[mem-plus] local service unavailable; deferring the sweep. Snapshots keep working
           and pending captures are retried once the service is back
```

**为什么不是"失败就回落"？** 两个原因，都是实测出来的：

**一，回落会静默烧钱。** 早期版本默认回落，于是本地服务起不来的那一次，抽取悄悄走了你的付费模型 —— 日志之外你不会知道。一个"免费本地"的插件，不能把配置错误变成计费账单。

**二，直接抛错比扣钱更糟。** openclaw 的抽取管线对失败重试 3 次、基准延迟 2 秒，耗尽后该记录被**永久搁置**。用真实管线实测：

```
complete() 被调用 3 次 → outcome = exhausted → 仍在 pending = 0
```

也就是说服务停 10 秒，那条记忆就没了。所以插件在 sweep **认领任何记录之前**先探一次服务：

```
服务挂 → 跳过 sweep，complete() 一次没调，attempts 仍为 0，记录保留
服务回 → 第一次尝试就 captured，只调 1 次 complete
```

要主动接受计费，两种方式：

```jsonc
{
  "model": {
    "allowHostedFallback": true   // 本地不可用时用计费模型顶替
  }
}
```

```jsonc
{
  "model": {
    "content": "opencode"        // 全程都用计费模型
  }
}
```

### 推理服务

| 选项 | 默认值 | 说明 |
|---|---|---|
| `service.port` | `4748` | 起始端口；被占用时自动顺延，最多试到 `4758` |
| `service.host` | `"127.0.0.1"` | 只监听本机 |
| `service.autostart` | `true` | 服务没跑时由插件拉起；`false` 则只连接不拉起 |
| `service.idleMinutes` | `10` | 空闲多久后自动退出；`0` = 不回收 |
| `service.startTimeoutMs` | `30000` | 拉起后等多久算就绪 |
| `service.url` | 无 | 直接指定完整地址，跳过发现和自动拉起 |

想手动常驻服务：

```bash
cd plugin
node serve/server.mjs --port 4748 --idle-minutes 0
curl http://127.0.0.1:4748/health
```

自己起的服务插件不会替你关掉（`dispose` 只回收自己拉起的那个）。

### GPU 优先级

按 **独显 > 核显 > CPU** 顺序显式尝试，**不是**交给库自己猜：

| 顺序 | 值 | 对应硬件 |
|---|---|---|
| 1 | `cuda` | NVIDIA 独显 |
| 2 | `metal` | Apple 独显 / 统一内存 |
| 3 | `vulkan` | AMD / Intel 独显、所有核显（llama.cpp 内部会挑最强的 Vulkan 设备） |
| 4 | `false` | 纯 CPU |

某一档加载失败（比如 Vulkan 驱动有问题）自动降级到下一档，**不会整个插件挂掉**。日志里会写明最终选中的：

```
[mem-plus] [mem-plus:serve] llama backend = vulkan (gpu) build=prebuilt
```

---

## 架构：为什么有个 4748 服务

```
OpenCode 插件（bun 进程）
   │  只管事件、落盘、HTTP 调用
   │  自动拉起服务，按需回收
   ▼
127.0.0.1:4748  ← 独立 Node 进程
   ├─ node-llama-cpp（原生绑定能正常加载）
   ├─ qwen 抽取 + bge-m3 向量，两个模型常驻
   └─ /health  /extract  /embed
```

**为什么不能直接在插件进程里跑？**

node-llama-cpp 加载原生绑定时会 fork 一个子进程做兼容性自检（`testBindingBinary.js`）。OpenCode 插件跑在 bun 里，`process.execPath` 是 opencode 的可执行文件而非 node —— 这个 fork 必然失败，绑定加载不了，又没有编译器可以退回源码构建。

实测：同环境下独立 `node`、独立 `bun` 都正常加载（`build=prebuilt`），只有嵌在 OpenCode 里失败。没有环境变量能跳过这个自检。

**拆开之后额外的好处**

- **一个模型实例被所有项目共享** —— 四个项目各开一个窗口，只加载一次 4 GB
- 4 GB 内存隔离在独立进程，llama.cpp 崩了不会带走 OpenCode 服务端
- 模型常驻，不用每次抽取重新加载
- 排障时直接 `curl`，不用读插件内部代码

**4748 而不是 4747**：opencode-mem 已经占了 4747 做记忆管理 Web UI，同一台机器上两个东西不能撞。

**空闲自动退出**：模型常驻约 4 GB。默认空闲 10 分钟服务自己走，不会在你关掉 OpenCode 之后还在后台占着 CPU 和内存。

---

## 本地模型

`models/` 在 `.gitignore` 里，需要你自己放两个文件：

| 用途 | 默认文件名 | 体积 | 干什么 |
|---|---|---|---|
| 抽取 | `qwen3.5-4b-q4_k_m.gguf` | ~2.6 GB | 把一次助手回合总结成结构化条目 |
| 向量 | `bge-m3-f16.gguf` | ~1.1 GB | 给记忆块算嵌入（**检索层用，现在还没接**） |

放到别处也行，用 `model.dir` / `model.contentPath` / `model.embedPath` 指过去。模型懒加载 —— 不触发抽取的项目不会占那 4 GB。

> **Windows 建议**：Defender 实时扫描会显著拖慢 GGUF 推理。如果抽取明显卡，把 `models/` 目录加进 Defender 排除项（需要管理员权限）。

### 抽取模型必须是"补全型"，不能用对话模板

这个坑值得单独写一节，因为它不报错、只是**静默返回空字符串**。

`Qwen3.5 4b **Src**` 里的 Src 是 source，即**预训练权重，不是 Instruct**。它带着 `chat_template`，但权重没经过指令微调。喂 `LlamaChatSession` 的对话模板，它会直接吐 EOS：

```
extract done in 12946 ms (0 chars)
```

流式回调也不触发 —— 看起来像是崩了，其实是模型在正常地"什么都不说"。

所以抽取走的是 **`LlamaCompletion` + few-shot 示例 + GBNF 语法约束**，三层各管一件事：

| 层 | 作用 |
|---|---|
| openclaw 原系统提示 | 保留语言选择和 `## Request` / `## Outcome` 格式要求 |
| 5 个 few-shot 示例 | 教基座模型"该长什么样" —— 2 个 skip、3 个技术活儿，覆盖不同 `type` |
| GBNF 语法 | 从 openclaw 的 `CAPTURE_SUMMARY_JSON_SCHEMA` 生成，**结构上不可能输出非法 JSON** |

示例里必须留 `tags: []` 的 skip 例子，所以语法层**不能**加 `minItems` —— 那会把"跳过"本身变成非法输出。

另外 `type` 字段单独做了双向归一化：基座模型会写好摘要然后标成 `skip`，也会给该记的内容标 `skip`。**摘要是信号** —— 空摘要一律 `skip`，非空摘要绝不因为一个标错的 token 被丢掉。

**如果你换成一个 Instruct 模型**：把 `LlamaChatSession` 换回去会更准，但 few-shot + 语法这套照样能跑，不用改配置。

---

## 日志

OpenCode 的插件 API **没有日志接口**，插件的 `console.log` 既不进 `--print-logs`，也不进 `~/.local/share/opencode/log/opencode.log`（2026-10-01 实测确认）。

所以插件自己写日志：

```
~/.config/opencode/mem-plus/mem-plus.log
```

超过 2 MB 自动轮转（保留一份 `.1`）。正常工作的日志长这样：

```
2026-10-01T09:27:40.333Z [mem-plus] snapshot 904 B -> ...\memory\2026-10-01-creating-and-verifying-hello-txt-with-memplus.md
2026-10-01T09:27:40.671Z [mem-plus] starting service: node ...\serve\server.mjs --port 4748
2026-10-01T09:27:40.756Z [mem-plus] [mem-plus:serve] listening on http://127.0.0.1:4748
2026-10-01T09:27:41.683Z [mem-plus] [mem-plus:serve] llama backend = vulkan (gpu) build=prebuilt
2026-10-01T09:27:46.111Z [mem-plus] [mem-plus:serve] content model loaded: ...\qwen3.5-4b-q4_k_m.gguf
2026-10-01T09:27:54.079Z [mem-plus] [mem-plus:serve] extract done in 7965 ms (type=feature, tags=2, summary=184 chars)
2026-10-01T09:27:54.095Z [mem-plus] captured prompt_1790846851535_8df77c4 -> memory/2026-10-01.md
```

Windows 下实时看：

```powershell
Get-Content "$env:USERPROFILE\.config\opencode\mem-plus\mem-plus.log" -Wait
```

服务自己的输出也转发进同一个文件，所以上面 `[mem-plus:serve]` 前缀的行就是 4748 服务的日志。

---

## 产出什么文件

### 项目内

```
<你的项目>/
├── MEMORY.md                            # 提升后的长期记忆
└── memory/
    ├── 2026-10-01.md                    # 抽取出来的条目，每天一个
    └── 2026-10-01-创建并验证 hello.txt.md   # 完整会话快照
```

`2026-10-01.md` 里的条目长这样（真实输出）：

```markdown
## 2026-10-01T09:27:40.333Z · auto-capture · feature

## Request
Create a file named hello.txt containing the word memplus, then read it back to verify.

## Outcome
Created hello.txt with content 'memplus' and verified by reading it back.

Tags: file-creation, verification
<!-- openclaw-capture:prompt_1790846851535_8df77c4 -->
```

末尾那串注释是 openclaw 原格式的来源标记 —— 幂等去重和溯源都靠它。

快照文件包含整个会话：你的每一轮提问、`patch`/`shell` 等工具的调用与输出、最后的回复结论。

### 全局档案

```
~/.config/opencode/mem-plus/archive/<项目名>--<路径哈希>/
├── INDEX.md
└── memory/
    └── ...
```

每个项目的会话在这里留一份跨项目副本。目录名带路径哈希，所以两个同名项目不会撞。Windows 上 `~/.config` 就是 `C:\Users\<你>\.config`。

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
                                                → LLM 结构化抽取
                                                → 过滤 type="skip"
                                                → 渲染
                                                → 追加 memory/<日期>.md
```

几个设计取舍：

- **用 `session.inbox.enqueued` 而不是 `session.hook("prompt")`** —— 前者是**已持久化**的准入边界，带着稳定的 `inboxID`；后者在准入之前就触发了，拿到的文本可能是最终形态的前一版
- **推理放在独立进程** —— 见 [架构](#架构为什么有个-4748-服务)
- **快照每次回合都 upsert** —— OpenCode V2 没有会话离开钩子
- **2 秒防抖** —— 一个回合触发多个完成事件，聚合一下再跑，避免重复抽取
- **抽取在后台跑**，不阻塞你继续对话

---

## 故障排除

**日志在哪？** `~/.config/opencode/mem-plus/mem-plus.log`，见 [日志](#日志)。先看这个，它比 opencode 自己的日志有用。

**抽取结果是空的 / `summary=0 chars` 且 `type=skip`** —— 大概率你的 content 模型是指令微调过的（Instruct / Chat），却按基座模型的方式在用，或者反过来。检查日志里 `extract done in Xms` 后面括号里的 `summary` 长度；一直为 0 就是模型不适用，见 [抽取模型必须是补全型](#抽取模型必须是补全型)。

**`service did not become healthy ... within 30s`** —— 服务没起来。看日志里 `[mem-plus:serve]` 的行：模型文件不存在、端口全被占、还是依赖没装。手动跑一次看报错：

```bash
cd plugin
node serve/server.mjs --port 4748
```

**`extraction DISABLED (GGUF not found)`** —— 模型文件不在，日志里会打印缺哪个路径。快照照写，只是没有抽取。

**`local service unavailable; deferring the sweep`** —— 服务暂时不可用。记录原样保留等服务回来，不是错误。

**`using the OpenCode model ... (metered)`** —— 你开了 `model.allowHostedFallback`，这次抽取花了你的钱。

**抽取特别慢** —— 取决于硬件。保持 `model.gpu: "auto"`，日志里看最终选中的后端和每次耗时。嫌慢就临时切回 OpenCode 托管的模型：`"model": { "content": "opencode" }`（**会计费**）。

**`memory/` 目录一直不出现** —— 会话得至少有一个**完成的回合**才会触发写入。落地之后还要等 2 秒防抖 + 抽取跑完。日志里搜 `snapshot` 和 `captured` 两行确认。

**日志里出现 `sweep: nothing pending`** —— 快照写了但抽取没跑，说明 landing zone 里没有待处理的记录。用 `session.inbox.enqueued` 兜底抓取没生效（通常是事件没到）。

---

## 许可与来源

本项目包含 openclaw 的记忆子系统代码，遵循其原有许可。

- **openclaw** —— MIT License，Copyright (c) 2026 OpenClaw Foundation（见 [`LICENSE`](./LICENSE)）
- **Pi / pi-mono** 等第三方部分 —— 见 [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md)
- 闭包内各子包自带声明的，已随目录保留（`packages/ai/LICENSE`、`packages/gateway-client/LICENSE`、`packages/gateway-protocol/LICENSE`、`extensions/facetime/LICENSE`、`extensions/typesafe/LICENSE`）

`plugin/` 目录下是 mem-plus 新增的 OpenCode 适配层、HTTP 客户端和本地推理服务。