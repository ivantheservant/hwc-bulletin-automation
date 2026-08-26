/**
 * InvariantDiagnose.gs
 *
 * 「診斷 I06」——把 I06 比對的**兩邊來源**、以及相關檔案的實際狀況全部
 * 打出來，寫入 `Diagnostics`。
 *
 * ⚠️ 為什麼要有這一支（docs/已知bug類型.md 事故三十三）：
 *   第二輪修完之後，I06 仍然報「1 條通道對不上（正式）」。那一句話看完
 *   之後，**仍然不知道要做什麼**——對不上的是版本號還是內容？兩邊分別
 *   取自哪裏？master 檔案是不是被人手改過？全部答不出。
 *
 *   一句「對不上」不是證據，是結論。要先有證據才改得動邏輯。
 *
 * ⚠️ **這支函式一個位元組都不會寫**（除了最後把報告寫入 `Diagnostics`）：
 *   全部 Drive 呼叫都是讀取。正式 master 檔案的內容與版本不會被碰。
 */

'use strict';

/**
 * 用途：收集「診斷 I06」要用的全部事實。**不寫任何檔案。**
 * Args:
 *   options {{fingerprintReader?:function, factsReader?:function,
 *             revisionLister?:function}} 測試注入點；正式流程一個都不傳。
 * Returns:
 *   {Object} 見 `buildI06DiagnosisLines_()` 怎樣用。
 */
function collectI06Diagnosis_(options) {
  var o = options || {};
  var resolveExpected = o.expectedResolver || resolvePublishExpectedFingerprint_;
  var readFacts = o.factsReader || readDriveFileFacts_;
  var listRevisions = o.revisionLister || driveListRevisions_;

  var out = {
    // 1
    latestRow: null,
    latestRowFields: [],
    // 2
    rowMasterFileId: '',
    configMasterFileId: String(getConfig(CONFIG_KEYS.PUBLISHED_PDF_FILE_ID, '') || '').trim(),
    rowMasterMatchesConfig: null,
    // 3
    archive: null,
    // 4
    master: null,
    // 5
    revisions: null,
    // 6
    comparison: null,
    // 7
    difference: null,
    notes: []
  };

  // ---- 1. PublishLog 最新一行**非自測**紀錄 ----
  var rows = readSheet(SHEETS.PUBLISH_LOG);
  var production = rows.filter(function (r) { return r.IS_SELFTEST !== true; });
  var latest = latestPublishLogRow_(production);

  if (!latest) {
    out.notes.push('PublishLog 沒有任何**非自測**的發佈紀錄（總行數 ' + rows.length + '），'
      + '所以 I06 的「正式」那一條通道根本沒有東西可以對——'
      + '它應該回「不適用」，不是「對不上」。');
    return out;
  }

  out.latestRow = latest;
  out.latestRowFields = COLUMNS.PUBLISH_LOG.keys.map(function (key) {
    return { key: key, value: publishLogValueForDiagnosis_(latest[key]) };
  });

  // ---- 2. 該行的 MASTER_FILE_ID vs Config ----
  out.rowMasterFileId = String(latest.MASTER_FILE_ID || '').trim();
  if (!out.rowMasterFileId) {
    out.notes.push('該行沒有 MASTER_FILE_ID（加欄之前的舊資料，而且一次性補寫沒有補到）。'
      + 'I06 唯有退回 Config 的 ' + CONFIG_KEYS.PUBLISHED_PDF_FILE_ID + ' 去猜。');
    out.rowMasterMatchesConfig = null;
  } else {
    out.rowMasterMatchesConfig = out.rowMasterFileId === out.configMasterFileId;
  }

  var compareFileId = out.rowMasterFileId || out.configMasterFileId;

  // ---- 3. 存檔副本 ----
  var archiveFileId = String(latest.ARCHIVE_FILE_ID || '').trim();
  if (!archiveFileId) {
    out.archive = { fileId: '', ok: false, message: '該行沒有 ARCHIVE_FILE_ID（當時存檔失敗，或者舊資料）。' };
  } else {
    var archiveFacts = readFacts(archiveFileId);
    out.archive = {
      fileId: archiveFileId,
      ok: archiveFacts.ok,
      fileName: archiveFacts.fileName,
      bytes: archiveFacts.bytes,
      fingerprint: archiveFacts.ok ? pdfFingerprint_(archiveFacts.blobBytes) : '',
      message: archiveFacts.message
    };
  }

  // ---- 4. master 檔案目前的實況 ----
  if (!compareFileId) {
    out.master = { fileId: '', ok: false, message: '推不出 master 檔案 ID（該行沒有記錄，Config 也是空的）。' };
  } else {
    var masterFacts = readFacts(compareFileId);
    out.master = {
      fileId: compareFileId,
      ok: masterFacts.ok,
      fileName: masterFacts.fileName,
      bytes: masterFacts.bytes,
      fingerprint: masterFacts.ok ? pdfFingerprint_(masterFacts.blobBytes) : '',
      lastUpdated: masterFacts.lastUpdated,
      lastModifiedBy: masterFacts.lastModifiedBy,
      mimeType: masterFacts.mimeType,
      message: masterFacts.message
    };
  }

  // ---- 5. Drive 版本記錄 ----
  out.revisions = compareFileId
    ? listRevisions(compareFileId, 10)
    : { ok: false, revisions: [], total: 0, message: '沒有檔案 ID，讀不到版本記錄。' };

  // ---- 6. I06 目前實際比對哪兩樣東西 ----
  // ⚠️ 左邊已經不再讀 Script Property（見事故三十六）：來源次序是
  //    「該行的 CONTENT_MD5」→「該行 ARCHIVE_FILE_ID 的實際指紋」→ 取不到。
  var expected = resolveExpected(latest);
  out.expected = expected;
  out.comparison = {
    leftName: '發佈當時的內容指紋（來源：'
      + (expected.sourceLabel || '取不到') + '）',
    leftValue: expected.fingerprint || '（取不到）',
    leftSourceLabel: expected.sourceLabel,
    leftReason: expected.reason,
    rightName: 'master 檔案目前內容的指紋（Drive 檔案 '
      + (compareFileId ? maskFileId_(compareFileId) : '（無）') + '）',
    rightValue: (out.master && out.master.ok) ? out.master.fingerprint : '（讀不到）',
    rowIsoDate: publishRowIsoDate_(latest),
    rowVersionNo: Number(latest.VERSION_NO || 0)
  };

  // ---- 7. 差在哪裏 ----
  out.difference = describeI06Difference_(out.comparison, out.master);

  return out;
}

/**
 * 用途：判斷 I06 兩邊到底差在哪裏。**純函式。**
 *
 *   ⚠️ 「其中一邊根本取不到」與「兩邊都有但不同」是**兩件事**，要分開報。
 *   前者是「未驗過」，後者才是「不一致」。
 * Args:
 *   comparison {Object} `collectI06Diagnosis_()` 的 `comparison`。
 *   master {?Object} 同上的 `master`。
 * Returns:
 *   {{kind:string, summary:string, detail:string}}
 *     `kind` 是 `SAME`／`VERSION_MISMATCH`／`CONTENT_MISMATCH`／`UNAVAILABLE`。
 */
function describeI06Difference_(comparison, master) {
  var c = comparison || {};

  if (!c.leftValue || c.leftValue === '（取不到）') {
    return {
      kind: 'UNAVAILABLE',
      summary: '取不到「發佈當時的內容指紋」',
      detail: (c.leftReason || '')
        + '　⚠️「取不到」不等於「內容不對」——這種情況 I06 應該報「驗證不到」。'
    };
  }
  if (!master || !master.ok) {
    return {
      kind: 'UNAVAILABLE',
      summary: '讀不到 master 檔案目前的內容',
      detail: (master && master.message) ? master.message : '（沒有原因）'
    };
  }

  if (c.leftValue === c.rightValue) {
    return {
      kind: 'SAME', summary: '兩邊完全相同',
      detail: '發佈當時的指紋來自' + (c.leftSourceLabel || '（沒有講明）') + '。'
    };
  }

  var left = splitPdfFingerprint_(c.leftValue);
  var right = splitPdfFingerprint_(c.rightValue);

  if (left.md5 && right.md5 && left.bytes !== right.bytes) {
    return {
      kind: 'CONTENT_MISMATCH',
      summary: '大小不同：發佈當時 ' + left.bytes + ' 位元組，現在 ' + right.bytes + ' 位元組',
      detail: '差 ' + Math.abs(right.bytes - left.bytes) + ' 位元組。'
        + '大小都變了，代表檔案內容真的被換過（不是編碼差異）。'
        + '發佈當時的指紋來自' + (c.leftSourceLabel || '（沒有講明）') + '。'
    };
  }

  return {
    kind: 'CONTENT_MISMATCH',
    summary: '大小相同（' + left.bytes + ' 位元組）但 MD5 不同',
    detail: '同樣長度、不同內容——通常代表檔案被另一份同樣大小的內容覆寫，'
      + '或者 Drive 重新編碼過。'
      + '發佈當時的指紋來自' + (c.leftSourceLabel || '（沒有講明）') + '。'
  };
}

/**
 * 用途：把 `PublishLog` 一格的值排成可以放進報告的文字。
 * Args:
 *   value {*}
 * Returns:
 *   {string}
 */
function publishLogValueForDiagnosis_(value) {
  if (value === null || value === undefined || value === '') return '（空）';
  if (Object.prototype.toString.call(value) === '[object Date]') return formatIsoDate_(value);
  if (value === true) return 'TRUE';
  if (value === false) return 'FALSE';
  return String(value);
}

/**
 * 用途：把診斷結果排版成 `Diagnostics` 報告的內容行。
 *
 *   ⚠️ 七項**逐項都要有一行**。取不到的一項要明確寫「取不到，原因是⋯⋯」，
 *   不可以整項消失——一項靜靜不見了，看報告的人會以為那一項沒有問題。
 *   ⚠️ 區段標題一律用全形括號「【…】」，不可以用 `=`／`+`／`-`／`@` 開頭
 *   （見 docs/已知bug類型.md 事故六）。
 * Args:
 *   d {Object} `collectI06Diagnosis_()` 的輸出。
 * Returns:
 *   {string[]}
 */
function buildI06DiagnosisLines_(d) {
  var lines = [];

  lines.push('【這份報告的用途】');
  lines.push('I06 報「對不上」的時候，這裏列出它實際比對的兩邊、以及相關檔案');
  lines.push('目前的實況。全部都是**唯讀**，一個位元組都沒有寫。');
  lines.push('');

  // ---- 1 ----
  lines.push('【1. PublishLog 最新一行（非自測）】');
  if (!d.latestRow) {
    lines.push('　取不到，原因是：沒有任何非自測的發佈紀錄。');
  } else {
    d.latestRowFields.forEach(function (field) {
      var fieldKey = field.key;
      lines.push('　' + fieldKey + '：' + field.value);
    });
  }
  lines.push('');

  // ---- 2 ----
  lines.push('【2. 該行的 master 檔案 ID vs Config 現值】');
  lines.push('　該行 MASTER_FILE_ID：' + (d.rowMasterFileId ? maskFileId_(d.rowMasterFileId) : '（空）'));
  lines.push('　Config ' + CONFIG_KEYS.PUBLISHED_PDF_FILE_ID + '：'
    + (d.configMasterFileId ? maskFileId_(d.configMasterFileId) : '（空）'));
  if (d.rowMasterMatchesConfig === null) {
    lines.push('　比不到：該行沒有 MASTER_FILE_ID。');
  } else {
    lines.push('　兩者' + (d.rowMasterMatchesConfig ? '相同' : '**不同**')
      + (d.rowMasterMatchesConfig ? '。' : '——I06 應該用該行那一個，不是 Config 那一個。'));
  }
  lines.push('');

  // ---- 3 ----
  lines.push('【3. 該行的存檔副本】');
  lines.push(i06FileFactsLine_(d.archive, '存檔副本'));
  lines.push('');

  // ---- 4 ----
  lines.push('【4. master 檔案目前的實況】');
  lines.push(i06FileFactsLine_(d.master, 'master 檔案'));
  if (d.master && d.master.ok) {
    lines.push('　最後修改時間：' + (d.master.lastUpdated || '（取不到）'));
    lines.push('　擁有者：' + (d.master.lastModifiedBy || '（取不到）'));
    lines.push('　MIME：' + (d.master.mimeType || '（取不到）'));
  }
  lines.push('');

  // ---- 5 ----
  lines.push('【5. Drive 版本記錄】');
  if (!d.revisions || !d.revisions.ok) {
    lines.push('　取不到，原因是：' + ((d.revisions && d.revisions.message) || '（沒有原因）'));
  } else if (d.revisions.total === 0) {
    lines.push('　真的一個版本都沒有（不是讀不到）。');
  } else {
    lines.push('　共 ' + d.revisions.total + ' 個版本，以下是最新 ' + d.revisions.revisions.length + ' 個：');
    d.revisions.revisions.forEach(function (rev) {
      lines.push('　　' + (rev.modifiedDate || '（沒有時間）')
        + '　' + (rev.fileSize === null ? '（沒有大小）' : (rev.fileSize + ' 位元組'))
        + (rev.modifiedBy ? ('　' + rev.modifiedBy) : ''));
    });
  }
  lines.push('');

  // ---- 6 ----
  lines.push('【6. I06 實際比對的兩樣東西】');
  if (!d.comparison) {
    lines.push('　取不到，原因是：沒有發佈紀錄，比對根本沒有發生。');
  } else {
    lines.push('　左邊：' + d.comparison.leftName);
    lines.push('　　值：' + d.comparison.leftValue);
    if (d.comparison.leftReason) lines.push('　　取不到的原因：' + d.comparison.leftReason);
    lines.push('　右邊：' + d.comparison.rightName);
    lines.push('　　值：' + d.comparison.rightValue);
    lines.push('　PublishLog 那一行講的是：' + d.comparison.rowIsoDate
      + ' 第 ' + d.comparison.rowVersionNo + ' 版');
  }
  lines.push('');

  // ---- 7 ----
  lines.push('【7. 差在哪裏】');
  if (!d.difference) {
    lines.push('　取不到，原因是：沒有比對過。');
  } else {
    lines.push('　' + d.difference.summary);
    if (d.difference.detail) lines.push('　' + d.difference.detail);
  }
  lines.push('');

  if (d.notes.length > 0) {
    lines.push('【其他發現】');
    d.notes.forEach(function (note) { lines.push('　' + note); });
    lines.push('');
  }

  lines.push('【接著做什麼】');
  lines.push(i06NextStepText_(d));

  return lines;
}

/**
 * 用途：把一個檔案的實況排成一行。取不到就寫明原因。
 * Args:
 *   facts {?Object}　label {string}
 * Returns:
 *   {string}
 */
function i06FileFactsLine_(facts, label) {
  if (!facts) return '　取不到，原因是：沒有收集過。';
  if (!facts.ok) {
    return '　' + label + '（' + (facts.fileId ? maskFileId_(facts.fileId) : '（沒有 ID）')
      + '）取不到，原因是：' + (facts.message || '（沒有原因）');
  }
  return '　' + label + '（' + maskFileId_(facts.fileId) + '）：'
    + (facts.fileName || '（沒有檔名）') + '，'
    + facts.bytes + ' 位元組，指紋 ' + (facts.fingerprint || '（算不到）');
}

/**
 * 用途：按診斷結果講一句「接著做什麼」。
 *
 *   ⚠️ 報告最後一定要有這一句。看完一堆數字仍然不知道下一步，等於沒有
 *   診斷過——這正是這一輪要修的東西。
 * Args:
 *   d {Object}
 * Returns:
 *   {string}
 */
function i06NextStepText_(d) {
  if (!d.latestRow) {
    return '　沒有非自測的發佈紀錄，I06 的「正式」通道應該回「不適用」。'
      + '如果它報「對不上」，那是 I06 的 bug。';
  }
  var kind = d.difference ? d.difference.kind : '';

  if (kind === 'SAME') {
    return '　兩邊相同，I06 的「正式」通道應該是綠的。如果它報「對不上」，'
      + '那是 I06 的 bug，請把這份報告連同自測報告一齊交出來。';
  }
  if (kind === 'UNAVAILABLE') {
    return '　其中一邊取不到，所以 I06 應該報「驗證不到」而不是「對不上」。'
      + '如果取不到的是「發佈當時的指紋」，撳選單「初始化工作表」跑一次'
      + '一次性補寫（會用存檔副本的指紋補上），或者直接做一次新的發佈'
      + '——之後那一行就會帶住 CONTENT_MD5。';
  }
  if (kind === 'CONTENT_MISMATCH') {
    return '　master 檔案的內容在最後一次發佈之後真的被換過。'
      + '如果那是你自己手動上載的，撳選單「重新對齊 I06」把目前內容記回去；'
      + '如果不是你做的，先查清楚是誰改了那個檔案，再對齊。';
  }
  return '　其中一邊取不到，所以 I06 應該報「驗證不到」而不是「對不上」。'
    + '先按上面第 3、4、5 項講的原因處理（通常是權限或者進階服務未啟用）。';
}

/**
 * 用途：選單「診斷 I06」。
 * Returns:
 *   {void}
 */
function menuDiagnoseI06_() {
  var ui = SpreadsheetApp.getUi();
  try {
    var diagnosis = collectI06Diagnosis_();
    var lines = buildI06DiagnosisLines_(diagnosis);
    writeDiagnosticsReport_('I06 診斷', lines);

    var summary = diagnosis.difference
      ? (diagnosis.difference.summary + '\n\n' + diagnosis.difference.detail)
      : '沒有可以比對的發佈紀錄。';
    ui.alert('I06 診斷',
      summary + '\n\n完整報告已經寫入 Diagnostics 工作表。\n'
        + '⚠️ 這次診斷全部都是唯讀，一個位元組都沒有寫。',
      ui.ButtonSet.OK);
  } catch (err) {
    logMenuError_('menuDiagnoseI06_', err);
    ui.alert('診斷 I06 失敗', enrichAuthError_(err), ui.ButtonSet.OK);
  }
}

/**
 * 用途：把某一條發佈通道 master 檔案**目前**的內容指紋，記回 `PublishLog`
 *   最新那一行（`CONTENT_BYTES`／`CONTENT_MD5`）。
 *
 *   ⚠️ 這是一個**承認現況**的動作，不是修復。用在兩種情況：
 *     1. master 檔案真的被人手覆寫過，而那一次覆寫是有意的；
 *     2. 舊資料沒有記過指紋（加欄之前），而目前內容確認就是那一版。
 *
 *   ⚠️ 它**不會碰 Drive 檔案**，只會改 `PublishLog` 那兩格。換句話說，
 *   它令 I06 由「不成立」變成「成立」，靠的是把記錄對齊現況——所以一定
 *   要人手確認過「現況是對的」才可以撳。撳錯的代價是：一次真的被人偷偷
 *   覆寫的事件，被記錄成正常。
 * Args:
 *   options {{isSelfTest?:boolean}} 預設對齊「正式」那一條通道。
 * Returns:
 *   {{ok:boolean, message:string, rowNo:number, fingerprint:string}}
 */
function realignI06Fingerprint_(options) {
  var o = options || {};
  var wantSelfTest = o.isSelfTest === true;

  var rows = readSheet(SHEETS.PUBLISH_LOG);
  var scoped = rows.filter(function (r) {
    return wantSelfTest ? (r.IS_SELFTEST === true) : (r.IS_SELFTEST !== true);
  });
  var latest = latestPublishLogRow_(scoped);
  if (!latest) {
    return {
      ok: false, rowNo: 0, fingerprint: '',
      message: 'PublishLog 沒有任何' + (wantSelfTest ? '自測' : '非自測') + '的發佈紀錄，沒有東西可以對齊。'
    };
  }

  var fileId = String(latest.MASTER_FILE_ID || '').trim();
  if (!fileId) {
    fileId = String(getConfig(
      wantSelfTest ? CONFIG_KEYS.SELFTEST_MASTER_PDF_FILE_ID : CONFIG_KEYS.PUBLISHED_PDF_FILE_ID,
      '') || '').trim();
  }
  if (!fileId) {
    return { ok: false, rowNo: 0, fingerprint: '', message: '推不出 master 檔案 ID，不知道要對齊哪一個檔案。' };
  }

  var bytes = readMasterPdfBytes_(fileId);
  if (bytes === null) {
    return {
      ok: false, rowNo: 0, fingerprint: '',
      message: '讀不到 ' + maskFileId_(fileId) + ' 目前的內容，對齊不到。'
        + '⚠️「讀不到」不等於「沒問題」，請先查清楚那個檔案還在不在。'
    };
  }

  var fingerprint = pdfFingerprint_(bytes);
  var parts = splitPdfFingerprint_(fingerprint);
  if (!parts.md5) {
    return { ok: false, rowNo: 0, fingerprint: '', message: '算不到目前內容的指紋（Utilities.computeDigest 不可用）。' };
  }

  var rowNo = Number(latest.__rowNo || 0);
  if (!rowNo) {
    // readSheet() 不帶 __rowNo，所以要自己找返那一行。
    rowNo = findPublishLogRowNo_(latest);
  }
  if (!rowNo) {
    return { ok: false, rowNo: 0, fingerprint: fingerprint, message: '找不到那一行在工作表的實際行號，沒有寫入任何東西。' };
  }

  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.PUBLISH_LOG);
  if (!sheet) {
    return { ok: false, rowNo: 0, fingerprint: fingerprint, message: '找不到 PublishLog 工作表。' };
  }

  var def = COLUMNS.PUBLISH_LOG;
  var oldFingerprint = publishRowFingerprint_(latest);
  setCellValueTextSafe_(sheet, def, rowNo, 'CONTENT_BYTES', parts.bytes);
  setCellValueTextSafe_(sheet, def, rowNo, 'CONTENT_MD5', sanitizeCellText_(parts.md5));

  appendAuditLog_({
    action: 'PUBLISH_LOG_REALIGN', sheetName: SHEETS.PUBLISH_LOG,
    rowKey: publishRowIsoDate_(latest), field: 'CONTENT_MD5',
    oldValue: oldFingerprint || '（空）', newValue: fingerprint,
    notes: '人手確認過 master 檔案（' + maskFileId_(fileId) + '）目前的內容就是這一版，'
      + '把指紋記回 PublishLog。⚠️ 這是承認現況，不是修復——Drive 檔案沒有被碰過。'
  });

  return {
    ok: true, rowNo: rowNo, fingerprint: fingerprint,
    message: '已把 ' + maskFileId_(fileId) + ' 目前的指紋（' + fingerprint + '）'
      + '記回 PublishLog 第 ' + rowNo + ' 行（' + publishRowIsoDate_(latest)
      + ' 第 ' + Number(latest.VERSION_NO || 0) + ' 版）。'
      + (oldFingerprint ? ('原本記的是 ' + oldFingerprint + '。') : '原本沒有記過。')
  };
}

/**
 * 用途：找返某一行 `PublishLog` 在工作表的實際行號（主日 ＋ 版本 ＋ 是否
 *   自測三樣齊對）。
 * Args:
 *   row {Object}
 * Returns:
 *   {number} 找不到回 0。
 */
function findPublishLogRowNo_(row) {
  var target = publishRowIsoDate_(row);
  var version = Number(row.VERSION_NO || 0);
  var isSelfTest = row.IS_SELFTEST === true;

  var all = readSheet(SHEETS.PUBLISH_LOG);
  for (var i = 0; i < all.length; i++) {
    var r = all[i];
    if (publishRowIsoDate_(r) !== target) continue;
    if (Number(r.VERSION_NO || 0) !== version) continue;
    if ((r.IS_SELFTEST === true) !== isSelfTest) continue;
    return i + 3; // 資料由第 3 行開始
  }
  return 0;
}

/**
 * 用途：選單「重新對齊 I06」。
 * Returns:
 *   {void}
 */
function menuRealignI06_() {
  var ui = SpreadsheetApp.getUi();
  try {
    var answer = ui.alert('重新對齊 I06',
      '這個動作會把 master 檔案**目前**的內容指紋，記回 PublishLog 最新一行。\n\n'
        + '⚠️ 它是「承認現況」，不是修復：\n'
        + '　　它不會碰 Drive 檔案，只會改 PublishLog 兩格。\n'
        + '　　撳完之後 I06 會變成成立——因為記錄被對齊到現況。\n\n'
        + '所以請先撳「診斷 I06（唯讀）」看清楚，確認 master 檔案目前的內容'
        + '真的就是你想要發佈的那一版，才好繼續。\n\n'
        + '要繼續嗎？',
      ui.ButtonSet.YES_NO);
    if (answer !== ui.Button.YES) return;

    var result = realignI06Fingerprint_({});
    ui.alert(result.ok ? '重新對齊完成' : '重新對齊失敗', result.message, ui.ButtonSet.OK);
  } catch (err) {
    logMenuError_('menuRealignI06_', err);
    ui.alert('重新對齊 I06 失敗', enrichAuthError_(err), ui.ButtonSet.OK);
  }
}

// =====================================================================
// 發佈版本記錄（發佈錯了怎樣救）
// =====================================================================

/**
 * 用途：把 master 發佈檔案的 Drive 版本記錄排成報告內容行。**純函式。**
 *
 *   ⚠️ 這是「發佈錯了怎樣救」那條路。Drive 保留檔案的每一個版本，所以
 *   即使覆寫了錯的內容，舊那一版仍然在——但**前提是有人知道去哪裏找**。
 *   見 docs/復工指引.md 第七節。
 *
 *   ⚠️ 「讀不到版本記錄」與「真的一個版本都沒有」是兩件事，要分開報。
 * Args:
 *   info {{fileId:string, fileName:string, revisions:Object, publishRows:Object[]}}
 * Returns:
 *   {string[]}
 */
function buildPublishRevisionLines_(info) {
  var lines = [];
  lines.push('【master 發佈檔案】');
  if (!info.fileId) {
    lines.push('　尚未設定 ' + CONFIG_KEYS.PUBLISHED_PDF_FILE_ID + '，沒有檔案可以看。');
    return lines;
  }
  lines.push('　檔案：' + (info.fileName || '（讀不到檔名）') + '（' + maskFileId_(info.fileId) + '）');
  lines.push('');

  lines.push('【Drive 版本記錄】');
  var revisions = info.revisions || { ok: false, revisions: [], total: 0, message: '' };
  if (!revisions.ok) {
    lines.push('　讀不到，原因是：' + (revisions.message || '（沒有原因）'));
    lines.push('　⚠️「讀不到」不等於「沒有版本」——請人手開啟該檔案 ▸ 檔案 ▸ 版本記錄確認。');
  } else if (revisions.total === 0) {
    lines.push('　真的一個版本都沒有（不是讀不到）。');
  } else {
    lines.push('　共 ' + revisions.total + ' 個版本，以下是最新 ' + revisions.revisions.length + ' 個（由新到舊）：');
    revisions.revisions.forEach(function (rev, index) {
      lines.push('　　' + (index + 1) + '.　' + (rev.modifiedDate || '（沒有時間）')
        + '　' + (rev.fileSize === null ? '（沒有大小）' : (rev.fileSize + ' 位元組'))
        + (rev.modifiedBy ? ('　' + rev.modifiedBy) : ''));
    });
  }
  lines.push('');

  lines.push('【對照：PublishLog 記錄的發佈】');
  if (!info.publishRows || info.publishRows.length === 0) {
    lines.push('　沒有發佈紀錄。');
  } else {
    info.publishRows.forEach(function (row) {
      lines.push('　' + publishRowIsoDate_(row) + ' 第 ' + Number(row.VERSION_NO || 0) + ' 版　'
        + (publishRowFingerprint_(row) || '（沒有記內容指紋）')
        + (row.IS_SELFTEST === true ? '　（自測）' : ''));
    });
    lines.push('　⚠️ 位元組數對得上哪一個 Drive 版本，就是那一次發佈寫進去的內容。');
  }
  lines.push('');

  lines.push('【發佈錯了怎樣還原】');
  lines.push('　Drive 的版本記錄不能由這個系統還原——一定要人手做，步驟如下：');
  lines.push('　1. 在 Drive 找到上面那個 master 檔案，按右鍵 ▸ 管理版本。');
  lines.push('　2. 對照上面的時間與位元組數，找出你要的那一版。');
  lines.push('　3. 按那一版右邊的三點 ▸ 下載，先把它存到電腦。');
  lines.push('　4. 回到週報系統的填寫介面，用「發佈及匯出」把剛才下載的那一份重新發佈。');
  lines.push('');
  lines.push('　⚠️ 刻意**不做**「一鍵還原」：還原等於再覆寫一次 master，');
  lines.push('　　而按錯的代價是網站上那條固定連結指向錯的一期。');
  lines.push('　　多一步人手下載，是要你親眼看過那一份內容才發佈。');
  lines.push('');
  lines.push('　⚠️ 用「發佈及匯出」重新發佈會產生**新的一版**（版本號 +1），');
  lines.push('　　不是把舊版本刪走。PublishLog 會看得出還原這一次。');

  return lines;
}

/**
 * 用途：選單「發佈版本記錄」——列出 master 檔案的全部 Drive 版本。
 *   **唯讀**，只讀不寫。
 * Returns:
 *   {void}
 */
function menuShowPublishRevisions_() {
  var ui = SpreadsheetApp.getUi();
  try {
    var fileId = String(getConfig(CONFIG_KEYS.PUBLISHED_PDF_FILE_ID, '') || '').trim();
    var facts = fileId ? readDriveFileFacts_(fileId) : { ok: false, fileName: '', message: '' };
    var revisions = fileId
      ? driveListRevisions_(fileId, 20)
      : { ok: false, revisions: [], total: 0, message: '尚未設定 master 發佈檔案。' };

    var publishRows = readSheet(SHEETS.PUBLISH_LOG)
      .filter(function (r) { return r.IS_SELFTEST !== true; })
      .slice(-10);

    var lines = buildPublishRevisionLines_({
      fileId: fileId,
      fileName: facts.ok ? facts.fileName : '',
      revisions: revisions,
      publishRows: publishRows
    });
    writeDiagnosticsReport_('發佈版本記錄', lines);

    var headline = revisions.ok
      ? ('共 ' + revisions.total + ' 個版本。')
      : ('讀不到版本記錄：' + (revisions.message || '（沒有原因）'));
    ui.alert('發佈版本記錄',
      headline + '\n\n完整清單與還原步驟已經寫入 Diagnostics 工作表。\n'
        + '⚠️ 這次只讀不寫，master 檔案的內容沒有被碰過。',
      ui.ButtonSet.OK);
  } catch (err) {
    logMenuError_('menuShowPublishRevisions_', err);
    ui.alert('發佈版本記錄失敗', enrichAuthError_(err), ui.ButtonSet.OK);
  }
}


// =====================================================================
// 診斷 I04
// =====================================================================

/**
 * 用途：收集「診斷 I04」要用的全部事實。**不寫任何東西。**
 *
 * ⚠️ 同「診斷 I06」一樣的做法：I04 報「不成立」的時候，那一句話講不出
 *   **兩邊分別是什麼、分別取自哪裏、為什麼會差**。先把證據打出來。
 * Args:
 *   options {{sinceMs:number=}} 選填。
 * Returns:
 *   {Object}
 */
function collectI04Diagnosis_(options) {
  var o = options || {};
  var rows = readSheet(SHEETS.SEND_LOG);

  var out = {
    totalRows: rows.length,
    batch: [],
    batchStatus: '',
    batchWindowMs: INVARIANT_SEND_BATCH_MS_,
    groups: [],
    previewCount: null,
    loggedCount: 0,
    distinctTimestamps: [],
    spanMs: null,
    mergedSendCount: null,
    recipients: [],
    notes: []
  };

  if (rows.length === 0) {
    out.notes.push('SendLog 一行都沒有，I04 應該回「驗證不到」。');
    return out;
  }

  var batch = invariantLatestSendLogBatch_(rows, o.sinceMs);
  out.batch = batch;
  out.loggedCount = batch.length;
  if (batch.length === 0) {
    out.notes.push('指定時間之後 SendLog 沒有新增任何行。');
    return out;
  }

  out.batchStatus = String(batch[0].STATUS || '');
  out.groups = invariantSendGroupsForStatus_(out.batchStatus);

  try {
    out.previewCount = buildRecipientList_(readSheet(SHEETS.RECIPIENTS), out.groups, null).recipients.length;
  } catch (err) {
    out.previewCount = null;
    out.notes.push('重新預覽收件人時拋錯：' + ((err && err.message) ? err.message : String(err)));
  }

  // ⚠️ 這一段是關鍵：同一「批」裡面到底有幾多個**不同的時間戳記**。
  //    一次 writeSheet() 是一次 setValues()，全部行同一刻寫入，所以正常
  //    情況下只會有一兩個。多過那個數，就代表**兩次不同的寄出被併成一批**。
  var seenTimes = {};
  batch.forEach(function (row) {
    var at = row.TIMESTAMP;
    if (Object.prototype.toString.call(at) !== '[object Date]') return;
    // 秒級——同一次寄出逐個收件人求值 new Date()，會跨秒但不會跨很多秒。
    var key = Math.floor(at.getTime() / 1000);
    seenTimes[key] = (seenTimes[key] || 0) + 1;
  });
  out.distinctTimestamps = Object.keys(seenTimes).sort().map(function (key) {
    return { epochSec: Number(key), count: seenTimes[key] };
  });

  if (out.distinctTimestamps.length > 0) {
    var first = out.distinctTimestamps[0].epochSec;
    var last = out.distinctTimestamps[out.distinctTimestamps.length - 1].epochSec;
    out.spanMs = (last - first) * 1000;
  }

  // 如果 previewCount 除得盡 loggedCount，很可能是 N 次寄出被併成一批。
  if (out.previewCount && out.previewCount > 0 && out.loggedCount % out.previewCount === 0) {
    out.mergedSendCount = out.loggedCount / out.previewCount;
  }

  out.recipients = readSheet(SHEETS.RECIPIENTS)
    .filter(function (r) { return r.ACTIVE === true; })
    .map(function (r) { return String(r.GROUP_NAME || '（未分組）'); });

  return out;
}

/**
 * 用途：把 I04 診斷排版成 `Diagnostics` 報告的內容行。
 *
 *   ⚠️ 區段標題一律用全形括號「【…】」（事故六）。
 * Args:
 *   d {Object} `collectI04Diagnosis_()` 的輸出。
 * Returns:
 *   {string[]}
 */
function buildI04DiagnosisLines_(d) {
  var lines = [];

  lines.push('【這份報告的用途】');
  lines.push('I04 報「不成立」的時候，這裏列出它實際比對的兩邊、各自的來源、');
  lines.push('以及「一批」的判定過程。全部都是唯讀，一個位元組都沒有寫。');
  lines.push('');

  lines.push('【1. I04 比對的兩邊】');
  lines.push('　左邊（預期）：用同一組收件組別重新預覽 → '
    + (d.previewCount === null ? '（算不到）' : (d.previewCount + ' 人')));
  lines.push('　　來源：Recipients 工作表 ＋ 收件組別 ' + (d.groups.join('、') || '（沒有）'));
  lines.push('　右邊（實際）：SendLog **最近一批**的行數 → ' + d.loggedCount + ' 行');
  lines.push('　　來源：SendLog（全表 ' + d.totalRows + ' 行）'
    + '，狀態 ' + (d.batchStatus || '（沒有）'));
  lines.push('');

  lines.push('【2. 「一批」是怎樣圈出來的】');
  lines.push('　規則：由最後一行往上數，狀態相同、而且與最後一行相差不超過 '
    + Math.round(d.batchWindowMs / 1000) + ' 秒的，全部當成同一批。');
  lines.push('　圈到 ' + d.loggedCount + ' 行，其中有 ' + d.distinctTimestamps.length
    + ' 個不同的時間戳記（秒）。');
  if (d.spanMs !== null) {
    lines.push('　這一批最早與最新相差 ' + Math.round(d.spanMs / 1000) + ' 秒。');
  }
  d.distinctTimestamps.forEach(function (entry) {
    lines.push('　　時間戳記 ' + entry.epochSec + '　' + entry.count + ' 行');
  });
  lines.push('');

  lines.push('【3. 差在哪裏】');
  lines.push(i04DifferenceText_(d));
  lines.push('');

  lines.push('【4. Recipients 目前的組別分佈】');
  if (d.recipients.length === 0) {
    lines.push('　沒有任何有效收件人。');
  } else {
    var byGroup = {};
    d.recipients.forEach(function (group) { byGroup[group] = (byGroup[group] || 0) + 1; });
    Object.keys(byGroup).sort().forEach(function (group) {
      lines.push('　' + group + '：' + byGroup[group] + ' 人');
    });
  }
  lines.push('');

  if (d.notes.length > 0) {
    lines.push('【其他發現】');
    d.notes.forEach(function (note) { lines.push('　' + note); });
    lines.push('');
  }

  lines.push('【接著做什麼】');
  lines.push(i04NextStepText_(d));

  return lines;
}

/**
 * 用途：判斷 I04 兩邊差在哪裏，並講出**最可能的成因**。**純函式。**
 *
 *   ⚠️ 「兩次寄出被併成一批」是這個規則的已知弱點：「一批」是用**時間
 *   視窗**圈出來的，而亂行機在幾秒之內連續寄兩次是很平常的事。
 * Args:
 *   d {Object}
 * Returns:
 *   {string}
 */
function i04DifferenceText_(d) {
  if (d.loggedCount === 0) return '　沒有可以比對的一批。';
  if (d.previewCount === null) return '　左邊算不到，所以 I04 應該報「驗證不到」。';

  if (d.previewCount === d.loggedCount) {
    return '　兩邊相同（' + d.previewCount + '），I04 應該是綠的。';
  }

  var text = '　預期 ' + d.previewCount + ' 封，實際 ' + d.loggedCount + ' 行，差 '
    + Math.abs(d.loggedCount - d.previewCount) + '。';

  if (d.mergedSendCount && d.mergedSendCount > 1) {
    text += '\n　⚠️ 行數剛好是預期的 ' + d.mergedSendCount + ' 倍，而且這一批有 '
      + d.distinctTimestamps.length + ' 個不同的時間戳記——'
      + '極可能是**' + d.mergedSendCount + ' 次不同的寄出被時間視窗併成了一批**。'
      + '\n　　那不是系統寄錯，是 I04 圈「一批」的規則本身不準。';
  } else if (d.distinctTimestamps.length > 2) {
    text += '\n　⚠️ 這一批有 ' + d.distinctTimestamps.length + ' 個不同的時間戳記，'
      + '一次 writeSheet() 正常只會有一兩個——很可能是多次寄出被併成一批。';
  } else {
    text += '\n　這一批的時間戳記只有 ' + d.distinctTimestamps.length + ' 個，'
      + '不像是多次寄出被併埋。要查的是 Recipients 在那一次寄出之後有沒有改過。';
  }
  return text;
}

/**
 * 用途：按診斷結果講一句「接著做什麼」。
 * Args:
 *   d {Object}
 * Returns:
 *   {string}
 */
function i04NextStepText_(d) {
  if (d.loggedCount === 0) return '　先寄一次（試行也可以），之後這一條才驗得到。';
  if (d.previewCount === null) return '　先修好「算收件人」那一段，見上面的其他發現。';
  if (d.previewCount === d.loggedCount) {
    return '　兩邊相同。如果自測機仍然報 I04 不成立，請把這份報告連同自測報告一齊交出來。';
  }
  if (d.mergedSendCount && d.mergedSendCount > 1) {
    return '　這是 I04 自己的問題，不是寄送的問題：'
      + '「一批」用時間視窗圈，連續兩次寄出會被併埋。'
      + '正確的做法是替每一次寄出寫一個批次編號（SendLog.BATCH_ID），'
      + '由編號圈一批，不再靠時間猜。';
  }
  return '　先確認 Recipients 在那一次寄出之後有沒有改過——'
    + '改過的話那個落差是預期之內的，I04 的證據本來就有寫明這一點。';
}

/**
 * 用途：選單「診斷 I04（唯讀）」。
 * Returns:
 *   {void}
 */
function menuDiagnoseI04_() {
  var ui = SpreadsheetApp.getUi();
  try {
    var diagnosis = collectI04Diagnosis_({});
    writeDiagnosticsReport_('I04 診斷', buildI04DiagnosisLines_(diagnosis));
    ui.alert('I04 診斷',
      i04DifferenceText_(diagnosis).replace(/^\s+/, '')
        + '\n\n完整報告已經寫入 Diagnostics 工作表。\n'
        + '⚠️ 這次診斷全部都是唯讀，一個位元組都沒有寫。',
      ui.ButtonSet.OK);
  } catch (err) {
    logMenuError_('menuDiagnoseI04_', err);
    ui.alert('診斷 I04 失敗', enrichAuthError_(err), ui.ButtonSet.OK);
  }
}

// =====================================================================
// I03 診斷（唯讀）
// =====================================================================

/**
 * 用途：收集 `I03` 的完整診斷資料——逐行列出 `NumberRegistry` 的每一項、
 *   兩路各自的來源與數值、對得上與否。**全部唯讀。**
 *
 *   ⚠️ 為什麼要有這一支（docs/待確認事項.md W-1）：自測機連續 25 個情境
 *   都報「I03（預期 全部對得上，實際 1 項對不上）」，同一項，25 次，
 *   而**從來沒有講是哪一項**。看完那句話仍然不知道要做什麼，等於沒有報。
 * Args:
 *   options {{quarterId:string=, isoDate:string=}=} 選填；不傳就用
 *     `invariantDefaultContext_()` 決定範圍。
 * Returns:
 *   {{ok:boolean, quarterId:string, isoDate:string, rows:Object[],
 *     registryOnly:string[], implOnly:string[], mismatchCount:number,
 *     skippedCount:number, message:string}}
 *     `rows` 每一項是
 *     `{id, label, sheetName, recountRule, independence, status,
 *       reported, recounted, diff, note}`；`status` 是
 *     `MATCH`／`MISMATCH`／`SKIPPED`／`ERROR`。
 */
function collectI03Diagnosis_(options) {
  var opts = options || {};
  var context = (opts.quarterId || opts.isoDate)
    ? { quarterId: String(opts.quarterId || ''), isoDate: String(opts.isoDate || '') }
    : invariantDefaultContext_();

  var out = {
    ok: false,
    quarterId: String(context.quarterId || ''),
    isoDate: String(context.isoDate || ''),
    rows: [],
    registryOnly: [],
    implOnly: [],
    mismatchCount: 0,
    skippedCount: 0,
    message: ''
  };

  if (!out.quarterId || !out.isoDate) {
    out.message = '未能決定要驗哪一個季度／主日（季度：'
      + (out.quarterId || '（未能決定）') + '、主日：' + (out.isoDate || '（未能決定）')
      + '）。I03 需要一個具體主日才數得到清單類的數字。';
    return out;
  }

  var probes = numberRegistryProbes_(context);
  var probeById = {};
  probes.forEach(function (p) { probeById[p.id] = p; });

  var registryRows = readSheet(SHEETS.NUMBER_REGISTRY).filter(function (r) { return r.ACTIVE === true; });
  var registeredIds = registryRows.map(function (r) { return String(r.REGISTRY_ID || '').trim(); });
  out.registryOnly = registeredIds.filter(function (id) { return id && !probeById[id]; });
  out.implOnly = probes.map(function (p) { return p.id; })
    .filter(function (id) { return registeredIds.indexOf(id) === -1; });

  probes.forEach(function (probe) {
    var row = {
      id: probe.id,
      label: probe.label,
      sheetName: probe.sheetName,
      recountRule: probe.recountRule,
      independence: probe.independence,
      status: 'MATCH',
      reported: null,
      recounted: null,
      diff: null,
      note: ''
    };

    if (typeof probe.applicable === 'function') {
      var gate;
      try {
        gate = probe.applicable();
      } catch (gateErr) {
        gate = { ok: false, reason: '判斷適不適用時拋錯——'
          + ((gateErr && gateErr.message) ? gateErr.message : String(gateErr)) };
      }
      if (!gate || gate.ok !== true) {
        row.status = 'SKIPPED';
        row.note = (gate && gate.reason) ? gate.reason : '（沒有寫明理由）';
        out.skippedCount++;
        out.rows.push(row);
        return;
      }
    }

    try {
      row.reported = probe.reported();
    } catch (err) {
      row.status = 'ERROR';
      row.note = '產生數字那一路拋錯——' + ((err && err.message) ? err.message : String(err));
      out.mismatchCount++;
      out.rows.push(row);
      return;
    }
    try {
      row.recounted = probe.recount();
    } catch (err2) {
      row.status = 'ERROR';
      row.note = '重新數那一路拋錯——' + ((err2 && err2.message) ? err2.message : String(err2));
      out.mismatchCount++;
      out.rows.push(row);
      return;
    }

    row.diff = Number(row.reported) - Number(row.recounted);
    if (row.diff !== 0) {
      row.status = 'MISMATCH';
      out.mismatchCount++;
    }
    out.rows.push(row);
  });

  out.ok = out.mismatchCount === 0 && out.registryOnly.length === 0 && out.implOnly.length === 0;
  out.message = buildI03DiagnosisSummary_(out);
  return out;
}

/**
 * 用途：把 `collectI03Diagnosis_()` 的結果縮成一句給對話框用的話。**純函式。**
 * Args:
 *   d {Object} `collectI03Diagnosis_()` 的回傳值。
 * Returns:
 *   {string}
 */
function buildI03DiagnosisSummary_(d) {
  if (!d.quarterId || !d.isoDate) return d.message || '未能決定要驗哪一個季度／主日。';

  var parts = ['季度 ' + d.quarterId + '、主日 ' + d.isoDate + '：共 ' + d.rows.length + ' 個登記數字。'];
  var matched = d.rows.filter(function (r) { return r.status === 'MATCH'; }).length;
  parts.push('對得上 ' + matched + ' 項、對不上 ' + d.mismatchCount + ' 項、不適用 ' + d.skippedCount + ' 項。');

  var bad = d.rows.filter(function (r) { return r.status === 'MISMATCH' || r.status === 'ERROR'; });
  if (bad.length > 0) {
    parts.push('對不上的是：' + bad.map(function (r) {
      // ⚠️ 先拆成一個本地變數再用。夾在引號之間的「.id」會被
      //    tools/scan-staged-secrets.js 誤判成網域（id 是真實 gTLD），
      //    見 docs/已知bug類型.md 事故六。
      var probeId = r.id;
      if (r.status === 'ERROR') return probeId + '（拋錯）';
      return probeId + '「' + r.label + '」畫面報 ' + r.reported + '、重新數是 ' + r.recounted;
    }).join('；') + '。');
  }
  if (d.registryOnly.length > 0) {
    parts.push('登記了但沒有實作：' + d.registryOnly.join('、') + '。');
  }
  if (d.implOnly.length > 0) {
    parts.push('有實作但沒有登記：' + d.implOnly.join('、') + '（請執行「初始化工作表」補回登記行）。');
  }
  return parts.join('　');
}

/**
 * 用途：把 `collectI03Diagnosis_()` 的結果排版成 `Diagnostics` 的內容行。
 *   **純函式。**
 *
 *   ⚠️ 逐項都要印**兩個數字與兩路各自的來源**，不論對得上與否。只印對不上
 *   那幾項的話，看的人分不出「其餘的驗過而且沒事」與「其餘的根本沒有驗」。
 * Args:
 *   d {Object} `collectI03Diagnosis_()` 的回傳值。
 * Returns:
 *   {string[]}
 */
function buildI03DiagnosisLines_(d) {
  var lines = [];
  lines.push('I03 診斷（唯讀）——畫面顯示的每一個數字，都可以由工作表重新數出同一個數');
  lines.push('');
  lines.push(d.message);
  lines.push('');

  if (!d.quarterId || !d.isoDate) return lines;

  lines.push('【逐項明細】');
  d.rows.forEach(function (r) {
    var mark = r.status === 'MATCH' ? '✅'
      : (r.status === 'SKIPPED' ? '⚪' : '🔴');
    // ⚠️ 先拆成本地變數，理由同上（事故六）。
    var probeId = r.id;
    lines.push(mark + '　' + probeId + '　' + r.label);
    lines.push('　　畫面那個數字：' + (r.reported === null ? '（沒有取到）' : r.reported));
    lines.push('　　重新數出來的：' + (r.recounted === null ? '（沒有取到）' : r.recounted)
      + '（來源工作表：' + r.sheetName + '）');
    if (r.diff !== null && r.diff !== 0) lines.push('　　相差：' + r.diff);
    lines.push('　　重新數的條件：' + r.recountRule);
    lines.push('　　兩路的獨立程度：' + r.independence);
    if (r.note) lines.push('　　備註：' + r.note);
    lines.push('');
  });

  if (d.registryOnly.length > 0) {
    lines.push('【⚠️ NumberRegistry 登記了但沒有實作】');
    d.registryOnly.forEach(function (id) { lines.push('　' + id + '（登記了卻沒有檢查，等於沒有登記）'); });
    lines.push('');
  }
  if (d.implOnly.length > 0) {
    lines.push('【⚠️ 有實作但沒有在 NumberRegistry 登記】');
    d.implOnly.forEach(function (id) { lines.push('　' + id); });
    lines.push('　請執行「初始化工作表」補回登記行。');
    lines.push('');
  }

  lines.push('【看完之後怎樣做】');
  lines.push(i03NextStepText_(d));
  lines.push('');
  lines.push('⚠️ 這次診斷全部都是唯讀，一個格都沒有寫。');
  return lines;
}

/**
 * 用途：按診斷結果講出下一步。**純函式。**
 *
 *   ⚠️ 三種可能刻意逐個列出來，因為它們的處理方式完全不同：改登記表、
 *   改函式、統一定義。分不清楚就會改錯地方。
 * Args:
 *   d {Object} `collectI03Diagnosis_()` 的回傳值。
 * Returns:
 *   {string}
 */
function i03NextStepText_(d) {
  if (d.ok) {
    return '　全部對得上，不需要做什麼。'
      + (d.skippedCount > 0
        ? ('　⚠️ 但有 ' + d.skippedCount + ' 項報「不適用」——那不等於通過，'
          + '請看上面那幾項的備註，確認「不適用」的理由現在仍然成立。')
        : '');
  }
  return [
    '　逐項看上面的「畫面那個數字」與「重新數出來的」，落在以下其中一種：',
    '　A. 登記表寫錯（來源函式或條件填錯）→ 改 NumberRegistry 那一行。',
    '　B. 產生數字那一支函式真的報錯數 → 改那一支函式。',
    '　C. 兩邊定義不同（例如一邊計已封存的、一邊不計）→ 統一定義，並在登記表的'
      + '「重新數的條件」寫明。',
    '　⚠️ 不要在未看清楚兩個數字之前就改任何一邊——三種的改法完全不同，'
      + '改錯地方會令這一條由「報得出問題」變成「永遠報綠」。'
  ].join('\n');
}

/**
 * 用途：選單「診斷 I03（唯讀）」。
 * Returns:
 *   {void}
 */
function menuDiagnoseI03_() {
  var ui = SpreadsheetApp.getUi();
  try {
    var diagnosis = collectI03Diagnosis_({});
    writeDiagnosticsReport_('I03 診斷', buildI03DiagnosisLines_(diagnosis));
    ui.alert('I03 診斷',
      diagnosis.message
        + '\n\n完整報告已經寫入 Diagnostics 工作表。\n'
        + '⚠️ 這次診斷全部都是唯讀，一個格都沒有寫。',
      ui.ButtonSet.OK);
  } catch (err) {
    logMenuError_('menuDiagnoseI03_', err);
    ui.alert('診斷 I03 失敗', enrichAuthError_(err), ui.ButtonSet.OK);
  }
}
