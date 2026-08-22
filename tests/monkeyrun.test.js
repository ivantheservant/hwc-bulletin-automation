#!/usr/bin/env node
/**
 * tests/monkeyrun.test.js
 *
 * 第 3 層（`src/MonkeyRun.gs`）的回歸測試。
 *
 * ⚠️ 同 tests/selftest.test.js 一樣：這一組只驗得到**骨架**——守門會不會
 * 擋、亂數可不可以重覆、報告有沒有印出「走到這裏的完整步驟」。真正的
 * 價值（隨機走出沒有人想過的狀態）只有在真環境按下去才發生。
 *
 * 這一組最重要的兩條：
 *   - 同一個種子走同一條路（沒有它，紅了也重現不到，整層白費）
 *   - 動作清單裡面**沒有**安裝觸發器／改 Config／寫職事表這些動作
 *
 * 執行方式：node tests/monkeyrun.test.js
 * 離開碼：0＝全部通過　1＝有測試失敗
 */

'use strict';

const assert = require('assert');
const { loadAllSrcFilesInOrder } = require('./helpers/loadGas');
const { makeFakeSheet, makeFakeSpreadsheet } = require('./helpers/fakeSpreadsheet');
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
    console.log('    ' + err.message);
  }
}

function deepEq(actual, expected, message) {
  assert.strictEqual(JSON.stringify(actual), JSON.stringify(expected), message);
}

function baseStubs() {
  return {
    Utilities: {
      formatDate: function (date, tz, pattern) {
        const y = date.getFullYear();
        const mo = String(date.getMonth() + 1).padStart(2, '0');
        const d = String(date.getDate()).padStart(2, '0');
        const hh = String(date.getHours()).padStart(2, '0');
        const mi = String(date.getMinutes()).padStart(2, '0');
        const ss = String(date.getSeconds()).padStart(2, '0');
        if (String(pattern).indexOf('HHmmss') !== -1) return `${y}${mo}${d}${hh}${mi}${ss}`;
        if (String(pattern).indexOf('HH') !== -1) return `${y}-${mo}-${d} ${hh}:${mi}`;
        return `${y}-${mo}-${d}`;
      }
    },
    Session: {
      getScriptTimeZone: function () { return 'Pacific/Auckland'; },
      getActiveUser: function () { return { getEmail: function () { return 'tester@example.com'; } }; }
    },
    CacheService: {},
    HtmlService: {}
  };
}

function makeEnv(options) {
  const o = options || {};
  const boot = loadAllSrcFilesInOrder(baseStubs());

  const cfg = {};
  boot.DEFAULTS.forEach(function (d) { cfg[d.key] = d.value; });
  Object.assign(cfg, o.config || {});

  function ownSheet(sheetId, rows) {
    const def = boot.COLUMNS[sheetId];
    return makeFakeSheet(def.headers, def.keys, rows || []);
  }

  const sheets = {};
  Object.keys(boot.SHEETS).forEach(function (id) { sheets[boot.SHEETS[id]] = ownSheet(id, []); });
  sheets.Config = ownSheet('CONFIG', Object.keys(cfg).map(function (k) {
    return { KEY: k, VALUE: cfg[k], NOTE: '', EDITABLE: true };
  }));
  sheets.BulletinWeeks = ownSheet('BULLETIN_WEEKS', o.weekRows || []);
  sheets.MonkeyLog = ownSheet('MONKEY_LOG', o.monkeyLog || []);

  const sandbox = loadAllSrcFilesInOrder(Object.assign({}, baseStubs(), {
    SpreadsheetApp: {
      getActiveSpreadsheet: function () { return makeFakeSpreadsheet(sheets); },
      openById: function () { throw new Error('這一組測試不連職事表'); },
      ProtectionType: { SHEET: 'SHEET' },
      getUi: function () {
        return {
          createMenu: function () {
            const m = {
              addItem: function () { return m; }, addSeparator: function () { return m; },
              addSubMenu: function () { return m; }, addToUi: function () { return m; }
            };
            return m;
          },
          alert: function () { return 'OK'; },
          prompt: function () {
            return { getSelectedButton: function () { return 'CANCEL'; }, getResponseText: function () { return ''; } };
          },
          ButtonSet: { OK: 'OK', OK_CANCEL: 'OK_CANCEL' }, Button: { OK: 'OK', CANCEL: 'CANCEL' }
        };
      }
    }
  }));

  return { sandbox: sandbox, sheets: sheets, boot: boot };
}

// =====================================================================
// 亂數：同一個種子走同一條路
// =====================================================================

test('monkeyRandom_：同一個種子產生同一串數字（沒有它，紅了也重現不到）', function () {
  const env = makeEnv({});
  const a = env.sandbox.monkeyRandom_(12345);
  const b = env.sandbox.monkeyRandom_(12345);

  const seqA = [];
  const seqB = [];
  for (let i = 0; i < 30; i++) {
    seqA.push(a.nextInt(7));
    seqB.push(b.nextInt(7));
  }
  deepEq(seqA, seqB, '同一個種子必須走同一條路');
});

test('monkeyRandom_：不同種子產生不同的串（否則種子形同虛設）', function () {
  const env = makeEnv({});
  const a = env.sandbox.monkeyRandom_(1);
  const b = env.sandbox.monkeyRandom_(999);

  const seqA = [];
  const seqB = [];
  for (let i = 0; i < 30; i++) {
    seqA.push(a.nextInt(7));
    seqB.push(b.nextInt(7));
  }
  assert.notStrictEqual(JSON.stringify(seqA), JSON.stringify(seqB));
});

test('monkeyRandom_：nextInt(n) 一定落在 0 至 n-1 之間', function () {
  const env = makeEnv({});
  const rng = env.sandbox.monkeyRandom_(42);
  for (let i = 0; i < 500; i++) {
    const v = rng.nextInt(5);
    assert.ok(v >= 0 && v <= 4, '越界：' + v);
    assert.strictEqual(v, Math.floor(v), '要是整數：' + v);
  }
});

test('monkeyRandom_：nextInt(1) 永遠回 0，不會除以零或回 NaN', function () {
  const env = makeEnv({});
  const rng = env.sandbox.monkeyRandom_(7);
  for (let i = 0; i < 20; i++) assert.strictEqual(rng.nextInt(1), 0);
  assert.strictEqual(env.sandbox.monkeyRandom_(7).nextInt(0), 0, 'n=0 要當成 1 處理，不可以回 NaN');
});

// =====================================================================
// 動作清單：靠「根本沒有這個選項」，不是靠執行時擋
// =====================================================================

test('動作清單：沒有安裝觸發器／改 Config／寫職事表／碰正式 master 這幾種動作', function () {
  const env = makeEnv({});
  const actions = env.sandbox.monkeyActions_();
  const text = actions.map(function (a) { return a.id + ' ' + a.label; }).join('\n');

  ['觸發器', 'Trigger', 'TRIGGER'].forEach(function (banned) {
    assert.ok(text.indexOf(banned) === -1, '動作清單不可以有觸發器相關的動作：' + text);
  });
  ['設定', 'CONFIG'].forEach(function (banned) {
    assert.ok(text.indexOf(banned) === -1, '動作清單不可以有改 Config 的動作：' + text);
  });
  assert.ok(text.indexOf('職事表') === -1, '動作清單不可以有寫職事表的動作：' + text);
});

test('動作清單：每一個都有 id、label、available、run', function () {
  const env = makeEnv({});
  env.sandbox.monkeyActions_().forEach(function (a) {
    const actionId = a.id;
    assert.ok(String(actionId).length > 0);
    assert.ok(String(a.label).length > 0, actionId + ' 沒有標籤');
    assert.strictEqual(typeof a.available, 'function', actionId + ' 沒有 available()');
    assert.strictEqual(typeof a.run, 'function', actionId + ' 沒有 run()');
  });
});

test('動作清單：動作標籤是書面語繁體中文', function () {
  const env = makeEnv({});
  const labels = env.sandbox.monkeyActions_().map(function (a) { return a.label; }).join('\n');
  assertWrittenChinese(assert, '亂行機動作標籤', labels);
});

test('動作清單：空季度時只有「建立本季空白週報」與不需要週報的動作', function () {
  const env = makeEnv({});
  const actions = env.sandbox.monkeyActions_();
  const emptyState = {
    weekCount: 0, announcementCount: 0, hasContentFolder: false,
    hasContentSheet: false, hasSandboxMaster: false, canRenderDocx: false, hasRecipients: false
  };
  const available = actions.filter(function (a) { return a.available(emptyState); })
    .map(function (a) { return a.id; });

  deepEq(available, ['CREATE_WEEKS'], '空季度、甚麼都未設定時只應該有一個合法動作');
});

test('動作清單：沒有沙盒 master 檔案時，發佈動作不會出現（絕對不碰正式那一個）', function () {
  const env = makeEnv({});
  const state = {
    weekCount: 5, announcementCount: 0, hasContentFolder: false,
    hasContentSheet: false, hasSandboxMaster: false, canRenderDocx: false, hasRecipients: false
  };
  const available = env.sandbox.monkeyActions_()
    .filter(function (a) { return a.available(state); })
    .map(function (a) { return a.id; });

  assert.ok(available.indexOf('PUBLISH') === -1,
    '沒有沙盒 master 就不可以有發佈動作，否則會覆寫正式那一個：' + available.join('、'));
});

test('動作清單：沒有收件人時，寄出動作不會出現', function () {
  const env = makeEnv({});
  const state = {
    weekCount: 5, announcementCount: 0, hasContentFolder: false,
    hasContentSheet: false, hasSandboxMaster: false, canRenderDocx: false, hasRecipients: false
  };
  const available = env.sandbox.monkeyActions_()
    .filter(function (a) { return a.available(state); })
    .map(function (a) { return a.id; });
  assert.ok(available.indexOf('SEND_DRY_RUN') === -1, available.join('、'));
});

// =====================================================================
// 守門
// =====================================================================

test('守門：DRY_RUN=FALSE → 一步都不走', function () {
  const env = makeEnv({ config: { DRY_RUN: 'FALSE' } });
  const summary = env.sandbox.runMonkey_({ steps: 10 });

  assert.strictEqual(summary.ok, false);
  deepEq(summary.steps, []);
  assert.strictEqual(env.sheets.MonkeyLog.getLastRow(), 2, 'MonkeyLog 不應該多任何一行');
});

test('守門：monkeyAssertDryRun_ 在 DRY_RUN 變成 FALSE 時拋錯', function () {
  const env = makeEnv({ config: { DRY_RUN: 'FALSE' } });
  assert.throws(function () { env.sandbox.monkeyAssertDryRun_(); }, /亂行機中止/);
});

test('守門：monkeyAssertDryRun_ 在 DRY_RUN=TRUE 時不拋錯', function () {
  const env = makeEnv({});
  assert.doesNotThrow(function () { env.sandbox.monkeyAssertDryRun_(); });
});

test('守門：沙盒季度撞正只讀季度 → 一步都不走', function () {
  const env = makeEnv({
    config: { SELFTEST_QUARTER_ID: '2027T4', SELFTEST_ROSTER_QUARTER_ID: '2027T4' }
  });
  const summary = env.sandbox.runMonkey_({ steps: 5 });
  assert.strictEqual(summary.ok, false);
  assert.ok(summary.message.indexOf('真實資料會被清走') !== -1, summary.message);
});

// =====================================================================
// 報告
// =====================================================================

function fakeSummary(overrides) {
  return Object.assign({
    ok: true,
    runId: 'MK20281001000000',
    seed: 987654321,
    requestedSteps: 50,
    steps: [
      {
        stepNo: 1, availableIds: ['CREATE_WEEKS'], chosenId: 'CREATE_WEEKS',
        chosenLabel: '建立本季空白週報', result: 'OK', detail: '建立了 13 行',
        invariantStatus: '全部通過（3 條驗證不到）', invariantFailures: [],
        pathSoFar: '建立本季空白週報'
      },
      {
        stepNo: 2, availableIds: ['EDIT_FIELDS', 'IMPORT_CONTENT'], chosenId: 'IMPORT_CONTENT',
        chosenLabel: '從內容表匯入', result: 'OK', detail: '新增 4',
        invariantStatus: '不成立：I08', pathSoFar: '建立本季空白週報 → 從內容表匯入',
        invariantFailures: [{
          id: 'I08', expected: '0 項改動', actual: '4 項改動',
          evidence: '再匯入應為 0 改動，實際 4 行'
        }]
      }
    ],
    failedStep: null,
    stoppedForTime: false
  }, overrides || {});
}

test('報告：亂數種子印在開頭（沒有它就重現不到）', function () {
  const env = makeEnv({});
  const lines = env.sandbox.buildMonkeyReportLines_(fakeSummary());

  assert.ok(lines.slice(0, 3).join('\n').indexOf('987654321') !== -1,
    '種子必須印在報告開頭：' + lines.slice(0, 3).join(' | '));
  assert.ok(lines.slice(0, 3).join('\n').indexOf('同一個種子重跑') !== -1,
    '要講明種子的用途');
});

test('報告：紅了的話，「走到這裏的完整步驟」一定要印出來', function () {
  const env = makeEnv({});
  const summary = fakeSummary();
  summary.failedStep = summary.steps[1];

  const text = env.sandbox.buildMonkeyReportLines_(summary).join('\n');
  assert.ok(text.indexOf('走到這裏的完整步驟') !== -1, text);
  assert.ok(text.indexOf('建立本季空白週報 → 從內容表匯入') !== -1,
    '沒有完整步驟，紅了也重現不到：' + text);
  assert.ok(text.indexOf('I08') !== -1 && text.indexOf('4 項改動') !== -1,
    '要連不變量的預期與實際一齊印：' + text);
});

test('報告：逐步記錄印出「合法動作」與「揀了甚麼」', function () {
  const env = makeEnv({});
  const text = env.sandbox.buildMonkeyReportLines_(fakeSummary()).join('\n');

  assert.ok(text.indexOf('第 1 步') !== -1, text);
  assert.ok(text.indexOf('CREATE_WEEKS') !== -1, text);
  assert.ok(text.indexOf('揀了：建立本季空白週報') !== -1, text);
  assert.ok(text.indexOf('不變量：') !== -1, text);
});

test('報告：停低了要講明，而且指路去〔繼續亂行〕', function () {
  const env = makeEnv({});
  const text = env.sandbox.buildMonkeyReportLines_(fakeSummary({ stoppedForTime: true })).join('\n');
  assert.ok(text.indexOf('執行時間到') !== -1, text);
  assert.ok(text.indexOf('繼續亂行') !== -1, text);
});

test('報告：全部走完而且沒有紅 → 明確講「每一步之後不變量都成立」', function () {
  const env = makeEnv({});
  const text = env.sandbox.buildMonkeyReportLines_(fakeSummary({ requestedSteps: 2 })).join('\n');
  assert.ok(text.indexOf('每一步之後不變量都成立') !== -1, text);
});

test('報告：守門擋住時只講守門訊息，不假裝走過', function () {
  const env = makeEnv({});
  const lines = env.sandbox.buildMonkeyReportLines_({ ok: false, message: '守門訊息' });
  assert.strictEqual(lines.length, 1);
  assert.ok(lines[0].indexOf('守門訊息') !== -1);
});

test('對話框摘要：紅了要連完整步驟一齊講', function () {
  const env = makeEnv({});
  const summary = fakeSummary();
  summary.failedStep = summary.steps[1];

  const text = env.sandbox.buildMonkeyShortSummary_(summary);
  assert.ok(text.indexOf('走到這裏的完整步驟') !== -1, text);
  assert.ok(text.indexOf('建立本季空白週報 → 從內容表匯入') !== -1, text);
  assert.ok(text.indexOf('MonkeyLog') !== -1, '要指路去完整記錄：' + text);
});

test('報告與摘要的文字是書面語繁體中文', function () {
  const env = makeEnv({});
  const summary = fakeSummary();
  summary.failedStep = summary.steps[1];

  assertWrittenChinese(assert, '亂行報告', env.sandbox.buildMonkeyReportLines_(summary).join('\n'));
  assertWrittenChinese(assert, '亂行摘要', env.sandbox.buildMonkeyShortSummary_(summary));
  assertWrittenChinese(assert, '亂行報告（停低）',
    env.sandbox.buildMonkeyReportLines_(fakeSummary({ stoppedForTime: true })).join('\n'));
});

// =====================================================================
// 狀態判斷
// =====================================================================

test('monkeyCurrentState_：只數沙盒季度那幾行，不會把真實季度算進去', function () {
  const env = makeEnv({
    weekRows: [
      { SERVICE_DATE: '2028-10-01', QUARTER_ID: '2028T4', WEEK_OF_MONTH: 1, STATUS: 'DRAFT' },
      { SERVICE_DATE: '2027-11-07', QUARTER_ID: '2027T4', WEEK_OF_MONTH: 1, STATUS: 'DRAFT' },
      { SERVICE_DATE: '2028-10-08', QUARTER_ID: '2028T4', WEEK_OF_MONTH: 2, STATUS: 'DRAFT' }
    ]
  });
  const state = env.sandbox.monkeyCurrentState_(env.sandbox.selfTestConfig_());
  assert.strictEqual(state.weekCount, 2, '只應該數 2028T4 那兩行');
});

test('monkeyCurrentState_：沒有設定沙盒 master／內容表資料夾時，對應旗標是 false', function () {
  const env = makeEnv({});
  const state = env.sandbox.monkeyCurrentState_(env.sandbox.selfTestConfig_());
  assert.strictEqual(state.hasSandboxMaster, false);
  assert.strictEqual(state.hasContentFolder, false);
});

test('monkeyLatestSeed_：沒有記錄回空字串，有記錄回最後一個種子', function () {
  const empty = makeEnv({});
  assert.strictEqual(empty.sandbox.monkeyLatestSeed_(), '');

  const withLog = makeEnv({
    monkeyLog: [
      { RUN_ID: 'MK1', SEED: '111', STEP_NO: 1, AVAILABLE_ACTIONS: 'a', CHOSEN_ACTION: 'a', RESULT: 'OK', INVARIANT_STATUS: 'ok', PATH_SO_FAR: 'a', TIMESTAMP: '2028-10-01' },
      { RUN_ID: 'MK2', SEED: '222', STEP_NO: 1, AVAILABLE_ACTIONS: 'a', CHOSEN_ACTION: 'a', RESULT: 'OK', INVARIANT_STATUS: 'ok', PATH_SO_FAR: 'a', TIMESTAMP: '2028-10-02' }
    ]
  });
  assert.strictEqual(withLog.sandbox.monkeyLatestSeed_(), '222');
});

// =====================================================================

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
