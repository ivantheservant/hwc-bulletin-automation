/**
 * RosterRead.gs
 *
 * 職事表唯讀介面。這是全 repo **唯一**可以出現 `openById(` 的檔案
 * （見 tools/lint-readonly-roster.js）。硬規則：對職事表試算表一律唯讀，
 * 一個格都不可以寫——本檔案只准出現讀取方法（`getDataRange()`／
 * `getValues()`／`getSheetByName()` 之類），不准出現任何寫入方法。
 *
 * 分成三層，缺一不可（見 docs/職事表唯讀介面.md）：
 *   1. IO 層　fetchRosterTables_(spreadsheetId, sheetNames)
 *      唯一會碰 SpreadsheetApp 的地方，只做結構性讀取＋型別正規化，
 *      不做任何業務判斷（不比對日期、不篩選版本、不解析特別主日）。
 *   2. 純函式層　buildRosterSnapshot_(tables, isoDate)
 *      完全不碰 Apps Script 服務，輸入是 IO 層的回傳值，做全部業務判斷，
 *      輸出快照物件。可以在 Node 用假資料直接測試。
 *   3. 真正入口　readRosterSnapshot_(isoDate)
 *      先讀 Config、視需要呼叫 IO 層（同一次執行內 memoize），再呼叫
 *      純函式層。
 */

'use strict';

// =====================================================================
// 職事表工作表結構（照抄自職事表的 src/Constants.gs，不要自己猜）
// =====================================================================

/**
 * 職事表七張工作表的結構定義：
 *   label          人看的表名，用於錯誤訊息。
 *   configKeyName  對應哪一個 CONFIG_KEYS，錯誤訊息要講得出「改哪個設定」。
 *   columns        機器鍵 → 型別（COLUMN_TYPES 的其中一個值）。只列出本輪
 *                  真正需要讀取的欄位——尤其 NAME_MAPPING 刻意只列 3 欄，
 *                  Email／Phone／PersonalLinkToken 等敏感欄位一律不讀進
 *                  記憶體（硬規則）。SpecialSundays 這張表已知會有其他
 *                  後加欄位，讀取邏輯用「機器鍵對照欄位位置」而不是「照
 *                  固定欄數讀」，所以多出來的欄不會造成任何問題。
 */
var ROSTER_TABLE_DEFS_ = Object.freeze({
  ASSIGNMENTS: {
    label: 'RosterAssignments',
    configKeyName: 'ROSTER_SHEET_ASSIGNMENTS',
    columns: {
      AssignmentID: 'TEXT', QuarterID: 'TEXT', VersionNo: 'INT', ServiceDateID: 'TEXT',
      ServiceDate: 'DATE', PostID: 'TEXT', SlotIndex: 'INT', PersonID: 'TEXT',
      PersonNameSnapshot: 'TEXT', AssignSource: 'TEXT', RuleFlags: 'TEXT',
      Locked: 'BOOLEAN', UpdatedAt: 'DATE', UpdatedBy: 'TEXT'
    }
  },
  VERSIONS: {
    label: 'RosterVersions',
    configKeyName: 'ROSTER_SHEET_VERSIONS',
    columns: {
      VersionID: 'TEXT', QuarterID: 'TEXT', VersionNo: 'INT', SheetName: 'TEXT',
      Basis: 'TEXT', ParentVersionNo: 'INT', Status: 'TEXT', Protected: 'BOOLEAN',
      WarningCount: 'INT', CreatedAt: 'DATE', CreatedBy: 'TEXT', Notes: 'TEXT'
    }
  },
  QUARTERS: {
    label: 'Quarters',
    configKeyName: 'ROSTER_SHEET_QUARTERS',
    columns: {
      QuarterID: 'TEXT', Year: 'INT', Term: 'TEXT', StartDate: 'DATE', EndDate: 'DATE',
      WeekCount: 'INT', GenerateOn: 'DATE', OfficialSendOn: 'DATE', Status: 'TEXT',
      Notes: 'TEXT', Stage: 'TEXT', StageUpdatedAt: 'DATE'
    }
  },
  SERVICE_DATES: {
    label: 'ServiceDates',
    configKeyName: 'ROSTER_SHEET_SERVICE_DATES',
    columns: {
      ServiceDateID: 'TEXT', QuarterID: 'TEXT', ServiceDate: 'DATE', WeekIndex: 'INT',
      IsFirstSundayOfMonth: 'BOOLEAN', ServiceType: 'TEXT', SpecialID: 'TEXT',
      AutoGenerate: 'BOOLEAN', Notes: 'TEXT'
    }
  },
  SPECIAL_SUNDAYS: {
    label: 'SpecialSundays',
    configKeyName: 'ROSTER_SHEET_SPECIAL_SUNDAYS',
    columns: {
      SpecialID: 'TEXT', QuarterID: 'TEXT', ServiceDate: 'DATE', Type: 'TEXT', Title: 'TEXT',
      SkipPostIDs: 'TEXT', LockPostIDs: 'TEXT', ExternalOwner: 'TEXT',
      CommunionOverride: 'TEXT', TranslationRequired: 'BOOLEAN', Active: 'BOOLEAN', Notes: 'TEXT'
    }
  },
  NAME_MAPPING: {
    label: 'NameMapping',
    configKeyName: 'ROSTER_SHEET_NAME_MAPPING',
    columns: {
      // ⚠️ 刻意只列 3 欄——見上面檔案層級註解的說明。
      PersonID: 'TEXT', NameTC: 'TEXT', Active: 'BOOLEAN'
    }
  },
  POSTS: {
    label: 'Posts',
    configKeyName: 'ROSTER_SHEET_POSTS',
    columns: {
      PostID: 'TEXT', PostName_TC: 'TEXT', PostName_EN: 'TEXT', SlotCount: 'INT',
      DistinctWithinPost: 'BOOLEAN', Category: 'TEXT', Frequency: 'TEXT',
      AutoGenerate: 'BOOLEAN', AllowConsecutive: 'BOOLEAN', MutexGroup: 'TEXT',
      DisplayOrder: 'INT', Active: 'BOOLEAN', Notes: 'TEXT', EmptyDisplay: 'TEXT',
      EarlyArrivalMinutes: 'INT', RequiredRoles: 'TEXT'
    }
  }
});

/** PersonNameSnapshot 的已知佔位符——代表「尚未排到實際人選」，不是真人姓名。 */
var ROSTER_PERSON_PLACEHOLDER_SNAPSHOTS_ = ['—', '待確認', '⚠ 未能安排'];

// =====================================================================
// 真正入口
// =====================================================================

/** 同一次執行內的職事表資料快取（memoize）。見 fetchRosterTablesCached_()。 */
var ROSTER_TABLES_CACHE_ = null;
var ROSTER_TABLES_CACHE_KEY_ = null;

/**
 * 用途：按一個主日日期，從職事表試算表取得該主日的事奉名單與特別主日
 *   資訊。這是本檔案的真正入口：先讀 Config，再視需要呼叫 IO 層（同一次
 *   執行內會 memoize，重複呼叫不會重新讀試算表），最後呼叫純函式層組出
 *   快照物件。
 * Args:
 *   isoDate {string} 主日日期，yyyy-MM-dd 格式。
 * Returns:
 *   {Object} 快照物件，形狀見 docs/職事表唯讀介面.md。`ROSTER_SPREADSHEET_ID`
 *     未設定時，回傳 `{ ok:false, notConfigured:true, ... }`，不拋錯。
 * Raises:
 *   Error 如果 `openById()` 失敗、任何一張工作表不存在、或工作表第 2 行
 *     缺少預期的機器鍵（見 fetchRosterTables_()／readRosterTable_()）。
 */
function readRosterSnapshot_(isoDate) {
  var spreadsheetId = getConfig(CONFIG_KEYS.ROSTER_SPREADSHEET_ID, '');
  if (!spreadsheetId) {
    return emptyRosterSnapshot_(isoDate, { ok: false, notConfigured: true });
  }

  var tables = fetchRosterTablesCached_(spreadsheetId, buildRosterSheetNames_());
  return buildRosterSnapshot_(tables, isoDate);
}

/**
 * 用途：列出指定季度的全部主日日期，按日期由小到大排序。跟
 *   readRosterSnapshot_() 共用同一份 memoized 資料，供選單「測試讀取
 *   職事表（全季）」使用。
 * Args:
 *   quarterId {string} 季度 ID（例如 '2027T4'）。
 * Returns:
 *   {string[]} yyyy-MM-dd 字串陣列。
 * Raises:
 *   Error 如果 `ROSTER_SPREADSHEET_ID` 未設定，或底層讀取失敗
 *     （見 fetchRosterTables_()）。
 */
function listRosterServiceDatesForQuarter_(quarterId) {
  var spreadsheetId = getConfig(CONFIG_KEYS.ROSTER_SPREADSHEET_ID, '');
  if (!spreadsheetId) {
    throw new Error('listRosterServiceDatesForQuarter_：Config 的 ROSTER_SPREADSHEET_ID 未設定。');
  }

  var tables = fetchRosterTablesCached_(spreadsheetId, buildRosterSheetNames_());
  return tables.serviceDates
    .filter(function (r) { return r.QuarterID === quarterId; })
    .map(function (r) { return r.ServiceDate; })
    .filter(function (d) { return d instanceof Date; })
    .sort(function (a, b) { return a.getTime() - b.getTime(); })
    .map(function (d) { return formatIsoDate_(d); });
}

/**
 * 用途：組出一個「未設定／查無資料」情況下形狀完整的快照物件——所有欄位
 *   都在，只是值為 null／空陣列，方便呼叫端不用逐層防呆就能顯示摘要。
 * Args:
 *   isoDate {string} 主日日期。
 *   overrides {Object} 要覆寫的欄位（例如 `{ ok:false, notConfigured:true }`）。
 * Returns:
 *   {Object}
 */
function emptyRosterSnapshot_(isoDate, overrides) {
  var base = {
    ok: true,
    notConfigured: false,
    found: false,
    isoDate: isoDate,
    weekOfMonth: null,
    quarterId: null,
    quarterStage: null,
    isOfficial: false,
    versionNo: null,
    serviceDate: null,
    special: null,
    assignments: [],
    posts: [],
    warnings: []
  };
  return Object.assign(base, overrides || {});
}

/**
 * 用途：從 Config 組出職事表七張工作表的實際名稱。
 * Args: （無）
 * Returns:
 *   {{ASSIGNMENTS:string, VERSIONS:string, QUARTERS:string, SERVICE_DATES:string,
 *     SPECIAL_SUNDAYS:string, NAME_MAPPING:string, POSTS:string}}
 */
function buildRosterSheetNames_() {
  return {
    ASSIGNMENTS: getConfig(CONFIG_KEYS.ROSTER_SHEET_ASSIGNMENTS, 'RosterAssignments'),
    VERSIONS: getConfig(CONFIG_KEYS.ROSTER_SHEET_VERSIONS, 'RosterVersions'),
    QUARTERS: getConfig(CONFIG_KEYS.ROSTER_SHEET_QUARTERS, 'Quarters'),
    SERVICE_DATES: getConfig(CONFIG_KEYS.ROSTER_SHEET_SERVICE_DATES, 'ServiceDates'),
    SPECIAL_SUNDAYS: getConfig(CONFIG_KEYS.ROSTER_SHEET_SPECIAL_SUNDAYS, 'SpecialSundays'),
    NAME_MAPPING: getConfig(CONFIG_KEYS.ROSTER_SHEET_NAME_MAPPING, 'NameMapping'),
    POSTS: getConfig(CONFIG_KEYS.ROSTER_SHEET_POSTS, 'Posts')
  };
}

/**
 * 用途：fetchRosterTables_() 的 memoize 包裝——同一次執行內，同樣的
 *   spreadsheetId／sheetNames 組合只會真正讀一次試算表。
 * Args:
 *   spreadsheetId {string} 職事表試算表 ID。
 *   sheetNames {Object} buildRosterSheetNames_() 的回傳值。
 * Returns:
 *   {Object} 同 fetchRosterTables_() 的回傳值。
 */
function fetchRosterTablesCached_(spreadsheetId, sheetNames) {
  var cacheKey = spreadsheetId + '|' + JSON.stringify(sheetNames);
  if (ROSTER_TABLES_CACHE_ && ROSTER_TABLES_CACHE_KEY_ === cacheKey) {
    return ROSTER_TABLES_CACHE_;
  }
  var tables = fetchRosterTables_(spreadsheetId, sheetNames);
  ROSTER_TABLES_CACHE_ = tables;
  ROSTER_TABLES_CACHE_KEY_ = cacheKey;
  return tables;
}

// =====================================================================
// IO 層——唯一會碰 SpreadsheetApp 的地方
// =====================================================================

/**
 * 用途：一次過把職事表七張工作表讀成純陣列物件並回傳，不做任何業務判斷
 *   （不比對日期、不篩選版本、不解析特別主日、不查姓名對照）。每張表只
 *   讀一次（`getDataRange` 等級的單次範圍讀取），不會針對個別崗位或個別
 *   主日重覆開表。
 * Args:
 *   spreadsheetId {string} 職事表試算表 ID。
 *   sheetNames {Object} buildRosterSheetNames_() 的回傳值，七個工作表的
 *     實際名稱。
 * Returns:
 *   {{assignments:Object[], versions:Object[], quarters:Object[],
 *     serviceDates:Object[], specialSundays:Object[], nameMapping:Object[],
 *     posts:Object[]}} 每個陣列元素是以職事表機器鍵為 key 的物件，已依
 *     ROSTER_TABLE_DEFS_ 宣告的型別正規化。
 * Raises:
 *   Error 如果 `openById()` 失敗（訊息只含 ID 前 8 個字元＋省略號，不印
 *     完整 ID），或任何一張工作表不存在，或第 2 行缺少預期的機器鍵。
 */
function fetchRosterTables_(spreadsheetId, sheetNames) {
  var ss;
  try {
    ss = SpreadsheetApp.openById(spreadsheetId);
  } catch (err) {
    var idPrefix = String(spreadsheetId || '').slice(0, 8) + '…';
    throw new Error(
      '無法開啟職事表試算表（ID 開頭：' + idPrefix + '）：'
      + (err && err.message ? err.message : String(err))
      + '。請檢查 Config 的 ROSTER_SPREADSHEET_ID，以及本帳戶是否有該檔案的檢視權限。'
    );
  }

  return {
    assignments: readRosterTable_(ss, ROSTER_TABLE_DEFS_.ASSIGNMENTS, sheetNames.ASSIGNMENTS),
    versions: readRosterTable_(ss, ROSTER_TABLE_DEFS_.VERSIONS, sheetNames.VERSIONS),
    quarters: readRosterTable_(ss, ROSTER_TABLE_DEFS_.QUARTERS, sheetNames.QUARTERS),
    serviceDates: readRosterTable_(ss, ROSTER_TABLE_DEFS_.SERVICE_DATES, sheetNames.SERVICE_DATES),
    specialSundays: readRosterTable_(ss, ROSTER_TABLE_DEFS_.SPECIAL_SUNDAYS, sheetNames.SPECIAL_SUNDAYS),
    nameMapping: readRosterTable_(ss, ROSTER_TABLE_DEFS_.NAME_MAPPING, sheetNames.NAME_MAPPING),
    posts: readRosterTable_(ss, ROSTER_TABLE_DEFS_.POSTS, sheetNames.POSTS)
  };
}

/**
 * 用途：讀取職事表其中一張工作表：第 2 行當機器鍵、第 3 行起是資料。
 *   用機器鍵對照欄位位置（不是照固定欄數讀），所以工作表多出其他後加
 *   欄位不會造成任何問題；但如果 ROSTER_TABLE_DEFS_ 宣告的機器鍵有任何
 *   一個在第 2 行找不到，視為結構性問題，直接拋錯。
 * Args:
 *   ss {Spreadsheet} 已經用 `openById()` 開啟的職事表試算表。
 *   tableDef {{label:string, configKeyName:string, columns:Object<string,string>}}
 *     ROSTER_TABLE_DEFS_ 其中一個表定義。
 *   sheetName {string} 這張表在職事表試算表內的實際名稱（來自 Config）。
 * Returns:
 *   {Object[]} 陣列，每個元素是以機器鍵為 key 的物件；整行皆空白的資料
 *     列會被略過。
 * Raises:
 *   Error 如果工作表不存在，或第 2 行缺少 tableDef.columns 宣告的任何
 *     一個機器鍵。
 */
function readRosterTable_(ss, tableDef, sheetName) {
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    throw new Error(
      '職事表找不到工作表「' + sheetName + '」（Config 鍵 ' + tableDef.configKeyName
      + ' 指向這個名稱）。請確認職事表試算表內有這張工作表，或修正 Config 的設定值。'
    );
  }

  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  if (lastRow < 2 || lastCol < 1) {
    throw new Error(
      '職事表工作表「' + sheetName + '」（Config 鍵 ' + tableDef.configKeyName + '）連標題都不完整。'
    );
  }

  var headerKeys = sheet.getRange(2, 1, 1, lastCol).getValues()[0].map(function (v) {
    return normalizeText_(v);
  });

  var colIndexByKey = {};
  headerKeys.forEach(function (key, idx) {
    if (key && !(key in colIndexByKey)) colIndexByKey[key] = idx;
  });

  var expectedKeys = Object.keys(tableDef.columns);
  var missingKeys = expectedKeys.filter(function (k) { return !(k in colIndexByKey); });
  if (missingKeys.length > 0) {
    throw new Error(
      '職事表工作表「' + sheetName + '」（Config 鍵 ' + tableDef.configKeyName
      + '）第 2 行缺少預期的機器鍵：' + missingKeys.join('、')
      + '。職事表的欄位結構可能已經改變，請通知 Ivan 確認。'
    );
  }

  if (lastRow < 3) return [];

  var values = sheet.getRange(3, 1, lastRow - 2, lastCol).getValues();
  var rows = [];

  values.forEach(function (rawRow, r) {
    var isBlank = rawRow.every(function (cell) { return cell === '' || cell === null; });
    if (isBlank) return;

    var row = {};
    expectedKeys.forEach(function (key) {
      var raw = rawRow[colIndexByKey[key]];
      var type = tableDef.columns[key];
      var context = { sheet: sheetName, key: key, row: r + 3 };
      try {
        row[key] = normalizeByType_(type, raw, context);
      } catch (err) {
        throw new Error(
          '職事表工作表「' + sheetName + '」第 ' + (r + 3) + ' 行、欄位「' + key
          + '」的值無法正規化：' + err.message
        );
      }
    });
    rows.push(row);
  });

  return rows;
}

// =====================================================================
// 純函式層——完全不碰 Apps Script 服務
// =====================================================================

/**
 * 用途：把 fetchRosterTables_() 的原始資料，組成一個主日的事奉快照。
 *   全部業務判斷都在這裡：比對日期、算 weekOfMonth、篩選最新版本的派工
 *   紀錄、解析特別主日、解析姓名對照、產生警告。完全不碰 Apps Script
 *   服務，方便在 Node 用假資料直接測試。
 * Args:
 *   tables {Object} fetchRosterTables_() 的回傳值。
 *   isoDate {string} 主日日期，yyyy-MM-dd 格式。
 * Returns:
 *   {Object} 快照物件，形狀見 docs/職事表唯讀介面.md。
 * Raises:
 *   Error 如果 isoDate 不是合法的 yyyy-MM-dd 格式。
 */
function buildRosterSnapshot_(tables, isoDate) {
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(isoDate || ''));
  if (!m) {
    throw new Error('buildRosterSnapshot_：isoDate 必須是 yyyy-MM-dd 格式，收到：' + JSON.stringify(isoDate));
  }
  var targetYear = Number(m[1]);
  var targetMonth = Number(m[2]);
  var targetDay = Number(m[3]);
  var weekOfMonth = Math.floor((targetDay - 1) / 7) + 1;

  var warnings = [];
  var snapshot = emptyRosterSnapshot_(isoDate, {
    weekOfMonth: weekOfMonth,
    posts: buildActiveRosterPostsList_(tables.posts),
    warnings: warnings
  });

  var serviceDateRow = tables.serviceDates.find(function (r) {
    return rosterDateMatchesYMD_(r.ServiceDate, targetYear, targetMonth, targetDay);
  });

  if (!serviceDateRow) {
    warnings.push({
      code: 'SERVICE_DATE_NOT_FOUND',
      message: '職事表 ServiceDates 找不到 ' + isoDate + ' 這個主日。'
    });
    return snapshot;
  }

  snapshot.found = true;
  snapshot.quarterId = serviceDateRow.QuarterID;
  snapshot.serviceDate = {
    serviceDateId: serviceDateRow.ServiceDateID,
    weekIndex: serviceDateRow.WeekIndex,
    isFirstSundayOfMonth: serviceDateRow.IsFirstSundayOfMonth,
    serviceType: serviceDateRow.ServiceType,
    specialId: serviceDateRow.SpecialID
  };

  if (Boolean(serviceDateRow.IsFirstSundayOfMonth) !== (weekOfMonth === 1)) {
    warnings.push({
      code: 'WEEK_OF_MONTH_MISMATCH',
      message: '自己算出來的 weekOfMonth（' + weekOfMonth + '）與職事表 IsFirstSundayOfMonth（'
        + serviceDateRow.IsFirstSundayOfMonth + '）不一致；已保留自己算的結果，僅供留意，不會用職事表的值覆蓋。'
    });
  }

  var quarterRow = tables.quarters.find(function (r) { return r.QuarterID === snapshot.quarterId; });
  if (quarterRow) {
    snapshot.quarterStage = quarterRow.Stage;
    snapshot.isOfficial = quarterRow.Stage === 'OFFICIAL_SENT';
    if (!snapshot.isOfficial) {
      warnings.push({
        code: 'NOT_OFFICIAL',
        message: '職事表尚未正式發出（目前階段：' + quarterRow.Stage + '），內容可能仍會變動。'
      });
    }
  } else {
    warnings.push({
      code: 'QUARTER_NOT_FOUND',
      message: '職事表 Quarters 找不到季度「' + snapshot.quarterId + '」的定義。'
    });
  }

  var maxVersionNo = null;
  tables.versions.forEach(function (r) {
    if (r.QuarterID !== snapshot.quarterId) return;
    if (typeof r.VersionNo !== 'number') return;
    if (maxVersionNo === null || r.VersionNo > maxVersionNo) maxVersionNo = r.VersionNo;
  });
  snapshot.versionNo = maxVersionNo;

  if (maxVersionNo === null) {
    warnings.push({
      code: 'NO_VERSION_GENERATED',
      message: '該季（' + snapshot.quarterId + '）尚未生成職事表版本。'
    });
  } else {
    var nameByPersonId = {};
    tables.nameMapping.forEach(function (p) { nameByPersonId[p.PersonID] = p; });

    snapshot.assignments = tables.assignments
      .filter(function (a) {
        return a.ServiceDateID === snapshot.serviceDate.serviceDateId && a.VersionNo === maxVersionNo;
      })
      .map(function (a) { return resolveRosterAssignmentPerson_(a, nameByPersonId, warnings); });
  }

  if (serviceDateRow.SpecialID) {
    var specialRow = tables.specialSundays.find(function (r) { return r.SpecialID === serviceDateRow.SpecialID; });
    if (specialRow) {
      snapshot.special = {
        specialId: specialRow.SpecialID,
        type: specialRow.Type,
        title: specialRow.Title,
        skipPostIds: parseRosterIdList_(specialRow.SkipPostIDs),
        lockPostIds: parseRosterIdList_(specialRow.LockPostIDs),
        externalOwner: specialRow.ExternalOwner,
        communionOverride: specialRow.CommunionOverride,
        translationRequired: Boolean(specialRow.TranslationRequired)
      };
    } else {
      warnings.push({
        code: 'SPECIAL_SUNDAY_NOT_FOUND',
        message: 'ServiceDates 指向的 SpecialID「' + serviceDateRow.SpecialID + '」在 SpecialSundays 找不到對應的一行。'
      });
    }
  }

  return snapshot;
}

/**
 * 用途：判斷一個（已正規化的）ServiceDate 值是不是剛好等於指定的年／月／日。
 * Args:
 *   dateValue {*} tables.serviceDates 某一行的 ServiceDate（應該是 Date 或 null）。
 *   year {number}　month {number}（1-12）　day {number}
 * Returns:
 *   {boolean}
 */
function rosterDateMatchesYMD_(dateValue, year, month, day) {
  if (!(dateValue instanceof Date)) return false;
  return dateValue.getFullYear() === year && dateValue.getMonth() === month - 1 && dateValue.getDate() === day;
}

/**
 * 用途：把一個 Date 物件格式化成 yyyy-MM-dd。純 JS 實作，不依賴
 *   Utilities.formatDate()，讓這個檔案的純函式層完全不用碰 Apps Script 服務。
 * Args:
 *   d {Date}
 * Returns:
 *   {string}
 */
function formatIsoDate_(d) {
  var y = d.getFullYear();
  var mo = String(d.getMonth() + 1);
  var da = String(d.getDate());
  if (mo.length < 2) mo = '0' + mo;
  if (da.length < 2) da = '0' + da;
  return y + '-' + mo + '-' + da;
}

/**
 * 用途：把 Posts 資料篩成 Active=TRUE、按 DisplayOrder 排序的顯示用清單。
 * Args:
 *   postsRows {Object[]} tables.posts。
 * Returns:
 *   {{postId:string, nameTC:string, slotCount:number, frequency:string,
 *     autoGenerate:boolean, displayOrder:number, emptyDisplay:string}[]}
 */
function buildActiveRosterPostsList_(postsRows) {
  return postsRows
    .filter(function (p) { return Boolean(p.Active); })
    .slice()
    .sort(function (a, b) { return (a.DisplayOrder || 0) - (b.DisplayOrder || 0); })
    .map(function (p) {
      return {
        postId: p.PostID,
        nameTC: p.PostName_TC,
        slotCount: p.SlotCount,
        frequency: p.Frequency,
        autoGenerate: Boolean(p.AutoGenerate),
        displayOrder: p.DisplayOrder,
        emptyDisplay: p.EmptyDisplay
      };
    });
}

/**
 * 用途：把一筆 RosterAssignments 原始資料，解析出 personId／personName，
 *   規則見 docs/職事表唯讀介面.md 的錯誤處理契約表。
 * Args:
 *   a {Object} tables.assignments 其中一行。
 *   nameByPersonId {Object<string,Object>} PersonID → NameMapping 那一行。
 *   warnings {{code:string,message:string}[]} 累積警告用的陣列，這個函式
 *     可能會往裡面 push。
 * Returns:
 *   {{postId:string, slotIndex:number, personId:(string|null),
 *     personName:string, assignSource:string, locked:boolean}}
 */
function resolveRosterAssignmentPerson_(a, nameByPersonId, warnings) {
  var snapshot = a.PersonNameSnapshot || '';
  var isPlaceholder = ROSTER_PERSON_PLACEHOLDER_SNAPSHOTS_.indexOf(snapshot.trim()) !== -1;

  var personId = null;
  var personName = snapshot;

  if (isPlaceholder) {
    warnings.push({
      code: 'PERSON_PLACEHOLDER',
      message: '崗位 ' + a.PostID + '（第 ' + a.SlotIndex + ' 位）目前是佔位符「' + snapshot + '」，尚未排定實際人選。'
    });
  } else if (a.PersonID) {
    var match = nameByPersonId[a.PersonID];
    if (match) {
      personId = a.PersonID;
      personName = match.NameTC;
    } else {
      personId = a.PersonID;
      personName = snapshot;
      warnings.push({
        code: 'PERSON_NOT_FOUND_IN_NAME_MAPPING',
        message: 'PersonID「' + a.PersonID + '」（崗位 ' + a.PostID + '）在職事表 NameMapping 找不到對應姓名，已改用 PersonNameSnapshot。'
      });
    }
  }

  return {
    postId: a.PostID,
    slotIndex: a.SlotIndex,
    personId: personId,
    personName: personName,
    assignSource: a.AssignSource,
    locked: Boolean(a.Locked)
  };
}

/**
 * 用途：把 SkipPostIDs／LockPostIDs 這類逗號分隔字串解析成陣列，支援
 *   半形逗號與全形逗號、容忍多餘空白，空字串回空陣列。
 * Args:
 *   raw {string} 原始字串。
 * Returns:
 *   {string[]}
 */
function parseRosterIdList_(raw) {
  if (!raw) return [];
  return String(raw)
    .split(/[,，]/)
    .map(function (s) { return s.trim(); })
    .filter(function (s) { return s.length > 0; });
}
