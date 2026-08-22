#!/usr/bin/env node
/**
 * tests/selftest.test.js
 *
 * 第 2 層（`src/SelfTest.gs`）的回歸測試。
 *
 * ⚠️ **這一組測試不可能代替自測機本身。** 自測機存在的理由正正是
 * 「Node 測試用人手砌的狀態，抓不到真環境的問題」——用 Node 測試去驗
 * 自測機，最多只能驗到它的**骨架**對不對：
 *
 *   - 沙盒守門會不會真的擋（DRY_RUN=FALSE、季度撞正真資料）
 *   - 情境清單完不完整、有沒有漏了實作
 *   - 報告會不會把「停低了」講出來
 *   - 「略過」有沒有被當成「通過」
 *
 * 真正的價值（由真實入口造狀態）只有在 Apps Script 上按下去才發生。
 * 這個限制寫在 docs/待確認事項.md，不當成已經驗過。
 *
 * 執行方式：node tests/selftest.test.js
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

/** 造一個只夠驗骨架的環境（沒有 Drive、沒有職事表資料）。 */
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
  sheets.Announcements = ownSheet('ANNOUNCEMENTS', o.announcements || []);
  sheets.SelfTestState = ownSheet('SELF_TEST_STATE', o.selfTestState || []);
  sheets.SelfTestReport = ownSheet('SELF_TEST_REPORT', o.selfTestReport || []);

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
          ButtonSet: { OK: 'OK', YES_NO: 'YES_NO' }, Button: { OK: 'OK', YES: 'YES', NO: 'NO' }
        };
      }
    }
  }));

  return { sandbox: sandbox, sheets: sheets, boot: boot };
}

// =====================================================================
// 沙盒守門——這一組是整個自測機唯一的安全邊界
// =====================================================================

test('守門：DRY_RUN=FALSE → 拒絕開跑，訊息講明後果', function () {
  const env = makeEnv({ config: { DRY_RUN: 'FALSE' } });
  const guard = env.sandbox.assertSelfTestSandbox_(env.sandbox.selfTestConfig_());

  assert.strictEqual(guard.ok, false);
  assert.ok(guard.message.indexOf('不會在真實寄信模式下執行') !== -1, guard.message);
  assert.ok(guard.message.indexOf('收不回來') !== -1, '要講明後果：' + guard.message);
});

test('守門：DRY_RUN=FALSE → runSelfTest_() 一個情境都不跑', function () {
  // ⚠️ 只回 ok:false 不夠——要確認它真的沒有跑任何情境。
  const env = makeEnv({ config: { DRY_RUN: 'FALSE' } });
  const summary = env.sandbox.runSelfTest_({});

  assert.strictEqual(summary.ok, false);
  deepEq(summary.results, []);
  assert.strictEqual(summary.passCount, 0);
  assert.strictEqual(env.sheets.SelfTestReport.getLastRow(), 2, 'SelfTestReport 不應該多任何一行');
});

test('守門：沙盒季度 === 只讀的職事表季度 → 拒絕（否則會清走真實資料）', function () {
  const env = makeEnv({
    config: { SELFTEST_QUARTER_ID: '2027T4', SELFTEST_ROSTER_QUARTER_ID: '2027T4' }
  });
  const guard = env.sandbox.assertSelfTestSandbox_(env.sandbox.selfTestConfig_());

  assert.strictEqual(guard.ok, false);
  assert.ok(guard.message.indexOf('真實資料會被清走') !== -1, guard.message);
});

test('守門：沙盒季度格式不正確 → 拒絕', function () {
  const env = makeEnv({ config: { SELFTEST_QUARTER_ID: '亂寫' } });
  const guard = env.sandbox.assertSelfTestSandbox_(env.sandbox.selfTestConfig_());
  assert.strictEqual(guard.ok, false);
  assert.ok(guard.message.indexOf('格式不正確') !== -1, guard.message);
});

test('守門：正常設定（DRY_RUN=TRUE、兩季不同）→ 放行', function () {
  const env = makeEnv({});
  const guard = env.sandbox.assertSelfTestSandbox_(env.sandbox.selfTestConfig_());
  assert.strictEqual(guard.ok, true, guard.message);
});

test('守門：預設沙盒季度是 2028T4、只讀季度是 2027T4（兩者必須不同）', function () {
  const env = makeEnv({});
  const config = env.sandbox.selfTestConfig_();
  assert.strictEqual(config.quarterId, '2028T4');
  assert.strictEqual(config.rosterQuarterId, '2027T4');
  assert.notStrictEqual(config.quarterId, config.rosterQuarterId);
});

test('寫入守門：assertSelfTestWritableQuarter_ 擋得住非沙盒季度', function () {
  const env = makeEnv({});
  const config = env.sandbox.selfTestConfig_();

  assert.doesNotThrow(function () {
    env.sandbox.assertSelfTestWritableQuarter_('2028T4', config);
  });
  assert.throws(function () {
    env.sandbox.assertSelfTestWritableQuarter_('2027T4', config);
  }, /只准寫沙盒季度/);
});

test('寫入守門：assertSelfTestWritableDate_ 擋得住非沙盒主日', function () {
  const env = makeEnv({});
  const config = env.sandbox.selfTestConfig_();
  const sandboxDates = env.sandbox.selfTestSandboxDates_(config);

  assert.doesNotThrow(function () {
    env.sandbox.assertSelfTestWritableDate_(sandboxDates[0], config);
  });
  assert.throws(function () {
    env.sandbox.assertSelfTestWritableDate_('2027-11-07', config);
  }, /只准寫沙盒季度/);
});

// =====================================================================
// 沙盒主日清單
// =====================================================================

test('selfTestCalendarSundays_：2028T4 是 10–12 月全部星期日', function () {
  const env = makeEnv({});
  const dates = env.sandbox.selfTestCalendarSundays_('2028T4');

  assert.ok(dates.length >= 12 && dates.length <= 14, '一季應該有 12–14 個星期日，實際 ' + dates.length);
  assert.ok(dates[0].indexOf('2028-10-') === 0, dates[0]);
  assert.ok(dates[dates.length - 1].indexOf('2028-12-') === 0, dates[dates.length - 1]);

  // 每一個都要真的是星期日，而且相隔剛好 7 天。
  dates.forEach(function (iso) {
    const [y, m, d] = iso.split('-').map(Number);
    assert.strictEqual(new Date(y, m - 1, d).getDay(), 0, iso + ' 不是星期日');
  });
});

test('selfTestCalendarSundays_：T1 是 1–3 月，季度格式不對回空陣列', function () {
  const env = makeEnv({});
  assert.ok(env.sandbox.selfTestCalendarSundays_('2028T1')[0].indexOf('2028-01-') === 0);
  deepEq(env.sandbox.selfTestCalendarSundays_('亂寫'), []);
  deepEq(env.sandbox.selfTestCalendarSundays_('2028T9'), []);
});

test('selfTestSandboxDates_：職事表沒有這一季 → 退回曆法推算（不是回空陣列）', function () {
  const env = makeEnv({});
  const dates = env.sandbox.selfTestSandboxDates_(env.sandbox.selfTestConfig_());
  assert.ok(dates.length > 0, '職事表沒有資料時要退回曆法推算，否則後面全部情境都跑不到');
  assert.ok(dates[0].indexOf('2028-') === 0, dates[0]);
});

// =====================================================================
// 情境清單
// =====================================================================

test('情境清單：S01–S18 十八個，編號不重複、每個都有實作', function () {
  const env = makeEnv({});
  const scenarios = env.sandbox.selfTestScenarios_();

  assert.strictEqual(scenarios.length, 18);
  const ids = scenarios.map(function (s) { return s.id; });
  deepEq(ids, ['S01', 'S02', 'S03', 'S04', 'S05', 'S06', 'S07', 'S08', 'S09',
    'S10', 'S11', 'S12', 'S13', 'S14', 'S15', 'S16', 'S17', 'S18']);

  scenarios.forEach(function (s) {
    var scenarioId = s.id;
    var scenarioName = s.name;
    assert.strictEqual(typeof s.run, 'function', scenarioId + ' 沒有實作');
    assert.ok(String(scenarioName).length > 0, scenarioId + ' 沒有名稱');
  });
});

test('情境名稱全部是書面語繁體中文', function () {
  const env = makeEnv({});
  const names = env.sandbox.selfTestScenarios_().map(function (s) { return s.id + ' ' + s.name; });
  assertWrittenChinese(assert, '情境名稱', names.join('\n'));
});

// =====================================================================
// 結果與報告
// =====================================================================

test('selfTestOutcome_：三個狀態（通過／失敗／略過），略過用 null 不是 false', function () {
  const env = makeEnv({});
  assert.strictEqual(env.sandbox.selfTestOutcome_(true, 'a', 'a', 'e').ok, true);
  assert.strictEqual(env.sandbox.selfTestOutcome_(false, 'a', 'b', 'e').ok, false);
  assert.strictEqual(env.sandbox.selfTestOutcome_(null, 'a', '', 'e').ok, null);
  assert.strictEqual(env.sandbox.selfTestOutcome_(undefined, 'a', '', 'e').ok, null);
});

function fakeSummary(overrides) {
  return Object.assign({
    ok: true,
    runId: 'ST20281001000000',
    message: '',
    results: [
      { id: 'S01', name: '空季度', result: 'PASS', expected: '4 行', actual: '4 行', evidence: 'x', elapsedMs: 12 },
      {
        id: 'S16', name: '寄出（DRY_RUN）', result: 'FAIL',
        expected: 'preview 人數 === SendLog 封數', actual: 'preview 3，SendLog 9',
        evidence: 'apiPreviewSend 回傳 3；SendLog 新增 9 行', elapsedMs: 40
      },
      {
        id: 'S13', name: '發佈', result: 'SKIPPED',
        expected: '已設定沙盒 master 發佈檔案', actual: '尚未設定',
        evidence: '略過的原因', elapsedMs: 1
      }
    ],
    passCount: 1, failCount: 1, skipCount: 1,
    pendingIds: ['S17', 'S18'], stoppedForTime: false, totalScenarios: 18
  }, overrides || {});
}

test('報告：紅色的一定連預期／實際／證據三樣一齊印', function () {
  const env = makeEnv({});
  const text = env.sandbox.buildSelfTestReportLines_(fakeSummary()).join('\n');

  assert.ok(text.indexOf('🔴 S16') !== -1, text);
  assert.ok(text.indexOf('預期：preview 人數 === SendLog 封數') !== -1, text);
  assert.ok(text.indexOf('實際：preview 3，SendLog 9') !== -1, text);
  assert.ok(text.indexOf('證據：') !== -1, text);
});

test('報告：「略過」明確標示，而且講明「略過」不等於「通過」', function () {
  const env = makeEnv({});
  const text = env.sandbox.buildSelfTestReportLines_(fakeSummary()).join('\n');

  assert.ok(text.indexOf('⚪ S13') !== -1, text);
  assert.ok(text.indexOf('「略過」不等於「通過」') !== -1,
    '略過被當成通過，正是這一輪要根治的假綠燈：' + text);
});

test('報告：停低了一定要講「跑到哪裏、還有幾多個未跑」', function () {
  const env = makeEnv({});
  const text = env.sandbox.buildSelfTestReportLines_(fakeSummary({ stoppedForTime: true })).join('\n');

  assert.ok(text.indexOf('執行時間到') !== -1, text);
  assert.ok(text.indexOf('還有 2 個未跑') !== -1, text);
  assert.ok(text.indexOf('S17、S18') !== -1, '要列出是哪幾個：' + text);
  assert.ok(text.indexOf('繼續跑自測') !== -1, '要指路：' + text);
});

test('報告：沒有停低時，不會無端出現「執行時間到」那一句', function () {
  const env = makeEnv({});
  const text = env.sandbox.buildSelfTestReportLines_(fakeSummary()).join('\n');
  assert.ok(text.indexOf('執行時間到') === -1, text);
});

test('報告：第一行的四個數字（綠／紅／略過／未跑）都印出來', function () {
  const env = makeEnv({});
  const first = env.sandbox.buildSelfTestReportLines_(fakeSummary())[0];
  assert.ok(first.indexOf('18 個情境') !== -1, first);
  assert.ok(first.indexOf('1 綠') !== -1 && first.indexOf('1 紅') !== -1, first);
  assert.ok(first.indexOf('1 略過') !== -1 && first.indexOf('2 未跑') !== -1, first);
});

test('對話框摘要：紅色的連預期與實際一齊講，並指路去完整報告', function () {
  const env = makeEnv({});
  const text = env.sandbox.buildSelfTestShortSummary_(fakeSummary());

  assert.ok(text.indexOf('🔴 S16') !== -1, text);
  assert.ok(text.indexOf('預期：') !== -1 && text.indexOf('實際：') !== -1, text);
  assert.ok(text.indexOf('SelfTestReport') !== -1, text);
});

test('對話框摘要：守門擋住時直接顯示守門訊息，不假裝跑過', function () {
  const env = makeEnv({});
  const text = env.sandbox.buildSelfTestShortSummary_({ ok: false, message: '守門訊息' });
  assert.strictEqual(text, '守門訊息');
});

test('報告與摘要的文字是書面語繁體中文', function () {
  const env = makeEnv({});
  assertWrittenChinese(assert, '自測報告', env.sandbox.buildSelfTestReportLines_(fakeSummary({ stoppedForTime: true })).join('\n'));
  assertWrittenChinese(assert, '自測摘要', env.sandbox.buildSelfTestShortSummary_(fakeSummary()));
});

// =====================================================================
// 續跑
// =====================================================================

test('續跑：從未跑過 → 明確拒絕，不會靜靜當成新的一次', function () {
  const env = makeEnv({});
  const summary = env.sandbox.runSelfTest_({ resume: true });
  assert.strictEqual(summary.ok, false);
  assert.ok(summary.message.indexOf('找不到未跑完的自測') !== -1, summary.message);
});

test('續跑：已經有結論的情境不會再跑一次', function () {
  const env = makeEnv({
    selfTestState: [
      { RUN_ID: 'ST1', SCENARIO_ID: 'S01', STATUS: 'PASS', STARTED_AT: '2028-10-01', FINISHED_AT: '2028-10-01', MESSAGE: '' },
      { RUN_ID: 'ST1', SCENARIO_ID: 'S02', STATUS: 'FAIL', STARTED_AT: '2028-10-01', FINISHED_AT: '2028-10-01', MESSAGE: '' }
    ]
  });
  deepEq(env.sandbox.selfTestFinishedScenarioIds_('ST1'), ['S01', 'S02']);
  assert.strictEqual(env.sandbox.selfTestLatestRunId_(), 'ST1');
});

// =====================================================================
// 清空沙盒
// =====================================================================

test('清空沙盒：只刪沙盒季度那幾行，其餘一行都不動', function () {
  // ⚠️ 這是整個自測機最危險的一支函式——刪錯了就是刪真資料。
  const env = makeEnv({
    weekRows: [
      { SERVICE_DATE: '2028-10-01', QUARTER_ID: '2028T4', WEEK_OF_MONTH: 1, STATUS: 'DRAFT' },
      { SERVICE_DATE: '2027-11-07', QUARTER_ID: '2027T4', WEEK_OF_MONTH: 1, STATUS: 'DRAFT' },
      { SERVICE_DATE: '2028-10-08', QUARTER_ID: '2028T4', WEEK_OF_MONTH: 2, STATUS: 'DRAFT' }
    ]
  });

  const config = env.sandbox.selfTestConfig_();
  env.sandbox.resetSelfTestSandbox_(config);

  const left = env.sandbox.readSheet('BulletinWeeks');
  assert.strictEqual(left.length, 1, '只應該剩下非沙盒那一行');
  assert.strictEqual(String(left[0].QUARTER_ID), '2027T4', '真實季度那一行不可以被刪');
});

test('清空沙盒：一個主日多行的表，只刪主日屬於沙盒季度的行', function () {
  const env = makeEnv({});
  const boot = env.boot;
  const def = boot.COLUMNS.ANNOUNCEMENTS;
  const sandboxDate = env.sandbox.selfTestCalendarSundays_('2028T4')[0];

  env.sheets.Announcements = makeFakeSheet(def.headers, def.keys, [
    { SERVICE_DATE: sandboxDate, SEQ_NO: 10, TEXT: '沙盒的', ACTIVE: true },
    { SERVICE_DATE: '2027-11-07', SEQ_NO: 10, TEXT: '真實的', ACTIVE: true }
  ]);

  env.sandbox.resetSelfTestSandbox_(env.sandbox.selfTestConfig_());

  const left = env.sandbox.readSheet('Announcements');
  assert.strictEqual(left.length, 1);
  assert.strictEqual(String(left[0].TEXT), '真實的');
});

test('清空沙盒：判斷不到主日的行一律不刪（寧可留垃圾，不可以誤刪）', function () {
  const env = makeEnv({});
  const def = env.boot.COLUMNS.ANNOUNCEMENTS;
  env.sheets.Announcements = makeFakeSheet(def.headers, def.keys, [
    { SERVICE_DATE: '', SEQ_NO: 10, TEXT: '沒有日期的一行', ACTIVE: true }
  ]);

  env.sandbox.resetSelfTestSandbox_(env.sandbox.selfTestConfig_());
  assert.strictEqual(env.sandbox.readSheet('Announcements').length, 1);
});

// =====================================================================
// S18 的覆蓋缺口要講出來
// =====================================================================

test('S18 的證據明確講出「沒有真的呼叫觸發器」這個覆蓋缺口', function () {
  // ⚠️ 一個「其實沒有驗到」的情境如果報綠燈而不講，就是這一輪要根治的
  // 假綠燈本身。所以缺口一定要寫在證據裡面。
  const env = makeEnv({});
  const outcome = env.sandbox.selfTestS18_({ config: env.sandbox.selfTestConfig_() });

  assert.ok(outcome.evidence.indexOf('覆蓋缺口') !== -1, outcome.evidence);
  assert.ok(outcome.evidence.indexOf('沒有**真的呼叫') !== -1
    || outcome.evidence.indexOf('沒有') !== -1, outcome.evidence);
  assert.ok(outcome.evidence.indexOf('人手驗') !== -1, '要講明仍然需要人手驗：' + outcome.evidence);
});

// =====================================================================

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
