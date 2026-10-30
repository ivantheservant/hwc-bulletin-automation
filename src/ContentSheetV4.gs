/**
 * src/ContentSheetV4.gs
 *
 * 內容表 v4（2026-10-30，Ivan 示範之後的決定）。
 *
 *   1. 「崇拜程序」只留主日日期、讀經經文、證道講題、回應詩歌、備註；拿走「有效」。序樂、宣召出處、
 *      宣召經文、詩歌頌讚、詩班曲名、詩班項目名稱六欄搬回填寫介面填（v3 內容表這六欄的值先搬入週報）。
 *   2. 「崇拜程序」「崇拜人數」一個日期一行，由系統預先開好；日期欄與標題鎖住、不可以插入或刪除行
 *      （分頁保護，只有本系統的帳戶可以改結構）。匯入時同一個日期有兩行生效中就那一日不匯入並警告。
 *   3. 「家事報告」「代禱事項」把「連續到」搬到 B 欄、「有效」搬到 C 欄（搬欄，資料與格式跟住欄走）。
 *   4. 「家事報告」「代禱事項」「財政報告」每日清晨（每日觸發器，自動寄送前一小時）按主日日期、次序自動排列（次序留空排在有次序的後面）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 不刪資料
 * ─────────────────────────────────────────────────────────────────────
 *
 *   要重新整理的分頁（v3 的「崇拜程序」、形狀不對的「崇拜人數」）一律**改名保留**（隱藏、A1 註解、
 *   警告式保護），再建一張新的。新分頁每個日期的值取自舊分頁那一日最後一行生效中的資料；舊分頁其餘的行
 *   （停用的、重複的、季度以外的）不會搬，但留在改了名的舊分頁。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 次序（中途失敗可以重跑）
 * ─────────────────────────────────────────────────────────────────────
 *
 *   崇拜程序 v3 → v4：先寫週報（六欄），再改名舊分頁，最後建新分頁。改名之後失敗：重跑時「崇拜程序」不存在
 *   或者是未寫完的新分頁，而改了名的 v3 舊分頁仍然在，就由那一張再建一次（`V4_PENDING`）。週報那一步只寫
 *   不同的格，重跑結果一樣。重新整理（一個主日一行對不上）改名之後失敗亦一樣：新分頁空白而改了名的
 *   「…（整理前，已停用）」在，就由最新那一張再建一次（`RESHAPE_PENDING`；「崇拜人數」同理）。
 *
 *   新分頁一律先寫資料行，最後才寫第 1、2 行；資料行寫好而第 1、2 行未寫的分頁當作現行版面，套版面時補回。
 *
 *   預覽與執行用同一個 planner（bug class 120）。
 *
 * 分層：本檔案是業務邏輯；格子讀寫經 `src/ContentSheetIo.gs`；週報那一邊經 `applyWeekFieldChanges_()`（逐格 AuditLog）。
 */

'use strict';

/** v3「崇拜程序」改名之後的名稱（已經有同名分頁就加數字）。 */
var CONTENT_SHEET_V4_WORSHIP_RETIRED_BASE_ = '崇拜程序（舊版 v3，已停用）';

/** v4「崇拜程序」形狀不對（例如有人用本系統的帳戶插了行）要重建時，舊分頁改名用的名稱。 */
var CONTENT_SHEET_V4_WORSHIP_RESHAPE_BASE_ = '崇拜程序（整理前，已停用）';

/** 「崇拜人數」形狀不對要重建時，舊分頁改名用的名稱。 */
var CONTENT_SHEET_V4_ATTENDANCE_RESHAPE_BASE_ = '崇拜人數（整理前，已停用）';

/** 改了名的舊分頁 A1 註解。 */
var CONTENT_SHEET_V4_RETIRED_NOTE_ = '已停用（2026-10-30 起）：這是重新整理之前的分頁，資料保留作記錄，請不要再填這一張。'
  + '新的分頁一個日期一行，由系統預先開好。';

/** 改了名的舊分頁的保護說明（警告式保護）。 */
var CONTENT_SHEET_V4_RETIRED_PROTECTION_ = '週報系統：重新整理之前的舊分頁（已停用）';

/** 一個日期一行的分頁的保護說明（嚴格保護：只可以改值的欄）。 */
var CONTENT_SHEET_V4_LOCK_DESCRIPTION_ = '週報系統：日期欄與標題鎖住，只可以改值的欄（不可以插入或刪除行）';

/**
 * 用途：v3「崇拜程序」搬回填寫介面的六欄（v4 定義沒有、v3 定義有的值欄）。由兩份定義衍生，不另抄。
 * Args: （無）
 * Returns:
 *   {string[]}
 * Raises:
 *   （無）
 */
function contentSheetV4MovedWorshipKeys_() {
  var v4 = contentSheetWorshipTabDef_().keys;
  return contentSheetWorshipKeysV3_().filter(function (k) {
    return k !== 'SERVICE_DATE' && k !== 'ACTIVE' && k !== 'NOTES' && v4.indexOf(k) === -1;
  });
}

/**
 * 用途：這一季「崇拜人數」要預先開好的崇拜日期：每個主日減七天（第一期週報印的是上一季最後一個主日的人數；
 *   這一季最後一個主日的人數由下一季第一期印，所以不在這一季）。純函式。
 * Args:
 *   serviceDates {string[]} 這一季的主日，由舊到新。
 * Returns:
 *   {string[]}
 * Raises:
 *   （無）
 */
function contentSheetV4AttendanceDates_(serviceDates) {
  return (serviceDates || []).map(function (d) { return addDaysToIsoDate_(d, -7); });
}

/**
 * 用途：分頁名稱：`base`；已經有同名分頁就加數字（「…2」「…3」）。
 * Args:
 *   spreadsheet {Spreadsheet}　base {string}
 * Returns:
 *   {string}
 * Raises:
 *   Error 讀取失敗時原樣拋出。
 */
function uniqueContentTabName_(spreadsheet, base) {
  var name = base;
  var n = 2;
  while (spreadsheet.getSheetByName(name)) {
    name = base + n;
    n++;
  }
  return name;
}

/**
 * 用途：名稱以 `base` 開頭的分頁之中最新的一張（`uniqueContentTabName_()` 加的數字最大的一張）。唯讀。
 * Args:
 *   spreadsheet {Spreadsheet}　base {string}
 * Returns:
 *   {?Sheet} 沒有就是 `null`。
 * Raises:
 *   Error 讀取失敗時原樣拋出。
 */
function newestRetiredContentTab_(spreadsheet, base) {
  var best = null;
  var bestNo = 0;
  spreadsheet.getSheets().forEach(function (sheet) {
    var name = String(sheet.getName());
    if (name.indexOf(base) !== 0) return;
    var rest = name.slice(base.length);
    var no = rest === '' ? 1 : (/^\d+$/.test(rest) ? Number(rest) : 0);
    if (no > 0 && no >= bestNo) { best = sheet; bestNo = no; }
  });
  return best;
}

/**
 * 用途：第 1、2 行是空的分頁，下面有沒有資料（獨立審查 2026-10-30 第 6 項：以前當成新分頁，`clearContent()`
 *   就把資料清走）。唯讀。
 * Args:
 *   sheet {Sheet}　colCount {number} 分頁定義的欄數。
 * Returns:
 *   {{hasData:boolean, beyond:boolean}} `beyond`：定義的欄數以外（右邊）亦有字——欄的位置不明。
 * Raises:
 *   Error 讀取失敗時原樣拋出。
 */
function blankHeaderDataState_(sheet, colCount) {
  var width = Math.max(Number(colCount) || 0, Number(sheet.getLastColumn()) || 0);
  var rows = readContentTabDataValues_(sheet, width);
  var state = { hasData: false, beyond: false };
  rows.forEach(function (row) {
    row.forEach(function (v, i) {
      if (migrationText_(v) === '' && !(v instanceof Date)) return;
      if (i < colCount) state.hasData = true; else state.beyond = true;
    });
  });
  return state;
}

/**
 * 用途：認出「崇拜程序」現在是哪一版。唯讀。
 * Args:
 *   spreadsheet {Spreadsheet} 內容表。
 * Returns:
 *   {{layout:string, sheet:?Sheet, retiredSheet:?Sheet}}
 *     `layout`：`'NONE'`（沒有這張分頁，亦沒有改了名的 v3）／`'V4'`／`'V3'`／`'V4_PENDING'`（改了名的 v3 在，
 *     新分頁未有或者未寫好）／`'RESHAPE_PENDING'`（重新整理改了名的舊分頁在，新分頁未有或者未寫好）／
 *     `'LEGACY'`（v1、v2 或者認不出，交給原有的移轉判斷）／`'UNREADABLE'`（第 1、2 行
 *     空白而五欄以外亦有資料，欄的位置不明，整次不做）。
 *     `retiredSheet` 是改了名的 v3 舊分頁（最新一張），沒有就是 `null`；`reshapeSheet` 是重新整理改了名的
 *     舊分頁（最新一張）。
 * Raises:
 *   Error 讀取失敗時原樣拋出。
 */
function detectWorshipTabLayoutV4_(spreadsheet) {
  var def = contentSheetWorshipTabDef_();
  var v3Keys = contentSheetWorshipKeysV3_();
  var retiredSheet = newestRetiredContentTab_(spreadsheet, CONTENT_SHEET_V4_WORSHIP_RETIRED_BASE_);
  var reshapeSheet = newestRetiredContentTab_(spreadsheet, CONTENT_SHEET_V4_WORSHIP_RESHAPE_BASE_);
  // 新分頁未有或者一行都未寫：重新整理改了名的舊分頁在＝v4 早已完成、這一次是重新整理中途失敗（優先）；
  //    只有 v3 舊分頁在＝v3 轉 v4 中途失敗。
  function pending(s) {
    var layout = reshapeSheet ? 'RESHAPE_PENDING' : (retiredSheet ? 'V4_PENDING' : 'NONE');
    return { layout: layout, sheet: s, retiredSheet: retiredSheet, reshapeSheet: reshapeSheet };
  }
  var sheet = spreadsheet.getSheetByName(def.tabName);
  if (!sheet) return pending(null);

  var header = readContentTabHeaderKeys_(sheet, v3Keys.length);
  var isV3 = v3Keys.every(function (k, i) { return header[i] === k; });
  if (isV3) return { layout: 'V3', sheet: sheet, retiredSheet: retiredSheet };
  var isV4 = def.keys.every(function (k, i) { return header[i] === k; })
    && header.slice(def.keys.length).every(function (v) { return v === ''; });
  if (isV4) return { layout: 'V4', sheet: sheet, retiredSheet: retiredSheet };
  var blank = header.every(function (v) { return v === ''; });
  if (blank) {
    // 第 1、2 行空白而下面有資料：只在五欄之內的就當作 v4 的位置（系統寫 v4 分頁是先寫資料行、最後才寫第 1、2 行；
    //    有人清走第 1、2 行亦是 v4 的位置），套版面時補回第 1、2 行。五欄以外亦有字＝位置不明，整次不做。
    var state = blankHeaderDataState_(sheet, def.keys.length);
    if (state.beyond) return { layout: 'UNREADABLE', sheet: sheet, retiredSheet: retiredSheet };
    if (state.hasData) return { layout: 'V4', sheet: sheet, retiredSheet: retiredSheet, headerRestore: true };
    return pending(sheet);
  }
  return { layout: 'LEGACY', sheet: sheet, retiredSheet: retiredSheet };
}

/**
 * 用途：「崇拜程序」已經是 v3、這一次會轉成 v4 時，v2 移轉計畫不再為未有任何一行的主日開行——v4 會建一張新的
 *   分頁，每個主日一行；在 v3 分頁開行只會令改了名保留的舊分頁多了系統造的行。v1、v2 仍然要移轉的不變。純函式。
 * Args:
 *   plan {?Object} `planContentSheetV2Migration_()` 的輸出（會被改）。
 * Returns:
 *   {?Object} 同一個物件。
 * Raises:
 *   （無）
 */
function dropV3AppendsBeforeV4_(plan) {
  if (!plan || !plan.ok || plan.needsMigration) return plan;
  plan.appends = [];
  plan.counts.appendedRows = 0;
  return plan;
}

/**
 * 用途：讀 v4 整理要用的東西。唯讀。
 * Args:
 *   spreadsheet {Spreadsheet} 內容表。
 * Returns:
 *   {{worship:{layout:string, v3Rows:Object[], v4Rows:Object[]},
 *     attendance:{exists:boolean, headerOk:boolean, rows:Object[]},
 *     lists:{tabName:string, order:string}[], weeks:Object[]}}
 *     `lists[].order`：`'V4'`／`'V3'`（要搬欄）／`'UNKNOWN'`（交給匯入核對報錯）／`'MISSING'`。
 * Raises:
 *   Error 讀取失敗時原樣拋出。
 */
function readContentSheetV4Inputs_(spreadsheet) {
  var worshipDef = contentSheetWorshipTabDef_();
  var v3Keys = contentSheetWorshipKeysV3_();
  var detected = detectWorshipTabLayoutV4_(spreadsheet);
  var worship = { layout: detected.layout, v3Rows: [], v4Rows: [] };
  if (detected.layout === 'V3') {
    worship.v3Rows = parseContentTabRows_(readContentTabDataValues_(detected.sheet, v3Keys.length), v3Keys);
  } else if (detected.layout === 'V4_PENDING' && detected.retiredSheet) {
    worship.v3Rows = parseContentTabRows_(readContentTabDataValues_(detected.retiredSheet, v3Keys.length), v3Keys);
  } else if (detected.layout === 'RESHAPE_PENDING' && detected.reshapeSheet) {
    worship.v4Rows = parseContentTabRows_(readContentTabDataValues_(detected.reshapeSheet, worshipDef.keys.length), worshipDef.keys);
    worship.sourceName = String(detected.reshapeSheet.getName());
  } else if (detected.layout === 'V4') {
    worship.v4Rows = parseContentTabRows_(readContentTabDataValues_(detected.sheet, worshipDef.keys.length), worshipDef.keys);
  }

  var attendanceDef = contentSheetTabDefs_().filter(function (d) { return d.oneRowPerDate === true && d.tabName !== worshipDef.tabName; })[0];
  var attendance = { exists: false, headerOk: false, rows: [], tabName: attendanceDef.tabName };
  var attendanceSheet = spreadsheet.getSheetByName(attendanceDef.tabName);
  if (attendanceSheet) {
    attendance.exists = true;
    var aHeader = readContentTabHeaderKeys_(attendanceSheet, attendanceDef.keys.length);
    attendance.headerBlank = aHeader.every(function (v) { return v === ''; });
    attendance.headerOk = attendanceDef.keys.every(function (k, i) { return aHeader[i] === k; });
    if (attendance.headerBlank) {
      // 第 1、2 行空白而下面有資料：當作現行欄位位置（與「崇拜程序」同一個規則），不可以當成新分頁清走。
      var aState = blankHeaderDataState_(attendanceSheet, attendanceDef.keys.length);
      attendance.unreadable = aState.beyond;
      if (aState.hasData && !aState.beyond) { attendance.headerBlank = false; attendance.headerOk = true; }
    }
    // 已經鎖住＝v4 由系統建的分頁：行數不對（例如職事表加了主日）就自動重新整理，不用人手確認。
    attendance.locked = hasContentTabDateLock_(attendanceSheet);
    if (attendance.headerOk) {
      attendance.rows = parseContentTabRows_(readContentTabDataValues_(attendanceSheet, attendanceDef.keys.length), attendanceDef.keys);
    }
  }
  if (!attendanceSheet || (attendance.headerBlank === true && attendance.unreadable !== true)) {
    // 分頁未有或者一行都未寫，而重新整理改了名的舊分頁在＝上一次重新整理中途失敗：由最新那一張再建一次
    //（不可以當成新分頁開空白行，人數全部在舊分頁）。
    var attRetired = newestRetiredContentTab_(spreadsheet, CONTENT_SHEET_V4_ATTENDANCE_RESHAPE_BASE_);
    var retiredHeader = attRetired ? readContentTabHeaderKeys_(attRetired, attendanceDef.keys.length) : [];
    if (attRetired && attendanceDef.keys.every(function (k, i) { return retiredHeader[i] === k; })) {
      attendance.rows = parseContentTabRows_(readContentTabDataValues_(attRetired, attendanceDef.keys.length), attendanceDef.keys);
      attendance.sourceName = String(attRetired.getName());
    }
  }

  var lists = [];
  contentSheetTabDefs_().forEach(function (def) {
    var v3 = contentSheetListKeysV3_(def.tabName);
    if (!v3) return;
    var sheet = spreadsheet.getSheetByName(def.tabName);
    if (!sheet) { lists.push({ tabName: def.tabName, order: 'MISSING' }); return; }
    var header = readContentTabHeaderKeys_(sheet, def.keys.length);
    var order = def.keys.every(function (k, i) { return header[i] === k; }) ? 'V4'
      : (v3.every(function (k, i) { return header[i] === k; }) ? 'V3'
        : (header.every(function (v) { return v === ''; }) ? 'BLANK' : 'UNKNOWN'));
    // 第 1、2 行空白而下面有資料：v3 與 v4 的欄位次序不同，分不出是哪一個，不可以把 v4 的第 2 行蓋上去。
    if (order === 'BLANK' && blankHeaderDataState_(sheet, def.keys.length).hasData) order = 'UNKNOWN';
    lists.push({ tabName: def.tabName, order: order });
  });

  return {
    worship: worship, attendance: attendance, lists: lists, weeks: readRowsWithRowNo_(SHEETS.BULLETIN_WEEKS),
    retired: readRetiredContentTabsV4_(spreadsheet, detected.layout)
  };
}

/**
 * 用途：內容表內已改名停用的舊分頁，各自還缺哪幾樣（隱藏、A1 註解、警告式保護）。唯讀。
 *   有人把舊分頁取消隱藏、或者改名之後中途失敗，下一次按「更新本季內容表…」就補做（審查 B2，v4 沿用）。
 *   v1 併入的舊分頁（「宣召（已停用）」「浸禮合堂（已停用）」）只在「崇拜程序」已經不經 v2／v3 移轉時才在這裏看
 *   （`V4`／`V4_PENDING`／`NONE`）；要經 v2／v3 移轉的，由那邊的 `legacyToFinish` 補做，免得預覽講兩次。
 * Args:
 *   spreadsheet {Spreadsheet} 內容表。
 *   worshipLayout {string} `detectWorshipTabLayoutV4_()` 的 `layout`。
 * Returns:
 *   {{sheetName:string, note:string, protection:string, state:Object}[]}
 * Raises:
 *   Error 讀取失敗時原樣拋出。
 */
function readRetiredContentTabsV4_(spreadsheet, worshipLayout) {
  var groups = [{
    prefixes: [CONTENT_SHEET_V4_WORSHIP_RETIRED_BASE_, CONTENT_SHEET_V4_WORSHIP_RESHAPE_BASE_,
      CONTENT_SHEET_V4_ATTENDANCE_RESHAPE_BASE_],
    note: CONTENT_SHEET_V4_RETIRED_NOTE_, protection: CONTENT_SHEET_V4_RETIRED_PROTECTION_
  }];
  if (worshipLayout === 'V4' || worshipLayout === 'V4_PENDING' || worshipLayout === 'RESHAPE_PENDING' || worshipLayout === 'NONE') {
    groups.push({
      prefixes: legacyMergedTabDefs_().map(function (d) { return d.tabName + CONTENT_SHEET_RETIRED_TAB_SUFFIX_; }),
      note: CONTENT_SHEET_RETIRED_TAB_NOTE_, protection: CONTENT_SHEET_RETIRED_TAB_PROTECTION_
    });
  }
  var out = [];
  spreadsheet.getSheets().forEach(function (sheet) {
    var name = String(sheet.getName());
    groups.forEach(function (g) {
      var hit = g.prefixes.some(function (p) { return name.indexOf(p) === 0; });
      if (!hit) return;
      out.push({ sheetName: name, note: g.note, protection: g.protection,
        state: inspectRetiredContentTab_(sheet, g.note, g.protection) });
    });
  });
  return out;
}

/**
 * 用途：一張「一個日期一行」的分頁的資料行是不是剛好等於預期的日期（次序相同、沒有多、沒有少、沒有重複、
 *   沒有停用的行）。純函式。
 * Args:
 *   rows {Object[]} `parseContentTabRows_()` 的輸出。
 *   expectedDates {string[]}
 * Returns:
 *   {boolean}
 * Raises:
 *   （無）
 */
function isOneRowPerDateCanonical_(rows, expectedDates) {
  var list = rows || [];
  var expected = expectedDates || [];
  if (list.length !== expected.length) return false;
  for (var i = 0; i < list.length; i++) {
    if ((list[i].__typeIssues || []).indexOf('SERVICE_DATE') !== -1) return false;
    if (String(list[i].SERVICE_DATE || '').trim() !== expected[i]) return false;
    if (list[i].__active !== true) return false;
  }
  return true;
}

/**
 * 用途：v4 整理計畫。純函式；預覽與執行共用。
 * Args:
 *   input {{serviceDates:string[], created:boolean, worship:Object, attendance:Object, lists:Object[], weeks:Object[]}}
 *     後四樣見 `readContentSheetV4Inputs_()`；新建的內容表 `created:true`、`worship.layout:'NONE'`。
 * Returns:
 *   {{needsMigration:boolean,
 *     worship:{action:string, rows:Object[], weekWrites:Object[], conflicts:Object[], notCarried:Object[], fromRetired:boolean},
 *       `conflicts`：內容表與週報兩邊都有值而不同的格（保留週報，不寫），`{isoDate, field, weekValue, contentValue}`。
 *       `cellIssues`：舊分頁被試算表轉成日期／時間的格（讀不到原本的字），新分頁改用週報現有的值，
 *       `{tab, rowNo, isoDate, field, usedValue}`。
 *     attendance:{action:string, rows:Object[], notCarried:Object[], cellIssues:Object[], sourceName:string},
 *     reorder:string[], unknownLists:string[],
 *     counts:{worshipRows:number, weekCells:number, weekDates:number, attendanceRows:number, notCarried:number}}}
 *     `worship.action`：`''`（不用做）／`'FROM_V3'`（v3 轉 v4）／`'RESHAPE'`（v4 但形狀不對）／`'CREATE'`（新建）。
 *     `attendance.action`：`''`／`'RESHAPE'`／`'CREATE'`／`'HEADER_UNKNOWN'`（第 2 行認不出，不動）。
 *     `needsMigration`：要不要人手確認（v3 轉 v4、搬欄）。新建、形狀整理不算（自動流程照做）。
 * Raises:
 *   （無）
 */
function planContentSheetV4_(input) {
  var o = input || {};
  var serviceDates = (o.serviceDates || []).slice().sort();
  var worshipKeys = contentSheetWorshipTabDef_().keys;
  var worshipValueKeys = worshipKeys.filter(function (k) { return k !== 'SERVICE_DATE' && k !== 'NOTES'; });
  var movedKeys = contentSheetV4MovedWorshipKeys_();
  var plan = {
    needsMigration: false,
    worship: { action: '', rows: [], weekWrites: [], conflicts: [], notCarried: [], cellIssues: [], fromRetired: false },
    attendance: { action: '', rows: [], notCarried: [], cellIssues: [], sourceName: '' },
    reorder: [], unknownLists: [],
    // 認不出欄位位置的分頁（獨立審查 2026-10-30 第 1、6 項）：有任何一項就整次不做，一格都不寫。
    blockers: [],
    // 已改名停用、但隱藏／註解／保護未做齊的舊分頁（補做，不算移轉；自動流程照做）。
    retiredRepairs: (o.retired || []).filter(function (r) {
      return Boolean(r.state && (r.state.needsHide || r.state.needsNote || r.state.needsProtect));
    }),
    counts: { worshipRows: 0, weekCells: 0, weekDates: 0, attendanceRows: 0, notCarried: 0, cellIssues: 0 }
  };

  var weekByIso = {};
  (o.weeks || []).forEach(function (w) {
    var iso = w.SERVICE_DATE instanceof Date ? formatIsoDate_(w.SERVICE_DATE) : String(w.SERVICE_DATE || '').trim();
    if (iso) weekByIso[iso] = w;
  });
  var inQuarter = {};
  serviceDates.forEach(function (d) { inQuarter[d] = true; });

  // 被試算表轉成日期／時間的格：`parseContentTabRows_()` 已經讀成空字串，原本的字讀不到。新分頁改用週報現有的值
  //（沒有就留空）並列出來；以前當成空白搬，之後匯入就把週報那一格清空（獨立審查 2026-10-30 第 4 項）。
  function srcCell(src, k, fallback, issues, label, iso) {
    if ((src.__typeIssues || []).indexOf(k) === -1) return src[k] === undefined ? '' : src[k];
    issues.push({ tab: label, rowNo: src.__rowNo, isoDate: iso, field: k, usedValue: fallback });
    return fallback;
  }

  function notCarriedOf(rows, expected, lastByDate, label) {
    var wanted = {};
    expected.forEach(function (d) { wanted[d] = true; });
    var out = [];
    (rows || []).forEach(function (row) {
      var iso = String(row.SERVICE_DATE || '').trim();
      var reason = '';
      if ((row.__typeIssues || []).indexOf('SERVICE_DATE') !== -1) reason = '日期被試算表轉成日期格式';
      else if (row.__active !== true) reason = '已停用（有效＝FALSE）';
      else if (!iso) reason = '日期空白';
      else if (!wanted[iso]) reason = '不是這一季的日期';
      else if (lastByDate[iso] !== row) reason = '同一個日期較早的一行（以最後一行為準）';
      if (!reason) return;
      var hasValue = Object.keys(row).some(function (k) {
        return k.indexOf('__') !== 0 && k !== 'SERVICE_DATE' && k !== 'ACTIVE' && migrationText_(row[k]) !== '';
      });
      if (!hasValue && reason !== '已停用（有效＝FALSE）') return;
      out.push({ tab: label, rowNo: row.__rowNo, isoDate: iso, reason: reason });
    });
    return out;
  }

  // ---- 崇拜程序 ----
  var layout = (o.worship || {}).layout || 'NONE';
  var weekDates = {};
  if (layout === 'V3' || layout === 'V4_PENDING') {
    plan.worship.action = 'FROM_V3';
    plan.worship.fromRetired = layout === 'V4_PENDING';
    plan.needsMigration = true;
    var v3Rows = (o.worship.v3Rows || []).filter(function (r) { return (r.__typeIssues || []).indexOf('SERVICE_DATE') === -1; });
    var last = lastActiveRowByDate_(v3Rows);
    // 這一日在舊分頁有行、但全部停用（有效＝FALSE）：同工的意思是「這一日沒有內容」，新分頁留空，不可以改用週報
    //    現有的值（2026-10-30 2028T3：示範樣本設了 FALSE，轉換之後又由週報帶回新分頁）。
    var datesWithRows = {};
    v3Rows.forEach(function (r) { datesWithRows[String(r.SERVICE_DATE || '').trim()] = true; });
    serviceDates.forEach(function (iso) {
      var src = last[iso] || null;
      var week = weekByIso[iso] || null;
      var row = { SERVICE_DATE: iso };
      var onlyInactive = !src && datesWithRows[iso] === true;
      worshipValueKeys.forEach(function (k) {
        var fromWeek = (week && !onlyInactive) ? migrationText_(week[k]) : '';
        row[k] = src ? srcCell(src, k, fromWeek, plan.worship.cellIssues, '崇拜程序', iso) : fromWeek;
      });
      row.NOTES = src ? srcCell(src, 'NOTES', '', plan.worship.cellIssues, '崇拜程序', iso) : '';
      plan.worship.rows.push(row);
      if (!src || !week) return;
      movedKeys.forEach(function (k) {
        if ((src.__typeIssues || []).indexOf(k) !== -1) {
          plan.worship.cellIssues.push({ tab: '崇拜程序', rowNo: src.__rowNo, isoDate: iso, field: k, usedValue: migrationText_(week[k]) });
          return;
        }
        var v = migrationText_(src[k]);
        if (v === '') return;
        var current = migrationText_(week[k]);
        if (v === current) return;
        // 週報已經有另一個值（例如在填寫介面改過）：保留週報的值，只列出來（獨立審查 2026-10-30 第 2 項）。
        if (current !== '') {
          plan.worship.conflicts.push({ isoDate: iso, field: k, weekValue: current, contentValue: v });
          return;
        }
        plan.worship.weekWrites.push({ isoDate: iso, rowNo: week.__rowNo, field: k, oldValue: current, newValue: v });
        weekDates[iso] = true;
      });
    });
    plan.worship.notCarried = notCarriedOf(o.worship.v3Rows, serviceDates, last, '崇拜程序');
  } else if (layout === 'V4' || layout === 'RESHAPE_PENDING') {
    if (layout === 'RESHAPE_PENDING' || !isOneRowPerDateCanonical_(o.worship.v4Rows, serviceDates)) {
      plan.worship.action = 'RESHAPE';
      plan.worship.fromRetired = layout === 'RESHAPE_PENDING';
      plan.worship.sourceName = layout === 'RESHAPE_PENDING' ? String(o.worship.sourceName || '') : '';
      var v4Rows = (o.worship.v4Rows || []).filter(function (r) { return (r.__typeIssues || []).indexOf('SERVICE_DATE') === -1; });
      var lastV4 = lastActiveRowByDate_(v4Rows);
      serviceDates.forEach(function (iso) {
        var src = lastV4[iso] || null;
        var week = weekByIso[iso] || null;
        var row = { SERVICE_DATE: iso };
        worshipKeys.forEach(function (k) {
          if (k === 'SERVICE_DATE') return;
          var fromWeek = (k === 'NOTES' || !week) ? '' : migrationText_(week[k]);
          row[k] = src ? srcCell(src, k, fromWeek, plan.worship.cellIssues, '崇拜程序', iso) : fromWeek;
        });
        plan.worship.rows.push(row);
      });
      plan.worship.notCarried = notCarriedOf(o.worship.v4Rows, serviceDates, lastV4, '崇拜程序');
    }
  } else if (layout === 'NONE') {
    plan.worship.action = 'CREATE';
    serviceDates.forEach(function (iso) {
      var week = weekByIso[iso] || null;
      var row = { SERVICE_DATE: iso, NOTES: '' };
      worshipValueKeys.forEach(function (k) { row[k] = week ? migrationText_(week[k]) : ''; });
      plan.worship.rows.push(row);
    });
  }
  // layout 'LEGACY'：交給原有的 v2／v3 移轉；之後重新讀一次，再按 v3 轉 v4。

  // ---- 崇拜人數 ----
  var att = o.attendance || { exists: false, headerOk: false, rows: [] };
  var attendanceDates = contentSheetV4AttendanceDates_(serviceDates);
  var attendanceKeys = contentSheetTabDefs_().filter(function (d) { return d.tabName === att.tabName; })[0];
  attendanceKeys = attendanceKeys ? attendanceKeys.keys : [];
  if (!att.exists || att.headerBlank === true) {
    plan.attendance.action = 'CREATE';
    plan.attendance.sourceName = String(att.sourceName || '');
  } else if (!att.headerOk) {
    plan.attendance.action = 'HEADER_UNKNOWN';
  } else if (!isOneRowPerDateCanonical_(att.rows, attendanceDates)) {
    plan.attendance.action = 'RESHAPE';
    // 舊版（未鎖、人手開行）要人手確認；v4 鎖住的分頁只是主日有變，自動整理。
    if (att.rows.length > 0 && att.locked !== true) plan.needsMigration = true;
  }
  if (plan.attendance.action === 'CREATE' || plan.attendance.action === 'RESHAPE') {
    var aRows = (att.rows || []).filter(function (r) { return (r.__typeIssues || []).indexOf('SERVICE_DATE') === -1; });
    var lastAtt = lastActiveRowByDate_(aRows);
    attendanceDates.forEach(function (iso) {
      var src = lastAtt[iso] || null;
      // 崇拜日期 + 7 日＝印這一日人數的那一期週報。
      var printedIn = weekByIso[addDaysToIsoDate_(iso, 7)] || null;
      var row = { SERVICE_DATE: iso };
      attendanceKeys.forEach(function (k) {
        if (k === 'SERVICE_DATE') return;
        if (k === 'ACTIVE') { row[k] = 'TRUE'; return; }
        if (!src) { row[k] = ''; return; }
        row[k] = srcCell(src, k, printedIn ? migrationText_(printedIn[k]) : '', plan.attendance.cellIssues, att.tabName || '崇拜人數', iso);
      });
      plan.attendance.rows.push(row);
    });
    plan.attendance.notCarried = notCarriedOf(att.rows, attendanceDates, lastAtt, '崇拜人數');
  }

  // ---- 家事報告、代禱事項：搬欄 ----
  (o.lists || []).forEach(function (l) {
    if (l.order === 'V3') { plan.reorder.push(l.tabName); plan.needsMigration = true; }
    if (l.order === 'UNKNOWN') {
      plan.unknownLists.push(l.tabName);
      plan.blockers.push({ tabName: l.tabName, message: '「' + l.tabName + '」第 2 行（機器鍵）既不是舊版亦不是新版'
        + '（可能曾經插入、刪除或移動欄，或者第 1、2 行被清走）' });
    }
  });
  if (layout === 'UNREADABLE') {
    plan.blockers.push({ tabName: '崇拜程序', message: '「崇拜程序」第 1、2 行是空的，而第 F 欄以後亦有資料，系統不知道哪一欄是甚麼' });
  }
  if (att.unreadable === true) {
    plan.blockers.push({ tabName: att.tabName, message: '「' + att.tabName + '」第 1、2 行是空的，而定義的欄以外亦有資料，系統不知道哪一欄是甚麼' });
  }

  plan.counts.worshipRows = plan.worship.rows.length;
  plan.counts.weekCells = plan.worship.weekWrites.length;
  plan.counts.weekDates = Object.keys(weekDates).length;
  plan.counts.attendanceRows = plan.attendance.rows.length;
  plan.counts.notCarried = plan.worship.notCarried.length + plan.attendance.notCarried.length;
  plan.counts.cellIssues = plan.worship.cellIssues.length + plan.attendance.cellIssues.length;
  return plan;
}

/**
 * 用途：這一份 v4 計畫有沒有東西要做。純函式。
 * Args:
 *   plan {?Object} `planContentSheetV4_()` 的輸出。
 * Returns:
 *   {boolean}
 */
function contentSheetV4PlanHasWrites_(plan) {
  return Boolean(plan) && (Boolean(plan.worship.action) || plan.attendance.action === 'CREATE'
    || plan.attendance.action === 'RESHAPE' || plan.reorder.length > 0 || (plan.retiredRepairs || []).length > 0);
}

/**
 * 用途：把一張「一個日期一行」的分頁鎖住：整張分頁保護（只有本系統的帳戶可以改），只留值的欄（第 B 欄起、
 *   第 3 行起的資料行）給人改。已經有同一個說明的保護就先拿走再設（行數會變）。插入、刪除行亦因此做不到。
 * Args:
 *   sheet {Sheet} 分頁。
 *   colCount {number} 分頁定義的欄數。
 *   dataRows {number} 資料行數。
 * Returns:
 *   {{ok:boolean, message:string}} 鎖不到回 `ok:false`（寫 ErrorLog `CONTENT_SHEET_LOCK_FAILED`），不拋出。
 * Raises:
 *   （無）
 */
function ensureContentTabDateLock_(sheet, colCount, dataRows) {
  // ⚠️ 鎖不到不可以令整次「更新本季內容表」失敗（改名、建分頁已經做了；Shared Drive 的權限可能不准拿走編輯者）：
  //    分頁照樣是一個日期一行，只是同工仍然插得到行——匯入時重複的日期照樣會擋（不匯入並警告）。
  try {
    (sheet.getProtections(SpreadsheetApp.ProtectionType.SHEET) || []).forEach(function (p) {
      if (String(p.getDescription() || '') === CONTENT_SHEET_V4_LOCK_DESCRIPTION_) p.remove();
    });
    var protection = sheet.protect().setDescription(CONTENT_SHEET_V4_LOCK_DESCRIPTION_);
    if (colCount > 1 && dataRows > 0) {
      protection.setUnprotectedRanges([sheet.getRange(CONTENT_SHEET_FIRST_DATA_ROW_, 2, dataRows, colCount - 1)]);
    }
    // Apps Script 說明的做法：先把自己加為編輯者，再拿走其餘的人（自己拿不走）。
    var me = Session.getEffectiveUser();
    protection.addEditor(me);
    protection.removeEditors(protection.getEditors());
    if (protection.canDomainEdit()) protection.setDomainEdit(false);
    return { ok: true, message: '' };
  } catch (err) {
    var message = (err && err.message) ? err.message : String(err);
    appendErrorLog_({
      source: ERROR_LOG_SOURCE.SERVER, functionName: 'ensureContentTabDateLock_',
      errorCode: 'CONTENT_SHEET_LOCK_FAILED',
      message: '內容表「' + String(sheet.getName()) + '」的日期欄鎖不到：' + message,
      detail: buildErrorDetail_(err, { argsSummary: 'sheet=' + String(sheet.getName()) })
    });
    return { ok: false, message: message };
  }
}

/**
 * 用途：這張分頁有沒有 v4「一個日期一行」的鎖（`ensureContentTabDateLock_()` 設的那一個）。唯讀。
 * Args:
 *   sheet {Sheet}
 * Returns:
 *   {boolean}
 * Raises:
 *   Error 讀取失敗時原樣拋出。
 */
function hasContentTabDateLock_(sheet) {
  return (sheet.getProtections(SpreadsheetApp.ProtectionType.SHEET) || []).some(function (p) {
    return String(p.getDescription() || '') === CONTENT_SHEET_V4_LOCK_DESCRIPTION_;
  });
}

/**
 * 用途：舊分頁改名保留（隱藏、A1 註解、警告式保護），並記 AuditLog。
 * Args:
 *   spreadsheet {Spreadsheet}　sheet {Sheet}　base {string} 新名稱的開頭　quarterId {string}　what {string} 說明
 * Returns:
 *   {string} 新名稱。
 * Raises:
 *   Error 失敗時原樣拋出。
 */
function retireContentTabV4_(spreadsheet, sheet, base, quarterId, what) {
  var oldName = String(sheet.getName());
  var newName = uniqueContentTabName_(spreadsheet, base);
  renameRetiredContentTab_(sheet, newName);
  // 舊分頁本身可能有「一個日期一行」的嚴格保護：先拿走，改用警告式保護。
  (sheet.getProtections(SpreadsheetApp.ProtectionType.SHEET) || []).forEach(function (p) {
    if (String(p.getDescription() || '') === CONTENT_SHEET_V4_LOCK_DESCRIPTION_) p.remove();
  });
  ensureRetiredContentTabState_(sheet,
    inspectRetiredContentTab_(sheet, CONTENT_SHEET_V4_RETIRED_NOTE_, CONTENT_SHEET_V4_RETIRED_PROTECTION_),
    CONTENT_SHEET_V4_RETIRED_NOTE_, CONTENT_SHEET_V4_RETIRED_PROTECTION_);
  appendAuditLog_({
    action: 'CONTENT_SHEET_MIGRATE_V4', sheetName: SHEETS.CONTENT_SHEETS, rowKey: quarterId, field: oldName,
    oldValue: oldName, newValue: newName,
    notes: '內容表 v4：' + what + '舊分頁「' + oldName + '」改名「' + newName + '」，隱藏保留，不刪。'
  });
  return newName;
}

/**
 * 用途：建立（或清空重寫）一張「一個日期一行」的分頁：套版面、寫資料行、鎖日期欄。
 * Args:
 *   spreadsheet {Spreadsheet}　tabDef {Object} 分頁定義　rows {Object[]} 資料行（以機器鍵為 key）
 *   layoutOptions {Object} `applyContentTabLayout_()` 的 options。
 * Returns:
 *   {Sheet}
 * Raises:
 *   Error 失敗時原樣拋出。
 */
function writeOneRowPerDateTab_(spreadsheet, tabDef, rows, layoutOptions) {
  var sheet = ensureContentTab_(spreadsheet, tabDef.tabName).sheet;
  ensureContentTabColumns_(sheet, tabDef.keys.length);
  var lastRow = sheet.getLastRow();
  if (lastRow >= CONTENT_SHEET_FIRST_DATA_ROW_) {
    sheet.getRange(CONTENT_SHEET_FIRST_DATA_ROW_, 1, lastRow - CONTENT_SHEET_FIRST_DATA_ROW_ + 1, tabDef.keys.length).clearContent();
  }
  // ⚠️ 先寫資料行，**最後**才寫第 1、2 行（提交點，與 v2 移轉同一個規則）：中途失敗的話第 2 行仍然是空的，
  //    下一次判定為 V4_PENDING，由改了名的舊分頁再建一次；先寫第 2 行的話，下一次會當成已經是 v4 而由週報重建，
  //    舊分頁的值就帶不過來（獨立審查 2026-10-30 第 3 項）。
  if (rows.length > 0) {
    setContentRangePlainText_(sheet, CONTENT_SHEET_FIRST_DATA_ROW_, 1, rows.length, tabDef.keys.length);
    writeContentRows_(sheet, tabDef.keys, rows.map(function (r) {
      var out = {};
      tabDef.keys.forEach(function (k) {
        var v = r[k];
        out[k] = (v === null || v === undefined) ? '' : (v instanceof Date ? v : sanitizeCellText_(String(v)));
      });
      return out;
    }), CONTENT_SHEET_FIRST_DATA_ROW_);
  }
  applyContentTabLayout_(sheet, tabDef, layoutOptions);
  ensureContentTabDateLock_(sheet, tabDef.keys.length, rows.length);
  return sheet;
}

/**
 * 用途：把「家事報告」「代禱事項」由 v3 次序（主日日期、次序、內容、連續到、有效…）搬成 v4 次序
 *   （主日日期、連續到、有效、次序、內容…）。用整欄搬移：資料、格式、驗證、欄寬跟住欄走，一格都不用重寫。
 * Args:
 *   sheet {Sheet} 分頁（第 2 行已確認是 v3 次序）。
 * Returns:
 *   {void}
 * Raises:
 *   Error 搬欄失敗時原樣拋出。
 */
function reorderContentListTabV4_(sheet) {
  // v3：A 主日日期 B 次序 C 內容 D 連續到 E 有效 → 「連續到」「有效」兩欄**一次過**搬到 B 欄之前
  //    （A、D、E、B、C）。⚠️ 不可以分兩次搬：第二次失敗的話第 2 行既不是 v3 亦不是 v4，下一次刷新會把 v4 的
  //    機器鍵蓋上去，「內容」欄讀到的就是「有效」（獨立審查 2026-10-30 第 1 項）。
  sheet.moveColumns(sheet.getRange('D:E'), 2);
}

/**
 * 用途：執行 v4 整理計畫（不含排序，排序由 `sortContentListTabs_()` 做）。由 `buildOrRefreshContentSheet_()`
 *   在套版面之前呼叫（套版面會寫第 1、2 行）。
 * Args:
 *   spreadsheet {Spreadsheet}　plan {Object} `planContentSheetV4_()` 的輸出　quarterId {string}
 *   layoutOptions {Object} `applyContentTabLayout_()` 的 options。
 * Returns:
 *   {{weekCells:number, retired:string[], worshipRows:number, attendanceRows:number, reordered:string[],
 *     snapshotWarnings:string[]}}
 * Raises:
 *   Error 任何一步失敗時原樣拋出（已做的保留；重跑結果相同，見檔頭）。
 */
function applyContentSheetV4_(spreadsheet, plan, quarterId, layoutOptions) {
  var out = { weekCells: 0, retired: [], worshipRows: 0, attendanceRows: 0, reordered: [], snapshotWarnings: [],
    repaired: [] };
  var worshipDef = contentSheetWorshipTabDef_();

  // ---- 0. 已停用的舊分頁補做隱藏、註解、保護（資料不改）----
  (plan.retiredRepairs || []).forEach(function (r) {
    var sheet = spreadsheet.getSheetByName(r.sheetName);
    if (!sheet) return;
    ensureRetiredContentTabState_(sheet, r.state, r.note, r.protection);
    out.repaired.push(r.sheetName);
    appendAuditLog_({
      action: 'CONTENT_SHEET_MIGRATE_V4', sheetName: SHEETS.CONTENT_SHEETS, rowKey: quarterId, field: r.sheetName,
      newValue: retiredContentTabStepsText_(r.state),
      notes: '內容表：已停用的舊分頁「' + r.sheetName + '」補做：' + retiredContentTabStepsText_(r.state) + '（資料不改、不刪）。'
    });
  });

  // ---- 1. 崇拜程序六欄寫入週報（v3 轉 v4）----
  if (plan.worship.weekWrites.length > 0) {
    var dates = [];
    plan.worship.weekWrites.forEach(function (w) { if (dates.indexOf(w.isoDate) === -1) dates.push(w.isoDate); });
    out.snapshotWarnings = snapshotWeeksBeforeWrite_(dates, 'CONTENT_SHEET_UPGRADE');
    var auditEntries = [];
    dates.forEach(function (iso) {
      var changes = plan.worship.weekWrites.filter(function (w) { return w.isoDate === iso; });
      applyWeekFieldChanges_(changes[0].rowNo, changes.map(function (w) {
        return { field: w.field, oldValue: w.oldValue, newValue: w.newValue };
      }), iso, auditEntries, 'CONTENT_SHEET_UPGRADE_V4');
    });
    auditEntries.forEach(function (e) {
      appendAuditLog_(Object.assign({}, e, {
        notes: '內容表 v4：這一欄改為在填寫介面填，內容表的值搬入週報。季度 ' + quarterId + '。'
      }));
    });
    out.weekCells = auditEntries.length;
    touchWeeksLastSavedAt_(dates, new Date());
  }

  // ---- 2. 崇拜程序：舊分頁改名保留，建新分頁 ----
  if (plan.worship.action) {
    var current = spreadsheet.getSheetByName(worshipDef.tabName);
    if (current && plan.worship.action === 'FROM_V3' && !plan.worship.fromRetired) {
      out.retired.push(retireContentTabV4_(spreadsheet, current, CONTENT_SHEET_V4_WORSHIP_RETIRED_BASE_, quarterId,
        '「崇拜程序」只留讀經經文、證道講題、回應詩歌與備註，'));
    } else if (current && plan.worship.action === 'RESHAPE' && !plan.worship.fromRetired) {
      out.retired.push(retireContentTabV4_(spreadsheet, current, CONTENT_SHEET_V4_WORSHIP_RESHAPE_BASE_, quarterId,
        '「崇拜程序」要一個主日一行，'));
    }
    writeOneRowPerDateTab_(spreadsheet, worshipDef, plan.worship.rows, layoutOptions);
    out.worshipRows = plan.worship.rows.length;
  }

  // ---- 3. 崇拜人數 ----
  var attendanceDef = contentSheetTabDefs_().filter(function (d) { return d.oneRowPerDate === true && d.tabName !== worshipDef.tabName; })[0];
  if (plan.attendance.action === 'CREATE' || plan.attendance.action === 'RESHAPE') {
    var att = spreadsheet.getSheetByName(attendanceDef.tabName);
    if (att && plan.attendance.action === 'RESHAPE') {
      out.retired.push(retireContentTabV4_(spreadsheet, att, CONTENT_SHEET_V4_ATTENDANCE_RESHAPE_BASE_, quarterId,
        '「崇拜人數」要一個崇拜日期一行，'));
    }
    var attLayout = Object.assign({}, layoutOptions);
    writeOneRowPerDateTab_(spreadsheet, attendanceDef, plan.attendance.rows, attLayout);
    out.attendanceRows = plan.attendance.rows.length;
  }

  // ---- 4. 家事報告、代禱事項：搬欄 ----
  plan.reorder.forEach(function (tabName) {
    var sheet = spreadsheet.getSheetByName(tabName);
    if (!sheet) return;
    reorderContentListTabV4_(sheet);
    out.reordered.push(tabName);
    appendAuditLog_({
      action: 'CONTENT_SHEET_MIGRATE_V4', sheetName: SHEETS.CONTENT_SHEETS, rowKey: quarterId, field: tabName,
      newValue: '連續到 → B 欄、有效 → C 欄',
      notes: '內容表 v4：「' + tabName + '」把「連續到」搬到 B 欄、「有效」搬到 C 欄（整欄搬移，資料與格式不變）。'
    });
  });

  if (plan.worship.action || plan.attendance.action || plan.reorder.length > 0) {
    appendAuditLog_({
      action: 'CONTENT_SHEET_MIGRATE_V4', sheetName: SHEETS.CONTENT_SHEETS, rowKey: quarterId, field: '完成',
      newValue: '崇拜程序 ' + out.worshipRows + ' 行、崇拜人數 ' + out.attendanceRows + ' 行、週報 ' + out.weekCells + ' 格',
      notes: '內容表 v4 整理完成：' + (plan.worship.action || '崇拜程序不用改') + '／' + (plan.attendance.action || '崇拜人數不用改')
        + (out.reordered.length ? '／搬欄：' + out.reordered.join('、') : '') + '。'
    });
  }
  return out;
}

/**
 * 用途：v4 計畫的說明行（預覽與結果共用）。純函式。
 * Args:
 *   plan {?Object} `planContentSheetV4_()` 的輸出。
 *   options {{applied:boolean}=}
 * Returns:
 *   {string[]} 沒有東西要做時回空陣列。
 */
function buildContentSheetV4Lines_(plan, options) {
  if (!contentSheetV4PlanHasWrites_(plan)) return [];
  var done = Boolean(options && options.applied);
  var w = done ? '已' : '會';
  var lines = [];
  (plan.retiredRepairs || []).forEach(function (r) {
    lines.push('已停用的舊分頁「' + r.sheetName + '」' + w + '補做：' + retiredContentTabStepsText_(r.state) + '（資料不改、不刪）。');
  });
  var layoutChanged = Boolean(plan.worship.action) || plan.attendance.action === 'CREATE'
    || plan.attendance.action === 'RESHAPE' || plan.reorder.length > 0;
  if (!layoutChanged) return lines;
  if (lines.length > 0) lines.push('');
  lines.push('【內容表新版面（2026-10-30）】');
  if (plan.worship.action === 'FROM_V3') {
    lines.push('・「崇拜程序」' + w + '只留讀經經文、證道講題、回應詩歌與備註，一個主日一行（' + plan.counts.worshipRows
      + ' 行），日期欄鎖住、不可以插入行。');
    lines.push('・序樂、宣召出處、宣召經文、詩歌頌讚、詩班曲名、詩班項目名稱改在填寫介面填：內容表這六欄的值'
      + w + '先搬入週報（' + plan.counts.weekCells + ' 格，' + plan.counts.weekDates + ' 個主日）。');
    var conflicts = plan.worship.conflicts || [];
    if (conflicts.length > 0) {
      var v3Def = contentSheetWorshipTabDefV3_();
      lines.push('・以下 ' + conflicts.length + ' 格週報已經有另一個值（例如在填寫介面改過），' + w
        + '保留週報的值，內容表的值不搬；要用內容表的值，請之後在填寫介面改：');
      conflicts.slice(0, 10).forEach(function (c) {
        lines.push('　' + c.isoDate + '「' + contentTabColumnLabel_('崇拜程序', c.field, v3Def) + '」：週報「'
          + c.weekValue + '」，內容表「' + c.contentValue + '」');
      });
      if (conflicts.length > 10) lines.push('　（另有 ' + (conflicts.length - 10) + ' 格未列出）');
    }
    lines.push('・舊的「崇拜程序」' + w + '改名「' + CONTENT_SHEET_V4_WORSHIP_RETIRED_BASE_ + '」，隱藏保留，不刪。');
  } else if (plan.worship.action === 'RESHAPE' && plan.worship.fromRetired) {
    lines.push('・「崇拜程序」上一次重新整理未做完，' + w + '由「' + plan.worship.sourceName + '」再建一次（一個主日一行，'
      + plan.counts.worshipRows + ' 行）。');
  } else if (plan.worship.action === 'RESHAPE') {
    lines.push('・「崇拜程序」的行與這一季的主日對不上，' + w + '重新整理成一個主日一行（' + plan.counts.worshipRows
      + ' 行）；舊分頁' + w + '改名「' + CONTENT_SHEET_V4_WORSHIP_RESHAPE_BASE_ + '」保留。');
  } else if (plan.worship.action === 'CREATE') {
    lines.push('・「崇拜程序」' + w + '一個主日一行預先開好（' + plan.counts.worshipRows + ' 行），日期欄鎖住。');
  }
  if (plan.attendance.action === 'RESHAPE') {
    lines.push('・「崇拜人數」' + w + '整理成一個崇拜日期一行（' + plan.counts.attendanceRows + ' 行），日期欄鎖住、不可以插入行；'
      + '舊分頁' + w + '改名「' + CONTENT_SHEET_V4_ATTENDANCE_RESHAPE_BASE_ + '」保留。');
  } else if (plan.attendance.action === 'CREATE' && plan.attendance.sourceName) {
    lines.push('・「崇拜人數」上一次重新整理未做完，' + w + '由「' + plan.attendance.sourceName + '」再建一次（一個崇拜日期一行，'
      + plan.counts.attendanceRows + ' 行），日期欄鎖住。');
  } else if (plan.attendance.action === 'CREATE') {
    lines.push('・「崇拜人數」' + w + '一個崇拜日期一行預先開好（' + plan.counts.attendanceRows + ' 行），日期欄鎖住。');
  }
  plan.reorder.forEach(function (tabName) {
    lines.push('・「' + tabName + '」' + w + '把「連續到」搬到 B 欄、「有效」搬到 C 欄（整欄搬移，資料不變）。');
  });
  if (plan.counts.notCarried > 0) {
    lines.push('・以下 ' + plan.counts.notCarried + ' 行不會搬入新分頁（留在改了名的舊分頁）：');
    plan.worship.notCarried.concat(plan.attendance.notCarried).slice(0, 10).forEach(function (n) {
      lines.push('　' + n.tab + '第 ' + n.rowNo + ' 行（' + (n.isoDate || '沒有日期') + '）：' + n.reason);
    });
    if (plan.counts.notCarried > 10) lines.push('　（另有 ' + (plan.counts.notCarried - 10) + ' 行未列出）');
  }
  var cellIssues = (plan.worship.cellIssues || []).concat(plan.attendance.cellIssues || []);
  if (cellIssues.length > 0) {
    lines.push('・以下 ' + cellIssues.length + ' 格被試算表轉成日期／時間格式，讀不到原本的字：' + w
      + '一律改用週報現有的值（週報沒有就留空），原本的格留在改了名的舊分頁，請之後核對：');
    var worshipV3Def = contentSheetWorshipTabDefV3_();
    cellIssues.slice(0, 10).forEach(function (c) {
      var label = contentTabColumnLabel_(c.tab, c.field, c.tab === '崇拜程序' ? worshipV3Def : undefined);
      lines.push('　' + c.tab + '第 ' + c.rowNo + ' 行（' + c.isoDate + '）「' + label + '」'
        + (c.usedValue === '' ? '：留空' : '：用週報的「' + c.usedValue + '」'));
    });
    if (cellIssues.length > 10) lines.push('　（另有 ' + (cellIssues.length - 10) + ' 格未列出）');
  }
  return lines;
}

// =====================================================================
// 每日排序（家事報告、代禱事項、財政報告）
// =====================================================================

/**
 * 用途：算出一張清單分頁的資料行要排成的次序：主日日期由舊到新（空白排最後），同一日按「次序」
 *   （留空排在有次序的後面，見 `compareContentRowsBySeq_()`），其餘按原本的行號。純函式。
 * Args:
 *   rows {Object[]} `parseContentTabRows_()` 的輸出（帶 `__rowNo`）。
 * Returns:
 *   {{order:number[], sorted:boolean}} `order` 是排好之後每一個位置原本的行號；`sorted` 是不是已經排好。
 * Raises:
 *   （無）
 */
function planContentListSort_(rows) {
  var list = (rows || []).slice();
  function dateKey(r) {
    if ((r.__typeIssues || []).indexOf('SERVICE_DATE') !== -1) return '';
    return String(r.SERVICE_DATE || '').trim();
  }
  list.sort(function (a, b) {
    var da = dateKey(a);
    var db = dateKey(b);
    if (da !== db) {
      if (da === '') return 1;
      if (db === '') return -1;
      return da < db ? -1 : 1;
    }
    return compareContentRowsBySeq_(a, b);
  });
  var order = list.map(function (r) { return r.__rowNo; });
  var sorted = order.every(function (rowNo, i) { return i === 0 || rowNo > order[i - 1]; });
  return { order: order, sorted: sorted };
}

/**
 * 用途：把一張清單分頁按 `planContentListSort_()` 排好。用試算表本身的排序（整行連格式一齊搬）：先在最右邊
 *   一欄寫入每一行的排名，按那一欄排，再清走那一欄——試算表的多欄排序不保證「同值保持原次序」，所以不直接
 *   按日期、次序排。已經排好就一格都不寫。
 * Args:
 *   sheet {Sheet}　tabDef {Object}
 * Returns:
 *   {boolean} 有沒有排過。
 * Raises:
 *   Error 失敗時原樣拋出。
 */
function sortContentListTab_(sheet, tabDef) {
  var rows = parseContentTabRows_(readContentTabDataValues_(sheet, tabDef.keys.length), tabDef.keys)
    .filter(function (r) {
      return tabDef.keys.some(function (k) { return migrationText_(r[k]) !== '' || r[k] instanceof Date; });
    });
  if (rows.length < 2) return false;
  var sortPlan = planContentListSort_(rows);
  if (sortPlan.sorted) return false;
  var lastRow = sheet.getLastRow();
  var numRows = lastRow - CONTENT_SHEET_FIRST_DATA_ROW_ + 1;
  var keyCol = Math.max(sheet.getLastColumn(), tabDef.keys.length) + 1;
  ensureContentTabColumns_(sheet, keyCol);
  var rankByRow = {};
  sortPlan.order.forEach(function (rowNo, i) { rankByRow[rowNo] = i + 1; });
  var ranks = [];
  for (var r = 0; r < numRows; r++) {
    var rowNo = CONTENT_SHEET_FIRST_DATA_ROW_ + r;
    ranks.push([rankByRow[rowNo] !== undefined ? rankByRow[rowNo] : sortPlan.order.length + 1 + r]);
  }
  var keyRange = sheet.getRange(CONTENT_SHEET_FIRST_DATA_ROW_, keyCol, numRows, 1);
  keyRange.setValues(ranks);
  try {
    sheet.getRange(CONTENT_SHEET_FIRST_DATA_ROW_, 1, numRows, keyCol).sort({ column: keyCol, ascending: true });
  } finally {
    keyRange.clearContent();
  }
  return true;
}

/**
 * 用途：排好一份內容表內有 `nightlySort` 的分頁（家事報告、代禱事項、財政報告）。第 2 行與定義不符的分頁不排
 *   （那一種匯入會報錯，要人手處理）。
 * Args:
 *   spreadsheet {Spreadsheet}
 * Returns:
 *   {string[]} 排過的分頁。
 * Raises:
 *   Error 失敗時原樣拋出。
 */
function sortContentListTabs_(spreadsheet) {
  var sortedTabs = [];
  contentSheetTabDefs_().forEach(function (tabDef) {
    if (tabDef.nightlySort !== true) return;
    var sheet = spreadsheet.getSheetByName(tabDef.tabName);
    if (!sheet) return;
    var header = readContentTabHeaderKeys_(sheet, tabDef.keys.length);
    if (!tabDef.keys.every(function (k, i) { return header[i] === k; })) return;
    if (sortContentListTab_(sheet, tabDef)) sortedTabs.push(tabDef.tabName);
  });
  return sortedTabs;
}

/**
 * 用途：每日排序：所有生效中的內容表（沙盒季度除外）。由每日觸發器（`dailyQuarterAutoCreateTrigger_()`）叫。
 *   每一份各自包 try/catch，失敗記 ErrorLog；整段在指令碼鎖之內（與匯入、建立／刷新內容表互相排隊）。
 * Args:
 *   options {{source:string=}=}
 * Returns:
 *   {{quarterId:string, sorted:string[], error:string}[]}
 * Raises:
 *   （無）
 */
function runNightlyContentSort_(options) {
  var out = [];
  var sandbox = String(getConfig_(CONFIG_KEYS.SELFTEST_QUARTER_ID, '') || '').trim();
  readSheet_(SHEETS.CONTENT_SHEETS).forEach(function (row) {
    if (row.ACTIVE !== true) return;
    var qid = String(row.QUARTER_ID || '').trim();
    if (!qid || qid === sandbox) return;
    var entry = { quarterId: qid, sorted: [], error: '' };
    out.push(entry);
    try {
      var spreadsheet = openContentSpreadsheet_(row.FILE_ID);
      if (!spreadsheet) { entry.error = 'FILE_MISSING'; return; }
      entry.sorted = withScriptLock_('runNightlyContentSort_', 30000, function () {
        return sortContentListTabs_(spreadsheet);
      }, function () {
        var lockErr = new Error('每日排序內容表：30 秒內拿不到指令碼鎖。');
        lockErr.code = 'LOCK_TIMEOUT';
        throw lockErr;
      });
      if (entry.sorted.length > 0) {
        appendAuditLog_({
          action: 'CONTENT_SHEET_NIGHTLY_SORT', sheetName: SHEETS.CONTENT_SHEETS, rowKey: qid,
          newValue: entry.sorted.join('、'),
          notes: '每日排序（' + String((options && options.source) || '') + '）：按主日日期、次序排好「'
            + entry.sorted.join('」「') + '」。'
        });
      }
    } catch (err) {
      entry.error = (err && err.message) ? err.message : String(err);
      appendErrorLog_({
        source: ERROR_LOG_SOURCE.TRIGGER, functionName: 'runNightlyContentSort_',
        errorCode: (err && err.code) || 'ERROR',
        message: '每日排序內容表（季度 ' + qid + '）失敗：' + entry.error,
        detail: buildErrorDetail_(err, { argsSummary: 'quarterId=' + qid })
      });
    }
  });
  return out;
}

/**
 * 用途：v4 計畫有認不出的分頁時，整次拒絕的訊息。純函式。
 * Args:
 *   plan {?Object} `planContentSheetV4_()` 的輸出。
 * Returns:
 *   {string} 沒有就是空字串。
 */
function contentSheetV4BlockerMessage_(plan) {
  var blockers = (plan && plan.blockers) || [];
  if (blockers.length === 0) return '';
  return blockers.map(function (b) { return b.message; }).join('；') + '。所以這次一格都沒有寫（寫了會把資料放錯欄）。'
    + '請用「檔案 ▸ 版本記錄」把那張分頁的第 1、2 行與欄位次序還原，再按一次「更新本季內容表…」。';
}
