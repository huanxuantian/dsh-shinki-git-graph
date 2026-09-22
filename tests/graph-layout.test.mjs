/**
 * 图谱布局/图元单测：泳道配色稳定性、分叉/合并的曲线图元、泳道压缩滑移、
 * 跨页配色延续，以及「按行切开绘制」所依赖的坐标不变量。
 *
 * 这些断言就是 client.js 画图的契约：改了 lib/graph-layout.js 的几何/配色，
 * 这里必须同步改（并重跑内联脚本）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PALETTE, NODE_Y, ROW_H,
  laneWidth, nodeRadius, nodeShape, laneX, segmentPath, primPath, layoutGraph,
} from '../lib/graph-layout.js';

const W = 15; // laneWidth(1..8) —— 常规泳道间距，便于写死期望的 path

/** 只保留图元的关键字段，便于 deepEqual。 */
const prim = (p) => ({ col: p.col, toCol: p.toCol, y0: p.y0, y1: p.y1, color: p.color });

test('线性历史：泳道颜色全程稳定，节点种类正确', () => {
  const l = layoutGraph([
    { oid: 'c3', parents: ['c2'] },
    { oid: 'c2', parents: ['c1'] },
    { oid: 'c1', parents: [] },
  ]);
  assert.equal(l.laneCount, 1);
  assert.deepEqual(l.rows.map((r) => r.node.col), [0, 0, 0]);
  assert.deepEqual(l.rows.map((r) => r.node.kind), ['commit', 'commit', 'root']);
  assert.deepEqual(l.rows.map((r) => r.node.color), [PALETTE[0], PALETTE[0], PALETTE[0]]);
  assert.deepEqual(l.rows.map((r) => r.columns), [['node'], ['node'], ['node']]);
  assert.deepEqual(l.lanes, []);
  assert.deepEqual(l.colors, []);
});

test('分叉：另一条泳道以曲线斜插进节点（树叉的画法）', () => {
  //        c3 (feature 顶)
  //       /
  // c2 -- c1 (main 顶)
  const l = layoutGraph([
    { oid: 'c3', parents: ['c1'] },
    { oid: 'c2', parents: ['c1'] },
    { oid: 'c1', parents: [] },
  ]);
  const fork = l.rows[2];
  assert.equal(fork.node.col, 0);
  assert.deepEqual(fork.columns, ['node', 'pass']);
  assert.equal(fork.top.length, 2);
  // lane0 是节点自身泳道（自上方竖直进入）
  assert.deepEqual(prim(fork.top[0]), { col: 0, toCol: undefined, y0: 0, y1: NODE_Y, color: PALETTE[0] });
  // lane1 是「也在等 c1」的另一条分支：从行顶斜插到节点，颜色是它自己的
  assert.deepEqual(prim(fork.top[1]), { col: 1, toCol: 0, y0: 0, y1: NODE_Y, color: PALETTE[1] });
  assert.equal(primPath(fork.top[1], W), 'M22.5 0C22.5 6 7.5 6 7.5 12');
  // 两条线颜色不同：分叉一眼可辨（旧版这里只有断线）
  assert.notEqual(fork.top[0].color, fork.top[1].color);
  // 上部无扇出、节点无父
  assert.deepEqual(fork.bottom, []);
  // 分支颜色：c3 与 c1 同色（同一条主线），c2 是另一条
  assert.equal(l.rows[0].node.color, PALETTE[0]);
  assert.equal(l.rows[1].node.color, PALETTE[1]);
  assert.equal(fork.node.color, PALETTE[0]);
});

test('合并提交：第二个父从节点斜出到右侧泳道，颜色随该泳道', () => {
  const l = layoutGraph([
    { oid: 'M', parents: ['A', 'B'] },
    { oid: 'B', parents: ['base'] },
    { oid: 'A', parents: ['base'] },
    { oid: 'base', parents: [] },
  ]);
  const m = l.rows[0];
  assert.equal(m.node.kind, 'merge');
  assert.equal(m.node.col, 0);
  assert.equal(m.node.color, PALETTE[0]);
  assert.deepEqual(m.columns, ['merge', 'pass']);
  assert.equal(m.bottom.length, 2);
  assert.deepEqual(prim(m.bottom[0]), { col: 0, toCol: 0, y0: NODE_Y, y1: ROW_H, color: PALETTE[0] });
  assert.deepEqual(prim(m.bottom[1]), { col: 0, toCol: 1, y0: NODE_Y, y1: ROW_H, color: PALETTE[1] });
  assert.equal(primPath(m.bottom[1], W), 'M7.5 12C7.5 26.5 22.5 26.5 22.5 41');
  // B 侧泳道一路保持自己的颜色：B 行节点、base 行的汇入曲线都是 PALETTE[1]
  assert.equal(l.rows[1].node.color, PALETTE[1]);
  const join = l.rows[3];
  assert.equal(join.node.kind, 'root');
  assert.deepEqual(join.columns, ['node', 'pass']);
  assert.deepEqual(prim(join.top[1]), { col: 1, toCol: 0, y0: 0, y1: NODE_Y, color: PALETTE[1] });
});

test('章鱼合并（3 父）：两条扇出曲线，颜色互不相同', () => {
  const l = layoutGraph([
    { oid: 'M', parents: ['A', 'B', 'C'] },
    { oid: 'A', parents: [] },
    { oid: 'B', parents: [] },
    { oid: 'C', parents: [] },
  ]);
  const m = l.rows[0];
  const outs = m.bottom.filter((p) => p.toCol !== p.col);
  assert.equal(outs.length, 2);
  assert.deepEqual(outs.map((p) => p.toCol), [1, 2]);
  assert.equal(new Set(outs.map((p) => p.color)).size, 2);
  assert.equal(m.laneCount, 3);
});

test('泳道压缩：空列释放后，右侧泳道在下一段里滑移过去', () => {
  // a ---- base
  // b ---- base (并额外分叉出 X)      → base 行里 base 的两条泳道合并释放，
  //        \ X                         X 从第 2 列滑到第 0 列
  const l = layoutGraph([
    { oid: 'a', parents: ['base'] },
    { oid: 'b', parents: ['base', 'X'] },
    { oid: 'base', parents: [] },
  ]);
  const last = l.rows[2];
  assert.equal(last.node.col, 0);
  assert.deepEqual(last.columns, ['node', 'pass', 'pass']);
  // 释放掉的是 col0/col1（都在等 base），col2 的 X 滑到 col0
  assert.deepEqual(prim(last.bottom[0]), { col: 2, toCol: 0, y0: NODE_Y, y1: ROW_H, color: PALETTE[2] });
  assert.equal(primPath(last.bottom[0], W), 'M37.5 12C37.5 26.5 7.5 26.5 7.5 41');
  assert.deepEqual(l.lanes, ['X']);
  assert.deepEqual(l.colors, [PALETTE[2]]);
});

test('跨页：显式传入的颜色被沿用（不按列号重新分配）', () => {
  const page1 = layoutGraph([{ oid: 'm', parents: ['A', 'B'] }]);
  assert.deepEqual(page1.lanes, ['A', 'B']);
  assert.deepEqual(page1.colors, [PALETTE[0], PALETTE[1]]);

  const page2 = layoutGraph(
    [{ oid: 'B', parents: ['x'] }, { oid: 'A', parents: ['y'] }],
    { lanes: page1.lanes, colors: ['#111111', '#222222'] },
  );
  assert.equal(page2.rows[0].node.color, '#222222');
  assert.equal(page2.rows[1].node.color, '#111111');
  assert.deepEqual(page2.colors, ['#111111', '#222222']);
  // bottom[0] 是另一条直通泳道（A，颜色 #111111），bottom[1] 才是 B→x 的续线
  assert.equal(page2.rows[0].bottom[0].color, '#111111');
  assert.equal(page2.rows[0].bottom[1].color, '#222222');
});

test('图元坐标不变量：上半段 0→NODE_Y、下半段 NODE_Y→ROW_H、两端竖直切线', () => {
  const rows = [
    { oid: 'r1', parents: ['r2', 'r3'] },
    { oid: 'r2', parents: ['r4'] },
    { oid: 'r3', parents: ['r4', 'r5'] },
    { oid: 'r4', parents: ['r6'] },
    { oid: 'r5', parents: ['r6'] },
    { oid: 'r6', parents: [] },
  ];
  const l = layoutGraph(rows);
  const curveRe = /^M(-?[\d.]+) (-?[\d.]+)C(-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+)$/;
  for (const row of l.rows) {
    assert.ok(row.node.col < row.columns.length, '节点必须落在绘制宽度内');
    for (const p of row.top) {
      assert.equal(p.y0, 0);
      assert.equal(p.y1, NODE_Y);
      assert.ok(p.col < row.columns.length && (p.toCol ?? p.col) < row.columns.length, '图元不得超出绘制宽度');
      checkPath(primPath(p, W), curveRe);
    }
    for (const p of row.bottom) {
      assert.equal(p.y0, NODE_Y);
      assert.equal(p.y1, ROW_H);
      assert.ok(p.col < row.columns.length && (p.toCol ?? p.col) < row.columns.length, '图元不得超出绘制宽度');
      checkPath(primPath(p, W), curveRe);
    }
  }
});

/** 线条要么是竖直线，要么两端切线竖直（控制点 x 与端点相同）——按行切开才不会有折角。 */
function checkPath(d, curveRe) {
  if (/^M(-?[\d.]+) (-?[\d.]+)V(-?[\d.]+)$/.test(d)) return;
  const m = curveRe.exec(d);
  assert.ok(m, `不是合法 path：${d}`);
  assert.equal(m[3], m[1], `起点切线必须竖直：${d}`);
  assert.equal(m[5], m[7], `终点切线必须竖直：${d}`);
}

test('几何/形状工具函数：泳道自适应宽度、节点半径、GE 节点形状规则', () => {
  assert.equal(laneX(0, W), 7.5);
  assert.equal(laneX(2, 9), 22.5);
  assert.equal(segmentPath(10, 0, 10, 20), 'M10 0V20');
  assert.equal(segmentPath(0, 0, 30, 20), 'M0 0C0 10 30 10 30 20');
  assert.deepEqual([laneWidth(1), laneWidth(8), laneWidth(10), laneWidth(20), laneWidth(40)], [15, 15, 12, 9, 7]);
  assert.deepEqual([nodeRadius(15), nodeRadius(12), nodeRadius(9)], [4, 3.4, 2.6]);
  // GE：有 ref → 方块；HEAD → 加一圈描边；合并提交不额外变形
  assert.deepEqual(nodeShape(true, false), { shape: 'square', ring: false });
  assert.deepEqual(nodeShape(false, true), { shape: 'circle', ring: true });
  assert.deepEqual(nodeShape(true, true), { shape: 'square', ring: true });
});

test('每行泳道数与整页宽度：压缩后不因历史高水位永久变宽', () => {
  // 先并排 3 条泳道，随后两条被消费释放，只剩 1 条
  const l = layoutGraph([
    { oid: 'm', parents: ['A', 'B', 'C'] },
    { oid: 'A', parents: [] },
    { oid: 'B', parents: [] },
    { oid: 'C', parents: [] },
  ]);
  assert.equal(l.laneCount, 3, '整页宽度取同时并存的最大值');
  assert.ok(l.rows[1].laneCount <= 3);
  // 末行（C）时 A/B 已释放：C 所在的泳道被压缩回第 0 列
  assert.equal(l.rows[3].node.col, 0);
});
