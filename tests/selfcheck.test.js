#!/usr/bin/env node
/**
 * tests/selfcheck.test.js
 *
 * prompt9 第 4 部分的回歸測試：「完成度自我檢測」（`runSelfCheck_()`）。
 *
 * 17. 各種缺失情況下 🔴／🟡 的判定
 * 18. 全部齊備 → 0 個 🔴
 *
 * 執行方式：node tests/selfcheck.test.js
 * 離開碼：0＝全部通過　1＝有測試失敗
 */

'use strict';

const assert = require('assert');
const { makeFillEnv, QUARTER_ID } = require('./helpers/fillEnv');
const { makeFakeDriveApp, makeFakeUtilities, buildFakeDocx } = require('./helpers/fakeDrive');
const fx = require('./fixtures/docxXml');

const FAKE_TEMPLATE_NORMAL = 'FAKE_TEMPLATE_NORMAL';
const FAKE_TEMPLATE_BAPTISM = 'FAKE_TEMPLATE_BAPTISM';
const FAKE_TEMPLATE_ANNIVERSARY = 'FAKE_TEMPLATE_ANNIVERSARY';
const FAKE_FOLDER_ID = 'FAKE_OUTPUT_FOLDER';

/** 一個沒有任何自訂佔位符的乾淨範本——保證「範本用到但系統不提供」是 0。 */
function blankTemplateXml() {
  return fx.documentXml(fx.para(fx.run('固定內容，沒有任何佔位符')));
}

function makeEnv(options) {
  const o = options || {};

  const files = {};
  if (o.templates !== false) {
    files[FAKE_TEMPLATE_NORMAL] = buildFakeDocx(blankTemplateXml());
    if (o.baptismConfigured !== false) files[FAKE_TEMPLATE_BAPTISM] = buildFakeDocx(blankTemplateXml());
    if (o.anniversaryConfigured !== false) files[FAKE_TEMPLATE_ANNIVERSARY] = buildFakeDocx(blankTemplateXml());
  }

  const drive = makeFakeDriveApp({
    files: files,
    folders: o.folderExists === false ? {} : { [FAKE_FOLDER_ID]: {} },
    rootAccessError: o.rootAccessError
  });

  const config = Object.assign({
    TEMPLATE_FILE_ID_NORMAL: (o.templates === false || o.normalConfigured === false) ? '' : FAKE_TEMPLATE_NORMAL,
    TEMPLATE_FILE_ID_COMBINED_BAPTISM: (o.templates === false || o.baptismConfigured === false) ? '' : FAKE_TEMPLATE_BAPTISM,
    TEMPLATE_FILE_ID_ANNIVERSARY: (o.templates === false || o.anniversaryConfigured === false) ? '' : FAKE_TEMPLATE_ANNIVERSARY,
    BULLETIN_OUTPUT_FOLDER_ID: o.folderConfigured === false ? '' : FAKE_FOLDER_ID,
    WEBAPP_URL: o.webAppConfigured === false ? '' : 'https://script.google.com/macros/s/FAKE/exec'
  }, o.config || {});

  const env = makeFillEnv(Object.assign({ withGrid: false, config: config }, o.fillEnvOptions || {}, {
    driveApp: drive.DriveApp,
    utilitiesZip: makeFakeUtilities()
  }));

  return Object.assign({ drive: drive }, env);
}

function findItem(summary, labelSubstring) {
  return summary.items.filter(function (i) { return i.label.indexOf(labelSubstring) !== -1; });
}

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

// =====================================================================
// 17. 各種缺失情況下 🔴／🟡 的判定
// =====================================================================

test('17a. 職事表 ID 未設定 → 該項目是 🔴', function () {
  const env = makeEnv({ config: { ROSTER_SPREADSHEET_ID: '' } });
  const summary = env.sandbox.runSelfCheck_();
  const item = findItem(summary, '職事表試算表 ID')[0];
  assert.strictEqual(item.status, '🔴');
});

test('17b. 平常主日範本未設定 → 🔴；浸禮／堂慶範本未設定 → 🟡（不是核心功能）', function () {
  const env = makeEnv({ normalConfigured: false, baptismConfigured: false });
  const summary = env.sandbox.runSelfCheck_();
  assert.strictEqual(findItem(summary, '平常主日 Word 範本')[0].status, '🔴');
  assert.strictEqual(findItem(summary, '浸禮三堂聯合崇拜 Word 範本')[0].status, '🟡');
});

test('17c. 範本 ID 設定了但檔案讀不到（MIME 不對／檔案不存在）→ 🔴', function () {
  const env = makeEnv({ config: { TEMPLATE_FILE_ID_NORMAL: 'NONEXISTENT_ID' } });
  const summary = env.sandbox.runSelfCheck_();
  const item = findItem(summary, '平常主日 Word 範本')[0];
  assert.strictEqual(item.status, '🔴');
  assert.ok(item.message.indexOf('讀取失敗') !== -1);
});

test('17d. 輸出資料夾未設定 → 🟡；設定了但資料夾不存在 → 🔴', function () {
  const notConfigured = makeEnv({ folderConfigured: false });
  assert.strictEqual(findItem(notConfigured.sandbox.runSelfCheck_(), '週報輸出資料夾')[0].status, '🟡');

  const notExist = makeEnv({ folderExists: false });
  assert.strictEqual(findItem(notExist.sandbox.runSelfCheck_(), '週報輸出資料夾')[0].status, '🔴');
});

test('17e. Recipients 完全沒有有效收件人 → 🟡', function () {
  const env = makeEnv({ fillEnvOptions: { recipients: [] } });
  const summary = env.sandbox.runSelfCheck_();
  assert.strictEqual(findItem(summary, 'Recipients 收件人')[0].status, '🟡');
});

test('17e-2. Recipients 有有效收件人（fillEnv 預設的 ADMIN／WORSHIP 各一位）→ 🟢', function () {
  const env = makeEnv({});
  const summary = env.sandbox.runSelfCheck_();
  const item = findItem(summary, 'Recipients 收件人')[0];
  assert.strictEqual(item.status, '🟢');
  assert.ok(item.message.indexOf('ADMIN') !== -1);
});

test('17f. WEBAPP_URL 是空的 → Web App 部署那一項是 🟡', function () {
  const env = makeEnv({ webAppConfigured: false });
  const summary = env.sandbox.runSelfCheck_();
  assert.strictEqual(findItem(summary, 'Web App 部署')[0].status, '🟡');
});

test('17g. 沒有安裝任何觸發器 → 三個觸發器項目都是 🟡', function () {
  const env = makeEnv({});
  const summary = env.sandbox.runSelfCheck_();
  assert.strictEqual(findItem(summary, '觸發器：自動寄送')[0].status, '🟡');
  assert.strictEqual(findItem(summary, '觸發器：填寫表同步')[0].status, '🟡');
  assert.strictEqual(findItem(summary, '觸發器：填寫表對帳')[0].status, '🟡');
  assert.strictEqual(findItem(summary, '下一季提示')[0].status, '🟡');
});

test('17h. 沒有設定任何工作表保護 → 🟡', function () {
  const env = makeEnv({});
  const summary = env.sandbox.runSelfCheck_();
  assert.strictEqual(findItem(summary, '工作表保護')[0].status, '🟡');
});

test('17i. ErrorLog 最近 7 日有錯誤 → 🟡；沒有 → 🟢', function () {
  const withError = makeEnv({});
  withError.sandbox.appendErrorLog_({ source: 'MENU', functionName: 'x', errorCode: 'E', message: '測試錯誤' });
  const summaryWithError = withError.sandbox.runSelfCheck_();
  assert.strictEqual(findItem(summaryWithError, 'ErrorLog 最近 7 日錯誤數')[0].status, '🟡');

  const clean = makeEnv({});
  const summaryClean = clean.sandbox.runSelfCheck_();
  assert.strictEqual(findItem(summaryClean, 'ErrorLog 最近 7 日錯誤數')[0].status, '🟢');
});

test('17j. 從未寄送過（SendLog 是空的）→ 🟡', function () {
  const env = makeEnv({});
  const summary = env.sandbox.runSelfCheck_();
  assert.strictEqual(findItem(summary, 'SendLog 最近一次寄送')[0].status, '🟡');
});

test('17k. 範本用到系統不提供的佔位符 → 該範本的佔位符對帳項目是 🔴', function () {
  const badTemplateXml = fx.documentXml(fx.para(fx.run('{{TYPO_PLACEHOLDER}}')));
  const drive = makeFakeDriveApp({
    files: { [FAKE_TEMPLATE_NORMAL]: buildFakeDocx(badTemplateXml) },
    folders: { [FAKE_FOLDER_ID]: {} }
  });
  const env = makeFillEnv({
    withGrid: false,
    config: { TEMPLATE_FILE_ID_NORMAL: FAKE_TEMPLATE_NORMAL, BULLETIN_OUTPUT_FOLDER_ID: FAKE_FOLDER_ID },
    driveApp: drive.DriveApp,
    utilitiesZip: makeFakeUtilities()
  });
  const summary = env.sandbox.runSelfCheck_();
  const item = findItem(summary, '範本佔位符對帳：平常主日')[0];
  assert.strictEqual(item.status, '🔴');
  assert.ok(item.message.indexOf('TYPO_PLACEHOLDER') !== -1);
});

// =====================================================================
// 18. 全部齊備 → 0 個 🔴
// =====================================================================

test('18. 全部齊備（設定齊全、範本乾淨、資料夾存在、觸發器已裝、保護已設）→ 0 個 🔴', function () {
  const env = makeEnv({});

  // 模擬三個觸發器都已經安裝——直接寫進 fillEnv 暴露的 triggers.installed，
  // 不呼叫真正的安裝函式：Trigger.gs 的 installWeeklySendTrigger_() 需要
  // ScriptApp.WeekDay 這個列舉，fillEnv 的假 ScriptApp 沒有實作它（那是
  // 另一個測試檔案的職責），這裡只需要「已安裝」這個事實本身。
  ['weeklyBulletinSendTrigger_', 'onFillGridEdit_', 'fillReconcileTrigger_'].forEach(function (handler) {
    env.triggers.installed.push({ getHandlerFunction: function () { return handler; } });
  });

  // 設定工作表保護。
  env.sandbox.applySheetProtection_();

  const summary = env.sandbox.runSelfCheck_();
  const redItems = summary.items.filter(function (i) { return i.status === '🔴'; });
  assert.strictEqual(redItems.length, 0, '不應該有任何 🔴：' + JSON.stringify(redItems));
});

test('17l. 「檢測季度」項一定存在，且職事表與 BulletinWeeks 都是 fillEnv 預設的 2027T4 時是 🟢', function () {
  const env = makeEnv({});
  const summary = env.sandbox.runSelfCheck_();
  const item = findItem(summary, '檢測季度')[0];
  assert.ok(item, '「檢測季度」這一項應該一定存在');
  assert.strictEqual(item.status, '🟢');
  assert.ok(item.message.indexOf('2027T4') !== -1, item.message);
});

// =====================================================================
// checkAuthorizationScopes_()：檢查授權範圍
// =====================================================================

test('checkAuthorizationScopes_：全部服務都叫得動 → 5 項全部 ok:true', function () {
  const env = makeEnv({});
  const results = env.sandbox.checkAuthorizationScopes_();
  assert.strictEqual(results.length, 5);
  results.forEach(function (r) {
    assert.strictEqual(r.ok, true, r.item + '：' + r.message);
  });
});

test('checkAuthorizationScopes_：DriveApp 授權不足 → 那一項 ok:false，訊息帶授權指引，其餘服務不受影響', function () {
  const authErr = new Error('You do not have permission to call DriveApp.getFileById.');
  const env = makeEnv({ rootAccessError: authErr });
  const results = env.sandbox.checkAuthorizationScopes_();

  const driveItem = results.filter(function (r) { return r.item.indexOf('DriveApp') !== -1; })[0];
  assert.strictEqual(driveItem.ok, false);
  assert.ok(driveItem.message.indexOf('授權範圍問題') !== -1, driveItem.message);

  const others = results.filter(function (r) { return r.item.indexOf('DriveApp') === -1; });
  others.forEach(function (r) { assert.strictEqual(r.ok, true, r.item + '：' + r.message); });
});

test('buildAuthorizationScopeReportLines_：全部可用時的摘要行；有失敗時列出失敗數與逐項結果', function () {
  const env = makeEnv({});
  const okLines = env.sandbox.buildAuthorizationScopeReportLines_([
    { item: 'A', ok: true, message: '可用。' }
  ]);
  assert.ok(okLines[0].indexOf('全部可用') !== -1, okLines[0]);

  const mixedLines = env.sandbox.buildAuthorizationScopeReportLines_([
    { item: 'A', ok: true, message: '可用。' },
    { item: 'B', ok: false, message: '授權範圍問題，去 Apps Script 編輯器重新授權。' }
  ]);
  assert.ok(mixedLines[0].indexOf('1 項未授權') !== -1, mixedLines[0]);
  assert.ok(mixedLines.some(function (l) { return l.indexOf('✗ 未授權') !== -1 && l.indexOf('B') !== -1; }));
});

test('menuCheckAuthorizationScopes_：把結果寫進 Diagnostics（報告名稱「檢查授權範圍」）', function () {
  const authErr = new Error('Authorization is required to perform that action.');
  const env = makeEnv({ rootAccessError: authErr });
  env.sandbox.menuCheckAuthorizationScopes_();

  const diagnostics = env.sandbox.readSheet('Diagnostics');
  const rows = diagnostics.filter(function (r) { return r.REPORT_NAME === '檢查授權範圍'; });
  assert.ok(rows.length > 0);
  assert.ok(rows.some(function (r) { return r.CONTENT.indexOf('DriveApp') !== -1; }));
});

// =====================================================================

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
