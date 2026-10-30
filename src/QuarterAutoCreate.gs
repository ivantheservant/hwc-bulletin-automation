/**
 * QuarterAutoCreate.gs
 *
 * v3（2026-10-26 Ivan 測試結果 A，第 1 項）：職事表某一季已經生成版本（未正式發出亦算），而且該季
 * 未完結，系統就自動建立該季的週報（每個主日一行）與內容表——幹事不用再到試算表選單「測試讀取職事表」
 * 「建立本季空白週報」「建立本季內容表」。
 *
 * 甚麼時候檢查：
 *   - 每日一次（觸發器 `dailyQuarterAutoCreateTrigger_`，與自動寄送觸發器一齊在選單安裝／移除）；
 *   - 開啟填寫介面時（`apiListWeeks()` 第一次載入，十分鐘內只檢查一次，而且每次最多建立一季，
 *     免得開頁要等太久；其餘的十分鐘之後再開頁，或者由每日觸發器處理）。
 *
 * ⚠️ 只建立「缺少的」：週報已經有那一季（任何一行）就不再建週報；內容表已經登記就不再建內容表。
 *    既有的一格都不改（建週報只加未有的主日，內容表已經有就不碰——更新舊版內容表要人手確認，
 *    見 src/ContentSheetMigrateV3.gs）。
 * ⚠️ 職事表一律唯讀（只經 src/RosterRead.gs 讀）。
 * ⚠️ Config `AUTO_CREATE_QUARTERS` 設 FALSE 就整個停用。沙盒季度（`SELFTEST_QUARTER_ID`）永遠不建。
 */

'use strict';

/** 開啟填寫介面時「十分鐘內只檢查一次」的記錄鍵（指令碼屬性，見 src/TimedProperty.gs）。 */
var AUTO_CREATE_QUARTERS_CHECKED_KEY_ = 'AUTO_CREATE_QUARTERS_CHECKED_V3';

/** 建週報時等指令碼鎖的上限（毫秒）。與儲存、匯入同一把鎖。 */
var AUTO_CREATE_LOCK_WAIT_MS_ = 30000;

/**
 * 用途：某一季的內容表自動建立失敗過的記錄鍵（開啟填寫介面時一日內不再試）。
 * Args:
 *   quarterId {string}
 * Returns:
 *   {string}
 */
function autoCreateSheetFailedKey_(quarterId) {
  return 'AUTO_CREATE_SHEET_FAILED_' + String(quarterId || '');
}

/**
 * 用途：算出要自動建立甚麼。純函式。
 * Args:
 *   input {{rosterQuarters:Object[], weekQuarterIds:Object<string,boolean>,
 *     contentSheetQuarterIds:Object<string,boolean>, todayIso:string, excludedQuarterIds:string[], leadDays:number=}}
 *     `leadDays`：只建立第一個主日在今日起這麼多日之內的季度；0 或省略＝不限。
 *     `rosterQuarters` 見 `listRosterQuarterSummaries_()`；`weekQuarterIds`＝週報已經有（任何一行）的季度；
 *     `contentSheetQuarterIds`＝已經登記內容表（有效）的季度。
 * Returns:
 *   {{quarterId:string, createWeeks:boolean, createContentSheet:boolean, firstIso:string, lastIso:string}[]}
 *     由早到遲。兩樣都已經有的季度不列出。
 * Raises:
 *   （無）
 */
function planAutoCreateQuarters_(input) {
  var o = input || {};
  var today = String(o.todayIso || '').trim();
  var excluded = (o.excludedQuarterIds || []).map(function (q) { return String(q || '').trim(); });
  var weeks = o.weekQuarterIds || {};
  var sheets = o.contentSheetQuarterIds || {};
  var out = [];
  (o.rosterQuarters || []).forEach(function (q) {
    var qid = String(q.quarterId || '').trim();
    if (!qid || excluded.indexOf(qid) !== -1) return;
    if (!(Number(q.versionCount) > 0)) return;            // 職事表未生成任何版本
    if (!today || String(q.lastIso || '') < today) return; // 該季已經完結
    var lead = Number(o.leadDays) || 0;
    if (lead > 0 && String(q.firstIso || '') > addDaysToIsoDate_(today, lead)) return; // 太遠（例如職事表內的測試季度）
    var createWeeks = weeks[qid] !== true;
    var createContentSheet = sheets[qid] !== true;
    if (!createWeeks && !createContentSheet) return;
    out.push({
      quarterId: qid, createWeeks: createWeeks, createContentSheet: createContentSheet,
      firstIso: String(q.firstIso || ''), lastIso: String(q.lastIso || '')
    });
  });
  return out.sort(function (a, b) { return a.firstIso < b.firstIso ? -1 : (a.firstIso > b.firstIso ? 1 : 0); });
}

/**
 * 用途：自動建立季度的真正入口（每日觸發器與開啟填寫介面共用）。
 * Args:
 *   options {{maxQuarters:number=, source:string=}=}
 *     `maxQuarters`：這一次最多處理幾季（開啟填寫介面時傳 1）；省略＝全部。
 *     `source`：`'TRIGGER'`／`'WEBAPP'`，只用於 AuditLog 與 ErrorLog。
 * Returns:
 *   {{enabled:boolean, created:{quarterId:string, weeksAdded:number, contentSheetCreated:boolean,
 *     contentSheetUrl:string}[], skipped:{quarterId:string, reason:string}[], pending:number, message:string}}
 *     `pending`：因為 `maxQuarters` 而留待下一次的季數。
 * Raises:
 *   （無）任何一季失敗都寫 ErrorLog、記入 `skipped`，其餘照做。
 */
function runAutoCreateQuarters_(options) {
  var opts = options || {};
  var source = String(opts.source || 'TRIGGER');
  var result = { enabled: true, created: [], skipped: [], pending: 0, message: '' };
  var planned = buildAutoCreateQuartersPlanNow_();
  if (!planned.enabled) {
    result.enabled = false;
    result.message = planned.disabledReason;
    return result;
  }
  // 開啟填寫介面時：內容表最近一日內自動建立失敗過的季度先不再試內容表（每日觸發器照試），免得每十分鐘
  //    重試一次、ErrorLog 洗版，亦不會擋住排在後面的季度。只欠內容表的季度整季略過，不佔「每次一季」。
  var webapp = source === 'WEBAPP';
  var plan = planned.plan.map(function (item) {
    var skipSheet = webapp && item.createContentSheet && Boolean(readTimedScriptProperty_(autoCreateSheetFailedKey_(item.quarterId), 86400));
    return Object.assign({}, item, { createContentSheet: item.createContentSheet && !skipSheet });
  }).filter(function (item) { return item.createWeeks || item.createContentSheet; });
  var max = Number(opts.maxQuarters) > 0 ? Number(opts.maxQuarters) : plan.length;
  result.pending = Math.max(0, plan.length - max);

  plan.slice(0, max).forEach(function (item) {
    var entry = { quarterId: item.quarterId, weeksAdded: 0, contentSheetCreated: false, contentSheetUrl: '' };
    try {
      if (item.createWeeks) {
        // ⚠️ 經指令碼鎖（獨立審查）：每日觸發器與開頁、或者兩個分頁同時建同一季，第二個要等第一個寫完才讀，
        //    createBlankBulletinWeeks_() 只加未有的主日，所以不會重複加行。
        var weeks = withScriptLock_('runAutoCreateQuarters_', AUTO_CREATE_LOCK_WAIT_MS_, function () {
          return createBlankBulletinWeeks_(item.quarterId);
        });
        entry.weeksAdded = weeks.added;
        appendAuditLog_({
          action: 'AUTO_CREATE_WEEKS', sheetName: SHEETS.BULLETIN_WEEKS, rowKey: item.quarterId,
          newValue: String(weeks.added),
          notes: '職事表已經有季度 ' + item.quarterId + ' 的版本，系統自動建立該季週報（新增 ' + weeks.added
            + ' 行）。來源：' + (source === 'WEBAPP' ? '開啟填寫介面' : '每日觸發器') + '。'
        });
      }
      if (item.createContentSheet) {
        var built = buildOrRefreshContentSheet_(item.quarterId);
        if (built.ok) {
          entry.contentSheetCreated = built.created === true;
          entry.contentSheetUrl = String(built.fileUrl || '');
        } else {
          writeTimedScriptProperty_(autoCreateSheetFailedKey_(item.quarterId), '1');
          result.skipped.push({ quarterId: item.quarterId, reason: built.message || built.reason || '' });
          appendErrorLog_({
            source: ERROR_LOG_SOURCE.TRIGGER, functionName: 'runAutoCreateQuarters_',
            errorCode: 'AUTO_CREATE_CONTENT_SHEET_FAILED',
            message: '季度 ' + item.quarterId + ' 的內容表沒有自動建立：' + (built.message || built.reason || '')
          });
        }
      }
      if (entry.weeksAdded > 0 || entry.contentSheetCreated) result.created.push(entry);
    } catch (err) {
      result.skipped.push({ quarterId: item.quarterId, reason: (err && err.message) ? err.message : String(err) });
      appendErrorLog_({
        source: ERROR_LOG_SOURCE.TRIGGER, functionName: 'runAutoCreateQuarters_',
        errorCode: (err && err.code) || 'AUTO_CREATE_FAILED',
        message: '自動建立季度 ' + item.quarterId + ' 失敗：' + ((err && err.message) ? err.message : String(err)),
        detail: buildErrorDetail_(err, { argsSummary: 'quarterId=' + item.quarterId + ' source=' + source })
      });
    }
  });

  result.message = buildAutoCreateQuartersMessage_(result);
  return result;
}

/**
 * 用途：讀出現況，算出「現在自動建立的話會建立甚麼」。真正建立（`runAutoCreateQuarters_()`）與「上線前檢查」
 *   共用這一支，兩邊講的一樣（bug class 3）。唯讀：只讀週報試算表與職事表。
 * Args: （無）
 * Returns:
 *   {{enabled:boolean, disabledReason:string, plan:Object[]}} `plan` 見 `planAutoCreateQuarters_()`。
 * Raises:
 *   Error 職事表讀不到（由呼叫方決定怎樣講）。
 */
function buildAutoCreateQuartersPlanNow_() {
  if (normalizeBoolean_(getConfig_(CONFIG_KEYS.AUTO_CREATE_QUARTERS, 'TRUE')) !== true) {
    return { enabled: false, disabledReason: 'Config 的 ' + CONFIG_KEYS.AUTO_CREATE_QUARTERS + ' 是 FALSE，沒有自動建立。', plan: [] };
  }
  if (!getConfig_(CONFIG_KEYS.ROSTER_SPREADSHEET_ID, '')) {
    return { enabled: false, disabledReason: '職事表未設定，沒有自動建立。', plan: [] };
  }
  // v3 重測（2026-10-27）：「今日」與填寫介面同一個（webAppTodayIso_()）：測試時 Config WEBAPP_SIMULATED_TODAY
  //    填了就按那一日計，可以在測試季度（例如 2028T3）試自動建立，而不會建立真正的季度；未填就是真正的今日。
  //    自動寄送（星期一）不受影響。
  var today = webAppTodayIso_();
  var weekQuarterIds = {};
  readSheet_(SHEETS.BULLETIN_WEEKS).forEach(function (r) {
    var qid = String(r.QUARTER_ID || '').trim();
    if (qid) weekQuarterIds[qid] = true;
  });
  // ⚠️ 與 findContentSheetRow_() 同一個準則（ACTIVE === true），兩處講的「已經有內容表」一樣（獨立審查）。
  var contentSheetQuarterIds = {};
  readSheet_(SHEETS.CONTENT_SHEETS).forEach(function (r) {
    var qid = String(r.QUARTER_ID || '').trim();
    if (qid && r.ACTIVE === true) contentSheetQuarterIds[qid] = true;
  });
  return {
    enabled: true, disabledReason: '',
    todayIso: today.todayIso, simulated: today.simulated === true,
    plan: planAutoCreateQuarters_({
      rosterQuarters: listRosterQuarterSummaries_(),
      weekQuarterIds: weekQuarterIds,
      contentSheetQuarterIds: contentSheetQuarterIds,
      todayIso: today.todayIso,
      excludedQuarterIds: [getConfig_(CONFIG_KEYS.SELFTEST_QUARTER_ID, '')],
      leadDays: autoCreateLeadDays_()
    })
  };
}

/**
 * 用途：讀 Config `AUTO_CREATE_QUARTERS_LEAD_DAYS`。不是非負整數就用 90（寧可保守，亦不可以變成不限）。
 * Args: （無）
 * Returns:
 *   {number} 0＝不限。
 */
function autoCreateLeadDays_() {
  var raw = String(getConfig_(CONFIG_KEYS.AUTO_CREATE_QUARTERS_LEAD_DAYS, '90') || '').trim();
  if (!/^\d+$/.test(raw)) return 90;
  return Number(raw);
}

/**
 * 用途：「上線前檢查」的一項：現在自動建立的話會建立哪幾季（唯讀，一格都不寫）。部署之後、開啟填寫介面
 *   之前先看這一項，就知道開頁時會建立甚麼。
 * Args:
 *   S {Object} `SELF_CHECK_STATUS_`。
 * Returns:
 *   {{label:string, status:string, message:string}}
 * Raises:
 *   （無）
 */
function buildAutoCreateQuartersGoLiveItem_(S) {
  var label = '上線前：自動建立季度';
  var planned;
  try {
    planned = buildAutoCreateQuartersPlanNow_();
  } catch (err) {
    return { label: label, status: S.YELLOW, message: '⚠️ 讀不到職事表，算不到會自動建立哪幾季：' + ((err && err.message) ? err.message : String(err)) };
  }
  if (!planned.enabled) {
    return { label: label, status: S.YELLOW, message: '⚠️ ' + planned.disabledReason + '新一季要人手用選單建立週報與內容表。' };
  }
  var leadDays = autoCreateLeadDays_();
  var scope = leadDays > 0 ? '（只看第一個主日在 ' + leadDays + ' 日之內的季度，Config ' + CONFIG_KEYS.AUTO_CREATE_QUARTERS_LEAD_DAYS + '）' : '';
  if (planned.simulated) {
    scope += '（按 Config ' + CONFIG_KEYS.WEBAPP_SIMULATED_TODAY + '「' + planned.todayIso + '」當今日計）';
  }
  if (planned.plan.length === 0) {
    return { label: label, status: S.GREEN, message: '職事表已有版本、而且未完結的季度' + scope + '，週報與內容表都已經建立，沒有東西要自動建立。' };
  }
  return {
    label: label, status: S.YELLOW,
    message: '開啟填寫介面（每十分鐘最多一季）或每日觸發器會自動建立' + scope + '：'
      + planned.plan.map(function (p) {
        var what = [];
        if (p.createWeeks) what.push('週報');
        if (p.createContentSheet) what.push('內容表');
        return p.quarterId + '（' + p.firstIso + ' 至 ' + p.lastIso + '，' + what.join('與') + '）';
      }).join('；') + '。不想建立的話，先把 Config 的 ' + CONFIG_KEYS.AUTO_CREATE_QUARTERS + ' 改成 FALSE。'
  };
}

/**
 * 用途：自動建立季度之後給幹事看的一句（開啟填寫介面時在頂部黃色橫幅顯示）。純函式。
 * Args:
 *   result {Object} `runAutoCreateQuarters_()` 的結果（`message` 以外）。
 * Returns:
 *   {string} 甚麼都沒有建立、亦沒有失敗時回空字串。
 * Raises:
 *   （無）
 */
function buildAutoCreateQuartersMessage_(result) {
  var r = result || {};
  var parts = (r.created || []).map(function (c) {
    var what = [];
    if (c.weeksAdded > 0) what.push('週報（' + c.weeksAdded + ' 個主日）');
    if (c.contentSheetCreated) what.push('內容表');
    return c.quarterId + ' 的' + what.join('與');
  });
  var text = parts.length > 0 ? '職事表已經有新的季度，系統已自動建立 ' + parts.join('；') + '。' : '';
  if ((r.skipped || []).length > 0) {
    text += (text ? '　' : '') + '⚠️ ' + r.skipped.map(function (s) { return s.quarterId; }).join('、')
      + ' 未能自動建立，詳情見試算表的 ErrorLog。';
  }
  if (Number(r.pending) > 0) {
    text += (text ? '　' : '') + '另有 ' + r.pending + ' 季會在稍後自動建立（每日一次）。';
  }
  return text;
}

/**
 * 用途：開啟填寫介面時的自動建立：十分鐘內只檢查一次（讀職事表要一兩秒），每次最多一季。
 *   任何失敗都不可以令載入失敗——只回一句說明。
 * Args: （無）
 * Returns:
 *   {string} 要在頂部顯示的一句；沒有就是空字串。
 * Raises:
 *   （無）
 */
function autoCreateQuartersForWebApp_() {
  try {
    if (readTimedScriptProperty_(AUTO_CREATE_QUARTERS_CHECKED_KEY_, 600)) return '';
    // ⚠️ 先記下才做（獨立審查）：兩個分頁差不多同時打開，只有先到的一個會做；做的途中出錯亦不會令之後
    //    每一次開頁都重讀職事表、重試、再寫一行 ErrorLog。其餘的季度十分鐘之後再開頁，或者由每日觸發器處理。
    writeTimedScriptProperty_(AUTO_CREATE_QUARTERS_CHECKED_KEY_, '1');
    var result = runAutoCreateQuarters_({ maxQuarters: 1, source: 'WEBAPP' });
    // v3 重測（2026-10-27）：停用（Config FALSE、職事表未設定）時不出橫幅——以前每次開頁都出一條黃色
    //    「沒有自動建立」，對幹事沒有用處；停用與否由「上線前檢查」講明。
    if (result.enabled === false) return '';
    return result.message || '';
  } catch (err) {
    appendErrorLog_({
      source: ERROR_LOG_SOURCE.SERVER, functionName: 'autoCreateQuartersForWebApp_',
      errorCode: (err && err.code) || 'AUTO_CREATE_FAILED',
      message: (err && err.message) ? err.message : String(err), detail: buildErrorDetail_(err)
    });
    return '';
  }
}

/**
 * 用途：每日觸發器的入口（時間觸發器固定簽章，沒有參數）：自動建立新季度，之後排好內容表的清單分頁。
 *   全部失敗都寫 ErrorLog。
 * Args: （無）
 * Returns:
 *   {void}
 */
function dailyQuarterAutoCreateTrigger_() {
  try {
    runAutoCreateQuarters_({ source: 'TRIGGER' });
  } catch (err) {
    appendErrorLog_({
      source: ERROR_LOG_SOURCE.TRIGGER, functionName: 'dailyQuarterAutoCreateTrigger_',
      errorCode: (err && err.code) || 'ERROR',
      message: (err && err.message) ? err.message : String(err), detail: buildErrorDetail_(err)
    });
  }
  // 2026-10-30（內容表 v4）：同一個每日觸發器順便把「家事報告」「代禱事項」「財政報告」按日期排好
  //    （src/ContentSheetV4.gs）。自己包 try/catch：建立季度失敗不影響排序，排序失敗亦不影響建立季度。
  try {
    runNightlyContentSort_({ source: 'TRIGGER' });
  } catch (err) {
    appendErrorLog_({
      source: ERROR_LOG_SOURCE.TRIGGER, functionName: 'runNightlyContentSort_',
      errorCode: (err && err.code) || 'ERROR',
      message: (err && err.message) ? err.message : String(err), detail: buildErrorDetail_(err)
    });
  }
}
