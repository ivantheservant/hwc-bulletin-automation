#!/usr/bin/env node
/**
 * tests/sheetutils.test.js
 *
 * src/SheetUtils.gs 的型別正規化層回歸測試。不依賴 SpreadsheetApp——只測試
 * normalizeBoolean_／normalizeText_／normalizeDate_／normalizeInt_／
 * normalizeByType_ 這些不需要真正試算表的純函式。ensureSheet_／readSheet／
 * writeSheet 需要 SpreadsheetApp，只能由 Ivan 在試算表內手動驗收
 * （見 prompt1.md 的驗收條件）。
 *
 * 執行方式：node tests/sheetutils.test.js
 * 離開碼：0＝全部通過　1＝有測試失敗
 */

'use strict';

const assert = require('assert');
const { loadGasFiles } = require('./helpers/loadGas');

// SheetUtils.gs 的 normalizeText_() 在「文字欄位拿到 Date 物件」時會呼叫
// Utilities.formatDate() 與 Session.getScriptTimeZone()——這兩個是 Apps
// Script 全域服務，Node 沒有，所以在載入前先放兩個最小 stub 進 context。
const FAKE_TIMEZONE = 'Pacific/Auckland';
const GAS_STUBS = {
  Utilities: {
    formatDate: function (date, timezone, pattern) {
      var y = date.getFullYear();
      var m = String(date.getMonth() + 1).padStart(2, '0');
      var d = String(date.getDate()).padStart(2, '0');
      return y + '-' + m + '-' + d;
    }
  },
  Session: {
    getScriptTimeZone: function () { return FAKE_TIMEZONE; }
  }
};

const sandbox = loadGasFiles(['src/Constants.gs', 'src/SheetUtils.gs'], GAS_STUBS);
const {
  normalizeBoolean_, normalizeText_, normalizeDate_, normalizeInt_,
  normalizeByType_, getSheetUtilsTypeWarnings_, clearSheetUtilsTypeWarnings_,
  COLUMN_TYPES
} = sandbox;

/**
 * ⚠️ vm.createContext() 給 sandbox 自己一整套內建物件（它自己的 Date、
 * Object…），跟這個測試檔案所在的 Node 主 realm 是兩個不同的 realm。
 * 如果在這個檔案用主 realm 的 `new Date(...)` 造一個物件，傳進 sandbox
 * 內的函式後，sandbox 內部的 `v instanceof Date` 會因為兩邊 Date 建構子
 * 不是同一個而判斷成 false，就算日期本身完全正確也一樣——這是 vm 模組
 * 眾所周知的坑（sandbox 物件本身不會把內建的 Date 建構子暴露成一個外面
 * 拿得到的 own property，所以也沒辦法簡單靠 `sandbox.Date` 借出來用）。
 *
 * 解法：一律靠 normalizeDate_() 自己在 sandbox 內部造 Date（例如用
 * makeSandboxDate() 把一個 yyyy-MM-dd 字串轉成 Date），這樣造出來的物件
 * 跟後續要測試的函式是同一個 realm，instanceof 才會準。
 */
function makeSandboxDate(yyyyMMdd) {
  const d = normalizeDate_(yyyyMMdd);
  assert.ok(d, 'makeSandboxDate 內部呼叫失敗：' + yyyyMMdd);
  return d;
}

/** 跨 realm 安全的 Date 型別檢查，不能用 instanceof（同上）。 */
function isDate(v) {
  return Object.prototype.toString.call(v) === '[object Date]';
}

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
// normalizeBoolean_
// =====================================================================

test('normalizeBoolean_: boolean 原樣回傳', function () {
  assert.strictEqual(normalizeBoolean_(true), true);
  assert.strictEqual(normalizeBoolean_(false), false);
});

test('normalizeBoolean_: TRUE/FALSE 字串不分大小寫', function () {
  assert.strictEqual(normalizeBoolean_('TRUE'), true);
  assert.strictEqual(normalizeBoolean_('FALSE'), false);
  assert.strictEqual(normalizeBoolean_('true'), true);
  assert.strictEqual(normalizeBoolean_('FaLsE'), false);
  assert.strictEqual(normalizeBoolean_('  TRUE  '), true);
});

test('normalizeBoolean_: 是/否', function () {
  assert.strictEqual(normalizeBoolean_('是'), true);
  assert.strictEqual(normalizeBoolean_('否'), false);
});

test('normalizeBoolean_: 空值回 null（不是 false）', function () {
  assert.strictEqual(normalizeBoolean_(''), null);
  assert.strictEqual(normalizeBoolean_(null), null);
  assert.strictEqual(normalizeBoolean_(undefined), null);
});

test('normalizeBoolean_: 無法判斷時拋錯，不可以默默當 false', function () {
  assert.throws(function () { normalizeBoolean_('maybe'); });
  assert.throws(function () { normalizeBoolean_('1'); });
  assert.throws(function () { normalizeBoolean_(1); });
  assert.throws(function () { normalizeBoolean_(0); });
});

// =====================================================================
// normalizeText_
// =====================================================================

test('normalizeText_: 空值回空字串', function () {
  assert.strictEqual(normalizeText_(''), '');
  assert.strictEqual(normalizeText_(null), '');
  assert.strictEqual(normalizeText_(undefined), '');
});

test('normalizeText_: 字串會 trim 前後空白', function () {
  assert.strictEqual(normalizeText_('  abc  '), 'abc');
  assert.strictEqual(normalizeText_('沒有空白'), '沒有空白');
});

test('normalizeText_: boolean 轉成 TRUE/FALSE 文字', function () {
  assert.strictEqual(normalizeText_(true), 'TRUE');
  assert.strictEqual(normalizeText_(false), 'FALSE');
});

test('normalizeText_: number 轉成文字', function () {
  assert.strictEqual(normalizeText_(5), '5');
  assert.strictEqual(normalizeText_(0), '0');
});

test('normalizeText_: Date 物件轉回 yyyy-MM-dd 文字，並記一筆型別警告', function () {
  clearSheetUtilsTypeWarnings_();
  const d = makeSandboxDate('2026-01-15');
  const result = normalizeText_(d, { sheet: 'TestSheet', key: 'TEST_FIELD', row: 5 });
  assert.strictEqual(result, '2026-01-15');

  const warnings = getSheetUtilsTypeWarnings_();
  assert.strictEqual(warnings.length, 1);
  assert.strictEqual(warnings[0].sheet, 'TestSheet');
  assert.strictEqual(warnings[0].key, 'TEST_FIELD');
  assert.strictEqual(warnings[0].row, 5);
  clearSheetUtilsTypeWarnings_();
});

test('normalizeText_: 沒有 context 也可以正常運作（只是警告訊息比較籠統）', function () {
  clearSheetUtilsTypeWarnings_();
  const d = makeSandboxDate('2026-06-01');
  const result = normalizeText_(d);
  assert.strictEqual(result, '2026-06-01');
  assert.strictEqual(getSheetUtilsTypeWarnings_().length, 1);
  clearSheetUtilsTypeWarnings_();
});

test('normalizeText_: 不支援的型別要拋錯', function () {
  assert.throws(function () { normalizeText_([1, 2, 3]); });
  assert.throws(function () { normalizeText_({ a: 1 }); });
});

// =====================================================================
// normalizeDate_
// =====================================================================

test('normalizeDate_: Date 物件原樣回傳', function () {
  const d = makeSandboxDate('2026-01-15');
  assert.strictEqual(normalizeDate_(d), d);
});

test('normalizeDate_: yyyy-MM-dd 字串轉成 Date', function () {
  const result = normalizeDate_('2026-01-15');
  assert.ok(isDate(result), '應該回傳 Date 物件');
  assert.strictEqual(result.getFullYear(), 2026);
  assert.strictEqual(result.getMonth(), 0);
  assert.strictEqual(result.getDate(), 15);
});

test('normalizeDate_: 空值回 null', function () {
  assert.strictEqual(normalizeDate_(''), null);
  assert.strictEqual(normalizeDate_(null), null);
  assert.strictEqual(normalizeDate_(undefined), null);
});

test('normalizeDate_: 非 yyyy-MM-dd 格式要拋錯', function () {
  assert.throws(function () { normalizeDate_('15/01/2026'); });
  assert.throws(function () { normalizeDate_('2026/01/15'); });
  assert.throws(function () { normalizeDate_(12345); });
  assert.throws(function () { normalizeDate_(true); });
});

test('normalizeDate_: 格式對但日期不存在要拋錯（不可以默默進位成另一個日期）', function () {
  assert.throws(function () { normalizeDate_('2026-13-01'); });
  assert.throws(function () { normalizeDate_('2026-02-30'); });
});

// =====================================================================
// normalizeInt_
// =====================================================================

test('normalizeInt_: 空值回 null', function () {
  assert.strictEqual(normalizeInt_(''), null);
  assert.strictEqual(normalizeInt_(null), null);
  assert.strictEqual(normalizeInt_(undefined), null);
});

test('normalizeInt_: number 與整數形狀的字串', function () {
  assert.strictEqual(normalizeInt_(5), 5);
  assert.strictEqual(normalizeInt_(0), 0);
  assert.strictEqual(normalizeInt_('5'), 5);
  assert.strictEqual(normalizeInt_('  5  '), 5);
  assert.strictEqual(normalizeInt_('-3'), -3);
});

test('normalizeInt_: 非整數要拋錯', function () {
  assert.throws(function () { normalizeInt_('5.5'); });
  assert.throws(function () { normalizeInt_(5.5); });
  assert.throws(function () { normalizeInt_('abc'); });
  assert.throws(function () { normalizeInt_({}); });
  assert.throws(function () { normalizeInt_([]); });
});

// =====================================================================
// normalizeByType_ 與 COLUMN_TYPES
// =====================================================================

test('normalizeByType_: 依 COLUMN_TYPES 分派到對應的正規化函式', function () {
  assert.strictEqual(normalizeByType_(COLUMN_TYPES.TEXT, '  abc  '), 'abc');
  assert.strictEqual(normalizeByType_(COLUMN_TYPES.BOOLEAN, 'TRUE'), true);
  assert.strictEqual(normalizeByType_(COLUMN_TYPES.INT, '5'), 5);
  const d = normalizeByType_(COLUMN_TYPES.DATE, '2026-01-15');
  assert.ok(isDate(d));
});

test('normalizeByType_: 未知型別要拋錯', function () {
  assert.throws(function () { normalizeByType_('NOT_A_REAL_TYPE', 'abc'); });
});

// =====================================================================

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
