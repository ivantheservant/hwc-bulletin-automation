#!/usr/bin/env node
/**
 * tests/carryover.test.js
 *
 * 2026-10-30（Ivan）：內容表「連續到」跨季（src/ContentCarryOver.gs）。
 *
 * 真正入口：applyContentImport_／previewContentImport_（填寫介面載入、自動同步、整季匯入都經這兩支）、
 * runContentAutoSync_、apiLoadWeek。
 *
 * 執行方式：node tests/carryover.test.js
 */

'use strict';

const assert = require('assert');
const { makeEnv, QUARTER_ID } = require('./helpers/contentEnv');
const { assertWrittenChinese } = require('./helpers/writtenChinese');

let pass = 0;
let fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); } catch (err) {
    fail++; console.log('  ✗ ' + name); console.log('    ' + (err && err.stack ? err.stack.split('\n').slice(0, 5).join('\n    ') : err));
  }
}

const PREV_QID = '2027T3';
const PREV_FILE = 'FAKE_PREV_CONTENT_FILE';

function prevSheet(content, extra) {
  return [Object.assign({ quarterId: PREV_QID, fileId: PREV_FILE, content: content }, extra || {})];
}

function activeTexts(env, sheetName, iso) {
  return Array.from(env.sandbox.readSheet(sheetName)
    .filter(function (r) { return r.ACTIVE === true && env.sandbox.formatIsoDate_(r.SERVICE_DATE) === iso; })
    .sort(function (a, b) { return Number(a.SEQ_NO) - Number(b.SEQ_NO); })
    .map(function (r) { return r.TEXT; }));
}

console.log('\n純函式');

test('CO-1 previousQuarterId_：T2→T1、T1→上一年 T4、格式不對回空字串', function () {
  const sb = makeEnv().sandbox;
  assert.strictEqual(sb.previousQuarterId_('2028T2'), '2028T1');
  assert.strictEqual(sb.previousQuarterId_('2028T1'), '2027T4');
  assert.strictEqual(sb.previousQuarterId_('2028T5'), '');
  assert.strictEqual(sb.previousQuarterId_(''), '');
});

test('CO-2 contentRepeatUntilOptions_：本季主日＋之後每隔七日的 N 個主日；0 或不合法＝只有本季', function () {
  const sb = makeEnv().sandbox;
  const q = ['2027-12-19', '2027-12-26'];
  assert.deepStrictEqual(Array.from(sb.contentRepeatUntilOptions_(q, 3)), ['2027-12-19', '2027-12-26', '2028-01-02', '2028-01-09', '2028-01-16']);
  assert.deepStrictEqual(Array.from(sb.contentRepeatUntilOptions_(q, 0)), q);
  assert.deepStrictEqual(Array.from(sb.contentRepeatUntilOptions_(q, 'x')), q);
  assert.deepStrictEqual(Array.from(sb.contentRepeatUntilOptions_([], 3)), []);
});

test('CO-3 expandRepeatUntilRows_：連續到遲過本季最後一個主日 → 展開到最後一個主日，不記警告；本季之內但不是主日 → 照舊警告', function () {
  const sb = makeEnv().sandbox;
  const dates = ['2027-10-03', '2027-10-10', '2027-10-17'];
  const beyond = sb.expandRepeatUntilRows_([{ __rowNo: 3, SERVICE_DATE: '2027-10-10', REPEAT_UNTIL: '2027-11-07' }], dates);
  assert.deepStrictEqual(Array.from(beyond.rows.map(function (r) { return r.__isoDate; })), ['2027-10-10', '2027-10-17']);
  assert.deepStrictEqual(Array.from(beyond.warnings), []);
  const inside = sb.expandRepeatUntilRows_([{ __rowNo: 3, SERVICE_DATE: '2027-10-03', REPEAT_UNTIL: '2027-10-12' }], dates);
  assert.deepStrictEqual(Array.from(inside.rows.map(function (r) { return r.__isoDate; })), ['2027-10-03', '2027-10-10']);
  assert.strictEqual(inside.warnings.length, 1);
});

console.log('\n匯入（真入口 applyContentImport_）');

test('CO-4 上一季的報告「連續到」本季第二個主日 → 本季頭兩個主日都有；排在同次序的本季報告前面；上一季其他行不帶', function () {
  const env = makeEnv({
    content: { 家事報告: [{ SERVICE_DATE: '2027-10-03', SEQ_NO: '10', TEXT: '本季的報告', ACTIVE: 'TRUE' }] },
    otherContentSheets: prevSheet({
      家事報告: [
        { SERVICE_DATE: '2027-09-19', REPEAT_UNTIL: '2027-10-10', SEQ_NO: '10', TEXT: '跨季的報告', ACTIVE: 'TRUE' },
        { SERVICE_DATE: '2027-09-26', REPEAT_UNTIL: '', SEQ_NO: '10', TEXT: '只在上一季', ACTIVE: 'TRUE' },
        { SERVICE_DATE: '2027-09-12', REPEAT_UNTIL: '2027-09-26', SEQ_NO: '10', TEXT: '連到上一季為止', ACTIVE: 'TRUE' },
        { SERVICE_DATE: '2027-09-26', REPEAT_UNTIL: '2027-10-24', SEQ_NO: '10', TEXT: '已停用', ACTIVE: 'FALSE' }
      ],
      代禱事項: [{ SERVICE_DATE: '2027-09-26', REPEAT_UNTIL: '2027-10-03', SEQ_NO: '', TEXT: '跨季代禱', ACTIVE: 'TRUE' }]
    })
  });
  const r = env.sandbox.applyContentImport_(QUARTER_ID, {});
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.deepStrictEqual(activeTexts(env, 'Announcements', '2027-10-03'), ['跨季的報告', '本季的報告']);
  assert.deepStrictEqual(activeTexts(env, 'Announcements', '2027-10-10'), ['跨季的報告']);
  assert.deepStrictEqual(activeTexts(env, 'Announcements', '2027-10-17'), []);
  assert.deepStrictEqual(activeTexts(env, 'Prayers', '2027-10-03'), ['跨季代禱']);
  assert.deepStrictEqual(activeTexts(env, 'Prayers', '2027-10-10'), []);
  // 再匯入一次 0 改動（冪等）。
  const again = env.sandbox.previewContentImport_(QUARTER_ID, {});
  assert.strictEqual(again.plan.added + again.plan.updated + again.plan.removed, 0);
});

test('CO-5 只匯入一個主日（填寫介面載入）亦帶入；上一季那一行改內容／停用 → 本季跟着改', function () {
  const env = makeEnv({
    content: { 家事報告: [{ SERVICE_DATE: '2027-10-17', SEQ_NO: '10', TEXT: '本季', ACTIVE: 'TRUE' }] },
    otherContentSheets: prevSheet({
      家事報告: [{ SERVICE_DATE: '2027-09-19', REPEAT_UNTIL: '2027-10-10', SEQ_NO: '10', TEXT: '跨季', ACTIVE: 'TRUE' }]
    })
  });
  env.sandbox.applyContentImport_(QUARTER_ID, { isoDate: '2027-10-10' });
  assert.deepStrictEqual(activeTexts(env, 'Announcements', '2027-10-10'), ['跨季']);
  // 改上一季那一行（模擬幹事在上一季內容表改內容）。
  const prev = env.sandbox.SpreadsheetApp.openById(PREV_FILE).getSheetByName('家事報告');
  const keys = env.sandbox.contentSheetTabDefs_().filter(function (d) { return d.tabName === '家事報告'; })[0].keys;
  prev.getRange(3, keys.indexOf('TEXT') + 1).setValue('跨季（改了）');
  env.sandbox.applyContentImport_(QUARTER_ID, {});
  assert.deepStrictEqual(activeTexts(env, 'Announcements', '2027-10-03'), ['跨季（改了）']);
  prev.getRange(3, keys.indexOf('ACTIVE') + 1).setValue('FALSE');
  env.sandbox.applyContentImport_(QUARTER_ID, {});
  assert.deepStrictEqual(activeTexts(env, 'Announcements', '2027-10-03'), []);
  assert.deepStrictEqual(activeTexts(env, 'Announcements', '2027-10-10'), []);
});

test('CO-6 本季這張分頁整張空白、只有上一季帶過來的：只動那幾個主日，其餘主日週報原有的行不動（安全規則 1）', function () {
  const env = makeEnv({
    announcements: [{ SERVICE_DATE: '2027-10-24', SEQ_NO: 10, TEXT: '原有的', ACTIVE: true }],
    otherContentSheets: prevSheet({
      家事報告: [{ SERVICE_DATE: '2027-09-19', REPEAT_UNTIL: '2027-10-03', SEQ_NO: '10', TEXT: '跨季', ACTIVE: 'TRUE' }]
    })
  });
  env.sandbox.applyContentImport_(QUARTER_ID, {});
  assert.deepStrictEqual(activeTexts(env, 'Announcements', '2027-10-03'), ['跨季']);
  assert.deepStrictEqual(activeTexts(env, 'Announcements', '2027-10-24'), ['原有的']);
});

test('CO-7 上一季沒有內容表＝正常（沒有警告）；有登記但開不到、版面未更新 → 警告講明，本季照常匯入', function () {
  const none = makeEnv({ content: { 家事報告: [{ SERVICE_DATE: '2027-10-03', SEQ_NO: '10', TEXT: '本季', ACTIVE: 'TRUE' }] } });
  const p0 = none.sandbox.previewContentImport_(QUARTER_ID, {});
  assert.strictEqual(p0.ok, true);
  assert.strictEqual(p0.plan.warnings.filter(function (w) { return w.indexOf('上一季') !== -1; }).length, 0);

  const missing = makeEnv({
    content: { 家事報告: [{ SERVICE_DATE: '2027-10-03', SEQ_NO: '10', TEXT: '本季', ACTIVE: 'TRUE' }] },
    otherContentSheets: prevSheet({}, { missing: true })
  });
  const p1 = missing.sandbox.previewContentImport_(QUARTER_ID, {});
  assert.strictEqual(p1.ok, true);
  const w1 = p1.plan.warnings.filter(function (w) { return w.indexOf('上一季（2027T3）的內容表開不到') !== -1; });
  assert.strictEqual(w1.length, 1, JSON.stringify(p1.plan.warnings));
  assertWrittenChinese(assert, '開不到', w1);
  assert.strictEqual(p1.plan.added, 1, '本季照常');

  const old = makeEnv({
    content: { 家事報告: [{ SERVICE_DATE: '2027-10-03', SEQ_NO: '10', TEXT: '本季', ACTIVE: 'TRUE' }] },
    otherContentSheets: prevSheet({}, { layout: 'v3' })
  });
  const p2 = old.sandbox.previewContentImport_(QUARTER_ID, {});
  assert.strictEqual(p2.ok, true);
  assert.strictEqual(p2.plan.warnings.filter(function (w) { return w.indexOf('上一季（2027T3）的內容表版面未更新') !== -1; }).length, 1,
    JSON.stringify(p2.plan.warnings));
});

test('CO-8 selectContentCarryOverRows_：有格被轉成日期／時間的跨季行不帶，講出來；團契、財政不帶', function () {
  const sb = makeEnv().sandbox;
  const out = sb.selectContentCarryOverRows_({
    家事報告: [
      { __rowNo: 3, __active: true, SERVICE_DATE: '2027-09-19', REPEAT_UNTIL: '2027-10-10', TEXT: '好', __typeIssues: [] },
      { __rowNo: 4, __active: true, SERVICE_DATE: '2027-09-19', REPEAT_UNTIL: '2027-10-10', TEXT: '壞', __typeIssues: ['TEXT'] }
    ],
    團契聚會: [{ __rowNo: 3, __active: true, SERVICE_DATE: '2027-09-19', REPEAT_UNTIL: '2027-10-10', __typeIssues: [] }]
  }, '2027-10-03', PREV_QID);
  assert.deepStrictEqual(Object.keys(out.rowsByTab), ['家事報告']);
  assert.deepStrictEqual(Array.from(out.rowsByTab['家事報告'].map(function (r) { return r.TEXT; })), ['好']);
  assert.strictEqual(out.warnings.length, 1);
  assert.ok(out.warnings[0].indexOf('第 4 行') !== -1, out.warnings[0]);
});

console.log('\n自動同步（真入口 runContentAutoSync_）');

test('CO-9 只有上一季的內容表改了 → 本季照樣自動同步（修改時間合併兩份）', function () {
  const env = makeEnv({
    config: { WEBAPP_SIMULATED_TODAY: '2027-10-01' },
    content: { 家事報告: [{ SERVICE_DATE: '2027-10-17', SEQ_NO: '10', TEXT: '本季', ACTIVE: 'TRUE' }] },
    otherContentSheets: prevSheet({
      家事報告: [{ SERVICE_DATE: '2027-09-19', REPEAT_UNTIL: '2027-10-10', SEQ_NO: '10', TEXT: '跨季', ACTIVE: 'TRUE' }]
    })
  });
  const sb = env.sandbox;
  // 修改時間要用沙盒內的 Date（instanceof 跨 realm 不成立）。
  const times = { FAKE_CONTENT_FILE: '2027-01-01', FAKE_PREV_CONTENT_FILE: '2027-01-02' };
  sb.DriveApp.getFileById = function (id) { return { getLastUpdated: function () { return sb.normalizeDate_(times[id]); } }; };
  const props = {};
  sb.PropertiesService = { getScriptProperties: function () {
    return { getProperty: function (k) { return props[k] === undefined ? null : props[k]; }, setProperty: function (k, v) { props[k] = String(v); },
      deleteProperty: function (k) { delete props[k]; } };
  } };
  const first = sb.runContentAutoSync_({ todayIso: '2027-10-01' });
  const q = first.quarters.filter(function (e) { return e.quarterId === QUARTER_ID; })[0];
  assert.strictEqual(q.status, 'IMPORTED', JSON.stringify(first));
  assert.deepStrictEqual(activeTexts(env, 'Announcements', '2027-10-03'), ['跨季']);
  const second = sb.runContentAutoSync_({ todayIso: '2027-10-01' });
  assert.strictEqual(second.quarters.filter(function (e) { return e.quarterId === QUARTER_ID; })[0].status, 'UNCHANGED');
  // 只改上一季
  const prev = sb.SpreadsheetApp.openById(PREV_FILE).getSheetByName('家事報告');
  const keys = sb.contentSheetTabDefs_().filter(function (d) { return d.tabName === '家事報告'; })[0].keys;
  prev.getRange(3, keys.indexOf('TEXT') + 1).setValue('跨季（改了）');
  times.FAKE_PREV_CONTENT_FILE = '2027-01-03';
  const third = sb.runContentAutoSync_({ todayIso: '2027-10-01' });
  assert.strictEqual(third.quarters.filter(function (e) { return e.quarterId === QUARTER_ID; })[0].status, 'IMPORTED', JSON.stringify(third));
  assert.deepStrictEqual(activeTexts(env, 'Announcements', '2027-10-10'), ['跨季（改了）']);
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
