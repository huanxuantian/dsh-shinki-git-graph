/**
 * HTTP surface of the plugin: a single JSON entry point under the
 * `/shinki-git` prefix. Every method is dispatched by name against the
 * git service; the session working directory is resolved host-side from
 * the session store (never trusted from the client).
 */
import path from 'node:path';
import crypto from 'node:crypto';
import { chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createFence } from './trust-fence.js';
import { createGitService, resolveSessionCwd, GitCommandError, E_NOT_A_REPO, E_GIT_MISSING, E_BAD_REQUEST, validateRelPath } from './git-service.js';

const API_PATH = '/shinki-git/api';
const MAX_BODY_BYTES = 64 * 1024;
/** Directory holding this host half (the askpass helper scripts live here). */
const LIB_DIR = path.dirname(fileURLToPath(import.meta.url));

/** Resolve an optional client-supplied `repoPath` (workspace-relative,
 *  '/'-separated) to an absolute directory inside the session cwd. This is
 *  how the client targets a subdirectory git repo discovered by `init`.
 *  Anything that escapes the workspace (absolute paths, '..' segments, '\\'
 *  separators) is rejected — the cwd comes from the session store, never
 *  from the client. When repoPath is absent/empty, returns the session cwd
 *  itself (the workspace-root repo path, preserving the pre-0.7 behavior). */
function subRepoDir(cwd, repoPath) {
  if (repoPath === undefined || repoPath === null || repoPath === '') return cwd;
  if (typeof repoPath !== 'string' || !validateRelPath(repoPath) || repoPath.includes(':')) {
    // ':' would be ambiguous on Windows (a drive-letter segment like 'C:'),
    // and it never appears in a real relative repo path — reject it.
    throw new GitCommandError('非法仓库路径', E_BAD_REQUEST);
  }
  const abs = path.resolve(cwd, ...repoPath.split('/'));
  const rel = path.relative(cwd, abs);
  if (path.isAbsolute(rel) || rel.split(path.sep).includes('..')) {
    throw new GitCommandError('非法仓库路径', E_BAD_REQUEST);
  }
  return abs;
}

/** Read a JSON body with a size cap. */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      try { resolve(JSON.parse(text)); } catch { reject(new Error('invalid json')); }
    });
    req.on('error', reject);
  });
}

/** Write a JSON response. */
function writeJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(text);
}

const OK = (value) => ({ ok: true, value });
const FAIL = (error) => ({ ok: false, error: { code: error.code ?? 'internal', message: error.message } });

/**
 * Build the route handler.
 * @param {{sessions?: any, webRuntime?: any, logger?: any}} ctx
 * @returns {(req: any, res: any) => Promise<void>}
 */
export function createHandler(ctx) {
  const fence = createFence(ctx);
  const service = createGitService(ctx);

  // ── Credential prompt bridge ────────────────────────────────────────────
  // Two producers feed **one queue per operation**:
  //   · primary  — `lib/askpass.sh` (git's GIT_ASKPASS) posts the prompt to
  //     `askpass-wait` and blocks until the browser answers. This is the only
  //     mechanism that works on Linux, where git otherwise prompts on
  //     `/dev/tty` (see lib/askpass-main.mjs for the incident write-up).
  //   · fallback — git wrote the prompt to stderr (lib/git-runner.js onPrompt).
  // The browser polls `prompt-poll` and answers via `prompt-answer`.
  //
  // Pending prompts are keyed **per prompt**, not per operation: one operation
  // legitimately asks twice (username, then password), and asking concurrently
  // is what breaks VS Code's equivalent (microsoft/vscode#230033).
  const pendingPrompts = new Map(); // promptId -> { opId, prompt, resolve, timer }
  const opPromptQueue = new Map(); // opId -> promptId[] (FIFO)
  const opTokens = new Map(); // opId -> askpass token (shared secret with the helper)
  const opCredentials = new Map(); // opId -> { username, password } captured answers
  const PROMPT_WAIT_MS = 180_000;
  let promptSeq = 0;

  /** Drop one prompt id from its operation queue. */
  function dropFromQueue(opId, promptId) {
    const queue = opPromptQueue.get(opId);
    if (!queue) return;
    const next = queue.filter((id) => id !== promptId);
    if (next.length === 0) opPromptQueue.delete(opId);
    else opPromptQueue.set(opId, next);
  }

  /** Register a prompt and resolve with the browser's answer (or '' on timeout). */
  function registerPrompt(opId, prompt) {
    const promptId = `${opId}#${++promptSeq}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingPrompts.delete(promptId);
        dropFromQueue(opId, promptId);
        resolve('');
      }, PROMPT_WAIT_MS);
      pendingPrompts.set(promptId, { opId, prompt, resolve, timer });
      const queue = opPromptQueue.get(opId) ?? [];
      queue.push(promptId);
      opPromptQueue.set(opId, queue);
    });
  }

  /** Answer one prompt (by promptId, else the operation's oldest pending one). */
  function answerPrompt({ promptId, opId, value }) {
    const id = promptId || (opId ? (opPromptQueue.get(opId) ?? [])[0] : '');
    const pending = id ? pendingPrompts.get(id) : undefined;
    if (!pending) return false;
    clearTimeout(pending.timer);
    pendingPrompts.delete(id);
    dropFromQueue(pending.opId, id);
    pending.resolve(String(value ?? ''));
    return true;
  }

  /** Legacy stderr-based fallback (lib/git-runner.js onPrompt). */
  function promptBridge(opId) {
    return (prompt) => registerPrompt(opId, prompt);
  }

  /** Remember username/password answers so the operation can store them via
   *  `git credential approve` (or drop them via `reject` after a failure). */
  function noteCredential(opId, prompt, value) {
    const text = String(prompt ?? '');
    const cred = opCredentials.get(opId) ?? {};
    if (/password|passphrase/i.test(text)) cred.password = value;
    else if (/username|login|user(name)?\b/i.test(text)) cred.username = value;
    else if (cred.username === undefined) cred.username = value;
    opCredentials.set(opId, cred);
  }

  /** GIT_ASKPASS wiring for one network op: loopback endpoint + per-op token.
   *  `req.socket.localPort` is authoritative (no Host-header trust needed). */
  function askpassEnv(req, opId, sessionId) {
    const token = crypto.randomBytes(24).toString('hex');
    opTokens.set(opId, token);
    let port = req.socket?.localPort ?? 0;
    if (!port) {
      const m = /:(\d+)$/.exec(String(req.headers?.host ?? ''));
      port = m ? Number(m[1]) : 0;
    }
    const isWin = process.platform === 'win32';
    const script = path.join(LIB_DIR, isWin ? 'askpass.cmd' : 'askpass.sh');
    if (!isWin) {
      // npm/pnpm may drop the executable bit when materialising the package.
      try { chmodSync(script, 0o755); } catch { /* best effort */ }
    }
    return {
      GIT_ASKPASS: script,
      DSH_GIT_ASKPASS_NODE: process.execPath,
      DSH_GIT_ASKPASS_MAIN: path.join(LIB_DIR, 'askpass-main.mjs'),
      DSH_GIT_ASKPASS_ENDPOINT: `http://127.0.0.1:${port}${API_PATH}`,
      DSH_GIT_ASKPASS_TOKEN: token,
      DSH_GIT_ASKPASS_OPID: opId,
      DSH_GIT_ASKPASS_SESSION: sessionId,
    };
  }

  /** Release per-operation state (tokens, captured credentials, prompts). */
  function releaseOp(opId) {
    opTokens.delete(opId);
    opCredentials.delete(opId);
    for (const id of opPromptQueue.get(opId) ?? []) {
      const pending = pendingPrompts.get(id);
      if (pending) {
        clearTimeout(pending.timer);
        pendingPrompts.delete(id);
      }
    }
    opPromptQueue.delete(opId);
  }

  /** Credential-helper status for the UI. Persistence itself is **git's own
   *  behaviour**: on a successful authentication git calls `credential approve`
   *  on the configured helper(s), so a helper is what makes the next push
   *  silent. We only report whether one exists (and whether this op had to
   *  prompt) so the dialog can tell the user what to expect. */
  async function credentialStatus(repoDir, opId) {
    const helpers = await service.credentialHelperNames(repoDir);
    return {
      helperConfigured: helpers.length > 0,
      helpers,
      prompted: opId !== '' && opCredentials.has(opId),
    };
  }

  /** Drop a stored credential that just failed, so the next attempt prompts
   *  again instead of replaying a bad password. */
  async function rejectCredentialIfAuth(repoDir, remote, opId, error) {
    if (!(error instanceof GitCommandError) || error.code !== 'git-auth') return;
    const cred = opCredentials.get(opId) ?? {};
    let parsed = null;
    try { parsed = service.parseRemoteUrl(await service.remoteUrl(repoDir, remote)); } catch { /* ignore */ }
    if (!parsed) return;
    await service.credentialReject(repoDir, {
      protocol: parsed.protocol,
      host: parsed.host,
      username: cred.username,
    });
  }

  return async (req, res) => {
    const gate = fence.check(req);
    if (!gate.ok) { writeJson(res, 403, FAIL(gate)); return; }
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
    if (!(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
      res.writeHead(415); res.end(); return;
    }
    let payload;
    try { payload = await readJsonBody(req); }
    catch { writeJson(res, 400, FAIL({ code: E_BAD_REQUEST, message: '请求体需为合法 JSON' })); return; }
    const pathname = new URL(req.url ?? '/', 'http://x').pathname;
    if (pathname !== API_PATH) { res.writeHead(404); res.end(); return; }

    const method = typeof payload?.method === 'string' ? payload.method : '';
    const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : '';
    if (method === '' || sessionId === '') {
      writeJson(res, 400, FAIL({ code: E_BAD_REQUEST, message: '缺少 method / sessionId' }));
      return;
    }
    const resolved = await resolveSessionCwd(ctx, sessionId, typeof payload?.cwd === 'string' ? payload.cwd : '');
    if (resolved.cwd === null) {
      const missing = resolved.reason === 'workspace-missing';
      writeJson(res, 404, FAIL({
        code: missing ? 'workspace-missing' : 'session-not-found',
        message: missing
          ? `工作区目录不存在或不可访问：${resolved.detail ?? ''}`
          : '会话不存在或工作区不可访问',
      }));
      return;
    }
    const cwd = resolved.cwd;
    try {
      switch (method) {
        case 'init': {
          const target = subRepoDir(cwd, payload.repoPath);
          const result = await service.init(target);
          // Workspace itself is not (inside) a git repo: also discover git
          // repositories in the workspace subdirectories so the client can
          // offer them as independently manageable repos. (Skipped when a
          // repoPath is given — that targets one specific sub-repo.)
          if (!payload.repoPath && !result.isRepo) {
            result.subrepos = await service.scanSubRepos(cwd);
          }
          writeJson(res, 200, OK(result));
          return;
        }
        case 'branches': {
          writeJson(res, 200, OK(await service.branches(subRepoDir(cwd, payload.repoPath))));
          return;
        }
        case 'graph': {
          const { revs, all, skip, limit } = payload;
          writeJson(res, 200, OK(await service.graph(subRepoDir(cwd, payload.repoPath), {
            revs: Array.isArray(revs) ? revs : [],
            all: all === true,
            skip: Number.isInteger(skip) ? skip : 0,
            limit: Number.isInteger(limit) ? limit : 100,
          })));
          return;
        }
        case 'commit': {
          writeJson(res, 200, OK(await service.commit(subRepoDir(cwd, payload.repoPath), String(payload.hash ?? ''))));
          return;
        }
        case 'status': {
          writeJson(res, 200, OK(await service.status(subRepoDir(cwd, payload.repoPath))));
          return;
        }
        case 'absPath': {
          // Read-only helper for the client "open in built-in file manager"
          // action: resolves a repo-root-relative entry to its absolute path.
          writeJson(res, 200, OK(await service.absPath(subRepoDir(cwd, payload.repoPath), payload.path)));
          return;
        }
        case 'diff': {
          writeJson(res, 200, OK(await service.diff(subRepoDir(cwd, payload.repoPath), payload.path, payload.staged === true, payload.untracked === true)));
          return;
        }
        case 'stage': {
          writeJson(res, 200, OK(await service.stage(subRepoDir(cwd, payload.repoPath), payload.path)));
          return;
        }
        case 'unstage': {
          writeJson(res, 200, OK(await service.unstage(subRepoDir(cwd, payload.repoPath), payload.path)));
          return;
        }
        case 'discard': {
          writeJson(res, 200, OK(await service.discard(subRepoDir(cwd, payload.repoPath), payload.path)));
          return;
        }
        case 'wcommit': {
          writeJson(res, 200, OK(await service.commitWithMessage(subRepoDir(cwd, payload.repoPath), String(payload.message ?? ''))));
          return;
        }
        case 'remotes': {
          writeJson(res, 200, OK(await service.remotes(subRepoDir(cwd, payload.repoPath))));
          return;
        }
        case 'tags': {
          writeJson(res, 200, OK(await service.tags(subRepoDir(cwd, payload.repoPath))));
          return;
        }
        // Network operations: always wired with the askpass bridge so git can
        // never fall back to a terminal prompt (the freeze bug).
        case 'push':
        case 'pull':
        case 'fetchAll': {
          const opId = String(payload.opId ?? '');
          const repoDir = subRepoDir(cwd, payload.repoPath);
          const remote = String(payload.remote ?? '');
          const opts = {
            onPrompt: opId ? promptBridge(opId) : undefined,
            env: opId ? askpassEnv(req, opId, sessionId) : undefined,
          };
          try {
            let out;
            if (method === 'push') {
              out = await service.push(repoDir, {
                remote,
                branch: String(payload.branch ?? ''),
                tag: String(payload.tag ?? ''),
                setUpstream: payload.setUpstream === true,
              }, opts);
            } else if (method === 'pull') {
              out = await service.pull(repoDir, {
                remote,
                branch: String(payload.branch ?? ''),
                tag: String(payload.tag ?? ''),
                fetchOnly: payload.fetchOnly === true,
                rebase: payload.rebase === true,
              }, opts);
            } else {
              out = await service.fetchAll(repoDir, opts);
            }
            const credentials = await credentialStatus(repoDir, opId);
            writeJson(res, 200, OK({ ...out, credentials }));
          } catch (error) {
            await rejectCredentialIfAuth(repoDir, remote, opId, error);
            throw error;
          } finally {
            if (opId) releaseOp(opId);
          }
          return;
        }
        // askpass bridge: the GIT_ASKPASS helper posts git's prompt here and
        // blocks until the browser answers. Authenticated by the per-op token
        // handed to that operation's git child via the environment.
        case 'askpass-wait': {
          const opId = String(payload.opId ?? '');
          const token = String(payload.token ?? '');
          if (opId === '' || token === '' || opTokens.get(opId) !== token) {
            writeJson(res, 403, FAIL({ code: 'forbidden', message: 'askpass 令牌无效或已过期' }));
            return;
          }
          const prompt = String(payload.prompt ?? '');
          const value = await registerPrompt(opId, prompt);
          noteCredential(opId, prompt, value);
          writeJson(res, 200, OK({ value }));
          return;
        }
        // Credential prompt polling: {prompt, promptId} while the op waits for
        // input, {prompt: null} otherwise.
        case 'prompt-poll': {
          const opId = String(payload.opId ?? '');
          const head = opId ? (opPromptQueue.get(opId) ?? [])[0] : '';
          const pending = head ? pendingPrompts.get(head) : undefined;
          writeJson(res, 200, OK(pending ? { prompt: pending.prompt, promptId: head } : { prompt: null, promptId: null }));
          return;
        }
        // Credential prompt answer: resolves one prompt (by promptId, or the
        // operation's oldest pending prompt when only opId is sent).
        case 'prompt-answer': {
          const ok = answerPrompt({
            promptId: String(payload.promptId ?? ''),
            opId: String(payload.opId ?? ''),
            value: payload.value,
          });
          if (!ok) { writeJson(res, 404, FAIL({ code: 'prompt-not-found', message: '提示不存在或已超时' })); return; }
          writeJson(res, 200, OK({ ok: true }));
          return;
        }
        // Whether git has a credential helper configured (the dialog uses this
        // to tell the user whether "remember" can actually persist anything).
        case 'credentialInfo': {
          const helpers = await service.credentialHelperNames(subRepoDir(cwd, payload.repoPath));
          writeJson(res, 200, OK({ configured: helpers.length > 0, helpers }));
          return;
        }
        case 'checkout': {
          writeJson(res, 200, OK(await service.checkout(subRepoDir(cwd, payload.repoPath), {
            branch: String(payload.branch ?? ''),
            linkCurrent: payload.linkCurrent === true,
          })));
          return;
        }
        case 'createBranch': {
          writeJson(res, 200, OK(await service.createBranch(subRepoDir(cwd, payload.repoPath), {
            name: String(payload.name ?? ''),
            base: String(payload.base ?? ''),
          })));
          return;
        }
        case 'checkoutCommit': {
          writeJson(res, 200, OK(await service.checkoutCommit(subRepoDir(cwd, payload.repoPath), { hash: String(payload.hash ?? '') })));
          return;
        }
        default:
          writeJson(res, 404, FAIL({ code: 'not-found', message: `未知方法 ${method}` }));
      }
    } catch (error) {
      if (error instanceof GitCommandError) {
        if (error.code === E_NOT_A_REPO || error.code === E_GIT_MISSING) {
          writeJson(res, 200, OK({ error: error.code, message: error.message }));
          return;
        }
        if (error.code === E_BAD_REQUEST) { writeJson(res, 400, FAIL(error)); return; }
        writeJson(res, 500, FAIL(error));
        return;
      }
      ctx.logger?.warn?.(`[dsh-shinki-git-graph] ${method} failed: ${error instanceof Error ? error.message : String(error)}`);
      writeJson(res, 500, FAIL({ code: 'internal', message: error instanceof Error ? error.message : String(error) }));
    }
  };
}
