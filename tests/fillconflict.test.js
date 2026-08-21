#!/usr/bin/env node
/**
 * tests/fillconflict.test.js
 *
 * prompt8b 第 2 部分的回歸測試：`resolveFillConflicts_()` 無論結果如何都要
 * 寫一筆 `FILL_CONFLICT_RESOLVE_RUN` 總結記錄，而且要能分辨「使用者真的
 * 全部選了暫不處理」與「前後端鍵值對不上（unmatched）」——後者是這一輪
 * 要修的實測事故：撳了確定但一格都沒有變、也完全沒有留下任何記錄。
 *
 * 執行方式：node tests/fillconflict.test.js
 * 離開碼：0＝全部通過　1＝有測試失敗
 */

'use strict';

const assert = require('assert');
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
    console.log('    ' + err.message);
  }
}

/** 建立格子表（會先做一次快照寫入），回傳環境。 */
function makeSyncedEnv(options) {
  const env = makeFillEnv(Object.assign({ withGrid: false }, options || {}));
  env.sandbox.createOrRefreshFillGrid_(QUARTER_ID);
  return env;
}

/** 直接改格子表某一格（模擬幹事打字）。 */
function setGridCell(env, isoDate, fieldKey, value) {
  const sheet = env.sheets['Fill_' + QUARTER_ID];
  const rows = env.sandbox.readFillGridRows_(QUARTER_ID);
  const row = rows.filter(function (r) { return r.isoDate === isoDate; })[0];
  sheet.getRange(row.rowNo, env.sandbox.fillGridColumnIndex_(fieldKey)).setValue(value);
}

/** 直接改 BulletinWeeks 某一格（模擬 Web App 儲存，但不更新快照）。 */
function setSystemCell(env, isoDate, fieldKey, value) {
  env.sandbox.writeBulletinWeekField_(isoDate, fieldKey, value);
}

/** 造一個「兩邊都改過」的衝突格，回傳同步後的環境。 */
function makeConflictEnv(isoDate, fieldKey, gridValue, systemValue) {
  const env = makeSyncedEnv();
  setGridCell(env, isoDate, fieldKey, gridValue);
  setSystemCell(env, isoDate, fieldKey, systemValue);
  env.sandbox.syncFillGrid_(QUARTER_ID);
  return env;
}

function findRunRecord(env) {
  return env.sandbox.readSheet('AuditLog').filter(function (r) {
    return r.ACTION === 'FILL_CONFLICT_RESOLVE_RUN';
  });
}

// =====================================================================
// 1. 全部 SKIP：一格都沒有改動，但仍然要留下總結記錄
// =====================================================================

test('1. 全部 SKIP → appliedGrid／appliedSystem 為 0，但仍然寫一筆 FILL_CONFLICT_RESOLVE_RUN，skipped 正確', function () {
  const env = makeConflictEnv('2027-11-07', 'SERMON_TITLE', '格子表的講題', '系統的講題');

  const result = env.sandbox.resolveFillConflicts_(QUARTER_ID, [
    { isoDate: '2027-11-07', fieldKey: 'SERMON_TITLE', choice: 'SKIP' }
  ]);

  assert.strictEqual(result.appliedGrid, 0);
  assert.strictEqual(result.appliedSystem, 0);
  assert.strictEqual(result.skipped, 1);

  const runRecords = findRunRecord(env);
  assert.strictEqual(runRecords.length, 1, '就算全部 SKIP，也一定要留下一筆總結記錄');
  const notes = JSON.parse(runRecords[0].NOTES);
  assert.strictEqual(notes.skipped, 1);
  assert.strictEqual(notes.appliedGrid, 0);
  assert.strictEqual(notes.appliedSystem, 0);
  assert.strictEqual(notes.unmatched, 0);
  assert.strictEqual(notes.decisionsReceived, 1);
  assert.strictEqual(notes.matchedConflicts, 1);
});

// =====================================================================
// 2. decisions 是空陣列
// =====================================================================

test('2. decisions 是空陣列 → 仍然寫總結記錄，decisionsReceived 為 0', function () {
  const env = makeConflictEnv('2027-11-07', 'SERMON_TITLE', '格子表的講題', '系統的講題');

  const result = env.sandbox.resolveFillConflicts_(QUARTER_ID, []);

  assert.strictEqual(result.decisionsReceived, 0);
  assert.strictEqual(result.appliedGrid, 0);
  assert.strictEqual(result.appliedSystem, 0);
  assert.strictEqual(result.skipped, 0);
  assert.strictEqual(result.unmatched, 0);

  const runRecords = findRunRecord(env);
  assert.strictEqual(runRecords.length, 1, 'decisions 是空陣列也要留下一筆總結記錄');
  const notes = JSON.parse(runRecords[0].NOTES);
  assert.strictEqual(notes.decisionsReceived, 0);
});

// =====================================================================
// 3. decisions 對不上任何目前的衝突
// =====================================================================

test('3. decisions 之中有一部分對不上目前的衝突 → unmatched 計數正確，不拋錯（因為還有其他配對成功）', function () {
  const env = makeSyncedEnv();
  setGridCell(env, '2027-11-07', 'SERMON_TITLE', '格子表講題');
  setSystemCell(env, '2027-11-07', 'SERMON_TITLE', '系統講題');
  env.sandbox.syncFillGrid_(QUARTER_ID);

  let result;
  assert.doesNotThrow(function () {
    result = env.sandbox.resolveFillConflicts_(QUARTER_ID, [
      { isoDate: '2027-11-07', fieldKey: 'SERMON_TITLE', choice: 'GRID' },
      { isoDate: '2027-12-25', fieldKey: 'SERMON_TITLE', choice: 'GRID' },
      { isoDate: '2027-11-07', fieldKey: 'NOT_A_REAL_FIELD', choice: 'SYSTEM' }
    ]);
  });

  assert.strictEqual(result.unmatched, 2);
  assert.strictEqual(result.appliedGrid, 1);
  assert.strictEqual(result.matchedConflicts, 1);
  assert.strictEqual(result.decisionsReceived, 3);

  const runRecords = findRunRecord(env);
  assert.strictEqual(runRecords.length, 1);
  assert.strictEqual(JSON.parse(runRecords[0].NOTES).unmatched, 2);
});

test('3b. decisions 全部對不上目前的衝突（例如季度 ID 傳壞了）→ 拋 NO_MATCHING_CONFLICT，而且沒有任何寫入', function () {
  const env = makeConflictEnv('2027-11-07', 'SERMON_TITLE', '格子表的講題', '系統的講題');
  const beforeWeeks = JSON.stringify(env.sandbox.readSheet('BulletinWeeks'));
  const beforeAuditCount = env.sandbox.readSheet('AuditLog').length;

  assert.throws(function () {
    env.sandbox.resolveFillConflicts_(QUARTER_ID, [
      { isoDate: '2027-12-25', fieldKey: 'SERMON_TITLE', choice: 'GRID' }
    ]);
  }, function (err) {
    assert.strictEqual(err.code, 'NO_MATCHING_CONFLICT');
    assert.ok(err.message.indexOf(QUARTER_ID) !== -1, '訊息要講明是哪一個季度');
    return true;
  });

  assert.strictEqual(JSON.stringify(env.sandbox.readSheet('BulletinWeeks')), beforeWeeks,
    'BulletinWeeks 不可以有任何改動');
  assert.strictEqual(env.sandbox.readSheet('AuditLog').length, beforeAuditCount,
    '連 FILL_CONFLICT_RESOLVE_RUN 總結記錄都不可以寫——這不是使用者的選擇，是系統性的鍵值不符');
});

// =====================================================================
// 4-5. 選 GRID／SYSTEM
// =====================================================================

test('4. 選 GRID → BulletinWeeks 被寫入、快照更新、逐格 AuditLog', function () {
  const env = makeConflictEnv('2027-11-07', 'SERMON_TITLE', '格子表的講題', '系統的講題');

  const result = env.sandbox.resolveFillConflicts_(QUARTER_ID, [
    { isoDate: '2027-11-07', fieldKey: 'SERMON_TITLE', choice: 'GRID' }
  ]);
  assert.strictEqual(result.appliedGrid, 1);

  const week = env.sandbox.readSheet('BulletinWeeks').filter(function (r) {
    return env.sandbox.fillGridCellText_(r.SERVICE_DATE) === '2027-11-07';
  })[0];
  assert.strictEqual(week.SERMON_TITLE, '格子表的講題');

  assert.ok(env.sandbox.readSheet('AuditLog').some(function (r) {
    return r.ACTION === 'FILL_CONFLICT_RESOLVE' && r.NEW_VALUE === '格子表的講題';
  }), '要有逐格的 FILL_CONFLICT_RESOLVE 記錄');

  // 快照已更新 → 再同步一次應該沒有衝突了。
  const plan = env.sandbox.computeFillSyncPlan_(QUARTER_ID);
  assert.strictEqual(plan.conflictCount, 0, '快照更新之後不應該再報成衝突');
});

test('5. 選 SYSTEM → 格子表被寫入、快照更新', function () {
  const env = makeConflictEnv('2027-11-07', 'SERMON_TITLE', '格子表的講題', '系統的講題');

  const result = env.sandbox.resolveFillConflicts_(QUARTER_ID, [
    { isoDate: '2027-11-07', fieldKey: 'SERMON_TITLE', choice: 'SYSTEM' }
  ]);
  assert.strictEqual(result.appliedSystem, 1);

  const gridRow = env.sandbox.readFillGridRows_(QUARTER_ID)
    .filter(function (r) { return r.isoDate === '2027-11-07'; })[0];
  assert.strictEqual(gridRow.values.SERMON_TITLE, '系統的講題');

  const plan = env.sandbox.computeFillSyncPlan_(QUARTER_ID);
  assert.strictEqual(plan.conflictCount, 0, '快照更新之後不應該再報成衝突');
});

// =====================================================================
// 6. 混合選擇
// =====================================================================

test('6. 混合選擇（一格 GRID、一格 SYSTEM、一格 SKIP）→ 三個計數都正確', function () {
  const env = makeSyncedEnv();
  setGridCell(env, '2027-11-07', 'SERMON_TITLE', '格子表講題');
  setSystemCell(env, '2027-11-07', 'SERMON_TITLE', '系統講題');
  setGridCell(env, '2027-11-14', 'PRELUDE', '格子表序樂');
  setSystemCell(env, '2027-11-14', 'PRELUDE', '系統序樂');
  setGridCell(env, '2027-11-21', 'SCRIPTURE_REF', '格子表經文');
  setSystemCell(env, '2027-11-21', 'SCRIPTURE_REF', '系統經文');
  env.sandbox.syncFillGrid_(QUARTER_ID);

  const result = env.sandbox.resolveFillConflicts_(QUARTER_ID, [
    { isoDate: '2027-11-07', fieldKey: 'SERMON_TITLE', choice: 'GRID' },
    { isoDate: '2027-11-14', fieldKey: 'PRELUDE', choice: 'SYSTEM' },
    { isoDate: '2027-11-21', fieldKey: 'SCRIPTURE_REF', choice: 'SKIP' }
  ]);

  assert.strictEqual(result.appliedGrid, 1);
  assert.strictEqual(result.appliedSystem, 1);
  assert.strictEqual(result.skipped, 1);
  assert.strictEqual(result.decisionsReceived, 3);
  assert.strictEqual(result.matchedConflicts, 3);
  assert.strictEqual(result.unmatched, 0);

  const runRecords = findRunRecord(env);
  assert.strictEqual(runRecords.length, 1);
  const notes = JSON.parse(runRecords[0].NOTES);
  assert.strictEqual(notes.appliedGrid, 1);
  assert.strictEqual(notes.appliedSystem, 1);
  assert.strictEqual(notes.skipped, 1);

  // 沒被處理的那一格（SCRIPTURE_REF）下次同步仍然要報成衝突。
  const plan = env.sandbox.computeFillSyncPlan_(QUARTER_ID);
  assert.strictEqual(plan.conflictCount, 1, '只有 SKIP 的那一格還應該是衝突');
});

// =====================================================================
// buildFillConflictResultMessage_：訊息文案一律由伺服器算好（事故十五）
// =====================================================================

test('buildFillConflictResultMessage_：有實際套用時，講明三個實際數字', function () {
  const env = makeSyncedEnv();
  const message = env.sandbox.buildFillConflictResultMessage_({ appliedGrid: 2, appliedSystem: 1, skipped: 1 });
  assert.strictEqual(message, '已套用：填寫表 2 格、系統 1 格；暫不處理 1 格（下次同步仍然會問）。');
});

test('buildFillConflictResultMessage_：只有 skipped 大於 0 且 appliedGrid／appliedSystem 都是 0 才可以說「全部選了暫不處理」', function () {
  const env = makeSyncedEnv();
  assert.strictEqual(
    env.sandbox.buildFillConflictResultMessage_({ appliedGrid: 0, appliedSystem: 0, skipped: 3 }),
    '你全部選了「暫不處理」，所以一格都沒有改動。'
  );
});

test('buildFillConflictResultMessage_：appliedGrid／appliedSystem／skipped 全部是 0 時，不可以誤判成「全部暫不處理」', function () {
  // ⚠️ 這正是事故十五的陷阱：舊寫法只看 appliedGrid===0 && appliedSystem===0，
  // 在 unmatched 為主、skipped 也是 0 的情況下會錯誤顯示「你全部選了暫不
  // 處理」，實際上使用者根本沒有選過暫不處理。
  const env = makeSyncedEnv();
  const message = env.sandbox.buildFillConflictResultMessage_({ appliedGrid: 0, appliedSystem: 0, skipped: 0 });
  assert.strictEqual(message, '已套用：填寫表 0 格、系統 0 格；暫不處理 0 格（下次同步仍然會問）。');
});

test('resolveFillConflicts_ 的回傳值含 message 欄位，內容與 buildFillConflictResultMessage_ 一致', function () {
  const env = makeConflictEnv('2027-11-07', 'SERMON_TITLE', '格子表的講題', '系統的講題');
  const result = env.sandbox.resolveFillConflicts_(QUARTER_ID, [
    { isoDate: '2027-11-07', fieldKey: 'SERMON_TITLE', choice: 'SKIP' }
  ]);
  assert.strictEqual(result.message, '你全部選了「暫不處理」，所以一格都沒有改動。');
});

// =====================================================================

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
