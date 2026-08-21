#!/usr/bin/env node
/**
 * tests/docxtemplate.test.js
 *
 * src/DocxTemplate.gs（純 XML 操作層）的回歸測試。
 *
 * ⚠️ 真正的 .docx 範本還未提供，測試素材一律用 tests/fixtures/docxXml.js
 * 自己造的 XML 字串——本層完全不碰 Google 服務，所以這樣測得到全部行為。
 *
 * 執行方式：node tests/docxtemplate.test.js
 * 離開碼：0＝全部通過　1＝有測試失敗
 */

'use strict';

const assert = require('assert');
const { loadAllSrcFilesInOrder } = require('./helpers/loadGas');
const fx = require('./fixtures/docxXml');

const GAS_STUBS = {
  Utilities: { formatDate: function () { return ''; } },
  Session: {
    getScriptTimeZone: function () { return 'Pacific/Auckland'; },
    getActiveUser: function () { return { getEmail: function () { return 'tester@x.com'; } }; }
  },
  SpreadsheetApp: {},
  CacheService: {},
  HtmlService: {}
};

const sandbox = loadAllSrcFilesInOrder(GAS_STUBS);
const {
  escapeXmlText_, toWordText_, mergeRunsInParagraphs_, findPlaceholders_,
  findBrokenPlaceholders_, replaceSimplePlaceholders_, expandEachRows_,
  expandInterleavedRows_, applyConditionalRows_, applyConditionalParagraphs_,
  renderDocumentXml_, findElementRanges_, isTruthyForTemplate_
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

/**
 * 陣列比較。⚠️ 不可以用 assert.deepStrictEqual()——sandbox 內造出來的
 * 陣列跟外層 Node 的 Array 不是同一個 realm 的建構子，deepStrictEqual
 * 會報「same structure but not reference-equal」。轉成 JSON 比較就沒事。
 */
function assertArrayEqual(actual, expected, message) {
  assert.strictEqual(JSON.stringify(actual), JSON.stringify(expected), message);
}

/**
 * 把 XML 內全部 <w:t> 的文字串起來，並把實體還原，方便斷言
 * 「Word 最後顯示出來是什麼」。
 *
 * ⚠️ 一定要還原 &#123;／&#125;：toWordText_() 刻意把值裡面的大括號換成
 * 數值參照來防二次替換（見 src/DocxTemplate.gs），但 Word 顯示出來仍然
 * 是 `{` 與 `}`，測試要斷言的是後者。
 */
function visibleText(xml) {
  const out = [];
  const pattern = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g;
  let m;
  while ((m = pattern.exec(xml)) !== null) out.push(m[1]);
  return out.join('')
    .split('&#123;').join('{')
    .split('&#125;').join('}')
    .split('&lt;').join('<')
    .split('&gt;').join('>')
    .split('&amp;').join('&');
}

/** 數某個標籤出現多少次（開標籤）。 */
function countTag(xml, tag) {
  const ranges = findElementRanges_(xml, tag);
  return ranges.length;
}

// =====================================================================
// 1–3. mergeRunsInParagraphs_
// =====================================================================

test('1. mergeRunsInParagraphs_：{{／SERMON／_TITLE}} 三個 run 合併後可以被替換', function () {
  const xml = fx.documentXml(fx.splitPlaceholderParagraph(['{{', 'SERMON', '_TITLE}}']));
  assert.strictEqual(
    replaceSimplePlaceholders_(xml, { SERMON_TITLE: '主是我牧者' }, 'BLANK').replacedCount, 0,
    '前提：未合併之前一定替換不到（這正是這個 bug 的可怕之處）'
  );

  const merged = mergeRunsInParagraphs_(xml);
  const result = replaceSimplePlaceholders_(merged, { SERMON_TITLE: '主是我牧者' }, 'BLANK');
  assert.strictEqual(result.replacedCount, 1);
  assert.strictEqual(visibleText(result.xml), '主是我牧者');
});

test('1b. mergeRunsInParagraphs_：切成五片一樣合併得到', function () {
  const xml = fx.documentXml(fx.splitPlaceholderParagraph(['{', '{SER', 'MON_', 'TITLE}', '}']));
  const merged = mergeRunsInParagraphs_(xml);
  const result = replaceSimplePlaceholders_(merged, { SERMON_TITLE: 'X' }, 'BLANK');
  assert.strictEqual(result.replacedCount, 1);
});

test('2. mergeRunsInParagraphs_：格式不同的相鄰 run 不會被合併', function () {
  const boldRPr = '<w:rPr><w:b/></w:rPr>';
  const plainRPr = '<w:rPr><w:i/></w:rPr>';
  const xml = fx.documentXml(fx.para(
    fx.run('{{', boldRPr) + fx.run('SERMON_TITLE}}', plainRPr)
  ));
  const merged = mergeRunsInParagraphs_(xml);
  assert.strictEqual(countTag(merged, 'w:r'), 2, '格式不同就不可以合併，否則會丟失格式');
  assert.ok(merged.indexOf('<w:b/>') !== -1 && merged.indexOf('<w:i/>') !== -1);
});

test('2b. mergeRunsInParagraphs_：不同段落的 run 不會互相合併', function () {
  const xml = fx.documentXml(fx.para(fx.run('{{')) + fx.para(fx.run('SERMON_TITLE}}')));
  const merged = mergeRunsInParagraphs_(xml);
  assert.strictEqual(countTag(merged, 'w:r'), 2);
});

test('2c. mergeRunsInParagraphs_：含 <w:drawing> 的 run 不會被合併（不可以丟失圖片）', function () {
  const drawingRun = '<w:r><w:drawing><wp:inline/></w:drawing></w:r>';
  const xml = fx.documentXml(fx.para(fx.run('A') + drawingRun + fx.run('B')));
  const merged = mergeRunsInParagraphs_(xml);
  assert.ok(merged.indexOf('<w:drawing>') !== -1, '圖片必須原封不動保留');
  assert.strictEqual(countTag(merged, 'w:r'), 3, '圖片 run 兩邊的文字 run 不可以跨過它合併');
});

test('3. mergeRunsInParagraphs_：合併結果一律帶 xml:space="preserve"（空白不可以被吃掉）', function () {
  const xml = fx.documentXml(fx.para(fx.run('祈禱會 ', '', true) + fx.run('眾坐', '', true)));
  const merged = mergeRunsInParagraphs_(xml);
  assert.ok(merged.indexOf('xml:space="preserve"') !== -1);
  assert.strictEqual(visibleText(merged), '祈禱會 眾坐', '中間那個空格必須保留');
});

test('3b. mergeRunsInParagraphs_：沒有可合併的 run 時原樣回傳', function () {
  const xml = fx.documentXml(fx.para(fx.run('單獨一個 run')));
  assert.strictEqual(mergeRunsInParagraphs_(xml), xml);
});

test('3c. mergeRunsInParagraphs_：文字方塊內的巢狀段落各自合併，不會跟外層混在一起', function () {
  const inner = fx.para(fx.run('{{') + fx.run('FLOWER_THIS_WEEK}}'));
  const textbox = '<w:r><mc:AlternateContent><w:txbxContent>' + inner + '</w:txbxContent></mc:AlternateContent></w:r>';
  const xml = fx.documentXml(fx.para(fx.run('{{') + fx.run('PAGE_TITLE}}') + textbox));
  const merged = mergeRunsInParagraphs_(xml);
  const result = replaceSimplePlaceholders_(merged, { PAGE_TITLE: '崇拜程序', FLOWER_THIS_WEEK: '假甲' }, 'BLANK');
  assert.strictEqual(result.replacedCount, 2, '內外兩個佔位符都要合併得到並替換得到');
});

// =====================================================================
// 4. findBrokenPlaceholders_
// =====================================================================

test('4. findBrokenPlaceholders_：孤立的 {{（有頭無尾）被偵測到', function () {
  const xml = fx.documentXml(fx.para(fx.run('{{SERMON_TITLE 忘記收尾')));
  const broken = findBrokenPlaceholders_(xml);
  assert.strictEqual(broken.length, 1);
  assert.strictEqual(broken[0].kind, 'UNCLOSED');
});

test('4b. findBrokenPlaceholders_：合併不了而跨 <w:t> 的佔位符被偵測到', function () {
  // 中間夾書籤 ⇒ mergeRunsInParagraphs_ 刻意不合併 ⇒ 應該被報出來
  const xml = fx.documentXml(fx.para(
    fx.run('{{') + '<w:bookmarkStart w:id="1" w:name="x"/>' + fx.run('SERMON_TITLE}}')
  ));
  const merged = mergeRunsInParagraphs_(xml);
  const broken = findBrokenPlaceholders_(merged);
  assert.strictEqual(broken.length, 1, JSON.stringify(broken));
  assert.strictEqual(broken[0].kind, 'SPLIT_ACROSS_RUNS');
  assert.strictEqual(broken[0].text, '{{SERMON_TITLE}}');
});

test('4c. findBrokenPlaceholders_：完好的佔位符不會被誤報', function () {
  const xml = fx.documentXml(fx.para(fx.run('{{SERMON_TITLE}}')));
  assertArrayEqual(findBrokenPlaceholders_(xml), []);
});

test('4d. findBrokenPlaceholders_：孤立的 }}（有尾無頭）被偵測到', function () {
  const xml = fx.documentXml(fx.para(fx.run('SERMON_TITLE}} 前面漏了開頭')));
  const broken = findBrokenPlaceholders_(xml);
  assert.strictEqual(broken.length, 1);
  assert.strictEqual(broken[0].kind, 'UNOPENED');
});

// =====================================================================
// 5. escapeXmlText_
// =====================================================================

test('5. escapeXmlText_：& < > 三個都轉義', function () {
  assert.strictEqual(escapeXmlText_('a & b < c > d'), 'a &amp; b &lt; c &gt; d');
});

test('5b. escapeXmlText_：已經轉義過的實體不會被重複轉義', function () {
  assert.strictEqual(escapeXmlText_('a &amp; b'), 'a &amp; b');
  assert.strictEqual(escapeXmlText_('&lt;&gt;&quot;&apos;&#39;&#x27;'), '&lt;&gt;&quot;&apos;&#39;&#x27;');
});

test('5c. escapeXmlText_：不是實體的 & 照樣轉義', function () {
  assert.strictEqual(escapeXmlText_('R&D'), 'R&amp;D');
  assert.strictEqual(escapeXmlText_('&notanentity'), '&amp;notanentity');
});

test('5d. escapeXmlText_：null／undefined 當空字串', function () {
  assert.strictEqual(escapeXmlText_(null), '');
  assert.strictEqual(escapeXmlText_(undefined), '');
  assert.strictEqual(escapeXmlText_(0), '0');
});

// =====================================================================
// 6. toWordText_
// =====================================================================

test('6. toWordText_：\\n 轉成 <w:br/>', function () {
  const out = toWordText_('第一行\n第二行');
  assert.strictEqual(out, '第一行</w:t><w:br/><w:t xml:space="preserve">第二行');
});

test('6b. toWordText_：連續兩個 \\n 產生兩個 <w:br/>', function () {
  const out = toWordText_('a\n\nb');
  assert.strictEqual((out.match(/<w:br\/>/g) || []).length, 2);
});

test('6c. toWordText_：\\r\\n 與 \\r 一樣正規化（Windows 貼上來的文字）', function () {
  assert.strictEqual((toWordText_('a\r\nb').match(/<w:br\/>/g) || []).length, 1);
  assert.strictEqual((toWordText_('a\rb').match(/<w:br\/>/g) || []).length, 1);
});

test('6d. toWordText_：換行同時仍然做 XML 轉義', function () {
  assert.ok(toWordText_('a & b\nc < d').indexOf('&amp;') !== -1);
  assert.ok(toWordText_('a & b\nc < d').indexOf('&lt;') !== -1);
});

test('6e. toWordText_：沒有換行時就是單純的轉義', function () {
  assert.strictEqual(toWordText_('普通文字'), '普通文字');
});

// =====================================================================
// 7. replaceSimplePlaceholders_ 三種 mode
// =====================================================================

test('7. replaceSimplePlaceholders_ mode=BLANK：找不到值換成空字串', function () {
  const r = replaceSimplePlaceholders_('<w:t>{{A}}|{{B}}</w:t>', { A: '有值' }, 'BLANK');
  assert.strictEqual(r.xml, '<w:t>有值|</w:t>');
  assert.strictEqual(r.replacedCount, 1);
  assertArrayEqual(r.missingKeys, ['B']);
});

test('7b. replaceSimplePlaceholders_ mode=KEEP：找不到值原樣保留', function () {
  const r = replaceSimplePlaceholders_('<w:t>{{A}}|{{B}}</w:t>', { A: '有值' }, 'KEEP');
  assert.strictEqual(r.xml, '<w:t>有值|{{B}}</w:t>');
  assertArrayEqual(r.missingKeys, ['B']);
});

test('7c. replaceSimplePlaceholders_ mode=ERROR：找不到值就拋錯，訊息含佔位符名稱', function () {
  assert.throws(
    function () { replaceSimplePlaceholders_('<w:t>{{B}}</w:t>', {}, 'ERROR'); },
    function (err) { return err.message.indexOf('{{B}}') !== -1; }
  );
});

test('7d. replaceSimplePlaceholders_：空字串是合法的值，不算「找不到」', function () {
  const r = replaceSimplePlaceholders_('<w:t>{{A}}</w:t>', { A: '' }, 'ERROR');
  assert.strictEqual(r.xml, '<w:t></w:t>');
  assert.strictEqual(r.replacedCount, 1);
  assertArrayEqual(r.missingKeys, []);
});

test('7e. replaceSimplePlaceholders_：不會碰清單欄位佔位符（含點的）', function () {
  const r = replaceSimplePlaceholders_('<w:t>{{PROGRAM.ITEM}}</w:t>', { A: 'x' }, 'BLANK');
  assert.strictEqual(r.xml, '<w:t>{{PROGRAM.ITEM}}</w:t>', '清單欄位由 expandEachRows_ 負責，單值替換一定不可以碰');
  assertArrayEqual(r.missingKeys, []);
});

test('7f. replaceSimplePlaceholders_：值會經過 XML 轉義', function () {
  const r = replaceSimplePlaceholders_('<w:t>{{A}}</w:t>', { A: '弟兄 & 姊妹' }, 'BLANK');
  assert.strictEqual(r.xml, '<w:t>弟兄 &amp; 姊妹</w:t>');
});

// =====================================================================
// 8. expandEachRows_
// =====================================================================

function announcementTable() {
  return fx.table([
    fx.row([fx.cell(fx.para(fx.run('{{#EACH:ANNOUNCEMENT}}{{ANNOUNCEMENT.NO}}'))),
      fx.cell(fx.para(fx.run('{{ANNOUNCEMENT.TEXT}}')))])
  ]);
}

test('8. expandEachRows_：0 筆 → 整列刪除', function () {
  const xml = fx.documentXml(announcementTable());
  const r = expandEachRows_(xml, 'ANNOUNCEMENT', []);
  assert.strictEqual(r.expandedRows, 0);
  assert.strictEqual(countTag(r.xml, 'w:tr'), 0, '空清單要整列刪除，不可以留一列空白');
  assert.strictEqual(r.xml.indexOf('{{#EACH:'), -1);
});

test('8b. expandEachRows_：1 筆', function () {
  const xml = fx.documentXml(announcementTable());
  const r = expandEachRows_(xml, 'ANNOUNCEMENT', [{ NO: '1', TEXT: '第一則' }]);
  assert.strictEqual(r.expandedRows, 1);
  assert.strictEqual(countTag(r.xml, 'w:tr'), 1);
  assert.strictEqual(visibleText(r.xml), '1第一則');
});

test('8c. expandEachRows_：5 筆，次序正確', function () {
  const xml = fx.documentXml(announcementTable());
  const rows = [1, 2, 3, 4, 5].map(function (n) { return { NO: String(n), TEXT: '項目' + n }; });
  const r = expandEachRows_(xml, 'ANNOUNCEMENT', rows);
  assert.strictEqual(r.expandedRows, 5);
  assert.strictEqual(countTag(r.xml, 'w:tr'), 5);
  assert.strictEqual(visibleText(r.xml), '1項目12項目23項目34項目45項目5');
});

test('8d. expandEachRows_：範本沒有這個列範本時 found=false，XML 不變', function () {
  const xml = fx.documentXml(announcementTable());
  const r = expandEachRows_(xml, 'PRAYER', [{ NO: '1', TEXT: 'x' }]);
  assert.strictEqual(r.found, false);
  assert.strictEqual(r.xml, xml);
});

test('8e. expandEachRows_：資料缺少某個欄位 → 換成空字串，不拋錯', function () {
  const xml = fx.documentXml(announcementTable());
  const r = expandEachRows_(xml, 'ANNOUNCEMENT', [{ NO: '1' }]);
  assert.strictEqual(visibleText(r.xml), '1');
});

test('8f. expandEachRows_：巢狀表格內的列範本，只影響最內層那一列', function () {
  const innerTable = fx.table([
    fx.row([fx.cell(fx.para(fx.run('{{#EACH:ANNOUNCEMENT}}{{ANNOUNCEMENT.TEXT}}')))])
  ]);
  const outer = fx.table([fx.row([fx.cell(innerTable)])]);
  const xml = fx.documentXml(outer);
  const r = expandEachRows_(xml, 'ANNOUNCEMENT', [{ TEXT: 'A' }, { TEXT: 'B' }]);
  assert.strictEqual(r.expandedRows, 2);
  // 外層那一列必須仍然在（1 外層 + 2 內層 = 3）
  assert.strictEqual(countTag(r.xml, 'w:tr'), 3, '外層的列不可以被砍掉——這就是「不要用正則硬拆 <w:tr>」那條規則');
  assert.strictEqual(visibleText(r.xml), 'AB');
});

test('8g. expandEachRows_：值含換行會變成 <w:br/>', function () {
  const xml = fx.documentXml(announcementTable());
  const r = expandEachRows_(xml, 'ANNOUNCEMENT', [{ NO: '1', TEXT: '第一行\n第二行' }]);
  assert.ok(r.xml.indexOf('<w:br/>') !== -1);
});

// =====================================================================
// 9. applyConditionalRows_ / applyConditionalParagraphs_
// =====================================================================

test('9. applyConditionalRows_：空值 → 整列刪除', function () {
  const xml = fx.documentXml(fx.table([
    fx.row([fx.cell(fx.para(fx.run('{{#IF:CHOIR_TITLE}}詩班')))]),
    fx.row([fx.cell(fx.para(fx.run('固定列')))])
  ]));
  const r = applyConditionalRows_(xml, { CHOIR_TITLE: '' });
  assert.strictEqual(r.removed, 1);
  assert.strictEqual(countTag(r.xml, 'w:tr'), 1);
  assert.strictEqual(visibleText(r.xml), '固定列');
});

test('9b. applyConditionalRows_：有值 → 保留並移除標記本身', function () {
  const xml = fx.documentXml(fx.table([
    fx.row([fx.cell(fx.para(fx.run('{{#IF:CHOIR_TITLE}}詩班')))])
  ]));
  const r = applyConditionalRows_(xml, { CHOIR_TITLE: '奇異恩典' });
  assert.strictEqual(r.kept, 1);
  assert.strictEqual(countTag(r.xml, 'w:tr'), 1);
  assert.strictEqual(visibleText(r.xml), '詩班');
  assert.strictEqual(r.xml.indexOf('{{#IF:'), -1);
});

test('9c. applyConditionalParagraphs_：{{#IFP:}} 作用於段落而不是列', function () {
  const xml = fx.documentXml(
    fx.para(fx.run('{{#IFP:FLOWER_THIS_WEEK}}本週獻花'))
    + fx.para(fx.run('固定段落'))
  );
  const removed = applyConditionalParagraphs_(xml, { FLOWER_THIS_WEEK: '' });
  assert.strictEqual(removed.removed, 1);
  assert.strictEqual(visibleText(removed.xml), '固定段落');

  const kept = applyConditionalParagraphs_(xml, { FLOWER_THIS_WEEK: '假甲' });
  assert.strictEqual(kept.kept, 1);
  assert.strictEqual(visibleText(kept.xml), '本週獻花固定段落');
});

test('9d. isTruthyForTemplate_：數字 0 與字串 "0" 算有值（人數表的 0 是有意義的資料）', function () {
  assert.strictEqual(isTruthyForTemplate_(0), true);
  assert.strictEqual(isTruthyForTemplate_('0'), true);
  assert.strictEqual(isTruthyForTemplate_(''), false);
  assert.strictEqual(isTruthyForTemplate_('   '), false);
  assert.strictEqual(isTruthyForTemplate_(null), false);
  assert.strictEqual(isTruthyForTemplate_(undefined), false);
  assert.strictEqual(isTruthyForTemplate_(false), false);
});

test('9e. applyConditionalRows_：同一列有兩個 {{#IF:}} 標記時由第一個決定去留', function () {
  const xml = fx.documentXml(fx.table([
    fx.row([fx.cell(fx.para(fx.run('{{#IF:A}}x'))), fx.cell(fx.para(fx.run('{{#IF:B}}y')))])
  ]));
  const r = applyConditionalRows_(xml, { A: '', B: '有值' });
  assert.strictEqual(r.removed, 1, '第一個標記的值是空的，整列刪除');
});

// =====================================================================
// 10–11. expandInterleavedRows_（本輪最容易做錯的地方）
// =====================================================================

function programRows(spec) {
  return spec.map(function (s) {
    return { ITEM: s.item || '', CONTENT: s.content || '', POSTURE: s.posture || '', IS_FULL_WIDTH: Boolean(s.fw) };
  });
}

test('10. expandInterleavedRows_：一般列與全寬列交錯出現，次序正確', function () {
  const xml = fx.documentXml(fx.programTable());
  const rows = programRows([
    { item: '序樂', content: '安靜', posture: '眾 立' },
    { item: '家事報告', content: '', posture: '眾 坐' },
    { content: '祈禱會', fw: true },
    { item: '祝福', content: '', posture: '眾 立' }
  ]);
  const r = expandInterleavedRows_(xml, 'PROGRAM', rows, 'IS_FULL_WIDTH');

  assert.strictEqual(r.expandedRows, 4);
  assert.strictEqual(r.normalRows, 3);
  assert.strictEqual(r.fullWidthRows, 1);
  assert.strictEqual(countTag(r.xml, 'w:tr'), 4, '兩個原始列範本都要刪掉，只剩展開出來的 4 列');
  assert.strictEqual(
    visibleText(r.xml), '序樂安靜眾 立家事報告眾 坐祈禱會祝福眾 立',
    '「祈禱會」必須夾在「家事報告」與「祝福」之間——這就是交錯的意義'
  );
});

test('10b. expandInterleavedRows_：全寬列真的用了全寬列範本（只有一個儲存格）', function () {
  const xml = fx.documentXml(fx.programTable());
  const r = expandInterleavedRows_(xml, 'PROGRAM', programRows([{ content: '祈禱會', fw: true }]), 'IS_FULL_WIDTH');
  assert.strictEqual(countTag(r.xml, 'w:tc'), 1, '全寬列範本只有一個儲存格');
});

test('10c. expandInterleavedRows_：一般列真的用了一般列範本（三個儲存格）', function () {
  const xml = fx.documentXml(fx.programTable());
  const r = expandInterleavedRows_(xml, 'PROGRAM', programRows([{ item: '序樂', content: 'x', posture: '眾 立' }]), 'IS_FULL_WIDTH');
  assert.strictEqual(countTag(r.xml, 'w:tc'), 3);
});

test('11. expandInterleavedRows_：全寬列在最後一筆', function () {
  const xml = fx.documentXml(fx.programTable());
  const r = expandInterleavedRows_(xml, 'PROGRAM', programRows([
    { item: 'A', content: '1', posture: '立' },
    { item: 'B', content: '2', posture: '坐' },
    { content: '全寬', fw: true }
  ]), 'IS_FULL_WIDTH');
  assert.strictEqual(visibleText(r.xml), 'A1立B2坐全寬');
});

test('11b. expandInterleavedRows_：全寬列在第一筆', function () {
  const xml = fx.documentXml(fx.programTable());
  const r = expandInterleavedRows_(xml, 'PROGRAM', programRows([
    { content: '全寬', fw: true },
    { item: 'A', content: '1', posture: '立' }
  ]), 'IS_FULL_WIDTH');
  assert.strictEqual(visibleText(r.xml), '全寬A1立');
});

test('11c. expandInterleavedRows_：全寬列在中間', function () {
  const xml = fx.documentXml(fx.programTable());
  const r = expandInterleavedRows_(xml, 'PROGRAM', programRows([
    { item: 'A', content: '1', posture: '立' },
    { content: '全寬', fw: true },
    { item: 'B', content: '2', posture: '坐' }
  ]), 'IS_FULL_WIDTH');
  assert.strictEqual(visibleText(r.xml), 'A1立全寬B2坐');
});

test('11d. expandInterleavedRows_：連續兩個全寬列', function () {
  const xml = fx.documentXml(fx.programTable());
  const r = expandInterleavedRows_(xml, 'PROGRAM', programRows([
    { content: '全寬一', fw: true },
    { content: '全寬二', fw: true }
  ]), 'IS_FULL_WIDTH');
  assert.strictEqual(r.fullWidthRows, 2);
  assert.strictEqual(visibleText(r.xml), '全寬一全寬二');
});

test('11e. expandInterleavedRows_：空清單 → 兩個列範本都刪掉', function () {
  const xml = fx.documentXml(fx.programTable());
  const r = expandInterleavedRows_(xml, 'PROGRAM', [], 'IS_FULL_WIDTH');
  assert.strictEqual(countTag(r.xml, 'w:tr'), 0);
  assert.strictEqual(r.xml.indexOf('{{#EACH:'), -1);
});

test('11f. expandInterleavedRows_：只有一般列範本時退回單一模式並記 warning', function () {
  const xml = fx.documentXml(fx.table([
    fx.row([fx.cell(fx.para(fx.run('{{#EACH:PROGRAM}}{{PROGRAM.CONTENT}}')))])
  ]));
  const r = expandInterleavedRows_(xml, 'PROGRAM', programRows([
    { content: 'A' }, { content: '全寬', fw: true }
  ]), 'IS_FULL_WIDTH');
  assert.strictEqual(r.expandedRows, 2);
  assert.strictEqual(r.warnings.length, 1);
  assert.strictEqual(r.warnings[0].code, 'NO_FULL_WIDTH_ROW_TEMPLATE');
  assert.strictEqual(visibleText(r.xml), 'A全寬');
});

test('11g. expandInterleavedRows_：全寬列範本內用 {{PROGRAM_FW.CONTENT}} 也認得', function () {
  const xml = fx.documentXml(fx.table([
    fx.row([fx.cell(fx.para(fx.run('{{#EACH:PROGRAM}}{{PROGRAM.ITEM}}')))]),
    fx.row([fx.cell(fx.para(fx.run('{{#EACH:PROGRAM_FW}}{{PROGRAM_FW.CONTENT}}')))])
  ]));
  const r = expandInterleavedRows_(xml, 'PROGRAM', programRows([
    { item: 'A' }, { content: '全寬', fw: true }
  ]), 'IS_FULL_WIDTH');
  assert.strictEqual(visibleText(r.xml), 'A全寬');
});

test('11h. expandInterleavedRows_：兩個列範本都沒有時 found=false，XML 不變', function () {
  const xml = fx.documentXml(fx.para(fx.run('沒有程序表')));
  const r = expandInterleavedRows_(xml, 'PROGRAM', programRows([{ item: 'A' }]), 'IS_FULL_WIDTH');
  assert.strictEqual(r.found, false);
  assert.strictEqual(r.xml, xml);
});

// =====================================================================
// 12. 執行次序（用測試鎖住）
// =====================================================================

test('12. 執行次序：先展開重複列再替換單值——列範本內的單值佔位符每一列都要被替換', function () {
  const xml = fx.documentXml(fx.table([
    fx.row([fx.cell(fx.para(fx.run('{{#EACH:ANNOUNCEMENT}}{{CHURCH_NAME}}：{{ANNOUNCEMENT.TEXT}}')))])
  ]));
  const result = renderDocumentXml_(xml, {
    values: { CHURCH_NAME: '聖道堂' },
    lists: { ANNOUNCEMENT: [{ TEXT: '甲' }, { TEXT: '乙' }] }
  });
  assert.strictEqual(visibleText(result.xml), '聖道堂：甲聖道堂：乙',
    '每一列都要有教會名稱；如果次序顛倒（先替換單值），只有第一列會有，其餘會是空的');
});

test('12b. 執行次序（反向鎖）：單值替換一定發生在展開之後——用替換次數鎖死', function () {
  // ⚠️ 為什麼用「替換次數」而不是「最後的文字」來鎖：
  // 單值佔位符的值在每一列都一樣，所以兩種次序印出來的**文字剛好相同**，
  // 用文字比較根本鎖不住次序。真正的差別在於**替換了幾多次**：
  //   正確次序（先展開）→ 2 列各替換一次 = 2
  //   顛倒次序（先單值）→ 範本只有一列，替換一次 = 1，之後才複製
  // 這個數字會出現在選單的產生報告上，本身也是要對的。
  const xml = fx.documentXml(fx.table([
    fx.row([fx.cell(fx.para(fx.run('{{#EACH:ANNOUNCEMENT}}{{CHURCH_NAME}}：{{ANNOUNCEMENT.TEXT}}')))])
  ]));

  const correct = renderDocumentXml_(xml, {
    values: { CHURCH_NAME: '聖道堂' },
    lists: { ANNOUNCEMENT: [{ TEXT: '甲' }, { TEXT: '乙' }] }
  });
  assert.strictEqual(correct.stats.replacedCount, 2, '展開成 2 列之後，每一列各替換一次');

  // 刻意用錯的次序，證明它真的算出不同（錯誤）的結果
  const wrongFirstPass = replaceSimplePlaceholders_(xml, { CHURCH_NAME: '聖道堂' }, 'BLANK');
  assert.strictEqual(wrongFirstPass.replacedCount, 1,
    '顛倒次序只會替換一次——這就是為什麼次序不可以調轉');
});

test('12c. 執行次序：條件列排在展開之後，對展開出來的列也生效', function () {
  const xml = fx.documentXml(fx.table([
    fx.row([fx.cell(fx.para(fx.run('{{#EACH:ANNOUNCEMENT}}{{#IF:SHOW_ANN}}{{ANNOUNCEMENT.TEXT}}')))])
  ]));
  const result = renderDocumentXml_(xml, {
    values: { SHOW_ANN: '' },
    lists: { ANNOUNCEMENT: [{ TEXT: '甲' }, { TEXT: '乙' }] }
  });
  assert.strictEqual(countTag(result.xml, 'w:tr'), 0, '展開出來的兩列都要被條件刪掉');
});

// =====================================================================
// 13–14. 其他規約細節
// =====================================================================

test('13. 佔位符名稱可以含數字與底線', function () {
  const r = replaceSimplePlaceholders_('<w:t>{{ATT_ENG_WORSHIP}}|{{COL1}}</w:t>', { ATT_ENG_WORSHIP: '120', COL1: 'A' }, 'BLANK');
  assert.strictEqual(r.xml, '<w:t>120|A</w:t>');
  assert.strictEqual(r.replacedCount, 2);
});

test('13b. 佔位符只認大寫：小寫的不會被當成佔位符', function () {
  const r = replaceSimplePlaceholders_('<w:t>{{lowercase}}</w:t>', { lowercase: 'x' }, 'BLANK');
  assert.strictEqual(r.xml, '<w:t>{{lowercase}}</w:t>');
  assert.strictEqual(r.replacedCount, 0);
});

test('14. 值本身含 {{ }} 不會被二次替換', function () {
  const r = replaceSimplePlaceholders_('<w:t>{{A}}</w:t>', { A: '{{B}}', B: '不應該出現' }, 'BLANK');
  assert.strictEqual(visibleText(r.xml), '{{B}}', '值裡面的大括號只是普通文字，不可以再被當成佔位符');
  assert.strictEqual(r.replacedCount, 1);
});

test('14b. 清單資料的值含 {{ }} 同樣不會被二次替換', function () {
  const xml = fx.documentXml(announcementTable());
  const r = expandEachRows_(xml, 'ANNOUNCEMENT', [{ NO: '1', TEXT: '{{NO}}' }]);
  const after = replaceSimplePlaceholders_(r.xml, { NO: '不應該出現' }, 'KEEP');
  assert.strictEqual(after.replacedCount, 0);
});

// =====================================================================
// findPlaceholders_
// =====================================================================

test('findPlaceholders_：五種類型都認得出來，而且去重', function () {
  const xml = '<w:t>{{SERMON_TITLE}}{{SERMON_TITLE}}{{#EACH:PROGRAM}}{{PROGRAM.ITEM}}{{#IF:A}}{{#IFP:B}}</w:t>';
  const found = findPlaceholders_(xml);
  const byType = {};
  found.forEach(function (p) { byType[p.type] = (byType[p.type] || 0) + 1; });
  assert.strictEqual(byType.SIMPLE, 1, '重複的只算一次');
  assert.strictEqual(byType.EACH, 1);
  assert.strictEqual(byType.FIELD, 1);
  assert.strictEqual(byType.IF, 1);
  assert.strictEqual(byType.IFP, 1);
});

test('findPlaceholders_：name 已經去掉前綴', function () {
  const found = findPlaceholders_('<w:t>{{#EACH:PROGRAM}}{{#IF:CHOIR_TITLE}}</w:t>');
  const each = found.filter(function (p) { return p.type === 'EACH'; })[0];
  const cond = found.filter(function (p) { return p.type === 'IF'; })[0];
  assert.strictEqual(each.name, 'PROGRAM');
  assert.strictEqual(cond.name, 'CHOIR_TITLE');
});

// =====================================================================
// findElementRanges_（巢狀配對的基礎）
// =====================================================================

test('findElementRanges_：巢狀 <w:tr> 正確配對，depth 正確', function () {
  const inner = fx.table([fx.row([fx.cell(fx.para(fx.run('inner')))])]);
  const xml = fx.table([fx.row([fx.cell(inner)])]);
  const ranges = findElementRanges_(xml, 'w:tr');
  assert.strictEqual(ranges.length, 2);
  assert.strictEqual(ranges[0].depth, 0, '外層列 depth=0');
  assert.strictEqual(ranges[1].depth, 1, '內層列 depth=1');
  assert.ok(ranges[0].start < ranges[1].start && ranges[0].end > ranges[1].end, '外層必須完整包住內層');
});

test('findElementRanges_：不會把 <w:trPr> 當成 <w:tr>', function () {
  const xml = '<w:tr><w:trPr><w:trHeight w:val="200"/></w:trPr></w:tr>';
  const ranges = findElementRanges_(xml, 'w:tr');
  assert.strictEqual(ranges.length, 1, '只有一個 <w:tr>；<w:trPr> 是另一個標籤');
});

test('findElementRanges_：自閉標籤也算一個元素', function () {
  const ranges = findElementRanges_('<w:p/><w:p></w:p>', 'w:p');
  assert.strictEqual(ranges.length, 2);
});

test('findElementRanges_：屬性值內的 > 不會被當成標籤結束', function () {
  const xml = '<w:p w:note="a &gt; b"><w:r/></w:p>';
  const ranges = findElementRanges_(xml, 'w:p');
  assert.strictEqual(ranges.length, 1);
  assert.strictEqual(ranges[0].end, xml.length);
});

// =====================================================================
// renderDocumentXml_ 總入口
// =====================================================================

test('renderDocumentXml_：完整流程——合併 run、展開、條件、單值一次做完', function () {
  const xml = fx.documentXml(
    fx.splitPlaceholderParagraph(['{{', 'SERMON', '_TITLE}}'])
    + fx.programTable()
    + fx.table([fx.row([fx.cell(fx.para(fx.run('{{#IF:CHOIR_TITLE}}詩班頌唱')))])])
  );
  const result = renderDocumentXml_(xml, {
    values: { SERMON_TITLE: '主是我牧者', CHOIR_TITLE: '' },
    lists: { PROGRAM: programRows([{ item: '序樂', content: '安靜', posture: '眾 立' }, { content: '祈禱會', fw: true }]) },
    interleavedLists: { PROGRAM: 'IS_FULL_WIDTH' }
  });

  assert.strictEqual(result.stats.replacedCount, 1);
  assert.strictEqual(result.stats.expandedRows, 2);
  assert.strictEqual(result.stats.removedRows, 1);
  assert.strictEqual(visibleText(result.xml), '主是我牧者序樂安靜眾 立祈禱會');
  assert.strictEqual(result.xml.indexOf('{{'), -1, '成品不可以殘留任何佔位符');
});

test('renderDocumentXml_：被切斷的佔位符收集成 warning，但不中斷', function () {
  const xml = fx.documentXml(fx.para(
    fx.run('{{') + '<w:bookmarkStart w:id="1" w:name="x"/>' + fx.run('SERMON_TITLE}}')
  ));
  let result;
  assert.doesNotThrow(function () {
    result = renderDocumentXml_(xml, { values: { SERMON_TITLE: 'X' }, lists: {} });
  });
  assert.strictEqual(result.stats.broken.length, 1);
  assert.ok(result.warnings.some(function (w) { return w.code === 'BROKEN_PLACEHOLDER'; }));
});

test('renderDocumentXml_：找不到值的佔位符收集成 warning（mode=BLANK）', function () {
  const xml = fx.documentXml(fx.para(fx.run('{{NOT_PROVIDED}}')));
  const result = renderDocumentXml_(xml, { values: {}, lists: {} });
  assertArrayEqual(result.stats.missingKeys, ['NOT_PROVIDED']);
  assert.ok(result.warnings.some(function (w) { return w.code === 'PLACEHOLDER_VALUE_MISSING'; }));
});

test('renderDocumentXml_：mode=ERROR 時找不到值會拋錯', function () {
  const xml = fx.documentXml(fx.para(fx.run('{{NOT_PROVIDED}}')));
  assert.throws(function () {
    renderDocumentXml_(xml, { values: {}, lists: {}, missingValueMode: 'ERROR' });
  });
});

test('renderDocumentXml_：lists 統計逐個清單分開記錄', function () {
  const xml = fx.documentXml(announcementTable());
  const result = renderDocumentXml_(xml, {
    values: {},
    lists: { ANNOUNCEMENT: [{ NO: '1', TEXT: 'a' }, { NO: '2', TEXT: 'b' }], PRAYER: [] }
  });
  assert.strictEqual(result.stats.lists.ANNOUNCEMENT, 2);
  assert.strictEqual(result.stats.lists.PRAYER, 0);
});

test('renderDocumentXml_：非 word/document.xml 的內容（沒有段落）也不會拋錯', function () {
  const result = renderDocumentXml_('<root>{{A}}</root>', { values: { A: 'x' }, lists: {} });
  assert.strictEqual(result.xml, '<root>x</root>');
});

// =====================================================================

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
