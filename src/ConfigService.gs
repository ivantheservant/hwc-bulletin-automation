/**
 * ConfigService.gs
 *
 * Config 工作表的讀寫與快取。getConfig()／setConfig() 是全系統讀寫設定的
 * 唯一入口，其他檔案一律不可以直接用 SpreadsheetApp 讀 Config 工作表。
 *
 * ⚠️ 設計上的重要限制：本檔案內讀取 Config 原始值一律用 coerceConfigRawValue_()，
 * 不可以用 SheetUtils.gs 的 normalizeText_()／readSheet()。原因是
 * normalizeText_() 在「文字欄位拿到 Date 物件」時會呼叫
 * Session.getScriptTimeZone()——這個呼叫本身不依賴 Config，是安全的；
 * 但如果將來有人把 normalizeText_() 改成依 Config 的 SYS_TIMEZONE 取時區，
 * 而 loadConfigCache_() 又呼叫 normalizeText_() 來讀 Config 自己的 VALUE 欄，
 * 就會變成「載入 Config 的過程需要先讀 Config」的無限遞迴。coerceConfigRawValue_()
 * 刻意保持零相依，從根本避免這個風險。
 */

'use strict';

/** 執行期記憶體快取（同一次執行內重複呼叫 getConfig() 不用重讀工作表）。 */
var CONFIG_CACHE_ = null;

/** CacheService 的 key；「重新載入設定」選單會清掉這個 key。 */
var CONFIG_CACHE_SERVICE_KEY_ = 'BULLETIN_CONFIG_CACHE_V1';

/** CacheService 的存活時間（秒）。21600 秒＝6 小時，是 CacheService 的上限。 */
var CONFIG_CACHE_TTL_SECONDS_ = 21600;

/**
 * 用途：讀取 Config 工作表的其中一個設定值。
 * Args:
 *   key {string} 設定鍵（建議一律用 CONFIG_KEYS 內的常數）。
 *   defaultValue {string=} 選填的預設值。有提供時，key 不存在會回這個值；
 *     沒有提供時，key 不存在會拋錯。
 * Returns:
 *   {string} 該設定的值。一律是文字（例如 DRY_RUN 的值會是字串 'TRUE'，
 *     不是 boolean），呼叫方需要別的型別時自行用 normalizeBoolean_() 等函式轉換。
 * Raises:
 *   Error 如果 key 不存在，而呼叫方沒有提供 defaultValue——缺失不可以靜靜
 *     變成 undefined 繼續往下傳。
 */
function getConfig(key, defaultValue) {
  var all = loadConfigCache_();
  if (Object.prototype.hasOwnProperty.call(all, key)) {
    return all[key];
  }
  if (arguments.length >= 2) {
    return defaultValue;
  }
  throw new Error('getConfig：Config 工作表沒有設定鍵「' + key + '」，呼叫方也沒有提供預設值。');
}

/**
 * 用途：寫入或更新 Config 工作表的其中一個設定值，同步清除快取並寫一筆
 *   稽核記錄。key 不存在時會新增一行（EDITABLE 預設 TRUE）。
 * Args:
 *   key {string} 設定鍵。
 *   value {string} 新值，一律當文字寫入。
 * Returns:
 *   {void}
 * Raises:
 *   Error 如果 key 是空字串。
 */
function setConfig(key, value) {
  if (!key) {
    throw new Error('setConfig：key 不可以是空字串。');
  }

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ensureSheet_(ss, 'CONFIG');
  var lastRow = sheet.getLastRow();
  var targetRow = -1;
  var oldValue = '';

  if (lastRow >= 3) {
    var keys = sheet.getRange(3, 1, lastRow - 2, 1).getValues();
    for (var i = 0; i < keys.length; i++) {
      if (coerceConfigRawValue_(keys[i][0]) === key) {
        targetRow = i + 3;
        break;
      }
    }
  }

  if (targetRow === -1) {
    writeSheet(SHEETS.CONFIG, [{ KEY: key, VALUE: value, NOTE: '', EDITABLE: true }]);
  } else {
    oldValue = coerceConfigRawValue_(sheet.getRange(targetRow, 2).getValue());
    sheet.getRange(targetRow, 2).setValue(value);
  }

  clearConfigCache_();
  appendAuditLog_({
    action: 'SET_CONFIG',
    sheetName: SHEETS.CONFIG,
    rowKey: key,
    field: 'VALUE',
    oldValue: oldValue,
    newValue: value
  });
}

/**
 * 用途：把 DEFAULTS 內尚未存在於 Config 工作表的設定鍵補進去；已存在的鍵
 *   一律不覆蓋（不論目前的值是什麼）。
 * Args: （無）
 * Returns:
 *   {number} 新增的設定鍵數量。
 */
function seedConfigDefaults_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ensureSheet_(ss, 'CONFIG');
  var lastRow = sheet.getLastRow();

  var existingKeys = {};
  if (lastRow >= 3) {
    var keys = sheet.getRange(3, 1, lastRow - 2, 1).getValues();
    keys.forEach(function (row) {
      var k = coerceConfigRawValue_(row[0]);
      if (k) existingKeys[k] = true;
    });
  }

  var missing = DEFAULTS.filter(function (d) { return !existingKeys[d.key]; });
  if (missing.length === 0) return 0;

  var rows = missing.map(function (d) {
    return { KEY: d.key, VALUE: d.value, NOTE: d.note || '', EDITABLE: true };
  });
  writeSheet(SHEETS.CONFIG, rows);
  clearConfigCache_();
  return rows.length;
}

/**
 * 用途：清除 Config 快取（記憶體＋CacheService）。下一次 getConfig() 會
 *   重新從工作表讀取。選單「重新載入設定（唯讀）」會呼叫這個函式。
 * Args: （無）
 * Returns:
 *   {void}
 */
function clearConfigCache_() {
  CONFIG_CACHE_ = null;
  try {
    CacheService.getScriptCache().remove(CONFIG_CACHE_SERVICE_KEY_);
  } catch (e) {
    // CacheService 在部分執行環境（例如某些簡易觸發器）可能無法使用；
    // 記憶體快取已經清了，CacheService 清不到不應該讓整個操作失敗。
  }
}

/**
 * 用途：載入 Config 工作表全部設定值：先查記憶體、再查 CacheService、
 *   最後才真正讀工作表並重建兩層快取。
 * Args: （無）
 * Returns:
 *   {Object<string,string>} 設定鍵到文字值的對照表。
 * Raises:
 *   Error 如果同一個 KEY 在 Config 工作表出現多於一次（兩個真相來源，
 *     必須由人手刪除重覆的一行才能繼續）。
 */
function loadConfigCache_() {
  if (CONFIG_CACHE_) return CONFIG_CACHE_;

  try {
    var cached = CacheService.getScriptCache().get(CONFIG_CACHE_SERVICE_KEY_);
    if (cached) {
      CONFIG_CACHE_ = JSON.parse(cached);
      return CONFIG_CACHE_;
    }
  } catch (e) {
    // CacheService 不可用時直接退回讀工作表，不阻擋 getConfig() 運作。
  }

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ensureSheet_(ss, 'CONFIG');
  var lastRow = sheet.getLastRow();
  var result = {};

  if (lastRow >= 3) {
    var values = sheet.getRange(3, 1, lastRow - 2, 2).getValues();
    var seenAtRow = {};
    values.forEach(function (row, idx) {
      var key = coerceConfigRawValue_(row[0]);
      if (!key) return;
      if (seenAtRow[key]) {
        throw new Error(
          'loadConfigCache_：Config 工作表的設定鍵「' + key + '」出現多於一次（第 '
          + seenAtRow[key] + ' 行與第 ' + (idx + 3) + ' 行），必須先人手刪除重覆的一行。'
        );
      }
      seenAtRow[key] = idx + 3;
      result[key] = coerceConfigRawValue_(row[1]);
    });
  }

  CONFIG_CACHE_ = result;
  try {
    CacheService.getScriptCache().put(CONFIG_CACHE_SERVICE_KEY_, JSON.stringify(result), CONFIG_CACHE_TTL_SECONDS_);
  } catch (e) {
    // 同上，CacheService 不可用時只用記憶體快取，不影響本次執行的正確性。
  }
  return result;
}

/**
 * 用途：把 Config KEY／VALUE 欄的原始儲存格值轉成文字，處理 Google Sheets
 *   的自動型別轉換（輸入 TRUE/FALSE 變成 boolean、日期形狀的字串變成 Date）。
 *   刻意不依賴 SheetUtils.gs 或其他設定，見檔案開頭的說明。
 * Args:
 *   v {*} 儲存格原始值。
 * Returns:
 *   {string} 正規化後的文字；空值一律回 ''。
 * Raises:
 *   Error 如果 v 是無法處理的型別（Sheets 儲存格理論上不會出現，屬於防呆）。
 */
function coerceConfigRawValue_(v) {
  if (v === null || v === undefined || v === '') return '';
  if (v instanceof Date) {
    return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') return v.trim();
  throw new Error('coerceConfigRawValue_：無法處理的型別（' + (typeof v) + '），值＝' + String(v));
}
