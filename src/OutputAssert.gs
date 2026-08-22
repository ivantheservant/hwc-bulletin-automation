/**
 * OutputAssert.gs
 *
 * 第 4 層：**產出實物斷言**——凡是產出檔案，一律**重新讀取產出物本身**
 * 來斷言，不准用「我替換了幾多個」倒推。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 為甚麼
 * ─────────────────────────────────────────────────────────────────────
 *
 *   已經出現過「報告說殘留 0，實際有 3」（docs/已知bug類型.md 事故
 *   二十二）。根因：`replacedCount`／`missingKeys`／`broken` 三個數字
 *   全部由渲染流程**自己**算，用的是跟渲染完全同一套假設。假設一旦錯，
 *   三個數字會**一齊錯、一齊報沒事**。
 *
 *   所以這個檔案的每一支函式都遵守同一條規矩：
 *
 *     **輸入是產出物（檔案 ID 或 blob），不是渲染過程的統計。**
 *
 *   它重新解壓、重新解析、重新數。它不知道、也不需要知道那份檔案是
 *   怎樣造出來的——這正是它抓得到渲染流程盲點的原因。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ⚠️ 「讀不到」與「沒問題」是兩件事
 * ─────────────────────────────────────────────────────────────────────
 *
 *   每一支斷言都回一個 `ok` 欄位：`false` 代表**讀不到／驗不到**（檔案
 *   開不到、不是合法的 zip、服務不可用），這時其餘欄位一律不可信。
 *   `ok:true` 才代表「真的驗過了」，那時候 `residualPlaceholders` 等數字
 *   才有意義。混為一談就等於自己騙自己。
 */

'use strict';

/**
 * 用途：斷言一份已經產生好的 `.docx`。**重新讀取產出物本身。**
 * Args:
 *   fileId {string} Drive 檔案 ID。
 * Returns:
 *   {{ok:boolean, message:string, fileId:string, fileName:string, bytes:number,
 *     scannedParts:number, residualPlaceholders:number, residualSamples:string[],
 *     residualParts:string[], variantChars:number, variantSamples:string[],
 *     emptyTables:Object[], orphanLabels:string[], pageCountHint:?number,
 *     fontsUsed:string[]}}
 *     `ok:false` 時只有 `message` 有意義。
 */
function assertDocxOutput_(fileId) {
  var id = String(fileId || '').trim();
  var empty = assertDocxOutputEmptyResult_(id);

  if (!id) {
    empty.message = '沒有提供檔案 ID，無法斷言產出。';
    return empty;
  }

  // ⚠️ 讀檔案那一步在 `src/DocxIo.gs`：`DriveApp` 受
  // `tools/lint-readonly-roster.js` 規則 3 管制，只准出現在四個指定
  // 檔案。本檔案是純粹的「斷言」層，不應該為了讀一個檔案而變成第五個
  // 高權限檔案——那會令「有沒有人用 Drive 繞過職事表唯讀邊界」要審的
  // 檔案又多一個。
  var read = readOutputDocxById_(id);
  if (!read.ok) {
    empty.message = read.message;
    return empty;
  }

  var result = assertDocxBlob_(read.blob);
  result.fileId = id;
  result.fileName = read.fileName;
  return result;
}

/**
 * 用途：`assertDocxOutput_()` 的 blob 版本——發佈流程手上已經有 blob
 *   （還未存檔）時直接用這一支，不必先寫入 Drive 再讀回來。
 * Args:
 *   blob {Blob} `.docx` 的內容。
 * Returns:
 *   {Object} 同 `assertDocxOutput_()`。
 */
function assertDocxBlob_(blob) {
  var result = assertDocxOutputEmptyResult_('');

  try {
    result.bytes = blob.getBytes().length;
  } catch (bytesErr) {
    result.message = '讀不到 blob 的位元組：' + ((bytesErr && bytesErr.message) ? bytesErr.message : String(bytesErr));
    return result;
  }

  var entries;
  try {
    entries = unzipDocx_(blob);
  } catch (err) {
    result.message = '產出檔案解壓失敗（不是合法的 .docx？）：'
      + ((err && err.message) ? err.message : String(err));
    return result;
  }

  var residualSeen = {};
  var variantSeen = {};
  var fontsSeen = {};
  var sectPrCount = 0;
  var pageBreakCount = 0;

  entries.forEach(function (entry) {
    if (!isDocxTextPartName_(entry.name)) return;

    var xml;
    try {
      xml = entry.blob.getDataAsString('UTF-8');
    } catch (readErr) {
      return; // 個別部件讀不到，不應該令整份斷言失敗；下面的 scannedParts 會反映
    }
    result.scannedParts++;

    // ---- 殘留佔位符 ----
    // ⚠️ 用同一支 scanResidualPlaceholders_()，但輸入是**產出物**而不是
    // 渲染中途的字串——關鍵在資料來源，不在函式。
    var residual = scanResidualPlaceholders_(xml);
    if (residual.count > 0) {
      result.residualPlaceholders += residual.count;
      result.residualParts.push(entry.name);
      residual.samples.forEach(function (s) {
        if (residualSeen[s] || result.residualSamples.length >= 10) return;
        residualSeen[s] = true;
        result.residualSamples.push(s);
      });
    }

    // ---- 異體字 ----
    var variant = normalizeVariantCharacters_(xml);
    if (variant.count > 0) {
      result.variantChars += variant.count;
      Object.keys(variant.breakdown).forEach(function (correctChar) {
        if (variantSeen[correctChar]) return;
        variantSeen[correctChar] = true;
        result.variantSamples.push('應該是「' + correctChar + '」的異體字 ' + variant.breakdown[correctChar] + ' 個');
      });
    }

    // ---- 空表格與孤兒標籤 ----
    docxScanEmptyTables_(xml).forEach(function (t) {
      result.emptyTables.push({ part: entry.name, headerText: t.headerText, rowCount: t.rowCount });
    });
    docxScanOrphanLabels_(xml).forEach(function (labelText) {
      if (result.orphanLabels.length >= 20) return;
      result.orphanLabels.push(labelText);
    });

    // ---- 頁數線索與字型 ----
    sectPrCount += docxCountOccurrences_(xml, '<w:sectPr');
    pageBreakCount += docxCountOccurrences_(xml, 'w:type="page"');
    docxScanFonts_(xml).forEach(function (font) { fontsSeen[font] = true; });
  });

  result.fontsUsed = Object.keys(fontsSeen).sort();
  result.pageCountHint = docxPageCountHint_(sectPrCount, pageBreakCount);
  result.ok = result.scannedParts > 0;
  result.message = result.ok
    ? ('已重新解壓並掃描 ' + result.scannedParts + ' 個 XML 部件。')
    : '解壓成功但找不到任何 document.xml／header／footer 部件——這不是一份正常的 .docx。';
  return result;
}

/**
 * 用途：`assertDocxOutput_()` 的空結果骨架。集中一處，避免各分支各自砌
 *   一個形狀不同的物件（呼叫方就要逐個欄位防禦）。
 * Args:
 *   fileId {string} 檔案 ID。
 * Returns:
 *   {Object}
 */
function assertDocxOutputEmptyResult_(fileId) {
  return {
    ok: false,
    message: '',
    fileId: String(fileId || ''),
    fileName: '',
    bytes: 0,
    scannedParts: 0,
    residualPlaceholders: 0,
    residualSamples: [],
    residualParts: [],
    variantChars: 0,
    variantSamples: [],
    emptyTables: [],
    orphanLabels: [],
    pageCountHint: null,
    fontsUsed: []
  };
}

/**
 * 用途：數一個子字串在文字內出現幾多次。**純函式。**
 *   （刻意不用正規表示式：要數的都是字面上的標記，`indexOf` 迴圈最不會
 *   因為跳脫字元寫錯而靜靜數少。）
 * Args:
 *   text {string} 要搜尋的文字。
 *   needle {string} 子字串。
 * Returns:
 *   {number}
 */
function docxCountOccurrences_(text, needle) {
  var haystack = String(text || '');
  var target = String(needle || '');
  if (!target) return 0;

  var count = 0;
  var idx = haystack.indexOf(target);
  while (idx !== -1) {
    count++;
    idx = haystack.indexOf(target, idx + target.length);
  }
  return count;
}

/**
 * 用途：由 `sectPr` 與分頁符推算頁數。**純函式，只是線索，不是真頁數。**
 *
 *   ⚠️ Word 的實際頁數要排版引擎跑完才知道，OOXML 裡面根本沒有存。
 *   這裡回的是「至少幾多頁」的下限估算：每個 `w:sectPr`（節）至少一頁，
 *   每個明確的分頁符再加一頁。推算不到就回 `null`——**不可以回 0 假裝
 *   自己知道**。
 * Args:
 *   sectPrCount {number} `<w:sectPr` 出現次數。
 *   pageBreakCount {number} `w:type="page"` 出現次數。
 * Returns:
 *   {?number}
 */
function docxPageCountHint_(sectPrCount, pageBreakCount) {
  var sections = Number(sectPrCount) || 0;
  var breaks = Number(pageBreakCount) || 0;
  if (sections === 0 && breaks === 0) return null;
  return Math.max(sections, 1) + breaks;
}

/**
 * 用途：找出「只有標題行、沒有資料行」的表格。**純函式。**
 *
 *   ⚠️ 這一類表格在紙上的樣子是「一個框，入面得個標題，下面一片空白」
 *   ——渲染流程不會報錯（它成功地展開了 0 行），但印出來明顯不對。
 *   這正是「報告說沒事，成品其實有事」那一類。
 * Args:
 *   xml {string} 一個 XML 部件的內容。
 * Returns:
 *   {{headerText:string, rowCount:number}[]}
 */
function docxScanEmptyTables_(xml) {
  var text = String(xml || '');
  var found = [];
  var tableRegex = /<w:tbl>[\s\S]*?<\/w:tbl>/g;
  var match;

  while ((match = tableRegex.exec(text)) !== null) {
    var tableXml = match[0];
    var rowCount = docxCountOccurrences_(tableXml, '<w:tr>') + docxCountOccurrences_(tableXml, '<w:tr ');
    if (rowCount > 1) continue;

    // 只有 0 或 1 行：取那一行的文字當作「標題」，讓報告拿得出實際內容。
    var headerText = docxExtractPlainText_(tableXml).trim();
    if (!headerText) continue; // 完全空白的表格多數是版面用的框，不算問題
    found.push({ headerText: headerText.slice(0, 60), rowCount: rowCount });
  }
  return found;
}

/**
 * 用途：找出「有標籤、無值」的孤兒行——例如紙上剩下一句「講員：」
 *   後面甚麼都沒有。**純函式。**
 *
 *   ⚠️ 判斷方式刻意保守：一個段落的**全部**文字加起來，去掉空白之後
 *   剛好以全形冒號或半形冒號結尾、而且長度不超過
 *   `DOCX_ORPHAN_LABEL_MAX_CHARS_`，才算孤兒標籤。放寬的話，正文裡面
 *   任何一句以冒號結尾的話（例如「以下三項：」）都會被誤報。
 * Args:
 *   xml {string} 一個 XML 部件的內容。
 * Returns:
 *   {string[]}
 */
function docxScanOrphanLabels_(xml) {
  var text = String(xml || '');
  var found = [];
  var paragraphRegex = /<w:p[ >][\s\S]*?<\/w:p>/g;
  var match;

  while ((match = paragraphRegex.exec(text)) !== null) {
    var plain = docxExtractPlainText_(match[0]).replace(/\s+/g, '');
    if (!plain || plain.length > DOCX_ORPHAN_LABEL_MAX_CHARS_) continue;

    var lastChar = plain.charAt(plain.length - 1);
    if (lastChar !== '：' && lastChar !== ':') continue;
    found.push(plain);
  }
  return found;
}

/** 孤兒標籤最多幾多個字元。超過就當成正文，不報。 */
var DOCX_ORPHAN_LABEL_MAX_CHARS_ = 12;

/**
 * 用途：把一段 OOXML 內的 `<w:t>` 文字抽出來串成純文字。**純函式。**
 * Args:
 *   xml {string} 一段 OOXML。
 * Returns:
 *   {string}
 */
function docxExtractPlainText_(xml) {
  var text = String(xml || '');
  var parts = [];
  var regex = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g;
  var match;

  while ((match = regex.exec(text)) !== null) {
    parts.push(match[1]);
  }
  return parts.join('')
    .split('&lt;').join('<')
    .split('&gt;').join('>')
    .split('&amp;').join('&');
}

/**
 * 用途：列出一個部件用到的字型名稱。**純函式。**
 *
 *   用途是核對「週報那 18 款字型有沒有全部被帶進產出」——範本渲染理論上
 *   不會動字型，但 XML 被改壞的時候這一欄看得出端倪。
 * Args:
 *   xml {string} 一個 XML 部件的內容。
 * Returns:
 *   {string[]}
 */
function docxScanFonts_(xml) {
  var text = String(xml || '');
  var fonts = {};
  var regex = /w:(?:ascii|hAnsi|eastAsia|cs)="([^"]+)"/g;
  var match;

  while ((match = regex.exec(text)) !== null) {
    fonts[match[1]] = true;
  }
  return Object.keys(fonts);
}

// =====================================================================
// PDF
// =====================================================================

/**
 * 用途：斷言一份 PDF。**重新讀取內容本身**，不信任何人講的話。
 * Args:
 *   blob {Blob} PDF 內容。
 * Returns:
 *   {{ok:boolean, message:string, bytes:number, hasPdfHeader:boolean,
 *     pageCount:?number, fingerprint:string}}
 */
function assertPdfOutput_(blob) {
  var result = {
    ok: false, message: '', bytes: 0,
    hasPdfHeader: false, pageCount: null, fingerprint: ''
  };

  var bytes;
  try {
    bytes = blob.getBytes();
  } catch (err) {
    result.message = '讀不到 PDF 的位元組：' + ((err && err.message) ? err.message : String(err));
    return result;
  }

  result.bytes = bytes.length;
  if (bytes.length === 0) {
    result.message = 'PDF 是 0 個位元組——不是一份可以發佈的檔案。';
    return result;
  }

  // ⚠️ 檔頭比對用 `& 0xFF`：Apps Script 的位元組是 signed（-128..127）。
  var magic = [0x25, 0x50, 0x44, 0x46]; // %PDF
  result.hasPdfHeader = bytes.length >= 4 && magic.every(function (expected, i) {
    return (Number(bytes[i]) & 0xFF) === expected;
  });
  if (!result.hasPdfHeader) {
    result.message = '檔頭不是 %PDF——這不是一份 PDF（副檔名叫甚麼並不作準）。';
    return result;
  }

  result.pageCount = pdfCountPages_(bytes);
  result.fingerprint = pdfFingerprint_(bytes);
  result.ok = true;
  result.message = 'PDF 檔頭正確、' + result.bytes + ' 個位元組、'
    + (result.pageCount === null ? '頁數數不到' : ('約 ' + result.pageCount + ' 頁')) + '。';
  return result;
}

/**
 * 用途：數一份 PDF 有幾多頁。**純函式。**
 *
 *   做法：把位元組當 latin-1 文字看，數 `/Type /Page` 這個物件標記。
 *
 *   ⚠️ 這是**下限估算**，不是精準頁數：PDF 可以把物件壓縮進 object
 *   stream，那時候標記根本不在明文裡面。數不到就回 `null`——
 *   **不可以回 0 假裝自己知道**（0 頁會被下游當成「空檔案」而誤報）。
 * Args:
 *   bytes {number[]} PDF 的位元組。
 * Returns:
 *   {?number}
 */
function pdfCountPages_(bytes) {
  var list = bytes || [];
  if (list.length === 0) return null;

  var chars = [];
  for (var i = 0; i < list.length; i++) {
    chars.push(String.fromCharCode(Number(list[i]) & 0xFF));
  }
  var text = chars.join('');

  // `/Type /Page` 與 `/Type/Page` 兩種寫法都合法；`/Type /Pages`（目錄
  // 節點）不是一頁，所以要排除掉——用「後面不是 s」來分辨。
  var count = 0;
  var regex = /\/Type\s*\/Page(?![s])/g;
  while (regex.exec(text) !== null) count++;

  return count > 0 ? count : null;
}

// =====================================================================
// 排版成報告
// =====================================================================

/**
 * 用途：把 `assertDocxOutput_()` 的結果排版成報告內容行。**純函式。**
 *
 *   ⚠️ 每一項都印出**實際的值**，不只印「有問題」——「殘留 3 個」要連
 *   那三個是甚麼一齊講，否則看的人還是要自己去查。
 * Args:
 *   assertion {Object} `assertDocxOutput_()` 的回傳值。
 * Returns:
 *   {string[]}
 */
function buildDocxAssertionLines_(assertion) {
  var a = assertion || {};
  if (!a.ok) {
    return ['⚠️ 未能斷言產出：' + (a.message || '（沒有訊息）'),
      '　　「驗不到」不等於「沒問題」——請人手開啟那份檔案確認。'];
  }

  var lines = [];
  lines.push('產出斷言（重新讀取檔案本身，不是渲染過程報的數字）：');
  lines.push('　檔案：' + (a.fileName || '（blob）') + '　' + a.bytes + ' 個位元組　'
    + '掃描了 ' + a.scannedParts + ' 個 XML 部件');
  lines.push('　殘留佔位符：' + a.residualPlaceholders
    + (a.residualPlaceholders > 0 ? ('（' + a.residualSamples.join('、') + '）') : ''));
  lines.push('　異體字：' + a.variantChars
    + (a.variantChars > 0 ? ('（' + a.variantSamples.join('、') + '）') : ''));
  lines.push('　只有標題沒有資料的表格：' + a.emptyTables.length
    + (a.emptyTables.length > 0
      ? ('（' + a.emptyTables.map(function (t) { return t.headerText; }).join('、') + '）') : ''));
  lines.push('　有標籤無值的行：' + a.orphanLabels.length
    + (a.orphanLabels.length > 0 ? ('（' + a.orphanLabels.join('、') + '）') : ''));
  lines.push('　頁數線索：' + (a.pageCountHint === null ? '取不到' : (a.pageCountHint + ' 頁（下限估算）')));
  lines.push('　用到的字型：' + (a.fontsUsed.length > 0 ? a.fontsUsed.join('、') : '（沒有偵測到）'));
  return lines;
}
