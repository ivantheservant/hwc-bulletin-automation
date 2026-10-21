/**
 * Authorize.gs
 *
 * 第二批測試修正 G1：一次過要求 `appsscript.json` 列出的全部授權範圍。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ⚠️ 為什麼「在編輯器隨便執行一個函式」不再出授權畫面
 * ─────────────────────────────────────────────────────────────────────
 *
 *   Google 現在是逐項授權：在 Apps Script 編輯器執行一個函式，只會為那個
 *   函式執行時真正用到、而又未授權的範圍出授權畫面。`onOpen` 用不到表單，
 *   執行它不會要求 forms 範圍，所以 2028T2 測試照舊指引執行 `onOpen` 之後，
 *   「檢查授權範圍」仍然報 `FormApp（講員表格）` 未授權。
 *
 *   `ScriptApp.requireAllScopes(ScriptApp.AuthMode.FULL)` 會檢查
 *   `appsscript.json` 的 `oauthScopes` 全部範圍，任何一項未授權就即刻要求
 *   授權（在編輯器出「Authorization required」；在選單出授權對話框）。
 *   本檔案的兩個入口都只做這一句，並共用 `requireAllScriptScopes_()`，
 *   不各寫一份。
 *
 * ⚠️ `authorizeAllScopes()` 名稱不可以用底線結尾：Apps Script 編輯器的函式
 *   下拉選單不顯示底線結尾的（私有）函式，幹事會找不到。
 *
 * ⚠️ 本檔案頂層只有字串常數，不引用其他檔案的識別碼（載入次序，見
 *   docs/已知bug類型.md 事故一）。
 */

'use strict';

/**
 * 選單項目「重新授權」的名稱。選單（`onOpen()`）與授權錯誤的指引
 * （`enrichAuthError_()`）共用這一個字串，名稱一改兩處一齊改，不會一處
 * 寫舊名、一處寫新名。
 */
var AUTHORIZE_MENU_LABEL_ = '重新授權（新增權限之後用）';

/** 在 Apps Script 編輯器函式下拉要揀的函式名稱（給指引文字用）。 */
var AUTHORIZE_FUNCTION_NAME_ = 'authorizeAllScopes';

/**
 * 用途：要求 `appsscript.json` 列出的全部授權範圍；任何一項未授權，
 *   Apps Script 會即刻要求使用者授權。編輯器入口與選單入口共用這一支。
 * Args: （無）
 * Returns:
 *   {void}
 * Raises:
 *   Error 未授權而使用者未完成授權時，`ScriptApp.requireAllScopes()` 拋出的
 *     例外原樣往外拋，不會吞掉（呼叫方要讓使用者看到失敗）。
 */
function requireAllScriptScopes_() {
  ScriptApp.requireAllScopes(ScriptApp.AuthMode.FULL);
}

/**
 * 用途：給 Apps Script 編輯器用的公開入口——在函式下拉揀 `authorizeAllScopes`
 *   再按執行，就會為全部未授權的範圍出授權畫面。完成之後在執行記錄寫一句
 *   「全部授權範圍已核准。」。
 *
 *   ⚠️ 不要在這裏加任何其他動作（例如寫工作表、開對話框）：編輯器入口沒有
 *   `SpreadsheetApp.getUi()`，而且這個函式的用途只有授權一件事。
 * Args: （無）
 * Returns:
 *   {void}
 * Raises:
 *   Error 授權未完成時，`requireAllScriptScopes_()` 的例外原樣往外拋，
 *     編輯器的執行記錄會顯示失敗。
 */
function authorizeAllScopes() {
  requireAllScriptScopes_();
  Logger.log('全部授權範圍已核准。');
}

/**
 * 用途：選單項目「週報系統 ▸ 重新授權（新增權限之後用）」的處理函式。
 *   呼叫同一支 `requireAllScriptScopes_()`；成功之後提示使用者再按
 *   「檢查授權範圍」確認。失敗時照選單慣例寫一筆 `ErrorLog`
 *   （`logMenuError_()`），再用對話框顯示原因與授權指引。
 * Args: （無）
 * Returns:
 *   {void}
 * Raises:
 *   （無）失敗時寫 `ErrorLog` 並用對話框顯示，不往外拋。
 */
function menuAuthorizeAllScopes_() {
  var ui = SpreadsheetApp.getUi();
  try {
    requireAllScriptScopes_();
    ui.alert('重新授權', '全部授權範圍已核准。請再按「檢查授權範圍」確認。', ui.ButtonSet.OK);
  } catch (err) {
    logMenuError_('menuAuthorizeAllScopes_', err);
    ui.alert('重新授權失敗', enrichAuthError_(err), ui.ButtonSet.OK);
  }
}
