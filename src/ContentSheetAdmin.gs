/**
 * ContentSheetAdmin.gs
 *
 * 內容表嘅**真正入口**：建立／刷新（R-013／R-014）、寄出連結（R-015）、
 * 自動提前寄，以及對應嘅選單處理函式。
 *
 * 分層：結構同純函式喺 `src/ContentSheet.gs`，Drive／跨試算表 IO 喺
 * `src/ContentSheetIo.gs`（嗰個檔案受 lint 特別管制），本檔案負責串起嚟
 * 同讀 Config。
 *
 * ⚠️ 呢一輪**唔做匯入**（R-011／R-012 下一輪先做）。週報試算表現有嘅
 * `Announcements`／`Prayers`／`Fellowships`／`Finance`／`BulletinWeeks`
 * 一個欄都冇改。
 */

'use strict';

/**
 * 用途：一次過讀齊建立內容表要用嘅全部 Config。集中一處，方便測試同
 *   避免逐個函式各自讀（讀漏一個好難查）。
 * Args: （無）
 * Returns:
 *   {{folderId:string, namePattern:string, domain:string, owners:Object<string,string>,
 *     deadlineNote:string, seedSample:boolean, adminContact:string,
 *     inviteGroups:string[], leadDays:number}}
 */
function contentSheetConfig_() {
  var leadDays = normalizeInt_(getConfig(CONFIG_KEYS.CONTENT_SHEET_INVITE_LEAD_DAYS, '21'));
  return {
    folderId: getConfig(CONFIG_KEYS.CONTENT_SHEET_FOLDER_ID, ''),
    namePattern: getConfig(CONFIG_KEYS.CONTENT_SHEET_NAME_PATTERN, '週報內容_{{QUARTER_ID}}'),
    domain: getConfig(CONFIG_KEYS.CONTENT_SHEET_DOMAIN, ''),
    owners: parseContentSheetOwners_(getConfig(CONFIG_KEYS.CONTENT_SHEET_OWNERS, '')),
    deadlineNote: getConfig(CONFIG_KEYS.CONTENT_SHEET_DEADLINE_NOTE, ''),
    seedSample: normalizeBoolean_(getConfig(CONFIG_KEYS.CONTENT_SHEET_SEED_SAMPLE, 'TRUE')) === true,
    adminContact: getConfig(CONFIG_KEYS.CONTENT_SHEET_ADMIN_CONTACT, ''),
    inviteGroups: getConfigTextList_(CONFIG_KEYS.CONTENT_SHEET_INVITE_GROUPS, 'CC,DB,ADMIN,IT'),
    leadDays: (leadDays === null || leadDays < 0) ? 21 : leadDays
  };
}

// =====================================================================
// 版面：標題、凍結、下拉、格式
// =====================================================================

/**
 * 用途：套用一張資料分頁嘅完整版面——標題兩行、凍結、機器鍵行灰色細字、
 *   日期／有效下拉選單、純文字欄、自動換行同欄寬、A1 說明。
 *
 *   **冪等**：已經存在嘅分頁只會被重新套一次版面同刷新下拉選單，
 *   **第 3 行起嘅資料一格都唔會郁**。
 * Args:
 *   sheet {Sheet} 目標分頁。
 *   tabDef {Object} `contentSheetTabDefs_()` 其中一項。
 *   options {{dateOptions:string[], attendanceDateOptions:string[],
 *            owners:Object<string,string>, deadlineNote:string}}
 * Returns:
 *   {void}
 */
function applyContentTabLayout_(sheet, tabDef, options) {
  var keys = tabDef.keys;
  var colCount = keys.length;

  // ---- 標題兩行 ----
  sheet.getRange(1, 1, 1, colCount).setValues([tabDef.headers]);
  sheet.getRange(2, 1, 1, colCount).setValues([keys]);
  sheet.getRange(1, 1, 1, colCount).setFontWeight('bold').setBackground('#d9d9d9');
  // 機器鍵嗰行：灰色、細一號——人手唔使睇，但唔可以刪。
  sheet.getRange(2, 1, 1, colCount).setFontColor('#999999').setFontSize(8).setBackground('#f6f6f6');

  if (sheet.getFrozenRows() < CONTENT_SHEET_HEADER_ROWS_) {
    sheet.setFrozenRows(CONTENT_SHEET_HEADER_ROWS_);
  }

  // ---- A1 說明（誰負責、幾時要填好）----
  // ⚠️ 實作成 A1 嘅**儲存格註解**：第 1、2 行係標題同機器鍵（規格寫死咗），
  // 資料由第 3 行開始，所以版面上冇位放一行獨立嘅說明文字。完整說明另外
  // 印喺 `_說明` 分頁。見 docs/待確認事項.md J-3。
  sheet.getRange(1, 1).setNote(
    buildContentSheetTabNote_(tabDef, options.owners, options.deadlineNote)
  );

  var blankRows = CONTENT_SHEET_BLANK_ROWS_;

  // ---- 純文字欄（一定要喺任何資料寫入之前設好）----
  tabDef.plainTextColumns.forEach(function (key) {
    var col = keys.indexOf(key) + 1;
    if (col <= 0) return;
    sheet.getRange(CONTENT_SHEET_FIRST_DATA_ROW_, col, blankRows, 1).setNumberFormat('@');
  });

  // ---- 日期下拉選單 ----
  var dateValues = tabDef.attendanceDates ? options.attendanceDateOptions : options.dateOptions;
  tabDef.dateColumns.forEach(function (key) {
    var col = keys.indexOf(key) + 1;
    if (col <= 0) return;
    var range = sheet.getRange(CONTENT_SHEET_FIRST_DATA_ROW_, col, blankRows, 1);
    // 日期欄一律純文字：下拉選項係 `yyyy-MM-dd` 字串，唔設純文字嘅話
    // Sheets 會自動轉成 Date，之後匯入讀返出嚟就唔係字串。
    range.setNumberFormat('@');
    if (dateValues.length === 0) {
      range.clearDataValidations();
      return;
    }
    // ⚠️ setAllowInvalid(false)：**拒絕**清單以外嘅值。呢度同季度填寫表
    // 相反（嗰邊刻意用 true，下拉只係方便）——內容表嘅日期係之後匯入時
    // 對得返主日嘅唯一根據，手打錯一個字就成行匯入唔到，所以要硬擋。
    range.setDataValidation(
      SpreadsheetApp.newDataValidation().requireValueInList(dateValues, true).setAllowInvalid(false).build()
    );
  });

  // ---- 「有效」下拉 ----
  var activeCol = keys.indexOf(tabDef.activeKey) + 1;
  if (activeCol > 0) {
    sheet.getRange(CONTENT_SHEET_FIRST_DATA_ROW_, activeCol, blankRows, 1).setDataValidation(
      SpreadsheetApp.newDataValidation().requireValueInList(['TRUE', 'FALSE'], true).setAllowInvalid(false).build()
    );
  }

  // ---- 自動換行同欄寬 ----
  tabDef.wrapColumns.forEach(function (spec) {
    var col = keys.indexOf(spec.key) + 1;
    if (col <= 0) return;
    sheet.setColumnWidth(col, spec.width);
    sheet.getRange(CONTENT_SHEET_FIRST_DATA_ROW_, col, blankRows, 1).setWrap(true);
  });
}

/**
 * 用途：套用 `_說明` 分頁嘅內容（整張重寫——嗰張表冇人手資料）。
 * Args:
 *   sheet {Sheet} `_說明` 分頁。
 *   lines {string[]} `buildContentSheetInstructionLines_()` 嘅輸出。
 * Returns:
 *   {void}
 */
function applyContentInstructionsTab_(sheet, lines) {
  var lastRow = sheet.getLastRow();
  if (lastRow > 0) sheet.getRange(1, 1, lastRow, Math.max(sheet.getLastColumn(), 1)).clearContent();

  var values = lines.map(function (line) { return [sanitizeCellText_(line)]; });
  if (values.length > 0) sheet.getRange(1, 1, values.length, 1).setValues(values);

  sheet.setColumnWidth(1, 900);
  sheet.getRange(1, 1, Math.max(values.length, 1), 1).setWrap(true);
  sheet.getRange(1, 1).setFontWeight('bold').setFontSize(14);
  if (sheet.getFrozenRows() < 1) sheet.setFrozenRows(1);
}

// =====================================================================
// 建立／刷新（真正入口）
// =====================================================================

/**
 * 用途：建立或者刷新指定季度嘅內容表。**真正入口。**
 *
 *   ⚠️ **冪等**：`ContentSheets` 已經有嗰一季、而且檔案仲開得到 →
 *   **唔重建**，淨係補返缺少嘅分頁、欄位、新增嘅主日、下拉選單，然後回報
 *   「已更新，未重建」。人手輸入嘅資料（第 3 行起）一格都唔會郁。
 *
 *   重建會令堂委已經填好嘅嘢全部不見，所以「已經有就唔好再建立」係硬規則，
 *   唔係優化。
 * Args:
 *   quarterId {string} 季度 ID。
 * Returns:
 *   {{ok:boolean, created:boolean, quarterId:string, fileId:string, fileUrl:string,
 *     tabsCreated:string[], serviceDateCount:number, seededSample:boolean,
 *     sharingApplied:boolean, sharingError:string,
 *     reason:(string|undefined), message:(string|undefined)}}
 *     `ok:false` 時一定有 `reason` 同一句人睇得明嘅 `message`。
 * Raises:
 *   Error 如果職事表讀取失敗（`listQuarterServiceDates_()` 拋出嚟嘅）。
 */
function buildOrRefreshContentSheet_(quarterId) {
  var qid = String(quarterId || '').trim();
  if (!qid) {
    return { ok: false, created: false, quarterId: qid, reason: 'NO_QUARTER_ID', message: '季度 ID 不可以是空的。' };
  }

  var config = contentSheetConfig_();
  var folderCheck = checkContentSheetFolderConfigured_(config.folderId);
  if (!folderCheck.ok) {
    return { ok: false, created: false, quarterId: qid, reason: 'NO_FOLDER_ID', message: folderCheck.message };
  }

  var serviceDates = listQuarterServiceDates_(qid).map(function (d) { return d.isoDate; });
  if (serviceDates.length === 0) {
    return {
      ok: false, created: false, quarterId: qid, reason: 'NO_SERVICE_DATES',
      message: '職事表 ServiceDates 找不到季度「' + qid + '」的任何主日。請先確認季度 ID 沒有輸入錯誤。'
    };
  }

  var existing = findContentSheetRow_(qid);
  var spreadsheet = existing ? openContentSpreadsheet_(existing.FILE_ID) : null;
  var created = false;
  var sharingApplied = false;
  var sharingError = '';
  var fileId = existing ? String(existing.FILE_ID || '') : '';
  var fileUrl = existing ? String(existing.FILE_URL || '') : '';

  if (existing && !spreadsheet) {
    return {
      ok: false, created: false, quarterId: qid, reason: 'FILE_MISSING',
      message: 'ContentSheets 已登記季度「' + qid + '」的內容表（檔案 ID 開頭 '
        + maskContentFileId_(existing.FILE_ID) + '），但現在無法開啟——可能已被刪除、'
        + '移到沒有權限的位置，或者 ID 不正確。請人手確認該檔案，或將 ContentSheets '
        + '該一行的「有效」改為 FALSE，然後再按一次建立。'
    };
  }

  if (!spreadsheet) {
    var fileName = buildContentSheetFileName_(config.namePattern, qid);
    var createdFile = createContentSpreadsheet_(fileName, config.folderId, config.domain);
    spreadsheet = createdFile.spreadsheet;
    fileId = createdFile.fileId;
    fileUrl = createdFile.fileUrl;
    sharingApplied = createdFile.sharingApplied;
    sharingError = createdFile.sharingError;
    created = true;
  }

  // ---- 分頁：補齊 ＋ 套版面 ----
  var dateOptions = serviceDates.slice();
  var attendanceDateOptions = contentSheetAttendanceDateOptions_(serviceDates);
  var tabsCreated = [];

  var instructionsTab = ensureContentTab_(spreadsheet, CONTENT_SHEET_INSTRUCTIONS_TAB_);
  if (instructionsTab.created) tabsCreated.push(CONTENT_SHEET_INSTRUCTIONS_TAB_);

  var sampleRows = (created && config.seedSample) ? buildContentSheetSampleRows_(serviceDates) : {};
  var seededSample = false;

  contentSheetTabDefs_().forEach(function (tabDef) {
    var ensured = ensureContentTab_(spreadsheet, tabDef.tabName);
    if (ensured.created) tabsCreated.push(tabDef.tabName);

    applyContentTabLayout_(ensured.sheet, tabDef, {
      dateOptions: dateOptions,
      attendanceDateOptions: attendanceDateOptions,
      owners: config.owners,
      deadlineNote: config.deadlineNote
    });

    // 樣本**淨係喺新建立嗰陣**寫，而且只寫落一張全新嘅分頁——刷新現有
    // 內容表時一行都唔會加，否則每次刷新都會多幾行重複樣本。
    var rows = sampleRows[tabDef.tabName];
    if (created && rows && rows.length > 0 && ensured.sheet.getLastRow() < CONTENT_SHEET_FIRST_DATA_ROW_) {
      writeContentRows_(ensured.sheet, tabDef.keys, rows, CONTENT_SHEET_FIRST_DATA_ROW_);
      seededSample = true;
    }
  });

  applyContentInstructionsTab_(instructionsTab.sheet, buildContentSheetInstructionLines_({
    quarterId: qid,
    serviceDates: serviceDates,
    owners: config.owners,
    deadlineNote: config.deadlineNote,
    adminContact: config.adminContact,
    seededSample: seededSample
  }));

  arrangeContentTabs_(spreadsheet, contentSheetTabNames_());

  if (created) {
    appendContentSheetRow_({ quarterId: qid, fileId: fileId, fileUrl: fileUrl });
    appendAuditLog_({
      action: 'CONTENT_SHEET_CREATE',
      sheetName: SHEETS.CONTENT_SHEETS, rowKey: qid,
      field: 'FILE_ID', oldValue: '', newValue: maskContentFileId_(fileId),
      notes: '建立季度 ' + qid + ' 的內容表，共 ' + serviceDates.length + ' 個主日。'
    });
  }

  return {
    ok: true,
    created: created,
    quarterId: qid,
    fileId: fileId,
    fileUrl: fileUrl,
    tabsCreated: tabsCreated,
    serviceDateCount: serviceDates.length,
    seededSample: seededSample,
    sharingApplied: sharingApplied,
    sharingError: sharingError
  };
}

/**
 * 用途：把檔案 ID 遮罩成「開頭幾個字元 ＋ …」，供訊息同 `AuditLog` 用。
 *
 *   ⚠️ 完整檔案 ID 唔應該散落喺 `AuditLog`／錯誤訊息度——本 repo 會公開，
 *   而 `AuditLog` 有機會被貼出嚟求助。做法同 `maskFileId_()`（DocxIo.gs）
 *   一致，但唔可以直接借用嗰個（嗰個檔案專門畀 Word IO 用）。
 * Args:
 *   fileId {*} 檔案 ID。
 * Returns:
 *   {string}
 */
function maskContentFileId_(fileId) {
  var id = String(fileId || '');
  if (!id) return '（空）';
  return id.slice(0, 6) + '…（共 ' + id.length + ' 字）';
}

// =====================================================================
// 寄出內容表連結（R-015，真正入口）
// =====================================================================

/**
 * 用途：寄出指定季度嘅內容表連結。**真正入口。**
 *
 *   受 `DRY_RUN` 保護，寫 `SendLog`（`STATUS='CONTENT_SHEET_INVITE'`），
 *   成功之後更新 `ContentSheets.INVITE_SENT_AT`。
 * Args:
 *   quarterId {string} 季度 ID。
 * Returns:
 *   {{sent:boolean, dryRun:boolean, recipientCount:number,
 *     reason:(string|undefined), message:(string|undefined)}}
 */
function sendContentSheetInvite_(quarterId) {
  var qid = String(quarterId || '').trim();
  var dryRun = normalizeBoolean_(getConfig(CONFIG_KEYS.DRY_RUN, 'TRUE')) === true;

  var row = findContentSheetRow_(qid);
  if (!row) {
    return {
      sent: false, dryRun: dryRun, recipientCount: 0, reason: 'NO_CONTENT_SHEET',
      message: '季度「' + qid + '」尚未建立內容表。請先按「建立本季內容表」，然後再寄出連結。'
    };
  }

  var config = contentSheetConfig_();
  var recipientsResult = buildRecipientList_(readSheet(SHEETS.RECIPIENTS), config.inviteGroups, null);
  if (recipientsResult.recipients.length === 0) {
    return {
      sent: false, dryRun: dryRun, recipientCount: 0, reason: 'NO_RECIPIENTS',
      message: 'Recipients 找不到屬於 ' + config.inviteGroups.join('／') + ' 的有效收件人。'
    };
  }

  var serviceDates = [];
  try {
    serviceDates = listQuarterServiceDates_(qid).map(function (d) { return d.isoDate; });
  } catch (err) {
    // 主日清單只係信入面嘅參考資料，讀唔到唔應該令封信寄唔出。
    serviceDates = [];
  }

  var churchName = getConfig(CHURCH_NAME_KEY_FOR_CONTENT_SHEET_(), '');
  var htmlBody = buildContentSheetInviteHtml_({
    quarterId: qid,
    fileUrl: String(row.FILE_URL || ''),
    serviceDates: serviceDates,
    owners: config.owners,
    deadlineNote: config.deadlineNote,
    churchName: churchName
  });

  var subject = churchName + '粵語堂週報：' + qid + ' 季度內容表';
  var plainBody = htmlBody.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

  var sendLogRows = [];
  recipientsResult.recipients.forEach(function (recipient) {
    var status = 'CONTENT_SHEET_INVITE';
    var errorMessage = '';

    if (!dryRun) {
      try {
        MailApp.sendEmail({ to: recipient.email, subject: subject, body: plainBody, htmlBody: htmlBody });
      } catch (mailErr) {
        status = 'FAILED';
        errorMessage = (mailErr && mailErr.message) ? mailErr.message : String(mailErr);
      }
    }

    sendLogRows.push({
      TIMESTAMP: new Date(),
      SERVICE_DATE: '',
      RECIPIENT_EMAIL: sanitizeCellText_(recipient.email),
      SUBJECT: sanitizeCellText_(subject),
      STATUS: status,
      DRY_RUN: dryRun,
      ROSTER_VERSION_USED: sanitizeCellText_(qid),
      ERROR: sanitizeCellText_(errorMessage),
      BODY_PREVIEW: buildSendLogBodyPreview_(plainBody)
    });
  });

  writeSheet(SHEETS.SEND_LOG, sendLogRows);
  updateContentSheetField_(qid, 'INVITE_SENT_AT', new Date());

  return { sent: true, dryRun: dryRun, recipientCount: recipientsResult.recipients.length };
}

/**
 * 用途：`CHURCH_NAME` 嘅設定鍵名。包成函式純粹係為咗延遲求值——本檔案
 *   按檔名字母序排喺 `Constants.gs` **前面**，頂層引用 `CONFIG_KEYS` 會
 *   讀到 `undefined`（見 docs/已知bug類型.md 事故一）。
 * Args: （無）
 * Returns:
 *   {string}
 */
function CHURCH_NAME_KEY_FOR_CONTENT_SHEET_() {
  return CONFIG_KEYS.CHURCH_NAME;
}

// =====================================================================
// 自動提前寄
// =====================================================================

/**
 * 用途：判斷「今日距離該季第一個主日」係咪已經進入提前通知期。純函式。
 * Args:
 *   todayIso {string} 今日，yyyy-MM-dd。
 *   firstServiceDateIso {string} 該季第一個主日，yyyy-MM-dd。
 *   leadDays {number} Config `CONTENT_SHEET_INVITE_LEAD_DAYS`。
 * Returns:
 *   {boolean} 相差日數 ≤ `leadDays` 就回 true。**已經開始咗嘅季度一樣回
 *     true**（相差係負數）——嗰陣更加應該即刻寄。日期解析唔到回 false。
 */
function isWithinContentSheetLeadWindow_(todayIso, firstServiceDateIso, leadDays) {
  var today = isoDateToTime_(todayIso);
  var first = isoDateToTime_(firstServiceDateIso);
  if (today === null || first === null) return false;
  var diffDays = Math.round((first - today) / (24 * 60 * 60 * 1000));
  return diffDays <= Number(leadDays || 0);
}

/**
 * 用途：每週寄送流程順手做嘅事——揾出「職事表已經有、`BulletinWeeks`
 *   已經建咗骨架、但仲未寄過內容表邀請」而且已經進入提前通知期嘅季度，
 *   自動建立內容表並寄出邀請。
 *
 *   ⚠️ **同一季只寄一次**：沿用第六輪嘅 `ConflictNoticeLog` 指紋機制
 *   （`CONTENT_SHEET_INVITE|<季度>`），同 `autoCreateNextQuarterFillGrids_()`
 *   完全同一套做法，唔另外開一張表。
 *   ⚠️ 受 `DRY_RUN` 保護；而且**只有真係寄出（非 DRY_RUN）先至記指紋**
 *   ——指紋係狀態，試行唔可以消耗佢（理由同 src/ConflictNotice.gs）。
 * Args: （無）
 * Returns:
 *   {{created:string[], invited:string[], skipped:string[]}}
 */
function autoCreateContentSheetsForUpcomingQuarters_() {
  var result = { created: [], invited: [], skipped: [] };
  var config = contentSheetConfig_();

  // 未設定資料夾就乜都唔好做——自動流程唔應該喺背景不停拋錯。
  if (!checkContentSheetFolderConfigured_(config.folderId).ok) return result;

  var timezone = getConfig(CONFIG_KEYS.SYS_TIMEZONE, 'Pacific/Auckland');
  var todayIso = Utilities.formatDate(new Date(), timezone, 'yyyy-MM-dd');

  var notified = {};
  readNotifiedFingerprints_().forEach(function (fp) { notified[fp] = true; });

  // 只睇 `BulletinWeeks` 已經有資料嘅季度——同
  // `findQuartersWithoutFillGrid_()` 同一個道理：職事表可能有好多季，
  // 但只有已經「建立本季空白週報」嗰啲先至輪到內容表。
  var quarterIds = {};
  readSheet(SHEETS.BULLETIN_WEEKS).forEach(function (r) {
    var qid = String(r.QUARTER_ID || '').trim();
    if (qid) quarterIds[qid] = true;
  });

  Object.keys(quarterIds).sort().forEach(function (qid) {
    var fingerprint = 'CONTENT_SHEET_INVITE|' + qid;
    if (notified[fingerprint]) { result.skipped.push(qid); return; }

    var serviceDates;
    try {
      serviceDates = listQuarterServiceDates_(qid).map(function (d) { return d.isoDate; });
    } catch (err) {
      result.skipped.push(qid);
      return;
    }
    if (serviceDates.length === 0) { result.skipped.push(qid); return; }
    if (!isWithinContentSheetLeadWindow_(todayIso, serviceDates[0], config.leadDays)) {
      result.skipped.push(qid);
      return;
    }

    var built = buildOrRefreshContentSheet_(qid);
    if (!built.ok) { result.skipped.push(qid); return; }
    if (built.created) result.created.push(qid);

    var invite = sendContentSheetInvite_(qid);
    if (!invite.sent) { result.skipped.push(qid); return; }
    result.invited.push(qid);

    if (!invite.dryRun) recordContentSheetInviteFingerprint_(qid, fingerprint);
  });

  return result;
}

/**
 * 用途：把「已經寄過某一季嘅內容表邀請」記入 `ConflictNoticeLog`。
 *
 *   ⚠️ 刻意重用第六輪嘅 `ConflictNoticeLog` 而唔另開一張表：兩者要解決嘅
 *   係**同一個問題**（同一件事唔可以重複轟炸收件人），機制亦一樣。
 *   用 `POST_ID` 欄放 `CONTENT_SHEET_INVITE` 呢個標記去分辨。
 * Args:
 *   quarterId {string} 季度 ID。
 *   fingerprint {string} 指紋。
 * Returns:
 *   {void}
 */
function recordContentSheetInviteFingerprint_(quarterId, fingerprint) {
  writeSheet(SHEETS.CONFLICT_NOTICE_LOG, [{
    TIMESTAMP: new Date(),
    SERVICE_DATE: '',
    POST_ID: 'CONTENT_SHEET_INVITE',
    SLOT_INDEX: '',
    FINGERPRINT: sanitizeCellText_(fingerprint),
    ROSTER_VALUE: sanitizeCellText_(quarterId),
    NOTES: '已寄出季度內容表邀請；同一季不會再寄第二次。'
  }]);
}

// =====================================================================
// 選單處理函式
// =====================================================================

/**
 * 用途：選單項目「建立本季內容表」嘅處理函式。
 * Args: （無）
 * Returns:
 *   {void}
 */
function menuCreateContentSheet_() {
  var ui = SpreadsheetApp.getUi();
  try {
    var quarterResolution = resolveWorkingQuarter_();
    var defaultQuarterId = quarterResolution.ok ? quarterResolution.quarterId : '';
    var resp = ui.prompt(
      '建立本季內容表',
      '請輸入季度 ID' + (defaultQuarterId ? '（例如 ' + defaultQuarterId + '）' : '（例如 2027T4）') + '：',
      ui.ButtonSet.OK_CANCEL
    );
    if (resp.getSelectedButton() !== ui.Button.OK) return;

    var quarterId = resp.getResponseText().trim() || defaultQuarterId;
    if (!quarterId) {
      ui.alert('請輸入季度 ID。');
      return;
    }

    var result = buildOrRefreshContentSheet_(quarterId);
    if (!result.ok) {
      ui.alert('未能建立內容表', result.message, ui.ButtonSet.OK);
      return;
    }

    ui.alert(
      result.created ? '已建立內容表' : '已更新，未重建',
      buildContentSheetResultLines_(result).join('\n'),
      ui.ButtonSet.OK
    );
  } catch (err) {
    logMenuError_('menuCreateContentSheet_', err);
    ui.alert('建立內容表失敗', enrichAuthError_(err), ui.ButtonSet.OK);
  }
}

/**
 * 用途：組出「建立本季內容表」對話框嘅內容行。抽成純函式方便測試。
 * Args:
 *   result {Object} `buildOrRefreshContentSheet_()` 嘅回傳值（`ok:true`）。
 * Returns:
 *   {string[]}
 */
function buildContentSheetResultLines_(result) {
  var lines = ['季度：' + result.quarterId];

  if (result.created) {
    lines.push('本季主日：' + result.serviceDateCount + ' 個');
    lines.push('已建立分頁：' + result.tabsCreated.join('、'));
    if (result.seededSample) {
      lines.push('已預填樣本（首個主日）——確認格式之後請自行修改，或把「有效」改為 FALSE。');
    }
    if (result.sharingApplied) {
      lines.push('分享權限：網域內任何人可編輯。');
    } else if (result.sharingError) {
      lines.push('⚠️ 分享權限設定失敗：' + result.sharingError + '　請人手設定。');
    } else {
      lines.push('⚠️ 未設定 ' + CONFIG_KEYS.CONTENT_SHEET_DOMAIN
        + '，因此沒有自動設定分享權限——請人手將檔案分享給教會網域內的同工（可編輯）。');
    }
  } else {
    lines.push('**已更新，未重建**——既有的內容表不會重做，人手輸入的資料一格都沒有改動。');
    lines.push('已刷新：欄位、下拉選單（本季 ' + result.serviceDateCount + ' 個主日）、版面。');
    if (result.tabsCreated.length > 0) {
      lines.push('已補回缺少的分頁：' + result.tabsCreated.join('、'));
    }
  }

  lines.push('');
  lines.push('連結：' + result.fileUrl);
  return lines;
}

/**
 * 用途：選單項目「從內容表匯入」的處理函式。先顯示差異，確認之後才寫入。
 *
 *   ⚠️ 與 Web App 那個「重新匯入」按鈕呼叫**同一組函式**
 *   （`previewContentImport_()` ／ `applyContentImport_()`），不可以各寫
 *   一套——兩套差異計算遲早會不一致，而不一致的那一刻沒有人會發現。
 * Args: （無）
 * Returns:
 *   {void}
 */
function menuImportFromContentSheet_() {
  var ui = SpreadsheetApp.getUi();
  try {
    var quarterResolution = resolveWorkingQuarter_();
    var defaultQuarterId = quarterResolution.ok ? quarterResolution.quarterId : '';
    var resp = ui.prompt(
      '從內容表匯入',
      '請輸入季度 ID' + (defaultQuarterId ? '（例如 ' + defaultQuarterId + '）' : '（例如 2027T4）') + '：',
      ui.ButtonSet.OK_CANCEL
    );
    if (resp.getSelectedButton() !== ui.Button.OK) return;

    var quarterId = resp.getResponseText().trim() || defaultQuarterId;
    if (!quarterId) {
      ui.alert('請輸入季度 ID。');
      return;
    }

    var preview = previewContentImport_(quarterId, {});
    if (!preview.ok) {
      ui.alert('未能匯入', preview.message, ui.ButtonSet.OK);
      return;
    }

    // 完整明細一律寫入 Diagnostics，對話框只放前 20 行。
    writeDiagnosticsReport_('內容表匯入預覽', buildContentImportReportLines_(preview));

    var dryRun = normalizeBoolean_(getConfig(CONFIG_KEYS.DRY_RUN, 'TRUE')) === true;
    var previewLines = buildContentImportDialogLines_(preview, { dryRun: dryRun, applied: false });
    previewLines.push('');
    previewLines.push('確定要寫入嗎？');

    var confirmed = ui.alert('內容表匯入預覽', previewLines.join('\n'), ui.ButtonSet.YES_NO);
    if (confirmed !== ui.Button.YES) {
      ui.alert('已取消', '沒有寫入任何資料。差異明細已寫入 Diagnostics 工作表，可以慢慢核對。', ui.ButtonSet.OK);
      return;
    }

    var applied = applyContentImport_(quarterId, {});
    ui.alert('匯入完成', buildContentImportDialogLines_(applied, { dryRun: dryRun, applied: true }).join('\n'), ui.ButtonSet.OK);
  } catch (err) {
    logMenuError_('menuImportFromContentSheet_', err);
    ui.alert('從內容表匯入失敗', enrichAuthError_(err), ui.ButtonSet.OK);
  }
}

/**
 * 用途：選單項目「寄出內容表連結」嘅處理函式。
 * Args: （無）
 * Returns:
 *   {void}
 */
function menuSendContentSheetInvite_() {
  var ui = SpreadsheetApp.getUi();
  try {
    var quarterResolution = resolveWorkingQuarter_();
    var defaultQuarterId = quarterResolution.ok ? quarterResolution.quarterId : '';
    var resp = ui.prompt(
      '寄出內容表連結',
      '請輸入季度 ID' + (defaultQuarterId ? '（例如 ' + defaultQuarterId + '）' : '（例如 2027T4）') + '：',
      ui.ButtonSet.OK_CANCEL
    );
    if (resp.getSelectedButton() !== ui.Button.OK) return;

    var quarterId = resp.getResponseText().trim() || defaultQuarterId;
    if (!quarterId) {
      ui.alert('請輸入季度 ID。');
      return;
    }

    var result = sendContentSheetInvite_(quarterId);
    if (!result.sent) {
      ui.alert('未有寄出', result.message, ui.ButtonSet.OK);
      return;
    }

    ui.alert(
      '內容表連結',
      [
        '季度：' + quarterId,
        '收件人數：' + result.recipientCount,
        '是否試行（DRY_RUN）：' + (result.dryRun ? '是（並未實際寄出任何郵件）' : '否'),
        '',
        '詳情見 SendLog 工作表。'
      ].join('\n'),
      ui.ButtonSet.OK
    );
  } catch (err) {
    logMenuError_('menuSendContentSheetInvite_', err);
    ui.alert('寄出內容表連結失敗', enrichAuthError_(err), ui.ButtonSet.OK);
  }
}
