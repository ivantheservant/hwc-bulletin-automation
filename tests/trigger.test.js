#!/usr/bin/env node
/**
 * tests/trigger.test.js
 *
 * src/Trigger.gs 的回歸測試（用假的 ScriptApp／SpreadsheetApp 替身）。
 *
 * 1. 目標日不是星期日 → 不寄、寫 ErrorLog
 * 2. 安裝時先清舊觸發器（連續安裝兩次只會剩一個）
 *
 * 執行方式：node tests/trigger.test.js
 * 離開碼：0＝全部通過　1＝有測試失敗
 */

'use strict';

const assert = require('assert');
const { loadAllSrcFilesInOrder } = require('./helpers/loadGas');
const { makeFakeSheet, makeFakeSpreadsheet } = require('./helpers/fakeSpreadsheet');

/** 固定「今天」＝2027-10-04（星期一，2027-10-03 是本專案測試慣用的主日星期日）。 */
const FIXED_TODAY_ISO = '2027-10-04';

function formatDateForTest(date, timeZone, pattern) {
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  if (pattern === 'yyyy-MM-dd') return FIXED_TODAY_ISO;
  return String(pattern)
    .replace(/yyyy/g, String(date.getFullYear()))
    .replace(/MM/g, pad2(date.getMonth() + 1))
    .replace(/dd/g, pad2(date.getDate()))
    .replace(/HH/g, pad2(date.getHours()))
    .replace(/mm/g, pad2(date.getMinutes()))
    .replace(/ss/g, pad2(date.getSeconds()));
}

const BASE_STUBS = {
  Utilities: { formatDate: formatDateForTest },
  Session: {
    getScriptTimeZone: function () { return 'Pacific/Auckland'; },
    getActiveUser: function () { return { getEmail: function () { return ''; } }; }
  },
  CacheService: {},
  HtmlService: {}
};

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

/**
 * 造一個假的 ScriptApp：`newTrigger()` 回傳一個可以串接
 * `.timeBased().onWeekDay().atHour().create()` 的 builder，
 * `getProjectTriggers()`／`deleteTrigger()` 操作同一份記憶體清單。
 */
function makeFakeScriptApp() {
  var triggers = [];
  var idCounter = 0;
  var WeekDay = {
    SUNDAY: 'SUNDAY', MONDAY: 'MONDAY', TUESDAY: 'TUESDAY', WEDNESDAY: 'WEDNESDAY',
    THURSDAY: 'THURSDAY', FRIDAY: 'FRIDAY', SATURDAY: 'SATURDAY'
  };
  return {
    WeekDay: WeekDay,
    _triggers: triggers,
    newTrigger: function (fnName) {
      var draft = { fnName: fnName, weekDay: null, hour: null };
      var builder = {
        timeBased: function () { return builder; },
        onWeekDay: function (wd) { draft.weekDay = wd; return builder; },
        atHour: function (h) { draft.hour = h; return builder; },
        create: function () {
          var id = 'trig_' + (++idCounter);
          var record = { id: id, handlerFunction: draft.fnName, weekDay: draft.weekDay, hour: draft.hour };
          triggers.push(record);
          return { getUniqueId: function () { return id; } };
        }
      };
      return builder;
    },
    getProjectTriggers: function () {
      return triggers.map(function (t) {
        return {
          getHandlerFunction: function () { return t.handlerFunction; },
          getEventType: function () { return 'CLOCK'; },
          getUniqueId: function () { return t.id; }
        };
      });
    },
    deleteTrigger: function (triggerObj) {
      var id = triggerObj.getUniqueId();
      var idx = triggers.findIndex(function (t) { return t.id === id; });
      if (idx !== -1) triggers.splice(idx, 1);
    }
  };
}

function configRows(sandboxRef, overrides) {
  const base = {};
  sandboxRef.DEFAULTS.forEach(function (item) { base[item.key] = item.value; });
  Object.assign(base, overrides || {});
  return Object.keys(base).map(function (key) {
    return { KEY: key, VALUE: base[key], NOTE: '', EDITABLE: true };
  });
}

function makeEnv(o) {
  o = o || {};
  const freshSandbox = loadAllSrcFilesInOrder(BASE_STUBS);
  const sheets = {
    Config: makeFakeSheet(freshSandbox.COLUMNS.CONFIG.headers, freshSandbox.COLUMNS.CONFIG.keys, configRows(freshSandbox, o.config)),
    ErrorLog: makeFakeSheet(freshSandbox.COLUMNS.ERROR_LOG.headers, freshSandbox.COLUMNS.ERROR_LOG.keys, []),
    SendLog: makeFakeSheet(freshSandbox.COLUMNS.SEND_LOG.headers, freshSandbox.COLUMNS.SEND_LOG.keys, [])
  };
  const fakeScriptApp = makeFakeScriptApp();
  const FakeApp = { getActiveSpreadsheet: function () { return makeFakeSpreadsheet(sheets); } };
  const sb = loadAllSrcFilesInOrder(Object.assign({}, BASE_STUBS, { SpreadsheetApp: FakeApp, ScriptApp: fakeScriptApp }));
  return { sandbox: sb, scriptApp: fakeScriptApp };
}

// =====================================================================
// 純函式：日期算術
// =====================================================================

test('addDaysToIsoDate_／isIsoDateSunday_：2027-10-03 是星期日，2027-10-04 不是', function () {
  const sb = loadAllSrcFilesInOrder(BASE_STUBS);
  assert.strictEqual(sb.isIsoDateSunday_('2027-10-03'), true);
  assert.strictEqual(sb.isIsoDateSunday_('2027-10-04'), false);
  assert.strictEqual(sb.addDaysToIsoDate_('2027-10-04', 6), '2027-10-10');
  assert.strictEqual(sb.isIsoDateSunday_(sb.addDaysToIsoDate_('2027-10-04', 6)), true, '星期一 + 6 天應該是下一個星期日');
});

// =====================================================================
// 1. 目標主日一定是星期日
// =====================================================================

// ⚠️ 這一組在第一輪自測之後**改變了預期**，理由要寫清楚：
//    舊版目標日是「今日 ＋ Config SEND_TARGET_OFFSET_DAYS 天」，所以
//    「算出來不是星期日」是一個**真的會發生**的情況（把 offset 設成 5
//    就會得出星期六），於是有一條測試在驗那個失敗路徑。
//
//    真實後果比設定寫錯嚴重得多：那條算式只在**觸發日是星期一**時才落
//    在星期日。第一輪自測在 2026-08-22（星期六）跑，系統選中 2026-08-28
//    ——一個星期五。見 docs/已知bug類型.md 事故三十。
//
//    現在目標主日由 resolveNextSendSundayIso_() 直接數星期幾，
//    SEND_TARGET_OFFSET_DAYS 已經廢棄。所以要驗的不再是「設定寫錯時會
//    報錯」，而是「**無論今日是星期幾，選中的都是星期日**」。

test('weeklyBulletinSendTrigger_：選中的目標日一定是星期日，而且不會再出現 TARGET_NOT_SUNDAY', function () {
  const env = makeEnv({ config: { ROSTER_SPREADSHEET_ID: '' } });
  env.sandbox.weeklyBulletinSendTrigger_();

  const errorRows = env.sandbox.readSheet('ErrorLog');
  assert.ok(
    errorRows.every(function (r) { return r.ERROR_CODE !== 'TARGET_NOT_SUNDAY'; }),
    '不應該再卡在「目標日不是星期日」，實際：'
      + JSON.stringify(errorRows.map(function (r) { return r.ERROR_CODE; }))
  );
});

// ⚠️ 這一條才是真正的迴歸測試：逐個星期幾試一次。舊算法在其中**六個**
//    星期幾都會得出非星期日，只有星期一是對的。
test('resolveNextSendSundayIso_：七個星期幾逐個試，選中的一定是星期日', function () {
  const sb = makeEnv({}).sandbox;
  // 2027-10-04（一）到 2027-10-10（日），剛好一整個星期。
  const week = ['2027-10-04', '2027-10-05', '2027-10-06', '2027-10-07',
    '2027-10-08', '2027-10-09', '2027-10-10'];
  const bad = [];
  week.forEach(function (iso) {
    const result = sb.resolveNextSendSundayIso_({ todayIso: iso, sentIsoList: [] });
    if (!result.ok || !sb.isIsoDateSunday_(result.isoDate)) {
      bad.push(iso + ' → ' + result.isoDate);
    }
  });
  assert.strictEqual(bad.length, 0, '這幾日算出來不是星期日：' + bad.join('、'));
});

test('weeklyBulletinSendTrigger_：分歧提醒失敗不會連累週報寄送——兩者各自記一筆 ErrorLog，函式本身不拋錯', function () {
  const env = makeEnv({ config: { ROSTER_SPREADSHEET_ID: '' } });
  assert.doesNotThrow(function () { env.sandbox.weeklyBulletinSendTrigger_(); });

  const errorRows = env.sandbox.readSheet('ErrorLog');
  assert.ok(
    errorRows.some(function (r) { return r.FUNCTION_NAME.indexOf('sendConflictNoticeIfNeeded_') !== -1; }),
    '應該有一筆來自分歧提醒的錯誤，實際：' + JSON.stringify(errorRows.map(function (r) { return r.FUNCTION_NAME; }))
  );
});

// =====================================================================
// 2. 安裝時先清舊觸發器（連續安裝兩次只會剩一個）
// =====================================================================

test('installWeeklySendTrigger_：安裝一次 → 專案內剛好一個 weeklyBulletinSendTrigger_ 觸發器', function () {
  const env = makeEnv({ config: { SEND_WEEKDAY: 'MONDAY', SEND_HOUR: '8' } });
  env.sandbox.installWeeklySendTrigger_();

  const triggers = env.scriptApp.getProjectTriggers();
  assert.strictEqual(triggers.length, 1);
  assert.strictEqual(triggers[0].getHandlerFunction(), 'weeklyBulletinSendTrigger_');
});

test('installWeeklySendTrigger_：連續安裝兩次，專案內仍然只有一個觸發器（不是寄兩次）', function () {
  const env = makeEnv({ config: { SEND_WEEKDAY: 'MONDAY', SEND_HOUR: '8' } });
  env.sandbox.installWeeklySendTrigger_();
  env.sandbox.installWeeklySendTrigger_();

  const triggers = env.scriptApp.getProjectTriggers();
  assert.strictEqual(triggers.length, 1, '連續安裝兩次應該只剩一個，不是兩個');
});

test('installWeeklySendTrigger_：不會影響其他 handler 的既有觸發器', function () {
  const env = makeEnv({ config: { SEND_WEEKDAY: 'MONDAY', SEND_HOUR: '8' } });
  env.scriptApp.newTrigger('someOtherHandler_').timeBased().onWeekDay(env.scriptApp.WeekDay.TUESDAY).atHour(9).create();

  env.sandbox.installWeeklySendTrigger_();
  env.sandbox.installWeeklySendTrigger_();

  const triggers = env.scriptApp.getProjectTriggers();
  assert.strictEqual(triggers.length, 2, '應該有 someOtherHandler_ 一個＋ weeklyBulletinSendTrigger_ 一個');
  assert.strictEqual(triggers.filter(function (t) { return t.getHandlerFunction() === 'weeklyBulletinSendTrigger_'; }).length, 1);
  assert.strictEqual(triggers.filter(function (t) { return t.getHandlerFunction() === 'someOtherHandler_'; }).length, 1);
});

test('removeAllSendTriggers_：移除全部同名觸發器，回傳刪除的數量', function () {
  const env = makeEnv({ config: { SEND_WEEKDAY: 'MONDAY', SEND_HOUR: '8' } });
  env.sandbox.installWeeklySendTrigger_();
  const removed = env.sandbox.removeAllSendTriggers_();
  assert.strictEqual(removed, 1);
  assert.strictEqual(env.scriptApp.getProjectTriggers().length, 0);
});

test('resolveScriptAppWeekDay_：不合法的 SEND_WEEKDAY 會拋錯', function () {
  const env = makeEnv({ config: { SEND_WEEKDAY: '不是星期幾' } });
  assert.throws(function () {
    env.sandbox.installWeeklySendTrigger_();
  });
});

// =====================================================================

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
