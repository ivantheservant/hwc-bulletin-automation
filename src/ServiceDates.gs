/**
 * ServiceDates.gs
 *
 * **「這一季有哪幾個主日」的單一真相來源。**
 *
 * ─────────────────────────────────────────────────────────────────────
 * 為什麼要有這一個檔案
 * ─────────────────────────────────────────────────────────────────────
 *
 * R-036 之後，職事表未有該季資料**一樣建立得到週報**。但全專案有九個地方
 * 各自呼叫 `listQuarterServiceDates_()`（**只讀職事表**）去問「這一季有哪幾個
 * 主日」，於是那些季度全部得到一張空清單：
 *
 *   | 功能 | 職事表未有該季時的實際結果 |
 *   |---|---|
 *   | 從內容表匯入 | 「新增 0、修改 0、刪除 0、不變 0」——**不是報錯** |
 *   | 產生本季全部週報 | 一份都不產生 |
 *   | 產生本季團契 | 一個都不產生 |
 *   | 建立季度填寫表 | 建立不到 |
 *   | 全季流程演練 | 跑不動 |
 *   | 本季待填清單／完成度自我檢測 | 清單是空的 |
 *   | 內容表邀請信／自動建立 | 主日清單空白 |
 *
 * 全部都是**靜靜地什麼都不做**，比報錯難發現得多（見 docs/已知bug類型.md
 * 檢查清單第 94 條）。所以「這一季有哪幾個主日」這條問題只准有一個答案，
 * 而且那個答案要**講得出自己是從哪裏來的**。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 四個來源，由可信到不可信
 * ─────────────────────────────────────────────────────────────────────
 *
 *   | `source` | 意思 | 週次／特別主日 |
 *   |---|---|---|
 *   | `ROSTER` | 職事表有這一季 | 由職事表快照讀出來 |
 *   | `BULLETIN_WEEKS` | 職事表未有，但週報已經建立了這一季 | 由 `BulletinWeeks` 那幾行讀出來 |
 *   | `CALENDAR` | 兩者都沒有，用曆法推算該季全部星期日 | 週次由日期算，特別主日一律空白 |
 *   | `NONE` | 連曆法都推算不到（季度 ID 格式不對） | 空清單 |
 *
 * ⚠️ **退回的只是「用哪一份清單」，不是「用哪一季」。** 四個來源全部只看
 * 同一個季度 ID，一個都不會跨季——這是事故四十一那一條紀律：
 * 「決定處理哪一季」可以退回，「拿該季的資料」不可以。
 *
 * ⚠️ `NONE` **不可以**當成「這一季沒有主日」靜靜回 0 筆。呼叫方一定要
 * 明確報「取不到主日清單」。`resolveQuarterServiceDateEntries_()` 已經把
 * 那一句組好放在 `message`，照抄出去即可。
 *
 * ⚠️ 為什麼 `BULLETIN_WEEKS` 排在 `CALENDAR` 之前：`BulletinWeeks` 那幾行是
 * 幹事真的建立過的，可能已經人手加減過主日（例如某一週停開）。曆法推算
 * 答的是「理論上有哪幾個星期日」，比較粗。有真的資料就不應該用推算的。
 *
 * ⚠️ 靜態防線：`tools/lint-service-dates.js`。除了本檔案與
 * `src/FillGrid.gs`（`listQuarterServiceDates_()` 的定義處）以外，
 * `src/` 內不准再直接呼叫 `listQuarterServiceDates_()`。
 */

'use strict';

/** 四個來源的機器值。 */
var SERVICE_DATE_SOURCE = Object.freeze({
  ROSTER: 'ROSTER',
  BULLETIN_WEEKS: 'BULLETIN_WEEKS',
  CALENDAR: 'CALENDAR',
  NONE: 'NONE'
});

/**
 * 用途：把 `source` 譯成給人看的一句話。**純函式。**
 * Args:
 *   source {string} `SERVICE_DATE_SOURCE` 其中一個值。
 * Returns:
 *   {string}
 */
function serviceDateSourceLabel_(source) {
  switch (String(source || '')) {
    case SERVICE_DATE_SOURCE.ROSTER: return '職事表';
    case SERVICE_DATE_SOURCE.BULLETIN_WEEKS: return 'BulletinWeeks（週報已建立的主日）';
    case SERVICE_DATE_SOURCE.CALENDAR: return '曆法推算（該季全部星期日）';
    case SERVICE_DATE_SOURCE.NONE: return '取不到';
    default: return String(source || '（未知）');
  }
}

/**
 * 用途：**這一季有哪幾個主日**——全專案唯一的入口。
 *
 *   ⚠️ 不要再直接呼叫 `listQuarterServiceDates_()`。理由見本檔案檔頭，
 *   靜態防線是 `tools/lint-service-dates.js`。
 * Args:
 *   quarterId {string} 季度 ID，`YYYYTn`。
 * Returns:
 *   {{entries:{isoDate:string, weekOfMonth:number, specialTitle:string}[],
 *     dates:string[], source:string, sourceLabel:string, message:string,
 *     ok:boolean}}
 *     `ok` 為 `false` 只有一種情況：`source === 'NONE'`（連曆法都推算不到）。
 *     `message` 在 `ROSTER` 以外一律有一句給人看的說明，可以直接放進對話框。
 * Raises:
 *   （不拋錯）讀職事表失敗一律退回下一個來源，並在 `message` 講明。
 */
function resolveQuarterServiceDateEntries_(quarterId) {
  var qid = String(quarterId || '').trim();

  // ---- 來源 1：職事表 ----
  var rosterEntries = [];
  var rosterError = '';
  if (qid) {
    try {
      // lint-service-dates: 容許——這裏就是那個唯一的包裝，包的正是它。
      rosterEntries = listQuarterServiceDates_(qid) || [];
    } catch (err) {
      rosterEntries = [];
      rosterError = '讀職事表時拋錯：' + ((err && err.message) ? err.message : String(err)) + '　';
    }
  }
  if (rosterEntries.length > 0) {
    return serviceDateResult_(rosterEntries, SERVICE_DATE_SOURCE.ROSTER, '');
  }

  // ---- 來源 2：BulletinWeeks（**只取同一季**，一行都不會跨季）----
  var weekEntries = quarterEntriesFromBulletinWeeks_(qid);
  if (weekEntries.length > 0) {
    return serviceDateResult_(weekEntries, SERVICE_DATE_SOURCE.BULLETIN_WEEKS,
      rosterError + '職事表未有季度「' + qid + '」的資料，主日清單改用 '
        + SHEETS.BULLETIN_WEEKS + ' 內同一季的 ' + weekEntries.length + ' 個主日。');
  }

  // ---- 來源 3：曆法推算 ----
  var calendarEntries = quarterCalendarSundays_(qid).map(function (iso) {
    return { isoDate: iso, weekOfMonth: weekOfMonthForIsoDate_(iso), specialTitle: '' };
  });
  if (calendarEntries.length > 0) {
    return serviceDateResult_(calendarEntries, SERVICE_DATE_SOURCE.CALENDAR,
      rosterError + '本季職事表未有資料，主日清單由曆法推算（該季全部星期日，共 '
        + calendarEntries.length + ' 個）。');
  }

  // ---- 來源 4：取不到 ----
  return serviceDateResult_([], SERVICE_DATE_SOURCE.NONE,
    rosterError + '取不到季度「' + qid + '」的主日清單：職事表沒有這一季、'
      + SHEETS.BULLETIN_WEEKS + ' 也沒有，而且季度 ID 不合法（要 YYYYTn，例如 2027T4），'
      + '連曆法都推算不到。請確認季度 ID。');
}

/**
 * 用途：把 entries 組成標準回傳值。**純函式。**
 * Args:
 *   entries {Object[]} 主日清單。
 *   source {string} `SERVICE_DATE_SOURCE` 其中一個值。
 *   message {string} 給人看的說明。
 * Returns:
 *   {Object} 見 `resolveQuarterServiceDateEntries_()`。
 */
function serviceDateResult_(entries, source, message) {
  var list = entries || [];
  return {
    entries: list,
    dates: list.map(function (e) { return e.isoDate; }),
    source: source,
    sourceLabel: serviceDateSourceLabel_(source),
    message: message || '',
    ok: source !== SERVICE_DATE_SOURCE.NONE
  };
}

/**
 * 用途：由 `BulletinWeeks` 讀出**同一季**的主日清單。
 *
 *   ⚠️ 一定要篩季度。不篩的話，職事表未有該季時會把全表的主日都當成
 *   這一季的——那正是事故四十一要防的跨季。
 * Args:
 *   quarterId {string} 季度 ID。
 * Returns:
 *   {{isoDate:string, weekOfMonth:number, specialTitle:string}[]} 依日期排序。
 */
function quarterEntriesFromBulletinWeeks_(quarterId) {
  var qid = String(quarterId || '').trim();
  if (!qid) return [];

  var seen = {};
  var out = [];
  readSheet(SHEETS.BULLETIN_WEEKS).forEach(function (row) {
    if (String(row.QUARTER_ID || '').trim() !== qid) return;
    var iso = (Object.prototype.toString.call(row.SERVICE_DATE) === '[object Date]')
      ? formatIsoDate_(row.SERVICE_DATE)
      : String(row.SERVICE_DATE || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return;
    if (seen[iso]) return;
    seen[iso] = true;

    var weekOfMonth = (row.WEEK_OF_MONTH === null || row.WEEK_OF_MONTH === undefined
      || row.WEEK_OF_MONTH === '')
      ? weekOfMonthForIsoDate_(iso)
      : Number(row.WEEK_OF_MONTH);
    out.push({
      isoDate: iso,
      weekOfMonth: isFinite(weekOfMonth) ? weekOfMonth : weekOfMonthForIsoDate_(iso),
      specialTitle: String(row.SPECIAL_TYPE || '')
    });
  });

  out.sort(function (a, b) {
    if (a.isoDate < b.isoDate) return -1;
    if (a.isoDate > b.isoDate) return 1;
    return 0;
  });
  return out;
}

/**
 * 用途：由日期本身算「當月第幾個主日」。**純函式。**
 *
 *   ⚠️ 與 `buildRosterSnapshot_()` 用的是同一條算式（`(日-1)/7 + 1`）。
 *   兩處刻意寫成同一條，是因為那是本專案對「第幾個主日」的定義，不是巧合。
 * Args:
 *   isoDate {string} yyyy-MM-dd。
 * Returns:
 *   {number} 格式不對時回 `1`（不拋錯——這只是顯示用的週次，不值得中斷流程）。
 */
function weekOfMonthForIsoDate_(isoDate) {
  var m = /^\d{4}-\d{2}-(\d{2})$/.exec(String(isoDate || '').trim());
  if (!m) return 1;
  return Math.floor((Number(m[1]) - 1) / 7) + 1;
}

/**
 * 用途：`source` 不是 `ROSTER` 時，要附在對話框／報告後面的那一句。
 *
 *   ⚠️ 用了退而求其次的來源而**不講**，下一個人看到數字對不上會查錯方向
 *   （見 docs/已知bug類型.md 檢查清單第 78 條）。
 * Args:
 *   resolution {Object} `resolveQuarterServiceDateEntries_()` 的回傳值。
 * Returns:
 *   {string} 來源是 `ROSTER` 時回空字串（正常情況不用多講一句）。
 */
function serviceDateSourceNote_(resolution) {
  var r = resolution || {};
  if (r.source === SERVICE_DATE_SOURCE.ROSTER) return '';
  return '⚠️ 主日清單來源：' + serviceDateSourceLabel_(r.source)
    + (r.message ? ('　' + r.message) : '');
}
