<div align="center">

# mem-plus

</div>

使用 OpenClaw 与 opencode-mem 源码开发的 OpenCode 持久记忆系统。全部推理在本地 GGUF 模型上运行，也可使用 OpenCode 模型。
不仅仅只是能记忆，在 `SOUL.md` / `IDENTITY.md` 文件里写入人设，也可以让它扮演角色（见[提示词注入](#提示词注入)）。

- **会话快照** — 每轮对话自动归档为 `memory/YYYY-MM-DD-标题.md`
- **LLM 抽取** — 本地模型将每轮工作内容提炼为结构化条目（请求 / 结果 / 标签），写入 `memory/YYYY-MM-DD.md`
- **混合检索** — 全文与向量双通道，模型可自动检索历史记忆
- **文档语料** — ChatGPT 导出或自备 markdown 页面编入同一索引，用 `corpus: "wiki"` 单独检索
- **睡眠整理** — 每日将当日条目汇编写入 `MEMORY.md`（长期记忆）与 `DREAMS.md`（洞察日志）
- **提示词注入** — `AGENTS.md`、`MEMORY.md` 等工作区文件在每轮对话前注入系统提示词，其内容对模型始终可见
- **人设与成长** — `SOUL.md`、`IDENTITY.md`、`USER.md` 等文件定义 agent 的性格、身份与用户画像，可随时修改；与逐日沉淀的长期记忆一起，agent 随使用慢慢"长成"你期望的助手



## 目录

- [环境要求](#环境要求)
- [快速开始](#快速开始)
  - [1. 下载安装包并安装](#1-下载安装包并安装)
  - [2. 注册插件](#2-注册插件)
  - [3. 下载模型](#3-下载模型)
  - [4. 重启 OpenCode 并验证](#4-重启-opencode-并验证)
  - [5. 全量重建索引（可选）](#5-全量重建索引可选)
- [日常使用](#日常使用)
  - [四个工具](#四个工具)
  - [文档语料（wiki）](#文档语料wiki)
  - [数据位置](#数据位置)
  - [推理服务](#推理服务)
- [模型](#模型)
- [配置](#配置)
  - [模型选项](#模型选项)
  - [服务](#服务)
  - [文档语料选项](#文档语料选项)
- [睡眠整理](#睡眠整理)
- [提示词注入](#提示词注入)
- [故障排除](#故障排除)
- [卸载](#卸载)
- [许可证](#许可证)

## 环境要求

- **OpenCode V2**（`@opencode/plugin` 2.0.20 及以上；不支持 V1）
- **Node 22.5+**（或 Bun）：检索工具依赖 `node:sqlite`。若缺失，快照与抽取功能正常运行，仅检索工具不可用。`node -v` 查看版本，低于 22.5 请先升级
- **抽取用的本地 GGUF 模型**（`Qwen3.5-4B-Q4_K_M.gguf`，~2.7 GB）：不用它就得用 OpenCode 计费模型抽取，见 [模型](#模型)
- **嵌入用的本地 GGUF 模型**（`bge-m3-FP16.gguf`，~1.2 GB，**可选**）：只有语义检索（`hybrid` / `vector`）需要它，纯文本检索不需要

## 快速开始

### 1. 下载安装包并安装

**Releases** 处下载 `mem-plus-<版本>.tgz`。

```powershell
cd ~/.config/opencode/plugins/ #此处示范路径为 OpenCode 的全局插件目录，可以修改为其他希望安装插件的文件夹路径。只影响记忆存放位置，不影响全局使用
npm i path #此处path为 .tgz 的文件路径
```

依赖由 npm 自动装齐（含 `node-llama-cpp` 的平台预编译二进制）。安装产物位于 `mem-plus/`。

### 2. 注册插件

OpenCode 插件的自动发现只扫全局插件目录 `~/.config/opencode/plugins/` 。如安装在其他位置，只需在 `opencode.jsonc`（全局： `~/.config/opencode/opencode.jsonc` 或项目目录下）里写入：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "C:/path/to/mem-plus",
      "options": {}
    }
  ]
}
```

路径即第 1 步安装出来的 `mem-plus/` 包目录（含 `index.ts` 与 `package.json` 的那层）：

- Windows 下须用正斜杠；建议写绝对路径，相对路径则相对配置文件所在目录解析
- 不传选项时也可写成字符串形式 `"C:/path/to/mem-plus"`；要传选项就用上面的对象形式，全部可选项见 [配置](#配置)
- 完整示例见 [`opencode.example.jsonc`](./opencode.example.jsonc)
- 保存后重启 OpenCode（`opencode service restart`）生效

### 3. 下载模型

两个 GGUF 模型共约 3.7 GB：

| 文件名 | 大小 | 用途 | 国内（ModelScope） | 海外（Hugging Face） |
|---|---|---|---|---|
| `Qwen3.5-4B-Q4_K_M.gguf` | ~2.7 GB | 抽取 | [Qwen3.5-4B-Q4_K_M.gguf](https://modelscope.cn/models/unsloth/Qwen3.5-4B-GGUF/resolve/main/Qwen3.5-4B-Q4_K_M.gguf) | [Qwen3.5-4B-Q4_K_M.gguf](https://huggingface.co/unsloth/Qwen3.5-4B-GGUF/resolve/main/Qwen3.5-4B-Q4_K_M.gguf) |
| `bge-m3-FP16.gguf` | ~1.2 GB | 向量嵌入 | [bge-m3-FP16.gguf](https://modelscope.cn/models/gpustack/bge-m3-GGUF/resolve/main/bge-m3-FP16.gguf) | [bge-m3-FP16.gguf](https://huggingface.co/gpustack/bge-m3-GGUF/resolve/main/bge-m3-FP16.gguf) |

安装目录（`mem-plus/`）没有 `models/` 时，插件默认取 `~/.config/opencode/mem-plus/models/`。创建该目录并放入文件即可；也可以用 `model.dir` 指向别的目录，或用 `model.contentPath` / `model.embedPath` 单独指定。只做纯文本检索的话，嵌入模型可以先不放（见[模型](#模型)）。

注意：

- 仓库中还托管有其他量化版本，它们不属于默认配置。
- 如想使用其他模型，两个槽位的类型不可互换：抽取槽位须为 completion 风格（base）语言模型，嵌入槽位须为带 embedding 头的模型。不经配置直接替换时，须将新模型重命名为与上表文件名相同后放入 models 目录；或保留原文件名，用 `model.contentPath` / `model.embedPath` 指向实际路径（见[配置](#配置)）。
- 详见 [模型](#模型)。

### 4. 重启 OpenCode 并验证

安装完成后重启 OpenCode 使插件生效（Windows 与 Linux / macOS 命令相同）：

```bash
opencode service restart
```

验证安装成功（两个都应出现）：

```powershell
# Windows：日志最后几行应出现 `plugin loaded`
Get-Content "$env:USERPROFILE\.config\opencode\mem-plus\mem-plus.log" -Tail 5
```

```bash
# Linux / macOS
tail -n 5 ~/.config/opencode/mem-plus/mem-plus.log
```

随后在任意项目中完成一个对话 turn，全局记忆目录 `~/.config/opencode/mem-plus/workspace/memory/` 下应出现当日文件（见 [数据位置](#数据位置)）。

日志中没有 `plugin loaded` 时：先检查第 2 步的路径是否指向 `mem-plus` 包目录并再次重启；仍不出现则见 [故障排除](#故障排除)。

### 5. 全量重建索引（可选）

平时不需要做任何事：插件写入的抽取条目、会话快照，以及文档语料（[wiki](#文档语料wiki)）里的页面，都会自动登记进索引。索引只是可丢弃的缓存，Markdown 才是数据本体。

需要手动跑一次的情况：

- 索引被删过或损坏——`memory_reindex` 就是修复手段，删索引不会丢记忆
- 全局记忆目录 `~/.config/opencode/mem-plus/workspace/` 下有**注册插件之前**就存在的记忆文件（手动写的，或从别的机器、别的目录迁移来的）
- 换过嵌入模型，需要按新模型重算向量

**在哪里执行**：不是终端命令，而是插件注册给 agent 的工具。在 OpenCode 的对话框里把下面这行当普通消息发给 agent 即可，agent 会调用对应工具；agent 觉得需要时也会自己调用。

```
memory_reindex                  # 只重建索引，纯文本检索够用时即可
memory_reindex {"embed": true}  # 顺带补齐向量，hybrid / vector 检索才可用
```

- 花括号里是该工具的参数（JSON），不是 shell 语法；照抄即可，也可以直接说「重建索引」让 agent 自己判断参数
- 扫描全局记忆目录与文档语料的全部文件并重建，幂等，可重复执行；输出会说明扫了多少个文件、写入多少个、移除了多少个（磁盘上已删除的文档）。
- `embed: true` 会为缺向量的内容各算一次向量，本地每个约几秒，第一次可能跑一会儿；只做纯文本检索就不必加。
- 新克隆的仓库第一次用它时，通常就是补 `hybrid` / `vector` 通道。

## 日常使用

### 四个工具

模型可自动调用；用户亦可在会话中显式指定调用。它们是**插件注册给 agent 的工具**，不是终端命令：在 OpenCode 对话框里把工具名连同参数当普通消息发给 agent（例：`memory_reindex {"embed": true}`），agent 收到后调用对应工具。

| 工具 | 作用 |
|---|---|
| `memory_search` | 检索记忆。默认为纯文本检索（最快，无需模型）；`mode: "hybrid"` 融合向量检索；`scope: "all"` 跨项目搜索；`corpus: "wiki"` / `"all"` 检索文档语料 |
| `memory_get` | 按 id 读取完整条目 |
| `memory_reindex` | 重建检索索引（全局记忆目录 + 文档语料）；`embed: true` 补齐向量 |
| `memory_wiki_import` | 把 ChatGPT 数据导出导入文档语料；`dryRun: true` 先看会写入什么 |

`memory_search` 参数：

- `query`（必填）
- `scope` — `project`（默认，本项目加全局长期记忆）/ `all`（全部项目）
- `mode` — `text`（默认）/ `hybrid` / `vector`
- `corpus` — `memory`（默认，只搜会话记忆）/ `wiki`（只搜文档语料）/ `all`（两者都搜）
- `limit`、`kind`（`entry` / `turn` / `memory` / `wiki`）、`tag`、`since`、`until`、`project`

全文检索采用 **AND** 语义：所有查询词均须命中。建议先使用具体词汇，无结果时再逐步放宽。

### 文档语料（wiki）

除会话记忆外，mem-plus 还维护一个**文档语料**：一个存放 markdown 页面的目录，默认 `~/.config/opencode/mem-plus/wiki/`。它对应 openclaw 的 `memory-wiki`（按其 active-branch、分诊与页面结构移植而来），但在 mem-plus 里落在同一套索引与同一组工具上：

- 页面就是普通 markdown 文件，任何编辑器都能读改；带 YAML frontmatter 时，`title` 作为标题、`labels` 作为标签、`sourceType` 作为类型，因此 `tag` / `type` 过滤对文档同样生效
- 直接把笔记、导出的文档、Obsidian 仓库丢进这个目录即可（`.obsidian` 等点目录会被跳过）
- 导入 ChatGPT 导出：ChatGPT「导出数据」得到 zip，解压后调用

  ```
  memory_wiki_import  {"path": "<解压后的目录或 conversations.json>", "dryRun": true}
  ```

  确认后再不带 `dryRun` 调用一次。每个会话写成 `wiki/sources/chatgpt-<日期>-<会话>.md`，只取 `current_node` 那条活跃分支（被重新生成而废弃的回答不会进来）；同一份导出重复导入不会产生重复页面。
- 检索时加 `corpus: "wiki"`（或 `"all"`）。文档没有时间戳，`since` / `until` 之类的日期过滤对它们不生效
- 文档语料可以在不删文件的前提下关掉：`wiki.enabled: false`（此时 `memory_wiki_import` 不再注册）

### 数据位置

项目目录内不写入任何文件。所有记忆文件集中在一个固定的全局记忆目录（所有项目共用，不按项目分开存放）：

```
~/.config/opencode/mem-plus/workspace/
├── MEMORY.md                        # 长期记忆（全局，由睡眠整理每日汇入）
├── DREAMS.md                        # 睡眠整理日志（全局，供人工审阅，不进入检索索引）
└── memory/
    └── <项目名>--<哈希>/            # 按项目分子目录（项目只是标签，不是独立库）
        ├── 2026-10-02.md            # 抽取条目
        └── 2026-10-02-fix-bug-x.md  # 会话快照
```

其余数据与它同在 `~/.config/opencode/mem-plus/` 下（所有项目共用一个索引）：

```
~/.config/opencode/mem-plus/
├── workspace/                       # 全局记忆目录（如上）
├── wiki/                            # 文档语料（用户自己的 markdown，可整个删掉）
│   └── sources/                     # memory_wiki_import 写入的页面
├── models/                          # GGUF 模型（npm 安装时的默认位置）
├── index.db                         # 检索索引（可随时删除，通过 memory_reindex 重建）
├── mem-plus.log                     # 日志
└── dreaming/last-day                # 睡眠整理标记（全局单个，删除后可强制重新执行）
```

Markdown 文件为唯一数据源；索引为可再生数据。

### 推理服务

插件在 `127.0.0.1:4748` 启动本地推理服务（独立进程）。多个 OpenCode 窗口共享同一服务，避免重复占用显存。服务空闲 10 分钟后自动退出，关闭 OpenCode 后不会持续占用 CPU。

GPU 优先级：**独显 > 核显**，不使用 CPU。独显不可用时自动尝试核显；若连核显也运行不了，推理服务不启动，日志直接报错（快照照常写入，抽取保持延后，直至出现可用 GPU）。日志将报告最终选用的后端：

```
[mem-plus] [mem-plus:serve] llama backend = vulkan (discrete or integrated) build=prebuilt
```

## 模型

mem-plus 默认使用两个本地 GGUF 模型：抽取模型 `Qwen3.5-4B-Q4_K_M.gguf` 与嵌入模型 `bge-m3-FP16.gguf`。切换模型通过 `opencode.jsonc` 中的 `model.*` 选项完成（完整键值表见 [模型选项](#模型选项)）：

- 换本地 GGUF 文件：`model.contentPath` / `model.embedPath`（或 `model.dir` 整体换目录）
- 改用 OpenCode 计费模型：`model.content: "opencode"`
- 指定用哪个 OpenCode 模型做抽取：`model.hostedModel: "anthropic/claude-sonnet-4-5"`（不写则沿用 OpenCode 自己的默认模型）
- 本地不可用时是否允许回退至计费模型：`model.allowHostedFallback`（默认 `false`，即不静默回退）

替换模型时须注意：

- **抽取模型必须使用 completion 风格（base）模型，不得使用 Instruct / Chat 风格模型**。使用 Instruct 模型进行抽取将静默返回空结果。默认的 `Qwen3.5-4B-Q4_K_M.gguf` 为 base 模型，适用。
- **嵌入模型须带 embedding 头**。默认的 `bge-m3-FP16.gguf` 满足此要求；嵌入槽位放入语言模型会在首次使用时报错。
- **嵌入模型可以不放**。它只服务语义检索：缺失时 `hybrid` / `vector` 与 `memory_reindex {"embed": true}` 不可用，快照、抽取与纯文本检索照常（日志会写明向量通道已关闭）。抽取模型缺失才会停掉抽取——两个槽位互不牵连，这一点沿用 openclaw 的嵌入 provider 降级语义。完全不想留这个槽位，可设 `model.embed: false`。
- 更换嵌入模型后须执行 `memory_reindex {"embed": true}` 重建向量。旧向量由旧模型计算，空间混杂会导致 hybrid / vector 检索结果错误。

**计费原则**：本插件推理全程本地化。本地推理不可用时（模型缺失、依赖未安装、端口被占用、服务异常），插件**不会**静默回退至计费模型：

1. 快照继续写入（不产生费用）
2. 抽取暂缓执行，待处理记录保留
3. 服务恢复后自动补做抽取：每个完成 turn 时插件先探测本地服务，可用才执行抽取；不可用时本轮跳过，待处理记录原样保留——服务恢复后的下一个 turn 自动补做，无需手动操作

如需启用计费模型回退，请显式设置 `model.allowHostedFallback: true` 或 `model.content: "opencode"`。

## 配置

以下配置项均为可选。需在 `opencode.jsonc` 中传入选项时使用对象形式：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "C:/path/to/mem-plus",
      "options": {
        "model": { "gpu": "auto" },
        "service": { "port": 4748 }
      }
    }
  ]
}
```

完整示例见 [`opencode.example.jsonc`](./opencode.example.jsonc)。

### 模型选项

| 键 | 默认值 | 说明 |
|---|---|---|
| `model.content` | `"local"` | `"local"` = 本地 GGUF 服务；`"opencode"` = OpenCode 计费模型 |
| `model.hostedModel` | — | 用哪个 OpenCode 模型做抽取，写 `"providerID/modelID"`（如 `"anthropic/claude-sonnet-4-5"`）。不写则沿用 OpenCode 默认模型；仅在走计费模型时生效 |
| `model.allowHostedFallback` | `false` | 本地推理不可用时是否允许回退至计费模型 |
| `model.dir` | `<安装目录>/models`（不存在时回落 `~/.config/opencode/mem-plus/models`） | GGUF 文件所在目录 |
| `model.contentPath` | `model.dir/Qwen3.5-4B-Q4_K_M.gguf` | 抽取模型路径 |
| `model.embedPath` | `model.dir/bge-m3-FP16.gguf` | 嵌入模型路径 |
| `model.embed` | `true` | `false` = 只用全文检索，不加载嵌入模型（对应 openclaw 的 `provider: "none"`） |
| `model.gpu` | `"auto"` | `"auto"`（独显 > 核显，无 CPU 回退）/ `"cuda"` / `"vulkan"`。CPU 推理已移除，旧的 `"cpu"` 值按 `"auto"` 处理 |
| `model.gpuLayers` | `"auto"` | 分配至显存的层数 |
| `model.contextSize` | `16384` | 抽取上下文窗口 |
| `model.maxNewTokens` | `512` | 单次抽取最大 token 数 |
| `model.threads` | `0` | CPU 线程数（宿主侧运算用；推理本身在 GPU 上运行） |
| `model.logLevel` | `"warn"` | `"silent"` / `"warn"` / `"info"` / `"debug"` |

### 服务

| 键 | 默认值 | 说明 |
|---|---|---|
| `service.port` | `4748` | 起始端口；被占用时自动递增，上限 4758 |
| `service.host` | `"127.0.0.1"` | 绑定地址（仅本机） |
| `service.autostart` | `true` | 服务未运行时自动启动 |
| `service.idleMinutes` | `10` | 空闲多少分钟后自动退出；`0` 表示不退出 |
| `service.startTimeoutMs` | `30000` | 等待服务就绪的最长时间 |
| `service.url` | — | 使用已在该地址运行的服务 |

### 文档语料选项

| 键 | 默认值 | 说明 |
|---|---|---|
| `wiki.dir` | `~/.config/opencode/mem-plus/wiki` | 文档语料目录，递归读取其中的 markdown |
| `wiki.enabled` | `true` | `false` = 文档语料不进索引，`memory_wiki_import` 也不再注册 |

## 睡眠整理

每个日历日内的首个完成 turn 触发（全局门控，所有项目每日合计最多一次），将当日条目汇编写入全局记忆目录根部的 `MEMORY.md`（长期记忆）与 `DREAMS.md`（洞察日志）。删除全局标记 `~/.config/opencode/mem-plus/dreaming/last-day` 可强制在下一 turn 重新执行。本地服务不可用时，整理流程降级为仅写入条目，不生成 LLM 叙述。

## 提示词注入

每轮模型调用前，mem-plus 读取项目根目录下的工作区文件并注入系统提示词，随后追加全局记忆目录（`~/.config/opencode/mem-plus/workspace/`）根部的全局 `MEMORY.md`。这些文件的名称与语义沿用 openclaw 的约定，缺失的文件自动跳过，可随时增改，下一轮即生效：

| 文件 | 作用 |
|---|---|
| `AGENTS.md` | 项目协作约定（工作规则、代码风格、偏好） |
| `SOUL.md` | 人设：agent 的性格、价值观与行为准则（openclaw 的"灵魂"文件） |
| `IDENTITY.md` | 身份：名字、角色、自称与语气 |
| `USER.md` | 用户画像：称呼、偏好、背景信息 |
| `BOOTSTRAP.md` | 启动引导说明 |

全局 `MEMORY.md` 所有项目共用一份，由睡眠整理每日汇入。写入 `SOUL.md` / `IDENTITY.md` 即为 agent 设定性格与身份；日常工作中踩过的坑、失败的方案经 LLM 抽取与睡眠整理沉淀进 `MEMORY.md`，注入内容逐日累积，agent 对项目的理解随使用演进。演进发生在提示词与记忆层面（注入文件、检索索引），不改变模型本身。

## 故障排除

日志文件位于 `~/.config/opencode/mem-plus/mem-plus.log`，排查问题时首先检查该文件。

| 现象 | 原因 / 处理 |
|---|---|
| `extraction DISABLED (GGUF not found)` | 抽取模型未放置于安装目录的 `models/`（npm 安装即 `~/.config/opencode/mem-plus/models`）。快照与纯文本检索不受影响 |
| `no embedding model at ... vector search off` | 嵌入模型不在。属正常降级：只有 `hybrid` / `vector` 不可用；要恢复就把文件放好或修正 `model.embedPath` |
| `missing ... (model.embedPath) -- vector search stays off` | 你显式写了 `model.embedPath` 而文件不在。修正路径，或删掉该选项让其静默降级 |
| `vector search off (model.embed = false)` | 配置如此，不是故障 |
| `service did not become healthy ... within 30s` | 服务未启动。手动执行：`node <安装目录>/plugin/serve/server.mjs --port 4748`，观察日志定位原因 |
| `gpu backend unavailable; service will not start` | 无可用 GPU（独显 > 核显，CPU 已禁用）。服务不启动，抽取保持延后；出现可用 GPU 后恢复 |
| `local service unavailable; deferring the sweep` | 服务暂不可用；记录保留，恢复后自动重试 |
| 抽取输出为空（`summary=0 chars`） | 抽取模型为 Instruct 风格，参见 [模型](#模型) |
| `Index: 0 documents` | 执行 `memory_reindex` |
| `hybrid` / `vector` 返回 0 条 | 执行 `memory_reindex {"embed": true}` 并等待完成 |
| `workspace/memory/` 下不出现当日文件 | 需完成一个完整 turn（结算 + 2 秒防抖）后生成 |
| 导入后搜不到文档 | 用 `memory_search` 带 `corpus: "wiki"`（默认只搜会话记忆）；导入完可执行一次 `memory_reindex` |

## 卸载

彻底移除插件及其数据（顺序执行）：

1. 关闭 OpenCode，并停止本地推理服务（命令在 Windows 与 Linux / macOS 上相同）：

   ```bash
   opencode service stop
   ```

2. 删除数据目录（全局记忆目录 `workspace/`、文档语料 `wiki/`、模型、索引、日志、睡眠整理标记）：

   ```powershell
   # Windows
   Remove-Item -Recurse -Force "$env:USERPROFILE\.config\opencode\mem-plus"
   ```

   ```bash
   # Linux / macOS
   rm -rf ~/.config/opencode/mem-plus
   ```

   目录内即记忆本体与可再生数据；需保留记忆时先备份 `workspace/`，否则直接删除
3. 删除第 1 步 `npm i` 时所在目录下的包（`node_modules/mem-plus`，路径按实际安装位置替换）：

   ```powershell
   # Windows
   Remove-Item -Recurse -Force "<npm i 时的目录>\node_modules\mem-plus"
   ```

   ```bash
   # Linux / macOS
   rm -rf <npm i 时的目录>/node_modules/mem-plus
   ```

   模型默认放在 `~/.config/opencode/mem-plus/models/`（第 3 步），第 2 步删除数据目录时已一并删除
4. 在 `opencode.jsonc` 中删除对应的 `plugins` 条目（npm 安装方式必然是显式注册的）
5. 重启 OpenCode，卸载完成

## 许可证

本仓库采用 MIT 许可。其中包含的第三方代码：

| 来源 | 范围 | 许可 | 版权 |
|---|---|---|---|
| [openclaw](https://github.com/openclaw/openclaw) | `src/`、`extensions/`、`packages/` 下记忆相关模块的副本 | MIT | Copyright (c) 2026 OpenClaw Foundation |
| [opencode-mem](https://github.com/tickernelz/opencode-mem) | Web 管理界面布局（计划并入） | MIT | Copyright (c) 2025 Zhafron Adani Kautsar |

各来源的完整许可文本见 [LICENSE](./LICENSE) 与 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。
