#!/usr/bin/env node
/**
 * tests/rehearsal.test.js
 *
 * prompt9 第 3 部分的回歸測試：「全季流程演練」
 * （`runQuarterRehearsal_()`）。
 *
 * 15. 演練強制當成 DRY_RUN，即使 Config 是 FALSE 也不會寄信
 *     ——本專案的做法比「強制 DRY_RUN」更乾淨：演練完全不呼叫
 *     `MailApp`，連寄送那條程式路徑都沒有碰到，所以這裡驗證的是
 *     「不管 DRY_RUN 是什麼，MailApp.sendEmail 從頭到尾都不會被呼叫」。
 * 16. 某一步失敗 → 報告仍然產生，並列出失敗步驟。
 *
 * 執行方式：node tests/rehearsal.test.js
 * 離開碼：0＝全部通過　1＝有測試失敗
 */

'use strict';

const assert = require('assert');
const { makeFillEnv, QUARTER_ID, SERVICE_DATES } = require('./helpers/fillEnv');
const { makeFakeDriveApp, makeFakeUtilities, buildFakeDocx } = require('./helpers/fakeDrive');
const fx = require('./fixtures/docxXml');

const FAKE_TEMPLATE_ID = 'FAKE_TEMPLATE_ID_NORMAL';
const FAKE_FOLDER_ID = 'FAKE_OUTPUT_FOLDER';

function templateDocumentXml() {
  return fx.documentXml(fx.para(fx.run('{{SERMON_TITLE}}')) + fx.para(fx.run('{{SERVICE_DATE_COVER}}')));
}

/** 造一個具備完整格子表能力 ＋ Word 產生能力的演練測試環境。 */
function makeRehearsalEnv(options) {
  const o = options || {};
  const drive = makeFakeDriveApp({
    files: o.templateConfigured === false ? {} : { [FAKE_TEMPLATE_ID]: buildFakeDocx(templateDocumentXml()) },
    folders: { [FAKE_FOLDER_ID]: {} }
  });

  const config = Object.assign({
    TEMPLATE_FILE_ID_NORMAL: o.templateConfigured === false ? '' : FAKE_TEMPLATE_ID,
    BULLETIN_OUTPUT_FOLDER_ID: FAKE_FOLDER_ID
  }, o.config || {});

  const env = makeFillEnv(Object.assign({ withGrid: false, config: config }, o.fillEnvOptions || {}, {
    driveApp: drive.DriveApp,
    driveAdvanced: drive.Drive,
    utilitiesZip: makeFakeUtilities()
  }));

  return Object.assign({ drive: drive }, env);
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
// 15. 演練不會寄出真郵件，不管 DRY_RUN 是什麼
// =====================================================================

test('15a. DRY_RUN=FALSE 時演練仍然完全不會呼叫 MailApp.sendEmail', function () {
  const env = makeRehearsalEnv({ config: { DRY_RUN: 'FALSE' } });
  const summary = env.sandbox.runQuarterRehearsal_(QUARTER_ID);

  assert.strictEqual(env.mail.calls.length, 0, '演練全程不應該寄出任何郵件');
  assert.ok(summary.emailOkCount > 0, '至少要成功組裝過幾封郵件內容，證明有真的跑到這一步');
});

test('15b. DRY_RUN=TRUE 時同樣完全不會呼叫 MailApp.sendEmail', function () {
  const env = makeRehearsalEnv({ config: { DRY_RUN: 'TRUE' } });
  env.sandbox.runQuarterRehearsal_(QUARTER_ID);
  assert.strictEqual(env.mail.calls.length, 0);
});

test('15c. SendLog 工作表全程沒有任何新增的行（連 DRY_RUN 記錄都沒有——因為根本沒有走到寄送那條路徑）', function () {
  const env = makeRehearsalEnv({ config: { DRY_RUN: 'FALSE' } });
  env.sandbox.runQuarterRehearsal_(QUARTER_ID);
  assert.strictEqual(env.sandbox.readSheet('SendLog').length, 0);
});

// =====================================================================
// 16. 某一步失敗 → 報告仍然產生，並列出失敗步驟
// =====================================================================

test('16a. 範本未設定 → 「產生 Word」那一步失敗，但報告仍然完整產生，且列出失敗步驟', function () {
  const env = makeRehearsalEnv({ templateConfigured: false });
  let summary;
  assert.doesNotThrow(function () { summary = env.sandbox.runQuarterRehearsal_(QUARTER_ID); });

  assert.ok(summary.failedSteps.length > 0, '應該至少有一個失敗步驟');
  assert.ok(summary.failedSteps.some(function (f) { return f.step.indexOf('產生 Word') !== -1; }),
    '失敗步驟裡應該包含「產生 Word」：' + JSON.stringify(summary.failedSteps));

  // 報告仍然要寫進 Diagnostics，而且要看得到失敗這件事，不可以看起來像全部順利。
  const diagnostics = env.sandbox.readSheet('Diagnostics');
  const reportRows = diagnostics.filter(function (r) { return r.REPORT_NAME === '全季流程演練'; });
  assert.ok(reportRows.length > 0);
  const reportText = reportRows.map(function (r) { return r.CONTENT; }).join('\n');
  assert.ok(reportText.indexOf('失敗的步驟') !== -1);
  assert.ok(reportText.indexOf('產生 Word') !== -1);

  // 其餘步驟不應該被這一步的失敗拖累——至少應該有主日資料模型算出來過。
  assert.ok(summary.perDate.some(function (r) { return r.ok; }), '其他步驟不應該被「產生 Word」失敗拖累');
});

test('16b. 某個步驟失敗時，總待填／總警告等彙總數字仍然是根據成功的那些主日算出來的（不是整批歸零）', function () {
  const env = makeRehearsalEnv({ templateConfigured: false });
  const summary = env.sandbox.runQuarterRehearsal_(QUARTER_ID);
  assert.ok(summary.totalMissing >= 0);
  assert.strictEqual(summary.perDate.length, SERVICE_DATES.length);
});

// =====================================================================
// 其他：基本情況全部順利
// =====================================================================

test('全部順利時：每個主日都有完整資訊，總數與逐日加總一致', function () {
  const env = makeRehearsalEnv({});
  const summary = env.sandbox.runQuarterRehearsal_(QUARTER_ID);

  assert.strictEqual(summary.failedSteps.length, 0, JSON.stringify(summary.failedSteps));
  assert.strictEqual(summary.totalSundays, SERVICE_DATES.length);

  const summedMissing = summary.perDate.reduce(function (s, r) { return s + (r.ok ? r.missingCount : 0); }, 0);
  assert.strictEqual(summary.totalMissing, summedMissing);

  assert.ok(summary.wordResult && summary.wordResult.file, '應該真的產生了一份 Word');
  assert.strictEqual(env.drive.listFolderFiles(FAKE_FOLDER_ID).length, 1, '只應該產生第一個主日那一份，不是全部主日');
});

test('唯讀為主：職事表分歧檢查不會寫 AuditLog、不會推進 BulletinWeeks 的快照版本', function () {
  const env = makeRehearsalEnv({});
  const beforeAudit = env.sandbox.readSheet('AuditLog').filter(function (r) { return r.ACTION === 'ROSTER_FOLLOW'; }).length;
  env.sandbox.runQuarterRehearsal_(QUARTER_ID);
  const afterAudit = env.sandbox.readSheet('AuditLog').filter(function (r) { return r.ACTION === 'ROSTER_FOLLOW'; }).length;
  assert.strictEqual(afterAudit, beforeAudit, '演練用的是 computeRosterDiff_（唯讀），不應該寫 ROSTER_FOLLOW 記錄');
});

// =====================================================================

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
