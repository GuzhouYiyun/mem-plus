<div align="center">

# mem-plus

[English](./README_en.md)

</div>

依据 OpenClaw 开发的 OpenCode 持久记忆系统。全部推理在本地 GGUF 模型上运行，不调用外部 API，不产生按量计费。

不只是记忆：在 `SOUL.md` / `IDENTITY.md` 写入人设（角色扮演、专属助手、严格的代码评审员……），agent 每轮都以该性格与语气行事；长期记忆逐日累积，它会越来越懂你和你的项目（见[提示词注入](#提示词注入)）。

OpenCode 本身不具备记忆能力：会话中获取的信息（修改过的文件、遇到的障碍、失败的方案）在会话结束后即丢失。mem-plus 为 OpenCode 提供持久记忆系统：

- **会话快照** — 每轮对话自动归档为 `memory/YYYY-MM-DD-标题.md`
- **LLM 抽取** — 本地模型将每轮工作内容提炼为结构化条目（请求 / 结果 / 标签），写入 `memory/YYYY-MM-DD.md`
- **混合检索** — 全文与向量双通道，模型可自动检索历史记忆
- **睡眠整理** — 每日将当日条目汇编写入 `MEMORY.md`（长期记忆）与 `DREAMS.md`（洞察日志）
- **提示词注入** — `AGENTS.md`、`MEMORY.md` 等工作区文件在每轮对话前注入系统提示词，其内容对模型始终可见
- **人设与成长** — `SOUL.md`、`IDENTITY.md`、`USER.md` 等文件定义 agent 的性格、身份与用户画像，可随时修改；与逐日沉淀的长期记忆一起，agent 随使用慢慢"长成"你期望的助手



## 环境要求

- **OpenCode V2**（`@opencode/plugin` 2.0.20 及以上；不支持 V1）
- **Node 22.5+**（或 Bun）：检索工具依赖 `node:sqlite`。若缺失，快照与抽取功能正常运行，仅检索工具不可用。`node -v` 查看版本，低于 22.5 请先升级
- **两个本地 GGUF 模型**（共约 3.7 GB，见 [本地模型](#本地模型)）

## 快速开始

### 1. 克隆到 OpenCode 插件目录

将 mem-plus 克隆到 OpenCode 的全局插件目录 `~/.config/opencode/plugins/`，与其他插件统一管理：

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

也可以不从 git 克隆：在 GitHub 仓库页面下载源码压缩包（Code → Download ZIP），解压后将目录重命名为 `mem-plus` 放入全局插件目录 `~/.config/opencode/plugins/`。目录名保持一致，后续各步骤中的路径才不变。

### 2. 安装依赖

```bash
npm install                  # 仓库根目录
cd plugin                    # 进入插件目录
npm install                  # 插件目录
```

根目录的 `npm install` 会通过 postinstall 自动生成运行时模块别名（幂等，可重复执行；若使用 `npm install --ignore-scripts` 等跳过脚本的装法，需手动执行 `node plugin/scripts/link-openclaw-alias.mjs`，否则插件无法加载）。

`npm install` 会同时安装 `node-llama-cpp` 对应平台的预编译二进制。未安装依赖时，插件仍可加载，会话快照正常写入，但 LLM 抽取不执行。

### 3. 注册插件（默认安装无需操作）

第 1 步克隆进全局插件目录 `~/.config/opencode/plugins/` 时，OpenCode 启动时自动发现并加载——无需注册，直接跳过本节。

仅在以下情况才需写入 `opencode.jsonc`（全局 `~/.config/opencode/opencode.jsonc`，或项目目录下的 `opencode.jsonc`）：

- 克隆到了全局插件目录以外的位置
- 需要向插件传入配置选项
- 重启后日志中没有 `plugin loaded`（见第 5 步），即自动发现未生效

最小示例（只告诉 OpenCode 插件在哪，不传选项）：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    "C:/path/to/where/you/cloned/mem-plus"
  ]
}
```

路径规则：

- 路径即第 1 步克隆（或解压）的实际位置，且须指向 **mem-plus 仓库根目录**——含 `package.json`、`index.ts`、`plugin/` 的那一层（入口声明在根 `package.json`），不要写成内层 `plugin/` 子目录
- Windows 下须用正斜杠；建议写绝对路径，相对路径则相对配置文件所在目录解析
- `plugins` 的条目有两种写法：字符串形式只填路径（如上例，不传任何选项）；对象形式把路径放进 `"package"`、要传的选项放进 `"options"`。需要传选项时用对象形式（形如 `{ "package": "...", "options": { ... } }`），全部可选项见[配置](#配置)
- 保存后重启 OpenCode（`opencode service restart`）生效

### 4. 下载模型

在仓库根目录创建 `models` 目录（克隆时不包含该目录），并将以下两个文件下载至 `mem-plus/models/`：

| 文件名 | 大小 | 用途 | 国内（ModelScope） | 海外（Hugging Face） |
|---|---|---|---|---|
| `Qwen3.5-4B-Q4_K_M.gguf` | ~2.7 GB | 抽取 | [Qwen3.5-4B-Q4_K_M.gguf](https://modelscope.cn/models/unsloth/Qwen3.5-4B-GGUF/resolve/main/Qwen3.5-4B-Q4_K_M.gguf) | [Qwen3.5-4B-Q4_K_M.gguf](https://huggingface.co/unsloth/Qwen3.5-4B-GGUF/resolve/main/Qwen3.5-4B-Q4_K_M.gguf) |
| `bge-m3-FP16.gguf` | ~1.2 GB | 向量嵌入 | [bge-m3-FP16.gguf](https://modelscope.cn/models/gpustack/bge-m3-GGUF/resolve/main/bge-m3-FP16.gguf) | [bge-m3-FP16.gguf](https://huggingface.co/gpustack/bge-m3-GGUF/resolve/main/bge-m3-FP16.gguf) |

注意：

- 仓库中还托管有其他量化版本，它们不属于默认配置。
- 如想使用其他模型，两个槽位的类型不可互换：抽取槽位须为 completion 风格（base）语言模型，嵌入槽位须为带 embedding 头的模型。不经配置直接替换时，须将新模型重命名为与上表文件名相同（`Qwen3.5-4B-Q4_K_M.gguf` / `bge-m3-FP16.gguf`）后放入 `models/`；或保留原文件名，用 `model.contentPath` / `model.embedPath` 指向实际路径（见[配置](#配置)）。
- 详见 [本地模型](#本地模型)。

### 5. 重启 OpenCode 并验证

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

随后在任意项目中完成一个对话 turn，项目目录下应生成 `memory/` 目录（见 [数据位置](#数据位置)）。

日志中没有 `plugin loaded` 时：先按第 3 步的路径形式注册插件并再次重启；仍不出现则见 [故障排除](#故障排除)。

### 6. 索引已有文件（可选）

插件注册后写入的记忆条目会自动登记进检索索引。仅当环境中存在**注册之前**的 `memory/` 或 `MEMORY.md` 文件（例如手动写入的会话记录、自旧项目迁移的文件）时，需要执行一次全量索引将其纳入；此类文件不会被自动扫描：

```
memory_reindex  {"scope": "all", "embed": true}
```

- 该命令扫描全部现有记忆文件并重建索引，幂等，可重复执行。
- `embed: true` 由嵌入模型为各内容块计算向量，启用 `hybrid` / `vector` 语义检索；仅需全文检索时执行 `{"scope": "all"}` 即可。

## 日常使用

### 三个检索工具

模型可自动调用；用户亦可在会话中显式指定调用。

| 工具 | 作用 |
|---|---|
| `memory_search` | 检索记忆。默认为纯文本检索（最快，无需模型）；`mode: "hybrid"` 融合向量检索；`scope: "archive"` 跨项目搜索 |
| `memory_get` | 按 id 读取完整条目 |
| `memory_reindex` | 从 markdown 文件重建索引；`embed: true` 补齐向量 |

`memory_search` 参数：

- `query`（必填）
- `scope` — `project`（默认）/ `all` / `archive`
- `mode` — `text`（默认）/ `hybrid` / `vector`
- `limit`、`kind`（`entry` / `snapshot` / `memory`）、`tag`、`since`、`until`、`project`

全文检索采用 **AND** 语义：所有查询词均须命中。建议先使用具体词汇，无结果时再逐步放宽。

### 数据位置

项目内的数据：

```
<项目目录>/
├── MEMORY.md                  # 长期记忆
└── memory/
    ├── 2026-10-02.md          # 抽取条目
    ├── DREAMS.md              # 睡眠整理日志
    └── 2026-10-02-fix-bug-x.md # 会话快照
```

共享数据（所有项目共用一个索引）：

```
~/.config/opencode/mem-plus/
├── index.db                   # 检索索引（可随时删除，通过 memory_reindex 重建）
├── mem-plus.log               # 日志
├── archive/<项目名>--<哈希>/   # 各项目 memory/ 的全局镜像（跨项目检索的数据来源）
│   ├── INDEX.md               # 该项目的归档索引
│   └── memory/…               # 与 <项目>/memory/ 同名
└── dreaming/<项目名>.last-day # 睡眠整理标记（删除后可强制重新执行）
```

Markdown 文件为唯一数据源；`archive/` 是其全局镜像，索引为可再生数据。

### 推理服务

插件在 `127.0.0.1:4748` 启动本地推理服务（独立进程）。多个 OpenCode 窗口共享同一服务，避免重复占用显存。服务空闲 10 分钟后自动退出，关闭 OpenCode 后不会持续占用 CPU。

GPU 优先级：**独显 > 核显 > CPU**，某级不可用时自动回退至下一级。日志将报告最终选用的后端：

```
[mem-plus] [mem-plus:serve] llama backend = vulkan (gpu) build=prebuilt
```

## 本地模型

替换模型时须注意：

- **抽取模型必须使用 completion 风格（base）模型，不得使用 Instruct / Chat 风格模型**。使用 Instruct 模型进行抽取将静默返回空结果。默认的 `Qwen3.5-4B-Q4_K_M.gguf` 为 base 模型，适用。
- **嵌入模型须带 embedding 头**。默认的 `bge-m3-FP16.gguf` 满足此要求；嵌入槽位放入语言模型会在首次使用时报错。
- 若仅使用文本检索，可省略嵌入模型（`bge-m3`）。
- 更换嵌入模型后须执行 `memory_reindex {"scope": "all", "embed": true}` 重建向量。旧向量由旧模型计算，空间混杂会导致 hybrid / vector 检索结果错误。

## 配置

以下配置项均为可选。需在 `opencode.jsonc` 中传入选项时使用对象形式：

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

完整示例见 [`opencode.example.jsonc`](./opencode.example.jsonc)。

### 模型

| 键 | 默认值 | 说明 |
|---|---|---|
| `model.content` | `"local"` | `"local"` = 本地 GGUF 服务；`"opencode"` = OpenCode 计费模型 |
| `model.allowHostedFallback` | `false` | 本地推理不可用时是否允许回退至计费模型 |
| `model.dir` | `<repo>/models` | GGUF 文件所在目录 |
| `model.contentPath` | `model.dir/Qwen3.5-4B-Q4_K_M.gguf` | 抽取模型路径 |
| `model.embedPath` | `model.dir/bge-m3-FP16.gguf` | 嵌入模型路径 |
| `model.gpu` | `"auto"` | `"auto"` / `"cuda"` / `"vulkan"` / `"cpu"` |
| `model.gpuLayers` | `"auto"` | 分配至显存的层数 |
| `model.contextSize` | `16384` | 抽取上下文窗口 |
| `model.maxNewTokens` | `512` | 单次抽取最大 token 数 |
| `model.threads` | `0` | CPU 线程数（仅 CPU 回退时生效） |
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

## 无静默计费

本插件的设计原则为推理全程本地化。本地推理不可用时（模型缺失、依赖未安装、端口被占用、服务异常），插件**不会**静默回退至计费模型：

1. 快照继续写入（不产生费用）
2. 抽取暂缓执行，待处理记录保留
3. 服务恢复后自动补做抽取：每个完成 turn 时插件先探测本地服务，可用才执行抽取；不可用时本轮跳过，待处理记录原样保留——服务恢复后的下一个 turn 自动补做，无需手动操作

如需启用计费模型回退，请显式设置 `model.allowHostedFallback: true` 或 `model.content: "opencode"`。

## 睡眠整理

每个日历日内的首个完成 turn 触发（每日最多执行一次），将当日条目汇编写入 `MEMORY.md` 与 `DREAMS.md`。删除 `~/.config/opencode/mem-plus/dreaming/` 下的标记文件可强制在下一 turn 重新执行。本地服务不可用时，整理流程降级为仅写入条目，不生成 LLM 叙述。

## 提示词注入

每轮模型调用前，mem-plus 读取项目根目录下的工作区文件并注入系统提示词。这些文件的名称与语义沿用 openclaw 的约定，缺失的文件自动跳过，可随时增改，下一轮即生效：

| 文件 | 作用 |
|---|---|
| `AGENTS.md` | 项目协作约定（工作规则、代码风格、偏好） |
| `SOUL.md` | 人设：agent 的性格、价值观与行为准则（openclaw 的"灵魂"文件） |
| `IDENTITY.md` | 身份：名字、角色、自称与语气 |
| `USER.md` | 用户画像：称呼、偏好、背景信息 |
| `BOOTSTRAP.md` | 启动引导说明 |
| `MEMORY.md` | 长期记忆，由睡眠整理每日汇入 |

写入 `SOUL.md` / `IDENTITY.md` 即为 agent 设定性格与身份；日常工作中踩过的坑、失败的方案经 LLM 抽取与睡眠整理沉淀进 `MEMORY.md`，注入内容逐日累积，agent 对项目的理解随使用演进。演进发生在提示词与记忆层面（注入文件、检索索引），不改变模型本身。

## 故障排除

日志文件位于 `~/.config/opencode/mem-plus/mem-plus.log`，排查问题时首先检查该文件。

| 现象 | 原因 / 处理 |
|---|---|
| `extraction DISABLED (GGUF not found)` | 模型未放置于 `models/` 目录。快照写入不受影响 |
| `service did not become healthy ... within 30s` | 服务未启动。手动执行：`cd plugin && node serve/server.mjs --port 4748` |
| `local service unavailable; deferring the sweep` | 服务暂不可用；记录保留，恢复后自动重试 |
| 抽取输出为空（`summary=0 chars`） | 抽取模型为 Instruct 风格，参见 [本地模型](#本地模型) |
| `Index: 0 documents` | 执行 `memory_reindex` |
| `hybrid` / `vector` 返回 0 条 | 执行 `memory_reindex {"embed": true}` 并等待完成 |
| `memory/` 目录不出现 | 需完成一个完整 turn（结算 + 2 秒防抖）后生成 |

## 卸载

彻底移除插件及其数据（顺序执行）：

1. 关闭 OpenCode，并停止本地推理服务（命令在 Windows 与 Linux / macOS 上相同）：

   ```bash
   opencode service stop
   ```

2. 删除共享数据目录（索引、日志、`archive/` 归档镜像、睡眠整理标记）：

   ```powershell
   # Windows
   Remove-Item -Recurse -Force "$env:USERPROFILE\.config\opencode\mem-plus"
   ```

   ```bash
   # Linux / macOS
   rm -rf ~/.config/opencode/mem-plus
   ```

   目录内全部为可再生数据或项目目录 markdown 的镜像，直接删除即可
3. （可选）删除各项目中的 `MEMORY.md` 与 `memory/`。记忆本体即这些 markdown 文件，需保留时先备份
4. 删除插件目录（含 `models/` 下约 3.7 GB 的模型文件）：

   ```powershell
   # Windows
   Remove-Item -Recurse -Force "$env:USERPROFILE\.config\opencode\plugins\mem-plus"
   ```

   ```bash
   # Linux / macOS
   rm -rf ~/.config/opencode/plugins/mem-plus
   ```

   插件克隆在其他位置的，删除对应目录
5. 曾在 `opencode.jsonc` 中注册过插件的，删除相应条目；仅靠全局插件目录自动发现加载的，无需此步
6. 重启 OpenCode，卸载完成

## 许可证

本仓库采用 MIT 许可。其中包含的第三方代码：

| 来源 | 范围 | 许可 | 版权 |
|---|---|---|---|
| [openclaw](https://github.com/openclaw/openclaw) | `src/`、`extensions/`、`packages/` 下记忆相关模块的副本 | MIT | Copyright (c) 2026 OpenClaw Foundation |
| [opencode-mem](https://github.com/tickernelz/opencode-mem) | Web 管理界面布局（计划并入） | MIT | Copyright (c) 2025 Zhafron Adani Kautsar |

各来源的完整许可文本见 [LICENSE](./LICENSE) 与 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。
