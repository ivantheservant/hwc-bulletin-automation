#!/usr/bin/env node
/**
 * tests/transposed.test.js
 *
 * 2026-10-30（Ivan）：內容表「崇拜人數」改為日子橫放（src/ContentSheetTransposed.gs）——第 1 行全部是崇拜日期
 *   （每一日一欄），十二格人數在日期下面。Ivan 選「自動轉換（先預覽）」：舊的一個日期一行由「更新本季內容表…」
 *   轉換（先預覽，確定之後舊分頁改名隱藏保留）；轉換之前匯入整次拒絕；自動流程不替人轉換。
 *
 * 一律經真正入口：apiPreviewContentSheetBuild／apiRunContentSheetBuild、apiRunQuarterContentImport、
 * weeklyBulletinSendTrigger_、apiLoadWeek。
 *
 * 執行方式：node tests/transposed.test.js
 * 離開碼：0＝全部通過　1＝有測試失敗
 */

'use strict';

const assert = require('assert');
const contentEnv = require('./helpers/contentEnv');
const { assertWrittenChinese } = require('./helpers/writtenChinese');

const QUARTER_ID = contentEnv.QUARTER_ID;
const DATES = contentEnv.SERVICE_DATES;
const [D1, D2] = DATES;

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

function plain(v) { return JSON.parse(JSON.stringify(v)); }

function minus7(iso) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - 7);
  return d.toISOString().slice(0, 10);
}

/** 一份其餘分頁已經是新版、只有「崇拜人數」仍然是一個日期一行的內容表（2028T3 現在的樣子）。 */
function makeRowsEnv(extra) {
  return contentEnv.makeEnv(Object.assign({
    attendanceLayout: 'rows',
    content: {
      崇拜人數: DATES.map(function (iso, i) {
        return { SERVICE_DATE: minus7(iso), ATT_ENG_WORSHIP: String(50 + i), ATT_CANE_WORSHIP: i === 0 ? '1,024' : '', ACTIVE: 'TRUE' };
      })
    }
  }, extra || {}));
}

function snapshot(env) {
  return JSON.stringify(env.contentSpreadsheet.getSheets().map(function (s) {
    return { name: s.getName(), hidden: s.isSheetHidden(), data: s.__data };
  }));
}

function weekOf(env, iso) {
  return env.sandbox.readSheet_('BulletinWeeks').filter(function (r) { return env.sandbox.formatIsoDate_(r.SERVICE_DATE) === iso; })[0];
}

function attDef(env) {
  return env.sandbox.contentSheetTabDefs_().filter(function (d) { return d.tabName === '崇拜人數'; })[0];
}

function cellOf(sheet, key, iso) {
  const r = sheet.__data.findIndex(function (row) { return row[1] === key; });
  const c = sheet.__data[0].indexOf(iso);
  return r === -1 || c === -1 ? undefined : sheet.__data[r][c];
}

console.log('\n崇拜人數日子橫放（真入口）');

test('T-1 轉換之前：匯入整次拒絕，講明「崇拜人數」未改為日子橫放、要按「更新本季內容表…」；週報一格不寫', function () {
  const env = makeRowsEnv();
  const imp = env.sandbox.apiRunQuarterContentImport(QUARTER_ID);
  assert.strictEqual(imp.data.ok, false, JSON.stringify(imp.data));
  ['「崇拜人數」未改為日子橫放（每一個崇拜日期一欄）', '更新本季內容表…'].forEach(function (p) {
    assert.ok(String(imp.data.message).indexOf(p) !== -1, imp.data.message);
  });
  assert.strictEqual(String(weekOf(env, D1).ATT_ENG_WORSHIP || ''), '');
});

test('T-2 預覽：講明會改為日子橫放、舊分頁改名隱藏保留；預覽一格不寫', function () {
  const env = makeRowsEnv();
  const before = snapshot(env);
  const resp = env.sandbox.apiPreviewContentSheetBuild(QUARTER_ID);
  assert.strictEqual(resp.ok, true, JSON.stringify(resp));
  const text = resp.data.lines.join('\n');
  ['「崇拜人數」會改為日子橫放：第 1 行是崇拜日期（每一日一欄，共 ' + DATES.length + ' 欄）', '已經填好的人數照搬',
    '「崇拜人數（整理前，已停用）」隱藏保留'].forEach(function (p) {
    assert.ok(text.indexOf(p) !== -1, '預覽缺少：' + p + '\n' + text);
  });
  assertWrittenChinese(assert, '預覽', resp.data.lines);
  assert.strictEqual(snapshot(env), before, '預覽一格不寫');
});

test('T-3 確定轉換：新分頁日子橫放、人數照搬（千分位不變）、B 欄隱藏、只可以改 C2 起；舊分頁改名隱藏，一格不改；之後匯入正常', function () {
  const env = makeRowsEnv();
  const oldData = plain(env.contentTabs['崇拜人數'].__data);
  const resp = env.sandbox.apiRunContentSheetBuild(QUARTER_ID);
  assert.strictEqual(resp.ok, true, JSON.stringify(resp));
  assert.strictEqual(resp.data.ok, true, JSON.stringify(resp.data));
  const retired = env.contentSpreadsheet.getSheetByName('崇拜人數（整理前，已停用）');
  assert.ok(retired, '舊分頁改名保留');
  assert.strictEqual(retired.isSheetHidden(), true);
  assert.deepStrictEqual(plain(retired.__data), oldData, '舊分頁資料一格不改');
  const sheet = env.contentSpreadsheet.getSheetByName('崇拜人數');
  assert.deepStrictEqual(plain(sheet.__data[0].slice(0, 2 + DATES.length)), ['崇拜日期', 'SERVICE_DATE'].concat(DATES.map(minus7)));
  assert.strictEqual(env.sandbox.detectTransposedTabLayout_(sheet, attDef(env)), 'TRANSPOSED');
  DATES.forEach(function (iso, i) { assert.strictEqual(cellOf(sheet, 'ATT_ENG_WORSHIP', minus7(iso)), String(50 + i)); });
  assert.strictEqual(cellOf(sheet, 'ATT_CANE_WORSHIP', minus7(D1)), '1,024', '千分位原樣');
  assert.strictEqual(sheet.isColumnHiddenByUser(2), true);
  assert.strictEqual(sheet.getFrozenRows(), 1);
  assert.strictEqual(sheet.getFrozenColumns(), 2);
  const lock = sheet.__protections.filter(function (p) { return p.description === env.sandbox.CONTENT_SHEET_V4_LOCK_DESCRIPTION_; });
  assert.strictEqual(lock.length, 1);
  assert.deepStrictEqual(plain(lock[0].unprotected.map(function (r) { return [r.getRow(), r.getColumn(), r.getNumRows(), r.getNumColumns()]; })),
    [[2, 3, 12, DATES.length]]);
  const imp = env.sandbox.apiRunQuarterContentImport(QUARTER_ID);
  assert.strictEqual(imp.data.ok, true, JSON.stringify(imp.data));
  // 崇拜日期 + 7 日＝印這一日人數的那一期週報。
  assert.strictEqual(String(weekOf(env, D1).ATT_ENG_WORSHIP), '50');
  assert.strictEqual(String(weekOf(env, D1).ATT_CANE_WORSHIP), '1,024');
  assert.strictEqual(String(weekOf(env, D2).ATT_ENG_WORSHIP), '51');
  const audits = env.sandbox.readSheet_('AuditLog').filter(function (a) { return a.ACTION === 'CONTENT_SHEET_MIGRATE_V4' && a.FIELD === '完成'; });
  assert.strictEqual(audits.length, 1);
  assert.ok(String(audits[0].NEW_VALUE).indexOf('崇拜人數 ' + DATES.length + ' 個日期') !== -1, audits[0].NEW_VALUE);
});

test('T-4 再按一次「更新本季內容表…」：一格不改（冪等）；同工填的人數保留', function () {
  const env = makeRowsEnv();
  assert.strictEqual(env.sandbox.apiRunContentSheetBuild(QUARTER_ID).data.ok, true);
  const sheet = env.contentSpreadsheet.getSheetByName('崇拜人數');
  const r = sheet.__data.findIndex(function (row) { return row[1] === 'ATT_MAN_PRAYER'; }) + 1;
  sheet.getRange(r, 4).setValue('8');
  const before = snapshot(env);
  assert.strictEqual(env.sandbox.apiRunContentSheetBuild(QUARTER_ID).data.ok, true);
  assert.strictEqual(snapshot(env), before);
  assert.strictEqual(env.contentSpreadsheet.getSheetByName('崇拜人數（整理前，已停用）2'), null, '不會再轉換一次');
});

test('T-5 自動流程（星期一 weeklyBulletinSendTrigger_）不替人轉換：一格不寫，ErrorLog 只講「崇拜人數」要改為日子橫放', function () {
  const env = makeRowsEnv({ config: { CONTENT_SHEET_INVITE_LEAD_DAYS: '100000', DRY_RUN: 'TRUE' } });
  const before = snapshot(env);
  env.sandbox.weeklyBulletinSendTrigger_();
  assert.strictEqual(snapshot(env), before, '一格不寫');
  const errs = env.sandbox.readSheet_('ErrorLog').filter(function (r) { return r.ERROR_CODE === 'CONTENT_SHEET_NEEDS_MIGRATION'; });
  assert.strictEqual(errs.length, 1, JSON.stringify(plain(env.sandbox.readSheet_('ErrorLog'))));
  assert.ok(errs[0].MESSAGE.indexOf('「崇拜人數」改為日子橫放') !== -1, errs[0].MESSAGE);
  assert.strictEqual(errs[0].MESSAGE.indexOf('「崇拜程序」只留'), -1, '崇拜程序已經是新版，不用講：' + errs[0].MESSAGE);
  assertWrittenChinese(assert, 'ErrorLog', [errs[0].MESSAGE]);
});

test('T-6 新建的內容表一開始就是日子橫放；一格被試算表轉成日期 → 警告講「第 D 欄」，那一格不匯入', function () {
  const env = contentEnv.makeEnv({});
  const sheet = env.contentTabs['崇拜人數'];
  // 預設的假內容表已經是橫放：C 欄起每一筆一欄。
  assert.strictEqual(env.sandbox.detectTransposedTabLayout_(sheet, attDef(env)), 'TRANSPOSED');
  sheet.insertColumnsAfter(2, 2);
  sheet.getRange(1, 3, 1, 2).setValues([[minus7(D1), minus7(D2)]]);
  const r = sheet.__data.findIndex(function (row) { return row[1] === 'ATT_ENG_WORSHIP'; }) + 1;
  sheet.getRange(r, 3).setValue('41');
  sheet.__data[r - 1][3] = new Date(1900, 0, 14); // D 欄被試算表轉了
  const imp = env.sandbox.apiRunQuarterContentImport(QUARTER_ID);
  assert.strictEqual(imp.data.ok, true, JSON.stringify(imp.data));
  const warn = imp.data.lines.join('\n');
  assert.ok(warn.indexOf('「崇拜人數」第 D 欄「英語堂崇拜」被試算表轉成日期／時間') !== -1, warn);
  assert.strictEqual(String(weekOf(env, D1).ATT_ENG_WORSHIP), '41');
});

test('T-7 「連續到」跨季：上一季的崇拜人數仍然是一個日期一行，不影響家事報告帶入本季（只核對有「連續到」的分頁）', function () {
  const env = contentEnv.makeEnv({
    otherContentSheets: [{
      quarterId: '2027T3', fileId: 'FILE_PREV',
      content: { 家事報告: [{ SERVICE_DATE: minus7(D1), REPEAT_UNTIL: D2, ACTIVE: 'TRUE', SEQ_NO: '10', TEXT: '上一季連續' }] }
    }]
  });
  const prev = env.sandbox.previousQuarterId_(QUARTER_ID);
  assert.strictEqual(prev, '2027T3');
  assert.strictEqual(env.sandbox.detectTransposedTabLayout_(env.otherSpreadsheets.FILE_PREV.getSheetByName('崇拜人數'), attDef(env)), 'ROWS',
    '上一季的崇拜人數仍然是一個日期一行');
  const imp = env.sandbox.apiRunQuarterContentImport(QUARTER_ID);
  assert.strictEqual(imp.data.ok, true, JSON.stringify(imp.data));
  const warn = imp.data.lines.join('\n');
  assert.strictEqual(warn.indexOf('版面未更新'), -1, warn);
  const ann = env.sandbox.readSheet_('Announcements').filter(function (a) {
    return env.sandbox.formatIsoDate_(a.SERVICE_DATE) === D1 && String(a.ACTIVE).toUpperCase() !== 'FALSE';
  });
  assert.ok(ann.some(function (a) { return a.TEXT === '上一季連續'; }), JSON.stringify(plain(ann)));
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
