/**
 * Diagnostics.gs
 *
 * Diagnostics 工作表存放唯讀診斷報告。每次寫入會取代整張表原有的內容
 * （只保留最新一次報告），行數上限由 Config 的 DIAGNOSTICS_MAX_ROWS 控制
 * （預設 380 行——超過的話 Google Drive connector 讀不完）。超過上限就截斷，
 * 並在最後一行明確寫明「已截斷」，不可以默默丟掉資料。
 */

'use strict';

/**
 * 用途：把一份診斷報告寫入 Diagnostics 工作表，取代該工作表原有的全部內容。
 * Args:
 *   reportName {string} 報告名稱（例如「初始化工作表」）。
 *   contentLines {string[]} 報告內容，一個陣列元素對應一行。
 * Returns:
 *   {number} 實際寫入的資料行數（不含標題兩行；如果有截斷，含截斷提示那一行）。
 * Raises:
 *   Error 如果 reportName 是空字串。
 */
function writeDiagnosticsReport_(reportName, contentLines) {
  if (!reportName) {
    throw new Error('writeDiagnosticsReport_：reportName 不可以是空字串。');
  }

  var lines = (contentLines || []).slice();
  var totalLines = lines.length;

  var maxRows = normalizeInt_(getConfig(CONFIG_KEYS.DIAGNOSTICS_MAX_ROWS, '380'));
  if (!maxRows || maxRows < 1) maxRows = 380;

  var truncated = false;
  if (lines.length > maxRows) {
    truncated = true;
    lines = lines.slice(0, maxRows - 1);
  }

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ensureSheet_(ss, 'DIAGNOSTICS');
  var lastRow = sheet.getLastRow();
  if (lastRow > 2) {
    sheet.getRange(3, 1, lastRow - 2, COLUMNS.DIAGNOSTICS.keys.length).clearContent();
  }

  var now = new Date();
  var rows = lines.map(function (line, i) {
    return { REPORT_NAME: reportName, ROW_NO: i + 1, CONTENT: line, GENERATED_AT: now };
  });

  if (truncated) {
    rows.push({
      REPORT_NAME: reportName,
      ROW_NO: rows.length + 1,
      CONTENT: '（已截斷：本報告共 ' + totalLines + ' 行，只顯示前 ' + (maxRows - 1)
        + ' 行，尚餘 ' + (totalLines - (maxRows - 1)) + ' 行未顯示，上限為 ' + maxRows + ' 行。）',
      GENERATED_AT: now
    });
  }

  if (rows.length > 0) {
    writeSheet(SHEETS.DIAGNOSTICS, rows);
  }
  return rows.length;
}
