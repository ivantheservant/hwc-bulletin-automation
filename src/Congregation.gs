/**
 * src/Congregation.gs
 *
 * 2026-11-03（Ivan：多堂會，先準備「甲、同一份程式碼、多個部署」）：同一教會內不同堂會各自一個部署（各自的
 * Apps Script 專案、試算表、雲端硬碟資料夾、Config），資料完全分開。堂會專屬的字一律由 Config 讀，不寫在程式碼：
 *   - `CONGREGATION_NAME`（例如「粵語堂」）：填寫介面標題、電郵 {{CongregationName}}、內容表邀請信標題、
 *     檔名樣式的 {{CONGREGATION}}；
 *   - 其餘（教會全名、財政報告標題、人數表欄名、聚會時間、教牧同工、範本、收件人……）本來已經是 Config／工作表。
 * 清單與新堂會建立步驟見 docs/多堂會部署.md。
 */

'use strict';

/** `CONGREGATION_NAME` 未填時用的值（與 Config 預設值相同）。 */
var CONGREGATION_NAME_DEFAULT_ = '粵語堂';

/**
 * 用途：這一個部署屬於哪一個堂會（Config `CONGREGATION_NAME`）。空白用預設值。
 * Returns:
 *   {string}
 */
function congregationName_() {
  var v = String(getConfig_(CONFIG_KEYS.CONGREGATION_NAME, CONGREGATION_NAME_DEFAULT_) || '').trim();
  return v || CONGREGATION_NAME_DEFAULT_;
}

/**
 * 用途：把文字內的 `{{CONGREGATION}}` 換成堂會名稱（檔名樣式、表格標題用）。沒有這個佔位符就原樣回。
 * Args:
 *   text {*}
 * Returns:
 *   {string}
 */
function applyCongregationToken_(text) {
  var s = String(text === null || text === undefined ? '' : text);
  return s.indexOf('{{CONGREGATION}}') === -1 ? s : s.split('{{CONGREGATION}}').join(congregationName_());
}
