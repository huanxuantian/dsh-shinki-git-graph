/**
 * End-to-end verification of the git askpass bridge (web-side auth).
 *
 * What it proves:
 *   1. a push to an **auth-required** remote completes with the credential
 *      supplied through the plugin's browser bridge (prompt-poll/answer) —
 *      i.e. web-side auth works end to end;
 *   2. git never writes a credential prompt to the controlling terminal
 *      (run this under `script` and grep the typescript — that was the freeze);
 *   3. `remember: true` persists the credential via `git credential approve`;
 *   4. a wrong credential is rejected and the stored one erased via
 *      `git credential reject`.
 *
 * Runs on git 2.20.1 (no `git init -b`), unlike the plugin's own suite.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { createHandler } from '../lib/routes.js';

const USER = 'shinki-user';
const PASS = 'shinki-pass';
const WRONG = 'wrong-pass';

let workRepo;
let bareRepo;
let projectRoot;
let gitServer;
let gitPort;
let pluginServer;
let pluginPort;
let credFile;
/** Populated in `before()`: the working repo's checked-out branch. */
const workRepoState = {};

function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} 失败: ${r.stderr}`);
  return r.stdout.trim();
}

/** Minimal smart-HTTP git server that demands Basic auth for receive-pack.
 *  The git protocol itself is delegated to git's own `http-backend` (CGI). */
function startGitServer(projectRoot) {
  const expected = 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64');
  const server = http.createServer((req, res) => {
    if (req.headers.authorization !== expected) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="test"' });
      res.end('auth required');
      return;
    }
    const url = new URL(req.url, 'http://x');
    const child = spawn('git', ['http-backend'], {
      env: {
        ...process.env,
        GIT_PROJECT_ROOT: projectRoot,
        GIT_HTTP_EXPORT_ALL: '1',
        PATH_INFO: url.pathname,
        QUERY_STRING: url.searchParams.toString(),
        REQUEST_METHOD: req.method ?? 'GET',
        CONTENT_TYPE: req.headers['content-type'] ?? '',
        REMOTE_USER: USER,
        REMOTE_ADDR: '127.0.0.1',
      },
    });
    req.pipe(child.stdin);
    const chunks = [];
    child.stdout.on('data', (d) => chunks.push(d));
    child.on('close', () => {
      const buf = Buffer.concat(chunks);
      const split = buf.indexOf('\r\n\r\n');
      if (split === -1) { res.writeHead(500); res.end(); return; }
      const head = buf.slice(0, split).toString('utf8');
      let status = 200;
      const headers = {};
      for (const line of head.split('\r\n')) {
        const idx = line.indexOf(':');
        if (idx === -1) continue;
        const key = line.slice(0, idx).trim().toLowerCase();
        const value = line.slice(idx + 1).trim();
        if (key === 'status') status = Number(value.split(' ')[0]);
        else headers[key] = value;
      }
      res.writeHead(status, headers);
      res.end(buf.slice(split + 4));
    });
  });
  return server;
}

async function call(method, payload) {
  const res = await fetch(`http://127.0.0.1:${pluginPort}/shinki-git/api`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 's1', method, ...(payload ?? {}) }),
  });
  return { status: res.status, body: await res.json() };
}

/** Answer prompts for `opId` until `stop()` is called; returns answers used. */
function answerPrompts(opId, answers) {
  let stopped = false;
  const used = [];
  const loop = (async () => {
    while (!stopped) {
      const { body } = await call('prompt-poll', { opId }).catch(() => ({ body: null }));
      const prompt = body?.value?.prompt;
      const promptId = body?.value?.promptId;
      if (prompt) {
        const isPassword = /password|passphrase/i.test(prompt);
        const value = answers[isPassword ? 'password' : 'username'];
        used.push({ prompt, value, promptId });
        await call('prompt-answer', { opId, promptId, value });
      } else {
        await new Promise((r) => setTimeout(r, 25));
      }
    }
  })();
  return { used, stop: async () => { stopped = true; await loop; } };
}

before(async () => {
  workRepo = mkdtempSync(path.join(tmpdir(), 'shinki-askpass-work-'));
  // GIT_PROJECT_ROOT for `git http-backend`; the URL path must match the dir name.
  projectRoot = mkdtempSync(path.join(tmpdir(), 'shinki-askpass-srv-'));
  bareRepo = path.join(projectRoot, 'repo.git');
  credFile = path.join(workRepo, 'stored-credentials');
  git(['init'], workRepo);
  git(['config', 'user.email', 't@example.com'], workRepo);
  git(['config', 'user.name', 'Tester'], workRepo);
  // Keep the credential in a file so the test can inspect approve/reject.
  git(['config', 'credential.helper', `store --file=${credFile}`], workRepo);
  writeFileSync(path.join(workRepo, 'a.txt'), 'v1\n');
  git(['add', '.'], workRepo);
  git(['commit', '-m', 'c1'], workRepo);
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], workRepo);

  git(['init', '--bare', bareRepo], workRepo);
  git(['config', 'http.receivepack', 'true'], bareRepo);

  gitServer = startGitServer(projectRoot);
  await new Promise((r) => gitServer.listen(0, '127.0.0.1', r));
  gitPort = gitServer.address().port;
  git(['remote', 'add', 'origin', `http://127.0.0.1:${gitPort}/repo.git`], workRepo);

  const ctx = {
    sessions: { get: (id) => (id === 's1' ? { header: { cwd: workRepo } } : undefined) },
    webRuntime: { trustedHosts: [] },
    logger: { warn() {} },
  };
  const handler = createHandler(ctx);
  pluginServer = http.createServer((req, res) => {
    handler(req, res).catch(() => { res.writeHead(500); res.end(); });
  });
  await new Promise((r) => pluginServer.listen(0, '127.0.0.1', r));
  pluginPort = pluginServer.address().port;
  workRepoState.branch = branch;
});

after(() => {
  try { gitServer.close(); } catch { /* ignore */ }
  try { pluginServer.close(); } catch { /* ignore */ }
  for (const d of [workRepo, projectRoot]) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test('push 需要认证时经网页桥完成（且不向终端提示）', async () => {
  const opId = 'op-ok';
  const answers = { username: USER, password: PASS };
  const pump = answerPrompts(opId, answers);
  const pushed = call('push', { opId, remote: 'origin', branch: workRepoState.branch });
  const { status, body } = await pushed;
  await pump.stop();

  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.ok, true, JSON.stringify(body));
  assert.equal(body.value.ok, true);
  // Exactly the two prompts git needs, both answered by the bridge.
  assert.deepEqual(pump.used.map((u) => u.value), [USER, PASS]);
  assert.match(pump.used[0].prompt, /username/i);
  assert.match(pump.used[1].prompt, /password/i);
  // The bare repo really received the commit.
  const remoteHead = git(['rev-parse', 'HEAD'], bareRepo);
  assert.equal(remoteHead, git(['rev-parse', 'HEAD'], workRepo));
});

test('认证成功后凭据由助手落盘 → 第二次推送不再提示', async () => {
  // 上一条用例认证成功后，git 自身会调用 `credential approve` 把凭据交给
  // 配置好的助手（凭据持久化是 git 的行为，不是我们代劳）。
  assert.ok(existsSync(credFile), '凭据应已由 git 落盘（credential approve）');
  assert.match(readFileSync(credFile, 'utf8'), new RegExp(`${USER}:${PASS}@127\\.0\\.0\\.1`));

  writeFileSync(path.join(workRepo, 'b.txt'), 'v2\n');
  git(['add', '.'], workRepo);
  git(['commit', '-m', 'c2'], workRepo);

  const opId = 'op-silent';
  const pump = answerPrompts(opId, { username: 'unused', password: 'unused' });
  const { body } = await call('push', { opId, remote: 'origin', branch: workRepoState.branch });
  await pump.stop();

  assert.equal(body.ok, true, JSON.stringify(body));
  assert.equal(body.value.credentials.helperConfigured, true, JSON.stringify(body.value));
  assert.equal(body.value.credentials.prompted, false, '已存凭据 → 不应再提示');
  assert.deepEqual(pump.used, [], '不应出现任何凭据提示');
});

test('认证失败后错误凭据不残留（reject / 助手自身 erase）', async () => {
  // 前置：上一条用例已把正确凭据落盘
  assert.ok(existsSync(credFile), '前置：凭据文件应存在');
  assert.match(readFileSync(credFile, 'utf8'), /shinki-user/);

  writeFileSync(path.join(workRepo, 'c.txt'), 'v3\n');
  git(['add', '.'], workRepo);
  git(['commit', '-m', 'c3'], workRepo);
  // 让 git 使用错误的已存凭据：把 store 文件换成错的，且不回答提示（超时即空）
  writeFileSync(credFile, `http://${USER}:${WRONG}@127.0.0.1:${gitPort}\n`);
  const opId = 'op-reject';
  const pump = answerPrompts(opId, { username: USER, password: WRONG });
  const { body } = await call('push', { opId, remote: 'origin', branch: workRepoState.branch });
  await pump.stop();
  // 推送应失败（认证错误 → 友好映射），且坏凭据被 reject 掉
  assert.equal(body.ok, false, JSON.stringify(body));
  assert.equal(body.error.code, 'git-auth', JSON.stringify(body));
  const after = existsSync(credFile) ? readFileSync(credFile, 'utf8') : '';
  assert.doesNotMatch(after, new RegExp(WRONG), '错误凭据应从 store 中清除');
});

test('askpass 令牌错误 → 403（防伪造提示）', async () => {
  const { status, body } = await call('askpass-wait', { opId: 'nope', token: 'bad', prompt: 'Username:' });
  assert.equal(status, 403, JSON.stringify(body));
  assert.equal(body.ok, false);
});
