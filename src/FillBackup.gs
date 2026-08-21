/**
 * FillBackup.gs
 *
 * 季度資料的版本備份與還原。
 *
 * 備份的內容：該季 `BulletinWeeks` 全部行 ＋ 四張清單表（`Announcements`／
 * `Prayers`／`Fellowships`／`Finance`）該季的行，序列化成 JSON。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ⚠️ 單格 50000 字元上限，超過要分拆
 * ─────────────────────────────────────────────────────────────────────
 *
 * Google Sheets 單格的硬上限是 50000 字元，**超過會靜靜截斷**。一份被截斷
 * 的 JSON 是還原不到的——那就變成一個「看起來有、其實無」的假備份，
 * 比完全沒有備份更危險（人會以為自己有得還原）。
 *
 * 所以 `PAYLOAD_JSON` 超過上限就分拆成多行（`BACKUP_ID` 相同、`PART_NO`
 * 由 1 遞增），還原時按 `PART_NO` 串回來。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ⚠️ 這是全系統唯一容許刪行的地方
 * ─────────────────────────────────────────────────────────────────────
 *
 * 本專案的硬規則是「不刪行」（停用一律用 `ACTIVE=FALSE`）。`FillBackup`
 * 的輪替是**唯一**的例外，理由：
 *
 *   1. 備份是**快照式**資料，不是記錄。舊備份沒有「停用」這個狀態——
 *      它要麼可以還原，要麼應該消失。用 `ACTIVE=FALSE` 留住只會令這張表
 *      無限增長，而每一行可能有 50000 字元。
 *   2. 一季 13 行 × 五張表的 JSON 很大，保留數目不設限的話，幾個月之後
 *      這張表本身就會拖慢整個試算表。
 *   3. 保留數目由 Config `FILL_BACKUP_KEEP` 控制（預設 20），刪的一定是
 *      **最舊**的，而且刪之前不會動到任何其他表。
 *
 * 真正的逐格歷史保存在 `AuditLog`，那張表永不刪行。
 */

'use strict';

/**
 * 單格可以安全存放的字元數上限。
 *
 * Google Sheets 的硬上限是 50000；這裡刻意留一點餘裕，因為
 * `sanitizeCellText_()` 可能會在最前面加一個單引號。
 */
var FILL_BACKUP_CHUNK_SIZE_ = 49000;

/**
 * 用途：把一個長字串切成不超過 `FILL_BACKUP_CHUNK_SIZE_` 的片段。純函式。
 * Args:
 *   text {string} 要切的字串。
 *   chunkSize {number=} 每段長度上限，省略時用 `FILL_BACKUP_CHUNK_SIZE_`。
 * Returns:
 *   {string[]} 空字串回 `['']`（一個空的分段），不是空陣列——一份「什麼
 *     都沒有」的備份仍然要有一行記錄，否則還原時分不出「沒有備份過」與
 *     「備份過但當時是空的」。
 */
function splitBackupPayload_(text, chunkSize) {
  var size = chunkSize || FILL_BACKUP_CHUNK_SIZE_;
  var s = String(text === null || text === undefined ? '' : text);
  if (s.length === 0) return [''];

  var parts = [];
  for (var i = 0; i < s.length; i += size) {
    parts.push(s.slice(i, i + size));
  }
  return parts;
}

/**
 * 用途：把同一個 `BACKUP_ID` 的多個分段按 `PART_NO` 串回原本的字串。純函式。
 * Args:
 *   rows {Object[]} 同一個 `BACKUP_ID` 的 `FillBackup` 資料列。
 * Returns:
 *   {string}
 */
function joinBackupPayload_(rows) {
  return (rows || [])
    .slice()
    .sort(function (a, b) { return (Number(a.PART_NO) || 0) - (Number(b.PART_NO) || 0); })
    .map(function (r) { return String(r.PAYLOAD_JSON === null || r.PAYLOAD_JSON === undefined ? '' : r.PAYLOAD_JSON); })
    .join('');
}

/**
 * 用途：組出一個備份編號。
 *
 *   格式是 `<季度>-<時間戳記>`，例如 `2027T4-20270821T093000`。
 *
 *   ⚠️ 時間戳記只到**秒**，所以同一秒內連續備份兩次會撞名。這不是理論
 *   問題：使用者撳「立即備份本季」之後**緊接着**撳「還原到某個備份」，
 *   還原前的安全備份就有機會落在同一秒。撞名的後果很惡劣——
 *   `groupFillBackups_()` 會把兩份完全不同的 JSON 當成同一個備份的兩個
 *   分段串在一起，串出來的字串不是合法 JSON，那兩份備份就**同時報廢**。
 *
 *   所以撞名時在後面加一個序號（`-2`、`-3`……），由呼叫方傳入現有的
 *   編號清單。
 * Args:
 *   quarterId {string} 季度 ID。
 *   now {Date} 現在時間。
 *   timezone {string} 時區。
 *   existingIds {string[]=} 已經存在的備份編號，用來避開撞名。
 * Returns:
 *   {string}
 */
function buildBackupId_(quarterId, now, timezone, existingIds) {
  var base = String(quarterId) + '-' + Utilities.formatDate(now, timezone, "yyyyMMdd'T'HHmmss");
  var taken = {};
  (existingIds || []).forEach(function (id) { taken[id] = true; });

  if (!taken[base]) return base;
  for (var n = 2; n <= 1000; n++) {
    if (!taken[base + '-' + n]) return base + '-' + n;
  }
  return base + '-' + now.getTime();
}

/**
 * 用途：把一批資料列內的 `Date` 值轉成 `yyyy-MM-dd` 字串，供序列化用。
 *   純函式。
 *
 *   ⚠️ **這一步不可以省略。** `JSON.stringify()` 會把 `Date` 變成 ISO
 *   日期時間字串（`2027-11-06T11:00:00.000Z`——注意時區偏移已經令日期
 *   跳到前一日），`JSON.parse()` 回來只是一個字串、不再是 `Date`。
 *   還原時用那個字串去對 `SERVICE_DATE` 就**一個主日都對不上**，
 *   結果是「還原成功、改動 0 格」——一份看起來有、其實還原不到的備份。
 *   這比完全沒有備份更危險，因為人會信任它。
 * Args:
 *   rows {Object[]} 資料列。
 * Returns:
 *   {Object[]} 新的陣列，`Date` 欄位已經轉成 `yyyy-MM-dd` 字串。
 */
function normalizeRowsForBackup_(rows) {
  return (rows || []).map(function (row) {
    var out = {};
    Object.keys(row).forEach(function (key) {
      var value = row[key];
      out[key] = (value && Object.prototype.toString.call(value) === '[object Date]')
        ? fillGridCellText_(value)
        : value;
    });
    return out;
  });
}

/**
 * 用途：把該季全部資料序列化成 JSON。純函式。
 * Args:
 *   input {{quarterId:string, weekRows:Object[], announcements:Object[],
 *          prayers:Object[], fellowships:Object[], finance:Object[]}}
 * Returns:
 *   {{json:string, rowCount:number}}
 */
function buildBackupPayload_(input) {
  var payload = {
    quarterId: input.quarterId,
    bulletinWeeks: normalizeRowsForBackup_(input.weekRows),
    announcements: normalizeRowsForBackup_(input.announcements),
    prayers: normalizeRowsForBackup_(input.prayers),
    fellowships: normalizeRowsForBackup_(input.fellowships),
    finance: normalizeRowsForBackup_(input.finance)
  };

  var rowCount = payload.bulletinWeeks.length + payload.announcements.length
    + payload.prayers.length + payload.fellowships.length + payload.finance.length;

  return { json: JSON.stringify(payload), rowCount: rowCount };
}

/**
 * 用途：判斷一個清單表的資料列屬不屬於指定季度。
 *
 *   四張清單表（`Announcements` 等）**沒有 `QUARTER_ID` 欄**，只有
 *   `SERVICE_DATE`，所以要靠「這個主日在不在該季的主日清單內」判斷。
 * Args:
 *   row {Object} 資料列。
 *   isoDateSet {Object<string,boolean>} 該季全部主日。
 * Returns:
 *   {boolean}
 */
function rowBelongsToQuarter_(row, isoDateSet) {
  var iso = fillGridCellText_(row.SERVICE_DATE);
  return Boolean(iso && isoDateSet[iso]);
}

/**
 * 用途：讀出該季全部要備份的資料。
 * Args:
 *   quarterId {string} 季度 ID。
 * Returns:
 *   {{weekRows:Object[], announcements:Object[], prayers:Object[],
 *     fellowships:Object[], finance:Object[]}}
 */
function readQuarterDataForBackup_(quarterId) {
  var weekRows = readSheet(SHEETS.BULLETIN_WEEKS).filter(function (r) {
    return String(r.QUARTER_ID || '') === quarterId;
  });

  var isoDateSet = {};
  weekRows.forEach(function (r) {
    var iso = fillGridCellText_(r.SERVICE_DATE);
    if (iso) isoDateSet[iso] = true;
  });

  function listRows(sheetName) {
    return readSheet(sheetName).filter(function (r) { return rowBelongsToQuarter_(r, isoDateSet); });
  }

  return {
    weekRows: weekRows,
    announcements: listRows(SHEETS.ANNOUNCEMENTS),
    prayers: listRows(SHEETS.PRAYERS),
    fellowships: listRows(SHEETS.FELLOWSHIPS),
    finance: listRows(SHEETS.FINANCE)
  };
}

/**
 * 用途：為指定季度做一次備份。真正入口。
 * Args:
 *   quarterId {string} 季度 ID。
 *   reason {string} 觸發原因，見 `FILL_BACKUP_REASON`。
 * Returns:
 *   {{backupId:string, partCount:number, rowCount:number, prunedCount:number}}
 * Raises:
 *   Error 如果 `FillBackup` 工作表不存在。
 */
function createFillBackup_(quarterId, reason) {
  var data = readQuarterDataForBackup_(quarterId);
  var payload = buildBackupPayload_(Object.assign({ quarterId: quarterId }, data));

  var timezone = getConfig(CONFIG_KEYS.SYS_TIMEZONE, 'Pacific/Auckland');
  var now = new Date();
  // ⚠️ 要把**全部**季度的既有編號都傳進去避開撞名，不只本季——編號本身
  // 已經含季度，理論上不會跨季撞，但多比一次沒有成本。
  var existingIds = readFillBackupRowsSafe_().map(function (r) { return String(r.BACKUP_ID || ''); });
  var backupId = buildBackupId_(quarterId, now, timezone, existingIds);
  var actor = currentUserEmailForBackup_();

  var parts = splitBackupPayload_(payload.json);
  var rows = parts.map(function (part, i) {
    return {
      BACKUP_ID: backupId,
      PART_NO: i + 1,
      QUARTER_ID: quarterId,
      CREATED_AT: now,
      CREATED_BY: sanitizeCellText_(actor),
      REASON: sanitizeCellText_(reason || FILL_BACKUP_REASON.MANUAL),
      // ⚠️ JSON 以 `{` 開頭，不是 `=`／`+`／`-`／`@`，所以其實不會被當成
      // 公式；但一律經 sanitizeCellText_() 是本專案的硬規則，不開例外。
      PAYLOAD_JSON: sanitizeCellText_(part),
      ROW_COUNT: payload.rowCount
    };
  });

  writeSheet(SHEETS.FILL_BACKUP, rows);

  appendAuditLog_({
    action: 'FILL_BACKUP_CREATE', sheetName: SHEETS.FILL_BACKUP,
    rowKey: backupId, field: 'REASON', oldValue: '', newValue: reason || FILL_BACKUP_REASON.MANUAL,
    notes: '備份季度 ' + quarterId + '，共 ' + payload.rowCount + ' 行資料、分成 ' + parts.length + ' 段。'
  });

  return {
    backupId: backupId,
    partCount: parts.length,
    rowCount: payload.rowCount,
    prunedCount: pruneOldBackups_(quarterId)
  };
}

/**
 * 用途：取得目前使用者的電郵，供 `CREATED_BY` 用。取不到時回一個明確的
 *   佔位字串而不是空白。
 * Args: （無）
 * Returns:
 *   {string}
 */
function currentUserEmailForBackup_() {
  try {
    return Session.getActiveUser().getEmail() || '（未知使用者）';
  } catch (err) {
    return '（未知使用者）';
  }
}

/**
 * 用途：把 `FillBackup` 的資料列依 `BACKUP_ID` 分組。純函式。
 * Args:
 *   rows {Object[]} `FillBackup` 的資料列。
 *   quarterId {string=} 只收這一季的；省略代表全收。
 * Returns:
 *   {{backupId:string, quarterId:string, createdAt:*, createdBy:string,
 *     reason:string, rowCount:number, parts:Object[]}[]}
 *     依 `backupId` 由**新到舊**排序（`backupId` 含時間戳記，所以字串
 *     倒序就是時間倒序）。
 */
function groupFillBackups_(rows, quarterId) {
  var byId = {};
  (rows || []).forEach(function (row) {
    if (quarterId && String(row.QUARTER_ID || '') !== quarterId) return;
    var id = String(row.BACKUP_ID || '');
    if (!id) return;
    if (!byId[id]) {
      byId[id] = {
        backupId: id, quarterId: String(row.QUARTER_ID || ''),
        createdAt: row.CREATED_AT, createdBy: String(row.CREATED_BY || ''),
        reason: String(row.REASON || ''), rowCount: Number(row.ROW_COUNT) || 0, parts: []
      };
    }
    byId[id].parts.push(row);
  });

  return Object.keys(byId)
    .sort(function (a, b) { return a < b ? 1 : (a > b ? -1 : 0); })
    .map(function (id) { return byId[id]; });
}

/**
 * 用途：列出指定季度的全部備份（由新到舊）。
 * Args:
 *   quarterId {string} 季度 ID。
 * Returns:
 *   {Object[]} `groupFillBackups_()` 的輸出。
 */
function listFillBackups_(quarterId) {
  return groupFillBackups_(readFillBackupRowsSafe_(), quarterId);
}

/**
 * 用途：讀 `FillBackup`，工作表不存在時回空陣列而不是拋錯——「還沒有
 *   備份過」不是錯誤。
 * Args: （無）
 * Returns:
 *   {Object[]}
 */
function readFillBackupRowsSafe_() {
  try {
    return readSheet(SHEETS.FILL_BACKUP);
  } catch (err) {
    return [];
  }
}

/**
 * 用途：算出「保留最新 N 個備份」之下，哪些 `BACKUP_ID` 要刪。純函式。
 * Args:
 *   groups {Object[]} `groupFillBackups_()` 的輸出（已經由新到舊排序）。
 *   keep {number} 保留數目。
 * Returns:
 *   {string[]} 要刪除的 `BACKUP_ID`。
 */
function backupIdsToPrune_(groups, keep) {
  var limit = Number(keep);
  if (!Number.isFinite(limit) || limit < 1) limit = 20;
  return (groups || []).slice(limit).map(function (g) { return g.backupId; });
}

/**
 * 用途：刪走超出 `FILL_BACKUP_KEEP` 的舊備份。
 *
 *   ⚠️ **這是全系統唯一容許刪行的地方**，理由見檔頭。刪的一定是最舊的，
 *   而且只動 `FillBackup` 這一張表。
 * Args:
 *   quarterId {string} 季度 ID。
 * Returns:
 *   {number} 刪除的**備份數**（不是行數）。
 */
function pruneOldBackups_(quarterId) {
  var keep = normalizeInt_(getConfig(CONFIG_KEYS.FILL_BACKUP_KEEP, '20'));
  var groups = listFillBackups_(quarterId);
  var doomed = backupIdsToPrune_(groups, keep);
  if (doomed.length === 0) return 0;

  var doomedSet = {};
  doomed.forEach(function (id) { doomedSet[id] = true; });

  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.FILL_BACKUP);
  if (!sheet) return 0;

  var kept = readFillBackupRowsSafe_().filter(function (row) { return !doomedSet[String(row.BACKUP_ID || '')]; });

  var lastRow = sheet.getLastRow();
  if (lastRow > 2) {
    sheet.getRange(3, 1, lastRow - 2, COLUMNS.FILL_BACKUP.keys.length).clearContent();
  }
  if (kept.length > 0) writeSheet(SHEETS.FILL_BACKUP, kept);

  appendAuditLog_({
    action: 'FILL_BACKUP_PRUNE', sheetName: SHEETS.FILL_BACKUP,
    rowKey: quarterId, field: 'BACKUP_ID', oldValue: doomed.join('、'), newValue: '',
    notes: '保留數目上限 ' + keep + '，刪走最舊的 ' + doomed.length + ' 個備份。'
      + '這是全系統唯一容許刪行的地方，見 src/FillBackup.gs 檔頭。'
  });

  return doomed.length;
}

// =====================================================================
// 還原
// =====================================================================

/**
 * 用途：把一個備份的 JSON 還原成物件。
 * Args:
 *   group {Object} `groupFillBackups_()` 的其中一項。
 * Returns:
 *   {Object} 解析後的 payload。
 * Raises:
 *   Error 如果 JSON 解析失敗——多數代表備份被截斷或被人手改壞，
 *     這時**一定要拋錯**，不可以還原一份殘缺的資料。
 */
function parseFillBackupPayload_(group) {
  var json = joinBackupPayload_(group.parts);
  try {
    return JSON.parse(json);
  } catch (err) {
    throw new Error(
      'parseFillBackupPayload_：備份「' + group.backupId + '」的內容解析失敗（'
      + (err && err.message ? err.message : String(err)) + '）。'
      + '這通常代表備份被截斷或被人手改動過。**不會**還原一份殘缺的資料——'
      + '請改用另一個備份。'
    );
  }
}

/**
 * 用途：算出「把備份還原回去」要改動哪些格。純函式。
 *
 *   只比對 `BulletinWeeks` 的**可編輯欄**（`fillGridEditableKeys_()`），
 *   系統欄（`STATUS`／`DOC_ID`／`SENT_AT` 等）不還原——那些是系統自己
 *   維護的狀態，還原它們只會令狀態與現實脫節。
 * Args:
 *   payload {Object} `parseFillBackupPayload_()` 的輸出。
 *   currentWeekRowsByIso {Object<string,Object>} `BulletinWeeks` 現況。
 * Returns:
 *   {{changes:{isoDate:string, fieldKey:string, oldValue:string,
 *      newValue:string}[], affectedDates:string[]}}
 */
function buildFillRestorePlan_(payload, currentWeekRowsByIso) {
  var editableKeys = fillGridEditableKeys_();
  var current = currentWeekRowsByIso || {};
  var changes = [];
  var affected = {};

  (payload.bulletinWeeks || []).forEach(function (backupRow) {
    var iso = fillGridCellText_(backupRow.SERVICE_DATE);
    if (!iso) return;
    var now = current[iso];
    if (!now) return; // 備份裡有、現在沒有的主日：不新增行，只還原既有的

    editableKeys.forEach(function (key) {
      var oldValue = fillGridCellText_(now[key]);
      var newValue = fillGridCellText_(backupRow[key]);
      if (oldValue === newValue) return;
      changes.push({ isoDate: iso, fieldKey: key, oldValue: oldValue, newValue: newValue });
      affected[iso] = true;
    });
  });

  return { changes: changes, affectedDates: Object.keys(affected).sort() };
}

/**
 * 用途：算出還原的差異摘要（**唯讀**，不寫任何一格）。供還原對話框
 *   在確認之前顯示。
 * Args:
 *   quarterId {string} 季度 ID。
 *   backupId {string} 要還原的備份編號。
 * Returns:
 *   {{ok:boolean, backupId:string, changes:Object[], affectedDates:string[],
 *     fieldSummary:{fieldKey:string, label:string, count:number}[],
 *     message:(string|undefined)}}
 */
function previewFillRestore_(quarterId, backupId) {
  var group = listFillBackups_(quarterId).filter(function (g) { return g.backupId === backupId; })[0];
  if (!group) {
    return { ok: false, backupId: backupId, changes: [], affectedDates: [], fieldSummary: [], message: '找不到備份「' + backupId + '」。' };
  }

  var payload = parseFillBackupPayload_(group);
  var plan = buildFillRestorePlan_(payload, readBulletinWeekRowsByIso_(quarterId));

  var labelByKey = {};
  fillGridColumnDefs_().forEach(function (d) { labelByKey[d.key] = d.label; });

  var countByField = {};
  plan.changes.forEach(function (c) { countByField[c.fieldKey] = (countByField[c.fieldKey] || 0) + 1; });

  return {
    ok: true, backupId: backupId,
    changes: plan.changes, affectedDates: plan.affectedDates,
    fieldSummary: Object.keys(countByField).sort().map(function (k) {
      return { fieldKey: k, label: labelByKey[k] || k, count: countByField[k] };
    })
  };
}

/**
 * 用途：真正執行還原。
 *
 *   ⚠️ **還原之前一定會再做一次備份**（原因 `BEFORE_RESTORE`）——還原
 *   本身也是一次大規模改動，如果揀錯了備份，要有得再還原回來。
 *
 *   逐格寫入並逐格記 `AuditLog`，最後更新 `FillSnapshot`（否則下一次
 *   同步會把還原誤判成「系統單方面改過」而去刷新格子表——雖然結果一樣，
 *   但會產生一堆沒有意義的 `PULL` 記錄）。
 * Args:
 *   quarterId {string} 季度 ID。
 *   backupId {string} 要還原的備份編號。
 * Returns:
 *   {{ok:boolean, restoredCount:number, safetyBackupId:(string|undefined),
 *     message:(string|undefined)}}
 * Raises:
 *   Error 如果備份內容解析失敗（見 `parseFillBackupPayload_()`）。
 */
function restoreFillBackup_(quarterId, backupId) {
  var preview = previewFillRestore_(quarterId, backupId);
  if (!preview.ok) return { ok: false, restoredCount: 0, message: preview.message };

  // ⚠️ 先備份現況再還原。
  var safety = createFillBackup_(quarterId, FILL_BACKUP_REASON.BEFORE_RESTORE);

  var snapshotEntries = [];
  preview.changes.forEach(function (change) {
    writeBulletinWeekField_(change.isoDate, change.fieldKey, change.newValue);
    appendAuditLog_({
      action: 'FILL_BACKUP_RESTORE', sheetName: SHEETS.BULLETIN_WEEKS,
      rowKey: change.isoDate, field: change.fieldKey,
      oldValue: change.oldValue, newValue: change.newValue,
      notes: '由備份「' + backupId + '」還原。還原前的現況已經另外備份成「' + safety.backupId + '」。'
    });
    snapshotEntries.push({ isoDate: change.isoDate, fieldKey: change.fieldKey, value: change.newValue });
  });

  if (snapshotEntries.length > 0) writeFillSnapshotEntries_(quarterId, snapshotEntries);

  return { ok: true, restoredCount: preview.changes.length, safetyBackupId: safety.backupId };
}
