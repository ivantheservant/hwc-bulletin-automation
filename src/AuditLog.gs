/**
 * AuditLog.gs
 *
 * AuditLog 工作表的逐格記錄慣例：任何一次對試算表的寫入異動，都應該呼叫
 * appendAuditLog_() 留一筆記錄。只會新增、不會刪除或覆寫既有記錄。
 *
 * ⚠️ 全部欄位一律經 SheetUtils.gs 的 sanitizeCellText_() 才寫入——
 * OLD_VALUE／NEW_VALUE 這類值可能直接來自使用者填在 BulletinWeeks 等
 * 工作表的內容，如果剛好以 =／+／-／@ 開頭，setValues() 會被 Sheets
 * 當成公式求值，見 docs/已知bug類型.md 事故六。
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
  assertAuditLogEntry_(entry);
  writeSheet_(SHEETS.AUDIT_LOG, [buildAuditLogRow_(entry, resolveAuditLogActor_(entry), new Date())]);
}

/**
 * 用途：R-060（2026-11-17）：一次附加多筆稽核記錄，只呼叫**一次** `writeSheet_()`。
 *
 *   欄位處理與 `appendAuditLog_()` 完全相同——兩邊共用 `buildAuditLogRow_()`，不另寫一份；
 *   分別只在：`Session.getActiveUser()` 整批只取一次（`resolveAuditLogActor_()` 只在有一筆沒有 actor 時才問，
 *   而且只問一次），`TIMESTAMP` 整批同一個時刻。行的先後次序就是 `entries` 的次序。
 *   以前整季匯入每格一筆、逐筆寫入，13 週要寫幾百次 AuditLog；現在是一次。
 * Args:
 *   entries {Object[]} 每一項同 `appendAuditLog_()` 的 `entry`。空陣列或者沒有提供，什麼都不做。
 * Returns:
 *   {number} 寫入的行數。
 * Raises:
 *   Error 如果其中任何一項缺漏或者沒有 action——**先全部核對，一筆都沒有寫**才拋出
 *     （逐筆寫的舊做法會寫了前面幾筆才拋錯）。
 */
function appendAuditLogBatch_(entries) {
  if (!entries || entries.length === 0) return 0;
  entries.forEach(assertAuditLogEntry_);

  var now = new Date();
  var sessionActor = null;
  var rows = entries.map(function (entry) {
    var actor = entry.actor;
    if (!actor) {
      if (sessionActor === null) sessionActor = resolveAuditLogActor_(entry);
      actor = sessionActor;
    }
    return buildAuditLogRow_(entry, actor, now);
  });
  return writeSheet_(SHEETS.AUDIT_LOG, rows);
}

/**
 * 用途：核對一筆稽核記錄一定有 `action`。`appendAuditLog_()` 與 `appendAuditLogBatch_()` 共用。
 * Args:
 *   entry {Object}
 * Returns:
 *   {void}
 * Raises:
 *   Error 同 `appendAuditLog_()`。
 */
function assertAuditLogEntry_(entry) {
  if (!entry || !entry.action) {
    throw new Error('appendAuditLog_：entry.action 是必填欄位。');
  }
}

/**
 * 用途：決定一筆稽核記錄的 actor：entry 自己有就用它，否則用目前使用者的電郵，拿不到寫「（未知用戶）」。
 * Args:
 *   entry {Object}
 * Returns:
 *   {string}
 */
function resolveAuditLogActor_(entry) {
  var actor = entry.actor;
  if (!actor) {
    try {
      actor = Session.getActiveUser().getEmail() || '（未知用戶）';
    } catch (e) {
      // Session.getActiveUser() 在部分執行環境（例如非同網域的觸發器）
      // 可能沒有權限回傳電郵，這不應該阻擋稽核記錄本身被寫入。
      actor = '（未知用戶）';
    }
  }
  return actor;
}

/**
 * 用途：把一筆稽核記錄轉成 AuditLog 的一行（以機器鍵為 key 的物件）。`appendAuditLog_()` 與
 *   `appendAuditLogBatch_()` **共用這一支**，欄位處理不可以在兩處各寫一次。全部欄位經 `sanitizeCellText_()`。
 * Args:
 *   entry {Object} 同 `appendAuditLog_()` 的 `entry`。
 *   actor {string} 已決定好的 actor。
 *   now {Date} 時間戳。
 * Returns:
 *   {Object}
 */
function buildAuditLogRow_(entry, actor, now) {
  return {
    TIMESTAMP: now,
    ACTOR: sanitizeCellText_(actor),
    ACTION: sanitizeCellText_(entry.action),
    SHEET_NAME: sanitizeCellText_(entry.sheetName || ''),
    ROW_KEY: sanitizeCellText_(entry.rowKey || ''),
    FIELD: sanitizeCellText_(entry.field || ''),
    OLD_VALUE: sanitizeCellText_(entry.oldValue || ''),
    NEW_VALUE: sanitizeCellText_(entry.newValue || ''),
    NOTES: sanitizeCellText_(entry.notes || '')
  };
}
