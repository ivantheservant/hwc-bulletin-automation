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
    inviteGroups: getConfigTextList_(CONFIG_KEYS.CONTENT_SHEET_INVITE_GROUPS, 'CC,DB,ADMIN,IT,WORSHIP'),
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
  // 內容表 v2（決定 6）：「崇拜程序」有十多欄，凍結 A 欄（主日日期），向右捲動仍然看得到是哪一個主日。
  //    凍結失敗（例如有人合併了跨 A、B 欄的格，Sheets 會拒絕）不可以令版面其餘部分、_說明等略過：
  //    寫一筆 ErrorLog（上線前檢查「最近 7 日的錯誤」看得到），其餘照做（審查第二輪 7）。
  if (tabDef.frozenColumns && sheet.getFrozenColumns() < tabDef.frozenColumns) {
    try {
      sheet.setFrozenColumns(tabDef.frozenColumns);
    } catch (freezeErr) {
      appendErrorLog_({
        source: ERROR_LOG_SOURCE.SERVER, functionName: 'applyContentTabLayout_',
        errorCode: 'CONTENT_SHEET_FREEZE_FAILED',
        message: '內容表「' + tabDef.tabName + '」凍結 A 欄失敗（多數是有人合併了跨欄的格）：'
          + ((freezeErr && freezeErr.message) ? freezeErr.message : String(freezeErr))
          + '。其餘版面照常套用；要凍結的話，先取消合併，再做一次「更新本季內容表」（或者試算表選單「內容表 ▸ 建立本季內容表」）。',
        detail: buildErrorDetail_(freezeErr)
      });
    }
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
 *   options {{fileNameSuffix:string=, serviceDates:string[]=}=} 選填，
 *     兩個都係畀**自測機**用嘅，生產路徑一律唔傳、行為完全唔變：
 *     - `fileNameSuffix`：加喺檔名尾（**只喺新建立嗰陣有用**，已經存在
 *       嘅檔案唔會改名）。沙盒內容表加 `_SELFTEST`，確保唔會撞正式嗰個。
 *     - `serviceDates`：職事表**冇**呢一季資料時改用呢個主日清單。
 *       沙盒季度刻意揀一個職事表冇資料嘅季度，冇呢個參數就連內容表都
 *       建立唔到。
 *     - `migrate`（內容表 v2）：`true`＝已有的舊版內容表照樣移轉成新版（「宣召」「浸禮合堂」併入
 *       「崇拜程序」，見 src/ContentSheetMigrate.gs）。人手入口（填寫介面「季度作業」、選單）先給人看
 *       預覽再傳 `true`；自動流程（星期一）不傳——遇到要移轉的就回 `NEEDS_MIGRATION`，一格都不寫
 *       （bug class 113）。新建的內容表不算移轉，照樣預先開好每個主日一行。
 * Returns:
 *   {{ok:boolean, created:boolean, quarterId:string, fileId:string, fileUrl:string,
 *     tabsCreated:string[], serviceDateCount:number, seededSample:boolean,
 *     sharingApplied:boolean, sharingError:string,
 *     reason:(string|undefined), message:(string|undefined)}}
 *     `ok:false` 時一定有 `reason` 同一句人睇得明嘅 `message`（內容表 v2 加
 *     `NEEDS_MIGRATION`、`LAYOUT_UNKNOWN`、`LEGACY_LAYOUT_UNKNOWN`、`NEW_COLUMNS_NOT_EMPTY`）；`migration` 是移轉計畫
 *     （`planContentSheetV2Migration_()` 的輸出）。
 * Raises:
 *   Error 如果職事表讀取失敗（`listQuarterServiceDates_()` 拋出嚟嘅）；拿不到指令碼鎖
 *     （`code:'LOCK_TIMEOUT'`，一格都未寫）。
 */
function buildOrRefreshContentSheet_(quarterId, options) {
  // 內容表 v2：整段在指令碼鎖之內（D12 的 withScriptLock_()）——兩個分頁同時按「建立／刷新」
  //    會各自新增一次「崇拜程序」的行（bug class 38、134）。
  return withScriptLock_('buildOrRefreshContentSheet_', 30000, function () {
    return buildOrRefreshContentSheetLocked_(quarterId, options);
  }, function () {
    var lockErr = new Error('建立／刷新內容表：30 秒內拿不到指令碼鎖，可能有另一個建立、匯入或儲存正在執行。'
      + '請稍後再試一次。這次一格都沒有寫。');
    lockErr.code = 'LOCK_TIMEOUT';
    throw lockErr;
  });
}

/**
 * 用途：`buildOrRefreshContentSheet_()` 拿到指令碼鎖之後的那一段。只可以由它呼叫。
 * Args:
 *   quarterId {string}　options {Object=} 同 `buildOrRefreshContentSheet_()`。
 * Returns:
 *   {Object} 同 `buildOrRefreshContentSheet_()`。
 * Raises:
 *   Error 同 `buildOrRefreshContentSheet_()`。
 */
function buildOrRefreshContentSheetLocked_(quarterId, options) {
  var buildOptions = options || {};
  var qid = String(quarterId || '').trim();
  if (!qid) {
    return { ok: false, created: false, quarterId: qid, reason: 'NO_QUARTER_ID', message: '季度 ID 不可以是空的。' };
  }

  var config = contentSheetConfig_();
  var folderCheck = checkContentSheetFolderConfigured_(config.folderId);
  if (!folderCheck.ok) {
    return { ok: false, created: false, quarterId: qid, reason: 'NO_FOLDER_ID', message: folderCheck.message };
  }

  // 主日清單只准經這一支拿（見 src/ServiceDates.gs 檔頭）：職事表 →
  // BulletinWeeks（同一季）→ 曆法推算。呼叫方仍然可以自己傳一份蓋過
  // （自測機就是這樣造沙盒的），傳咗就以呼叫方嗰份為準。
  var dateResolution = resolveQuarterServiceDateEntries_(qid);
  var serviceDates = dateResolution.dates.slice();
  if (buildOptions.serviceDates && buildOptions.serviceDates.length > 0) {
    serviceDates = buildOptions.serviceDates.slice();
  }
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
      message: contentSheetFileMissingMessage_(qid, existing.FILE_ID)
    };
  }

  // 內容表 v2：已有的內容表在寫任何一格之前先算好移轉計畫——認不出版面就整次不做；要移轉而
  //    呼叫方沒有說可以（自動流程）就回 NEEDS_MIGRATION，一格都不寫。
  // v3：另外算 v3 更新計畫（浸禮六欄搬入週報、v2 刪走浸禮六欄、停用舊覆寫，見 src/ContentSheetMigrateV3.gs）。
  //    v2 內容表交給 v2 planner 的是「刪走浸禮六欄之後」的樣子，所以兩份計畫可以一齊預覽。
  // v4（2026-10-30）：「崇拜程序」只留三欄、一個日期一行（見 src/ContentSheetV4.gs）。v1、v2、v3 的「崇拜程序」
  //    先經原有的 v2／v3 移轉（用凍結的 v3 定義）變成 v3，再轉成 v4；已經是 v4 的不再經 v2／v3 移轉。
  var migrationPlan = null;
  var upgradePlan = null;
  var v4Detect = spreadsheet ? detectWorshipTabLayoutV4_(spreadsheet) : { layout: 'NONE' };
  var runLegacy = Boolean(spreadsheet) && (v4Detect.layout === 'LEGACY' || v4Detect.layout === 'V3');
  var v4PrePlan = null;
  if (spreadsheet) {
    if (runLegacy) {
      var existingInputs = readContentSheetV2Inputs_(spreadsheet);
      upgradePlan = planContentSheetV3Upgrade_(Object.assign({}, existingInputs, { serviceDates: serviceDates }));
      migrationPlan = planContentSheetV2Migration_(Object.assign({}, existingInputs,
        { serviceDates: serviceDates, created: false }));
      if (v4Detect.layout === 'V3') dropV3AppendsBeforeV4_(migrationPlan);
      if (!migrationPlan.ok) {
        return { ok: false, created: false, quarterId: qid, reason: migrationPlan.reason, message: migrationPlan.message };
      }
    }
    // v1、v2 要先移轉才知道 v4 的行；v3、v4 現在就算得到（預覽看到的就是之後寫的）。
    if (v4Detect.layout !== 'LEGACY') {
      v4PrePlan = planContentSheetV4_(Object.assign(readContentSheetV4Inputs_(spreadsheet), { serviceDates: serviceDates }));
    }
    var needsMigration = (runLegacy && (migrationPlan.needsMigration || contentSheetV3PlanHasWrites_(upgradePlan)))
      || v4Detect.layout === 'LEGACY' || Boolean(v4PrePlan && v4PrePlan.needsMigration);
    if (needsMigration && buildOptions.migrate !== true) {
      return {
        ok: false, created: false, quarterId: qid, reason: 'NEEDS_MIGRATION',
        message: '季度「' + qid + '」的內容表是舊版，要先更新成新版（「崇拜程序」只留讀經經文、證道講題、回應詩歌，'
          + '一個主日一行；序樂、宣召、詩歌頌讚、詩班改在填寫介面填）。'
          + '自動流程不會替你更新，這次一格都沒有寫。請在填寫介面打開這一季任何一個主日，'
          + '按內容表狀態列的「更新本季內容表…」，先看會做甚麼再確定。'
      };
    }
  }

  if (!spreadsheet) {
    var fileName = buildContentSheetFileName_(config.namePattern, qid)
      + String(buildOptions.fileNameSuffix || '');
    var createdFile = createContentSpreadsheet_(fileName, config.folderId, config.domain);
    spreadsheet = createdFile.spreadsheet;
    fileId = createdFile.fileId;
    fileUrl = createdFile.fileUrl;
    sharingApplied = createdFile.sharingApplied;
    sharingError = createdFile.sharingError;
    created = true;
    // v3：新建時 v3 計畫只會有「停用舊覆寫」（以前在介面改過的值已經在週報）。
    // v4：「崇拜程序」「崇拜人數」一個日期一行，由 v4 整理預先開好（不再經 v2 planner）。
    var createdInputs = readContentSheetV2Inputs_(spreadsheet);
    upgradePlan = planContentSheetV3Upgrade_(Object.assign({}, createdInputs, { serviceDates: serviceDates }));
  }

  // ---- v3：浸禮六欄搬入週報、刪欄、停用舊覆寫（崇拜程序第 2 行之前）----
  var upgradeResult = null;
  if (contentSheetV3PlanHasWrites_(upgradePlan)) {
    var upgradeWorshipSheet = spreadsheet.getSheetByName(contentSheetWorshipTabDefV3_().tabName);
    upgradeResult = applyContentSheetV3Upgrade_(spreadsheet, runLegacy ? upgradeWorshipSheet : null, upgradePlan, qid);
    if (runLegacy) {
      // 刪欄、寫格之後按真正的樣子重新算一次（v2 的模擬與真正做完之後讀到的應該一樣，重算是保險）。
      migrationPlan = planContentSheetV2Migration_(Object.assign(readContentSheetV2Inputs_(spreadsheet),
        { serviceDates: serviceDates, created: false }));
      if (v4Detect.layout === 'V3') dropV3AppendsBeforeV4_(migrationPlan);
      if (!migrationPlan.ok) {
        return { ok: false, created: created, quarterId: qid, reason: migrationPlan.reason, message: migrationPlan.message };
      }
    }
  }

  // ---- 分頁：補齊 ＋ 套版面 ----
  var dateOptions = serviceDates.slice();
  var attendanceDateOptions = contentSheetAttendanceDateOptions_(serviceDates);
  var tabsCreated = [];
  var layoutOptions = {
    dateOptions: dateOptions,
    attendanceDateOptions: attendanceDateOptions,
    owners: config.owners,
    deadlineNote: config.deadlineNote
  };

  var instructionsTab = ensureContentTab_(spreadsheet, CONTENT_SHEET_INSTRUCTIONS_TAB_);
  if (instructionsTab.created) tabsCreated.push(CONTENT_SHEET_INSTRUCTIONS_TAB_);

  // ⚠️⚠️ 內容表 v2：舊的「崇拜程序」先移轉（補欄、回填、新增行、舊分頁改名），之後才套 v3 版面——
  //    applyContentTabLayout_() 寫第 1、2 行是提交點，一定要排最後（見 src/ContentSheetMigrate.gs）。
  var worshipTabName = contentSheetWorshipTabDef_().tabName;
  if (runLegacy) {
    var legacyWorship = ensureContentTab_(spreadsheet, worshipTabName).sheet;
    if (contentSheetPlanHasWrites_(migrationPlan)) {
      applyContentSheetV2Migration_(spreadsheet, legacyWorship, migrationPlan, qid);
    }
    applyContentTabLayout_(legacyWorship, contentSheetWorshipTabDefV3_(), layoutOptions);
  }

  // ---- v4：崇拜程序只留三欄、一個日期一行；崇拜人數一個日期一行；家事報告、代禱事項搬欄 ----
  //    v1／v2 這時已經是 v3，按真正的樣子重新算（預覽講的是 v3 → v4 的概要）。
  var v4Plan = planContentSheetV4_(Object.assign(readContentSheetV4Inputs_(spreadsheet), {
    serviceDates: serviceDates, created: created
  }));
  var v4Result = contentSheetV4PlanHasWrites_(v4Plan)
    ? applyContentSheetV4_(spreadsheet, v4Plan, qid, layoutOptions) : null;

  var sampleRows = (created && config.seedSample) ? buildContentSheetSampleRows_(serviceDates) : {};
  var seededSample = false;

  contentSheetTabDefs_().forEach(function (tabDef) {
    var ensured = ensureContentTab_(spreadsheet, tabDef.tabName);
    if (ensured.created) tabsCreated.push(tabDef.tabName);

    applyContentTabLayout_(ensured.sheet, tabDef, layoutOptions);

    // 樣本**淨係喺新建立嗰陣**寫，而且只寫落一張全新嘅分頁——刷新現有
    // 內容表時一行都唔會加，否則每次刷新都會多幾行重複樣本。
    // v4：一個日期一行的分頁（崇拜程序、崇拜人數）已經預先開好，不寫樣本。
    var rows = sampleRows[tabDef.tabName];
    if (created && tabDef.oneRowPerDate !== true && rows && rows.length > 0
      && ensured.sheet.getLastRow() < CONTENT_SHEET_FIRST_DATA_ROW_) {
      writeContentRows_(ensured.sheet, tabDef.keys, rows, CONTENT_SHEET_FIRST_DATA_ROW_);
      seededSample = true;
    }

    // v4：一個日期一行的分頁每次都重新鎖一次（行數可能變了）。
    if (tabDef.oneRowPerDate === true) {
      var dataRows = Math.max(0, ensured.sheet.getLastRow() - CONTENT_SHEET_FIRST_DATA_ROW_ + 1);
      ensureContentTabDateLock_(ensured.sheet, tabDef.keys.length, dataRows);
    }
  });

  // v4：家事報告、代禱事項、財政報告按主日日期、次序排好（每日清晨亦排一次）。
  var sortedTabs = sortContentListTabs_(spreadsheet);

  applyContentInstructionsTab_(instructionsTab.sheet, buildContentSheetInstructionLines_({
    quarterId: qid,
    serviceDates: serviceDates,
    owners: config.owners,
    deadlineNote: config.deadlineNote,
    adminContact: config.adminContact,
    seededSample: seededSample,
    // 內容表 v2：已停用（已改名）的舊分頁，_說明 講明不要再填。
    retiredTabs: listRetiredContentTabNames_(spreadsheet),
    // 2026-10-30：自動同步的間隔（Config 不是允許的值就當沒有，與觸發器安裝一致）。
    autoSyncMinutes: parseContentAutoSyncMinutes_(getConfig(CONFIG_KEYS.CONTENT_AUTO_SYNC_MINUTES, '30')).minutes
  }));

  // ---- R-030：夏令時間轉換提示 ----
  var dstResult = applyDaylightSavingRows_(spreadsheet, serviceDates);

  arrangeContentTabs_(spreadsheet, contentSheetTabNames_());
  // v3：填寫介面的內容表狀態列（「更新本季內容表…」）讀的是快取，建立／刷新之後即時清走。
  forgetContentSheetSchemaStatus_(fileId);

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
    daylightSaving: dstResult,
    serviceDateCount: serviceDates.length,
    seededSample: seededSample,
    sharingApplied: sharingApplied,
    sharingError: sharingError,
    migration: migrationPlan,
    // v3：浸禮六欄搬入週報、刪欄、停用舊覆寫的計畫與結果（沒有就是 null）。
    upgrade: upgradePlan,
    upgradeResult: upgradeResult,
    // v4（2026-10-30）：新版面的計畫與結果；排好的分頁。
    v4: v4Plan,
    v4Result: v4Result,
    sortedTabs: sortedTabs
  };
}

/**
 * 用途：「已登記但開不到」的內容表的說明（建立／刷新與預覽共用一句）。純函式。
 * Args:
 *   quarterId {string} 季度 ID。
 *   fileId {string} ContentSheets 登記的檔案 ID（只顯示開頭幾個字）。
 * Returns:
 *   {string}
 * Raises:
 *   （無）
 */
function contentSheetFileMissingMessage_(quarterId, fileId) {
  return 'ContentSheets 已登記季度「' + quarterId + '」的內容表（檔案 ID 開頭 '
    + maskContentFileId_(fileId) + '），但現在無法開啟——可能已被刪除、'
    + '移到沒有權限的位置，或者 ID 不正確。請人手確認該檔案，或將 ContentSheets '
    + '該一行的「有效」改為 FALSE，然後再按一次建立。';
}

/**
 * 用途：把夏令時間轉換提示寫入內容表的「家事報告」（R-030）。
 *
 *   ⚠️ **只覆寫系統自己加而且未被人手改過的行。** 三條規則見
 *   `planDaylightSavingRows_()`。人手改過內容、或者把「有效」設成
 *   `FALSE`，之後永遠不會再被覆寫——那是幹事說「我不要這一則」。
 * Args:
 *   spreadsheet {Spreadsheet} 內容表。
 *   serviceDates {string[]} 該季主日。
 * Returns:
 *   {{enabled:boolean, added:number, updated:number, untouched:number,
 *     notices:string[], message:string}}
 */
function applyDaylightSavingRows_(spreadsheet, serviceDates) {
  var config = daylightSavingConfig_();
  var out = { enabled: config.autoInsert, added: 0, updated: 0, untouched: 0, notices: [], message: '' };

  if (!config.autoInsert) {
    out.message = 'Config 的 ' + CONFIG_KEYS.DST_AUTO_INSERT + ' 是 FALSE，沒有自動加。';
    return out;
  }

  var wanted = buildDaylightSavingRows_(serviceDates, config);
  out.notices = wanted.map(function (row) { return row.SERVICE_DATE; });
  if (wanted.length === 0) {
    out.message = '這一季沒有夏令時間轉換的前一個主日，沒有加任何一行。';
    return out;
  }

  var tabDef = null;
  contentSheetTabDefs_().forEach(function (def) {
    if (def.tabName === '家事報告') tabDef = def;
  });
  if (!tabDef) {
    out.message = '找不到「家事報告」分頁的定義，沒有加任何一行。';
    return out;
  }

  var sheet = spreadsheet.getSheetByName(tabDef.tabName);
  if (!sheet) {
    out.message = '內容表沒有「家事報告」分頁，沒有加任何一行。';
    return out;
  }

  var existing = readContentTabRowsWithRowNo_(sheet, tabDef.keys);
  var plan = planDaylightSavingRows_(existing, wanted);

  plan.updates.forEach(function (update) {
    tabDef.keys.forEach(function (key, index) {
      if (update.row[key] === undefined) return;
      var cell = sheet.getRange(update.rowNo, index + 1, 1, 1);
      cell.setNumberFormat('@');
      cell.setValue(sanitizeCellText_(update.row[key]));
    });
    out.updated++;
  });

  if (plan.appends.length > 0) {
    var startRow = Math.max(sheet.getLastRow() + 1, CONTENT_SHEET_FIRST_DATA_ROW_);
    writeContentRows_(sheet, tabDef.keys, plan.appends, startRow);
    out.added = plan.appends.length;
  }
  out.untouched = plan.untouched.length;

  out.message = '夏令時間提示：新增 ' + out.added + ' 行、更新 ' + out.updated
    + ' 行、' + out.untouched + ' 行因為已經被人手改過而不動。';
  return out;
}

/**
 * 用途：讀出內容表某一張分頁由第 3 行開始的資料列，**帶實際行號**。
 *
 *   ⚠️ 帶行號是為了「只改那一行那幾格」——整批重寫會蓋走人手在其他行
 *   輸入的東西。
 * Args:
 *   sheet {Sheet} 內容表的一張分頁。
 *   keys {string[]} 該分頁的機器鍵。
 * Returns:
 *   {Object[]} 每個元素以機器鍵為 key，另加 `__rowNo`。整行空白的略過。
 */
function readContentTabRowsWithRowNo_(sheet, keys) {
  var lastRow = sheet.getLastRow();
  if (lastRow < CONTENT_SHEET_FIRST_DATA_ROW_) return [];

  var numRows = lastRow - CONTENT_SHEET_FIRST_DATA_ROW_ + 1;

  // ⚠️ 欄數要夾住分頁實際有幾多欄。R-030 在最尾加了兩欄，而 getRange()
  //    一旦超出實際欄數就直接拋例外——舊的內容表如果因為任何理由未套到
  //    新版面，整個「建立本季內容表」會爆掉，而不是少讀兩欄。
  var numCols = Math.min(keys.length, sheet.getMaxColumns());
  var values = sheet.getRange(CONTENT_SHEET_FIRST_DATA_ROW_, 1, numRows, numCols).getValues();

  var out = [];
  values.forEach(function (rowValues, index) {
    var allBlank = rowValues.every(function (v) {
      return v === '' || v === null || v === undefined;
    });
    if (allBlank) return;

    var row = { __rowNo: CONTENT_SHEET_FIRST_DATA_ROW_ + index };
    keys.forEach(function (key, i) { row[key] = (i < rowValues.length) ? rowValues[i] : ''; });
    out.push(row);
  });
  return out;
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

  // 主日清單只係信入面嘅參考資料，取唔到唔應該令封信寄唔出，所以
  // 呢度唔理 source 係邊個——但一定要經共用嗰支拿。
  var serviceDates = [];
  try {
    serviceDates = resolveQuarterServiceDateEntries_(qid).dates.slice();
  } catch (err) {
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
  var failed = [];
  recipientsResult.recipients.forEach(function (recipient) {
    var status = 'CONTENT_SHEET_INVITE';
    var errorMessage = '';

    if (!dryRun) {
      try {
        MailApp.sendEmail({ to: recipient.email, subject: subject, body: plainBody, htmlBody: htmlBody });
      } catch (mailErr) {
        status = 'FAILED';
        errorMessage = (mailErr && mailErr.message) ? mailErr.message : String(mailErr);
        failed.push(errorMessage);
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

  writeSendLogRows_(sendLogRows);

  // v3 重測（獨立審查）：全部寄不出就不可以講成功，亦不記「已寄出」。
  if (!dryRun && failed.length === recipientsResult.recipients.length) {
    return {
      sent: false, dryRun: dryRun, recipientCount: 0, reason: 'SEND_FAILED',
      message: '全部 ' + failed.length + ' 個收件人都寄不出（第一個錯誤：' + failed[0] + '），詳情見 SendLog。'
    };
  }
  updateContentSheetField_(qid, 'INVITE_SENT_AT', new Date());
  // v3 重測（獨立審查）：真的寄出（不論經選單、季度作業還是星期一自動流程）都記指紋，星期一自動流程
  //    才不會再寄一次。以前只有自動流程記，人手寄過的季度到了提前期仍然會再收到一封。
  if (!dryRun) recordContentSheetInviteFingerprint_(qid, contentSheetInviteFingerprint_(qid));

  return { sent: true, dryRun: dryRun, recipientCount: recipientsResult.recipients.length - failed.length,
    failedCount: failed.length };
}

/**
 * 用途：「已經寄過某一季內容表邀請」的指紋（`ConflictNoticeLog`）。一處定義。
 * Args:
 *   quarterId {string} 季度 ID。
 * Returns:
 *   {string}
 */
function contentSheetInviteFingerprint_(quarterId) {
  return 'CONTENT_SHEET_INVITE|' + String(quarterId || '').trim();
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
  // v3 重測（獨立審查）：已封存的季度與自測沙盒季度不理——以前已封存的季度內容表那一行是 ACTIVE=FALSE，
  //    buildOrRefreshContentSheet_() 找不到就每星期一另建一份新的。
  var quarterIds = {};
  var archivedQuarter = {};
  readSheet(SHEETS.BULLETIN_WEEKS).forEach(function (r) {
    var qid = String(r.QUARTER_ID || '').trim();
    if (!qid) return;
    quarterIds[qid] = true;
    if (r.ARCHIVED === true) archivedQuarter[qid] = true;
  });
  var selfTestQuarterId = String(getConfig(CONFIG_KEYS.SELFTEST_QUARTER_ID, '') || '').trim();

  Object.keys(quarterIds).sort().forEach(function (qid) {
    var fingerprint = contentSheetInviteFingerprint_(qid);
    if (notified[fingerprint]) { result.skipped.push(qid); return; }
    if (archivedQuarter[qid] || (selfTestQuarterId && qid === selfTestQuarterId)) { result.skipped.push(qid); return; }

    var serviceDates;
    try {
      serviceDates = resolveQuarterServiceDateEntries_(qid).dates.slice();
    } catch (err) {
      result.skipped.push(qid);
      return;
    }
    if (serviceDates.length === 0) { result.skipped.push(qid); return; }
    // v3 重測（獨立審查）：已經完結的季度（最後一個主日已過）不再建立內容表、不再寄邀請。
    var lastIso = serviceDates.reduce(function (a, b) { return String(b) > a ? String(b) : a; }, '');
    if (lastIso && lastIso < todayIso) { result.skipped.push(qid); return; }
    if (!isWithinContentSheetLeadWindow_(todayIso, serviceDates[0], config.leadDays)) {
      result.skipped.push(qid);
      return;
    }

    var built = buildOrRefreshContentSheet_(qid);
    if (!built.ok) {
      // 內容表 v2：舊版內容表要人手移轉（先看預覽），自動流程略過並留一筆紀錄（照 RETENTION_NEEDS_CONFIRMATION 的先例）。
      //    審查 A6：新欄位置原本有字（NEW_COLUMNS_NOT_EMPTY）同樣是「要人手處理才可以移轉」。
      if (built.reason === 'NEEDS_MIGRATION' || built.reason === 'NEW_COLUMNS_NOT_EMPTY') {
        appendErrorLog_({
          source: ERROR_LOG_SOURCE.TRIGGER, functionName: 'autoCreateContentSheetsForUpcomingQuarters_',
          errorCode: 'CONTENT_SHEET_NEEDS_MIGRATION', message: built.message
        });
      }
      result.skipped.push(qid);
      return;
    }
    if (built.created) result.created.push(qid);

    var invite = sendContentSheetInvite_(qid);
    if (!invite.sent) { result.skipped.push(qid); return; }
    result.invited.push(qid);
    // 指紋由 sendContentSheetInvite_() 真的寄出時記下（人手寄出亦一樣），這裏不再記一次。
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
 * 用途：選單項目「建立本季內容表」嘅處理函式。內容表 v2 起先顯示預覽（`previewContentSheetBuild_()`），
 *   撳「是」才建立／刷新（舊版內容表會移轉）。
 * Args: （無）
 * Returns:
 *   {void}
 * Raises:
 *   （無）失敗時寫 `ErrorLog` 並用對話框顯示。
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

    // 內容表 v2：撳之前先講會做甚麼（建立還是刷新、會不會移轉、移轉會搬甚麼），與填寫介面
    //    「季度作業」同一份預覽（事故四十七：撳之前要講）。
    var preview = previewContentSheetBuild_(quarterId);
    if (!preview.ok) {
      ui.alert('未能建立內容表', preview.message, ui.ButtonSet.OK);
      return;
    }
    var confirmed = ui.alert('建立／刷新本季內容表', preview.lines.join('\n') + '\n\n確定要繼續嗎？', ui.ButtonSet.YES_NO);
    if (confirmed !== ui.Button.YES) {
      ui.alert('已取消', '一格都沒有寫。', ui.ButtonSet.OK);
      return;
    }

    var result = buildOrRefreshContentSheet_(quarterId, { migrate: true });
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
    lines.push((contentSheetV3PlanHasWrites_(result.upgrade) || contentSheetV4PlanHasWrites_(result.v4))
      ? '已更新，未重建——既有的內容表不會重做；除了下面列出的各項，人手輸入的資料一格都沒有改動。'
      : '已更新，未重建——既有的內容表不會重做，人手輸入的資料一格都沒有改動。');
    lines.push('已刷新：欄位、下拉選單（本季 ' + result.serviceDateCount + ' 個主日）、版面。');
    if (result.tabsCreated.length > 0) {
      lines.push('已補回缺少的分頁：' + result.tabsCreated.join('、'));
    }
  }

  // v3：浸禮六欄搬入週報、刪欄、停用舊覆寫。
  var upgradeLines = buildContentSheetV3UpgradeLines_(result.upgrade, { applied: true });
  if (upgradeLines.length > 0) {
    lines.push('');
    upgradeLines.forEach(function (line) { lines.push(line); });
  }

  // ⚠️ 內容表 v2：移轉（或新建時預先開好的行）寫了甚麼一定要講出來。幹事見到崇拜程序多了
  //    內容，會以為是同工已經填過。
  var migrationLines = buildContentSheetMigrationLines_(result.migration, { applied: true, created: result.created });
  if (migrationLines.length > 0) {
    lines.push('');
    migrationLines.forEach(function (line) { lines.push(line); });
  }

  // v4（2026-10-30）：新版面整理與排序。
  var v4Lines = buildContentSheetV4Lines_(result.v4, { applied: true });
  if (v4Lines.length > 0) {
    lines.push('');
    v4Lines.forEach(function (line) { lines.push(line); });
  }
  if ((result.sortedTabs || []).length > 0) {
    lines.push('已按主日日期、次序排好：' + result.sortedTabs.join('、') + '。');
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
