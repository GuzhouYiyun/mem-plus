# mem-plus — 给 OpenCode 的持久记忆

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green?style=flat-square" alt="License: MIT"></a>
  <img src="https://img.shields.io/badge/OpenCode-V2-blue?style=flat-square" alt="OpenCode V2">
  <img src="https://img.shields.io/badge/platforms-Windows%20%2F%20macOS%20%2F%20Linux-lightgrey?style=flat-square" alt="Platforms">
</p>

mem-plus 是 OpenCode 的持久记忆插件。记忆跨会话、跨项目保留：每轮对话结束后归档原文、抽取结构化条目，每个自然日首个完成的对话再把当日内容汇总为长期记忆。下一次对话开始时，这些内容自动回到系统提示词里——agent 不需要你提醒它，它自己知道之前发生过什么。

**你的记忆就是 markdown 文件。** 全部记忆以 `MEMORY.md`、`DREAMS.md` 和 `memory/<项目名>--<哈希>/<日期>-<标题>.md` 的形式落在 `~/.config/opencode/mem-plus/`，可以直接打开、修改、删除、用 git 管起来。检索索引由这些文件生成，删掉索引不会丢记忆，`memory_reindex` 就能重建。项目目录里一个文件都不写。

**出机的只有对话本身。** 条目抽取、整合与每日睡眠整理跑在你在 OpenCode 里已经配好的模型上，不额外要 API key、provider 或 endpoint，认证和计费都由 OpenCode 负责。语义检索需要本机放一个向量模型（约 1.2 GB，`bge-m3`），不装就退化成关键词检索，其余功能不受影响——它不会把记忆发给 OpenCode 之外的任何地方。

记忆浏览器在 `http://127.0.0.1:4747`：读写注入文件、看梦境日记、改设置、重建向量索引、删除某次会话产生的长期记忆。与 agent 无关，纯供人工查看。

[Releases](https://github.com/GuzhouYiyun/mem-plus/releases) · [许可证](LICENSE) · [第三方声明](THIRD_PARTY_NOTICES.md) · [移植说明](docs/port-plan.md)

## 运行要求

| 项目 | 要求 |
|---|---|
| OpenCode | V2，`@opencode/plugin` 2.0.20 及以上。不支持 V1，`opencode --version` 查看 |
| Node.js | 22.5 以上。低于此版本检索工具不注册，会话快照与条目抽取仍正常 |
| GPU | 只有语义检索需要。条目抽取用 OpenCode 侧的模型 |
| 磁盘 | 安装包约 4.5 MB；`npm install` 后的依赖树约 858 MB；向量模型约 1.2 GB（自行下载） |

## 安装

### Windows：双击安装器

在 [Releases](https://github.com/GuzhouYiyun/mem-plus/releases) 下载 `mem-plus-installer-<版本号>.exe`（x64），双击，按提示走完四页。安装位置默认取 OpenCode 实际扫描的插件目录，通常不用改；装完会自动 `opencode reload`，不用手动重启。

安装器内嵌整个包，约 20 秒完成，不需要联网或任何辅助工具。它每次都会装上向量检索需要的 GPU 运行库。

**升级就是再双击一次新版安装器。** 新版安装器会先删掉上一版写过、这一版不再携带的文件，再写新包——否则残留的旧模块会被 Node 照常加载（它并不知道 `.ts` 已经不存在了），症状是行为对不上你装的版本。你自己放在插件目录里的东西不在删除范围内，`models/` 和 `node_modules/` 也不在。

### 任意系统：压缩包

先停服务，否则它会在依赖装完之前就开始加载半旧的插件树：

```bash
opencode service stop
```

再解压并装依赖：

```bash
tar -xzf mem-plus-<版本号>.tgz -C ~/.config/opencode/plugins
cd ~/.config/opencode/plugins/mem-plus
npm install
opencode service restart
```

Windows PowerShell 把上面两行换成：

```powershell
opencode service stop
tar -xzf mem-plus-<版本号>.tgz -C "$env:USERPROFILE\.config\opencode\plugins"
Set-Location "$env:USERPROFILE\.config\opencode\plugins\mem-plus"
npm install
opencode service restart
```

装完确认一下：

```bash
opencode service restart
```

日志在 `~/.config/opencode/mem-plus/mem-plus.log`，其中 `plugin loaded` 一行表示插件已加载。浏览器 `http://127.0.0.1:4747` 能打开就是装好了。其余情况见[故障排查](#故障排查)。

想确认记忆真的在写：在任意项目里给 agent 一个具体任务（例如「创建 test-memplus.txt，内容为 hello 并读取确认」），完成一轮对话后约 2 秒，全局记忆目录下应出现当日文件。

### 向量模型（可选）

不装向量模型，`memory_search` 用关键词检索，会话快照、条目抽取、提示词注入都不受影响。

```bash
mkdir -p ~/.config/opencode/mem-plus/models
# 放入 bge-m3-Q8_0.gguf，约 635 MB
```

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.config\opencode\mem-plus\models"
```

下载地址见[模型](#模型)。放好后跑一次 `memory_reindex {"embed": true}` 建向量。

## 它是怎么工作的

下面这些过程全都自动，不需要手工操作：

- **会话快照**——每轮对话结束约 2 秒后，该轮原文写入 `memory/<项目名>--<哈希>/<日期>-<标题>.md`。不依赖模型，任何情况下都写。
- **条目抽取**——每轮对话结束后，模型把该轮内容提炼成结构化条目，追加进 `memory/<项目名>--<哈希>/<日期>.md`。依赖模型，模型不可用时延后，恢复后自动补做。
- **索引更新**——文件写完即登记进索引，可以立刻检索到。
- **睡眠整理**——每个自然日首个完成的对话触发，把当日条目汇总写进 `MEMORY.md`（长期记忆）与 `DREAMS.md`（洞察日志）。全局门控，所有项目每日合计一次。
- **提示词注入**——每轮对话开始前，工作区文件与 `MEMORY.md` 进入系统提示词。
- **记忆浏览器**——本机 HTTP 服务，人工查看与编辑，与 agent 无关。

## 文档

| 目标 | 从这里开始 |
|---|---|
| 装上并确认能用 | [安装](#安装) · [故障排查](#故障排查) |
| 改配置 | [配置](#配置) |
| 开语义检索 | [模型](#模型) · `bge-m3-Q8_0.gguf` 约 635 MB |
| 了解 agent 能调什么 | [工具](#工具) |
| 让人工能读能改 | [记忆浏览器](#记忆浏览器) |
| 导入自己的文档 | [文档语料](#文档语料) |
| 知道数据在哪、怎么备份 | [数据位置](#数据位置) |
| 换版本 | [更新](#更新) · [卸载](#卸载) |
| 知道这些代码从哪来 | [许可证](#许可证) · [移植说明](docs/port-plan.md) |

## 配置

配置文件 `~/.config/opencode/mem-plus/config.jsonc`：

| 键 | 默认值 | 说明 |
|---|---|---|
| `model.*` | — | 模型相关，见[模型](#模型) |
| `service.port` | `4748` | 推理服务起始端口，被占用时递增 |
| `service.idleMinutes` | `10` | 推理服务空闲退出时间，`0` 为不退出 |
| `web.port` | `4747` | 记忆浏览器端口，被占用时递增 |
| `wiki.dir` | `~/.config/opencode/mem-plus/wiki` | 文档语料目录，递归读取其中的 markdown |
| `wiki.enabled` | `true` | `false` 时文档语料不进入索引，`memory_wiki_import` 不再注册 |

未知键被忽略，不报错，键名拼错也没有提示。改完以启动日志为准核对。

## 模型

两件事各用一个模型，互不依赖：

| 用途 | 由谁执行 |
|---|---|
| 条目抽取、整合、睡眠整理 | OpenCode 侧的模型 |
| 向量检索（`memory_search` 的 `hybrid` 与 `vector`） | 本机的 embedding 模型 |

缺 embedding 模型只是检索退化为关键词匹配。

### 抽取：用 OpenCode 侧的模型

直接用你在 OpenCode 里配好的模型，**不需要任何本地模型文件**，推理位置由 OpenCode 的 provider 决定。若该 provider 指向本机服务（ollama、lmstudio、vllm 等），同样不出本机。

`model.hostedModel` 可指定模型，格式 `providerID/modelID`，可用 `opencode models` 查询。不指定则沿用 OpenCode 当前的默认模型。

### 向量模型：文件与后端

默认目录 `~/.config/opencode/mem-plus/models/`。插件目录下若存在 `models/` 则优先用它。默认文件名 `bge-m3-Q8_0.gguf`；名字或位置不同用 `model.embedPath` 指定，`model.dir` 可整体指定目录。**模型不包含在安装包内，需自行下载。**

| 文件 | 用途 | 大小 | 国内（ModelScope） | 海外（Hugging Face） |
|---|---|---|---|---|
| `bge-m3-Q8_0.gguf` | 向量检索 | 约 635 MB | [下载](https://modelscope.cn/models/gpustack/bge-m3-GGUF/resolve/main/bge-m3-Q8_0.gguf) | [下载](https://huggingface.co/gpustack/bge-m3-GGUF/resolve/main/bge-m3-Q8_0.gguf) |

模型文件更新后（换了文件、换了位置、或换了别的模型），要执行一次
「重建并嵌入」——向量按当时的文件整套重算，不与之前的文件混用。

必须是带 embedding 头的模型，否则生成不出向量。**要求显卡，不使用 CPU 推理**：无可用 GPU 时推理服务拒绝启动，日志记录 `gpu backend unavailable; service will not start`。AMD 与 Intel 的独显走 vulkan，`model.gpu` 保持 `auto` 即可，取 `discrete` 会漏掉它们。

| 情况 | 行为 |
|---|---|
| 未放置向量模型，或 `model.embed` 为 `false` | 日志记录 `no embedding model at ... vector search off`。快照、抽取、全文检索均正常 |
| `model.embedPath` 指向的文件不存在 | 日志明确报错，属配置错误，不静默降级 |

**换模型后必须重建向量索引**，新旧向量混用会让语义检索给出错误结果：

```jsonc
memory_reindex { "embed": true }
```

幂等，可重复执行。浏览器「设置」页的「重建并嵌入」功能等价。

### 模型选项

| 键 | 默认值 | 说明 |
|---|---|---|
| `model.hostedModel` | — | OpenCode 侧使用的模型，格式 `providerID/modelID` |
| `model.dir` | 插件目录下 `models/`，不存在时回落 `~/.config/opencode/mem-plus/models` | GGUF 所在目录 |
| `model.embedPath` | `<模型目录>/bge-m3-Q8_0.gguf` | 向量模型文件路径 |
| `model.embed` | `true` | `false` 时只用全文检索 |
| `model.gpu` | `"auto"` | GPU 后端：`auto` / `discrete` / `integrated` |
| `model.gpuLayers` | `"auto"` | 分配至显存的层数，`"auto"` 按当前显存计算，也可填 0–999 |
| `model.vramPadding` | 引擎默认 | 额外预留的显存（GB），0–64。显卡同时跑游戏等程序时调大，防止向量模型把显存挤爆 |
| `model.threads` | `0` | 宿主侧运算的 CPU 线程数，`0` 为运行时决定 |
| `model.logLevel` | `"warn"` | 本地推理日志：`silent` / `warn` / `info` / `debug` |

## 工具

插件注册给 agent 的四个工具，**不是终端命令**。在对话框里当普通消息发工具名和参数，agent 收到后调用，判断需要时也会自己调。

| 工具 | 功能 |
|---|---|
| `memory_search` | 检索记忆与文档 |
| `memory_get` | 按 `memory_search` 返回的 `path` 读取完整条目 |
| `memory_reindex` | 重建检索索引，可同时补齐向量 |
| `memory_wiki_import` | 把 ChatGPT 导出导入文档语料 |

### memory_search

| 参数 | 取值 | 说明 |
|---|---|---|
| `query` | 字符串 | **必填**。输入你记得的词，不要写指令句 |
| `mode` | `text`（默认）/ `hybrid` / `vector` | 全文 / 关键词加语义 / 仅语义。后两者需已放向量模型 |
| `scope` | `project`（默认）/ `all` | 本项目加全局长期记忆 / 全部项目 |
| `corpus` | `memory`（默认）/ `wiki` / `all` | 会话记忆 / 文档语料 / 两者 |
| `kind` | `entry` / `turn` / `memory` / `wiki` | 抽取条目 / 会话轮次 / 长期记忆 / 文档分节。不填为全部 |
| `type` | `feature` / `bug-fix` / `configuration` / `refactor` / `research` / `decision` / `other` | 按捕获类型筛 |
| `tag`、`project` | 字符串 | 按标签（精确匹配）或项目 slug 筛，如 `my-app--4f2a1c` |
| `since`、`until` | `YYYY-MM-DD` | 日期区间 |
| `maxResults` | 1–25，默认 `8` | 返回条数上限 |
| `minScore` | 数字 | 丢掉低于此分数的结果。不填则用索引自带的阈值 |
| `limit` | — | `maxResults` 的已弃用别名，新代码请用 `maxResults` |

全文检索是 AND 语义，查询里每个词都要命中。建议先用具体的词，没命中再减词。

```jsonc
// 找 postgres 连接池相关的记忆
{ "query": "postgres 连接池" }

// 跨语料，并且关键词加语义
{ "query": "部署时数据库连不上", "mode": "hybrid", "corpus": "all" }
```

### 重建索引

索引由记忆文件生成，删了不丢记忆。以下情况要手动重建：索引损坏、安装前就已经有记忆文件、换了向量模型、导入文档语料后想立刻能搜。

```jsonc
memory_reindex                      // 仅重建索引
memory_reindex { "embed": true }    // 同时补齐向量
```

两条都幂等。浏览器「设置」页的「重建并嵌入」等价于第二条。

## 记忆浏览器

监听本机 `http://127.0.0.1:4747`，端口被占用时递增，实际端口以日志里 `memory browser at` 一行为准。多个 OpenCode 窗口只有一个能占用。

| 标签页 | 内容 | 写入 |
|---|---|---|
| 提示词文件 | `AGENTS.md`、`SOUL.md`、`IDENTITY.md`、`USER.md`、`BOOTSTRAP.md`、`MEMORY.md` | 前五个在当前工作目录里，`MEMORY.md` 在全局记忆目录，所有项目共用 |
| 梦境日记 | `DREAMS.md`，按日记条目分条显示 | 只读 |
| 设置 | 见[配置](#配置)与[模型](#模型) | 写入 `config.jsonc` |

文件类标签页改完下一轮对话生效，不用重启；设置页改完要重启。

### 删除长期记忆

设置页里有一行「忘记」，填**会话标识**，先预览再确认执行——两步之间不缓存任何东西，执行时服务端会重新读一遍文件并做哈希校验，所以预览时看到的数字如果和执行时对不上，说明这期间有改动，以执行那次的为准。默认只预览，不改任何文件。

判据是会话标识，跟上游一致：血缘表记录每条长期记忆由哪个会话产生，forget 靠它反查。**没有血缘记录的条目删不掉**——它们会列进「无法定位」，因为无法确定归属。这是上游同款限制。

它删的是长期记忆条目本身、相关血缘行，以及这些条目在检索索引里的行。**会话快照不删**（`memory/<项目>/<日期>-<标题>.md` 那些文件原样留着）——上游那条扫描语料的分支本树没有移植，相关计数恒为 0，详见[移植说明](docs/port-plan.md)。

不做成工具是刻意的：这是不可逆地改写你的记忆文件，属于人做一个明确决定，不是 agent 自己决定要忘掉什么。`memory_reindex` 有工具是因为重建索引不丢东西，这个会。

## 提示词注入

每轮对话开始前，项目根目录下的下列文件读进系统提示词，其后追加全局记忆目录根部的 `MEMORY.md`。文件缺失就跳过，改完下一轮生效。

| 文件 | 用途 |
|---|---|
| `AGENTS.md` | 项目协作约定：工作规则、代码风格、偏好 |
| `SOUL.md` | 人设：性格、价值观与行为准则 |
| `IDENTITY.md` | 身份：名字、角色、自称与语气 |
| `USER.md` | 用户画像：称呼、偏好、背景 |
| `BOOTSTRAP.md` | 启动引导说明 |

## 睡眠整理

每个自然日首个完成的对话触发，全局门控，所有项目每日合计一次。当日条目汇总写进 `MEMORY.md` 与 `DREAMS.md`。删掉标记文件 `~/.config/opencode/mem-plus/dreaming/last-day` 可以在下一轮强制重跑。

## 文档语料

默认目录 `~/.config/opencode/mem-plus/wiki/`，放 markdown 页面——笔记、导出文档、Obsidian 仓库都行。文档与记忆共用同一个索引，用 `corpus: "wiki"` 或 `"all"` 单独检索。

导入 ChatGPT 对话记录：解压导出包，拿到含 `conversations.json` 的目录后执行 `memory_wiki_import`。

```jsonc
{ "path": "<解压后的目录>", "dryRun": true }   // 预检
{ "path": "<解压后的目录>" }                    // 执行
```

每个会话生成一个页面，只保留活跃分支；对同一份导出重复执行不会产生重复页面。

## 数据位置

项目目录里不写文件。全部数据在 `~/.config/opencode/mem-plus/`：

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
├── index.db                         # 检索索引（可删，memory_reindex 重建）
├── mem-plus.log                     # 日志
├── dreaming/last-day                # 睡眠整理标记
├── state/openclaw.sqlite            # 记忆宿主的事件与游标
└── agents/main/agent/
    └── openclaw-agent.sqlite        # 常驻意图与记忆血缘
```

markdown 是唯一数据源，索引是可再生数据。想备份就备份 `workspace/`。

`state/` 与 `agents/` 是插件的内部账本，随插件自动创建，`memory_reindex` 与备份都不需要管它们；手工删掉也不会丢记忆条目，但常驻意图（`standing_intent` 建的提醒）和记忆血缘会一起没，而血缘没了「忘记」就定位不到条目。

## 故障排查

先看日志 `~/.config/opencode/mem-plus/mem-plus.log`。

| 现象 | 原因与处理 |
|---|---|
| 工具重复注册，日志出现两条 `plugin loaded`，同一轮对话两份快照 | 自动发现与 `opencode.jsonc` 指向同一目录，插件加载了两次。保留一种 |
| 日志无 `plugin loaded` | 核对安装路径是否指向含 `package.json` 与 `index.ts` 的目录、是否绝对路径、Windows 下是否用了正斜杠，然后重启 |
| 有 `plugin loaded` 但无 `retrieval tools ready` | 检索工具注册失败，`memory_search` 等不可用。看日志里紧随其后的错误 |
| 浏览器打不开默认端口 | 端口被占用时自动递增，实际端口以日志 `memory browser at` 一行为准 |
| 记忆浏览器无法访问，或显示别的项目的记忆 | 端口先到先得，实际端口见日志。多个 OpenCode 窗口只有一个能占用 |
| 模块解析失败 | 运行时模块别名没生成。执行 `node "<插件目录>/plugin/scripts/link-openclaw-alias.mjs"` 后重启 |
| `index unavailable (no node:sqlite ...)` | Node.js 低于 22.5，检索工具不注册。快照与抽取不受影响 |
| `no embedding model at ... vector search off` | 没放向量模型或路径不对。只有语义检索不可用 |
| `missing ... (model.embedPath) -- vector search stays off` | `model.embedPath` 指向的文件不存在。修正路径或删掉该项 |
| `hybrid` / `vector` 返回 0 条 | 执行 `memory_reindex {"embed": true }` 并等它跑完 |
| 导入后搜不到文档 | `memory_search` 默认只搜会话记忆，要指定 `corpus: "wiki"` 或 `"all"` |
| `workspace/memory/` 下没有当日文件 | 要完成一次完整对话轮次，写入在结算约 2 秒后发生 |
| `service did not become healthy ... within 30s` | 推理服务没起来。可手动跑 `node "<插件目录>/plugin/serve/server.mjs" --port 4748` 看日志 |
| `gpu backend unavailable; service will not start` | 没有可用 GPU，推理服务不启动。出现可用 GPU 后自动恢复 |
| `推理依赖未安装：找不到 node-llama-cpp` | 推理依赖缺失，与显卡无关。重新运行安装器即可补上；未装时全文检索不受影响，向量检索不可用 |

## 更新

无自动更新。**Windows 用户再双击一次新版安装器就行** —— 它会先删掉上一版写过、这一版不再携带的文件，再写新包，然后 `opencode reload`。

压缩包安装的覆盖升级，与安装同理，先停服务：

```bash
opencode service stop                 # 服务在跑时会加载到半旧半新的插件
npm i "<新版本 tgz 的完整路径>"       # 覆盖安装，依赖自动更新
opencode service restart
```

记忆、索引与日志在 `~/.config/opencode/mem-plus/`，不在插件目录里，两种更新方式都不碰它们。各版本号与安装包见 [Releases](https://github.com/GuzhouYiyun/mem-plus/releases)。

向量**模型**仍然要自己下载放置，约 1.2 GB，见[向量模型](#向量模型可选)。

> 早期版本的安装器在不勾选「本地向量检索依赖」时会传入 `--omit=optional`，npm 会顺带把已装好的 `node-llama-cpp` 剪掉，于是更新后向量检索静默失效——日志只提示显卡不可用，与真实原因无关。该分支现已不可达：运行库每次都装，且报错会直接说明是包缺失而非显卡问题。

覆盖更新时 npm 也不会重装它：实测（2026-10-12，一次真实安装）`node-llama-cpp` 是 971 个文件 / 37.8 MB，整棵依赖树 29482 个文件 / 858.3 MB，它只占其中一小部分；在已装好的树上跑 `npm install --dry-run`，`node-llama-cpp` 没有任何动作。

## 卸载

**Windows 设置 → 应用 → 已安装的应用 → mem-plus → 卸载。**

卸载器只删安装器自己写入的文件。放在插件目录里的其他东西（例如你下载的向量模型）不在删除范围内，会留在原处。记忆数据目录不会被触碰。

压缩包安装的手动卸载：

```bash
opencode service stop
rm -rf ~/.config/opencode/plugins/mem-plus    # 插件目录
```

```powershell
# Windows
opencode service stop
Remove-Item -Recurse -Force "$env:USERPROFILE\.config\opencode\plugins\mem-plus"
```

记忆数据目录默认保留，要一并清掉再手动删 `~/.config/opencode/mem-plus`。若用了显式注册，同时删掉 `opencode.jsonc` 里的 `plugins` 条目，最后 `opencode service restart`。

## 许可证

MIT。其中包含的第三方代码：

| 来源 | 范围 | 许可 | 版权 |
|---|---|---|---|
| [openclaw](https://github.com/openclaw/openclaw) | `src/`、`extensions/`、`packages/` 下记忆相关模块的副本 | MIT | Copyright (c) 2026 OpenClaw Foundation |
| [opencode-mem](https://github.com/tickernelz/opencode-mem) | 记忆浏览器的界面布局与前端框架 | MIT | Copyright (c) 2025 Zhafron Adani Kautsar |

完整许可文本见 [LICENSE](./LICENSE) 与 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。