/**
 * 写操作扩展的路由单测（v0.11.0）：走真实 HTTP `/shinki-git/api` 覆盖
 * `reset` / `merge` / `mergeState` / `mergeContinue` / `mergeAbort`，
 * 以及 `checkout` / `checkoutCommit` 的 `autoReset` 载荷。
 *
 * 每个用例独立仓库（避免历史互相影响），仓库初始化避开 `git init -b`（本机 git 2.20 可跑）。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import http from 'node:http';
import { createHandler } from '../lib/routes.js';

let dir;
let sid = '';
let server;
let port;
const repos = [];

/** 每个仓库用**独立的 sessionId**：host 侧对「sessionId → cwd」有缓存，
 *  复用同一个 id 会让后续用例仍然操作上一个仓库（本文件曾因此全挂）。 */

function git(args, opts = {}) {
  const r = spawnSync('git', args, { cwd: opts.cwd ?? dir, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} 失败: ${r.stderr}`);
  return r.stdout.trim();
}
const head = () => git(['rev-parse', 'HEAD']);
const file = (name, body) => writeFileSync(path.join(dir, name), `${body}\n`);
const commitFile = (name, body, msg) => { file(name, body); git(['add', '.']); git(['commit', '-qm', msg]); return head(); };

/** 每个用例：新仓库 + 新 HTTP 服务（handler 捕获的 cwd 通过会话表提供）。 */
async function makeRepo() {
  closeServer();
  dir = mkdtempSync(path.join(tmpdir(), 'shinki-mrroutes-'));
  repos.push(dir);
  sid = `s${repos.length}`;
  git(['init', '-q', dir], { cwd: tmpdir() });
  git(['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: dir });
  git(['config', 'user.email', 't@example.com'], { cwd: dir });
  git(['config', 'user.name', 'Tester'], { cwd: dir });
  git(['config', 'commit.gpgsign', 'false'], { cwd: dir });
  commitFile('a.txt', 'base', 'base');

  const ctx = {
    sessions: { get: (id) => (id === sid ? { header: { cwd: dir } } : undefined) },
    webRuntime: { trustedHosts: [] },
    logger: { warn() {} },
  };
  const handler = createHandler(ctx);
  server = http.createServer((req, res) => { handler(req, res).catch(() => { res.writeHead(500); res.end(); }); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
}

function closeServer() {
  try { server?.close(); } catch { /* ignore */ }
  server = undefined;
}

after(() => {
  closeServer();
  for (const d of repos) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
});

async function call(method, payload) {
  const res = await fetch(`http://127.0.0.1:${port}/shinki-git/api`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: sid, method, ...(payload ?? {}) }),
  });
  return { status: res.status, body: await res.json() };
}

test('reset 路由：soft/mixed/hard 生效，非法模式/非法 hash 400', async () => {
  await makeRepo();
  const base = head();
  const second = commitFile('a.txt', 'second', 'second');

  assert.equal((await call('reset', { hash: base, mode: 'hard' })).status, 200);
  assert.equal(head(), base);

  assert.equal((await call('reset', { hash: second })).status, 200, 'mode 省略时应为 mixed');
  assert.equal(head(), second);

  const bad = await call('reset', { hash: base, mode: 'nuke' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, 'bad-request');

  assert.equal((await call('reset', { hash: 'HEAD' })).status, 400);
  assert.equal((await call('reset', {})).status, 400);
});

test('checkout 路由：autoReset=true 会先丢弃已跟踪改动再切换', async () => {
  await makeRepo();
  git(['checkout', '-q', '-b', 'feature']);
  commitFile('a.txt', 'feature-version', 'feature version');
  git(['checkout', '-q', 'main']);
  file('a.txt', 'dirty');

  const blocked = await call('checkout', { branch: 'feature' });
  assert.notEqual(blocked.status, 200, '脏工作区不加 autoReset 应失败');
  assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD']), 'main');

  const ok = await call('checkout', { branch: 'feature', autoReset: true });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD']), 'feature');

  // checkoutCommit 同样支持 autoReset
  const base = git(['rev-parse', 'main']);
  assert.equal((await call('checkoutCommit', { hash: base, autoReset: true })).status, 200);
  assert.equal(git(['rev-parse', 'HEAD']), base);
});

test('mergeState 路由：干净仓库 merging=false；冲突后带 MERGE_HEAD/冲突文件/预填消息', async () => {
  await makeRepo();
  const clean = await call('mergeState');
  assert.equal(clean.status, 200);
  assert.equal(clean.body.value.merging, false);

  git(['checkout', '-q', '-b', 'feature']);
  commitFile('c.txt', 'feature-line', 'feature change');
  git(['checkout', '-q', 'main']);
  commitFile('c.txt', 'main-line', 'main change');

  const res = await call('merge', { ref: 'feature' });
  assert.equal(res.status, 200);
  assert.equal(res.body.value.conflicted, true);

  const state = await call('mergeState');
  assert.equal(state.body.value.merging, true);
  assert.equal(state.body.value.conflicts.length, 1);
  assert.match(state.body.value.message, /feature/);
});

test('merge 路由：干净合并 / 非法目标 400 / 合并中再合并 400', async () => {
  await makeRepo();
  git(['checkout', '-q', '-b', 'topic']);
  commitFile('t.txt', 'topic', 'topic');
  git(['checkout', '-q', 'main']);

  const merged = await call('merge', { ref: 'topic' });
  assert.equal(merged.status, 200, JSON.stringify(merged.body));
  assert.equal(merged.body.value.conflicted, false);

  assert.equal((await call('merge', { ref: '-x' })).status, 400);
  assert.equal((await call('merge', {})).status, 400);

  // 造一个冲突的合并，然后试图再合并
  git(['checkout', '-q', '-b', 'f2']);
  commitFile('c.txt', 'f2', 'f2');
  git(['checkout', '-q', 'main']);
  commitFile('c.txt', 'm2', 'm2');
  assert.equal((await call('merge', { ref: 'f2' })).body.value.conflicted, true);
  const again = await call('merge', { ref: 'topic' });
  assert.equal(again.status, 400);
  assert.match(again.body.error.message, /已有进行中的合并/);
});

test('mergeContinue / mergeAbort 路由：冲突未解决 400、解决后完成、无合并时 400', async () => {
  await makeRepo();
  assert.equal((await call('mergeContinue')).status, 400);
  assert.equal((await call('mergeAbort')).status, 400);

  git(['checkout', '-q', '-b', 'feature']);
  commitFile('c.txt', 'feature-line', 'feature change');
  git(['checkout', '-q', 'main']);
  const mainTip = commitFile('c.txt', 'main-line', 'main change');
  await call('merge', { ref: 'feature' });

  const blocked = await call('mergeContinue');
  assert.equal(blocked.status, 400);
  assert.match(blocked.body.error.message, /未解决冲突/);

  file('c.txt', 'resolved');
  git(['add', 'c.txt']);
  const done = await call('mergeContinue', { message: 'merge feature (resolved)' });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal((await call('mergeState')).body.value.merging, false);
  assert.match(git(['log', '-1', '--format=%s']), /resolved/);

  // 再起一个冲突，用路由中止
  git(['checkout', '-q', '-b', 'f3']);
  commitFile('c.txt', 'f3', 'f3');
  git(['checkout', '-q', 'main']);
  commitFile('c.txt', 'm3', 'm3');
  await call('merge', { ref: 'f3' });
  assert.equal((await call('mergeAbort')).status, 200);
  assert.equal((await call('mergeState')).body.value.merging, false);
  assert.notEqual(head(), mainTip);
});

test('新方法同样受 repoPath 逃逸防护', async () => {
  await makeRepo();
  for (const [method, payload] of [
    ['reset', { hash: head(), mode: 'soft', repoPath: '../escape' }],
    ['mergeState', { repoPath: '/abs/path' }],
    ['merge', { ref: 'main', repoPath: '..' }],
    ['mergeContinue', { repoPath: '../x' }],
    ['mergeAbort', { repoPath: '../x' }],
  ]) {
    const { status } = await call(method, payload);
    assert.equal(status, 400, `${method} 应拒绝逃逸路径`);
  }
});
