#!/usr/bin/env node
/**
 * tests/eachparagraph.test.js
 *
 * prompt9 §1.1 的回歸測試：`expandEachParagraphs_()`——段落層的
 * `{{#EACHP:LIST}}` 展開，與 `expandEachRows_()`（列層）平行。
 *
 * 最重要的一組：**表格儲存格內唯一的段落不可以被刪除**（清單為空時），
 * 否則違反 OOXML「每個 `<w:tc>` 至少要有一個 `<w:p>`」的規定，Word 會
 * 判定檔案損毀、要求修復——本專案造範本時就踩過這個坑。
 *
 * 執行方式：node tests/eachparagraph.test.js
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
const {
  expandEachParagraphs_, isSoleParagraphInTableCell_,
  clearParagraphTextKeepingStructure_, findElementRanges_
} = sandbox;

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

function announcementRows(n) {
  const rows = [];
  for (let i = 1; i <= n; i++) rows.push({ NO: String(i), TEXT: '第' + i + '則' });
  return rows;
}

// =====================================================================
// 1. 段落層重複：0／1／5 筆（表格外，非唯一段落情況）
// =====================================================================

test('1a. 表格外的段落範本：5 筆資料 → 複製成 5 段，逐段替換', function () {
  const xml = fx.documentXml(
    fx.para(fx.run('{{#EACHP:ANNOUNCEMENT}}{{ANNOUNCEMENT.NO}}. {{ANNOUNCEMENT.TEXT}}'))
  );
  const r = expandEachParagraphs_(xml, 'ANNOUNCEMENT', announcementRows(5));
  assert.strictEqual(r.found, true);
  assert.strictEqual(r.expandedRows, 5);
  const paragraphs = findElementRanges_(r.xml, 'w:p').filter(function (p) { return p.depth === 0; });
  assert.strictEqual(paragraphs.length, 5, '應該複製成 5 個段落');
  assert.ok(r.xml.indexOf('3. 第3則') !== -1);
  assert.ok(r.xml.indexOf('{{#EACHP:') === -1, '標記本身要被移走');
});

test('1b. 表格外的段落範本：1 筆資料 → 只有 1 段，內容正確', function () {
  const xml = fx.documentXml(
    fx.para(fx.run('{{#EACHP:ANNOUNCEMENT}}{{ANNOUNCEMENT.TEXT}}'))
  );
  const r = expandEachParagraphs_(xml, 'ANNOUNCEMENT', announcementRows(1));
  assert.strictEqual(r.expandedRows, 1);
  assert.ok(r.xml.indexOf('第1則') !== -1);
});

test('1c. 表格外的段落範本：0 筆資料 → 整個段落刪除（不在表格內，可以刪）', function () {
  const before = fx.documentXml(
    fx.para(fx.run('前面一段')) +
    fx.para(fx.run('{{#EACHP:ANNOUNCEMENT}}{{ANNOUNCEMENT.TEXT}}')) +
    fx.para(fx.run('後面一段'))
  );
  const r = expandEachParagraphs_(before, 'ANNOUNCEMENT', []);
  assert.strictEqual(r.expandedRows, 0);
  const paragraphs = findElementRanges_(r.xml, 'w:p').filter(function (p) { return p.depth === 0; });
  assert.strictEqual(paragraphs.length, 2, '範本段落應該被整個刪走，只剩前後兩段');
  assert.ok(r.xml.indexOf('前面一段') !== -1 && r.xml.indexOf('後面一段') !== -1);
});

// =====================================================================
// 2. ⚠️ 表格內唯一段落不可刪除，改為清空文字
// =====================================================================

test('2a. 表格儲存格唯一的段落：清單為空 → 不刪除，改為清空文字，段落仍然存在', function () {
  const cellXml = fx.cell(fx.para(fx.run('{{#EACHP:ANNOUNCEMENT}}{{ANNOUNCEMENT.TEXT}}', '<w:rPr><w:b/></w:rPr>')));
  const xml = fx.documentXml(fx.table([fx.row([cellXml])]));

  const r = expandEachParagraphs_(xml, 'ANNOUNCEMENT', []);
  assert.strictEqual(r.expandedRows, 0);

  const tcRanges = findElementRanges_(r.xml, 'w:tc');
  assert.strictEqual(tcRanges.length, 1, '儲存格本身不可以被刪除');

  const paragraphsInResult = findElementRanges_(r.xml, 'w:p');
  assert.strictEqual(paragraphsInResult.length, 1, 'OOXML 規定每個 <w:tc> 至少要有一個 <w:p>，不可以變成 0 個');

  assert.ok(r.xml.indexOf('{{#EACHP:') === -1, '標記本身要被移走');

  // 用 findElementRanges_() 精確找 <w:t>（不會誤配 <w:tblPr>／<w:tcPr>
  // 這類名稱也以 "w:t" 開頭的標籤），確認內容真的被清空、但標籤還在。
  const tRanges = findElementRanges_(r.xml, 'w:t');
  assert.strictEqual(tRanges.length, 1, '應該還留有一個 <w:t>（只是清空內容）');
  const tWhole = r.xml.slice(tRanges[0].start, tRanges[0].end);
  const tOpenEnd = tWhole.indexOf('>') + 1;
  const tCloseStart = tWhole.lastIndexOf('</w:t');
  assert.strictEqual(tWhole.slice(tOpenEnd, tCloseStart), '', '文字內容應該被清空');
  assert.ok(r.xml.indexOf('<w:rPr><w:b/></w:rPr>') !== -1, '格式（<w:rPr>）要保留，不可以連格式都清掉');
});

test('2b. 表格儲存格唯一的段落：清單有資料 → 正常複製，不受「唯一段落」規則影響', function () {
  const cellXml = fx.cell(fx.para(fx.run('{{#EACHP:ANNOUNCEMENT}}{{ANNOUNCEMENT.TEXT}}')));
  const xml = fx.documentXml(fx.table([fx.row([cellXml])]));

  const r = expandEachParagraphs_(xml, 'ANNOUNCEMENT', announcementRows(3));
  assert.strictEqual(r.expandedRows, 3);
  const paragraphsInResult = findElementRanges_(r.xml, 'w:p');
  assert.strictEqual(paragraphsInResult.length, 3);
});

test('2c. isSoleParagraphInTableCell_()：儲存格有兩個段落時，範本那一段不算唯一，可以刪除', function () {
  const cellXml = fx.cell(
    fx.para(fx.run('固定標題')) +
    fx.para(fx.run('{{#EACHP:ANNOUNCEMENT}}{{ANNOUNCEMENT.TEXT}}'))
  );
  const xml = fx.documentXml(fx.table([fx.row([cellXml])]));

  const r = expandEachParagraphs_(xml, 'ANNOUNCEMENT', []);
  assert.strictEqual(r.expandedRows, 0);
  const paragraphsInResult = findElementRanges_(r.xml, 'w:p');
  assert.strictEqual(paragraphsInResult.length, 1, '範本段落要被整個刪掉，只剩「固定標題」那一段');
  assert.ok(r.xml.indexOf('固定標題') !== -1);
  assert.ok(r.xml.indexOf('{{#EACHP:') === -1);
});

test('2d. isSoleParagraphInTableCell_()：不在任何 <w:tc> 內一律回 false', function () {
  const xml = fx.documentXml(fx.para(fx.run('獨立段落')));
  const paragraphRanges = findElementRanges_(xml, 'w:p');
  assert.strictEqual(isSoleParagraphInTableCell_(xml, paragraphRanges[0]), false);
});

// =====================================================================
// 3. 表格外段落清單為空 → 段落被刪除（與 2a 對照，證明規則只針對表格內）
// =====================================================================

test('3. 表格外的段落範本清單為空 → 整段刪除（不是清空文字）', function () {
  const xml = fx.documentXml(
    fx.para(fx.run('{{#EACHP:ANNOUNCEMENT}}{{ANNOUNCEMENT.TEXT}}'))
  );
  const r = expandEachParagraphs_(xml, 'ANNOUNCEMENT', []);
  const paragraphs = findElementRanges_(r.xml, 'w:p');
  assert.strictEqual(paragraphs.length, 0, '不在表格內，清單為空應該整段刪除');
});

// =====================================================================
// 其他：clearParagraphTextKeepingStructure_、找不到標記
// =====================================================================

test('clearParagraphTextKeepingStructure_()：清空多個 <w:t> 的內容，保留其餘結構', function () {
  const p = '<w:p><w:pPr><w:jc w:val="center"/></w:pPr>'
    + '<w:r><w:t>A</w:t></w:r><w:r><w:t xml:space="preserve">B</w:t></w:r></w:p>';
  const cleared = clearParagraphTextKeepingStructure_(p);
  assert.ok(cleared.indexOf('<w:jc w:val="center"/>') !== -1);
  assert.ok(cleared.indexOf('>A<') === -1 && cleared.indexOf('>B<') === -1);
  assert.ok(cleared.indexOf('<w:t>') !== -1 && cleared.indexOf('<w:t xml:space="preserve">') !== -1);
});

test('expandEachParagraphs_()：範本內根本沒有這個段落範本 → found:false，xml 原樣不動', function () {
  const xml = fx.documentXml(fx.para(fx.run('普通內容')));
  const r = expandEachParagraphs_(xml, 'ANNOUNCEMENT', announcementRows(3));
  assert.strictEqual(r.found, false);
  assert.strictEqual(r.expandedRows, 0);
  assert.strictEqual(r.xml, xml);
});

// =====================================================================

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
