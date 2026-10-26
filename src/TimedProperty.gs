/**
 * TimedProperty.gs
 *
 * v3：「多久之內只做一次」的小記錄，存在指令碼屬性（`PropertiesService.getScriptProperties()`）。
 *
 * 用途只有兩個，而且都只是省時間，不是真相來源：
 *   - 開啟填寫介面時十分鐘內只檢查一次職事表有沒有新季度（src/QuarterAutoCreate.gs）；
 *   - 內容表版面是不是最新，十分鐘內不重複開內容表檢查（src/WebApp.gs）。
 *
 * ⚠️ 刻意不用 Apps Script 的快取服務：本專案規定不用跨執行快取（tests/configcache.test.js，docs/已知bug類型.md 事故三），
 *    以免人手改了東西之後讀到舊值。這裏記的東西過期就重新做一次，讀不到亦當作過期。
 */

'use strict';

/**
 * 用途：讀一個有時限的記錄；過期、讀不到、格式不對一律回 `null`。
 * Args:
 *   key {string} 屬性鍵。
 *   maxAgeSec {number} 多少秒之內算有效。
 * Returns:
 *   {?string} 記下的值。
 * Raises:
 *   （無）
 */
function readTimedScriptProperty_(key, maxAgeSec) {
  try {
    var raw = PropertiesService.getScriptProperties().getProperty(key);
    if (!raw) return null;
    var obj = JSON.parse(raw);
    var age = (new Date().getTime() - Number(obj.at)) / 1000;
    if (!isFinite(age) || age < 0 || age > maxAgeSec) return null;
    return typeof obj.value === 'string' ? obj.value : null;
  } catch (err) {
    return null;
  }
}

/**
 * 用途：寫一個有時限的記錄（連同現在的時間）。寫不到就算——下一次再做一次。
 * Args:
 *   key {string} 屬性鍵。
 *   value {string} 要記的值。
 * Returns:
 *   {void}
 * Raises:
 *   （無）
 */
function writeTimedScriptProperty_(key, value) {
  try {
    PropertiesService.getScriptProperties().setProperty(key, JSON.stringify({ at: new Date().getTime(), value: String(value) }));
  } catch (err) {
    // 寫不到只是下一次再做一次。
  }
}

/**
 * 用途：刪走一個有時限的記錄。
 * Args:
 *   key {string} 屬性鍵。
 * Returns:
 *   {void}
 * Raises:
 *   （無）
 */
function deleteTimedScriptProperty_(key) {
  try {
    PropertiesService.getScriptProperties().deleteProperty(key);
  } catch (err) {
    // 刪不到最多十分鐘之後自己過期。
  }
}
