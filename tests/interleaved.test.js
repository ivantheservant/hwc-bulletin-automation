#!/usr/bin/env node
/**
 * tests/interleaved.test.js
 *
 * prompt9 第 6 部分要求的**獨立**測試檔，聚焦 `expandInterleavedRows_()`
 * 在「全寬列出現位置」這件事上的正確性——這是 prompt7 §5／prompt9 提到
 * 「本輪最容易做錯的地方」，額外開一個檔案專門鎖住，跟
 * tests/docxtemplate.test.js 既有的 11 系列測試互相補強，不是取代。
 *
 * 執行方式：node tests/interleaved.test.js
 * 離開碼：0＝全部通過　1＝有測試失敗
 */

'use strict';

const assert = require('assert');
const { loadAllSrcFilesInOrder } = require('./helpers/loadGas');
const fx = require('./fixtures/docxXml');

const sandbox = loadAllSrcFilesInOrder({
  Utilities: { formatDate: function () { return ''; } },
  Session: { getScriptTimeZone: function () { return 'Pacific/Auckland'; } },
  SpreadsheetApp: {},
  CacheService: {}
});
const { expandInterleavedRows_, findElementRanges_ } = sandbox;

let pass = 0;
let fail = 0;

function test(name, fn) {
  try {
    fn();
    pass++;
    console.log('  ✓ ' + name);
  } catch (err) {
    fail++;
    console.log('  ✗ ' + name);
    console.log('    ' + err.message);
  }
}

/** 造程序表的一般列＋全寬列兩條範本。 */
function programXml() {
  return fx.documentXml(fx.programTable());
}

/** 造一筆 PROGRAM 資料。 */
function row(item, fullWidth) {
  return { ITEM: item, CONTENT: item + '內容', POSTURE: fullWidth ? '' : '眾 立', IS_FULL_WIDTH: Boolean(fullWidth) };
}

/** 取展開結果內每一列的可見文字（用 ITEM 值判斷次序），依原始文件次序排列。 */
function extractOrder(xml, items) {
  return items.filter(function (item) { return xml.indexOf(item) !== -1; })
    .sort(function (a, b) { return xml.indexOf(a) - xml.indexOf(b); });
}

// =====================================================================
// 4. 全寬列在第一／中間／最後
// =====================================================================

test('4a. 全寬列在第一筆', function () {
  const rows = [row('祈禱會', true), row('序樂', false), row('家事報告', false)];
  const r = expandInterleavedRows_(programXml(), 'PROGRAM', rows, 'IS_FULL_WIDTH');
  assert.strictEqual(r.fullWidthRows, 1);
  assert.strictEqual(r.normalRows, 2);
  const order = ['祈禱會', '序樂', '家事報告'].filter(function (i) { return r.xml.indexOf(i) !== -1; })
    .sort(function (a, b) { return r.xml.indexOf(a) - r.xml.indexOf(b); });
  assert.deepStrictEqual(order, ['祈禱會', '序樂', '家事報告']);
});

test('4b. 全寬列在中間', function () {
  const rows = [row('序樂', false), row('祈禱會', true), row('家事報告', false)];
  const r = expandInterleavedRows_(programXml(), 'PROGRAM', rows, 'IS_FULL_WIDTH');
  const order = ['序樂', '祈禱會', '家事報告'].filter(function (i) { return r.xml.indexOf(i) !== -1; })
    .sort(function (a, b) { return r.xml.indexOf(a) - r.xml.indexOf(b); });
  assert.deepStrictEqual(order, ['序樂', '祈禱會', '家事報告']);
});

test('4c. 全寬列在最後', function () {
  const rows = [row('序樂', false), row('家事報告', false), row('祈禱會', true)];
  const r = expandInterleavedRows_(programXml(), 'PROGRAM', rows, 'IS_FULL_WIDTH');
  const order = ['序樂', '家事報告', '祈禱會'].filter(function (i) { return r.xml.indexOf(i) !== -1; })
    .sort(function (a, b) { return r.xml.indexOf(a) - r.xml.indexOf(b); });
  assert.deepStrictEqual(order, ['序樂', '家事報告', '祈禱會']);
});

// =====================================================================
// 5. 連續兩個全寬列
// =====================================================================

test('5. 連續兩個全寬列：次序與計數都正確', function () {
  const rows = [row('序樂', false), row('祈禱會', true), row('拍照', true), row('祝福', false)];
  const r = expandInterleavedRows_(programXml(), 'PROGRAM', rows, 'IS_FULL_WIDTH');
  assert.strictEqual(r.fullWidthRows, 2);
  assert.strictEqual(r.normalRows, 2);
  assert.strictEqual(r.expandedRows, 4);
  const order = ['序樂', '祈禱會', '拍照', '祝福'].filter(function (i) { return r.xml.indexOf(i) !== -1; })
    .sort(function (a, b) { return r.xml.indexOf(a) - r.xml.indexOf(b); });
  assert.deepStrictEqual(order, ['序樂', '祈禱會', '拍照', '祝福']);
});

// =====================================================================
// 6. 沒有全寬列
// =====================================================================

test('6. 沒有全寬列：全部用一般列範本，兩條原始範本都被移除', function () {
  const rows = [row('序樂', false), row('讀經', false), row('證道', false)];
  const r = expandInterleavedRows_(programXml(), 'PROGRAM', rows, 'IS_FULL_WIDTH');
  assert.strictEqual(r.fullWidthRows, 0);
  assert.strictEqual(r.normalRows, 3);
  assert.strictEqual(r.xml.indexOf('{{#EACH:PROGRAM}}'), -1);
  assert.strictEqual(r.xml.indexOf('{{#EACH:PROGRAM_FW}}'), -1);
  // 三列都是一般列（三格：項目｜內容｜立坐）。
  const trRanges = findElementRanges_(r.xml, 'w:tr');
  assert.strictEqual(trRanges.filter(function (t) { return t.depth === 0; }).length, 3);
});

// =====================================================================
// 7. 清單為空 → 兩條列範本都被刪除
// =====================================================================

test('7. 清單為空：兩條原始列範本都被刪除，結果沒有任何 <w:tr>', function () {
  const r = expandInterleavedRows_(programXml(), 'PROGRAM', [], 'IS_FULL_WIDTH');
  assert.strictEqual(r.expandedRows, 0);
  assert.strictEqual(r.xml.indexOf('{{#EACH:PROGRAM}}'), -1);
  assert.strictEqual(r.xml.indexOf('{{#EACH:PROGRAM_FW}}'), -1);
  const trRanges = findElementRanges_(r.xml, 'w:tr').filter(function (t) { return t.depth === 0; });
  assert.strictEqual(trRanges.length, 0, '兩條範本列都應該被刪除，不留一列空白');
});

// =====================================================================

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
