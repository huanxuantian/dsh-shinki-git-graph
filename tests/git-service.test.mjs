import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createGitService, GitCommandError, E_BAD_REQUEST } from '../lib/git-service.js';

let dir;
let cwd;
let service;
const ctx = { logger: { warn() {} } };

function git(args, opts = {}) {
  const r = spawnSync('git', args, { cwd: opts.cwd ?? dir, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} 失败: ${r.stderr}`);
  return r.stdout;
}
function commit(msg, opts = {}) {
  const file = opts.file ?? 'a.txt';
  writeFileSync(path.join(dir, file), (opts.content ?? msg) + '\n', { flag: 'a' });
  git(['add', '.']);
  git(['commit', '-m', msg]);
  return git(['rev-parse', 'HEAD']).trim();
}

before(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'shinki-git-'));
  git(['init', '-b', 'main']);
  git(['config', 'user.email', 't@example.com']);
  git(['config', 'user.name', 'Tester']);
  writeFileSync(path.join(dir, 'a.txt'), 'v1\n');
  git(['add', '.']);
  git(['commit', '-m', 'c1']);
  git(['checkout', '-b', 'feature']);
  writeFileSync(path.join(dir, 'b.txt'), 'fb\n');
  git(['add', '.']);
  git(['commit', '-m', 'c2']);
  git(['checkout', 'main']);
  writeFileSync(path.join(dir, 'c.txt'), 'mc\n');
  git(['add', '.']);
  git(['commit', '-m', 'c3']);
  git(['merge', '--no-ff', 'feature', '-m', 'merge feature']);
  cwd = dir;
  service = createGitService(ctx);
});

after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

test('init：识别仓库与当前分支', async () => {
  const r = await service.init(cwd);
  assert.equal(r.isRepo, true);
  assert.equal(r.branch, 'main');
  assert.ok(r.root.length > 0);
  assert.ok(r.head.length > 0);
});

test('branches：本地/远程分组与上游映射', async () => {
  const r = await service.branches(cwd);
  assert.equal(r.current, 'main');
  assert.ok(r.local.some((b) => b.name === 'main'));
  assert.ok(r.local.some((b) => b.name === 'feature'));
  assert.ok(r.local.find((b) => b.name === 'main').isHead);
});

test('graph：默认返回 HEAD 可达提交，含 parents', async () => {
  const r = await service.graph(cwd, { limit: 100 });
  assert.ok(r.rows.length >= 4, `rows=${r.rows.length}`);
  const merge = r.rows.find((row) => row.parents.length > 1);
  assert.ok(merge, '应包含 merge 提交（parents>1）');
  for (const row of r.rows) {
    assert.ok(/^[0-9a-f]{40}$/.test(row.oid));
    assert.ok(typeof row.subject === 'string');
    assert.ok(row.date.length > 0);
  }
});

test('graph：revs 白名单拒绝非法值', async () => {
  await assert.rejects(
    service.graph(cwd, { revs: ['../../etc/passwd'] }),
    (e) => e instanceof GitCommandError && e.code === E_BAD_REQUEST
  );
});

test('graph：all 模式返回 --all 提交', async () => {
  const r = await service.graph(cwd, { all: true, limit: 100 });
  assert.ok(r.rows.length >= 4);
});

test('graph：skip/limit 分页', async () => {
  const first = await service.graph(cwd, { limit: 2 });
  const second = await service.graph(cwd, { skip: 2, limit: 2 });
  assert.equal(first.rows.length, 2);
  assert.equal(second.rows.length, 2);
  assert.notEqual(first.rows[0].oid, second.rows[0].oid);
});

test('commit：元信息 + stat + diff', async () => {
  const log = await service.graph(cwd, { limit: 1 });
  const r = await service.commit(cwd, log.rows[0].oid);
  assert.equal(r.isMerge, true);
  assert.ok(r.parents.length >= 2);
  assert.ok(r.subject.length > 0);
  assert.ok(r.author.name === 'Tester');
  assert.ok(Array.isArray(r.stat));
  assert.ok(typeof r.diffText === 'string');
  assert.ok(r.diffText.includes('diff --git'), 'diffText 应包含补丁（--numstat 抑制补丁的回归防护）');
});

test('commit：非法 hash 被拒', async () => {
  await assert.rejects(
    service.commit(cwd, 'not-a-hash!'),
    (e) => e instanceof GitCommandError && e.code === E_BAD_REQUEST
  );
});

test('非仓库目录：init 返回 isRepo=false', async () => {
  const plain = mkdtempSync(path.join(tmpdir(), 'shinki-plain-'));
  try {
    const r = await service.init(plain);
    assert.equal(r.isRepo, false);
  } finally { rmSync(plain, { recursive: true, force: true }); }
});

test('status：未提交变更入列', async () => {
  writeFileSync(path.join(dir, 'a.txt'), 'changed\n', { flag: 'a' });
  const r = await service.status(cwd);
  const a = r.entries.find((e) => e.path === 'a.txt');
  assert.ok(a, 'a.txt 应在 status 中');
  assert.equal(a.xy, ' M'); // 未暂存修改
});

test('stage → unstage → commit 全链路', async () => {
  writeFileSync(path.join(dir, 'staged.txt'), 's1\n');
  await service.stage(cwd, 'staged.txt');
  let r = await service.status(cwd);
  assert.equal(r.entries.find((e) => e.path === 'staged.txt').xy, 'A ');
  await service.unstage(cwd, 'staged.txt');
  r = await service.status(cwd);
  assert.equal(r.entries.find((e) => e.path === 'staged.txt').xy, '??');
  await service.stage(cwd, 'staged.txt');
  await service.commitWithMessage(cwd, 'test commit staged');
  const log = await service.graph(cwd, { limit: 1 });
  assert.match(log.rows[0].subject, /test commit staged/);
});

test('stage 全部（无 path）', async () => {
  writeFileSync(path.join(dir, 'all.txt'), 'x\n');
  await service.stage(cwd);
  const r = await service.status(cwd);
  assert.equal(r.entries.find((e) => e.path === 'all.txt').xy, 'A ');
  await service.commitWithMessage(cwd, 'stage all');
});

test('discard：恢复工作区文件', async () => {
  writeFileSync(path.join(dir, 'disc.txt'), 'keep\n');
  await service.stage(cwd, 'disc.txt');
  await service.commitWithMessage(cwd, 'disc base');
  writeFileSync(path.join(dir, 'disc.txt'), 'keep\nchanged\n');
  await service.discard(cwd, 'disc.txt');
  const content = git(['show', 'HEAD:disc.txt']).trim();
  assert.equal(content, 'keep');
});

test('非法路径被拒（stage/discard/diff）', async () => {
  await assert.rejects(service.stage(cwd, '../escape'), (e) => e instanceof GitCommandError && e.code === E_BAD_REQUEST);
  await assert.rejects(service.discard(cwd, 'a\\b'), (e) => e instanceof GitCommandError && e.code === E_BAD_REQUEST);
  await assert.rejects(service.diff(cwd, '..', false), (e) => e instanceof GitCommandError && e.code === E_BAD_REQUEST);
});

test('discard 未跟踪文件 = 删除文件', async () => {
  const p = path.join(dir, 'untracked-del.txt');
  writeFileSync(p, 'to be deleted\n');
  assert.equal(existsSync(p), true);
  await service.discard(cwd, 'untracked-del.txt');
  assert.equal(existsSync(p), false, '未跟踪文件应被删除');
});

test('空提交消息被拒', async () => {
  await assert.rejects(service.commitWithMessage(cwd, '   '), (e) => e instanceof GitCommandError && e.code === E_BAD_REQUEST);
});
