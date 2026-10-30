/**
 * ProgramTemplateAuto.gs
 *
 * 2026-10-27（Ivan 選 B）：程序範本跟每週標題。`BulletinWeeks.PROGRAM_TEMPLATE_ID` 留空＝自動
 * （按職事表 `ServiceDates.Title` 推斷，見 resolveProgramTemplateId_()），有值＝幹事人手揀過。
 *
 * 舊資料的問題：以前「建立本季空白週報」、「重設這一週」、「補抓」與載入週報都會把**推斷結果**寫進
 * 那一格，於是幾乎每一行都有值——照新規則全部變成「人手揀過」，每週標題再改也不會跟。這個檔案在
 * 「初始化工作表」時做**一次**清理：
 *
 *   - 已封存的行（`ARCHIVED=TRUE`）一律不動：那是歷史資料。
 *   - 那一格最後一次改動（AuditLog，`FIELD=PROGRAM_TEMPLATE_ID`）是人手揀選，而且新值就是現值 ⇒
 *     **保留**。人手揀選＝填寫介面儲存（`WEBAPP_SAVE_WEEK`），或者已停用的季度填寫表
 *     （`FILL_GRID_EDIT`、`FILL_SYNC_PUSH`）。
 *   - 其餘（AuditLog 找不到改動、最後一次是系統推斷／建立／重設／還原）⇒ 清空，恢復自動。每一格寫一筆
 *     AuditLog（舊值記在 OLD_VALUE，要還原可以照抄回去）。清空之後**實際用的範本有變**的主日逐一列出
 *     （舊值 → 現在按每週標題推斷的值）——例如以前由職事表舊的特別主日資料推斷成浸禮範本、而職事表
 *     「類型」欄未填的那一週，清空之後會變成平常主日，要看得到。
 *   - 不存版本記錄：版本記錄還原會把舊值帶回來，等於重新鎖定；舊值只記在 AuditLog。
 *
 *   做完寫一筆 `PROGRAM_TEMPLATE_AUTO_MIGRATED`；AuditLog 有這一筆就不再做（只做一次——之後
 *   幹事「還原」舊版本帶回來的範本 ID 算是那個版本的選擇，不應該再被清走）。
 *
 * 分層：`planProgramTemplateAutoMigration_()` 純函式（可在 Node 測試）；
 * `migrateProgramTemplateToAuto_()` 真正入口（讀寫工作表，在指令碼鎖之內）。
 */

'use strict';

/** AuditLog：清理做完的記號（只做一次）。 */
var PROGRAM_TEMPLATE_AUTO_MIGRATED_ACTION_ = 'PROGRAM_TEMPLATE_AUTO_MIGRATED';

/** AuditLog：清空其中一格。 */
var PROGRAM_TEMPLATE_AUTO_CLEAR_ACTION_ = 'PROGRAM_TEMPLATE_AUTO_CLEAR';

/** 算是「人手揀選」的 AuditLog 動作：填寫介面儲存、已停用的季度填寫表直接改與同步。 */
var PROGRAM_TEMPLATE_MANUAL_ACTIONS_ = ['WEBAPP_SAVE_WEEK', 'FILL_GRID_EDIT', 'FILL_SYNC_PUSH'];

/** 對話框最多逐一列出幾個「範本有變」的主日（其餘寫入 Diagnostics）。 */
var PROGRAM_TEMPLATE_AUTO_DIALOG_MAX_ = 12;

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
 *     keep:{isoDate:string, value:string, reason:string}[]}}
 *     `alreadyDone` 為 true 時兩張清單都是空的。`keep.reason`：`MANUAL`（人手揀過）或 `ARCHIVED`。
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
    if (row.ARCHIVED === true) {
      keep.push({ isoDate: isoDate, value: value, reason: 'ARCHIVED' });
      return;
    }
    var last = lastByDate[isoDate] || null;
    var manual = Boolean(last)
      && PROGRAM_TEMPLATE_MANUAL_ACTIONS_.indexOf(String(last.ACTION || '')) !== -1
      && String(last.NEW_VALUE === null || last.NEW_VALUE === undefined ? '' : last.NEW_VALUE).trim() === value;
    if (manual) {
      keep.push({ isoDate: isoDate, value: value, reason: 'MANUAL' });
    } else {
      clear.push({ isoDate: isoDate, rowNo: row.__rowNo, oldValue: value, lastAction: last ? String(last.ACTION || '') : '' });
    }
  });

  return { alreadyDone: false, clear: clear, keep: keep };
}

/**
 * 用途：清空之後這一週會用哪一個範本（按職事表現在的每週標題推斷）。讀不到職事表不拋錯。
 * Args:
 *   isoDate {string} 主日。
 *   templateConfig {Object} `readProgramTemplateConfig_()` 的輸出。
 * Returns:
 *   {string} 範本 ID；讀不到職事表時回「（讀不到職事表：原因）」。
 * Raises:
 *   （無）
 */
function programTemplateAutoValueFor_(isoDate, templateConfig) {
  try {
    return resolveProgramTemplateId_({}, readRosterSnapshot_(isoDate), templateConfig).templateId;
  } catch (err) {
    return '（讀不到職事表：' + ((err && err.message) ? err.message : String(err)) + '）';
  }
}

/**
 * 用途：「初始化工作表」用：把舊資料裏系統寫入的程序範本清空，恢復「留空＝自動跟每週標題」。
 *   **只做一次**（見檔頭）。真正入口，會寫 `BulletinWeeks` 與 `AuditLog`；整段在指令碼鎖之內
 *   （與填寫介面儲存同一把鎖，免得儲存的同時用舊計畫寫）。
 * Args: （無）
 * Returns:
 *   {{ran:boolean, cleared:number, kept:number, changed:{isoDate:string, from:string, to:string}[],
 *     lines:string[]}}
 *     `ran` 為 false＝以前已經做過，這次甚麼都沒有寫。`changed`＝清空之後實際用的範本有變的主日。
 *     `lines` 是給對話框與報告的說明。
 * Raises:
 *   Error 讀寫工作表失敗、拿不到鎖時原樣拋出（由 initializeAllSheets() 的呼叫方呈現）；行號不合理時
 *     **在寫任何一格之前**拋出。
 */
function migrateProgramTemplateToAuto_() {
  return withScriptLock_('migrateProgramTemplateToAuto_', 30000, function () {
    var plan = planProgramTemplateAutoMigration_(readRowsWithRowNo_(SHEETS.BULLETIN_WEEKS), readSheet(SHEETS.AUDIT_LOG));
    if (plan.alreadyDone) return { ran: false, cleared: 0, kept: 0, changed: [], lines: [] };

    // 先核對全部行號，才寫第一格：中途才發現就會寫了一半。
    plan.clear.forEach(function (c) {
      if (!(c.rowNo >= 3)) {
        throw new Error('migrateProgramTemplateToAuto_：主日 ' + c.isoDate + ' 讀不到行號，一格都沒有寫。');
      }
    });

    var templateConfig = readProgramTemplateConfig_();
    var changed = [];
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.BULLETIN_WEEKS);
    plan.clear.forEach(function (c) {
      var autoValue = programTemplateAutoValueFor_(c.isoDate, templateConfig);
      setCellValueTextSafe_(sheet, COLUMNS.BULLETIN_WEEKS, c.rowNo, 'PROGRAM_TEMPLATE_ID', '');
      appendAuditLog_({
        action: PROGRAM_TEMPLATE_AUTO_CLEAR_ACTION_, sheetName: SHEETS.BULLETIN_WEEKS, rowKey: c.isoDate,
        field: 'PROGRAM_TEMPLATE_ID', oldValue: c.oldValue, newValue: '',
        notes: '程序範本改為「留空＝自動跟每週標題」：這一格是系統以前寫入的推斷結果（最後一次改動：'
          + (c.lastAction || '查不到') + '），清空之後按職事表的每週標題自動推斷，現在是 ' + autoValue + '。'
      });
      if (autoValue !== c.oldValue) changed.push({ isoDate: c.isoDate, from: c.oldValue, to: autoValue });
    });
    appendAuditLog_({
      action: PROGRAM_TEMPLATE_AUTO_MIGRATED_ACTION_, sheetName: SHEETS.BULLETIN_WEEKS,
      notes: '一次性清理完成：清空 ' + plan.clear.length + ' 格（其中 ' + changed.length + ' 個主日實際用的範本有變）、'
        + '保留 ' + plan.keep.length + ' 格（人手選過或已封存）。'
    });

    var manualKept = plan.keep.filter(function (k) { return k.reason === 'MANUAL'; });
    var lines = ['程序範本改為跟每週標題：清空系統以前寫入的 ' + plan.clear.length + ' 格'
      + (manualKept.length > 0 ? '，保留人手選過的 ' + manualKept.length + ' 格（'
        + manualKept.slice(0, 8).map(function (k) { return k.isoDate + ' ' + k.value; }).join('、')
        + (manualKept.length > 8 ? '……' : '') + '）' : '')
      + '；已封存的不動。只做這一次。'];
    if (changed.length > 0) {
      lines.push('⚠️ 以下主日清空之後用的範本有變（以前的值 → 現在按職事表「類型」欄推斷）：');
      changed.slice(0, PROGRAM_TEMPLATE_AUTO_DIALOG_MAX_).forEach(function (c) {
        lines.push('　' + c.isoDate + '：' + c.from + ' → ' + c.to);
      });
      if (changed.length > PROGRAM_TEMPLATE_AUTO_DIALOG_MAX_) {
        lines.push('　……另有 ' + (changed.length - PROGRAM_TEMPLATE_AUTO_DIALOG_MAX_) + ' 個，見 AuditLog（動作 '
          + PROGRAM_TEMPLATE_AUTO_CLEAR_ACTION_ + '）。');
      }
      lines.push('　不對的話：在職事表那一週的「類型」欄填標題（例如「浸禮主日」），或者在填寫介面選範本。');
    }
    return { ran: true, cleared: plan.clear.length, kept: plan.keep.length, changed: changed, lines: lines };
  });
}
