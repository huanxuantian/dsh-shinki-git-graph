/**
 * 写操作扩展单测（v0.11.0）：`reset`（soft/mixed/hard）、检出时的 `autoReset`，
 * 以及 merge 的状态检测 / 发起 / 继续 / 中止。
 *
 * 仓库初始化避开 `git init -b`（要 git ≥ 2.28），因此本机 git 2.20 也能全绿。
 * 真实仓库 + 真实冲突（两边改同一文件同一行）是本文件的重点：merge 的「冲突不是错误、
 * 而是留在 merging 状态」这条语义只有真跑 git 才测得准。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createGitService, GitCommandError, E_BAD_REQUEST } from '../lib/git-service.js';

let dir;
const repos = [];
const service = createGitService({ logger: { warn() {} } });

function git(args, opts = {}) {
  const r = spawnSync('git', args, { cwd: opts.cwd ?? dir, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} 失败: ${r.stderr}`);
  return r.stdout.trim();
}
const head = () => git(['rev-parse', 'HEAD']);
/** 不 trim 的原始输出：`git status --porcelain` 的首列空格有意义（' M' 未暂存 vs 'M ' 已暂存）。 */
function gitRaw(args) {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} 失败: ${r.stderr}`);
  return r.stdout;
}
const file = (name, body) => writeFileSync(path.join(dir, name), `${body}\n`);
const commitFile = (name, body, msg) => { file(name, body); git(['add', '.']); git(['commit', '-qm', msg]); return head(); };

after(() => {
  for (const d of repos) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
});

/** 每个用例都用自己的全新仓库（共用仓库会让上一个用例的历史/文件影响下一个）。 */
function makeRepo() {
  const d = mkdtempSync(path.join(tmpdir(), 'shinki-merge-'));
  repos.push(d);
  git(['init', '-q', d], { cwd: tmpdir() });
  git(['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: d });
  git(['config', 'user.email', 't@example.com'], { cwd: d });
  git(['config', 'user.name', 'Tester'], { cwd: d });
  git(['config', 'commit.gpgsign', 'false'], { cwd: d });
  dir = d;
  commitFile('a.txt', 'base', 'base');
  return d;
}

// ── reset ───────────────────────────────────────────────────────────────
test('reset：soft/mixed/hard 三种模式移动分支，hard 会丢弃已跟踪改动', async () => {
  makeRepo();
  const base = head();
  const second = commitFile('a.txt', 'second', 'second');

  // soft：索引与工作区都保留（改动进入暂存区）
  await service.reset(dir, { hash: base, mode: 'soft' });
  assert.equal(head(), base);
  assert.match(gitRaw(['status', '--porcelain']), /^M /m, 'soft 后改动应处于已暂存');
  git(['reset', '--hard', second]);

  // mixed（默认）：工作区保留、索引复位
  await service.reset(dir, { hash: base });
  assert.equal(head(), base);
  assert.match(gitRaw(['status', '--porcelain']), /^ M/m, '默认 mixed 后改动应处于未暂存');
  git(['reset', '--hard', second]);

  // hard：工作区也复位
  await service.reset(dir, { hash: base, mode: 'hard' });
  assert.equal(head(), base);
  assert.equal(gitRaw(['status', '--porcelain']), '', 'hard 后工作区应干净');
});

test('reset：非法 hash / 非法模式 → bad-request', async () => {
  makeRepo();
  await assert.rejects(() => service.reset(dir, { hash: 'zzz' }), (e) => e.code === E_BAD_REQUEST);
  await assert.rejects(() => service.reset(dir, { hash: 'HEAD' }), (e) => e.code === E_BAD_REQUEST);
  await assert.rejects(() => service.reset(dir, { hash: head(), mode: 'nuke' }),
    (e) => e.code === E_BAD_REQUEST && /模式/.test(e.message));
});

// ── 检出 + autoReset ────────────────────────────────────────────────────
test('checkout：脏工作区不加 autoReset 会被 git 拒绝；加了 autoReset 成功且改动被丢弃', async () => {
  makeRepo();
  // feature 上把 a.txt 改成不同内容：这样本地再改 a.txt 时，切分支会被 git 挡住
  git(['checkout', '-q', '-b', 'feature']);
  commitFile('a.txt', 'feature-version', 'feature version');
  git(['checkout', '-q', 'main']);
  file('a.txt', 'local-dirty');

  await assert.rejects(() => service.checkout(dir, { branch: 'feature' }));
  assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD']), 'main', '被拒绝后仍应停在原分支');

  await service.checkout(dir, { branch: 'feature', autoReset: true });
  assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD']), 'feature');
  assert.equal(gitRaw(['status', '--porcelain']), '', 'autoReset 后工作区应干净');
  assert.equal(git(['show', 'HEAD:a.txt']), 'feature-version', '工作区应回到分支内容');
});

test('checkoutCommit：autoReset 同样生效（含未跟踪文件不受影响）', async () => {
  makeRepo();
  const base = head();
  const second = commitFile('a.txt', 'second', 'second');
  file('a.txt', 'dirty');
  writeFileSync(path.join(dir, 'untracked.txt'), 'keep\n');

  await service.checkoutCommit(dir, { hash: base, autoReset: true });
  assert.equal(head(), base);
  assert.equal(git(['status', '--porcelain', '--untracked-files=all']), '?? untracked.txt', '未跟踪文件不应被 autoReset 删除');
  git(['checkout', '-q', 'main']);
  git(['reset', '--hard', second]);
});

// ── merge 状态检测 / 发起 / 继续 / 中止 ─────────────────────────────────
test('mergeState：无合并时 merging=false；冲突后能报出 MERGE_HEAD 与冲突文件', async () => {
  makeRepo();
  assert.deepEqual(await service.mergeState(dir), { merging: false });

  // 造冲突：main 与 feature 改同一文件同一行
  const base = head();
  git(['checkout', '-q', '-b', 'feature', base]);
  commitFile('c.txt', 'feature-line', 'feature change');
  git(['checkout', '-q', 'main']);
  commitFile('c.txt', 'main-line', 'main change');
  const mainTip = head(); // 合并前当前分支的 tip（冲突时 HEAD 必须停在这里）

  const res = await service.merge(dir, { ref: 'feature' });
  assert.equal(res.ok, true);
  assert.equal(res.conflicted, true, '冲突应作为「已进入 merging 状态」返回，而不是抛错');

  const state = await service.mergeState(dir);
  assert.equal(state.merging, true);
  assert.equal(state.conflicts.length, 1);
  assert.match(state.conflicts[0], /c\.txt/);
  assert.equal(state.short.length, 7);
  assert.ok(state.message.length > 0, '应读到 MERGE_MSG（供继续时预填）');
  assert.equal(head(), mainTip, '冲突时不应产生合并提交（HEAD 应停在原 tip）');
});

test('mergeContinue：有未解决冲突时拒绝；解决后可完成合并；无合并时拒绝', async () => {
  makeRepo();
  await assert.rejects(() => service.mergeContinue(dir), (e) => e.code === E_BAD_REQUEST && /没有进行中的合并/.test(e.message));

  git(['checkout', '-q', '-b', 'feature']);
  commitFile('c.txt', 'feature-line', 'feature change');
  git(['checkout', '-q', 'main']);
  commitFile('c.txt', 'main-line', 'main change');
  await service.merge(dir, { ref: 'feature' });

  await assert.rejects(() => service.mergeContinue(dir),
    (e) => e.code === E_BAD_REQUEST && /未解决冲突/.test(e.message));

  // 解决冲突 → 继续
  file('c.txt', 'resolved');
  git(['add', 'c.txt']);
  await service.mergeContinue(dir, { message: 'merge feature (resolved)' });
  assert.deepEqual(await service.mergeState(dir), { merging: false });
  assert.equal(git(['log', '-1', '--format=%s']), 'merge feature (resolved)');
  assert.match(git(['log', '-1', '--format=%P']), /\s/, '合并提交应有两个父');
});

test('mergeAbort：回到合并前的 HEAD 且工作区干净；无合并时拒绝', async () => {
  makeRepo();
  await assert.rejects(() => service.mergeAbort(dir), (e) => e.code === E_BAD_REQUEST && /没有进行中的合并/.test(e.message));

  git(['checkout', '-q', '-b', 'feature']);
  commitFile('c.txt', 'feature-line', 'feature change');
  git(['checkout', '-q', 'main']);
  const before = commitFile('c.txt', 'main-line', 'main change');
  await service.merge(dir, { ref: 'feature' });
  assert.equal((await service.mergeState(dir)).merging, true);

  await service.mergeAbort(dir);
  assert.deepEqual(await service.mergeState(dir), { merging: false });
  assert.equal(head(), before, '中止后应回到合并前的提交');
  assert.equal(git(['status', '--porcelain']), '', '中止后工作区应干净');
});

test('merge：干净合并直接产生提交；已是最新时标记 alreadyUpToDate；非法目标 400', async () => {
  makeRepo();
  git(['checkout', '-q', '-b', 'topic']);
  commitFile('t.txt', 'topic', 'topic change');
  git(['checkout', '-q', 'main']);

  const merged = await service.merge(dir, { ref: 'topic' });
  assert.equal(merged.ok, true);
  assert.equal(merged.conflicted, false);
  assert.match(git(['log', '-1', '--format=%s']), /topic|Merge/i);

  const again = await service.merge(dir, { ref: 'topic' });
  assert.equal(again.alreadyUpToDate, true);

  await assert.rejects(() => service.merge(dir, { ref: 'nope-branch' }), (e) => e.code !== undefined);
  await assert.rejects(() => service.merge(dir, { ref: '-x' }), (e) => e.code === E_BAD_REQUEST);
  await assert.rejects(() => service.merge(dir, {}), (e) => e.code === E_BAD_REQUEST);
});

test('merge：合并中再发起合并 → 拒绝（先继续或中止）', async () => {
  makeRepo();
  git(['checkout', '-q', '-b', 'feature']);
  commitFile('c.txt', 'feature-line', 'feature change');
  git(['checkout', '-q', 'main']);
  commitFile('c.txt', 'main-line', 'main change');
  await service.merge(dir, { ref: 'feature' });
  await assert.rejects(() => service.merge(dir, { ref: 'feature' }),
    (e) => e.code === E_BAD_REQUEST && /已有进行中的合并/.test(e.message));
  await service.mergeAbort(dir);
});

test('merge：可合并任意提交 hash（不只是分支名）', async () => {
  makeRepo();
  git(['checkout', '-q', '-b', 'topic']);
  const tip = commitFile('t2.txt', 'topic2', 'topic 2');
  git(['checkout', '-q', 'main']);
  const res = await service.merge(dir, { ref: tip });
  assert.equal(res.conflicted, false);
  assert.equal(git(['log', '-1', '--format=%s']).length > 0, true);
});
