#!/usr/bin/env node
/**
 * tests/specialservice.test.js
 *
 * 特別崇拜（非主日，例如受苦節；2026-10-30 Ivan 示範之後，src/SpecialService.gs）。
 *
 * 真正入口：apiPreviewCreateSpecialService／apiCreateSpecialService、apiListWeeks、apiLoadWeek、apiSaveWeek、
 * generateBulletinDocx_、apiRunQuarterContentImport、resolveQuarterServiceDateEntries_、runContentAutoSync_。
 *
 * 執行方式：node tests/specialservice.test.js
 */

'use strict';

const assert = require('assert');
const { makeWordEnv } = require('./helpers/wordEnv');
const { buildFakeDocx } = require('./helpers/fakeDrive');
const contentEnv = require('./helpers/contentEnv');
const fx = require('./fixtures/docxXml');
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
function plain(v) { return JSON.parse(JSON.stringify(v)); }

const Q = '2027T4';
const SUNDAYS = ['2027-11-07', '2027-11-14', '2027-11-21', '2027-11-28'];
const FRI = '2027-11-19';
const SOURCE = '2027-11-14';
const NEXT = '2027-11-21';

function template() {
  return buildFakeDocx(fx.documentXml(
    fx.para(fx.run('{{SPECIAL_TYPE}}|{{PAGE_TITLE}}|{{SERMON_TITLE}}|{{ATT_ENG_WORSHIP}}|{{ATTENDANCE_DATE}}|{{NEXT_WEEK_DATE}}'))
    + fx.para(fx.run('{{#EACHP:ANNOUNCEMENT}}{{ANNOUNCEMENT.NO}}. {{ANNOUNCEMENT.TEXT}}'))
  ));
}

function makeEnv(extra) {
  const o = extra || {};
  const env = makeWordEnv({
    driveOptions: { files: { FAKE_TEMPLATE_ID_NORMAL: template() } },
    weekRows: SUNDAYS.map(function (iso, i) {
      const row = { SERVICE_DATE: iso, QUARTER_ID: Q, WEEK_OF_MONTH: i + 1, STATUS: 'DRAFT', SERMON_TITLE: '講題' + (i + 1) };
      if (iso === SOURCE) Object.assign(row, { ATT_ENG_WORSHIP: '88', ATTENDANCE_DATE: '2027-11-07' });
      return row;
    }).concat(o.extraWeekRows || []),
    config: Object.assign({ WEBAPP_SIMULATED_TODAY: '2027-11-17' }, o.config || {})
  });
  env.sandbox.writeSheet('Announcements', [
    { SERVICE_DATE: new Date(2027, 10, 14), SEQ_NO: 10, TEXT: '十四日的報告', ACTIVE: true },
    { SERVICE_DATE: new Date(2027, 10, 21), SEQ_NO: 10, TEXT: '廿一日的報告', ACTIVE: true }
  ]);
  return env;
}

function weekOf(env, iso) {
  return env.sandbox.readSheet('BulletinWeeks').filter(function (r) { return env.sandbox.formatIsoDate_(r.SERVICE_DATE) === iso; });
}

function create(env, iso, title) {
  const r = env.sandbox.apiCreateSpecialService(iso, title);
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  return r.data;
}

console.log('\n建立特別崇拜');

test('S-1 預覽講明會做甚麼（一格不寫）；拒絕：主日、沒有名稱、名稱太長、已經有一期、上一個主日未有週報、那一季未有主日', function () {
  const env = makeEnv();
  const sb = env.sandbox;
  const before = JSON.stringify(sb.readSheet('BulletinWeeks'));
  const p = sb.apiPreviewCreateSpecialService(FRI, '受苦節崇拜').data;
  assert.strictEqual(p.ok, true, JSON.stringify(p));
  const text = p.lines.join('\n');
  ['2027-11-19（星期五）', '受苦節崇拜', 'TPL_NORMAL', '跟上一個主日（2027-11-14）', '下一個主日（2027-11-21）的職事表', '不會自動寄出'].forEach(function (s) {
    assert.ok(text.indexOf(s) !== -1, '缺少：' + s + '\n' + text);
  });
  assert.strictEqual(JSON.stringify(sb.readSheet('BulletinWeeks')), before, '預覽一格不寫');
  assertWrittenChinese(assert, '預覽', p.lines);
  const reasons = [
    [SOURCE, '受苦節崇拜', 'IS_SUNDAY'], [FRI, ' ', 'NO_TITLE'], [FRI, '長'.repeat(41), 'TITLE_TOO_LONG'],
    ['2027-11-05', '甲', 'NO_SOURCE_SUNDAY'], ['2027-13-01', '甲', 'BAD_DATE'], ['2028-01-05', '甲', 'NO_SOURCE_SUNDAY']
  ].map(function (c) { return [c[2], sb.apiPreviewCreateSpecialService(c[0], c[1]).data.reason]; });
  reasons.forEach(function (pair) { assert.strictEqual(pair[1], pair[0]); });
  create(env, FRI, '受苦節崇拜');
  assert.strictEqual(sb.apiPreviewCreateSpecialService(FRI, '另一個').data.reason, 'EXISTS');
});

test('S-1b 那一季未有主日的週報 → 拒絕（不可以造出只有特別崇拜的季度）', function () {
  const env = makeEnv({ extraWeekRows: [{ SERVICE_DATE: '2027-12-26', QUARTER_ID: Q, WEEK_OF_MONTH: 4, STATUS: 'DRAFT' }] });
  const r = env.sandbox.apiPreviewCreateSpecialService('2028-01-01', '新年感恩崇拜').data;
  assert.strictEqual(r.reason, 'QUARTER_NOT_CREATED', JSON.stringify(r));
  assert.ok(r.message.indexOf('2028T1') !== -1, r.message);
});

test('S-2 建立：一行 SERVICE_KIND=SPECIAL、名稱、大標題、程序範本 TPL_NORMAL、季度、AuditLog；再按一次不會重複', function () {
  const env = makeEnv();
  const d = create(env, FRI, '受苦節崇拜');
  assert.strictEqual(d.created, true);
  const rows = weekOf(env, FRI);
  assert.strictEqual(rows.length, 1);
  const r = rows[0];
  assert.deepStrictEqual([r.SERVICE_KIND, r.SPECIAL_TYPE, r.PAGE_TITLE, r.PROGRAM_TEMPLATE_ID, r.QUARTER_ID, r.STATUS],
    ['SPECIAL', '受苦節崇拜', '受苦節崇拜', 'TPL_NORMAL', Q, 'DRAFT']);
  assert.strictEqual(env.sandbox.readSheet('AuditLog').filter(function (a) { return a.ACTION === 'CREATE_SPECIAL_SERVICE'; }).length, 1);
  const again = env.sandbox.apiCreateSpecialService(FRI, '受苦節崇拜').data;
  assert.strictEqual(again.created, false);
  assert.strictEqual(weekOf(env, FRI).length, 1);
});

console.log('\n填寫介面（真入口）');

test('S-3 apiListWeeks：下拉顯示名稱；apiLoadWeek：說明、讀經經文等三欄可以改、清單與上週人數跟上一個主日、下週事奉是下一個主日', function () {
  const env = makeEnv();
  create(env, FRI, '受苦節崇拜');
  const list = env.sandbox.apiListWeeks(false).data;
  const entry = plain(list.weeks).filter(function (w) { return w.isoDate === FRI; })[0];
  assert.ok(entry && entry.specialService === true && entry.selectorLabel.indexOf('受苦節崇拜') !== -1, JSON.stringify(entry));
  const load = env.sandbox.apiLoadWeek(FRI);
  assert.strictEqual(load.ok, true, JSON.stringify(load.error));
  const ro = load.data.readOnly;
  assert.deepStrictEqual(plain(ro.specialService), { title: '受苦節崇拜', contentSourceIso: SOURCE, nextSundayIso: NEXT });
  const readOnly = Array.from(ro.readOnlyFields.week);
  ['SCRIPTURE_REF', 'SERMON_TITLE', 'RESPONSE_HYMN'].forEach(function (k) { assert.strictEqual(readOnly.indexOf(k), -1, k); });
  assert.ok(readOnly.indexOf('ATT_ENG_WORSHIP') !== -1, '人數仍然唯讀');
  assert.deepStrictEqual(plain(load.data.lists.announcements).map(function (a) { return a.TEXT; }), ['十四日的報告']);
  assert.strictEqual(load.data.week.ATT_ENG_WORSHIP, '88', '上週人數跟上一個主日');
  assert.strictEqual(plain(load.data.contentSheet).specialService.contentSourceIso, SOURCE);
  // 平常的主日照舊唯讀。
  const sun = env.sandbox.apiLoadWeek(SOURCE).data;
  assert.ok(Array.from(sun.readOnly.readOnlyFields.week).indexOf('SERMON_TITLE') !== -1);
  assert.strictEqual(sun.readOnly.specialService, null);
});

test('S-4 apiSaveWeek：特別崇拜可以存證道講題；平常的主日照舊整次拒絕', function () {
  const env = makeEnv();
  create(env, FRI, '受苦節崇拜');
  const load = env.sandbox.apiLoadWeek(FRI).data;
  const saved = env.sandbox.apiSaveWeek({
    isoDate: FRI, lastSavedAt: load.lastSavedAt, payloadVersion: 2,
    week: { SERMON_TITLE: '十架七言', SCRIPTURE_REF: '路加福音 23:34' }, baseWeek: { SERMON_TITLE: '', SCRIPTURE_REF: '' },
    announcements: [], prayers: [], fellowships: [], finance: []
  });
  assert.strictEqual(saved.ok, true, JSON.stringify(saved.error));
  assert.strictEqual(weekOf(env, FRI)[0].SERMON_TITLE, '十架七言');
  const sunLoad = env.sandbox.apiLoadWeek(SOURCE).data;
  const refused = env.sandbox.apiSaveWeek({
    isoDate: SOURCE, lastSavedAt: sunLoad.lastSavedAt, payloadVersion: 2,
    week: { SERMON_TITLE: '改講題' }, baseWeek: { SERMON_TITLE: '講題2' },
    announcements: [], prayers: [], fellowships: [], finance: []
  });
  assert.strictEqual(refused.ok, false);
  assert.strictEqual(refused.error.code, 'CONTENT_SHEET_READONLY');
});

console.log('\nWord（真入口 generateBulletinDocx_）');

test('S-5 封面名稱、大標題、自己填的講題；家事報告與上週人數跟上一個主日；下週事奉日期是下一個主日', function () {
  const env = makeEnv();
  create(env, FRI, '受苦節崇拜');
  env.sandbox.writeBulletinWeekField_(FRI, 'SERMON_TITLE', '十架七言');
  const r = env.sandbox.generateBulletinDocx_(FRI);
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  const xml = r.blob.__entries.filter(function (e) { return e.getName() === 'word/document.xml'; })[0].__text;
  // 這個測試環境的 Utilities.formatDate 回固定字串，日期在下面由資料模型核對。
  ['受苦節崇拜|受苦節崇拜|十架七言|88|', '1. 十四日的報告'].forEach(function (s) {
    assert.ok(xml.indexOf(s) !== -1, '缺少：' + s + '\n' + xml.replace(/<[^>]+>/g, ''));
  });
  assert.strictEqual(xml.indexOf('廿一日的報告'), -1);
  const model = env.sandbox.buildBulletinModel_(FRI);
  assert.strictEqual(model.nextIsoDate, NEXT, '下週事奉是下一個主日');
  assert.strictEqual(env.sandbox.formatIsoDate_(model.weekFields.ATTENDANCE_DATE), '2027-11-07', '人數日期跟上一個主日');
  assert.strictEqual(model.specialService, true);
  assert.strictEqual(model.special.title, '受苦節崇拜');
});

test('S-6 程序：職事表沒有這一日，週次條件（WEEK_IN:1 聖餐）不出現——即使日期本身在每月第一週', function () {
  const env = makeEnv({ extraWeekRows: [{ SERVICE_DATE: '2027-10-31', QUARTER_ID: Q, WEEK_OF_MONTH: 5, STATUS: 'DRAFT' }] });
  create(env, '2027-11-05', '感恩崇拜');
  function items(iso) {
    const d = env.sandbox.apiLoadWeek(iso).data;
    return plain(d.readOnly.program).map(function (r) { return r.itemName; });
  }
  assert.ok(items('2027-11-07').indexOf('聖餐') !== -1, '對照：第一個主日有聖餐');
  assert.strictEqual(items('2027-11-05').indexOf('聖餐'), -1);
});

console.log('\n其他流程不理特別崇拜');

test('S-7 季度的主日清單（BulletinWeeks 後備）、內容表自動同步的日期、整季匯入都不包括特別崇拜；自己填的講題不被匯入清走', function () {
  const env = contentEnv.makeEnv({
    weekRows: contentEnv.SERVICE_DATES.map(function (iso) { return { SERVICE_DATE: iso, QUARTER_ID: contentEnv.QUARTER_ID }; })
      .concat([{ SERVICE_DATE: '2027-10-08', QUARTER_ID: contentEnv.QUARTER_ID, SERVICE_KIND: 'SPECIAL', SPECIAL_TYPE: '感恩崇拜', SERMON_TITLE: '自己填的' }])
  });
  const sb = env.sandbox;
  assert.strictEqual(sb.quarterEntriesFromBulletinWeeks_(contentEnv.QUARTER_ID).map(function (e) { return e.isoDate; }).indexOf('2027-10-08'), -1);
  assert.strictEqual(plain(sb.planContentAutoSyncDates_(sb.readSheet('BulletinWeeks'), contentEnv.QUARTER_ID, '2027-10-01')).indexOf('2027-10-08'), -1);
  assert.strictEqual(sb.apiRunContentSheetBuild(contentEnv.QUARTER_ID).data.ok, true);
  assert.strictEqual(sb.apiRunQuarterContentImport(contentEnv.QUARTER_ID).data.ok, true);
  const row = sb.readSheet('BulletinWeeks').filter(function (r) { return sb.formatIsoDate_(r.SERVICE_DATE) === '2027-10-08'; })[0];
  assert.strictEqual(row.SERMON_TITLE, '自己填的');
  const worship = env.contentSpreadsheet.getSheetByName('崇拜程序').__data.slice(2).map(function (r) { return r[0]; });
  assert.strictEqual(worship.indexOf('2027-10-08'), -1, '內容表不為特別崇拜開行');
  assert.strictEqual(sb.autoImportContentForWeek_('2027-10-08', 'WEBAPP').reason, 'SPECIAL_SERVICE');
});

test('S-8 發佈時窗：同一週的特別崇拜可以發佈，下一週的不可以；發佈的日期異常不講「不是下一個主日」', function () {
  const sb = makeEnv().sandbox;
  assert.strictEqual(sb.isWithinPublishWindow_('2027-11-19', '2027-11-17'), true);
  assert.strictEqual(sb.isWithinPublishWindow_('2027-11-21', '2027-11-17'), true);
  assert.strictEqual(sb.isWithinPublishWindow_('2027-11-26', '2027-11-17'), false);
  assert.strictEqual(sb.isWithinPublishWindow_('2027-11-14', '2027-11-17'), false, '上一個主日不可以');
  const issues = plain(sb.detectPublishDateIssues_({ isoDate: '2027-11-19', todayIso: '2027-11-17', lastPublishedIso: '2027-11-07' }));
  assert.deepStrictEqual(issues, []);
});

test('S-9 previousSundayBeforeIso_／nextSundayAfterIso_：星期五、星期日、跨年', function () {
  const sb = makeEnv().sandbox;
  assert.strictEqual(sb.previousSundayBeforeIso_('2027-11-19'), '2027-11-14');
  assert.strictEqual(sb.nextSundayAfterIso_('2027-11-19'), '2027-11-21');
  assert.strictEqual(sb.previousSundayBeforeIso_('2027-11-21'), '2027-11-14', '主日的上一個主日是七日前');
  assert.strictEqual(sb.nextSundayAfterIso_('2027-12-31'), '2028-01-02');
  assert.strictEqual(sb.previousSundayBeforeIso_('bad'), '');
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
