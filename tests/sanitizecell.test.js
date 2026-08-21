#!/usr/bin/env node
/**
 * tests/sanitizecell.test.js
 *
 * src/SheetUtils.gs 的 sanitizeCellText_() 回歸測試：=／+／-／@ 開頭的字串
 * 一律加前導單引號，其餘原樣回傳；並且斷言 Diagnostics（writeDiagnosticsReport_）
 * 與 AuditLog（appendAuditLog_）這兩條寫入路徑真的有呼叫它，不是只有純函式
 * 本身正確、卻沒有在真正的寫入路徑上生效。
 *
 * 事故背景：「週報資料模型預覽」的區段標題 `'=== 基本資料 ==='` 用
 * setValues() 寫入 Diagnostics 後，被 Google Sheets 當成公式求值，整格
 * 變成 #ERROR!（見 docs/已知bug類型.md 事故六）。
 *
 * 執行方式：node tests/sanitizecell.test.js
 * 離開碼：0＝全部通過　1＝有測試失敗
 */

'use strict';

const assert = require('assert');
const { loadAllSrcFilesInOrder } = require('./helpers/loadGas');
const { makeFakeSheet, makeFakeSpreadsheet } = require('./helpers/fakeSpreadsheet');

const GAS_STUBS = {
  Utilities: {
    formatDate: function (date) {
      var y = date.getFullYear();
      var mo = String(date.getMonth() + 1).padStart(2, '0');
      var d = String(date.getDate()).padStart(2, '0');
      return y + '-' + mo + '-' + d;
    }
  },
  Session: {
    getScriptTimeZone: function () { return 'Pacific/Auckland'; },
    getActiveUser: function () { return { getEmail: function () { return ''; } }; }
  },
  SpreadsheetApp: {},
  CacheService: {}
};

const sandbox = loadAllSrcFilesInOrder(GAS_STUBS);
const { sanitizeCellText_ } = sandbox;

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

// =====================================================================
// sanitizeCellText_（純函式）
// =====================================================================

test('sanitizeCellText_：= 開頭 → 加前導單引號', function () {
  assert.strictEqual(sanitizeCellText_('=1+1'), "'=1+1");
});

test('sanitizeCellText_：+ 開頭 → 加前導單引號', function () {
  assert.strictEqual(sanitizeCellText_('+886912345678'), "'+886912345678");
});

test('sanitizeCellText_：- 開頭 → 加前導單引號', function () {
  assert.strictEqual(sanitizeCellText_('-1'), "'-1");
});

test('sanitizeCellText_：@ 開頭 → 加前導單引號', function () {
  assert.strictEqual(sanitizeCellText_('@SUM(A1)'), "'@SUM(A1)");
});

test('sanitizeCellText_：正常字串原樣回傳（不會多加單引號）', function () {
  assert.strictEqual(sanitizeCellText_('基本資料'), '基本資料');
  assert.strictEqual(sanitizeCellText_('陳大文弟兄'), '陳大文弟兄');
});

test('sanitizeCellText_：空字串原樣回傳', function () {
  assert.strictEqual(sanitizeCellText_(''), '');
});

test('sanitizeCellText_：null／undefined 原樣回傳（不是型別錯誤，也不會拋錯）', function () {
  assert.strictEqual(sanitizeCellText_(null), null);
  assert.strictEqual(sanitizeCellText_(undefined), undefined);
});

test('sanitizeCellText_：數字原樣回傳（不會被誤判成字串處理）', function () {
  assert.strictEqual(sanitizeCellText_(123), 123);
  assert.strictEqual(sanitizeCellText_(0), 0);
});

test('sanitizeCellText_：Date 物件原樣回傳', function () {
  var d = sandbox.normalizeDate_('2027-10-03');
  assert.strictEqual(sanitizeCellText_(d), d);
});

test('sanitizeCellText_：boolean 原樣回傳', function () {
  assert.strictEqual(sanitizeCellText_(true), true);
  assert.strictEqual(sanitizeCellText_(false), false);
});

test('sanitizeCellText_：中間出現 =／+／-／@ 不受影響，只看第一個字元', function () {
  assert.strictEqual(sanitizeCellText_('報告：=1+1 不是公式'), '報告：=1+1 不是公式');
});

// =====================================================================
// 由真正的寫入路徑（writeDiagnosticsReport_／appendAuditLog_）叫下去，
// 斷言真的有呼叫 sanitizeCellText_()，不是只有純函式本身正確。
// =====================================================================

function ownSheetFor(sheetId, rows) {
  var def = sandbox.COLUMNS[sheetId];
  return makeFakeSheet(def.headers, def.keys, rows || []);
}

function makeEnv() {
  var freshSandbox = loadAllSrcFilesInOrder(GAS_STUBS);
  var sheets = {
    Config: (function () {
      var def = freshSandbox.COLUMNS.CONFIG;
      return makeFakeSheet(def.headers, def.keys, []);
    })(),
    Diagnostics: (function () {
      var def = freshSandbox.COLUMNS.DIAGNOSTICS;
      return makeFakeSheet(def.headers, def.keys, []);
    })(),
    AuditLog: (function () {
      var def = freshSandbox.COLUMNS.AUDIT_LOG;
      return makeFakeSheet(def.headers, def.keys, []);
    })()
  };
  var FakeApp = { getActiveSpreadsheet: function () { return makeFakeSpreadsheet(sheets); } };
  var sandbox = loadAllSrcFilesInOrder(Object.assign({}, GAS_STUBS, { SpreadsheetApp: FakeApp }));
  // ⚠️ 一併帶出假工作表本身：真實 Sheets 會把 sanitizeCellText_() 加的
  // 前導單引號當成**格式標記**吃掉（`getValue()` 讀回來沒有它），所以
  // 「有沒有跳脫過」不可以靠讀回來的值判斷——要看假工作表記下的
  // `__escapedValues`。見 tests/helpers/fakeSpreadsheet.js 的
  // applyTextFormatMarker()。
  sandbox.__sheets = sheets;
  return sandbox;
}

/**
 * 斷言某個值寫入指定工作表時真的經過了 sanitizeCellText_()。
 */
function assertWasEscaped(env, sheetName, value, message) {
  assert.ok(
    env.__sheets[sheetName].__escapedValues.has(value),
    message || ('「' + value + '」寫入 ' + sheetName + ' 時應該經過 sanitizeCellText_()')
  );
}

test('真正入口：writeDiagnosticsReport_() 寫入以 = 開頭的行 → 工作表上的值有前導單引號，不是原始的 = 開頭', function () {
  var env = makeEnv();
  env.writeDiagnosticsReport_('週報資料模型預覽', ['=== 基本資料 ===', '正常的一行']);

  var rows = env.readSheet('Diagnostics');
  var titleRow = rows.filter(function (r) { return r.CONTENT.indexOf('基本資料') !== -1; })[0];
  assert.ok(titleRow, '應該找得到那一行');
  assert.strictEqual(titleRow.CONTENT, '=== 基本資料 ===', '讀回來應該是原文（真實 Sheets 會把格式標記吃掉）');
  assertWasEscaped(env, 'Diagnostics', '=== 基本資料 ===',
    'CONTENT 應該經過 sanitizeCellText_()，否則 Sheets 會把它當成公式求值');

  var normalRow = rows.filter(function (r) { return r.CONTENT.indexOf('正常的一行') !== -1; })[0];
  assert.strictEqual(normalRow.CONTENT, '正常的一行', '不需要跳脫的內容不應該被多加單引號');
});

test('真正入口：writeDiagnosticsReport_() 的 reportName 若以 = 開頭同樣被保護', function () {
  var env = makeEnv();
  env.writeDiagnosticsReport_('=惡意報告名稱', ['內容']);
  var rows = env.readSheet('Diagnostics');
  assert.strictEqual(rows[0].REPORT_NAME, '=惡意報告名稱');
  assertWasEscaped(env, 'Diagnostics', '=惡意報告名稱');
});

test('真正入口：appendAuditLog_() 的 OLD_VALUE／NEW_VALUE 若以 = 開頭 → 寫入時有前導單引號', function () {
  var env = makeEnv();
  env.appendAuditLog_({
    action: 'TEST_ACTION',
    sheetName: 'BulletinWeeks',
    rowKey: '2027-10-03',
    field: 'SERMON_TITLE',
    oldValue: '',
    newValue: '=HYPERLINK("http://example.invalid")'
  });

  var rows = env.readSheet('AuditLog');
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].NEW_VALUE, '=HYPERLINK("http://example.invalid")');
  assertWasEscaped(env, 'AuditLog', '=HYPERLINK("http://example.invalid")');
});

test('真正入口：appendAuditLog_() 的 ACTION／NOTES 等一般欄位一樣經過 sanitizeCellText_（正常內容不受影響）', function () {
  var env = makeEnv();
  env.appendAuditLog_({ action: 'NORMAL_ACTION', notes: '沒有特殊字元的備註' });
  var rows = env.readSheet('AuditLog');
  assert.strictEqual(rows[0].ACTION, 'NORMAL_ACTION');
  assert.strictEqual(rows[0].NOTES, '沒有特殊字元的備註');
});

// =====================================================================

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
