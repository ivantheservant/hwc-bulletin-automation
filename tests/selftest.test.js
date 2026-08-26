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

test('守門：沙盒 master 檔案 === 正式 master 檔案 → 拒絕開跑', function () {
  const env = makeEnv({
    config: {
      SELFTEST_MASTER_PDF_FILE_ID: 'SAME_FILE_ID',
      PUBLISHED_PDF_FILE_ID: 'SAME_FILE_ID'
    }
  });
  const guard = env.sandbox.assertSelfTestSandbox_(env.sandbox.selfTestConfig_());

  assert.strictEqual(guard.ok, false);
  assert.ok(guard.message.indexOf('沙盒 master 檔案不可以是正式那一個') !== -1, guard.message);
  assert.ok(guard.message.indexOf('SELFTEST_MASTER_PDF_FILE_ID') !== -1, '要講得出是哪兩個設定鍵：' + guard.message);
  assert.ok(guard.message.indexOf('PUBLISHED_PDF_FILE_ID') !== -1, guard.message);
  assert.ok(guard.message.indexOf('一格都沒有寫') !== -1, '要講明沒有寫入：' + guard.message);
});

// ⚠️ 只回 ok:false 不夠——要確認它真的沒有跑任何情境。這一條守的是
//    「先跑幾個看看」那種寫法：S13／S14／S15 會**真的覆寫** master 檔案
//    的內容並加版本，跑一個都嫌多。
test('守門：沙盒 master === 正式 master → runSelfTest_() 一個情境都不跑', function () {
  const env = makeEnv({
    config: {
      SELFTEST_MASTER_PDF_FILE_ID: 'SAME_FILE_ID',
      PUBLISHED_PDF_FILE_ID: 'SAME_FILE_ID'
    }
  });
  const summary = env.sandbox.runSelfTest_({});

  assert.strictEqual(summary.ok, false);
  deepEq(summary.results, []);
  assert.strictEqual(summary.passCount, 0);
  assert.strictEqual(env.sheets.SelfTestReport.getLastRow(), 2, 'SelfTestReport 不應該多任何一行');
});

// ⚠️ 亂行機同樣會發佈，走同一道守門，所以同樣要擋。
test('守門：沙盒 master === 正式 master → runMonkey_() 一步都不行', function () {
  const env = makeEnv({
    config: {
      SELFTEST_MASTER_PDF_FILE_ID: 'SAME_FILE_ID',
      PUBLISHED_PDF_FILE_ID: 'SAME_FILE_ID'
    }
  });
  const result = env.sandbox.runMonkey_({ steps: 5 });

  assert.strictEqual(result.ok, false);
  deepEq(result.steps, []);
  assert.ok(result.message.indexOf('沙盒 master 檔案不可以是正式那一個') !== -1, result.message);
});

test('守門：兩個 master 檔案 ID 不同 → 放行', function () {
  const env = makeEnv({
    config: {
      SELFTEST_MASTER_PDF_FILE_ID: 'SANDBOX_FILE_ID',
      PUBLISHED_PDF_FILE_ID: 'PRODUCTION_FILE_ID'
    }
  });
  const guard = env.sandbox.assertSelfTestSandbox_(env.sandbox.selfTestConfig_());
  assert.strictEqual(guard.ok, true, guard.message);
});

// ⚠️ 兩個都是空字串代表「未設定」，那是另一件事——自測機會略過發佈相關
//    情境並講明原因。空值當成相同而擋住開跑的話，一個全新的環境會連自測
//    機都跑不起來。
test('守門：兩個都未設定（都是空字串）→ 放行，不可以當成「相同」', function () {
  const env = makeEnv({
    config: { SELFTEST_MASTER_PDF_FILE_ID: '', PUBLISHED_PDF_FILE_ID: '' }
  });
  const guard = env.sandbox.assertSelfTestSandbox_(env.sandbox.selfTestConfig_());
  assert.strictEqual(guard.ok, true, guard.message);
});

test('守門：正式那個有值、沙盒未設定 → 放行（未設定不等於撞到）', function () {
  const env = makeEnv({
    config: { SELFTEST_MASTER_PDF_FILE_ID: '', PUBLISHED_PDF_FILE_ID: 'PRODUCTION_FILE_ID' }
  });
  const guard = env.sandbox.assertSelfTestSandbox_(env.sandbox.selfTestConfig_());
  assert.strictEqual(guard.ok, true, guard.message);
});

// ⚠️ 前後空白不可以令兩個相同的 ID 溜過去。Config 那一格是人手貼上去的，
//    貼多一個空格是很平常的事。
test('守門：ID 相同但帶前後空白 → 一樣擋得住（selfTestConfig_ 會 trim）', function () {
  const env = makeEnv({
    config: {
      SELFTEST_MASTER_PDF_FILE_ID: '  SAME_FILE_ID  ',
      PUBLISHED_PDF_FILE_ID: 'SAME_FILE_ID'
    }
  });
  const guard = env.sandbox.assertSelfTestSandbox_(env.sandbox.selfTestConfig_());
  assert.strictEqual(guard.ok, false, '前後空白不應該令這道守門失效');
});

test('selfTestConfig_ 讀得到正式那個 master 檔案 ID（只為對數，自測機不會碰它）', function () {
  const env = makeEnv({ config: { PUBLISHED_PDF_FILE_ID: 'PRODUCTION_FILE_ID' } });
  const config = env.sandbox.selfTestConfig_();
  assert.strictEqual(config.publishedFileId, 'PRODUCTION_FILE_ID');
});

test('守門：預設沙盒季度是 2030T1、只讀季度是 2027T4（兩者必須不同）', function () {
  const env = makeEnv({});
  const config = env.sandbox.selfTestConfig_();
  // 2026-08-26 由 2028T4 改成 2030T1。沙盒季度要同時滿足兩個條件：
  //   (1) 職事表沒有這一季（職事表最遠只到 2028T4，所以 2028T4 本身
  //       其實**有**資料，一直是個錯的選擇）；
  //   (2) 含夏令時間轉換提示日，S22–S24 才驗得到真的寫入。
  // 提示登在改動當日的**前一個主日**，所以要用 YYYYT1 或 YYYYT3——
  // YYYYT2 與 YYYYT4 永遠不會含提示日。見 docs/待確認事項.md V-3。
  assert.strictEqual(config.quarterId, '2030T1');
  assert.strictEqual(config.rosterQuarterId, '2027T4');
  assert.notStrictEqual(config.quarterId, config.rosterQuarterId);
});

test('寫入守門：assertSelfTestWritableQuarter_ 擋得住非沙盒季度', function () {
  const env = makeEnv({});
  const config = env.sandbox.selfTestConfig_();

  assert.doesNotThrow(function () {
    env.sandbox.assertSelfTestWritableQuarter_('2030T1', config);
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

test('selfTestCalendarSundays_：2030T1 是 1–3 月全部星期日', function () {
  const env = makeEnv({});
  const dates = env.sandbox.selfTestCalendarSundays_('2030T1');

  assert.ok(dates.length >= 12 && dates.length <= 14, '一季應該有 12–14 個星期日，實際 ' + dates.length);
  assert.ok(dates[0].indexOf('2030-01-') === 0, dates[0]);
  assert.ok(dates[dates.length - 1].indexOf('2030-03-') === 0, dates[dates.length - 1]);

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
  assert.ok(dates[0].indexOf('2030-') === 0, dates[0]);
});

// =====================================================================
// 情境清單
// =====================================================================

test('情境清單：三十九個，編號不重複、每個都有實作', function () {
  const env = makeEnv({});
  const scenarios = env.sandbox.selfTestScenarios_();

  // 第三輪自測新增 S14b／S14c：S14 只驗「連續撳兩次不會出兩個版本」這個
  // **結果**；防重複那一道本身由 S14b（視窗之內要擋）與 S14c（視窗之外
  // 不可以擋）專門驗。見 docs/已知bug類型.md 事故三十二。
  // R-036／R-030 加了 S19–S25 共七條（職事表未有資料仍可建立、補抓不覆寫、
  // 夏令時間提示自動加），所以由 20 變 27。
  // 2026-08-27 由 27 變 33：R-033 加 S26–S29（草稿預覽）、R-032 加 S30–S31
  // （重複段落偵測、內容份量估算）。
  // 2026-08-27 由 33 變 39：R-035 加 S32–S37（封存）。
  assert.strictEqual(scenarios.length, 39);
  const ids = scenarios.map(function (s) { return s.id; });
  deepEq(ids, ['S01', 'S02', 'S03', 'S04', 'S05', 'S06', 'S07', 'S08', 'S09',
    'S10', 'S11', 'S12', 'S13', 'S14', 'S14b', 'S14c', 'S15', 'S16', 'S17', 'S18',
    'S19', 'S20', 'S21', 'S22', 'S23', 'S24', 'S25',
    'S26', 'S27', 'S28', 'S29', 'S30', 'S31',
    'S32', 'S33', 'S34', 'S35', 'S36', 'S37']);

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
      },
      // ⚠️ 第二輪自測新增的第四種結果：情境本身通過，但跑完之後不變量
      //    不成立。第二輪 18 個情境 6 紅，其中 5 個就是這一種——那 5 個
      //    情境自己全部寫住「實際：符合」。
      {
        id: 'S14', name: '防重複', result: 'INVARIANT_WARNING',
        expected: '被防重複擋住', actual: '被擋住；不變量 I06 不成立',
        evidence: '情境本身通過，但跑完之後不變量不成立：I06',
        invariantFailures: ['I06'], elapsedMs: 30
      },
      {
        id: 'S15', name: '揀錯檔案', result: 'INVARIANT_WARNING',
        expected: '被拒', actual: '被拒；不變量 I06 不成立',
        evidence: '情境本身通過，但跑完之後不變量不成立：I06',
        invariantFailures: ['I06'], elapsedMs: 20
      }
    ],
    passCount: 1, failCount: 1, skipCount: 1, invariantWarningCount: 2,
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

// ⚠️ 第二輪自測改變了這一行的寫法：「不變量警告」要**單獨數出來**。
//    併入「通過」等於放過一個真的問題；併入「失敗」等於把一個要查的
//    問題報成六個。見 docs/已知bug類型.md 事故三十一。
test('報告：第一行分開數出通過／失敗／不變量警告／略過／未跑', function () {
  const env = makeEnv({});
  const first = env.sandbox.buildSelfTestReportLines_(fakeSummary())[0];
  assert.ok(first.indexOf('18 個情境') !== -1, first);
  assert.ok(first.indexOf('1 通過') !== -1, first);
  assert.ok(first.indexOf('1 失敗') !== -1, first);
  assert.ok(first.indexOf('2 不變量警告') !== -1, '不變量警告要單獨數：' + first);
  assert.ok(first.indexOf('1 略過') !== -1 && first.indexOf('2 未跑') !== -1, first);
});

test('報告：三段分開——情境本身失敗／情境通過但不變量不成立／略過', function () {
  const env = makeEnv({});
  const lines = env.sandbox.buildSelfTestReportLines_(fakeSummary());
  const text = lines.join('\n');

  const failIdx = lines.findIndex(function (l) { return l.indexOf('【情境本身失敗】') !== -1; });
  const warnIdx = lines.findIndex(function (l) { return l.indexOf('【情境通過，但不變量不成立】') !== -1; });
  const skipIdx = lines.findIndex(function (l) { return l.indexOf('【略過') !== -1; });

  assert.ok(failIdx !== -1, '缺「情境本身失敗」一段：' + text);
  assert.ok(warnIdx !== -1, '缺「情境通過，但不變量不成立」一段：' + text);
  assert.ok(skipIdx !== -1, '缺「略過」一段：' + text);
  assert.ok(failIdx < warnIdx && warnIdx < skipIdx,
    '三段的次序要是：失敗 → 不變量警告 → 略過（真的要修的東西排最前）');
  assert.ok(text.indexOf('略過」不等於「通過') !== -1, '略過那一段仍然要講明它不等於通過');
});

test('報告：不變量警告那一段指名是哪一條不變量，並叫人先查那一條', function () {
  const env = makeEnv({});
  const text = env.sandbox.buildSelfTestReportLines_(fakeSummary()).join('\n');
  assert.ok(text.indexOf('牽涉的不變量：I06') !== -1, text);
  assert.ok(text.indexOf('受影響的情境 2 個') !== -1, text);
  assert.ok(text.indexOf('不要逐個情境查') !== -1, text);
  assert.ok(text.indexOf('🟡 S14') !== -1, '每一個受影響的情境都要列出來：' + text);
  assert.ok(text.indexOf('🟡 S15') !== -1, text);
});

// ⚠️ 這一條守住「不變量警告不可以被當成 🔴」——混在一起顯示正是這一輪
//    要修的東西。
test('報告：不變量警告不會出現在「情境本身失敗」那一段', function () {
  const env = makeEnv({});
  const lines = env.sandbox.buildSelfTestReportLines_(fakeSummary());
  const failIdx = lines.findIndex(function (l) { return l.indexOf('【情境本身失敗】') !== -1; });
  const warnIdx = lines.findIndex(function (l) { return l.indexOf('【情境通過，但不變量不成立】') !== -1; });
  const failSection = lines.slice(failIdx, warnIdx).join('\n');
  assert.ok(failSection.indexOf('S16') !== -1, '真的失敗那一個要在這一段');
  assert.ok(failSection.indexOf('S14') === -1, 'S14 只是不變量警告，不可以排進失敗那一段');
  assert.ok(failSection.indexOf('S15') === -1, failSection);
});

test('報告：完全沒有不變量警告時，那一段不會出現（不留一個空標題）', function () {
  const env = makeEnv({});
  const clean = fakeSummary({
    results: [{ id: 'S01', name: '空季度', result: 'PASS', expected: '4 行', actual: '4 行', evidence: 'x', elapsedMs: 12 }],
    passCount: 1, failCount: 0, skipCount: 0, invariantWarningCount: 0, pendingIds: []
  });
  const text = env.sandbox.buildSelfTestReportLines_(clean).join('\n');
  assert.ok(text.indexOf('【情境通過，但不變量不成立】') === -1, text);
  assert.ok(text.indexOf('0 不變量警告') !== -1, '摘要那一行照樣要寫出 0：' + text);
});

test('對話框摘要：有不變量警告時講明「先查那一條不變量」', function () {
  const env = makeEnv({});
  const text = env.sandbox.buildSelfTestShortSummary_(fakeSummary());
  assert.ok(text.indexOf('2 不變量警告') !== -1, text);
  assert.ok(text.indexOf('I06') !== -1, text);
  assert.ok(text.indexOf('不要逐個情境查') !== -1, text);
});

test('selfTestSummaryCounts_：四種結果各自數，一個都不會漏或重複', function () {
  const env = makeEnv({});
  const counts = env.sandbox.selfTestSummaryCounts_(fakeSummary().results);
  assert.strictEqual(counts.passCount, 1);
  assert.strictEqual(counts.failCount, 1);
  assert.strictEqual(counts.invariantWarningCount, 2);
  assert.strictEqual(counts.skipCount, 1);
  assert.strictEqual(
    counts.passCount + counts.failCount + counts.invariantWarningCount + counts.skipCount,
    fakeSummary().results.length, '四個數加起來要等於情境總數');
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
      { SERVICE_DATE: '2030-01-06', QUARTER_ID: '2030T1', WEEK_OF_MONTH: 1, STATUS: 'DRAFT' },
      { SERVICE_DATE: '2027-11-07', QUARTER_ID: '2027T4', WEEK_OF_MONTH: 1, STATUS: 'DRAFT' },
      { SERVICE_DATE: '2030-01-13', QUARTER_ID: '2030T1', WEEK_OF_MONTH: 2, STATUS: 'DRAFT' }
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
  const sandboxDate = env.sandbox.selfTestCalendarSundays_('2030T1')[0];

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
// S14：防重複——改成不依賴時間（第二輪自測）
// =====================================================================

// ⚠️ 防重複本身**沒有壞**，證據見 tests/publishfix.test.js 第 9、9b 條：
//    同一主日、視窗之內，第二、三次照樣擋得住、版本號不變。
//
//    S14 第二輪報紅的原因是**測試依賴時間**：每個情境耗時 14 至 23 秒
//    （那個數字包含跑完十條不變量），而 PUBLISH_DEDUP_SEC 只有 30 秒
//    ——由 S13 發佈完到 S14 再發佈，隨時已經超出視窗。
//
//    所以改的是測試，不是防重複（prompt 第 2 節：不要為了讓它變綠而改
//    防重複）。下面幾條守住「新版 S14 不再依賴那個前提」。

test('S14 不再依賴「S13 剛剛發佈過」這個前提', function () {
  const env = makeEnv({});
  // 完全沒有 ctx.lastPublishedPdfBase64——舊版在這裡會回「請先跑 S13」。
  const outcome = env.sandbox.selfTestS14_({ config: env.sandbox.selfTestConfig_() });
  assert.ok(outcome.actual.indexOf('S13 未跑') === -1,
    '新版 S14 自己發佈兩次，不應該再要求 S13 先跑：' + JSON.stringify(outcome));
  assert.ok(outcome.evidence.indexOf('請先跑 S13') === -1, outcome.evidence);
});

test('S14 的證據講得出 S13 → S14 相隔多少秒與 PUBLISH_DEDUP_SEC 的現值', function () {
  const env = makeEnv({});
  const nowMs = new Date().getTime();
  const outcome = env.sandbox.selfTestS14_({
    config: env.sandbox.selfTestConfig_(),
    lastPublishAtMs: nowMs - 45000,
    lastPublishIsoDate: '2028-10-01'
  });
  assert.ok(outcome.evidence.indexOf('PUBLISH_DEDUP_SEC=30') !== -1, outcome.evidence);
  assert.ok(outcome.evidence.indexOf('秒前發佈') !== -1, outcome.evidence);
});

// ⚠️ 這一條是關鍵的診斷句：45 秒 > 30 秒，證據要**明白講出**「舊版在這個
//    情況下必然擋不住，那不是防重複壞了」。沒有這一句，下一個看報告的人
//    只會見到一個紅燈，再去改防重複。
test('S14 的證據會指出「超出視窗 → 舊版必然擋不住，不是防重複壞了」', function () {
  const env = makeEnv({});
  const text = env.sandbox.selfTestDescribePublishGap_(
    { lastPublishAtMs: new Date().getTime() - 45000, lastPublishIsoDate: '2028-10-01' }, 30);
  assert.ok(text.indexOf('已經超出視窗') !== -1, text);
  assert.ok(text.indexOf('測試依賴時間') !== -1, text);
});

test('S14 的證據：仍在視窗之內時如實講「仍在視窗之內」', function () {
  const env = makeEnv({});
  const text = env.sandbox.selfTestDescribePublishGap_(
    { lastPublishAtMs: new Date().getTime() - 5000, lastPublishIsoDate: '2028-10-01' }, 30);
  assert.ok(text.indexOf('仍在視窗之內') !== -1, text);
});

test('S14 的證據：PUBLISH_DEDUP_SEC 是 0 → 講明防重複等於關閉', function () {
  const env = makeEnv({});
  const text = env.sandbox.selfTestDescribePublishGap_(
    { lastPublishAtMs: new Date().getTime() - 5000 }, 0);
  assert.ok(text.indexOf('等於關閉') !== -1, text);
});

test('S14 的證據：S13 未記下發佈時刻 → 如實講「講不出」，不會靜靜當成 0 秒', function () {
  const env = makeEnv({});
  const text = env.sandbox.selfTestDescribePublishGap_({}, 30);
  assert.ok(text.indexOf('講不出') !== -1, text);
});

test('S13 跑完會記下發佈時刻與主日，供 S14 的證據用', function () {
  const env = makeEnv({});
  const src = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'src', 'SelfTest.gs'), 'utf8');
  assert.ok(src.indexOf('ctx.lastPublishAtMs = new Date().getTime();') !== -1,
    'S13 要記下發佈時刻，否則 S14 的證據講不出相隔多少秒');
  assert.ok(src.indexOf('ctx.lastPublishIsoDate = isoDate;') !== -1, src.length);
});

// ⚠️ S14 刻意用**另一個主日**（dates[1]）：防重複的時間戳是逐個主日分開
//    存的，用 S13 那一個主日的話，S13 留下的時間戳會令 S14 的第一次發佈
//    就被擋住——那樣又變成依賴上一個情境。
// ⚠️ 第三輪改了分工：S14 刻意用**同一份**（驗「結果」），S14b／S14c 才用
//    內容不同的（驗防重複那一道本身）。四個情境各自用不同主日，令彼此的
//    時間戳影響不到對方。
test('S14／S14b／S14c 各自用不同主日，令彼此的時間戳影響不到對方', function () {
  const src = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'src', 'SelfTest.gs'), 'utf8');
  function bodyOf(name, nextName) {
    return src.slice(src.indexOf('function ' + name), src.indexOf('function ' + nextName));
  }
  assert.ok(bodyOf('selfTestS14_', 'selfTestS14b_').indexOf('var isoDate = dates[1];') !== -1,
    'S14 要用 dates[1]（S13 用 dates[0]）');
  assert.ok(bodyOf('selfTestS14b_', 'selfTestS14c_').indexOf('var isoDate = dates[2];') !== -1,
    'S14b 要用 dates[2]');
  assert.ok(bodyOf('selfTestS14c_', 'describePublishBlock_').indexOf('var isoDate = dates[3];') !== -1,
    'S14c 要用 dates[3]');
});

// ⚠️ selfTestMakePdfBlob_() 把全部非 ASCII 換成 `?`，所以「甲」「乙」兩份
//    會變成完全一樣的位元組——第二輪就是這樣造出兩份「以為不同、其實相同」
//    的 PDF，於是被「揀錯檔案」那一道擋住而不是防重複。
test('selfTestMakePdfBlob_：非 ASCII 全部變 ?，所以「不同內容」一定要用 ASCII 分辨', function () {
  const env = makeEnv({});
  // selfTestMakePdfBlob_() 做的是 replace(/[^ -~]/g, '?') 之後交給
  // buildMinimalPdfText_()。這裡直接用真的 buildMinimalPdfText_() 驗同一件事
  // （測試環境沒有 Utilities.newBlob，但那一層不是重點）。
  function normalise(text) {
    return String(text).replace(/[^ -~]/g, '?');
  }
  const build = env.sandbox.buildMinimalPdfText_;

  assert.strictEqual(normalise('自測防重複甲 X'), normalise('自測防重複乙 X'),
    '兩個中文字都會變成 ?——這正是第二輪那兩份「以為不同、其實相同」的 PDF 的成因');
  assert.strictEqual(build([normalise('自測防重複甲 X')]), build([normalise('自測防重複乙 X')]),
    '造出來的 PDF 位元組完全相同');

  assert.notStrictEqual(build([normalise('selftest dedup B1 X')]),
    build([normalise('selftest dedup B2 different X')]),
    'ASCII 文字才造得出真的不同的內容');
});

test('S14b／S14c 用的是 ASCII 文字（否則兩份 PDF 會完全一樣）', function () {
  const src = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'src', 'SelfTest.gs'), 'utf8');
  const body = src.slice(src.indexOf('function selfTestS14b_'), src.indexOf('function describePublishBlock_'));
  const calls = body.split("selfTestMakePdfBlob_('").slice(1)
    .map(function (rest) { return "selfTestMakePdfBlob_('" + rest.slice(0, rest.indexOf("'") + 1); });
  assert.ok(calls.length >= 4, '應該有四次呼叫（S14b 兩次、S14c 兩次）：' + calls.length);
  calls.forEach(function (call) {
    const text = call.slice(call.indexOf("('") + 2, call.length - 1);
    // eslint-disable-next-line no-control-regex
    assert.ok(/^[ -~]*$/.test(text), '不可以有非 ASCII 字元：' + call);
  });
});

// =====================================================================
// describePublishBlock_：斷言針對「結果」，不是「哪一道守門」
// =====================================================================

// ⚠️ 第三輪的核心教訓：第二輪的 S14 只認 PUBLISH_DEDUP_SEC 那一道守門。
//    實際跑出來是被 UPLOAD_IS_CURRENT_MASTER 擋住的——行為完全正確
//    （版本號維持 1），情境卻報失敗。斷言指定了「用哪一道守門」，
//    而不是「結果對不對」。見 docs/已知bug類型.md 事故三十二。

test('describePublishBlock_：防重複擋住 → blocked，gate 是 DEDUP', function () {
  const env = makeEnv({});
  const b = env.sandbox.describePublishBlock_({
    ok: true, duplicate: true, lines: ['剛才已經發佈過（第 1 版）'],
    published: { versionNo: 1 }
  });
  assert.strictEqual(b.blocked, true);
  assert.strictEqual(b.gate, 'DEDUP');
  assert.ok(b.gateLabel.indexOf('防重複') !== -1, b.gateLabel);
});

// ⚠️ 這一條就是第三輪那個假紅：換一道守門擋住，一樣算「被擋住」。
test('describePublishBlock_：揀錯檔案擋住 → 一樣算 blocked，gate 講得出是哪一道', function () {
  const env = makeEnv({});
  const b = env.sandbox.describePublishBlock_({
    ok: false, reason: 'UPLOAD_IS_CURRENT_MASTER',
    message: '你選的是目前已發佈的那一份，請選用 Word 另存的新 PDF。'
  });
  assert.strictEqual(b.blocked, true, '被另一道守門擋住，一樣是「被擋住」');
  assert.strictEqual(b.gate, 'UPLOAD_IS_CURRENT_MASTER');
  assert.ok(b.gateLabel.indexOf('揀錯檔案') !== -1, b.gateLabel);
  assert.ok(b.message.indexOf('目前已發佈的那一份') !== -1, b.message);
});

test('describePublishBlock_：成功發佈 → blocked 是 false', function () {
  const env = makeEnv({});
  const b = env.sandbox.describePublishBlock_({ ok: true, published: { versionNo: 2 }, lines: [] });
  assert.strictEqual(b.blocked, false);
  assert.strictEqual(b.gate, '');
});

test('describePublishBlock_：認不出的原因 → 原樣回機器碼，不會靜靜當成沒有被擋', function () {
  const env = makeEnv({});
  const b = env.sandbox.describePublishBlock_({ ok: false, reason: 'SOMETHING_NEW', message: 'x' });
  assert.strictEqual(b.blocked, true);
  assert.strictEqual(b.gate, 'SOMETHING_NEW');
  assert.strictEqual(b.gateLabel, 'SOMETHING_NEW', '認不出就原樣講機器碼，好過不講');
});

test('describePublishBlock_：完全沒有回報原因 → 一樣算 blocked，並講明沒有原因', function () {
  const env = makeEnv({});
  const b = env.sandbox.describePublishBlock_({ ok: false });
  assert.strictEqual(b.blocked, true);
  assert.ok(b.gateLabel.indexOf('沒有回報原因') !== -1, b.gateLabel);
});

test('publishGateLabel_：每一個已知的守門碼都有中文名', function () {
  const env = makeEnv({});
  ['UPLOAD_IS_CURRENT_MASTER', 'UPLOAD_IS_PLACEHOLDER', 'NOT_PDF', 'EMPTY_FILE',
    'TOO_LARGE', 'NO_MASTER_FILE', 'NO_ARCHIVE_FOLDER', 'NEVER_PUBLISHED'
  ].forEach(function (code) {
    const label = env.sandbox.publishGateLabel_(code);
    assert.notStrictEqual(label, code, code + ' 沒有中文名');
    assert.ok(label.length > 0);
  });
});

// ⚠️ S14 的斷言要針對**結果**：被擋住 ＋ 版本不變。至於是哪一道守門，
//    記入證據，不寫進斷言。這一條用讀原始碼的方式守住那個分工。
test('S14 的斷言針對「有沒有被擋」，不是「被哪一道擋」', function () {
  const src = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'src', 'SelfTest.gs'), 'utf8');
  const body = src.slice(src.indexOf('function selfTestS14_'), src.indexOf('function selfTestS14b_'));

  assert.ok(body.indexOf('block.blocked && versionHeld') !== -1,
    'S14 的 ok 應該只看「被擋住」與「版本不變」：' + body.slice(-400));
  assert.ok(body.indexOf("block.gate === 'DEDUP'") === -1,
    'S14 不可以指定一定要防重複那一道擋住——那正是第三輪那個假紅');
  assert.ok(body.indexOf('擋住的守門：') !== -1, '是哪一道要寫入證據');
});

test('S14b 才是專門驗防重複那一道的（它可以指定 gate）', function () {
  const src = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'src', 'SelfTest.gs'), 'utf8');
  const body = src.slice(src.indexOf('function selfTestS14b_'), src.indexOf('function selfTestS14c_'));
  assert.ok(body.indexOf("block.gate === 'DEDUP'") !== -1,
    'S14b 的分工正正是驗防重複那一道');
});

test('S14c 驗「不該擋的時候不擋」：版本要 +1', function () {
  const src = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'src', 'SelfTest.gs'), 'utf8');
  const body = src.slice(src.indexOf('function selfTestS14c_'), src.indexOf('function describePublishBlock_'));
  assert.ok(body.indexOf('!block.blocked') !== -1, 'S14c 要斷言沒有被擋');
  assert.ok(body.indexOf('versionAfterFirst + 1') !== -1, 'S14c 要斷言版本 +1');
});

// ⚠️ 撥時間戳是一個可以亂改狀態的動作，所以一定要先經沙盒守門。
test('selfTestRewindPublishStamp_：只准撥沙盒季度的主日', function () {
  const env = makeEnv({});
  const config = env.sandbox.selfTestConfig_();
  assert.throws(function () {
    env.sandbox.selfTestRewindPublishStamp_('2027-10-03', config, 60000);
  }, /只准寫沙盒季度/);
});

test('selfTestRewindPublishStamp_：找不到時間戳 → ok:false，不會靜靜當成成功', function () {
  const env = makeEnv({});
  const config = env.sandbox.selfTestConfig_();
  const dates = env.sandbox.selfTestSandboxDates_(config);
  const result = env.sandbox.selfTestRewindPublishStamp_(dates[0], config, 60000);
  assert.strictEqual(result.ok, false);
  assert.ok(result.message.indexOf('找不到') !== -1, result.message);
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
