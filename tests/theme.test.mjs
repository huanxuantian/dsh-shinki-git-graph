/**
 * 深浅主题表现验证（v0.9.1）。
 *
 * 背景：v0.9.0 的泳道/徽标/diff 配色只有一套「深色主题专用」的亮色值。宿主切到浅色主题时
 * 这些颜色画在 #f9fafb 上只有 1.47~2.94:1（WCAG 图形对比度要求 ≥3:1）——绿色泳道几乎看不见。
 * 现在每个色值都有两套（浅色挂 `:root`、深色挂 `body[data-ds-dark-theme]`，与宿主主题服务
 * 的开关一致），本用例按 WCAG 公式把「宣称可读」变成可断言的数字。
 *
 * 断言：
 *   1. 两个主题的 token 集合完全一致（加了 token 只改一边 → 失败）；
 *   2. 泳道调色板确实通过 var(--sgg-lane-N) 取色，且两个主题都定义了 1..8；
 *   3. 对比度：泳道线（图形）≥3:1；徽标/diff/状态文本 ≥4.5:1（底色含半透明叠加后的实际值）；
 *   4. 旧的一次性硬编码色不再残留在规则里（除了 token 定义本身）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PALETTE } from '../lib/graph-layout.js';
import { cssDecls, cssVars, clientSource } from './css-tokens.mjs';

/** 宿主主题的侧边栏底色（来自 dsh-client-ui-theme 的 design_platform_css：
 *  浅色 --dsw-specific-sidebar-fill=neutral-bluish-50，深色 =neutral-bluish-900；
 *  layer-1 分别是 #fff / #232324。取两者中对比度更低的一个作为断言基准。 */
const LIGHT_BGS = ['#f9fafb', '#ffffff'];
const DARK_BGS = ['#1b1b1c', '#232324'];
const DARK_SELECTOR = 'body[data-ds-dark-theme],html[data-ds-dark-theme]';

const light = cssVars(':root');
const dark = cssVars(DARK_SELECTOR);

// ── WCAG 2.x 相对亮度/对比度 ───────────────────────────────────────────────
function channel(v) {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
function luminance(hex) {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}
function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
/** 把 rgba() 半透明色叠在底色上，得到实际渲染色。 */
function composite(color, bg) {
  const m = /^rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)$/.exec(color);
  if (!m) return color;
  const [, r, g, b, a] = [m[0], +m[1], +m[2], +m[3], +m[4]];
  const h = bg.replace('#', '');
  const [br, bgc, bb] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  const mix = (x, y) => Math.round(x * a + y * (1 - a));
  return `#${[mix(r, br), mix(g, bgc), mix(b, bb)].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}
const worst = (color, bgs) => Math.min(...bgs.map((bg) => contrast(color, bg)));
const worstOn = (fg, bgColor, bgs) => Math.min(...bgs.map((bg) => contrast(fg, composite(bgColor, bg))));

test('深浅主题 token 集合完全一致（不能只定义一个主题）', () => {
  assert.ok(Object.keys(light).length >= 18, `浅色 token 太少：${Object.keys(light).length}`);
  assert.deepEqual(Object.keys(light).sort(), Object.keys(dark).sort());
  for (const name of [...Object.keys(light)]) {
    assert.match(light[name], /^#[0-9a-f]{6}$|^rgba\(/, `浅色 ${name} 值异常`);
    assert.match(dark[name], /^#[0-9a-f]{6}$|^rgba\(/, `深色 ${name} 值异常`);
    assert.notEqual(light[name], dark[name], `${name} 两个主题不应同值（否则等于没适配）`);
  }
});

test('泳道调色板走 CSS 变量，且 1..8 在两个主题里都有定义', () => {
  assert.equal(PALETTE.length, 8);
  PALETTE.forEach((c, i) => {
    assert.equal(c, `var(--sgg-lane-${i + 1})`, `PALETTE[${i}] 应是 var(--sgg-lane-${i + 1})`);
    assert.ok(light[`--sgg-lane-${i + 1}`], `浅色缺少 --sgg-lane-${i + 1}`);
    assert.ok(dark[`--sgg-lane-${i + 1}`], `深色缺少 --sgg-lane-${i + 1}`);
  });
});

test('对比度：泳道线在两个主题下都 ≥3:1（WCAG 非文本对比度）', () => {
  const table = [];
  for (let i = 1; i <= 8; i += 1) {
    const l = worst(light[`--sgg-lane-${i}`], LIGHT_BGS);
    const d = worst(dark[`--sgg-lane-${i}`], DARK_BGS);
    table.push(`lane${i} 浅 ${l.toFixed(2)} 深 ${d.toFixed(2)}`);
    assert.ok(l >= 3, `浅色 lane${i} ${light[`--sgg-lane-${i}`]} 对比度仅 ${l.toFixed(2)}:1`);
    assert.ok(d >= 3, `深色 lane${i} ${dark[`--sgg-lane-${i}`]} 对比度仅 ${d.toFixed(2)}:1`);
  }
  assert.ok(table.length === 8);
});

test('对比度：徽标 / diff / 状态文本在两个主题下都 ≥4.5:1', () => {
  const cases = [
    ['ref', '--sgg-ref-fg', '--sgg-ref-bg', 4.5],
    ['current', '--sgg-ref-current-fg', '--sgg-ref-current-bg', 4.5],
    ['tag', '--sgg-ref-tag-fg', '--sgg-ref-tag-bg', 4.5],
  ];
  for (const [name, fgVar, bgVar, min] of cases) {
    const l = worstOn(light[fgVar], light[bgVar], LIGHT_BGS);
    const d = worstOn(dark[fgVar], dark[bgVar], DARK_BGS);
    assert.ok(l >= min, `浅色 ${name} 徽标对比度仅 ${l.toFixed(2)}:1`);
    assert.ok(d >= min, `深色 ${name} 徽标对比度仅 ${d.toFixed(2)}:1`);
  }
  for (const name of ['--sgg-add', '--sgg-del', '--sgg-hunk', '--sgg-success', '--sgg-danger', '--sgg-warn']) {
    const l = worst(light[name], LIGHT_BGS);
    const d = worst(dark[name], DARK_BGS);
    assert.ok(l >= 4.5, `浅色 ${name} 文本对比度仅 ${l.toFixed(2)}:1`);
    assert.ok(d >= 4.5, `深色 ${name} 文本对比度仅 ${d.toFixed(2)}:1`);
  }
});

test('旧的一次性硬编码色不再残留在规则里（只允许出现在 token 定义中）', () => {
  const src = clientSource();
  // 规则里的用法必须走 var(--sgg-*)
  for (const selector of ['.sgg-ref', '.sgg-ref-current', '.sgg-ref-tag', '.sgg-add', '.sgg-del',
    '.sgg-error', '.sgg-notice', '.sgg-wt-icon', '.sgg-wt-badge-untracked', '.sgg-repo-branch']) {
    const d = cssDecls(selector);
    for (const prop of ['color', 'background', 'background-color']) {
      if (d[prop] === undefined) continue;
      assert.match(d[prop], /^var\(--sgg-/, `${selector} 的 ${prop} 应走主题 token，实际 ${d[prop]}`);
    }
  }
  // JS 内联的校验失败红框同样走 token
  assert.equal(src.includes("borderColor = '#ff7b72'"), false, '内联 borderColor 应改用 var(--sgg-danger)');
  assert.equal(src.includes("style.borderColor = 'var(--sgg-danger)'"), true);
  // diff 三色规则必须走 token
  const diff = cssDecls('.sgg-diff .d');
  assert.match(diff.color, /^var\(--sgg-del\)$/);
});

test('主题色不写进 JS 内联样式（渲染只吃 token，避免主题切换后不刷新）', () => {
  const src = clientSource();
  // PALETTE 是 var(...)，所以分支树圆点/节点填充跟着主题走
  assert.equal(src.includes("'#d29922'"), false, '不应再有硬编码泳道色');
  assert.equal(src.includes("'#79c0ff'"), false);
  assert.equal(src.includes("'#7ee787'"), false);
});
