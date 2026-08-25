/**
 * DriveShared.gs
 *
 * Drive **進階服務**（`Drive.Files.*`）嘅唯一呼叫點。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ⚠️ 存在理由：Shared Drive ＋ `supportsAllDrives`
 * ─────────────────────────────────────────────────────────────────────
 *
 *   本系統全部檔案都喺 **Shared Drive**（共用雲端硬碟）。Drive 進階服務
 *   **預設淨係睇「我的雲端硬碟」**——對住一個明明存在嘅 Shared Drive
 *   檔案，唔加參數就會回一句
 *
 *       File not found: <fileId>
 *
 *   即係 404。呢個訊息最要命嘅地方係佢**講咗一句假話**：檔案明明喺度，
 *   權限都啱，只係你冇話畀 Drive 知「請埋共用雲端硬碟一齊搵」。
 *
 *   每一個 `Drive.Files.*` 呼叫都**一定**要帶 `supportsAllDrives: true`；
 *   列檔案／搜檔案嗰啲仲要多帶一個 `includeItemsFromAllDrives: true`
 *   （前者係「我識得處理共用雲端硬碟嘅檔案」，後者係「結果入面請包埋
 *   共用雲端硬碟嘅項目」，兩者缺一不可）。
 *
 *   ⚠️ **所以呢個檔案要獨佔全部 `Drive.` 呼叫。** 每個地方自己寫一次
 *   選項物件，就等於每個地方都有一次寫漏嘅機會，而寫漏嘅後果係一個
 *   「檔案不存在」嘅假訊息。`tools/lint-drive-shared.js` 會靜態掃描
 *   `src/`，任何 `Drive.Files.`／`Drive.Drives.` 呼叫嘅同一個語句內冇
 *   `supportsAllDrives` 就報錯。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ⚠️ 呢個檔案受 `tools/lint-readonly-roster.js` 特別管制
 * ─────────────────────────────────────────────────────────────────────
 *
 *   同 `DocxIo.gs`／`ContentSheetIo.gs`／`PublishIo.gs` 一樣：准用 Drive，
 *   但**一個格都唔准出現 `ROSTER_SPREADSHEET_ID`**。Drive 理論上開得到
 *   任何檔案，包括職事表本身；靜態上證明唔到某個執行期變數唔係職事表
 *   ID，但證明得到「呢個檔案由頭到尾拎唔到職事表 ID 呢個設定鍵」。
 *
 *   亦即係話：**唔好喺呢度加任何業務邏輯**。呢度淨係「包一層、補參數」。
 */

'use strict';

/**
 * 用途：全部 `Drive.Files.*` 呼叫共用嘅選項。**單一真相來源。**
 *
 *   ⚠️ 唔好喺呼叫點自己寫 `{ supportsAllDrives: true }`——寫得越多次，
 *   寫漏嘅機會越大，而寫漏嘅表現係一句「檔案不存在」，唔會有人估到
 *   真正原因係少咗一個參數。
 * Args:
 *   extra {Object=} 額外選項，會併喺共用選項之上。
 * Returns:
 *   {Object}
 */
function driveSharedOptions_(extra) {
  var options = { supportsAllDrives: true };
  Object.keys(extra || {}).forEach(function (k) { options[k] = extra[k]; });
  return options;
}

/**
 * 用途：原地覆寫一個檔案嘅內容（檔案 ID 唔變），可以順手改檔名。
 *
 *   ⚠️ `DriveApp` 嘅 `setContent()` 只處理得到文字，餵二進位落去會寫出
 *   一個開得開但係壞嘅檔案。原地覆寫二進位內容只有呢一條路。
 * Args:
 *   fileId {string} 檔案 ID。
 *   blob {Blob} 新內容。
 *   fileName {string=} 選填；有值就一併把檔名設成佢。
 * Returns:
 *   {{fileId:string}} 回傳嘅 ID 一定同傳入嗰個一樣。
 * Raises:
 *   Error 進階服務未啟用（`ReferenceError`）、冇權限、檔案搵唔到——
 *     一律原樣拋出，由呼叫方分類成人睇得明嘅訊息。
 */
function driveUpdateFileContent_(fileId, blob, fileName) {
  var id = String(fileId || '').trim();
  var resource = {};
  var name = String(fileName || '');
  // ⚠️ Drive 進階服務在 appsscript.json 釘死在 **v3**，v3 的檔名欄位叫
  //    `name`（v2 才叫 `title`）。原本這裡寫 `title` 而註解寫「釘死在 v2」
  //    ——註解與 appsscript.json 對不上，而 v3 會靜靜忽略 `title`，於是
  //    「順手改檔名」那一步一直沒有生效（內容照樣覆寫得到，所以沒有人
  //    發現）。見 docs/已知bug類型.md 事故三十七。
  // ⚠️ 用中括號存取而不是點存取：夾在引號之間的 `.name` 會被
  //    tools/scan-staged-secrets.js 誤判成網域（name 是真實 gTLD），
  //    見 docs/已知bug類型.md 事故六。欄位名照樣是 v3 的 name。
  if (name) resource['name'] = name;

  var updated = Drive.Files.update(resource, id, blob, driveSharedOptions_());
  return { fileId: (updated && updated.id) ? updated.id : id };
}

/**
 * 用途：探測 Drive **進階服務**有冇啟用。
 *
 *   ⚠️ 未啟用時 `Drive` 呢個名根本唔存在，會拋 `ReferenceError`。呢個
 *   同「檔案搵唔到」係**兩件完全唔同嘅事**，處理方法亦完全唔同（一個要
 *   去 Apps Script 編輯器撳一次，一個要重新建立檔案），所以一定要分得出。
 * Args: （無）
 * Returns:
 *   {boolean}
 */
function driveAdvancedServiceAvailable_() {
  try {
    return typeof Drive !== 'undefined' && Boolean(Drive.Files);
  } catch (err) {
    return false;
  }
}

/**
 * 用途：讀一個檔案嘅 metadata（用嚟確認檔案存唔存在、叫咩名）。
 * Args:
 *   fileId {string} 檔案 ID。
 * Returns:
 *   {?Object} 開唔到回 `null`，**唔拋錯**——呼叫方要分得出「未建立過」
 *     同「建立過但而家開唔到」。
 */
function driveGetFileMetadata_(fileId) {
  var id = String(fileId || '').trim();
  if (!id) return null;
  try {
    return Drive.Files.get(id, driveSharedOptions_());
  } catch (err) {
    return null;
  }
}

/**
 * 用途：喺指定資料夾內，查有冇某個檔名嘅檔案（唔理已刪除嘅）。
 *
 *   ⚠️ 刻意唔用 `DriveApp` 嘅 `Folder.getFilesByName()`／
 *   `DriveApp.searchFiles()`：後者**預設唔搜共用雲端硬碟**，喺 Shared
 *   Drive 上會一律回「搵唔到」，於是「檔名有冇撞」永遠答「冇撞」，
 *   結果就係靜靜覆蓋。
 * Args:
 *   folderId {string} 資料夾 ID。
 *   fileName {string} 要查嘅檔名（完整比對）。
 * Returns:
 *   {number} 同名檔案數目；查唔到（權限、服務未啟用）一律回 `-1`。
 *     ⚠️ `-1` 同 `0` **唔可以**混為一談：`0` 係「查過，冇同名」，
 *     `-1` 係「查唔到」，呼叫方要當作「唔敢肯定，用最保守嘅做法」。
 */
function driveCountFilesByNameInFolder_(folderId, fileName) {
  var folder = String(folderId || '').trim();
  var name = String(fileName || '');
  if (!folder || !name) return -1;

  try {
    var escaped = name.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    var result = Drive.Files.list(driveSharedOptions_({
      // ⚠️ 兩個選項缺一不可：`supportsAllDrives` 係「我識得處理共用
      // 雲端硬碟嘅檔案」，`includeItemsFromAllDrives` 係「結果入面請
      // 包埋共用雲端硬碟嘅項目」。
      includeItemsFromAllDrives: true,
      // ⚠️ **v3 的欄位名**：查詢用 `name`（v2 是 `title`）、分頁用
      //    `pageSize`（v2 是 `maxResults`）、結果在 `files`（v2 是
      //    `items`）。見 docs/已知bug類型.md 事故三十七。
      q: "'" + folder + "' in parents and name = '" + escaped + "' and trashed = false",
      pageSize: 1,
      fields: 'files(id)'
    }));
    var items = (result && result.files) ? result.files : [];
    return items.length;
  } catch (err) {
    return -1;
  }
}

/**
 * 用途：試探 Drive **進階服務**是否真係用得（唔淨係「個名存唔存在」）。
 *   一次最小、唯讀、冇副作用嘅呼叫（列 1 個檔案）。
 *
 *   ⚠️ 畀「完成度自我檢測」用：進階服務未啟用會拋 `ReferenceError`，
 *   已啟用但冇授權／配額用完會拋另一種例外——兩者呢度都當「唔可用」，
 *   訊息原樣帶返出去，由呼叫方決定點樣顯示。
 * Args: （無）
 * Returns:
 *   {{ok:boolean, message:string}}
 */
function probeDriveAdvancedService_() {
  try {
    Drive.Files.list(driveSharedOptions_({ pageSize: 1, fields: 'files(id)' }));
    return { ok: true, message: '可用。' };
  } catch (err) {
    return { ok: false, message: (err && err.message) ? err.message : String(err) };
  }
}

/**
 * 用途：數一個檔案有幾多個版本記錄（Drive 嘅「版本記錄」／revisions）。
 *
 *   ⚠️ 不變量 I10 靠佢做**最終確認**：「對職事表一律唯讀」呢條紀律，
 *   靜態 lint 只證明得到「程式碼裏面冇寫入方法」，呢個函式證明「實際上
 *   真係一個版本都冇多」——兩者嘅證據等級完全唔同。
 *
 *   ⚠️ 這裡**有**帶 `supportsAllDrives`（經 `driveSharedOptions_()`）。
 *   舊註解寫「刻意不加，因為 v2 的 revisions.list 沒有這個參數，傳落去
 *   有機會拋錯」——實測推翻了那個顧慮：`driveListRevisions_()` 一直有
 *   傳，而真實環境回的錯只提到 `fields`，完全沒有提 `supportsAllDrives`。
 *   master 檔案在 Shared Drive 上，帶住它比較穩妥。
 *   `tools/lint-drive-shared.js` 只管 `Drive.Files.`／`Drive.Drives.`
 *   兩個前綴，不會誤判這一行——理由已經寫在那個工具的檔頭。
 *
 *   ⚠️ 版本記錄可能好多頁；呢度只需要**數目**，所以一頁一頁攞落去數，
 *   最多攞 `DRIVE_REVISION_MAX_PAGES_` 頁，超過就當「數唔到」回 `null`
 *   ——寧可講「數唔到」，都好過回一個截斷咗嘅數字然後被人當成真數。
 * Args:
 *   fileId {string} 檔案 ID。呼叫方負責傳入，本檔案唔會自己去攞任何
 *     試算表 ID（見檔頭規則 4）。
 * Returns:
 *   {?number} 版本記錄數目；讀唔到（進階服務未啟用、冇權限、檔案類型
 *     唔支援、頁數太多）一律回 `null`。
 *     ⚠️ `null` 同 `0` **唔可以**混為一談：`0` 係「數過，冇版本」，
 *     `null` 係「數唔到」。
 */
function driveCountRevisions_(fileId) {
  var id = String(fileId || '').trim();
  if (!id) return null;

  try {
    var total = 0;
    var pageToken = null;
    for (var page = 0; page < DRIVE_REVISION_MAX_PAGES_; page++) {
      // ⚠️ **v3 的欄位名**。appsscript.json 把 Drive 進階服務釘死在 v3，
      //    但這裡本來寫的是 v2 的 `items`／`maxResults`，於是每一次呼叫都
      //    回「Invalid field selection items」——而外面的 try/catch 把它變成
      //    `null`（「數唔到」），所以 I10 一直報「驗證不到」而沒有人發現。
      //    見 docs/已知bug類型.md 事故三十七。
      var args = driveSharedOptions_({ pageSize: 1000, fields: 'revisions(id),nextPageToken' });
      if (pageToken) args.pageToken = pageToken;

      var result = Drive.Revisions.list(id, args);
      var items = (result && result.revisions) ? result.revisions : [];
      total += items.length;

      pageToken = (result && result.nextPageToken) ? result.nextPageToken : null;
      if (!pageToken) return total;
    }
    return null; // 頁數超出上限：數唔晒，唔可以回一個截斷咗嘅數字
  } catch (err) {
    return null;
  }
}

/**
 * 用途：列出一個檔案的版本記錄（時間與大小），供「診斷 I06」報告用。
 *   **唯讀**——只叫 `Drive.Revisions.list`，一個位元組都不會寫。
 *
 *   ⚠️ 回 `ok:false` 與回「0 個版本」是**兩件事**：前者代表讀不到
 *   （進階服務未啟用、權限不足、檔案不支援版本記錄），後者代表真的沒有。
 *   混為一談的話，報告會把「未驗過」寫成「沒問題」。
 * Args:
 *   fileId {string} 檔案 ID。
 *   maxItems {number=} 最多回幾多個（預設 20，由新到舊）。
 * Returns:
 *   {{ok:boolean, revisions:Object[], total:number, message:string}}
 *     每個 revision 是 `{id, modifiedDate, fileSize}`。
 */
function driveListRevisions_(fileId, maxItems) {
  var id = String(fileId || '').trim();
  var limit = (maxItems === undefined || maxItems === null) ? 20 : Number(maxItems);
  if (!id) return { ok: false, revisions: [], total: 0, message: '檔案 ID 是空的。' };

  try {
    var all = [];
    var pageToken = null;
    for (var page = 0; page < DRIVE_REVISION_MAX_PAGES_; page++) {
      // ⚠️ v3 的欄位名：`revisions` 不是 `items`、`modifiedTime` 不是
      //    `modifiedDate`、`size` 不是 `fileSize`、修改者是一個物件
      //    `lastModifyingUser` 而不是 `lastModifyingUserName` 那個字串。
      //    見 docs/已知bug類型.md 事故三十七。
      var args = driveSharedOptions_({
        pageSize: 1000,
        fields: 'revisions(id,modifiedTime,size,lastModifyingUser(displayName)),nextPageToken'
      });
      if (pageToken) args.pageToken = pageToken;

      var result = Drive.Revisions.list(id, args);
      var items = (result && result.revisions) ? result.revisions : [];
      items.forEach(function (item) {
        all.push({
          id: String(item.id || ''),
          modifiedDate: String(item.modifiedTime || ''),
          fileSize: (item.size === undefined || item.size === null) ? null : Number(item.size),
          modifiedBy: driveRevisionModifierName_(item)
        });
      });

      pageToken = (result && result.nextPageToken) ? result.nextPageToken : null;
      if (!pageToken) break;
    }

    // 由新到舊，只回頭幾個——報告有行數上限（事故二十一）。
    var newestFirst = all.slice().reverse();
    return {
      ok: true,
      revisions: newestFirst.slice(0, limit),
      total: all.length,
      message: ''
    };
  } catch (err) {
    return {
      ok: false, revisions: [], total: 0,
      message: '讀不到版本記錄：' + ((err && err.message) ? err.message : String(err))
        + '（Drive 進階服務未啟用、權限不足，或者該檔案不支援版本記錄）'
    };
  }
}

/**
 * 用途：由 v3 的 revision 物件取出「誰改的」。**純函式。**
 *
 *   ⚠️ v3 的 `lastModifyingUser` 是一個**物件**（`{displayName, emailAddress…}`），
 *   不是 v2 那個 `lastModifyingUserName` 字串。直接當字串用會得出
 *   `[object Object]`。
 * Args:
 *   item {Object} 一個 revision。
 * Returns:
 *   {string} 取不到回空字串。
 */
function driveRevisionModifierName_(item) {
  var user = (item || {}).lastModifyingUser;
  if (!user) return '';
  if (typeof user === 'string') return user;
  return String(user.displayName || user.emailAddress || '');
}

/** `driveCountRevisions_()` 最多翻幾多頁。超過就當數唔到。 */
var DRIVE_REVISION_MAX_PAGES_ = 20;
