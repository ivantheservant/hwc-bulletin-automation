#!/usr/bin/env node
/**
 * tests/savetoken.test.js
 *
 * src/WebAppSave.gs 的 canonicalSaveToken_() 回歸測試——修正「第一次
 * 儲存永遠被誤判成 STALE」這個事故（docs/已知bug類型.md 事故七）的核心：
 * 「從未儲存」這個狀態，載入與儲存兩條路徑都必須正規化成同一個值。
 *
 * 1. null／undefined／''／'   ' 全部回 ''
 * 2. Date 物件與其對應的 ISO 字串 → 回傳同一個值
 * 3. 數字序列值（epoch 毫秒）→ 與對應 Date 相同
 * 4. 無法解析的字串 → 回傳 trim() 後的原值
 * 5. 首次儲存：payload 的 lastSavedAt 是 null、工作表是 '' → 允許儲存
 * 6. 已儲存過、token 相符 → 允許
 * 7. 已儲存過、token 不符 → STALE，且錯誤訊息同時包含兩個時間
 * 8. STALE 時沒有任何寫入動作
 *
 * 執行方式：node tests/savetoken.test.js
 * 離開碼：0＝全部通過　1＝有測試失敗
 */

'use strict';

const assert = require('assert');
const vm = require('vm');
const { loadAllSrcFilesInOrder } = require('./helpers/loadGas');
const { makeFakeSheet, makeFakeSpreadsheet } = require('./helpers/fakeSpreadsheet');

const GAS_STUBS = {
  Utilities: { formatDate: function () { return ''; } },
  Session: {
    getScriptTimeZone: function () { return 'Pacific/Auckland'; },
    getActiveUser: function () { return { getEmail: function () { return ''; } }; }
  },
  SpreadsheetApp: {},
  CacheService: {}
};

const sandbox = loadAllSrcFilesInOrder(GAS_STUBS);
const { canonicalSaveToken_ } = sandbox;

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
 * `canonicalSaveToken_()` 執行在 vm sandbox 內，`value instanceof Date`
 * 檢查的是 sandbox 自己那個 realm 的 Date 建構子——用 Node 外層的
 * `new Date(...)` 造出來的物件，`instanceof` 在 sandbox 裡面判定會是
 * false（跨 realm），變成掉進「不是 Date、不是 number、不是 string」
 * 的最後一條分支，用 `String(value)` 印出 `Date.prototype.toString()`
 * 的格式，不是我們要測的 `formatSaveTokenDate_()` 輸出。
 *
 * `vm.createContext()` 之後，內建的 `Date` 不會變成 sandbox 物件自己的
 * 「屬性」（`sandbox.Date` 是 `undefined`），但在同一個 context 內執行的
 * 程式碼仍然看得到它（環境自己的全域）。所以要造一個「跟 canonicalSaveToken_()
 * 同一個 realm」的 Date，只能用 `vm.runInContext()` 在同一個 sandbox
 * 內執行 `new Date(...)`，不能用外層 Node 的 `new Date(...)`。
 */
function sandboxDate(y, mo, d, h, mi, s) {
  return vm.runInContext(
    'new Date(' + [y, mo, d, h, mi, s].join(',') + ')',
    sandbox
  );
}

// =====================================================================
// 1. 空值一律回 ''
// =====================================================================

test('canonicalSaveToken_：null／undefined／空字串／只有空白的字串，全部回 \'\'（代表「從未儲存」）', function () {
  assert.strictEqual(canonicalSaveToken_(null), '');
  assert.strictEqual(canonicalSaveToken_(undefined), '');
  assert.strictEqual(canonicalSaveToken_(''), '');
  assert.strictEqual(canonicalSaveToken_('   '), '');
});

// =====================================================================
// 2. Date 物件與其對應的 ISO 字串 → 同一個值
// =====================================================================

test('canonicalSaveToken_：Date 物件與 date.toISOString() → 回傳同一個值（同一個時間點只有一種表示法）', function () {
  var d = sandboxDate(2027, 7, 20, 15, 40, 12); // 2027-08-20 15:40:12（區域時間）
  var iso = d.toISOString();
  assert.strictEqual(canonicalSaveToken_(d), canonicalSaveToken_(iso));
});

test('canonicalSaveToken_：Date 物件格式化成 yyyy-MM-dd HH:mm:ss', function () {
  var d = sandboxDate(2027, 7, 20, 15, 40, 12);
  assert.strictEqual(canonicalSaveToken_(d), '2027-08-20 15:40:12');
});

// =====================================================================
// 3. 數字序列值（epoch 毫秒）→ 與對應 Date 相同
// =====================================================================

test('canonicalSaveToken_：數字（epoch 毫秒）與對應 Date 物件回傳同一個值', function () {
  var d = sandboxDate(2027, 0, 5, 9, 0, 0);
  assert.strictEqual(canonicalSaveToken_(d.getTime()), canonicalSaveToken_(d));
});

// =====================================================================
// 4. 無法解析的字串 → 回傳 trim() 後的原值
// =====================================================================

test('canonicalSaveToken_：無法解析成日期的字串 → 回傳 trim() 後的原值', function () {
  assert.strictEqual(canonicalSaveToken_('  這不是日期  '), '這不是日期');
});

// =====================================================================
// 5-8：透過 checkOptimisticLock_() 與真正入口 saveWeekFromWebApp_() 驗證
// =====================================================================

test('canonicalSaveToken_ 驅動的 checkOptimisticLock_：首次儲存（payload null、工作表空）→ 允許', function () {
  assert.strictEqual(sandbox.checkOptimisticLock_('', null), true);
  assert.strictEqual(sandbox.checkOptimisticLock_(null, ''), true);
});

test('canonicalSaveToken_ 驅動的 checkOptimisticLock_：已儲存過、token 相符 → 允許', function () {
  var d = sandboxDate(2027, 7, 20, 15, 40, 12);
  assert.strictEqual(sandbox.checkOptimisticLock_(d, d.toISOString()), true);
});

test('canonicalSaveToken_ 驅動的 checkOptimisticLock_：已儲存過、token 不符 → 不允許', function () {
  var d1 = sandboxDate(2027, 7, 20, 15, 40, 12);
  var d2 = sandboxDate(2027, 7, 20, 15, 41, 0);
  assert.strictEqual(sandbox.checkOptimisticLock_(d1, d2), false);
});

// ---- 由真正入口 saveWeekFromWebApp_() 叫下去 ----

function ownSheetFor(sandboxRef, sheetId, rows) {
  const def = sandboxRef.COLUMNS[sheetId];
  return makeFakeSheet(def.headers, def.keys, rows || []);
}

function makeEnv(options) {
  const o = options || {};
  const freshSandbox = loadAllSrcFilesInOrder(GAS_STUBS);
  const sheets = {
    BulletinWeeks: ownSheetFor(freshSandbox, 'BULLETIN_WEEKS', o.bulletinWeeks || []),
    Announcements: ownSheetFor(freshSandbox, 'ANNOUNCEMENTS', []),
    Prayers: ownSheetFor(freshSandbox, 'PRAYERS', []),
    Fellowships: ownSheetFor(freshSandbox, 'FELLOWSHIPS', []),
    Finance: ownSheetFor(freshSandbox, 'FINANCE', []),
    AuditLog: ownSheetFor(freshSandbox, 'AUDIT_LOG', [])
  };
  const FakeApp = { getActiveSpreadsheet: function () { return makeFakeSpreadsheet(sheets); } };
  return loadAllSrcFilesInOrder(Object.assign({}, GAS_STUBS, { SpreadsheetApp: FakeApp }));
}

function basicPayload(overrides) {
  return Object.assign({
    isoDate: '2027-10-03',
    lastSavedAt: null,
    week: {},
    announcements: [], prayers: [], fellowships: [], finance: []
  }, overrides || {});
}

test('真正入口：首次儲存（BulletinWeeks 那一行從未有過 LAST_SAVED_AT，payload 帶 null）→ 成功，不再誤判 STALE', function () {
  var sb = makeEnv({
    bulletinWeeks: [{ SERVICE_DATE: '2027-10-03', QUARTER_ID: '2027T4', WEEK_OF_MONTH: 1, STATUS: 'DRAFT' }]
  });
  var result = sb.saveWeekFromWebApp_(basicPayload({ lastSavedAt: null, week: { SERMON_TITLE: '恩典夠用' } }));
  assert.ok(result.lastSavedAt, '應該有新的 lastSavedAt');
  assert.strictEqual(sb.readSheet('BulletinWeeks')[0].SERMON_TITLE, '恩典夠用');
});

test('真正入口：已儲存過、token 相符 → 允許儲存', function () {
  var sb = makeEnv({
    bulletinWeeks: [{ SERVICE_DATE: '2027-10-03', QUARTER_ID: '2027T4', WEEK_OF_MONTH: 1, STATUS: 'DRAFT' }]
  });
  sb.saveWeekFromWebApp_(basicPayload({ week: { SERMON_TITLE: '第一次' } }));

  // 用重新讀出來的 lastSavedAt（而不是第一次呼叫的回傳值）送第二次儲存，
  // 理由同上一個測試的註解：假工作表把 Date 存成 'yyyy-MM-dd' 字串。
  var reloadedLastSavedAt = sb.readSheet('BulletinWeeks')[0].LAST_SAVED_AT;
  var second = sb.saveWeekFromWebApp_(basicPayload({ lastSavedAt: reloadedLastSavedAt, week: { SERMON_TITLE: '第二次' } }));
  assert.strictEqual(sb.readSheet('BulletinWeeks')[0].SERMON_TITLE, '第二次');
  assert.ok(second.lastSavedAt);
});

test('真正入口：已儲存過、token 不符 → STALE，錯誤訊息同時包含兩個時間，而且完全沒有寫入動作', function () {
  var sb = makeEnv({
    bulletinWeeks: [{ SERVICE_DATE: '2027-10-03', QUARTER_ID: '2027T4', WEEK_OF_MONTH: 1, STATUS: 'DRAFT', SERMON_TITLE: '原本的' }]
  });
  sb.saveWeekFromWebApp_(basicPayload({ week: { SERMON_TITLE: '原本的' } }));

  // ⚠️ 假工作表把 Date 存成 'yyyy-MM-dd' 字串（見 tests/helpers/fakeSpreadsheet.js
  // 的 toRealmSafeCellValue()），所以不能直接拿 saveWeekFromWebApp_() 回傳的
  // 高精度 lastSavedAt 跟訊息比對；要重新讀一次工作表現有的值，跟
  // buildSaveOperations_() 組訊息時看到的是同一份資料。
  var currentToken = sb.canonicalSaveToken_(sb.readSheet('BulletinWeeks')[0].LAST_SAVED_AT);

  var beforeWeek = JSON.stringify(sb.readSheet('BulletinWeeks'));
  var beforeAudit = JSON.stringify(sb.readSheet('AuditLog'));

  var thrown = null;
  try {
    sb.saveWeekFromWebApp_(basicPayload({
      lastSavedAt: null, // 過期的版本（第一次儲存之前的狀態）
      week: { SERMON_TITLE: '想要覆蓋成這個' }
    }));
  } catch (err) {
    thrown = err;
  }

  assert.ok(thrown, '應該拋出例外');
  assert.strictEqual(thrown.code, 'STALE');
  assert.ok(thrown.message.indexOf(currentToken) !== -1, '訊息要包含工作表上目前的最後儲存時間：' + thrown.message);
  assert.ok(thrown.message.indexOf('（尚未儲存）') !== -1, '訊息要包含你載入時的版本時間（此例是「尚未儲存」）：' + thrown.message);

  var afterWeek = JSON.stringify(sb.readSheet('BulletinWeeks'));
  var afterAudit = JSON.stringify(sb.readSheet('AuditLog'));
  assert.strictEqual(afterWeek, beforeWeek, 'STALE 時 BulletinWeeks 不應該有任何變動');
  assert.strictEqual(afterAudit, beforeAudit, 'STALE 時 AuditLog 不應該有任何新記錄');
});

// =====================================================================

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
