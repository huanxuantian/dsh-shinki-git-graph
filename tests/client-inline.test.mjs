/**
 * 内联同步单测：client.js 里的图谱布局内联区必须与 lib/graph-layout.js 逐字一致。
 * 漂移即失败（跑 `node tool/plugin-sync/inline-git-graph-layout.mjs` 重新生成）。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { extractRegion, inlinedBody, strippedBody } from '../../../../tool/plugin-sync/inline-git-graph-layout.mjs';

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLIENT = join(PLUGIN, 'lib', 'client.js');
const SOURCE = join(PLUGIN, 'lib', 'graph-layout.js');

test('client.js 内联区与 lib/graph-layout.js 完全一致', () => {
  const client = readFileSync(CLIENT, 'utf8');
  assert.equal(
    extractRegion(client),
    strippedBody(),
    '内联区已漂移：请运行 node tool/plugin-sync/inline-git-graph-layout.mjs',
  );
});

test('内联区带 4 空格缩进、非空、且不残留 ESM/Node 依赖', () => {
  const body = inlinedBody();
  assert.ok(body.length > 4000);
  assert.ok(body.split('\n').every((line) => line === '' || line.startsWith('    ')));
  assert.ok(!/^export /m.test(body));
  assert.ok(!/require\(|from 'node:|process\.env/.test(body), '内联区不应依赖 Node API');
  assert.ok(!/require\(|from 'node:|process\.env/.test(readFileSync(SOURCE, 'utf8')), 'lib/graph-layout.js 不应依赖 Node API');
});

test('client.js 里确实使用了内联的图谱符号（没退化成旧的字符泳道）', () => {
  const client = readFileSync(CLIENT, 'utf8');
  for (const needle of ['layoutGraph', 'primPath', 'nodeShape', 'laneWidth', 'nodeRadius', 'NODE_Y', 'ROW_H', 'PALETTE']) {
    assert.ok(client.includes(needle), `client.js 缺少内联符号 ${needle}`);
  }
  // 旧实现的两处特征必须消失：字符泳道样式与内联 assignLanes 调用
  assert.ok(!client.includes('sgg-glyph'), '旧的字符泳道 CSS 不应残留');
  assert.ok(!/setLaneMaps\(assignLanes\(/.test(client), '客户端不应再直接调 assignLanes');
});
