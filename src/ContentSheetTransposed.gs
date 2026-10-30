/**
 * src/ContentSheetTransposed.gs
 *
 * 2026-10-30（Ivan）：內容表「崇拜人數」改為**日子橫放**——第 1 行全部是崇拜日期（每一日一欄），
 * 十二格人數在日期下面；第 A 欄是中文標題，第 B 欄是機器鍵（隱藏）。其餘分頁照舊（一則一行）。
 *
 *   版面（n＝機器鍵數目，「有效」不放在橫放的分頁）：
 *     A1「崇拜日期」　B1 SERVICE_DATE　C1、D1…＝日期（yyyy-MM-dd 文字，系統預先填好並鎖住）
 *     A2「英語堂崇拜」B2 ATT_ENG_WORSHIP　C2、D2…＝人數（純文字）
 *     …
 *   同工只可以改 C2 至最後一欄第 n 行（分頁保護，與 v4「一個日期一行」同一個保護說明）。
 *
 *   程式內部仍然用「一個日期一筆」的資料（`parseContentTabRows_()` 的形狀）：讀的時候每一欄變成一筆
 *   （`__rowNo` 是欄號、`__colLetter` 是欄的字母），寫的時候每一筆變成一欄。匯入、v4 整理的計畫都不用改。
 *
 *   舊的「一個崇拜日期一行」分頁由「更新本季內容表…」轉換（先預覽，確定之後舊分頁改名隱藏保留，一格不刪）。
 */

'use strict';

/** 橫放分頁第一個資料欄（C）。 */
var CONTENT_SHEET_TRANSPOSED_FIRST_DATA_COL_ = 3;

/**
 * 用途：橫放分頁用的機器鍵（不包括「有效」）。純函式。
 * Args:
 *   tabDef {Object}
 * Returns:
 *   {string[]}
 */
function transposedContentKeys_(tabDef) {
  return (tabDef.keys || []).filter(function (k) { return k !== 'ACTIVE'; });
}

/**
 * 用途：橫放分頁第 A 欄的中文標題（與 `transposedContentKeys_()` 一一對應）。純函式。
 * Args:
 *   tabDef {Object}
 * Returns:
 *   {string[]}
 */
function transposedContentHeaders_(tabDef) {
  return (tabDef.headers || []).filter(function (h, i) { return (tabDef.keys || [])[i] !== 'ACTIVE'; });
}

/**
 * 用途：欄號 → 欄的字母（1 → A，27 → AA）。純函式。
 * Args:
 *   n {number}
 * Returns:
 *   {string}
 */
function contentColumnLetter_(n) {
  var out = '';
  var x = Math.floor(Number(n) || 0);
  while (x > 0) {
    var r = (x - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    x = Math.floor((x - 1) / 26);
  }
  return out;
}

/**
 * 用途：警告訊息裏一筆資料在內容表的位置：橫放分頁講「第 D 欄」，其餘講「第 5 行」。純函式。
 * Args:
 *   row {Object} `parseContentTabRows_()` 或 `readTransposedContentRows_()` 的一筆。
 * Returns:
 *   {string}
 */
function contentRowRef_(row) {
  if (row && row.__colLetter) return '第 ' + row.__colLetter + ' 欄';
  return '第 ' + (row ? row.__rowNo : '?') + ' 行';
}

/**
 * 用途：讀橫放分頁第 B 欄（機器鍵）頭 `n` 行。IO 層。
 * Args:
 *   sheet {Sheet}　n {number}
 * Returns:
 *   {string[]} 長度剛好 `n`。
 */
function readTransposedHeaderKeys_(sheet, n) {
  var want = Math.max(0, Number(n) || 0);
  var cols = Number(sheet.getMaxColumns()) || 0;
  var rows = Math.min(want, Number(sheet.getMaxRows()) || 0);
  var cells = (cols >= 2 && rows > 0) ? sheet.getRange(1, 2, rows, 1).getValues() : [];
  var out = [];
  for (var i = 0; i < want; i++) {
    var v = i < cells.length ? cells[i][0] : '';
    out.push(v === null || v === undefined ? '' : String(v).trim());
  }
  return out;
}

/**
 * 用途：認出「崇拜人數」分頁現在是哪一個版面。IO 層（唯讀）。
 * Args:
 *   sheet {?Sheet}　tabDef {Object} 現行定義（`transposed:true`）。
 * Returns:
 *   {string} `'MISSING'`／`'TRANSPOSED'`（日子橫放）／`'TRANSPOSED_NO_HEAD'`（日子橫放，但第 A、B 欄空白：
 *     有人清走了標題，或者上一次寫到一半——資料欄的位置仍然是現行的，照讀，套版面時補回 A、B 欄）／
 *     `'ROWS'`（舊版一個日期一行）／`'BLANK'`（新分頁）／`'UNREADABLE'`（標題空白而有資料，位置不明）／`'UNKNOWN'`。
 */
function detectTransposedTabLayout_(sheet, tabDef) {
  if (!sheet) return 'MISSING';
  var tkeys = transposedContentKeys_(tabDef);
  var colB = readTransposedHeaderKeys_(sheet, tkeys.length);
  if (tkeys.every(function (k, i) { return colB[i] === k; })) return 'TRANSPOSED';
  var row2 = readContentTabHeaderKeys_(sheet, tabDef.keys.length);
  if (tabDef.keys.every(function (k, i) { return row2[i] === k; })) return 'ROWS';
  var colBBlank = colB.every(function (v) { return v === ''; });
  if ((Number(sheet.getLastRow()) || 0) === 0) return 'BLANK';
  // 第 A、B 欄（頭 n 行）全部空白而 C1 是日期＝日子橫放的資料位置（舊版第 A 欄第 3 行起是日期，不會全部空白）。
  var lastCol = Number(sheet.getLastColumn()) || 0;
  if (colBBlank && lastCol >= CONTENT_SHEET_TRANSPOSED_FIRST_DATA_COL_) {
    var rows = Math.min(tkeys.length, Number(sheet.getMaxRows()) || 0);
    var colA = rows > 0 ? sheet.getRange(1, 1, rows, 1).getValues() : [];
    var colABlank = colA.every(function (r) { return r[0] === '' || r[0] === null || r[0] === undefined; });
    var c1 = sheet.getRange(1, CONTENT_SHEET_TRANSPOSED_FIRST_DATA_COL_, 1, 1).getValues()[0][0];
    if (colABlank && /^\d{4}-\d{2}-\d{2}$/.test(String(c1 || '').trim())) return 'TRANSPOSED_NO_HEAD';
  }
  var row2Blank = row2.every(function (v) { return v === ''; });
  if (!colBBlank || !row2Blank) return 'UNKNOWN';
  var state = blankHeaderDataState_(sheet, tabDef.keys.length);
  if (!state.hasData && !state.beyond) return 'BLANK';
  // 舊版第 1、2 行空白而有資料（與「崇拜程序」同一個規則）：當作舊版的欄位位置。
  return state.beyond ? 'UNREADABLE' : 'ROWS';
}

/**
 * 用途：讀橫放分頁的資料：每一欄（C 起）變成一筆（形狀同 `parseContentTabRows_()`）。IO 層。
 * Args:
 *   sheet {Sheet}　tabDef {Object}
 * Returns:
 *   {Object[]} 每筆多 `__colLetter`；`__rowNo` 是欄號。整欄空白的略過。
 */
function readTransposedContentRows_(sheet, tabDef) {
  var tkeys = transposedContentKeys_(tabDef);
  var n = tkeys.length;
  var lastCol = Number(sheet.getLastColumn()) || 0;
  if (lastCol < CONTENT_SHEET_TRANSPOSED_FIRST_DATA_COL_ || n === 0) return [];
  var width = lastCol - CONTENT_SHEET_TRANSPOSED_FIRST_DATA_COL_ + 1;
  var values = sheet.getRange(1, CONTENT_SHEET_TRANSPOSED_FIRST_DATA_COL_, n, width).getValues();
  var columns = [];
  for (var j = 0; j < width; j++) {
    var col = [];
    for (var i = 0; i < n; i++) col.push((values[i] || [])[j]);
    columns.push(col);
  }
  // parseContentTabRows_() 的行號由 CONTENT_SHEET_FIRST_DATA_ROW_ 起計；這裏改成真正的欄號。
  return parseContentTabRows_(columns, tkeys).map(function (row) {
    var colNo = row.__rowNo - CONTENT_SHEET_FIRST_DATA_ROW_ + CONTENT_SHEET_TRANSPOSED_FIRST_DATA_COL_;
    row.__rowNo = colNo;
    row.__colLetter = contentColumnLetter_(colNo);
    return row;
  });
}

/**
 * 用途：建立（或清空重寫）橫放分頁：先寫資料欄，**最後**才寫第 A、B 欄（提交點：中途停止的話機器鍵仍然是空的，
 *   下一次由改了名的舊分頁再建一次），然後套版面、上鎖。IO 層。
 * Args:
 *   spreadsheet {Spreadsheet}　tabDef {Object}　rows {Object[]} 一個日期一筆（以機器鍵為 key）。
 *   layoutOptions {Object} `owners`、`deadlineNote`。
 * Returns:
 *   {{sheet:Sheet, lock:{ok:boolean, message:string}}}
 * Raises:
 *   Error 寫入失敗時原樣拋出。
 */
function writeTransposedContentTab_(spreadsheet, tabDef, rows, layoutOptions) {
  var sheet = ensureContentTab_(spreadsheet, tabDef.tabName).sheet;
  var tkeys = transposedContentKeys_(tabDef);
  var n = tkeys.length;
  var list = rows || [];
  ensureContentTabColumns_(sheet, CONTENT_SHEET_TRANSPOSED_FIRST_DATA_COL_ - 1 + Math.max(1, list.length));
  var lastCol = Number(sheet.getLastColumn()) || 0;
  if (lastCol >= CONTENT_SHEET_TRANSPOSED_FIRST_DATA_COL_) {
    sheet.getRange(1, CONTENT_SHEET_TRANSPOSED_FIRST_DATA_COL_, n, lastCol - CONTENT_SHEET_TRANSPOSED_FIRST_DATA_COL_ + 1).clearContent();
  }
  if (list.length > 0) {
    var range = sheet.getRange(1, CONTENT_SHEET_TRANSPOSED_FIRST_DATA_COL_, n, list.length);
    range.setNumberFormat('@');
    range.setValues(tkeys.map(function (k) {
      return list.map(function (r) {
        var v = r[k];
        return (v === null || v === undefined) ? '' : sanitizeCellText_(String(v));
      });
    }));
  }
  writeTransposedContentHead_(sheet, tabDef);
  applyTransposedContentTabLayout_(sheet, tabDef, list.length, layoutOptions || {});
  var lock = ensureContentTabDateLock_(sheet, n, list.length, { transposed: true });
  return { sheet: sheet, lock: lock };
}

/**
 * 用途：寫橫放分頁的第 A 欄（中文標題）與第 B 欄（機器鍵）。IO 層；冪等。
 * Args:
 *   sheet {Sheet}　tabDef {Object}
 * Returns:
 *   {void}
 * Raises:
 *   Error 寫入失敗時原樣拋出。
 */
function writeTransposedContentHead_(sheet, tabDef) {
  var tkeys = transposedContentKeys_(tabDef);
  var headers = transposedContentHeaders_(tabDef);
  var head = sheet.getRange(1, 1, tkeys.length, 2);
  head.setNumberFormat('@');
  head.setValues(tkeys.map(function (k, i) { return [headers[i], k]; }));
}

/**
 * 用途：橫放分頁有幾個日期欄（第 1 行 C 起最後一個有值的欄）。唯讀。
 * Args:
 *   sheet {Sheet}
 * Returns:
 *   {number}
 */
function transposedDateColumnCount_(sheet) {
  var lastCol = Number(sheet.getLastColumn()) || 0;
  if (lastCol < CONTENT_SHEET_TRANSPOSED_FIRST_DATA_COL_) return 0;
  var row1 = sheet.getRange(1, CONTENT_SHEET_TRANSPOSED_FIRST_DATA_COL_, 1, lastCol - CONTENT_SHEET_TRANSPOSED_FIRST_DATA_COL_ + 1).getValues()[0];
  var count = 0;
  row1.forEach(function (v, i) { if (v !== '' && v !== null && v !== undefined) count = i + 1; });
  return count;
}

/**
 * 用途：橫放分頁的版面：凍結第 1 行與第 A、B 欄、標題粗體、隱藏機器鍵欄、欄寬、A1 說明、拿走下拉。IO 層；冪等。
 * Args:
 *   sheet {Sheet}　tabDef {Object}　dataCols {number} 日期欄數。　options {Object} `owners`、`deadlineNote`。
 * Returns:
 *   {void}
 */
function applyTransposedContentTabLayout_(sheet, tabDef, dataCols, options) {
  var n = transposedContentKeys_(tabDef).length;
  var width = CONTENT_SHEET_TRANSPOSED_FIRST_DATA_COL_ - 1 + Math.max(1, dataCols);
  sheet.getRange(1, 1, n, width).clearDataValidations();
  sheet.setFrozenRows(1);
  sheet.setFrozenColumns(2);
  sheet.getRange(1, 1, 1, width).setFontWeight('bold').setBackground('#e8eef7');
  sheet.getRange(1, 1, n, 1).setFontWeight('bold');
  sheet.getRange(1, 2, n, 1).setFontColor('#999999').setFontSize(8);
  sheet.setColumnWidth(1, 150);
  for (var c = CONTENT_SHEET_TRANSPOSED_FIRST_DATA_COL_; c <= width; c++) sheet.setColumnWidth(c, 100);
  if (typeof sheet.hideColumns === 'function') sheet.hideColumns(2);
  sheet.getRange(1, 1).setNote(buildContentSheetTabNote_(tabDef, options.owners, options.deadlineNote));
}
