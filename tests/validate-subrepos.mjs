// 真机实测脚本（临时）：用真实 routes.js 全链路对 D:\AI\win\data\home 做子仓库探测验证。
// 运行：node tests/validate-subrepos.mjs （用引擎自带 node）
import http from 'node:http';
import { createHandler } from '../lib/routes.js';

const home = 'D:/AI/win/data/home';
const ctx = {
  sessions: { get: (id) => (id === 's1' ? { header: { cwd: home } } : undefined) },
  webRuntime: { trustedHosts: [] },
  logger: { warn() {} },
};
const handler = createHandler(ctx);
const server = http.createServer((req, res) => { handler(req, res).catch(() => { res.writeHead(500); res.end(); }); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

async function call(method, payload = {}) {
  const res = await fetch(`http://127.0.0.1:${port}/shinki-git/api`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 's1', method, ...payload }),
  });
  const body = await res.json();
  return { status: res.status, body };
}
const show = (label, x) => console.log(`\n${label}\n${JSON.stringify(x, null, 2)}`);

// 1) init：工作区本身非 git → 应返回 subrepos（3 层内、跳过隐藏/node_modules、排除第 4 层）
const init = await call('init');
show('1) init(工作区非 git)', {
  isRepo: init.body.value.isRepo,
  subrepos: init.body.value.subrepos?.map((s) => ({ path: s.path, branch: s.branch, head: s.head, subdir: s.subdir })),
});

// 2) 对某个子仓库做 branches/graph/status（repoPath 定位）
for (const rp of ['repo-one', 'nested', 'nested/deep', 'repo-blank']) {
  const b = await call('branches', { repoPath: rp });
  show(`2) branches(${rp})`, { status: b.status, ok: b.body.ok, current: b.body.value?.current, local: b.body.value?.local?.length, error: b.body.error });
}
const g = await call('graph', { repoPath: 'repo-one', limit: 5 });
show('2b) graph(repo-one)', { status: g.status, ok: g.body.ok, rows: g.body.value?.rows?.length, subjects: g.body.value?.rows?.slice(0, 3).map((r) => r.subject) });
const st = await call('status', { repoPath: 'repo-one' });
show('2c) status(repo-one)', { status: st.status, ok: st.body.ok, entries: st.body.value?.entries, error: st.body.error });

// 3) 逃逸/非仓库校验
for (const bad of ['..', 'C:/x', '/abs', '..\\x']) {
  const r = await call('status', { repoPath: bad });
  show(`3) 逃逸(${JSON.stringify(bad)})`, { status: r.status, ok: r.body.ok, code: r.body.error?.code, message: r.body.error?.message });
}

// 4) 深度：第 3 层应被默认探测；第 4 层(nested/deep/deeper/fourth)应被排除
const hasL3 = init.body.value.subrepos?.some((s) => s.path === 'nested/deep/deeper');
const hasL4 = init.body.value.subrepos?.some((s) => s.path === 'nested/deep/deeper/fourth');
console.log(`\n4) 默认深度: 第 3 层(nested/deep/deeper) 探测=${hasL3}（期望 true）；第 4 层(nested/deep/deeper/fourth) 探测=${hasL4}（期望 false）`);

server.close();
process.exit(0);
