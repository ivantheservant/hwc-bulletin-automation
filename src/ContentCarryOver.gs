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
  var n = normalizeInt_(getConfig_(CONFIG_KEYS.CONTENT_REPEAT_UNTIL_NEXT_QUARTER_WEEKS, '13'));
  return (n === null || n < 0) ? 0 : n;
}

/**
 * 用途：由上一季內容表的資料，揀出要帶入本季的行。純函式。
 * Args:
 *   contentData {Object<string,Object[]>} 上一季的 `readContentSheetTabs_()`。
 *   firstIso {string} 本季第一個主日。
 *   sourceQuarterId {string} 上一季的季度 ID（只用來寫警告）。
 * Returns:
 *   {{rowsByTab:Object<string,Object[]>, warnings:string[], skipThrough:Object<string,string>,
 *     managedTabs:Object<string,string>}} 只包括有「連續到」的清單分頁；`managedTabs` 見 readContentCarryOver_()。
 * Raises:
 *   （無）
 */
function selectContentCarryOverRows_(contentData, firstIso, sourceQuarterId) {
  var out = { rowsByTab: {}, warnings: [], skipThrough: {}, managedTabs: {} };
  var first = String(firstIso || '').trim();
  if (!first) return out;
  contentImportTargets_().forEach(function (def) {
    if (def.kind !== 'LIST' || def.repeatUntil !== true) return;
    var picked = [];
    ((contentData || {})[def.tabName] || []).forEach(function (row) {
      var start = String(row.SERVICE_DATE || '').trim();
      var until = String(row.REPEAT_UNTIL || '').trim();
      var issues = row.__typeIssues || [];
      if (issues.length > 0) {
        // 獨立審查 2026-10-30 第 2 項：有格被轉了，這一行帶不帶都不可信——**不可以**當沒有（否則本季已經帶入的
        //    那幾個主日會被停用）。那幾個主日這一次不匯入（週報保留原有的內容）：連續到讀得到就到那一日，
        //    讀不到（連續到本身被轉了）就整季。
        var structural = issues.indexOf('REPEAT_UNTIL') !== -1 || issues.indexOf('SERVICE_DATE') !== -1
          || issues.indexOf('ACTIVE') !== -1;
        if (structural || (until && until >= first)) {
          out.skipThrough[def.tabName] = structural ? 'ALL'
            : (out.skipThrough[def.tabName] === 'ALL' ? 'ALL' : maxIso_(out.skipThrough[def.tabName], until));
          out.warnings.push('上一季（' + sourceQuarterId + '）內容表「' + def.tabName + '」第 ' + row.__rowNo
            + ' 行有格被試算表轉成日期／時間：本季「' + def.tabName + '」' + (structural ? '整季' : '至 ' + until)
            + ' 的主日這一次不匯入（週報保留原有的內容）。請在上一季的內容表把那一格改回純文字，再重新輸入。');
        }
        return;
      }
      if (!start || !until || start >= first || until < first) return;
      // 有效或者已停用都算：本季這張分頁空白時，用來知道至哪一日的週報要跟上一季比對（第 4 項）。
      out.managedTabs[def.tabName] = maxIso_(out.managedTabs[def.tabName], until);
      if (row.__active !== true) return;
      picked.push(Object.assign({}, row, { __carriedFromQuarter: sourceQuarterId }));
    });
    if (picked.length > 0) out.rowsByTab[def.tabName] = picked;
  });
  return out;
}

/**
 * 用途：兩個 yyyy-MM-dd 取較遲的一個（空字串當最早）。純函式。
 * Args:
 *   a {string=}　b {string=}
 * Returns:
 *   {string}
 */
function maxIso_(a, b) {
  var x = String(a || '');
  var y = String(b || '');
  return x > y ? x : y;
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
 *   {{rowsByTab:Object<string,Object[]>, warnings:string[], sourceQuarterId:string, unreadable:boolean=,
 *     skipThrough:Object<string,string>=, managedTabs:Object<string,string>=}}
 *   `unreadable`：上一季登記了內容表但讀不到；`skipThrough`：分頁 → 本季這一次不匯入至哪一日（`ALL`＝整季）；
 *   `managedTabs`：分頁 → 上一季連到本季的行（有效或停用）最遲連到哪一日。
 * Raises:
 *   （無：讀不到就在 `warnings` 講明）
 */
function readContentCarryOver_(quarterId, serviceDates) {
  var prevQid = previousQuarterId_(quarterId);
  var out = { rowsByTab: {}, warnings: [], sourceQuarterId: prevQid };
  if (!prevQid || !serviceDates || serviceDates.length === 0) return out;
  var row = findContentSheetRow_(prevQid);
  if (!row) return out; // 上一季沒有內容表：正常，沒有東西帶過來。

  // 獨立審查 2026-10-30 第 2 項：上一季登記了內容表但讀不到——不知道有甚麼帶過來，**不可以**當沒有
  //    （否則本季已經帶入的行會被停用）。家事報告、代禱事項這一次整季不匯入，週報保留原有的內容。
  var spreadsheet = openContentSpreadsheet_(row.FILE_ID);
  if (!spreadsheet) {
    out.unreadable = true;
    out.warnings.push('上一季（' + prevQid + '）的內容表開不到，所以本季的家事報告、代禱事項這一次不匯入（週報保留原有的內容）。'
      + '如果那份內容表已經不用，請在週報系統試算表的 ContentSheets 把季度「' + prevQid + '」那一行的「有效」改為 FALSE。');
    return out;
  }
  // 2026-10-30：只核對、只讀有「連續到」的分頁——上一季其他分頁（例如崇拜人數仍然是一個日期一行）不影響帶入。
  var carryTabs = contentImportTargets_().filter(function (def) {
    return def.kind === 'LIST' && def.repeatUntil === true;
  }).map(function (def) { return def.tabName; });
  var schema = checkContentSheetSchema_(spreadsheet, carryTabs);
  if (!schema.ok) {
    out.unreadable = true;
    out.warnings.push('上一季（' + prevQid + '）的內容表版面未更新，所以本季的家事報告、代禱事項這一次不匯入（週報保留原有的內容）：'
      + schema.message);
    return out;
  }
  var selected = selectContentCarryOverRows_(readContentSheetTabs_(spreadsheet, carryTabs), serviceDates[0], prevQid);
  out.rowsByTab = selected.rowsByTab;
  out.warnings = selected.warnings;
  out.skipThrough = selected.skipThrough;
  out.managedTabs = selected.managedTabs;
  return out;
}
