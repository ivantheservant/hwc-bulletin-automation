/**
 * src/ContentAutoSync.gs
 *
 * 2026-10-30（Ivan，示範之後）：內容表有改動時，每隔 Config `CONTENT_AUTO_SYNC_MINUTES` 分鐘（預設 30）
 * 自動匯入週報。目的：預覽連結（?page=preview）看得到內容表的改動，不用等幹事登入填寫介面。
 *
 *   - 只匯入**今日及之後**、未封存的主日（「今日」經 `webAppTodayIso_()`，測試時跟 Config
 *     `WEBAPP_SIMULATED_TODAY`）；已經過去的主日不動。
 *   - 只處理生效中的內容表（`ContentSheets` 有效＝TRUE），沙盒季度（Config `SELFTEST_QUARTER_ID`）不處理。
 *   - 內容表檔案的最後修改時間與上一次同步時一樣就不開檔（省時間）。修改時間記在指令碼屬性，
 *     只是省時間，不是真相來源：讀不到或過期就照樣同步一次。
 *   - 與填寫介面載入時的自動匯入同一套：先預覽，有改動才寫（`previewContentImport_()` →
 *     `applyContentImport_()`），寫入前存版本、逐格 AuditLog、整段在指令碼鎖之內。
 *   - 失敗分兩種（R-056，2026-11-17）：結構性的（例如內容表要先更新版面）每個修改時間只記一次 ErrorLog，
 *     「不再試」的記錄有效期 30 日；暫時性的（Google 暫時出錯、寫入失敗）同一個修改時間連續失敗未滿 3 次不當作
 *     已處理，下一次觸發照樣再試，ErrorLog 只記第 1 次與第 3 次，第 3 次起內容表有改動才再試。拿不到鎖就
 *     下一次再試。沒有今日及之後主日的季度不呼叫 Drive。
 *
 * R-060（2026-11-17）：匯入有時間預算（Config `IMPORT_TIME_BUDGET_SEC`，預設 240 秒）。用完就在寫好一個完整主日之後停下，
 *   這一次**不記修改時間**（`PARTIAL`），下一次觸發重新比較、由下一個主日繼續；AuditLog 摘要行講明做了幾個主日。
 *   同一次觸發有幾個季度時共用同一個預算，預算用完之後尚未處理的季度標 `DEFERRED`，下一次觸發才做。
 *
 * 觸發器由「安裝自動寄送觸發器」一併安裝（src/Trigger.gs）。
 */

'use strict';

/** 指令碼屬性鍵的前綴：記下每一季內容表上一次同步時的最後修改時間。 */
var CONTENT_AUTO_SYNC_PROPERTY_PREFIX_ = 'CONTENT_SYNC_MTIME_';

/** 修改時間記錄的有效期（秒）。過期就當作未同步過，照樣同步一次。 */
var CONTENT_AUTO_SYNC_PROPERTY_MAX_AGE_SEC_ = 7 * 24 * 3600;

/** R-056：記下「連續失敗次數」的指令碼屬性前綴（值帶指紋與次數）。 */
var CONTENT_AUTO_SYNC_FAIL_PREFIX_ = 'CONTENT_SYNC_FAIL_';

/** R-056：記下「結構性失敗，或者連續失敗 3 次所以放棄再試」的指令碼屬性前綴（值是修改時間指紋）。 */
var CONTENT_AUTO_SYNC_STRUCT_PREFIX_ = 'CONTENT_SYNC_STRUCT_';

/** R-056：「不再試」記錄的有效期（秒）：30 日。比七日長，免得同一句錯誤每七日重複一次。 */
var CONTENT_AUTO_SYNC_STRUCT_MAX_AGE_SEC_ = 30 * 24 * 3600;

/** R-056：同一個修改時間指紋連續失敗幾次之後放棄（內容表有改動才再試）。 */
var CONTENT_AUTO_SYNC_MAX_FAILS_ = 3;

/** Apps Script 時間觸發器 `everyMinutes()` 只接受這幾個值；60 用 `everyHours(1)`。 */
var CONTENT_AUTO_SYNC_ALLOWED_MINUTES_ = [1, 5, 10, 15, 30, 60];

/**
 * 用途：把 Config `CONTENT_AUTO_SYNC_MINUTES` 解析成觸發器間隔。純函式。
 * Args:
 *   raw {*} Config 的原始值。
 * Returns:
 *   {{minutes:number, valid:boolean}} `minutes` 是 0 代表不自動同步。不是允許的值時 `valid:false`、`minutes:0`
 *     （呼叫方要講出來，不可以靜靜當作關掉）。
 * Raises:
 *   （無）
 */
function parseContentAutoSyncMinutes_(raw) {
  var text = String(raw === null || raw === undefined ? '' : raw).trim();
  if (text === '' || text === '0') return { minutes: 0, valid: true };
  var n = Number(text);
  if (CONTENT_AUTO_SYNC_ALLOWED_MINUTES_.indexOf(n) === -1) return { minutes: 0, valid: false };
  return { minutes: n, valid: true };
}

/**
 * 用途：這一季要自動同步哪幾個主日：屬於這一季、日期在今日或之後、未封存。純函式。
 * Args:
 *   weekRows {Object[]} `BulletinWeeks` 的資料列。
 *   quarterId {string} 季度 ID。
 *   todayIso {string} 今日，yyyy-MM-dd。
 * Returns:
 *   {string[]} 由舊到新，不重複。
 * Raises:
 *   （無）
 */
function planContentAutoSyncDates_(weekRows, quarterId, todayIso) {
  var qid = String(quarterId || '').trim();
  var today = String(todayIso || '').trim();
  var seen = {};
  var out = [];
  (weekRows || []).forEach(function (row) {
    if (String(row.QUARTER_ID || '').trim() !== qid) return;
    if (normalizeBoolean_(row.ARCHIVED) === true) return;
    // 2026-10-30：特別崇拜沒有內容表的行（家事報告等直接跟上一個主日），不用匯入。
    //    2026-11-04：家事報告等另外填寫的特別崇拜照常匯入（只限四張清單分頁）。
    if (isSpecialServiceRow_(row) && !isOwnContentSpecialRow_(row)) return;
    var iso = row.SERVICE_DATE instanceof Date ? formatIsoDate_(row.SERVICE_DATE) : String(row.SERVICE_DATE || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return;
    if (today && iso < today) return;
    if (seen[iso]) return;
    seen[iso] = true;
    out.push(iso);
  });
  return out.sort();
}

/**
 * 用途：時間觸發器的入口（每 N 分鐘）。任何失敗都寫 ErrorLog（`SOURCE='TRIGGER'`），不拋出。
 * Args: （無，時間觸發器固定簽章）
 * Returns:
 *   {void}
 */
function contentAutoSyncTrigger_() {
  try {
    runContentAutoSync_({ source: 'TRIGGER' });
  } catch (err) {
    appendErrorLog_({
      source: ERROR_LOG_SOURCE.TRIGGER, functionName: 'contentAutoSyncTrigger_',
      errorCode: (err && err.code) || 'ERROR',
      message: (err && err.message) ? err.message : String(err), detail: buildErrorDetail_(err)
    });
  }
}

/**
 * 用途：這一季內容表指紋（本季與上一季的修改時間）失敗次數記錄的屬性鍵。R-056。
 * Args:
 *   quarterId {string} 季度 ID。
 * Returns:
 *   {string}
 */
function contentSyncFailKey_(quarterId) {
  return CONTENT_AUTO_SYNC_FAIL_PREFIX_ + String(quarterId || '');
}

/**
 * 用途：讀出「同一個修改時間指紋」已經連續失敗了幾次。指紋不同（內容表有改動）、記錄過期、讀不到、格式不對一律回 0。
 * Args:
 *   quarterId {string} 季度 ID。
 *   fingerprint {string} 這一次的修改時間指紋（`contentSyncFingerprint_()`）。
 * Returns:
 *   {number}
 * Raises:
 *   （無）
 */
function readContentSyncFailCount_(quarterId, fingerprint) {
  var raw = readTimedScriptProperty_(contentSyncFailKey_(quarterId), CONTENT_AUTO_SYNC_PROPERTY_MAX_AGE_SEC_);
  if (!raw) return 0;
  try {
    var rec = JSON.parse(raw);
    if (rec && String(rec.m) === String(fingerprint) && isFinite(Number(rec.n))) return Number(rec.n);
  } catch (err) {
    // 格式不對當作沒有記錄。
  }
  return 0;
}

/**
 * 用途：內容表指紋：本季與上一季內容表的最後修改時間。任何一個讀不到就回 `null`（呼叫方當作「有改過」，照樣同步，
 *   亦記不到失敗次數所依據的指紋）。純函式。
 * Args:
 *   ownMtime {?number|string} 本季內容表的修改時間。
 *   prevMtime {?number|string} 上一季內容表的修改時間；沒有上一季內容表傳空字串。
 * Returns:
 *   {?string}
 */
function contentSyncFingerprint_(ownMtime, prevMtime) {
  if (ownMtime === null || prevMtime === null) return null;
  return String(ownMtime) + '|' + String(prevMtime);
}

/**
 * 用途：處理一次自動同步的失敗（暫時性的 Google 錯誤等）。R-056：
 *   「同一個修改時間指紋」連續失敗未滿 `CONTENT_AUTO_SYNC_MAX_FAILS_` 次**不記修改時間**，下一次觸發照樣再試；
 *   ErrorLog 只在第 1 次與第 3 次記；第 3 次才記下「不再試」（有效期 30 日），訊息講明。
 *   讀不到修改時間（指紋是 `null`）時沒有東西可以記下來，所以會一直再試，ErrorLog 仍然只記第 1、3 次。
 * Args:
 *   quarterId {string} 季度 ID。
 *   fingerprint {?string} 修改時間指紋。
 *   message {string} 給人看的失敗原因。
 *   errorCode {string} ErrorLog 的錯誤代碼。
 *   detail {string} ErrorLog 的 DETAIL（可以是空字串）。
 * Returns:
 *   {{count:number, giveUp:boolean}} `count` 是這一次之後的連續失敗次數；`giveUp` 為 true 代表這一次起不再試
 *     （內容表有改動才再試）。
 * Raises:
 *   （無：寫 ErrorLog 失敗由 `appendErrorLog_()` 自己吞掉）
 */
function recordContentSyncFailure_(quarterId, fingerprint, message, errorCode, detail) {
  var fp = fingerprint === null ? 'NO_MTIME' : String(fingerprint);
  var count = readContentSyncFailCount_(quarterId, fp) + 1;
  var giveUp = count >= CONTENT_AUTO_SYNC_MAX_FAILS_;

  if (count === 1 || count === CONTENT_AUTO_SYNC_MAX_FAILS_) {
    appendErrorLog_({
      source: ERROR_LOG_SOURCE.TRIGGER, functionName: 'runContentAutoSync_',
      errorCode: errorCode,
      message: '內容表自動同步（季度 ' + quarterId + '）失敗：' + message
        + (giveUp ? '　已連續失敗 ' + count + ' 次，內容表再有改動之前不會再試。'
          : '　（第 ' + count + ' 次，下一次觸發會再試）'),
      detail: detail || ''
    });
  }

  writeTimedScriptProperty_(contentSyncFailKey_(quarterId), JSON.stringify({ m: fp, n: count }));
  if (giveUp && fingerprint !== null) {
    writeTimedScriptProperty_(CONTENT_AUTO_SYNC_STRUCT_PREFIX_ + quarterId, String(fingerprint));
  }
  return { count: count, giveUp: giveUp };
}

/**
 * 用途：跑一次內容表自動同步（見檔頭）。IO 層。
 *
 *   R-056（2026-11-17）：
 *     - 先算這一季有沒有「今日及之後」的主日（`planContentAutoSyncDates_()`），**沒有就不呼叫 Drive**
 *       （`NO_DATES`）。以前每 30 分鐘為每一個生效內容表讀兩次修改時間，包括早已過去的季度。
 *     - 暫時性失敗（例外、寫入失敗）不當作已處理：同一個修改時間指紋連續失敗未滿 3 次，下一次觸發照樣再試
 *       （`recordContentSyncFailure_()`）。成功、`NO_CHANGE`、`UNCHANGED` 都清走失敗次數。
 *     - 結構性失敗（`preview.ok === false`，例如版面過舊）行為不變，只是「不再試」的記錄有效期由七日改為 30 日
 *       （七日過期令同一句錯誤每七日重複一次）。
 * Args:
 *   options {{source:string=, todayIso:string=, timeBudgetSec:number=}=} `todayIso` 是測試的注入點；省略用 `webAppTodayIso_()`；
 *     `timeBudgetSec` 蓋過 Config 的時間預算（測試用）。
 * Returns:
 *   {{quarters:{quarterId:string, status:string, dates:number, changed:number, message:string}[]}}
 *     `status`：`UNCHANGED`（內容表沒有改過，或已經放棄再試）／`NO_DATES`（這一季沒有今日之後的主日）／
 *     `NO_CHANGE`／`IMPORTED`／`PARTIAL`（時間預算用完，寫了一部分主日，下一次觸發繼續）／`DEFERRED`（同一次觸發
 *     前面的季度已經用完預算，這一季下一次觸發才做）／`FAILED`／`LOCK_TIMEOUT`。
 * Raises:
 *   （無：每一季各自包 try/catch）
 */
function runContentAutoSync_(options) {
  var opts = options || {};
  var todayIso = opts.todayIso || webAppTodayIso_().todayIso;
  var sandbox = String(getConfig_(CONFIG_KEYS.SELFTEST_QUARTER_ID, '') || '').trim();
  var weekRows = readSheet_(SHEETS.BULLETIN_WEEKS);
  var out = { quarters: [] };
  // R-060：同一次觸發所有季度共用一個時間預算。
  var runStartMs = Date.now();
  var budgetSpent = false;

  var contentRows = readSheet_(SHEETS.CONTENT_SHEETS);
  var activeFileIdByQuarter = {};
  contentRows.forEach(function (row) {
    if (row.ACTIVE !== true) return;
    var q = String(row.QUARTER_ID || '').trim();
    if (q) activeFileIdByQuarter[q] = row.FILE_ID;
  });

  contentRows.forEach(function (row) {
    if (row.ACTIVE !== true) return;
    var qid = String(row.QUARTER_ID || '').trim();
    if (!qid || qid === sandbox) return;
    var entry = { quarterId: qid, status: '', dates: 0, changed: 0, message: '' };
    out.quarters.push(entry);

    var propertyKey = CONTENT_AUTO_SYNC_PROPERTY_PREFIX_ + qid;
    var structKey = CONTENT_AUTO_SYNC_STRUCT_PREFIX_ + qid;

    // R-056：先看有沒有今日及之後的主日，沒有就連修改時間都不讀（不呼叫 Drive）。
    var dates = planContentAutoSyncDates_(weekRows, qid, todayIso);
    entry.dates = dates.length;
    if (dates.length === 0) {
      entry.status = 'NO_DATES';
      return;
    }

    // 2026-10-30：上一季的內容表亦要看（「連續到」本季的家事報告、代禱事項，src/ContentCarryOver.gs）——
    //    只看本季的修改時間的話，上一季那一行改了，本季的週報不會自動更新。
    var ownMtime = readContentSheetLastUpdatedMillis_(row.FILE_ID);
    var prevFileId = activeFileIdByQuarter[previousQuarterId_(qid)];
    var prevMtime = prevFileId ? readContentSheetLastUpdatedMillis_(prevFileId) : '';
    var mtime = contentSyncFingerprint_(ownMtime, prevMtime);
    var lastSynced = readTimedScriptProperty_(propertyKey, CONTENT_AUTO_SYNC_PROPERTY_MAX_AGE_SEC_);
    var gaveUp = readTimedScriptProperty_(structKey, CONTENT_AUTO_SYNC_STRUCT_MAX_AGE_SEC_);
    if (mtime !== null && (lastSynced === mtime || gaveUp === mtime)) {
      entry.status = 'UNCHANGED';
      deleteTimedScriptProperty_(contentSyncFailKey_(qid));
      return;
    }

    // R-060：前面的季度已經用完這一次的時間預算：不開檔、不記修改時間，下一次觸發再做。
    if (budgetSpent) {
      entry.status = 'DEFERRED';
      entry.message = '這一次觸發的匯入時間預算用完了，下一次觸發才處理這一季。';
      return;
    }

    try {
      var preview = previewContentImport_(qid, { isoDates: dates });
      if (!preview.ok) {
        // 結構性原因（例如內容表版面過舊）：再試也沒有用，記下來，內容表有改動才再試（有效期 30 日）。
        entry.status = 'FAILED';
        entry.message = preview.message || preview.reason || '';
        appendErrorLog_({
          source: ERROR_LOG_SOURCE.TRIGGER, functionName: 'runContentAutoSync_',
          errorCode: preview.reason || 'PREVIEW_FAILED',
          message: '內容表自動同步（季度 ' + qid + '）沒有匯入：' + entry.message
            + '　內容表再有改動之前不會再試。'
        });
        if (mtime !== null) writeTimedScriptProperty_(structKey, String(mtime));
        return;
      }
      // 2026-11-02：持續狀況（未補上合堂三行、上一季內容表讀不到等）：沒有改動亦要留痕跡（ErrorLog，每日一次）。
      entry.notices = (preview.notices || []).map(function (n) { return n.message; });
      recordContentImportNotices_(qid, preview.notices, 'runContentAutoSync_', todayIso);
      var plan = preview.plan || {};
      var changeCount = Number(plan.added || 0) + Number(plan.updated || 0) + Number(plan.removed || 0)
        + ((plan.releases || []).length);
      // 2026-11-03：只補寫家事報告、代禱事項的來源欄亦要寫一次（src/ContentImport.gs diffContentListForDate_()）。
      if (changeCount === 0 && Number(plan.backfilled || 0) === 0) {
        entry.status = 'NO_CHANGE';
        if (mtime !== null) writeTimedScriptProperty_(propertyKey, String(mtime));
        deleteTimedScriptProperty_(contentSyncFailKey_(qid));
        return;
      }
      var applied = applyContentImport_(qid, {
        isoDates: dates, budgetStartMs: runStartMs, timeBudgetSec: opts.timeBudgetSec
      });
      if (!applied.ok) {
        entry.status = 'FAILED';
        entry.message = applied.message || applied.reason || '';
        recordContentSyncFailure_(qid, mtime, '寫入失敗：' + entry.message, applied.reason || 'APPLY_FAILED', '');
        return;
      }
      var partial = Boolean(applied.progress && applied.progress.partial === true);
      entry.status = partial ? 'PARTIAL' : 'IMPORTED';
      entry.changed = changeCount;
      appendAuditLog_({
        action: 'CONTENT_AUTO_SYNC', sheetName: SHEETS.CONTENT_SHEETS, rowKey: qid,
        newValue: '+' + applied.plan.added + ' ~' + applied.plan.updated + ' -' + applied.plan.removed,
        notes: '內容表自動同步（' + String(opts.source || '') + '）：季度 ' + qid + '，今日 ' + todayIso
          + ' 及之後的 ' + dates.length + ' 個主日。'
          + (partial
            ? '時間預算用完，這一次只做了 ' + applied.progress.datesDone + '／' + applied.progress.datesTotal
              + ' 個有改動的主日（每個都是完整寫好的），下一次觸發繼續；數字是整份計畫的。'
            : '')
      });
      if (partial) {
        // 沒有做完：不記修改時間，下一次觸發才會再比較、由下一個主日繼續。
        budgetSpent = true;
        entry.message = contentImportProgressMessage_(applied.progress);
        deleteTimedScriptProperty_(contentSyncFailKey_(qid));
        return;
      }
      if (mtime !== null) writeTimedScriptProperty_(propertyKey, String(mtime));
      deleteTimedScriptProperty_(contentSyncFailKey_(qid));
    } catch (err) {
      if (err && err.code === 'LOCK_TIMEOUT') {
        // 有人正在儲存或匯入：不記修改時間，下一次再試。
        entry.status = 'LOCK_TIMEOUT';
        entry.message = err.message || '';
        return;
      }
      entry.status = 'FAILED';
      entry.message = (err && err.message) ? err.message : String(err);
      // R-056：暫時性失敗不記修改時間；同一個指紋連續失敗 3 次才放棄（見 recordContentSyncFailure_()）。
      recordContentSyncFailure_(qid, mtime, entry.message, (err && err.code) || 'ERROR',
        buildErrorDetail_(err, { argsSummary: 'quarterId=' + qid }));
    }
  });

  return out;
}
