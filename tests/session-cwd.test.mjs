/**
 * Working-directory resolution for the /shinki-git routes.
 *
 * The host resolves a session's cwd itself. Sources, in order of trust:
 *   1. the live session store (`ctx.sessions`) — an in-memory map of the
 *      sessions currently OPEN in this instance, which is why a workspace whose
 *      session is not attached used to answer `session-not-found` (404) even
 *      though its header on disk has a perfectly good cwd (the A571 report);
 *   2. persisted session headers on disk (`sessionQuery.listSessions()`);
 *   3. the workspace ledger (`workspaceRegistry.list()`), session id -> path;
 *   4. better-sidebar's `scope.cwd`, accepted ONLY when it matches a workspace
 *      path in that same ledger (membership check; fails closed).
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
import { resolveSessionCwd, sessionCwd, resetSessionCwdCache } from '../lib/git-service.js';

const liveDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sgg-live-')));
const diskDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sgg-disk-')));
const wsDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sgg-ws-')));
const otherDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sgg-other-')));
const goneDir = path.join(os.tmpdir(), 'sgg-does-not-exist-4c1f');

/** A fake host context; `calls` counts sessionQuery scans. */
function fakeCtx({ live = {}, persisted = [], workspaces = [], sessionQuery = true, workspaceRegistry = true } = {}) {
  const calls = { listSessions: 0 };
  return {
    calls,
    ctx: {
      sessions: { get: (id) => live[id] },
      get: (name) => {
        if (name === 'sessionQuery' && sessionQuery) {
          return { listSessions: async () => { calls.listSessions += 1; return persisted; } };
        }
        if (name === 'workspaceRegistry' && workspaceRegistry) return { list: () => workspaces };
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
  const r = await resolveSessionCwd(ctx, 's-live');
  assert.equal(r.cwd, liveDir);
  assert.equal(r.source, 'live');
});

test('session that is NOT open still resolves from its persisted header (A571 case)', async () => {
  resetSessionCwdCache();
  const { ctx } = fakeCtx({ persisted: [{ header: { id: 's-disk', cwd: diskDir } }] });
  const r = await resolveSessionCwd(ctx, 's-disk');
  assert.equal(r.cwd, diskDir);
  assert.equal(r.source, 'persisted');
});

test('falls back to the workspace ledger when no header is available', async () => {
  resetSessionCwdCache();
  const { ctx } = fakeCtx({ workspaces: [{ path: wsDir, sessionIds: ['s-ws'] }] });
  const r = await resolveSessionCwd(ctx, 's-ws');
  assert.equal(r.cwd, wsDir);
  assert.equal(r.source, 'workspace');
});

test('unknown session id reports session-unknown', async () => {
  resetSessionCwdCache();
  const { ctx } = fakeCtx({ persisted: [{ header: { id: 'other', cwd: diskDir } }] });
  const r = await resolveSessionCwd(ctx, 's-unknown');
  assert.equal(r.cwd, null);
  assert.equal(r.reason, 'session-unknown');
});

test('degrades to the live store when the optional services are absent', async () => {
  resetSessionCwdCache();
  const { ctx } = fakeCtx({
    persisted: [{ header: { id: 's-disk', cwd: diskDir } }],
    workspaces: [{ path: wsDir, sessionIds: ['s-disk'] }],
    sessionQuery: false,
    workspaceRegistry: false,
  });
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

test('a known session whose workspace vanished reports workspace-missing', async () => {
  resetSessionCwdCache();
  const { ctx } = fakeCtx({ live: { 's-gone': { header: { cwd: goneDir } } } });
  const r = await resolveSessionCwd(ctx, 's-gone');
  assert.equal(r.cwd, null);
  assert.equal(r.reason, 'workspace-missing');
  assert.equal(r.detail, goneDir);
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

test('a client cwd hint is accepted for a path the ledger knows as a workspace', async () => {
  resetSessionCwdCache();
  const { ctx } = fakeCtx({ workspaces: [{ path: wsDir, sessionIds: ['someone-else'] }] });
  const r = await resolveSessionCwd(ctx, 'session-not-indexed-yet', wsDir);
  assert.equal(r.cwd, wsDir);
  assert.equal(r.reason, 'ok');
  assert.equal(r.source, 'client');
});

test('a client cwd hint is rejected when it is not a workspace path', async () => {
  resetSessionCwdCache();
  const { ctx } = fakeCtx({ workspaces: [{ path: wsDir, sessionIds: ['someone-else'] }] });
  const r = await resolveSessionCwd(ctx, 'session-not-indexed-yet', otherDir);
  assert.equal(r.cwd, null);
  assert.equal(r.reason, 'session-unknown');
});

test('a client cwd hint fails closed when the ledger is unavailable', async () => {
  resetSessionCwdCache();
  const { ctx } = fakeCtx({ workspaceRegistry: false, sessionQuery: false });
  const r = await resolveSessionCwd(ctx, 'session-not-indexed-yet', wsDir);
  assert.equal(r.cwd, null);
  assert.equal(r.reason, 'session-unknown');
});

test('a client cwd hint never overrides an authoritative source', async () => {
  resetSessionCwdCache();
  const { ctx } = fakeCtx({
    live: { 's-live': { header: { cwd: liveDir } } },
    workspaces: [{ path: wsDir, sessionIds: ['s-live'] }],
  });
  const r = await resolveSessionCwd(ctx, 's-live', wsDir);
  assert.equal(r.cwd, liveDir);
  assert.equal(r.source, 'live');
});