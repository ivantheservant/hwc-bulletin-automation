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
 *     5. 舊分頁的停用行、不屬本季的日期、同一主日多行生效 → 不搬，逐項列入報告；
 *     6. 那個主日只有已停用的行（HH-13：不另起一行）→ 新欄同樣回填在**最後一行停用行**的空白格
 *        （停用行不匯入，沒有副作用；日後幹事把它改回 TRUE，也不會清空週報。審查 A3）；
 *     7. v1 的新欄位置（第 8 欄以後）原本已經有字，而且不是移轉自己寫的 → **整次拒絕**
 *        （`NEW_COLUMNS_NOT_EMPTY`），逐格列出，請人先移走（審查 A6）。否則那些字之後會被匯入，
 *        當成序樂、宣召或浸禮資料印在週報上。「移轉自己寫的」＝與這一次計畫的值相同（中途失敗之後
 *        重跑），或者在移轉新增的行（「備註」是「系統移轉建立」）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 次序與「提交點」
 * ─────────────────────────────────────────────────────────────────────
 *
 *   `applyContentSheetV2Migration_()`：補欄 → 新欄設純文字 → 逐格寫入與新增行 → 舊分頁改名、
 *   隱藏、註解、警告式保護（**不刪**）。改名之後才失敗的話，下一次 planner 會找出已改名的分頁缺了
 *   哪幾樣（`legacyToFinish`），補做（審查 B2）；這一步即使已經是新版亦會做。之後由 `buildOrRefreshContentSheet_()` 的分頁迴圈呼叫
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

/**
 * AuditLog 動作：「這一份內容表的移轉已經開始」（第一格寫入之前寫）。重跑時見到這一行，就知道新欄位置的字
 * 可能是上一次移轉自己寫的（兩次之間來源又改過），不可以當成「原本已經有字」整次拒絕（審查 A6-2 至 A6-4）。
 */
// v3（2026-10-26）：改用新的記錄名稱。v1 → v2 那一次（舊記錄 CONTENT_SHEET_MIGRATE_V2_START）已經完成的內容表，
//    v3 加「詩班項目名稱」一欄時要重新核對新欄位置原本沒有字，不可以當成「上一次已經開始」。
var CONTENT_SHEET_MIGRATE_START_ACTION_ = 'CONTENT_SHEET_MIGRATE_V3_START';

/** 已停用舊分頁 A1 的註解。 */
var CONTENT_SHEET_RETIRED_TAB_NOTE_ = '已停用（2026-10）：資料已搬入「崇拜程序」分頁，請不要再填這一張。';

/** 已停用舊分頁的保護說明（警告式保護：仍然改得到，但會先彈出警告）。 */
var CONTENT_SHEET_RETIRED_TAB_PROTECTION_ = '週報系統：已停用的舊分頁，資料已搬入「崇拜程序」';

/**
 * 用途：移轉要讀的三樣東西：崇拜程序（第 2 行與資料）、兩張舊分頁（改名前後兩個名字都認）、
 *   BulletinWeeks，以及 AuditLog 有沒有這一份內容表「移轉已開始」的記錄。唯讀。
 * Args:
 *   spreadsheet {Spreadsheet} 已經開啟的內容表。
 * Returns:
 *   {{worship:{exists:boolean, headerKeys:string[], rows:Object[]},
 *     legacy:{kind:string, def:Object, sheetName:string, renamed:boolean, retiredState:?Object,
 *       headerKeys:string[], rows:Object[]}[],
 *     weeks:Object[], migrationStarted:boolean}}
 *     `rows` 一律經 `parseContentTabRows_()`（單一正規化）：崇拜程序按 v2 定義解析，舊分頁按凍結的
 *     v1 定義解析。`retiredState`：已改名的分頁還缺哪幾樣（`inspectRetiredContentTab_()`）；未改名的是 `null`。
 * Raises:
 *   Error 讀取失敗時原樣拋出。
 */
function readContentSheetV2Inputs_(spreadsheet) {
  var worshipDef = contentSheetWorshipTabDefV3_();
  var n = worshipDef.keys.length;
  var v2Keys = contentSheetWorshipKeysV2_();
  var worshipSheet = spreadsheet.getSheetByName(worshipDef.tabName);
  var worship = { exists: Boolean(worshipSheet), layout: '', headerKeys: [], rows: [], v2Rows: [] };
  if (worshipSheet) {
    // v3：先認出 v2（第 2 行頭十七格與 v2 完全相同）。v2 的第 12 欄是浸禮主禮，v3 的第 12 欄是詩班項目名稱，
    //    直接按 v3 讀會把浸禮主禮當成詩班項目名稱。認出 v2 之後，這裏交給 planner 的是「刪走浸禮六欄之後」
    //    的樣子（頭十一欄、第 12 欄空白），與 applyContentSheetV3Upgrade_() 真正做完之後讀到的完全一樣——
    //    預覽與執行用同一份計畫（bug class 120）。
    //    v2 第 17 欄之後的格（刪欄之後會變成 v3 的新欄，例如第 R 欄 → 第 L 欄「詩班項目名稱」）一併讀出來，
    //    預覽才看得到「新欄位置原本有字」（與真正刪欄之後讀到的一樣）。
    var tailKeys = v3TailKeysAfterV2_(worshipDef.keys);
    var longHeader = readContentTabHeaderKeys_(worshipSheet, Math.max(n, v2Keys.length + tailKeys.length));
    var isV2 = v2Keys.every(function (k, i) { return longHeader[i] === k; });
    if (isV2) {
      worship.layout = 'V2';
      worship.v2Rows = parseContentTabRows_(readContentTabDataValues_(worshipSheet, v2Keys.length + tailKeys.length),
        v2Keys.concat(tailKeys));
      worship.headerKeys = simulateWorshipHeaderAfterV3Drop_(worshipDef.keys, longHeader.slice(v2Keys.length));
      worship.rows = simulateWorshipRowsAfterV3Drop_(worship.v2Rows, worshipDef.keys);
    } else {
      worship.headerKeys = longHeader.slice(0, n);
      worship.rows = parseContentTabRows_(readContentTabDataValues_(worshipSheet, n), worshipDef.keys);
    }
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
      var renamed = name !== def.tabName;
      legacy.push({
        kind: def.kind, def: def, sheetName: name, renamed: renamed,
        retiredState: renamed
          ? inspectRetiredContentTab_(sheet, CONTENT_SHEET_RETIRED_TAB_NOTE_, CONTENT_SHEET_RETIRED_TAB_PROTECTION_)
          : null,
        headerKeys: readContentTabHeaderKeys_(sheet, def.keys.length),
        rows: parseContentTabRows_(readContentTabDataValues_(sheet, def.keys.length), def.keys)
      });
    });
  });

  return {
    worship: worship, legacy: legacy,
    // v3：帶行號（浸禮六欄要寫回週報那一行）。
    weeks: readRowsWithRowNo_(SHEETS.BULLETIN_WEEKS),
    // v3：生效中的欄位覆寫（帶行號）——九欄改為只在內容表填、浸禮六欄改為只在介面填，舊覆寫要停用。
    fieldOverrides: readRowsWithRowNo_(SHEETS.FIELD_OVERRIDE).filter(function (r) { return r.ACTIVE === true; }),
    migrationStarted: contentSheetMigrationStarted_(readSheet(SHEETS.AUDIT_LOG), String(spreadsheet.getId()))
  };
}

/**
 * 用途：AuditLog 有沒有這一份內容表「移轉已開始」的記錄（`CONTENT_SHEET_MIGRATE_V2_START`，欄位＝檔案 ID）。純函式。
 * Args:
 *   auditRows {Object[]} `readSheet(SHEETS.AUDIT_LOG)` 的輸出。
 *   fileId {string} 內容表檔案 ID。
 * Returns:
 *   {boolean}
 * Raises:
 *   （無）
 */
function contentSheetMigrationStarted_(auditRows, fileId) {
  var id = String(fileId || '').trim();
  if (!id) return false;
  return (auditRows || []).some(function (r) {
    return String(r.ACTION || '') === CONTENT_SHEET_MIGRATE_START_ACTION_ && String(r.FIELD || '').trim() === id;
  });
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
 *   input {{serviceDates:string[], worship:Object, legacy:Object[], weeks:Object[], created:boolean,
 *     migrationStarted:boolean}}
 *     前三樣與 `migrationStarted` 見 `readContentSheetV2Inputs_()`；`created`＝這一次新建的內容表（新增行的「備註」留空）。
 * Returns:
 *   {{ok:boolean, reason:string, message:string, needsMigration:boolean, keys:string[],
 *     newColumns:string[], cellWrites:Object[], appends:Object[], conflicts:Object[], skipped:Object[],
 *     strayCells:Object[], legacyToRetire:{kind:string, sheetName:string}[],
 *     legacyToFinish:{kind:string, sheetName:string, state:Object}[],
 *     counts:{newColumns:number, callDates:number, baptismDates:number, weekCells:number,
 *       appendedRows:number, conflicts:number, skipped:number, inactiveDates:number}}}
 *     `ok:false`（`LAYOUT_UNKNOWN`／`LEGACY_LAYOUT_UNKNOWN`／`NEW_COLUMNS_NOT_EMPTY`）時一格都不可以寫。
 *     已經是新版（`needsMigration:false`）時只會有 `appends`（未有任何一行的主日預先開好一行）與
 *     `legacyToFinish`（已改名的舊分頁補做隱藏、註解、保護）。
 *     要不要寫，看 `contentSheetPlanHasWrites_()`。
 * Raises:
 *   （無）
 */
function planContentSheetV2Migration_(input) {
  var def = contentSheetWorshipTabDefV3_();
  var keys = def.keys;
  var valueKeys = keys.filter(function (k) { return k !== 'SERVICE_DATE' && k !== 'ACTIVE' && k !== 'NOTES'; });
  var plan = {
    ok: true, reason: '', message: '', needsMigration: false, resumed: false, keys: keys, newColumns: [],
    cellWrites: [], appends: [], conflicts: [], skipped: [], strayCells: [], legacyToRetire: [], legacyToFinish: [],
    counts: {
      newColumns: 0, callDates: 0, baptismDates: 0, weekCells: 0, appendedRows: 0, conflicts: 0, skipped: 0,
      inactiveDates: 0
    }
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
  // 審查 B2：已改名、但隱藏／註解／保護未做齊（改名之後中途失敗）的舊分頁，補做缺的那幾樣。
  plan.legacyToFinish = legacy.filter(function (l) {
    var st = l.renamed ? l.retiredState : null;
    return Boolean(st && (st.needsHide || st.needsNote || st.needsProtect));
  }).map(function (l) { return { kind: l.kind, sheetName: l.sheetName, state: l.retiredState }; });
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
  var rowsByDate = {};
  (worship.rows || []).forEach(function (row) {
    var iso = String(row.SERVICE_DATE || '').trim();
    if (!iso) return;
    if (!rowsByDate[iso]) rowsByDate[iso] = [];
    rowsByDate[iso].push(row);
  });

  var movedDates = { CALL: {}, BAPTISM: {} };

  // 這一格移轉打算寫甚麼：先用舊分頁的值，沒有就用週報現值（只限這一次新加的欄）。
  var candidateFor = function (key, fromLegacy, week) {
    if (fromLegacy[key]) return { value: fromLegacy[key].value, source: fromLegacy[key].kind };
    if (newValueKeys.indexOf(key) !== -1 && week) return { value: migrationText_(week[key]), source: 'WEEKS' };
    return { value: '', source: '' };
  };
  // 移轉新增的行（中途失敗之後重跑時已經在）：新欄的值本來就是移轉由週報帶入的，不算「原本有字」。
  var isMigratedRow = function (row) {
    return migrationText_(row.NOTES) === CONTENT_SHEET_MIGRATED_ROW_NOTE_;
  };
  // 審查 A6：v1 的新欄位置原本已經有字（不是移轉自己寫的）。只在第 2 行仍然是舊版時才會發生。
  //    上一次移轉已經開始（AuditLog 有記錄）的話，第一次寫入之前已經核對過「原本沒有字」，現在新欄位置的字
  //    只可能是上一次自己寫的（兩次之間來源再改過）→ 當作「兩邊不同」保留現值，不拒絕（審查 A6-2 至 A6-4）。
  plan.resumed = plan.needsMigration && input.migrationStarted === true;
  var checkStray = plan.needsMigration && newValueKeys.length > 0 && !plan.resumed;
  var addStray = function (iso, row, key, existing) {
    plan.strayCells.push({ isoDate: iso, rowNo: row.__rowNo, key: key, col: keys.indexOf(key) + 1, existing: existing });
  };
  // 一行：新欄逐格比對。`fill`＝空白格要不要回填（目標行與只有停用行那一行要，其餘行不填）。
  var reconcileRow = function (iso, row, fromLegacy, week, fill) {
    var wrote = false;
    valueKeys.forEach(function (key) {
      var isNewKey = newValueKeys.indexOf(key) !== -1;
      var cand = fill ? candidateFor(key, fromLegacy, week) : { value: '', source: '' };
      var existingIsDate = (row.__typeIssues || []).indexOf(key) !== -1;
      var existing = existingIsDate ? '' : migrationText_(row[key]);
      if (!existingIsDate && existing === '') {
        if (cand.value === '') return;
        plan.cellWrites.push({ isoDate: iso, rowNo: row.__rowNo, key: key, col: keys.indexOf(key) + 1, value: cand.value, source: cand.source });
        if (cand.source === 'WEEKS') plan.counts.weekCells++;
        else movedDates[cand.source][iso] = true;
        wrote = true;
        return;
      }
      if (!existingIsDate && existing === cand.value) return; // 中途失敗之後重跑：上一次已經寫好
      if (checkStray && isNewKey && !isMigratedRow(row)) {
        addStray(iso, row, key, existingIsDate ? '（被試算表轉成日期／時間）' : existing);
        return;
      }
      // 重跑（上一次已開始）時，新欄的來源之後變成空白亦要講出來（保留現值）。
      if (cand.value === '' && !(plan.resumed && isNewKey)) return;
      plan.conflicts.push({
        isoDate: iso, key: key, existing: existingIsDate ? '（被試算表轉成日期／時間）' : existing,
        candidate: cand.value, source: cand.source
      });
    });
    return wrote;
  };

  serviceDates.forEach(function (iso) {
    var fromLegacy = legacyByDate[iso] || {};
    var week = weekByDate[iso] || null;
    var target = targets[iso];
    var dateRows = rowsByDate[iso] || [];

    if (target) {
      if (!plan.needsMigration) return;
      reconcileRow(iso, target, fromLegacy, week, true);
      dateRows.forEach(function (row) { if (row !== target) reconcileRow(iso, row, {}, null, false); });
      return;
    }

    if (dateRows.length > 0) {
      // 那個主日只有已停用的行：幹事刻意停用，不替他另起一行（HH-13）。新欄同樣回填在最後一行停用行
      // ——停用行不匯入，沒有副作用；日後把它改回 TRUE，序樂、宣召等亦不會被清空（審查 A3）。
      if (!plan.needsMigration) return;
      var lastInactive = dateRows.slice().sort(function (a, b) { return a.__rowNo - b.__rowNo; })[dateRows.length - 1];
      var wroteInactive = reconcileRow(iso, lastInactive, fromLegacy, week, true);
      dateRows.forEach(function (row) { if (row !== lastInactive) reconcileRow(iso, row, {}, null, false); });
      if (wroteInactive) plan.counts.inactiveDates++;
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

  if (plan.strayCells.length > 0) {
    plan.ok = false;
    plan.reason = 'NEW_COLUMNS_NOT_EMPTY';
    plan.message = buildContentSheetStrayCellsMessage_(plan.strayCells);
  }

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
  return Boolean(plan && plan.ok
    && (plan.needsMigration || plan.appends.length > 0 || (plan.legacyToFinish || []).length > 0));
}

/**
 * 用途：欄號轉成試算表的欄名（1 → A、27 → AA）。純函式。
 * Args:
 *   col {number} 1 起算。
 * Returns:
 *   {string}
 * Raises:
 *   （無）
 */
function contentColumnLetter_(col) {
  var n = Math.floor(Number(col) || 0);
  var out = '';
  while (n > 0) {
    var r = (n - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/**
 * 用途：`NEW_COLUMNS_NOT_EMPTY` 的訊息：新欄位置原本已經有字，逐格列出（最多 10 格）。純函式。
 * Args:
 *   strayCells {{isoDate:string, rowNo:number, key:string, col:number, existing:string}[]}
 * Returns:
 *   {string}
 * Raises:
 *   （無）
 */
function buildContentSheetStrayCellsMessage_(strayCells) {
  var def = contentSheetWorshipTabDefV3_();
  var firstNew = legacyWorshipTabDefV1_().keys.length + 1;
  var lines = strayCells.slice(0, 10).map(function (c) {
    return '　' + contentColumnLetter_(c.col) + c.rowNo + '（' + c.isoDate + '，新欄「'
      + contentTabColumnLabel_(def.tabName, c.key, def) + '」的位置）：「' + c.existing + '」';
  });
  if (strayCells.length > 10) lines.push('　（另有 ' + (strayCells.length - 10) + ' 格未列出）');
  return '內容表「崇拜程序」第 ' + contentColumnLetter_(firstNew) + ' 至 ' + contentColumnLetter_(def.keys.length)
    + ' 欄是這一次要加的新欄，但以下 ' + strayCells.length + ' 格原本已經有字：\n' + lines.join('\n')
    + '\n如果照樣移轉，之後匯入會把這些字當成序樂、宣召或浸禮資料印在週報上，所以這次一格都沒有寫。'
    + '請把這些字搬到同一行的「備註」欄或者清走，再按一次「更新本季內容表…」。';
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
  var bases = legacyMergedTabDefs_().map(function (def) { return def.tabName + CONTENT_SHEET_RETIRED_TAB_SUFFIX_; })
    // v4（2026-10-30）：重新整理之前改了名保留的分頁。
    .concat([CONTENT_SHEET_V4_WORSHIP_RETIRED_BASE_, CONTENT_SHEET_V4_WORSHIP_RESHAPE_BASE_,
      CONTENT_SHEET_V4_ATTENDANCE_RESHAPE_BASE_]);
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
 *   {{retiredTabs:{from:string, to:string}[], finishedTabs:string[]}}
 * Raises:
 *   Error 任何一步失敗時原樣拋出（已寫的格保留；第 2 行未寫，下一次重跑只填仍然空白的格）。
 */
function applyContentSheetV2Migration_(spreadsheet, worshipSheet, plan, quarterId) {
  var keys = plan.keys;
  // 第一格寫入之前留記錄：之後中途失敗再重跑，planner 由這一行知道新欄位置的字是自己寫的（審查 A6）。
  if (plan.needsMigration && !plan.resumed) {
    appendAuditLog_({
      action: CONTENT_SHEET_MIGRATE_START_ACTION_, sheetName: SHEETS.CONTENT_SHEETS, rowKey: quarterId,
      field: String(spreadsheet.getId()),
      notes: '內容表 v2 移轉開始（已核對新欄位置原本沒有字）。之後的步驟各自另有記錄。'
    });
  }
  if (plan.needsMigration || plan.appends.length > 0) ensureContentTabColumns_(worshipSheet, keys.length);

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

  // 格子與新增行寫好之後即時記一筆（之後改名、隱藏失敗，這一筆仍然在；審查 B2-4）。
  if (plan.needsMigration || plan.appends.length > 0) appendAuditLog_({
    action: 'CONTENT_SHEET_MIGRATE_V2', sheetName: SHEETS.CONTENT_SHEETS, rowKey: quarterId, field: '崇拜程序',
    newValue: '欄 +' + plan.counts.newColumns + '；格 ' + plan.cellWrites.length + '；行 +' + plan.appends.length
      + '；兩邊不同 ' + plan.counts.conflicts,
    notes: plan.needsMigration
      ? ('內容表 v2 移轉：「崇拜程序」加 ' + plan.counts.newColumns + ' 欄，寫入 ' + plan.cellWrites.length
        + ' 格（其中由週報回填 ' + plan.counts.weekCells + ' 格），新增 ' + plan.appends.length + ' 行，'
        + plan.counts.conflicts + ' 格兩邊不同（保留崇拜程序的值）。'
        + (plan.resumed ? '上一次移轉中途停止，已經寫好的格這一次不再計算。' : ''))
      : ('「崇拜程序」為 ' + plan.appends.length + ' 個未有任何一行的主日預先開好一行，由週報帶入現有的值。')
  });

  // 3. 舊分頁改名、隱藏、註解、警告式保護。不刪。已改名但未做齊的，補做缺的那幾樣（審查 B2）。
  //    每一張做完即時記 AuditLog。
  var finishedTabs = [];
  (plan.legacyToFinish || []).forEach(function (l) {
    var sheet = spreadsheet.getSheetByName(l.sheetName);
    if (!sheet) return;
    ensureRetiredContentTabState_(sheet, l.state, CONTENT_SHEET_RETIRED_TAB_NOTE_, CONTENT_SHEET_RETIRED_TAB_PROTECTION_);
    finishedTabs.push(l.sheetName);
    appendAuditLog_({
      action: 'CONTENT_SHEET_MIGRATE_V2', sheetName: SHEETS.CONTENT_SHEETS, rowKey: quarterId, field: l.sheetName,
      newValue: retiredContentTabStepsText_(l.state),
      notes: '內容表 v2：已停用的舊分頁「' + l.sheetName + '」補做：' + retiredContentTabStepsText_(l.state) + '（資料不改、不刪）。'
    });
  });
  var retiredTabs = [];
  plan.legacyToRetire.forEach(function (l) {
    var sheet = spreadsheet.getSheetByName(l.sheetName);
    if (!sheet) return;
    var newName = uniqueRetiredContentTabName_(spreadsheet, l.sheetName);
    renameRetiredContentTab_(sheet, newName);
    retiredTabs.push({ from: l.sheetName, to: newName });
    // 改名一成功就記（之後隱藏、保護失敗，這一筆仍然在；下一次 legacyToFinish 補做並另記一筆）。
    appendAuditLog_({
      action: 'CONTENT_SHEET_MIGRATE_V2', sheetName: SHEETS.CONTENT_SHEETS, rowKey: quarterId, field: l.sheetName,
      oldValue: l.sheetName, newValue: newName,
      notes: '內容表 v2 移轉：舊分頁「' + l.sheetName + '」的資料已搬入「崇拜程序」（'
        + (l.kind === 'CALL' ? plan.counts.callDates : plan.counts.baptismDates) + ' 個主日'
        + (plan.resumed ? '，不計上一次已經寫好的格' : '') + '），分頁改名為「' + newName + '」，之後隱藏，沒有刪除。'
    });
    ensureRetiredContentTabState_(sheet,
      inspectRetiredContentTab_(sheet, CONTENT_SHEET_RETIRED_TAB_NOTE_, CONTENT_SHEET_RETIRED_TAB_PROTECTION_),
      CONTENT_SHEET_RETIRED_TAB_NOTE_, CONTENT_SHEET_RETIRED_TAB_PROTECTION_);
  });

  return { retiredTabs: retiredTabs, finishedTabs: finishedTabs };
}

/**
 * 用途：舊分頁補做的步驟名稱（「隱藏、A1 加註解、警告式保護」）。純函式。
 * Args:
 *   state {{needsHide:boolean, needsNote:boolean, needsProtect:boolean}}
 * Returns:
 *   {string}
 * Raises:
 *   （無）
 */
function retiredContentTabStepsText_(state) {
  var st = state || {};
  var steps = [];
  if (st.needsHide) steps.push('隱藏');
  if (st.needsNote) steps.push('A1 加註解');
  if (st.needsProtect) steps.push('警告式保護');
  return steps.join('、');
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
  (plan.legacyToFinish || []).forEach(function (l) {
    lines.push('已停用的舊分頁「' + l.sheetName + '」' + will + '補做：' + retiredContentTabStepsText_(l.state) + '（資料不改、不刪）。');
  });
  if (!plan.needsMigration) {
    if (plan.counts.appendedRows > 0) {
      lines.push('「崇拜程序」' + will + '為 ' + plan.counts.appendedRows + ' 個未有任何一行的主日預先開好一行，由週報帶入現有的值。');
    }
    return lines;
  }
  if (o.created) {
    lines.push('「崇拜程序」' + will + '預先開好 ' + plan.counts.appendedRows + ' 行（每個主日一行），由週報帶入現有的值。');
    return lines;
  }
  // v3：v2 → v3 只是在最後加「詩班項目名稱」一欄（浸禮六欄另由 buildContentSheetV3UpgradeLines_() 講）；
  //    v1 → v3 才有舊分頁要併入。浸禮合堂的資料改為搬入週報（見 src/ContentSheetMigrateV3.gs）。
  var mergingLegacy = plan.legacyToRetire.length > 0 || plan.counts.callDates > 0;
  if (mergingLegacy) {
    lines.push('內容表移轉成新版：「宣召」分頁併入「崇拜程序」（「浸禮合堂」的資料搬入週報，之後在填寫介面填）。');
  }
  if (plan.counts.newColumns > 0) {
    lines.push('　「崇拜程序」' + will + '在最後加 ' + plan.counts.newColumns + ' 欄（'
      + plan.newColumns.map(function (k) { return contentTabColumnLabel_('崇拜程序', k, contentSheetWorshipTabDefV3_()); }).join('、') + '）。');
  }
  if (mergingLegacy) {
    lines.push('　由舊「宣召」搬入 ' + plan.counts.callDates + ' 個主日。');
  }
  lines.push('　由週報回填 ' + plan.counts.weekCells + ' 格（只填空白格）。');
  if (plan.resumed) {
    lines.push('　（上一次移轉中途停止：上一次已經寫好的格不在以上數字之內，資料仍在；新欄位置與現在的來源不同的格，'
      + '列入下面「兩邊不同」，保留「崇拜程序」的值。）');
  }
  lines.push('　新增 ' + plan.counts.appendedRows + ' 行（這幾個主日「崇拜程序」未有任何一行，所有欄由週報帶齊）。');
  if (plan.counts.inactiveDates > 0) {
    lines.push('　' + plan.counts.inactiveDates + ' 個主日在「崇拜程序」只有已停用的行：不另開一行；新欄同樣填在最後一行'
      + '停用行（仍然停用，不會匯入；日後改回 TRUE 亦不會清空週報）。');
  }
  if (plan.counts.conflicts > 0) {
    lines.push('　⚠️ ' + plan.counts.conflicts + ' 格兩邊不同，保留「崇拜程序」的值：');
    plan.conflicts.slice(0, 10).forEach(function (c) {
      lines.push('　　' + c.isoDate + '「' + contentTabColumnLabel_('崇拜程序', c.key, contentSheetWorshipTabDefV3_()) + '」：崇拜程序「' + c.existing
        + '」，' + (c.source === 'CALL' ? '舊宣召' : (c.source === 'BAPTISM' ? '舊浸禮合堂' : '週報')) + '「' + (c.candidate || '（空白）') + '」');
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
