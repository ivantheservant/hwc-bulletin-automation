/**
 * src/ContentSheetTransposed.gs
 *
 * 2026-10-30（Ivan）：內容表「崇拜人數」曾經改為**日子橫放**——第 1 行全部是崇拜日期（每一日一欄），
 * 十二格人數（11-02 起再加合堂三格）在日期下面；第 A 欄是中文標題，第 B 欄是機器鍵（隱藏）。
 *
 * 2026-11-03（Ivan）：決定**改回一個崇拜日期一行**，與家事報告、代禱事項一致（合堂三格是「有效」之前的三欄）。
 *   這個檔案只剩「認出」與「讀」橫放版面：2026-10-30 至 11-03 建好的內容表仍然是橫放——
 *     - 匯入照讀（`readTransposedContentRows_()`），只出提示，部署之後未按「更新本季內容表…」的季度照常匯入；
 *     - 「更新本季內容表…」先預覽，確定之後改回一個日期一行（舊分頁改名隱藏保留，一格不刪；src/ContentSheetV4.gs）。
 *   「崇拜人數」現在是哪一個版面一律由 `detectAttendanceTabLayout_()` 判斷。
 *
 *   橫放版面（n＝機器鍵數目，「有效」不放在橫放的分頁）：
 *     A1「崇拜日期」　B1 SERVICE_DATE　C1、D1…＝日期（yyyy-MM-dd 文字）
 *     A2「英語堂崇拜」B2 ATT_ENG_WORSHIP　C2、D2…＝人數（純文字）
 *     …
 *   讀的時候每一欄變成一筆（`__rowNo` 是欄號、`__colLetter` 是欄的字母），形狀同 `parseContentTabRows_()`。
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
 * 用途：2026-11-03：「崇拜人數」分頁現在是哪一個版面（改回一個崇拜日期一行之後的唯一判斷）。IO 層（唯讀）。
 * Args:
 *   sheet {?Sheet}　tabDef {Object} 現行定義（`formerlyTransposed:true`）。
 * Returns:
 *   {string} `'ROWS'`（現行：一個日期一行，第 2 行是現行機器鍵）／
 *     `'ROWS_NO_HEAD'`（現行欄位位置，但第 1、2 行被清走而下面有資料；現行版面最後一欄「有效」有值才算，
 *       舊版「有效」在第 N 欄、最後三欄空白，不會被認成這一個）／
 *     `'ROWS_LEGACY'`（2026-10-30 之前的一個日期一行，未有合堂三欄，`legacyRowKeys`）／
 *     `'TRANSPOSED'`／`'TRANSPOSED_SHORT'`／`'TRANSPOSED_NO_HEAD'`（2026-10-30 至 11-03 的日子橫放，見
 *       `detectTransposedTabLayout_()`）／`'BLANK'`／`'UNREADABLE'`／`'UNKNOWN'`／`'MISSING'`。
 * Raises:
 *   Error 讀取失敗時原樣拋出。
 */
function detectAttendanceTabLayout_(sheet, tabDef) {
  if (!sheet) return 'MISSING';
  var keys = (tabDef && tabDef.keys) || [];
  var row2 = readContentTabHeaderKeys_(sheet, keys.length);
  if (keys.length > 0 && keys.every(function (k, i) { return row2[i] === k; })) return 'ROWS';
  var row2Blank = row2.every(function (v) { return v === ''; });
  if (row2Blank && (Number(sheet.getLastRow()) || 0) >= CONTENT_SHEET_FIRST_DATA_ROW_) {
    var state = blankHeaderDataState_(sheet, keys.length);
    // 第 1 行亦要空白、第 3 行 A 欄要是日期（橫放的資料由第 1 行起，A 欄是標題），才當作現行位置（獨立審查 2026-11-03）。
    var row1 = sheet.getRange(1, 1, 1, keys.length).getValues()[0];
    var row1Blank = row1.every(function (v) { return v === '' || v === null || v === undefined; });
    var a3 = sheet.getRange(CONTENT_SHEET_FIRST_DATA_ROW_, 1, 1, 1).getValues()[0][0];
    var a3Date = (a3 instanceof Date) || /^\d{4}-\d{2}-\d{2}$/.test(String(a3 || '').trim());
    if (state.hasData && !state.beyond && row1Blank && a3Date && attendanceLastColumnHasData_(sheet, keys.length)) return 'ROWS_NO_HEAD';
  }
  var older = detectTransposedTabLayout_(sheet, tabDef);
  return older === 'ROWS' ? 'ROWS_LEGACY' : older;
}

/**
 * 用途：一個日期一行的分頁第 `colCount` 欄（現行版面的「有效」）由第 3 行起有沒有任何字。唯讀。
 * Args:
 *   sheet {Sheet}　colCount {number}
 * Returns:
 *   {boolean}
 */
function attendanceLastColumnHasData_(sheet, colCount) {
  return readContentTabDataValues_(sheet, colCount).some(function (row) {
    var v = row[colCount - 1];
    return v === true || v === false || (v !== '' && v !== null && v !== undefined);
  });
}

/**
 * 用途：2026-11-03：「崇拜人數」的版面是不是要改回／改成現行的一個崇拜日期一行（橫放、或者未有合堂三欄的舊版）。純函式。
 * Args:
 *   layout {string} `detectAttendanceTabLayout_()` 的輸出。
 * Returns:
 *   {boolean}
 */
function attendanceLayoutIsTransposed_(layout) {
  return layout === 'TRANSPOSED' || layout === 'TRANSPOSED_SHORT' || layout === 'TRANSPOSED_NO_HEAD';
}

/**
 * 用途：2026-11-03：「崇拜人數」仍然是日子橫放、或者未有合堂三欄時，匯入照常做、只出的提示。純函式。
 *   匯入預覽、填寫介面（內容表狀態列）、自動同步的 ErrorLog 都用這一句。
 * Args:
 *   tabName {string}　layout {string} `detectAttendanceTabLayout_()` 的輸出。
 * Returns:
 *   {?{code:string, message:string}} 現行版面回 `null`。
 */
function contentAttendanceLayoutNotice_(tabName, layout) {
  if (layout === 'TRANSPOSED' || layout === 'TRANSPOSED_SHORT') {
    return {
      code: 'CONTENT_ATTENDANCE_TRANSPOSED',
      message: '內容表「' + tabName + '」仍然是日子橫放（每一個崇拜日期一欄），請按「更新本季內容表…」改回一個崇拜日期一行'
        + '（與家事報告、代禱事項一致，已經填好的人數照搬）；未改之前人數照常匯入'
        + (layout === 'TRANSPOSED_SHORT' ? '，但合堂三格不會匯入（這張分頁未有合堂三行）' : '') + '。'
    };
  }
  if (layout === 'ROWS_LEGACY') {
    return {
      code: 'CONTENT_ATTENDANCE_ROWS_MISSING',
      message: '內容表「' + tabName + '」未有合堂三欄（合堂崇拜、合堂祈禱會、合堂兒童），請按「更新本季內容表…」補上；'
        + '未補之前其餘人數照常匯入，合堂三格不會匯入。'
    };
  }
  return null;
}
