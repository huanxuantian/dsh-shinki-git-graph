# dsh-shinki-git-graph

DSH 侧边栏 **Git 图谱**插件：在侧边栏增加一个 Git 历史/分支树视图（类似 VS Code 的 Git Graph 扩展），支持写操作与远程同步。

**当前版本：v0.10.2**（工作目录四级解析 + 子目录 git 仓库探测 + M5 分支写操作 + 远程同步 + 网页端 git 认证（GIT_ASKPASS 桥，绝不停留在终端） + 便携 git 部署 + Git Extensions 风格的曲线分支树 + 浅色/深色主题各自配色、分支/远程/标签徽标带图标 + **TAG 创建/管理：注释、GPG 签名、创建后推送、远程 TAG 拉取、三重确认删除**）

> ⚠ **版本号有两处，必须同步**：`package.json` 的 `version` 与 `lib/client.js` 的 `PLUGIN_VERSION`
> （侧边栏角标显示的就是后者；浏览器半边读不到 package.json，所以是硬编码副本）。
> 只改前者会出现「json 已是新版本、界面仍显示旧版本」—— 0.8.0 时踩过。
> 另：改完插件要在 profile 目录 `pnpm install` **重新物化**（`file:` 依赖是 pnpm 的硬链接副本，
> 改源目录不生效），再**重启 dsh Web 服务**。

- **子目录 git 仓库探测**：当工作区本身不是 git（或不在 git 内）时，自动探测工作区子目录中的 git 仓库（默认最多 3 层，跳过隐藏目录与 node_modules），以**折叠列表**展示（仓库名按**工作区相对路径**），点击某行即**展开单独管理**该仓库（图谱/分支树/暂存区/写操作/同步全部作用于该仓库）；仓库较多时分页「加载更多仓库」。工作区本身是 git 时保持原有单仓库逻辑不变。

- **分支范围**：默认显示**当前分支 + 其上游远程分支**；可切换为**全部本地和远程分支**（此时分支树可勾选过滤）。
- **分支树**：本地/远程分组树，当前分支 ✓ 标记、上游 ↔ 标注，点击勾选过滤历史。
- **多分支颜色标记**：勾选多个分支过滤时，每个选中分支分配稳定色板颜色——提交行节点/路径按所属分支着色，分支树行带同色圆点。
- **提交图**：泳道（lane）式提交图，分叉/合并清晰可辨，refs 徽标（当前分支高亮）、作者、相对时间；「加载更多」分页**跨页泳道续接**（不顶部断开）。
- **点击展开详情**：提交元信息（作者/提交者/父提交/正文）+ 变更文件列表（+/− 统计）+ 可折叠完整 diff；点文件行内联展开该文件 diff。**提交行右键「查看 diff」同样内联展开详情**（不再打开外部 diff tab）。
- **写操作**：暂存区（已暂存/未暂存/未跟踪三组）、单击内联 diff、文件右键（暂存/取消暂存/丢弃）、一键暂存全部/取消暂存全部、丢弃确认（未跟踪删除需三次勾选）、内嵌提交框（Ctrl+Enter 提交）。
- **分支写操作（M5）**：分支树右键「切换分支 / 基于此新建分支」（远程分支也可检出或作基准，**自动设置上游跟踪**）、提交行右键「检出到分支… / 在此提交新建分支… / 检出此提交（detached）」、顶部「⋯」菜单「新建分支…」（对话框输入分支名 + 基准分支：本地/远程分组，支持以任意提交为基准）；**未跟踪分支检出时按默认策略自动绑定默认远程同名分支（仅当远程真实存在）**；脏工作区时弹确认；操作后自动刷新。
- **远程同步**：头部 **⇣ 拉取 / ⇡ 推送** 按钮——选择**类型（分支/标签）**与远程源、分支或标签后执行；拉取可选「仅拉取（fetch，不合并/不签出）」与「变基（--rebase）」，推送可选「设置上游（-u）」，拉取标签恒为 fetch，支持自定义标签名输入与「拉取全部（fetch --all）」；**git 认证交互**（账号/密码/SSH passphrase 原生输入框）；push 前显示 ahead/behind 提示；操作后自动刷新图谱。

## 验证状态

**工作目录解析（v0.7.2 / v0.7.3）**：`tests/session-cwd.test.mjs` **13/13 通过** —— 活跃会话优先（且不被其他来源覆盖）/ 未打开会话从磁盘会话头解析 / 工作区台账兜底 / 未知 id → `session-unknown` / 会话在但目录没了 → `workspace-missing` / 可选服务缺失优雅降级 / 空或非字符串 id → null / 缓存每次 id 仅一次扫描 / **scope.cwd 提示：命中台账工作区才采信、非工作区路径拒绝、台账不可用则失败关闭（fail closed）**。真实数据复核：A571（`D:\hzw\work\car` 子目录，7 万+ 文件）的 4 个会话在**未打开**状态下均解析到 `D:\hzw\work\car\brank_brank\example\A571`；进程内直调真实 handler 端到端实测 `init` 721ms（`isRepo=true root=D:/hzw/work/car subdir=brank_brank/example/A571`）、`graph` 746ms（10 行）；未打开且台账未索引的会话 + 合法 cwd 提示同样能出图，未知会话仍 404 `session-not-found`，目录已消失则 404 `workspace-missing`。排查记录见 `doc/调试笔记-20260911-git图谱工作区无会话无限刷新.md`。

单测全绿（**95 个**：git-service 56 / routes 26 / lanes 7 / fence 6；新增子仓库扫描与 repoPath 路由用例）。已用真实路径 `D:\AI\win\data\home` 全链路实测（`tests/validate-subrepos.mjs`）：工作区非 git 时 `init` 返回子仓库列表（3 层内、跳过隐藏/node_modules、排除第 4 层），空白仓库以 `HEAD` 分支列出，`repoPath` 定位子仓库的 branches/graph/status 正常，路径逃逸（`..`/`C:/x`/`/abs`）均 400 拒绝；工作区为 git 时保持原逻辑。已在副本运行环境（`D:\vmx\test\dsh-win-x64`，端口 3081）验证：bundle 加载 v0.7.0、API 路由挂载、fence 放行、`dsh.ps1 check` 便携 git 注入成功、git 认证交互路由（prompt-poll/answer）；GUI 交互（同步对话框/分支操作/认证输入）已人工确认主要流程。原环境（`D:\vmx\dsh-win-x64`）未受影响。

## 安装

本插件依赖 [dsh-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar)（侧边栏宿主，提供 `ctx.betterSidebar` 注册服务）。

```sh
# 本地开发（link: 方式，重建后刷新即生效）
dsh plugin --profile web add link:/绝对路径/plugin/web/dsh-shinki-git-graph

# 或从 npm 安装
dsh plugin --profile web add dsh-shinki-git-graph

# 或拷贝到运行时 plugin\web\ 后，在 profile 目录执行 pnpm install
```

安装后重启 `dsh web`，侧边栏 + 菜单出现「Git 图谱」Tab。

> 便携 git：`engine/dsh.ps1` / `engine/dsh.bat` 在系统无 git 时会自动下载 PortableGit 到 `engine/git-win-x64` 并注入 PATH（`DSH_AUTO_GIT_DOWNLOAD=0` 禁用，`DSH_GIT_VERSION` 指定版本）。

## 卸载

```sh
dsh plugin --profile web remove dsh-shinki-git-graph
```

## 设置

- **分支范围**（当前+上游 / 全部）、**页大小**（50/100/200/500）、**显示标签**：侧边栏设置页声明式设置行（`pluginSettings`，v0.12+），localStorage 回退双写，跨会话记忆；页大小也保留「⋯」菜单入口。

## Git 认证（v0.8.0 重做，※ 本机 Linux 冻结事故的修复）

**背景（2026-09-22 实测）**：旧实现以为「git 把凭据提示写到 stderr、从 stdin 读答案」，于是
`netEnv()` 设了 `GIT_TERMINAL_PROMPT=1` 且把 `GIT_ASKPASS` **清空**，靠 `lib/git-runner.js` 的
`onPrompt` 从 stderr 抓提示。**这在 Linux 上是错的**：git 会 `open("/dev/tty")` 在**控制终端**上
提示并阻塞在那里——stderr 一直是空的（实测：提示出现在 pty 上，探针捕获的 stderr 为 `""`）。
dsh web 继承了控制终端时，提示被打进宿主控制台、git 阻塞不返回 = **推送时整个控制台卡死、只能强制重启**。

**现在的机制**（对齐 VS Code 的 `extensions/git/src/askpass*.ts`，见文末参考）：

| 层 | 实现 |
|---|---|
| 环境 | 网络操作（push/pull/fetchAll）一律 `GIT_TERMINAL_PROMPT=0` + `GIT_ASKPASS=lib/askpass.sh`（Windows 为 `askpass.cmd`）；即使桥不可用，git 也只会**快速失败**，绝不再碰终端 |
| 助手 | git 以 `askpass 「Username for 'https://…': 」` 调用 → `lib/askpass-main.mjs` 把提示 POST 到插件自己的回环端点 `/shinki-git/api`（`method=askpass-wait`，带**每操作一次性令牌**）→ 阻塞等浏览器回答 → 把答案打到 **stdout**（git 只取 stdout，所以诊断信息一律走 stderr） |
| 桥 | host 侧 `pendingPrompts` 按**每条提示**（不是每个操作）登记：一次操作会问两次（用户名、密码），并发/交错提问正是 VS Code 那个老问题（microsoft/vscode#230033）的根源 |
| 界面 | 浏览器轮询 `prompt-poll` 拿 `{prompt, promptId}`，弹原生对话框，用 `prompt-answer`（回带 `promptId`）作答；`密码/口令` 类提示自动用掩码输入 |
| 身份留存 | **由 git 自己完成**：认证成功后 git 会调用 `credential approve` 交给已配置的助手（`store`/`libsecret`/`osxkeychain`/`wincred`/GCM），所以「下次不再问」只需要一个助手；插件只**如实告知**——`credentials.helperConfigured` 决定提示「凭据已保存」还是「未配置凭据助手，下次仍会询问」。认证失败时插件额外执行 `credential reject` 清掉坏凭据 |
| SSH | 维持非交互（`GIT_SSH_COMMAND='ssh -o BatchMode=yes'`、`SSH_ASKPASS_REQUIRE=never`）：SSH 走密钥/agent，失败即快速报错，同样不会在终端挂住 |

**为什么助手不能从 stdin 拿答案**：实测 askpass 助手的 stdin **不是** git 的 stdin 管道
（`read -t 3` 直接 EOF/超时）。VS Code 也是走带外通道（IPC 管道 + `VSCODE_GIT_ASKPASS_PIPE` 文件）；
本插件用回环 HTTP + 每操作令牌，跨平台且无需额外 socket。助手任何失败都**不打印 stdout 并以非 0 退出**，
让 git 用自己的认证错误收场，而不是无限等待。

**测试**：`tests/askpass.test.mjs`（4/4）用**真实 git + 真实 askpass 脚本 + 真实回环 HTTP**，远端是
一个「先 401、认证后走 `git http-backend`」的智能 HTTP 服务，覆盖：①需认证的 push 经网页桥完成，
且**在 pty 下全程没有出现任何凭据提示**；②认证成功后凭据由助手落盘 → 第二次推送**不再提示**；
③认证失败后坏凭据不残留；④伪造令牌 → 403。

## 架构

- **host 半区**（`lib/index.js`，Node）：git 数据服务 + `POST /shinki-git/api` 路由。
  - 数据：`init` / `branches`（本地+远程+上游映射）/ `graph`（`git log --parents` 拓扑，revs 白名单防注入，skip/limit 分页）/ `commit`（元信息 + numstat + diff）/ `status` / `diff` / `stage` / `unstage` / `discard` / `wcommit`。
  - 分支写操作：`checkout`（切换，白名单 + 存在性校验，当前分支返回 unchanged；远程分支本地无同名时 `--track` 自动建跟踪分支）/ `createBranch`（新建，重名拒绝，base 可为本地/远程分支或 hash，远程 base 自动 `--track` 设上游）/ `checkoutCommit`（detached 检出，hash 正则校验）。
  - 同步：`remotes`（`git remote -v`）/ `tags`（`for-each-ref refs/tags`）/ `push`（`git push [-u]` 分支或 `git push <remote> tag <tag>`）/ `pull`（`git pull [--rebase]` 分支，`fetchOnly` 时仅 `git fetch`；`tag` 时仅 fetch）/ `fetchAll`（`git fetch --all --prune`）；**TAG**：`tagCreate`（`git tag --no-sign|-a -m|-s -m`，注释/签名必须有消息，否则 git 会开编辑器卡住；轻量 TAG 显式 `--no-sign` 以免 `tag.gpgSign=true` 时被意外签名）/ `tagDelete`（`git tag -d`，危险，UI 三重确认）/ `tagDeleteRemote`（`git push --delete <remote> refs/tags/<tag>`，**先 ls-remote 确认远程确有该 TAG** —— `push --delete` 删不存在的远端 ref 也返回 0）/ `tagsFetch`（`git fetch [<remote>|--all] --tags`，不 prune）/ `tagsRemote`（`git ls-remote --tags`）；远程名/分支名/标签名白名单校验，branch 与 tag 二选一，网络操作 120s 超时；**认证**：`onPrompt` 凭据提示桥接（`prompt-poll`/`prompt-answer`）+ SSH BatchMode + 认证失败友好映射。
  - 安全：回环 socket + Host/`--trusted-host` 围栏（`lib/trust-fence.js`）；仓库路径仅从会话 cwd 解析，绝不信任客户端传入路径；git 逐条 spawn（无 shell）+ 超时 + 输出上限。
- **browser 半区**（`lib/client.js`）：通过 `window.__ModuleLoader__` 加载，注册侧边栏 Tab（`ctx.betterSidebar.registerTab`），渲染分支树 + 泳道提交图 + 展开详情 + 写操作/同步/认证对话框。泳道算法与官方 git-graph 插件一致（`lib/lanes.js`，client 内有内联副本，需同步）。

## 测试

```sh
npm test                          # = node --test（自动发现 tests/*.test.mjs）
node --test tests/lanes.test.mjs          # 泳道分配（旧入口兼容）
node --test tests/graph-layout.test.mjs   # 泳道配色 / 曲线图元 / 压缩滑移 / 跨页续接
node --test tests/client-load.test.mjs    # 浏览器半包加载 + 图谱行渲染冒烟
node --test tests/client-inline.test.mjs  # 内联区与 lib/graph-layout.js 一致性
node --test tests/git-service.test.mjs    # 需要真实 git（临时仓库；git < 2.28 会因 `init -b` 失败）
node --test tests/fence.test.mjs
```

图谱样式的**目视校验**（无需浏览器）：`node tests/graph-preview.mjs --png` 会把三组样例历史画成
`/tmp/git-graph-preview.svg|png`（若装了 `rsvg-convert` 则顺带转 PNG）。

## 主题（浅色 / 深色）

宿主主题服务用 `body[data-ds-dark-theme]` 切换深浅色（皮肤/自定义主题只改 `--dsw-*` 的值），
插件据此给每个颜色准备两套值（token 前缀 `--sgg-`）：

| token | 浅色 | 深色 | 最低对比度（对 #f9fafb / #1b1b1c） |
|---|---|---|---|
| `--sgg-lane-1..8` | `#9a6700 #bf3989 #0969da #1a7f37 #bc4c00 #1b7c83 #cf222e #57606a` | `#d29922 #f778ba #79c0ff #7ee787 #ffa657 #a5d6ff #ff7b72 #8b949e` | 4.66:1 / 5.11:1 |
| `--sgg-ref-fg` / `-bg` / `-line` | `#0550ae` 等 | `#79c0ff` 等 | 徽标文字 ≥5.3:1 / ≥4.7:1 |
| `--sgg-add/del/hunk/success/danger/warn` | `#1a7f37 #cf222e #0969da …` | `#7ee787 #ff7b72 #79c0ff …` | ≥4.5:1 |

`tests/theme.test.mjs` 按 WCAG 公式断言这些数字（泳道是图形 → ≥3:1；文字 → ≥4.5:1），
并保证两个主题的 token 集合一致、旧硬编码色不残留。改动配色后跑
`node tests/graph-preview.mjs --png` 可同时生成深浅两套预览图目视核对。

## 已知限制（初版）

- 标签随 refs 徽标显示（`tag: x` → `x`），无单独开关。
- TAG 签名（`-s`）需要本机已配置 GPG 密钥；没有密钥时 git 直接报错（不会卡住，10s 超时兜底）。
- 泳道间距按整页最宽行自适应（15 / 12 / 9 / 7 px），提交点半径随之缩小；图谱列宽度上限为行宽的
  62%，超过时整幅图**等比挤压**（所有泳道都还在，节点略呈椭圆）——侧边栏宽度所限，优先保住提交标题。
- 仅 web profile。
- pull/push 的 `--rebase` / `-u` 已支持；暂未支持交互式 rebase 与冲突解决 UI。

## 版本历史

- **v0.10.2**：**修复「管理 TAG → 删除选中」点了没反应、不弹窗** —— `showConfirm()` 里用 `box.insertBefore(extra, btns)` 插入「同时删除远程 TAG」附加控件，而那一刻 `btns` 还没挂到 `box` 上，真实 DOM 会抛 **`NotFoundError`**，异常又从按钮的 click 处理器冒出去 → 静默无反应（假 DOM 当时不校验参照节点，所以测试没拦住）。改用 `appendChild`（DOM 顺序仍是「勾选项 → 附加控件 → 按钮」）；同时把管理面板删除按钮的调用包进 try/catch，任何打开确认框的异常都会显示在面板内，不再静默；测试用的假 DOM 改为**严格校验 `insertBefore` 参照节点**并支持 `innerHTML=''` 清空，新增 DOM 级用例跑**真实删除流程**（断言确认框真的出现、宽版、4 个复选框、未勾满三重确认时按钮禁用、可选勾选项不能替代三重确认、确认后回调执行且带出「同时删除远程 TAG」状态）—— 把该 bug 改回去该用例立即失败（已实测）。
- **v0.10.1**：**「同时删除远程 TAG」选项显性化** —— 该选项原先只在「仓库配了远程」时才渲染、且远程下拉要勾选后才出现，容易被误以为功能缺失。现确认框里**始终显示**「同时删除远程 TAG」复选框 + 远程选择（未勾选时下拉置灰、文案说明「不勾选：只删本地 TAG，远程不受影响」；没有远程时置灰并提示「未配置远程仓库」），确认框改为宽版并可滚动；控件抽成模块级 `tagDeleteExtraControls` 并新增 **DOM 级单测**（用极简假 DOM 驱动：断言选项存在、远程清单与默认远程、勾选/取消的联动与状态写回），防止再退化。
- **v0.10.0**：**TAG 功能** —— 提交右键新增「在此创建 TAG」与「管理 TAG…」：① 创建对话框填名称，可选**带注释（-a）**（必填消息）、**带 GPG 签名（-s，隐含注释）**，并可勾选**同时推送到远程**（选择远程，创建成功后立即推送；推送失败会明确提示「TAG 已创建，但推送失败」）；② 管理对话框选一个 TAG 做**推送**/**删除**，可**拉取远程 TAG**（单远程或全部远程），并标出每个 TAG「远程已有 / 未推送」；③ **删除是危险操作**：三重勾选确认后才可执行，并可勾选**同时删除对应远程 TAG**（多远程时指定远程）。host 侧新增 `tagCreate / tagDelete / tagDeleteRemote / tagsFetch / tagsRemote`，`tags()` 带上 `annotated/target/date`。**修复**「显示标签」开关看不出状态：原按钮是 emoji 图标（不继承 `color`）+ `--dsw-alias-brand-primary`（默认主题里是中性前景色，等于没高亮）→ 改为 `ToggleIconButton`：开/关两枚不同图标（标签 / 斜杠标签）+ 主题色按下态（`--sgg-ref-*`）+ `aria-pressed` + title 标注「开/关」；「显示整个仓库」开关同样处理。
- **v0.9.1**：**主题适配 + 分支/标签徽标重做** —— v0.9.0 的配色只有一套深色专用亮色，浅色主题下泳道线在 #f9fafb 上仅 1.47~2.94:1（低于 WCAG 图形要求 3:1，绿色/浅蓝几乎看不见），ref 徽标文字 <2.3:1。现所有颜色收敛为 `--sgg-*` token（浅色挂 `:root`、深色挂宿主主题开关 `body[data-ds-dark-theme]`），泳道线/分支树圆点/节点填充/徽标/diff 全部随主题切换；徽标改为**图标 + 描边 + 省略号**：本地分支=分支图标、远程分支=云图标、标签=标签牌图标（类型不再只靠颜色区分，远程判定查宿主远程分支清单而非「名字带斜杠」）。新增 `tests/theme.test.mjs` 按 WCAG 断言对比度（泳道 ≥3:1、文本 ≥4.5:1、两主题 token 集合一致），预览脚本改为同时产出深浅两套。
- **v0.9.0**：**分支树绘制重做（Git Extensions 风格）** —— 原实现每行只画一串等宽字形（`│ ● ◉`），分叉/合并表现为「某列突然变空格（线断了）」，配色还随列号轮换。现改为按 Git Extensions 的绘制模型出**图形图元**：① 分叉/合并处画 S 曲线斜插进节点（不再断线）；② 泳道**随身携带颜色**（分支全程同色，只有分叉处出现第二种颜色），跨页沿用同一配色；③ 泳道每行**压缩**（释放的空列即时移除，右侧泳道用滑移曲线平移过去），图谱宽度只取决于同时并存的分支数；④ 节点形状按 GE 规则：有 ref → 方块、HEAD → 多一圈描边（合并提交不额外变形，靠曲线表达）；⑤ 布局/配色/几何收敛为单一真源 `lib/graph-layout.js`（内联进 `client.js`，由单测守卫一致），并新增 `tests/graph-preview.mjs` 目视校验脚本。`assignLanes` 旧入口保留为兼容层。
- **v0.8.0**：**网页端 git 认证（askpass 桥）**——修复 Linux 上「推送时凭据提示落到宿主控制台、git 阻塞把整机卡死」的事故：网络操作改 `GIT_TERMINAL_PROMPT=0` + 真正的 `GIT_ASKPASS` 助手（`lib/askpass.sh|.cmd` + `lib/askpass-main.mjs`，经回环 HTTP 送回浏览器对话框，每操作一次性令牌）；`pendingPrompts` 改为按提示 id 登记（支持一次操作问两次、避免交错）；如实上报凭据助手状态并在认证失败时 `credential reject`。参考 VS Code `extensions/git/src/askpass.ts|askpass-main.ts`。
- **v0.7.3**：**cwd 提示（成员资格校验）+ 精确错误码**。① 更正认知并利用既有能力：better-sidebar 的面板 scope 是 `{ sessionId, cwd }`（cwd 取自客户端侧、磁盘来源的会话列表），其自身 host 端也是"校验成员资格后才把客户端 cwd 当命令 cwd 用"；本插件现把 `scope.cwd` 作为**提示**随请求上报，host 仅在它能 realpath 命中**自己台账里的某个工作区路径**时才采信，且**台账不可用即忽略**（fail closed）—— 于是"会话既没打开、台账也没索引到"的情况也能出图，而浏览器依旧无法把 git 指向任意目录。② 错误语义细分：会话存在但目录已消失/改名 → 404 `workspace-missing`（附具体路径，客户端显示错误而非无意义轮询）；会话确实找不到 → 仍 404 `session-not-found`（客户端走有界重试 + 提示）。
- **v0.7.2**：**工作目录改为三级解析（修 A571 工作区打不开）**——原先只从 `ctx.sessions.get(sessionId)` 取 cwd，而那是**内存里"当前已打开"的会话表**：没打开的会话一律 404 `session-not-found`，于是同一仓库下 p507 正常、A571 一直失败。现按序回退：① 活跃会话 → ② 磁盘会话头（`sessionQuery.listSessions()`） → ③ 工作区台账（`workspaceRegistry.list()` 按 `sessionIds` 反查 `path`）；后两者用 `ctx.get()` 可选获取，缺失时优雅降级为原行为。仅回环客户端可达（trust fence 未变），路径仍全部由宿主推导。
- **v0.7.1**：**面板拿不到可用会话时不再无限刷新**——原实现每 2s 无上限重试，表现为 A571 这类 workspace「一直在反复刷新」且始终没有 git 信息。现改为**有界重试**（10 × 2s ≈ 20s）后停止自动刷新，给出说明与「重试」按钮；新会话出现或手动重试会重置预算。（**更正**：初版此处写的"better-sidebar 的 scope 只带 `sessionId`"是错的 —— 实际是 `{ sessionId, cwd }`，详见 v0.7.3。）
- **v0.7.0**：**子目录 git 仓库探测**——工作区本身非 git 时扫描子目录 git 仓库（默认 3 层，跳过隐藏/node_modules，上限防护），折叠列表（工作区相对路径）+ 分页「加载更多」；点击展开对单个仓库独立管理（全部方法经 `repoPath` 定位，host 侧防路径逃逸）；工作区为 git 时逻辑不变。
- **v0.6.0**：M5 分支写操作（切换/新建/检出，远程分支自动跟踪、未跟踪自动绑定默认远程同名、linkCurrent 会话参数）；页大小设置 UI + pluginSettings 接线；跨页泳道续接；启动体验（无会话提示 + 自动轮询）；pull/push 增强（`-u`/`--rebase`/ahead-behind）；git 认证交互；便携 git 自动部署。
- **v0.5.0**：提交行右键「查看 diff」内联化；pull/push/fetch-all 同步（含 tag 推送/拉取、fetch-only）。
- **v0.3.x**：泳道图 / 分支树 / 详情展开 / 多分支颜色（初版布局）。

## 参考实现

- Git Extensions 的提交图绘制（本项目 v0.9.0 分支树样式的参考）：
  `src/app/GitUI/UserControls/RevisionGrid/Graph/Rendering/{GraphRenderer,SegmentRenderer}.cs`
  —— 泳道宽度 16 / 线宽 2 / 节点 10、每段「上一行-本行-下一行」三点几何、两端竖直时的贝塞尔配方、
  有 ref → 方块与 HEAD 描边；`RevisionGraphLaneColor.cs` 的 7 色调色板与「颜色挂在段上」的稳定配色；
  `docs/macos/reduced-graph-design.md` 的 reduced-graph 算法与「lane 压缩 / 滑移」说明。

- VS Code Git 扩展的 askpass：`extensions/git/src/askpass.ts`（环境注入 `GIT_ASKPASS`/`VSCODE_GIT_ASKPASS_*`、无 IPC 时用 `askpassEmpty`、按 authority 缓存 60s、密码用掩码输入框）与 `extensions/git/src/askpass-main.ts`（助手经 IPC 取答案、写管道文件、失败 `fatal()` 退出 1）
- git 官方：`gitcredentials(7)`（取凭据顺序 `GIT_ASKPASS` → `core.askPass` → `SSH_ASKPASS` → **终端提示**）、`git-credential(1)`（`fill`/`approve`/`reject` 协议）
- 已知坑：microsoft/vscode#230033（askpass 并发/交错的用户名+密码请求）
