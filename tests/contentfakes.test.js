#!/usr/bin/env node
/**
 * tests/contentfakes.test.js
 *
 * 內容表 v2 Commit 1：證明內容表的假替身**真的測得出**它要測的東西（docs/已知bug類型.md
 * bug class 46：在一個「甚麼都不做」的假替身上驗證修正，修不修都是綠的）。每一條都是「應該紅」
 * 的案例：替身要拋錯、要轉型、要跟住改名，否則之後的移轉測試靠不住。
 *
 * 執行方式：node tests/contentfakes.test.js
 * 離開碼：0＝全部通過　1＝有測試失敗
 */

'use strict';

const assert = require('assert');
const { makeContentTab, makeContentSpreadsheet, makeContentFaults } = require('./helpers/contentTabFake');
const { makeEnv } = require('./helpers/contentEnv');
const { legacyContentTabDefsV1, legacyContentTabDefV1 } = require('./fixtures/legacyContentSheetV1');

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
    console.log('    ' + err.message);
  }
}

test('F1. getRange() 超出分頁欄數就拋錯（真的 Sheets 一樣拋）', function () {
  const tab = makeContentTab(['A', 'B'], ['甲', '乙'], [], { name: '測試', maxColumns: 3 });
  tab.getRange(3, 1, 1, 3).getValues();
  assert.throws(function () { tab.getRange(3, 1, 1, 4); }, /超出/);
  tab.insertColumnsAfter(3, 2);
  tab.getRange(3, 1, 1, 5).getValues();
});

test('F2. 沒有先設純文字格式的「42,150」會被轉成數字；先設 @ 就保留原文', function () {
  const tab = makeContentTab(['A', 'B'], ['甲', '乙'], [], { name: '測試' });
  tab.getRange(3, 1).setValue('42,150');
  assert.strictEqual(tab.__data[2][0], 42150);
  tab.getRange(3, 2).setNumberFormat('@');
  tab.getRange(3, 2).setValue('42,150');
  assert.strictEqual(tab.__data[2][1], '42,150');
});

test('F3. 改名之後 getSheetByName() 跟住新名字走；撞名拋錯', function () {
  const a = makeContentTab(['A'], ['甲'], [], { name: '宣召' });
  const b = makeContentTab(['A'], ['甲'], [], { name: '崇拜程序' });
  const ss = makeContentSpreadsheet({ id: 'X', url: 'u', tabs: [a, b] });
  a.setName('宣召（已停用）');
  assert.strictEqual(ss.getSheetByName('宣召'), null);
  assert.strictEqual(ss.getSheetByName('宣召（已停用）'), a);
  assert.throws(function () { b.setName('宣召（已停用）'); }, /已經有一張分頁/);
});

test('F4. 注入失敗：第 N 次寫入、第 N 次改名拋錯', function () {
  const faults = makeContentFaults({ failOnSetValue: 2, failOnSetName: 1 });
  const tab = makeContentTab(['A'], ['甲'], [], { name: '測試', faults: faults });
  tab.getRange(3, 1).setValue('一');
  assert.throws(function () { tab.getRange(4, 1).setValue('二'); }, /注入的寫入失敗/);
  assert.throws(function () { tab.setName('新名'); }, /注入的改名失敗/);
});

test('F5. 隱藏、保護、註解都有記錄', function () {
  const tab = makeContentTab(['A'], ['甲'], [], { name: '測試' });
  assert.strictEqual(tab.isSheetHidden(), false);
  tab.hideSheet();
  assert.strictEqual(tab.isSheetHidden(), true);
  tab.protect().setDescription('說明').setWarningOnly(true);
  assert.strictEqual(tab.getProtections().length, 1);
  assert.strictEqual(tab.__protections[0].warningOnly, true);
  tab.getRange(1, 1).setNote('已停用');
  assert.strictEqual(tab.getRange(1, 1).getNote(), '已停用');
});

test('F6. contentEnv：寫了一個版面沒有的分頁名稱就拋錯（不再靜靜當成空白）', function () {
  assert.throws(function () { makeEnv({ content: { 不存在的分頁: [{ SERVICE_DATE: '2027-10-03' }] } }); }, /沒有「不存在的分頁」/);
});

test('F7. contentEnv 的 v1 版面：由凍結的舊定義造，有「宣召」「浸禮合堂」與 7 欄的「崇拜程序」', function () {
  const env = makeEnv({ contentLayout: 'v1', content: { 宣召: [{ SERVICE_DATE: '2027-10-03', CALL_REF: '詩篇 100' }] } });
  const names = env.contentSpreadsheet.__tabNames();
  assert.ok(names.indexOf('宣召') !== -1 && names.indexOf('浸禮合堂') !== -1, names.join('、'));
  const worship = env.contentSpreadsheet.getSheetByName('崇拜程序');
  assert.strictEqual(JSON.stringify(worship.__data[1]), JSON.stringify(legacyContentTabDefV1('崇拜程序').keys));
  assert.strictEqual(legacyContentTabDefV1('崇拜程序').keys.length, 7);
  assert.strictEqual(env.contentSpreadsheet.getSheetByName('宣召').__data[2][1], '詩篇 100');
});

test('F8. 凍結的舊定義每次回一份新副本（呼叫方改了也不影響下一次）', function () {
  const a = legacyContentTabDefsV1();
  a[0].keys.push('X');
  assert.strictEqual(legacyContentTabDefsV1()[0].keys.indexOf('X'), -1);
});

console.log('');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
