#!/usr/bin/env node
/**
 * tests/conflictnotice.test.js
 *
 * src/ConflictNotice.gs 的回歸測試（用假的 MailApp／SpreadsheetApp 替身，
 * 由真正入口 sendConflictNoticeIfNeeded_() 叫下去）。
 *
 * 1. 無衝突 → 不寄
 * 2. 有衝突 → 寄給 ADMIN 組，內容含三個值
 * 3. 同一指紋第二次 → 不寄；職事表再改 → 再寄
 * 4. DRY_RUN=TRUE → 不呼叫 MailApp，但有 SendLog
 *
 * 執行方式：node tests/conflictnotice.test.js
 * 離開碼：0＝全部通過　1＝有測試失敗
 */

'use strict';

const assert = require('assert');
const { loadAllSrcFilesInOrder } = require('./helpers/loadGas');
const { makeFakeSheet, makeFakeSpreadsheet } = require('./helpers/fakeSpreadsheet');

const FAKE_ROSTER_ID = 'FAKE_ROSTER_ID_FOR_CONFLICTNOTICE_TEST';
const ISO_DATE = '2027-10-03';

const GAS_STUBS = {
  Utilities: { formatDate: function () { return ''; } },
  Session: {
    getScriptTimeZone: function () { return 'Pacific/Auckland'; },
    getActiveUser: function () { return { getEmail: function () { return 'tester@x.com'; } }; },
    getEffectiveUser: function () { return { getEmail: function () { return 'tester@x.com'; } }; }
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

function makeFakeMailApp() {
  const calls = [];
  return {
    calls: calls,
    getRemainingDailyQuota: function () { return 1000; },
    sendEmail: function (message) { calls.push(message); }
  };
}

function ownSheetFor(sandboxRef, sheetId, rows) {
  const def = sandboxRef.COLUMNS[sheetId];
  return makeFakeSheet(def.headers, def.keys, rows || []);
}

function rosterSheetFor(sandboxRef, defKey, rows) {
  const keys = Object.keys(sandboxRef.ROSTER_TABLE_DEFS_[defKey].columns);
  return makeFakeSheet(keys, keys, rows || []);
}

/**
 * 造一個完整的假環境。
 * `o.rosterChairName` 決定職事表現時主席是誰；`o.overrideRosterValue`
 * 決定覆寫當時記下的職事表值（兩者不同就會產生 CONFLICT）。
 * `o.hasOverride` 為 false 時完全沒有覆寫（也就沒有衝突）。
 */
function makeEnv(o) {
  o = o || {};
  const freshSandbox = loadAllSrcFilesInOrder(GAS_STUBS);
  const rosterChairName = o.rosterChairName || '王美美';
  const hasOverride = o.hasOverride !== false;

  const configBase = {};
  freshSandbox.DEFAULTS.forEach(function (d) { configBase[d.key] = d.value; });
  configBase.ROSTER_SPREADSHEET_ID = FAKE_ROSTER_ID;
  Object.assign(configBase, o.config || {});

  const ownSheets = {};
  Object.keys(freshSandbox.SHEETS).forEach(function (sheetId) {
    ownSheets[freshSandbox.SHEETS[sheetId]] = ownSheetFor(freshSandbox, sheetId, []);
  });
  ownSheets.Config = ownSheetFor(freshSandbox, 'CONFIG', Object.keys(configBase).map(function (k) {
    return { KEY: k, VALUE: configBase[k], NOTE: '', EDITABLE: true };
  }));
  ownSheets.BulletinWeeks = ownSheetFor(freshSandbox, 'BULLETIN_WEEKS', [{
    SERVICE_DATE: ISO_DATE, QUARTER_ID: '2027T4', WEEK_OF_MONTH: 1, STATUS: 'DRAFT',
    ROSTER_SNAPSHOT_VERSION: 12
  }]);
  ownSheets.PostDisplay = ownSheetFor(freshSandbox, 'POST_DISPLAY', freshSandbox.seedPostDisplayRows_());
  ownSheets.Recipients = ownSheetFor(freshSandbox, 'RECIPIENTS', o.recipients || [
    { RECIPIENT_ID: 'R1', NAME: '假甲', EMAIL: 'admin@x.com', GROUP_NAME: 'ADMIN', ACTIVE: true, EFFECTIVE_FROM: '', EFFECTIVE_TO: '', NOTES: '' },
    { RECIPIENT_ID: 'R2', NAME: '假乙', EMAIL: 'deacon@x.com', GROUP_NAME: 'DB', ACTIVE: true, EFFECTIVE_FROM: '', EFFECTIVE_TO: '', NOTES: '' }
  ]);
  ownSheets.DutyOverride = ownSheetFor(freshSandbox, 'DUTY_OVERRIDE', hasOverride ? [{
    SERVICE_DATE: ISO_DATE, POST_ID: 'CHAIR', SLOT_INDEX: 1,
    OVERRIDE_NAME: '李小明',
    ROSTER_VALUE_AT_OVERRIDE: (o.overrideRosterValue === undefined) ? '陳大文' : o.overrideRosterValue,
    ROSTER_VERSION_AT_OVERRIDE: 12, OVERRIDE_AT: '', OVERRIDE_BY: '', REASON: '', ACTIVE: true, NOTES: ''
  }] : []);
  ownSheets.ConflictNoticeLog = ownSheetFor(freshSandbox, 'CONFLICT_NOTICE_LOG', o.noticeLog || []);

  const rosterSheets = {
    RosterAssignments: rosterSheetFor(freshSandbox, 'ASSIGNMENTS', [{
      QuarterID: '2027T4', VersionNo: 12, ServiceDate: ISO_DATE, PostID: 'CHAIR',
      SlotIndex: 1, PersonID: 'P9003', PersonNameSnapshot: rosterChairName, AssignSource: 'AUTO', Locked: false
    }]),
    RosterVersions: rosterSheetFor(freshSandbox, 'VERSIONS', [{ QuarterID: '2027T4', VersionNo: 12 }]),
    Quarters: rosterSheetFor(freshSandbox, 'QUARTERS', [{ QuarterID: '2027T4', Stage: 'OFFICIAL_SENT' }]),
    ServiceDates: rosterSheetFor(freshSandbox, 'SERVICE_DATES', [{
      ServiceDateID: 'SD1', QuarterID: '2027T4', ServiceDate: ISO_DATE, WeekIndex: 1,
      IsFirstSundayOfMonth: true, ServiceType: '主日崇拜', SpecialID: ''
    }]),
    SpecialSundays: rosterSheetFor(freshSandbox, 'SPECIAL_SUNDAYS', []),
    NameMapping: rosterSheetFor(freshSandbox, 'NAME_MAPPING', [{ PersonID: 'P9003', NameTC: rosterChairName, Active: true }]),
    Posts: rosterSheetFor(freshSandbox, 'POSTS', [
      { PostID: 'CHAIR', PostName_TC: '主席', SlotCount: 1, Frequency: 'WEEKLY', AutoGenerate: true, DisplayOrder: 10, Active: true, EmptyDisplay: 'PENDING' }
    ])
  };

  const fakeMailApp = makeFakeMailApp();
  const FakeApp = {
    getActiveSpreadsheet: function () { return makeFakeSpreadsheet(ownSheets); },
    openById: function (id) {
      if (id !== FAKE_ROSTER_ID) throw new Error('openById: 未預期的 id ' + id);
      return makeFakeSpreadsheet(rosterSheets);
    }
  };

  return {
    sandbox: loadAllSrcFilesInOrder(Object.assign({}, GAS_STUBS, { SpreadsheetApp: FakeApp, MailApp: fakeMailApp })),
    mailApp: fakeMailApp
  };
}

// =====================================================================
// 1. 無衝突 → 不寄
// =====================================================================

test('無覆寫（因此無衝突）→ 不寄，reason=NO_CONFLICT，完全沒有呼叫 MailApp', function () {
  const env = makeEnv({ hasOverride: false, config: { DRY_RUN: 'FALSE' } });
  const result = env.sandbox.sendConflictNoticeIfNeeded_(ISO_DATE);

  assert.strictEqual(result.sent, false);
  assert.strictEqual(result.reason, 'NO_CONFLICT');
  assert.strictEqual(env.mailApp.calls.length, 0);
  assert.strictEqual(env.sandbox.readSheet('SendLog').length, 0);
});

test('有覆寫但職事表沒有再改過（OVERRIDDEN，不是 CONFLICT）→ 不寄', function () {
  // 覆寫當時記下的職事表值 = 職事表現值 → OVERRIDDEN
  const env = makeEnv({ rosterChairName: '王美美', overrideRosterValue: '王美美', config: { DRY_RUN: 'FALSE' } });
  const result = env.sandbox.sendConflictNoticeIfNeeded_(ISO_DATE);

  assert.strictEqual(result.sent, false);
  assert.strictEqual(result.reason, 'NO_CONFLICT');
  assert.strictEqual(env.mailApp.calls.length, 0);
});

// =====================================================================
// 2. 有衝突 → 寄給 ADMIN 組，內容含三個值
// =====================================================================

test('有衝突 → 只寄給 ADMIN 組（不寄給 DB 組），內容同時含三個值', function () {
  const env = makeEnv({ rosterChairName: '王美美', overrideRosterValue: '陳大文', config: { DRY_RUN: 'FALSE' } });
  const result = env.sandbox.sendConflictNoticeIfNeeded_(ISO_DATE);

  assert.strictEqual(result.sent, true);
  assert.strictEqual(result.conflictCount, 1);
  assert.strictEqual(result.recipientCount, 1, 'CONFLICT_NOTICE_GROUPS 預設只有 ADMIN');
  assert.strictEqual(env.mailApp.calls.length, 1);
  assert.strictEqual(env.mailApp.calls[0].to, 'admin@x.com');

  const html = env.mailApp.calls[0].htmlBody;
  assert.ok(html.indexOf('陳大文') !== -1, '要有「你覆寫時職事表是」：' + html);
  assert.ok(html.indexOf('王美美') !== -1, '要有「職事表現在是」');
  assert.ok(html.indexOf('李小明') !== -1, '要有「週報現在顯示」');
  assert.ok(html.indexOf('本系統不會改動職事表') !== -1, '一定要有這一句');

  const plain = env.mailApp.calls[0].body;
  assert.ok(plain.indexOf('本系統不會改動職事表') !== -1, '純文字版同樣要有這一句');
});

test('有衝突但 ADMIN 組一個收件人都沒有 → 不寄，reason=NO_RECIPIENTS', function () {
  const env = makeEnv({
    rosterChairName: '王美美', overrideRosterValue: '陳大文', config: { DRY_RUN: 'FALSE' },
    recipients: [
      { RECIPIENT_ID: 'R2', NAME: '假乙', EMAIL: 'deacon@x.com', GROUP_NAME: 'DB', ACTIVE: true, EFFECTIVE_FROM: '', EFFECTIVE_TO: '', NOTES: '' }
    ]
  });
  const result = env.sandbox.sendConflictNoticeIfNeeded_(ISO_DATE);
  assert.strictEqual(result.sent, false);
  assert.strictEqual(result.reason, 'NO_RECIPIENTS');
  assert.strictEqual(env.mailApp.calls.length, 0);
});

test('CONFLICT_NOTICE_GROUPS 改成別的組別 → 寄給那一組（證明沒有寫死 ADMIN）', function () {
  const env = makeEnv({
    rosterChairName: '王美美', overrideRosterValue: '陳大文',
    config: { DRY_RUN: 'FALSE', CONFLICT_NOTICE_GROUPS: 'DB' }
  });
  const result = env.sandbox.sendConflictNoticeIfNeeded_(ISO_DATE);
  assert.strictEqual(result.sent, true);
  assert.strictEqual(env.mailApp.calls[0].to, 'deacon@x.com');
});

// =====================================================================
// 3. 同一指紋第二次 → 不寄；職事表再改 → 再寄
// =====================================================================

test('同一個衝突第二次 → 不寄（指紋已經記錄過），reason=ALREADY_NOTIFIED', function () {
  const env = makeEnv({ rosterChairName: '王美美', overrideRosterValue: '陳大文', config: { DRY_RUN: 'FALSE' } });

  const first = env.sandbox.sendConflictNoticeIfNeeded_(ISO_DATE);
  assert.strictEqual(first.sent, true);
  assert.strictEqual(env.mailApp.calls.length, 1);

  const second = env.sandbox.sendConflictNoticeIfNeeded_(ISO_DATE);
  assert.strictEqual(second.sent, false);
  assert.strictEqual(second.reason, 'ALREADY_NOTIFIED');
  assert.strictEqual(env.mailApp.calls.length, 1, '不可以重複轟炸');
  assert.strictEqual(second.conflictCount, 1, '衝突仍然存在，只是不再重複通知');
});

test('職事表再改一次（指紋變了）→ 再寄一次', function () {
  // 用「上一次已經通知過 王美美 這個值」的狀態開場，但職事表現在是 假丙。
  const previousFingerprint = [ISO_DATE, 'CHAIR', '1', '王美美'].join('#');
  const env = makeEnv({
    rosterChairName: '假丙', overrideRosterValue: '陳大文', config: { DRY_RUN: 'FALSE' },
    noticeLog: [{
      TIMESTAMP: '', SERVICE_DATE: ISO_DATE, POST_ID: 'CHAIR', SLOT_INDEX: 1,
      FINGERPRINT: previousFingerprint, ROSTER_VALUE: '王美美', NOTES: ''
    }]
  });

  const result = env.sandbox.sendConflictNoticeIfNeeded_(ISO_DATE);
  assert.strictEqual(result.sent, true, '職事表現值變了 → 指紋變了 → 是新資訊，要再寄');
  assert.strictEqual(env.mailApp.calls.length, 1);
  assert.ok(env.mailApp.calls[0].htmlBody.indexOf('假丙') !== -1);
});

test('指紋會寫進 ConflictNoticeLog（只新增，不覆寫既有記錄）', function () {
  const env = makeEnv({ rosterChairName: '王美美', overrideRosterValue: '陳大文', config: { DRY_RUN: 'FALSE' } });
  env.sandbox.sendConflictNoticeIfNeeded_(ISO_DATE);

  const rows = env.sandbox.readSheet('ConflictNoticeLog');
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].POST_ID, 'CHAIR');
  assert.strictEqual(rows[0].SLOT_INDEX, 1);
  assert.strictEqual(rows[0].ROSTER_VALUE, '王美美');
  assert.strictEqual(rows[0].FINGERPRINT, [ISO_DATE, 'CHAIR', '1', '王美美'].join('#'));
});

test('buildConflictFingerprint_：用職事表現值（不是週報現值）——職事表沒變就是同一個指紋', function () {
  const sb = loadAllSrcFilesInOrder(GAS_STUBS);
  const a = sb.buildConflictFingerprint_(ISO_DATE, 'CHAIR', 1, '王美美');
  const b = sb.buildConflictFingerprint_(ISO_DATE, 'CHAIR', 1, '王美美');
  const c = sb.buildConflictFingerprint_(ISO_DATE, 'CHAIR', 1, '假丙');
  assert.strictEqual(a, b);
  assert.notStrictEqual(a, c);
});

// =====================================================================
// 4. DRY_RUN=TRUE → 不呼叫 MailApp，但有 SendLog
// =====================================================================

test('DRY_RUN=TRUE：完全沒有呼叫 MailApp.sendEmail，但 SendLog 有記錄（STATUS=CONFLICT_NOTICE）', function () {
  const env = makeEnv({ rosterChairName: '王美美', overrideRosterValue: '陳大文', config: { DRY_RUN: 'TRUE' } });
  const result = env.sandbox.sendConflictNoticeIfNeeded_(ISO_DATE);

  assert.strictEqual(result.sent, true);
  assert.strictEqual(result.dryRun, true);
  assert.strictEqual(env.mailApp.calls.length, 0, 'DRY_RUN 時絕對不可以呼叫 MailApp.sendEmail');

  const sendLog = env.sandbox.readSheet('SendLog');
  assert.strictEqual(sendLog.length, 1);
  assert.strictEqual(sendLog[0].STATUS, 'CONFLICT_NOTICE');
  assert.strictEqual(sendLog[0].DRY_RUN, true);
});

test('DRY_RUN=TRUE：**不會**把指紋記進 ConflictNoticeLog——否則第一封真正的提醒信會被靜靜略過', function () {
  const env = makeEnv({ rosterChairName: '王美美', overrideRosterValue: '陳大文', config: { DRY_RUN: 'TRUE' } });
  env.sandbox.sendConflictNoticeIfNeeded_(ISO_DATE);

  assert.strictEqual(env.sandbox.readSheet('ConflictNoticeLog').length, 0,
    '指紋是「會改變將來行為的狀態」，試行模式不可以動它（SendLog 只是記錄，照寫沒問題）');

  // 再跑一次，仍然會「寄」——證明試行不會消耗掉通知機會。
  const second = env.sandbox.sendConflictNoticeIfNeeded_(ISO_DATE);
  assert.strictEqual(second.sent, true);
});

test('DRY_RUN=FALSE 時寄出之後，SendLog 的 STATUS 同樣是 CONFLICT_NOTICE、DRY_RUN 欄是 false', function () {
  const env = makeEnv({ rosterChairName: '王美美', overrideRosterValue: '陳大文', config: { DRY_RUN: 'FALSE' } });
  env.sandbox.sendConflictNoticeIfNeeded_(ISO_DATE);

  const sendLog = env.sandbox.readSheet('SendLog');
  assert.strictEqual(sendLog.length, 1);
  assert.strictEqual(sendLog[0].STATUS, 'CONFLICT_NOTICE');
  assert.strictEqual(sendLog[0].DRY_RUN, false);
  assert.strictEqual(sendLog[0].RECIPIENT_EMAIL, 'admin@x.com');
});

// =====================================================================
// 職事表唯讀
// =====================================================================

test('整個提醒流程完全不會寫入職事表（假職事表物件不支援寫入，有寫入就會拋錯）', function () {
  const env = makeEnv({ rosterChairName: '王美美', overrideRosterValue: '陳大文', config: { DRY_RUN: 'FALSE' } });
  assert.doesNotThrow(function () { env.sandbox.sendConflictNoticeIfNeeded_(ISO_DATE); });
});

// =====================================================================

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
