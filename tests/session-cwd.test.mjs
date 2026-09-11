/**
 * sessionCwd resolution chain: live session store -> persisted session headers
 * -> workspace ledger.
 *
 * The live store (`ctx.sessions`) is an in-memory map of the sessions currently
 * OPEN in this instance, so a workspace whose session is not attached yet used
 * to answer `session-not-found` (404) even though its header on disk has a
 * perfectly good cwd — that is the A571 report this covers.
 *
 * Run the file directly (`node tests/session-cwd.test.mjs`): node:test then
 * executes in-process, which matters under the DSH file sandbox (child-process
 * stdio pipes are denied, so `node --test` cannot spawn per-file children).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sessionCwd, resetSessionCwdCache } from '../lib/git-service.js';

const liveDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sgg-live-')));
const diskDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sgg-disk-')));
const wsDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sgg-ws-')));
const goneDir = path.join(os.tmpdir(), 'sgg-does-not-exist-4c1f');

/** A fake host context; `calls` counts sessionQuery scans. */
function fakeCtx({ live = {}, persisted = [], workspaces = [], services = true } = {}) {
  const calls = { listSessions: 0 };
  return {
    calls,
    ctx: {
      sessions: { get: (id) => live[id] },
      get: (name) => {
        if (!services) return undefined;
        if (name === 'sessionQuery') {
          return { listSessions: async () => { calls.listSessions += 1; return persisted; } };
        }
        if (name === 'workspaceRegistry') return { list: () => workspaces };
        return undefined;
      },
    },
  };
}

test('live session header resolves and wins over persistence', async () => {
  resetSessionCwdCache();
  const { ctx } = fakeCtx({
    live: { 's-live': { header: { cwd: liveDir } } },
    persisted: [{ header: { id: 's-live', cwd: diskDir } }],
  });
  assert.equal(await sessionCwd(ctx, 's-live'), liveDir);
});

test('session that is NOT open still resolves from its persisted header (A571 case)', async () => {
  resetSessionCwdCache();
  const { ctx } = fakeCtx({ persisted: [{ header: { id: 's-disk', cwd: diskDir } }] });
  assert.equal(await sessionCwd(ctx, 's-disk'), diskDir);
});

test('falls back to the workspace ledger when no header is available', async () => {
  resetSessionCwdCache();
  const { ctx } = fakeCtx({ workspaces: [{ path: wsDir, sessionIds: ['s-ws'] }] });
  assert.equal(await sessionCwd(ctx, 's-ws'), wsDir);
});

test('unknown session id resolves to null', async () => {
  resetSessionCwdCache();
  const { ctx } = fakeCtx({ persisted: [{ header: { id: 'other', cwd: diskDir } }] });
  assert.equal(await sessionCwd(ctx, 's-unknown'), null);
});

test('degrades to the live store when the optional services are absent', async () => {
  resetSessionCwdCache();
  const { ctx } = fakeCtx({ services: false, persisted: [{ header: { id: 's-disk', cwd: diskDir } }] });
  assert.equal(await sessionCwd(ctx, 's-disk'), null);
});

test('a non-existent directory is refused from every source', async () => {
  resetSessionCwdCache();
  const { ctx } = fakeCtx({
    live: { 's-gone': { header: { cwd: goneDir } } },
    persisted: [{ header: { id: 's-gone', cwd: goneDir } }],
    workspaces: [{ path: goneDir, sessionIds: ['s-gone'] }],
  });
  assert.equal(await sessionCwd(ctx, 's-gone'), null);
});

test('empty / non-string session ids resolve to null', async () => {
  resetSessionCwdCache();
  const { ctx } = fakeCtx();
  assert.equal(await sessionCwd(ctx, ''), null);
  assert.equal(await sessionCwd(ctx, undefined), null);
  assert.equal(await sessionCwd(ctx, 42), null);
});

test('resolved and unresolved ids are cached (one disk scan per id)', async () => {
  resetSessionCwdCache();
  const { ctx, calls } = fakeCtx({ persisted: [{ header: { id: 's-cache', cwd: diskDir } }] });
  assert.equal(await sessionCwd(ctx, 's-cache'), diskDir);
  assert.equal(await sessionCwd(ctx, 's-cache'), diskDir);
  assert.equal(await sessionCwd(ctx, 's-miss'), null);
  assert.equal(await sessionCwd(ctx, 's-miss'), null);
  assert.equal(calls.listSessions, 2, 'one scan for the hit, one for the miss');
});