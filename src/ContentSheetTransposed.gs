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
 *
 *   2026-11-02（Ivan）：最後加合堂三行（合堂崇拜、合堂祈禱會、合堂兒童；第 14 至 16 行）。已經建好的橫放分頁
 *   第 B 欄只有頭幾個機器鍵（`TRANSPOSED_SHORT`）：「建立本季內容表」（＝更新）只在最後補上那幾行的標題與
 *   純文字格式（`addTransposedContentRows_()`），已有的格一格不改；未補之前匯入講明要先更新（不讀少了的行）。
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
 * 用途：舊版「一個崇拜日期一行」分頁第 2 行的機器鍵（凍結；分頁定義的 `legacyRowKeys`，沒有就用 `keys`）。
 *   認出舊版、讀舊版資料都用這一份——之後加在橫放分頁的行（例如合堂三格）舊版沒有。純函式。
 * Args:
 *   tabDef {Object}
 * Returns:
 *   {string[]}
 */
function transposedLegacyRowKeys_(tabDef) {
  return (tabDef.legacyRowKeys || tabDef.keys || []).slice();
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
 *   {string} `'MISSING'`／`'TRANSPOSED'`（日子橫放）／`'TRANSPOSED_SHORT'`（日子橫放，第 B 欄是現行機器鍵的前段、
 *     之後的行整行空白＝之後才加的行未補上，見 `transposedShortRowCount_()`）／
 *     `'TRANSPOSED_NO_HEAD'`（日子橫放，但第 A、B 欄空白：
 *     有人清走了標題，或者上一次寫到一半——資料欄的位置仍然是現行的，照讀，套版面時補回 A、B 欄）／
 *     `'ROWS'`（舊版一個日期一行）／`'BLANK'`（新分頁）／`'UNREADABLE'`（標題空白而有資料，位置不明）／`'UNKNOWN'`。
 */
function detectTransposedTabLayout_(sheet, tabDef) {
  if (!sheet) return 'MISSING';
  var tkeys = transposedContentKeys_(tabDef);
  var colB = readTransposedHeaderKeys_(sheet, tkeys.length);
  if (tkeys.every(function (k, i) { return colB[i] === k; })) return 'TRANSPOSED';
  // 2026-11-02：第 B 欄是現行機器鍵的前段（例如未有合堂三行）。之後的行有任何字＝位置不明（不當作少了行）。
  var prefix = transposedKeyPrefixLength_(colB, tkeys);
  if (prefix > 0) {
    return transposedRowsBlank_(sheet, prefix + 1, tkeys.length - prefix) ? 'TRANSPOSED_SHORT' : 'UNKNOWN';
  }
  var legacyKeys = transposedLegacyRowKeys_(tabDef);
  var row2 = readContentTabHeaderKeys_(sheet, legacyKeys.length);
  if (legacyKeys.every(function (k, i) { return row2[i] === k; })) return 'ROWS';
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
  var state = blankHeaderDataState_(sheet, legacyKeys.length);
  if (!state.hasData && !state.beyond) return 'BLANK';
  // 舊版第 1、2 行空白而有資料（與「崇拜程序」同一個規則）：當作舊版的欄位位置。
  return state.beyond ? 'UNREADABLE' : 'ROWS';
}

/**
 * 用途：第 B 欄（頭 n 行）是現行機器鍵的**真前段**時，前段有幾行：頭 k 行與機器鍵一一相同、其餘全部空白，
 *   而且 0 < k < n。其餘情況（全部相同、全部空白、中間不同）回 0。純函式。
 * Args:
 *   colB {string[]} `readTransposedHeaderKeys_()` 的輸出（長度＝n）。
 *   tkeys {string[]} `transposedContentKeys_()`。
 * Returns:
 *   {number}
 */
function transposedKeyPrefixLength_(colB, tkeys) {
  var k = 0;
  while (k < tkeys.length && colB[k] === tkeys[k]) k++;
  if (k === 0 || k >= tkeys.length) return 0;
  for (var i = k; i < tkeys.length; i++) {
    if (String(colB[i] === undefined ? '' : colB[i]) !== '') return 0;
  }
  return k;
}

/**
 * 用途：橫放分頁由第 `fromRow` 行起 `count` 行（第 A 欄至最後一欄）是不是整片空白。唯讀。
 * Args:
 *   sheet {Sheet}　fromRow {number} 1 起算。　count {number}
 * Returns:
 *   {boolean} 分頁行數不夠（那幾行根本不存在）亦當作空白。
 */
function transposedRowsBlank_(sheet, fromRow, count) {
  var maxRows = Number(sheet.getMaxRows()) || 0;
  var rows = Math.min(count, maxRows - fromRow + 1);
  var lastCol = Number(sheet.getLastColumn()) || 0;
  if (rows <= 0 || lastCol <= 0) return true;
  return sheet.getRange(fromRow, 1, rows, lastCol).getValues().every(function (r) {
    return r.every(function (v) { return v === '' || v === null || v === undefined; });
  });
}

/**
 * 用途：`TRANSPOSED_SHORT` 的分頁少了哪幾行（機器鍵與中文標題）。唯讀。
 * Args:
 *   sheet {Sheet}　tabDef {Object}
 * Returns:
 *   {{fromIndex:number, keys:string[], headers:string[]}} `fromIndex` 是第一個缺的機器鍵在 `transposedContentKeys_()`
 *     的位置（0 起算；分頁上是第 fromIndex＋1 行）。不是 `TRANSPOSED_SHORT` 回 `keys:[]`。
 */
function transposedMissingRows_(sheet, tabDef) {
  var tkeys = transposedContentKeys_(tabDef);
  var headers = transposedContentHeaders_(tabDef);
  var k = transposedKeyPrefixLength_(readTransposedHeaderKeys_(sheet, tkeys.length), tkeys);
  if (k === 0) return { fromIndex: tkeys.length, keys: [], headers: [] };
  return { fromIndex: k, keys: tkeys.slice(k), headers: headers.slice(k) };
}

/**
 * 用途：在已經建好的橫放分頁最後補上新加的行（2026-11-02 合堂三行）：只寫那幾行的第 A 欄（中文標題）、
 *   第 B 欄（機器鍵），並把那幾行的日期欄設成純文字。已有的格一格不改；版面與鎖由呼叫方之後照常套
 *   （`applyTransposedContentTabLayout_()`、`ensureContentTabDateLock_()`）。IO 層；冪等（已經補好就不寫）。
 * Args:
 *   sheet {Sheet}　tabDef {Object}
 * Returns:
 *   {string[]} 補上的行的中文標題；沒有補就是空陣列。
 * Raises:
 *   Error 寫入失敗時原樣拋出。
 */
function addTransposedContentRows_(sheet, tabDef) {
  var missing = transposedMissingRows_(sheet, tabDef);
  if (missing.keys.length === 0) return [];
  var firstRow = missing.fromIndex + 1;
  var needRows = firstRow + missing.keys.length - 1;
  var maxRows = Number(sheet.getMaxRows()) || 0;
  if (maxRows < needRows) sheet.insertRowsAfter(Math.max(1, maxRows), needRows - maxRows);
  var head = sheet.getRange(firstRow, 1, missing.keys.length, 2);
  head.setNumberFormat('@');
  head.setValues(missing.keys.map(function (k, i) { return [missing.headers[i], k]; }));
  var dateCols = transposedDateColumnCount_(sheet);
  if (dateCols > 0) {
    sheet.getRange(firstRow, CONTENT_SHEET_TRANSPOSED_FIRST_DATA_COL_, missing.keys.length, dateCols).setNumberFormat('@');
  }
  return missing.headers.slice();
}

/**
 * 用途：讀橫放分頁的資料：每一欄（C 起）變成一筆（形狀同 `parseContentTabRows_()`）。IO 層。
 * Args:
 *   sheet {Sheet}　tabDef {Object}
 * Returns:
 *   {Object[]} 每筆多 `__colLetter`；`__rowNo` 是欄號。整欄空白的略過。分頁未補上之後才加的行時，每一筆沒有那幾個鍵。
 */
function readTransposedContentRows_(sheet, tabDef) {
  var tkeys = transposedContentKeys_(tabDef);
  // 2026-11-02：未補上之後才加的行（TRANSPOSED_SHORT，例如合堂三行）：只讀有的那幾行——每一筆就沒有那幾個鍵，
  //    匯入不碰週報那幾格（computeContentImportPlan_()），不會當成空白清走。
  var prefix = transposedKeyPrefixLength_(readTransposedHeaderKeys_(sheet, tkeys.length), tkeys);
  if (prefix > 0) tkeys = tkeys.slice(0, prefix);
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
