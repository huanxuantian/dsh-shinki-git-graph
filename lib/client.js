/*!
 * dsh-shinki-git-graph client bundle (browser half).
 *
 * Registers a sidebar tab ("Git 图谱") through the dsh-better-sidebar
 * `ctx.betterSidebar` service and renders: branch scope selector, branch
 * tree (local/remote groups), a lane-based commit graph, and expandable
 * commit details (metadata + file stats + collapsible diff).
 *
 * The graph data (parents per commit) comes from the host half's
 * POST /shinki-git/api routes; lanes are computed here with the same
 * algorithm as the upstream git-graph plugin (see lib/lanes.js — keep the
 * inlined copy in sync).
 */
window.__ModuleLoader__.load({
  id: 'dsh-shinki-git-graph',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    let react = require('react');
    let primitives = require('@deepseek-ai/dsh-client-ui-primitives');
    const { useState, useEffect, useCallback, useMemo, useRef, Fragment } = react;

    // ── helpers ──────────────────────────────────────────────────────────
    const h = (type, props, ...children) => react.createElement(type, props ?? null, ...children);

    /** POST one /shinki-git/api method. */
    function apiPost(method, sessionId, payload, signal) {
      return fetch('/shinki-git/api', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, method, ...(payload ?? {}) }),
        signal,
      }).then(async (res) => {
        const body = await res.json().catch(() => ({ ok: false, error: { code: 'bad-response', message: '无效响应' } }));
        if (!res.ok || body.ok !== true) {
          const err = new Error(body?.error?.message ?? `HTTP ${res.status}`);
          err.code = body?.error?.code ?? 'http-' + res.status;
          throw err;
        }
        return body.value;
      });
    }

    /** Ref names of one log row's decorations (same rule as the built-in GitView). */
    function refNames(refs) {
      return [...new Set(
        String(refs || '')
          .split(',')
          .map((ref) => ref.trim())
          .filter((ref) => ref !== '')
          .map((ref) => (ref.includes(' -> ') ? ref.slice(ref.indexOf(' -> ') + 4) : ref))
          .map((ref) => (ref.startsWith('tag: ') ? ref.slice(5) : ref))
      )];
    }

    /** Ref list with tag distinction: [{name, isTag}] (deduped). */
    function refsList(refs) {
      const out = [];
      const seen = new Set();
      for (const raw of String(refs || '').split(',')) {
        const r = raw.trim();
        if (r === '') continue;
        let name = r;
        if (name.includes(' -> ')) name = name.slice(name.indexOf(' -> ') + 4);
        let isTag = false;
        if (name.startsWith('tag: ')) { name = name.slice(5); isTag = true; }
        if (seen.has(name)) continue;
        seen.add(name);
        out.push({ name, isTag });
      }
      return out;
    }

    /** The XY status letter a worktree row badge shows (X=index, Y=worktree). */
    function badgeOf(entry) {
      const index = entry.xy[0];
      const worktree = entry.xy[1];
      if (index !== undefined && index !== ' ' && index !== '?') return index;
      if (worktree !== undefined && worktree !== ' ' && worktree !== '?') return worktree;
      return '?';
    }

    /** Relative time for an ISO date string (mirrors the built-in formatting). */
    function relativeTime(iso) {
      const time = new Date(iso).getTime();
      if (Number.isNaN(time)) return iso;
      const elapsed = Date.now() - time;
      const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
      if (elapsed < MINUTE) return t('justNow');
      if (elapsed < HOUR) return t('minutesAgo', { count: Math.floor(elapsed / MINUTE) });
      if (elapsed < DAY) return t('hoursAgo', { count: Math.floor(elapsed / HOUR) });
      if (elapsed < 30 * DAY) return t('daysAgo', { count: Math.floor(elapsed / DAY) });
      return new Date(iso).toLocaleDateString();
    }

    /** Lane assignment — inlined copy of lib/lanes.js (keep in sync). */
    function assignLanes(rows) {
      const later = new Set();
      for (const row of rows) for (const parent of row.parents) later.add(parent);
      const lanes = [];
      return rows.map((row) => {
        let nodeColumn = lanes.findIndex((pending) => pending === row.oid);
        if (nodeColumn === -1) { lanes.push(row.oid); nodeColumn = lanes.length - 1; }
        const columns = [];
        for (let i = 0; i < lanes.length; i += 1) {
          const pending = lanes[i];
          if (pending === null) columns.push('gap');
          else if (i === nodeColumn) columns.push(row.parents.length > 1 ? 'merge' : 'node');
          else if (pending === row.oid) columns.push('gap');
          else if (typeof pending === 'string' && later.has(pending)) columns.push('pass');
          else columns.push('gap');
        }
        const [first, ...rest] = row.parents.filter((parent) => later.has(parent));
        for (let i = 0; i < lanes.length; i += 1) if (lanes[i] === row.oid && i !== nodeColumn) lanes[i] = null;
        lanes[nodeColumn] = first ?? null;
        for (const parent of rest) if (!lanes.includes(parent)) lanes.push(parent);
        while (lanes.length > 0 && lanes[lanes.length - 1] === null) lanes.pop();
        return { columns, merge: row.parents.length > 1 };
      });
    }

    const LANE_COLORS = ['#d29922', '#f778ba', '#79c0ff', '#7ee787', '#ffa657', '#a5d6ff', '#ff7b72', '#8b949e'];

    // ── persisted settings (localStorage; pluginSettings wiring deferred) ──
    const store = {
      get(key, fallback) {
        try {
          const v = window.localStorage.getItem(`${NS}:${key}`);
          return v === null ? fallback : v;
        } catch { return fallback; }
      },
      set(key, value) {
        try { window.localStorage.setItem(`${NS}:${key}`, String(value)); } catch { /* ignore */ }
      },
    };

    // ── locale ───────────────────────────────────────────────────────────
    const NS = 'shinkiGitGraph';
    const zh = {
      tabTitle: 'Git 图谱',
      scope: '分支范围',
      scopeCurUp: '当前分支 + 上游',
      scopeAll: '全部本地和远程分支',
      refresh: '刷新',
      local: '本地',
      remote: '远程',
      current: '当前',
      upstream: '上游',
      loading: '加载中…',
      loadMore: '加载更多',
      notRepo: '当前工作区不是 Git 仓库',
      gitMissing: 'git 不可用，请安装 git 后重试',
      noUpstream: '（无上游远程分支）',
      noCommits: '没有提交记录',
      error: '加载失败',
      retry: '重试',
      expanded: '收起',
      collapsed: '展开',
      author: '作者',
      committer: '提交者',
      parents: '父提交',
      mergeCommit: '合并提交',
      files: '变更文件',
      copyHash: '复制 hash',
      copied: '已复制',
      showDiff: '显示完整 diff',
      hideDiff: '收起 diff',
      diffTitle: '提交详情',
      openDiff: '在 diff 页打开',
      filterHint: '勾选分支以过滤（不勾选 = 显示全部）',
      justNow: '刚刚',
      minutesAgo: '{count} 分钟前',
      hoursAgo: '{count} 小时前',
      daysAgo: '{count} 天前',
      workAction: '工作区操作…',
      stageAll: '暂存全部',
      unstageAll: '取消暂存全部',
      discardAll: '丢弃全部更改',
      commit: '提交',
      cancel: '取消',
      commitPlaceholder: '提交信息…（Ctrl+Enter 提交）',
      uncommitted: '未提交的更改',
      worktreeArea: '暂存区',
      worktreeClean: '工作区干净',
      worktreeCleanHint: '没有未提交的更改',
      staged: '已暂存',
      unstaged: '未暂存',
      stage: '暂存',
      unstage: '取消暂存',
      discard: '丢弃更改',
      viewDiff: '查看 diff',
      copyShortHash: '复制短 hash',
      copyFullHash: '复制完整 hash',
      copySubject: '复制提交主题',
      showTags: '显示标签',
      expand: '展开详情',
      tags: '标签',
    };
    const en = {
      tabTitle: 'Git Graph',
      scope: 'Branches',
      scopeCurUp: 'Current + upstream',
      scopeAll: 'All local & remote',
      refresh: 'Refresh',
      local: 'Local',
      remote: 'Remote',
      current: 'current',
      upstream: 'upstream',
      loading: 'Loading…',
      loadMore: 'Load more',
      notRepo: 'The current workspace is not a git repository',
      gitMissing: 'git is unavailable — install git and retry',
      noUpstream: '(no upstream remote branch)',
      noCommits: 'No commits',
      error: 'Failed to load',
      retry: 'Retry',
      expanded: 'Collapse',
      collapsed: 'Expand',
      author: 'Author',
      committer: 'Committer',
      parents: 'Parents',
      mergeCommit: 'Merge commit',
      files: 'Files changed',
      copyHash: 'Copy hash',
      copied: 'Copied',
      showDiff: 'Show full diff',
      hideDiff: 'Hide diff',
      diffTitle: 'Commit details',
      openDiff: 'Open in diff tab',
      filterHint: 'Check branches to filter (none checked = show all)',
      justNow: 'just now',
      minutesAgo: '{count} minutes ago',
      hoursAgo: '{count} hours ago',
      daysAgo: '{count} days ago',
      workAction: 'Workspace actions…',
      stageAll: 'Stage all',
      unstageAll: 'Unstage all',
      discardAll: 'Discard all changes',
      commit: 'Commit',
      cancel: 'Cancel',
      commitPlaceholder: 'Commit message… (Ctrl+Enter to commit)',
      uncommitted: 'Uncommitted changes',
      worktreeArea: 'Staging area',
      worktreeClean: 'Working tree clean',
      worktreeCleanHint: 'No uncommitted changes',
      staged: 'Staged',
      unstaged: 'Unstaged',
      stage: 'Stage',
      unstage: 'Unstage',
      discard: 'Discard changes',
      viewDiff: 'View diff',
      copyShortHash: 'Copy short hash',
      copyFullHash: 'Copy full hash',
      copySubject: 'Copy subject',
      showTags: 'Show tags',
      expand: 'Expand details',
      tags: 'Tags',
    };
    const DICTS = { zh, en };
    const activeLocale = () => {
      try {
        const a = (typeof nw !== 'undefined' && nw) ? 'zh' : (navigator.language || 'zh');
        return a.toLowerCase().startsWith('zh') ? 'zh' : 'en';
      } catch { return 'zh'; }
    };
    let t = (key, vars) => {
      const dict = DICTS[activeLocale()] ?? zh;
      let s = dict[key] ?? key;
      if (vars) for (const [k, v] of Object.entries(vars)) s = s.replace(`{${k}}`, String(v));
      return s;
    };

    // ── styles ───────────────────────────────────────────────────────────
    const CSS = `
[data-dsh-plugin="dsh-shinki-git-graph"]{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-primary,#e6edf3)}
.sgg-header{display:flex;align-items:center;gap:6px;padding:6px 8px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.08))}
.sgg-scope{flex:1;min-width:0;background:var(--dsw-alias-button-tool-bar-fill,transparent);color:var(--dsw-alias-label-primary,#e6edf3);border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.1));border-radius:6px;padding:3px 6px;font-size:12px;outline:none}
.sgg-ver{flex:none;font-size:10px;color:var(--dsw-alias-label-tertiary,#8b949e);user-select:none}
.sgg-iconbtn{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border:none;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,#9da7b3);cursor:pointer;flex:none}
.sgg-iconbtn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06));color:var(--dsw-alias-label-primary,#e6edf3)}
.sgg-iconbtn:disabled{opacity:.5;cursor:default}
.sgg-tree{padding:4px 8px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.06))}
.sgg-tree-group{font-size:11px;color:var(--dsw-alias-label-tertiary,#8b949e);text-transform:uppercase;letter-spacing:.04em;margin:6px 0 2px;display:flex;align-items:center;gap:4px}
.sgg-tree-row{display:flex;align-items:center;gap:6px;padding:2px 4px;border-radius:4px;cursor:pointer;min-width:0}
.sgg-tree-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06))}
.sgg-tree-row.sgg-current{color:var(--dsw-alias-label-primary,#e6edf3)}
.sgg-tree-check{flex:none;accent-color:var(--dsw-alias-brand-primary,#4d9fff)}
.sgg-tree-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sgg-branch-dot{width:8px;height:8px;border-radius:50%;flex:none;background:transparent}
.sgg-tree-tag{flex:none;font-size:10px;padding:0 5px;border-radius:8px;background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08));color:var(--dsw-alias-label-secondary,#9da7b3)}
.sgg-hint{font-size:10px;color:var(--dsw-alias-label-tertiary,#8b949e);padding:2px 4px}
.sgg-list{padding:4px 0 8px;overflow-y:auto;flex:1;min-height:0}
.sgg-row{display:flex;align-items:flex-start;gap:6px;padding:3px 8px;cursor:pointer;border-radius:0;min-width:0}
.sgg-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.05))}
.sgg-row.sgg-open{background:var(--dsw-alias-interactive-bg-hover-accent,rgba(77,159,255,.12))}
.sgg-lanes{display:flex;flex:none;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:1.5}
.sgg-glyph{width:10px;text-align:center}
.sgg-glyph-gap{color:transparent}
.sgg-main{flex:1;min-width:0}
.sgg-line1{display:flex;align-items:baseline;gap:6px;min-width:0}
.sgg-hash{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10.5px;color:var(--dsw-alias-label-tertiary,#8b949e);flex:none}
.sgg-subject{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary,#e6edf3)}
.sgg-line2{display:flex;align-items:center;gap:6px;margin-top:1px;flex-wrap:wrap}
.sgg-ref{font-size:10px;padding:0 5px;border-radius:8px;background:rgba(77,159,255,.16);color:#79c0ff;flex:none}
.sgg-ref-current{background:rgba(46,160,67,.18);color:#7ee787}
.sgg-ref-tag{background:rgba(210,153,34,.16);color:#d29922}
.sgg-meta{font-size:10.5px;color:var(--dsw-alias-label-tertiary,#8b949e)}
.sgg-more{display:block;width:100%;text-align:center;padding:6px;border:none;background:transparent;color:var(--dsw-alias-label-secondary,#9da7b3);cursor:pointer;font-size:12px}
.sgg-more:hover{color:var(--dsw-alias-label-primary,#e6edf3)}
.sgg-work{flex:none;width:36px;background:var(--dsw-alias-button-tool-bar-fill,transparent);color:var(--dsw-alias-label-primary,#e6edf3);border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.1));border-radius:6px;padding:3px 4px;font-size:12px;outline:none}
.sgg-wt{border-bottom:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.08))}
.sgg-wt-head{display:flex;align-items:center;gap:6px;padding:5px 8px;cursor:pointer;font-size:12px;color:var(--dsw-alias-label-primary,#e6edf3)}
.sgg-wt-head:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.05))}
.sgg-wt-caret{flex:none;color:var(--dsw-alias-label-tertiary,#8b949e);width:12px}
.sgg-wt-icon{flex:none;color:#d29922}
.sgg-wt-title{font-weight:600;flex:none}
.sgg-wt-info{font-size:11px;color:var(--dsw-alias-label-secondary,#9da7b3);margin-left:4px}
.sgg-wt-clean{color:var(--dsw-alias-label-tertiary,#8b949e)}
.sgg-wt-body{padding:4px 8px 8px;border-top:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.05))}
.sgg-wt-empty{padding:6px 4px;font-size:11.5px;color:var(--dsw-alias-label-tertiary,#8b949e)}
.sgg-wt-group{font-size:11px;color:var(--dsw-alias-label-tertiary,#8b949e);margin:5px 0 2px}
.sgg-wt-file{display:flex;align-items:center;gap:6px;padding:2px 4px;border-radius:4px;min-width:0}
.sgg-wt-file:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.05))}
.sgg-wt-badge{flex:none;font-size:10px;color:var(--dsw-alias-label-tertiary,#8b949e);width:14px;text-align:center}
.sgg-wt-path{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11.5px;color:var(--dsw-alias-label-primary,#e6edf3)}
.sgg-commit-row{display:flex;align-items:center;gap:6px;margin-top:6px}
.sgg-commit-input{flex:1;min-width:0;background:var(--dsw-alias-button-tool-bar-fill,transparent);border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.1));border-radius:6px;padding:4px 6px;font-size:12px;color:var(--dsw-alias-label-primary,#e6edf3);outline:none}
.sgg-commit-btn{flex:none;border:none;border-radius:6px;background:var(--dsw-alias-brand-primary,#4d9fff);color:#fff;padding:4px 12px;font-size:12px;cursor:pointer}
.sgg-commit-btn:disabled{opacity:.5;cursor:default}
.sgg-empty{padding:20px 12px;text-align:center;color:var(--dsw-alias-label-tertiary,#8b949e)}
.sgg-error{padding:8px 12px;color:#ff7b72;white-space:pre-wrap}
.sgg-detail{border-top:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.1));max-height:33vh;overflow-y:auto;background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.15))}
.sgg-detail-fixed{position:sticky;top:0;z-index:1;background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.15));padding:8px 10px 4px;max-height:14vh;overflow-y:auto}
.sgg-stat-wrap{padding:0 10px;overflow-y:auto}
.sgg-detail-scroll{padding:0 10px 8px}
.sgg-detail-head{display:flex;align-items:center;gap:8px;margin-bottom:6px}
.sgg-detail-title{font-weight:600;font-size:12.5px;color:var(--dsw-alias-label-primary,#e6edf3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sgg-detail-meta{font-size:11px;color:var(--dsw-alias-label-secondary,#9da7b3);margin:2px 0}
.sgg-detail-meta b{color:var(--dsw-alias-label-tertiary,#8b949e);font-weight:500;margin-right:4px}
.sgg-body{font-size:11.5px;color:var(--dsw-alias-label-secondary,#9da7b3);white-space:pre-wrap;margin:4px 0 8px;border-left:2px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));padding-left:8px}
.sgg-stat{list-style:none;margin:0;padding:0}
.sgg-stat li{display:flex;align-items:center;gap:8px;padding:2px 4px;border-radius:4px;font-size:11.5px;min-width:0}
.sgg-stat li:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.05))}
.sgg-stat-path{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary,#e6edf3);cursor:pointer}
.sgg-stat-path:hover{text-decoration:underline}
.sgg-stat-nums{flex:none;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10.5px}
.sgg-add{color:#7ee787}
.sgg-del{color:#ff7b72;margin-left:6px}
.sgg-diff-toggle{border:none;background:none;color:var(--dsw-alias-brand-primary,#4d9fff);cursor:pointer;font-size:11.5px;padding:2px 0}
.sgg-diff{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10.5px;line-height:1.45;white-space:pre;overflow-x:auto;margin-top:6px;color:var(--dsw-alias-label-secondary,#9da7b3)}
.sgg-diff .d{color:#ff7b72}.sgg-diff .a{color:#7ee787}.sgg-diff .h{color:#79c0ff}
.sgg-actions{display:flex;gap:8px;margin-top:6px}
.sgg-link{border:none;background:none;color:var(--dsw-alias-brand-primary,#4d9fff);cursor:pointer;font-size:11.5px;padding:0}
.sgg-copy{flex:none}
`;

    function injectCss() {
      if (document.querySelector('style[data-dsh-plugin="dsh-shinki-git-graph"]')) return;
      const style = document.createElement('style');
      style.dataset.dshPlugin = 'dsh-shinki-git-graph';
      style.textContent = CSS;
      document.head.appendChild(style);
    }

    // ── components ───────────────────────────────────────────────────────
    /** Diff text with lightweight +/- coloring. */
    function DiffText({ text }) {
      const lines = String(text).split('\n');
      return h('pre', { className: 'sgg-diff' },
        lines.map((line, i) => {
          let cls = '';
          if (line.startsWith('+') && !line.startsWith('+++')) cls = 'a';
          else if (line.startsWith('-') && !line.startsWith('---')) cls = 'd';
          else if (line.startsWith('@@')) cls = 'h';
          return h('div', { key: i, className: cls }, line === '' ? ' ' : line);
        })
      );
    }

    /** Expandable commit detail panel. */
    function CommitDetail({ detail, branch, onOpenDiff, onClose, refsRaw }) {
      const [showDiff, setShowDiff] = useState(false);
      const [copied, setCopied] = useState(false);
      const tags = refsRaw ? refsList(refsRaw).filter((r) => r.isTag).map((r) => r.name) : [];
      // File list height computed in JS (pixel-exact, no flex/percent guess):
      // at least the natural row count, capped at 33vh/4 + two rows (~8.25vh
      // + 2 rows). One file = one row, no leftover blank.
      const ROW_H = 22;
      const statMax = Math.round((window.innerHeight * 0.33) / 4) + ROW_H * 2;
      const statH = Math.min(detail.stat.length * ROW_H, statMax);
      const copy = () => {
        try { primitives.writeClipboard(detail.hash); } catch { /* ignore */ }
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      };
      const short = detail.hash.slice(0, 7);
      const openFile = (filePath) => {
        onOpenDiff?.({
          id: `diff:c:${detail.hash}`,
          type: 'diff',
          title: `${short} ${detail.subject}`,
          diff: { kind: 'commit', hash: short, hashFull: detail.hash, subject: detail.subject },
        });
      };
      return h('div', { className: 'sgg-detail' },
        h('div', { className: 'sgg-detail-fixed' },
          h('div', { className: 'sgg-detail-head' },
            h('span', { className: 'sgg-detail-title' }, `${short} ${detail.subject}`),
            h('button', { className: 'sgg-link sgg-copy', onClick: copy }, copied ? t('copied') : t('copyHash')),
            h('button', { className: 'sgg-link', onClick: onClose }, t('collapsed')),
          ),
          detail.isMerge && h('div', { className: 'sgg-detail-meta' }, t('mergeCommit')),
          tags.length > 0 && h('div', { className: 'sgg-detail-meta' },
            h('b', null, t('tags')),
            tags.map((tag, i) => h('span', { key: tag, className: 'sgg-ref sgg-ref-tag' }, i > 0 ? ` ${tag}` : tag)),
          ),
          h('div', { className: 'sgg-detail-meta' },
            h('b', null, t('author')), `${detail.author.name} <${detail.author.email}> · ${detail.author.date}`),
          h('div', { className: 'sgg-detail-meta' },
            h('b', null, t('committer')), `${detail.committer.name} · ${detail.committer.date}`),
          detail.parents.length > 0 && h('div', { className: 'sgg-detail-meta' },
            h('b', null, t('parents')),
            detail.parents.slice(0, 8).join(' '),
            detail.parents.length > 8 ? ` …(+${detail.parents.length - 8})` : ''),
          detail.body ? h('div', { className: 'sgg-body' }, detail.body) : null,
        ),
        h('div', { className: 'sgg-stat-wrap', style: { height: statH > 0 ? `${statH}px` : 'auto' } },
          h('ul', { className: 'sgg-stat' },
            detail.stat.map((f) => h('li', { key: f.path },
              h('span', { className: 'sgg-stat-path', title: f.path, onClick: () => openFile(f.path) }, f.path),
              h('span', { className: 'sgg-stat-nums' },
                f.add > 0 && h('span', { className: 'sgg-add' }, `+${f.add}`),
                f.del > 0 && h('span', { className: 'sgg-del' }, `-${f.del}`),
              ),
            )),
          ),
        ),
        h('div', { className: 'sgg-detail-scroll' },
          detail.diffText
            ? h(Fragment, null,
                h('button', { className: 'sgg-diff-toggle', onClick: () => setShowDiff(!showDiff) },
                  showDiff ? t('hideDiff') : t('showDiff')),
                showDiff && h(DiffText, { text: detail.diffText }),
              )
            : null,
        ),
      );
    }

    /** One commit row: lanes + refs + subject + meta. `branchColor` is the
     *  color of the first selected branch this row belongs to (multi-branch
     *  filtering), coloring the leading node/lane glyphs as a branch marker;
     *  null keeps the default lane palette. */
    function GraphRow({ row, lane, branch, open, onToggle, onContextMenu, branchColor, showTags }) {
      const colorOf = (i, glyph) => {
        if (glyph === 'gap') return null;
        return branchColor ?? LANE_COLORS[i % LANE_COLORS.length];
      };
      const cells = lane.columns.map((glyph, i) =>
        h('span', {
          key: i,
          className: `sgg-glyph sgg-glyph-${glyph}`,
          style: { color: colorOf(i, glyph) },
        }, glyph === 'node' ? '●' : glyph === 'merge' ? '◉' : glyph === 'pass' ? '│' : ' '),
      );
      const refs = refsList(row.refs);
      const isCurrentRef = branch !== '' && refs.some((r) => r.name === branch && !r.isTag);
      const openMenu = (event) => {
        event.preventDefault();
        event.stopPropagation();
        onContextMenu?.({ x: event.clientX, y: event.clientY, row });
      };
      return h('div', {
        className: `sgg-row${open ? ' sgg-open' : ''}`,
        role: 'button',
        tabIndex: 0,
        onClick: onToggle,
        onContextMenu: openMenu,
        onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); } },
        title: `${row.author} · ${row.date}\n${row.oid}`,
      },
        h('span', { className: 'sgg-lanes' }, cells),
        h('span', { className: 'sgg-main' },
          h('div', { className: 'sgg-line1' },
            h('span', { className: 'sgg-hash' }, row.oid.slice(0, 7)),
            h('span', { className: 'sgg-subject' }, row.subject),
          ),
          h('div', { className: 'sgg-line2' },
            refs.filter((r) => !r.isTag || showTags).map((ref) => h('span', {
              key: ref.name,
              className: `sgg-ref${isCurrentRef && ref.name === branch ? ' sgg-ref-current' : ''}${ref.isTag ? ' sgg-ref-tag' : ''}`,
            }, ref.name)),
            h('span', { className: 'sgg-meta' }, `${row.author} · ${relativeTime(row.date)}`),
          ),
        ),
      );
    }

    /** Branch tree: local/remote groups with upstream annotations. */
    function BranchTree({ branches, scopeMode, selected, onToggleBranch, currentBranch, branchColors }) {
      const curUp = branches.upstreamOf[currentBranch] ?? '';
      const localRows = scopeMode === 'all'
        ? branches.local
        : branches.local.filter((b) => b.name === currentBranch || (curUp && b.name === curUp));
      const remoteRows = scopeMode === 'all' ? branches.remote : [];
      const row = (b) => {
        const isCurrent = b.name === currentBranch;
        const isUp = b.name === curUp;
        const tag = isCurrent ? t('current') : isUp ? t('upstream') : b.upstream ? `↔ ${b.upstream}` : '';
        const checked = scopeMode === 'all' ? selected.includes(b.name) : true;
        const dotColor = branchColors?.get(b.name) ?? '';
        return h('div', {
          key: b.name,
          className: `sgg-tree-row${isCurrent ? ' sgg-current' : ''}`,
          onClick: scopeMode === 'all' ? () => onToggleBranch(b.name) : undefined,
        },
          scopeMode === 'all' && h('input', {
            type: 'checkbox', className: 'sgg-tree-check', checked,
            onChange: () => onToggleBranch(b.name),
            onClick: (e) => e.stopPropagation(),
          }),
          h('span', { className: 'sgg-branch-dot', style: dotColor ? { background: dotColor } : null }),
          h('span', { className: 'sgg-tree-name', title: b.name }, `${isCurrent ? '✓ ' : ''}${b.name}`),
          tag && h('span', { className: 'sgg-tree-tag' }, tag),
        );
      };
      return h('div', { className: 'sgg-tree' },
        h('div', { className: 'sgg-tree-group' }, t('local')),
        ...localRows.map(row),
        scopeMode !== 'all' && curUp === '' && h('div', { className: 'sgg-hint' }, t('noUpstream')),
        scopeMode === 'all' && h('div', { className: 'sgg-tree-group' }, t('remote')),
        ...remoteRows.map(row),
        scopeMode === 'all' && h('div', { className: 'sgg-hint' }, t('filterHint')),
      );
    }

    /** Main sidebar tab. */
    function GitGraphTab({ ctx, scope, visible, onOpenDiff }) {
      const sessionId = scope?.sessionId ?? '';
      const [phase, setPhase] = useState('loading'); // loading | ready | not-repo | git-missing | error
      const [branches, setBranches] = useState(null);
      const [rows, setRows] = useState([]);
      const [ended, setEnded] = useState(false);
      const [scopeMode, setScopeMode] = useState(() => store.get('scope', 'current-upstream'));
      const [pageSize, setPageSize] = useState(() => {
        const n = Number(store.get('pageSize', '100'));
        return Number.isInteger(n) && n >= 20 && n <= 500 ? n : 100;
      });
      const [selected, setSelected] = useState([]);
      const [expandedHash, setExpandedHash] = useState(null);
      const [detail, setDetail] = useState(null);
      const [detailLoading, setDetailLoading] = useState(false);
      const [error, setError] = useState('');
      const [loadingMore, setLoadingMore] = useState(false);
      const [showTags, setShowTags] = useState(() => store.get('showTags', '1') !== '0');
      const [status, setStatus] = useState(null);
      const [statusOpen, setStatusOpen] = useState(false);
      const [rowMenu, setRowMenu] = useState(null);
      const [workMenu, setWorkMenu] = useState(null);
      const [commitOpen, setCommitOpen] = useState(false);
      const [commitMsg, setCommitMsg] = useState('');
      const [busy, setBusy] = useState(false);
      const [expandedRefs, setExpandedRefs] = useState('');
      // Window/pane resizing must re-layout (vh-based height caps re-evaluate).
      const [, forceRender] = useState(0);
      useEffect(() => {
        const onResize = () => forceRender((n) => n + 1);
        window.addEventListener('resize', onResize);
        return () => window.removeEventListener('resize', onResize);
      }, []);
      useEffect(() => { store.set('scope', scopeMode); }, [scopeMode]);
      useEffect(() => { store.set('pageSize', pageSize); }, [pageSize]);
      useEffect(() => { store.set('showTags', showTags ? '1' : '0'); }, [showTags]);
      const scopeModeRef = useRef(scopeMode);
      const selectedRef = useRef(selected);
      useEffect(() => { scopeModeRef.current = scopeMode; }, [scopeMode]);
      useEffect(() => { selectedRef.current = selected; }, [selected]);
      const selectedKey = selected.join(',');

      // Rebuild graph request params INSIDE load (reads the just-fetched
      // branches + latest refs), so load never depends on state it mutates.
      const load = useCallback(async () => {
        if (!sessionId) return;
        setPhase('loading');
        setError('');
        try {
          const init = await apiPost('init', sessionId);
          if (!init.isRepo) { setPhase('not-repo'); return; }
          const [b, st] = await Promise.all([
            apiPost('branches', sessionId),
            apiPost('status', sessionId).catch(() => null),
          ]);
          setBranches(b);
          setStatus(st && Array.isArray(st.entries) ? st : { entries: [] });
          let params;
          if (scopeModeRef.current === 'all') {
            params = selectedRef.current.length > 0 ? { revs: [...selectedRef.current] } : { all: true };
          } else {
            const cur = b.current ?? '';
            const up = b.upstreamOf?.[cur] ?? '';
            const revs = [cur, up].filter((x) => x !== '');
            params = revs.length > 0 ? { revs } : { revs: ['HEAD'] };
          }
          const g = await apiPost('graph', sessionId, params);
          setRows(g.rows);
          setEnded(g.ended);
          setPhase('ready');
        } catch (err) {
          if (err?.code === 'git-missing') { setPhase('git-missing'); return; }
          setPhase('error');
          setError(err?.message ?? String(err));
        }
      }, [sessionId]);

      // Reload when the tab becomes visible or the filter parameters change;
      // `branches` is NOT a dependency (load sets it, would re-trigger).
      useEffect(() => { if (visible) load(); }, [visible, load, scopeMode, selectedKey]);

      useEffect(() => {
        if (expandedHash === null || !sessionId) { setDetail(null); return; }
        setDetailLoading(true);
        const controller = new AbortController();
        apiPost('commit', sessionId, { hash: expandedHash }, controller.signal)
          .then((d) => setDetail(d))
          .catch((err) => { if (err?.name !== 'AbortError') setError(err?.message ?? String(err)); })
          .finally(() => setDetailLoading(false));
        return () => controller.abort();
      }, [expandedHash, sessionId]);

      const toggleBranch = (name) => {
        setSelected((prev) => (prev.includes(name) ? prev.filter((x) => x !== name) : [...prev, name]));
      };
      const toggleRow = (hash) => {
        setExpandedHash((prev) => (prev === hash ? null : hash));
        if (expandedHash !== hash) {
          const row = rows.find((r) => r.oid === hash);
          setExpandedRefs(row?.refs ?? '');
        }
      };

      // ── write operations (staging / committing) ──
      const refreshStatus = async () => {
        try { const s = await apiPost('status', sessionId); setStatus(s); } catch { /* ignore */ }
      };
      const copy = (text) => { try { primitives.writeClipboard(text); } catch { /* ignore */ } };
      const runWrite = async (fn) => {
        setBusy(true);
        try { await fn(); await refreshStatus(); await load(); setError(''); }
        catch (err) { setError(err?.message ?? String(err)); }
        finally { setBusy(false); }
      };
      const doStage = (path) => runWrite(() => apiPost('stage', sessionId, path ? { path } : {}));
      const doUnstage = (path) => runWrite(() => apiPost('unstage', sessionId, path ? { path } : {}));
      const doDiscard = (path) => runWrite(() => apiPost('discard', sessionId, { path }));
      const doDiscardAll = () => {
        const entries = status?.entries ?? [];
        const targets = entries.filter((en) => {
          const y = en.xy[1];
          return y !== undefined && y !== ' ' && y !== '?';
        });
        runWrite(async () => { for (const en of targets) await apiPost('discard', sessionId, { path: en.path }); });
      };
      const doCommit = async () => {
        const msg = commitMsg.trim();
        if (!msg || busy) return;
        await runWrite(() => apiPost('wcommit', sessionId, { message: msg }));
        setCommitMsg('');
        setStatusOpen(false);
      };
      const onWorkAction = (e) => {
        const v = e.target.value;
        e.target.value = '';
        if (v === 'refresh') { refreshStatus(); load(); }
        else if (v === 'stageAll') doStage(undefined);
        else if (v === 'unstageAll') doUnstage(undefined);
        else if (v === 'discardAll') doDiscardAll();
        else if (v === 'commit') { setStatusOpen(true); }
      };
      const openCommitDiffTab = (row) => {
        onOpenDiff?.({
          id: `diff:c:${row.oid}`,
          type: 'diff',
          title: `${row.oid.slice(0, 7)} ${row.subject}`,
          diff: { kind: 'commit', hash: row.oid.slice(0, 7), hashFull: row.oid, subject: row.subject },
        });
      };
      const loadMore = async () => {
        if (loadingMore || ended) return;
        setLoadingMore(true);
        try {
          let params;
          if (scopeModeRef.current === 'all') {
            params = selectedRef.current.length > 0 ? { revs: [...selectedRef.current] } : { all: true };
          } else {
            const cur = branches?.current ?? '';
            const up = branches?.upstreamOf?.[cur] ?? '';
            const revs = [cur, up].filter((x) => x !== '');
            params = revs.length > 0 ? { revs } : { revs: ['HEAD'] };
          }
          const g = await apiPost('graph', sessionId, { ...params, skip: rows.length, limit: pageSize });
          setRows((prev) => [...prev, ...g.rows]);
          setEnded(g.ended);
        } catch (err) { setError(err?.message ?? String(err)); }
        finally { setLoadingMore(false); }
      };

      const lanes = useMemo(() => assignLanes(rows), [rows]);
      // Per-branch color for multi-branch filtering: each selected branch gets
      // a stable palette color; rows belonging to one show it on the node icon.
      const branchColors = useMemo(() => {
        const m = new Map();
        [...selected].forEach((name, i) => m.set(name, LANE_COLORS[i % LANE_COLORS.length]));
        return m;
      }, [selected]);
      const branchColorOf = (row) => {
        for (const ref of refNames(row.refs)) {
          const c = branchColors.get(ref);
          if (c) return c;
        }
        return null;
      };

      const renderStatusGroup = (staged) => {
        const entries = (status?.entries ?? []).filter((en) => {
          const x = en.xy[0];
          const y = en.xy[1];
          if (staged) return x !== undefined && x !== ' ' && x !== '?';
          if (en.xy === '??') return true;
          return y !== undefined && y !== ' ' && y !== '?';
        });
        if (entries.length === 0) return null;
        return h(Fragment, null,
          h('div', { className: 'sgg-wt-group' }, staged ? t('staged') : t('unstaged')),
          entries.map((en) => h('div', { key: en.path, className: 'sgg-wt-file' },
            h('span', { className: 'sgg-wt-badge' }, badgeOf(en)),
            h('span', { className: 'sgg-wt-path', title: en.path }, en.path),
            h('button', {
              type: 'button', className: 'sgg-iconbtn', title: staged ? t('unstage') : t('stage'),
              'aria-label': staged ? t('unstage') : t('stage'), disabled: busy,
              onClick: () => (staged ? doUnstage(en.path) : doStage(en.path)),
            }, h(primitives.IconBranchOutline16, { size: 13 })),
            h('button', {
              type: 'button', className: 'sgg-iconbtn', title: t('discard'), 'aria-label': t('discard'),
              disabled: busy || en.xy === '??',
              onClick: () => doDiscard(en.path),
            }, '✕'),
          )),
        );
      };
      const stagedCount = (status?.entries ?? []).filter((en) => {
        const x = en.xy[0];
        return x !== undefined && x !== ' ' && x !== '?';
      }).length;

      let body;
      if (phase === 'loading') body = h('div', { className: 'sgg-empty' }, t('loading'));
      else if (phase === 'not-repo') body = h('div', { className: 'sgg-empty' }, t('notRepo'));
      else if (phase === 'git-missing') body = h('div', { className: 'sgg-error' }, t('gitMissing'));
      else if (phase === 'error') body = h('div', { className: 'sgg-error' },
        `${t('error')}: ${error}`, ' ',
        h('button', { className: 'sgg-link', onClick: load }, t('retry')));
      else body = h(Fragment, null,
        h(BranchTree, { branches, scopeMode, selected, onToggleBranch: toggleBranch, currentBranch: branches.current, branchColors }),
        rows.length === 0
          ? h('div', { className: 'sgg-empty' }, t('noCommits'))
          : h('div', { className: 'sgg-list' },
              h('div', { className: 'sgg-wt' },
                h('div', {
                  className: 'sgg-wt-head', role: 'button', tabIndex: 0,
                  onClick: () => setStatusOpen(!statusOpen),
                  onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setStatusOpen(!statusOpen); } },
                  onContextMenu: (e) => { e.preventDefault(); e.stopPropagation(); setWorkMenu({ x: e.clientX, y: e.clientY }); },
                },
                  h('span', { className: 'sgg-wt-caret' }, statusOpen ? '▾' : '▸'),
                  h('span', { className: 'sgg-wt-icon' }, '◍'),
                  h('span', { className: 'sgg-wt-title' }, t('worktreeArea')),
                  status && status.entries.length > 0
                    ? h('span', { className: 'sgg-wt-info' }, `${t('staged')} ${stagedCount} · ${t('unstaged')} ${status.entries.length - stagedCount}`)
                    : h('span', { className: 'sgg-wt-info sgg-wt-clean' }, t('worktreeClean')),
                ),
                statusOpen && h('div', { className: 'sgg-wt-body' },
                  status && status.entries.length > 0
                    ? h(Fragment, null,
                        renderStatusGroup(true),
                        renderStatusGroup(false),
                      )
                    : h('div', { className: 'sgg-wt-empty' }, t('worktreeCleanHint')),
                  h('div', { className: 'sgg-commit-row' },
                    h('input', {
                      className: 'sgg-commit-input', value: commitMsg, placeholder: t('commitPlaceholder'), disabled: busy,
                      onChange: (e) => setCommitMsg(e.target.value),
                      onKeyDown: (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') doCommit(); },
                    }),
                    h('button', { className: 'sgg-commit-btn', disabled: busy || commitMsg.trim() === '' || stagedCount === 0, onClick: doCommit }, t('commit')),
                  ),
                ),
              ),
              rows.map((row, i) => h(GraphRow, {
                key: row.oid,
                row,
                lane: lanes[i],
                branch: branches.current,
                open: expandedHash === row.oid,
                branchColor: branchColorOf(row),
                showTags,
                onContextMenu: setRowMenu,
                onToggle: () => toggleRow(row.oid),
              })),
              !ended && h('button', { className: 'sgg-more', onClick: loadMore, disabled: loadingMore },
                loadingMore ? t('loading') : t('loadMore')),
            ),
        error && h('div', { className: 'sgg-error' }, error),
        detail && h(CommitDetail, {
          key: detail.hash, detail, branch: branches.current, onOpenDiff,
          refsRaw: expandedRefs,
          onClose: () => setExpandedHash(null),
        }),
        detailLoading && h('div', { className: 'sgg-empty' }, t('loading')),
        h(primitives.Menu, {
          open: rowMenu !== null,
          onClose: () => setRowMenu(null),
          items: [
            { id: 'expand', label: t('expand'), onClick: () => { toggleRow(rowMenu.row.oid); setRowMenu(null); } },
            { id: 'diff', label: t('viewDiff'), onClick: () => { openCommitDiffTab(rowMenu.row); setRowMenu(null); } },
            { id: 'copyShort', label: t('copyShortHash'), icon: h(primitives.IconCopyOutline16, { size: 14 }), onClick: () => { copy(rowMenu.row.oid.slice(0, 7)); setRowMenu(null); } },
            { id: 'copyFull', label: t('copyFullHash'), icon: h(primitives.IconCopyOutline16, { size: 14 }), onClick: () => { copy(rowMenu.row.oid); setRowMenu(null); } },
            { id: 'copySubject', label: t('copySubject'), icon: h(primitives.IconCopyOutline16, { size: 14 }), onClick: () => { copy(rowMenu.row.subject); setRowMenu(null); } },
          ],
          getAnchorRect: () => (rowMenu === null ? null : new DOMRect(rowMenu.x, rowMenu.y, 0, 0)),
        }),
        h(primitives.Menu, {
          open: workMenu !== null,
          onClose: () => setWorkMenu(null),
          items: [
            { id: 'refresh', label: t('refresh'), onClick: () => { refreshStatus(); load(); setWorkMenu(null); } },
            { id: 'stageAll', label: t('stageAll'), onClick: () => { doStage(undefined); setWorkMenu(null); } },
            { id: 'unstageAll', label: t('unstageAll'), onClick: () => { doUnstage(undefined); setWorkMenu(null); } },
            { id: 'discardAll', label: t('discardAll'), onClick: () => { doDiscardAll(); setWorkMenu(null); } },
            { id: 'commit', label: t('commit'), onClick: () => { setCommitOpen(true); setWorkMenu(null); } },
          ],
          getAnchorRect: () => (workMenu === null ? null : new DOMRect(workMenu.x, workMenu.y, 0, 0)),
        }),
      );

      return h('div', { 'data-dsh-plugin': 'dsh-shinki-git-graph', style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, overflow: 'hidden' } },
        h('div', { className: 'sgg-header' },
          h('select', {
            className: 'sgg-scope',
            value: scopeMode,
            title: t('scope'),
            onChange: (e) => setScopeMode(e.target.value),
          },
            h('option', { value: 'current-upstream' }, t('scopeCurUp')),
            h('option', { value: 'all' }, t('scopeAll')),
          ),
          h('select', {
            className: 'sgg-work',
            value: '',
            title: t('workAction'),
            onChange: onWorkAction,
          },
            h('option', { value: '' }, '⋯'),
            h('option', { value: 'refresh' }, t('refresh')),
            h('option', { value: 'stageAll' }, t('stageAll')),
            h('option', { value: 'unstageAll' }, t('unstageAll')),
            h('option', { value: 'discardAll' }, t('discardAll')),
            h('option', { value: 'commit' }, t('commit')),
          ),
          h('button', {
            type: 'button', className: 'sgg-iconbtn', title: t('showTags'), 'aria-label': t('showTags'),
            onClick: () => setShowTags(!showTags),
            style: showTags ? { color: 'var(--dsw-alias-brand-primary,#4d9fff)' } : null,
          }, '🏷'),
          h('span', { className: 'sgg-ver', title: 'plugin bundle version' }, `v${PLUGIN_VERSION}`),
          h('button', {
            type: 'button', className: 'sgg-iconbtn', title: t('refresh'), 'aria-label': t('refresh'),
            onClick: load, disabled: phase === 'loading',
          }, h(primitives.IconRefreshOutline16, { size: 14 })),
        ),
        body,
      );
    }

    // ── plugin body ──────────────────────────────────────────────────────
    // Cordis inject: property access without an inject declaration is
    // rejected ("cannot get property without inject"). `betterSidebar` is
    // provided by dsh-better-sidebar's client half.
    const PLUGIN_VERSION = '0.4.0';
    const inject = ['locale', 'betterSidebar'];
    const name = 'dsh-shinki-git-graph';

    function apply(ctx) {
      injectCss();
      try { ctx.locale?.register?.(NS, { zh, en }); } catch { /* locale optional */ }
      const service = ctx?.betterSidebar ?? (typeof ctx.get === 'function' ? ctx.get('betterSidebar') : undefined);
      if (!service || typeof service.registerTab !== 'function') {
        console.warn('[dsh-shinki-git-graph] ctx.betterSidebar 不可用（需安装 dsh-better-sidebar），侧边栏 Tab 未注册');
        return;
      }
      let disposers = [];
      const off = service.registerTab({
        id: 'dsh-shinki-git-graph',
        title: () => t('tabTitle'),
        icon: (size) => h(primitives.IconBranchOutline16, { size }),
        order: 25,
        single: true,
        component: (props) => h(GitGraphTab, {
          ctx,
          scope: props.scope,
          visible: props.visible,
          onOpenDiff: props.onOpenDiff,
        }),
      });
      disposers.push(off);
      ctx.effect?.(() => () => { for (const d of disposers) d(); }, 'dsh-shinki-git-graph: sidebar tab');
    }

    exports.name = name;
    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  },
});
