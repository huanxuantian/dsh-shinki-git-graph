/*!
 * graph-layout.js — 提交图谱的**唯一真源**：泳道分配 + 泳道配色 + SVG 图元。
 *
 * 为什么不再用「每行一串等宽字形」（v0.8.x 及以前）：那时每列只能画 `│ ● ◉`
 * 三种字符，分叉/合并只表现为「某一列突然变成空格（线断了）」，看不出哪条支线
 * 汇进/分出去；配色还随列号轮换（同一条分支换列即换色）。
 *
 * 本模块按 Git Extensions 的绘制模型重做（参考
 * `src/app/GitUI/UserControls/RevisionGrid/Graph/Rendering/{GraphRenderer,SegmentRenderer}.cs`
 * 与 `docs/macos/reduced-graph-design.md`），要点：
 *
 *   1. **泳道 = 一条「等待某个提交出现」的竖直通道，通道随身携带颜色**：
 *      分支在整幅图里保持同一颜色，只有分叉/合并处才出现第二种颜色
 *      （GE 用 LaneInfo 把颜色挂在「段」上，见 LaneInfo.cs:23-35；本模块挂在
 *      泳道槽位上，语义等价且不需要持久化段对象）。
 *   2. **每行输出图元而不是字符**：
 *      · top[]    —— 行上半段（y ∈ [0, NODE_Y]）：上一行下来的竖直线，
 *                    以及「汇入本行节点」的 S 曲线（分叉/合并的视觉主体）；
 *      · bottom[] —— 行下半段（y ∈ [NODE_Y, ROW_H]）：继续向下的竖直线，
 *                    节点分出到别的泳道的 S 曲线，以及泳道左移（压缩）时的滑移曲线；
 *      · node     —— 提交点（在 client.js 里按 GE 规则画形状：有 ref → 方块，
 *                    HEAD → 加一圈描边；颜色取该泳道颜色）。
 *   3. **泳道每行压缩**：释放掉的空列即时移除，图谱宽度只取决于「同时并存的
 *      分支数」；被释放列右侧的泳道用一条滑移曲线平移过去（GE 的 lane shift）。
 *   4. 所有曲线都是**两端竖直切线**的 S 曲线（smoothstep 形式的三次贝塞尔）。
 *      这正是 GE `SegmentRenderer.cs:79-93` 在「两端都竖直」时使用的配方
 *      （控制点在竖直方向偏移 1/4 行高），好处是：按行切开绘制时，
 *      切点处切线竖直 → 上下两行的线**一阶连续**，不会出现折角。
 *      （GE 默认的 `RenderGraphWithDiagonals=true` 走「斜直段 + 圆角贝塞尔」，
 *      那是为单行高、16px 泳道的桌面表格设计的；本插件行高约 41px、泳道自适应
 *      收窄，斜直段会变成近乎竖直的折线，故采用其 both-perpendicular 配方。）
 *
 * 坐标系：x = 泳道中心（`laneX()` 换算成 px），y 用**标称行高**：
 *   0 = 行顶，NODE_Y = 首行文字中心（默认 12px），ROW_H = 常规行高（默认 41px）。
 * client.js 把 top[] 画在 12px 高、1:1 的 SVG 里（圆点不变形），
 * bottom[] 画在 `top:NODE_Y; height:calc(100% - NODE_Y)` 的 SVG 里并
 * `preserveAspectRatio="none"`（行因 refs 换行变高时上下仍然接得上）。
 *
 * 本文件由 `tool/plugin-sync/inline-git-graph-layout.mjs` 逐字内联进
 * `lib/client.js`（浏览器半包不能 require 兄弟文件），并由
 * `tests/client-inline.test.mjs` 守卫两者一致 —— 改这里就必须重跑内联脚本。
 * 因此本文件**不得** import 任何东西、不得使用 `export {}` / `export default`
 * （内联脚本只识别 `^export ` 前缀）。
 */

/** 泳道调色板（暗色主题可读，复用 v0.8.x 的 LANE_COLORS 以便沿用既有观感）。 */
export const PALETTE = [
  '#d29922', '#f778ba', '#79c0ff', '#7ee787',
  '#ffa657', '#a5d6ff', '#ff7b72', '#8b949e',
];

/** 首行文字中心距行顶的距离（px，对齐 .sgg-row 的 padding 3px + line-height 18px/2）。 */
export const NODE_Y = 12;
/** 常规行高（px）：padding 3+3 + 首行 18 + 次行 ~17；仅作下段 viewBox 的标称高度。 */
export const ROW_H = 41;
/** 泳道间距下限（px）。 */
export const MIN_LANE_W = 7;

/** 泳道间距：泳道多则收窄，保证侧边栏里还看得见文字。 */
export function laneWidth(laneCount) {
  if (laneCount <= 8) return 15;
  if (laneCount <= 14) return 12;
  if (laneCount <= 22) return 9;
  return MIN_LANE_W;
}

/** 提交点半径：随泳道收窄同步缩小，避免相邻节点粘连（GE: 10px 节点 / 16px 泳道）。 */
export function nodeRadius(laneW) {
  if (laneW >= 13) return 4;
  if (laneW >= 10) return 3.4;
  return 2.6;
}

/** 第 col 列泳道中心的 x（px）。 */
export function laneX(col, laneW) {
  return laneW * (col + 0.5);
}

/**
 * 提交点形状（GE `GraphRenderer.cs:92-130` 的规则）：
 * 有 ref（分支/标签/HEAD 指向）→ 方块（一眼看出「这里有个名字」）；
 * 当前 HEAD → 额外一圈描边。合并提交**不**用特殊形状 —— 它靠两条汇入/分出的曲线表达。
 */
export function nodeShape(hasRefs, isHead) {
  return { shape: hasRefs ? 'square' : 'circle', ring: isHead === true };
}

/**
 * 一段线的 SVG `d`：x0===x1 时是竖直线，否则是**两端竖直切线**的三次贝塞尔
 * （控制点落在同一水平中线上 → smoothstep 形态：先竖直离开、再横移、最后竖直进入）。
 */
export function segmentPath(x0, y0, x1, y1) {
  if (x0 === x1) return `M${x0} ${y0}V${y1}`;
  const mid = (y0 + y1) / 2;
  return `M${x0} ${y0}C${x0} ${mid} ${x1} ${mid} ${x1} ${y1}`;
}

/** 一个图元的 `d`（客户端、测试与预览脚本共用同一实现）。 */
export function primPath(prim, laneW) {
  return segmentPath(
    laneX(prim.col, laneW), prim.y0,
    laneX(prim.toCol === undefined ? prim.col : prim.toCol, laneW), prim.y1,
  );
}

/** 图元覆盖到的列（用于把列号映射回「这一列有没有线」）。 */
function primCols(prim) {
  return prim.toCol === undefined ? [prim.col] : [prim.col, prim.toCol];
}

/** 挑一个当前没被占用的调色板颜色；占满则按占用数轮转。 */
function pickColor(used) {
  for (const color of PALETTE) if (!used.includes(color)) return color;
  return PALETTE[used.length % PALETTE.length];
}

/**
 * 计算整页图谱布局。
 *
 * @param {Array<{oid: string, parents: string[]}>} rows 拓扑序（新 → 旧）
 * @param {{lanes?: string[], colors?: string[]}} [options] 上一页的泳道 / 配色状态
 *   （分页「加载更多」时传入，泳道与配色跨页连续，不会换色或断线）
 * @returns {{rows: Array<object>, lanes: string[], colors: string[], laneCount: number}}
 *   每行 `{columns, merge, laneCount, node, top, bottom, colorOf}`：
 *   · `columns`  —— 兼容旧调用方的字形摘要 'node' | 'merge' | 'pass' | 'gap'
 *   · `node`     —— `{col, color, kind:'commit'|'merge'|'root'}`（永远存在）
 *   · `top`/`bottom` —— 图元 `{col, toCol?, y0, y1, color}`
 *   · `colorOf`  —— 该行泳道颜色数组（下标 = 列号）
 */
export function layoutGraph(rows, options = {}) {
  const initialLanes = Array.isArray(options.lanes) ? options.lanes : [];
  const initialColors = Array.isArray(options.colors) ? options.colors : [];
  const later = new Set();
  for (const row of rows) for (const parent of row.parents) later.add(parent);

  let lanes = initialLanes.filter((p) => typeof p === 'string' && p !== '');
  let colors = lanes.map((_, i) => initialColors[i] ?? PALETTE[i % PALETTE.length]);
  let laneCount = lanes.length;
  const out = [];

  for (const row of rows) {
    const before = lanes.slice();
    const beforeColors = colors.slice();

    // ── 1. 本行节点落在哪条泳道（已有就用，没有就新开一条）───────────
    let nodeCol = before.indexOf(row.oid);
    const nodeColor = nodeCol === -1 ? pickColor(colors) : beforeColors[nodeCol];
    if (nodeCol === -1) {
      nodeCol = lanes.length;
      lanes.push(row.oid);
      colors.push(nodeColor);
    }

    // ── 2. 节点泳道让给首父；其余「同样在等本提交」的泳道在本行终结 ──
    //    这类重复泳道正是分叉/合并的另一侧：它在行顶斜插进节点（画 top 曲线）。
    const first = row.parents.length > 0 ? row.parents[0] : null;
    const converging = [];
    for (let i = 0; i < before.length; i += 1) if (i !== nodeCol && before[i] === row.oid) converging.push(i);
    lanes[nodeCol] = first;
    for (const col of converging) lanes[col] = null;

    // ── 3. 其余父提交：并入已有泳道，否则在右侧新开 ──────────────────
    const fresh = new Set(); // 本行新建的泳道（下段直接从节点斜过去）
    for (const parent of row.parents.slice(1)) {
      let col = lanes.indexOf(parent);
      if (col === -1) {
        lanes.push(parent);
        colors.push(pickColor(colors));
        col = lanes.length - 1;
        fresh.add(col);
      }
    }

    // ── 4. 压缩：移除释放出的空列，记录每列压缩前的位置（左移要画滑移曲线）
    const origin = [];
    const afterLanes = [];
    const afterColors = [];
    for (let i = 0; i < lanes.length; i += 1) {
      if (lanes[i] === null) continue;
      afterLanes.push(lanes[i]);
      afterColors.push(colors[i]);
      origin.push(i);
    }
    for (const col of fresh) {
      const j = origin.indexOf(col);
      if (j !== -1) origin[j] = -1; // 新建泳道：下段从节点出发，不存在「原位」
    }

    // ── 5. 图元：上半段（0 → NODE_Y）─────────────────────────────────
    const top = [];
    for (let i = 0; i < before.length; i += 1) {
      if (i === nodeCol) top.push({ col: i, y0: 0, y1: NODE_Y, color: beforeColors[i] });
      else if (before[i] === row.oid) top.push({ col: i, toCol: nodeCol, y0: 0, y1: NODE_Y, color: beforeColors[i] });
      else top.push({ col: i, y0: 0, y1: NODE_Y, color: beforeColors[i] });
    }

    // ── 6. 图元：下半段（NODE_Y → ROW_H）────────────────────────────
    const bottom = [];
    for (let j = 0; j < afterLanes.length; j += 1) {
      // 新建泳道 / 节点泳道：从节点出发；直通泳道：自压缩前的原位下来（可能左移）
      const from = origin[j] === -1 || origin[j] === nodeCol ? nodeCol : origin[j];
      bottom.push({ col: from, toCol: j, y0: NODE_Y, y1: ROW_H, color: afterColors[j] });
    }

    // ── 7. 兼容旧调用方的字形摘要 ───────────────────────────────────
    // 节点可能开在比 before/after 都靠右的新列（末行常有），宽度必须罩住它。
    const rowWidth = Math.max(before.length, afterLanes.length, nodeCol + 1);
    const columns = [];
    for (let i = 0; i < rowWidth; i += 1) {
      if (i === nodeCol) columns.push(row.parents.length > 1 ? 'merge' : 'node');
      else if ([...top, ...bottom].some((p) => primCols(p).includes(i))) columns.push('pass');
      else columns.push('gap');
    }

    laneCount = Math.max(laneCount, rowWidth);
    lanes = afterLanes;
    colors = afterColors;
    out.push({
      columns,
      merge: row.parents.length > 1,
      laneCount: rowWidth,
      colorOf: afterColors.slice(),
      node: {
        col: nodeCol,
        color: nodeColor,
        kind: row.parents.length === 0 ? 'root' : row.parents.length > 1 ? 'merge' : 'commit',
      },
      top,
      bottom,
    });
  }

  return { rows: out, lanes, colors, laneCount };
}

/**
 * 旧接口（`lib/lanes.js` 与 v0.8.x 调用方）：只返回每行 `{columns, merge}` 与数组上的
 * `tail`。由 layoutGraph 派生，不再单独实现，因此不会再出现「两份泳道算法各自漂移」。
 */
export function assignLanes(rows, initialLanes = []) {
  const layout = layoutGraph(rows, { lanes: initialLanes });
  const maps = layout.rows.map((r) => ({ columns: r.columns, merge: r.merge }));
  maps.tail = layout.lanes;
  return maps;
}
