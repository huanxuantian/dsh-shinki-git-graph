/**
 * 内联同步单测：client.js 里的图谱布局内联区必须与 lib/graph-layout.js 逐字一致。
 *
 * 为什么有这条守卫：浏览器半包（lib/client.js）不能 require 兄弟文件，所以布局/配色/
 * 曲线几何（lib/graph-layout.js，**唯一真源**）要在 client.js 的标记区里放一份逐字副本。
 * 两份一旦漂移，就会出现「宿主单测跑的是 A、界面画的是 B」这类极难排查的问题。
 *
 * 本文件自带内联区的抽取/生成实现（不依赖任何仓库外的脚本）：
 *  - `strippedBody()`  → 真源正文（去掉 ESM `export ` 前缀）
 *  - `inlinedBody()`   → 写入形态（正文统一缩进 4 空格）
 *  - `extractRegion()` → 从 client.js 抽出标记区内容（去掉 4 空格缩进）
 * 三者都先按 **LF 归一化**：Windows 检出（core.autocrlf）下两个文件都是 CRLF，
 * 若按 `\n` 切行，内联区首行会多出一个 `\r`，造成「内容其实一致但校验报漂移」的误报。
 *
 * 漂移时怎么改：以 lib/graph-layout.js 为真源，手工同步 client.js 中
 * `//#region INLINE:lib/graph-layout.js` 与 `//#endregion …` 之间的内容
 * （正文每行 +4 空格、去掉 `export ` 前缀），然后本测试即为验收。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLIENT = join(PLUGIN, 'lib', 'client.js');
const SOURCE = join(PLUGIN, 'lib', 'graph-layout.js');

const BEGIN = '    //#region INLINE:lib/graph-layout.js';
const END = '    //#endregion INLINE:lib/graph-layout.js';

/** 统一按 LF 比较/生成（见文件头说明）。 */
const toLF = (text) => text.replace(/\r\n/g, '\n');

/** 真源正文：去掉 ESM `export ` 前缀（浏览器包里是同一函数作用域内的声明）。 */
function strippedBody() {
  return toLF(readFileSync(SOURCE, 'utf8')).replace(/^export /gm, '').replace(/\s+$/, '');
}

/** 写入形态：正文统一缩进 4 空格，便于在 factory 函数内阅读。 */
function inlinedBody() {
  return strippedBody()
    .split('\n')
    .map((line) => (line === '' ? '' : `    ${line}`))
    .join('\n');
}

/** 抽出 client.js 里的标记区内容（去掉统一 4 空格缩进）。 */
function extractRegion(clientSource) {
  const client = toLF(clientSource);
  const b = client.indexOf(BEGIN);
  const e = client.indexOf(END);
  if (b === -1 || e === -1 || e < b) throw new Error(`client.js 缺少 ${BEGIN} / ${END} 标记`);
  const inner = client.slice(b + BEGIN.length, e);
  return inner
    .split('\n')
    .map((line) => (line.startsWith('    ') ? line.slice(4) : line))
    .join('\n')
    .replace(/^\n+/, '')
    .replace(/\s+$/, '');
}

test('client.js 内联区与 lib/graph-layout.js 完全一致', () => {
  const client = readFileSync(CLIENT, 'utf8');
  assert.equal(
    extractRegion(client),
    strippedBody(),
    '内联区已漂移：请按 lib/graph-layout.js 手工同步 client.js 的 INLINE 标记区',
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
