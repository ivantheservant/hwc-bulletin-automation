/**
 * PublishIo.gs
 *
 * 發佈（R-001／R-009）嘅全部 Drive IO：建立 master PDF 檔案、覆寫佢嘅內容、
 * 存一份帶日期同版本號嘅副本。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ⚠️ 呢個檔案係全 src/ 三個高權限檔案之一，改動之前請先讀 lint 嘅說明
 * ─────────────────────────────────────────────────────────────────────
 *
 *   `tools/lint-readonly-roster.js` 對本檔案有兩條硬規則：
 *
 *     - **准用 `DriveApp` 同 `Drive.Files`**（規則 3）：建立檔案、設定
 *       「知道連結的人可檢視」、覆寫內容，冇 Drive 做唔到。
 *     - **一個格都唔准出現 `ROSTER_SPREADSHEET_ID`**（規則 4）：Drive
 *       理論上開得到**任何**檔案，包括職事表本身。靜態上證明唔到某個
 *       執行期變數唔係職事表 ID，但證明得到「呢個檔案由頭到尾拎唔到
 *       職事表 ID 呢個設定鍵」——拎唔到就冇辦法自己揾到職事表。
 *
 *   所以：**唔好喺呢個檔案加業務邏輯**。版本號、日期檢查、未填欄位、
 *   寄信全部喺 `src/Publish.gs`，呢度淨係做「開檔、覆寫、複製、設權限」。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ⚠️ 兩件唔可以做嘅事（做咗就會爆咗 R-001 個核心承諾）
 * ─────────────────────────────────────────────────────────────────────
 *
 *   1. **唔可以用「刪除再上載」更新 master 檔案。** 咁做會換咗檔案 ID，
 *      即係換咗條連結——而條連結已經印咗喺教會網站度。一定要原地覆寫。
 *   2. **唔可以用 `DriveApp` 嘅 `setContent()`。** 佢淨係處理得到文字，
 *      餵 PDF 落去會寫出一個「內容係一堆亂碼字元」嘅檔案，副檔名仲係
 *      `.pdf`，開得開但係壞嘅。原地覆寫二進位內容只有一條路：Drive
 *      **進階服務** `Drive.Files.update()`。
 *
 *   ⚠️ 進階服務要喺 Apps Script 編輯器人手啟用一次（見
 *   docs/幹事操作說明.md）。未啟用時 `Drive` 呢個名根本唔存在，會拋
 *   `ReferenceError`——`classifyPublishError_()` 專門認得呢一種，
 *   會回一句「請先啟用 Drive 進階服務」而唔係一句睇唔明嘅原始例外。
 */

'use strict';

/** master PDF 佔位檔案嘅內文（未發佈過嗰陣睇到嘅嘢）。 */
var PUBLISH_PLACEHOLDER_TITLE_ = '本週週報尚未發佈';

/**
 * 用途：造一個「尚未發佈」嘅一頁佔位 PDF blob。
 *
 *   ⚠️ 主路徑係 HTML → PDF（`Blob.getAs()`），因為佔位頁要有中文字；
 *   純手砌嘅 PDF 只有 Helvetica，寫唔到中文。轉換失敗（配額、服務暫時
 *   唔得）就退回 `buildMinimalPdfText_()` 嗰個純 ASCII 版本——一個
 *   **開得到嘅英文佔位頁**，好過成個「建立 master 檔案」流程失敗。
 * Args:
 *   title {string} 佔位頁要顯示嘅字。
 * Returns:
 *   {Blob} MIME 一定係 `application/pdf`。
 */
function buildPlaceholderPdfBlob_(title) {
  var text = String(title || PUBLISH_PLACEHOLDER_TITLE_);
  try {
    var html = '<html><head><meta charset="utf-8"></head><body style="font-family:sans-serif;'
      + 'text-align:center;padding-top:200px;font-size:28px;">' + text + '</body></html>';
    return Utilities.newBlob(html, 'text/html', 'placeholder.html').getAs('application/pdf');
  } catch (err) {
    return Utilities.newBlob(buildMinimalPdfText_([PUBLISH_PLACEHOLDER_ASCII_LINE_()]),
      'application/pdf', 'placeholder.pdf');
  }
}

/**
 * 用途：退回版佔位 PDF 嘅英文內文。寫成函式純粹係為咗集中一處，方便
 *   日後改字。
 * Args: （無）
 * Returns:
 *   {string} 只可以有 ASCII 字元——`buildMinimalPdfText_()` 用 Helvetica，
 *     寫中文出嚟係空白。
 */
function PUBLISH_PLACEHOLDER_ASCII_LINE_() {
  return 'Not published yet.';
}

/**
 * 用途：手砌一個最小、合法嘅一頁 PDF（Helvetica、ASCII）。**純函式**。
 *
 *   ⚠️ `xref` 表入面每個物件嘅位元組位移一定要啱，所以要一路砌一路
 *   累加長度，唔可以事後估。呢個函式刻意唔用任何 Apps Script 服務，
 *   方便單獨測試「頭四個位元組係咪 `%PDF`」。
 * Args:
 *   lines {string[]} 要印嘅文字行（ASCII）。
 * Returns:
 *   {string} 完整嘅 PDF 檔案內容（latin-1 安全，全部係 ASCII）。
 */
function buildMinimalPdfText_(lines) {
  var textLines = (lines || []).map(function (line) {
    return String(line).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  });
  if (textLines.length === 0) textLines = [''];

  var stream = 'BT /F1 18 Tf 72 720 Td 22 TL\n'
    + textLines.map(function (t) { return '(' + t + ') Tj T*'; }).join('\n')
    + '\nET';

  var objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    '<< /Length ' + stream.length + ' >>\nstream\n' + stream + '\nendstream',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ];

  var out = '%PDF-1.4\n';
  var offsets = [];
  objects.forEach(function (body, i) {
    offsets.push(out.length);
    out += (i + 1) + ' 0 obj\n' + body + '\nendobj\n';
  });

  var xrefOffset = out.length;
  out += 'xref\n0 ' + (objects.length + 1) + '\n0000000000 65535 f \n';
  offsets.forEach(function (offset) {
    var padded = String(offset);
    while (padded.length < 10) padded = '0' + padded;
    out += padded + ' 00000 n \n';
  });
  out += 'trailer\n<< /Size ' + (objects.length + 1) + ' /Root 1 0 R >>\nstartxref\n' + xrefOffset + '\n%%EOF\n';
  return out;
}

/**
 * 用途：喺指定資料夾建立 master PDF 檔案，並設成「知道連結的人可檢視」。
 *
 *   ⚠️ 權限係 `ANYONE_WITH_LINK` ＋ `VIEW`，**唔係** `EDIT`：條連結會
 *   放上教會網站，任何人都拎得到。可編輯等於畀全世界改教會週報。
 * Args:
 *   fileName {string} 檔名（Config `PUBLISHED_PDF_NAME`）。
 *   folderId {string} 目標資料夾 ID。
 *   blob {Blob} 佔位 PDF 內容。
 * Returns:
 *   {{fileId:string, sharingApplied:boolean, sharingError:string}}
 * Raises:
 *   Error 如果資料夾開唔到或者建立唔到檔案（原樣拋出，由呼叫方分類）。
 */
function createMasterPdfFile_(fileName, folderId, blob) {
  var folder = DriveApp.getFolderById(String(folderId || '').trim());
  var file = folder.createFile(blob.setName(fileName));

  // 分享失敗唔可以令成個建立流程失敗：檔案已經喺度，人手補設權限就得。
  // 硬拋錯只會留低一個「建立咗但登記唔到」嘅孤兒檔案。
  var sharingApplied = false;
  var sharingError = '';
  try {
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    sharingApplied = true;
  } catch (err) {
    sharingError = (err && err.message) ? err.message : String(err);
  }

  return { fileId: file.getId(), sharingApplied: sharingApplied, sharingError: sharingError };
}

/**
 * 用途：查一個檔案 ID 而家仲開唔開得到。
 * Args:
 *   fileId {string} 檔案 ID。
 * Returns:
 *   {{exists:boolean, fileName:string}} 開唔到回 `{exists:false, fileName:''}`，
 *     **唔拋錯**——呼叫方要分得出「未建立過」同「建立過但而家開唔到」。
 */
function probeMasterPdfFile_(fileId) {
  var id = String(fileId || '').trim();
  if (!id) return { exists: false, fileName: '' };
  try {
    var file = DriveApp.getFileById(id);
    return { exists: true, fileName: file.getName() };
  } catch (err) {
    return { exists: false, fileName: '' };
  }
}

/**
 * 用途：原地覆寫 master PDF 檔案嘅內容，並把檔名設回指定值。**檔案 ID
 *   前後唔變**，所以條連結唔變（R-001 個核心承諾）。
 *
 *   ⚠️ 一定要行 `Drive.Files.update()`（進階服務）。理由同「唔可以用
 *   `setContent()`」嘅說明見檔頭。`title` 一併喺同一次呼叫傳埋，
 *   慳返一次 API，亦避免「內容已經換咗但檔名仲係舊嗰個」嘅中間狀態。
 * Args:
 *   fileId {string} master 檔案 ID。
 *   blob {Blob} 新內容（PDF）。
 *   fileName {string} 要設嘅檔名。
 * Returns:
 *   {{fileId:string}} 回傳嘅 ID 一定同傳入嗰個一樣；唔一樣就代表出咗事。
 * Raises:
 *   Error 進階服務未啟用（`ReferenceError`）、冇權限、檔案被刪——一律
 *     原樣拋出，由 `classifyPublishError_()` 分類成人睇得明嘅訊息。
 */
function overwriteMasterPdf_(fileId, blob, fileName) {
  var id = String(fileId || '').trim();
  var updated = Drive.Files.update({ title: String(fileName || '') }, id, blob);
  return { fileId: (updated && updated.id) ? updated.id : id };
}

/**
 * 用途：把今次發佈嘅 PDF 存一份副本落存檔資料夾（R-009）。
 * Args:
 *   blob {Blob} PDF 內容。
 *   fileName {string} 副本檔名（`buildArchiveFileName_()` 砌好）。
 *   archiveFolderId {string} 存檔資料夾 ID。
 * Returns:
 *   {{fileId:string, fileUrl:string}}
 * Raises:
 *   Error 如果資料夾開唔到（原樣拋出）。
 */
function saveArchivePdfCopy_(blob, fileName, archiveFolderId) {
  var folder = DriveApp.getFolderById(String(archiveFolderId || '').trim());
  var file = folder.createFile(blob.setName(fileName));
  return { fileId: file.getId(), fileUrl: file.getUrl() };
}
