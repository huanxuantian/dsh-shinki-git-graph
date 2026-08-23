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

test('分叉：第二个父开启右侧泳道', () => {
  //        c3 (feature 顶)
  //       /
  // c2 -- c1 (main 顶)
  const rows = [
    { oid: 'c3', parents: ['c1'] },
    { oid: 'c2', parents: ['c1'] },
    { oid: 'c1', parents: [] },
  ];
  const lanes = assignLanes(rows);
  // c3：lane0=node；c2：lane0 里 c3 已消费 → lane0 空，c2 开启 lane1？
  // 实际顺序：c3 先到 → lanes=[c3]；columns=[node]（parent c1 在 later）
  //   lanes[0]=c1。c2 → lanes=[c1]，nodeColumn=-1 → push → lanes=[c1,c2]
  //   columns: i0 pending=c1 → c1 in later → pass；i1=nodeColumn → node
  assert.deepEqual(lanes[0].columns, ['node']);
  assert.equal(lanes[0].columns.length, 1);
  assert.deepEqual(lanes[1].columns, ['pass', 'node']);
  // c1：lanes=[c1,c2]，nodeColumn=0 → columns[0]=node；i1 pending=c2，
  //   c2 不在 later（c2 已消费）→ gap
  assert.deepEqual(lanes[2].columns, ['node', 'gap']);
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
  // 4 行都应有 lane 拓扑，不抛错且列数 ≥1
  assert.equal(lanes.length, 4);
});

test('分页断开：父不在 later 时 lane 置空', () => {
  const rows = [
    { oid: 'c5', parents: ['c4'] },
    { oid: 'c4', parents: ['c3'] },
  ];
  const lanes = assignLanes(rows);
  // c5 的父 c4 在 later（后续行有）→ lane 续接；c4 的父 c3 不在 → lanes[nodeColumn]=null
  assert.deepEqual(lanes[0].columns, ['node']);
  assert.equal(lanes[1].columns.length, 1);
});
