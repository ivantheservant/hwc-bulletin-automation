#!/usr/bin/env node
/**
 * tests/retire.test.js
 *
 * 內容表 v2（工作介面精簡為「填寫介面＋內容表」）：停用季度填寫表與講員表格。
 *
 * 停用一個功能，要數齊它的**每一個入口與副作用**（docs/已知bug類型.md bug class 33、47）：選單、
 * 舊選單（部署前已開着的試算表仍然有舊項目）、觸發器、星期一自動流程、全季演練、不帶底線的公開 api、
 * 儲存副作用、封存還原、填寫介面的按鈕。這個檔案逐個入口驗「一格都不寫」，全部經真正入口。
 *
 * 執行方式：node tests/retire.test.js
 * 離開碼：0＝全部通過　1＝有測試失敗
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
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
    console.log('    ' + (err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n    ') : err));
  }
}

function readSrc(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');
}

/** 造一個會記錄選單結構與對話框的假 UI（與 tests/selfcheck.test.js 的 recordingUi 同一個做法）。 */
function recordingUi(store) {
  store.alerts = store.alerts || [];
  return {
    createMenu: function (name) {
      const menu = { name: name, items: [] };
      const api = {
        __menu: menu,
        addItem: function (label, fn) { menu.items.push({ label: label, fn: fn }); return api; },
        addSeparator: function () { menu.items.push({ separator: true }); return api; },
        addSubMenu: function (sub) { menu.items.push({ sub: sub.__menu }); return api; },
        addToUi: function () { store.top = menu; return api; }
      };
      return api;
    },
    alert: function (title, message) { store.alerts.push({ title: title, message: message }); return 'OK'; }
  };
}

/** 選單內全部項目（包括子選單）。 */
function flattenMenu(menu) {
  const out = [];
  (function walk(m, parent) {
    m.items.forEach(function (i) {
      if (i.sub) return walk(i.sub, i.sub.name);
      if (i.fn) out.push({ label: i.label, fn: i.fn, parent: parent });
    });
  })(menu, menu.name);
  return out;
}

/** 把會被寫到的工作表拍一張快照，比較「一格都沒有寫」。 */
function snapshotSheets(env) {
  const out = {};
  ['BulletinWeeks', 'FillSnapshot', 'AuditLog', 'SendLog', 'ConflictNoticeLog', 'WeekSnapshots', 'FieldOverride', 'DutyOverride']
    .forEach(function (n) { out[n] = JSON.stringify(env.sandbox.readSheet(n)); });
  const grid = env.sheets['Fill_' + QUARTER_ID];
  out.grid = grid ? JSON.stringify(grid.__data) : '';
  out.sheetNames = JSON.stringify(Object.keys(env.sheets).sort());
  out.triggers = JSON.stringify(env.triggers.installed.map(function (t) { return t.getHandlerFunction(); }));
  return out;
}

function assertSame(before, after, label) {
  Object.keys(before).forEach(function (k) {
    assert.strictEqual(after[k], before[k], (label || '') + '：' + k + ' 不應該有任何變動');
  });
}

/** 季度填寫表已停用之後不可以再出現在選單上的處理函式。 */
const RETIRED_FILL_MENU_HANDLERS = [
  'menuCreateOrRefreshFillGrid_', 'menuSyncFillGrid_', 'menuResolveFillConflicts_',
  'menuCheckFillGridAppearance_', 'menuSendFillInvite_', 'menuCheckMissingQuarters_',
  'menuInstallFillReconcileTrigger_', 'menuRemoveFillReconcileTrigger_'
];

// =====================================================================
// Commit 2：停用季度填寫表
// =====================================================================

console.log('\n停用季度填寫表');

test('R2-1 onOpen：子選單叫「季度工具」，沒有填寫表各項；稽核觸發器兩項改名；引用的處理函式全部存在', function () {
  const store = {};
  const env = makeFillEnv({ ui: recordingUi(store) });
  env.sandbox.onOpen();
  const items = flattenMenu(store.top);

  const subNames = [];
  (function walk(m) { m.items.forEach(function (i) { if (i.sub) { subNames.push(i.sub.name); walk(i.sub); } }); })(store.top);
  assert.ok(subNames.indexOf('季度工具') !== -1, '子選單：' + subNames.join('、'));
  assert.strictEqual(subNames.indexOf('季度填寫表'), -1, '不可以再有「季度填寫表」子選單');

  const retiredInMenu = items.filter(function (i) { return RETIRED_FILL_MENU_HANDLERS.indexOf(i.fn) !== -1; });
  assert.deepStrictEqual(retiredInMenu, [], '選單仍然引用已停用的項目');
  assert.strictEqual(items.filter(function (i) { return i.label.indexOf('填寫表') !== -1; }).length, 0,
    '選單不可以再有任何「填寫表」字眼：' + items.map(function (i) { return i.label; }).join('、'));

  const tools = items.filter(function (i) { return i.parent === '季度工具'; }).map(function (i) { return i.label + '→' + i.fn; });
  assert.ok(tools.indexOf('安裝 Config 改動稽核觸發器→menuInstallFillEditTrigger_') !== -1, tools.join('、'));
  assert.ok(tools.indexOf('移除 Config 改動稽核觸發器→menuRemoveFillEditTrigger_') !== -1, tools.join('、'));

  const missing = items.filter(function (i) { return typeof env.sandbox[i.fn] !== 'function'; });
  assert.deepStrictEqual(missing, [], '選單引用了不存在的處理函式');
});

test('R2-2 舊選單（部署前已開着的試算表）：每一個已停用的項目只顯示「已停用」，一格都不寫、不裝觸發器、不建 Fill_', function () {
  RETIRED_FILL_MENU_HANDLERS.filter(function (fn) { return fn !== 'menuRemoveFillReconcileTrigger_'; }).forEach(function (fn) {
    const store = {};
    const env = makeFillEnv({ withGrid: false, ui: recordingUi(store), config: { DRY_RUN: 'FALSE' } });
    const before = snapshotSheets(env);
    env.sandbox[fn]();
    assertSame(before, snapshotSheets(env), fn);
    assert.strictEqual(env.mail.calls.length, 0, fn + '：不可以寄信');
    assert.strictEqual(store.alerts.length, 1, fn + '：要有一個對話框');
    assert.ok(store.alerts[0].message.indexOf('季度填寫表已停用') !== -1, fn + '：' + store.alerts[0].message);
  });
});

test('R2-3 星期一觸發器（weeklyBulletinSendTrigger_）：不建立 Fill_、不寄填寫邀請；內容表那一步照舊執行', function () {
  const env = makeFillEnv({ withGrid: false, config: { DRY_RUN: 'FALSE' } });
  let contentStepCalls = 0;
  env.sandbox.autoCreateContentSheetsForUpcomingQuarters_ = function () {
    contentStepCalls++;
    return { created: [], invited: [], skipped: [] };
  };
  env.sandbox.weeklyBulletinSendTrigger_();

  assert.strictEqual(Object.keys(env.sheets).filter(function (n) { return /^Fill_/.test(n); }).length, 0, '不可以建立 Fill_');
  assert.strictEqual(env.sandbox.readSheet('SendLog').filter(function (r) { return r.STATUS === 'FILL_INVITE'; }).length, 0);
  assert.strictEqual(env.sandbox.readSheet('ConflictNoticeLog').filter(function (r) { return r.POST_ID === 'FILL_INVITE'; }).length, 0);
  assert.strictEqual(contentStepCalls, 1, '內容表的自動建立與邀請那一步要照舊執行');
});

test('R2-4 apiResolveFillConflicts（不帶底線的公開函式）：回 FILL_GRID_RETIRED，一格都不寫', function () {
  const env = makeFillEnv({});
  const before = snapshotSheets(env);
  const resp = env.sandbox.apiResolveFillConflicts(QUARTER_ID, [{ isoDate: SERVICE_DATES[0], fieldKey: 'PRELUDE', choice: 'GRID' }]);
  assert.strictEqual(resp.ok, false);
  assert.strictEqual(resp.error.code, 'FILL_GRID_RETIRED');
  assert.ok(resp.error.message.indexOf('季度填寫表已停用') !== -1, resp.error.message);
  assertSame(before, snapshotSheets(env), 'apiResolveFillConflicts');
});

test('R2-5 fillReconcileTrigger_（觸發器拆之前仍然會觸發）：一格都不寫、不寄信、不寫 ErrorLog', function () {
  const env = makeFillEnv({ config: { DRY_RUN: 'FALSE' } });
  // 格子表有一格未同步的改動：以前對帳會把它寫回週報。
  const sheet = env.sheets['Fill_' + QUARTER_ID];
  sheet.getRange(4, env.sandbox.fillGridColumnIndex_('PRELUDE')).setValue('格子表的序樂');
  const before = snapshotSheets(env);
  env.sandbox.fillReconcileTrigger_();
  assertSame(before, snapshotSheets(env), 'fillReconcileTrigger_');
  assert.strictEqual(env.sandbox.readSheet('ErrorLog').length, 0);
  assert.strictEqual(env.mail.calls.length, 0);
});

test('R2-6 全季流程演練（runQuarterRehearsal_）：不再建立 Fill_', function () {
  const env = makeFillEnv({ withGrid: false });
  env.sandbox.runQuarterRehearsal_(QUARTER_ID);
  assert.strictEqual(Object.keys(env.sheets).filter(function (n) { return /^Fill_/.test(n); }).length, 0,
    '演練會替真實季度建立 Fill_，停用之後不可以再建');
});

test('R2-7 取消封存（unarchiveQuarter_）：Fill_ 維持隱藏，訊息講明季度填寫表已停用', function () {
  const env = makeFillEnv({});
  const sheet = env.sheets['Fill_' + QUARTER_ID];
  sheet.hideSheet();
  const result = env.sandbox.unarchiveQuarter_(QUARTER_ID);
  assert.strictEqual(result.ok, true, result.message);
  assert.strictEqual(sheet.isSheetHidden(), true, '取消封存不可以令已停用的分頁重新出現');
  assert.ok(result.message.indexOf('季度填寫表已停用') !== -1, result.message);
});

test('R2-8 儲存（saveWeekFromWebApp_）與重設（resetWeekFromWebApp_）：Fill_ 與 FillSnapshot 一格都不變', function () {
  const env = makeFillEnv({});
  const gridBefore = JSON.stringify(env.sheets['Fill_' + QUARTER_ID].__data);
  const snapBefore = JSON.stringify(env.sandbox.readSheet('FillSnapshot'));
  env.sandbox.saveWeekFromWebApp_({
    isoDate: SERVICE_DATES[0], lastSavedAt: '', baseWeek: { PRELUDE: '' }, week: { PRELUDE: '介面改的序樂' }
  });
  const token = env.sandbox.canonicalSaveToken_(env.sandbox.readBulletinWeekRowWithRowNo_(SERVICE_DATES[0]).LAST_SAVED_AT);
  env.sandbox.resetWeekFromWebApp_(SERVICE_DATES[0], token);
  assert.strictEqual(JSON.stringify(env.sheets['Fill_' + QUARTER_ID].__data), gridBefore, 'Fill_ 不可以被改');
  assert.strictEqual(JSON.stringify(env.sandbox.readSheet('FillSnapshot')), snapBefore, 'FillSnapshot 不可以被改');
});

test('R2-9 填寫介面：apiLoadWeek 不再送 fillGridUrl；Index.html、Script.html 沒有「開啟本季填寫表」', function () {
  const env = makeFillEnv({});
  const data = env.sandbox.loadWeekForWebApp_(SERVICE_DATES[0]);
  assert.strictEqual('fillGridUrl' in data, false);
  const index = readSrc('src/ui/Index.html');
  const script = readSrc('src/ui/Script.html');
  ['fillGridLink', '開啟本季填寫表'].forEach(function (needle) {
    assert.strictEqual(index.indexOf(needle), -1, 'Index.html 仍然有 ' + needle);
    assert.strictEqual(script.indexOf(needle), -1, 'Script.html 仍然有 ' + needle);
  });
  assert.strictEqual(readSrc('src/WebApp.gs').indexOf('buildFillGridUrlForWebApp_'), -1);
});

test('R2-10 onFillGridEdit_：Config 那一格照舊記 CONFIG_MANUAL_EDIT（同一個觸發器兼做 Config 稽核，不可以一併停掉）', function () {
  const env = makeFillEnv({});
  const config = env.sheets.Config;
  config.getName = function () { return 'Config'; };
  const rowNo = 3;
  env.sandbox.onFillGridEdit_({
    oldValue: '舊值',
    range: {
      getSheet: function () { return config; },
      getRow: function () { return rowNo; },
      getColumn: function () { return 2; },
      getNumRows: function () { return 1; },
      getNumColumns: function () { return 1; }
    }
  });
  const audit = env.sandbox.readSheet('AuditLog').filter(function (r) { return r.ACTION === 'CONFIG_MANUAL_EDIT'; });
  assert.strictEqual(audit.length, 1, 'Config 稽核要照舊運作');
});

console.log('');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
