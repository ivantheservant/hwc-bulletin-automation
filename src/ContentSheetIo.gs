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
      message: '尚未設定內容表要存放在哪一個資料夾。請在 Config 工作表填入 '
        + CONFIG_KEYS.CONTENT_SHEET_FOLDER_ID
        + '（Shared Drive 內某個資料夾的 ID——在瀏覽器開啟該資料夾，'
        + '網址 /folders/ 後面那一串就是），然後再按一次。'
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
 * 用途：2026-10-30：內容表檔案的最後修改時間（毫秒）。唯讀。內容表自動同步（src/ContentAutoSync.gs）用來判斷
 *   「上一次同步之後有沒有人改過」。放在這個檔案是因為 DriveApp 只准出現在這裏等幾個檔案。
 * Args:
 *   fileId {string} 內容表的檔案 ID。
 * Returns:
 *   {?number} 讀不到回 `null`（呼叫方當作「有改過」，照樣同步）。
 * Raises:
 *   （無）
 */
function readContentSheetLastUpdatedMillis_(fileId) {
  if (!fileId) return null;
  try {
    var updated = DriveApp.getFileById(String(fileId)).getLastUpdated();
    return (updated instanceof Date && !isNaN(updated.getTime())) ? updated.getTime() : null;
  } catch (err) {
    return null;
  }
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
 * 用途：內容表 v2：讀一張分頁第 2 行（機器鍵）頭 `n` 欄。純 IO，不做判斷（判斷在
 *   `checkContentSheetSchema_()`）。欄數夾住 `getMaxColumns()`：分頁欄數比 `n` 少的時候，
 *   超出的位置當作空白，不會因為 `getRange()` 越界而拋錯。
 * Args:
 *   sheet {Sheet} 內容表其中一張分頁。
 *   n {number} 要讀幾欄（通常是該分頁定義的欄數）。
 * Returns:
 *   {string[]} 長度剛好 `n`，每格已轉字串並去頭尾空白。
 * Raises:
 *   Error 讀取失敗時原樣拋出。
 */
function readContentTabHeaderKeys_(sheet, n) {
  var want = Math.max(0, Number(n) || 0);
  var available = Math.min(want, Math.max(0, Number(sheet.getMaxColumns()) || 0));
  var cells = available > 0 ? sheet.getRange(2, 1, 1, available).getValues()[0] : [];
  var out = [];
  for (var i = 0; i < want; i++) {
    var v = i < cells.length ? cells[i] : '';
    out.push(v === null || v === undefined ? '' : String(v).trim());
  }
  return out;
}

/**
 * 用途：內容表 v2：讀一張分頁第 3 行起全部資料（頭 `n` 欄）。純 IO。欄數夾住 `getMaxColumns()`，
 *   不夠的欄當作空白，每一行補足 `n` 格。
 * Args:
 *   sheet {Sheet} 內容表其中一張分頁。
 *   n {number} 要讀幾欄。
 * Returns:
 *   {Array[]} 由第 3 行開始的原始格值（可以有 Date 物件，由 `parseContentTabRows_()` 處理）。
 * Raises:
 *   Error 讀取失敗時原樣拋出。
 */
function readContentTabDataValues_(sheet, n) {
  var want = Math.max(0, Number(n) || 0);
  var lastRow = sheet.getLastRow();
  if (want === 0 || lastRow < CONTENT_SHEET_FIRST_DATA_ROW_) return [];
  var available = Math.min(want, Math.max(0, Number(sheet.getMaxColumns()) || 0));
  var numRows = lastRow - CONTENT_SHEET_FIRST_DATA_ROW_ + 1;
  var values = available > 0 ? sheet.getRange(CONTENT_SHEET_FIRST_DATA_ROW_, 1, numRows, available).getValues() : [];
  var out = [];
  for (var r = 0; r < numRows; r++) {
    var row = (values[r] || []).slice();
    while (row.length < want) row.push('');
    out.push(row);
  }
  return out;
}

/**
 * 用途：內容表 v2：分頁欄數不夠 `n` 就在最右邊補欄（`insertColumnsAfter`）。已經夠的一格都不動。
 * Args:
 *   sheet {Sheet} 分頁。
 *   n {number} 至少要有幾欄。
 * Returns:
 *   {number} 補了幾欄。
 * Raises:
 *   Error 插欄失敗時原樣拋出。
 */
function ensureContentTabColumns_(sheet, n) {
  var have = Number(sheet.getMaxColumns()) || 0;
  var need = Number(n) || 0;
  if (have >= need) return 0;
  sheet.insertColumnsAfter(Math.max(have, 1), need - have);
  return need - have;
}

/**
 * 用途：v3：刪走一張分頁的幾欄（整欄刪除，連標題、資料、格式）。只用於內容表 v2 → v3 刪走「崇拜程序」
 *   的浸禮六欄（資料已先搬入週報）。分頁欄數不夠就只刪到最後一欄。
 * Args:
 *   sheet {Sheet} 分頁。
 *   startCol {number} 由第幾欄開始（1 起算）。
 *   count {number} 刪幾欄。
 * Returns:
 *   {number} 實際刪了幾欄。
 * Raises:
 *   Error 刪欄失敗時原樣拋出。
 */
function deleteContentTabColumns_(sheet, startCol, count) {
  var have = Number(sheet.getMaxColumns()) || 0;
  var start = Number(startCol) || 0;
  if (start < 1 || start > have) return 0;
  var n = Math.min(Number(count) || 0, have - start + 1);
  if (n < 1) return 0;
  sheet.deleteColumns(start, n);
  return n;
}

/**
 * 用途：v3：讀一張分頁由第 1 行起的原始格值（包括第 1、2 行標題），刪欄之前整張複製作備份用。
 * Args:
 *   sheet {Sheet} 分頁。
 *   numCols {number} 讀幾欄（分頁欄數不夠就補空白）。
 * Returns:
 *   {Array[]} 原始格值（Date 物件照原樣）；分頁全空回空陣列。
 * Raises:
 *   Error 讀取失敗時原樣拋出。
 */
function readContentTabRawValues_(sheet, numCols) {
  var want = Math.max(0, Number(numCols) || 0);
  var lastRow = sheet.getLastRow();
  if (want === 0 || lastRow < 1) return [];
  var available = Math.min(want, Math.max(0, Number(sheet.getMaxColumns()) || 0));
  var values = available > 0 ? sheet.getRange(1, 1, lastRow, available).getValues() : [];
  return values.map(function (row) {
    var r = row.slice();
    while (r.length < want) r.push('');
    return r;
  });
}

/**
 * 用途：v3：把一批原始格值由第 1 行第 1 欄起寫入一張分頁（備份分頁用；分頁欄數不夠先補欄）。
 *   寫之前把範圍設成純文字，免得「3:16」之類的值被轉成時間（Date 物件照原樣寫回）。
 * Args:
 *   sheet {Sheet} 分頁（新建、空白）。
 *   values {Array[]} 每一行一樣長。
 * Returns:
 *   {number} 寫了幾行。
 * Raises:
 *   Error 寫入失敗時原樣拋出。
 */
function writeContentTabRawValues_(sheet, values) {
  if (!values || values.length === 0) return 0;
  var cols = values[0].length;
  ensureContentTabColumns_(sheet, cols);
  var range = sheet.getRange(1, 1, values.length, cols);
  range.setNumberFormat('@');
  range.setValues(values);
  return values.length;
}

/**
 * 用途：內容表 v2：把一段範圍設成純文字格式（`@`）。寫入之前用，否則「3:16」之類的值會被試算表
 *   轉成時間。
 * Args:
 *   sheet {Sheet} 分頁。
 *   row {number}　col {number}　numRows {number}　numCols {number} 範圍（1 起算）。
 * Returns:
 *   {void}
 * Raises:
 *   Error 設定失敗時原樣拋出。
 */
function setContentRangePlainText_(sheet, row, col, numRows, numCols) {
  if (numRows < 1 || numCols < 1) return;
  sheet.getRange(row, col, numRows, numCols).setNumberFormat('@');
}

/**
 * 用途：內容表 v2：寫一格文字——先設純文字格式，再寫入（已經過 `sanitizeCellText_()`）。
 * Args:
 *   sheet {Sheet} 分頁。
 *   rowNo {number}　colNo {number} 位置（1 起算）。
 *   value {string} 要寫的文字。
 * Returns:
 *   {void}
 * Raises:
 *   Error 寫入失敗時原樣拋出。
 */
function writeContentCellAsText_(sheet, rowNo, colNo, value) {
  var cell = sheet.getRange(rowNo, colNo, 1, 1);
  cell.setNumberFormat('@');
  cell.setValue(sanitizeCellText_(value));
}

/**
 * 用途：內容表 v2：停用舊分頁的第一步——改名（加「（已停用）」）。之後由呼叫方記 AuditLog，再經
 *   `ensureRetiredContentTabState_()` 隱藏、A1 加註解、設警告式保護。**不刪**，資料原封不動（決定 14）。
 * Args:
 *   sheet {Sheet} 舊分頁。
 *   newName {string} 新名稱（呼叫方已確保沒有撞名）。
 * Returns:
 *   {void}
 * Raises:
 *   Error 改名失敗時原樣拋出。改名之後的步驟失敗的話，下一次由 `inspectRetiredContentTab_()`
 *     找出缺了哪幾樣，再補做（審查 B2）。
 */
function renameRetiredContentTab_(sheet, newName) {
  sheet.setName(newName);
}

/**
 * 用途：已改名的舊分頁還缺哪幾樣（隱藏、A1 註解、警告式保護）。唯讀。
 * Args:
 *   sheet {Sheet} 已改名（或者準備改名）的舊分頁。
 *   note {string} A1 註解應有的開頭。
 *   protectionDescription {string} 保護應有的說明（現時只用於呼叫方一致；已有任何分頁保護就算已保護）。
 * Returns:
 *   {{needsHide:boolean, needsNote:boolean, needsProtect:boolean}}
 * Raises:
 *   Error 讀分頁狀態失敗時原樣拋出。
 */
function inspectRetiredContentTab_(sheet, note, protectionDescription) {
  var currentNote = String(sheet.getRange(1, 1, 1, 1).getNote() || '');
  // 審查第二輪 6：分頁已有**任何**分頁保護（例如有人改了說明、或者改成嚴格保護）就當作已保護，
  //    不再呼叫 protect()——否則會把別人的保護說明換掉、甚至降成警告式。
  var protectedOk = (sheet.getProtections(SpreadsheetApp.ProtectionType.SHEET) || []).length > 0;
  return {
    needsHide: sheet.isSheetHidden() !== true,
    needsNote: currentNote.indexOf(note) !== 0,
    needsProtect: !protectedOk
  };
}

/**
 * 用途：把已改名的舊分頁補齊「隱藏、A1 註解、警告式保護」三樣，缺哪樣補哪樣。冪等。
 * Args:
 *   sheet {Sheet} 已改名的舊分頁。
 *   state {{needsHide:boolean, needsNote:boolean, needsProtect:boolean}} `inspectRetiredContentTab_()` 的輸出。
 *   note {string} A1 註解。
 *   protectionDescription {string} 保護的說明。
 * Returns:
 *   {void}
 * Raises:
 *   Error 任何一步失敗時原樣拋出（已做的保留；下一次再檢查，只補未做的）。
 */
function ensureRetiredContentTabState_(sheet, state, note, protectionDescription) {
  if (state.needsHide) sheet.hideSheet();
  if (state.needsNote) {
    var cell = sheet.getRange(1, 1, 1, 1);
    var oldNote = String(cell.getNote() || '');
    cell.setNote(note + (oldNote ? '\n\n' + oldNote : ''));
  }
  if (state.needsProtect) sheet.protect().setDescription(protectionDescription).setWarningOnly(true);
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

/**
 * 用途：把「一個主日一行」的內容表分頁（例如「崇拜程序」）指定的幾格寫好：
 *   該主日已經有一行生效中的資料就只改那幾格（其餘欄一格都不動）；沒有就在
 *   最後面新增一行。講員表格的答案寫入內容表用。
 *
 *   ⚠️ 同一個主日有多行生效中資料時改最後一行——匯入也是以最後一行為準
 *   （`buildContentImportTargets_()`），兩邊要看同一行。已停用的行（有效＝FALSE）
 *   不會被復活，另起新行。
 *   ⚠️ 寫之前先把那一格設成純文字格式，否則「3:16」之類的經文會被轉成時間。
 *
 *   這裏只做「找行、寫格」，不含業務判斷（寫哪幾格由呼叫方決定）。
 * Args:
 *   spreadsheet {Spreadsheet} 已經開啟的內容表。
 *   tabName {string} 分頁名稱。
 *   tabKeys {string[]} 該分頁的機器鍵（欄次序）。
 *   isoDate {string} 主日日期，yyyy-MM-dd。
 *   values {Object<string,string>} 要寫的欄位（機器鍵 → 值），不含 `SERVICE_DATE`／`ACTIVE`。
 * Returns:
 *   {{ok:boolean, reason:string, rowNo:number, created:boolean, previous:Object<string,string>}}
 *     `ok:false` 時 `reason` 是 `'NO_TAB'`（內容表沒有這張分頁）。
 *     `previous` 是改之前那幾格的原值（新增行時是空字串）。
 */
function upsertContentWeekValues_(spreadsheet, tabName, tabKeys, isoDate, values) {
  var sheet = spreadsheet.getSheetByName(tabName);
  if (!sheet) return { ok: false, reason: 'NO_TAB', rowNo: 0, created: false, previous: {} };

  var lastRow = sheet.getLastRow();
  var parsed = [];
  if (lastRow >= CONTENT_SHEET_FIRST_DATA_ROW_) {
    parsed = parseContentTabRows_(
      sheet.getRange(CONTENT_SHEET_FIRST_DATA_ROW_, 1, lastRow - CONTENT_SHEET_FIRST_DATA_ROW_ + 1, tabKeys.length).getValues(),
      tabKeys
    );
  }
  var matches = parsed.filter(function (row) {
    return row.__active === true && String(row.SERVICE_DATE || '').trim() === isoDate;
  });
  var target = matches.length > 0 ? matches[matches.length - 1] : null;

  function writeCell(rowNo, key, value) {
    var col = tabKeys.indexOf(key) + 1;
    if (col <= 0) return;
    var range = sheet.getRange(rowNo, col, 1, 1);
    range.setNumberFormat('@');
    range.setValue(value);
  }

  var previous = {};
  if (target) {
    Object.keys(values).forEach(function (key) {
      previous[key] = String(target[key] === undefined ? '' : target[key]);
      writeCell(target.__rowNo, key, values[key]);
    });
    return { ok: true, reason: '', rowNo: target.__rowNo, created: false, previous: previous };
  }

  var rowNo = Math.max(lastRow + 1, CONTENT_SHEET_FIRST_DATA_ROW_);
  writeCell(rowNo, 'SERVICE_DATE', isoDate);
  Object.keys(values).forEach(function (key) {
    previous[key] = '';
    writeCell(rowNo, key, values[key]);
  });
  writeCell(rowNo, 'ACTIVE', 'TRUE');
  return { ok: true, reason: '', rowNo: rowNo, created: true, previous: previous };
}

/**
 * 用途：把一個內容表檔案搬去指定資料夾（R-035 封存用）。
 *
 *   ⚠️ **搬，不是刪。** 封存的整條規則就是「一格資料都不刪」——檔案仍然
 *   在 Drive，只是換了一個資料夾，隨時搬得返。
 *
 *   ⚠️ 搬不到**不可以靜靜當成成功**：回 `ok:false` 加一句原因，由呼叫方
 *   寫進報告。搬不到而報告話搬咗，下一次找不到檔案會查半日。
 * Args:
 *   fileId {string} 內容表檔案 ID。
 *   folderId {string} 目標資料夾 ID。
 * Returns:
 *   {{ok:boolean, message:string}}
 */
function moveContentSheetFileToFolder_(fileId, folderId) {
  var id = String(fileId || '').trim();
  var target = String(folderId || '').trim();
  if (!id) return { ok: false, message: '（內容表登記行沒有檔案 ID，所以沒有搬動檔案。）' };
  if (!target) return { ok: false, message: '（未設定封存資料夾，所以沒有搬動檔案。）' };

  try {
    var file = DriveApp.getFileById(id);
    file.moveTo(DriveApp.getFolderById(target));
    return { ok: true, message: '檔案已搬去封存資料夾（' + maskContentFileId_(id) + '）。' };
  } catch (err) {
    return {
      ok: false,
      message: '⚠️ 搬動檔案失敗（' + maskContentFileId_(id) + '）：'
        + ((err && err.message) ? err.message : String(err))
        + '　檔案仍然在原本的資料夾，登記行的「有效」已經改了。'
    };
  }
}
