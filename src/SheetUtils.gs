/**
 * SheetUtils.gs
 *
 * 工作表存取的共用工具：確保工作表存在（ensureSheet_）、通用讀取
 * （readSheet）、通用附加寫入（writeSheet），型別正規化層
 * （normalizeBoolean_／normalizeText_／normalizeDate_／normalizeInt_），
 * 以及防止字串被 Sheets 當成公式求值的 sanitizeCellText_()。
 *
 * 型別正規化層存在的原因：Google Sheets 會自動把 `TRUE`／`FALSE` 正規化成
 * boolean、把日期形狀的字串正規化成 Date 物件，如果不處理，「本來想要字串
 * 卻拿到 Date」這類狀況會被靜靜當成正常值往下傳。readSheet() 內部一律呼叫
 * 這四個函式，缺失或型別不符一律明確拋錯。
 */

'use strict';

// =====================================================================
// 型別警告收集——normalizeText_() 偵測到「文字欄位拿到 Date 物件」時，
// 不會拋錯（因為已經自動轉回文字、資料沒有遺失），但會記一筆警告在這裡，
// 由呼叫方（例如 Bootstrap.gs 的 initializeAllSheets()）決定何時、以什麼
// 形式（通常是 writeDiagnosticsReport_()）呈現出來。
// =====================================================================

var SHEETUTILS_TYPE_WARNINGS_ = [];

/**
 * 用途：取得目前累積的型別警告清單。
 * Args: （無）
 * Returns:
 *   {{sheet:string, key:string, row:(number|null), message:string}[]}
 */
function getSheetUtilsTypeWarnings_() {
  return SHEETUTILS_TYPE_WARNINGS_.slice();
}

/**
 * 用途：清空型別警告清單（通常在警告已經寫進 Diagnostics 之後呼叫）。
 * Args: （無）
 * Returns:
 *   {void}
 */
function clearSheetUtilsTypeWarnings_() {
  SHEETUTILS_TYPE_WARNINGS_ = [];
}

// =====================================================================
// 型別正規化
// =====================================================================

/**
 * 用途：把儲存格值正規化成 boolean。
 * Args:
 *   v {*} 儲存格原始值。
 * Returns:
 *   {?boolean} 正規化後的值；空值（''／null／undefined）回 null，
 *     代表「未填」，不是 false。
 * Raises:
 *   Error 如果 v 不是 boolean、'TRUE'/'FALSE'（不分大小寫）、'是'/'否'、或空值。
 *     無法判斷時一律拋錯，不可以默默當 false。
 */
function normalizeBoolean_(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    var t = v.trim();
    var upper = t.toUpperCase();
    if (upper === 'TRUE') return true;
    if (upper === 'FALSE') return false;
    if (t === '是') return true;
    if (t === '否') return false;
  }
  throw new Error('normalizeBoolean_：無法判斷是否為 TRUE/FALSE，值＝' + JSON.stringify(v));
}

/**
 * 用途：把儲存格值正規化成文字。如果偵測到 Sheets 把本來的文字誤判成
 *   Date 物件，會用 Session.getScriptTimeZone() 轉回 yyyy-MM-dd 文字，
 *   並在 SHEETUTILS_TYPE_WARNINGS_ 記一筆警告（不會拋錯，因為資料沒有遺失）。
 * Args:
 *   v {*} 儲存格原始值。
 *   context {{sheet:string, key:string, row:number}=} 選填，只用來讓警告
 *     訊息講得出「哪一個工作表、哪一欄、第幾行」，不影響回傳值本身。
 * Returns:
 *   {string} 正規化後的文字；空值一律回 ''。
 * Raises:
 *   Error 如果 v 不是 string／number／boolean／Date／null／undefined。
 */
function normalizeText_(v, context) {
  if (v === null || v === undefined || v === '') return '';
  if (v instanceof Date) {
    var tz = Session.getScriptTimeZone();
    var formatted = Utilities.formatDate(v, tz, 'yyyy-MM-dd');
    SHEETUTILS_TYPE_WARNINGS_.push({
      sheet: (context && context.sheet) || '（未知工作表）',
      key: (context && context.key) || '（未知欄位）',
      row: (context && context.row) || null,
      message: '欄位本應為文字，但讀到 Date 物件（已自動轉回文字：' + formatted + '）。'
        + '請檢查這個儲存格是否被 Google Sheets 誤判成日期格式。'
    });
    return formatted;
  }
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') return v.trim();
  throw new Error('normalizeText_：無法處理的型別（' + (typeof v) + '），值＝' + String(v));
}

/**
 * 用途：把儲存格值正規化成 Date 物件。
 * Args:
 *   v {*} 儲存格原始值。
 * Returns:
 *   {?Date} 正規化後的 Date；空值回 null。
 * Raises:
 *   Error 如果 v 不是 Date 物件，也不是合法的 yyyy-MM-dd 字串（含格式對但
 *     日期不存在，例如 2026-13-40）。
 */
function normalizeDate_(v) {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) return v;
  if (typeof v === 'string') {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v.trim());
    if (m) {
      var y = Number(m[1]);
      var mo = Number(m[2]);
      var d = Number(m[3]);
      var date = new Date(y, mo - 1, d);
      // JS 的 Date 建構子對超出範圍的月／日會自動進位（例如 13 月會變成
      // 下一年的 1 月），必須反查回去確認三個欄位真的對得上，否則
      // 「格式正確但日期不存在」的錯字會被靜靜接受成另一個日期。
      if (date.getFullYear() === y && date.getMonth() === mo - 1 && date.getDate() === d) {
        return date;
      }
    }
  }
  throw new Error('normalizeDate_：不是 Date 物件、也不是合法的 yyyy-MM-dd 字串，值＝' + JSON.stringify(v));
}

/**
 * 用途：把儲存格值正規化成整數。
 * Args:
 *   v {*} 儲存格原始值。
 * Returns:
 *   {?number} 正規化後的整數；空值回 null。
 * Raises:
 *   Error 如果 v 不是空值，也不是合法整數（number 或整數形狀的字串）。
 */
function normalizeInt_(v) {
  if (v === null || v === undefined || v === '') return null;
  var n;
  if (typeof v === 'number') {
    n = v;
  } else if (typeof v === 'string') {
    var t = v.trim();
    if (t === '') return null;
    n = Number(t);
  } else {
    throw new Error('normalizeInt_：不是數字，值＝' + JSON.stringify(v));
  }
  if (!Number.isFinite(n) || Math.floor(n) !== n) {
    throw new Error('normalizeInt_：不是合法整數，值＝' + JSON.stringify(v));
  }
  return n;
}

/**
 * 用途：依 COLUMN_TYPES 的型別名稱，分派到對應的 normalize*_() 函式。
 *   readSheet() 內部用這個函式逐欄正規化。
 * Args:
 *   type {string} COLUMN_TYPES 的其中一個值。
 *   raw {*} 儲存格原始值。
 *   context {{sheet:string, key:string, row:number}=} 選填，轉交給
 *     normalizeText_() 用來標註警告訊息。
 * Returns:
 *   {*} 正規化後的值，型別依 type 而定。
 * Raises:
 *   Error 如果 type 不是 COLUMN_TYPES 內任何一個已知值，或底層 normalize*_()
 *     函式拋錯（原樣往上拋）。
 */
function normalizeByType_(type, raw, context) {
  switch (type) {
    case COLUMN_TYPES.TEXT:
      return normalizeText_(raw, context);
    case COLUMN_TYPES.DATE:
      return normalizeDate_(raw);
    case COLUMN_TYPES.BOOLEAN:
      return normalizeBoolean_(raw);
    case COLUMN_TYPES.INT:
      return normalizeInt_(raw);
    default:
      throw new Error('normalizeByType_：未知的欄位型別「' + type + '」。');
  }
}

// =====================================================================
// 防止字串被當成公式求值
// =====================================================================

/**
 * 用途：防止字串被 Google Sheets 的 `setValues()`／`setValue()` 當成公式
 *   求值。凡是字串以 `=`／`+`／`-`／`@` 其中一個字元開頭，就在前面加一個
 *   半形單引號，強制 Sheets 當成純文字；其餘型別與不需要跳脫的字串一律
 *   原樣回傳。
 *
 *   ⚠️ 事故：「週報資料模型預覽」的區段標題 `'=== 基本資料 ==='` 經
 *   `writeDiagnosticsReport_()` 的 `setValues()` 寫入 Diagnostics 後，
 *   因為以 `=` 開頭，被 Sheets 當成公式求值，整格變成 `#ERROR!`。
 *   `setValues()`／`setValue()` 跟使用者在儲存格介面手動打字不一樣，
 *   沒有「這一欄是純文字格式」這道防線可以攔（`textFormatColumns` 只保護
 *   固定的欄，Diagnostics／AuditLog 這類每次內容都不一樣的欄位沒辦法
 *   預先鎖死格式）——凡是**系統自己組出來、經 `writeSheet()` 整批寫入**
 *   的文字，尤其是 `Diagnostics`／`AuditLog`／`SendLog`（見
 *   docs/已知bug類型.md 事故六），一律要在寫入前經過這個函式。
 * Args:
 *   value {*} 任意值。
 * Returns:
 *   {*} 只有「字串、而且以 `=`／`+`／`-`／`@` 開頭」才會加上前導單引號；
 *     其餘型別（`number`／`boolean`／`Date`／`null`／`undefined`）與不需要
 *     跳脫的字串一律原樣回傳。
 */
function sanitizeCellText_(value) {
  if (typeof value !== 'string' || value.length === 0) return value;
  var firstChar = value.charAt(0);
  if (firstChar === '=' || firstChar === '+' || firstChar === '-' || firstChar === '@') {
    return "'" + value;
  }
  return value;
}

/**
 * 用途：把一封郵件的內文縮成 `SendLog.BODY_PREVIEW` 要存的摘要——去掉
 *   HTML 標籤、壓平連續空白、截到 `SEND_LOG_BODY_PREVIEW_CHARS` 個字元，
 *   最後再經 `sanitizeCellText_()`。**純函式。**
 *
 *   ⚠️ 存在理由：`DRY_RUN=TRUE` 之下如果只記收件人而不記內容，就沒有
 *   辦法在不真寄的情況下檢查電郵格式——而那正是試行模式最主要的用途。
 *
 *   ⚠️ 去 HTML 標籤不是為了美觀，是為了**讓人一眼看得出內容對不對**：
 *   原始 HTML 塞進一個儲存格只會看到一堆 `<td style=...>`，真正的文字
 *   淹沒在裡面。要看原始 HTML 的話有「預覽週報郵件內容」那個選單。
 *
 *   ⚠️ 被截斷時會在結尾加一句講明，不可以靜靜截走——看的人必須分得出
 *   「內文就是這麼短」與「後面還有，只是沒有存」。
 * Args:
 *   body {*} 郵件內文（HTML 或純文字皆可）。
 *   maxChars {number=} 選填，預設 `SEND_LOG_BODY_PREVIEW_CHARS`。
 * Returns:
 *   {*} 經 `sanitizeCellText_()` 處理過的字串；`body` 是空值時回空字串。
 */
function buildSendLogBodyPreview_(body, maxChars) {
  var text = String(body === null || body === undefined ? '' : body);
  if (!text) return '';

  var limit = Number(maxChars) > 0 ? Number(maxChars) : SEND_LOG_BODY_PREVIEW_CHARS;
  var plain = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  if (plain.length > limit) {
    plain = plain.slice(0, limit) + '…（內文較長，只存前 ' + limit + ' 個字元）';
  }
  return sanitizeCellText_(plain);
}

// =====================================================================
// 工作表存取
// =====================================================================

/**
 * 用途：確保指定工作表存在，並且第 1／2 行標題正確、凍結前兩行、套用
 *   textFormatColumns 指定的純文字格式。冪等：已存在的工作表只會補回
 *   標題，不會清空第 3 行以後的資料。
 * Args:
 *   ss {Spreadsheet} 目標試算表。
 *   sheetId {string} SHEETS／COLUMNS 共用的 key（例如 'BULLETIN_WEEKS'）。
 * Returns:
 *   {Sheet} 對應的工作表物件。
 * Raises:
 *   Error 如果 sheetId 不在 SHEETS／COLUMNS 定義內。
 */
function ensureSheet_(ss, sheetId) {
  var name = SHEETS[sheetId];
  var def = COLUMNS[sheetId];
  if (!name || !def) {
    throw new Error('ensureSheet_：未知的 sheetId「' + sheetId + '」。');
  }

  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
  }

  sheet.getRange(1, 1, 1, def.headers.length).setValues([def.headers]);
  sheet.getRange(2, 1, 1, def.keys.length).setValues([def.keys]);
  sheet.getRange(1, 1, 2, def.headers.length).setFontWeight('bold');
  sheet.getRange(1, 1, 1, def.headers.length).setBackground('#d9d9d9');
  if (sheet.getFrozenRows() < 2) {
    sheet.setFrozenRows(2);
  }

  (def.textFormatColumns || []).forEach(function (key) {
    var colIndex = def.keys.indexOf(key) + 1;
    if (colIndex > 0) {
      var maxRows = Math.max(sheet.getMaxRows() - 2, 1);
      sheet.getRange(3, colIndex, maxRows, 1).setNumberFormat('@');
    }
  });

  return sheet;
}

/**
 * 用途：讀取指定工作表由第 3 行開始的資料，依 COLUMNS 定義做型別正規化。
 * Args:
 *   sheetName {string} 工作表名稱（即 SHEETS 內的其中一個值，例如
 *     'BulletinWeeks'）。
 * Returns:
 *   {Object[]} 陣列，每個元素是一個以機器鍵為 key 的物件。整行皆空白的
 *     資料列會被略過，不會出現在回傳結果內。
 * Raises:
 *   Error 如果工作表不存在，或第 2 行機器鍵與 COLUMNS 定義不符（代表工作表
 *     結構跑位，必須先重新執行「初始化工作表」），或任何一格的值無法正規化。
 */
function readSheet(sheetName) {
  var sheetId = SHEET_ID_BY_NAME[sheetName];
  if (!sheetId) {
    throw new Error('readSheet：未知的工作表名稱「' + sheetName + '」。');
  }
  var def = COLUMNS[sheetId];

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    throw new Error('readSheet：找不到工作表「' + sheetName + '」，請先執行「初始化工作表」。');
  }

  var lastRow = sheet.getLastRow();
  var colCount = def.keys.length;
  if (lastRow < 2) {
    throw new Error('readSheet：工作表「' + sheetName + '」連標題都不完整，請先執行「初始化工作表」。');
  }

  var actualKeys = sheet.getRange(2, 1, 1, colCount).getValues()[0];
  for (var i = 0; i < def.keys.length; i++) {
    if (String(actualKeys[i]).trim() !== def.keys[i]) {
      throw new Error(
        'readSheet：工作表「' + sheetName + '」第 2 行機器鍵與程式定義不符（第 ' + (i + 1)
        + ' 欄，預期「' + def.keys[i] + '」，實際讀到「' + actualKeys[i] + '」）。'
        + '請先執行「初始化工作表」，如果仍然不符，代表工作表結構被人手改動過。'
      );
    }
  }

  if (lastRow < 3) return [];

  var values = sheet.getRange(3, 1, lastRow - 2, colCount).getValues();
  var results = [];

  for (var r = 0; r < values.length; r++) {
    var row = values[r];
    var isBlank = row.every(function (cell) { return cell === '' || cell === null; });
    if (isBlank) continue;

    var obj = {};
    for (var c = 0; c < def.keys.length; c++) {
      var key = def.keys[c];
      var type = def.types[c];
      var raw = row[c];
      var context = { sheet: sheetName, key: key, row: r + 3 };
      try {
        obj[key] = normalizeByType_(type, raw, context);
      } catch (err) {
        throw new Error(
          'readSheet：工作表「' + sheetName + '」第 ' + (r + 3) + ' 行、欄位「' + key
          + '」的值無法正規化：' + err.message
        );
      }
    }
    results.push(obj);
  }

  return results;
}

/**
 * 用途：把一批資料列附加寫入指定工作表的最後面（由現有資料的下一行開始），
 *   依 COLUMNS 定義的欄位順序寫入。不會刪除或覆寫任何既有資料列，符合
 *   「不刪行」的慣例。
 * Args:
 *   sheetName {string} 工作表名稱。
 *   rows {Object[]} 每個元素是以機器鍵為 key 的物件；缺少的鍵一律寫成
 *     空字串，值是 undefined／null 的鍵也一律寫成空字串。
 * Returns:
 *   {number} 實際寫入的資料列數（rows 是空陣列或未提供時回 0）。
 * Raises:
 *   Error 如果工作表不存在，或 rows 內含 COLUMNS 定義以外的機器鍵
 *     （代表呼叫方拼錯欄位名稱，寧可拋錯也不要靜靜寫進錯的欄）。
 */
function writeSheet(sheetName, rows) {
  if (!rows || rows.length === 0) return 0;

  var sheetId = SHEET_ID_BY_NAME[sheetName];
  if (!sheetId) {
    throw new Error('writeSheet：未知的工作表名稱「' + sheetName + '」。');
  }
  var def = COLUMNS[sheetId];

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    throw new Error('writeSheet：找不到工作表「' + sheetName + '」，請先執行「初始化工作表」。');
  }

  var values = rows.map(function (rowObj) {
    var unknownKeys = Object.keys(rowObj).filter(function (k) { return def.keys.indexOf(k) === -1; });
    if (unknownKeys.length > 0) {
      throw new Error(
        'writeSheet：工作表「' + sheetName + '」不認識的機器鍵：' + unknownKeys.join('、')
      );
    }
    return def.keys.map(function (key) {
      var v = rowObj[key];
      return (v === undefined || v === null) ? '' : v;
    });
  });

  var startRow = Math.max(sheet.getLastRow() + 1, 3);
  sheet.getRange(startRow, 1, values.length, def.keys.length).setValues(values);
  return values.length;
}
