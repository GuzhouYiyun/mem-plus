<div align="center">

# mem-plus

</div>

mem-plus 是 OpenCode 的持久记忆插件。记忆内容跨会话、跨项目保留；每个自然日首次完成的对话结束后，当日内容汇总为长期记忆。

全部记忆以本地 markdown 文件形式存放，可直接查看、修改、删除。检索索引由这些文件生成，删除索引不影响记忆本身。

- 每轮对话结束约 2 秒后，该轮原文归档为 `memory/<项目名>--<哈希>/<日期>-<标题>.md`
- 每轮对话结束约 2 秒后，该轮内容提炼为结构化条目，追加至 `memory/<项目名>--<哈希>/<日期>.md`
- 每个自然日首次完成的对话结束后，当日条目汇总写入 `MEMORY.md`（长期记忆）与 `DREAMS.md`（洞察日志）
- `AGENTS.md`、`MEMORY.md` 等工作区文件在每轮对话开始前注入系统提示词
- 记忆浏览器 `http://127.0.0.1:4747`：读写注入文件、查看梦境日记、编辑设置、重建向量索引

## 目录

- [运行要求](#运行要求)
- [安装](#安装)
- [配置](#配置)
- [模型](#模型)
- [日常使用](#日常使用)
- [数据位置](#数据位置)
- [故障排查](#故障排查)
- [更新](#更新)
- [卸载](#卸载)
- [许可证](#许可证)

## 运行要求

| 项目 | 要求 |
|---|---|
| OpenCode | V2，`@opencode/plugin` 2.0.20 及以上。不支持 V1。`opencode --version` 查看 |
| GPU | 本机的向量模型需要显卡；条目抽取使用 OpenCode 侧模型 |
| 磁盘 | 压缩包约 4.3 MB；向量模型约 1.2 GB |

抽取默认使用 OpenCode 侧的模型，无需 API key、provider 或 endpoint，认证与计费由 OpenCode 负责。

## 安装

### 下载

在 [Releases](https://github.com/GuzhouYiyun/mem-plus/releases) 页面下载：

| 文件 | 适用 |
|---|---|
| `mem-plus-installer-<版本号>.exe` | Windows x64。双击安装，无需命令行 |
| `mem-plus-<版本号>.tgz` | 任意系统。手动安装，见下文 |

### 用安装器安装（Windows）

双击 `.exe`，按提示完成。安装位置默认取 OpenCode 实际扫描的插件目录，通常无需修改。

安装器不包含向量模型，见[向量模型](#向量模型)。

### 用压缩包安装（任意系统）

先停止正在运行的 OpenCode 服务，否则它会在依赖装完之前就开始加载插件。

```bash
opencode service stop
```

再解压并安装依赖：

```bash
tar -xzf 此处用文件名替换 -C ~/.config/opencode/plugins
cd ~/.config/opencode/plugins/mem-plus
npm install
```

或

```powershell
# Windows
tar -xzf 此处用文件名替换 -C "$env:USERPROFILE\.config\opencode\plugins"
Set-Location "$env:USERPROFILE\.config\opencode\plugins\mem-plus"
npm install
```

### 向量模型

安装器不包含向量模型，需自行下载并放置。下载地址、格式与后端要求见[模型](#模型)。

放置位置：

```bash
mkdir -p ~/.config/opencode/mem-plus/models
```

```powershell
# Windows
New-Item -ItemType Directory -Force "$env:USERPROFILE\.config\opencode\mem-plus\models"
```

未放置向量模型时，`memory_search` 使用关键词检索，会话快照、条目抽取与记忆注入均不受影响。

### 验证

```bash
opencode service restart
```

日志位于 `~/.config/opencode/mem-plus/mem-plus.log`，其中 `plugin loaded` 一行表示插件已加载。访问 `http://127.0.0.1:4747`，页面正常显示即安装完成。其它情况见[故障排查](#故障排查)。

在任意项目内向 agent 提出一个具体任务（例如「创建 test-memplus.txt，内容为 hello 并读取确认」），完成一轮对话后，全局记忆目录下应出现当日文件。该写入发生在对话结算约 2 秒后。

## 配置

| 键 | 默认值 | 说明 |
|---|---|---|
| `model.*` | — | 模型相关配置项，见[模型](#模型) |
| `service.port` | `4748` | 推理服务起始端口，被占用时递增 |
| `service.idleMinutes` | `10` | 推理服务空闲退出时间，`0` 为不退出 |
| `web.port` | `4747` | 记忆浏览器端口，被占用时递增 |
| `wiki.dir` | `~/.config/opencode/mem-plus/wiki` | 文档语料目录，递归读取其中的 markdown |
| `wiki.enabled` | `true` | `false` 时文档语料不进入索引，`memory_wiki_import` 不再注册 |

本文件中的未知键被忽略，不产生报错，键名拼写错误亦无提示。修改后以启动日志为准核对。

## 模型

mem-plus 用模型做两件事，各用一个模型。

| 用途 | 由谁执行 |
|---|---|
| 条目抽取、整合、dreaming | OpenCode 侧的模型 |
| 向量检索（`memory_search` 的 `hybrid` 与 `vector` 模式） | 本机的 embedding 模型 |

两者互不依赖：缺少 embedding 模型只是检索退化为关键词匹配，其余功能不受影响。

### 抽取：用 OpenCode 侧的模型

条目抽取直接使用你在 OpenCode 里配置好的模型，**不需要任何本地模型文件**。推理位置由 OpenCode 的 provider 决定。

可用 `model.hostedModel` 指定模型，格式 `providerID/modelID`，可用 `opencode models` 查询可用值。未指定时沿用 OpenCode 当前的默认模型。若该 provider 指向本机服务（ollama、lmstudio、vllm 等），同样不出本机。

### 文件位置

向量模型默认目录为 `~/.config/opencode/mem-plus/models/`。插件目录下若存在 `models/`，优先使用该目录；默认目录不存在时使用上述路径，且该目录需自行创建。

默认文件名为 `bge-m3-FP16.gguf`。文件名或位置不同时用 `model.embedPath` 指定；`model.dir` 可整体指定模型目录。

模型文件不包含在安装包内，需另行下载。

### 下载

| 文件 | 用途 | 大小 | 国内（ModelScope） | 海外（Hugging Face） |
|---|---|---|---|---|
| `bge-m3-FP16.gguf` | 向量检索 | 约 1.2 GB | [下载](https://modelscope.cn/models/gpustack/bge-m3-GGUF/resolve/main/bge-m3-FP16.gguf) | [下载](https://huggingface.co/gpustack/bge-m3-GGUF/resolve/main/bge-m3-FP16.gguf) |

### 格式要求

| 用途 | 要求 | 不满足时的表现 |
|---|---|---|
| 向量检索 | 带 embedding 头的模型 | 无法生成向量，语义检索不可用 |

### GPU 后端

向量模型要求显卡，**不使用 CPU 推理**。无可用 GPU 时推理服务拒绝启动，日志记录 `gpu backend unavailable; service will not start`。

| `model.gpu` | 含义 | 适用 |
|---|---|---|
| `auto`（默认） | 独显优先，核显次之 | 通用。AMD 与 Intel 的独显必须用此项 |
| `discrete` | 仅 NVIDIA·Apple 独显后端 | 确认本机为 NVIDIA 或 Apple 独显 |
| `integrated` | vulkan 后端 | 核显 |

AMD 与 Intel 的独显经 vulkan 运行，取 `discrete` 会漏掉，因此统一使用 `auto`。

`model.gpuLayers` 控制分配至显存的层数，`"auto"` 按当前显存计算，亦可填 0–999 的整数。

### 缺失与失败时的行为

| 情况 | 行为 |
|---|---|
| 未放置向量模型，或 `model.embed` 为 `false` | 语义检索不可用，日志记录 `no embedding model at ... vector search off`。会话快照、条目抽取、全文检索均正常 |
| `model.embedPath` 指向的文件不存在 | 日志明确报错，属配置错误，不静默降级 |

### 更换模型

更换向量模型后必须重建向量索引，新旧向量混用会导致语义检索结果错误：

```jsonc
memory_reindex { "embed": true }
```

该命令为幂等操作，可重复执行。记忆浏览器的「设置」页提供「重建并嵌入」按钮，功能等价。

### 模型选项

| 键 | 默认值 | 说明 |
|---|---|---|
| `model.hostedModel` | — | 指定 OpenCode 侧使用的模型，格式 `providerID/modelID` |
| `model.dir` | 插件目录下 `models/`，不存在时回落 `~/.config/opencode/mem-plus/models` | GGUF 文件所在目录 |
| `model.embedPath` | `<模型目录>/bge-m3-FP16.gguf` | 向量模型文件路径 |
| `model.embed` | `true` | `false` 时停用向量检索，仅使用全文检索 |
| `model.gpu` | `"auto"` | GPU 后端：`auto` / `discrete` / `integrated` |
| `model.gpuLayers` | `"auto"` | 分配至显存的层数，`"auto"` 按当前显存计算 |
| `model.contextSize` | `16384` | 抽取上下文窗口 |
| `model.maxNewTokens` | `512` | 单次抽取的最大 token 数 |
| `model.threads` | `0` | 宿主侧运算使用的 CPU 线程数，`0` 为运行时决定 |
| `model.logLevel` | `"warn"` | 本地推理日志级别：`silent` / `warn` / `info` / `debug` |

## 日常使用

### 内容记录方式

以下过程无需手工操作：

| 过程 | 触发时机 | 结果 |
|---|---|---|
| 会话快照 | 每轮对话结束约 2 秒后 | 该轮原文写入 `memory/<项目名>--<哈希>/<日期>-<标题>.md` |
| 条目抽取 | 每轮对话结束，模型可用时 | 结构化条目追加至 `memory/<项目名>--<哈希>/<日期>.md` |
| 索引更新 | 文件写入完成后 | 新内容登记进索引，可立即检索 |
| 睡眠整理 | 每个自然日首个完成的对话 | 当日条目汇总写入 `MEMORY.md` 与 `DREAMS.md` |
| 提示词注入 | 每轮对话开始前 | 工作区文件与全局长期记忆注入系统提示词 |

会话快照不依赖模型，任何情况下均会写入。条目抽取依赖模型，模型不可用时延后处理，恢复后自动补做。

### 工具

以下为插件注册给 agent 的工具，**不是终端命令**。在 OpenCode 对话框中以普通消息发送工具名与参数，agent 收到后调用；其自行判断需要时也会调用。

| 工具 | 功能 |
|---|---|
| `memory_search` | 检索记忆与文档 |
| `memory_get` | 按 id 读取完整条目 |
| `memory_reindex` | 重建检索索引，可同时补齐向量 |
| `memory_wiki_import` | 将 ChatGPT 导出导入文档语料 |

`memory_search` 参数：

| 参数 | 取值 | 说明 |
|---|---|---|
| `query` | 字符串 | 必填。输入关键词，不要输入指令句 |
| `mode` | `text`（默认）/ `hybrid` / `vector` | 全文 / 全文加向量 / 仅向量。后两者需已放置向量模型 |
| `scope` | `project`（默认）/ `all` | 当前项目加全局长期记忆 / 全部项目 |
| `corpus` | `memory`（默认）/ `wiki` / `all` | 会话记忆 / 文档语料 / 两者 |
| `kind` | `entry` / `turn` / `memory` / `wiki` | 抽取条目 / 会话轮次 / 长期记忆 / 文档分节 |
| `tag`、`type`、`since`、`until`、`project`、`limit` | — | 按标签、类型、日期区间、项目筛选。`since` 与 `until` 取 `YYYY-MM-DD` |

全文检索为 AND 语义，查询中的全部关键词均需命中。建议先用具体关键词，未命中时减少词数。

```jsonc
// 检索 postgres 连接池相关记忆
{ "query": "postgres 连接池" }

// 指定模式与语料
{ "query": "部署时数据库连不上", "mode": "hybrid", "corpus": "all" }
```

### 重建索引

索引由记忆文件生成，删除不导致记忆丢失。以下情况需手动重建：索引损坏、存在安装前已有的记忆文件、更换向量模型后需重新计算向量、导入文档语料后希望立即可检索。

```jsonc
memory_reindex                      // 仅重建索引
memory_reindex { "embed": true }    // 同时补齐向量
```

两条命令均为幂等操作。记忆浏览器的「设置」页提供「重建并嵌入」，功能等价于第二条。

### 记忆浏览器

监听本机，地址 `http://127.0.0.1:4747`。与 agent 无关，仅供人工查看与编辑。

| 标签页 | 内容 | 写入 |
|---|---|---|
| 提示词文件 | `AGENTS.md`、`SOUL.md`、`IDENTITY.md`、`USER.md`、`BOOTSTRAP.md`、`MEMORY.md` | 前五个为当前工作目录内的文件；`MEMORY.md` 为全局记忆目录文件，所有项目共用 |
| 梦境日记 | `DREAMS.md`，按日记条目分条显示 | 只读 |
| 设置 | 配置项见[配置](#配置)，模型相关项见[模型](#模型) | 写入 `config.jsonc` |

文件类标签页修改后下一轮对话生效，无需重启。设置页修改后需重启。

### 提示词注入

每轮对话开始前，项目根目录下的下列文件读入系统提示词，其后追加全局记忆目录根部的 `MEMORY.md`。文件缺失时跳过，内容修改后下一轮生效。

| 文件 | 用途 |
|---|---|
| `AGENTS.md` | 项目协作约定：工作规则、代码风格、偏好 |
| `SOUL.md` | 人设：性格、价值观与行为准则 |
| `IDENTITY.md` | 身份：名字、角色、自称与语气 |
| `USER.md` | 用户画像：称呼、偏好、背景 |
| `BOOTSTRAP.md` | 启动引导说明 |

### 睡眠整理

每个自然日首个完成的对话触发，全局门控，所有项目每日合计一次。当日条目汇总写入 `MEMORY.md` 与 `DREAMS.md`。删除标记文件 `~/.config/opencode/mem-plus/dreaming/last-day` 可在下一轮强制重新执行。

### 文档语料

默认目录 `~/.config/opencode/mem-plus/wiki/`，存放 markdown 页面，支持笔记、导出文档、Obsidian 仓库。文档与记忆共用同一索引，以 `corpus: "wiki"` 单独检索。

导入 ChatGPT 对话记录：解压导出的压缩包，取得含 `conversations.json` 的目录后执行 `memory_wiki_import`。

```jsonc
{ "path": "<解压后的目录>", "dryRun": true }   // 预检
{ "path": "<解压后的目录>" }                    // 执行
```

每个会话生成一个页面，仅保留活跃分支。对同一份导出重复执行不产生重复页面。

## 数据位置

项目目录内不写入文件。全部数据位于 `~/.config/opencode/mem-plus/`：

```
~/.config/opencode/mem-plus/
├── workspace/                       # 全局记忆目录
│   ├── MEMORY.md                    # 长期记忆（睡眠整理每日汇入）
│   ├── DREAMS.md                    # 睡眠整理日志（供人工审阅，不进索引）
│   └── memory/
│       └── <项目名>--<哈希>/
│           ├── 2026-10-04.md         # 当日抽取条目
│           └── 2026-10-04-修复登录.md # 会话快照
├── wiki/                            # 文档语料
├── models/                          # GGUF 模型
├── config.jsonc                     # 配置
├── index.db                         # 检索索引（可删除，通过 memory_reindex 重建）
├── mem-plus.log                     # 日志
└── dreaming/last-day                # 睡眠整理标记
```

markdown 文件为唯一数据源，索引为可再生数据。

## 故障排查

先查看日志 `~/.config/opencode/mem-plus/mem-plus.log`。

| 现象 | 原因与处理 |
|---|---|
| 工具重复注册，日志出现两条 `plugin loaded`，同一轮对话两份快照 | 自动发现与 `opencode.jsonc` 指向同一目录，插件加载两次。保留一种 |
| 日志无 `plugin loaded` | 核对安装路径是否指向含 `package.json` 与 `index.ts` 的目录、是否为绝对路径、Windows 下是否使用正斜杠，然后重启 |
| 有 `plugin loaded` 但无 `retrieval tools ready` | 检索工具注册失败，`memory_search` 等不可用。检查日志中紧随其后的错误 |
| 浏览器打不开默认端口 | 端口被占用时自动递增，实际端口以日志中 `memory browser at` 一行为准 |
| 模块解析失败 | 运行时模块别名未生成。执行 `node "<插件目录>/plugin/scripts/link-openclaw-alias.mjs"` 后重启 |
| `index unavailable (no node:sqlite ...)` | Node.js 低于 22.5，检索工具不注册。会话快照与条目抽取不受影响 |
| `no embedding model at ... vector search off` | 未放置向量模型，或路径不正确。仅语义检索不可用 |
| `missing ... (model.embedPath) -- vector search stays off` | `model.embedPath` 指向的文件不存在。修正路径，或删除该项 |
| `hybrid` / `vector` 返回 0 条 | 执行 `memory_reindex {"embed": true }` 并等待完成 |
| 导入后检索不到文档 | `memory_search` 默认仅检索会话记忆，需指定 `corpus: "wiki"` 或 `"all"` |
| `workspace/memory/` 下无当日文件 | 需完成一次完整对话轮次，写入在结算约 2 秒后发生 |
| 记忆浏览器无法访问，或显示其他项目的记忆 | 端口先到先得，实际端口见日志 `memory browser at` 一行。多个 OpenCode 窗口仅一个能占用 |
| `service did not become healthy ... within 30s` | 推理服务未启动。可手动启动查看日志：`node "<插件目录>/plugin/serve/server.mjs" --port 4748` |
| `gpu backend unavailable; service will not start` | 无可用 GPU，推理服务不启动。出现可用 GPU 后自动恢复 |
| `推理依赖未安装：找不到 node-llama-cpp` | 推理依赖缺失，推理服务不启动，与显卡无关。重新运行安装器即可补上；未安装时全文检索不受影响，向量检索不可用 |

## 更新

无自动更新。更新方式为下载新版本压缩包后覆盖安装。与安装同理，先停止服务再覆盖文件：

```bash
opencode service stop                    # 覆盖期间服务若在运行，会加载到半旧半新的插件
npm i "<新版本 tgz 的完整路径>"    # 覆盖安装，依赖自动更新
opencode service restart           # 重启后生效
```

覆盖安装会替换插件目录内的全部文件。记忆、索引与日志位于 `~/.config/opencode/mem-plus/`，不在插件目录内，不受影响。各版本号与安装包见 Releases 页面。

安装器（Windows `.exe`）每次都会安装向量检索的 GPU 运行库，不再提供勾选框（0.2.0 起取消了「本地向量检索依赖」这个可选项）。

实测体积（2026-10-12，一次真实安装）：`node-llama-cpp` 971 个文件 / **37.8 MB**。整棵依赖树 29482 个文件 / 858.3 MB，它只占其中一小部分。覆盖更新时 npm 不会重装它——`npm install --dry-run` 在已装好的树上对 `node-llama-cpp` 没有任何动作。

向量**模型**仍然需要你自己下载放置，约 2.2 GB，见上文「放置向量模型」。

> 早期版本的安装器在不勾选该项时会传入 `--omit=optional`，npm 会顺带把已安装的 `node-llama-cpp` 一并剪掉，于是更新后向量检索静默失效——日志只提示显卡不可用，与真实原因无关。现在该分支已不可达：运行库每次都装，且报错信息会直接说明是包缺失而非显卡问题。

## 卸载

### 用安装器卸载（Windows）

**Windows 设置 → 应用 → 已安装的应用 → mem-plus → 卸载。**

卸载器仅删除安装器自身写入的文件。放在插件目录内的其他文件（例如你下载的向量模型）不在删除范围内，会保留在原处。记忆数据目录不会被触碰。

### 手动卸载（压缩包安装）

```bash
opencode service stop
rm -rf ~/.config/opencode/plugins/mem-plus    # 插件目录
```

```powershell
# Windows
opencode service stop
Remove-Item -Recurse -Force "$env:USERPROFILE\.config\opencode\plugins\mem-plus"
```

记忆数据目录 `~/.config/opencode/mem-plus/` 默认保留。需要一并清除时再手动删除：

```bash
rm -rf ~/.config/opencode/mem-plus            # 数据目录（含全局记忆目录）
```

需保留记忆时，先备份该目录内的 `workspace/`。若使用了显式注册，同时删除 `opencode.jsonc` 中的 `plugins` 条目，最后执行 `opencode service restart`。

## 许可证

本仓库采用 MIT 许可。其中包含的第三方代码：

| 来源 | 范围 | 许可 | 版权 |
|---|---|---|---|
| [openclaw](https://github.com/openclaw/openclaw) | `src/`、`extensions/`、`packages/` 下记忆相关模块的副本 | MIT | Copyright (c) 2026 OpenClaw Foundation |
| [opencode-mem](https://github.com/tickernelz/opencode-mem) | 记忆浏览器的界面布局与前端框架 | MIT | Copyright (c) 2025 Zhafron Adani Kautsar |

各来源的完整许可文本见 [LICENSE](./LICENSE) 与 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。
