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

- [运行要求](#运行要求)
- [安装](#安装)
- [日常使用](#日常使用)
- [配置](#配置)
- [模型与推理](#模型与推理)
- [数据位置](#数据位置)
- [记忆如何被使用](#记忆如何被使用)
- [故障排查](#故障排查)
- [更新](#更新)
- [卸载](#卸载)
- [许可证](#许可证)

## 运行要求

| 项目 | 要求 |
|---|---|
| OpenCode | V2，`@opencode/plugin` 2.0.20 及以上（不支持 V1）。`opencode --version` 查看 |
| Node.js | 22.5 及以上，或 Bun。检索工具依赖内置的 `node:sqlite`。`node -v` 查看 |
| GPU | 需可用显卡，优先级为独显 > 核显，不使用 CPU 推理 |
| 磁盘 | 插件约 4 MB；本地模型约 3.7 GB（可选，见[模型与推理](#模型与推理)） |

Node.js 低于 22.5 时插件仍可加载，会话快照与抽取正常进行，仅检索工具不注册。

## 安装

### 1. 取得安装包

在仓库的 **Releases** 页面下载 `mem-plus-<版本>.tgz`（例如 `mem-plus-0.1.0.tgz`）。

### 2. 安装

在终端执行。安装目录可自行指定，仅影响插件代码的存放位置，不影响记忆数据的位置（见[数据位置](#数据位置)）。

```bash
cd ~/.config/opencode/plugins        # 或任意其他目录
npm i "<mem-plus-0.1.0.tgz 的完整路径>"
```

```powershell
# Windows
cd "$env:USERPROFILE\.config\opencode\plugins"
npm i "<mem-plus-0.1.0.tgz 的完整路径>"
```

安装后插件目录为 `mem-plus/`，内含 `package.json`、`index.ts`、`plugin/`。依赖由 npm 自动安装，包含 `node-llama-cpp` 的平台预编译二进制。

若安装时跳过了 npm 脚本（如使用了 `--ignore-scripts`），运行时模块别名会缺失，需手动生成一次：

```bash
node "<插件目录>/plugin/scripts/link-openclaw-alias.mjs"
```

### 3. 选择一种加载方式

**mem-plus 只能被加载一次。**以下两种方式任选其一，不可同时使用：自动发现与配置条目指向同一目录时，OpenCode 会将其识别为两个插件，工具重复注册，同一轮对话也会被记录两次。

| 方式 | 安装位置 | 是否写入 `opencode.jsonc` | 能否传入选项 |
|---|---|---|---|
| A 自动发现 | 全局插件目录的直接子目录：`~/.config/opencode/plugins/mem-plus` | **不写** | 不能。需要选项请用方式 B |
| B 显式注册 | 全局插件目录**之外**的任意位置，例如 `~/.config/opencode/mem-plus` | 写一条 | 能 |

默认建议使用方式 A；需要配置抽取来源、模型、服务端口或文档语料时，使用方式 B。

方式 B 的配置文件为 `~/.config/opencode/opencode.jsonc`，**Windows：** `%USERPROFILE%\.config\opencode\opencode.jsonc`（不使用 `%APPDATA%`）。也可使用项目目录下的 `opencode.jsonc`。该格式为 JSONC，允许 `//` 注释。

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "C:/Users/你的用户名/.config/opencode/mem-plus",
      "options": {}
    }
  ]
}
```

`package` 为插件目录的绝对路径，即包含 `package.json` 与 `index.ts` 的那一层，不可填写内层 `plugin/` 子目录；Windows 下须使用正斜杠 `/`。不传选项时可简写为字符串：`"plugins": ["C:/path/to/mem-plus"]`。

若已按方式 A 安装（插件位于全局插件目录下），却在 `opencode.jsonc` 中也写入了同一条目，OpenCode 会加载两份：日志中出现两条 `plugin loaded`，工具列表中 `memory_search` 等出现两次，同一轮对话生成两份快照。此时删除 `opencode.jsonc` 中的该条目，或将插件目录移出全局插件目录，二者取一即可。

完整示例见 [`opencode.example.jsonc`](./opencode.example.jsonc)。

### 4. 放置模型

模型用于抽取与嵌入，属于可选项：完全不使用本地模型时，抽取可交由 OpenCode 端模型完成（见[模型与推理](#模型与推理)）。

| 文件名 | 大小 | 用途 | 国内（ModelScope） | 海外（Hugging Face） |
|---|---|---|---|---|
| `Qwen3.5-4B-Q4_K_M.gguf` | ~2.7 GB | 抽取 | [下载](https://modelscope.cn/models/unsloth/Qwen3.5-4B-GGUF/resolve/main/Qwen3.5-4B-Q4_K_M.gguf) | [下载](https://huggingface.co/unsloth/Qwen3.5-4B-GGUF/resolve/main/Qwen3.5-4B-Q4_K_M.gguf) |
| `bge-m3-FP16.gguf` | ~1.2 GB | 嵌入（仅语义检索需要） | [下载](https://modelscope.cn/models/gpustack/bge-m3-GGUF/resolve/main/bge-m3-FP16.gguf) | [下载](https://huggingface.co/gpustack/bge-m3-GGUF/resolve/main/bge-m3-FP16.gguf) |

放入 `~/.config/opencode/mem-plus/models/`（需自行创建）：

```bash
mkdir -p ~/.config/opencode/mem-plus/models
```

```powershell
# Windows
New-Item -ItemType Directory -Force "$env:USERPROFILE\.config\opencode\mem-plus\models"
```

插件目录内若存在 `models/`，则优先使用该目录。也可用 `model.dir` 指定其他目录，或用 `model.contentPath` / `model.embedPath` 分别指定文件。

抽取槽位必须使用 completion 风格（base）模型，Instruct 与 Chat 风格模型会返回空结果；嵌入槽位必须使用带 embedding 头的模型；两者不可互换。

### 5. 重启并确认

```bash
opencode service restart
```

日志位于 `~/.config/opencode/mem-plus/mem-plus.log`，其中应出现：

```
[mem-plus] plugin loaded, workspace ...
[mem-plus] index ...\.config\opencode\mem-plus\index.db
[mem-plus] retrieval tools ready: memory_search, memory_get, memory_reindex, memory_wiki_import
```

`plugin loaded` 表示插件已加载，`retrieval tools ready` 表示检索工具已注册。日志中没有 `plugin loaded` 时，核对第 3 步的路径后再次重启。

在任意项目中向 agent 提出一个具体任务（例如"创建 test-memplus.txt，内容为 hello，并读取确认"），完成一轮对话后，全局记忆目录下应出现当日文件。该写入在对话结束约 2 秒后发生。

## 日常使用

### 自动记录的内容

无需任何手工操作，以下过程由插件自动完成：

| 过程 | 触发时机 | 结果 |
|---|---|---|
| 会话快照 | 每轮对话结束（约 2 秒后） | 该轮原文写入 `memory/<项目名>--<哈希>/<日期>-<标题>.md` |
| 条目抽取 | 每轮对话结束，模型可用时 | 一条结构化记录追加到 `memory/<项目名>--<哈希>/<日期>.md` |
| 索引更新 | 写入完成后 | 新内容登记进索引，可立即检索 |
| 睡眠整理 | 每个日历日的首个完成 turn | 当日条目汇总写入 `MEMORY.md` 与 `DREAMS.md` |
| 提示词注入 | 每轮对话开始前 | 工作区文件与全局长期记忆注入系统提示词 |

快照不需要模型，任何情况下都会写入。抽取需要模型，模型不可用时该项延后，服务恢复后自动补做。

### 四个工具

以下为插件注册给 agent 的工具，**不是终端命令**。在 OpenCode 对话框中将工具名与参数作为普通消息发送，agent 收到后调用对应工具；agent 判断需要时也会自行调用。

| 工具 | 作用 |
|---|---|
| `memory_search` | 检索记忆与文档 |
| `memory_get` | 按 id 读取完整条目 |
| `memory_reindex` | 重建检索索引，可同时补齐向量 |
| `memory_wiki_import` | 将 ChatGPT 导出导入文档语料 |

`memory_search` 参数：

| 参数 | 取值 | 说明 |
|---|---|---|
| `query` | 字符串 | 必填。输入记得的关键词，不要输入指令句 |
| `mode` | `text`（默认）/ `hybrid` / `vector` | 全文检索 / 全文加向量 / 仅向量。后两者需要嵌入模型与本地服务 |
| `scope` | `project`（默认）/ `all` | 当前项目加全局长期记忆 / 全部项目 |
| `corpus` | `memory`（默认）/ `wiki` / `all` | 会话记忆 / 文档语料 / 两者 |
| `kind` | `entry` / `turn` / `memory` / `wiki` | 抽取条目 / 会话轮次 / 长期记忆 / 文档分节 |
| `tag`、`type`、`since`、`until`、`project`、`limit` | — | 按标签、类型、日期区间、项目筛选。`since` / `until` 为 `YYYY-MM-DD` |

全文检索为 **AND** 语义，查询中的所有词都需命中；建议先使用具体关键词，未命中时再减少词数。检索结果含来源路径与条目 id，可继续用 `memory_get` 读取完整内容。

```jsonc
// 用 memory_search 搜 postgres 连接池
{ "query": "postgres 连接池" }

// 指定模式与语料
{ "query": "部署时数据库连不上", "mode": "hybrid", "corpus": "all" }
```

### 重建索引

索引由记忆文件生成，删除索引不会造成记忆丢失。以下情况需要手动重建：

- 索引被删除或损坏
- 全局记忆目录下存在安装之前就已存在的记忆文件（手工写入，或从其他机器迁移而来）
- 更换嵌入模型后需要重新计算向量
- 导入文档语料后希望立即可检索

```jsonc
memory_reindex                      // 只重建索引
memory_reindex { "embed": true }    // 顺带补齐向量
```

两条命令均为幂等操作，可重复执行。第二条会为缺少向量的内容各计算一次向量（本地每个约数秒，首次执行耗时较长）；仅使用全文检索时无需第二条。

### 文档语料

文档语料是一个存放 markdown 页面的目录，默认位于 `~/.config/opencode/mem-plus/wiki/`。它对应 OpenClaw 的 `memory-wiki`，按其活跃分支判定、风险分诊与页面结构移植而来，与记忆共用同一套索引与同一组工具。

页面为普通 markdown，可用任意编辑器读写。含 YAML frontmatter 时，`title` 作为标题、`labels` 作为标签、`sourceType` 作为类型，因此 `tag` 与 `type` 过滤对文档同样有效。文档不带时间戳，`since` / `until` 等日期过滤对其不生效。放入笔记、导出文档或 Obsidian 仓库即可（以点开头的目录会被跳过）。

导入 ChatGPT 对话记录：ChatGPT 的"导出数据"生成压缩包，解压后得到包含 `conversations.json` 的目录。

```jsonc
// 先预检
{ "path": "<解压后的目录或 conversations.json 的路径>", "dryRun": true }

// 确认后执行
{ "path": "<解压后的目录或 conversations.json 的路径>" }
```

每个会话生成一个页面 `wiki/sources/chatgpt-<日期>-<会话>.md`，仅保留 `current_node` 所指向的活跃分支，被重新生成而废弃的回答不会写入。对同一份导出重复执行不会产生重复页面。导入完成后以 `corpus: "wiki"` 检索。

可在不删除文件的前提下停用文档语料：在 `options.wiki` 中设 `"enabled": false`，此时 `memory_wiki_import` 不再注册。

## 配置

### 配置文件

全部可调项均写入 `opencode.jsonc` 中 mem-plus 条目的 `options` 字段，即[方式 B](#3-选择一种加载方式)所注册的同一个文件。使用方式 A（自动发现）时没有可写入的条目，任何选项都无法设置；需配置选项请改用方式 B。

```
~/.config/opencode/opencode.jsonc            # 全局，对所有项目生效
```

```powershell
# Windows
%USERPROFILE%\.config\opencode\opencode.jsonc
```

也可在项目目录下放置 `opencode.jsonc`，仅对该项目生效（同名文件两处都存在时，项目级的键覆盖全局的同名键）。

键的位置如下。本文所有选项名（如 `model.content`、`wiki.enabled`）均相对于 `options`：

```
opencode.jsonc
└── plugins                    插件列表
    └── [0]                    第 3 步注册的 mem-plus 条目
        ├── package            插件安装路径
        └── options            ← 所有可调项写在这里
            ├── model          抽取与嵌入模型
            ├── service        推理服务
            └── wiki           文档语料
```

注意事项：

- **`plugins` 数组中 mem-plus 只应存在一条**。第 3 步的注册与本节的 `options` 是同一条目：若已按第 3 步注册，请在该条目内补充 `options`，不要再新增一条。同一插件出现两条时会被加载两次，表现为工具重复注册、同一轮对话可能被写两次记忆
- 若第 3 步使用的是字符串形式（`"plugins": ["C:/path/to/mem-plus"]`），则无法传入任何选项。**凡需设置选项，必须在原位置改为对象形式**（`{ "package": ..., "options": { ... } }`），其余项目保持不变
- `options` 中的未知键会被忽略，不产生报错；键名拼写错误亦无提示，修改后请以启动日志为准核对
- 该文件为 JSONC，允许 `//` 与 `/* */` 注释；修改后需执行 `opencode service restart` 生效

### 完整示例

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "C:/Users/你的用户名/.config/opencode/plugins/mem-plus",
      "options": {
        "model": {
          "content": "local",
          "hostedModel": "anthropic/claude-sonnet-4-5",
          "allowHostedFallback": false,
          "dir": "C:/Users/你的用户名/models",
          "gpu": "auto",
          "logLevel": "warn"
        },
        "service": {
          "port": 4748,
          "idleMinutes": 10,
          "autostart": true
        },
        "wiki": {
          "enabled": true,
          "dir": "C:/Users/你的用户名/.config/opencode/mem-plus/wiki"
        }
      }
    }
  ]
}
```

所有选项均为可选项，未设置时使用下表中的默认值。修改配置后需执行 `opencode service restart` 生效。

### 模型选项

| 键 | 默认值 | 说明 |
|---|---|---|
| `model.content` | `"local"` | 抽取来源。`"local"` = 本地 GGUF；`"opencode"` = 由 OpenCode 侧模型完成推理 |
| `model.hostedModel` | — | 使用 OpenCode 端模型时指定哪一个，格式 `"providerID/modelID"`。不设置则沿用 OpenCode 默认模型 |
| `model.allowHostedFallback` | `false` | 本地推理不可用时是否改用 OpenCode 端模型。默认 `false`，即抽取延后而不改用 |
| `model.dir` | 插件目录下的 `models/`，不存在时回落 `~/.config/opencode/mem-plus/models` | GGUF 文件所在目录 |
| `model.contentPath` | `model.dir/Qwen3.5-4B-Q4_K_M.gguf` | 抽取模型文件路径 |
| `model.embedPath` | `model.dir/bge-m3-FP16.gguf` | 嵌入模型文件路径 |
| `model.embed` | `true` | `false` = 停用嵌入槽位，仅使用全文检索 |
| `model.gpu` | `"auto"` | `"auto"`（独显 > 核显，无 CPU 回退）/ `"cuda"` / `"vulkan"`。CPU 推理已移除，旧的 `"cpu"` 值按 `"auto"` 处理 |
| `model.gpuLayers` | `"auto"` | 分配至显存的层数 |
| `model.contextSize` | `16384` | 抽取上下文窗口 |
| `model.maxNewTokens` | `512` | 单次抽取的最大 token 数 |
| `model.threads` | `0` | 宿主侧运算使用的 CPU 线程数，推理本身在 GPU 上运行 |
| `model.logLevel` | `"warn"` | `"silent"` / `"warn"` / `"info"` / `"debug"` |

### 服务选项

推理服务为独立进程，多个 OpenCode 窗口共用同一实例，避免重复占用显存；空闲后自动退出。

| 键 | 默认值 | 说明 |
|---|---|---|
| `service.port` | `4748` | 起始端口；被占用时自动递增，上限 4758。4747 为 opencode-mem 使用 |
| `service.host` | `"127.0.0.1"` | 绑定地址，仅本机 |
| `service.autostart` | `true` | 服务未运行时是否由插件自动启动 |
| `service.idleMinutes` | `10` | 空闲多少分钟后自动退出，`0` 表示不退出 |
| `service.startTimeoutMs` | `30000` | 等待服务就绪的最长时间 |
| `service.url` | — | 使用已在该地址运行的服务，跳过自动启动 |

### 文档语料选项

| 键 | 默认值 | 说明 |
|---|---|---|
| `wiki.dir` | `~/.config/opencode/mem-plus/wiki` | 文档语料目录，递归读取其中的 markdown |
| `wiki.enabled` | `true` | `false` = 文档语料不进入索引，`memory_wiki_import` 不再注册 |

## 模型与推理

mem-plus 仅在两处使用模型，且两者相互独立：抽取使用语言模型，嵌入使用 embedding 模型。缺少其中之一只影响其对应的功能。

### 抽取来源

由 `options.model.content` 与 `options.model.allowHostedFallback` 决定，实际生效的只有以下之一（键的位置见[配置文件](#配置文件)）：

| 抽取来源 | 在 `options.model` 中设置 | 推理位置 | 说明 |
|---|---|---|---|
| 本地 GGUF | 保持默认（`content` 为 `local`），放好 `Qwen3.5-4B-Q4_K_M.gguf` | 本机 | 默认。本地模型不可用时抽取延后，不会自动改用其他来源 |
| OpenCode 端模型 | `"content": "opencode"` | 由 OpenCode 侧决定 | 抽取请求交由 OpenCode 发出，无需本地抽取模型 |
| 本地失败时改用 OpenCode 端模型 | `"allowHostedFallback": true` | 由 OpenCode 侧决定（仅失败的轮次） | 平时使用本地模型；本地服务不可用时该轮改由 OpenCode 侧完成 |

例如改为由 OpenCode 端模型抽取，并指定模型（方式 B，需写入 `opencode.jsonc`）：

```jsonc
// ~/.config/opencode/opencode.jsonc
{
  "plugins": [
    {
      "package": "C:/Users/你的用户名/.config/opencode/plugins/mem-plus",
      "options": {
        "model": {
          "content": "opencode",
          "hostedModel": "anthropic/claude-sonnet-4-5"
        }
      }
    }
  ]
}
```

### 通过 OpenCode 端模型推理

mem-plus 不直接访问任何模型厂商接口。抽取时它调用 OpenCode 插件上下文提供的生成接口（`ctx.generate.text`）发起一次补全请求，其余环节均由 OpenCode 负责：

```
mem-plus ──> ctx.generate.text ──> OpenCode 侧 provider 与模型 ──> 抽取结果
```

因此：

- **无需在 mem-plus 中配置 API key、provider 或 endpoint**。认证、token 刷新、provider 路由与用量统计都在 OpenCode 侧完成，与您平常使用 OpenCode 的方式一致
- **推理是否发生在本机，取决于 OpenCode 侧的 provider 配置**。若该 provider 指向本地服务（例如 ollama、lmstudio、vllm 等），此路径同样是本地推理，不产生任何外部请求
- **模型的选择顺序**：先取 `options.model.hostedModel` 指定的模型；未指定时沿用 OpenCode 当前的默认模型（agent 或会话选中的模型）
- **请求形式**：抽取提示词中附带 `save_memory` 的 JSON 定义，模型返回的 JSON 由 mem-plus 解析，兼容裸 JSON、代码块包裹与工具调用信封三种形态
- **验证方式**：启动日志会记录本次生效的抽取来源与模型

可用 `opencode models` 查询可用的模型 id。`options.model.hostedModel` 的格式为 `"providerID/modelID"`，按第一个斜杠分隔，`openrouter/anthropic/claude-sonnet-4` 这类包含斜杠的 id 可正确解析；provider 与模型须为 OpenCode 中已配置可用者。

```
[mem-plus] extraction model = opencode (options.model.content = "opencode") -- metered, by request (model = anthropic/claude-sonnet-4-5)
```

### 嵌入模型

嵌入模型仅用于语义检索（`mode: "hybrid"` / `"vector"` 与 `memory_reindex {"embed": true}`），始终在本机运行：

| 情况 | 结果 |
|---|---|
| 未放置嵌入模型 | 语义检索不可用；快照、抽取、全文检索均正常。日志记录向量通道已关闭 |
| `options.model.embed: false` | 停用嵌入槽位，行为同上 |
| 显式设置 `options.model.embedPath` 但文件不存在 | 日志明确报错（属配置错误，不静默降级） |
| 更换嵌入模型 | 须执行 `memory_reindex {"embed": true}` 重新计算向量；新旧向量混用会导致语义检索结果错误 |

### 本地推理的降级行为

默认全程本地运行。本地推理不可用时（模型缺失、依赖未安装、端口被占用、服务异常、GPU 不可用），插件不会静默改用 OpenCode 端模型：会话快照继续写入，抽取延后执行且待处理记录保留；每个完成 turn 先探测本地服务，可用时执行抽取，不可用时跳过该轮，服务恢复后的下一个 turn 自动补做。

需要改用 OpenCode 端模型时，须显式设置 `model.allowHostedFallback: true`（仅本地失败时改用）或 `model.content: "opencode"`（始终由 OpenCode 侧完成抽取）。

## 数据位置

项目目录内不写入任何文件。所有数据集中存放于 `~/.config/opencode/mem-plus/`：

```
~/.config/opencode/mem-plus/
├── workspace/                       # 全局记忆目录
│   ├── MEMORY.md                    # 长期记忆（全局，由睡眠整理每日汇入）
│   ├── DREAMS.md                    # 睡眠整理日志（供人工审阅，不进入检索索引）
│   └── memory/
│       └── <项目名>--<哈希>/         # 按项目分子目录（项目仅为标签，非独立数据库）
│           ├── 2026-10-04.md         # 当日抽取条目
│           └── 2026-10-04-修复登录.md # 会话快照
├── wiki/                            # 文档语料（markdown 页面）
│   └── sources/                     # memory_wiki_import 写入的页面
├── models/                          # GGUF 模型
├── index.db                         # 检索索引（可删除，通过 memory_reindex 重建）
├── mem-plus.log                     # 日志
└── dreaming/last-day                # 睡眠整理标记（全局单个）
```

markdown 文件为唯一数据源，索引为可再生数据。删除 `index.db` 不会造成记忆丢失。

## 记忆如何被使用

### 提示词注入

每轮对话开始前，项目根目录下的下列文件被读入系统提示词，其后追加全局记忆目录根部的 `MEMORY.md`。文件缺失时自动跳过，内容修改后下一轮生效。

| 文件 | 作用 |
|---|---|
| `AGENTS.md` | 项目协作约定：工作规则、代码风格、偏好 |
| `SOUL.md` | 人设：agent 的性格、价值观与行为准则 |
| `IDENTITY.md` | 身份：名字、角色、自称与语气 |
| `USER.md` | 用户画像：称呼、偏好、背景信息 |
| `BOOTSTRAP.md` | 启动引导说明 |

在上述文件中写入内容即定义 agent 的性格、身份与协作规则。`MEMORY.md` 为所有项目共用，由睡眠整理每日汇入。

### 睡眠整理

每个日历日的首个完成 turn 触发（全局门控，所有项目每日合计一次），将当日条目汇总写入 `MEMORY.md` 与 `DREAMS.md`。删除标记文件 `~/.config/opencode/mem-plus/dreaming/last-day` 可在下一轮强制重新执行。

## 故障排查

排查前先查看日志 `~/.config/opencode/mem-plus/mem-plus.log`。

| 现象 | 原因与处理 |
|---|---|
| 工具列表中 `memory_search` 等出现两次，日志中有两条 `plugin loaded`，同一轮对话生成两份快照 | 自动发现与 `opencode.jsonc` 条目指向同一目录，插件被加载两次。二者只保留一种，见[选择一种加载方式](#3-选择一种加载方式) |
| 日志无 `plugin loaded` | 核对 `opencode.jsonc` 中 `package` 是否指向 `mem-plus` 目录（含 `package.json` 与 `index.ts`）、是否为绝对路径、Windows 下是否使用正斜杠，随后重启 OpenCode |
| 模块解析失败 | 模块别名未生成。执行 `node "<插件目录>/plugin/scripts/link-openclaw-alias.mjs"` 后重启 |
| `index unavailable (no node:sqlite ...)` | Node.js 低于 22.5。升级后检索工具方可注册，快照与抽取不受影响 |
| `extraction DISABLED (GGUF not found)` | 抽取模型未放置于模型目录。快照与全文检索不受影响，抽取延后至模型就位 |
| `no embedding model at ... vector search off` | 未放置嵌入模型。属正常降级，仅语义检索不可用 |
| `missing ... (model.embedPath) -- vector search stays off` | `model.embedPath` 指向的文件不存在。修正路径，或删除该项以恢复静默降级 |
| `service did not become healthy ... within 30s` | 服务未启动。可手动启动并查看日志：`node "<插件目录>/plugin/serve/server.mjs" --port 4748` |
| `gpu backend unavailable; service will not start` | 无可用 GPU。服务不启动，抽取延后；出现可用 GPU 后自动恢复 |
| 抽取结果为空（`summary=0 chars`） | 抽取模型为 Instruct 或 Chat 风格，须改用 base 模型 |
| `Index: 0 documents` | 执行 `memory_reindex` |
| `hybrid` / `vector` 返回 0 条 | 执行 `memory_reindex {"embed": true}` 并等待完成 |
| 导入后检索不到文档 | `memory_search` 默认仅检索会话记忆，须指定 `corpus: "wiki"` 或 `"all"` |
| `workspace/memory/` 下无当日文件 | 需完成一次完整对话 turn，写入在结算后约 2 秒发生 |

## 更新

插件不包含自动更新。更新方式为下载新版本安装包并覆盖安装：

```bash
npm i "<新版本 tgz 的完整路径>"    # 覆盖安装，依赖自动更新
opencode service restart           # 重启后生效
```

覆盖安装会替换插件目录内的全部文件，模块别名与桩包随安装自动重新生成。推理服务为独立进程，其中仍运行旧版本代码，必须重启 OpenCode 才会生效。记忆、索引与日志位于 `~/.config/opencode/mem-plus/`，不在插件目录内，覆盖安装不会影响它们。各版本号与安装包可在 Releases 页面查看。

## 卸载

按以下顺序执行：

1. 停止服务：

   ```bash
   opencode service stop
   ```

2. 删除数据目录（含全局记忆目录、文档语料、模型、索引、日志）：

   ```bash
   rm -rf ~/.config/opencode/mem-plus
   ```

   ```powershell
   # Windows
   Remove-Item -Recurse -Force "$env:USERPROFILE\.config\opencode\mem-plus"
   ```

   需保留记忆时，请先备份其中的 `workspace/` 目录。

3. 删除插件目录（第 2 步 `npm i` 时所在目录下的 `mem-plus`）：

   ```bash
   rm -rf <npm i 时的目录>/node_modules/mem-plus
   ```

   ```powershell
   # Windows
   Remove-Item -Recurse -Force "<npm i 时的目录>\node_modules\mem-plus"
   ```

4. 删除 `opencode.jsonc` 中对应的 `plugins` 条目。

5. 执行 `opencode service restart`。

## 许可证

本仓库采用 MIT 许可。其中包含的第三方代码：

| 来源 | 范围 | 许可 | 版权 |
|---|---|---|---|
| [openclaw](https://github.com/openclaw/openclaw) | `src/`、`extensions/`、`packages/` 下记忆相关模块的副本 | MIT | Copyright (c) 2026 OpenClaw Foundation |
| [opencode-mem](https://github.com/tickernelz/opencode-mem) | Web 管理界面布局（计划并入） | MIT | Copyright (c) 2025 Zhafron Adani Kautsar |

各来源的完整许可文本见 [LICENSE](./LICENSE) 与 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。