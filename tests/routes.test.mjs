import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import http from 'node:http';
import { createHandler } from '../lib/routes.js';

let dir;
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
  originDir = path.join(dir, 'origin.git');
  git(['init', '--bare', originDir]);
  git(['--git-dir', originDir, 'symbolic-ref', 'HEAD', 'refs/heads/main']);
  git(['remote', 'add', 'origin', originDir]);

  const ctx = {
    sessions: { get: (id) => (id === 's1' ? { header: { cwd: dir } } : undefined) },
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
});

async function call(method, payload) {
  const res = await fetch(`http://127.0.0.1:${port}/shinki-git/api`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 's1', method, ...(payload ?? {}) }),
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
