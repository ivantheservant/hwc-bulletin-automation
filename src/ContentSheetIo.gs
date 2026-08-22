/**
 * ContentSheetIo.gs
 *
 * 每季「內容表」（獨立試算表）嘅全部 Drive 與跨試算表 IO。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ⚠️ 呢個檔案係全 src/ 兩個高權限檔案之一，改動之前請先讀 lint 嘅說明
 * ─────────────────────────────────────────────────────────────────────
 *
 *   `tools/lint-readonly-roster.js` 對本檔案有三條硬規則：
 *
 *     - **准用 `DriveApp`**（規則 3）：建立檔案、搬入 Shared Drive 資料夾、
 *       設定分享權限，冇 Drive 做唔到。
 *     - **准用 `openById(`**（規則 1）：內容表係另一個試算表，唔喺
 *       `getActiveSpreadsheet()` 入面。
 *     - **一個格都唔准出現 `ROSTER_SPREADSHEET_ID`**（規則 4）：上面兩樣
 *       嘢理論上開得到**任何**檔案，包括職事表本身。靜態上證明唔到某個
 *       執行期變數唔係職事表 ID，但證明得到「呢個檔案由頭到尾拎唔到職事表
 *       ID 呢個設定鍵」——拎唔到，就冇辦法自己揾到職事表。
 *
 *   所以：**唔好喺呢個檔案加任何同職事表有關嘅嘢**，亦唔好喺呢度加業務
 *   邏輯。結構、欄位定義、樣本內容、邀請信全部喺 `src/ContentSheet.gs`。
 *   呢度淨係做「開檔、寫格、設權限」。
 *
 * ⚠️ 分享權限一律係**網域內可編輯**（`DriveApp.Access.DOMAIN`），
 * **絕對唔可以**用 `ANYONE_WITH_LINK`——內容表有會友姓名同教會內部資料。
 */

'use strict';

/**
 * 用途：檢查 Config `CONTENT_SHEET_FOLDER_ID` 有冇填。
 *
 *   ⚠️ 未填時要畀一句**講明缺咗邊個設定鍵**嘅錯誤訊息，唔可以等到
 *   `DriveApp.getFolderById('')` 拋一句睇唔明嘅原始例外——嗰句只會話
 *   「找不到 ID 為空的項目」，幹事完全唔知要去邊度填。
 * Args:
 *   folderId {string} Config 讀出嚟嘅值。
 * Returns:
 *   {{ok:boolean, message:string}}
 */
function checkContentSheetFolderConfigured_(folderId) {
  var id = String(folderId || '').trim();
  if (!id) {
    return {
      ok: false,
      message: '尚未設定內容表要放喺邊個資料夾。請喺 Config 工作表填入 '
        + CONFIG_KEYS.CONTENT_SHEET_FOLDER_ID
        + '（Shared Drive 內某個資料夾嘅 ID——喺瀏覽器打開嗰個資料夾，'
        + '網址 /folders/ 後面嗰一串就係），然後再撳一次。'
    };
  }
  return { ok: true, message: '' };
}

/**
 * 用途：喺指定資料夾建立一個新嘅試算表，並設定網域分享權限。
 * Args:
 *   fileName {string} 檔名。
 *   folderId {string} 目標資料夾 ID（Shared Drive）。
 *   domain {string} 要分享畀邊個網域；空白就唔設分享（留返畀人手處理）。
 * Returns:
 *   {{spreadsheet:Spreadsheet, fileId:string, fileUrl:string,
 *     sharingApplied:boolean, sharingError:string}}
 * Raises:
 *   Error 如果建立或者搬檔案失敗（資料夾 ID 唔啱、冇權限……）。
 */
function createContentSpreadsheet_(fileName, folderId, domain) {
  var spreadsheet = SpreadsheetApp.create(fileName);
  var fileId = spreadsheet.getId();

  var file = DriveApp.getFileById(fileId);
  file.moveTo(DriveApp.getFolderById(folderId));

  // ⚠️ 分享失敗**唔可以**令成個建立流程失敗：檔案已經建立好，人手補設
  // 權限就得。硬拋錯只會留低一個「已經建立但登記唔到」嘅孤兒檔案。
  var sharingApplied = false;
  var sharingError = '';
  var targetDomain = String(domain || '').trim();
  if (targetDomain) {
    try {
      file.setSharing(DriveApp.Access.DOMAIN, DriveApp.Permission.EDIT);
      sharingApplied = true;
    } catch (err) {
      sharingError = (err && err.message) ? err.message : String(err);
    }
  }

  return {
    spreadsheet: spreadsheet,
    fileId: fileId,
    fileUrl: spreadsheet.getUrl(),
    sharingApplied: sharingApplied,
    sharingError: sharingError
  };
}

/**
 * 用途：按檔案 ID 開啟一個已經存在嘅內容表。
 * Args:
 *   fileId {string} 檔案 ID。
 * Returns:
 *   {?Spreadsheet} 開唔到（檔案被刪、冇權限、ID 唔啱）時回 `null`，唔拋錯
 *     ——呼叫方要分得出「未建立過」同「建立過但而家開唔到」，兩者嘅處理
 *     唔同（前者建立新嘅，後者要話畀人知檔案唔見咗）。
 */
function openContentSpreadsheet_(fileId) {
  var id = String(fileId || '').trim();
  if (!id) return null;
  try {
    return SpreadsheetApp.openById(id);
  } catch (err) {
    return null;
  }
}

/**
 * 用途：確保內容表入面有指定名稱嘅分頁，冇就建立。
 * Args:
 *   spreadsheet {Spreadsheet} 內容表。
 *   name {string} 分頁名稱。
 * Returns:
 *   {{sheet:Sheet, created:boolean}}
 */
function ensureContentTab_(spreadsheet, name) {
  var sheet = spreadsheet.getSheetByName(name);
  if (sheet) return { sheet: sheet, created: false };
  return { sheet: spreadsheet.insertSheet(name), created: true };
}

/**
 * 用途：把內容表嘅分頁次序排成 `contentSheetTabNames_()` 嗰個次序，並且
 *   刪走 Google 自動建立嘅預設空白分頁（`Sheet1`／`工作表1` 之類）。
 *
 *   ⚠️ **只刪「唔喺我哋清單入面、而且完全空白」嗰啲**：人手加咗嘅分頁
 *   （例如堂委自己開嘅草稿）唔可以刪。
 * Args:
 *   spreadsheet {Spreadsheet} 內容表。
 *   wantedNames {string[]} 想要嘅分頁次序。
 * Returns:
 *   {{removed:string[]}} 刪走咗邊幾張。
 */
function arrangeContentTabs_(spreadsheet, wantedNames) {
  var removed = [];

  wantedNames.forEach(function (name, index) {
    var sheet = spreadsheet.getSheetByName(name);
    if (!sheet) return;
    spreadsheet.setActiveSheet(sheet);
    spreadsheet.moveActiveSheet(index + 1);
  });

  spreadsheet.getSheets().forEach(function (sheet) {
    var name = sheet.getName();
    if (wantedNames.indexOf(name) !== -1) return;
    if (sheet.getLastRow() > 0 || sheet.getLastColumn() > 0) return; // 有嘢就唔好郁
    try {
      spreadsheet.deleteSheet(sheet);
      removed.push(name);
    } catch (err) {
      // 只剩一張分頁時刪唔到——嗰陣其餘分頁一定已經建立好，唔會行到呢度。
    }
  });

  return { removed: removed };
}

/**
 * 用途：把一批「以機器鍵為 key 嘅資料列」寫入內容表某張分頁嘅指定位置。
 * Args:
 *   sheet {Sheet} 目標分頁。
 *   keys {string[]} 欄位機器鍵（決定欄次序）。
 *   rows {Object[]} 資料列。
 *   startRow {number} 由第幾行開始寫（1 起算）。
 * Returns:
 *   {number} 實際寫咗幾多行。
 */
function writeContentRows_(sheet, keys, rows, startRow) {
  var list = rows || [];
  if (list.length === 0) return 0;

  var values = list.map(function (row) {
    return keys.map(function (k) {
      var v = row[k];
      return (v === null || v === undefined) ? '' : v;
    });
  });

  sheet.getRange(startRow, 1, values.length, keys.length).setValues(values);
  return values.length;
}
