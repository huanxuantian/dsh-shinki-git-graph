/**
 * TAG 路由单测（v0.10.0）：走真实 HTTP `/shinki-git/api`，覆盖
 * `tagCreate` / `tagDelete` / `tagDeleteRemote` / `tagsFetch` / `tagsRemote`
 * 的放行路径与非法载荷拒绝。
 *
 * 与 tests/tag-service.test.mjs 一样，仓库初始化避开 `git init -b`（要 git ≥ 2.28），
 * 所以本机 git 2.20 也能全绿。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import http from 'node:http';
import { createHandler } from '../lib/routes.js';

let dir;
let bare;
let server;
let port;

function git(args, opts = {}) {
  const r = spawnSync('git', args, { cwd: opts.cwd ?? dir, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} 失败: ${r.stderr}`);
  return r.stdout;
}

before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'shinki-tagroutes-'));
  git(['init', '-q', dir], { cwd: tmpdir() });
  git(['symbolic-ref', 'HEAD', 'refs/heads/main']);
  git(['config', 'user.email', 't@example.com']);
  git(['config', 'user.name', 'Tester']);
  git(['config', 'tag.gpgSign', 'false']);
  writeFileSync(path.join(dir, 'a.txt'), 'v1\n');
  git(['add', '.']);
  git(['commit', '-qm', 'c1']);
  bare = path.join(tmpdir(), `shinki-tagroutes-origin-${path.basename(dir)}.git`);
  rmSync(bare, { recursive: true, force: true });
  git(['init', '--bare', '-q', bare], { cwd: tmpdir() });
  git(['--git-dir', bare, 'symbolic-ref', 'HEAD', 'refs/heads/main']);
  git(['remote', 'add', 'origin', bare]);
  git(['push', '-q', 'origin', 'main']);

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
  for (const d of [dir, bare]) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
});

async function call(method, payload) {
  const res = await fetch(`http://127.0.0.1:${port}/shinki-git/api`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 's1', method, ...(payload ?? {}) }),
  });
  return { status: res.status, body: await res.json() };
}

const tagNames = async () => (await call('tags')).body.value.tags.map((t) => t.name);

test('tagCreate 全链路：轻量 / 注释 / 指定历史提交', async () => {
  const head = git(['rev-parse', 'HEAD']).trim();
  let r = await call('tagCreate', { tag: 'v1.0.0' });
  assert.equal(r.status, 200);
  assert.equal(r.body.value.ok, true);

  r = await call('tagCreate', { tag: 'v1.1.0', annotate: true, message: '第二版' });
  assert.equal(r.status, 200);

  r = await call('tagCreate', { tag: 'v1.2.0', target: head });
  assert.equal(r.status, 200);

  const { body } = await call('tags');
  const byName = new Map(body.value.tags.map((t) => [t.name, t]));
  assert.equal(byName.get('v1.0.0').annotated, false);
  assert.equal(byName.get('v1.1.0').annotated, true);
  assert.equal(byName.get('v1.1.0').target, head);
  assert.equal(byName.get('v1.2.0').target, head);
});

test('tagCreate 非法载荷：重名 / 空名 / 带注释但无消息 / 目标不是 hash / 选项注入', async () => {
  const cases = [
    { tag: 'v1.0.0' },
    { tag: '' },
    { tag: 'ann-x', annotate: true },
    { tag: 'x', sign: true },
    { tag: 'ok-name', target: 'HEAD' },
    { tag: '-x' },
    { tag: 'a..b' },
  ];
  for (const payload of cases) {
    const { status, body } = await call('tagCreate', payload);
    assert.equal(status, 400, `应拒绝 ${JSON.stringify(payload)}`);
    assert.equal(body.ok, false);
    assert.equal(body.error.code, 'bad-request');
  }
});

test('tagDelete 全链路 + 不存在时 400', async () => {
  assert.ok((await tagNames()).includes('v1.2.0'));
  const r = await call('tagDelete', { tag: 'v1.2.0' });
  assert.equal(r.status, 200);
  assert.ok(!(await tagNames()).includes('v1.2.0'));

  const again = await call('tagDelete', { tag: 'v1.2.0' });
  assert.equal(again.status, 400);
  assert.match(again.body.error.message, /不存在/);
});

test('远程 TAG：push → tagsRemote → tagDeleteRemote', async () => {
  assert.equal((await call('push', { remote: 'origin', tag: 'v1.1.0' })).status, 200);
  let remote = await call('tagsRemote', { remote: 'origin' });
  assert.equal(remote.status, 200);
  assert.ok(remote.body.value.tags.some((t) => t.name === 'v1.1.0'));

  assert.equal((await call('tagDeleteRemote', { remote: 'origin', tag: 'v1.1.0' })).status, 200);
  remote = await call('tagsRemote', { remote: 'origin' });
  assert.ok(!remote.body.value.tags.some((t) => t.name === 'v1.1.0'));
  // 只删远程：本地还在
  assert.ok((await tagNames()).includes('v1.1.0'));
});

test('tagDeleteRemote：远程没有该标签 / 远程名非法 / 伪远程 → 400', async () => {
  const notThere = await call('tagDeleteRemote', { remote: 'origin', tag: 'ghost' });
  assert.equal(notThere.status, 400);
  assert.match(notThere.body.error.message, /没有该标签/);

  for (const payload of [
    { remote: 'nope', tag: 'v1.0.0' },
    { remote: '-x', tag: 'v1.0.0' },
    { remote: '../etc', tag: 'v1.0.0' },
    { remote: 'origin', tag: '-x' },
  ]) {
    const { status } = await call('tagDeleteRemote', payload);
    assert.equal(status, 400, `应拒绝 ${JSON.stringify(payload)}`);
  }
});

test('tagsFetch：单远程与全部远程（remote 为空串）', async () => {
  git(['--git-dir', bare, 'tag', 'remote-only', git(['rev-parse', 'HEAD']).trim()]);
  assert.ok(!(await tagNames()).includes('remote-only'));
  assert.equal((await call('tagsFetch', { remote: 'origin' })).status, 200);
  assert.ok((await tagNames()).includes('remote-only'));

  assert.equal((await call('tagDelete', { tag: 'remote-only' })).status, 200);
  assert.equal((await call('tagsFetch', { remote: '' })).status, 200);
  assert.ok((await tagNames()).includes('remote-only'), 'fetch --all --tags 也应拉回');

  const bad = await call('tagsFetch', { remote: 'nope' });
  assert.equal(bad.status, 400);
});

test('tagsRemote：未知远程 400；repoPath 逃逸仍被拒', async () => {
  assert.equal((await call('tagsRemote', { remote: 'nope' })).status, 400);
  assert.equal((await call('tagsRemote', { remote: 'origin', repoPath: '../escape' })).status, 400);
  assert.equal((await call('tagCreate', { tag: 'v9', repoPath: '/abs/path' })).status, 400);
});
