/**
 * 非 ASCII 路径 / 空提交说明 / git 子进程环境 的回归测试。
 *
 * 事故背景（2026-10-03，由 dsh-shinki-svn-graph 的同类问题排查而来）：
 *   · `mergeState()` 的冲突列表用了不带 `core.quotepath=false` 的
 *     `git diff --name-only`，中文文件名被 git 输出成八进制转义
 *     （`说明书.txt` → `"\350\257\264..."`），直接显示在合并横幅里。
 *   · `commitWithMessage()` 一律拒绝空说明，而 git 也需要
 *     `--allow-empty-message` 才肯提交空说明。
 *   · 全仓库没有一个非 ASCII 路径的用例，所以上面第一个问题一直没被发现。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createGitService, E_BAD_REQUEST } from '../lib/git-service.js';
import { buildGitEnv } from '../lib/git-runner.js';

/** 与插件一致地跑 git（同样的环境归一化，便于设置夹具）。 */
function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: buildGitEnv(process.env) });
  assert.equal(r.status, 0, `git ${args.join(' ')} 失败: ${r.stderr}`);
  return r.stdout;
}

/** 建一个临时仓库（realpath：macOS tmpdir 是 /var/...，git 返回 /private/var/...）。 */
function makeRepo(prefix = 'shinki-git-cjk-') {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  git(['init', '-b', 'main'], dir);
  git(['config', 'user.email', 't@example.com'], dir);
  git(['config', 'user.name', 'Tester'], dir);
  return dir;
}

const CN_DIR = '福信富通';
const CN_FILE = `${CN_DIR}/固件说明.bin`;

// ── buildGitEnv ──────────────────────────────────────────────────────────

test('buildGitEnv：强制 C locale 并注入 core.quotepath=false', () => {
  const env = buildGitEnv({ PATH: '/usr/bin', LANG: 'zh_CN.UTF-8' });
  assert.equal(env.LC_ALL, 'C', '文案解析需要确定的语言');
  assert.equal(env.PATH, '/usr/bin', '其它环境变量必须原样保留');
  assert.equal(env.GIT_CONFIG_COUNT, '1');
  assert.equal(env.GIT_CONFIG_KEY_0, 'core.quotepath');
  assert.equal(env.GIT_CONFIG_VALUE_0, 'false');
});

test('buildGitEnv：已有 GIT_CONFIG_* 时追加而非覆盖', () => {
  const env = buildGitEnv({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'x' });
  assert.equal(env.GIT_CONFIG_COUNT, '2');
  assert.equal(env.GIT_CONFIG_KEY_0, 'user.name', '调用方原有条目必须保留');
  assert.equal(env.GIT_CONFIG_KEY_1, 'core.quotepath');
});

test('buildGitEnv：调用方已设置 cores.quotepath 时不重复注入（尊重显式设置）', () => {
  const env = buildGitEnv({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.quotepath', GIT_CONFIG_VALUE_0: 'true' });
  assert.equal(env.GIT_CONFIG_COUNT, '1');
  assert.equal(env.GIT_CONFIG_VALUE_0, 'true');
});

test('buildGitEnv：不破坏 netEnv/askpass 的既有变量', () => {
  const env = buildGitEnv({ GIT_ASKPASS: '/x/askpass.sh', DSH_GIT_ASKPASS_TOKEN: 'tok', GIT_TERMINAL_PROMPT: '0' });
  assert.equal(env.GIT_ASKPASS, '/x/askpass.sh');
  assert.equal(env.DSH_GIT_ASKPASS_TOKEN, 'tok');
  assert.equal(env.GIT_TERMINAL_PROMPT, '0');
});

// ── 中文路径全链路 ────────────────────────────────────────────────────────

test('中文路径：status/stage/commit 全链路都拿到原始 UTF-8（无八进制转义）', async () => {
  const dir = makeRepo();
  try {
    const svc = createGitService({ logger: { warn() {} } });

    mkdirSync(path.join(dir, CN_DIR), { recursive: true });
    writeFileSync(path.join(dir, CN_FILE), 'BIN\n');

    // ① status 必须给出原始中文路径
    const st = await svc.status(dir);
    assert.ok(st.entries.some((e) => e.path === CN_FILE),
      `status 应给出原始中文路径，实际：${JSON.stringify(st.entries)}`);
    assert.doesNotMatch(JSON.stringify(st.entries), /\\\\3[0-9][0-9]/, '不得出现八进制转义');

    // ② stage 用该路径回传必须成功
    await svc.stage(dir, CN_FILE);
    const staged = (await svc.status(dir)).entries.find((e) => e.path === CN_FILE);
    assert.ok(staged, '暂存后仍应能按同一路径找到条目');
    assert.match(staged.xy, /^A/, `应为新增：${staged.xy}`);

    // ③ 提交中文说明 + 中文路径
    await svc.commitWithMessage(dir, '新增固件（中文提交说明）');
    assert.equal(git(['log', '-1', '--pretty=%s'], dir).trim(), '新增固件（中文提交说明）');
    assert.equal(git(['log', '-1', '--name-only', '--pretty=format:'], dir).trim(), CN_FILE);

    // ④ 提交后工作区干净
    assert.deepEqual((await svc.status(dir)).entries, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('中文路径：合并冲突列表不被转义（mergeState 回归）', async () => {
  const dir = makeRepo('shinki-git-cjk-merge-');
  try {
    const svc = createGitService({ logger: { warn() {} } });

    writeFileSync(path.join(dir, '说明书.txt'), 'base\n');
    git(['add', '.'], dir);
    git(['commit', '-m', 'base'], dir);

    // 另一分支改同一文件的同一行
    git(['checkout', '-q', '-b', 'other'], dir);
    writeFileSync(path.join(dir, '说明书.txt'), 'other\n');
    git(['commit', '-qam', 'other'], dir);

    git(['checkout', '-q', 'main'], dir);
    writeFileSync(path.join(dir, '说明书.txt'), 'main\n');
    git(['commit', '-qam', 'main'], dir);

    // 制造冲突
    const merged = spawnSync('git', ['merge', 'other'], { cwd: dir, encoding: 'utf8', env: buildGitEnv(process.env) });
    assert.notEqual(merged.status, 0, '应有冲突');

    const state = await svc.mergeState(dir);
    assert.equal(state.merging, true);
    // 关键断言：冲突路径必须是原始中文名，而不是 "\350\257\264..."
    assert.deepEqual(state.conflicts, ['说明书.txt']);
    assert.doesNotMatch(JSON.stringify(state.conflicts), /\\\\3[0-9][0-9]/);

    // 未解决冲突时不允许继续合并
    await assert.rejects(() => svc.mergeContinue(dir, {}), (e) => e.code === E_BAD_REQUEST);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 空提交说明 ────────────────────────────────────────────────────────────

test('空提交说明：默认拒绝，allowEmptyMessage 后放行', async () => {
  const dir = makeRepo('shinki-git-empty-msg-');
  try {
    const svc = createGitService({ logger: { warn() {} } });
    writeFileSync(path.join(dir, 'a.txt'), 'v1\n');
    git(['add', '.'], dir);

    // 默认：空 / 纯空白都必须被拦下
    await assert.rejects(() => svc.commitWithMessage(dir, ''), (e) => e.code === E_BAD_REQUEST);
    await assert.rejects(() => svc.commitWithMessage(dir, '   '), (e) => e.code === E_BAD_REQUEST);

    // 勾选后：空说明可以提交（host 会补 --allow-empty-message）
    await svc.commitWithMessage(dir, '', { allowEmptyMessage: true });
    assert.equal(git(['log', '-1', '--pretty=%s'], dir).trim(), '', '仓库里的提交说明应为空串');

    // 纯空白同样放行（git 会先做 stripspace 清理，所以仍需要该 flag）
    writeFileSync(path.join(dir, 'b.txt'), 'v2\n');
    git(['add', '.'], dir);
    await svc.commitWithMessage(dir, '   ', { allowEmptyMessage: true });
    assert.equal(git(['log', '-1', '--pretty=%s'], dir).trim(), '');

    // 非空说明即使勾选也照常写入
    writeFileSync(path.join(dir, 'c.txt'), 'v3\n');
    git(['add', '.'], dir);
    await svc.commitWithMessage(dir, '正常说明', { allowEmptyMessage: true });
    assert.equal(git(['log', '-1', '--pretty=%s'], dir).trim(), '正常说明');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
