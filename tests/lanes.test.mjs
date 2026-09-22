/**
 * 泳道分配语义（`lib/lanes.js` 兼容入口 → `lib/graph-layout.js`）。
 *
 * v0.9.0 起 `columns` 是 layoutGraph 的**字形摘要**：分叉/合并的另一侧不再画成
 * 断线（旧 'gap'），那一段现在是从行顶斜插进节点的曲线，摘要里算作 'pass'
 * （该列确实有线）。曲线几何本身在 tests/graph-layout.test.mjs 里断言。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assignLanes } from '../lib/lanes.js';

test('线性历史：单泳道', () => {
  // c3 -> c2 -> c1（新的在前）
  const rows = [
    { oid: 'c3', parents: ['c2'] },
    { oid: 'c2', parents: ['c1'] },
    { oid: 'c1', parents: [] },
  ];
  const lanes = assignLanes(rows);
  assert.equal(lanes.length, 3);
  assert.deepEqual(lanes[0].columns, ['node']);
  assert.deepEqual(lanes[1].columns, ['node']);
  assert.deepEqual(lanes[2].columns, ['node']);
  assert.equal(lanes[0].merge, false);
});

test('分叉：第二个父开启右侧泳道，汇合行的另一侧算 pass（不再是断线 gap）', () => {
  //        c3 (feature 顶)
  //       /
  // c2 -- c1 (main 顶)
  const rows = [
    { oid: 'c3', parents: ['c1'] },
    { oid: 'c2', parents: ['c1'] },
    { oid: 'c1', parents: [] },
  ];
  const lanes = assignLanes(rows);
  assert.deepEqual(lanes[0].columns, ['node']);
  assert.deepEqual(lanes[1].columns, ['pass', 'node']);
  // c1：lane0 是节点；lane1 是「另一个也在等 c1」的泳道 —— v0.9.0 起
  // 它画成斜插进节点的曲线，所以摘要为 pass（旧版本此处是 gap 断线）。
  assert.deepEqual(lanes[2].columns, ['node', 'pass']);
});

test('合并：merge 节点带两条以上泳道', () => {
  //        c4 (merge)
  //       / \
  // c2 --    c3
  //       \ /
  //        c1
  const rows = [
    { oid: 'c4', parents: ['c2', 'c3'] },
    { oid: 'c3', parents: ['c1'] },
    { oid: 'c2', parents: ['c1'] },
    { oid: 'c1', parents: [] },
  ];
  const lanes = assignLanes(rows);
  assert.equal(lanes[0].merge, true);
  assert.ok(lanes[0].columns.includes('merge'));
  assert.equal(lanes.length, 4);
});

test('分页断开：父不在本页时泳道仍指向它（tail 带走）', () => {
  const rows = [
    { oid: 'c5', parents: ['c4'] },
    { oid: 'c4', parents: ['c3'] },
  ];
  const lanes = assignLanes(rows);
  assert.deepEqual(lanes[0].columns, ['node']);
  assert.equal(lanes[1].columns.length, 1);
  assert.deepEqual(lanes.tail, ['c3']);
});

test('跨页续接：第二页继承上一页 tail，泳道不断开', () => {
  const page1 = [
    { oid: 'c4', parents: ['c3'] },
  ];
  const m1 = assignLanes(page1);
  assert.deepEqual(m1[0].columns, ['node']);
  assert.deepEqual(m1.tail, ['c3'], 'tail 应保留未消费的父提交');

  const page2 = [
    { oid: 'c3', parents: ['c2'] },
    { oid: 'c2', parents: ['c1'] },
    { oid: 'c1', parents: [] },
  ];
  const m2 = assignLanes(page2, m1.tail);
  assert.equal(m2.length, 3);
  assert.deepEqual(m2[0].columns, ['node'], '第一行应接续父 lane 为 node');
  assert.deepEqual(m2[1].columns, ['node']);
  assert.deepEqual(m2[2].columns, ['node']);
  assert.deepEqual(m2.tail, [], '线性收尾后 tail 应为空');
});

test('跨页续接：多泳道时未消费的 pending 保持 pass 线到底', () => {
  const page1 = [
    { oid: 'c4', parents: ['c2'] },
    { oid: 'c3', parents: ['c2'] },
  ];
  const m1 = assignLanes(page1);
  assert.deepEqual(m1[0].columns, ['node']);
  assert.deepEqual(m1[1].columns, ['pass', 'node']);
  assert.ok(m1.tail.includes('c2'), 'tail 应包含 c2（下一页要消费）');

  const page2 = [
    { oid: 'c2', parents: ['c1'] },
  ];
  const m2 = assignLanes(page2, m1.tail);
  // c2 在第一页有两条泳道同时在等它 → 本行一条是节点、另一条斜插进来（pass）。
  assert.deepEqual(m2[0].columns, ['node', 'pass'], 'c2 应接续第一页的泳道');
});

test('跨页续接：tail 中本页不消费的 pending 仍画 pass（不顶部断开）', () => {
  const page1 = [
    { oid: 'c4', parents: ['c3'] },
    { oid: 'c3', parents: ['c2'] },
  ];
  const m1 = assignLanes(page1);
  assert.deepEqual(m1.tail, ['c2']);

  const page2 = [
    { oid: 'c5', parents: [] },
  ];
  const m2 = assignLanes(page2, m1.tail);
  assert.deepEqual(m2[0].columns, ['pass', 'node'], 'carried c2 应画 pass，新节点 c5 开右侧 lane');
});
