#!/usr/bin/env node
/**
 * 图谱预览（开发用）：把 lib/graph-layout.js 的图元按 client.js 的同一套几何
 * （上下两层、标称 NODE_Y/ROW_H）画成一张独立 SVG，用来**肉眼校验**分支树样式，
 * 不依赖浏览器、不依赖 dsh 运行环境。
 *
 * 用法：
 *   node tests/graph-preview.mjs                 # 写 /tmp/git-graph-preview.svg
 *   node tests/graph-preview.mjs --png           # 顺带用 rsvg-convert 转 PNG
 *   node tests/graph-preview.mjs --out=/path.svg
 *
 * 与 client.js 的对应关系：
 *   · 每个提交行高 ROW_H，节点画在行内 NODE_Y 处（= 首行文字中心）；
 *   · **图谱带从行顶贯穿到行底**（这是硬约束：`.sgg-row` 不得有竖直内边距，行的上下
 *     3px 内边距挂在 `.sgg-main` 上）—— 否则相邻两行之间会出现 ~6px 断线；
 *     本预览按该契约绘制（行首文字仍在行顶 +3px），所以能在无浏览器时看出接缝问题；
 *   · top[] = 上半段（上一行下来的直通线 + 汇入曲线），bottom[] = 下半段
 *     （向下的直通线 + 扇出曲线 + 泳道左移滑移曲线）；
 *   · 节点形状遵循 GE 规则：有 ref → 方块，HEAD → 多一圈描边。
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import {
  NODE_Y, ROW_H, PALETTE, laneWidth, nodeRadius, laneX, nodeShape, primPath, layoutGraph,
} from '../lib/graph-layout.js';

const HEAD = 'HEAD';
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** 样例历史（新 → 旧），模拟 git log 的拓扑序输出。 */
const SAMPLES = [
  {
    title: '① 线性 + 分叉合并（feature 合回 main）',
    rows: [
      { oid: 'd10', parents: ['d09'], subject: 'docs: 补 README 发布步骤', refs: 'HEAD -> main', author: 'huanxuantian' },
      { oid: 'd09', parents: ['d08', 'f03'], subject: 'Merge branch feature/graph-style', refs: '', author: 'huanxuantian' },
      { oid: 'f03', parents: ['f02'], subject: 'feat: 曲线泳道渲染', refs: 'feature/graph-style', author: 'huanxuantian' },
      { oid: 'f02', parents: ['f01'], subject: 'test: 图元几何单测', refs: '', author: 'huanxuantian' },
      { oid: 'f01', parents: ['d07'], subject: 'feat: 泳道稳定配色', refs: '', author: 'huanxuantian' },
      { oid: 'd08', parents: ['d07'], subject: 'fix: 侧边栏空仓刷新', refs: 'origin/main', author: 'huanxuantian' },
      { oid: 'd07', parents: ['d06'], subject: 'chore: 版本号 0.9.0', refs: '', author: 'huanxuantian' },
      { oid: 'd06', parents: ['d05'], subject: 'refactor: 泳道算法收敛到 graph-layout', refs: '', author: 'huanxuantian' },
      { oid: 'd05', parents: [], subject: 'init: 仓库初始化', refs: 'tag: v0.1.0', author: 'huanxuantian' },
    ],
  },
  {
    title: '② 章鱼合并 + 多分支并存（泳道压缩滑移）',
    rows: [
      { oid: 'e12', parents: ['e11'], subject: 'chore: 汇总', refs: '', author: 'a' },
      { oid: 'e11', parents: ['e10', 'g04', 'h03'], subject: 'Merge branches g/h into main', refs: 'HEAD -> main', author: 'a' },
      { oid: 'g04', parents: ['g03'], subject: 'g: 4', refs: 'g', author: 'a' },
      { oid: 'g03', parents: ['e08'], subject: 'g: 3', refs: '', author: 'a' },
      { oid: 'h03', parents: ['h02'], subject: 'h: 3', refs: 'h', author: 'a' },
      { oid: 'h02', parents: ['e08'], subject: 'h: 2', refs: '', author: 'a' },
      { oid: 'e10', parents: ['e09'], subject: 'e: 10', refs: '', author: 'a' },
      { oid: 'e09', parents: ['e08'], subject: 'e: 9', refs: '', author: 'a' },
      { oid: 'e08', parents: ['e07'], subject: 'e: 8（三条支线的共同祖先）', refs: '', author: 'a' },
      { oid: 'e07', parents: [], subject: 'e: 7 根提交', refs: 'tag: root', author: 'a' },
    ],
  },
  {
    title: '③ 两条长支线 + 交错汇入（颜色必须沿分支保持）',
    rows: [
      { oid: 'k14', parents: ['k13', 'm06'], subject: 'Merge m into k', refs: 'HEAD -> k', author: 'a' },
      { oid: 'm06', parents: ['m05'], subject: 'm: 6', refs: 'm', author: 'a' },
      { oid: 'k13', parents: ['k12'], subject: 'k: 13', refs: '', author: 'a' },
      { oid: 'm05', parents: ['k11'], subject: 'm: 5（回到主线）', refs: '', author: 'a' },
      { oid: 'k12', parents: ['k11'], subject: 'k: 12', refs: '', author: 'a' },
      { oid: 'k11', parents: ['k10', 'n04'], subject: 'Merge n into k', refs: '', author: 'a' },
      { oid: 'n04', parents: ['n03'], subject: 'n: 4', refs: 'n', author: 'a' },
      { oid: 'n03', parents: ['k09'], subject: 'n: 3（回到主线）', refs: '', author: 'a' },
      { oid: 'k10', parents: ['k09'], subject: 'k: 10', refs: '', author: 'a' },
      { oid: 'k09', parents: ['k08'], subject: 'k: 9', refs: '', author: 'a' },
      { oid: 'k08', parents: [], subject: 'k: 8 根提交', refs: 'tag: v1.0', author: 'a' },
    ],
  },
];

const BG = '#0d1117';
const FG = '#e6edf3';
const MUTED = '#8b949e';
const ROW_H_PX = ROW_H;
const LANE_LEFT = 6;
const TEXT_LEFT_EXTRA = 10;

function renderSample(sample, topY) {
  const layout = layoutGraph(sample.rows);
  const laneW = laneWidth(layout.laneCount);
  const radius = nodeRadius(laneW);
  const graphWidth = layout.laneCount * laneW;
  const textLeft = LANE_LEFT + graphWidth + TEXT_LEFT_EXTRA;
  const width = 640;
  const height = sample.rows.length * ROW_H_PX + 26;
  const parts = [];

  parts.push(`<g transform="translate(0,${topY})">`);
  parts.push(`<text x="8" y="18" fill="${FG}" font-size="13">${esc(sample.title)}　（泳道 ${layout.laneCount}，laneW ${laneW}）</text>`);
  parts.push(`<g transform="translate(0,26)">`);

  layout.rows.forEach((lane, i) => {
    const y0 = i * ROW_H_PX;
    const shift = (p, dy) => ({ ...p, y0: p.y0 + dy, y1: p.y1 + dy });
    // 行背景微条纹 + 行边界虚线：用来肉眼确认「图谱带贯穿整行、线跨行不断」
    if (i % 2 === 1) parts.push(`<rect x="0" y="${y0}" width="${width}" height="${ROW_H_PX}" fill="#ffffff08"/>`);
    if (i > 0) parts.push(`<line x1="0" y1="${y0}" x2="${width}" y2="${y0}" stroke="#ffffff18" stroke-width="1"/>`);
    for (const p of lane.bottom) {
      const q = shift(p, y0);
      parts.push(`<path d="${primPath(q, laneW)}" fill="none" stroke="${p.color}" stroke-width="2" stroke-linecap="round" transform="translate(${LANE_LEFT},0)"/>`);
    }
    for (const p of lane.top) {
      const q = shift(p, y0);
      parts.push(`<path d="${primPath(q, laneW)}" fill="none" stroke="${p.color}" stroke-width="2" stroke-linecap="round" transform="translate(${LANE_LEFT},0)"/>`);
    }
    const cx = LANE_LEFT + laneX(lane.node.col, laneW);
    const cy = y0 + NODE_Y;
    const shape = nodeShape(sample.rows[i].refs !== '', sample.rows[i].refs.includes('HEAD'));
    if (shape.shape === 'square') {
      parts.push(`<rect x="${cx - radius}" y="${cy - radius}" width="${radius * 2}" height="${radius * 2}" fill="${lane.node.color}"/>`);
    } else {
      parts.push(`<circle cx="${cx}" cy="${cy}" r="${radius}" fill="${lane.node.color}"/>`);
    }
    if (shape.ring) {
      parts.push(shape.shape === 'square'
        ? `<rect x="${cx - radius - 1.5}" y="${cy - radius - 1.5}" width="${(radius + 1.5) * 2}" height="${(radius + 1.5) * 2}" fill="none" stroke="${FG}" stroke-width="1.5"/>`
        : `<circle cx="${cx}" cy="${cy}" r="${radius + 1.5}" fill="none" stroke="${FG}" stroke-width="1.5"/>`);
    }
    // 文本：hash / subject / refs 徽标 / 作者
    const row = sample.rows[i];
    const baseY = y0 + 12;
    parts.push(`<text x="${textLeft}" y="${baseY + 4}" fill="${MUTED}" font-size="10.5">${esc(row.oid)}</text>`);
    parts.push(`<text x="${textLeft + 42}" y="${baseY + 4}" fill="${FG}" font-size="12">${esc(row.subject)}</text>`);
    let bx = textLeft;
    for (const raw of String(row.refs || '').split(',').map((s) => s.trim()).filter(Boolean)) {
      const name = raw.replace(/^HEAD -> /, '').replace(/^tag: /, '');
      const isTag = raw.startsWith('tag: ');
      const w = name.length * 6 + 10;
      parts.push(`<rect x="${bx}" y="${baseY + 10}" width="${w}" height="13" rx="6.5" fill="${isTag ? '#d2992229' : '#4d9fff29'}"/>`);
      parts.push(`<text x="${bx + 5}" y="${baseY + 20}" fill="${isTag ? '#d29922' : '#79c0ff'}" font-size="10">${esc(name)}</text>`);
      bx += w + 6;
    }
    parts.push(`<text x="${bx}" y="${baseY + 20}" fill="${MUTED}" font-size="10.5">${esc(row.author)} · just now</text>`);
  });

  parts.push('</g></g>');
  return { body: parts.join('\n'), height };
}

const args = process.argv.slice(2);
const outArg = args.find((a) => a.startsWith('--out='));
const out = outArg ? outArg.slice(6) : '/tmp/git-graph-preview.svg';

let offset = 0;
const bodies = [];
for (const sample of SAMPLES) {
  const { body, height } = renderSample(sample, offset);
  bodies.push(body);
  offset += height + 14;
}
const width = 640;
const svg = [
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${offset}" viewBox="0 0 ${width} ${offset}" font-family="ui-monospace,SFMono-Regular,Menlo,monospace">`,
  `<rect width="100%" height="100%" fill="${BG}"/>`,
  bodies.join('\n'),
  '</svg>',
].join('\n');
writeFileSync(out, svg);
console.log(`已写入 ${out}（${SAMPLES.length} 张样例，总高 ${offset}px）`);

if (args.includes('--png')) {
  const png = out.replace(/\.svg$/, '') + '.png';
  try {
    execFileSync('rsvg-convert', ['-w', '1280', '-o', png, out]);
    console.log(`已写入 ${png}`);
  } catch (err) {
    console.error(`rsvg-convert 失败（可忽略）：${err.message}`);
  }
}
