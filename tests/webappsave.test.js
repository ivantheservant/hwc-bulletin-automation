#!/usr/bin/env node
/**
 * tests/webappsave.test.js
 *
 * src/WebAppSave.gs（與 src/WebApp.gs 的權限判斷）的回歸測試：
 *   1. 樂觀鎖：lastSavedAt 相符才允許儲存，不符回 STALE 且沒有任何寫入。
 *   2. upsert：新增／修改／移除三種情況，移除是 ACTIVE=FALSE，不是刪除。
 *   3. 重新編號：SEQ_NO 依 payload 次序變成 10/20/30。
 *   4. AuditLog：只有真正改動的欄位才產生記錄。
 *   5. 人數 12 格：'--' 與 '前:5 / 後:120' 原樣保存，不轉數字。
 *   6. 團契日期欄：'10/5 星期日' 原樣保存，不變成 Date。
 *   7. 權限：WEBAPP_ALLOWED_EMAILS 空白／有值／呼叫者不在名單。
 *
 * 純函式層（computeListUpsertPlan_／computeFieldDiff_／checkOptimisticLock_／
 * isEmailAuthorized_）直接測；儲存的完整流程（saveWeekFromWebApp_）用假
 * SpreadsheetApp 替身，由真正入口叫下去。
 *
 * 執行方式：node tests/webappsave.test.js
 * 離開碼：0＝全部通過　1＝有測試失敗
 */

'use strict';

const assert = require('assert');
const { loadAllSrcFilesInOrder } = require('./helpers/loadGas');
const { makeFakeSheet, makeFakeSpreadsheet } = require('./helpers/fakeSpreadsheet');

const GAS_STUBS = {
  Utilities: { formatDate: function () { return ''; } },
  Session: {
    getScriptTimeZone: function () { return 'Pacific/Auckland'; },
    getActiveUser: function () { return { getEmail: function () { return ''; } }; },
    getEffectiveUser: function () { return { getEmail: function () { return ''; } }; }
  },
  SpreadsheetApp: {},
  CacheService: {}
};

const sandbox = loadAllSrcFilesInOrder(GAS_STUBS);
const {
  checkOptimisticLock_, computeFieldDiff_, computeListUpsertPlan_,
  isEmailAuthorized_, fieldsEqual_
} = sandbox;

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

function d(iso) { return sandbox.normalizeDate_(iso); }

/**
 * computeListUpsertPlan_() 在 vm sandbox 內執行，回傳的陣列是 sandbox 自己
 * 那個 realm 的 Array——即使元素值相同，assert.deepStrictEqual() 會因為
 * 建構子不是同一個 Array 而判定「not reference-equal」。改用 JSON.stringify
 * 比較，跟 tests/dutybox.test.js 的 assertArrayEqual 同一個做法。
 */
function assertArrayEqual(actual, expected, message) {
  assert.strictEqual(JSON.stringify(actual), JSON.stringify(expected), message);
}

// =====================================================================
// 1. 樂觀鎖（純函式）
// =====================================================================

test('checkOptimisticLock_：兩者皆空（從未儲存過）→ 允許', function () {
  assert.strictEqual(checkOptimisticLock_(undefined, undefined), true);
  assert.strictEqual(checkOptimisticLock_(null, ''), true);
});

test('checkOptimisticLock_：同一個日期（不同物件）→ 相符', function () {
  assert.strictEqual(checkOptimisticLock_(d('2027-08-01'), d('2027-08-01')), true);
});

test('checkOptimisticLock_：日期不同 → 不相符', function () {
  assert.strictEqual(checkOptimisticLock_(d('2027-08-01'), d('2027-08-02')), false);
});

test('checkOptimisticLock_：一邊有值一邊空 → 不相符', function () {
  assert.strictEqual(checkOptimisticLock_(d('2027-08-01'), null), false);
  assert.strictEqual(checkOptimisticLock_(null, d('2027-08-01')), false);
});

// =====================================================================
// fieldsEqual_（純函式，upsert／diff 的基礎）
// =====================================================================

test('fieldsEqual_：null／undefined／空字串互相視為相等', function () {
  assert.strictEqual(fieldsEqual_(null, undefined), true);
  assert.strictEqual(fieldsEqual_('', null), true);
});

test('fieldsEqual_：數字與同值字串視為相等（SEQ_NO 比對用）', function () {
  assert.strictEqual(fieldsEqual_(10, '10'), true);
  assert.strictEqual(fieldsEqual_(10, 20), false);
});

// =====================================================================
// 4. AuditLog：只有真正改動的欄位才產生記錄（純函式）
// =====================================================================

test('computeFieldDiff_：完全沒有改動 → 回空陣列', function () {
  const existing = { A: '甲', B: '乙', C: 10 };
  const changes = computeFieldDiff_(existing, { A: '甲', B: '乙', C: 10 }, ['A', 'B', 'C']);
  assert.strictEqual(changes.length, 0);
});

test('computeFieldDiff_：只有一個欄位改了 → 只回那一項', function () {
  const existing = { A: '甲', B: '乙' };
  const changes = computeFieldDiff_(existing, { A: '甲', B: '丙' }, ['A', 'B']);
  assert.strictEqual(changes.length, 1);
  assert.strictEqual(changes[0].field, 'B');
  assert.strictEqual(changes[0].oldValue, '乙');
  assert.strictEqual(changes[0].newValue, '丙');
});

// =====================================================================
// 2／3. upsert：新增／修改／移除，重新編號成 10/20/30
// =====================================================================

test('computeListUpsertPlan_：新增／修改／移除三種情況一次覆蓋', function () {
  const existingRows = [
    { __rowNo: 3, SEQ_NO: 10, TEXT: 'A', ACTIVE: true },
    { __rowNo: 4, SEQ_NO: 20, TEXT: 'B', ACTIVE: true },
    { __rowNo: 5, SEQ_NO: 30, TEXT: 'C', ACTIVE: true }
  ];
  const payloadItems = [
    { seqNo: 20, TEXT: 'B 改過' },
    { seqNo: null, TEXT: 'D 新增' }
  ];
  const plan = computeListUpsertPlan_(existingRows, payloadItems, ['TEXT']);

  assert.strictEqual(plan.updates.length, 1, '只有 seqNo 20 那一行是修改');
  assert.strictEqual(plan.updates[0].rowNo, 4);
  assert.strictEqual(plan.updates[0].seqNoNew, 10, '第一項重新編號成 10');
  const textChange = plan.updates[0].changes.filter(function (c) { return c.field === 'TEXT'; })[0];
  assert.strictEqual(textChange.newValue, 'B 改過');

  assert.strictEqual(plan.appends.length, 1, '沒有 seqNo 的那一項是新增');
  assert.strictEqual(plan.appends[0].SEQ_NO, 20, '第二項重新編號成 20');
  assert.strictEqual(plan.appends[0].TEXT, 'D 新增');

  assert.strictEqual(plan.deactivations.length, 2, 'seqNo 10 與 30 都沒有被 payload 認領，要停用');
  const deactivatedRowNos = plan.deactivations.map(function (x) { return x.rowNo; }).sort();
  assertArrayEqual(deactivatedRowNos, [3, 5]);
});

test('computeListUpsertPlan_：移除的行是 ACTIVE=FALSE，不是被刪掉（deactivations 帶著原本的 rowNo）', function () {
  const existingRows = [{ __rowNo: 7, SEQ_NO: 10, TEXT: '要被移除', ACTIVE: true }];
  const plan = computeListUpsertPlan_(existingRows, [], ['TEXT']);
  assert.strictEqual(plan.deactivations.length, 1);
  assert.strictEqual(plan.deactivations[0].rowNo, 7, 'rowNo 保留，代表原地改 ACTIVE，不是刪除整行');
});

test('computeListUpsertPlan_：已經是 ACTIVE=FALSE 的行不會被重複停用（不產生多餘變動）', function () {
  const existingRows = [{ __rowNo: 3, SEQ_NO: 10, TEXT: '早就停用了', ACTIVE: false }];
  const plan = computeListUpsertPlan_(existingRows, [], ['TEXT']);
  assert.strictEqual(plan.deactivations.length, 0);
});

test('computeListUpsertPlan_：三項只是重新排序、內容不變 → SEQ_NO 變成 10/20/30，且沒有多餘欄位變動', function () {
  const existingRows = [
    { __rowNo: 3, SEQ_NO: 10, TEXT: 'A', ACTIVE: true },
    { __rowNo: 4, SEQ_NO: 20, TEXT: 'B', ACTIVE: true },
    { __rowNo: 5, SEQ_NO: 30, TEXT: 'C', ACTIVE: true }
  ];
  const payloadItems = [
    { seqNo: 30, TEXT: 'C' },
    { seqNo: 10, TEXT: 'A' },
    { seqNo: 20, TEXT: 'B' }
  ];
  const plan = computeListUpsertPlan_(existingRows, payloadItems, ['TEXT']);

  assert.strictEqual(plan.updates.length, 3);
  assertArrayEqual(plan.updates.map(function (u) { return u.seqNoNew; }), [10, 20, 30]);
  plan.updates.forEach(function (u) {
    assert.strictEqual(u.changes.length, 1, '內容沒變，應該只有 SEQ_NO 這一項變動：' + JSON.stringify(u.changes));
    assert.strictEqual(u.changes[0].field, 'SEQ_NO');
  });
  assert.strictEqual(plan.appends.length, 0);
  assert.strictEqual(plan.deactivations.length, 0);
});

// =====================================================================
// 7. 權限（純函式）
// =====================================================================

test('isEmailAuthorized_：WEBAPP_ALLOWED_EMAILS 空白 → 只有部署者本人（effectiveEmail）可用', function () {
  assert.strictEqual(isEmailAuthorized_('a@x.com', [], 'a@x.com'), true);
  assert.strictEqual(isEmailAuthorized_('b@x.com', [], 'a@x.com'), false);
});

test('isEmailAuthorized_：WEBAPP_ALLOWED_EMAILS 有值 → 名單內就可以，不看 effectiveEmail', function () {
  assert.strictEqual(isEmailAuthorized_('a@x.com', ['a@x.com', 'b@x.com'], 'c@x.com'), true);
});

test('isEmailAuthorized_：呼叫者不在名單內 → 拒絕', function () {
  assert.strictEqual(isEmailAuthorized_('z@x.com', ['a@x.com'], 'a@x.com'), false);
});

test('isEmailAuthorized_：比對不分大小寫', function () {
  assert.strictEqual(isEmailAuthorized_('A@X.COM', ['a@x.com'], ''), true);
});

test('isEmailAuthorized_：呼叫者電郵查不到（空字串）→ 一律拒絕', function () {
  assert.strictEqual(isEmailAuthorized_('', [], ''), false);
  assert.strictEqual(isEmailAuthorized_('', ['a@x.com'], 'a@x.com'), false);
});

// =====================================================================
// 由真正入口 saveWeekFromWebApp_() 叫下去（假 SpreadsheetApp 替身）
// =====================================================================

function ownSheetFor(sandboxRef, sheetId, rows) {
  const def = sandboxRef.COLUMNS[sheetId];
  return makeFakeSheet(def.headers, def.keys, rows || []);
}

function makeEnv(options) {
  const o = options || {};
  const freshSandbox = loadAllSrcFilesInOrder(GAS_STUBS);
  const sheets = {
    BulletinWeeks: ownSheetFor(freshSandbox, 'BULLETIN_WEEKS', o.bulletinWeeks || []),
    Announcements: ownSheetFor(freshSandbox, 'ANNOUNCEMENTS', o.announcements || []),
    Prayers: ownSheetFor(freshSandbox, 'PRAYERS', o.prayers || []),
    Fellowships: ownSheetFor(freshSandbox, 'FELLOWSHIPS', o.fellowships || []),
    Finance: ownSheetFor(freshSandbox, 'FINANCE', o.finance || []),
    AuditLog: ownSheetFor(freshSandbox, 'AUDIT_LOG', [])
  };
  const FakeApp = { getActiveSpreadsheet: function () { return makeFakeSpreadsheet(sheets); } };
  return {
    sheets: sheets,
    sandbox: loadAllSrcFilesInOrder(Object.assign({}, GAS_STUBS, { SpreadsheetApp: FakeApp }))
  };
}

function basicPayload(overrides) {
  return Object.assign({
    isoDate: '2027-10-03',
    lastSavedAt: null,
    week: {},
    announcements: [],
    prayers: [],
    fellowships: [],
    finance: []
  }, overrides || {});
}

test('真正入口：第一次儲存（lastSavedAt 皆空）→ 成功，並寫入 12 個人數欄與團契日期，原樣保存', function () {
  const env = makeEnv({
    bulletinWeeks: [{ SERVICE_DATE: '2027-10-03', QUARTER_ID: '2027T4', WEEK_OF_MONTH: 1, STATUS: 'DRAFT' }]
  });

  const payload = basicPayload({
    week: {
      ATT_ENG_WORSHIP: '45', ATT_CANE_WORSHIP: '前:5 / 後:120', ATT_CANN_WORSHIP: '--', ATT_MAN_WORSHIP: '60',
      ATT_ENG_PRAYER: '--', ATT_CANE_PRAYER: '--', ATT_CANN_PRAYER: '--', ATT_MAN_PRAYER: '--',
      ATT_ENG_CHILD: '--', ATT_CANE_CHILD: '--', ATT_CANN_CHILD: '--', ATT_MAN_CHILD: '--'
    },
    fellowships: [{ seqNo: null, FELLOWSHIP_NAME: '安提阿團契', MEETING_DATE: '10/5 星期日', MEETING_TIME: '4:30pm', CONTENT: '查經' }]
  });

  const result = env.sandbox.saveWeekFromWebApp_(payload);
  assert.ok(result.changedFieldCount > 0);
  assert.ok(result.lastSavedAt, 'lastSavedAt 要有值');

  const week = env.sandbox.readSheet('BulletinWeeks')[0];
  assert.strictEqual(week.ATT_CANE_WORSHIP, '前:5 / 後:120', '人數欄原樣保存，不是數字');
  assert.strictEqual(week.ATT_CANN_WORSHIP, '--');
  assert.strictEqual(typeof week.ATT_ENG_WORSHIP, 'string');

  const fellowship = env.sandbox.readSheet('Fellowships')[0];
  assert.strictEqual(fellowship.MEETING_DATE, '10/5 星期日', '團契日期原樣保存，不可以變成 Date');
  assert.strictEqual(typeof fellowship.MEETING_DATE, 'string');

  const auditRows = env.sandbox.readSheet('AuditLog');
  assert.ok(auditRows.length > 0, '應該有 AuditLog 記錄');
  assert.ok(
    auditRows.every(function (r) { return r.ACTION === 'WEBAPP_SAVE_WEEK' || r.ACTION === 'WEBAPP_SAVE_FELLOWSHIPS'; }),
    '實際 ACTION：' + JSON.stringify(auditRows.map(function (r) { return r.ACTION; }))
  );
});

test('真正入口：樂觀鎖不符 → 拋 STALE 且完全沒有寫入動作', function () {
  const env = makeEnv({
    bulletinWeeks: [{ SERVICE_DATE: '2027-10-03', QUARTER_ID: '2027T4', WEEK_OF_MONTH: 1, STATUS: 'DRAFT', SERMON_TITLE: '原本的講題' }]
  });

  const before = {
    week: JSON.stringify(env.sandbox.readSheet('BulletinWeeks')),
    audit: JSON.stringify(env.sandbox.readSheet('AuditLog'))
  };

  assert.throws(function () {
    env.sandbox.saveWeekFromWebApp_(basicPayload({
      lastSavedAt: env.sandbox.normalizeDate_('2020-01-01'), // 一定跟現有的（空白）對不上
      week: { SERMON_TITLE: '想要改成這個講題' }
    }));
  }, function (err) { return err.code === 'STALE'; }, '應該拋出 code=STALE 的錯誤');

  const after = {
    week: JSON.stringify(env.sandbox.readSheet('BulletinWeeks')),
    audit: JSON.stringify(env.sandbox.readSheet('AuditLog'))
  };
  assert.strictEqual(after.week, before.week, 'BulletinWeeks 不應該有任何變動');
  assert.strictEqual(after.audit, before.audit, 'AuditLog 不應該有任何新記錄');
});

test('真正入口：沒有改動的欄位重新儲存同樣的內容 → changedFieldCount 為 0（AuditLog 沒有多餘記錄）', function () {
  const env = makeEnv({
    bulletinWeeks: [{ SERVICE_DATE: '2027-10-03', QUARTER_ID: '2027T4', WEEK_OF_MONTH: 1, STATUS: 'DRAFT' }]
  });

  const first = env.sandbox.saveWeekFromWebApp_(basicPayload({
    week: { SERMON_TITLE: '講題甲' },
    announcements: [{ seqNo: null, TEXT: '第一則' }]
  }));
  assert.ok(first.changedFieldCount > 0);

  const savedWeek = env.sandbox.readSheet('BulletinWeeks')[0];
  const savedAnnouncements = env.sandbox.readSheet('Announcements');

  const second = env.sandbox.saveWeekFromWebApp_(basicPayload({
    lastSavedAt: savedWeek.LAST_SAVED_AT,
    week: { SERMON_TITLE: '講題甲' },
    announcements: [{ seqNo: savedAnnouncements[0].SEQ_NO, TEXT: '第一則' }]
  }));

  assert.strictEqual(second.changedFieldCount, 0, '內容完全沒變，不應該產生任何新的 AuditLog 記錄');
});

test('真正入口：家事報告刪一項再儲存 → 該行 ACTIVE=FALSE，工作表上仍然找得到（沒有被刪除）', function () {
  const env = makeEnv({
    bulletinWeeks: [{ SERVICE_DATE: '2027-10-03', QUARTER_ID: '2027T4', WEEK_OF_MONTH: 1, STATUS: 'DRAFT' }]
  });

  const first = env.sandbox.saveWeekFromWebApp_(basicPayload({
    announcements: [{ seqNo: null, TEXT: '要被刪的那一項' }]
  }));

  const savedWeek = env.sandbox.readSheet('BulletinWeeks')[0];

  env.sandbox.saveWeekFromWebApp_(basicPayload({
    lastSavedAt: savedWeek.LAST_SAVED_AT,
    announcements: []
  }));

  const rows = env.sandbox.readSheet('Announcements');
  assert.strictEqual(rows.length, 1, '整行仍然在，只是 ACTIVE 改掉');
  assert.strictEqual(rows[0].ACTIVE, false);
  assert.strictEqual(rows[0].TEXT, '要被刪的那一項', '內容沒有被清空');
});

// =====================================================================

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
