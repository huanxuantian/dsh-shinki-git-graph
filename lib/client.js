/*!
 * dsh-shinki-git-graph client bundle (browser half).
 *
 * Registers a sidebar tab ("Git 图谱") through the dsh-better-sidebar
 * `ctx.betterSidebar` service and renders: branch scope selector, branch
 * tree (local/remote groups), a Git Extensions style commit graph (curved
 * lane branches, stable per-branch colors, square nodes for refs, a ring for
 * HEAD), and expandable commit details (metadata + file stats + collapsible diff).
 *
 * The graph data (parents per commit) comes from the host half's
 * POST /shinki-git/api routes; lanes, colors and the SVG primitives are
 * computed by lib/graph-layout.js, which is inlined below (see
 * tool/plugin-sync/inline-git-graph-layout.mjs — the browser half cannot
 * require sibling files; tests/client-inline.test.mjs guards the copy).
 */
window.__ModuleLoader__.load({
  id: 'dsh-shinki-git-graph',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    let react = require('react');
    // rc.1 起 host 不再提供 @deepseek-ai/dsh-client-ui-primitives → 内联本地线性图标
    // （16px，stroke=currentColor 随主题前景色；与旧 primitives.Icon*Outline16 同签名 {size}）
    const _svg = (d, size) => react.createElement('svg', {
      width: size || 16, height: size || 16, viewBox: '0 0 16 16',
      fill: 'none', stroke: 'currentColor', strokeWidth: 1.5,
      strokeLinecap: 'round', strokeLinejoin: 'round',
    }, react.createElement('path', { d }));
    const primitives = {
      IconBranchOutline16: (p) => _svg('M4 2v12M4 4.5h3.2a1.8 1.8 0 0 1 1.8 1.8v1.4a1.8 1.8 0 0 0 1.8 1.8H14', p && p.size),
      IconTrashOutline16: (p) => _svg('M3 4h10M6.4 4V2.4h3.2V4M5 4l.6 9.4a1 1 0 0 0 1 .9h2.8a1 1 0 0 0 1-.9L11 4', p && p.size),
      IconRefreshOutline16: (p) => _svg('M13.2 8a5.2 5.2 0 1 1-1.6-3.7M13.2 2.4v2.4h-2.4', p && p.size),
      IconFullscreenOutline16: (p) => _svg('M6 2.5H2.5V6M10 2.5h3.5V6M6 13.5H2.5V10M10 13.5h3.5V10', p && p.size),
      // 标签：圆角标签牌 + 圆孔（圆孔用 h.01 配合 round cap 画成点）
      IconTagOutline16: (p) => _svg('M2.6 7.7V3.5a.9.9 0 0 1 .9-.9h4.2l5.7 5.7a1 1 0 0 1 0 1.4l-3.3 3.3a1 1 0 0 1-1.4 0L2.9 8.6a.9.9 0 0 1-.3-.9zM5.4 5.4h.01', p && p.size),
      // 远程分支：云
      IconRemoteOutline16: (p) => _svg('M4.9 12.4h6.2a2.5 2.5 0 0 0 .3-5 3.5 3.5 0 0 0-6.7-.6 2.8 2.8 0 0 0 .2 5.6z', p && p.size),
    };
    const { useState, useEffect, useCallback, useMemo, useRef, Fragment } = react;

    // ── helpers ──────────────────────────────────────────────────────────
    const h = (type, props, ...children) => react.createElement(type, props ?? null, ...children);

    /** POST one /shinki-git/api method. */
    function apiPost(method, sessionId, payload, signal) {
      return fetch('/shinki-git/api', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, method, ...(payload ?? {}) }),
        signal,
      }).then(async (res) => {
        const body = await res.json().catch(() => ({ ok: false, error: { code: 'bad-response', message: '无效响应' } }));
        if (!res.ok || body.ok !== true) {
          const err = new Error(body?.error?.message ?? `HTTP ${res.status}`);
          err.code = body?.error?.code ?? 'http-' + res.status;
          throw err;
        }
        // The host reports soft failures (git-missing / not-a-repo) as
        // HTTP 200 with value.error — surface them as thrown errors so
        // callers can branch on err.code (e.g. load() → git-missing).
        if (body.value && typeof body.value === 'object' && body.value.error) {
          const err = new Error(body.value.message ?? body.value.error);
          err.code = body.value.error;
          throw err;
        }
        return body.value;
      });
    }

    /** Ref names of one log row's decorations (same rule as the built-in GitView). */
    function refNames(refs) {
      return [...new Set(
        String(refs || '')
          .split(',')
          .map((ref) => ref.trim())
          .filter((ref) => ref !== '')
          .map((ref) => (ref.includes(' -> ') ? ref.slice(ref.indexOf(' -> ') + 4) : ref))
          .map((ref) => (ref.startsWith('tag: ') ? ref.slice(5) : ref))
      )];
    }

    /** Ref list with tag distinction: [{name, isTag}] (deduped). */
    function refsList(refs) {
      const out = [];
      const seen = new Set();
      for (const raw of String(refs || '').split(',')) {
        const r = raw.trim();
        if (r === '') continue;
        let name = r;
        if (name.includes(' -> ')) name = name.slice(name.indexOf(' -> ') + 4);
        let isTag = false;
        if (name.startsWith('tag: ')) { name = name.slice(5); isTag = true; }
        if (seen.has(name)) continue;
        seen.add(name);
        out.push({ name, isTag });
      }
      return out;
    }

    /** Whether this log row is the commit HEAD points at: `%D` carries either
     *  'HEAD -> <branch>' (attached) or a bare 'HEAD' (detached). Used for the
     *  node's HEAD ring, exactly like Git Extensions' `hasOutline`. */
    function isHeadRow(row) {
      return String(row.refs || '').split(',').some((ref) => {
        const name = ref.trim();
        return name === 'HEAD' || name.startsWith('HEAD -> ');
      });
    }

    /** The XY status letter a worktree row badge shows (X=index, Y=worktree). */
    function badgeOf(entry) {
      const index = entry.xy[0];
      const worktree = entry.xy[1];
      if (index !== undefined && index !== ' ' && index !== '?') return index;
      if (worktree !== undefined && worktree !== ' ' && worktree !== '?') return worktree;
      return '?';
    }

    /** Relative time for an ISO date string (mirrors the built-in formatting). */
    function relativeTime(iso) {
      const time = new Date(iso).getTime();
      if (Number.isNaN(time)) return iso;
      const elapsed = Date.now() - time;
      const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
      if (elapsed < MINUTE) return t('justNow');
      if (elapsed < HOUR) return t('minutesAgo', { count: Math.floor(elapsed / MINUTE) });
      if (elapsed < DAY) return t('hoursAgo', { count: Math.floor(elapsed / HOUR) });
      if (elapsed < 30 * DAY) return t('daysAgo', { count: Math.floor(elapsed / DAY) });
      return new Date(iso).toLocaleDateString();
    }

    // 图谱布局/配色/曲线几何的唯一真源在 lib/graph-layout.js，由
    // `node tool/plugin-sync/inline-git-graph-layout.mjs` 内联到下面这段标记区
    // （浏览器半包不能 require 兄弟文件）。改算法请改真源后重跑该脚本；
    // tests/client-inline.test.mjs 会守住两者逐字一致。
    //#region INLINE:lib/graph-layout.js
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

    /**
     * 泳道调色板：**通过 CSS 变量取色**，深浅主题各自一套（定义在 client.js 的 CSS 里，
     * 浅色挂在 `:root`、深色挂在 `body[data-ds-dark-theme]`——后者是宿主主题服务的开关）。
     * 这样泳道颜色、分支树圆点、节点填充都会随主题自动切换，不需要 JS 侦测主题；
     * 也让「浅色主题下深色专用色几乎看不见」这类问题在 CSS 层就能被审计（见 tests/theme.test.mjs
     * 的 WCAG 对比度断言）。具体色值与对比度见 README「主题」一节。
     */
    const PALETTE = [
      'var(--sgg-lane-1)', 'var(--sgg-lane-2)', 'var(--sgg-lane-3)', 'var(--sgg-lane-4)',
      'var(--sgg-lane-5)', 'var(--sgg-lane-6)', 'var(--sgg-lane-7)', 'var(--sgg-lane-8)',
    ];

    /** 首行文字中心距行顶的距离（px，对齐 .sgg-row 的 padding 3px + line-height 18px/2）。 */
    const NODE_Y = 12;
    /** 常规行高（px）：padding 3+3 + 首行 18 + 次行 ~17；仅作下段 viewBox 的标称高度。 */
    const ROW_H = 41;
    /** 泳道间距下限（px）。 */
    const MIN_LANE_W = 7;

    /** 泳道间距：泳道多则收窄，保证侧边栏里还看得见文字。 */
    function laneWidth(laneCount) {
      if (laneCount <= 8) return 15;
      if (laneCount <= 14) return 12;
      if (laneCount <= 22) return 9;
      return MIN_LANE_W;
    }

    /** 提交点半径：随泳道收窄同步缩小，避免相邻节点粘连（GE: 10px 节点 / 16px 泳道）。 */
    function nodeRadius(laneW) {
      if (laneW >= 13) return 4;
      if (laneW >= 10) return 3.4;
      return 2.6;
    }

    /** 第 col 列泳道中心的 x（px）。 */
    function laneX(col, laneW) {
      return laneW * (col + 0.5);
    }

    /**
     * 提交点形状（GE `GraphRenderer.cs:92-130` 的规则）：
     * 有 ref（分支/标签/HEAD 指向）→ 方块（一眼看出「这里有个名字」）；
     * 当前 HEAD → 额外一圈描边。合并提交**不**用特殊形状 —— 它靠两条汇入/分出的曲线表达。
     */
    function nodeShape(hasRefs, isHead) {
      return { shape: hasRefs ? 'square' : 'circle', ring: isHead === true };
    }

    /**
     * 一段线的 SVG `d`：x0===x1 时是竖直线，否则是**两端竖直切线**的三次贝塞尔
     * （控制点落在同一水平中线上 → smoothstep 形态：先竖直离开、再横移、最后竖直进入）。
     */
    function segmentPath(x0, y0, x1, y1) {
      if (x0 === x1) return `M${x0} ${y0}V${y1}`;
      const mid = (y0 + y1) / 2;
      return `M${x0} ${y0}C${x0} ${mid} ${x1} ${mid} ${x1} ${y1}`;
    }

    /** 一个图元的 `d`（客户端、测试与预览脚本共用同一实现）。 */
    function primPath(prim, laneW) {
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
    function layoutGraph(rows, options = {}) {
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
    function assignLanes(rows, initialLanes = []) {
      const layout = layoutGraph(rows, { lanes: initialLanes });
      const maps = layout.rows.map((r) => ({ columns: r.columns, merge: r.merge }));
      maps.tail = layout.lanes;
      return maps;
    }
    //#endregion INLINE:lib/graph-layout.js

    /** 泳道调色板 = graph-layout 的 PALETTE（分支树圆点复用同一套颜色）。 */
    const LANE_COLORS = PALETTE;

    /** How many subdirectory repos the collapsed repo list shows per page. */
    const REPO_PAGE = 20;
    /** Status groups with more visible items than this collapse by default
     *  after each refresh (issue #3: staged/unstaged/untracked collapse). */
    const WT_GROUP_COLLAPSE_MAX = 5;

    // ── persisted settings ───────────────────────────────────────────────
    // Two layers: the dsh-better-sidebar pluginSettings blob (declarative
    // setting rows in the side-card settings page, v0.12+) is authoritative;
    // localStorage remains a fallback for hosts without the settings seam.
    const store = {
      get(key, fallback) {
        try {
          const v = window.localStorage.getItem(`${NS}:${key}`);
          return v === null ? fallback : v;
        } catch { return fallback; }
      },
      set(key, value) {
        try { window.localStorage.setItem(`${NS}:${key}`, String(value)); } catch { /* ignore */ }
      },
    };
    /** The descriptor's pluginSettings blob from the sidebar store, if any. */
    function pluginBlobOf(sidebarStore) {
      try {
        return sidebarStore?.getPrefs?.()?.pluginSettings?.[name] ?? {};
      } catch { return {}; }
    }
    /** Persist one setting to both layers (pluginSettings first, then localStorage). */
    function persistSetting(sidebarStore, key, value) {
      try {
        store.set(key, value);
        if (sidebarStore && typeof sidebarStore.getPrefs === 'function') {
          const prefs = sidebarStore.getPrefs();
          const blob = { ...(prefs.pluginSettings?.[name] ?? {}), [key]: value };
          sidebarStore.setPrefs?.({
            ...prefs,
            pluginSettings: { ...(prefs.pluginSettings ?? {}), [name]: blob },
          });
        }
      } catch { /* ignore */ }
    }
    /** Read a string setting: pluginSettings blob first, localStorage fallback. */
    function readSetting(sidebarStore, key, fallback) {
      const blob = pluginBlobOf(sidebarStore);
      const v = blob[key];
      return v === undefined || v === null ? store.get(key, fallback) : String(v);
    }
    /** Read a boolean setting with the same layering. */
    function readBoolSetting(sidebarStore, key, fallback) {
      const blob = pluginBlobOf(sidebarStore);
      const v = blob[key];
      if (v === undefined || v === null) return store.get(key, fallback ? '1' : '0') !== '0';
      return v === true || v === '1';
    }
    /** Session-scoped flag (survives tab switches in this app session, resets
     *  on restart): "auto-link upstream when checking out the current branch". */
    const sessionStore = {
      get(key, fallback) {
        try {
          const v = window.sessionStorage.getItem(`${NS}:${key}`);
          return v === null ? fallback : v;
        } catch { return fallback; }
      },
      set(key, value) {
        try { window.sessionStorage.setItem(`${NS}:${key}`, String(value)); } catch { /* ignore */ }
      },
    };

    // ── locale ───────────────────────────────────────────────────────────
    const NS = 'shinkiGitGraph';
    const zh = {
      tabTitle: 'Git 图谱',
      scope: '分支范围',
      scopeCurUp: '当前分支 + 上游',
      scopeAll: '全部本地和远程分支',
      refresh: '刷新',
      local: '本地',
      remote: '远程',
      current: '当前',
      upstream: '上游',
      loading: '加载中…',
      loadMore: '加载更多',
      notRepo: '当前工作区不是 Git 仓库',
      subrepos: '工作区包含多个 Git 仓库',
      subreposHint: '工作区本身不是 Git 仓库，已探测到以下子目录 Git 仓库，点击进入管理',
      noSubRepos: '未在工作区子目录中检测到 Git 仓库',
      repoCount: '{count} 个仓库',
      backToList: '返回仓库列表',
      loadMoreRepos: '加载更多仓库',
      noSession: '等待工作区会话…',
      noSessionHint: '打开或选择一个工作区后自动加载',
      noSessionStopped: '未检测到可用的工作区会话（已停止自动重试）',
      noSessionStoppedHint: '打开或新建该工作区的会话后点「重试」；本面板不会一直自动刷新',
      gitMissing: 'git 不可用，请安装 git 后重试',
      noUpstream: '（无上游远程分支）',
      noCommits: '没有提交记录',
      error: '加载失败',
      retry: '重试',
      expanded: '收起',
      collapsed: '展开',
      author: '作者',
      committer: '提交者',
      parents: '父提交',
      mergeCommit: '合并提交',
      files: '变更文件',
      copyHash: '复制 hash',
      copied: '已复制',
      showDiff: '显示完整 diff',
      hideDiff: '收起 diff',
      diffTitle: '提交详情',
      filterHint: '勾选分支以过滤（不勾选 = 显示全部）',
      justNow: '刚刚',
      minutesAgo: '{count} 分钟前',
      hoursAgo: '{count} 小时前',
      daysAgo: '{count} 天前',
      workAction: '工作区操作…',
      pageSizeSetting: '页大小…',
      pageSizeHint: '图谱每次加载的提交行数',
      settingScope: '分支范围',
      settingScopeCurUp: '当前分支 + 上游',
      settingScopeAll: '全部本地和远程分支',
      settingPageSize: '页大小',
      settingShowTags: '显示标签',
      stageAll: '暂存全部',
      unstageAll: '取消暂存全部',
      discardAll: '丢弃全部更改',
      commit: '提交',
      cancel: '取消',
      confirmDelete: '删除文件',
      confirmDiscard: '确认丢弃',
      confirmDelUntracked: '此文件为未跟踪新文件，丢弃将删除该文件：',
      dangerUntrackedDelete: '危险操作：对于未跟踪文件，删除将从文件系统中删除，可能无法恢复。',
      confirmCheck1: '我确认要删除该文件',
      confirmCheck2: '该文件为未跟踪新文件，删除后无法恢复',
      confirmCheck3: '我确认执行删除操作',
      confirmDiscardFile: '丢弃该文件的未提交更改（复位到上次提交状态）：',
      confirmDiscardCheck: '我确认丢弃该文件的未提交更改',
      confirmDiscardAll: '确认丢弃全部未暂存更改？已跟踪文件将复位到上次提交状态（未跟踪文件不受影响）。此操作不可撤销。',
      confirmDiscardAllBtn: '确认丢弃全部',
      commitInputPlaceholder: '输入提交信息…（Ctrl+Enter 提交）',
      commitMsgHint: '第 1 行：概述（必填）\n第 2 行：建议留空\n第 3 行起：详情',
      signOff: '添加 Signed-off-by 签名',
      signNamePlaceholder: '姓名，如 张三',
      signEmailPlaceholder: '邮箱，如 zhang@example.com',
      signedOffBy: 'Signed-off-by: ',
      signOffIncomplete: '请填写 sign-off 姓名与邮箱后再提交',
      expandAll: '展开全部',
      collapseAll: '折叠全部',
      openInFileManager: '用内置文件管理器打开',
      openInFmUnavailable: '当前环境不支持用内置文件管理器打开',
      uncommitted: '未提交的更改',
      worktreeArea: '暂存区',
      worktreeClean: '工作区干净',
      worktreeCleanHint: '没有未提交的更改',
      staged: '已暂存',
      unstaged: '未暂存',
      untracked: '未跟踪',
      stage: '暂存',
      unstage: '取消暂存',
      discard: '丢弃更改',
      viewDiff: '查看 diff',
      copyShortHash: '复制短 hash',
      copyFullHash: '复制完整 hash',
      copySubject: '复制提交主题',
      showTags: '显示标签',
      showAllRepo: '显示整个仓库修改内容',
      expand: '展开详情',
      tags: '标签',
      checkout: '切换分支',
      checkoutTo: '检出到分支…',
      checkoutToHint: '将 HEAD 切换到所选分支（工作区随之切换）',
      linkCurrentOptIn: '检出当前分支时自动补齐上游（仅本次会话）',
      createBranch: '新建分支…',
      createFromHere: '基于此新建分支',
      createBranchHere: '在此提交新建分支…',
      checkoutCommit: '检出此提交（detached）',
      branchName: '分支名',
      branchNamePlaceholder: '输入新分支名…',
      baseBranch: '基于分支',
      commitPrefix: '此提交',
      dirtyCheckoutMsg: '工作区有未提交更改，切换分支将携带这些更改。是否继续？',
      dirtyCreateMsg: '工作区有未提交更改，新建分支将携带这些更改。是否继续？',
      dirtyDetachMsg: '工作区有未提交更改，检出提交将进入 detached HEAD。是否继续？',
      detachedHead: '游离 HEAD',
      pull: '拉取',
      push: '推送',
      fetchAll: '拉取全部（fetch --all）',
      fetchAllDone: '已拉取全部远程',
      syncRemote: '远程',
      syncBranch: '分支',
      noBranches: '（无可用分支）',
      syncType: '类型',
      typeBranch: '分支',
      typeTag: '标签',
      tagCustom: '自定义标签…',
      tagInputPlaceholder: '输入标签名…',
      pullFetchOnly: '仅拉取（fetch，不合并/不签出）',
      pullRebase: '变基拉取（--rebase）',
      pushSetUpstream: '设置上游（-u）',
      aheadBehindNotice: '推送前提示：领先 {ahead} · 落后 {behind}',
      noRemote: '未配置远程仓库',
      syncDone: '操作完成',
      blankBranchCreated: '分支已创建（首次提交后生效）',
      promptTitle: 'Git 需要认证',
      promptPassword: '密码',
      promptOk: '确认',
      promptCancel: '取消',
      credSaved: '凭据已交由凭据助手保存（{helper}），下次不再询问',
      credNotSaved: '未配置凭据助手：本次凭据不会被记住，每次推送都会在此处询问',
    };
    const en = {
      tabTitle: 'Git Graph',
      scope: 'Branches',
      scopeCurUp: 'Current + upstream',
      scopeAll: 'All local & remote',
      refresh: 'Refresh',
      local: 'Local',
      remote: 'Remote',
      current: 'current',
      upstream: 'upstream',
      loading: 'Loading…',
      loadMore: 'Load more',
      notRepo: 'The current workspace is not a git repository',
      subrepos: 'Workspace contains multiple git repositories',
      subreposHint: 'The workspace itself is not a git repository; these subdirectory git repositories were found. Click one to manage it.',
      noSubRepos: 'No git repositories found in workspace subdirectories',
      repoCount: '{count} repositories',
      backToList: 'Back to repo list',
      loadMoreRepos: 'Load more repositories',
      noSession: 'Waiting for a workspace session…',
      noSessionHint: 'Opens automatically once a workspace is selected',
      noSessionStopped: 'No usable workspace session (auto-retry stopped)',
      noSessionStoppedHint: 'Open or create a session for this workspace, then Retry — this panel no longer refreshes forever',
      gitMissing: 'git is unavailable — install git and retry',
      noUpstream: '(no upstream remote branch)',
      noCommits: 'No commits',
      error: 'Failed to load',
      retry: 'Retry',
      expanded: 'Collapse',
      collapsed: 'Expand',
      author: 'Author',
      committer: 'Committer',
      parents: 'Parents',
      mergeCommit: 'Merge commit',
      files: 'Files changed',
      copyHash: 'Copy hash',
      copied: 'Copied',
      showDiff: 'Show full diff',
      hideDiff: 'Hide diff',
      diffTitle: 'Commit details',
      filterHint: 'Check branches to filter (none checked = show all)',
      justNow: 'just now',
      minutesAgo: '{count} minutes ago',
      hoursAgo: '{count} hours ago',
      daysAgo: '{count} days ago',
      workAction: 'Workspace actions…',
      pageSizeSetting: 'Page size…',
      pageSizeHint: 'Commits loaded per page',
      settingScope: 'Branch scope',
      settingScopeCurUp: 'Current + upstream',
      settingScopeAll: 'All local & remote',
      settingPageSize: 'Page size',
      settingShowTags: 'Show tags',
      stageAll: 'Stage all',
      unstageAll: 'Unstage all',
      discardAll: 'Discard all changes',
      commit: 'Commit',
      cancel: 'Cancel',
      confirmDelete: 'Delete file',
      confirmDiscard: 'Confirm discard',
      confirmDelUntracked: 'This is an untracked new file; discarding will DELETE it:',
      dangerUntrackedDelete: 'DANGER: for untracked files, deletion removes them from the filesystem and may be unrecoverable.',
      confirmCheck1: 'I confirm I want to delete this file',
      confirmCheck2: 'This is an untracked new file; deletion cannot be undone',
      confirmCheck3: 'I confirm executing the deletion',
      confirmDiscardFile: 'Discard uncommitted changes of this file (restore to last commit):',
      confirmDiscardCheck: 'I confirm discarding this file\'s uncommitted changes',
      confirmDiscardAll: 'Discard all unstaged changes? Tracked files will be restored to the last commit (untracked files are not affected). This cannot be undone.',
      confirmDiscardAllBtn: 'Discard all',
      commitInputPlaceholder: 'Type commit message… (Ctrl+Enter to commit)',
      commitMsgHint: 'Line 1: summary (required)\nLine 2: leave blank\nLine 3+: details',
      signOff: 'Add Signed-off-by',
      signNamePlaceholder: 'Name, e.g. Alice',
      signEmailPlaceholder: 'Email, e.g. alice@example.com',
      signedOffBy: 'Signed-off-by: ',
      signOffIncomplete: 'Fill in the sign-off name and email before committing',
      expandAll: 'Expand all',
      collapseAll: 'Collapse all',
      openInFileManager: 'Open in built-in file manager',
      openInFmUnavailable: 'Built-in file manager is unavailable in this environment',
      uncommitted: 'Uncommitted changes',
      worktreeArea: 'Staging area',
      worktreeClean: 'Working tree clean',
      worktreeCleanHint: 'No uncommitted changes',
      staged: 'Staged',
      unstaged: 'Unstaged',
      untracked: 'Untracked',
      stage: 'Stage',
      unstage: 'Unstage',
      discard: 'Discard changes',
      viewDiff: 'View diff',
      copyShortHash: 'Copy short hash',
      copyFullHash: 'Copy full hash',
      copySubject: 'Copy subject',
      showTags: 'Show tags',
      showAllRepo: 'Show all repository changes',
      expand: 'Expand details',
      tags: 'Tags',
      checkout: 'Checkout',
      checkoutTo: 'Checkout to branch…',
      checkoutToHint: 'Point HEAD at the selected branch (working tree switches with it)',
      linkCurrentOptIn: 'Auto-link upstream when checking out the current branch (this session only)',
      createBranch: 'Create branch…',
      createFromHere: 'Create branch from here',
      createBranchHere: 'Create branch here…',
      checkoutCommit: 'Checkout commit (detached)',
      branchName: 'Branch name',
      branchNamePlaceholder: 'New branch name…',
      baseBranch: 'From branch',
      commitPrefix: 'This commit',
      dirtyCheckoutMsg: 'The working tree has uncommitted changes; switching will carry them along. Continue?',
      dirtyCreateMsg: 'The working tree has uncommitted changes; creating a branch will carry them along. Continue?',
      dirtyDetachMsg: 'The working tree has uncommitted changes; checking out a commit enters detached HEAD. Continue?',
      detachedHead: 'detached HEAD',
      pull: 'Pull',
      push: 'Push',
      fetchAll: 'Fetch all (--all)',
      fetchAllDone: 'Fetched all remotes',
      syncRemote: 'Remote',
      syncBranch: 'Branch',
      noBranches: '(no branches available)',
      syncType: 'Type',
      typeBranch: 'Branch',
      typeTag: 'Tag',
      tagCustom: 'Custom tag…',
      tagInputPlaceholder: 'Type a tag name…',
      pullFetchOnly: 'Fetch only (no merge / checkout)',
      pullRebase: 'Rebase pull (--rebase)',
      pushSetUpstream: 'Set upstream (-u)',
      aheadBehindNotice: 'Before push: {ahead} ahead · {behind} behind',
      noRemote: 'No remotes configured',
      syncDone: 'Done',
      blankBranchCreated: 'Branch created (takes effect after the first commit)',
      promptTitle: 'Git authentication required',
      promptPassword: 'Password',
      promptOk: 'OK',
      promptCancel: 'Cancel',
      credSaved: 'Credential stored by {helper} — you will not be asked again',
      credNotSaved: 'No credential helper configured: this credential is not remembered — each push will ask here again',
    };
    const DICTS = { zh, en };
    const activeLocale = () => {
      try {
        const a = (typeof nw !== 'undefined' && nw) ? 'zh' : (navigator.language || 'zh');
        return a.toLowerCase().startsWith('zh') ? 'zh' : 'en';
      } catch { return 'zh'; }
    };
    let t = (key, vars) => {
      const dict = DICTS[activeLocale()] ?? zh;
      let s = dict[key] ?? key;
      if (vars) for (const [k, v] of Object.entries(vars)) s = s.replace(`{${k}}`, String(v));
      return s;
    };

    // ── styles ───────────────────────────────────────────────────────────
    const CSS = `
/* ── 主题取色 tokens（v0.9.1）─────────────────────────────────────────────
   宿主主题服务用 body[data-ds-dark-theme] 切换深浅色（浅色=无该属性），皮肤/自定义主题
   只改 --dsw-* 的值、不改这个开关，所以按它取色与宿主自身一致。
   浅色主题若沿用深色专用的高亮色，泳道线在 #f9fafb 上只有 1.5~2.9:1（几乎看不见），
   因此每个 token 都有两套值；对比度由 tests/theme.test.mjs 按 WCAG 断言：
   泳道线（图形）≥3:1、徽标/diff 文本 ≥4.5:1。 */
:root{
--sgg-lane-1:#9a6700;--sgg-lane-2:#bf3989;--sgg-lane-3:#0969da;--sgg-lane-4:#1a7f37;
--sgg-lane-5:#bc4c00;--sgg-lane-6:#1b7c83;--sgg-lane-7:#cf222e;--sgg-lane-8:#57606a;
--sgg-ref-fg:#0550ae;--sgg-ref-bg:rgba(9,105,218,.10);--sgg-ref-line:rgba(9,105,218,.45);
--sgg-ref-current-fg:#116329;--sgg-ref-current-bg:rgba(26,127,55,.12);--sgg-ref-current-line:rgba(26,127,55,.45);
--sgg-ref-tag-fg:#7d4e00;--sgg-ref-tag-bg:rgba(154,103,0,.12);--sgg-ref-tag-line:rgba(154,103,0,.45);
--sgg-add:#1a7f37;--sgg-del:#cf222e;--sgg-hunk:#0969da;
--sgg-success:#1a7f37;--sgg-danger:#cf222e;--sgg-warn:#9a6700}
body[data-ds-dark-theme],html[data-ds-dark-theme]{
--sgg-lane-1:#d29922;--sgg-lane-2:#f778ba;--sgg-lane-3:#79c0ff;--sgg-lane-4:#7ee787;
--sgg-lane-5:#ffa657;--sgg-lane-6:#a5d6ff;--sgg-lane-7:#ff7b72;--sgg-lane-8:#8b949e;
--sgg-ref-fg:#79c0ff;--sgg-ref-bg:rgba(77,159,255,.16);--sgg-ref-line:rgba(121,192,255,.50);
--sgg-ref-current-fg:#7ee787;--sgg-ref-current-bg:rgba(46,160,67,.18);--sgg-ref-current-line:rgba(126,231,135,.50);
--sgg-ref-tag-fg:#d29922;--sgg-ref-tag-bg:rgba(210,153,34,.16);--sgg-ref-tag-line:rgba(210,153,34,.50);
--sgg-add:#7ee787;--sgg-del:#ff7b72;--sgg-hunk:#79c0ff;
--sgg-success:#7ee787;--sgg-danger:#ff7b72;--sgg-warn:#d29922}
[data-dsh-plugin="dsh-shinki-git-graph"]{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-primary,#e6edf3)}
.sgg-header{display:flex;align-items:center;gap:6px;padding:6px 8px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.08))}
.sgg-scope{flex:1;min-width:0;background:var(--dsw-alias-bg-layer-2,transparent);color:var(--dsw-alias-label-primary,#e6edf3);border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.1));border-radius:6px;padding:3px 6px;font-size:12px;outline:none}
.sgg-ver{flex:none;font-size:10px;color:var(--dsw-alias-label-tertiary,#8b949e);user-select:none}
.sgg-iconbtn{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border:none;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,#9da7b3);cursor:pointer;flex:none}
.sgg-iconbtn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06));color:var(--dsw-alias-label-primary,#e6edf3)}
.sgg-iconbtn:disabled{opacity:.5;cursor:default}
.sgg-tree{padding:4px 8px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.06))}
.sgg-tree-group{font-size:11px;color:var(--dsw-alias-label-tertiary,#8b949e);text-transform:uppercase;letter-spacing:.04em;margin:6px 0 2px;display:flex;align-items:center;gap:4px}
.sgg-tree-row{display:flex;align-items:center;gap:6px;padding:2px 4px;border-radius:4px;cursor:pointer;min-width:0}
.sgg-tree-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06))}
.sgg-tree-row.sgg-current{color:var(--dsw-alias-label-primary,#e6edf3)}
.sgg-tree-check{flex:none;accent-color:var(--dsw-alias-brand-primary,#4d9fff)}
.sgg-tree-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sgg-branch-dot{width:8px;height:8px;border-radius:50%;flex:none;background:transparent}
.sgg-tree-tag{flex:none;font-size:10px;padding:0 5px;border-radius:8px;background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08));color:var(--dsw-alias-label-secondary,#9da7b3)}
.sgg-hint{font-size:10px;color:var(--dsw-alias-label-tertiary,#8b949e);padding:2px 4px}
.sgg-list{padding:4px 0 8px;overflow-y:auto;flex:1;min-height:0}
/* 图谱列必须**贯穿整行**：行的竖直内边距放在 .sgg-main 上，.sgg-row 只留左右内边距。
   否则图谱列被行的 3px 上下 padding 夹住 → 每两行之间断线 ~6px（v0.9.0 首版踩过）。 */
.sgg-row{display:flex;align-items:flex-start;gap:6px;padding:0 8px;cursor:pointer;border-radius:0;min-width:0}
.sgg-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.05))}
.sgg-row.sgg-open{background:var(--dsw-alias-interactive-bg-hover-accent,rgba(77,159,255,.12))}
/* 图谱列：上下两层 SVG —— 下层（纵向拉伸）画向下的线与扇出曲线，上层（y 方向 1:1，含节点）
   画向上的线、汇入曲线与提交点；节点在上层末尾绘制，正好盖住下层的线头。
   两层都 width:100% + preserveAspectRatio=none → x 映射完全一致（行宽被 max-width 收窄时
   一起等比压缩，不会出现「线在左、节点在右」）。max-width 限制图谱占行宽的比例。
   ⚠ 三层都不裁剪：圆头线帽会各向外伸出 1px，正好跨过行边界把接缝糊住（裁剪掉就可能在
   小数设备像素上露出一条亮缝）。 */
.sgg-graph{position:relative;flex:none;align-self:stretch;min-height:28px;max-width:62%}
.sgg-graph-down{position:absolute;left:0;top:12px;width:100%;height:calc(100% - 12px);overflow:visible}
.sgg-graph-up{position:absolute;left:0;top:0;overflow:visible}
.sgg-graph path{fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.sgg-main{flex:1;min-width:0;padding:3px 0}
.sgg-line1{display:flex;align-items:baseline;gap:6px;min-width:0}
.sgg-hash{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10.5px;color:var(--dsw-alias-label-tertiary,#8b949e);flex:none}
.sgg-subject{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary,#e6edf3)}
.sgg-line2{display:flex;align-items:center;gap:6px;margin-top:1px;flex-wrap:wrap}
.sgg-ref{display:inline-flex;align-items:center;gap:3px;max-width:100%;min-width:0;font-size:10px;line-height:1.4;padding:0 5px;border-radius:8px;border:1px solid var(--sgg-ref-line);background:var(--sgg-ref-bg);color:var(--sgg-ref-fg);flex:none}
.sgg-ref svg{flex:none}
.sgg-ref-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sgg-ref-current{border-color:var(--sgg-ref-current-line);background:var(--sgg-ref-current-bg);color:var(--sgg-ref-current-fg)}
.sgg-ref-tag{border-color:var(--sgg-ref-tag-line);background:var(--sgg-ref-tag-bg);color:var(--sgg-ref-tag-fg)}
.sgg-meta{font-size:10.5px;color:var(--dsw-alias-label-tertiary,#8b949e)}
.sgg-more{display:block;width:100%;text-align:center;padding:6px;border:none;background:transparent;color:var(--dsw-alias-label-secondary,#9da7b3);cursor:pointer;font-size:12px}
.sgg-more:hover{color:var(--dsw-alias-label-primary,#e6edf3)}
.sgg-work{flex:none;width:36px;background:var(--dsw-alias-bg-layer-2,transparent);color:var(--dsw-alias-label-primary,#e6edf3);border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.1));border-radius:6px;padding:3px 4px;font-size:12px;outline:none}
.sgg-wt{border-bottom:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.08))}
.sgg-wt-head{display:flex;align-items:center;gap:6px;padding:5px 8px;cursor:pointer;font-size:12px;color:var(--dsw-alias-label-primary,#e6edf3)}
.sgg-wt-head:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.05))}
.sgg-wt-caret{flex:none;color:var(--dsw-alias-label-tertiary,#8b949e);width:12px}
.sgg-wt-icon{flex:none;color:var(--sgg-warn)}
.sgg-wt-title{font-weight:600;flex:none}
.sgg-wt-actions{margin-left:auto;display:flex;gap:2px;flex:none}
.sgg-wt-info{font-size:11px;color:var(--dsw-alias-label-secondary,#9da7b3);margin-left:4px}
.sgg-wt-clean{color:var(--dsw-alias-label-tertiary,#8b949e)}
.sgg-wt-body{padding:4px 8px 8px;border-top:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.05))}
.sgg-wt-empty{padding:6px 4px;font-size:11.5px;color:var(--dsw-alias-label-tertiary,#8b949e)}
.sgg-wt-groups-toolbar{display:flex;justify-content:flex-end;margin:6px 0 2px}
.sgg-wt-groups-toggle{background:transparent;border:none;padding:0;font-size:11px;color:var(--dsw-alias-label-secondary,#9da7b3);cursor:pointer}
.sgg-wt-groups-toggle:hover{color:var(--dsw-alias-label-primary,#e6edf3)}
.sgg-wt-group-head{display:flex;align-items:center;gap:4px;padding:2px 4px;margin:5px 0 1px;border-radius:4px;cursor:pointer;font-size:11px;color:var(--dsw-alias-label-secondary,#9da7b3);user-select:none}
.sgg-wt-group-head:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.05))}
.sgg-wt-group-name{font-weight:600;color:var(--dsw-alias-label-primary,#e6edf3)}
.sgg-wt-group-count{margin-left:auto;color:var(--dsw-alias-label-tertiary,#8b949e);font-weight:400}
.sgg-wt-file{display:flex;align-items:center;gap:6px;padding:2px 4px;border-radius:4px;min-width:0}
.sgg-wt-file:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.05))}
.sgg-wt-badge{flex:none;font-size:10px;color:var(--dsw-alias-label-tertiary,#8b949e);width:14px;text-align:center}
.sgg-wt-badge-untracked{color:var(--sgg-warn);font-weight:700}
.sgg-wt-file.sgg-wt-untracked .sgg-wt-path{color:var(--dsw-alias-label-secondary,#9da7b3)}
.sgg-wt-path{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11.5px;color:var(--dsw-alias-label-primary,#e6edf3)}
.sgg-commit-panel{padding:4px 2px 2px}
.sgg-commit-input{display:block;width:100%;box-sizing:border-box;min-width:0;background:var(--dsw-alias-bg-layer-2,transparent);border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.1));border-radius:6px;padding:5px 6px;font-size:12px;font-family:inherit;line-height:1.5;color:var(--dsw-alias-label-primary,#e6edf3);outline:none;resize:vertical}
.sgg-commit-hint{font-size:10.5px;line-height:1.55;white-space:pre-line;color:var(--dsw-alias-label-tertiary,#8b949e);margin:3px 2px 0;user-select:none}
.sgg-commit-foot{display:flex;align-items:flex-end;justify-content:space-between;gap:8px;margin-top:6px}
.sgg-commit-sign{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px;font-size:11px;color:var(--dsw-alias-label-secondary,#9da7b3)}
.sgg-commit-sign-check{display:flex;align-items:center;gap:4px;cursor:pointer;user-select:none}
.sgg-commit-sign-check input{accent-color:var(--dsw-alias-button-primary-fill,#4d9fff);margin:0}
.sgg-commit-sign-row{display:flex;gap:4px}
.sgg-commit-sign-input{flex:1;min-width:0;background:var(--dsw-alias-bg-layer-2,transparent);border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.1));border-radius:6px;padding:3px 6px;font-size:11px;color:var(--dsw-alias-label-primary,#e6edf3);outline:none}
.sgg-commit-sign-preview{font-size:11px;color:var(--dsw-alias-label-tertiary,#8b949e);word-break:break-all}
.sgg-commit-btn{flex:none;border:none;border-radius:6px;background:var(--dsw-alias-button-primary-fill,#4d9fff);color:var(--dsw-alias-label-primary-foreground,#fff);padding:4px 12px;font-size:12px;cursor:pointer}
.sgg-commit-btn:disabled{opacity:.5;cursor:default}
.sgg-menu-backdrop{position:fixed;inset:0;z-index:2000}
.sgg-menu{position:fixed;z-index:2001;min-width:150px;padding:4px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));background:var(--dsw-alias-bg-overlay,#1b1d24);box-shadow:0 8px 24px var(--dsw-alias-bg-mask-2,rgba(0,0,0,.4))}
.sgg-menu-item{display:block;width:100%;text-align:left;border:none;background:none;color:var(--dsw-alias-label-primary,#e6edf3);font-size:12px;padding:6px 10px;border-radius:6px;cursor:pointer}
.sgg-menu-item:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.07))}
.sgg-confirm-backdrop{position:fixed;inset:0;z-index:2000;background:var(--dsw-alias-bg-mask-2,rgba(0,0,0,.4))}
.sgg-confirm{position:fixed;z-index:2001;left:50%;top:40%;transform:translate(-50%,-50%);width:min(320px,calc(100vw - 40px));border-radius:10px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));background:var(--dsw-alias-bg-overlay,#1b1d24);box-shadow:0 8px 24px var(--dsw-alias-bg-mask-2,rgba(0,0,0,.5));padding:14px 16px}
.sgg-confirm-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,#e6edf3);margin-bottom:8px}
.sgg-confirm-msg{font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary,#9da7b3);word-break:break-all;margin-bottom:14px;white-space:pre-line}
.sgg-confirm-checks{display:flex;flex-direction:column;gap:8px;margin-bottom:14px}
.sgg-confirm-check{display:flex;align-items:flex-start;gap:8px;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-primary,#e6edf3);cursor:pointer}
.sgg-confirm-check input{accent-color:var(--dsw-alias-brand-primary,#4d9fff);margin-top:2px;flex:none}
.sgg-confirm-btns{display:flex;justify-content:flex-end;gap:8px}
.sgg-confirm-btn{border:none;border-radius:6px;padding:5px 14px;font-size:12px;cursor:pointer;color:var(--dsw-alias-label-primary,#e6edf3);background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08))}
.sgg-confirm-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.13))}
.sgg-confirm-danger{background:#d1242f;color:#fff}
.sgg-confirm-danger:hover{background:#b01e28}
.sgg-empty{padding:20px 12px;text-align:center;color:var(--dsw-alias-label-tertiary,#8b949e)}
.sgg-repolist{flex:1;min-height:0;overflow-y:auto;padding:8px}
.sgg-repolist-head{display:flex;align-items:center;gap:6px;margin-bottom:4px}
.sgg-repolist-title{font-weight:600;color:var(--dsw-alias-label-primary,#e6edf3);flex:none}
.sgg-repolist-count{font-size:11px;color:var(--dsw-alias-label-tertiary,#8b949e);background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08));border-radius:8px;padding:0 6px;flex:none}
.sgg-repo-row{display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:6px;cursor:pointer;min-width:0}
.sgg-repo-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06))}
.sgg-repo-path{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary,#e6edf3);font-size:12px}
.sgg-repo-branch{flex:none;font-size:10px;padding:0 5px;border-radius:8px;background:var(--sgg-ref-bg);color:var(--sgg-ref-fg)}
.sgg-repo-go{flex:none;color:var(--dsw-alias-label-tertiary,#8b949e)}
.sgg-repo-bar{display:flex;align-items:center;gap:6px;padding:5px 8px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.06));min-width:0}
.sgg-repo-bar-path{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11.5px;color:var(--dsw-alias-label-secondary,#9da7b3)}
.sgg-repo-bar .sgg-link{flex:none}
.sgg-error{padding:8px 12px;color:var(--sgg-danger);white-space:pre-wrap}
.sgg-notice{padding:8px 12px;color:var(--sgg-success);white-space:pre-wrap}
.sgg-dialog-backdrop{position:fixed;inset:0;z-index:2000;background:var(--dsw-alias-bg-mask-2,rgba(0,0,0,.4))}
.sgg-dialog{position:fixed;z-index:2001;left:50%;top:40%;transform:translate(-50%,-50%);width:min(320px,calc(100vw - 40px));border-radius:10px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));background:var(--dsw-alias-bg-overlay,#1b1d24);box-shadow:0 8px 24px var(--dsw-alias-bg-mask-2,rgba(0,0,0,.5));padding:14px 16px}
.sgg-dialog-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,#e6edf3);margin-bottom:10px}
.sgg-dialog-msg{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary,#9da7b3);word-break:break-all;margin-bottom:8px}
.sgg-dialog-form{display:flex;flex-direction:column;gap:10px;margin-bottom:14px}
.sgg-dialog-row{display:flex;align-items:center;gap:8px}
.sgg-dialog-row.sgg-dialog-check{cursor:pointer;font-size:12px;color:var(--dsw-alias-label-primary,#e6edf3)}
.sgg-dialog-check input{accent-color:var(--dsw-alias-brand-primary,#4d9fff);flex:none}
.sgg-dialog-label{flex:none;font-size:12px;color:var(--dsw-alias-label-secondary,#9da7b3);width:44px}
.sgg-dialog-select{flex:1;min-width:0;background:var(--dsw-alias-bg-layer-2,transparent);color:var(--dsw-alias-label-primary,#e6edf3);border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.1));border-radius:6px;padding:4px 6px;font-size:12px;outline:none}
.sgg-dialog-btns{display:flex;justify-content:flex-end;gap:8px}
.sgg-dialog-run{background:var(--dsw-alias-button-primary-fill,#4d9fff);color:var(--dsw-alias-label-primary-foreground,#fff)}
.sgg-dialog-run:hover{opacity:.9}
.sgg-detail{border-top:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.1));max-height:33vh;overflow-y:auto;background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.15))}
.sgg-detail-fixed{position:sticky;top:0;z-index:1;background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.15));padding:8px 10px 4px;max-height:14vh;overflow-y:auto}
.sgg-stat-wrap{padding:0 10px;overflow-y:auto}
.sgg-detail-scroll{padding:0 10px 8px}
.sgg-detail-head{display:flex;align-items:center;gap:8px;margin-bottom:6px}
.sgg-detail-title{font-weight:600;font-size:12.5px;color:var(--dsw-alias-label-primary,#e6edf3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sgg-detail-meta{font-size:11px;color:var(--dsw-alias-label-secondary,#9da7b3);margin:2px 0}
.sgg-detail-meta b{color:var(--dsw-alias-label-tertiary,#8b949e);font-weight:500;margin-right:4px}
.sgg-body{font-size:11.5px;color:var(--dsw-alias-label-secondary,#9da7b3);white-space:pre-wrap;margin:4px 0 8px;border-left:2px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));padding-left:8px}
.sgg-stat{list-style:none;margin:0;padding:0}
.sgg-stat-li{display:flex;align-items:center;gap:8px;padding:2px 4px;border-radius:4px;font-size:11.5px;min-width:0;cursor:pointer}
.sgg-stat-li:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.05))}
.sgg-stat-open{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.07))}
.sgg-inline-diff{border-top:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.08));padding:4px 4px 6px;max-height:24vh;overflow-y:auto}
.sgg-inline-diff-loading{padding:8px 4px;color:var(--dsw-alias-label-tertiary,#8b949e);font-size:11.5px}
.sgg-inline-diff-close{margin-bottom:2px;display:block}
.sgg-stat-path{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary,#e6edf3);cursor:pointer}
.sgg-stat-path:hover{text-decoration:underline}
.sgg-stat-nums{flex:none;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10.5px}
.sgg-add{color:var(--sgg-add)}
.sgg-del{color:var(--sgg-del);margin-left:6px}
.sgg-diff-toggle{border:none;background:none;color:var(--dsw-alias-brand-primary,#4d9fff);cursor:pointer;font-size:11.5px;padding:2px 0}
.sgg-diff{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10.5px;line-height:1.45;white-space:pre;overflow-x:auto;margin-top:6px;color:var(--dsw-alias-label-secondary,#9da7b3)}
.sgg-diff .d{color:var(--sgg-del)}.sgg-diff .a{color:var(--sgg-add)}.sgg-diff .h{color:var(--sgg-hunk)}
.sgg-actions{display:flex;gap:8px;margin-top:6px}
.sgg-link{border:none;background:none;color:var(--dsw-alias-brand-primary,#4d9fff);cursor:pointer;font-size:11.5px;padding:0}
.sgg-copy{flex:none}
`;

    function injectCss() {
      const existing = document.querySelector('style[data-dsh-plugin="dsh-shinki-git-graph"]');
      const style = existing ?? document.createElement('style');
      if (!existing) {
        style.dataset.dshPlugin = 'dsh-shinki-git-graph';
        document.head.appendChild(style);
      }
      // 每次都按当前 CSS 覆写内容：client 半包被 dsh-client-hmr 热更后 apply() 会重新执行，
      // 而 <style> 元素是复用的（挂一次就不再创建）。若只按「元素已存在」提前返回，
      // 改动过的 CSS（例如 v0.9.1 的主题 token）永远不会生效，直到整页刷新。
      if (style.textContent !== CSS) style.textContent = CSS;
    }

    // ── components ───────────────────────────────────────────────────────
    /** Diff text with lightweight +/- coloring. */
    function DiffText({ text }) {
      const lines = String(text).split('\n');
      return h('pre', { className: 'sgg-diff' },
        lines.map((line, i) => {
          let cls = '';
          if (line.startsWith('+') && !line.startsWith('+++')) cls = 'a';
          else if (line.startsWith('-') && !line.startsWith('---')) cls = 'd';
          else if (line.startsWith('@@')) cls = 'h';
          return h('div', { key: i, className: cls }, line === '' ? ' ' : line);
        })
      );
    }

    /** Inline diff block rendered inside the git view (no external tab). */
    function InlineDiff({ text, loading, onClose }) {
      return h('div', { className: 'sgg-inline-diff' },
        loading
          ? h('div', { className: 'sgg-inline-diff-loading' }, t('loading'))
          : h(Fragment, null,
              h('button', { type: 'button', className: 'sgg-link sgg-inline-diff-close', onClick: onClose }, t('hideDiff')),
              h(DiffText, { text: text ?? '' }),
            ),
      );
    }

    /** Extract one file's diff block from a whole-commit diff text. */
    function splitCommitDiff(diffText, path) {
      const blocks = String(diffText ?? '').split(/\n(?=diff --git )/);
      const needle = `diff --git a/${path} b/${path}`;
      return blocks.find((b) => b.startsWith(needle) || b.includes(needle)) ?? '';
    }

    /** Expandable commit detail panel. */
    function CommitDetail({ detail, branch, onClose, refsRaw }) {
      const [showDiff, setShowDiff] = useState(false);
      const [copied, setCopied] = useState(false);
      const [fileDiffPath, setFileDiffPath] = useState(null);
      const tags = refsRaw ? refsList(refsRaw).filter((r) => r.isTag).map((r) => r.name) : [];
      // File list height: natural content height capped by max-height (no
      // fixed px height — a one-file list is one row tall, and an inline
      // diff expands freely). Base cap = 33vh/4 + two rows; while an inline
      // file diff is open the cap grows to nearly the detail panel so the
      // diff stays visible (scrolls only when huge).
      const ROW_H = 22;
      const statMaxBase = Math.round((window.innerHeight * 0.33) / 4) + ROW_H * 2;
      const statMax = fileDiffPath
        ? Math.round(window.innerHeight * 0.33) - 60
        : statMaxBase;
      const copy = () => {
        copyText(detail.hash);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      };
      const short = detail.hash.slice(0, 7);
      return h('div', { className: 'sgg-detail' },
        h('div', { className: 'sgg-detail-fixed' },
          h('div', { className: 'sgg-detail-head' },
            h('span', { className: 'sgg-detail-title' }, `${short} ${detail.subject}`),
            h('button', { className: 'sgg-link sgg-copy', onClick: copy }, copied ? t('copied') : t('copyHash')),
            h('button', { className: 'sgg-link', onClick: onClose }, t('collapsed')),
          ),
          detail.isMerge && h('div', { className: 'sgg-detail-meta' }, t('mergeCommit')),
          tags.length > 0 && h('div', { className: 'sgg-detail-meta' },
            h('b', null, t('tags')),
            tags.map((tag) => refChip({ name: tag, isTag: true }, { key: tag })),
          ),
          h('div', { className: 'sgg-detail-meta' },
            h('b', null, t('author')), `${detail.author.name} <${detail.author.email}> · ${detail.author.date}`),
          h('div', { className: 'sgg-detail-meta' },
            h('b', null, t('committer')), `${detail.committer.name} · ${detail.committer.date}`),
          detail.parents.length > 0 && h('div', { className: 'sgg-detail-meta' },
            h('b', null, t('parents')),
            detail.parents.slice(0, 8).join(' '),
            detail.parents.length > 8 ? ` …(+${detail.parents.length - 8})` : ''),
          detail.body ? h('div', { className: 'sgg-body' }, detail.body) : null,
        ),
        h('div', { className: 'sgg-stat-wrap', style: { maxHeight: statMax } },
          h('div', { className: 'sgg-stat' },
            detail.stat.map((f) => h(Fragment, { key: f.path },
              h('div', {
                className: `sgg-stat-li${fileDiffPath === f.path ? ' sgg-stat-open' : ''}`,
                onClick: () => setFileDiffPath(fileDiffPath === f.path ? null : f.path),
              },
                h('span', { className: 'sgg-stat-path', title: `${f.path} · ${t('viewDiff')}` }, f.path),
                h('span', { className: 'sgg-stat-nums' },
                  f.add > 0 && h('span', { className: 'sgg-add' }, `+${f.add}`),
                  f.del > 0 && h('span', { className: 'sgg-del' }, `-${f.del}`),
                ),
              ),
              fileDiffPath === f.path && h(InlineDiff, {
                text: splitCommitDiff(detail.diffText, f.path),
                loading: false,
                onClose: () => setFileDiffPath(null),
              }),
            )),
          ),
        ),
        h('div', { className: 'sgg-detail-scroll' },
          detail.diffText
            ? h(Fragment, null,
                h('button', { className: 'sgg-diff-toggle', onClick: () => setShowDiff(!showDiff) },
                  showDiff ? t('hideDiff') : t('showDiff')),
                showDiff && h(DiffText, { text: detail.diffText }),
              )
            : null,
        ),
      );
    }

    /** 一条 ref 徽标（提交行第二行）。**不靠颜色单独编码类型**：本地分支=分支图标、
     *  远程分支=云图标、标签=标签牌图标，颜色只是辅助（浅色/深色主题各自一套 token）。
     *  当前分支另加绿色 token；名字过长时省略号截断，title 里给全名。 */
    function refChip(ref, opts = {}) {
      // 本地分支也可以带 '/'（feature/x），所以远程与否只能查宿主的远程分支清单，
      // 不能靠「名字里有斜杠」猜（v0.9.1 首版就是这么错的）。
      const isRemote = !ref.isTag && ref.name !== 'HEAD' && opts.remoteRefs?.has(ref.name) === true;
      const isCurrent = opts.current || ref.name === 'HEAD';
      const Icon = ref.isTag
        ? primitives.IconTagOutline16
        : isRemote ? primitives.IconRemoteOutline16 : primitives.IconBranchOutline16;
      const cls = `sgg-ref${isCurrent ? ' sgg-ref-current' : ''}${ref.isTag ? ' sgg-ref-tag' : ''}`;
      return h('span', { key: opts.key, className: cls, title: ref.name },
        h(Icon, { size: 10 }),
        h('span', { className: 'sgg-ref-name' }, ref.name));
    }

    /** 提交点在行内的位置：`NODE_Y` 处（= 首行文字中心），与 graph-layout 的
     *  标称坐标一致；上层 SVG 高 NODE_Y 且 1:1，所以圆不会被拉扁。 */
    function GraphLanes({ lane, laneW, radius, branchColor, shape }) {
      const width = lane.laneCount * laneW;
      const path = (p, key) => h('path', { key, d: primPath(p, laneW), stroke: p.color });
      // 下层：向下的直通线与扇出曲线（纵向拉伸以填满行高）
      const down = lane.bottom.map((p, i) => path(p, `d${i}`));
      // 上层：向上的直通线、汇入曲线，最后是提交点（盖住下层线头）
      const up = lane.top.map((p, i) => path(p, `u${i}`));
      const cx = laneX(lane.node.col, laneW);
      const color = branchColor ?? lane.node.color;
      const node = shape.shape === 'square'
        ? h('rect', { key: 'n', x: cx - radius, y: NODE_Y - radius, width: radius * 2, height: radius * 2, fill: color })
        : h('circle', { key: 'n', cx, cy: NODE_Y, r: radius, fill: color });
      const ring = shape.ring
        ? (shape.shape === 'square'
          ? h('rect', {
            key: 'r',
            x: cx - radius - 1.5, y: NODE_Y - radius - 1.5,
            width: (radius + 1.5) * 2, height: (radius + 1.5) * 2,
            fill: 'none', stroke: 'currentColor', strokeWidth: 1.5,
          })
          : h('circle', {
            key: 'r', cx, cy: NODE_Y, r: radius + 1.5, fill: 'none', stroke: 'currentColor', strokeWidth: 1.5,
          }))
        : null;
      return h('span', { className: 'sgg-graph', style: { width: `${width}px` } },
        h('svg', {
          className: 'sgg-graph-down',
          width: '100%',
          height: `calc(100% - ${NODE_Y}px)`,
          viewBox: `0 ${NODE_Y} ${width} ${ROW_H - NODE_Y}`,
          preserveAspectRatio: 'none',
        }, down),
        // 上层同样用 width:100% + preserveAspectRatio=none：与下层**共享同一个 x 映射**
        // （行宽被 max-width 收窄时两层一起等比压缩；否则上层保持 px 宽、下层按 100% 压缩，
        //  会出现「线在左、节点在右」的错位与线宽突变）。height 恒为 NODE_Y 像素 → y 仍是 1:1。
        h('svg', {
          className: 'sgg-graph-up',
          width: '100%', height: NODE_Y, viewBox: `0 0 ${width} ${NODE_Y}`,
          preserveAspectRatio: 'none',
        }, up, node, ring),
      );
    }

    /** One commit row: graph (lanes + curves + node) + refs + subject + meta.
     *  `lane` is one graph-layout row (`lib/graph-layout.js`); `branchColor` is the
     *  color of the first selected branch this row belongs to (multi-branch
     *  filtering) and overrides just this row's node color as a branch marker. */
    function GraphRow({ row, lane, laneW, radius, branch, open, onToggle, onContextMenu, branchColor, showTags, remoteRefs }) {
      const refs = refsList(row.refs);
      const headRow = isHeadRow(row);
      const shape = nodeShape(refs.length > 0, headRow);
      const isCurrentRef = branch !== '' && refs.some((r) => r.name === branch && !r.isTag);
      const openMenu = (event) => {
        event.preventDefault();
        event.stopPropagation();
        onContextMenu?.({ x: event.clientX, y: event.clientY, row });
      };
      return h('div', {
        className: `sgg-row${open ? ' sgg-open' : ''}`,
        role: 'button',
        tabIndex: 0,
        onClick: onToggle,
        onContextMenu: openMenu,
        onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); } },
        title: `${row.author} · ${row.date}\n${row.oid}`,
      },
        h(GraphLanes, { lane, laneW, radius, branchColor, shape }),
        h('span', { className: 'sgg-main' },
          h('div', { className: 'sgg-line1' },
            h('span', { className: 'sgg-hash' }, row.oid.slice(0, 7)),
            h('span', { className: 'sgg-subject' }, row.subject),
          ),
          h('div', { className: 'sgg-line2' },
            refs.filter((r) => !r.isTag || showTags).map((ref) => refChip(ref, {
              key: ref.name,
              current: isCurrentRef && ref.name === branch,
              remoteRefs,
            })),
            h('span', { className: 'sgg-meta' }, `${row.author} · ${relativeTime(row.date)}`),
          ),
        ),
      );
    }

    /** Branch tree: local/remote groups with upstream annotations. */
    function BranchTree({ branches, scopeMode, selected, onToggleBranch, onBranchMenu, currentBranch, branchColors }) {
      const curUp = branches.upstreamOf[currentBranch] ?? '';
      const localRows = scopeMode === 'all'
        ? branches.local
        : branches.local.filter((b) => b.name === currentBranch || (curUp && b.name === curUp));
      const remoteRows = scopeMode === 'all' ? branches.remote : [];
      const row = (b, isRemote) => {
        const isCurrent = !isRemote && b.name === currentBranch;
        const isUp = !isRemote && b.name === curUp;
        const tag = isCurrent ? t('current') : isUp ? t('upstream') : (!isRemote && b.upstream) ? `↔ ${b.upstream}` : '';
        const checked = scopeMode === 'all' ? selected.includes(b.name) : true;
        const dotColor = branchColors?.get(b.name) ?? '';
        return h('div', {
          key: b.name,
          className: `sgg-tree-row${isCurrent ? ' sgg-current' : ''}`,
          onClick: scopeMode === 'all' ? () => onToggleBranch(b.name) : undefined,
          onContextMenu: (e) => {
            e.preventDefault();
            e.stopPropagation();
            onBranchMenu?.({ x: e.clientX, y: e.clientY, branch: b, isCurrent, isRemote });
          },
        },
          scopeMode === 'all' && h('input', {
            type: 'checkbox', className: 'sgg-tree-check', checked,
            onChange: () => onToggleBranch(b.name),
            onClick: (e) => e.stopPropagation(),
          }),
          h('span', { className: 'sgg-branch-dot', style: dotColor ? { background: dotColor } : null }),
          h('span', { className: 'sgg-tree-name', title: b.name }, `${isCurrent ? '✓ ' : ''}${b.name}`),
          tag && h('span', { className: 'sgg-tree-tag' }, tag),
        );
      };
      return h('div', { className: 'sgg-tree' },
        h('div', { className: 'sgg-tree-group' }, t('local')),
        ...localRows.map((b) => row(b, false)),
        scopeMode !== 'all' && curUp === '' && h('div', { className: 'sgg-hint' }, t('noUpstream')),
        scopeMode === 'all' && h('div', { className: 'sgg-tree-group' }, t('remote')),
        ...remoteRows.map((b) => row(b, true)),
        scopeMode === 'all' && h('div', { className: 'sgg-hint' }, t('filterHint')),
      );
    }

    /** Native context menu appended to document.body — immune to the sidebar
     *  panel's stacking/transform contexts that break in-tree popups. */
    function hideCtxMenu() {
      document.querySelectorAll('.sgg-menu-backdrop, .sgg-menu').forEach((el) => el.remove());
    }
    function showCtxMenu(x, y, items) {
      hideCtxMenu();
      const backdrop = document.createElement('div');
      backdrop.className = 'sgg-menu-backdrop';
      backdrop.onclick = hideCtxMenu;
      backdrop.oncontextmenu = (e) => { e.preventDefault(); hideCtxMenu(); };
      const menu = document.createElement('div');
      menu.className = 'sgg-menu';
      menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - 160))}px`;
      menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - 34 * items.length - 8))}px`;
      for (const item of items) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'sgg-menu-item';
        btn.textContent = item.label;
        btn.onclick = () => { hideCtxMenu(); item.onClick(); };
        menu.appendChild(btn);
      }
      document.body.appendChild(backdrop);
      document.body.appendChild(menu);
    }

    /** Copy text to the clipboard: async Clipboard API with an execCommand
     *  fallback (primitives.writeClipboard is not always available). */
    function fallbackCopy(text) {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        document.execCommand('copy');
        ta.remove();
      } catch { /* ignore */ }
    }
    function copyText(text) {
      try {
        if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          navigator.clipboard.writeText(text).then(() => {}, () => fallbackCopy(text));
          return;
        }
      } catch { /* ignore */ }
      fallbackCopy(text);
    }

    /** Native confirm dialog appended to document.body (same rationale as the
     *  context menu: immune to the sidebar panel's stacking/transform). */
    function hideConfirm() {
      document.querySelectorAll('.sgg-confirm-backdrop, .sgg-confirm').forEach((el) => el.remove());
    }
    function showConfirm(title, message, confirmLabel, onConfirm, items) {
      hideConfirm();
      const backdrop = document.createElement('div');
      backdrop.className = 'sgg-confirm-backdrop';
      backdrop.onclick = hideConfirm;
      const box = document.createElement('div');
      box.className = 'sgg-confirm';
      const hd = document.createElement('div');
      hd.className = 'sgg-confirm-title';
      hd.textContent = title;
      const msg = document.createElement('div');
      msg.className = 'sgg-confirm-msg';
      msg.textContent = message;
      const btns = document.createElement('div');
      btns.className = 'sgg-confirm-btns';
      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'sgg-confirm-btn';
      cancelBtn.textContent = t('cancel');
      cancelBtn.onclick = hideConfirm;
      const okBtn = document.createElement('button');
      okBtn.type = 'button';
      okBtn.className = 'sgg-confirm-btn sgg-confirm-danger';
      okBtn.textContent = confirmLabel;
      okBtn.onclick = () => { hideConfirm(); onConfirm(); };
      btns.appendChild(cancelBtn);
      btns.appendChild(okBtn);
      box.appendChild(hd);
      box.appendChild(msg);
      // Optional triple-check list: the confirm button stays disabled until
      // every checkbox is ticked (destructive untracked-file deletion).
      if (items && items.length > 0) {
        const states = items.map(() => false);
        const list = document.createElement('div');
        list.className = 'sgg-confirm-checks';
        items.forEach((it, i) => {
          const label = document.createElement('label');
          label.className = 'sgg-confirm-check';
          const cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.onchange = () => {
            states[i] = cb.checked;
            okBtn.disabled = states.some((s) => !s);
          };
          const span = document.createElement('span');
          span.textContent = it.text;
          label.appendChild(cb);
          label.appendChild(span);
          list.appendChild(label);
        });
        box.appendChild(list);
        okBtn.disabled = true;
      }
      box.appendChild(btns);
      document.body.appendChild(backdrop);
      document.body.appendChild(box);
    }

    /** Native pull/push dialog appended to document.body (same rationale as
     *  the context menu / confirm: immune to the sidebar panel's stacking
     *  and transform contexts). Lets the user pick the remote and a branch
     *  OR a tag; pull adds a "fetch only" option and fetch-all. */
    function hideDialog() {
      document.querySelectorAll('.sgg-dialog-backdrop, .sgg-dialog').forEach((el) => el.remove());
    }
    function showSyncDialog({ kind, remotes, local, remote, tags, upstreamOf, currentBranch, onRun, onFetchAll }) {
      hideDialog();
      const backdrop = document.createElement('div');
      backdrop.className = 'sgg-dialog-backdrop';
      backdrop.onclick = hideDialog;
      const box = document.createElement('div');
      box.className = 'sgg-dialog';
      const hd = document.createElement('div');
      hd.className = 'sgg-dialog-title';
      hd.textContent = kind === 'pull' ? t('pull') : t('push');
      const form = document.createElement('div');
      form.className = 'sgg-dialog-form';

      // Type row: branch or tag (tag = push/fetch a specific tag).
      const typeRow = document.createElement('div');
      typeRow.className = 'sgg-dialog-row';
      const typeLabel = document.createElement('span');
      typeLabel.className = 'sgg-dialog-label';
      typeLabel.textContent = t('syncType');
      const typeSel = document.createElement('select');
      typeSel.className = 'sgg-dialog-select';
      const typeBranchOpt = document.createElement('option');
      typeBranchOpt.value = 'branch';
      typeBranchOpt.textContent = t('typeBranch');
      const typeTagOpt = document.createElement('option');
      typeTagOpt.value = 'tag';
      typeTagOpt.textContent = t('typeTag');
      typeSel.appendChild(typeBranchOpt);
      typeSel.appendChild(typeTagOpt);
      typeRow.appendChild(typeLabel);
      typeRow.appendChild(typeSel);

      // Remote row: pick one of the configured remotes (default = the
      // current branch's upstream remote, else the first remote).
      const remoteRow = document.createElement('div');
      remoteRow.className = 'sgg-dialog-row';
      const remoteLabel = document.createElement('span');
      remoteLabel.className = 'sgg-dialog-label';
      remoteLabel.textContent = t('syncRemote');
      const remoteSel = document.createElement('select');
      remoteSel.className = 'sgg-dialog-select';
      for (const r of remotes) {
        const o = document.createElement('option');
        o.value = r.name;
        o.textContent = r.name;
        remoteSel.appendChild(o);
      }
      const upstreamRemote = (upstreamOf[currentBranch] ?? '').split('/')[0];
      if (upstreamRemote && remotes.some((r) => r.name === upstreamRemote)) remoteSel.value = upstreamRemote;
      remoteRow.appendChild(remoteLabel);
      remoteRow.appendChild(remoteSel);

      // Branch row: local branches for push; branches of the chosen remote
      // for pull (prefix stripped, e.g. origin/main → main).
      const branchRow = document.createElement('div');
      branchRow.className = 'sgg-dialog-row';
      const branchLabel = document.createElement('span');
      branchLabel.className = 'sgg-dialog-label';
      branchLabel.textContent = t('syncBranch');
      const branchSel = document.createElement('select');
      branchSel.className = 'sgg-dialog-select';
      const fillBranches = () => {
        branchSel.innerHTML = '';
        const remoteName = remoteSel.value;
        const prefix = `${remoteName}/`;
        let names = [];
        let def = '';
        if (kind === 'push') {
          names = local.map((b) => b.name);
          def = currentBranch;
        } else {
          names = remote.filter((r) => r.name.startsWith(prefix)).map((r) => r.name.slice(prefix.length));
          const up = upstreamOf[currentBranch] ?? '';
          if (up.startsWith(prefix)) def = up.slice(prefix.length);
        }
        if (names.length === 0) {
          const o = document.createElement('option');
          o.value = '';
          o.textContent = t('noBranches');
          branchSel.appendChild(o);
          return;
        }
        for (const n of names) {
          const o = document.createElement('option');
          o.value = n;
          o.textContent = n;
          if (n === def) o.selected = true;
          branchSel.appendChild(o);
        }
      };
      remoteSel.addEventListener('change', fillBranches);
      fillBranches();
      branchRow.appendChild(branchLabel);
      branchRow.appendChild(branchSel);

      // Tag row: local tags (push) or tags to fetch (pull), plus a free-text
      // custom entry for tags that don't exist locally yet (e.g. fetching a
      // remote tag for the first time).
      const tagRow = document.createElement('div');
      tagRow.className = 'sgg-dialog-row';
      const tagLabel = document.createElement('span');
      tagLabel.className = 'sgg-dialog-label';
      tagLabel.textContent = t('typeTag');
      const tagSel = document.createElement('select');
      tagSel.className = 'sgg-dialog-select';
      const tagInput = document.createElement('input');
      tagInput.type = 'text';
      tagInput.className = 'sgg-dialog-select';
      tagInput.placeholder = t('tagInputPlaceholder');
      tagInput.style.display = 'none';
      const fillTags = () => {
        tagSel.innerHTML = '';
        const names = (tags ?? []).map((tg) => tg.name);
        tagSel.disabled = false;
        if (names.length === 0) {
          // No local tags: still allow fetching a remote tag via the custom
          // entry — select it by default so the input is ready to type.
          const o = document.createElement('option');
          o.value = '__custom__';
          o.textContent = t('tagCustom');
          tagSel.appendChild(o);
        } else {
          for (const n of names) {
            const o = document.createElement('option');
            o.value = n;
            o.textContent = n;
            tagSel.appendChild(o);
          }
          const custom = document.createElement('option');
          custom.value = '__custom__';
          custom.textContent = t('tagCustom');
          tagSel.appendChild(custom);
        }
        if (names.length === 0) tagSel.value = '__custom__';
        const isCustom = tagSel.value === '__custom__';
        tagInput.style.display = isCustom ? '' : 'none';
        if (isCustom) tagInput.focus();
      };
      tagSel.addEventListener('change', fillTags);
      fillTags();
      tagRow.appendChild(tagLabel);
      tagRow.appendChild(tagSel);
      tagRow.appendChild(tagInput);

      // Pull: "fetch only" (no merge / checkout) and "rebase" options —
      // branch mode only; a tag pull is inherently a fetch.
      let fetchCheck = null;
      let fetchRow = null;
      let rebaseCheck = null;
      let rebaseRow = null;
      if (kind === 'pull') {
        fetchRow = document.createElement('label');
        fetchRow.className = 'sgg-dialog-row sgg-dialog-check';
        fetchCheck = document.createElement('input');
        fetchCheck.type = 'checkbox';
        const span = document.createElement('span');
        span.textContent = t('pullFetchOnly');
        fetchRow.appendChild(fetchCheck);
        fetchRow.appendChild(span);
        rebaseRow = document.createElement('label');
        rebaseRow.className = 'sgg-dialog-row sgg-dialog-check';
        rebaseCheck = document.createElement('input');
        rebaseCheck.type = 'checkbox';
        const rebaseSpan = document.createElement('span');
        rebaseSpan.textContent = t('pullRebase');
        rebaseRow.appendChild(rebaseCheck);
        rebaseRow.appendChild(rebaseSpan);
        const syncFetchVisibility = () => {
          const hidden = typeSel.value === 'tag';
          fetchRow.style.display = hidden ? 'none' : '';
          rebaseRow.style.display = hidden ? 'none' : '';
        };
        typeSel.addEventListener('change', syncFetchVisibility);
        syncFetchVisibility();
      }
      // Push: "set upstream (-u)" option — branch mode only.
      let upstreamCheck = null;
      let upstreamRow = null;
      if (kind === 'push') {
        upstreamRow = document.createElement('label');
        upstreamRow.className = 'sgg-dialog-row sgg-dialog-check';
        upstreamCheck = document.createElement('input');
        upstreamCheck.type = 'checkbox';
        const upstreamSpan = document.createElement('span');
        upstreamSpan.textContent = t('pushSetUpstream');
        upstreamRow.appendChild(upstreamCheck);
        upstreamRow.appendChild(upstreamSpan);
        const syncUpstreamVisibility = () => {
          upstreamRow.style.display = typeSel.value === 'tag' ? 'none' : '';
        };
        typeSel.addEventListener('change', syncUpstreamVisibility);
        syncUpstreamVisibility();
      }

      const syncTypeVisibility = () => {
        const isTag = typeSel.value === 'tag';
        branchRow.style.display = isTag ? 'none' : '';
        tagRow.style.display = isTag ? '' : 'none';
      };
      typeSel.addEventListener('change', syncTypeVisibility);
      syncTypeVisibility();

      form.appendChild(typeRow);
      form.appendChild(remoteRow);
      form.appendChild(branchRow);
      form.appendChild(tagRow);
      if (fetchRow) form.appendChild(fetchRow);
      if (rebaseRow) form.appendChild(rebaseRow);
      if (upstreamRow) form.appendChild(upstreamRow);

      const btns = document.createElement('div');
      btns.className = 'sgg-dialog-btns';
      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'sgg-confirm-btn';
      cancelBtn.textContent = t('cancel');
      cancelBtn.onclick = hideDialog;
      const runBtn = document.createElement('button');
      runBtn.type = 'button';
      runBtn.className = 'sgg-confirm-btn sgg-dialog-run';
      runBtn.textContent = kind === 'pull' ? t('pull') : t('push');
      runBtn.onclick = () => {
        const remote = remoteSel.value;
        const isTag = typeSel.value === 'tag';
        const tag = isTag ? (tagSel.value === '__custom__' ? tagInput.value.trim() : tagSel.value) : '';
        const branch = isTag ? '' : branchSel.value;
        const fetchOnly = fetchCheck ? fetchCheck.checked : false;
        const rebase = rebaseCheck ? rebaseCheck.checked : false;
        const setUpstream = upstreamCheck ? upstreamCheck.checked : false;
        if (isTag && tag === '') {
          // Empty custom tag: keep the dialog open and flag the input.
          tagSel.value = '__custom__';
          tagInput.style.display = '';
          tagInput.style.borderColor = 'var(--sgg-danger)';
          tagInput.focus();
          return;
        }
        if (!isTag && branch === '') {
          branchSel.style.borderColor = 'var(--sgg-danger)';
          return;
        }
        hideDialog();
        onRun({ remote, branch, tag, fetchOnly, rebase, setUpstream });
      };
      btns.appendChild(cancelBtn);
      if (kind === 'pull' && typeof onFetchAll === 'function') {
        const faBtn = document.createElement('button');
        faBtn.type = 'button';
        faBtn.className = 'sgg-confirm-btn';
        faBtn.textContent = t('fetchAll');
        faBtn.onclick = () => { hideDialog(); onFetchAll(); };
        btns.appendChild(faBtn);
      }
      btns.appendChild(runBtn);
      box.appendChild(hd);
      box.appendChild(form);
      box.appendChild(btns);
      document.body.appendChild(backdrop);
      document.body.appendChild(box);
    }

    /** Native "create branch" dialog appended to document.body (same
     *  rationale as the sync dialog). Asks for a new branch name and the
     *  base branch (defaults to the current branch / HEAD). */
    function showBranchDialog({ local, remote, currentBranch, defaultBase, onRun }) {
      hideDialog();
      const backdrop = document.createElement('div');
      backdrop.className = 'sgg-dialog-backdrop';
      backdrop.onclick = hideDialog;
      const box = document.createElement('div');
      box.className = 'sgg-dialog';
      const hd = document.createElement('div');
      hd.className = 'sgg-dialog-title';
      hd.textContent = t('createBranch');
      const form = document.createElement('div');
      form.className = 'sgg-dialog-form';

      // Name row.
      const nameRow = document.createElement('div');
      nameRow.className = 'sgg-dialog-row';
      const nameLabel = document.createElement('span');
      nameLabel.className = 'sgg-dialog-label';
      nameLabel.textContent = t('branchName');
      const nameInput = document.createElement('input');
      nameInput.type = 'text';
      nameInput.className = 'sgg-dialog-select';
      nameInput.placeholder = t('branchNamePlaceholder');
      nameRow.appendChild(nameLabel);
      nameRow.appendChild(nameInput);

      // Base branch row. `defaultBase` may be a branch name (local or remote)
      // or a commit hash (from the commit-row "create branch here" entry); a
      // hash is shown as a synthetic "此提交 <short>" option and selected by
      // default. Remote branches are grouped under their own optgroup; basing
      // on one sets the upstream tracking relationship (host --track).
      const baseRow = document.createElement('div');
      baseRow.className = 'sgg-dialog-row';
      const baseLabel = document.createElement('span');
      baseLabel.className = 'sgg-dialog-label';
      baseLabel.textContent = t('baseBranch');
      const baseSel = document.createElement('select');
      baseSel.className = 'sgg-dialog-select';
      const names = (local ?? []).map((b) => b.name);
      const remoteNames = (remote ?? []).map((b) => b.name);
      const isHashBase = typeof defaultBase === 'string' && /^[0-9a-fA-F]{4,40}$/.test(defaultBase);
      const base = (defaultBase && (names.includes(defaultBase) || remoteNames.includes(defaultBase) || isHashBase)) ? defaultBase : currentBranch;
      if (isHashBase) {
        const o = document.createElement('option');
        o.value = defaultBase;
        o.textContent = `${t('commitPrefix')} ${defaultBase.slice(0, 7)}`;
        if (base === defaultBase) o.selected = true;
        baseSel.appendChild(o);
      }
      if (names.length > 0) {
        const localGroup = document.createElement('optgroup');
        localGroup.label = t('local');
        for (const n of names) {
          const o = document.createElement('option');
          o.value = n;
          o.textContent = n;
          if (n === base) o.selected = true;
          localGroup.appendChild(o);
        }
        baseSel.appendChild(localGroup);
      }
      if (remoteNames.length > 0) {
        const remoteGroup = document.createElement('optgroup');
        remoteGroup.label = t('remote');
        for (const n of remoteNames) {
          const o = document.createElement('option');
          o.value = n;
          o.textContent = n;
          if (n === base) o.selected = true;
          remoteGroup.appendChild(o);
        }
        baseSel.appendChild(remoteGroup);
      }
      if (names.length === 0 && remoteNames.length === 0 && !isHashBase) {
        const o = document.createElement('option');
        o.value = '';
        o.textContent = t('noBranches');
        baseSel.appendChild(o);
      }
      baseRow.appendChild(baseLabel);
      baseRow.appendChild(baseSel);

      form.appendChild(nameRow);
      form.appendChild(baseRow);

      const btns = document.createElement('div');
      btns.className = 'sgg-dialog-btns';
      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'sgg-confirm-btn';
      cancelBtn.textContent = t('cancel');
      cancelBtn.onclick = hideDialog;
      const runBtn = document.createElement('button');
      runBtn.type = 'button';
      runBtn.className = 'sgg-confirm-btn sgg-dialog-run';
      runBtn.textContent = t('createBranch');
      runBtn.onclick = () => {
        const name = nameInput.value.trim();
        if (name === '') {
          nameInput.style.borderColor = 'var(--sgg-danger)';
          nameInput.focus();
          return;
        }
        hideDialog();
        onRun({ name, base: baseSel.value });
      };
      btns.appendChild(cancelBtn);
      btns.appendChild(runBtn);
      box.appendChild(hd);
      box.appendChild(form);
      box.appendChild(btns);
      document.body.appendChild(backdrop);
      document.body.appendChild(box);
      nameInput.focus();
    }

    /** Native "checkout to branch" dialog appended to document.body (same
     *  rationale as the sync/branch dialogs). Picks a local branch to point
     *  HEAD at (working tree switches with it). */
    function showCheckoutDialog({ local, remote, currentBranch, onRun }) {
      hideDialog();
      const backdrop = document.createElement('div');
      backdrop.className = 'sgg-dialog-backdrop';
      backdrop.onclick = hideDialog;
      const box = document.createElement('div');
      box.className = 'sgg-dialog';
      const hd = document.createElement('div');
      hd.className = 'sgg-dialog-title';
      hd.textContent = t('checkoutTo');
      const form = document.createElement('div');
      form.className = 'sgg-dialog-form';

      const row = document.createElement('div');
      row.className = 'sgg-dialog-row';
      const label = document.createElement('span');
      label.className = 'sgg-dialog-label';
      label.textContent = t('baseBranch');
      const sel = document.createElement('select');
      sel.className = 'sgg-dialog-select';
      const localNames = (local ?? []).map((b) => b.name);
      const remoteNames = (remote ?? []).map((b) => b.name);
      if (localNames.length === 0 && remoteNames.length === 0) {
        const o = document.createElement('option');
        o.value = '';
        o.textContent = t('noBranches');
        sel.appendChild(o);
      } else {
        const localGroup = document.createElement('optgroup');
        localGroup.label = t('local');
        for (const n of localNames) {
          const o = document.createElement('option');
          o.value = n;
          o.textContent = n === currentBranch ? `${n} ✓` : n;
          if (n === currentBranch) o.selected = true;
          localGroup.appendChild(o);
        }
        sel.appendChild(localGroup);
        if (remoteNames.length > 0) {
          const remoteGroup = document.createElement('optgroup');
          remoteGroup.label = t('remote');
          for (const n of remoteNames) {
            const o = document.createElement('option');
            o.value = n;
            o.textContent = n;
            remoteGroup.appendChild(o);
          }
          sel.appendChild(remoteGroup);
        }
      }
      row.appendChild(label);
      row.appendChild(sel);
      form.appendChild(row);
      const hint = document.createElement('div');
      hint.className = 'sgg-hint';
      hint.textContent = t('checkoutToHint');
      form.appendChild(hint);
      // Session-scoped opt-in: auto-link upstream when checking out the
      // CURRENT branch (a no-op checkout). Off by default; when on, the
      // host links the branch to its same-named default-remote branch.
      const optRow = document.createElement('label');
      optRow.className = 'sgg-dialog-row sgg-dialog-check';
      const optCheck = document.createElement('input');
      optCheck.type = 'checkbox';
      optCheck.checked = sessionStore.get('linkCurrent', '0') === '1';
      const optSpan = document.createElement('span');
      optSpan.textContent = t('linkCurrentOptIn');
      optRow.appendChild(optCheck);
      optRow.appendChild(optSpan);
      form.appendChild(optRow);

      const btns = document.createElement('div');
      btns.className = 'sgg-dialog-btns';
      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'sgg-confirm-btn';
      cancelBtn.textContent = t('cancel');
      cancelBtn.onclick = hideDialog;
      const runBtn = document.createElement('button');
      runBtn.type = 'button';
      runBtn.className = 'sgg-confirm-btn sgg-dialog-run';
      runBtn.textContent = t('checkout');
      runBtn.onclick = () => {
        const branch = sel.value;
        if (branch === '') return;
        sessionStore.set('linkCurrent', optCheck.checked ? '1' : '0');
        hideDialog();
        onRun(branch, optCheck.checked);
      };
      btns.appendChild(cancelBtn);
      btns.appendChild(runBtn);
      box.appendChild(hd);
      box.appendChild(form);
      box.appendChild(btns);
      document.body.appendChild(backdrop);
      document.body.appendChild(box);
    }

    /** Native "page size" dialog appended to document.body (same rationale
     *  as the other dialogs). Picks how many commits each page loads. */
    function showPageSizeDialog({ current, onRun }) {
      hideDialog();
      const backdrop = document.createElement('div');
      backdrop.className = 'sgg-dialog-backdrop';
      backdrop.onclick = hideDialog;
      const box = document.createElement('div');
      box.className = 'sgg-dialog';
      const hd = document.createElement('div');
      hd.className = 'sgg-dialog-title';
      hd.textContent = t('pageSizeSetting');
      const form = document.createElement('div');
      form.className = 'sgg-dialog-form';

      const row = document.createElement('div');
      row.className = 'sgg-dialog-row';
      const label = document.createElement('span');
      label.className = 'sgg-dialog-label';
      label.textContent = t('pageSizeSetting');
      const sel = document.createElement('select');
      sel.className = 'sgg-dialog-select';
      for (const size of [50, 100, 200, 500]) {
        const o = document.createElement('option');
        o.value = String(size);
        o.textContent = `${size}`;
        if (size === current) o.selected = true;
        sel.appendChild(o);
      }
      row.appendChild(label);
      row.appendChild(sel);
      form.appendChild(row);
      const hint = document.createElement('div');
      hint.className = 'sgg-hint';
      hint.textContent = t('pageSizeHint');
      form.appendChild(hint);

      const btns = document.createElement('div');
      btns.className = 'sgg-dialog-btns';
      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'sgg-confirm-btn';
      cancelBtn.textContent = t('cancel');
      cancelBtn.onclick = hideDialog;
      const runBtn = document.createElement('button');
      runBtn.type = 'button';
      runBtn.className = 'sgg-confirm-btn sgg-dialog-run';
      runBtn.textContent = t('refresh');
      runBtn.onclick = () => {
        hideDialog();
        onRun(Number(sel.value));
      };
      btns.appendChild(cancelBtn);
      btns.appendChild(runBtn);
      box.appendChild(hd);
      box.appendChild(form);
      box.appendChild(btns);
      document.body.appendChild(backdrop);
      document.body.appendChild(box);
    }

    /** Native credential prompt dialog appended to document.body (same
     *  rationale as the other dialogs). git asks for a username/password /
     *  passphrase; a "Password for" prompt renders a masked input. Resolves
     *  with the typed value, or null when cancelled. */
    function showPromptDialog(promptText) {
      return new Promise((resolve) => {
        hideDialog();
        const backdrop = document.createElement('div');
        backdrop.className = 'sgg-dialog-backdrop';
        backdrop.onclick = () => { hideDialog(); resolve(null); };
        const box = document.createElement('div');
        box.className = 'sgg-dialog';
        const hd = document.createElement('div');
        hd.className = 'sgg-dialog-title';
        hd.textContent = t('promptTitle');
        const form = document.createElement('div');
        form.className = 'sgg-dialog-form';
        const msg = document.createElement('div');
        msg.className = 'sgg-dialog-msg';
        msg.textContent = promptText || t('promptPassword');
        const input = document.createElement('input');
        input.type = /password|passphrase/i.test(promptText) ? 'password' : 'text';
        input.className = 'sgg-dialog-select';
        input.placeholder = /password|passphrase/i.test(promptText) ? t('promptPassword') : '';
        form.appendChild(msg);
        form.appendChild(input);
        const btns = document.createElement('div');
        btns.className = 'sgg-dialog-btns';
        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'sgg-confirm-btn';
        cancelBtn.textContent = t('promptCancel');
        cancelBtn.onclick = () => { hideDialog(); resolve(null); };
        const okBtn = document.createElement('button');
        okBtn.type = 'button';
        okBtn.className = 'sgg-confirm-btn sgg-dialog-run';
        okBtn.textContent = t('promptOk');
        okBtn.onclick = () => { hideDialog(); resolve(input.value); };
        btns.appendChild(cancelBtn);
        btns.appendChild(okBtn);
        box.appendChild(hd);
        box.appendChild(form);
        box.appendChild(btns);
        document.body.appendChild(backdrop);
        document.body.appendChild(box);
        input.focus();
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); okBtn.click(); }
        });
      });
    }

    // Bounded auto-retry while no workspace can be resolved for this tab.
    // better-sidebar's tab scope is `{ sessionId, cwd }`, but cwd is best-effort
    // (it stays absent until the client's session list knows that session), so a
    // tab can still end up with no usable session — e.g. the workspace has no
    // selected session at all. Polling must therefore stop and say so, instead of
    // refreshing forever (which is what users saw as "一直在反复刷新").
    const NO_SESSION_RETRY_MAX = 10; // 10 × 2s ≈ 20s, then a manual Retry button

    /** Main sidebar tab. */
    function GitGraphTab({ ctx, scope, visible, sidebarStore }) {
      const sessionId = scope?.sessionId ?? '';
      const [sessionRetries, setSessionRetries] = useState(0);
      // A new session id restarts the retry budget (and a manual Retry resets it).
      useEffect(() => { setSessionRetries(0); }, [sessionId]);
      const [phase, setPhase] = useState('loading'); // loading | ready | not-repo | git-missing | error
      const [branches, setBranches] = useState(null);
      const [rows, setRows] = useState([]);
      // Lane maps + the tail lane state of the last page, carried into the
      // next page so "加载更多" continues lanes instead of re-breaking them.
      const [laneMaps, setLaneMaps] = useState([]);
      const lanesTailRef = useRef([]);
      const [ended, setEnded] = useState(false);
      const [scopeMode, setScopeMode] = useState(() => readSetting(sidebarStore, 'scope', 'current-upstream'));
      const [pageSize, setPageSize] = useState(() => {
        const n = Number(readSetting(sidebarStore, 'pageSize', '100'));
        return Number.isInteger(n) && n >= 20 && n <= 500 ? n : 100;
      });
      const [selected, setSelected] = useState([]);
      const [expandedHash, setExpandedHash] = useState(null);
      const [detail, setDetail] = useState(null);
      const [detailLoading, setDetailLoading] = useState(false);
      const [error, setError] = useState('');
      const [loadingMore, setLoadingMore] = useState(false);
      const [showTags, setShowTags] = useState(() => readBoolSetting(sidebarStore, 'showTags', true));
      // Workspace's path relative to the repo root ('' when the workspace IS
      // the repo root). When non-empty the staging area hides changes outside
      // the workspace unless the user opts into showing the whole repo.
      const [subdir, setSubdir] = useState('');
      const [showAllRepo, setShowAllRepo] = useState(() => readBoolSetting(sidebarStore, 'showAllRepo', false));
      // Subdirectory git repos (when the workspace itself is not a repo):
      // the discovered list and the currently selected repo's
      // workspace-relative path (null = the workspace-root repo itself).
      const [subrepos, setSubrepos] = useState([]);
      const [activeRepo, setActiveRepo] = useState(null);
      const [repoLimit, setRepoLimit] = useState(REPO_PAGE);
      const activeRepoRef = useRef(null);
      const [status, setStatus] = useState(null);
      const [statusOpen, setStatusOpen] = useState(false);
      const [wtDiff, setWtDiff] = useState(null); // {path, staged, loading, text}
      const [commitOpen, setCommitOpen] = useState(false);
      const [commitMsg, setCommitMsg] = useState('');
      // Sign-off trailer (issue #3): enabled flag + name/email inputs. Kept
      // across commits and cleared when the worktree area view closes.
      const [signOn, setSignOn] = useState(false);
      const [signName, setSignName] = useState('');
      const [signEmail, setSignEmail] = useState('');
      // Per-group collapse (true = expanded); re-initialized after each
      // status refresh so groups > WT_GROUP_COLLAPSE_MAX default collapsed.
      const [wtGroups, setWtGroups] = useState({ staged: true, unstaged: true, untracked: true });
      const [busy, setBusy] = useState(false);
      const [notice, setNotice] = useState('');
      const [expandedRefs, setExpandedRefs] = useState('');
      // Window/pane resizing must re-layout (vh-based height caps re-evaluate).
      const [, forceRender] = useState(0);
      useEffect(() => {
        const onResize = () => forceRender((n) => n + 1);
        window.addEventListener('resize', onResize);
        return () => window.removeEventListener('resize', onResize);
      }, []);
      useEffect(() => { persistSetting(sidebarStore, 'scope', scopeMode); }, [scopeMode, sidebarStore]);
      useEffect(() => { persistSetting(sidebarStore, 'pageSize', pageSize); }, [pageSize, sidebarStore]);
      useEffect(() => { persistSetting(sidebarStore, 'showTags', showTags ? '1' : '0'); }, [showTags, sidebarStore]);
      useEffect(() => { persistSetting(sidebarStore, 'showAllRepo', showAllRepo ? '1' : '0'); }, [showAllRepo, sidebarStore]);
      // The side-card settings page edits the pluginSettings blob through the
      // sidebar store; reflect those external changes into local state so the
      // graph re-renders immediately.
      useEffect(() => {
        if (!sidebarStore || typeof sidebarStore.subscribe !== 'function') return;
        return sidebarStore.subscribe(() => {
          const blob = pluginBlobOf(sidebarStore);
          setScopeMode((prev) => {
            const v = blob.scope;
            return v === undefined || v === null ? prev : String(v);
          });
          setShowTags((prev) => {
            const v = blob.showTags;
            if (v === undefined || v === null) return prev;
            return v === true || v === '1';
          });
          setShowAllRepo((prev) => {
            const v = blob.showAllRepo;
            if (v === undefined || v === null) return prev;
            return v === true || v === '1';
          });
          setPageSize((prev) => {
            const v = Number(blob.pageSize);
            return Number.isInteger(v) && v >= 20 && v <= 500 ? v : prev;
          });
        });
      }, [sidebarStore]);
      const scopeModeRef = useRef(scopeMode);
      const selectedRef = useRef(selected);
      const rowsRef = useRef(rows);
      useEffect(() => { scopeModeRef.current = scopeMode; }, [scopeMode]);
      useEffect(() => { selectedRef.current = selected; }, [selected]);
      useEffect(() => { rowsRef.current = rows; }, [rows]);
      useEffect(() => { activeRepoRef.current = activeRepo; }, [activeRepo]);
      const selectedKey = selected.join(',');

      // `scope.cwd` is better-sidebar's best-effort workspace path for this tab
      // (from the client's session list, which is disk-backed). Send it as a HINT
      // only: the host resolves the working directory itself (live session header
      // → persisted header → workspace ledger) and accepts this value solely when
      // it equals a path in its own workspace ledger, so the client can never
      // point git at an arbitrary directory. It matters for a session the host has
      // neither attached nor indexed yet.
      const cwdHint = typeof scope?.cwd === 'string' ? scope.cwd : '';
      const withCwd = (payload) => (cwdHint !== '' ? { cwd: cwdHint, ...(payload ?? {}) } : payload);
      /** POST one method for this tab (no sub-repo routing). */
      const post = (method, payload = {}, signal) => apiPost(method, sessionId, withCwd(payload), signal);
      // API helper that transparently targets the currently selected
      // subdirectory repo (workspace-root when activeRepo is null).
      const api = (method, payload = {}, signal) =>
        post(method, activeRepoRef.current ? { ...payload, repoPath: activeRepoRef.current } : payload, signal);

      // Rebuild graph request params INSIDE load (reads the just-fetched
      // branches + latest refs), so load never depends on state it mutates.
      // `repoPath` selects a subdirectory git repo ('' = workspace root);
      // both load and loadMore route through it, so the whole view (graph,
      // branches, staging area, sync) targets the same repo.
      const loadRepoData = useCallback(async (repoPath) => {
        const p = repoPath ? { repoPath } : {};
        const [b, st] = await Promise.all([
          post('branches', p),
          post('status', p).catch(() => null),
        ]);
        setBranches(b);
        setStatus(st && Array.isArray(st.entries) ? st : { entries: [] });
        let params = { ...p };
        if (scopeModeRef.current === 'all') {
          params = selectedRef.current.length > 0 ? { ...p, revs: [...selectedRef.current] } : { ...p, all: true };
        } else {
          const cur = b.current ?? '';
          const up = b.upstreamOf?.[cur] ?? '';
          const revs = [cur, up].filter((x) => x !== '');
          params = revs.length > 0 ? { ...p, revs } : { ...p, revs: ['HEAD'] };
        }
        const g = await post('graph', params);
        setRows(g.rows);
        // 图谱布局（泳道 + 配色 + 曲线图元）：第一页从空状态开始，
        // 尾巴（lanes+colors）留给「加载更多」续接，避免跨页换色/断线。
        const layout = layoutGraph(g.rows);
        setLaneMaps(layout.rows);
        lanesTailRef.current = { lanes: layout.lanes, colors: layout.colors };
        setEnded(g.ended);
        setPhase('ready');
      }, [sessionId]);

      const load = useCallback(async () => {
        if (!sessionId) { setPhase('no-session'); setError(''); return; }
        // Silent refresh when data already shown: keep the current view and
        // only swap in fresh data, so opening a diff tab (which toggles tab
        // visibility and re-runs this) never blanks/reloads the whole graph.
        if (rowsRef.current.length === 0) setPhase('loading');
        setError('');
        try {
          const rp = activeRepoRef.current;
          const init = await post('init', rp ? { repoPath: rp } : {});
          if (init.isRepo) {
            // Workspace (or the selected sub-repo) is a git repo: render the
            // graph as before. For a sub-repo, subdir is '' (its root is the
            // repo root), so the staging area shows repo-root-relative paths.
            setSubdir(typeof init.subdir === 'string' ? init.subdir : '');
            await loadRepoData(rp);
            return;
          }
          // Workspace itself is NOT (inside) a git repo: fall back to the
          // discovered subdirectory repos as independently manageable repos.
          // If the selected sub-repo just stopped being a repo, drop back to
          // the list.
          setSubdir('');
          if (rp) { activeRepoRef.current = null; setActiveRepo(null); }
          const subs = Array.isArray(init.subrepos) ? init.subrepos : [];
          setSubrepos(subs);
          if (subs.length === 0) setPhase('not-repo');
          else { setRepoLimit(REPO_PAGE); setPhase('repo-list'); }
        } catch (err) {
          if (err?.code === 'git-missing') { setPhase('git-missing'); return; }
          if (err?.code === 'not-a-repo') { setPhase('not-repo'); return; }
          // No usable workspace yet (no session / cwd unavailable): show a
          // gentle hint instead of an error, and auto-retry while visible.
          if (err?.code === 'session-not-found') { setPhase('no-session'); setError(''); return; }
          setPhase('error');
          setError(err?.message ?? String(err));
        }
      }, [sessionId]);

      // Reload when the tab becomes visible or the filter parameters change;
      // `branches` is NOT a dependency (load sets it, would re-trigger).
      // `activeRepo` re-runs load when the user switches subdirectory repos.
      useEffect(() => { if (visible) load(); }, [visible, load, scopeMode, selectedKey, activeRepo]);

      // While waiting for a workspace session (no-session), retry a BOUNDED
      // number of times so the graph appears automatically once a session
      // becomes available, then stop and offer a manual retry.
      useEffect(() => {
        if (!visible || phase !== 'no-session') return;
        if (sessionRetries >= NO_SESSION_RETRY_MAX) return;
        const timer = setTimeout(() => { setSessionRetries((n) => n + 1); load(); }, 2000);
        return () => clearTimeout(timer);
      }, [visible, phase, sessionRetries, load]);

      useEffect(() => {
        if (expandedHash === null || !sessionId) { setDetail(null); return; }
        setDetailLoading(true);
        const controller = new AbortController();
        api('commit', { hash: expandedHash }, controller.signal)
          .then((d) => setDetail(d))
          .catch((err) => { if (err?.name !== 'AbortError') setError(err?.message ?? String(err)); })
          .finally(() => setDetailLoading(false));
        return () => controller.abort();
      }, [expandedHash, sessionId]);

      const toggleBranch = (name) => {
        setSelected((prev) => (prev.includes(name) ? prev.filter((x) => x !== name) : [...prev, name]));
      };
      const toggleRow = (hash) => {
        setExpandedHash((prev) => (prev === hash ? null : hash));
        if (expandedHash !== hash) {
          const row = rows.find((r) => r.oid === hash);
          setExpandedRefs(row?.refs ?? '');
        }
      };
      // ── subdirectory repo list navigation ──
      // Enter a sub-repo (or leave it): reset the graph/staging view, point
      // the ref at the new target and let the load effect re-render it. The
      // phase is forced to 'loading' so stale rows never linger on screen.
      const selectRepo = (path) => {
        activeRepoRef.current = path;
        setActiveRepo(path);
        setRows([]); setLaneMaps([]); setDetail(null); setExpandedHash(null); setStatus(null);
        setRepoLimit(REPO_PAGE);
        setPhase('loading');
      };
      const backToList = () => {
        activeRepoRef.current = null;
        setActiveRepo(null);
        setRows([]); setLaneMaps([]); setDetail(null); setExpandedHash(null); setStatus(null);
        setRepoLimit(REPO_PAGE);
        setPhase('loading');
      };

      // ── write operations (staging / committing) ──
      const refreshStatus = async () => {
        try { const s = await api('status'); setStatus(s); } catch { /* ignore */ }
      };
      const copy = (text) => copyText(text);
      const runWrite = async (fn, okMsg) => {
        setBusy(true);
        try {
          await fn();
          await refreshStatus();
          await load();
          setError('');
          if (okMsg) { setNotice(okMsg); setTimeout(() => setNotice(''), 3000); }
        } catch (err) { setError(err?.message ?? String(err)); }
        finally { setBusy(false); }
      };
      const doStage = (path) => runWrite(() => api('stage', path ? { path } : {}));
      const doUnstage = (path) => runWrite(() => api('unstage', path ? { path } : {}));
      // Bulk stage/unstage/discard scope to the VISIBLE entries when the
      // workspace is a subdir and the whole-repo view is off — so changes
      // hidden outside the workspace are never staged/discarded by accident.
      const doStageAll = () => {
        if (subdir && !showAllRepo) {
          const targets = visibleEntries.filter((en) => {
            const x = en.xy[0];
            return x === undefined || x === ' ' || x === '?';
          });
          if (targets.length === 0) return;
          runWrite(async () => { for (const en of targets) await api('stage', { path: en.path }); });
        } else {
          doStage(undefined);
        }
      };
      const doUnstageAll = () => {
        if (subdir && !showAllRepo) {
          const targets = visibleEntries.filter((en) => {
            const x = en.xy[0];
            return x !== undefined && x !== ' ' && x !== '?';
          });
          if (targets.length === 0) return;
          runWrite(async () => { for (const en of targets) await api('unstage', { path: en.path }); });
        } else {
          doUnstage(undefined);
        }
      };
      const doDiscard = (path) => {
        const en = (status?.entries ?? []).find((e) => e.path === path);
        const isUntracked = en?.xy === '??';
        if (isUntracked) {
          showConfirm(
            t('confirmDelete'),
            `${t('dangerUntrackedDelete')}\n${t('confirmDelUntracked')} ${path}`,
            t('confirmDelete'),
            () => runWrite(() => api('discard', { path })),
            [
              { text: t('confirmCheck1') },
              { text: t('confirmCheck2') },
              { text: t('confirmCheck3') },
            ],
          );
        } else {
          showConfirm(
            t('confirmDiscard'),
            `${t('confirmDiscardFile')} ${path}`,
            t('confirmDiscard'),
            () => runWrite(() => api('discard', { path })),
            [{ text: t('confirmDiscardCheck') }],
          );
        }
      };
      const doDiscardAll = () => {
        const entries = visibleEntries;
        const targets = entries.filter((en) => {
          const y = en.xy[1];
          return y !== undefined && y !== ' ' && y !== '?';
        });
        if (targets.length === 0) return;
        showConfirm(
          t('discardAll'),
          t('confirmDiscardAll'),
          t('confirmDiscardAllBtn'),
          () => runWrite(async () => { for (const en of targets) await api('discard', { path: en.path }); }),
        );
      };
      const doCommit = async () => {
        const msg = commitMsg.trim();
        if (!msg || busy) return;
        const signNameT = signName.trim();
        const signEmailT = signEmail.trim();
        if (signOn && (signNameT === '' || signEmailT === '')) {
          setNotice(t('signOffIncomplete'));
          setTimeout(() => setNotice(''), 3000);
          return;
        }
        // Sign-off trailer is appended to the message body; the backend passes
        // the string to `git commit -m` via spawn (no shell), so embedded
        // newlines survive verbatim (issue #3).
        const full = signOn ? `${msg}\n\n${t('signedOffBy')}${signNameT} <${signEmailT}>` : msg;
        await runWrite(() => api('wcommit', { message: full }));
        setCommitMsg('');
        // Sign-off (checkbox + name/email) is deliberately KEPT across commits
        // and only cleared when the worktree area view closes (statusOpen
        // effect), per issue #3 — the panel is no longer auto-collapsed here.
      };
      const onWorkAction = (e) => {
        const v = e.target.value;
        e.target.value = '';
        if (v === 'refresh') { refreshStatus(); load(); }
        else if (v === 'createBranch') openCreateBranch(undefined);
        else if (v === 'pageSize') showPageSizeDialog({ current: pageSize, onRun: (n) => { setPageSize(n); load(); } });
        else if (v === 'stageAll') doStageAll();
        else if (v === 'unstageAll') doUnstageAll();
        else if (v === 'discardAll') doDiscardAll();
        else if (v === 'commit') { setStatusOpen(true); }
        else if (v === 'fetchAll') doFetchAll();
      };
      // ── sync (pull / push / fetch-all) ──
      const doFetchAll = () => runWrite(() => api('fetchAll'), t('fetchAllDone'));
      const openSync = async (kind) => {
        try {
          const [rs, ts] = await Promise.all([
            api('remotes'),
            api('tags').catch(() => ({ tags: [] })),
          ]);
          if (!Array.isArray(rs.remotes) || rs.remotes.length === 0) {
            setNotice(t('noRemote'));
            setTimeout(() => setNotice(''), 3000);
            return;
          }
          showSyncDialog({
            kind,
            remotes: rs.remotes,
            tags: Array.isArray(ts.tags) ? ts.tags : [],
            local: branches?.local ?? [],
            remote: branches?.remote ?? [],
            upstreamOf: branches?.upstreamOf ?? {},
            currentBranch: branches?.current ?? '',
            onRun: (payload) => runWrite(async () => {
              const opId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
              // Fire the network op WITHOUT awaiting: git may block on a
              // credential prompt, during which we poll the host bridge.
              const mainPromise = api(kind, { ...payload, opId });
              // Poll the host credential bridge while the op runs; stop as
              // soon as the op settles (no more prompts will arrive).
              let mainDone = false;
              mainPromise.then(() => { mainDone = true; }, () => { mainDone = true; });
              for (;;) {
                const p = await api('prompt-poll', { opId }).catch(() => ({ prompt: null }));
                if (p && p.prompt != null) {
                  const answer = await showPromptDialog(String(p.prompt));
                  // Echo promptId back: one operation asks twice (username, then
                  // password) and the host keys pending prompts per prompt.
                  await api('prompt-answer', {
                    opId,
                    promptId: p.promptId,
                    value: answer === null ? '' : answer,
                  }).catch(() => {});
                  if (answer === null) break;
                } else if (mainDone) {
                  break; // op finished without a pending prompt
                } else {
                  await new Promise((r) => setTimeout(r, 300));
                }
              }
              const result = await mainPromise;
              // Credential persistence is git's own behaviour (it calls
              // `credential approve` on the configured helper after a
              // successful auth) — so all we do is tell the user what to
              // expect next time.
              const cred = result?.credentials;
              if (cred?.prompted) {
                setNotice(cred.helperConfigured
                  ? t('credSaved', { helper: (cred.helpers ?? []).join(', ') || 'credential.helper' })
                  : t('credNotSaved'));
                setTimeout(() => setNotice(''), 6000);
              }
              // Push ahead/behind hint (computed against the upstream).
              if (kind === 'push' && result?.info) {
                const { ahead, behind } = result.info;
                if (ahead > 0 || behind > 0) {
                  setNotice(t('aheadBehindNotice', { ahead, behind }));
                  setTimeout(() => setNotice(''), 4000);
                }
              }
            }, t('syncDone')),
            onFetchAll: doFetchAll,
          });
        } catch (err) { setError(err?.message ?? String(err)); }
      };
      // ── M5 branch write ops (checkout / create / detach) ──
      const dirtyCount = () => (status?.entries ?? []).length;
      const doCheckout = (branch, linkCurrent) => {
        if (busy) return;
        const run = () => runWrite(() => api('checkout', { branch, linkCurrent }), t('syncDone'));
        if (dirtyCount() > 0) showConfirm(t('checkout'), t('dirtyCheckoutMsg'), t('checkout'), run);
        else run();
      };
      const doCreateBranch = (name, base) => {
        if (busy) return;
        // On a fresh repo (no commits / no branches) the new branch is
        // unborn, so it won't appear in the branch tree until the first
        // commit — surface a hint so creation doesn't look like a no-op.
        const wasBlank = rows.length === 0 && (branches?.local ?? []).length === 0;
        const run = () => runWrite(async () => {
          await api('createBranch', { name, base });
          if (wasBlank) { setNotice(t('blankBranchCreated')); setTimeout(() => setNotice(''), 4000); }
        }, t('syncDone'));
        if (dirtyCount() > 0) showConfirm(t('createBranch'), t('dirtyCreateMsg'), t('createBranch'), run);
        else run();
      };
      const doCheckoutCommit = (hash) => {
        if (busy) return;
        const run = () => runWrite(() => api('checkoutCommit', { hash }), t('syncDone'));
        if (dirtyCount() > 0) showConfirm(t('checkoutCommit'), t('dirtyDetachMsg'), t('checkoutCommit'), run);
        else run();
      };
      const openCreateBranch = (base) => showBranchDialog({
        local: branches?.local ?? [],
        remote: branches?.remote ?? [],
        currentBranch: branches?.current ?? '',
        defaultBase: base,
        onRun: ({ name, base: b }) => doCreateBranch(name, b),
      });
      const openCheckoutTo = () => showCheckoutDialog({
        local: branches?.local ?? [],
        remote: branches?.remote ?? [],
        currentBranch: branches?.current ?? '',
        onRun: (branch, linkCurrent) => doCheckout(branch, linkCurrent),
      });
      const branchTreeMenu = ({ x, y, branch, isCurrent, isRemote }) => {
        const items = [];
        const bname = branch.name;
        if (!isRemote) {
          if (!isCurrent) items.push({ label: t('checkout'), onClick: () => doCheckout(bname) });
          items.push({ label: t('createFromHere'), onClick: () => openCreateBranch(bname) });
        } else {
          // Checkout a remote branch = create a local tracking branch.
          items.push({ label: t('checkout'), onClick: () => doCheckout(bname) });
          items.push({ label: t('createFromHere'), onClick: () => openCreateBranch(bname) });
        }
        if (items.length > 0) showCtxMenu(x, y, items);
      };
      const loadMore = async () => {
        if (loadingMore || ended) return;
        setLoadingMore(true);
        try {
          const p = activeRepoRef.current ? { repoPath: activeRepoRef.current } : {};
          let params;
          if (scopeModeRef.current === 'all') {
            params = selectedRef.current.length > 0 ? { revs: [...selectedRef.current] } : { all: true };
          } else {
            const cur = branches?.current ?? '';
            const up = branches?.upstreamOf?.[cur] ?? '';
            const revs = [cur, up].filter((x) => x !== '');
            params = revs.length > 0 ? { revs } : { revs: ['HEAD'] };
          }
          const g = await post('graph', { ...p, ...params, skip: rows.length, limit: pageSize });
          setRows((prev) => [...prev, ...g.rows]);
          // Continue lanes AND colors from the previous page's tail: the graph
          // neither breaks nor re-colors at the page boundary.
          const layout = layoutGraph(g.rows, lanesTailRef.current);
          setLaneMaps((prev) => [...prev, ...layout.rows]);
          lanesTailRef.current = { lanes: layout.lanes, colors: layout.colors };
          setEnded(g.ended);
        } catch (err) { setError(err?.message ?? String(err)); }
        finally { setLoadingMore(false); }
      };

      // Layout rows are maintained incrementally (page 1 + appended pages with
      // cross-page continuation); no full recompute here.
      const lanes = laneMaps;
      // 泳道间距按整页最宽的一行自适应（泳道越多越窄），节点半径随之缩小。
      const laneW = laneWidth(lanes.reduce((max, l) => Math.max(max, l.laneCount), 1));
      const radius = nodeRadius(laneW);
      // Per-branch color for multi-branch filtering: each selected branch gets
      // a stable palette color; rows belonging to one show it on the node icon.
      const branchColors = useMemo(() => {
        const m = new Map();
        [...selected].forEach((name, i) => m.set(name, LANE_COLORS[i % LANE_COLORS.length]));
        return m;
      }, [selected]);
      /** 远程分支名集合：给 ref 徽标区分「本地分支 / 远程分支 / 标签」用（图标 + 颜色）。 */
      const remoteRefs = new Set((branches?.remote ?? []).map((b) => b.name));
      const branchColorOf = (row) => {
        for (const ref of refNames(row.refs)) {
          const c = branchColors.get(ref);
          if (c) return c;
        }
        return null;
      };

      // Staging-area entries to SHOW. When the session workspace is a
      // subdirectory of a git repo (subdir != '') and "show whole repo" is
      // off, unrelated changes outside the workspace are hidden. Entry paths
      // stay repo-root-relative (as the host reports them) so write
      // operations keep working; display strips the workspace prefix.
      const visibleEntries = useMemo(() => {
        const entries = status?.entries ?? [];
        if (!subdir || showAllRepo) return entries;
        const prefix = `${subdir}/`;
        return entries.filter((en) => en.path === subdir || en.path.startsWith(prefix));
      }, [status, subdir, showAllRepo]);

      // After every status refresh, groups with more than
      // WT_GROUP_COLLAPSE_MAX visible items default to COLLAPSED (≤ max stays
      // expanded). Manual clicks override until the next status update.
      useEffect(() => {
        const entries = visibleEntries;
        const countStaged = entries.filter((en) => { const x = en.xy[0]; return x !== undefined && x !== ' ' && x !== '?'; }).length;
        const countUnstaged = entries.filter((en) => { const y = en.xy[1]; return en.xy !== '??' && y !== undefined && y !== ' ' && y !== '?'; }).length;
        const countUntracked = entries.filter((en) => en.xy === '??').length;
        setWtGroups({
          staged: countStaged <= WT_GROUP_COLLAPSE_MAX,
          unstaged: countUnstaged <= WT_GROUP_COLLAPSE_MAX,
          untracked: countUntracked <= WT_GROUP_COLLAPSE_MAX,
        });
      }, [visibleEntries]);

      // Closing the worktree area counts as "the view closed": drop retained
      // sign-off state (checkbox + name + email). The message itself is kept
      // across open/close as before (issue #3 sign-off retention rule).
      useEffect(() => {
        if (!statusOpen) { setSignOn(false); setSignName(''); setSignEmail(''); }
      }, [statusOpen]);
      /** The path to render for an entry: workspace-relative when the
       *  workspace is a subdir and the whole-repo view is off. */
      const displayPath = (p) => {
        if (subdir && !showAllRepo && typeof p === 'string' && p.startsWith(`${subdir}/`)) {
          return p.slice(subdir.length + 1);
        }
        return p;
      };

      // One worktree file row: click toggles an INLINE diff inside the git
      // view (no external tab, no whole-view refresh); right-click offers
      // stage/unstage/discard; icons follow the built-in GitView habits.
      const openWtInlineDiff = async (en, staged) => {
        if (wtDiff && wtDiff.path === en.path && wtDiff.staged === staged) { setWtDiff(null); return; }
        setWtDiff({ path: en.path, staged, loading: true, text: '' });
        try {
          const untracked = en.xy === '??';
          const r = await api('diff', { path: en.path, staged, untracked });
          setWtDiff({ path: en.path, staged, loading: false, text: r.diff });
        } catch (err) {
          setWtDiff({ path: en.path, staged, loading: false, text: '' });
          setError(err?.message ?? String(err));
        }
      };
      // The unified client file-open funnel — ctx.get('workspaces').openPath
      // (with better-sidebar interception active it opens files in the built-in
      // editor/file manager; otherwise it falls back to the host's default
      // opener). Resolved lazily via ctx.get so cordis's inject property guard
      // is never tripped; hidden from the row menu when unavailable.
      const fileOpener = useMemo(() => {
        try {
          const ws = ctx && typeof ctx.get === 'function' ? ctx.get('workspaces') : undefined;
          return ws && typeof ws.openPath === 'function' ? ws.openPath.bind(ws) : null;
        } catch { return null; }
      }, [ctx]);
      const doOpenInFileManager = async (en) => {
        if (!fileOpener) {
          setNotice(t('openInFmUnavailable'));
          setTimeout(() => setNotice(''), 3000);
          return;
        }
        try {
          // Host resolves the repo-root-relative entry to its absolute path
          // (repoPath is added automatically by `api` for sub-repos).
          const r = await api('absPath', { path: en.path });
          await fileOpener(r.abs);
        } catch (err) { setError(err?.message ?? String(err)); }
      };
      const fileRowMenu = (en, staged) => {
        const items = [];
        // "Open in built-in file manager": via the client's unified open funnel
        // (ctx.get('workspaces').openPath → better-sidebar interception lands it
        // in the built-in editor/file manager; otherwise the host default).
        if (fileOpener) items.push({ label: t('openInFileManager'), onClick: () => doOpenInFileManager(en) });
        if (staged) {
          items.push({ label: t('unstage'), onClick: () => doUnstage(en.path) });
          const y = en.xy[1];
          if (y !== undefined && y !== ' ' && y !== '?') items.push({ label: t('discard'), onClick: () => doDiscard(en.path) });
        } else if (en.xy === '??') {
          items.push({ label: t('stage'), onClick: () => doStage(en.path) });
          items.push({ label: t('confirmDelete'), onClick: () => doDiscard(en.path) });
        } else {
          items.push({ label: t('stage'), onClick: () => doStage(en.path) });
          items.push({ label: t('discard'), onClick: () => doDiscard(en.path) });
        }
        return items;
      };
      const renderFileRow = (en, staged) => h(Fragment, { key: en.path },
        h('div', {
          className: `sgg-wt-file${en.xy === '??' ? ' sgg-wt-untracked' : ''}`,
          title: `${staged ? t('staged') : t('unstaged')} · ${t('viewDiff')}`,
          onClick: () => openWtInlineDiff(en, staged),
          onContextMenu: (e) => {
            e.preventDefault();
            e.stopPropagation();
            showCtxMenu(e.clientX, e.clientY, fileRowMenu(en, staged));
          },
        },
          h('span', { className: `sgg-wt-badge${en.xy === '??' ? ' sgg-wt-badge-untracked' : ''}` }, badgeOf(en)),
          h('span', { className: 'sgg-wt-path', title: en.path }, displayPath(en.path)),
          h('button', {
            type: 'button', className: 'sgg-iconbtn', title: staged ? t('unstage') : t('stage'),
            'aria-label': staged ? t('unstage') : t('stage'), disabled: busy,
            onClick: (e) => { e.stopPropagation(); (staged ? doUnstage(en.path) : doStage(en.path)); },
          }, staged ? h(primitives.IconTrashOutline16, { size: 13 }) : h(primitives.IconBranchOutline16, { size: 13 })),
          h('button', {
            type: 'button', className: 'sgg-iconbtn',
            title: en.xy === '??' ? t('confirmDelete') : t('discard'),
            'aria-label': en.xy === '??' ? t('confirmDelete') : t('discard'),
            disabled: busy,
            onClick: (e) => { e.stopPropagation(); doDiscard(en.path); },
          }, '✕'),
        ),
        wtDiff && wtDiff.path === en.path && h(InlineDiff, {
          text: wtDiff.text,
          loading: wtDiff.loading,
          onClose: () => setWtDiff(null),
        }),
      );
      // Staged / unstaged(modified) / untracked — three explicit groups, each
      // with an independent collapse head (title shows the file count) and a
      // group-level "expand all / collapse all" toggle (issue #3).
      const renderStatusGroups = () => {
        const entries = visibleEntries;
        const staged = entries.filter((en) => { const x = en.xy[0]; return x !== undefined && x !== ' ' && x !== '?'; });
        const unstaged = entries.filter((en) => { const y = en.xy[1]; return en.xy !== '??' && y !== undefined && y !== ' ' && y !== '?'; });
        const untracked = entries.filter((en) => en.xy === '??');
        const groups = [
          { key: 'staged', label: t('staged'), items: staged, stagedRows: true },
          { key: 'unstaged', label: t('unstaged'), items: unstaged, stagedRows: false },
          { key: 'untracked', label: t('untracked'), items: untracked, stagedRows: false },
        ].filter((g) => g.items.length > 0);
        if (groups.length === 0) return null;
        const allExpanded = groups.every((g) => wtGroups[g.key]);
        const toggleGroup = (key) => setWtGroups((prev) => ({ ...prev, [key]: !prev[key] }));
        const toggleAll = () => {
          const next = !allExpanded;
          const patch = {};
          for (const g of groups) patch[g.key] = next;
          setWtGroups((prev) => ({ ...prev, ...patch }));
        };
        return h(Fragment, null,
          h('div', { className: 'sgg-wt-groups-toolbar' },
            h('button', {
              type: 'button', className: 'sgg-wt-groups-toggle',
              onClick: toggleAll, disabled: busy,
            }, allExpanded ? t('collapseAll') : t('expandAll')),
          ),
          groups.map((g) => h(Fragment, { key: g.key },
            h('div', {
              className: 'sgg-wt-group-head', role: 'button', tabIndex: 0,
              'aria-expanded': !!wtGroups[g.key],
              onClick: () => toggleGroup(g.key),
              onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleGroup(g.key); } },
            },
              h('span', { className: 'sgg-wt-caret' }, wtGroups[g.key] ? '▾' : '▸'),
              h('span', { className: 'sgg-wt-group-name' }, g.label),
              h('span', { className: 'sgg-wt-group-count' }, g.items.length),
            ),
            wtGroups[g.key] && g.items.map((en) => renderFileRow(en, g.stagedRows)),
          )),
        );
      };
      const stagedCount = visibleEntries.filter((en) => {
        const x = en.xy[0];
        return x !== undefined && x !== ' ' && x !== '?';
      }).length;

      let body;
      if (phase === 'loading') body = h('div', { className: 'sgg-empty' }, t('loading'));
      else if (phase === 'no-session') body = h('div', { className: 'sgg-empty' },
        sessionRetries >= NO_SESSION_RETRY_MAX ? t('noSessionStopped') : t('noSession'),
        h('div', { className: 'sgg-hint' },
          sessionRetries >= NO_SESSION_RETRY_MAX ? t('noSessionStoppedHint') : t('noSessionHint')),
        sessionRetries >= NO_SESSION_RETRY_MAX && h('button', {
          className: 'sgg-link',
          onClick: () => { setSessionRetries(0); load(); },
        }, t('retry')));
      else if (phase === 'not-repo') body = h('div', { className: 'sgg-empty' }, t('notRepo'));
      else if (phase === 'repo-list') body = h('div', { className: 'sgg-repolist' },
        h('div', { className: 'sgg-repolist-head' },
          h('span', { className: 'sgg-repolist-title' }, t('subrepos')),
          h('span', { className: 'sgg-repolist-count' }, t('repoCount', { count: subrepos.length })),
        ),
        h('div', { className: 'sgg-hint' }, t('subreposHint')),
        subrepos.length === 0
          ? h('div', { className: 'sgg-empty' }, t('noSubRepos'))
          : h(Fragment, null,
              subrepos.slice(0, repoLimit).map((repo) => h('div', {
                key: repo.path,
                className: 'sgg-repo-row',
                role: 'button',
                tabIndex: 0,
                title: `${repo.root}`,
                onClick: () => selectRepo(repo.path),
                onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectRepo(repo.path); } },
              },
                h('span', { className: 'sgg-repo-path', title: repo.root }, repo.path),
                repo.branch ? h('span', { className: 'sgg-repo-branch' }, repo.branch) : null,
                h('span', { className: 'sgg-repo-go' }, '›'),
              )),
              repoLimit < subrepos.length && h('button', {
                className: 'sgg-more',
                onClick: () => setRepoLimit((n) => n + REPO_PAGE),
              }, t('loadMoreRepos')),
            ),
      );
      else if (phase === 'git-missing') body = h('div', { className: 'sgg-error' }, t('gitMissing'));
      else if (phase === 'error') body = h('div', { className: 'sgg-error' },
        `${t('error')}: ${error}`, ' ',
        h('button', { className: 'sgg-link', onClick: load }, t('retry')));
      else body = h(Fragment, null,
        activeRepo && h('div', { className: 'sgg-repo-bar' },
          h('span', { className: 'sgg-repo-bar-path', title: activeRepo }, activeRepo),
          h('button', { className: 'sgg-link', onClick: backToList }, t('backToList')),
        ),
        h(BranchTree, { branches, scopeMode, selected, onToggleBranch: toggleBranch, onBranchMenu: branchTreeMenu, currentBranch: branches.current, branchColors }),
        rows.length === 0
          ? h('div', { className: 'sgg-empty' }, t('noCommits'))
          : h('div', { className: 'sgg-list' },
              h('div', { className: 'sgg-wt' },
                h('div', {
                  className: 'sgg-wt-head', role: 'button', tabIndex: 0,
                  onClick: () => setStatusOpen(!statusOpen),
                  onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setStatusOpen(!statusOpen); } },
                  onContextMenu: (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    showCtxMenu(e.clientX, e.clientY, [
                      { label: t('refresh'), onClick: () => { refreshStatus(); load(); } },
                      { label: t('stageAll'), onClick: () => doStageAll() },
                      { label: t('unstageAll'), onClick: () => doUnstageAll() },
                      { label: t('discardAll'), onClick: () => doDiscardAll() },
                      { label: t('commit'), onClick: () => setStatusOpen(true) },
                    ]);
                  },
                },
                  h('span', { className: 'sgg-wt-caret' }, statusOpen ? '▾' : '▸'),
                  h('span', { className: 'sgg-wt-icon' }, '◍'),
                  h('span', { className: 'sgg-wt-title' }, t('worktreeArea')),
                  visibleEntries.length > 0
                    ? h('span', { className: 'sgg-wt-info' }, `${t('staged')} ${stagedCount} · ${t('unstaged')} ${visibleEntries.length - stagedCount}`)
                    : h('span', { className: 'sgg-wt-info sgg-wt-clean' }, t('worktreeClean')),
                  h('span', { className: 'sgg-wt-actions' },
                    subdir && h('button', {
                      type: 'button', className: 'sgg-iconbtn', title: t('showAllRepo'), 'aria-label': t('showAllRepo'),
                      onClick: (e) => { e.stopPropagation(); setShowAllRepo(!showAllRepo); },
                      style: showAllRepo ? { color: 'var(--dsw-alias-brand-primary,#4d9fff)' } : null,
                    }, h(primitives.IconFullscreenOutline16, { size: 13 })),
                    h('button', {
                      type: 'button', className: 'sgg-iconbtn', title: t('stageAll'), 'aria-label': t('stageAll'),
                      disabled: busy || !status || visibleEntries.length === 0,
                      onClick: (e) => { e.stopPropagation(); doStageAll(); },
                    }, h(primitives.IconBranchOutline16, { size: 13 })),
                    h('button', {
                      type: 'button', className: 'sgg-iconbtn', title: t('unstageAll'), 'aria-label': t('unstageAll'),
                      disabled: busy || stagedCount === 0,
                      onClick: (e) => { e.stopPropagation(); doUnstageAll(); },
                    }, h(primitives.IconTrashOutline16, { size: 13 })),
                  ),
                ),
                statusOpen && h('div', { className: 'sgg-wt-body' },
                  h('div', { className: 'sgg-commit-panel' },
                    h('textarea', {
                      className: 'sgg-commit-input', rows: 3,
                      value: commitMsg, placeholder: t('commitInputPlaceholder'), disabled: busy,
                      onChange: (e) => setCommitMsg(e.target.value),
                      onKeyDown: (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') doCommit(); },
                    }),
                    h('div', { className: 'sgg-commit-hint' }, t('commitMsgHint')),
                    h('div', { className: 'sgg-commit-foot' },
                      h('div', { className: 'sgg-commit-sign' },
                        h('label', { className: 'sgg-commit-sign-check' },
                          h('input', {
                            type: 'checkbox', checked: signOn, disabled: busy,
                            onChange: (e) => setSignOn(e.target.checked),
                          }),
                          ' ',
                          t('signOff'),
                        ),
                        signOn && h(Fragment, null,
                          h('div', { className: 'sgg-commit-sign-row' },
                            h('input', {
                              className: 'sgg-commit-sign-input', value: signName,
                              placeholder: t('signNamePlaceholder'), disabled: busy,
                              onChange: (e) => setSignName(e.target.value),
                            }),
                            h('input', {
                              className: 'sgg-commit-sign-input', value: signEmail,
                              placeholder: t('signEmailPlaceholder'), disabled: busy,
                              onChange: (e) => setSignEmail(e.target.value),
                            }),
                          ),
                          (signName.trim() !== '' || signEmail.trim() !== '')
                            && h('div', { className: 'sgg-commit-sign-preview' },
                              t('signedOffBy'),
                              signEmail.trim() !== '' ? `${signName.trim()} <${signEmail.trim()}>` : signName.trim()),
                        ),
                      ),
                      h('button', {
                        className: 'sgg-commit-btn',
                        disabled: busy || commitMsg.trim() === '' || stagedCount === 0 || (signOn && (signName.trim() === '' || signEmail.trim() === '')),
                        onClick: doCommit,
                      }, t('commit')),
                    ),
                  ),
                  visibleEntries.length > 0
                    ? renderStatusGroups()
                    : h('div', { className: 'sgg-wt-empty' }, t('worktreeCleanHint')),
                ),
              ),
              rows.map((row, i) => h(GraphRow, {
                key: row.oid,
                row,
                lane: lanes[i],
                laneW,
                radius,
                branch: branches.current,
                open: expandedHash === row.oid,
                branchColor: branchColorOf(row),
                showTags,
                remoteRefs,
                onContextMenu: (pos) => showCtxMenu(pos.x, pos.y, [
                  { label: t('expand'), onClick: () => toggleRow(pos.row.oid) },
                  { label: t('viewDiff'), onClick: () => toggleRow(pos.row.oid) },
                  { label: t('checkoutTo'), onClick: openCheckoutTo },
                  { label: t('createBranchHere'), onClick: () => openCreateBranch(pos.row.oid) },
                  { label: t('checkoutCommit'), onClick: () => doCheckoutCommit(pos.row.oid) },
                  { label: t('copyShortHash'), onClick: () => copy(pos.row.oid.slice(0, 7)) },
                  { label: t('copyFullHash'), onClick: () => copy(pos.row.oid) },
                  { label: t('copySubject'), onClick: () => copy(pos.row.subject) },
                ]),
                onToggle: () => toggleRow(row.oid),
              })),
              !ended && h('button', { className: 'sgg-more', onClick: loadMore, disabled: loadingMore },
                loadingMore ? t('loading') : t('loadMore')),
            ),
        error && h('div', { className: 'sgg-error' }, error),
        notice && h('div', { className: 'sgg-notice' }, notice),
        detail && h(CommitDetail, {
          key: detail.hash, detail, branch: branches.current,
          refsRaw: expandedRefs,
          onClose: () => setExpandedHash(null),
        }),
        detailLoading && h('div', { className: 'sgg-empty' }, t('loading')),
      );

      return h('div', { 'data-dsh-plugin': 'dsh-shinki-git-graph', style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, overflow: 'hidden' } },
        h('div', { className: 'sgg-header' },
          activeRepo && h('button', {
            type: 'button', className: 'sgg-iconbtn', title: `${activeRepo} · ${t('backToList')}`,
            'aria-label': t('backToList'),
            onClick: backToList,
          }, '←'),
          h('select', {
            className: 'sgg-scope',
            value: scopeMode,
            title: t('scope'),
            onChange: (e) => setScopeMode(e.target.value),
          },
            h('option', { value: 'current-upstream' }, t('scopeCurUp')),
            h('option', { value: 'all' }, t('scopeAll')),
          ),
          h('select', {
            className: 'sgg-work',
            value: '',
            title: t('workAction'),
            disabled: phase !== 'ready',
            onChange: onWorkAction,
          },
            h('option', { value: '' }, '⋯'),
            h('option', { value: 'refresh' }, t('refresh')),
            h('option', { value: 'createBranch' }, t('createBranch')),
            h('option', { value: 'pageSize' }, t('pageSizeSetting')),
            h('option', { value: 'stageAll' }, t('stageAll')),
            h('option', { value: 'unstageAll' }, t('unstageAll')),
            h('option', { value: 'discardAll' }, t('discardAll')),
            h('option', { value: 'commit' }, t('commit')),
            h('option', { value: 'fetchAll' }, t('fetchAll')),
          ),
          h('button', {
            type: 'button', className: 'sgg-iconbtn', title: t('pull'), 'aria-label': t('pull'),
            disabled: busy || phase !== 'ready',
            onClick: () => openSync('pull'),
          }, '⇣'),
          h('button', {
            type: 'button', className: 'sgg-iconbtn', title: t('push'), 'aria-label': t('push'),
            disabled: busy || phase !== 'ready',
            onClick: () => openSync('push'),
          }, '⇡'),
          h('button', {
            type: 'button', className: 'sgg-iconbtn', title: t('showTags'), 'aria-label': t('showTags'),
            onClick: () => setShowTags(!showTags),
            style: showTags ? { color: 'var(--dsw-alias-brand-primary,#4d9fff)' } : null,
          }, '🏷'),
          h('span', { className: 'sgg-ver', title: 'plugin bundle version' }, `v${PLUGIN_VERSION}`),
          h('button', {
            type: 'button', className: 'sgg-iconbtn', title: t('refresh'), 'aria-label': t('refresh'),
            onClick: load, disabled: phase === 'loading',
          }, h(primitives.IconRefreshOutline16, { size: 14 })),
        ),
        body,
      );
    }

    // ── plugin body ──────────────────────────────────────────────────────
    // Cordis inject: property access without an inject declaration is
    // rejected ("cannot get property without inject"). `betterSidebar` is
    // provided by dsh-better-sidebar's client half.
    // Header version badge. ⚠ 必须与 package.json 的 `version` 同步：浏览器半边
    // 读不到 package.json，这里是**硬编码副本**，而用户看到的就是它 —— 只改
    // package.json 会显示过期版本（0.8.0 时踩过：json 已改、角标仍是 0.7.3）。
    const PLUGIN_VERSION = '0.9.1';
    const inject = ['locale', 'betterSidebar'];
    const name = 'dsh-shinki-git-graph';

    function apply(ctx) {
      injectCss();
      try { ctx.locale?.register?.(NS, { zh, en }); } catch { /* locale optional */ }
      const service = ctx?.betterSidebar ?? (typeof ctx.get === 'function' ? ctx.get('betterSidebar') : undefined);
      if (!service || typeof service.registerTab !== 'function') {
        console.warn('[dsh-shinki-git-graph] ctx.betterSidebar 不可用（需安装 dsh-better-sidebar），侧边栏 Tab 未注册');
        return;
      }
      let disposers = [];
      const off = service.registerTab({
        id: 'dsh-shinki-git-graph',
        title: () => t('tabTitle'),
        icon: (size) => h(primitives.IconBranchOutline16, { size }),
        order: 25,
        single: true,
        settings: {
          // Declarative plugin-owned setting rows (v0.12+): values persist in
          // the sidebar's pluginSettings['dsh-shinki-git-graph'] blob.
          pluginToggles: [
            {
              key: 'scope',
              type: 'select',
              title: () => t('settingScope'),
              options: [
                { value: 'current-upstream', title: () => t('settingScopeCurUp') },
                { value: 'all', title: () => t('settingScopeAll') },
              ],
            },
            {
              key: 'pageSize',
              type: 'select',
              title: () => t('settingPageSize'),
              options: [50, 100, 200, 500].map((n) => ({ value: n, title: () => String(n) })),
            },
            {
              key: 'showTags',
              type: 'switch',
              title: () => t('settingShowTags'),
            },
          ],
        },
        component: (props) => h(GitGraphTab, {
          ctx,
          scope: props.scope,
          visible: props.visible,
          sidebarStore: props.store,
        }),
      });
      disposers.push(off);
      ctx.effect?.(() => () => { for (const d of disposers) d(); }, 'dsh-shinki-git-graph: sidebar tab');
    }

    exports.name = name;
    exports.inject = inject;
    exports.apply = apply;
    // 仅供 Node 侧单测使用的内部句柄（tests/client-load.test.mjs）：浏览器半包没有别的
    // 导出通道，而图谱渲染（GraphRow/GraphLanes）必须在无浏览器环境下被**真实渲染**一遍，
    // 才能抓出渲染期错误。宿主不读这个字段，也不属于插件公开 API。
    exports.__internals = { GraphRow, GraphLanes, layoutGraph, primPath, nodeShape, laneWidth, nodeRadius, NODE_Y, ROW_H };
    return module.exports;
  },
});
