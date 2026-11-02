#!/usr/bin/env node
/**
 * tests/mailguard.test.js
 *
 * 2026-11-02（Ivan 第 8 項）：寄出電郵的白名單（Config `EMAIL_ALLOWLIST`，src/MailGuard.gs）。
 *   - 全系統只有 `sendEmailAllowlisted_()` 呼叫 `MailApp.sendEmail`（靜態掃描）；`GmailApp` 一律不用；
 *   - 名單外的地址拿走（不分大小寫、去空白）；`to` 一個不剩就不寄；SendLog 記 NOT_ALLOWED、ErrorLog 記一筆、結果訊息講明；
 *   - 留空＝不限制。
 *
 * 真正入口：sendPreviewNotice_、sendPublishNotice_（連「另外寄給」的電郵）、sendContentSheetInvite_ 的同一個寄送函式。
 *
 * 執行方式：node tests/mailguard.test.js
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { makeFillEnv } = require('./helpers/fillEnv');
const { assertWrittenChinese } = require('./helpers/writtenChinese');

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

const SRC = path.join(__dirname, '..', 'src');

/** 拿走註解（`//` 與 `/* … *\/`），只看程式碼。 */
function stripComments(code) {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');
}
function srcFiles(dir) {
  const out = [];
  fs.readdirSync(dir).forEach(function (name) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) out.push.apply(out, srcFiles(full));
    else if (/\.(gs|html|js)$/.test(name)) out.push(full);
  });
  return out;
}

console.log('\n靜態：只有一個地方寄電郵');

test('MG-1 src 內只有 MailGuard.gs 的 sendEmailAllowlisted_() 呼叫 MailApp.sendEmail；GmailApp 一處都沒有', function () {
  const offenders = [];
  srcFiles(SRC).forEach(function (file) {
    const code = stripComments(fs.readFileSync(file, 'utf8'));
    const rel = path.relative(SRC, file);
    if (/\bGmailApp\b/.test(code)) offenders.push(rel + '：GmailApp');
    const calls = code.match(/MailApp\s*\.\s*send\w*\s*\(/g) || [];
    if (rel === 'MailGuard.gs') {
      assert.strictEqual(calls.length, 1, 'MailGuard.gs 只可以有一處');
      const fn = code.slice(code.indexOf('function sendEmailAllowlisted_('));
      const body = fn.slice(0, fn.indexOf('\nfunction ', 10));
      assert.ok(/MailApp\s*\.\s*sendEmail\s*\(/.test(body), '那一處要在 sendEmailAllowlisted_() 之內');
    } else if (calls.length > 0) {
      offenders.push(rel + '：' + calls.length + ' 處');
    }
  });
  assert.deepStrictEqual(offenders, [], '以下檔案繞過寄送名單：' + offenders.join('、'));
});

console.log('\n純函式');

test('MG-2 名單解析與過濾：不分大小寫、去空白、「名稱 <地址>」、多個地址；留空＝不限制', function () {
  const sb = makeFillEnv({ withGrid: false }).sandbox;
  assert.deepStrictEqual(plain(sb.parseEmailAllowlist_(' A@X.com ; b@example.org,\n c@example.net ')), ['a@x.com', 'b@example.org', 'c@example.net']);
  assert.strictEqual(sb.parseEmailAllowlist_('  '), null);
  const allow = ['a@x.com'];
  assert.deepStrictEqual(plain(sb.filterEmailField_(' 甲 <A@X.com>, no@example.org ', allow)), { kept: '甲 <A@X.com>', dropped: ['no@example.org'] });
  assert.deepStrictEqual(plain(sb.filterEmailField_('no@example.org', allow)), { kept: '', dropped: ['no@example.org'] });
  assert.deepStrictEqual(plain(sb.filterEmailField_('no@example.org', null)), { kept: 'no@example.org', dropped: [] });
  const entry = sb.DEFAULTS.filter(function (d) { return d.key === 'EMAIL_ALLOWLIST'; })[0];
  assert.strictEqual(entry.note, '所有寄出的電郵只會寄給這個名單內的地址；留空＝不限制。DRY_RUN 仍然是總開關');
});

test('MG-2b 預設名單（Config 未有這個鍵、或者「初始化工作表」寫入時）＝本系統帳戶＋同網域的 hwc 信箱；程式內沒有寫死真實電郵', function () {
  const sb = makeFillEnv({ withGrid: false }).sandbox;
  assert.strictEqual(sb.emailAllowlistSeedValue_(), 'tester@x.com,hwc@x.com');
  sb.Session = { getEffectiveUser: function () { throw new Error('沒有授權'); } };
  assert.strictEqual(sb.parseEmailAllowlist_(sb.emailAllowlistSeedValue_()).some(function (a) { return a.indexOf('@') !== -1; }), false,
    '取不到帳戶＝一個地址都不配對（一封都不寄），不可以變成不限制');
  const code = fs.readFileSync(path.join(SRC, 'Constants.gs'), 'utf8') + fs.readFileSync(path.join(SRC, 'MailGuard.gs'), 'utf8');
  assert.strictEqual(/holywordchurch/i.test(code), false, '不可以寫死教會網域');
});

console.log('\n真正入口');

const RECIPIENTS = [
  { RECIPIENT_ID: 'R1', NAME: '甲', EMAIL: 'OK@Example.org', GROUP_NAME: 'CC', ACTIVE: true, EFFECTIVE_FROM: '', EFFECTIVE_TO: '', NOTES: '' },
  { RECIPIENT_ID: 'R2', NAME: '乙', EMAIL: 'no@example.org', GROUP_NAME: 'DB', ACTIVE: true, EFFECTIVE_FROM: '', EFFECTIVE_TO: '', NOTES: '' }
];
function previewEnv(allowlist, dryRun) {
  const probe = makeFillEnv({ withGrid: false }).sandbox;
  return makeFillEnv({
    withGrid: false, emailTemplates: probe.seedEmailTemplatesRows_(), recipients: RECIPIENTS,
    config: { PREVIEW_WEBAPP_URL: 'https://script.google.com/macros/s/FAKE/exec', DRY_RUN: dryRun || 'FALSE', EMAIL_ALLOWLIST: allowlist }
  });
}
function sendLog(env) { return env.sandbox.readSheet_('SendLog').map(function (r) { return [r.RECIPIENT_EMAIL, r.STATUS]; }); }
function notAllowedLogs(env) { return env.sandbox.readSheet_('ErrorLog').filter(function (r) { return r.ERROR_CODE === 'EMAIL_NOT_IN_ALLOWLIST'; }); }

test('MG-3 sendPreviewNotice_：只寄名單內的（大小寫不同照認），名單外的 SendLog 記 NOT_ALLOWED、ErrorLog 一筆、結果訊息講明', function () {
  const env = previewEnv(' ok@example.org ,hwc@x.com');
  const r = env.sandbox.sendPreviewNotice_('2027-11-14');
  assert.strictEqual(r.sent, true, r.message);
  assert.strictEqual(r.recipientCount, 1);
  assert.deepStrictEqual(env.mail.calls.map(function (c) { return c.to; }), ['OK@Example.org']);
  assert.deepStrictEqual(plain(sendLog(env)), [['OK@Example.org', 'PREVIEW'], ['no@example.org', 'NOT_ALLOWED']]);
  assert.ok(r.message.indexOf('另有 1 個收件人不在 Config EMAIL_ALLOWLIST 的寄送名單，沒有寄出') !== -1, r.message);
  assert.strictEqual(notAllowedLogs(env).length, 1);
  assert.ok(String(notAllowedLogs(env)[0].MESSAGE).indexOf('no@example.org') !== -1);
  assertWrittenChinese(assert, '寄送名單', [r.message, String(notAllowedLogs(env)[0].MESSAGE)]);
});

test('MG-4 全部不在名單：一封都不寄，sent:false（NOT_ALLOWED），不講成已寄出', function () {
  const env = previewEnv('hwc@x.com');
  const r = env.sandbox.sendPreviewNotice_('2027-11-14');
  assert.strictEqual(r.sent, false);
  assert.strictEqual(r.reason, 'NOT_ALLOWED');
  assert.strictEqual(env.mail.calls.length, 0);
  assert.deepStrictEqual(plain(sendLog(env)), [['OK@Example.org', 'NOT_ALLOWED'], ['no@example.org', 'NOT_ALLOWED']]);
  assert.ok(r.message.indexOf('沒有寄出') !== -1, r.message);
});

test('MG-5 Config 留空＝不限制（兩個都寄）；DRY_RUN=TRUE 仍然一封都不寄', function () {
  const env = previewEnv('');
  assert.strictEqual(env.sandbox.sendPreviewNotice_('2027-11-14').recipientCount, 2);
  assert.strictEqual(env.mail.calls.length, 2);
  assert.strictEqual(notAllowedLogs(env).length, 0);
  const dry = previewEnv('', 'TRUE');
  dry.sandbox.sendPreviewNotice_('2027-11-14');
  assert.strictEqual(dry.mail.calls.length, 0);
});

test('MG-6 sendPublishNotice_（只寄出）：「另外寄給」的電郵不在名單亦被拿走，SendLog 記 NOT_ALLOWED', function () {
  const env = previewEnv('ok@example.org,extra-ok@example.org');
  const r = env.sandbox.sendPublishNotice_('2027-11-14', {
    groups: ['CC'], customEmails: 'extra-ok@example.org, outsider@example.net', blob: null, published: false
  });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  const sentTo = env.mail.calls.map(function (c) { return String(c.to).toLowerCase(); }).sort();
  assert.deepStrictEqual(sentTo, ['extra-ok@example.org', 'ok@example.org']);
  const log = plain(sendLog(env));
  assert.ok(log.some(function (x) { return x[0] === 'outsider@example.net' && x[1] === 'NOT_ALLOWED'; }), JSON.stringify(log));
  assert.strictEqual(r.blockedCount, 1);
  assert.ok(r.allowlistNote.indexOf('另有 1 個收件人') !== -1, r.allowlistNote);
});

test('MG-7 未按「初始化工作表」（Config 沒有 EMAIL_ALLOWLIST）：sendPreviewNotice_ 只寄本系統帳戶與 hwc 信箱；初始化之後 Config 有同一份', function () {
  const probe = makeFillEnv({ withGrid: false }).sandbox;
  const env = makeFillEnv({
    withGrid: false, emailTemplates: probe.seedEmailTemplatesRows_(), omitConfigKeys: ['EMAIL_ALLOWLIST'],
    recipients: [
      { RECIPIENT_ID: 'R1', NAME: '甲', EMAIL: 'hwc@x.com', GROUP_NAME: 'CC', ACTIVE: true, EFFECTIVE_FROM: '', EFFECTIVE_TO: '', NOTES: '' },
      { RECIPIENT_ID: 'R2', NAME: '乙', EMAIL: 'deacon@x.com', GROUP_NAME: 'DB', ACTIVE: true, EFFECTIVE_FROM: '', EFFECTIVE_TO: '', NOTES: '' }
    ],
    config: { PREVIEW_WEBAPP_URL: 'https://script.google.com/macros/s/FAKE/exec', DRY_RUN: 'FALSE' }
  });
  const r = env.sandbox.sendPreviewNotice_('2027-11-14');
  assert.strictEqual(r.sent, true, r.message);
  assert.deepStrictEqual(env.mail.calls.map(function (c) { return c.to; }), ['hwc@x.com']);
  assert.strictEqual(env.sandbox.seedConfigDefaults_() >= 1, true);
  const row = env.sandbox.readSheet_('Config').filter(function (c) { return c.KEY === 'EMAIL_ALLOWLIST'; })[0];
  assert.strictEqual(String(row.VALUE), 'tester@x.com,hwc@x.com');
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
