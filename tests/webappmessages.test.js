#!/usr/bin/env node
/**
 * tests/webappmessages.test.js
 *
 * src/WebAppSave.gs 的 buildSaveResultMessage_() 與 src/WebApp.gs 的
 * buildRosterReloadMessage_() 回歸測試——把前端訊息文案的分支移到 `.gs`，
 * 讓它測得到（前端沒有 Node 測試）。
 *
 * 1. buildSaveResultMessage_(3) → type success、文字含「3」
 * 2. buildSaveResultMessage_(0) → type info、文字含「沒有偵測到任何改動」
 * 3. buildSaveResultMessage_() 與 (null) → 當作 0 處理，不可以拋錯
 * 4. buildRosterReloadMessage_(10, true) / (10, false) / (null, false) 三種文案
 * 5. apiSaveWeek 的回傳物件含 message 欄位（假 SpreadsheetApp 替身，真正入口）
 *
 * 執行方式：node tests/webappmessages.test.js
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

const sandbox = loadAllSrcFilesInOrder(GAS_STUBS);
const { buildSaveResultMessage_, buildRosterReloadMessage_ } = sandbox;

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
// 1-3. buildSaveResultMessage_
// =====================================================================

test('buildSaveResultMessage_(3)：type=success，文字含「3」', function () {
  var msg = buildSaveResultMessage_(3);
  assert.strictEqual(msg.type, 'success');
  assert.ok(msg.text.indexOf('3') !== -1, msg.text);
  assert.ok(msg.text.indexOf('已儲存') !== -1, msg.text);
});

test('buildSaveResultMessage_(0)：type=info，文字含「沒有偵測到任何改動」', function () {
  var msg = buildSaveResultMessage_(0);
  assert.strictEqual(msg.type, 'info');
  assert.ok(msg.text.indexOf('沒有偵測到任何改動') !== -1, msg.text);
});

test('buildSaveResultMessage_()／(null)：當作 0 處理，不拋錯', function () {
  assert.doesNotThrow(function () { buildSaveResultMessage_(); });
  assert.doesNotThrow(function () { buildSaveResultMessage_(null); });
  assert.strictEqual(buildSaveResultMessage_().type, 'info');
  assert.strictEqual(buildSaveResultMessage_(null).type, 'info');
  assert.strictEqual(buildSaveResultMessage_(undefined).type, 'info');
});

test('buildSaveResultMessage_：「有改動」與「沒有改動」用完全不同的一句話（不會共用同一句造成誤會）', function () {
  var withChanges = buildSaveResultMessage_(1);
  var noChanges = buildSaveResultMessage_(0);
  assert.notStrictEqual(withChanges.text, noChanges.text);
  assert.notStrictEqual(withChanges.type, noChanges.type);
});

// =====================================================================
// 4. buildRosterReloadMessage_
// =====================================================================

test('buildRosterReloadMessage_(10, true)：版本 10、已正式發出', function () {
  var msg = buildRosterReloadMessage_(10, true);
  assert.strictEqual(msg.type, 'info');
  assert.ok(msg.text.indexOf('10') !== -1, msg.text);
  assert.ok(msg.text.indexOf('已正式發出') !== -1, msg.text);
});

test('buildRosterReloadMessage_(10, false)：版本 10、尚未正式發出', function () {
  var msg = buildRosterReloadMessage_(10, false);
  assert.ok(msg.text.indexOf('10') !== -1, msg.text);
  assert.ok(msg.text.indexOf('尚未正式發出') !== -1, msg.text);
});

test('buildRosterReloadMessage_(null, false)：該季尚未生成職事表', function () {
  var msg = buildRosterReloadMessage_(null, false);
  assert.ok(msg.text.indexOf('尚未生成職事表') !== -1, msg.text);
  assert.strictEqual(msg.text.indexOf('null'), -1, '不應該把 null 原樣印出來：' + msg.text);
});

// =====================================================================
// 5. apiSaveWeek 的回傳物件含 message 欄位（由真正入口叫下去）
// =====================================================================

function ownSheetFor(sandboxRef, sheetId, rows) {
  const def = sandboxRef.COLUMNS[sheetId];
  return makeFakeSheet(def.headers, def.keys, rows || []);
}

/**
 * apiSaveWeek() 開頭會先跑 checkSheetSchema_()（第四b輪），對不齊的話
 * 一律拒絕儲存——所以這裡要把全部 17 張工作表都用程式碼自己的
 * COLUMNS 定義造出來（本來就是同一份資料，schema 檢查天生會通過），
 * 不能像更早的測試那樣只造 apiSaveWeek 用得到的幾張。
 */
function makeEnv(options) {
  const o = options || {};
  const freshSandbox = loadAllSrcFilesInOrder(GAS_STUBS);
  const configRows = freshSandbox.DEFAULTS.map(function (d) {
    return { KEY: d.key, VALUE: d.value, NOTE: '', EDITABLE: true };
  });

  const sheets = {};
  Object.keys(freshSandbox.SHEETS).forEach(function (sheetId) {
    const name = freshSandbox.SHEETS[sheetId];
    if (sheetId === 'CONFIG') {
      sheets[name] = makeFakeSheet(freshSandbox.COLUMNS.CONFIG.headers, freshSandbox.COLUMNS.CONFIG.keys, configRows);
      return;
    }
    if (sheetId === 'BULLETIN_WEEKS') {
      sheets[name] = ownSheetFor(freshSandbox, 'BULLETIN_WEEKS', o.bulletinWeeks || []);
      return;
    }
    sheets[name] = ownSheetFor(freshSandbox, sheetId, []);
  });

  const FakeApp = { getActiveSpreadsheet: function () { return makeFakeSpreadsheet(sheets); } };
  return loadAllSrcFilesInOrder(Object.assign({}, GAS_STUBS, { SpreadsheetApp: FakeApp }));
}

test('真正入口：apiSaveWeek() 有改動時，回傳的 data.message 是 success 且含改動數字', function () {
  var sb = makeEnv({
    bulletinWeeks: [{ SERVICE_DATE: '2027-10-03', QUARTER_ID: '2027T4', WEEK_OF_MONTH: 1, STATUS: 'DRAFT' }]
  });
  var resp = sb.apiSaveWeek({
    isoDate: '2027-10-03', lastSavedAt: null,
    week: { SERMON_TITLE: '因信稱義' },
    announcements: [], prayers: [], fellowships: [], finance: []
  });
  assert.strictEqual(resp.ok, true, JSON.stringify(resp));
  assert.strictEqual(resp.data.message.type, 'success');
  assert.ok(resp.data.message.text.indexOf(String(resp.data.changedFieldCount)) !== -1, resp.data.message.text);
});

test('真正入口：apiSaveWeek() 沒有改動時，回傳的 data.message 是 info', function () {
  var sb = makeEnv({
    bulletinWeeks: [{ SERVICE_DATE: '2027-10-03', QUARTER_ID: '2027T4', WEEK_OF_MONTH: 1, STATUS: 'DRAFT', SERMON_TITLE: '不變的講題' }]
  });
  var first = sb.apiSaveWeek({
    isoDate: '2027-10-03', lastSavedAt: null,
    week: { SERMON_TITLE: '不變的講題' },
    announcements: [], prayers: [], fellowships: [], finance: []
  });
  assert.strictEqual(first.ok, true, JSON.stringify(first));

  var reloadedLastSavedAt = sb.readSheet('BulletinWeeks')[0].LAST_SAVED_AT;
  var second = sb.apiSaveWeek({
    isoDate: '2027-10-03', lastSavedAt: reloadedLastSavedAt,
    week: { SERMON_TITLE: '不變的講題' },
    announcements: [], prayers: [], fellowships: [], finance: []
  });
  assert.strictEqual(second.ok, true, JSON.stringify(second));
  assert.strictEqual(second.data.changedFieldCount, 0);
  assert.strictEqual(second.data.message.type, 'info');
  assert.ok(second.data.message.text.indexOf('沒有偵測到任何改動') !== -1);
});

// =====================================================================

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
