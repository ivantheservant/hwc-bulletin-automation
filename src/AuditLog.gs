/**
 * AuditLog.gs
 *
 * AuditLog 工作表的逐格記錄慣例：任何一次對試算表的寫入異動，都應該呼叫
 * appendAuditLog_() 留一筆記錄。只會新增、不會刪除或覆寫既有記錄。
 */

'use strict';

/**
 * 用途：在 AuditLog 工作表附加一筆稽核記錄。
 * Args:
 *   entry {{actor:(string|undefined), action:string, sheetName:(string|undefined),
 *     rowKey:(string|undefined), field:(string|undefined), oldValue:(string|undefined),
 *     newValue:(string|undefined), notes:(string|undefined)}} 記錄內容；除
 *     action 外全部選填，缺少的一律寫成空字串。actor 缺少時會嘗試用
 *     Session.getActiveUser().getEmail()，仍然拿不到就寫「（未知使用者）」。
 * Returns:
 *   {void}
 * Raises:
 *   Error 如果 entry 缺漏或 entry.action 是空字串——沒有動作名稱的稽核記錄
 *     沒有意義，不可以靜靜寫一筆空白記錄。
 */
function appendAuditLog_(entry) {
  if (!entry || !entry.action) {
    throw new Error('appendAuditLog_：entry.action 是必填欄位。');
  }

  var actor = entry.actor;
  if (!actor) {
    try {
      actor = Session.getActiveUser().getEmail() || '（未知使用者）';
    } catch (e) {
      // Session.getActiveUser() 在部分執行環境（例如非同網域的觸發器）
      // 可能沒有權限回傳電郵，這不應該阻擋稽核記錄本身被寫入。
      actor = '（未知使用者）';
    }
  }

  writeSheet(SHEETS.AUDIT_LOG, [{
    TIMESTAMP: new Date(),
    ACTOR: actor,
    ACTION: entry.action,
    SHEET_NAME: entry.sheetName || '',
    ROW_KEY: entry.rowKey || '',
    FIELD: entry.field || '',
    OLD_VALUE: entry.oldValue || '',
    NEW_VALUE: entry.newValue || '',
    NOTES: entry.notes || ''
  }]);
}
