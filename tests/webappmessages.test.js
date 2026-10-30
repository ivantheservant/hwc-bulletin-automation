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
const { assertWrittenChinese } = require('./helpers/writtenChinese');

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
    week: { FLOWER_THIS_WEEK: '因信稱義' }, baseWeek: { FLOWER_THIS_WEEK: '' },
    announcements: [], prayers: [], fellowships: [], finance: []
  });
  assert.strictEqual(resp.ok, true, JSON.stringify(resp));
  assert.strictEqual(resp.data.message.type, 'success');
  assert.ok(resp.data.message.text.indexOf(String(resp.data.changedFieldCount)) !== -1, resp.data.message.text);
});

test('真正入口：apiSaveWeek() 沒有改動時，回傳的 data.message 是 info', function () {
  var sb = makeEnv({
    bulletinWeeks: [{ SERVICE_DATE: '2027-10-03', QUARTER_ID: '2027T4', WEEK_OF_MONTH: 1, STATUS: 'DRAFT' }]
  });
  var first = sb.apiSaveWeek({
    isoDate: '2027-10-03', lastSavedAt: null,
    week: { FLOWER_THIS_WEEK: '不變的講題' }, baseWeek: { FLOWER_THIS_WEEK: '' },
    announcements: [], prayers: [], fellowships: [], finance: []
  });
  assert.strictEqual(first.ok, true, JSON.stringify(first));

  var reloadedLastSavedAt = sb.readSheet_('BulletinWeeks')[0].LAST_SAVED_AT;
  var second = sb.apiSaveWeek({
    isoDate: '2027-10-03', lastSavedAt: reloadedLastSavedAt,
    week: { FLOWER_THIS_WEEK: '不變的講題' }, baseWeek: { FLOWER_THIS_WEEK: '不變的講題' },
    announcements: [], prayers: [], fellowships: [], finance: []
  });
  assert.strictEqual(second.ok, true, JSON.stringify(second));
  assert.strictEqual(second.data.changedFieldCount, 0);
  assert.strictEqual(second.data.message.type, 'info');
  assert.ok(second.data.message.text.indexOf('沒有偵測到任何改動') !== -1);
});

// =====================================================================
// G16：完成訊息的欄位數只數使用者改了的欄位，覆寫記錄不計
// （2028-04-09 瀏覽器重測：只改「回應詩歌」一格，訊息講「更新了 2 個欄位」）
// =====================================================================

const G16_DATE = '2027-10-03';

/** 一個由內容表帶入「回應詩歌」的主日（RESPONSE_HYMN 是內容表為來源、介面可覆寫的欄位）。 */
function makeG16Env() {
  return makeEnv({
    bulletinWeeks: [{
      SERVICE_DATE: G16_DATE, QUARTER_ID: '2027T4', WEEK_OF_MONTH: 1, STATUS: 'DRAFT',
      RESPONSE_HYMN: '內容表的詩歌', PRELUDE: '', CHOIR_LABEL: ''
    }]
  });
}

/** 經真正入口 apiSaveWeek() 儲存；week 是改了的欄位，baseWeek 是它們載入時的值。 */
function g16Save(sb, week, baseWeek) {
  var resp = sb.apiSaveWeek({
    isoDate: G16_DATE, lastSavedAt: sb.readSheet_('BulletinWeeks')[0].LAST_SAVED_AT || null,
    week: week, baseWeek: baseWeek
  });
  assert.strictEqual(resp.ok, true, JSON.stringify(resp.error));
  return resp.data;
}

function g16Actions(sb, fromIndex) {
  // JSON 來回一次：陣列來自 sandbox 那一個 realm，deepStrictEqual 會判成不同。
  return JSON.parse(JSON.stringify(sb.readSheet_('AuditLog').slice(fromIndex || 0)
    .map(function (r) { return r.ACTION + (r.FIELD ? ' ' + r.FIELD : ''); })
    .filter(function (a) { return a.indexOf('WEBAPP_SAVE_WEEK') === 0 || a.indexOf('FIELD_OVERRIDE_') === 0; })));
}

// v3（Ivan 測試結果 A 第 10 項）：回應詩歌、詩班項目名稱等九欄改為只可以在內容表輸入，介面不再有覆寫
//    （FieldOverride 不再有可覆寫欄位）。G16-1 至 G16-4 原本測「內容表欄位＋覆寫記錄」的計數，改測新規則。
test('G16-1 v3 真正入口 apiSaveWeek：送內容表才可以改的欄位（回應詩歌）→ 整次拒絕（CONTENT_SHEET_READONLY），一格都沒有寫', function () {
  var sb = makeG16Env();
  var auditBefore = sb.readSheet_('AuditLog').length;
  var weekBefore = JSON.stringify(sb.readSheet_('BulletinWeeks'));
  var resp = sb.apiSaveWeek({
    isoDate: G16_DATE, lastSavedAt: null,
    week: { RESPONSE_HYMN: '幹事改的詩歌' }, baseWeek: { RESPONSE_HYMN: '內容表的詩歌' }
  });
  assert.strictEqual(resp.ok, false);
  assert.strictEqual(resp.error.code, 'CONTENT_SHEET_READONLY');
  assert.ok(resp.error.message.indexOf('回應詩歌') !== -1, '訊息要講出是哪一欄');
  assert.strictEqual(sb.readSheet_('AuditLog').length, auditBefore);
  assert.strictEqual(JSON.stringify(sb.readSheet_('BulletinWeeks')), weekBefore);
  assertWrittenChinese(assert, 'G16-1 v3 訊息', [resp.error.message]);
});

test('G16-2 v3 真正入口 apiSaveWeek：改兩個介面欄位（程序表大標題、本週獻花）→「已儲存，更新了 2 個欄位。」', function () {
  var sb = makeG16Env();
  var data = g16Save(sb, { PAGE_TITLE: '宣教主日', FLOWER_THIS_WEEK: '陳姊妹' }, { PAGE_TITLE: '', FLOWER_THIS_WEEK: '' });
  assert.deepStrictEqual(g16Actions(sb), ['WEBAPP_SAVE_WEEK PAGE_TITLE', 'WEBAPP_SAVE_WEEK FLOWER_THIS_WEEK']);
  assert.strictEqual(data.changedFieldCount, 2);
  assert.strictEqual(data.sideRecordCount, 0);
  assert.strictEqual(data.message.text, '已儲存，更新了 2 個欄位。');
});

test('G16-3 v3 真正入口 apiSaveWeek：這一週的程序增刪（PROGRAM_EDITS）照一般欄位儲存，訊息「更新了 1 個欄位」', function () {
  var sb = makeG16Env();
  var edits = JSON.stringify({ v: 1, hidden: ['拍照#1'], added: [] });
  var data = g16Save(sb, { PROGRAM_EDITS: edits }, { PROGRAM_EDITS: '' });
  assert.deepStrictEqual(g16Actions(sb), ['WEBAPP_SAVE_WEEK PROGRAM_EDITS']);
  assert.strictEqual(sb.readSheet_('BulletinWeeks')[0].PROGRAM_EDITS, edits);
  assert.strictEqual(data.message.text, '已儲存，更新了 1 個欄位。');
});

test('G16-4 v3 真正入口 apiSaveWeek：程序增刪格式不對 → 整次拒絕（INVALID_ARRANGEMENT），一格都沒有寫；只更新覆寫記錄的訊息照舊（事奉框覆寫用）', function () {
  var sb = makeG16Env();
  var auditBefore = sb.readSheet_('AuditLog').length;
  var resp = sb.apiSaveWeek({
    isoDate: G16_DATE, lastSavedAt: null,
    week: { PROGRAM_EDITS: '{壞了', PAGE_TITLE: '不應寫入' }, baseWeek: { PROGRAM_EDITS: '', PAGE_TITLE: '' }
  });
  assert.strictEqual(resp.ok, false);
  assert.strictEqual(resp.error.code, 'INVALID_ARRANGEMENT');
  assert.strictEqual(sb.readSheet_('AuditLog').length, auditBefore);
  assert.strictEqual(String(sb.readSheet_('BulletinWeeks')[0].PAGE_TITLE || ''), '');
  var msg = JSON.parse(JSON.stringify(sb.buildSaveResultMessage_(0, 1)));
  assert.strictEqual(msg.text,
    '已儲存。欄位內容沒有改變，只更新了 1 筆覆寫記錄（例如取消已經與內容表或職事表相同的覆寫，或記下覆寫對照的職事表現值）。');
  assertWrittenChinese(assert, 'G16-4 v3 訊息', [resp.error.message, msg.text]);
});

test('G16-5 countSaveChanges_：事奉框同一格幾筆條目只算一個欄位；只更新覆寫對照的職事表值、取消一筆名字已經相同的覆寫算附帶記錄；本週與下週同一崗位是兩個欄位', function () {
  var count = function (entries) { return JSON.parse(JSON.stringify(sandbox.countSaveChanges_(entries))); };
  var duty = function (iso, action, field, extra) {
    return Object.assign({ action: action, sheetName: 'DutyOverride', rowKey: iso + '#CHAIR#1', field: field }, extra || {});
  };
  assert.deepStrictEqual(count([
    duty('2027-10-03', 'DUTY_OVERRIDE_SET', 'OVERRIDE_NAME'),
    duty('2027-10-03', 'DUTY_OVERRIDE_SET', 'ROSTER_VERSION_AT_OVERRIDE')
  ]), { fieldCount: 1, sideRecordCount: 0 }, '名字與版本一齊改：一個欄位');
  assert.deepStrictEqual(count([
    duty('2027-10-03', 'DUTY_OVERRIDE_SET', 'ROSTER_VALUE_AT_OVERRIDE'),
    duty('2027-10-03', 'DUTY_OVERRIDE_SET', 'ROSTER_VERSION_AT_OVERRIDE')
  ]), { fieldCount: 0, sideRecordCount: 1 }, '只更新對照基準：一筆附帶記錄');
  assert.deepStrictEqual(count([duty('2027-10-03', 'DUTY_OVERRIDE_SET', 'ACTIVE')]),
    { fieldCount: 1, sideRecordCount: 0 }, '重新啟用一筆覆寫：畫面上那一格會變');
  assert.deepStrictEqual(count([duty('2027-10-03', 'DUTY_OVERRIDE_CLEAR', 'ACTIVE', { displayUnchanged: false })]),
    { fieldCount: 1, sideRecordCount: 0 });
  assert.deepStrictEqual(count([duty('2027-10-03', 'DUTY_OVERRIDE_CLEAR', 'ACTIVE', { displayUnchanged: true })]),
    { fieldCount: 0, sideRecordCount: 1 });
  assert.deepStrictEqual(count([
    duty('2027-10-03', 'DUTY_OVERRIDE_SET', 'OVERRIDE_NAME'),
    duty('2027-10-10', 'DUTY_OVERRIDE_SET', 'OVERRIDE_NAME')
  ]), { fieldCount: 2, sideRecordCount: 0 }, '本週事奉與下週事奉同一崗位：兩個欄位');
  assert.deepStrictEqual(count([{ action: 'SOMETHING_NEW', sheetName: 'X', rowKey: 'k', field: 'F' }]),
    { fieldCount: 1, sideRecordCount: 0 }, '未知的動作代碼當作一個欄位，不可以講成沒有改動');
  assert.deepStrictEqual(count(null), { fieldCount: 0, sideRecordCount: 0 });

  var sideOnly = buildSaveResultMessage_(0, 2);
  assert.strictEqual(sideOnly.type, 'success');
  assert.ok(sideOnly.text.indexOf('只更新了 2 筆覆寫記錄') !== -1, sideOnly.text);
  assert.strictEqual(buildSaveResultMessage_(3, 2).text, '已儲存，更新了 3 個欄位。', '有欄位就只講欄位數');
  assert.strictEqual(buildSaveResultMessage_(0, 0).type, 'info');
});

test('G16-6 儲存路徑內每一個 AuditLog 動作代碼都判斷過算不算欄位（新增動作代碼要在 countSaveChanges_() 判斷一次再改這裏）', function () {
  var fs = require('fs');
  var path = require('path');
  var src = ['WebAppSave.gs', 'DutyOverride.gs', 'FieldOverride.gs'].map(function (f) {
    return fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8');
  }).join('\n');
  var found = {};
  (src.match(/action:\s*(?:action \|\| )?'[A-Z_]+'/g) || []).forEach(function (m) { found[m.match(/'([A-Z_]+)'/)[1]] = true; });
  Object.keys(sandbox.webAppListDefs_()).forEach(function (type) { found['WEBAPP_SAVE_' + type.toUpperCase()] = true; });
  var expected = {
    WEBAPP_SAVE_WEEK: 'FIELD', WEBAPP_SAVE_ANNOUNCEMENTS: 'FIELD', WEBAPP_SAVE_PRAYERS: 'FIELD',
    WEBAPP_SAVE_FELLOWSHIPS: 'FIELD', WEBAPP_SAVE_FINANCE: 'FIELD',
    DUTY_OVERRIDE_SET: 'FIELD（名字或 ACTIVE）／附帶（只有對照基準）', DUTY_OVERRIDE_CLEAR: 'FIELD／附帶（名字本來相同）',
    FIELD_OVERRIDE_SET: 'SIDE', FIELD_OVERRIDE_CLEAR: 'SIDE'
  };
  assert.deepStrictEqual(Object.keys(found).sort(), Object.keys(expected).sort(),
    '儲存路徑的動作代碼有增減：先在 countSaveChanges_() 判斷，再更新這裏');
  ['FIELD_OVERRIDE_SET', 'FIELD_OVERRIDE_CLEAR'].forEach(function (a) {
    assert.strictEqual(sandbox.countSaveChanges_([{ action: a, sheetName: 'FieldOverride', rowKey: 'k' }]).fieldCount, 0, a);
  });
  Object.keys(expected).filter(function (a) { return expected[a] === 'FIELD'; }).forEach(function (a) {
    assert.strictEqual(sandbox.countSaveChanges_([{ action: a, sheetName: 'S', rowKey: 'k', field: 'F' }]).fieldCount, 1, a);
  });
});

// =====================================================================

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
