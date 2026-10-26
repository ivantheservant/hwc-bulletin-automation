#!/usr/bin/env node
/**
 * tests/selftestv3.test.js
 *
 * v3（2026-10-26 Ivan 測試結果 A 第 10 項）：序樂、宣召、詩歌、讀經經文、證道講題、詩班改為只在內容表輸入，
 * 填寫介面送了會整次被拒（CONTENT_SHEET_READONLY）。自測機與亂行機以前經 `saveWeekFromWebApp_()` 寫講題，
 * v3 之後一跑就紅。這裏經真正的情境函式（`selfTestS08_()` 等）與亂行機的真動作跑一次，守住它們只送
 * 介面仍然可以編輯的欄位。
 *
 * 執行方式：node tests/selftestv3.test.js
 * 離開碼：0＝全部通過　1＝有測試失敗
 */

'use strict';

const assert = require('assert');
const { makeFillEnv, QUARTER_ID, SERVICE_DATES } = require('./helpers/fillEnv');

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
    console.log('    ' + (err && err.stack ? err.stack.split('\n').slice(0, 6).join('\n    ') : err));
  }
}

function plain(v) { return JSON.parse(JSON.stringify(v)); }

function makeEnv() {
  return makeFillEnv({
    withGrid: false,
    weekRows: SERVICE_DATES.map(function (iso, i) {
      return { SERVICE_DATE: iso, QUARTER_ID: QUARTER_ID, WEEK_OF_MONTH: i + 1, STATUS: 'DRAFT', LAST_SAVED_AT: '2026-10-01' };
    }),
    config: { PRELUDE_DEFAULT: '預設序樂' }
  });
}

function ctxOf() {
  return { config: { quarterId: QUARTER_ID }, runId: 'V3', stepNo: 1 };
}

console.log('\nv3：自測機與亂行機只送介面可以編輯的欄位');

test('S08（真情境函式）：經真正的儲存入口寫入成功（v3 之前寫講題，一跑就被拒）', function () {
  const env = makeEnv();
  const outcome = plain(env.sandbox.selfTestS08_(ctxOf()));
  assert.strictEqual(outcome.ok, true, JSON.stringify(outcome));
  assert.ok(outcome.actual.indexOf('自測大標題 V3') !== -1, outcome.actual);
});

test('S09（真情境函式）：四種唯讀送法全部被拒，包括 v3 起只在內容表輸入的講題；一格都沒有寫', function () {
  const env = makeEnv();
  const outcome = plain(env.sandbox.selfTestS09_(ctxOf()));
  assert.strictEqual(outcome.ok, true, JSON.stringify(outcome));
  assert.ok(JSON.stringify(outcome).indexOf('證道講題') !== -1, '要包括講題那一個送法：' + JSON.stringify(outcome));
});

test('S21（真情境函式）：人手填的值補抓之後原封不動', function () {
  const env = makeEnv();
  const outcome = plain(env.sandbox.selfTestS21_(ctxOf()));
  assert.strictEqual(outcome.ok, true, JSON.stringify(outcome));
});

test('S36（真情境函式）：填了一格的主日被列為「未發佈但有內容」', function () {
  const env = makeEnv();
  const outcome = plain(env.sandbox.selfTestS36_(ctxOf()));
  assert.strictEqual(outcome.ok, true, JSON.stringify(outcome));
});

test('亂行機「經填寫介面改幾格」（真動作）：改最多格數也不會被拒；送的每一格都是介面可以編輯的欄位', function () {
  const env = makeEnv();
  const sb = env.sandbox;
  const action = sb.monkeyActions_().filter(function (a) { return a.id === 'EDIT_FIELDS'; })[0];
  const result = action.run({
    config: { quarterId: QUARTER_ID }, runId: 'V3', stepNo: 1,
    // 揀第一個主日，改最多格數。
    random: { nextInt: (function () { let n = 0; return function (k) { n++; return n === 1 ? 0 : k - 1; }; })() }
  });
  assert.ok(JSON.stringify(result).indexOf('改了') !== -1, JSON.stringify(result));
  const editable = plain(sb.webAppEditableWeekFieldKeys_());
  const touched = sb.readSheet('AuditLog').filter(function (r) { return r.SHEET_NAME === 'BulletinWeeks'; })
    .map(function (r) { return r.FIELD; });
  assert.ok(touched.length >= 2, '前提：改了幾格：' + touched.join('、'));
  touched.forEach(function (key) { assert.ok(editable.indexOf(key) !== -1, key + ' 不是介面可以編輯的欄位'); });
});

console.log('\n通過 ' + pass + ' 項，失敗 ' + fail + ' 項。');
process.exit(fail === 0 ? 0 : 1);
