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
let originDir; // bare remote for push/pull/fetch tests
const ctx = { logger: { warn() {} } };

function git(args, opts = {}) {
  const r = spawnSync('git', args, { cwd: opts.cwd ?? dir, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} 失败: ${r.stderr}`);
  return r.stdout;
}
function gitOrFail(args, opts = {}) {
  return spawnSync('git', args, { cwd: opts.cwd ?? dir, encoding: 'utf8' });
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
  // Bare remote for sync tests.
  originDir = path.join(dir, 'origin.git');
  git(['init', '--bare', originDir]);
  git(['--git-dir', originDir, 'symbolic-ref', 'HEAD', 'refs/heads/main']);
  git(['remote', 'add', 'origin', originDir]);
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

test('remotes：列出配置的远程', async () => {
  const { remotes: rs } = await service.remotes(cwd);
  assert.ok(rs.some((r) => r.name === 'origin' && r.url === originDir));
});

test('push：推送到远程裸仓库', async () => {
  const { ok } = await service.push(cwd, { remote: 'origin', branch: 'main' });
  assert.equal(ok, true);
  const remoteHead = git(['--git-dir', originDir, 'rev-parse', 'main']).trim();
  const localHead = git(['rev-parse', 'HEAD']).trim();
  assert.equal(remoteHead, localHead);
});

test('tags：列出本地标签', async () => {
  git(['tag', 'v1.0.0']);
  git(['tag', '-a', 'v2.0.0', '-m', 'annotated']);
  const { tags: ts } = await service.tags(cwd);
  const names = ts.map((t) => t.name);
  assert.ok(names.includes('v1.0.0'));
  assert.ok(names.includes('v2.0.0'));
  for (const tg of ts) assert.ok(/^[0-9a-f]{40}$/.test(tg.oid), `tag ${tg.name} 应有完整 oid`);
});

test('push tag：推送到远程裸仓库', async () => {
  const { ok } = await service.push(cwd, { remote: 'origin', tag: 'v1.0.0' });
  assert.equal(ok, true);
  const remoteTag = git(['--git-dir', originDir, 'rev-parse', 'refs/tags/v1.0.0']).trim();
  const localTag = git(['rev-parse', 'refs/tags/v1.0.0']).trim();
  assert.equal(remoteTag, localTag);
});

test('push：branch 与 tag 不能同时指定', async () => {
  await assert.rejects(
    service.push(cwd, { remote: 'origin', branch: 'main', tag: 'v1.0.0' }),
    (e) => e instanceof GitCommandError && e.code === E_BAD_REQUEST
  );
  await assert.rejects(
    service.push(cwd, { remote: 'origin' }),
    (e) => e instanceof GitCommandError && e.code === E_BAD_REQUEST
  );
});

test('push tag：不存在的本地标签被拒', async () => {
  await assert.rejects(
    service.push(cwd, { remote: 'origin', tag: 'nope-tag' }),
    (e) => e instanceof GitCommandError && e.code === E_BAD_REQUEST
  );
  await assert.rejects(
    service.push(cwd, { remote: 'origin', tag: '../escape' }),
    (e) => e instanceof GitCommandError && e.code === E_BAD_REQUEST
  );
});

test('pull tag：只拉取指定标签（不合并/不检出）', async () => {
  const clone = mkdtempSync(path.join(tmpdir(), 'shinki-clone-tag-'));
  try {
    git(['clone', originDir, clone], { cwd: tmpdir() });
    const c2 = { cwd: clone };
    git(['config', 'user.email', 't5@example.com'], c2);
    git(['config', 'user.name', 'Tester5'], c2);
    git(['tag', 'v3.0.0'], c2);
    git(['push', 'origin', 'tag', 'v3.0.0'], c2);
    const tagOid = git(['rev-parse', 'refs/tags/v3.0.0'], c2).trim();

    const before = git(['rev-parse', 'HEAD']).trim();
    const { ok } = await service.pull(cwd, { remote: 'origin', tag: 'v3.0.0' });
    assert.equal(ok, true);
    assert.equal(git(['rev-parse', 'refs/tags/v3.0.0']).trim(), tagOid, 'tag 应已拉取到本地');
    assert.equal(git(['rev-parse', 'HEAD']).trim(), before, 'tag 拉取不应移动 HEAD');
  } finally { rmSync(clone, { recursive: true, force: true }); }
});

test('pull：branch 与 tag 不能同时指定；非法 tag 被拒', async () => {
  await assert.rejects(
    service.pull(cwd, { remote: 'origin', branch: 'main', tag: 'v1.0.0' }),
    (e) => e instanceof GitCommandError && e.code === E_BAD_REQUEST
  );
  await assert.rejects(
    service.pull(cwd, { remote: 'origin', tag: 'a..b' }),
    (e) => e instanceof GitCommandError && e.code === E_BAD_REQUEST
  );
});

test('push：非法远程/分支被拒', async () => {
  await assert.rejects(
    service.push(cwd, { remote: 'nope', branch: 'main' }),
    (e) => e instanceof GitCommandError && e.code === E_BAD_REQUEST
  );
  await assert.rejects(
    service.push(cwd, { remote: 'origin', branch: '../escape' }),
    (e) => e instanceof GitCommandError && e.code === E_BAD_REQUEST
  );
  await assert.rejects(
    service.push(cwd, { remote: 'origin', branch: '-u' }),
    (e) => e instanceof GitCommandError && e.code === E_BAD_REQUEST
  );
});

test('pull fetchOnly：只拉取不合并/不检出', async () => {
  // A second clone pushes a new commit to the bare remote.
  const clone = mkdtempSync(path.join(tmpdir(), 'shinki-clone-'));
  try {
    git(['clone', originDir, clone], { cwd: tmpdir() });
    const c2 = { cwd: clone };
    git(['config', 'user.email', 't2@example.com'], c2);
    git(['config', 'user.name', 'Tester2'], c2);
    writeFileSync(path.join(clone, 'remote.txt'), 'remote work\n');
    git(['add', '.'], c2);
    git(['commit', '-m', 'remote commit'], c2);
    git(['push', 'origin', 'main'], c2);
    const pushed = git(['rev-parse', 'HEAD'], c2).trim();

    const before = git(['rev-parse', 'HEAD']).trim();
    const { ok } = await service.pull(cwd, { remote: 'origin', branch: 'main', fetchOnly: true });
    assert.equal(ok, true);
    const after = git(['rev-parse', 'HEAD']).trim();
    assert.equal(after, before, 'fetchOnly 不应移动 HEAD（不合并/不检出）');
    assert.equal(git(['rev-parse', 'FETCH_HEAD']).trim(), pushed, 'FETCH_HEAD 应指向远端新提交');
  } finally { rmSync(clone, { recursive: true, force: true }); }
});

test('pull：fetch+merge 合入远端提交', async () => {
  const clone = mkdtempSync(path.join(tmpdir(), 'shinki-clone2-'));
  try {
    git(['clone', originDir, clone], { cwd: tmpdir() });
    const c2 = { cwd: clone };
    git(['config', 'user.email', 't3@example.com'], c2);
    git(['config', 'user.name', 'Tester3'], c2);
    writeFileSync(path.join(clone, 'm.txt'), 'm\n');
    git(['add', '.'], c2);
    git(['commit', '-m', 'merge target'], c2);
    git(['push', 'origin', 'main'], c2);

    const { ok } = await service.pull(cwd, { remote: 'origin', branch: 'main' });
    assert.equal(ok, true);
    const log = await service.graph(cwd, { limit: 20 });
    assert.ok(log.rows.some((r) => r.subject === 'merge target'), 'pull 后应能看到远端提交');
  } finally { rmSync(clone, { recursive: true, force: true }); }
});

test('fetchAll：拉取全部远程', async () => {
  const clone = mkdtempSync(path.join(tmpdir(), 'shinki-clone3-'));
  try {
    git(['clone', originDir, clone], { cwd: tmpdir() });
    const c2 = { cwd: clone };
    git(['config', 'user.email', 't4@example.com'], c2);
    git(['config', 'user.name', 'Tester4'], c2);
    writeFileSync(path.join(clone, 'fa.txt'), 'fa\n');
    git(['add', '.'], c2);
    git(['commit', '-m', 'fetch all target'], c2);
    git(['push', 'origin', 'main'], c2);
    const pushed = git(['rev-parse', 'HEAD'], c2).trim();

    const { ok } = await service.fetchAll(cwd);
    assert.equal(ok, true);
    assert.equal(git(['rev-parse', 'FETCH_HEAD']).trim(), pushed);
  } finally { rmSync(clone, { recursive: true, force: true }); }
});

test('checkout：切换到已存在本地分支', async () => {
  const { ok, unchanged } = await service.checkout(cwd, { branch: 'feature' });
  assert.equal(ok, true);
  assert.notEqual(unchanged, true);
  assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD']).trim(), 'feature');
  // 切回 main，避免影响后续用例的当前分支假设。
  await service.checkout(cwd, { branch: 'main' });
  assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD']).trim(), 'main');
});

test('checkout：当前分支不变更、不存在分支/非法名被拒', async () => {
  const r = await service.checkout(cwd, { branch: 'main' });
  assert.equal(r.unchanged, true);
  await assert.rejects(
    service.checkout(cwd, { branch: 'nope' }),
    (e) => e instanceof GitCommandError && e.code === E_BAD_REQUEST
  );
  await assert.rejects(
    service.checkout(cwd, { branch: '../escape' }),
    (e) => e instanceof GitCommandError && e.code === E_BAD_REQUEST
  );
});

test('createBranch：新建并切到新分支（默认基于 HEAD）', async () => {
  const { ok } = await service.createBranch(cwd, { name: 'new-feature' });
  assert.equal(ok, true);
  assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD']).trim(), 'new-feature');
  await service.checkout(cwd, { branch: 'main' });
});

test('createBranch：基于指定分支；重名/非法名被拒', async () => {
  await service.createBranch(cwd, { name: 'from-feature', base: 'feature' });
  assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD']).trim(), 'from-feature');
  // 先创建 dup，再创建同名 → 拒绝。
  await service.createBranch(cwd, { name: 'dup' });
  await assert.rejects(
    service.createBranch(cwd, { name: 'dup' }),
    (e) => e instanceof GitCommandError && e.code === E_BAD_REQUEST
  );
  await assert.rejects(
    service.createBranch(cwd, { name: 'bad..name' }),
    (e) => e instanceof GitCommandError && e.code === E_BAD_REQUEST
  );
  await assert.rejects(
    service.createBranch(cwd, { name: 'x', base: 'missing-base' }),
    (e) => e instanceof GitCommandError && e.code === E_BAD_REQUEST
  );
  await service.checkout(cwd, { branch: 'main' });
});

test('createBranch：支持以提交 hash 为基准', async () => {
  const log = await service.graph(cwd, { limit: 5 });
  const hash = log.rows[log.rows.length - 1].oid;
  const { ok } = await service.createBranch(cwd, { name: 'from-hash', base: hash });
  assert.equal(ok, true);
  assert.equal(git(['rev-parse', 'HEAD']).trim(), hash, '新分支应指向基准提交');
  await service.checkout(cwd, { branch: 'main' });
});

test('checkoutCommit：检出提交进入 detached HEAD', async () => {
  const log = await service.graph(cwd, { limit: 5 });
  const oldHead = log.rows[log.rows.length - 1].oid; // 取较老提交，与当前 HEAD 不同
  const { ok } = await service.checkoutCommit(cwd, { hash: oldHead });
  assert.equal(ok, true);
  const head = git(['rev-parse', 'HEAD']).trim();
  assert.equal(head, oldHead);
  const symbolic = gitOrFail(['symbolic-ref', '-q', 'HEAD']);
  assert.notEqual(symbolic.status, 0, '应处于 detached HEAD（symbolic-ref 失败）');
  // 回到 main，避免影响后续用例。
  await service.checkout(cwd, { branch: 'main' });
});

test('checkoutCommit：非法 hash 被拒', async () => {
  await assert.rejects(
    service.checkoutCommit(cwd, { hash: 'not-a-hash' }),
    (e) => e instanceof GitCommandError && e.code === E_BAD_REQUEST
  );
  await assert.rejects(
    service.checkoutCommit(cwd, { hash: '..' }),
    (e) => e instanceof GitCommandError && e.code === E_BAD_REQUEST
  );
});

test('checkout 远程分支：本地无同名分支时自动创建跟踪分支', async () => {
  // 制造"仅远程存在"的分支：本地建 → 推送 → 删本地。
  git(['checkout', '-b', 'remote-only']);
  git(['push', 'origin', 'remote-only']);
  git(['checkout', 'main']);
  git(['branch', '-D', 'remote-only']);
  const { ok } = await service.checkout(cwd, { branch: 'origin/remote-only' });
  assert.equal(ok, true);
  assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD']).trim(), 'remote-only', '应检出并创建本地 remote-only');
  const upstream = git(['rev-parse', '--abbrev-ref', 'remote-only@{upstream}']).trim();
  assert.equal(upstream, 'origin/remote-only', '应自动设置上游跟踪');
  await service.checkout(cwd, { branch: 'main' });
});

test('checkout 远程分支：本地已有同名分支时切换本地分支', async () => {
  const { ok } = await service.checkout(cwd, { branch: 'origin/main' });
  assert.equal(ok, true);
  assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD']).trim(), 'main', '应切换到本地 main');
});

test('createBranch：基于远程分支时自动设置跟踪', async () => {
  const { ok } = await service.createBranch(cwd, { name: 'tracked-new', base: 'origin/remote-only' });
  assert.equal(ok, true);
  assert.equal(git(['rev-parse', '--abbrev-ref', 'tracked-new@{upstream}']).trim(), 'origin/remote-only');
  await service.checkout(cwd, { branch: 'main' });
});

test('checkout/createBranch：不存在的远程分支被拒', async () => {
  await assert.rejects(
    service.checkout(cwd, { branch: 'origin/nope' }),
    (e) => e instanceof GitCommandError && e.code === E_BAD_REQUEST
  );
  await assert.rejects(
    service.createBranch(cwd, { name: 'x', base: 'origin/nope' }),
    (e) => e instanceof GitCommandError && e.code === E_BAD_REQUEST
  );
});

test('checkout 本地分支：未跟踪且默认远程有同名 → 自动设置上游', async () => {
  // 本地建 auto-track 并推送（不带 -u，保持未跟踪），再切回 main。
  git(['checkout', '-b', 'auto-track']);
  git(['push', 'origin', 'auto-track']);
  const before = gitOrFail(['rev-parse', '--abbrev-ref', 'auto-track@{upstream}']);
  assert.notEqual(before.status, 0, '前置：auto-track 应未跟踪');
  git(['checkout', 'main']);
  // 检出 auto-track（真正切换，非当前分支）：应按默认远程（origin）自动设置上游。
  await service.checkout(cwd, { branch: 'auto-track' });
  const upstream = git(['rev-parse', '--abbrev-ref', 'auto-track@{upstream}']).trim();
  assert.equal(upstream, 'origin/auto-track', '未跟踪分支检出应自动关联默认远程同名分支');
  await service.checkout(cwd, { branch: 'main' });
});

test('checkout 当前分支：默认不自动补齐上游；linkCurrent 时补齐', async () => {
  // 准备一个未跟踪分支 sit-here（推送但不带 -u），并停留在它上面。
  git(['checkout', '-b', 'sit-here']);
  git(['push', 'origin', 'sit-here']);
  // 默认（linkCurrent 缺省 = false）：检出当前分支 → 不补绑。
  const r1 = await service.checkout(cwd, { branch: 'sit-here' });
  assert.equal(r1.unchanged, true);
  let up = gitOrFail(['rev-parse', '--abbrev-ref', 'sit-here@{upstream}']);
  assert.notEqual(up.status, 0, '默认应不自动补齐（检出当前分支）');
  // linkCurrent=true：本次检出当前分支 → 按默认策略补绑。
  const r2 = await service.checkout(cwd, { branch: 'sit-here', linkCurrent: true });
  assert.equal(r2.unchanged, true);
  up = git(['rev-parse', '--abbrev-ref', 'sit-here@{upstream}']).trim();
  assert.equal(up, 'origin/sit-here', 'linkCurrent 时检出当前分支应补齐上游');
  await service.checkout(cwd, { branch: 'main' });
});

test('checkout 本地分支：未跟踪且默认远程无同名 → 保持未跟踪', async () => {
  git(['checkout', '-b', 'no-remote-twin']);
  git(['checkout', 'main']);
  await service.checkout(cwd, { branch: 'no-remote-twin' });
  const upstream = gitOrFail(['rev-parse', '--abbrev-ref', 'no-remote-twin@{upstream}']);
  assert.notEqual(upstream.status, 0, '远程无同名分支时不应设置上游');
  await service.checkout(cwd, { branch: 'main' });
});

test('checkout 远程分支：本地同名未跟踪 → 切换并设置上游', async () => {
  // 本地 twin 未跟踪（推送不带 -u），检出 origin/twin 时应补设上游。
  git(['checkout', '-b', 'twin']);
  git(['push', 'origin', 'twin']);
  git(['checkout', 'main']);
  await service.checkout(cwd, { branch: 'origin/twin' });
  const upstream = git(['rev-parse', '--abbrev-ref', 'twin@{upstream}']).trim();
  assert.equal(upstream, 'origin/twin', '检出远程分支且本地同名未跟踪时应设置上游');
  await service.checkout(cwd, { branch: 'main' });
});
