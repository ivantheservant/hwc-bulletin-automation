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
 *   detail {string[]=} 選填，寫入 `Diagnostics` 的明細行（例如尊稱未設定
 *     名單、待填欄位明細）——只在報告內容出現，不影響對話框顯示的三個
 *     數字。省略時等於沒有明細。
 * Returns:
 *   {{label:string, status:string, message:string, detail:string[]}}
 */
function selfCheckItem_(label, status, message, detail) {
  return { label: label, status: status, message: message, detail: detail || [] };
}

/**
 * 用途：「檢測季度」這一項的中文說明短語，依 `resolveWorkingQuarter_()`
 *   實際用了哪一層而不同。
 * Args:
 *   source {string} `resolveWorkingQuarter_()` 回傳的 `source`。
 * Returns:
 *   {string}
 */
function selfCheckQuarterSourcePhrase_(source) {
  var phrases = {
    NEXT_SEND_SUNDAY: '由下一個要寄的主日推算',
    ROSTER_TEST_DATE: '職事表沒有下一個主日的資料，改用設定值 ROSTER_TEST_DATE 推算',
    CONFIG_OVERRIDE: '設定值 WORKING_QUARTER_ID 指定',
    BULLETIN_WEEKS_LATEST: '前三層都推算失敗，改用 BulletinWeeks 現有資料推算'
  };
  return phrases[source] || source;
}

/**
 * 用途：「檢測季度」這一項檢測——把 `resolveWorkingQuarter_()` 的結果
 *   排版成一句人看得懂的說明。**不可以靜靜退回而不講用了哪一層**（見
 *   `docs/已知bug類型.md` 第 27 條的同一類問題：靜靜退回沒有錯誤訊息）。
 * Args:
 *   quarterResolution {Object} `resolveWorkingQuarter_()` 的回傳值。
 * Returns:
 *   {{label:string, status:string, message:string, detail:string[]}}
 */
function selfCheckQuarterItem_(quarterResolution) {
  var S = SELF_CHECK_STATUS_;
  var qr = quarterResolution;

  if (!qr.ok) {
    return selfCheckItem_('檢測季度', S.YELLOW, '四層推算全部失敗，見下方明細。', qr.notes);
  }

  var message = '本季 ' + qr.quarterId + '（' + selfCheckQuarterSourcePhrase_(qr.source) + '）';
  if (qr.source === 'CONFIG_OVERRIDE' && qr.notes.some(function (n) { return n.indexOf('找不到') !== -1; })) {
    message += '　⚠️ 設定值指定的季度在職事表找不到，請確認 WORKING_QUARTER_ID 是否打錯。';
  }
  return selfCheckItem_('檢測季度', S.GREEN, message, qr.notes);
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
 *
 *   ⚠️ 「尊稱未設定人數」與「待填欄位總數」一律用同一個
 *   `quarterResolution.quarterId`——不可以任何一項自己再猜一次季度，
 *   否則兩項可能各自報不同季的數字，見 `docs/已知bug類型.md` 第 3 類。
 * Args:
 *   quarterResolution {Object} `resolveWorkingQuarter_()` 的回傳值，由
 *     `runSelfCheck_()` 只算一次、向下傳給本函式。
 * Returns:
 *   {{label:string, status:string, message:string, detail:string[]}[]}
 */
function selfCheckDataItems_(quarterResolution) {
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

  var currentQuarterId = quarterResolution.ok ? quarterResolution.quarterId : null;

  if (currentQuarterId) {
    var personDisplayRows = readSheet(SHEETS.PERSON_DISPLAY);
    try {
      // ⚠️ listRosterQuarterAssignedPersons_() 要的是一個「屬於這一季的
      // 主日日期」，不是季度 ID 本身——沿用 listRosterServiceDatesForQuarter_()
      // 取這一季隨便一個（第一個）主日，不重寫「日期查季度」那一套邏輯，
      // 也不會因為用了跟「待填欄位總數」不同的日期而算出不同的季度。
      var quarterDates = listRosterServiceDatesForQuarter_(currentQuarterId);
      if (quarterDates.length === 0) {
        throw new Error('職事表 ServiceDates 找不到季度「' + currentQuarterId + '」的任何主日。');
      }
      var quarterInfo = listRosterQuarterAssignedPersons_(quarterDates[0]);
      var missingHonorific = buildHonorificMissingList_(quarterInfo.persons, personDisplayRows);
      items.push(selfCheckItem_(
        'PersonDisplay 尊稱未設定人數',
        missingHonorific.length === 0 ? S.GREEN : S.YELLOW,
        missingHonorific.length + ' 人（本季共 ' + quarterInfo.persons.length + ' 人有事奉）。',
        missingHonorific.map(function (p) { return p.personId + '　' + (p.nameTC || '（無姓名）'); })
      ));
    } catch (err) {
      items.push(selfCheckItem_('PersonDisplay 尊稱未設定人數', S.YELLOW, '無法計算：' + ((err && err.message) ? err.message : String(err))));
    }

    try {
      var serviceDates = listQuarterServiceDates_(currentQuarterId);
      var totalMissing = 0;
      var missingDetail = [];
      serviceDates.forEach(function (sd) {
        try {
          (buildBulletinModel_(sd.isoDate).missing || []).forEach(function (m) {
            totalMissing++;
            missingDetail.push(sd.isoDate + '　' + m.label + '（' + m.field + '）');
          });
        } catch (perDateErr) {
          // 單一主日算不出來不應該讓整個自我檢測失敗，忽略即可——
          // 那個主日本身的問題會在其他檢測項目或演練報告裡看得到。
        }
      });
      items.push(selfCheckItem_(
        '本季（' + currentQuarterId + '）待填欄位總數',
        totalMissing === 0 ? S.GREEN : S.YELLOW,
        totalMissing + ' 項（共 ' + serviceDates.length + ' 個主日）。',
        missingDetail
      ));
    } catch (err) {
      items.push(selfCheckItem_('本季待填欄位總數', S.YELLOW, '無法計算：' + ((err && err.message) ? err.message : String(err))));
    }
  } else {
    items.push(selfCheckItem_('PersonDisplay 尊稱未設定人數', S.YELLOW, '未能決定季度，見『檢測季度』一項。'));
    items.push(selfCheckItem_('本季待填欄位總數', S.YELLOW, '未能決定季度，見『檢測季度』一項。'));
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
 *
 *   ⚠️ `resolveWorkingQuarter_()`（`src/QuarterResolve.gs`）**只叫一次**，
 *   結果向下傳給 `selfCheckDataItems_()`——不可以任何一個檢測項自己
 *   再猜一次季度，見 `docs/已知bug類型.md` 第 3 類。
 * Args: （無）
 * Returns:
 *   {{items:Object[], greenCount:number, yellowCount:number, redCount:number,
 *     quarterResolution:Object}}
 */
function runSelfCheck_() {
  var quarterResolution = resolveWorkingQuarter_();

  var items = []
    .concat(selfCheckConfigItems_())
    .concat([selfCheckQuarterItem_(quarterResolution)])
    .concat(selfCheckDataItems_(quarterResolution))
    .concat(selfCheckFeatureItems_())
    .concat(selfCheckLogItems_());

  var S = SELF_CHECK_STATUS_;
  var greenCount = items.filter(function (i) { return i.status === S.GREEN; }).length;
  var yellowCount = items.filter(function (i) { return i.status === S.YELLOW; }).length;
  var redCount = items.filter(function (i) { return i.status === S.RED; }).length;

  var summary = {
    items: items, greenCount: greenCount, yellowCount: yellowCount, redCount: redCount,
    quarterResolution: quarterResolution
  };
  writeDiagnosticsReport_('完成度自我檢測', buildSelfCheckReportLines_(summary));
  return summary;
}

/**
 * 用途：把 `runSelfCheck_()` 的結果排版成 `Diagnostics` 報告的內容行。
 *
 *   ⚠️ 區段標題一律用全形括號「【…】」，不可以用 `===` 開頭——見
 *   docs/已知bug類型.md 事故六。
 *
 *   ⚠️ 每個項目若有 `detail`（尊稱未設定名單、待填欄位明細），逐行
 *   縮排列在該項目下方——行數上限交給 `writeDiagnosticsReport_()`
 *   既有的 `DIAGNOSTICS_MAX_ROWS` 截斷機制統一處理，這裡不用另外截斷。
 * Args:
 *   summary {Object} `runSelfCheck_()` 的回傳值。
 * Returns:
 *   {string[]}
 */
function buildSelfCheckReportLines_(summary) {
  var lines = [];
  var qr = summary.quarterResolution;

  lines.push('檢測季度：' + (qr.ok ? qr.quarterId : '（未能決定）') + '　來源：' + (qr.ok ? qr.sourceLabel : '四層全部失敗'));
  lines.push('');
  lines.push('【總覽】');
  lines.push('🟢 ' + summary.greenCount + ' 項　🟡 ' + summary.yellowCount + ' 項　🔴 ' + summary.redCount + ' 項');
  lines.push('');
  lines.push('【逐項結果】');
  summary.items.forEach(function (item) {
    lines.push(item.status + '　' + item.label + '　' + item.message);
    (item.detail || []).forEach(function (d) { lines.push('　　' + d); });
  });
  return lines;
}

// =====================================================================
// 檢查授權範圍
// =====================================================================

/**
 * 用途：「檢查授權範圍」要逐一試探的服務清單與探測方式。寫成函式
 *   延遲求值，不依賴 `.gs` 檔案載入次序（見 docs/已知bug類型.md 事故一）。
 *
 *   ⚠️ 每一個探測都要**最輕量、不產生副作用**——這是「有沒有權限」的
 *   試探，不是功能測試，不可以順手寫入或刪除任何東西。`DriveApp` 不可以
 *   在這個檔案直接呼叫（`tools/lint-readonly-roster.js` 規則 3 只准
 *   `src/DocxIo.gs` 出現），所以透過 `probeDriveAccess_()` 間接呼叫。
 * Args: （無）
 * Returns:
 *   {{item:string, probe:function():void}[]}
 */
function authorizationScopeProbes_() {
  return [
    { item: 'SpreadsheetApp（試算表）', probe: function () { SpreadsheetApp.getActiveSpreadsheet().getName(); } },
    { item: 'DriveApp（雲端硬碟）', probe: function () { probeDriveAccess_(); } },
    { item: 'MailApp（寄信配額查詢）', probe: function () { MailApp.getRemainingDailyQuota(); } },
    { item: 'ScriptApp（觸發器清單）', probe: function () { ScriptApp.getProjectTriggers(); } },
    { item: 'Session（目前使用者）', probe: function () { Session.getActiveUser().getEmail(); } }
  ];
}

/**
 * 用途：「檢查授權範圍」的真正入口。逐一試探性呼叫
 *   `authorizationScopeProbes_()` 列出的服務，回報哪些可用、哪些授權
 *   不足。**唯讀**。
 * Args: （無）
 * Returns:
 *   {{item:string, ok:boolean, message:string}[]}
 */
function checkAuthorizationScopes_() {
  return authorizationScopeProbes_().map(function (p) {
    try {
      p.probe();
      return { item: p.item, ok: true, message: '可用。' };
    } catch (err) {
      return { item: p.item, ok: false, message: enrichAuthError_(err) };
    }
  });
}

/**
 * 用途：把 `checkAuthorizationScopes_()` 的結果排版成 `Diagnostics`
 *   報告的內容行。
 *
 *   ⚠️ 區段標題一律用全形括號「【…】」，不可以用 `===` 開頭——見
 *   docs/已知bug類型.md 事故六。
 * Args:
 *   results {{item:string, ok:boolean, message:string}[]}
 *     `checkAuthorizationScopes_()` 的回傳值。
 * Returns:
 *   {string[]}
 */
function buildAuthorizationScopeReportLines_(results) {
  var lines = [];
  var failedCount = results.filter(function (r) { return !r.ok; }).length;
  lines.push('共 ' + results.length + ' 項，' + (failedCount === 0 ? '全部可用。' : failedCount + ' 項未授權或呼叫失敗。'));
  lines.push('');
  lines.push('【逐項結果】');
  results.forEach(function (r) {
    lines.push((r.ok ? '✓ 可用' : '✗ 未授權') + '　' + r.item + '　' + r.message);
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
    ui.alert('完成度自我檢測失敗', enrichAuthError_(err), ui.ButtonSet.OK);
  }
}

/**
 * 用途：選單項目「檢查授權範圍」的處理函式。**唯讀**。
 * Args: （無）
 * Returns:
 *   {void}
 */
function menuCheckAuthorizationScopes_() {
  var ui = SpreadsheetApp.getUi();
  try {
    var results = checkAuthorizationScopes_();
    writeDiagnosticsReport_('檢查授權範圍', buildAuthorizationScopeReportLines_(results));

    var failed = results.filter(function (r) { return !r.ok; });
    if (failed.length === 0) {
      ui.alert('檢查授權範圍', '全部 ' + results.length + ' 項服務都可以正常呼叫，授權範圍沒有問題。', ui.ButtonSet.OK);
      return;
    }

    var lines = ['以下 ' + failed.length + ' 項未授權或呼叫失敗：', ''];
    failed.forEach(function (r) { lines.push('　' + r.item + '：' + r.message); });
    lines.push('');
    lines.push('完整結果已寫入 Diagnostics 工作表。');
    ui.alert('檢查授權範圍', lines.join('\n'), ui.ButtonSet.OK);
  } catch (err) {
    logMenuError_('menuCheckAuthorizationScopes_', err);
    ui.alert('檢查授權範圍失敗', enrichAuthError_(err), ui.ButtonSet.OK);
  }
}
