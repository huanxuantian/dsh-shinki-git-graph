/**
 * Git data assembly for the host half: repository/branch/commit history
 * payloads for the sidebar Git graph. All commands are spawned per request
 * against the session's working directory (repo root resolved by git
 * itself), no library, no state.
 */
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { runGit } from './git-runner.js';

/** One git failure (stderr text as the message). */
export class GitCommandError extends Error {
  /**
   * @param {string} message
   * @param {string} [code]
   * @param {string} [command]
   */
  constructor(message, code = 'git-error', command = '') {
    super(message);
    this.name = 'GitCommandError';
    this.code = code;
    this.command = command;
  }
}

/** git missing or not runnable. */
export const E_GIT_MISSING = 'git-missing';
/** Directory is not inside a git work tree. */
export const E_NOT_A_REPO = 'not-a-repo';
/** Per-command timeout. */
export const E_TIMEOUT = 'timeout';
/** Bad request payload. */
export const E_BAD_REQUEST = 'bad-request';

/** Assert a command's exit code is 0, else raise GitCommandError. */
function assertOk(result, code = 'git-error', command = '') {
  if (result.exitCode === 0) return result;
  if (result.exitCode === 127) throw new GitCommandError(result.stderr.trim() || 'git 不可用', E_GIT_MISSING, command);
  if (result.exitCode === 124) throw new GitCommandError('git 命令超时', E_TIMEOUT, command);
  throw new GitCommandError(result.stderr.trim() || `git 退出码 ${result.exitCode}`, code, command);
}

/** Resolve the session's working directory from the session header (host
 *  authoritative — the client never supplies an arbitrary path). */
export function sessionCwd(ctx, sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') return null;
  const session = ctx.sessions?.get?.(sessionId);
  const cwd = session?.header?.cwd;
  if (typeof cwd !== 'string' || cwd === '' || !path.isAbsolute(cwd) || !existsSync(cwd)) return null;
  try { return realpathSync(cwd); } catch { return null; }
}

/** One parsed `git log --parents` row. */
function parseGraphRow(line) {
  const [hash, parentsRaw, subject, author, date, refs = ''] = line.split('\x1f');
  return {
    oid: hash,
    parents: parentsRaw ? parentsRaw.split(' ') : [],
    subject,
    author,
    date,
    refs, // raw %D decorations, e.g. 'HEAD -> main, origin/main, tag: v1'
  };
}

/**
 * Create the git service bound to a host context.
 * @param {{logger?: {warn?: (...a:any[])=>void}}} ctx
 */
export function createGitService(ctx) {
  const log = (...a) => ctx.logger?.warn?.(...a);

  /** Repo root for a cwd, or null when not a git work tree. */
  async function repoRootOf(cwd) {
    const r = await runGit(cwd, ['rev-parse', '--show-toplevel']);
    if (r.exitCode !== 0) return null;
    return r.stdout.trim();
  }

  /** Basic repo identity: isRepo / root / current branch / short HEAD. */
  async function init(cwd) {
    const root = await repoRootOf(cwd);
    if (root === null) return { isRepo: false, root: null, branch: '', head: '' };
    const branchResult = await runGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const headResult = await runGit(cwd, ['rev-parse', '--short', 'HEAD']);
    const branch = branchResult.exitCode === 0 ? branchResult.stdout.trim() : 'HEAD';
    const head = headResult.exitCode === 0 ? headResult.stdout.trim() : '';
    return { isRepo: true, root, branch, head };
  }

  /** Local branches (with upstream + HEAD marker) and remote branches. */
  async function branches(cwd) {
    const format = ['--format=%(refname:short)%00%(upstream:short)%00%(HEAD)%00%(objectname)'];
    const localResult = await runGit(cwd, ['for-each-ref', 'refs/heads', ...format]);
    const remoteResult = await runGit(cwd, ['for-each-ref', 'refs/remotes', '--format=%(refname:short)%00%(objectname)']);
    assertOk(localResult, 'git-error', 'for-each-ref refs/heads');
    const local = [];
    for (const line of localResult.stdout.split(/\r?\n/)) {
      if (!line) continue;
      const [name, upstream = '', head = '', oid = ''] = line.split('\x00');
      if (!name) continue;
      local.push({ name, upstream: upstream || '', isHead: head === '*', oid });
    }
    const remote = [];
    for (const line of remoteResult.stdout.split(/\r?\n/)) {
      if (!line) continue;
      const [name, oid = ''] = line.split('\x00');
      if (!name) continue;
      remote.push({ name, oid });
    }
    const upstreamOf = {};
    for (const b of local) if (b.upstream) upstreamOf[b.name] = b.upstream;
    const current = local.find((b) => b.isHead)?.name ?? '';
    return { current, local, remote, upstreamOf };
  }

  /**
   * Topo-ordered commit graph rows.
   * @param {string} cwd
   * @param {{revs?: string[], all?: boolean, skip?: number, limit?: number, signal?: AbortSignal}} [options]
   */
  async function graph(cwd, options = {}) {
    const { revs = [], all = false, skip = 0, limit = 100, signal } = options;
    if (!Number.isInteger(limit) || limit <= 0 || limit > 1000) throw new GitCommandError('limit 需为 1..1000', E_BAD_REQUEST);
    if (!Number.isInteger(skip) || skip < 0) throw new GitCommandError('skip 需为非负整数', E_BAD_REQUEST);
    // Whitelist every rev against the current refs (injection guard): only
    // HEAD, the current branch, its upstream, and existing branch names.
    let selected;
    if (all) {
      selected = ['--all'];
    } else {
      const { current, local, remote, upstreamOf } = await branches(cwd);
      const allowed = new Set(['HEAD', current, upstreamOf[current] ?? '']);
      for (const b of local) allowed.add(b.name);
      for (const b of remote) allowed.add(b.name);
      allowed.delete('');
      const requested = revs.length > 0 ? revs : ['HEAD'];
      for (const r of requested) {
        if (typeof r !== 'string' || !allowed.has(r)) throw new GitCommandError(`不允许的 rev：${String(r)}`, E_BAD_REQUEST);
      }
      selected = [...requested];
    }
    const args = [
      '-c', 'core.quotepath=false',
      '-c', 'log.showSignature=false',
      'log', '--parents', '--date=iso-strict',
      '--format=%H%x1f%P%x1f%s%x1f%an%x1f%ai%x1f%D',
      ...selected,
      `--skip=${skip}`,
      `-n${limit}`,
    ];
    const result = await runGit(cwd, args, { signal });
    if (result.exitCode === 128 && /not a git repository/i.test(result.stderr)) {
      throw new GitCommandError(result.stderr.trim(), E_NOT_A_REPO, args.join(' '));
    }
    assertOk(result, 'git-error', args.join(' '));
    const rows = result.stdout.split(/\r?\n/).filter(Boolean).map(parseGraphRow);
    return { rows, ended: rows.length < limit, revs: selected };
  }

  /**
   * One commit's detail: metadata + file change stats + full diff text.
   * @param {string} cwd
   * @param {string} hash
   * @param {{signal?: AbortSignal}} [options]
   */
  async function commit(cwd, hash, options = {}) {
    const { signal } = options;
    if (typeof hash !== 'string' || !/^[0-9a-fA-F]{4,40}$/.test(hash)) {
      throw new GitCommandError('非法 hash', E_BAD_REQUEST);
    }
    const metaArgs = [
      '-c', 'core.quotepath=false',
      'show', '-s',
      '--format=%H%x1f%P%x1f%an%x1f%ae%x1f%ai%x1f%cn%x1f%ci%x1f%s%x1f%B',
      hash,
    ];
    const metaResult = await runGit(cwd, metaArgs, { signal });
    if (metaResult.exitCode === 128 && /bad object|unknown revision/i.test(metaResult.stderr)) {
      throw new GitCommandError(metaResult.stderr.trim(), E_BAD_REQUEST, metaArgs.join(' '));
    }
    assertOk(metaResult, 'git-error', metaArgs.join(' '));
    const parts = metaResult.stdout.split('\x1f');
    const [H, P, an, ae, ai, cn, ci, s, ...bodyParts] = parts;
    const isMerge = typeof P === 'string' && P.split(' ').filter(Boolean).length > 1;

    // File stats + diff text in one pass: numstat table precedes the patch.
    const diffArgs = [
      '-c', 'core.quotepath=false',
      'show', ...(isMerge ? ['-m', '--first-parent'] : []),
      '--numstat', '--format=',
      hash,
    ];
    const diffResult = await runGit(cwd, diffArgs, { signal });
    assertOk(diffResult, 'git-error', diffArgs.join(' '));
    const splitAt = diffResult.stdout.indexOf('\ndiff --git ');
    const numstatPart = splitAt === -1 ? diffResult.stdout : diffResult.stdout.slice(0, splitAt + 1);
    const diffText = splitAt === -1 ? '' : diffResult.stdout.slice(splitAt + 1);
    const stat = [];
    for (const line of numstatPart.split(/\r?\n/)) {
      const m = /^([0-9-]+)\t([0-9-]+)\t(.+)$/.exec(line);
      if (m) {
        stat.push({ path: m[3], add: m[1] === '-' ? 0 : Number(m[1]), del: m[2] === '-' ? 0 : Number(m[2]) });
      }
    }
    return {
      hash: H,
      parents: (P ?? '').split(' ').filter(Boolean),
      isMerge,
      subject: s ?? '',
      body: (bodyParts.join('\x1f') ?? '').trimEnd(),
      author: { name: an ?? '', email: ae ?? '', date: ai ?? '' },
      committer: { name: cn ?? '', date: ci ?? '' },
      stat,
      diffText,
    };
  }

  return { init, branches, graph, commit, repoRootOf };
}
