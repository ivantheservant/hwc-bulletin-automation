/**
 * Menu.gs
 *
 * 開啟試算表時建立「週報系統」自訂選單。本輪只有三個項目：初始化工作表、
 * 重新載入設定（唯讀）、關於本系統。
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
    .addItem('關於本系統', 'menuAbout_')
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
    ui.alert('初始化失敗', String(err && err.message ? err.message : err), ui.ButtonSet.OK);
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
    ui.alert('讀取設定失敗', String(err && err.message ? err.message : err), ui.ButtonSet.OK);
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
