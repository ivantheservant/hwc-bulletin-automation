/**
 * src/RosterCache.gs
 *
 * 2026-11-03（Ivan：載入慢，「沒有風險、不影響讀到最新改動」就做職事表快取）：
 *   職事表六張表（RosterAssignments 約五千行）每次載入都要開職事表、讀一次，是載入其中一段最慢的。
 *   讀完之後把結果存在週報試算表一張隱藏的工作表（`_職事表快取`），下一次先看職事表檔案的修改時間：
 *     - 修改時間與存的時候一樣、存了未超過十分鐘、程式版本一樣 → 用存起來的（不開職事表）；
 *     - 否則（職事表有人改過、讀不到修改時間、記錄壞了）→ 照舊開職事表讀，再存一次。
 *   只有網頁載入用快取（`withRosterCacheMode_('USE', …)`）；觸發器、產生 Word、寄出、發佈一律直接讀職事表。
 *   「重新讀取職事表」「重新載入（全部讀最新）」不看快取（`'REFRESH'`），讀完把快取換成最新。
 *
 *   ⚠️ 唯讀邊界不變：這個檔案不開職事表（沒有 openById）、沒有 DriveApp；修改時間經 src/DriveShared.gs
 *   `driveFileLastUpdatedMillis_()`（只讀修改時間）。寫入的是**週報自己的試算表**那一張隱藏工作表，職事表一格都不寫。
 *   快取只是省時間，不是真相來源：任何讀不到、對不上一律當作沒有快取。
 */

'use strict';

var ROSTER_CACHE_SHEET_NAME_ = '_職事表快取';
var ROSTER_CACHE_MAX_AGE_MS_ = 10 * 60 * 1000;
var ROSTER_CACHE_CHUNK_CHARS_ = 45000;
var ROSTER_CACHE_MAX_CHARS_ = 3000000;
/** 職事表讀法（RosterRead.gs 的表定義、正規化）改了就改這個值，舊快取一律作廢。 */
var ROSTER_CACHE_VERSION_ = '2026-11-03';

/**
 * 這一次執行的快取模式（每次執行由 OFF 開始，不跨執行）：
 *   OFF     ＝不讀、不存（預設：觸發器、產生 Word、寄出、發佈一律直接讀職事表）；
 *   USE     ＝網頁載入：先看快取，用不到才讀職事表，再存；
 *   REFRESH ＝「重新讀取職事表」「重新載入（全部讀最新）」：不看快取，讀職事表之後把快取換成最新。
 */
var ROSTER_CACHE_MODES_ = { OFF: 'OFF', USE: 'USE', REFRESH: 'REFRESH' };
var ROSTER_CACHE_MODE_ = 'OFF';

/**
 * 用途：設定這一次執行的職事表快取模式。
 * Args:
 *   mode {string} ROSTER_CACHE_MODES_ 其中一個；其他值當作 OFF。
 * Returns:
 *   {string} 設定之前的模式（呼叫的一方用完之後還原）。
 */
function setRosterCacheMode_(mode) {
  var previous = ROSTER_CACHE_MODE_;
  ROSTER_CACHE_MODE_ = (mode === ROSTER_CACHE_MODES_.USE || mode === ROSTER_CACHE_MODES_.REFRESH) ? mode : ROSTER_CACHE_MODES_.OFF;
  return previous;
}

/**
 * 用途：在指定的快取模式之下執行 fn，完成（或出錯）之後還原原來的模式。
 * Args:
 *   mode {string}　fn {function():*}
 * Returns:
 *   {*} fn 的結果。
 */
function withRosterCacheMode_(mode, fn) {
  var previous = setRosterCacheMode_(mode);
  try {
    return fn();
  } finally {
    setRosterCacheMode_(previous);
  }
}

/**
 * 用途：快取的識別：試算表 ID、六張表的名稱、程式版本。純函式。
 */
function rosterCacheKey_(spreadsheetId, sheetNames) {
  return [ROSTER_CACHE_VERSION_, String(spreadsheetId || ''), JSON.stringify(sheetNames || {})].join('|');
}

/**
 * 用途：把職事表讀出來的資料轉成文字（日期記成 {"$d":毫秒}）。純函式。
 */
function serializeRosterTables_(result) {
  return JSON.stringify(result, function (k, v) {
    var raw = this[k];
    if (raw instanceof Date) return { $d: raw.getTime() };
    return v;
  });
}

/**
 * 用途：`serializeRosterTables_()` 的反向。純函式。
 */
function parseRosterTables_(text) {
  return JSON.parse(text, function (k, v) {
    if (v && typeof v === 'object' && Object.keys(v).length === 1 && typeof v.$d === 'number') return new Date(v.$d);
    return v;
  });
}

/**
 * 用途：讀快取。IO 層（讀職事表修改時間、讀週報試算表的隱藏工作表）。
 * Args:
 *   spreadsheetId {string}　sheetNames {Object}
 * Returns:
 *   {{result:?Object, mtime:?number}} `result` 有值＝可以用；`mtime` 是這一次讀到的職事表修改時間
 *     （沒有快取時，讀完職事表用它存快取——一定要用**讀之前**的修改時間）。
 */
function readRosterCache_(spreadsheetId, sheetNames) {
  if (ROSTER_CACHE_MODE_ === ROSTER_CACHE_MODES_.OFF) return { result: null, mtime: null };
  var mtime = driveFileLastUpdatedMillis_(spreadsheetId);
  // 「讀最新」：照樣開職事表，讀完用這一次的修改時間把快取換成最新的。
  if (ROSTER_CACHE_MODE_ === ROSTER_CACHE_MODES_.REFRESH || mtime === null) return { result: null, mtime: mtime };
  try {
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(ROSTER_CACHE_SHEET_NAME_);
    if (!sheet) return { result: null, mtime: mtime };
    var lastRow = Number(sheet.getLastRow()) || 0;
    if (lastRow < 2) return { result: null, mtime: mtime };
    var cells = sheet.getRange(1, 1, lastRow, 1).getValues();
    var meta = JSON.parse(String(cells[0][0] || '').replace(/^R/, '') || 'null');
    if (!meta || meta.key !== rosterCacheKey_(spreadsheetId, sheetNames) || meta.mtime !== mtime) return { result: null, mtime: mtime };
    if (!(Date.now() - Number(meta.savedAt || 0) <= ROSTER_CACHE_MAX_AGE_MS_)) return { result: null, mtime: mtime };
    if (Number(meta.chunks) !== lastRow - 1) return { result: null, mtime: mtime };
    var text = cells.slice(1).map(function (r) { return String(r[0] || '').replace(/^R/, ''); }).join('');
    if (text.length !== Number(meta.length)) return { result: null, mtime: mtime };
    var result = parseRosterTables_(text);
    if (!result || !result.tables) return { result: null, mtime: mtime };
    return { result: result, mtime: mtime };
  } catch (err) {
    return { result: null, mtime: mtime };
  }
}

/**
 * 用途：存快取（週報試算表的隱藏工作表；沒有就建立）。寫不到、太大一律略過，不影響載入。IO 層。
 * Args:
 *   spreadsheetId {string}　sheetNames {Object}　result {Object} `fetchRosterTables_()` 的輸出。
 *   mtime {?number} 讀職事表**之前**讀到的修改時間；`null` 就不存。
 * Returns:
 *   {boolean} 有沒有存。
 */
function storeRosterCache_(spreadsheetId, sheetNames, result, mtime) {
  if (ROSTER_CACHE_MODE_ === ROSTER_CACHE_MODES_.OFF || mtime === null || mtime === undefined) return false;
  try {
    var text = serializeRosterTables_(result);
    if (text.length > ROSTER_CACHE_MAX_CHARS_) return false;
    var chunks = [];
    for (var i = 0; i < text.length; i += ROSTER_CACHE_CHUNK_CHARS_) chunks.push(text.slice(i, i + ROSTER_CACHE_CHUNK_CHARS_));
    var meta = { key: rosterCacheKey_(spreadsheetId, sheetNames), mtime: mtime, savedAt: Date.now(), chunks: chunks.length, length: text.length };
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(ROSTER_CACHE_SHEET_NAME_);
    if (!sheet) {
      sheet = ss.insertSheet(ROSTER_CACHE_SHEET_NAME_);
      sheet.hideSheet();
    }
    sheet.clearContents();
    var rows = [['R' + JSON.stringify(meta)]].concat(chunks.map(function (c) { return ['R' + c]; }));
    if ((Number(sheet.getMaxRows()) || 0) < rows.length) sheet.insertRowsAfter(Math.max(1, Number(sheet.getMaxRows()) || 1), rows.length);
    var range = sheet.getRange(1, 1, rows.length, 1);
    range.setNumberFormat('@');
    range.setValues(rows);
    return true;
  } catch (err) {
    return false;
  }
}
