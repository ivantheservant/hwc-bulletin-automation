#!/usr/bin/env node
/**
 * tests/carryovercache.test.js
 *
 * 2026-11-03（Ivan：「proceed 提速」；職事表提速經驗「費時的計算按簽名快取」）：
 *   「上一季連續到」（src/ContentCarryOver.gs）在填寫介面平常載入時，上一季內容表的修改時間與上次一樣、
 *   十分鐘之內，就用記下的結果，不打開上一季內容表。重新載入（讀最新）一律打開。
 *
 *   真正入口：apiAutoImportWeek（填寫介面背景匯入）。
 *
 * 執行方式：node tests/carryovercache.test.js
 */

'use strict';

const assert = require('assert');
const vm = require('vm');
const contentEnv = require('./helpers/contentEnv');

let pass = 0;
let fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); } catch (err) {
    fail++; console.log('  ✗ ' + name); console.log('    ' + (err && err.stack ? err.stack.split('\n').slice(0, 6).join('\n    ') : err));
  }
}

const QUARTER_ID = contentEnv.QUARTER_ID;
const D1 = contentEnv.SERVICE_DATES[0];
const PREV_QID = '2027T3';
const PREV_FILE = 'FAKE_PREV_CONTENT_FILE';
const OWN_FILE = 'FAKE_CONTENT_FILE';

function makeCacheEnv() {
  const env = contentEnv.makeEnv({
    content: { 家事報告: [{ SERVICE_DATE: D1, SEQ_NO: '20', TEXT: '本季的報告', ACTIVE: 'TRUE' }] },
    otherContentSheets: [{
      quarterId: PREV_QID, fileId: PREV_FILE,
      content: { 家事報告: [{ SERVICE_DATE: '2027-09-19', REPEAT_UNTIL: D1, SEQ_NO: '10', TEXT: '跨季的報告', ACTIVE: 'TRUE' }] }
    }]
  });
  const sb = env.sandbox;
  const mtimes = {};
  mtimes[OWN_FILE] = Date.UTC(2027, 0, 1);
  mtimes[PREV_FILE] = Date.UTC(2027, 0, 1);
  sb.DriveApp.getFileById = function (id) {
    return { getLastUpdated: function () { return mtimes[id] === undefined ? null : vm.runInContext('new Date(' + mtimes[id] + ')', sb); } };
  };
  const props = {};
  sb.PropertiesService = { getScriptProperties: function () {
    return { getProperty: function (k) { return props[k] === undefined ? null : props[k]; }, setProperty: function (k, v) { props[k] = String(v); },
      deleteProperty: function (k) { delete props[k]; } };
  } };
  const realOpen = sb.SpreadsheetApp.openById;
  const opened = { own: 0, prev: 0 };
  sb.SpreadsheetApp.openById = function (id) {
    if (id === OWN_FILE) opened.own++;
    if (id === PREV_FILE) opened.prev++;
    return realOpen.apply(this, arguments);
  };
  return { env: env, sb: sb, mtimes: mtimes, opened: opened, props: props };
}

function activeTexts(t, iso) {
  return Array.from(t.sb.readSheet_('Announcements')
    .filter(function (r) { return r.ACTIVE === true && t.sb.formatIsoDate_(r.SERVICE_DATE) === iso; })
    .sort(function (a, b) { return Number(a.SEQ_NO) - Number(b.SEQ_NO); })
    .map(function (r) { return r.TEXT; }));
}

/** 改本季內容表的一格（同時推前它的修改時間），令下一次載入要重新比較。 */
function editOwnContent(t, text) {
  const sheet = t.sb.SpreadsheetApp.openById(OWN_FILE).getSheetByName('家事報告');
  const keys = t.sb.contentSheetTabDefs_().filter(function (d) { return d.tabName === '家事報告'; })[0].keys;
  sheet.getRange(3, keys.indexOf('TEXT') + 1).setValue(text);
  t.mtimes[OWN_FILE] += 60000;
}

console.log('\n上一季連續到的記錄（真入口 apiAutoImportWeek）');

test('CC-1 第一次打開上一季內容表並記下；本季內容表改了、上一季沒有改 → 不再打開上一季，跨季報告照樣在', function () {
  const t = makeCacheEnv();
  const first = t.sb.apiAutoImportWeek(D1);
  assert.strictEqual(first.ok, true, JSON.stringify(first.error));
  assert.deepStrictEqual(activeTexts(t, D1), ['跨季的報告', '本季的報告']);
  assert.strictEqual(t.opened.prev, 1, '第一次要打開上一季');

  editOwnContent(t, '本季的報告（改了）');
  const before = t.opened.prev;
  const second = t.sb.apiAutoImportWeek(D1);
  assert.strictEqual(second.ok, true, JSON.stringify(second.error));
  assert.ok(second.data.autoImport.changed > 0, JSON.stringify(second.data.autoImport));
  assert.strictEqual(t.opened.prev, before, '上一季沒有改過：用記錄，不打開');
  assert.deepStrictEqual(activeTexts(t, D1), ['跨季的報告', '本季的報告（改了）'], '跨季報告不可以因為用了記錄而被停用');
});

test('CC-2 上一季內容表改了（修改時間不同）→ 再打開上一季，新內容帶入本季', function () {
  const t = makeCacheEnv();
  t.sb.apiAutoImportWeek(D1);
  const prev = t.sb.SpreadsheetApp.openById(PREV_FILE).getSheetByName('家事報告');
  const keys = t.sb.contentSheetTabDefs_().filter(function (d) { return d.tabName === '家事報告'; })[0].keys;
  prev.getRange(3, keys.indexOf('TEXT') + 1).setValue('跨季的報告（改了）');
  t.mtimes[PREV_FILE] += 60000;
  const before = t.opened.prev;
  const again = t.sb.apiAutoImportWeek(D1);
  assert.strictEqual(again.ok, true, JSON.stringify(again.error));
  assert.ok(t.opened.prev > before, '修改時間不同：要打開上一季');
  assert.deepStrictEqual(activeTexts(t, D1), ['跨季的報告（改了）', '本季的報告']);
});

test('CC-3 重新載入（讀最新，fresh）→ 一律打開上一季，不用記錄', function () {
  const t = makeCacheEnv();
  t.sb.apiAutoImportWeek(D1);
  const before = t.opened.prev;
  const fresh = t.sb.apiAutoImportWeek(D1, { fresh: true });
  assert.strictEqual(fresh.ok, true, JSON.stringify(fresh.error));
  assert.ok(t.opened.prev > before, 'fresh：要打開上一季');
});

test('CC-4 記錄有日期物件就不記（JSON 會變成文字）；記錄的版本、修改時間、第一個主日對不上就不用', function () {
  const t = makeCacheEnv();
  const sb = t.sb;
  const dated = { rowsByTab: { 家事報告: [{ TEXT: 'x', WHEN: vm.runInContext('new Date(0)', sb) }] }, warnings: [], skipThrough: {}, managedTabs: {} };
  const match = { v: sb.CARRY_OVER_CACHE_VERSION_, mtime: 5, first: D1, quarter: PREV_QID };
  assert.strictEqual(sb.storeCarryOverCache_('K1', match, dated), false);
  assert.strictEqual(sb.containsDateValue_({ a: [1, { b: 'x' }] }), false);
  const plainResult = { rowsByTab: { 家事報告: [{ TEXT: 'x' }] }, warnings: [], skipThrough: {}, managedTabs: {} };
  assert.strictEqual(sb.storeCarryOverCache_('K2', match, plainResult), true);
  assert.ok(sb.readCarryOverCache_('K2', match), '完全對得上：用');
  assert.strictEqual(sb.readCarryOverCache_('K2', Object.assign({}, match, { mtime: 6 })), null);
  assert.strictEqual(sb.readCarryOverCache_('K2', Object.assign({}, match, { first: '2099-01-01' })), null);
  assert.strictEqual(sb.readCarryOverCache_('K2', Object.assign({}, match, { v: 'old' })), null);
  t.props.K3 = 'not json';
  assert.strictEqual(sb.readCarryOverCache_('K3', match), null, '壞了：不用');
});

test('CC-5 分段用時：apiAutoImportWeek 有「內容表：上一季連續到」與「（其中讀週報試算表 …）」', function () {
  const t = makeCacheEnv();
  const r = t.sb.apiAutoImportWeek(D1);
  const labels = Array.from(r.data.timings.parts.map(function (p) { return p.label; }));
  assert.ok(labels.indexOf('內容表：上一季連續到') !== -1, labels.join('、'));
  assert.ok(labels.some(function (l) { return /^（其中讀週報試算表 \d+ 次；最慢：/.test(l); }), labels.join('、'));
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
