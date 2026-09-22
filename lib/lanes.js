/**
 * 兼容层：泳道/配色/图元算法现在只有一份实现 —— `lib/graph-layout.js`。
 *
 * v0.8.x 及以前本文件是一份「每列只画 `│ ● ◉` 字符」的最小泳道分配器（移植自
 * 上游 `@linxin666/dsh-client-ui-git-graph` 的 `assignLanes`），并在 `lib/client.js`
 * 里手工维护一份内联副本。v0.9.0 起改为 Git Extensions 风格的曲线分支树，
 * 算法升级为「泳道 + 稳定配色 + SVG 图元」，因此把实现收敛到 graph-layout.js，
 * 本文件只保留旧入口名，避免调用方/测试改 import 路径。
 *
 * 注意：`assignLanes` 返回的 `columns` 是 layoutGraph 的**字形摘要**，语义与 v0.8.x
 * 不再逐字相同 —— 分叉/合并处不再出现断线（'gap'），那一段现在是画进节点的曲线。
 */
export { assignLanes, layoutGraph } from './graph-layout.js';
