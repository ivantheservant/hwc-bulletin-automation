#!/usr/bin/env node
/**
 * tests/threewaysave.test.js
 *
 * 2028T2 瀏覽器無人看管測試（2026-10-21）之後的修正：F1／F2／F8。
 *
 *   F1　舊分頁儲存會靜靜蓋走伺服器端剛寫入的值（測試 I3）。
 *       修法：前端只送改過的欄位 ＋ 它們載入時的值（`baseWeek`），後端做
 *       三方比較（工作表現值／送來的值／載入時的值）。
 *   F2　沒有任何改動的儲存也更新 `LAST_SAVED_AT`，令另一分頁誤報 STALE。
 *   F8　樂觀鎖擋下被當成錯誤寫進 `ErrorLog`。
 *
 * ⚠️ 全部經**真正入口** `saveWeekFromWebApp_()`／`apiSaveWeek()`。「別處在伺服器端寫入」
 *    以前用真正的 `onFillGridEdit_()`（季度填寫表觸發器）模擬；內容表 v2 停用季度填寫表之後，
 *    那條路一格都不寫，改用 `writeBulletinWeekField_()`——內容表匯入、講員表格等伺服器端寫入
 *    共用的那一支，同樣不更新 `LAST_SAVED_AT`，所以 I3 那一點照樣測得出來。
 *
 * 執行方式：node tests/threewaysave.test.js
 * 離開碼：0＝全部通過　1＝有測試失敗
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { makeFillEnv, QUARTER_ID } = require('./helpers/fillEnv');

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
    console.log('    ' + (err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n    ') : err));
  }
}

const D = '2027-11-07';

/** 造一個已經建立季度填寫表的環境。 */
function makeSyncedEnv() {
  const env = makeFillEnv({ withGrid: false });
  env.sandbox.createOrRefreshFillGrid_(QUARTER_ID);
  return env;
}

/**
 * 模擬「別處在伺服器端寫入」BulletinWeeks（不更新 LAST_SAVED_AT）。內容表 v2 之前用季度填寫表的
 * onEdit 觸發器；那條路停用之後，改用內容表匯入、講員表格共用的 writeBulletinWeekField_()。
 * 名字保留 gridEdit，免得下面每一條都要改。
 */
function gridEdit(env, isoDate, fieldKey, value) {
  assert.strictEqual(env.sandbox.writeBulletinWeekField_(isoDate, fieldKey, value), true, '前提：寫得到 ' + isoDate);
}

function weekRow(env, isoDate) {
  return env.sandbox.readSheet('BulletinWeeks').filter(function (r) {
    return env.sandbox.fillGridCellText_(r.SERVICE_DATE) === isoDate;
  })[0];
}

/** 把會被儲存碰到的全部工作表拍一張快照，比較「一格都沒有寫」。 */
function snapshotAll(env) {
  const names = ['BulletinWeeks', 'AuditLog', 'FieldOverride', 'DutyOverride', 'FillSnapshot', 'ErrorLog'];
  const out = {};
  names.forEach(function (n) { out[n] = JSON.stringify(env.sandbox.readSheet(n)); });
  out.grid = JSON.stringify(env.sheets['Fill_' + QUARTER_ID].__data);
  return out;
}

function assertNothingWritten(env, before, label) {
  const after = snapshotAll(env);
  Object.keys(before).forEach(function (k) {
    if (k === 'ErrorLog') return; // ErrorLog 由 F8 另外檢查
    assert.strictEqual(after[k], before[k], (label || '') + k + ' 不應該有任何變動');
  });
}

function catchError(fn) {
  try { fn(); } catch (err) { return err; }
  return null;
}

// =====================================================================
// F1：重現測試 I3
// =====================================================================

console.log('\nF1：只送改過的欄位 ＋ 三方比較');

test('F1-1 重現 I3：伺服器端寫了序樂之後，較早載入的分頁只改獻花儲存 → 序樂保持新值', function () {
  const env = makeSyncedEnv();
  // 分頁載入：序樂與獻花都是空白，LAST_SAVED_AT 從未有過。
  const loadedToken = env.sandbox.canonicalSaveToken_(weekRow(env, D).LAST_SAVED_AT);

  // 別處在伺服器端改了序樂（以前是季度填寫表的觸發器）→ 寫入 BulletinWeeks，不碰 LAST_SAVED_AT。
  gridEdit(env, D, 'PRELUDE', '格子表改的序樂');
  assert.strictEqual(weekRow(env, D).PRELUDE, '格子表改的序樂');
  assert.strictEqual(env.sandbox.canonicalSaveToken_(weekRow(env, D).LAST_SAVED_AT), loadedToken,
    '前提：伺服器端寫入不更新 LAST_SAVED_AT，所以整行 STALE 檢查擋不住這種情況');

  // 舊分頁只改「本週獻花」。前端只送改過的欄位，另送它們載入時的值。
  const result = env.sandbox.saveWeekFromWebApp_({
    isoDate: D, lastSavedAt: loadedToken,
    baseWeek: { FLOWER_THIS_WEEK: '' },
    week: { FLOWER_THIS_WEEK: '玫瑰' }
  });

  assert.strictEqual(result.changedFieldCount, 1, '只有獻花一格是這次真的改動');
  assert.strictEqual(weekRow(env, D).FLOWER_THIS_WEEK, '玫瑰');
  assert.strictEqual(weekRow(env, D).PRELUDE, '格子表改的序樂', '⚠️ 序樂不可以被蓋回舊值（空白）');
  // 內容表 v2：以前這裏再驗「格子表即時刷新、同步之後兩邊一致」；季度填寫表已停用，儲存不再碰 Fill_
  // （見 tests/fillgrid.test.js 第 9 組），所以拿走那幾句。
});

test('F1-2 同一格兩邊都改過 → FIELD_CONFLICT，整次拒絕，一格都沒有寫（含 LAST_SAVED_AT／FieldOverride／DutyOverride）', function () {
  const env = makeSyncedEnv();
  gridEdit(env, D, 'PRELUDE', '格子表改的序樂');
  const before = snapshotAll(env);

  const err = catchError(function () {
    env.sandbox.saveWeekFromWebApp_({
      isoDate: D, lastSavedAt: '',
      baseWeek: { PRELUDE: '', FLOWER_THIS_WEEK: '', SERMON_TITLE: '' },
      // 序樂與格子表那邊衝突；獻花、講題本身沒有衝突，但整次都不可以寫。
      week: { PRELUDE: '分頁改的序樂', FLOWER_THIS_WEEK: '玫瑰', SERMON_TITLE: '分頁改的講題' },
      payloadVersion: 2,
      dutyEdits: [{ postId: 'CHAIR', slotIndex: 1, name: '李小明' }],
      nextWeekDutyEdits: [{ postId: 'CHAIR', slotIndex: 1, name: '王小華' }]
    });
  });

  assert.ok(err, '應該拋出例外');
  assert.strictEqual(err.code, 'FIELD_CONFLICT');
  assert.strictEqual(err.message,
    '以下欄位在你載入之後已經被改過（可能是內容表匯入或另一個分頁）：序樂。'
    + '請重新載入再改，以免蓋走別人的修改。');
  assert.deepStrictEqual(Array.from(err.conflictFields), ['PRELUDE']);
  assertNothingWritten(env, before);
  assert.strictEqual(weekRow(env, D).FLOWER_THIS_WEEK, '', '連沒有衝突的獻花也不可以寫');
  assert.strictEqual(env.sandbox.readSheet('FieldOverride').length, 0);
  assert.strictEqual(env.sandbox.readSheet('DutyOverride').length, 0);
});

test('F1-3 衝突訊息用介面標籤，不用機器鍵；多個欄位用「、」分隔', function () {
  const env = makeSyncedEnv();
  gridEdit(env, D, 'PRELUDE', 'A');
  gridEdit(env, D, 'FLOWER_THIS_WEEK', 'B');
  const err = catchError(function () {
    env.sandbox.saveWeekFromWebApp_({
      isoDate: D, lastSavedAt: '',
      baseWeek: { PRELUDE: '', FLOWER_THIS_WEEK: '' },
      week: { PRELUDE: 'X', FLOWER_THIS_WEEK: 'Y' }
    });
  });
  assert.strictEqual(err.code, 'FIELD_CONFLICT');
  assert.ok(err.message.indexOf('序樂、本週獻花') !== -1, err.message);
  assert.strictEqual(err.message.indexOf('PRELUDE'), -1, '不可以出現機器鍵：' + err.message);
});

test('F1-4 別處剛好改成跟你送的同一個值 → 不算衝突，也不用重寫', function () {
  const env = makeSyncedEnv();
  gridEdit(env, D, 'PRELUDE', '同一個序樂');
  const result = env.sandbox.saveWeekFromWebApp_({
    isoDate: D, lastSavedAt: '',
    baseWeek: { PRELUDE: '' }, week: { PRELUDE: '同一個序樂' }
  });
  assert.strictEqual(result.changedFieldCount, 0);
  assert.strictEqual(weekRow(env, D).PRELUDE, '同一個序樂');
});

test('F1-5 沒有 baseWeek（舊版前端仍然送整張表單）→ CLIENT_OUTDATED，一格都沒有寫', function () {
  const env = makeSyncedEnv();
  gridEdit(env, D, 'PRELUDE', '格子表改的序樂');
  const before = snapshotAll(env);

  const err = catchError(function () {
    env.sandbox.saveWeekFromWebApp_({
      isoDate: D, lastSavedAt: '',
      // 舊版前端：整張表單，序樂是載入時的舊值（空白）。
      week: { PRELUDE: '', FLOWER_THIS_WEEK: '玫瑰', SERMON_TITLE: '', PAGE_TITLE: '' },
      dutyEdits: []
    });
  });

  assert.ok(err);
  assert.strictEqual(err.code, 'CLIENT_OUTDATED');
  assert.strictEqual(err.message, '介面版本已更新，請重新載入這一頁再儲存。');
  assertNothingWritten(env, before);
  assert.strictEqual(weekRow(env, D).PRELUDE, '格子表改的序樂', '不可以退回舊的整張寫入');
});

test('F1-6 baseWeek 不是物件（null／陣列／字串）一律當作沒有', function () {
  const env = makeSyncedEnv();
  [null, [], 'x', 7].forEach(function (bad) {
    const err = catchError(function () {
      env.sandbox.saveWeekFromWebApp_({ isoDate: D, lastSavedAt: '', baseWeek: bad, week: { FLOWER_THIS_WEEK: 'a' } });
    });
    assert.ok(err && err.code === 'CLIENT_OUTDATED', '收到 ' + JSON.stringify(bad));
  });
});

test('F1-7 normalizeWeekPayloadForCompare_ 只處理 payload 內有出現的鍵（不再把缺少的鍵補成空白）', function () {
  const env = makeSyncedEnv();
  const partial = env.sandbox.normalizeWeekPayloadForCompare_({ FLOWER_THIS_WEEK: '玫瑰' });
  assert.deepStrictEqual(Object.keys(partial), ['FLOWER_THIS_WEEK']);
  assert.deepStrictEqual(Object.keys(env.sandbox.normalizeWeekPayloadForCompare_({})), []);
  assert.deepStrictEqual(Object.keys(env.sandbox.normalizeWeekPayloadForCompare_(null)), []);
  const withNull = env.sandbox.normalizeWeekPayloadForCompare_({ PRELUDE: null });
  assert.strictEqual(withNull.PRELUDE, '', '有出現的鍵，null 照舊當空白');
});

test('F1-8 只改一格的部分 payload 不會清空其餘欄位', function () {
  const env = makeSyncedEnv();
  gridEdit(env, D, 'PRELUDE', '序樂甲');
  gridEdit(env, D, 'HYMN_PRAISE', '詩歌乙');
  gridEdit(env, D, 'PAGE_TITLE', '標題丙');
  env.sandbox.saveWeekFromWebApp_({
    isoDate: D, lastSavedAt: '', baseWeek: { FLOWER_THIS_WEEK: '' }, week: { FLOWER_THIS_WEEK: '玫瑰' }
  });
  const w = weekRow(env, D);
  assert.strictEqual(w.PRELUDE, '序樂甲');
  assert.strictEqual(w.HYMN_PRAISE, '詩歌乙');
  assert.strictEqual(w.PAGE_TITLE, '標題丙');
});

test('F1-9 BulletinWeeks 沒有該主日那一行（防呆補行）→ 部分 payload 照常建立，未出現的欄位是空白', function () {
  const env = makeFillEnv({ withGrid: false, weekRows: [] });
  env.sandbox.saveWeekFromWebApp_({
    isoDate: D, lastSavedAt: '', baseWeek: { FLOWER_THIS_WEEK: '' }, week: { FLOWER_THIS_WEEK: '玫瑰' }
  });
  const w = weekRow(env, D);
  assert.ok(w, '要補一行');
  assert.strictEqual(w.FLOWER_THIS_WEEK, '玫瑰');
  assert.strictEqual(w.PRELUDE, '');
});

test('F1-10 沒有衝突的正常改動：舊值 = baseWeek → 照寫，並逐格記 AuditLog', function () {
  const env = makeSyncedEnv();
  gridEdit(env, D, 'PRELUDE', '舊序樂');
  const token = env.sandbox.canonicalSaveToken_(weekRow(env, D).LAST_SAVED_AT);
  const result = env.sandbox.saveWeekFromWebApp_({
    isoDate: D, lastSavedAt: token,
    baseWeek: { PRELUDE: '舊序樂' }, week: { PRELUDE: '新序樂' }
  });
  assert.strictEqual(result.changedFieldCount, 1);
  assert.strictEqual(weekRow(env, D).PRELUDE, '新序樂');
  const audit = env.sandbox.readSheet('AuditLog').filter(function (r) { return r.ACTION === 'WEBAPP_SAVE_WEEK'; });
  assert.strictEqual(audit.length, 1);
  assert.strictEqual(audit[0].OLD_VALUE, '舊序樂');
  assert.strictEqual(audit[0].NEW_VALUE, '新序樂');
});

test('F1-11 沒有改動的第三種欄位不會被開覆寫（FieldOverride 沒有新行）', function () {
  const env = makeSyncedEnv();
  // 講題由別處寫入（等同內容表匯入後 BulletinWeeks 的新值）。
  gridEdit(env, D, 'SERMON_TITLE', '別處寫入的講題');
  const overridesBefore = env.sandbox.readSheet('FieldOverride').length;

  // 舊分頁只改獻花；講題沒有改，所以前端根本不送。
  env.sandbox.saveWeekFromWebApp_({
    isoDate: D, lastSavedAt: '', baseWeek: { FLOWER_THIS_WEEK: '' }, week: { FLOWER_THIS_WEEK: '玫瑰' }
  });
  assert.strictEqual(weekRow(env, D).SERMON_TITLE, '別處寫入的講題');
  assert.strictEqual(env.sandbox.readSheet('FieldOverride').length, overridesBefore,
    '⚠️ 不可以替沒有改過的舊值開覆寫（否則內容表之後的新值會被永遠擋住）');
});

test('F1-12 使用者真的改了第三種欄位 → 照舊寫成 FieldOverride', function () {
  const env = makeSyncedEnv();
  env.sandbox.saveWeekFromWebApp_({
    isoDate: D, lastSavedAt: '', baseWeek: { SERMON_TITLE: '' }, week: { SERMON_TITLE: '我改的講題' }
  });
  const rows = env.sandbox.readSheet('FieldOverride').filter(function (r) { return r.FIELD_KEY === 'SERMON_TITLE'; });
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].OVERRIDE_VALUE, '我改的講題');
  assert.strictEqual(rows[0].ACTIVE, true);
});

test('F1-13 整行 STALE 檢查保留：LAST_SAVED_AT 不符 → STALE，一格都沒有寫', function () {
  const env = makeSyncedEnv();
  env.sandbox.saveWeekFromWebApp_({
    isoDate: D, lastSavedAt: '', baseWeek: { FLOWER_THIS_WEEK: '' }, week: { FLOWER_THIS_WEEK: '第一次' }
  });
  const before = snapshotAll(env);
  const err = catchError(function () {
    env.sandbox.saveWeekFromWebApp_({
      isoDate: D, lastSavedAt: '', baseWeek: { FLOWER_THIS_WEEK: '第一次' }, week: { FLOWER_THIS_WEEK: '第二次' }
    });
  });
  assert.strictEqual(err.code, 'STALE');
  assertNothingWritten(env, before);
});

// =====================================================================
// 前端：diffWeekFields()
// =====================================================================

console.log('\n前端 diffWeekFields()（從 Script.html 抽出來執行）');

/** 讀 src 下的檔案；統一換成 LF，免得工作目錄是 CRLF 時，用換行切字串的測試失效。 */
function readSrc(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');
}

function loadDiffWeekFields() {
  const html = readSrc('src/ui/Script.html');
  const start = html.indexOf('function diffWeekFields(');
  assert.ok(start !== -1, 'Script.html 內找不到 diffWeekFields()');
  // 函式結尾：下一個與它同縮排（兩格）的「  }」。
  const end = html.indexOf('\n  }\n', start);
  const source = html.slice(start, end + 4);
  const sandbox = {};
  vm.runInNewContext(source + '\nthis.fn = diffWeekFields;', sandbox);
  return sandbox.fn;
}

test('F1-14 diffWeekFields：沒有改動的欄位一律不送', function () {
  const diff = loadDiffWeekFields();
  const out = diff({ A: 'x', B: 'y' }, { A: 'x', B: 'y' }, []);
  assert.deepStrictEqual(Object.keys(out.week), []);
  assert.deepStrictEqual(Object.keys(out.baseWeek), []);
});

test('F1-15 diffWeekFields：改過的欄位進 week，載入時的值進 baseWeek，兩者鍵相同', function () {
  const diff = loadDiffWeekFields();
  const out = diff({ A: 'new', B: 'same', C: '' }, { A: 'old', B: 'same', C: 'was' }, []);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(out.week)), { A: 'new', C: '' });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(out.baseWeek)), { A: 'old', C: 'was' });
});

test('F1-16 diffWeekFields：內容表接管的欄位不送；載入時沒有的鍵當空白', function () {
  const diff = loadDiffWeekFields();
  const out = diff({ CALL_TEXT: 'x', NEW_KEY: 'v', E: '' }, {}, ['CALL_TEXT']);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(out.week)), { NEW_KEY: 'v' });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(out.baseWeek)), { NEW_KEY: '' });
});

test('F1-17 前端：載入完成時記下 loadedWeek，儲存時經 diffWeekFields 送 baseWeek（不再送整張表單）', function () {
  const html = readSrc('src/ui/Script.html');
  assert.ok(/state\.loadedWeek\s*=\s*collectWeekFieldsFromForm\(\)/.test(html), '載入後要記下基準值');
  const payloadFn = html.slice(html.indexOf('function buildSavePayload('), html.indexOf('function setSaveButtonText('));
  assert.ok(payloadFn.indexOf('diffWeekFields(') !== -1);
  assert.ok(payloadFn.indexOf('baseWeek') !== -1);
  assert.strictEqual(payloadFn.indexOf('week: collectWeekFieldsFromForm'), -1, '不可以再整張表單送出');
});

// =====================================================================
// F2：沒有改動的儲存不更新 LAST_SAVED_AT
// =====================================================================

console.log('\nF2：沒有改動不更新 LAST_SAVED_AT');

test('F2-1 完全沒有改動的儲存：不寫 LAST_SAVED_AT，回傳原本的 token，訊息照舊', function () {
  const env = makeSyncedEnv();
  env.sandbox.saveWeekFromWebApp_({
    isoDate: D, lastSavedAt: '', baseWeek: { FLOWER_THIS_WEEK: '' }, week: { FLOWER_THIS_WEEK: '玫瑰' }
  });
  const token = env.sandbox.canonicalSaveToken_(weekRow(env, D).LAST_SAVED_AT);
  assert.ok(token, '前提：第一次真的儲存過，有 token');
  const auditBefore = env.sandbox.readSheet('AuditLog').length;

  const result = env.sandbox.apiSaveWeek({ isoDate: D, lastSavedAt: token, baseWeek: {}, week: {} });
  assert.strictEqual(result.ok, true, JSON.stringify(result));
  assert.strictEqual(result.data.lastSavedAt, token, '回傳原本的 token');
  assert.strictEqual(result.data.changedFieldCount, 0);
  assert.strictEqual(result.data.message.text, '沒有偵測到任何改動，工作表沒有變更。');
  assert.strictEqual(env.sandbox.canonicalSaveToken_(weekRow(env, D).LAST_SAVED_AT), token, 'LAST_SAVED_AT 沒有變');
  assert.strictEqual(env.sandbox.readSheet('AuditLog').length, auditBefore);
});

test('F2-2 H15／H17：無改動儲存之後，另一個用同一 token 的 payload 可以正常儲存', function () {
  const env = makeSyncedEnv();
  env.sandbox.saveWeekFromWebApp_({
    isoDate: D, lastSavedAt: '', baseWeek: { FLOWER_THIS_WEEK: '' }, week: { FLOWER_THIS_WEEK: '玫瑰' }
  });
  const token = env.sandbox.canonicalSaveToken_(weekRow(env, D).LAST_SAVED_AT);

  // 分頁甲：沒有改動就按儲存。
  env.sandbox.saveWeekFromWebApp_({ isoDate: D, lastSavedAt: token, baseWeek: {}, week: {} });

  // 分頁乙：持同一個 token，改一格。以前會被誤判 STALE。
  const result = env.sandbox.saveWeekFromWebApp_({
    isoDate: D, lastSavedAt: token, baseWeek: { HYMN_PRAISE: '' }, week: { HYMN_PRAISE: '詩歌' }
  });
  assert.strictEqual(result.changedFieldCount, 1);
  assert.strictEqual(weekRow(env, D).HYMN_PRAISE, '詩歌');
});

test('F2-3 從未儲存過的一週，無改動儲存之後 token 仍然是空，下一次儲存不會誤判 STALE', function () {
  const env = makeSyncedEnv();
  const first = env.sandbox.saveWeekFromWebApp_({ isoDate: D, lastSavedAt: null, baseWeek: {}, week: {} });
  assert.strictEqual(first.lastSavedAt, '');
  assert.strictEqual(first.changedFieldCount, 0);
  const second = env.sandbox.saveWeekFromWebApp_({
    isoDate: D, lastSavedAt: first.lastSavedAt, baseWeek: { FLOWER_THIS_WEEK: '' }, week: { FLOWER_THIS_WEEK: '玫瑰' }
  });
  assert.strictEqual(second.changedFieldCount, 1);
});

test('F2-4 只有事奉覆寫有改動，也算有改動：照舊更新 LAST_SAVED_AT', function () {
  const env = makeSyncedEnv();
  const result = env.sandbox.saveWeekFromWebApp_({
    isoDate: D, lastSavedAt: '', baseWeek: {}, week: {}, payloadVersion: 2,
    dutyEdits: [{ postId: 'CHAIR', slotIndex: 1, name: '李小明' }]
  });
  assert.ok(result.changedFieldCount >= 1);
  assert.ok(result.lastSavedAt, '有改動就要有新 token');
  assert.strictEqual(env.sandbox.readSheet('DutyOverride').length, 1);
});

// =====================================================================
// F8：預期中的使用者情況不寫 ErrorLog
// =====================================================================

console.log('\nF8：STALE／FIELD_CONFLICT／CLIENT_OUTDATED 不寫 ErrorLog');

test('F8-1 清單是一個常數，正是這三個錯誤碼', function () {
  const env = makeSyncedEnv();
  assert.deepStrictEqual(Array.from(env.sandbox.EXPECTED_USER_ERROR_CODES_).sort(),
    ['CLIENT_OUTDATED', 'FIELD_CONFLICT', 'STALE']);
});

test('F8-2 經 apiSaveWeek()：STALE 回傳錯誤給介面，但不寫 ErrorLog', function () {
  const env = makeSyncedEnv();
  env.sandbox.saveWeekFromWebApp_({
    isoDate: D, lastSavedAt: '', baseWeek: { FLOWER_THIS_WEEK: '' }, week: { FLOWER_THIS_WEEK: '玫瑰' }
  });
  const errorsBefore = env.sandbox.readSheet('ErrorLog').length;
  const resp = env.sandbox.apiSaveWeek({
    isoDate: D, lastSavedAt: '', baseWeek: { FLOWER_THIS_WEEK: '' }, week: { FLOWER_THIS_WEEK: '另一個分頁' }
  });
  assert.strictEqual(resp.ok, false);
  assert.strictEqual(resp.error.code, 'STALE');
  assert.ok(resp.error.message.length > 0);
  assert.strictEqual(env.sandbox.readSheet('ErrorLog').length, errorsBefore, 'STALE 不是故障，不寫 ErrorLog');
});

test('F8-3 經 apiSaveWeek()：FIELD_CONFLICT 與 CLIENT_OUTDATED 同樣不寫 ErrorLog', function () {
  const env = makeSyncedEnv();
  gridEdit(env, D, 'PRELUDE', '格子表');
  const errorsBefore = env.sandbox.readSheet('ErrorLog').length;

  const conflict = env.sandbox.apiSaveWeek({
    isoDate: D, lastSavedAt: '', baseWeek: { PRELUDE: '' }, week: { PRELUDE: '分頁' }
  });
  assert.strictEqual(conflict.error.code, 'FIELD_CONFLICT');

  const outdated = env.sandbox.apiSaveWeek({ isoDate: D, lastSavedAt: '', week: { PRELUDE: '分頁' } });
  assert.strictEqual(outdated.error.code, 'CLIENT_OUTDATED');

  assert.strictEqual(env.sandbox.readSheet('ErrorLog').length, errorsBefore);
});

test('F8-4 其他錯誤照寫 ErrorLog', function () {
  const env = makeSyncedEnv();
  const errorsBefore = env.sandbox.readSheet('ErrorLog').length;
  const resp = env.sandbox.apiSaveWeek({ isoDate: '', week: {} });
  assert.strictEqual(resp.ok, false);
  const rows = env.sandbox.readSheet('ErrorLog');
  assert.strictEqual(rows.length, errorsBefore + 1, '真正的錯誤要記下來');
  assert.strictEqual(rows[rows.length - 1].FUNCTION_NAME, 'apiSaveWeek');
});

test('F8-5 withApiResult_ 直接測：自訂錯誤碼 BOOM 要寫，STALE 不寫', function () {
  const env = makeSyncedEnv();
  const before = env.sandbox.readSheet('ErrorLog').length;
  env.sandbox.withApiResult_(function () { const e = new Error('x'); e.code = 'STALE'; throw e; }, { functionName: 't' });
  assert.strictEqual(env.sandbox.readSheet('ErrorLog').length, before);
  env.sandbox.withApiResult_(function () { const e = new Error('x'); e.code = 'BOOM'; throw e; }, { functionName: 't' });
  assert.strictEqual(env.sandbox.readSheet('ErrorLog').length, before + 1);
});

// =====================================================================
// 標籤表
// =====================================================================

console.log('\n欄位標籤');

test('FIELD_CONFLICT 用的中文名稱涵蓋每一個可編輯欄位，而且是介面上的字眼', function () {
  const env = makeSyncedEnv();
  const labels = env.sandbox.webAppWeekFieldLabels_();
  env.sandbox.webAppEditableWeekFieldKeys_().forEach(function (key) {
    assert.ok(labels[key], key + ' 沒有中文名稱');
    assert.ok(!/^[A-Z_]+$/.test(labels[key]), key + ' 的名稱不可以是機器鍵：' + labels[key]);
  });
  const index = readSrc('src/ui/Index.html');
  ['PRELUDE', 'FLOWER_THIS_WEEK', 'SERMON_TITLE', 'SCRIPTURE_REF', 'CHOIR_TITLE'].forEach(function (key) {
    const re = new RegExp('<label[^>]*>\\s*([^\\n<]+)\\n\\s*<(?:input|select|textarea)[^>]*data-field="' + key + '"');
    const m = re.exec(index);
    assert.ok(m, 'Index.html 找不到 ' + key + ' 的標籤');
    assert.strictEqual(m[1].trim(), labels[key], key + ' 的名稱要與介面標籤一致');
  });
});

console.log('\n通過 ' + pass + ' 項，失敗 ' + fail + ' 項。');
process.exit(fail === 0 ? 0 : 1);
