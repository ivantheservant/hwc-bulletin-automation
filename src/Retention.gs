/**
 * Retention.gs
 *
 * R-035：**只顯示本季與前一季，更早的自動封存。**
 *
 * ─────────────────────────────────────────────────────────────────────
 * 第一條規則，也是唯一一條真正要緊的規則
 * ─────────────────────────────────────────────────────────────────────
 *
 * **一格資料都不可以刪。** 封存只是「預設不顯示」：
 *
 *   | 對象 | 封存做什麼 | 資料還在不在 |
 *   |---|---|---|
 *   | `BulletinWeeks` | 該季每一行 `ARCHIVED=TRUE` | 在，一格未動 |
 *   | 季度填寫表 `Fill_*` | `hideSheet()` | 在，取消隱藏就見得返 |
 *   | 內容表 | `ContentSheets` 那一行 `ACTIVE=FALSE`，檔案搬去封存資料夾 | 在，檔案沒有刪 |
 *
 * 全部都有「取消封存」可以完全還原（`unarchiveQuarter_()`）。
 *
 * ⚠️ **絕對不碰** `Diagnostics`、`PublishLog`、`AuditLog`、`SendLog`。
 * 那四張是紀錄，不是「本季的工作」——封存它們等於把稽核軌跡藏起來，
 * 而稽核軌跡的用途正正是「事後回去查」。
 *
 * ⚠️ **沙盒季度（Config `SELFTEST_QUARTER_ID`）永遠不封存、永遠不出現在
 * 使用者的季度下拉。** 它不是真實的一季，封存它沒有意義；而它出現在下拉
 * 會令幹事以為那是一個要填的期數。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 這一條功能最大的風險
 * ─────────────────────────────────────────────────────────────────────
 *
 * 「十月回來打開系統，見到一片空白。」所以：
 *
 *   - 季度下拉在**沒有任何可見季度**時，一定要顯示一句說明
 *     （`RETENTION_EMPTY_HINT_`），不可以只顯示一個空下拉；
 *   - 封存**之前**先確認該季沒有「未發佈而且有內容」的主日，有就列出來
 *     要求確認——那一季還在做，不應該收起。
 */

'use strict';

/** 沒有任何可見季度時，季度下拉旁邊要顯示的那一句。 */
var RETENTION_EMPTY_HINT_ = '目前沒有未封存的季度，請撳「顯示已封存」或建立新一季。';

/**
 * 用途：讀出封存相關的 Config。
 * Args: （無）
 * Returns:
 *   {{visibleQuarters:number, archiveFolderId:string, sandboxQuarterId:string}}
 */
function retentionConfig_() {
  var visible = normalizeInt_(getConfig(CONFIG_KEYS.RETENTION_QUARTERS_VISIBLE, '2'));
  if (visible === null || visible < 1) visible = 2;
  return {
    visibleQuarters: visible,
    archiveFolderId: String(getConfig(CONFIG_KEYS.CONTENT_SHEET_ARCHIVE_FOLDER_ID, '') || '').trim(),
    sandboxQuarterId: String(getConfig(CONFIG_KEYS.SELFTEST_QUARTER_ID, '') || '').trim()
  };
}

/**
 * 用途：決定哪幾季應該可見、哪幾季應該封存。**純函式。**
 *
 *   ⚠️ 沙盒季度**兩邊都不入**：既不算進「可見的 N 季」，也永遠不會被列入
 *   要封存的一批。它是自測機的沙盒，不是真實的一季。
 *
 *   ⚠️ 排序用季度 ID 的字串比較（`YYYYTn` 格式下，字串序 === 時間序），
 *   不是靠日期——日期要讀每一行，而這一支是純函式，刻意只吃季度清單。
 * Args:
 *   quarterIds {string[]} 全部出現過的季度 ID（可以有重複）。
 *   visibleCount {number} 要保留可見的季度數（本季 ＋ 前 N-1 季）。
 *   sandboxQuarterId {string} 沙盒季度 ID；空字串代表沒有。
 * Returns:
 *   {{visible:string[], toArchive:string[], sandbox:string[]}}
 *     `visible` 由新到舊；`toArchive` 同樣由新到舊。
 */
function planQuarterRetention_(quarterIds, visibleCount, sandboxQuarterId) {
  var sandbox = String(sandboxQuarterId || '').trim();
  var count = Number(visibleCount);
  if (!isFinite(count) || count < 1) count = 2;

  var seen = {};
  var real = [];
  var sandboxSeen = [];

  (quarterIds || []).forEach(function (raw) {
    var qid = String(raw || '').trim();
    if (!qid || seen[qid]) return;
    seen[qid] = true;
    if (sandbox && qid === sandbox) { sandboxSeen.push(qid); return; }
    real.push(qid);
  });

  real.sort(function (a, b) {
    if (a === b) return 0;
    return a < b ? 1 : -1;                                // 由新到舊
  });

  return {
    visible: real.slice(0, count),
    toArchive: real.slice(count),
    sandbox: sandboxSeen
  };
}

/**
 * 用途：找出一個季度之中「未發佈而且有內容」的主日。
 *
 *   ⚠️ 封存之前一定要問這一句：那一季**還在做**的話，收起它等於把幹事
 *   正在填的東西藏走。「有內容」的判斷刻意寬鬆（任何一個人手欄位有值就算），
 *   寧可多問一次，也不要靜靜收起一季還在用的資料。
 * Args:
 *   quarterId {string} 季度 ID。
 * Returns:
 *   {{isoDate:string, reason:string}[]} 沒有就回空陣列。
 */
function findUnpublishedWorkInQuarter_(quarterId) {
  var qid = String(quarterId || '').trim();
  if (!qid) return [];

  var publishedIso = {};
  readSheet(SHEETS.PUBLISH_LOG).forEach(function (r) {
    if (r.IS_SELFTEST === true) return;
    var iso = publishRowIsoDate_(r);
    if (iso) publishedIso[iso] = true;
  });

  // 「有內容」＝任何一個人手填的欄位有值。刻意用一份明確的清單，
  // 不用「除了系統欄位以外全部」那種反向定義（日後加欄位就會靜靜改變行為）。
  var contentKeys = [
    'CALL_TEXT', 'CALL_REF', 'SCRIPTURE_REF', 'SERMON_TITLE',
    'RESPONSE_HYMN', 'HYMN_PRAISE', 'FLOWER_THIS_WEEK', 'PRELUDE'
  ];

  var out = [];
  readSheet(SHEETS.BULLETIN_WEEKS).forEach(function (row) {
    if (String(row.QUARTER_ID || '').trim() !== qid) return;

    var iso = (Object.prototype.toString.call(row.SERVICE_DATE) === '[object Date]')
      ? formatIsoDate_(row.SERVICE_DATE)
      : String(row.SERVICE_DATE || '').trim();
    if (!iso || publishedIso[iso]) return;

    var filled = contentKeys.filter(function (key) {
      return String(row[key] === null || row[key] === undefined ? '' : row[key]).trim() !== '';
    });
    if (filled.length === 0) return;

    out.push({
      isoDate: iso,
      reason: '未發佈，但已經填了 ' + filled.length + ' 個欄位（'
        + filled.slice(0, 3).join('、') + (filled.length > 3 ? ' 等' : '') + '）'
    });
  });

  out.sort(function (a, b) { return a.isoDate < b.isoDate ? -1 : (a.isoDate > b.isoDate ? 1 : 0); });
  return out;
}

/**
 * 用途：把 `BulletinWeeks` 某一季的每一行標記成封存／取消封存。
 *
 *   ⚠️ 只寫 `ARCHIVED` 一欄，**其餘一格都不動**。
 * Args:
 *   quarterId {string} 季度 ID。
 *   archived {boolean} `true` ＝ 封存、`false` ＝ 取消封存。
 * Returns:
 *   {number} 動了幾多行。
 */
function setQuarterArchivedFlag_(quarterId, archived) {
  var qid = String(quarterId || '').trim();
  if (!qid) return 0;

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEETS.BULLETIN_WEEKS);
  if (!sheet) return 0;

  var def = COLUMNS.BULLETIN_WEEKS;
  var col = def.keys.indexOf('ARCHIVED') + 1;
  if (col <= 0) return 0;

  var rows = readSheet(SHEETS.BULLETIN_WEEKS);
  var touched = 0;
  rows.forEach(function (row, index) {
    if (String(row.QUARTER_ID || '').trim() !== qid) return;
    if (row.ARCHIVED === archived) return;               // 已經是想要的值就不寫
    sheet.getRange(index + 3, col).setValue(archived);
    touched++;
  });
  return touched;
}

/**
 * 用途：隱藏／取消隱藏某一季的季度填寫表。
 *
 *   ⚠️ 用 `hideSheet()`，**不是刪除**。工作表一刪就救不回（Apps Script 沒有
 *   還原 API），而隱藏隨時取消得到。
 * Args:
 *   quarterId {string} 季度 ID。
 *   hidden {boolean} `true` ＝ 隱藏。
 * Returns:
 *   {{ok:boolean, sheetName:string, message:string}}
 */
function setFillGridHidden_(quarterId, hidden) {
  var name = fillGridSheetName_(quarterId);
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sheet) {
    return { ok: false, sheetName: name, message: '沒有 ' + name + ' 這一張工作表（未建立過季度填寫表）。' };
  }
  try {
    if (hidden) sheet.hideSheet();
    else sheet.showSheet();
  } catch (err) {
    return {
      ok: false, sheetName: name,
      message: (hidden ? '隱藏' : '取消隱藏') + ' ' + name + ' 失敗：'
        + ((err && err.message) ? err.message : String(err))
    };
  }
  return { ok: true, sheetName: name, message: (hidden ? '已隱藏 ' : '已取消隱藏 ') + name + '。' };
}

/**
 * 用途：封存／取消封存一季的內容表登記行，並（設定了資料夾的話）搬檔案。
 *
 *   ⚠️ 未設定 `CONTENT_SHEET_ARCHIVE_FOLDER_ID` 時**只改 `ACTIVE`，不搬檔案**，
 *   而且要在回傳訊息講明。靜靜不搬而不講的話，下一次找不到檔案會查半日。
 * Args:
 *   quarterId {string} 季度 ID。
 *   archived {boolean} `true` ＝ 封存。
 *   archiveFolderId {string} 封存資料夾 ID；空字串代表未設定。
 * Returns:
 *   {{ok:boolean, activeChanged:boolean, fileMoved:boolean, message:string}}
 */
function setContentSheetArchived_(quarterId, archived, archiveFolderId) {
  var qid = String(quarterId || '').trim();
  var out = { ok: false, activeChanged: false, fileMoved: false, message: '' };

  var row = findContentSheetRow_(qid);
  if (!row) {
    out.ok = true;
    out.message = '季度「' + qid + '」沒有登記內容表，沒有東西要處理。';
    return out;
  }

  try {
    updateContentSheetField_(qid, 'ACTIVE', !archived);
    out.activeChanged = true;
  } catch (err) {
    out.message = '改 ContentSheets 的 ACTIVE 失敗：'
      + ((err && err.message) ? err.message : String(err));
    return out;
  }

  var folderId = String(archiveFolderId || '').trim();
  if (!folderId) {
    out.ok = true;
    out.message = '內容表登記行的「有效」已改為 ' + (archived ? 'FALSE' : 'TRUE')
      + '。⚠️ Config 的 ' + CONFIG_KEYS.CONTENT_SHEET_ARCHIVE_FOLDER_ID
      + ' 未設定，所以**沒有搬動檔案**——檔案仍然在原本的資料夾。';
    return out;
  }

  if (!archived) {
    out.ok = true;
    out.message = '內容表登記行的「有效」已改回 TRUE。'
      + '⚠️ 檔案**沒有**自動搬回原本的資料夾——搬回哪裏系統不知道，請人手處理。';
    return out;
  }

  var moved = moveContentSheetFileToFolder_(String(row.FILE_ID || ''), folderId);
  out.ok = true;
  out.fileMoved = moved.ok;
  out.message = '內容表登記行的「有效」已改為 FALSE。' + moved.message;
  return out;
}

/**
 * 用途：封存一個季度。**不刪任何資料。**
 * Args:
 *   quarterId {string} 季度 ID。
 *   options {{force:boolean=, archiveFolderId:string=}=} `force:true` 代表
 *     已經確認過「未發佈而且有內容」那幾個主日，可以照樣封存。
 * Returns:
 *   {{ok:boolean, quarterId:string, reason:string, weekRows:number,
 *     fillGrid:Object, contentSheet:Object, blockers:Object[], message:string}}
 * Raises:
 *   Error 如果季度 ID 是沙盒季度——那是一個**不可以**發生的呼叫，
 *     靜靜略過會令呼叫方以為封存成功了。
 */
function archiveQuarter_(quarterId, options) {
  var opts = options || {};
  var qid = String(quarterId || '').trim();
  var config = retentionConfig_();

  var out = {
    ok: false, quarterId: qid, reason: '', weekRows: 0,
    fillGrid: null, contentSheet: null, blockers: [], message: ''
  };

  if (!qid) {
    out.reason = 'NO_QUARTER_ID';
    out.message = '季度 ID 不可以是空的。';
    return out;
  }
  if (config.sandboxQuarterId && qid === config.sandboxQuarterId) {
    var sandboxErr = new Error('archiveQuarter_：沙盒季度（' + qid + '）永遠不可以封存。'
      + '它不是真實的一季，封存它沒有意義，而且會令自測機下一次跑的時候看不見自己的資料。');
    sandboxErr.code = 'SANDBOX_QUARTER';
    throw sandboxErr;
  }

  // ---- 封存前的確認：那一季還在做的話，不應該收起 ----
  var blockers = findUnpublishedWorkInQuarter_(qid);
  if (blockers.length > 0 && opts.force !== true) {
    out.reason = 'HAS_UNPUBLISHED_WORK';
    out.blockers = blockers;
    out.message = '季度「' + qid + '」有 ' + blockers.length
      + ' 個主日**未發佈但已經有內容**，所以沒有封存。'
      + '那一季看來還在做，收起它等於把正在填的東西藏走。'
      + '確認過真的可以收起，請再撳一次並選擇「照樣封存」。';
    return out;
  }

  out.weekRows = setQuarterArchivedFlag_(qid, true);
  out.fillGrid = setFillGridHidden_(qid, true);
  out.contentSheet = setContentSheetArchived_(qid, true, config.archiveFolderId);
  out.blockers = blockers;

  appendAuditLog_({
    action: 'ARCHIVE_QUARTER', sheetName: SHEETS.BULLETIN_WEEKS,
    rowKey: qid, field: 'ARCHIVED', oldValue: 'FALSE', newValue: 'TRUE',
    notes: '封存季度 ' + qid + '：' + out.weekRows + ' 行標記 ARCHIVED、'
      + out.fillGrid.message + out.contentSheet.message
      + '　⚠️ 一格資料都沒有刪，撳「取消封存」可以完全還原。'
      + (blockers.length > 0 ? ('　⚠️ 有 ' + blockers.length + ' 個未發佈但有內容的主日，使用者已確認照樣封存。') : '')
  });

  out.ok = true;
  out.reason = 'OK';
  out.message = '已封存季度「' + qid + '」：' + out.weekRows + ' 個主日標記為已封存。'
    + out.fillGrid.message + out.contentSheet.message;
  return out;
}

/**
 * 用途：取消封存一個季度，**完全還原**。
 * Args:
 *   quarterId {string} 季度 ID。
 * Returns:
 *   {{ok:boolean, quarterId:string, weekRows:number, fillGrid:Object,
 *     contentSheet:Object, message:string}}
 */
function unarchiveQuarter_(quarterId) {
  var qid = String(quarterId || '').trim();
  var config = retentionConfig_();
  var out = { ok: false, quarterId: qid, weekRows: 0, fillGrid: null, contentSheet: null, message: '' };

  if (!qid) {
    out.message = '季度 ID 不可以是空的。';
    return out;
  }

  out.weekRows = setQuarterArchivedFlag_(qid, false);
  out.fillGrid = setFillGridHidden_(qid, false);
  out.contentSheet = setContentSheetArchived_(qid, false, config.archiveFolderId);

  appendAuditLog_({
    action: 'UNARCHIVE_QUARTER', sheetName: SHEETS.BULLETIN_WEEKS,
    rowKey: qid, field: 'ARCHIVED', oldValue: 'TRUE', newValue: 'FALSE',
    notes: '取消封存季度 ' + qid + '：' + out.weekRows + ' 行改回未封存、'
      + out.fillGrid.message + out.contentSheet.message
  });

  out.ok = true;
  out.message = '已取消封存季度「' + qid + '」：' + out.weekRows + ' 個主日改回未封存。'
    + out.fillGrid.message + out.contentSheet.message;
  return out;
}

/**
 * 用途：**真正入口**——掃一次全部季度，把超出保留範圍的封存。
 *
 *   ⚠️ 這一支在三個地方被呼叫：「建立本季週報」之後、每季提示觸發器、
 *   以及選單「立即整理舊季度」。三處共用同一支，不可以各自寫一份。
 * Args:
 *   options {{force:boolean=}=} `force:true` 代表使用者已經確認過那幾個
 *     「未發佈但有內容」的季度可以照樣封存。
 * Returns:
 *   {{ok:boolean, archived:Object[], skipped:Object[], visible:string[],
 *     lines:string[], message:string}}
 */
function runQuarterRetention_(options) {
  var opts = options || {};
  var config = retentionConfig_();

  var quarterIds = readSheet(SHEETS.BULLETIN_WEEKS).map(function (r) {
    return String(r.QUARTER_ID || '').trim();
  });
  var plan = planQuarterRetention_(quarterIds, config.visibleQuarters, config.sandboxQuarterId);

  var archived = [];
  var skipped = [];

  plan.toArchive.forEach(function (qid) {
    var result;
    try {
      result = archiveQuarter_(qid, { force: opts.force === true });
    } catch (err) {
      skipped.push({ quarterId: qid, reason: (err && err.code) || 'ERROR',
        message: (err && err.message) ? err.message : String(err) });
      return;
    }
    if (result.ok) archived.push(result);
    else skipped.push({ quarterId: qid, reason: result.reason, message: result.message,
      blockers: result.blockers });
  });

  return {
    ok: true,
    archived: archived,
    skipped: skipped,
    visible: plan.visible,
    lines: buildRetentionReportLines_(plan, archived, skipped, config),
    message: buildRetentionSummary_(archived, skipped, plan)
  };
}

/**
 * 用途：整理結果的一句摘要。**純函式。**
 * Args:
 *   archived {Object[]} 成功封存的。
 *   skipped {Object[]} 沒有封存的。
 *   plan {Object} `planQuarterRetention_()` 的輸出。
 * Returns:
 *   {string}
 */
function buildRetentionSummary_(archived, skipped, plan) {
  var parts = [];
  if (archived.length === 0 && skipped.length === 0) {
    parts.push('沒有需要封存的季度。');
  } else {
    parts.push('封存了 ' + archived.length + ' 季，略過 ' + skipped.length + ' 季。');
  }
  parts.push('目前可見：' + (plan.visible.length > 0 ? plan.visible.join('、') : '（沒有）') + '。');
  parts.push('⚠️ 封存只是「預設不顯示」，一格資料都沒有刪；撳「取消封存」可以完全還原。');
  return parts.join('　');
}

/**
 * 用途：整理結果的完整報告行。**純函式。**
 *
 *   ⚠️ 一定要**逐季**列出「封存了哪一季、幾多個主日、內容表有沒有搬」。
 *   只講「封存了 2 季」的話，日後要查「某一季去了哪裏」完全無從查起。
 * Args:
 *   plan {Object} `planQuarterRetention_()` 的輸出。
 *   archived {Object[]} 成功封存的。
 *   skipped {Object[]} 沒有封存的。
 *   config {Object} `retentionConfig_()` 的輸出。
 * Returns:
 *   {string[]}
 */
function buildRetentionReportLines_(plan, archived, skipped, config) {
  var lines = [];
  lines.push('整理舊季度（R-035）');
  lines.push('');
  lines.push('保留可見的季度數（' + CONFIG_KEYS.RETENTION_QUARTERS_VISIBLE + '）：'
    + config.visibleQuarters);
  lines.push('目前可見：' + (plan.visible.length > 0 ? plan.visible.join('、') : '（沒有）'));
  if (plan.sandbox.length > 0) {
    lines.push('沙盒季度（永不封存、永不出現在使用者的季度下拉）：' + plan.sandbox.join('、'));
  }
  lines.push('');

  lines.push('【封存了 ' + archived.length + ' 季】');
  if (archived.length === 0) lines.push('　（沒有）');
  archived.forEach(function (a) {
    lines.push('　' + a.quarterId + '：' + a.weekRows + ' 個主日');
    lines.push('　　季度填寫表：' + (a.fillGrid ? a.fillGrid.message : '（沒有處理）'));
    lines.push('　　內容表：' + (a.contentSheet ? a.contentSheet.message : '（沒有處理）'));
    if (a.blockers && a.blockers.length > 0) {
      lines.push('　　⚠️ 有 ' + a.blockers.length + ' 個未發佈但有內容的主日，使用者已確認照樣封存。');
    }
  });
  lines.push('');

  if (skipped.length > 0) {
    lines.push('【略過 ' + skipped.length + ' 季】');
    skipped.forEach(function (s) {
      lines.push('　' + s.quarterId + '（' + s.reason + '）：' + s.message);
      (s.blockers || []).slice(0, 5).forEach(function (b) {
        lines.push('　　' + b.isoDate + '　' + b.reason);
      });
      if ((s.blockers || []).length > 5) {
        lines.push('　　（另有 ' + (s.blockers.length - 5) + ' 個未列出）');
      }
    });
    lines.push('');
  }

  lines.push('⚠️ 封存只是「預設不顯示」，**一格資料都沒有刪**：');
  lines.push('　　BulletinWeeks 只多了一個 ARCHIVED=TRUE 的標記，內容一格未動；');
  lines.push('　　季度填寫表是**隱藏**（不是刪除），取消隱藏就見得返；');
  lines.push('　　內容表檔案沒有刪，只是登記行的「有效」改成 FALSE。');
  lines.push('　　要完全還原，用選單「取消封存季度」。');
  lines.push('');
  lines.push('⚠️ 這一次完全沒有碰 Diagnostics、PublishLog、AuditLog、SendLog——');
  lines.push('　　那四張是紀錄，封存它們等於把稽核軌跡藏起來。');
  return lines;
}

/**
 * 用途：使用者可見的季度清單（季度下拉用）。
 *
 *   ⚠️ 沙盒季度**永遠不出現**，不論有沒有勾「顯示已封存」。
 * Args:
 *   quarterIds {string[]} 全部出現過的季度 ID。
 *   archivedByQuarter {Object<string,boolean>} 每一季是不是已封存。
 *   includeArchived {boolean} 有沒有勾「顯示已封存」。
 *   sandboxQuarterId {string} 沙盒季度 ID。
 * Returns:
 *   {{quarterId:string, archived:boolean}[]} 由新到舊。
 */
function visibleQuarterList_(quarterIds, archivedByQuarter, includeArchived, sandboxQuarterId) {
  var sandbox = String(sandboxQuarterId || '').trim();
  var flags = archivedByQuarter || {};
  var seen = {};
  var out = [];

  (quarterIds || []).forEach(function (raw) {
    var qid = String(raw || '').trim();
    if (!qid || seen[qid]) return;
    seen[qid] = true;
    if (sandbox && qid === sandbox) return;              // 沙盒永遠不出現
    var isArchived = flags[qid] === true;
    if (isArchived && includeArchived !== true) return;
    out.push({ quarterId: qid, archived: isArchived });
  });

  out.sort(function (a, b) {
    if (a.quarterId === b.quarterId) return 0;
    return a.quarterId < b.quarterId ? 1 : -1;
  });
  return out;
}

// =====================================================================
// 選單
// =====================================================================

/**
 * 用途：選單「立即整理舊季度（封存，不刪資料）」。
 *
 *   ⚠️ 對話框第一句就要講明「不刪資料」。「封存」兩個字在別的系統裏面
 *   經常等於「刪走但留備份」，幹事沒有理由知道我們這裏不是。
 * Returns:
 *   {void}
 */
function menuRunQuarterRetention_() {
  var ui = SpreadsheetApp.getUi();
  try {
    var config = retentionConfig_();
    var confirm = ui.alert('立即整理舊季度',
      '把超出保留範圍的季度標記為「已封存」。\n\n'
        + '⚠️ **一格資料都不會刪。** 封存只是「預設不顯示」：\n'
        + '　　• BulletinWeeks 只多一個 ARCHIVED 標記，內容一格未動\n'
        + '　　• 季度填寫表是**隱藏**，不是刪除\n'
        + '　　• 內容表檔案沒有刪，只是登記行的「有效」改成 FALSE\n'
        + '　　• 隨時可以用選單「取消封存季度」完全還原\n\n'
        + '目前設定保留最近 ' + config.visibleQuarters + ' 季（Config 的 '
        + CONFIG_KEYS.RETENTION_QUARTERS_VISIBLE + '）。\n\n'
        + '確定要開始嗎？',
      ui.ButtonSet.YES_NO);
    if (confirm !== ui.Button.YES) return;

    var result = runQuarterRetention_({});

    // ⚠️ 有季度因為「未發佈但有內容」而略過的話，一定要再問一次，
    //    而且要列出是哪幾個主日——只講「有 2 季略過」等於叫人自己去猜。
    var blocked = result.skipped.filter(function (s) { return s.reason === 'HAS_UNPUBLISHED_WORK'; });
    if (blocked.length > 0) {
      var detail = blocked.map(function (s) {
        return '　' + s.quarterId + '：\n'
          + (s.blockers || []).slice(0, 5).map(function (b) {
            return '　　' + b.isoDate + '　' + b.reason;
          }).join('\n')
          + ((s.blockers || []).length > 5
            ? ('\n　　（另有 ' + (s.blockers.length - 5) + ' 個未列出）') : '');
      }).join('\n');

      var again = ui.alert('有季度未封存',
        '以下季度有**未發佈但已經有內容**的主日，所以沒有封存：\n\n'
          + detail + '\n\n'
          + '那幾季看來還在做。確認過真的可以收起，撳「是」照樣封存；\n'
          + '撳「否」就維持現狀（其餘季度已經封存好）。',
        ui.ButtonSet.YES_NO);
      if (again === ui.Button.YES) {
        result = runQuarterRetention_({ force: true });
      }
    }

    writeDiagnosticsReport_('整理舊季度', result.lines);
    ui.alert('整理舊季度', result.message + '\n\n完整報告已寫入 Diagnostics 工作表。', ui.ButtonSet.OK);
  } catch (err) {
    logMenuError_('menuRunQuarterRetention_', err);
    ui.alert('整理舊季度失敗', enrichAuthError_(err), ui.ButtonSet.OK);
  }
}

/**
 * 用途：選單「取消封存季度（完全還原）」。
 * Returns:
 *   {void}
 */
function menuUnarchiveQuarter_() {
  var ui = SpreadsheetApp.getUi();
  try {
    var resp = ui.prompt('取消封存季度',
      '把一個已封存的季度完全還原：ARCHIVED 改回 FALSE、季度填寫表取消隱藏、\n'
        + '內容表登記行的「有效」改回 TRUE。\n\n'
        + '⚠️ 內容表**檔案**不會自動搬回原本的資料夾——搬回哪裏系統不知道，\n'
        + '　　請在 Drive 人手處理（檔案一直都在，沒有刪）。\n\n'
        + '要還原哪一個季度？（例如 2027T4）',
      ui.ButtonSet.OK_CANCEL);
    if (resp.getSelectedButton() !== ui.Button.OK) return;

    var quarterId = resp.getResponseText().trim();
    if (!quarterId) {
      ui.alert('取消封存季度', '季度 ID 不可以是空的。', ui.ButtonSet.OK);
      return;
    }

    var result = unarchiveQuarter_(quarterId);
    ui.alert(result.ok ? '取消封存完成' : '取消封存失敗', result.message, ui.ButtonSet.OK);
  } catch (err) {
    logMenuError_('menuUnarchiveQuarter_', err);
    ui.alert('取消封存失敗', enrichAuthError_(err), ui.ButtonSet.OK);
  }
}
