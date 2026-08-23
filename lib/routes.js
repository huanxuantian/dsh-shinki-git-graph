/**
 * HTTP surface of the plugin: a single JSON entry point under the
 * `/shinki-git` prefix. Every method is dispatched by name against the
 * git service; the session working directory is resolved host-side from
 * the session store (never trusted from the client).
 */
import { createFence } from './trust-fence.js';
import { createGitService, sessionCwd, GitCommandError, E_NOT_A_REPO, E_GIT_MISSING, E_BAD_REQUEST } from './git-service.js';

const API_PATH = '/shinki-git/api';
const MAX_BODY_BYTES = 64 * 1024;

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

  // Credential prompt bridge: while a network op (push/pull/fetchAll) waits
  // on git's stdin for a username/password, the op registers its prompt here
  // and the client polls `prompt-poll` then answers via `prompt-answer`.
  // Keyed by the client-supplied opId (a fresh random id per operation).
  const pendingPrompts = new Map(); // opId -> { prompt, resolve, timer, sessionId }
  const PROMPT_WAIT_MS = 180_000;

  /** Build an onPrompt callback for a network op; resolves when the client
   *  submits an answer (or the prompt wait times out -> empty answer). */
  function promptBridge(opId, sessionId) {
    return (prompt) => new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingPrompts.delete(opId);
        resolve('');
      }, PROMPT_WAIT_MS);
      pendingPrompts.set(opId, { prompt, resolve, timer, sessionId });
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
    const cwd = sessionCwd(ctx, sessionId);
    if (cwd === null) {
      writeJson(res, 404, FAIL({ code: 'session-not-found', message: '会话不存在或工作区不可访问' }));
      return;
    }
    try {
      switch (method) {
        case 'init': {
          writeJson(res, 200, OK(await service.init(cwd)));
          return;
        }
        case 'branches': {
          writeJson(res, 200, OK(await service.branches(cwd)));
          return;
        }
        case 'graph': {
          const { revs, all, skip, limit } = payload;
          writeJson(res, 200, OK(await service.graph(cwd, {
            revs: Array.isArray(revs) ? revs : [],
            all: all === true,
            skip: Number.isInteger(skip) ? skip : 0,
            limit: Number.isInteger(limit) ? limit : 100,
          })));
          return;
        }
        case 'commit': {
          writeJson(res, 200, OK(await service.commit(cwd, String(payload.hash ?? ''))));
          return;
        }
        case 'status': {
          writeJson(res, 200, OK(await service.status(cwd)));
          return;
        }
        case 'diff': {
          writeJson(res, 200, OK(await service.diff(cwd, payload.path, payload.staged === true, payload.untracked === true)));
          return;
        }
        case 'stage': {
          writeJson(res, 200, OK(await service.stage(cwd, payload.path)));
          return;
        }
        case 'unstage': {
          writeJson(res, 200, OK(await service.unstage(cwd, payload.path)));
          return;
        }
        case 'discard': {
          writeJson(res, 200, OK(await service.discard(cwd, payload.path)));
          return;
        }
        case 'wcommit': {
          writeJson(res, 200, OK(await service.commitWithMessage(cwd, String(payload.message ?? ''))));
          return;
        }
        case 'remotes': {
          writeJson(res, 200, OK(await service.remotes(cwd)));
          return;
        }
        case 'tags': {
          writeJson(res, 200, OK(await service.tags(cwd)));
          return;
        }
        case 'push': {
          const opId = String(payload.opId ?? '');
          writeJson(res, 200, OK(await service.push(cwd, {
            remote: String(payload.remote ?? ''),
            branch: String(payload.branch ?? ''),
            tag: String(payload.tag ?? ''),
            setUpstream: payload.setUpstream === true,
          }, { onPrompt: opId ? promptBridge(opId, sessionId) : undefined })));
          return;
        }
        case 'pull': {
          const opId = String(payload.opId ?? '');
          writeJson(res, 200, OK(await service.pull(cwd, {
            remote: String(payload.remote ?? ''),
            branch: String(payload.branch ?? ''),
            tag: String(payload.tag ?? ''),
            fetchOnly: payload.fetchOnly === true,
            rebase: payload.rebase === true,
          }, { onPrompt: opId ? promptBridge(opId, sessionId) : undefined })));
          return;
        }
        case 'fetchAll': {
          const opId = String(payload.opId ?? '');
          writeJson(res, 200, OK(await service.fetchAll(cwd, { onPrompt: opId ? promptBridge(opId, sessionId) : undefined })));
          return;
        }
        // Credential prompt polling: returns {prompt} when the op with opId
        // is waiting for input, {prompt: null} otherwise.
        case 'prompt-poll': {
          const opId = String(payload.opId ?? '');
          const p = opId ? pendingPrompts.get(opId) : undefined;
          if (p) {
            writeJson(res, 200, OK({ prompt: p.prompt }));
          } else {
            writeJson(res, 200, OK({ prompt: null }));
          }
          return;
        }
        // Credential prompt answer: resolves the pending prompt for opId.
        case 'prompt-answer': {
          const opId = String(payload.opId ?? '');
          const p = opId ? pendingPrompts.get(opId) : undefined;
          if (!p) { writeJson(res, 404, FAIL({ code: 'prompt-not-found', message: '提示不存在或已超时' })); return; }
          clearTimeout(p.timer);
          pendingPrompts.delete(opId);
          p.resolve(String(payload.value ?? ''));
          writeJson(res, 200, OK({ ok: true }));
          return;
        }
        case 'checkout': {
          writeJson(res, 200, OK(await service.checkout(cwd, {
            branch: String(payload.branch ?? ''),
            linkCurrent: payload.linkCurrent === true,
          })));
          return;
        }
        case 'createBranch': {
          writeJson(res, 200, OK(await service.createBranch(cwd, {
            name: String(payload.name ?? ''),
            base: String(payload.base ?? ''),
          })));
          return;
        }
        case 'checkoutCommit': {
          writeJson(res, 200, OK(await service.checkoutCommit(cwd, { hash: String(payload.hash ?? '') })));
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
