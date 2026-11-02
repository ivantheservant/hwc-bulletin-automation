/**
 * src/YearLogo.gs
 *
 * 2026-11-02（Ivan）：Config `YEAR_LOGO_FILE_ID`——每一兩年換一次的年度 logo 不用逐個 Word 範本改圖。
 *
 *   四個範本封面的年度 logo 圖片在 Word 標了替代文字 `YEAR_LOGO`（`<wp:docPr descr="YEAR_LOGO">`）。Config 填了
 *   雲端硬碟上一張 JPG／PNG 的檔案 ID，產生 Word 時：
 *     1. 找出替代文字是 `YEAR_LOGO` 的每一個 `<w:drawing>`，取它 `<a:blip r:embed>` 的關係 ID；
 *     2. 圖片加入 zip 成為 `word/media/year_logo.png`（或 `.jpeg`，按圖片的內容類型）；
 *     3. `word/_rels/document.xml.rels` 那一個關係的 Target 改指新圖；同一個關係 ID 亦被其他（不是 YEAR_LOGO 的）
 *        圖用到的話，不改那一個，另加一個新的關係 ID，只改 YEAR_LOGO 那幾個 `r:embed`；
 *     4. `[Content_Types].xml` 沒有那個副檔名的 `<Default>` 就補上。
 *   圖的框（`<wp:extent>`）一律不改：新圖縮放到範本原本的框（8.43×3.24 cm），比例不同會變形（Config 說明有寫）。
 *
 *   本檔案只有純函式（字串進、字串出）。讀雲端硬碟（`readYearLogoImage_()`）與改 zip 在 src/DocxIo.gs——全系統只有
 *   那一個檔案准許用 `DriveApp`。換不到（Config 填了而檔案讀不到、不是 JPG／PNG、範本沒有 YEAR_LOGO 圖）一律不阻止
 *   產生，但出警告（`generateBulletinDocx_()` 的 `warnings`，代碼 `YEAR_LOGO_*`）。
 */

'use strict';

/** 範本內年度 logo 圖片的替代文字（Word：圖片 ▸ 編輯替代文字）。 */
var YEAR_LOGO_ALT_TEXT_ = 'YEAR_LOGO';

/** 新圖在 zip 內的檔名（不含副檔名）。 */
var YEAR_LOGO_MEDIA_BASENAME_ = 'year_logo';

/** 範本的主文件關係檔。 */
var DOCX_DOCUMENT_RELS_ENTRY_ = 'word/_rels/document.xml.rels';

/** 圖片關係的 Type。 */
var DOCX_IMAGE_RELATIONSHIP_TYPE_ = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image';

/**
 * 用途：年度 logo 圖片的內容類型 → zip 內用的副檔名。只接受 PNG 與 JPEG（Word 一定認得）。純函式。
 * Args:
 *   contentType {string} 例如 `image/png`。
 * Returns:
 *   {string} `'png'`／`'jpeg'`；其他類型回空字串。
 */
function yearLogoImageExtension_(contentType) {
  var ct = String(contentType || '').trim().toLowerCase();
  if (ct === 'image/png') return 'png';
  if (ct === 'image/jpeg' || ct === 'image/jpg') return 'jpeg';
  return '';
}

/**
 * 用途：把字串轉成可以放進正規表示式的字面值。純函式。
 * Args:
 *   text {string}
 * Returns:
 *   {string}
 */
function escapeRegExpText_(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 用途：找出 `document.xml` 內替代文字是 `YEAR_LOGO` 的每一個 `<w:drawing>`，連同它用到的圖片關係 ID。純函式。
 * Args:
 *   documentXml {string}
 * Returns:
 *   {{start:number, end:number, xml:string, embeds:string[]}[]} `start`／`end` 是在 `documentXml` 的位置。
 */
function findYearLogoDrawings_(documentXml) {
  var xml = String(documentXml || '');
  var out = [];
  var drawing = /<w:drawing\b[\s\S]*?<\/w:drawing>/g;
  var docPr = new RegExp('<wp:docPr\\b[^>]*\\bdescr="' + escapeRegExpText_(YEAR_LOGO_ALT_TEXT_) + '"');
  var m;
  while ((m = drawing.exec(xml)) !== null) {
    if (!docPr.test(m[0])) continue;
    var embeds = [];
    var blip = /<a:blip\b[^>]*\br:embed="([^"]+)"/g;
    var b;
    while ((b = blip.exec(m[0])) !== null) {
      if (embeds.indexOf(b[1]) === -1) embeds.push(b[1]);
    }
    out.push({ start: m.index, end: m.index + m[0].length, xml: m[0], embeds: embeds });
  }
  return out;
}

/**
 * 用途：數一段 XML 內某一個關係 ID 被引用了幾次（`r:embed`／`r:link`／`r:id`／`r:pict`）。純函式。
 * Args:
 *   xml {string}　relId {string}
 * Returns:
 *   {number}
 */
function countRelationshipRefs_(xml, relId) {
  var re = new RegExp('\\br:(?:embed|link|id|pict)="' + escapeRegExpText_(relId) + '"', 'g');
  return (String(xml || '').match(re) || []).length;
}

/**
 * 用途：把年度 logo 換成新圖要改的三份 XML 與新圖在 zip 內的路徑。純函式（不碰 zip、不碰雲端硬碟）。
 * Args:
 *   input {{documentXml:string, relsXml:string, contentTypesXml:string, entryNames:string[], contentType:string}}
 *     `entryNames`：zip 內現有的全部檔名（避免新圖與現有檔案同名）；`contentType`：新圖的內容類型。
 * Returns:
 *   {{ok:boolean, reason:string, documentXml:string, relsXml:string, contentTypesXml:string, mediaPath:string,
 *     drawingCount:number, retargeted:string[], addedRelIds:string[]}}
 *     `reason`（`ok:false` 時）：`NOT_IMAGE`（不是 PNG／JPEG）／`NO_LOGO`（範本沒有 YEAR_LOGO 圖）／
 *     `NO_EMBED`（YEAR_LOGO 圖沒有 `a:blip r:embed`）／`REL_NOT_FOUND`（關係檔沒有那一個 ID）。
 *     `ok:false` 時三份 XML 原樣回傳。
 */
function applyYearLogoToDocxParts_(input) {
  var o = input || {};
  var documentXml = String(o.documentXml || '');
  var relsXml = String(o.relsXml || '');
  var contentTypesXml = String(o.contentTypesXml || '');
  var result = {
    ok: false, reason: '', documentXml: documentXml, relsXml: relsXml, contentTypesXml: contentTypesXml,
    mediaPath: '', drawingCount: 0, retargeted: [], addedRelIds: []
  };
  var ext = yearLogoImageExtension_(o.contentType);
  if (!ext) { result.reason = 'NOT_IMAGE'; return result; }
  var drawings = findYearLogoDrawings_(documentXml);
  result.drawingCount = drawings.length;
  if (drawings.length === 0) { result.reason = 'NO_LOGO'; return result; }
  var relIds = [];
  drawings.forEach(function (d) { d.embeds.forEach(function (id) { if (relIds.indexOf(id) === -1) relIds.push(id); }); });
  if (relIds.length === 0 || drawings.some(function (d) { return d.embeds.length === 0; })) {
    result.reason = 'NO_EMBED';
    return result;
  }
  function relElement(id) {
    var re = new RegExp('<Relationship\\b[^>]*\\bId="' + escapeRegExpText_(id) + '"[^>]*>');
    return re.exec(relsXml);
  }
  if (relIds.some(function (id) { return !relElement(id); })) { result.reason = 'REL_NOT_FOUND'; return result; }

  // 新圖的檔名：與 zip 內現有的檔案不可以同名（不分大小寫）。
  var existing = (o.entryNames || []).map(function (n) { return String(n || '').toLowerCase().replace(/\\/g, '/'); });
  var fileName = YEAR_LOGO_MEDIA_BASENAME_ + '.' + ext;
  for (var n = 2; existing.indexOf('word/media/' + fileName.toLowerCase()) !== -1; n++) {
    fileName = YEAR_LOGO_MEDIA_BASENAME_ + '_' + n + '.' + ext;
  }
  var target = 'media/' + fileName;

  // 關係：只被 YEAR_LOGO 圖用到的 → 改 Target；亦被其他圖用到的 → 另加一個新 ID，只改 YEAR_LOGO 那幾個 r:embed。
  var logoXml = drawings.map(function (d) { return d.xml; }).join('');
  var newDocument = documentXml;
  var newRels = relsXml;
  var usedIds = [];
  var idRe = /<Relationship\b[^>]*\bId="([^"]+)"/g;
  var im;
  while ((im = idRe.exec(relsXml)) !== null) usedIds.push(im[1]);
  var newRelXml = '';
  relIds.forEach(function (id) {
    var shared = countRelationshipRefs_(documentXml, id) > countRelationshipRefs_(logoXml, id);
    if (!shared) {
      newRels = newRels.replace(relElement(id)[0], function (el) {
        return el.replace(/\bTarget="[^"]*"/, 'Target="' + target + '"').replace(/\s+TargetMode="[^"]*"/, '');
      });
      result.retargeted.push(id);
      return;
    }
    var k = 1;
    while (usedIds.indexOf('rIdYearLogo' + k) !== -1) k++;
    var newId = 'rIdYearLogo' + k;
    usedIds.push(newId);
    newRelXml += '<Relationship Id="' + newId + '" Type="' + DOCX_IMAGE_RELATIONSHIP_TYPE_ + '" Target="' + target + '"/>';
    result.addedRelIds.push(newId);
    // 只改 YEAR_LOGO 那幾個 drawing 內的引用（由後面改起，位置不會移）。
    var embedRe = new RegExp('(\\br:embed=")' + escapeRegExpText_(id) + '"', 'g');
    for (var i = drawings.length - 1; i >= 0; i--) {
      var d = drawings[i];
      var replaced = newDocument.slice(d.start, d.end).replace(embedRe, '$1' + newId + '"');
      newDocument = newDocument.slice(0, d.start) + replaced + newDocument.slice(d.end);
      drawings[i] = { start: d.start, end: d.start + replaced.length, xml: replaced, embeds: d.embeds };
      for (var j = i + 1; j < drawings.length; j++) {
        drawings[j].start += replaced.length - d.xml.length;
        drawings[j].end += replaced.length - d.xml.length;
      }
    }
  });
  if (newRelXml) {
    newRels = /<\/Relationships>\s*$/.test(newRels)
      ? newRels.replace(/<\/Relationships>\s*$/, newRelXml + '</Relationships>')
      : newRels.replace(/<Relationships\b([^>]*)\/>/, '<Relationships$1>' + newRelXml + '</Relationships>');
  }

  // 內容類型：沒有這個副檔名的 <Default> 就補上（大小寫不分）。
  var newTypes = contentTypesXml;
  var hasDefault = new RegExp('<Default\\b[^>]*\\bExtension="' + ext + '"', 'i').test(contentTypesXml);
  if (!hasDefault) {
    var def = '<Default Extension="' + ext + '" ContentType="' + (ext === 'png' ? 'image/png' : 'image/jpeg') + '"/>';
    newTypes = /<Types\b[^>]*\/>/.test(newTypes)
      ? newTypes.replace(/<Types\b([^>]*)\/>/, '<Types$1>' + def + '</Types>')
      : newTypes.replace(/<Types\b[^>]*>/, function (open) { return open + def; });
  }

  result.ok = true;
  result.documentXml = newDocument;
  result.relsXml = newRels;
  result.contentTypesXml = newTypes;
  result.mediaPath = 'word/' + target;
  return result;
}

/**
 * 用途：年度 logo 換不到時的警告字眼（產生 Word 的結果 `warnings` 用；對話框、批次報告、填寫介面照列）。純函式。
 * Args:
 *   reason {string} `readYearLogoImage_()` 或 `applyYearLogoToDocxParts_()` 的 `reason`。
 *   detail {{templateLabel:string=, contentType:string=, error:string=, maskedId:string=}=}
 * Returns:
 *   {{code:string, message:string}}
 */
function buildYearLogoWarning_(reason, detail) {
  var d = detail || {};
  var keep = '這一份 Word 用範本內原本的圖。';
  if (reason === 'UNREADABLE') {
    return { code: 'YEAR_LOGO_UNREADABLE', message: '年度 logo：讀不到 Config YEAR_LOGO_FILE_ID 的圖片（ID 開頭 '
      + (d.maskedId || '') + '）：' + (d.error || '未知原因') + '。' + keep + '請檢查檔案 ID，以及本系統的帳戶有沒有那個檔案的檢視權限。' };
  }
  if (reason === 'NOT_IMAGE') {
    return { code: 'YEAR_LOGO_NOT_IMAGE', message: '年度 logo：Config YEAR_LOGO_FILE_ID 的檔案不是 JPG 或 PNG 圖片（現在是 '
      + (d.contentType || '不明類型') + '）。' + keep + '請上載 JPG 或 PNG，再把新檔案的 ID 填入 Config。' };
  }
  if (reason === 'NO_LOGO') {
    return { code: 'YEAR_LOGO_NOT_IN_TEMPLATE', message: '年度 logo：Config YEAR_LOGO_FILE_ID 已填，但「' + (d.templateLabel || '這一個')
      + '」範本沒有替代文字是 YEAR_LOGO 的圖片，所以沒有換。請在 Word 範本的年度 logo 按右鍵 ▸ 檢視替代文字，填 YEAR_LOGO。' };
  }
  return { code: 'YEAR_LOGO_NOT_APPLIED', message: '年度 logo：「' + (d.templateLabel || '這一個') + '」範本的 YEAR_LOGO 圖片結構認不出（'
    + reason + '），所以沒有換。' + keep + '請在 Word 把那張圖刪走、重新插入，再填替代文字 YEAR_LOGO。' };
}

/**
 * 用途：由產生 Word 的結果 `warnings` 取出年度 logo 那幾句（對話框與批次報告用）。純函式。
 * Args:
 *   warnings {?{code:string, message:string}[]}
 * Returns:
 *   {string[]}
 */
function yearLogoWarningMessages_(warnings) {
  return (warnings || []).filter(function (w) { return String((w || {}).code || '').indexOf('YEAR_LOGO_') === 0; })
    .map(function (w) { return String(w.message || ''); });
}
