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
 *   6. **沙盒 master 發佈檔案不可以是正式那一個。**
 *      `SELFTEST_MASTER_PDF_FILE_ID` 與 `PUBLISHED_PDF_FILE_ID` 相同就
 *      即刻停。S13／S14／S15 會**真的覆寫** master 檔案的內容並加版本，
 *      兩者相同的話，教會網站上那條固定連結會被沙盒 PDF 洗掉——而且
 *      完全沒有錯誤訊息：發佈成功、`PublishLog` 綠色、版本 +1。
 *
 *   ⚠️ 沙盒季度刻意選一個**職事表沒有資料**的季度（預設 `2030T1`）：
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
  PASS: 'PASS', FAIL: 'FAIL', SKIPPED: 'SKIPPED', PENDING: 'PENDING',
  // ⚠️ 第二輪自測新增：情境本身通過，但跑完之後某一條不變量不成立。
  //    刻意**不**當成 FAIL：一條不變量不成立會令它後面每一個情境一齊
  //    變紅，看報告的人會以為六個功能壞了，實際只有一條不變量要查。
  //    也刻意**不**當成 PASS——那樣等於放過一個真的問題。
  INVARIANT_WARNING: 'INVARIANT_WARNING'
});

/** 沙盒內容表檔名的後綴——確保永遠不會撞正式那一個。 */
var SELF_TEST_CONTENT_SUFFIX_ = '_SELFTEST';

// =====================================================================
// 沙盒守門
// =====================================================================

/**
 * 用途：一次過讀齊自測機要用的設定。
 *
 *   ⚠️ 連**正式**那個 master 發佈檔案 ID 一齊讀出來，唯一目的是給
 *   `assertSelfTestSandbox_()` 對數（兩者相同就不准開跑）。自測機
 *   本身一格都不會碰 `publishedFileId`。
 * Args: （無）
 * Returns:
 *   {{quarterId:string, rosterQuarterId:string, masterFileId:string,
 *     publishedFileId:string, timeBudgetMs:number, dryRun:boolean,
 *     contentFolderId:string}}
 */
function selfTestConfig_() {
  var budgetSec = normalizeInt_(getConfig(CONFIG_KEYS.SELFTEST_TIME_BUDGET_SEC, '240'));
  if (budgetSec === null || budgetSec <= 0) budgetSec = 240;

  return {
    quarterId: String(getConfig(CONFIG_KEYS.SELFTEST_QUARTER_ID, '2030T1') || '').trim(),
    rosterQuarterId: String(getConfig(CONFIG_KEYS.SELFTEST_ROSTER_QUARTER_ID, '2027T4') || '').trim(),
    masterFileId: String(getConfig(CONFIG_KEYS.SELFTEST_MASTER_PDF_FILE_ID, '') || '').trim(),
    publishedFileId: String(getConfig(CONFIG_KEYS.PUBLISHED_PDF_FILE_ID, '') || '').trim(),
    contentFolderId: String(getConfig(CONFIG_KEYS.CONTENT_SHEET_FOLDER_ID, '') || '').trim(),
    timeBudgetMs: budgetSec * 1000,
    dryRun: normalizeBoolean_(getConfig(CONFIG_KEYS.DRY_RUN, 'TRUE')) === true
  };
}

/**
 * 用途：開跑前提醒——沙盒季度含不含夏令時間轉換的**提示日**。
 *
 *   ⚠️ 提示登在轉換當日的**前一個主日**，所以要落在季度之內的是提示日，
 *   不是轉換日。4 月那一次的提示日在 3 月底（屬 `YYYYT1`），9 月那一次的
 *   提示日在 9 月中（屬 `YYYYT3`）——`YYYYT2` 與 `YYYYT4` **永遠**不會含
 *   提示日。這一點很容易搞錯（挑季度時就錯過一次），所以直接寫在提示裏。
 *
 *   ⚠️ 這只是**提醒**，不是守門：沙盒季度不含提示日仍然可以跑，只是
 *   S22–S24 會報「不適用」。要不要換季度是使用者的決定。
 * Args:
 *   config {Object} `selfTestConfig_()` 的回傳值。
 * Returns:
 *   {string} 含提示日時回一句「會驗到」，不含時回一段指引。
 */
function selfTestDstCoverageWarning_(config) {
  var dates = [];
  try {
    dates = selfTestSandboxDates_(config);
  } catch (err) {
    dates = [];
  }

  var notices = [];
  try {
    notices = daylightSavingNoticesForDates_(dates) || [];
  } catch (err2) {
    notices = [];
  }

  if (notices.length > 0) {
    return '夏令時間：沙盒季度含提示日（' + notices.map(function (n) { return n.noticeIso; }).join('、')
      + '），S22 至 S24 會真的驗到寫入。';
  }
  return '⚠️ 夏令時間：沙盒季度（' + config.quarterId + '）不含轉換提示日，'
    + 'S22 至 S24 將會報不適用。如要驗夏令時間，請把 Config 的 '
    + CONFIG_KEYS.SELFTEST_QUARTER_ID + ' 改用 YYYYT1 或 YYYYT3'
    + '（提示登在轉換當日的前一個主日，所以 YYYYT2 與 YYYYT4 永遠不會含提示日）。';
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
        + ' 填入一個**職事表沒有資料**的季度（預設 2030T1）。'
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

  // ⚠️ 沙盒 master 發佈檔案不可以是正式那一個。
  //    自測機的 S13／S14／S15 會**真的覆寫** master 檔案的內容、真的加版本。
  //    兩個 ID 相同的話，教會網站上那條固定連結會被自測機的沙盒 PDF 洗掉
  //    ——而且完全不會有錯誤訊息：發佈成功、PublishLog 綠色、版本 +1。
  //    這一種「靜靜地做了一件不是使用者要的事」是最難查的一種，所以寧可
  //    在開跑前就停，不要「先跑幾個看看」。
  //
  //    ⚠️ 只在沙盒那個有值時才比。兩個都是空字串代表「未設定」，那是另一
  //    件事：自測機會略過發佈相關情境並講明原因（見 S13）。空值當成相同
  //    而擋住開跑的話，一個全新的環境會連自測機都跑不起來。
  if (config.masterFileId && config.masterFileId === config.publishedFileId) {
    return {
      ok: false,
      message: '沙盒 master 檔案不可以是正式那一個。'
        + CONFIG_KEYS.SELFTEST_MASTER_PDF_FILE_ID + ' 與 '
        + CONFIG_KEYS.PUBLISHED_PDF_FILE_ID + ' 是同一個檔案 ID。'
        + '自測機會真的覆寫 master 檔案的內容並加版本——兩者相同的話，'
        + '教會網站上那條固定連結會被沙盒 PDF 洗掉，而且不會有任何錯誤訊息。'
        + '請先用選單「建立 master 發佈檔案」另外造一個沙盒專用的檔案，'
        + '把它的 ID 填入 ' + CONFIG_KEYS.SELFTEST_MASTER_PDF_FILE_ID + '，然後再試一次。'
        + '已經中止，一格都沒有寫。'
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
 *   `2030T1` 正是刻意選一個沒有資料的季度），退回用曆法推算——
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
    SHEETS.DUTY_OVERRIDE].forEach(function (sheetName) {
    var removed = selfTestDeleteRowsWhere_(sheetName, function (values, keys) {
      var iso = selfTestRowIsoDate_(values, keys, 'SERVICE_DATE');
      return Boolean(iso) && sandboxDates[iso] === true;
    });
    if (removed > 0) { deletedBySheet[sheetName] = removed; total += removed; }
  });

  // PublishLog：**靠 IS_SELFTEST 這個明確的標記**，不是靠日期。
  //
  // ⚠️ 這一條 2026-08-27 改過，理由要記住（見 docs/待確認事項.md W-2）：
  //    舊版把 PublishLog 混在上面那一批，用「SERVICE_DATE 在沙盒季度之內」
  //    去圈沙盒的行。沙盒季度一改（2028T4 → 2030T1），舊季度那幾行就再也
  //    圈不中——它們仍然 IS_SELFTEST=TRUE，於是被 I06 當成「沙盒通道最新
  //    一行」，而沙盒 master 的內容早已被之後的發佈覆寫過。結果 I06 由
  //    S01 一路紅到 S12，直到 S13 真的發佈一次寫入新行才「好返」。
  //
  //    那些行本身就帶住「我是自測寫的」這個標記，卻要用日期去猜——
  //    與事故三十九同一類：**有明確的身分標記就不要用間接特徵去圈**。
  //
  // ⚠️ 只刪 IS_SELFTEST 為真那些。正式發佈的紀錄一行都不可以碰。
  var publishRemoved = selfTestDeleteRowsWhere_(SHEETS.PUBLISH_LOG, function (values, keys) {
    var idx = keys.indexOf('IS_SELFTEST');
    if (idx === -1) return false;
    return normalizeBoolean_(values[idx]) === true;
  });
  if (publishRemoved > 0) {
    deletedBySheet[SHEETS.PUBLISH_LOG] = publishRemoved;
    total += publishRemoved;
  }

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
    { id: 'S14', name: '連續發佈同一份兩次：第二次被擋住（任何一道守門都算），版本號不變', run: selfTestS14_ },
    { id: 'S14b', name: '視窗之內、內容不同：被防重複擋住', run: selfTestS14b_ },
    { id: 'S14c', name: '視窗之外、內容不同：不擋，版本 +1（改版重發是正常的）', run: selfTestS14c_ },
    { id: 'S15', name: '發佈上載 master 目前那一份：被拒，訊息正確', run: selfTestS15_ },
    { id: 'S16', name: '寄出（DRY_RUN）：預覽人數 === SendLog 封數，且有記內文', run: selfTestS16_ },
    { id: 'S17', name: '未填欄位檢查：清單條數 === 實際空格數', run: selfTestS17_ },
    { id: 'S18', name: '星期一自動寄出：選中的是下一個主日，DRY_RUN 之下沒有真寄', run: selfTestS18_ },
    { id: 'S19', name: '職事表沒有該季資料：照樣建立本季週報，ROSTER_STATUS=NOT_FOUND、事奉格全空', run: selfTestS19_ },
    { id: 'S20', name: '補抓空白的事奉欄位（仍然找不到）：明確訊息，一格都沒有寫', run: selfTestS20_ },
    { id: 'S21', name: '人手填一格之後補抓：那一格沒有被覆寫', run: selfTestS21_ },
    { id: 'S22', name: '含 4 月第一個主日的季度：夏令時間提示自動一行，SOURCE=SYSTEM_DST', run: selfTestS22_ },
    { id: 'S23', name: '夏令時間那一行被人手改過：刷新不覆寫、也不另加一行', run: selfTestS23_ },
    { id: 'S24', name: 'DST_AUTO_INSERT=FALSE：不自動加（開啟時要加得到）', run: selfTestS24_ },
    { id: 'S25', name: '該季沒有夏令時間轉換：一行都不加', run: selfTestS25_ },
    { id: 'S26', name: '草稿預覽（下一個主日）：頁面組得出、含提示語、未填欄位顯示「（未填）」', run: selfTestS26_ },
    { id: 'S27', name: '草稿預覽帶指定日期：顯示的就是那一個主日', run: selfTestS27_ },
    { id: 'S28', name: '寄出草稿預覽（DRY_RUN）：SendLog 多 STATUS=PREVIEW，內文含連結', run: selfTestS28_ },
    { id: 'S29', name: 'PREVIEW_ENABLED=FALSE：不寄預覽，SendLog 一筆都沒有多', run: selfTestS29_ },
    { id: 'S30', name: '重複段落偵測：長段重複算數，短句重複不算', run: selfTestS30_ },
    { id: 'S31', name: '內容份量估算：超過門檻有提示、未超過沒有提示，而且結果穩定', run: selfTestS31_ },
    { id: 'S32', name: '三季資料：最舊那一季列入封存，其餘兩季維持可見', run: selfTestS32_ },
    { id: 'S33', name: '取消封存：那一季重新出現在可見清單', run: selfTestS33_ },
    { id: 'S34', name: '封存不會碰 Diagnostics／PublishLog／AuditLog／SendLog', run: selfTestS34_ },
    { id: 'S35', name: '沙盒季度永不被封存、永不出現在使用者的季度下拉', run: selfTestS35_ },
    { id: 'S36', name: '有未發佈而且有內容的主日：封存前列出並要求確認', run: selfTestS36_ },
    { id: 'S37', name: '沒有任何可見季度：有提示語而且講得出下一步，不是空白下拉', run: selfTestS37_ }
  ];
}

/**
 * 用途：S19：職事表沒有該季資料 → 建立本季週報 → 斷言建立成功、
 *   `ROSTER_STATUS` 是 `NOT_FOUND`、事奉格全空、對話框有講明（R-036）。
 *
 *   ⚠️ 沙盒季度本來就是刻意選一個職事表沒有資料的季度，所以這一條驗的
 *   正是生產路徑本身，不需要另造假資料。這一條紅代表「職事表未出就完全
 *   建立不到週報」那個舊行為回來了。
 * Args:
 *   ctx {Object} 自測機的執行脈絡，見 `runSelfTest_()`。
 * Returns:
 *   {{ok:(boolean|null), expected:string, actual:string, evidence:string}}
 * Raises:
 *   Error 如果沙盒季度不是可寫的季度（`assertSelfTestWritableQuarter_()`）。
 */
function selfTestS19_(ctx) {
  var config = ctx.config;
  assertSelfTestWritableQuarter_(config.quarterId, config);

  var rosterDates = [];
  try {
    rosterDates = listRosterServiceDatesForQuarter_(config.quarterId);
  } catch (err) {
    rosterDates = [];
  }
  if (rosterDates.length > 0) {
    return selfTestOutcome_(null, '沙盒季度在職事表沒有資料',
      '職事表有 ' + rosterDates.length + ' 個主日',
      '沙盒季度 ' + config.quarterId + ' 在職事表竟然有資料，這一條驗不到「找不到」那條路。'
        + '請把 Config 的 ' + CONFIG_KEYS.SELFTEST_QUARTER_ID + ' 改成一個職事表沒有資料的季度。');
  }

  var result = createBlankBulletinWeeks_(config.quarterId);

  var rows = readSheet(SHEETS.BULLETIN_WEEKS).filter(function (r) {
    return String(r.QUARTER_ID || '').trim() === config.quarterId;
  });

  // ⚠️ 「事奉格全空」逐格數出來，不是信 createBlankBulletinWeeks_() 回的數字。
  //
  //    ⚠️ 一定要用 rosterOnlyWeekFieldKeys_()，**不是** rosterDerivedWeekFieldKeys_()。
  //    後者那三欄之中有兩欄（WEEK_OF_MONTH、PROGRAM_TEMPLATE_ID）就算職事表
  //    完全沒有這一季都一定有值——一個由日期算出來，一個退回 Config 預設值。
  //    2026-08-26 這一條就是這樣報「職事表沒有這一季，卻有 26 格事奉資料」，
  //    嚇到以為抓了別季的人名；查證之後真相是 13 行 × 那兩欄，一格都沒有
  //    跨季。見 docs/已知bug類型.md 事故四十一、docs/待確認事項.md V-1。
  var dutyKeys = rosterOnlyWeekFieldKeys_();
  var nonBlankDuty = 0;
  var notFoundCount = 0;
  var wrongQuarter = 0;
  rows.forEach(function (row) {
    if (String(row.ROSTER_STATUS || '') === ROSTER_STATUS.NOT_FOUND) notFoundCount++;
    dutyKeys.forEach(function (key) {
      if (!isBlankWeekCell_(row[key])) nonBlankDuty++;
    });
    // 順手把「季度有沒有寫錯」也數一次——I11 驗全套，這裏只驗這一季。
    var iso = (Object.prototype.toString.call(row.SERVICE_DATE) === '[object Date]')
      ? formatIsoDate_(row.SERVICE_DATE) : String(row.SERVICE_DATE || '');
    var calendarQuarter = calendarQuarterIdForIsoDate_(iso);
    if (calendarQuarter && calendarQuarter !== config.quarterId) wrongQuarter++;
  });

  var messageMentions = String(result.message || '').indexOf('職事表') !== -1;
  var ok = rows.length > 0
    && notFoundCount === rows.length
    && nonBlankDuty === 0
    && wrongQuarter === 0
    && result.rosterFound === false
    && messageMentions;

  return selfTestOutcome_(ok,
    '建立到主日、全部 ROSTER_STATUS=NOT_FOUND、只可能來自職事表的格全空、對話框有講明',
    rows.length + ' 個主日、其中 ' + notFoundCount + ' 個 NOT_FOUND、'
      + '只可能來自職事表的格有值的 ' + nonBlankDuty + ' 格、'
      + '季度寫錯的 ' + wrongQuarter + ' 行、'
      + '對話框' + (messageMentions ? '有' : '沒有') + '提職事表',
    '季度 ' + config.quarterId + '；逐格檢查的欄位：' + dutyKeys.join('、')
      + '（WEEK_OF_MONTH 與 PROGRAM_TEMPLATE_ID **刻意不計**——它們不讀職事表都一定有值）；'
      + '對話框訊息：' + String(result.message || '（空）'));
}

/**
 * 用途：S20：S19 之後撳「補抓空白的事奉欄位」（職事表仍然找不到）→ 斷言回一句
 *   明確訊息、**事奉格一格未變**、補抓數為 0（R-036）。
 *
 *   ⚠️ 斷言的範圍在 2026-08-26 收窄過一次，理由要寫清楚，免得日後被當成
 *   「為了轉綠而放寬」：
 *
 *   舊版斷言「整季資料一格未變」（整行字串化前後比對）。但補抓**本來就
 *   應該**更正 `ROSTER_STATUS`——那是它的職責之一。舊沙盒季度剛好狀態
 *   一直沒有變，所以看不出來；換季之後補抓把一批狀態由「未算過」更正成
 *   `NOT_FOUND`，舊斷言就判 FAIL。**那個改變是對的，判 FAIL 的是斷言。**
 *
 *   所以現在只鎖住真正不可以動的東西：**事奉相關的格**。`ROSTER_STATUS`
 *   容許被更正（並且把前後的分佈印在證據欄，看得見）。
 * Args:
 *   ctx {Object} 自測機的執行脈絡。
 * Returns:
 *   {{ok:(boolean|null), expected:string, actual:string, evidence:string}}
 * Raises:
 *   Error 如果沙盒季度不是可寫的季度。
 */
function selfTestS20_(ctx) {
  var config = ctx.config;
  assertSelfTestWritableQuarter_(config.quarterId, config);

  var before = selfTestQuarterDutySnapshot_(config.quarterId);
  if (before.rowCount === 0) {
    return selfTestOutcome_(null, '沙盒季度有主日', '0 個', '請先跑 S19。');
  }

  var result = backfillRosterForQuarter_(config.quarterId);
  var after = selfTestQuarterDutySnapshot_(config.quarterId);

  var dutyUnchanged = before.digest === after.digest;
  var saidSo = String(result.message || '').indexOf('職事表') !== -1;
  var ok = result.rosterFound === false && result.filled === 0 && dutyUnchanged && saidSo;

  return selfTestOutcome_(ok,
    '補了 0 格、事奉格一格未變、訊息有講明職事表仍然找不到',
    '補了 ' + result.filled + ' 格、事奉格' + (dutyUnchanged ? '一格未變' : '**變了**')
      + '、訊息' + (saidSo ? '有' : '沒有') + '講明',
    '季度 ' + config.quarterId + '；職事表狀態 '
      + describeRosterStatusCounts_(result.statusBefore) + ' → '
      + describeRosterStatusCounts_(result.statusAfter)
      + '（狀態被更正是**正常的**，補抓的職責之一就是更正它）；'
      + '訊息：' + String(result.message || '（空）'));
}
/**
 * 用途：S21：人手填一格事奉 → 補抓 → 斷言該格**沒有被覆寫**（R-036）。
 *
 *   ⚠️ 這一條是整個 R-036 最要緊的一條。補抓可以隨時重試，前提是它永遠
 *   不會蓋走人手已經填好的東西；一旦蓋得走，幹事補完的資料會在下一次撳
 *   按鈕時無聲無息不見。
 *
 *   職事表仍然找不到，所以「其他空格照補」在這個沙盒裏補得到的是 0 格
 *   ——這一點在證據欄講明，不當成已經驗過（覆蓋缺口）。
 * Args:
 *   ctx {Object} 自測機的執行脈絡。
 * Returns:
 *   {{ok:(boolean|null), expected:string, actual:string, evidence:string}}
 * Raises:
 *   Error 如果沙盒季度不是可寫的季度。
 */
function selfTestS21_(ctx) {
  var config = ctx.config;
  assertSelfTestWritableQuarter_(config.quarterId, config);

  var dates = selfTestSandboxDates_(config);
  if (dates.length === 0) return selfTestOutcome_(null, '沙盒季度有主日', '0 個', '請先跑 S19。');

  var isoDate = dates[0];
  var sentinel = 'S21 人手填的值';
  var fieldKey = 'SERMON_TITLE';

  // 用**真正的**儲存入口寫這一格，不是自己直接改試算表——幹事實際上就是
  // 經填寫介面填的，走同一條路才驗得到真實情況。
  var loaded = loadWeekForWebApp_(isoDate);
  var patch = {};
  patch[fieldKey] = sentinel;
  saveWeekFromWebApp_({ isoDate: isoDate, lastSavedAt: loaded.lastSavedAt, week: patch, dutyEdits: [] });

  var result = backfillRosterForQuarter_(config.quarterId);

  var row = findBulletinWeekRow_(readSheet(SHEETS.BULLETIN_WEEKS), isoDate) || {};
  var kept = String(row[fieldKey] || '') === sentinel;

  return selfTestOutcome_(kept,
    '人手填的「' + sentinel + '」原封不動',
    '現在是「' + String(row[fieldKey] || '（空）') + '」',
    '主日 ' + isoDate + '；補抓補了 ' + result.filled + ' 格。'
      + '　⚠️ 覆蓋缺口：沙盒季度在職事表沒有資料，所以「其他空格照補」這一半'
      + '在這裏補得到的是 0 格，沒有真正驗到。見 docs/待確認事項.md。');
}

/**
 * 用途：S22：沙盒季度含夏令時間轉換的前一個主日 → **真的建立內容表** →
 *   斷言 `家事報告` 自動多了一行 `SOURCE=SYSTEM_DST`，內容含正確的日期
 *   （R-030）。
 *
 *   ⚠️ 2026-08-26 改寫過：舊版自己另外算一個未來季度（`YYYYT2`）去「半驗」
 *   `buildDaylightSavingRows_()`，真正寫入試算表那一段從來沒有執行過。
 *   一段從來沒有執行過的碼等於沒有寫過（見 docs/已知bug類型.md）。
 *   現在一律用沙盒季度，真的寫、真的讀回來對。
 *
 *   ⚠️ 沙盒季度**不含**轉換提示日時報「不適用」，**不會**自己另揀一個季度
 *   去半驗——半驗會令報告看起來像驗過了。
 *
 *   ⚠️ 提示登在**改動當日的前一個主日**，所以要「含提示日」的是：
 *   4 月那一次 → `YYYYT1`（提示日在 3 月底）；9 月那一次 → `YYYYT3`。
 *   `YYYYT2`／`YYYYT4` 兩種季度**永遠**不會含提示日。
 * Args:
 *   ctx {Object} 自測機的執行脈絡。
 * Returns:
 *   {{ok:(boolean|null), expected:string, actual:string, evidence:string}}
 * Raises:
 *   Error 如果沙盒季度不是可寫的季度。
 */
function selfTestS22_(ctx) {
  var config = ctx.config;
  var gate = selfTestDstGate_(config);
  if (!gate.ok) return gate.outcome;

  assertSelfTestWritableQuarter_(config.quarterId, config);
  var refreshed = selfTestRefreshSandboxContentSheet_(config);
  if (!refreshed.ok) return refreshed.outcome;

  var rows = selfTestReadDstRows_(refreshed.spreadsheet);
  var one = rows.length === 1 ? rows[0] : null;

  // ⚠️ 期望值用一支與被驗邏輯無關的算法：直接數星期幾。
  var expectedNoticeIso = gate.notice.noticeIso;
  var expectedChangeIso = gate.notice.changeIso;
  var independentChange = selfTestIndependentDstChangeIso_(expectedNoticeIso);
  var dstConfig = daylightSavingConfig_();
  var changeText = formatDaylightSavingDate_(expectedChangeIso, dstConfig.datePattern, dstConfig.timezone);
  var dateInText = one ? (String(one.TEXT).indexOf(changeText) !== -1) : false;

  var ok = one !== null
    && contentRowIsoDate_(one.SERVICE_DATE) === expectedNoticeIso
    && String(one.SOURCE) === CONTENT_ROW_SOURCE.SYSTEM_DST
    && dateInText
    && independentChange === expectedChangeIso;

  return selfTestOutcome_(ok,
    '內容表 家事報告 有 1 行 SOURCE=SYSTEM_DST，登在 ' + expectedNoticeIso
      + '，內容含「' + changeText + '」',
    rows.length + ' 行 SOURCE=SYSTEM_DST'
      + (one ? ('、登在 ' + contentRowIsoDate_(one.SERVICE_DATE)
        + '、內容' + (dateInText ? '有' : '沒有') + '正確日期') : ''),
    '季度 ' + config.quarterId + '（' + gate.notice.kind + '）；轉換日 ' + expectedChangeIso
      + '；獨立算法（直接數星期幾）：' + independentChange
      + '；內容：' + (one ? one.TEXT : '（沒有）'));
}

/**
 * 用途：S23：把 S22 那一行內容改掉 → 重新刷新內容表 → 斷言**沒有被覆寫**，
 *   而且**沒有另外加一行**（R-030）。
 *
 *   ⚠️ 「另外加一行」與「覆寫」一樣壞：人手那一行會被下面那一行蓋住。
 * Args:
 *   ctx {Object} 自測機的執行脈絡。
 * Returns:
 *   {{ok:(boolean|null), expected:string, actual:string, evidence:string}}
 * Raises:
 *   Error 如果沙盒季度不是可寫的季度。
 */
function selfTestS23_(ctx) {
  var config = ctx.config;
  var gate = selfTestDstGate_(config);
  if (!gate.ok) return gate.outcome;

  assertSelfTestWritableQuarter_(config.quarterId, config);
  var opened = selfTestOpenSandboxContentSheet_(config);
  if (!opened.ok) return opened.outcome;

  var before = selfTestReadDstRows_(opened.spreadsheet);
  if (before.length !== 1) {
    return selfTestOutcome_(null, 'S22 已經寫好 1 行夏令時間提示',
      before.length + ' 行', '請先跑 S22。');
  }

  // 人手改掉內容（只改 TEXT，快照那一欄不動＝系統應該看得出被改過）。
  var edited = '幹事自己改過的夏令時間提示（S23 ' + ctx.runId + '）';
  var tabDef = selfTestFindTabDef_('家事報告');
  var sheet = opened.spreadsheet.getSheetByName(tabDef.tabName);
  var textCol = tabDef.keys.indexOf('TEXT') + 1;
  var cell = sheet.getRange(before[0].__rowNo, textCol, 1, 1);
  cell.setNumberFormat('@');
  cell.setValue(edited);

  var refreshed = selfTestRefreshSandboxContentSheet_(config);
  if (!refreshed.ok) return refreshed.outcome;

  var after = selfTestReadDstRows_(refreshed.spreadsheet);
  var stillEdited = after.length === 1 && String(after[0].TEXT) === edited;
  var ok = after.length === 1 && stillEdited;

  return selfTestOutcome_(ok,
    '仍然是 1 行，而且內容仍然是人手改過的那一句',
    after.length + ' 行；內容'
      + (stillEdited ? '未被覆寫' : ('已變成「' + (after[0] ? after[0].TEXT : '（沒有）') + '」')),
    '人手改成：「' + edited + '」'
      + '　⚠️ 行數也一定要維持 1——多加一行等於人手那一行被蓋住，跟覆寫一樣壞。');
}

/**
 * 用途：S24：`DST_AUTO_INSERT=FALSE` → 斷言不會自動加；改回 `TRUE` →
 *   斷言加得到（R-030）。
 *
 *   ⚠️ 一定要**兩邊都驗**。只驗「關了是 0」的話，一支永遠什麼都不加的
 *   壞實作一樣會綠。
 *
 *   ⚠️ Config 一定要在 `finally` 裏改回原值，否則這一條一失敗就會把整個
 *   系統的夏令時間提示永久關掉。
 * Args:
 *   ctx {Object} 自測機的執行脈絡。
 * Returns:
 *   {{ok:(boolean|null), expected:string, actual:string, evidence:string}}
 * Raises:
 *   Error 如果沙盒季度不是可寫的季度。
 */
function selfTestS24_(ctx) {
  var config = ctx.config;
  var gate = selfTestDstGate_(config);
  if (!gate.ok) return gate.outcome;

  assertSelfTestWritableQuarter_(config.quarterId, config);
  var opened = selfTestOpenSandboxContentSheet_(config);
  if (!opened.ok) return opened.outcome;

  // 先清走 S22／S23 留下的那一行，兩邊才驗得準。
  var tabDef = selfTestFindTabDef_('家事報告');
  selfTestClearContentTab_(opened.spreadsheet.getSheetByName(tabDef.tabName), tabDef);

  var original = getConfig(CONFIG_KEYS.DST_AUTO_INSERT, 'TRUE');
  var offCount = null;
  var onCount = null;
  try {
    setConfig(CONFIG_KEYS.DST_AUTO_INSERT, 'FALSE', '自測機 S24：暫時關掉夏令時間自動加入');
    var off = selfTestRefreshSandboxContentSheet_(config);
    if (!off.ok) return off.outcome;
    offCount = selfTestReadDstRows_(off.spreadsheet).length;
  } finally {
    setConfig(CONFIG_KEYS.DST_AUTO_INSERT, original, '自測機 S24：還原原值');
  }

  var on = selfTestRefreshSandboxContentSheet_(config);
  if (!on.ok) return on.outcome;
  onCount = selfTestReadDstRows_(on.spreadsheet).length;

  var ok = offCount === 0 && onCount === 1;
  return selfTestOutcome_(ok, '關掉時 0 行、開啟時 1 行',
    '關掉時 ' + offCount + ' 行、開啟時 ' + onCount + ' 行',
    '季度 ' + config.quarterId + '；Config ' + CONFIG_KEYS.DST_AUTO_INSERT
      + ' 已還原成「' + original + '」。');
}

/**
 * 用途：S25：該季沒有夏令時間轉換提示 → 斷言一行都不加（R-030）。
 *
 *   ⚠️ 沙盒季度**含**提示日的時候，這一條驗不到自己要驗的東西，所以報
 *   「不適用」並講明——不會硬用另一個季度去湊。反過來說：S22–S24 與
 *   S25 之中，**必然有一組是「不適用」**，這是沙盒季度只有一個的必然
 *   後果，不是漏驗。
 * Args:
 *   ctx {Object} 自測機的執行脈絡。
 * Returns:
 *   {{ok:(boolean|null), expected:string, actual:string, evidence:string}}
 */
function selfTestS25_(ctx) {
  var config = ctx.config;
  var dates = selfTestSandboxDates_(config);
  if (dates.length === 0) return selfTestOutcome_(null, '沙盒季度有主日', '0 個', '請先跑 S19。');

  var notices = daylightSavingNoticesForDates_(dates);
  if (notices.length > 0) {
    return selfTestOutcome_(null, '沙盒季度沒有夏令時間轉換提示',
      '有 ' + notices.length + ' 個（' + notices.map(function (n) { return n.noticeIso; }).join('、') + '）',
      '不適用：沙盒季度「' + config.quarterId + '」**含**提示日，所以驗不到「不含轉換的季度」'
        + '這一條。S22–S24 那一組會驗到寫入那一邊。'
        + '⚠️ 「不適用」不等於「通過」。');
  }

  var rows = buildDaylightSavingRows_(dates, daylightSavingConfig_());
  var ok = rows.length === 0;
  return selfTestOutcome_(ok, '0 行', rows.length + ' 行',
    '季度 ' + config.quarterId + '；主日 ' + dates.length + ' 個；'
      + (ok ? '' : '加了：' + rows.map(function (r) { return r.SERVICE_DATE; }).join('、')));
}

/**
 * 用途：S26：開啟預覽頁（下一個主日）→ 斷言頁面組得出、含提示語、
 *   含主日日期、未填欄位顯示「（未填）」（R-033）。
 *
 *   ⚠️ 刻意走**真實入口** `buildPreviewPage_()`，不是自己砌一個假的 model
 *   再叫 `renderPreviewHtml_()`——後者驗不到「由日期到 HTML」整條路，而那
 *   條路才是使用者真正會走的。
 * Args:
 *   ctx {Object} 自測機的執行脈絡。
 * Returns:
 *   {{ok:(boolean|null), expected:string, actual:string, evidence:string}}
 */
function selfTestS26_(ctx) {
  var config = ctx.config;
  var dates = selfTestSandboxDates_(config);
  if (dates.length === 0) return selfTestOutcome_(null, '沙盒季度有主日', '0 個', '請先跑 S19。');

  // ⚠️ 不傳日期＝走「下一個主日」那條路，但那個主日是**真實**季度的，
  //    自測機不可以碰。所以這一條驗的是「不帶日期時算得出一個主日、
  //    而且頁面組得出來」，用的是唯讀路徑（預覽全程不寫任何一格）。
  var page = buildPreviewPage_('');
  var html = String(page.html || '');
  var notice = previewConfig_().notice;

  var hasNotice = html.indexOf(escapeHtml_(notice)) !== -1;
  var hasDate = Boolean(page.isoDate) && html.indexOf(escapeHtml_(page.isoDate)) !== -1;
  var hasBlank = html.indexOf('（未填）') !== -1;
  // 唯讀：整版不可以有表單或者 google.script.run。
  var readOnly = html.indexOf('<form') === -1 && html.indexOf('google.script.run') === -1;

  var ok = page.ok === true && hasNotice && hasDate && hasBlank && readOnly;
  return selfTestOutcome_(ok,
    '頁面組得出、含提示語、含主日日期、有「（未填）」、完全唯讀',
    '組得出 ' + (page.ok === true) + '、提示語 ' + hasNotice + '、日期 ' + hasDate
      + '、（未填）' + hasBlank + '、唯讀 ' + readOnly,
    '主日 ' + (page.isoDate || '（算不到）') + '；HTML 長度 ' + html.length + ' 字元。'
      + '　⚠️ 「（未填）」一定要出現：預覽的用途就是讓人看到有什麼未填，'
      + '留空白等於把「未填」偽裝成「沒有這一項」。');
}

/**
 * 用途：S27：預覽頁帶指定日期 → 斷言顯示的就是那一個主日（R-033）。
 * Args:
 *   ctx {Object} 自測機的執行脈絡。
 * Returns:
 *   {{ok:(boolean|null), expected:string, actual:string, evidence:string}}
 */
function selfTestS27_(ctx) {
  var config = ctx.config;
  var dates = selfTestSandboxDates_(config);
  if (dates.length === 0) return selfTestOutcome_(null, '沙盒季度有主日', '0 個', '請先跑 S19。');

  // 刻意揀第二個主日：揀第一個的話，「下一個主日」剛好等於它時就分不出
  // 「真的用了指定日期」還是「其實走了預設那條路」。
  var target = dates.length > 1 ? dates[1] : dates[0];
  var page = buildPreviewPage_(target);
  var html = String(page.html || '');

  var ok = page.ok === true
    && page.isoDate === target
    && html.indexOf(escapeHtml_(target)) !== -1;

  return selfTestOutcome_(ok, '顯示 ' + target,
    '顯示 ' + (page.isoDate || '（算不到）'),
    '指定日期 ' + target + '；沙盒季度共 ' + dates.length + ' 個主日。'
      + '　⚠️ 刻意揀第二個主日——揀第一個的話，分不出「用了指定日期」與'
      + '「其實走了下一個主日那條路」。');
}

/**
 * 用途：S28：星期一觸發器（`DRY_RUN`）→ 斷言 `SendLog` 多一筆
 *   `STATUS='PREVIEW'`，而且內文含預覽連結（R-033）。
 *
 *   ⚠️ 與 S18 同一個理由，**刻意不直接呼叫 `weeklyBulletinSendTrigger_()`**：
 *   那一支會順手建立季度填寫表與內容表，直接違反「只准碰沙盒季度」。
 *   這一條驗的是它會呼叫的那一段（`sendPreviewNotice_()`）。
 *   **這是一個已知的覆蓋缺口**，寫在證據欄。
 * Args:
 *   ctx {Object} 自測機的執行脈絡。
 * Returns:
 *   {{ok:(boolean|null), expected:string, actual:string, evidence:string}}
 */
function selfTestS28_(ctx) {
  var config = ctx.config;
  if (!config.dryRun) {
    return selfTestOutcome_(null, 'DRY_RUN=TRUE', 'DRY_RUN=FALSE',
      '自測機只在 DRY_RUN 之下驗寄送，這一條略過。⚠️ 「略過」不等於「通過」。');
  }

  var dates = selfTestSandboxDates_(config);
  if (dates.length === 0) return selfTestOutcome_(null, '沙盒季度有主日', '0 個', '請先跑 S19。');

  var before = selfTestCountPreviewSendLogRows_();
  var result = sendPreviewNotice_(dates[0]);
  var after = selfTestCountPreviewSendLogRows_();

  if (!result.sent) {
    return selfTestOutcome_(null, '寄得出草稿預覽', '沒有寄：' + result.reason,
      result.message + '　⚠️ 「沒有寄」不等於「通過」——多數是未設定 '
        + CONFIG_KEYS.PREVIEW_WEBAPP_URL + ' 或者 Recipients 沒有對應的組別。');
  }

  var added = after.count - before.count;
  var hasUrl = after.lastBodyPreview.indexOf('page=preview') !== -1
    || (result.previewUrl && after.lastBodyPreview.indexOf(result.previewUrl.slice(0, 30)) !== -1);

  var ok = added === result.recipientCount && added > 0 && hasUrl && result.dryRun === true;
  return selfTestOutcome_(ok,
    result.recipientCount + ' 筆 STATUS=PREVIEW、內文含預覽連結、DRY_RUN=TRUE',
    added + ' 筆、內文' + (hasUrl ? '有' : '沒有') + '連結、DRY_RUN=' + result.dryRun,
    '主日 ' + dates[0] + '；連結 ' + (result.previewUrl || '（取不到）')
      + '　⚠️ 覆蓋缺口：這一條**沒有**真的呼叫 weeklyBulletinSendTrigger_()，'
      + '因為那一支會替真實季度建立填寫表與內容表。見 docs/待確認事項.md。');
}

/**
 * 用途：S29：`PREVIEW_ENABLED=FALSE` → 斷言不寄預覽（R-033）。
 *
 *   ⚠️ 改完 Config 一定要在 `finally` 還原，否則這一條一失敗就會把整個
 *   草稿預覽永久關掉。
 * Args:
 *   ctx {Object} 自測機的執行脈絡。
 * Returns:
 *   {{ok:(boolean|null), expected:string, actual:string, evidence:string}}
 */
function selfTestS29_(ctx) {
  var config = ctx.config;
  var dates = selfTestSandboxDates_(config);
  if (dates.length === 0) return selfTestOutcome_(null, '沙盒季度有主日', '0 個', '請先跑 S19。');

  var original = getConfig(CONFIG_KEYS.PREVIEW_ENABLED, 'TRUE');
  var before = selfTestCountPreviewSendLogRows_();
  var offResult;
  try {
    setConfig(CONFIG_KEYS.PREVIEW_ENABLED, 'FALSE', '自測機 S29：暫時關掉草稿預覽');
    offResult = sendPreviewNotice_(dates[0]);
  } finally {
    setConfig(CONFIG_KEYS.PREVIEW_ENABLED, original, '自測機 S29：還原原值');
  }
  var after = selfTestCountPreviewSendLogRows_();

  var ok = offResult.sent === false
    && offResult.reason === 'DISABLED'
    && after.count === before.count;

  return selfTestOutcome_(ok,
    '不寄、reason=DISABLED、SendLog 一筆都沒有多',
    '寄了 ' + offResult.sent + '、reason=' + offResult.reason
      + '、SendLog 多了 ' + (after.count - before.count) + ' 筆',
    'Config ' + CONFIG_KEYS.PREVIEW_ENABLED + ' 已還原成「' + original + '」。');
}

/**
 * 用途：S30：產生一份含重複段落的 Word → 斷言 `duplicateParagraphs`
 *   列出正確條數（R-032）。
 *
 *   ⚠️ 刻意用**人手砌的 OOXML**，不是真的去產生一份週報：真週報有沒有
 *   重複段落不受我們控制，驗不到「數得準」這件事。這裏要驗的是掃描本身。
 * Args:
 *   ctx {Object} 自測機的執行脈絡。
 * Returns:
 *   {{ok:(boolean|null), expected:string, actual:string, evidence:string}}
 */
function selfTestS30_(ctx) {
  var longText = '為斯里蘭卡短宣隊代禱，求主保守隊員身心靈健壯，行程順利平安。';
  var otherText = '請為本週三晚上的祈禱會代禱，求主感動更多弟兄姊妹一同參與。';
  var shortText = '請代禱。';

  function para(text) { return '<w:p><w:r><w:t>' + text + '</w:t></w:r></w:p>'; }

  // 兩段長文各出現兩次、一段短文出現三次（短文不應該被計算）。
  var xml = '<w:body>'
    + para(longText) + para(otherText) + para(longText)
    + para(shortText) + para(shortText) + para(shortText)
    + para(otherText)
    + '</w:body>';

  var found = docxScanDuplicateParagraphs_(xml, 25);
  var texts = found.map(function (d) { return d.text; });

  var ok = found.length === 2
    && texts.indexOf(longText) !== -1
    && texts.indexOf(otherText) !== -1
    && found.every(function (d) { return d.count === 2; });

  return selfTestOutcome_(ok, '2 段（各出現 2 次），短句不計',
    found.length + ' 段：' + found.map(function (d) {
      return d.text.slice(0, 12) + '⋯（' + d.count + ' 次）';
    }).join('、'),
    '短句「' + shortText + '」出現 3 次但長度不足 25 字元，刻意不計——'
      + '短句重複是排版的正常現象，報出來只會令人不再看這一項。');
}

/**
 * 用途：S31：內容份量超過門檻 → 斷言有提示；未超過 → 斷言沒有提示（R-032）。
 *
 *   ⚠️ **兩邊都要驗。** 只驗「超過會提示」的話，一支永遠提示的壞實作
 *   一樣會綠。
 * Args:
 *   ctx {Object} 自測機的執行脈絡。
 * Returns:
 *   {{ok:(boolean|null), expected:string, actual:string, evidence:string}}
 */
function selfTestS31_(ctx) {
  function paraXml(text) { return '<w:p><w:r><w:t>' + text + '</w:t></w:r></w:p>'; }

  var unit = '';
  for (var i = 0; i < 100; i++) unit += '週';

  var small = estimateDocxContentSize_([paraXml(unit)], 500);           // 100 字元
  var big = estimateDocxContentSize_([paraXml(unit + unit + unit + unit + unit + unit)], 500);  // 600

  var smallLines = buildContentSizeLines_(small);
  var bigLines = buildContentSizeLines_(big);
  var smallWarns = smallLines.join('').indexOf('可能會排到第 5 頁') !== -1;
  var bigWarns = bigLines.join('').indexOf('可能會排到第 5 頁') !== -1;

  // 同一份輸入跑兩次要得出同一個數字（穩定性）。
  var again = estimateDocxContentSize_([paraXml(unit)], 500);
  var stable = again.chars === small.chars;

  var ok = small.chars === 100 && big.chars === 600
    && small.overThreshold === false && big.overThreshold === true
    && !smallWarns && bigWarns && stable;

  return selfTestOutcome_(ok,
    '未超過 → 沒有提示；超過 → 有提示；同一份輸入兩次結果相同',
    '未超過 ' + small.chars + ' 字元（提示 ' + smallWarns + '）、'
      + '超過 ' + big.chars + ' 字元（提示 ' + bigWarns + '）、穩定 ' + stable,
    '門檻 500（測試用）。⚠️ 兩邊都要驗——只驗「超過會提示」的話，'
      + '一支永遠提示的壞實作一樣會綠。'
      + '　⚠️ 這個數字**只是估算**：準確頁數要靠 Word 的排版引擎。');
}

/**
 * 用途：S32：三季資料 → 跑封存 → 斷言最舊那一季 `ARCHIVED=TRUE`、
 *   其餘兩季不變（R-035）。
 *
 *   ⚠️ 這一條**刻意只驗純函式層** `planQuarterRetention_()`，不真的去封存：
 *   自測機只准寫沙盒季度那一季，而封存是**整季**的操作，真跑一次就會動到
 *   真實季度的 `ARCHIVED`、隱藏真實的 `Fill_*`、改真實內容表的 `ACTIVE`。
 *   那三樣全部在沙盒範圍以外。
 *   **這是一個已知的覆蓋缺口**，寫在證據欄與 docs/待確認事項.md。
 * Args:
 *   ctx {Object} 自測機的執行脈絡。
 * Returns:
 *   {{ok:(boolean|null), expected:string, actual:string, evidence:string}}
 */
function selfTestS32_(ctx) {
  var config = ctx.config;
  var quarters = ['2029T1', '2029T2', '2029T3'];
  var plan = planQuarterRetention_(quarters, 2, config.quarterId);

  var ok = plan.visible.length === 2
    && plan.visible[0] === '2029T3' && plan.visible[1] === '2029T2'
    && plan.toArchive.length === 1 && plan.toArchive[0] === '2029T1';

  return selfTestOutcome_(ok,
    '可見 2029T3、2029T2；封存 2029T1',
    '可見 ' + plan.visible.join('、') + '；封存 ' + plan.toArchive.join('、'),
    '保留 2 季（Config ' + CONFIG_KEYS.RETENTION_QUARTERS_VISIBLE + '）。'
      + '　⚠️ 覆蓋缺口：這一條只驗「決定封存哪一季」那一段，**沒有真的封存**'
      + '——封存是整季操作，會動到沙盒範圍以外的資料。真正的寫入要靠'
      + '十二月真數據演練，或者人手撳選單「立即整理舊季度」。');
}

/**
 * 用途：S33：取消封存 → 斷言全部還原（R-035）。
 *
 *   ⚠️ 同 S32，只驗得到「還原之後那一季會不會重新出現在可見清單」。
 * Args:
 *   ctx {Object} 自測機的執行脈絡。
 * Returns:
 *   {{ok:(boolean|null), expected:string, actual:string, evidence:string}}
 */
function selfTestS33_(ctx) {
  var config = ctx.config;
  var quarters = ['2029T1', '2029T2', '2029T3'];

  // 封存之後：2029T1 的旗標是 TRUE，預設看不見。
  var archived = { '2029T1': true, '2029T2': false, '2029T3': false };
  var hiddenList = visibleQuarterList_(quarters, archived, false, config.quarterId);

  // 取消封存之後：旗標改回 FALSE，三季都應該見得返。
  var restored = { '2029T1': false, '2029T2': false, '2029T3': false };
  var restoredList = visibleQuarterList_(quarters, restored, false, config.quarterId);

  var ok = hiddenList.length === 2
    && restoredList.length === 3
    && restoredList.map(function (q) { return q.quarterId; }).indexOf('2029T1') !== -1;

  return selfTestOutcome_(ok,
    '封存後可見 2 季；取消封存後可見 3 季（2029T1 重新出現）',
    '封存後 ' + hiddenList.length + ' 季；取消封存後 ' + restoredList.length + ' 季',
    '⚠️ 封存**一格資料都沒有刪**，所以取消封存之後那一季完完整整地回來。'
      + '　⚠️ 覆蓋缺口：同 S32，這一條沒有真的寫入。');
}

/**
 * 用途：S34：封存不會碰 `Diagnostics`／`PublishLog`／`AuditLog`／`SendLog`
 *   （R-035）。
 *
 *   ⚠️ 這一條驗的是**靜態的**：`src/Retention.gs` 整個檔案不可以出現那四張
 *   表的寫入。用行為去驗要真的封存一季（做不到，見 S32），用靜態掃描反而
 *   驗得更徹底——它連「將來有人加一行」都攔得住。
 * Args:
 *   ctx {Object} 自測機的執行脈絡。
 * Returns:
 *   {{ok:(boolean|null), expected:string, actual:string, evidence:string}}
 */
function selfTestS34_(ctx) {
  // 封存只碰三樣：BulletinWeeks 的 ARCHIVED 一欄、Fill_* 的隱藏、
  // ContentSheets 的 ACTIVE（＋ Drive 搬檔案）。逐樣點名。
  var before = {
    diagnostics: readSheet(SHEETS.DIAGNOSTICS).length,
    publishLog: readSheet(SHEETS.PUBLISH_LOG).length,
    auditLog: readSheet(SHEETS.AUDIT_LOG).length,
    sendLog: readSheet(SHEETS.SEND_LOG).length
  };

  // 跑一次**只讀**的部分：算出封存計畫。這一步絕對不應該寫任何東西。
  var quarterIds = readSheet(SHEETS.BULLETIN_WEEKS).map(function (r) {
    return String(r.QUARTER_ID || '').trim();
  });
  planQuarterRetention_(quarterIds, retentionConfig_().visibleQuarters, ctx.config.quarterId);
  findUnpublishedWorkInQuarter_(ctx.config.quarterId);

  var after = {
    diagnostics: readSheet(SHEETS.DIAGNOSTICS).length,
    publishLog: readSheet(SHEETS.PUBLISH_LOG).length,
    auditLog: readSheet(SHEETS.AUDIT_LOG).length,
    sendLog: readSheet(SHEETS.SEND_LOG).length
  };

  var changed = Object.keys(before).filter(function (k) { return before[k] !== after[k]; });
  var ok = changed.length === 0;

  return selfTestOutcome_(ok,
    '四張紀錄表一行都沒有多',
    changed.length === 0 ? '四張都沒有變' : ('變咗：' + changed.join('、')),
    'Diagnostics ' + before.diagnostics + '→' + after.diagnostics
      + '、PublishLog ' + before.publishLog + '→' + after.publishLog
      + '、AuditLog ' + before.auditLog + '→' + after.auditLog
      + '、SendLog ' + before.sendLog + '→' + after.sendLog
      + '　⚠️ 那四張是**紀錄**，不是「本季的工作」——封存它們等於把稽核軌跡'
      + '藏起來，而稽核軌跡的用途正正是事後回去查。'
      + '　⚠️ 覆蓋缺口：這一條只跑得到唯讀那一段（真封存會動到沙盒以外）。'
      + '真正的防線是 tests/retention.test.js 那條靜態掃描。');
}

/**
 * 用途：S35：沙盒季度永不被封存、永不出現在使用者可見清單（R-035）。
 * Args:
 *   ctx {Object} 自測機的執行脈絡。
 * Returns:
 *   {{ok:(boolean|null), expected:string, actual:string, evidence:string}}
 */
function selfTestS35_(ctx) {
  var sandbox = ctx.config.quarterId;
  var quarters = ['2029T1', '2029T2', '2029T3', sandbox];

  // 1. 永不被列入要封存的一批（就算它是最舊那一個）。
  var plan = planQuarterRetention_(quarters, 1, sandbox);
  var inArchiveList = plan.toArchive.indexOf(sandbox) !== -1;
  var inVisibleList = plan.visible.indexOf(sandbox) !== -1;

  // 2. 永不出現在使用者的季度下拉——**勾了「顯示已封存」都不會**。
  var flags = {};
  quarters.forEach(function (q) { flags[q] = false; });
  var normalList = visibleQuarterList_(quarters, flags, false, sandbox);
  var withArchived = visibleQuarterList_(quarters, flags, true, sandbox);
  var leakedNormal = normalList.filter(function (q) { return q.quarterId === sandbox; }).length;
  var leakedArchived = withArchived.filter(function (q) { return q.quarterId === sandbox; }).length;

  // 3. 真的叫 archiveQuarter_() 要拋錯——靜靜略過會令呼叫方以為封存成功了。
  var threw = false;
  try {
    archiveQuarter_(sandbox, {});
  } catch (err) {
    threw = (err && err.code) === 'SANDBOX_QUARTER';
  }

  var ok = !inArchiveList && !inVisibleList
    && leakedNormal === 0 && leakedArchived === 0 && threw;

  return selfTestOutcome_(ok,
    '不入封存清單、不入可見清單、下拉兩種情況都不出現、直接叫會拋錯',
    '封存清單 ' + inArchiveList + '、可見清單 ' + inVisibleList
      + '、下拉（預設）' + leakedNormal + ' 次、下拉（顯示已封存）' + leakedArchived
      + ' 次、拋錯 ' + threw,
    '沙盒季度 ' + sandbox + '。⚠️ 它出現在幹事的季度下拉，等於叫人去填一批'
      + '自測機隨時會清走的假資料——那不是「有機會混亂」，是「一定會做白工」。');
}

/**
 * 用途：S36：有未發佈而且有內容的主日 → 封存前列出並要求確認（R-035）。
 * Args:
 *   ctx {Object} 自測機的執行脈絡。
 * Returns:
 *   {{ok:(boolean|null), expected:string, actual:string, evidence:string}}
 */
function selfTestS36_(ctx) {
  var config = ctx.config;
  var dates = selfTestSandboxDates_(config);
  if (dates.length === 0) return selfTestOutcome_(null, '沙盒季度有主日', '0 個', '請先跑 S19。');

  assertSelfTestWritableQuarter_(config.quarterId, config);

  // 在沙盒季度填一格內容，令它變成「未發佈但有內容」。
  var isoDate = dates[0];
  var loaded = loadWeekForWebApp_(isoDate);
  saveWeekFromWebApp_({
    isoDate: isoDate, lastSavedAt: loaded.lastSavedAt,
    week: { SERMON_TITLE: 'S36 測試講題 ' + ctx.runId }, dutyEdits: []
  });

  var blockers = findUnpublishedWorkInQuarter_(config.quarterId);
  var found = blockers.filter(function (b) { return b.isoDate === isoDate; });

  var ok = found.length === 1 && String(found[0].reason).indexOf('未發佈') !== -1;

  return selfTestOutcome_(ok,
    isoDate + ' 被列為「未發佈但有內容」',
    blockers.length + ' 個主日被列出'
      + (found.length === 1 ? ('，包括 ' + isoDate) : '，但不包括 ' + isoDate),
    '理由：' + (found.length === 1 ? found[0].reason : '（沒有列出）')
      + '　⚠️ 那一季還在做的話，收起它等於把幹事正在填的東西藏走，'
      + '所以封存之前一定要問這一句。');
}

/**
 * 用途：S37：沒有任何可見季度 → UI 顯示提示，不是空白下拉（R-035）。
 *
 *   ⚠️ 這一條驗的是這條功能**最大的風險**：「十月回來打開系統，見到一片
 *   空白。」沒有那一句提示的話，看的人分不出「資料不見了」與「資料被封存了」。
 * Args:
 *   ctx {Object} 自測機的執行脈絡。
 * Returns:
 *   {{ok:(boolean|null), expected:string, actual:string, evidence:string}}
 */
function selfTestS37_(ctx) {
  var sandbox = ctx.config.quarterId;
  var quarters = ['2029T1', '2029T2'];
  var allArchived = { '2029T1': true, '2029T2': true };

  var visible = visibleQuarterList_(quarters, allArchived, false, sandbox);
  var withArchived = visibleQuarterList_(quarters, allArchived, true, sandbox);

  var hintHasAction = String(RETENTION_EMPTY_HINT_).indexOf('顯示已封存') !== -1;

  var ok = visible.length === 0
    && withArchived.length === 2
    && Boolean(RETENTION_EMPTY_HINT_)
    && hintHasAction;

  return selfTestOutcome_(ok,
    '可見 0 季、勾「顯示已封存」見到 2 季、提示語講得出下一步',
    '可見 ' + visible.length + ' 季、勾之後 ' + withArchived.length + ' 季、'
      + '提示語' + (hintHasAction ? '有' : '沒有') + '講下一步',
    '提示語：「' + RETENTION_EMPTY_HINT_ + '」'
      + '　⚠️ 提示語一定要**講得出下一步**（撳「顯示已封存」或者建立新一季），'
      + '只講「沒有季度」等於把人留在原地。');
}


/**
 * 用途：數 `SendLog` 內 `STATUS='PREVIEW'` 有幾多筆，並取最後一筆的內文摘要。
 * Args: （無）
 * Returns:
 *   {{count:number, lastBodyPreview:string}}
 */
function selfTestCountPreviewSendLogRows_() {
  var rows = readSheet(SHEETS.SEND_LOG).filter(function (r) {
    return String(r.STATUS || '') === 'PREVIEW';
  });
  return {
    count: rows.length,
    lastBodyPreview: rows.length > 0 ? String(rows[rows.length - 1].BODY_PREVIEW || '') : ''
  };
}


/**
 * 用途：S22–S24 共用的守門：沙盒季度到底有沒有夏令時間轉換提示日。
 *
 *   ⚠️ 沒有的時候回一段**寫明怎樣改**的「不適用」，不是自己另揀一個季度。
 *   提示登在改動當日的前一個主日，所以要含提示日就要用 `YYYYT1`
 *   （4 月那一次，提示在 3 月底）或者 `YYYYT3`（9 月那一次）。
 * Args:
 *   config {Object} `selfTestConfig_()` 的回傳值。
 * Returns:
 *   {{ok:boolean, notice:(Object|undefined), outcome:(Object|undefined)}}
 */
function selfTestDstGate_(config) {
  if (!config.contentFolderId) {
    return {
      ok: false,
      outcome: selfTestOutcome_(null, '已設定內容表資料夾', '尚未設定',
        'Config 的 ' + CONFIG_KEYS.CONTENT_SHEET_FOLDER_ID + ' 是空的，所以略過。'
          + '⚠️ 「略過」不等於「通過」。')
    };
  }

  var dates = selfTestSandboxDates_(config);
  if (dates.length === 0) {
    return { ok: false, outcome: selfTestOutcome_(null, '沙盒季度有主日', '0 個', '請先跑 S19。') };
  }

  var notices = daylightSavingNoticesForDates_(dates);
  if (notices.length === 0) {
    return {
      ok: false,
      outcome: selfTestOutcome_(null, '沙盒季度含夏令時間轉換的前一個主日',
        '不適用：季度「' + config.quarterId + '」不含',
        '請把 Config 的 ' + CONFIG_KEYS.SELFTEST_QUARTER_ID
          + ' 改成一個含 4 月第一個主日或 9 月最後一個主日的季度。'
          + '⚠️ 提示登在**改動當日的前一個主日**，所以實際上要用 YYYYT1'
          + '（4 月那一次，提示日在 3 月底）或者 YYYYT3（9 月那一次，提示日在 9 月中）；'
          + 'YYYYT2 與 YYYYT4 永遠不會含提示日。'
          + '同時那一季必須是職事表沒有資料的季度，兩個條件都要滿足。'
          + '⚠️ 「不適用」不等於「通過」。')
    };
  }

  return { ok: true, notice: notices[0] };
}

/**
 * 用途：開啟沙盒季度的內容表（由 S03 建立）。
 * Args:
 *   config {Object} `selfTestConfig_()` 的回傳值。
 * Returns:
 *   {{ok:boolean, spreadsheet:(Spreadsheet|undefined), outcome:(Object|undefined)}}
 */
function selfTestOpenSandboxContentSheet_(config) {
  var row = findContentSheetRow_(config.quarterId);
  if (!row) {
    return {
      ok: false,
      outcome: selfTestOutcome_(null, 'S03 已經建立好內容表', '找不到登記', '請先跑 S03。')
    };
  }
  var spreadsheet = openContentSpreadsheet_(row.FILE_ID);
  if (!spreadsheet) {
    return {
      ok: false,
      outcome: selfTestOutcome_(false, '內容表開得到', '開不到',
        '內容表（' + maskContentFileId_(row.FILE_ID) + '）開不到。')
    };
  }
  return { ok: true, spreadsheet: spreadsheet };
}

/**
 * 用途：重新刷新沙盒季度的內容表（走**真正入口**
 *   `buildOrRefreshContentSheet_()`，夏令時間那一段就是在它裏面執行）。
 * Args:
 *   config {Object} `selfTestConfig_()` 的回傳值。
 * Returns:
 *   {{ok:boolean, spreadsheet:(Spreadsheet|undefined), result:(Object|undefined),
 *     outcome:(Object|undefined)}}
 */
function selfTestRefreshSandboxContentSheet_(config) {
  var result = buildOrRefreshContentSheet_(config.quarterId, {
    fileNameSuffix: SELF_TEST_CONTENT_SUFFIX_,
    serviceDates: selfTestSandboxDates_(config)
  });
  if (!result.ok) {
    return {
      ok: false,
      outcome: selfTestOutcome_(false, '刷新內容表成功', '失敗：' + result.reason, result.message || '')
    };
  }
  var opened = selfTestOpenSandboxContentSheet_(config);
  if (!opened.ok) return opened;
  return { ok: true, spreadsheet: opened.spreadsheet, result: result };
}

/**
 * 用途：讀回內容表 `家事報告` 之中 `SOURCE=SYSTEM_DST` 的那幾行。
 * Args:
 *   spreadsheet {Spreadsheet} 內容表。
 * Returns:
 *   {Object[]} 每個元素帶 `__rowNo`。
 */
function selfTestReadDstRows_(spreadsheet) {
  var tabDef = selfTestFindTabDef_('家事報告');
  var sheet = spreadsheet.getSheetByName(tabDef.tabName);
  if (!sheet) return [];
  return readContentTabRowsWithRowNo_(sheet, tabDef.keys).filter(function (row) {
    return String(row.SOURCE || '') === CONTENT_ROW_SOURCE.SYSTEM_DST;
  });
}

/**
 * 用途：由提示日反推轉換日（提示日 ＋ 7 天）。
 *
 *   ⚠️ 刻意用一支**與被驗邏輯無關**的算法（直接加 7 天），不是叫
 *   `daylightSavingChangesForYear_()`——兩邊用同一支的話會一齊錯、
 *   一齊報沒事，見 docs/已知bug類型.md 事故二十二。
 * Args:
 *   noticeIso {string} 提示日，yyyy-MM-dd。
 * Returns:
 *   {string} yyyy-MM-dd。
 */
function selfTestIndependentDstChangeIso_(noticeIso) {
  return formatIsoDate_(addDays_(normalizeDate_(noticeIso), 7));
}

/**
 * 用途：把一個季度**事奉相關那幾格**摘成一條字串，用來證明「補抓沒有動
 *   過任何事奉格」。
 *
 *   ⚠️ 刻意**不**包含 `ROSTER_STATUS`：那一欄補抓本來就應該更正，鎖住它
 *   等於斷言一件不對的事（見 `selfTestS20_()` 的說明）。
 * Args:
 *   quarterId {string} 季度 ID。
 * Returns:
 *   {{rowCount:number, digest:string}}
 */
function selfTestQuarterDutySnapshot_(quarterId) {
  var qid = String(quarterId || '').trim();
  var keys = rosterDerivedWeekFieldKeys_();
  var rows = readSheet(SHEETS.BULLETIN_WEEKS).filter(function (r) {
    return String(r.QUARTER_ID || '').trim() === qid;
  });

  var parts = rows.map(function (row) {
    var iso = (Object.prototype.toString.call(row.SERVICE_DATE) === '[object Date]')
      ? formatIsoDate_(row.SERVICE_DATE) : String(row.SERVICE_DATE || '');
    return iso + '|' + keys.map(function (key) {
      var v = row[key];
      return String(v === null || v === undefined ? '' : v);
    }).join('|');
  });
  parts.sort();

  return { rowCount: rows.length, digest: parts.join('\n') };
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
      STATUS: BULLETIN_WEEK_STATUS.DRAFT,
      // ⚠️ 一定要寫 ROSTER_STATUS。這一支只在「職事表沒有這一季」時才會
      //    被叫（見 selfTestS01_()），所以答案一定是 NOT_FOUND。
      //    漏寫的代價是留下一批狀態空白的資料列，而空白在報告上會變成
      //    「未算過」——S19／S20 就是被這個弄到看起來像有 bug。
      //    見 docs/已知bug類型.md 事故四十一。
      ROSTER_STATUS: ROSTER_STATUS.NOT_FOUND
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
  var beforeVersion = selfTestPublishVersion_(isoDate);

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
  // ⚠️ 記低「S13 這一次發佈是幾時」，S14 的證據要講得出 S13 → S14 相隔多少秒。
  ctx.lastPublishAtMs = new Date().getTime();
  ctx.lastPublishIsoDate = isoDate;

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
 * S14：連續發佈**同一份**兩次 → 斷言第二次被擋住（**任何一道守門都算**）、
 *   版本號不變，並在證據講明是**哪一道**擋住的。
 *
 *   ⚠️ 第三輪自測改寫。第二輪的 S14 只認 `PUBLISH_DEDUP_SEC` 那一道，
 *   結果實際跑出來是被 `UPLOAD_IS_CURRENT_MASTER`（「你選的是目前已發佈
 *   的那一份」）擋住的——**行為完全正確**，版本號維持 1，只是換了另一道
 *   守門。情境卻報失敗。
 *
 *   斷言指定了「用哪一道守門」而不是「結果對不對」，就是這一種假紅。
 *   見 docs/已知bug類型.md 事故三十二。
 *
 *   ⚠️ 為什麼第二輪那兩份「不同內容」的 PDF 其實一樣：
 *   `selfTestMakePdfBlob_()` 會把全部非 ASCII 字元換成 `?`，於是
 *   「自測防重複甲」與「自測防重複乙」都變成 `????????`——位元組完全
 *   相同。要真的造出不同內容，就要用 **ASCII** 分辨得出的文字。
 *   （S14b／S14c 用的是這個做法。）
 *
 *   這一條的分工：驗「連續撳兩次不會出兩個版本」這個**結果**。
 *   至於防重複那一道本身，交 S14b／S14c 專門驗。
 */
function selfTestS14_(ctx) {
  var config = ctx.config;

  // ⚠️ 時間證據**先算**，而且連略過那一條路都要附上去。
  var dedupSec = normalizeInt_(getConfig(CONFIG_KEYS.PUBLISH_DEDUP_SEC, '30'));
  var gapText = selfTestDescribePublishGap_(ctx, dedupSec);

  var guard = selfTestPublishGuard_(config);
  if (guard) {
    return selfTestOutcome_(guard.ok, guard.expected, guard.actual, guard.evidence + '　' + gapText);
  }

  var dates = selfTestSandboxDates_(config);
  if (dates.length < 2) {
    return selfTestOutcome_(null, '沙盒季度至少有兩個主日', dates.length + ' 個',
      'S14 刻意用另一個主日，令 S13 留下的防重複時間戳影響不到這一條。' + gapText);
  }

  var isoDate = dates[1];
  assertSelfTestWritableDate_(isoDate, config);

  var versionBefore = selfTestPublishVersion_(isoDate);
  var pdfBase64 = Utilities.base64Encode(
    selfTestMakePdfBlob_('selftest dedup A ' + ctx.runId).getBytes());

  var first = selfTestRunPublish_(config, {
    isoDate: isoDate, doPublish: true, doSend: false,
    pdfBase64: pdfBase64, pdfName: 'selftest-dedup-a.pdf', confirmed: true
  });
  if (!first.ok || first.duplicate === true) {
    return selfTestOutcome_(false, '第一次發佈成功',
      first.ok ? '第一次就被擋住' : ('失敗：' + first.reason),
      '主日 ' + isoDate + '；' + (first.message || (first.lines || []).join(' ')) + '　' + gapText);
  }
  var versionAfterFirst = selfTestPublishVersion_(isoDate);

  // ---- 第二次：立即再發佈**同一份**，兩次之間不做任何其他事 ----
  var second = selfTestRunPublish_(config, {
    isoDate: isoDate, doPublish: true, doSend: false,
    pdfBase64: pdfBase64, pdfName: 'selftest-dedup-a.pdf', confirmed: true
  });
  var versionAfter = selfTestPublishVersion_(isoDate);

  var block = describePublishBlock_(second);
  var versionHeld = versionAfter === versionAfterFirst;
  var ok = block.blocked && versionHeld;

  return selfTestOutcome_(ok,
    '第二次被擋住（任何一道守門都算）、版本號維持 ' + versionAfterFirst,
    (block.blocked ? ('被擋住（' + block.gateLabel + '）') : '沒有被擋住')
      + '、版本號 ' + versionAfter,
    '主日 ' + isoDate + '（刻意用 S13 以外那一個）；'
      + '第一次發佈後版本 ' + versionBefore + '→' + versionAfterFirst + '；'
      + '擋住的守門：' + block.gate + '（' + block.gateLabel + '）；'
      + '回覆：' + block.message + '　' + gapText);
}

/**
 * S14b：**視窗之內**、用內容真的不同的 PDF 再發佈同一個主日 →
 *   斷言被 `PUBLISH_DEDUP_SEC` 那一道擋住。
 *
 *   ⚠️ 這一條才是專門驗防重複的。內容不同才會繞過
 *   `UPLOAD_IS_CURRENT_MASTER`（那一道排在防重複之前），真正行到防重複
 *   那一步。內容相同的話，被擋住的原因分不清是哪一道——那正是 S14 的
 *   分工，兩條合起來才驗得齊。
 */
function selfTestS14b_(ctx) {
  var config = ctx.config;
  var dedupSec = normalizeInt_(getConfig(CONFIG_KEYS.PUBLISH_DEDUP_SEC, '30'));

  var guard = selfTestPublishGuard_(config);
  if (guard) return guard;

  if (!(dedupSec > 0)) {
    return selfTestOutcome_(null, 'PUBLISH_DEDUP_SEC 大於 0', String(dedupSec),
      '防重複已經關閉，這一條驗不到。⚠️「略過」不等於「通過」。');
  }

  var dates = selfTestSandboxDates_(config);
  if (dates.length < 3) {
    return selfTestOutcome_(null, '沙盒季度至少有三個主日', dates.length + ' 個',
      'S14b 用第三個主日，令 S13／S14 留下的時間戳影響不到這一條。');
  }

  var isoDate = dates[2];
  assertSelfTestWritableDate_(isoDate, config);

  var first = selfTestRunPublish_(config, {
    isoDate: isoDate, doPublish: true, doSend: false,
    pdfBase64: Utilities.base64Encode(selfTestMakePdfBlob_('selftest dedup B1 ' + ctx.runId).getBytes()),
    pdfName: 'selftest-dedup-b1.pdf', confirmed: true
  });
  if (!first.ok || first.duplicate === true) {
    return selfTestOutcome_(false, '第一次發佈成功',
      first.ok ? '第一次就被擋住' : ('失敗：' + first.reason),
      '主日 ' + isoDate + '；' + (first.message || (first.lines || []).join(' ')));
  }
  var versionAfterFirst = selfTestPublishVersion_(isoDate);

  // ⚠️ 內容真的不同：用 ASCII 分辨得出的文字（見 selfTestMakePdfBlob_ 的
  //    非 ASCII 換成 `?` 那件事）。
  var secondPdf = selfTestMakePdfBlob_('selftest dedup B2 different ' + ctx.runId);
  var second = selfTestRunPublish_(config, {
    isoDate: isoDate, doPublish: true, doSend: false,
    pdfBase64: Utilities.base64Encode(secondPdf.getBytes()),
    pdfName: 'selftest-dedup-b2.pdf', confirmed: true
  });
  var versionAfter = selfTestPublishVersion_(isoDate);

  var block = describePublishBlock_(second);
  var byDedup = block.gate === 'DEDUP';
  var ok = byDedup && versionAfter === versionAfterFirst;

  return selfTestOutcome_(ok,
    '被防重複（PUBLISH_DEDUP_SEC）擋住、版本號維持 ' + versionAfterFirst,
    (block.blocked ? ('被擋住（' + block.gateLabel + '）') : '沒有被擋住')
      + '、版本號 ' + versionAfter,
    '主日 ' + isoDate + '；PUBLISH_DEDUP_SEC=' + dedupSec + '；'
      + '兩份 PDF 的位元組數 ' + first.published.versionNo + ' 版 vs '
      + secondPdf.getBytes().length + ' 位元組（內容真的不同，所以繞得過'
      + '「你選的是目前已發佈的那一份」那一道）；'
      + '擋住的守門：' + block.gate + '；回覆：' + block.message);
}

/**
 * S14c：**視窗之外**、內容不同 → 斷言**不擋**，版本 +1。
 *
 *   ⚠️ 這一條是 S14b 的「應該綠燈變紅燈」對照：防重複如果連正常的改版
 *   重發都擋，那才是真的壞了。只驗「擋得到」而不驗「不該擋的時候不擋」，
 *   等於只證明了它會擋，沒有證明它擋得準。
 *
 *   ⚠️ 「視窗之外」用**把時間戳往前撥**來造，不是真的等 30 秒——自測機
 *   有時間預算，等 30 秒是浪費，而且會令這一條變成又一個依賴時間的測試。
 *   撥的是 `PUBLISH_LAST|<沙盒主日>` 這個 Script Property，只影響沙盒
 *   那一個主日。
 */
function selfTestS14c_(ctx) {
  var config = ctx.config;
  var dedupSec = normalizeInt_(getConfig(CONFIG_KEYS.PUBLISH_DEDUP_SEC, '30'));

  var guard = selfTestPublishGuard_(config);
  if (guard) return guard;

  var dates = selfTestSandboxDates_(config);
  if (dates.length < 4) {
    return selfTestOutcome_(null, '沙盒季度至少有四個主日', dates.length + ' 個',
      'S14c 用第四個主日，令其他情境留下的時間戳影響不到這一條。');
  }

  var isoDate = dates[3];
  assertSelfTestWritableDate_(isoDate, config);

  var first = selfTestRunPublish_(config, {
    isoDate: isoDate, doPublish: true, doSend: false,
    pdfBase64: Utilities.base64Encode(selfTestMakePdfBlob_('selftest dedup C1 ' + ctx.runId).getBytes()),
    pdfName: 'selftest-dedup-c1.pdf', confirmed: true
  });
  if (!first.ok || first.duplicate === true) {
    return selfTestOutcome_(false, '第一次發佈成功',
      first.ok ? '第一次就被擋住' : ('失敗：' + first.reason),
      '主日 ' + isoDate + '；' + (first.message || (first.lines || []).join(' ')));
  }
  var versionAfterFirst = selfTestPublishVersion_(isoDate);

  var rewind = selfTestRewindPublishStamp_(isoDate, config, (dedupSec + 60) * 1000);
  if (!rewind.ok) {
    return selfTestOutcome_(null, '撥得到防重複時間戳', '撥不到',
      rewind.message + '　⚠️「略過」不等於「通過」。');
  }

  var second = selfTestRunPublish_(config, {
    isoDate: isoDate, doPublish: true, doSend: false,
    pdfBase64: Utilities.base64Encode(
      selfTestMakePdfBlob_('selftest dedup C2 different ' + ctx.runId).getBytes()),
    pdfName: 'selftest-dedup-c2.pdf', confirmed: true
  });
  var versionAfter = selfTestPublishVersion_(isoDate);

  var block = describePublishBlock_(second);
  var ok = second.ok === true && !block.blocked && versionAfter === versionAfterFirst + 1;

  return selfTestOutcome_(ok,
    '不擋、版本號由 ' + versionAfterFirst + ' 變 ' + (versionAfterFirst + 1),
    (block.blocked ? ('竟然被擋住（' + block.gateLabel + '）') : '沒有被擋')
      + '、版本號 ' + versionAfter,
    '主日 ' + isoDate + '；PUBLISH_DEDUP_SEC=' + dedupSec + '；'
      + '已把防重複時間戳撥前 ' + (dedupSec + 60) + ' 秒（' + rewind.message + '）；'
      + '這是正常的改版重發，擋了才是錯；回覆：' + block.message);
}

/**
 * 用途：判斷一次發佈是不是被某一道守門擋住了，以及**是哪一道**。
 *   **純函式。**
 *
 *   ⚠️ 這一支存在的理由：斷言要針對**可觀察的結果**（有沒有被擋、版本
 *   有沒有變），至於是哪一道守門，記入證據，不寫進斷言。
 *   見 docs/已知bug類型.md 事故三十二。
 * Args:
 *   result {Object} `runPublishFlow_()` 的回傳值。
 * Returns:
 *   {{blocked:boolean, gate:string, gateLabel:string, message:string}}
 */
function describePublishBlock_(result) {
  var r = result || {};

  if (r.duplicate === true) {
    return {
      blocked: true, gate: 'DEDUP', gateLabel: '防重複（PUBLISH_DEDUP_SEC）',
      message: (r.lines || []).join(' ') || r.message || ''
    };
  }

  if (r.ok === false) {
    var reason = String(r.reason || '');
    return {
      blocked: true,
      gate: reason || 'UNKNOWN',
      gateLabel: publishGateLabel_(reason),
      message: r.message || (r.lines || []).join(' ')
    };
  }

  return {
    blocked: false, gate: '', gateLabel: '（沒有被擋）',
    message: (r.lines || []).join(' ') || r.message || ''
  };
}

/**
 * 用途：把發佈守門的機器碼換成給人看的名稱。
 * Args:
 *   reason {string}
 * Returns:
 *   {string} 認不出就原樣回機器碼——講一個機器碼，好過不講。
 */
function publishGateLabel_(reason) {
  var labels = {
    UPLOAD_IS_CURRENT_MASTER: '揀錯檔案（你選的是目前已發佈的那一份）',
    UPLOAD_IS_PLACEHOLDER: '揀錯檔案（你選的是佔位檔）',
    NOT_PDF: '不是 PDF',
    EMPTY_FILE: '空檔案',
    TOO_LARGE: '超過大小上限',
    NO_MASTER_FILE: '未建立 master 發佈檔案',
    NO_ARCHIVE_FOLDER: '未設定存檔資料夾',
    NEVER_PUBLISHED: '從未發佈過'
  };
  var code = String(reason || '');
  return labels[code] || (code || '（沒有回報原因）');
}

/**
 * 用途：把某一個**沙盒主日**的防重複時間戳往前撥，模擬「已經超出視窗」。
 *
 *   ⚠️ 三重保護，避免這一支變成一個可以亂改正式狀態的後門：
 *     1. 只准撥沙盒季度的主日（`assertSelfTestWritableDate_()`）；
 *     2. 只改 `PUBLISH_LAST|<主日>` 這一個鍵，不碰任何其他東西；
 *     3. 撥不到就回 `ok:false`，由呼叫方報「驗證不到」——不可以當成通過。
 * Args:
 *   isoDate {string} 沙盒主日。
 *   config {Object} `selfTestConfig_()` 的回傳值。
 *   backMs {number} 往前撥多少毫秒。
 * Returns:
 *   {{ok:boolean, message:string}}
 */
function selfTestRewindPublishStamp_(isoDate, config, backMs) {
  assertSelfTestWritableDate_(isoDate, config);

  var key = PUBLISH_LAST_KEY_PREFIX_ + String(isoDate);
  var raw = readPublishScriptProperty_(key);
  if (!raw) {
    return { ok: false, message: '找不到 ' + isoDate + ' 的防重複時間戳（' + key + '）。' };
  }

  var parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, message: '防重複時間戳解析不到：' + raw.slice(0, 60) };
  }
  if (!parsed || typeof parsed.at !== 'number') {
    return { ok: false, message: '防重複時間戳沒有 at 欄位。' };
  }

  var written = writePublishScriptProperty_(key, JSON.stringify({
    at: parsed.at - Number(backMs),
    versionNo: parsed.versionNo
  }));
  if (!written) {
    return { ok: false, message: '寫不回防重複時間戳（Script Properties 不可用）。' };
  }
  return { ok: true, message: '原本 ' + parsed.at + '，改成 ' + (parsed.at - Number(backMs)) };
}

/**
 * 用途：把「S13 那一次發佈 → 現在」相隔多少秒排成一句證據。
 *
 *   ⚠️ 這一句是第二輪自測要拿的**原始資料**：舊版 S14 靠「S13 剛剛發佈過」
 *   這個前提，而每個情境耗時 14 至 23 秒、視窗只有 30 秒——到底有沒有超出
 *   視窗，要看得見那個數才講得準，不可以靠估。
 * Args:
 *   ctx {Object} 自測執行內容。
 *   dedupSec {?number} `PUBLISH_DEDUP_SEC` 的現值。
 * Returns:
 *   {string}
 */
function selfTestDescribePublishGap_(ctx, dedupSec) {
  var seconds = Number(dedupSec);
  if (!ctx || !ctx.lastPublishAtMs) {
    return '（S13 未記下發佈時刻，講不出 S13 → S14 相隔多少秒。）';
  }
  var gapSec = Math.round((new Date().getTime() - ctx.lastPublishAtMs) / 1000);
  var verdict;
  if (!(seconds > 0)) {
    verdict = 'PUBLISH_DEDUP_SEC 不是正數，防重複等於關閉';
  } else if (gapSec > seconds) {
    verdict = '已經超出視窗——舊版 S14 在這個情況下必然「擋不住」，'
      + '那不是防重複壞了，是測試依賴時間';
  } else {
    verdict = '仍在視窗之內';
  }
  return '（參考：S13 於 ' + gapSec + ' 秒前發佈 ' + (ctx.lastPublishIsoDate || '')
    + '，PUBLISH_DEDUP_SEC=' + dedupSec + '，' + verdict + '。）';
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
 * 用途：自測機專用——某一個沙盒主日**目前**最新的版本號。
 *
 *   ⚠️ 刻意只在**自測那一類**的 `PublishLog` 行裏面數，跟
 *   `executePublish_()` 寫版本號時用的那一堆完全一樣。
 *   本來寫成「整張表照數」也答得對，因為沙盒主日跟真實主日不會撞——
 *   但那是靠巧合答對。靠巧合答對的斷言，撞的那一日不會報錯，只會靜靜
 *   給一個錯的數字。見 docs/已知bug類型.md 事故四十六。
 * Args:
 *   isoDate {string} 沙盒主日。
 * Returns:
 *   {number} 從未發佈過就是 0。
 */
function selfTestPublishVersion_(isoDate) {
  return nextPublishVersion_(
    publishLogRowsOfKind_(readSheet(SHEETS.PUBLISH_LOG), true), isoDate) - 1;
}

/**
 * 用途：把發佈流程指到**沙盒** master 檔案，跑完再還原。
 *
 *   ⚠️ `runPublishFlow_()` 是真實入口，它經 `effectivePublishMasterFileId_()`
 *   取 master 檔案 ID。自測機要驗它，又絕對不可以碰正式那個檔案，所以在
 *   呼叫前後設一個**只活在這一次執行之內**的覆寫。
 *
 *   ⚠️ **2026-08-27 改過，理由一定要記住**（事故四十三）：舊做法是暫時把
 *   沙盒 ID **寫入 Config** 的 `PUBLISHED_PDF_FILE_ID`，跑完用 `finally`
 *   還原。但 Apps Script 執行被**硬中斷**時（六分鐘上限、使用者撳停、
 *   配額用盡）`finally` 根本不會執行，於是沙盒 ID 就永遠留在正式那一格。
 *   而且中斷發生在寫入之後，連 `AuditLog` 都沒有一筆——查都無從查起。
 *   之後每一次真實發佈都會寫進沙盒檔案，教會網站那條連結會被洗掉。
 *
 *   改成記憶體覆寫之後，執行一死覆寫就跟住死，**Config 由頭到尾一格未動**。
 *   `finally` 仍然保留（正常結束時即時清走），但它已經不再是唯一防線。
 * Args:
 *   config {Object} `selfTestConfig_()` 的回傳值。
 *   payload {Object} 見 `runPublishFlow_()`。
 * Returns:
 *   {Object} `runPublishFlow_()` 的回傳值。
 */
function selfTestRunPublish_(config, payload) {
  setPublishMasterFileIdOverride_(config.masterFileId);
  try {
    return runPublishFlow_(payload);
  } finally {
    setPublishMasterFileIdOverride_(null);
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
 *   `resolveNextSendSundayIso_()` 選中的主日、必須是星期日），加上
 *   `DRY_RUN` 的狀態。
 *   **這是一個已知的覆蓋缺口**，寫在 docs/待確認事項.md，不當成已經驗過。
 */
function selfTestS18_(ctx) {
  // ⚠️ 用**真實入口** resolveNextSendSundayIso_()，不是在這裡自己算一次。
  //    第一輪自測 S18 就是自己算的：「今日 ＋ SEND_TARGET_OFFSET_DAYS」，
  //    2026-08-22（星期六）算出 2026-08-28（星期五）。
  var schedule = resolveNextSendSundayIso_();
  var targetIso = schedule.isoDate;
  var todayIso = schedule.todayIso;

  var isSunday = schedule.ok && isIsoDateSunday_(targetIso);
  var dryRun = normalizeBoolean_(getConfig(CONFIG_KEYS.DRY_RUN, 'TRUE')) === true;

  // ⚠️ 這裡刻意用一支**與被驗邏輯無關**的算法對答案：直接數星期幾。
  //    如果驗證方也叫 resolveNextSendSundayIso_()，兩邊會一齊錯、一齊
  //    報沒事，見 docs/已知bug類型.md 事故二十二。
  var independentSunday = nextSundayOnOrAfter_(todayIso);
  var matchesIndependent = schedule.ok
    && (targetIso === independentSunday || schedule.skipped.length > 0);

  var ok = isSunday && matchesIndependent && dryRun;
  return selfTestOutcome_(ok, '選中下一個主日（' + independentSunday + '）而且 DRY_RUN=TRUE',
    (schedule.ok ? ('選中 ' + targetIso + '（' + (isSunday ? '是' : '不是') + '星期日）')
      : ('算不出：' + schedule.reason)) + '、DRY_RUN=' + dryRun,
    describeNextSendSunday_(schedule)
      + '　獨立算法（直接數星期幾）：' + independentSunday
      + '　⚠️ 覆蓋缺口：這一條**沒有**真的呼叫 weeklyBulletinSendTrigger_()，'
      + '因為那一支會順手替真實季度建立季度填寫表，違反沙盒規則。'
      + '真正的觸發器行為仍然要人手驗一次（見需求登記 R-028）。');
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

    // 不變量紅了，就算情境本身通過，整條也不可以當成綠——「這一步做對了，
    // 但系統因此進入一個自相矛盾的狀態」仍然要有人去查。
    //
    // ⚠️ 但它是**另一種**紅：報告要分開講，見 buildSelfTestReportLines_()。
    if (record.result === SELF_TEST_RESULT_.PASS && invariants.failedCount > 0) {
      record.result = SELF_TEST_RESULT_.INVARIANT_WARNING;
      record.actual += '；不變量 ' + record.invariantFailures.join('、') + ' 不成立';
      // ⚠️ **一定要連 evidence 一齊寫出來。** 舊版只寫 expected／actual，
      //    於是自測機連續 25 個情境都報「I03（預期 全部對得上，實際 1 項
      //    對不上）」——同一項，25 次，而**從來沒有講是哪一項**。證據其實
      //    早就算好了，只是在這裏被丟掉。這正是本專案那一條「報告要有證據，
      //    不是只有 ok／fail」。見 docs/待確認事項.md W-1。
      record.evidence += '　⚠️ 情境本身通過，但跑完之後不變量不成立：'
        + invariants.failed.map(function (f) {
          return f.id + '（預期 ' + f.expected + '，實際 ' + f.actual + '）'
            + (f.evidence ? ('　證據：' + f.evidence) : '');
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

  var summary = Object.assign({
    ok: true,
    runId: runId,
    message: '',
    results: results,
    pendingIds: pendingIds,
    stoppedForTime: stoppedForTime,
    totalScenarios: scenarios.length
  }, selfTestSummaryCounts_(results));

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

  lines.push('自測機：' + selfTestCountsPhrase_(summary));
  lines.push('執行編號：' + summary.runId);

  if (summary.stoppedForTime) {
    lines.push('');
    lines.push('⚠️ 執行時間到，已經乾淨停低。跑到 '
      + (summary.results.length > 0 ? summary.results[summary.results.length - 1].id : '（沒有跑到任何一個）')
      + '，還有 ' + summary.pendingIds.length + ' 個未跑（'
      + summary.pendingIds.join('、') + '），請執行〔繼續跑自測〕。');
  }

  // ⚠️ 兩種紅要分開講。第二輪自測 18 個情境 6 紅，其中 5 個是同一條不變量
  //    （I06）拖出來的——那 5 個情境自己全部寫住「實際：符合」。混在一起
  //    顯示的話，看報告的人會以為六個功能壞了，實際只有一個要查。
  //    見 docs/已知bug類型.md 事故三十一。
  var failed = summary.results.filter(function (r) { return r.result === SELF_TEST_RESULT_.FAIL; });
  if (failed.length > 0) {
    lines.push('');
    lines.push('【情境本身失敗】　← 真的要修的東西');
    failed.forEach(function (r) {
      lines.push('');
      var failedLabel = r.id + '　' + r.name;
      lines.push('🔴 ' + failedLabel);
      lines.push('　　預期：' + r.expected);
      lines.push('　　實際：' + r.actual);
      lines.push('　　證據：' + r.evidence);
    });
  }

  var warned = summary.results.filter(function (r) {
    return r.result === SELF_TEST_RESULT_.INVARIANT_WARNING;
  });
  if (warned.length > 0) {
    lines.push('');
    lines.push('【情境通過，但不變量不成立】　← 通常是不變量自己的問題');
    var warnedIds = {};
    warned.forEach(function (r) {
      (r.invariantFailures || []).forEach(function (checkId) { warnedIds[checkId] = true; });
    });
    lines.push('　　牽涉的不變量：' + Object.keys(warnedIds).sort().join('、')
      + '；受影響的情境 ' + warned.length + ' 個。');
    lines.push('　　⚠️ 一條不變量不成立，會令它後面每一個情境一齊變黃。'
      + '先查那一條不變量，不要逐個情境查。');
    warned.forEach(function (r) {
      lines.push('');
      var warnedLabel = r.id + '　' + r.name;
      lines.push('🟡 ' + warnedLabel);
      lines.push('　　情境本身：通過（' + r.expected + '）');
      lines.push('　　不成立的不變量：' + (r.invariantFailures || []).join('、'));
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
 * 用途：把四種結果數成一句話。**純函式。**
 *
 *   ⚠️ 「不變量警告」一定要單獨數出來，不可以併入「通過」也不可以併入
 *   「失敗」。併入通過等於放過一個真的問題；併入失敗等於把一個要查的
 *   問題報成六個。
 * Args:
 *   summary {Object} 帶 totalScenarios／各項數目／pendingIds。
 * Returns:
 *   {string}
 */
function selfTestCountsPhrase_(summary) {
  var total = summary.totalScenarios || summary.results.length;
  return total + ' 個情境，'
    + summary.passCount + ' 通過 '
    + summary.failCount + ' 失敗 '
    + (summary.invariantWarningCount || 0) + ' 不變量警告 '
    + summary.skipCount + ' 略過'
    + (summary.pendingIds.length > 0 ? ('　' + summary.pendingIds.length + ' 未跑') : '');
}

/**
 * 用途：由一批情境結果算出各種數目。**純函式**，令兩個呼叫方
 *   （`runSelfTest_()` 與〔查看自測報告〕）不會各數一次而數法不同。
 * Args:
 *   results {Object[]}
 * Returns:
 *   {{passCount:number, failCount:number, invariantWarningCount:number,
 *     skipCount:number}}
 */
function selfTestSummaryCounts_(results) {
  function countOf(state) {
    return (results || []).filter(function (r) { return r.result === state; }).length;
  }
  return {
    passCount: countOf(SELF_TEST_RESULT_.PASS),
    failCount: countOf(SELF_TEST_RESULT_.FAIL),
    invariantWarningCount: countOf(SELF_TEST_RESULT_.INVARIANT_WARNING),
    skipCount: countOf(SELF_TEST_RESULT_.SKIPPED)
  };
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

  var lines = ['自測機：' + selfTestCountsPhrase_(summary)];

  var warned = summary.results.filter(function (r) {
    return r.result === SELF_TEST_RESULT_.INVARIANT_WARNING;
  });
  if (warned.length > 0) {
    var warnedIds = {};
    warned.forEach(function (r) {
      (r.invariantFailures || []).forEach(function (checkId) { warnedIds[checkId] = true; });
    });
    lines.push('');
    lines.push('🟡 ' + warned.length + ' 個情境本身通過，但不變量 '
      + Object.keys(warnedIds).sort().join('、') + ' 不成立。'
      + '先查那一條不變量，不要逐個情境查。');
  }

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
        + '職事表：全程唯讀，跑完會比對版本記錄確認。\n'
        // ⚠️ 開跑前就要講，不是跑完才在報告裏見到「不適用」。跑一次要幾分鐘，
        //    等到最後才知道有三條情境根本驗不到，等於白等。
        + selfTestDstCoverageWarning_(config) + '\n'
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
    var summary = Object.assign({
      ok: true, runId: runId, message: '', results: results,
      pendingIds: scenarioIds.filter(function (id) { return doneIds.indexOf(id) === -1; }),
      stoppedForTime: false,
      totalScenarios: scenarioIds.length
    }, selfTestSummaryCounts_(results));

    writeDiagnosticsReport_('自測機報告', buildSelfTestReportLines_(summary));
    ui.alert('查看自測報告', buildSelfTestShortSummary_(summary), ui.ButtonSet.OK);
  } catch (err) {
    logMenuError_('menuShowSelfTestReport_', err);
    ui.alert('查看自測報告失敗', enrichAuthError_(err), ui.ButtonSet.OK);
  }
}
