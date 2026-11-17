#!/usr/bin/env node
/**
 * tests/savetiming.test.js
 *
 * R-061（2026-11-17）：儲存（apiSaveWeek）加分段計時；同一次儲存之內同一張工作表只讀一次、同類寫入合併。
 *
 *   1. 分段計時：回應帶 `timings`（與載入同一個格式），分段名稱與次序固定；計時不影響結果。
 *   2. 只做兩類改動，而且**寫入的內容、AuditLog 的內容與次序一律不變**：
 *      對照基準＝在第二個沙盒把兩項優化關掉（AuditLog 逐筆寫、BulletinWeeks 逐格寫、不記住讀過的工作表），
 *      同一個 payload、同一個真正入口（apiSaveWeek）各存一次，逐格比較全部工作表。
 *   3. 讀寫次數：典型的一次儲存（改 3 個欄位、1 個事奉格）讀寫了每張工作表幾多次，改動之前與之後。
 *   4. 記憶作廢（bug class 3）：寫入之後同一次儲存之內再讀，讀到的是新值。
 *
 *   ⚠️ 全部由真正入口 apiSaveWeek 叫下去（bug class 5）。
 *   樂觀鎖、三方比對、版本快照、LAST_SAVED_AT 的測試在 tests/webappsave.test.js、threewaysave.test.js、
 *   savetoken.test.js、writeaction.test.js，沒有改動。
 *
 * 執行方式：node tests/savetiming.test.js
 * 離開碼：0＝全部通過　1＝有測試失敗
 */

'use strict';

const assert = require('assert');
const { makeFillEnv, QUARTER_ID } = require('./helpers/fillEnv');
const { changedDutyCells, SAVE_PAYLOAD_VERSION } = require('./helpers/savePayload');

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

const W = '2027-11-14';
const DATES = ['2027-11-07', W, '2027-11-21', '2027-11-28'];
const ROSTER_ID = 'FAKE_ROSTER_ID_FOR_FILL_TESTS';

function makeEnv(legacy) {
  const env = makeFillEnv({
    withGrid: false,
    weekRows: DATES.map(function (iso, i) {
      return { SERVICE_DATE: iso, QUARTER_ID: QUARTER_ID, WEEK_OF_MONTH: i + 1, STATUS: 'DRAFT', LAST_SAVED_AT: '2026-10-01' };
    }),
    config: { PRELUDE_DEFAULT: '預設序樂' }
  });
  if (legacy) {
    // 改動之前的做法：AuditLog 逐筆寫、BulletinWeeks 逐格寫、不記住讀過的工作表。
    const sb = env.sandbox;
    sb.appendAuditLogBatch_ = function (entries) { (entries || []).forEach(function (e) { sb.appendAuditLog_(e); }); return (entries || []).length; };
    sb.setRowCellsTextSafe_ = function (sheet, def, rowNo, valuesByField) {
      Object.keys(valuesByField).forEach(function (key) { sb.setCellValueTextSafe_(sheet, def, rowNo, key, valuesByField[key]); });
      return { segments: 0, cells: 0, gapCells: 0 };
    };
    sb.withReadRowsMemo_ = function (fn) { return fn(); };
    sb.withReadSheetMemo_ = function (fn) { return fn(); };
  }
  return env;
}

/** 典型的一次儲存：改 3 個欄位（序樂、宣召、詩歌頌讚）、1 個事奉格（本週主席）。 */
function typicalPayload(sb) {
  const tab = plain(sb.loadWeekForWebApp_(W));
  const patch = { PRELUDE: '序樂甲', CALL_TEXT: '宣召乙', HYMN_PRAISE: '詩歌丙' };
  return {
    isoDate: W, lastSavedAt: tab.lastSavedAt, payloadVersion: SAVE_PAYLOAD_VERSION, week: patch,
    baseWeek: plain(sb.baseWeekFor_(tab.week, patch)),
    dutyEdits: changedDutyCells(tab.readOnly.dutyBoxPage1, { 'CHAIR#1': '李小明' }),
    nextWeekDutyEdits: []
  };
}

function dumpSheet(env, name, dropCols) {
  const sheet = env.sheets[name];
  const last = sheet.getLastRow();
  if (last < 1) return [];
  return plain(sheet.getRange(1, 1, last, sheet.getLastColumn()).getValues()).map(function (row) {
    return row.filter(function (v, i) { return !(dropCols || []).includes(i); });
  });
}

function sheetNamesOf(env) { return Object.keys(env.sheets); }

/** 讀寫次數：每張工作表 { reads, writes, formats }。 */
function callTable(env) {
  const out = {};
  sheetNamesOf(env).forEach(function (name) {
    const c = env.sheets[name].__calls;
    if (!c) return;
    out[name] = { reads: c.getValues + c.getValue, writes: c.setValue + c.setValues + c.clearContent, formats: c.setNumberFormat };
  });
  return out;
}
function resetAllCalls(env) { sheetNamesOf(env).forEach(function (n) { env.sheets[n].__resetCalls(); }); }

const EXPECTED_LABELS = [
  '檢查工作表結構', '檢查這一週有沒有取消', '檢查送來的欄位', '拿指令碼鎖', '讀現況與比對', '存版本',
  '寫 BulletinWeeks', '寫清單', '寫事奉與欄位覆寫', '寫最後儲存時間', '寫 AuditLog', '更新填寫表快照'
];

console.log('\nR-061：分段計時');

test('SV-1 apiSaveWeek 的回應帶 timings（name、totalMs、parts），分段名稱與次序固定', function () {
  const env = makeEnv(false);
  const sb = env.sandbox;
  const resp = sb.apiSaveWeek(plain(typicalPayload(sb)));
  assert.strictEqual(resp.ok, true, JSON.stringify(resp.error));
  const t = plain(resp.data.timings);
  assert.strictEqual(t.name, 'apiSaveWeek');
  assert.ok(typeof t.totalMs === 'number' && t.totalMs >= 0);
  const labels = t.parts.filter(function (p) { return !p.note; }).map(function (p) { return p.label; });
  assert.deepStrictEqual(labels, EXPECTED_LABELS);
  t.parts.forEach(function (p) { assert.ok(typeof p.ms === 'number' && p.ms >= 0, p.label); });
  assert.ok(t.parts.some(function (p) { return p.note && p.label.indexOf('其中讀週報試算表') !== -1; }), '帶「其中讀週報試算表 N 次」');
  assert.strictEqual(resp.data.changedFieldCount, 4, '儲存本身的結果照舊');
});

test('SV-2 沒有改動的儲存、STALE 的儲存：照舊（沒有改動 → 沒有寫入；STALE → 回錯誤，不寫）', function () {
  const env = makeEnv(false);
  const sb = env.sandbox;
  const tab = plain(sb.loadWeekForWebApp_(W));
  const none = sb.apiSaveWeek(plain({
    isoDate: W, lastSavedAt: tab.lastSavedAt, payloadVersion: SAVE_PAYLOAD_VERSION, week: {}, baseWeek: {}, dutyEdits: [], nextWeekDutyEdits: []
  }));
  assert.strictEqual(none.ok, true, JSON.stringify(none.error));
  assert.strictEqual(none.data.changedFieldCount, 0);
  assert.strictEqual(none.data.lastSavedAt, tab.lastSavedAt, '沒有改動不更新 token');
  const stale = sb.apiSaveWeek(plain(Object.assign(typicalPayload(sb), { lastSavedAt: '2020-01-01 00:00:00' })));
  assert.strictEqual(stale.ok, false);
  assert.strictEqual(stale.error.code, 'STALE');
  assert.strictEqual(env.sheets.AuditLog.__calls.setValues, 0, 'STALE 沒有寫任何 AuditLog');
  assert.strictEqual(env.sheets.BulletinWeeks.__calls.setValue + env.sheets.BulletinWeeks.__calls.setValues, 0, 'STALE 沒有寫 BulletinWeeks');
});

console.log('\nR-061：寫入的內容與次序不變（與關掉優化的對照）');

test('SV-3 同一個 payload、同一個真入口：全部工作表逐格相同（AuditLog 去掉時間）', function () {
  const neu = makeEnv(false);
  const old = makeEnv(true);
  const pn = typicalPayload(neu.sandbox);
  const po = typicalPayload(old.sandbox);
  const rn = neu.sandbox.apiSaveWeek(plain(pn));
  const ro = old.sandbox.apiSaveWeek(plain(po));
  assert.strictEqual(rn.ok, true, JSON.stringify(rn.error));
  assert.strictEqual(ro.ok, true, JSON.stringify(ro.error));
  assert.strictEqual(rn.data.message.text, ro.data.message.text);
  assert.strictEqual(rn.data.changedFieldCount, ro.data.changedFieldCount);
  assert.strictEqual(rn.data.sideRecordCount, ro.data.sideRecordCount);
  const timeCols = { AuditLog: [0], BulletinWeeks: [], WeekSnapshots: [4], DutyOverride: [] };
  ['BulletinWeeks', 'AuditLog', 'DutyOverride', 'FieldOverride', 'Announcements', 'Prayers', 'Fellowships', 'Finance'].forEach(function (name) {
    // 時間、版本編號因每次執行而不同，只比較其餘的欄。
    const dropTime = function (rows) {
      const keys = neu.sandbox.COLUMNS[neu.sandbox.SHEET_ID_BY_NAME[name]].keys;
      const drop = keys.map(function (k, i) { return /(_AT|^TIMESTAMP)$/.test(k) ? i : -1; }).filter(function (i) { return i >= 0; });
      return rows.map(function (row) { return row.filter(function (v, i) { return drop.indexOf(i) === -1; }); });
    };
    assert.deepStrictEqual(dropTime(dumpSheet(neu, name, timeCols[name])), dropTime(dumpSheet(old, name, timeCols[name])), name + ' 內容逐格相同');
  });
  const auditOf = function (env) {
    return dumpSheet(env, 'AuditLog', [0]).slice(2).map(function (r) { return r[1] === 'WEEK_SNAPSHOT_CREATE' ? r.map(function (v, i) { return i === 3 ? '<版本>' : v; }) : r; });
  };
  const an = auditOf(neu);
  assert.deepStrictEqual(an, auditOf(old), 'AuditLog 每一行的內容與先後次序相同');
  assert.ok(an.length >= 5, '版本一行、欄位三行、事奉一行以上：' + an.length);
  // LAST_SAVED_AT 真的更新了（樂觀鎖的基礎）。
  const keys = neu.sandbox.COLUMNS.BULLETIN_WEEKS.keys;
  assert.notStrictEqual(neu.sheets.BulletinWeeks.getRange(4, keys.indexOf('LAST_SAVED_AT') + 1, 1, 1).getValue(), '2026-10-01');
  assert.strictEqual(neu.sheets.BulletinWeeks.getRange(4, keys.indexOf('PRELUDE') + 1, 1, 1).getValue(), '序樂甲');
  assert.strictEqual(neu.sheets.BulletinWeeks.getRange(4, keys.indexOf('HYMN_PRAISE') + 1, 1, 1).getValue(), '詩歌丙');
});

test('SV-4 ATT_* 純文字欄經 applyWeekFieldChanges_（儲存、還原、重設共用的寫入）合併寫入之後仍然是文字（事故二十八）；AuditLog 條目的內容與次序不變', function () {
  // 填寫介面儲存本身不可以改 ATT_*（內容表接管，見 SV-3 之外的 webappsave 測試）；還原與重設會經同一支寫入把它們寫回。
  const env = makeEnv(false);
  const sb = env.sandbox;
  const changes = [
    { field: 'ATT_ENG_WORSHIP', oldValue: '', newValue: '1,024' },
    { field: 'ATT_CANE_WORSHIP', oldValue: '', newValue: '57' },
    { field: 'PRELUDE', oldValue: '', newValue: '序樂' },
    { field: 'ATT_CANN_WORSHIP', oldValue: '', newValue: '--' },
    { field: 'ATT_MAN_WORSHIP', oldValue: '', newValue: '前:5 / 後:120' }
  ];
  const audit = [];
  env.sheets.BulletinWeeks.__resetCalls();
  sb.applyWeekFieldChanges_(4, changes, W, audit, 'WEEK_RESTORE');
  const keys = sb.COLUMNS.BULLETIN_WEEKS.keys;
  changes.forEach(function (c) {
    const v = env.sheets.BulletinWeeks.getRange(4, keys.indexOf(c.field) + 1, 1, 1).getValue();
    assert.strictEqual(v, c.newValue, c.field + '：' + JSON.stringify(v));
    assert.strictEqual(typeof v, 'string');
  });
  assert.strictEqual(env.sheets.BulletinWeeks.getRange(4, keys.indexOf('ATT_ENG_WORSHIP') + 1, 1, 1).getNumberFormat(), '@');
  assert.deepStrictEqual(plain(audit.map(function (e) { return [e.action, e.field, e.newValue]; })),
    changes.map(function (c) { return ['WEEK_RESTORE', c.field, c.newValue]; }), 'AuditLog 條目的內容與次序照 changes 的次序');
  const w = env.sheets.BulletinWeeks.__calls;
  assert.ok(w.setValue + w.setValues <= 3, '五格改動、三段欄位 → 最多三次寫入：' + (w.setValue + w.setValues));
});

console.log('\nR-061：讀寫次數（改動之前與之後）');

test('SV-5 典型的一次儲存（改 3 個欄位、1 個事奉格）：每張工作表讀寫次數，之後不多於之前，BulletinWeeks 與 AuditLog 明顯減少', function () {
  const neu = makeEnv(false);
  const old = makeEnv(true);
  const pn = plain(typicalPayload(neu.sandbox));
  const po = plain(typicalPayload(old.sandbox));
  resetAllCalls(neu);
  resetAllCalls(old);
  assert.strictEqual(neu.sandbox.apiSaveWeek(pn).ok, true);
  assert.strictEqual(old.sandbox.apiSaveWeek(po).ok, true);
  const tn = callTable(neu);
  const to = callTable(old);
  const lines = [];
  Object.keys(to).forEach(function (name) {
    const o = to[name];
    const n = tn[name];
    if (o.reads + o.writes + o.formats + n.reads + n.writes + n.formats === 0) return;
    lines.push(name + '：讀 ' + o.reads + '→' + n.reads + '，寫 ' + o.writes + '→' + n.writes + '，格式 ' + o.formats + '→' + n.formats);
    assert.ok(n.reads <= o.reads, name + ' 讀取不可以變多：' + o.reads + '→' + n.reads);
    assert.ok(n.writes <= o.writes, name + ' 寫入不可以變多：' + o.writes + '→' + n.writes);
  });
  console.log('    [量度] 典型儲存（逐表 改動之前→之後）\n      ' + lines.filter(function (l) { return /讀 [0-9]+→[0-9]+，寫 [1-9]|BulletinWeeks|AuditLog|WeekSnapshots|DutyOverride/.test(l); }).join('\n      '));
  assert.ok(tn.BulletinWeeks.reads < to.BulletinWeeks.reads, 'BulletinWeeks 讀取減少');
  assert.ok(tn.BulletinWeeks.writes < to.BulletinWeeks.writes, 'BulletinWeeks 寫入減少');
  assert.ok(tn.AuditLog.writes < to.AuditLog.writes, 'AuditLog 寫入減少');
  assert.ok(tn.AuditLog.writes <= 2, 'AuditLog 寫入：版本那一行與其餘各一次');
});

console.log('\nR-061：記憶作廢（bug class 3）');

test('SV-6 withReadRowsMemo_：記住 readSheet_ 與 readRowsWithRowNo_；任何經 setCellValueTextSafe_／writeSheet_ 的寫入都清走', function () {
  const env = makeEnv(false);
  const sb = env.sandbox;
  const sheet = env.sheets.BulletinWeeks;
  const keys = sb.COLUMNS.BULLETIN_WEEKS.keys;
  sheet.__resetCalls();
  sb.withReadRowsMemo_(function () {
    const a = sb.readRowsWithRowNo_('BulletinWeeks');
    const reads = sheet.__calls.getValues;
    sb.readRowsWithRowNo_('BulletinWeeks');
    assert.strictEqual(sheet.__calls.getValues, reads, '第二次讀來自記憶');
    a[0].PRELUDE = '外面改了拷貝';
    assert.notStrictEqual(sb.readRowsWithRowNo_('BulletinWeeks')[0].PRELUDE, '外面改了拷貝', '每次回新的拷貝');
    sb.writeWeekCell_(3, 'PRELUDE', '新序樂');
    assert.strictEqual(sb.readRowsWithRowNo_('BulletinWeeks')[0].PRELUDE, '新序樂', '寫入之後讀到新值');
    sb.readSheet_('BulletinWeeks');
    sb.writeSheet_('AuditLog', [{ ACTION: 'T' }]);
    const afterWrite = sheet.__calls.getValues;
    assert.strictEqual(sb.readRowsWithRowNo_('BulletinWeeks')[0].PRELUDE, '新序樂');
    assert.ok(sheet.__calls.getValues > afterWrite, 'writeSheet_ 之後記憶已清走，重新讀');
  });
  assert.ok(keys.length > 0);
  // 在記憶範圍之外：每次都讀（不跨執行、不留記憶）。
  sheet.__resetCalls();
  sb.readRowsWithRowNo_('BulletinWeeks');
  sb.readRowsWithRowNo_('BulletinWeeks');
  assert.strictEqual(sheet.__calls.getValues, 2);
});

test('SV-7 直接 setValue 的三個寫入函式（清單、事奉覆寫、欄位覆寫）一開始就清走記憶', function () {
  const env = makeEnv(false);
  const sb = env.sandbox;
  sb.withReadRowsMemo_(function () {
    const hasMemo = function () { return Object.keys(sb.READ_SHEET_MEMO_).length > 0; };
    sb.readRowsWithRowNo_('BulletinWeeks');
    assert.ok(hasMemo(), '前提：有記憶');
    sb.applyDutyOverridePlan_({ updates: [], deactivations: [], appends: [] }, sb.normalizeDate_(W), W, 'a@b.c', []);
    assert.ok(!hasMemo(), 'applyDutyOverridePlan_ 清走記憶');
    sb.readRowsWithRowNo_('BulletinWeeks');
    sb.applyFieldOverridePlan_({ upserts: [{ fieldKey: 'PRELUDE', overrideValue: 'x', sourceValue: '' }], deactivations: [] }, sb.normalizeDate_(W), W, 'a@b.c', []);
    assert.ok(!Object.prototype.hasOwnProperty.call(sb.READ_SHEET_MEMO_, '#rows:BulletinWeeks'), 'applyFieldOverridePlan_ 清走記憶');
    sb.readRowsWithRowNo_('BulletinWeeks');
    sb.applyListPlan_('Announcements', sb.normalizeDate_(W), W, 'announcements', { updates: [], deactivations: [], appends: [] }, []);
    assert.ok(!hasMemo(), 'applyListPlan_ 清走記憶');
  });
});

test('SV-8 儲存之內：寫入之後的讀取讀到新值——另一週的 LAST_SAVED_AT 在事奉改動之後被更新（touchWeeksLastSavedAt_ 在寫入之後讀）', function () {
  const env = makeEnv(false);
  const sb = env.sandbox;
  const resp = sb.apiSaveWeek(plain(typicalPayload(sb)));
  assert.strictEqual(resp.ok, true, JSON.stringify(resp.error));
  const keys = sb.COLUMNS.BULLETIN_WEEKS.keys;
  const col = keys.indexOf('LAST_SAVED_AT') + 1;
  const stamps = DATES.map(function (iso, i) { return String(env.sheets.BulletinWeeks.getRange(3 + i, col, 1, 1).getValue()); });
  assert.notStrictEqual(stamps[1], '2026-10-01', '這一週更新了');
  // 本週主席改了名字：上一週的「下週事奉」顯示它，也要更新（dutychanged.test.js 有完整的對照）。
  assert.notStrictEqual(stamps[0], '2026-10-01', '上一週（顯示這一週事奉）更新了');
  assert.strictEqual(stamps[2], '2026-10-01', '下一週沒有動');
  assert.strictEqual(sb.READ_SHEET_MEMO_, null, '儲存完畢之後沒有留下記憶');
  assert.strictEqual(sb.READ_ROWS_MEMO_ON_, false, '開關已經還原');
});

console.log('\n通過 ' + pass + ' 項，失敗 ' + fail + ' 項。');
process.exit(fail === 0 ? 0 : 1);
