/**
 * i18n 完备性单测（v0.10.0）：浏览器半包里的 `t('key')` 必须都能在 zh/en 两个字典里找到，
 * 且两个字典的键集合完全一致（历史上就出过「只加一边」/「用了没定义的键」的返工）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { clientSource } from './css-tokens.mjs';

const src = clientSource();

function dict(name) {
  const m = new RegExp(`const ${name} = \\{([\\s\\S]*?)\\n    \\};`).exec(src);
  assert.ok(m, `找不到 ${name} 字典`);
  const out = {};
  for (const line of m[1].split('\n')) {
    const km = /^\s{6}([A-Za-z0-9_]+):/.exec(line);
    if (km) out[km[1]] = line;
  }
  return out;
}

const zh = dict('zh');
const en = dict('en');

test('zh / en 字典键集合完全一致', () => {
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort());
  assert.ok(Object.keys(zh).length > 150, `键太少：${Object.keys(zh).length}`);
});

test('代码里用到的每个 t(key) 都有定义', () => {
  const used = new Set([...src.matchAll(/\bt\('([A-Za-z0-9_]+)'/g)].map((m) => m[1]));
  assert.ok(used.size > 120, `t() 调用太少（${used.size}），解析可能有误`);
  const missing = [...used].filter((k) => !zh[k] || !en[k]);
  assert.deepEqual(missing, [], `缺少文案：${missing.join(', ')}`);
});

test('TAG 功能的中英文文案齐备', () => {
  for (const key of [
    'createTagHere', 'manageTags', 'tagCreateTitle', 'tagName', 'tagAnnotate', 'tagMessage', 'tagSign',
    'tagAlsoPush', 'tagPushTo', 'tagNameRequired', 'tagMessageRequired', 'tagCreated', 'tagCreatedPushed',
    'tagPushFailed', 'tagManageTitle', 'tagLocalList', 'tagAnnotatedBadge', 'tagLightweightBadge',
    'tagRemoteHas', 'tagRemoteMissing', 'tagPushSelected', 'tagDeleteSelected', 'tagFetchRemote',
    'tagDeleteTitle', 'tagDeleteDanger', 'tagDeleteCheck1', 'tagDeleteCheck2', 'tagDeleteCheck3',
    'tagDeleteBtn', 'tagDeleteAlsoRemote', 'tagDeleteRemotePick', 'tagDeleted', 'tagDeletedRemote',
  ]) {
    assert.ok(zh[key], `zh 缺 ${key}`);
    assert.ok(en[key], `en 缺 ${key}`);
  }
});

test('占位符 {name}/{remote}/{message} 在两个字典里都保留', () => {
  for (const key of ['tagCreated', 'tagCreatedPushed', 'tagPushFailed', 'tagPushed', 'tagFetched', 'tagDeleted', 'tagDeletedRemote', 'tagLocalList']) {
    const vars = new Set([...zh[key].matchAll(/\{([a-zA-Z]+)\}/g)].map((m) => m[1]));
    const varsEn = new Set([...en[key].matchAll(/\{([a-zA-Z]+)\}/g)].map((m) => m[1]));
    assert.deepEqual([...vars].sort(), [...varsEn].sort(), `${key} 的占位符不一致`);
  }
});
