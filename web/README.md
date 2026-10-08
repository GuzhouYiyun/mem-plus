# web —— 记忆浏览器（React 前端）

四个标签页：**提示词文件**、**梦境日记**、**mem-plus 配置**、**设置**。技术栈
React 19 + Vite 8 + Tailwind 4 + shadcn/radix + lucide，自成一个 npm 子项目，
不与插件共用依赖。中文单语。

| 路由 | 页面 | 内容 | 接口 |
|---|---|---|---|
| `/prompt-files` | 提示词文件 | 6 个注入文件的正文，标签页切换，可编辑保存 | `GET` / `PUT /api/prompt-files` |
| `/dreams` | 梦境日记 | `DREAMS.md`，**只读**，按日记条目分卡 | `GET /api/dreams` |
| `/config` | 设置 | 模型相关的选项，13 个字段，分「抽取／文件／运行」三段 | `GET` / `PUT /api/config` |

`/` 会重定向到 `/prompt-files`；任何不认识的路径也一样（router 用 `replaceState`
改写地址栏），所以旧的 `/project-memories`、`/user-profile` 都会落到提示词文件页。
旧的 `/settings`（只读状态页，已删）重定向到 `/config` —— 一个书签点进来却落到
无关页面，看起来就像站点坏了。

**没有会话历史页。** openclaw 刻意不保留可读的完整会话：会话转录只作为 dreaming 的
输入素材（`memory/.dreams/session-corpus/`，每条截断到 12–280 字符），产品是长期记忆。
曾按轮做过一个基于 capture 快照的对话页，但它展示的是 openclaw 从未打算暴露的东西，
已删除。

## 配置页：为什么不能"搬"openclaw 的那个

openclaw 自己的软件设置里有一个可视化改 JSONC 的配置页，但它**搬不过来**：

- 它是 **Lit** 写的（`@lit/context` / `@lit/task` / `lit/decorators.js`），这里是 React。
  `ui/src/pages/config/config-page.ts` 一个文件 1238 行 / 51 KB，`config-form*` 渲染器
  另有 22 个文件 / 177 KB。
- 它读写配置走 **gateway 的 WebSocket RPC**（`config.get` / `config.patch` /
  `config.set` / `config.schema`），而 gateway 服务端在 2026-10-04 的裁剪里一起没了
  （`src/gateway/` 现在只剩 17 个类型文件，裁剪前 `server-methods/` 有 383 个）。
- 整个 `ui/` 是 1977 个文件 / 15.7 MB，且依赖 app shell（context / i18n / gateway client）。

所以这里是**重写**，而且只重写有用的那一半：表单字段表在 `web/src/lib/config-schema.ts`，
服务端在 `plugin/src/web/config-file.ts`。

### 表单只留模型那一节

字段表里现在只有 `model.*`（14 个字段），**默认全部折叠**。`web.*` / `service.*` /
`wiki.*` 仍然有效、仍有各自的默认值、保存时仍被保留 —— 只是从这个页面上编辑不了了。
这是关于页面的取舍，不是关于插件的：`web.port`、`web.authPassword` 现在得手动改配置文件。

`ConfigField.kind` 里的 `secret` 分支没有字段在用，但留着 —— 把 `web` 那一节加回
表里，密码框立刻就能用。

### 配置页写的是哪个文件

`~/.config/opencode/mem-plus/config.jsonc` —— mem-plus 自己的文件，就在记忆库和索引
旁边。**插件正常启动时会自动生成一份带注释的模板**；万一没有（比如目录不可写、被手工
删了），页面不会给一句没用的提示就完事 —— 它显示一张虚线卡片，说明缺的是什么、创建的
按钮会做什么，并按下按钮。按钮带 `create: true`，服务端据此跳过 sha256 检查（没有文件
就没有可校验的哈希），写入那份模板。

`GET /api/config` **不**创建文件：读操作不该有副作用，而且文件真不在时，页面要能说
"没有"并给出选择，而不是悄悄变出一个文件。

**为什么不再写 `opencode.jsonc`。** 原来写的是 `plugins[]` 里 mem-plus 那条的
`options`。但那个通道**只有你把插件注册进 `plugins[]` 时才存在**，于是自动发现的
用户一个设置都配不上；而为了能配设置去注册一份，就变成加载两份（工具重复注册、
同一轮对话写两份快照）。自己拥有文件把这个矛盾解开了：**注册方式与配置位置彻底解耦**，
两种加载方式都能配。

这是 opencode-mem 的做法：它的设置在 `~/.config/opencode/opencode-mem.jsonc`，模块
加载时创建，全仓不读 `ctx.options`（`src/config.ts:8-13`、`:563-577`）。

**优先级**（`plugin/src/index.ts` 里只算一次）：

```
内置默认值  <  ctx.options  <  config.jsonc
```

`ctx.options` 保留是为了让已有的 `plugins[]` 条目不至于立刻失效，但它不再是该写的地方。
配置文件赢，因为它必须"无论怎么加载都是同一份" —— 一个换加载方式就变意思的设置，
不叫真相来源。

注意这只解决**配置**。加载两份还是两份，那是另一条独立的规则，见根 README。

写入保护（实测过）：

| 断言 | 结果 |
|---|---|
| 首次运行自动建文件，且首次就读得到模板里的值 | 通过 |
| 逐**叶**编辑：改一个键，同对象里其它键和它们旁边的注释都还在 | 通过 |
| 没改动的保存报告 `unchanged`，文件一个字节不动 | 通过 |
| sha256 对不上就 409，不盲合并 | 通过 |
| 语法错误的文件拒绝写入（422），且一个字节没动 | 通过 |
| 新增不存在的键，缩进与闭合括号对齐 | 通过 |
| 密码任意深度都不外泄；改别的键不会抹掉它；显式清除会真的删掉 | 通过 |
| 建不出目录时退回 `ctx.options`，不抛异常 | 通过 |

其中"密码清除"值得单说：密码**永不往返**（页面只收到"是否已设置"），所以"清除"没法
用写空值表达 —— 服务端为它专门支持按路径删除节点。这也解释了为什么**只有密码**会删键：
别的字段"恢复默认"是把默认值**显式写进去**，服务端因此不需要知道表单管哪些键。

写入是逐叶子的，所以你在文件里写的注释不会因为改一个数字而丢掉；临时文件 + rename
原子替换。改完仍然需要 `opencode service restart`。

## 怎么打开

装好 mem-plus 之后，OpenCode 一启动插件就把页面服务拉起来（`127.0.0.1:4747`，
端口被占时顺延），浏览器打开 <http://127.0.0.1:4747/> 即可。日志里会有一行
`[mem-plus:web] memory browser at http://127.0.0.1:4747/`。关掉这个开关：
`"web": { "enabled": false }`；换端口：`"web": { "port": 4750 }`。

服务由插件侧的 `plugin/src/web/server.ts` 提供（与 opencode-mem 同一形态：Bun.serve
优先、node:http 兜底，静态托管 + SPA 回退，端口冲突时顺延，被另一个实例占用时复用
它的地址）。它在 `openIndex()` 之后 fire-and-forget 启动，拿的是插件自己打开的那条
SQLite 连接。

改完页面要重新构建才会生效：

```
cd web; npm run build        # tsc -b && vite build -> web/dist
```

`npm run dev`（vite 开发服务器，默认 5173）只是改代码时看效果用的，不是产品的形态。
注意 dev 下页面没有令牌（没有服务进程往 `index.html` 里注入），所以接口会回 401 ——
要看真数据就开 `npm run build` 后用插件起的那个服务。

## 鉴权（两层，都搬自 opencode-mem）

页面能读整个记忆索引、还能改注入文件，所以默认绑回环；但 `web.host` 一旦不是回环
（局域网地址、SSH 隧道、容器端口），能连上的人就能读你的记忆、改 `AGENTS.md`。两层防护：

| 层 | 什么时候开 | 拦什么 | 代码 |
|---|---|---|---|
| **HTTP Basic Auth** | 设了 `web.authPassword` 才开 | 网络：非回环暴露 | `plugin/src/web/auth.ts` |
| **CSRF 令牌** | 总是开 | 浏览器：别的网站借你的登录态发请求 | `plugin/src/web/auth-token.ts` |

```jsonc
// opencode.json
"plugins": [{ "package": "mem-plus", "options": {
  "web": {
    "host": "0.0.0.0",          // 可选，要从局域网访问才需要
    "authPassword": "挑一个强密码", // 留空 = 不开 Basic Auth
    "authUser": "me"             // 可选，默认当前系统账号名
  }
}}]
```

- `authPassword` 三种写法，和 opencode-mem 的 `webServerAuthPassword` 一致：字面量、
  `env://环境变量名`、`file:///绝对路径`。后两种在**读取失败时按"没设密码"处理**，
  并且只要 `host` 不是回环，日志里就会打出 WARNING —— 路径写错导致裸奔比启动失败更糟。
- Basic Auth 的用户名密码是**常数时间比较**，401 带 `Cache-Control: no-store`，
  `WWW-Authenticate: Basic realm="mem-plus"`（浏览器弹自己的登录框，会话内记住）。
- `/api/health` 两层都放行：它是第二个 OpenCode 窗口判断"这个端口是不是自家页面服务"
  的探针（`ownedByMemPlus`），没凭据也必须能答。
- **令牌**是每台机器一份的随机 32 字节（hex），存在
  `~/.config/opencode/mem-plus/.auth-token`（POSIX 下 0600），首次启动时生成。
  服务端把它内联进 `index.html`（`window.__MEM_PLUS_TOKEN__`），页面每个 `/api/*`
  请求带回 `x-mem-plus-token`。为什么密码不够：浏览器会把 Basic 凭据缓存到会话结束，
  任何网站都能借它驱动一次已认证的请求 —— 包括改 `AGENTS.md` 的那个 PUT。令牌只有
  bundle 里的脚本读得到（服务端不发 CORS 头，跨源读 index.html 是不透明响应）。
- 没搬上游的 CORS 层：mem-plus 的页面和接口同源，不需要。上游那份是给它的
  `vite dev`（5173）放行的；mem-plus 的 dev 模式本来就拿不到数据。

## 接口

服务端路由全在 `plugin/src/web/api.ts`，页面侧封装在 `src/lib/api.ts`（`fetchAPI`，
统一读 `{ success, data | error }` 信封）。**每个端点都用这个信封**，包括 `/api/health` ——
早先 health 单独返回裸对象，于是页面把它读成 `undefined`，改成信封后第二个 OpenCode
窗口的端口复用探测也跟着改成读 `data.service`。

### 设置（侧栏第三项，`/config`）

设置是个**普通的标签页**，不是弹窗 —— 弹窗会让地址栏停在上一页，浏览器「后退」键的
行为也变得莫名其妙。

这一页只有「模型」一节，13 个字段按「抽取 → 文件 → 运行」排：先决定抽取跑在哪个模型
上，再决定那个模型的文件在哪，最后才是机器怎么跑它。三段之间是小标题，不是可折叠的
二级栏 —— 只有一个 section 的时候，折叠栏只是点开点关都只看到一节。

字段控件按值域选，不是一个输入框走天下：`enum` 和 `modelRef` 是页面自己画的
listbox（原生 `<select>` 的弹层由操作系统绘制，字体不归页面管），`number` 是
`type="number"`（`gpuLayers` 只能填 `auto` 或 0–999，因为 `readGpuLayers` 会把
其它一切静默落回 `auto`），`text` 只剩三个文件路径。

**设置里没有密码，也不该有。** 访问控制是配置（`web.authPassword`，见上面的「鉴权」），
在这里既改不了；而且在一个你已经登录进去的页面上复述"你有没有设密码"，信息量是零 ——
看配置文件更快。

### 梦境日记怎么拆成条目

openclaw 的 `DREAMS.md` 是一份带受管标记的 markdown，`appendNarrativeEntry` 每次
dreaming 就在日记块末尾插入一条 `\n---\n\n*<日期>*\n\n<正文>\n`——追加，
所以最新的在文件末尾。页面按**日期行**（`*October 3, 2026 at 09:57 AM GMT+8*`）
切分，而不是按 `---`：正文里本来就可能有 `---`（markdown 的分隔线），按它切会把
一夜切成两夜，实测确实如此。

- 解析在 `src/lib/dream-diary.ts`（`parseDreams`），无日期的手写文件整体收成一条
  无日期条目，而不是显示空白页。
- `## Deep Sleep` 块单独作为一张卡：它是 deep 阶段"沉淀了什么"的汇总，不是某一夜的日记。
- 最新的在前（文件是追加的，页面从上往下读）。

| 路由 | 方法 | 说明 |
|---|---|---|
| `/api/health` | GET | 存活探针（鉴权放行），返回索引状态与 `authEnabled`；页面不读它，是**端口复用探测**（`ownedByMemPlus`）和外部健康检查用的 |
| `/api/stats` | GET | 索引计数：文档数、条目数、向量数、字节数。**页面已不读它** —— 唯一读它的只读状态页删了；端点留着，因为从插件的 HTTP 表面上摘掉一个接口和删掉读它的标签页是两件事 |
| `/api/prompt-files` | GET / PUT | 6 个注入文件；PUT 带 sha256，并发写冲突回 409 |
| `/api/dreams` | GET | `DREAMS.md`，只有读没有写 |
| `/api/config` | GET / PUT | mem-plus 自己的 `config.jsonc`；PUT 带 sha256，`create: true` 表示文件不在、由页面创建。详见上面「配置页写的是哪个文件」 |
| `/api/models` | GET | OpenCode 能用到的模型，给配置页的模型下拉框；宿主没有该接口时返回 `available: false`，页面退回手填 |

没有暴露索引的接口：`/api/memories`、`/api/search`、`/api/tags` 已随会话历史页删除
（实测 404）。索引只喂给 `memory_search`。

可写的有两处：那 6 个注入文件（`AGENTS.md`、`SOUL.md`、`IDENTITY.md`、`USER.md`、
`BOOTSTRAP.md` 取自工作区，`MEMORY.md` 取自记忆库），白名单在 `promptFileTarget()`；
以及配置文件里 mem-plus 的 `options` 那一个对象。注入文件的写入保护：sha256 乐观并发
+ 临时文件 rename 原子替换 + 2 MB 上限（与注入器读取上限一致）+ 写后重索引（仅
`MEMORY.md`）+ 令牌校验（见上）。**梦境日记只读**，不提供 PUT。

配置读写用到 `jsonc-parser`（MIT、零依赖、约 200 KB）—— 唯一为这次新增的运行时依赖。
自己写一个 JSONC 扫描器去改用户手写的配置文件，是那种"聪明"的做法：省下一个依赖，
换来一个会在某次转义或注释上吃掉你配置的东西。

## 页面侧现状

- 数据全部来自接口，没有本地 store、没有轮询；每个页面挂载时拉一次，另有刷新按钮。
- 提示词文件页的编辑是「编辑 → 底部固定操作栏的保存/取消」（不随滚动跑）。
- 四个标签页都是「外壳固定、只有正文滚动」：标签栏/文件头/路径/说明/操作栏都是
  `shrink-0`，正文 `flex-1 overflow-y-auto`；窗口本身 `h-svh overflow-hidden`。
- 配置页的字段都标了「默认」：配置文件里没写的键 = 跑在默认值上。表里把默认值显式
  写出来，是因为"框里是 4747"不告诉你是你设的还是本来就那样。改一个值会把这个键
  显式写进文件，「恢复默认」把键删掉。
- `model.hostedModel` 是**下拉框**，选项来自 `GET /api/models`（OpenCode 的
  `ctx.model.list()`）。值是 `providerID/modelID` —— 没有猜的办法，与其让人去
  `opencode models` 复制一行，不如直接列出来。已停用的模型**列出来但标记并禁用**
  （你配过又停用的那个正是你想在列表里看到的）；配置里写着一个当前列表里没有的
  id 时，它会作为「当前不可用」保留在选中项里，而不是被悄悄删掉 —— 删掉等于把抽取
  换到另一个模型。列表为空或接口不存在时退回手填输入框。
- 设置页**没有密码**，也不该有：访问控制是配置（`web.authPassword`），在这里既改不了；
  而在一个你已经登录进去的页面上复述"你有没有设密码"，信息量是零。
- 未接线的动作：没有。原来的「清理」「去重」「删除」「置顶」「批量删除」都随会话历史页
  一起删掉了——它们的接口从来不存在，留着只是按钮。

## 与发布包的关系

`web/` 的**源码**不进 tgz（不在插件导入闭包里，两个类型门禁也不包含它），但
**`web/dist` 进** —— `scripts/audit-npm-pack.mjs` 把 `web/dist` 列为固定目录，缺了它就算
漂移；`prepack` 先跑 `scripts/build-web.mjs`（已构建则跳过，不在背后重 build），再跑审计。
源码要随包分发的话得另说，目前分发渠道只有 GitHub Release 的 tgz。
