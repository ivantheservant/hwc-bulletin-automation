#!/usr/bin/env node
/**
 * tests/autosyncretry.test.js
 *
 * R-056（2026-11-17）：內容表自動同步的暫時性失敗要再試，不可以當作已處理。
 *
 *   背景（正式試算表 ErrorLog）：11/12 `contentAutoSyncTrigger_`「Service Spreadsheets failed while accessing
 *   document…」，之前的版本一失敗就記下修改時間，令這一季要等內容表再改（或七日後）才再試，而且沒有人收到通知。
 *
 *   規則：
 *     - 同一個修改時間指紋連續失敗未滿 3 次，不記修改時間，下一次觸發照樣再試；
 *     - ErrorLog 只在第 1 次與第 3 次記；第 3 次才記下「不再試」，訊息講明；
 *     - 成功、NO_CHANGE、UNCHANGED 都清走失敗次數；
 *     - 結構性失敗（preview.ok === false）行為不變，記錄有效期改為 30 日；
 *     - 沒有「今日及之後」主日的季度不呼叫 Drive（NO_DATES）。
 *
 *   ⚠️ 全部由真正入口 `contentAutoSyncTrigger_()` 叫下去（bug class 5）。
 *
 * 執行方式：node tests/autosyncretry.test.js
 * 離開碼：0＝全部通過　1＝有測試失敗
 */

'use strict';

const assert = require('assert');
const contentEnv = require('./helpers/contentEnv');

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
    console.log('    ' + (err && err.stack ? err.stack.split('\n').slice(0, 6).join('\n    ') : err));
  }
}

function plain(v) { return JSON.parse(JSON.stringify(v)); }

function makeProps() {
  const store = {};
  return {
    store: store,
    service: {
      getScriptProperties: function () {
        return {
          getProperty: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
          setProperty: function (k, v) { store[k] = String(v); },
          deleteProperty: function (k) { delete store[k]; }
        };
      }
    }
  };
}

/**
 * 造環境：模擬今日 2027-10-15，內容表有一個今日之後的主日（10-17）。
 * `failures`：頭幾次讀內容表分頁時丟 Google 的暫時性錯誤，之後才成功。
 */
function makeSyncEnv(options) {
  const o = options || {};
  const env = contentEnv.makeEnv(Object.assign({
    config: Object.assign({ WEBAPP_SIMULATED_TODAY: o.today || '2027-10-15' }, o.config || {}),
    content: {
      家事報告: [{ SERVICE_DATE: '2027-10-17', SEQ_NO: '10', TEXT: '下一個主日的報告', ACTIVE: 'TRUE' }]
    }
  }, o.env || {}));
  const sb = env.sandbox;
  const props = makeProps();
  sb.PropertiesService = props.service;

  let mtime = o.mtime === undefined ? 1000 : o.mtime;
  env.mtimeReads = 0;
  sb.readContentSheetLastUpdatedMillis_ = function () { env.mtimeReads++; return mtime; };
  env.setMtime = function (v) { mtime = v; };

  // 暫時性失敗：頭 N 次讀內容表分頁丟錯，之後照常讀。
  const originalRead = sb.readContentSheetTabs_;
  env.tabReads = 0;
  let failuresLeft = o.failures === undefined ? 0 : o.failures;
  env.setFailures = function (n) { failuresLeft = n; };
  sb.readContentSheetTabs_ = function (spreadsheet) {
    env.tabReads++;
    if (failuresLeft > 0) {
      failuresLeft--;
      throw new Error('Service Spreadsheets timed out while accessing document with id FAKE');
    }
    return originalRead(spreadsheet);
  };
  env.props = props;
  return env;
}

function syncErrors(env) {
  return env.sandbox.readSheet_('ErrorLog').filter(function (r) { return r.FUNCTION_NAME === 'runContentAutoSync_'; });
}

function importedTexts(env) {
  return plain(env.sandbox.readSheet_('Announcements').filter(function (r) { return r.ACTIVE === true; })
    .map(function (r) { return String(r.TEXT); }));
}

function lastStatus(env) {
  return plain(env.sandbox.runContentAutoSync_({ source: 'TEST' })).quarters.map(function (q) { return q.status; });
}

// =====================================================================
console.log('\nR-056：暫時性失敗要再試');
// =====================================================================

test('第一、二次丟「Service Spreadsheets timed out」、第三次成功 → 第三次有匯入；ErrorLog 只有第 1 次那一筆', function () {
  const env = makeSyncEnv({ failures: 2 });

  env.sandbox.contentAutoSyncTrigger_();
  assert.deepStrictEqual(importedTexts(env), [], '第一次失敗，沒有匯入');
  assert.strictEqual(syncErrors(env).length, 1, '第 1 次要記');
  assert.ok(syncErrors(env)[0].MESSAGE.indexOf('第 1 次，下一次觸發會再試') !== -1, syncErrors(env)[0].MESSAGE);
  assert.strictEqual(syncErrors(env)[0].SOURCE, 'TRIGGER');

  env.sandbox.contentAutoSyncTrigger_();
  assert.deepStrictEqual(importedTexts(env), [], '第二次仍然失敗');
  assert.strictEqual(syncErrors(env).length, 1, '第 2 次不記 ErrorLog');

  env.sandbox.contentAutoSyncTrigger_();
  assert.deepStrictEqual(importedTexts(env), ['下一個主日的報告'], '⚠️ 第三次成功，一定要有匯入（以前第一次失敗之後就不再試）');
  assert.strictEqual(syncErrors(env).length, 1, '成功不再記 ErrorLog');
  assert.strictEqual(env.sandbox.readSheet_('AuditLog').filter(function (r) { return r.ACTION === 'CONTENT_AUTO_SYNC'; }).length, 1);
  assert.strictEqual(env.props.store['CONTENT_SYNC_FAIL_' + contentEnv.QUARTER_ID], undefined, '成功之後清走失敗次數');
});

test('連續三次失敗 → ErrorLog 第 1、3 次各一筆，第 3 次講明不再試；第四次不再打開內容表', function () {
  const env = makeSyncEnv({ failures: 99 });

  env.sandbox.contentAutoSyncTrigger_();
  env.sandbox.contentAutoSyncTrigger_();
  assert.strictEqual(syncErrors(env).length, 1);
  env.sandbox.contentAutoSyncTrigger_();
  const errors = syncErrors(env);
  assert.strictEqual(errors.length, 2, '第 1 次與第 3 次各一筆，實際：' + JSON.stringify(errors.map(function (e) { return e.MESSAGE; })));
  assert.ok(errors[1].MESSAGE.indexOf('已連續失敗 3 次，內容表再有改動之前不會再試') !== -1, errors[1].MESSAGE);

  const readsBefore = env.tabReads;
  env.sandbox.contentAutoSyncTrigger_();
  env.sandbox.contentAutoSyncTrigger_();
  assert.strictEqual(env.tabReads, readsBefore, '⚠️ 第四次起不可以再打開內容表');
  assert.strictEqual(syncErrors(env).length, 2, '放棄之後不再洗 ErrorLog');
  assert.deepStrictEqual(lastStatus(env), ['UNCHANGED']);
});

test('放棄之後內容表再有改動 → 照樣再試，失敗次數由 1 重新計', function () {
  const env = makeSyncEnv({ failures: 99 });
  for (let i = 0; i < 3; i++) env.sandbox.contentAutoSyncTrigger_();
  assert.strictEqual(syncErrors(env).length, 2);

  env.setMtime(2000);
  env.setFailures(0);
  env.sandbox.contentAutoSyncTrigger_();
  assert.deepStrictEqual(importedTexts(env), ['下一個主日的報告'], '內容表有改動，要再試而且成功');
});

test('修改時間指紋不同的失敗不算「連續」：內容表中途改過，失敗次數重新計', function () {
  const env = makeSyncEnv({ failures: 99 });
  env.sandbox.contentAutoSyncTrigger_();
  env.sandbox.contentAutoSyncTrigger_();
  env.setMtime(2000);                                   // 內容表改了
  env.sandbox.contentAutoSyncTrigger_();                // 新指紋的第 1 次
  assert.strictEqual(syncErrors(env).length, 2, '新指紋的第 1 次要記 ErrorLog');
  assert.ok(syncErrors(env)[1].MESSAGE.indexOf('第 1 次') !== -1, syncErrors(env)[1].MESSAGE);
  env.setFailures(0);
  env.sandbox.contentAutoSyncTrigger_();                // 仍然可以再試
  assert.deepStrictEqual(importedTexts(env), ['下一個主日的報告']);
});

test('NO_CHANGE 與 UNCHANGED 都清走失敗次數', function () {
  const env = makeSyncEnv({ failures: 1 });
  env.sandbox.contentAutoSyncTrigger_();                // 失敗 1 次
  assert.ok(env.props.store['CONTENT_SYNC_FAIL_' + contentEnv.QUARTER_ID], '前提：有失敗次數');
  env.sandbox.contentAutoSyncTrigger_();                // 成功（IMPORTED）
  assert.strictEqual(env.props.store['CONTENT_SYNC_FAIL_' + contentEnv.QUARTER_ID], undefined);

  // NO_CHANGE：改了修改時間但內容一樣；先造一次失敗再成功。
  env.setMtime(3000);
  env.setFailures(1);
  env.sandbox.contentAutoSyncTrigger_();
  assert.ok(env.props.store['CONTENT_SYNC_FAIL_' + contentEnv.QUARTER_ID]);
  assert.deepStrictEqual(lastStatus(env), ['NO_CHANGE']);
  assert.strictEqual(env.props.store['CONTENT_SYNC_FAIL_' + contentEnv.QUARTER_ID], undefined);

  // UNCHANGED：寫入失敗次數記錄之後，修改時間記錄與指紋相同的下一次會清走。
  env.props.store['CONTENT_SYNC_FAIL_' + contentEnv.QUARTER_ID] = JSON.stringify({ at: Date.now(), value: JSON.stringify({ m: '3000|', n: 2 }) });
  assert.deepStrictEqual(lastStatus(env), ['UNCHANGED']);
  assert.strictEqual(env.props.store['CONTENT_SYNC_FAIL_' + contentEnv.QUARTER_ID], undefined);
});

test('拿不到鎖（LOCK_TIMEOUT）不算失敗：不記次數、不寫 ErrorLog', function () {
  const env = makeSyncEnv({ env: { lockFails: true } });
  for (let i = 0; i < 4; i++) env.sandbox.contentAutoSyncTrigger_();
  assert.strictEqual(syncErrors(env).length, 0);
  assert.strictEqual(env.props.store['CONTENT_SYNC_FAIL_' + contentEnv.QUARTER_ID], undefined);
  assert.strictEqual(env.props.store['CONTENT_SYNC_MTIME_' + contentEnv.QUARTER_ID], undefined);
});

test('寫入失敗（applyContentImport_ 回 ok:false）同樣按次數再試，不是每 30 分鐘洗一次 ErrorLog', function () {
  const env = makeSyncEnv({});
  const sb = env.sandbox;
  sb.applyContentImport_ = function () { return { ok: false, reason: 'APPLY_FAILED', message: '寫入失敗（測試）' }; };
  for (let i = 0; i < 6; i++) sb.contentAutoSyncTrigger_();
  const errors = syncErrors(env);
  assert.strictEqual(errors.length, 2, '第 1 次與第 3 次各一筆，之後不再試：' + errors.length);
  assert.ok(errors[1].MESSAGE.indexOf('已連續失敗 3 次') !== -1);
});

test('讀不到修改時間（指紋是 null）：照樣每次再試，ErrorLog 仍然只記第 1、3 次', function () {
  const env = makeSyncEnv({ failures: 99, mtime: null });
  for (let i = 0; i < 5; i++) env.sandbox.contentAutoSyncTrigger_();
  assert.strictEqual(syncErrors(env).length, 2);
  assert.strictEqual(env.tabReads, 5, '沒有指紋可以記，所以每一次都再試');
});

// =====================================================================
console.log('\nR-056：結構性失敗的記錄改為 30 日');
// =====================================================================

test('preview.ok === false（內容表開不到）：ErrorLog 一筆；八日之後仍然不再試；31 日之後才再試', function () {
  const env = makeSyncEnv({ env: { contentFileMissing: true } });
  env.sandbox.contentAutoSyncTrigger_();
  env.sandbox.contentAutoSyncTrigger_();
  assert.strictEqual(syncErrors(env).length, 1);
  assert.ok(syncErrors(env)[0].MESSAGE.indexOf('內容表再有改動之前不會再試') !== -1);

  const key = 'CONTENT_SYNC_STRUCT_' + contentEnv.QUARTER_ID;
  const rec = JSON.parse(env.props.store[key]);
  const DAY = 24 * 3600 * 1000;

  rec.at = Date.now() - 8 * DAY;                       // 以前七日就過期，重複同一句錯誤
  env.props.store[key] = JSON.stringify(rec);
  env.sandbox.contentAutoSyncTrigger_();
  assert.strictEqual(syncErrors(env).length, 1, '⚠️ 八日之後不可以再重複同一句錯誤');

  rec.at = Date.now() - 31 * DAY;
  env.props.store[key] = JSON.stringify(rec);
  env.sandbox.contentAutoSyncTrigger_();
  assert.strictEqual(syncErrors(env).length, 2, '31 日之後記錄過期，再試一次');
});

test('結構性失敗之後內容表有改動 → 照樣再試', function () {
  const env = makeSyncEnv({ env: { contentFileMissing: true } });
  env.sandbox.contentAutoSyncTrigger_();
  env.setMtime(5000);
  env.sandbox.contentAutoSyncTrigger_();
  assert.strictEqual(syncErrors(env).length, 2);
});

// =====================================================================
console.log('\nR-056：沒有今日及之後主日的季度不呼叫 Drive');
// =====================================================================

test('NO_DATES：一個主日都在今日之前 → 不讀修改時間、不開內容表', function () {
  const env = makeSyncEnv({ today: '2027-12-31' });
  env.sandbox.contentAutoSyncTrigger_();
  assert.strictEqual(env.mtimeReads, 0, '⚠️ 已經過去的季度不可以每 30 分鐘打兩次 Drive');
  assert.strictEqual(env.tabReads, 0);
  assert.deepStrictEqual(lastStatus(env), ['NO_DATES']);
  assert.strictEqual(env.mtimeReads, 0);
});

test('有今日之後的主日 → 照常讀修改時間（本季與上一季）', function () {
  const env = makeSyncEnv({});
  env.sandbox.contentAutoSyncTrigger_();
  assert.ok(env.mtimeReads >= 1);
});

test('contentSyncFingerprint_：任何一個讀不到就是 null；上一季沒有內容表傳空字串', function () {
  const sb = makeSyncEnv({}).sandbox;
  assert.strictEqual(sb.contentSyncFingerprint_(1, 2), '1|2');
  assert.strictEqual(sb.contentSyncFingerprint_(1, ''), '1|');
  assert.strictEqual(sb.contentSyncFingerprint_(null, 2), null);
  assert.strictEqual(sb.contentSyncFingerprint_(1, null), null);
});

console.log('\n通過 ' + pass + ' 項，失敗 ' + fail + ' 項。');
process.exit(fail === 0 ? 0 : 1);
