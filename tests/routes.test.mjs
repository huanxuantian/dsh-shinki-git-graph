import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import http from 'node:http';
import { createHandler } from '../lib/routes.js';

let dir;
let wsDir; // 非 git 工作区（子目录仓库场景），session s2
let server;
let port;
let originDir;

function git(args, opts = {}) {
  const r = spawnSync('git', args, { cwd: opts.cwd ?? dir, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} 失败: ${r.stderr}`);
  return r.stdout;
}

before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'shinki-routes-'));
  git(['init', '-b', 'main']);
  git(['config', 'user.email', 't@example.com']);
  git(['config', 'user.name', 'Tester']);
  writeFileSync(path.join(dir, 'a.txt'), 'v1\n');
  git(['add', '.']);
  git(['commit', '-m', 'c1']);
  // Bare remote for sync tests — MUST live outside the work tree (an
  // in-tree origin.git would be swept into `git add .` and reported dirty).
  originDir = path.join(tmpdir(), `shinki-routes-origin-${path.basename(dir)}.git`);
  rmSync(originDir, { recursive: true, force: true });
  git(['init', '--bare', originDir]);
  git(['--git-dir', originDir, 'symbolic-ref', 'HEAD', 'refs/heads/main']);
  git(['remote', 'add', 'origin', originDir]);

  // 非 git 工作区（子目录仓库场景）：sub1、sub1/sub2 为独立 git 仓库，
  // plain 为普通目录。
  wsDir = mkdtempSync(path.join(tmpdir(), 'shinki-ws-'));
  for (const rel of ['sub1', 'sub1/sub2']) {
    const repoDir = path.join(wsDir, rel);
    mkdirSync(repoDir, { recursive: true });
    git(['init', '-b', 'main'], { cwd: repoDir });
    git(['config', 'user.email', 't@example.com'], { cwd: repoDir });
    git(['config', 'user.name', 'Tester'], { cwd: repoDir });
    writeFileSync(path.join(repoDir, 'f.txt'), 'x\n');
    git(['add', '.'], { cwd: repoDir });
    git(['commit', '-m', 'c1'], { cwd: repoDir });
  }
  // 空白仓库（无提交）：graph 应返回空图谱而非报错
  const blankDir = path.join(wsDir, 'blank-sub');
  mkdirSync(blankDir, { recursive: true });
  git(['init', '-b', 'main'], { cwd: blankDir });
  git(['config', 'user.email', 't@example.com'], { cwd: blankDir });
  git(['config', 'user.name', 'Tester'], { cwd: blankDir });
  mkdirSync(path.join(wsDir, 'plain'), { recursive: true });

  const ctx = {
    sessions: {
      get: (id) => (id === 's1' ? { header: { cwd: dir } } : id === 's2' ? { header: { cwd: wsDir } } : undefined),
    },
    webRuntime: { trustedHosts: [] },
    logger: { warn() {} },
  };
  const handler = createHandler(ctx);
  server = http.createServer((req, res) => { handler(req, res).catch(() => { res.writeHead(500); res.end(); }); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});

after(() => {
  try { server.close(); } catch { /* ignore */ }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  try { rmSync(wsDir, { recursive: true, force: true }); } catch { /* ignore */ }
  try { rmSync(originDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

async function call(method, payload) {
  const res = await fetch(`http://127.0.0.1:${port}/shinki-git/api`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 's1', method, ...(payload ?? {}) }),
  });
  return { status: res.status, body: await res.json() };
}

/** 针对非 git 工作区（session s2）的请求。 */
async function callSub(method, payload) {
  const res = await fetch(`http://127.0.0.1:${port}/shinki-git/api`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 's2', method, ...(payload ?? {}) }),
  });
  return { status: res.status, body: await res.json() };
}

test('init 全链路（回环放行 → 分派 → git）', async () => {
  const { status, body } = await call('init');
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.value.isRepo, true);
  assert.equal(body.value.branch, 'main');
});

test('graph 全链路', async () => {
  const { status, body } = await call('graph', { limit: 10 });
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.ok(body.value.rows.length >= 1);
});

test('commit 全链路', async () => {
  const g = await call('graph', { limit: 1 });
  const { status, body } = await call('commit', { hash: g.body.value.rows[0].oid });
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.value.subject, 'c1');
});

test('未知会话 → 404', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/shinki-git/api`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 'nope', method: 'init' }),
  });
  assert.equal(res.status, 404);
});

test('缺少 method/sessionId → 400', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/shinki-git/api`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 400);
});

test('未知方法 → 404', async () => {
  const { status } = await call('hack');
  assert.equal(status, 404);
});

test('remotes 全链路', async () => {
  const { status, body } = await call('remotes');
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.ok(body.value.remotes.some((r) => r.name === 'origin'));
});

test('tags 全链路', async () => {
  git(['tag', 'r1']);
  const { status, body } = await call('tags');
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.ok(body.value.tags.some((t) => t.name === 'r1'));
});

test('push tag 全链路', async () => {
  const { status, body } = await call('push', { remote: 'origin', tag: 'r1' });
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  const remoteTag = git(['--git-dir', originDir, 'rev-parse', 'refs/tags/r1']).trim();
  assert.equal(remoteTag, git(['rev-parse', 'refs/tags/r1']).trim());
});

test('pull tag 全链路（仅 fetch）', async () => {
  const { status, body } = await call('pull', { remote: 'origin', tag: 'r1' });
  assert.equal(status, 200);
  assert.equal(body.ok, true);
});

test('push 全链路（推送到裸远程）', async () => {
  const { status, body } = await call('push', { remote: 'origin', branch: 'main' });
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  const remoteHead = git(['--git-dir', originDir, 'rev-parse', 'main']).trim();
  assert.equal(remoteHead, git(['rev-parse', 'HEAD']).trim());
});

test('push 非法远程 → 400', async () => {
  const { status, body } = await call('push', { remote: 'nope', branch: 'main' });
  assert.equal(status, 400);
  assert.equal(body.ok, false);
  assert.equal(body.error.code, 'bad-request');
});

test('pull fetchOnly 全链路', async () => {
  const { status, body } = await call('pull', { remote: 'origin', branch: 'main', fetchOnly: true });
  assert.equal(status, 200);
  assert.equal(body.ok, true);
});

test('fetchAll 全链路', async () => {
  const { status, body } = await call('fetchAll');
  assert.equal(status, 200);
  assert.equal(body.ok, true);
});

test('prompt-poll：未知 opId 返回 prompt=null', async () => {
  const { status, body } = await call('prompt-poll', { opId: 'nope' });
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.value.prompt, null);
});

test('prompt-answer：未知 opId 返回 404', async () => {
  const { status, body } = await call('prompt-answer', { opId: 'nope', value: 'x' });
  assert.equal(status, 404);
  assert.equal(body.ok, false);
  assert.equal(body.error.code, 'prompt-not-found');
});

test('checkout 全链路', async () => {
  const { status, body } = await call('checkout', { branch: 'main' });
  assert.equal(status, 200);
  assert.equal(body.ok, true);
});

test('checkout 不存在分支 → 400', async () => {
  const { status, body } = await call('checkout', { branch: 'nope' });
  assert.equal(status, 400);
  assert.equal(body.ok, false);
  assert.equal(body.error.code, 'bad-request');
});

test('createBranch 全链路', async () => {
  const { status, body } = await call('createBranch', { name: 'route-branch' });
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD']).trim(), 'route-branch');
  await call('checkout', { branch: 'main' });
});

test('checkoutCommit 全链路（detached）', async () => {
  const hash = git(['rev-parse', 'HEAD']).trim();
  const { status, body } = await call('checkoutCommit', { hash });
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(git(['rev-parse', 'HEAD']).trim(), hash);
  await call('checkout', { branch: 'main' });
});

// ── 子目录仓库（工作区非 git）──
test('init：非 git 工作区返回 subrepos（子目录仓库，工作区相对路径）', async () => {
  const { status, body } = await callSub('init');
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.value.isRepo, false);
  const paths = body.value.subrepos.map((s) => s.path).sort();
  assert.deepEqual(paths, ['blank-sub', 'sub1', 'sub1/sub2']);
  const sub1 = body.value.subrepos.find((s) => s.path === 'sub1');
  assert.equal(sub1.branch, 'main');
  assert.equal(sub1.subdir, '');
  assert.ok(path.isAbsolute(sub1.root));
});

test('branches/graph/status：repoPath 定位到子仓库', async () => {
  const b = await callSub('branches', { repoPath: 'sub1' });
  assert.equal(b.status, 200);
  assert.equal(b.body.ok, true);
  assert.equal(b.body.value.current, 'main');
  const g = await callSub('graph', { repoPath: 'sub1', limit: 10 });
  assert.equal(g.status, 200);
  assert.equal(g.body.ok, true);
  assert.ok(g.body.value.rows.length >= 1);
  // 在 sub1 内造一个脏文件，status 路径应相对子仓库根（'dirty.txt'，
  // 而非带 'sub1/' 前缀）——验证"内部文件列表按对应 git 相对路径显示"。
  const dirty = path.join(wsDir, 'sub1', 'dirty.txt');
  writeFileSync(dirty, 'x\n');
  try {
    const st = await callSub('status', { repoPath: 'sub1' });
    assert.equal(st.status, 200);
    assert.equal(st.body.ok, true);
    assert.ok(st.body.value.entries.some((e) => e.path === 'dirty.txt'), 'status 应列出子仓库根相对路径');
    assert.ok(!st.body.value.entries.some((e) => e.path.startsWith('sub1/')), '不应带工作区前缀');
  } finally { rmSync(dirty, { force: true }); }
});

test('init：指定 repoPath 时定位子仓库并返回其身份', async () => {
  const { status, body } = await callSub('init', { repoPath: 'sub1/sub2' });
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.value.isRepo, true);
  assert.equal(body.value.branch, 'main');
  // 子仓库根即仓库根 → subdir 为空
  assert.equal(body.value.subdir, '');
});

test('repoPath 逃逸被拒 → 400', async () => {
  for (const bad of ['..', '../x', '..\\x', 'C:/x', '/abs', 'a/../b']) {
    const { status, body } = await callSub('branches', { repoPath: bad });
    assert.equal(status, 400, `repoPath=${JSON.stringify(bad)} 应被拒`);
    assert.equal(body.ok, false);
    assert.equal(body.error.code, 'bad-request');
  }
});

test('absPath：解析绝对路径；非法/逃逸条目被拒', async () => {
  // 顶层仓库（s1，cwd=dir）与子目录仓库（s2/repoPath=sub1）各自返回真实绝对路径
  const top = await call('absPath', { path: 'a.txt' });
  assert.equal(top.status, 200);
  assert.equal(top.body.value.abs, path.join(realpathSync(dir), 'a.txt'));

  const sub = await callSub('absPath', { repoPath: 'sub1', path: 'f.txt' });
  assert.equal(sub.status, 200);
  assert.equal(sub.body.value.abs, path.join(realpathSync(path.join(wsDir, 'sub1')), 'f.txt'));

  for (const bad of ['', '..', '../x', '..\\x', 'C:/x', '/abs', 'a/../b']) {
    const { status, body } = await call('absPath', { path: bad });
    assert.equal(status, 400, `path=${JSON.stringify(bad)} 应被拒`);
    assert.equal(body.error.code, 'bad-request');
  }
});

test('repoPath 指向非仓库目录 → not-a-repo 软失败', async () => {
  const { status, body } = await callSub('status', { repoPath: 'plain' });
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.value.error, 'not-a-repo');
});

test('graph：空白子仓库经 repoPath 返回空图谱而非报错', async () => {
  const { status, body } = await callSub('graph', { repoPath: 'blank-sub', limit: 10 });
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.deepEqual(body.value.rows, []);
  assert.equal(body.value.ended, true);
});

test('createBranch：空白子仓库无参考新建（repoPath）', async () => {
  // 无 base 新建：应成功，且 init 反映新分支（symbolic-ref 回退）
  const c = await callSub('createBranch', { repoPath: 'blank-sub', name: 'feature-x', base: '' });
  assert.equal(c.status, 200);
  assert.equal(c.body.ok, true);
  let id = await callSub('init', { repoPath: 'blank-sub' });
  assert.equal(id.body.value.branch, 'feature-x');
  // 以 unborn 当前分支为 base 新建：回退为无 base 创建
  const c2 = await callSub('createBranch', { repoPath: 'blank-sub', name: 'feature-y', base: 'feature-x' });
  assert.equal(c2.status, 200);
  assert.equal(c2.body.ok, true);
  id = await callSub('init', { repoPath: 'blank-sub' });
  assert.equal(id.body.value.branch, 'feature-y');
});

test('init：git 工作区保持原逻辑（不返回 subrepos）', async () => {
  const { status, body } = await call('init');
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.value.isRepo, true);
  assert.equal(body.value.subrepos, undefined);
});
