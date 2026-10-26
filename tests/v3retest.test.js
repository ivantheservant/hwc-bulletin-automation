#!/usr/bin/env node
/**
 * tests/v3retest.test.js
 *
 * v3 部署後重測的獨立審查（2026-10-27）找到的「只有正式寄送（DRY_RUN=FALSE）或真正日期才會出現」的問題：
 *   1. 星期一觸發器：那一期已經真的寄過就順延一週 → 提早 13 日寄出再下一期。改為只寄「今日或之後第一個主日」，
 *      寄過就略過（記 AuditLog），不改寄再下一期。
 *   2. 星期一自動寄內容表邀請：已完結、已封存、自測沙盒季度不理；人手真的寄過（任何入口）都記指紋，不再寄第二次。
 *   3. 草稿預覽信全部寄不出時講明失敗（觸發器靠它記 ErrorLog）。
 *   4. 草稿預覽信講的主日不是「下一個主日」時，連結帶日期；選單試寄只收星期日、真寄先問。
 *
 * 執行方式：node tests/v3retest.test.js
 * 離開碼：0＝全部通過　1＝有測試失敗
 */

'use strict';

const assert = require('assert');
const { loadAllSrcFilesInOrder } = require('./helpers/loadGas');
const { makeFakeSheet, makeFakeSpreadsheet } = require('./helpers/fakeSpreadsheet');
const { makeFillEnv } = require('./helpers/fillEnv');

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
    console.log('    ' + (err && err.stack ? err.stack.split('\n').slice(0, 6).join('\n    ') : err));
  }
}
function plain(v) { return JSON.parse(JSON.stringify(v)); }

/** 用假的「今日」載入全部 src（Utilities.formatDate 回固定日期）。 */
function makeEnv(todayIso, options) {
  const o = options || {};
  const stubs = {
    Utilities: { formatDate: function (d, tz, p) { return p === 'yyyy-MM-dd' ? todayIso : todayIso + ' 06:00:00'; } },
    Session: { getScriptTimeZone: function () { return 'Pacific/Auckland'; }, getActiveUser: function () { return { getEmail: function () { return ''; } }; } },
    CacheService: {}, HtmlService: {}
  };
  const base = loadAllSrcFilesInOrder(stubs);
  const cfg = {};
  base.DEFAULTS.forEach(function (i) { cfg[i.key] = i.value; });
  Object.assign(cfg, o.config || {});
  function weekRow(qid, iso, extra) {
    const r = {};
    base.COLUMNS.BULLETIN_WEEKS.keys.forEach(function (k) { r[k] = ''; });
    return Object.assign(r, { QUARTER_ID: qid, SERVICE_DATE: iso }, extra || {});
  }
  const sheets = {
    Config: makeFakeSheet(base.COLUMNS.CONFIG.headers, base.COLUMNS.CONFIG.keys,
      Object.keys(cfg).map(function (k) { return { KEY: k, VALUE: cfg[k], NOTE: '', EDITABLE: true }; })),
    ErrorLog: makeFakeSheet(base.COLUMNS.ERROR_LOG.headers, base.COLUMNS.ERROR_LOG.keys, []),
    AuditLog: makeFakeSheet(base.COLUMNS.AUDIT_LOG.headers, base.COLUMNS.AUDIT_LOG.keys, []),
    SendLog: makeFakeSheet(base.COLUMNS.SEND_LOG.headers, base.COLUMNS.SEND_LOG.keys, o.sendLog || []),
    BulletinWeeks: makeFakeSheet(base.COLUMNS.BULLETIN_WEEKS.headers, base.COLUMNS.BULLETIN_WEEKS.keys,
      (o.weeks || []).map(function (w) { return weekRow(w[0], w[1], w[2]); }))
  };
  const sb = loadAllSrcFilesInOrder(Object.assign({}, stubs, {
    SpreadsheetApp: { getActiveSpreadsheet: function () { return makeFakeSpreadsheet(sheets); } }, ScriptApp: {}
  }));
  return { sandbox: sb, sheets: sheets };
}

function sentRow(iso) {
  return { TIMESTAMP: '2027-10-04', SERVICE_DATE: iso, RECIPIENT_EMAIL: 'a@x.org', SUBJECT: 's', STATUS: 'SENT',
    DRY_RUN: false, ROSTER_VERSION_USED: '1', ERROR: '', BODY_PREVIEW: '', BATCH_ID: 'B1' };
}

/** 把星期一流程其他幾步換成記錄器，只看寄了哪一期。 */
function stubMondaySteps(sb) {
  const calls = [];
  sb.sendConflictNoticeIfNeeded_ = function () {};
  sb.autoCreateContentSheetsForUpcomingQuarters_ = function () {};
  sb.runQuarterRetention_ = function () { return { skipped: [] }; };
  sb.sendPreviewNotice_ = function (iso) { calls.push('preview:' + iso); return { sent: true, reason: 'OK' }; };
  sb.sendBulletinForDate_ = function (iso) { calls.push('bulletin:' + iso); return { ok: true }; };
  return calls;
}

console.log('\n1. 星期一觸發器只寄這一期，寄過就略過');

test('weeklyTriggerTargetSunday_：今日或之後第一個主日；寄過就標 alreadySent，不會順延', function () {
  const sb = makeEnv('2027-10-04').sandbox;
  assert.deepStrictEqual(plain(sb.weeklyTriggerTargetSunday_({ todayIso: '2027-10-04', sentIsoList: [] })),
    { ok: true, todayIso: '2027-10-04', isoDate: '2027-10-10', alreadySent: false, reason: '' });
  assert.deepStrictEqual(plain(sb.weeklyTriggerTargetSunday_({ todayIso: '2027-10-04', sentIsoList: ['2027-10-10'] })).isoDate, '2027-10-10');
  assert.strictEqual(sb.weeklyTriggerTargetSunday_({ todayIso: '2027-10-04', sentIsoList: ['2027-10-10'] }).alreadySent, true);
  assert.strictEqual(sb.weeklyTriggerTargetSunday_({ todayIso: '2027-10-10', sentIsoList: [] }).isoDate, '2027-10-10', '主日當日就是當日');
  assert.strictEqual(sb.weeklyTriggerTargetSunday_({ todayIso: '亂寫' }).ok, false);
});

test('真入口 weeklyBulletinSendTrigger_：這一期未寄 → 寄草稿預覽信與週報（這一期）', function () {
  const env = makeEnv('2027-10-04', { config: { DRY_RUN: 'FALSE' } });
  const calls = stubMondaySteps(env.sandbox);
  env.sandbox.weeklyBulletinSendTrigger_();
  assert.deepStrictEqual(calls, ['preview:2027-10-10', 'bulletin:2027-10-10']);
});

test('真入口 weeklyBulletinSendTrigger_：這一期已經真的寄過（同一日第二次跑，或者上星期人手真的試寄了）→ 甚麼都不寄、不提早寄再下一期；AuditLog 講明', function () {
  const env = makeEnv('2027-10-04', { config: { DRY_RUN: 'FALSE' }, sendLog: [sentRow('2027-10-10')] });
  const calls = stubMondaySteps(env.sandbox);
  env.sandbox.weeklyBulletinSendTrigger_();
  assert.deepStrictEqual(calls, [], '以前會寄 2027-10-17');
  const audit = env.sandbox.readSheet('AuditLog').filter(function (r) { return r.ACTION === 'WEEKLY_SEND_SKIPPED'; });
  assert.strictEqual(audit.length, 1);
  assert.ok(audit[0].NOTES.indexOf('2027-10-10') !== -1 && audit[0].NOTES.indexOf('不會提早改寄再下一期') !== -1, audit[0].NOTES);
  assert.strictEqual(env.sandbox.readSheet('ErrorLog').length, 0, '不是錯誤');
});

test('真入口 weeklyBulletinSendTrigger_：試寄（DRY_RUN）的紀錄不算寄過——照寄這一期', function () {
  const dry = Object.assign(sentRow('2027-10-10'), { DRY_RUN: true, STATUS: 'DRY_RUN' });
  const env = makeEnv('2027-10-04', { sendLog: [dry] });
  const calls = stubMondaySteps(env.sandbox);
  env.sandbox.weeklyBulletinSendTrigger_();
  assert.deepStrictEqual(calls, ['preview:2027-10-10', 'bulletin:2027-10-10']);
});

console.log('\n2. 星期一自動寄內容表邀請');

test('autoCreateContentSheetsForUpcomingQuarters_（真入口）：已完結、已封存、自測沙盒季度不建內容表亦不寄；人手寄過（有指紋）的不再寄；只寄未完結而進入提前期的', function () {
  const env = makeEnv('2026-12-14', {
    config: { DRY_RUN: 'FALSE', SELFTEST_QUARTER_ID: '2030T1' },
    weeks: [
      ['2026T3', '2026-07-05'], ['2026T3', '2026-09-27'],                                 // 已完結
      ['2026T4', '2026-10-04', { ARCHIVED: true }], ['2026T4', '2026-12-27', { ARCHIVED: true }], // 已封存
      ['2027T1', '2027-01-03'], ['2027T1', '2027-03-28'],                                 // 人手寄過
      ['2027T2', '2027-01-03'], ['2027T2', '2027-03-28'],                                 // 應該寄
      ['2030T1', '2026-12-20'], ['2030T1', '2027-03-28']                                  // 沙盒
    ]
  });
  const sb = env.sandbox;
  const dates = { '2026T3': ['2026-07-05', '2026-09-27'], '2026T4': ['2026-10-04', '2026-12-27'],
    '2027T1': ['2027-01-03', '2027-03-28'], '2027T2': ['2027-01-03', '2027-03-28'], '2030T1': ['2026-12-20', '2027-03-28'] };
  const built = [];
  const invited = [];
  sb.checkContentSheetFolderConfigured_ = function () { return { ok: true }; };
  sb.readNotifiedFingerprints_ = function () { return [sb.contentSheetInviteFingerprint_('2027T1')]; };
  sb.resolveQuarterServiceDateEntries_ = function (q) { return { dates: dates[q] }; };
  sb.buildOrRefreshContentSheet_ = function (q) { built.push(q); return { ok: true, created: false }; };
  sb.sendContentSheetInvite_ = function (q) { invited.push(q); return { sent: true, dryRun: false }; };
  const r = plain(sb.autoCreateContentSheetsForUpcomingQuarters_());
  assert.deepStrictEqual(invited, ['2027T2'], JSON.stringify(r));
  assert.deepStrictEqual(built, ['2027T2'], '已封存的季度不會另建一份內容表');
});

test('sendContentSheetInvite_（真入口）：真的寄出就記指紋（星期一不會再寄）；試行不記；全部寄不出講明失敗、不記「已寄出」', function () {
  function inviteEnv(config, mailFn) {
    const env = makeFillEnv({ withGrid: false, config: Object.assign({ CONTENT_SHEET_INVITE_GROUPS: 'ADMIN' }, config) });
    const sb = env.sandbox;
    sb.findContentSheetRow_ = function (q) { return { QUARTER_ID: q, FILE_URL: 'https://docs.google.com/x', ACTIVE: true, INVITE_SENT_AT: '' }; };
    sb.updateContentSheetField_ = function (q, k, v) { (sb.__fields = sb.__fields || []).push(k); };
    const recorded = [];
    sb.recordContentSheetInviteFingerprint_ = function (q, fp) { recorded.push(fp); };
    if (mailFn) sb.MailApp.sendEmail = mailFn;
    return { sb: sb, recorded: recorded };
  }
  const real = inviteEnv({ DRY_RUN: 'FALSE' });
  const r1 = plain(real.sb.sendContentSheetInvite_('2027T2'));
  assert.strictEqual(r1.sent, true, JSON.stringify(r1));
  assert.deepStrictEqual(real.recorded, ['CONTENT_SHEET_INVITE|2027T2']);

  const dry = inviteEnv({ DRY_RUN: 'TRUE' });
  assert.strictEqual(dry.sb.sendContentSheetInvite_('2027T2').sent, true);
  assert.deepStrictEqual(dry.recorded, [], '試行不記指紋');

  const bad = inviteEnv({ DRY_RUN: 'FALSE' }, function () { throw new Error('quota'); });
  const r3 = plain(bad.sb.sendContentSheetInvite_('2027T2'));
  assert.strictEqual(r3.sent, false);
  assert.strictEqual(r3.reason, 'SEND_FAILED');
  assert.deepStrictEqual(bad.recorded, []);
  assert.ok(!(bad.sb.__fields || []).length, '不記 INVITE_SENT_AT');
});

console.log('\n3、4. 草稿預覽信');

function previewEnv(config, ui) {
  const boot = makeFillEnv({ withGrid: false });
  return makeFillEnv({
    withGrid: false,
    config: Object.assign({ PREVIEW_WEBAPP_URL: 'https://script.google.com/macros/s/FAKE/exec' }, config || {}),
    emailTemplates: plain(boot.sandbox.seedEmailTemplatesRows_()),
    ui: ui
  });
}

test('sendPreviewNotice_：真的寄（DRY_RUN=FALSE）而全部寄不出 → sent:false SEND_FAILED（觸發器因此記 ErrorLog）', function () {
  const env = previewEnv({ DRY_RUN: 'FALSE' });
  env.sandbox.MailApp.sendEmail = function () { throw new Error('Service invoked too many times'); };
  const out = plain(env.sandbox.sendPreviewNotice_('2027-11-07'));
  assert.strictEqual(out.sent, false);
  assert.strictEqual(out.reason, 'SEND_FAILED');
  assert.ok(out.message.indexOf('寄不出') !== -1, out.message);
});

test('sendPreviewNotice_：信講的主日就是下一個主日 → 固定連結（不帶日期）；不是 → 連結帶日期', function () {
  const env = previewEnv({ WEBAPP_SIMULATED_TODAY: '2027-11-03' });
  assert.strictEqual(env.sandbox.sendPreviewNotice_('2027-11-07').previewUrl, 'https://script.google.com/macros/s/FAKE/exec?page=preview');
  assert.strictEqual(env.sandbox.sendPreviewNotice_('2027-11-14').previewUrl, 'https://script.google.com/macros/s/FAKE/exec?page=preview&date=2027-11-14');
});

test('選單試寄草稿預覽信（真入口 menuTestSendPreviewNotice_）：不是星期日不寄；DRY_RUN=FALSE 先問，按「否」不寄', function () {
  const alerts = [];
  let answer = '2027-11-10';
  const ui = {
    prompt: function () { return { getSelectedButton: function () { return 'OK'; }, getResponseText: function () { return answer; } }; },
    alert: function () { alerts.push(Array.prototype.slice.call(arguments)); return 'NO'; }
  };
  const env = previewEnv({ DRY_RUN: 'FALSE' }, ui);
  env.sandbox.menuTestSendPreviewNotice_();
  assert.ok(String(alerts[0][0]).indexOf('不是星期日') !== -1, JSON.stringify(alerts));
  answer = '2027-11-14';
  env.sandbox.menuTestSendPreviewNotice_();
  assert.strictEqual(alerts[1][0], '真的寄出');
  assert.strictEqual(env.sandbox.readSheet('SendLog').length, 0, '按「否」一封都不寄');
  assert.strictEqual(env.mail.calls.length, 0);
});

console.log('\n通過 ' + pass + ' 項，失敗 ' + fail + ' 項。');
process.exit(fail === 0 ? 0 : 1);
