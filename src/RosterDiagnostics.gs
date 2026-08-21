/**
 * RosterDiagnostics.gs
 *
 * 選單用的職事表讀取測試報告。這個檔案只呼叫 RosterRead.gs 的入口
 * （readRosterSnapshot_()／listRosterServiceDatesForQuarter_()），本身
 * 不直接碰 SpreadsheetApp 讀職事表，也不碰職事表試算表的任何寫入方法。
 */

'use strict';

/**
 * 用途：選單項目「測試讀取職事表」的處理函式。問使用者一個主日日期，
 *   呼叫 readRosterSnapshot_()，用對話框顯示摘要，完整內容寫入 Diagnostics。
 * Args: （無）
 * Returns:
 *   {void}
 */
function menuTestReadRoster_() {
  var ui = SpreadsheetApp.getUi();
  try {
    var defaultDate = getConfig(CONFIG_KEYS.ROSTER_TEST_DATE, '2027-10-03');
    var resp = ui.prompt(
      '測試讀取職事表',
      '請輸入要測試的主日日期，格式 yyyy-MM-dd（例如 ' + defaultDate + '）：',
      ui.ButtonSet.OK_CANCEL
    );
    if (resp.getSelectedButton() !== ui.Button.OK) return;

    var isoDate = resp.getResponseText().trim() || defaultDate;
    var snapshot = readRosterSnapshot_(isoDate);

    if (snapshot.notConfigured) {
      ui.alert('尚未設定職事表位置', '請先在 Config 工作表填入 ROSTER_SPREADSHEET_ID，再重試一次。', ui.ButtonSet.OK);
      return;
    }

    ui.alert('職事表讀取測試', buildRosterSnapshotSummaryLines_(snapshot).join('\n'), ui.ButtonSet.OK);
    writeRosterSnapshotDiagnosticsReport_(snapshot);
  } catch (err) {
    logMenuError_('menuTestReadRoster_', err);
    ui.alert('測試讀取職事表失敗', enrichAuthError_(err), ui.ButtonSet.OK);
  }
}

/**
 * 用途：選單項目「測試讀取職事表（全季）」的處理函式。問使用者一個
 *   QuarterID，逐個主日呼叫 readRosterSnapshot_()，把「日期 × 崗位 ×
 *   姓名」寫入 Diagnostics，遵守 DIAGNOSTICS_MAX_ROWS 上限。
 * Args: （無）
 * Returns:
 *   {void}
 */
function menuTestReadRosterQuarter_() {
  var ui = SpreadsheetApp.getUi();
  try {
    var defaultQuarterId = guessRosterTestQuarterId_();
    var resp = ui.prompt(
      '測試讀取職事表（全季）',
      '請輸入要測試的季度 ID' + (defaultQuarterId ? '（例如 ' + defaultQuarterId + '）' : '（例如 2027T4）') + '：',
      ui.ButtonSet.OK_CANCEL
    );
    if (resp.getSelectedButton() !== ui.Button.OK) return;

    var quarterId = resp.getResponseText().trim() || defaultQuarterId;
    if (!quarterId) {
      ui.alert('請輸入季度 ID。');
      return;
    }

    var dates = listRosterServiceDatesForQuarter_(quarterId);
    if (dates.length === 0) {
      ui.alert('季度「' + quarterId + '」在職事表 ServiceDates 找不到任何主日，請確認季度 ID 是否正確。');
      return;
    }

    var lines = buildRosterQuarterReportLines_(quarterId, dates);
    writeDiagnosticsReport_('職事表讀取測試（全季）', lines);
    ui.alert('已完成', '季度「' + quarterId + '」共 ' + dates.length + ' 個主日，已把結果寫入 Diagnostics。', ui.ButtonSet.OK);
  } catch (err) {
    logMenuError_('menuTestReadRosterQuarter_', err);
    ui.alert('測試讀取職事表（全季）失敗', enrichAuthError_(err), ui.ButtonSet.OK);
  }
}

/**
 * 用途：用 Config 的 ROSTER_TEST_DATE 呼叫一次快照，猜一個預設的
 *   QuarterID 給「測試讀取職事表（全季）」的輸入框用。猜不到（例如尚未
 *   設定職事表位置、或該日期找不到）就回空字串，讓使用者自己輸入，
 *   不能讓整個選單項目因此失敗。
 * Args: （無）
 * Returns:
 *   {string}
 */
function guessRosterTestQuarterId_() {
  try {
    var testDate = getConfig(CONFIG_KEYS.ROSTER_TEST_DATE, '2027-10-03');
    var probe = readRosterSnapshot_(testDate);
    return probe.quarterId || '';
  } catch (err) {
    return '';
  }
}

/**
 * 用途：組出「測試讀取職事表」對話框摘要用的文字行。
 * Args:
 *   snapshot {Object} readRosterSnapshot_() 的回傳值。
 * Returns:
 *   {string[]}
 */
function buildRosterSnapshotSummaryLines_(snapshot) {
  var lines = [
    '日期：' + snapshot.isoDate,
    '找到資料：' + (snapshot.found ? '是' : '否')
  ];

  if (snapshot.found) {
    lines.push('季度：' + snapshot.quarterId);
    lines.push('階段：' + (snapshot.quarterStage || '（未知）'));
    lines.push('是否已正式發出：' + (snapshot.isOfficial ? '是' : '否'));
    lines.push('版本：' + (snapshot.versionNo === null ? '（尚未生成）' : snapshot.versionNo));
    lines.push('當月第幾個主日：' + snapshot.weekOfMonth);
    lines.push('特別主日：' + (snapshot.special ? snapshot.special.type + '／' + snapshot.special.title : '（無）'));
    lines.push('崗位數：' + snapshot.posts.length);
    lines.push('已排定人數：' + snapshot.assignments.length);
  }

  lines.push('警告數：' + snapshot.warnings.length);
  return lines;
}

/**
 * 用途：把一次快照的完整內容寫入 Diagnostics，報告名稱「職事表讀取測試」。
 * Args:
 *   snapshot {Object} readRosterSnapshot_() 的回傳值。
 * Returns:
 *   {void}
 */
function writeRosterSnapshotDiagnosticsReport_(snapshot) {
  var lines = [];
  lines.push('日期：' + snapshot.isoDate);
  lines.push('ok=' + snapshot.ok + '　notConfigured=' + snapshot.notConfigured + '　found=' + snapshot.found);

  if (snapshot.found) {
    lines.push(
      '季度=' + snapshot.quarterId + '　階段=' + snapshot.quarterStage
      + '　正式發出=' + snapshot.isOfficial + '　版本=' + snapshot.versionNo
    );
    lines.push('當月第幾個主日=' + snapshot.weekOfMonth);
    lines.push('ServiceDate：' + JSON.stringify(snapshot.serviceDate));
    lines.push('特別主日：' + (snapshot.special ? JSON.stringify(snapshot.special) : '（無）'));

    lines.push('崗位（' + snapshot.posts.length + ' 個）：');
    snapshot.posts.forEach(function (p) {
      lines.push('　' + p.displayOrder + '　' + p.postId + '　' + p.nameTC + '　slotCount=' + p.slotCount);
    });

    lines.push('事奉安排（' + snapshot.assignments.length + ' 筆）：');
    snapshot.assignments.forEach(function (a) {
      lines.push(
        '　' + a.postId + '　#' + a.slotIndex + '　' + (a.personName || '')
        + '　personId=' + (a.personId || '（無）') + '　locked=' + a.locked
      );
    });
  }

  lines.push('警告（' + snapshot.warnings.length + ' 筆）：');
  snapshot.warnings.forEach(function (w) {
    lines.push('　[' + w.code + '] ' + w.message);
  });

  writeDiagnosticsReport_('職事表讀取測試', lines);
}

/**
 * 用途：組出「測試讀取職事表（全季）」報告的內容行，逐個主日呼叫快照，
 *   把每一筆事奉安排（日期 × 崗位 × 姓名）各佔一行；超過
 *   DIAGNOSTICS_MAX_ROWS 就截斷，最後一行明確寫「已截斷，尚餘 N 行未
 *   顯示」（自己截斷，不倚賴 writeDiagnosticsReport_() 的截斷邏輯，因為
 *   那邊的截斷訊息格式不同——這裡刻意採用本輪指定的措辭）。
 * Args:
 *   quarterId {string} 季度 ID。
 *   dates {string[]} listRosterServiceDatesForQuarter_() 的回傳值。
 * Returns:
 *   {string[]}
 */
function buildRosterQuarterReportLines_(quarterId, dates) {
  var lines = ['季度：' + quarterId + '　共 ' + dates.length + ' 個主日'];

  dates.forEach(function (isoDate) {
    var snapshot = readRosterSnapshot_(isoDate);
    if (!snapshot.found) {
      lines.push(isoDate + '　（找不到這個主日的資料）');
      return;
    }
    if (snapshot.assignments.length === 0) {
      lines.push(isoDate + '　（沒有任何事奉安排）');
      return;
    }
    snapshot.assignments.forEach(function (a) {
      lines.push(isoDate + '　' + a.postId + '　' + (a.personName || '（未排定）'));
    });
  });

  var maxRows = normalizeInt_(getConfig(CONFIG_KEYS.DIAGNOSTICS_MAX_ROWS, '380'));
  if (!maxRows || maxRows < 1) maxRows = 380;

  if (lines.length > maxRows) {
    var remaining = lines.length - (maxRows - 1);
    lines = lines.slice(0, maxRows - 1);
    lines.push('已截斷，尚餘 ' + remaining + ' 行未顯示。');
  }

  return lines;
}
