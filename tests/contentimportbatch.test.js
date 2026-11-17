#!/usr/bin/env node
/**
 * tests/contentimportbatch.test.js
 *
 * R-060（2026-11-17）：內容表匯入（單週、整季、自動同步）改為批次寫入，並加時間預算。
 *
 *   對照基準：tests/helpers/legacyContentImportWrite.js 是「改動之前」的寫入做法原封不動。同一批輸入、同一個
 *   真正入口各跑一次（新的與舊的各用一個沙盒），逐行比較工作表內容與 AuditLog（TIMESTAMP 與版本編號除外），
 *   再比較假試算表的寫入呼叫次數。
 *
 *   ⚠️ 全部由真正入口叫下去（bug class 5）：apiRunQuarterContentImport、apiAutoImportWeek、
 *   contentAutoSyncTrigger_、menuImportFromContentSheet_。
 *
 * 執行方式：node tests/contentimportbatch.test.js
 * 離開碼：0＝全部通過　1＝有測試失敗
 */

'use strict';

const assert = require('assert');
const vm = require('vm');
const contentEnv = require('./helpers/contentEnv');
const { installLegacyContentImportWrite } = require('./helpers/legacyContentImportWrite');
const { assertWrittenChinese } = require('./helpers/writtenChinese');

const QUARTER_ID = contentEnv.QUARTER_ID;

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

// ---------------------------------------------------------------------
// 13 個主日、每週約 18 格改動的內容表
// ---------------------------------------------------------------------

function addDays(iso, days) {
  const d = new Date(Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))));
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const DATES = Array.from({ length: 13 }, function (_, i) { return addDays('2027-10-03', 7 * i); });

const ATT_KEYS = [
  'ATT_ENG_WORSHIP', 'ATT_CANE_WORSHIP', 'ATT_CANN_WORSHIP', 'ATT_MAN_WORSHIP',
  'ATT_ENG_PRAYER', 'ATT_CANE_PRAYER', 'ATT_CANN_PRAYER', 'ATT_MAN_PRAYER',
  'ATT_ENG_CHILD', 'ATT_CANE_CHILD', 'ATT_CANN_CHILD', 'ATT_MAN_CHILD'
];
const COMB_KEYS = ['ATT_COMB_WORSHIP', 'ATT_COMB_PRAYER', 'ATT_COMB_CHILD'];

function attendanceValue(i, k) {
  // 刻意混合：純數字、千分位、帶字、破折號——全部都不可以被試算表轉成數字。
  return [String(40 + i), '1,0' + String(10 + i), '前:' + i + ' / 後:' + (100 + k), '--'][k % 4];
}

function makeContent(withComb) {
  return {
    崇拜程序: DATES.map(function (d, i) {
      return { SERVICE_DATE: d, SCRIPTURE_REF: '約翰福音 3:' + (i + 1), SERMON_TITLE: '講題 ' + d, RESPONSE_HYMN: '詩歌 ' + (i + 1), ACTIVE: 'TRUE' };
    }),
    // 崇拜人數的日期是崇拜當日，對應的週報主日是它 + 7 天。
    崇拜人數: DATES.map(function (d, i) {
      const row = { SERVICE_DATE: addDays(d, -7), ACTIVE: 'TRUE' };
      ATT_KEYS.forEach(function (key, k) { row[key] = attendanceValue(i, k); });
      if (withComb) COMB_KEYS.forEach(function (key, k) { row[key] = '合' + (i + k); });
      return row;
    }),
    家事報告: DATES.map(function (d) {
      return { SERVICE_DATE: d, SEQ_NO: '10', TEXT: '家事 ' + d, ACTIVE: 'TRUE' };
    }),
    代禱事項: DATES.map(function (d) {
      return { SERVICE_DATE: d, SEQ_NO: '10', TEXT: '代禱 ' + d, ACTIVE: 'TRUE' };
    })
  };
}

function makeBatchEnv(options) {
  const o = options || {};
  const env = contentEnv.makeEnv(Object.assign({
    serviceDates: DATES,
    config: Object.assign({ WEBAPP_SIMULATED_TODAY: '2027-10-01' }, o.config || {}),
    content: makeContent(Boolean(o.withComb))
  }, o.env || {}));
  const sb = env.sandbox;
  const props = {};
  sb.PropertiesService = { getScriptProperties: function () {
    return {
      getProperty: function (k) { return props[k] === undefined ? null : props[k]; },
      setProperty: function (k, v) { props[k] = String(v); },
      deleteProperty: function (k) { delete props[k]; }
    };
  } };
  env.props = props;
  env.mtime = 1000;
  sb.readContentSheetLastUpdatedMillis_ = function () { return env.mtime; };
  if (o.legacy) installLegacyContentImportWrite(sb);
  return env;
}

/** 工作表的原始內容（第 1 行起，所有欄），Date 轉成字串；可以排除某幾欄（0 起算）。 */
function dumpSheet(env, name, dropCols) {
  const sheet = env.sheets[name];
  const last = sheet.getLastRow();
  if (last < 1) return [];
  const width = sheet.getLastColumn();
  return plain(sheet.getRange(1, 1, last, width).getValues()).map(function (row) {
    return row.filter(function (v, i) { return !(dropCols || []).includes(i); });
  });
}

/** AuditLog：去掉 TIMESTAMP（第 0 欄）；版本的編號含時間（ROW_KEY），換成固定字。 */
function auditRows(env) {
  return dumpSheet(env, 'AuditLog', [0]).slice(2).map(function (row) {
    return row[1] === 'WEEK_SNAPSHOT_CREATE' ? row.map(function (v, i) { return i === 3 ? '<版本編號>' : v; }) : row;
  });
}

/** WeekSnapshots：只比較不含時間的欄（主日、季度、原因、摘要）。 */
function snapshotRows(env) {
  const keys = env.sandbox.COLUMNS.WEEK_SNAPSHOTS.keys;
  const wanted = ['SERVICE_DATE', 'QUARTER_ID', 'REASON', 'SUMMARY', 'ACTIVE'].map(function (k) { return keys.indexOf(k); });
  return dumpSheet(env, 'WeekSnapshots').slice(2).map(function (row) {
    return wanted.map(function (i) { return row[i]; });
  });
}

const DATA_SHEETS = ['BulletinWeeks', 'Announcements', 'Prayers', 'Fellowships', 'Finance', 'FieldOverride'];

function resetCalls(env) {
  Object.keys(env.sheets).forEach(function (name) { env.sheets[name].__resetCalls(); });
}
function valueWrites(env, name) {
  const c = env.sheets[name].__calls;
  return c.setValue + c.setValues;
}

function importOnce(env) {
  const resp = env.sandbox.apiRunQuarterContentImport(QUARTER_ID);
  assert.strictEqual(resp.ok, true, JSON.stringify(resp.error));
  return resp.data;
}

// =====================================================================
console.log('\nR-060：批次寫入（13 週，與舊做法逐行對照）');
// =====================================================================

test('B-1 apiRunQuarterContentImport：新做法與舊做法，工作表內容、AuditLog 每一行的內容與先後次序逐行相同', function () {
  const neu = makeBatchEnv({});
  const old = makeBatchEnv({ legacy: true });
  const rn = importOnce(neu);
  const ro = importOnce(old);
  assert.strictEqual(rn.partial, false);
  assert.deepStrictEqual(plain(rn.summary), plain(ro.summary), '四個數字相同');
  assert.ok(rn.summary.updated >= 13 && rn.summary.added >= 26, JSON.stringify(rn.summary));

  DATA_SHEETS.forEach(function (name) {
    assert.deepStrictEqual(dumpSheet(neu, name), dumpSheet(old, name), name + ' 內容逐格相同');
  });
  const an = auditRows(neu);
  const ao = auditRows(old);
  assert.ok(an.length > 13 * 15 + 26, 'AuditLog 行數：' + an.length);
  assert.strictEqual(an.length, ao.length, 'AuditLog 行數相同');
  assert.deepStrictEqual(an, ao, 'AuditLog 每一行的內容與先後次序逐行相同');
  assert.deepStrictEqual(snapshotRows(neu), snapshotRows(old), '版本記錄（每個主日一個）相同');
  assert.ok(snapshotRows(neu).length >= 13, '每個會被改到的主日都有版本');
});

test('B-2 每一格都真的寫對了（不只是「與舊做法相同」）：十二格人數仍是文字（千分位、帶字、破折號都沒有被轉成數字）', function () {
  const env = makeBatchEnv({});
  importOnce(env);
  const keys = env.sandbox.COLUMNS.BULLETIN_WEEKS.keys;
  const sheet = env.sheets.BulletinWeeks;
  DATES.forEach(function (d, i) {
    const rowNo = 3 + i;
    ATT_KEYS.forEach(function (key, k) {
      const v = sheet.getRange(rowNo, keys.indexOf(key) + 1, 1, 1).getValue();
      assert.strictEqual(typeof v, 'string', d + ' ' + key + ' 要是文字，實際：' + JSON.stringify(v));
      assert.strictEqual(v, attendanceValue(i, k), d + ' ' + key);
      assert.strictEqual(sheet.getRange(rowNo, keys.indexOf(key) + 1, 1, 1).getNumberFormat(), '@', key + ' 設了純文字格式');
    });
    assert.strictEqual(sheet.getRange(rowNo, keys.indexOf('SCRIPTURE_REF') + 1, 1, 1).getValue(), '約翰福音 3:' + (i + 1));
    assert.strictEqual(sheet.getRange(rowNo, keys.indexOf('SERMON_TITLE') + 1, 1, 1).getValue(), '講題 ' + d);
  });
});

test('B-3 與舊做法相同：有合堂三格（兩段不連續的欄）、而且某一格原本有值', function () {
  const weekRows = DATES.map(function (iso, i) {
    return { SERVICE_DATE: iso, QUARTER_ID: QUARTER_ID, WEEK_OF_MONTH: (i % 4) + 1, STATUS: 'DRAFT',
      ATT_ENG_WORSHIP: '舊值', ATT_COMB_CHILD: '合舊', ATTENDANCE_HEADING: '崇拜人數', ROSTER_VERSION_USED: 3 };
  });
  const neu = makeBatchEnv({ withComb: true, env: { weekRows: weekRows } });
  const old = makeBatchEnv({ withComb: true, legacy: true, env: { weekRows: weekRows } });
  importOnce(neu);
  importOnce(old);
  DATA_SHEETS.forEach(function (name) {
    assert.deepStrictEqual(dumpSheet(neu, name), dumpSheet(old, name), name);
  });
  assert.deepStrictEqual(auditRows(neu), auditRows(old));
  const keys = neu.sandbox.COLUMNS.BULLETIN_WEEKS.keys;
  const sheet = neu.sheets.BulletinWeeks;
  assert.strictEqual(sheet.getRange(3, keys.indexOf('ATTENDANCE_HEADING') + 1, 1, 1).getValue(), '崇拜人數', '夾在中間沒有匯入的格保持原值');
  assert.strictEqual(sheet.getRange(3, keys.indexOf('ROSTER_VERSION_USED') + 1, 1, 1).getValue(), 3, '遠處沒有匯入的格保持原值（型別不變）');
});

test('B-4 同一個主日再匯入一次（冪等）：第二次沒有任何寫入、AuditLog 沒有新增', function () {
  const env = makeBatchEnv({});
  importOnce(env);
  const before = auditRows(env).length;
  resetCalls(env);
  const second = importOnce(env);
  assert.strictEqual(second.partial, false);
  assert.deepStrictEqual(plain(second.summary), { added: 0, updated: 0, removed: 0, unchanged: second.summary.unchanged });
  assert.strictEqual(valueWrites(env, 'BulletinWeeks'), 0);
  const after = auditRows(env);
  assert.strictEqual(after.length, before + 1, '沒有新的逐格記錄，只多了「整季匯入」那一行摘要');
  assert.strictEqual(after[after.length - 1][1], 'WEBAPP_CONTENT_IMPORT_QUARTER');
});

// =====================================================================
console.log('\nR-060：寫入呼叫次數（改動之前與之後）');
// =====================================================================

test('B-5 選單 menuImportFromContentSheet_（真入口）：BulletinWeeks 的資料寫入呼叫不多於主日數目；AuditLog 的寫入呼叫整次匯入 1 次', function () {
  const neu = makeBatchEnv({});
  const old = makeBatchEnv({ legacy: true });
  resetCalls(neu);
  resetCalls(old);
  neu.sandbox.menuImportFromContentSheet_();
  old.sandbox.menuImportFromContentSheet_();
  const nb = valueWrites(neu, 'BulletinWeeks');
  const ob = valueWrites(old, 'BulletinWeeks');
  const na = neu.sheets.AuditLog.__calls.setValues;
  const oa = old.sheets.AuditLog.__calls.setValues;
  const nr = neu.sheets.BulletinWeeks.__calls;
  const or = old.sheets.BulletinWeeks.__calls;
  console.log('    [量度] BulletinWeeks 資料寫入（setValue＋setValues）：舊 ' + ob + ' → 新 ' + nb
    + '；BulletinWeeks setNumberFormat：舊 ' + or.setNumberFormat + ' → 新 ' + nr.setNumberFormat
    + '；BulletinWeeks 讀取（getValues）：舊 ' + or.getValues + ' → 新 ' + nr.getValues);
  console.log('    [量度] AuditLog 寫入（setValues）：舊 ' + oa + ' → 新 ' + na
    + '；Announcements 寫入：舊 ' + valueWrites(old, 'Announcements') + ' → 新 ' + valueWrites(neu, 'Announcements')
    + '；Prayers 寫入：舊 ' + valueWrites(old, 'Prayers') + ' → 新 ' + valueWrites(neu, 'Prayers'));
  assert.ok(nb <= DATES.length, 'BulletinWeeks 資料寫入 ' + nb + ' 次，主日 ' + DATES.length + ' 個');
  assert.ok(ob >= DATES.length * 15, '舊做法是逐格寫：' + ob);
  assert.strictEqual(na, 1, 'AuditLog 整次匯入只寫 1 次（版本記錄的那一行 AuditLog 一併在內）：' + na);
  assert.ok(oa > 13 * 15, '舊做法逐筆寫：' + oa);
  // BulletinWeeks 整份只讀一次（以前每一格改動讀一次）。
  // 整份匯入自己讀一次；其餘是每個主日存版本時讀週報（readWeekStateForSnapshot_，不是這一次改動的範圍）。
  assert.ok(nr.getValues <= DATES.length * 2, 'BulletinWeeks 讀取次數：' + nr.getValues);
  assert.ok(or.getValues > 13 * 15, '舊做法每格改動讀一次整張表：' + or.getValues);
  assert.deepStrictEqual(dumpSheet(neu, 'BulletinWeeks'), dumpSheet(old, 'BulletinWeeks'));
});

test('B-6 有合堂三格（兩段欄位不連續）：每個主日最多 2 次資料寫入', function () {
  const neu = makeBatchEnv({ withComb: true });
  resetCalls(neu);
  neu.sandbox.menuImportFromContentSheet_();
  const nb = valueWrites(neu, 'BulletinWeeks');
  console.log('    [量度] 有合堂三格：BulletinWeeks 資料寫入 ' + nb + ' 次（' + DATES.length + ' 個主日）');
  assert.ok(nb <= DATES.length * 2, String(nb));
  assert.strictEqual(neu.sheets.AuditLog.__calls.setValues, 1);
});

test('B-7 AuditLog 的批次函式 appendAuditLogBatch_：行與逐筆 appendAuditLog_ 相同、Session 只問一次、一次 writeSheet_、先核對再寫', function () {
  const a = makeBatchEnv({});
  const b = makeBatchEnv({});
  let asked = 0;
  b.sandbox.Session.getActiveUser = function () { asked++; return { getEmail: function () { return 'tester@x.com'; } }; };
  const entries = [
    { action: 'X', sheetName: 'S', rowKey: 'k1', field: 'f', oldValue: '=1+1', newValue: '-5', notes: '@n' },
    { action: 'Y', actor: 'someone@x.com', rowKey: 'k2' },
    { action: 'Z' }
  ];
  entries.forEach(function (e) { a.sandbox.appendAuditLog_(e); });
  b.sandbox.appendAuditLogBatch_(entries);
  assert.deepStrictEqual(auditRows(b), auditRows(a));
  assert.strictEqual(b.sheets.AuditLog.__calls.setValues, 1);
  assert.strictEqual(asked, 1, 'Session.getActiveUser() 只問一次');
  assert.strictEqual(b.sandbox.appendAuditLogBatch_([]), 0);
  assert.throws(function () { b.sandbox.appendAuditLogBatch_([{ action: 'OK' }, { action: '' }]); }, /action 是必填/);
  assert.strictEqual(auditRows(b).length, 3, '有一筆沒有 action → 一筆都沒有寫');
});

test('B-8 setRowCellsTextSafe_：只改有改動的格；中間有數字樣子的文字（原本不是純文字格式）不合併、不轉型', function () {
  const env = makeBatchEnv({});
  const sb = env.sandbox;
  const def = sb.COLUMNS.BULLETIN_WEEKS;
  const sheet = env.sheets.BulletinWeeks;
  const keys = def.keys;
  const col = function (k) { return keys.indexOf(k) + 1; };
  // 第 3 行：夾在 SCRIPTURE_REF 與 ATT_ENG_WORSHIP 之間的 ATTENDANCE_HEADING 是文字 '12'（格式不是純文字）。
  sheet.getRange(3, col('ATTENDANCE_HEADING'), 1, 1).setValue("'12");
  const raw = sheet.getRange(3, 1, 1, keys.length).getValues()[0];
  assert.strictEqual(raw[col('ATTENDANCE_HEADING') - 1], '12');
  sheet.__resetCalls();
  const done = sb.setRowCellsTextSafe_(sheet, def, 3,
    { SCRIPTURE_REF: 'a', RESPONSE_HYMN: 'b', ATT_ENG_WORSHIP: '1,024' }, { currentRow: raw, maxGap: 3 });
  assert.strictEqual(done.segments, 2, '三格 → 兩段（RESPONSE_HYMN 與 ATT 中間隔着不安全的格，不合併）');
  assert.strictEqual(sheet.getRange(3, col('ATTENDANCE_HEADING'), 1, 1).getValue(), '12', '中間的格沒有被碰（沒有變成數字）');
  assert.strictEqual(sheet.getRange(3, col('ATT_ENG_WORSHIP'), 1, 1).getValue(), '1,024', '純文字欄先設 @ 再寫');
  // 中間是空白就合併成一次。
  const sheet2 = makeBatchEnv({}).sheets.BulletinWeeks;
  const raw2 = sheet2.getRange(3, 1, 1, keys.length).getValues()[0];
  sheet2.__resetCalls();
  const merged = sb.setRowCellsTextSafe_(sheet2, def, 3,
    { SCRIPTURE_REF: 'a', RESPONSE_HYMN: 'b', ATT_ENG_WORSHIP: '1,024' }, { currentRow: raw2, maxGap: 3 });
  assert.strictEqual(merged.segments, 1);
  assert.strictEqual(merged.gapCells, 3, 'SERMON_TITLE、ATTENDANCE_HEADING、ATTENDANCE_DATE 三格原值寫回');
  assert.strictEqual(sheet2.__calls.setValues, 1);
  assert.strictEqual(sheet2.getRange(3, col('ATT_ENG_WORSHIP'), 1, 1).getValue(), '1,024');
  assert.strictEqual(sb.isTextFormatField_(def, 'ATT_ENG_WORSHIP'), true);
  assert.strictEqual(sb.isTextFormatField_(def, 'SERMON_TITLE'), false);
});

// =====================================================================
console.log('\nR-060：時間預算（IMPORT_TIME_BUDGET_SEC）');
// =====================================================================

function snapshotOfData(env) {
  return DATA_SHEETS.map(function (name) { return dumpSheet(env, name); });
}

test('B-9 預算 0：整季匯入每次只寫一個完整主日；字眼正確；再按一次由下一個主日繼續；十三次之後結果與一次做完相同', function () {
  const slow = makeBatchEnv({ config: { IMPORT_TIME_BUDGET_SEC: '0' } });
  const whole = makeBatchEnv({});
  importOnce(whole);

  const first = importOnce(slow);
  assert.strictEqual(first.partial, true);
  assert.strictEqual(first.message, '已匯入 1／13 個主日，請再按一次繼續。');
  assert.ok(first.lines.some(function (l) { return l.indexOf('已匯入 1／13 個主日，請再按一次繼續。') !== -1; }), '對話框的行（填寫介面與選單同一句）');
  assertWrittenChinese(assert, '整季匯入對話框（時間預算用完）', first.lines.concat([first.message]));
  // 只寫了第一個主日，而且是完整的（BulletinWeeks 的 15 格＋兩張清單各一行）。
  const keys = slow.sandbox.COLUMNS.BULLETIN_WEEKS.keys;
  const sheet = slow.sheets.BulletinWeeks;
  const cell = function (rowNo, key) { return sheet.getRange(rowNo, keys.indexOf(key) + 1, 1, 1).getValue(); };
  assert.strictEqual(cell(3, 'SERMON_TITLE'), '講題 ' + DATES[0]);
  assert.strictEqual(cell(3, 'ATT_MAN_CHILD'), attendanceValue(0, 11));
  assert.strictEqual(cell(4, 'SERMON_TITLE'), '', '第二個主日一格都沒有寫');
  assert.strictEqual(cell(4, 'ATT_ENG_WORSHIP'), '');
  assert.strictEqual(slow.sandbox.readSheet_('Announcements').length, 1, '清單也只寫了第一個主日');
  assert.strictEqual(slow.sandbox.readSheet_('Prayers').length, 1);

  const second = importOnce(slow);
  assert.strictEqual(second.partial, true);
  assert.strictEqual(second.message, '已匯入 1／12 個主日，請再按一次繼續。', '第二次的計畫只剩 12 個主日');
  assert.strictEqual(cell(4, 'SERMON_TITLE'), '講題 ' + DATES[1], '第二次由第二個主日繼續');
  assert.strictEqual(cell(5, 'SERMON_TITLE'), '');

  let last = second;
  let rounds = 2;
  while (last.partial && rounds < 30) { last = importOnce(slow); rounds++; }
  assert.strictEqual(rounds, 13, '十三個主日按十三次');
  assert.strictEqual(last.partial, false);
  assert.strictEqual(last.message, '');
  assert.deepStrictEqual(snapshotOfData(slow), snapshotOfData(whole), '最後的工作表內容與一次做完相同');
  // AuditLog 的逐格記錄（不計版本與整季匯入的摘要行）與一次做完是同一批行（次序按主日分批，所以比較內容）。
  const importRows = function (env) {
    return auditRows(env).filter(function (r) { return r[1] === 'CONTENT_SHEET_IMPORT' || r[1] === 'FIELD_OVERRIDE_RELEASE'; })
      .map(function (r) { return JSON.stringify(r); }).sort();
  };
  assert.strictEqual(importRows(slow).length > 13 * 15, true);
  assert.deepStrictEqual(importRows(slow), importRows(whole));
  const snaps = function (env) { return snapshotRows(env).map(function (r) { return JSON.stringify(r); }).sort(); };
  assert.deepStrictEqual(snaps(slow), snaps(whole), '每個主日只存一個版本（不因為分幾次而多存或者漏存）');
});

test('B-10 預算 0、選單：只寫第一個主日，對話框講「已匯入 1／13 個主日，請再按一次繼續。」', function () {
  const env = makeBatchEnv({ config: { IMPORT_TIME_BUDGET_SEC: '0' } });
  env.sandbox.menuImportFromContentSheet_();
  const done = env.uiAlerts[env.uiAlerts.length - 1];
  assert.strictEqual(done.title, '匯入完成');
  assert.ok(done.body.indexOf('已匯入 1／13 個主日，請再按一次繼續。') !== -1, done.body);
  const keys = env.sandbox.COLUMNS.BULLETIN_WEEKS.keys;
  assert.strictEqual(env.sheets.BulletinWeeks.getRange(4, keys.indexOf('SERMON_TITLE') + 1, 1, 1).getValue(), '');
});

test('B-11 預算夠用（預設 240 秒）：一次做完，沒有 partial、沒有「請再按一次」', function () {
  const env = makeBatchEnv({});
  const r = importOnce(env);
  assert.strictEqual(r.partial, false);
  assert.strictEqual(r.message, '');
  assert.ok(!r.lines.some(function (l) { return l.indexOf('請再按一次') !== -1; }));
  assert.strictEqual(plain(r.progress).datesDone, 13);
});

test('B-12 預算原始值：空白、非數字、負數用預設 240 秒（不當作不限時）；0 合法', function () {
  const sb = makeBatchEnv({}).sandbox;
  assert.strictEqual(sb.parseContentImportBudgetSec_(''), 240);
  assert.strictEqual(sb.parseContentImportBudgetSec_('abc'), 240);
  assert.strictEqual(sb.parseContentImportBudgetSec_(-5), 240);
  assert.strictEqual(sb.parseContentImportBudgetSec_('Infinity'), 240);
  assert.strictEqual(sb.parseContentImportBudgetSec_('0'), 0);
  assert.strictEqual(sb.parseContentImportBudgetSec_(' 90 '), 90);
  assert.strictEqual(sb.contentImportBudgetMs_({}), 240000);
  assert.strictEqual(sb.contentImportBudgetMs_({ timeBudgetSec: 0 }), 0);
  assert.strictEqual(makeBatchEnv({ config: { IMPORT_TIME_BUDGET_SEC: '30' } }).sandbox.contentImportBudgetMs_({}), 30000);
});

test('B-13 自動同步 contentAutoSyncTrigger_（預算 0）：每次觸發只做一個主日，不記修改時間，AuditLog 摘要講明；全部做完才記修改時間；之後 UNCHANGED', function () {
  const slow = makeBatchEnv({ config: { IMPORT_TIME_BUDGET_SEC: '0' } });
  const whole = makeBatchEnv({});
  importOnce(whole);
  const keys = slow.sandbox.COLUMNS.BULLETIN_WEEKS.keys;
  const sermon = function (rowNo) { return slow.sheets.BulletinWeeks.getRange(rowNo, keys.indexOf('SERMON_TITLE') + 1, 1, 1).getValue(); };
  const mtimeProps = function () { return Object.keys(slow.props).filter(function (k) { return k.indexOf('CONTENT_SYNC_MTIME_') === 0; }); };
  const summaries = function () {
    return slow.sandbox.readSheet_('AuditLog').filter(function (r) { return r.ACTION === 'CONTENT_AUTO_SYNC'; });
  };

  slow.sandbox.contentAutoSyncTrigger_();
  assert.strictEqual(sermon(3), '講題 ' + DATES[0]);
  assert.strictEqual(sermon(4), '', '第二個主日這一次沒有做');
  assert.deepStrictEqual(mtimeProps(), [], '沒有做完：不記修改時間');
  assert.strictEqual(summaries().length, 1);
  assert.ok(String(summaries()[0].NOTES).indexOf('這一次只做了 1／13 個有改動的主日') !== -1, summaries()[0].NOTES);
  assert.ok(String(summaries()[0].NOTES).indexOf('下一次觸發繼續') !== -1);

  let guard = 0;
  while (mtimeProps().length === 0 && guard < 30) { slow.sandbox.contentAutoSyncTrigger_(); guard++; }
  assert.strictEqual(guard + 1, 13, '十三個主日，觸發十三次才做完：' + (guard + 1));
  assert.strictEqual(mtimeProps().length, 1, '做完才記修改時間');
  assert.deepStrictEqual(snapshotOfData(slow), snapshotOfData(whole));
  const statuses = plain(slow.sandbox.runContentAutoSync_({ source: 'TEST' })).quarters.map(function (q) { return q.status; });
  assert.deepStrictEqual(statuses, ['UNCHANGED']);
});

test('B-14 自動同步、預算夠用：一次觸發做完，記修改時間，與舊做法的工作表內容相同', function () {
  const neu = makeBatchEnv({});
  const old = makeBatchEnv({ legacy: true });
  neu.sandbox.contentAutoSyncTrigger_();
  old.sandbox.contentAutoSyncTrigger_();
  assert.strictEqual(Object.keys(neu.props).filter(function (k) { return k.indexOf('CONTENT_SYNC_MTIME_') === 0; }).length, 1);
  assert.deepStrictEqual(snapshotOfData(neu), snapshotOfData(old));
  assert.deepStrictEqual(auditRows(neu), auditRows(old), 'AuditLog（含自動同步摘要行）逐行相同');
});

test('B-15 apiAutoImportWeek（單週，真入口）：與舊做法的工作表內容、AuditLog 逐行相同', function () {
  const d = DATES[2];
  const neu = makeBatchEnv({});
  const old = makeBatchEnv({ legacy: true });
  const rn = neu.sandbox.apiAutoImportWeek(d);
  const ro = old.sandbox.apiAutoImportWeek(d);
  assert.strictEqual(rn.ok, true, JSON.stringify(rn.error));
  assert.strictEqual(ro.ok, true, JSON.stringify(ro.error));
  assert.ok(rn.data.autoImport.changed > 0);
  DATA_SHEETS.forEach(function (name) {
    assert.deepStrictEqual(dumpSheet(neu, name), dumpSheet(old, name), name);
  });
  assert.deepStrictEqual(auditRows(neu), auditRows(old));
  const keys = neu.sandbox.COLUMNS.BULLETIN_WEEKS.keys;
  assert.strictEqual(neu.sheets.BulletinWeeks.getRange(3, keys.indexOf('SERMON_TITLE') + 1, 1, 1).getValue(), '', '範圍外的主日一格不動');
});

test('B-16 解除覆寫（releases）與舊做法相同：AuditLog 的 FIELD_OVERRIDE_RELEASE 行內容與次序', function () {
  const env = makeBatchEnv({});
  const sb = env.sandbox;
  const sheet = env.sheets.FieldOverride;
  const def = sb.COLUMNS.FIELD_OVERRIDE;
  const mk = function (iso, field) {
    const row = {};
    def.keys.forEach(function (k) { row[k] = ''; });
    return Object.assign(row, { SERVICE_DATE: iso, FIELD_KEY: field, ACTIVE: true });
  };
  const keyOfField = def.keys.indexOf('FIELD_KEY') >= 0 ? 'FIELD_KEY' : def.keys[1];
  const rows = [mk(DATES[0], 'SERMON_TITLE'), mk(DATES[1], 'PRELUDE')];
  sheet.getRange(3, 1, 2, def.keys.length).setValues(rows.map(function (r) { return def.keys.map(function (k) { return r[k]; }); }));
  const releases = [
    { isoDate: DATES[0], field: 'SERMON_TITLE', overrideValue: '舊', row: { __rowNo: 3 } },
    { isoDate: DATES[1], field: 'PRELUDE', overrideValue: '', row: { __rowNo: 4 } }
  ];
  sb.releaseFieldOverrides_(releases);
  assert.ok(keyOfField);
  const log = sb.readSheet_('AuditLog').filter(function (r) { return r.ACTION === 'FIELD_OVERRIDE_RELEASE'; });
  assert.deepStrictEqual(plain(log.map(function (r) { return r.ROW_KEY; })), [DATES[0] + '#SERMON_TITLE', DATES[1] + '#PRELUDE']);
  assert.ok(String(log[1].NOTES).indexOf('（空白）') !== -1);
  assert.strictEqual(env.sheets.AuditLog.__calls.setValues, 1, '整批一次寫入');
  const activeCol = def.keys.indexOf('ACTIVE') + 1;
  assert.strictEqual(sheet.getRange(3, activeCol, 1, 1).getValue(), false);
  assert.strictEqual(sheet.getRange(4, activeCol, 1, 1).getValue(), false);
});

test('B-17 寫入途中拋錯：已經做完的主日照樣記 AuditLog，再把錯誤原樣拋出', function () {
  const env = makeBatchEnv({});
  const sb = env.sandbox;
  const real = sb.setRowCellsTextSafe_;
  let calls = 0;
  sb.setRowCellsTextSafe_ = function () {
    calls++;
    if (calls === 3) throw new Error('Service Spreadsheets timed out');
    return real.apply(this, arguments);
  };
  const resp = sb.apiRunQuarterContentImport(QUARTER_ID);
  assert.strictEqual(resp.ok, false);
  assert.ok(JSON.stringify(resp.error).indexOf('timed out') !== -1, JSON.stringify(resp.error));
  const logged = sb.readSheet_('AuditLog').filter(function (r) { return r.ACTION === 'CONTENT_SHEET_IMPORT' && r.SHEET_NAME === 'BulletinWeeks'; });
  const loggedDates = Array.from(new Set(logged.map(function (r) { return r.ROW_KEY; }))).sort();
  assert.deepStrictEqual(loggedDates, [DATES[0], DATES[1]], '前兩個主日（寫完了）有記錄，第三個（寫到一半拋錯）沒有');
});

console.log('\n通過 ' + pass + ' 項，失敗 ' + fail + ' 項。');
process.exit(fail === 0 ? 0 : 1);
