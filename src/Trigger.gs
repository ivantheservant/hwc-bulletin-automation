/**
 * Trigger.gs
 *
 * 每週自動寄送的時間觸發器：入口函式 `weeklyBulletinSendTrigger_()`，以及
 * 三個選單（安裝／移除／查看狀態）。**觸發器一律要幹事自己在選單撳
 * 「安裝自動寄送觸發器」才會建立**——不會有任何程式碼自動幫你裝上。
 *
 * ⚠️ Apps Script 的時間觸發器只能指定「小時」（`atHour()`），**不保證
 * 準確在該小時的第幾分鐘執行**，可能有數十分鐘的誤差。這件事在安裝
 * 對話框與 `docs/幹事操作說明.md` 都要講清楚，不要讓人以為是準時執行。
 */

'use strict';

/** 讓「安裝自動寄送觸發器」對話框顯示中文星期幾用。 */
var WEEKDAY_LABELS_ = Object.freeze({
  SUNDAY: '日', MONDAY: '一', TUESDAY: '二', WEDNESDAY: '三',
  THURSDAY: '四', FRIDAY: '五', SATURDAY: '六'
});

/**
 * 用途：觸發器**唯一**會呼叫的入口函式。用
 *   `resolveNextSendSundayIso_()`（src/SendSchedule.gs）算出目標主日
 *   ——今日之後（含今日）最近的一個星期日，已經真的寄過就順延一週。
 *   算不出就記一筆 `ErrorLog` 並結束，不寄送任何郵件。
 *   整個函式包 try/catch，任何失敗都寫 `ErrorLog`（`SOURCE='TRIGGER'`）
 *   而不是讓例外無聲無息地消失在觸發器的執行紀錄裡。
 * Args: （無，時間觸發器固定簽章：沒有參數）
 * Returns:
 *   {void}
 */
function weeklyBulletinSendTrigger_() {
  try {
    // ⚠️ 目標主日一律經 resolveNextSendSundayIso_()（src/SendSchedule.gs），
    //    不在這裡自己算。舊版是「今日 ＋ SEND_TARGET_OFFSET_DAYS 天」，那條
    //    算式只在觸發日是星期一時才落在星期日；星期六跑會得出星期五。
    //    見 docs/已知bug類型.md 事故三十。
    var schedule = resolveNextSendSundayIso_();
    var todayIso = schedule.todayIso;
    var targetIso = schedule.isoDate;

    if (!schedule.ok) {
      appendErrorLog_({
        source: ERROR_LOG_SOURCE.TRIGGER,
        functionName: 'weeklyBulletinSendTrigger_',
        errorCode: 'NEXT_SUNDAY_UNRESOLVED',
        message: describeNextSendSunday_(schedule)
          + '　直接結束，不寄送任何郵件。'
      });
      return;
    }

    // ⚠️ 這道檢查現在**應該永遠不會觸發**（算法本身保證是星期日）。
    //    保留它是因為「目標日不是星期日就寄出去」的代價太大：寧可多一道
    //    永遠綠的檢查，也不要哪一日算法被改壞而無聲寄錯。
    if (!isIsoDateSunday_(targetIso)) {
      appendErrorLog_({
        source: ERROR_LOG_SOURCE.TRIGGER,
        functionName: 'weeklyBulletinSendTrigger_',
        errorCode: 'TARGET_NOT_SUNDAY',
        message: '算出來的目標日期（' + targetIso + '，今天 ' + todayIso
          + '）不是星期日，不猜測正確日期，直接結束，不寄送任何郵件。'
          + '這代表 resolveNextSendSundayIso_() 被改壞了，請檢查 src/SendSchedule.gs。'
      });
      return;
    }

    // 先跑一次職事表分歧提醒，再寄週報。包一層 try/catch——提醒信本身
    // 失敗（例如收件人清單有問題）不應該連累週報寄不出去，那是兩件
    // 獨立的事；失敗記一筆 ErrorLog 就好。
    try {
      sendConflictNoticeIfNeeded_(targetIso);
    } catch (noticeErr) {
      appendErrorLog_({
        source: ERROR_LOG_SOURCE.TRIGGER,
        functionName: 'weeklyBulletinSendTrigger_/sendConflictNoticeIfNeeded_',
        errorCode: (noticeErr && noticeErr.code) || 'ERROR',
        message: (noticeErr && noticeErr.message) ? noticeErr.message : String(noticeErr),
        detail: buildErrorDetail_(noticeErr, { argsSummary: 'isoDate=' + targetIso })
      });
    }

    // 內容表 v2：季度填寫表已停用，這裏不再自動建立 Fill_ 與寄出季度填寫邀請（第八輪的
    // autoCreateNextQuarterFillGrids_()）。新季度的準備改由下面的內容表那一步做。

    // R-015：新季度快到（距離第一個主日少於 CONTENT_SHEET_INVITE_LEAD_DAYS）
    // 而且未寄過內容表邀請的話，自動建立內容表並寄出。同樣包一層 try/catch
    // ——這件事失敗不應該連累週報寄送。
    try {
      autoCreateContentSheetsForUpcomingQuarters_();
    } catch (contentErr) {
      appendErrorLog_({
        source: ERROR_LOG_SOURCE.TRIGGER,
        functionName: 'weeklyBulletinSendTrigger_/autoCreateContentSheetsForUpcomingQuarters_',
        errorCode: (contentErr && contentErr.code) || 'ERROR',
        message: (contentErr && contentErr.message) ? contentErr.message : String(contentErr),
        detail: buildErrorDetail_(contentErr)
      });
    }

    // 內容表 v2：講員表格已停用，星期一不再刷新它的日期選項（第二批階段 3 的那一步）。

    // R-035：順手整理舊季度（封存超出保留範圍那幾季）。包一層 try/catch
    //    ——整理失敗不應該連累寄週報，那是兩件獨立的事。
    //
    // ⚠️ 這裏**刻意不 force**：有「未發佈但有內容」的季度就略過並記
    //    ErrorLog，等人手撳選單確認。自動流程不應該替使用者決定
    //    「那一季可以收起了」——那是判斷，不是規則。
    try {
      var retentionResult = runQuarterRetention_({});
      var blockedQuarters = retentionResult.skipped.filter(function (s) {
        return s.reason === 'HAS_UNPUBLISHED_WORK';
      });
      if (blockedQuarters.length > 0) {
        appendErrorLog_({
          source: ERROR_LOG_SOURCE.TRIGGER,
          functionName: 'weeklyBulletinSendTrigger_/runQuarterRetention_',
          errorCode: 'RETENTION_NEEDS_CONFIRMATION',
          message: '有 ' + blockedQuarters.length + ' 季未封存，因為仍然有未發佈而且有內容的主日：'
            + blockedQuarters.map(function (s) { return s.quarterId; }).join('、')
            + '　請按選單「立即整理舊季度（封存，不刪資料）」人手確認。'
        });
      }
    } catch (retentionErr) {
      appendErrorLog_({
        source: ERROR_LOG_SOURCE.TRIGGER,
        functionName: 'weeklyBulletinSendTrigger_/runQuarterRetention_',
        errorCode: (retentionErr && retentionErr.code) || 'ERROR',
        message: (retentionErr && retentionErr.message) ? retentionErr.message : String(retentionErr),
        detail: buildErrorDetail_(retentionErr)
      });
    }

    // R-033：草稿預覽連結。包一層 try/catch——預覽寄不到不應該連累週報，
    //    那是兩件獨立的事；失敗記一筆 ErrorLog 就好。
    try {
      var previewResult = sendPreviewNotice_(targetIso);
      if (!previewResult.sent && previewResult.reason !== 'DISABLED') {
        appendErrorLog_({
          source: ERROR_LOG_SOURCE.TRIGGER,
          functionName: 'weeklyBulletinSendTrigger_/sendPreviewNotice_',
          errorCode: previewResult.reason,
          message: previewResult.message
        });
      }
    } catch (previewErr) {
      appendErrorLog_({
        source: ERROR_LOG_SOURCE.TRIGGER,
        functionName: 'weeklyBulletinSendTrigger_/sendPreviewNotice_',
        errorCode: (previewErr && previewErr.code) || 'ERROR',
        message: (previewErr && previewErr.message) ? previewErr.message : String(previewErr),
        detail: buildErrorDetail_(previewErr, { argsSummary: 'isoDate=' + targetIso })
      });
    }

    sendBulletinForDate_(targetIso, {});
  } catch (err) {
    appendErrorLog_({
      source: ERROR_LOG_SOURCE.TRIGGER,
      functionName: 'weeklyBulletinSendTrigger_',
      errorCode: (err && err.code) || 'ERROR',
      message: (err && err.message) ? err.message : String(err),
      detail: buildErrorDetail_(err)
    });
  }
}

/**
 * 用途：把一個 `yyyy-MM-dd` 日期字串加減指定天數，回傳新的
 *   `yyyy-MM-dd` 字串。純函式。
 * Args:
 *   isoDate {string} 原日期，yyyy-MM-dd。
 *   days {number} 要加的天數，可以是負數。
 * Returns:
 *   {string}
 * Raises:
 *   Error 如果 `isoDate` 不是合法的 yyyy-MM-dd（`normalizeDate_()` 原樣拋出）。
 */
function addDaysToIsoDate_(isoDate, days) {
  var d = normalizeDate_(isoDate);
  var result = new Date(d.getFullYear(), d.getMonth(), d.getDate() + days);
  return formatIsoDate_(result);
}

/**
 * 用途：判斷一個 `yyyy-MM-dd` 日期字串是不是星期日。純函式。
 * Args:
 *   isoDate {string} yyyy-MM-dd。
 * Returns:
 *   {boolean}
 * Raises:
 *   Error 如果 `isoDate` 不是合法的 yyyy-MM-dd（`normalizeDate_()` 原樣拋出）。
 */
function isIsoDateSunday_(isoDate) {
  var d = normalizeDate_(isoDate);
  return d.getDay() === 0;
}

/**
 * 用途：刪除全部指向 `weeklyBulletinSendTrigger_` 的既有觸發器。
 * Args: （無）
 * Returns:
 *   {number} 刪除的觸發器數量。
 */
function removeAllSendTriggers_() {
  var triggers = ScriptApp.getProjectTriggers();
  var removed = 0;
  triggers.forEach(function (t) {
    // v3：每日自動建立季度的觸發器與自動寄送一齊安裝、一齊移除。
    var handler = t.getHandlerFunction();
    if (handler === 'weeklyBulletinSendTrigger_' || handler === 'dailyQuarterAutoCreateTrigger_') {
      ScriptApp.deleteTrigger(t);
      removed++;
    }
  });
  return removed;
}

/**
 * 用途：把 Config 的 `SEND_WEEKDAY`（例如 `'MONDAY'`）轉成
 *   `ScriptApp.WeekDay` 列舉值。
 * Args:
 *   weekdayName {string} Config `SEND_WEEKDAY` 的原始值。
 * Returns:
 *   {*} `ScriptApp.WeekDay` 的其中一個值。
 * Raises:
 *   Error 如果不是合法的星期幾英文全大寫名稱。
 */
function resolveScriptAppWeekDay_(weekdayName) {
  var key = String(weekdayName || '').trim().toUpperCase();
  var value = ScriptApp.WeekDay[key];
  if (!value) {
    throw new Error('resolveScriptAppWeekDay_：Config 的 SEND_WEEKDAY「' + weekdayName + '」不是合法的星期幾（例如 MONDAY）。');
  }
  return value;
}

/**
 * 用途：安裝每週自動寄送觸發器。**先刪除全部既有的同名觸發器，再建立
 *   一個新的**——避免連續安裝兩次變成寄兩封（見
 *   docs/幹事操作說明.md）。
 * Args: （無）
 * Returns:
 *   {{weekday:string, hour:number, minute:number, removedCount:number}}
 *     `minute` 只是把 Config `SEND_MINUTE` 原樣帶出來顯示用——Apps
 *     Script 的時間觸發器實際上不能指定分鐘，這裡不會、也不能拿它來
 *     排程。
 * Raises:
 *   Error 如果 Config 的 `SEND_WEEKDAY` 不是合法的星期幾。
 */
function installWeeklySendTrigger_() {
  var removedCount = removeAllSendTriggers_();

  var weekdayName = getConfig(CONFIG_KEYS.SEND_WEEKDAY, 'MONDAY');
  var hour = normalizeInt_(getConfig(CONFIG_KEYS.SEND_HOUR, '6'));
  var minute = normalizeInt_(getConfig(CONFIG_KEYS.SEND_MINUTE, '0'));
  var weekDayEnum = resolveScriptAppWeekDay_(weekdayName);

  ScriptApp.newTrigger('weeklyBulletinSendTrigger_')
    .timeBased()
    .onWeekDay(weekDayEnum)
    .atHour(hour)
    .create();

  // v3：每日自動建立季度（職事表有新季度的版本時建立週報與內容表）。排在寄送之前一小時，
  //    星期一的草稿預覽寄出之前，新季度已經建好。
  var dailyHour = (hour + 23) % 24;
  ScriptApp.newTrigger('dailyQuarterAutoCreateTrigger_')
    .timeBased()
    .everyDays(1)
    .atHour(dailyHour)
    .create();

  return { weekday: weekdayName, hour: hour, minute: minute, removedCount: removedCount, dailyHour: dailyHour };
}

/**
 * 用途：選單項目「安裝自動寄送觸發器」的處理函式。
 * Args: （無）
 * Returns:
 *   {void}
 */
function menuInstallSendTrigger_() {
  var ui = SpreadsheetApp.getUi();
  try {
    var result = installWeeklySendTrigger_();
    var weekdayLabel = WEEKDAY_LABELS_[String(result.weekday).toUpperCase()] || result.weekday;
    ui.alert(
      '安裝自動寄送觸發器',
      [
        '已安裝：每週' + weekdayLabel + '　約 ' + result.hour + ':' + pad2Trigger_(result.minute) + ' 執行一次。',
        '另外每日約 ' + result.dailyHour + ':00 檢查一次職事表有沒有新季度（有就自動建立該季週報與內容表）。',
        (result.removedCount > 0 ? '（先移除了 ' + result.removedCount + ' 個舊的同名觸發器，避免重複寄送。）' : ''),
        '',
        '⚠️ Apps Script 的時間觸發器只保證在指定小時內執行，不保證準確在',
        '第幾分鐘——實際觸發時間可能比預定時間晚數十分鐘，請不要當成',
        '準時執行。'
      ].filter(function (line) { return line !== ''; }).join('\n'),
      ui.ButtonSet.OK
    );
  } catch (err) {
    logMenuError_('menuInstallSendTrigger_', err);
    ui.alert('安裝自動寄送觸發器失敗', enrichAuthError_(err), ui.ButtonSet.OK);
  }
}

/**
 * 用途：把個位數的分鐘數補成兩位字串，例如 `5` → `'05'`。
 * Args:
 *   n {number}
 * Returns:
 *   {string}
 */
function pad2Trigger_(n) {
  return (n < 10 ? '0' : '') + n;
}

/**
 * 用途：選單項目「移除自動寄送觸發器」的處理函式。
 * Args: （無）
 * Returns:
 *   {void}
 */
function menuRemoveSendTrigger_() {
  var ui = SpreadsheetApp.getUi();
  try {
    var removed = removeAllSendTriggers_();
    ui.alert('移除自動寄送觸發器', '已移除 ' + removed + ' 個觸發器。', ui.ButtonSet.OK);
  } catch (err) {
    logMenuError_('menuRemoveSendTrigger_', err);
    ui.alert('移除自動寄送觸發器失敗', enrichAuthError_(err), ui.ButtonSet.OK);
  }
}

/**
 * 用途：選單項目「查看觸發器狀態」的處理函式。唯讀。內容表 v2 起每一種觸發器一行，寫明預期
 *   與實際數目及狀態（預期清單見 src/TriggerInventory.gs）；清單以外的觸發器另列。
 * Args: （無）
 * Returns:
 *   {void}
 * Raises:
 *   （無）失敗時寫 `ErrorLog` 並用對話框顯示。
 */
function menuShowTriggerStatus_() {
  var ui = SpreadsheetApp.getUi();
  try {
    // 內容表 v2：每一行寫明預期數目與狀態（src/TriggerInventory.gs，與兩個檢測同一個來源）。
    var status = buildTriggerStatusLines_(inspectProjectTriggers_());
    ui.alert(status.title, status.lines.join('\n'), ui.ButtonSet.OK);
  } catch (err) {
    logMenuError_('menuShowTriggerStatus_', err);
    ui.alert('查看觸發器狀態失敗', enrichAuthError_(err), ui.ButtonSet.OK);
  }
}
