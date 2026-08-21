#!/usr/bin/env node
/**
 * tests/splitrun.test.js
 *
 * 「跨 run 的佔位符」與「產出實掃驗證」的回歸測試。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 這一輪修的兩件事
 * ─────────────────────────────────────────────────────────────────────
 *
 *   1. **佔位符處理一律以「整段合併文字」為準。** Word 重新儲存時會把
 *      一段文字重新切成多個 `w:r`／`w:t`。原本只有
 *      `mergeRunsInParagraphs_()` 一道防線，而它只合併**格式完全相同**的
 *      相鄰 run——切開的幾個 run 只要格式有一丁點差異（字型大小、
 *      `w:lang`……）就合併不到，佔位符原封不動印在紙上。第二道防線
 *      `collapseSplitPlaceholderParagraphs_()` 把那些段落整段壓平。
 *
 *   2. **產出驗證要實掃產出，不是自己數自己。**
 *      `replacedCount`／`missingKeys`／`broken` 三個數字全部由渲染流程
 *      自己算，用的是跟渲染同一套假設——假設錯了三個數字會一齊報沒事。
 *      `scanResidualPlaceholders_()`／`scanDocxResidualPlaceholders_()`
 *      回頭掃真正的產出，跟渲染沒有共用假設。
 *
 * 執行方式：node tests/splitrun.test.js
 * 離開碼：0＝全部通過　1＝有測試失敗
 */

'use strict';

const assert = require('assert');
const { loadAllSrcFilesInOrder } = require('./helpers/loadGas');
const { makeFakeUtilities, buildFakeDocx } = require('./helpers/fakeDrive');
const fx = require('./fixtures/docxXml');

const sandbox = loadAllSrcFilesInOrder({
  Utilities: makeFakeUtilities(),
  Session: { getScriptTimeZone: function () { return 'Pacific/Auckland'; } },
  SpreadsheetApp: {}, CacheService: {}, HtmlService: {}
});

const {
  renderDocumentXml_, prepareXmlForPlaceholders_, paragraphMergedText_,
  paragraphHasSplitPlaceholder_, scanResidualPlaceholders_, scanDocxResidualPlaceholders_,
  mergeRunsInParagraphs_
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

/** 兩個**不同**的 `<w:rPr>`——只差字型大小，但足以令舊的合併放棄。 */
const RPR_A = '<w:rPr><w:rFonts w:ascii="Calibri Light"/><w:sz w:val="21"/></w:rPr>';
const RPR_B = '<w:rPr><w:rFonts w:ascii="Calibri Light"/><w:sz w:val="22"/></w:rPr>';

/**
 * 把一串文字碎片造成一個段落，每一片一個 `<w:r>`，格式交替 A／B。
 * 交替格式是重點：格式一樣的話 `mergeRunsInParagraphs_()` 自己就搞掂，
 * 測不到第二道防線。
 */
function splitParagraph(pieces) {
  return fx.para(pieces.map(function (p, i) {
    return fx.run(p, i % 2 === 0 ? RPR_A : RPR_B);
  }).join(''));
}

/** 同上，但中間夾拼寫檢查標記（模仿 Word 真實輸出）。 */
function splitParagraphWithProofErr(pieces) {
  return fx.para(pieces.map(function (p, i) {
    const proof = i === 0 ? '' : '<w:proofErr w:type="gramStart"/>';
    return proof + fx.run(p, i % 2 === 0 ? RPR_A : RPR_B);
  }).join(''));
}

function visibleText(xml) {
  const out = [];
  const pattern = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g;
  let m;
  while ((m = pattern.exec(xml)) !== null) out.push(m[1]);
  return out.join('');
}

function countTag(xml, tag) {
  return (xml.match(new RegExp('<' + tag + '(?:\\s[^>]*)?>', 'g')) || []).length;
}

function render(xml, context) {
  return renderDocumentXml_(xml, Object.assign({ values: {}, lists: {}, missingValueMode: 'BLANK' }, context || {}));
}

// =====================================================================
// 1-4. 單值佔位符：完整、拆兩片、拆三片、逐個字元
// =====================================================================

test('1. {{FIELD}} 完整在一個 w:t → 正常替換', function () {
  const xml = fx.documentXml(fx.para(fx.run('{{SERMON_TITLE}}', RPR_A)));
  const result = render(xml, { values: { SERMON_TITLE: '因信稱義' } });
  assert.strictEqual(visibleText(result.xml), '因信稱義');
  assert.strictEqual(result.stats.collapsedParagraphs, 0, '本來就完整，不應該被壓平');
});

test('2. {{FIELD}} 被拆成 {{FIE ＋ LD}}（格式不同）→ 正常替換', function () {
  const xml = fx.documentXml(splitParagraph(['{{SERMON_TIT', 'LE}}']));
  const result = render(xml, { values: { SERMON_TITLE: '因信稱義' } });
  assert.strictEqual(visibleText(result.xml), '因信稱義');
  assert.strictEqual(result.stats.collapsedParagraphs, 1);
  assert.strictEqual(result.xml.indexOf('{{'), -1);
});

test('3. {{FIELD}} 被拆成 {{ ＋ FIELD ＋ }}（格式不同）→ 正常替換', function () {
  const xml = fx.documentXml(splitParagraph(['{{', 'SERMON_TITLE', '}}']));
  const result = render(xml, { values: { SERMON_TITLE: '因信稱義' } });
  assert.strictEqual(visibleText(result.xml), '因信稱義');
  assert.strictEqual(result.xml.indexOf('{{'), -1);
});

test('4. 每個字元一個 w:t（極端情況）→ 正常替換', function () {
  const xml = fx.documentXml(splitParagraph('{{SERMON_TITLE}}'.split('')));
  const result = render(xml, { values: { SERMON_TITLE: '因信稱義' } });
  assert.strictEqual(visibleText(result.xml), '因信稱義');
  assert.strictEqual(result.xml.indexOf('{{'), -1);
});

test('4b. 真實形態：{{# ＋ EACHP:X}}{ ＋ {X.NO}}（中間夾 proofErr）→ 認得出完整 marker', function () {
  // 這就是 TPL_NORMAL 內實際的切法（已由本輪的驗證確認）。
  const xml = fx.documentXml(splitParagraphWithProofErr([
    '{{#', 'EACHP:ANNOUNCEMENT}}{', '{ANNOUNCEMENT.NO}}. {{ANNOUNCEMENT.TEXT}}'
  ]));
  const prepared = prepareXmlForPlaceholders_(xml);
  assert.ok(prepared.xml.indexOf('{{#EACHP:ANNOUNCEMENT}}') !== -1, '要認得出完整的段落層標記');
  assert.ok(prepared.xml.indexOf('{{ANNOUNCEMENT.NO}}') !== -1);
});

// =====================================================================
// 5-6. 段落層清單：0 行整段刪除、3 行展開
// =====================================================================

/** prompt 點名嘅實際案例，拆成 5 段。 */
function eachpAnnouncementParagraph() {
  return splitParagraph([
    '{{#EACHP:', 'ANNOUNCEMENT}}', '{{ANNOUNCEMENT.NO}}', '. ', '{{ANNOUNCEMENT.TEXT}}'
  ]);
}

test('5. {{#EACHP:ANNOUNCEMENT}}… 被拆成 5 段、資料 0 行 → 整段刪除', function () {
  const xml = fx.documentXml(fx.para(fx.run('前面')) + eachpAnnouncementParagraph() + fx.para(fx.run('後面')));
  const result = render(xml, { lists: { ANNOUNCEMENT: [] } });

  assert.strictEqual(result.xml.indexOf('{{'), -1, '不可以殘留任何佔位符');
  const text = visibleText(result.xml);
  assert.strictEqual(text, '前面後面', '整段要刪走，前後兩段不受影響：' + text);
  assert.strictEqual(countTag(result.xml, 'w:p'), 2);
});

test('6. 同上、資料 3 行 → 展開成 3 段，編號 1／2／3', function () {
  const xml = fx.documentXml(eachpAnnouncementParagraph());
  const result = render(xml, {
    lists: { ANNOUNCEMENT: [
      { NO: '1', TEXT: '第一則' }, { NO: '2', TEXT: '第二則' }, { NO: '3', TEXT: '第三則' }
    ] }
  });

  assert.strictEqual(result.xml.indexOf('{{'), -1);
  assert.strictEqual(countTag(result.xml, 'w:p'), 3, '要展開成 3 段');
  assert.strictEqual(result.stats.expandedRows, 3);
  const text = visibleText(result.xml);
  assert.strictEqual(text, '1. 第一則2. 第二則3. 第三則', text);
});

test('6b. 同上、資料 1 行 → 一段，內容正確', function () {
  const xml = fx.documentXml(eachpAnnouncementParagraph());
  const result = render(xml, { lists: { ANNOUNCEMENT: [{ NO: '1', TEXT: '只得一則' }] } });
  assert.strictEqual(visibleText(result.xml), '1. 只得一則');
  assert.strictEqual(countTag(result.xml, 'w:p'), 1);
});

// =====================================================================
// 7. 表格列內的 {{#EACH:}} 被拆
// =====================================================================

test('7. {{#EACH:PROGRAM}} 在表格列內被拆（格式不同）→ 正常展開', function () {
  const xml = fx.documentXml(fx.table([
    fx.row([
      fx.cell(splitParagraph(['{{#EACH:', 'PROGRAM}}', '{{PROGRAM.ITEM}}'])),
      fx.cell(fx.para(fx.run('{{PROGRAM.CONTENT}}', RPR_A)))
    ])
  ]));
  const result = render(xml, {
    lists: { PROGRAM: [
      { ITEM: '序樂', CONTENT: '安靜' },
      { ITEM: '宣召', CONTENT: '詩篇' }
    ] }
  });

  assert.strictEqual(result.xml.indexOf('{{'), -1);
  assert.strictEqual(countTag(result.xml, 'w:tr'), 2, '兩筆資料要展開成兩列');
  assert.strictEqual(result.stats.expandedRows, 2);
  const text = visibleText(result.xml);
  assert.ok(text.indexOf('序樂') !== -1 && text.indexOf('安靜') !== -1, text);
  assert.ok(text.indexOf('宣召') !== -1 && text.indexOf('詩篇') !== -1, text);
});

test('7b. 表格儲存格內、清單 0 行 → 整列刪除，不殘留 {{', function () {
  const xml = fx.documentXml(fx.table([
    fx.row([fx.cell(splitParagraph(['{{#EACH:', 'PROGRAM}}', '{{PROGRAM.ITEM}}']))])
  ]));
  const result = render(xml, { lists: { PROGRAM: [] } });
  assert.strictEqual(result.xml.indexOf('{{'), -1);
  assert.strictEqual(countTag(result.xml, 'w:tr'), 0);
});

// =====================================================================
// 8. 同一段兩個佔位符，其中一個被拆
// =====================================================================

test('8. 同一段有兩個佔位符、其中一個被拆 → 兩個都正確', function () {
  const xml = fx.documentXml(fx.para(
    fx.run('{{CHOIR_LABEL}}：', RPR_A)      // 完整
    + fx.run('{{CHOIR_', RPR_B)             // 被拆（而且格式不同）
    + fx.run('TITLE}}', RPR_A)
  ));
  const result = render(xml, { values: { CHOIR_LABEL: '詩班', CHOIR_TITLE: '主愛長闊高深' } });

  assert.strictEqual(visibleText(result.xml), '詩班：主愛長闊高深');
  assert.strictEqual(result.xml.indexOf('{{'), -1);
});

test('8b. 同一段兩個佔位符都完整 → 段落原封不動（不會被無謂壓平）', function () {
  const xml = fx.documentXml(fx.para(
    fx.run('{{CHOIR_LABEL}}', RPR_A) + fx.run('{{CHOIR_TITLE}}', RPR_B)
  ));
  const result = render(xml, { values: { CHOIR_LABEL: '詩班', CHOIR_TITLE: '主愛' } });
  assert.strictEqual(result.stats.collapsedParagraphs, 0,
    '兩個都完整落在自己的 w:t 內，冇必要壓平——壓平會拉平段落內的混合格式');
  assert.strictEqual(visibleText(result.xml), '詩班主愛');
});

// =====================================================================
// 9. 保留第一個 run 的格式
// =====================================================================

test('9. 替換之後保留第一個 run 的字型與大小', function () {
  const xml = fx.documentXml(splitParagraph(['{{SERMON_', 'TITLE}}']));
  const result = render(xml, { values: { SERMON_TITLE: '因信稱義' } });

  // 第一個 run 的格式是 RPR_A（sz=21）；壓平之後整段都應該用它。
  assert.ok(result.xml.indexOf('<w:sz w:val="21"/>') !== -1, '第一個 run 的字型大小要保留');
  assert.ok(result.xml.indexOf('Calibri Light') !== -1, '第一個 run 的字型要保留');
  // 段落結構仍然完整（run 冇被刪走）。
  assert.ok(countTag(result.xml, 'w:r') >= 1);
  assert.ok(countTag(result.xml, 'w:p') === 1);
});

test('9b. 壓平之後第一個 w:t 一定帶 xml:space="preserve"（否則前後空白會被 Word 食咗）', function () {
  const xml = fx.documentXml(splitParagraph(['{{CHOIR_LABEL}}', '　', '{{CHOIR_', 'TITLE}}']));
  const prepared = prepareXmlForPlaceholders_(xml);
  assert.ok(prepared.xml.indexOf('<w:t xml:space="preserve">') !== -1);
});

// =====================================================================
// 10. 巢狀文字方塊
// =====================================================================

/** 造一個「外層段落內含一個文字方塊，方塊內另有段落」的結構。 */
function paragraphWithTextBox(outerPieces, innerText) {
  const box = '<w:r><mc:AlternateContent><mc:Choice><w:drawing><wps:txbx><w:txbxContent>'
    + fx.para(fx.run(innerText, RPR_A))
    + '</w:txbxContent></wps:txbx></w:drawing></mc:Choice></mc:AlternateContent></w:r>';
  return fx.para(outerPieces.map(function (p, i) {
    return fx.run(p, i % 2 === 0 ? RPR_A : RPR_B);
  }).join('') + box);
}

test('10. 巢狀文字方塊內的段落不會被外層段落的合併吃掉', function () {
  const xml = fx.documentXml(paragraphWithTextBox(['{{SERMON_', 'TITLE}}'], '{{CHURCH_NAME}}'));

  // 外層段落「自己」的合併文字不可以含文字方塊內的字。
  const pRanges = sandbox.findElementRanges_(xml, 'w:p');
  const outer = pRanges[0];
  const ownText = paragraphMergedText_(xml.slice(outer.start, outer.end));
  assert.strictEqual(ownText, '{{SERMON_TITLE}}',
    '外層段落只可以睇到自己嗰兩片，唔可以撈埋文字方塊內嗰句：' + ownText);

  const result = render(xml, { values: { SERMON_TITLE: '因信稱義', CHURCH_NAME: '聖道堂' } });
  assert.strictEqual(result.xml.indexOf('{{'), -1);
  const text = visibleText(result.xml);
  assert.ok(text.indexOf('因信稱義') !== -1, '外層要填得到：' + text);
  assert.ok(text.indexOf('聖道堂') !== -1, '文字方塊內嗰個一樣要填得到：' + text);
});

test('10b. 文字方塊內被拆開的佔位符，自己都救得到', function () {
  const box = '<w:r><w:drawing><wps:txbx><w:txbxContent>'
    + splitParagraph(['{{CHURCH_', 'NAME}}'])
    + '</w:txbxContent></wps:txbx></w:drawing></w:r>';
  const xml = fx.documentXml(fx.para(box));
  const result = render(xml, { values: { CHURCH_NAME: '聖道堂' } });
  assert.strictEqual(result.xml.indexOf('{{'), -1);
  assert.ok(visibleText(result.xml).indexOf('聖道堂') !== -1);
});

test('10c. paragraphHasSplitPlaceholder_：外層段落唔會因為文字方塊內有碎片而被誤判', function () {
  // 外層自己只有一片完整文字，方塊內先至係拆開嘅——外層唔應該被判定要壓平。
  const box = '<w:r><w:drawing><wps:txbx><w:txbxContent>'
    + splitParagraph(['{{CHURCH_', 'NAME}}'])
    + '</w:txbxContent></wps:txbx></w:drawing></w:r>';
  const outerXml = fx.para(fx.run('完整文字', RPR_A) + box);
  assert.strictEqual(paragraphHasSplitPlaceholder_(outerXml), false);
});

// =====================================================================
// 11-12. 產出實掃
// =====================================================================

test('11. 產出掃描：人為造一份含殘留 {{X}} 的產出 → 報告殘留 1 個', function () {
  const blob = buildFakeDocx(fx.documentXml(
    fx.para(fx.run('正常內容')) + fx.para(fx.run('{{NOT_REPLACED}}'))
  ));
  const result = scanDocxResidualPlaceholders_(blob);
  assert.strictEqual(result.count, 1);
  assert.strictEqual(result.samples[0], '{{NOT_REPLACED}}');
  assert.ok(result.parts.indexOf('word/document.xml') !== -1);
});

test('12. 產出掃描：正常產出 → 報告殘留 0 個', function () {
  const blob = buildFakeDocx(fx.documentXml(fx.para(fx.run('全部都填好咗'))));
  const result = scanDocxResidualPlaceholders_(blob);
  assert.strictEqual(result.count, 0);
  assert.strictEqual(result.samples.length, 0);
  assert.strictEqual(result.parts.length, 0);
});

test('12b. 產出掃描：解壓失敗 → count 為 -1（「驗證不到」，唔可以當成 0）', function () {
  const brokenSandbox = loadAllSrcFilesInOrder({
    Utilities: makeFakeUtilities({ failUnzip: true }),
    Session: { getScriptTimeZone: function () { return 'Pacific/Auckland'; } },
    SpreadsheetApp: {}, CacheService: {}, HtmlService: {}
  });
  const blob = buildFakeDocx(fx.documentXml(fx.para(fx.run('x'))));
  const result = brokenSandbox.scanDocxResidualPlaceholders_(blob);
  assert.strictEqual(result.count, -1, '負數代表驗證不到，跟「乾淨」必須分得清楚');
  assert.ok(result.error);
});

test('12c. 產出掃描：頁首／頁尾內的殘留一樣掃得到', function () {
  const blob = buildFakeDocx(fx.documentXml(fx.para(fx.run('乾淨'))));
  const { makeFakeBlob } = require('./helpers/fakeDrive');
  blob.__entries.push(makeFakeBlob('<w:hdr>{{FOOTER_LEFTOVER}}</w:hdr>', 'word/header1.xml'));
  const result = scanDocxResidualPlaceholders_(blob);
  assert.strictEqual(result.count, 1);
  assert.ok(result.parts.indexOf('word/header1.xml') !== -1);
});

test('12d. 產出掃描：不會掃 styles/settings 這類非文字部件（避免誤報）', function () {
  const blob = buildFakeDocx(fx.documentXml(fx.para(fx.run('乾淨'))));
  const { makeFakeBlob } = require('./helpers/fakeDrive');
  blob.__entries.push(makeFakeBlob('<w:settings>{{NOT_TEXT}}</w:settings>', 'word/settings2.xml'));
  assert.strictEqual(scanDocxResidualPlaceholders_(blob).count, 0);
});

test('12e. scanResidualPlaceholders_：有頭無尾的碎片一樣算殘留（用最寬鬆的 {{ 去掃）', function () {
  const result = scanResidualPlaceholders_('<w:t>{{SERMON_TITLE</w:t>');
  assert.strictEqual(result.count, 1, '殘留物本身就可能係壞嘅，用嚴格樣式反而會漏報');
});

test('12f. scanResidualPlaceholders_：同一個殘留出現多次 → count 照數，samples 去重', function () {
  const result = scanResidualPlaceholders_('{{X}}{{X}}{{Y}}');
  assert.strictEqual(result.count, 3);
  assert.strictEqual(JSON.stringify(result.samples), JSON.stringify(['{{X}}', '{{Y}}']));
});

// =====================================================================
// 反向鎖：驗證函式唔可以同被驗證嘅邏輯用同一個假設
// =====================================================================

test('反向鎖. 實掃係獨立路徑：就算渲染統計話「冇嘢」，實掃照樣捉到殘留', function () {
  // 造一個渲染流程「處理唔到、但三個統計數字都話冇事」的情況：
  // 範本用咗一個系統根本冇提供、又唔係單值語法嘅清單標記。
  const xml = fx.documentXml(fx.para(fx.run('{{#EACHP:NOT_A_REAL_LIST}}{{NOT_A_REAL_LIST.TEXT}}')));
  const result = render(xml, { values: {}, lists: {} });

  // 三個「自己數自己」嘅數字全部話冇事⋯⋯
  assert.strictEqual(result.stats.missingKeys.length, 0, '單值替換唔會碰 # 開頭同帶點嘅鍵');
  assert.strictEqual(result.stats.broken.length, 0, '兩個佔位符本身都係完整嘅，唔算被切斷');
  // ⋯⋯但紙上真係有嘢殘留。
  const scan = scanResidualPlaceholders_(result.xml);
  assert.strictEqual(scan.count, 2, '實掃一定要捉到：' + JSON.stringify(scan.samples));
});

test('反向鎖 b. mergeRunsInParagraphs_ 單獨救唔到格式不同嘅切法（所以第二道防線係必要嘅）', function () {
  const xml = fx.documentXml(splitParagraph(['{{SERMON_', 'TITLE}}']));
  const mergedOnly = mergeRunsInParagraphs_(xml);
  assert.strictEqual(mergedOnly.indexOf('{{SERMON_TITLE}}'), -1,
    '格式唔同 → 舊嘅合併一定救唔到，呢個就係今次要補嘅窿');
  assert.ok(prepareXmlForPlaceholders_(xml).xml.indexOf('{{SERMON_TITLE}}') !== -1,
    '加咗第二道防線之後就救得到');
});

// =====================================================================

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
