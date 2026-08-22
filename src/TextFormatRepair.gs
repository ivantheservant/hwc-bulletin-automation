/**
 * TextFormatRepair.gs
 *
 * 一次性修復：把「設計上是文字、但已經被 Google Sheets 自作主張轉成數字或
 * 日期」的舊資料改回文字。
 *
 * ⚠️ 這個問題的成因與後果（docs/已知bug類型.md 事故二十八）：
 *   `Finance` 的金額欄樣本值是 '42,150'，`BulletinWeeks` 的 `ATT_*` 是
 *   '12 人'／'—'，`Fellowships` 的 `MEETING_DATE` 是 '10/5 星期日'。這些欄
 *   設計上全部都是**文字**。但 `setValue('42,150')` 在沒有預先設純文字格式
 *   的儲存格上，會被試算表解讀成數字 42150。於是：
 *     1. 週報印出「42150」，少了千分位逗號；
 *     2. 每次匯入都覺得「值不同」而重寫一次，永遠不會冪等——這正是第一輪
 *        自測 I08「匯入兩次改動必為 0」一直紅的真正原因。
 *
 * 寫入端已經改成「先設 '@' 再寫值」（`setCellValueTextSafe_()`／
 * `applyTextFormatToRange_()`，見 src/SheetUtils.gs）。這個檔案負責清理在
 * 修正之前已經寫壞了的舊資料。
 *
 * ⚠️ 修復只還原**型別**，不還原**顯示格式**：從數字 42150 無法反推原本是
 * '42,150' 定 '42150.00'。所以這裡只把它寫回文字 '42150'，正確的顯示文字
 * 由下一次「從內容表匯入」帶回來（那時寫入端已經有保護，不會再被轉走）。
 * 報告會明白寫出這一點，不可以讓人以為修完就等於資料正確。
 */

'use strict';

/**
 * 用途：判斷一個儲存格的值，是不是「設計上是文字但被轉走了」。純函式。
 *
 *   ⚠️ 空字串、`null`、本身已經是字串的，一律不算——不要為了報一個好看的
 *   數字而去動不需要動的格。
 * Args:
 *   value {*} 儲存格原值（`getValues()` 拿到的，未經型別正規化）。
 * Returns:
 *   {string|null} 需要修復時回「應該寫回去的文字」，不需要修復回 `null`。
 */
function textFormatRepairTargetText_(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') {
    if (!isFinite(value)) return null;
    return String(value);
  }
  if (Object.prototype.toString.call(value) === '[object Date]') {
    // ⚠️ formatIsoDate_() 回字串；normalizeDate_() 回的是 Date 物件，寫回去
    //    等於什麼都沒有做過。
    return formatIsoDate_(value);
  }
  return null;
}

/**
 * 用途：算出某一欄要修哪幾格。純函式，方便單獨測試。
 * Args:
 *   columnValues {Array[]} `getValues()` 的輸出（每個元素是一行、長度 1）。
 *   firstRowNo {number} `columnValues[0]` 對應的真實行號。
 * Returns:
 *   {{rowNo:number, oldValue:*, newValue:string}[]}
 */
function planTextFormatRepairForColumn_(columnValues, firstRowNo) {
  var out = [];
  (columnValues || []).forEach(function (row, i) {
    var value = (row && row.length > 0) ? row[0] : null;
    var text = textFormatRepairTargetText_(value);
    if (text === null) return;
    out.push({ rowNo: firstRowNo + i, oldValue: value, newValue: text });
  });
  return out;
}

/**
 * 用途：掃描全部有 `textFormatColumns` 的工作表，把被轉走的舊資料改回文字。
 *
 *   ⚠️ 只改**型別**，不刪行、不動其他欄。順序一定是「先設 '@' 格式，再寫
 *   文字值」——次序反過來的話寫進去的文字會即刻再被轉走一次。
 * Args:
 *   options {{dryRun?:boolean}} `dryRun` 為 `true` 時只點算不寫入。
 * Returns:
 *   {{ok:boolean, scannedSheets:number, scannedColumns:number,
 *     repaired:number, dryRun:boolean, bySheet:Object[], skipped:string[]}}
 */
function repairTextColumnsStoredAsNumbers_(options) {
  var opts = options || {};
  var dryRun = opts.dryRun === true;
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  var summary = {
    ok: true,
    scannedSheets: 0,
    scannedColumns: 0,
    repaired: 0,
    dryRun: dryRun,
    bySheet: [],
    skipped: []
  };

  Object.keys(COLUMNS).forEach(function (sheetId) {
    var def = COLUMNS[sheetId];
    var textKeys = def.textFormatColumns || [];
    if (textKeys.length === 0) return;

    var sheetName = SHEETS[sheetId];
    if (!sheetName) return;
    var sheet = ss.getSheetByName(sheetName);
    if (!sheet) {
      summary.skipped.push(sheetName + '：工作表不存在，略過。');
      return;
    }

    var lastRow = sheet.getLastRow();
    summary.scannedSheets++;
    if (lastRow < 3) {
      summary.bySheet.push({ sheetName: sheetName, repaired: 0, columns: [], rows: 0 });
      return;
    }

    var numRows = lastRow - 2;
    var sheetEntry = { sheetName: sheetName, repaired: 0, columns: [], rows: numRows };

    textKeys.forEach(function (key) {
      var colIndex = def.keys.indexOf(key) + 1;
      if (colIndex <= 0) return;
      summary.scannedColumns++;

      var range = sheet.getRange(3, colIndex, numRows, 1);
      var fixes = planTextFormatRepairForColumn_(range.getValues(), 3);

      // 不論有沒有要修的格，都把整欄的格式補設成純文字——舊版建表時
      // `getMaxRows()` 可能比現在的資料短，新行沒有這道保護。
      if (!dryRun) range.setNumberFormat('@');

      if (fixes.length === 0) return;
      if (!dryRun) {
        fixes.forEach(function (fix) {
          var cell = sheet.getRange(fix.rowNo, colIndex, 1, 1);
          cell.setNumberFormat('@');
          cell.setValue(fix.newValue);
        });
      }
      sheetEntry.repaired += fixes.length;
      summary.repaired += fixes.length;
      sheetEntry.columns.push({
        fieldKey: key,
        count: fixes.length,
        samples: fixes.slice(0, 3).map(function (fix) {
          return '第 ' + fix.rowNo + ' 行：' + String(fix.oldValue) + ' → ' + fix.newValue;
        })
      });
    });

    summary.bySheet.push(sheetEntry);
  });

  return summary;
}

/**
 * 用途：把修復結果排版成 `Diagnostics` 報告的內容行。
 *
 *   ⚠️ 區段標題一律用全形括號「【…】」，不可以用 `=`／`+`／`-`／`@` 開頭
 *   ——見 docs/已知bug類型.md 事故六。
 * Args:
 *   summary {Object} `repairTextColumnsStoredAsNumbers_()` 的輸出。
 * Returns:
 *   {string[]}
 */
function buildTextFormatRepairReportLines_(summary) {
  var lines = [];
  lines.push('【摘要】');
  lines.push('模式：' + (summary.dryRun ? '只檢查、不寫入' : '實際修復'));
  lines.push('掃描工作表：' + summary.scannedSheets + ' 張　掃描欄位：'
    + summary.scannedColumns + ' 欄');
  lines.push('修正格數：' + summary.repaired + ' 格');
  lines.push('');

  if (summary.repaired === 0) {
    lines.push('沒有發現被轉成數字或日期的文字欄位，不需要修復。');
  }

  summary.bySheet.forEach(function (entry) {
    if (entry.repaired === 0) return;
    lines.push('【' + entry.sheetName + '】共 ' + entry.repaired + ' 格');
    entry.columns.forEach(function (col) {
      // ⚠️ 先取出成獨立變數再串接：夾在引號之間的屬性存取，如果屬性名
      //    啱好是一個真實的 gTLD（id、name、info、dev……），會被
      //    tools/scan-staged-secrets.js 誤判成網域，見事故六。
      //    （這一句本身也不可以寫出那個「點加屬性名」的形狀。）
      var fieldKey = col.fieldKey;
      lines.push('　' + fieldKey + '：' + col.count + ' 格');
      col.samples.forEach(function (sample) { lines.push('　　' + sample); });
      if (col.count > col.samples.length) {
        lines.push('　　（只列出前 ' + col.samples.length + ' 格）');
      }
    });
    lines.push('');
  });

  if (summary.skipped.length > 0) {
    lines.push('【略過】');
    summary.skipped.forEach(function (text) { lines.push('　' + text); });
    lines.push('');
  }

  lines.push('【要知道的事】');
  lines.push('這次修復只把型別改回文字，不能還原原本的顯示格式。');
  lines.push('例如金額被轉成數字 42150 之後，無法反推它原本是「42,150」還是');
  lines.push('「42150.00」。正確的顯示文字要靠下一次「從內容表匯入」帶回來');
  lines.push('——寫入端已經改成先設純文字格式再寫值，不會再被轉走。');
  lines.push('');
  lines.push('建議接著做：選單「從內容表匯入」跑一次，然後再跑一次，');
  lines.push('第二次應該是 0 項改動。如果不是 0，代表仲有未修好的欄位。');

  return lines;
}

/**
 * 用途：選單「修復被轉成數字的文字欄位」。
 * Returns:
 *   {void}
 */
function menuRepairTextColumns_() {
  var ui = SpreadsheetApp.getUi();
  var answer = ui.alert(
    '修復被轉成數字的文字欄位',
    '會掃描 BulletinWeeks、Fellowships、Finance 等工作表設計上是文字的欄位，'
      + '把已經被試算表轉成數字或日期的格改回文字。\n\n'
      + '不會刪行，不會動其他欄。要繼續嗎？',
    ui.ButtonSet.YES_NO
  );
  if (answer !== ui.Button.YES) return;

  var summary = repairTextColumnsStoredAsNumbers_({ dryRun: false });
  writeDiagnosticsReport_('修復被轉成數字的文字欄位', buildTextFormatRepairReportLines_(summary));
  ui.alert('修復完成',
    '修正了 ' + summary.repaired + ' 格。詳情見 Diagnostics 工作表。\n\n'
      + '接著請跑一次「從內容表匯入」把正確的顯示文字帶回來。',
    ui.ButtonSet.OK);
}
