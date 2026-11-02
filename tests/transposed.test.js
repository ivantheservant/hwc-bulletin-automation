#!/usr/bin/env node
/**
 * tests/transposed.test.js
 *
 * 2026-11-03（Ivan）：內容表「崇拜人數」由日子橫放（2026-10-30 至 11-03）**改回一個崇拜日期一行**，與家事報告、
 *   代禱事項一致；合堂三格是「有效」之前的三欄。
 *   - 仍然是橫放的內容表：匯入照常（按橫放讀），只出提示；
 *   - 「更新本季內容表…」先預覽，確定之後改回一個日期一行（舊分頁改名隱藏保留，一格不改）；
 *   - 自動流程不替人改版面（ErrorLog 講明）。
 *
 * 一律經真正入口：apiPreviewContentSheetBuild／apiRunContentSheetBuild、apiRunQuarterContentImport、
 * weeklyBulletinSendTrigger_。
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

function attRows() {
  return DATES.map(function (iso, i) {
    return {
      SERVICE_DATE: minus7(iso), ATT_ENG_WORSHIP: String(50 + i), ATT_CANE_WORSHIP: i === 0 ? '1,024' : '',
      ATT_COMB_WORSHIP: i === 2 ? '231' : '', ACTIVE: 'TRUE'
    };
  });
}

/** 2026-10-30 至 11-03 建的日子橫放內容表（2028T3、2028T4、2026T3、2026T4、2027T1 現在的樣子）。 */
function makeTransposedEnv(extra, layout) {
  return contentEnv.makeEnv(Object.assign({
    attendanceLayout: layout || 'transposed',
    content: { 崇拜人數: attRows() }
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

/** 一個日期一行的分頁：那一日那一欄的值。 */
function rowCell(sheet, key, iso) {
  const c = sheet.__data[1].indexOf(key);
  const r = sheet.__data.findIndex(function (row, i) { return i >= 2 && row[0] === iso; });
  return r === -1 || c === -1 ? undefined : sheet.__data[r][c];
}

const TRANSPOSED_NOTICE = '內容表「崇拜人數」仍然是日子橫放（每一個崇拜日期一欄），請按「更新本季內容表…」改回一個崇拜日期一行'
  + '（與家事報告、代禱事項一致，已經填好的人數照搬）；未改之前人數照常匯入。';

console.log('\n崇拜人數改回一個崇拜日期一行（真入口）');

test('R-1 仍然是日子橫放：匯入照常（十二格與合堂三格都匯入「加七天」那一期），結果講明要按「更新本季內容表…」改回', function () {
  const env = makeTransposedEnv();
  assert.strictEqual(env.sandbox.detectAttendanceTabLayout_(env.contentTabs['崇拜人數'], attDef(env)), 'TRANSPOSED');
  const imp = env.sandbox.apiRunQuarterContentImport(QUARTER_ID);
  assert.strictEqual(imp.data.ok, true, JSON.stringify(imp.data));
  assert.ok(imp.data.lines.indexOf('⚠️ ' + TRANSPOSED_NOTICE) !== -1, imp.data.lines.join('\n'));
  assert.strictEqual(String(weekOf(env, D1).ATT_ENG_WORSHIP), '50');
  assert.strictEqual(String(weekOf(env, D1).ATT_CANE_WORSHIP), '1,024');
  assert.strictEqual(String(weekOf(env, DATES[2]).ATT_COMB_WORSHIP), '231');
  assertWrittenChinese(assert, '提示', [TRANSPOSED_NOTICE]);
});

test('R-2 預覽：講明會由日子橫放改回一個崇拜日期一行、舊分頁改名隱藏保留；要人手確認；預覽一格不寫', function () {
  const env = makeTransposedEnv();
  const before = snapshot(env);
  const resp = env.sandbox.apiPreviewContentSheetBuild(QUARTER_ID);
  assert.strictEqual(resp.ok, true, JSON.stringify(resp));
  const text = resp.data.lines.join('\n');
  ['・「崇拜人數」會由日子橫放改回一個崇拜日期一行（與家事報告、代禱事項一致，共 ' + DATES.length + ' 行）；已經填好的人數照搬。',
    '舊分頁會改名「崇拜人數（整理前，已停用）」隱藏保留'].forEach(function (p) {
    assert.ok(text.indexOf(p) !== -1, '預覽缺少：' + p + '\n' + text);
  });
  assert.strictEqual(text.indexOf('加上 3 欄'), -1, '橫放分頁已經有合堂三行，不用講加欄：' + text);
  assert.strictEqual(resp.data.summary.needsMigration, true, '版面改變要人手確認');
  assertWrittenChinese(assert, '預覽', resp.data.lines);
  assert.strictEqual(snapshot(env), before, '預覽一格不寫');
});

test('R-3 確定：新分頁一個崇拜日期一行（第 2 行＝現行機器鍵）、人數照搬（千分位、合堂三格）、日期鎖住只可以改 B3 起；舊分頁改名隱藏，一格不改；之後匯入不再提示', function () {
  const env = makeTransposedEnv();
  const oldData = plain(env.contentTabs['崇拜人數'].__data);
  const resp = env.sandbox.apiRunContentSheetBuild(QUARTER_ID);
  assert.strictEqual(resp.ok, true, JSON.stringify(resp));
  assert.strictEqual(resp.data.ok, true, JSON.stringify(resp.data));
  const retired = env.contentSpreadsheet.getSheetByName('崇拜人數（整理前，已停用）');
  assert.ok(retired, '舊分頁改名保留');
  assert.strictEqual(retired.isSheetHidden(), true);
  assert.deepStrictEqual(plain(retired.__data), oldData, '舊分頁資料一格不改');
  const sheet = env.contentSpreadsheet.getSheetByName('崇拜人數');
  const def = attDef(env);
  assert.deepStrictEqual(plain(sheet.__data[1].slice(0, def.keys.length)), plain(def.keys));
  assert.deepStrictEqual(plain(sheet.__data[0].slice(0, def.headers.length)), plain(def.headers));
  assert.strictEqual(env.sandbox.detectAttendanceTabLayout_(sheet, def), 'ROWS');
  assert.deepStrictEqual(plain(sheet.__data.slice(2).map(function (r) { return r[0]; })), DATES.map(minus7));
  DATES.forEach(function (iso, i) { assert.strictEqual(rowCell(sheet, 'ATT_ENG_WORSHIP', minus7(iso)), String(50 + i)); });
  assert.strictEqual(rowCell(sheet, 'ATT_CANE_WORSHIP', minus7(D1)), '1,024', '千分位原樣');
  assert.strictEqual(rowCell(sheet, 'ATT_COMB_WORSHIP', minus7(DATES[2])), '231', '合堂三格照搬');
  assert.strictEqual(rowCell(sheet, 'ACTIVE', minus7(D1)), 'TRUE');
  assert.strictEqual(sheet.getFrozenRows(), 2);
  const lock = sheet.__protections.filter(function (p) { return p.description === env.sandbox.CONTENT_SHEET_V4_LOCK_DESCRIPTION_; });
  assert.strictEqual(lock.length, 1);
  assert.deepStrictEqual(plain(lock[0].unprotected.map(function (r) { return [r.getRow(), r.getColumn(), r.getNumRows(), r.getNumColumns()]; })),
    [[3, 2, DATES.length, def.keys.length - 1]]);
  const imp = env.sandbox.apiRunQuarterContentImport(QUARTER_ID);
  assert.strictEqual(imp.data.ok, true, JSON.stringify(imp.data));
  assert.strictEqual(imp.data.lines.join('\n').indexOf('日子橫放'), -1, '改回之後不再提示');
  assert.strictEqual(String(weekOf(env, D2).ATT_ENG_WORSHIP), '51');
  assert.strictEqual(String(weekOf(env, DATES[2]).ATT_COMB_WORSHIP), '231');
  const audits = env.sandbox.readSheet_('AuditLog').filter(function (a) { return a.ACTION === 'CONTENT_SHEET_MIGRATE_V4' && a.FIELD === '完成'; });
  assert.strictEqual(audits.length, 1);
  assert.ok(String(audits[0].NEW_VALUE).indexOf('崇拜人數 ' + DATES.length + ' 行') !== -1, audits[0].NEW_VALUE);
});

test('R-4 再按一次「更新本季內容表…」：一格不改（冪等）；同工填的人數保留', function () {
  const env = makeTransposedEnv();
  assert.strictEqual(env.sandbox.apiRunContentSheetBuild(QUARTER_ID).data.ok, true);
  const sheet = env.contentSpreadsheet.getSheetByName('崇拜人數');
  const r = sheet.__data.findIndex(function (row, i) { return i >= 2 && row[0] === minus7(D2); }) + 1;
  sheet.getRange(r, sheet.__data[1].indexOf('ATT_MAN_PRAYER') + 1).setValue('8');
  const before = snapshot(env);
  assert.strictEqual(env.sandbox.apiRunContentSheetBuild(QUARTER_ID).data.ok, true);
  assert.strictEqual(snapshot(env), before);
  assert.strictEqual(env.contentSpreadsheet.getSheetByName('崇拜人數（整理前，已停用）2'), null, '不會再整理一次');
});

test('R-5 自動流程（星期一 weeklyBulletinSendTrigger_）不替人改版面：一格不寫，ErrorLog 只講「崇拜人數」要改回一個崇拜日期一行', function () {
  const env = makeTransposedEnv({ config: { CONTENT_SHEET_INVITE_LEAD_DAYS: '100000', DRY_RUN: 'TRUE' } });
  const before = snapshot(env);
  env.sandbox.weeklyBulletinSendTrigger_();
  assert.strictEqual(snapshot(env), before, '一格不寫');
  const errs = env.sandbox.readSheet_('ErrorLog').filter(function (r) { return r.ERROR_CODE === 'CONTENT_SHEET_NEEDS_MIGRATION'; });
  assert.strictEqual(errs.length, 1, JSON.stringify(plain(env.sandbox.readSheet_('ErrorLog'))));
  assert.ok(errs[0].MESSAGE.indexOf('要先更新：「崇拜人數」由日子橫放改回一個崇拜日期一行') !== -1, errs[0].MESSAGE);
  assert.strictEqual(errs[0].MESSAGE.indexOf('「崇拜程序」只留'), -1, '崇拜程序已經是新版，不用講：' + errs[0].MESSAGE);
  assertWrittenChinese(assert, 'ErrorLog', [errs[0].MESSAGE]);
});

test('R-6 2026-11-02 之前的橫放（未有合堂三行）：匯入照常、合堂三格不碰並講明；更新改回一個日期一行並加上合堂三欄', function () {
  const env = makeTransposedEnv({}, 'transposedShort');
  assert.strictEqual(env.sandbox.detectAttendanceTabLayout_(env.contentTabs['崇拜人數'], attDef(env)), 'TRANSPOSED_SHORT');
  env.sandbox.writeBulletinWeekField_(DATES[3], 'ATT_COMB_WORSHIP', '199');
  const imp = env.sandbox.apiRunQuarterContentImport(QUARTER_ID);
  assert.strictEqual(imp.data.ok, true, JSON.stringify(imp.data));
  assert.ok(imp.data.lines.join('\n').indexOf('但合堂三格不會匯入（這張分頁未有合堂三行）') !== -1, imp.data.lines.join('\n'));
  assert.strictEqual(String(weekOf(env, DATES[3]).ATT_COMB_WORSHIP), '199', '少了的行不讀，週報那一格不碰');
  const preview = env.sandbox.apiPreviewContentSheetBuild(QUARTER_ID).data.lines.join('\n');
  assert.ok(preview.indexOf('・「崇拜人數」會加上 3 欄：合堂崇拜、合堂祈禱會、合堂兒童（在「有效」之前；合堂主日那一行只填合堂三格，其餘留空）。') !== -1, preview);
  assert.strictEqual(env.sandbox.apiRunContentSheetBuild(QUARTER_ID).data.ok, true);
  const sheet = env.contentSpreadsheet.getSheetByName('崇拜人數');
  assert.strictEqual(env.sandbox.detectAttendanceTabLayout_(sheet, attDef(env)), 'ROWS');
  assert.strictEqual(rowCell(sheet, 'ATT_COMB_WORSHIP', minus7(DATES[3])), '');
  assert.strictEqual(rowCell(sheet, 'ATT_ENG_WORSHIP', minus7(DATES[3])), '53');
});

test('R-7 新建的內容表一開始就是一個崇拜日期一行；一格被試算表轉成日期 → 警告講「第 3 行」，那一格不匯入', function () {
  const env = contentEnv.makeEnv({ content: { 崇拜人數: [{ SERVICE_DATE: minus7(D1), ATT_ENG_WORSHIP: '41', ATT_CANE_WORSHIP: '', ACTIVE: 'TRUE' }] } });
  const sheet = env.contentTabs['崇拜人數'];
  assert.strictEqual(env.sandbox.detectAttendanceTabLayout_(sheet, attDef(env)), 'ROWS');
  sheet.__data[2][sheet.__data[1].indexOf('ATT_CANE_WORSHIP')] = new Date(1900, 0, 14); // 被試算表轉了
  const imp = env.sandbox.apiRunQuarterContentImport(QUARTER_ID);
  assert.strictEqual(imp.data.ok, true, JSON.stringify(imp.data));
  const warn = imp.data.lines.join('\n');
  assert.ok(warn.indexOf('「崇拜人數」第 3 行「粵語堂東區崇拜」被試算表轉成日期／時間') !== -1, warn);
  assert.strictEqual(String(weekOf(env, D1).ATT_ENG_WORSHIP), '41');
});

test('R-8 橫放而第 A、B 欄被清走：匯入整次拒絕並講明；更新照資料位置改回一個日期一行，人數照搬', function () {
  const env = makeTransposedEnv();
  const sheet = env.contentTabs['崇拜人數'];
  const rows = attDef(env).keys.length - 1;
  sheet.getRange(1, 1, rows, 2).clearContent();
  assert.strictEqual(env.sandbox.detectAttendanceTabLayout_(sheet, attDef(env)), 'TRANSPOSED_NO_HEAD');
  const imp = env.sandbox.apiRunQuarterContentImport(QUARTER_ID);
  assert.strictEqual(imp.data.ok, false, JSON.stringify(imp.data));
  assert.ok(String(imp.data.message).indexOf('「崇拜人數」（日子橫放）第 A、B 欄（標題）被清走了') !== -1, imp.data.message);
  assert.strictEqual(env.sandbox.apiRunContentSheetBuild(QUARTER_ID).data.ok, true);
  const now = env.contentSpreadsheet.getSheetByName('崇拜人數');
  assert.strictEqual(rowCell(now, 'ATT_ENG_WORSHIP', minus7(DATES[4])), '54');
  assert.strictEqual(env.sandbox.apiRunQuarterContentImport(QUARTER_ID).data.ok, true);
});

test('R-9 「連續到」跨季：上一季的崇拜人數是哪一個版面都不影響家事報告帶入本季（只核對有「連續到」的分頁）', function () {
  const env = contentEnv.makeEnv({
    otherContentSheets: [{
      quarterId: '2027T3', fileId: 'FILE_PREV',
      content: { 家事報告: [{ SERVICE_DATE: minus7(D1), REPEAT_UNTIL: D2, ACTIVE: 'TRUE', SEQ_NO: '10', TEXT: '上一季連續' }] }
    }]
  });
  assert.strictEqual(env.sandbox.detectAttendanceTabLayout_(env.otherSpreadsheets.FILE_PREV.getSheetByName('崇拜人數'), attDef(env)), 'ROWS_LEGACY');
  const imp = env.sandbox.apiRunQuarterContentImport(QUARTER_ID);
  assert.strictEqual(imp.data.ok, true, JSON.stringify(imp.data));
  assert.strictEqual(imp.data.lines.join('\n').indexOf('版面未更新'), -1, imp.data.lines.join('\n'));
  const ann = env.sandbox.readSheet_('Announcements').filter(function (a) {
    return env.sandbox.formatIsoDate_(a.SERVICE_DATE) === D1 && String(a.ACTIVE).toUpperCase() !== 'FALSE';
  });
  assert.ok(ann.some(function (a) { return a.TEXT === '上一季連續'; }), JSON.stringify(plain(ann)));
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
