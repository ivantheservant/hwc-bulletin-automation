/**
 * SelfCheck.gs
 *
 * prompt9 第 4 部分：「完成度自我檢測」——Ivan 判斷「系統是否可以交付」
 * 的唯一依據。逐項自動檢測設定／資料／功能／紀錄四大類，每項輸出
 * 🟢／🟡／🔴 加一句說明，寫入 `Diagnostics`，並用對話框顯示三個數字。
 *
 * **🔴 的定義**：會令系統無法正常運作的項目（例如職事表沒設定、範本
 * 檔案讀不到）。**🟡**：可以運作但未完備（例如工作表保護未設定、
 * 尚有待填欄位）。
 *
 * ⚠️ 唯讀：本檔案全部檢查一律不寫入任何資料，只讀取現況——這份報告本身
 * 就是要給 Ivan 一個「現在系統長什麼樣」的忠實快照，不應該在檢查的
 * 過程中順手改動了什麼。
 */

'use strict';

var SELF_CHECK_STATUS_ = Object.freeze({ GREEN: '🟢', YELLOW: '🟡', RED: '🔴' });

/**
 * 用途：組出一個檢測項目。小工具，純粹減少重複打字。
 * Args:
 *   label {string} 項目名稱。
 *   status {string} `SELF_CHECK_STATUS_` 其中一個值。
 *   message {string} 一句說明。
 * Returns:
 *   {{label:string, status:string, message:string}}
 */
function selfCheckItem_(label, status, message) {
  return { label: label, status: status, message: message };
}

/**
 * 用途：算出「本季」——用來檢查「本季待填欄位總數」與「尊稱未設定人數」
 *   的季度 ID。以 `guessNextBulletinSendIso_()`（下一次要寄的主日）為準，
 *   猜不到就退回 Config `ROSTER_TEST_DATE`。
 * Args: （無）
 * Returns:
 *   {?string} 職事表讀不到／未設定時回 `null`。
 */
function selfCheckResolveCurrentQuarterId_() {
  var refDate = guessNextBulletinSendIso_() || getConfig(CONFIG_KEYS.ROSTER_TEST_DATE, '2027-10-03');
  try {
    var snapshot = readRosterSnapshot_(refDate);
    if (snapshot.notConfigured || !snapshot.quarterId) return null;
    return snapshot.quarterId;
  } catch (err) {
    return null;
  }
}

// =====================================================================
// 設定類
// =====================================================================

/**
 * 用途：設定類的全部檢測項目。
 * Args: （無）
 * Returns:
 *   {{label:string, status:string, message:string}[]}
 */
function selfCheckConfigItems_() {
  var items = [];
  var S = SELF_CHECK_STATUS_;

  // ---- ROSTER_SPREADSHEET_ID ----
  var rosterId = getConfig(CONFIG_KEYS.ROSTER_SPREADSHEET_ID, '');
  if (!rosterId) {
    items.push(selfCheckItem_('職事表試算表 ID', S.RED, '尚未設定 ROSTER_SPREADSHEET_ID。'));
  } else {
    try {
      readRosterSnapshot_(getConfig(CONFIG_KEYS.ROSTER_TEST_DATE, '2027-10-03'));
      items.push(selfCheckItem_('職事表試算表 ID', S.GREEN, '已設定且讀得到。'));
    } catch (err) {
      items.push(selfCheckItem_('職事表試算表 ID', S.RED, '已設定但讀取失敗：' + ((err && err.message) ? err.message : String(err))));
    }
  }

  // ---- 三個 TEMPLATE_FILE_ID_* ----
  var templateChecks = [
    { key: CONFIG_KEYS.TEMPLATE_FILE_ID_NORMAL, label: '平常主日 Word 範本', critical: true },
    { key: CONFIG_KEYS.TEMPLATE_FILE_ID_COMBINED_BAPTISM, label: '浸禮三堂聯合崇拜 Word 範本', critical: false },
    { key: CONFIG_KEYS.TEMPLATE_FILE_ID_ANNIVERSARY, label: '堂慶三堂聯合崇拜 Word 範本', critical: false }
  ];
  templateChecks.forEach(function (t) {
    var fileId = getConfig(t.key, '');
    if (!fileId) {
      items.push(selfCheckItem_(t.label, t.critical ? S.RED : S.YELLOW, '尚未設定 ' + t.key + '。'));
      return;
    }
    try {
      readTemplateBlob_(fileId);
      items.push(selfCheckItem_(t.label, S.GREEN, '已設定、檔案存在、MIME 正確。'));
    } catch (err) {
      items.push(selfCheckItem_(t.label, S.RED, '已設定但讀取失敗：' + ((err && err.message) ? err.message : String(err))));
    }
  });

  // ---- BULLETIN_OUTPUT_FOLDER_ID ----
  var folderId = getConfig(CONFIG_KEYS.BULLETIN_OUTPUT_FOLDER_ID, '');
  var folderCheck = checkOutputFolderAccessible_(folderId);
  items.push(selfCheckItem_('週報輸出資料夾', folderCheck.ok ? S.GREEN : (folderId ? S.RED : S.YELLOW), folderCheck.message));

  // ---- Recipients 各組別人數、DRY_RUN ----
  var recipientsByGroup = {};
  readSheet(SHEETS.RECIPIENTS).forEach(function (r) {
    if (r.ACTIVE !== true) return;
    var g = String(r.GROUP_NAME || '（未分組）');
    recipientsByGroup[g] = (recipientsByGroup[g] || 0) + 1;
  });
  var groupSummary = Object.keys(recipientsByGroup).sort().map(function (g) {
    return g + '：' + recipientsByGroup[g] + ' 人';
  }).join('　');
  items.push(selfCheckItem_(
    'Recipients 收件人',
    Object.keys(recipientsByGroup).length > 0 ? S.GREEN : S.YELLOW,
    Object.keys(recipientsByGroup).length > 0 ? groupSummary : 'Recipients 工作表沒有任何有效的收件人。'
  ));

  var dryRun = getConfig(CONFIG_KEYS.DRY_RUN, 'TRUE');
  items.push(selfCheckItem_('DRY_RUN 目前值', S.GREEN, dryRun));

  // ---- 工作表結構 ----
  var schema = checkSheetSchema_();
  items.push(selfCheckItem_(
    '工作表結構（Config 鍵數與程式碼期望值一致）',
    schema.ok ? S.GREEN : S.RED,
    schema.ok ? '一致。' : buildSchemaShortSummary_(schema)
  ));

  return items;
}

// =====================================================================
// 資料類
// =====================================================================

/**
 * 用途：資料類的全部檢測項目。
 * Args:
 *   currentQuarterId {?string} `selfCheckResolveCurrentQuarterId_()` 的結果。
 * Returns:
 *   {{label:string, status:string, message:string}[]}
 */
function selfCheckDataItems_(currentQuarterId) {
  var items = [];
  var S = SELF_CHECK_STATUS_;

  var weekRows = readSheet(SHEETS.BULLETIN_WEEKS);
  var quarterIds = {};
  weekRows.forEach(function (r) { if (r.QUARTER_ID) quarterIds[r.QUARTER_ID] = true; });
  items.push(selfCheckItem_(
    'BulletinWeeks 資料量',
    weekRows.length > 0 ? S.GREEN : S.YELLOW,
    Object.keys(quarterIds).length + ' 季、' + weekRows.length + ' 個主日。'
  ));

  if (currentQuarterId) {
    var personDisplayRows = readSheet(SHEETS.PERSON_DISPLAY);
    try {
      var refDate = guessNextBulletinSendIso_() || getConfig(CONFIG_KEYS.ROSTER_TEST_DATE, '2027-10-03');
      var quarterInfo = listRosterQuarterAssignedPersons_(refDate);
      var missingHonorific = buildHonorificMissingList_(quarterInfo.persons, personDisplayRows);
      items.push(selfCheckItem_(
        'PersonDisplay 尊稱未設定人數',
        missingHonorific.length === 0 ? S.GREEN : S.YELLOW,
        missingHonorific.length + ' 人（本季共 ' + quarterInfo.persons.length + ' 人有事奉）。'
      ));
    } catch (err) {
      items.push(selfCheckItem_('PersonDisplay 尊稱未設定人數', S.YELLOW, '無法計算：' + ((err && err.message) ? err.message : String(err))));
    }

    try {
      var serviceDates = listQuarterServiceDates_(currentQuarterId);
      var totalMissing = 0;
      serviceDates.forEach(function (sd) {
        try {
          totalMissing += (buildBulletinModel_(sd.isoDate).missing || []).length;
        } catch (perDateErr) {
          // 單一主日算不出來不應該讓整個自我檢測失敗，忽略即可——
          // 那個主日本身的問題會在其他檢測項目或演練報告裡看得到。
        }
      });
      items.push(selfCheckItem_(
        '本季（' + currentQuarterId + '）待填欄位總數',
        totalMissing === 0 ? S.GREEN : S.YELLOW,
        totalMissing + ' 項（共 ' + serviceDates.length + ' 個主日）。'
      ));
    } catch (err) {
      items.push(selfCheckItem_('本季待填欄位總數', S.YELLOW, '無法計算：' + ((err && err.message) ? err.message : String(err))));
    }
  } else {
    items.push(selfCheckItem_('PersonDisplay 尊稱未設定人數', S.YELLOW, '職事表未設定或讀不到，無法計算。'));
    items.push(selfCheckItem_('本季待填欄位總數', S.YELLOW, '職事表未設定或讀不到，無法計算。'));
  }

  [
    { sheetId: 'FELLOWSHIPS', label: 'Fellowships（團契）' },
    { sheetId: 'ANNOUNCEMENTS', label: 'Announcements（家事報告）' },
    { sheetId: 'PRAYERS', label: 'Prayers（代禱事項）' }
  ].forEach(function (s) {
    var rows = readSheet(SHEETS[s.sheetId]);
    items.push(selfCheckItem_(s.label + ' 有無資料', rows.length > 0 ? S.GREEN : S.YELLOW, rows.length + ' 行。'));
  });

  return items;
}

// =====================================================================
// 功能類
// =====================================================================

/**
 * 用途：功能類的全部檢測項目。
 * Args: （無）
 * Returns:
 *   {{label:string, status:string, message:string}[]}
 */
function selfCheckFeatureItems_() {
  var items = [];
  var S = SELF_CHECK_STATUS_;

  var handlers = {};
  ScriptApp.getProjectTriggers().forEach(function (t) {
    var h = t.getHandlerFunction();
    handlers[h] = (handlers[h] || 0) + 1;
  });

  var sendInstalled = Boolean(handlers['weeklyBulletinSendTrigger_']);
  items.push(selfCheckItem_('觸發器：自動寄送', sendInstalled ? S.GREEN : S.YELLOW, sendInstalled ? '已安裝。' : '尚未安裝，需要人手撳選單安裝。'));

  var fillEditInstalled = Boolean(handlers['onFillGridEdit_']);
  items.push(selfCheckItem_('觸發器：填寫表同步', fillEditInstalled ? S.GREEN : S.YELLOW, fillEditInstalled ? '已安裝。' : '尚未安裝。'));

  var reconcileInstalled = Boolean(handlers['fillReconcileTrigger_']);
  items.push(selfCheckItem_('觸發器：填寫表對帳', reconcileInstalled ? S.GREEN : S.YELLOW, reconcileInstalled ? '已安裝。' : '尚未安裝。'));

  // ⚠️「下一季提示」（autoCreateNextQuarterFillGrids_）不是獨立的觸發器，
  // 是每週自動寄送流程 weeklyBulletinSendTrigger_ 順手做的一部分，
  // 見 src/Trigger.gs／src/FillAdmin.gs——所以這裡的安裝狀態跟「自動
  // 寄送」共用同一個判斷依據，不是另外裝一個。
  items.push(selfCheckItem_(
    '觸發器：下一季提示（隨自動寄送觸發器一起執行）',
    sendInstalled ? S.GREEN : S.YELLOW,
    sendInstalled ? '會隨每週自動寄送一起檢查。' : '自動寄送觸發器未安裝，這個功能也不會執行。'
  ));

  var webAppUrl = getConfig(CONFIG_KEYS.WEBAPP_URL, '');
  items.push(selfCheckItem_('Web App 部署', webAppUrl ? S.GREEN : S.YELLOW, webAppUrl ? '已部署（' + webAppUrl + '）。' : 'WEBAPP_URL 是空的，尚未填入部署後的網址。'));

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var protectedCount = protectedSheetNames_().filter(function (name) {
    var sheet = ss.getSheetByName(name);
    return sheet && sheet.getProtections(SpreadsheetApp.ProtectionType.SHEET).length > 0;
  }).length;
  var totalProtectable = protectedSheetNames_().length;
  items.push(selfCheckItem_(
    '工作表保護',
    protectedCount === totalProtectable ? S.GREEN : S.YELLOW,
    protectedCount + '／' + totalProtectable + ' 張已設定保護。'
  ));

  var placeholderReport = inspectTemplatePlaceholders_();
  placeholderReport.templates.forEach(function (t) {
    if (!t.configured) return; // 範本未設定已經在設定類報過，這裡不重複。
    if (t.error) {
      items.push(selfCheckItem_('範本佔位符對帳：' + t.label, S.RED, '讀取失敗：' + t.error));
      return;
    }
    var unknownCount = t.unknownValues.length + t.unknownLists.length;
    items.push(selfCheckItem_(
      '範本佔位符對帳：' + t.label,
      unknownCount === 0 ? S.GREEN : S.RED,
      unknownCount === 0
        ? '範本用到的佔位符系統全部都有提供。'
        : '範本用到但系統不提供：' + t.unknownValues.concat(t.unknownLists).join('、')
    ));
  });

  return items;
}

// =====================================================================
// 紀錄類
// =====================================================================

/**
 * 用途：紀錄類的全部檢測項目。
 * Args: （無）
 * Returns:
 *   {{label:string, status:string, message:string}[]}
 */
function selfCheckLogItems_() {
  var items = [];
  var S = SELF_CHECK_STATUS_;

  var sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  var recentErrors = readSheet(SHEETS.ERROR_LOG).filter(function (r) {
    return r.TIMESTAMP instanceof Date && r.TIMESTAMP >= sevenDaysAgo;
  });
  items.push(selfCheckItem_(
    'ErrorLog 最近 7 日錯誤數',
    recentErrors.length > 0 ? S.YELLOW : S.GREEN,
    recentErrors.length + ' 筆。'
  ));

  var sendLogRows = readSheet(SHEETS.SEND_LOG);
  if (sendLogRows.length === 0) {
    items.push(selfCheckItem_('SendLog 最近一次寄送', S.YELLOW, '從未寄送過（或試寄過）。'));
  } else {
    var latest = sendLogRows.reduce(function (best, r) {
      if (!(r.TIMESTAMP instanceof Date)) return best;
      if (!best || r.TIMESTAMP > best.TIMESTAMP) return r;
      return best;
    }, null);
    items.push(selfCheckItem_(
      'SendLog 最近一次寄送',
      S.GREEN,
      latest ? (formatDateForBatchReport_(latest.TIMESTAMP) + '　狀態：' + latest.STATUS + '　試行：' + latest.DRY_RUN) : '（找不到有效時間戳記的記錄）'
    ));
  }

  items.push(selfCheckItem_('AuditLog 行數', S.GREEN, readSheet(SHEETS.AUDIT_LOG).length + ' 行。'));

  return items;
}

// =====================================================================
// 總入口
// =====================================================================

/**
 * 用途：「完成度自我檢測」的真正入口。跑完設定／資料／功能／紀錄四大類
 *   全部檢測項目，寫入 `Diagnostics`（報告名稱「完成度自我檢測」）。
 *   **唯讀**，不寫入任何資料。
 * Args: （無）
 * Returns:
 *   {{items:Object[], greenCount:number, yellowCount:number, redCount:number}}
 */
function runSelfCheck_() {
  var currentQuarterId = selfCheckResolveCurrentQuarterId_();

  var items = []
    .concat(selfCheckConfigItems_())
    .concat(selfCheckDataItems_(currentQuarterId))
    .concat(selfCheckFeatureItems_())
    .concat(selfCheckLogItems_());

  var S = SELF_CHECK_STATUS_;
  var greenCount = items.filter(function (i) { return i.status === S.GREEN; }).length;
  var yellowCount = items.filter(function (i) { return i.status === S.YELLOW; }).length;
  var redCount = items.filter(function (i) { return i.status === S.RED; }).length;

  var summary = { items: items, greenCount: greenCount, yellowCount: yellowCount, redCount: redCount };
  writeDiagnosticsReport_('完成度自我檢測', buildSelfCheckReportLines_(summary));
  return summary;
}

/**
 * 用途：把 `runSelfCheck_()` 的結果排版成 `Diagnostics` 報告的內容行。
 *
 *   ⚠️ 區段標題一律用全形括號「【…】」，不可以用 `===` 開頭——見
 *   docs/已知bug類型.md 事故六。
 * Args:
 *   summary {Object} `runSelfCheck_()` 的回傳值。
 * Returns:
 *   {string[]}
 */
function buildSelfCheckReportLines_(summary) {
  var lines = [];
  lines.push('【總覽】');
  lines.push('🟢 ' + summary.greenCount + ' 項　🟡 ' + summary.yellowCount + ' 項　🔴 ' + summary.redCount + ' 項');
  lines.push('');
  lines.push('【逐項結果】');
  summary.items.forEach(function (item) {
    lines.push(item.status + '　' + item.label + '　' + item.message);
  });
  return lines;
}

// =====================================================================
// 選單處理函式
// =====================================================================

/**
 * 用途：選單項目「完成度自我檢測」的處理函式。
 * Args: （無）
 * Returns:
 *   {void}
 */
function menuRunSelfCheck_() {
  var ui = SpreadsheetApp.getUi();
  try {
    var summary = runSelfCheck_();
    ui.alert(
      '完成度自我檢測',
      '🟢 ' + summary.greenCount + ' 項　🟡 ' + summary.yellowCount + ' 項　🔴 ' + summary.redCount + ' 項\n\n'
      + '完整清單已寫入 Diagnostics 工作表。',
      ui.ButtonSet.OK
    );
  } catch (err) {
    logMenuError_('menuRunSelfCheck_', err);
    ui.alert('完成度自我檢測失敗', String(err && err.message ? err.message : err), ui.ButtonSet.OK);
  }
}
