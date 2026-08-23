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

function git(args) {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
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
