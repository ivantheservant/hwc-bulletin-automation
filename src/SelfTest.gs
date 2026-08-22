/**
 * SelfTest.gs
 *
 * 第 2 層：**真環境自測機**——在真的 Apps Script、真的試算表上，由**真實
 * 入口**造出狀態，然後斷言。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 核心原則：每一個狀態都必須由真實入口造出來
 * ─────────────────────────────────────────────────────────────────────
 *
 *   要一個「已匯入內容、已產生 Word、已發佈過一次」的狀態，唯一合法做法
 *   是真的呼叫 `applyContentImport_()` → 真的呼叫 `saveBulletinDocx_()` →
 *   真的呼叫 `runPublishFlow_()`。
 *
 *   **不可以**直接寫 `PublishLog` 然後假設狀態成立。違反這一條，這一層
 *   就退化成第 171 條假綠燈——那正是這個專案至今每一個 bug 的形狀。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ⚠️ 沙盒規則（違反任何一條，整套設計就失效）
 * ─────────────────────────────────────────────────────────────────────
 *
 *   1. **`DRY_RUN` 必須是 `TRUE`。** 否則即刻停，一個情境都不跑。
 *   2. **只准寫 Config `SELFTEST_QUARTER_ID` 那一季。** 每一次寫入之前
 *      都要經 `assertSelfTestWritableDate_()`／`assertSelfTestWritableQuarter_()`。
 *   3. **職事表零寫入。** 開跑前記下版本記錄行數，跑完由不變量 I10 比對。
 *   4. 需要真實職事表資料的情境，讀 `SELFTEST_ROSTER_QUARTER_ID`，**只讀**。
 *   5. 每次開跑先把沙盒季度的資料清乾淨，令每次都由同一個起點開始。
 *
 *   ⚠️ 沙盒季度刻意選一個**職事表沒有資料**的季度（預設 `2028T4`）：
 *   一來寫錯了也傷不到真資料，二來順便測「職事表無資料」那一條路。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ⚠️ 執行時間：不可以靜靜停低
 * ─────────────────────────────────────────────────────────────────────
 *
 *   Apps Script 有 6 分鐘上限。每個情境開始前檢查已用時間，接近上限就
 *   **乾淨地停低**，並在報告寫明「跑到 S07，還有 11 個未跑，請執行
 *   〔繼續跑自測〕」。
 *
 *   停低而不講，就變成「跑完了，全綠」的假象——那比不跑更差。
 */

'use strict';

/** 情境的四種結果。`SKIPPED` 是「前置條件未滿足」，不是通過。 */
var SELF_TEST_RESULT_ = Object.freeze({
  PASS: 'PASS', FAIL: 'FAIL', SKIPPED: 'SKIPPED', PENDING: 'PENDING'
});

/** 沙盒內容表檔名的後綴——確保永遠不會撞正式那一個。 */
var SELF_TEST_CONTENT_SUFFIX_ = '_SELFTEST';

// =====================================================================
// 沙盒守門
// =====================================================================

/**
 * 用途：一次過讀齊自測機要用的設定。
 * Args: （無）
 * Returns:
 *   {{quarterId:string, rosterQuarterId:string, masterFileId:string,
 *     timeBudgetMs:number, dryRun:boolean, contentFolderId:string}}
 */
function selfTestConfig_() {
  var budgetSec = normalizeInt_(getConfig(CONFIG_KEYS.SELFTEST_TIME_BUDGET_SEC, '240'));
  if (budgetSec === null || budgetSec <= 0) budgetSec = 240;

  return {
    quarterId: String(getConfig(CONFIG_KEYS.SELFTEST_QUARTER_ID, '2028T4') || '').trim(),
    rosterQuarterId: String(getConfig(CONFIG_KEYS.SELFTEST_ROSTER_QUARTER_ID, '2027T4') || '').trim(),
    masterFileId: String(getConfig(CONFIG_KEYS.SELFTEST_MASTER_PDF_FILE_ID, '') || '').trim(),
    contentFolderId: String(getConfig(CONFIG_KEYS.CONTENT_SHEET_FOLDER_ID, '') || '').trim(),
    timeBudgetMs: budgetSec * 1000,
    dryRun: normalizeBoolean_(getConfig(CONFIG_KEYS.DRY_RUN, 'TRUE')) === true
  };
}

/**
 * 用途：開跑前的守門。**任何一條不成立就不准開跑。**
 *
 *   ⚠️ 這一支是整套自測機唯一的安全邊界。它回 `ok:false` 的時候，
 *   呼叫方**必須**立刻停——不可以「先跑幾個看看」。
 * Args:
 *   config {Object} `selfTestConfig_()` 的回傳值。
 * Returns:
 *   {{ok:boolean, message:string}}
 */
function assertSelfTestSandbox_(config) {
  if (!config.dryRun) {
    return {
      ok: false,
      message: '自測機不會在真實寄信模式下執行。請先把 Config 的 DRY_RUN 改回 TRUE，然後再試一次。'
        + '（自測機會真的走一次寄出流程；DRY_RUN=FALSE 之下那些信會真的寄給全教會，而且收不回來。）'
    };
  }

  if (!config.quarterId) {
    return {
      ok: false,
      message: '尚未設定沙盒季度。請在 Config 的 ' + CONFIG_KEYS.SELFTEST_QUARTER_ID
        + ' 填入一個**職事表沒有資料**的季度（預設 2028T4）。'
    };
  }

  if (config.quarterId === config.rosterQuarterId) {
    return {
      ok: false,
      message: '沙盒季度（' + config.quarterId + '）跟「只讀的職事表季度」是同一季。'
        + '自測機會清空並改寫沙盒季度的資料——兩者相同的話，真實資料會被清走。'
        + '請把 ' + CONFIG_KEYS.SELFTEST_QUARTER_ID + ' 改成一個不會用到的季度。'
    };
  }

  try {
    normalizeQuarterId_(config.quarterId);
  } catch (err) {
    return { ok: false, message: '沙盒季度格式不正確：' + ((err && err.message) ? err.message : String(err)) };
  }

  return { ok: true, message: '' };
}

/**
 * 用途：確認某一個季度是沙盒季度，否則拋錯。**每一次寫入之前都要叫。**
 * Args:
 *   quarterId {string} 要寫入的季度。
 *   config {Object} `selfTestConfig_()` 的回傳值。
 * Returns:
 *   {void}
 * Raises:
 *   Error 如果不是沙盒季度。
 */
function assertSelfTestWritableQuarter_(quarterId, config) {
  var target = String(quarterId || '').trim();
  if (target !== config.quarterId) {
    throw new Error('自測機只准寫沙盒季度（' + config.quarterId + '），但這一次想寫「'
      + target + '」。已經中止，一格都沒有寫。');
  }
}

/**
 * 用途：確認某一個主日屬於沙盒季度，否則拋錯。
 * Args:
 *   isoDate {string} 主日日期。
 *   config {Object} `selfTestConfig_()` 的回傳值。
 * Returns:
 *   {void}
 * Raises:
 *   Error 如果那一個主日不在沙盒季度內。
 */
function assertSelfTestWritableDate_(isoDate, config) {
  var target = String(isoDate || '').trim();
  var dates = selfTestSandboxDates_(config);
  if (dates.indexOf(target) === -1) {
    throw new Error('自測機只准寫沙盒季度（' + config.quarterId + '）的主日，但這一次想寫「'
      + target + '」。沙盒季度的主日是：' + dates.join('、') + '。已經中止，一格都沒有寫。');
  }
}

// =====================================================================
// 沙盒的主日清單
// =====================================================================

/**
 * 用途：算出沙盒季度有哪幾個主日。
 *
 *   ⚠️ 先問職事表（真實入口）。職事表**沒有**這一季的資料時（預設的
 *   `2028T4` 正是刻意選一個沒有資料的季度），退回用曆法推算——
 *   `YYYYTn` 的 `n` 當成日曆季度（T1＝1–3 月、T2＝4–6 月、T3＝7–9 月、
 *   T4＝10–12 月）。
 *
 *   ⚠️ **這個對應關係是本專案自己的假設，不是職事表系統的規格**：
 *   職事表怎樣切季度，本專案從來沒有、也不需要知道（生產路徑一律直接
 *   讀 `ServiceDates`）。沙盒季度既然職事表沒有資料，用哪幾個月其實
 *   不影響要驗的東西——要驗的是系統的管道，不是月曆。這個限制記在
 *   docs/待確認事項.md。
 * Args:
 *   config {Object} `selfTestConfig_()` 的回傳值。
 * Returns:
 *   {string[]} yyyy-MM-dd，由小到大。
 */
function selfTestSandboxDates_(config) {
  var fromRoster = [];
  try {
    fromRoster = listRosterServiceDatesForQuarter_(config.quarterId);
  } catch (err) {
    fromRoster = [];
  }
  if (fromRoster.length > 0) return fromRoster;

  return selfTestCalendarSundays_(config.quarterId);
}

/**
 * 用途：用曆法推算一個季度內全部星期日。**純函式。**
 * Args:
 *   quarterId {string} `YYYYTn`。
 * Returns:
 *   {string[]} yyyy-MM-dd，由小到大；季度格式不對回空陣列。
 */
function selfTestCalendarSundays_(quarterId) {
  var m = /^(\d{4})T(\d)$/.exec(String(quarterId || '').trim());
  if (!m) return [];

  var year = Number(m[1]);
  var term = Number(m[2]);
  if (term < 1 || term > 4) return [];

  var startMonth = (term - 1) * 3;          // 0 起算
  var cursor = new Date(year, startMonth, 1);
  var endExclusive = new Date(year, startMonth + 3, 1);

  // 推到該季第一個星期日。
  cursor.setDate(cursor.getDate() + ((7 - cursor.getDay()) % 7));

  var dates = [];
  while (cursor.getTime() < endExclusive.getTime()) {
    dates.push(formatIsoDate_(cursor));
    cursor = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 7);
  }
  return dates;
}

// =====================================================================
// 清空沙盒
// =====================================================================

/**
 * 用途：把沙盒季度的資料清乾淨，令每次自測都由同一個起點開始、結果可
 *   重覆。
 *
 *   ⚠️ 這是全專案**唯一**准許刪行的地方之一（另一個是 `FillBackup`）。
 *   本專案的硬規則是「不刪行，只把 ACTIVE 改 FALSE」——但那條規則保護
 *   的是**真實資料**。沙盒季度的資料每一次自測都會重造，留住舊行只會
 *   令「結果可重覆」這個前提失效（第二次跑會看到第一次的殘留）。
 *
 *   ⚠️ 每一行刪之前都確認過屬於沙盒季度／沙盒主日。判斷不到的一律**不刪**
 *   ——寧可留一行垃圾，都不可以誤刪真資料。
 * Args:
 *   config {Object} `selfTestConfig_()` 的回傳值。
 * Returns:
 *   {{deletedBySheet:Object<string,number>, total:number}}
 */
function resetSelfTestSandbox_(config) {
  var sandboxDates = {};
  selfTestSandboxDates_(config).forEach(function (iso) { sandboxDates[iso] = true; });

  var deletedBySheet = {};
  var total = 0;

  // 一個主日多行的那幾張：靠 SERVICE_DATE 判斷。
  [SHEETS.ANNOUNCEMENTS, SHEETS.PRAYERS, SHEETS.FELLOWSHIPS, SHEETS.FINANCE,
    SHEETS.DUTY_OVERRIDE, SHEETS.PUBLISH_LOG].forEach(function (sheetName) {
    var removed = selfTestDeleteRowsWhere_(sheetName, function (values, keys) {
      var iso = selfTestRowIsoDate_(values, keys, 'SERVICE_DATE');
      return Boolean(iso) && sandboxDates[iso] === true;
    });
    if (removed > 0) { deletedBySheet[sheetName] = removed; total += removed; }
  });

  // BulletinWeeks：靠 QUARTER_ID 判斷（比日期更直接，也擋得住「日期在
  // 沙盒範圍但季度標錯」那種行）。
  var weekRemoved = selfTestDeleteRowsWhere_(SHEETS.BULLETIN_WEEKS, function (values, keys) {
    var idx = keys.indexOf('QUARTER_ID');
    if (idx === -1) return false;
    return String(values[idx] || '').trim() === config.quarterId;
  });
  if (weekRemoved > 0) { deletedBySheet[SHEETS.BULLETIN_WEEKS] = weekRemoved; total += weekRemoved; }

  // ContentSheets：只刪沙盒季度那一行登記（內容表檔案本身不刪——那是
  // Drive 上的檔案，重用比每次建立新檔安全，也省 Drive 配額）。
  var contentRemoved = selfTestDeleteRowsWhere_(SHEETS.CONTENT_SHEETS, function (values, keys) {
    var idx = keys.indexOf('QUARTER_ID');
    if (idx === -1) return false;
    return String(values[idx] || '').trim() === config.quarterId;
  });
  if (contentRemoved > 0) { deletedBySheet[SHEETS.CONTENT_SHEETS] = contentRemoved; total += contentRemoved; }

  return { deletedBySheet: deletedBySheet, total: total };
}

/**
 * 用途：把一行的某個日期欄位正規化成 `yyyy-MM-dd`。**純函式。**
 * Args:
 *   values {Array} 一行的原始值。
 *   keys {string[]} 那一張表的機器鍵。
 *   key {string} 要取哪一個欄位。
 * Returns:
 *   {string} 取不到回空字串。
 */
function selfTestRowIsoDate_(values, keys, key) {
  var idx = keys.indexOf(key);
  if (idx === -1) return '';
  var v = values[idx];
  if (Object.prototype.toString.call(v) === '[object Date]') return formatIsoDate_(v);
  return String(v === null || v === undefined ? '' : v).trim();
}

/**
 * 用途：刪走一張工作表內符合條件的資料列（第 3 行起）。
 *
 *   ⚠️ 由下往上刪：由上往下刪的話，刪完一行之後下面全部行號往前移，
 *   之後那幾個行號就全部指錯位置。
 * Args:
 *   sheetName {string} 工作表名稱。
 *   predicate {function(Array, string[]): boolean} 收到一行的原始值與
 *     機器鍵，回 `true` 代表要刪。
 * Returns:
 *   {number} 實際刪走幾行。
 */
function selfTestDeleteRowsWhere_(sheetName, predicate) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) return 0;

  var sheetId = SHEET_ID_BY_NAME[sheetName];
  var keys = COLUMNS[sheetId].keys;
  var lastRow = sheet.getLastRow();
  if (lastRow < 3) return 0;

  var values = sheet.getRange(3, 1, lastRow - 2, keys.length).getValues();
  var rowsToDelete = [];
  values.forEach(function (row, i) {
    var isBlank = row.every(function (cell) { return cell === '' || cell === null; });
    if (isBlank) return;
    if (predicate(row, keys)) rowsToDelete.push(i + 3);
  });

  rowsToDelete.sort(function (a, b) { return b - a; }).forEach(function (rowNo) {
    sheet.deleteRow(rowNo);
  });
  return rowsToDelete.length;
}

// =====================================================================
// 情境
// =====================================================================

/**
 * 用途：組出一個情境的結果。
 * Args:
 *   ok {?boolean} `true` 通過／`false` 失敗／`null` 略過（前置條件未滿足）。
 *   expected {*} 預期。
 *   actual {*} 實際。
 *   evidence {string} 證據——**每一條紅色都要拿得出實際的值**。
 * Returns:
 *   {{ok:?boolean, expected:string, actual:string, evidence:string}}
 */
function selfTestOutcome_(ok, expected, actual, evidence) {
  return {
    ok: (ok === true || ok === false) ? ok : null,
    expected: String(expected === undefined || expected === null ? '' : expected),
    actual: String(actual === undefined || actual === null ? '' : actual),
    evidence: String(evidence || '')
  };
}

/**
 * 用途：全部情境的定義。每一個 `S0x` 都是**獨立、可單獨重跑**的。
 *
 *   ⚠️ 中間一個爆了，後面照跑，最後一次過報——一個情境失敗就整批停,
 *   等於只看得到第一個問題。
 * Args: （無）
 * Returns:
 *   {{id:string, name:string, run:function(Object): Object}[]}
 */
function selfTestScenarios_() {
  return [
    { id: 'S01', name: '空季度：建立本季週報', run: selfTestS01_ },
    { id: 'S02', name: '讀職事表（只讀）：事奉格有值、尊稱正確', run: selfTestS02_ },
    { id: 'S03', name: '建立內容表：七張分頁齊、下拉選單正確', run: selfTestS03_ },
    { id: 'S04', name: '再建立一次：已更新未重建，人手資料一格未變', run: selfTestS04_ },
    { id: 'S05', name: '內容表寫 3 條家事報告（一條連續到跨 4 個主日）→ 匯入', run: selfTestS05_ },
    { id: 'S06', name: '立即再匯入：四個數字全 0（冪等）', run: selfTestS06_ },
    { id: 'S07', name: '清空內容表的代禱事項整張 → 匯入：資料不可以被清走', run: selfTestS07_ },
    { id: 'S08', name: '經真正的 apiSaveWeek 儲存一格', run: selfTestS08_ },
    { id: 'S09', name: '對唯讀欄位呼叫 apiSaveWeek（三種送法）：全部被拒，且沒有任何寫入', run: selfTestS09_ },
    { id: 'S10', name: '產生 Word（平常主日）：殘留 0、替換數 > 40', run: selfTestS10_ },
    { id: 'S11', name: '產生 Word（浸禮合堂，副框六欄全空）：整個表格已刪', run: selfTestS11_ },
    { id: 'S12', name: '浸禮副框只填主禮：第 1 列在、第 2、3 列已刪', run: selfTestS12_ },
    { id: 'S13', name: '發佈：MD5 改變、版本 +1、存檔副本在、檔案 ID 不變', run: selfTestS13_ },
    { id: 'S14', name: '即刻再發佈同一份：被防重複擋住，版本號不變', run: selfTestS14_ },
    { id: 'S15', name: '發佈上載 master 目前那一份：被拒，訊息正確', run: selfTestS15_ },
    { id: 'S16', name: '寄出（DRY_RUN）：預覽人數 === SendLog 封數，且有記內文', run: selfTestS16_ },
    { id: 'S17', name: '未填欄位檢查：清單條數 === 實際空格數', run: selfTestS17_ },
    { id: 'S18', name: '星期一自動寄出：選中的是下一個主日，DRY_RUN 之下沒有真寄', run: selfTestS18_ }
  ];
}

/**
 * S01：空季度 → 用**真實入口** `createBlankBulletinWeeks_()` 建立骨架，
 *   斷言 `BulletinWeeks` 行數 === 該季主日數。
 *
 *   ⚠️ 沙盒季度職事表沒有資料，所以真實入口會建立 0 行——那本身就是
 *   要驗的一條路（「職事表無資料」）。之後的情境需要有主日才跑得到，
 *   所以真實入口回 0 行時，改用曆法推算的主日補上骨架，並在證據講明
 *   **這一次用了哪一條路**。不講的話，S01 綠燈的意思會變得含糊。
 */
function selfTestS01_(ctx) {
  var config = ctx.config;
  assertSelfTestWritableQuarter_(config.quarterId, config);

  var rosterDates = [];
  try {
    rosterDates = listRosterServiceDatesForQuarter_(config.quarterId);
  } catch (err) {
    rosterDates = [];
  }

  var source;
  if (rosterDates.length > 0) {
    createBlankBulletinWeeks_(config.quarterId);
    source = '職事表 ServiceDates';
  } else {
    selfTestSeedSandboxWeeks_(config);
    source = '曆法推算（職事表沒有這一季的資料——這正是沙盒季度刻意選它的原因）';
  }

  var expectedDates = selfTestSandboxDates_(config);
  var actualRows = readSheet(SHEETS.BULLETIN_WEEKS).filter(function (r) {
    return String(r.QUARTER_ID || '').trim() === config.quarterId;
  });

  var ok = actualRows.length === expectedDates.length && expectedDates.length > 0;
  return selfTestOutcome_(ok,
    expectedDates.length + ' 行',
    actualRows.length + ' 行',
    '季度 ' + config.quarterId + '；主日來源：' + source
      + '；主日清單：' + expectedDates.join('、'));
}

/**
 * 用途：沙盒季度在職事表沒有資料時，補一批空白骨架。
 *
 *   ⚠️ 這**不是**「人手砌狀態」：它砌的是**輸入**（哪幾個主日存在），
 *   角色等同生產環境的職事表；下游全部狀態（內容、產出、發佈）仍然
 *   一律由真實入口造。分別在於「餵進去的原料」與「跑出來的結果」——
 *   前者本來就要有人提供，後者才是不可以假造的東西。
 * Args:
 *   config {Object} `selfTestConfig_()` 的回傳值。
 * Returns:
 *   {number} 新增的行數。
 */
function selfTestSeedSandboxWeeks_(config) {
  assertSelfTestWritableQuarter_(config.quarterId, config);

  var existing = {};
  readSheet(SHEETS.BULLETIN_WEEKS).forEach(function (r) {
    var iso = (Object.prototype.toString.call(r.SERVICE_DATE) === '[object Date]')
      ? formatIsoDate_(r.SERVICE_DATE) : String(r.SERVICE_DATE || '').trim();
    if (iso) existing[iso] = true;
  });

  var rows = [];
  selfTestCalendarSundays_(config.quarterId).forEach(function (iso) {
    if (existing[iso]) return;
    var targetDate = normalizeDate_(iso);
    rows.push({
      SERVICE_DATE: targetDate,
      QUARTER_ID: config.quarterId,
      WEEK_OF_MONTH: Math.floor((targetDate.getDate() - 1) / 7) + 1,
      PAGE_TITLE: getConfig(CONFIG_KEYS.DEFAULT_PAGE_TITLE, '崇拜程序'),
      PROGRAM_TEMPLATE_ID: getConfig(CONFIG_KEYS.TEMPLATE_DEFAULT, 'TPL_NORMAL'),
      PRELUDE: getConfig(CONFIG_KEYS.PRELUDE_DEFAULT, ''),
      ATTENDANCE_HEADING: getConfig(CONFIG_KEYS.DEFAULT_ATTENDANCE_HEADING, '上週主日崇拜人數'),
      ATTENDANCE_DATE: addDays_(targetDate, -7),
      NEXT_WEEK_HEADING: getConfig(CONFIG_KEYS.DEFAULT_NEXT_WEEK_HEADING, '下週主日崇拜聚會事奉肢體'),
      PRAYER_BLOCK_HEADING: getConfig(CONFIG_KEYS.DEFAULT_PRAYER_BLOCK_HEADING, '代禱事項'),
      STATUS: BULLETIN_WEEK_STATUS.DRAFT
    });
  });

  if (rows.length === 0) return 0;
  writeSheet(SHEETS.BULLETIN_WEEKS, rows);
  return rows.length;
}

/**
 * S02：讀職事表（`SELFTEST_ROSTER_QUARTER_ID`，**只讀**）→ 斷言事奉格
 *   有值、尊稱套用正確。
 *
 *   ⚠️ 刻意**不呼叫** `buildBulletinModel_()`：那一支在
 *   `PROGRAM_TEMPLATE_ID` 留空時會把推斷結果**寫回** `BulletinWeeks`
 *   （`persistInferredTemplateId_()`）——對一個非沙盒季度而言那是寫入，
 *   違反沙盒規則。改為直接用 `readRosterSnapshot_()` ＋ `buildDutyBox_()`，
 *   兩者都是唯讀。
 */
function selfTestS02_(ctx) {
  var config = ctx.config;
  var dates = [];
  try {
    dates = listRosterServiceDatesForQuarter_(config.rosterQuarterId);
  } catch (err) {
    return selfTestOutcome_(null, '職事表讀得到 ' + config.rosterQuarterId,
      '讀取失敗', (err && err.message) ? err.message : String(err));
  }

  if (dates.length === 0) {
    return selfTestOutcome_(null, '職事表有 ' + config.rosterQuarterId + ' 的資料', '一個主日都沒有',
      '職事表 ServiceDates 找不到季度「' + config.rosterQuarterId + '」。'
        + '請把 ' + CONFIG_KEYS.SELFTEST_ROSTER_QUARTER_ID + ' 改成一個真的有資料的季度。');
  }

  var isoDate = dates[0];
  var snapshot = readRosterSnapshot_(isoDate);
  var warnings = [];
  var dutyRows = buildDutyBox_(snapshot, 1, warnings, null);

  var filled = dutyRows.filter(function (row) {
    return (row.slots || []).some(function (s) { return String(s.displayText || '').trim(); });
  });
  var withHonorific = dutyRows.filter(function (row) {
    return (row.slots || []).some(function (s) {
      var text = String(s.displayText || '');
      return text.indexOf('弟兄') !== -1 || text.indexOf('姊妹') !== -1
        || text.indexOf('牧師') !== -1 || text.indexOf('傳道') !== -1 || text.indexOf('長老') !== -1;
    });
  });

  var ok = filled.length > 0;
  return selfTestOutcome_(ok, '至少一格事奉有值',
    filled.length + ' 個崗位有值（共 ' + dutyRows.length + ' 個）',
    '主日 ' + isoDate + '（' + config.rosterQuarterId + '，只讀）；'
      + '有套用尊稱的崗位：' + withHonorific.length + ' 個；'
      + (warnings.length > 0 ? ('警告 ' + warnings.length + ' 項：' + warnings.slice(0, 3).map(function (w) { return w.message; }).join('；')) : '沒有警告'));
}

/**
 * S03：用**真實入口** `buildOrRefreshContentSheet_()` 建立沙盒內容表。
 */
function selfTestS03_(ctx) {
  var config = ctx.config;
  if (!config.contentFolderId) {
    return selfTestOutcome_(null, '已設定內容表資料夾', '尚未設定',
      'Config 的 ' + CONFIG_KEYS.CONTENT_SHEET_FOLDER_ID + ' 是空的，所以略過 S03–S07。'
        + '⚠️ 「略過」不等於「通過」。');
  }
  assertSelfTestWritableQuarter_(config.quarterId, config);

  var result = buildOrRefreshContentSheet_(config.quarterId, {
    fileNameSuffix: SELF_TEST_CONTENT_SUFFIX_,
    serviceDates: selfTestSandboxDates_(config)
  });
  if (!result.ok) {
    return selfTestOutcome_(false, '建立成功', '失敗：' + result.reason, result.message || '');
  }

  var expectedTabs = contentSheetTabNames_();
  var spreadsheet = openContentSpreadsheet_(result.fileId);
  if (!spreadsheet) {
    return selfTestOutcome_(false, '內容表開得到', '開不到',
      '剛剛建立的內容表（' + maskContentFileId_(result.fileId) + '）開不到。');
  }

  var actualTabs = spreadsheet.getSheets().map(function (s) { return s.getName(); });
  var missing = expectedTabs.filter(function (t) { return actualTabs.indexOf(t) === -1; });

  var ok = missing.length === 0;
  return selfTestOutcome_(ok, expectedTabs.length + ' 張分頁齊備',
    (expectedTabs.length - missing.length) + '／' + expectedTabs.length + ' 張',
    '季度 ' + config.quarterId + '；本季主日 ' + result.serviceDateCount + ' 個；'
      + '實際分頁：' + actualTabs.join('、')
      + (missing.length > 0 ? ('；缺少：' + missing.join('、')) : ''));
}

/**
 * S04：再建立一次 → 斷言「已更新，未重建」，而且人手資料一格未變。
 *
 *   ⚠️ 這一條驗的是整個內容表功能最重要的一條保證：重建會令堂委已經
 *   填好的東西全部不見。
 */
function selfTestS04_(ctx) {
  var config = ctx.config;
  if (!config.contentFolderId) {
    return selfTestOutcome_(null, '已設定內容表資料夾', '尚未設定', '略過（同 S03）。');
  }

  var before = findContentSheetRow_(config.quarterId);
  if (!before) {
    return selfTestOutcome_(null, 'S03 已經建立好內容表', '找不到登記',
      'ContentSheets 沒有季度 ' + config.quarterId + ' 的登記——請先跑 S03。');
  }

  // 先在內容表寫一格「人手資料」，再建立一次，看它有沒有被清走。
  var spreadsheet = openContentSpreadsheet_(before.FILE_ID);
  var tabDef = contentSheetTabDefs_()[0];
  var sheet = spreadsheet.getSheetByName(tabDef.tabName);
  var marker = '自測標記 ' + ctx.runId;
  var textColIndex = tabDef.keys.indexOf('TEXT');
  if (textColIndex === -1) textColIndex = tabDef.keys.length - 1;
  sheet.getRange(CONTENT_SHEET_FIRST_DATA_ROW_ + 50, textColIndex + 1).setValue(marker);

  var result = buildOrRefreshContentSheet_(config.quarterId, {
    fileNameSuffix: SELF_TEST_CONTENT_SUFFIX_,
    serviceDates: selfTestSandboxDates_(config)
  });
  var after = findContentSheetRow_(config.quarterId);
  var stillThere = String(sheet.getRange(CONTENT_SHEET_FIRST_DATA_ROW_ + 50, textColIndex + 1).getValue() || '');

  var sameFile = after && String(after.FILE_ID) === String(before.FILE_ID);
  var ok = result.ok && result.created === false && sameFile && stillThere === marker;

  return selfTestOutcome_(ok, '已更新未重建、檔案 ID 不變、人手資料仍在',
    (result.created ? '重建了' : '未重建') + '；檔案 ID '
      + (sameFile ? '不變' : '變了') + '；人手資料 ' + (stillThere === marker ? '仍在' : '不見了'),
    '季度 ' + config.quarterId + '；寫入的標記：「' + marker + '」，'
      + '再建立之後讀回：「' + stillThere + '」。');
}

/**
 * S05：在內容表寫 3 條家事報告（其中一條「連續到」跨 4 個主日）→ 用
 *   **真實入口** `applyContentImport_()` 匯入 → 斷言展開後總行數 === 1+1+4。
 */
function selfTestS05_(ctx) {
  var config = ctx.config;
  if (!config.contentFolderId) {
    return selfTestOutcome_(null, '已設定內容表資料夾', '尚未設定', '略過（同 S03）。');
  }

  var row = findContentSheetRow_(config.quarterId);
  if (!row) {
    return selfTestOutcome_(null, 'S03 已經建立好內容表', '找不到登記', '請先跑 S03。');
  }

  var dates = selfTestSandboxDates_(config);
  if (dates.length < 4) {
    return selfTestOutcome_(null, '沙盒季度至少 4 個主日', dates.length + ' 個',
      '「連續到跨 4 個主日」需要至少 4 個主日。');
  }

  var spreadsheet = openContentSpreadsheet_(row.FILE_ID);
  var tabDef = selfTestFindTabDef_('家事報告');
  var sheet = spreadsheet.getSheetByName(tabDef.tabName);

  // 清走這一張的舊資料，再寫 3 條。⚠️ 這是**沙盒內容表**，不是正式那一個。
  selfTestClearContentTab_(sheet, tabDef);
  writeContentRows_(sheet, tabDef.keys, [
    { SERVICE_DATE: dates[0], SEQ_NO: 10, TEXT: '自測家事一', ACTIVE: 'TRUE' },
    { SERVICE_DATE: dates[1], SEQ_NO: 10, TEXT: '自測家事二', ACTIVE: 'TRUE' },
    { SERVICE_DATE: dates[0], SEQ_NO: 20, TEXT: '自測連登四週', REPEAT_UNTIL: dates[3], ACTIVE: 'TRUE' }
  ], CONTENT_SHEET_FIRST_DATA_ROW_);

  assertSelfTestWritableQuarter_(config.quarterId, config);
  var imported = applyContentImport_(config.quarterId);
  if (!imported.ok) {
    return selfTestOutcome_(false, '匯入成功', '失敗：' + imported.reason, imported.message || '');
  }

  var announcements = readSheet(SHEETS.ANNOUNCEMENTS).filter(function (r) {
    if (r.ACTIVE !== true) return false;
    var iso = (Object.prototype.toString.call(r.SERVICE_DATE) === '[object Date]')
      ? formatIsoDate_(r.SERVICE_DATE) : String(r.SERVICE_DATE || '').trim();
    return dates.indexOf(iso) !== -1;
  });

  // ⚠️ 有副作用的檢查（I08）只在匯入相關的情境明確呼叫，不放進
  // `runAllInvariants_()`——見 src/Invariants.gs 檔頭的說明。
  var stateful = runStatefulChecks_({ quarterId: config.quarterId });

  var expected = 1 + 1 + 4;
  var ok = announcements.length === expected && stateful.failedCount === 0;
  return selfTestOutcome_(ok, expected + ' 行（1 ＋ 1 ＋ 連登 4）、匯入是冪等的',
    announcements.length + ' 行'
      + (stateful.failedCount > 0 ? ('；' + selfTestStatefulSummary_(stateful)) : ''),
    '主日：' + dates.slice(0, 4).join('、') + '；'
      + '匯入計畫：新增 ' + imported.plan.added + '、修改 ' + imported.plan.updated
      + '、刪除 ' + imported.plan.removed + '、不變 ' + imported.plan.unchanged
      + '；' + selfTestStatefulSummary_(stateful));
}

/**
 * S06：立即再匯入 → 斷言四個數字全 0（冪等）。
 */
function selfTestS06_(ctx) {
  var config = ctx.config;
  if (!config.contentFolderId) {
    return selfTestOutcome_(null, '已設定內容表資料夾', '尚未設定', '略過（同 S03）。');
  }
  assertSelfTestWritableQuarter_(config.quarterId, config);

  // ⚠️ **連續匯入兩次**（S05 已經匯入過一次，所以合共三次）。
  // 只驗一次的話，「第二次 0 改動但第三次又有改動」這種狀態驗不出來
  // ——而財政欄位那個「文字被試算表轉成數字」的 bug 正是這種形狀。
  var rounds = [];
  for (var i = 0; i < 2; i++) {
    var result = applyContentImport_(config.quarterId);
    if (!result.ok) {
      return selfTestOutcome_(false, '匯入成功', '第 ' + (i + 2) + ' 次失敗：' + result.reason,
        result.message || '');
    }
    var p = result.plan;
    rounds.push({
      round: i + 2,
      changes: Number(p.added) + Number(p.updated) + Number(p.removed),
      detail: '新增 ' + p.added + '、修改 ' + p.updated + '、刪除 ' + p.removed + '、不變 ' + p.unchanged
    });
  }

  var stateful = runStatefulChecks_({ quarterId: config.quarterId });
  var bad = rounds.filter(function (r) { return r.changes !== 0; });
  var ok = bad.length === 0 && stateful.failedCount === 0;

  return selfTestOutcome_(ok, '第 2、3 次都是 0 項改動',
    rounds.map(function (r) { return '第 ' + r.round + ' 次 ' + r.changes + ' 項'; }).join('、'),
    rounds.map(function (r) { return '第 ' + r.round + ' 次：' + r.detail; }).join('；')
      + '；' + selfTestStatefulSummary_(stateful)
      + (ok ? '' : '　⚠️ 匯入之後再匯入應該完全沒有改動；有改動代表寫入的值與內容表的值格式不同'
        + '（例如文字被試算表自作主張轉成數字）。'));
}

/**
 * S07：清空內容表的「代禱事項」整張 → 匯入 → 斷言代禱資料**沒有被清走**，
 *   而且報告有「本次不改動」那一句。
 *
 *   ⚠️ 這一條擋住的是「有人不小心清空一張表，就把整季內容清光」。
 */
function selfTestS07_(ctx) {
  var config = ctx.config;
  if (!config.contentFolderId) {
    return selfTestOutcome_(null, '已設定內容表資料夾', '尚未設定', '略過（同 S03）。');
  }

  var row = findContentSheetRow_(config.quarterId);
  if (!row) return selfTestOutcome_(null, 'S03 已經建立好內容表', '找不到登記', '請先跑 S03。');

  var dates = selfTestSandboxDates_(config);
  var spreadsheet = openContentSpreadsheet_(row.FILE_ID);
  var tabDef = selfTestFindTabDef_('代禱');
  var sheet = spreadsheet.getSheetByName(tabDef.tabName);

  // 先放一條代禱進去並匯入，令週報那邊真的有資料可以「被清走」。
  selfTestClearContentTab_(sheet, tabDef);
  writeContentRows_(sheet, tabDef.keys,
    [{ SERVICE_DATE: dates[0], SEQ_NO: 10, TEXT: '自測代禱一', ACTIVE: 'TRUE' }],
    CONTENT_SHEET_FIRST_DATA_ROW_);
  assertSelfTestWritableQuarter_(config.quarterId, config);
  applyContentImport_(config.quarterId);

  var before = selfTestCountActive_(SHEETS.PRAYERS, dates);
  if (before === 0) {
    return selfTestOutcome_(false, '匯入之後代禱有資料', '0 行',
      '前置步驟本身就失敗了——沒有資料的話，「不會被清走」根本驗不到。');
  }

  // 現在把整張清空，再匯入。
  selfTestClearContentTab_(sheet, tabDef);
  var imported = applyContentImport_(config.quarterId);
  if (!imported.ok) {
    return selfTestOutcome_(false, '匯入成功', '失敗：' + imported.reason, imported.message || '');
  }

  var after = selfTestCountActive_(SHEETS.PRAYERS, dates);
  var lines = buildContentImportDialogLines_(imported, { applied: true }).join('\n');
  var saidSkipped = lines.indexOf('沒有資料，本次不改動') !== -1;

  var stateful = runStatefulChecks_({ quarterId: config.quarterId });
  var ok = after === before && saidSkipped && stateful.failedCount === 0;
  return selfTestOutcome_(ok, before + ' 行（一行都不可以少）並且報告講明「本次不改動」',
    after + ' 行；報告' + (saidSkipped ? '有' : '沒有') + '講明',
    '清空前 ' + before + ' 行、清空後 ' + after + ' 行；'
      + '略過的分頁：' + (imported.plan.skippedTabs.join('、') || '（沒有）')
      + '；' + selfTestStatefulSummary_(stateful));
}

/**
 * S08：經**真正的** `saveWeekFromWebApp_()` 儲存一格 → 斷言寫入成功、
 *   `AuditLog` 有記錄。
 */
function selfTestS08_(ctx) {
  var config = ctx.config;
  var dates = selfTestSandboxDates_(config);
  if (dates.length === 0) return selfTestOutcome_(null, '沙盒季度有主日', '0 個', '請先跑 S01。');

  var isoDate = dates[0];
  assertSelfTestWritableDate_(isoDate, config);

  var loaded = loadWeekForWebApp_(isoDate);
  var newTitle = '自測講題 ' + ctx.runId;
  var auditBefore = readSheet(SHEETS.AUDIT_LOG).length;

  var saved = saveWeekFromWebApp_({
    isoDate: isoDate,
    lastSavedAt: loaded.lastSavedAt,
    week: { SERMON_TITLE: newTitle },
    dutyEdits: []
  });

  var weekRow = findBulletinWeekRow_(readSheet(SHEETS.BULLETIN_WEEKS), isoDate) || {};
  var auditAfter = readSheet(SHEETS.AUDIT_LOG).length;

  var ok = String(weekRow.SERMON_TITLE || '') === newTitle
    && saved.changedFieldCount >= 1
    && auditAfter > auditBefore;

  return selfTestOutcome_(ok, '講題寫入成功、AuditLog 多至少一筆',
    '講題「' + String(weekRow.SERMON_TITLE || '') + '」、改動 ' + saved.changedFieldCount
      + ' 格、AuditLog 由 ' + auditBefore + ' 變 ' + auditAfter,
    '主日 ' + isoDate + '；儲存回覆：' + (saved.message ? saved.message.text : ''));
}

/**
 * S09：對唯讀欄位（家事報告）呼叫 `saveWeekFromWebApp_()` → 斷言被拒，
 *   而且**沒有任何寫入**。
 */
function selfTestS09_(ctx) {
  var config = ctx.config;
  var dates = selfTestSandboxDates_(config);
  if (dates.length === 0) return selfTestOutcome_(null, '沙盒季度有主日', '0 個', '請先跑 S01。');

  var isoDate = dates[0];
  assertSelfTestWritableDate_(isoDate, config);

  var loaded = loadWeekForWebApp_(isoDate);
  var auditBefore = readSheet(SHEETS.AUDIT_LOG).length;
  var announcementsBefore = selfTestCountActive_(SHEETS.ANNOUNCEMENTS, dates);

  // ⚠️ 這裡要送**真正的 payload 形狀**（四張清單在**頂層**，不是
  //    `lists: {...}`）。第一輪自測就是死在這一點：送了 `lists` 這個
  //    後端根本不會看的形狀，於是防線一次都沒有觸發，S09 卻報「竟然存得
  //    到」——測試量度的是一個兩邊都不認識的形狀，等於什麼都沒有測。
  //    （防線本身現在兩種形狀都認，但測試仍然要照真實形狀送。）
  var attempts = [
    {
      label: '清單（家事報告）',
      payload: {
        isoDate: isoDate, lastSavedAt: loaded.lastSavedAt, week: {},
        announcements: [{ TEXT: '這是唯讀欄位，不應該存得到' }],
        dutyEdits: []
      }
    },
    {
      label: '週欄位（宣召經文）',
      payload: {
        isoDate: isoDate, lastSavedAt: loaded.lastSavedAt,
        week: { CALL_TEXT: '這是唯讀欄位，不應該存得到' },
        dutyEdits: []
      }
    },
    {
      label: '唯讀欄位混一個可寫欄位（人數 ＋ 證道講題）',
      payload: {
        isoDate: isoDate, lastSavedAt: loaded.lastSavedAt,
        week: { ATT_ENG_WORSHIP: '99', SERMON_TITLE: '這一欄本來可以寫' },
        dutyEdits: []
      }
    }
  ];

  var results = [];
  attempts.forEach(function (attempt) {
    var rejected = false;
    var errorCode = '';
    var message = '';
    try {
      saveWeekFromWebApp_(attempt.payload);
    } catch (err) {
      rejected = true;
      errorCode = (err && err.code) || '';
      message = (err && err.message) ? err.message : String(err);
    }
    results.push({
      label: attempt.label, rejected: rejected, errorCode: errorCode,
      message: message, ok: rejected && errorCode === 'CONTENT_SHEET_READONLY'
    });
  });

  var auditAfter = readSheet(SHEETS.AUDIT_LOG).length;
  var announcementsAfter = selfTestCountActive_(SHEETS.ANNOUNCEMENTS, dates);
  var noWrite = auditAfter === auditBefore && announcementsAfter === announcementsBefore;

  var bad = results.filter(function (r) { return !r.ok; });
  var ok = bad.length === 0 && noWrite;

  // ⚠️ 第三個嘗試特別重要：它混了一個**本來可以寫**的欄位。整次儲存
  //    必須一齊拒絕——只擋唯讀那一欄、把可寫那一欄寫了，就變成「一半
  //    成功」，幹事以為全部存好了。所以上面才要驗 AuditLog 完全沒有增加。
  return selfTestOutcome_(ok, '三種送法全部被拒（CONTENT_SHEET_READONLY）且一格都沒有寫',
    (bad.length === 0 ? '三種全部被拒' : ('有 ' + bad.length + ' 種沒有被正確拒絕')) + '；'
      + (noWrite ? '沒有寫入' : '有寫入'),
    '主日 ' + isoDate + '；AuditLog ' + auditBefore + '→' + auditAfter
      + '；家事報告 ' + announcementsBefore + '→' + announcementsAfter + '\n'
      + results.map(function (r) {
          return '　' + r.label + '：' + (r.rejected ? ('被拒，代碼 ' + r.errorCode) : '竟然存得到')
            + (r.message ? ('；' + r.message.slice(0, 80)) : '');
        }).join('\n'));
}

/**
 * S10：用**真實入口** `saveBulletinDocx_()` 產生 Word，再用**第 4 層的
 *   產出斷言**（重新讀取檔案本身）驗殘留佔位符。
 */
function selfTestS10_(ctx) {
  var config = ctx.config;
  var dates = selfTestSandboxDates_(config);
  if (dates.length === 0) return selfTestOutcome_(null, '沙盒季度有主日', '0 個', '請先跑 S01。');
  if (!getConfig(CONFIG_KEYS.TEMPLATE_FILE_ID_NORMAL, '')) {
    return selfTestOutcome_(null, '已設定平常主日範本', '尚未設定',
      'Config 的 TEMPLATE_FILE_ID_NORMAL 是空的，略過。⚠️「略過」不等於「通過」。');
  }
  if (!getConfig(CONFIG_KEYS.BULLETIN_OUTPUT_FOLDER_ID, '')) {
    return selfTestOutcome_(null, '已設定輸出資料夾', '尚未設定',
      'Config 的 BULLETIN_OUTPUT_FOLDER_ID 是空的，略過。');
  }

  var isoDate = dates[0];
  assertSelfTestWritableDate_(isoDate, config);

  var result = saveBulletinDocx_(isoDate);
  if (!result.ok) {
    return selfTestOutcome_(false, '產生成功', '失敗：' + result.reason, result.message || '');
  }

  ctx.lastDocxFileId = result.file.fileId;
  var assertion = assertDocxOutput_(result.file.fileId);
  if (!assertion.ok) {
    return selfTestOutcome_(null, '產出驗得到', '驗不到', assertion.message);
  }

  var replaced = (result.stats && result.stats.replacedCount) || 0;
  var ok = assertion.residualPlaceholders === 0 && assertion.bytes > 0 && replaced > 40;

  return selfTestOutcome_(ok, '殘留 0、大小 > 0、替換數 > 40',
    '殘留 ' + assertion.residualPlaceholders + '、' + assertion.bytes + ' 位元組、替換 ' + replaced,
    '主日 ' + isoDate + '；檔案 ' + assertion.fileName + '（' + maskFileId_(result.file.fileId) + '）；'
      + buildDocxAssertionLines_(assertion).slice(2).join('　')
      + (assertion.residualPlaceholders > 0
        ? ('　殘留的：' + assertion.residualSamples.join('、')) : ''));
}

/**
 * S11：浸禮合堂、副框六欄**全空** → 斷言整個副框表格已刪，紙上沒有
 *   孤零零的標籤。
 */
function selfTestS11_(ctx) {
  return selfTestBaptismScenario_(ctx, {
    fields: {},
    expected: '副框整個表格不出現、沒有孤兒標籤',
    check: function (assertion) {
      var orphan = assertion.orphanLabels.filter(function (label) {
        return label.indexOf('浸禮') !== -1 || label.indexOf('入會') !== -1 || label.indexOf('奉獻') !== -1;
      });
      return { ok: orphan.length === 0, detail: '副框相關的孤兒標籤：' + (orphan.join('、') || '（沒有）') };
    }
  });
}

/**
 * S12：浸禮副框**只填「浸禮主禮」** → 斷言第 1 列在、第 2、3 列已刪。
 */
function selfTestS12_(ctx) {
  return selfTestBaptismScenario_(ctx, {
    fields: { BAPTISM_OFFICIANT: '自測牧師' },
    expected: '第 1 列在（看得到「自測牧師」）、第 2、3 列已刪',
    check: function (assertion, docText) {
      var hasOfficiant = docText.indexOf('自測牧師') !== -1;
      var orphan = assertion.orphanLabels.filter(function (label) {
        return label.indexOf('入會') !== -1 || label.indexOf('奉獻') !== -1;
      });
      return {
        ok: hasOfficiant && orphan.length === 0,
        detail: '產出' + (hasOfficiant ? '看得到' : '看不到') + '「自測牧師」；'
          + '第 2、3 列相關的孤兒標籤：' + (orphan.join('、') || '（沒有）')
      };
    }
  });
}

/**
 * 用途：S11／S12 共用的浸禮副框情境。
 * Args:
 *   ctx {Object} 情境上下文。
 *   spec {{fields:Object, expected:string, check:function}}
 * Returns:
 *   {Object} `selfTestOutcome_()`。
 */
function selfTestBaptismScenario_(ctx, spec) {
  var config = ctx.config;
  var dates = selfTestSandboxDates_(config);
  if (dates.length < 2) return selfTestOutcome_(null, '沙盒季度至少 2 個主日', dates.length + ' 個', '請先跑 S01。');

  var templateId = getConfig(CONFIG_KEYS.TEMPLATE_FILE_ID_COMBINED_BAPTISM, '');
  if (!templateId) {
    return selfTestOutcome_(null, '已設定浸禮合堂範本', '尚未設定',
      'Config 的 TEMPLATE_FILE_ID_COMBINED_BAPTISM 是空的，略過。⚠️「略過」不等於「通過」。');
  }
  if (!getConfig(CONFIG_KEYS.BULLETIN_OUTPUT_FOLDER_ID, '')) {
    return selfTestOutcome_(null, '已設定輸出資料夾', '尚未設定', '略過。');
  }

  // 用第二個主日，避免跟 S10 的產出混淆。
  var isoDate = dates[1];
  assertSelfTestWritableDate_(isoDate, config);

  // 經真正的儲存入口設定範本與副框欄位。
  var loaded = loadWeekForWebApp_(isoDate);
  var week = Object.assign({ PROGRAM_TEMPLATE_ID: 'TPL_COMBINED_BAPTISM' }, spec.fields);
  baptismBoxFieldKeys_().forEach(function (key) {
    if (!Object.prototype.hasOwnProperty.call(week, key)) week[key] = '';
  });
  saveWeekFromWebApp_({ isoDate: isoDate, lastSavedAt: loaded.lastSavedAt, week: week, dutyEdits: [] });

  var result = saveBulletinDocx_(isoDate);
  if (!result.ok) {
    return selfTestOutcome_(false, spec.expected, '產生失敗：' + result.reason, result.message || '');
  }

  var assertion = assertDocxOutput_(result.file.fileId);
  if (!assertion.ok) {
    return selfTestOutcome_(null, spec.expected, '驗不到', assertion.message);
  }

  var docText = selfTestReadDocxPlainText_(result.file.fileId);
  var verdict = spec.check(assertion, docText);
  var ok = verdict.ok && assertion.residualPlaceholders === 0;

  return selfTestOutcome_(ok, spec.expected,
    verdict.ok ? '符合' : '不符合',
    '主日 ' + isoDate + '；檔案 ' + maskFileId_(result.file.fileId) + '；'
      + verdict.detail + '；殘留佔位符 ' + assertion.residualPlaceholders
      + '；只有標題沒有資料的表格 ' + assertion.emptyTables.length + ' 個');
}

/**
 * 用途：讀出一份產出 `.docx` 的純文字（供 S12 檢查「紙上看不看得到某個
 *   名字」）。
 * Args:
 *   fileId {string} 檔案 ID。
 * Returns:
 *   {string} 讀不到回空字串。
 */
function selfTestReadDocxPlainText_(fileId) {
  var read = readOutputDocxById_(fileId);
  if (!read.ok) return '';
  try {
    var parts = [];
    unzipDocx_(read.blob).forEach(function (entry) {
      if (!isDocxTextPartName_(entry.name)) return;
      parts.push(docxExtractPlainText_(entry.blob.getDataAsString('UTF-8')));
    });
    return parts.join('\n');
  } catch (err) {
    return '';
  }
}

/**
 * S13：發佈——上載一個自造的 PDF → 斷言 master 的 MD5 改變、版本 +1、
 *   存檔副本存在、**master 檔案 ID 不變**。
 *
 *   ⚠️ 用 Config `SELFTEST_MASTER_PDF_FILE_ID` 那一個**沙盒** master
 *   檔案，絕對不碰正式那一個。沒有設定就略過並講明。
 */
function selfTestS13_(ctx) {
  var config = ctx.config;
  var guard = selfTestPublishGuard_(config);
  if (guard) return guard;

  var dates = selfTestSandboxDates_(config);
  var isoDate = dates[0];
  assertSelfTestWritableDate_(isoDate, config);

  var beforeBytes = readMasterPdfBytes_(config.masterFileId);
  var beforeFingerprint = pdfFingerprint_(beforeBytes || []);
  var beforeVersion = nextPublishVersion_(readSheet(SHEETS.PUBLISH_LOG), isoDate) - 1;

  var pdf = selfTestMakePdfBlob_('自測發佈 ' + ctx.runId);
  var pdfAssertion = assertPdfOutput_(pdf);
  if (!pdfAssertion.ok) {
    return selfTestOutcome_(false, '自造的 PDF 合法', '不合法', pdfAssertion.message);
  }

  var result = selfTestRunPublish_(config, {
    isoDate: isoDate, doPublish: true, doSend: false,
    pdfBase64: Utilities.base64Encode(pdf.getBytes()),
    pdfName: '自測.pdf', confirmed: true
  });
  if (!result.ok) {
    return selfTestOutcome_(false, '發佈成功', '失敗：' + result.reason, result.message || '');
  }

  ctx.lastPublishedPdfBase64 = Utilities.base64Encode(pdf.getBytes());

  var afterFingerprint = pdfFingerprint_(readMasterPdfBytes_(config.masterFileId) || []);
  var fingerprintChanged = Boolean(afterFingerprint) && afterFingerprint !== beforeFingerprint;
  var versionOk = result.published.versionNo === beforeVersion + 1;
  var idUnchanged = String(result.published.fileId) === String(config.masterFileId);
  var archiveOk = Boolean(result.published.archiveFileId);

  var ok = fingerprintChanged && versionOk && idUnchanged && archiveOk;
  return selfTestOutcome_(ok, 'MD5 改變、版本 ' + (beforeVersion + 1) + '、存檔副本存在、檔案 ID 不變',
    'MD5 ' + (fingerprintChanged ? '改變了' : '沒有改變') + '、版本 ' + result.published.versionNo
      + '、存檔副本 ' + (archiveOk ? '存在' : '沒有') + '、檔案 ID ' + (idUnchanged ? '不變' : '變了'),
    '主日 ' + isoDate + '；發佈前指紋 ' + (beforeFingerprint || '（讀不到）')
      + '；發佈後指紋 ' + (afterFingerprint || '（讀不到）')
      + '；存檔檔名 ' + result.published.archiveFileName);
}

/**
 * S14：即刻再發佈同一份 → 斷言被防重複擋住，版本號不變。
 */
function selfTestS14_(ctx) {
  var config = ctx.config;
  var guard = selfTestPublishGuard_(config);
  if (guard) return guard;
  if (!ctx.lastPublishedPdfBase64) {
    return selfTestOutcome_(null, 'S13 已經發佈過一次', 'S13 未跑或未成功', '請先跑 S13。');
  }

  var dates = selfTestSandboxDates_(config);
  var isoDate = dates[0];
  var versionBefore = nextPublishVersion_(readSheet(SHEETS.PUBLISH_LOG), isoDate) - 1;

  // 用一份**不同內容**的 PDF，確保被擋住的原因是防重複、不是「揀錯檔案」。
  var pdf = selfTestMakePdfBlob_('自測發佈第二次 ' + ctx.runId);
  var result = selfTestRunPublish_(config, {
    isoDate: isoDate, doPublish: true, doSend: false,
    pdfBase64: Utilities.base64Encode(pdf.getBytes()),
    pdfName: '自測2.pdf', confirmed: true
  });

  var versionAfter = nextPublishVersion_(readSheet(SHEETS.PUBLISH_LOG), isoDate) - 1;
  var ok = result.ok === true && result.duplicate === true && versionAfter === versionBefore;

  return selfTestOutcome_(ok, '被防重複擋住、版本號維持 ' + versionBefore,
    (result.duplicate ? '被擋住' : '沒有被擋住') + '、版本號 ' + versionAfter,
    '主日 ' + isoDate + '；回覆：' + ((result.lines || []).join(' ') || result.message || '')
      + '；PUBLISH_DEDUP_SEC=' + getConfig(CONFIG_KEYS.PUBLISH_DEDUP_SEC, '30'));
}

/**
 * S15：發佈時上載 master 目前那一份 → 斷言被拒，訊息正確。
 *
 *   ⚠️ 這一條驗的是「用舊內容覆寫自己」那一個實際發生過的事故。
 */
function selfTestS15_(ctx) {
  var config = ctx.config;
  var guard = selfTestPublishGuard_(config);
  if (guard) return guard;

  var currentBytes = readMasterPdfBytes_(config.masterFileId);
  if (!currentBytes || currentBytes.length === 0) {
    return selfTestOutcome_(null, '讀得到 master 目前內容', '讀不到',
      '沙盒 master 檔案（' + maskFileId_(config.masterFileId) + '）讀不到內容。');
  }

  var dates = selfTestSandboxDates_(config);
  // 用另一個主日，避開 S13／S14 留下的防重複時間窗。
  var isoDate = dates.length > 2 ? dates[2] : dates[0];
  assertSelfTestWritableDate_(isoDate, config);

  var result = selfTestRunPublish_(config, {
    isoDate: isoDate, doPublish: true, doSend: false,
    pdfBase64: Utilities.base64Encode(currentBytes),
    pdfName: '同一份.pdf', confirmed: true
  });

  var ok = result.ok === false && result.reason === 'UPLOAD_IS_CURRENT_MASTER';
  return selfTestOutcome_(ok, '被拒（UPLOAD_IS_CURRENT_MASTER）',
    result.ok === false ? ('被拒：' + result.reason) : '竟然發佈得到',
    '主日 ' + isoDate + '；訊息：' + String(result.message || '').slice(0, 160));
}

/**
 * 用途：S13–S15 共用的前置檢查——沒有沙盒 master 檔案就略過。
 * Args:
 *   config {Object} `selfTestConfig_()` 的回傳值。
 * Returns:
 *   {?Object} 要略過時回 `selfTestOutcome_()`；可以跑就回 `null`。
 */
function selfTestPublishGuard_(config) {
  if (!config.masterFileId) {
    return selfTestOutcome_(null, '已設定沙盒 master 發佈檔案', '尚未設定',
      'Config 的 ' + CONFIG_KEYS.SELFTEST_MASTER_PDF_FILE_ID + ' 是空的，所以略過 S13–S15。'
        + '⚠️ 自測機**絕對不會**碰正式那一個 master 檔案（' + CONFIG_KEYS.PUBLISHED_PDF_FILE_ID
        + '），所以要驗發佈就必須另外建立一個沙盒檔案並填在這裡。'
        + '「略過」不等於「通過」。');
  }
  if (selfTestSandboxDates_(config).length === 0) {
    return selfTestOutcome_(null, '沙盒季度有主日', '0 個', '請先跑 S01。');
  }
  return null;
}

/**
 * 用途：把發佈流程指到**沙盒** master 檔案，跑完再還原。
 *
 *   ⚠️ `runPublishFlow_()` 是真實入口，它讀 Config 的
 *   `PUBLISHED_PDF_FILE_ID`。自測機要驗它，又絕對不可以碰正式那個檔案，
 *   所以在呼叫前後暫時把那一格換成沙盒檔案 ID。
 *
 *   ⚠️ 用 `try/finally` 保證**無論如何都還原**——中途拋錯而沒有還原的話，
 *   之後每一次真實發佈都會寫進沙盒檔案，而且沒有人會發現。
 * Args:
 *   config {Object} `selfTestConfig_()` 的回傳值。
 *   payload {Object} 見 `runPublishFlow_()`。
 * Returns:
 *   {Object} `runPublishFlow_()` 的回傳值。
 */
function selfTestRunPublish_(config, payload) {
  var original = getConfig(CONFIG_KEYS.PUBLISHED_PDF_FILE_ID, '');
  setConfig(CONFIG_KEYS.PUBLISHED_PDF_FILE_ID, config.masterFileId);
  try {
    return runPublishFlow_(payload);
  } finally {
    setConfig(CONFIG_KEYS.PUBLISHED_PDF_FILE_ID, original);
  }
}

/**
 * 用途：造一份最小但合法的 PDF blob，供發佈情境上載。
 * Args:
 *   text {string} 內文（ASCII）。
 * Returns:
 *   {Blob}
 */
function selfTestMakePdfBlob_(text) {
  return Utilities.newBlob(buildMinimalPdfText_([String(text).replace(/[^\x20-\x7E]/g, '?')]),
    'application/pdf', 'selftest.pdf');
}

/**
 * S16：寄出（`DRY_RUN`）→ 斷言預覽人數 === `SendLog` 記錄封數，而且
 *   `SendLog` **有記錄整封信的主旨與內文**。
 */
function selfTestS16_(ctx) {
  var config = ctx.config;
  var dates = selfTestSandboxDates_(config);
  if (dates.length === 0) return selfTestOutcome_(null, '沙盒季度有主日', '0 個', '請先跑 S01。');

  var isoDate = dates[0];
  assertSelfTestWritableDate_(isoDate, config);

  var previewCount = resolveRecipients_(isoDate).recipients.length;
  if (previewCount === 0) {
    return selfTestOutcome_(null, '至少一個收件人', '0 個',
      'Recipients 沒有任何符合 SEND_GROUPS 的有效收件人，寄出情境驗不到。');
  }

  var sinceMs = new Date().getTime();
  var sent = sendBulletinForDate_(isoDate);

  var newRows = readSheet(SHEETS.SEND_LOG).filter(function (r) {
    return Object.prototype.toString.call(r.TIMESTAMP) === '[object Date]'
      && r.TIMESTAMP.getTime() >= sinceMs;
  });
  var realSends = newRows.filter(function (r) { return r.DRY_RUN !== true; });
  var withSubject = newRows.filter(function (r) { return String(r.SUBJECT || '').trim(); });
  var withBody = newRows.filter(function (r) { return String(r.BODY_PREVIEW || '').trim(); });

  var ok = newRows.length === previewCount
    && realSends.length === 0
    && withSubject.length === newRows.length
    && withBody.length === newRows.length;

  return selfTestOutcome_(ok,
    previewCount + ' 封、全部試行、每一封都有主旨與內文摘要',
    newRows.length + ' 封、真實寄出 ' + realSends.length + ' 封、'
      + withSubject.length + ' 封有主旨、' + withBody.length + ' 封有內文摘要',
    '主日 ' + isoDate + '；寄出流程回覆：試行 ' + sent.dryRun + '、收件人 ' + (sent.recipientCount || 0)
      + '；內文摘要樣本：' + (withBody.length > 0 ? String(withBody[0].BODY_PREVIEW).slice(0, 60) : '（沒有）'));
}

/**
 * S17：未填欄位檢查 → 斷言清單條數 === `BulletinWeeks` 實際空格數
 *   （**逐格數出來對**，不是信 `missing.length`）。
 */
function selfTestS17_(ctx) {
  var config = ctx.config;
  var dates = selfTestSandboxDates_(config);
  if (dates.length === 0) return selfTestOutcome_(null, '沙盒季度有主日', '0 個', '請先跑 S01。');

  var isoDate = dates[0];
  var model = buildBulletinModel_(isoDate);
  var reported = (model.missing || []).length;

  // ⚠️ 另一條路：直接由工作表逐格數。刻意**不呼叫** buildMissingList_()
  // ——它跟 model.missing 是同一支函式，兩邊會一齊錯、一齊報沒事。
  var weekRow = findBulletinWeekRow_(readSheet(SHEETS.BULLETIN_WEEKS), isoDate) || {};
  var recounted = 0;
  var detail = [];

  function isBlank(key) {
    var v = weekRow[key];
    return String(v === null || v === undefined ? '' : v).trim() === '';
  }
  if (isBlank('CALL_TEXT') && isBlank('CALL_REF')) { recounted++; detail.push('宣召'); }
  ['SCRIPTURE_REF', 'SERMON_TITLE', 'RESPONSE_HYMN', 'FLOWER_THIS_WEEK'].forEach(function (key) {
    if (isBlank(key)) { recounted++; detail.push(key); }
  });
  attendanceRowDefs_().forEach(function (def) {
    def.keys.forEach(function (key) { if (isBlank(key)) { recounted++; detail.push(key); } });
  });
  [[SHEETS.ANNOUNCEMENTS, '家事報告'], [SHEETS.PRAYERS, '代禱事項'], [SHEETS.FELLOWSHIPS, '團契聚會']]
    .forEach(function (pair) {
      if (selfTestCountActive_(pair[0], [isoDate]) === 0) { recounted++; detail.push(pair[1]); }
    });
  (model.dutyBoxPage1 || []).forEach(function (row) { if (row.isPending) recounted++; });

  var ok = reported === recounted;
  return selfTestOutcome_(ok, recounted + ' 項（逐格數出來）', reported + ' 項（系統報的）',
    '主日 ' + isoDate + '；逐格數到的空格：' + detail.join('、')
      + (ok ? '' : '　⚠️ 兩者對不上代表待填清單的判斷與工作表實況脫節。'));
}

/**
 * S18：星期一自動寄出那一支函式的**日期選擇邏輯**。
 *
 *   ⚠️ **刻意不直接呼叫 `weeklyBulletinSendTrigger_()`。** 那一支除了寄
 *   週報，還會順手跑 `sendConflictNoticeIfNeeded_()` 與
 *   `autoCreateNextQuarterFillGrids_()`——後者會**替真實季度建立季度
 *   填寫表**，直接違反「只准碰沙盒季度」這條沙盒規則。
 *
 *   所以這一條驗的是它決定「寄哪一個主日」的那一段邏輯（今日 ＋
 *   `SEND_TARGET_OFFSET_DAYS`、必須是星期日），加上 `DRY_RUN` 的狀態。
 *   **這是一個已知的覆蓋缺口**，寫在 docs/待確認事項.md，不當成已經驗過。
 */
function selfTestS18_(ctx) {
  var timezone = getConfig(CONFIG_KEYS.SYS_TIMEZONE, 'Pacific/Auckland');
  var todayIso = Utilities.formatDate(new Date(), timezone, 'yyyy-MM-dd');
  var offsetDays = normalizeInt_(getConfig(CONFIG_KEYS.SEND_TARGET_OFFSET_DAYS, '6'));
  var targetIso = addDaysToIsoDate_(todayIso, offsetDays);

  var isSunday = isIsoDateSunday_(targetIso);
  var nextSunday = nextSundayOnOrAfter_(todayIso);
  var picksNextSunday = targetIso === nextSunday;
  var dryRun = normalizeBoolean_(getConfig(CONFIG_KEYS.DRY_RUN, 'TRUE')) === true;

  var ok = isSunday && picksNextSunday && dryRun;
  return selfTestOutcome_(ok, '選中下一個主日（' + nextSunday + '）而且 DRY_RUN=TRUE',
    '選中 ' + targetIso + '（' + (isSunday ? '是' : '不是') + '星期日）、DRY_RUN=' + dryRun,
    '今日 ' + todayIso + ' ＋ SEND_TARGET_OFFSET_DAYS(' + offsetDays + ') = ' + targetIso
      + '　⚠️ 覆蓋缺口：這一條**沒有**真的呼叫 weeklyBulletinSendTrigger_()，'
      + '因為那一支會順手替真實季度建立季度填寫表，違反沙盒規則。'
      + '真正的觸發器行為仍然要人手驗一次。');
}

// =====================================================================
// 情境用到的小工具
// =====================================================================

/**
 * 用途：把 `runStatefulChecks_()` 的結果縮成一句可以放進證據的話。
 * Args:
 *   summary {Object} `runStatefulChecks_()` 的回傳值。
 * Returns:
 *   {string}
 */
function selfTestStatefulSummary_(summary) {
  if (summary.failedCount === 0) {
    return '有副作用的檢查：' + summary.okCount + ' 條通過、'
      + summary.unknownCount + ' 條驗證不到';
  }
  return '有副作用的檢查不成立：' + summary.failed.map(function (f) {
    var checkId = f.id;
    return checkId + '（預期 ' + f.expected + '，實際 ' + f.actual + '）';
  }).join('、');
}

/**
 * 用途：按分頁名稱的關鍵字找一個內容表分頁定義。
 * Args:
 *   keyword {string} 關鍵字（例如 `'家事報告'`）。
 * Returns:
 *   {Object} `contentSheetTabDefs_()` 其中一項。
 * Raises:
 *   Error 如果找不到——找不到代表分頁定義改過名，靜靜略過會令情境變成
 *     一個永遠通過的空殼。
 */
function selfTestFindTabDef_(keyword) {
  var found = contentSheetTabDefs_().filter(function (def) {
    return String(def.tabName).indexOf(keyword) !== -1;
  })[0];
  if (!found) {
    throw new Error('自測機找不到分頁名稱含「' + keyword + '」的內容表分頁定義。'
      + '目前的分頁：' + contentSheetTabNames_().join('、'));
  }
  return found;
}

/**
 * 用途：清空一張內容表分頁的資料區（第 3 行起），標題兩行不動。
 * Args:
 *   sheet {Sheet} 內容表的一張分頁。
 *   tabDef {Object} 對應的分頁定義。
 * Returns:
 *   {void}
 */
function selfTestClearContentTab_(sheet, tabDef) {
  var lastRow = sheet.getLastRow();
  if (lastRow < CONTENT_SHEET_FIRST_DATA_ROW_) return;
  sheet.getRange(CONTENT_SHEET_FIRST_DATA_ROW_, 1,
    lastRow - CONTENT_SHEET_FIRST_DATA_ROW_ + 1, tabDef.keys.length).clearContent();
}

/**
 * 用途：數一張「一個主日多行」的表，在指定那幾個主日有幾多行有效資料。
 * Args:
 *   sheetName {string} 工作表名稱。
 *   isoDates {string[]} 主日清單。
 * Returns:
 *   {number}
 */
function selfTestCountActive_(sheetName, isoDates) {
  var wanted = {};
  (isoDates || []).forEach(function (iso) { wanted[iso] = true; });

  return readSheet(sheetName).filter(function (r) {
    if (r.ACTIVE !== true) return false;
    var iso = (Object.prototype.toString.call(r.SERVICE_DATE) === '[object Date]')
      ? formatIsoDate_(r.SERVICE_DATE) : String(r.SERVICE_DATE || '').trim();
    return wanted[iso] === true;
  }).length;
}

// =====================================================================
// 執行器
// =====================================================================

/**
 * 用途：自測機的**真正入口**。
 * Args:
 *   options {{resume:boolean=}=} `resume:true` 由上次停低處接住。
 * Returns:
 *   {{ok:boolean, runId:string, message:string, results:Object[],
 *     passCount:number, failCount:number, skipCount:number,
 *     pendingIds:string[], stoppedForTime:boolean}}
 */
function runSelfTest_(options) {
  var opts = options || {};
  var config = selfTestConfig_();

  var guard = assertSelfTestSandbox_(config);
  if (!guard.ok) {
    return {
      ok: false, runId: '', message: guard.message, results: [],
      passCount: 0, failCount: 0, skipCount: 0, pendingIds: [], stoppedForTime: false
    };
  }

  var scenarios = selfTestScenarios_();
  var runId;
  var doneIds = {};

  if (opts.resume) {
    var previous = selfTestLatestRunId_();
    if (!previous) {
      return {
        ok: false, runId: '', message: '找不到未跑完的自測——請先執行〔跑自測〕。',
        results: [], passCount: 0, failCount: 0, skipCount: 0, pendingIds: [], stoppedForTime: false
      };
    }
    runId = previous;
    selfTestFinishedScenarioIds_(runId).forEach(function (id) { doneIds[id] = true; });
  } else {
    runId = 'ST' + Utilities.formatDate(new Date(), getConfig(CONFIG_KEYS.SYS_TIMEZONE, 'Pacific/Auckland'),
      'yyyyMMddHHmmss');
    resetSelfTestSandbox_(config);
  }

  var ctx = {
    config: config,
    runId: runId,
    rosterRevisionBaseline: driveCountRevisions_(getConfig(CONFIG_KEYS.ROSTER_SPREADSHEET_ID, '')),
    startMs: new Date().getTime()
  };

  var results = [];
  var stoppedForTime = false;

  for (var i = 0; i < scenarios.length; i++) {
    var scenario = scenarios[i];
    if (doneIds[scenario.id]) continue;

    // ⚠️ 每個情境開始前檢查時間預算。停低要**講出來**，不可以靜靜停。
    if (new Date().getTime() - ctx.startMs > config.timeBudgetMs) {
      stoppedForTime = true;
      break;
    }

    var startedAt = new Date();
    var outcome;
    try {
      outcome = scenario.run(ctx);
    } catch (err) {
      outcome = selfTestOutcome_(false, '情境跑得完', '拋出例外',
        ((err && err.message) ? err.message : String(err))
        + '　' + buildErrorDetail_(err, { argsSummary: 'scenario=' + scenario.id }));
    }

    // 每個情境跑完叫一次全部不變量。
    var invariants = runAllInvariants_({
      quarterId: config.quarterId,
      isoDate: selfTestSandboxDates_(config)[0] || '',
      docxFileId: ctx.lastDocxFileId,
      rosterRevisionBaseline: ctx.rosterRevisionBaseline
    });

    var finishedAt = new Date();
    var record = {
      id: scenario.id,
      name: scenario.name,
      result: outcome.ok === true ? SELF_TEST_RESULT_.PASS
        : (outcome.ok === false ? SELF_TEST_RESULT_.FAIL : SELF_TEST_RESULT_.SKIPPED),
      expected: outcome.expected,
      actual: outcome.actual,
      evidence: outcome.evidence,
      invariantFailures: invariants.failed.map(function (f) { return f.id; }),
      elapsedMs: finishedAt.getTime() - startedAt.getTime()
    };

    // 不變量紅了就算情境本身通過，整條也要變紅——「這一步做對了，但系統
    // 因此進入一個自相矛盾的狀態」跟「這一步做錯了」一樣嚴重。
    if (record.result === SELF_TEST_RESULT_.PASS && invariants.failedCount > 0) {
      record.result = SELF_TEST_RESULT_.FAIL;
      record.actual += '；不變量 ' + record.invariantFailures.join('、') + ' 不成立';
      record.evidence += '　⚠️ 情境本身通過，但跑完之後不變量不成立：'
        + invariants.failed.map(function (f) {
          return f.id + '（預期 ' + f.expected + '，實際 ' + f.actual + '）';
        }).join('；');
    }

    results.push(record);
    selfTestWriteReportRow_(runId, record, finishedAt);
    selfTestWriteStateRow_(runId, record, startedAt, finishedAt);
  }

  var doneNow = {};
  results.forEach(function (r) { doneNow[r.id] = true; });
  var pendingIds = scenarios
    .filter(function (s) { return !doneIds[s.id] && !doneNow[s.id]; })
    .map(function (s) { return s.id; });

  var summary = {
    ok: true,
    runId: runId,
    message: '',
    results: results,
    passCount: results.filter(function (r) { return r.result === SELF_TEST_RESULT_.PASS; }).length,
    failCount: results.filter(function (r) { return r.result === SELF_TEST_RESULT_.FAIL; }).length,
    skipCount: results.filter(function (r) { return r.result === SELF_TEST_RESULT_.SKIPPED; }).length,
    pendingIds: pendingIds,
    stoppedForTime: stoppedForTime,
    totalScenarios: scenarios.length
  };

  writeDiagnosticsReport_('自測機報告', buildSelfTestReportLines_(summary));
  return summary;
}

/**
 * 用途：把一個情境的結果寫入 `SelfTestReport`。
 * Args:
 *   runId {string} 執行編號。
 *   record {Object} 情境結果。
 *   at {Date} 時間。
 * Returns:
 *   {void}
 */
function selfTestWriteReportRow_(runId, record, at) {
  writeSheet(SHEETS.SELF_TEST_REPORT, [{
    RUN_ID: sanitizeCellText_(runId),
    SCENARIO_ID: sanitizeCellText_(record.id),
    SCENARIO_NAME: sanitizeCellText_(record.name),
    RESULT: sanitizeCellText_(record.result),
    EXPECTED: sanitizeCellText_(record.expected),
    ACTUAL: sanitizeCellText_(record.actual),
    EVIDENCE: sanitizeCellText_(record.evidence),
    ELAPSED_MS: Number(record.elapsedMs || 0),
    TIMESTAMP: at
  }]);
}

/**
 * 用途：把一個情境的續跑狀態寫入 `SelfTestState`。
 * Args:
 *   runId {string}　record {Object}　startedAt {Date}　finishedAt {Date}
 * Returns:
 *   {void}
 */
function selfTestWriteStateRow_(runId, record, startedAt, finishedAt) {
  writeSheet(SHEETS.SELF_TEST_STATE, [{
    RUN_ID: sanitizeCellText_(runId),
    SCENARIO_ID: sanitizeCellText_(record.id),
    STATUS: sanitizeCellText_(record.result),
    STARTED_AT: startedAt,
    FINISHED_AT: finishedAt,
    MESSAGE: sanitizeCellText_(record.actual)
  }]);
}

/**
 * 用途：找出最近一次自測的執行編號。
 * Args: （無）
 * Returns:
 *   {string} 沒有跑過回空字串。
 */
function selfTestLatestRunId_() {
  var rows = readSheet(SHEETS.SELF_TEST_STATE);
  if (rows.length === 0) return '';
  return String(rows[rows.length - 1].RUN_ID || '');
}

/**
 * 用途：列出某一次執行已經有結論的情境編號。
 * Args:
 *   runId {string} 執行編號。
 * Returns:
 *   {string[]}
 */
function selfTestFinishedScenarioIds_(runId) {
  return readSheet(SHEETS.SELF_TEST_STATE)
    .filter(function (r) {
      return String(r.RUN_ID || '') === String(runId)
        && String(r.STATUS || '') !== SELF_TEST_RESULT_.PENDING;
    })
    .map(function (r) { return String(r.SCENARIO_ID || ''); });
}

// =====================================================================
// 報告
// =====================================================================

/**
 * 用途：把自測結果排版成報告內容行。**純函式。**
 *
 *   ⚠️ 每一條紅色都要拿得出**實際的值**，不可以只寫「失敗」。
 *   ⚠️ 停低了一定要講明「跑到哪裏、還有幾多個未跑」——停低而不講，
 *   就變成「跑完了，全綠」的假象。
 * Args:
 *   summary {Object} `runSelfTest_()` 的回傳值。
 * Returns:
 *   {string[]}
 */
function buildSelfTestReportLines_(summary) {
  var lines = [];
  var total = summary.totalScenarios || summary.results.length;

  lines.push('自測機：' + total + ' 個情境，'
    + summary.passCount + ' 綠 ' + summary.failCount + ' 紅 '
    + summary.skipCount + ' 略過 ' + summary.pendingIds.length + ' 未跑');
  lines.push('執行編號：' + summary.runId);

  if (summary.stoppedForTime) {
    lines.push('');
    lines.push('⚠️ 執行時間到，已經乾淨停低。跑到 '
      + (summary.results.length > 0 ? summary.results[summary.results.length - 1].id : '（沒有跑到任何一個）')
      + '，還有 ' + summary.pendingIds.length + ' 個未跑（'
      + summary.pendingIds.join('、') + '），請執行〔繼續跑自測〕。');
  }

  var failed = summary.results.filter(function (r) { return r.result === SELF_TEST_RESULT_.FAIL; });
  if (failed.length > 0) {
    lines.push('');
    lines.push('【不通過】');
    failed.forEach(function (r) {
      lines.push('');
      var failedLabel = r.id + '　' + r.name;
      lines.push('🔴 ' + failedLabel);
      lines.push('　　預期：' + r.expected);
      lines.push('　　實際：' + r.actual);
      lines.push('　　證據：' + r.evidence);
    });
  }

  var skipped = summary.results.filter(function (r) { return r.result === SELF_TEST_RESULT_.SKIPPED; });
  if (skipped.length > 0) {
    lines.push('');
    lines.push('【略過（前置條件未滿足——「略過」不等於「通過」）】');
    skipped.forEach(function (r) {
      var skippedLabel = r.id + '　' + r.name;
      lines.push('⚪ ' + skippedLabel + '　' + r.actual + '　' + r.evidence);
    });
  }

  var passed = summary.results.filter(function (r) { return r.result === SELF_TEST_RESULT_.PASS; });
  if (passed.length > 0) {
    lines.push('');
    lines.push('【通過】');
    passed.forEach(function (r) {
      var passedLabel = r.id + '　' + r.name;
      lines.push('✅ ' + passedLabel + '　（' + r.elapsedMs + ' 毫秒）');
    });
  }

  return lines;
}

/**
 * 用途：把自測結果縮成對話框要顯示的摘要。**純函式。**
 * Args:
 *   summary {Object} `runSelfTest_()` 的回傳值。
 * Returns:
 *   {string}
 */
function buildSelfTestShortSummary_(summary) {
  if (!summary.ok) return summary.message;

  var total = summary.totalScenarios || summary.results.length;
  var lines = ['自測機：' + total + ' 個情境，'
    + summary.passCount + ' 綠 ' + summary.failCount + ' 紅 '
    + summary.skipCount + ' 略過 ' + summary.pendingIds.length + ' 未跑'];

  summary.results.filter(function (r) { return r.result === SELF_TEST_RESULT_.FAIL; })
    .forEach(function (r) {
      lines.push('');
      var shortLabel = r.id + '　' + r.name;
      lines.push('🔴 ' + shortLabel);
      lines.push('　預期：' + r.expected);
      lines.push('　實際：' + r.actual);
    });

  if (summary.stoppedForTime) {
    lines.push('');
    lines.push('⚠️ 執行時間到，已停低，還有 ' + summary.pendingIds.length
      + ' 個未跑，請執行〔繼續跑自測〕。');
  }

  lines.push('');
  lines.push('完整證據見 Diagnostics 的「自測機報告」與 SelfTestReport 工作表。');
  return lines.join('\n');
}

// =====================================================================
// 選單
// =====================================================================

/**
 * 用途：選單項目「跑自測（沙盒季度，DRY_RUN）」的處理函式。
 * Args: （無）
 * Returns:
 *   {void}
 */
function menuRunSelfTest_() {
  selfTestMenuRun_({ resume: false }, '跑自測');
}

/**
 * 用途：選單項目「繼續跑自測」的處理函式。
 * Args: （無）
 * Returns:
 *   {void}
 */
function menuResumeSelfTest_() {
  selfTestMenuRun_({ resume: true }, '繼續跑自測');
}

/**
 * 用途：兩個自測選單項目共用的處理流程。
 * Args:
 *   options {Object} 傳給 `runSelfTest_()`。
 *   title {string} 對話框標題。
 * Returns:
 *   {void}
 */
function selfTestMenuRun_(options, title) {
  var ui = SpreadsheetApp.getUi();
  try {
    var config = selfTestConfig_();
    if (!options.resume) {
      var confirm = ui.alert(title,
        '自測機會**清空並重造**沙盒季度（' + config.quarterId + '）的資料，然後由真實入口跑一次完整流程。\n\n'
        + '目前 DRY_RUN＝' + (config.dryRun ? 'TRUE（不會真的寄出）' : 'FALSE（⚠️ 會真的寄出）') + '\n'
        + '職事表：全程唯讀，跑完會比對版本記錄確認。\n\n'
        + '確定要開始嗎？',
        ui.ButtonSet.YES_NO);
      if (confirm !== ui.Button.YES) return;
    }

    var summary = runSelfTest_(options);
    ui.alert(title, buildSelfTestShortSummary_(summary), ui.ButtonSet.OK);
  } catch (err) {
    logMenuError_('selfTestMenuRun_', err);
    ui.alert(title + '失敗', enrichAuthError_(err), ui.ButtonSet.OK);
  }
}

/**
 * 用途：選單項目「查看自測報告」的處理函式——把最近一次的結果重新寫入
 *   `Diagnostics` 並顯示摘要。**唯讀，不會重跑任何情境。**
 * Args: （無）
 * Returns:
 *   {void}
 */
function menuShowSelfTestReport_() {
  var ui = SpreadsheetApp.getUi();
  try {
    var runId = selfTestLatestRunId_();
    if (!runId) {
      ui.alert('查看自測報告', '從未跑過自測。請先執行〔跑自測〕。', ui.ButtonSet.OK);
      return;
    }

    var rows = readSheet(SHEETS.SELF_TEST_REPORT).filter(function (r) {
      return String(r.RUN_ID || '') === runId;
    });
    var results = rows.map(function (r) {
      return {
        id: String(r.SCENARIO_ID || ''), name: String(r.SCENARIO_NAME || ''),
        result: String(r.RESULT || ''), expected: String(r.EXPECTED || ''),
        actual: String(r.ACTUAL || ''), evidence: String(r.EVIDENCE || ''),
        elapsedMs: Number(r.ELAPSED_MS || 0)
      };
    });

    var scenarioIds = selfTestScenarios_().map(function (s) { return s.id; });
    var doneIds = results.map(function (r) { return r.id; });
    var summary = {
      ok: true, runId: runId, message: '', results: results,
      passCount: results.filter(function (r) { return r.result === SELF_TEST_RESULT_.PASS; }).length,
      failCount: results.filter(function (r) { return r.result === SELF_TEST_RESULT_.FAIL; }).length,
      skipCount: results.filter(function (r) { return r.result === SELF_TEST_RESULT_.SKIPPED; }).length,
      pendingIds: scenarioIds.filter(function (id) { return doneIds.indexOf(id) === -1; }),
      stoppedForTime: false,
      totalScenarios: scenarioIds.length
    };

    writeDiagnosticsReport_('自測機報告', buildSelfTestReportLines_(summary));
    ui.alert('查看自測報告', buildSelfTestShortSummary_(summary), ui.ButtonSet.OK);
  } catch (err) {
    logMenuError_('menuShowSelfTestReport_', err);
    ui.alert('查看自測報告失敗', enrichAuthError_(err), ui.ButtonSet.OK);
  }
}
