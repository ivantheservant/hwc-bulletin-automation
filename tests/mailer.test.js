#!/usr/bin/env node
/**
 * tests/mailer.test.js
 *
 * src/Mailer.gs 的回歸測試（用假的 MailApp／SpreadsheetApp 替身，由真正
 * 入口 sendBulletinForDate_() 叫下去）。
 *
 * 1. DRY_RUN=TRUE → 完全沒有呼叫 MailApp.sendEmail，SendLog 有記錄
 * 2. DRY_RUN=FALSE → 每個收件人一次 sendEmail
 * 3. 其中一個收件人拋錯 → 其餘照樣寄完，SendLog 有 FAILED 那一行
 * 4. 有任何失敗時 STATUS 不會變成 SENT
 * 5. 配額不足 → 一封都不寄並拋錯
 * 6. schema 落後且開關為 TRUE → 拒絕寄送
 * 7. 附件不可用 → 照樣寄，郵件正文含「未附上 Word 檔」的說明
 * 8. 由真正入口 sendBulletinForDate_() 叫下去（本檔案全部測試都是）
 *
 * 執行方式：node tests/mailer.test.js
 * 離開碼：0＝全部通過　1＝有測試失敗
 */

'use strict';

const assert = require('assert');
const { loadAllSrcFilesInOrder } = require('./helpers/loadGas');
const { makeFakeSheet, makeFakeSpreadsheet } = require('./helpers/fakeSpreadsheet');

const FAKE_ROSTER_ID = 'FAKE_ROSTER_ID_FOR_MAILER_TEST';

/** 支援本檔案用得到的樣式符號：yyyy／MM／dd／HH／mm／ss。 */
function formatDateForTest(date, pattern) {
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  return String(pattern)
    .replace(/yyyy/g, String(date.getFullYear()))
    .replace(/MM/g, pad2(date.getMonth() + 1))
    .replace(/dd/g, pad2(date.getDate()))
    .replace(/HH/g, pad2(date.getHours()))
    .replace(/mm/g, pad2(date.getMinutes()))
    .replace(/ss/g, pad2(date.getSeconds()));
}

const BASE_STUBS = {
  Utilities: { formatDate: function (date, tz, pattern) { return formatDateForTest(date, pattern); } },
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
 * 造一個假的 MailApp。`options.failFor` 是一個電郵地址集合，
 * `sendEmail()` 遇到 `to` 在集合內就拋錯，其餘正常記錄。
 */
function makeFakeMailApp(options) {
  const o = options || {};
  const failFor = o.failFor || [];
  const calls = [];
  return {
    calls: calls,
    getRemainingDailyQuota: function () { return (o.quota === undefined) ? 1000 : o.quota; },
    sendEmail: function (message) {
      calls.push(message);
      if (failFor.indexOf(message.to) !== -1) {
        throw new Error('模擬寄送失敗：' + message.to);
      }
    }
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

function configRows(sandboxRef, overrides) {
  const base = {};
  sandboxRef.DEFAULTS.forEach(function (item) { base[item.key] = item.value; });
  base.ROSTER_SPREADSHEET_ID = FAKE_ROSTER_ID;
  Object.assign(base, overrides || {});
  return Object.keys(base).map(function (key) {
    return { KEY: key, VALUE: base[key], NOTE: '', EDITABLE: true };
  });
}

/**
 * 造一個完整的假環境：週報自己的全部 17 張工作表（用 COLUMNS 定義直接
 * 造，schema 檢查天生會通過）＋ 職事表（openById 開出來）＋ 假 MailApp。
 * `o.recipients`／`o.emailTemplates`／`o.bulletinWeeks`／`o.mailAppOptions`
 * 可以覆寫對應的測試資料。
 */
function makeEnv(o) {
  o = o || {};
  const freshSandbox = loadAllSrcFilesInOrder(BASE_STUBS);
  const isoDate = o.isoDate || '2027-10-03';

  const serviceDates = [{
    ServiceDateID: 'SD-' + isoDate, QuarterID: '2027T4', ServiceDate: isoDate,
    WeekIndex: 1, IsFirstSundayOfMonth: true, ServiceType: '主日崇拜', SpecialID: ''
  }];
  const assignments = [{
    QuarterID: '2027T4', VersionNo: 2, ServiceDate: isoDate, PostID: 'CHAIR',
    SlotIndex: 1, PersonID: 'P9001', PersonNameSnapshot: '陳大文',
    AssignSource: 'AUTO', Locked: false
  }];

  const ownSheets = {};
  Object.keys(freshSandbox.SHEETS).forEach(function (sheetId) {
    ownSheets[freshSandbox.SHEETS[sheetId]] = ownSheetFor(freshSandbox, sheetId, []);
  });

  ownSheets.Config = makeFakeSheet(freshSandbox.COLUMNS.CONFIG.headers, freshSandbox.COLUMNS.CONFIG.keys, configRows(freshSandbox, o.config));
  ownSheets.BulletinWeeks = ownSheetFor(freshSandbox, 'BULLETIN_WEEKS', o.bulletinWeeks || [
    { SERVICE_DATE: isoDate, QUARTER_ID: '2027T4', WEEK_OF_MONTH: 1, STATUS: 'DRAFT', SERMON_TITLE: '因信稱義' }
  ]);
  ownSheets.PersonDisplay = ownSheetFor(freshSandbox, 'PERSON_DISPLAY', o.personDisplay || [
    { PERSON_ID: 'P9001', NAME_TC: '陳大文', HONORIFIC: '弟兄', DISPLAY_OVERRIDE: '', EFFECTIVE_FROM: '', EFFECTIVE_TO: '', ACTIVE: true, NOTES: '' }
  ]);
  ownSheets.PostDisplay = ownSheetFor(freshSandbox, 'POST_DISPLAY', freshSandbox.seedPostDisplayRows_());
  ownSheets.MergeGroups = ownSheetFor(freshSandbox, 'MERGE_GROUPS', freshSandbox.seedMergeGroupsRows_());
  ownSheets.ProgramTemplates = ownSheetFor(freshSandbox, 'PROGRAM_TEMPLATES', freshSandbox.seedProgramTemplatesRows_());
  ownSheets.EmailTemplates = ownSheetFor(freshSandbox, 'EMAIL_TEMPLATES', o.emailTemplates || freshSandbox.seedEmailTemplatesRows_());
  ownSheets.Recipients = ownSheetFor(freshSandbox, 'RECIPIENTS', o.recipients || [
    { RECIPIENT_ID: 'R1', NAME: '假甲', EMAIL: 'a@x.com', GROUP_NAME: 'CC', ACTIVE: true, EFFECTIVE_FROM: '', EFFECTIVE_TO: '', NOTES: '' },
    { RECIPIENT_ID: 'R2', NAME: '假乙', EMAIL: 'b@x.com', GROUP_NAME: 'CC', ACTIVE: true, EFFECTIVE_FROM: '', EFFECTIVE_TO: '', NOTES: '' }
  ]);

  const rosterSheets = {
    RosterAssignments: rosterSheetFor(freshSandbox, 'ASSIGNMENTS', o.assignments || assignments),
    RosterVersions: rosterSheetFor(freshSandbox, 'VERSIONS', [{ QuarterID: '2027T4', VersionNo: 2 }]),
    Quarters: rosterSheetFor(freshSandbox, 'QUARTERS', [{ QuarterID: '2027T4', Stage: 'OFFICIAL_SENT' }]),
    ServiceDates: rosterSheetFor(freshSandbox, 'SERVICE_DATES', o.serviceDates || serviceDates),
    SpecialSundays: rosterSheetFor(freshSandbox, 'SPECIAL_SUNDAYS', o.specialSundays || []),
    NameMapping: rosterSheetFor(freshSandbox, 'NAME_MAPPING', [{ PersonID: 'P9001', NameTC: '陳大文', Active: true }]),
    Posts: rosterSheetFor(freshSandbox, 'POSTS', [
      { PostID: 'CHAIR', PostName_TC: '主席', SlotCount: 1, Frequency: 'WEEKLY', AutoGenerate: true, DisplayOrder: 10, Active: true, EmptyDisplay: 'PENDING' }
    ])
  };

  const fakeMailApp = makeFakeMailApp(o.mailAppOptions);

  const FakeApp = {
    getActiveSpreadsheet: function () { return makeFakeSpreadsheet(ownSheets); },
    openById: function (id) {
      if (id !== FAKE_ROSTER_ID) throw new Error('openById: 未預期的 id ' + id);
      return makeFakeSpreadsheet(rosterSheets);
    },
    getUi: function () { throw new Error('makeEnv：測試沒有預期會呼叫 getUi()'); }
  };

  const sb = loadAllSrcFilesInOrder(Object.assign({}, BASE_STUBS, { SpreadsheetApp: FakeApp, MailApp: fakeMailApp }));
  return { sandbox: sb, mailApp: fakeMailApp, isoDate: isoDate };
}

// =====================================================================
// 1. DRY_RUN=TRUE → 完全沒有呼叫 MailApp.sendEmail，SendLog 有記錄
// =====================================================================

test('DRY_RUN=TRUE：完全沒有呼叫 MailApp.sendEmail，SendLog 每個收件人各一行、STATUS=DRY_RUN', function () {
  const env = makeEnv({ config: { DRY_RUN: 'TRUE' } });
  const result = env.sandbox.sendBulletinForDate_(env.isoDate, {});

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.dryRun, true);
  assert.strictEqual(env.mailApp.calls.length, 0, 'DRY_RUN 時絕對不可以呼叫 MailApp.sendEmail');

  const sendLogRows = env.sandbox.readSheet('SendLog');
  assert.strictEqual(sendLogRows.length, 2);
  sendLogRows.forEach(function (r) {
    assert.strictEqual(r.STATUS, 'DRY_RUN');
    assert.strictEqual(r.DRY_RUN, true);
  });
});

// =====================================================================
// 2. DRY_RUN=FALSE → 每個收件人一次 sendEmail
// =====================================================================

test('DRY_RUN=FALSE：每個收件人剛好呼叫一次 MailApp.sendEmail，SendLog 記 SENT', function () {
  const env = makeEnv({ config: { DRY_RUN: 'FALSE' } });
  const result = env.sandbox.sendBulletinForDate_(env.isoDate, {});

  assert.strictEqual(result.dryRun, false);
  assert.strictEqual(env.mailApp.calls.length, 2);
  assert.strictEqual(result.sentCount, 2);
  assert.strictEqual(result.failedCount, 0);

  const sendLogRows = env.sandbox.readSheet('SendLog');
  assert.strictEqual(sendLogRows.length, 2);
  sendLogRows.forEach(function (r) { assert.strictEqual(r.STATUS, 'SENT'); });
});

// =====================================================================
// 3. 其中一個收件人拋錯 → 其餘照樣寄完，SendLog 有 FAILED 那一行
// =====================================================================

test('其中一個收件人 sendEmail 拋錯：其餘收件人照樣寄完，SendLog 有 FAILED 那一行含錯誤訊息', function () {
  const env = makeEnv({ config: { DRY_RUN: 'FALSE' }, mailAppOptions: { failFor: ['a@x.com'] } });
  const result = env.sandbox.sendBulletinForDate_(env.isoDate, {});

  assert.strictEqual(result.sentCount, 1);
  assert.strictEqual(result.failedCount, 1);
  assert.strictEqual(env.mailApp.calls.length, 2, '兩個收件人都要嘗試寄送，不可以因為第一個失敗就中斷');

  const sendLogRows = env.sandbox.readSheet('SendLog');
  const failedRow = sendLogRows.filter(function (r) { return r.STATUS === 'FAILED'; })[0];
  const sentRow = sendLogRows.filter(function (r) { return r.STATUS === 'SENT'; })[0];
  assert.ok(failedRow, '應該有一行 FAILED');
  assert.ok(sentRow, '應該有一行 SENT');
  assert.strictEqual(failedRow.RECIPIENT_EMAIL, 'a@x.com');
  assert.ok(failedRow.ERROR.indexOf('a@x.com') !== -1, failedRow.ERROR);
});

// =====================================================================
// 4. 有任何失敗時 STATUS 不會變成 SENT
// =====================================================================

test('有任何收件人失敗時，BulletinWeeks 的 STATUS 不會變成 SENT', function () {
  const env = makeEnv({ config: { DRY_RUN: 'FALSE' }, mailAppOptions: { failFor: ['a@x.com'] } });
  env.sandbox.sendBulletinForDate_(env.isoDate, {});

  const week = env.sandbox.readSheet('BulletinWeeks')[0];
  assert.notStrictEqual(week.STATUS, 'SENT');
});

test('全部成功且非 DRY_RUN 時，BulletinWeeks 的 STATUS 會變成 SENT，SENT_AT 有值，且記一筆 AuditLog', function () {
  const env = makeEnv({ config: { DRY_RUN: 'FALSE' } });
  env.sandbox.sendBulletinForDate_(env.isoDate, {});

  const week = env.sandbox.readSheet('BulletinWeeks')[0];
  assert.strictEqual(week.STATUS, 'SENT');
  // `week.SENT_AT` 是在 vm sandbox 內用 normalizeDate_() 造出來的 Date，
  // 跟本檔案（外層 Node realm）的 Date 不是同一個建構子，instanceof 在
  // 這裡會誤判 false（見 docs/已知bug類型.md 的跨 realm 系列坑）；改用
  // Object.prototype.toString 判斷，這個判斷不受 realm 影響。
  assert.strictEqual(Object.prototype.toString.call(week.SENT_AT), '[object Date]');

  const auditRows = env.sandbox.readSheet('AuditLog');
  assert.ok(auditRows.some(function (r) { return r.ACTION === 'SEND_BULLETIN'; }));
});

test('DRY_RUN=TRUE 時，即使全部「成功」，BulletinWeeks 的 STATUS 也不會變成 SENT', function () {
  const env = makeEnv({ config: { DRY_RUN: 'TRUE' } });
  env.sandbox.sendBulletinForDate_(env.isoDate, {});
  const week = env.sandbox.readSheet('BulletinWeeks')[0];
  assert.notStrictEqual(week.STATUS, 'SENT');
});

// =====================================================================
// 5. 配額不足 → 一封都不寄並拋錯
// =====================================================================

test('MailApp 配額不足：一封都不寄，拋錯，SendLog 沒有任何新記錄', function () {
  const env = makeEnv({ config: { DRY_RUN: 'FALSE' }, mailAppOptions: { quota: 1 } }); // 2 個收件人，配額只有 1
  assert.throws(function () {
    env.sandbox.sendBulletinForDate_(env.isoDate, {});
  }, function (err) { return err.code === 'QUOTA_INSUFFICIENT'; });

  assert.strictEqual(env.mailApp.calls.length, 0);
  assert.strictEqual(env.sandbox.readSheet('SendLog').length, 0);
});

test('DRY_RUN=TRUE 時完全不檢查配額（反正不會真的寄）', function () {
  const env = makeEnv({ config: { DRY_RUN: 'TRUE' }, mailAppOptions: { quota: 0 } });
  assert.doesNotThrow(function () {
    env.sandbox.sendBulletinForDate_(env.isoDate, {});
  });
});

// =====================================================================
// 6. schema 落後且開關為 TRUE → 拒絕寄送
// =====================================================================

test('工作表結構落後且 SEND_BLOCK_IF_SCHEMA_OUTDATED=TRUE：拒絕寄送，不呼叫 MailApp', function () {
  const env = makeEnv({ config: { DRY_RUN: 'FALSE', SEND_BLOCK_IF_SCHEMA_OUTDATED: 'TRUE' } });
  // 故意破壞 BulletinWeeks 的結構（第 2 行機器鍵跑位）。
  env.sandbox.SpreadsheetApp.getActiveSpreadsheet().getSheetByName('BulletinWeeks')
    .getRange(2, 1, 1, 1).setValues([['WRONG_KEY']]);

  assert.throws(function () {
    env.sandbox.sendBulletinForDate_(env.isoDate, {});
  }, function (err) { return err.code === 'SCHEMA_OUTDATED'; });
  assert.strictEqual(env.mailApp.calls.length, 0);
});

test('工作表結構落後但 SEND_BLOCK_IF_SCHEMA_OUTDATED=FALSE：不因結構落差被擋（照常嘗試寄送）', function () {
  const env = makeEnv({ config: { DRY_RUN: 'TRUE', SEND_BLOCK_IF_SCHEMA_OUTDATED: 'FALSE' } });
  env.sandbox.SpreadsheetApp.getActiveSpreadsheet().getSheetByName('ErrorLog')
    .getRange(2, 1, 1, 1).setValues([['WRONG_KEY']]);

  assert.doesNotThrow(function () {
    env.sandbox.sendBulletinForDate_(env.isoDate, {});
  });
});

// =====================================================================
// 7. 附件不可用 → 照樣寄，郵件正文含「未附上 Word 檔」的說明
// =====================================================================

test('附件不可用（TEMPLATE_FILE_ID_NORMAL 留空）：照樣寄送成功，HTML 正文含「未附上 Word 檔」的說明', function () {
  const env = makeEnv({ config: { DRY_RUN: 'FALSE' } });
  const result = env.sandbox.sendBulletinForDate_(env.isoDate, {});

  assert.strictEqual(result.attachment.ok, false);
  assert.strictEqual(result.attachment.reason, 'NO_TEMPLATE');
  assert.strictEqual(result.sentCount, 2, '附件不可用不應該阻止寄送');

  const htmlBody = env.mailApp.calls[0].htmlBody;
  assert.ok(htmlBody.indexOf('未附上 Word 檔') !== -1, htmlBody);
  assert.ok(htmlBody.indexOf('尚未設定 Word 範本') !== -1, htmlBody);
});

test('附件不可用時，sendEmail 呼叫不應該帶 attachments 欄位', function () {
  const env = makeEnv({ config: { DRY_RUN: 'FALSE' } });
  env.sandbox.sendBulletinForDate_(env.isoDate, {});
  assert.strictEqual(env.mailApp.calls[0].attachments, undefined);
});

// =====================================================================
// 額外：沒有可用收件人 → 明確報錯，不是「寄了 0 封當成功」
// =====================================================================

test('Recipients 全部 ACTIVE=FALSE：sendBulletinForDate_() 拋錯（code=NO_RECIPIENTS），不是靜靜寄 0 封', function () {
  const env = makeEnv({
    recipients: [
      { RECIPIENT_ID: 'R1', NAME: '假甲', EMAIL: 'a@x.com', GROUP_NAME: 'CC', ACTIVE: false, EFFECTIVE_FROM: '', EFFECTIVE_TO: '', NOTES: '' }
    ]
  });
  assert.throws(function () {
    env.sandbox.sendBulletinForDate_(env.isoDate, {});
  }, function (err) { return err.code === 'NO_RECIPIENTS'; });
  assert.strictEqual(env.mailApp.calls.length, 0);
});

// =====================================================================
// 額外：職事表找不到該主日 → 明確拋錯
// =====================================================================

test('職事表找不到該主日：sendBulletinForDate_() 拋錯（code=ROSTER_NOT_FOUND）', function () {
  const env = makeEnv({ isoDate: '2027-10-03', serviceDates: [] });
  assert.throws(function () {
    env.sandbox.sendBulletinForDate_('2027-10-03', {});
  }, function (err) { return err.code === 'ROSTER_NOT_FOUND'; });
});

// =====================================================================

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
