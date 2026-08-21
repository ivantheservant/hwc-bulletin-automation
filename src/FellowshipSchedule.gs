/**
 * FellowshipSchedule.gs
 *
 * 由「常設時間表」（`FellowshipDefaults`）自動產生整季的本週團契聚會
 * （`Fellowships`）。幹事只需要改例外。
 *
 * ⚠️ `RECURRENCE`（出現規則）與 `ProgramTemplates.CONDITION` **共用同一個
 * 求值器** `evaluateProgramCondition_()`（`src/ProgramTable.gs`），不是
 * 另外寫一套——「第 2、4 個主日」這種規則在兩處的意思必須完全一樣，
 * 各寫一套遲早會分岔。
 *
 * ⚠️ **冪等**：已經存在的行**完全不動**，只補缺的。幹事很可能已經人手
 * 改過某一週的內容（例如那一週改成郊遊），再跑一次不可以蓋掉它。
 */

'use strict';

/**
 * 用途：把主日日期加上偏移天數，算出團契實際的聚會日期。純函式。
 * Args:
 *   isoDate {string} 主日日期，yyyy-MM-dd。
 *   dayOffset {*} 相對主日的天數（主日 ＝ 0、之後的星期五 ＝ 5）。
 * Returns:
 *   {?Date} `isoDate` 格式不對時回 `null`。
 */
function fellowshipMeetingDate_(isoDate, dayOffset) {
  var base = null;
  try {
    base = normalizeDate_(isoDate);
  } catch (err) {
    return null;
  }
  if (!base) return null;

  var offset = Number(dayOffset);
  if (!Number.isFinite(offset)) offset = 0;
  return addDays_(base, offset);
}

/**
 * 用途：把聚會日期格式化成 `Fellowships.MEETING_DATE` 要存的文字。
 *
 *   格式是 Config `FELLOWSHIP_DATE_PATTERN`（預設 `d/M`）＋一個半形空格
 *   ＋`DAY_LABEL`，例如 `10/5 星期日`。
 *
 *   ⚠️ 日期部分**刻意不用 `Utilities.formatDate()`**，改用自己算——
 *   這樣整個函式就是純函式，可以在 Node 直接測試，不需要任何 GAS stub。
 *   只支援 `d`／`dd`／`M`／`MM`／`yyyy` 五個樣式（足夠 `d/M` 這類用途），
 *   認不出的樣式字元原樣保留。
 * Args:
 *   date {Date} 聚會日期。
 *   dayLabel {string} 星期文字，例如 `星期日`。
 *   pattern {string} 日期格式，例如 `d/M`。
 * Returns:
 *   {string} `date` 是 `null` 時只回 `dayLabel`。
 */
function formatFellowshipMeetingDate_(date, dayLabel, pattern) {
  var label = String(dayLabel || '').trim();
  if (!date) return label;

  var p = String(pattern || 'd/M');
  var d = date.getDate();
  var m = date.getMonth() + 1;
  var y = date.getFullYear();

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  // ⚠️ 由長到短替換（yyyy → dd → MM → d → M），否則 `dd` 會先被 `d`
  // 吃掉一半。用一次 replace 加 callback 完成，避免替換出來的數字再被
  // 當成樣式字元（例如 5 月 5 日的 `d/M` → `5/5`，再掃一次不會出事，
  // 但 12 月的 `MM` → `12` 內含的字元就有機會）。
  var text = p.replace(/yyyy|dd|MM|d|M/g, function (token) {
    if (token === 'yyyy') return String(y);
    if (token === 'dd') return pad2(d);
    if (token === 'MM') return pad2(m);
    if (token === 'd') return String(d);
    return String(m);
  });

  return label ? (text + ' ' + label) : text;
}

/**
 * 用途：算出「由常設時間表產生本季團契」要新增哪些行。純函式。
 *
 *   逐個主日 × 逐個常設團契：
 *     - 團契 `ACTIVE` 不是 TRUE → 略過
 *     - `RECURRENCE` 求值為 false → 那一週不出現
 *     - `Fellowships` 已經有「同一個主日 ＋ 同一個團契名稱」的行 →
 *       **完全不動**（冪等），計入 `skipped`
 *     - 否則產生一行
 * Args:
 *   input {{serviceDates:{isoDate:string, weekOfMonth:number}[],
 *          defaultRows:Object[], existingRows:Object[], datePattern:string}}
 * Returns:
 *   {{appends:Object[], addedCount:number, skippedCount:number,
 *     warnings:{code:string,message:string}[]}}
 *     `appends` 的元素是 `Fellowships` 的資料列（含 `SERVICE_DATE`）。
 */
function buildFellowshipGenerationPlan_(input) {
  var defaults = (input.defaultRows || [])
    .filter(function (r) { return r.ACTIVE === true; })
    .slice()
    .sort(function (a, b) { return (Number(a.SORT_ORDER) || 0) - (Number(b.SORT_ORDER) || 0); });

  var existingKeys = {};
  (input.existingRows || []).forEach(function (row) {
    var iso = fillGridCellText_(row.SERVICE_DATE);
    existingKeys[iso + '|' + String(row.FELLOWSHIP_NAME || '').trim()] = true;
  });

  var appends = [];
  var warnings = [];
  var skipped = 0;

  (input.serviceDates || []).forEach(function (sd) {
    var seqNo = 10;

    defaults.forEach(function (def) {
      var appears;
      try {
        appears = evaluateProgramCondition_(def.RECURRENCE, {
          week: {},
          weekOfMonth: sd.weekOfMonth,
          row: { TEMPLATE_ID: SHEETS.FELLOWSHIP_DEFAULTS, SEQ_NO: def.SORT_ORDER }
        });
      } catch (err) {
        // 認不出的規則：略過那個團契並記 warning，不拋錯——一個團契的
        // 規則打錯字，不應該令整季都產生不到。
        warnings.push({
          code: 'BAD_RECURRENCE',
          message: '團契「' + String(def.FELLOWSHIP_NAME || '') + '」的出現規則「'
            + String(def.RECURRENCE || '') + '」無法辨識，已略過這個團契：'
            + (err && err.message ? err.message : String(err))
        });
        appears = false;
      }
      if (!appears) return;

      var name = String(def.FELLOWSHIP_NAME || '').trim();
      if (existingKeys[sd.isoDate + '|' + name]) { skipped++; return; }

      var meetingDate = fellowshipMeetingDate_(sd.isoDate, def.DAY_OFFSET);
      appends.push({
        SERVICE_DATE: sd.isoDate,
        SEQ_NO: seqNo,
        FELLOWSHIP_NAME: name,
        MEETING_DATE: formatFellowshipMeetingDate_(meetingDate, def.DAY_LABEL, input.datePattern),
        MEETING_TIME: String(def.TIME_TEXT || ''),
        CONTENT: String(def.DEFAULT_CONTENT || ''),
        ACTIVE: true
      });
      seqNo += 10;
    });
  });

  // 同一個 warning（同一個團契的規則打錯字）會在每一個主日各產生一次，
  // 去重之後才有得看。
  var seenWarnings = {};
  var uniqueWarnings = warnings.filter(function (w) {
    if (seenWarnings[w.message]) return false;
    seenWarnings[w.message] = true;
    return true;
  });

  return { appends: appends, addedCount: appends.length, skippedCount: skipped, warnings: uniqueWarnings };
}

/**
 * 用途：由常設時間表產生指定季度的團契聚會。真正入口。
 *
 *   ⚠️ **產生之前會先自動備份**（原因 `BEFORE_GENERATE_FELLOWSHIPS`）。
 * Args:
 *   quarterId {string} 季度 ID。
 * Returns:
 *   {{added:number, skipped:number, warnings:Object[], backupId:string}}
 * Raises:
 *   Error 如果職事表讀取失敗，或 `Fellowships`／`FellowshipDefaults`
 *     工作表不存在。
 */
function generateQuarterFellowships_(quarterId) {
  var backup = createFillBackup_(quarterId, FILL_BACKUP_REASON.BEFORE_GENERATE_FELLOWSHIPS);

  var plan = buildFellowshipGenerationPlan_({
    serviceDates: listQuarterServiceDates_(quarterId),
    defaultRows: readSheet(SHEETS.FELLOWSHIP_DEFAULTS),
    existingRows: readSheet(SHEETS.FELLOWSHIPS),
    datePattern: getConfig(CONFIG_KEYS.FELLOWSHIP_DATE_PATTERN, 'd/M')
  });

  if (plan.appends.length > 0) {
    writeSheet(SHEETS.FELLOWSHIPS, plan.appends.map(function (row) {
      return Object.assign({}, row, {
        SERVICE_DATE: normalizeDate_(row.SERVICE_DATE),
        FELLOWSHIP_NAME: sanitizeCellText_(row.FELLOWSHIP_NAME),
        MEETING_DATE: sanitizeCellText_(row.MEETING_DATE),
        MEETING_TIME: sanitizeCellText_(row.MEETING_TIME),
        CONTENT: sanitizeCellText_(row.CONTENT)
      });
    }));

    plan.appends.forEach(function (row) {
      appendAuditLog_({
        action: 'FELLOWSHIP_GENERATE', sheetName: SHEETS.FELLOWSHIPS,
        rowKey: row.SERVICE_DATE, field: 'FELLOWSHIP_NAME',
        oldValue: '', newValue: row.FELLOWSHIP_NAME,
        notes: '由常設時間表 ' + SHEETS.FELLOWSHIP_DEFAULTS + ' 自動產生。'
      });
    });
  }

  return {
    added: plan.addedCount,
    skipped: plan.skippedCount,
    warnings: plan.warnings,
    backupId: backup.backupId
  };
}

// =====================================================================
// 整理清單次序
// =====================================================================

/**
 * 用途：算出四張清單表其中一張，指定季度的行**重新編號**之後應該是什麼。
 *   純函式。
 *
 *   排序依 `SERVICE_DATE`、然後 `SEQ_NO`，重新編成 10、20、30……
 *
 *   ⚠️ **不刪行**：`ACTIVE=FALSE` 的行照樣保留、照樣重新編號，只是排在
 *   同一個主日的最後（停用的行仍然是歷史記錄）。
 * Args:
 *   rows {Object[]} 該表的全部資料列（帶 `__rowNo`）。
 *   isoDateSet {Object<string,boolean>} 該季全部主日。
 * Returns:
 *   {{rowNo:number, isoDate:string, oldSeq:*, newSeq:number}[]}
 *     只回**真的要改**的行。
 */
function buildResequencePlan_(rows, isoDateSet) {
  var inQuarter = (rows || []).filter(function (r) { return rowBelongsToQuarter_(r, isoDateSet); });

  inQuarter.sort(function (a, b) {
    var da = fillGridCellText_(a.SERVICE_DATE);
    var db = fillGridCellText_(b.SERVICE_DATE);
    if (da !== db) return da < db ? -1 : 1;
    // 停用的排在同一個主日的最後
    var aActive = a.ACTIVE === true ? 0 : 1;
    var bActive = b.ACTIVE === true ? 0 : 1;
    if (aActive !== bActive) return aActive - bActive;
    return (Number(a.SEQ_NO) || 0) - (Number(b.SEQ_NO) || 0);
  });

  var seqByDate = {};
  var changes = [];

  inQuarter.forEach(function (row) {
    var iso = fillGridCellText_(row.SERVICE_DATE);
    seqByDate[iso] = (seqByDate[iso] || 0) + 10;
    var newSeq = seqByDate[iso];
    if (Number(row.SEQ_NO) === newSeq) return;
    changes.push({ rowNo: row.__rowNo, isoDate: iso, oldSeq: row.SEQ_NO, newSeq: newSeq });
  });

  return changes;
}

/**
 * 用途：整理四張清單表指定季度的次序，把 `SEQ_NO` 重新編成 10、20、30……
 *   真正入口。
 *
 *   ⚠️ **不刪行**，只改 `SEQ_NO`。
 *   ⚠️ **整理之前會先自動備份**（原因 `BEFORE_RESEQUENCE`）。
 * Args:
 *   quarterId {string} 季度 ID。
 * Returns:
 *   {{changedBySheet:Object<string,number>, totalChanged:number, backupId:string}}
 */
function resequenceQuarterLists_(quarterId) {
  var backup = createFillBackup_(quarterId, FILL_BACKUP_REASON.BEFORE_RESEQUENCE);

  var isoDateSet = {};
  Object.keys(readBulletinWeekRowsByIso_(quarterId)).forEach(function (iso) { isoDateSet[iso] = true; });

  var sheetNames = [SHEETS.ANNOUNCEMENTS, SHEETS.PRAYERS, SHEETS.FELLOWSHIPS, SHEETS.FINANCE];
  var changedBySheet = {};
  var total = 0;

  sheetNames.forEach(function (sheetName) {
    var sheetId = SHEET_ID_BY_NAME[sheetName];
    var seqCol = COLUMNS[sheetId].keys.indexOf('SEQ_NO') + 1;
    if (seqCol <= 0) { changedBySheet[sheetName] = 0; return; }

    var changes = buildResequencePlan_(readRowsWithRowNo_(sheetName), isoDateSet);
    changedBySheet[sheetName] = changes.length;
    total += changes.length;
    if (changes.length === 0) return;

    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
    if (!sheet) return;

    changes.forEach(function (c) {
      sheet.getRange(c.rowNo, seqCol).setValue(c.newSeq);
      appendAuditLog_({
        action: 'LIST_RESEQUENCE', sheetName: sheetName,
        rowKey: c.isoDate, field: 'SEQ_NO',
        oldValue: String(c.oldSeq === null || c.oldSeq === undefined ? '' : c.oldSeq),
        newValue: String(c.newSeq),
        notes: '整理清單次序（季度 ' + quarterId + '）。不刪行，只重新編號。'
      });
    });
  });

  return { changedBySheet: changedBySheet, totalChanged: total, backupId: backup.backupId };
}
