#!/usr/bin/env node
/**
 * tests/personsplit.test.js
 *
 * 2026-11-03（Ivan：「跟以往週報」）：職事表同一格寫了幾個名字（例如 10-18 司琴「李潔慈、林敏恒」）
 *   → 逐個名字套尊稱，再用一個空格分開，與以往週報一樣（「李潔慈姊妹 林敏恒弟兄」；第 3 頁不加尊稱＝「李潔慈 林敏恒」）。
 *   分隔字由 Config `PERSON_NAME_SPLIT_CHARS` 決定（預設「、」，留空＝不拆）。
 *
 * 執行方式：node tests/personsplit.test.js
 */

'use strict';

const assert = require('assert');
const { loadAllSrcFilesInOrder } = require('./helpers/loadGas');

const sb = loadAllSrcFilesInOrder({
  Utilities: { formatDate: function () { return ''; } },
  Session: { getScriptTimeZone: function () { return 'Pacific/Auckland'; }, getActiveUser: function () { return { getEmail: function () { return ''; } }; } },
  SpreadsheetApp: {}, CacheService: {}
});

let pass = 0;
let fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); } catch (err) { fail++; console.log('  ✗ ' + name); console.log('    ' + err.message); }
}
function row(id, name, hon, extra) {
  return Object.assign({ PERSON_ID: id, NAME_TC: name, HONORIFIC: hon, DISPLAY_OVERRIDE: '', EFFECTIVE_FROM: null, EFFECTIVE_TO: null, ACTIVE: true }, extra || {});
}
const ROWS = [row('P1', '李潔慈', '姊妹'), row('P2', '林敏恒', '弟兄'), row('P3', '黃牧', '牧師')];
function opts(extra) { return Object.assign({ withHonorific: true, personDisplayRows: ROWS, targetDate: null, warnings: [] }, extra || {}); }

console.log('\n同一格幾個名字');

test('PS-1 拆字：預設「、」；多個分隔字；留空不拆；空白去掉', function () {
  assert.deepStrictEqual(Array.from(sb.splitJoinedPersonNames_('李潔慈、林敏恒')), ['李潔慈', '林敏恒']);
  assert.deepStrictEqual(Array.from(sb.splitJoinedPersonNames_(' 李潔慈 、 林敏恒 、')), ['李潔慈', '林敏恒']);
  assert.deepStrictEqual(Array.from(sb.splitJoinedPersonNames_('甲，乙、丙', '、，')), ['甲', '乙', '丙']);
  assert.deepStrictEqual(Array.from(sb.splitJoinedPersonNames_('李潔慈、林敏恒', '')), ['李潔慈、林敏恒']);
  assert.deepStrictEqual(Array.from(sb.splitJoinedPersonNames_('')), []);
  assert.deepStrictEqual(Array.from(sb.splitJoinedPersonNames_('Robert Mark郭斯旋')), ['Robert Mark郭斯旋'], '空格不是分隔字');
});

test('PS-2 職事表一格兩個名字：第 1 頁逐個加尊稱、空格分開；第 3 頁不加尊稱', function () {
  assert.strictEqual(sb.resolvePersonDisplay_('', '李潔慈、林敏恒', opts()), '李潔慈姊妹 林敏恒弟兄');
  assert.strictEqual(sb.resolvePersonDisplay_('', '李潔慈、林敏恒', opts({ withHonorific: false })), '李潔慈 林敏恒');
  // 有 PersonID（職事表把兩個名字寫在其中一個人的格）亦一樣按名字逐個查。
  assert.strictEqual(sb.resolvePersonDisplay_('P1', '李潔慈、林敏恒', opts()), '李潔慈姊妹 林敏恒弟兄');
  // 職稱類尊稱第 3 頁照樣保留。
  assert.strictEqual(sb.resolvePersonDisplay_('', '黃牧、林敏恒', opts({ withHonorific: false })), '黃牧牧師 林敏恒');
});

test('PS-3 名單以外的名字照印；人手覆寫亦拆開，對不上的名字照舊記警告', function () {
  assert.strictEqual(sb.resolvePersonDisplay_('', '李潔慈、訪客甲', opts()), '李潔慈姊妹 訪客甲');
  const o = opts();
  assert.strictEqual(sb.resolveOverrideDisplay_('林敏恒、訪客乙', o), '林敏恒弟兄 訪客乙');
  assert.strictEqual(o.warnings.length, 1);
  assert.strictEqual(o.warnings[0].name, '訪客乙');
});

test('PS-4 整格本身對得上 PersonDisplay 的一行就不拆；留空 Config＝不拆（舊行為）', function () {
  const rows = ROWS.concat([row('P9', '王、李', '伉儷')]);
  assert.strictEqual(sb.resolvePersonDisplay_('', '王、李', opts({ personDisplayRows: rows })), '王、李伉儷');
  assert.strictEqual(sb.resolvePersonDisplay_('', '李潔慈、林敏恒', opts({ nameSplitChars: '' })), '李潔慈、林敏恒');
});

test('PS-5 事奉框（真正組框的函式）：一個 slot 寫了兩個名字 → 「李潔慈姊妹 林敏恒弟兄」', function () {
  const snapshot = { isoDate: '2026-10-18', found: true, slotsByPost: { PIANIST: [
    { state: sb.ROSTER_SLOT_STATE_.ASSIGNED, personId: '', personName: '李潔慈、林敏恒', rosterName: '李潔慈、林敏恒', slotIndex: 1 }
  ] } };
  const post = { POST_ID: 'PIANIST', ACTIVE: true, SHOW_ON_PAGE1: true, PAGE1_ORDER: 1, PAGE1_NAME: '司琴', PAGE1_MERGE_GROUP: '', SHOW_ON_PAGE3: true, PAGE3_ORDER: 1, PAGE3_NAME: '司琴', PAGE3_MERGE_GROUP: '' };
  const rows = sb.buildDutyBoxRows_({ snapshot: snapshot, page: 1, postDisplayRows: [post], mergeGroupRows: [], personDisplayRows: ROWS,
    withHonorific: true, nameSplitChars: '、', targetDate: null, warnings: [] });
  assert.strictEqual(rows.length, 1, JSON.stringify(rows));
  assert.strictEqual(rows[0].text, '李潔慈姊妹 林敏恒弟兄');
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
if (fail > 0) process.exit(1);
