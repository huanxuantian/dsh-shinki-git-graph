/**
 * 「全部分支」模式下勾选/取消分支的交互单测（v0.11.1）。
 *
 * 为什么需要这个文件：`client-load.test.mjs` 的 React 替身不实现状态与副作用，
 * 只能渲染一次；而「勾选分支 → 视图是否真的重新拉取/过滤」是**状态 + effect 依赖**
 * 的问题，必须有一个能跑 useState/useEffect/重渲染的最小 React。这里自建一个
 * mini-react（hooks 按全局渲染顺序分配，够用且可预测），配合假 DOM + 假 fetch，
 * 记录组件到底发了哪些 `/shinki-git/api` 请求、渲染出了什么。
 *
 * 用户报告的现象：全部分支模式下勾选/取消分支，视图没有刷新（分支标识该显示/隐藏的没变）。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const CLIENT = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'client.js');

// ── 假 DOM（与 client-load 的严格版一致：insertBefore 校验参照节点）────────
function makeFakeDom() {
  const make = (tag) => {
    const el = {
      tagName: tag, children: [], className: '', textContent: '', style: {}, dataset: {},
      type: '', title: '', value: '', disabled: false, checked: false, rows: 0, placeholder: '',
      appendChild(c) { el.children.push(c); return c; },
      insertBefore(c, ref) {
        if (ref !== undefined && !el.children.includes(ref)) throw new Error('NotFoundError: 参照节点不是子节点');
        el.children.push(c); return c;
      },
      set innerHTML(v) { if (v === '') el.children.length = 0; },
      get innerHTML() { return ''; },
      remove() {},
      addEventListener() {}, removeEventListener() {},
      classList: {
        add(c) { if (!el.classList.contains(c)) el.className = `${el.className} ${c}`.trim(); },
        contains(c) { return el.className.split(/\s+/).includes(c); },
      },
    };
    return el;
  };
  const document = {
    createElement: make, querySelector: () => null, querySelectorAll: () => [],
    getElementById: () => null, head: make('head'), body: make('body'),
  };
  return { document };
}

// ── mini React：真状态 + 真副作用 + 重渲染 ────────────────────────────────
function makeMiniReact() {
  const state = [];
  const refs = [];
  const effects = [];   // { deps, fn }
  const memo = [];
  let cursor = 0;
  let pending = [];

  const react = {
    createElement: (type, props, ...children) => ({ __el: true, type, props: props ?? {}, children }),
    Fragment: 'Fragment',
    useState(init) {
      const i = cursor++;
      if (!(i in state)) state[i] = typeof init === 'function' ? init() : init;
      // 只改值，不在这里同步重渲染：真实 React 会批处理同一批次里的多个 setState
      // （client 的 loadRepoData 先 setRows 再 setLaneMaps，中间渲染会取到长度不匹配的槽位）。
      return [state[i], (v) => { state[i] = typeof v === 'function' ? v(state[i]) : v; }];
    },
    useRef(v) {
      const i = cursor++;
      if (!(i in refs)) refs[i] = { current: v };
      return refs[i];
    },
    useEffect(fn, deps) {
      const i = cursor++;
      const prev = effects[i];
      const changed = !prev || !deps || deps.length !== prev.deps.length
        || deps.some((d, k) => !Object.is(d, prev.deps[k]));
      if (changed) pending.push({ i, fn, deps });
    },
    useMemo(fn, deps) {
      const i = cursor++;
      const prev = memo[i];
      const changed = !prev || !deps || deps.length !== prev.deps.length
        || deps.some((d, k) => !Object.is(d, prev.deps[k]));
      if (changed) memo[i] = { value: fn(), deps };
      return memo[i].value;
    },
    useCallback(fn, deps) {
      const i = cursor++;
      const prev = memo[`cb${i}`];
      const changed = !prev || !deps || deps.length !== prev.deps.length
        || deps.some((d, k) => !Object.is(d, prev.deps[k]));
      if (changed) memo[`cb${i}`] = { value: fn, deps };
      return memo[`cb${i}`].value;
    },
  };
  return {
    react,
    /** 渲染一次根组件并展开子树（hooks 在展开过程中按顺序分配）。 */
    render(rootType, props) {
      cursor = 0;
      pending = [];
      const expand = (node, depth = 0) => {
        if (depth > 80 || node === null || node === undefined) return null;
        if (Array.isArray(node)) return node.map((n) => expand(n, depth + 1));
        if (typeof node !== 'object' || node.__el !== true) return node;
        if (typeof node.type === 'function') return expand(node.type({ ...node.props, children: node.children }), depth + 1);
        return { type: node.type, props: node.props, children: node.children.map((c) => expand(c, depth + 1)) };
      };
      const tree = expand(react.createElement(rootType, props));
      for (const e of pending) {
        effects[e.i] = { deps: e.deps };
        const cleanup = e.fn();
        if (typeof cleanup === 'function') effects[`cleanup${e.i}`] = cleanup;
      }
      pending = [];
      return tree;
    },
  };
}

/** 深度优先收集宿主节点。 */
function flatten(node, out = []) {
  if (Array.isArray(node)) { node.forEach((n) => flatten(n, out)); return out; }
  if (node && typeof node === 'object' && node.type) { out.push(node); flatten(node.children, out); }
  return out;
}

/** 假 fetch：按 method 返回预置响应，并记录每次调用。 */
function makeFetch(rows, calls) {
  const branchesData = {
    current: 'main',
    local: [{ name: 'main', upstream: 'origin/main' }, { name: 'feature', upstream: '' }],
    remote: [{ name: 'origin/main', upstream: '' }],
    upstreamOf: { main: 'origin/main' },
  };
  return async (url, opts = {}) => {
    const body = JSON.parse(opts.body ?? '{}');
    calls.push(body);
    let value = {};
    switch (body.method) {
      case 'init': value = { isRepo: true, root: '/r', branch: 'main', head: rows[0].oid, subdir: '' }; break;
      case 'branches': value = branchesData; break;
      case 'status': value = { entries: [] }; break;
      case 'mergeState': value = { merging: false }; break;
      case 'tags': value = { tags: [] }; break;
      case 'remotes': value = { remotes: [{ name: 'origin', url: 'git@x' }] }; break;
      case 'graph': {
        // 粗略模拟 host：给了 revs 就只返回这些分支上的提交（按 refs 匹配），否则 --all 全给
        const revs = Array.isArray(body.revs) ? body.revs : [];
        const picked = body.all === true || revs.length === 0
          ? rows
          : rows.filter((r) => revs.some((v) => String(r.refs).split(',').map((x) => x.trim().replace(/^HEAD -> /, '')).includes(v)));
        value = { rows: picked, ended: true };
        break;
      }
      default: value = {};
    }
    return {
      ok: true,
      status: 200,
      async json() { return { ok: true, value }; },
    };
  };
}

function loadBundle({ document: dom, fetchImpl, calls }) {
  const mini = makeMiniReact();
  const sandbox = {
    console, setTimeout, clearTimeout, setInterval: () => 1, clearInterval,
    fetch: fetchImpl,
    document: dom,
    navigator: { language: 'zh-CN' },
    localStorage: { getItem: () => null, setItem: () => {} },
    addEventListener() {}, removeEventListener() {},
  };
  sandbox.window = sandbox;
  let captured = null;
  sandbox.__ModuleLoader__ = {
    load: ({ id, factory }) => {
      captured = factory((name) => {
        if (name === 'react') return mini.react;
        throw new Error(`bundle 不应 require(${name})`);
      });
      captured.__id = id;
    },
  };
  new Function('window', 'document', 'navigator', 'console', 'fetch', 'setTimeout', 'clearTimeout',
    'setInterval', 'clearInterval', 'localStorage',
    `${readFileSync(CLIENT, 'utf8')}\n`)(
    sandbox.window, dom, sandbox.navigator, console, fetchImpl, setTimeout, clearTimeout,
    sandbox.setInterval, clearInterval, sandbox.localStorage);
  return { exports: captured, mini, sandbox, calls };
}

const ROWS = [
  { oid: 'a'.repeat(40), parents: ['b'.repeat(40)], subject: 'main work', refs: 'HEAD -> main, origin/main', author: 'a', date: '2026-01-02T00:00:00+08:00' },
  { oid: 'b'.repeat(40), parents: [], subject: 'feature work', refs: 'feature', author: 'a', date: '2026-01-01T00:00:00+08:00' },
];

/** 挂载 Tab 组件，跑完初始加载，返回可再次 flush 的句柄。 */
async function mountTab() {
  const dom = makeFakeDom();
  const calls = [];
  const { exports, mini } = loadBundle({ document: dom.document, fetchImpl: makeFetch(ROWS, calls), calls });
  let tree = null;
  const registered = [];
  let betterCalls = 0;
  const ctx = {
    locale: { register() {} },
    get: (n) => {
      if (n === 'shinkiViews') return { register: (sp) => { registered.push(sp); return () => {}; } };
      if (n === 'betterSidebar') return { registerTab: () => { betterCalls += 1; return () => {}; }, updateTab() {} };
      return undefined;
    },
    effect: (fn) => { fn(); return () => {}; },
  };
  exports.apply(ctx);
  if (registered.length !== 1) throw new Error('应恰好经适配层注册 1 个视图，实际 ' + registered.length);
  if (betterCalls !== 0) throw new Error('不应再直连 better-sidebar');
  const spec = registered[0];
  const tab = { id: spec.id, component: spec.render, settings: spec.settings, targets: spec.targets };
  const tabProps = { ctx, scope: { sessionId: 's1', cwd: '/r' }, visible: true, store: null };
  const flush = async (ticks = 6) => {
    for (let i = 0; i < ticks; i += 1) {
      tree = mini.render(tab.component, tabProps);
      // 让已发出的 promise 落地
      await new Promise((r) => setTimeout(r, 0));
    }
    return tree;
  };
  await flush();
  return { dom, calls, tree: () => tree, flush, tab };
}

/** 找到某个分支所在行的复选框节点。 */
function checkboxOf(tree, branch) {
  const rows = flatten(tree).filter((n) => (n.props.className ?? '').includes('sgg-tree-row'));
  for (const row of rows) {
    const name = flatten(row.children).find((n) => (n.props.className ?? '') === 'sgg-tree-name');
    if (name && String(name.children?.[0] ?? '').endsWith(branch)) {
      return flatten(row.children).find((n) => n.type === 'input' && n.props.type === 'checkbox');
    }
  }
  return null;
}

const graphCalls = (calls) => calls.filter((c) => c.method === 'graph');

test('全部分支模式：勾选分支必须触发重新拉图（视图刷新）', async () => {
  const { calls, tree, flush } = await mountTab();
  const first = graphCalls(calls);
  assert.ok(first.length >= 1, '挂载后应至少拉一次图');
  assert.deepEqual(first[0].revs, ['main', 'origin/main'], '默认 scope 是「当前分支 + 上游」');

  // 切到「全部分支」模式（默认可能是当前+上游）
  const scopeSel = flatten(tree()).find((n) => (n.props.className ?? '') === 'sgg-scope');
  scopeSel.props.onChange({ target: { value: 'all' } });
  await flush();
  assert.equal(calls.some((c) => c.method === 'branches'), true);

  const before = graphCalls(calls).length;
  const cb = checkboxOf(tree(), 'feature');
  assert.ok(cb, '全部分支模式下分支树应出现「feature」的复选框');
  assert.equal(cb.props.checked, false);

  // 勾选 feature
  cb.props.onChange();
  await flush();
  const after = graphCalls(calls).slice(before);
  assert.ok(after.length >= 1, '勾选分支后必须重新拉图（否则就是用户报的「视图没刷新」）');
  assert.deepEqual(after[after.length - 1].revs, ['feature'], '应只按勾选的分支过滤');

  // 复选框状态要跟着勾选变（受控）
  assert.equal(checkboxOf(tree(), 'feature').props.checked, true);
  // 视图（提交行）也要跟着变：只剩 feature 那条
  const subjects = flatten(tree())
    .filter((n) => (n.props.className ?? '') === 'sgg-subject')
    .map((n) => n.children?.[0]);
  assert.deepEqual(subjects, ['feature work'], `勾选 feature 后视图应只剩 feature 的提交，实际：${subjects.join('|')}`);
});

test('全部分支模式：取消勾选最后一个分支回到 --all', async () => {
  const { calls, tree, flush } = await mountTab();
  const scopeSel = flatten(tree()).find((n) => (n.props.className ?? '') === 'sgg-scope');
  scopeSel.props.onChange({ target: { value: 'all' } });
  await flush();

  const cb = checkboxOf(tree(), 'main');
  assert.ok(cb, '应出现「main」的复选框');
  cb.props.onChange();
  await flush();
  let last = graphCalls(calls).pop();
  assert.deepEqual(last.revs, ['main']);

  // 再取消：selected 变空 → 回到 --all
  const cb2 = checkboxOf(tree(), 'main');
  assert.equal(cb2.props.checked, true);
  cb2.props.onChange();
  await flush();
  last = graphCalls(calls).pop();
  assert.equal(last.all, true, '取消全部勾选应回到 --all');
});

test('全部分支模式：勾选后提交行只显示被勾选分支的标识（未勾选的徽标要隐藏）', async () => {
  const { tree, flush } = await mountTab();
  const scopeSel = flatten(tree()).find((n) => (n.props.className ?? '') === 'sgg-scope');
  scopeSel.props.onChange({ target: { value: 'all' } });
  await flush();

  const chipNames = () => flatten(tree())
    .filter((n) => (n.props.className ?? '').split(/\s+/).includes('sgg-ref'))
    .map((n) => n.props.title);
  assert.deepEqual(chipNames().sort(), ['feature', 'main', 'origin/main'].sort(), '未过滤时应显示全部 ref 徽标');

  checkboxOf(tree(), 'feature').props.onChange();
  await flush();
  const after = chipNames();
  assert.ok(after.includes('feature'), `被勾选分支的标识应保留，实际：${after.join(',')}`);
  assert.ok(!after.includes('origin/main'), `未勾选分支（origin/main）的标识必须隐藏，实际：${after.join(',')}`);
  assert.ok(!after.includes('main'), `未勾选分支（main）的标识必须隐藏，实际：${after.join(',')}`);
});

test('全部分支模式：过滤生效时有可见提示，并可一键清空', async () => {
  const { tree, flush } = await mountTab();
  const scopeSel = flatten(tree()).find((n) => (n.props.className ?? '') === 'sgg-scope');
  scopeSel.props.onChange({ target: { value: 'all' } });
  await flush();

  // 提示块可能是纯文本（未过滤）或「文本 + 清空按钮」（过滤中），两种都取到
  const nodeText = (n) => {
    if (typeof n === 'string') return n;
    if (Array.isArray(n)) return n.map(nodeText).join('');
    if (!n || typeof n !== 'object') return '';
    if (typeof n.children?.[0] === 'string') return n.children[0];
    return (n.children ?? []).map(nodeText).join('');
  };
  const hintText = () => flatten(tree())
    .filter((n) => (n.props.className ?? '').includes('sgg-hint'))
    .map(nodeText)
    .join(' | ');
  assert.match(hintText(), /勾选分支以过滤/, '未过滤时给提示');

  checkboxOf(tree(), 'main').props.onChange();
  await flush();
  assert.match(hintText(), /已按 1 个分支过滤/, `过滤后应显示生效提示，实际：${hintText()}`);

  // 一键清空
  const clear = flatten(tree()).find((n) => n.type === 'button' && n.children?.[0] === '清空筛选');
  assert.ok(clear, '应有「清空筛选」入口');
  clear.props.onClick();
  await flush();
  assert.equal(checkboxOf(tree(), 'main').props.checked, false);
  assert.match(hintText(), /勾选分支以过滤/);
});
