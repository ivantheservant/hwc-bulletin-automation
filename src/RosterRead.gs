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
 *
 * ⚠️ 型別正規化用的是本檔案自己的一套「白名單欄位＋寬鬆解析」
 * （rosterToText_／rosterToIntLenient_／rosterToDateLenient_／
 * rosterIsTrueValue_），**跟 `src/SheetUtils.gs` 的 `normalize*_()` 完全
 * 分開，不共用**。原因見 docs/職事表唯讀介面.md「為什麼對職事表用寬鬆
 * 解析」一節：職事表是別人的系統，我們沒有話事權要求對方的欄位型別／
 * 列舉值符合我們的假設，嚴格規則只適合套在「自己的工作表」（`Constants.gs`
 * 的 `COLUMNS`）。**這條界線不可以模糊**：職事表的寬鬆解析函式不可以
 * 拿去用在週報自己的工作表上，自己的表仍然要嚴格。
 */

'use strict';

// =====================================================================
// 職事表工作表結構——只列週報真正需要的白名單欄位，不是職事表的完整
// schema（照抄完整 schema 曾經導致對方一個列舉欄位就讓我們整個拋錯，
// 見 docs/已知bug類型.md 事故二）。
// =====================================================================

/**
 * 職事表六張工作表的白名單定義：
 *   label           人看的表名，用於錯誤訊息。
 *   configKeyName   對應哪一個 CONFIG_KEYS，錯誤訊息要講得出「改哪個設定」。
 *   columns         **必要**欄：機器鍵 → 型別（'TEXT'／'INT'／'DATE'／'BOOLEAN'，見
 *                   rosterNormalizeByType_()）。第 2 行找不到就拋錯。**只列出週報
 *                   真正需要的欄位**——不在清單內的欄，即使工作表裡有，也完全不會
 *                   被讀取／正規化／驗證，工作表可以自由新增其他欄位而
 *                   不影響週報。NAME_MAPPING 刻意只列 3 欄，Email／Phone／
 *                   PersonalLinkToken 等敏感欄位一律不讀進記憶體（硬規則）。
 *   optionalColumns **選讀**欄（2026-10-27，職事表第八十二輪說明）：職事表後來才加、舊試算表
 *                   可能未有的欄。第 2 行找不到就當每一行都是空值（TEXT＝''），**不拋錯、
 *                   不記警告**——例如 `ServiceDates.Title` 要等幹事第一次改每週標題，職事表
 *                   才會加這一欄。
 *
 * ⚠️ 2026-10-27 起**不再讀 `SpecialSundays`**：職事表第七十五輪起特別主日拿走
 *   （`SPECIAL_SUNDAYS_ENABLED` 預設 FALSE），那張表的內容不再影響職事表。每週標題改讀
 *   `ServiceDates.Title`；「這一週不設」改看 `RosterAssignments.RuleFlags`。
 */
var ROSTER_TABLE_DEFS_ = Object.freeze({
  ASSIGNMENTS: {
    label: 'RosterAssignments',
    configKeyName: 'ROSTER_SHEET_ASSIGNMENTS',
    columns: {
      QuarterID: 'TEXT', VersionNo: 'INT', ServiceDate: 'DATE', PostID: 'TEXT',
      SlotIndex: 'INT', PersonID: 'TEXT', PersonNameSnapshot: 'TEXT',
      AssignSource: 'TEXT', Locked: 'BOOLEAN'
    },
    optionalColumns: {
      // 逗號分隔的規則代號（例如 HARD_COMMUNION_FIRST_SUNDAY），用來分「空格」是哪一種。
      RuleFlags: 'TEXT'
    }
  },
  VERSIONS: {
    label: 'RosterVersions',
    configKeyName: 'ROSTER_SHEET_VERSIONS',
    columns: {
      QuarterID: 'TEXT', VersionNo: 'INT'
    }
  },
  QUARTERS: {
    label: 'Quarters',
    configKeyName: 'ROSTER_SHEET_QUARTERS',
    columns: {
      // ⚠️ Quarters 同時有 Status 與 Stage 兩個欄位，快照用的是 Stage。
      QuarterID: 'TEXT', Stage: 'TEXT'
    }
  },
  SERVICE_DATES: {
    label: 'ServiceDates',
    configKeyName: 'ROSTER_SHEET_SERVICE_DATES',
    columns: {
      ServiceDateID: 'TEXT', QuarterID: 'TEXT', ServiceDate: 'DATE', WeekIndex: 'INT',
      IsFirstSundayOfMonth: 'BOOLEAN', ServiceType: 'TEXT', SpecialID: 'TEXT'
    },
    optionalColumns: {
      // 每週標題：幹事在職事表「類型」欄改，空白＝預設類型（ServiceType）。
      Title: 'TEXT'
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
      // ⚠️ 刻意不列 AllowConsecutive：職事表的實際取值是
      // ALLOW／BLOCK／WARN（一個列舉），不是 boolean，週報也用不到。
      PostID: 'TEXT', PostName_TC: 'TEXT', SlotCount: 'INT', Frequency: 'TEXT',
      AutoGenerate: 'BOOLEAN', DisplayOrder: 'INT', Active: 'BOOLEAN', EmptyDisplay: 'TEXT'
    }
  }
});

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
 *   快照物件，並把 IO 層讀取時累積的寬鬆解析警告一併併入。
 * Args:
 *   isoDate {string} 主日日期，yyyy-MM-dd 格式。
 * Returns:
 *   {Object} 快照物件，形狀見 docs/職事表唯讀介面.md。`ROSTER_SPREADSHEET_ID`
 *     未設定時，回傳 `{ ok:false, notConfigured:true, ... }`，不拋錯。
 * Raises:
 *   Error 只有三種情況：`openById()` 失敗、任何一張工作表不存在、或工作表
 *     第 2 行缺少白名單內的機器鍵（見 fetchRosterTables_()／
 *     readRosterTable_()）。其餘一律回傳快照物件並在 `warnings` 說明。
 */
function readRosterSnapshot_(isoDate) {
  var spreadsheetId = getConfig(CONFIG_KEYS.ROSTER_SPREADSHEET_ID, '');
  if (!spreadsheetId) {
    return emptyRosterSnapshot_(isoDate, { ok: false, notConfigured: true });
  }

  // 聖餐週次、「不是人」的顯示字、「這一週不設」的規則代號都由 Config 決定（不可以寫死）。
  // 純函式層自己讀不到 Config，所以在這個真正入口讀好再傳進去。
  var io = fetchRosterTablesCached_(spreadsheetId, buildRosterSheetNames_());
  var snapshot = buildRosterSnapshot_(io.tables, isoDate, readRosterSnapshotOptions_());
  if (io.warnings.length > 0) {
    snapshot.warnings = snapshot.warnings.concat(io.warnings);
  }
  return snapshot;
}

/**
 * 用途：讀出 `buildRosterSnapshot_()` 要用的三項 Config。真正入口專用（會讀 Config）。
 * Args: （無）
 * Returns:
 *   {{communionWeeks:number[], notAPersonTexts:string[], notApplicableRuleFlags:string[]}}
 * Raises:
 *   Error 如果 `COMMUNION_WEEKS` 格式不對（見 getConfigIntList_()）。
 */
function readRosterSnapshotOptions_() {
  return {
    communionWeeks: getConfigIntList_(CONFIG_KEYS.COMMUNION_WEEKS, '1'),
    notAPersonTexts: getConfigTextList_(CONFIG_KEYS.ROSTER_NOT_A_PERSON_TEXTS, ROSTER_NOT_A_PERSON_TEXTS_DEFAULT),
    notApplicableRuleFlags: getConfigTextList_(
      CONFIG_KEYS.ROSTER_NOT_APPLICABLE_RULE_FLAGS, ROSTER_NOT_APPLICABLE_RULE_FLAGS_DEFAULT
    )
  };
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

  var io = fetchRosterTablesCached_(spreadsheetId, buildRosterSheetNames_());
  return io.tables.serviceDates
    .filter(function (r) { return r.QuarterID === quarterId; })
    .map(function (r) { return r.ServiceDate; })
    .filter(function (d) { return d instanceof Date; })
    .sort(function (a, b) { return a.getTime() - b.getTime(); })
    .map(function (d) { return formatIsoDate_(d); });
}

/**
 * 用途：v3（自動建立季度）：列出職事表每一季的概況——有沒有生成過版本、主日由哪一日到哪一日。
 *   **唯讀**，與 `readRosterSnapshot_()` 共用同一份 memoized 資料。
 * Args: （無）
 * Returns:
 *   {{quarterId:string, versionCount:number, maxVersion:(number|null), firstIso:string, lastIso:string,
 *     dateCount:number}[]} 按季度 ID 排序；只列 ServiceDates 有主日的季度。
 * Raises:
 *   Error 如果 `ROSTER_SPREADSHEET_ID` 未設定，或底層讀取失敗（見 fetchRosterTables_()）。
 */
function listRosterQuarterSummaries_() {
  var spreadsheetId = getConfig(CONFIG_KEYS.ROSTER_SPREADSHEET_ID, '');
  if (!spreadsheetId) {
    throw new Error('listRosterQuarterSummaries_：Config 的 ROSTER_SPREADSHEET_ID 未設定。');
  }
  var io = fetchRosterTablesCached_(spreadsheetId, buildRosterSheetNames_());
  return buildRosterQuarterSummaries_(io.tables);
}

/**
 * 用途：v3：由職事表的 `RosterVersions` 與 `ServiceDates` 算出每一季的概況。純函式。
 * Args:
 *   tables {{versions:Object[], serviceDates:Object[]}} IO 層的回傳值。
 * Returns:
 *   {Object[]} 形狀見 `listRosterQuarterSummaries_()`。
 * Raises:
 *   （無）
 */
function buildRosterQuarterSummaries_(tables) {
  var byQuarter = {};
  ((tables && tables.serviceDates) || []).forEach(function (r) {
    var qid = String(r.QuarterID || '').trim();
    if (!qid || !(r.ServiceDate instanceof Date)) return;
    var iso = formatIsoDate_(r.ServiceDate);
    if (!byQuarter[qid]) byQuarter[qid] = { quarterId: qid, versionCount: 0, maxVersion: null, firstIso: iso, lastIso: iso, dateCount: 0 };
    var q = byQuarter[qid];
    q.dateCount++;
    if (iso < q.firstIso) q.firstIso = iso;
    if (iso > q.lastIso) q.lastIso = iso;
  });
  ((tables && tables.versions) || []).forEach(function (r) {
    var q = byQuarter[String(r.QuarterID || '').trim()];
    if (!q) return;
    var v = Number(r.VersionNo);
    if (!isFinite(v) || r.VersionNo === null || r.VersionNo === '') return;
    q.versionCount++;
    if (q.maxVersion === null || v > q.maxVersion) q.maxVersion = v;
  });
  // ⚠️ 次序不保證（本檔案不准出現排序呼叫，見 tools/lint-readonly-roster.js）；要排就由呼叫方排。
  return Object.keys(byQuarter).map(function (k) { return byQuarter[k]; });
}

/**
 * 用途：讀出職事表 `NameMapping` 的全部資料列（白名單三欄：`PersonID`／
 *   `NameTC`／`Active`，見 ROSTER_TABLE_DEFS_.NAME_MAPPING 的說明——
 *   `Email`／`Phone`／`PersonalLinkToken` 這些欄位一律不會被讀進記憶體，
 *   這是硬規則，不是這個函式自己過濾的）。供第六b輪「由職事表建立
 *   PersonDisplay 骨架」使用，不篩選 `Active`，由呼叫方自行決定要不要
 *   篩（純函式層的職責，方便單獨測試「篩選 Active」這條規則）。
 * Args: （無）
 * Returns:
 *   {Object[]} 每個元素是 `{PersonID, NameTC, Active}`。
 * Raises:
 *   Error 如果 `ROSTER_SPREADSHEET_ID` 未設定，或底層讀取失敗
 *     （見 fetchRosterTables_()）。
 */
function readRosterNameMappingRows_() {
  var spreadsheetId = getConfig(CONFIG_KEYS.ROSTER_SPREADSHEET_ID, '');
  if (!spreadsheetId) {
    throw new Error('readRosterNameMappingRows_：Config 的 ROSTER_SPREADSHEET_ID 未設定。');
  }

  var io = fetchRosterTablesCached_(spreadsheetId, buildRosterSheetNames_());
  return io.tables.nameMapping;
}

/**
 * 用途：列出「某個主日所在的季度」內，全部有實際事奉安排（`PersonID`
 *   不為空）的人，PersonID 各出現一次（同一人整季可能事奉多次）。供
 *   第六b輪「尊稱未設定報告」使用——只有真的會出現在週報上的人才需要
 *   確認尊稱，不用理會職事表 90 個人全部。
 *
 *   ⚠️ 真正入口，唯讀，不寫入任何一格。
 * Args:
 *   isoDate {string} 主日日期，yyyy-MM-dd——只用來定位「哪一季」，不代表
 *     只看這一個主日。
 * Returns:
 *   {{quarterId:(string|null), versionNo:(number|null),
 *     persons:{personId:string, nameTC:string}[]}} `quarterId` 找不到
 *     （這個日期不在職事表 `ServiceDates` 內）時回 `null`，`persons`
 *     為空陣列，不拋錯——這是唯讀診斷報告，讓呼叫方自行決定如何呈現
 *     「找不到這個主日」，不需要用例外中斷。
 * Raises:
 *   Error 如果 `ROSTER_SPREADSHEET_ID` 未設定，或底層讀取失敗
 *     （見 fetchRosterTables_()），或 `isoDate` 不是合法的 yyyy-MM-dd 格式
 *     （見 buildRosterQuarterAssignedPersons_()）。
 */
function listRosterQuarterAssignedPersons_(isoDate) {
  var spreadsheetId = getConfig(CONFIG_KEYS.ROSTER_SPREADSHEET_ID, '');
  if (!spreadsheetId) {
    throw new Error('listRosterQuarterAssignedPersons_：Config 的 ROSTER_SPREADSHEET_ID 未設定。');
  }

  var io = fetchRosterTablesCached_(spreadsheetId, buildRosterSheetNames_());
  return buildRosterQuarterAssignedPersons_(io.tables, isoDate);
}

/**
 * 用途：`listRosterQuarterAssignedPersons_()` 的純函式層——完全不碰
 *   Apps Script 服務，方便在 Node 直接測試。版本選擇邏輯與
 *   `buildRosterSnapshot_()` 一致：同一季取 `VersionNo` 最大的一版
 *   （最新版）。
 * Args:
 *   tables {Object} `fetchRosterTables_()` 回傳的 `tables`（`serviceDates`／
 *     `versions`／`assignments`／`nameMapping`）。
 *   isoDate {string} 主日日期，yyyy-MM-dd。
 * Returns:
 *   {{quarterId:(string|null), versionNo:(number|null),
 *     persons:{personId:string, nameTC:string}[]}} `persons` 依
 *     `personId` 排序；找不到 `NameTC`（NameMapping 沒有這個人）時退回
 *     `PersonNameSnapshot`。
 * Raises:
 *   Error 如果 `isoDate` 不是合法的 yyyy-MM-dd 格式。
 */
function buildRosterQuarterAssignedPersons_(tables, isoDate) {
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(isoDate || ''));
  if (!m) {
    throw new Error('buildRosterQuarterAssignedPersons_：isoDate 必須是 yyyy-MM-dd 格式，收到：' + JSON.stringify(isoDate));
  }
  var targetYear = Number(m[1]);
  var targetMonth = Number(m[2]);
  var targetDay = Number(m[3]);

  var serviceDateRow = tables.serviceDates.find(function (r) {
    return rosterDateMatchesYMD_(r.ServiceDate, targetYear, targetMonth, targetDay);
  });
  if (!serviceDateRow) {
    return { quarterId: null, versionNo: null, persons: [] };
  }
  var quarterId = serviceDateRow.QuarterID;

  var maxVersionNo = null;
  tables.versions.forEach(function (r) {
    if (r.QuarterID !== quarterId) return;
    if (typeof r.VersionNo !== 'number') return;
    if (maxVersionNo === null || r.VersionNo > maxVersionNo) maxVersionNo = r.VersionNo;
  });
  if (maxVersionNo === null) {
    return { quarterId: quarterId, versionNo: null, persons: [] };
  }

  var nameByPersonId = {};
  tables.nameMapping.forEach(function (p) { nameByPersonId[p.PersonID] = p.NameTC; });

  var seen = {};
  var persons = [];
  tables.assignments.forEach(function (a) {
    if (a.QuarterID !== quarterId || a.VersionNo !== maxVersionNo) return;
    if (!a.PersonID) return;
    if (seen[a.PersonID]) return;
    seen[a.PersonID] = true;
    persons.push({
      personId: a.PersonID,
      nameTC: nameByPersonId[a.PersonID] || a.PersonNameSnapshot || ''
    });
  });

  persons.sort(function (a, b) { return a.personId < b.personId ? -1 : (a.personId > b.personId ? 1 : 0); });

  return { quarterId: quarterId, versionNo: maxVersionNo, persons: persons };
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
    slotsByPost: {},
    posts: [],
    notAPersonTexts: [],
    warnings: []
  };
  return Object.assign(base, overrides || {});
}

/**
 * 用途：從 Config 組出職事表六張工作表的實際名稱（2026-10-27 起不再讀 SpecialSundays）。
 * Args: （無）
 * Returns:
 *   {{ASSIGNMENTS:string, VERSIONS:string, QUARTERS:string, SERVICE_DATES:string,
 *     NAME_MAPPING:string, POSTS:string}}
 */
function buildRosterSheetNames_() {
  return {
    ASSIGNMENTS: getConfig(CONFIG_KEYS.ROSTER_SHEET_ASSIGNMENTS, 'RosterAssignments'),
    VERSIONS: getConfig(CONFIG_KEYS.ROSTER_SHEET_VERSIONS, 'RosterVersions'),
    QUARTERS: getConfig(CONFIG_KEYS.ROSTER_SHEET_QUARTERS, 'Quarters'),
    SERVICE_DATES: getConfig(CONFIG_KEYS.ROSTER_SHEET_SERVICE_DATES, 'ServiceDates'),
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
 *   {{tables:Object, warnings:Object[]}} 同 fetchRosterTables_() 的回傳值。
 */
function fetchRosterTablesCached_(spreadsheetId, sheetNames) {
  var cacheKey = spreadsheetId + '|' + JSON.stringify(sheetNames);
  if (ROSTER_TABLES_CACHE_ && ROSTER_TABLES_CACHE_KEY_ === cacheKey) {
    return ROSTER_TABLES_CACHE_;
  }
  var result = fetchRosterTables_(spreadsheetId, sheetNames);
  ROSTER_TABLES_CACHE_ = result;
  ROSTER_TABLES_CACHE_KEY_ = cacheKey;
  return result;
}

// =====================================================================
// IO 層——唯一會碰 SpreadsheetApp 的地方
// =====================================================================

/**
 * 用途：一次過把職事表六張工作表（白名單欄位）讀成純陣列物件並回傳，
 *   不做任何業務判斷（不比對日期、不篩選版本、不解析特別主日、不查
 *   姓名對照）。每張表只讀一次（`getRange` 等級的單次範圍讀取），不會
 *   針對個別崗位或個別主日重覆開表。
 * Args:
 *   spreadsheetId {string} 職事表試算表 ID。
 *   sheetNames {Object} buildRosterSheetNames_() 的回傳值，六個工作表的
 *     實際名稱。
 * Returns:
 *   {{tables:{assignments:Object[], versions:Object[], quarters:Object[],
 *     serviceDates:Object[], nameMapping:Object[], posts:Object[]},
 *     warnings:{code:string,message:string}[]}}
 *     `tables` 的每個陣列元素是以機器鍵為 key 的物件，已依
 *     ROSTER_TABLE_DEFS_ 宣告的型別做**寬鬆**正規化；`warnings` 是讀取
 *     過程中遇到的、無法解析的整數／日期值（空白不算，只有「有值但解析
 *     不出來」才會記一筆）。
 * Raises:
 *   Error 如果 `openById()` 失敗（訊息只含 ID 前 8 個字元＋省略號，不印
 *     完整 ID），或任何一張工作表不存在，或第 2 行缺少白名單內的機器鍵。
 *     這是唯一會拋錯的三種情況——見檔案開頭「職事表工作表結構」的說明。
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

  var warnings = [];
  var tables = {
    assignments: readRosterTable_(ss, ROSTER_TABLE_DEFS_.ASSIGNMENTS, sheetNames.ASSIGNMENTS, warnings),
    versions: readRosterTable_(ss, ROSTER_TABLE_DEFS_.VERSIONS, sheetNames.VERSIONS, warnings),
    quarters: readRosterTable_(ss, ROSTER_TABLE_DEFS_.QUARTERS, sheetNames.QUARTERS, warnings),
    serviceDates: readRosterTable_(ss, ROSTER_TABLE_DEFS_.SERVICE_DATES, sheetNames.SERVICE_DATES, warnings),
    nameMapping: readRosterTable_(ss, ROSTER_TABLE_DEFS_.NAME_MAPPING, sheetNames.NAME_MAPPING, warnings),
    posts: readRosterTable_(ss, ROSTER_TABLE_DEFS_.POSTS, sheetNames.POSTS, warnings)
  };

  return { tables: tables, warnings: warnings };
}

/**
 * 用途：讀取職事表其中一張工作表的白名單欄位：第 2 行當機器鍵、第 3 行
 *   起是資料。用機器鍵對照欄位位置（不是照固定欄數讀），白名單以外的欄
 *   完全不會被碰——工作表多出其他欄位（不論是本來就有、還是對方日後
 *   加的）一律靜靜略過，不是錯誤。只有**必要**欄（`columns`）的機器鍵在第 2 行
 *   找不到，才視為結構性問題，直接拋錯；**選讀**欄（`optionalColumns`）找不到
 *   就當每一行都是空值。
 * Args:
 *   ss {Spreadsheet} 已經用 `openById()` 開啟的職事表試算表。
 *   tableDef {{label:string, configKeyName:string, columns:Object<string,string>,
 *     optionalColumns:(Object<string,string>|undefined)}} ROSTER_TABLE_DEFS_ 其中一個表定義。
 *   sheetName {string} 這張表在職事表試算表內的實際名稱（來自 Config）。
 *   warningsOut {{code:string,message:string}[]} 累積寬鬆解析警告用的
 *     陣列，這個函式會往裡面 push（透過 rosterNormalizeByType_()）。
 * Returns:
 *   {Object[]} 陣列，每個元素是以機器鍵為 key 的物件（必要欄＋選讀欄，選讀欄
 *     在工作表找不到時是該型別的空值）；整行皆空白的資料列會被略過。
 * Raises:
 *   Error 如果工作表不存在，或第 2 行缺少 tableDef.columns 宣告的任何
 *     一個機器鍵（選讀欄不算）。
 */
function readRosterTable_(ss, tableDef, sheetName, warningsOut) {
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
    return rosterToText_(v);
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
      + '）第 2 行缺少白名單內的機器鍵：' + missingKeys.join('、')
      + '。職事表的欄位結構可能已經改變，請通知 Ivan 確認。'
    );
  }

  if (lastRow < 3) return [];

  var optionalColumns = tableDef.optionalColumns || {};
  var optionalKeys = Object.keys(optionalColumns);

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
      row[key] = rosterNormalizeByType_(type, raw, context, warningsOut);
    });
    // 選讀欄：工作表沒有這一欄＝每一行都是空值（經同一個正規化，TEXT 得 ''），不拋錯、不記警告。
    optionalKeys.forEach(function (key) {
      var raw = (key in colIndexByKey) ? rawRow[colIndexByKey[key]] : '';
      var context = { sheet: sheetName, key: key, row: r + 3 };
      row[key] = rosterNormalizeByType_(optionalColumns[key], raw, context, warningsOut);
    });
    rows.push(row);
  });

  return rows;
}

// =====================================================================
// 職事表專用的寬鬆型別解析——跟 src/SheetUtils.gs 的 normalize*_() 完全
// 分開，不共用。理由見檔案開頭的說明；不可以拿去用在週報自己的工作表。
// =====================================================================

/**
 * 用途：依 tableDef.columns 宣告的型別名稱，分派到對應的寬鬆解析函式。
 * Args:
 *   type {string} 'TEXT'／'INT'／'DATE'／'BOOLEAN' 其中之一。
 *   raw {*} 儲存格原始值。
 *   context {{sheet:string, key:string, row:number}} 供警告訊息使用。
 *   warningsOut {{code:string,message:string}[]} 累積警告用的陣列。
 * Returns:
 *   {*} 正規化後的值，型別依 type 而定；永不拋錯（除了 type 本身打錯字）。
 * Raises:
 *   Error 如果 type 不是已知的型別名稱（代表 ROSTER_TABLE_DEFS_ 自己寫錯，
 *     屬於程式錯誤，不是資料問題，所以還是要拋）。
 */
function rosterNormalizeByType_(type, raw, context, warningsOut) {
  switch (type) {
    case 'TEXT': return rosterToText_(raw);
    case 'INT': return rosterToIntLenient_(raw, context, warningsOut);
    case 'DATE': return rosterToDateLenient_(raw, context, warningsOut);
    case 'BOOLEAN': return rosterIsTrueValue_(raw);
    default:
      throw new Error('rosterNormalizeByType_：ROSTER_TABLE_DEFS_ 用了未知的型別「' + type + '」，這是程式錯誤。');
  }
}

/**
 * 用途：職事表專用的寬鬆布林正規化。**刻意複製職事表 `src/SheetReader.gs`
 *   的 `isTrueValue_()` 語意**：`value === true`，或者字串 trim 之後轉大寫
 *   等於 `'TRUE'`，才是 `true`；空白、`FALSE`、`'是'`、`'1'`、`'Y'`、無法
 *   辨識的列舉值（例如 `Posts.AllowConsecutive` 的 `'ALLOW'`）……其餘一律
 *   當 `false`，**永不拋錯**。
 *
 *   ⚠️ 這個語意是刻意複製職事表的行為，**不可以自己另立一套**（例如接受
 *   `是`／`1`／`Y`）。改這個函式之前，要先確認職事表 `isTrueValue_()`
 *   那邊是不是也同步改了，否則會出現「職事表當它是關、週報當它是開」
 *   這種兩邊語意不一致、最難查的問題。
 * Args:
 *   value {*} 儲存格原始值。
 * Returns:
 *   {boolean}
 */
function rosterIsTrueValue_(value) {
  return value === true || String(value).trim().toUpperCase() === 'TRUE';
}

/**
 * 用途：職事表專用的寬鬆文字正規化。跟 `SheetUtils.gs` 的 `normalizeText_()`
 *   不同——這裡完全不管「這欄本來應該是什麼型別」，一律 `String()` 轉
 *   字串再 trim，**永不拋錯、不記警告**。職事表的欄位不是我們定義的
 *   schema，我們沒有資格要求它一定是純文字。
 * Args:
 *   value {*} 儲存格原始值。
 * Returns:
 *   {string} 空值一律回 `''`。
 */
function rosterToText_(value) {
  if (value === null || value === undefined || value === '') return '';
  return String(value).trim();
}

/**
 * 用途：職事表專用的寬鬆整數正規化。空白回 `null`（正常狀態，不記警告）；
 *   有值但解析不出整數，回 `null` 並記一筆警告，**永不拋錯**。
 * Args:
 *   value {*} 儲存格原始值。
 *   context {{sheet:string, key:string, row:number}} 供警告訊息使用。
 *   warningsOut {{code:string,message:string}[]} 累積警告用的陣列。
 * Returns:
 *   {?number}
 */
function rosterToIntLenient_(value, context, warningsOut) {
  if (value === null || value === undefined || value === '') return null;
  var n = Number(value);
  if (!Number.isFinite(n) || Math.floor(n) !== n) {
    warningsOut.push({
      code: 'ROSTER_VALUE_UNPARSEABLE',
      message: '職事表「' + context.sheet + '」第 ' + context.row + ' 行、欄位「' + context.key
        + '」的整數值無法解析（值：' + JSON.stringify(value) + '），已當成空值處理。'
    });
    return null;
  }
  return n;
}

/**
 * 用途：職事表專用的寬鬆日期正規化。接受 `Date` 物件與 `yyyy-MM-dd`
 *   字串；空白回 `null`（正常狀態，不記警告）；有值但解析不出來，回
 *   `null` 並記一筆警告，**永不拋錯**——該列在後續比對日期時，會因為
 *   這個欄位是 `null` 而自動配不到任何日期，等於被略過。
 * Args:
 *   value {*} 儲存格原始值。
 *   context {{sheet:string, key:string, row:number}} 供警告訊息使用。
 *   warningsOut {{code:string,message:string}[]} 累積警告用的陣列。
 * Returns:
 *   {?Date}
 */
function rosterToDateLenient_(value, context, warningsOut) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return value;
  if (typeof value === 'string') {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
    if (m) {
      var y = Number(m[1]);
      var mo = Number(m[2]);
      var d = Number(m[3]);
      var date = new Date(y, mo - 1, d);
      if (date.getFullYear() === y && date.getMonth() === mo - 1 && date.getDate() === d) {
        return date;
      }
    }
  }
  warningsOut.push({
    code: 'ROSTER_VALUE_UNPARSEABLE',
    message: '職事表「' + context.sheet + '」第 ' + context.row + ' 行、欄位「' + context.key
      + '」的日期值無法解析（值：' + JSON.stringify(value) + '），這一行在比對日期時會被自動略過。'
  });
  return null;
}

// =====================================================================
// 純函式層——完全不碰 Apps Script 服務
// =====================================================================

/**
 * 用途：把 fetchRosterTables_() 的 `tables` 原始資料，組成一個主日的
 *   事奉快照。全部業務判斷都在這裡：比對日期、算 weekOfMonth、篩選最新
 *   版本的派工紀錄、讀每週標題、解析姓名對照、逐個 slot 判斷狀態、
 *   產生警告。完全不碰 Apps Script 服務，方便在 Node 用假資料直接測試。
 *
 *   每週標題（2026-10-27，職事表第八十二輪說明第 5 節）：`ServiceDates.Title` 有字、而且
 *   不等於 `ServiceType`，就是這一週的標題，放在 `snapshot.special.title`（沿用舊的位置，
 *   下游——「特別主日：」一行、程序範本推斷、Word `{{SPECIAL_TYPE}}`、郵件標題——不用改）。
 *   空白或等於 ServiceType ⇒ 普通主日（`special` 是 null）。**不再讀 SpecialSundays。**
 * Args:
 *   tables {Object} fetchRosterTables_() 回傳值的 `.tables` 部分。
 *   isoDate {string} 主日日期，yyyy-MM-dd 格式。
 *   options {{communionWeeks:(number[]|undefined), notAPersonTexts:(string[]|undefined),
 *     notApplicableRuleFlags:(string[]|undefined)}=} 選填，正式路徑一律由
 *     readRosterSnapshotOptions_() 讀 Config 傳進來；沒有提供時退回與 Config 預設值相同的值
 *     （只在測試等沒有 Config 的情境下使用）：
 *     - `communionWeeks`：Config `COMMUNION_WEEKS`，判斷 `Frequency === 'FIRST_SUNDAY'`
 *       的崗位這一週適不適用（後備，見 resolveRosterSlotState_()）。預設 `[1]`。
 *     - `notAPersonTexts`：Config `ROSTER_NOT_A_PERSON_TEXTS`，職事表的顯示字（「（待填）」
 *       「—」「待確認」……），在 `PersonNameSnapshot` 見到一律當空白。
 *     - `notApplicableRuleFlags`：Config `ROSTER_NOT_APPLICABLE_RULE_FLAGS`，`RuleFlags`
 *       有其中一個代號＝這一週不設這個崗位。
 * Returns:
 *   {Object} 快照物件，形狀見 docs/職事表唯讀介面.md。
 * Raises:
 *   Error 如果 isoDate 不是合法的 yyyy-MM-dd 格式。
 */
function buildRosterSnapshot_(tables, isoDate, options) {
  var opts = options || {};
  var communionWeeks = opts.communionWeeks || [1];
  var notAPersonTexts = opts.notAPersonTexts || parseConfigTextList_(ROSTER_NOT_A_PERSON_TEXTS_DEFAULT);
  var notApplicableRuleFlags = opts.notApplicableRuleFlags
    || parseConfigTextList_(ROSTER_NOT_APPLICABLE_RULE_FLAGS_DEFAULT);
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
    // 下游（例如 buildRosterDiff_() 比對舊覆寫記下的職事表值）要用同一份清單判斷「不是人」。
    notAPersonTexts: notAPersonTexts.slice(),
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
    specialId: serviceDateRow.SpecialID,
    title: serviceDateRow.Title || ''
  };
  snapshot.special = buildRosterWeekTitle_(serviceDateRow);

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

    // ⚠️ RosterAssignments 白名單沒有 ServiceDateID，用
    // QuarterID + ServiceDate（實際日期）配對，不是用 ID 對照。
    snapshot.assignments = tables.assignments
      .filter(function (a) {
        return a.QuarterID === snapshot.quarterId
          && a.VersionNo === maxVersionNo
          && rosterDateMatchesYMD_(a.ServiceDate, targetYear, targetMonth, targetDay);
      })
      .map(function (a) { return resolveRosterAssignmentPerson_(a, nameByPersonId, warnings, notAPersonTexts); });
  }

  snapshot.slotsByPost = buildRosterSlotIndex_(snapshot, communionWeeks, notApplicableRuleFlags);

  return snapshot;
}

/**
 * 用途：由 `ServiceDates` 一行算出這一週的標題（職事表第八十二輪說明第 5 節）。純函式。
 *
 *   `Title` 是幹事在職事表「類型」欄改的每週標題，空白＝預設類型（`ServiceType`）。職事表改回
 *   預設時會清空 Title；這裏另外把「Title 等於 ServiceType」都當成普通主日，免得舊資料或人手
 *   填了一模一樣的字被當成特別主日。
 * Args:
 *   serviceDateRow {Object} `tables.serviceDates` 其中一行（`Title` 是選讀欄，沒有這一欄時是 ''）。
 * Returns:
 *   {?{title:string, type:string, source:string}} 普通主日回 `null`。`type` 一律空字串（職事表已經
 *     沒有特別主日類型）；`source` 固定是 `'WEEK_TITLE'`，診斷報告用。
 * Raises:
 *   （無）
 */
function buildRosterWeekTitle_(serviceDateRow) {
  var row = serviceDateRow || {};
  var title = String(row.Title === null || row.Title === undefined ? '' : row.Title).trim();
  var serviceType = String(row.ServiceType === null || row.ServiceType === undefined ? '' : row.ServiceType).trim();
  if (!title || title === serviceType) return null;
  return { title: title, type: '', source: 'WEEK_TITLE' };
}

// =====================================================================
// 崗位 slot 狀態
// =====================================================================

/**
 * slot 的三種狀態。週報對每一種的處理完全不同，所以**不可以**一律顯示
 * 「（未排定）」——實測 2027-10-10 的聖餐襄禮與講員同樣顯示「（未排定）」，
 * 但前者那一週根本不設這個崗位（整行不應該出現），後者只是等人手填
 * （要顯示空白並列入待填清單）。見 docs/已知bug類型.md 事故五。
 *
 * ⚠️ 2026-10-27 拿走 `EXTERNAL`（外判單位）：那是 SpecialSundays.ExternalOwner 的功能，
 * 職事表第七十五輪起特別主日拿走，週報亦不再讀那張表。
 */
var ROSTER_SLOT_STATE_ = Object.freeze({
  ASSIGNED: 'ASSIGNED',
  NOT_APPLICABLE: 'NOT_APPLICABLE',
  PENDING: 'PENDING'
});

/**
 * 職事表 `Posts.Frequency` 代表「只在每月首個主日出現」的取值。
 *
 * ⚠️ 這是**職事表的列舉值**，跟 rosterIsTrueValue_() 的布林語意一樣屬於
 * 「照抄對方實作」的東西，不是我們自己的設定——所以放在程式碼而不是
 * Config。真正屬於我們的規則是「首個主日是第幾週」，那一項在 Config 的
 * `COMMUNION_WEEKS`，由呼叫方讀好傳進來。
 */
var ROSTER_FREQUENCY_FIRST_SUNDAY_ = 'FIRST_SUNDAY';

/**
 * 用途：判斷一個 slot 的狀態，三選一。
 *
 *   判斷次序（**不可以調換**）：
 *     1. `NOT_APPLICABLE`——這一週不設這個崗位：
 *        a. `RuleFlags` 有 Config `ROSTER_NOT_APPLICABLE_RULE_FLAGS` 其中一個代號
 *           （預設 `HARD_COMMUNION_FIRST_SUNDAY`、`HARD_SPECIAL_SUNDAY_SKIP`；職事表第八十二輪
 *           說明第 3 節）；或者
 *        b. 後備：`Posts.Frequency` 是 `FIRST_SUNDAY` 而這一週不是聖餐週（舊版本沒有
 *           RuleFlags、或者這個崗位這一週根本沒有那一格時用）。
 *     2. `ASSIGNED`——已排定人選（名字已經去掉「不是人」的顯示字，見
 *        resolveRosterAssignmentPerson_()）。
 *     3. `PENDING`——有這個 slot 但未排人。合堂那一週幹事在職事表人手清空的格（沒有
 *        PersonID、名字和 RuleFlags）就是這一種：不出錯、不記警告。
 *
 *   為什麼「不設」要排最先：這一週「根本不設這個崗位」是關於**版面
 *   結構**的判斷（那一行整行不出現），而其餘兩種都是關於**那一格填什麼
 *   內容**。結構先於內容——如果先判斷「有沒有人名」，一個沒有人名的
 *   聖餐襄禮就會被當成 PENDING 而列入待填清單，叫幹事去填一個那一週
 *   根本不存在的崗位。職事表的 `isStructuralNotApplicable_()` 也是同一個
 *   優先級，兩邊一致才不會出現「職事表當它不存在、週報當它待填」。
 * Args:
 *   ctx {{postId:string, personName:string, frequency:string,
 *        weekOfMonth:number, communionWeeks:number[], ruleFlags:(string[]|undefined),
 *        notApplicableRuleFlags:(string[]|undefined)}} 判斷所需的全部資料。
 *     刻意用明確參數而不是直接吃 snapshot，讓這個判斷可以獨立測試。
 * Returns:
 *   {string} ROSTER_SLOT_STATE_ 的其中一個值。
 */
function resolveRosterSlotState_(ctx) {
  var ruleFlags = ctx.ruleFlags || [];
  var naFlags = ctx.notApplicableRuleFlags || [];

  // 1a. RuleFlags 講明這一週不設。
  var flaggedNotApplicable = ruleFlags.some(function (flag) { return naFlags.indexOf(flag) !== -1; });

  // 1b. 後備：只在首主日出現的崗位，而這一週不是聖餐週。
  var isFirstSundayOnlyPost = ctx.frequency === ROSTER_FREQUENCY_FIRST_SUNDAY_;
  var thisWeekIsCommunionWeek = (ctx.communionWeeks || []).indexOf(ctx.weekOfMonth) !== -1;
  var structurallyNotApplicable = isFirstSundayOnlyPost && !thisWeekIsCommunionWeek;

  if (flaggedNotApplicable || structurallyNotApplicable) {
    return ROSTER_SLOT_STATE_.NOT_APPLICABLE;
  }

  // 2. 已排定。
  if (ctx.personName) {
    return ROSTER_SLOT_STATE_.ASSIGNED;
  }

  // 3. 有這個 slot 但未排人。
  return ROSTER_SLOT_STATE_.PENDING;
}

/**
 * 用途：把快照的派工紀錄整理成「崗位 → slot 陣列」的索引，並為每個 slot
 *   算好 `state`。快照內 `snapshot.posts` 列出的每一個啟用崗位都會有一個
 *   條目——即使該崗位這一週完全沒有派工紀錄，也會補一個空白 slot，
 *   好讓下游分得清「這個崗位不適用」與「這個崗位等人手填」。
 * Args:
 *   snapshot {Object} 已經填好 posts／assignments／weekOfMonth 的快照。
 *   communionWeeks {number[]} Config COMMUNION_WEEKS 解析後的週次陣列。
 *   notApplicableRuleFlags {string[]=} Config ROSTER_NOT_APPLICABLE_RULE_FLAGS 解析後的代號；
 *     省略＝空陣列（只看後備規則）。
 * Returns:
 *   {Object<string, Object[]>} postId → slot 陣列（按 slotIndex 排序）。
 *     slot 形狀：`{ postId, slotIndex, personId, personName, assignSource,
 *     locked, ruleFlags, state }`。
 */
function buildRosterSlotIndex_(snapshot, communionWeeks, notApplicableRuleFlags) {
  var naFlags = notApplicableRuleFlags || [];

  var frequencyByPostId = {};
  (snapshot.posts || []).forEach(function (p) { frequencyByPostId[p.postId] = p.frequency; });

  var assignmentsByPostId = {};
  (snapshot.assignments || []).forEach(function (a) {
    if (!assignmentsByPostId[a.postId]) assignmentsByPostId[a.postId] = [];
    assignmentsByPostId[a.postId].push(a);
  });

  // 崗位清單＝啟用崗位 ∪ 實際有派工紀錄的崗位（後者是防呆：職事表把某個
  // 崗位停用了、但舊的派工紀錄還在，我們寧可照樣顯示也不要靜靜漏掉）。
  var postIds = (snapshot.posts || []).map(function (p) { return p.postId; });
  Object.keys(assignmentsByPostId).forEach(function (postId) {
    if (postIds.indexOf(postId) === -1) postIds.push(postId);
  });

  var slotsByPost = {};
  postIds.forEach(function (postId) {
    var rows = (assignmentsByPostId[postId] || []).slice().sort(function (a, b) {
      return (a.slotIndex || 0) - (b.slotIndex || 0);
    });

    // 完全沒有派工紀錄時補一個空白 slot：這個崗位在版面上仍然存在，
    // 只是未排人（或者結構上不適用），下面的 state 判斷會分辨得出來。
    if (rows.length === 0) {
      rows = [{ postId: postId, slotIndex: 1, personId: null, personName: '', assignSource: '', locked: false, ruleFlags: [] }];
    }

    slotsByPost[postId] = rows.map(function (a) {
      var ruleFlags = a.ruleFlags || [];
      var state = resolveRosterSlotState_({
        postId: postId,
        personName: a.personName,
        frequency: frequencyByPostId[postId] || '',
        weekOfMonth: snapshot.weekOfMonth,
        communionWeeks: communionWeeks,
        ruleFlags: ruleFlags,
        notApplicableRuleFlags: naFlags
      });
      return {
        postId: postId,
        slotIndex: a.slotIndex,
        personId: a.personId,
        personName: a.personName,
        assignSource: a.assignSource,
        locked: a.locked,
        ruleFlags: ruleFlags.slice(),
        state: state
      };
    });
  });

  return slotsByPost;
}

/**
 * 用途：判斷一個（已正規化的）ServiceDate 值是不是剛好等於指定的年／月／日。
 * Args:
 *   dateValue {*} 應該是 Date 或 null（rosterToDateLenient_() 的輸出）。
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
 * 用途：判斷一段職事表的名字是不是「不是人」的顯示字（職事表第八十二輪說明第 3.1 節）。純函式。
 * Args:
 *   text {*} `PersonNameSnapshot`（或者覆寫時記下的職事表值）。
 *   notAPersonTexts {string[]} Config `ROSTER_NOT_A_PERSON_TEXTS` 解析後的清單。
 * Returns:
 *   {boolean} 去頭尾空白之後與清單其中一項完全相同就回 true；空白回 false。
 * Raises:
 *   （無）
 */
function isRosterNotAPersonText_(text, notAPersonTexts) {
  var t = String(text === null || text === undefined ? '' : text).trim();
  if (!t) return false;
  return (notAPersonTexts || []).indexOf(t) !== -1;
}

/**
 * 用途：把職事表的名字去掉「不是人」的顯示字：是顯示字就回空字串，否則回去頭尾空白的名字。
 *   純函式。
 * Args:
 *   text {*} 職事表的名字。
 *   notAPersonTexts {string[]} 同 isRosterNotAPersonText_()。
 * Returns:
 *   {string}
 * Raises:
 *   （無）
 */
function rosterPersonTextOrBlank_(text, notAPersonTexts) {
  if (isRosterNotAPersonText_(text, notAPersonTexts)) return '';
  return String(text === null || text === undefined ? '' : text).trim();
}

/**
 * 用途：把一筆 RosterAssignments 原始資料，解析出 personId／personName，
 *   規則見 docs/職事表唯讀介面.md 的錯誤處理契約表。
 *
 *   名字的來源（職事表第八十二輪說明第 1、3.1、4 節）：
 *     - 有 PersonID、NameMapping 找得到 → `NameMapping.NameTC`。
 *     - 有 PersonID、NameMapping 找不到 → `PersonNameSnapshot`（去掉顯示字），記一筆警告。
 *     - 沒有 PersonID → `PersonNameSnapshot`（外請講員、臨時幫手）；是「（待填）」「—」
 *       「待確認」之類的顯示字就當空白（未排定），**不記警告**——那是職事表正常的顯示，
 *       不是錯。
 * Args:
 *   a {Object} tables.assignments 其中一行。
 *   nameByPersonId {Object<string,Object>} PersonID → NameMapping 那一行。
 *   warnings {{code:string,message:string}[]} 累積警告用的陣列，這個函式
 *     可能會往裡面 push。
 *   notAPersonTexts {string[]=} 「不是人」的顯示字；省略＝空陣列。
 * Returns:
 *   {{postId:string, slotIndex:number, personId:(string|null),
 *     personName:string, assignSource:string, locked:boolean, ruleFlags:string[]}}
 */
function resolveRosterAssignmentPerson_(a, nameByPersonId, warnings, notAPersonTexts) {
  var snapshotName = rosterPersonTextOrBlank_(a.PersonNameSnapshot, notAPersonTexts || []);

  var personId = null;
  var personName = snapshotName;

  if (a.PersonID) {
    personId = a.PersonID;
    var match = nameByPersonId[a.PersonID];
    if (match) {
      personName = match.NameTC;
    } else {
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
    locked: Boolean(a.Locked),
    ruleFlags: parseRosterIdList_(a.RuleFlags)
  };
}

/**
 * 用途：把 `RosterAssignments.RuleFlags` 這類逗號分隔字串解析成陣列，支援
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
