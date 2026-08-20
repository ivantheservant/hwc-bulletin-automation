/**
 * SchemaCheck.gs
 *
 * 工作表結構版本檢查：本專案已經連續三次因為「push 了程式碼但沒有撳
 * 『初始化工作表』」而浪費時間（新 Config 鍵未 seed、`BulletinWeeks`
 * 缺 `LAST_SAVED_AT` 欄……）。`checkSheetSchema_()` 把試算表實際結構跟
 * 程式碼裡的 `SHEETS`／`COLUMNS`／`DEFAULTS` 比對一次，讓這件事自己講
 * 出來，而不是等某個功能因為讀不到欄位而莫名其妙壞掉。
 *
 * 唯讀，不寫入任何一格。三個地方會用到它的結果：選單「檢查工作表結構」、
 * `doGet`（黃色橫幅）、`apiSaveWeek`（結構落後就直接拒絕儲存，寧可拒絕
 * 也不要寫壞資料）。
 */

'use strict';

/**
 * 用途：比對試算表實際結構與程式碼定義（`SHEETS`／`COLUMNS`／`DEFAULTS`）
 *   是否一致。唯讀，不寫入任何一格。
 * Args: （無）
 * Returns:
 *   {{ok:boolean, missingConfigKeys:string[], missingSheets:string[],
 *     missingColumns:{sheet:string, keys:string[]}[]}}
 *     `missingSheets` 是完全找不到的工作表名稱；`missingColumns` 只列出
 *     「工作表存在，但第 2 行機器鍵在該欄位置對不上程式定義」的表（跟
 *     `readSheet()` 本身判斷「工作表結構跑位」的規則一致），找不到的
 *     工作表不會同時出現在這裡（已經在 `missingSheets`）。
 */
function checkSheetSchema_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var missingSheets = [];
  var missingColumns = [];

  Object.keys(SHEETS).forEach(function (sheetId) {
    var name = SHEETS[sheetId];
    var sheet = ss.getSheetByName(name);
    if (!sheet) {
      missingSheets.push(name);
      return;
    }

    var mismatchedKeys = findMismatchedColumnKeys_(sheet, COLUMNS[sheetId]);
    if (mismatchedKeys.length > 0) {
      missingColumns.push({ sheet: name, keys: mismatchedKeys });
    }
  });

  var missingConfigKeys = checkMissingConfigKeys_();

  return {
    ok: missingConfigKeys.length === 0 && missingSheets.length === 0 && missingColumns.length === 0,
    missingConfigKeys: missingConfigKeys,
    missingSheets: missingSheets,
    missingColumns: missingColumns
  };
}

/**
 * 用途：比對一張工作表第 2 行的機器鍵，跟 `COLUMNS` 定義在**同一個位置**
 *   是否相符——判斷方式刻意跟 `SheetUtils.gs` 的 `readSheet()` 一致
 *   （逐欄比對位置，不是「有沒有出現在某處」），這樣「結構落後」的定義
 *   在全專案只有一種，不會出現「schema 檢查說沒事、`readSheet()` 卻拋錯」
 *   這種兩邊各講各話的情況。
 * Args:
 *   sheet {Sheet} 已經確認存在的工作表物件。
 *   def {{headers:string[], keys:string[], types:string[]}} `COLUMNS` 的
 *     其中一個定義。
 * Returns:
 *   {string[]} 對不上的機器鍵（依程式定義的次序），完全相符回空陣列；
 *     連第 2 行都不完整（`getLastRow() < 2`）視為全部欄位都對不上。
 */
function findMismatchedColumnKeys_(sheet, def) {
  var colCount = def.keys.length;
  if (sheet.getLastRow() < 2) {
    return def.keys.slice();
  }

  var actualKeys = sheet.getRange(2, 1, 1, colCount).getValues()[0];
  var mismatched = [];
  for (var i = 0; i < def.keys.length; i++) {
    if (String(actualKeys[i]).trim() !== def.keys[i]) {
      mismatched.push(def.keys[i]);
    }
  }
  return mismatched;
}

/**
 * 用途：比對 `Config` 工作表現有的設定鍵，跟 `DEFAULTS` 定義的完整清單，
 *   列出缺少的鍵。`Config` 工作表本身完全不存在時，`DEFAULTS` 全部視為
 *   缺少。
 * Args: （無）
 * Returns:
 *   {string[]}
 */
function checkMissingConfigKeys_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEETS.CONFIG);
  if (!sheet) {
    return DEFAULTS.map(function (d) { return d.key; });
  }

  var lastRow = sheet.getLastRow();
  var existingKeys = {};
  if (lastRow >= 3) {
    var values = sheet.getRange(3, 1, lastRow - 2, 1).getValues();
    values.forEach(function (row) {
      var k = coerceConfigRawValue_(row[0]);
      if (k) existingKeys[k] = true;
    });
  }

  return DEFAULTS.filter(function (d) { return !existingKeys[d.key]; }).map(function (d) { return d.key; });
}

/**
 * 用途：把 `checkSheetSchema_()` 的結果排成**一行**「缺 N 個設定鍵、M 張
 *   工作表、K 個欄位」這種計數摘要，供 `doGet` 的黃色橫幅（沒有地方放
 *   多行內容）與 `buildSchemaMismatchSummary_()` 共用第一行。
 * Args:
 *   result {Object} `checkSheetSchema_()` 的回傳值。
 * Returns:
 *   {string} `result.ok` 為 `true` 時回空字串。
 */
function buildSchemaShortSummary_(result) {
  if (result.ok) return '';
  var columnCount = result.missingColumns.reduce(function (sum, m) { return sum + m.keys.length; }, 0);
  return '缺 ' + result.missingConfigKeys.length + ' 個設定鍵、'
    + result.missingSheets.length + ' 張工作表、' + columnCount + ' 個欄位';
}

/**
 * 用途：把 `checkSheetSchema_()` 的結果排成一句（含換行）人看的完整摘要，
 *   供選單對話框、`apiSaveWeek` 的 `SCHEMA_OUTDATED` 錯誤訊息共用——
 *   兩個地方統一同一句措辭，不會各自寫一套。
 * Args:
 *   result {Object} `checkSheetSchema_()` 的回傳值。
 * Returns:
 *   {string} `result.ok` 為 `true` 時回空字串。
 */
function buildSchemaMismatchSummary_(result) {
  if (result.ok) return '';

  var lines = [buildSchemaShortSummary_(result) + '。'];

  if (result.missingConfigKeys.length > 0) {
    lines.push('缺少的設定鍵：' + result.missingConfigKeys.join('、'));
  }
  if (result.missingSheets.length > 0) {
    lines.push('缺少的工作表：' + result.missingSheets.join('、'));
  }
  result.missingColumns.forEach(function (m) {
    lines.push('工作表「' + m.sheet + '」欄位對不上：' + m.keys.join('、'));
  });

  return lines.join('\n');
}
