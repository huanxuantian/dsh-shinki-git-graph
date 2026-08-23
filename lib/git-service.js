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

/** Network commands (push/pull/fetch) may take far longer than local ones. */
const NET_TIMEOUT_MS = 120_000;

/** Assert a command's exit code is 0, else raise GitCommandError. */
function assertOk(result, code = 'git-error', command = '') {
  if (result.exitCode === 0) return result;
  if (result.exitCode === 127) throw new GitCommandError(result.stderr.trim() || 'git 不可用', E_GIT_MISSING, command);
  if (result.exitCode === 124) throw new GitCommandError('git 命令超时', E_TIMEOUT, command);
  throw new GitCommandError(result.stderr.trim() || `git 退出码 ${result.exitCode}`, code, command);
}

/** Reject non-plain relative repo paths coming from the client (used as git
 *  args). Git status paths are '/'-separated and may contain spaces; '..'
 *  segments would escape the repo. */
export function validateRelPath(p) {
  if (typeof p !== 'string' || p === '') return false;
  if (p.includes('\u0000') || p.includes('\\')) return false;
  const segs = p.split('/');
  return !segs.some((s) => s === '' || s === '.' || s === '..');
}

/** A remote name: short, no '/', no leading '-' (would parse as an option),
 *  no whitespace. Remote names come from `git remote` and are then re-checked
 *  against the authoritative list before use. */
export function isValidRemoteName(name) {
  return typeof name === 'string'
    && name.length > 0 && name.length <= 64
    && !name.startsWith('-') && !name.includes('\u0000')
    && !name.includes(' ') && !name.includes('/') && !name.includes('\\');
}

/** A branch refspec argument for push/pull/fetch: forbids anything that
 *  could be read as an option or escape the ref namespace ('..', ':', '@{').
 *  Slashes are allowed (feature/x, origin/x). */
export function isValidBranchArg(name) {
  return typeof name === 'string'
    && name.length > 0 && name.length <= 255
    && !name.startsWith('-') && !name.includes('\u0000')
    && !name.includes(' ') && !name.includes('\\')
    && !name.includes('..') && !name.includes('@') && !name.includes(':')
    && !name.includes('~') && !name.includes('^') && !name.includes('?')
    && !name.includes('*') && !name.includes('[') && !name.includes(']')
    && !name.startsWith('/') && !name.endsWith('/') && !name.endsWith('.')
    && name !== '.' && name !== '..';
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

    // File stats + diff text: two passes. `--numstat --format=` yields the
    // stat table but SUPPRESSES the patch; `-p --format=` yields the pure
    // patch. (git show --numstat without --format= also omits the patch.)
    const mergeFlags = isMerge ? ['-m', '--first-parent'] : [];
    const statResult = await runGit(cwd, ['-c', 'core.quotepath=false', 'show', ...mergeFlags, '--numstat', '--format=', hash], { signal });
    assertOk(statResult, 'git-error', 'show --numstat');
    const diffResult = await runGit(cwd, ['-c', 'core.quotepath=false', 'show', ...mergeFlags, '-p', '--format=', hash], { signal });
    assertOk(diffResult, 'git-error', 'show -p');
    const stat = [];
    for (const line of statResult.stdout.split(/\r?\n/)) {
      const m = /^([0-9-]+)\t([0-9-]+)\t(.+)$/.exec(line);
      if (m) {
        stat.push({ path: m[3], add: m[1] === '-' ? 0 : Number(m[1]), del: m[2] === '-' ? 0 : Number(m[2]) });
      }
    }
    const diffText = diffResult.stdout;
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

  /**
   * Working-tree status: porcelain entries [{path, xy}] (index/worktree
   * letters, e.g. 'M ', ' M', 'A ', '??'). NUL-delimited parsing avoids the
   * quoting porcelain applies to unusual paths.
   */
  async function status(cwd) {
    const r = await runGit(cwd, ['-c', 'core.quotepath=false', 'status', '--porcelain=v1', '-z']);
    if (r.exitCode === 128 && /not a git repository/i.test(r.stderr)) {
      throw new GitCommandError(r.stderr.trim(), E_NOT_A_REPO, 'status');
    }
    assertOk(r, 'git-error', 'status --porcelain');
    const entries = [];
    for (const part of r.stdout.split('\u0000')) {
      if (part.length < 3) continue;
      entries.push({ path: part.slice(3), xy: part.slice(0, 2) });
    }
    return { entries };
  }

  /** Diff text of the worktree (unstaged) or the index (staged), optionally
   *  limited to one path. */
  async function diff(cwd, path, staged) {
    if (path !== undefined && !validateRelPath(path)) throw new GitCommandError('非法路径', E_BAD_REQUEST);
    const args = [
      '-c', 'core.quotepath=false',
      'diff',
      ...(staged === true ? ['--cached'] : []),
      ...(path !== undefined ? ['--', path] : []),
    ];
    const r = await runGit(cwd, args);
    assertOk(r, 'git-error', args.join(' '));
    return { diff: r.stdout };
  }

  /** Stage paths (all when path is undefined). */
  async function stage(cwd, path) {
    if (path !== undefined && !validateRelPath(path)) throw new GitCommandError('非法路径', E_BAD_REQUEST);
    const args = ['add', ...(path !== undefined ? ['--', path] : ['--all'])];
    const r = await runGit(cwd, args);
    assertOk(r, 'git-error', args.join(' '));
    return { ok: true };
  }

  /** Unstage paths (all when path is undefined). */
  async function unstage(cwd, path) {
    if (path !== undefined && !validateRelPath(path)) throw new GitCommandError('非法路径', E_BAD_REQUEST);
    const args = ['reset', '--quiet', ...(path !== undefined ? ['--', path] : [])];
    const r = await runGit(cwd, args);
    assertOk(r, 'git-error', args.join(' '));
    return { ok: true };
  }

  /** Discard the worktree changes of one path: `git checkout -- <path>` for
   *  tracked files (index untouched); untracked files are deleted via
   *  `git clean -f -- <path>`. */
  async function discard(cwd, path) {
    if (path === undefined || !validateRelPath(path)) throw new GitCommandError('非法路径', E_BAD_REQUEST);
    const st = await runGit(cwd, ['-c', 'core.quotepath=false', 'status', '--porcelain=v1', '-z']);
    assertOk(st, 'git-error', 'status --porcelain');
    const isUntracked = st.stdout.split('\u0000').some((p) => p.length >= 3 && p.slice(0, 2) === '??' && p.slice(3) === path);
    const args = isUntracked
      ? ['clean', '-f', '--', path]
      : ['checkout', '--quiet', '--', path];
    const r = await runGit(cwd, args);
    assertOk(r, 'git-error', args.join(' '));
    return { ok: true };
  }

  /** Commit the staged changes with a message (global identity untouched). */
  async function commitWithMessage(cwd, message) {
    if (typeof message !== 'string' || message.trim() === '') {
      throw new GitCommandError('提交消息不能为空', E_BAD_REQUEST);
    }
    const args = ['commit', '-m', message];
    const r = await runGit(cwd, args);
    assertOk(r, 'git-error', args.join(' '));
    return { ok: true };
  }

  /** Configured remotes: [{name, url}] from `git remote -v` (deduped). */
  async function remotes(cwd) {
    const r = await runGit(cwd, ['remote', '-v']);
    assertOk(r, 'git-error', 'remote -v');
    const seen = new Set();
    const list = [];
    for (const line of r.stdout.split(/\r?\n/)) {
      const m = /^(\S+)\t(\S+)/.exec(line);
      if (!m) continue;
      const name = m[1];
      if (!seen.has(name)) { seen.add(name); list.push({ name, url: m[2] }); }
    }
    return { remotes: list };
  }

  /** Local tags: [{name, oid}] from refs/tags. */
  async function tags(cwd) {
    const r = await runGit(cwd, ['for-each-ref', 'refs/tags', '--format=%(refname:short)%00%(objectname)']);
    assertOk(r, 'git-error', 'for-each-ref refs/tags');
    const list = [];
    for (const line of r.stdout.split(/\r?\n/)) {
      if (!line) continue;
      const [name, oid = ''] = line.split('\x00');
      if (!name) continue;
      list.push({ name, oid });
    }
    return { tags: list };
  }

  /** Assert a remote exists (authoritative list from `git remote`). */
  async function assertRemote(cwd, remote) {
    if (!isValidRemoteName(remote)) throw new GitCommandError('非法远程名', E_BAD_REQUEST);
    const { remotes: rs } = await remotes(cwd);
    if (!rs.some((r) => r.name === remote)) throw new GitCommandError(`远程不存在：${remote}`, E_BAD_REQUEST);
  }

  /** Push a local branch or tag to a remote:
   *  `git push [-u] <remote> <branch>` / `git push <remote> tag <tag>`.
   *  Exactly one of branch/tag must be provided. */
  async function push(cwd, { remote, branch, tag, setUpstream = false }) {
    await assertRemote(cwd, remote);
    const hasBranch = typeof branch === 'string' && branch !== '';
    const hasTag = typeof tag === 'string' && tag !== '';
    if (hasBranch === hasTag) throw new GitCommandError('push 需指定 branch 或 tag（二选一）', E_BAD_REQUEST);
    let args;
    if (hasBranch) {
      if (!isValidBranchArg(branch)) throw new GitCommandError('非法分支名', E_BAD_REQUEST);
      const { local } = await branches(cwd);
      if (!local.some((b) => b.name === branch)) throw new GitCommandError(`本地分支不存在：${branch}`, E_BAD_REQUEST);
      args = ['push', ...(setUpstream === true ? ['-u'] : []), remote, branch];
    } else {
      if (!isValidBranchArg(tag)) throw new GitCommandError('非法标签名', E_BAD_REQUEST);
      const { tags: ts } = await tags(cwd);
      if (!ts.some((t) => t.name === tag)) throw new GitCommandError(`本地标签不存在：${tag}`, E_BAD_REQUEST);
      args = ['push', remote, 'tag', tag];
    }
    const r = await runGit(cwd, args, { timeoutMs: NET_TIMEOUT_MS });
    assertOk(r, 'git-error', args.join(' '));
    return { ok: true };
  }

  /** Pull = fetch + merge (branch); fetch-only branch; or fetch a specific tag.
   *  - branch: `git pull <remote> <branch>`; fetchOnly → `git fetch <remote> <branch>`
   *  - tag: always fetch only — `git fetch <remote> tag <tag>` (a tag pull
   *    never merges or checks out). branch and tag are mutually exclusive. */
  async function pull(cwd, { remote, branch, tag, fetchOnly = false }) {
    await assertRemote(cwd, remote);
    const hasBranch = typeof branch === 'string' && branch !== '';
    const hasTag = typeof tag === 'string' && tag !== '';
    if (hasBranch && hasTag) throw new GitCommandError('pull 的 branch 与 tag 不能同时指定', E_BAD_REQUEST);
    let args;
    if (hasTag) {
      if (!isValidBranchArg(tag)) throw new GitCommandError('非法标签名', E_BAD_REQUEST);
      args = ['fetch', remote, 'tag', tag];
    } else {
      if (hasBranch && !isValidBranchArg(branch)) throw new GitCommandError('非法分支名', E_BAD_REQUEST);
      args = (fetchOnly === true ? ['fetch'] : ['pull']);
      if (hasBranch) args.push(remote, branch);
      else args.push(remote);
    }
    const r = await runGit(cwd, args, { timeoutMs: NET_TIMEOUT_MS });
    assertOk(r, 'git-error', args.join(' '));
    return { ok: true };
  }

  /** Fetch every remote (`git fetch --all --prune`) — no merge, no checkout. */
  async function fetchAll(cwd) {
    const args = ['fetch', '--all', '--prune'];
    const r = await runGit(cwd, args, { timeoutMs: NET_TIMEOUT_MS });
    assertOk(r, 'git-error', args.join(' '));
    return { ok: true };
  }

  /** The default remote for tracking auto-setup, mirroring git's
   *  checkout.defaultRemote resolution: explicit config → sole remote →
   *  'origin' → first remote. Returns '' when no remote applies.
   *  `remoteList` holds full remote-branch names (`origin/feature`), so the
   *  remote name is the part before the first '/'. */
  async function defaultRemoteName(cwd, remoteList) {
    const cfg = await runGit(cwd, ['config', '--get', 'checkout.defaultRemote']);
    if (cfg.exitCode === 0 && cfg.stdout.trim() && isValidRemoteName(cfg.stdout.trim())) {
      return cfg.stdout.trim();
    }
    const remoteNames = [];
    const seen = new Set();
    for (const r of remoteList) {
      const slash = String(r.name).indexOf('/');
      if (slash <= 0) continue;
      const name = r.name.slice(0, slash);
      if (!seen.has(name)) { seen.add(name); remoteNames.push(name); }
    }
    if (remoteNames.length === 1) return remoteNames[0];
    if (remoteNames.includes('origin')) return 'origin';
    return remoteNames[0] ?? '';
  }

  /** `git branch --set-upstream-to=<remoteBranch> <branchName>`. */
  async function setUpstream(cwd, branchName, remoteBranch) {
    const args = ['branch', `--set-upstream-to=${remoteBranch}`, branchName];
    const r = await runGit(cwd, args);
    assertOk(r, 'git-error', args.join(' '));
  }

  /** Whether a same-named branch actually exists on the remote. Local
   *  remote-tracking refs are a fast path; when stale/missing, `git ls-remote
   *  --heads <remote> <branch>` probes the authoritative remote (short
   *  timeout; a network failure counts as "not present" so we never bind a
   *  tracking relationship speculatively). */
  async function remoteBranchExists(cwd, remoteName, branchName, remoteList) {
    if (remoteList.some((r) => r.name === `${remoteName}/${branchName}`)) return true;
    const r = await runGit(cwd, ['ls-remote', '--heads', remoteName, `refs/heads/${branchName}`], { timeoutMs: 8000 });
    if (r.exitCode !== 0) return false;
    return /^[0-9a-f]{40}\s+refs\/heads\//m.test(r.stdout);
  }

  /** If the branch has no upstream yet, link it to the same-named branch on
   *  the default remote (git's default tracking strategy) — only when that
   *  branch actually exists on the remote. */
  async function maybeSetUpstream(cwd, branchName, remoteList) {
    const dr = await defaultRemoteName(cwd, remoteList);
    if (dr === '') return;
    const exists = await remoteBranchExists(cwd, dr, branchName, remoteList);
    if (!exists) return;
    await setUpstream(cwd, branchName, `${dr}/${branchName}`);
  }

  /** Switch to a local branch (`git checkout <branch>`), or to a remote
   *  branch (`origin/feature`): if a local branch with the same name exists
   *  it is checked out, otherwise `--track` creates it with the upstream
   *  configured. A local branch without an upstream gets linked to the
   *  same-named branch on the default remote (git's default strategy) when
   *  one exists. */
  async function checkout(cwd, { branch, linkCurrent = false }) {
    if (!isValidBranchArg(branch)) throw new GitCommandError('非法分支名', E_BAD_REQUEST);
    const { local, remote, current } = await branches(cwd);
    const slash = branch.indexOf('/');
    const isRemoteRef = slash > 0 && remote.some((r) => r.name === branch);
    const localName = isRemoteRef ? branch.slice(slash + 1) : branch;
    const localBranch = local.find((b) => b.name === localName);
    let args;
    let after = null;
    if (isRemoteRef) {
      if (localBranch) {
        // A local branch of the same name takes precedence (plain switch);
        // link it to this remote branch if it has no upstream yet.
        if (localBranch.upstream) {
          if (localName === current) return { ok: true, unchanged: true };
          args = ['checkout', '--quiet', localName];
        } else if (localName === current) {
          // Checking out the current branch is a no-op; only link its
          // upstream when the user opted in for this session (linkCurrent).
          if (linkCurrent === true) await setUpstream(cwd, localName, branch);
          return { ok: true, unchanged: true };
        } else {
          args = ['checkout', '--quiet', localName];
          after = () => setUpstream(cwd, localName, branch);
        }
      } else {
        args = ['checkout', '--quiet', '--track', branch];
      }
    } else {
      if (!localBranch) throw new GitCommandError(`本地分支不存在：${branch}`, E_BAD_REQUEST);
      if (localName === current) {
        // No-op checkout of the current branch: do NOT auto-link its
        // upstream by default; only when the user opted in (linkCurrent).
        if (localBranch.upstream === '' && linkCurrent === true) await maybeSetUpstream(cwd, localName, remote);
        return { ok: true, unchanged: true };
      }
      args = ['checkout', '--quiet', branch];
      if (!localBranch.upstream) after = () => maybeSetUpstream(cwd, localName, remote);
    }
    const r = await runGit(cwd, args);
    if (r.exitCode === 128 && /unknown revision|pathspec/i.test(r.stderr)) {
      throw new GitCommandError(r.stderr.trim(), E_BAD_REQUEST, args.join(' '));
    }
    assertOk(r, 'git-error', args.join(' '));
    if (after) await after();
    return { ok: true };
  }

  /** Create a new branch from a base (defaults to current HEAD):
   *  `git checkout -b <name> [<base>]`. The name must not exist yet; the
   *  base may be an existing local branch, a remote branch (`origin/feature`,
   *  which also configures the upstream tracking relationship via `--track`),
   *  or a commit hash (4..40 hex). */
  async function createBranch(cwd, { name, base }) {
    if (!isValidBranchArg(name)) throw new GitCommandError('非法分支名', E_BAD_REQUEST);
    const { local, remote } = await branches(cwd);
    if (local.some((b) => b.name === name)) throw new GitCommandError(`本地分支已存在：${name}`, E_BAD_REQUEST);
    let args;
    if (base !== undefined && base !== '') {
      if (!isValidBranchArg(base)) throw new GitCommandError('非法分支名', E_BAD_REQUEST);
      const isLocal = local.some((b) => b.name === base);
      const isRemote = remote.some((r) => r.name === base);
      const isHash = /^[0-9a-fA-F]{4,40}$/.test(base);
      if (!isLocal && !isRemote && !isHash) throw new GitCommandError(`基准分支不存在：${base}`, E_BAD_REQUEST);
      args = isRemote
        ? ['checkout', '--quiet', '-b', name, '--track', base]
        : ['checkout', '--quiet', '-b', name, base];
    } else {
      args = ['checkout', '--quiet', '-b', name];
    }
    const r = await runGit(cwd, args);
    if (r.exitCode === 128 && /unknown revision|pathspec/i.test(r.stderr)) {
      throw new GitCommandError(r.stderr.trim(), E_BAD_REQUEST, args.join(' '));
    }
    assertOk(r, 'git-error', args.join(' '));
    return { ok: true };
  }

  /** Check out a commit in detached HEAD state: `git checkout --detach <hash>`. */
  async function checkoutCommit(cwd, { hash }) {
    if (typeof hash !== 'string' || !/^[0-9a-fA-F]{4,40}$/.test(hash)) {
      throw new GitCommandError('非法 hash', E_BAD_REQUEST);
    }
    const args = ['checkout', '--quiet', '--detach', hash];
    const r = await runGit(cwd, args);
    if (r.exitCode === 128 && /unknown revision|pathspec/i.test(r.stderr)) {
      throw new GitCommandError(r.stderr.trim(), E_BAD_REQUEST, args.join(' '));
    }
    assertOk(r, 'git-error', args.join(' '));
    return { ok: true };
  }

  return {
    init, branches, graph, commit, repoRootOf, status, diff, stage, unstage, discard,
    commitWithMessage, remotes, tags, push, pull, fetchAll,
    checkout, createBranch, checkoutCommit,
  };
}
