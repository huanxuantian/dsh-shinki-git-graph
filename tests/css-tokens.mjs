/**
 * 测试共用的小工具：从 `lib/client.js` 里抽出 CSS 模板与规则/变量声明。
 *
 * 图谱渲染的接缝与配色约束由 CSS 决定（见 tests/client-load.test.mjs 的「CSS 契约」与
 * tests/theme.test.mjs 的对比度断言），所以需要一个不依赖浏览器、纯文本层面的解析器。
 * 只处理本插件用到的最简单形式：`sel{...}`、`sel1,sel2{...}`，外加 `--var:value`。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CLIENT = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'client.js');

/** `const CSS = \`...\`;` 里的 CSS 正文。 */
export function cssSource() {
  const code = readFileSync(CLIENT, 'utf8');
  const m = /const CSS = `([\s\S]*?)`;/.exec(code);
  assert.ok(m, 'client.js 应包含 CSS 模板字符串');
  return m[1];
}

/** 某条规则（选择器需完全一致，支持逗号列表写法）的声明对象。 */
export function cssDecls(selector, css = cssSource()) {
  const rule = new RegExp(`(^|\\n)\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\{([^}]*)\\}`).exec(css);
  assert.ok(rule, `CSS 里找不到规则 ${selector}`);
  return parseDecls(rule[2]);
}

/** `--sgg-*` 之类的自定义属性块（选择器同样需完全一致）。 */
export function cssVars(selector, css = cssSource()) {
  const all = {};
  for (const [k, v] of Object.entries(cssDecls(selector, css))) {
    if (k.startsWith('--')) all[k] = v;
  }
  return all;
}

function parseDecls(body) {
  const out = {};
  for (const part of body.split(';')) {
    const i = part.indexOf(':');
    if (i === -1) continue;
    const key = part.slice(0, i).trim();
    if (key) out[key] = part.slice(i + 1).trim();
  }
  return out;
}

/** 客户端 bundle 源码（内联区断言等用）。 */
export function clientSource() {
  return readFileSync(CLIENT, 'utf8');
}
