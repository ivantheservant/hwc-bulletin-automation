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
  if (!isWebAppEnabled_()) {
    return HtmlService.createHtmlOutput(renderWebAppMessagePage_(
      '填寫介面目前已關閉',
      ['管理者已經在 Config 把 WEBAPP_ENABLED 設為 FALSE。', '要重新啟用，請在 Config 把 WEBAPP_ENABLED 改回 TRUE。']
    ));
  }
  if (!isCallerAuthorized_()) {
    return HtmlService.createHtmlOutput(renderWebAppMessagePage_(
      '沒有使用權限',
      ['您目前沒有權限使用本填寫介面。', '請聯絡管理者，在 Config 的 WEBAPP_ALLOWED_EMAILS 加入您的電郵（逗號分隔）。']
    ));
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
 * Args:
 *   callerEmail {string} 呼叫者的電郵。
 *   allowedEmailsList {string[]} `WEBAPP_ALLOWED_EMAILS` 解析後的清單。
 *   effectiveEmail {string} 部署者（`Session.getEffectiveUser()`）的電郵。
 * Returns:
 *   {boolean} 名單非空時，呼叫者要在名單內（不分大小寫）；名單空白時，
 *     只有呼叫者等於 `effectiveEmail` 才通過。`callerEmail` 空白一律回 false。
 */
function isEmailAuthorized_(callerEmail, allowedEmailsList, effectiveEmail) {
  var caller = String(callerEmail || '').trim().toLowerCase();
  if (!caller) return false;

  var allowed = (allowedEmailsList || [])
    .map(function (e) { return String(e || '').trim().toLowerCase(); })
    .filter(function (e) { return e.length > 0; });

  if (allowed.length > 0) {
    return allowed.indexOf(caller) !== -1;
  }

  var effective = String(effectiveEmail || '').trim().toLowerCase();
  return Boolean(effective) && caller === effective;
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
 * 用途：把一個會拋錯的函式包成統一的 `{ ok, data?, error? }` 形狀，並在
 *   執行前檢查呼叫者權限。全部 `api*` 函式都經由這個函式呼叫底層邏輯。
 *
 *   ⚠️ **例外發生時，先寫一筆 `ErrorLog`（`SOURCE='SERVER'`）才回傳
 *   `{ok:false,...}`**——Apps Script 的執行紀錄只看得到「這次呼叫完成」，
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
    appendErrorLog_({
      source: ERROR_LOG_SOURCE.SERVER,
      functionName: (context && context.functionName) || '',
      errorCode: errorCode,
      message: message,
      detail: buildErrorDetail_(err, context)
    });
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
function apiListWeeks() {
  return withApiResult_(function () { return listWeeksForWebApp_(); }, { functionName: 'apiListWeeks' });
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

  var dryRun = normalizeBoolean_(getConfig(CONFIG_KEYS.DRY_RUN, 'TRUE')) === true;
  return {
    ok: true,
    scope: result.scope,
    summary: {
      added: result.plan.added, updated: result.plan.updated,
      removed: result.plan.removed, unchanged: result.plan.unchanged
    },
    lines: buildContentImportDialogLines_(result, { dryRun: dryRun, applied: Boolean(apply) })
  };
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
 *   {{ok:boolean, data:{lastSavedAt:string, changedFieldCount:number, message:{type:string,text:string}}, error?:Object}}
 *     樂觀鎖沒對上時 `error.code` 是 `'STALE'`；工作表結構落後於程式碼時
 *     `error.code` 是 `'SCHEMA_OUTDATED'`（見 `checkSheetSchema_()`），
 *     兩種情況都**不會執行任何寫入**。
 */
function apiSaveWeek(payload) {
  return withApiResult_(function () {
    var schema = checkSheetSchema_();
    if (!schema.ok) {
      var err = new Error(
        '工作表結構落後於程式碼（' + buildSchemaMismatchSummary_(schema)
        + '），請先在試算表撳「週報系統 ▸ 初始化工作表」。寧可拒絕儲存，也不要寫壞資料。'
      );
      err.code = 'SCHEMA_OUTDATED';
      throw err;
    }
    return saveWeekFromWebApp_(payload);
  }, { functionName: 'apiSaveWeek', argsSummary: 'isoDate=' + (payload && payload.isoDate) });
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
 * Returns:
 *   {{ok:boolean, data:{fileName:string, base64:string, warnings:Object[]},
 *     error?:Object}}
 */
function apiDownloadBulletinDocx(isoDate) {
  return withApiResult_(function () { return bulletinDocxForDownload_(isoDate); },
    { functionName: 'apiDownloadBulletinDocx', argsSummary: 'isoDate=' + isoDate });
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
 * Returns:
 *   {{doPublish:boolean, doSend:boolean, groups:string[]}}
 */
function loadPublishPrefs_(defaultGroups) {
  var fallback = { doPublish: true, doSend: false, groups: (defaultGroups || []).slice() };
  try {
    var raw = PropertiesService.getUserProperties().getProperty(PUBLISH_PREFS_KEY_);
    if (!raw) return fallback;
    var parsed = JSON.parse(raw);
    return {
      doPublish: parsed.doPublish === true,
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
 * 用途：`apiDownloadBulletinDocx()` 的 IO 層——產生 Word 檔並轉成 base64。
 * Args:
 *   isoDate {string} 主日日期，yyyy-MM-dd。
 * Returns:
 *   {{fileName:string, base64:string, warnings:Object[]}}
 * Raises:
 *   Error 如果職事表未設定、範本未設定，或者渲染失敗——訊息一律沿用
 *     `generateBulletinDocx_()` 已經組好那一句，不在這裏另寫。
 */
function bulletinDocxForDownload_(isoDate) {
  var result = generateBulletinDocx_(isoDate);
  if (!result.ok) {
    var err = new Error(result.message || '未能產生 Word 檔。');
    err.code = result.reason || 'RENDER_FAILED';
    throw err;
  }
  return {
    fileName: result.fileName,
    base64: Utilities.base64Encode(result.blob.getBytes()),
    warnings: result.warnings || []
  };
}

/**
 * 用途：`apiListWeeks()` 的 IO 層——讀 `BulletinWeeks`，交給純函式層組出
 *   下拉選項與預設選中的日期。
 * Args: （無）
 * Returns:
 *   {{weeks:Object[], defaultIsoDate:(string|null)}}
 */
function listWeeksForWebApp_() {
  var rows = readSheet(SHEETS.BULLETIN_WEEKS);
  var todayIso = formatIsoDate_(new Date());
  var entries = buildWeekListEntries_(rows, todayIso);
  return {
    weeks: entries,
    defaultIsoDate: pickDefaultWeekIsoDate_(entries, todayIso)
  };
}

/**
 * 用途：把 `BulletinWeeks` 資料列組成下拉選單用的清單：`STATUS` 不是
 *   `SENT` 的排前面，組內按日期由小到大排序。純函式，方便獨立測試。
 * Args:
 *   rows {Object[]} `readSheet(SHEETS.BULLETIN_WEEKS)` 的輸出。
 *   todayIso {string} 今天的日期，yyyy-MM-dd（只用來讓呼叫方之後挑預設值，
 *     這個函式本身不使用）。
 * Returns:
 *   {{isoDate:string, weekOfMonth:(number|null), status:string, label:string}[]}
 *     `SERVICE_DATE` 不是合法 Date 的行會被略過（代表資料本身有問題，
 *     不應該讓整個下拉清單壞掉）。
 */
function buildWeekListEntries_(rows, todayIso) {
  return (rows || [])
    .filter(function (r) { return r.SERVICE_DATE instanceof Date; })
    .map(function (r) {
      var isoDate = formatIsoDate_(r.SERVICE_DATE);
      var weekOfMonth = (r.WEEK_OF_MONTH === null || r.WEEK_OF_MONTH === undefined) ? null : r.WEEK_OF_MONTH;
      return {
        isoDate: isoDate,
        weekOfMonth: weekOfMonth,
        status: r.STATUS || '',
        label: isoDate + '（週次 ' + (weekOfMonth === null ? '?' : weekOfMonth) + '）'
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
 * 用途：從下拉清單挑出預設選中的日期：今天之後最近的一個主日；沒有
 *   （全部都是過去）就選清單第一個。純函式。
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
 *        warnings:Object[], options:Object, rosterReloadMessage:Object }`
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

  return {
    isoDate: isoDate,
    week: week,
    lists: {
      announcements: pickWebAppListItems_(readSheet(SHEETS.ANNOUNCEMENTS), isoDate, ['TEXT']),
      prayers: pickWebAppListItems_(readSheet(SHEETS.PRAYERS), isoDate, ['TEXT']),
      fellowships: pickWebAppListItems_(readSheet(SHEETS.FELLOWSHIPS), isoDate,
        ['FELLOWSHIP_NAME', 'MEETING_DATE', 'MEETING_TIME', 'CONTENT']),
      finance: pickWebAppListItems_(readSheet(SHEETS.FINANCE), isoDate,
        ['ROW_LABEL', 'COL_SPECIAL_OVERSEAS', 'COL_HARDSHIP'])
    },
    lastSavedAt: canonicalSaveToken_(weekRow.LAST_SAVED_AT),
    readOnly: {
      dutyBoxPage1: model.dutyBoxPage1,
      nextWeekDuty: model.nextWeekDuty,
      special: model.special,
      templateId: model.templateId,
      // 前端靠這個旗標決定要不要顯示「浸禮合堂副框」那一段。刻意由伺服器
      // 算好（`isBaptismTemplateId_()`），不讓前端自己拿 templateId 去跟
      // 字面值比——那樣範本 ID 一改就會有一處漏改。
      isBaptismSunday: model.isBaptismSunday === true,
      rosterVersionUsed: model.rosterVersionUsed,
      rosterIsOfficial: model.rosterIsOfficial,
      program: model.program,
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
    warnings: model.warnings,
    options: webAppFieldOptions_(),
    // 第六輪：週報與職事表的比對結果。前端用 `conflictCount` 顯示頂部
    // 的「衝突 N 項」，用 `rows` 展開比對清單。
    rosterDiff: model.rosterDiff,
    // 第八輪：直達本季季度填寫表的連結。格子表未建立時是空字串，
    // 前端就不顯示那個按鈕——顯示一條開不到的連結比不顯示更差。
    fillGridUrl: buildFillGridUrlForWebApp_(model.quarterId),
    // R-011：七個唯讀區塊上方那一行要用的資料（內容表連結、最後匯入時間）。
    contentSheet: buildContentSheetStatusForWebApp_(model.quarterId),
    // 「重新讀取職事表」按鈕成功之後要顯示的文案；一律算好給前端，
    // 前端只在那個按鈕的情境下使用，一般切換主日時不理會這個欄位。
    rosterReloadMessage: buildRosterReloadMessage_(model.rosterVersionUsed, model.rosterIsOfficial)
  };
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

  return {
    exists: true, quarterId: qid,
    fileUrl: String(row.FILE_URL || ''),
    lastImportedAt: lastImported
  };
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
  var program = buildProgramTable_(draftWeek, snapshot);
  return { templateId: program.templateId, rows: program.rows };
}

/**
 * 用途：組出直達本季季度填寫表的網址，給填寫介面頂部那個按鈕用。
 *
 *   ⚠️ 格子表**未建立**時回空字串，前端就不顯示那個按鈕——顯示一條開
 *   不到的連結，比不顯示更差（使用者會以為系統壞了）。
 * Args:
 *   quarterId {?string} 這一週所屬的季度。
 * Returns:
 *   {string} 找不到季度或格子表時回空字串。
 */
function buildFillGridUrlForWebApp_(quarterId) {
  if (!quarterId) return '';
  var sheetName = fillGridSheetName_(quarterId);
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss.getSheetByName(sheetName)) return '';
  return buildSheetDeepLink_(sheetName);
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
  var rows = diff.rows
    .filter(function (r) {
      return r.status === ROSTER_DIFF_STATUS.CONFLICT || r.status === ROSTER_DIFF_STATUS.OVERRIDDEN;
    })
    .map(function (r) {
      return Object.assign({}, r, { defaultChecked: r.status === ROSTER_DIFF_STATUS.CONFLICT });
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
 * Args:
 *   isoDate {string} 主日日期，yyyy-MM-dd。
 *   selections {{postId:string, slotIndex:number}[]} 使用者勾選的欄位。
 * Returns:
 *   {{clearedCount:number, message:{type:string,text:string}}}
 */
function fetchFromRosterForWebApp_(isoDate, selections) {
  var picked = selections || [];
  if (picked.length === 0) {
    return { clearedCount: 0, message: { type: 'info', text: '沒有勾選任何欄位，沒有做任何改動。' } };
  }

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
  picked.forEach(function (sel) {
    var key = dutyOverrideKey_(sel.postId, sel.slotIndex);
    var existing = existingByKey[key];
    if (!existing || existing.ACTIVE !== true) return;

    sheet.getRange(existing.__rowNo, activeCol).setValue(false);
    appendAuditLog_({
      action: 'FETCH_FROM_ROSTER',
      sheetName: SHEETS.DUTY_OVERRIDE,
      rowKey: isoDate + '#' + sel.postId + '#' + (sel.slotIndex === undefined ? 1 : sel.slotIndex),
      field: 'ACTIVE',
      oldValue: 'TRUE',
      newValue: 'FALSE',
      notes: '由職事表重新取數：人手覆寫「' + String(existing.OVERRIDE_NAME || '') + '」已取消，改回跟隨職事表。記錄保留，不刪行。'
    });
    cleared++;
  });

  return {
    clearedCount: cleared,
    message: {
      type: cleared > 0 ? 'success' : 'info',
      text: cleared > 0
        ? '已把 ' + cleared + ' 個欄位改回跟隨職事表；你原本的修改已清除（記錄仍然保留）。'
        : '勾選的欄位目前沒有生效中的人手覆寫，沒有做任何改動。'
    }
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
      buildSchemaMismatchSummary_(result) + '\n\n請撳「初始化工作表」補齊。',
      ui.ButtonSet.OK
    );
  } catch (err) {
    logMenuError_('menuCheckSheetSchema_', err);
    ui.alert('檢查工作表結構失敗', enrichAuthError_(err), ui.ButtonSet.OK);
  }
}
