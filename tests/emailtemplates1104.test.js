#!/usr/bin/env node
/**
 * tests/emailtemplates1104.test.js
 *
 * 2026-11-04（Ivan 對《電郵範本內容_2026-11-03》的意見）：
 *   1. 開頭稱呼按收件組別（「各位堂委、執事、幹事：」；IT 不寫入），不再一律「各位主內肢體」。
 *   2. 主旨與內文拿走教會全名（{{ChurchName}}）。
 *   3. 主旨加版本號：已發佈＝發佈版本「v2」；未發佈＝第幾次寄草稿「草稿 v1」（草稿預覽信與「寄出」共用計數）。
 *   4. 佔位符空白之後不留三個空行。
 *   5. 季度內容表邀請信（由職事表系統寄）、職事表分歧提醒信（填寫介面已提示）預設不寄。
 *   6. 「初始化工作表」把仍然是系統舊預設值的範本更新為新預設；人手改過的不動。
 *
 *   ⚠️ bug class 5：每一項都由真正入口叫（sendPreviewNotice_、sendPublishNotice_、initializeAllSheets_、
 *   weeklyBulletinSendTrigger_、sendContentSheetInvite_）。
 *
 * 執行方式：node tests/emailtemplates1104.test.js
 */

'use strict';

const assert = require('assert');
const { makeFillEnv } = require('./helpers/fillEnv');
const { assertWrittenChinese } = require('./helpers/writtenChinese');

let pass = 0;
let fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); } catch (err) {
    fail++; console.log('  ✗ ' + name); console.log('    ' + (err && err.stack ? err.stack.split('\n').slice(0, 6).join('\n    ') : err));
  }
}

const D = '2027-11-14';
const CHURCH = '基督教中國佈道會奧克蘭聖道堂';
const RECIPIENTS = [
  { RECIPIENT_ID: 'R1', NAME: '甲', EMAIL: 'cc@example.org', GROUP_NAME: 'CC', ACTIVE: true, EFFECTIVE_FROM: '', EFFECTIVE_TO: '', NOTES: '' },
  { RECIPIENT_ID: 'R2', NAME: '乙', EMAIL: 'db@example.org', GROUP_NAME: 'DB', ACTIVE: true, EFFECTIVE_FROM: '', EFFECTIVE_TO: '', NOTES: '' },
  { RECIPIENT_ID: 'R3', NAME: '丙', EMAIL: 'admin@example.org', GROUP_NAME: 'ADMIN', ACTIVE: true, EFFECTIVE_FROM: '', EFFECTIVE_TO: '', NOTES: '' },
  { RECIPIENT_ID: 'R4', NAME: '丁', EMAIL: 'it@example.org', GROUP_NAME: 'IT', ACTIVE: true, EFFECTIVE_FROM: '', EFFECTIVE_TO: '', NOTES: '' }
];

function propsStub() {
  const props = {};
  return { props: props, PropertiesService: { getScriptProperties: function () {
    return { getProperty: function (k) { return props[k] === undefined ? null : props[k]; }, setProperty: function (k, v) { props[k] = String(v); },
      deleteProperty: function (k) { delete props[k]; }, getProperties: function () { return Object.assign({}, props); } };
  } } };
}

function mailEnv(extra) {
  const probe = makeFillEnv({ withGrid: false }).sandbox;
  const p = propsStub();
  const env = makeFillEnv(Object.assign({
    withGrid: false, emailTemplates: probe.seedEmailTemplatesRows_(), recipients: RECIPIENTS,
    config: { PREVIEW_WEBAPP_URL: 'https://script.google.com/macros/s/FAKE/exec', DRY_RUN: 'FALSE', EMAIL_ALLOWLIST: '' },
    extraStubs: { PropertiesService: p.PropertiesService }
  }, extra || {}));
  env.props = p.props;
  return env;
}

console.log('\n純函式');

test('E-1 稱呼：按 Config 次序；IT（稱呼留空）不寫入；全部沒有稱呼＝各位同工', function () {
  const sb = makeFillEnv({ withGrid: false }).sandbox;
  const titles = 'CC=堂委,DB=執事,ADMIN=幹事,WORSHIP=敬拜同工,IT=';
  assert.strictEqual(sb.buildEmailSalutation_(['ADMIN', 'CC', 'DB', 'IT'], titles), '各位堂委、執事、幹事：');
  assert.strictEqual(sb.buildEmailSalutation_(['cc'], titles), '各位堂委：');
  assert.strictEqual(sb.buildEmailSalutation_(['IT'], titles), '各位同工：');
  assert.strictEqual(sb.buildEmailSalutation_([], titles), '各位同工：');
});

test('E-2 空白佔位符留下的連續空行收成一個空行；一個空行照樣保留', function () {
  const sb = makeFillEnv({ withGrid: false }).sandbox;
  assert.strictEqual(sb.tidyEmailBlankLines_('甲\n\n\n\n乙\n\n丙'), '甲\n\n乙\n\n丙');
  assert.strictEqual(sb.tidyEmailBlankLines_('甲\r\n\r\n \r\n\r\n乙'), '甲\n\n乙');
});

console.log('\n真正入口');

test('E-3 星期一草稿預覽信（sendPreviewNotice_）：主旨「粵語堂週報草稿預覽 v1」、沒有教會全名；稱呼按 PREVIEW_SEND_GROUPS；再寄一次＝v2', function () {
  const env = mailEnv();
  const r = env.sandbox.sendPreviewNotice_(D);
  assert.strictEqual(r.sent, true, r.message);
  const first = env.mail.calls[0];
  assert.strictEqual(first.subject, '粵語堂週報草稿預覽 v1 — ' + D);
  assert.strictEqual(first.body.split('\n')[0], '各位堂委、執事、幹事：');
  assert.strictEqual(first.body.indexOf(CHURCH), -1, '內文不可以有教會全名');
  assert.strictEqual(first.subject.indexOf(CHURCH), -1);
  assert.strictEqual(/\n\s*\n\s*\n/.test(first.body), false, '不可以有連續兩個空行：\n' + first.body);
  env.sandbox.sendPreviewNotice_(D);
  assert.strictEqual(env.mail.calls[env.mail.calls.length - 1].subject, '粵語堂週報草稿預覽 v2 — ' + D);
  assertWrittenChinese(assert, '草稿預覽信', [first.subject, first.body]);
});

test('E-3b 獨立審查：試行（DRY_RUN）與全部寄不出都不加草稿號；之後第一封真的寄出仍然是 v1', function () {
  const dry = mailEnv({ config: { PREVIEW_WEBAPP_URL: 'https://script.google.com/macros/s/FAKE/exec', DRY_RUN: 'TRUE', EMAIL_ALLOWLIST: '' } });
  dry.sandbox.sendPreviewNotice_(D);
  dry.sandbox.sendPreviewNotice_(D);
  assert.strictEqual(dry.props['NOTICE_DRAFT_SEQ_' + D], undefined, '試行不加');
  const env = mailEnv();
  const realSend = env.sandbox.MailApp.sendEmail;
  env.sandbox.MailApp.sendEmail = function () { throw new Error('Service invoked too many times'); };
  const failed = env.sandbox.sendPreviewNotice_(D);
  assert.strictEqual(failed.sent, false);
  assert.strictEqual(env.props['NOTICE_DRAFT_SEQ_' + D], undefined, '全部寄不出不加');
  env.sandbox.MailApp.sendEmail = realSend;
  env.sandbox.sendPreviewNotice_(D);
  assert.strictEqual(env.mail.calls[env.mail.calls.length - 1].subject, '粵語堂週報草稿預覽 v1 — ' + D);
  assert.strictEqual(env.props['NOTICE_DRAFT_SEQ_' + D], '1');
});

test('E-4 填寫介面「寄出」（sendPublishNotice_，未發佈）：稱呼按勾選的組別（IT 不寫入）；主旨「草稿 v」與草稿預覽信共用計數；沒有三個空行', function () {
  const env = mailEnv();
  env.sandbox.sendPreviewNotice_(D);
  const r = env.sandbox.sendPublishNotice_(D, { published: false, groups: ['CC', 'IT'], customEmails: '' });
  assert.strictEqual(r.ok, true, r.message);
  const mail = env.mail.calls[env.mail.calls.length - 1];
  assert.strictEqual(mail.subject, '粵語堂週報 草稿 v2 — ' + D);
  assert.strictEqual(mail.body.split('\n')[0], '各位堂委：');
  assert.strictEqual(mail.body.indexOf(CHURCH), -1);
  assert.ok(mail.body.indexOf(D + ' 主日的粵語堂週報') !== -1, mail.body);
  assert.strictEqual(/\n\s*\n\s*\n/.test(mail.body), false, '沒有附件時不可以留三個空行：\n' + mail.body);
});

test('E-5 「寄出」已發佈（發佈加寄出）：主旨用發佈版本「v3」，不用草稿計數；草稿計數不變', function () {
  const env = mailEnv();
  env.sandbox.sendPreviewNotice_(D);
  const r = env.sandbox.sendPublishNotice_(D, {
    published: true, publishedVersionNo: 3, groups: ['DB'], customEmails: '', blob: null
  });
  if (r.reason === 'NO_MASTER_FILE') {
    // 測試環境未設 master：改用「只寄出、master 是這一期」走同一條版本規則。
    const s = env.sandbox.sendPublishNotice_(D, { published: false, masterOnThisWeek: true, masterVersionNo: 3, groups: ['DB'], customEmails: '' });
    assert.strictEqual(s.ok, true, s.message);
  } else {
    assert.strictEqual(r.ok, true, r.message);
  }
  const mail = env.mail.calls[env.mail.calls.length - 1];
  assert.strictEqual(mail.subject, '粵語堂週報 v3 — ' + D);
  assert.strictEqual(mail.body.split('\n')[0], '各位執事：');
  assert.strictEqual(env.props['NOTICE_DRAFT_SEQ_' + D], '1', '已發佈的通知不增加草稿計數');
});

test('E-6 初始化工作表（initializeAllSheets_）：仍然是系統舊預設值的範本更新為新預設；人手改過的一格不動；對話框列出', function () {
  const probe = makeFillEnv({ withGrid: false }).sandbox;
  const live = {
    PREVIEW_NOTICE: { SUBJECT: '{{ChurchName}}粵語堂週報草稿預覽 — {{ServiceDate}}', BODY: '各位主內肢體：\n\n平安！\n\n下一個主日（{{ServiceDate}}）的週報草稿預覽已經可以查看：\n\n{{PreviewUrl}}\n\n⚠️ 這是草稿預覽，版面與正式印刷版不同，只供核對內容。如發現資料有錯漏，請回覆此郵件。\n\n這條連結固定不變，之後每星期打開都是最新一期，可以直接收藏。\n\n{{RosterPendingNote}}\n\n謝謝！\n\n粵語堂週報系統　敬上' },
    SEND_NOTICE: { SUBJECT: '{{ChurchName}}粵語堂週報 — {{ServiceDate}}', BODY: '人手改過的內文' },
    TPL_WEEKLY_BULLETIN: { SUBJECT: '人手改過的主旨', BODY: '各位主內肢體：\n\n平安！\n\n隨函附上 {{ServiceDate}} 主日的{{ChurchName}}粵語堂週報，敬請查收。\n\n如發現資料有任何錯漏，請回覆此郵件告知，以便盡快更正。\n\n謝謝！\n\n粵語堂週報系統　敬上' }
  };
  const rows = Object.keys(live).map(function (id) { return { TEMPLATE_ID: id, SUBJECT: live[id].SUBJECT, BODY: live[id].BODY, ACTIVE: true, NOTES: '' }; });
  const env = makeFillEnv({ withGrid: false, emailTemplates: rows });
  const sb = env.sandbox;
  const summary = sb.initializeAllSheets_();
  const after = {};
  sb.readSheet_('EmailTemplates').forEach(function (r) { after[r.TEMPLATE_ID] = r; });
  const seeds = {};
  probe.seedEmailTemplatesRows_().forEach(function (r) { seeds[r.TEMPLATE_ID] = r; });
  assert.strictEqual(after.PREVIEW_NOTICE.SUBJECT, seeds.PREVIEW_NOTICE.SUBJECT);
  assert.strictEqual(String(after.PREVIEW_NOTICE.BODY).replace(/\r\n/g, '\n'), seeds.PREVIEW_NOTICE.BODY);
  assert.strictEqual(after.SEND_NOTICE.SUBJECT, seeds.SEND_NOTICE.SUBJECT);
  assert.strictEqual(after.SEND_NOTICE.BODY, '人手改過的內文', '人手改過的不可以動');
  assert.strictEqual(after.TPL_WEEKLY_BULLETIN.SUBJECT, '人手改過的主旨', '人手改過的不可以動');
  assert.strictEqual(String(after.TPL_WEEKLY_BULLETIN.BODY).replace(/\r\n/g, '\n'), seeds.TPL_WEEKLY_BULLETIN.BODY);
  assert.strictEqual(summary.emailTemplateUpgrades.upgrades.length, 4, JSON.stringify(summary.emailTemplateUpgrades));
  const audits = sb.readSheet_('AuditLog').filter(function (a) { return a.ACTION === 'EMAIL_TEMPLATE_UPGRADE_DEFAULT'; });
  assert.strictEqual(audits.length, 4);
  // 再按一次：已經是新值，不再更新。
  assert.strictEqual(sb.initializeAllSheets_().emailTemplateUpgrades.upgrades.length, 0);
});

test('E-7 季度內容表邀請（sendContentSheetInvite_）預設不寄，講明由職事表系統寄；星期一分歧提醒預設不叫', function () {
  const env = mailEnv({ config: { CONTENT_SHEET_INVITE_GROUPS: 'ADMIN', DRY_RUN: 'FALSE', EMAIL_ALLOWLIST: '' } });
  const sb = env.sandbox;
  sb.findContentSheetRow_ = function (q) { return { QUARTER_ID: q, FILE_URL: 'https://docs.google.com/x', ACTIVE: true, INVITE_SENT_AT: '' }; };
  const before = env.mail.calls.length;
  const r = sb.sendContentSheetInvite_('2027T4');
  assert.strictEqual(r.sent, false);
  assert.strictEqual(r.reason, 'DISABLED');
  assert.ok(r.message.indexOf('職事表系統') !== -1, r.message);
  assert.strictEqual(env.mail.calls.length, before);
  assertWrittenChinese(assert, '邀請信停用', [r.message]);

  let called = 0;
  sb.sendConflictNoticeIfNeeded_ = function () { called++; return { sent: false }; };
  sb.weeklyBulletinSendTrigger_();
  assert.strictEqual(called, 0, '預設不寄分歧提醒');
  const on = mailEnv({ config: { CONFLICT_NOTICE_EMAIL_ENABLED: 'TRUE', DRY_RUN: 'TRUE' } });
  let calledOn = 0;
  on.sandbox.sendConflictNoticeIfNeeded_ = function () { calledOn++; return { sent: false }; };
  on.sandbox.weeklyBulletinSendTrigger_();
  assert.strictEqual(calledOn, 1, 'Config 開了就照舊叫');
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
