# dsh-shinki-git-graph

DSH 侧边栏 **Git 图谱**插件：在侧边栏增加一个 Git 历史/分支树视图（类似 VS Code 的 Git Graph 扩展），支持写操作与远程同步。

**当前版本：v0.6.0**（M5 分支写操作 + 远程同步 + git 认证交互 + 便携 git 部署）

- **分支范围**：默认显示**当前分支 + 其上游远程分支**；可切换为**全部本地和远程分支**（此时分支树可勾选过滤）。
- **分支树**：本地/远程分组树，当前分支 ✓ 标记、上游 ↔ 标注，点击勾选过滤历史。
- **多分支颜色标记**：勾选多个分支过滤时，每个选中分支分配稳定色板颜色——提交行节点/路径按所属分支着色，分支树行带同色圆点。
- **提交图**：泳道（lane）式提交图，分叉/合并清晰可辨，refs 徽标（当前分支高亮）、作者、相对时间；「加载更多」分页**跨页泳道续接**（不顶部断开）。
- **点击展开详情**：提交元信息（作者/提交者/父提交/正文）+ 变更文件列表（+/− 统计）+ 可折叠完整 diff；点文件行内联展开该文件 diff。**提交行右键「查看 diff」同样内联展开详情**（不再打开外部 diff tab）。
- **写操作**：暂存区（已暂存/未暂存/未跟踪三组）、单击内联 diff、文件右键（暂存/取消暂存/丢弃）、一键暂存全部/取消暂存全部、丢弃确认（未跟踪删除需三次勾选）、内嵌提交框（Ctrl+Enter 提交）。
- **分支写操作（M5）**：分支树右键「切换分支 / 基于此新建分支」（远程分支也可检出或作基准，**自动设置上游跟踪**）、提交行右键「检出到分支… / 在此提交新建分支… / 检出此提交（detached）」、顶部「⋯」菜单「新建分支…」（对话框输入分支名 + 基准分支：本地/远程分组，支持以任意提交为基准）；**未跟踪分支检出时按默认策略自动绑定默认远程同名分支（仅当远程真实存在）**；脏工作区时弹确认；操作后自动刷新。
- **远程同步**：头部 **⇣ 拉取 / ⇡ 推送** 按钮——选择**类型（分支/标签）**与远程源、分支或标签后执行；拉取可选「仅拉取（fetch，不合并/不签出）」与「变基（--rebase）」，推送可选「设置上游（-u）」，拉取标签恒为 fetch，支持自定义标签名输入与「拉取全部（fetch --all）」；**git 认证交互**（账号/密码/SSH passphrase 原生输入框）；push 前显示 ahead/behind 提示；操作后自动刷新图谱。

## 验证状态

单测全绿（git-service 48 / routes 20 / lanes 7 / fence 6）。已在副本运行环境（`D:\vmx\test\dsh-win-x64`，端口 3081）验证：bundle 加载 v0.6.0、API 路由挂载、fence 放行、`dsh.ps1 check` 便携 git 注入成功、git 认证交互路由（prompt-poll/answer）；GUI 交互（同步对话框/分支操作/认证输入）已人工确认主要流程。原环境（`D:\vmx\dsh-win-x64`）未受影响。

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

## 架构

- **host 半区**（`lib/index.js`，Node）：git 数据服务 + `POST /shinki-git/api` 路由。
  - 数据：`init` / `branches`（本地+远程+上游映射）/ `graph`（`git log --parents` 拓扑，revs 白名单防注入，skip/limit 分页）/ `commit`（元信息 + numstat + diff）/ `status` / `diff` / `stage` / `unstage` / `discard` / `wcommit`。
  - 分支写操作：`checkout`（切换，白名单 + 存在性校验，当前分支返回 unchanged；远程分支本地无同名时 `--track` 自动建跟踪分支）/ `createBranch`（新建，重名拒绝，base 可为本地/远程分支或 hash，远程 base 自动 `--track` 设上游）/ `checkoutCommit`（detached 检出，hash 正则校验）。
  - 同步：`remotes`（`git remote -v`）/ `tags`（`for-each-ref refs/tags`）/ `push`（`git push [-u]` 分支或 `git push <remote> tag <tag>`）/ `pull`（`git pull [--rebase]` 分支，`fetchOnly` 时仅 `git fetch`；`tag` 时仅 fetch）/ `fetchAll`（`git fetch --all --prune`）；远程名/分支名/标签名白名单校验，branch 与 tag 二选一，网络操作 120s 超时；**认证**：`onPrompt` 凭据提示桥接（`prompt-poll`/`prompt-answer`）+ SSH BatchMode + 认证失败友好映射。
  - 安全：回环 socket + Host/`--trusted-host` 围栏（`lib/trust-fence.js`）；仓库路径仅从会话 cwd 解析，绝不信任客户端传入路径；git 逐条 spawn（无 shell）+ 超时 + 输出上限。
- **browser 半区**（`lib/client.js`）：通过 `window.__ModuleLoader__` 加载，注册侧边栏 Tab（`ctx.betterSidebar.registerTab`），渲染分支树 + 泳道提交图 + 展开详情 + 写操作/同步/认证对话框。泳道算法与官方 git-graph 插件一致（`lib/lanes.js`，client 内有内联副本，需同步）。

## 测试

```sh
node --test tests/            # node:test（沙箱受限环境可逐个文件直接运行）
node tests/lanes.test.mjs
node tests/git-service.test.mjs   # 需要真实 git（临时仓库）
node tests/fence.test.mjs
```

## 已知限制（初版）

- 标签随 refs 徽标显示（`tag: x` → `x`），无单独开关。
- 仅 web profile。
- pull/push 的 `--rebase` / `-u` 已支持；暂未支持交互式 rebase 与冲突解决 UI。

## 版本历史

- **v0.6.0**：M5 分支写操作（切换/新建/检出，远程分支自动跟踪、未跟踪自动绑定默认远程同名、linkCurrent 会话参数）；页大小设置 UI + pluginSettings 接线；跨页泳道续接；启动体验（无会话提示 + 自动轮询）；pull/push 增强（`-u`/`--rebase`/ahead-behind）；git 认证交互；便携 git 自动部署。
- **v0.5.0**：提交行右键「查看 diff」内联化；pull/push/fetch-all 同步（含 tag 推送/拉取、fetch-only）。
- **v0.3.x**：泳道图 / 分支树 / 详情展开 / 多分支颜色（初版布局）。
