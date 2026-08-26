/**
 * BulletinDiagnostics.gs
 *
 * 週報資料模型相關的兩個選單處理函式：
 *   - 「建立本季空白週報」：為整季每一個主日在 `BulletinWeeks` 建一行空白骨架。
 *   - 「預覽本週週報資料」：叫 buildBulletinModel_() 並把完整模型寫入 `Diagnostics`。
 *
 * 這個檔案只呼叫其他模組的入口，本身不直接讀職事表，也不碰 Google Docs、
 * PDF、電郵、觸發器。
 */

'use strict';

/**
 * 用途：選單項目「建立本季空白週報」的處理函式。問一個 QuarterID，從職事表
 *   讀該季全部主日，為每一個尚未存在的主日在 `BulletinWeeks` 建立一行，
 *   並自動填入可以推斷的欄位。
 *
 *   **冪等**：已經存在的日期完全不動（連一格都不改），只補新的。
 * Args: （無）
 * Returns:
 *   {void}
 */
function menuCreateBlankBulletinWeeks_() {
  var ui = SpreadsheetApp.getUi();
  try {
    var defaultQuarterId = guessRosterTestQuarterId_();
    var resp = ui.prompt(
      '建立本季空白週報',
      '請輸入要建立的季度 ID' + (defaultQuarterId ? '（例如 ' + defaultQuarterId + '）' : '（例如 2027T4）') + '：',
      ui.ButtonSet.OK_CANCEL
    );
    if (resp.getSelectedButton() !== ui.Button.OK) return;

    var quarterId = resp.getResponseText().trim() || defaultQuarterId;
    if (!quarterId) {
      ui.alert('請輸入季度 ID。');
      return;
    }

    var result = createBlankBulletinWeeks_(quarterId);
    ui.alert(
      '建立本季空白週報',
      [
        '季度：' + quarterId,
        '主日數：' + result.totalDates
          + '（來源：' + (result.rosterFound ? '職事表' : '曆法推算') + '）',
        '新增行數：' + result.added,
        '略過（已存在）：' + result.skipped,
        '',
        result.message
      ].join('\n'),
      ui.ButtonSet.OK
    );
  } catch (err) {
    logMenuError_('menuCreateBlankBulletinWeeks_', err);
    ui.alert('建立本季空白週報失敗', enrichAuthError_(err), ui.ButtonSet.OK);
  }
}

/**
 * 用途：為指定季度的每一個主日，在 `BulletinWeeks` 補一行空白骨架。
 *   已經存在的日期完全不動。每新增一行寫一筆 `AuditLog`。
 *
 *   自動填入的欄位：`SERVICE_DATE`、`QUARTER_ID`、`WEEK_OF_MONTH`、
 *   `SPECIAL_TYPE`（來自 `special.title`）、`PROGRAM_TEMPLATE_ID`（依特別
 *   主日推斷）、`ATTENDANCE_DATE`（主日減 7 天）、`PRELUDE`、`PAGE_TITLE`、
 *   `ATTENDANCE_HEADING`、`NEXT_WEEK_HEADING`、`PRAYER_BLOCK_HEADING`
 *   （後五項來自 Config 預設值）、`STATUS`＝`DRAFT`。其餘欄位留空等人手填。
 * Args:
 *   quarterId {string} 季度 ID。
 * Returns:
 *   {{totalDates:number, added:number, skipped:number, addedDates:string[]}}
 * Raises:
 *   Error 如果 `ROSTER_SPREADSHEET_ID` 未設定，或職事表讀取失敗。
 */
function createBlankBulletinWeeks_(quarterId) {
  // ⚠️ R-036：職事表未有該季資料**不再令這一步中止**。改為用曆法推算該季
  //    全部星期日，照樣建立骨架，事奉相關欄位留空、`ROSTER_STATUS` 寫
  //    `NOT_FOUND`，之後撳「補抓空白的事奉欄位」補回去。
  //
  //    週報有大量與事奉無關的欄位（講題、詩歌、家事報告、人數）本來就
  //    填得——因為一部分資料未到而令全部工作開始不到，是不對的。
  //    見 docs/已知bug類型.md 事故四十。
  var resolution = resolveQuarterServiceDates_(quarterId);
  var dates = resolution.dates;
  var existingRows = readSheet(SHEETS.BULLETIN_WEEKS);

  var templateConfig = {
    baptismKeywords: getConfigTextList_(CONFIG_KEYS.TEMPLATE_KEYWORDS_BAPTISM, '浸禮'),
    anniversaryKeywords: getConfigTextList_(CONFIG_KEYS.TEMPLATE_KEYWORDS_ANNIVERSARY, '堂慶,週年'),
    templateDefault: getConfig(CONFIG_KEYS.TEMPLATE_DEFAULT, 'TPL_NORMAL')
  };
  var defaults = {
    prelude: getConfig(CONFIG_KEYS.PRELUDE_DEFAULT, ''),
    pageTitle: getConfig(CONFIG_KEYS.DEFAULT_PAGE_TITLE, '崇拜程序'),
    attendanceHeading: getConfig(CONFIG_KEYS.DEFAULT_ATTENDANCE_HEADING, '上週主日崇拜人數'),
    nextWeekHeading: getConfig(CONFIG_KEYS.DEFAULT_NEXT_WEEK_HEADING, '下週主日崇拜聚會事奉肢體'),
    prayerBlockHeading: getConfig(CONFIG_KEYS.DEFAULT_PRAYER_BLOCK_HEADING, '代禱事項')
  };

  var newRows = [];
  var addedDates = [];
  var skipped = 0;

  dates.forEach(function (isoDate) {
    if (findBulletinWeekRow_(existingRows, isoDate)) {
      skipped++;
      return;
    }

    // ⚠️ 職事表讀不到的時候 readRosterSnapshot_() 回一個空快照（不拋錯），
    //    所以下面那幾格自然會是空的——正是我們想要的「留空」。
    var snapshot = readRosterSnapshot_(isoDate);
    var special = snapshot.special;
    var resolved = resolveProgramTemplateId_({}, snapshot, templateConfig);
    var targetDate = normalizeDate_(isoDate);
    var rowRosterStatus = (snapshot && snapshot.found === true)
      ? ROSTER_STATUS.OK
      : rosterStatusForDate_(isoDate, resolution);

    newRows.push({
      SERVICE_DATE: targetDate,
      // ⚠️ **一定要用呼叫方指定的季度，不可以用 `snapshot.quarterId`。**
      //    快照那個值是職事表自己講這個日期屬於哪一季；兩者不一致時，
      //    用快照那個＝把一行寫進另一個季度，而畫面上完全看不出來。
      //    「決定處理哪一季」是呼叫方的事，職事表只負責答「這一天有沒有
      //    資料」。見 docs/已知bug類型.md 事故四十一。
      QUARTER_ID: quarterId,
      WEEK_OF_MONTH: snapshot.weekOfMonth,
      SPECIAL_TYPE: special ? special.title : '',
      PAGE_TITLE: defaults.pageTitle,
      PROGRAM_TEMPLATE_ID: resolved.templateId,
      PRELUDE: defaults.prelude,
      ATTENDANCE_HEADING: defaults.attendanceHeading,
      ATTENDANCE_DATE: addDays_(targetDate, -7),
      NEXT_WEEK_HEADING: defaults.nextWeekHeading,
      PRAYER_BLOCK_HEADING: defaults.prayerBlockHeading,
      STATUS: BULLETIN_WEEK_STATUS.DRAFT,
      ROSTER_STATUS: rowRosterStatus
    });
    addedDates.push(isoDate);
  });

  if (newRows.length > 0) {
    writeSheet(SHEETS.BULLETIN_WEEKS, newRows);
    addedDates.forEach(function (isoDate, idx) {
      appendAuditLog_({
        action: 'CREATE_BLANK_BULLETIN_WEEK',
        sheetName: SHEETS.BULLETIN_WEEKS,
        rowKey: isoDate,
        newValue: newRows[idx].PROGRAM_TEMPLATE_ID,
        notes: '季度 ' + quarterId + ' 的空白週報骨架，特別主日：' + (newRows[idx].SPECIAL_TYPE || '（無）')
      });
    });
  }

  // ⚠️ 要數的是「這一季現在在表上的全部行」，不是「這一次新增的那幾行」。
  //    只數新增的話，全部主日都已經存在時 newRows 是空陣列，狀態分佈
  //    會全部是 0——看起來像「一切正常」，其實是「什麼都沒有數過」。
  var quarterRows = readSheet(SHEETS.BULLETIN_WEEKS).filter(function (r) {
    return String(r.QUARTER_ID || '').trim() === String(quarterId || '').trim();
  });
  var statusCounts = countRosterStatuses_(quarterRows);

  // R-035：順手整理舊季度。包一層 try/catch——整理失敗不應該令
  //    「建立本季週報」整個失敗，那是兩件獨立的事。
  // ⚠️ 刻意不 force：有未發佈而且有內容的季度就略過，等人手確認。
  var retention = null;
  try {
    retention = runQuarterRetention_({});
  } catch (retentionErr) {
    retention = {
      archived: [], skipped: [], visible: [],
      message: '整理舊季度時出錯（不影響剛才建立的週報）：'
        + ((retentionErr && retentionErr.message) ? retentionErr.message : String(retentionErr))
    };
  }

  return {
    totalDates: dates.length,
    quarterRowCount: quarterRows.length,
    added: newRows.length,
    skipped: skipped,
    addedDates: addedDates,
    dateSource: resolution.source,
    rosterFound: resolution.source === 'ROSTER',
    rosterStatusCounts: statusCounts,
    retention: retention,
    message: buildCreateWeeksMessage_({
      quarterId: quarterId, added: newRows.length, skipped: skipped,
      rosterFound: resolution.source === 'ROSTER', statusCounts: statusCounts
    })
  };
}

/**
 * 用途：「建立本季空白週報」完成之後給人看的一段話。**純函式。**
 *
 *   ⚠️ 職事表未有資料的時候一定要**明確講出來**：建立成功了，但事奉欄位
 *   全部留空。不講的話，幹事會以為那幾格是系統漏了填。
 * Args:
 *   input {{quarterId:string, added:number, skipped:number,
 *           rosterFound:boolean, statusCounts:Object}}
 * Returns:
 *   {string}
 */
function buildCreateWeeksMessage_(input) {
  var lines = [];
  var skipped = input.skipped || 0;
  if (!input.rosterFound) {
    // ⚠️ 一定要同時講「新增幾多」與「略過幾多」。舊版只講 `added`，
    //    於是全部主日都已經存在時印出「已建立 0 個主日」——工作表上
    //    明明有 13 行，訊息卻好像什麼都沒有做過。**「0」與「本來就有」
    //    是兩件事，不可以用同一句話講。**
    if (input.added === 0 && skipped > 0) {
      lines.push('本季 ' + skipped + ' 個主日本來就已經建立好，這一次沒有新增任何一行。');
    } else {
      lines.push('本季職事表未有資料，已建立 ' + input.added + ' 個主日'
        + (skipped > 0 ? ('（另有 ' + skipped + ' 個本來就已經存在）') : '')
        + '，事奉欄位全部留空。');
    }
    lines.push('本季職事表未有資料，主日清單由曆法推算（該季全部星期日）。');
    lines.push('職事表建立好之後，撳「補抓空白的事奉欄位」就會把空格補回去。');
    lines.push('目前職事表狀態：' + describeRosterStatusCounts_(input.statusCounts));
  } else {
    lines.push('季度 ' + input.quarterId + '：新增 ' + input.added + ' 行，略過 '
      + input.skipped + ' 行（已經存在）。');
    var gaps = (input.statusCounts.PARTIAL || 0) + (input.statusCounts.NOT_FOUND || 0);
    if (gaps > 0) {
      lines.push('⚠️ 其中 ' + gaps + ' 個主日在職事表找不到資料，那幾期的事奉欄位留空。');
      lines.push('職事表補齊之後，撳「補抓空白的事奉欄位」。');
    }
  }
  return lines.join('\n');
}

/**
 * 用途：選單項目「預覽本週週報資料」的處理函式。問一個主日日期，叫
 *   buildBulletinModel_()，用對話框顯示摘要，完整模型寫入 `Diagnostics`。
 * Args: （無）
 * Returns:
 *   {void}
 */
function menuPreviewBulletinModel_() {
  var ui = SpreadsheetApp.getUi();
  try {
    var defaultDate = getConfig(CONFIG_KEYS.ROSTER_TEST_DATE, '2027-10-03');
    var resp = ui.prompt(
      '預覽本週週報資料',
      '請輸入主日日期，格式 yyyy-MM-dd（例如 ' + defaultDate + '）：',
      ui.ButtonSet.OK_CANCEL
    );
    if (resp.getSelectedButton() !== ui.Button.OK) return;

    var isoDate = resp.getResponseText().trim() || defaultDate;
    var model = buildBulletinModel_(isoDate);

    if (model.notConfigured) {
      ui.alert('尚未設定職事表位置', '請先在 Config 工作表填入 ROSTER_SPREADSHEET_ID，再重試一次。', ui.ButtonSet.OK);
      return;
    }

    ui.alert(
      '週報資料模型預覽',
      [
        '日期：' + model.isoDate,
        '找到職事表資料：' + (model.found ? '是' : '否'),
        '程序範本：' + (model.templateId || '（無）'),
        '程序表行數：' + model.program.length,
        '事奉框行數：' + model.dutyBoxPage1.length,
        '下週事奉行數：' + model.nextWeekDuty.length,
        '待填項目數：' + model.missing.length,
        '警告數：' + model.warnings.length,
        '',
        '完整內容見 Diagnostics 工作表。'
      ].join('\n'),
      ui.ButtonSet.OK
    );

    writeDiagnosticsReport_('週報資料模型預覽', buildBulletinModelReportLines_(model));
  } catch (err) {
    logMenuError_('menuPreviewBulletinModel_', err);
    ui.alert('預覽本週週報資料失敗', enrichAuthError_(err), ui.ButtonSet.OK);
  }
}

/**
 * 用途：把週報資料模型排版成 `Diagnostics` 報告的內容行，分成六個區段：
 *   基本資料、事奉框、程序表、下週事奉、待填清單、警告，每個區段之前
 *   有一行分隔標題。
 *
 *   ⚠️ 區段標題一律用全形括號「【…】」，**不可以用 `===` 這類以 `=` 開頭
 *   的寫法**——`writeDiagnosticsReport_()` 用 `setValues()` 整批寫入，
 *   Sheets 會把 `=` 開頭的字串當成公式求值（見 docs/已知bug類型.md
 *   事故六）。就算標題本身沒問題，`writeDiagnosticsReport_()` 內部也一律
 *   會呼叫 `sanitizeCellText_()` 再保險一次，但這裡仍然要用不會觸發的
 *   寫法，不要依賴下游的保護。
 *
 *   ⚠️ 這裡**不做截斷**——截斷交給 writeDiagnosticsReport_() 統一處理，
 *   它會依 Config 的 `DIAGNOSTICS_MAX_ROWS`（380）截斷並在最後一行寫明
 *   本報告共幾行、只顯示了前幾行。一份報告只在一個地方截斷，才不會出現
 *   「兩層各截一次、數字對不上」的情況。
 * Args:
 *   model {Object} buildBulletinModel_() 的回傳值。
 * Returns:
 *   {string[]}
 */
function buildBulletinModelReportLines_(model) {
  var lines = [];

  lines.push('【基本資料】');
  lines.push('日期：' + model.isoDate + '　當月第 ' + model.weekOfMonth + ' 個主日');
  lines.push('季度：' + (model.quarterId || '（無）')
    + '　職事表版本：' + (model.rosterVersionUsed === null ? '（尚未生成）' : model.rosterVersionUsed)
    + '　已正式發出：' + (model.rosterIsOfficial ? '是' : '否'));
  lines.push('特別主日：' + (model.special ? (model.special.type + '／' + model.special.title) : '（無）'));
  if (model.special) {
    lines.push('　跳過崗位：' + (model.special.skipPostIds.join('、') || '（無）')
      + '　外判單位：' + (model.special.externalOwner || '（無）'));
  }
  lines.push('程序範本：' + (model.templateId || '（無）'));
  lines.push('大標題：' + model.header.pageTitle + '　封面日期：' + model.header.coverDate);
  lines.push('人數表標題：' + model.header.attendanceHeading + '（' + model.header.attendanceDate + '）');
  lines.push('下週事奉標題：' + model.header.nextWeekHeading + '（' + model.header.nextWeekDate + '）');
  lines.push('本週獻花：' + (model.flowers.thisWeek || '（未填）')
    + '　下週獻花：' + (model.flowers.nextWeek || '（未填）'));

  lines.push('');
  lines.push('【事奉框（第 1 頁，' + model.dutyBoxPage1.length + ' 行）】');
  model.dutyBoxPage1.forEach(function (row) {
    lines.push('　' + row.label + '：' + (row.text || '（待填）') + '　[' + row.states.join(',') + ']');
  });

  lines.push('');
  lines.push('【程序表（' + model.program.length + ' 行）】');
  model.program.forEach(function (row) {
    lines.push('　' + row.seqNo + '　' + row.itemName
      + (row.posture ? '　' + row.posture : '')
      + (row.fullWidth ? '　[整行]' : '')
      + '　' + (row.content || ''));
  });

  lines.push('');
  lines.push('【下週事奉（第 3 頁，' + model.nextWeekDuty.length + ' 行）】');
  model.nextWeekDuty.forEach(function (row) {
    lines.push('　' + row.label + '：' + (row.text || '（待填）'));
  });

  lines.push('');
  lines.push('【人數表】');
  lines.push('　　　　' + model.attendance.columns.join('　'));
  model.attendance.rows.forEach(function (row) {
    lines.push('　' + row.label + '　' + row.values.map(function (v) { return v || '—'; }).join('　'));
  });

  lines.push('');
  lines.push('【家事報告（' + model.announcements.length + ' 項）／代禱（'
    + model.prayerBlock.items.length + ' 項）／團契（' + model.fellowships.length + ' 項）／財政（'
    + model.finance.length + ' 項）】');
  model.announcements.forEach(function (a) { lines.push('　報告 ' + a.seqNo + '：' + a.text); });
  model.prayerBlock.items.forEach(function (p) { lines.push('　' + model.prayerBlock.heading + ' ' + p.seqNo + '：' + p.text); });
  model.fellowships.forEach(function (f) {
    lines.push('　團契：' + f.fellowshipName + '　' + f.meetingDate + ' ' + f.meetingTime + '　' + f.content);
  });
  model.finance.forEach(function (f) {
    lines.push('　財政：' + f.rowLabel + '　特殊海外奉獻=' + f.specialOverseas + '　慈惠=' + f.hardship);
  });

  lines.push('');
  lines.push('【待填清單（' + model.missing.length + ' 項）】');
  model.missing.forEach(function (m) {
    lines.push('　' + m.label + '（' + m.field + '）：' + m.reason);
  });

  lines.push('');
  lines.push('【警告（' + model.warnings.length + ' 項）】');
  model.warnings.forEach(function (w) {
    lines.push('　[' + w.code + '] ' + w.message);
  });

  return lines;
}
