#!/usr/bin/env node
/**
 * tests/baptismbox.test.js
 *
 * 浸禮合堂範本第 1 頁「副框」的回歸測試：
 *   - `buildBaptismBoxFields_()`（`src/BaptismBox.gs`）——單人欄位套尊稱、
 *     多人欄位原樣輸出。
 *   - `applyOptionalLabelledCellRows_()`（`src/DocxTemplate.gs`）——留空
 *     規則：整列刪除／整個表格刪除／同一列一格清空。
 *
 * ⚠️ 副框每一格的文字是「標籤：佔位符」，標籤是範本上的死字。留空時要
 * 連標籤一併清走，所以測試一律驗證**成品文字**，不是只驗證佔位符有沒有
 * 被替換掉。
 *
 * 執行方式：node tests/baptismbox.test.js
 * 離開碼：0＝全部通過　1＝有測試失敗
 */

'use strict';

const assert = require('assert');
const { loadAllSrcFilesInOrder } = require('./helpers/loadGas');
const fx = require('./fixtures/docxXml');

const sandbox = loadAllSrcFilesInOrder({
  Utilities: { formatDate: function () { return '2027-11-07'; } },
  Session: { getScriptTimeZone: function () { return 'Pacific/Auckland'; } },
  SpreadsheetApp: {}, CacheService: {}, HtmlService: {}
});

const {
  buildBaptismBoxFields_, baptismBoxFieldDefs_, baptismBoxFieldKeys_, baptismBoxRowGroups_,
  applyOptionalLabelledCellRows_, renderDocumentXml_, mergeRunsInParagraphs_
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

function assertArrayEqual(actual, expected, message) {
  assert.strictEqual(JSON.stringify(actual), JSON.stringify(expected), message);
}

/**
 * 造一個「浸禮副框」表格：3 列 × 2 欄，每格是「標籤：佔位符」。
 * 刻意跟真實範本一樣把標籤與佔位符放在**同一個 run**，因為留空規則
 * 靠的就是「整格文字一齊清走」。
 */
function baptismBoxTable() {
  return fx.table([
    fx.row([
      fx.cell(fx.para(fx.run('浸禮：{{BAPTISM_OFFICIANT}}'))),
      fx.cell(fx.para(fx.run('入會禮：{{MEMBERSHIP_OFFICIANT}}')))
    ]),
    fx.row([
      fx.cell(fx.para(fx.run('受浸肢體：{{BAPTISM_MEMBERS}}'))),
      fx.cell(fx.para(fx.run('入會肢體：{{MEMBERSHIP_MEMBERS}}')))
    ]),
    fx.row([
      fx.cell(fx.para(fx.run('孩童奉獻禮：{{CHILD_DEDICATION_OFFICIANT}}'))),
      fx.cell(fx.para(fx.run('奉獻孩童：{{CHILD_DEDICATION_CHILDREN}}')))
    ])
  ]);
}

/** 副框 ＋ 前後各一段其他內容——驗證刪表格時不會誤刪旁邊的東西。 */
function baptismDocumentXml() {
  return fx.documentXml(
    fx.para(fx.run('副框之前的內容'))
    + baptismBoxTable()
    + fx.para(fx.run('副框之後的內容'))
  );
}

/** 取出 XML 內全部 <w:t> 的文字，串成一句方便比對。 */
function visibleText(xml) {
  const out = [];
  const pattern = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g;
  let m;
  while ((m = pattern.exec(xml)) !== null) out.push(m[1]);
  return out.join('｜');
}

function countTag(xml, tag) {
  const pattern = new RegExp('<' + tag + '(?:\\s[^>]*)?>', 'g');
  return (xml.match(pattern) || []).length;
}

/** 六個欄位全部空字串的 values（測試逐項覆寫）。 */
function emptyValues() {
  const v = {};
  baptismBoxFieldKeys_().forEach(function (k) { v[k] = ''; });
  return v;
}

/** 跑一次完整渲染（含單值替換），回傳成品 XML。 */
function renderWith(values) {
  return renderDocumentXml_(baptismDocumentXml(), {
    values: values,
    lists: {},
    optionalCellRows: baptismBoxRowGroups_(),
    missingValueMode: 'BLANK'
  });
}

// =====================================================================
// 1-4. 留空規則
// =====================================================================

test('1. 六格全有值 → 3 列都在，六個值都印得出來', function () {
  const values = Object.assign(emptyValues(), {
    BAPTISM_OFFICIANT: '甲牧師', MEMBERSHIP_OFFICIANT: '乙牧師',
    BAPTISM_MEMBERS: '丙 丁 戊', MEMBERSHIP_MEMBERS: '己 庚',
    CHILD_DEDICATION_OFFICIANT: '辛傳道', CHILD_DEDICATION_CHILDREN: '壬 癸'
  });
  const result = renderWith(values);

  assert.strictEqual(countTag(result.xml, 'w:tr'), 3, '三列都要在');
  assert.strictEqual(countTag(result.xml, 'w:tbl'), 1, '表格要在');
  const text = visibleText(result.xml);
  ['甲牧師', '乙牧師', '丙 丁 戊', '己 庚', '辛傳道', '壬 癸'].forEach(function (v) {
    assert.ok(text.indexOf(v) !== -1, '應該印得出「' + v + '」：' + text);
  });
  assert.strictEqual(result.stats.removedRows, 0);
  assert.strictEqual(result.stats.removedTables, 0);
});

test('2. 孩童兩格皆空（2026-04-05 那期）→ 第 3 列被刪，其餘兩列不變', function () {
  const values = Object.assign(emptyValues(), {
    BAPTISM_OFFICIANT: '甲牧師', MEMBERSHIP_OFFICIANT: '乙牧師',
    BAPTISM_MEMBERS: '丙 丁', MEMBERSHIP_MEMBERS: '戊'
  });
  const result = renderWith(values);

  assert.strictEqual(countTag(result.xml, 'w:tr'), 2, '第 3 列要被刪走');
  assert.strictEqual(countTag(result.xml, 'w:tbl'), 1, '表格本身要留低');
  const text = visibleText(result.xml);
  assert.ok(text.indexOf('孩童奉獻禮') === -1, '標籤不可以孤零零留在紙上：' + text);
  assert.ok(text.indexOf('奉獻孩童') === -1, '標籤不可以孤零零留在紙上：' + text);
  assert.ok(text.indexOf('甲牧師') !== -1 && text.indexOf('戊') !== -1, '其餘兩列要原樣保留：' + text);
  assert.strictEqual(result.stats.removedRows, 1);
});

test('3. 六格全空 → 整個表格被刪，前後的內容不受影響', function () {
  const result = renderWith(emptyValues());

  assert.strictEqual(countTag(result.xml, 'w:tbl'), 0, '整個表格要消失');
  assert.strictEqual(countTag(result.xml, 'w:tr'), 0);
  assert.strictEqual(result.stats.removedTables, 1);

  const text = visibleText(result.xml);
  assert.ok(text.indexOf('副框之前的內容') !== -1, '表格以外的內容不可以被誤刪：' + text);
  assert.ok(text.indexOf('副框之後的內容') !== -1, '表格以外的內容不可以被誤刪：' + text);
  assert.ok(text.indexOf('浸禮') === -1 && text.indexOf('入會禮') === -1, '全部標籤都要清走：' + text);
});

test('4. 只有 BAPTISM_MEMBERS 有值 → 該列保留，同列另一格連標籤清空', function () {
  const values = Object.assign(emptyValues(), { BAPTISM_MEMBERS: '丙 丁' });
  const result = renderWith(values);

  assert.strictEqual(countTag(result.xml, 'w:tr'), 1, '只剩下有值那一列');
  assert.strictEqual(countTag(result.xml, 'w:tbl'), 1, '表格要留低（有一列有值）');

  const text = visibleText(result.xml);
  assert.ok(text.indexOf('受浸肢體：丙 丁') !== -1, '有值那一格連標籤一齊保留：' + text);
  assert.ok(text.indexOf('入會肢體') === -1, '同列空的那格要連標籤一併清空：' + text);
  assert.strictEqual(result.stats.removedRows, 2);
  assert.strictEqual(result.stats.clearedCells, 1);
});

test('4b. 清空的那一格仍然保留 <w:tc> 與段落結構（事故十六：空儲存格會令 Word 判定損毀）', function () {
  const values = Object.assign(emptyValues(), { BAPTISM_MEMBERS: '丙 丁' });
  const result = renderWith(values);

  assert.strictEqual(countTag(result.xml, 'w:tc'), 2, '保留那一列的兩格都要在');
  assert.strictEqual(countTag(result.xml, 'w:p'), countTag(result.xml, 'w:p'), 'sanity');
  // 被清空那一格內仍然要有一個 <w:p>，不可以變成空的 <w:tc></w:tc>。
  assert.ok(/<w:tc>(?:(?!<\/w:tc>)[\s\S])*<w:p>/.test(result.xml), '每個 <w:tc> 內都要至少有一個 <w:p>');
});

// =====================================================================
// 5. 單人套尊稱、多人原樣
// =====================================================================

const PERSON_DISPLAY_ROWS = [
  { PERSON_ID: 'P1', NAME_TC: '甲', HONORIFIC: '牧師', DISPLAY_OVERRIDE: '', EFFECTIVE_FROM: '', EFFECTIVE_TO: '', ACTIVE: true, NOTES: '' },
  { PERSON_ID: 'P2', NAME_TC: '乙', HONORIFIC: '弟兄', DISPLAY_OVERRIDE: '', EFFECTIVE_FROM: '', EFFECTIVE_TO: '', ACTIVE: true, NOTES: '' },
  { PERSON_ID: 'P3', NAME_TC: '丙', HONORIFIC: '姊妹', DISPLAY_OVERRIDE: '', EFFECTIVE_FROM: '', EFFECTIVE_TO: '', ACTIVE: true, NOTES: '' }
];

test('5. 單人欄位有經過尊稱處理（withHonorific=true）', function () {
  const fields = buildBaptismBoxFields_(
    { BAPTISM_OFFICIANT: '甲', MEMBERSHIP_OFFICIANT: '乙' },
    { withHonorific: true, personDisplayRows: PERSON_DISPLAY_ROWS, targetDate: null }
  );
  assert.strictEqual(fields.BAPTISM_OFFICIANT, '甲牧師');
  assert.strictEqual(fields.MEMBERSHIP_OFFICIANT, '乙弟兄');
});

test('5b. 單人欄位：職稱類尊稱即使 withHonorific=false 也一律保留（與事奉框同一套規則）', function () {
  const fields = buildBaptismBoxFields_(
    { BAPTISM_OFFICIANT: '甲', MEMBERSHIP_OFFICIANT: '乙' },
    { withHonorific: false, personDisplayRows: PERSON_DISPLAY_ROWS, targetDate: null }
  );
  assert.strictEqual(fields.BAPTISM_OFFICIANT, '甲牧師', '牧師是職稱，不受 withHonorific 控制');
  assert.strictEqual(fields.MEMBERSHIP_OFFICIANT, '乙', '弟兄是一般敬稱，withHonorific=false 就省掉');
});

test('5c. 多人欄位**沒有**被加尊稱，而且次序原樣不動', function () {
  const fields = buildBaptismBoxFields_(
    { BAPTISM_MEMBERS: '丙 甲 乙', MEMBERSHIP_MEMBERS: '乙', CHILD_DEDICATION_CHILDREN: '甲 丙' },
    { withHonorific: true, personDisplayRows: PERSON_DISPLAY_ROWS, targetDate: null }
  );
  assert.strictEqual(fields.BAPTISM_MEMBERS, '丙 甲 乙', '多人欄位原樣輸出，不加尊稱、不重新排序');
  assert.strictEqual(fields.MEMBERSHIP_MEMBERS, '乙', '就算只得一位、而且查得到尊稱，多人欄位一樣不加');
  assert.strictEqual(fields.CHILD_DEDICATION_CHILDREN, '甲 丙');
});

test('5d. 單人欄位查不到姓名 → 原樣顯示並記一筆 warning，不拋錯', function () {
  const warnings = [];
  const fields = buildBaptismBoxFields_(
    { BAPTISM_OFFICIANT: '查無此人' },
    { withHonorific: true, personDisplayRows: PERSON_DISPLAY_ROWS, targetDate: null, warnings: warnings }
  );
  assert.strictEqual(fields.BAPTISM_OFFICIANT, '查無此人');
  assert.strictEqual(warnings.length, 1);
  assert.strictEqual(warnings[0].code, 'OVERRIDE_NAME_NOT_IN_PERSON_DISPLAY');
});

test('5e. 六個鍵一定齊全（沒有值的是空字串，不是缺鍵）', function () {
  const fields = buildBaptismBoxFields_({}, {});
  assertArrayEqual(Object.keys(fields).sort(), baptismBoxFieldKeys_().slice().sort());
  Object.keys(fields).forEach(function (k) {
    assert.strictEqual(fields[k], '', k + ' 應該是空字串');
  });
});

test('5f. 多人欄位只做 trim，內部空白原樣保留', function () {
  const fields = buildBaptismBoxFields_({ BAPTISM_MEMBERS: '  丙   丁  ' }, {});
  assert.strictEqual(fields.BAPTISM_MEMBERS, '丙   丁');
});

// =====================================================================
// 6. 產出 XML 不殘留 {{
// =====================================================================

test('6. 六格全有值 → 成品不殘留任何 {{', function () {
  const values = Object.assign(emptyValues(), {
    BAPTISM_OFFICIANT: '甲牧師', MEMBERSHIP_OFFICIANT: '乙牧師',
    BAPTISM_MEMBERS: '丙 丁', MEMBERSHIP_MEMBERS: '戊',
    CHILD_DEDICATION_OFFICIANT: '己傳道', CHILD_DEDICATION_CHILDREN: '庚'
  });
  assert.strictEqual(renderWith(values).xml.indexOf('{{'), -1);
});

test('6b. 部分留空 → 成品同樣不殘留任何 {{', function () {
  const values = Object.assign(emptyValues(), { BAPTISM_OFFICIANT: '甲牧師' });
  assert.strictEqual(renderWith(values).xml.indexOf('{{'), -1);
});

test('6c. 六格全空 → 成品同樣不殘留任何 {{', function () {
  assert.strictEqual(renderWith(emptyValues()).xml.indexOf('{{'), -1);
});

test('6d. 佔位符被 Word 拆散時仍然認得（渲染流程會先合併 run）', function () {
  const splitXml = fx.documentXml(fx.table([
    fx.row([
      fx.cell(fx.splitPlaceholderParagraph(['浸禮：{{', 'BAPTISM', '_OFFICIANT}}'])),
      fx.cell(fx.para(fx.run('入會禮：{{MEMBERSHIP_OFFICIANT}}')))
    ])
  ]));
  const result = renderDocumentXml_(splitXml, {
    values: Object.assign(emptyValues(), { BAPTISM_OFFICIANT: '甲牧師' }),
    lists: {},
    optionalCellRows: baptismBoxRowGroups_(),
    missingValueMode: 'BLANK'
  });
  const text = visibleText(result.xml);
  assert.ok(text.indexOf('甲牧師') !== -1, '被拆散的佔位符要填得到：' + text);
  assert.ok(text.indexOf('入會禮') === -1, '同列空的那格要連標籤清空：' + text);
});

// =====================================================================
// applyOptionalLabelledCellRows_ 的邊界情況
// =====================================================================

test('邊界 a. 範本沒有這些佔位符（平常主日範本）→ XML 原樣不動，found=false', function () {
  const xml = fx.documentXml(fx.para(fx.run('{{SERMON_TITLE}}')));
  const result = applyOptionalLabelledCellRows_(xml, emptyValues(), baptismBoxRowGroups_());
  assert.strictEqual(result.found, false);
  assert.strictEqual(result.xml, xml);
});

test('邊界 b. rowGroups 是空陣列 → XML 原樣不動，不拋錯', function () {
  const xml = baptismDocumentXml();
  const result = applyOptionalLabelledCellRows_(xml, emptyValues(), []);
  assert.strictEqual(result.found, false);
  assert.strictEqual(result.xml, xml);
});

test('邊界 c. 表格內還有其他列（例如標題列）→ 不會整個表格刪走，只刪空的那幾列', function () {
  const xml = fx.documentXml(fx.table([
    fx.row([fx.cell(fx.para(fx.run('副框標題'))), fx.cell(fx.para(fx.run('')))]),
    fx.row([
      fx.cell(fx.para(fx.run('浸禮：{{BAPTISM_OFFICIANT}}'))),
      fx.cell(fx.para(fx.run('入會禮：{{MEMBERSHIP_OFFICIANT}}')))
    ])
  ]));
  const result = applyOptionalLabelledCellRows_(xml, emptyValues(), baptismBoxRowGroups_());

  assert.strictEqual(result.removedTables, 0, '表格內還有標題列，不可以整個刪');
  assert.strictEqual(result.removedRows, 1);
  assert.ok(visibleText(result.xml).indexOf('副框標題') !== -1, '標題列要留低');
});

test('邊界 d. 數字 0 算「有值」（與條件列同一套 isTruthyForTemplate_ 標準）', function () {
  const values = Object.assign(emptyValues(), { BAPTISM_MEMBERS: 0 });
  const result = applyOptionalLabelledCellRows_(baptismDocumentXml(), values, baptismBoxRowGroups_());
  assert.strictEqual(result.removedTables, 0, '有一格算有值，就不可以整個表格刪走');
  assert.strictEqual(result.removedRows, 2);
});

test('邊界 e. 只有空白字元的值算「沒有值」', function () {
  const values = Object.assign(emptyValues(), { BAPTISM_MEMBERS: '   ' });
  const result = applyOptionalLabelledCellRows_(baptismDocumentXml(), values, baptismBoxRowGroups_());
  assert.strictEqual(result.removedTables, 1, '全部都是空白 → 整個表格刪走');
});

// =====================================================================
// 欄位定義本身
// =====================================================================

test('定義 a. 六個欄位：三個單人、三個多人，機器鍵與 BulletinWeeks 一致', function () {
  const defs = baptismBoxFieldDefs_();
  assert.strictEqual(defs.length, 6);
  assert.strictEqual(defs.filter(function (d) { return !d.multi; }).length, 3);
  assert.strictEqual(defs.filter(function (d) { return d.multi; }).length, 3);

  const weekKeys = sandbox.COLUMNS.BULLETIN_WEEKS.keys;
  defs.forEach(function (d) {
    assert.ok(weekKeys.indexOf(d.key) !== -1, d.key + ' 應該是 BulletinWeeks 的機器鍵');
  });
});

test('定義 b. 列分組剛好用齊六個機器鍵，每列兩格，沒有重複', function () {
  const groups = baptismBoxRowGroups_();
  assert.strictEqual(groups.length, 3);
  groups.forEach(function (g) { assert.strictEqual(g.length, 2); });

  const flat = groups.reduce(function (acc, g) { return acc.concat(g); }, []);
  assertArrayEqual(flat.slice().sort(), baptismBoxFieldKeys_().slice().sort());
});

// =====================================================================

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
