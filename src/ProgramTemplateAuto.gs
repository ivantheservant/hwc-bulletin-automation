/**
 * ProgramTemplateAuto.gs
 *
 * 2026-10-27（Ivan 選 B）：程序範本跟每週標題。`BulletinWeeks.PROGRAM_TEMPLATE_ID` 留空＝自動
 * （按職事表 `ServiceDates.Title` 推斷，見 resolveProgramTemplateId_()），有值＝幹事在填寫介面人手
 * 揀過。
 *
 * 舊資料的問題：以前「建立本季空白週報」、「重設這一週」、「補抓」與載入週報都會把**推斷結果**寫進
 * 那一格，於是幾乎每一行都有值——照新規則全部變成「人手揀過」，每週標題再改也不會跟。這個檔案在
 * 「初始化工作表」時做**一次**清理：
 *
 *   - 那一格最後一次改動（AuditLog，`FIELD=PROGRAM_TEMPLATE_ID`）是填寫介面儲存
 *     （`WEBAPP_SAVE_WEEK`），而且新值就是現值 ⇒ 幹事人手揀過，**保留**。
 *   - 其餘（AuditLog 找不到改動、最後一次是系統推斷／建立／重設／還原）⇒ 清空，恢復自動。
 *     每一格寫一筆 AuditLog（舊值記在 OLD_VALUE，要還原可以照抄回去）。
 *
 *   做完寫一筆 `PROGRAM_TEMPLATE_AUTO_MIGRATED`；AuditLog 有這一筆就不再做（只做一次——之後
 *   幹事「還原」舊版本帶回來的範本 ID 算是那個版本的選擇，不應該再被清走）。
 *
 * 分層：`planProgramTemplateAutoMigration_()` 純函式（可在 Node 測試）；
 * `migrateProgramTemplateToAuto_()` 真正入口（讀寫工作表）。
 */

'use strict';

/** AuditLog：清理做完的記號（只做一次）。 */
var PROGRAM_TEMPLATE_AUTO_MIGRATED_ACTION_ = 'PROGRAM_TEMPLATE_AUTO_MIGRATED';

/** AuditLog：清空其中一格。 */
var PROGRAM_TEMPLATE_AUTO_CLEAR_ACTION_ = 'PROGRAM_TEMPLATE_AUTO_CLEAR';

/**
 * 用途：把 AuditLog 的 `ROW_KEY` 轉成可以與主日比對的文字。試算表可能把 yyyy-MM-dd 自動轉成日期，
 *   所以 Date 一律先格式化。純函式。
 * Args:
 *   value {*} `AuditLog.ROW_KEY`。
 * Returns:
 *   {string}
 * Raises:
 *   （無）
 */
function programTemplateAuditRowKey_(value) {
  if (value instanceof Date) return formatIsoDate_(value);
  return String(value === null || value === undefined ? '' : value).trim();
}

/**
 * 用途：算出「初始化工作表」要清空哪幾格 `PROGRAM_TEMPLATE_ID`。純函式。
 * Args:
 *   weekRows {Object[]} `readRowsWithRowNo_(SHEETS.BULLETIN_WEEKS)` 的輸出（每行帶 `__rowNo`；
 *     ⚠️ 不可以用陣列位置推行號——`readSheet()` 會略過整行空白的行，位置與行號會錯開）。
 *   auditRows {Object[]} `readSheet(SHEETS.AUDIT_LOG)` 的輸出（次序＝寫入次序）。
 * Returns:
 *   {{alreadyDone:boolean, clear:{isoDate:string, rowNo:number, oldValue:string, lastAction:string}[],
 *     keep:{isoDate:string, value:string}[]}}
 *     `alreadyDone` 為 true 時兩張清單都是空的。
 * Raises:
 *   （無）
 */
function planProgramTemplateAutoMigration_(weekRows, auditRows) {
  var audits = auditRows || [];
  var done = audits.some(function (a) { return String(a.ACTION || '') === PROGRAM_TEMPLATE_AUTO_MIGRATED_ACTION_; });
  if (done) return { alreadyDone: true, clear: [], keep: [] };

  // 每一個主日「PROGRAM_TEMPLATE_ID 最後一次改動」的那一筆 AuditLog（後寫的蓋前寫的）。
  var lastByDate = {};
  audits.forEach(function (a) {
    if (String(a.SHEET_NAME || '') !== SHEETS.BULLETIN_WEEKS) return;
    if (String(a.FIELD || '') !== 'PROGRAM_TEMPLATE_ID') return;
    lastByDate[programTemplateAuditRowKey_(a.ROW_KEY)] = a;
  });

  var clear = [];
  var keep = [];
  (weekRows || []).forEach(function (row) {
    var value = String(row.PROGRAM_TEMPLATE_ID === null || row.PROGRAM_TEMPLATE_ID === undefined
      ? '' : row.PROGRAM_TEMPLATE_ID).trim();
    if (!value) return;
    var date = normalizeDate_(row.SERVICE_DATE);
    if (!date) return;
    var isoDate = formatIsoDate_(date);
    var last = lastByDate[isoDate] || null;
    var manual = Boolean(last)
      && String(last.ACTION || '') === 'WEBAPP_SAVE_WEEK'
      && String(last.NEW_VALUE === null || last.NEW_VALUE === undefined ? '' : last.NEW_VALUE).trim() === value;
    if (manual) {
      keep.push({ isoDate: isoDate, value: value });
    } else {
      clear.push({ isoDate: isoDate, rowNo: row.__rowNo, oldValue: value, lastAction: last ? String(last.ACTION || '') : '' });
    }
  });

  return { alreadyDone: false, clear: clear, keep: keep };
}

/**
 * 用途：「初始化工作表」用：把舊資料裏系統寫入的程序範本清空，恢復「留空＝自動跟每週標題」。
 *   **只做一次**（見檔頭）。真正入口，會寫 `BulletinWeeks` 與 `AuditLog`。
 * Args: （無）
 * Returns:
 *   {{ran:boolean, cleared:number, kept:number, lines:string[]}}
 *     `ran` 為 false＝以前已經做過，這次甚麼都沒有寫。`lines` 是給對話框與報告的說明。
 * Raises:
 *   Error 讀寫工作表失敗時原樣拋出（由 initializeAllSheets() 的呼叫方呈現）。
 */
function migrateProgramTemplateToAuto_() {
  var plan = planProgramTemplateAutoMigration_(readRowsWithRowNo_(SHEETS.BULLETIN_WEEKS), readSheet(SHEETS.AUDIT_LOG));
  if (plan.alreadyDone) return { ran: false, cleared: 0, kept: 0, lines: [] };

  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.BULLETIN_WEEKS);
  plan.clear.forEach(function (c) {
    if (!(c.rowNo >= 3)) {
      throw new Error('migrateProgramTemplateToAuto_：主日 ' + c.isoDate + ' 讀不到行號，一格都不寫。');
    }
    setCellValueTextSafe_(sheet, COLUMNS.BULLETIN_WEEKS, c.rowNo, 'PROGRAM_TEMPLATE_ID', '');
    appendAuditLog_({
      action: PROGRAM_TEMPLATE_AUTO_CLEAR_ACTION_, sheetName: SHEETS.BULLETIN_WEEKS, rowKey: c.isoDate,
      field: 'PROGRAM_TEMPLATE_ID', oldValue: c.oldValue, newValue: '',
      notes: '程序範本改為「留空＝自動跟每週標題」：這一格是系統以前寫入的推斷結果（最後一次改動：'
        + (c.lastAction || '查不到') + '），清空之後按職事表的每週標題自動推斷。'
    });
  });
  appendAuditLog_({
    action: PROGRAM_TEMPLATE_AUTO_MIGRATED_ACTION_, sheetName: SHEETS.BULLETIN_WEEKS,
    notes: '一次性清理完成：清空 ' + plan.clear.length + ' 格、保留人手揀過的 ' + plan.keep.length + ' 格。'
  });

  var lines = ['程序範本改為跟每週標題：清空系統以前寫入的 ' + plan.clear.length + ' 格'
    + (plan.keep.length > 0 ? '，保留在填寫介面人手揀過的 ' + plan.keep.length + ' 格（'
      + plan.keep.slice(0, 8).map(function (k) { return k.isoDate + ' ' + k.value; }).join('、')
      + (plan.keep.length > 8 ? '……' : '') + '）' : '')
    + '。只做這一次。'];
  return { ran: true, cleared: plan.clear.length, kept: plan.keep.length, lines: lines };
}
