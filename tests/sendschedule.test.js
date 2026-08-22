#!/usr/bin/env node
/**
 * tests/sendschedule.test.js
 *
 * 第一輪自測修正 Part 4：「下一個要寄的主日」只有一個定義。
 *
 * 第一輪自測在 2026-08-22（星期六）跑，系統選中 **2026-08-28（星期五）**。
 * 正確答案是 2026-08-23（星期日）。
 *
 * 原因：舊算法是「今日 ＋ Config `SEND_TARGET_OFFSET_DAYS`（預設 6）天」，
 * 那條算式只在**觸發日是星期一**時才落在星期日。而且那條算式一共有三份
 * 拷貝（`Mailer.gs`、`Trigger.gs`、`SelfTest.gs` 的 S18），三份同時錯，
 * 「對答案」的一方與「算答案」的一方得出同一個錯的結果。
 *
 * ⚠️ 所以這個檔案的預期值全部**寫死**，不是由 sandbox 的函式算出來的。
 *    用被驗函式去算期望值，等於沒有驗（事故二十二）。
 *
 * 執行方式：node tests/sendschedule.test.js
 * 離開碼：0＝全部通過　1＝有測試失敗
 */

'use strict';

const assert = require('assert');
const { loadAllSrcFilesInOrder } = require('./helpers/loadGas');
const { makeFakeSheet, makeFakeSpreadsheet } = require('./helpers/fakeSpreadsheet');

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

const GAS_STUBS = {
  Logger: { log: function () {} },
  Utilities: {
    formatDate: function (d, tz, fmt) {
      const y = d.getFullYear();
      const mo = String(d.getMonth() + 1).padStart(2, '0');
      const da = String(d.getDate()).padStart(2, '0');
      return fmt === 'yyyy-MM-dd' ? (y + '-' + mo + '-' + da) : (y + '-' + mo + '-' + da + ' 00:00');
    },
    sleep: function () {}
  },
  Session: {
    getActiveUser: function () { return { getEmail: function () { return 'clerk@example.com'; } }; },
    getEffectiveUser: function () { return { getEmail: function () { return 'clerk@example.com'; } }; },
    getScriptTimeZone: function () { return 'Pacific/Auckland'; }
  }
};

function makeEnv(options) {
  const o = options || {};
  const boot = loadAllSrcFilesInOrder(GAS_STUBS);
  const sheets = {};
  Object.keys(boot.SHEETS).forEach(function (id) {
    const def = boot.COLUMNS[id];
    sheets[boot.SHEETS[id]] = makeFakeSheet(def.headers, def.keys, []);
  });
  if (o.sendLog) {
    const def = boot.COLUMNS.SEND_LOG;
    sheets[boot.SHEETS.SEND_LOG] = makeFakeSheet(def.headers, def.keys, o.sendLog);
  }
  const FakeApp = { getActiveSpreadsheet: function () { return makeFakeSpreadsheet(sheets); } };
  return {
    sheets: sheets,
    sandbox: loadAllSrcFilesInOrder(Object.assign({}, GAS_STUBS, { SpreadsheetApp: FakeApp }))
  };
}

function nextSunday(env, todayIso, sentIsoList) {
  return env.sandbox.computeNextSendSundayIso_(todayIso, sentIsoList || []);
}

// =====================================================================
// 1. 七個星期幾——第一輪那個 bug 的正面迴歸測試
// =====================================================================

// ⚠️ 預期值寫死。舊算法（今日 + 6）在其中六個星期幾都會答錯，只有星期一
//    是對的——那正是為什麼一直沒有人發現。
test('1a. 2027-10-04（一）到 2027-10-10（日）逐日試，答案全部是 2027-10-10', function () {
  const env = makeEnv({});
  const cases = [
    ['2027-10-04', '2027-10-10'], // 星期一
    ['2027-10-05', '2027-10-10'], // 星期二
    ['2027-10-06', '2027-10-10'], // 星期三
    ['2027-10-07', '2027-10-10'], // 星期四
    ['2027-10-08', '2027-10-10'], // 星期五
    ['2027-10-09', '2027-10-10'], // 星期六
    ['2027-10-10', '2027-10-10']  // 星期日：**今日就是主日，取今日**
  ];
  const bad = [];
  cases.forEach(function (pair) {
    const got = nextSunday(env, pair[0]).isoDate;
    if (got !== pair[1]) bad.push(pair[0] + ' → 預期 ' + pair[1] + '，實際 ' + got);
  });
  assert.strictEqual(bad.length, 0, bad.join('\n  '));
});

// ⚠️ 這一條直接重現第一輪自測那一日的情況，用真實日期。
test('1b. 第一輪自測那一日：2026-08-22（六）→ 2026-08-23，不是 2026-08-28', function () {
  const env = makeEnv({});
  const result = nextSunday(env, '2026-08-22');
  assert.strictEqual(result.isoDate, '2026-08-23');
  assert.notStrictEqual(result.isoDate, '2026-08-28', '2026-08-28 是星期五，舊算法的錯誤答案');
});

test('1c. 今日就是星期日 → 取今日，不是下星期（含今日）', function () {
  const env = makeEnv({});
  assert.strictEqual(nextSunday(env, '2027-10-03').isoDate, '2027-10-03');
});

// =====================================================================
// 2. 跨月、跨年
// =====================================================================

test('2a. 跨月：2027-10-26（二）→ 2027-10-31；2027-11-01（一）→ 2027-11-07', function () {
  const env = makeEnv({});
  assert.strictEqual(nextSunday(env, '2027-10-26').isoDate, '2027-10-31');
  assert.strictEqual(nextSunday(env, '2027-11-01').isoDate, '2027-11-07');
});

test('2b. 跨月而且主日落在下個月：2027-11-29（一）→ 2027-12-05', function () {
  const env = makeEnv({});
  assert.strictEqual(nextSunday(env, '2027-11-29').isoDate, '2027-12-05');
});

test('2c. 跨年：2027-12-27（一）→ 2028-01-02', function () {
  const env = makeEnv({});
  assert.strictEqual(nextSunday(env, '2027-12-27').isoDate, '2028-01-02');
});

test('2d. 跨年而且今日是 12 月 31 日（五）→ 2028-01-02', function () {
  const env = makeEnv({});
  assert.strictEqual(nextSunday(env, '2027-12-31').isoDate, '2028-01-02');
});

test('2e. 閏年二月：2028-02-28（一）→ 2028-03-05（2028 年 2 月有 29 日）', function () {
  const env = makeEnv({});
  assert.strictEqual(nextSunday(env, '2028-02-28').isoDate, '2028-03-05');
});

// =====================================================================
// 3. 已經寄過就順延
// =====================================================================

test('3a. 下一個主日已經寄過 → 取再下一個', function () {
  const env = makeEnv({});
  const result = nextSunday(env, '2027-10-04', ['2027-10-10']);
  assert.strictEqual(result.isoDate, '2027-10-17');
  assert.strictEqual(JSON.stringify(result.skipped), JSON.stringify(['2027-10-10']));
});

test('3b. 連續兩個主日都寄過 → 取第三個，而且跳過哪幾期要講得出', function () {
  const env = makeEnv({});
  const result = nextSunday(env, '2027-10-04', ['2027-10-10', '2027-10-17']);
  assert.strictEqual(result.isoDate, '2027-10-24');
  assert.strictEqual(JSON.stringify(result.skipped),
    JSON.stringify(['2027-10-10', '2027-10-17']));
});

test('3c. 已寄清單裡面有不相干的日期 → 完全不影響', function () {
  const env = makeEnv({});
  assert.strictEqual(nextSunday(env, '2027-10-04', ['2027-09-05', '2027-11-21']).isoDate,
    '2027-10-10');
});

test('3d. 順延會跨月：2027-10-25（一），10-31 已寄 → 2027-11-07', function () {
  const env = makeEnv({});
  assert.strictEqual(nextSunday(env, '2027-10-25', ['2027-10-31']).isoDate, '2027-11-07');
});

// ⚠️ 防無限迴圈。全部都寄過的話要**明確講出算不到**，不可以回一個
//    看起來合理的日期，也不可以卡死。
test('3e. 連續很多期都寄過 → ok:false 並講明原因，不會無限迴圈', function () {
  const env = makeEnv({});
  const sent = [];
  let iso = '2027-10-10';
  for (let i = 0; i < 10; i++) {
    sent.push(iso);
    iso = env.sandbox.addDaysToIsoDate_(iso, 7);
  }
  const result = env.sandbox.computeNextSendSundayIso_('2027-10-04', sent, 5);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.isoDate, '');
  assert.ok(result.reason.indexOf('已經寄過') !== -1, result.reason);
});

test('3f. 今日不是合法日期 → ok:false，不會拋錯', function () {
  const env = makeEnv({});
  const result = nextSunday(env, '唔係日期');
  assert.strictEqual(result.ok, false);
  assert.ok(result.reason.length > 0);
});

// =====================================================================
// 4. 「已寄過」的判斷準則
// =====================================================================

// ⚠️ DRY_RUN 不算已寄。試寄的用途正是「寄之前先看一次」，如果試寄會令
//    系統跳過那一期，就變成試一次漏一期，而且完全沒有提示。
test('4a. readSentBulletinSundays_：DRY_RUN 的紀錄不算已寄過', function () {
  const env = makeEnv({
    sendLog: [
      { TIMESTAMP: '2027-10-04', SERVICE_DATE: '2027-10-10', RECIPIENT_EMAIL: 'a@x.com',
        SUBJECT: '週報', STATUS: 'DRY_RUN', DRY_RUN: true }
    ]
  });
  assert.strictEqual(JSON.stringify(env.sandbox.readSentBulletinSundays_()), JSON.stringify([]));
});

// ⚠️ FAILED 也不算。寄失敗代表**沒有寄到**，下一次要再試同一期。
test('4b. readSentBulletinSundays_：FAILED 的紀錄不算已寄過', function () {
  const env = makeEnv({
    sendLog: [
      { TIMESTAMP: '2027-10-04', SERVICE_DATE: '2027-10-10', RECIPIENT_EMAIL: 'a@x.com',
        SUBJECT: '週報', STATUS: 'FAILED', DRY_RUN: false, ERROR: '寄唔到' }
    ]
  });
  assert.strictEqual(JSON.stringify(env.sandbox.readSentBulletinSundays_()), JSON.stringify([]));
});

test('4c. readSentBulletinSundays_：SENT 而且不是 DRY_RUN 才算', function () {
  const env = makeEnv({
    sendLog: [
      { TIMESTAMP: '2027-10-04', SERVICE_DATE: '2027-10-10', RECIPIENT_EMAIL: 'a@x.com',
        SUBJECT: '週報', STATUS: 'SENT', DRY_RUN: false },
      { TIMESTAMP: '2027-10-04', SERVICE_DATE: '2027-10-10', RECIPIENT_EMAIL: 'b@x.com',
        SUBJECT: '週報', STATUS: 'SENT', DRY_RUN: false }
    ]
  });
  const sent = env.sandbox.readSentBulletinSundays_();
  assert.strictEqual(sent.length, 2, '一期多個收件人會有多筆，重複不需要理會');
  assert.strictEqual(sent[0], '2027-10-10');
});

test('4d. 真正入口 resolveNextSendSundayIso_：真的寄過那一期會被跳過', function () {
  const env = makeEnv({
    sendLog: [
      { TIMESTAMP: '2027-10-04', SERVICE_DATE: '2027-10-10', RECIPIENT_EMAIL: 'a@x.com',
        SUBJECT: '週報', STATUS: 'SENT', DRY_RUN: false }
    ]
  });
  const result = env.sandbox.resolveNextSendSundayIso_({ todayIso: '2027-10-04' });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.isoDate, '2027-10-17');
  assert.strictEqual(result.todayIso, '2027-10-04');
});

test('4e. 真正入口：只試寄過（DRY_RUN）那一期不會被跳過', function () {
  const env = makeEnv({
    sendLog: [
      { TIMESTAMP: '2027-10-04', SERVICE_DATE: '2027-10-10', RECIPIENT_EMAIL: 'a@x.com',
        SUBJECT: '週報', STATUS: 'DRY_RUN', DRY_RUN: true }
    ]
  });
  const result = env.sandbox.resolveNextSendSundayIso_({ todayIso: '2027-10-04' });
  assert.strictEqual(result.isoDate, '2027-10-10');
});

// =====================================================================
// 5. 只有一個定義：每一個呼叫方都用同一支
// =====================================================================

// ⚠️ 這一條守的是事故三十的根因：算式有三份拷貝。日後有人再寫一份
//    「今日 ＋ N 天」出來，這條測試不會紅——所以下面 5b 用 grep 守。
test('5a. guessNextBulletinSendIso_ 與 resolveNextSendSundayIso_ 答案一致', function () {
  const env = makeEnv({});
  const direct = env.sandbox.resolveNextSendSundayIso_();
  const guessed = env.sandbox.guessNextBulletinSendIso_();
  assert.strictEqual(guessed, direct.ok ? direct.isoDate : '');
  if (guessed) {
    assert.strictEqual(env.sandbox.isIsoDateSunday_(guessed), true, '猜出來的一定是星期日');
  }
});

test('5b. 全 repo 不可以再有人自己用 SEND_TARGET_OFFSET_DAYS 算目標日', function () {
  const fs = require('fs');
  const path = require('path');
  const srcDir = path.join(__dirname, '..', 'src');
  const offenders = [];
  fs.readdirSync(srcDir).filter(function (name) { return /\.gs$/.test(name); })
    .forEach(function (name) {
      const text = fs.readFileSync(path.join(srcDir, name), 'utf8');
      text.split('\n').forEach(function (line, i) {
        // 註解（說明為什麼廢棄）不算，只抓真的取值來用的。
        if (/^\s*(\/\/|\*)/.test(line)) return;
        if (line.indexOf('SEND_TARGET_OFFSET_DAYS') === -1) return;
        // Bootstrap.gs 的廢棄鍵清單是它最後一次合法出現的地方。
        if (name === 'Bootstrap.gs') return;
        offenders.push(name + ':' + (i + 1) + '　' + line.trim());
      });
    });
  assert.strictEqual(offenders.length, 0,
    'SEND_TARGET_OFFSET_DAYS 已廢棄，不可以再有程式碼讀它：\n  ' + offenders.join('\n  '));
});

test('5c. describeNextSendSunday_：講得出今日、選中哪一日、跳過了哪幾期', function () {
  const env = makeEnv({});
  const text = env.sandbox.describeNextSendSunday_({
    ok: true, todayIso: '2027-10-04', isoDate: '2027-10-17',
    skipped: ['2027-10-10'], reason: ''
  });
  assert.ok(text.indexOf('2027-10-04') !== -1, text);
  assert.ok(text.indexOf('2027-10-17') !== -1, text);
  assert.ok(text.indexOf('2027-10-10') !== -1, '跳過了哪幾期一定要講得出：' + text);
});

test('5d. describeNextSendSunday_：算不到時講明原因，不會回一句好像成功的話', function () {
  const env = makeEnv({});
  const text = env.sandbox.describeNextSendSunday_({
    ok: false, todayIso: '', isoDate: '', skipped: [], reason: '測試用原因'
  });
  assert.ok(text.indexOf('算不出') !== -1, text);
  assert.ok(text.indexOf('測試用原因') !== -1, text);
});

console.log('');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
