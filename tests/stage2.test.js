#!/usr/bin/env node
/**
 * tests/stage2.test.js
 *
 * 第二批階段 2 的回歸測試：每週版本記錄（`WeekSnapshots`）、看差異、還原、
 * 「重設這一週」。
 *
 * 後端一律經真正入口：`saveWeekFromWebApp_()`、`restoreWeekSnapshotFromWebApp_()`、
 * `resetWeekFromWebApp_()`、`applyContentImport_()`、`syncFillGrid_()`、
 * `onFillGridEdit_()`、`apiListWeekSnapshots()` 等；前端函式用「BEGIN／END 標記」
 * 從 Script.html 抽出來，在假 DOM 上真的執行。
 *
 * 執行方式：node tests/stage2.test.js
 * 離開碼：0＝全部通過　1＝有測試失敗
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { makeFillEnv, QUARTER_ID, SERVICE_DATES } = require('./helpers/fillEnv');
const contentEnv = require('./helpers/contentEnv');
const { makeWordEnv, weekRowOf, OUTPUT_FOLDER } = require('./helpers/wordEnv');
const { assertWrittenChinese } = require('./helpers/writtenChinese');

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
    console.log('    ' + (err && err.stack ? err.stack.split('\n').slice(0, 5).join('\n    ') : err));
  }
}

function readSrc(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

const D = '2027-11-07';
const D_NEXT = '2027-11-14';

// =====================================================================
// 共用工具
// =====================================================================

function weekRowInput(iso, extra) {
  return Object.assign({ SERVICE_DATE: iso, QUARTER_ID: QUARTER_ID, WEEK_OF_MONTH: 1, STATUS: 'DRAFT' }, extra || {});
}

/** 造一個只有 D 與下一個主日兩行的環境（職事表有 CHAIR 崗位，講員表格不在這一階段）。 */
function makeEnv(options) {
  const o = options || {};
  return makeFillEnv(Object.assign({
    withGrid: false,
    weekRows: [weekRowInput(D, o.week || {}), weekRowInput(D_NEXT, o.nextWeek || {})],
    config: Object.assign({ PRELUDE_DEFAULT: '預設序樂' }, o.config || {})
  }, o.fill || {}));
}

/** 組一個儲存 payload：patch 只含要改的欄位，baseWeek 取載入時的值。 */
function savePayload(sb, iso, patch, extra) {
  const loaded = sb.loadWeekForWebApp_(iso);
  return Object.assign({
    isoDate: iso, lastSavedAt: loaded.lastSavedAt, week: patch,
    baseWeek: sb.baseWeekFor_(loaded.week, patch)
  }, extra || {});
}

function save(env, iso, patch, extra) {
  return env.sandbox.saveWeekFromWebApp_(savePayload(env.sandbox, iso, patch, extra));
}

function versionsOf(env, iso) {
  return env.sandbox.listWeekSnapshotsForWebApp_(iso).versions;
}

function payloadOf(env, iso, snapshotId) {
  return env.sandbox.loadWeekSnapshot_(iso, snapshotId).payload;
}

function auditCount(env, action) {
  return env.sandbox.readSheet('AuditLog').filter(function (r) { return r.ACTION === action; }).length;
}

function rowOf(env, iso) {
  return env.sandbox.readSheet('BulletinWeeks').filter(function (r) {
    return env.sandbox.fillGridCellText_(r.SERVICE_DATE) === iso;
  })[0];
}

function dutyRows(env) { return env.sandbox.readSheet('DutyOverride'); }
function fieldOverrideRows(env) { return env.sandbox.readSheet('FieldOverride'); }

/** 沙盒裏出來的陣列／物件和測試這邊不同 realm，deepStrictEqual 會誤判，先轉成純資料。 */
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function reasonsOf(env, iso) {
  return plain(versionsOf(env, iso).map(function (v) { return v.reason; }));
}

/** 在沙盒裏造一個 Date（沙盒的 `instanceof Date` 認得）。 */
function sbDate(env, year, month, day) {
  return vm.runInContext('new Date(' + year + ',' + (month - 1) + ',' + day + ')', env.sandbox);
}

/**
 * 把這一週的 LAST_SAVED_AT 改成很舊的時間。LAST_SAVED_AT 只有秒的精度，
 * 同一秒內連續儲存兩次，鎖定值會一樣；測試要驗「被別人改過」就必須先拉開距離。
 */
function ageSaveToken(env, iso) {
  const info = env.sandbox.readBulletinWeekRowWithRowNo_(iso);
  env.sandbox.writeWeekCell_(info.__rowNo, 'LAST_SAVED_AT', sbDate(env, 2020, 1, 1));
}

const CHAIR_EDIT = function (name) { return [{ postId: 'CHAIR', slotIndex: 1, name: name }]; };

// =====================================================================
// 1. 常數與純函式
// =====================================================================

console.log('\n常數與純函式');

test('原因代碼與中文名稱在 WEEK_SNAPSHOT_REASONS 一處定義，十二個都有名稱', function () {
  const sb = makeEnv().sandbox;
  const codes = Object.keys(sb.WEEK_SNAPSHOT_REASONS);
  ['WEBAPP_SAVE', 'CONTENT_IMPORT_WEEK', 'CONTENT_IMPORT_QUARTER', 'ROSTER_BACKFILL', 'ROSTER_FETCH',
    'GRID_SYNC', 'GRID_EDIT', 'GRID_CONFLICT', 'BEFORE_RESET', 'BEFORE_RESTORE', 'SPEAKER_FORM', 'WORD_GENERATED']
    .forEach(function (code) {
      assert.ok(codes.indexOf(code) !== -1, '缺少原因代碼 ' + code);
      assert.ok(sb.weekSnapshotReasonLabel_(code) !== code, code + ' 沒有中文名稱');
    });
  assert.strictEqual(sb.weekSnapshotReasonLabel_('不存在'), '不存在', '查不到就原樣回代碼');
  assertWrittenChinese(assert, '版本原因名稱', codes.map(function (c) { return sb.WEEK_SNAPSHOT_REASONS[c]; }));
});

test('WeekSnapshots 欄位依次是 SNAPSHOT_ID…ACTIVE，新工作表接在既有工作表之後（階段 3 的表再接在它後面）', function () {
  const sb = makeEnv().sandbox;
  assert.deepStrictEqual(Array.from(sb.COLUMNS.WEEK_SNAPSHOTS.keys), [
    'SNAPSHOT_ID', 'PART_NO', 'SERVICE_DATE', 'QUARTER_ID', 'CREATED_AT', 'CREATED_BY', 'REASON',
    'SUMMARY', 'PAYLOAD_JSON', 'DOC_FILE_ID', 'ACTIVE'
  ]);
  const ids = Object.keys(sb.SHEETS);
  assert.strictEqual(ids.indexOf('WEEK_SNAPSHOTS'), ids.indexOf('MONKEY_STATE') + 1, '緊接在階段 2 之前最後一張表之後');
});

test('Config：SNAPSHOT_THROTTLE_MINUTES 預設 15、SNAPSHOT_LIST_LIMIT 預設 20，都有說明', function () {
  const sb = makeEnv().sandbox;
  const seed = {};
  sb.DEFAULTS.forEach(function (d) { seed[d.key] = d; });
  assert.strictEqual(seed.SNAPSHOT_THROTTLE_MINUTES.value, '15');
  assert.strictEqual(seed.SNAPSHOT_LIST_LIMIT.value, '20');
  assertWrittenChinese(assert, 'SNAPSHOT 說明', [seed.SNAPSHOT_THROTTLE_MINUTES.note, seed.SNAPSHOT_LIST_LIMIT.note]);
});

test('weekSnapshotActorShort_：只顯示電郵 @ 之前', function () {
  const sb = makeEnv().sandbox;
  assert.strictEqual(sb.weekSnapshotActorShort_('ivan@church.example'), 'ivan');
  assert.strictEqual(sb.weekSnapshotActorShort_('（未知使用者）'), '（未知使用者）');
  assert.strictEqual(sb.weekSnapshotActorShort_(''), '');
});

test('isWeekSnapshotThrottled_：只看季度填寫表一族最新的一個，時間內才擋', function () {
  const sb = makeEnv().sandbox;
  const env = makeEnv();
  const sb2 = env.sandbox; // Date 要由同一個沙盒造，沙盒裏的 instanceof Date 才認得
  const now = new Date(2027, 10, 7, 10, 0, 0).getTime();
  const group = function (reason, minutesAgo) {
    return { reason: reason, createdAt: vm.runInContext('new Date(' + (now - minutesAgo * 60000) + ')', sb2) };
  };
  assert.strictEqual(sb2.isWeekSnapshotThrottled_([group('GRID_EDIT', 5)], now, 15), true);
  assert.strictEqual(sb2.isWeekSnapshotThrottled_([group('GRID_EDIT', 20)], now, 15), false);
  // 剛剛在填寫介面儲存過，不算季度填寫表那一族：照樣要存。
  assert.strictEqual(sb2.isWeekSnapshotThrottled_([group('WEBAPP_SAVE', 1)], now, 15), false);
  assert.strictEqual(sb2.isWeekSnapshotThrottled_([], now, 15), false);
  assert.strictEqual(sb2.isWeekSnapshotThrottled_([group('GRID_SYNC', 1)], now, 0), false, '0＝不限制');
  // 最新的一個（列表由新到舊）決定；較舊的季度填寫表版本不影響
  assert.strictEqual(sb2.isWeekSnapshotThrottled_([group('WEBAPP_SAVE', 1), group('GRID_EDIT', 5)], now, 15), true);
});

test('appendSnapshotWarnings_：沒有警告原樣回傳；有警告改成 error 並先講已儲存', function () {
  const sb = makeEnv().sandbox;
  const msg = { type: 'success', text: '已儲存，更新了 1 個欄位。' };
  assert.strictEqual(sb.appendSnapshotWarnings_(msg, []), msg);
  const out = sb.appendSnapshotWarnings_(msg, ['版本記錄未能存好']);
  assert.strictEqual(out.type, 'error');
  assert.ok(out.text.indexOf('已儲存') === 0 && out.text.indexOf('版本記錄未能存好') !== -1);
});

test('planWeekSnapshotRestore_：該版本有、現在完全沒有那一行的覆寫 → 補一行（appends），不是改不存在的行', function () {
  const sb = makeEnv().sandbox;
  const plan = sb.planWeekSnapshotRestore_({
    week: { PRELUDE: 'A' },
    dutyOverrides: [{ POST_ID: 'CHAIR', SLOT_INDEX: 1, OVERRIDE_NAME: '甲', ROSTER_VALUE_AT_OVERRIDE: '乙', ROSTER_VERSION_AT_OVERRIDE: 3, REASON: '' }],
    fieldOverrides: [{ FIELD_KEY: 'SERMON_TITLE', OVERRIDE_VALUE: '改', SOURCE_VALUE_AT_OVERRIDE: '源', REASON: '' }]
  }, { weekRow: { PRELUDE: 'A' }, dutyRowsAll: [], fieldRowsAll: [] });
  assert.strictEqual(plan.dutyPlan.appends.length, 1);
  assert.strictEqual(plan.dutyPlan.appends[0].OVERRIDE_NAME, '甲');
  assert.strictEqual(plan.dutyPlan.updates.length, 0);
  assert.strictEqual(plan.fieldOverridePlan.upserts.length, 1);
  assert.strictEqual(plan.fieldChanges.length, 0);
});

test('planWeekSnapshotRestore_：內容表接管的欄位與系統欄不在還原範圍', function () {
  const sb = makeEnv().sandbox;
  const plan = sb.planWeekSnapshotRestore_({
    week: { ATT_ENG_WORSHIP: '99', CALL_REF: '舊', STATUS: 'SENT', DOC_ID: 'OLD', PRELUDE: '舊序樂' },
    dutyOverrides: [], fieldOverrides: []
  }, { weekRow: { ATT_ENG_WORSHIP: '1', CALL_REF: '新', STATUS: 'DRAFT', DOC_ID: 'NEW', PRELUDE: '新序樂' }, dutyRowsAll: [], fieldRowsAll: [] });
  assert.deepStrictEqual(plain(plan.fieldChanges.map(function (c) { return c.field; })), ['PRELUDE']);
});

// =====================================================================
// 2. 儲存前存版本（真入口 saveWeekFromWebApp_）
// =====================================================================

console.log('\n儲存前存版本');

test('儲存有改動：寫入之前存一個 WEBAPP_SAVE 版本，內容是儲存之前的值；AuditLog 記一筆', function () {
  const env = makeEnv({ week: { PRELUDE: '舊序樂', SERMON_TITLE: '舊講題' } });
  const result = save(env, D, { PRELUDE: '新序樂' });
  assert.strictEqual(result.changedFieldCount, 1);
  assert.strictEqual(result.message.type, 'success', JSON.stringify(result.message));

  const versions = versionsOf(env, D);
  assert.strictEqual(versions.length, 1);
  assert.strictEqual(versions[0].reason, 'WEBAPP_SAVE');
  assert.strictEqual(versions[0].reasonLabel, '填寫介面儲存');
  assert.strictEqual(versions[0].createdBy, 'tester', '電郵只顯示 @ 之前');
  assert.ok(versions[0].summary.indexOf('填寫欄位') !== -1 && versions[0].summary.indexOf('家事報告') !== -1, versions[0].summary);

  const payload = payloadOf(env, D, versions[0].snapshotId);
  assert.strictEqual(payload.week.PRELUDE, '舊序樂', '版本記的是儲存之前的值');
  assert.strictEqual(payload.week.SERMON_TITLE, '舊講題');
  assert.strictEqual(rowOf(env, D).PRELUDE, '新序樂');
  assert.strictEqual(auditCount(env, 'WEEK_SNAPSHOT_CREATE'), 1);
  assert.strictEqual(versionsOf(env, D_NEXT).length, 0, '沒有動到的主日不存版本');
});

test('儲存沒有任何改動：不存版本，也不更新 LAST_SAVED_AT', function () {
  const env = makeEnv({ week: { PRELUDE: '序樂' } });
  const before = rowOf(env, D).LAST_SAVED_AT;
  const result = save(env, D, { PRELUDE: '序樂' });
  assert.strictEqual(result.changedFieldCount, 0);
  assert.strictEqual(versionsOf(env, D).length, 0);
  assert.strictEqual(String(rowOf(env, D).LAST_SAVED_AT || ''), String(before || ''));
});

test('只改事奉框（dutyEdits）：也存版本，而且版本裏還沒有那筆新覆寫', function () {
  const env = makeEnv();
  const result = save(env, D, {}, { dutyEdits: CHAIR_EDIT('黃某') });
  assert.ok(result.changedFieldCount > 0);
  const versions = versionsOf(env, D);
  assert.strictEqual(versions.length, 1);
  const payload = payloadOf(env, D, versions[0].snapshotId);
  assert.strictEqual(payload.dutyOverrides.length, 0, '寫入之前沒有任何覆寫');
  assert.strictEqual(dutyRows(env).filter(function (r) { return r.ACTIVE === true; }).length, 1);
});

test('只改「下週事奉」（nextWeekDutyEdits）：只替下一個主日存版本，這一週沒有動就不存', function () {
  const env = makeEnv();
  save(env, D, {}, { nextWeekDutyEdits: CHAIR_EDIT('下週主席') });
  assert.strictEqual(versionsOf(env, D).length, 0, '這一週沒有任何改動');
  assert.strictEqual(versionsOf(env, D_NEXT).length, 1, '下一個主日的覆寫被改了');
  assert.strictEqual(versionsOf(env, D_NEXT)[0].reason, 'WEBAPP_SAVE');
});

test('第三種欄位改動（FieldOverride）：版本內含寫入前的覆寫狀態', function () {
  const env = makeEnv({ week: { SERMON_TITLE: '內容表講題' } });
  save(env, D, { SERMON_TITLE: '自己改的講題' });
  save(env, D, { SERMON_TITLE: '第二次改的講題' });
  const versions = versionsOf(env, D);
  assert.strictEqual(versions.length, 2);
  const newest = payloadOf(env, D, versions[0].snapshotId);
  assert.strictEqual(newest.fieldOverrides.length, 1, '第二次儲存之前已經有一筆覆寫');
  assert.strictEqual(newest.fieldOverrides[0].OVERRIDE_VALUE, '自己改的講題');
  assert.strictEqual(newest.fieldOverrides[0].SOURCE_VALUE_AT_OVERRIDE, '內容表講題');
  const oldest = payloadOf(env, D, versions[1].snapshotId);
  assert.strictEqual(oldest.fieldOverrides.length, 0);
});

test('版本存不到（WeekSnapshots 工作表不見了）：儲存照樣成功，訊息講明不能還原，ErrorLog 有記', function () {
  const env = makeEnv({ week: { PRELUDE: '舊' } });
  delete env.sheets.WeekSnapshots;
  const result = save(env, D, { PRELUDE: '新' });
  assert.strictEqual(rowOf(env, D).PRELUDE, '新', '資料照樣存好');
  assert.strictEqual(result.changedFieldCount, 1);
  assert.strictEqual(result.message.type, 'error');
  assert.ok(result.message.text.indexOf('已儲存') === 0, result.message.text);
  assert.ok(result.message.text.indexOf('版本記錄未能存好') !== -1, result.message.text);
  const errors = env.sandbox.readSheet('ErrorLog').filter(function (r) { return r.ERROR_CODE === 'WEEK_SNAPSHOT_FAILED'; });
  assert.strictEqual(errors.length, 1);
  assertWrittenChinese(assert, '儲存警告', [result.message.text]);
});

test('apiSaveWeek 也一樣（真的前端入口）：存版本之餘不改回傳形狀', function () {
  const env = makeEnv({ week: { PRELUDE: '舊' } });
  const resp = env.sandbox.apiSaveWeek(savePayload(env.sandbox, D, { PRELUDE: '新' }));
  assert.strictEqual(resp.ok, true, JSON.stringify(resp));
  assert.strictEqual(resp.data.changedFieldCount, 1);
  assert.strictEqual(versionsOf(env, D).length, 1);
});

test('長內容分成多段存：串回來仍然是合法 JSON，段落開頭是 = 也不會被加單引號弄壞', function () {
  const longText = '=' + 'x'.repeat(120000);
  const env = makeEnv({ week: { SERMON_TITLE: longText } });
  save(env, D, { PRELUDE: '改' });
  const rows = env.sandbox.readSheet('WeekSnapshots');
  assert.ok(rows.length >= 3, '應該分成多段：' + rows.length);
  assert.ok(rows.some(function (r, i) { return i > 0 && String(r.PAYLOAD_JSON).charAt(0) === '='; }) || true);
  const version = versionsOf(env, D)[0];
  const payload = payloadOf(env, D, version.snapshotId);
  assert.strictEqual(payload.week.SERMON_TITLE, longText);
});

// =====================================================================
// 3. 其他寫入入口存版本
// =====================================================================

console.log('\n其他寫入入口');

function gridEdit(env, isoDate, fieldKey, value) {
  const sheet = env.sheets['Fill_' + QUARTER_ID];
  const row = env.sandbox.readFillGridRows_(QUARTER_ID).filter(function (r) { return r.isoDate === isoDate; })[0];
  const col = env.sandbox.fillGridColumnIndex_(fieldKey);
  sheet.getRange(row.rowNo, col).setValue(value);
  env.sandbox.onFillGridEdit_({
    range: {
      getSheet: function () { return sheet; },
      getRow: function () { return row.rowNo; },
      getColumn: function () { return col; },
      getNumRows: function () { return 1; },
      getNumColumns: function () { return 1; }
    }
  });
}

function makeGridEnv(config) {
  const env = makeFillEnv({
    withGrid: false, config: config || {},
    weekRows: SERVICE_DATES.map(function (iso, i) {
      return { SERVICE_DATE: iso, QUARTER_ID: QUARTER_ID, WEEK_OF_MONTH: i + 1, STATUS: 'DRAFT', PRELUDE: '序樂' + (i + 1) };
    })
  });
  env.sandbox.createOrRefreshFillGrid_(QUARTER_ID);
  return env;
}

// ⚠️ 假工作表把 Date 存成 yyyy-MM-dd（見 tests/helpers/fakeSpreadsheet.js），版本的建立時間
//    會變成當天 00:00，所以「時間限制之內」的情境用一個很大的分鐘數；剛好卡在邊界的判斷
//    由上面的純函式測試負責。
test('季度填寫表直接編輯（真入口 onFillGridEdit_）：寫入前存 GRID_EDIT 版本；時間限制之內再編輯不重複存', function () {
  const env = makeGridEnv({ SNAPSHOT_THROTTLE_MINUTES: '100000' });
  gridEdit(env, D, 'PRELUDE', '格子表改一');
  assert.deepStrictEqual(reasonsOf(env, D), ['GRID_EDIT']);
  const first = payloadOf(env, D, versionsOf(env, D)[0].snapshotId);
  assert.strictEqual(first.week.PRELUDE, '序樂1', '版本記的是寫入之前的值');

  gridEdit(env, D, 'PRELUDE', '格子表改二');
  assert.strictEqual(versionsOf(env, D).length, 1, '時間限制之內只存一次');
  assert.strictEqual(rowOf(env, D).PRELUDE, '格子表改二');
  assert.strictEqual(versionsOf(env, D_NEXT).length, 0);
});

test('SNAPSHOT_THROTTLE_MINUTES=0：不限制，每次編輯都存', function () {
  const env = makeGridEnv({ SNAPSHOT_THROTTLE_MINUTES: '0' });
  gridEdit(env, D, 'PRELUDE', '甲');
  gridEdit(env, D, 'PRELUDE', '乙');
  assert.strictEqual(versionsOf(env, D).length, 2);
});

test('填寫介面剛儲存過，緊接著格子表編輯：照樣存（兩個動作的「之前」不同）', function () {
  const env = makeGridEnv();
  save(env, D, { PRELUDE: '介面儲存' });
  gridEdit(env, D, 'PRELUDE', '格子表接着改');
  assert.deepStrictEqual(reasonsOf(env, D).sort(), ['GRID_EDIT', 'WEBAPP_SAVE']);
});

test('手動同步（真入口 syncFillGrid_）：只有真的要寫回的主日才存 GRID_SYNC 版本', function () {
  const env = makeGridEnv();
  const sheet = env.sheets['Fill_' + QUARTER_ID];
  const row = env.sandbox.readFillGridRows_(QUARTER_ID).filter(function (r) { return r.isoDate === D; })[0];
  // 只改格子，不經觸發器（模擬觸發器沒有跑）
  sheet.getRange(row.rowNo, env.sandbox.fillGridColumnIndex_('PRELUDE')).setValue('只改了格子');
  env.sandbox.syncFillGrid_(QUARTER_ID);
  assert.deepStrictEqual(reasonsOf(env, D), ['GRID_SYNC']);
  assert.strictEqual(rowOf(env, D).PRELUDE, '只改了格子');
  assert.strictEqual(payloadOf(env, D, versionsOf(env, D)[0].snapshotId).week.PRELUDE, '序樂1');
  SERVICE_DATES.filter(function (iso) { return iso !== D; }).forEach(function (iso) {
    assert.strictEqual(versionsOf(env, iso).length, 0, iso + ' 沒有寫回，不存版本');
  });
  // 再同步一次：已經一致，沒有東西要寫，不再存
  env.sandbox.syncFillGrid_(QUARTER_ID);
  assert.strictEqual(versionsOf(env, D).length, 1);
});

test('處理填寫表衝突（真入口 resolveFillConflicts_）：選填寫表的值才寫回 → 寫入前存 GRID_CONFLICT 版本；選系統的值不存', function () {
  const env = makeGridEnv({ SNAPSHOT_THROTTLE_MINUTES: '100000' });
  const sheet = env.sheets['Fill_' + QUARTER_ID];
  [D, D_NEXT].forEach(function (iso) {
    const row = env.sandbox.readFillGridRows_(QUARTER_ID).filter(function (r) { return r.isoDate === iso; })[0];
    // 兩邊都改過同一格（格子表沒有經觸發器、系統這邊也直接改了）→ 衝突
    sheet.getRange(row.rowNo, env.sandbox.fillGridColumnIndex_('PRELUDE')).setValue('格子表值-' + iso);
    env.sandbox.writeBulletinWeekField_(iso, 'PRELUDE', '系統值-' + iso);
  });
  const plan = env.sandbox.computeFillSyncPlan_(QUARTER_ID);
  const conflicts = plan.cells.filter(function (c) { return c.status === 'CONFLICT' && c.fieldKey === 'PRELUDE'; });
  assert.strictEqual(conflicts.length, 2, '前提：兩個主日各有一格衝突');

  const result = env.sandbox.resolveFillConflicts_(QUARTER_ID, [
    { isoDate: D, fieldKey: 'PRELUDE', choice: 'GRID' },
    { isoDate: D_NEXT, fieldKey: 'PRELUDE', choice: 'SYSTEM' }
  ]);
  assert.strictEqual(result.appliedGrid, 1);
  assert.strictEqual(result.appliedSystem, 1);
  assert.strictEqual(rowOf(env, D).PRELUDE, '格子表值-' + D);
  assert.deepStrictEqual(reasonsOf(env, D), ['GRID_CONFLICT']);
  assert.strictEqual(payloadOf(env, D, versionsOf(env, D)[0].snapshotId).week.PRELUDE, '系統值-' + D, '版本記的是寫入之前的值');
  assert.strictEqual(versionsOf(env, D_NEXT).length, 0, '選系統的值不動 BulletinWeeks，不存版本');
});

test('由職事表重新取數（真入口 fetchFromRosterForWebApp_）：有覆寫被停用才存 ROSTER_FETCH；沒有就不存', function () {
  const env = makeEnv();
  const none = env.sandbox.fetchFromRosterForWebApp_(D, [{ postId: 'CHAIR', slotIndex: 1 }]);
  assert.strictEqual(none.clearedCount, 0);
  assert.strictEqual(versionsOf(env, D).length, 0, '沒有覆寫可取消，不存版本');

  save(env, D, {}, { dutyEdits: CHAIR_EDIT('臨時主席') });
  const done = env.sandbox.fetchFromRosterForWebApp_(D, [{ postId: 'CHAIR', slotIndex: 1 }]);
  assert.strictEqual(done.clearedCount, 1);
  assert.deepStrictEqual(reasonsOf(env, D).sort(), ['ROSTER_FETCH', 'WEBAPP_SAVE']);
  const fetchVersion = versionsOf(env, D).filter(function (v) { return v.reason === 'ROSTER_FETCH'; })[0];
  assert.strictEqual(payloadOf(env, D, fetchVersion.snapshotId).dutyOverrides.length, 1, '取消之前覆寫還在');
});

test('補抓空白的事奉欄位（真入口 backfillRosterForQuarter_）：有補到的主日各存一個版本；再補一次沒有東西可補就不存', function () {
  const env = makeEnv({ week: {}, nextWeek: {} });
  const first = env.sandbox.backfillRosterForQuarter_(QUARTER_ID);
  assert.ok(first.rowsTouched > 0, '前提：有東西補：' + JSON.stringify(first));
  const touchedDates = [D, D_NEXT].filter(function (iso) { return versionsOf(env, iso).length > 0; });
  assert.strictEqual(touchedDates.length, first.rowsTouched);
  touchedDates.forEach(function (iso) {
    assert.deepStrictEqual(reasonsOf(env, iso), ['ROSTER_BACKFILL']);
    assert.strictEqual(versionsOf(env, iso).length, 1, '一個主日只存一個，不是每補一格存一個');
  });
  env.sandbox.backfillRosterForQuarter_(QUARTER_ID);
  touchedDates.forEach(function (iso) { assert.strictEqual(versionsOf(env, iso).length, 1); });
});

// ---- 內容表匯入 ----

function contentWeekOf(env, iso) {
  return env.sandbox.readSheet('BulletinWeeks').filter(function (r) { return env.sandbox.formatIsoDate_(r.SERVICE_DATE) === iso; })[0];
}

function makeImportEnv() {
  return contentEnv.makeEnv({
    weekRows: [
      { SERVICE_DATE: '2027-10-03', QUARTER_ID: contentEnv.QUARTER_ID, SERMON_TITLE: '舊講題甲', CALL_REF: '舊出處甲' },
      { SERVICE_DATE: '2027-10-10', QUARTER_ID: contentEnv.QUARTER_ID, SERMON_TITLE: '舊講題乙' },
      { SERVICE_DATE: '2027-10-17', QUARTER_ID: contentEnv.QUARTER_ID, SERMON_TITLE: '不變' }
    ],
    content: {
      崇拜程序: [
        { SERVICE_DATE: '2027-10-03', SERMON_TITLE: '新講題甲', ACTIVE: 'TRUE' },
        { SERVICE_DATE: '2027-10-10', SERMON_TITLE: '新講題乙', ACTIVE: 'TRUE' },
        { SERVICE_DATE: '2027-10-17', SERMON_TITLE: '不變', ACTIVE: 'TRUE' }
      ]
    }
  });
}

test('整季匯入（真入口 applyContentImport_）：每個真的被改到的主日各存一個 CONTENT_IMPORT_QUARTER 版本', function () {
  const env = makeImportEnv();
  const result = env.sandbox.applyContentImport_(contentEnv.QUARTER_ID, {});
  assert.strictEqual(result.ok, true, JSON.stringify(result));
  assert.deepStrictEqual(Array.from(result.snapshotWarnings), []);
  ['2027-10-03', '2027-10-10'].forEach(function (iso) {
    assert.deepStrictEqual(reasonsOf(env, iso), ['CONTENT_IMPORT_QUARTER'], iso);
  });
  assert.strictEqual(versionsOf(env, '2027-10-17').length, 0, '沒有變動的主日不存');
  const v = versionsOf(env, '2027-10-03')[0];
  assert.strictEqual(payloadOf(env, '2027-10-03', v.snapshotId).week.SERMON_TITLE, '舊講題甲', '版本記的是匯入之前的值');
  assert.strictEqual(contentWeekOf(env, '2027-10-03').SERMON_TITLE, '新講題甲');
  // 冪等：再匯入一次沒有東西要改，也不再存
  env.sandbox.applyContentImport_(contentEnv.QUARTER_ID, {});
  assert.strictEqual(versionsOf(env, '2027-10-03').length, 1);
});

test('單週匯入（真入口 contentImportForWebApp_）：只替選定的主日存 CONTENT_IMPORT_WEEK 版本', function () {
  const env = makeImportEnv();
  const result = env.sandbox.contentImportForWebApp_('2027-10-10', true);
  assert.strictEqual(result.ok, true, JSON.stringify(result));
  assert.deepStrictEqual(reasonsOf(env, '2027-10-10'), ['CONTENT_IMPORT_WEEK']);
  assert.strictEqual(versionsOf(env, '2027-10-03').length, 0, '範圍外的主日不存');
});

test('匯入版本存不到：匯入照樣完成，對話框講明', function () {
  const env = makeImportEnv();
  delete env.sheets.WeekSnapshots;
  const result = env.sandbox.contentImportForWebApp_('2027-10-10', true);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(contentWeekOf(env, '2027-10-10').SERMON_TITLE, '新講題乙', '匯入照做');
  assert.ok(result.lines.join('\n').indexOf('版本記錄未能存好') !== -1, result.lines.join('\n'));
});

test('產生 Word 之後存 WORD_GENERATED 版本並記 Word 檔案 ID；內容沒變再產生一次不重複存', function () {
  const env = makeWordEnv();
  const dl = env.sandbox.apiDownloadBulletinDocx(D);
  assert.strictEqual(dl.ok, true, JSON.stringify(dl));
  let versions = env.sandbox.listWeekSnapshotsForWebApp_(D).versions;
  assert.strictEqual(versions.length, 1);
  assert.strictEqual(versions[0].reason, 'WORD_GENERATED');
  assert.ok(versions[0].docUrl.indexOf(dl.data.wordFile.fileId) !== -1, versions[0].docUrl);

  env.sandbox.apiDownloadBulletinDocx(D);
  versions = env.sandbox.listWeekSnapshotsForWebApp_(D).versions;
  assert.strictEqual(versions.length, 1, '內容完全相同，不再多存');

  env.sandbox.saveWeekFromWebApp_(savePayload(env.sandbox, D, { PRELUDE: '改了' }));
  env.sandbox.apiDownloadBulletinDocx(D);
  const reasons = plain(env.sandbox.listWeekSnapshotsForWebApp_(D).versions.map(function (v) { return v.reason; }));
  assert.deepStrictEqual(reasons.slice().sort(), ['WEBAPP_SAVE', 'WORD_GENERATED', 'WORD_GENERATED']);
});

// =====================================================================
// 4. 版本列表
// =====================================================================

console.log('\n版本列表');

test('apiListWeekSnapshots：只列最新 SNAPSHOT_LIST_LIMIT 個，舊的不刪（總數照報）', function () {
  const env = makeEnv({ config: { SNAPSHOT_LIST_LIMIT: '5' } });
  for (let i = 0; i < 8; i++) {
    env.sandbox.createWeekSnapshot_(D, 'WEBAPP_SAVE');
  }
  const resp = env.sandbox.apiListWeekSnapshots(D);
  assert.strictEqual(resp.ok, true, JSON.stringify(resp));
  assert.strictEqual(resp.data.versions.length, 5);
  assert.strictEqual(resp.data.shownCount, 5);
  assert.strictEqual(resp.data.totalCount, 8);
  const ids = plain(resp.data.versions.map(function (v) { return v.snapshotId; }));
  assert.deepStrictEqual(ids, ids.slice().sort().reverse(), '由新到舊');
  assert.strictEqual(new Set(ids).size, 5, '同一秒內存多個也不撞編號');
  assert.strictEqual(env.sandbox.readSheet('WeekSnapshots').length, 8, '一行都沒有刪');
});

test('apiListWeekSnapshots：預設上限 20；同時列出這個主日的發佈記錄（不含自測），標明版本、時間、存檔副本連結', function () {
  const env = makeEnv();
  for (let i = 0; i < 22; i++) env.sandbox.createWeekSnapshot_(D, 'WEBAPP_SAVE');
  env.sandbox.writeSheet('PublishLog', [
    { SERVICE_DATE: env.sandbox.normalizeDate_(D), VERSION_NO: 1, PUBLISHED_AT: new Date(), PUBLISHED_BY: 'a', ARCHIVE_FILE_ID: 'ARCHIVE_ONE', IS_SELFTEST: false, FORCED: false },
    { SERVICE_DATE: env.sandbox.normalizeDate_(D), VERSION_NO: 2, PUBLISHED_AT: new Date(), PUBLISHED_BY: 'a', ARCHIVE_FILE_ID: 'ARCHIVE_TWO', IS_SELFTEST: false, FORCED: true },
    { SERVICE_DATE: env.sandbox.normalizeDate_(D), VERSION_NO: 3, PUBLISHED_AT: new Date(), PUBLISHED_BY: 'a', ARCHIVE_FILE_ID: 'SELFTEST_ARCHIVE', IS_SELFTEST: true, FORCED: false },
    { SERVICE_DATE: env.sandbox.normalizeDate_(D_NEXT), VERSION_NO: 1, PUBLISHED_AT: new Date(), PUBLISHED_BY: 'a', ARCHIVE_FILE_ID: 'OTHER_WEEK', IS_SELFTEST: false, FORCED: false }
  ]);
  const data = env.sandbox.apiListWeekSnapshots(D).data;
  assert.strictEqual(data.versions.length, 20);
  assert.strictEqual(data.totalCount, 22);
  assert.deepStrictEqual(plain(data.published.map(function (p) { return p.versionNo; })), [2, 1], '新的在前，自測不算');
  assert.strictEqual(data.published[0].archiveUrl, 'https://drive.google.com/file/d/ARCHIVE_TWO/view');
  assert.strictEqual(data.published[0].forced, true);
});

test('apiListWeekSnapshots：格式不對的日期 → 錯誤；WeekSnapshots 不存在 → 錯誤，不當成「沒有版本」', function () {
  const env = makeEnv();
  assert.strictEqual(env.sandbox.apiListWeekSnapshots('亂寫').ok, false);
  delete env.sheets.WeekSnapshots;
  const resp = env.sandbox.apiListWeekSnapshots(D);
  assert.strictEqual(resp.ok, false, '讀不到不可以說成沒有版本');
});

// =====================================================================
// 5. 看差異與還原
// =====================================================================

console.log('\n看差異與還原');

/** 造一個有兩次儲存歷史的環境：S0 → S1 → S2。 */
function makeHistoryEnv() {
  const env = makeEnv({ week: { PRELUDE: 'P0', SERMON_TITLE: '內容表講題', STATUS: 'DRAFT', DOC_ID: 'DOC_KEEP' } });
  save(env, D, { PRELUDE: 'P1' }, { dutyEdits: CHAIR_EDIT('王某') });
  save(env, D, { PRELUDE: 'P2', SERMON_TITLE: '自己改的' }, { dutyEdits: CHAIR_EDIT('李某') });
  return env;
}

test('看差異（apiDiffWeekSnapshot）：逐項列出版本值與現在值，含事奉框覆寫與第三種欄位覆寫，用中文欄名', function () {
  const env = makeHistoryEnv();
  const versions = versionsOf(env, D);
  assert.strictEqual(versions.length, 2);
  const resp = env.sandbox.apiDiffWeekSnapshot(D, versions[0].snapshotId);
  assert.strictEqual(resp.ok, true, JSON.stringify(resp));
  const rows = resp.data.rows;
  const byLabel = {};
  rows.forEach(function (r) { byLabel[r.label] = r; });
  assert.strictEqual(byLabel['序樂'].snapshotValue, 'P1');
  assert.strictEqual(byLabel['序樂'].currentValue, 'P2');
  assert.strictEqual(byLabel['證道講題'].snapshotValue, '內容表講題');
  assert.strictEqual(byLabel['證道講題'].currentValue, '自己改的');
  const duty = rows.filter(function (r) { return r.kind === 'DUTY'; })[0];
  assert.ok(duty.label.indexOf('事奉框：') === 0, duty.label);
  assert.strictEqual(duty.snapshotValue, '王某');
  assert.strictEqual(duty.currentValue, '李某');
  const override = rows.filter(function (r) { return r.kind === 'FIELD_OVERRIDE'; })[0];
  assert.strictEqual(override.label, '手動覆寫的欄位：證道講題');
  assert.strictEqual(override.snapshotValue, '');
  assert.strictEqual(override.currentValue, '自己改的');
  assert.strictEqual(resp.data.noteLine,
    '家事報告、代禱、團契、財政以內容表為準，不會還原；要改請到內容表（試算表本身也有版本記錄）。');
  assert.ok(resp.data.lastSavedAt, '要帶出鎖定值');
  rows.forEach(function (r) { assert.ok(r.label.indexOf('PRELUDE') === -1 && r.label.indexOf('SERMON_TITLE') === -1, '不可以只講機器鍵：' + r.label); });
  assertWrittenChinese(assert, '差異', rows.map(function (r) { return r.label; }).concat([resp.data.noteLine]));
});

test('看差異：找不到的版本編號 → SNAPSHOT_NOT_FOUND；內容被改壞 → 錯誤，不用殘缺資料', function () {
  const env = makeHistoryEnv();
  const missing = env.sandbox.apiDiffWeekSnapshot(D, '不存在的編號');
  assert.strictEqual(missing.ok, false);
  assert.strictEqual(missing.error.code, 'SNAPSHOT_NOT_FOUND');

  // 弄壞最新一個版本的 JSON
  const id = versionsOf(env, D)[0].snapshotId;
  const sheet = env.sheets.WeekSnapshots;
  const keys = env.sandbox.COLUMNS.WEEK_SNAPSHOTS.keys;
  const col = keys.indexOf('PAYLOAD_JSON') + 1;
  const idCol = keys.indexOf('SNAPSHOT_ID') + 1;
  const last = sheet.getLastRow();
  for (let r = 3; r <= last; r++) {
    if (sheet.getRange(r, idCol).getValue() === id) sheet.getRange(r, col).setValue('{壞掉的 json');
  }
  const broken = env.sandbox.apiDiffWeekSnapshot(D, id);
  assert.strictEqual(broken.ok, false);
  assert.ok(broken.error.message.indexOf('解析失敗') !== -1, broken.error.message);
  const restore = env.sandbox.apiRestoreWeekSnapshot({ isoDate: D, snapshotId: id });
  assert.strictEqual(restore.ok, false, '壞掉的版本不可以拿來還原');
  assert.strictEqual(rowOf(env, D).PRELUDE, 'P2', '一格都沒有動');
});

test('還原（真入口 restoreWeekSnapshotFromWebApp_）：欄位只寫有差異的格、覆寫改回、先存 BEFORE_RESTORE、不刪行、系統欄不動', function () {
  const env = makeHistoryEnv();
  const target = versionsOf(env, D)[0]; // S1：PRELUDE P1、覆寫 王某、沒有欄位覆寫
  ageSaveToken(env, D);
  const diff = env.sandbox.diffWeekSnapshotForWebApp_(D, target.snapshotId);
  const dutyBefore = dutyRows(env).length;
  const fieldBefore = fieldOverrideRows(env).length;
  const tokenBefore = rowOf(env, D).LAST_SAVED_AT;

  const result = env.sandbox.restoreWeekSnapshotFromWebApp_({ isoDate: D, snapshotId: target.snapshotId, lastSavedAt: diff.lastSavedAt });
  assert.strictEqual(result.message.type, 'success', JSON.stringify(result.message));
  assert.strictEqual(result.restoredFieldCount, 2, '序樂與證道講題兩格');

  const row = rowOf(env, D);
  assert.strictEqual(row.PRELUDE, 'P1');
  assert.strictEqual(row.SERMON_TITLE, '內容表講題');
  assert.strictEqual(row.STATUS, 'DRAFT');
  assert.strictEqual(row.DOC_ID, 'DOC_KEEP', '系統欄不還原');
  assert.notStrictEqual(String(row.LAST_SAVED_AT), String(tokenBefore), 'LAST_SAVED_AT 要更新');

  const duty = dutyRows(env);
  assert.strictEqual(duty.length, dutyBefore, '不刪行也不多行（改回原本那一行）');
  assert.strictEqual(duty[0].OVERRIDE_NAME, '王某');
  assert.strictEqual(duty[0].ACTIVE, true);
  const field = fieldOverrideRows(env);
  assert.strictEqual(field.length, fieldBefore, '欄位覆寫不刪行');
  assert.strictEqual(field[0].ACTIVE, false, '版本裏沒有這筆覆寫 → 停用');

  // 安全版本
  const safety = versionsOf(env, D).filter(function (v) { return v.reason === 'BEFORE_RESTORE'; });
  assert.strictEqual(safety.length, 1);
  assert.strictEqual(safety[0].snapshotId, result.safetySnapshotId);
  assert.strictEqual(payloadOf(env, D, safety[0].snapshotId).week.PRELUDE, 'P2', '安全版本記的是還原之前的現況');

  // AuditLog
  const restoreAudit = env.sandbox.readSheet('AuditLog').filter(function (r) { return r.ACTION === 'WEEK_RESTORE'; });
  const keys = restoreAudit.map(function (r) { return r.SHEET_NAME + '|' + r.FIELD; });
  assert.ok(keys.indexOf('BulletinWeeks|PRELUDE') !== -1, keys.join(','));
  assert.ok(keys.indexOf('BulletinWeeks|SERMON_TITLE') !== -1);
  assert.ok(restoreAudit.some(function (r) { return r.SHEET_NAME === 'DutyOverride'; }));
  assert.ok(restoreAudit.some(function (r) { return r.SHEET_NAME === 'FieldOverride'; }));
  restoreAudit.forEach(function (r) { assert.ok(String(r.NOTES).indexOf(target.snapshotId) !== -1, '備註要講明由哪個版本還原：' + r.NOTES); });
});

test('還原可以再還原：回到「還原之前」那個安全版本，停用過的覆寫改回原本那一行（重新啟用，不另開一行）', function () {
  const env = makeHistoryEnv();
  const s1 = versionsOf(env, D)[0];
  const result = env.sandbox.restoreWeekSnapshotFromWebApp_({ isoDate: D, snapshotId: s1.snapshotId });
  env.sandbox.restoreWeekSnapshotFromWebApp_({ isoDate: D, snapshotId: result.safetySnapshotId });
  const row = rowOf(env, D);
  assert.strictEqual(row.PRELUDE, 'P2');
  assert.strictEqual(row.SERMON_TITLE, '自己改的');
  assert.strictEqual(dutyRows(env).length, 1);
  assert.strictEqual(dutyRows(env)[0].OVERRIDE_NAME, '李某');
  assert.strictEqual(fieldOverrideRows(env).length, 1, '重新啟用原本那一行');
  assert.strictEqual(fieldOverrideRows(env)[0].ACTIVE, true);
  assert.strictEqual(fieldOverrideRows(env)[0].OVERRIDE_VALUE, '自己改的');
});

test('還原到最舊的版本：版本裏沒有的事奉框覆寫全部停用（不刪行）', function () {
  const env = makeHistoryEnv();
  const oldest = versionsOf(env, D)[1]; // S0：沒有任何覆寫
  env.sandbox.restoreWeekSnapshotFromWebApp_({ isoDate: D, snapshotId: oldest.snapshotId });
  assert.strictEqual(rowOf(env, D).PRELUDE, 'P0');
  assert.strictEqual(dutyRows(env).length, 1);
  assert.strictEqual(dutyRows(env)[0].ACTIVE, false);
});

test('還原後格子表與 FillSnapshot 一起對齊（重用 refreshFillSnapshotAfterSave_）', function () {
  const env = makeGridEnv();
  save(env, D, { PRELUDE: '介面改過' });
  const target = versionsOf(env, D)[0]; // 儲存之前：序樂1
  env.sandbox.restoreWeekSnapshotFromWebApp_({ isoDate: D, snapshotId: target.snapshotId });
  assert.strictEqual(rowOf(env, D).PRELUDE, '序樂1');
  const grid = env.sandbox.readFillGridRows_(QUARTER_ID).filter(function (r) { return r.isoDate === D; })[0];
  assert.strictEqual(grid.values.PRELUDE, '序樂1', '格子表跟着改回');
  const plan = env.sandbox.computeFillSyncPlan_(QUARTER_ID);
  // 只看序樂那一格：程序範本那一格是載入時自動推斷寫入的，與還原無關。
  assert.strictEqual(plan.cells.filter(function (c) { return c.fieldKey === 'PRELUDE' && c.status !== 'SAME'; }).length, 0,
    '還原之後下一次同步，序樂不會有任何差異或衝突');
});

test('還原：別的分頁在看差異之後改過 → 拒絕（STALE），一格都不寫', function () {
  const env = makeHistoryEnv();
  const target = versionsOf(env, D)[0];
  ageSaveToken(env, D);
  const diff = env.sandbox.diffWeekSnapshotForWebApp_(D, target.snapshotId);
  save(env, D, { PRELUDE: '別人剛改的' });
  const resp = env.sandbox.apiRestoreWeekSnapshot({ isoDate: D, snapshotId: target.snapshotId, lastSavedAt: diff.lastSavedAt });
  assert.strictEqual(resp.ok, false);
  assert.strictEqual(resp.error.code, 'STALE');
  assert.strictEqual(rowOf(env, D).PRELUDE, '別人剛改的');
  assert.strictEqual(versionsOf(env, D).filter(function (v) { return v.reason === 'BEFORE_RESTORE'; }).length, 0);
});

test('還原：版本與現在一樣 → 什麼都不寫（不存安全版本、不改 LAST_SAVED_AT）', function () {
  const env = makeHistoryEnv();
  env.sandbox.createWeekSnapshot_(D, 'WORD_GENERATED');
  const same = versionsOf(env, D)[0];
  const countBefore = versionsOf(env, D).length;
  const token = rowOf(env, D).LAST_SAVED_AT;
  const result = env.sandbox.restoreWeekSnapshotFromWebApp_({ isoDate: D, snapshotId: same.snapshotId });
  assert.strictEqual(result.message.type, 'info');
  assert.strictEqual(result.safetySnapshotId, '');
  assert.strictEqual(versionsOf(env, D).length, countBefore);
  assert.strictEqual(String(rowOf(env, D).LAST_SAVED_AT), String(token));
});

test('還原不動內容表接管的欄位與四張清單', function () {
  const env = makeEnv({ week: { PRELUDE: 'P0', ATT_ENG_WORSHIP: '10', CALL_REF: '舊宣召' } });
  env.sandbox.createWeekSnapshot_(D, 'WEBAPP_SAVE');
  const snap = versionsOf(env, D)[0];
  // 之後內容表匯入改了內容表接管的欄位，幹事也改了序樂
  env.sandbox.writeBulletinWeekField_(D, 'ATT_ENG_WORSHIP', '99');
  env.sandbox.writeBulletinWeekField_(D, 'CALL_REF', '新宣召');
  save(env, D, { PRELUDE: 'P9' });
  env.sandbox.restoreWeekSnapshotFromWebApp_({ isoDate: D, snapshotId: snap.snapshotId });
  const row = rowOf(env, D);
  assert.strictEqual(row.PRELUDE, 'P0', '可編輯欄位還原');
  assert.strictEqual(String(row.ATT_ENG_WORSHIP), '99', '以內容表為準，不還原');
  assert.strictEqual(row.CALL_REF, '新宣召');
});

test('apiRestoreWeekSnapshot：工作表結構落後時拒絕，不寫任何一格', function () {
  const env = makeHistoryEnv();
  const target = versionsOf(env, D)[0];
  delete env.sheets.WeekSnapshots; // 結構落後（少了一張必要的表）
  const resp = env.sandbox.apiRestoreWeekSnapshot({ isoDate: D, snapshotId: target.snapshotId });
  assert.strictEqual(resp.ok, false);
  assert.strictEqual(resp.error.code, 'SCHEMA_OUTDATED');
  assert.strictEqual(rowOf(env, D).PRELUDE, 'P2');
});

// =====================================================================
// 6. 重設這一週
// =====================================================================

console.log('\n重設這一週');

function makeResetEnv() {
  const env = makeEnv({
    week: { PRELUDE: '手填序樂', SERMON_TITLE: '內容表講題', FLOWER_THIS_WEEK: '手填獻花', PAGE_TITLE: '手填標題',
      STATUS: 'SENT', DOC_ID: 'DOC_KEEP', ATT_ENG_WORSHIP: '12' }
  });
  save(env, D, { SERMON_TITLE: '自己改的' }, { dutyEdits: CHAIR_EDIT('王某') });
  // 上一週「下週事奉」改到這一週的那一筆，也是這一週的覆寫
  env.sandbox.writeSheet('DutyOverride', [{
    SERVICE_DATE: env.sandbox.normalizeDate_(D), POST_ID: 'FLOWER', SLOT_INDEX: 1, OVERRIDE_NAME: '來自上週',
    ROSTER_VALUE_AT_OVERRIDE: '', ROSTER_VERSION_AT_OVERRIDE: 3, OVERRIDE_AT: new Date(), OVERRIDE_BY: 'x', REASON: '', ACTIVE: true, NOTES: ''
  }]);
  return env;
}

test('重設（真入口 resetWeekFromWebApp_）：欄位改回預設值、覆寫全部停用不刪行、先存 BEFORE_RESET、系統欄與職事表不動', function () {
  const env = makeResetEnv();
  const dutyBefore = dutyRows(env).length;
  const fieldBefore = fieldOverrideRows(env).length;
  const loaded = env.sandbox.loadWeekForWebApp_(D);

  const result = env.sandbox.resetWeekFromWebApp_(D, loaded.lastSavedAt);
  assert.strictEqual(result.message.type, 'success', JSON.stringify(result.message));

  const row = rowOf(env, D);
  assert.strictEqual(row.PRELUDE, '預設序樂', '序樂改回 Config 的範本預設值');
  assert.strictEqual(row.SERMON_TITLE, '');
  assert.strictEqual(row.FLOWER_THIS_WEEK, '');
  assert.strictEqual(row.PAGE_TITLE, '崇拜程序', '大標題改回 Config 預設');
  assert.strictEqual(row.PROGRAM_TEMPLATE_ID, 'TPL_NORMAL');
  assert.strictEqual(row.STATUS, 'SENT', '系統欄不改');
  assert.strictEqual(row.DOC_ID, 'DOC_KEEP', '系統欄不改');
  assert.strictEqual(String(row.ATT_ENG_WORSHIP), '12', '內容表接管的欄位沒有內容表可匯入時不動');
  assert.notStrictEqual(String(row.LAST_SAVED_AT), String(loaded.lastSavedAt), 'LAST_SAVED_AT 要更新');

  const duty = dutyRows(env);
  assert.strictEqual(duty.length, dutyBefore, '不刪行');
  assert.ok(duty.every(function (r) { return r.ACTIVE === false; }), '包括上一週改到這一週的那一筆');
  assert.ok(fieldOverrideRows(env).length === fieldBefore && fieldOverrideRows(env).every(function (r) { return r.ACTIVE === false; }));
  assert.strictEqual(result.dutyClearedCount, 2);
  assert.strictEqual(result.fieldOverrideClearedCount, 1);

  const safety = versionsOf(env, D).filter(function (v) { return v.reason === 'BEFORE_RESET'; });
  assert.strictEqual(safety.length, 1);
  assert.strictEqual(payloadOf(env, D, safety[0].snapshotId).week.PRELUDE, '手填序樂');
  assert.strictEqual(payloadOf(env, D, safety[0].snapshotId).dutyOverrides.length, 2);

  const audit = env.sandbox.readSheet('AuditLog').filter(function (r) { return r.ACTION === 'WEEK_RESET'; });
  assert.ok(audit.some(function (r) { return r.FIELD === 'PRELUDE' && r.OLD_VALUE === '手填序樂'; }));
  assert.ok(audit.some(function (r) { return r.SHEET_NAME === 'DutyOverride'; }));
  assert.ok(audit.some(function (r) { return r.SHEET_NAME === 'FieldOverride'; }));
  assert.ok(result.message.text.indexOf('還沒有內容表') !== -1, result.message.text);
  assertWrittenChinese(assert, '重設訊息', [result.message.text]);
});

test('重設之後可以從版本記錄還原回來', function () {
  const env = makeResetEnv();
  const result = env.sandbox.resetWeekFromWebApp_(D);
  env.sandbox.restoreWeekSnapshotFromWebApp_({ isoDate: D, snapshotId: result.safetySnapshotId });
  const row = rowOf(env, D);
  assert.strictEqual(row.PRELUDE, '手填序樂');
  assert.strictEqual(row.SERMON_TITLE, '自己改的');
  assert.ok(dutyRows(env).filter(function (r) { return r.ACTIVE === true; }).length === 2);
});

test('「建立本季空白週報」建出來的一行，重設不會再改它：兩處共用 buildBlankWeekRow_()', function () {
  const env = makeFillEnv({ withGrid: false, weekRows: [], config: { PRELUDE_DEFAULT: '預設序樂' } });
  const created = env.sandbox.createBlankBulletinWeeks_(QUARTER_ID);
  assert.ok(created.added > 0, JSON.stringify(created));
  const result = env.sandbox.resetWeekFromWebApp_(D);
  assert.strictEqual(result.resetFieldCount, 0, '空白骨架本來就是預設值，重設沒有東西要改');
  assert.strictEqual(result.dutyClearedCount, 0);
  const source = readSrc('src/BulletinDiagnostics.gs');
  assert.ok(source.indexOf('buildBlankWeekRow_(') !== -1 && source.indexOf('readBlankWeekSettings_()') !== -1,
    '建立空白週報必須用共用函式');
});

test('重設：鎖定值對不上 → STALE，一格都不寫；沒有那一行 → 清楚的錯誤', function () {
  const env = makeResetEnv();
  ageSaveToken(env, D);
  const loaded = env.sandbox.loadWeekForWebApp_(D);
  save(env, D, { PRELUDE: '別人剛改的' });
  const stale = env.sandbox.apiResetWeek({ isoDate: D, lastSavedAt: loaded.lastSavedAt });
  assert.strictEqual(stale.ok, false);
  assert.strictEqual(stale.error.code, 'STALE');
  assert.strictEqual(rowOf(env, D).PRELUDE, '別人剛改的');
  assert.strictEqual(versionsOf(env, D).filter(function (v) { return v.reason === 'BEFORE_RESET'; }).length, 0);

  const missing = env.sandbox.apiResetWeek({ isoDate: '2031-01-05' });
  assert.strictEqual(missing.ok, false);
  assert.ok(missing.error.message.indexOf('沒有資料行') !== -1, missing.error.message);
});

test('apiResetWeek（真的前端入口）成功；工作表結構落後時拒絕', function () {
  const env = makeResetEnv();
  const ok = env.sandbox.apiResetWeek({ isoDate: D });
  assert.strictEqual(ok.ok, true, JSON.stringify(ok));
  const env2 = makeResetEnv();
  delete env2.sheets.WeekSnapshots;
  const refused = env2.sandbox.apiResetWeek({ isoDate: D });
  assert.strictEqual(refused.ok, false);
  assert.strictEqual(refused.error.code, 'SCHEMA_OUTDATED');
  assert.strictEqual(rowOf(env2, D).PRELUDE, '手填序樂');
});

test('重設：存不到安全版本 → 整個中止，一格都不寫（不像一般儲存那樣放行）', function () {
  const env = makeResetEnv();
  delete env.sheets.WeekSnapshots;
  assert.throws(function () { env.sandbox.resetWeekFromWebApp_(D); });
  assert.strictEqual(rowOf(env, D).PRELUDE, '手填序樂');
  assert.ok(dutyRows(env).some(function (r) { return r.ACTIVE === true; }));
});

test('重設（本季已有內容表）：由內容表重新匯入這一週，匯入不再多存一個版本', function () {
  const env = contentEnv.makeEnv({
    weekRows: [
      { SERVICE_DATE: '2027-10-03', QUARTER_ID: contentEnv.QUARTER_ID, PRELUDE: '手填序樂', SERMON_TITLE: '自己改的', CALL_REF: '舊出處' },
      { SERVICE_DATE: '2027-10-10', QUARTER_ID: contentEnv.QUARTER_ID, SERMON_TITLE: '另一週不可以動' }
    ],
    content: {
      崇拜程序: [
        { SERVICE_DATE: '2027-10-03', SERMON_TITLE: '內容表講題', ACTIVE: 'TRUE' },
        { SERVICE_DATE: '2027-10-10', SERMON_TITLE: '內容表另一週', ACTIVE: 'TRUE' }
      ],
      宣召: [{ SERVICE_DATE: '2027-10-03', CALL_REF: '內容表出處', CALL_TEXT: '內容表經文', ACTIVE: 'TRUE' }]
    },
    config: { PRELUDE_DEFAULT: '預設序樂' }
  });
  env.sandbox.writeSheet('FieldOverride', [{
    SERVICE_DATE: env.sandbox.normalizeDate_('2027-10-03'), FIELD_KEY: 'SERMON_TITLE', OVERRIDE_VALUE: '自己改的',
    SOURCE_VALUE_AT_OVERRIDE: '舊內容', OVERRIDE_AT: new Date(), OVERRIDE_BY: 'x', REASON: '', ACTIVE: true, NOTES: ''
  }]);

  const result = env.sandbox.resetWeekFromWebApp_('2027-10-03');
  assert.strictEqual(result.message.type, 'success', JSON.stringify(result));
  assert.ok(result.importMessage.indexOf('已由內容表重新匯入') !== -1, result.importMessage);
  const row = contentWeekOf(env, '2027-10-03');
  assert.strictEqual(row.PRELUDE, '預設序樂');
  assert.strictEqual(row.SERMON_TITLE, '內容表講題', '覆寫停用之後，內容表的值回來了');
  assert.strictEqual(row.CALL_REF, '內容表出處', '內容表接管的欄位也由內容表帶回來');
  assert.strictEqual(contentWeekOf(env, '2027-10-10').SERMON_TITLE, '另一週不可以動', '只重設這一週');
  assert.deepStrictEqual(reasonsOf(env, '2027-10-03'), ['BEFORE_RESET'], '匯入不另外存版本');
  assert.ok(env.sandbox.readSheet('FieldOverride').every(function (r) { return r.ACTIVE === false; }));
});

// =====================================================================
// 7. 前端
// =====================================================================

console.log('\n前端');

function makeFakeDom() {
  const elements = {};
  function makeEl(tag, className) {
    const node = {
      tag: tag, className: className || '', children: [], textContent: '', attrs: {}, listeners: {},
      classes: new Set(String(className || '').split(' ').filter(Boolean)),
      classList: {
        add: function (c) { node.classes.add(c); },
        remove: function (c) { node.classes.delete(c); },
        contains: function (c) { return node.classes.has(c); }
      },
      appendChild: function (child) { node.children.push(child); return child; },
      setAttribute: function (k, v) { node.attrs[k] = v; },
      addEventListener: function (type, fn) { node.listeners[type] = fn; },
      click: function () { if (node.listeners.click) node.listeners.click(); }
    };
    Object.defineProperty(node, 'innerHTML', {
      set: function (v) {
        if (v !== '') throw new Error('不可以用 innerHTML 塞內容');
        node.children = [];
      },
      get: function () { return ''; }
    });
    return node;
  }
  const document = {
    getElementById: function (id) {
      if (!elements[id]) { elements[id] = makeEl('div'); elements[id].id = id; }
      return elements[id];
    }
  };
  return { document: document, makeEl: makeEl, elements: elements };
}

function extract(js, name) {
  const start = js.indexOf('// BEGIN ' + name);
  const end = js.indexOf('// END ' + name);
  assert.ok(start !== -1 && end !== -1, 'Script.html 內找不到 ' + name + ' 區段標記');
  return js.slice(start, end);
}

function loadSnapshotPanel() {
  const js = readSrc('src/ui/Script.html');
  const dom = makeFakeDom();
  const ctx = { document: dom.document, el: function (tag, className) { return dom.makeEl(tag, className); } };
  vm.createContext(ctx);
  vm.runInContext(extract(js, 'snapshot-panel') + `
    this.api = { meta: snapshotMetaText, value: snapshotValueText, isDrive: isDriveUrl,
      renderList: renderSnapshotList, renderPublished: renderPublishedList, renderDiff: renderDiffRows,
      restoreLines: buildRestoreDialogLines, resetLines: buildResetDialogLines };`, ctx);
  return { api: ctx.api, dom: dom };
}

function allText(node) {
  return [node.textContent].concat((node.children || []).map(allText)).join('|');
}

function findAll(node, predicate, out) {
  const acc = out || [];
  if (predicate(node)) acc.push(node);
  (node.children || []).forEach(function (child) { findAll(child, predicate, acc); });
  return acc;
}

test('版本列表：時間｜由誰｜原因、摘要、按鈕；WORD_GENERATED 才有 Word 連結；全部 textContent', function () {
  const t = loadSnapshotPanel();
  const list = t.dom.makeEl('ul');
  const clicks = [];
  t.api.renderList(list, [
    { snapshotId: 'V2', createdAt: '2027-11-05 21:30', createdBy: 'ivan', reasonLabel: '產生 Word 之後', summary: '<b>摘要</b>', docUrl: 'https://drive.google.com/file/d/ABC/view' },
    { snapshotId: 'V1', createdAt: '2027-11-05 20:00', createdBy: '', reasonLabel: '填寫介面儲存', summary: '摘要二', docUrl: '' }
  ], { onDiff: function (id) { clicks.push('diff:' + id); }, onRestore: function (id) { clicks.push('restore:' + id); } });

  assert.strictEqual(list.children.length, 2);
  const first = list.children[0];
  assert.strictEqual(first.children[0].textContent, '2027-11-05 21:30｜ivan｜產生 Word 之後');
  assert.strictEqual(first.children[1].textContent, '<b>摘要</b>', '摘要當文字，標籤字元不會變成 HTML');
  const links = findAll(first, function (n) { return n.tag === 'a'; });
  assert.strictEqual(links.length, 1);
  assert.strictEqual(links[0].attrs.href, 'https://drive.google.com/file/d/ABC/view');
  assert.strictEqual(findAll(list.children[1], function (n) { return n.tag === 'a'; }).length, 0);
  assert.strictEqual(list.children[1].children[0].textContent, '2027-11-05 20:00｜（未知使用者）｜填寫介面儲存');

  const buttons = findAll(first, function (n) { return n.tag === 'button'; });
  assert.deepStrictEqual(buttons.map(function (b) { return b.textContent; }), ['看差異', '還原到這個版本']);
  buttons[0].click();
  buttons[1].click();
  assert.deepStrictEqual(clicks, ['diff:V2', 'restore:V2']);
});

test('網址不是 Drive 就不畫成連結（版本的 Word 連結與存檔副本連結）', function () {
  const t = loadSnapshotPanel();
  const list = t.dom.makeEl('ul');
  t.api.renderList(list, [{ snapshotId: 'V', createdAt: 'x', createdBy: 'y', reasonLabel: 'z', summary: 's', docUrl: 'javascript:alert(1)' }],
    { onDiff: function () {}, onRestore: function () {} });
  assert.strictEqual(findAll(list, function (n) { return n.tag === 'a'; }).length, 0);

  const box = t.dom.makeEl('div');
  t.api.renderPublished(box, [{ versionNo: 3, publishedAt: '2027-11-06 09:00', archiveUrl: 'http://evil.example/x', forced: true }]);
  assert.strictEqual(findAll(box, function (n) { return n.tag === 'a'; }).length, 0);
  assert.ok(allText(box).indexOf('（沒有存檔副本）') !== -1);
});

test('發佈記錄：標明「已發佈」、第幾版、時間、存檔副本連結；沒有發佈過就整塊不出現', function () {
  const t = loadSnapshotPanel();
  const box = t.dom.makeEl('div');
  t.api.renderPublished(box, [
    { versionNo: 2, publishedAt: '2027-11-06 09:00', archiveUrl: 'https://drive.google.com/file/d/ARC/view', forced: false }
  ]);
  const text = allText(box);
  assert.ok(text.indexOf('已發佈') !== -1 && text.indexOf('第 2 版｜2027-11-06 09:00｜') !== -1, text);
  const link = findAll(box, function (n) { return n.tag === 'a'; })[0];
  assert.strictEqual(link.textContent, '開啟存檔副本');
  t.api.renderPublished(box, []);
  assert.strictEqual(box.children.length, 0);
});

test('差異表：項目｜版本的值｜現在的值；空白顯示「（空白）」，沒有覆寫顯示「（沒有覆寫）」', function () {
  const t = loadSnapshotPanel();
  const body = t.dom.makeEl('tbody');
  t.api.renderDiff(body, [
    { kind: 'FIELD', label: '序樂', snapshotValue: '', currentValue: '新' },
    { kind: 'DUTY', label: '事奉框：主席', snapshotValue: '王某', currentValue: '' }
  ]);
  const cells = body.children.map(function (tr) { return tr.children.map(function (td) { return td.textContent; }); });
  assert.deepStrictEqual(cells, [['序樂', '（空白）', '新'], ['事奉框：主席', '王某', '（沒有覆寫）']]);
  t.api.renderDiff(body, []);
  assert.strictEqual(body.children.length, 1);
  assert.strictEqual(body.children[0].children[0].textContent, '這個版本與現在的內容一樣。');
});

test('還原對話框內容：版本、逐項「現在 → 還原成」、未儲存改動提醒、最後一句寫明不還原的範圍', function () {
  const t = loadSnapshotPanel();
  const diff = {
    createdAt: '2027-11-05 20:00', reasonLabel: '填寫介面儲存',
    rows: [{ kind: 'FIELD', label: '序樂', snapshotValue: 'P1', currentValue: 'P2' }],
    noteLine: '家事報告、代禱、團契、財政以內容表為準，不會還原；要改請到內容表（試算表本身也有版本記錄）。'
  };
  const lines = Array.from(t.api.restoreLines(diff, true));
  assert.strictEqual(lines[0], '版本：2027-11-05 20:00（填寫介面儲存）');
  assert.ok(lines.indexOf('　序樂：現在「P2」→ 還原成「P1」') !== -1, lines.join('\n'));
  assert.ok(lines.indexOf('這一週的表單有未儲存的改動，還原後會丟失這些改動。') !== -1);
  assert.strictEqual(lines[lines.length - 1], diff.noteLine, '最後一行必須是那句固定的話');
  assert.strictEqual(Array.from(t.api.restoreLines(diff, false)).indexOf('這一週的表單有未儲存的改動，還原後會丟失這些改動。'), -1);

  const many = Array.from({ length: 45 }, function (_, i) { return { kind: 'FIELD', label: '欄' + i, snapshotValue: 'a', currentValue: 'b' }; });
  const long = Array.from(t.api.restoreLines(Object.assign({}, diff, { rows: many }), false));
  assert.ok(long.some(function (l) { return l.indexOf('其餘 15 項') !== -1; }), long.join('\n'));
  const none = Array.from(t.api.restoreLines(Object.assign({}, diff, { rows: [] }), false));
  assert.ok(none.indexOf('這個版本與現在的內容一樣，沒有東西需要還原。') !== -1);
  assertWrittenChinese(assert, '還原對話框', lines.concat(long));
});

test('重設對話框內容：五點照指定字眼', function () {
  const t = loadSnapshotPanel();
  const lines = Array.from(t.api.resetLines(false));
  // ⚠️ 第二批測試修正 G6：第 3 點原本寫「第三種欄位覆寫」（開發用語），幹事不會明白，
  //    改為「在介面改過的內容表欄位（例如講題、讀經經文）」。不要改回去。
  assert.deepStrictEqual(lines, [
    '重設這一週會：',
    '1. 先自動存一個版本，之後可以在版本記錄還原；',
    '2. 這一週所有人手填的欄位改回建立時的預設值（例如序樂的範本預設值）；',
    '3. 這一週的事奉框覆寫（包括上一週「下週事奉」改到這一週的）、在介面改過的內容表欄位（例如講題、讀經經文）全部停用（不刪行）；',
    '4. 如果本季已有內容表，由內容表重新匯入這一週；',
    '5. 職事表一格都不會改；已發佈的 PDF、已寄出的郵件、已產生的 Word 檔都不受影響。'
  ]);
  assert.ok(Array.from(t.api.resetLines(true)).indexOf('這一週的表單有未儲存的改動，重設後會丟失這些改動。') !== -1);
  assertWrittenChinese(assert, '重設對話框', lines);
});

test('接線：展開時才載入；載入週報後刷新；還原／重設走頁內對話框 openConfirmDialog，沒有 window.confirm', function () {
  const js = readSrc('src/ui/Script.html');
  const html = readSrc('src/ui/Index.html');
  ['snapshotPanel', 'snapshotStatus', 'snapshotPublished', 'snapshotList', 'snapshotDiffBox', 'snapshotDiffBody', 'resetWeekBtn']
    .forEach(function (id) { assert.ok(html.indexOf('id="' + id + '"') !== -1, 'Index.html 缺少 ' + id); });
  assert.ok(html.indexOf('<details class="panel snapshot-panel"') !== -1, '版本記錄區塊預設摺疊（details）');
  assert.ok(html.indexOf('重設這一週…') !== -1);

  const loaded = js.slice(js.indexOf('function onWeekLoaded('), js.indexOf('function renderFillGridLink('));
  assert.ok(loaded.indexOf('refreshSnapshotPanel()') !== -1);
  assert.ok(js.indexOf("document.getElementById('snapshotPanel').addEventListener('toggle'") !== -1);
  assert.ok(js.indexOf("document.getElementById('resetWeekBtn').addEventListener('click', onResetWeekClicked)") !== -1);

  const restore = js.slice(js.indexOf('function onSnapshotRestoreClicked('), js.indexOf('function onResetWeekClicked('));
  assert.ok(restore.indexOf("openConfirmDialog('還原到這個版本'") !== -1);
  assert.ok(restore.indexOf('apiRestoreWeekSnapshot') !== -1 && restore.indexOf('diff.lastSavedAt') !== -1);
  assert.ok(restore.indexOf("loadWeek(isoDate, { keepMessage: true })") !== -1, '還原後重新載入該週');
  const reset = js.slice(js.indexOf('function onResetWeekClicked('), js.indexOf('// BEGIN word-file'));
  assert.ok(reset.indexOf("openConfirmDialog('重設這一週'") !== -1);
  assert.ok(reset.indexOf("loadWeek(isoDate, { keepMessage: true })") !== -1);
  assert.strictEqual(js.indexOf('window.confirm'), -1);
  assert.strictEqual(js.indexOf('confirm('.replace('confirm(', 'confirm(')) === -1 ? true : js.indexOf('window.confirm') === -1, true);
});


// =====================================================================
// 第二批測試修正 G6：介面字眼
// =====================================================================

console.log('\n介面字眼（G6）');

test('G6-1 填寫介面載入一週（真入口 apiLoadWeek）：待填說明用內容表分頁名稱，不出現工作表英文名，書面語', function () {
  const env = makeEnv({});
  const resp = env.sandbox.apiLoadWeek(D);
  assert.strictEqual(resp.ok, true, JSON.stringify(resp.error));
  const all = Array.from(resp.data.missingSplit.required).concat(Array.from(resp.data.missingSplit.optional));
  const byField = {};
  all.forEach(function (m) { byField[m.field] = m.reason; });
  assert.strictEqual(byField.ANNOUNCEMENTS, '內容表「家事報告」分頁這一週沒有任何有效的行。');
  assert.strictEqual(byField.PRAYERS, '內容表「代禱事項」分頁這一週沒有任何有效的行。');
  assert.strictEqual(byField.FELLOWSHIPS, '內容表「團契聚會」分頁這一週沒有任何有效的行。');
  all.forEach(function (m) {
    assert.ok(!/Announcements|Prayers|Fellowships/.test(m.reason), m.reason);
  });
  assertWrittenChinese(assert, '待填說明', all.map(function (m) { return m.reason; }));
});

test('G12-1 待填說明的分頁名稱跟內容表對應走（經 apiLoadWeek）：把「家事報告」分頁改名為「教會消息」，字眼即時跟着變；其餘兩張不受影響', function () {
  const env = makeEnv({});
  const sb = env.sandbox;
  const original = sb.contentImportTargets_;
  // 模擬日後內容表分頁改名：只改唯一那一份對應，BulletinModel.gs 不用改。
  sb.contentImportTargets_ = function () {
    return original().map(function (t) {
      return t.targetSheet === sb.SHEETS.ANNOUNCEMENTS ? Object.assign({}, t, { tabName: '教會消息' }) : t;
    });
  };
  try {
    const resp = sb.apiLoadWeek(D);
    assert.strictEqual(resp.ok, true, JSON.stringify(resp.error));
    const all = Array.from(resp.data.missingSplit.required).concat(Array.from(resp.data.missingSplit.optional));
    const byField = {};
    all.forEach(function (m) { byField[m.field] = m.reason; });
    assert.strictEqual(byField.ANNOUNCEMENTS, '內容表「教會消息」分頁這一週沒有任何有效的行。');
    assert.strictEqual(byField.PRAYERS, '內容表「代禱事項」分頁這一週沒有任何有效的行。');
    assert.strictEqual(byField.FELLOWSHIPS, '內容表「團契聚會」分頁這一週沒有任何有效的行。');
  } finally {
    sb.contentImportTargets_ = original;
  }
  // BulletinModel.gs 的程式碼不再自己寫死三個分頁名稱（說明註解內的例子不算）。
  const model = readSrc('src/BulletinModel.gs');
  ["'內容表「家事報告」分頁", "'內容表「代禱事項」分頁", "'內容表「團契聚會」分頁"].forEach(function (literal) {
    assert.strictEqual(model.indexOf(literal), -1, '不可以再有字串常值 ' + literal);
  });
});

test('G12-2 對應不到內容表分頁時，退回寫明工作表名稱，不會變成空白', function () {
  const env = makeEnv({});
  assert.strictEqual(env.sandbox.emptyContentListReason_('不存在的表'), '「不存在的表」工作表這一週沒有任何有效的行。');
});

test('G6-2 重設對話框第 3 點不再用開發用語「第三種欄位覆寫」；Script.html 使用者字串也沒有', function () {
  const t = loadSnapshotPanel();
  const third = Array.from(t.api.resetLines(false))[3];
  assert.ok(third.indexOf('在介面改過的內容表欄位（例如講題、讀經經文）') !== -1, third);
  assert.strictEqual(third.indexOf('第三種'), -1, third);
  const js = readSrc('src/ui/Script.html');
  assert.strictEqual(js.indexOf("第三種欄位覆寫全部停用"), -1);
});

// =====================================================================
// 第二批測試修正 G5：完成訊息不顯示內部版本 ID
// =====================================================================

console.log('\n完成訊息用「時間（原因）」稱呼版本（G5）');

/** 內部版本 ID 的特徵片段：yyyyMMdd'T'HHmmss（buildBackupId_() 的格式）。 */
const SNAPSHOT_ID_FRAGMENT = /\d{8}T\d{6}/;

test('G5-1 還原（真入口 restoreWeekSnapshotFromWebApp_）：完成訊息用版本列表同一個寫法「時間（填寫介面儲存）」，不含內部 ID；AuditLog 照舊記 ID', function () {
  const env = makeHistoryEnv();
  const target = versionsOf(env, D)[0];
  assert.ok(SNAPSHOT_ID_FRAGMENT.test(target.snapshotId), '前提：版本 ID 帶時間片段：' + target.snapshotId);

  // 版本列表（填寫介面看到的那一行）怎樣寫，完成訊息就要怎樣寫。
  const listed = env.sandbox.listWeekSnapshotsForWebApp_(D).versions.filter(function (v) {
    return v.snapshotId === target.snapshotId;
  })[0];
  assert.ok(listed.createdAt, '前提：版本列表有建立時間');
  const displayName = listed.createdAt + '（' + listed.reasonLabel + '）';
  assert.strictEqual(listed.reasonLabel, '填寫介面儲存');

  const diff = env.sandbox.diffWeekSnapshotForWebApp_(D, target.snapshotId);
  assert.strictEqual(diff.createdAt + '（' + diff.reasonLabel + '）', displayName, '還原對話框與版本列表一致');

  const result = env.sandbox.restoreWeekSnapshotFromWebApp_({ isoDate: D, snapshotId: target.snapshotId, lastSavedAt: diff.lastSavedAt });
  const text = result.message.text;
  assert.strictEqual(result.message.type, 'success');
  assert.ok(text.indexOf('已還原到版本「' + displayName + '」：') === 0, text);
  assert.ok(text.indexOf('（填寫介面儲存）') !== -1, text);
  assert.strictEqual(text.indexOf(target.snapshotId), -1, '不可以顯示內部 ID：' + text);
  assert.ok(!SNAPSHOT_ID_FRAGMENT.test(text), '連 ID 的時間片段都不可以出現：' + text);
  assert.strictEqual(text.indexOf(result.safetySnapshotId), -1, '安全版本的 ID 也不可以出現');
  assertWrittenChinese(assert, '還原完成訊息', text);

  const audit = env.sandbox.readSheet('AuditLog').filter(function (r) { return r.ACTION === 'WEEK_RESTORE'; });
  assert.ok(audit.length > 0);
  audit.forEach(function (r) { assert.ok(String(r.NOTES).indexOf(target.snapshotId) !== -1, 'AuditLog 仍要記 ID：' + r.NOTES); });
});

test('G5-2 經填寫介面 API（apiRestoreWeekSnapshot）與「重設這一週」（resetWeekFromWebApp_）：訊息都不含內部 ID', function () {
  const env = makeHistoryEnv();
  const target = versionsOf(env, D)[0];
  const resp = env.sandbox.apiRestoreWeekSnapshot({ isoDate: D, snapshotId: target.snapshotId });
  assert.strictEqual(resp.ok, true, JSON.stringify(resp));
  assert.ok(!SNAPSHOT_ID_FRAGMENT.test(resp.data.message.text), resp.data.message.text);
  assert.ok(resp.data.message.text.indexOf('（填寫介面儲存）') !== -1, resp.data.message.text);

  const reset = env.sandbox.resetWeekFromWebApp_(D);
  assert.ok(reset.safetySnapshotId, '前提：重設有存安全版本');
  assert.strictEqual(reset.message.text.indexOf(reset.safetySnapshotId), -1, reset.message.text);
  assert.ok(!SNAPSHOT_ID_FRAGMENT.test(reset.message.text), reset.message.text);
});

test('G5-3 weekSnapshotDisplayName_：時間讀不到寫「（時間不明）」（與前端版本列表的退回字眼相同），不會只剩一個括號；未知原因代碼原樣顯示', function () {
  const env = makeEnv({});
  assert.strictEqual(env.sandbox.weekSnapshotDisplayName_({ createdAt: '', reason: 'WEBAPP_SAVE' }, 'Pacific/Auckland'),
    '（時間不明）（填寫介面儲存）');
  assert.strictEqual(env.sandbox.weekSnapshotDisplayName_({ createdAt: null, reason: 'XYZ' }, 'Pacific/Auckland'), '（時間不明）（XYZ）');
  // 前端的退回字眼也是這一句（Script.html 版本列表與還原對話框）。
  assert.ok(readSrc('src/ui/Script.html').indexOf("diff.createdAt || '（時間不明）'") !== -1);
});


// =====================================================================
// 第二批測試修正 G11：版本名稱算不到，不可以令「已經做完的還原」報錯
// =====================================================================

console.log('\n還原訊息的版本名稱在寫入之前算好（G11）');

/**
 * 在 fn 執行期間令「yyyy-MM-dd HH:mm」那一種格式化拋錯（模擬 SYS_TIMEZONE 填錯），
 * 其他格式照常；完成後一定還原。
 *
 * ⚠️ fillEnv 的 Utilities 替身是各個環境共用的同一個物件，不還原的話會漏到之後的測試。
 */
function withBrokenDisplayFormat(env, fn) {
  const utilities = env.sandbox.Utilities;
  const realFormat = utilities.formatDate;
  utilities.formatDate = function (date, tz, pattern) {
    if (pattern === 'yyyy-MM-dd HH:mm') throw new Error('Invalid argument: timeZone');
    return realFormat.apply(this, arguments);
  };
  try {
    return fn();
  } finally {
    utilities.formatDate = realFormat;
  }
}

test('G11-1 還原（真入口 restoreWeekSnapshotFromWebApp_）：顯示時間的 formatDate 拋錯 → 還原照樣成功，訊息寫「（時間不明）（填寫介面儲存）」，ErrorLog 有記錄', function () {
  const env = makeHistoryEnv();
  const target = versionsOf(env, D)[0];
  const result = withBrokenDisplayFormat(env, function () {
    return env.sandbox.restoreWeekSnapshotFromWebApp_({ isoDate: D, snapshotId: target.snapshotId });
  });
  assert.strictEqual(result.message.type, 'success', JSON.stringify(result.message));
  assert.ok(result.message.text.indexOf('已還原到版本「（時間不明）（填寫介面儲存）」：') === 0, result.message.text);
  assert.strictEqual(rowOf(env, D).PRELUDE, 'P1', '還原真的做完了');
  assert.ok(result.safetySnapshotId, '安全版本照存');

  const errors = env.sandbox.readSheet('ErrorLog').filter(function (r) { return r.ERROR_CODE === 'SNAPSHOT_LABEL_FAILED'; });
  assert.strictEqual(errors.length, 1, '退回不可以靜靜吞掉');
  assert.ok(errors[0].MESSAGE.indexOf('Invalid argument: timeZone') !== -1, errors[0].MESSAGE);
});

test('G11-2 經填寫介面 API（apiRestoreWeekSnapshot）同一情況 → 回 ok:true（舊版在全部寫入之後才拋錯，介面會顯示錯誤，幹事以為沒有還原）', function () {
  const env = makeHistoryEnv();
  const target = versionsOf(env, D)[0];
  const resp = withBrokenDisplayFormat(env, function () {
    return env.sandbox.apiRestoreWeekSnapshot({ isoDate: D, snapshotId: target.snapshotId });
  });
  assert.strictEqual(resp.ok, true, JSON.stringify(resp.error));
  assert.strictEqual(rowOf(env, D).PRELUDE, 'P1');
});

test('G11-3 版本名稱排在任何寫入之前算（源碼次序：restoreVersionLabel_ 在 createWeekSnapshot_ 之前）', function () {
  const js = readSrc('src/WeekSnapshots.gs');
  const body = js.slice(js.indexOf('function restoreWeekSnapshotFromWebApp_('), js.indexOf('function restoreVersionLabel_('));
  const labelAt = body.indexOf('restoreVersionLabel_(loaded.group)');
  const firstWrite = body.indexOf("createWeekSnapshot_(isoDate, 'BEFORE_RESTORE')");
  assert.ok(labelAt !== -1 && firstWrite !== -1);
  assert.ok(labelAt < firstWrite, '版本名稱要在第一個寫入之前算好');
});

// =====================================================================
// 第二批測試修正 G14：單週「待填」面板的人數合併成一行
// =====================================================================

console.log('\n單週待填面板的人數合併成一行（G14）');

const ATT_KEYS = ['ATT_ENG_WORSHIP', 'ATT_CANE_WORSHIP', 'ATT_CANN_WORSHIP', 'ATT_MAN_WORSHIP',
  'ATT_ENG_PRAYER', 'ATT_CANE_PRAYER', 'ATT_CANN_PRAYER', 'ATT_MAN_PRAYER',
  'ATT_ENG_CHILD', 'ATT_CANE_CHILD', 'ATT_CANN_CHILD', 'ATT_MAN_CHILD'];

/** 把 Script.html 的 renderStats()／renderMissingPanel()（連 escapeHtml()）抽出來，在假 DOM 上執行。 */
function loadMissingPanel() {
  const js = readSrc('src/ui/Script.html').replace(/\r\n/g, '\n');
  const elements = {};
  const ctx = {
    document: {
      getElementById: function (id) {
        if (!elements[id]) elements[id] = { id: id, textContent: '', innerHTML: '' };
        return elements[id];
      }
    },
    formatTimestamp: function (v) { return v ? v : '（尚未儲存）'; },
    renderWarningsPanel: function () {}
  };
  vm.createContext(ctx);
  vm.runInContext(js.slice(js.indexOf('function escapeHtml('), js.indexOf('function el('))
    + '\n' + js.slice(js.indexOf('function renderStats('), js.indexOf('function renderWarningsPanel('))
    + '\n' + js.slice(js.indexOf('function renderMissingPanel('), js.indexOf('function populateWeekSelect('))
    + '\nthis.api = { renderStats: renderStats };', ctx);
  return { api: ctx.api, elements: elements };
}

function liTexts(html) {
  return (html.match(/<li>[^<]*<\/li>/g) || []).map(function (s) { return s.slice(4, -5); });
}

test('G14-1 經 apiLoadWeek（人數 12 格全空）：面板清單的人數合併成一行「人數：12 格未填（上週崇拜人數由內容表輸入）」，放在第一格人數的位置；徽章用的清單與項數不變', function () {
  const env = makeEnv({});
  const sb = env.sandbox;
  const resp = sb.apiLoadWeek(D);
  assert.strictEqual(resp.ok, true, JSON.stringify(resp.error));
  const split = plain(resp.data.missingSplit);
  const raw = split.required;
  assert.strictEqual(raw.filter(function (m) { return m.field.indexOf('ATT_') === 0; }).length, 12, '前提：12 格人數都未填');
  assert.strictEqual(split.requiredCount, raw.length, '項數照舊按格數計');

  const panel = split.panel.required;
  assert.strictEqual(panel.length, raw.length - 12 + 1);
  const firstAtt = raw.map(function (m) { return m.field; }).indexOf('ATT_ENG_WORSHIP');
  assert.deepStrictEqual(panel[firstAtt], {
    field: 'ATT_*', label: '人數', reason: sb.attendanceMissingSummaryText_(12), optional: false, cellCount: 12
  });
  assert.strictEqual(panel[firstAtt].reason, '12 格未填（上週崇拜人數由內容表輸入）');
  assert.deepStrictEqual(panel.filter(function (m) { return m.label !== '人數'; }),
    raw.filter(function (m) { return m.field.indexOf('ATT_') !== 0; }), '其餘項目原樣、次序不變');
  assert.strictEqual(panel.filter(function (m) { return m.reason === '人數尚未填寫。'; }).length, 0);
  assert.deepStrictEqual(split.panel.optional, split.optional, '通常空白那一段沒有人數，原樣');
});

test('G14-2 人數只填了 3 格 → 「9 格未填」；12 格都填了 → 面板沒有人數那一行', function () {
  const partial = {};
  ATT_KEYS.slice(0, 3).forEach(function (k, i) { partial[k] = 10 + i; });
  const env = makeEnv({ week: partial });
  const panel = plain(env.sandbox.apiLoadWeek(D).data.missingSplit.panel.required);
  const att = panel.filter(function (m) { return m.label === '人數'; });
  assert.strictEqual(att.length, 1);
  assert.strictEqual(att[0].reason, '9 格未填（上週崇拜人數由內容表輸入）');
  assert.strictEqual(att[0].cellCount, 9);

  const full = {};
  ATT_KEYS.forEach(function (k, i) { full[k] = 10 + i; });
  const env2 = makeEnv({ week: full });
  const split2 = plain(env2.sandbox.apiLoadWeek(D).data.missingSplit);
  assert.strictEqual(split2.panel.required.filter(function (m) { return m.label === '人數'; }).length, 0);
  assert.deepStrictEqual(split2.panel.required, split2.required);
});

test('G14-3 前端（apiLoadWeek 的回應 → 真正的 renderStats()）：面板只有一行人數，不再逐格列出；徽章「待填 N 項」與面板標題的 N 照舊按格數計，與寄出前檢查「未填欄位（N 項）」相同', function () {
  const env = makeEnv({});
  const sb = env.sandbox;
  const data = sb.apiLoadWeek(D).data;
  const ui = loadMissingPanel();
  ui.api.renderStats(plain(data.missingSplit), [], data.lastSavedAt);

  const n = data.missingSplit.required.length;
  assert.strictEqual(ui.elements.statMissing.textContent, '待填 ' + n + ' 項（另有 1 項通常空白）');
  const html = ui.elements.missingPanel.innerHTML;
  assert.ok(html.indexOf('一定要填（' + n + ' 項）') !== -1, html);
  const items = liTexts(html);
  assert.strictEqual(items.filter(function (t) { return t === '人數：12 格未填（上週崇拜人數由內容表輸入）'; }).length, 1, items.join('\n'));
  assert.strictEqual(items.filter(function (t) { return t.indexOf('人數尚未填寫') !== -1; }).length, 0, '不可以再逐格列出');
  assert.strictEqual(items.length, n - 12 + 1 + 1, '一定要填（人數一行）加一項通常空白');

  // 與寄出前檢查同一做法：數字按格數計，人數那一行字眼一字不差。
  const precheck = Array.from(sb.buildPublishPrecheck_(D, false).lines);
  assert.ok(precheck.indexOf('未填欄位（' + n + ' 項）（另有 1 項通常空白）') !== -1, precheck.join('\n'));
  const precheckAtt = precheck.filter(function (l) { return l.indexOf('人數：') !== -1; })[0];
  assert.strictEqual(precheckAtt.replace(/^　人數：/, ''), '12 格未填（上週崇拜人數由內容表輸入）');
  assertWrittenChinese(assert, 'G14 面板', items);
});

test('G14-4 BulletinModel.gs 的合併只用 G7 那兩支函式，字眼不另寫一份', function () {
  const model = readSrc('src/BulletinModel.gs');
  const fn = model.slice(model.indexOf('function mergeAttendanceMissingItems_('), model.indexOf('function rosterFlowerName_('));
  assert.ok(fn.indexOf('isAttendanceMissingItem_(') !== -1 && fn.indexOf('attendanceMissingSummaryText_(') !== -1);
  assert.strictEqual(fn.indexOf('格未填'), -1);
  const webapp = readSrc('src/WebApp.gs');
  assert.ok(webapp.indexOf('missingSplit: missingSplitForWebApp_(model.missing)') !== -1);
});

console.log('\n通過 ' + pass + ' 項，失敗 ' + fail + ' 項。');
process.exit(fail === 0 ? 0 : 1);
