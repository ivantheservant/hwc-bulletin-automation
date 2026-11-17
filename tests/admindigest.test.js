#!/usr/bin/env node
/**
 * tests/admindigest.test.js
 *
 * R-057（2026-11-17）：每日管理員摘要電郵（src/AdminDigest.gs）。
 *
 *   內容（有任何一項才寄，沒有就不寄）：
 *     1. 上一次摘要之後 ErrorLog 內 SOURCE=TRIGGER 的行（最多 20 行，超過的講明還有幾行）；
 *     2. 星期一自動流程本週有沒有執行（SendLog 與 AuditLog 都找不到這個目標主日的痕跡）。
 *   寄出只經 sendEmailAllowlisted_()；DRY_RUN=TRUE 不寄，只寫 SendLog 一行 STATUS=DRY_RUN。
 *
 *   ⚠️ 主要路徑由真正入口 `dailyQuarterAutoCreateTrigger_()` 叫下去（bug class 5）。
 *
 *   ⚠️ 假試算表把 Date 截成日期（時間變成當日 00:00），真試算表不會。所以這裏的 ErrorLog 時間一律用
 *   「今日」或「很久以前」，不依賴同一日之內的先後。
 *
 * 執行方式：node tests/admindigest.test.js
 * 離開碼：0＝全部通過　1＝有測試失敗
 */

'use strict';

const assert = require('assert');
const contentEnv = require('./helpers/contentEnv');

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

function makeProps() {
  const store = {};
  return {
    store: store,
    service: {
      getScriptProperties: function () {
        return {
          getProperty: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
          setProperty: function (k, v) { store[k] = String(v); },
          deleteProperty: function (k) { delete store[k]; }
        };
      }
    }
  };
}

const DAY = 24 * 3600 * 1000;

/**
 * 造環境：DRY_RUN 預設 FALSE；MailApp 記錄寄出的信；Recipients 預設 ADMIN 兩人、IT 一人。
 * `fixedToday`：固定「真正的今日」（Utilities.formatDate 的 yyyy-MM-dd）。預設是 2027-11-08（星期一＝寄送日當日，
 *   不判斷星期一流程有沒有執行），免得測試結果跟執行測試的星期幾有關。
 */
function makeDigestEnv(options) {
  const o = options || {};
  const env = contentEnv.makeEnv({ config: Object.assign({ DRY_RUN: 'FALSE' }, o.config || {}) });
  const sb = env.sandbox;
  env.mails = [];
  sb.MailApp = {
    sendEmail: function (m) {
      if (o.mailFails) throw new Error('MailApp：額度用完（測試）');
      env.mails.push(plain(m));
    },
    getRemainingDailyQuota: function () { return 100; }
  };
  env.props = makeProps();
  sb.PropertiesService = env.props.service;

  const fixedToday = o.fixedToday || '2027-11-08';
  const original = sb.Utilities.formatDate;
  sb.Utilities.formatDate = function (date, tz, pattern) {
    return pattern === 'yyyy-MM-dd' ? fixedToday : original(date, tz, pattern);
  };

  const recipients = o.recipients === undefined ? [
    { RECIPIENT_ID: 'R1', NAME: '管理員甲', EMAIL: 'admin1@example.org', GROUP_NAME: 'ADMIN', ACTIVE: true },
    { RECIPIENT_ID: 'R2', NAME: '管理員乙', EMAIL: 'admin2@example.org', GROUP_NAME: 'ADMIN', ACTIVE: true },
    { RECIPIENT_ID: 'R3', NAME: 'IT 丙', EMAIL: 'it1@example.org', GROUP_NAME: 'IT', ACTIVE: true },
    { RECIPIENT_ID: 'R4', NAME: '堂委丁', EMAIL: 'cc1@example.org', GROUP_NAME: 'CC', ACTIVE: true }
  ] : o.recipients;
  if (recipients.length > 0) sb.writeSheet_(sb.SHEETS.RECIPIENTS, recipients);
  return env;
}

/** 在 ErrorLog 放一行。`daysAgo`：0＝今日、10＝十日前（見檔頭說明，不要用同一日內的先後）。 */
function addError(env, spec) {
  const d = new Date();
  const stamp = new Date(d.getFullYear(), d.getMonth(), d.getDate() - (spec.daysAgo || 0), 12, 0, 0);
  env.sandbox.writeSheet_(env.sandbox.SHEETS.ERROR_LOG, [{
    TIMESTAMP: stamp, ACTOR: 'x', SOURCE: spec.source || 'TRIGGER',
    FUNCTION_NAME: spec.fn || 'contentAutoSyncTrigger_', ERROR_CODE: spec.code || 'ERROR',
    MESSAGE: spec.message || '測試錯誤', DETAIL: ''
  }]);
}

function sendLogRows(env) { return plain(env.sandbox.readSheet_(env.sandbox.SHEETS.SEND_LOG)); }
function errorRows(env) { return plain(env.sandbox.readSheet_(env.sandbox.SHEETS.ERROR_LOG)); }
function triggerErrorFns(env) {
  return errorRows(env).filter(function (r) { return r.SOURCE === 'TRIGGER'; }).map(function (r) { return r.FUNCTION_NAME; });
}

// =====================================================================
console.log('\nR-057：由 dailyQuarterAutoCreateTrigger_() 入口');
// =====================================================================

test('有觸發器錯誤 → 寄給 ADMIN 與 IT 組（共三人，CC 不在內）；內文只列 SOURCE=TRIGGER 而且是上次之後的；SendLog 有記錄', function () {
  const env = makeDigestEnv({});
  addError(env, { fn: 'contentAutoSyncTrigger_', code: 'ERROR', message: 'Service Spreadsheets timed out while accessing document' });
  addError(env, { fn: 'dailyQuarterAutoCreateTrigger_', code: 'TIMEOUT', message: '第二個錯誤' });
  addError(env, { source: 'SERVER', fn: 'apiSaveWeek', message: '伺服器錯誤不列' });
  addError(env, { daysAgo: 10, fn: 'oldTrigger_', message: '十日前的不列（在上次摘要之前）' });
  env.props.store.ADMIN_DIGEST_LAST_AT = String(Date.now() - 3 * DAY);

  env.sandbox.dailyQuarterAutoCreateTrigger_();

  assert.strictEqual(env.mails.length, 3, '三個收件人各一封：' + JSON.stringify(env.mails.map(function (m) { return m.to; })));
  assert.deepStrictEqual(env.mails.map(function (m) { return m.to; }).sort(),
    ['admin1@example.org', 'admin2@example.org', 'it1@example.org']);
  const body = env.mails[0].body;
  assert.ok(body.indexOf('contentAutoSyncTrigger_') !== -1 && body.indexOf('Service Spreadsheets timed out') !== -1, body);
  assert.ok(body.indexOf('dailyQuarterAutoCreateTrigger_') !== -1 && body.indexOf('第二個錯誤') !== -1, body);
  assert.strictEqual(body.indexOf('apiSaveWeek'), -1, 'SOURCE=SERVER 不列');
  assert.strictEqual(body.indexOf('oldTrigger_'), -1, '上次摘要之前的不列');
  assert.ok(body.indexOf('各位管理員') !== -1 && body.indexOf('ErrorLog') !== -1, body);
  assert.ok(env.mails[0].subject.indexOf('管理員摘要') !== -1 && env.mails[0].subject.indexOf('觸發器錯誤 2 項') !== -1, env.mails[0].subject);

  const logs = sendLogRows(env);
  assert.strictEqual(logs.length, 3);
  logs.forEach(function (l) {
    assert.strictEqual(l.STATUS, 'SENT');
    assert.strictEqual(l.DRY_RUN, false);
    assert.strictEqual(l.ROSTER_VERSION_USED, 'ADMIN_DIGEST');
    assert.strictEqual(l.SERVICE_DATE, null, '摘要的 SendLog 行不帶主日，免得被當成星期一流程的痕跡');
  });
  assert.ok(Number(env.props.store.ADMIN_DIGEST_LAST_AT) > Date.now() - 60000, '記下這一次摘要的時間');
});

test('沒有任何事項 → 不寄、不寫 SendLog；時間照記（下一次只看之後新增的）', function () {
  const env = makeDigestEnv({});
  addError(env, { daysAgo: 10 });
  env.props.store.ADMIN_DIGEST_LAST_AT = String(Date.now() - 3 * DAY);
  env.sandbox.dailyQuarterAutoCreateTrigger_();
  assert.strictEqual(env.mails.length, 0);
  assert.strictEqual(sendLogRows(env).length, 0);
  assert.ok(Number(env.props.store.ADMIN_DIGEST_LAST_AT) > Date.now() - 60000);
});

test('DRY_RUN=TRUE → 一封都不寄，只寫 SendLog 一行 STATUS=DRY_RUN', function () {
  const env = makeDigestEnv({ config: { DRY_RUN: 'TRUE' } });
  addError(env, { message: '測試錯誤甲' });
  env.sandbox.dailyQuarterAutoCreateTrigger_();
  assert.strictEqual(env.mails.length, 0, '⚠️ 試行模式不可以真的寄');
  const logs = sendLogRows(env);
  assert.strictEqual(logs.length, 1);
  assert.strictEqual(logs[0].STATUS, 'DRY_RUN');
  assert.strictEqual(logs[0].DRY_RUN, true);
  assert.ok(logs[0].BODY_PREVIEW.indexOf('測試錯誤甲') !== -1, logs[0].BODY_PREVIEW);
});

test('不在 EMAIL_ALLOWLIST 的地址被擋：只寄給名單內的，其餘 SendLog 記 NOT_ALLOWED', function () {
  const env = makeDigestEnv({ config: { EMAIL_ALLOWLIST: 'admin1@example.org' } });
  addError(env, { message: '測試錯誤甲' });
  env.sandbox.dailyQuarterAutoCreateTrigger_();
  assert.deepStrictEqual(env.mails.map(function (m) { return m.to; }), ['admin1@example.org']);
  const statuses = sendLogRows(env).map(function (l) { return l.RECIPIENT_EMAIL + '=' + l.STATUS; }).sort();
  assert.deepStrictEqual(statuses, ['admin1@example.org=SENT', 'admin2@example.org=NOT_ALLOWED', 'it1@example.org=NOT_ALLOWED']);
});

test('全部不在名單 → 一封都沒寄；不記時間（改好名單之後連同這一次再寄）；ErrorLog 講明', function () {
  const env = makeDigestEnv({ config: { EMAIL_ALLOWLIST: 'someone-else@example.org' } });
  addError(env, { message: '測試錯誤甲' });
  env.props.store.ADMIN_DIGEST_LAST_AT = String(Date.now() - 3 * DAY);
  const before = env.props.store.ADMIN_DIGEST_LAST_AT;
  env.sandbox.dailyQuarterAutoCreateTrigger_();
  assert.strictEqual(env.mails.length, 0);
  assert.strictEqual(env.props.store.ADMIN_DIGEST_LAST_AT, before);
  assert.ok(errorRows(env).some(function (r) { return r.ERROR_CODE === 'ADMIN_DIGEST_NOT_ALLOWED'; }));
});

test('摘要自己失敗（MailApp 丟錯）→ 不影響建立季度與排序兩段；ErrorLog 記一筆；不記時間', function () {
  const env = makeDigestEnv({ mailFails: true });
  const sb = env.sandbox;
  const calls = [];
  const realCreate = sb.runAutoCreateQuarters_;
  const realSort = sb.runNightlyContentSort_;
  sb.runAutoCreateQuarters_ = function () { calls.push('create'); return realCreate.apply(sb, arguments); };
  sb.runNightlyContentSort_ = function () { calls.push('sort'); return realSort.apply(sb, arguments); };
  addError(env, { message: '測試錯誤甲' });
  env.props.store.ADMIN_DIGEST_LAST_AT = String(Date.now() - 3 * DAY);
  const before = env.props.store.ADMIN_DIGEST_LAST_AT;

  assert.doesNotThrow(function () { sb.dailyQuarterAutoCreateTrigger_(); });
  assert.deepStrictEqual(calls, ['create', 'sort'], '兩段照常做完');
  assert.ok(errorRows(env).some(function (r) { return r.FUNCTION_NAME === 'runAdminDailyDigest_' && r.ERROR_CODE === 'ADMIN_DIGEST_SEND_FAILED'; }));
  assert.strictEqual(env.props.store.ADMIN_DIGEST_LAST_AT, before, '寄不出就不記時間');
  assert.ok(sendLogRows(env).every(function (l) { return l.STATUS === 'FAILED'; }));
});

test('摘要本身拋出例外（不是寄信失敗）→ 外層接住，只記 ErrorLog，觸發器不拋錯，前兩段照做', function () {
  const env = makeDigestEnv({});
  const sb = env.sandbox;
  const calls = [];
  sb.runAutoCreateQuarters_ = function () { calls.push('create'); return {}; };
  sb.runNightlyContentSort_ = function () { calls.push('sort'); return {}; };
  sb.runAdminDailyDigest_ = function () { throw new Error('摘要壞了（測試）'); };
  assert.doesNotThrow(function () { sb.dailyQuarterAutoCreateTrigger_(); });
  assert.deepStrictEqual(calls, ['create', 'sort']);
  assert.ok(errorRows(env).some(function (r) { return r.FUNCTION_NAME === 'runAdminDailyDigest_' && r.MESSAGE.indexOf('摘要壞了') !== -1; }));
});

test('建立季度那一段失敗 → 摘要照樣寄，而且把這一個失敗放進去（排在最後一段的理由）', function () {
  const env = makeDigestEnv({});
  const sb = env.sandbox;
  sb.runAutoCreateQuarters_ = function () { throw new Error('Service Spreadsheets timed out（建立季度）'); };
  env.props.store.ADMIN_DIGEST_LAST_AT = String(Date.now() - 3 * DAY);
  sb.dailyQuarterAutoCreateTrigger_();
  assert.ok(env.mails.length > 0, '有寄出');
  assert.ok(env.mails[0].body.indexOf('建立季度') !== -1 && env.mails[0].body.indexOf('dailyQuarterAutoCreateTrigger_') !== -1, env.mails[0].body);
});

// =====================================================================
console.log('\nR-057：內容與上限');
// =====================================================================

test('超過 20 行 → 只列 20 行，講明還有幾行；每行訊息最多 200 字', function () {
  const env = makeDigestEnv({});
  for (let i = 0; i < 25; i++) addError(env, { fn: 'fn' + i + '_', message: i === 0 ? ('長'.repeat(300)) : ('錯誤' + i) });
  env.props.store.ADMIN_DIGEST_LAST_AT = String(Date.now() - 3 * DAY);
  env.sandbox.dailyQuarterAutoCreateTrigger_();
  const body = env.mails[0].body;
  const errorLines = body.split('\n').filter(function (l) { return /fn\d+_/.test(l); });
  assert.strictEqual(errorLines.length, 20, '實際 ' + errorLines.length);
  assert.ok(body.indexOf('另有 5 行未列出') !== -1, body);
  assert.ok(body.indexOf('共 25 項') !== -1, body);
  const longLine = errorLines.filter(function (l) { return l.indexOf('長長長') !== -1; })[0];
  assert.ok(longLine && longLine.indexOf('長'.repeat(200) + '…') !== -1 && longLine.indexOf('長'.repeat(201)) === -1, '訊息要截在 200 字');
});

test('ADMIN_DIGEST_ENABLED＝FALSE → 完全不處理（不寄、不記時間）', function () {
  const env = makeDigestEnv({ config: { ADMIN_DIGEST_ENABLED: 'FALSE' } });
  addError(env, {});
  const r = plain(env.sandbox.runAdminDailyDigest_({}));
  assert.strictEqual(r.reason, 'DISABLED');
  assert.strictEqual(env.mails.length, 0);
  assert.strictEqual(env.props.store.ADMIN_DIGEST_LAST_AT, undefined);
});

test('ADMIN_DIGEST_EMAILS 指定地址 → 用它，不看 Recipients；格式不對的略過並在摘要講出來', function () {
  const env = makeDigestEnv({ config: { ADMIN_DIGEST_EMAILS: 'boss@example.org, 不是電郵, boss@example.org' } });
  addError(env, {});
  env.sandbox.dailyQuarterAutoCreateTrigger_();
  assert.deepStrictEqual(env.mails.map(function (m) { return m.to; }), ['boss@example.org'], '重複的只寄一次');
  assert.ok(env.mails[0].body.indexOf('格式不對的地址，已略過：不是電郵') !== -1, env.mails[0].body);
});

test('Recipients 沒有 ADMIN 也沒有 IT → 寄給本系統帳戶；連帳戶都取不到 → NO_RECIPIENTS 並記 ErrorLog', function () {
  const env = makeDigestEnv({ recipients: [{ RECIPIENT_ID: 'R4', NAME: '堂委丁', EMAIL: 'cc1@example.org', GROUP_NAME: 'CC', ACTIVE: true }] });
  addError(env, {});
  env.sandbox.dailyQuarterAutoCreateTrigger_();
  assert.deepStrictEqual(env.mails.map(function (m) { return m.to; }), ['tester@x.com']);

  const none = makeDigestEnv({ recipients: [{ RECIPIENT_ID: 'R4', NAME: '堂委丁', EMAIL: 'cc1@example.org', GROUP_NAME: 'CC', ACTIVE: true }] });
  none.sandbox.Session = { getEffectiveUser: function () { throw new Error('沒有權限'); }, getScriptTimeZone: function () { return 'Pacific/Auckland'; }, getActiveUser: function () { return { getEmail: function () { return ''; } }; } };
  addError(none, {});
  const r = plain(none.sandbox.runAdminDailyDigest_({}));
  assert.strictEqual(r.reason, 'NO_RECIPIENTS');
  assert.ok(errorRows(none).some(function (e) { return e.ERROR_CODE === 'ADMIN_DIGEST_NO_RECIPIENTS'; }));
});

test('範本：ADMIN_DIGEST 有種子（主旨、內文有三個佔位符）；工作表上改過的主旨照用；找不到那一行就用內建的', function () {
  const env = makeDigestEnv({});
  const seeded = env.sandbox.seedEmailTemplatesRows_().filter(function (t) { return t.TEMPLATE_ID === 'ADMIN_DIGEST'; })[0];
  assert.ok(seeded && seeded.ACTIVE === true);
  ['{{CongregationName}}', '{{DigestLines}}', '{{ErrorCount}}'].forEach(function (ph) {
    assert.ok((seeded.SUBJECT + seeded.BODY).indexOf(ph) !== -1, '種子範本要用到 ' + ph);
  });

  // 工作表上有一行，主旨被人手改過。
  const custom = makeDigestEnv({});
  custom.sandbox.writeSheet_(custom.sandbox.SHEETS.EMAIL_TEMPLATES, [{
    TEMPLATE_ID: 'ADMIN_DIGEST', SUBJECT: '自訂主旨 {{ErrorCount}}', BODY: '自訂內文\n{{DigestLines}}', ACTIVE: true, NOTES: ''
  }]);
  addError(custom, {});
  custom.sandbox.dailyQuarterAutoCreateTrigger_();
  assert.ok(custom.mails[0].subject.indexOf('自訂主旨 1') === 0, custom.mails[0].subject);
  assert.ok(custom.mails[0].body.indexOf('自訂內文') === 0, custom.mails[0].body);

  // 找不到那一行（未按「初始化工作表」）→ 內建那一份，照樣寄得出。
  const noRow = makeDigestEnv({});
  addError(noRow, {});
  noRow.sandbox.dailyQuarterAutoCreateTrigger_();
  assert.ok(noRow.mails.length > 0 && noRow.mails[0].subject.indexOf('管理員摘要') !== -1);
});

test('Config：ADMIN_DIGEST_ENABLED 預設 TRUE、ADMIN_DIGEST_EMAILS 預設空白', function () {
  const sb = makeDigestEnv({}).sandbox;
  const byKey = {};
  sb.DEFAULTS.forEach(function (d) { byKey[d.key] = d.value; });
  assert.strictEqual(byKey.ADMIN_DIGEST_ENABLED, 'TRUE');
  assert.strictEqual(byKey.ADMIN_DIGEST_EMAILS, '');
});

// =====================================================================
console.log('\nR-057：星期一流程有沒有執行（2027-11-14 是目標主日，寄送日是 11-08 星期一）');
// =====================================================================

const WEEK_TODAY = '2027-11-09';          // 星期二：寄送日之後、目標主日之前
const WEEK_TARGET = '2027-11-14';

function addSendRow(env, spec) {
  env.sandbox.writeSheet_(env.sandbox.SHEETS.SEND_LOG, [{
    TIMESTAMP: new Date(2027, 10, spec.day || 8, 6, 0, 0), SERVICE_DATE: env.sandbox.normalizeDate_(spec.target || WEEK_TARGET),
    RECIPIENT_EMAIL: 'x@example.org', SUBJECT: 's', STATUS: spec.status || 'PREVIEW', DRY_RUN: spec.dryRun === true,
    ROSTER_VERSION_USED: spec.tag || '', ERROR: '', BODY_PREVIEW: ''
  }]);
}
function addAuditRow(env, spec) {
  env.sandbox.writeSheet_(env.sandbox.SHEETS.AUDIT_LOG, [{
    TIMESTAMP: new Date(2027, 10, spec.day || 8, 6, 0, 0), ACTOR: 'x', ACTION: spec.action, SHEET_NAME: 'SendLog',
    ROW_KEY: spec.target || WEEK_TARGET, FIELD: '', OLD_VALUE: '', NEW_VALUE: '', NOTES: ''
  }]);
}

test('星期二、SendLog 與 AuditLog 都沒有這個目標主日的痕跡 → 摘要加一行「星期一自動流程本週未見執行」（沒有錯誤也寄）', function () {
  const env = makeDigestEnv({ fixedToday: WEEK_TODAY });
  env.sandbox.dailyQuarterAutoCreateTrigger_();
  assert.ok(env.mails.length > 0, '沒有錯誤，但星期一流程沒有執行，也要寄');
  const body = env.mails[0].body;
  assert.ok(body.indexOf('星期一自動流程本週未見執行') !== -1, body);
  assert.ok(body.indexOf('試寄星期一草稿預覽信') !== -1, body);
  assert.ok(body.indexOf(WEEK_TARGET) !== -1, body);
});

test('SendLog 有這個目標主日的 PREVIEW／DRY_RUN／SENT 行 → 不加那一行（不寄）', function () {
  ['PREVIEW', 'DRY_RUN', 'SENT'].forEach(function (status) {
    const env = makeDigestEnv({ fixedToday: WEEK_TODAY });
    addSendRow(env, { status: status, dryRun: status === 'DRY_RUN' });
    env.sandbox.dailyQuarterAutoCreateTrigger_();
    assert.strictEqual(env.mails.length, 0, status + ' 要算有執行');
  });
});

test('AuditLog 有 WEEKLY_SEND_SKIPPED／WEEKLY_SEND_BULLETIN_SKIPPED → 算有執行', function () {
  ['WEEKLY_SEND_SKIPPED', 'WEEKLY_SEND_BULLETIN_SKIPPED'].forEach(function (action) {
    const env = makeDigestEnv({ fixedToday: WEEK_TODAY });
    addAuditRow(env, { action: action });
    env.sandbox.dailyQuarterAutoCreateTrigger_();
    assert.strictEqual(env.mails.length, 0, action + ' 要算有執行');
  });
});

test('別的主日的痕跡、寄送日之前的舊痕跡、摘要自己的 SendLog 行都不算', function () {
  const env = makeDigestEnv({ fixedToday: WEEK_TODAY });
  addSendRow(env, { target: '2027-11-07', status: 'SENT' });                   // 上一個主日
  addSendRow(env, { day: 3, status: 'PREVIEW' });                             // 寄送日（11-08）之前
  addSendRow(env, { status: 'SENT', tag: 'ADMIN_DIGEST' });                    // 摘要自己的行
  addAuditRow(env, { action: 'WEEKLY_SEND_SKIPPED', target: '2027-11-07' });
  addAuditRow(env, { action: 'SOME_OTHER_ACTION' });
  env.sandbox.dailyQuarterAutoCreateTrigger_();
  assert.ok(env.mails.length > 0, '這些都不是證據，要警告');
  assert.ok(env.mails[0].body.indexOf('星期一自動流程本週未見執行') !== -1);
});

test('寄送日當日（星期一）與目標主日當日（星期日）不判斷', function () {
  ['2027-11-08', '2027-11-14'].forEach(function (today) {
    const env = makeDigestEnv({ fixedToday: today });
    env.sandbox.dailyQuarterAutoCreateTrigger_();
    assert.strictEqual(env.mails.length, 0, today + ' 不應該警告');
  });
});

test('detectWeeklyFlowMissing_：邊界——SEND_WEEKDAY 是 SUNDAY／不合法／日期不合法', function () {
  const sb = makeDigestEnv({}).sandbox;
  const base = { todayIso: '2027-11-10', targetIso: WEEK_TARGET, sendWeekday: 'SUNDAY', sendLogRows: [], auditRows: [] };
  const sunday = plain(sb.detectWeeklyFlowMissing_(base));
  assert.strictEqual(sunday.sendIso, '2027-11-07', '星期日當寄送日＝上一個星期日');
  assert.strictEqual(sunday.checked, true);
  assert.strictEqual(sunday.missing, true);

  const badDay = plain(sb.detectWeeklyFlowMissing_(Object.assign({}, base, { sendWeekday: '亂寫' })));
  assert.strictEqual(badDay.checked, false);
  assert.ok(badDay.reason);
  const badDate = plain(sb.detectWeeklyFlowMissing_(Object.assign({}, base, { todayIso: 'x' })));
  assert.strictEqual(badDate.checked, false);

  assert.strictEqual(plain(sb.detectWeeklyFlowMissing_(Object.assign({}, base, { sendWeekday: 'MONDAY', todayIso: '2027-11-08' }))).checked, false);
  assert.strictEqual(plain(sb.detectWeeklyFlowMissing_(Object.assign({}, base, { sendWeekday: 'MONDAY', todayIso: '2027-11-13' }))).missing, true);
});

// =====================================================================
console.log('\nR-057：與不變量 I04 的關係');
// =====================================================================

test('摘要的 SendLog 行不會被當成「最近一批寄出記錄」（否則 I04 會拿它去對週報的收件組別）', function () {
  const env = makeDigestEnv({ config: { DRY_RUN: 'TRUE' } });
  const sb = env.sandbox;
  const old = new Date(2027, 10, 1, 6, 0, 0);
  sb.writeSheet_(sb.SHEETS.SEND_LOG, [
    { TIMESTAMP: old, SERVICE_DATE: sb.normalizeDate_('2027-11-07'), RECIPIENT_EMAIL: 'a@example.org', STATUS: 'PREVIEW', DRY_RUN: true, BATCH_ID: 'B-WEEKLY' }
  ]);
  addError(env, {});
  sb.dailyQuarterAutoCreateTrigger_();                       // DRY_RUN：寫一行摘要的 SendLog（BATCH_ID 較新）
  assert.strictEqual(sendLogRows(env).length, 2);
  const batch = plain(sb.invariantLatestSendLogBatch_(sb.readSheet_(sb.SHEETS.SEND_LOG)));
  assert.strictEqual(batch.length, 1);
  assert.strictEqual(batch[0].BATCH_ID, 'B-WEEKLY', '最近一批要是週報那一批，不是摘要');
});

test('isAdminDigestSendLogRow_ 認標記，不認狀態或主旨', function () {
  const sb = makeDigestEnv({}).sandbox;
  assert.strictEqual(sb.isAdminDigestSendLogRow_({ ROSTER_VERSION_USED: 'ADMIN_DIGEST' }), true);
  assert.strictEqual(sb.isAdminDigestSendLogRow_({ ROSTER_VERSION_USED: '2027T4', STATUS: 'DRY_RUN' }), false);
  assert.strictEqual(sb.isAdminDigestSendLogRow_({}), false);
});

console.log('\n通過 ' + pass + ' 項，失敗 ' + fail + ' 項。');
process.exit(fail === 0 ? 0 : 1);
