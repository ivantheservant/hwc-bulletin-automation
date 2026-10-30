#!/usr/bin/env node
/**
 * tests/combined.test.js
 *
 * 2026-10-30：職事表合堂主日（ServiceDates.CombinedKind／CombinedName，職事表第八十五輪；src/CombinedService.gs）
 * 與〔設定合堂主日〕按鈕（職事表第八十七輪的 ?view=combined&quarter=）。
 *
 * 真正入口：buildBulletinModel_（Word、預覽、電郵都經它）、apiLoadWeek、readRosterSnapshot_。
 *
 * 執行方式：node tests/combined.test.js
 */

'use strict';

const assert = require('assert');
const { makeWordEnv } = require('./helpers/wordEnv');
const { assertWrittenChinese } = require('./helpers/writtenChinese');

let pass = 0;
let fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); } catch (err) {
    fail++; console.log('  ✗ ' + name); console.log('    ' + (err && err.stack ? err.stack.split('\n').slice(0, 5).join('\n    ') : err));
  }
}
function plain(v) { return JSON.parse(JSON.stringify(v)); }

const D = '2027-11-07';
const D_NEXT = '2027-11-14';

console.log('\n純函式');

test('CS-1 parseCodeValueList_：代號轉大寫、去空白、全形逗號亦可；格式不對的一項略過', function () {
  const sb = makeWordEnv().sandbox;
  assert.deepStrictEqual(plain(sb.parseCodeValueList_(' combined = TPL_COMBINED，BAPTISM=TPL_COMBINED_BAPTISM,壞的,=X,Y=')),
    { COMBINED: 'TPL_COMBINED', BAPTISM: 'TPL_COMBINED_BAPTISM' });
});

test('CS-2 buildRosterCombinedUrl_：加 view=combined 與季度；網址已有 ? 就用 &；不是 https 或季度格式不對不顯示', function () {
  const sb = makeWordEnv().sandbox;
  assert.strictEqual(sb.buildRosterCombinedUrl_('https://script.google.com/a/x/s/ABC/exec', '2027T1'),
    'https://script.google.com/a/x/s/ABC/exec?view=combined&quarter=2027T1');
  assert.strictEqual(sb.buildRosterCombinedUrl_('https://x.example/exec?a=1#top', '2027T1'), 'https://x.example/exec?a=1&view=combined&quarter=2027T1');
  assert.strictEqual(sb.buildRosterCombinedUrl_('http://x.example/exec', '2027T1'), '');
  assert.strictEqual(sb.buildRosterCombinedUrl_('https://x.example/exec', ''), '');
  assert.strictEqual(sb.buildRosterCombinedUrl_('', '2027T1'), '');
});

console.log('\n程序範本與標題（真入口 buildBulletinModel_）');

test('CS-3 BAPTISM → 浸禮合堂範本；COMBINED → 三堂聯合；ANNIVERSARY → 堂慶；排在每週標題關鍵詞之前', function () {
  const env = makeWordEnv({
    combinedServices: { [D]: { kind: 'BAPTISM', name: '' }, [D_NEXT]: { kind: 'combined', name: '宣教月' } },
    weekTitles: { [D_NEXT]: '堂慶主日' }
  });
  const m1 = env.sandbox.buildBulletinModel_(D);
  assert.strictEqual(m1.templateId, 'TPL_COMBINED_BAPTISM');
  assert.strictEqual(m1.templateAutoSource, 'COMBINED_KIND');
  assert.deepStrictEqual(plain(m1.combined), { kind: 'BAPTISM', name: '' });
  const m2 = env.sandbox.buildBulletinModel_(D_NEXT);
  assert.strictEqual(m2.templateId, 'TPL_COMBINED', '合堂種類優先於標題的「堂慶」關鍵詞');
});

test('CS-4 標題：每週標題優先；空白就用合堂名稱；再空白就用種類名稱（Config COMBINED_KIND_NAMES）', function () {
  const env = makeWordEnv({
    combinedServices: { [D]: { kind: 'BAPTISM', name: '' }, [D_NEXT]: { kind: 'COMBINED', name: '宣教月' } }
  });
  assert.strictEqual(env.sandbox.buildBulletinModel_(D).special.title, '浸禮');
  assert.strictEqual(env.sandbox.buildBulletinModel_(D_NEXT).special.title, '宣教月');
  const titled = makeWordEnv({
    combinedServices: { [D]: { kind: 'BAPTISM', name: '第六十屆浸禮' } },
    weekTitles: { [D]: '第六十屆浸禮三堂聯合崇拜' }
  });
  assert.strictEqual(titled.sandbox.buildBulletinModel_(D).special.title, '第六十屆浸禮三堂聯合崇拜');
});

test('CS-5 人手選的範本永遠優先；舊試算表沒有這兩欄 ＝ 不是合堂（照舊按每週標題，沒有警告）', function () {
  const env = makeWordEnv({
    combinedServices: { [D]: { kind: 'BAPTISM', name: '' } },
    weekRows: [
      { SERVICE_DATE: D, QUARTER_ID: '2027T4', WEEK_OF_MONTH: 1, STATUS: 'DRAFT', PROGRAM_TEMPLATE_ID: 'TPL_NORMAL' },
      { SERVICE_DATE: D_NEXT, QUARTER_ID: '2027T4', WEEK_OF_MONTH: 2, STATUS: 'DRAFT' }
    ]
  });
  const m = env.sandbox.buildBulletinModel_(D);
  assert.strictEqual(m.templateId, 'TPL_NORMAL');
  assert.strictEqual(m.templateAuto, 'TPL_COMBINED_BAPTISM', '自動值仍然講出合堂範本');
  const old = makeWordEnv({ noCombinedColumns: true, weekTitles: { [D]: '浸禮主日' } });
  const mo = old.sandbox.buildBulletinModel_(D);
  assert.strictEqual(mo.combined, null);
  assert.strictEqual(mo.templateId, 'TPL_COMBINED_BAPTISM', '照舊按每週標題關鍵詞');
  assert.strictEqual(mo.templateAutoSource, 'TITLE_KEYWORD');
  assert.strictEqual(plain(mo.warnings).filter(function (w) { return w.code === 'COMBINED_KIND_UNKNOWN'; }).length, 0);
});

test('CS-6 種類代號不在 Config → 警告講明（不可以靜靜當平常主日），程序範本改用每週標題', function () {
  const env = makeWordEnv({ combinedServices: { [D]: { kind: 'YOUTH', name: '青年主日' } } });
  const m = env.sandbox.buildBulletinModel_(D);
  assert.strictEqual(m.templateId, 'TPL_NORMAL');
  const w = plain(m.warnings).filter(function (x) { return x.code === 'COMBINED_KIND_UNKNOWN'; });
  assert.strictEqual(w.length, 1, JSON.stringify(plain(m.warnings)));
  assert.ok(w[0].message.indexOf('YOUTH') !== -1 && w[0].message.indexOf('COMBINED_KIND_TEMPLATES') !== -1, w[0].message);
  assertWrittenChinese(assert, '警告', [w[0].message]);
  assert.strictEqual(m.special.title, '青年主日');
});

test('CS-6b 獨立審查第 7 項：COMBINED_KIND_TEMPLATES 指向 ProgramTemplates 沒有的範本 → 程序表空白要警告（不可以靜靜印空表）', function () {
  const env = makeWordEnv({
    combinedServices: { [D]: { kind: 'BAPTISM', name: '' } },
    config: { COMBINED_KIND_TEMPLATES: 'BAPTISM=TPL_NOT_THERE' }
  });
  const m = env.sandbox.buildBulletinModel_(D);
  assert.strictEqual(m.templateId, 'TPL_NOT_THERE');
  const w = plain(m.warnings).filter(function (x) { return x.code === 'PROGRAM_TEMPLATE_EMPTY'; });
  assert.strictEqual(w.length, 1, JSON.stringify(plain(m.warnings)));
  assert.ok(w[0].message.indexOf('COMBINED_KIND_TEMPLATES') !== -1, w[0].message);
});

console.log('\n填寫介面（真入口 apiLoadWeek）');

test('CS-7 apiLoadWeek：合堂資料、自動值依據；〔設定合堂主日〕網址帶這一週在職事表的季度；ROSTER_WEBAPP_URL 留空就不顯示', function () {
  const env = makeWordEnv({
    combinedServices: { [D]: { kind: 'BAPTISM', name: '' } },
    config: { ROSTER_WEBAPP_URL: 'https://script.google.com/a/x/s/ROSTER/exec' }
  });
  const load = env.sandbox.apiLoadWeek(D);
  assert.strictEqual(load.ok, true, JSON.stringify(load.error));
  const ro = plain(load.data.readOnly);
  assert.deepStrictEqual(ro.combined, { kind: 'BAPTISM', name: '', kindName: '浸禮' });
  assert.strictEqual(ro.templateAutoSource, 'COMBINED_KIND');
  assert.strictEqual(load.data.rosterCombinedUrl, 'https://script.google.com/a/x/s/ROSTER/exec?view=combined&quarter=2027T4');
  const none = makeWordEnv({ config: { ROSTER_WEBAPP_URL: '' } }).sandbox.apiLoadWeek(D);
  assert.strictEqual(none.data.rosterCombinedUrl, '');
  assert.strictEqual(plain(none.data.readOnly).combined, null);
});

test('CS-8 週報一格都不寫入職事表：讀合堂設定、載入之後職事表的 ServiceDates 完全不變', function () {
  const env = makeWordEnv({ combinedServices: { [D]: { kind: 'BAPTISM', name: '' } } });
  const roster = env.sandbox.SpreadsheetApp.openById(env.sandbox.getConfig_('ROSTER_SPREADSHEET_ID', ''));
  const sheet = roster.getSheetByName('ServiceDates');
  function dump() { return JSON.stringify(sheet.getRange(1, 1, sheet.getLastRow(), sheet.getLastColumn()).getValues()); }
  const before = dump();
  assert.ok(before.indexOf('BAPTISM') !== -1, '假職事表確實有合堂設定');
  env.sandbox.apiLoadWeek(D);
  env.sandbox.buildBulletinModel_(D_NEXT);
  assert.strictEqual(dump(), before);
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
