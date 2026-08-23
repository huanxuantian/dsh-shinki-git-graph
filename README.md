# dsh-shinki-git-graph

DSH 侧边栏 **Git 图谱**插件：在侧边栏增加一个 Git 历史/分支树视图（类似 VS Code 的 Git Graph 扩展），只读查看提交历史。

**当前版本：v0.3.4**（布局：详情面板 ≤1/3 侧边栏、头部固定、文件列表按行数精确计算）

- **分支范围**：默认显示**当前分支 + 其上游远程分支**；可切换为**全部本地和远程分支**（此时分支树可勾选过滤）。
- **分支树**：本地/远程分组树，当前分支 ✓ 标记、上游 ↔ 标注，点击勾选过滤历史。
- **多分支颜色标记**：勾选多个分支过滤时，每个选中分支分配稳定色板颜色——提交行节点/路径按所属分支着色，分支树行带同色圆点。
- **提交图**：泳道（lane）式提交图，分叉/合并清晰可辨，refs 徽标（当前分支高亮）、作者、相对时间。
- **点击展开详情**：提交元信息（作者/提交者/父提交/正文）+ 变更文件列表（+/− 统计）+ 可折叠完整 diff；点文件行可打开侧边栏内置 diff tab。
- **详情面板布局**：整体高度 ≤ 侧边栏 1/3（33vh，单滚动容器）；头部（提交信息）sticky 固定、正文过长时头部区内滚动（≤14vh）；文件列表高度按行数 JS 像素计算（1 行 = 22px，上限 33vh/4 + 两行），行数少时无空白。
- **只读**：不含分支切换/提交/推送等写操作（写操作请用侧边栏内置 Git tab 或终端）。

## 验证状态

已在副本运行环境（`D:\vmx\test\dsh-win-x64`，端口 3081）验证通过：Tab 注册/泳道图/分支树/详情展开/多分支颜色/窗口缩放跟随/长正文与文件列表布局。原环境（`D:\vmx\dsh-win-x64`）未受影响。

## 安装

本插件依赖 [dsh-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar)（侧边栏宿主，提供 `ctx.betterSidebar` 注册服务）。

```sh
# 本地开发（link: 方式，重建后刷新即生效）
dsh plugin --profile web add link:/绝对路径/plugin/web/dsh-shinki-git-graph

# 或拷贝到运行时 plugin\web\ 后，在 profile 目录执行 pnpm install
```

安装后重启 `dsh web`，侧边栏 + 菜单出现「Git 图谱」Tab。

## 卸载

```sh
dsh plugin --profile web remove dsh-shinki-git-graph
```

> 动运行时环境（`D:\vmx\dsh-win-x64`）前，先按仓库 `doc/异常恢复指南-运行时插件环境.md` 备份。

## 设置

- **分支范围**（当前+上游 / 全部）与**页大小**会持久化到浏览器 localStorage（`dsh-shinki-git-graph:*`），跨会话记忆。
- 侧边栏设置页的 `pluginSettings` 接线（v0.12+ 声明式设置行）留待后续版本接入。

## 架构

- **host 半区**（`lib/index.js`，Node）：git 数据服务 + `POST /shinki-git/api` 路由。
  - 数据：`init` / `branches`（本地+远程+上游映射）/ `graph`（`git log --parents` 拓扑，revs 白名单防注入，skip/limit 分页）/ `commit`（元信息 + numstat + diff）。
  - 安全：回环 socket + Host/`--trusted-host` 围栏（`lib/trust-fence.js`）；仓库路径仅从会话 cwd 解析，绝不信任客户端传入路径；git 逐条 spawn（无 shell）+ 超时 + 输出上限。
- **browser 半区**（`lib/client.js`）：通过 `window.__ModuleLoader__` 加载，注册侧边栏 Tab（`ctx.betterSidebar.registerTab`），渲染分支树 + 泳道提交图 + 展开详情。泳道算法与官方 git-graph 插件一致（`lib/lanes.js`，client 内有内联副本，需同步）。

## 测试

```sh
node --test tests/            # node:test（沙箱受限环境可逐个文件直接运行）
node tests/lanes.test.mjs
node tests/git-service.test.mjs   # 需要真实 git（临时仓库）
node tests/fence.test.mjs
```

## 已知限制（初版）

- 分页「加载更多」每页泳道独立（顶部为断开线），不做跨页泳道续接。
- 标签随 refs 徽标显示（`tag: x` → `x`），无单独开关。
- 仅 web profile。
