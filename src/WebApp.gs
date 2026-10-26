/**
 * WebApp.gs
 *
 * 週報填寫介面（單頁 Web App）：`doGet` 入口、權限檢查，以及給前端
 * `google.script.run` 呼叫的五個 API 函式（`apiListWeeks`／`apiLoadWeek`／
 * `apiPreviewProgram`／`apiSaveWeek`／`apiLogClientError`）。實際的儲存
 * 邏輯（upsert、樂觀鎖、AuditLog）在 `src/WebAppSave.gs`，工作表結構
 * 檢查在 `src/SchemaCheck.gs`，例外記錄在 `src/ErrorLog.gs`；本檔案負責
 * 「誰可以用」「前端要什麼資料」，把這幾個模組串起來。
 *
 * 本檔案完全不碰 Google Docs、PDF、`MailApp`、`ScriptApp.newTrigger`，
 * 也不會寫入職事表（唯一會寫的是週報自己的試算表，經 WebAppSave.gs）。
 *
 * 權限次序（`doGet` 與每一個 API 函式都要遵守）：
 *   1. `WEBAPP_ENABLED` 不是 TRUE → 一頁說明，不渲染介面。
 *   2. 呼叫者不在 `WEBAPP_ALLOWED_EMAILS`（留空時只允許部署者本人）
 *      → 一頁說明。
 *   3. 通過才渲染 `ui/Index`（`doGet` 這一步同時會跑一次
 *      `checkSheetSchema_()`，結構落後於程式碼時交給樣板顯示黃色橫幅）。
 *
 * ⚠️ **只在 `doGet` 檢查是不夠的**——`google.script.run` 可以繞過頁面直接
 * 呼叫任何一個全域函式，所以每一個 API 函式開頭都要再呼叫一次
 * `assertCallerAuthorized_()`（透過 `withApiResult_()` 統一處理）；
 * `withApiResult_()` 同時也是把例外寫進 `ErrorLog` 的唯一地方——
 * Apps Script 的執行紀錄只看得到「這次呼叫完成」，看不出裡面其實失敗了，
 * 見 docs/已知bug類型.md 事故七。
 */

'use strict';

// =====================================================================
// doGet 入口
// =====================================================================

/**
 * 用途：Web App 的 `doGet` 入口（Apps Script 固定簽章）。依序檢查總開關與
 *   呼叫者權限，通過才渲染 `ui/Index` 樣板；渲染前先跑一次
 *   `checkSheetSchema_()`，結構落後於程式碼時把摘要交給樣板顯示成黃色
 *   橫幅（見 `ui/Index.html`），提醒要先撳「初始化工作表」。
 * Args:
 *   e {Object} Apps Script 傳入的請求事件物件，本函式不使用其內容。
 * Returns:
 *   {HtmlOutput}
 */
function doGet(e) {
  // ⚠️ 預覽頁要**排在總開關與填寫介面權限之前**判斷（R-033）：
  //    它是另一個功能、另一套授權（完全唯讀，預設網域內任何人都開得到）。
  //    排在後面的話，`WEBAPP_ENABLED=FALSE` 或者不在名單內的人就連唯讀的
  //    預覽都看不到——而那正是它要服務的那一批人。
  if (webAppRequestedPage_(e) === 'preview') {
    return renderPreviewResponse_(e);
  }

  if (!isWebAppEnabled_()) {
    return HtmlService.createHtmlOutput(renderWebAppMessagePage_(
      '填寫介面目前已關閉',
      ['管理者已經在 Config 把 WEBAPP_ENABLED 設為 FALSE。', '要重新啟用，請在 Config 把 WEBAPP_ENABLED 改回 TRUE。']
    ));
  }
  if (!isCallerAuthorized_()) {
    return HtmlService.createHtmlOutput(renderWebAppMessagePage_(
      '沒有使用權限', buildNoAccessLines_()));
  }

  var schema = checkSheetSchema_();
  var template = HtmlService.createTemplateFromFile('ui/Index');
  template.schemaWarning = buildSchemaShortSummary_(schema);
  // ⚠️ 前端沒有辦法自己讀 Config，所以由這裏放進 `#app` 的 data 屬性。
  // 不可以用 include('ui/Script') 那一邊的樣板變數——`include()` 造的是
  // 一個**全新的**樣板，這裏設的值傳不過去。
  template.callTimeoutSec = webAppCallTimeoutSec_();

  return template.evaluate()
    .setTitle(APP_NAME + '－填寫介面')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/**
 * 用途：讀出請求想要哪一版（`?page=`）。
 * Args:
 *   e {Object} `doGet` 的事件物件。
 * Returns:
 *   {string} 一律小寫；沒有帶就回空字串。
 */
function webAppRequestedPage_(e) {
  var params = (e && e.parameter) ? e.parameter : {};
  return String(params.page || '').trim().toLowerCase();
}

/**
 * 用途：`?page=preview` 的回應。
 *
 *   ⚠️ 這一條路徑**完全唯讀**：只讀資料、只砌 HTML，不會寫任何一格。
 *   所以它不受 `WEBAPP_ENABLED` 影響（那個開關是關填寫介面的），
 *   授權亦另有一條（`PREVIEW_REQUIRE_ALLOWLIST`，預設 FALSE）。
 * Args:
 *   e {Object} `doGet` 的事件物件。
 * Returns:
 *   {HtmlOutput}
 */
function renderPreviewResponse_(e) {
  if (!isPreviewCallerAuthorized_()) {
    return HtmlService.createHtmlOutput(renderWebAppMessagePage_(
      '沒有權限查看草稿預覽', buildNoAccessLines_().concat([
        '（草稿預覽目前設定為只限名單內的人查看：Config 的 '
          + CONFIG_KEYS.PREVIEW_REQUIRE_ALLOWLIST + ' 是 TRUE。）'
      ])));
  }

  var params = (e && e.parameter) ? e.parameter : {};
  var page = buildPreviewPage_(params.date, { snapshotId: params.snapshot });
  return HtmlService.createHtmlOutput(page.html)
    .setTitle(APP_NAME + '－草稿預覽')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}
/**
 * 用途：讀出 Config `WEBAPP_CALL_TIMEOUT_SEC`（填寫介面等候伺服器回應的
 *   上限，秒）。設定不合法或者非正數一律回 120。
 *
 *   ⚠️ 這個值一定要有一個**有限**的上限：`google.script.run` 本身沒有
 *   逾時機制，伺服器那一邊卡住的話，成功與失敗兩個處理函式都不會被呼叫，
 *   介面就永遠停在忙碌狀態（見 docs/已知bug類型.md 事故二十五）。
 * Args: （無）
 * Returns:
 *   {number} 秒。
 */
function webAppCallTimeoutSec_() {
  var seconds = normalizeInt_(getConfig(CONFIG_KEYS.WEBAPP_CALL_TIMEOUT_SEC, '120'));
  return (seconds === null || seconds <= 0) ? 120 : seconds;
}

/**
 * 用途：`ui/Index.html` 用來組合 `ui/Style.html`／`ui/Script.html` 的樣板
 *   輔助函式（Apps Script `HtmlService` 樣板的標準寫法）。
 * Args:
 *   filename {string} 相對於 `src/` 的 HTML 檔案路徑（例如 `'ui/Style'`）。
 * Returns:
 *   {string} 該檔案求值後的內容。
 */
function include(filename) {
  return HtmlService.createTemplateFromFile(filename).evaluate().getContent();
}

/**
 * 用途：組出「總開關關閉」或「沒有權限」這類說明頁面的 HTML。純字串組合，
 *   不經過樣板引擎，所以不受「.html 註解不可以出現樣板標籤符號」那條
 *   限制（那條限制針對的是 `HtmlService.createTemplateFromFile()` 讀取的
 *   `.html` 檔案，這裡回傳的是已經求值完的純字串）。
 * Args:
 *   title {string} 頁面標題。
 *   lines {string[]} 每一行說明文字，會逐行輸出成獨立的 `<p>`。
 * Returns:
 *   {string} 完整的 HTML 內容。
 */
function renderWebAppMessagePage_(title, lines) {
  var paragraphs = (lines || []).map(function (line) { return '<p>' + escapeHtml_(line) + '</p>'; }).join('');
  return '<div style="font-family:sans-serif;max-width:32em;margin:3em auto;line-height:1.8;color:#333;">'
    + '<h2>' + escapeHtml_(title) + '</h2>'
    + paragraphs
    + '</div>';
}

/**
 * 用途：把文字轉成安全嵌入 HTML 的形式（跳脫 `& < > "` 四個字元）。
 * Args:
 *   text {*} 任意值，會先轉成字串。
 * Returns:
 *   {string}
 */
function escapeHtml_(text) {
  return String(text === null || text === undefined ? '' : text)
    .split('&').join('&amp;')
    .split('<').join('&lt;')
    .split('>').join('&gt;')
    .split('"').join('&quot;');
}

// =====================================================================
// 權限
// =====================================================================

/**
 * 用途：「沒有使用權限」那一頁的內容行。
 *
 *   ⚠️ **一定要印出「你目前登入的是哪一個帳戶」。** 沒有這一行的話，
 *   看見「沒有使用權限」的人完全沒有辦法自助排解——最常見的原因根本
 *   不是權限，而是瀏覽器登入了另一個 Google 帳戶（個人 Gmail 而不是
 *   教會帳戶）。把登入的電郵印出來，多數情況一眼就看得出。
 * Args: （無）
 * Returns:
 *   {string[]}
 */
function buildNoAccessLines_() {
  var caller = getCallerEmail_();
  return [
    '您目前沒有權限使用本填寫介面。',
    '你目前登入的是：' + (caller || '（查不到——可能未登入，或者瀏覽器擋住了帳戶資訊）'),
    '如果那不是你的教會帳戶，請先在瀏覽器切換帳戶再開一次。',
    '如果帳戶正確，請聯絡管理者，在 Config 的 WEBAPP_ALLOWED_EMAILS 加入您的電郵（逗號分隔）。'
  ];
}
/**
 * 用途：讀 Config 的 `WEBAPP_ENABLED` 總開關。
 * Args: （無）
 * Returns:
 *   {boolean}
 */
function isWebAppEnabled_() {
  return normalizeBoolean_(getConfig(CONFIG_KEYS.WEBAPP_ENABLED, 'TRUE')) === true;
}

/**
 * 用途：取得目前呼叫者的電郵。包一層 try/catch——部分執行環境（例如網域
 *   外的存取）可能沒有權限回傳電郵，這時當成「查不到」而不是讓整個請求
 *   失敗（呼叫方會因為查不到電郵而判定沒有權限，效果等同拒絕）。
 * Args: （無）
 * Returns:
 *   {string} 查不到時回空字串。
 */
function getCallerEmail_() {
  try {
    return Session.getActiveUser().getEmail() || '';
  } catch (err) {
    return '';
  }
}

/**
 * 用途：取得腳本的「有效使用者」電郵——`executeAs: USER_DEPLOYING` 部署下，
 *   這是部署者本人的電郵，不論實際呼叫者是誰都一樣。`WEBAPP_ALLOWED_EMAILS`
 *   留空時，只有這個人可以使用填寫介面。
 * Args: （無）
 * Returns:
 *   {string} 查不到時回空字串。
 */
function getEffectiveEmail_() {
  try {
    return Session.getEffectiveUser().getEmail() || '';
  } catch (err) {
    return '';
  }
}

/**
 * 用途：判斷一個電郵是否有權限使用填寫介面。純函式，方便獨立測試。
 *
 *   ⚠️ **部署者一律放行，不論名單有沒有他。** 授權範圍是
 *   「`WEBAPP_ALLOWED_EMAILS` 的清單 **∪** 部署者本人」。
 *
 *   舊版是「名單非空就只看名單」，於是實際發生過這件事：名單只有兩個
 *   同工的電郵，**部署者本人不在裏面**，結果自己開不到自己部署的 Web App，
 *   畫面只有一句「沒有使用權限」。而唯一改得到那個名單的地方是試算表的
 *   `Config`——幸好那一邊還開得到，否則就是把自己鎖死在系統外面。
 *
 *   **一個權限系統不可以把唯一有能力修好它的人擋在門外。**
 * Args:
 *   callerEmail {string} 呼叫者的電郵。
 *   allowedEmailsList {string[]} `WEBAPP_ALLOWED_EMAILS` 解析後的清單。
 *   effectiveEmail {string} 部署者（`Session.getEffectiveUser()`）的電郵。
 * Returns:
 *   {boolean} 呼叫者在名單內、或者呼叫者就是部署者，兩者其一即通過。
 *     名單空白時只有部署者通過。`callerEmail` 空白一律回 false。
 */
function isEmailAuthorized_(callerEmail, allowedEmailsList, effectiveEmail) {
  var caller = String(callerEmail || '').trim().toLowerCase();
  if (!caller) return false;

  // ⚠️ 部署者永遠放行，而且要**排在名單判斷之前**——放在之後的話，
  //    名單非空那條路仍然會先 return，等於沒有加。
  var effective = String(effectiveEmail || '').trim().toLowerCase();
  if (effective && caller === effective) return true;

  var allowed = (allowedEmailsList || [])
    .map(function (e) { return String(e || '').trim().toLowerCase(); })
    .filter(function (e) { return e.length > 0; });

  return allowed.indexOf(caller) !== -1;
}

/**
 * 用途：`isEmailAuthorized_()` 的 IO 包裝——讀目前呼叫者、Config 名單、
 *   部署者電郵，判斷這一次呼叫是否有權限。
 * Args: （無）
 * Returns:
 *   {boolean}
 */
function isCallerAuthorized_() {
  var allowed = getConfigTextList_(CONFIG_KEYS.WEBAPP_ALLOWED_EMAILS, '');
  return isEmailAuthorized_(getCallerEmail_(), allowed, getEffectiveEmail_());
}

/**
 * 用途：每一個給前端呼叫的 API 函式開頭都要呼叫這個函式——只在 `doGet`
 *   檢查權限是不夠的，`google.script.run` 可以繞過頁面直接呼叫任何全域
 *   函式。
 * Args: （無）
 * Returns:
 *   {void}
 * Raises:
 *   Error（`code: 'FORBIDDEN'`）如果呼叫者沒有權限。
 */
function assertCallerAuthorized_() {
  if (isCallerAuthorized_()) return;
  var err = new Error('您沒有權限使用本填寫介面。請聯絡管理者，在 Config 的 WEBAPP_ALLOWED_EMAILS 加入您的電郵。');
  err.code = 'FORBIDDEN';
  throw err;
}

// =====================================================================
// API 函式——統一回傳 { ok, data?, error? }，不可以把例外直接拋到前端
// =====================================================================

/**
 * 用途：「預期中的使用者情況」的錯誤碼清單。這些不是系統出錯，而是系統
 *   正確地擋下了一次不安全的儲存（樂觀鎖不符、欄位被別處改過、前端版本
 *   過舊）。照樣回傳錯誤給介面，但**不寫 `ErrorLog`**——寫進去會令「上線前
 *   檢查」的「最近 7 日的錯誤」變黃，把真正的故障淹沒在正常的擋駕裡。
 *
 *   純字串常數，沒有跨檔案頂層引用，不受載入次序影響。
 */
var EXPECTED_USER_ERROR_CODES_ = Object.freeze(['STALE', 'FIELD_CONFLICT', 'CLIENT_OUTDATED']);

/**
 * 用途：把一個會拋錯的函式包成統一的 `{ ok, data?, error? }` 形狀，並在
 *   執行前檢查呼叫者權限。全部 `api*` 函式都經由這個函式呼叫底層邏輯。
 *
 *   ⚠️ **例外發生時，先寫一筆 `ErrorLog`（`SOURCE='SERVER'`）才回傳
 *   `{ok:false,...}`**（錯誤碼屬於 `EXPECTED_USER_ERROR_CODES_` 的除外，
 *   那些照樣回傳錯誤，但不算故障，不寫 `ErrorLog`）——Apps Script 的執行紀錄只看得到「這次呼叫完成」，
 *   看不出裡面其實是失敗的；不記下來就沒有人知道發生過什麼事（見
 *   docs/已知bug類型.md 事故七的第 2 部分）。寫 `ErrorLog` 本身若失敗，
 *   `appendErrorLog_()` 自己會吞掉例外，不會影響這裡照樣回傳
 *   `{ok:false,...}` 給呼叫端。
 * Args:
 *   fn {function(): *} 實際要執行的邏輯，可以拋錯。
 *   context {{functionName:(string|undefined), argsSummary:(string|undefined)}=}
 *     選填，寫入 `ErrorLog` 用：`functionName` 是出錯的 API 函式名稱，
 *     `argsSummary` 是呼叫方自己組的、**不含電郵或個人資料**的參數摘要
 *     （例如 `'isoDate=2027-10-03'`）。
 * Returns:
 *   {{ok:boolean, data:*, error:({code:string,message:string}|undefined)}}
 */
function withApiResult_(fn, context) {
  try {
    assertCallerAuthorized_();
    return { ok: true, data: fn() };
  } catch (err) {
    var errorCode = (err && err.code) || 'ERROR';
    var message = enrichAuthError_(err);
    if (EXPECTED_USER_ERROR_CODES_.indexOf(errorCode) === -1) {
      appendErrorLog_({
        source: ERROR_LOG_SOURCE.SERVER,
        functionName: (context && context.functionName) || '',
        errorCode: errorCode,
        message: message,
        detail: buildErrorDetail_(err, context)
      });
    }
    return {
      ok: false,
      error: { code: errorCode, message: message }
    };
  }
}

/**
 * 用途：前端呼叫，取得主日下拉清單。
 * Args: （無）
 * Returns:
 *   {{ok:boolean, data:{weeks:Object[], defaultIsoDate:(string|null)}, error?:Object}}
 */
function apiListWeeks(includeArchived, options) {
  var autoCreate = Boolean(options && options.autoCreate === true);
  return withApiResult_(function () {
    // v3：開啟填寫介面（第一次載入）時順手自動建立職事表已有版本的新季度（十分鐘內只檢查一次、每次最多一季）。
    //    失敗不可以令載入失敗（autoCreateQuartersForWebApp_() 不拋錯）。
    var notice = autoCreate ? autoCreateQuartersForWebApp_() : '';
    var data = listWeeksForWebApp_(includeArchived === true);
    data.autoCreateNotice = notice;
    return data;
  }, { functionName: 'apiListWeeks', argsSummary: 'includeArchived=' + (includeArchived === true) + ' autoCreate=' + autoCreate });
}

/**
 * 用途：前端呼叫，把某一季在職事表已經有、而週報仍然空白的事奉格補抓
 *   回來（R-036）。
 *
 *   ⚠️ 只填**空白格**，不覆寫人手已經填好的值；隨時可以重試，重複按不會
 *   改壞任何東西。職事表仍然是唯讀的，這裏一格都不會寫回職事表。
 * Args:
 *   quarterId {string} 季度 ID，`YYYYTn`。
 * Returns:
 *   {{ok:boolean, data:Object, error?:Object}} `data` 形狀見
 *     `backfillRosterForQuarter_()`：`{ok, quarterId, filled, stillBlank,
 *     rowsTouched, statusBefore, statusAfter, rosterFound, message}`。
 *     ⚠️ 職事表仍然找不到**不是**錯誤：`ok` 會是 `true`（呼叫成功），
 *     `data.rosterFound` 是 `false`，`data.message` 有明確說明。
 */
function apiBackfillRoster(quarterId) {
  return withApiResult_(function () { return backfillRosterForQuarter_(quarterId); },
    { functionName: 'apiBackfillRoster', argsSummary: 'quarterId=' + quarterId });
}

/**
 * 用途：前端呼叫，取得指定主日的完整可編輯欄位、唯讀區塊、待填清單、
 *   警告與樂觀鎖時間戳記。
 * Args:
 *   isoDate {string} 主日日期，yyyy-MM-dd。
 * Returns:
 *   {{ok:boolean, data:Object, error?:Object}} `data` 形狀見
 *     `loadWeekForWebApp_()`。
 */
function apiLoadWeek(isoDate) {
  return withApiResult_(function () { return loadWeekForWebApp_(isoDate); },
    { functionName: 'apiLoadWeek', argsSummary: 'isoDate=' + isoDate });
}

/**
 * 用途：前端呼叫，預覽「由內容表匯入這一個主日」會改動什麼。**唯讀。**
 *
 *   ⚠️ 與選單「從內容表匯入」呼叫**同一個** `previewContentImport_()`，
 *   不可以各寫一套差異計算。
 * Args:
 *   isoDate {string} 主日日期，yyyy-MM-dd。
 * Returns:
 *   {{ok:boolean, data:Object, error?:Object}}
 */
function apiPreviewContentImport(isoDate) {
  return withApiResult_(function () { return contentImportForWebApp_(isoDate, false); },
    { functionName: 'apiPreviewContentImport', argsSummary: 'isoDate=' + isoDate });
}

/**
 * 用途：前端呼叫，真的把這一個主日由內容表匯入。
 * Args:
 *   isoDate {string} 主日日期，yyyy-MM-dd。
 * Returns:
 *   {{ok:boolean, data:Object, error?:Object}}
 */
function apiRunContentImport(isoDate) {
  return withApiResult_(function () { return contentImportForWebApp_(isoDate, true); },
    { functionName: 'apiRunContentImport', argsSummary: 'isoDate=' + isoDate });
}

/**
 * 用途：Web App 的「重新匯入」按鈕背後的共用實作——先由主日反查季度，
 *   再叫跟選單完全一樣的預覽／匯入函式。
 * Args:
 *   isoDate {string} 主日日期，yyyy-MM-dd。
 *   apply {boolean} `false` 只預覽；`true` 真的寫入。
 * Returns:
 *   {{ok:boolean, scope:string, summary:(Object|undefined), lines:string[],
 *     reason:(string|undefined), message:(string|undefined)}}
 *     `lines` 是可以直接顯示的差異摘要行。
 */
function contentImportForWebApp_(isoDate, apply) {
  var quarterId = lookupQuarterIdForIsoDate_(isoDate);
  if (!quarterId) {
    return {
      ok: false, scope: 'ONE_WEEK', lines: [], reason: 'NO_QUARTER',
      message: '找不到主日 ' + isoDate + ' 屬於哪一個季度，無法匯入。'
    };
  }

  var result = apply
    ? applyContentImport_(quarterId, { isoDate: isoDate })
    : previewContentImport_(quarterId, { isoDate: isoDate });

  if (!result.ok) {
    return { ok: false, scope: 'ONE_WEEK', lines: [], reason: result.reason, message: result.message };
  }

  if (apply) {
    // 與整季匯入（`WEBAPP_CONTENT_IMPORT_QUARTER`）同一做法：逐格記錄之外，再寫一行摘要。
    appendAuditLog_({
      action: 'WEBAPP_CONTENT_IMPORT_WEEK',
      sheetName: SHEETS.CONTENT_SHEETS,
      rowKey: isoDate,
      newValue: '+' + result.plan.added + ' ~' + result.plan.updated + ' -' + result.plan.removed,
      notes: '由填寫介面「重新匯入（只限這一個主日）」匯入 ' + isoDate + '（季度 ' + quarterId + '）。'
    });
  }

  var dryRun = normalizeBoolean_(getConfig(CONFIG_KEYS.DRY_RUN, 'TRUE')) === true;
  var conflicts = result.plan.conflicts || [];
  var releases = result.plan.releases || [];
  return {
    ok: true,
    scope: result.scope,
    summary: {
      added: result.plan.added, updated: result.plan.updated,
      removed: result.plan.removed, unchanged: result.plan.unchanged,
      // 2026-10-23 重測發現：只有「沒有蓋過」或「解除覆寫」時，前端以前只看三個數字，講「一致，沒有任何改動」，
      //    沒有蓋過的格靜靜不講（bug class 2），解除覆寫亦永遠做不到。
      conflicts: conflicts.length, releases: releases.length,
      noChangeMessage: buildContentImportNoChangeMessage_(conflicts)
    },
    lines: buildContentImportDialogLines_(result, { dryRun: dryRun, applied: Boolean(apply) })
  };
}

/**
 * 用途：單週匯入「沒有要寫的改動」時給幹事看的一句。有格在介面改過、而內容表的值不同（沒有蓋過）就逐格講出來，
 *   不可以講成「一致」。純函式。
 * Args:
 *   conflicts {{isoDate:string, field:string, overrideValue:*, sourceValue:*}[]} 匯入計畫的 `conflicts`。
 * Returns:
 *   {string}
 * Raises:
 *   （無）
 */
function buildContentImportNoChangeMessage_(conflicts) {
  var list = conflicts || [];
  if (list.length === 0) return '內容表與週報現況一致，沒有任何改動。';
  var shown = list.slice(0, 3).map(function (c) {
    return contentFieldLabel_(c.field) + '（你填的是「' + (c.overrideValue || '（空白）') + '」，內容表是「'
      + (c.sourceValue || '（空白）') + '」）';
  });
  return '沒有要匯入的改動。有 ' + list.length + ' 格你在介面改過，內容表的值不同，所以沒有蓋過：'
    + shown.join('；') + (list.length > 3 ? '；另有 ' + (list.length - 3) + ' 格' : '')
    + '。想跟回內容表，把介面那一格改成與內容表相同再儲存。';
}

// =====================================================================
// R-038：季度作業（八個功能）
//
// ⚠️ 每一支都只是叫 src/QuarterOps.gs 那一份共用核心，一行邏輯都沒有
//    自己寫。試算表選單叫的是同一批函式——同一個狀態不可以有兩個真相
//    來源（見 docs/已知bug類型.md 事故三）。
//
// ⚠️ 四個唯讀報告（E-H）一律**回傳行**，不寫 `Diagnostics`。
//    `Diagnostics` 每次執行清空重寫，只保留最新一份；幹事在介面撳一下，
//    就會把 IT 剛跑完的診斷報告清走，而且沒有任何提示。
// =====================================================================

/**
 * 用途：前端呼叫，取得「季度作業」區塊開啟時要知道的東西。**唯讀。**
 * Args:
 *   quarterId {string} 目前選住的季度；空白就由 `resolveWorkingQuarter_()` 決定。
 * Returns:
 *   {{ok:boolean, data:Object, error?:Object}}
 */
function apiGetQuarterOpsPanel(quarterId) {
  return withApiResult_(function () { return quarterOpsPanelData_(quarterId); },
    { functionName: 'apiGetQuarterOpsPanel', argsSummary: 'quarterId=' + quarterId });
}

/**
 * 用途：前端呼叫，預覽「建立本季週報」會新增幾多行。**唯讀。**
 * Args:
 *   quarterId {string}
 * Returns:
 *   {{ok:boolean, data:Object, error?:Object}}
 */
function apiPreviewCreateWeeks(quarterId) {
  return withApiResult_(function () { return previewCreateBlankWeeks_(quarterId); },
    { functionName: 'apiPreviewCreateWeeks', argsSummary: 'quarterId=' + quarterId });
}

/**
 * 用途：前端呼叫，真的建立本季週報。**冪等**：已經存在的日期一格都不會改。
 * Args:
 *   quarterId {string}
 * Returns:
 *   {{ok:boolean, data:Object, error?:Object}}
 */
function apiRunCreateWeeks(quarterId) {
  return withApiResult_(function () { return runCreateBlankWeeks_(quarterId); },
    { functionName: 'apiRunCreateWeeks', argsSummary: 'quarterId=' + quarterId });
}

/**
 * 用途：前端呼叫，預覽「建立／刷新本季內容表」會建立還是刷新。**唯讀。**
 * Args:
 *   quarterId {string}
 * Returns:
 *   {{ok:boolean, data:Object, error?:Object}}
 */
function apiPreviewContentSheetBuild(quarterId) {
  return withApiResult_(function () { return previewContentSheetBuild_(quarterId); },
    { functionName: 'apiPreviewContentSheetBuild', argsSummary: 'quarterId=' + quarterId });
}

/**
 * 用途：前端呼叫，真的建立或刷新本季內容表。
 *   刷新時同工已經填落去的資料**一格都不會改**。
 * Args:
 *   quarterId {string}
 * Returns:
 *   {{ok:boolean, data:Object, error?:Object}} `data.summary.fileUrl` 可以直接開。
 */
function apiRunContentSheetBuild(quarterId) {
  return withApiResult_(function () { return runContentSheetBuild_(quarterId); },
    { functionName: 'apiRunContentSheetBuild', argsSummary: 'quarterId=' + quarterId });
}

/**
 * 用途：前端呼叫，預覽「寄出內容表連結」會寄給幾多人。**唯讀，一封信都不寄。**
 *
 *   ⚠️ 收件人 0 個會回 `ok:false`＋`reason='NO_RECIPIENTS'`，訊息明確
 *   講「就算撳落去也不會寄到任何人」——不可以等寄完才回「已寄 0 封」。
 * Args:
 *   quarterId {string}
 * Returns:
 *   {{ok:boolean, data:Object, error?:Object}}
 */
function apiPreviewContentSheetInvite(quarterId) {
  return withApiResult_(function () { return previewContentSheetInvite_(quarterId); },
    { functionName: 'apiPreviewContentSheetInvite', argsSummary: 'quarterId=' + quarterId });
}

/**
 * 用途：前端呼叫，真的寄出內容表連結。**受 `DRY_RUN` 管**——
 *   `DRY_RUN=TRUE` 時只寫 `SendLog`，一封都不會真的寄出。
 * Args:
 *   quarterId {string}
 * Returns:
 *   {{ok:boolean, data:Object, error?:Object}}
 */
function apiRunContentSheetInvite(quarterId) {
  return withApiResult_(function () { return runContentSheetInvite_(quarterId); },
    { functionName: 'apiRunContentSheetInvite', argsSummary: 'quarterId=' + quarterId });
}

/**
 * 用途：前端呼叫，預覽「從內容表匯入（整季）」會改動什麼。**唯讀。**
 *
 *   ⚠️ 與唯讀區塊上方那粒「重新匯入」走同一組函式，分別只在範圍：
 *   那一粒是**這一個主日**，這一支是**整季**。
 * Args:
 *   quarterId {string}
 * Returns:
 *   {{ok:boolean, data:Object, error?:Object}}
 */
function apiPreviewQuarterContentImport(quarterId) {
  return withApiResult_(function () { return quarterContentImport_(quarterId, false); },
    { functionName: 'apiPreviewQuarterContentImport', argsSummary: 'quarterId=' + quarterId });
}

/**
 * 用途：前端呼叫，真的把整季由內容表匯入。
 * Args:
 *   quarterId {string}
 * Returns:
 *   {{ok:boolean, data:Object, error?:Object}}
 */
function apiRunQuarterContentImport(quarterId) {
  return withApiResult_(function () { return quarterContentImport_(quarterId, true); },
    { functionName: 'apiRunQuarterContentImport', argsSummary: 'quarterId=' + quarterId });
}

/**
 * 用途：前端呼叫，本季待填清單。**唯讀，不寫 `Diagnostics`。**
 * Args:
 *   quarterId {string}
 * Returns:
 *   {{ok:boolean, data:Object, error?:Object}}
 */
function apiQuarterMissingReport(quarterId) {
  return withApiResult_(function () { return quarterMissingFieldsReport_(quarterId); },
    { functionName: 'apiQuarterMissingReport', argsSummary: 'quarterId=' + quarterId });
}

/**
 * 用途：前端呼叫，檢查職事表分歧。**唯讀**——本系統一格都不會寫職事表。
 * Args:
 *   isoDate {string} 主日日期，yyyy-MM-dd。
 * Returns:
 *   {{ok:boolean, data:Object, error?:Object}}
 */
function apiRosterDiffReport(isoDate) {
  return withApiResult_(function () { return rosterDiffReport_(isoDate); },
    { functionName: 'apiRosterDiffReport', argsSummary: 'isoDate=' + isoDate });
}

/**
 * 用途：前端呼叫，上線前檢查。**唯讀，不寫 `Diagnostics`。**
 * Args: （無）
 * Returns:
 *   {{ok:boolean, data:Object, error?:Object}}
 */
function apiGoLiveReport() {
  return withApiResult_(function () { return goLiveReport_(); },
    { functionName: 'apiGoLiveReport', argsSummary: '' });
}

/**
 * 用途：前端呼叫，發佈版本記錄。**唯讀**——master 檔案的內容一個位元
 *   都不會碰，也不會寫 `Diagnostics`。
 * Args: （無）
 * Returns:
 *   {{ok:boolean, data:Object, error?:Object}}
 */
function apiPublishRevisionsReport() {
  return withApiResult_(function () { return publishRevisionsReport_(); },
    { functionName: 'apiPublishRevisionsReport', argsSummary: '' });
}

/**
 * 用途：前端呼叫，用**未儲存**的草稿欄位值即時重算一次程序表，不寫入
 *   任何工作表。
 * Args:
 *   isoDate {string} 主日日期，yyyy-MM-dd。
 *   draftFields {Object} 目前表單上的欄位草稿值（以 `BulletinWeeks` 機器鍵
 *     為 key），會覆蓋掉工作表現有值後再算一次程序表。
 * Returns:
 *   {{ok:boolean, data:{templateId:string, rows:Object[]}, error?:Object}}
 */
function apiPreviewProgram(isoDate, draftFields) {
  return withApiResult_(function () { return previewProgramForWebApp_(isoDate, draftFields); },
    { functionName: 'apiPreviewProgram', argsSummary: 'isoDate=' + isoDate });
}

/**
 * 用途：前端呼叫，儲存一週的可編輯欄位。詳細行為見 `src/WebAppSave.gs`
 *   的 `saveWeekFromWebApp_()`（樂觀鎖、upsert、逐格 AuditLog）。
 * Args:
 *   payload {Object} 見 `src/WebAppSave.gs` 檔頭的 payload 形狀說明。
 * Returns:
 *   {{ok:boolean, data:{lastSavedAt:string, changedFieldCount:number, sideRecordCount:number,
 *     message:{type:string,text:string}}, error?:Object}}
 *     `changedFieldCount` 是使用者改了幾個欄位，覆寫記錄等附帶記錄不計
 *     （另計在 `sideRecordCount`，見 `countSaveChanges_()`）。
 *     樂觀鎖沒對上時 `error.code` 是 `'STALE'`；工作表結構落後於程式碼時
 *     `error.code` 是 `'SCHEMA_OUTDATED'`（見 `checkSheetSchema_()`），
 *     兩種情況都**不會執行任何寫入**。
 */
function apiSaveWeek(payload) {
  return withApiResult_(function () {
    assertSheetSchemaUpToDate_('儲存');
    return saveWeekFromWebApp_(payload);
  }, { functionName: 'apiSaveWeek', argsSummary: 'isoDate=' + (payload && payload.isoDate) });
}

/**
 * 用途：工作表結構落後於程式碼時拒絕動作，不要寫壞資料。儲存、還原、重設
 *   這幾個會寫入的入口共用同一個檢查與訊息。
 * Args:
 *   actionWord {string} 拒絕的是哪個動作（例如「儲存」），只用來組訊息。
 * Returns:
 *   {void}
 * Raises:
 *   Error（`code:'SCHEMA_OUTDATED'`）如果 `checkSheetSchema_()` 不通過。
 */
function assertSheetSchemaUpToDate_(actionWord) {
  var schema = checkSheetSchema_();
  if (schema.ok) return;
  var err = new Error(
    '工作表結構落後於程式碼（' + buildSchemaMismatchSummary_(schema)
    + '），請先在試算表按「週報系統 ▸ 初始化工作表」。寧可拒絕' + actionWord + '，也不要寫壞資料。'
  );
  err.code = 'SCHEMA_OUTDATED';
  throw err;
}

/**
 * 用途：內容表 v2：講員表格已停用，三個講員表格 api 共用的回覆——一律回 `SPEAKER_FORM_RETIRED`，
 *   一格都不寫。填寫介面已經沒有「講員表格」區塊，但這三支是不帶底線的公開函式，舊分頁或瀏覽器
 *   主控台仍然叫得到（bug class 33、47），所以後端要自己把關。
 * Args:
 *   functionName {string} api 名稱（ErrorLog 用）。
 * Returns:
 *   {{ok:boolean, error:{code:string, message:string}}} `ok` 一律是 `false`。
 * Raises:
 *   （無）錯誤由 `withApiResult_()` 轉成回傳值。
 */
function speakerFormRetiredApiResult_(functionName) {
  return withApiResult_(function () {
    var err = new Error(speakerFormRetiredApiMessage_());
    err.code = 'SPEAKER_FORM_RETIRED';
    throw err;
  }, { functionName: functionName });
}

/**
 * 用途：（內容表 v2 起已停用）以前取「講員表格」區塊的現況。一律回 `SPEAKER_FORM_RETIRED`。
 * Args: （無）
 * Returns:
 *   {{ok:boolean, error:Object}}
 * Raises:
 *   （無）
 */
function apiGetSpeakerFormStatus() {
  return speakerFormRetiredApiResult_('apiGetSpeakerFormStatus');
}

/**
 * 用途：（內容表 v2 起已停用）以前建立講員表格。一律回 `SPEAKER_FORM_RETIRED`，不建表格、不裝觸發器。
 * Args: （無）
 * Returns:
 *   {{ok:boolean, error:Object}}
 * Raises:
 *   （無）
 */
function apiCreateSpeakerForm() {
  return speakerFormRetiredApiResult_('apiCreateSpeakerForm');
}

/**
 * 用途：（內容表 v2 起已停用）以前刷新講員表格的日期選項。一律回 `SPEAKER_FORM_RETIRED`，不改表格。
 * Args: （無）
 * Returns:
 *   {{ok:boolean, error:Object}}
 * Raises:
 *   （無）
 */
function apiRefreshSpeakerFormDates() {
  return speakerFormRetiredApiResult_('apiRefreshSpeakerFormDates');
}

/**
 * 用途：前端呼叫，列出這一個主日的版本記錄與發佈記錄。唯讀。
 * Args:
 *   isoDate {string} 主日日期，yyyy-MM-dd。
 * Returns:
 *   {{ok:boolean, data:Object, error?:Object}} `data` 形狀見
 *     `listWeekSnapshotsForWebApp_()`。
 */
function apiListWeekSnapshots(isoDate) {
  return withApiResult_(function () { return listWeekSnapshotsForWebApp_(isoDate); },
    { functionName: 'apiListWeekSnapshots', argsSummary: 'isoDate=' + isoDate });
}

/**
 * 用途：前端呼叫，逐項列出某個版本與現在的差異。唯讀。
 * Args:
 *   isoDate {string} 主日日期。
 *   snapshotId {string} 版本編號。
 * Returns:
 *   {{ok:boolean, data:Object, error?:Object}} `data` 形狀見
 *     `diffWeekSnapshotForWebApp_()`。
 */
function apiDiffWeekSnapshot(isoDate, snapshotId) {
  return withApiResult_(function () { return diffWeekSnapshotForWebApp_(isoDate, snapshotId); },
    { functionName: 'apiDiffWeekSnapshot', argsSummary: 'isoDate=' + isoDate + ' snapshotId=' + snapshotId });
}

/**
 * 用途：前端呼叫，還原到某個版本（寫入）。詳細行為見
 *   `restoreWeekSnapshotFromWebApp_()`。工作表結構落後時拒絕，不寫任何一格。
 * Args:
 *   payload {{isoDate:string, snapshotId:string, lastSavedAt:string}}
 * Returns:
 *   {{ok:boolean, data:Object, error?:Object}}
 */
function apiRestoreWeekSnapshot(payload) {
  return withApiResult_(function () {
    assertSheetSchemaUpToDate_('還原');
    return restoreWeekSnapshotFromWebApp_(payload);
  }, { functionName: 'apiRestoreWeekSnapshot',
    argsSummary: 'isoDate=' + (payload && payload.isoDate) + ' snapshotId=' + (payload && payload.snapshotId) });
}

/**
 * 用途：前端呼叫，重設這一週（寫入）。詳細行為見 `resetWeekFromWebApp_()`。
 *   工作表結構落後時拒絕，不寫任何一格。
 * Args:
 *   payload {{isoDate:string, lastSavedAt:string=}}
 * Returns:
 *   {{ok:boolean, data:Object, error?:Object}}
 */
function apiResetWeek(payload) {
  return withApiResult_(function () {
    assertSheetSchemaUpToDate_('重設');
    return resetWeekFromWebApp_(payload && payload.isoDate, payload && payload.lastSavedAt);
  }, { functionName: 'apiResetWeek', argsSummary: 'isoDate=' + (payload && payload.isoDate) });
}

/**
 * 用途：前端呼叫，取得「由職事表重新取數」對話框要顯示的比對清單。
 *   **唯讀，不寫入任何一格**——撳按鈕只是打開對話框看看有什麼可以取，
 *   真正的寫入要等使用者勾選完再撳「確定」（`apiFetchFromRoster()`）。
 * Args:
 *   isoDate {string} 主日日期，yyyy-MM-dd。
 * Returns:
 *   {{ok:boolean, data:{rows:Object[], rosterVersion:(number|null)}, error?:Object}}
 *     `rows` 只含 `status` 是 `CONFLICT` 或 `OVERRIDDEN` 的行——`FOLLOW`
 *     已經自動處理好、`SAME` 根本沒有東西會變，兩者都沒有「要不要取數」
 *     這個選擇可言。每一行多一個 `defaultChecked`：`CONFLICT` 預設勾選
 *     （職事表在覆寫之後改過，多數情況下要跟新的），`OVERRIDDEN` 預設
 *     不勾選（幹事的決定仍然成立，不應該預設幫他推翻）。
 */
function apiGetRosterFetchCandidates(isoDate) {
  return withApiResult_(function () { return getRosterFetchCandidates_(isoDate); },
    { functionName: 'apiGetRosterFetchCandidates', argsSummary: 'isoDate=' + isoDate });
}

/**
 * 用途：前端呼叫，把勾選的欄位改回跟隨職事表——也就是把那些格子的
 *   `DutyOverride` 改成 `ACTIVE=FALSE`（**不刪行**，記錄永遠保留）。
 * Args:
 *   isoDate {string} 主日日期，yyyy-MM-dd。
 *   selections {{postId:string, slotIndex:number}[]} 使用者勾選的欄位。
 * Returns:
 *   {{ok:boolean, data:{clearedCount:number, message:{type:string,text:string}}, error?:Object}}
 */
function apiFetchFromRoster(isoDate, selections) {
  return withApiResult_(function () { return fetchFromRosterForWebApp_(isoDate, selections); },
    { functionName: 'apiFetchFromRoster', argsSummary: 'isoDate=' + isoDate + ' selections=' + ((selections || []).length) });
}

/**
 * 用途：前端呼叫，把捕捉到的前端例外（`window.onerror`／
 *   `window.onunhandledrejection`，或前端程式碼自己 catch 到的錯誤）
 *   寫入 `ErrorLog`（`SOURCE='CLIENT'`）。跟其他 `api*` 函式一樣要通過
 *   `withApiResult_()` 的權限檢查——理由同樣是「google.script.run 可以
 *   繞過頁面直接呼叫」。
 * Args:
 *   payload {{message:(string|undefined), detail:(string|undefined),
 *     functionName:(string|undefined)}} `detail` 只准放堆疊摘要這類
 *     不含個資的內容，**前端不可以把電郵或表單完整內容塞進來**。
 * Returns:
 *   {{ok:boolean, data:{logged:boolean}, error?:Object}}
 */
function apiLogClientError(payload) {
  return withApiResult_(function () {
    var p = payload || {};
    var logged = appendErrorLog_({
      source: ERROR_LOG_SOURCE.CLIENT,
      functionName: p.functionName || '（前端）',
      errorCode: 'CLIENT_ERROR',
      message: p.message || '',
      detail: p.detail || ''
    });
    return { logged: logged };
  }, { functionName: 'apiLogClientError' });
}

// =====================================================================
// apiListWeeks 的實作
// =====================================================================

/**
 * 用途：前端呼叫，取得頂部狀態列（R-008）與「發佈及匯出」區塊要用的
 *   全部資料：目前已發佈到哪一期、三條 master 連結、收件組別選項、
 *   預設勾選、`DRY_RUN` 狀態，以及上一次記住的勾選。
 *
 *   ⚠️ 這一組資料**不隨主日下拉改變**，所以另開一個 API，不併入
 *   `apiLoadWeek()`——併進去的話，每切一次主日就會多做一次無謂的
 *   `PublishLog` 讀取。發佈完之後前端會再叫一次這個函式刷新狀態列。
 * Args: （無）
 * Returns:
 *   {{ok:boolean, data:Object, error?:Object}}
 */
function apiGetPublishStatus() {
  return withApiResult_(function () { return publishPanelDataForWebApp_(); },
    { functionName: 'apiGetPublishStatus' });
}

/**
 * 用途：前端呼叫，執行「發佈及匯出」區塊的「執行」按鈕。
 *
 *   ⚠️ 第一次呼叫時 `confirmed` 是 `false`：後端如果發現有未填欄位或者
 *   日期異常，會回 `reason:'NEEDS_CONFIRM'` 而且**一格都未寫過**；前端
 *   出完確認視窗、幹事親手勾了那個方框之後，再帶 `confirmed:true` 呼叫
 *   一次。**後端才是把關的一方**——只擋前端等於沒有擋。
 * Args:
 *   payload {Object} 見 `runPublishFlow_()`。
 * Returns:
 *   {{ok:boolean, data:Object, error?:Object}}
 */
function apiRunPublish(payload) {
  var p = payload || {};
  return withApiResult_(function () { return runPublishFlow_(p); }, {
    functionName: 'apiRunPublish',
    // ⚠️ 摘要**不可以**夾帶 `pdfBase64`（幾 MB 的 base64）或者自訂電郵
    // （個人資料）——`ErrorLog.DETAIL` 兩者都不應該有。
    argsSummary: 'isoDate=' + p.isoDate + ' doPublish=' + (p.doPublish === true)
      + ' doSend=' + (p.doSend === true) + ' confirmed=' + (p.confirmed === true)
      + ' attachWord=' + (p.attachWord === true)
  });
}

/**
 * 用途：前端呼叫，把這一個主日的 Word 檔產生出來並回傳 base64，讓瀏覽器
 *   直接下載（R-005）。
 *
 *   ⚠️ 產生用的是跟選單「產生本週週報（Word）」**同一個**
 *   `generateBulletinDocx_()`——不可以另寫一條渲染路徑，否則「介面下載
 *   到的」與「選單產生的」會慢慢分岔。
 * Args:
 *   isoDate {string} 主日日期，yyyy-MM-dd。
 *   options {{draft:Object=}=} v3：`draft` 是與儲存 payload 同形狀的草稿（`week`／`dutyEdits`／
 *     `nextWeekDutyEdits`），有就產生「包括未儲存修改」的草稿——只下載，不存雲端硬碟、不寫任何工作表。
 * Returns:
 *   {{ok:boolean, data:{fileName:string, base64:string, warnings:Object[], draft:boolean},
 *     error?:Object}}
 */
function apiDownloadBulletinDocx(isoDate, options) {
  var o = options || {};
  return withApiResult_(function () { return bulletinDocxForDownload_(isoDate, o.draft || null); },
    { functionName: 'apiDownloadBulletinDocx', argsSummary: 'isoDate=' + isoDate + ' draft=' + Boolean(o.draft) });
}

/**
 * 用途：前端呼叫，把「發佈及匯出」區塊的勾選狀態記住。
 * Args:
 *   prefs {{doPublish:boolean, doSend:boolean, groups:string[]}}
 * Returns:
 *   {{ok:boolean, data:{saved:boolean}, error?:Object}}
 */
function apiSavePublishPrefs(prefs) {
  return withApiResult_(function () { return { saved: savePublishPrefs_(prefs) }; },
    { functionName: 'apiSavePublishPrefs' });
}

/**
 * 用途：組出頂部狀態列與「發佈及匯出」區塊要用的全部資料。
 * Args: （無）
 * Returns:
 *   {{status:Object, groupOptions:Object[], defaultGroups:string[],
 *     dryRun:boolean, attachPdf:boolean, maxPdfMb:number, prefs:Object}}
 */
function publishPanelDataForWebApp_() {
  var config = publishConfig_();
  return {
    status: buildPublishStatusForWebApp_(),
    groupOptions: publishGroupOptions_(),
    defaultGroups: config.sendGroups,
    dryRun: config.dryRun,
    attachPdf: config.attachPdf,
    maxPdfMb: config.maxPdfMb,
    prefs: loadPublishPrefs_(config.sendGroups),
    // 使用者測試模式的保險（prompt-pre-usertest 第 3 部分）：Ivan 自己
    // 在 Config 填一句話，頁面頂部就會常駐顯示一條藍色橫幅。留空就不
    // 顯示——這是唯一一個「有值才出現」的頂部橫幅，另一條（DRY_RUN）
    // 是系統狀態，不是人手決定要不要講。
    testModeBanner: getConfig(CONFIG_KEYS.TEST_MODE_BANNER, '')
  };
}

/**
 * 用途：讀出這個使用者上一次的勾選狀態。
 *
 *   ⚠️ 存 `PropertiesService` 的 **user properties**，不是工作表：這是
 *   個人的介面偏好，不是系統資料。寫進工作表的話，兩個幹事同時用就會
 *   互相蓋掉，而且每一次勾選都變成一筆試算表寫入。
 * Args:
 *   defaultGroups {string[]} 沒有存過時要用的預設勾選（Config
 *     `PUBLISH_SEND_GROUPS`）。
 *
 *   ⚠️ `doPublish` **永遠以 `false` 載入**，不論預設或之前記住的值。
 *   「發佈到 master 連結」會覆寫網站上的 master 連結，不應該靠記憶中的勾選
 *   在載入時就已經打了剔——每次發佈都要使用者當下自己勾。`doSend` 與
 *   群組照舊記住。
 * Returns:
 *   {{doPublish:boolean, doSend:boolean, groups:string[]}} `doPublish` 一律 `false`。
 */
function loadPublishPrefs_(defaultGroups) {
  var fallback = { doPublish: false, doSend: false, groups: (defaultGroups || []).slice() };
  try {
    var raw = PropertiesService.getUserProperties().getProperty(PUBLISH_PREFS_KEY_);
    if (!raw) return fallback;
    var parsed = JSON.parse(raw);
    return {
      doPublish: false,
      doSend: parsed.doSend === true,
      groups: Array.isArray(parsed.groups) ? parsed.groups : fallback.groups
    };
  } catch (err) {
    // 偏好設定讀不到只是「回到預設」，不應該令整個介面載入不到。
    return fallback;
  }
}

/**
 * 用途：把這個使用者的勾選狀態存起來。
 * Args:
 *   prefs {{doPublish:boolean, doSend:boolean, groups:string[]}}
 * Returns:
 *   {boolean} 存不到回 `false`，不拋錯。
 */
function savePublishPrefs_(prefs) {
  var p = prefs || {};
  try {
    PropertiesService.getUserProperties().setProperty(PUBLISH_PREFS_KEY_, JSON.stringify({
      doPublish: p.doPublish === true,
      doSend: p.doSend === true,
      groups: Array.isArray(p.groups) ? p.groups : []
    }));
    return true;
  } catch (err) {
    return false;
  }
}

/**
 * 用途：`PropertiesService` 內存放「發佈及匯出」勾選偏好的鍵名。寫成
 *   函式外的常數即可——這個檔案沒有跨檔案頂層引用的問題（純字串）。
 */
var PUBLISH_PREFS_KEY_ = 'PUBLISH_PANEL_PREFS';

/**
 * 用途：`apiDownloadBulletinDocx()` 的 IO 層——產生 Word 檔並轉成 base64，
 *   同時把它存成這個主日在雲端硬碟的「最新版」。
 *
 *   ⚠️ 存雲端失敗不可以令下載失敗：幹事要的是手上這份檔案。失敗改為
 *   一則警告，由前端顯示；雲端沒有更新，`wordFile` 就是 `null`（前端會
 *   沿用載入時顯示的舊連結，警告已經講明新版沒有存進去）。
 * Args:
 *   isoDate {string} 主日日期，yyyy-MM-dd。
 * Returns:
 *   {{fileName:string, base64:string, warnings:Object[], wordFile:?Object}}
 *     `wordFile` 形狀見 `buildWordFileInfo_()`。
 * Raises:
 *   Error 如果職事表未設定、範本未設定，或者渲染失敗——訊息一律沿用
 *     `generateBulletinDocx_()` 已經組好那一句，不在這裏另寫。
 */
function bulletinDocxForDownload_(isoDate, draft) {
  var result = generateBulletinDocx_(isoDate, draft ? { modelOptions: buildDraftModelOptions_(isoDate, draft) } : undefined);
  if (!result.ok) {
    var err = new Error(result.message || '未能產生 Word 檔。');
    err.code = result.reason || 'RENDER_FAILED';
    throw err;
  }
  // v3：草稿只下載，不存雲端硬碟（雲端硬碟上的「最新 Word」一定是已儲存的內容）。
  if (draft) {
    var draftName = String(result.fileName || '').replace(/\.docx$/i, '') + '（草稿）.docx';
    return {
      fileName: draftName, base64: Utilities.base64Encode(result.blob.getBytes()),
      warnings: result.warnings || [], wordFile: null, draft: true
    };
  }
  var stored = tryStoreLatestBulletinDocx_(isoDate, result, {
    action: 'BULLETIN_DOCX_WEBAPP_SAVE',
    notes: '填寫介面「下載 Word」同時更新了這個主日的最新 Word。'
  });
  return {
    fileName: result.fileName,
    base64: Utilities.base64Encode(result.blob.getBytes()),
    warnings: (result.warnings || []).concat(stored.warning ? [stored.warning] : []),
    wordFile: stored.wordFile,
    draft: false
  };
}

/**
 * 用途：組出填寫介面「最新 Word」那一行要用的資料。
 * Args:
 *   docId {*} `BulletinWeeks.DOC_ID`。
 *   generatedAt {*} `BulletinWeeks.LAST_GENERATED_AT`（`Date`）；不是 `Date`
 *     就當作時間未知。
 *   isoDate {string} 主日日期，用來還原檔名。
 *   folderId {string=} 檔案所在資料夾 ID；未知就省略，資料夾連結便是空字串。
 * Returns:
 *   {?{fileId:string, url:string, folderUrl:string, fileName:string, generatedAt:string}}
 *     `docId` 是空白（從未存過）回 `null`；`generatedAt` 未知時是空字串。
 */
function buildWordFileInfo_(docId, generatedAt, isoDate, folderId) {
  var id = String(docId === null || docId === undefined ? '' : docId).trim();
  if (!id) return null;
  var stamp = '';
  if (generatedAt instanceof Date && !isNaN(generatedAt.getTime())) {
    stamp = Utilities.formatDate(
      generatedAt, getConfig(CONFIG_KEYS.SYS_TIMEZONE, 'Pacific/Auckland'), 'yyyy-MM-dd HH:mm'
    );
  }
  var folder = String(folderId || '').trim();
  return {
    fileId: id, url: driveFileViewUrl_(id),
    folderUrl: folder ? driveFolderViewUrl_(folder) : '',
    fileName: buildOutputFileName_(isoDate), generatedAt: stamp
  };
}

/**
 * 用途：載入某個主日時，由 `BulletinWeeks` 的 `DOC_ID` 組出「最新 Word」資料，
 *   並向 Drive 查一次檔案所在的資料夾。
 *
 *   ⚠️ 檔案已被丟進垃圾桶 ⇒ 當作沒有（一條通往垃圾桶的連結比沒有連結更
 *   誤導人）。查不到（進階服務出錯）⇒ 仍然顯示檔案連結，只是沒有資料夾連結。
 * Args:
 *   weekRow {Object} `BulletinWeeks` 該主日那一行；沒有就傳 `{}`。
 *   isoDate {string} 主日日期。
 * Returns:
 *   {?Object} 見 `buildWordFileInfo_()`；從未產生過回 `null`。
 */
function wordFileInfoForWeek_(weekRow, isoDate) {
  var docId = String((weekRow || {}).DOC_ID || '').trim();
  if (!docId) return null;
  var location = driveGetFileLocation_(docId);
  if (location && location.trashed) return null;
  return buildWordFileInfo_(docId, weekRow.LAST_GENERATED_AT, isoDate, location ? location.folderId : '');
}

/**
 * 用途：`apiListWeeks()` 的 IO 層——讀 `BulletinWeeks`、`PublishLog` 與
 *   內容三張表，交給純函式層組出**兩層**下拉（季度 → 主日）與預設選中
 *   的日期。
 *
 *   ⚠️ 舊的 `weeks`／`defaultIsoDate` 兩個欄位照樣回傳，不可以拿走——
 *   網址帶主日參數直接跳轉那條路徑仍然靠它，前端亦要在拿不到 `quarters`
 *   時退回舊行為（R-034）。
 * Args: （無）
 * Returns:
 *   {{weeks:Object[], defaultIsoDate:(string|null),
 *     quarters:Object[], defaultQuarterId:(string|null)}}
 */
function listWeeksForWebApp_(includeArchived) {
  var rows = readSheet(SHEETS.BULLETIN_WEEKS);
  // v3 重測（2026-10-27）：與發佈時窗同一個「今日」——測試時 Config WEBAPP_SIMULATED_TODAY 填了，打開就落在
  //    模擬那一週（未填就是真正的今日，與以前一樣）。
  var todayIso = webAppTodayIso_().todayIso;

  var publishIndex = weekSelectorPublishIndex_(readSheet(SHEETS.PUBLISH_LOG));
  var missingIndex = weekSelectorMissingIndex_(
    rows,
    readSheet(SHEETS.ANNOUNCEMENTS),
    readSheet(SHEETS.PRAYERS),
    readSheet(SHEETS.FELLOWSHIPS)
  );

  var entries = buildWeekListEntries_(rows, todayIso, {
    publishIndex: publishIndex,
    missingIndex: missingIndex
  });

  var allGroups = buildQuarterWeekGroups_(entries, getConfig(CONFIG_KEYS.SELFTEST_QUARTER_ID, ''));

  // R-035：已封存的季度預設不顯示，勾了「顯示已封存」才全部列出。
  // ⚠️ 沙盒季度由 buildQuarterWeekGroups_() 擋走，兩邊都不會出現。
  var archivedByQuarter = quarterArchivedFlags_(rows);
  var wantArchived = includeArchived === true;
  var groups = allGroups.filter(function (g) {
    return wantArchived || archivedByQuarter[g.quarterId] !== true;
  }).map(function (g) {
    return {
      quarterId: g.quarterId,
      // 已封存的要在下拉裏面睇得出，否則勾了「顯示已封存」之後分不清。
      label: g.label + (archivedByQuarter[g.quarterId] === true ? '（已封存）' : ''),
      archived: archivedByQuarter[g.quarterId] === true,
      weeks: g.weeks
    };
  });

  var defaultIsoDate = pickDefaultSelectorIsoDate_(groups, todayIso);
  if (defaultIsoDate === null) defaultIsoDate = pickDefaultWeekIsoDate_(entries, todayIso);

  var archivedCount = allGroups.filter(function (g) {
    return archivedByQuarter[g.quarterId] === true;
  }).length;

  return {
    weeks: entries,
    defaultIsoDate: defaultIsoDate,
    quarters: groups,
    defaultQuarterId: quarterIdOfIsoDateInGroups_(groups, defaultIsoDate),
    // R-035：前端要知道「有沒有已封存的季度」才決定要不要提示。
    archivedQuarterCount: archivedCount,
    includeArchived: wantArchived,
    // ⚠️ 一個可見季度都沒有時**一定要有一句說明**，不可以只顯示一個空下拉。
    //    「十月回來打開系統見到一片空白」是這一條功能最大的風險。
    emptyHint: groups.length === 0 ? RETENTION_EMPTY_HINT_ : ''
  };
}

/**
 * 用途：由 `BulletinWeeks` 算出每一季是不是已封存。**純函式。**
 *
 *   ⚠️ 一季之內只要**有任何一行**未封存，那一季就當成未封存。封存是
 *   整季一齊做的，出現「一半封存一半沒有」代表中途出過事——那種情況
 *   應該讓那一季照樣顯示（睇得到才修得到），不是靜靜收起。
 * Args:
 *   rows {Object[]} `readSheet(SHEETS.BULLETIN_WEEKS)` 的輸出。
 * Returns:
 *   {Object<string,boolean>}
 */
function quarterArchivedFlags_(rows) {
  var anyUnarchived = {};
  var seen = {};
  (rows || []).forEach(function (row) {
    var qid = String(row.QUARTER_ID || '').trim();
    if (!qid) return;
    seen[qid] = true;
    if (row.ARCHIVED !== true) anyUnarchived[qid] = true;
  });

  var out = {};
  Object.keys(seen).forEach(function (qid) {
    out[qid] = anyUnarchived[qid] !== true;
  });
  return out;
}

/**
 * 用途：由 `PublishLog` 整理出「每一個主日最新是第幾版」。
 *
 *   ⚠️ 自測（`IS_SELFTEST` 為真）那些行不可以算進去，否則沙盒跑過一次
 *   之後，正式的主日會變成「已發佈」。
 * Args:
 *   publishRows {Object[]} `readSheet(SHEETS.PUBLISH_LOG)` 的輸出。
 * Returns:
 *   {Object<string,number>} 以 yyyy-MM-dd 為鍵，值是最大的版本號。
 *     沒有任何發佈紀錄的主日不會出現在裏面。
 */
function weekSelectorPublishIndex_(publishRows) {
  var index = {};
  (publishRows || []).forEach(function (row) {
    if (row.IS_SELFTEST === true) return;
    var iso = weekSelectorIsoOf_(row.SERVICE_DATE);
    if (!iso) return;
    var version = Number(row.VERSION_NO);
    if (!isFinite(version)) version = 0;
    if (!Object.prototype.hasOwnProperty.call(index, iso) || version > index[iso]) {
      index[iso] = version;
    }
  });
  return index;
}

/**
 * 用途：把一個可能是 Date、可能是字串的日期值轉成 yyyy-MM-dd。
 * Args:
 *   value {*} 日期值。
 * Returns:
 *   {?string} 轉不到回 `null`。
 */
function weekSelectorIsoOf_(value) {
  if (value instanceof Date) return formatIsoDate_(value);
  var text = String(value === null || value === undefined ? '' : value).trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

/**
 * 用途：算出每一個主日「未填欄位」有多少項，供下拉的狀態標記用。
 *   F6：只數「一定要填」，「通常空白」不計入（下拉標籤很短，不附註）。
 *
 *   ⚠️ 這裏**故意只數本試算表拿得到的東西**（`BulletinWeeks` 的欄位、
 *   家事報告／代禱／團契有沒有行），不去讀職事表。下拉選單一開就要出來，
 *   逐個主日跑一次 `buildBulletinModel_()` 會連帶讀職事表幾十次，慢到不能
 *   用。因此這個數字是「未填欄位」的**下限**：職事表未排人手那幾格不計。
 *   要看完整清單請用選單「本季待填清單」。
 * Args:
 *   weekRows {Object[]} `readSheet(SHEETS.BULLETIN_WEEKS)` 的輸出。
 *   announcementRows {Object[]} `readSheet(SHEETS.ANNOUNCEMENTS)` 的輸出。
 *   prayerRows {Object[]} `readSheet(SHEETS.PRAYERS)` 的輸出。
 *   fellowshipRows {Object[]} `readSheet(SHEETS.FELLOWSHIPS)` 的輸出。
 * Returns:
 *   {Object<string,number>} 以 yyyy-MM-dd 為鍵，值是未填項數。
 */
function weekSelectorMissingIndex_(weekRows, announcementRows, prayerRows, fellowshipRows) {
  var announcements = weekSelectorActiveCountByIso_(announcementRows);
  var prayers = weekSelectorActiveCountByIso_(prayerRows);
  var fellowships = weekSelectorActiveCountByIso_(fellowshipRows);

  var index = {};
  (weekRows || []).forEach(function (row) {
    var iso = weekSelectorIsoOf_(row.SERVICE_DATE);
    if (!iso) return;
    // F6：只數「一定要填」，與頂部徽章同一個算法（經 `missingCountSummary_()`）。
    index[iso] = missingCountSummary_(buildMissingList_({
      week: row,
      dutyBoxPage1: [],                                  // 見上面的說明：不讀職事表
      announcementCount: announcements[iso] || 0,
      prayerCount: prayers[iso] || 0,
      fellowshipCount: fellowships[iso] || 0
    })).requiredCount;
  });
  return index;
}

/**
 * 用途：數一數某張內容表每一個主日有幾多行**有效**資料。
 * Args:
 *   rows {Object[]} 內容表的資料列，需有 `SERVICE_DATE` 與 `ACTIVE`。
 * Returns:
 *   {Object<string,number>} 以 yyyy-MM-dd 為鍵。
 */
function weekSelectorActiveCountByIso_(rows) {
  var counts = {};
  (rows || []).forEach(function (row) {
    if (row.ACTIVE !== true) return;
    var iso = weekSelectorIsoOf_(row.SERVICE_DATE);
    if (!iso) return;
    counts[iso] = (counts[iso] || 0) + 1;
  });
  return counts;
}

/**
 * 用途：組出主日下拉那一句狀態標記。幹事最常問「邊幾期未搞掂」，答案就
 *   放在這裏。
 * Args:
 *   publishedVersion {?number} 最新版本號；未發佈傳 `null`／`undefined`。
 *   missingCount {number} 未填項數。
 * Returns:
 *   {string} `已發佈 第 N 版`／`待填 N 項`／`已齊`。
 */
function weekSelectorStatusLabel_(publishedVersion, missingCount) {
  if (publishedVersion !== null && publishedVersion !== undefined) {
    return '已發佈 第 ' + publishedVersion + ' 版';
  }
  var count = Number(missingCount);
  if (isFinite(count) && count > 0) return '待填 ' + count + ' 項';
  return '已齊';
}

/**
 * 用途：把 `BulletinWeeks` 資料列組成下拉選單用的清單：`STATUS` 不是
 *   `SENT` 的排前面，組內按日期由小到大排序。純函式，方便獨立測試。
 * Args:
 *   rows {Object[]} `readSheet(SHEETS.BULLETIN_WEEKS)` 的輸出。
 *   todayIso {string} 今天的日期，yyyy-MM-dd（只用來讓呼叫方之後挑預設值，
 *     這個函式本身不使用）。
 *   decorations {Object=} 可選，形狀
 *     `{publishIndex:Object<string,number>, missingIndex:Object<string,number>}`。
 *     不傳就當兩個都是空的：`publishedVersion` 一律 `null`、`missingCount`
 *     一律 `0`（狀態標記會是「已齊」）。
 * Returns:
 *   {{isoDate:string, quarterId:string, weekOfMonth:(number|null),
 *     status:string, rosterStatus:string, publishedVersion:(number|null),
 *     missingCount:number, statusLabel:string, label:string,
 *     selectorLabel:string}[]}
 *     `SERVICE_DATE` 不是合法 Date 的行會被略過（代表資料本身有問題，
 *     不應該讓整個下拉清單壞掉）。
 */
function buildWeekListEntries_(rows, todayIso, decorations) {
  var publishIndex = (decorations && decorations.publishIndex) || {};
  var missingIndex = (decorations && decorations.missingIndex) || {};

  return (rows || [])
    .filter(function (r) { return r.SERVICE_DATE instanceof Date; })
    .map(function (r) {
      var isoDate = formatIsoDate_(r.SERVICE_DATE);
      var weekOfMonth = (r.WEEK_OF_MONTH === null || r.WEEK_OF_MONTH === undefined) ? null : r.WEEK_OF_MONTH;
      var publishedVersion = Object.prototype.hasOwnProperty.call(publishIndex, isoDate)
        ? publishIndex[isoDate]
        : null;
      var missingCount = Object.prototype.hasOwnProperty.call(missingIndex, isoDate)
        ? missingIndex[isoDate]
        : 0;
      var statusLabel = weekSelectorStatusLabel_(publishedVersion, missingCount);
      return {
        isoDate: isoDate,
        quarterId: String(r.QUARTER_ID || ''),
        weekOfMonth: weekOfMonth,
        status: r.STATUS || '',
        rosterStatus: String(r.ROSTER_STATUS || ''),
        publishedVersion: publishedVersion,
        missingCount: missingCount,
        statusLabel: statusLabel,
        label: isoDate + '（週次 ' + (weekOfMonth === null ? '?' : weekOfMonth) + '）',
        selectorLabel: isoDate + '　' + statusLabel
      };
    })
    .sort(function (a, b) {
      var aNotSent = a.status !== BULLETIN_WEEK_STATUS.SENT;
      var bNotSent = b.status !== BULLETIN_WEEK_STATUS.SENT;
      if (aNotSent !== bNotSent) return aNotSent ? -1 : 1;
      if (a.isoDate < b.isoDate) return -1;
      if (a.isoDate > b.isoDate) return 1;
      return 0;
    });
}

/**
 * 用途：把主日清單按季度分組，組成兩層下拉的資料（R-034）。
 *
 *   ⚠️ 沙盒季度（Config `SELFTEST_QUARTER_ID`）**永遠不可以出現**。自測機
 *   會在那一季寫入大量假資料，幹事在正式介面看見會以為是真的要填的期數。
 * Args:
 *   entries {Object[]} `buildWeekListEntries_()` 的輸出。
 *   selftestQuarterId {*} 沙盒季度 ID；空值代表沒有要排除的季度。
 * Returns:
 *   {{quarterId:string, label:string, weeks:Object[]}[]}
 *     季度由新到舊；每季內的主日由早到遲。`QUARTER_ID` 是空的那些行會
 *     歸到一個 `quarterId` 為空字串、標題「未分季」的組，排在最後。
 */
function buildQuarterWeekGroups_(entries, selftestQuarterId) {
  var sandbox = String(selftestQuarterId === null || selftestQuarterId === undefined ? '' : selftestQuarterId).trim();
  var byQuarter = {};
  var order = [];

  (entries || []).forEach(function (entry) {
    var quarterId = String(entry.quarterId || '');
    if (sandbox && quarterId === sandbox) return;
    if (!Object.prototype.hasOwnProperty.call(byQuarter, quarterId)) {
      byQuarter[quarterId] = [];
      order.push(quarterId);
    }
    byQuarter[quarterId].push(entry);
  });

  order.sort(function (a, b) {
    if (a === b) return 0;
    if (a === '') return 1;                              // 未分季永遠排最後
    if (b === '') return -1;
    return a < b ? 1 : -1;                               // 由新到舊
  });

  return order.map(function (quarterId) {
    var weeks = byQuarter[quarterId].slice().sort(function (a, b) {
      if (a.isoDate < b.isoDate) return -1;
      if (a.isoDate > b.isoDate) return 1;
      return 0;
    });
    return {
      quarterId: quarterId,
      label: quarterId === '' ? '未分季' : quarterId,
      weeks: weeks
    };
  });
}

/**
 * 用途：兩層下拉開啟時預設落在「下一個未發佈的主日」（R-034）。
 *
 *   ⚠️ 不是清單第一項。幹事開介面十之八九是要填**下一期**，落在第一項
 *   （通常是最新季度最早那個主日，可能已經發佈完）等於每次都要自己再揀。
 * Args:
 *   groups {Object[]} `buildQuarterWeekGroups_()` 的輸出。
 *   todayIso {string} 今天的日期，yyyy-MM-dd。
 * Returns:
 *   {?string} 順序：今天或之後最早的未發佈主日 → 今天或之後最早的主日 →
 *     全部之中最遲的主日。完全沒有主日時回 `null`。
 */
function pickDefaultSelectorIsoDate_(groups, todayIso) {
  var all = [];
  (groups || []).forEach(function (group) {
    (group.weeks || []).forEach(function (week) { all.push(week); });
  });
  if (all.length === 0) return null;

  all.sort(function (a, b) {
    if (a.isoDate < b.isoDate) return -1;
    if (a.isoDate > b.isoDate) return 1;
    return 0;
  });

  var upcoming = all.filter(function (w) { return w.isoDate >= todayIso; });

  for (var i = 0; i < upcoming.length; i++) {
    if (upcoming[i].publishedVersion === null || upcoming[i].publishedVersion === undefined) {
      return upcoming[i].isoDate;
    }
  }
  if (upcoming.length > 0) return upcoming[0].isoDate;
  return all[all.length - 1].isoDate;
}

/**
 * 用途：查一個主日在兩層下拉裏屬於哪一個季度，讓前端由網址參數直接跳轉
 *   之後可以把季度下拉一併對準。
 * Args:
 *   groups {Object[]} `buildQuarterWeekGroups_()` 的輸出。
 *   isoDate {*} 主日日期。
 * Returns:
 *   {?string} 找不到回 `null`。
 */
function quarterIdOfIsoDateInGroups_(groups, isoDate) {
  var target = String(isoDate === null || isoDate === undefined ? '' : isoDate);
  if (!target) return null;
  for (var i = 0; i < (groups || []).length; i++) {
    var weeks = groups[i].weeks || [];
    for (var j = 0; j < weeks.length; j++) {
      if (weeks[j].isoDate === target) return groups[i].quarterId;
    }
  }
  return null;
}

/**
 * 用途：從下拉清單挑出預設選中的日期：今天之後最近的一個主日；沒有
 *   （全部都是過去）就選清單第一個。純函式。
 *
 *   ⚠️ 這是 R-034 之前的舊行為，保留下來當後備：兩層下拉如果因為季度
 *   全部被排除而空無一物，仍然要挑得出一個日期。
 * Args:
 *   entries {Object[]} `buildWeekListEntries_()` 的輸出。
 *   todayIso {string} 今天的日期，yyyy-MM-dd。
 * Returns:
 *   {?string} 清單是空陣列時回 `null`。
 */
function pickDefaultWeekIsoDate_(entries, todayIso) {
  if (!entries || entries.length === 0) return null;

  var upcoming = entries
    .filter(function (e) { return e.isoDate >= todayIso; })
    .slice()
    .sort(function (a, b) {
      if (a.isoDate < b.isoDate) return -1;
      if (a.isoDate > b.isoDate) return 1;
      return 0;
    });

  return upcoming.length > 0 ? upcoming[0].isoDate : entries[0].isoDate;
}

// =====================================================================
// apiLoadWeek 的實作
// =====================================================================

/**
 * 用途：第二批測試修正 G14：填寫介面頂部「待填 N 項」徽章與展開的待填面板用的資料。
 *   純函式。
 *
 *   required／optional／requiredCount 照舊是 splitMissingList_() 的結果（徽章的數字
 *   照舊按格數計，與寄出前檢查「未填欄位（N 項）」、主日下拉的標籤相同）；panel 是
 *   面板顯示用的清單，人數各格合併成一行（mergeAttendanceMissingItems_()，與寄出前
 *   檢查、本季待填清單同一組函式）。兩者由同一份 missing 在同一處算出，不會對不上。
 * Args:
 *   missing {Object[]} buildMissingList_() 的輸出（model.missing）。
 * Returns:
 *   {{required:Object[], optional:Object[], requiredCount:number,
 *     panel:{required:Object[], optional:Object[]}}}
 * Raises:
 *   （無）
 */
function missingSplitForWebApp_(missing) {
  var split = splitMissingList_(missing);
  split.panel = {
    required: mergeAttendanceMissingItems_(split.required),
    optional: mergeAttendanceMissingItems_(split.optional)
  };
  return split;
}

/**
 * 用途：`apiLoadWeek()` 的 IO 層。唯讀區塊（事奉框、下週事奉、特別主日、
 *   程序範本、職事表版本／是否正式發出）直接沿用 `buildBulletinModel_()`；
 *   可編輯欄位另外用**未經 BulletinModel 加工**的原始值讀出（幹事要看到
 *   實際存的內容，不是套過預設值之後的顯示字串）。
 * Args:
 *   isoDate {string} 主日日期，yyyy-MM-dd。
 * Returns:
 *   {Object} 形狀：
 *     `{ isoDate, week:Object, lists:{announcements,prayers,fellowships,finance},
 *        lastSavedAt:string, readOnly:Object, missing:Object[],
 *        missingSplit:{required:Object[], optional:Object[], requiredCount:number,
 *          panel:{required:Object[], optional:Object[]}},
 *        warnings:Object[], options:Object, rosterReloadMessage:Object,
 *        wordFile:?Object }`
 *     `readOnly.flowerRoster` 是職事表的獻花名字（獻花欄位旁邊的提示用）；
 *     `wordFile` 是雲端硬碟上這個主日最新 Word 的資料，從未存過是 `null`
 *     （形狀見 `buildWordFileInfo_()`）。
 *     `lastSavedAt` 經 `canonicalSaveToken_()` 正規化（見 WebAppSave.gs），
 *     前端只需要原樣存起來、儲存時原樣送回，不需要自己解析或轉換；
 *     `apiSaveWeek()` 比對樂觀鎖用的也是同一個函式，「從未儲存」在兩條
 *     路徑都是同一個值（空字串）——這是事故七的修法，見
 *     docs/已知bug類型.md。`rosterReloadMessage` 是
 *     `buildRosterReloadMessage_()` 算好的文案，只在「重新讀取職事表」
 *     按鈕的情境下使用。
 * Raises:
 *   Error（`code:'NOT_CONFIGURED'`）如果 `ROSTER_SPREADSHEET_ID` 未設定。
 */
function loadWeekForWebApp_(isoDate) {
  var model = buildBulletinModel_(isoDate);
  if (model.notConfigured) {
    var err = new Error('職事表尚未設定（Config 的 ROSTER_SPREADSHEET_ID 是空的），請先設定後再使用填寫介面。');
    err.code = 'NOT_CONFIGURED';
    throw err;
  }

  var weekRows = readSheet(SHEETS.BULLETIN_WEEKS);
  var weekRow = findBulletinWeekRow_(weekRows, isoDate) || {};

  var week = {};
  webAppWeekFieldKeys_().forEach(function (key) {
    var v = weekRow[key];
    if (v instanceof Date) {
      week[key] = formatIsoDate_(v);
    } else {
      week[key] = (v === null || v === undefined) ? '' : v;
    }
  });

  // v3（第 13 項）：丁戊己按這一週的安排排列；拿走了的仍然送去介面（`hidden:true`，畫刪除線），
  //    每一則帶 `arrangeKey`。次序與鍵由 arrangeListItems_() 算，與資料模型同一支。
  var arrangement = parseListArrangement_(weekRow.LIST_ARRANGEMENT);
  function arrangedForUi(type, items) {
    return arrangeListItems_(type, items, arrangement.lists[type]).map(function (a) {
      return Object.assign({}, a.item, { arrangeKey: a.key, hidden: a.hidden === true, sourceIndex: a.sourceIndex });
    });
  }

  return {
    isoDate: isoDate,
    week: week,
    lists: {
      announcements: arrangedForUi('announcements', pickWebAppListItems_(readSheet(SHEETS.ANNOUNCEMENTS), isoDate, ['TEXT'])),
      prayers: arrangedForUi('prayers', pickWebAppListItems_(readSheet(SHEETS.PRAYERS), isoDate, ['TEXT'])),
      fellowships: arrangedForUi('fellowships', pickWebAppListItems_(readSheet(SHEETS.FELLOWSHIPS), isoDate,
        ['FELLOWSHIP_NAME', 'MEETING_DATE', 'MEETING_TIME', 'CONTENT'])),
      finance: pickWebAppListItems_(readSheet(SHEETS.FINANCE), isoDate,
        ['ROW_LABEL', 'COL_SPECIAL_OVERSEAS', 'COL_HARDSHIP'])
    },
    lastSavedAt: canonicalSaveToken_(weekRow.LAST_SAVED_AT),
    readOnly: {
      dutyBoxPage1: model.dutyBoxPage1,
      nextWeekDuty: model.nextWeekDuty,
      // ⚠️ R-040：下週事奉由唯讀改為可覆寫。前端要知道**改的是哪一個
      //    主日**——那一格的 `SERVICE_DATE` 是下一個主日，不是這一週。
      //    前端不自己由日期加七天：同一個推算只應該有一處。
      nextWeekIsoDate: model.nextIsoDate || '',
      // 下一季未建立時，前端要顯示提示，**不可以靜靜當成空白可編輯**
      // ——填了會寫進一個沒有週報的主日，之後沒有人見得到。
      nextWeekEditable: (model.nextWeekDuty || []).length > 0,
      nextWeekNotice: buildNextWeekDutyNotice_(model),
      special: model.special,
      templateId: model.templateId,
      // 前端靠這個旗標決定要不要顯示「浸禮合堂副框」那一段。刻意由伺服器
      // 算好（`isBaptismTemplateId_()`），不讓前端自己拿 templateId 去跟
      // 字面值比——那樣範本 ID 一改就會有一處漏改。
      isBaptismSunday: model.isBaptismSunday === true,
      rosterVersionUsed: model.rosterVersionUsed,
      rosterIsOfficial: model.rosterIsOfficial,
      program: model.program,
      // v3（第 11 項）：程序表給介面顯示的版本——拿走的行仍在（`removed:true`），每一行帶 `key`／`addedId`。
      programDisplay: model.programDisplay || [],
      programPostureOptions: programAddPostureOptions_(),
      // R-041：誦讀下拉旁邊顯示「目前自動值：主禱文」。由後端算好——
      // 月份分組是 Config 改得到的，前端不可以自己算一次。
      recitationAuto: model.recitationAuto || '',
      // 階段 1：獻花欄位旁邊的提示。職事表的名字由後端算好（與帶入
      // 獻花同一個 rosterFlowerName_()），前端只負責挑哪一句提示。
      flowerRoster: model.flowerRoster || { thisWeek: '', nextWeek: '' },
      // ⚠️ 唯讀欄位清單由**伺服器**送過來，前端不再自己寫一份。
      //    第一輪自測之前這份清單在前端寫死，與後端那一份是兩件會分岔的
      //    東西；分岔的方向如果是「前端少列了一項」，那一欄就會變成看起來
      //    可以改、一按儲存又被整次拒絕。見 CONTENT_SHEET_READONLY_FIELDS。
      readOnlyFields: {
        week: CONTENT_SHEET_READONLY_FIELDS.WEEK.slice(),
        lists: CONTENT_SHEET_READONLY_FIELDS.LISTS.slice()
      }
    },
    missing: model.missing,
    // F6：頂部徽章與待填清單面板用的分類，由 `splitMissingList_()` 算好。
    // 前端不可以再自己 filter 一次 `optional`——那是第三份分類。
    // G14：另附面板顯示用、人數合併成一行的清單（見 missingSplitForWebApp_()）。
    missingSplit: missingSplitForWebApp_(model.missing),
    warnings: model.warnings,
    options: webAppFieldOptions_(),
    // 第六輪：週報與職事表的比對結果。前端用 `conflictCount` 顯示頂部
    // 的「衝突 N 項」，用 `rows` 展開比對清單。
    rosterDiff: model.rosterDiff,
    // 內容表 v2：季度填寫表已停用，不再送「開啟本季填寫表」的連結（以前的 fillGridUrl）。
    // R-011：七個唯讀區塊上方那一行要用的資料（內容表連結、最後匯入時間）。
    contentSheet: buildContentSheetStatusForWebApp_(model.quarterId),
    // 「重新讀取職事表」按鈕成功之後要顯示的文案；一律算好給前端，
    // 前端只在那個按鈕的情境下使用，一般切換主日時不理會這個欄位。
    rosterReloadMessage: buildRosterReloadMessage_(model.rosterVersionUsed, model.rosterIsOfficial),
    // R-033：這一個主日的草稿預覽連結。取不到網址時是空字串，前端就不顯示
    // 那顆按鈕——一條開不到的連結比不顯示更差。
    previewUrl: buildPreviewUrl_(isoDate),
    // R-036：職事表整季未有資料時頂部要出的黃色橫幅。是空字串就不顯示。
    // 由伺服器算好文案，前端只負責顯示——ROSTER_STATUS 的三個值代表什麼
    // 只應該有一處知道。
    rosterGapBanner: rosterGapBannerForQuarter_(model.quarterId),
    // R-036：「補抓空白的事奉欄位」要知道補哪一季。前端不自己由日期推算季度——
    // 季度的定義只應該有一處知道。
    quarterId: model.quarterId,
    // 這個主日在雲端硬碟的最新 Word（`BulletinWeeks.DOC_ID`）；從未存過是 `null`。
    wordFile: wordFileInfoForWeek_(weekRow, isoDate),
    // v3：發佈／寄出只限該週。前端靠它決定頂部「目前已發佈」那一行、發佈與寄出兩個勾選能不能用；
    //    真正把關在 runPublishFlow_()。
    publishWindow: buildPublishWindowStatus_(isoDate, webAppTodayIso_()),
    // v3：你填的名字與職事表不同的崗位（職事表未排定的不算）。每次載入都講出來，名字一律保留你填的。
    dutyDiffs: buildDutyDiffNotices_(model.rosterDiff),
    // v3：「查看／修改職事表」按鈕的網址（Config ROSTER_WEBAPP_URL）；空字串就不顯示按鈕。
    rosterWebAppUrl: rosterWebAppUrlForButton_()
  };
}

/**
 * 用途：v3：由比對結果挑出「你填的名字與職事表不同」的崗位——有人手覆寫、職事表有名字（未排定的不算，
 *   Ivan：職事表空白就不用提）、而兩個名字不同。純函式。
 *
 *   ⚠️ 與「衝突」（CONFLICT）不同：衝突只算「職事表在你改了之後又改過」。這裏是每次載入都要講的
 *   「現在兩邊不同」，名字一律保留你填的，要改回職事表的名字就按「以職事表覆寫我的修改…」。
 * Args:
 *   rosterDiff {?Object} `buildRosterDiff_()` 的輸出。
 * Returns:
 *   {{postId:string, slotIndex:number, postLabel:string, bulletinName:string, rosterName:string,
 *     conflict:boolean}[]}
 * Raises:
 *   （無）
 */
function buildDutyDiffNotices_(rosterDiff) {
  return ((rosterDiff && rosterDiff.rows) || []).filter(function (r) {
    var roster = String(r.rosterName || '').trim();
    return r.hasOverride === true && roster !== '' && roster !== String(r.bulletinName || '').trim();
  }).map(function (r) {
    return {
      postId: r.postId, slotIndex: r.slotIndex, postLabel: r.postLabel,
      bulletinName: String(r.bulletinName || ''), rosterName: String(r.rosterName || ''),
      conflict: r.status === ROSTER_DIFF_STATUS.CONFLICT
    };
  });
}

/**
 * 用途：v3：「查看／修改職事表」按鈕的網址。只接受 `https://` 開頭的網址，其他（包括留空）一律回空字串
 *   ——一條開不到或者不安全的連結比不顯示更差。
 * Args: （無）
 * Returns:
 *   {string}
 * Raises:
 *   （無）
 */
function rosterWebAppUrlForButton_() {
  var url = String(getConfig(CONFIG_KEYS.ROSTER_WEBAPP_URL, '') || '').trim();
  return /^https:\/\//i.test(url) ? url : '';
}

/**
 * 用途：**R-040**——「下週事奉」改不到的時候，那一句提示寫什麼。
 *   **純函式。**
 *
 *   ⚠️ 「下一季未建立」是**很正常**的狀況（季末最後一個主日必然遇到），
 *   不是錯誤。文案要講得出下一步，而不是報一句紅色的失敗。
 * Args:
 *   model {Object} `buildBulletinModel_()` 的回傳值。
 * Returns:
 *   {string} 可以編輯時回空字串（前端就不顯示提示）。
 */
function buildNextWeekDutyNotice_(model) {
  if ((model.nextWeekDuty || []).length > 0) return '';
  var nextIso = String((model || {}).nextIsoDate || '');
  return '下一個主日（' + (nextIso || '？') + '）尚未在職事表出現，'
    + '多數是因為下一季還沒有生成。這一區暫時改不到——'
    + '等下一季的職事表建立之後，再開這一頁就可以填。'
    + '（週報照樣產生得到，下週事奉那一欄會留白。）';
}

/**
 * 用途：組出七個唯讀區塊上方那一行要用的資料——該季有沒有內容表、
 *   連結、最後匯入時間。
 *
 *   ⚠️ 三種狀態要分得清楚，前端的文案完全不同：
 *     - 該季未建立內容表　→ `exists:false`，介面顯示「本季尚未建立內容表」
 *       並提示去選單建立。
 *     - 已建立、從未匯入　→ `exists:true`、`lastImportedAt:''`，
 *       介面顯示「尚未匯入過」，兩個按鈕照樣可用。
 *     - 已建立、匯入過　　→ 顯示實際時間。
 * Args:
 *   quarterId {?string} `model.quarterId`。
 * Returns:
 *   {{exists:boolean, quarterId:string, fileUrl:string, lastImportedAt:string}}
 */
function buildContentSheetStatusForWebApp_(quarterId) {
  var qid = String(quarterId || '').trim();
  var empty = { exists: false, quarterId: qid, fileUrl: '', lastImportedAt: '' };
  if (!qid) return empty;

  var row;
  try {
    row = findContentSheetRow_(qid);
  } catch (err) {
    // 這一行只是介面上的提示，讀不到不應該令整個載入失敗。
    return empty;
  }
  if (!row) return empty;

  var lastImported = '';
  if (row.LAST_IMPORTED_AT instanceof Date) {
    lastImported = Utilities.formatDate(
      row.LAST_IMPORTED_AT, getConfig(CONFIG_KEYS.SYS_TIMEZONE, 'Pacific/Auckland'), 'yyyy-MM-dd HH:mm'
    );
  }

  // v3：「季度作業」區塊已經由填寫介面拿走，內容表比系統舊時要在狀態列直接出「更新本季內容表…」。
  var schema = contentSheetSchemaStatusCached_(String(row.FILE_ID || ''));
  return {
    exists: true, quarterId: qid,
    fileUrl: String(row.FILE_URL || ''),
    lastImportedAt: lastImported,
    schemaStatus: schema.status,
    schemaMessage: schema.message
  };
}

/** v3：內容表版面狀態的記錄鍵前綴（指令碼屬性，十分鐘，見 src/TimedProperty.gs）。 */
var CONTENT_SHEET_SCHEMA_CACHE_PREFIX_ = 'CS_SCHEMA_V3_';

/**
 * 用途：v3：內容表的版面是不是最新（`checkContentSheetSchema_()`），結果記十分鐘（指令碼屬性）——每次載入一個主日都
 *   開一次內容表太慢。建立／刷新內容表之後由 `forgetContentSheetSchemaStatus_()` 清走記錄。
 *   讀不到（檔案開不到、讀取失敗）一律當作 `'OK'`：這只是介面上的提示，真正把關在匯入
 *   （`previewContentImport_()` 會整次拒絕並講明原因）。
 * Args:
 *   fileId {string} 內容表檔案 ID。
 * Returns:
 *   {{status:string, message:string}} `status`：`'OK'`／`'OUTDATED'`／`'HEADER_CHANGED'`。
 * Raises:
 *   （無）
 */
function contentSheetSchemaStatusCached_(fileId) {
  var id = String(fileId || '').trim();
  var ok = { status: 'OK', message: '' };
  if (!id) return ok;
  var hit = readTimedScriptProperty_(CONTENT_SHEET_SCHEMA_CACHE_PREFIX_ + id, 600);
  if (hit) {
    try { return JSON.parse(hit); } catch (parseErr) { /* 重新檢查 */ }
  }
  var result = ok;
  try {
    var spreadsheet = openContentSpreadsheet_(id);
    if (!spreadsheet) return ok;
    var schema = checkContentSheetSchema_(spreadsheet);
    result = schema.ok ? ok : {
      status: schema.reason === 'CONTENT_SHEET_HEADER_CHANGED' ? 'HEADER_CHANGED' : 'OUTDATED',
      message: String(schema.message || '')
    };
  } catch (err) {
    return ok;
  }
  writeTimedScriptProperty_(CONTENT_SHEET_SCHEMA_CACHE_PREFIX_ + id, JSON.stringify(result));
  return result;
}

/**
 * 用途：v3：清走某一份內容表的版面狀態記錄（建立／刷新之後）。
 * Args:
 *   fileId {string} 內容表檔案 ID。
 * Returns:
 *   {void}
 * Raises:
 *   （無）
 */
function forgetContentSheetSchemaStatus_(fileId) {
  var id = String(fileId || '').trim();
  if (!id) return;
  deleteTimedScriptProperty_(CONTENT_SHEET_SCHEMA_CACHE_PREFIX_ + id);
}

/**
 * 用途：從一張「一個主日多行」的工作表（`Announcements`／`Prayers`／
 *   `Fellowships`／`Finance`），篩出指定主日、`ACTIVE=TRUE` 的行，按
 *   `SEQ_NO` 排序，只挑出呼叫方要的欄位（加上 `seqNo`）。
 * Args:
 *   rows {Object[]} `readSheet()` 的輸出。
 *   isoDate {string} 主日日期，yyyy-MM-dd。
 *   fieldKeys {string[]} 要挑出的機器鍵（例如 `['TEXT']`）。
 * Returns:
 *   {Object[]} 每個元素形狀 `{ seqNo, <fieldKeys...> }`；`isoDate` 格式不對
 *     時回空陣列。
 */
function pickWebAppListItems_(rows, isoDate, fieldKeys) {
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(isoDate || ''));
  if (!m) return [];
  var y = Number(m[1]);
  var mo = Number(m[2]);
  var d = Number(m[3]);

  return (rows || [])
    .filter(function (r) { return r.ACTIVE === true && rosterDateMatchesYMD_(r.SERVICE_DATE, y, mo, d); })
    .slice()
    .sort(function (a, b) { return (a.SEQ_NO || 0) - (b.SEQ_NO || 0); })
    .map(function (r) {
      var item = { seqNo: r.SEQ_NO };
      fieldKeys.forEach(function (key) {
        var v = r[key];
        item[key] = (v === null || v === undefined) ? '' : v;
      });
      return item;
    });
}

/**
 * 用途：組出可編輯欄位需要的各種下拉選項（程序範本 ID、誦讀覆寫、代禱
 *   標題建議值），一律來自 Config／`ProgramTemplates`，不寫死。
 * Args: （無）
 * Returns:
 *   {{programTemplateIds:string[], recitationOptions:string[],
 *     prayerBlockHeadingOptions:string[], cantoneseSubColumnLabel:string}}
 *     `recitationOptions` 第一項固定是空字串（代表「留空＝自動」）。
 */
function webAppFieldOptions_() {
  return {
    programTemplateIds: uniqueProgramTemplateIds_(readSheet(SHEETS.PROGRAM_TEMPLATES)),
    recitationOptions: webAppRecitationOptions_(),
    prayerBlockHeadingOptions: getConfigTextList_(
      CONFIG_KEYS.PRAYER_BLOCK_HEADING_OPTIONS, '代禱事項,宣教消息,宣教代禱消息,宣教代禱事項'
    ),
    cantoneseSubColumnLabel: getConfig(CONFIG_KEYS.CANTONESE_SUBCOLUMN_LABEL, '主堂')
  };
}

/**
 * 用途：把 `ProgramTemplates` 啟用中的資料列去重出 `TEMPLATE_ID` 清單，
 *   保留第一次出現的次序。
 * Args:
 *   templateRows {Object[]} `readSheet(SHEETS.PROGRAM_TEMPLATES)` 的輸出。
 * Returns:
 *   {string[]}
 */
function uniqueProgramTemplateIds_(templateRows) {
  var seen = {};
  var ids = [];
  (templateRows || []).forEach(function (r) {
    if (r.ACTIVE !== true) return;
    if (seen[r.TEMPLATE_ID]) return;
    seen[r.TEMPLATE_ID] = true;
    ids.push(r.TEMPLATE_ID);
  });
  return ids;
}

/**
 * 用途：組出「誦讀（覆寫）」下拉的選項——留空（自動）＋ Config 三個誦讀
 *   內容鍵目前的值（去重）。選項內容完全來自 Config，不寫死。
 * Args: （無）
 * Returns:
 *   {string[]} 第一項固定是空字串。
 */
function webAppRecitationOptions_() {
  var raw = [
    getConfig(CONFIG_KEYS.RECITATION_JAN_APR, '使徒信經'),
    getConfig(CONFIG_KEYS.RECITATION_MAY_AUG, '十誡'),
    getConfig(CONFIG_KEYS.RECITATION_SEP_DEC, '主禱文')
  ];
  var seen = {};
  var options = [''];
  raw.forEach(function (v) {
    var t = String(v || '').trim();
    if (!t || seen[t]) return;
    seen[t] = true;
    options.push(t);
  });
  return options;
}

/**
 * 用途：組出「重新讀取職事表」按鈕完成後要顯示的訊息。純函式，前端沒有
 *   Node 測試，文案分支放在這裡才測得到，前端直接顯示、不用自己砌字串。
 * Args:
 *   versionNo {?number} 職事表版本號，`readRosterSnapshot_()` 的
 *     `versionNo`；該季尚未生成職事表版本時是 `null`。
 *   isOfficial {boolean} 職事表是否已正式發出。
 * Returns:
 *   {{type:'info', text:string}}
 */
function buildRosterReloadMessage_(versionNo, isOfficial) {
  if (versionNo === null || versionNo === undefined) {
    return { type: 'info', text: '已重新讀取職事表（該季尚未生成職事表）。' };
  }
  return {
    type: 'info',
    text: '已重新讀取職事表（版本 ' + versionNo + '，' + (isOfficial ? '已正式發出' : '尚未正式發出') + '）。'
  };
}

// =====================================================================
// apiPreviewProgram 的實作
// =====================================================================

/**
 * 用途：`apiPreviewProgram()` 的 IO 層。用工作表現有的週資料列為底，疊上
 *   前端傳來的草稿欄位值，重算一次程序表——完全不寫入任何工作表。
 * Args:
 *   isoDate {string} 主日日期，yyyy-MM-dd。
 *   draftFields {Object} 草稿欄位值（`BulletinWeeks` 機器鍵 → 值）。
 * Returns:
 *   {{templateId:string, rows:Object[]}}
 */
function previewProgramForWebApp_(isoDate, draftFields) {
  var snapshot = readRosterSnapshot_(isoDate);
  var weekRows = readSheet(SHEETS.BULLETIN_WEEKS);
  var weekRow = findBulletinWeekRow_(weekRows, isoDate) || {};
  var draftWeek = Object.assign({}, weekRow, draftFields || {});
  // 內容表 v2（審查 C5）：序樂留空時與 Word、電郵一樣印 Config PRELUDE_DEFAULT（同一支 applyPreludeDefault_()，
  //    見 buildBulletinModel_()），否則填寫介面的程序預覽與印出來的不一樣。
  draftWeek = applyPreludeDefault_(draftWeek, getConfig(CONFIG_KEYS.PRELUDE_DEFAULT, ''));
  var program = buildProgramTable_(draftWeek, snapshot);
  return {
    templateId: program.templateId, rows: program.rows,
    // v3：草稿的程序增刪／換範本之後，介面要重畫那張可以拿走、加項的表。
    displayRows: program.displayRows || [], editWarnings: program.editWarnings || []
  };
}

// =====================================================================
// 由職事表重新取數
// =====================================================================

/**
 * 用途：`apiGetRosterFetchCandidates()` 的 IO 層。唯讀。
 * Args:
 *   isoDate {string} 主日日期，yyyy-MM-dd。
 * Returns:
 *   {{rows:Object[], rosterVersion:(number|null)}}
 */
function getRosterFetchCandidates_(isoDate) {
  var diff = computeRosterDiff_(isoDate);
  // v3：「以職事表覆寫我的修改」——列出你改過、而職事表有名字（未排定的不改）又與你填的不同的格，
  //    預設全部勾選。職事表未排定的格保留你填的（Ivan：職事表空白就不覆寫）。
  var rows = buildDutyDiffNotices_(diff).map(function (d) {
    var row = diff.rows.filter(function (r) { return r.postId === d.postId && r.slotIndex === d.slotIndex; })[0];
    return Object.assign({}, row, { defaultChecked: true });
  });
  return { rows: rows, rosterVersion: diff.rosterVersion };
}

/**
 * 用途：`apiFetchFromRoster()` 的 IO 層。把勾選的欄位改回跟隨職事表：
 *   那些格子生效中的 `DutyOverride` 改成 `ACTIVE=FALSE`，並逐格記一筆
 *   `AuditLog`（`ACTION` 用 `FETCH_FROM_ROSTER`）。
 *
 *   ⚠️ **不刪行**——`DutyOverride` 的記錄永遠保留，只是不再生效。日後
 *   要追「這一格曾經被誰、什麼時候、改成什麼」仍然查得到。
 *
 *   ⚠️ 第二批測試修正 G28：真的停用了覆寫就更新這一週的 `LAST_SAVED_AT`（與儲存、還原、
 *   重設一致）。以前不更新：另一個較早載入的分頁之後按「儲存」，送上來的事奉框仍然是舊的
 *   覆寫名字（前端每次儲存都送全部格），樂觀鎖照樣通過，`computeDutyOverridePlan_()` 就把
 *   剛停用的同名覆寫重新啟用。更新之後那個分頁會收到 STALE。D9 之後前端只送改過的格，沒有改那一格的
 *   舊分頁不會令覆寫復活；但它若改了同一格仍然是照舊畫面做決定，所以照舊更新（不為簡化而拿走）。
 * Args:
 *   isoDate {string} 主日日期，yyyy-MM-dd。
 *   selections {{postId:string, slotIndex:number}[]} 使用者勾選的欄位。
 * Returns:
 *   {{clearedCount:number, message:{type:string,text:string}}}
 * Raises:
 *   Error 如果 `DutyOverride` 工作表不存在；Error（`code:'LOCK_TIMEOUT'`）如果 30 秒內拿不到
 *     指令碼鎖（D13，一格都沒有寫）。
 */
function fetchFromRosterForWebApp_(isoDate, selections) {
  var picked = selections || [];
  if (picked.length === 0) {
    return { clearedCount: 0, message: { type: 'info', text: '沒有勾選任何欄位，沒有做任何改動。' } };
  }
  // D13：由讀取覆寫到停用、更新 LAST_SAVED_AT，全部在指令碼鎖之內（與儲存同一把、同一個等候時間）。
  // 以前沒有拿鎖，與另一個分頁同一刻的儲存或重設有機會互相穿插。拿不到鎖就一格都不寫。
  return withScriptLock_('apiFetchFromRoster', SAVE_LOCK_WAIT_MS_, function () {
    return fetchFromRosterLocked_(isoDate, picked);
  }, function () {
    throw buildLockTimeoutError_(SAVE_LOCK_WAIT_MS_, '請稍等再按一次「以職事表覆寫我的修改…」。');
  });
}

/**
 * 用途：D13：`fetchFromRosterForWebApp_()` 拿到指令碼鎖之後的那一段——讀這一週的覆寫、停用勾選的格、
 *   記 AuditLog、更新 LAST_SAVED_AT。只可以由 `fetchFromRosterForWebApp_()` 呼叫。
 * Args:
 *   isoDate {string} 主日日期，yyyy-MM-dd。
 *   picked {{postId:string, slotIndex:number}[]} 使用者勾選的欄位（至少一項）。
 * Returns:
 *   {{clearedCount:number, message:{type:string,text:string}}} 同 `fetchFromRosterForWebApp_()`。
 * Raises:
 *   Error 如果 `DutyOverride` 工作表不存在。
 */
function fetchFromRosterLocked_(isoDate, picked) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.DUTY_OVERRIDE);
  if (!sheet) {
    throw new Error('fetchFromRosterForWebApp_：找不到工作表「' + SHEETS.DUTY_OVERRIDE + '」，請先執行「初始化工作表」。');
  }
  var def = COLUMNS.DUTY_OVERRIDE;
  var activeCol = def.keys.indexOf('ACTIVE') + 1;

  var existingByKey = {};
  readDutyOverrideRowsWithRowNo_(isoDate).forEach(function (row) {
    var key = dutyOverrideKey_(row.POST_ID, row.SLOT_INDEX);
    if (!(key in existingByKey)) existingByKey[key] = row;
  });

  var cleared = 0;
  var snapshotWarnings = [];
  var snapshotTaken = false;
  picked.forEach(function (sel) {
    var key = dutyOverrideKey_(sel.postId, sel.slotIndex);
    var existing = existingByKey[key];
    if (!existing || existing.ACTIVE !== true) return;

    // 第二批階段 2：第一次真的要停用之前存一個版本（只存一次）。
    if (!snapshotTaken) {
      snapshotTaken = true;
      snapshotWarnings = snapshotWeeksBeforeWrite_([isoDate], 'ROSTER_FETCH');
    }
    sheet.getRange(existing.__rowNo, activeCol).setValue(false);
    appendAuditLog_({
      action: 'FETCH_FROM_ROSTER',
      sheetName: SHEETS.DUTY_OVERRIDE,
      rowKey: isoDate + '#' + sel.postId + '#' + (sel.slotIndex === undefined ? 1 : sel.slotIndex),
      field: 'ACTIVE',
      oldValue: 'TRUE',
      newValue: 'FALSE',
      notes: '以職事表覆寫：人手覆寫「' + String(existing.OVERRIDE_NAME || '') + '」已取消，改回跟隨職事表。記錄保留，不刪行。'
    });
    cleared++;
  });

  // G28：真的停用了才更新；一格都沒有停用就不動（與儲存的 F2 同一個道理）。G28 補充：
  // 上一週的「下週事奉」亦顯示這些名字，一併更新（見 weeksShowingDuty_()）。
  if (cleared > 0) touchWeeksLastSavedAt_(weeksShowingDuty_([isoDate]), new Date());

  return {
    clearedCount: cleared,
    message: appendSnapshotWarnings_({
      type: cleared > 0 ? 'success' : 'info',
      text: cleared > 0
        ? '已把 ' + cleared + ' 個欄位改回跟隨職事表；你原本的修改已清除（記錄仍然保留）。'
        : '勾選的欄位目前沒有生效中的人手覆寫，沒有做任何改動。'
    }, snapshotWarnings)
  };
}

// =====================================================================
// 選單：開啟填寫介面
// =====================================================================

/**
 * 用途：選單項目「開啟填寫介面」的處理函式。`WEBAPP_URL` 有值就用對話框
 *   顯示可點擊的連結；留空就講解部署步驟。
 * Args: （無）
 * Returns:
 *   {void}
 */
function menuOpenWebApp_() {
  var ui = SpreadsheetApp.getUi();
  try {
    var url = getConfig(CONFIG_KEYS.WEBAPP_URL, '');

    if (url) {
      var html = HtmlService.createHtmlOutput(
        '<div style="font-family:sans-serif;padding:1em;line-height:1.6;">'
        + '<p>填寫介面網址：</p>'
        + '<p><a href="' + escapeHtml_(url) + '" target="_blank" rel="noopener">' + escapeHtml_(url) + '</a></p>'
        + '</div>'
      ).setWidth(440).setHeight(160);
      ui.showModalDialog(html, '開啟填寫介面');
      return;
    }

    ui.alert(
      '尚未部署填寫介面',
      [
        '請先部署本專案的 Web App，步驟：',
        '1. Script Editor ▸ 部署 ▸ 新增部署作業',
        '2. 類型選「網頁應用程式」',
        '3. 執行身分選「我」',
        '4. 存取權選「網域內的使用者」',
        '5. 按「部署」，複製產生的網址',
        '6. 把網址貼進 Config 的 WEBAPP_URL 這一格',
        '',
        '完成後重新點選這個選單項目即可看到連結。'
      ].join('\n'),
      ui.ButtonSet.OK
    );
  } catch (err) {
    logMenuError_('menuOpenWebApp_', err);
    ui.alert('開啟填寫介面失敗', enrichAuthError_(err), ui.ButtonSet.OK);
  }
}

/**
 * 用途：選單項目「檢查工作表結構」的處理函式。呼叫 `checkSheetSchema_()`，
 *   用對話框顯示結果；有落差時明確講「請撳『初始化工作表』」。
 * Args: （無）
 * Returns:
 *   {void}
 */
function menuCheckSheetSchema_() {
  var ui = SpreadsheetApp.getUi();
  try {
    var result = checkSheetSchema_();
    if (result.ok) {
      ui.alert('檢查工作表結構', '工作表結構與程式碼一致，沒有發現落差。', ui.ButtonSet.OK);
      return;
    }
    ui.alert(
      '檢查工作表結構：發現落差',
      buildSchemaMismatchSummary_(result) + '\n\n請按「初始化工作表」補齊。',
      ui.ButtonSet.OK
    );
  } catch (err) {
    logMenuError_('menuCheckSheetSchema_', err);
    ui.alert('檢查工作表結構失敗', enrichAuthError_(err), ui.ButtonSet.OK);
  }
}
