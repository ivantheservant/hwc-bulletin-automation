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
  // Drive 進階服務喺本專案釘死喺 v2（見 appsscript.json），v2 嘅檔名欄位
  // 叫 `title`（v3 先至叫 `name`）。改版本嘅話呢一行要一齊改。
  if (name) resource.title = name;

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
      q: "'" + folder + "' in parents and title = '" + escaped + "' and trashed = false",
      maxResults: 1,
      fields: 'items(id)'
    }));
    var items = (result && result.items) ? result.items : [];
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
    Drive.Files.list(driveSharedOptions_({ maxResults: 1, fields: 'items(id)' }));
    return { ok: true, message: '可用。' };
  } catch (err) {
    return { ok: false, message: (err && err.message) ? err.message : String(err) };
  }
}
