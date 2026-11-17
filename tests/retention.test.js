#!/usr/bin/env node
/**
 * tests/retention.test.js
 *
 * R-035（舊季度自動封存）、R-037（環境整理），以及兩個職事表選單改名的
 * 回歸測試。
 *
 * ⚠️ 這一組最要緊的一條，是**「一格資料都不可以刪」**。封存只是「預設不
 * 顯示」——所以測試不只驗「封存之後見不到」，更要驗「取消封存之後完完整整
 * 地回來」，以及「`Retention.gs` 整個檔案沒有任何刪除操作」。
 *
 * 執行方式：node tests/retention.test.js
 * 離開碼：0＝全部通過　1＝有測試失敗
 */

'use strict';

const assert = require('assert');
const vm = require('vm');
const path = require('path');
const fsNode = require('fs');
const { loadAllSrcFilesInOrder } = require('./helpers/loadGas');
const { makeFakeSheet, makeFakeSpreadsheet } = require('./helpers/fakeSpreadsheet');

const FAKE_ROSTER_ID = 'FAKE_ROSTER_ID_FOR_RETENTION_TEST';
const SANDBOX_QUARTER = '2030T1';

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

function baseStubs(todayIso) {
  return {
    Utilities: {
      formatDate: function (date, tz, pattern) {
        // todayIso：固定「真正的今日」（R-035 修正按今日所在季度計算）。
        if (todayIso && pattern === 'yyyy-MM-dd') return todayIso;
        const y = date.getFullYear();
        const mo = String(date.getMonth() + 1).padStart(2, '0');
        const d = String(date.getDate()).padStart(2, '0');
        const hh = String(date.getHours()).padStart(2, '0');
        const mi = String(date.getMinutes()).padStart(2, '0');
        if (String(pattern).indexOf('HH') !== -1) return `${y}-${mo}-${d} ${hh}:${mi}`;
        return `${y}-${mo}-${d}`;
      }
    },
    Session: {
      getScriptTimeZone: function () { return 'Pacific/Auckland'; },
      getActiveUser: function () { return { getEmail: function () { return 'tester@example.org'; } }; },
      getEffectiveUser: function () { return { getEmail: function () { return 'tester@example.org'; } }; }
    },
    CacheService: {},
    HtmlService: {},
    MailApp: { getRemainingDailyQuota: function () { return 100; } },
    DriveApp: { getRootFolder: function () { return { getName: function () { return 'root'; } }; } },
    LockService: {
      getScriptLock: function () {
        return { tryLock: function () { return true; }, releaseLock: function () {} };
      }
    }
  };
}

const boot = loadAllSrcFilesInOrder(baseStubs());

function makeEnv(options) {
  const o = options || {};

  const cfg = {};
  boot.DEFAULTS.forEach(function (d) { cfg[d.key] = d.value; });
  cfg.ROSTER_SPREADSHEET_ID = FAKE_ROSTER_ID;
  cfg.SELFTEST_QUARTER_ID = SANDBOX_QUARTER;
  Object.assign(cfg, o.config || {});

  const sheets = {};
  Object.keys(boot.SHEETS).forEach(function (id) {
    const def = boot.COLUMNS[id];
    sheets[boot.SHEETS[id]] = makeFakeSheet(def.headers, def.keys, []);
  });
  sheets.Config = makeFakeSheet(boot.COLUMNS.CONFIG.headers, boot.COLUMNS.CONFIG.keys,
    Object.keys(cfg).map(function (k) { return { KEY: k, VALUE: cfg[k], NOTE: '', EDITABLE: true }; }));
  Object.keys(sheets).forEach(function (name) { sheets[name].setName(name); });

  const triggers = o.triggers || [];

  const sandbox = loadAllSrcFilesInOrder(Object.assign({}, baseStubs(o.todayIso), {
    SpreadsheetApp: {
      getActiveSpreadsheet: function () {
        const ss = makeFakeSpreadsheet(sheets);
        // R-058：`spreadsheetTz`＝這份試算表的時區；沒有指定就沒有這個方法（核對不到）。
        if (o.spreadsheetTz) ss.getSpreadsheetTimeZone = function () { return o.spreadsheetTz; };
        return ss;
      },
      openById: function () { throw new Error('這一組測試不連職事表'); },
      ProtectionType: { SHEET: 'SHEET' },
      getUi: function () {
        if (o.ui) return o.ui;
        throw new Error('這一組測試不應該用到 UI');
      }
    },
    ScriptApp: {
      getProjectTriggers: function () {
        return triggers.map(function (name) {
          return { getHandlerFunction: function () { return name; } };
        });
      }
    }
  }));

  vm.runInContext('function __mkDate(y, m, d) { return new Date(y, m, d); }', sandbox);

  (o.weekRowSpecs || []).forEach(function (spec) {
    const p = spec.isoDate.split('-').map(Number);
    sandbox.writeSheet_(sandbox.SHEETS.BULLETIN_WEEKS, [Object.assign({
      SERVICE_DATE: sandbox.__mkDate(p[0], p[1] - 1, p[2]),
      QUARTER_ID: spec.quarterId,
      WEEK_OF_MONTH: 1,
      STATUS: 'DRAFT'
    }, spec.fields || {})]);
  });

  // 內容表登記行（R-055 測試用）：{ QUARTER_ID, FILE_ID, FILE_URL, ACTIVE }。
  (o.contentSheetSpecs || []).forEach(function (spec) {
    sandbox.writeSheet_(sandbox.SHEETS.CONTENT_SHEETS, [Object.assign({
      CREATED_AT: '2026-09-01', LAST_IMPORTED_AT: '', INVITE_SENT_AT: ''
    }, spec)]);
  });

  (o.publishRowSpecs || []).forEach(function (spec) {
    const p = spec.isoDate.split('-').map(Number);
    sandbox.writeSheet_(sandbox.SHEETS.PUBLISH_LOG, [{
      SERVICE_DATE: sandbox.__mkDate(p[0], p[1] - 1, p[2]),
      VERSION_NO: spec.versionNo || 1,
      PUBLISHED_AT: sandbox.__mkDate(p[0], p[1] - 1, p[2]),
      PUBLISHED_BY: 'tester',
      MASTER_FILE_ID: spec.masterFileId || 'FAKE_MASTER',
      IS_SELFTEST: spec.isSelfTest === true
    }]);
  });

  return { sandbox: sandbox, sheets: sheets };
}

function arr(a) { return Array.prototype.slice.call(a); }

// =====================================================================
// 第 1 組：決定封存哪一季
// =====================================================================

console.log('\n第 1 組：決定封存哪一季');

test('RETENTION_QUARTERS_VISIBLE=2 → 只有本季與前一季可見', function () {
  const env = makeEnv({});
  const plan = env.sandbox.planQuarterRetention_(['2029T1', '2029T2', '2029T3'], 2, '', '2029T3');
  assert.strictEqual(JSON.stringify(arr(plan.visible)), JSON.stringify(['2029T3', '2029T2']));
  assert.strictEqual(JSON.stringify(arr(plan.toArchive)), JSON.stringify(['2029T1']));
});

test('改成 4 → 四季可見，一季都不封存', function () {
  const env = makeEnv({});
  const plan = env.sandbox.planQuarterRetention_(['2029T1', '2029T2', '2029T3', '2029T4'], 4, '', '2029T4');
  assert.strictEqual(plan.visible.length, 4);
  assert.strictEqual(plan.toArchive.length, 0);
});

test('跨年排序正確：2030T1 比 2029T4 新', function () {
  // ⚠️ 用字串比較（YYYYTn 格式下字串序 === 時間序）。寫錯就會把新一季封存。
  const env = makeEnv({});
  const plan = env.sandbox.planQuarterRetention_(['2029T4', '2030T1'], 1, '', '2030T1');
  assert.strictEqual(JSON.stringify(arr(plan.visible)), JSON.stringify(['2030T1']));
  assert.strictEqual(JSON.stringify(arr(plan.toArchive)), JSON.stringify(['2029T4']));
});

test('沙盒季度兩邊都不入：既不可見、也永不封存', function () {
  const env = makeEnv({});
  const plan = env.sandbox.planQuarterRetention_(
    ['2029T1', '2029T2', '2029T3', SANDBOX_QUARTER], 1, SANDBOX_QUARTER, '2029T3');
  assert.strictEqual(plan.visible.indexOf(SANDBOX_QUARTER), -1, '不可以算進可見那 N 季');
  assert.strictEqual(plan.toArchive.indexOf(SANDBOX_QUARTER), -1, '永遠不可以被封存');
  assert.strictEqual(JSON.stringify(arr(plan.sandbox)), JSON.stringify([SANDBOX_QUARTER]));
});

test('保留數不合法 → 退回 2，不會變成 0（0 會把全部季度封存）', function () {
  const env = makeEnv({});
  [0, -1, '亂寫', null].forEach(function (bad) {
    const plan = env.sandbox.planQuarterRetention_(['2029T1', '2029T2', '2029T3'], bad, '', '2029T3');
    assert.strictEqual(plan.visible.length, 2, '保留數 ' + JSON.stringify(bad) + ' 應該退回 2');
  });
});

test('重複的季度 ID 只算一次', function () {
  const env = makeEnv({});
  const plan = env.sandbox.planQuarterRetention_(
    ['2029T1', '2029T1', '2029T2', '2029T2', '2029T3'], 2, '', '2029T3');
  assert.strictEqual(plan.visible.length + plan.toArchive.length, 3);
});

// =====================================================================
// 第 2 組：可見清單與空白提示
// =====================================================================

console.log('\n第 2 組：季度下拉');

test('已封存的季度預設不顯示', function () {
  const env = makeEnv({});
  const list = env.sandbox.visibleQuarterList_(
    ['2029T1', '2029T2'], { '2029T1': true, '2029T2': false }, false, '');
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].quarterId, '2029T2');
});

test('勾「顯示已封存」→ 全部列出，而且已封存那些帶標記', function () {
  const env = makeEnv({});
  const list = env.sandbox.visibleQuarterList_(
    ['2029T1', '2029T2'], { '2029T1': true, '2029T2': false }, true, '');
  assert.strictEqual(list.length, 2);
  const archived = list.filter(function (q) { return q.archived === true; });
  assert.strictEqual(archived.length, 1);
  assert.strictEqual(archived[0].quarterId, '2029T1');
});

test('沙盒季度永不出現——勾了「顯示已封存」都不會', function () {
  const env = makeEnv({});
  [false, true].forEach(function (includeArchived) {
    const list = env.sandbox.visibleQuarterList_(
      ['2029T1', SANDBOX_QUARTER], {}, includeArchived, SANDBOX_QUARTER);
    assert.strictEqual(
      list.filter(function (q) { return q.quarterId === SANDBOX_QUARTER; }).length, 0,
      'includeArchived=' + includeArchived + ' 時沙盒季度仍然出現了');
  });
});

test('全部封存 → 可見清單是空的，但提示語存在而且講得出下一步', function () {
  // ⚠️ 這是這條功能最大的風險：「十月回來打開系統見到一片空白」。
  const env = makeEnv({});
  const list = env.sandbox.visibleQuarterList_(
    ['2029T1', '2029T2'], { '2029T1': true, '2029T2': true }, false, '');
  assert.strictEqual(list.length, 0);

  const hint = env.sandbox.RETENTION_EMPTY_HINT_;
  assert.ok(hint, '一定要有提示語');
  assert.ok(hint.indexOf('顯示已封存') !== -1, '要講得出下一步：' + hint);
  assert.ok(hint.indexOf('建立新一季') !== -1, '要講得出另一條路：' + hint);
});

test('listWeeksForWebApp_：預設不含已封存的季度，emptyHint 只在真的空時出現', function () {
  const env = makeEnv({
    weekRowSpecs: [
      { isoDate: '2029-01-07', quarterId: '2029T1', fields: { ARCHIVED: true } },
      { isoDate: '2029-04-01', quarterId: '2029T2' }
    ]
  });
  const data = env.sandbox.listWeeksForWebApp_(false);
  assert.strictEqual(data.quarters.length, 1);
  assert.strictEqual(data.quarters[0].quarterId, '2029T2');
  assert.strictEqual(data.archivedQuarterCount, 1);
  assert.strictEqual(data.emptyHint, '', '仲有一季可見，不應該出提示');

  const withArchived = env.sandbox.listWeeksForWebApp_(true);
  assert.strictEqual(withArchived.quarters.length, 2);
  const archivedGroup = withArchived.quarters.filter(function (g) { return g.archived === true; })[0];
  assert.ok(archivedGroup, '要有一季標記為已封存');
  assert.ok(archivedGroup.label.indexOf('已封存') !== -1,
    '下拉裏面要睇得出邊一季封存咗：' + archivedGroup.label);
});

test('listWeeksForWebApp_：全部封存 → emptyHint 有值', function () {
  const env = makeEnv({
    weekRowSpecs: [{ isoDate: '2029-01-07', quarterId: '2029T1', fields: { ARCHIVED: true } }]
  });
  const data = env.sandbox.listWeeksForWebApp_(false);
  assert.strictEqual(data.quarters.length, 0);
  assert.ok(data.emptyHint, '一個可見季度都沒有時一定要有提示');
});

test('一季之內有一行未封存 → 整季當成未封存（睇得到才修得到）', function () {
  const env = makeEnv({
    weekRowSpecs: [
      { isoDate: '2029-01-07', quarterId: '2029T1', fields: { ARCHIVED: true } },
      { isoDate: '2029-01-14', quarterId: '2029T1' }
    ]
  });
  const rows = env.sandbox.readSheet_(env.sandbox.SHEETS.BULLETIN_WEEKS);
  const flags = env.sandbox.quarterArchivedFlags_(rows);
  assert.strictEqual(flags['2029T1'], false,
    '一半封存一半沒有，代表中途出過事——應該照樣顯示，不是靜靜收起');
});

// =====================================================================
// 第 3b 組：R-035 修正——按「今日所在季度」封存，不按季度編號排名（2026-11-17）
// =====================================================================

console.log('\n第 3b 組：按今日所在季度封存');

const QUARTERS_1117 = ['2026T3', '2026T4', '2027T1', '2027T4', '2028T2', '2028T3', '2028T4', '2030T2', '2030T1'];

test('R-035 修正 1：今日 2026-11-17，N＝4 與 N＝2 → 一季都不封存（未來的測試季度不擠走今季）', function () {
  const env = makeEnv({});
  const current = env.sandbox.retentionCurrentQuarter_('2026-11-17');
  assert.strictEqual(current.quarterId, '2026T4');
  [4, 2].forEach(function (n) {
    const plan = env.sandbox.planQuarterRetention_(QUARTERS_1117, n, SANDBOX_QUARTER, current.quarterId);
    assert.strictEqual(JSON.stringify(arr(plan.toArchive)), '[]', 'N=' + n + ' 實際：' + JSON.stringify(arr(plan.toArchive)));
    assert.strictEqual(plan.reason, '');
  });
});

test('R-035 修正 2：今日 2027-01-05，N＝2 → 只封存 2026T3', function () {
  const env = makeEnv({});
  const current = env.sandbox.retentionCurrentQuarter_('2027-01-05');
  assert.strictEqual(current.quarterId, '2027T1');
  const plan = env.sandbox.planQuarterRetention_(QUARTERS_1117, 2, SANDBOX_QUARTER, current.quarterId);
  assert.strictEqual(JSON.stringify(arr(plan.toArchive)), JSON.stringify(['2026T3']));
  assert.strictEqual(plan.oldestVisibleQuarterId, '2026T4');
});

test('R-035 修正 3：今日 2027-07-06，N＝2 → 2026T3、2026T4、2027T1；未來季度一個都不在內', function () {
  const env = makeEnv({});
  const current = env.sandbox.retentionCurrentQuarter_('2027-07-06');
  assert.strictEqual(current.quarterId, '2027T3');
  const plan = env.sandbox.planQuarterRetention_(QUARTERS_1117, 2, SANDBOX_QUARTER, current.quarterId);
  assert.strictEqual(JSON.stringify(arr(plan.toArchive).sort()), JSON.stringify(['2026T3', '2026T4', '2027T1']));
  ['2027T4', '2028T2', '2028T3', '2028T4', '2030T2'].forEach(function (q) {
    assert.strictEqual(plan.toArchive.indexOf(q), -1, '未來季度 ' + q + ' 不可以被封存');
    assert.notStrictEqual(plan.visible.indexOf(q), -1, '未來季度 ' + q + ' 仍然可見');
  });
});

test('R-035 修正 3b：今日所在季度本身永遠不封存（N 再細亦然）', function () {
  const env = makeEnv({});
  const plan = env.sandbox.planQuarterRetention_(['2026T3', '2026T4', '2027T1'], 1, '', '2026T4');
  assert.strictEqual(plan.toArchive.indexOf('2026T4'), -1);
  assert.strictEqual(plan.toArchive.indexOf('2027T1'), -1);
  assert.strictEqual(JSON.stringify(arr(plan.toArchive)), JSON.stringify(['2026T3']));
});

test('R-035 修正 5：今日所在季度空白或格式不合 → 一季都不封存，結果有 reason（不退回舊的排名做法）', function () {
  const env = makeEnv({});
  ['', undefined, null, '2026-11-17', '2026T5', 'abc'].forEach(function (bad) {
    const plan = env.sandbox.planQuarterRetention_(QUARTERS_1117, 2, SANDBOX_QUARTER, bad);
    assert.strictEqual(plan.toArchive.length, 0, JSON.stringify(bad) + ' 時不可以封存任何一季');
    assert.ok(plan.reason, JSON.stringify(bad) + ' 時一定要有 reason');
  });
  const unreadable = env.sandbox.retentionCurrentQuarter_('不是日期');
  assert.strictEqual(unreadable.quarterId, '');
  assert.ok(unreadable.reason);
});

test('R-035 修正 5b：runQuarterRetention_() 算不出今日所在季度 → ok:false、reason、一季都沒封存', function () {
  const env = makeEnv({
    weekRowSpecs: [{ isoDate: '2020-01-05', quarterId: '2020T1' }, { isoDate: '2020-04-05', quarterId: '2020T2' },
      { isoDate: '2020-07-05', quarterId: '2020T3' }]
  });
  const result = env.sandbox.runQuarterRetention_({ todayIso: '不是日期' });
  assert.strictEqual(result.ok, false);
  assert.ok(result.reason);
  assert.strictEqual(result.archived.length, 0);
  assert.ok(result.message.indexOf('一季都沒有封存') !== -1, result.message);
  env.sandbox.readSheet_(env.sandbox.SHEETS.BULLETIN_WEEKS).forEach(function (r) {
    assert.notStrictEqual(r.ARCHIVED, true);
  });
});

test('R-035 修正 6：runQuarterRetention_() 的報告與摘要講明今日所在季度與保留範圍', function () {
  const env = makeEnv({
    weekRowSpecs: [{ isoDate: '2026-07-05', quarterId: '2026T3', fields: { SERMON_TITLE: 'x' } },
      { isoDate: '2026-11-22', quarterId: '2026T4' }]
  });
  const result = env.sandbox.runQuarterRetention_({ todayIso: '2026-11-17' });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.currentQuarterId, '2026T4');
  assert.ok(result.message.indexOf('今日所在季度是 2026T4，保留 2026T4 連之前共 2 季') !== -1, result.message);
  assert.ok(result.lines.join('\n').indexOf('今日所在季度：2026T4') !== -1);
});

test('R-035 修正 4：由 weeklyBulletinSendTrigger_() 入口——全空白的今季＋三個未來測試季度，今季不被封存、沒有 RETENTION_NEEDS_CONFIRMATION', function () {
  // 2026-11-17（星期二）：今日所在季度 2026T4，上線季 2027T1 還未開始。
  const env = makeEnv({
    todayIso: '2026-11-17',
    weekRowSpecs: [
      { isoDate: '2026-11-22', quarterId: '2026T4' },                                   // 全空白的今季
      { isoDate: '2028-04-02', quarterId: '2028T2', fields: { SERMON_TITLE: '測試講題' } },
      { isoDate: '2028-07-02', quarterId: '2028T3', fields: { SERMON_TITLE: '測試講題' } },
      { isoDate: '2028-10-01', quarterId: '2028T4' }
    ]
  });
  env.sandbox.weeklyBulletinSendTrigger_();

  env.sandbox.readSheet_(env.sandbox.SHEETS.BULLETIN_WEEKS).forEach(function (r) {
    assert.notStrictEqual(r.ARCHIVED, true, String(r.QUARTER_ID) + ' 不可以被封存');
  });
  const codes = env.sandbox.readSheet_(env.sandbox.SHEETS.ERROR_LOG).map(function (r) { return r.ERROR_CODE; });
  assert.strictEqual(codes.indexOf('RETENTION_NEEDS_CONFIRMATION'), -1, '實際 ErrorLog：' + JSON.stringify(codes));
  assert.strictEqual(codes.indexOf('RETENTION_NO_CURRENT_QUARTER'), -1);
});

test('R-035 修正 4b：由觸發器入口——真的有舊季度（比保留範圍更舊、已發佈）→ 封存；今季與未來季度不動', function () {
  const env = makeEnv({
    todayIso: '2027-01-05',
    weekRowSpecs: [
      { isoDate: '2026-07-05', quarterId: '2026T3', fields: { SERMON_TITLE: '舊講題' } },
      { isoDate: '2026-11-22', quarterId: '2026T4' },
      { isoDate: '2027-01-10', quarterId: '2027T1' },
      { isoDate: '2028-04-02', quarterId: '2028T2' }
    ],
    publishRowSpecs: [{ isoDate: '2026-07-05' }]
  });
  env.sandbox.weeklyBulletinSendTrigger_();
  const byQuarter = {};
  env.sandbox.readSheet_(env.sandbox.SHEETS.BULLETIN_WEEKS).forEach(function (r) { byQuarter[r.QUARTER_ID] = r.ARCHIVED === true; });
  assert.strictEqual(JSON.stringify(byQuarter),
    JSON.stringify({ '2026T3': true, '2026T4': false, '2027T1': false, '2028T2': false }));
});

test('R-035 修正 7：算不出今日所在季度時，觸發器要寫 ErrorLog（RETENTION_NO_CURRENT_QUARTER）', function () {
  const env = makeEnv({
    todayIso: '2027-01-05',
    weekRowSpecs: [{ isoDate: '2026-07-05', quarterId: '2026T3' }]
  });
  env.sandbox.retentionCurrentQuarter_ = function () { return { quarterId: '', todayIso: '', reason: '測試：讀不到今日' }; };
  env.sandbox.weeklyBulletinSendTrigger_();
  const codes = env.sandbox.readSheet_(env.sandbox.SHEETS.ERROR_LOG).map(function (r) { return r.ERROR_CODE; });
  assert.notStrictEqual(codes.indexOf('RETENTION_NO_CURRENT_QUARTER'), -1, JSON.stringify(codes));
});

// =====================================================================
// 第 3c 組：R-055 選單「封存指定季度…」
// =====================================================================

console.log('\n第 3c 組：封存指定季度');

/** 造一個會記錄對話框的假 UI：`answers` 依次回答每一個 alert（預設 YES）。 */
function makeFakeUi(quarterAnswer, answers) {
  const alerts = [];
  const queue = (answers || []).slice();
  return {
    alerts: alerts,
    ui: {
      ButtonSet: { OK: 'OK', OK_CANCEL: 'OK_CANCEL', YES_NO: 'YES_NO' },
      Button: { OK: 'OK', CANCEL: 'CANCEL', YES: 'YES', NO: 'NO' },
      prompt: function (title, body) {
        alerts.push({ kind: 'prompt', title: title, body: body });
        return {
          getSelectedButton: function () { return quarterAnswer === null ? 'CANCEL' : 'OK'; },
          getResponseText: function () { return quarterAnswer || ''; }
        };
      },
      alert: function (title, body) {
        alerts.push({ kind: 'alert', title: title, body: body });
        return queue.length > 0 ? queue.shift() : 'YES';
      }
    }
  };
}

function contentSheetRow(env, qid) {
  return env.sandbox.readSheet_(env.sandbox.SHEETS.CONTENT_SHEETS)
    .filter(function (r) { return r.QUARTER_ID === qid; })[0];
}

function archivedFlags(env) {
  const out = {};
  env.sandbox.readSheet_(env.sandbox.SHEETS.BULLETIN_WEEKS).forEach(function (r) { out[r.QUARTER_ID] = r.ARCHIVED === true; });
  return out;
}

const TEST_QUARTER_SPECS = [
  { isoDate: '2028-04-02', quarterId: '2028T2', fields: { SERMON_TITLE: '測試講題' } },
  { isoDate: '2028-04-09', quarterId: '2028T2' },
  { isoDate: '2026-11-22', quarterId: '2026T4' }
];
const TEST_CONTENT_SPECS = [
  { QUARTER_ID: '2028T2', FILE_ID: 'FILE_2028T2', FILE_URL: 'https://example.invalid/2028T2', ACTIVE: true },
  { QUARTER_ID: '2026T4', FILE_ID: 'FILE_2026T4', FILE_URL: 'https://example.invalid/2026T4', ACTIVE: true }
];

test('R-055：選單入口——對話框列出主日數、未發佈有內容的主日、內容表會怎樣；按確定才封存，一格都不刪', function () {
  const fake = makeFakeUi('2028T2');
  const env = makeEnv({ todayIso: '2026-11-17', weekRowSpecs: TEST_QUARTER_SPECS, contentSheetSpecs: TEST_CONTENT_SPECS, ui: fake.ui });
  const before = env.sandbox.readSheet_(env.sandbox.SHEETS.BULLETIN_WEEKS).length;

  env.sandbox.menuArchiveQuarter_();

  const confirmText = fake.alerts.filter(function (a) { return a.kind === 'alert'; })[0].body;
  assert.ok(confirmText.indexOf('共 2 個主日') !== -1, confirmText);
  assert.ok(confirmText.indexOf('1 個主日未發佈，但已經有內容') !== -1, confirmText);
  assert.ok(confirmText.indexOf('「有效」會改為 FALSE；檔案不會刪') !== -1, confirmText);
  assert.ok(confirmText.indexOf('一格資料都不會刪') !== -1, confirmText);

  const flags = archivedFlags(env);
  assert.strictEqual(flags['2028T2'], true, '2028T2 要封存（即使有未發佈而且有內容的主日——使用者已經確認）');
  assert.strictEqual(flags['2026T4'], false, '其他季度不動');
  assert.strictEqual(env.sandbox.readSheet_(env.sandbox.SHEETS.BULLETIN_WEEKS).length, before, '一行都不可以刪');
  assert.strictEqual(contentSheetRow(env, '2028T2').ACTIVE, false);
  assert.strictEqual(contentSheetRow(env, '2026T4').ACTIVE, true);
  const audit = env.sandbox.readSheet_(env.sandbox.SHEETS.AUDIT_LOG).filter(function (r) { return r.ACTION === 'ARCHIVE_QUARTER'; });
  assert.strictEqual(audit.length, 1);
  assert.strictEqual(audit[0].ROW_KEY, '2028T2');
});

test('R-055：按「否」→ 一格都沒有寫', function () {
  const fake = makeFakeUi('2028T2', ['NO']);
  const env = makeEnv({ todayIso: '2026-11-17', weekRowSpecs: TEST_QUARTER_SPECS, contentSheetSpecs: TEST_CONTENT_SPECS, ui: fake.ui });
  env.sandbox.menuArchiveQuarter_();
  assert.strictEqual(archivedFlags(env)['2028T2'], false);
  assert.strictEqual(contentSheetRow(env, '2028T2').ACTIVE, true);
  assert.strictEqual(env.sandbox.readSheet_(env.sandbox.SHEETS.AUDIT_LOG).length, 0);
});

test('R-055：取消輸入季度 → 什麼都不做', function () {
  const fake = makeFakeUi(null);
  const env = makeEnv({ weekRowSpecs: TEST_QUARTER_SPECS, contentSheetSpecs: TEST_CONTENT_SPECS, ui: fake.ui });
  env.sandbox.menuArchiveQuarter_();
  assert.strictEqual(fake.alerts.filter(function (a) { return a.kind === 'alert'; }).length, 0);
  assert.strictEqual(archivedFlags(env)['2028T2'], false);
});

test('R-055：沙盒季度拒絕，一格都沒有寫', function () {
  const fake = makeFakeUi(SANDBOX_QUARTER);
  const env = makeEnv({
    weekRowSpecs: [{ isoDate: '2030-01-06', quarterId: SANDBOX_QUARTER, fields: { SERMON_TITLE: 'x' } }],
    ui: fake.ui
  });
  env.sandbox.menuArchiveQuarter_();
  const text = fake.alerts.filter(function (a) { return a.kind === 'alert'; })[0].body;
  assert.ok(text.indexOf('沙盒季度') !== -1 && text.indexOf('不可以封存') !== -1, text);
  assert.strictEqual(archivedFlags(env)[SANDBOX_QUARTER], false);
});

test('R-055：沒有這一季／格式不對 → 只講明，什麼都沒有封存', function () {
  ['2099T1', 'abc'].forEach(function (bad) {
    const fake = makeFakeUi(bad);
    const env = makeEnv({ weekRowSpecs: TEST_QUARTER_SPECS, ui: fake.ui });
    env.sandbox.menuArchiveQuarter_();
    const text = fake.alerts.filter(function (a) { return a.kind === 'alert'; })[0].body;
    assert.ok(text.indexOf('沒有季度「' + bad + '」') !== -1, text);
    assert.strictEqual(JSON.stringify(archivedFlags(env)), JSON.stringify({ '2028T2': false, '2026T4': false }));
  });
});

test('R-055：今日所在季度要再確認一次；第二次答「否」就不封存', function () {
  const fake = makeFakeUi('2026T4', ['YES', 'NO']);
  const env = makeEnv({ todayIso: '2026-11-17', weekRowSpecs: TEST_QUARTER_SPECS, contentSheetSpecs: TEST_CONTENT_SPECS, ui: fake.ui });
  env.sandbox.menuArchiveQuarter_();
  const alertsOnly = fake.alerts.filter(function (a) { return a.kind === 'alert'; });
  assert.strictEqual(alertsOnly.length, 2, '今季要問兩次');
  assert.ok(alertsOnly[1].body.indexOf('今日所在的季度') !== -1, alertsOnly[1].body);
  assert.strictEqual(archivedFlags(env)['2026T4'], false);

  const fake2 = makeFakeUi('2026T4', ['YES', 'YES']);
  const env2 = makeEnv({ todayIso: '2026-11-17', weekRowSpecs: TEST_QUARTER_SPECS, contentSheetSpecs: TEST_CONTENT_SPECS, ui: fake2.ui });
  env2.sandbox.menuArchiveQuarter_();
  assert.strictEqual(archivedFlags(env2)['2026T4'], true);
});

test('R-055：非今季只問一次', function () {
  const fake = makeFakeUi('2028T2');
  const env = makeEnv({ todayIso: '2026-11-17', weekRowSpecs: TEST_QUARTER_SPECS, contentSheetSpecs: TEST_CONTENT_SPECS, ui: fake.ui });
  env.sandbox.menuArchiveQuarter_();
  assert.strictEqual(fake.alerts.filter(function (a) { return a.kind === 'alert' && a.title === '封存指定季度'; }).length, 1);
});

test('R-055：已經全部封存 → 只講一句，不再寫 AuditLog', function () {
  const fake = makeFakeUi('2028T2');
  const env = makeEnv({
    weekRowSpecs: [{ isoDate: '2028-04-02', quarterId: '2028T2', fields: { ARCHIVED: true } }],
    ui: fake.ui
  });
  env.sandbox.menuArchiveQuarter_();
  assert.ok(fake.alerts.filter(function (a) { return a.kind === 'alert'; })[0].body.indexOf('早已封存') !== -1);
  assert.strictEqual(env.sandbox.readSheet_(env.sandbox.SHEETS.AUDIT_LOG).length, 0);
});

test('R-055：封存之後 runContentAutoSync_() 不再處理這一季；取消封存完整還原，自動同步又處理它', function () {
  const fake = makeFakeUi('2028T2');
  const env = makeEnv({ todayIso: '2026-11-17', weekRowSpecs: TEST_QUARTER_SPECS, contentSheetSpecs: TEST_CONTENT_SPECS, ui: fake.ui });
  const quartersOf = function () {
    return env.sandbox.runContentAutoSync_({ todayIso: '2026-11-17' }).quarters.map(function (q) { return q.quarterId; });
  };
  assert.notStrictEqual(quartersOf().indexOf('2028T2'), -1, '前提：封存之前自動同步會處理 2028T2');

  const before = JSON.stringify(env.sandbox.readSheet_(env.sandbox.SHEETS.BULLETIN_WEEKS));
  env.sandbox.menuArchiveQuarter_();
  assert.strictEqual(quartersOf().indexOf('2028T2'), -1, '封存之後不再處理');

  const restored = env.sandbox.unarchiveQuarter_('2028T2');
  assert.strictEqual(restored.ok, true, restored.message);
  assert.notStrictEqual(quartersOf().indexOf('2028T2'), -1, '取消封存之後又處理');
  assert.strictEqual(contentSheetRow(env, '2028T2').ACTIVE, true);
  const afterRows = env.sandbox.readSheet_(env.sandbox.SHEETS.BULLETIN_WEEKS);
  const beforeRows = JSON.parse(before);
  assert.strictEqual(afterRows.length, beforeRows.length);
  afterRows.forEach(function (row, i) {
    Object.keys(beforeRows[i]).forEach(function (key) {
      if (key === 'ARCHIVED') return;
      assert.strictEqual(JSON.stringify(row[key]), JSON.stringify(beforeRows[i][key]), key + ' 被改動');
    });
  });
});

test('R-055：選單已加「封存指定季度…」，排在「取消封存季度」之前', function () {
  const menu = fsNode.readFileSync(path.join(__dirname, '..', 'src', 'Menu.gs'), 'utf8');
  const a = menu.indexOf("'封存指定季度…', 'menuArchiveQuarter_'");
  const b = menu.indexOf("'取消封存季度（完全還原）', 'menuUnarchiveQuarter_'");
  assert.ok(a !== -1 && b !== -1 && a < b);
});

// =====================================================================
// 第 3 組：封存與取消封存
// =====================================================================

console.log('\n第 3 組：封存與取消封存');

test('封存的季度資料一格未刪，取消封存之後完全還原', function () {
  // ⚠️ 這是整條功能唯一一條真正要緊的規則。
  const env = makeEnv({
    weekRowSpecs: [
      { isoDate: '2029-01-07', quarterId: '2029T1', fields: { SERMON_TITLE: '重要的講題', CALL_REF: '詩篇一百篇' } }
    ],
    publishRowSpecs: [{ isoDate: '2029-01-07' }]     // 已發佈，所以不會被 blocker 攔住
  });

  const before = JSON.stringify(env.sandbox.readSheet_(env.sandbox.SHEETS.BULLETIN_WEEKS));

  const archived = env.sandbox.archiveQuarter_('2029T1', {});
  assert.strictEqual(archived.ok, true, archived.message);
  assert.strictEqual(archived.weekRows, 1);

  const afterArchive = env.sandbox.readSheet_(env.sandbox.SHEETS.BULLETIN_WEEKS);
  assert.strictEqual(afterArchive.length, 1, '⚠️ 一行都不可以刪');
  assert.strictEqual(afterArchive[0].ARCHIVED, true);
  assert.strictEqual(String(afterArchive[0].SERMON_TITLE), '重要的講題', '內容一格都不可以動');
  assert.strictEqual(String(afterArchive[0].CALL_REF), '詩篇一百篇');

  const restored = env.sandbox.unarchiveQuarter_('2029T1');
  assert.strictEqual(restored.ok, true, restored.message);
  const afterRestore = env.sandbox.readSheet_(env.sandbox.SHEETS.BULLETIN_WEEKS);
  assert.strictEqual(afterRestore[0].ARCHIVED, false);

  // ⚠️ 逐欄比對，只放行 ARCHIVED 一欄。用整行字串化去比的話，要靠一個
  //    脆弱的字串替換去抵銷「空白 → false」的差異，那種比較一改欄位就壞。
  const beforeRow = JSON.parse(before)[0];
  Object.keys(beforeRow).forEach(function (key) {
    if (key === 'ARCHIVED') return;
    assert.strictEqual(JSON.stringify(afterRestore[0][key]), JSON.stringify(beforeRow[key]),
      '欄位 ' + key + ' 在封存／取消封存之後被改動了');
  });
});

test('沙盒季度直接叫 archiveQuarter_ → 拋錯，不是靜靜略過', function () {
  // ⚠️ 靜靜略過會令呼叫方以為封存成功了。
  const env = makeEnv({});
  let code = '';
  try {
    env.sandbox.archiveQuarter_(SANDBOX_QUARTER, {});
  } catch (err) {
    code = (err && err.code) || '';
  }
  assert.strictEqual(code, 'SANDBOX_QUARTER');
});

test('有未發佈而且有內容的主日 → 不封存，而且列出是邊幾個', function () {
  const env = makeEnv({
    weekRowSpecs: [
      { isoDate: '2029-01-07', quarterId: '2029T1', fields: { SERMON_TITLE: '仲填緊' } }
    ]
  });
  const result = env.sandbox.archiveQuarter_('2029T1', {});
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'HAS_UNPUBLISHED_WORK');
  assert.strictEqual(result.blockers.length, 1);
  assert.strictEqual(result.blockers[0].isoDate, '2029-01-07');
  // 而且真的沒有動過那一行。
  const rows = env.sandbox.readSheet_(env.sandbox.SHEETS.BULLETIN_WEEKS);
  assert.notStrictEqual(rows[0].ARCHIVED, true, '被攔住就一格都不應該寫');
});

test('force:true → 照樣封存，而且 AuditLog 講明使用者確認過', function () {
  const env = makeEnv({
    weekRowSpecs: [
      { isoDate: '2029-01-07', quarterId: '2029T1', fields: { SERMON_TITLE: '仲填緊' } }
    ]
  });
  const result = env.sandbox.archiveQuarter_('2029T1', { force: true });
  assert.strictEqual(result.ok, true, result.message);

  const audit = env.sandbox.readSheet_(env.sandbox.SHEETS.AUDIT_LOG)
    .filter(function (a) { return String(a.ACTION) === 'ARCHIVE_QUARTER'; });
  assert.strictEqual(audit.length, 1);
  assert.ok(String(audit[0].NOTES).indexOf('用戶已確認') !== -1,
    '要記低係人手確認過先封存：' + audit[0].NOTES);
});

test('已發佈的主日不算 blocker（那一季做完了）', function () {
  const env = makeEnv({
    weekRowSpecs: [
      { isoDate: '2029-01-07', quarterId: '2029T1', fields: { SERMON_TITLE: '已經出咗' } }
    ],
    publishRowSpecs: [{ isoDate: '2029-01-07' }]
  });
  assert.strictEqual(env.sandbox.findUnpublishedWorkInQuarter_('2029T1').length, 0);
});

test('自測的發佈紀錄不算「已發佈」（那一期沒有寄給會眾）', function () {
  const env = makeEnv({
    weekRowSpecs: [
      { isoDate: '2029-01-07', quarterId: '2029T1', fields: { SERMON_TITLE: '仲填緊' } }
    ],
    publishRowSpecs: [{ isoDate: '2029-01-07', isSelfTest: true }]
  });
  assert.strictEqual(env.sandbox.findUnpublishedWorkInQuarter_('2029T1').length, 1,
    '自測的發佈不可以令一個仍然在做的主日看起來像做完了');
});

test('完全空白的主日不算 blocker（未填的一季可以直接收起）', function () {
  const env = makeEnv({
    weekRowSpecs: [{ isoDate: '2029-01-07', quarterId: '2029T1' }]
  });
  assert.strictEqual(env.sandbox.findUnpublishedWorkInQuarter_('2029T1').length, 0);
});

test('封存不會碰 Diagnostics／PublishLog／AuditLog／SendLog 的既有內容', function () {
  const env = makeEnv({
    weekRowSpecs: [{ isoDate: '2029-01-07', quarterId: '2029T1' }],
    publishRowSpecs: [{ isoDate: '2029-01-07' }]
  });
  const S = env.sandbox.SHEETS;
  const before = {
    diagnostics: env.sandbox.readSheet_(S.DIAGNOSTICS).length,
    publishLog: env.sandbox.readSheet_(S.PUBLISH_LOG).length,
    sendLog: env.sandbox.readSheet_(S.SEND_LOG).length
  };

  env.sandbox.archiveQuarter_('2029T1', {});

  assert.strictEqual(env.sandbox.readSheet_(S.DIAGNOSTICS).length, before.diagnostics);
  assert.strictEqual(env.sandbox.readSheet_(S.PUBLISH_LOG).length, before.publishLog);
  assert.strictEqual(env.sandbox.readSheet_(S.SEND_LOG).length, before.sendLog);
  // AuditLog 一定會多一筆（封存本身要記帳），但**只可以多**，不可以少。
  assert.ok(env.sandbox.readSheet_(S.AUDIT_LOG).length >= 1, 'AuditLog 應該多一筆封存紀錄');
});

test('⚠️ 靜態檢查：Retention.gs 沒有任何刪除操作', function () {
  // ⚠️ 這一條比行為測試更徹底：它連「將來有人加一行 deleteRow」都攔得住。
  //    封存的整條規則就是「一格資料都不刪」。
  const src = fsNode.readFileSync(path.join(__dirname, '..', 'src', 'Retention.gs'), 'utf8');
  const forbidden = ['deleteRow', 'deleteRows', 'deleteSheet', 'deleteColumn',
    'clearContent', 'clear(', 'removeSheet', 'setTrashed'];
  const found = [];
  src.split(/\r?\n/).forEach(function (line, i) {
    const trimmed = line.trim();
    if (trimmed.indexOf('*') === 0 || trimmed.indexOf('//') === 0) return;   // 註解不算
    forbidden.forEach(function (bad) {
      if (line.indexOf(bad) !== -1) found.push('第 ' + (i + 1) + ' 行：' + bad);
    });
  });
  assert.strictEqual(found.length, 0, '封存絕對不可以刪任何東西，實際：' + found.join('、'));
});

test('⚠️ 靜態檢查：Retention.gs 沒有碰那四張紀錄表', function () {
  const src = fsNode.readFileSync(path.join(__dirname, '..', 'src', 'Retention.gs'), 'utf8');
  const forbidden = ['SHEETS.DIAGNOSTICS', 'SHEETS.SEND_LOG', 'SHEETS.ERROR_LOG'];
  const found = [];
  src.split(/\r?\n/).forEach(function (line, i) {
    const trimmed = line.trim();
    if (trimmed.indexOf('*') === 0 || trimmed.indexOf('//') === 0) return;
    forbidden.forEach(function (bad) {
      if (line.indexOf(bad) !== -1) found.push('第 ' + (i + 1) + ' 行：' + bad);
    });
  });
  assert.strictEqual(found.length, 0,
    '那四張是紀錄，封存它們等於把稽核軌跡藏起來，實際：' + found.join('、'));
  // PublishLog 只准**讀**（findUnpublishedWorkInQuarter_ 要知道邊個發佈咗），
  // 不准寫。
  assert.strictEqual(src.indexOf('writeSheet_(SHEETS.PUBLISH_LOG'), -1);
});

// =====================================================================
// 第 4 組：R-037 上線前檢查
// =====================================================================

console.log('\n第 4 組：上線前檢查（八項）');

function goLiveItem(env, keyword) {
  return env.sandbox.buildGoLiveChecklist_().filter(function (i) {
    return String(i.label).indexOf(keyword) !== -1;
  })[0];
}

// 內容表 v2：第 4 項之後加了「上線前：其他觸發器」（Config 人手改動稽核＝1、兩個已停用的＝0，
// 預期清單在 src/TriggerInventory.gs），最後加了「上線前：內容表版本」（審查 F8），所以由九項變十一項。
// v3 再加「上線前：自動建立季度」（部署之後、開啟填寫介面之前，先看會自動建立哪幾季）與
// 「上線前：模擬今日（測試設定）」，共十三項。
test('十七項齊備，一項都不可以少（第九項是階段 3 的講員表格；內容表 v2 加了「其他觸發器」「內容表版本」；v3 加了「自動建立季度」「模擬今日」；R-058 加了寄送名單、測試名單、測試季度、時區一致）', function () {
  const env = makeEnv({});
  const items = env.sandbox.buildGoLiveChecklist_();
  assert.strictEqual(items.length, 17, '實際：' + items.map(function (i) { return i.label; }).join('、'));
  assert.ok(items.some(function (i) { return i.label === '上線前：模擬今日（測試設定）'; }));
  assert.ok(items.some(function (i) { return i.label === '上線前：其他觸發器'; }));
  assert.ok(items.some(function (i) { return i.label === '上線前：內容表版本'; }));
  assert.ok(items.some(function (i) { return i.label === '上線前：自動建立季度'; }));
  items.forEach(function (i) {
    assert.ok(i.label && i.status && i.message, '每一項都要有標題、燈色、說明：' + JSON.stringify(i));
  });
});

test('1. Recipients 缺 IT → 🟡 並講出缺邊一組', function () {
  const env = makeEnv({});
  env.sandbox.writeSheet_(env.sandbox.SHEETS.RECIPIENTS, [
    { GROUP_NAME: 'CC', NAME: '甲', EMAIL: 'cc@example.org', ACTIVE: true },
    { GROUP_NAME: 'DB', NAME: '乙', EMAIL: 'db@example.org', ACTIVE: true }
  ]);
  const item = goLiveItem(env, 'Recipients');
  assert.strictEqual(item.status, env.sandbox.SELF_CHECK_STATUS_.YELLOW);
  assert.ok(item.message.indexOf('IT') !== -1, item.message);
});

test('1. 三組齊備 → 🟢', function () {
  const env = makeEnv({});
  env.sandbox.writeSheet_(env.sandbox.SHEETS.RECIPIENTS, [
    { GROUP_NAME: 'CC', NAME: '甲', EMAIL: 'cc@example.org', ACTIVE: true },
    { GROUP_NAME: 'DB', NAME: '乙', EMAIL: 'db@example.org', ACTIVE: true },
    { GROUP_NAME: 'IT', NAME: '丙', EMAIL: 'it@example.org', ACTIVE: true }
  ]);
  assert.strictEqual(goLiveItem(env, 'Recipients').status, env.sandbox.SELF_CHECK_STATUS_.GREEN);
});

test('2. DRY_RUN=TRUE → 🟡「測試模式」；FALSE → 🟢「正式模式」', function () {
  const S = boot.SELF_CHECK_STATUS_;
  const dry = makeEnv({ config: { DRY_RUN: 'TRUE' } });
  const item1 = goLiveItem(dry, '寄送模式');
  assert.strictEqual(item1.status, S.YELLOW);
  assert.ok(item1.message.indexOf('測試模式') !== -1, item1.message);

  const live = makeEnv({ config: { DRY_RUN: 'FALSE' } });
  const item2 = goLiveItem(live, '寄送模式');
  assert.strictEqual(item2.status, S.GREEN);
  assert.ok(item2.message.indexOf('正式模式') !== -1, item2.message);
});

test('3. PREVIEW_WEBAPP_URL 空白 → 🟡，講明觸發器情境取不到', function () {
  const env = makeEnv({ config: { PREVIEW_WEBAPP_URL: '' } });
  const item = goLiveItem(env, '草稿預覽網址');
  assert.strictEqual(item.status, env.sandbox.SELF_CHECK_STATUS_.YELLOW);
  assert.ok(item.message.indexOf('觸發器') !== -1, item.message);

  const filled = makeEnv({ config: { PREVIEW_WEBAPP_URL: 'https://example.org/exec' } });
  assert.strictEqual(goLiveItem(filled, '草稿預覽網址').status, boot.SELF_CHECK_STATUS_.GREEN);
});

test('4. 星期一觸發器：0 個 🟡、1 個 🟢、2 個 🔴', function () {
  const S = boot.SELF_CHECK_STATUS_;
  const none = makeEnv({ triggers: [] });
  assert.strictEqual(goLiveItem(none, '星期一觸發器').status, S.YELLOW);

  const one = makeEnv({ triggers: ['weeklyBulletinSendTrigger_'] });
  assert.strictEqual(goLiveItem(one, '星期一觸發器').status, S.GREEN);

  const two = makeEnv({ triggers: ['weeklyBulletinSendTrigger_', 'weeklyBulletinSendTrigger_'] });
  const item = goLiveItem(two, '星期一觸發器');
  assert.strictEqual(item.status, S.RED, '兩個觸發器＝同一期寄兩次給全教會');
  assert.ok(item.message.indexOf('2 次') !== -1, '要講明後果：' + item.message);
});

test('4. 其他觸發器不算（只數 weeklyBulletinSendTrigger_）', function () {
  const env = makeEnv({ triggers: ['onFillGridEdit_', 'weeklyBulletinSendTrigger_'] });
  assert.strictEqual(goLiveItem(env, '星期一觸發器').status, boot.SELF_CHECK_STATUS_.GREEN);
});

test('5. 兩個 master ID 相同 → 🔴', function () {
  const env = makeEnv({
    config: { PUBLISHED_PDF_FILE_ID: 'SAME_FAKE_ID', SELFTEST_MASTER_PDF_FILE_ID: 'SAME_FAKE_ID' }
  });
  assert.strictEqual(goLiveItem(env, 'master 檔案').status, env.sandbox.SELF_CHECK_STATUS_.RED);
});

test('6. ErrorLog 最近 7 日有錯 → 🟡，並講出最新一筆', function () {
  const env = makeEnv({});
  const now = new Date();
  env.sandbox.writeSheet_(env.sandbox.SHEETS.ERROR_LOG, [{
    TIMESTAMP: env.sandbox.__mkDate(now.getFullYear(), now.getMonth(), now.getDate()),
    SOURCE: 'MENU', FUNCTION_NAME: 'test', ERROR_CODE: 'TEST_CODE',
    MESSAGE: '測試錯誤訊息', DETAIL: ''
  }]);
  const item = goLiveItem(env, '最近 7 日的錯誤');
  assert.strictEqual(item.status, env.sandbox.SELF_CHECK_STATUS_.YELLOW);
  assert.ok(item.message.indexOf('TEST_CODE') !== -1, '要講出最新一筆：' + item.message);
});

test('6. 沒有錯誤 → 🟢', function () {
  const env = makeEnv({});
  assert.strictEqual(goLiveItem(env, '最近 7 日的錯誤').status, boot.SELF_CHECK_STATUS_.GREEN);
});

test('6. 舊過 7 日的錯誤不算', function () {
  const env = makeEnv({});
  const old = new Date(new Date().getTime() - (30 * 24 * 60 * 60 * 1000));
  env.sandbox.writeSheet_(env.sandbox.SHEETS.ERROR_LOG, [{
    TIMESTAMP: env.sandbox.__mkDate(old.getFullYear(), old.getMonth(), old.getDate()),
    SOURCE: 'MENU', FUNCTION_NAME: 'test', ERROR_CODE: 'OLD', MESSAGE: '舊錯誤', DETAIL: ''
  }]);
  assert.strictEqual(goLiveItem(env, '最近 7 日的錯誤').status, boot.SELF_CHECK_STATUS_.GREEN);
});

test('8. 沙盒季度不在使用者可見範圍 → 🟢', function () {
  const env = makeEnv({
    weekRowSpecs: [
      { isoDate: '2029-01-07', quarterId: '2029T1' },
      { isoDate: '2030-01-06', quarterId: SANDBOX_QUARTER }
    ]
  });
  const item = goLiveItem(env, '沙盒季度');
  assert.strictEqual(item.status, env.sandbox.SELF_CHECK_STATUS_.GREEN, item.message);
});

// =====================================================================
// 第 5 組：R-037 正式報表排除自測資料
// =====================================================================

console.log('\n第 5 組：正式報表排除自測資料');

test('readOfficialPublishLogRows_：自測的行一行都不會回', function () {
  const env = makeEnv({
    publishRowSpecs: [
      { isoDate: '2027-11-07', isSelfTest: false },
      { isoDate: '2030-01-06', isSelfTest: true }
    ]
  });
  const rows = env.sandbox.readOfficialPublishLogRows_();
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(env.sandbox.publishRowIsoDate_(rows[0]), '2027-11-07');
});

test('IS_SELFTEST 空白當成「不是自測」（舊資料那一欄可能是空的）', function () {
  const env = makeEnv({});
  env.sandbox.writeSheet_(env.sandbox.SHEETS.PUBLISH_LOG, [{
    SERVICE_DATE: env.sandbox.__mkDate(2027, 10, 7), VERSION_NO: 1,
    PUBLISHED_AT: env.sandbox.__mkDate(2027, 10, 7), PUBLISHED_BY: 'x',
    MASTER_FILE_ID: 'FAKE'
  }]);
  assert.strictEqual(env.sandbox.readOfficialPublishLogRows_().length, 1);
});

test('自我檢測「最近一次發佈」不會指住沙盒那一期', function () {
  const env = makeEnv({
    publishRowSpecs: [
      { isoDate: '2027-11-07', isSelfTest: false, versionNo: 3 },
      // 沙盒那一行比較新——不排除的話會變成「最近一次發佈」。
      { isoDate: '2030-01-06', isSelfTest: true, versionNo: 9 }
    ]
  });
  const summary = env.sandbox.runSelfCheck_();
  const item = summary.items.filter(function (i) {
    return String(i.label).indexOf('最近一次發佈') !== -1;
  })[0];
  assert.ok(item, '應該有這一項');
  assert.ok(item.message.indexOf('2027-11-07') !== -1, item.message);
  assert.strictEqual(item.message.indexOf('2030-01-06'), -1,
    '⚠️ 沙盒那一期不應該出現在正式報表：' + item.message);
});

test('⚠️ 靜態檢查：正式報表那三處都經 readOfficialPublishLogRows_', function () {
  // ⚠️ 逐處點名。將來有人加一個「直接 readSheet_(PUBLISH_LOG)」的正式報表，
  //    這一條攔不到，但至少釘住現有那三處不會被改回去。
  //
  // ⚠️ 本來這一條連**版本號**都一併釘住，那是錯的——版本號問的是另一條
  //    問題（「這一行會不會跟我撞」），不是「這是不是正式紀錄」。
  //    照搬的後果見 docs/已知bug類型.md 事故四十六，下一條就是釘住它。
  const pub = fsNode.readFileSync(path.join(__dirname, '..', 'src', 'Publish.gs'), 'utf8');
  const check = fsNode.readFileSync(path.join(__dirname, '..', 'src', 'SelfCheck.gs'), 'utf8');

  assert.ok(pub.indexOf('var rows = readOfficialPublishLogRows_();') !== -1,
    '頂部狀態列要經共用那一支');
  assert.ok(pub.indexOf('latestPublishLogRow_(readOfficialPublishLogRows_())') !== -1,
    '發佈前檢查要經共用那一支');
  assert.ok(check.indexOf('var publishRows = readOfficialPublishLogRows_();') !== -1,
    '自我檢測「最近一次發佈」要經共用那一支');
});

test('⚠️ 靜態檢查：版本號**不可以**用正式報表那一支（事故四十六）', function () {
  const pub = fsNode.readFileSync(path.join(__dirname, '..', 'src', 'Publish.gs'), 'utf8');

  assert.ok(pub.indexOf('nextPublishVersion_(readOfficialPublishLogRows_()') === -1,
    '版本號用正式濾網的話，自測發佈每次都算第 1 版，寫出兩行同樣的版本號');
  assert.ok(pub.indexOf('publishLogRowsOfKind_(readSheet_(SHEETS.PUBLISH_LOG), isSelfTestRun)') !== -1,
    '版本號要在同一類的行裏面數：正式的跟正式的比，自測的跟自測的比');
});

// =====================================================================
// 第 6 組：工作表保護與選單改名
// =====================================================================

console.log('\n第 6 組：工作表保護與選單改名');

test('MonkeyState 已納入受保護清單（機器寫的那一張）', function () {
  const names = arr(boot.protectedSheetNames_());
  assert.ok(names.indexOf(boot.SHEETS.MONKEY_STATE) !== -1, 'MonkeyState 應該受保護');
  assert.strictEqual(names.filter(function (n) { return !n; }).length, 0,
    '清單裏面不可以有 undefined（打錯 SHEETS 的鍵就會這樣，而且靜靜地不保護那一張）');
});

test('人手要填的八張**刻意不保護**（保護它們等於弄壞流程）', function () {
  const names = arr(boot.protectedSheetNames_());
  ['ANNOUNCEMENTS', 'PRAYERS', 'FELLOWSHIPS', 'FINANCE',
    'PERSON_DISPLAY', 'HONORIFIC_LOOKUP', 'RECIPIENTS', 'FELLOWSHIP_DEFAULTS'
  ].forEach(function (id) {
    assert.strictEqual(names.indexOf(boot.SHEETS[id]), -1,
      boot.SHEETS[id] + ' 是人手要填的，不可以設成受保護');
  });
});

test('兩個職事表選單的名稱都答到「會不會覆寫」', function () {
  // ⚠️ 「會不會覆寫我填的東西」是幹事最怕的事。名稱一定要答到這條問題。
  const menu = fsNode.readFileSync(path.join(__dirname, '..', 'src', 'Menu.gs'), 'utf8');
  const index = fsNode.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'Index.html'), 'utf8');

  assert.ok(menu.indexOf('補抓空白的事奉欄位（整季，不覆寫已填的）') !== -1,
    '選單那一個要講明「不覆寫已填的」');
  // v3（Ivan 測試結果 A 第 7 項）：頂部「重讀職事表」拿走，改為「本週事奉」框內兩粒：一粒不覆寫、一粒明講覆寫。
  assert.ok(index.indexOf('重新讀取職事表（不覆寫）') !== -1, 'UI 不覆寫那一粒要講明「不覆寫」');
  assert.ok(index.indexOf('以職事表覆寫我的修改…') !== -1, 'UI 覆寫那一粒要講明「覆寫」');
  assert.strictEqual(index.indexOf('重讀職事表（本主日，不覆寫）'), -1, '頂部那一粒已經拿走');
  assert.strictEqual(menu.indexOf('從職事表補抓'), -1, '舊名不應該再出現');
});

test('兩個名稱分得出範圍（一個講「本主日」、一個講「整季」）', function () {
  const menu = fsNode.readFileSync(path.join(__dirname, '..', 'src', 'Menu.gs'), 'utf8');
  const index = fsNode.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'Index.html'), 'utf8');
  assert.ok(menu.indexOf('整季') !== -1, '選單那一個要講明係整季');
  // v3：兩粒在「本週事奉」框內，範圍就是這一個主日；提示亦講明。
  const panel = index.slice(index.indexOf('<section class="panel duty-panel">'), index.indexOf('</section>', index.indexOf('<section class="panel duty-panel">')));
  assert.ok(panel.indexOf('<h2>本週事奉') !== -1 && panel.indexOf('id="fetchFromRosterBtn"') !== -1 && panel.indexOf('id="overwriteFromRosterBtn"') !== -1,
    'UI 那兩粒要在「本週事奉」框內');
  assert.ok(panel.indexOf('這一個主日的職事表') !== -1, 'UI 那一個要講明只係這一個主日');
});

// =====================================================================
// R-058（2026-11-17）：上線前檢查加四項
// =====================================================================

console.log('\nR-058：寄送名單、測試名單、測試季度、時區一致');

const S_ = function (env) { return env.sandbox.SELF_CHECK_STATUS_; };

function recipientRows(list) {
  return list.map(function (r, i) {
    // ⚠️ 先取出成獨立變數：夾在引號之間的 `.name` 會被 tools/scan-staged-secrets.js 誤判成網域（事故六）。
    const personName = r.name || ('人' + (i + 1));
    return { RECIPIENT_ID: 'R' + (i + 1), NAME: personName, EMAIL: r.email, GROUP_NAME: r.group || 'CC', ACTIVE: r.active !== false };
  });
}

test('R-058 a. 寄送名單：名單空白＝不限制 → 🟢', function () {
  const env = makeEnv({ config: { EMAIL_ALLOWLIST: '', DRY_RUN: 'FALSE' } });
  env.sandbox.writeSheet_(env.sandbox.SHEETS.RECIPIENTS, recipientRows([{ email: 'a@example.org' }, { email: 'b@example.org', group: 'DB' }]));
  const item = goLiveItem(env, '寄送名單');
  assert.strictEqual(item.status, S_(env).GREEN, item.message);
  assert.ok(item.message.indexOf('不限制') !== -1);
});

test('R-058 a. 寄送名單：全部在名單內（不分大小寫）→ 🟢', function () {
  const env = makeEnv({ config: { EMAIL_ALLOWLIST: 'A@Example.org, b@example.org', DRY_RUN: 'FALSE' } });
  env.sandbox.writeSheet_(env.sandbox.SHEETS.RECIPIENTS, recipientRows([{ email: 'a@example.org' }, { email: 'B@example.org', group: 'DB' }]));
  assert.strictEqual(goLiveItem(env, '寄送名單').status, S_(env).GREEN);
});

test('R-058 a. 寄送名單：DRY_RUN=FALSE 而有人被擋 → 🔴；DRY_RUN=TRUE 而有人被擋 → 🟡；兩者都列出是誰', function () {
  [['FALSE', 'RED'], ['TRUE', 'YELLOW']].forEach(function (pair) {
    const env = makeEnv({ config: { EMAIL_ALLOWLIST: 'a@example.org', DRY_RUN: pair[0] } });
    env.sandbox.writeSheet_(env.sandbox.SHEETS.RECIPIENTS, recipientRows([{ email: 'a@example.org' }, { email: 'out@example.org', group: 'DB' }]));
    const item = goLiveItem(env, '寄送名單');
    assert.strictEqual(item.status, S_(env)[pair[1]], 'DRY_RUN=' + pair[0] + '：' + item.message);
    assert.ok(item.message.indexOf('out@example.org') !== -1, item.message);
    assert.ok(item.message.indexOf('EMAIL_ALLOWLIST') !== -1);
  });
});

test('R-058 a. 寄送名單：不生效（ACTIVE＝FALSE）的收件人不算被擋', function () {
  const env = makeEnv({ config: { EMAIL_ALLOWLIST: 'a@example.org', DRY_RUN: 'FALSE' } });
  env.sandbox.writeSheet_(env.sandbox.SHEETS.RECIPIENTS, recipientRows([{ email: 'a@example.org' }, { email: 'old@example.org', active: false }]));
  assert.strictEqual(goLiveItem(env, '寄送名單').status, S_(env).GREEN);
});

test('R-058 b. 測試名單：生效行的電郵全部是同一個地址 → 🟡「看來仍是測試名單」；有兩個不同地址 → 🟢', function () {
  const same = makeEnv({});
  same.sandbox.writeSheet_(same.sandbox.SHEETS.RECIPIENTS, recipientRows([
    { email: 'me@example.org', group: 'CC' }, { email: 'ME@example.org', group: 'DB' }, { email: 'me@example.org', group: 'IT' }]));
  const item = goLiveItem(same, '測試名單');
  assert.strictEqual(item.status, S_(same).YELLOW);
  assert.ok(item.message.indexOf('看來仍是測試名單') !== -1, item.message);

  const real = makeEnv({});
  real.sandbox.writeSheet_(real.sandbox.SHEETS.RECIPIENTS, recipientRows([{ email: 'a@example.org' }, { email: 'b@example.org', group: 'DB' }]));
  assert.strictEqual(goLiveItem(real, '測試名單').status, S_(real).GREEN);

  const none = makeEnv({});
  assert.strictEqual(goLiveItem(none, '測試名單').status, S_(none).YELLOW, '一個生效的收件人都沒有也不是正常');
});

test('R-058 c. 測試季度：第一個主日比今日遲超過 LEAD_DAYS＋92 日、未封存 → 🟡 列出；已封存、沙盒、近的季度不列', function () {
  // 今日 2026-11-17、LEAD_DAYS 預設 90 → 2026-11-17 ＋ 182 日＝2027-05-18。
  const env = makeEnv({
    todayIso: '2026-11-17',
    weekRowSpecs: [
      { isoDate: '2026-11-22', quarterId: '2026T4' },
      { isoDate: '2027-01-03', quarterId: '2027T1' },
      { isoDate: '2028-04-02', quarterId: '2028T2' },                                   // 測試季度
      { isoDate: '2028-07-02', quarterId: '2028T3', fields: { ARCHIVED: true } },       // 已封存
      { isoDate: '2030-01-06', quarterId: SANDBOX_QUARTER }                             // 沙盒
    ]
  });
  const item = goLiveItem(env, '測試季度');
  assert.strictEqual(item.status, S_(env).YELLOW, item.message);
  assert.ok(item.message.indexOf('2028T2（2028-04-02）') !== -1, item.message);
  assert.ok(item.message.indexOf('封存指定季度…') !== -1, item.message);
  ['2026T4', '2027T1', '2028T3', SANDBOX_QUARTER].forEach(function (q) {
    assert.strictEqual(item.message.indexOf(q), -1, q + ' 不應該被列出：' + item.message);
  });
});

test('R-058 c. 測試季度：LEAD_DAYS＝0（不限）時用 92 日；沒有測試季度 → 🟢；邊界剛好不算', function () {
  const env = makeEnv({
    todayIso: '2026-11-17', config: { AUTO_CREATE_QUARTERS_LEAD_DAYS: '0' },
    weekRowSpecs: [{ isoDate: '2027-02-14', quarterId: '2027T1' }, { isoDate: '2027-02-21', quarterId: '2027T1' }]
  });
  // 2026-11-17 ＋ 92 日＝2027-02-17；第一個主日 2027-02-14 沒有遲過，不算。
  assert.strictEqual(goLiveItem(env, '測試季度').status, S_(env).GREEN);

  const later = makeEnv({
    todayIso: '2026-11-17', config: { AUTO_CREATE_QUARTERS_LEAD_DAYS: '0' },
    weekRowSpecs: [{ isoDate: '2027-02-21', quarterId: '2027T1' }]
  });
  assert.strictEqual(goLiveItem(later, '測試季度').status, S_(later).YELLOW);
});

test('R-058 d. 時區一致：三者相同 → 🟢；任何一個不同 → 🔴 並列出三個值；讀不到 → 🟡', function () {
  const same = makeEnv({ spreadsheetTz: 'Pacific/Auckland' });
  assert.strictEqual(goLiveItem(same, '時區一致').status, S_(same).GREEN);

  const diffSheet = makeEnv({ spreadsheetTz: 'America/Los_Angeles' });
  const red = goLiveItem(diffSheet, '時區一致');
  assert.strictEqual(red.status, S_(diffSheet).RED);
  ['America/Los_Angeles', 'Pacific/Auckland'].forEach(function (tz) { assert.ok(red.message.indexOf(tz) !== -1, red.message); });

  const diffScript = makeEnv({ spreadsheetTz: 'Pacific/Auckland' });
  diffScript.sandbox.Session = { getScriptTimeZone: function () { return 'Asia/Hong_Kong'; }, getActiveUser: function () { return { getEmail: function () { return ''; } }; }, getEffectiveUser: function () { return { getEmail: function () { return ''; } }; } };
  assert.strictEqual(goLiveItem(diffScript, '時區一致').status, S_(diffScript).RED);

  const diffConfig = makeEnv({ spreadsheetTz: 'Pacific/Auckland', config: { SYS_TIMEZONE: 'Asia/Hong_Kong' } });
  assert.strictEqual(goLiveItem(diffConfig, '時區一致').status, S_(diffConfig).RED);

  const unreadable = makeEnv({});            // 假試算表沒有 getSpreadsheetTimeZone
  const yellow = goLiveItem(unreadable, '時區一致');
  assert.strictEqual(yellow.status, S_(unreadable).YELLOW);
  assert.ok(yellow.message.indexOf('不等於「一致」') !== -1, yellow.message);
});

test('R-058 d. 「完成度自我檢測」與「上線前檢查」共用同一支判斷（同一個燈色、同一句說明）', function () {
  const env = makeEnv({ spreadsheetTz: 'America/Los_Angeles' });
  const fromGoLive = goLiveItem(env, '時區一致');
  const fromSelfCheck = env.sandbox.selfCheckTimezoneItem_();
  assert.strictEqual(fromSelfCheck.status, fromGoLive.status);
  assert.strictEqual(fromSelfCheck.message, fromGoLive.message);
  assert.strictEqual(fromSelfCheck.label, '時區一致');
});

test('R-058：選單入口 menuRunGoLiveCheck_ 與 Web App 入口 apiGoLiveReport 的報告都有這四項', function () {
  const fake = makeFakeUi(null);
  const env = makeEnv({ ui: fake.ui, spreadsheetTz: 'America/Los_Angeles', config: { DRY_RUN: 'TRUE' } });
  env.sandbox.menuRunGoLiveCheck_();
  const alertText = fake.alerts.filter(function (a) { return a.kind === 'alert'; })[0].body;
  assert.ok(alertText.indexOf('上線前：時區一致') !== -1, '時區不一致是🔴，要列在「必須先處理」：' + alertText);

  const resp = env.sandbox.apiGoLiveReport();
  assert.strictEqual(resp.ok, true, JSON.stringify(resp));
  const text = resp.data.lines.join('\n');
  ['上線前：寄送名單', '上線前：收件人是否仍是測試名單', '上線前：測試季度', '上線前：時區一致'].forEach(function (label) {
    assert.ok(text.indexOf(label) !== -1, '報告缺少「' + label + '」');
  });
  assert.strictEqual(resp.data.summary.total, 17);
});

test('R-058：四項的字眼全部是書面語（沒有口語字）', function () {
  const env = makeEnv({
    todayIso: '2026-11-17', spreadsheetTz: 'America/Los_Angeles', config: { EMAIL_ALLOWLIST: 'a@example.org', DRY_RUN: 'FALSE' },
    weekRowSpecs: [{ isoDate: '2028-04-02', quarterId: '2028T2' }]
  });
  env.sandbox.writeSheet_(env.sandbox.SHEETS.RECIPIENTS, recipientRows([{ email: 'a@example.org' }, { email: 'out@example.org', group: 'DB' }]));
  const { assertWrittenChinese } = require('./helpers/writtenChinese');
  ['寄送名單', '測試名單', '測試季度', '時區一致'].forEach(function (k) {
    assertWrittenChinese(assert, k, goLiveItem(env, k).message);
  });
});

// =====================================================================

console.log('\n通過 ' + pass + ' 項，失敗 ' + fail + ' 項。');
process.exit(fail === 0 ? 0 : 1);
