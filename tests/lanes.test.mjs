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

test('跨页续接：第二页继承上一页 tail，泳道不断开', () => {
  // 一页放不下：c4 的父 c3 在下一页。第一页 rows=[c4]，tail 应保留 c3。
  const page1 = [
    { oid: 'c4', parents: ['c3'] },
  ];
  const m1 = assignLanes(page1);
  assert.deepEqual(m1[0].columns, ['node']);
  assert.deepEqual(m1.tail, ['c3'], 'tail 应保留未消费的父提交');

  // 第二页：以 tail 为初始 lanes，c3 应作为 node 续接而不是断开。
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
  //        c4 (feature 顶)     —— 第一页
  //       /
  // c3 -- c2 (main)           —— c2 的父 c1 在下一页
  // 第一页 rows=[c4, c3]，tail 应保留 c1（c3 消费了 c4 的父 lane？）
  const page1 = [
    { oid: 'c4', parents: ['c2'] },
    { oid: 'c3', parents: ['c2'] },
  ];
  const m1 = assignLanes(page1);
  // c4: lanes=[c4] → node；lane0=c2。c3: nodeColumn=-1 → push → lanes=[c2,c3]
  //   columns: i0 pending=c2 在 later → pass；i1 node
  assert.deepEqual(m1[0].columns, ['node']);
  assert.deepEqual(m1[1].columns, ['pass', 'node']);
  assert.ok(m1.tail.includes('c2'), 'tail 应包含 c2（下一页要消费）');

  // 第二页：[c2(父 c1)] —— c2 消费第一页的 lane。
  const page2 = [
    { oid: 'c2', parents: ['c1'] },
  ];
  const m2 = assignLanes(page2, m1.tail);
  // lane0 接续为 node；lane1 是 tail 中 c2 的重复引用（c4/c3 都指向 c2），
  // 消费行按算法渲染 gap（与单页 merge 行为一致，非顶部断开）。
  assert.deepEqual(m2[0].columns, ['node', 'gap'], 'c2 应接续第一页的 pass lane 为 node');
});

test('跨页续接：tail 中本页不消费的 pending 仍画 pass（不顶部断开）', () => {
  // 第一页最后一行 c3 的父 c2 未消费，进入 tail。
  const page1 = [
    { oid: 'c4', parents: ['c3'] },
    { oid: 'c3', parents: ['c2'] },
  ];
  const m1 = assignLanes(page1);
  assert.deepEqual(m1.tail, ['c2']);

  // 第二页没有 c2 的提交（它更远），但有 c2 的旁支 c5（父 c2 无，纯新节点）。
  // c5 独立开启 lane；carried 的 c2 在本页不消费 → 应保持 pass 线而非 gap。
  const page2 = [
    { oid: 'c5', parents: [] },
  ];
  const m2 = assignLanes(page2, m1.tail);
  assert.deepEqual(m2[0].columns, ['pass', 'node'], 'carried c2 应画 pass，新节点 c5 开右侧 lane');
});
