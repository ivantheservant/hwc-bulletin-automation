/**
 * src/AdminDigest.gs
 *
 * R-057（2026-11-17）：每日管理員摘要電郵。
 *
 *   背景（正式試算表 ErrorLog）：11/12 `contentAutoSyncTrigger_`、11/15 `dailyQuarterAutoCreateTrigger_` 都曾經
 *   失敗，沒有任何人收到通知，要有人打開 ErrorLog 才知道。觸發器在背景執行，失敗只會留在試算表裏面。
 *
 *   由 `dailyQuarterAutoCreateTrigger_()` 最後一段呼叫（自己包 try/catch，失敗只記 ErrorLog；不新增觸發器）。
 *   有任何一項才寄，沒有就不寄：
 *     1. 上一次摘要之後 ErrorLog 內 `SOURCE=TRIGGER` 的行（時間、函式、錯誤代碼、訊息前 200 字，最多 20 行）；
 *     2. 星期一自動流程本週有沒有執行：今日在寄送日之後、目標主日之前，SendLog 與 AuditLog 都找不到這一個
 *        目標主日的執行痕跡。
 *
 *   ⚠️ 寄出只經 `sendEmailAllowlisted_()`（src/MailGuard.gs）；`DRY_RUN=TRUE` 時不寄，只寫 SendLog 一行
 *   `STATUS=DRY_RUN`。摘要的 SendLog 行 `SERVICE_DATE` 留空、`ROSTER_VERSION_USED` 記 `ADMIN_DIGEST`：
 *   第 2 項靠「這個目標主日有沒有 SendLog 行」判斷星期一流程有沒有執行，摘要自己的行不可以被當成那一種證據；
 *   不變量 I04 看「最近一批寄出記錄」，亦不可以把摘要當成一次週報寄出（見 `isAdminDigestSendLogRow_()`）。
 */

'use strict';

/** 記下上一次摘要時間（毫秒）的指令碼屬性鍵。只用來劃定「自上次之後」；讀不到就當過去 24 小時。 */
var ADMIN_DIGEST_LAST_AT_KEY_ = 'ADMIN_DIGEST_LAST_AT';

/** 系統範本 ID。 */
var ADMIN_DIGEST_TEMPLATE_ID_ = 'ADMIN_DIGEST';

/** 摘要裏最多列出幾行觸發器錯誤。 */
var ADMIN_DIGEST_MAX_ERROR_LINES_ = 20;

/** 每行錯誤訊息最多取幾個字。 */
var ADMIN_DIGEST_MESSAGE_CHARS_ = 200;

/** 摘要在 SendLog `ROSTER_VERSION_USED` 欄的標記。 */
var ADMIN_DIGEST_SEND_LOG_TAG_ = 'ADMIN_DIGEST';

/**
 * 用途：星期一流程「有執行過」的證據：這幾種 SendLog 狀態。
 *   `PREVIEW`＝草稿預覽（試行或真寄都是這個狀態）、`DRY_RUN`／`SENT`＝週報本身。
 */
var ADMIN_DIGEST_FLOW_SEND_STATUSES_ = ['PREVIEW', 'DRY_RUN', 'SENT'];

/** 星期一流程「有執行過」的另一種證據：AuditLog 的這兩個動作（`weeklyBulletinSendTrigger_()` 寫的）。 */
var ADMIN_DIGEST_FLOW_AUDIT_ACTIONS_ = ['WEEKLY_SEND_SKIPPED', 'WEEKLY_SEND_BULLETIN_SKIPPED'];

/**
 * 用途：判斷一行 SendLog 是不是每日管理員摘要自己的記錄。純函式。
 *   星期一流程的判斷與不變量 I04 都要把它排除。
 * Args:
 *   row {Object} `SendLog` 的資料列。
 * Returns:
 *   {boolean}
 */
function isAdminDigestSendLogRow_(row) {
  return String((row && row.ROSTER_VERSION_USED) || '').trim() === ADMIN_DIGEST_SEND_LOG_TAG_;
}

/**
 * 用途：ADMIN_DIGEST 範本的種子資料（主旨、內文可以在 EmailTemplates 改）。由
 *   `seedEmailTemplatesRows_()` 取用；工作表上找不到這一行時 `runAdminDailyDigest_()` 退回用這一份。
 *   佔位符：`{{CongregationName}}`、`{{DigestLines}}`、`{{ErrorCount}}`。
 * Args: （無）
 * Returns:
 *   {{TEMPLATE_ID:string, SUBJECT:string, BODY:string, ACTIVE:boolean, NOTES:string}}
 */
function adminDigestTemplateRow_() {
  return {
    TEMPLATE_ID: ADMIN_DIGEST_TEMPLATE_ID_,
    SUBJECT: '{{CongregationName}}週報系統管理員摘要（觸發器錯誤 {{ErrorCount}} 項）',
    BODY: [
      '各位管理員：',
      '',
      '以下是{{CongregationName}}週報系統自上一次摘要之後，需要留意的事項：',
      '',
      '{{DigestLines}}',
      '',
      '詳情請在週報試算表查看 ErrorLog 與 SendLog 工作表。',
      '',
      '{{CongregationName}}週報系統　自動寄出'
    ].join('\n'),
    ACTIVE: true,
    NOTES: 'R-057：每日管理員摘要（觸發器失敗、星期一流程沒有執行）。沒有事項就不寄。'
      + '⚠️ {{DigestLines}} 由系統逐行砌出，不要刪走。收件人見 Config ADMIN_DIGEST_EMAILS。'
  };
}

/**
 * 用途：讀每日管理員摘要的 Config。
 * Args: （無）
 * Returns:
 *   {{enabled:boolean, emailsRaw:string}}
 */
function adminDigestConfig_() {
  return {
    enabled: normalizeBoolean_(getConfig_(CONFIG_KEYS.ADMIN_DIGEST_ENABLED, 'TRUE')) === true,
    emailsRaw: String(getConfig_(CONFIG_KEYS.ADMIN_DIGEST_EMAILS, '') || '').trim()
  };
}

/**
 * 用途：挑出摘要要列的觸發器錯誤：`SOURCE=TRIGGER`、時間在 `sinceMs` 之後，由舊到新。純函式。
 * Args:
 *   errorRows {Object[]} `ErrorLog` 的資料列。
 *   sinceMs {number} 這個時間（毫秒）之後的才算。
 * Returns:
 *   {Object[]}
 */
function pickAdminDigestErrorRows_(errorRows, sinceMs) {
  return (errorRows || []).filter(function (r) {
    if (String(r.SOURCE || '').trim() !== ERROR_LOG_SOURCE.TRIGGER) return false;
    if (Object.prototype.toString.call(r.TIMESTAMP) !== '[object Date]') return false;
    return r.TIMESTAMP.getTime() > sinceMs;
  }).sort(function (a, b) { return a.TIMESTAMP.getTime() - b.TIMESTAMP.getTime(); });
}

/**
 * 用途：把觸發器錯誤排成摘要內文的行：時間、函式、錯誤代碼、訊息前 200 字；最多 `maxLines` 行，超過的講明還有幾行。
 *   純函式（時間格式由呼叫方傳入的函式決定）。
 * Args:
 *   rows {Object[]} `pickAdminDigestErrorRows_()` 的輸出。
 *   maxLines {number} 最多列幾行。
 *   formatTime {function(Date):string} 把時間排成文字。
 * Returns:
 *   {string[]}
 */
function formatAdminDigestErrorLines_(rows, maxLines, formatTime) {
  var list = rows || [];
  var lines = list.slice(0, maxLines).map(function (r) {
    var message = String(r.MESSAGE || '').replace(/\s+/g, ' ').trim();
    if (message.length > ADMIN_DIGEST_MESSAGE_CHARS_) message = message.slice(0, ADMIN_DIGEST_MESSAGE_CHARS_) + '…';
    return formatTime(r.TIMESTAMP) + '　' + String(r.FUNCTION_NAME || '（未記函式）') + '　'
      + String(r.ERROR_CODE || '（無代碼）') + '　' + message;
  });
  if (list.length > maxLines) {
    lines.push('（另有 ' + (list.length - maxLines) + ' 行未列出，請在 ErrorLog 查看。）');
  }
  return lines;
}

/**
 * 用途：Config `SEND_WEEKDAY`（英文全大寫）轉成 0（星期日）至 6（星期六）。純函式。
 * Args:
 *   name {string}
 * Returns:
 *   {number} 認不出回 -1。
 */
function adminDigestWeekdayIndex_(name) {
  var names = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
  return names.indexOf(String(name || '').trim().toUpperCase());
}

/**
 * 用途：判斷「星期一自動流程本週有沒有執行」。純函式。
 *
 *   只在今日是寄送日**之後**、目標主日**之前**才判斷（寄送日當日觸發器還未必跑過；每日觸發器排在寄送前一小時）。
 *   寄送日＝目標主日之前最近一個 `SEND_WEEKDAY`。找得到執行痕跡就是有執行：
 *     - SendLog 有這個目標主日的 `PREVIEW`／`DRY_RUN`／`SENT` 行（時間在寄送日或之後；摘要自己的行不算）；或
 *     - AuditLog 有 `WEEKLY_SEND_SKIPPED`／`WEEKLY_SEND_BULLETIN_SKIPPED`（資料鍵是這個目標主日，時間在寄送日或之後）。
 * Args:
 *   input {{todayIso:string, targetIso:string, sendWeekday:string, sendLogRows:Object[], auditRows:Object[]}}
 * Returns:
 *   {{checked:boolean, missing:boolean, sendIso:string, reason:string}} `checked:false` 代表今日不在判斷範圍
 *     （`reason` 講原因）；`missing:true` 才要在摘要加一行。
 */
function detectWeeklyFlowMissing_(input) {
  var todayIso = String(input.todayIso || '');
  var targetIso = String(input.targetIso || '');
  var weekdayIndex = adminDigestWeekdayIndex_(input.sendWeekday);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(todayIso) || !/^\d{4}-\d{2}-\d{2}$/.test(targetIso)) {
    return { checked: false, missing: false, sendIso: '', reason: '日期不合法' };
  }
  if (weekdayIndex < 0) {
    return { checked: false, missing: false, sendIso: '', reason: 'Config SEND_WEEKDAY 不是合法的星期幾' };
  }
  // 寄送日：目標主日（星期日）之前最近一個 SEND_WEEKDAY（星期日當寄送日就是上一個星期日）。
  var daysBack = (7 - weekdayIndex) % 7;
  if (daysBack === 0) daysBack = 7;
  var sendIso = addDaysToIsoDate_(targetIso, -daysBack);
  if (!(todayIso > sendIso && todayIso < targetIso)) {
    return { checked: false, missing: false, sendIso: sendIso, reason: '今日不在寄送日之後、目標主日之前' };
  }

  function isoOfStamp(stamp) {
    return Object.prototype.toString.call(stamp) === '[object Date]' ? formatIsoDate_(stamp) : '';
  }
  var sawSend = (input.sendLogRows || []).some(function (r) {
    if (isAdminDigestSendLogRow_(r)) return false;
    if (ADMIN_DIGEST_FLOW_SEND_STATUSES_.indexOf(String(r.STATUS || '').trim()) === -1) return false;
    if (fieldOverrideIsoOf_(r.SERVICE_DATE) !== targetIso) return false;
    var at = isoOfStamp(r.TIMESTAMP);
    return at !== '' && at >= sendIso;
  });
  var sawAudit = (input.auditRows || []).some(function (r) {
    if (ADMIN_DIGEST_FLOW_AUDIT_ACTIONS_.indexOf(String(r.ACTION || '').trim()) === -1) return false;
    if (String(r.ROW_KEY || '').trim() !== targetIso) return false;
    var at = isoOfStamp(r.TIMESTAMP);
    return at !== '' && at >= sendIso;
  });
  return { checked: true, missing: !(sawSend || sawAudit), sendIso: sendIso, reason: '' };
}

/**
 * 用途：摘要的收件人：Config `ADMIN_DIGEST_EMAILS`（逗號分隔）；留空＝Recipients 內 ADMIN 與 IT 組生效的收件人；
 *   兩組都沒有人＝`Session.getEffectiveUser()`。格式不對的地址略過，並回報讓摘要自己講出來。
 * Args:
 *   emailsRaw {string} Config 原值。
 *   todayIso {string} 判斷 Recipients 生效日期用。
 * Returns:
 *   {{addresses:string[], invalid:string[], source:string}} `source`：`CONFIG`／`RECIPIENTS`／`EFFECTIVE_USER`／`NONE`。
 */
function resolveAdminDigestRecipients_(emailsRaw, todayIso) {
  var raw = String(emailsRaw || '').trim();
  if (raw) {
    var addresses = [];
    var invalid = [];
    parseConfigTextList_(raw).forEach(function (a) {
      if (isValidEmailShape_(a)) { if (addresses.indexOf(a) === -1) addresses.push(a); } else invalid.push(a);
    });
    return { addresses: addresses, invalid: invalid, source: 'CONFIG' };
  }
  var fromRecipients = buildRecipientList_(readSheet_(SHEETS.RECIPIENTS), ['ADMIN', 'IT'], normalizeDate_(todayIso));
  if (fromRecipients.recipients.length > 0) {
    return {
      addresses: fromRecipients.recipients.map(function (r) { return r.email; }),
      invalid: [], source: 'RECIPIENTS'
    };
  }
  var me = '';
  try {
    me = String(Session.getEffectiveUser().getEmail() || '').trim();
  } catch (err) {
    me = '';
  }
  if (me && isValidEmailShape_(me)) return { addresses: [me], invalid: [], source: 'EFFECTIVE_USER' };
  return { addresses: [], invalid: [], source: 'NONE' };
}

/**
 * 用途：讀上一次摘要的時間（毫秒）；沒有、讀不到、不合理（未來）就當過去 24 小時。
 * Args:
 *   nowMs {number} 現在（毫秒）。
 * Returns:
 *   {number} 「自上次之後」的起點。
 */
function readAdminDigestSinceMs_(nowMs) {
  var fallback = nowMs - 24 * 3600 * 1000;
  try {
    var raw = PropertiesService.getScriptProperties().getProperty(ADMIN_DIGEST_LAST_AT_KEY_);
    var n = Number(raw);
    if (raw && isFinite(n) && n > 0 && n <= nowMs) return n;
  } catch (err) {
    // 讀不到就當過去 24 小時。
  }
  return fallback;
}

/**
 * 用途：記下這一次摘要的時間。寫不到不影響結果（下一次當過去 24 小時）。
 * Args:
 *   nowMs {number}
 * Returns:
 *   {void}
 */
function writeAdminDigestLastAt_(nowMs) {
  try {
    PropertiesService.getScriptProperties().setProperty(ADMIN_DIGEST_LAST_AT_KEY_, String(nowMs));
  } catch (err) {
    // 寫不到下一次當過去 24 小時。
  }
}

/**
 * 用途：每日管理員摘要的入口（見檔頭）。IO 層。**永不拋錯**——失敗只記 ErrorLog。
 * Args:
 *   options {{source:string=, todayIso:string=, nowMs:number=}=} `todayIso`、`nowMs` 是測試的注入點，
 *     正式流程不傳（今日用 Config `SYS_TIMEZONE` 的真正今日，不看模擬今日）。
 * Returns:
 *   {{sent:boolean, reason:string, errorCount:number, weeklyMissing:boolean, recipientCount:number,
 *     lines:string[], message:string}}
 *     `reason`：`DISABLED`／`NOTHING_TO_REPORT`／`DRY_RUN`／`SENT`／`NO_RECIPIENTS`／`NOT_ALLOWED`／
 *     `SEND_FAILED`／`ERROR`。
 */
function runAdminDailyDigest_(options) {
  var opts = options || {};
  var out = { sent: false, reason: '', errorCount: 0, weeklyMissing: false, recipientCount: 0, lines: [], message: '' };
  try {
    var config = adminDigestConfig_();
    if (!config.enabled) {
      out.reason = 'DISABLED';
      out.message = 'Config ' + CONFIG_KEYS.ADMIN_DIGEST_ENABLED + ' 不是 TRUE，沒有寄管理員摘要。';
      return out;
    }

    var nowMs = opts.nowMs || new Date().getTime();
    var timezone = getConfig_(CONFIG_KEYS.SYS_TIMEZONE, 'Pacific/Auckland');
    var todayIso = opts.todayIso || Utilities.formatDate(new Date(nowMs), timezone, 'yyyy-MM-dd');
    var sinceMs = readAdminDigestSinceMs_(nowMs);

    // ---- 1. 觸發器錯誤 ----
    var errorRows = pickAdminDigestErrorRows_(readSheet_(SHEETS.ERROR_LOG), sinceMs);
    out.errorCount = errorRows.length;
    var lines = [];
    if (errorRows.length > 0) {
      lines.push('【觸發器錯誤（共 ' + errorRows.length + ' 項）】');
      formatAdminDigestErrorLines_(errorRows, ADMIN_DIGEST_MAX_ERROR_LINES_, function (d) {
        return Utilities.formatDate(d, timezone, 'yyyy-MM-dd HH:mm');
      }).forEach(function (l) { lines.push(l); });
    }

    // ---- 2. 星期一流程有沒有執行 ----
    var schedule = weeklyTriggerTargetSunday_({ todayIso: todayIso });
    if (schedule.ok) {
      var flow = detectWeeklyFlowMissing_({
        todayIso: todayIso, targetIso: schedule.isoDate,
        sendWeekday: getConfig_(CONFIG_KEYS.SEND_WEEKDAY, 'MONDAY'),
        sendLogRows: readSheet_(SHEETS.SEND_LOG), auditRows: readSheet_(SHEETS.AUDIT_LOG)
      });
      if (flow.missing) {
        out.weeklyMissing = true;
        if (lines.length > 0) lines.push('');
        lines.push('【星期一自動流程】');
        lines.push('星期一自動流程本週未見執行（目標主日 ' + schedule.isoDate + '），請按選單「試寄星期一草稿預覽信」補寄。');
      }
    }

    if (lines.length === 0) {
      // 沒有事項：記下時間，下一次只看之後新增的。
      writeAdminDigestLastAt_(nowMs);
      out.reason = 'NOTHING_TO_REPORT';
      out.message = '沒有需要通知管理員的事項。';
      return out;
    }

    // ---- 收件人 ----
    var recipients = resolveAdminDigestRecipients_(config.emailsRaw, todayIso);
    if (recipients.invalid.length > 0) {
      lines.push('');
      lines.push('⚠️ Config ' + CONFIG_KEYS.ADMIN_DIGEST_EMAILS + ' 內有格式不對的地址，已略過：' + recipients.invalid.join('、'));
    }
    out.lines = lines;
    if (recipients.addresses.length === 0) {
      out.reason = 'NO_RECIPIENTS';
      out.message = '有事項要通知管理員，但找不到收件人（Config ' + CONFIG_KEYS.ADMIN_DIGEST_EMAILS
        + ' 留空、Recipients 沒有 ADMIN 或 IT 組的有效收件人，亦取不到本系統帳戶）。';
      appendErrorLog_({
        source: ERROR_LOG_SOURCE.TRIGGER, functionName: 'runAdminDailyDigest_',
        errorCode: 'ADMIN_DIGEST_NO_RECIPIENTS', message: out.message
      });
      return out;
    }

    // ---- 組信 ----
    var rendered = renderAdminDigestMail_(lines, out.errorCount);
    var dryRun = normalizeBoolean_(getConfig_(CONFIG_KEYS.DRY_RUN, 'TRUE')) === true;
    out.recipientCount = recipients.addresses.length;

    if (dryRun) {
      // DRY_RUN：不寄，只寫 SendLog 一行 STATUS=DRY_RUN。
      writeSendLogRows_([adminDigestSendLogRow_(recipients.addresses.join(','), rendered, 'DRY_RUN', true, '')]);
      writeAdminDigestLastAt_(nowMs);
      out.reason = 'DRY_RUN';
      out.message = '測試模式（DRY_RUN=TRUE）：管理員摘要沒有寄出，只寫了 SendLog。';
      return out;
    }

    var sendLogRows = [];
    var sentCount = 0;
    var blocked = 0;
    var failed = [];
    recipients.addresses.forEach(function (address) {
      var status = 'SENT';
      var errorMessage = '';
      try {
        var outcome = sendEmailAllowlisted_({ to: address, subject: rendered.subject, body: rendered.body }, 'runAdminDailyDigest_');
        if (outcome.sent) {
          sentCount++;
        } else {
          status = 'NOT_ALLOWED';
          errorMessage = outcome.message;
          blocked++;
        }
      } catch (mailErr) {
        status = 'FAILED';
        errorMessage = (mailErr && mailErr.message) ? mailErr.message : String(mailErr);
        failed.push(errorMessage);
      }
      sendLogRows.push(adminDigestSendLogRow_(address, rendered, status, false, errorMessage));
    });
    writeSendLogRows_(sendLogRows);

    if (sentCount === 0) {
      out.reason = failed.length > 0 ? 'SEND_FAILED' : 'NOT_ALLOWED';
      out.message = failed.length > 0
        ? '管理員摘要全部寄不出（第一個錯誤：' + failed[0] + '），詳情見 SendLog。'
        : '管理員摘要沒有寄出：' + emailAllowlistResultNote_(blocked);
      appendErrorLog_({
        source: ERROR_LOG_SOURCE.TRIGGER, functionName: 'runAdminDailyDigest_',
        errorCode: 'ADMIN_DIGEST_' + out.reason, message: out.message
      });
      return out;                                       // 不記時間：下一次連同這一次的事項再寄
    }
    writeAdminDigestLastAt_(nowMs);
    out.sent = true;
    out.reason = 'SENT';
    out.message = '管理員摘要已寄給 ' + sentCount + ' 個收件人。';
    return out;
  } catch (err) {
    out.reason = 'ERROR';
    out.message = (err && err.message) ? err.message : String(err);
    appendErrorLog_({
      source: ERROR_LOG_SOURCE.TRIGGER, functionName: 'runAdminDailyDigest_',
      errorCode: (err && err.code) || 'ERROR', message: out.message, detail: buildErrorDetail_(err)
    });
    return out;
  }
}

/**
 * 用途：把摘要的行套進 ADMIN_DIGEST 範本（工作表上的啟用中那一行；沒有就用 `adminDigestTemplateRow_()`）。
 * Args:
 *   lines {string[]} 摘要內文各行。
 *   errorCount {number} 觸發器錯誤數目（`{{ErrorCount}}`）。
 * Returns:
 *   {{subject:string, body:string}}
 */
function renderAdminDigestMail_(lines, errorCount) {
  var template = null;
  try {
    template = readSheet_(SHEETS.EMAIL_TEMPLATES).filter(function (t) {
      return t.TEMPLATE_ID === ADMIN_DIGEST_TEMPLATE_ID_ && t.ACTIVE === true;
    })[0] || null;
  } catch (err) {
    template = null;
  }
  if (!template) template = adminDigestTemplateRow_();
  var vars = {
    CongregationName: congregationName_(),
    ErrorCount: String(errorCount || 0),
    DigestLines: (lines || []).join('\n')
  };
  return {
    subject: renderEmailTemplate_(String(template.SUBJECT || ''), vars, []),
    body: tidyEmailBlankLines_(renderEmailTemplate_(String(template.BODY || ''), vars, []))
  };
}

/**
 * 用途：砌摘要的一行 SendLog。`SERVICE_DATE` 留空、`ROSTER_VERSION_USED` 記 `ADMIN_DIGEST`（見檔頭）。
 * Args:
 *   recipient {string} 收件人（DRY_RUN 那一行是全部地址，逗號分隔）。
 *   rendered {{subject:string, body:string}} 組好的信。
 *   status {string} `SENT`／`DRY_RUN`／`NOT_ALLOWED`／`FAILED`。
 *   dryRun {boolean}
 *   errorMessage {string}
 * Returns:
 *   {Object}
 */
function adminDigestSendLogRow_(recipient, rendered, status, dryRun, errorMessage) {
  return {
    TIMESTAMP: new Date(),
    SERVICE_DATE: '',
    RECIPIENT_EMAIL: sanitizeCellText_(recipient),
    SUBJECT: sanitizeCellText_(rendered.subject),
    STATUS: status,
    DRY_RUN: dryRun,
    ROSTER_VERSION_USED: ADMIN_DIGEST_SEND_LOG_TAG_,
    ERROR: sanitizeCellText_(errorMessage || ''),
    BODY_PREVIEW: buildSendLogBodyPreview_(rendered.body)
  };
}
