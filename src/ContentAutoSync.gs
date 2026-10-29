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
 *   - 失敗（例如內容表要先更新版面）每個修改時間只記一次 ErrorLog，不會每 30 分鐘洗一次；拿不到鎖就
 *     下一次再試。
 *
 * 觸發器由「安裝自動寄送觸發器」一併安裝（src/Trigger.gs）。
 */

'use strict';

/** 指令碼屬性鍵的前綴：記下每一季內容表上一次同步時的最後修改時間。 */
var CONTENT_AUTO_SYNC_PROPERTY_PREFIX_ = 'CONTENT_SYNC_MTIME_';

/** 修改時間記錄的有效期（秒）。過期就當作未同步過，照樣同步一次。 */
var CONTENT_AUTO_SYNC_PROPERTY_MAX_AGE_SEC_ = 7 * 24 * 3600;

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
 * 用途：跑一次內容表自動同步（見檔頭）。IO 層。
 * Args:
 *   options {{source:string=, todayIso:string=}=} `todayIso` 是測試的注入點；省略用 `webAppTodayIso_()`。
 * Returns:
 *   {{quarters:{quarterId:string, status:string, dates:number, changed:number, message:string}[]}}
 *     `status`：`UNCHANGED`（內容表沒有改過）／`NO_DATES`（這一季沒有今日之後的主日）／`NO_CHANGE`／
 *     `IMPORTED`／`FAILED`／`LOCK_TIMEOUT`。
 * Raises:
 *   （無：每一季各自包 try/catch）
 */
function runContentAutoSync_(options) {
  var opts = options || {};
  var todayIso = opts.todayIso || webAppTodayIso_().todayIso;
  var sandbox = String(getConfig(CONFIG_KEYS.SELFTEST_QUARTER_ID, '') || '').trim();
  var weekRows = readSheet(SHEETS.BULLETIN_WEEKS);
  var out = { quarters: [] };

  readSheet(SHEETS.CONTENT_SHEETS).forEach(function (row) {
    if (row.ACTIVE !== true) return;
    var qid = String(row.QUARTER_ID || '').trim();
    if (!qid || qid === sandbox) return;
    var entry = { quarterId: qid, status: '', dates: 0, changed: 0, message: '' };
    out.quarters.push(entry);

    var propertyKey = CONTENT_AUTO_SYNC_PROPERTY_PREFIX_ + qid;
    var mtime = readContentSheetLastUpdatedMillis_(row.FILE_ID);
    var lastSynced = readTimedScriptProperty_(propertyKey, CONTENT_AUTO_SYNC_PROPERTY_MAX_AGE_SEC_);
    if (mtime !== null && lastSynced === String(mtime)) { entry.status = 'UNCHANGED'; return; }

    var dates = planContentAutoSyncDates_(weekRows, qid, todayIso);
    entry.dates = dates.length;
    if (dates.length === 0) {
      entry.status = 'NO_DATES';
      if (mtime !== null) writeTimedScriptProperty_(propertyKey, String(mtime));
      return;
    }

    try {
      var preview = previewContentImport_(qid, { isoDates: dates });
      if (!preview.ok) {
        entry.status = 'FAILED';
        entry.message = preview.message || preview.reason || '';
        appendErrorLog_({
          source: ERROR_LOG_SOURCE.TRIGGER, functionName: 'runContentAutoSync_',
          errorCode: preview.reason || 'PREVIEW_FAILED',
          message: '內容表自動同步（季度 ' + qid + '）沒有匯入：' + entry.message
            + '　內容表再有改動之前不會再試。'
        });
        if (mtime !== null) writeTimedScriptProperty_(propertyKey, String(mtime));
        return;
      }
      var plan = preview.plan || {};
      var changeCount = Number(plan.added || 0) + Number(plan.updated || 0) + Number(plan.removed || 0)
        + ((plan.releases || []).length);
      if (changeCount === 0) {
        entry.status = 'NO_CHANGE';
        if (mtime !== null) writeTimedScriptProperty_(propertyKey, String(mtime));
        return;
      }
      var applied = applyContentImport_(qid, { isoDates: dates });
      if (!applied.ok) {
        entry.status = 'FAILED';
        entry.message = applied.message || applied.reason || '';
        appendErrorLog_({
          source: ERROR_LOG_SOURCE.TRIGGER, functionName: 'runContentAutoSync_',
          errorCode: applied.reason || 'APPLY_FAILED',
          message: '內容表自動同步（季度 ' + qid + '）寫入失敗：' + entry.message
        });
        return;
      }
      entry.status = 'IMPORTED';
      entry.changed = changeCount;
      appendAuditLog_({
        action: 'CONTENT_AUTO_SYNC', sheetName: SHEETS.CONTENT_SHEETS, rowKey: qid,
        newValue: '+' + applied.plan.added + ' ~' + applied.plan.updated + ' -' + applied.plan.removed,
        notes: '內容表自動同步（' + String(opts.source || '') + '）：季度 ' + qid + '，今日 ' + todayIso
          + ' 及之後的 ' + dates.length + ' 個主日。'
      });
      if (mtime !== null) writeTimedScriptProperty_(propertyKey, String(mtime));
    } catch (err) {
      if (err && err.code === 'LOCK_TIMEOUT') {
        // 有人正在儲存或匯入：不記修改時間，下一次再試。
        entry.status = 'LOCK_TIMEOUT';
        entry.message = err.message || '';
        return;
      }
      entry.status = 'FAILED';
      entry.message = (err && err.message) ? err.message : String(err);
      appendErrorLog_({
        source: ERROR_LOG_SOURCE.TRIGGER, functionName: 'runContentAutoSync_',
        errorCode: (err && err.code) || 'ERROR',
        message: '內容表自動同步（季度 ' + qid + '）失敗：' + entry.message,
        detail: buildErrorDetail_(err, { argsSummary: 'quarterId=' + qid })
      });
      if (mtime !== null) writeTimedScriptProperty_(propertyKey, String(mtime));
    }
  });

  return out;
}
