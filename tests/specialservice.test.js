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
  env.sandbox.writeSheet_('Announcements', [
    { SERVICE_DATE: new Date(2027, 10, 14), SEQ_NO: 10, TEXT: '十四日的報告', ACTIVE: true },
    { SERVICE_DATE: new Date(2027, 10, 21), SEQ_NO: 10, TEXT: '廿一日的報告', ACTIVE: true }
  ]);
  return env;
}

function weekOf(env, iso) {
  return env.sandbox.readSheet_('BulletinWeeks').filter(function (r) { return env.sandbox.formatIsoDate_(r.SERVICE_DATE) === iso; });
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
  const before = JSON.stringify(sb.readSheet_('BulletinWeeks'));
  const p = sb.apiPreviewCreateSpecialService(FRI, '受苦節崇拜').data;
  assert.strictEqual(p.ok, true, JSON.stringify(p));
  const text = p.lines.join('\n');
  ['2027-11-19（星期五）', '受苦節崇拜', 'TPL_NORMAL', '跟上一個主日（2027-11-14）', '下一個主日（2027-11-21）的職事表', '不會自動寄出'].forEach(function (s) {
    assert.ok(text.indexOf(s) !== -1, '缺少：' + s + '\n' + text);
  });
  assert.strictEqual(JSON.stringify(sb.readSheet_('BulletinWeeks')), before, '預覽一格不寫');
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
  assert.strictEqual(env.sandbox.readSheet_('AuditLog').filter(function (a) { return a.ACTION === 'CREATE_SPECIAL_SERVICE'; }).length, 1);
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
  assert.strictEqual(plain(sb.planContentAutoSyncDates_(sb.readSheet_('BulletinWeeks'), contentEnv.QUARTER_ID, '2027-10-01')).indexOf('2027-10-08'), -1);
  assert.strictEqual(sb.apiRunContentSheetBuild(contentEnv.QUARTER_ID).data.ok, true);
  assert.strictEqual(sb.apiRunQuarterContentImport(contentEnv.QUARTER_ID).data.ok, true);
  const row = sb.readSheet_('BulletinWeeks').filter(function (r) { return sb.formatIsoDate_(r.SERVICE_DATE) === '2027-10-08'; })[0];
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

console.log('\n獨立審查 2026-10-30 的修正');

test('S-10 清單次序：特別崇拜自己沒有安排時顯示跟上一個主日，但可以改的值是自己的空白——改次序儲存不會報「已經被改過」', function () {
  const env = makeEnv();
  const sb = env.sandbox;
  const src = sb.apiLoadWeek(SOURCE).data;
  const key = plain(src.lists.announcements)[0].arrangeKey;
  const hideJson = JSON.stringify({ v: 1, announcements: [{ k: key, h: true }] });
  const s1 = sb.apiSaveWeek({
    isoDate: SOURCE, lastSavedAt: src.lastSavedAt, payloadVersion: 2,
    week: { LIST_ARRANGEMENT: hideJson }, baseWeek: { LIST_ARRANGEMENT: '' },
    announcements: [], prayers: [], fellowships: [], finance: []
  });
  assert.strictEqual(s1.ok, true, JSON.stringify(s1.error));
  create(env, FRI, '受苦節崇拜');
  const load = sb.apiLoadWeek(FRI).data;
  assert.strictEqual(load.week.LIST_ARRANGEMENT, '', '可以改的值是這一行自己的');
  assert.strictEqual(plain(load.lists.announcements)[0].hidden, true, '顯示跟上一個主日（拿走了）');
  const showJson = JSON.stringify({ v: 1, announcements: [{ k: key, h: false }] });
  const saved = sb.apiSaveWeek({
    isoDate: FRI, lastSavedAt: load.lastSavedAt, payloadVersion: 2,
    week: { LIST_ARRANGEMENT: showJson }, baseWeek: plain(load.week),
    announcements: [], prayers: [], fellowships: [], finance: []
  });
  assert.strictEqual(saved.ok, true, JSON.stringify(saved.error));
  const again = sb.apiLoadWeek(FRI).data;
  assert.strictEqual(again.week.LIST_ARRANGEMENT, showJson);
  assert.strictEqual(plain(again.lists.announcements)[0].hidden, false, '這一行自己的安排優先');
  assert.strictEqual(sb.apiLoadWeek(SOURCE).data.week.LIST_ARRANGEMENT, hideJson, '上一個主日不變');
});

test('S-11 財政報告：特別崇拜印上一個主日的財政行，標題月份與期間跟那一個主日（不是崇拜日期）', function () {
  const env = makeEnv({ extraWeekRows: [{ SERVICE_DATE: '2027-12-05', QUARTER_ID: Q, WEEK_OF_MONTH: 1, STATUS: 'DRAFT' }] });
  const sb = env.sandbox;
  sb.writeSheet_('Finance', [{
    SERVICE_DATE: new Date(2027, 10, 28), SEQ_NO: 10, ROW_LABEL: '總收入', COL_SPECIAL_OVERSEAS: '100', COL_HARDSHIP: '200',
    COL3: '300', COL4: '400', COL5: '', ACTIVE: true, REPORT_TITLE: '', REPORT_NOTE: '', REPORT_BALANCE: ''
  }]);
  create(env, '2027-12-03', '感恩崇拜');
  const sunday = sb.buildBulletinModel_('2027-11-28');
  const special = sb.buildBulletinModel_('2027-12-03');
  assert.strictEqual(sunday.financeReports.main.title, '聖道堂綜合收支財務報告-2027年 10月份', '對照');
  assert.strictEqual(special.financeReports.main.title, sunday.financeReports.main.title);
  assert.strictEqual(special.financeReports.periodLabel, sunday.financeReports.periodLabel);
  assert.strictEqual(special.financeReports.periodLabel, '10月份');
  assert.deepStrictEqual(plain(special.financeReports.columnLabels), plain(sunday.financeReports.columnLabels));
});

test('S-12 本週事奉：職事表沒有這一日 → 按崗位清單開空白格（以前顯示「沒有事奉資料」）；填了的人印在 Word，空格不印；程序即時預覽與資料模型同一個快照', function () {
  const env = makeEnv();
  const sb = env.sandbox;
  create(env, FRI, '受苦節崇拜');
  const load = sb.apiLoadWeek(FRI).data;
  const rows = plain(load.readOnly.dutyBoxPage1);
  assert.ok(rows.length > 0, '要有事奉格：' + JSON.stringify(rows));
  const slots = [].concat.apply([], rows.map(function (r) { return r.slots || []; }));
  assert.ok(slots.length > 0 && slots.every(function (sl) { return sl.rosterName === '' && sl.bulletinName === ''; }), JSON.stringify(slots));
  const first = slots[0];
  const saved = sb.apiSaveWeek({
    isoDate: FRI, lastSavedAt: load.lastSavedAt, payloadVersion: sb.SAVE_PAYLOAD_VERSION_,
    week: {}, baseWeek: {},
    dutyEdits: [{ postId: first.postId, slotIndex: first.slotIndex, name: '陳大文', baseName: '' }],
    announcements: [], prayers: [], fellowships: [], finance: []
  });
  assert.strictEqual(saved.ok, true, JSON.stringify(saved.error));
  const model = sb.buildBulletinModel_(FRI);
  const filled = plain(model.dutyBoxPage1).filter(function (r) { return String(r.text).indexOf('陳大文') !== -1; });
  assert.strictEqual(filled.length, 1, JSON.stringify(plain(model.dutyBoxPage1)));
  const again = plain(sb.apiLoadWeek(FRI).data.readOnly.dutyBoxPage1);
  const s2 = [].concat.apply([], again.map(function (r) { return r.slots || []; }))
    .filter(function (sl) { return sl.postId === first.postId && sl.slotIndex === first.slotIndex; })[0];
  assert.strictEqual(s2.bulletinName, '陳大文', '重新載入之後仍然在');
  // 程序即時預覽：週次條件不成立，與資料模型相同。
  const preview = plain(sb.apiPreviewProgram(FRI, {}).data);
  assert.deepStrictEqual(preview.rows.map(function (r) { return r.itemName; }), plain(model.program).map(function (r) { return r.itemName; }));
});

test('S-13 草稿預覽頁（真入口 buildPreviewPage_）：寫「崇拜日期」、不出「事奉資料尚未確定」、頁尾講明跟哪一個主日', function () {
  const env = makeEnv();
  create(env, FRI, '受苦節崇拜');
  const page = env.sandbox.buildPreviewPage_(FRI);
  assert.strictEqual(page.ok, true, JSON.stringify(page));
  const text = page.html.replace(/<[^>]+>/g, '');
  assert.ok(text.indexOf('崇拜日期：' + FRI) !== -1, text.slice(0, 400));
  assert.strictEqual(text.indexOf('本期事奉資料尚未確定'), -1);
  assert.ok(text.indexOf('特別崇拜：家事報告、代禱事項、團契、財政報告與上週崇拜人數跟 ' + SOURCE + ' 那一個主日。') !== -1, text.slice(-600));
  const sun = env.sandbox.buildPreviewPage_(SOURCE).html.replace(/<[^>]+>/g, '');
  assert.ok(sun.indexOf('主日日期：' + SOURCE) !== -1);
});

console.log('\n取消特別崇拜（2026-10-30 Ivan：先選那一期，再按取消；不刪行）');

test('S-14 真入口 apiPreviewCancelSpecialService／apiCancelSpecialService：預覽一格不寫；取消只改 SERVICE_KIND（不刪行）、AuditLog；下拉不再顯示；載入、預覽頁、Word 講明已取消', function () {
  const env = makeEnv();
  const sb = env.sandbox;
  create(env, FRI, '受苦節崇拜');
  const before = JSON.stringify(sb.readSheet_('BulletinWeeks'));
  const p = sb.apiPreviewCancelSpecialService(FRI).data;
  assert.strictEqual(p.ok, true, JSON.stringify(p));
  assert.strictEqual(JSON.stringify(sb.readSheet_('BulletinWeeks')), before, '預覽一格不寫');
  assert.ok(p.lines.join('\n').indexOf('不會刪除') !== -1);
  assert.strictEqual(p.sourceIso, SOURCE);
  assertWrittenChinese(assert, '取消預覽', p.lines);
  const countBefore = sb.readSheet_('BulletinWeeks').length;
  const r = sb.apiCancelSpecialService(FRI);
  assert.strictEqual(r.ok, true, JSON.stringify(r.error));
  assert.strictEqual(r.data.cancelled, true);
  assert.strictEqual(sb.readSheet_('BulletinWeeks').length, countBefore, '不刪行');
  const row = weekOf(env, FRI)[0];
  assert.strictEqual(row.SERVICE_KIND, 'SPECIAL_CANCELLED');
  assert.strictEqual(row.SPECIAL_TYPE, '受苦節崇拜', '其餘內容保留');
  const audit = sb.readSheet_('AuditLog').filter(function (a) { return a.ACTION === 'CANCEL_SPECIAL_SERVICE'; });
  assert.strictEqual(audit.length, 1);
  assert.deepStrictEqual([audit[0].FIELD, audit[0].OLD_VALUE, audit[0].NEW_VALUE], ['SERVICE_KIND', 'SPECIAL', 'SPECIAL_CANCELLED']);
  // 下拉
  const list = plain(sb.apiListWeeks(false).data.weeks);
  assert.strictEqual(list.filter(function (w) { return w.isoDate === FRI; }).length, 0, '下拉不再顯示');
  assert.strictEqual(list.filter(function (w) { return w.specialService; }).length, 0, '季度標籤不再算它');
  // 載入：講明已取消，不寫 ErrorLog（預期中的情況）
  const errBefore = sb.readSheet_('ErrorLog').length;
  const load = sb.apiLoadWeek(FRI);
  assert.strictEqual(load.ok, false);
  assert.strictEqual(load.error.code, 'SPECIAL_SERVICE_CANCELLED');
  assert.ok(load.error.message.indexOf('已經取消') !== -1, load.error.message);
  assert.strictEqual(sb.readSheet_('ErrorLog').length, errBefore);
  // 預覽頁
  const page = sb.buildPreviewPage_(FRI);
  assert.strictEqual(page.ok, false);
  assert.ok(page.html.indexOf('已經取消') !== -1);
  // 平常的流程照舊不理它：主日清單、自動同步
  assert.strictEqual(sb.planContentAutoSyncDates_(sb.readSheet_('BulletinWeeks'), Q, '2027-11-01').indexOf(FRI), -1);
});

test('S-15 取消：拒絕主日、沒有那一期、已經取消、已經發佈；重複按不會再寫', function () {
  const env = makeEnv();
  const sb = env.sandbox;
  assert.strictEqual(sb.apiPreviewCancelSpecialService(SOURCE).data.reason, 'NOT_SPECIAL');
  assert.strictEqual(sb.apiPreviewCancelSpecialService('2027-11-12').data.reason, 'NOT_FOUND');
  assert.strictEqual(sb.apiPreviewCancelSpecialService('2027/11/12').data.reason, 'BAD_DATE');
  create(env, FRI, '受苦節崇拜');
  assert.strictEqual(sb.apiCancelSpecialService(FRI).data.cancelled, true);
  const again = sb.apiCancelSpecialService(FRI).data;
  assert.strictEqual(again.cancelled, false);
  assert.strictEqual(again.reason, 'ALREADY_CANCELLED');
  assert.strictEqual(sb.readSheet_('AuditLog').filter(function (a) { return a.ACTION === 'CANCEL_SPECIAL_SERVICE'; }).length, 1);
  // 已經發佈 → 拒絕
  const plan = sb.planSpecialServiceCancel_({
    isoDate: FRI, publishIndex: { [FRI]: 1 },
    weekRows: [{ SERVICE_DATE: sb.normalizeDate_(FRI), SERVICE_KIND: 'SPECIAL', SPECIAL_TYPE: '受苦節崇拜', STATUS: 'DRAFT' }]
  });
  assert.strictEqual(plan.reason, 'PUBLISHED');
  const sent = sb.planSpecialServiceCancel_({
    isoDate: FRI, publishIndex: {},
    weekRows: [{ SERVICE_DATE: sb.normalizeDate_(FRI), SERVICE_KIND: 'SPECIAL', SPECIAL_TYPE: '受苦節崇拜', STATUS: 'SENT' }]
  });
  assert.strictEqual(sent.reason, 'SENT');
});

test('S-16 同一日再建立＝恢復那一行（不加第二行）：名稱用新填的，之前填的講題保留；下拉再顯示', function () {
  const env = makeEnv();
  const sb = env.sandbox;
  create(env, FRI, '受苦節崇拜');
  const load = sb.apiLoadWeek(FRI).data;
  const saved = sb.apiSaveWeek({
    isoDate: FRI, lastSavedAt: load.lastSavedAt, payloadVersion: 2,
    week: { SERMON_TITLE: '十架七言' }, baseWeek: { SERMON_TITLE: '' },
    announcements: [], prayers: [], fellowships: [], finance: []
  });
  assert.strictEqual(saved.ok, true, JSON.stringify(saved.error));
  sb.apiCancelSpecialService(FRI);
  const p = sb.apiPreviewCreateSpecialService(FRI, '受難節崇拜').data;
  assert.strictEqual(p.ok, true, JSON.stringify(p));
  assert.strictEqual(p.restore, true);
  assert.ok(p.lines[0].indexOf('恢復') !== -1, p.lines[0]);
  const d = create(env, FRI, '受難節崇拜');
  assert.strictEqual(d.created, true);
  const rows = weekOf(env, FRI);
  assert.strictEqual(rows.length, 1, '同一日只有一行');
  assert.deepStrictEqual([rows[0].SERVICE_KIND, rows[0].SPECIAL_TYPE, rows[0].PAGE_TITLE, rows[0].SERMON_TITLE],
    ['SPECIAL', '受難節崇拜', '受難節崇拜', '十架七言']);
  assert.strictEqual(sb.readSheet_('AuditLog').filter(function (a) { return a.ACTION === 'RESTORE_SPECIAL_SERVICE'; }).length, 3);
  assert.strictEqual(plain(sb.apiListWeeks(false).data.weeks).filter(function (w) { return w.isoDate === FRI; }).length, 1);
  assert.strictEqual(sb.apiLoadWeek(FRI).ok, true);
  // 恢復之後再建立 → EXISTS
  assert.strictEqual(sb.apiPreviewCreateSpecialService(FRI, '另一個').data.reason, 'EXISTS');
});

test('S-17 獨立審查第 6 項：另一個分頁仍然開着，那一期被取消之後按儲存 → 擋住，一格不寫', function () {
  const env = makeEnv();
  const sb = env.sandbox;
  create(env, FRI, '受苦節崇拜');
  const load = sb.apiLoadWeek(FRI).data;
  sb.apiCancelSpecialService(FRI);
  const before = JSON.stringify(sb.readSheet_('BulletinWeeks'));
  const saved = sb.apiSaveWeek({
    isoDate: FRI, lastSavedAt: load.lastSavedAt, payloadVersion: 2,
    week: { SERMON_TITLE: '十架七言' }, baseWeek: { SERMON_TITLE: '' },
    announcements: [], prayers: [], fellowships: [], finance: []
  });
  assert.strictEqual(saved.ok, false);
  assert.strictEqual(saved.error.code, 'SPECIAL_SERVICE_CANCELLED');
  assert.strictEqual(JSON.stringify(sb.readSheet_('BulletinWeeks')), before);
  ['apiResetWeek', 'apiRestoreWeekSnapshot'].forEach(function (n) {
    const r = sb[n]({ isoDate: FRI, lastSavedAt: load.lastSavedAt, snapshotId: 'X' });
    assert.strictEqual(r.error && r.error.code, 'SPECIAL_SERVICE_CANCELLED', n);
  });
  assert.strictEqual(sb.apiFetchFromRoster(FRI, []).error.code, 'SPECIAL_SERVICE_CANCELLED');
  assert.ok(String(weekOf(env, FRI)[0].LAST_SAVED_AT || '') !== '', '取消時更新了最後儲存時間（樂觀鎖）');
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
