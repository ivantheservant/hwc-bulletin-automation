/**
 * SendSchedule.gs
 *
 * 「下一個要寄的主日」的**單一真相來源**。
 *
 * ⚠️ 為什麼要有這一個檔案（docs/已知bug類型.md 事故三十）：
 *   第一輪自測在 2026-08-22（星期六）跑，系統選中的目標日是
 *   **2026-08-28（星期五）**。正確答案是 2026-08-23（星期日）。
 *
 *   原本的算法是「今日 ＋ Config `SEND_TARGET_OFFSET_DAYS`（預設 6）天」。
 *   那條算式只有在**觸發日是星期一**的時候才會落在星期日：一 ＋ 6 ＝ 日。
 *   換句話說，它算的不是「下一個主日」，而是「假設今日是星期一的話，
 *   下一個主日是哪一日」。星期六跑就得出星期五，星期三跑就得出星期二。
 *
 *   ⚠️ 這條算式一共有**三份拷貝**（`Mailer.gs` 的
 *   `guessNextBulletinSendIso_()`、`Trigger.gs` 的
 *   `weeklyBulletinSendTrigger_()`、`SelfTest.gs` 的 S18），每一份都自己
 *   讀 Config、自己加天數。三份同時錯，於是「對答案」的那一方與「算答案」
 *   的那一方得出同一個錯的結果，看起來一致——正是事故二十二講的那件事。
 *
 * **定義（現在只有這一句）**
 *   下一個要寄的主日 ＝ **今日之後（含今日）最近的一個星期日**；
 *   如果那一個主日已經**真的寄過**（`SendLog` 有一筆 `DRY_RUN` 不是
 *   `TRUE`、`STATUS` 是 `SENT` 的紀錄），就取再下一個主日，如此類推。
 *
 *   ⚠️ 「已寄過」刻意只認**真寄**。`DRY_RUN` 的紀錄不算——試寄的用途
 *   正是「寄之前先看一次」，如果試寄會令系統跳過那一期，那就變成試一次
 *   就漏一期，而且完全沒有提示。
 *
 *   ⚠️ 「已寄過」也刻意不認 `FAILED`。寄失敗代表**沒有寄到**，下一次
 *   觸發要再試同一期，不是跳過它。
 */

'use strict';

/** 往前找主日的上限（星期）。超過就當找不到，不會無限迴圈。 */
var NEXT_SEND_SUNDAY_MAX_WEEKS_ = 60;

/**
 * 用途：算出「下一個要寄的主日」。**純函式**，日期與已寄清單都由呼叫方
 *   提供，所以七個星期幾、跨月、跨年、已寄過全部測得到。
 * Args:
 *   todayIso {string} 今日，`yyyy-MM-dd`。
 *   sentIsoList {string[]} 已經**真的寄過**的主日（`yyyy-MM-dd`）。
 *   maxWeeks {number=} 最多往前找幾多個主日，預設
 *     `NEXT_SEND_SUNDAY_MAX_WEEKS_`。
 * Returns:
 *   {{ok:boolean, isoDate:string, skipped:string[], reason:string}}
 *     `skipped` 是「因為已經寄過而跳過」的主日，要放進報告——跳過了哪
 *     幾期一定要講得出，否則人只會見到一個日期，不知道系統決定過什麼。
 *     `reason` 在 `ok` 為 false 時說明原因，`ok` 為 true 時是空字串。
 */
function computeNextSendSundayIso_(todayIso, sentIsoList, maxWeeks) {
  var limit = (maxWeeks === undefined || maxWeeks === null) ? NEXT_SEND_SUNDAY_MAX_WEEKS_ : maxWeeks;
  var first = nextSundayOnOrAfter_(todayIso);
  if (!first) {
    return {
      ok: false, isoDate: '', skipped: [],
      reason: '今日日期不是合法的 yyyy-MM-dd：' + JSON.stringify(todayIso)
    };
  }

  var sent = {};
  (sentIsoList || []).forEach(function (iso) {
    var text = String(iso || '').trim();
    if (text) sent[text] = true;
  });

  var candidate = first;
  var skipped = [];
  for (var i = 0; i < limit; i++) {
    // ⚠️ 用 hasOwnProperty 而不是 `if (sent[candidate])`——見
    //    docs/已知bug類型.md 清單第 40 條（falsy 值當成「沒有」的陷阱）。
    if (!Object.prototype.hasOwnProperty.call(sent, candidate)) {
      return { ok: true, isoDate: candidate, skipped: skipped, reason: '' };
    }
    skipped.push(candidate);
    candidate = addDaysToIsoDate_(candidate, 7);
    if (!candidate) {
      return {
        ok: false, isoDate: '', skipped: skipped,
        reason: '往後推算主日時算不出日期，由 ' + first + ' 開始。'
      };
    }
  }

  return {
    ok: false, isoDate: '', skipped: skipped,
    reason: '由 ' + first + ' 起連續 ' + limit + ' 個主日都已經寄過，不再往後找。'
      + '這通常代表 SendLog 有異常資料，請人手檢查。'
  };
}

/**
 * 用途：由 `SendLog` 讀出「真的寄過」的主日清單。
 *
 *   ⚠️ 只認 `DRY_RUN` 不是 `TRUE` **而且** `STATUS` 是 `SENT` 的紀錄，
 *   理由見本檔案檔頭。
 * Args: （無）
 * Returns:
 *   {string[]} `yyyy-MM-dd`，可能有重複（一期多個收件人），呼叫方不需要
 *     理會重複。
 */
function readSentBulletinSundays_() {
  var rows = [];
  try {
    rows = readSheet(SHEETS.SEND_LOG);
  } catch (err) {
    return [];
  }

  var out = [];
  rows.forEach(function (row) {
    if (row.DRY_RUN === true) return;
    if (String(row.STATUS || '').trim() !== 'SENT') return;
    var date = normalizeDate_(row.SERVICE_DATE);
    if (!date) return;
    out.push(formatIsoDate_(date));
  });
  return out;
}

/**
 * 用途：「下一個要寄的主日」的**真正入口**。全部呼叫方（觸發器、選單
 *   預設值、`resolveWorkingQuarter_()`、自測機 S18）一律用這一支，不可以
 *   自己再算一次。
 *
 *   ⚠️ 任何一步失敗都不拋錯，改回 `ok:false` 加一句中文原因——這一支的
 *   呼叫方裡面有選單預設值，為了猜不到一個預設日期而令整個選單項目失敗
 *   是不划算的。要不要因為 `ok:false` 而停下來，由呼叫方自己決定。
 * Args:
 *   options {{todayIso?:string, sentIsoList?:string[]}} 兩個都是**測試用**
 *     的注入點；正式流程一個都不傳。
 * Returns:
 *   {{ok:boolean, isoDate:string, todayIso:string, skipped:string[],
 *     reason:string}}
 */
function resolveNextSendSundayIso_(options) {
  var opts = options || {};
  var todayIso = opts.todayIso;

  if (!todayIso) {
    try {
      var timezone = getConfig(CONFIG_KEYS.SYS_TIMEZONE, 'Pacific/Auckland');
      todayIso = Utilities.formatDate(new Date(), timezone, 'yyyy-MM-dd');
    } catch (err) {
      return {
        ok: false, isoDate: '', todayIso: '', skipped: [],
        reason: '讀不到今日日期（Config SYS_TIMEZONE 可能有誤）：'
          + ((err && err.message) ? err.message : String(err))
      };
    }
  }

  var sentIsoList = opts.sentIsoList;
  if (!sentIsoList) sentIsoList = readSentBulletinSundays_();

  var result = computeNextSendSundayIso_(todayIso, sentIsoList);
  return {
    ok: result.ok,
    isoDate: result.isoDate,
    todayIso: todayIso,
    skipped: result.skipped,
    reason: result.reason
  };
}

/**
 * 用途：把 `resolveNextSendSundayIso_()` 的結果縮成一句可以放進報告、
 *   對話框、`ErrorLog` 的話。
 * Args:
 *   result {Object} `resolveNextSendSundayIso_()` 的回傳值。
 * Returns:
 *   {string}
 */
function describeNextSendSunday_(result) {
  if (!result.ok) {
    return '算不出下一個要寄的主日：' + result.reason;
  }
  var text = '今日 ' + result.todayIso + '，下一個要寄的主日是 ' + result.isoDate;
  if (result.skipped.length > 0) {
    text += '（已經寄過因而跳過：' + result.skipped.join('、') + '）';
  }
  return text;
}
