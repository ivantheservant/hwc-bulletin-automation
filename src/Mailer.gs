/**
 * Mailer.gs
 *
 * 週報寄送流程的真正入口 `sendBulletinForDate_(isoDate, options)`，以及
 * 兩個手動選單（「試寄下週週報」「預覽週報郵件內容」）。這是唯一會呼叫
 * `MailApp` 的檔案。
 *
 * ⚠️ 本檔案完全不對職事表試算表做任何寫入——`buildBulletinModel_()`／
 * `resolveRecipients_()` 都只讀週報自己的試算表；`MailApp` 是外部服務，
 * 不是任何試算表。
 */

'use strict';

/**
 * 用途：寄出指定主日的週報。逐步檢查（結構、資料、收件人、配額），
 *   任何一步不通過就拋錯、**不寄任何一封**；逐個收件人寄送時，單一
 *   收件人失敗不會中斷其餘的寄送。
 *
 *   步驟：
 *     1. `SEND_BLOCK_IF_SCHEMA_OUTDATED=TRUE` 時先跑 `checkSheetSchema_()`，
 *        結構落後就拒絕（`code:'SCHEMA_OUTDATED'`）。
 *     2. `buildBulletinModel_(isoDate)`——`notConfigured` 或 `found===false`
 *        都拋錯，不寄。
 *     3. `resolveRecipients_(isoDate)`——收件人為空就拋錯，訊息帶上
 *        `reason`，不可以把「寄了 0 封」當成功。
 *     4. 非 `DRY_RUN` 時檢查 `MailApp.getRemainingDailyQuota()`，不足以
 *        寄給全部收件人就拋錯，一封都不寄（避免寄一半）。
 *     5. `renderBulletinAttachment_(model)`——附件不可用只記下 `reason`，
 *        **不阻止寄送**（正文本身就是完整內容）。
 *     6. 逐個收件人寄送：`DRY_RUN=TRUE` 完全不呼叫 `MailApp.sendEmail`，
 *        只寫一行 `SendLog`（`STATUS='DRY_RUN'`）；`DRY_RUN=FALSE` 才真的
 *        呼叫，成功寫 `STATUS='SENT'`、失敗寫 `STATUS='FAILED'`（連同
 *        `ERROR` 訊息），單一收件人失敗不會中斷其餘的迴圈。
 *     7. 全部成功（`failedCount===0`）且非 `DRY_RUN` 時，把
 *        `BulletinWeeks` 的 `SENT_AT`／`STATUS` 更新並記一筆
 *        `AuditLog`；有任何失敗，或本來就是 `DRY_RUN`，都**不改**
 *        `STATUS`。
 * Args:
 *   isoDate {string} 主日日期，yyyy-MM-dd。
 *   options {Object=} 選填，目前保留擴充用，本輪未使用任何欄位。
 * Returns:
 *   {{ok:boolean, dryRun:boolean, totalRecipients:number, sentCount:number,
 *     failedCount:number, attachment:Object, recipientWarnings:Object[],
 *     templateWarnings:Object[]}}
 * Raises:
 *   Error（帶 `code`：`SCHEMA_OUTDATED`／`NOT_CONFIGURED`／
 *     `ROSTER_NOT_FOUND`／`NO_RECIPIENTS`／`QUOTA_INSUFFICIENT`／
 *     `TEMPLATE_NOT_FOUND`）如果任何一個前置檢查不通過。
 */
function sendBulletinForDate_(isoDate, options) {
  var blockIfOutdated = normalizeBoolean_(getConfig(CONFIG_KEYS.SEND_BLOCK_IF_SCHEMA_OUTDATED, 'TRUE')) === true;
  if (blockIfOutdated) {
    var schema = checkSheetSchema_();
    if (!schema.ok) {
      var schemaErr = new Error(
        '工作表結構落後於程式碼（' + buildSchemaMismatchSummary_(schema) + '），拒絕寄送。請先在試算表撳「初始化工作表」。'
      );
      schemaErr.code = 'SCHEMA_OUTDATED';
      throw schemaErr;
    }
  }

  var model = buildBulletinModel_(isoDate);
  if (model.notConfigured) {
    var notConfiguredErr = new Error('sendBulletinForDate_：職事表尚未設定（Config 的 ROSTER_SPREADSHEET_ID 是空的），無法寄送。');
    notConfiguredErr.code = 'NOT_CONFIGURED';
    throw notConfiguredErr;
  }
  // ⚠️ R-036：職事表未有該主日資料**不再一律當成錯誤**。
  //
  //    舊版一律拋 `ROSTER_NOT_FOUND` 然後停手——`ErrorLog` 有一筆
  //    2026-08-24 的實際紀錄，那一期完全沒有寄出。但週報的其餘部分
  //    （講題、詩歌、家事報告、人數）本來就齊，只是事奉欄位空著。
  //    寄一份「事奉待定」的週報，比完全不寄有用。
  //
  //    Config `SEND_WHEN_ROSTER_MISSING` 改成 FALSE 就回復舊行為。
  //    見 docs/已知bug類型.md 事故四十。
  var rosterPending = false;
  if (!model.found) {
    var sendAnyway = normalizeBoolean_(getConfig(CONFIG_KEYS.SEND_WHEN_ROSTER_MISSING, 'TRUE')) === true;
    if (!sendAnyway) {
      var notFoundErr = new Error('sendBulletinForDate_：' + isoDate
        + ' 這個主日在職事表找不到資料，而 Config 的 '
        + CONFIG_KEYS.SEND_WHEN_ROSTER_MISSING + ' 是 FALSE，所以不寄送。');
      notFoundErr.code = 'ROSTER_NOT_FOUND';
      throw notFoundErr;
    }
    rosterPending = true;
  }

  var recipientsResult = resolveRecipients_(isoDate);
  if (recipientsResult.recipients.length === 0) {
    var noRecipientsErr = new Error('sendBulletinForDate_：沒有可寄送的收件人（' + (recipientsResult.reason || '原因不明') + '）。');
    noRecipientsErr.code = 'NO_RECIPIENTS';
    throw noRecipientsErr;
  }

  var dryRun = normalizeBoolean_(getConfig(CONFIG_KEYS.DRY_RUN, 'TRUE')) === true;

  if (!dryRun) {
    var quota = MailApp.getRemainingDailyQuota();
    if (quota < recipientsResult.recipients.length) {
      var quotaErr = new Error(
        'sendBulletinForDate_：MailApp 每日配額不足（剩餘 ' + quota + ' 封，需要寄 '
        + recipientsResult.recipients.length + ' 封），為避免只寄一半，不寄送任何一封。'
      );
      quotaErr.code = 'QUOTA_INSUFFICIENT';
      throw quotaErr;
    }
  }

  var attachment = renderBulletinAttachment_(model);

  var templateId = getConfig(CONFIG_KEYS.EMAIL_TEMPLATE_ID, 'TPL_WEEKLY_BULLETIN');
  var templateRows = readSheet(SHEETS.EMAIL_TEMPLATES);
  var template = templateRows.filter(function (t) { return t.TEMPLATE_ID === templateId && t.ACTIVE === true; })[0];
  if (!template) {
    var templateErr = new Error('sendBulletinForDate_：EmailTemplates 找不到啟用中的範本「' + templateId + '」。');
    templateErr.code = 'TEMPLATE_NOT_FOUND';
    throw templateErr;
  }

  var includeMissing = normalizeBoolean_(getConfig(CONFIG_KEYS.SEND_INCLUDE_MISSING_LIST, 'TRUE')) === true;
  var timezone = getConfig(CONFIG_KEYS.SYS_TIMEZONE, 'Pacific/Auckland');
  var generatedAtText = Utilities.formatDate(new Date(), timezone, 'yyyy-MM-dd HH:mm:ss');

  var templateWarnings = [];
  var vars = {
    ChurchName: getConfig(CONFIG_KEYS.CHURCH_NAME, ''),
    ServiceDate: model.isoDate,
    SpecialType: model.special ? model.special.title : '',
    MissingCount: String(model.missing.length),
    RosterVersion: (model.rosterVersionUsed === null || model.rosterVersionUsed === undefined) ? '（尚未生成）' : String(model.rosterVersionUsed)
  };
  var churchNameWarning = checkChurchNameConfigured_(vars.ChurchName);
  if (churchNameWarning) templateWarnings.push(churchNameWarning);

  var subject = renderEmailTemplate_(template.SUBJECT, vars, templateWarnings);
  var introText = renderEmailTemplate_(template.BODY, vars, templateWarnings);

  // ⚠️ 事奉資料未定的話，一定要在信中講明——收信的人見到事奉框空白，
  //    唯一的合理反應是「系統壞了」。講一句就變成「未到，稍後通知」。
  var rosterPendingNote = '';
  if (rosterPending) {
    rosterPendingNote = String(getConfig(CONFIG_KEYS.BULLETIN_ROSTER_PENDING_NOTE,
      '本期事奉資料尚未確定，稍後另行通知。') || '').trim();
    if (rosterPendingNote) introText = rosterPendingNote + '\n\n' + introText;
  }
  var introHtml = introText.split('\n').map(function (line) { return escapeHtmlEmail_(line); }).join('<br>');

  var htmlBody = buildBulletinEmailHtml_(model, {
    attachment: attachment, includeMissingList: includeMissing, introHtml: introHtml, generatedAtText: generatedAtText
  });
  var plainBody = introText + '\n\n' + buildBulletinEmailPlainText_(model, {
    attachment: attachment, includeMissingList: includeMissing
  });

  var sentCount = 0;
  var failedCount = 0;
  var sendLogRows = [];

  recipientsResult.recipients.forEach(function (recipient) {
    var status;
    var errorMessage = '';

    if (dryRun) {
      status = 'DRY_RUN';
    } else {
      try {
        var message = { to: recipient.email, subject: subject, body: plainBody, htmlBody: htmlBody };
        if (attachment.ok && attachment.blob) {
          message.attachments = [attachment.blob];
        }
        MailApp.sendEmail(message);
        status = 'SENT';
        sentCount++;
      } catch (mailErr) {
        status = 'FAILED';
        errorMessage = (mailErr && mailErr.message) ? mailErr.message : String(mailErr);
        failedCount++;
      }
    }

    sendLogRows.push({
      TIMESTAMP: new Date(),
      SERVICE_DATE: normalizeDate_(isoDate),
      RECIPIENT_EMAIL: sanitizeCellText_(recipient.email),
      SUBJECT: sanitizeCellText_(subject),
      STATUS: status,
      DRY_RUN: dryRun,
      ROSTER_VERSION_USED: sanitizeCellText_(vars.RosterVersion),
      // ⚠️ R-036：事奉待定**不是錯誤**，但要留低痕跡。寫在這一欄（而不是
      //    ErrorLog）——ErrorLog 是「要人去查」的地方，這一件事不需要查。
      ERROR: sanitizeCellText_(errorMessage
        || (rosterPending ? ('（不是錯誤）' + (rosterPendingNote || '本期事奉資料尚未確定。')) : '')),
      BODY_PREVIEW: buildSendLogBodyPreview_(plainBody)
    });
  });

  writeSendLogRows_(sendLogRows);

  if (!dryRun && failedCount === 0) {
    markBulletinAsSent_(isoDate);
  }

  return {
    ok: true,
    rosterPending: rosterPending,
    dryRun: dryRun,
    totalRecipients: recipientsResult.recipients.length,
    sentCount: sentCount,
    failedCount: failedCount,
    attachment: attachment,
    recipientWarnings: recipientsResult.warnings,
    templateWarnings: templateWarnings
  };
}

/**
 * 用途：把 `BulletinWeeks` 指定主日那一行的 `STATUS` 改成 `SENT`、
 *   `SENT_AT` 寫上目前時間，並記一筆 `AuditLog`。找不到那一行就靜靜
 *   略過（回 `false`）——寄送本身已經成功，這裡失敗不應該讓整個
 *   `sendBulletinForDate_()` 回報失敗，只是狀態欄沒有更新到。
 * Args:
 *   isoDate {string} 主日日期，yyyy-MM-dd。
 * Returns:
 *   {boolean} 是否找到並更新了那一行。
 */
function markBulletinAsSent_(isoDate) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEETS.BULLETIN_WEEKS);
  if (!sheet) return false;

  var def = COLUMNS.BULLETIN_WEEKS;
  var dateCol = def.keys.indexOf('SERVICE_DATE') + 1;
  var statusCol = def.keys.indexOf('STATUS') + 1;
  var sentAtCol = def.keys.indexOf('SENT_AT') + 1;

  var lastRow = sheet.getLastRow();
  if (lastRow < 3) return false;

  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(isoDate || ''));
  if (!m) return false;
  var y = Number(m[1]);
  var mo = Number(m[2]);
  var d = Number(m[3]);

  var dates = sheet.getRange(3, dateCol, lastRow - 2, 1).getValues();
  for (var i = 0; i < dates.length; i++) {
    var cellDate = null;
    try {
      cellDate = normalizeDate_(dates[i][0]);
    } catch (parseErr) {
      cellDate = null;
    }
    if (!rosterDateMatchesYMD_(cellDate, y, mo, d)) continue;

    var rowNo = i + 3;
    var oldStatus = sheet.getRange(rowNo, statusCol).getValue();
    sheet.getRange(rowNo, statusCol).setValue(BULLETIN_WEEK_STATUS.SENT);
    sheet.getRange(rowNo, sentAtCol).setValue(new Date());

    appendAuditLog_({
      action: 'SEND_BULLETIN',
      sheetName: SHEETS.BULLETIN_WEEKS,
      rowKey: isoDate,
      field: 'STATUS',
      oldValue: String(oldStatus === null || oldStatus === undefined ? '' : oldStatus),
      newValue: BULLETIN_WEEK_STATUS.SENT,
      notes: '週報已成功寄出，全部收件人都沒有失敗。'
    });
    return true;
  }
  return false;
}

/**
 * 用途：把一批 `SendLog` 行寫入，並替它們**全部**蓋上同一個批次編號。
 *   全部寄送流程一律經這一支，不可以直接 `writeSheet(SHEETS.SEND_LOG, …)`。
 *
 *   ⚠️ 為什麼要有批次編號（docs/已知bug類型.md 事故三十九）：
 *   不變量 I04 要驗「寄出前預覽的人數 === 實際寄出的封數」，所以它要
 *   圈得出「最近**一次**寄出寫了哪幾行」。舊版靠**時間視窗**（90 秒）
 *   去圈，而連續兩次寄出（亂行機幾秒就一步、幹事連按兩次）會被併成
 *   一批——行數變成兩倍，I04 報一個假的落差。
 *
 *   ⚠️ 時間視窗是一個**猜**。同一次寫入共用一個編號才是事實。
 * Args:
 *   rows {Object[]} 已經砌好的 `SendLog` 行（不含 `BATCH_ID`）。
 * Returns:
 *   {string} 這一批的編號。沒有行要寫時回空字串。
 */
function writeSendLogRows_(rows) {
  var list = rows || [];
  if (list.length === 0) return '';

  var batchId = newSendBatchId_();
  list.forEach(function (row) { row.BATCH_ID = sanitizeCellText_(batchId); });
  writeSheet(SHEETS.SEND_LOG, list);
  return batchId;
}

/**
 * 用途：造一個這一次寄出獨有的批次編號。
 *
 *   ⚠️ 時間戳記**加一個隨機尾碼**：只用時間戳記的話，同一秒內連續兩次
 *   寄出會撞編號——那正是這個欄位要解決的問題。
 * Args: （無）
 * Returns:
 *   {string}
 */
function newSendBatchId_() {
  var timezone = getConfig(CONFIG_KEYS.SYS_TIMEZONE, 'Pacific/Auckland');
  var stamp;
  try {
    stamp = Utilities.formatDate(new Date(), timezone, 'yyyyMMddHHmmss');
  } catch (err) {
    stamp = String(new Date().getTime());
  }
  var suffix = String(new Date().getTime() % 100000);
  while (suffix.length < 5) suffix = '0' + suffix;
  return 'SB' + stamp + '-' + suffix;
}

/**
 * 用途：猜一個「試寄」「預覽」對話框預設要用的主日日期。
 *
 *   ⚠️ 定義只有一句，而且不在這裡：見 `resolveNextSendSundayIso_()`
 *   （src/SendSchedule.gs）。這一支只是把它包成「猜不到就回空字串」的
 *   形狀，方便對話框用——猜不到一個預設值不應該令整個選單項目失敗。
 *
 *   ⚠️ 舊版是「今日 ＋ SEND_TARGET_OFFSET_DAYS 天」，那條算式只在觸發日
 *   是星期一時才落在星期日。第一輪自測在星期六跑，它算出了一個**星期五**。
 *   見 docs/已知bug類型.md 事故三十。
 * Args: （無）
 * Returns:
 *   {string} 猜到的日期，yyyy-MM-dd；猜不到回空字串。
 */
function guessNextBulletinSendIso_() {
  try {
    var result = resolveNextSendSundayIso_();
    return result.ok ? result.isoDate : '';
  } catch (err) {
    return '';
  }
}

/**
 * 用途：選單項目「試寄下週週報（依 DRY_RUN 設定）」的處理函式。問一個
 *   主日日期，呼叫 `sendBulletinForDate_()`，對話框回報結果。
 * Args: （無）
 * Returns:
 *   {void}
 */
function menuTestSendBulletin_() {
  var ui = SpreadsheetApp.getUi();
  try {
    var defaultIso = guessNextBulletinSendIso_();
    var resp = ui.prompt(
      '試寄下週週報（依 DRY_RUN 設定）',
      '請輸入要寄送的主日日期，格式 yyyy-MM-dd' + (defaultIso ? '（例如 ' + defaultIso + '）' : '') + '：',
      ui.ButtonSet.OK_CANCEL
    );
    if (resp.getSelectedButton() !== ui.Button.OK) return;
    var isoDate = resp.getResponseText().trim() || defaultIso;
    if (!isoDate) {
      ui.alert('請輸入主日日期。');
      return;
    }

    var result = sendBulletinForDate_(isoDate, {});
    ui.alert(
      '試寄完成',
      [
        '主日日期：' + isoDate,
        '收件人數：' + result.totalRecipients,
        '成功：' + result.sentCount,
        '失敗：' + result.failedCount,
        '是否試行（DRY_RUN）：' + (result.dryRun ? '是（沒有真的寄出任何郵件）' : '否'),
        '附件是否可用：' + (result.attachment.ok ? '是' : '否（原因：' + attachmentReasonText_(result.attachment.reason) + '）'),
        '',
        '詳情見 SendLog 工作表。'
      ].join('\n'),
      ui.ButtonSet.OK
    );
  } catch (err) {
    logMenuError_('menuTestSendBulletin_', err);
    ui.alert('試寄失敗', enrichAuthError_(err), ui.ButtonSet.OK);
  }
}

/**
 * 用途：選單項目「預覽週報郵件內容」的處理函式。問一個主日日期，把
 *   HTML 正文用 `HtmlService.createHtmlOutput()` 在對話框顯示。
 *   **不寄任何郵件**，也不呼叫 `MailApp`。
 * Args: （無）
 * Returns:
 *   {void}
 */
function menuPreviewBulletinEmail_() {
  var ui = SpreadsheetApp.getUi();
  try {
    var defaultIso = guessNextBulletinSendIso_();
    var resp = ui.prompt(
      '預覽週報郵件內容',
      '請輸入主日日期，格式 yyyy-MM-dd' + (defaultIso ? '（例如 ' + defaultIso + '）' : '') + '：',
      ui.ButtonSet.OK_CANCEL
    );
    if (resp.getSelectedButton() !== ui.Button.OK) return;
    var isoDate = resp.getResponseText().trim() || defaultIso;
    if (!isoDate) {
      ui.alert('請輸入主日日期。');
      return;
    }

    var model = buildBulletinModel_(isoDate);
    if (model.notConfigured || !model.found) {
      ui.alert('無法預覽', '職事表尚未設定，或這個主日在職事表找不到資料。', ui.ButtonSet.OK);
      return;
    }

    var attachment = renderBulletinAttachment_(model);
    var includeMissing = normalizeBoolean_(getConfig(CONFIG_KEYS.SEND_INCLUDE_MISSING_LIST, 'TRUE')) === true;
    var timezone = getConfig(CONFIG_KEYS.SYS_TIMEZONE, 'Pacific/Auckland');
    var generatedAtText = Utilities.formatDate(new Date(), timezone, 'yyyy-MM-dd HH:mm:ss');
    var html = buildBulletinEmailHtml_(model, {
      attachment: attachment, includeMissingList: includeMissing, generatedAtText: generatedAtText
    });

    var output = HtmlService.createHtmlOutput(html).setWidth(720).setHeight(600);
    ui.showModalDialog(output, '預覽週報郵件內容（' + isoDate + '）');
  } catch (err) {
    logMenuError_('menuPreviewBulletinEmail_', err);
    ui.alert('預覽週報郵件內容失敗', enrichAuthError_(err), ui.ButtonSet.OK);
  }
}
