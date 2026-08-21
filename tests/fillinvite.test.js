#!/usr/bin/env node
/**
 * tests/fillinvite.test.js
 *
 * 第八輪「季度填寫邀請」「工作表保護」「自動建立下一季」的回歸測試。
 *
 * 執行方式：node tests/fillinvite.test.js
 * 離開碼：0＝全部通過　1＝有測試失敗
 */

'use strict';

const assert = require('assert');
const { loadAllSrcFilesInOrder } = require('./helpers/loadGas');
const { makeFillEnv, QUARTER_ID, BASE_STUBS } = require('./helpers/fillEnv');

const sandbox = loadAllSrcFilesInOrder(Object.assign({}, BASE_STUBS, { SpreadsheetApp: {} }));
const { buildFillInviteHtml_, buildFillProgressByGroup_, protectedSheetNames_, RECIPIENT_GROUP } = sandbox;

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

/** 建好格子表的環境（邀請信一定要有格子表才寄得出）。 */
function makeInvitedEnv(options) {
  const env = makeFillEnv(Object.assign({ withGrid: false }, options || {}));
  env.sandbox.createOrRefreshFillGrid_(QUARTER_ID);
  return env;
}

// =====================================================================
// 1. 郵件含正確的 #gid= 連結
// =====================================================================

test('1. 邀請信含直達季度填寫表的 #gid= 連結', function () {
  const env = makeInvitedEnv({ config: { DRY_RUN: 'FALSE' } });
  const result = env.sandbox.sendFillInvite_(QUARTER_ID);

  assert.strictEqual(result.sent, true, JSON.stringify(result));
  const html = env.mail.calls[0].htmlBody;
  assert.ok(html.indexOf('#gid=') !== -1, '一定要有 #gid= 直達連結：' + html.slice(0, 400));
});

test('1b. 邀請信含家事報告／代禱事項／財政三張表的直達連結', function () {
  const env = makeInvitedEnv({ config: { DRY_RUN: 'FALSE' } });
  env.sandbox.sendFillInvite_(QUARTER_ID);

  const html = env.mail.calls[0].htmlBody;
  assert.ok(html.indexOf('家事報告') !== -1);
  assert.ok(html.indexOf('代禱事項') !== -1);
  assert.ok(html.indexOf('月度財政報告') !== -1);
  // 四條 #gid= 連結：格子表 ＋ 三張清單表
  assert.ok((html.match(/#gid=/g) || []).length >= 4, '四張表都要有直達連結');
});

test('1c. 邀請信含 Web App 網址（有設定時）', function () {
  const env = makeInvitedEnv({ config: { DRY_RUN: 'FALSE', WEBAPP_URL: 'https://script.google.com/macros/s/FAKE/exec' } });
  env.sandbox.sendFillInvite_(QUARTER_ID);
  assert.ok(env.mail.calls[0].htmlBody.indexOf('script.google.com') !== -1);
});

test('1d. Web App 網址未設定時，不會出現一條空連結', function () {
  const env = makeInvitedEnv({ config: { DRY_RUN: 'FALSE', WEBAPP_URL: '' } });
  env.sandbox.sendFillInvite_(QUARTER_ID);
  assert.strictEqual(env.mail.calls[0].htmlBody.indexOf('逐週填寫介面'), -1,
    '沒有網址就不應該列出那一項');
});

test('1e. 邀請信含主日清單與待填統計', function () {
  const env = makeInvitedEnv({ config: { DRY_RUN: 'FALSE' } });
  env.sandbox.sendFillInvite_(QUARTER_ID);

  const html = env.mail.calls[0].htmlBody;
  assert.ok(html.indexOf('2027-11-07') !== -1, '要列出主日清單');
  assert.ok(html.indexOf('崇拜程序') !== -1, '要有欄位群組的待填統計');
  assert.ok(html.indexOf('待填') !== -1);
});

test('1f. 邀請信含「哪些欄位由誰負責」那一句（來自 Config）', function () {
  const env = makeInvitedEnv({
    config: { DRY_RUN: 'FALSE', FILL_RESPONSIBILITY_NOTE: '詩歌由領詩填寫；講題由幹事填寫' }
  });
  env.sandbox.sendFillInvite_(QUARTER_ID);
  assert.ok(env.mail.calls[0].htmlBody.indexOf('詩歌由領詩填寫') !== -1);
});

test('1g. buildFillInviteHtml_ 是純函式，內容全部經過 HTML 跳脫', function () {
  const html = buildFillInviteHtml_({
    quarterId: '2027T4',
    serviceDates: ['2027-11-07'],
    progress: [{ group: '崇拜程序', filled: 1, total: 10, missing: 9 }],
    links: { grid: 'https://x.invalid/#gid=1', announcements: 'a', prayers: 'b', finance: 'c', webApp: '' },
    responsibilityNote: '<script>alert(1)</script>',
    churchName: '聖道堂'
  });
  assert.strictEqual(html.indexOf('<script>alert(1)</script>'), -1, '注入的標籤一定要被跳脫');
  assert.ok(html.indexOf('&lt;script&gt;') !== -1);
});

test('1h. 待填統計：已填與待填的數字正確', function () {
  const progress = buildFillProgressByGroup_([
    { isoDate: '2027-11-07', values: { SERMON_TITLE: '有值', HYMN_PRAISE: '', SCRIPTURE_REF: '有值' } },
    { isoDate: '2027-11-14', values: { SERMON_TITLE: '', HYMN_PRAISE: '', SCRIPTURE_REF: '' } }
  ]);
  const program = progress.filter(function (p) { return p.group === '崇拜程序'; })[0];
  assert.strictEqual(program.filled, 2, '兩個主日合共填了 2 格');
  assert.strictEqual(program.filled + program.missing, program.total);
});

// =====================================================================
// 2. DRY_RUN=TRUE 不呼叫 MailApp
// =====================================================================

test('2. DRY_RUN=TRUE：完全沒有呼叫 MailApp，但 SendLog 有記錄', function () {
  const env = makeInvitedEnv({ config: { DRY_RUN: 'TRUE' } });
  const result = env.sandbox.sendFillInvite_(QUARTER_ID);

  assert.strictEqual(result.sent, true);
  assert.strictEqual(result.dryRun, true);
  assert.strictEqual(env.mail.calls.length, 0, 'DRY_RUN 時絕對不可以呼叫 MailApp');

  const sendLog = env.sandbox.readSheet('SendLog');
  assert.ok(sendLog.length > 0);
  assert.strictEqual(sendLog[0].STATUS, 'FILL_INVITE');
  assert.strictEqual(sendLog[0].DRY_RUN, true);
});

test('2b. DRY_RUN=FALSE：真的寄出，SendLog 的 DRY_RUN 欄是 false', function () {
  const env = makeInvitedEnv({ config: { DRY_RUN: 'FALSE' } });
  env.sandbox.sendFillInvite_(QUARTER_ID);

  assert.ok(env.mail.calls.length > 0);
  const sendLog = env.sandbox.readSheet('SendLog');
  assert.strictEqual(sendLog[0].STATUS, 'FILL_INVITE');
  assert.strictEqual(sendLog[0].DRY_RUN, false);
});

test('2c. 收件人來自 FILL_INVITE_GROUPS（預設含 WORSHIP 領詩）', function () {
  const env = makeInvitedEnv({ config: { DRY_RUN: 'FALSE' } });
  const result = env.sandbox.sendFillInvite_(QUARTER_ID);

  assert.strictEqual(result.recipientCount, 2, 'ADMIN ＋ WORSHIP 兩位');
  const recipients = env.mail.calls.map(function (m) { return m.to; }).sort();
  assert.strictEqual(recipients.join(','), 'admin@x.com,worship@x.com');
});

test('2d. FILL_INVITE_GROUPS 改成只有 WORSHIP → 只寄給領詩', function () {
  const env = makeInvitedEnv({ config: { DRY_RUN: 'FALSE', FILL_INVITE_GROUPS: 'WORSHIP' } });
  const result = env.sandbox.sendFillInvite_(QUARTER_ID);
  assert.strictEqual(result.recipientCount, 1);
  assert.strictEqual(env.mail.calls[0].to, 'worship@x.com');
});

test('2e. 沒有收件人 → 不寄，明確訊息', function () {
  const env = makeInvitedEnv({ config: { DRY_RUN: 'FALSE' }, recipients: [] });
  const result = env.sandbox.sendFillInvite_(QUARTER_ID);
  assert.strictEqual(result.sent, false);
  assert.strictEqual(result.reason, 'NO_RECIPIENTS');
  assert.strictEqual(env.mail.calls.length, 0);
});

test('2f. 格子表還未建立 → 不寄，訊息叫人先建立填寫表', function () {
  const env = makeFillEnv({ withGrid: false, config: { DRY_RUN: 'FALSE' } });
  const result = env.sandbox.sendFillInvite_(QUARTER_ID);
  assert.strictEqual(result.sent, false);
  assert.strictEqual(result.reason, 'NO_FILL_GRID');
  assert.ok(result.message.indexOf('建立') !== -1);
});

// =====================================================================
// 3. 同一季不重複寄
// =====================================================================

test('3. 自動建立下一季：第一次會建立並寄邀請', function () {
  const env = makeFillEnv({ withGrid: false, config: { DRY_RUN: 'FALSE' } });
  const result = env.sandbox.autoCreateNextQuarterFillGrids_();

  assert.ok(result.created.indexOf(QUARTER_ID) !== -1, '應該建立了 ' + QUARTER_ID);
  assert.ok(result.invited.indexOf(QUARTER_ID) !== -1);
  assert.ok(env.mail.calls.length > 0);
});

test('3b. 自動建立下一季：第二次同一季不重複寄（指紋去重）', function () {
  const env = makeFillEnv({ withGrid: false, config: { DRY_RUN: 'FALSE' } });
  env.sandbox.autoCreateNextQuarterFillGrids_();
  const firstCallCount = env.mail.calls.length;

  const second = env.sandbox.autoCreateNextQuarterFillGrids_();
  assert.strictEqual(second.created.length, 0, '格子表已經存在，不應該再建立');
  assert.strictEqual(second.invited.length, 0);
  assert.strictEqual(env.mail.calls.length, firstCallCount, '同一季不可以重複寄邀請');
});

test('3c. 指紋記進 ConflictNoticeLog（重用第六輪的防重複機制）', function () {
  const env = makeFillEnv({ withGrid: false, config: { DRY_RUN: 'FALSE' } });
  env.sandbox.autoCreateNextQuarterFillGrids_();

  const log = env.sandbox.readSheet('ConflictNoticeLog');
  const inviteRow = log.filter(function (r) { return r.POST_ID === 'FILL_INVITE'; })[0];
  assert.ok(inviteRow, '應該記一筆 FILL_INVITE 指紋');
  assert.strictEqual(inviteRow.FINGERPRINT, 'FILL_INVITE|' + QUARTER_ID);
});

test('3d. ⚠️ DRY_RUN=TRUE 時不記指紋（試行不可以消耗掉真正的通知機會）', function () {
  const env = makeFillEnv({ withGrid: false, config: { DRY_RUN: 'TRUE' } });
  env.sandbox.autoCreateNextQuarterFillGrids_();

  const log = env.sandbox.readSheet('ConflictNoticeLog');
  assert.strictEqual(log.filter(function (r) { return r.POST_ID === 'FILL_INVITE'; }).length, 0,
    '⚠️ 指紋是會改變將來行為的**狀態**，試行模式不可以動它');
});

test('3e. FILL_AUTO_CREATE_NEXT_QUARTER=FALSE → 完全不自動建立', function () {
  const env = makeFillEnv({ withGrid: false, config: { DRY_RUN: 'FALSE', FILL_AUTO_CREATE_NEXT_QUARTER: 'FALSE' } });
  const result = env.sandbox.autoCreateNextQuarterFillGrids_();
  assert.strictEqual(result.created.length, 0);
  assert.strictEqual(env.mail.calls.length, 0);
});

test('3f. findQuartersWithoutFillGrid_：已建立的季度不會再列出', function () {
  const env = makeFillEnv({ withGrid: false });
  assert.ok(env.sandbox.findQuartersWithoutFillGrid_().indexOf(QUARTER_ID) !== -1, '一開始應該列出來');

  env.sandbox.createOrRefreshFillGrid_(QUARTER_ID);
  assert.strictEqual(env.sandbox.findQuartersWithoutFillGrid_().indexOf(QUARTER_ID), -1, '建立之後不應該再列出');
});

test('3g. listExistingFillGridQuarters_：列出全部已建立的季度', function () {
  const env = makeFillEnv({ withGrid: false });
  env.sandbox.createOrRefreshFillGrid_(QUARTER_ID);
  assert.ok(env.sandbox.listExistingFillGridQuarters_().indexOf(QUARTER_ID) !== -1);
});

// =====================================================================
// Recipients 新組別
// =====================================================================

test('Recipients：GROUP_NAME 允許值新增 IT 與 WORSHIP', function () {
  assert.strictEqual(RECIPIENT_GROUP.IT, 'IT');
  assert.strictEqual(RECIPIENT_GROUP.WORSHIP, 'WORSHIP');
  // 原有四個仍然在
  ['CC', 'DB', 'ADMIN', 'TEST'].forEach(function (g) {
    assert.strictEqual(RECIPIENT_GROUP[g], g);
  });
});

test('Recipients：IT 組別也收得到邀請', function () {
  const env = makeInvitedEnv({
    config: { DRY_RUN: 'FALSE', FILL_INVITE_GROUPS: 'IT' },
    recipients: [
      { RECIPIENT_ID: 'R3', NAME: '假丙', EMAIL: 'it@x.com', GROUP_NAME: 'IT', ACTIVE: true, EFFECTIVE_FROM: '', EFFECTIVE_TO: '', NOTES: '' }
    ]
  });
  const result = env.sandbox.sendFillInvite_(QUARTER_ID);
  assert.strictEqual(result.recipientCount, 1);
  assert.strictEqual(env.mail.calls[0].to, 'it@x.com');
});

// =====================================================================
// 工作表保護
// =====================================================================

test('保護清單：系統維護用的表在清單內', function () {
  const names = protectedSheetNames_();
  ['Config', 'Diagnostics', 'AuditLog', 'SendLog', 'ErrorLog', 'BulletinWeeks',
    'FillSnapshot', 'FillBackup', 'ConflictNoticeLog', 'DutyOverride'].forEach(function (n) {
    assert.ok(names.indexOf(n) !== -1, n + ' 應該受保護');
  });
});

test('保護清單：要交給人填的表**不**在清單內', function () {
  const names = protectedSheetNames_();
  ['Announcements', 'Prayers', 'Fellowships', 'Finance',
    'FellowshipDefaults', 'HonorificLookup', 'PersonDisplay', 'Recipients'].forEach(function (n) {
    assert.strictEqual(names.indexOf(n), -1, n + ' 要維持可編輯，不可以受保護');
  });
});

test('保護清單：Fill_* 格子表不在清單內（那正是要交給人填的）', function () {
  protectedSheetNames_().forEach(function (n) {
    assert.strictEqual(n.indexOf('Fill_'), -1, '格子表不可以受保護：' + n);
  });
});

test('applySheetProtection_：回報保護了幾多張表，並記 AuditLog', function () {
  const env = makeFillEnv({ withGrid: false });
  const result = env.sandbox.applySheetProtection_();

  assert.ok(result.protectedCount > 0);
  assert.ok(env.sandbox.readSheet('AuditLog').some(function (r) { return r.ACTION === 'APPLY_SHEET_PROTECTION'; }));
});

test('applySheetProtection_：PROTECTION_EDITOR_EMAILS 的例外編輯者會被套用', function () {
  const env = makeFillEnv({
    withGrid: false,
    config: { PROTECTION_EDITOR_EMAILS: 'helper1@x.com, helper2@x.com' }
  });
  const result = env.sandbox.applySheetProtection_();
  assert.strictEqual(result.editors.length, 2);
  assert.ok(result.editors.indexOf('helper1@x.com') !== -1);
});

test('applySheetProtection_：不合法的電郵（沒有 @）會被濾走', function () {
  const env = makeFillEnv({ withGrid: false, config: { PROTECTION_EDITOR_EMAILS: '唔係電郵, ok@x.com' } });
  const result = env.sandbox.applySheetProtection_();
  assert.strictEqual(result.editors.length, 1);
  assert.strictEqual(result.editors[0], 'ok@x.com');
});

// =====================================================================
// 定時對帳與衝突提醒
// =====================================================================

test('定時對帳：對全部已建立的格子表跑一次三方比對', function () {
  const env = makeFillEnv({ withGrid: false });
  env.sandbox.createOrRefreshFillGrid_(QUARTER_ID);

  const result = env.sandbox.reconcileAllFillGrids_();
  assert.strictEqual(result.quarters.length, 1);
  assert.strictEqual(result.quarters[0].quarterId, QUARTER_ID);
  assert.strictEqual(result.totalConflicts, 0);
});

test('定時對帳：有衝突時算得出總數', function () {
  const env = makeFillEnv({ withGrid: false });
  env.sandbox.createOrRefreshFillGrid_(QUARTER_ID);

  const sheet = env.sheets['Fill_' + QUARTER_ID];
  const row = env.sandbox.readFillGridRows_(QUARTER_ID)[0];
  sheet.getRange(row.rowNo, env.sandbox.fillGridColumnIndex_('SERMON_TITLE')).setValue('格子表的');
  env.sandbox.writeBulletinWeekField_(row.isoDate, 'SERMON_TITLE', '系統的');

  const result = env.sandbox.reconcileAllFillGrids_();
  assert.strictEqual(result.totalConflicts, 1);
});

test('衝突提醒信：DRY_RUN=TRUE 不呼叫 MailApp，但寫 SendLog', function () {
  const env = makeFillEnv({ withGrid: false, config: { DRY_RUN: 'TRUE' } });
  env.sandbox.createOrRefreshFillGrid_(QUARTER_ID);

  const sheet = env.sheets['Fill_' + QUARTER_ID];
  const row = env.sandbox.readFillGridRows_(QUARTER_ID)[0];
  sheet.getRange(row.rowNo, env.sandbox.fillGridColumnIndex_('SERMON_TITLE')).setValue('格子表的');
  env.sandbox.writeBulletinWeekField_(row.isoDate, 'SERMON_TITLE', '系統的');

  const reconciled = env.sandbox.reconcileAllFillGrids_();
  const notice = env.sandbox.sendFillConflictNotice_(reconciled);

  assert.strictEqual(notice.sent, true);
  assert.strictEqual(env.mail.calls.length, 0);
  assert.ok(env.sandbox.readSheet('SendLog').some(function (r) { return r.STATUS === 'FILL_CONFLICT_NOTICE'; }));
});

test('衝突提醒信：同一個衝突不重複寄（指紋去重）', function () {
  const env = makeFillEnv({ withGrid: false, config: { DRY_RUN: 'FALSE' } });
  env.sandbox.createOrRefreshFillGrid_(QUARTER_ID);

  const sheet = env.sheets['Fill_' + QUARTER_ID];
  const row = env.sandbox.readFillGridRows_(QUARTER_ID)[0];
  sheet.getRange(row.rowNo, env.sandbox.fillGridColumnIndex_('SERMON_TITLE')).setValue('格子表的');
  env.sandbox.writeBulletinWeekField_(row.isoDate, 'SERMON_TITLE', '系統的');

  const first = env.sandbox.sendFillConflictNotice_(env.sandbox.reconcileAllFillGrids_());
  assert.strictEqual(first.sent, true);
  const callCount = env.mail.calls.length;

  const second = env.sandbox.sendFillConflictNotice_(env.sandbox.reconcileAllFillGrids_());
  assert.strictEqual(second.sent, false);
  assert.strictEqual(second.reason, 'ALREADY_NOTIFIED');
  assert.strictEqual(env.mail.calls.length, callCount, '同一個衝突不可以重複轟炸');
});

test('衝突提醒信：內容含三個值（上次同步時／格子表／系統）', function () {
  const env = makeFillEnv({ withGrid: false, config: { DRY_RUN: 'FALSE' } });
  env.sandbox.createOrRefreshFillGrid_(QUARTER_ID);

  const sheet = env.sheets['Fill_' + QUARTER_ID];
  const row = env.sandbox.readFillGridRows_(QUARTER_ID)[0];
  env.sandbox.writeBulletinWeekField_(row.isoDate, 'SERMON_TITLE', '基準值');
  env.sandbox.syncFillGrid_(QUARTER_ID);

  sheet.getRange(row.rowNo, env.sandbox.fillGridColumnIndex_('SERMON_TITLE')).setValue('格子表的');
  env.sandbox.writeBulletinWeekField_(row.isoDate, 'SERMON_TITLE', '系統的');

  env.sandbox.sendFillConflictNotice_(env.sandbox.reconcileAllFillGrids_());
  const html = env.mail.calls[0].htmlBody;
  assert.ok(html.indexOf('基準值') !== -1, '要顯示上次同步時的值');
  assert.ok(html.indexOf('格子表的') !== -1);
  assert.ok(html.indexOf('系統的') !== -1);
  assert.ok(html.indexOf('不會自動選擇任何一邊') !== -1, '要講明系統沒有代人決定');
});

// =====================================================================
// 觸發器安裝
// =====================================================================

test('安裝同步觸發器：安裝前先刪同名的，不會重複', function () {
  const env = makeFillEnv({ withGrid: false });

  env.sandbox.removeTriggersByHandler_('onFillGridEdit_');
  assert.strictEqual(env.triggers.installed.length, 0);

  // 模擬人手安裝兩次
  env.sandbox.removeTriggersByHandler_('onFillGridEdit_');
  env.sandbox.ScriptApp.newTrigger('onFillGridEdit_').forSpreadsheet({}).onEdit().create();
  env.sandbox.removeTriggersByHandler_('onFillGridEdit_');
  env.sandbox.ScriptApp.newTrigger('onFillGridEdit_').forSpreadsheet({}).onEdit().create();

  const matching = env.triggers.installed.filter(function (t) { return t.getHandlerFunction() === 'onFillGridEdit_'; });
  assert.strictEqual(matching.length, 1, '連續安裝兩次仍然只應該有一個觸發器');
});

test('removeTriggersByHandler_：只刪指定 handler 的觸發器', function () {
  const env = makeFillEnv({ withGrid: false });
  env.sandbox.ScriptApp.newTrigger('onFillGridEdit_').forSpreadsheet({}).onEdit().create();
  env.sandbox.ScriptApp.newTrigger('weeklyBulletinSendTrigger_').timeBased().everyHours(1).create();

  const removed = env.sandbox.removeTriggersByHandler_('onFillGridEdit_');
  assert.strictEqual(removed, 1);
  assert.strictEqual(env.triggers.installed.length, 1);
  assert.strictEqual(env.triggers.installed[0].getHandlerFunction(), 'weeklyBulletinSendTrigger_');
});

// =====================================================================

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
