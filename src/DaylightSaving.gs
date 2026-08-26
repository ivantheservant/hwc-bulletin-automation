/**
 * DaylightSaving.gs
 *
 * R-030：夏令時間轉換提示，自動加入內容表的「家事報告」。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 考證（由 88 期真實週報抽出的原文）
 * ─────────────────────────────────────────────────────────────────────
 *
 *   2025-09-21（開始前一週）
 *     Daylight Saving將開始：今年Daylight Saving於下主日(28/9)開始，
 *     請於27/9星期六晚上將時鐘撥前一小時 (如圖)。
 *
 *   2026-03-29（完結前一週）
 *     今年Daylight Saving於下主日(4月5日) 完結，請大家於本週六晚將時間回撥一小時。
 *
 * ⚠️ 原文那句「(如圖)」指週報有一張時鐘圖。範本**刻意不含**這一句——系統
 *   不處理圖片，寫了就變成一句對不上的說明。要圖的話由幹事自己在內容表加。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 規則
 * ─────────────────────────────────────────────────────────────────────
 *
 *   紐西蘭夏令時間：**9 月最後一個主日開始，4 月第一個主日完結**。
 *   提示登在**轉換當日的前一個主日**那一期。一年兩次。
 *
 * ⚠️ **由日期計算，不可以寫死日期表。** 寫死的話 2030 年就會錯，而且錯得
 *   很靜——沒有人會發現那一年少了一則提示。
 */

'use strict';

/**
 * 用途：算出某年某月**第 n 個星期日**。**純函式。**
 * Args:
 *   year {number} 四位年份。
 *   monthIndex {number} 月份，**0 起算**（0＝一月）。
 *   nth {number} 第幾個，1 起算。
 * Returns:
 *   {?Date} 該月沒有第 n 個星期日時回 `null`（例如二月的第 5 個）。
 */
function nthSundayOfMonth_(year, monthIndex, nth) {
  var first = new Date(year, monthIndex, 1);
  var firstSunday = 1 + ((7 - first.getDay()) % 7);
  var day = firstSunday + (Number(nth) - 1) * 7;
  var candidate = new Date(year, monthIndex, day);
  if (candidate.getMonth() !== monthIndex) return null;
  return candidate;
}

/**
 * 用途：算出某年某月**最後一個星期日**。**純函式。**
 * Args:
 *   year {number} 四位年份。
 *   monthIndex {number} 月份，0 起算。
 * Returns:
 *   {Date}
 */
function lastSundayOfMonth_(year, monthIndex) {
  // 由下個月的第 0 日（即本月最後一日）往回數。
  var last = new Date(year, monthIndex + 1, 0);
  last.setDate(last.getDate() - last.getDay());
  return last;
}

/**
 * 用途：算出某一年兩次夏令時間轉換的日期。**純函式。**
 *
 *   ⚠️ 兩次都在**同一個曆年**：4 月第一個主日完結（年頭）、9 月最後一個
 *   主日開始（年尾）。不是「一次轉換的兩端」——所以同一年的兩則提示，
 *   一則在 3 月尾、一則在 9 月中。
 * Args:
 *   year {number} 四位年份。
 * Returns:
 *   {{changeIso:string, kind:string, noticeIso:string, saturdayIso:string}[]}
 *     `kind` 是 `START`／`END`；`noticeIso` 是**轉換當日的前一個主日**
 *     （提示要登在那一期）；`saturdayIso` 是轉換前一日（星期六）。
 */
function daylightSavingChangesForYear_(year) {
  var y = Number(year);
  if (!isFinite(y)) return [];

  var endChange = nthSundayOfMonth_(y, 3, 1);        // 4 月（index 3）第一個主日
  var startChange = lastSundayOfMonth_(y, 8);        // 9 月（index 8）最後一個主日

  return [
    buildDaylightSavingChange_(endChange, 'END'),
    buildDaylightSavingChange_(startChange, 'START')
  ].filter(Boolean);
}

/**
 * 用途：把一個轉換日期包成完整的一項（連提示主日與星期六）。**純函式。**
 * Args:
 *   changeDate {?Date} 轉換當日（一定是星期日）。
 *   kind {string} `START`／`END`。
 * Returns:
 *   {?Object} `changeDate` 是 `null` 時回 `null`。
 */
function buildDaylightSavingChange_(changeDate, kind) {
  if (!changeDate) return null;

  var notice = new Date(changeDate.getFullYear(), changeDate.getMonth(), changeDate.getDate() - 7);
  var saturday = new Date(changeDate.getFullYear(), changeDate.getMonth(), changeDate.getDate() - 1);

  return {
    changeIso: formatIsoDate_(changeDate),
    kind: kind,
    noticeIso: formatIsoDate_(notice),
    saturdayIso: formatIsoDate_(saturday)
  };
}

/**
 * 用途：算出一批主日之中，哪幾個要登夏令時間提示。**純函式。**
 *
 *   ⚠️ 掃**該批主日涵蓋的每一個年份**，不是只掃第一個主日那一年——
 *   12 月建立的季度可以包含下一年 1 月的主日（跨年邊界）。
 * Args:
 *   serviceDates {string[]} 該季主日，`yyyy-MM-dd`。
 * Returns:
 *   {Object[]} `daylightSavingChangesForYear_()` 的項，但只保留 `noticeIso`
 *     真的落在 `serviceDates` 內的那幾項，並按 `noticeIso` 排序。
 */
function daylightSavingNoticesForDates_(serviceDates) {
  var dates = (serviceDates || []).map(function (d) { return String(d); });
  if (dates.length === 0) return [];

  var years = {};
  dates.forEach(function (iso) {
    var m = /^(\d{4})-/.exec(iso);
    if (m) years[Number(m[1])] = true;
  });

  var out = [];
  Object.keys(years).forEach(function (key) {
    daylightSavingChangesForYear_(Number(key)).forEach(function (change) {
      if (dates.indexOf(change.noticeIso) === -1) return;
      out.push(change);
    });
  });

  return out.sort(function (a, b) {
    if (a.noticeIso < b.noticeIso) return -1;
    if (a.noticeIso > b.noticeIso) return 1;
    return 0;
  });
}

/**
 * 用途：把一個 `yyyy-MM-dd` 排成給人看的日期文字。
 *
 *   ⚠️ 跟隨現有的日期格式設定（Config `DATE_FORMAT_SHORT`）。實際週報兩種
 *   寫法都出現過（`28/9`、`4月5日`），所以一定要可設定，不可以寫死。
 * Args:
 *   isoDate {string}
 *   pattern {string} Apps Script 的日期格式字串。
 *   timezone {string}
 * Returns:
 *   {string} 格式化失敗時原樣回 `isoDate`——寧可印一個 ISO 日期，
 *     也好過印一句空白。
 */
function formatDaylightSavingDate_(isoDate, pattern, timezone) {
  var date = normalizeDate_(isoDate);
  if (!date) return String(isoDate || '');
  try {
    return Utilities.formatDate(date, timezone, pattern);
  } catch (err) {
    return String(isoDate || '');
  }
}

/**
 * 用途：一次過讀齊 R-030 要用的設定。
 * Args: （無）
 * Returns:
 *   {{autoInsert:boolean, seqNo:number, startTemplate:string,
 *     endTemplate:string, datePattern:string, timezone:string}}
 */
function daylightSavingConfig_() {
  var seq = normalizeInt_(getConfig(CONFIG_KEYS.DST_ANNOUNCEMENT_SEQ, '5'));
  return {
    autoInsert: normalizeBoolean_(getConfig(CONFIG_KEYS.DST_AUTO_INSERT, 'TRUE')) === true,
    seqNo: (seq === null || seq <= 0) ? 5 : seq,
    startTemplate: String(getConfig(CONFIG_KEYS.DST_START_ANNOUNCEMENT, '') || ''),
    endTemplate: String(getConfig(CONFIG_KEYS.DST_END_ANNOUNCEMENT, '') || ''),
    // ⚠️ 跟隨**現有**的日期格式設定（`DATE_FORMAT_INLINE`，人數表與下週事奉
    //    標題括號內用的那一個）。實際週報寫過 `28/9` 與 `4月5日` 兩種，
    //    兩種都不等於這個設定的預設值 `dd/MM/yyyy`——見 docs/待確認事項.md
    //    U-3。要改樣式就改那一個 Config 鍵，不要在這裡寫死。
    datePattern: String(getConfig(CONFIG_KEYS.DATE_FORMAT_INLINE, 'dd/MM/yyyy') || 'dd/MM/yyyy'),
    timezone: getConfig(CONFIG_KEYS.SYS_TIMEZONE, 'Pacific/Auckland')
  };
}

/**
 * 用途：把一個轉換項套進範本，砌出家事報告那一行的內文。**純函式**
 *   （日期格式化那一步靠傳入的 `formatter`，方便測試）。
 * Args:
 *   change {Object} `daylightSavingChangesForYear_()` 的一項。
 *   config {Object} `daylightSavingConfig_()` 的輸出。
 *   formatter {function(string): string=} 選填，把 iso 轉成顯示文字。
 * Returns:
 *   {string} 範本是空字串時回空字串（呼叫方要當成「不要加這一行」）。
 */
function renderDaylightSavingText_(change, config, formatter) {
  var template = change.kind === 'START' ? config.startTemplate : config.endTemplate;
  if (!String(template).trim()) return '';

  var format = formatter || function (iso) {
    return formatDaylightSavingDate_(iso, config.datePattern, config.timezone);
  };

  return String(template)
    .split('{{CHANGE_DATE}}').join(format(change.changeIso))
    .split('{{SATURDAY}}').join(format(change.saturdayIso));
}

/**
 * 用途：算出某一季內容表「家事報告」應該自動加哪幾行。**純函式。**
 * Args:
 *   serviceDates {string[]} 該季主日。
 *   config {Object} `daylightSavingConfig_()` 的輸出。
 *   formatter {function(string): string=} 選填。
 * Returns:
 *   {{SERVICE_DATE:string, SEQ_NO:number, TEXT:string, REPEAT_UNTIL:string,
 *     ACTIVE:string, SOURCE:string, SOURCE_SNAPSHOT:string}[]}
 *     `autoInsert` 關掉時回空陣列。
 */
function buildDaylightSavingRows_(serviceDates, config, formatter) {
  if (!config.autoInsert) return [];

  return daylightSavingNoticesForDates_(serviceDates).map(function (change) {
    var text = renderDaylightSavingText_(change, config, formatter);
    if (!text) return null;
    return {
      SERVICE_DATE: change.noticeIso,
      SEQ_NO: config.seqNo,
      TEXT: text,
      REPEAT_UNTIL: '',
      ACTIVE: 'TRUE',
      SOURCE: CONTENT_ROW_SOURCE.SYSTEM_DST,
      // ⚠️ 寫入時的內容快照。之後刷新內容表時，用它判斷「有沒有被人手改過」
      //    ——不是靠時間戳（人手改一個字不會動時間戳，而重新整理會）。
      SOURCE_SNAPSHOT: text
    };
  }).filter(Boolean);
}

/**
 * 用途：算出「刷新內容表時，家事報告那一張要怎樣改」。**純函式。**
 *
 *   ⚠️ 三條規則，缺一不可：
 *     1. 現有行的 `SOURCE` 不是 `SYSTEM_DST` → **一律不動**（人手加的）；
 *     2. 是 `SYSTEM_DST` 但內容與 `SOURCE_SNAPSHOT` 不同，或者 `ACTIVE`
 *        已經被改成 `FALSE` → **一律不動**（人手改過，之後永遠不再覆寫）；
 *     3. 是 `SYSTEM_DST` 而且未被改過 → 用新算出來的內容覆寫（範本改過、
 *        或者日期格式設定改過時，會更新）。
 *   還未有那一行的，就新增。
 * Args:
 *   existingRows {Object[]} 內容表「家事報告」現有的資料列（帶 `__rowNo`）。
 *   wantedRows {Object[]} `buildDaylightSavingRows_()` 的輸出。
 * Returns:
 *   {{appends:Object[], updates:Object[], untouched:Object[]}}
 *     `updates` 每項是 `{rowNo, row}`；`untouched` 是被人手改過而刻意不動的。
 */
function planDaylightSavingRows_(existingRows, wantedRows) {
  var existing = existingRows || [];
  var appends = [];
  var updates = [];
  var untouched = [];

  (wantedRows || []).forEach(function (wanted) {
    var match = null;
    existing.forEach(function (row) {
      if (match) return;
      if (String(row.SOURCE || '') !== CONTENT_ROW_SOURCE.SYSTEM_DST) return;
      if (contentRowIsoDate_(row.SERVICE_DATE) !== wanted.SERVICE_DATE) return;
      match = row;
    });

    if (!match) {
      appends.push(wanted);
      return;
    }

    if (daylightSavingRowWasEdited_(match)) {
      untouched.push(match);
      return;
    }

    if (String(match.TEXT || '') === wanted.TEXT) {
      untouched.push(match);
      return;
    }
    updates.push({ rowNo: match.__rowNo, row: wanted });
  });

  return { appends: appends, updates: updates, untouched: untouched };
}

/**
 * 用途：判斷一行系統加的夏令時間提示，有沒有被人手改過。**純函式。**
 *
 *   ⚠️ 兩種「改過」都要算：改內容，或者把「有效」設成 `FALSE`。
 *   後者是幹事說「我不要這一則」，之後永遠不可以再加回去。
 * Args:
 *   row {Object} 內容表一行。
 * Returns:
 *   {boolean}
 */
function daylightSavingRowWasEdited_(row) {
  var r = row || {};
  var active = String(r.ACTIVE === undefined || r.ACTIVE === null ? '' : r.ACTIVE).trim().toUpperCase();
  if (active === 'FALSE') return true;

  var snapshot = String(r.SOURCE_SNAPSHOT || '');
  // 沒有快照就當成被改過——寧可不動，也好過覆寫一句人手寫的東西。
  if (!snapshot) return true;
  return String(r.TEXT || '') !== snapshot;
}

/**
 * 用途：把內容表一格日期正規化成 `yyyy-MM-dd`。**純函式。**
 * Args:
 *   value {*}
 * Returns:
 *   {string} 轉不到回空字串。
 */
function contentRowIsoDate_(value) {
  if (value === null || value === undefined || value === '') return '';
  if (Object.prototype.toString.call(value) === '[object Date]') return formatIsoDate_(value);
  var text = String(value).trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : '';
}
