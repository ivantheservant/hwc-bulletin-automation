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
  var readFingerprint = o.fingerprintReader || readPublishOutputFingerprint_;
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
  var recorded = compareFileId ? readFingerprint(compareFileId) : null;
  out.comparison = {
    leftName: '發佈當時記下的指紋（Script Property '
      + (compareFileId ? publishOutputFingerprintKey_(compareFileId) : '（無）') + '）',
    leftValue: recorded ? recorded.fingerprint : '（沒有記錄）',
    leftIsoDate: recorded ? recorded.isoDate : '',
    leftVersionNo: recorded ? recorded.versionNo : null,
    leftMasterFileId: recorded ? (recorded.masterFileId || '（舊記錄，沒有記檔案 ID）') : '',
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

  if (!c.leftValue || c.leftValue === '（沒有記錄）') {
    return {
      kind: 'UNAVAILABLE',
      summary: '取不到「發佈當時的指紋」',
      detail: '那一次發佈是在加入指紋記錄之前做的，或者記錄被蓋走了。'
        + '⚠️「取不到」不等於「內容不對」——這種情況 I06 應該報「驗證不到」。'
    };
  }
  if (!master || !master.ok) {
    return {
      kind: 'UNAVAILABLE',
      summary: '讀不到 master 檔案目前的內容',
      detail: (master && master.message) ? master.message : '（沒有原因）'
    };
  }

  if (c.leftIsoDate !== c.rowIsoDate || Number(c.leftVersionNo) !== Number(c.rowVersionNo)) {
    return {
      kind: 'VERSION_MISMATCH',
      summary: '指紋記錄講的是另一次發佈',
      detail: 'PublishLog 最新一行是 ' + c.rowIsoDate + ' 第 ' + c.rowVersionNo + ' 版，'
        + '但指紋記錄講的是 ' + c.leftIsoDate + ' 第 ' + c.leftVersionNo + ' 版'
        + '（記錄的檔案 ID：' + c.leftMasterFileId + '）。'
        + '⚠️ 兩者對不上，代表那一份指紋根本不屬於這一行——'
        + '拿它去對內容，得出的「不一致」是假的。'
    };
  }

  if (c.leftValue === c.rightValue) {
    return { kind: 'SAME', summary: '兩邊完全相同', detail: '' };
  }

  // 指紋格式是「位元組數:md5」，拆得開就講得出是大小差還是內容差。
  var left = String(c.leftValue).split(':');
  var right = String(c.rightValue).split(':');
  var leftBytes = Number(left[0]);
  var rightBytes = Number(right[0]);

  if (left.length === 2 && right.length === 2 && leftBytes !== rightBytes) {
    return {
      kind: 'CONTENT_MISMATCH',
      summary: '大小不同：發佈當時 ' + leftBytes + ' 位元組，現在 ' + rightBytes + ' 位元組',
      detail: '差 ' + Math.abs(rightBytes - leftBytes) + ' 位元組。'
        + '大小都變了，代表檔案內容真的被換過（不是編碼差異）。'
    };
  }

  return {
    kind: 'CONTENT_MISMATCH',
    summary: '大小相同（' + leftBytes + ' 位元組）但 MD5 不同',
    detail: '同樣長度、不同內容——通常代表檔案被另一份同樣大小的內容覆寫，'
      + '或者 Drive 重新編碼過。'
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
    lines.push('　　它講的是：' + (d.comparison.leftIsoDate || '（沒有）')
      + ' 第 ' + (d.comparison.leftVersionNo === null ? '？' : d.comparison.leftVersionNo) + ' 版');
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
  if (kind === 'VERSION_MISMATCH') {
    return '　指紋記錄不屬於這一行——這是**記錄放錯地方**，不是內容出問題。'
      + '正確的修法是把指紋直接記在 PublishLog 每一行上（CONTENT_MD5／'
      + 'CONTENT_BYTES 兩欄），不再依賴一份會被覆蓋的共用記錄。'
      + '下一次發佈之後，這一條就會自己好返。';
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
