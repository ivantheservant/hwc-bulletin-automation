/**
 * ContentSheetMigrate.gs
 *
 * 內容表 v2：把 v1 內容表移轉成 v2——「宣召」「浸禮合堂」兩張舊分頁併入「崇拜程序」，
 * 「崇拜程序」在最後加新欄（序樂、宣召出處、宣召經文、詩歌頌讚、浸禮六欄），每個主日一行。
 * 新建內容表亦走同一套（沒有舊分頁、崇拜程序是空的），所以「預先開好每個主日一行」只有一個做法。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 為甚麼要這樣小心（docs/已知bug類型.md bug class 121、122、2、3）
 * ─────────────────────────────────────────────────────────────────────
 *
 *   合併分頁是**欄位層的換來源**：以前宣召由「宣召」分頁匯入、序樂只在填寫介面填；之後全部由
 *   「崇拜程序」匯入。危險位置是「崇拜程序那個主日已經有一行，但新欄是空白」——匯入會把週報的
 *   宣召、序樂、浸禮清空。所以：
 *     1. 新欄**逐格**回填：先用舊分頁的值，沒有就用週報（BulletinWeeks）現值；**只填空白格**，
 *        崇拜程序已經有不同的值就保留崇拜程序的值，列入「兩邊不同」；
 *     2. 週報回填**只填這一次新加的欄**；原有四欄（讀經經文等）照舊以內容表為準；
 *     3. 崇拜程序那個主日一行都沒有（生效或停用都沒有）→ 新增一行，**所有欄**都由週報帶齊，
 *        再蓋上舊分頁的值——否則新行會令匯入清空那個主日的講題；
 *     4. 目標行＝該主日最後一行生效中的資料，與匯入共用 `lastActiveRowByDate_()`；
 *     5. 舊分頁的停用行、不屬本季的日期、同一主日多行生效 → 不搬，逐項列入報告。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 次序與「提交點」
 * ─────────────────────────────────────────────────────────────────────
 *
 *   `applyContentSheetV2Migration_()`：補欄 → 新欄設純文字 → 逐格寫入與新增行 → 舊分頁改名、
 *   隱藏、註解、警告式保護（**不刪**）。之後由 `buildOrRefreshContentSheet_()` 的分頁迴圈呼叫
 *   `applyContentTabLayout_()` **最後才寫崇拜程序第 1、2 行**——第 2 行就是提交點：任何一步中途
 *   失敗，下一次仍然判定要移轉，而「只填空白格」令重跑結果與一次跑完相同。中間期間匯入會被
 *   `checkContentSheetSchema_()` 擋住（第 2 行不符或舊分頁未改名）。
 *
 *   預覽（`previewContentSheetBuild_()`）與執行用同一個讀取函式與同一個 planner（bug class 120）。
 *   自動流程（星期一）不替人移轉（bug class 113），見 `buildOrRefreshContentSheet_()`。
 *
 * 分層：本檔案是業務邏輯；格子讀寫全部經 `src/ContentSheetIo.gs`。
 */

'use strict';

/** 移轉時新增的行寫在「備註」的字眼（新建內容表的行不寫）。 */
var CONTENT_SHEET_MIGRATED_ROW_NOTE_ = '系統移轉建立';

/** 已停用舊分頁 A1 的註解。 */
var CONTENT_SHEET_RETIRED_TAB_NOTE_ = '已停用（2026-10）：資料已搬入「崇拜程序」分頁，請不要再填這一張。';

/** 已停用舊分頁的保護說明（警告式保護：仍然改得到，但會先彈出警告）。 */
var CONTENT_SHEET_RETIRED_TAB_PROTECTION_ = '週報系統：已停用的舊分頁，資料已搬入「崇拜程序」';

/**
 * 用途：移轉要讀的三樣東西：崇拜程序（第 2 行與資料）、兩張舊分頁（改名前後兩個名字都認）、
 *   BulletinWeeks。唯讀。
 * Args:
 *   spreadsheet {Spreadsheet} 已經開啟的內容表。
 * Returns:
 *   {{worship:{exists:boolean, headerKeys:string[], rows:Object[]},
 *     legacy:{kind:string, def:Object, sheetName:string, renamed:boolean, headerKeys:string[], rows:Object[]}[],
 *     weeks:Object[]}}
 *     `rows` 一律經 `parseContentTabRows_()`（單一正規化）：崇拜程序按 v2 定義解析，舊分頁按凍結的
 *     v1 定義解析。
 * Raises:
 *   Error 讀取失敗時原樣拋出。
 */
function readContentSheetV2Inputs_(spreadsheet) {
  var worshipDef = contentSheetWorshipTabDef_();
  var n = worshipDef.keys.length;
  var worshipSheet = spreadsheet.getSheetByName(worshipDef.tabName);
  var worship = { exists: Boolean(worshipSheet), headerKeys: [], rows: [] };
  if (worshipSheet) {
    worship.headerKeys = readContentTabHeaderKeys_(worshipSheet, n);
    worship.rows = parseContentTabRows_(readContentTabDataValues_(worshipSheet, n), worshipDef.keys);
  }

  var legacy = [];
  var sheets = spreadsheet.getSheets();
  legacyMergedTabDefs_().forEach(function (def) {
    // 已改名的排前、未改名的排後：同一個主日兩邊都有值時，以未改名（仍然在用）那一張為準。
    var matched = sheets.filter(function (sheet) {
      var name = String(sheet.getName());
      return name.indexOf(def.tabName + CONTENT_SHEET_RETIRED_TAB_SUFFIX_) === 0;
    }).concat(sheets.filter(function (sheet) { return String(sheet.getName()) === def.tabName; }));
    matched.forEach(function (sheet) {
      var name = String(sheet.getName());
      legacy.push({
        kind: def.kind, def: def, sheetName: name, renamed: name !== def.tabName,
        headerKeys: readContentTabHeaderKeys_(sheet, def.keys.length),
        rows: parseContentTabRows_(readContentTabDataValues_(sheet, def.keys.length), def.keys)
      });
    });
  });

  return { worship: worship, legacy: legacy, weeks: readSheet(SHEETS.BULLETIN_WEEKS) };
}

/**
 * 用途：把一格的值轉成比較用的文字（去頭尾空白；null／undefined＝空字串）。純函式。
 * Args:
 *   value {*}
 * Returns:
 *   {string}
 * Raises:
 *   （無）
 */
function migrationText_(value) {
  if (value === null || value === undefined) return '';
  if (Object.prototype.toString.call(value) === '[object Date]') return '';
  return String(value).trim();
}

/**
 * 用途：內容表 v2 移轉的計畫。純函式；預覽與執行共用。規則見檔頭。
 * Args:
 *   input {{serviceDates:string[], worship:Object, legacy:Object[], weeks:Object[], created:boolean}}
 *     前三樣見 `readContentSheetV2Inputs_()`；`created`＝這一次新建的內容表（新增行的「備註」留空）。
 * Returns:
 *   {{ok:boolean, reason:string, message:string, needsMigration:boolean, keys:string[],
 *     newColumns:string[], cellWrites:Object[], appends:Object[], conflicts:Object[], skipped:Object[],
 *     legacyToRetire:{kind:string, sheetName:string}[],
 *     counts:{newColumns:number, callDates:number, baptismDates:number, weekCells:number,
 *       appendedRows:number, conflicts:number, skipped:number}}}
 *     `ok:false`（`LAYOUT_UNKNOWN`／`LEGACY_LAYOUT_UNKNOWN`）時一格都不可以寫。
 *     已經是新版（`needsMigration:false`）時只會有 `appends`：未有任何一行的主日預先開好一行。
 *     要不要寫，看 `contentSheetPlanHasWrites_()`。
 * Raises:
 *   （無）
 */
function planContentSheetV2Migration_(input) {
  var def = contentSheetWorshipTabDef_();
  var keys = def.keys;
  var valueKeys = keys.filter(function (k) { return k !== 'SERVICE_DATE' && k !== 'ACTIVE' && k !== 'NOTES'; });
  var plan = {
    ok: true, reason: '', message: '', needsMigration: false, keys: keys, newColumns: [],
    cellWrites: [], appends: [], conflicts: [], skipped: [], legacyToRetire: [],
    counts: { newColumns: 0, callDates: 0, baptismDates: 0, weekCells: 0, appendedRows: 0, conflicts: 0, skipped: 0 }
  };

  var worship = input.worship || { exists: false, headerKeys: [], rows: [] };
  var header = compareContentTabHeaderKeys_(keys, worship.exists ? worship.headerKeys : []);
  if (header.status === 'HEADER_CHANGED') {
    plan.ok = false;
    plan.reason = 'LAYOUT_UNKNOWN';
    plan.message = '內容表「崇拜程序」第 2 行（機器鍵）第 ' + header.column + ' 欄應該是「' + header.expected
      + '」，現在是「' + (header.actual || '（空白）') + '」——這不是舊版，也不是新版，系統認不出欄位次序，'
      + '所以這次一格都沒有寫。請把第 2 行與欄位次序改回原樣（檔案 ▸ 版本記錄），再按一次。';
    return plan;
  }

  var legacy = input.legacy || [];
  var badLegacy = legacy.filter(function (l) {
    return compareContentTabHeaderKeys_(l.def.keys, l.headerKeys).status !== 'OK';
  });
  if (badLegacy.length > 0) {
    plan.ok = false;
    plan.reason = 'LEGACY_LAYOUT_UNKNOWN';
    plan.message = '舊分頁「' + badLegacy.map(function (l) { return l.sheetName; }).join('」「')
      + '」的第 2 行（機器鍵）與舊版不同，系統不知道哪一欄是甚麼，不可以搬，所以這次一格都沒有寫。'
      + '請把那張分頁的第 2 行改回原樣（檔案 ▸ 版本記錄），再按一次。';
    return plan;
  }

  var prefixLen = header.status === 'OK' ? keys.length : header.column - 1;
  plan.newColumns = keys.slice(prefixLen);
  plan.counts.newColumns = plan.newColumns.length;
  var newValueKeys = plan.newColumns.filter(function (k) { return valueKeys.indexOf(k) !== -1; });
  plan.legacyToRetire = legacy.filter(function (l) { return !l.renamed; })
    .map(function (l) { return { kind: l.kind, sheetName: l.sheetName }; });
  plan.needsMigration = header.status !== 'OK' || plan.legacyToRetire.length > 0;
  // 已經是新版：舊分頁（已改名）不再讀，只為未有任何一行的主日（例如職事表其後加了一個主日）
  // 預先開好一行。
  if (!plan.needsMigration) legacy = [];

  var serviceDates = (input.serviceDates || []).slice();
  var inQuarter = {};
  serviceDates.forEach(function (d) { inQuarter[d] = true; });

  // ---- 舊分頁：每個主日最後一行生效中的值（未改名的蓋過已改名的）----
  var legacyByDate = {};
  legacy.forEach(function (entry) {
    var last = lastActiveRowByDate_(entry.rows);
    entry.rows.forEach(function (row) {
      var iso = String(row.SERVICE_DATE || '').trim();
      var where = { sheetName: entry.sheetName, rowNo: row.__rowNo, isoDate: iso };
      if ((row.__typeIssues || []).indexOf('SERVICE_DATE') !== -1) {
        plan.skipped.push(Object.assign(where, { reason: '主日日期被試算表轉成日期，沒有搬' }));
      } else if (row.__active !== true) {
        plan.skipped.push(Object.assign(where, { reason: '已停用（有效＝FALSE），沒有搬' }));
      } else if (!iso || !inQuarter[iso]) {
        plan.skipped.push(Object.assign(where, { reason: '不是本季的主日，沒有搬' }));
      } else if (last[iso] !== row) {
        plan.skipped.push(Object.assign(where, { reason: '同一個主日有多行生效中的資料，以最後一行為準，這一行沒有搬' }));
      } else {
        (row.__typeIssues || []).forEach(function (key) {
          if (entry.def.valueKeys.indexOf(key) === -1) return;
          plan.skipped.push(Object.assign({}, where, { reason: '「' + key + '」被試算表轉成日期／時間，這一格沒有搬' }));
        });
      }
    });
    Object.keys(last).forEach(function (iso) {
      if (!inQuarter[iso]) return;
      entry.def.valueKeys.forEach(function (key) {
        var v = migrationText_(last[iso][key]);
        if (v === '') return;
        if (!legacyByDate[iso]) legacyByDate[iso] = {};
        legacyByDate[iso][key] = { value: v, kind: entry.kind };
      });
    });
  });

  var weekByDate = {};
  (input.weeks || []).forEach(function (w) {
    var iso = fieldOverrideIsoOf_(w.SERVICE_DATE);
    if (iso) weekByDate[iso] = w;
  });

  var targets = lastActiveRowByDate_(worship.rows || []);
  var anyRow = {};
  (worship.rows || []).forEach(function (row) {
    var iso = String(row.SERVICE_DATE || '').trim();
    if (iso) anyRow[iso] = true;
  });

  var movedDates = { CALL: {}, BAPTISM: {} };
  serviceDates.forEach(function (iso) {
    var fromLegacy = legacyByDate[iso] || {};
    var week = weekByDate[iso] || null;
    var target = targets[iso];

    if (target) {
      if (!plan.needsMigration) return;
      valueKeys.forEach(function (key) {
        var candidate = '';
        var source = '';
        if (fromLegacy[key]) {
          candidate = fromLegacy[key].value;
          source = fromLegacy[key].kind;
        } else if (newValueKeys.indexOf(key) !== -1 && week) {
          candidate = migrationText_(week[key]);
          source = 'WEEKS';
        }
        if (candidate === '') return;
        var existingIsDate = (target.__typeIssues || []).indexOf(key) !== -1;
        var existing = existingIsDate ? '' : migrationText_(target[key]);
        if (!existingIsDate && existing === '') {
          plan.cellWrites.push({ isoDate: iso, rowNo: target.__rowNo, key: key, col: keys.indexOf(key) + 1, value: candidate, source: source });
          if (source === 'WEEKS') plan.counts.weekCells++;
          else movedDates[source][iso] = true;
        } else if (existingIsDate || existing !== candidate) {
          plan.conflicts.push({
            isoDate: iso, key: key, existing: existingIsDate ? '（被試算表轉成日期／時間）' : existing,
            candidate: candidate, source: source
          });
        }
      });
      return;
    }

    if (anyRow[iso]) {
      // 那個主日只有已停用的行：幹事刻意停用，不替他另起一行。舊分頁的值不搬，講出來。
      if (Object.keys(fromLegacy).length > 0) {
        plan.skipped.push({
          sheetName: def.tabName, rowNo: 0, isoDate: iso,
          reason: '「崇拜程序」這個主日只有已停用的行，舊分頁的資料沒有搬'
        });
      }
      return;
    }

    var row = { SERVICE_DATE: iso, ACTIVE: true, NOTES: (plan.needsMigration && !input.created) ? CONTENT_SHEET_MIGRATED_ROW_NOTE_ : '' };
    valueKeys.forEach(function (key) {
      if (fromLegacy[key]) {
        row[key] = fromLegacy[key].value;
        movedDates[fromLegacy[key].kind][iso] = true;
      } else {
        row[key] = week ? migrationText_(week[key]) : '';
      }
    });
    plan.appends.push({ isoDate: iso, row: row });
  });

  plan.counts.callDates = Object.keys(movedDates.CALL).length;
  plan.counts.baptismDates = Object.keys(movedDates.BAPTISM).length;
  plan.counts.appendedRows = plan.appends.length;
  plan.counts.conflicts = plan.conflicts.length;
  plan.counts.skipped = plan.skipped.length;
  return plan;
}

/**
 * 用途：這一份計畫有沒有東西要寫（要移轉，或者有主日要預先開一行）。純函式。
 * Args:
 *   plan {?Object} `planContentSheetV2Migration_()` 的輸出。
 * Returns:
 *   {boolean}
 * Raises:
 *   （無）
 */
function contentSheetPlanHasWrites_(plan) {
  return Boolean(plan && plan.ok && (plan.needsMigration || plan.appends.length > 0));
}

/**
 * 用途：舊分頁改名用的名稱：「宣召（已停用）」；已經有同名分頁就加數字（「宣召（已停用）2」…）。
 * Args:
 *   spreadsheet {Spreadsheet} 內容表。
 *   baseName {string} 舊分頁原名。
 * Returns:
 *   {string}
 * Raises:
 *   Error 讀取失敗時原樣拋出。
 */
function uniqueRetiredContentTabName_(spreadsheet, baseName) {
  var name = baseName + CONTENT_SHEET_RETIRED_TAB_SUFFIX_;
  var n = 2;
  while (spreadsheet.getSheetByName(name)) {
    name = baseName + CONTENT_SHEET_RETIRED_TAB_SUFFIX_ + n;
    n++;
  }
  return name;
}

/**
 * 用途：內容表內已停用（已改名加「（已停用）」）的舊分頁名稱，`_說明` 用。唯讀。
 * Args:
 *   spreadsheet {Spreadsheet} 內容表。
 * Returns:
 *   {string[]} 按分頁次序。
 * Raises:
 *   Error 讀取失敗時原樣拋出。
 */
function listRetiredContentTabNames_(spreadsheet) {
  var bases = legacyMergedTabDefs_().map(function (def) { return def.tabName + CONTENT_SHEET_RETIRED_TAB_SUFFIX_; });
  return spreadsheet.getSheets().map(function (sheet) { return String(sheet.getName()); }).filter(function (name) {
    return bases.some(function (b) { return name.indexOf(b) === 0; });
  });
}

/**
 * 用途：執行移轉計畫（次序見檔頭）。**不寫崇拜程序第 1、2 行**——那是呼叫方之後
 *   `applyContentTabLayout_()` 的事（提交點）。每一步寫 AuditLog `CONTENT_SHEET_MIGRATE_V2` 摘要。
 * Args:
 *   spreadsheet {Spreadsheet} 內容表。
 *   worshipSheet {Sheet} 「崇拜程序」分頁（已經 `ensureContentTab_()`）。
 *   plan {Object} `planContentSheetV2Migration_()` 的輸出（`contentSheetPlanHasWrites_()` 為真）。
 *   quarterId {string} 季度 ID（AuditLog 用）。
 * Returns:
 *   {{retiredTabs:{from:string, to:string}[]}}
 * Raises:
 *   Error 任何一步失敗時原樣拋出（已寫的格保留；第 2 行未寫，下一次重跑只填仍然空白的格）。
 */
function applyContentSheetV2Migration_(spreadsheet, worshipSheet, plan, quarterId) {
  var keys = plan.keys;
  ensureContentTabColumns_(worshipSheet, keys.length);

  // 1. 新欄先設純文字（寫入之前），否則「3:16」之類的值會被轉成時間（bug class 11、45）。
  //    「有效」欄不設（它是 TRUE／FALSE 下拉）。
  plan.newColumns.forEach(function (key) {
    if (key === 'ACTIVE') return;
    setContentRangePlainText_(worshipSheet, CONTENT_SHEET_FIRST_DATA_ROW_, keys.indexOf(key) + 1,
      CONTENT_SHEET_BLANK_ROWS_, 1);
  });

  // 2. 逐格寫入（只填空白格，planner 已經篩過）。
  plan.cellWrites.forEach(function (w) {
    writeContentCellAsText_(worshipSheet, w.rowNo, w.col, w.value);
  });

  // 新增行：「有效」以外的欄先設純文字，再整批寫入。
  if (plan.appends.length > 0) {
    var startRow = Math.max(worshipSheet.getLastRow() + 1, CONTENT_SHEET_FIRST_DATA_ROW_);
    var activeCol = keys.indexOf('ACTIVE') + 1;
    setContentRangePlainText_(worshipSheet, startRow, 1, plan.appends.length, activeCol - 1);
    setContentRangePlainText_(worshipSheet, startRow, activeCol + 1, plan.appends.length, keys.length - activeCol);
    var rows = plan.appends.map(function (a) {
      var out = {};
      keys.forEach(function (k) {
        out[k] = k === 'ACTIVE' ? a.row[k] : sanitizeCellText_(a.row[k] === undefined ? '' : a.row[k]);
      });
      return out;
    });
    writeContentRows_(worshipSheet, keys, rows, startRow);
  }

  // 3. 舊分頁改名、隱藏、註解、警告式保護。不刪。
  var retiredTabs = [];
  plan.legacyToRetire.forEach(function (l) {
    var sheet = spreadsheet.getSheetByName(l.sheetName);
    if (!sheet) return;
    var newName = uniqueRetiredContentTabName_(spreadsheet, l.sheetName);
    retireContentTab_(sheet, newName, CONTENT_SHEET_RETIRED_TAB_NOTE_, CONTENT_SHEET_RETIRED_TAB_PROTECTION_);
    retiredTabs.push({ from: l.sheetName, to: newName });
  });

  appendAuditLog_({
    action: 'CONTENT_SHEET_MIGRATE_V2', sheetName: SHEETS.CONTENT_SHEETS, rowKey: quarterId, field: '崇拜程序',
    newValue: '欄 +' + plan.counts.newColumns + '；格 ' + plan.cellWrites.length + '；行 +' + plan.appends.length
      + '；兩邊不同 ' + plan.counts.conflicts,
    notes: plan.needsMigration
      ? ('內容表 v2 移轉：「崇拜程序」加 ' + plan.counts.newColumns + ' 欄，寫入 ' + plan.cellWrites.length
        + ' 格（其中由週報回填 ' + plan.counts.weekCells + ' 格），新增 ' + plan.appends.length + ' 行，'
        + plan.counts.conflicts + ' 格兩邊不同（保留崇拜程序的值）。')
      : ('「崇拜程序」為 ' + plan.appends.length + ' 個未有任何一行的主日預先開好一行，由週報帶入現有的值。')
  });
  retiredTabs.forEach(function (t) {
    var kind = plan.legacyToRetire.filter(function (l) { return l.sheetName === t.from; })[0].kind;
    appendAuditLog_({
      action: 'CONTENT_SHEET_MIGRATE_V2', sheetName: SHEETS.CONTENT_SHEETS, rowKey: quarterId, field: t.from,
      oldValue: t.from, newValue: t.to,
      notes: '內容表 v2 移轉：舊分頁「' + t.from + '」的資料已搬入「崇拜程序」（'
        + (kind === 'CALL' ? plan.counts.callDates : plan.counts.baptismDates) + ' 個主日），分頁改名為「'
        + t.to + '」並隱藏，沒有刪除。'
    });
  });

  return { retiredTabs: retiredTabs };
}

/**
 * 用途：移轉計畫的說明行（預覽與結果對話框共用）。純函式。
 * Args:
 *   plan {Object} `planContentSheetV2Migration_()` 的輸出。
 *   options {{applied:boolean, created:boolean}} `applied`＝已經做了（用「已」字）；
 *     `created`＝新建的內容表（只講預先開好幾行）。
 * Returns:
 *   {string[]} 不用移轉時回空陣列。
 * Raises:
 *   （無）
 */
function buildContentSheetMigrationLines_(plan, options) {
  var o = options || {};
  if (!contentSheetPlanHasWrites_(plan)) return [];
  var will = o.applied ? '已' : '會';
  var lines = [];
  if (!plan.needsMigration) {
    lines.push('「崇拜程序」' + will + '為 ' + plan.counts.appendedRows + ' 個未有任何一行的主日預先開好一行，由週報帶入現有的值。');
    return lines;
  }
  if (o.created) {
    lines.push('「崇拜程序」' + will + '預先開好 ' + plan.counts.appendedRows + ' 行（每個主日一行），由週報帶入現有的值。');
    return lines;
  }
  lines.push('內容表移轉成新版：「宣召」「浸禮合堂」兩張分頁併入「崇拜程序」。');
  if (plan.counts.newColumns > 0) {
    lines.push('　「崇拜程序」' + will + '在最後加 ' + plan.counts.newColumns + ' 欄。');
  }
  lines.push('　由舊「宣召」搬入 ' + plan.counts.callDates + ' 個主日；由舊「浸禮合堂」搬入 '
    + plan.counts.baptismDates + ' 個主日。');
  lines.push('　由週報回填 ' + plan.counts.weekCells + ' 格（只填空白格）。');
  lines.push('　新增 ' + plan.counts.appendedRows + ' 行（這幾個主日「崇拜程序」未有任何一行，所有欄由週報帶齊）。');
  if (plan.counts.conflicts > 0) {
    lines.push('　⚠️ ' + plan.counts.conflicts + ' 格兩邊不同，保留「崇拜程序」的值：');
    plan.conflicts.slice(0, 10).forEach(function (c) {
      lines.push('　　' + c.isoDate + '「' + contentTabColumnLabel_('崇拜程序', c.key) + '」：崇拜程序「' + c.existing
        + '」，' + (c.source === 'WEEKS' ? '週報' : (c.source === 'CALL' ? '舊宣召' : '舊浸禮合堂')) + '「' + c.candidate + '」');
    });
    if (plan.conflicts.length > 10) lines.push('　　（另有 ' + (plan.conflicts.length - 10) + ' 格未列出）');
  }
  if (plan.skipped.length > 0) {
    lines.push('　⚠️ ' + plan.skipped.length + ' 項沒有搬（舊分頁保留，資料仍在）：');
    plan.skipped.slice(0, 10).forEach(function (s) {
      lines.push('　　' + s.sheetName + (s.rowNo ? ' 第 ' + s.rowNo + ' 行' : '') + (s.isoDate ? '（' + s.isoDate + '）' : '') + '：' + s.reason);
    });
    if (plan.skipped.length > 10) lines.push('　　（另有 ' + (plan.skipped.length - 10) + ' 項未列出）');
  }
  if (plan.legacyToRetire.length > 0) {
    lines.push('　舊分頁' + plan.legacyToRetire.map(function (l) { return '「' + l.sheetName + '」'; }).join('')
      + will + '改名（加「' + CONTENT_SHEET_RETIRED_TAB_SUFFIX_ + '」）並隱藏，不會刪除。');
  }
  return lines;
}
