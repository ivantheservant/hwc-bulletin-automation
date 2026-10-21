/**
 * WeekSnapshots.gs
 *
 * 每週版本記錄（第二批階段 2）：每個主日各自的「版本」，可以看差異、還原，
 * 也可以把整個主日重設回建立時的樣子。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 一個版本裏面有什麼
 * ─────────────────────────────────────────────────────────────────────
 *
 *   - 該主日 `BulletinWeeks` 那一行（全部欄位）；
 *   - 該主日生效中的 `DutyOverride` 行與 `FieldOverride` 行；
 *   - 四張清單（家事報告、代禱、團契、財政）不存內容，只在 `SUMMARY`
 *     記條數——它們以內容表為準，還原不會動它們。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 什麼時候存
 * ─────────────────────────────────────────────────────────────────────
 *
 * 一律在寫入之前存，而且只在那一次真的會改到該主日時才存（原因代碼見
 * `WEEK_SNAPSHOT_REASONS`）。唯一的例外是 `WORD_GENERATED`：它記的是產生
 * Word 當下的內容，所以在產生之後存，並記下 Word 檔案 ID。
 *
 * ⚠️ 存版本失敗不可以令一般的儲存失敗（`trySnapshotWeek_()` 不拋錯，改為
 * 回傳一則警告，由呼叫方顯示）。但「重設」與「還原」是例外：它們的安全網
 * 就是這個版本，存不到就一格都不寫（直接用 `createWeekSnapshot_()`，會拋錯）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 與其他備份機制的分別
 * ─────────────────────────────────────────────────────────────────────
 *
 *   - `FillBackup` 是整季的備份（季度填寫表用）；本檔案是單一主日。
 *   - 長 JSON 的分拆與串回重用 `FillBackup.gs` 的 `splitBackupPayload_()`／
 *     `joinBackupPayload_()`，版本編號重用 `buildBackupId_()`，不另寫一份。
 *   - 不刪行：舊版本一直保留，列表只顯示最新的 `SNAPSHOT_LIST_LIMIT` 個。
 */

'use strict';

// =====================================================================
// 純函式層
// =====================================================================

/**
 * 用途：把版本原因代碼換成中文名稱。純函式。
 * Args:
 *   code {string} `WEEK_SNAPSHOT_REASONS` 的鍵。
 * Returns:
 *   {string} 查不到就原樣回代碼——講一個代碼，好過不講。
 */
function weekSnapshotReasonLabel_(code) {
  var key = String(code === null || code === undefined ? '' : code);
  return Object.prototype.hasOwnProperty.call(WEEK_SNAPSHOT_REASONS, key) ? WEEK_SNAPSHOT_REASONS[key] : key;
}

/**
 * 用途：版本建立時間的顯示文字（`yyyy-MM-dd HH:mm`）。純函式。版本列表、
 *   看差異、還原完成訊息共用這一支，時間格式只有一處。
 * Args:
 *   date {*} `WeekSnapshots.CREATED_AT`（工作表讀出來的 Date）。
 *   timezone {string} Config 的 `SYS_TIMEZONE`。
 * Returns:
 *   {string} 不是有效的 Date（讀不到、被人手改成文字）回空字串。
 * Raises:
 *   Error `Utilities.formatDate()` 拋的錯（例如 `timezone` 無效）原樣拋出。
 */
function weekSnapshotStampText_(date, timezone) {
  // ⚠️ 用 toString 判斷，不用 instanceof：工作表讀出來的 Date 不一定與本檔案
  //    同一個執行環境建立（測試的假工作表就不是）。
  if (Object.prototype.toString.call(date) !== '[object Date]' || isNaN(date.getTime())) return '';
  return Utilities.formatDate(date, timezone, 'yyyy-MM-dd HH:mm');
}

/**
 * 用途：給幹事看的版本名稱「時間（原因中文名）」，例如
 *   「2026-10-21 19:43（填寫介面儲存）」。純函式。
 *
 *   ⚠️ 第二批測試修正 G5：完成訊息不可以顯示內部版本 ID
 *   （例如「2028-04-16-20261021T194316」），幹事看不明白；要與版本列表、
 *   還原對話框用同一個寫法。`AuditLog` 照舊記 ID，方便日後追查。
 * Args:
 *   group {{createdAt:*, reason:string}} `groupWeekSnapshots_()` 的一項。
 *   timezone {string} Config 的 `SYS_TIMEZONE`。
 * Returns:
 *   {string} 時間讀不到時寫「（時間不明）」（與填寫介面版本列表、還原對話框的
 *     退回字眼相同），不會只剩一個原因括號。
 * Raises:
 *   Error 同 `weekSnapshotStampText_()`（呼叫方要不要退回，自己決定，見
 *     `restoreVersionLabel_()`）。
 */
function weekSnapshotDisplayName_(group, timezone) {
  var g = group || {};
  var stamp = weekSnapshotStampText_(g.createdAt, timezone) || '（時間不明）';
  return stamp + '（' + weekSnapshotReasonLabel_(g.reason) + '）';
}

/**
 * 用途：「季度填寫表」一族的版本原因——同一個主日在時間限制之內只存一次。
 *   純函式。
 * Args: （無）
 * Returns:
 *   {string[]}
 */
function weekSnapshotThrottledReasons_() {
  return ['GRID_SYNC', 'GRID_EDIT', 'GRID_CONFLICT'];
}

/**
 * 用途：只顯示電郵 `@` 之前的部分。純函式。
 * Args:
 *   email {*} 電郵或佔位字串（例如「（未知使用者）」）。
 * Returns:
 *   {string} 沒有 `@` 就原樣回傳。
 */
function weekSnapshotActorShort_(email) {
  var text = String(email === null || email === undefined ? '' : email);
  var at = text.indexOf('@');
  return at > 0 ? text.slice(0, at) : text;
}

/**
 * 用途：把一個值正規化成可以比較的文字。純函式。
 *   `Date` 用 `yyyy-MM-dd`、布林用 `TRUE`／`FALSE`、`null`／`undefined` 是
 *   空字串，其餘轉字串。與 `FillBackup` 序列化時的處理一致，所以「從工作表
 *   讀出來的 Date」與「版本內存的日期文字」比得起來。
 * Args:
 *   value {*}
 * Returns:
 *   {string}
 */
function weekSnapshotText_(value) {
  return fillGridCellText_(value);
}

/**
 * 用途：組出一個版本的內容（JSON）。純函式。
 * Args:
 *   input {{isoDate:string, quarterId:string, weekRow:Object, dutyRows:Object[],
 *     fieldRows:Object[], listCounts:Object<string,number>}}
 *     `dutyRows`／`fieldRows` 只放生效中的行。
 * Returns:
 *   {{payload:Object, json:string}}
 */
function buildWeekSnapshotPayload_(input) {
  var weekRow = {};
  Object.keys(input.weekRow || {}).forEach(function (key) {
    if (key !== '__rowNo') weekRow[key] = input.weekRow[key];
  });

  var payload = {
    version: 1,
    isoDate: input.isoDate,
    quarterId: input.quarterId || '',
    // ⚠️ Date 一定要先轉文字：JSON.stringify() 會把 Date 變成 ISO 時間字串
    // （時區偏移令日期跳到前一日），見 FillBackup.gs 的 normalizeRowsForBackup_()。
    week: normalizeRowsForBackup_([weekRow])[0],
    dutyOverrides: (input.dutyRows || []).map(function (row) {
      return {
        POST_ID: String(row.POST_ID || ''),
        SLOT_INDEX: (row.SLOT_INDEX === null || row.SLOT_INDEX === undefined || row.SLOT_INDEX === '') ? 1 : Number(row.SLOT_INDEX),
        OVERRIDE_NAME: String(row.OVERRIDE_NAME || ''),
        ROSTER_VALUE_AT_OVERRIDE: String(row.ROSTER_VALUE_AT_OVERRIDE || ''),
        ROSTER_VERSION_AT_OVERRIDE: (row.ROSTER_VERSION_AT_OVERRIDE === null || row.ROSTER_VERSION_AT_OVERRIDE === undefined)
          ? '' : row.ROSTER_VERSION_AT_OVERRIDE,
        REASON: String(row.REASON || '')
      };
    }),
    fieldOverrides: (input.fieldRows || []).map(function (row) {
      return {
        FIELD_KEY: String(row.FIELD_KEY || ''),
        OVERRIDE_VALUE: String(row.OVERRIDE_VALUE === null || row.OVERRIDE_VALUE === undefined ? '' : row.OVERRIDE_VALUE),
        SOURCE_VALUE_AT_OVERRIDE: String(row.SOURCE_VALUE_AT_OVERRIDE === null || row.SOURCE_VALUE_AT_OVERRIDE === undefined
          ? '' : row.SOURCE_VALUE_AT_OVERRIDE),
        REASON: String(row.REASON || '')
      };
    }),
    listCounts: input.listCounts || {}
  };

  return { payload: payload, json: JSON.stringify(payload) };
}

/**
 * 用途：組出一個版本的一句摘要（列表上顯示）。純函式。
 *   四張清單只報條數，名稱重用 `CONTENT_SHEET_READONLY_LABELS`。
 * Args:
 *   payload {Object} `buildWeekSnapshotPayload_()` 的 `payload`。
 * Returns:
 *   {string}
 */
function summarizeWeekSnapshotPayload_(payload) {
  var week = payload.week || {};
  var filled = webAppEditableWeekFieldKeys_().filter(function (key) {
    return weekSnapshotText_(week[key]).trim() !== '';
  }).length;

  var counts = payload.listCounts || {};
  var listText = ['announcements', 'prayers', 'fellowships', 'finance'].map(function (type) {
    return CONTENT_SHEET_READONLY_LABELS[type] + ' ' + (Number(counts[type]) || 0) + ' 條';
  }).join('、');

  return '填寫欄位 ' + filled + ' 格有內容；事奉框覆寫 ' + (payload.dutyOverrides || []).length
    + ' 項；手動覆寫的欄位 ' + (payload.fieldOverrides || []).length + ' 項；'
    + listText + '（四項以內容表為準，只記條數）';
}

/**
 * 用途：把 `WeekSnapshots` 的資料列依 `SNAPSHOT_ID` 分組，只收指定主日、
 *   `ACTIVE` 的版本，由新到舊。純函式。
 * Args:
 *   rows {Object[]} `readSheet(SHEETS.WEEK_SNAPSHOTS)` 的輸出。
 *   isoDate {string} 主日日期，yyyy-MM-dd。
 * Returns:
 *   {{snapshotId:string, isoDate:string, quarterId:string, createdAt:*, createdBy:string,
 *     reason:string, summary:string, docFileId:string, parts:Object[]}[]}
 *     版本編號含時間戳記，字串倒序就是時間倒序。
 */
function groupWeekSnapshots_(rows, isoDate) {
  var byId = {};
  (rows || []).forEach(function (row) {
    if (row.ACTIVE === false) return;
    if (fieldOverrideIsoOf_(row.SERVICE_DATE) !== isoDate) return;
    var id = String(row.SNAPSHOT_ID || '');
    if (!id) return;
    if (!byId[id]) {
      byId[id] = {
        snapshotId: id, isoDate: isoDate, quarterId: String(row.QUARTER_ID || ''),
        createdAt: row.CREATED_AT, createdBy: String(row.CREATED_BY || ''),
        reason: String(row.REASON || ''), summary: String(row.SUMMARY || ''),
        docFileId: String(row.DOC_FILE_ID || ''), parts: []
      };
    }
    byId[id].parts.push(row);
  });

  return Object.keys(byId)
    .sort(function (a, b) { return a < b ? 1 : (a > b ? -1 : 0); })
    .map(function (id) { return byId[id]; });
}

/**
 * 用途：判斷「季度填寫表」一族的版本要不要因為時間限制而略過。純函式。
 *   只看同一族原因（`weekSnapshotThrottledReasons_()`）最新的一個版本——
 *   其他動作（例如剛剛在填寫介面儲存過）不算數，因為那一個版本記的是
 *   儲存之前的內容，不等於現在的內容。
 * Args:
 *   groups {Object[]} `groupWeekSnapshots_()` 的輸出（由新到舊）。
 *   nowMs {number} 現在的毫秒時間戳記。
 *   minutes {number} 時間限制（分鐘）；0 或以下代表不限制。
 * Returns:
 *   {boolean}
 */
function isWeekSnapshotThrottled_(groups, nowMs, minutes) {
  var limit = Number(minutes);
  if (!Number.isFinite(limit) || limit <= 0) return false;
  var reasons = weekSnapshotThrottledReasons_();
  var latest = (groups || []).filter(function (g) { return reasons.indexOf(g.reason) !== -1; })[0];
  if (!latest) return false;
  var createdMs = dateCellToTime_(latest.createdAt);
  if (createdMs === null) return false;
  return (nowMs - createdMs) < limit * 60 * 1000;
}

/**
 * 用途：把一個版本的 JSON 還原成物件。
 * Args:
 *   group {Object} `groupWeekSnapshots_()` 的其中一項。
 * Returns:
 *   {Object} 解析後的 payload。
 * Raises:
 *   Error 如果 JSON 解析失敗（多數代表被截斷或被人手改動）——一定要拋錯，
 *     不可以用一份殘缺的資料去還原。
 */
function parseWeekSnapshotGroup_(group) {
  var json = joinBackupPayload_(group.parts);
  try {
    return JSON.parse(json);
  } catch (err) {
    throw new Error(
      '版本「' + group.snapshotId + '」的內容解析失敗（' + ((err && err.message) ? err.message : String(err))
      + '）。這通常代表它被截斷或被人手改動過。不會用一份殘缺的資料去還原——請改用另一個版本。'
    );
  }
}

/**
 * 用途：給一個事奉框覆寫格取中文名稱。純函式。
 * Args:
 *   postId {string} 崗位 ID。
 *   slotIndex {number} 位次。
 *   postDisplayRows {Object[]} `PostDisplay` 的資料列。
 * Returns:
 *   {string} 例如「主席」；同一崗位有多位時加「（第 2 位）」。找不到名稱就用崗位 ID。
 */
function weekSnapshotDutyLabel_(postId, slotIndex, postDisplayRows) {
  var row = (postDisplayRows || []).filter(function (r) { return String(r.POST_ID || '') === String(postId); })[0];
  var name = row ? (String(row.PAGE1_NAME || '') || String(row.PAGE3_NAME || '')) : '';
  var label = name || String(postId);
  var slot = Number(slotIndex);
  return slot > 1 ? (label + '（第 ' + slot + ' 位）') : label;
}

/**
 * 用途：逐項比對「某個版本」與「現在」，給「看差異」和還原對話框用。
 *   純函式。
 *
 *   三類差異（只列真的不同的項目）：
 *     - `FIELD`　　　填寫介面可以編輯的 `BulletinWeeks` 欄位（系統欄與內容表
 *                     接管的欄位不比，因為還原不會動它們）；
 *     - `DUTY`　　　 事奉框覆寫；
 *     - `FIELD_OVERRIDE`　第三種欄位（內容表為來源、介面可覆寫）的手動覆寫。
 * Args:
 *   payload {Object} 版本內容。
 *   current {{weekRow:Object, dutyRows:Object[], fieldRows:Object[]}} 現況；
 *     `dutyRows`／`fieldRows` 只放生效中的行。
 *   postDisplayRows {Object[]} `PostDisplay` 的資料列（給事奉框取名稱）。
 * Returns:
 *   {{kind:string, label:string, snapshotValue:string, currentValue:string}[]}
 *     沒有覆寫的一邊，值是空字串（前端顯示成「（沒有覆寫）」）。
 */
function diffWeekSnapshotState_(payload, current, postDisplayRows) {
  var labels = webAppWeekFieldLabels_();
  var rows = [];
  var snapWeek = payload.week || {};
  var curWeek = current.weekRow || {};

  webAppEditableWeekFieldKeys_().forEach(function (key) {
    var snapValue = weekSnapshotText_(snapWeek[key]);
    var curValue = weekSnapshotText_(curWeek[key]);
    if (snapValue === curValue) return;
    rows.push({ kind: 'FIELD', label: labels[key] || key, snapshotValue: snapValue, currentValue: curValue });
  });

  var snapDuty = {};
  (payload.dutyOverrides || []).forEach(function (r) {
    var key = dutyOverrideKey_(r.POST_ID, r.SLOT_INDEX);
    if (!(key in snapDuty)) snapDuty[key] = r;
  });
  var curDuty = {};
  (current.dutyRows || []).forEach(function (r) {
    var key = dutyOverrideKey_(r.POST_ID, r.SLOT_INDEX);
    if (!(key in curDuty)) curDuty[key] = r;
  });
  var dutyKeys = Object.keys(snapDuty).concat(Object.keys(curDuty).filter(function (k) { return !(k in snapDuty); })).sort();
  dutyKeys.forEach(function (key) {
    var snapName = snapDuty[key] ? String(snapDuty[key].OVERRIDE_NAME || '') : '';
    var curName = curDuty[key] ? String(curDuty[key].OVERRIDE_NAME || '') : '';
    if (snapName === curName) return;
    var source = snapDuty[key] || curDuty[key];
    rows.push({
      kind: 'DUTY', label: '事奉框：' + weekSnapshotDutyLabel_(source.POST_ID, source.SLOT_INDEX, postDisplayRows),
      snapshotValue: snapName, currentValue: curName
    });
  });

  var snapFields = {};
  (payload.fieldOverrides || []).forEach(function (r) {
    if (!(r.FIELD_KEY in snapFields)) snapFields[r.FIELD_KEY] = r;
  });
  var curFields = {};
  (current.fieldRows || []).forEach(function (r) {
    if (!(r.FIELD_KEY in curFields)) curFields[r.FIELD_KEY] = r;
  });
  var fieldKeys = Object.keys(snapFields).concat(Object.keys(curFields).filter(function (k) { return !(k in snapFields); })).sort();
  fieldKeys.forEach(function (key) {
    var snapValue = snapFields[key] ? fieldOverrideNormalize_(snapFields[key].OVERRIDE_VALUE) : '';
    var curValue = curFields[key] ? fieldOverrideNormalize_(curFields[key].OVERRIDE_VALUE) : '';
    var snapSource = snapFields[key] ? fieldOverrideNormalize_(snapFields[key].SOURCE_VALUE_AT_OVERRIDE) : '';
    var curSource = curFields[key] ? fieldOverrideNormalize_(curFields[key].SOURCE_VALUE_AT_OVERRIDE) : '';
    var sameOverrideState = Boolean(snapFields[key]) === Boolean(curFields[key]);
    if (sameOverrideState && snapValue === curValue && snapSource === curSource) return;
    rows.push({
      kind: 'FIELD_OVERRIDE', label: '手動覆寫的欄位：' + (labels[key] || key),
      snapshotValue: snapValue, currentValue: curValue
    });
  });

  return rows;
}

/**
 * 用途：算出「還原到某個版本」要改動什麼。純函式。
 *
 *   ⚠️ 事奉框覆寫與欄位覆寫的計畫刻意做成與 `computeDutyOverridePlan_()`／
 *   `computeFieldOverridePlan_()` 同一個形狀，這樣真正寫入時直接重用
 *   `applyDutyOverridePlan_()`／`applyFieldOverridePlan_()`，不另寫一份寫入
 *   邏輯。規則：
 *     - 該版本有、現在沒有（或已停用／內容不同）的覆寫 → 補回／重新啟用／改回；
 *     - 該版本沒有、現在生效中的覆寫 → 停用（`ACTIVE=FALSE`，不刪行）。
 * Args:
 *   payload {Object} 版本內容。
 *   current {{weekRow:Object, dutyRowsAll:Object[], fieldRowsAll:Object[]}} 現況；
 *     `*RowsAll` 含已停用的行並帶 `__rowNo`（同一個主日＋鍵只可以有一行，
 *     停用之後再覆寫要改返原本那一行）。
 * Returns:
 *   {{fieldChanges:{field:string, oldValue:*, newValue:*}[],
 *     dutyPlan:{updates:Object[], appends:Object[], deactivations:Object[]},
 *     fieldOverridePlan:{upserts:Object[], deactivations:Object[], unchanged:number}}}
 */
function planWeekSnapshotRestore_(payload, current) {
  var snapWeek = payload.week || {};
  var curWeek = current.weekRow || {};

  var fieldChanges = [];
  webAppEditableWeekFieldKeys_().forEach(function (key) {
    if (!Object.prototype.hasOwnProperty.call(snapWeek, key)) return;
    if (weekSnapshotText_(snapWeek[key]) === weekSnapshotText_(curWeek[key])) return;
    fieldChanges.push({ field: key, oldValue: curWeek[key], newValue: snapWeek[key] });
  });

  // ---- 事奉框覆寫 ----
  var snapDuty = {};
  (payload.dutyOverrides || []).forEach(function (r) {
    var key = dutyOverrideKey_(r.POST_ID, r.SLOT_INDEX);
    if (!(key in snapDuty)) snapDuty[key] = r;
  });
  var curDutyAll = {};
  (current.dutyRowsAll || []).forEach(function (r) {
    var key = dutyOverrideKey_(r.POST_ID, r.SLOT_INDEX);
    if (!(key in curDutyAll)) curDutyAll[key] = r;
  });

  var dutyPlan = { updates: [], appends: [], deactivations: [] };
  Object.keys(snapDuty).forEach(function (key) {
    var s = snapDuty[key];
    var existing = curDutyAll[key];
    var slotIndex = Number(s.SLOT_INDEX) || 1;
    if (!existing) {
      dutyPlan.appends.push({
        POST_ID: s.POST_ID, SLOT_INDEX: slotIndex, OVERRIDE_NAME: s.OVERRIDE_NAME,
        ROSTER_VALUE_AT_OVERRIDE: s.ROSTER_VALUE_AT_OVERRIDE,
        ROSTER_VERSION_AT_OVERRIDE: s.ROSTER_VERSION_AT_OVERRIDE,
        REASON: s.REASON, ACTIVE: true, NOTES: ''
      });
      return;
    }
    var changes = [];
    ['OVERRIDE_NAME', 'ROSTER_VALUE_AT_OVERRIDE', 'ROSTER_VERSION_AT_OVERRIDE', 'REASON'].forEach(function (field) {
      if (!fieldsEqual_(existing[field], s[field])) {
        changes.push({ field: field, oldValue: existing[field], newValue: s[field] });
      }
    });
    if (existing.ACTIVE !== true) changes.push({ field: 'ACTIVE', oldValue: existing.ACTIVE, newValue: true });
    if (changes.length > 0) {
      dutyPlan.updates.push({ rowNo: existing.__rowNo, changes: changes, postId: s.POST_ID, slotIndex: slotIndex });
    }
  });
  Object.keys(curDutyAll).forEach(function (key) {
    var existing = curDutyAll[key];
    if (existing.ACTIVE !== true || key in snapDuty) return;
    dutyPlan.deactivations.push({
      rowNo: existing.__rowNo, postId: existing.POST_ID,
      slotIndex: Number(existing.SLOT_INDEX) || 1, oldValue: String(existing.OVERRIDE_NAME || '')
    });
  });

  // ---- 第三種欄位的手動覆寫 ----
  var snapFields = {};
  (payload.fieldOverrides || []).forEach(function (r) {
    if (!(r.FIELD_KEY in snapFields)) snapFields[r.FIELD_KEY] = r;
  });
  var curFieldsAll = {};
  (current.fieldRowsAll || []).forEach(function (r) {
    var key = String(r.FIELD_KEY || '');
    if (!(key in curFieldsAll)) curFieldsAll[key] = r;
  });

  var fieldOverridePlan = { upserts: [], deactivations: [], unchanged: 0 };
  Object.keys(snapFields).forEach(function (key) {
    var s = snapFields[key];
    var existing = curFieldsAll[key];
    var same = existing && existing.ACTIVE === true
      && fieldOverrideNormalize_(existing.OVERRIDE_VALUE) === fieldOverrideNormalize_(s.OVERRIDE_VALUE)
      && fieldOverrideNormalize_(existing.SOURCE_VALUE_AT_OVERRIDE) === fieldOverrideNormalize_(s.SOURCE_VALUE_AT_OVERRIDE);
    if (same) { fieldOverridePlan.unchanged++; return; }
    fieldOverridePlan.upserts.push({
      fieldKey: key, overrideValue: fieldOverrideNormalize_(s.OVERRIDE_VALUE),
      sourceValue: fieldOverrideNormalize_(s.SOURCE_VALUE_AT_OVERRIDE)
    });
  });
  Object.keys(curFieldsAll).forEach(function (key) {
    var existing = curFieldsAll[key];
    if (existing.ACTIVE !== true || key in snapFields) return;
    fieldOverridePlan.deactivations.push({ fieldKey: key, row: existing });
  });

  return { fieldChanges: fieldChanges, dutyPlan: dutyPlan, fieldOverridePlan: fieldOverridePlan };
}

/**
 * 用途：判斷一份事奉框覆寫計畫有沒有任何要寫的東西。純函式。
 * Args:
 *   plan {?Object} `computeDutyOverridePlan_()` 形狀的計畫。
 * Returns:
 *   {boolean} `null`／`undefined` 當作沒有。
 */
function dutyOverridePlanHasChanges_(plan) {
  return Boolean(plan) && (plan.updates.length > 0 || plan.appends.length > 0 || plan.deactivations.length > 0);
}

/**
 * 用途：判斷一份欄位覆寫計畫有沒有任何要寫的東西。純函式。
 * Args:
 *   plan {?Object} `computeFieldOverridePlan_()` 形狀的計畫。
 * Returns:
 *   {boolean}
 */
function fieldOverridePlanHasChanges_(plan) {
  return Boolean(plan) && ((plan.upserts || []).length > 0 || (plan.deactivations || []).length > 0);
}

/**
 * 用途：把版本警告併進儲存結果的訊息。純函式。
 *   有警告就一律改成 `error` 類型（常駐、要使用者看到），文字先講已儲存。
 * Args:
 *   message {{type:string, text:string}} `buildSaveResultMessage_()` 的輸出。
 *   warnings {string[]} 版本記錄的警告。
 * Returns:
 *   {{type:string, text:string}} 新物件。
 */
function appendSnapshotWarnings_(message, warnings) {
  if (!warnings || warnings.length === 0) return message;
  return { type: 'error', text: message.text + '　⚠️ ' + warnings.join('　') };
}

// =====================================================================
// IO 層——讀現況、存版本
// =====================================================================

/**
 * 用途：讀出某個主日目前的完整狀態（版本內容與還原都用這一份）。
 *
 *   ⚠️ `DutyOverride`／`FieldOverride` 讀不到時拋錯，不當作「沒有覆寫」：
 *   把讀不到說成沒有，存出來的版本就會漏掉覆寫，還原時反而把它們全部停用。
 * Args:
 *   isoDate {string} 主日日期，yyyy-MM-dd。
 * Returns:
 *   {{weekRow:?Object, dutyRowsAll:Object[], fieldRowsAll:Object[],
 *     dutyRows:Object[], fieldRows:Object[], listCounts:Object<string,number>}}
 *     `weekRow` 帶 `__rowNo`，沒有這一行是 `null`；`*RowsAll` 含已停用的行並帶
 *     `__rowNo`；`dutyRows`／`fieldRows` 只含生效中的行。
 * Raises:
 *   Error 如果 `DutyOverride`／`FieldOverride` 工作表不存在。
 */
function readWeekStateForSnapshot_(isoDate) {
  var weekRow = readBulletinWeekRowWithRowNo_(isoDate);
  var dutyRowsAll = readDutyOverrideRowsWithRowNo_(isoDate);
  var fieldRowsAll = readRowsWithRowNo_(SHEETS.FIELD_OVERRIDE).filter(function (r) {
    return fieldOverrideIsoOf_(r.SERVICE_DATE) === isoDate;
  });

  var listCounts = {};
  var listDefs = webAppListDefs_();
  Object.keys(listDefs).forEach(function (type) {
    listCounts[type] = pickWebAppListItems_(readSheet(listDefs[type].sheetName), isoDate, []).length;
  });

  return {
    weekRow: weekRow,
    dutyRowsAll: dutyRowsAll,
    fieldRowsAll: fieldRowsAll,
    dutyRows: dutyRowsAll.filter(function (r) { return r.ACTIVE === true; }),
    fieldRows: fieldRowsAll.filter(function (r) { return r.ACTIVE === true; }),
    listCounts: listCounts
  };
}

/**
 * 用途：為某個主日存一個版本。會拋錯——「重設」「還原」靠它當安全網。
 *   一般的寫入動作改用不拋錯的 `trySnapshotWeek_()`。
 * Args:
 *   isoDate {string} 主日日期，yyyy-MM-dd。
 *   reason {string} `WEEK_SNAPSHOT_REASONS` 的鍵。
 *   options {{throttle:boolean=, dedupeSameReason:boolean=, docFileId:string=,
 *     actor:string=, snapshotRows:Object[]=}=}
 *     `throttle`：套用 `SNAPSHOT_THROTTLE_MINUTES`（季度填寫表一族用）；
 *     `dedupeSameReason`：內容與同一原因的最新版本完全相同就不再存
 *     （`WORD_GENERATED` 用，免得每次下載都多一個版本）；
 *     `docFileId`：記進 `DOC_FILE_ID`；
 *     `actor`：記進 `CREATED_BY`（表單提交觸發器裏查不到操作者，就用答題者的電郵）；
 *     `snapshotRows`：呼叫方已經讀好的 `WeekSnapshots` 資料列（一次替十幾個
 *     主日存版本時只讀一次，這張表每行可能有 49000 字元，逐個主日重讀很慢）。
 *     只可以傳給不同主日的連續呼叫——同一個主日要存第二個版本時必須重讀。
 * Returns:
 *   {{created:boolean, snapshotId:string, skipped:string, partCount:number}}
 *     `skipped` 是 `''`（有存）、`'THROTTLED'`、`'UNCHANGED'` 或 `'NO_WEEK'`
 *     （這個主日沒有週報那一行，沒有東西可存）。
 * Raises:
 *   Error 如果 `reason` 不認識、`WeekSnapshots` 等工作表不存在。
 */
function createWeekSnapshot_(isoDate, reason, options) {
  var opts = options || {};
  if (!Object.prototype.hasOwnProperty.call(WEEK_SNAPSHOT_REASONS, reason)) {
    throw new Error('createWeekSnapshot_：不認識的版本原因「' + reason + '」。');
  }

  var state = readWeekStateForSnapshot_(isoDate);
  if (!state.weekRow) return { created: false, snapshotId: '', skipped: 'NO_WEEK', partCount: 0 };

  var allRows = opts.snapshotRows || readSheet(SHEETS.WEEK_SNAPSHOTS);
  var groups = groupWeekSnapshots_(allRows, isoDate);
  var now = new Date();

  if (opts.throttle === true) {
    var minutes = normalizeInt_(getConfig(CONFIG_KEYS.SNAPSHOT_THROTTLE_MINUTES, '15'));
    if (isWeekSnapshotThrottled_(groups, now.getTime(), minutes)) {
      return { created: false, snapshotId: '', skipped: 'THROTTLED', partCount: 0 };
    }
  }

  var built = buildWeekSnapshotPayload_({
    isoDate: isoDate, quarterId: String(state.weekRow.QUARTER_ID || ''),
    weekRow: state.weekRow, dutyRows: state.dutyRows, fieldRows: state.fieldRows,
    listCounts: state.listCounts
  });

  if (opts.dedupeSameReason === true) {
    var latestSame = groups.filter(function (g) { return g.reason === reason; })[0];
    if (latestSame && joinBackupPayload_(latestSame.parts) === built.json) {
      return { created: false, snapshotId: latestSame.snapshotId, skipped: 'UNCHANGED', partCount: 0 };
    }
  }

  var timezone = getConfig(CONFIG_KEYS.SYS_TIMEZONE, 'Pacific/Auckland');
  var existingIds = allRows.map(function (r) { return String(r.SNAPSHOT_ID || ''); });
  var snapshotId = buildBackupId_(isoDate, now, timezone, existingIds);
  var actor = opts.actor ? String(opts.actor) : currentUserEmailForBackup_();
  var summary = summarizeWeekSnapshotPayload_(built.payload);
  var parts = splitBackupPayload_(built.json);

  var rows = parts.map(function (part, i) {
    return {
      SNAPSHOT_ID: snapshotId,
      PART_NO: i + 1,
      SERVICE_DATE: normalizeDate_(isoDate),
      QUARTER_ID: sanitizeCellText_(String(state.weekRow.QUARTER_ID || '')),
      CREATED_AT: now,
      CREATED_BY: sanitizeCellText_(actor),
      REASON: reason,
      SUMMARY: sanitizeCellText_(summary),
      // ⚠️ 內容不經 sanitizeCellText_()：這一欄是純文字格式，不會被當成公式；
      // 而分段之後的片段可能剛好以 `-`、`=` 開頭，加了前導單引號再串回去
      // 就是一份壞掉的 JSON。
      PAYLOAD_JSON: part,
      DOC_FILE_ID: sanitizeCellText_(String(opts.docFileId || '')),
      ACTIVE: true
    };
  });
  writeSheet(SHEETS.WEEK_SNAPSHOTS, rows);

  appendAuditLog_({
    action: 'WEEK_SNAPSHOT_CREATE', sheetName: SHEETS.WEEK_SNAPSHOTS,
    rowKey: snapshotId, field: 'REASON', oldValue: '', newValue: reason,
    notes: '主日 ' + isoDate + ' 存了一個版本（' + weekSnapshotReasonLabel_(reason) + '），分成 ' + parts.length + ' 段。'
  });

  return { created: true, snapshotId: snapshotId, skipped: '', partCount: parts.length };
}

/**
 * 用途：`createWeekSnapshot_()` 的不拋錯版本，給一般的寫入動作用——存版本
 *   失敗不可以令使用者的儲存失敗（資料還沒寫，最壞的後果是這次改動之後
 *   不能用「還原」找回）。失敗會記一筆 `ErrorLog`，並回傳一句警告讓呼叫方顯示。
 * Args:
 *   isoDate {string} 主日日期。
 *   reason {string} `WEEK_SNAPSHOT_REASONS` 的鍵。
 *   options {Object=} 同 `createWeekSnapshot_()`。
 * Returns:
 *   {{created:boolean, snapshotId:string, skipped:string, warning:string}}
 *     成功時 `warning` 是空字串。
 */
function trySnapshotWeek_(isoDate, reason, options) {
  try {
    var result = createWeekSnapshot_(isoDate, reason, options);
    return { created: result.created, snapshotId: result.snapshotId, skipped: result.skipped, warning: '' };
  } catch (err) {
    var message = (err && err.message) ? err.message : String(err);
    try {
      appendErrorLog_({
        source: ERROR_LOG_SOURCE.SERVER,
        functionName: 'trySnapshotWeek_',
        errorCode: 'WEEK_SNAPSHOT_FAILED',
        message: '主日 ' + isoDate + ' 的版本記錄（' + weekSnapshotReasonLabel_(reason) + '）存不到：' + message
      });
    } catch (logErr) {
      // 連 ErrorLog 都寫不到時，不可以再令呼叫方失敗。
    }
    return {
      created: false, snapshotId: '', skipped: '',
      warning: '版本記錄未能存好（' + isoDate + '：' + message + '），這次改動不能用「還原」找回。'
    };
  }
}

/**
 * 用途：為一批主日各存一個版本（每個主日一個，重複的日期只存一次）。
 *   給整季匯入、補抓、同步這類一次動到多個主日的動作用。不拋錯。
 * Args:
 *   isoDates {string[]} 主日日期。
 *   reason {string} `WEEK_SNAPSHOT_REASONS` 的鍵。
 *   options {Object=} 同 `createWeekSnapshot_()`。
 * Returns:
 *   {string[]} 警告（全部成功就是空陣列）。
 */
function snapshotWeeksBeforeWrite_(isoDates, reason, options) {
  var seen = {};
  var dates = [];
  (isoDates || []).forEach(function (isoDate) {
    if (!isoDate || seen[isoDate]) return;
    seen[isoDate] = true;
    dates.push(isoDate);
  });

  var shared = Object.assign({}, options || {});
  // 多個主日時只讀一次 WeekSnapshots（每個主日各自的版本編號含日期，不會互相撞名）。
  // 讀不到就不傳，由每個主日自己去讀、自己報錯。
  if (dates.length > 1 && !shared.snapshotRows) {
    try {
      shared.snapshotRows = readSheet(SHEETS.WEEK_SNAPSHOTS);
    } catch (err) {
      shared.snapshotRows = undefined;
    }
  }

  var warnings = [];
  dates.forEach(function (isoDate) {
    var result = trySnapshotWeek_(isoDate, reason, shared);
    if (result.warning) warnings.push(result.warning);
  });
  return warnings;
}

// =====================================================================
// 填寫介面用的入口
// =====================================================================

/**
 * 用途：列出某個主日的版本記錄與發佈記錄（填寫介面「版本記錄」區塊）。
 * Args:
 *   isoDate {string} 主日日期，yyyy-MM-dd。
 * Returns:
 *   {{isoDate:string, lastSavedAt:string, totalCount:number, shownCount:number,
 *     versions:Object[], published:Object[]}}
 *     `versions` 每項 `{snapshotId, createdAt, createdBy, reason, reasonLabel,
 *     summary, docUrl}`（`createdBy` 只含電郵 `@` 之前）；`published` 每項
 *     `{versionNo, publishedAt, archiveUrl, forced}`。
 * Raises:
 *   Error 如果 `isoDate` 格式不對，或 `WeekSnapshots` 工作表不存在。
 */
function listWeekSnapshotsForWebApp_(isoDate) {
  if (!normalizeDate_(isoDate)) {
    throw new Error('listWeekSnapshotsForWebApp_：isoDate 必須是 yyyy-MM-dd 格式，收到：' + JSON.stringify(isoDate));
  }
  var timezone = getConfig(CONFIG_KEYS.SYS_TIMEZONE, 'Pacific/Auckland');
  function stamp(date) {
    return weekSnapshotStampText_(date, timezone);
  }

  var limit = normalizeInt_(getConfig(CONFIG_KEYS.SNAPSHOT_LIST_LIMIT, '20'));
  if (!Number.isFinite(limit) || limit < 1) limit = 20;
  var groups = groupWeekSnapshots_(readSheet(SHEETS.WEEK_SNAPSHOTS), isoDate);

  var versions = groups.slice(0, limit).map(function (g) {
    return {
      snapshotId: g.snapshotId, createdAt: stamp(g.createdAt),
      createdBy: weekSnapshotActorShort_(g.createdBy),
      reason: g.reason, reasonLabel: weekSnapshotReasonLabel_(g.reason),
      summary: g.summary, docUrl: driveFileViewUrl_(g.docFileId)
    };
  });

  var published = filterPublishedRowsForDate_(readSheet(SHEETS.PUBLISH_LOG), isoDate).sort(function (a, b) {
    return (Number(b.VERSION_NO) || 0) - (Number(a.VERSION_NO) || 0);
  }).map(function (r) {
    return {
      versionNo: Number(r.VERSION_NO) || 0, publishedAt: stamp(r.PUBLISHED_AT),
      archiveUrl: driveFileViewUrl_(r.ARCHIVE_FILE_ID), forced: r.FORCED === true
    };
  });

  var weekRow = readBulletinWeekRowWithRowNo_(isoDate);
  return {
    isoDate: isoDate,
    lastSavedAt: canonicalSaveToken_(weekRow ? weekRow.LAST_SAVED_AT : null),
    totalCount: groups.length, shownCount: versions.length,
    versions: versions, published: published
  };
}

/**
 * 用途：找出某個主日的某個版本並解析（「看差異」「還原」共用）。
 * Args:
 *   isoDate {string} 主日日期。
 *   snapshotId {string} 版本編號。
 * Returns:
 *   {{group:Object, payload:Object}}
 * Raises:
 *   Error（`code:'SNAPSHOT_NOT_FOUND'`）如果找不到；內容壞掉時原樣拋出
 *     `parseWeekSnapshotGroup_()` 的錯。
 */
function loadWeekSnapshot_(isoDate, snapshotId) {
  var group = groupWeekSnapshots_(readSheet(SHEETS.WEEK_SNAPSHOTS), isoDate).filter(function (g) {
    return g.snapshotId === String(snapshotId || '');
  })[0];
  if (!group) {
    var err = new Error('找不到主日 ' + isoDate + ' 的版本「' + snapshotId + '」。請重新載入版本記錄。');
    err.code = 'SNAPSHOT_NOT_FOUND';
    throw err;
  }
  return { group: group, payload: parseWeekSnapshotGroup_(group) };
}

/**
 * 用途：「看差異」——逐項列出某個版本與現在的不同。唯讀。
 * Args:
 *   isoDate {string} 主日日期。
 *   snapshotId {string} 版本編號。
 * Returns:
 *   {{isoDate:string, snapshotId:string, createdAt:string, reasonLabel:string,
 *     lastSavedAt:string, rows:Object[], noteLine:string}}
 *     `rows` 見 `diffWeekSnapshotState_()`；`lastSavedAt` 是現況的鎖定值，
 *     還原時要原樣送回（別的分頁在這之間改過就拒絕還原）；`noteLine` 是還原
 *     對話框最後一句，由後端給，前端不另抄。
 * Raises:
 *   Error 同 `loadWeekSnapshot_()`。
 */
function diffWeekSnapshotForWebApp_(isoDate, snapshotId) {
  var loaded = loadWeekSnapshot_(isoDate, snapshotId);
  var state = readWeekStateForSnapshot_(isoDate);
  var timezone = getConfig(CONFIG_KEYS.SYS_TIMEZONE, 'Pacific/Auckland');
  var created = loaded.group.createdAt;

  return {
    isoDate: isoDate, snapshotId: loaded.group.snapshotId,
    createdAt: weekSnapshotStampText_(created, timezone),
    reasonLabel: weekSnapshotReasonLabel_(loaded.group.reason),
    lastSavedAt: canonicalSaveToken_(state.weekRow ? state.weekRow.LAST_SAVED_AT : null),
    rows: diffWeekSnapshotState_(loaded.payload, state, readSheet(SHEETS.POST_DISPLAY)),
    noteLine: weekSnapshotRestoreNote_()
  };
}

/**
 * 用途：還原對話框最後一句（也是「還原不動什麼」的唯一說明）。純函式。
 * Args: （無）
 * Returns:
 *   {string}
 */
function weekSnapshotRestoreNote_() {
  return '家事報告、代禱、團契、財政以內容表為準，不會還原；要改請到內容表（試算表本身也有版本記錄）。';
}

/**
 * 用途：把鎖定值（`LAST_SAVED_AT` 的文字）與目前工作表比對，不符就拋錯。
 *   還原與重設共用，規則與儲存相同（`checkOptimisticLock_()`）。
 * Args:
 *   weekRow {Object} 目前 `BulletinWeeks` 那一行。
 *   lastSavedAt {*} 前端帶來的鎖定值；`undefined` 代表呼叫方不要求檢查。
 * Returns:
 *   {void}
 * Raises:
 *   Error（`code:'STALE'`）如果不符。
 */
function assertWeekNotChangedSince_(weekRow, lastSavedAt) {
  if (lastSavedAt === undefined) return;
  if (checkOptimisticLock_(weekRow.LAST_SAVED_AT, lastSavedAt)) return;
  var err = new Error('這一週的資料在你打開版本記錄之後被改過，請重新載入後再操作，以免覆蓋別人的修改。');
  err.code = 'STALE';
  throw err;
}

/**
 * 用途：把還原／重設算出來的欄位異動、事奉框覆寫計畫、欄位覆寫計畫真正寫入，
 *   全部經既有的寫入函式，並把 `AuditLog` 條目的動作代碼統一換成指定的一個
 *   （`WEEK_RESTORE`／`WEEK_RESET`）。
 * Args:
 *   isoDate {string} 主日日期。
 *   rowNo {number} `BulletinWeeks` 該主日的行號。
 *   plan {{fieldChanges:Object[], dutyPlan:Object, fieldOverridePlan:Object}}
 *   action {string} AuditLog 動作代碼。
 *   noteHead {string} 每筆記錄備註的開頭（說明這是由哪個版本還原／重設）。
 * Returns:
 *   {Object[]} 已經整理好、尚未寫入的 AuditLog 條目（呼叫方負責寫，這樣和
 *     儲存一樣是「全部寫完才記帳」）。
 */
function applyWeekRestorePlan_(isoDate, rowNo, plan, action, noteHead) {
  var entries = [];
  var targetDate = normalizeDate_(isoDate);

  applyWeekFieldChanges_(rowNo, plan.fieldChanges, isoDate, entries, action);
  applyDutyOverridePlan_(plan.dutyPlan, targetDate, isoDate, getCallerEmail_(), entries);
  applyFieldOverridePlan_(plan.fieldOverridePlan, targetDate, isoDate, getCallerEmail_(), entries);

  entries.forEach(function (entry) {
    entry.action = action;
    entry.notes = noteHead + (entry.notes ? entry.notes : '');
  });
  return entries;
}

/**
 * 用途：還原到某個版本。
 *
 *   步驟：核對鎖定值 → 算出要改什麼（沒有任何差異就什麼都不寫）→ 先存一個
 *   `BEFORE_RESTORE` 版本（存不到就中止）→ 週報欄位只寫有差異的格 → 事奉框
 *   覆寫與欄位覆寫改回與該版本相同（多出來的停用，缺的補回或重新啟用，不刪行）
 *   → 刷新 `FillSnapshot` 與格子表 → 更新 `LAST_SAVED_AT` → 逐格 `AuditLog`
 *   `WEEK_RESTORE`。
 *
 *   系統欄（`STATUS`、`SENT_AT`、`DOC_ID` 等）與內容表接管的欄位不還原，四張清單
 *   也不還原。
 * Args:
 *   payload {{isoDate:string, snapshotId:string, lastSavedAt:string=}} 前端送來的
 *     請求；`lastSavedAt` 是「看差異」時拿到的鎖定值。
 * Returns:
 *   {{restoredFieldCount:number, dutyChangeCount:number, fieldOverrideChangeCount:number,
 *     safetySnapshotId:string, lastSavedAt:string, message:{type:string, text:string}}}
 *     `message.text` 用「時間（原因中文名）」稱呼版本（`weekSnapshotDisplayName_()`），
 *     不顯示內部 ID（第二批測試修正 G5）；`AuditLog` 備註照舊記 ID。
 * Raises:
 *   Error 找不到版本／那一週（`SNAPSHOT_NOT_FOUND`）、鎖定值不符（`STALE`）、
 *     存不到安全版本，或任何寫入失敗。
 */
function restoreWeekSnapshotFromWebApp_(payload) {
  if (!payload || !payload.isoDate || !payload.snapshotId) {
    throw new Error('restoreWeekSnapshotFromWebApp_：payload.isoDate 與 payload.snapshotId 都是必填欄位。');
  }
  var isoDate = payload.isoDate;
  var loaded = loadWeekSnapshot_(isoDate, payload.snapshotId);
  var state = readWeekStateForSnapshot_(isoDate);
  if (!state.weekRow) {
    throw new Error('主日 ' + isoDate + ' 在 BulletinWeeks 沒有資料行，無法還原。');
  }
  assertWeekNotChangedSince_(state.weekRow, payload.lastSavedAt);

  var plan = planWeekSnapshotRestore_(loaded.payload, state);
  var dutyCount = plan.dutyPlan.updates.length + plan.dutyPlan.appends.length + plan.dutyPlan.deactivations.length;
  var fieldOverrideCount = plan.fieldOverridePlan.upserts.length + plan.fieldOverridePlan.deactivations.length;

  if (plan.fieldChanges.length === 0 && dutyCount === 0 && fieldOverrideCount === 0) {
    return {
      restoredFieldCount: 0, dutyChangeCount: 0, fieldOverrideChangeCount: 0, safetySnapshotId: '',
      lastSavedAt: canonicalSaveToken_(state.weekRow.LAST_SAVED_AT),
      message: { type: 'info', text: '這個版本與現在的內容一樣，沒有東西需要還原。' }
    };
  }

  // ⚠️ 第二批測試修正 G11：完成訊息的版本名稱在任何寫入之前算好。排在寫入
  // 之後的話，時區設定錯令 formatDate 拋錯時，還原其實已經做完，介面卻顯示錯誤，
  // 幹事會以為沒有還原而再做一次。
  var versionLabel = restoreVersionLabel_(loaded.group);

  // ⚠️ 先存安全版本。存不到就一格都不寫——還原本身是一次大規模改動，
  // 揀錯版本要有得再還原回來。
  var safety = createWeekSnapshot_(isoDate, 'BEFORE_RESTORE');
  var entries = applyWeekRestorePlan_(isoDate, state.weekRow.__rowNo, plan, 'WEEK_RESTORE',
    '由版本「' + loaded.group.snapshotId + '」還原；還原前的現況已另存為版本「' + safety.snapshotId + '」。');

  var stamp = new Date();
  writeWeekCell_(state.weekRow.__rowNo, 'LAST_SAVED_AT', stamp);
  entries.forEach(function (entry) { appendAuditLog_(entry); });

  refreshFillSnapshotAfterSave_(isoDate, plan.fieldChanges.map(function (c) {
    return { field: c.field, newValue: c.newValue };
  }));

  return {
    restoredFieldCount: plan.fieldChanges.length, dutyChangeCount: dutyCount,
    fieldOverrideChangeCount: fieldOverrideCount, safetySnapshotId: safety.snapshotId,
    lastSavedAt: canonicalSaveToken_(stamp),
    message: {
      type: 'success',
      text: '已還原到版本「' + versionLabel + '」：週報欄位 ' + plan.fieldChanges.length
        + ' 格、事奉框覆寫 ' + dutyCount + ' 項、手動覆寫的欄位 ' + fieldOverrideCount
        + ' 項。還原前的現況已另存成一個版本，萬一揀錯可以再還原回來。'
    }
  };
}

/**
 * 用途：還原完成訊息要用的版本名稱「時間（原因中文名）」。第二批測試修正 G11。
 *
 *   ⚠️ 只是顯示用的字眼，算不到（例如 Config 的 `SYS_TIMEZONE` 填錯，令
 *   `Utilities.formatDate()` 拋錯）不可以令還原失敗：退回「（時間不明）（原因）」，
 *   並把原因寫進 `ErrorLog`，不會靜靜吞掉。
 * Args:
 *   group {{createdAt:*, reason:string, snapshotId:string}} `groupWeekSnapshots_()` 的一項。
 * Returns:
 *   {string}
 * Raises:
 *   （無）算不到就退回「（時間不明）」並寫 `ErrorLog`。
 */
function restoreVersionLabel_(group) {
  try {
    return weekSnapshotDisplayName_(group, getConfig(CONFIG_KEYS.SYS_TIMEZONE, 'Pacific/Auckland'));
  } catch (err) {
    // appendErrorLog_() 自己不會拋錯（寫不到就回 false）。
    appendErrorLog_({
      source: ERROR_LOG_SOURCE.SERVER,
      functionName: 'restoreVersionLabel_',
      errorCode: 'SNAPSHOT_LABEL_FAILED',
      message: '還原完成訊息的版本時間算不到（版本「' + String((group || {}).snapshotId || '') + '」），'
        + '已改寫「（時間不明）」：' + ((err && err.message) ? err.message : String(err)),
      detail: buildErrorDetail_(err)
    });
    return '（時間不明）（' + weekSnapshotReasonLabel_((group || {}).reason) + '）';
  }
}

/**
 * 用途：把 `BulletinWeeks` 一個空白週報行的預設值（建立本季空白週報時用）。
 *   純函式。「建立本季空白週報」與「重設這一週」共用這一支，預設值只有
 *   一個定義。
 * Args:
 *   input {{isoDate:string, quarterId:string, snapshot:Object, resolvedTemplateId:string,
 *     defaults:{prelude:string, pageTitle:string, attendanceHeading:string,
 *     nextWeekHeading:string, prayerBlockHeading:string}, rosterStatus:string}}
 * Returns:
 *   {Object} `BulletinWeeks` 的一行（機器鍵 → 值），`SERVICE_DATE` 是 `Date`。
 */
function buildBlankWeekRow_(input) {
  var targetDate = normalizeDate_(input.isoDate);
  var snapshot = input.snapshot || {};
  var special = snapshot.special;
  var defaults = input.defaults;

  return {
    SERVICE_DATE: targetDate,
    // ⚠️ 一定要用呼叫方指定的季度，不可以用 `snapshot.quarterId`。
    //    快照那個值是職事表自己講這個日期屬於哪一季；兩者不一致時，
    //    用快照那個＝把一行寫進另一個季度，而畫面上完全看不出來。
    //    「決定處理哪一季」是呼叫方的事，職事表只負責答「這一天有沒有
    //    資料」。見 docs/已知bug類型.md 事故四十一。
    QUARTER_ID: input.quarterId,
    WEEK_OF_MONTH: snapshot.weekOfMonth,
    SPECIAL_TYPE: special ? special.title : '',
    PAGE_TITLE: defaults.pageTitle,
    PROGRAM_TEMPLATE_ID: input.resolvedTemplateId,
    PRELUDE: defaults.prelude,
    ATTENDANCE_HEADING: defaults.attendanceHeading,
    ATTENDANCE_DATE: addDays_(targetDate, -7),
    NEXT_WEEK_HEADING: defaults.nextWeekHeading,
    PRAYER_BLOCK_HEADING: defaults.prayerBlockHeading,
    STATUS: BULLETIN_WEEK_STATUS.DRAFT,
    ROSTER_STATUS: input.rosterStatus
  };
}

/**
 * 用途：讀出建立空白週報行用的預設值與範本判斷設定（Config）。
 *   「建立本季空白週報」與「重設這一週」共用。
 * Args: （無）
 * Returns:
 *   {{defaults:Object, templateConfig:Object}}
 */
function readBlankWeekSettings_() {
  return {
    templateConfig: {
      baptismKeywords: getConfigTextList_(CONFIG_KEYS.TEMPLATE_KEYWORDS_BAPTISM, '浸禮'),
      anniversaryKeywords: getConfigTextList_(CONFIG_KEYS.TEMPLATE_KEYWORDS_ANNIVERSARY, '堂慶,週年'),
      templateDefault: getConfig(CONFIG_KEYS.TEMPLATE_DEFAULT, 'TPL_NORMAL')
    },
    defaults: {
      prelude: getConfig(CONFIG_KEYS.PRELUDE_DEFAULT, ''),
      pageTitle: getConfig(CONFIG_KEYS.DEFAULT_PAGE_TITLE, '崇拜程序'),
      attendanceHeading: getConfig(CONFIG_KEYS.DEFAULT_ATTENDANCE_HEADING, '上週主日崇拜人數'),
      nextWeekHeading: getConfig(CONFIG_KEYS.DEFAULT_NEXT_WEEK_HEADING, '下週主日崇拜聚會事奉肢體'),
      prayerBlockHeading: getConfig(CONFIG_KEYS.DEFAULT_PRAYER_BLOCK_HEADING, '代禱事項')
    }
  };
}

/**
 * 用途：算出「重設這一週」要改什麼。純函式。
 *   填寫介面可以編輯的每一個欄位改回空白骨架的預設值（骨架沒有定義的欄位
 *   就是空白）；這個主日所有生效中的事奉框覆寫與欄位覆寫全部停用。
 * Args:
 *   blankRow {Object} `buildBlankWeekRow_()` 的輸出。
 *   current {{weekRow:Object, dutyRowsAll:Object[], fieldRowsAll:Object[]}} 現況。
 * Returns:
 *   {{fieldChanges:Object[], dutyPlan:Object, fieldOverridePlan:Object}} 與
 *     `planWeekSnapshotRestore_()` 同一個形狀。
 */
function planWeekReset_(blankRow, current) {
  var curWeek = current.weekRow || {};
  var fieldChanges = [];
  webAppEditableWeekFieldKeys_().forEach(function (key) {
    var target = Object.prototype.hasOwnProperty.call(blankRow, key) ? blankRow[key] : '';
    if (weekSnapshotText_(target) === weekSnapshotText_(curWeek[key])) return;
    fieldChanges.push({ field: key, oldValue: curWeek[key], newValue: target });
  });

  var dutyPlan = { updates: [], appends: [], deactivations: [] };
  var seenDuty = {};
  (current.dutyRowsAll || []).forEach(function (row) {
    var key = dutyOverrideKey_(row.POST_ID, row.SLOT_INDEX);
    if (seenDuty[key]) return;
    seenDuty[key] = true;
    if (row.ACTIVE !== true) return;
    dutyPlan.deactivations.push({
      rowNo: row.__rowNo, postId: row.POST_ID, slotIndex: Number(row.SLOT_INDEX) || 1,
      oldValue: String(row.OVERRIDE_NAME || '')
    });
  });

  var fieldOverridePlan = { upserts: [], deactivations: [], unchanged: 0 };
  var seenField = {};
  (current.fieldRowsAll || []).forEach(function (row) {
    var key = String(row.FIELD_KEY || '');
    if (seenField[key]) return;
    seenField[key] = true;
    if (row.ACTIVE !== true) return;
    fieldOverridePlan.deactivations.push({ fieldKey: key, row: row });
  });

  return { fieldChanges: fieldChanges, dutyPlan: dutyPlan, fieldOverridePlan: fieldOverridePlan };
}

/**
 * 用途：重設這一週。真正入口。
 *
 *   步驟：核對鎖定值 → 先存一個 `BEFORE_RESET` 版本（存不到就中止）→ 填寫
 *   介面可編輯的欄位改回建立空白週報時的預設值（與「建立本季空白週報」共用
 *   `buildBlankWeekRow_()`）→ 這個主日全部事奉框覆寫（包括上一週「下週事奉」
 *   改到這一週的）與欄位覆寫停用（不刪行）→ 本季已有內容表就由內容表重新匯入
 *   這一個主日 → 更新 `LAST_SAVED_AT` → 刷新 `FillSnapshot` 與格子表 →
 *   `AuditLog` `WEEK_RESET`。
 *
 *   職事表一格都不會改；已發佈的 PDF、已寄出的郵件、已產生的 Word 檔都不受影響。
 * Args:
 *   isoDate {string} 主日日期，yyyy-MM-dd。
 *   lastSavedAt {string=} 前端載入時拿到的鎖定值；省略就不檢查。
 * Returns:
 *   {{resetFieldCount:number, dutyClearedCount:number, fieldOverrideClearedCount:number,
 *     safetySnapshotId:string, importMessage:string, lastSavedAt:string,
 *     message:{type:string, text:string}}}
 * Raises:
 *   Error 主日格式不對、BulletinWeeks 沒有那一行、鎖定值不符（`STALE`）、存不到
 *     安全版本，或任何寫入失敗。
 */
function resetWeekFromWebApp_(isoDate, lastSavedAt) {
  if (!isoDate || !normalizeDate_(isoDate)) {
    throw new Error('resetWeekFromWebApp_：isoDate 必須是 yyyy-MM-dd 格式，收到：' + JSON.stringify(isoDate));
  }
  var state = readWeekStateForSnapshot_(isoDate);
  if (!state.weekRow) {
    throw new Error('主日 ' + isoDate + ' 在 BulletinWeeks 沒有資料行，無從重設。請先用選單「建立本季空白週報」。');
  }
  assertWeekNotChangedSince_(state.weekRow, lastSavedAt);

  var quarterId = String(state.weekRow.QUARTER_ID || '');
  var settings = readBlankWeekSettings_();
  var rosterSnapshot = readRosterSnapshot_(isoDate);
  var resolved = resolveProgramTemplateId_({}, rosterSnapshot, settings.templateConfig);
  var blankRow = buildBlankWeekRow_({
    isoDate: isoDate, quarterId: quarterId, snapshot: rosterSnapshot,
    resolvedTemplateId: resolved.templateId, defaults: settings.defaults,
    rosterStatus: String(state.weekRow.ROSTER_STATUS || '')
  });
  var plan = planWeekReset_(blankRow, state);

  // ⚠️ 先存安全版本。存不到就一格都不寫。
  var safety = createWeekSnapshot_(isoDate, 'BEFORE_RESET');
  var entries = applyWeekRestorePlan_(isoDate, state.weekRow.__rowNo, plan, 'WEEK_RESET',
    '重設這一週；重設前的現況已另存為版本「' + safety.snapshotId + '」。');
  entries.forEach(function (entry) { appendAuditLog_(entry); });

  // 本季已有內容表就重新匯入這一個主日。已經存過安全版本，匯入不必再存一個。
  var importMessage = '';
  var hasContentSheet = false;
  try {
    hasContentSheet = Boolean(quarterId && findContentSheetRow_(quarterId));
  } catch (lookupErr) {
    importMessage = '查不到本季有沒有內容表（' + ((lookupErr && lookupErr.message) ? lookupErr.message : String(lookupErr)) + '），沒有重新匯入。';
  }
  if (hasContentSheet) {
    var imported = applyContentImport_(quarterId, { isoDate: isoDate, skipSnapshot: true });
    importMessage = imported.ok
      ? '已由內容表重新匯入這一個主日。'
      : ('由內容表重新匯入失敗：' + (imported.message || imported.reason || '原因不明'));
  }

  var stamp = new Date();
  writeWeekCell_(state.weekRow.__rowNo, 'LAST_SAVED_AT', stamp);

  // 格子表要對齊最終的值（重設之後內容表可能又寫回了一些欄位），
  // 所以重讀一次才算差異。
  var after = readBulletinWeekRowWithRowNo_(isoDate) || {};
  var finalChanges = [];
  webAppEditableWeekFieldKeys_().forEach(function (key) {
    if (weekSnapshotText_(after[key]) !== weekSnapshotText_(state.weekRow[key])) {
      finalChanges.push({ field: key, newValue: after[key] });
    }
  });
  refreshFillSnapshotAfterSave_(isoDate, finalChanges);

  var dutyCleared = plan.dutyPlan.deactivations.length;
  var fieldOverrideCleared = plan.fieldOverridePlan.deactivations.length;
  return {
    resetFieldCount: plan.fieldChanges.length, dutyClearedCount: dutyCleared,
    fieldOverrideClearedCount: fieldOverrideCleared, safetySnapshotId: safety.snapshotId,
    importMessage: importMessage, lastSavedAt: canonicalSaveToken_(stamp),
    message: {
      type: 'success',
      text: '已重設這一週：週報欄位 ' + plan.fieldChanges.length + ' 格改回預設值，事奉框覆寫停用 '
        + dutyCleared + ' 項，手動覆寫的欄位停用 ' + fieldOverrideCleared + ' 項。'
        + (importMessage ? importMessage : '本季還沒有內容表，所以沒有重新匯入。')
        + '重設前的現況已另存成一個版本，可以在版本記錄還原。'
    }
  };
}
