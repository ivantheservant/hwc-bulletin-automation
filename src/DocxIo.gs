/**
 * DocxIo.gs
 *
 * Word（`.docx`）範本渲染的 **IO 層**：讀範本檔、解壓、換掉
 * `word/document.xml`、壓縮、寫回雲端硬碟。
 *
 * ⚠️ **這是全 `src/` 唯一准許使用 `DriveApp` 的檔案**（見
 * tools/lint-readonly-roster.js 規則 3）。第七輪之前 `DriveApp` 是全面
 * 禁止的；Word 範本一定要讀寫 Drive，所以放寬成「鎖死在單一檔案」，
 * 手法跟 `openById(` 只准出現在 `RosterRead.gs` 完全一樣——能力集中在
 * 一個地方，「有沒有人用 Drive 繞過職事表唯讀邊界」永遠只需要審一個檔案。
 *
 * ⚠️ 配套的第二道防線（lint 規則 4）：**本檔案不准出現
 * `ROSTER_SPREADSHEET_ID`**。`DriveApp.getFileById()` 理論上可以開啟任何
 * 檔案，包括職事表本身；靜態上證明不了「這個執行期變數不是職事表 ID」，
 * 但可以證明「這個檔案從來拿不到職事表 ID 這個設定鍵」。加設定鍵的時候
 * 要記住這條界線。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ⚠️ 只改 `word/document.xml`，其餘一個位元都不碰
 * ─────────────────────────────────────────────────────────────────────
 *
 * `word/media/*`（圖片）、`styles.xml`、`settings.xml`、`theme1.xml`、
 * `fontTable.xml`……全部原封不動放回。週報的版面（A5 兩頁併印、三欄
 * section、8–20 個文字方塊、2–6 個圓角矩形、六種港式中文字型）就是靠
 * 這些檔案撐住的，動任何一個都會壞。
 *
 * 我們的做法從來不是「重畫版面」，只是「換字」——所以除了裝文字的
 * `word/document.xml` 之外，沒有任何理由碰其他檔案。
 */

'use strict';

/** `.docx`（其實是一個 zip）內一定要存在的清單檔。缺了它 Word 開不到檔。 */
var DOCX_CONTENT_TYPES_ENTRY_ = '[Content_Types].xml';

/** 要替換的主文件在 zip 內的路徑。 */
var DOCX_DOCUMENT_ENTRY_ = 'word/document.xml';

/** `.docx` 的 MIME 類型，`Utilities.newBlob()` 與寄附件時都要用。 */
var DOCX_MIME_TYPE_ = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/**
 * 用途：試探性確認目前的執行帳戶對 Drive 服務有沒有基本的存取範圍。
 *   供「檢查授權範圍」使用——刻意不依賴任何 Config 設定值（不用讀
 *   `BULLETIN_OUTPUT_FOLDER_ID` 之類的 ID），純粹只是想知道「DriveApp
 *   這個服務本身叫不叫得動」，不代表已經檢查過任何實際檔案／資料夾。
 * Args: （無）
 * Returns:
 *   {void}
 * Raises:
 *   Error 如果目前的授權範圍不包含 Drive（或其他任何原因導致呼叫失敗）——
 *     原樣往上拋，呼叫方（`checkAuthorizationScopes_()`）會接住並判定
 *     這一項「未授權」。
 */
function probeDriveAccess_() {
  DriveApp.getRootFolder().getId();
}

/**
 * 用途：確認一個資料夾 ID 開得到——供「完成度自我檢測」使用。
 *
 *   ⚠️ `DriveApp` 沒有直接的「檢查寫入權限」API；真正的寫入權限只有
 *   實際新增一個檔案時才會確定知道，而這裡刻意不建立任何測試檔案
 *   （避免留下垃圾）。所以這個檢查的意思是「開得到、讀得到名稱」，
 *   不是嚴格保證「一定寫得進去」——這個限制記在
 *   docs/待確認事項.md，供日後想加強時參考。
 * Args:
 *   folderId {string} 資料夾 ID。
 * Returns:
 *   {{ok:boolean, message:string}}
 */
function checkOutputFolderAccessible_(folderId) {
  if (!folderId) return { ok: false, message: '尚未設定資料夾 ID。' };
  try {
    var folder = DriveApp.getFolderById(folderId);
    return { ok: true, message: '可以開啟（' + folder.getName() + '）。' };
  } catch (err) {
    return {
      ok: false,
      message: '無法開啟資料夾（ID 開頭：' + maskFileId_(folderId) + '）：'
        + scrubFileId_(err && err.message ? err.message : String(err), folderId)
    };
  }
}

/**
 * 用途：把檔案 ID 縮短成可以安全放進錯誤訊息的形式（只留前 8 個字元）。
 *
 *   ⚠️ 錯誤訊息會流到 `ErrorLog`／`Diagnostics`／對話框，而這個 repo 是
 *   公開的。完整的 Drive 檔案 ID 等同於一條可以直接開啟檔案的線索，
 *   一律不可以完整印出來——這跟 `RosterRead.gs` 印職事表 ID 的做法一致。
 * Args:
 *   fileId {*} 檔案 ID。
 * Returns:
 *   {string} 例如 `'1a2b3c4d…'`；空值回 `'（空白）'`。
 */
function maskFileId_(fileId) {
  var id = String(fileId === null || fileId === undefined ? '' : fileId);
  if (!id) return '（空白）';
  return id.slice(0, 8) + '…';
}

/**
 * 用途：把一段文字（通常是底層例外的 `message`）裡面出現的完整檔案 ID
 *   換成遮罩過的形式。
 *
 *   ⚠️ 為什麼一定要有這一步：`maskFileId_()` 只管**我們自己**組的那一段
 *   訊息，但底層 `DriveApp` 拋出來的例外**本身就常常含完整 ID**
 *   （「找不到檔案 1a2b3c…」這種）。把 `err.message` 原樣接在後面，
 *   遮罩就完全白做了——完整 ID 照樣流進 `ErrorLog`／`Diagnostics`／
 *   對話框。tests/docxio.test.js 有兩個測試專門盯住這件事。
 * Args:
 *   text {*} 原始訊息。
 *   fileId {*} 要遮蔽的檔案／資料夾 ID。
 * Returns:
 *   {string}
 */
function scrubFileId_(text, fileId) {
  var message = String(text === null || text === undefined ? '' : text);
  var id = String(fileId === null || fileId === undefined ? '' : fileId);
  // 太短的字串不做替換：那多數不是真的 ID，硬換反而會把訊息弄花。
  if (id.length < 8) return message;
  return message.split(id).join(maskFileId_(id));
}

/**
 * 用途：由 Drive 讀出範本檔的 blob。
 * Args:
 *   fileId {string} 範本 `.docx` 在雲端硬碟的檔案 ID。
 * Returns:
 *   {Blob} 範本檔的 blob。
 * Raises:
 *   Error 如果 `fileId` 是空字串，或檔案開不到（不存在／沒有權限）。
 *     訊息只含 ID 的**前 8 個字元**，不印完整 ID。
 */
function readTemplateBlob_(fileId) {
  if (!fileId) {
    throw new Error('readTemplateBlob_：範本檔案 ID 是空的。請先在 Config 填入 Word 範本的檔案 ID。');
  }
  var blob;
  try {
    blob = DriveApp.getFileById(fileId).getBlob();
  } catch (err) {
    throw new Error(
      '無法讀取 Word 範本檔（ID 開頭：' + maskFileId_(fileId) + '）：'
      + scrubFileId_(err && err.message ? err.message : String(err), fileId)
      + '。請檢查 Config 的範本檔案 ID 是否正確，以及本帳戶有沒有該檔案的檢視權限。'
    );
  }

  // ⚠️ 最常見的事故來源：Google Drive 把上載的 .docx 自動轉換成 Google
  // 文件格式（帳戶設定「將上載的檔案轉換為 Google 文件編輯器格式」開著
  // 的話），或者 Ivan 不小心貼了 Google 文件本身的檔案 ID。兩種情況
  // `getBlob()` 都不會拋錯，但 MIME 類型不是 Word 檔——不檢查的話，
  // 後面 `Utilities.unzip()` 會用一個更難懂的「不是合法 zip」錯誤失敗，
  // 完全看不出真正原因。
  var contentType = blob.getContentType();
  if (contentType !== DOCX_MIME_TYPE_) {
    throw new Error(
      '範本檔案不是 Word 檔（目前是 ' + contentType + '）。如果它被 Google Drive 轉換成 Google 文件，'
      + '請在 Drive 設定關閉「將上載的檔案轉換為 Google 文件編輯器格式」，刪除已轉換的檔案，'
      + '重新上載原本的 .docx，再更新 Config 的檔案 ID。'
    );
  }

  return blob;
}

/**
 * 用途：把 `.docx` blob 解壓成一批 zip entry。
 * Args:
 *   blob {Blob} `.docx` 的 blob。
 * Returns:
 *   {{name:string, blob:Blob}[]} 每個 entry 的名稱與內容。
 * Raises:
 *   Error 如果解壓失敗（檔案不是合法的 zip／`.docx`）。
 */
function unzipDocx_(blob) {
  var entries;
  try {
    entries = Utilities.unzip(blob);
  } catch (err) {
    throw new Error(
      '無法解壓 Word 範本檔：' + (err && err.message ? err.message : String(err))
      + '。請確認那個檔案真的是 .docx（不是 .doc、也不是 Google 文件格式）。'
    );
  }
  return entries.map(function (entry) {
    return { name: entry.getName(), blob: entry };
  });
}

/**
 * 用途：在解壓出來的 entry 中，找出 `word/document.xml` 的索引。
 *
 *   ⚠️ **不可以寫死索引位置。** `Utilities.unzip()` 回傳的次序不保證，
 *   而且 entry 名稱可能不含資料夾前綴、或者大小寫有差異（不同工具產生的
 *   zip 行為不一樣）。所以一律用**實際回傳的名稱**去找：先精確比對，
 *   再退回「不分大小寫」與「只比對結尾檔名」兩種寬鬆比對。
 * Args:
 *   entries {{name:string}[]} `unzipDocx_()` 的輸出。
 * Returns:
 *   {number} 索引；找不到回 `-1`。
 */
function findDocumentEntryIndex_(entries) {
  var list = entries || [];
  var i;

  for (i = 0; i < list.length; i++) {
    if (list[i].name === DOCX_DOCUMENT_ENTRY_) return i;
  }

  var target = DOCX_DOCUMENT_ENTRY_.toLowerCase();
  for (i = 0; i < list.length; i++) {
    if (String(list[i].name || '').toLowerCase() === target) return i;
  }

  // 最後退路：只比對結尾的檔名。刻意排除 `document2.xml` 這類近似名稱，
  // 所以要求前面緊接的是路徑分隔符或者整個名稱就是它。
  for (i = 0; i < list.length; i++) {
    var name = String(list[i].name || '').toLowerCase().replace(/\\/g, '/');
    if (name === 'document.xml' || name.slice(-'/document.xml'.length) === '/document.xml') return i;
  }

  return -1;
}

/**
 * 用途：確認一批 entry 構成一個合法的 `.docx`——`[Content_Types].xml`
 *   一定要存在。
 *
 *   ⚠️ 缺了這個檔案，Word 會直接說「檔案已損毀」而且完全打不開。壓縮
 *   之前先檢查，比事後叫幹事自己發現好得多。
 * Args:
 *   entries {{name:string}[]} entry 清單。
 * Returns:
 *   {void}
 * Raises:
 *   Error 如果找不到 `[Content_Types].xml`。
 */
function assertDocxHasContentTypes_(entries) {
  var found = (entries || []).some(function (e) {
    return String(e.name || '').replace(/\\/g, '/').split('/').pop() === DOCX_CONTENT_TYPES_ENTRY_;
  });
  if (!found) {
    throw new Error(
      'zipDocx_：這批檔案缺少「' + DOCX_CONTENT_TYPES_ENTRY_ + '」，壓出來的 .docx 會被 Word 當成損毀檔案而完全打不開。'
      + '通常代表來源根本不是一個 .docx，或者解壓的時候漏了東西。'
    );
  }
}

/**
 * 用途：把 `[Content_Types].xml` 移到陣列最前面，其餘 entry **保持原本
 *   的相對次序**，不多不少。
 *
 *   ⚠️ `Utilities.unzip()` 回傳的次序不保證 `[Content_Types].xml` 排第一
 *   （見 `findDocumentEntryIndex_()` 檔頭的說明），但真正的 `.docx`
 *   （由 Word／Office 產生）zip 內第一個 entry**一定**是它——這是 Word
 *   認得出「這是一個有效的 OOXML 檔案」的其中一個依據。壓縮的時候如果
 *   照抄 `unzip()` 的原始次序，就有機會把它排到別的位置，Word 開啟時
 *   可能要求修復。
 * Args:
 *   entries {{name:string, blob:Blob}[]} entry 清單。
 * Returns:
 *   {{name:string, blob:Blob}[]} 新陣列（不修改原陣列）；找不到
 *     `[Content_Types].xml` 時原樣回傳（`assertDocxHasContentTypes_()`
 *     會在呼叫方那一層先擋住這種情況）。
 */
function moveContentTypesEntryFirst_(entries) {
  var list = (entries || []).slice();
  var index = -1;
  for (var i = 0; i < list.length; i++) {
    if (String(list[i].name || '').replace(/\\/g, '/').split('/').pop() === DOCX_CONTENT_TYPES_ENTRY_) {
      index = i;
      break;
    }
  }
  if (index <= 0) return list;

  var entry = list.splice(index, 1)[0];
  list.unshift(entry);
  return list;
}

/**
 * 用途：把一批 entry 壓縮回一個 `.docx` blob。
 *
 *   ⚠️ 除了呼叫方明確換掉的那一個 entry 之外，其餘 blob 一律**原物**
 *   放回，不做任何轉換——見檔頭「只改 word/document.xml」。
 * Args:
 *   entries {{name:string, blob:Blob}[]} 要壓縮的全部 entry。
 *   filename {string} 產生的檔名（含 `.docx`）。
 * Returns:
 *   {Blob} `.docx` blob，MIME 類型已經設成 Word 的類型。
 * Raises:
 *   Error 如果缺少 `[Content_Types].xml`，或壓縮失敗。
 */
function zipDocx_(entries, filename) {
  assertDocxHasContentTypes_(entries);

  var ordered = moveContentTypesEntryFirst_(entries);
  var blobs = ordered.map(function (e) { return e.blob.setName(e.name); });
  var zipped;
  try {
    zipped = Utilities.zip(blobs, filename);
  } catch (err) {
    throw new Error('zipDocx_：壓縮 .docx 失敗：' + (err && err.message ? err.message : String(err)));
  }

  // Utilities.zip() 出來的 MIME 是 application/zip；要改成 Word 的類型，
  // 否則寄出去的附件在收件人那邊會變成一個認不出的壓縮檔。
  return zipped.setContentType(DOCX_MIME_TYPE_).setName(filename);
}

/**
 * 用途：把整個「讀範本 → 換掉 `word/document.xml` → 壓回去」的流程做完。
 *
 *   純 XML 的轉換由呼叫方傳一個函式進來（`transformXml`），本函式只負責
 *   IO——這樣渲染邏輯仍然完全可以在 Node 測試，IO 這一層只需要用假的
 *   `Utilities`／`DriveApp` 替身測一次「有沒有動到不該動的 entry」。
 * Args:
 *   fileId {string} 範本 `.docx` 的檔案 ID。
 *   filename {string} 產生的檔名。
 *   transformXml {function(string): string} 輸入原始
 *     `word/document.xml`、輸出渲染後的 XML。
 * Returns:
 *   {{blob:Blob, entryCount:number, documentEntryName:string}}
 * Raises:
 *   Error 如果讀檔／解壓／壓縮失敗，或 zip 內找不到 `word/document.xml`。
 */
function renderDocxFromTemplate_(fileId, filename, transformXml) {
  var entries = unzipDocx_(readTemplateBlob_(fileId));

  var documentIndex = findDocumentEntryIndex_(entries);
  if (documentIndex === -1) {
    throw new Error(
      'renderDocxFromTemplate_：範本檔（ID 開頭：' + maskFileId_(fileId) + '）內找不到「'
      + DOCX_DOCUMENT_ENTRY_ + '」。實際的檔案清單：'
      + entries.map(function (e) { return e.name; }).join('、')
      + '。請確認那個檔案真的是 .docx。'
    );
  }

  var originalName = entries[documentIndex].name;
  var originalXml = entries[documentIndex].blob.getDataAsString('UTF-8');
  var renderedXml = transformXml(originalXml);

  // ⚠️ 只換這一個 entry，其餘保持原物件不動。
  entries[documentIndex] = {
    name: originalName,
    blob: Utilities.newBlob(renderedXml, 'application/xml', originalName)
  };

  return {
    blob: zipDocx_(entries, filename),
    entryCount: entries.length,
    documentEntryName: originalName
  };
}

/**
 * 用途：把檔名拆成「主檔名」與「副檔名」，供 `uniqueOutputFileName_()`
 *   在中間插入序號用。
 * Args:
 *   name {string} 例如 `'2027-11-07_粵語堂週報.docx'`。
 * Returns:
 *   {{base:string, ext:string}} `ext` 含前導的點；沒有副檔名時是空字串。
 */
function splitFileName_(name) {
  var full = String(name || '');
  var dot = full.lastIndexOf('.');
  if (dot <= 0) return { base: full, ext: '' };
  return { base: full.slice(0, dot), ext: full.slice(dot) };
}

/**
 * 用途：在同一個資料夾內找出一個尚未被使用的檔名——同名時在主檔名後面
 *   加 `(2)`、`(3)`……
 *
 *   ⚠️ **同名檔案一律新增，不覆蓋。** 幹事很可能為同一個主日產生好幾次
 *   （改完內容再產生一次），覆蓋掉舊檔就沒有辦法回頭比對「上一版印了
 *   什麼」。Drive 本身也允許同名檔案並存，靠檔名加序號才分得清楚。
 * Args:
 *   folder {Folder} 目標資料夾。
 *   name {string} 想要的檔名。
 *   maxAttempts {number=} 最多試幾個序號，預設 200；超過就在檔名加時間戳
 *     記，保證一定寫得出來。
 * Returns:
 *   {string} 實際可以用的檔名。
 */
function uniqueOutputFileName_(folder, name, maxAttempts) {
  var limit = maxAttempts || 200;
  var parts = splitFileName_(name);

  if (!folder.getFilesByName(name).hasNext()) return name;

  for (var n = 2; n <= limit; n++) {
    var candidate = parts.base + '(' + n + ')' + parts.ext;
    if (!folder.getFilesByName(candidate).hasNext()) return candidate;
  }

  return parts.base + '(' + new Date().getTime() + ')' + parts.ext;
}

/**
 * 用途：把產生好的 blob 存到輸出資料夾。
 * Args:
 *   blob {Blob} 要存的檔案。
 *   folderId {string} 目標資料夾 ID（Config 的 `BULLETIN_OUTPUT_FOLDER_ID`）。
 *   name {string} 想要的檔名；同名時會自動加序號（見
 *     `uniqueOutputFileName_()`）。
 * Returns:
 *   {{fileId:string, fileName:string, url:string}}
 * Raises:
 *   Error 如果 `folderId` 是空的，或資料夾開不到（訊息只含 ID 前 8 字元）。
 */
function writeOutputFile_(blob, folderId, name) {
  if (!folderId) {
    throw new Error(
      'writeOutputFile_：輸出資料夾 ID 是空的。請先在 Config 填入 BULLETIN_OUTPUT_FOLDER_ID。'
    );
  }

  var folder;
  try {
    folder = DriveApp.getFolderById(folderId);
  } catch (err) {
    throw new Error(
      '無法開啟輸出資料夾（ID 開頭：' + maskFileId_(folderId) + '）：'
      + scrubFileId_(err && err.message ? err.message : String(err), folderId)
      + '。請檢查 Config 的 BULLETIN_OUTPUT_FOLDER_ID，以及本帳戶有沒有該資料夾的編輯權限。'
    );
  }

  var finalName = uniqueOutputFileName_(folder, name);
  var file = folder.createFile(blob.setName(finalName));

  return { fileId: file.getId(), fileName: finalName, url: file.getUrl() };
}
