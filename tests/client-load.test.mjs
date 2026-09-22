/**
 * 浏览器半包冒烟测试：用最小的 ModuleLoader / React 替身在 Node 里加载 lib/client.js，
 * 校验导出与 apply() 注册 Tab，并把**图谱行的渲染真实跑一遍**（函数组件递归展开），
 * 以便在无浏览器环境下抓出渲染期错误（未定义变量、几何字段写错等）。
 *
 * 图谱的几何/配色正确性由 tests/graph-layout.test.mjs 断言；这里只管「渲染不抛异常 +
 * 渲染出来的 SVG 节点与预期形状一致」。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { cssDecls } from './css-tokens.mjs';

const CLIENT = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'client.js');

/** 极简 React 替身：createElement 造树，钩子返回稳定初值，effect 不执行。 */
function makeReactStub() {
  const noop = () => {};
  return {
    createElement: (type, props, ...children) => ({ __el: true, type, props: props ?? {}, children }),
    useState: (init) => [typeof init === 'function' ? init() : init, noop],
    useEffect: () => {},
    useRef: () => ({ current: null }),
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    Fragment: 'Fragment',
  };
}

/** 递归展开函数组件，得到宿主节点树（顺带执行渲染逻辑）。 */
function render(node, depth = 0) {
  if (depth > 60) return null;
  if (node === null || node === undefined || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map((n) => render(n, depth + 1));
  if (node.__el !== true) return node;
  if (typeof node.type === 'function') {
    return render(node.type({ ...node.props, children: node.children }), depth + 1);
  }
  return { type: node.type, props: node.props, children: node.children.map((c) => render(c, depth + 1)) };
}

/** 收集渲染树里的所有宿主节点。 */
function flatten(node, out = []) {
  if (Array.isArray(node)) { node.forEach((n) => flatten(n, out)); return out; }
  if (node && typeof node === 'object' && node.type) {
    out.push(node);
    flatten(node.children, out);
  }
  return out;
}

/** 渲染树里的所有文本。 */
function texts(nodes) {
  return nodes
    .filter((n) => typeof n.children?.[0] === 'string')
    .map((n) => n.children[0]);
}

function loadBundle() {
  const react = makeReactStub();
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    fetch: async () => { throw new Error('fetch 不应在加载/渲染期被调用'); },
    document: {
      getElementById: () => null,
      querySelector: () => null,
      createElement: () => ({ id: '', textContent: '', dataset: {} }),
      head: { appendChild: () => {} },
    },
    navigator: undefined,
  };
  sandbox.window = sandbox;
  let captured = null;
  sandbox.__ModuleLoader__ = {
    load: ({ id, factory }) => {
      captured = factory((name) => {
        if (name === 'react') return react;
        throw new Error(`bundle 不应 require(${name})`);
      });
      captured.__id = id;
    },
  };
  const code = readFileSync(CLIENT, 'utf8');
  const fn = new Function('window', 'document', 'navigator', 'console', 'fetch', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', `${code}\n`);
  fn(sandbox.window, sandbox.document, sandbox.navigator, console, sandbox.fetch, setTimeout, clearTimeout, setInterval, clearInterval);
  return { exports: captured, sandbox };
}

test('client bundle：可加载并导出 name/inject/apply', () => {
  const { exports } = loadBundle();
  assert.ok(exports, 'bundle 未调用 __ModuleLoader__.load');
  assert.equal(exports.__id, 'dsh-shinki-git-graph');
  assert.equal(exports.name, 'dsh-shinki-git-graph');
  assert.deepEqual([...exports.inject].sort(), ['betterSidebar', 'locale']);
  assert.equal(typeof exports.apply, 'function');
  assert.equal(typeof exports.__internals.GraphRow, 'function');
});

test('client bundle：apply() 注册侧边栏 Tab（含设置项），无 betterSidebar 时安全退出', () => {
  const { exports } = loadBundle();
  const registered = [];
  const locales = [];
  const effects = [];
  const ctx = {
    locale: { register: (ns, dict) => locales.push([ns, dict]) },
    betterSidebar: {
      registerTab: (desc) => { registered.push(desc); return () => {}; },
    },
    effect: (fn, label) => { effects.push(label); fn(); return () => {}; },
  };
  assert.doesNotThrow(() => exports.apply(ctx));
  assert.equal(registered.length, 1);
  assert.equal(registered[0].id, 'dsh-shinki-git-graph');
  assert.equal(registered[0].order, 25);
  assert.equal(typeof registered[0].component, 'function');
  assert.deepEqual(registered[0].settings.pluginToggles.map((x) => x.key), ['scope', 'pageSize', 'showTags']);
  assert.equal(registered[0].title(), 'Git 图谱');
  assert.equal(locales[0][0], 'shinkiGitGraph');
  assert.ok(locales[0][1].zh.tabTitle && locales[0][1].en.tabTitle);
  assert.ok(effects.some((l) => String(l).includes('sidebar tab')));
  // 没有 betterSidebar 服务时只警告、不抛
  assert.doesNotThrow(() => exports.apply({ locale: { register() {} }, effect: (fn) => fn() }));
});

test('client bundle：图谱行真实渲染出上下两层 SVG、曲线、节点与 refs 徽标', () => {
  const { exports } = loadBundle();
  const { GraphRow, layoutGraph } = exports.__internals;
  const rows = [
    { oid: 'aaa', parents: ['ccc'], subject: 'feat: 曲线泳道', refs: 'HEAD -> main', author: 'a', date: '2026-01-01T00:00:00+08:00' },
    { oid: 'bbb', parents: ['ccc'], subject: 'feat: 另一条支线', refs: 'feature/x, tag: v1', author: 'b', date: '2026-01-01T00:00:00+08:00' },
    { oid: 'ccc', parents: [], subject: 'root', refs: '', author: 'a', date: '2026-01-01T00:00:00+08:00' },
  ];
  const layout = layoutGraph(rows);
  const laneW = exports.__internals.laneWidth(layout.laneCount);
  const radius = exports.__internals.nodeRadius(laneW);
  const props = (i) => ({
    row: rows[i], lane: layout.rows[i], laneW, radius, branch: 'main', open: false,
    onToggle: () => {}, onContextMenu: () => {}, branchColor: null, showTags: true,
  });

  // ── 分叉汇合行（ccc，无 refs）：根节点是圆点，两条上游泳道斜插进来 ──
  const nodes = flatten(render(GraphRow(props(2))));
  const svgs = nodes.filter((n) => n.type === 'svg');
  assert.equal(svgs.length, 2, '应有上下两层 SVG');
  assert.equal(svgs[0].props.className, 'sgg-graph-down');
  assert.equal(svgs[1].props.className, 'sgg-graph-up');
  // 上下两层必须**共享同一个 x 映射**（都 width:100% + preserveAspectRatio=none），
  // 否则 max-width 收窄行宽时会出现「线在左、节点在右」的错位（v0.9.0 首版踩过）。
  assert.equal(svgs[0].props.width, '100%');
  assert.equal(svgs[1].props.width, '100%');
  assert.equal(svgs[0].props.preserveAspectRatio, 'none');
  assert.equal(svgs[1].props.preserveAspectRatio, 'none');
  // 上层 viewBox 高 = NODE_Y 且 height 恒为 NODE_Y 像素 → y 仍 1:1，圆不会被拉扁
  assert.equal(svgs[1].props.viewBox, `0 0 ${layout.laneCount * laneW} ${exports.__internals.NODE_Y}`);
  assert.equal(svgs[1].props.height, exports.__internals.NODE_Y);

  const paths = nodes.filter((n) => n.type === 'path');
  assert.equal(paths.length, 2, '上半段：节点自身泳道 + 一条汇入曲线');
  assert.ok(paths.some((p) => p.props.d.includes('C')), '应有 S 曲线');
  // 颜色必须是主题 token（var(--sgg-lane-N)）或具体色值；两条线不同色（分叉可辨）
  assert.ok(paths.every((p) => /^(#|var\(--sgg-lane-\d\))$/.test(p.props.stroke)));
  assert.equal(new Set(paths.map((p) => p.props.stroke)).size, 2, '两条线颜色必须不同（分叉可辨）');
  const circles = nodes.filter((n) => n.type === 'circle');
  assert.equal(circles.length, 1, '无 refs 的节点是圆点');
  assert.equal(circles[0].props.cx, laneW * (layout.rows[2].node.col + 0.5));
  assert.equal(nodes.filter((n) => n.type === 'rect').length, 0, '无 refs 不应有方块/描边');
  assert.ok(texts(nodes).includes('root'), '主题文本应渲染');

  // ── HEAD 行（aaa，refs = "HEAD -> main"）：方块节点 + 描边圈 ──
  const head = flatten(render(GraphRow(props(0))));
  const rects = head.filter((n) => n.type === 'rect');
  assert.equal(rects.length, 2, 'HEAD + 有 ref → 方块 + 描边');
  assert.equal(rects[0].props.x, laneW * 0.5 - radius);
  assert.equal(rects[0].props.width, radius * 2);
  const ring = rects.find((r) => r.props.fill === 'none');
  assert.ok(ring && ring.props.stroke === 'currentColor' && ring.props.width === (radius + 1.5) * 2);
  assert.equal(head.filter((n) => n.type === 'circle').length, 0);
  assert.ok(texts(head).includes('main'), 'refs 徽标应渲染');
  assert.ok(texts(head).includes('feat: 曲线泳道'), '主题文本应渲染');
});

test('client bundle：refs 为空 & 非 HEAD → 圆形节点、无描边；branchColor 覆盖节点色', () => {
  const { exports } = loadBundle();
  const { GraphRow, layoutGraph } = exports.__internals;
  const rows = [{ oid: 'solo', parents: [], subject: 'root', refs: '', author: 'a', date: '2026-01-01T00:00:00+08:00' }];
  const layout = layoutGraph(rows);
  const laneW = 15;
  const tree = render(GraphRow({
    row: rows[0], lane: layout.rows[0], laneW, radius: 4, branch: '', open: false,
    onToggle: () => {}, onContextMenu: () => {}, branchColor: '#ff0000', showTags: true,
  }));
  const nodes = flatten(tree);
  const circles = nodes.filter((n) => n.type === 'circle');
  assert.equal(circles.length, 1);
  assert.equal(circles[0].props.fill, '#ff0000', 'branchColor 应覆盖节点颜色');
  assert.equal(nodes.filter((n) => n.type === 'rect').length, 0, '空 refs 不应有方块/描边');
  // 没有父提交 → 下半段为空
  assert.equal(nodes.filter((n) => n.type === 'path').length, 0);
});

test('CSS 契约：图谱列必须贯穿整行（否则相邻提交之间会断线 ~6px）', () => {
  const { exports } = loadBundle();
  const { NODE_Y } = exports.__internals;
  // 竖直内边距必须挂在 .sgg-main 上：.sgg-row 一旦有上下 padding，图谱列（align-self:stretch
  // 只能撑到 content box）就会被夹住 → 每两行之间 6px 断线。这条测试锁死该不变量。
  const row = cssDecls('.sgg-row');
  assert.equal(row.padding, '0 8px', '.sgg-row 不能有竖直内边距（图谱列要贯穿整行）');
  assert.equal(row['padding-top'], undefined);
  assert.equal(row['padding-bottom'], undefined);
  const main = cssDecls('.sgg-main');
  assert.equal(main.padding, '3px 0', '行的竖直内边距应放在 .sgg-main 上（保持文字间距不变）');
  // 图谱列撑满行高，且上下两层在 NODE_Y 处**精确对接**（x 比例同为 1:1）
  assert.equal(cssDecls('.sgg-graph')['align-self'], 'stretch');
  assert.equal(cssDecls('.sgg-graph-up').top, '0');
  assert.equal(cssDecls('.sgg-graph-down').top, `${NODE_Y}px`, '下层必须正好从节点所在行高开始');
  assert.equal(cssDecls('.sgg-graph-down').height, `calc(100% - ${NODE_Y}px)`, '下层高度应为 100% - NODE_Y');
  assert.equal(cssDecls('.sgg-graph-down')['view-box'], undefined); // viewBox 由属性给，不在 CSS 里
  // 不能裁剪图谱列：圆头线帽各向外伸 1px，正好跨过行边界糊住接缝
  // （小数设备像素下若不重叠，两行之间可能露出一条亮缝）。
  assert.equal(cssDecls('.sgg-graph').overflow, undefined, '.sgg-graph 不应裁剪（否则行间缝被切断）');
  assert.equal(cssDecls('.sgg-graph-up').overflow, 'visible');
  assert.equal(cssDecls('.sgg-graph-down').overflow, 'visible');
  assert.equal(cssDecls('.sgg-graph path')['stroke-linecap'], 'round', '圆头线帽是接缝重叠的保证');
});

/** 在渲染树里按徽标上的名字找那个徽标节点。 */
function chipNamed(nodes, name) {
  return nodes.find((n) => typeof n.props.className === 'string'
    && /^sgg-ref($|\s)/.test(n.props.className)
    && flatten(n.children).some((c) => c.children?.[0] === name));
}

test('ref 徽标：本地分支 / 远程分支 / 标签各有图标（类型不能只靠颜色区分）', () => {
  const { exports } = loadBundle();
  const { GraphRow, layoutGraph } = exports.__internals;
  const rows = [{
    oid: 'r1', parents: [], subject: 'chore: 版本号',
    refs: 'HEAD -> main, origin/main, tag: v0.9.0',
    author: 'a', date: '2026-01-01T00:00:00+08:00',
  }];
  const layout = layoutGraph(rows);
  const nodes = flatten(render(GraphRow({
    row: rows[0], lane: layout.rows[0], laneW: 15, radius: 4, branch: 'main', open: false,
    onToggle: () => {}, onContextMenu: () => {}, branchColor: null, showTags: true,
    remoteRefs: new Set(['origin/main']),
  })));

  const chips = nodes.filter((n) => typeof n.props.className === 'string' && /^sgg-ref($|\s)/.test(n.props.className));
  assert.deepEqual(chips.map((c) => c.props.title).sort(), ['main', 'origin/main', 'v0.9.0']);

  const iconPath = (name) => {
    const chip = chipNamed(nodes, name);
    assert.ok(chip, `找不到徽标 ${name}`);
    const svg = flatten(chip.children).find((n) => n.type === 'svg');
    assert.ok(svg, `${name} 徽标缺少图标（类型会退化成只靠颜色区分）`);
    return flatten(svg.children).find((n) => n.type === 'path').props.d;
  };
  const branch = iconPath('main');
  const remote = iconPath('origin/main');
  const tag = iconPath('v0.9.0');
  assert.notEqual(tag, branch, '标签图标必须与分支图标不同');
  assert.notEqual(remote, branch, '远程分支图标必须与本地分支图标不同');
  assert.notEqual(remote, tag);

  // 当前分支（HEAD -> main）走 current token；远程分支不能因为名字里有 '/' 就被当成远程
  assert.match(chipNamed(nodes, 'main').props.className, /sgg-ref-current/);
  assert.match(chipNamed(nodes, 'v0.9.0').props.className, /sgg-ref-tag/);

  // 本地分支名里带 '/' 也必须用分支图标（feature/x 不是远程分支）
  const local = flatten(render(GraphRow({
    row: { ...rows[0], refs: 'feature/x' }, lane: layout.rows[0], laneW: 15, radius: 4, branch: 'main',
    open: false, onToggle: () => {}, onContextMenu: () => {}, branchColor: null, showTags: true,
    remoteRefs: new Set(['origin/main']),
  })));
  assert.equal(chipNamed(local, 'feature/x').props.title, 'feature/x');
  const localIcon = flatten(flatten(chipNamed(local, 'feature/x').children).find((n) => n.type === 'svg').children)
    .find((n) => n.type === 'path').props.d;
  assert.equal(localIcon, branch, 'feature/x 是本地分支，应使用分支图标');
});

test('预览脚本的徽标图标与 client.js 保持一致（漂移守卫）', () => {
  const client = readFileSync(CLIENT, 'utf8');
  const preview = readFileSync(join(CLIENT, '..', '..', 'tests', 'graph-preview.mjs'), 'utf8');
  const icons = [...preview.matchAll(/^\s+(?:branch|remote|tag): '([^']+)',$/gm)].map((m) => m[1]);
  assert.equal(icons.length, 3, '应为 branch/remote/tag 三条图标路径');
  for (const d of icons) assert.ok(client.includes(d), `预览图标与 client.js 不一致：${d.slice(0, 24)}…`);
});

test('CSS 注入：热更后必须按新内容覆写（不能只按 <style> 已存在就跳过）', () => {
  const client = readFileSync(CLIENT, 'utf8');
  const body = /function injectCss\(\) \{([\s\S]*?)\n    \}/.exec(client);
  assert.ok(body, '找不到 injectCss');
  // 复用已有 <style> 并覆写 textContent（HMR 热更后新 CSS 才会生效）
  assert.match(body[1], /querySelector\('style\[data-dsh-plugin=/);
  assert.match(body[1], /style\.textContent = CSS/);
  assert.equal(/if \(document\.querySelector\('style\[data-dsh-plugin=[^)]*\)\) return;/.test(body[1]), false,
    'injectCss 不应在 <style> 已存在时直接 return');
});
