/**
 * src/ContentCarryOver.gs
 *
 * 2026-10-30（Ivan）：內容表「連續到」跨季。
 *
 *   - 「家事報告」「代禱事項」的「連續到」下拉，除了本季的主日，再加下一季的頭幾個主日
 *     （Config `CONTENT_REPEAT_UNTIL_NEXT_QUARTER_WEEKS`，預設 13；0＝只可以選本季）。
 *   - 匯入某一季（previewContentImport_()）時，同時讀**上一季**的內容表：主日日期在本季之前、
 *     「連續到」在本季第一個主日或之後、生效中的行，帶入本季由第一個主日至「連續到」那幾個主日。
 *   - **只有一個真相來源**：那一行仍然只在上一季的內容表（不複製到本季的內容表）；要改內容、停用、
 *     縮短，改上一季那一行就可以。內容表自動同步會一併看上一季內容表的修改時間（src/ContentAutoSync.gs）。
 *   - 上一季沒有內容表＝正常（沒有東西帶過來）；有內容表但開不到、版面未更新、或那一行有格被轉成
 *     日期／時間——講出來（匯入的警告），不可以靜靜當沒有（bug class 2）。
 *   - 同一個主日內的次序：照「次序」；次序相同就按主日日期，上一季帶過來的排前（與同一季內
 *     「連續到」帶過來的舊一行排前同一條規則，compareContentRowsBySeq_()）。
 */

'use strict';

/**
 * 用途：上一季的季度 ID（例如 2028T1 → 2027T4）。純函式。
 * Args:
 *   quarterId {string} `YYYYTn`，n 是 1–4。
 * Returns:
 *   {string} 格式不對回空字串。
 * Raises:
 *   （無）
 */
function previousQuarterId_(quarterId) {
  var m = /^(\d{4})T([1-4])$/.exec(String(quarterId || '').trim());
  if (!m) return '';
  var year = Number(m[1]);
  var q = Number(m[2]);
  return q === 1 ? (year - 1) + 'T4' : year + 'T' + (q - 1);
}

/**
 * 用途：「連續到」下拉的選項：本季全部主日，再加最後一個主日之後的 `extraWeeks` 個主日（每隔七日）。純函式。
 * Args:
 *   serviceDates {string[]} 本季主日，yyyy-MM-dd，由舊到新。
 *   extraWeeks {number} 下一季可以選幾多個主日；不是正整數當 0。
 * Returns:
 *   {string[]}
 * Raises:
 *   （無）
 */
function contentRepeatUntilOptions_(serviceDates, extraWeeks) {
  var out = (serviceDates || []).slice();
  var n = Number(extraWeeks);
  if (!Number.isFinite(n) || n <= 0 || out.length === 0) return out;
  var last = out[out.length - 1];
  var time = isoDateToTime_(last);
  if (time === null) return out;
  var base = new Date(time);
  for (var k = 1; k <= Math.floor(n); k++) {
    out.push(formatIsoDate_(new Date(base.getFullYear(), base.getMonth(), base.getDate() + 7 * k)));
  }
  return out;
}

/**
 * 用途：讀 Config `CONTENT_REPEAT_UNTIL_NEXT_QUARTER_WEEKS`。不合法（負數、不是整數）當 0，並不拋錯
 *   （0＝只可以選本季，是安全的做法）。
 * Args: （無）
 * Returns:
 *   {number}
 */
function contentRepeatUntilExtraWeeks_() {
  var n = normalizeInt_(getConfig(CONFIG_KEYS.CONTENT_REPEAT_UNTIL_NEXT_QUARTER_WEEKS, '13'));
  return (n === null || n < 0) ? 0 : n;
}

/**
 * 用途：由上一季內容表的資料，揀出要帶入本季的行。純函式。
 * Args:
 *   contentData {Object<string,Object[]>} 上一季的 `readContentSheetTabs_()`。
 *   firstIso {string} 本季第一個主日。
 *   sourceQuarterId {string} 上一季的季度 ID（只用來寫警告）。
 * Returns:
 *   {{rowsByTab:Object<string,Object[]>, warnings:string[]}} 只包括有「連續到」的清單分頁。
 * Raises:
 *   （無）
 */
function selectContentCarryOverRows_(contentData, firstIso, sourceQuarterId) {
  var out = { rowsByTab: {}, warnings: [] };
  var first = String(firstIso || '').trim();
  if (!first) return out;
  contentImportTargets_().forEach(function (def) {
    if (def.kind !== 'LIST' || def.repeatUntil !== true) return;
    var picked = [];
    ((contentData || {})[def.tabName] || []).forEach(function (row) {
      if (row.__active !== true) return;
      var start = String(row.SERVICE_DATE || '').trim();
      var until = String(row.REPEAT_UNTIL || '').trim();
      var issues = row.__typeIssues || [];
      if (issues.length > 0) {
        // 結構欄被轉了就不知道這一行連到哪一日；其餘欄被轉了內容不可信。兩樣都不帶，講出來。
        if (issues.indexOf('REPEAT_UNTIL') !== -1 || (until && until >= first)) {
          out.warnings.push('上一季（' + sourceQuarterId + '）內容表「' + def.tabName + '」第 ' + row.__rowNo
            + ' 行有格被試算表轉成日期／時間，這一次沒有帶入本季。請在上一季的內容表把那一格改回純文字，再重新輸入。');
        }
        return;
      }
      if (!start || !until || start >= first || until < first) return;
      picked.push(Object.assign({}, row, { __carriedFromQuarter: sourceQuarterId }));
    });
    if (picked.length > 0) out.rowsByTab[def.tabName] = picked;
  });
  return out;
}

/**
 * 用途：把上一季帶過來的行展開成本季逐個主日：由本季第一個主日至「連續到」（不遲於它的最後一個主日）。
 *   「主日日期」保留上一季的原值（排次序用：同次序時舊的排前）。純函式。
 * Args:
 *   rows {Object[]} `selectContentCarryOverRows_()` 揀出來的行。
 *   serviceDates {string[]} 本季全部主日，由舊到新。
 * Returns:
 *   {Object[]} 每個元素多一個 `__isoDate`。
 * Raises:
 *   （無）
 */
function expandContentCarryOverRows_(rows, serviceDates) {
  var out = [];
  (rows || []).forEach(function (row) {
    var until = String(row.REPEAT_UNTIL || '').trim();
    (serviceDates || []).forEach(function (iso) {
      if (iso <= until) out.push(Object.assign({}, row, { __isoDate: iso }));
    });
  });
  return out;
}

/**
 * 用途：讀上一季內容表要帶入本季的行（見檔頭）。IO 層。
 *   ⚠️ 不用跨執行的快取（tests/configcache.test.js：人手編輯的資料不可以這樣快取）；每次匯入都
 *   開一次上一季的內容表（約一兩秒）。
 * Args:
 *   quarterId {string} 本季。
 *   serviceDates {string[]} 本季全部主日，由舊到新。
 * Returns:
 *   {{rowsByTab:Object<string,Object[]>, warnings:string[], sourceQuarterId:string}}
 * Raises:
 *   （無：讀不到就在 `warnings` 講明）
 */
function readContentCarryOver_(quarterId, serviceDates) {
  var prevQid = previousQuarterId_(quarterId);
  var out = { rowsByTab: {}, warnings: [], sourceQuarterId: prevQid };
  if (!prevQid || !serviceDates || serviceDates.length === 0) return out;
  var row = findContentSheetRow_(prevQid);
  if (!row) return out; // 上一季沒有內容表：正常，沒有東西帶過來。

  var spreadsheet = openContentSpreadsheet_(row.FILE_ID);
  if (!spreadsheet) {
    out.warnings.push('上一季（' + prevQid + '）的內容表開不到，由上一季「連續到」帶入本季的家事報告、代禱事項這一次沒有匯入。'
      + '請在週報系統試算表的 ContentSheets 核對那一季的檔案。');
    return out;
  }
  var schema = checkContentSheetSchema_(spreadsheet);
  if (!schema.ok) {
    out.warnings.push('上一季（' + prevQid + '）的內容表版面未更新，由上一季「連續到」帶入本季的家事報告、代禱事項這一次沒有匯入：'
      + schema.message);
    return out;
  }
  var selected = selectContentCarryOverRows_(readContentSheetTabs_(spreadsheet), serviceDates[0], prevQid);
  out.rowsByTab = selected.rowsByTab;
  out.warnings = selected.warnings;
  return out;
}
