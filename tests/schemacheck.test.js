#!/usr/bin/env node
/**
 * tests/schemacheck.test.js
 *
 * src/SchemaCheck.gs 的回歸測試：checkSheetSchema_() 唯讀比對試算表實際
 * 結構跟程式碼定義（SHEETS／COLUMNS／DEFAULTS）是否一致，以及
 * apiSaveWeek() 在結構落後時直接拒絕儲存（SCHEMA_OUTDATED，不寫入任何嘢）。
 *
 * 1. 完整 schema → ok:true
 * 2. 缺 Config 鍵／缺工作表／缺欄位 → 各自被列出
 * 3. apiSaveWeek 在 schema 落後時回 SCHEMA_OUTDATED 且沒有寫入
 *
 * 執行方式：node tests/schemacheck.test.js
 * 離開碼：0＝全部通過　1＝有測試失敗
 */

'use strict';

const assert = require('assert');
const { loadAllSrcFilesInOrder } = require('./helpers/loadGas');
const { makeFakeSheet, makeFakeSpreadsheet } = require('./helpers/fakeSpreadsheet');

const CALLER_EMAIL = 'tester@x.com';

const GAS_STUBS = {
  Utilities: { formatDate: function () { return ''; } },
  Session: {
    getScriptTimeZone: function () { return 'Pacific/Auckland'; },
    getActiveUser: function () { return { getEmail: function () { return CALLER_EMAIL; } }; },
    getEffectiveUser: function () { return { getEmail: function () { return CALLER_EMAIL; } }; }
  },
  SpreadsheetApp: {},
  CacheService: {},
  HtmlService: {}
};

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
 * checkSheetSchema_() 在 vm sandbox 內執行，回傳的陣列是 sandbox 自己
 * 那個 realm 的 Array——即使元素值相同，assert.deepStrictEqual() 會因為
 * 建構子不是同一個 Array 而判定「not reference-equal」。改用 JSON.stringify
 * 比較，跟 tests/dutybox.test.js 的 assertArrayEqual 同一個做法。
 */
function assertArrayEqual(actual, expected, message) {
  assert.strictEqual(JSON.stringify(actual), JSON.stringify(expected), message);
}

/**
 * 造一個「完整、跟程式碼定義完全一致」的假環境：每一張 SHEETS 定義的
 * 工作表都用 COLUMNS 的 headers／keys 造出來（跟程式碼定義本來就是同一份
 * 資料，schema 檢查天生會通過），Config 補齊全部 DEFAULTS。
 * `overrides` 可以整張替換或整張拿掉某個工作表、或替換 Config 資料列，
 * 用來造「缺這個、缺那個」的測試情境。
 */
function makeFullEnv(overrides) {
  const o = overrides || {};
  const freshSandbox = loadAllSrcFilesInOrder(GAS_STUBS);

  const configRows = (o.configRows !== undefined) ? o.configRows : freshSandbox.DEFAULTS.map(function (d) {
    return { KEY: d.key, VALUE: d.value, NOTE: d.note || '', EDITABLE: true };
  });

  const sheets = {};
  Object.keys(freshSandbox.SHEETS).forEach(function (sheetId) {
    const name = freshSandbox.SHEETS[sheetId];
    if (o.omitSheets && o.omitSheets.indexOf(name) !== -1) return;

    if (sheetId === 'CONFIG') {
      sheets[name] = makeFakeSheet(freshSandbox.COLUMNS.CONFIG.headers, freshSandbox.COLUMNS.CONFIG.keys, configRows);
      return;
    }

    var headers = freshSandbox.COLUMNS[sheetId].headers;
    var keys = freshSandbox.COLUMNS[sheetId].keys;
    if (o.corruptSheetKeys && o.corruptSheetKeys[name]) {
      keys = o.corruptSheetKeys[name];
    }
    sheets[name] = makeFakeSheet(headers, keys, []);
  });

  const FakeApp = { getActiveSpreadsheet: function () { return makeFakeSpreadsheet(sheets); } };
  return loadAllSrcFilesInOrder(Object.assign({}, GAS_STUBS, { SpreadsheetApp: FakeApp }));
}

// =====================================================================
// 1. 完整 schema → ok:true
// =====================================================================

test('checkSheetSchema_：完整、跟程式碼一致的環境 → ok:true，三個清單都是空的', function () {
  var sb = makeFullEnv();
  var result = sb.checkSheetSchema_();
  assert.strictEqual(result.ok, true);
  assertArrayEqual(result.missingConfigKeys, []);
  assertArrayEqual(result.missingSheets, []);
  assertArrayEqual(result.missingColumns, []);
});

// =====================================================================
// 2. 缺 Config 鍵／缺工作表／缺欄位 → 各自被列出
// =====================================================================

test('checkSheetSchema_：Config 少一個鍵 → missingConfigKeys 列出該鍵，其餘仍然是空的', function () {
  var sb = makeFullEnv();
  var configRows = sb.DEFAULTS
    .filter(function (d) { return d.key !== sb.CONFIG_KEYS.WEBAPP_ENABLED; })
    .map(function (d) { return { KEY: d.key, VALUE: d.value, NOTE: '', EDITABLE: true }; });

  var sb2 = makeFullEnv({ configRows: configRows });
  var result = sb2.checkSheetSchema_();
  assert.strictEqual(result.ok, false);
  assertArrayEqual(result.missingConfigKeys, [sb.CONFIG_KEYS.WEBAPP_ENABLED]);
  assertArrayEqual(result.missingSheets, []);
  assertArrayEqual(result.missingColumns, []);
});

test('checkSheetSchema_：整張工作表不存在 → missingSheets 列出該工作表名稱', function () {
  var sb = makeFullEnv({ omitSheets: ['ErrorLog'] });
  var result = sb.checkSheetSchema_();
  assert.strictEqual(result.ok, false);
  assertArrayEqual(result.missingSheets, ['ErrorLog']);
  assertArrayEqual(result.missingColumns, []);
});

test('checkSheetSchema_：工作表存在但少一欄（第 2 行機器鍵對不上）→ missingColumns 列出該表與缺的欄', function () {
  var sb = makeFullEnv({
    corruptSheetKeys: {
      BulletinWeeks: ['SERVICE_DATE', 'QUARTER_ID'] // 只留兩欄，其餘全部對不上位置
    }
  });
  var result = sb.checkSheetSchema_();
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.missingColumns.length, 1);
  assert.strictEqual(result.missingColumns[0].sheet, 'BulletinWeeks');
  assert.ok(result.missingColumns[0].keys.indexOf('LAST_SAVED_AT') !== -1, '應該列出對不上的欄，包含 LAST_SAVED_AT');
  assert.ok(result.missingColumns[0].keys.indexOf('SERVICE_DATE') === -1, 'SERVICE_DATE 位置沒問題，不應該被列出');
});

test('checkSheetSchema_：多種落差同時發生時，三個清單各自正確列出，不會互相蓋掉', function () {
  var configRows = [{ KEY: 'DRY_RUN', VALUE: 'TRUE', NOTE: '', EDITABLE: true }]; // 只留一個鍵
  var sb = makeFullEnv({
    configRows: configRows,
    omitSheets: ['SendLog'],
    corruptSheetKeys: { Announcements: ['SERVICE_DATE'] }
  });
  var result = sb.checkSheetSchema_();
  assert.strictEqual(result.ok, false);
  assert.ok(result.missingConfigKeys.length > 1);
  assertArrayEqual(result.missingSheets, ['SendLog']);
  assert.strictEqual(result.missingColumns.length, 1);
  assert.strictEqual(result.missingColumns[0].sheet, 'Announcements');
});

test('buildSchemaShortSummary_／buildSchemaMismatchSummary_：ok 時回空字串', function () {
  var sb = makeFullEnv();
  var result = sb.checkSheetSchema_();
  assert.strictEqual(sb.buildSchemaShortSummary_(result), '');
  assert.strictEqual(sb.buildSchemaMismatchSummary_(result), '');
});

test('buildSchemaShortSummary_：落差時回一行含三個計數的摘要', function () {
  var sb = makeFullEnv({ omitSheets: ['SendLog', 'ErrorLog'] });
  var result = sb.checkSheetSchema_();
  var summary = sb.buildSchemaShortSummary_(result);
  assert.ok(summary.indexOf('2 張工作表') !== -1, '摘要：' + summary);
  assert.strictEqual(summary.indexOf('\n'), -1, '短摘要不應該有換行');
});

// =====================================================================
// 3. apiSaveWeek 在 schema 落後時回 SCHEMA_OUTDATED 且沒有寫入
// =====================================================================

test('真正入口：apiSaveWeek() 在工作表結構落後於程式碼時拒絕儲存，error.code 是 SCHEMA_OUTDATED，且完全沒有寫入', function () {
  var sb = makeFullEnv({ omitSheets: [] , corruptSheetKeys: { BulletinWeeks: ['SERVICE_DATE'] } });
  // BulletinWeeks 本身結構壞了，但 apiSaveWeek 應該在動任何工作表之前就先被 schema 檢查擋下。
  var beforeAudit = JSON.stringify(sb.readSheet('AuditLog'));

  var resp = sb.apiSaveWeek({
    isoDate: '2027-10-03',
    lastSavedAt: null,
    week: { SERMON_TITLE: '不應該存得進去' },
    announcements: [], prayers: [], fellowships: [], finance: []
  });

  assert.strictEqual(resp.ok, false);
  assert.strictEqual(resp.error.code, 'SCHEMA_OUTDATED');
  assert.ok(resp.error.message.indexOf('初始化工作表') !== -1, '訊息要提示去撳「初始化工作表」：' + resp.error.message);

  var afterAudit = JSON.stringify(sb.readSheet('AuditLog'));
  assert.strictEqual(afterAudit, beforeAudit, 'AuditLog 不應該有任何新記錄');
});

test('真正入口：schema 正常時 apiSaveWeek() 照常運作（確認上一個測試不是因為別的原因失敗）', function () {
  var sb = makeFullEnv();
  var resp = sb.apiSaveWeek({
    isoDate: '2027-10-03',
    lastSavedAt: null,
    week: { SERMON_TITLE: '正常儲存' },
    announcements: [], prayers: [], fellowships: [], finance: []
  });
  assert.strictEqual(resp.ok, true, JSON.stringify(resp));
  assert.ok(resp.data.changedFieldCount > 0);
});

// =====================================================================

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
