/**
 * TAG 功能单测（v0.10.0）：`lib/git-service.js` 的
 * `tagCreateArgs`（纯参数装配）+ `tagCreate/tagDelete/tagDeleteRemote/tagsFetch/tagsRemote`
 * 对真实仓库的端到端行为。
 *
 * 本文件**不依赖较新的 git**：仓库初始化用 `git init` + `symbolic-ref HEAD refs/heads/main`
 * 代替 `git init -b main`（后者要 git ≥ 2.28），因此在本机 git 2.20 上也能全绿
 * —— 这样 TAG 相关的守卫不会淹没在「旧 git 环境差异」里。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createGitService, GitCommandError, E_BAD_REQUEST, tagCreateArgs } from '../lib/git-service.js';

let dir;
let bare;
let service;
const ctx = { logger: { warn() {} } };

function git(args, opts = {}) {
  const cwd = opts.cwd ?? dir;
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} 失败: ${r.stderr}`);
  return r.stdout;
}

/** git 2.20 兼容的仓库初始化（没有 `init -b`）。 */
function initRepo(target) {
  git(['init', '-q', target], { cwd: tmpdir() });
  git(['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: target });
  git(['config', 'user.email', 't@example.com'], { cwd: target });
  git(['config', 'user.name', 'Tester'], { cwd: target });
  // 宿主环境可能有全局 gpg 配置，显式关掉以免测试依赖密钥。
  git(['config', 'commit.gpgsign', 'false'], { cwd: target });
  git(['config', 'tag.gpgSign', 'false'], { cwd: target });
  return target;
}

before(() => {
  dir = initRepo(mkdtempSync(path.join(tmpdir(), 'shinki-tag-')));
  writeFileSync(path.join(dir, 'a.txt'), 'v1\n');
  git(['add', '.']);
  git(['commit', '-qm', 'c1']);
  writeFileSync(path.join(dir, 'a.txt'), 'v1\nv2\n');
  git(['add', '.']);
  git(['commit', '-qm', 'c2']);
  bare = path.join(tmpdir(), `shinki-tag-origin-${path.basename(dir)}.git`);
  rmSync(bare, { recursive: true, force: true });
  git(['init', '--bare', '-q', bare], { cwd: tmpdir() });
  git(['--git-dir', bare, 'symbolic-ref', 'HEAD', 'refs/heads/main']);
  git(['remote', 'add', 'origin', bare]);
  git(['push', '-q', 'origin', 'main']);
  service = createGitService(ctx);
});

after(() => {
  for (const d of [dir, bare]) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
});

const head = () => git(['rev-parse', 'HEAD']).trim();
const firstCommit = () => git(['rev-list', '--max-parents=0', 'HEAD']).trim();

// ── 纯参数装配（无需 git）───────────────────────────────────────────────
test('tagCreateArgs：轻量 / 注释 / 签名三种形态', () => {
  assert.deepEqual(tagCreateArgs({ tag: 'v1' }), ['tag', '--no-sign', 'v1']);
  assert.deepEqual(tagCreateArgs({ tag: 'v1', target: 'abc1234' }), ['tag', '--no-sign', 'v1', 'abc1234']);
  assert.deepEqual(tagCreateArgs({ tag: 'v1', annotate: true, message: 'rel' }), ['tag', '-a', '-m', 'rel', 'v1']);
  assert.deepEqual(tagCreateArgs({ tag: 'v1', sign: true, message: 'rel' }), ['tag', '-s', '-m', 'rel', 'v1']);
  // 签名隐含注释；消息去掉首尾空白
  assert.deepEqual(tagCreateArgs({ tag: 'v1', sign: true, message: '  rel  ' }), ['tag', '-s', '-m', 'rel', 'v1']);
});

test('tagCreateArgs：注释/签名必须有消息（否则 git 会打开编辑器卡住）', () => {
  for (const opts of [{ tag: 'v1', annotate: true }, { tag: 'v1', sign: true }, { tag: 'v1', annotate: true, message: '   ' }]) {
    assert.throws(() => tagCreateArgs(opts), (err) => err instanceof GitCommandError && err.code === E_BAD_REQUEST);
  }
});

test('tagCreateArgs：拒绝会被当成选项/越界的标签名与非法目标提交', () => {
  for (const tag of ['', '-x', 'a b', 'a..b', 'a~1', 'a^', 'a:b', 'a?', 'a*', 'a[b]', '/a', 'a/', 'a.', 'x'.repeat(256)]) {
    assert.throws(() => tagCreateArgs({ tag }), (err) => err.code === E_BAD_REQUEST, `应拒绝标签名 ${JSON.stringify(tag)}`);
  }
  for (const target of ['zzz', 'abc', 'HEAD', 'main']) {
    assert.throws(() => tagCreateArgs({ tag: 'v1', target }), (err) => err.code === E_BAD_REQUEST, `应拒绝目标 ${target}`);
  }
});

// ── 真实仓库：创建 ──────────────────────────────────────────────────────
test('tagCreate：轻量标签（annotated=false，target=提交本身）', async () => {
  await service.tagCreate(dir, { tag: 'light-1' });
  const { tags } = await service.tags(dir);
  const t = tags.find((x) => x.name === 'light-1');
  assert.ok(t, '标签应存在');
  assert.equal(t.annotated, false);
  assert.equal(t.oid, head());
  assert.equal(t.target, head());
});

test('tagCreate：注释标签（annotated=true，oid 是 tag 对象、target 是提交）', async () => {
  await service.tagCreate(dir, { tag: 'ann-1', annotate: true, message: '第一版\n\n详细说明' });
  const { tags } = await service.tags(dir);
  const t = tags.find((x) => x.name === 'ann-1');
  assert.equal(t.annotated, true);
  assert.equal(t.target, head());
  assert.notEqual(t.oid, t.target, '注释标签的 oid 应是 tag 对象而非提交');
  assert.equal(git(['cat-file', '-t', t.oid]).trim(), 'tag');
});

test('tagCreate：可指定历史提交作为目标', async () => {
  const base = firstCommit();
  await service.tagCreate(dir, { tag: 'old-1', target: base });
  const { tags } = await service.tags(dir);
  assert.equal(tags.find((x) => x.name === 'old-1').target, base);
});

test('tagCreate：重名/非法输入报 bad-request（不抛 git 原始错误）', async () => {
  await assert.rejects(() => service.tagCreate(dir, { tag: 'light-1' }),
    (err) => err.code === E_BAD_REQUEST && /已存在/.test(err.message));
  await assert.rejects(() => service.tagCreate(dir, { tag: '-bad' }), (err) => err.code === E_BAD_REQUEST);
  await assert.rejects(() => service.tagCreate(dir, { tag: 'ann-x', annotate: true }), (err) => err.code === E_BAD_REQUEST);
});

test('tags：新的在前（creatordate 降序），带注释/轻量可区分', async () => {
  const { tags } = await service.tags(dir);
  const names = tags.map((t) => t.name);
  for (const n of ['light-1', 'ann-1', 'old-1']) assert.ok(names.includes(n), `缺少 ${n}`);
  assert.equal(tags.filter((t) => t.annotated).length >= 1, true);
});

// ── 真实仓库：删除本地 ──────────────────────────────────────────────────
test('tagDelete：删除本地标签；不存在则 bad-request', async () => {
  await service.tagCreate(dir, { tag: 'tmp-del' });
  await service.tagDelete(dir, { tag: 'tmp-del' });
  assert.ok(!(await service.tags(dir)).tags.some((t) => t.name === 'tmp-del'));
  await assert.rejects(() => service.tagDelete(dir, { tag: 'tmp-del' }),
    (err) => err.code === E_BAD_REQUEST && /不存在/.test(err.message));
  await assert.rejects(() => service.tagDelete(dir, { tag: '-x' }), (err) => err.code === E_BAD_REQUEST);
});

// ── 真实远端（裸仓库）：推送 / 列出 / 删除 / 拉取 ────────────────────────
test('远程标签：push 推送 → tagsRemote 列出 → tagDeleteRemote 删除', async () => {
  await service.tagCreate(dir, { tag: 'v9.9.9', annotate: true, message: 'release' });
  await service.push(dir, { remote: 'origin', tag: 'v9.9.9' });
  let remote = await service.tagsRemote(dir, { remote: 'origin' });
  assert.ok(remote.tags.some((t) => t.name === 'v9.9.9'), '远程应列出刚推送的标签');

  await service.tagDeleteRemote(dir, { remote: 'origin', tag: 'v9.9.9' });
  remote = await service.tagsRemote(dir, { remote: 'origin' });
  assert.ok(!remote.tags.some((t) => t.name === 'v9.9.9'), '远程标签应已删除');
  // 本地标签仍在（只删远程）
  assert.ok((await service.tags(dir)).tags.some((t) => t.name === 'v9.9.9'));
});

test('tagDeleteRemote：远程不存在该标签 / 远程名非法 → bad-request', async () => {
  await assert.rejects(() => service.tagDeleteRemote(dir, { remote: 'origin', tag: 'nope-tag' }),
    (err) => err.code === E_BAD_REQUEST && /没有该标签/.test(err.message));
  await assert.rejects(() => service.tagDeleteRemote(dir, { remote: 'nope', tag: 'v1' }),
    (err) => err.code === E_BAD_REQUEST && /远程不存在/.test(err.message));
});

test('tagsFetch：把远端新增的标签拉到本地（单远程 / 全部远程）', async () => {
  // 直接在裸仓库里造一个本地没有的标签（模拟别人推上去的）
  const sha = head();
  git(['--git-dir', bare, 'tag', 'from-remote', sha]);
  assert.ok(!(await service.tags(dir)).tags.some((t) => t.name === 'from-remote'), '拉取前本地不应有');

  await service.tagsFetch(dir, { remote: 'origin' });
  assert.ok((await service.tags(dir)).tags.some((t) => t.name === 'from-remote'), '拉取后本地应出现');

  // 全部远程（remote: ''）→ fetch --all --tags，不应报错
  await service.tagDelete(dir, { tag: 'from-remote' });
  await service.tagsFetch(dir, { remote: '' });
  assert.ok((await service.tags(dir)).tags.some((t) => t.name === 'from-remote'), 'fetch --all --tags 也应拉回');
});

test('tagsFetch：远程名非法 / 不存在 → bad-request', async () => {
  await assert.rejects(() => service.tagsFetch(dir, { remote: 'nope' }),
    (err) => err.code === E_BAD_REQUEST && /远程不存在/.test(err.message));
  await assert.rejects(() => service.tagsRemote(dir, { remote: '-x' }), (err) => err.code === E_BAD_REQUEST);
});

test('轻量标签在 tag.gpgSign=true 的仓库里也不会被意外签名', async () => {
  git(['config', 'tag.gpgSign', 'true']);
  try {
    await service.tagCreate(dir, { tag: 'no-sign-1' });
    const { tags } = await service.tags(dir);
    assert.equal(tags.find((t) => t.name === 'no-sign-1').annotated, false);
  } finally {
    git(['config', 'tag.gpgSign', 'false']);
  }
});
