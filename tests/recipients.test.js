#!/usr/bin/env node
/**
 * tests/recipients.test.js
 *
 * src/Recipients.gs 的回歸測試：把 Recipients 工作表的資料列篩成「這一週
 * 真正要寄給誰」的清單。
 *
 * 1. 只取 ACTIVE=TRUE、只取 SEND_GROUPS 內的組別
 * 2. EFFECTIVE_FROM／TO 邊界（含當日）
 * 3. 重複電郵去重 + warning
 * 4. 不合法電郵被排除 + warning，其餘照樣寄
 * 5. 空結果回傳明確 reason
 *
 * 執行方式：node tests/recipients.test.js
 * 離開碼：0＝全部通過　1＝有測試失敗
 */

'use strict';

const assert = require('assert');
const { loadAllSrcFilesInOrder } = require('./helpers/loadGas');

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
const { buildRecipientList_ } = sandbox;

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

function recipientRow(overrides) {
  return Object.assign({
    RECIPIENT_ID: 'R1', NAME: '陳大文', EMAIL: 'a@x.com', GROUP_NAME: 'CC',
    ACTIVE: true, EFFECTIVE_FROM: null, EFFECTIVE_TO: null, NOTES: ''
  }, overrides || {});
}

// =====================================================================
// 1. 只取 ACTIVE=TRUE、只取 SEND_GROUPS 內的組別
// =====================================================================

test('buildRecipientList_：ACTIVE=FALSE 的行不會出現在結果內', function () {
  const result = buildRecipientList_([recipientRow({ ACTIVE: false })], ['CC'], d('2027-10-03'));
  assert.strictEqual(result.recipients.length, 0);
});

test('buildRecipientList_：GROUP_NAME 不在 SEND_GROUPS 內的行會被濾走', function () {
  const rows = [
    recipientRow({ EMAIL: 'a@x.com', GROUP_NAME: 'CC' }),
    recipientRow({ EMAIL: 'b@x.com', GROUP_NAME: 'TEST' })
  ];
  const result = buildRecipientList_(rows, ['CC', 'DB'], d('2027-10-03'));
  assert.strictEqual(result.recipients.length, 1);
  assert.strictEqual(result.recipients[0].email, 'a@x.com');
});

// =====================================================================
// 2. EFFECTIVE_FROM／TO 邊界（含當日）
// =====================================================================

test('buildRecipientList_：EFFECTIVE_FROM／TO 兩欄留空 → 不限，任何日期都生效', function () {
  const result = buildRecipientList_([recipientRow({})], ['CC'], d('2020-01-01'));
  assert.strictEqual(result.recipients.length, 1);
});

test('buildRecipientList_：目標日期剛好等於 EFFECTIVE_FROM → 生效（邊界含入）', function () {
  const result = buildRecipientList_([recipientRow({ EFFECTIVE_FROM: d('2027-10-03') })], ['CC'], d('2027-10-03'));
  assert.strictEqual(result.recipients.length, 1);
});

test('buildRecipientList_：目標日期剛好等於 EFFECTIVE_TO → 生效（邊界含入）', function () {
  const result = buildRecipientList_([recipientRow({ EFFECTIVE_TO: d('2027-10-03') })], ['CC'], d('2027-10-03'));
  assert.strictEqual(result.recipients.length, 1);
});

test('buildRecipientList_：目標日期早於 EFFECTIVE_FROM → 不生效', function () {
  const result = buildRecipientList_([recipientRow({ EFFECTIVE_FROM: d('2027-10-04') })], ['CC'], d('2027-10-03'));
  assert.strictEqual(result.recipients.length, 0);
});

test('buildRecipientList_：目標日期晚於 EFFECTIVE_TO → 不生效', function () {
  const result = buildRecipientList_([recipientRow({ EFFECTIVE_TO: d('2027-10-02') })], ['CC'], d('2027-10-03'));
  assert.strictEqual(result.recipients.length, 0);
});

// =====================================================================
// 3. 重複電郵去重 + warning
// =====================================================================

test('buildRecipientList_：同一個電郵出現多次 → 去重，保留第一個，並記一筆 warning', function () {
  const rows = [
    recipientRow({ RECIPIENT_ID: 'R1', NAME: '陳大文', EMAIL: 'a@x.com' }),
    recipientRow({ RECIPIENT_ID: 'R2', NAME: '李小明', EMAIL: 'A@X.COM' }) // 大小寫不同，仍算重複
  ];
  const result = buildRecipientList_(rows, ['CC'], d('2027-10-03'));
  assert.strictEqual(result.recipients.length, 1);
  assert.strictEqual(result.recipients[0].name, '陳大文', '保留第一個');
  assert.ok(result.warnings.some(function (w) { return w.code === 'DUPLICATE_EMAIL'; }));
});

// =====================================================================
// 4. 不合法電郵被排除 + warning，其餘照樣寄
// =====================================================================

test('buildRecipientList_：電郵沒有 @ → 排除並記 warning，其餘照樣寄', function () {
  const rows = [
    recipientRow({ EMAIL: 'not-an-email', NAME: '假甲' }),
    recipientRow({ EMAIL: 'ok@x.com', NAME: '假乙' })
  ];
  const result = buildRecipientList_(rows, ['CC'], d('2027-10-03'));
  assert.strictEqual(result.recipients.length, 1);
  assert.strictEqual(result.recipients[0].email, 'ok@x.com');
  assert.ok(result.warnings.some(function (w) { return w.code === 'INVALID_EMAIL'; }));
});

test('buildRecipientList_：電郵含空白 → 排除並記 warning', function () {
  const result = buildRecipientList_([recipientRow({ EMAIL: 'a b@x.com' })], ['CC'], d('2027-10-03'));
  assert.strictEqual(result.recipients.length, 0);
  assert.ok(result.warnings.some(function (w) { return w.code === 'INVALID_EMAIL'; }));
});

test('buildRecipientList_：電郵網域沒有點（缺頂層網域）→ 排除並記 warning', function () {
  const result = buildRecipientList_([recipientRow({ EMAIL: 'a@localhost' })], ['CC'], d('2027-10-03'));
  assert.strictEqual(result.recipients.length, 0);
  assert.ok(result.warnings.some(function (w) { return w.code === 'INVALID_EMAIL'; }));
});

// =====================================================================
// 5. 空結果回傳明確 reason
// =====================================================================

test('buildRecipientList_：完全沒有資料列 → recipients 空陣列，reason 講明沒有資料列', function () {
  const result = buildRecipientList_([], ['CC'], d('2027-10-03'));
  assert.strictEqual(result.recipients.length, 0);
  assert.ok(result.reason, '應該有明確的 reason，不可以是 null');
  assert.ok(result.reason.indexOf('沒有任何資料列') !== -1, result.reason);
});

test('buildRecipientList_：有資料列但全部被篩掉 → recipients 空陣列，reason 講明條件', function () {
  const result = buildRecipientList_([recipientRow({ ACTIVE: false })], ['CC'], d('2027-10-03'));
  assert.strictEqual(result.recipients.length, 0);
  assert.ok(result.reason, '應該有明確的 reason');
});

test('buildRecipientList_：有結果時 reason 是 null（不會誤導成「有問題」）', function () {
  const result = buildRecipientList_([recipientRow({})], ['CC'], d('2027-10-03'));
  assert.strictEqual(result.reason, null);
});

// =====================================================================
// 由真正入口 resolveRecipients_() 叫下去
// =====================================================================

test('真正入口：resolveRecipients_() 讀 Config 的 SEND_GROUPS 與 Recipients 工作表', function () {
  const { makeFakeSheet, makeFakeSpreadsheet } = require('./helpers/fakeSpreadsheet');
  const freshSandbox = loadAllSrcFilesInOrder(GAS_STUBS);
  const configRows = [
    { KEY: 'SEND_GROUPS', VALUE: 'CC', NOTE: '', EDITABLE: true }
  ];
  const recipientRows = [
    { RECIPIENT_ID: 'R1', NAME: '陳大文', EMAIL: 'a@x.com', GROUP_NAME: 'CC', ACTIVE: true, EFFECTIVE_FROM: '', EFFECTIVE_TO: '', NOTES: '' },
    { RECIPIENT_ID: 'R2', NAME: '李小明', EMAIL: 'b@x.com', GROUP_NAME: 'TEST', ACTIVE: true, EFFECTIVE_FROM: '', EFFECTIVE_TO: '', NOTES: '' }
  ];
  const sheets = {
    Config: makeFakeSheet(freshSandbox.COLUMNS.CONFIG.headers, freshSandbox.COLUMNS.CONFIG.keys, configRows),
    Recipients: makeFakeSheet(freshSandbox.COLUMNS.RECIPIENTS.headers, freshSandbox.COLUMNS.RECIPIENTS.keys, recipientRows)
  };
  const FakeApp = { getActiveSpreadsheet: function () { return makeFakeSpreadsheet(sheets); } };
  const sb = loadAllSrcFilesInOrder(Object.assign({}, GAS_STUBS, { SpreadsheetApp: FakeApp }));

  const result = sb.resolveRecipients_('2027-10-03');
  assert.strictEqual(result.recipients.length, 1, 'TEST 組別不在 SEND_GROUPS=CC 內，應該被濾走');
  assert.strictEqual(result.recipients[0].email, 'a@x.com');
});

// =====================================================================

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
