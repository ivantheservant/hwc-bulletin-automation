/**
 * ContentSheetMigrateV3.gs
 *
 * 內容表 v3（2026-10-26 Ivan 測試結果 A）：「崇拜程序」九欄只可以在內容表填、浸禮副框六欄只可以在
 * 填寫介面填。這個檔案負責把舊內容表（v2、v1）更新成 v3 之前要先做的三件事：
 *
 *   1. 浸禮六欄搬入週報（BulletinWeeks）：v2 由「崇拜程序」第 L 至 Q 欄、v1 由未改名的「浸禮合堂」
 *      分頁。每一格的值：介面有生效中的覆寫就用覆寫值（那是印出來的值），否則用內容表的值；
 *      內容表空白就**保留週報現值**（不清空任何東西）。
 *   2. v2 才做：刪走「崇拜程序」第 L 至 Q 欄（浸禮六欄）。刪走之後頭十一欄就是 v3 的頭十一欄，
 *      第 12 欄「詩班項目名稱」由 `planContentSheetV2Migration_()`（已改用 v3 定義）照新欄的做法
 *      加上，並由週報現值回填。
 *   3. 停用舊的欄位覆寫（`FieldOverride`）：九欄與浸禮六欄都不再是「內容表為來源、介面可覆寫」。
 *      九欄的覆寫：內容表那一格空白就把覆寫值寫入內容表（印出來的值不變）；內容表已經有不同的值就
 *      保留內容表的值，逐格列入報告（之後匯入會改用內容表的值）。浸禮六欄的覆寫值已經在第 1 步寫入
 *      週報。一律只停用（有效＝FALSE），不刪行。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 次序（中途失敗可以重跑）
 * ─────────────────────────────────────────────────────────────────────
 *
 *   先寫週報（第 1 步，用生效中的覆寫算值），再刪欄（第 2 步），最後才停用覆寫（第 3 步）。
 *   第 1 步之後失敗：重跑時覆寫仍然生效、v2 欄仍然在，算出來的值完全一樣。第 2 步之後失敗：重跑時
 *   已經不是 v2（沒有浸禮來源），第 1 步只會用覆寫值，結果仍然一樣；第 3 步照做。
 *   「崇拜程序」第 2 行（提交點）由 `buildOrRefreshContentSheet_()` 最後才寫。
 *
 *   預覽與執行用同一個 planner（`planContentSheetV3Upgrade_()`，bug class 120）。
 *
 * 分層：本檔案是業務邏輯；格子讀寫經 `src/ContentSheetIo.gs`，週報那一邊經 `src/WebAppSave.gs` 的
 * 寫入函式（逐格 AuditLog）。
 */

'use strict';

/**
 * 用途：v3「崇拜程序」只可以在內容表填的九欄（扣除主日日期、有效、備註）。由分頁定義衍生，不另抄。
 * Args: （無）
 * Returns:
 *   {string[]}
 * Raises:
 *   （無）
 */
function contentSheetWorshipValueKeys_() {
  return contentSheetWorshipTabDef_().keys.filter(function (k) {
    return k !== 'SERVICE_DATE' && k !== 'ACTIVE' && k !== 'NOTES';
  });
}

/**
 * 用途：v3 比 v2 頭十一欄多出來的那幾欄（現時只有「詩班項目名稱」），在 v2 分頁上讀取時用的臨時鍵。
 *   v2 刪走第 L 至 Q 欄之後，v2 第 17 欄之後的第 k 欄就變成 v3 的第 12 + k 欄。純函式。
 * Args:
 *   v3Keys {string[]} v3 機器鍵。
 * Returns:
 *   {string[]} 例如 `['__V3_TAIL_0']`。
 * Raises:
 *   （無）
 */
function v3TailKeysAfterV2_(v3Keys) {
  var shared = v3SharedPrefixWithV2_(v3Keys);
  var out = [];
  for (var i = shared; i < v3Keys.length; i++) out.push('__V3_TAIL_' + (i - shared));
  return out;
}

/**
 * 用途：v3 與 v2 頭幾欄相同（現時是十一欄）。純函式。
 * Args:
 *   v3Keys {string[]}
 * Returns:
 *   {number}
 * Raises:
 *   （無）
 */
function v3SharedPrefixWithV2_(v3Keys) {
  var v2Keys = contentSheetWorshipKeysV2_();
  var i = 0;
  while (i < v3Keys.length && i < v2Keys.length && v2Keys[i] === v3Keys[i]) i++;
  return i;
}

/**
 * 用途：v2 內容表「刪走浸禮六欄之後」第 2 行會是甚麼樣子：v3 頭十一欄，之後是 v2 第 17 欄之後原本的格
 *   （正常是空白）。純函式。
 * Args:
 *   v3Keys {string[]} v3「崇拜程序」的機器鍵。
 *   tailHeader {string[]=} v2 第 2 行第 18 欄起的格；省略當作空白。
 * Returns:
 *   {string[]} 長度與 `v3Keys` 相同。
 * Raises:
 *   （無）
 */
function simulateWorshipHeaderAfterV3Drop_(v3Keys, tailHeader) {
  var shared = v3SharedPrefixWithV2_(v3Keys);
  var tail = tailHeader || [];
  return v3Keys.map(function (k, i) {
    if (i < shared) return k;
    var v = tail[i - shared];
    return v === null || v === undefined ? '' : String(v).trim();
  });
}

/**
 * 用途：v2 內容表的資料行「刪走浸禮六欄之後」按 v3 讀出來會是甚麼樣子。純函式。
 *   v3 的新欄（詩班項目名稱）取 v2 第 17 欄之後那一格（臨時鍵 `__V3_TAIL_n`，見 `v3TailKeysAfterV2_()`），
 *   與真正刪欄之後讀到的一樣。
 * Args:
 *   v2Rows {Object[]} 按 v2 機器鍵（加臨時鍵）解析的資料行（`parseContentTabRows_()` 的輸出）。
 *   v3Keys {string[]} v3 機器鍵。
 * Returns:
 *   {Object[]} 形狀同 `parseContentTabRows_()` 的輸出（帶 `__rowNo`、`__active`、`__typeIssues`）。
 * Raises:
 *   （無）
 */
function simulateWorshipRowsAfterV3Drop_(v2Rows, v3Keys) {
  var shared = v3SharedPrefixWithV2_(v3Keys);
  var sourceKeyOf = function (k, i) { return i < shared ? k : '__V3_TAIL_' + (i - shared); };
  return (v2Rows || []).map(function (row) {
    var out = {};
    v3Keys.forEach(function (k, i) {
      var v = row[sourceKeyOf(k, i)];
      out[k] = v === undefined ? '' : v;
    });
    Object.keys(row).forEach(function (k) {
      if (k.indexOf('__') !== 0 || k.indexOf('__V3_TAIL_') === 0) return;
      out[k] = row[k];
    });
    var issues = row.__typeIssues || [];
    out.__typeIssues = v3Keys.filter(function (k, i) { return issues.indexOf(sourceKeyOf(k, i)) !== -1; });
    return out;
  });
}

/**
 * 用途：v3 更新計畫（第 1 至 3 步，見檔頭）。純函式；預覽與執行共用。
 * Args:
 *   input {{serviceDates:string[], worship:Object, legacy:Object[], weeks:Object[], fieldOverrides:Object[]}}
 *     後四樣見 `readContentSheetV2Inputs_()`（`weeks` 帶 `__rowNo`；`fieldOverrides` 只含生效中的行並帶
 *     `__rowNo`）。新建的內容表傳 `worship:{exists:false,...}`、`legacy:[]`。
 * Returns:
 *   {{isV2:boolean, deleteBaptismColumns:boolean,
 *     baptismWrites:{isoDate:string, rowNo:number, field:string, oldValue:string, newValue:string, source:string}[],
 *     baptismNoWeekRow:{isoDate:string, field:string, value:string}[],
 *     overrideCellWrites:{isoDate:string, rowNo:number, key:string, col:number, value:string}[],
 *     overrideConflicts:{isoDate:string, key:string, overrideValue:string, contentValue:string}[],
 *     overrideDeactivations:{row:Object, isoDate:string, field:string, overrideValue:string, kind:string}[],
 *     counts:{baptismCells:number, baptismDates:number, overrideCellWrites:number, overrideConflicts:number,
 *       overrideDeactivations:number}}}
 *     `source`：`'OVERRIDE'`（介面覆寫值）／`'CONTENT'`（內容表的值）。`kind`：`'WORSHIP'`／`'BAPTISM'`。
 * Raises:
 *   （無）
 */
function planContentSheetV3Upgrade_(input) {
  var o = input || {};
  var worship = o.worship || { exists: false, layout: '', headerKeys: [], rows: [], v2Rows: [] };
  var isV2 = worship.layout === 'V2';
  var baptismKeys = baptismBoxFieldKeys_();
  var worshipValueKeys = contentSheetWorshipValueKeys_();
  var v3Keys = contentSheetWorshipTabDef_().keys;
  var plan = {
    isV2: isV2, deleteBaptismColumns: isV2,
    baptismWrites: [], baptismNoWeekRow: [], overrideCellWrites: [], overrideConflicts: [], overrideDeactivations: [],
    counts: { baptismCells: 0, baptismDates: 0, overrideCellWrites: 0, overrideConflicts: 0, overrideDeactivations: 0 }
  };

  var inQuarter = {};
  (o.serviceDates || []).forEach(function (d) { inQuarter[d] = true; });

  // ---- 浸禮六欄的內容表來源：v2 讀「崇拜程序」；v1 讀未改名的「浸禮合堂」（已改名的舊資料已經過時，不讀）----
  var sourceByDate = {};
  function takeSource(rows) {
    var last = lastActiveRowByDate_(rows || []);
    Object.keys(last).forEach(function (iso) {
      if (!inQuarter[iso]) return;
      var row = last[iso];
      baptismKeys.forEach(function (key) {
        if ((row.__typeIssues || []).indexOf(key) !== -1) return;
        var v = migrationText_(row[key]);
        if (v === '') return;
        if (!sourceByDate[iso]) sourceByDate[iso] = {};
        sourceByDate[iso][key] = v;
      });
    });
  }
  if (isV2) {
    takeSource(worship.v2Rows);
  } else {
    (o.legacy || []).forEach(function (entry) {
      if (entry.kind === 'BAPTISM' && !entry.renamed) takeSource(entry.rows);
    });
  }

  // ---- 這一季生效中的覆寫（九欄與浸禮六欄）----
  var overrideByKey = {};
  var overrides = [];
  (o.fieldOverrides || []).forEach(function (r) {
    if (r.ACTIVE !== true) return;
    var iso = fieldOverrideIsoOf_(r.SERVICE_DATE);
    var field = String(r.FIELD_KEY || '').trim();
    if (!iso || !inQuarter[iso]) return;
    if (worshipValueKeys.indexOf(field) === -1 && baptismKeys.indexOf(field) === -1) return;
    overrides.push({ row: r, isoDate: iso, field: field });
    var k = iso + '#' + field;
    // 同一格有兩行生效中（理論上不會）：以行號較後的為準，兩行都會停用。
    if (!overrideByKey[k] || Number(r.__rowNo || 0) > Number(overrideByKey[k].__rowNo || 0)) overrideByKey[k] = r;
  });

  // ---- 第 1 步：浸禮六欄寫入週報 ----
  var weekByIso = {};
  (o.weeks || []).forEach(function (w) {
    var iso = fieldOverrideIsoOf_(w.SERVICE_DATE);
    if (iso) weekByIso[iso] = w;
  });
  var baptismDates = {};
  (o.serviceDates || []).forEach(function (iso) {
    var week = weekByIso[iso] || null;
    baptismKeys.forEach(function (key) {
      var ov = overrideByKey[iso + '#' + key] || null;
      var src = (sourceByDate[iso] || {})[key];
      var effective;
      var source;
      if (ov) { effective = migrationText_(ov.OVERRIDE_VALUE); source = 'OVERRIDE'; }
      else if (src) { effective = src; source = 'CONTENT'; }
      else return;
      var current = migrationText_(week ? week[key] : '');
      if (effective === current) return;
      if (!week) { plan.baptismNoWeekRow.push({ isoDate: iso, field: key, value: effective }); return; }
      plan.baptismWrites.push({ isoDate: iso, rowNo: week.__rowNo, field: key, oldValue: current, newValue: effective, source: source });
      baptismDates[iso] = true;
    });
  });

  // ---- 第 3 步：停用覆寫（九欄：內容表空白就寫入覆寫值；不同就保留內容表）----
  var headerKeys = worship.headerKeys || [];
  var targets = lastActiveRowByDate_(worship.rows || []);
  overrides.forEach(function (entry) {
    var value = migrationText_(entry.row.OVERRIDE_VALUE);
    var isBaptism = baptismKeys.indexOf(entry.field) !== -1;
    plan.overrideDeactivations.push({
      row: entry.row, isoDate: entry.isoDate, field: entry.field, overrideValue: value,
      kind: isBaptism ? 'BAPTISM' : 'WORSHIP'
    });
    if (isBaptism) return;
    // 只有這一格的同一主日只算一次（兩行生效中時，以 overrideByKey 那一行為準）。
    if (overrideByKey[entry.isoDate + '#' + entry.field] !== entry.row) return;
    var col = v3Keys.indexOf(entry.field) + 1;
    var columnExists = col > 0 && headerKeys[col - 1] === entry.field;
    var target = targets[entry.isoDate];
    // 欄未存在（v1 的新欄）或那個主日未有一行：之後由 planContentSheetV2Migration_() 用週報現值填
    // （週報現值就是覆寫值），這裏不用寫。
    if (!columnExists || !target) return;
    var isDate = (target.__typeIssues || []).indexOf(entry.field) !== -1;
    var existing = isDate ? null : migrationText_(target[entry.field]);
    if (existing === '') {
      if (value === '') return;
      plan.overrideCellWrites.push({ isoDate: entry.isoDate, rowNo: target.__rowNo, key: entry.field, col: col, value: value });
      return;
    }
    if (existing === value) return;
    plan.overrideConflicts.push({
      isoDate: entry.isoDate, key: entry.field, overrideValue: value,
      contentValue: isDate ? '（被試算表轉成日期／時間）' : existing
    });
  });

  plan.counts.baptismCells = plan.baptismWrites.length;
  plan.counts.baptismDates = Object.keys(baptismDates).length;
  plan.counts.overrideCellWrites = plan.overrideCellWrites.length;
  plan.counts.overrideConflicts = plan.overrideConflicts.length;
  plan.counts.overrideDeactivations = plan.overrideDeactivations.length;
  return plan;
}

/**
 * 用途：這一份 v3 更新計畫有沒有東西要寫。純函式。
 * Args:
 *   plan {?Object} `planContentSheetV3Upgrade_()` 的輸出。
 * Returns:
 *   {boolean}
 * Raises:
 *   （無）
 */
function contentSheetV3PlanHasWrites_(plan) {
  return Boolean(plan) && (plan.isV2 || plan.baptismWrites.length > 0 || plan.overrideCellWrites.length > 0
    || plan.overrideDeactivations.length > 0);
}

/**
 * 用途：執行 v3 更新計畫（第 1 至 3 步，次序見檔頭）。**不寫「崇拜程序」第 1、2 行**（提交點由呼叫方之後寫）。
 *   第 1 步之前先替受影響的主日存版本（原因 `CONTENT_SHEET_UPGRADE`），寫完更新那幾個主日的最後儲存時間
 *   （較早開着的分頁儲存時會收到「資料在你載入之後被改過」，不會蓋走）。
 * Args:
 *   spreadsheet {Spreadsheet} 內容表。
 *   worshipSheet {?Sheet} 「崇拜程序」分頁；沒有就傳 `null`（新建時第 2 步不會發生）。
 *   plan {Object} `planContentSheetV3Upgrade_()` 的輸出（`contentSheetV3PlanHasWrites_()` 為真）。
 *   quarterId {string} 季度 ID（AuditLog 用）。
 * Returns:
 *   {{weekCells:number, deletedColumns:number, contentCells:number, deactivated:number, snapshotWarnings:string[]}}
 * Raises:
 *   Error 任何一步失敗時原樣拋出（已寫的保留；重跑結果相同，見檔頭）。
 */
function applyContentSheetV3Upgrade_(spreadsheet, worshipSheet, plan, quarterId) {
  var out = { weekCells: 0, deletedColumns: 0, contentCells: 0, deactivated: 0, snapshotWarnings: [] };

  // ---- 第 1 步：浸禮六欄寫入週報（逐格 AuditLog）----
  if (plan.baptismWrites.length > 0) {
    var dates = [];
    plan.baptismWrites.forEach(function (w) { if (dates.indexOf(w.isoDate) === -1) dates.push(w.isoDate); });
    out.snapshotWarnings = snapshotWeeksBeforeWrite_(dates, 'CONTENT_SHEET_UPGRADE');
    var auditEntries = [];
    dates.forEach(function (iso) {
      var changes = plan.baptismWrites.filter(function (w) { return w.isoDate === iso; });
      applyWeekFieldChanges_(changes[0].rowNo, changes.map(function (w) {
        return { field: w.field, oldValue: w.oldValue, newValue: w.newValue };
      }), iso, auditEntries, 'CONTENT_SHEET_UPGRADE_V3');
    });
    auditEntries.forEach(function (e) {
      appendAuditLog_(Object.assign({}, e, {
        notes: '內容表 v3：浸禮副框改為只在填寫介面填，這一格由內容表（或之前在介面的覆寫）搬入週報。季度 ' + quarterId + '。'
      }));
    });
    out.weekCells = auditEntries.length;
    touchWeeksLastSavedAt_(dates, new Date());
  }

  // ---- 第 2 步：v2 才做，刪走「崇拜程序」第 L 至 Q 欄（浸禮六欄）----
  if (plan.deleteBaptismColumns && worshipSheet) {
    var v2Keys = contentSheetWorshipKeysV2_();
    var firstBaptismCol = v2Keys.indexOf(baptismBoxFieldKeys_()[0]) + 1;
    out.deletedColumns = deleteContentTabColumns_(worshipSheet, firstBaptismCol, v2Keys.length - firstBaptismCol + 1);
    appendAuditLog_({
      action: 'CONTENT_SHEET_MIGRATE_V3', sheetName: SHEETS.CONTENT_SHEETS, rowKey: quarterId, field: '崇拜程序',
      newValue: '刪欄 ' + out.deletedColumns,
      notes: '內容表 v3：「崇拜程序」第 ' + contentColumnLetter_(firstBaptismCol) + ' 至 '
        + contentColumnLetter_(v2Keys.length) + ' 欄（浸禮六欄）已刪走；資料已先搬入週報（' + out.weekCells + ' 格）。'
    });
  }

  // ---- 第 3 步：停用舊覆寫；九欄的覆寫值先寫入內容表的空白格 ----
  if (plan.overrideCellWrites.length > 0 && worshipSheet) {
    plan.overrideCellWrites.forEach(function (w) {
      writeContentCellAsText_(worshipSheet, w.rowNo, w.col, w.value);
      out.contentCells++;
    });
    appendAuditLog_({
      action: 'CONTENT_SHEET_MIGRATE_V3', sheetName: SHEETS.CONTENT_SHEETS, rowKey: quarterId, field: '崇拜程序',
      newValue: '格 ' + out.contentCells,
      notes: '內容表 v3：' + out.contentCells + ' 格以前在填寫介面改過、而內容表是空白，已把介面的值寫入內容表（印出來的不變）。'
    });
  }
  if (plan.overrideDeactivations.length > 0) {
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.FIELD_OVERRIDE);
    if (!sheet) {
      throw new Error('applyContentSheetV3Upgrade_：找不到工作表「' + SHEETS.FIELD_OVERRIDE + '」，請先執行「初始化工作表」。');
    }
    var activeCol = COLUMNS.FIELD_OVERRIDE.keys.indexOf('ACTIVE') + 1;
    plan.overrideDeactivations.forEach(function (d) {
      sheet.getRange(d.row.__rowNo, activeCol).setValue(false);
      appendAuditLog_({
        action: 'FIELD_OVERRIDE_RETIRE_V3', sheetName: SHEETS.FIELD_OVERRIDE, rowKey: d.isoDate + '#' + d.field,
        field: 'ACTIVE', oldValue: 'TRUE', newValue: 'FALSE',
        notes: d.kind === 'BAPTISM'
          ? '內容表 v3：浸禮副框改為只在填寫介面填，覆寫值「' + (d.overrideValue || '（空白）') + '」已經寫入週報，覆寫停用。記錄保留，不刪行。'
          : '內容表 v3：這一欄改為只在內容表填，以前在介面的覆寫「' + (d.overrideValue || '（空白）') + '」停用。記錄保留，不刪行。'
      });
      out.deactivated++;
    });
  }
  return out;
}

/**
 * 用途：v3 更新計畫的說明行（預覽與結果共用）。純函式。
 * Args:
 *   plan {Object} `planContentSheetV3Upgrade_()` 的輸出。
 *   options {{applied:boolean}=} `applied`＝已經做了（用「已」字）。
 * Returns:
 *   {string[]} 沒有東西要做時回空陣列。
 * Raises:
 *   （無）
 */
function buildContentSheetV3UpgradeLines_(plan, options) {
  if (!contentSheetV3PlanHasWrites_(plan)) return [];
  var will = (options || {}).applied ? '已' : '會';
  var lines = ['內容表更新成新版（2026-10）：「崇拜程序」各欄只可以在內容表填；浸禮副框六欄改為只在填寫介面填。'];
  if (plan.counts.baptismCells > 0) {
    lines.push('　浸禮副框：' + will + '把 ' + plan.counts.baptismDates + ' 個主日共 ' + plan.counts.baptismCells
      + ' 格搬入週報（之後在填寫介面「丙之二」改）。');
  }
  if (plan.baptismNoWeekRow.length > 0) {
    lines.push('　⚠️ ' + plan.baptismNoWeekRow.length + ' 格浸禮資料的主日在週報未有一行，沒有搬（內容表保留原值）：'
      + plan.baptismNoWeekRow.slice(0, 5).map(function (b) { return b.isoDate; }).join('、'));
  }
  if (plan.isV2) {
    lines.push('　「崇拜程序」第 L 至 Q 欄（浸禮六欄）' + will + '刪走；之後加「詩班項目名稱」一欄。');
  }
  if (plan.counts.overrideDeactivations > 0) {
    lines.push('　以前在填寫介面改過的 ' + plan.counts.overrideDeactivations + ' 格' + will + '停用'
      + (plan.counts.overrideCellWrites > 0 ? '（其中 ' + plan.counts.overrideCellWrites + ' 格內容表是空白，'
        + will + '把介面的值寫入內容表）' : '') + '。');
  }
  if (plan.counts.overrideConflicts > 0) {
    lines.push('　⚠️ ' + plan.counts.overrideConflicts + ' 格以前在介面改過、而內容表的值不同，之後以內容表為準'
      + '（下一次匯入會改用內容表的值）：');
    plan.overrideConflicts.slice(0, 10).forEach(function (c) {
      lines.push('　　' + c.isoDate + '「' + contentFieldLabel_(c.key) + '」：介面「' + (c.overrideValue || '（空白）')
        + '」，內容表「' + c.contentValue + '」');
    });
    if (plan.overrideConflicts.length > 10) lines.push('　　（另有 ' + (plan.overrideConflicts.length - 10) + ' 格未列出）');
  }
  return lines;
}
