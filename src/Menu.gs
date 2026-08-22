/**
 * Menu.gs
 *
 * 開啟試算表時建立「週報系統」自訂選單。第一輪三個基本項目（初始化工作表、
 * 重新載入設定、關於本系統）之後，第二輪加了兩個職事表唯讀介面的測試項目
 * （處理函式在 RosterDiagnostics.gs），第三輪加了兩個週報資料模型的項目
 * （處理函式在 BulletinDiagnostics.gs），第四輪加了一個開啟填寫介面的項目
 * （處理函式在 WebApp.gs），第四b輪加了一個檢查工作表結構的項目（處理
 * 函式同樣在 WebApp.gs），第五輪加了電郵與自動寄送相關的五個項目（處理
 * 函式在 Mailer.gs／Trigger.gs），第六輪加了一個檢查職事表分歧的項目
 * （處理函式在 RosterDiff.gs），第六b輪加了三個 PersonDisplay／尊稱設定
 * 相關的項目（處理函式在 HonorificSetup.gs），第七輪加了兩個 Word 範本
 * 渲染的項目（處理函式在 BulletinRender.gs），第八輪加了一個「季度填寫表」
 * 子選單（處理函式在 FillMenu.gs）。Apps Script 全部檔案共用一個全域
 * 命名空間，選單引用哪個檔案定義的函式都可以。
 *
 * ⚠️ 第八輪的項目放在**子選單**：主選單已經有 16 個項目，再平鋪下去會
 * 長到看不到底。子選單一律用 `SpreadsheetApp.getUi().createMenu()` 現造，
 * 不可以寫成頂層常數（載入次序，見 docs/已知bug類型.md 事故一）。
 *
 * ⚠️ 每個 `menuXxx_()` 的 catch 分支都要呼叫 `logMenuError_()`
 * （`src/ErrorLog.gs`）寫一筆 `ErrorLog`（`SOURCE='MENU'`），再顯示
 * `ui.alert()`——不能只顯示對話框、不留記錄，見 docs/已知bug類型.md 事故七。
 */

'use strict';

/**
 * 用途：Apps Script 簡易觸發器，開啟試算表時自動執行，建立「週報系統」選單。
 * Args: （無，簡易觸發器固定簽章）
 * Returns:
 *   {void}
 */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu(APP_NAME)
    .addItem('初始化工作表', 'menuInitializeAllSheets_')
    .addItem('重新載入設定（唯讀）', 'menuReloadConfig_')
    .addItem('檢查工作表結構', 'menuCheckSheetSchema_')
    .addItem('關於本系統', 'menuAbout_')
    .addItem('測試讀取職事表', 'menuTestReadRoster_')
    .addItem('測試讀取職事表（全季）', 'menuTestReadRosterQuarter_')
    .addItem('建立本季空白週報', 'menuCreateBlankBulletinWeeks_')
    .addItem('由職事表建立 PersonDisplay 骨架', 'menuBuildPersonDisplaySkeleton_')
    .addItem('套用尊稱對照表', 'menuApplyHonorificLookup_')
    .addItem('尊稱未設定報告', 'menuHonorificMissingReport_')
    .addItem('預覽本週週報資料', 'menuPreviewBulletinModel_')
    .addItem('檢查職事表分歧', 'menuCheckRosterDiff_')
    .addItem('開啟填寫介面', 'menuOpenWebApp_')
    .addItem('產生本週週報（Word）', 'menuGenerateBulletinDocx_')
    .addItem('產生本季全部週報（Word）', 'menuGenerateQuarterBulletinsBatch_')
    .addItem('檢查範本佔位符', 'menuInspectTemplatePlaceholders_')
    .addItem('全季流程演練', 'menuRunQuarterRehearsal_')
    .addItem('完成度自我檢測', 'menuRunSelfCheck_')
    .addItem('本季待填清單', 'menuShowQuarterMissingFieldsList_')
    .addItem('檢查授權範圍', 'menuCheckAuthorizationScopes_')
    .addSeparator()
    .addSubMenu(SpreadsheetApp.getUi().createMenu('內容表')
      .addItem('建立本季內容表', 'menuCreateContentSheet_')
      .addItem('寄出內容表連結', 'menuSendContentSheetInvite_'))
    .addSeparator()
    .addSubMenu(SpreadsheetApp.getUi().createMenu('季度填寫表')
      .addItem('建立／刷新季度填寫表', 'menuCreateOrRefreshFillGrid_')
      .addItem('立即同步季度填寫表', 'menuSyncFillGrid_')
      .addItem('處理填寫表衝突', 'menuResolveFillConflicts_')
      .addItem('檢查格子表外觀', 'menuCheckFillGridAppearance_')
      .addSeparator()
      .addItem('整理清單次序', 'menuResequenceLists_')
      .addItem('由常設時間表產生本季團契', 'menuGenerateFellowships_')
      .addSeparator()
      .addItem('立即備份本季', 'menuBackupQuarter_')
      .addItem('還原到某個備份', 'menuRestoreQuarter_')
      .addSeparator()
      .addItem('寄出季度填寫邀請', 'menuSendFillInvite_')
      .addItem('檢查未建立的季度', 'menuCheckMissingQuarters_')
      .addItem('設定工作表保護', 'menuApplySheetProtection_')
      .addSeparator()
      .addItem('安裝填寫表同步觸發器', 'menuInstallFillEditTrigger_')
      .addItem('移除填寫表同步觸發器', 'menuRemoveFillEditTrigger_')
      .addItem('安裝填寫表對帳觸發器', 'menuInstallFillReconcileTrigger_')
      .addItem('移除填寫表對帳觸發器', 'menuRemoveFillReconcileTrigger_'))
    .addItem('試寄下週週報（依 DRY_RUN 設定）', 'menuTestSendBulletin_')
    .addItem('預覽週報郵件內容', 'menuPreviewBulletinEmail_')
    .addItem('安裝自動寄送觸發器', 'menuInstallSendTrigger_')
    .addItem('移除自動寄送觸發器', 'menuRemoveSendTrigger_')
    .addItem('查看觸發器狀態', 'menuShowTriggerStatus_')
    .addToUi();
}

/**
 * 用途：選單項目「初始化工作表」的處理函式。呼叫 initializeAllSheets()，
 *   用對話框回報結果；失敗時顯示錯誤訊息，不會讓例外靜靜消失。
 * Args: （無）
 * Returns:
 *   {void}
 */
function menuInitializeAllSheets_() {
  var ui = SpreadsheetApp.getUi();
  try {
    var summary = initializeAllSheets();
    var seedRows = summary.seedRowsAdded;
    var lines = [
      '已建立／確認 ' + summary.sheetsEnsured + ' 張工作表。',
      'Config 新增 ' + summary.configKeysAdded + ' 個設定鍵。',
      'PostDisplay 新增 ' + seedRows.POST_DISPLAY + ' 行。',
      'MergeGroups 新增 ' + seedRows.MERGE_GROUPS + ' 行。',
      'ProgramTemplates 新增 ' + seedRows.PROGRAM_TEMPLATES + ' 行。',
      'EmailTemplates 新增 ' + seedRows.EMAIL_TEMPLATES + ' 行。',
      '',
      '詳情見 Diagnostics 工作表。'
    ];
    ui.alert('初始化完成', lines.join('\n'), ui.ButtonSet.OK);
  } catch (err) {
    logMenuError_('menuInitializeAllSheets_', err);
    ui.alert('初始化失敗', enrichAuthError_(err), ui.ButtonSet.OK);
  }
}

/**
 * 用途：選單項目「重新載入設定（唯讀）」的處理函式。清除 Config 快取後
 *   重新讀取，用對話框列出目前全部設定值；空白的值一律顯示「（未設定）」，
 *   不會直接印出空白（避免看起來像是讀取失敗）。這個對話框只讀不寫，
 *   不會修改 Config 工作表任何內容。
 * Args: （無）
 * Returns:
 *   {void}
 */
function menuReloadConfig_() {
  var ui = SpreadsheetApp.getUi();
  try {
    clearConfigCache_();
    var all = loadConfigCache_();
    var keys = Object.keys(all).sort();
    var lines = keys.map(function (k) {
      var v = all[k];
      return k + '：' + (v === '' ? '（未設定）' : v);
    });
    ui.alert('目前設定值（共 ' + keys.length + ' 項）', lines.join('\n'), ui.ButtonSet.OK);
  } catch (err) {
    logMenuError_('menuReloadConfig_', err);
    ui.alert('讀取設定失敗', enrichAuthError_(err), ui.ButtonSet.OK);
  }
}

/**
 * 用途：選單項目「關於本系統」的處理函式，顯示系統名稱、版本與 repo 網址。
 * Args: （無）
 * Returns:
 *   {void}
 */
function menuAbout_() {
  var ui = SpreadsheetApp.getUi();
  var lines = [
    APP_NAME + '　版本 ' + APP_VERSION,
    '',
    'Repo：' + REPO_URL,
    '姊妹專案（粵語堂職事表系統）：' + ROSTER_REPO_URL
  ];
  ui.alert('關於本系統', lines.join('\n'), ui.ButtonSet.OK);
}
