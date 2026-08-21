/**
 * BulletinBatch.gs
 *
 * prompt9 第 2 部分：「一鍵產生本季全部週報（Word）」——逐個主日呼叫
 * `saveBulletinDocx_()`，把結果記回 `BulletinWeeks`（`DOC_ID`／
 * `LAST_GENERATED_AT`），單一主日失敗不會中斷其餘的，最後整批結果寫入
 * `Diagnostics`。
 *
 * ⚠️ Apps Script 單次執行有 6 分鐘上限。一季 13 個主日、每份 Word 都要讀
 * Drive／解壓／壓縮，時間有機會不夠。所以本檔案會在**接近**上限（不是
 * 真的等到被強制中止）時主動停手，已經做完的不會遺失，也不會重做——
 * 幹事再撳一次選單就會從下一個還沒有 `LAST_GENERATED_AT` 的主日繼續。
 */

'use strict';

/**
 * 用途：這次批次執行容許的時間預算（毫秒）。
 *
 *   ⚠️ 刻意比 Apps Script 實際的 6 分鐘執行上限短一截（5 分鐘），留
 *   1 分鐘緩衝給「寫 Diagnostics 報告、寫 AuditLog、把結果傳回選單」
 *   這些收尾動作——如果緊貼著 6 分鐘才停手，收尾這幾步有機會來不及做完
 *   就被 Apps Script 強制砍斷，那樣連「已完成 N／M」這句回報都送不出去。
 * Args: （無）
 * Returns:
 *   {number}
 */
function bulletinBatchTimeBudgetMs_() {
  return 5 * 60 * 1000;
}

/**
 * 用途：判斷這次批次執行是不是應該因為接近時間上限而安全中止。純函式，
 *   方便測試不用真的等 5 分鐘。
 * Args:
 *   startMs {number} 這次執行開始的時間戳記（毫秒）。
 *   nowMs {number} 目前的時間戳記（毫秒）。
 *   budgetMs {number} 容許的執行時間預算（毫秒）。
 * Returns:
 *   {boolean}
 */
function shouldStopBulletinBatchForTime_(startMs, nowMs, budgetMs) {
  return (nowMs - startMs) >= budgetMs;
}

/**
 * 用途：判斷一行 `BulletinWeeks` 資料列是不是已經產生過 Word——
 *   `LAST_GENERATED_AT` 有值就算已經做過，這次批次會跳過它，不重做。
 * Args:
 *   weekRow {?Object} `readSheet(SHEETS.BULLETIN_WEEKS)` 的其中一行；
 *     那個主日在 `BulletinWeeks` 完全沒有資料列時傳 `null`／`undefined`。
 * Returns:
 *   {boolean}
 */
function bulletinAlreadyGenerated_(weekRow) {
  return Boolean(weekRow && weekRow.LAST_GENERATED_AT instanceof Date);
}

/**
 * 用途：把一次成功的批次產生結果記回 `BulletinWeeks`（`DOC_ID`／
 *   `LAST_GENERATED_AT`），並記一筆逐格 `AuditLog`。
 *
 *   ⚠️ 找不到那一行（`BulletinWeeks` 沒有這個主日的資料列，例如忘記先
 *   撳「建立本季空白週報」）不拋錯——Word 檔案本身已經產生成功並存進
 *   雲端硬碟，寫不回 `BulletinWeeks` 只是少一個索引方便日後查，不應該
 *   讓整批操作因此失敗，改為回傳 `false` 讓呼叫方記一筆警告。
 * Args:
 *   isoDate {string} 主日日期，yyyy-MM-dd。
 *   docId {string} 產生的 `.docx` 在雲端硬碟的檔案 ID。
 * Returns:
 *   {boolean} 是否成功寫回。
 */
function recordBulletinGeneration_(isoDate, docId) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEETS.BULLETIN_WEEKS);
  if (!sheet) return false;

  var def = COLUMNS.BULLETIN_WEEKS;
  var dateCol = def.keys.indexOf('SERVICE_DATE') + 1;
  var docIdCol = def.keys.indexOf('DOC_ID') + 1;
  var lastGenCol = def.keys.indexOf('LAST_GENERATED_AT') + 1;

  var lastRow = sheet.getLastRow();
  if (lastRow < 3) return false;

  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(isoDate || ''));
  if (!m) return false;
  var y = Number(m[1]);
  var mo = Number(m[2]);
  var d = Number(m[3]);

  var dates = sheet.getRange(3, dateCol, lastRow - 2, 1).getValues();
  for (var i = 0; i < dates.length; i++) {
    var cellDate = null;
    try {
      cellDate = normalizeDate_(dates[i][0]);
    } catch (parseErr) {
      cellDate = null;
    }
    if (!rosterDateMatchesYMD_(cellDate, y, mo, d)) continue;

    var rowNo = i + 3;
    sheet.getRange(rowNo, docIdCol).setValue(sanitizeCellText_(docId));
    sheet.getRange(rowNo, lastGenCol).setValue(new Date());

    appendAuditLog_({
      action: 'BULLETIN_BATCH_GENERATE_ONE', sheetName: SHEETS.BULLETIN_WEEKS,
      rowKey: isoDate, field: 'DOC_ID', oldValue: '', newValue: docId,
      notes: '「產生本季全部週報」批次產生的其中一份。'
    });
    return true;
  }
  return false;
}

/**
 * 用途：「一鍵產生本季全部週報（Word）」的真正入口。逐個主日呼叫
 *   `saveBulletinDocx_()`，單一主日失敗不會中斷其餘的；接近時間上限就
 *   安全中止，已完成的不會遺失。
 * Args:
 *   quarterId {string} 季度 ID，例如 `'2027T4'`。
 *   options {{nowFn:function():number=}=} 選填，測試用來注入假的時間
 *     來源；正式路徑一律用 `Date.now()`。
 * Returns:
 *   {{quarterId:string, total:number, succeeded:number, failed:number,
 *     skipped:number, stoppedForTime:boolean,
 *     results:{isoDate:string, status:string, message:string}[]}}
 *     `status` 是 `'OK'`／`'FAILED'`／`'SKIPPED'`（已經產生過）。
 * Raises:
 *   Error 如果職事表讀取失敗（`listQuarterServiceDates_()` 原樣拋出）——
 *     這是整批操作共用的前置條件，壞了沒有任何一個主日做得下去，
 *     不屬於「單一主日失敗」的範圍。
 */
function generateQuarterBulletinsBatch_(quarterId, options) {
  var opts = options || {};
  var nowFn = opts.nowFn || function () { return new Date().getTime(); };
  var startMs = nowFn();
  var budgetMs = bulletinBatchTimeBudgetMs_();

  var serviceDates = listQuarterServiceDates_(quarterId);
  var weekRowsByIso = readBulletinWeekRowsByIso_(quarterId);

  var results = [];
  var succeeded = 0;
  var failed = 0;
  var skipped = 0;
  var stoppedForTime = false;

  for (var i = 0; i < serviceDates.length; i++) {
    if (shouldStopBulletinBatchForTime_(startMs, nowFn(), budgetMs)) {
      stoppedForTime = true;
      break;
    }

    var isoDate = serviceDates[i].isoDate;
    var weekRow = weekRowsByIso[isoDate];

    if (bulletinAlreadyGenerated_(weekRow)) {
      skipped++;
      results.push({ isoDate: isoDate, status: 'SKIPPED', message: '已經產生過（上次產生時間：' + formatDateForBatchReport_(weekRow.LAST_GENERATED_AT) + '），不重做。' });
      continue;
    }

    try {
      var result = saveBulletinDocx_(isoDate);
      if (!result.ok) {
        failed++;
        results.push({ isoDate: isoDate, status: 'FAILED', message: result.message || ('原因代碼：' + result.reason) });
        continue;
      }

      var recorded = recordBulletinGeneration_(isoDate, result.file.fileId);
      succeeded++;
      results.push({
        isoDate: isoDate, status: 'OK',
        message: '已產生：' + result.file.fileName
          + (recorded ? '' : '　⚠️ BulletinWeeks 沒有這一行，DOC_ID／LAST_GENERATED_AT 未能寫回（檔案本身已經產生成功）。')
      });
    } catch (err) {
      failed++;
      results.push({ isoDate: isoDate, status: 'FAILED', message: (err && err.message) ? err.message : String(err) });
    }
  }

  var summary = {
    quarterId: quarterId,
    total: serviceDates.length,
    succeeded: succeeded,
    failed: failed,
    skipped: skipped,
    stoppedForTime: stoppedForTime,
    results: results
  };

  writeDiagnosticsReport_('本季週報產生', buildBulletinBatchReportLines_(summary));
  appendAuditLog_({
    action: 'BULLETIN_BATCH_GENERATE_RUN', sheetName: SHEETS.BULLETIN_WEEKS, rowKey: quarterId,
    notes: JSON.stringify({
      total: summary.total, succeeded: summary.succeeded, failed: summary.failed,
      skipped: summary.skipped, stoppedForTime: summary.stoppedForTime
    })
  });

  return summary;
}

/**
 * 用途：把 `Date` 格式化成報告用的簡短字串。純函式，不依賴
 *   `Utilities.formatDate()`（那個要 `Session`，這裡只是給人看的粗略時間，
 *   不需要精準到時區）。
 * Args:
 *   date {Date}
 * Returns:
 *   {string}
 */
function formatDateForBatchReport_(date) {
  if (!(date instanceof Date)) return '';
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate())
    + ' ' + pad2(date.getHours()) + ':' + pad2(date.getMinutes());
}

/**
 * 用途：把 `generateQuarterBulletinsBatch_()` 的結果排版成 `Diagnostics`
 *   報告的內容行。
 *
 *   ⚠️ 區段標題一律用全形括號「【…】」，不可以用 `===` 開頭——見
 *   docs/已知bug類型.md 事故六。
 * Args:
 *   summary {Object} `generateQuarterBulletinsBatch_()` 的回傳值。
 * Returns:
 *   {string[]}
 */
function buildBulletinBatchReportLines_(summary) {
  var lines = [];
  lines.push('季度：' + summary.quarterId);
  lines.push('總共 ' + summary.total + ' 個主日：成功 ' + summary.succeeded
    + '、失敗 ' + summary.failed + '、跳過（已產生過）' + summary.skipped + '。');

  if (summary.stoppedForTime) {
    lines.push('');
    lines.push('⚠️ 接近 Apps Script 執行時間上限，已安全中止。');
    lines.push('已完成 ' + (summary.succeeded + summary.skipped) + '／' + summary.total + '，請再撳一次「產生本季全部週報」繼續（已經產生過的不會重做）。');
  }

  if (summary.failed > 0) {
    lines.push('');
    lines.push('【失敗的主日】');
    summary.results.filter(function (r) { return r.status === 'FAILED'; }).forEach(function (r) {
      lines.push('　' + r.isoDate + '：' + r.message);
    });
  }

  lines.push('');
  lines.push('【逐個主日結果】');
  summary.results.forEach(function (r) {
    lines.push('　' + r.isoDate + '　[' + r.status + ']　' + r.message);
  });

  return lines;
}

// =====================================================================
// 選單處理函式
// =====================================================================

/**
 * 用途：選單項目「產生本季全部週報（Word）」的處理函式。
 * Args: （無）
 * Returns:
 *   {void}
 */
function menuGenerateQuarterBulletinsBatch_() {
  var ui = SpreadsheetApp.getUi();
  try {
    var resp = ui.prompt(
      '產生本季全部週報（Word）',
      '請輸入季度 ID（例如 2027T4）：',
      ui.ButtonSet.OK_CANCEL
    );
    if (resp.getSelectedButton() !== ui.Button.OK) return;

    var quarterId = resp.getResponseText().trim();
    if (!quarterId) {
      ui.alert('產生本季全部週報', '季度 ID 不可以是空的。', ui.ButtonSet.OK);
      return;
    }

    var summary = generateQuarterBulletinsBatch_(quarterId);
    var lines = [
      '季度：' + summary.quarterId,
      '總共 ' + summary.total + ' 個主日：成功 ' + summary.succeeded
        + '、失敗 ' + summary.failed + '、跳過（已產生過）' + summary.skipped + '。',
      '',
      '完整結果已寫入 Diagnostics 工作表。'
    ];
    if (summary.stoppedForTime) {
      lines.splice(2, 0, '', '⚠️ 接近執行時間上限，已安全中止，請再撳一次繼續（已完成的不會重做）。');
    }

    ui.alert('產生本季全部週報', lines.join('\n'), ui.ButtonSet.OK);
  } catch (err) {
    logMenuError_('menuGenerateQuarterBulletinsBatch_', err);
    ui.alert('產生本季全部週報失敗', enrichAuthError_(err), ui.ButtonSet.OK);
  }
}
