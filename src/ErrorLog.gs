/**
 * ErrorLog.gs
 *
 * `ErrorLog` 工作表的記錄慣例：伺服器端（`WebApp.gs` 的 `withApiResult_()`）、
 * 前端（`apiLogClientError()`）、選單（各個 `menuXxx_()` 的 catch 分支）
 * 三種來源的例外，統一經 `appendErrorLog_()` 寫成一筆記錄——把「看不見
 * 發生什麼」本身當成 bug 來修（見 docs/已知bug類型.md 事故七）。
 *
 * 只會新增、不會刪除或覆寫。`DETAIL` 欄**不可以**存電郵或完整的個人
 * 資料，只存堆疊的頭幾行與呼叫方自己組的參數摘要（例如 `isoDate=...`）。
 *
 * ⚠️ 寫入 `ErrorLog` 本身如果失敗（例如工作表還沒初始化），**不可以讓
 * 原本要回報的錯誤被蓋掉**——`appendErrorLog_()` 因此把全部內容包在
 * try/catch 內，永不拋錯，只回傳成功與否。
 */

'use strict';

/**
 * 用途：在 `ErrorLog` 工作表附加一筆記錄。永不拋錯——寫入失敗只回傳
 *   `false`，讓呼叫方（通常是另一個 catch 分支）原本要回報的錯誤照樣
 *   往下走，不會被這裡的例外蓋掉。
 * Args:
 *   entry {{actor:(string|undefined), source:string, functionName:(string|undefined),
 *     errorCode:(string|undefined), message:(string|undefined), detail:(string|undefined)}}
 *     `source` 應該是 `ERROR_LOG_SOURCE` 其中一個值（`SERVER`／`CLIENT`／
 *     `MENU`），是唯一必填欄位；`actor` 缺少時嘗試用
 *     `Session.getActiveUser().getEmail()`，仍然拿不到就寫「（未知使用者）」。
 *     `detail` 只准放堆疊頭幾行與非個資的參數摘要，不可以放電郵或完整
 *     個人資料。
 * Returns:
 *   {boolean} 是否成功寫入；失敗（含 `entry` 缺漏、`source` 是空字串、
 *     工作表不存在等任何原因）一律回 `false`，不拋錯。
 */
function appendErrorLog_(entry) {
  try {
    if (!entry || !entry.source) return false;

    var actor = entry.actor;
    if (!actor) {
      try {
        actor = Session.getActiveUser().getEmail() || '（未知使用者）';
      } catch (e) {
        actor = '（未知使用者）';
      }
    }

    writeSheet(SHEETS.ERROR_LOG, [{
      TIMESTAMP: new Date(),
      ACTOR: sanitizeCellText_(actor),
      SOURCE: sanitizeCellText_(entry.source),
      FUNCTION_NAME: sanitizeCellText_(entry.functionName || ''),
      ERROR_CODE: sanitizeCellText_(entry.errorCode || ''),
      MESSAGE: sanitizeCellText_(entry.message || ''),
      DETAIL: sanitizeCellText_(entry.detail || '')
    }]);
    return true;
  } catch (err) {
    // 寫 ErrorLog 本身失敗（例如工作表還沒初始化）：吞掉，不可以讓
    // 呼叫方原本要回報的錯誤被這裡的例外蓋掉。
    return false;
  }
}

/**
 * 用途：組出寫進 `ErrorLog.DETAIL` 的內容——堆疊的頭幾行（最多 5 行）
 *   接上呼叫方提供的參數摘要（如果有）。**不會**自動從 `err` 或呼叫參數
 *   擷取任何東西以外的資料，避免不小心夾帶電郵或個人資料：參數摘要
 *   一律由呼叫方明確組好、明確傳入。
 * Args:
 *   err {*} 被攔到的例外物件（或任意值）。
 *   context {{argsSummary:(string|undefined)}=} 選填，`argsSummary` 是
 *     呼叫方自己組的、不含個資的參數摘要文字（例如 `'isoDate=2027-10-03'`）。
 * Returns:
 *   {string}
 */
function buildErrorDetail_(err, context) {
  var parts = [];
  var stack = (err && err.stack) ? String(err.stack) : '';
  if (stack) {
    parts.push(stack.split('\n').slice(0, 5).join('\n'));
  }
  if (context && context.argsSummary) {
    parts.push('參數：' + context.argsSummary);
  }
  return parts.join('\n');
}

/**
 * 用途：選單 `menuXxx_()` 的 catch 分支專用的小工具——把一次選單執行的
 *   例外寫成一筆 `ErrorLog`（`SOURCE='MENU'`），呼叫方仍然要自己接著
 *   顯示 `ui.alert()`。
 * Args:
 *   functionName {string} 出錯的選單處理函式名稱（例如
 *     `'menuInitializeAllSheets_'`）。
 *   err {*} 被攔到的例外物件。
 * Returns:
 *   {void}
 */
function logMenuError_(functionName, err) {
  appendErrorLog_({
    source: ERROR_LOG_SOURCE.MENU,
    functionName: functionName,
    errorCode: (err && err.code) || 'ERROR',
    message: (err && err.message) ? err.message : String(err),
    detail: buildErrorDetail_(err)
  });
}
