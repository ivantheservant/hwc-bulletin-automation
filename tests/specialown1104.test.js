#!/usr/bin/env node
/**
 * tests/specialown1104.test.js
 *
 * 2026-11-04（Ivan 測試結果 C）：特別崇拜可以有自己的家事報告等，不用改上一個主日的內容表。
 *   `BulletinWeeks.SPECIAL_CONTENT_SOURCE='OWN'`（src/SpecialService.gs）：
 *   - 家事報告、代禱事項、團契、財政報告讀這一日自己的（內容表四張清單分頁的「主日」選這一日）；
 *   - 上週崇拜人數仍然跟上一個主日；崇拜程序（讀經經文等三欄）仍然在介面填，匯入一格不碰；
 *   - 「連續到」包括這一日的行亦會出現；
 *   - 預設（空白）＝跟上一個主日，與以前一樣。
 *
 *   ⚠️ bug class 5：經真正入口 apiCreateSpecialService、apiAutoImportWeek、apiLoadWeek、apiSetSpecialContentSource。
 *
 * 執行方式：node tests/specialown1104.test.js
 */

'use strict';

const assert = require('assert');
const contentEnv = require('./helpers/contentEnv');
const { assertWrittenChinese } = require('./helpers/writtenChinese');

let pass = 0;
let fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); } catch (err) {
    fail++; console.log('  ✗ ' + name); console.log('    ' + (err && err.stack ? err.stack.split('\n').slice(0, 6).join('\n    ') : err));
  }
}
function plain(v) { return JSON.parse(JSON.stringify(v)); }

const Q = contentEnv.QUARTER_ID;
const SUNDAYS = contentEnv.SERVICE_DATES;          // 2027-10-03 … 2027-10-31
const FRI = '2027-10-15';
const PREV = '2027-10-10';

function makeEnv(specialSource) {
  const weekRows = SUNDAYS.map(function (iso, i) {
    const row = { SERVICE_DATE: iso, QUARTER_ID: Q, WEEK_OF_MONTH: (i % 4) + 1, STATUS: 'DRAFT' };
    if (iso === PREV) Object.assign(row, { ATT_ENG_WORSHIP: '77', ATTENDANCE_DATE: '2027-10-03' });
    return row;
  });
  if (specialSource !== null) {
    weekRows.push({ SERVICE_DATE: FRI, QUARTER_ID: Q, WEEK_OF_MONTH: '', STATUS: 'DRAFT', SERVICE_KIND: 'SPECIAL',
      SPECIAL_TYPE: '受苦節崇拜', PAGE_TITLE: '受苦節崇拜', SERMON_TITLE: '介面填的講題', SPECIAL_CONTENT_SOURCE: specialSource });
  }
  const env = contentEnv.makeEnv({
    weekRows: weekRows,
    config: { WEBAPP_SIMULATED_TODAY: '2027-10-12' },
    content: {
      家事報告: [
        { SERVICE_DATE: PREV, SEQ_NO: '10', TEXT: '主日的報告', ACTIVE: 'TRUE' },
        { SERVICE_DATE: PREV, REPEAT_UNTIL: '2027-10-24', SEQ_NO: '20', TEXT: '連續三週的報告', ACTIVE: 'TRUE' },
        { SERVICE_DATE: FRI, SEQ_NO: '5', TEXT: '受苦節自己的報告', ACTIVE: 'TRUE' }
      ],
      代禱事項: [{ SERVICE_DATE: FRI, SEQ_NO: '10', TEXT: '受苦節代禱', ACTIVE: 'TRUE' }]
    }
  });
  // 內容表下拉：記下選項，方便核對。
  env.sandbox.SpreadsheetApp.newDataValidation = function () {
    const b = { __values: null, requireValueInList: function (v) { b.__values = v.slice(); return b; },
      setAllowInvalid: function () { return b; }, build: function () { return { values: b.__values }; } };
    return b;
  };
  return env;
}

function activeTexts(sb, sheet, iso) {
  return Array.from(sb.readSheet_(sheet)
    .filter(function (r) { return r.ACTIVE === true && sb.formatIsoDate_(r.SERVICE_DATE) === iso; })
    .sort(function (a, b) { return Number(a.SEQ_NO) - Number(b.SEQ_NO); })
    .map(function (r) { return r.TEXT; }));
}
function weekRow(sb, iso) {
  return sb.readSheet_('BulletinWeeks').filter(function (r) { return sb.formatIsoDate_(r.SERVICE_DATE) === iso; })[0];
}

console.log('\n另外填寫（OWN）');

test('SO-1 自動匯入（apiAutoImportWeek）：這一日的家事報告、代禱事項由內容表匯入，包括「連續到」的行；讀經經文等三欄一格不碰', function () {
  const sb = makeEnv('OWN').sandbox;
  const r = sb.apiAutoImportWeek(FRI);
  assert.strictEqual(r.ok, true, JSON.stringify(r.error));
  assert.notStrictEqual(r.data.autoImport.reason, 'SPECIAL_SERVICE');
  assert.ok(r.data.autoImport.changed > 0, JSON.stringify(r.data.autoImport));
  assert.deepStrictEqual(activeTexts(sb, 'Announcements', FRI), ['受苦節自己的報告', '連續三週的報告']);
  assert.deepStrictEqual(activeTexts(sb, 'Prayers', FRI), ['受苦節代禱']);
  assert.strictEqual(weekRow(sb, FRI).SERMON_TITLE, '介面填的講題', '崇拜程序不匯入特別崇拜');
  assert.deepStrictEqual(activeTexts(sb, 'Announcements', PREV), [], '單週匯入只改這一日');
});

test('SO-2 載入（apiLoadWeek）與資料模型：清單是這一日自己的；上週崇拜人數跟上一個主日；readOnly.specialService.ownContent', function () {
  const sb = makeEnv('OWN').sandbox;
  sb.apiAutoImportWeek(FRI);
  const loaded = sb.apiLoadWeek(FRI);
  assert.strictEqual(loaded.ok, true, JSON.stringify(loaded.error));
  const d = loaded.data;
  assert.deepStrictEqual(plain(d.lists.announcements).map(function (a) { return a.TEXT; }), ['受苦節自己的報告', '連續三週的報告']);
  assert.strictEqual(d.readOnly.specialService.ownContent, true);
  assert.strictEqual(d.readOnly.specialService.contentSourceIso, PREV);
  assert.strictEqual(String(d.week.ATT_ENG_WORSHIP), '77', '人數跟上一個主日');
  const model = sb.buildBulletinModel_(FRI);
  assert.deepStrictEqual(plain(model.announcements).map(function (a) { return a.text; }), ['受苦節自己的報告', '連續三週的報告']);
});

test('SO-3 整季匯入：主日照常；特別崇拜那一日只有清單；主日的報告不會走去特別崇拜', function () {
  const sb = makeEnv('OWN').sandbox;
  const p = sb.previewContentImport_(Q, {});
  assert.strictEqual(p.ok, true, p.message);
  sb.applyContentImport_(Q, {});
  assert.deepStrictEqual(activeTexts(sb, 'Announcements', PREV), ['主日的報告', '連續三週的報告']);
  assert.deepStrictEqual(activeTexts(sb, 'Announcements', '2027-10-17'), ['連續三週的報告']);
  assert.deepStrictEqual(activeTexts(sb, 'Announcements', FRI), ['受苦節自己的報告', '連續三週的報告']);
  assert.strictEqual(weekRow(sb, FRI).SERMON_TITLE, '介面填的講題');
});

console.log('\n跟上一個主日（預設）');

test('SO-4 預設（空白）：不匯入特別崇拜；清單跟上一個主日，與以前一樣', function () {
  const sb = makeEnv('').sandbox;
  const r = sb.apiAutoImportWeek(FRI);
  assert.strictEqual(r.data.autoImport.reason, 'SPECIAL_SERVICE');
  assert.deepStrictEqual(activeTexts(sb, 'Announcements', FRI), []);
  sb.apiAutoImportWeek(PREV);
  const loaded = sb.apiLoadWeek(FRI).data;
  assert.strictEqual(loaded.readOnly.specialService.ownContent, false);
  assert.deepStrictEqual(plain(loaded.lists.announcements).map(function (a) { return a.TEXT; }), ['主日的報告', '連續三週的報告']);
});

console.log('\n建立與更改（真正入口）');

test('SO-5 建立時選「另外填寫」：那一行 OWN；內容表四張清單分頁的「主日」下拉加入這一日；崇拜程序、崇拜人數不加', function () {
  const env = makeEnv(null);
  const sb = env.sandbox;
  const p = sb.apiPreviewCreateSpecialService(FRI, '受苦節崇拜', 'OWN').data;
  assert.strictEqual(p.ok, true, JSON.stringify(p));
  assert.ok(p.lines.join('\n').indexOf('另外填寫') !== -1, p.lines.join('\n'));
  assertWrittenChinese(assert, '預覽', p.lines);
  const c = sb.apiCreateSpecialService(FRI, '受苦節崇拜', 'OWN');
  assert.strictEqual(c.ok, true, JSON.stringify(c.error));
  assert.strictEqual(c.data.created, true);
  assert.strictEqual(c.data.contentSheetNote, '');
  assert.strictEqual(weekRow(sb, FRI).SPECIAL_CONTENT_SOURCE, 'OWN');
  const ann = env.contentTabs['家事報告'];
  const v = ann.__validations['3:' + (sb.contentSheetTabDefs_().filter(function (d) { return d.tabName === '家事報告'; })[0].keys.indexOf('SERVICE_DATE') + 1)];
  assert.ok(v && v.values.indexOf(FRI) !== -1 && v.values.indexOf(PREV) !== -1, JSON.stringify(v));
  ['崇拜程序', '崇拜人數'].forEach(function (name) {
    const tab = env.contentTabs[name];
    Object.keys(tab.__validations).forEach(function (k) {
      const vals = (tab.__validations[k] || {}).values || [];
      assert.strictEqual(vals.indexOf(FRI), -1, name + ' 不可以有特別崇拜的日期');
    });
  });
  assert.strictEqual(sb.readSheet_('AuditLog').filter(function (a) { return a.ACTION === 'CONTENT_SHEET_LIST_DATES'; }).length, 1);
});

test('SO-6 建立時不選（預設）：那一行空白，內容表下拉不改', function () {
  const sb = makeEnv(null).sandbox;
  const c = sb.apiCreateSpecialService(FRI, '受苦節崇拜');
  assert.strictEqual(c.data.created, true);
  assert.strictEqual(String(weekRow(sb, FRI).SPECIAL_CONTENT_SOURCE || ''), '');
  assert.strictEqual(sb.readSheet_('AuditLog').filter(function (a) { return a.ACTION === 'CONTENT_SHEET_LIST_DATES'; }).length, 0);
});

test('SO-7 改為另外填寫、再改回：預覽一格不寫；執行寫一格（AuditLog）、更新最後儲存時間；同一個選擇再按 → UNCHANGED', function () {
  const sb = makeEnv('').sandbox;
  const before = JSON.stringify(sb.readSheet_('BulletinWeeks'));
  const p = sb.apiPreviewSpecialContentSource(FRI, 'OWN').data;
  assert.strictEqual(p.ok, true, JSON.stringify(p));
  assert.strictEqual(JSON.stringify(sb.readSheet_('BulletinWeeks')), before, '預覽一格不寫');
  assertWrittenChinese(assert, '更改預覽', p.lines);
  const r = sb.apiSetSpecialContentSource(FRI, 'OWN');
  assert.strictEqual(r.ok, true, JSON.stringify(r.error));
  assert.strictEqual(r.data.changed, true);
  assert.strictEqual(weekRow(sb, FRI).SPECIAL_CONTENT_SOURCE, 'OWN');
  assert.ok(weekRow(sb, FRI).LAST_SAVED_AT, '要更新最後儲存時間（另一個分頁儲存會被擋）');
  assert.strictEqual(sb.apiPreviewSpecialContentSource(FRI, 'OWN').data.reason, 'UNCHANGED');
  const back = sb.apiSetSpecialContentSource(FRI, '');
  assert.strictEqual(back.data.changed, true);
  assert.strictEqual(String(weekRow(sb, FRI).SPECIAL_CONTENT_SOURCE), '');
  assert.strictEqual(sb.readSheet_('AuditLog').filter(function (a) { return a.ACTION === 'SPECIAL_CONTENT_SOURCE'; }).length, 2);
  assert.strictEqual(sb.apiPreviewSpecialContentSource(PREV, 'OWN').data.reason, 'NOT_SPECIAL');
});

test('SO-8 已取消的特別崇拜不當作另外填寫（不匯入、不加入內容表下拉）', function () {
  const sb = makeEnv('OWN').sandbox;
  sb.apiCancelSpecialService(FRI);
  assert.strictEqual(sb.isOwnContentSpecialRow_(weekRow(sb, FRI)), false);
  assert.deepStrictEqual(Array.from(sb.ownContentSpecialDatesForQuarter_(sb.readSheet_('BulletinWeeks'), Q)), []);
  assert.strictEqual(sb.apiPreviewSpecialContentSource(FRI, '').data.reason, 'CANCELLED');
});

test('SO-9 獨立審查：改回跟上一個主日、取消另外填寫的特別崇拜 → 「主日」下拉拿走這一日', function () {
  const env = makeEnv(null);
  const sb = env.sandbox;
  sb.apiCreateSpecialService(FRI, '受苦節崇拜', 'OWN');
  const col = sb.contentSheetTabDefs_().filter(function (d) { return d.tabName === '家事報告'; })[0].keys.indexOf('SERVICE_DATE') + 1;
  const vals = function () { return env.contentTabs['家事報告'].__validations['3:' + col].values; };
  assert.ok(vals().indexOf(FRI) !== -1);
  const back = sb.apiSetSpecialContentSource(FRI, '');
  assert.strictEqual(back.data.changed, true);
  assert.strictEqual(vals().indexOf(FRI), -1, '改回之後拿走');
  sb.apiSetSpecialContentSource(FRI, 'OWN');
  assert.ok(vals().indexOf(FRI) !== -1);
  const cancelled = sb.apiCancelSpecialService(FRI);
  assert.strictEqual(cancelled.data.cancelled, true, JSON.stringify(cancelled));
  assert.strictEqual(vals().indexOf(FRI), -1, '取消之後拿走');
  assert.ok(vals().indexOf(PREV) !== -1, '主日照樣在');
});

test('SO-11 獨立審查：稱呼接受全形「，」「＝」', function () {
  const sb = makeEnv('').sandbox;
  assert.strictEqual(sb.buildEmailSalutation_(['CC', 'DB'], 'CC=堂委，DB＝執事，ADMIN=幹事'), '各位堂委、執事：');
  assert.strictEqual(sb.friendlyApiError_('FIELD_CONFLICT', '「X_FIELD」在你載入之後被改過，請重新載入再改。').message,
    '「X_FIELD」在你載入之後被改過，請重新載入再改。', '預期中的擋駕保留原句');
  assert.strictEqual(sb.friendlyWarningText_({ code: 'BAD_RECURRENCE', message: '' }).indexOf('其中一個團契'), 0);
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
