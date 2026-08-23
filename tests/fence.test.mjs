import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFence, isLoopbackAddress, hostnameOf, isLoopbackHost } from '../lib/trust-fence.js';

test('hostnameOf 去掉端口/括号', () => {
  assert.equal(hostnameOf('127.0.0.1:3080'), '127.0.0.1');
  assert.equal(hostnameOf('localhost'), 'localhost');
  assert.equal(hostnameOf('[::1]:3080'), '[::1]');
  assert.equal(hostnameOf(''), '');
});

test('isLoopbackAddress', () => {
  assert.equal(isLoopbackAddress('127.0.0.1'), true);
  assert.equal(isLoopbackAddress('::1'), true);
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true);
  assert.equal(isLoopbackAddress('192.168.1.5'), false);
});

test('isLoopbackHost', () => {
  assert.equal(isLoopbackHost('127.0.0.1:3080'), true);
  assert.equal(isLoopbackHost('localhost'), true);
  assert.equal(isLoopbackHost('evil.example.com'), false);
});

test('fence：回环 socket 放行', () => {
  const fence = createFence({ webRuntime: { trustedHosts: [] } });
  const req = { socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:3080' } };
  assert.equal(fence.check(req).ok, true);
});

test('fence：非回环 socket 无白名单拒绝', () => {
  const fence = createFence({ webRuntime: { trustedHosts: [] } });
  const req = { socket: { remoteAddress: '192.168.1.5' }, headers: { host: 'dsh.local' } };
  assert.equal(fence.check(req).ok, false);
});

test('fence：非回环 socket 命中 trusted-host 放行', () => {
  const fence = createFence({ webRuntime: { trustedHosts: ['dsh.local'] } });
  const req = { socket: { remoteAddress: '192.168.1.5' }, headers: { host: 'dsh.local:3080' } };
  assert.equal(fence.check(req).ok, true);
});
