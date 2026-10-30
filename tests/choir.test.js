#!/usr/bin/env node
/**
 * tests/choir.test.js
 *
 * 2026-10-31（Ivan 批准，職事表第九十輪 d3d8365）：
 *   1. ServiceDates.ChoirSinging：TRUE＝這個主日詩班獻詩（沒有這一欄＝全部不是）。填寫介面甲區顯示；
 *      獻詩主日而「詩班曲名」空白 → 待填；這一季有設定獻詩主日、這一個主日不是而填了曲名 → 警告（照印）。
 *   2. Posts.ShowInRoster＝FALSE 的行（例如 CHOIR 詩班）不是崗位，讀 Posts 時略過。
 *   3. 〔設定詩班獻詩〕：Config ROSTER_WEBAPP_URL＋?view=choir&quarter=。
 * 一律經真正入口：buildBulletinModel_、apiLoadWeek、readRosterSnapshotForWeek_。週報不寫職事表。
 *
 * 執行方式：node tests/choir.test.js
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
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
const ROSTER_URL = 'https://script.google.com/a/x/s/ROSTER/exec';
const CHOIR_POST = { PostID: 'CHOIR', PostName_TC: '詩班', SlotCount: 20, Frequency: 'WEEKLY', AutoGenerate: false,
  DisplayOrder: 99, Active: true, EmptyDisplay: '', ShowInRoster: 'FALSE' };

console.log('\n詩班獻詩、名單組別、深連結');

test('CH-1 buildRosterViewUrl_：view=choir 帶季度；不認得的畫面不顯示；合堂照舊', function () {
  const sb = makeWordEnv().sandbox;
  assert.strictEqual(sb.buildRosterViewUrl_(ROSTER_URL, 'choir', '2027T4'), ROSTER_URL + '?view=choir&quarter=2027T4');
  assert.strictEqual(sb.buildRosterViewUrl_(ROSTER_URL, 'p', '2027T4'), '', '不可以用 p／q 等其他參數');
  assert.strictEqual(sb.buildRosterViewUrl_('http://x/exec', 'choir', '2027T4'), '');
  assert.strictEqual(sb.buildRosterCombinedUrl_(ROSTER_URL, '2027T4'), ROSTER_URL + '?view=combined&quarter=2027T4');
});

test('CH-2 Posts.ShowInRoster：FALSE（文字或布林）略過；留空、TRUE、沒有這一欄＝崗位', function () {
  const sb = makeWordEnv().sandbox;
  const list = plain(sb.buildActiveRosterPostsList_([
    { PostID: 'A', Active: true, DisplayOrder: 1, ShowInRoster: '' },
    { PostID: 'B', Active: true, DisplayOrder: 2, ShowInRoster: 'TRUE' },
    { PostID: 'C', Active: true, DisplayOrder: 3, ShowInRoster: 'false' },
    { PostID: 'D', Active: true, DisplayOrder: 4, ShowInRoster: false },
    { PostID: 'E', Active: true, DisplayOrder: 5 }
  ]));
  assert.deepStrictEqual(list.map(function (p) { return p.postId; }), ['A', 'B', 'E']);
});

test('CH-3 真入口：職事表的「詩班」名單組別不會變成崗位（平常主日、特別崇拜都一樣）', function () {
  const env = makeWordEnv({ rosterPosts: [CHOIR_POST] });
  const snap = env.sandbox.readRosterSnapshotForWeek_(D);
  assert.strictEqual(snap.found, true);
  assert.deepStrictEqual(plain(snap.posts).map(function (p) { return p.postId; }), ['CHAIR']);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(snap.slotsByPost, 'CHOIR'), false);
  const special = env.sandbox.specialServiceRosterSnapshot_(Object.assign({}, snap, { found: false }), {});
  assert.deepStrictEqual(plain(special.assignments).map(function (a) { return a.postId; }), ['CHAIR'], '特別崇拜不會多出 20 格「詩班」');
});

test('CH-4 獻詩主日：詩班曲名空白 → 待填（講明在甲區填）；填了就不列', function () {
  const env = makeWordEnv({ choirSundays: [D] });
  const m = env.sandbox.buildBulletinModel_(D);
  assert.strictEqual(m.choirSinging, true);
  const item = plain(m.missing).filter(function (x) { return x.field === 'CHOIR_TITLE'; })[0];
  assert.ok(item, JSON.stringify(plain(m.missing)));
  assert.strictEqual(item.optional, false);
  assert.ok(item.reason.indexOf('職事表：這一個主日詩班獻詩') !== -1, item.reason);
  assertWrittenChinese(assert, '待填', [item.reason]);
  const filled = makeWordEnv({ choirSundays: [D], weekRows: [
    { SERVICE_DATE: D, QUARTER_ID: '2027T4', WEEK_OF_MONTH: 1, STATUS: 'DRAFT', CHOIR_TITLE: '主的愛' },
    { SERVICE_DATE: D_NEXT, QUARTER_ID: '2027T4', WEEK_OF_MONTH: 2, STATUS: 'DRAFT' }
  ] });
  assert.strictEqual(plain(filled.sandbox.buildBulletinModel_(D).missing).filter(function (x) { return x.field === 'CHOIR_TITLE'; }).length, 0);
  // 不是獻詩主日：詩班曲名空白不算缺（與以前一樣）。
  assert.strictEqual(plain(env.sandbox.buildBulletinModel_(D_NEXT).missing).filter(function (x) { return x.field === 'CHOIR_TITLE'; }).length, 0);
});

test('CH-5 這一季有設定獻詩主日，這一個主日不是卻填了曲名 → 警告（照印）；這一季未設定（或職事表沒有這一欄）→ 不警告', function () {
  const rows = [
    { SERVICE_DATE: D, QUARTER_ID: '2027T4', WEEK_OF_MONTH: 1, STATUS: 'DRAFT', CHOIR_TITLE: '主的愛' },
    { SERVICE_DATE: D_NEXT, QUARTER_ID: '2027T4', WEEK_OF_MONTH: 2, STATUS: 'DRAFT' }
  ];
  const env = makeWordEnv({ choirSundays: [D_NEXT], weekRows: rows });
  const w = plain(env.sandbox.buildBulletinModel_(D).warnings).filter(function (x) { return x.code === 'CHOIR_NOT_IN_ROSTER'; });
  assert.strictEqual(w.length, 1);
  assert.ok(w[0].message.indexOf('「主的愛」') !== -1 && w[0].message.indexOf('照樣會印') !== -1, w[0].message);
  assertWrittenChinese(assert, '警告', [w[0].message]);
  const unset = makeWordEnv({ weekRows: rows });
  assert.strictEqual(plain(unset.sandbox.buildBulletinModel_(D).warnings).filter(function (x) { return x.code === 'CHOIR_NOT_IN_ROSTER'; }).length, 0);
});

test('CH-6 apiLoadWeek：choirSinging 與〔設定詩班獻詩〕網址；ROSTER_WEBAPP_URL 留空就不顯示', function () {
  const env = makeWordEnv({ choirSundays: [D], config: { ROSTER_WEBAPP_URL: ROSTER_URL } });
  const load = env.sandbox.apiLoadWeek(D);
  assert.strictEqual(load.ok, true, JSON.stringify(load.error));
  assert.strictEqual(load.data.choirSinging, true);
  assert.strictEqual(load.data.rosterChoirUrl, ROSTER_URL + '?view=choir&quarter=2027T4');
  const other = env.sandbox.apiLoadWeek(D_NEXT);
  assert.strictEqual(other.data.choirSinging, false);
  const none = makeWordEnv({ config: { ROSTER_WEBAPP_URL: '' } }).sandbox.apiLoadWeek(D);
  assert.strictEqual(none.data.rosterChoirUrl, '');
});

test('CH-7 週報不寫職事表：讀詩班獻詩、名單組別之後 ServiceDates、Posts 完全不變', function () {
  const env = makeWordEnv({ choirSundays: [D], rosterPosts: [CHOIR_POST] });
  const roster = env.sandbox.SpreadsheetApp.openById(env.sandbox.getConfig_('ROSTER_SPREADSHEET_ID', ''));
  function dump(name) { const sh = roster.getSheetByName(name); return JSON.stringify(sh.getRange(1, 1, sh.getLastRow(), sh.getLastColumn()).getValues()); }
  const before = dump('ServiceDates') + dump('Posts');
  env.sandbox.apiLoadWeek(D);
  env.sandbox.buildBulletinModel_(D_NEXT);
  assert.strictEqual(dump('ServiceDates') + dump('Posts'), before);
});

test('CH-8 介面：甲區「詩班曲名」旁邊有提示與〔設定詩班獻詩〕（新分頁）；載入時呼叫 renderRosterChoir', function () {
  const index = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'Index.html'), 'utf8');
  const script = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'Script.html'), 'utf8');
  assert.ok(/id="choirRosterHint"/.test(index));
  assert.ok(/<a id="rosterChoirLink"[^>]*target="_blank"[^>]*rel="noopener"/.test(index));
  assert.ok(/id="rosterChoirHint"/.test(index));
  assert.ok(script.indexOf('renderRosterChoir(data.choirSinging === true, data.rosterChoirUrl)') !== -1);
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
