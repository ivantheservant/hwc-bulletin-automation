/**
 * FillAdmin.gs
 *
 * 季度填寫表的**管理動作**：建立／刷新格子表、工作表保護、填寫邀請、
 * 未建立季度的檢查，以及全部相關的選單處理函式與觸發器安裝。
 *
 * 純邏輯在 `src/FillGrid.gs`（版面與欄位）、`src/FillSync.gs`（三方比對）、
 * `src/FillBackup.gs`（備份還原）、`src/FellowshipSchedule.gs`（常設團契）；
 * 本檔案只負責把它們串起來，以及對使用者的呈現。
 */

'use strict';

// =====================================================================
// 建立／刷新季度填寫表
// =====================================================================

/**
 * 用途：建立或刷新季度填寫表。**冪等**。
 *
 *   流程：
 *     1. **先備份**（原因 `BEFORE_CREATE_GRID`）——刷新會動到格子表，
 *        萬一同步判斷有問題要有得還原。
 *     2. 確保工作表存在、標題／凍結／純文字格式正確。
 *     3. 已經存在的表：跑一次三方同步（見 `src/FillSync.gs`），
 *        衝突的格**一格都不會被寫入**。
 *     4. 把（同步後的）內容寫進格子表，套用資料驗證與條件格式。
 *     5. 寫入 `FillSnapshot` 作為下一次比對的基準。
 * Args:
 *   quarterId {string} 季度 ID，例如 `'2027T4'`。
 * Returns:
 *   {{ok:boolean, created:boolean, rowCount:number, sheetName:string,
 *     sync:(Object|undefined), backupId:string, message:(string|undefined)}}
 * Raises:
 *   Error 如果職事表讀取失敗，或該季在職事表內沒有任何主日。
 */
function createOrRefreshFillGrid_(quarterId) {
  var qid = String(quarterId || '').trim();
  if (!qid) {
    return { ok: false, created: false, rowCount: 0, sheetName: '', backupId: '', message: '季度 ID 不可以是空的。' };
  }

  var serviceDates = listQuarterServiceDates_(qid);
  if (serviceDates.length === 0) {
    return {
      ok: false, created: false, rowCount: 0, sheetName: fillGridSheetName_(qid), backupId: '',
      message: '職事表找不到季度「' + qid + '」的任何主日。請確認季度 ID 是否正確（例如 2027T4），'
        + '以及職事表那一季是否已經生成。'
    };
  }

  var backup = createFillBackup_(qid, FILL_BACKUP_REASON.BEFORE_CREATE_GRID);

  var ensured = ensureFillGridSheet_(qid);

  // 已經存在的表要先同步，否則下一步的寫入會把幹事在格子表的改動蓋掉。
  var sync = null;
  if (!ensured.created) {
    sync = syncFillGrid_(qid);
  }

  var rows = buildFillGridRows_({
    serviceDates: serviceDates,
    weekRowsByIso: readBulletinWeekRowsByIso_(qid)
  });

  // ⚠️ 衝突格要保留格子表現值，不可以被 BulletinWeeks 的值蓋掉——
  // 「衝突時不自動蓋任何一邊」這條規則在這裡同樣要守。
  if (sync && sync.conflictCount > 0) {
    var gridByIso = {};
    readFillGridRows_(qid).forEach(function (r) { gridByIso[r.isoDate] = r.values; });
    sync.cells.forEach(function (cell) {
      if (cell.status !== FILL_SYNC_STATUS.CONFLICT) return;
      var target = rows.filter(function (r) { return r.isoDate === cell.isoDate; })[0];
      if (target) target.values[cell.fieldKey] = cell.gridValue;
    });
  }

  writeFillGridRows_(ensured.sheet, rows);
  applyFillGridValidation_(ensured.sheet, rows.length);
  applyFillGridConditionalFormat_(ensured.sheet, rows.length);

  // 衝突格的快照維持原樣（見 syncFillGrid_() 的說明），其餘更新成現值。
  var conflictKeys = {};
  if (sync) {
    sync.cells.forEach(function (cell) {
      if (cell.status === FILL_SYNC_STATUS.CONFLICT) conflictKeys[fillSnapshotKey_(cell.isoDate, cell.fieldKey)] = true;
    });
  }
  var snapshotRows = rows.map(function (r) {
    var values = {};
    Object.keys(r.values).forEach(function (k) {
      if (conflictKeys[fillSnapshotKey_(r.isoDate, k)]) return;
      values[k] = r.values[k];
    });
    return { isoDate: r.isoDate, values: values };
  });
  snapshotFillGrid_(qid, snapshotRows);

  appendAuditLog_({
    action: ensured.created ? 'FILL_GRID_CREATE' : 'FILL_GRID_REFRESH',
    sheetName: fillGridSheetName_(qid), rowKey: qid,
    field: 'ROW_COUNT', oldValue: '', newValue: String(rows.length),
    notes: (ensured.created ? '建立' : '刷新') + '季度填寫表，共 ' + rows.length + ' 個主日。'
  });

  return {
    ok: true, created: ensured.created, rowCount: rows.length,
    sheetName: fillGridSheetName_(qid), sync: sync, backupId: backup.backupId
  };
}

/**
 * 用途：列出全部已經建立的季度填寫表。
 * Args: （無）
 * Returns:
 *   {string[]} 季度 ID 陣列，依名稱排序。
 */
function listExistingFillGridQuarters_() {
  return SpreadsheetApp.getActiveSpreadsheet().getSheets()
    .map(function (s) { return quarterIdFromFillGridSheetName_(s.getName()); })
    .filter(function (q) { return q !== null; })
    .sort();
}

/**
 * 用途：對全部已經存在的季度填寫表跑一次三方對帳。定時觸發器用。
 * Args: （無）
 * Returns:
 *   {{quarters:Object[], totalConflicts:number}}
 */
function reconcileAllFillGrids_() {
  var quarters = listExistingFillGridQuarters_().map(function (qid) {
    try {
      return syncFillGrid_(qid);
    } catch (err) {
      appendErrorLog_({
        source: ERROR_LOG_SOURCE.TRIGGER,
        functionName: 'reconcileAllFillGrids_',
        errorCode: (err && err.code) || 'ERROR',
        message: (err && err.message) ? err.message : String(err),
        detail: buildErrorDetail_(err, { argsSummary: 'quarterId=' + qid })
      });
      return { quarterId: qid, pushCount: 0, pullCount: 0, conflictCount: 0, sameCount: 0, cells: [] };
    }
  });

  var totalConflicts = quarters.reduce(function (sum, q) { return sum + q.conflictCount; }, 0);
  return { quarters: quarters, totalConflicts: totalConflicts };
}

// =====================================================================
// 未建立的季度：自動偵測與自動建立
// =====================================================================

/**
 * 用途：找出職事表已經有、但還未建立填寫表的季度。
 *
 *   ⚠️ 只看 `BulletinWeeks` 已經有資料的季度——職事表可能有很多季，
 *   但只有已經「建立本季空白週報」的那些才輪到填寫表。
 * Args: （無）
 * Returns:
 *   {string[]} 季度 ID，依名稱排序。
 */
function findQuartersWithoutFillGrid_() {
  var existing = {};
  listExistingFillGridQuarters_().forEach(function (q) { existing[q] = true; });

  var known = {};
  readSheet(SHEETS.BULLETIN_WEEKS).forEach(function (row) {
    var qid = String(row.QUARTER_ID || '').trim();
    if (qid && !existing[qid]) known[qid] = true;
  });

  return Object.keys(known).sort();
}

/**
 * 用途：每週寄送流程順手做的事——發現有未建立填寫表的季度，就自動建立
 *   並寄出填寫邀請。
 *
 *   ⚠️ **同一季只寄一次**：用 `ConflictNoticeLog` 記一個另一種形狀的
 *   指紋（`FILL_INVITE|<季度>`），重用第六輪的防重複機制，不另外開一張表。
 *   ⚠️ 受 Config `FILL_AUTO_CREATE_NEXT_QUARTER` 與 `DRY_RUN` 保護。
 * Args: （無）
 * Returns:
 *   {{created:string[], invited:string[], skipped:string[]}}
 */
function autoCreateNextQuarterFillGrids_() {
  var result = { created: [], invited: [], skipped: [] };

  if (normalizeBoolean_(getConfig(CONFIG_KEYS.FILL_AUTO_CREATE_NEXT_QUARTER, 'TRUE')) !== true) {
    return result;
  }

  var notified = {};
  readNotifiedFingerprints_().forEach(function (fp) { notified[fp] = true; });

  findQuartersWithoutFillGrid_().forEach(function (qid) {
    var fingerprint = 'FILL_INVITE|' + qid;
    if (notified[fingerprint]) { result.skipped.push(qid); return; }

    var created = createOrRefreshFillGrid_(qid);
    if (!created.ok) { result.skipped.push(qid); return; }
    result.created.push(qid);

    var invite = sendFillInvite_(qid);
    if (invite.sent) {
      result.invited.push(qid);
      // 只有真的寄出（非 DRY_RUN）才記指紋——理由跟
      // src/ConflictNotice.gs 一樣：指紋是**狀態**，試行不可以消耗它。
      if (!invite.dryRun) recordFillInviteFingerprint_(qid, fingerprint);
    }
  });

  return result;
}

/**
 * 用途：把「已經寄過某一季的填寫邀請」記進 `ConflictNoticeLog`。
 *
 *   ⚠️ 刻意重用第六輪的 `ConflictNoticeLog` 而不是另開一張表：兩者要解決
 *   的是**同一個問題**（同一件事不可以重複轟炸收件人），機制也一樣。
 *   用 `POST_ID` 欄放 `FILL_INVITE` 這個標記來分辨兩種指紋。
 * Args:
 *   quarterId {string} 季度 ID。
 *   fingerprint {string} 指紋。
 * Returns:
 *   {void}
 */
function recordFillInviteFingerprint_(quarterId, fingerprint) {
  writeSheet(SHEETS.CONFLICT_NOTICE_LOG, [{
    TIMESTAMP: new Date(),
    SERVICE_DATE: '',
    POST_ID: 'FILL_INVITE',
    SLOT_INDEX: '',
    FINGERPRINT: sanitizeCellText_(fingerprint),
    ROSTER_VALUE: sanitizeCellText_(quarterId),
    NOTES: '已寄出季度填寫邀請；同一季不會再寄第二次。'
  }]);
}

// =====================================================================
// 填寫邀請
// =====================================================================

/**
 * 用途：算出某一季每個欄位群組還欠幾多格。純函式。
 * Args:
 *   gridRows {{isoDate:string, values:Object}[]} 格子表內容。
 * Returns:
 *   {{group:string, filled:number, total:number, missing:number}[]}
 *     依欄位定義的群組次序。
 */
function buildFillProgressByGroup_(gridRows) {
  var defs = fillGridColumnDefs_().filter(function (d) { return !d.readOnly; });
  var order = [];
  var stats = {};

  defs.forEach(function (def) {
    if (!stats[def.group]) { stats[def.group] = { group: def.group, filled: 0, total: 0 }; order.push(def.group); }
  });

  (gridRows || []).forEach(function (row) {
    defs.forEach(function (def) {
      stats[def.group].total++;
      if (String(row.values[def.key] || '').trim() !== '') stats[def.group].filled++;
    });
  });

  return order.map(function (g) {
    return { group: g, filled: stats[g].filled, total: stats[g].total, missing: stats[g].total - stats[g].filled };
  });
}

/**
 * 用途：組出直達某一張工作表的連結（試算表網址 ＋ `#gid=`）。
 * Args:
 *   sheetName {string} 工作表名稱。
 * Returns:
 *   {string} 找不到那張表時回試算表本身的網址。
 */
function buildSheetDeepLink_(sheetName) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var base = ss.getUrl();
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) return base;
  return base + '#gid=' + sheet.getSheetId();
}

/**
 * 用途：組出季度填寫邀請的 HTML 正文。純函式。
 * Args:
 *   input {{quarterId:string, serviceDates:string[], progress:Object[],
 *          links:{grid:string, announcements:string, prayers:string,
 *                 finance:string, webApp:string}, responsibilityNote:string,
 *          churchName:string}}
 * Returns:
 *   {string}
 */
function buildFillInviteHtml_(input) {
  var esc = escapeHtmlEmail_;
  var links = input.links || {};
  var parts = [];

  parts.push('<h2 style="margin:0 0 0.6em;">' + esc(input.quarterId) + ' 季度週報填寫邀請</h2>');
  parts.push('<p>各位主內肢體，平安！</p>');
  parts.push('<p>' + esc(input.churchName || '') + '粵語堂 ' + esc(input.quarterId)
    + ' 季度的週報填寫表已經準備好，敬請協助填寫。</p>');

  if (input.responsibilityNote) {
    parts.push('<p style="background:#e8f0fe;padding:0.6em 1em;border-radius:4px;">'
      + esc(input.responsibilityNote) + '</p>');
  }

  parts.push('<h3 style="margin:1.2em 0 0.4em;">本季主日（共 ' + (input.serviceDates || []).length + ' 個）</h3>');
  parts.push('<p>' + (input.serviceDates || []).map(esc).join('、') + '</p>');

  parts.push('<h3 style="margin:1.2em 0 0.4em;">目前待填統計</h3>');
  parts.push('<table style="border-collapse:collapse;">'
    + '<thead><tr>'
    + '<th style="border:1px solid #ccc;padding:4px 10px;text-align:left;">欄位群組</th>'
    + '<th style="border:1px solid #ccc;padding:4px 10px;text-align:left;">已填</th>'
    + '<th style="border:1px solid #ccc;padding:4px 10px;text-align:left;">待填</th>'
    + '</tr></thead><tbody>'
    + (input.progress || []).map(function (p) {
      return '<tr>'
        + '<td style="border:1px solid #ccc;padding:4px 10px;">' + esc(p.group) + '</td>'
        + '<td style="border:1px solid #ccc;padding:4px 10px;">' + p.filled + ' / ' + p.total + '</td>'
        + '<td style="border:1px solid #ccc;padding:4px 10px;'
        + (p.missing > 0 ? 'color:#8c231c;font-weight:bold;' : '') + '">' + p.missing + '</td>'
        + '</tr>';
    }).join('')
    + '</tbody></table>');

  parts.push('<h3 style="margin:1.2em 0 0.4em;">直達連結</h3>');
  parts.push('<ul>');
  parts.push('<li><a href="' + esc(links.grid) + '">' + esc(input.quarterId) + ' 季度填寫表</a>（一張表看晒整季）</li>');
  parts.push('<li><a href="' + esc(links.announcements) + '">家事報告</a></li>');
  parts.push('<li><a href="' + esc(links.prayers) + '">代禱事項</a></li>');
  parts.push('<li><a href="' + esc(links.finance) + '">月度財政報告</a></li>');
  if (links.webApp) {
    parts.push('<li><a href="' + esc(links.webApp) + '">逐週填寫介面</a></li>');
  }
  parts.push('</ul>');

  parts.push('<p style="color:#666;font-size:13px;">'
    + '填寫表內灰色的三欄（主日日期、當月第幾主日、特別主日）來自職事表，不可以編輯；'
    + '改動會自動還原。其餘欄位直接打字即可，系統會自動同步。</p>');

  return parts.join('\n');
}

/**
 * 用途：寄出季度填寫邀請。真正入口。
 *
 *   受 `DRY_RUN` 保護，寫 `SendLog`（`STATUS='FILL_INVITE'`）。
 * Args:
 *   quarterId {string} 季度 ID。
 * Returns:
 *   {{sent:boolean, dryRun:boolean, recipientCount:number,
 *     reason:(string|undefined), message:(string|undefined)}}
 */
function sendFillInvite_(quarterId) {
  var dryRun = normalizeBoolean_(getConfig(CONFIG_KEYS.DRY_RUN, 'TRUE')) === true;

  var gridRows = readFillGridRows_(quarterId);
  if (gridRows.length === 0) {
    return { sent: false, dryRun: dryRun, recipientCount: 0, reason: 'NO_FILL_GRID',
      message: '季度填寫表「' + fillGridSheetName_(quarterId) + '」還未建立或沒有資料。請先撳「建立／刷新季度填寫表」。' };
  }

  var allowedGroups = getConfigTextList_(CONFIG_KEYS.FILL_INVITE_GROUPS, 'ADMIN,CC,DB,IT,WORSHIP');
  var recipientsResult = buildRecipientList_(readSheet(SHEETS.RECIPIENTS), allowedGroups, null);
  if (recipientsResult.recipients.length === 0) {
    return { sent: false, dryRun: dryRun, recipientCount: 0, reason: 'NO_RECIPIENTS',
      message: 'Recipients 內找不到屬於 ' + allowedGroups.join('／') + ' 的有效收件人。' };
  }

  var churchName = getConfig(CONFIG_KEYS.CHURCH_NAME, '');
  var htmlBody = buildFillInviteHtml_({
    quarterId: quarterId,
    serviceDates: gridRows.map(function (r) { return r.isoDate; }),
    progress: buildFillProgressByGroup_(gridRows),
    links: {
      grid: buildSheetDeepLink_(fillGridSheetName_(quarterId)),
      announcements: buildSheetDeepLink_(SHEETS.ANNOUNCEMENTS),
      prayers: buildSheetDeepLink_(SHEETS.PRAYERS),
      finance: buildSheetDeepLink_(SHEETS.FINANCE),
      webApp: getConfig(CONFIG_KEYS.WEBAPP_URL, '')
    },
    responsibilityNote: getConfig(CONFIG_KEYS.FILL_RESPONSIBILITY_NOTE, ''),
    churchName: churchName
  });

  var subject = churchName + '粵語堂週報：' + quarterId + ' 季度填寫邀請';
  var plainBody = htmlBody.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

  var sendLogRows = [];
  recipientsResult.recipients.forEach(function (recipient) {
    var status = 'FILL_INVITE';
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
      ROSTER_VERSION_USED: sanitizeCellText_(quarterId),
      ERROR: sanitizeCellText_(errorMessage),
      BODY_PREVIEW: buildSendLogBodyPreview_(plainBody)
    });
  });

  writeSheet(SHEETS.SEND_LOG, sendLogRows);

  return { sent: true, dryRun: dryRun, recipientCount: recipientsResult.recipients.length };
}

// =====================================================================
// 工作表保護
// =====================================================================

/**
 * 用途：只有擁有者（與 Config `PROTECTION_EDITOR_EMAILS` 列出的人）可以
 *   編輯的工作表清單。
 *
 *   ⚠️ 沒有列在這裡的表（`Fill_*`、四張清單表、`FellowshipDefaults`、
 *   `HonorificLookup`、`PersonDisplay`、`Recipients`）**維持可編輯**——
 *   那些正正是要交給幹事、領詩、堂委填的。
 * Args: （無）
 * Returns:
 *   {string[]} 工作表名稱。
 */
function protectedSheetNames_() {
  return [
    SHEETS.README, SHEETS.CONFIG, SHEETS.DIAGNOSTICS, SHEETS.AUDIT_LOG,
    SHEETS.SEND_LOG, SHEETS.ERROR_LOG, SHEETS.POST_DISPLAY, SHEETS.MERGE_GROUPS,
    SHEETS.PROGRAM_TEMPLATES, SHEETS.EMAIL_TEMPLATES, SHEETS.BULLETIN_WEEKS,
    SHEETS.FILL_SNAPSHOT, SHEETS.FILL_BACKUP, SHEETS.CONFLICT_NOTICE_LOG,
    SHEETS.DUTY_OVERRIDE,
    // ContentSheets 只記「每季內容表指向哪一個檔案」，全部由系統寫；
    // 人手改一個檔案 ID 只會令匯入指去錯的檔案，所以一律受保護。
    SHEETS.CONTENT_SHEETS,
    // PublishLog 是發佈紀錄（版本號、是否強制發佈、存檔檔案 ID），
    // 全部由系統寫；人手改一行只會令版本號與實際發佈對不上。
    SHEETS.PUBLISH_LOG,
    // 自測機那四張：全部由系統寫。⚠️ NumberRegistry 受保護是因為它是
    // 不變量 I03 的宣告——人手改一行「重新數的條件」，改到的只是給人看
    // 的說明文字，程式讀的是 numberRegistryProbes_()，兩邊就會不一致而
    // 沒有人發現。要加新登記請改程式碼，再撳「初始化工作表」。
    SHEETS.NUMBER_REGISTRY,
    SHEETS.SELF_TEST_STATE,
    SHEETS.SELF_TEST_REPORT,
    SHEETS.MONKEY_LOG
  ];
}

/**
 * 用途：把 `protectedSheetNames_()` 列出的工作表設成受保護。
 *
 *   ⚠️ `BulletinWeeks` 受保護**不會**影響填寫介面與格子表同步——那些寫入
 *   是由**指令碼**執行的，指令碼一律以擁有者身分執行，不受保護限制。
 *   保護擋住的只是「人手直接在那張表打字」。
 * Args: （無）
 * Returns:
 *   {{protectedCount:number, skipped:string[], editors:string[]}}
 */
function applySheetProtection_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var editors = getConfigTextList_(CONFIG_KEYS.PROTECTION_EDITOR_EMAILS, '')
    .filter(function (e) { return e.indexOf('@') !== -1; });

  var protectedCount = 0;
  var skipped = [];

  protectedSheetNames_().forEach(function (name) {
    var sheet = ss.getSheetByName(name);
    if (!sheet) { skipped.push(name); return; }

    // 先移走本系統之前設過的保護，避免重複疊加。
    sheet.getProtections(SpreadsheetApp.ProtectionType.SHEET).forEach(function (p) {
      if (p.canEdit()) p.remove();
    });

    var protection = sheet.protect().setDescription('週報系統：系統維護用工作表，請勿人手編輯');
    protection.removeEditors(protection.getEditors());
    if (editors.length > 0) protection.addEditors(editors);
    protectedCount++;
  });

  appendAuditLog_({
    action: 'APPLY_SHEET_PROTECTION', sheetName: '',
    rowKey: '', field: 'PROTECTED_COUNT', oldValue: '', newValue: String(protectedCount),
    notes: '設定工作表保護，例外編輯者 ' + editors.length + ' 人。'
  });

  return { protectedCount: protectedCount, skipped: skipped, editors: editors };
}

// =====================================================================
// 觸發器
// =====================================================================

/** 填寫表同步觸發器指向的函式名稱。 */
var FILL_EDIT_TRIGGER_HANDLER_ = 'onFillGridEdit_';

/** 填寫表定時對帳觸發器指向的函式名稱。 */
var FILL_RECONCILE_TRIGGER_HANDLER_ = 'fillReconcileTrigger_';

/**
 * 用途：定時對帳觸發器的處理函式。有衝突就寫 `Diagnostics` 並寄提醒。
 *
 *   整個函式包 try/catch 並寫 `ErrorLog`——觸發器拋錯是靜默的。
 * Args: （無）
 * Returns:
 *   {void}
 */
function fillReconcileTrigger_() {
  try {
    var result = reconcileAllFillGrids_();

    var lines = ['【定時對帳結果】'];
    result.quarters.forEach(function (q) {
      lines.push('　' + q.quarterId + '：寫回 ' + q.pushCount + ' 格、刷新 ' + q.pullCount
        + ' 格、衝突 ' + q.conflictCount + ' 格');
    });
    result.quarters.forEach(function (q) {
      if (q.conflictCount === 0) return;
      lines.push('');
      buildFillSyncReportLines_(q).forEach(function (l) { lines.push(l); });
    });
    writeDiagnosticsReport_('填寫表定時對帳', lines);

    if (result.totalConflicts > 0) sendFillConflictNotice_(result);
  } catch (err) {
    appendErrorLog_({
      source: ERROR_LOG_SOURCE.TRIGGER,
      functionName: 'fillReconcileTrigger_',
      errorCode: (err && err.code) || 'ERROR',
      message: (err && err.message) ? err.message : String(err),
      detail: buildErrorDetail_(err)
    });
  }
}

/**
 * 用途：寄一封「填寫表有衝突」的提醒信。
 *
 *   ⚠️ 重用第六輪的指紋機制（`ConflictNoticeLog`）防重複——同一個
 *   「主日＋欄位＋兩邊的值」不會重複寄；值變了才會再寄。
 *   受 `DRY_RUN` 保護，寫 `SendLog`。
 * Args:
 *   result {Object} `reconcileAllFillGrids_()` 的輸出。
 * Returns:
 *   {{sent:boolean, reason:(string|undefined), notifiedCount:number}}
 */
function sendFillConflictNotice_(result) {
  var dryRun = normalizeBoolean_(getConfig(CONFIG_KEYS.DRY_RUN, 'TRUE')) === true;

  var notified = {};
  readNotifiedFingerprints_().forEach(function (fp) { notified[fp] = true; });

  var fresh = [];
  result.quarters.forEach(function (q) {
    q.cells.forEach(function (cell) {
      if (cell.status !== FILL_SYNC_STATUS.CONFLICT) return;
      var fingerprint = ['FILL_CONFLICT', cell.isoDate, cell.fieldKey, cell.gridValue, cell.systemValue].join('|');
      if (notified[fingerprint]) return;
      fresh.push(Object.assign({ quarterId: q.quarterId, fingerprint: fingerprint }, cell));
    });
  });

  if (fresh.length === 0) return { sent: false, reason: 'ALREADY_NOTIFIED', notifiedCount: 0 };

  var allowedGroups = getConfigTextList_(CONFIG_KEYS.FILL_CONFLICT_GROUPS, 'ADMIN');
  var recipientsResult = buildRecipientList_(readSheet(SHEETS.RECIPIENTS), allowedGroups, null);
  if (recipientsResult.recipients.length === 0) return { sent: false, reason: 'NO_RECIPIENTS', notifiedCount: 0 };

  var esc = escapeHtmlEmail_;
  var churchName = getConfig(CONFIG_KEYS.CHURCH_NAME, '');
  var subject = churchName + '粵語堂週報：季度填寫表有 ' + fresh.length + ' 格衝突';
  var htmlBody = [
    '<h2 style="margin:0 0 0.6em;">季度填寫表衝突提醒</h2>',
    '<p>以下欄位在季度填寫表與系統兩邊都被改過，系統<strong>沒有</strong>改動任何一邊：</p>',
    '<table style="border-collapse:collapse;width:100%;">',
    '<thead><tr>'
    + '<th style="border:1px solid #ccc;padding:4px 8px;text-align:left;">主日</th>'
    + '<th style="border:1px solid #ccc;padding:4px 8px;text-align:left;">欄位</th>'
    + '<th style="border:1px solid #ccc;padding:4px 8px;text-align:left;">上次同步時</th>'
    + '<th style="border:1px solid #ccc;padding:4px 8px;text-align:left;">填寫表的值</th>'
    + '<th style="border:1px solid #ccc;padding:4px 8px;text-align:left;">系統的值</th>'
    + '</tr></thead><tbody>',
    fresh.map(function (c) {
      return '<tr>'
        + '<td style="border:1px solid #ccc;padding:4px 8px;">' + esc(c.isoDate) + '</td>'
        + '<td style="border:1px solid #ccc;padding:4px 8px;">' + esc(c.label) + '</td>'
        + '<td style="border:1px solid #ccc;padding:4px 8px;">' + esc(c.snapshotValue || '（空白）') + '</td>'
        + '<td style="border:1px solid #ccc;padding:4px 8px;">' + esc(c.gridValue || '（空白）') + '</td>'
        + '<td style="border:1px solid #ccc;padding:4px 8px;">' + esc(c.systemValue || '（空白）') + '</td>'
        + '</tr>';
    }).join(''),
    '</tbody></table>',
    '<p style="background:#fdeceb;color:#8c231c;padding:0.8em 1em;border-radius:4px;">',
    '<strong>系統不會自動選擇任何一邊。</strong>請用試算表選單「週報系統 ▸ 處理填寫表衝突」逐項確認。',
    '</p>'
  ].join('\n');

  var plainBody = htmlBody.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  var sendLogRows = [];

  recipientsResult.recipients.forEach(function (recipient) {
    var status = 'FILL_CONFLICT_NOTICE';
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
      TIMESTAMP: new Date(), SERVICE_DATE: '',
      RECIPIENT_EMAIL: sanitizeCellText_(recipient.email),
      SUBJECT: sanitizeCellText_(subject), STATUS: status, DRY_RUN: dryRun,
      ROSTER_VERSION_USED: '', ERROR: sanitizeCellText_(errorMessage),
      BODY_PREVIEW: buildSendLogBodyPreview_(plainBody)
    });
  });

  writeSheet(SHEETS.SEND_LOG, sendLogRows);

  // 指紋是**狀態**，試行模式不可以消耗它（同 src/ConflictNotice.gs）。
  if (!dryRun) {
    writeSheet(SHEETS.CONFLICT_NOTICE_LOG, fresh.map(function (c) {
      return {
        TIMESTAMP: new Date(), SERVICE_DATE: normalizeDate_(c.isoDate),
        POST_ID: 'FILL_CONFLICT', SLOT_INDEX: '',
        FINGERPRINT: sanitizeCellText_(c.fingerprint),
        ROSTER_VALUE: sanitizeCellText_(c.systemValue),
        NOTES: '已寄出填寫表衝突提醒；兩邊的值再變才會再寄。'
      };
    }));
  }

  return { sent: true, notifiedCount: fresh.length };
}

/**
 * 用途：安裝／移除填寫表的兩個觸發器。安裝之前一律先刪同名的，避免重複。
 * Args:
 *   handlerName {string} 處理函式名稱。
 * Returns:
 *   {number} 刪除的觸發器數目。
 */
function removeTriggersByHandler_(handlerName) {
  var removed = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() !== handlerName) return;
    ScriptApp.deleteTrigger(t);
    removed++;
  });
  return removed;
}
