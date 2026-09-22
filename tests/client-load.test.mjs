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
  // 上层 viewBox 与节点层一致（1:1，圆不会被拉扁）
  assert.equal(svgs[1].props.viewBox, `0 0 ${layout.laneCount * laneW} 12`);

  const paths = nodes.filter((n) => n.type === 'path');
  assert.equal(paths.length, 2, '上半段：节点自身泳道 + 一条汇入曲线');
  assert.ok(paths.some((p) => p.props.d.includes('C')), '应有 S 曲线');
  assert.ok(paths.every((p) => typeof p.props.stroke === 'string' && p.props.stroke.startsWith('#')));
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
