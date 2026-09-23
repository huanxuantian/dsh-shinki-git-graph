# 历史重演说明（REPLAY-NOTES）

本仓库是 **`dsh-shinki-git-graph` 插件**的独立工程，其历史由原单仓 `dsh_nwjs`
中 `plugin/web/dsh-shinki-git-graph` 目录的历史**重演**而来。

## 来源

| 项 | 值 |
|---|---|
| 原仓库 | `dsh_nwjs`（本机 `D:\AI\dsh_nwjs`） |
| 原路径 | `plugin/web/dsh-shinki-git-graph` |
| 重演提交数 | 69（覆盖该目录自创建起的全部改动） |
| 时间范围 | 2026-08-23 ～ 2026-09-23 |
| 重演方式 | git 底层原语逐提交重建：导出该提交的插件子树 → 入索引 → `commit-tree`（不引入原仓库其他模块的对象） |

## 与原历史的差异（有意为之）

1. **身份统一**：所有重演提交的**作者与提交者**均为
   `huanxuantian <huanxuantian@msn.cn>`；**日期沿用原始提交**，因此时间线保持不变。
2. **提交信息脱敏**：只保留与 git-graph 插件相关的描述。原仓库中跨模块的混合提交（23 条）
   已人工重写，剔除其他插件/模块、宿主引擎与打包链、单仓文档与索引、本机环境实测细节等无关内容；
   主题 scope 统一为 `(git-graph)`。
3. **内容范围**：仅插件代码目录本身 —— `lib/`、`tests/`、`package.json`、`cordis.patch.yml`、
   `README.md`。原仓库其他路径（宿主插件、工具链、文档目录、依赖清单等）**不在**本仓库内。
4. **独立工程适配**（唯一一处代码改动）：内联一致性守护 `tests/client-inline.test.mjs` 改为
   **自带实现**（抽取/生成/比较内联区），不再依赖原仓库的 `tool/plugin-sync/` 脚本；
   `lib/client.js` 与 `lib/graph-layout.js` 中相关的注释同步更新。除此之外源码与上游一致。
5. 目标目录原有的 `LICENSE`（Apache-2.0）与骨架提交 `Initial commit` 予以保留，
   重演的历史接在其后。

## 内容一致性（可复核）

- 与 `dsh_nwjs` 的 `plugin/web/dsh-shinki-git-graph` 目录**逐字节一致**（30 个文件，
  不含本说明与 `.gitignore` 两个适配文件）；
- `lib/askpass.sh` 保持可执行位 `100755`（POSIX 上作为 git askpass 助手需要 +x）；
- 测试：`node --test`（见下）。

## 复核与使用

```bash
git log --oneline            # 重演历史（骨架提交 + 69 条）
node --test                  # 全量测试（无第三方依赖）
```

原仓库对应的调试与设计资料（`doc/调试笔记-Git图谱插件验证.md`、`doc/设计-Git图谱侧边栏插件.md` 等）
**未**随本仓库迁移；如需一并归档，可另行整理。
