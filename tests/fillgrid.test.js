#!/usr/bin/env node
/**
 * tests/fillgrid.test.js
 *
 * 第八輪「季度集中填寫表 ＋ 雙向同步」的回歸測試。
 *
 * 最核心的一組：**三方比對**（`compareFillCell_()`）。這個系統只要用
 * 兩方比較就會全盤錯掉，所以四種情況每種都有測試，而且「衝突時一格都
 * 不可以被寫入」單獨鎖住。
 *
 * 執行方式：node tests/fillgrid.test.js
 * 離開碼：0＝全部通過　1＝有測試失敗
 */

'use strict';

const assert = require('assert');
const { loadAllSrcFilesInOrder } = require('./helpers/loadGas');
const { makeFillEnv, QUARTER_ID, SERVICE_DATES, BASE_STUBS } = require('./helpers/fillEnv');

const pureSandbox = loadAllSrcFilesInOrder(Object.assign({}, BASE_STUBS, { SpreadsheetApp: {} }));
const {
  compareFillCell_, buildFillSyncPlan_, buildFillGridRows_, buildFillHeaderRowsAlias,
  fillGridColumnDefs_, fillGridEditableKeys_, fillGridReadOnlyKeys_, fillGridCellText_,
  fillGridSheetName_, quarterIdFromFillGridSheetName_, isFillGridSheetName_,
  buildFillSnapshotIndex_, fillSnapshotKey_, buildFillGridHeaderRows_,
  fillGridColumnIndex_, fillGridColumnDefAt_, buildFillProgressByGroup_, FILL_SYNC_STATUS,
  normalizeQuarterId_
} = pureSandbox;
void buildFillHeaderRowsAlias;

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

// =====================================================================
// 1. 三方比對四種情況各一例
// =====================================================================

test('1a. 三方比對 SAME：兩邊都跟快照一樣 → 不做任何事', function () {
  assert.strictEqual(compareFillCell_('甲', '甲', '甲'), FILL_SYNC_STATUS.SAME);
});

test('1b. 三方比對 PUSH：只有格子表改過 → 寫回 BulletinWeeks', function () {
  assert.strictEqual(compareFillCell_('新值', '舊值', '舊值'), FILL_SYNC_STATUS.PUSH);
});

test('1c. 三方比對 PULL：只有系統改過（例如經填寫介面）→ 刷新格子表', function () {
  assert.strictEqual(compareFillCell_('舊值', '新值', '舊值'), FILL_SYNC_STATUS.PULL);
});

test('1d. 三方比對 CONFLICT：兩邊都改過 → 衝突', function () {
  assert.strictEqual(compareFillCell_('格子表的新值', '系統的新值', '舊值'), FILL_SYNC_STATUS.CONFLICT);
});

test('1e. ⚠️ 兩方比較會出錯：格子表與系統不同**本身不代表衝突**', function () {
  // 這一個測試是整輪的核心約束：同樣是「兩邊現值不同」，靠快照才分得出
  // 到底是 PUSH、PULL 還是 CONFLICT。用兩方比較的話三者會被混為一談。
  assert.strictEqual(compareFillCell_('A', 'B', 'B'), FILL_SYNC_STATUS.PUSH, '快照＝B ⇒ 只有格子表改過');
  assert.strictEqual(compareFillCell_('A', 'B', 'A'), FILL_SYNC_STATUS.PULL, '快照＝A ⇒ 只有系統改過');
  assert.strictEqual(compareFillCell_('A', 'B', 'C'), FILL_SYNC_STATUS.CONFLICT, '快照＝C ⇒ 兩邊都改過');
});

test('1f. 空字串與 null／undefined 一律當成同一個「空」', function () {
  assert.strictEqual(compareFillCell_('', null, ''), FILL_SYNC_STATUS.SAME);
  assert.strictEqual(compareFillCell_(null, undefined, ''), FILL_SYNC_STATUS.SAME);
});

// =====================================================================
// 10. 快照缺失 → 視為「只有一邊改過」，不當衝突
// =====================================================================

test('10. 快照缺失（第一次同步）→ 不當衝突，以系統為準（PULL）', function () {
  assert.strictEqual(compareFillCell_('格子表', '系統', undefined), FILL_SYNC_STATUS.PULL);
  assert.strictEqual(compareFillCell_('格子表', '系統', null), FILL_SYNC_STATUS.PULL);
});

test('10b. 快照缺失但兩邊本來就一樣 → SAME', function () {
  assert.strictEqual(compareFillCell_('同一個值', '同一個值', undefined), FILL_SYNC_STATUS.SAME);
});

// =====================================================================
// buildFillSyncPlan_（純函式層的整表比對）
// =====================================================================

function gridRow(isoDate, values) {
  return { isoDate: isoDate, rowNo: 4, values: Object.assign({ _DATE: isoDate }, values || {}) };
}

test('buildFillSyncPlan_：只回報有差異的格，SAME 只計數不列出', function () {
  const plan = buildFillSyncPlan_({
    quarterId: QUARTER_ID,
    gridRows: [gridRow('2027-11-07', { SERMON_TITLE: '新講題', HYMN_PRAISE: '同一首' })],
    weekRowsByIso: { '2027-11-07': { SERMON_TITLE: '舊講題', HYMN_PRAISE: '同一首' } },
    snapshotIndex: {
      [fillSnapshotKey_('2027-11-07', 'SERMON_TITLE')]: '舊講題',
      [fillSnapshotKey_('2027-11-07', 'HYMN_PRAISE')]: '同一首'
    }
  });

  assert.strictEqual(plan.pushCount, 1);
  assert.strictEqual(plan.conflictCount, 0);
  assert.strictEqual(plan.cells.length, 1, 'SAME 的格不應該出現在 cells 內');
  assert.strictEqual(plan.cells[0].fieldKey, 'SERMON_TITLE');
});

test('buildFillSyncPlan_：三個唯讀欄不參與同步', function () {
  const plan = buildFillSyncPlan_({
    quarterId: QUARTER_ID,
    gridRows: [gridRow('2027-11-07', { _WEEK: '999', _SPECIAL: '亂改的' })],
    weekRowsByIso: { '2027-11-07': {} },
    snapshotIndex: {}
  });
  const readOnlyKeys = fillGridReadOnlyKeys_();
  plan.cells.forEach(function (c) {
    assert.strictEqual(readOnlyKeys.indexOf(c.fieldKey), -1, '唯讀欄 ' + c.fieldKey + ' 不應該進同步計畫');
  });
});

test('buildFillSyncPlan_：每一格都帶得出上次同步時的值（衝突對話框要顯示三個值）', function () {
  const plan = buildFillSyncPlan_({
    quarterId: QUARTER_ID,
    gridRows: [gridRow('2027-11-07', { SERMON_TITLE: 'A' })],
    weekRowsByIso: { '2027-11-07': { SERMON_TITLE: 'B' } },
    snapshotIndex: { [fillSnapshotKey_('2027-11-07', 'SERMON_TITLE')]: 'C' }
  });
  assert.strictEqual(plan.cells[0].status, FILL_SYNC_STATUS.CONFLICT);
  assert.strictEqual(plan.cells[0].snapshotValue, 'C');
  assert.strictEqual(plan.cells[0].gridValue, 'A');
  assert.strictEqual(plan.cells[0].systemValue, 'B');
});

// =====================================================================
// 欄位定義與版面
// =====================================================================

test('欄位定義：三個唯讀欄排在最前面', function () {
  const defs = fillGridColumnDefs_();
  assertArrayEqual(defs.slice(0, 3).map(function (d) { return d.key; }), ['_DATE', '_WEEK', '_SPECIAL']);
  defs.slice(0, 3).forEach(function (d) { assert.strictEqual(d.readOnly, true); });
});

test('欄位定義：可編輯欄全部是 BulletinWeeks 的機器鍵（不需要對照表）', function () {
  const weekKeys = pureSandbox.COLUMNS.BULLETIN_WEEKS.keys;
  fillGridEditableKeys_().forEach(function (key) {
    assert.ok(weekKeys.indexOf(key) !== -1, key + ' 不是 BulletinWeeks 的機器鍵');
  });
});

test('欄位定義：12 個人數欄與 ATTENDANCE_DATE 都是純文字欄', function () {
  const defs = fillGridColumnDefs_();
  const plainText = defs.filter(function (d) { return d.plainText; }).map(function (d) { return d.key; });
  assert.strictEqual(plainText.filter(function (k) { return /^ATT_/.test(k); }).length, 12);
  assert.ok(plainText.indexOf('ATTENDANCE_DATE') !== -1,
    'ATTENDANCE_DATE 一定要純文字，否則 2027-11-07 會被 Sheets 轉成 Date');
});

test('欄位定義：五個群組齊備，次序正確', function () {
  const groups = [];
  fillGridColumnDefs_().forEach(function (d) {
    if (groups.indexOf(d.group) === -1) groups.push(d.group);
  });
  assertArrayEqual(groups, ['基本', '崇拜程序', '上週人數', '事奉與獻花', '其他']);
});

// =====================================================================
// normalizeQuarterId_：伺服器端第二道防線（事故十五）
// =====================================================================

test('normalizeQuarterId_：乾淨的季度 ID 原樣通過', function () {
  assert.strictEqual(normalizeQuarterId_('2027T4'), '2027T4');
});

test('normalizeQuarterId_：剝掉包住整個字串的雙引號／單引號／頭尾空白', function () {
  assert.strictEqual(normalizeQuarterId_('"2027T4"'), '2027T4');
  assert.strictEqual(normalizeQuarterId_("'2027T4'"), '2027T4');
  assert.strictEqual(normalizeQuarterId_('  2027T4  '), '2027T4');
});

test('normalizeQuarterId_：格式不合（例如工作表名稱、空字串、亂打）一律拋錯', function () {
  ['Fill_2027T4', '', 'abc', '2027-T4', '27T4'].forEach(function (bad) {
    assert.throws(function () { normalizeQuarterId_(bad); }, /季度 ID 格式不正確/,
      '「' + bad + '」應該要拋錯');
  });
});

test('buildFillGridHeaderRows_：三行標題，群組合併範圍正確', function () {
  const header = buildFillGridHeaderRows_();
  assert.strictEqual(header.headerRows.length, 3);
  assert.strictEqual(header.headerRows[2][0], '_DATE', '第 3 行是機器鍵');
  assert.strictEqual(header.groupSpans[0].group, '基本');
  assert.strictEqual(header.groupSpans[0].start, 1);
  assert.strictEqual(header.groupSpans[0].length, 3);
});

test('fillGridColumnIndex_ / fillGridColumnDefAt_：互為反查', function () {
  const idx = fillGridColumnIndex_('SERMON_TITLE');
  assert.ok(idx > 0);
  assert.strictEqual(fillGridColumnDefAt_(idx).key, 'SERMON_TITLE');
  assert.strictEqual(fillGridColumnIndex_('NOT_A_KEY'), -1);
  assert.strictEqual(fillGridColumnDefAt_(9999), null);
});

test('工作表名稱：Fill_<QuarterID> 與反查', function () {
  assert.strictEqual(fillGridSheetName_('2027T4'), 'Fill_2027T4');
  assert.strictEqual(quarterIdFromFillGridSheetName_('Fill_2027T4'), '2027T4');
  assert.strictEqual(quarterIdFromFillGridSheetName_('BulletinWeeks'), null);
  assert.strictEqual(quarterIdFromFillGridSheetName_('Fill_'), null, '只有前綴沒有季度不算');
});

// =====================================================================
// 8. Fill_ 以外的工作表被編輯 → onEdit 直接 return
// =====================================================================

test('8. isFillGridSheetName_：只有 Fill_ 開頭的才算季度填寫表', function () {
  assert.strictEqual(isFillGridSheetName_('Fill_2027T4'), true);
  assert.strictEqual(isFillGridSheetName_('BulletinWeeks'), false);
  assert.strictEqual(isFillGridSheetName_('Config'), false);
  assert.strictEqual(isFillGridSheetName_('Filling'), false, 'Filling 不是 Fill_ 開頭');
});

test('8b. onFillGridEdit_：非 Fill_ 工作表的編輯直接 return，完全不動任何資料', function () {
  const env = makeFillEnv({});
  const before = JSON.stringify(env.sandbox.readSheet('BulletinWeeks'));

  env.sandbox.onFillGridEdit_({
    range: {
      getSheet: function () { return { getName: function () { return 'Config'; } }; },
      getRow: function () { return 4; }, getColumn: function () { return 1; },
      getNumRows: function () { return 1; }, getNumColumns: function () { return 1; }
    }
  });

  assert.strictEqual(JSON.stringify(env.sandbox.readSheet('BulletinWeeks')), before);
  assert.strictEqual(env.sandbox.readSheet('AuditLog').length, 0);
});

test('8c. onFillGridEdit_：事件物件缺漏時不拋錯（onEdit 拋錯是靜默的，不可以讓它掛掉）', function () {
  const env = makeFillEnv({});
  assert.doesNotThrow(function () { env.sandbox.onFillGridEdit_(null); });
  assert.doesNotThrow(function () { env.sandbox.onFillGridEdit_({}); });
});

// =====================================================================
// 真正入口：建立填寫表
// =====================================================================

test('7. 建立填寫表：第一次建立，13 行結構的格子表（本測試用 4 個主日）', function () {
  const env = makeFillEnv({ withGrid: false });
  const result = env.sandbox.createOrRefreshFillGrid_(QUARTER_ID);

  assert.strictEqual(result.ok, true, JSON.stringify(result));
  assert.strictEqual(result.created, true);
  assert.strictEqual(result.rowCount, SERVICE_DATES.length);

  const rows = env.sandbox.readFillGridRows_(QUARTER_ID);
  assert.strictEqual(rows.length, SERVICE_DATES.length);
  assertArrayEqual(rows.map(function (r) { return r.isoDate; }), SERVICE_DATES);
});

test('7b. 建立填寫表冪等：跑兩次，第二次 0 改動（沒有 push／pull／conflict）', function () {
  const env = makeFillEnv({ withGrid: false });
  env.sandbox.createOrRefreshFillGrid_(QUARTER_ID);

  const second = env.sandbox.createOrRefreshFillGrid_(QUARTER_ID);
  assert.strictEqual(second.ok, true);
  assert.strictEqual(second.created, false, '第二次是刷新，不是建立');
  assert.strictEqual(second.sync.pushCount, 0);
  assert.strictEqual(second.sync.pullCount, 0);
  assert.strictEqual(second.sync.conflictCount, 0, '第二次不應該有任何衝突');
});

test('7c. 建立填寫表：唯讀三欄由職事表填入', function () {
  const env = makeFillEnv({ withGrid: false });
  env.sandbox.createOrRefreshFillGrid_(QUARTER_ID);

  const rows = env.sandbox.readFillGridRows_(QUARTER_ID);
  assert.strictEqual(rows[0].values._DATE, '2027-11-07');
  assert.strictEqual(rows[0].values._WEEK, '1');
  assert.strictEqual(rows[1].values._WEEK, '2');
});

test('7d. 建立填寫表：職事表沒有那一季 → 明確訊息，不拋錯', function () {
  const env = makeFillEnv({ withGrid: false });
  const result = env.sandbox.createOrRefreshFillGrid_('9999T9');
  assert.strictEqual(result.ok, false);
  assert.ok(result.message.indexOf('9999T9') !== -1);
  assert.ok(result.message.indexOf('職事表') !== -1);
});

test('7e. 建立填寫表：季度 ID 空白 → 明確訊息', function () {
  const env = makeFillEnv({ withGrid: false });
  const result = env.sandbox.createOrRefreshFillGrid_('   ');
  assert.strictEqual(result.ok, false);
  assert.ok(result.message.indexOf('空') !== -1);
});

test('7f. 建立填寫表：會先做一次備份（還原點）', function () {
  const env = makeFillEnv({ withGrid: false });
  const result = env.sandbox.createOrRefreshFillGrid_(QUARTER_ID);
  assert.ok(result.backupId.indexOf(QUARTER_ID) === 0, '備份編號應該以季度開頭：' + result.backupId);
  assert.ok(env.sandbox.readSheet('FillBackup').length > 0);
});

// =====================================================================
// 同步：由真正入口叫下去
// =====================================================================

/** 建立格子表並填好快照，回傳環境（之後的測試由這個狀態出發）。 */
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
  return row.rowNo;
}

/** 直接改 BulletinWeeks 某一格（模擬 Web App 儲存，但不更新快照）。 */
function setSystemCell(env, isoDate, fieldKey, value) {
  env.sandbox.writeBulletinWeekField_(isoDate, fieldKey, value);
}

test('同步 PUSH：只有格子表改過 → 寫回 BulletinWeeks 並記 AuditLog', function () {
  const env = makeSyncedEnv();
  setGridCell(env, '2027-11-07', 'SERMON_TITLE', '因信稱義');

  const plan = env.sandbox.syncFillGrid_(QUARTER_ID);
  assert.strictEqual(plan.pushCount, 1);
  assert.strictEqual(plan.conflictCount, 0);

  const week = env.sandbox.readSheet('BulletinWeeks').filter(function (r) {
    return env.sandbox.fillGridCellText_(r.SERVICE_DATE) === '2027-11-07';
  })[0];
  assert.strictEqual(week.SERMON_TITLE, '因信稱義');

  assert.ok(env.sandbox.readSheet('AuditLog').some(function (r) { return r.ACTION === 'FILL_SYNC_PUSH'; }));
});

test('同步 PULL：只有系統改過 → 刷新格子表並記 AuditLog', function () {
  const env = makeSyncedEnv();
  setSystemCell(env, '2027-11-07', 'SERMON_TITLE', '由填寫介面改的');

  const plan = env.sandbox.syncFillGrid_(QUARTER_ID);
  assert.strictEqual(plan.pullCount, 1);
  assert.strictEqual(plan.conflictCount, 0);

  const rows = env.sandbox.readFillGridRows_(QUARTER_ID);
  const row = rows.filter(function (r) { return r.isoDate === '2027-11-07'; })[0];
  assert.strictEqual(row.values.SERMON_TITLE, '由填寫介面改的');

  assert.ok(env.sandbox.readSheet('AuditLog').some(function (r) { return r.ACTION === 'FILL_SYNC_PULL'; }));
});

// =====================================================================
// 2. 衝突時沒有任何寫入
// =====================================================================

test('2. 衝突：兩邊都改過 → 一格都沒有被寫入，兩邊的值都保留', function () {
  const env = makeSyncedEnv();
  setGridCell(env, '2027-11-07', 'SERMON_TITLE', '格子表的講題');
  setSystemCell(env, '2027-11-07', 'SERMON_TITLE', '系統的講題');

  const plan = env.sandbox.syncFillGrid_(QUARTER_ID);
  assert.strictEqual(plan.conflictCount, 1);
  assert.strictEqual(plan.pushCount, 0);
  assert.strictEqual(plan.pullCount, 0);

  // 兩邊都要維持原樣
  const gridRow = env.sandbox.readFillGridRows_(QUARTER_ID)
    .filter(function (r) { return r.isoDate === '2027-11-07'; })[0];
  assert.strictEqual(gridRow.values.SERMON_TITLE, '格子表的講題', '格子表的值不可以被蓋掉');

  const week = env.sandbox.readSheet('BulletinWeeks').filter(function (r) {
    return env.sandbox.fillGridCellText_(r.SERVICE_DATE) === '2027-11-07';
  })[0];
  assert.strictEqual(week.SERMON_TITLE, '系統的講題', '系統的值不可以被蓋掉');
});

test('2b. 衝突：快照維持原樣，下一次同步仍然報成衝突（不會無聲消失）', function () {
  const env = makeSyncedEnv();
  setGridCell(env, '2027-11-07', 'SERMON_TITLE', '格子表的講題');
  setSystemCell(env, '2027-11-07', 'SERMON_TITLE', '系統的講題');

  env.sandbox.syncFillGrid_(QUARTER_ID);
  const second = env.sandbox.syncFillGrid_(QUARTER_ID);
  assert.strictEqual(second.conflictCount, 1, '衝突未處理之前不可以自己消失');
});

test('2c. 衝突：AuditLog 不會出現 PUSH／PULL 記錄', function () {
  const env = makeSyncedEnv();
  setGridCell(env, '2027-11-07', 'SERMON_TITLE', 'A');
  setSystemCell(env, '2027-11-07', 'SERMON_TITLE', 'B');
  env.sandbox.syncFillGrid_(QUARTER_ID);

  const audit = env.sandbox.readSheet('AuditLog');
  assert.ok(!audit.some(function (r) { return r.ACTION === 'FILL_SYNC_PUSH' || r.ACTION === 'FILL_SYNC_PULL'; }));
});

test('2d. 衝突：刷新格子表時，衝突格的格子表值仍然不會被蓋掉', function () {
  const env = makeSyncedEnv();
  setGridCell(env, '2027-11-07', 'SERMON_TITLE', '格子表的講題');
  setSystemCell(env, '2027-11-07', 'SERMON_TITLE', '系統的講題');

  env.sandbox.createOrRefreshFillGrid_(QUARTER_ID);

  const gridRow = env.sandbox.readFillGridRows_(QUARTER_ID)
    .filter(function (r) { return r.isoDate === '2027-11-07'; })[0];
  assert.strictEqual(gridRow.values.SERMON_TITLE, '格子表的講題',
    '刷新格子表時也要守住「衝突不蓋任何一邊」');
});

// =====================================================================
// 3. 唯讀欄被改 → 還原原值
// =====================================================================

function editEvent(env, rowNo, colNo, numRows, numCols) {
  const sheet = env.sheets['Fill_' + QUARTER_ID];
  return {
    range: {
      getSheet: function () { return sheet; },
      getRow: function () { return rowNo; },
      getColumn: function () { return colNo; },
      getNumRows: function () { return numRows || 1; },
      getNumColumns: function () { return numCols || 1; }
    }
  };
}

test('3. 唯讀欄 _WEEK 被改 → 自動還原成職事表的值，並顯示浮動提示（不加永久註解）', function () {
  const env = makeSyncedEnv();
  const sheet = env.sheets['Fill_' + QUARTER_ID];
  const weekCol = env.sandbox.fillGridColumnIndex_('_WEEK');
  const rowNo = 4;

  sheet.getRange(rowNo, weekCol).setValue('999');
  env.sandbox.onFillGridEdit_(editEvent(env, rowNo, weekCol));

  assert.strictEqual(String(sheet.getRange(rowNo, weekCol).getValue()), '1', '應該還原成職事表算出來的第 1 個主日');
  assert.strictEqual(sheet.getRange(rowNo, weekCol).getNote(), '', 'prompt8b：不應該再加永久儲存格註解');
  assert.ok(env.toasts.some(function (t) { return t.message.indexOf('唯讀欄') !== -1; }), '要顯示浮動提示');
  assert.ok(env.sandbox.readSheet('AuditLog').some(function (r) { return r.ACTION === 'FILL_GRID_REVERT_READONLY'; }));
});

test('3b. 唯讀欄 _DATE 被改 → 用那一行在格子表的位置反推真正日期，立即還原（不是打入的錯值）', function () {
  const env = makeSyncedEnv();
  const sheet = env.sheets['Fill_' + QUARTER_ID];
  const dateCol = env.sandbox.fillGridColumnIndex_('_DATE');

  const original = String(sheet.getRange(4, dateCol).getValue());
  assert.strictEqual(original, '2027-11-07');

  sheet.getRange(4, dateCol).setValue('2027-10-06');
  env.sandbox.onFillGridEdit_(editEvent(env, 4, dateCol));

  // prompt8b 修的根因：即使使用者剛打錯 _DATE 本身，還原也不可以照抄
  // 剛打錯的值——必須用這一行的**位置**對照職事表反推出真正日期。
  assert.strictEqual(String(sheet.getRange(4, dateCol).getValue()), '2027-11-07',
    '不需要等下一次刷新，onFillGridEdit_ 當下就要還原成正確日期');

  const revertRow = env.sandbox.readSheet('AuditLog').filter(function (r) {
    return r.ACTION === 'FILL_GRID_REVERT_READONLY';
  }).pop();
  assert.strictEqual(revertRow.ROW_KEY, '2027-11-07', 'ROW_KEY 要記那一行原本的主日日期，不是使用者剛打入的錯值');
});

test('3c. 可編輯欄被改 → 寫回 BulletinWeeks，不會被當成唯讀欄還原', function () {
  const env = makeSyncedEnv();
  const sheet = env.sheets['Fill_' + QUARTER_ID];
  const col = env.sandbox.fillGridColumnIndex_('SERMON_TITLE');

  sheet.getRange(4, col).setValue('新講題');
  env.sandbox.onFillGridEdit_(editEvent(env, 4, col));

  const week = env.sandbox.readSheet('BulletinWeeks').filter(function (r) {
    return env.sandbox.fillGridCellText_(r.SERVICE_DATE) === '2027-11-07';
  })[0];
  assert.strictEqual(week.SERMON_TITLE, '新講題');
  assert.strictEqual(String(sheet.getRange(4, col).getValue()), '新講題', '可編輯欄不可以被還原');
});

test('3d. onFillGridEdit_：標題三行被改不會影響資料', function () {
  const env = makeSyncedEnv();
  const before = JSON.stringify(env.sandbox.readSheet('BulletinWeeks'));
  env.sandbox.onFillGridEdit_(editEvent(env, 2, 5));
  assert.strictEqual(JSON.stringify(env.sandbox.readSheet('BulletinWeeks')), before);
});

test('3e.「建立／刷新季度填寫表」會清走唯讀三欄既有的殘留註解（舊版留下的垃圾）', function () {
  const env = makeSyncedEnv();
  const sheet = env.sheets['Fill_' + QUARTER_ID];
  const weekCol = env.sandbox.fillGridColumnIndex_('_WEEK');
  const specialCol = env.sandbox.fillGridColumnIndex_('_SPECIAL');

  // 模擬舊版留下的永久註解垃圾。
  sheet.getRange(4, weekCol).setNote('「當月第幾主日」不可以編輯。');
  sheet.getRange(5, specialCol).setNote('「特別主日」不可以編輯。');

  env.sandbox.createOrRefreshFillGrid_(QUARTER_ID);

  assert.strictEqual(sheet.getRange(4, weekCol).getNote(), '', '刷新之後應該清乾淨');
  assert.strictEqual(sheet.getRange(5, specialCol).getNote(), '', '刷新之後應該清乾淨');
});

// =====================================================================
// 4. 多格貼上逐格處理
// =====================================================================

test('4. 多格貼上：一次貼 2 行 × 2 欄，四格都要各自寫回', function () {
  const env = makeSyncedEnv();
  const sheet = env.sheets['Fill_' + QUARTER_ID];
  const startCol = env.sandbox.fillGridColumnIndex_('SERMON_TITLE');

  sheet.getRange(4, startCol).setValue('講題一');
  sheet.getRange(4, startCol + 1).setValue('回應詩歌一');
  sheet.getRange(5, startCol).setValue('講題二');
  sheet.getRange(5, startCol + 1).setValue('回應詩歌二');

  env.sandbox.onFillGridEdit_(editEvent(env, 4, startCol, 2, 2));

  const weeks = {};
  env.sandbox.readSheet('BulletinWeeks').forEach(function (r) {
    weeks[env.sandbox.fillGridCellText_(r.SERVICE_DATE)] = r;
  });

  const defAt = env.sandbox.fillGridColumnDefAt_(startCol + 1);
  assert.strictEqual(weeks['2027-11-07'].SERMON_TITLE, '講題一');
  assert.strictEqual(weeks['2027-11-14'].SERMON_TITLE, '講題二');
  assert.strictEqual(weeks['2027-11-07'][defAt.key], '回應詩歌一');
  assert.strictEqual(weeks['2027-11-14'][defAt.key], '回應詩歌二');
});

test('4b. 多格貼上：橫跨唯讀欄與可編輯欄時，唯讀的還原、可編輯的照樣寫回', function () {
  const env = makeSyncedEnv();
  const sheet = env.sheets['Fill_' + QUARTER_ID];
  const weekCol = env.sandbox.fillGridColumnIndex_('_WEEK');

  // 由 _WEEK 開始貼 3 欄：_WEEK、_SPECIAL、PAGE_TITLE
  sheet.getRange(4, weekCol).setValue('亂改');
  sheet.getRange(4, weekCol + 1).setValue('亂改');
  sheet.getRange(4, weekCol + 2).setValue('新標題');

  const result = env.sandbox.applyFillGridEdit_(sheet, sheet.getRange(4, weekCol, 1, 3), QUARTER_ID);
  assert.strictEqual(result.reverted, 2, '_WEEK 與 _SPECIAL 兩個唯讀欄都要還原');
  assert.strictEqual(result.applied, 1, 'PAGE_TITLE 要照樣寫回');
});

// =====================================================================
// 5–6. 人數欄與日期欄的原樣保存
// =====================================================================

test('5. 人數欄輸入 `--` 原樣保存（不會變成 0 或空白）', function () {
  const env = makeSyncedEnv();
  setGridCell(env, '2027-11-07', 'ATT_CANN_WORSHIP', '--');
  env.sandbox.syncFillGrid_(QUARTER_ID);

  const week = env.sandbox.readSheet('BulletinWeeks').filter(function (r) {
    return env.sandbox.fillGridCellText_(r.SERVICE_DATE) === '2027-11-07';
  })[0];
  assert.strictEqual(week.ATT_CANN_WORSHIP, '--');
});

test('5b. 人數欄輸入 `前:5 / 後:120` 原樣保存', function () {
  const env = makeSyncedEnv();
  setGridCell(env, '2027-11-07', 'ATT_CANE_WORSHIP', '前:5 / 後:120');
  env.sandbox.syncFillGrid_(QUARTER_ID);

  const week = env.sandbox.readSheet('BulletinWeeks').filter(function (r) {
    return env.sandbox.fillGridCellText_(r.SERVICE_DATE) === '2027-11-07';
  })[0];
  assert.strictEqual(week.ATT_CANE_WORSHIP, '前:5 / 後:120');
});

test('6. ATTENDANCE_DATE 輸入 2027-10-31：格子表保持字串，來回同步不會走樣', function () {
  // ⚠️ `BulletinWeeks.ATTENDANCE_DATE` 在 schema 上本來就是 DATE 型別
  // （第一輪定的，`buildBulletinModel_()` 靠 `instanceof Date` 判斷），
  // 所以系統那一邊讀回來是 Date **是正確的**。真正要守住的是兩件事：
  //   1. **格子表**那一格保持人手打的字串（欄位設了純文字格式）；
  //   2. 來回同步之後不會走樣、也不會每次都被判定成「有改動」。
  // 第 2 點才是會出事的地方：如果比對不是在字串層做，Date 與字串永遠
  // 不相等，同步會無限來回推。
  const env = makeSyncedEnv();
  setGridCell(env, '2027-11-07', 'ATTENDANCE_DATE', '2027-10-31');
  env.sandbox.syncFillGrid_(QUARTER_ID);

  const gridRow = env.sandbox.readFillGridRows_(QUARTER_ID)
    .filter(function (r) { return r.isoDate === '2027-11-07'; })[0];
  assert.strictEqual(gridRow.values.ATTENDANCE_DATE, '2027-10-31', '格子表要保持人手打的字串');

  const second = env.sandbox.syncFillGrid_(QUARTER_ID);
  assert.strictEqual(second.pushCount, 0, '⚠️ 同一個值不可以每次同步都被當成有改動');
  assert.strictEqual(second.pullCount, 0);
  assert.strictEqual(second.conflictCount, 0);
});

test('6b. fillGridCellText_：Date 物件轉成 yyyy-MM-dd（比對一律在字串層做）', function () {
  const d = new Date(2027, 10, 7);
  assert.strictEqual(fillGridCellText_(d), '2027-11-07');
  assert.strictEqual(fillGridCellText_(null), '');
  assert.strictEqual(fillGridCellText_(undefined), '');
  assert.strictEqual(fillGridCellText_(true), 'TRUE');
  assert.strictEqual(fillGridCellText_(0), '0', '數字 0 不可以變成空字串');
});

// =====================================================================
// 9. Web App 儲存後 FillSnapshot 有更新（最容易漏的一項）
// =====================================================================

test('9. ⚠️ Web App 儲存後，FillSnapshot 一定要更新', function () {
  const env = makeSyncedEnv();

  const before = env.sandbox.readSheet('FillSnapshot').filter(function (r) {
    return r.FIELD_KEY === 'SERMON_TITLE' && env.sandbox.fillGridCellText_(r.SERVICE_DATE) === '2027-11-07';
  })[0];
  assert.strictEqual(env.sandbox.fillGridCellText_(before.VALUE), '', '一開始是空的');

  env.sandbox.saveWeekFromWebApp_({
    isoDate: '2027-11-07', lastSavedAt: null,
    week: { SERMON_TITLE: '經填寫介面改的' },
    announcements: [], prayers: [], fellowships: [], finance: []
  });

  const after = env.sandbox.readSheet('FillSnapshot').filter(function (r) {
    return r.FIELD_KEY === 'SERMON_TITLE' && env.sandbox.fillGridCellText_(r.SERVICE_DATE) === '2027-11-07';
  })[0];
  assert.strictEqual(env.sandbox.fillGridCellText_(after.VALUE), '經填寫介面改的',
    '⚠️ 沒有更新快照的話，下一次同步會把這次儲存誤判成「兩邊都改過」');
});

test('9b. ⚠️ Web App 儲存 ＋ 格子表改另一格 → 各自同步，不會誤判成衝突', function () {
  const env = makeSyncedEnv();

  // 填寫介面改一格
  env.sandbox.saveWeekFromWebApp_({
    isoDate: '2027-11-07', lastSavedAt: null,
    week: { SERMON_TITLE: '介面改的講題' },
    announcements: [], prayers: [], fellowships: [], finance: []
  });
  // 格子表改另一格
  setGridCell(env, '2027-11-07', 'HYMN_PRAISE', '格子表改的詩歌');

  // 填寫介面儲存時已經即時把 SERMON_TITLE 刷新到格子表並更新快照，
  // 所以同步時只剩下格子表那一格要寫回。
  const gridRow = env.sandbox.readFillGridRows_(QUARTER_ID)
    .filter(function (r) { return r.isoDate === '2027-11-07'; })[0];
  assert.strictEqual(gridRow.values.SERMON_TITLE, '介面改的講題',
    '⚠️ 儲存之後格子表那一格要即時跟住更新，否則下次同步會把舊值推回去蓋掉它');

  const plan = env.sandbox.syncFillGrid_(QUARTER_ID);
  assert.strictEqual(plan.conflictCount, 0, '⚠️ 兩個不同的格子，不應該有任何衝突');
  assert.strictEqual(plan.pushCount, 1, '格子表那一格要寫回');
  assert.strictEqual(plan.pullCount, 0, '介面那一格已經即時刷新過，不用再 PULL');
});

test('9b-2. ⚠️ 反向鎖：填寫介面儲存之後，同步**不可以**把格子表的舊值推回去', function () {
  // 這是實作時真的踩過的坑：只更新快照、不刷新格子表的話，
  // 下一次同步會看到「格子表(舊) ≠ 快照(新)」而判定成「格子表改過」，
  // 於是 PUSH 回去，把填寫介面剛剛存好的內容蓋掉。
  const env = makeSyncedEnv();
  env.sandbox.saveWeekFromWebApp_({
    isoDate: '2027-11-07', lastSavedAt: null,
    week: { SERMON_TITLE: '介面改的講題' },
    announcements: [], prayers: [], fellowships: [], finance: []
  });

  env.sandbox.syncFillGrid_(QUARTER_ID);

  const week = env.sandbox.readSheet('BulletinWeeks').filter(function (r) {
    return env.sandbox.fillGridCellText_(r.SERVICE_DATE) === '2027-11-07';
  })[0];
  assert.strictEqual(week.SERMON_TITLE, '介面改的講題',
    '⚠️ 填寫介面存好的內容絕對不可以被同步推回舊值蓋掉');
});

test('9b-3. 格子表那一格有未同步的改動時，儲存**不會**蓋掉它（留給同步報衝突）', function () {
  const env = makeSyncedEnv();
  setGridCell(env, '2027-11-07', 'SERMON_TITLE', '格子表打的');

  env.sandbox.saveWeekFromWebApp_({
    isoDate: '2027-11-07', lastSavedAt: null,
    week: { SERMON_TITLE: '介面打的' },
    announcements: [], prayers: [], fellowships: [], finance: []
  });

  const gridRow = env.sandbox.readFillGridRows_(QUARTER_ID)
    .filter(function (r) { return r.isoDate === '2027-11-07'; })[0];
  assert.strictEqual(gridRow.values.SERMON_TITLE, '格子表打的',
    '格子表有未同步的改動時，儲存不可以靜靜蓋掉它');

  const plan = env.sandbox.syncFillGrid_(QUARTER_ID);
  assert.strictEqual(plan.conflictCount, 1, '這才是真正的「兩邊都改過」，要報成衝突');
});

test('9c. Web App 儲存同一格之後，格子表再改**同一格** → 才算衝突', function () {
  const env = makeSyncedEnv();
  env.sandbox.saveWeekFromWebApp_({
    isoDate: '2027-11-07', lastSavedAt: null,
    week: { SERMON_TITLE: '介面改的' },
    announcements: [], prayers: [], fellowships: [], finance: []
  });
  // 快照已經更新成「介面改的」；現在格子表改成第三個值
  setGridCell(env, '2027-11-07', 'SERMON_TITLE', '格子表改的');

  const plan = env.sandbox.syncFillGrid_(QUARTER_ID);
  assert.strictEqual(plan.conflictCount, 0, '快照已經跟系統一樣，所以只有格子表改過 ⇒ PUSH');
  assert.strictEqual(plan.pushCount, 1);
});

test('9d. refreshFillSnapshotAfterSave_：只處理屬於格子表的欄位', function () {
  const env = makeSyncedEnv();
  const beforeCount = env.sandbox.readSheet('FillSnapshot').length;

  env.sandbox.refreshFillSnapshotAfterSave_('2027-11-07', [
    { field: 'SERMON_TITLE', newValue: 'A' },
    { field: 'NOT_A_GRID_FIELD', newValue: 'B' }
  ]);

  assert.strictEqual(env.sandbox.readSheet('FillSnapshot').length, beforeCount,
    '快照是整張重寫的，行數不應該因為多一個不相干的欄位而增加');

  const gridRow = env.sandbox.readFillGridRows_(QUARTER_ID)
    .filter(function (r) { return r.isoDate === '2027-11-07'; })[0];
  assert.strictEqual(gridRow.values.SERMON_TITLE, 'A', '屬於格子表的欄位要刷新');
  assert.strictEqual(gridRow.values.NOT_A_GRID_FIELD, undefined, '不屬於格子表的欄位根本沒有那一欄');
});

test('9e. refreshFillSnapshotAfterSave_：快照寫入失敗不會令儲存失敗', function () {
  const env = makeSyncedEnv();
  assert.doesNotThrow(function () {
    env.sandbox.refreshFillSnapshotAfterSave_('1999-01-01', [{ field: 'SERMON_TITLE', newValue: 'A' }]);
  }, '找不到季度時應該靜靜略過，不可以拋錯');
});

// =====================================================================
// 快照索引與填寫進度
// =====================================================================

test('buildFillSnapshotIndex_：同一個鍵取最後一行（後來居上）', function () {
  const index = buildFillSnapshotIndex_([
    { QUARTER_ID: '2027T4', SERVICE_DATE: '2027-11-07', FIELD_KEY: 'A', VALUE: '舊' },
    { QUARTER_ID: '2027T4', SERVICE_DATE: '2027-11-07', FIELD_KEY: 'A', VALUE: '新' }
  ], '2027T4');
  assert.strictEqual(index[fillSnapshotKey_('2027-11-07', 'A')], '新');
});

test('buildFillSnapshotIndex_：只收指定季度的行', function () {
  const index = buildFillSnapshotIndex_([
    { QUARTER_ID: '2027T4', SERVICE_DATE: '2027-11-07', FIELD_KEY: 'A', VALUE: '本季' },
    { QUARTER_ID: '2028T1', SERVICE_DATE: '2028-01-02', FIELD_KEY: 'A', VALUE: '別季' }
  ], '2027T4');
  assert.strictEqual(Object.keys(index).length, 1);
});

test('buildFillProgressByGroup_：逐個群組算已填／待填', function () {
  const progress = buildFillProgressByGroup_([
    { isoDate: '2027-11-07', values: { SERMON_TITLE: '有值', HYMN_PRAISE: '' } }
  ]);
  const program = progress.filter(function (p) { return p.group === '崇拜程序'; })[0];
  assert.ok(program.total > 0);
  assert.strictEqual(program.filled, 1);
  assert.strictEqual(program.missing, program.total - 1);
});

test('buildFillProgressByGroup_：唯讀欄不計入進度（那些不是要人填的）', function () {
  const progress = buildFillProgressByGroup_([{ isoDate: '2027-11-07', values: { _DATE: '2027-11-07' } }]);
  const basic = progress.filter(function (p) { return p.group === '基本'; })[0];
  assert.strictEqual(basic, undefined, '「基本」群組全部唯讀，不應該出現在進度統計內');
});

// =====================================================================
// 處理衝突
// =====================================================================

test('處理衝突：選「用格子表」→ 寫回系統，快照更新，衝突消失', function () {
  const env = makeSyncedEnv();
  setGridCell(env, '2027-11-07', 'SERMON_TITLE', '格子表的');
  setSystemCell(env, '2027-11-07', 'SERMON_TITLE', '系統的');
  env.sandbox.syncFillGrid_(QUARTER_ID);

  const result = env.sandbox.resolveFillConflicts_(QUARTER_ID, [
    { isoDate: '2027-11-07', fieldKey: 'SERMON_TITLE', choice: 'GRID' }
  ]);
  assert.strictEqual(result.appliedGrid, 1);

  const plan = env.sandbox.computeFillSyncPlan_(QUARTER_ID);
  assert.strictEqual(plan.conflictCount, 0, '處理完之後不應該再有衝突');
});

test('處理衝突：選「用系統」→ 刷新格子表', function () {
  const env = makeSyncedEnv();
  setGridCell(env, '2027-11-07', 'SERMON_TITLE', '格子表的');
  setSystemCell(env, '2027-11-07', 'SERMON_TITLE', '系統的');
  env.sandbox.syncFillGrid_(QUARTER_ID);

  env.sandbox.resolveFillConflicts_(QUARTER_ID, [
    { isoDate: '2027-11-07', fieldKey: 'SERMON_TITLE', choice: 'SYSTEM' }
  ]);

  const gridRow = env.sandbox.readFillGridRows_(QUARTER_ID)
    .filter(function (r) { return r.isoDate === '2027-11-07'; })[0];
  assert.strictEqual(gridRow.values.SERMON_TITLE, '系統的');
});

test('處理衝突：選「暫不處理」→ 完全不動，下次仍然報成衝突', function () {
  const env = makeSyncedEnv();
  setGridCell(env, '2027-11-07', 'SERMON_TITLE', '格子表的');
  setSystemCell(env, '2027-11-07', 'SERMON_TITLE', '系統的');
  env.sandbox.syncFillGrid_(QUARTER_ID);

  const result = env.sandbox.resolveFillConflicts_(QUARTER_ID, [
    { isoDate: '2027-11-07', fieldKey: 'SERMON_TITLE', choice: 'SKIP' }
  ]);
  assert.strictEqual(result.skipped, 1);

  const plan = env.sandbox.computeFillSyncPlan_(QUARTER_ID);
  assert.strictEqual(plan.conflictCount, 1, '暫不處理的格子下次一定要再問一次');
});

// =====================================================================

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
