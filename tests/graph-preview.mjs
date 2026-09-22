#!/usr/bin/env node
/**
 * 图谱预览（开发用）：把 lib/graph-layout.js 的图元按 client.js 的同一套几何与配色
 * 画成独立 SVG（**浅色 / 深色两套**），用来在无浏览器环境下目视校验分支树样式、
 * 主题配色与 ref 徽标（分支 / 远程分支 / 标签）的可读性。
 *
 * 用法：
 *   node tests/graph-preview.mjs                 # 两套主题各写一个 SVG 到 /tmp
 *   node tests/graph-preview.mjs --png           # 顺带用 rsvg-convert 转 PNG
 *   node tests/graph-preview.mjs --theme=light   # 只画浅色（dark / light / both，默认 both）
 *   node tests/graph-preview.mjs --out=/path.svg # 只画一套时指定输出路径
 *
 * 与 client.js 的对应关系：
 *   · 每个提交行高 ROW_H，节点画在行内 NODE_Y 处（= 首行文字中心）；
 *   · **图谱带从行顶贯穿到行底**（硬约束：`.sgg-row` 不得有竖直内边距，行的上下
 *     3px 内边距挂在 `.sgg-main` 上）—— 否则相邻两行之间会出现 ~6px 断线；
 *   · top[] = 上半段（上一行下来的直通线 + 汇入曲线），bottom[] = 下半段
 *     （向下的直通线 + 扇出曲线 + 泳道左移滑移曲线）；行边界用细线标出，便于核对跨行不断；
 *   · 节点形状遵循 GE 规则：有 ref → 方块，HEAD/当前分支 → 多一圈描边；
 *   · 颜色取自与 client.js 的 `--sgg-*` token 同值的主题表（泳道 8 色 + 徽标 3 组），
 *     用来核对「浅色主题不能沿用深色专用亮色」（对比度另由 tests/theme.test.mjs 断言）。
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import {
  NODE_Y, ROW_H, laneWidth, nodeRadius, laneX, nodeShape, primPath, layoutGraph,
} from '../lib/graph-layout.js';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** 与 client.js 的 primitives 图标逐字一致（漂移由 tests/client-load.test.mjs 守卫）。 */
const ICON = {
  branch: 'M4 2v12M4 4.5h3.2a1.8 1.8 0 0 1 1.8 1.8v1.4a1.8 1.8 0 0 0 1.8 1.8H14',
  remote: 'M4.9 12.4h6.2a2.5 2.5 0 0 0 .3-5 3.5 3.5 0 0 0-6.7-.6 2.8 2.8 0 0 0 .2 5.6z',
  tag: 'M2.6 7.7V3.5a.9.9 0 0 1 .9-.9h4.2l5.7 5.7a1 1 0 0 1 0 1.4l-3.3 3.3a1 1 0 0 1-1.4 0L2.9 8.6a.9.9 0 0 1-.3-.9zM5.4 5.4h.01',
};

/** 主题表：色值与 client.js 的 `--sgg-*` token 一致（浅色挂 :root、深色挂 body[data-ds-dark-theme]）。
 *  背景取宿主 sidebar 底色：浅色 #f9fafb、深色 #1b1b1c。 */
const THEMES = {
  dark: {
    label: '深色主题',
    bg: '#1b1b1c', rowAlt: '#ffffff0a', boundary: '#ffffff1f',
    fg: '#f9fafb', muted: '#979da6',
    lanes: ['#d29922', '#f778ba', '#79c0ff', '#7ee787', '#ffa657', '#a5d6ff', '#ff7b72', '#8b949e'],
    ref: { fg: '#79c0ff', bg: ['#79c0ff', 0.16], line: ['#79c0ff', 0.5] },
    current: { fg: '#7ee787', bg: ['#2ea043', 0.18], line: ['#7ee787', 0.5] },
    tag: { fg: '#d29922', bg: ['#d29922', 0.16], line: ['#d29922', 0.5] },
  },
  light: {
    label: '浅色主题',
    bg: '#f9fafb', rowAlt: '#00000006', boundary: '#00000014',
    fg: '#0f1115', muted: '#61666b',
    lanes: ['#9a6700', '#bf3989', '#0969da', '#1a7f37', '#bc4c00', '#1b7c83', '#cf222e', '#57606a'],
    ref: { fg: '#0550ae', bg: ['#0969da', 0.1], line: ['#0969da', 0.45] },
    current: { fg: '#116329', bg: ['#1a7f37', 0.12], line: ['#1a7f37', 0.45] },
    tag: { fg: '#7d4e00', bg: ['#9a6700', 0.12], line: ['#9a6700', 0.45] },
  },
};

/** 样例行：refs 带类型（k: branch|remote|tag，cur: 当前分支/HEAD）。 */
const SAMPLES = [
  {
    title: '① 线性 + 分叉合并（feature 合回 main）',
    rows: [
      { oid: 'd10', parents: ['d09'], subject: 'docs: 补 README 发布步骤', refs: [{ n: 'main', k: 'branch', cur: true }], author: 'huanxuantian' },
      { oid: 'd09', parents: ['d08', 'f03'], subject: 'Merge branch feature/graph-style', refs: [], author: 'huanxuantian' },
      { oid: 'f03', parents: ['f02'], subject: 'feat: 曲线泳道渲染', refs: [{ n: 'feature/graph-style', k: 'branch' }], author: 'huanxuantian' },
      { oid: 'f02', parents: ['f01'], subject: 'test: 图元几何单测', refs: [], author: 'huanxuantian' },
      { oid: 'f01', parents: ['d07'], subject: 'feat: 泳道稳定配色', refs: [], author: 'huanxuantian' },
      { oid: 'd08', parents: ['d07'], subject: 'fix: 侧边栏空仓刷新', refs: [{ n: 'origin/main', k: 'remote' }], author: 'huanxuantian' },
      { oid: 'd07', parents: ['d06'], subject: 'chore: 版本号 0.9.0', refs: [{ n: 'v0.9.0', k: 'tag' }], author: 'huanxuantian' },
      { oid: 'd06', parents: ['d05'], subject: 'refactor: 泳道算法收敛到 graph-layout', refs: [], author: 'huanxuantian' },
      { oid: 'd05', parents: [], subject: 'init: 仓库初始化', refs: [{ n: 'v0.1.0', k: 'tag' }, { n: 'release/2026-09', k: 'branch' }], author: 'huanxuantian' },
    ],
  },
  {
    title: '② 章鱼合并 + 多分支并存（泳道压缩滑移）',
    rows: [
      { oid: 'e12', parents: ['e11'], subject: 'chore: 汇总', refs: [], author: 'a' },
      { oid: 'e11', parents: ['e10', 'g04', 'h03'], subject: 'Merge branches g/h into main', refs: [{ n: 'main', k: 'branch', cur: true }, { n: 'origin/main', k: 'remote' }], author: 'a' },
      { oid: 'g04', parents: ['g03'], subject: 'g: 4', refs: [{ n: 'g', k: 'branch' }], author: 'a' },
      { oid: 'g03', parents: ['e08'], subject: 'g: 3', refs: [], author: 'a' },
      { oid: 'h03', parents: ['h02'], subject: 'h: 3', refs: [{ n: 'h', k: 'branch' }], author: 'a' },
      { oid: 'h02', parents: ['e08'], subject: 'h: 2', refs: [], author: 'a' },
      { oid: 'e10', parents: ['e09'], subject: 'e: 10', refs: [], author: 'a' },
      { oid: 'e09', parents: ['e08'], subject: 'e: 9', refs: [], author: 'a' },
      { oid: 'e08', parents: ['e07'], subject: 'e: 8（三条支线的共同祖先）', refs: [], author: 'a' },
      { oid: 'e07', parents: [], subject: 'e: 7 根提交', refs: [{ n: 'root', k: 'tag' }], author: 'a' },
    ],
  },
  {
    title: '③ 两条长支线 + 交错汇入（颜色必须沿分支保持）',
    rows: [
      { oid: 'k14', parents: ['k13', 'm06'], subject: 'Merge m into k', refs: [{ n: 'k', k: 'branch', cur: true }], author: 'a' },
      { oid: 'm06', parents: ['m05'], subject: 'm: 6', refs: [{ n: 'm', k: 'branch' }], author: 'a' },
      { oid: 'k13', parents: ['k12'], subject: 'k: 13', refs: [], author: 'a' },
      { oid: 'm05', parents: ['k11'], subject: 'm: 5（回到主线）', refs: [], author: 'a' },
      { oid: 'k12', parents: ['k11'], subject: 'k: 12', refs: [], author: 'a' },
      { oid: 'k11', parents: ['k10', 'n04'], subject: 'Merge n into k', refs: [], author: 'a' },
      { oid: 'n04', parents: ['n03'], subject: 'n: 4', refs: [{ n: 'n', k: 'branch' }], author: 'a' },
      { oid: 'n03', parents: ['k09'], subject: 'n: 3（回到主线）', refs: [], author: 'a' },
      { oid: 'k10', parents: ['k09'], subject: 'k: 10', refs: [], author: 'a' },
      { oid: 'k09', parents: ['k08'], subject: 'k: 9', refs: [], author: 'a' },
      { oid: 'k08', parents: [], subject: 'k: 8 根提交', refs: [{ n: 'v1.0', k: 'tag' }, { n: 'origin/release', k: 'remote' }], author: 'a' },
    ],
  },
];

const GRAPH_LEFT = 6;
const TEXT_LEFT_EXTRA = 10;
const WIDTH = 660;

/** 泳道颜色在 layoutGraph 里是 `var(--sgg-lane-N)`，预览要换成该主题的实际色值。 */
function laneColor(color, theme) {
  const m = /--sgg-lane-(\d)/.exec(color);
  return m ? THEMES[theme].lanes[Number(m[1]) - 1] : color;
}

function renderSample(sample, theme, topY) {
  const t = THEMES[theme];
  const layout = layoutGraph(sample.rows);
  const laneW = laneWidth(layout.laneCount);
  const radius = nodeRadius(laneW);
  const graphWidth = layout.laneCount * laneW;
  const textLeft = GRAPH_LEFT + graphWidth + TEXT_LEFT_EXTRA;
  const height = sample.rows.length * ROW_H + 26;
  const parts = [];

  parts.push(`<g transform="translate(0,${topY})">`);
  parts.push(`<text x="8" y="18" fill="${t.fg}" font-size="13">${esc(sample.title)}`
    + `<tspan fill="${t.muted}" font-size="11">　（${t.label}，泳道 ${layout.laneCount}，laneW ${laneW}）</tspan></text>`);
  parts.push('<g transform="translate(0,26)">');

  layout.rows.forEach((lane, i) => {
    const y0 = i * ROW_H;
    const shift = (p, dy) => ({ ...p, y0: p.y0 + dy, y1: p.y1 + dy });
    if (i % 2 === 1) parts.push(`<rect x="0" y="${y0}" width="${WIDTH}" height="${ROW_H}" fill="${t.rowAlt}"/>`);
    if (i > 0) parts.push(`<line x1="0" y1="${y0}" x2="${WIDTH}" y2="${y0}" stroke="${t.boundary}" stroke-width="1"/>`);
    for (const p of [...lane.bottom, ...lane.top]) {
      parts.push(`<path d="${primPath(shift(p, y0), laneW)}" fill="none" stroke="${laneColor(p.color, theme)}" stroke-width="2" stroke-linecap="round" transform="translate(${GRAPH_LEFT},0)"/>`);
    }
    const cx = GRAPH_LEFT + laneX(lane.node.col, laneW);
    const cy = y0 + NODE_Y;
    const row = sample.rows[i];
    const shape = nodeShape(row.refs.length > 0, row.refs.some((r) => r.cur === true));
    const nodeColor = laneColor(lane.node.color, theme);
    if (shape.shape === 'square') {
      parts.push(`<rect x="${cx - radius}" y="${cy - radius}" width="${radius * 2}" height="${radius * 2}" fill="${nodeColor}"/>`);
    } else {
      parts.push(`<circle cx="${cx}" cy="${cy}" r="${radius}" fill="${nodeColor}"/>`);
    }
    if (shape.ring) {
      parts.push(shape.shape === 'square'
        ? `<rect x="${cx - radius - 1.5}" y="${cy - radius - 1.5}" width="${(radius + 1.5) * 2}" height="${(radius + 1.5) * 2}" fill="none" stroke="${t.fg}" stroke-width="1.5"/>`
        : `<circle cx="${cx}" cy="${cy}" r="${radius + 1.5}" fill="none" stroke="${t.fg}" stroke-width="1.5"/>`);
    }

    // 文本 + ref 徽标（图标 + 边框 + 名称，对齐 client.js 的 .sgg-ref / refChip）
    const baseY = y0 + 12;
    parts.push(`<text x="${textLeft}" y="${baseY + 4}" fill="${t.muted}" font-size="10.5">${esc(row.oid)}</text>`);
    parts.push(`<text x="${textLeft + 42}" y="${baseY + 4}" fill="${t.fg}" font-size="12">${esc(row.subject)}</text>`);
    let bx = textLeft;
    for (const ref of row.refs) {
      const v = ref.cur ? t.current : (ref.k === 'tag' ? t.tag : t.ref);
      const w = 10 + 3 + ref.n.length * 5.9 + 10; // 图标 + 间距 + 文字 + 左右内边距
      const y = baseY + 9;
      parts.push(`<rect x="${bx.toFixed(1)}" y="${y}" width="${w.toFixed(1)}" height="15" rx="7.5" fill="${v.bg[0]}" fill-opacity="${v.bg[1]}" stroke="${v.line[0]}" stroke-opacity="${v.line[1]}" stroke-width="1"/>`);
      parts.push(`<g transform="translate(${(bx + 5).toFixed(1)},${(y + 2.5).toFixed(1)}) scale(0.625)" fill="none" stroke="${v.fg}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="${ICON[ref.k === 'tag' ? 'tag' : ref.k === 'remote' ? 'remote' : 'branch']}"/></g>`);
      parts.push(`<text x="${(bx + 18).toFixed(1)}" y="${y + 10.6}" fill="${v.fg}" font-size="10">${esc(ref.n)}</text>`);
      bx += w + 6;
    }
    parts.push(`<text x="${bx.toFixed(1)}" y="${baseY + 20}" fill="${t.muted}" font-size="10.5">${esc(row.author)} · just now</text>`);
  });

  parts.push('</g></g>');
  return { body: parts.join('\n'), height };
}

function renderTheme(theme) {
  const t = THEMES[theme];
  let offset = 0;
  const bodies = [];
  for (const sample of SAMPLES) {
    const { body, height } = renderSample(sample, theme, offset);
    bodies.push(body);
    offset += height + 14;
  }
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${offset}" viewBox="0 0 ${WIDTH} ${offset}" font-family="ui-monospace,SFMono-Regular,Menlo,monospace">`,
    `<rect width="100%" height="100%" fill="${t.bg}"/>`,
    bodies.join('\n'),
    '</svg>',
  ].join('\n');
}

const args = process.argv.slice(2);
const themeArg = (args.find((a) => a.startsWith('--theme=')) ?? '--theme=both').slice('--theme='.length);
const themes = themeArg === 'both' ? ['dark', 'light'] : [themeArg];
if (!themes.every((x) => THEMES[x])) throw new Error(`--theme 只能是 dark|light|both，收到 ${themeArg}`);
const outArg = args.find((a) => a.startsWith('--out='))?.slice('--out='.length);

for (const theme of themes) {
  const out = outArg && themes.length === 1
    ? outArg
    : `/tmp/git-graph-preview-${theme === 'dark' ? '深色' : '浅色'}.svg`;
  writeFileSync(out, renderTheme(theme));
  console.log(`已写入 ${out}`);
  if (args.includes('--png')) {
    const png = out.replace(/\.svg$/, '') + '.png';
    try {
      execFileSync('rsvg-convert', ['-w', '990', '-o', png, out]);
      console.log(`已写入 ${png}`);
    } catch (err) {
      console.error(`rsvg-convert 失败（可忽略）：${err.message}`);
    }
  }
}
