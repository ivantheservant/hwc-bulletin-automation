/**
 * FillSync.gs
 *
 * 季度填寫表 `Fill_<QuarterID>` 與 `BulletinWeeks` 的**雙向同步**。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ⚠️ 三方比對，不是兩方比較
 * ─────────────────────────────────────────────────────────────────────
 *
 * **不可以用「格子表現值 vs `BulletinWeeks` 現值」判斷衝突。**
 * 兩者不同是**完全正常**的——代表其中一邊改過。用兩方比較的話：
 *
 *   - 分不出「只有格子表改過」與「只有 `BulletinWeeks` 改過」，
 *     於是不知道應該把哪一邊寫去哪一邊；
 *   - 每一個「其中一邊改過」的格都會被誤報成衝突，衝突清單變成純噪音。
 *
 * 正確做法是與**快照**（`FillSnapshot`：上一次同步時兩邊一致的值）做
 * **三方**比較：
 *
 * | 格子表 vs 快照 | 系統 vs 快照 | 結果 | 處理 |
 * |---|---|---|---|
 * | 相同 | 相同 | `SAME` | 不做任何事 |
 * | **不同** | 相同 | `PUSH` | 寫回 `BulletinWeeks` |
 * | 相同 | **不同** | `PULL` | 刷新格子表 |
 * | **不同** | **不同** | `CONFLICT` | 兩個值都列出來由使用者選，**不自動蓋任何一邊** |
 *
 * 這跟 `src/RosterDiff.gs` 用 `ROSTER_VALUE_AT_OVERRIDE`（覆寫當時記下的
 * 職事表值）而不是「職事表現值 vs 週報現值」判斷衝突，是**完全同一個
 * 道理**。見 docs/已知bug類型.md 事故十一。
 *
 * ⚠️ 一個例外：**快照缺失**（第一次同步、或者新增的欄位）時，沒有基準
 * 可以比，這時一律當成「只有一邊改過」而**不是**衝突——第一次建立格子表
 * 如果把每一格都報成衝突，功能等於不能用。見 `compareFillCell_()`。
 */

'use strict';

/**
 * 用途：組出 `FillSnapshot` 的查表鍵。
 * Args:
 *   isoDate {string} 主日日期，yyyy-MM-dd。
 *   fieldKey {string} 欄位機器鍵。
 * Returns:
 *   {string}
 */
function fillSnapshotKey_(isoDate, fieldKey) {
  return String(isoDate || '') + '|' + String(fieldKey || '');
}

/**
 * 用途：把 `FillSnapshot` 的資料列組成「主日＋欄位 → 值」的索引。純函式。
 *
 *   同一個鍵有多行時取**最後一行**——快照是「只新增、後來居上」的寫法，
 *   後寫入的那一行才是最新的基準。
 * Args:
 *   snapshotRows {Object[]} `FillSnapshot` 的資料列。
 *   quarterId {string=} 只收這一季的；省略代表全收。
 * Returns:
 *   {Object<string,string>}
 */
function buildFillSnapshotIndex_(snapshotRows, quarterId) {
  var index = {};
  (snapshotRows || []).forEach(function (row) {
    if (quarterId && row.QUARTER_ID !== quarterId) return;
    var isoDate = fillGridCellText_(row.SERVICE_DATE);
    index[fillSnapshotKey_(isoDate, row.FIELD_KEY)] = fillGridCellText_(row.VALUE);
  });
  return index;
}

/**
 * 用途：比對**一格**的三方狀態。純函式，整個同步機制的核心。
 * Args:
 *   gridValue {string} 格子表現值。
 *   systemValue {string} `BulletinWeeks` 現值。
 *   snapshotValue {?string} 快照值；`undefined`／`null` 代表**沒有快照**。
 * Returns:
 *   {string} `FILL_SYNC_STATUS` 其中一個值。
 */
function compareFillCell_(gridValue, systemValue, snapshotValue) {
  var grid = String(gridValue === null || gridValue === undefined ? '' : gridValue);
  var system = String(systemValue === null || systemValue === undefined ? '' : systemValue);

  if (grid === system) return FILL_SYNC_STATUS.SAME;

  // ⚠️ 快照缺失（第一次同步、或者程式新加了一欄）：沒有基準可以判斷
  // 是哪一邊改過，所以**不可以**當成衝突——第一次建立格子表時每一格都
  // 沒有快照，全部報成衝突的話這個功能等於不能用。
  //
  // 兩邊不同而又沒有基準時，一律**以系統為準**（`PULL`）：`BulletinWeeks`
  // 是唯一真相，格子表只是投影，投影跟真相不符就以真相為準。
  if (snapshotValue === null || snapshotValue === undefined) {
    return FILL_SYNC_STATUS.PULL;
  }

  var snapshot = String(snapshotValue);
  var gridChanged = grid !== snapshot;
  var systemChanged = system !== snapshot;

  if (gridChanged && systemChanged) return FILL_SYNC_STATUS.CONFLICT;
  if (gridChanged) return FILL_SYNC_STATUS.PUSH;
  return FILL_SYNC_STATUS.PULL;
}

/**
 * 用途：比對整張格子表與 `BulletinWeeks`，逐格算出三方狀態。純函式。
 * Args:
 *   input {{quarterId:string, gridRows:Object[], weekRowsByIso:Object,
 *          snapshotIndex:Object<string,string>}}
 *     `gridRows` 是 `readFillGridRows_()` 的輸出；`weekRowsByIso` 是
 *     `BulletinWeeks` 該季資料列（以 yyyy-MM-dd 為鍵）。
 * Returns:
 *   {{cells:{isoDate:string, rowNo:number, fieldKey:string, label:string,
 *      gridValue:string, systemValue:string, snapshotValue:(string|null),
 *      status:string}[],
 *     pushCount:number, pullCount:number, conflictCount:number, sameCount:number}}
 *     只有 `status` 不是 `SAME` 的格才會出現在 `cells` 內。
 */
function buildFillSyncPlan_(input) {
  var gridRows = input.gridRows || [];
  var weekRows = input.weekRowsByIso || {};
  var snapshotIndex = input.snapshotIndex || {};
  var defs = fillGridColumnDefs_().filter(function (d) { return !d.readOnly; });

  var cells = [];
  var counts = { pushCount: 0, pullCount: 0, conflictCount: 0, sameCount: 0 };

  gridRows.forEach(function (gridRow) {
    var week = weekRows[gridRow.isoDate] || {};

    defs.forEach(function (def) {
      var gridValue = fillGridCellText_(gridRow.values[def.key]);
      var systemValue = fillGridCellText_(week[def.key]);
      var key = fillSnapshotKey_(gridRow.isoDate, def.key);
      var hasSnapshot = Object.prototype.hasOwnProperty.call(snapshotIndex, key);
      var snapshotValue = hasSnapshot ? snapshotIndex[key] : null;

      var status = compareFillCell_(gridValue, systemValue, hasSnapshot ? snapshotValue : undefined);

      if (status === FILL_SYNC_STATUS.SAME) { counts.sameCount++; return; }
      if (status === FILL_SYNC_STATUS.PUSH) counts.pushCount++;
      else if (status === FILL_SYNC_STATUS.PULL) counts.pullCount++;
      else counts.conflictCount++;

      cells.push({
        isoDate: gridRow.isoDate,
        rowNo: gridRow.rowNo,
        fieldKey: def.key,
        label: def.label,
        gridValue: gridValue,
        systemValue: systemValue,
        snapshotValue: hasSnapshot ? snapshotValue : null,
        status: status
      });
    });
  });

  return Object.assign({ cells: cells }, counts);
}

// =====================================================================
// IO 層：快照
// =====================================================================

/**
 * 用途：讀出 `FillSnapshot` 的全部資料列。工作表不存在時回空陣列而不是
 *   拋錯——快照缺失只代表「第一次同步」，不是錯誤。
 * Args: （無）
 * Returns:
 *   {Object[]}
 */
function readFillSnapshotRows_() {
  try {
    return readSheet(SHEETS.FILL_SNAPSHOT);
  } catch (err) {
    return [];
  }
}

/**
 * 用途：把一批「主日＋欄位＋值」寫進 `FillSnapshot`，並清走同一批鍵的
 *   舊記錄。
 *
 *   ⚠️ **這是全系統少數會刪行的地方之一**，理由：快照不是歷史記錄，
 *   是「上一次同步時的基準值」，同一個鍵只可以有一個有效值。留住舊值
 *   會令 `buildFillSnapshotIndex_()` 讀到過期的基準，衝突判斷就會錯。
 *   （真正的歷史保存在 `AuditLog` 與 `FillBackup`，那兩張表永不刪行。）
 *
 *   實作上為了避免逐行刪除的效能問題，做法是：把整張表讀出來、濾走要
 *   更新的鍵、加上新值、整張重寫。一季 13 行 × 約 30 欄 ＝ 約 390 行，
 *   整張重寫完全可以接受。
 * Args:
 *   quarterId {string} 季度 ID。
 *   entries {{isoDate:string, fieldKey:string, value:string}[]} 要寫入的快照。
 * Returns:
 *   {number} 寫入的筆數。
 */
function writeFillSnapshotEntries_(quarterId, entries) {
  if (!entries || entries.length === 0) return 0;

  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.FILL_SNAPSHOT);
  if (!sheet) {
    throw new Error('writeFillSnapshotEntries_：找不到工作表「' + SHEETS.FILL_SNAPSHOT + '」，請先執行「初始化工作表」。');
  }

  var replacing = {};
  entries.forEach(function (e) { replacing[fillSnapshotKey_(e.isoDate, e.fieldKey)] = true; });

  var kept = readFillSnapshotRows_().filter(function (row) {
    var key = fillSnapshotKey_(fillGridCellText_(row.SERVICE_DATE), row.FIELD_KEY);
    return !replacing[key];
  });

  var now = new Date();
  var fresh = entries.map(function (e) {
    return {
      QUARTER_ID: quarterId,
      SERVICE_DATE: normalizeDate_(e.isoDate),
      FIELD_KEY: e.fieldKey,
      VALUE: sanitizeCellText_(e.value === null || e.value === undefined ? '' : String(e.value)),
      SNAPSHOT_AT: now
    };
  });

  var lastRow = sheet.getLastRow();
  if (lastRow > 2) {
    sheet.getRange(3, 1, lastRow - 2, COLUMNS.FILL_SNAPSHOT.keys.length).clearContent();
  }

  var all = kept.map(function (row) {
    return {
      QUARTER_ID: row.QUARTER_ID,
      SERVICE_DATE: row.SERVICE_DATE,
      FIELD_KEY: row.FIELD_KEY,
      VALUE: sanitizeCellText_(fillGridCellText_(row.VALUE)),
      SNAPSHOT_AT: row.SNAPSHOT_AT
    };
  }).concat(fresh);

  if (all.length > 0) writeSheet(SHEETS.FILL_SNAPSHOT, all);
  return fresh.length;
}

/**
 * 用途：把整張格子表目前的**可編輯欄**值寫成快照，作為下一次三方比對的
 *   基準。建立／刷新格子表、以及每一次成功同步之後都要呼叫。
 * Args:
 *   quarterId {string} 季度 ID。
 *   gridRows {{isoDate:string, values:Object}[]} 格子表內容。
 * Returns:
 *   {number} 寫入的筆數。
 */
function snapshotFillGrid_(quarterId, gridRows) {
  var defs = fillGridColumnDefs_().filter(function (d) { return !d.readOnly; });
  var entries = [];

  (gridRows || []).forEach(function (row) {
    defs.forEach(function (def) {
      entries.push({ isoDate: row.isoDate, fieldKey: def.key, value: fillGridCellText_(row.values[def.key]) });
    });
  });

  return writeFillSnapshotEntries_(quarterId, entries);
}

/**
 * 用途：更新**一格**的快照。`onFillGridEdit_()` 與 Web App 儲存後都會用。
 *
 *   ⚠️ Web App 儲存之後一定要呼叫這個（見
 *   `src/WebAppSave.gs` 的 `refreshFillSnapshotAfterSave_()`），否則下一次
 *   同步會把「Web App 改過」誤判成「兩邊都改過」而報成衝突。
 *   **這一點最容易漏，tests/fillgrid.test.js 有專門的測試。**
 * Args:
 *   isoDate {string} 主日日期。
 *   fieldKey {string} 欄位機器鍵。
 *   value {*} 新的基準值。
 *   quarterId {string=} 季度 ID；省略時由 `BulletinWeeks` 查。
 * Returns:
 *   {void}
 */
function updateFillSnapshotCell_(isoDate, fieldKey, value, quarterId) {
  var qid = quarterId || lookupQuarterIdForIsoDate_(isoDate);
  if (!qid) return;
  writeFillSnapshotEntries_(qid, [{ isoDate: isoDate, fieldKey: fieldKey, value: fillGridCellText_(value) }]);
}

/**
 * 用途：由 `BulletinWeeks` 查一個主日屬於哪一季。
 * Args:
 *   isoDate {string} 主日日期。
 * Returns:
 *   {?string} 查不到回 `null`。
 */
function lookupQuarterIdForIsoDate_(isoDate) {
  var row = findBulletinWeekRow_(readSheet(SHEETS.BULLETIN_WEEKS), isoDate);
  if (row && row.QUARTER_ID) return String(row.QUARTER_ID);
  return null;
}

// =====================================================================
// 真正入口：同步
// =====================================================================

/**
 * 用途：讀出 `BulletinWeeks` 指定季度的資料列，以 yyyy-MM-dd 為鍵。
 * Args:
 *   quarterId {string} 季度 ID。
 * Returns:
 *   {Object<string,Object>}
 */
function readBulletinWeekRowsByIso_(quarterId) {
  var out = {};
  readSheet(SHEETS.BULLETIN_WEEKS).forEach(function (row) {
    if (quarterId && String(row.QUARTER_ID || '') !== quarterId) return;
    var iso = fillGridCellText_(row.SERVICE_DATE);
    if (iso) out[iso] = row;
  });
  return out;
}

/**
 * 用途：跑一次三方比對（**唯讀**，不寫入任何一格）。
 * Args:
 *   quarterId {string} 季度 ID。
 * Returns:
 *   {Object} `buildFillSyncPlan_()` 的輸出，另加 `quarterId`。
 */
function computeFillSyncPlan_(quarterId) {
  var plan = buildFillSyncPlan_({
    quarterId: quarterId,
    gridRows: readFillGridRows_(quarterId),
    weekRowsByIso: readBulletinWeekRowsByIso_(quarterId),
    snapshotIndex: buildFillSnapshotIndex_(readFillSnapshotRows_(), quarterId)
  });
  plan.quarterId = quarterId;
  return plan;
}

/**
 * 用途：執行一次同步——`PUSH` 寫回 `BulletinWeeks`、`PULL` 刷新格子表、
 *   `CONFLICT` **完全不動**，逐格記 `AuditLog`，最後更新快照。
 *
 *   ⚠️ **衝突的格一格都不會被寫入**（兩邊的值都保留），要由選單
 *   「處理填寫表衝突」逐項選過才會寫。
 *
 *   ⚠️ 快照只會更新**已經處理好**的格（`PUSH`／`PULL`／`SAME`）。
 *   衝突格的快照維持原樣，否則下一次比對就會因為基準被推走而變成
 *   「只有一邊改過」，衝突無聲消失。
 * Args:
 *   quarterId {string} 季度 ID。
 * Returns:
 *   {{quarterId:string, pushCount:number, pullCount:number,
 *     conflictCount:number, sameCount:number, cells:Object[]}}
 * Raises:
 *   Error 如果格子表或 `BulletinWeeks` 讀取失敗。
 */
function syncFillGrid_(quarterId) {
  var plan = computeFillSyncPlan_(quarterId);
  var gridSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(fillGridSheetName_(quarterId));
  var settledEntries = [];

  plan.cells.forEach(function (cell) {
    if (cell.status === FILL_SYNC_STATUS.CONFLICT) return;

    if (cell.status === FILL_SYNC_STATUS.PUSH) {
      // ⚠️ 第二層防線。第一層是 fillGridColumnDefs_() 把內容表接管的欄位
      //    標成 readOnly，buildFillSyncPlan_() 根本不會排它入計畫。這裡
      //    再擋一次，是因為「唯讀」這條規則的代價是**靜靜寫錯資料**，
      //    而第一層是一個容易在改欄位定義時被漏掉的旗標。
      if (CONTENT_SHEET_READONLY_FIELDS.WEEK.indexOf(cell.fieldKey) !== -1) {
        throw new Error('syncFillGrid_：「' + cell.fieldKey
          + '」由內容表接管，季度填寫表不可以寫回 BulletinWeeks。'
          + '這代表 fillGridColumnDefs_() 的 readOnly 旗標漏了——請修好定義，不要繞過這道檢查。');
      }
      writeBulletinWeekField_(cell.isoDate, cell.fieldKey, cell.gridValue);
      appendAuditLog_({
        action: 'FILL_SYNC_PUSH', sheetName: SHEETS.BULLETIN_WEEKS,
        rowKey: cell.isoDate, field: cell.fieldKey,
        oldValue: cell.systemValue, newValue: cell.gridValue,
        notes: '由季度填寫表 ' + fillGridSheetName_(quarterId) + ' 同步回來。'
      });
      settledEntries.push({ isoDate: cell.isoDate, fieldKey: cell.fieldKey, value: cell.gridValue });
      return;
    }

    // PULL：刷新格子表
    if (gridSheet) {
      var col = fillGridColumnIndex_(cell.fieldKey);
      if (col > 0) gridSheet.getRange(cell.rowNo, col).setValue(sanitizeCellText_(cell.systemValue));
    }
    appendAuditLog_({
      action: 'FILL_SYNC_PULL', sheetName: fillGridSheetName_(quarterId),
      rowKey: cell.isoDate, field: cell.fieldKey,
      oldValue: cell.gridValue, newValue: cell.systemValue,
      notes: 'BulletinWeeks 改過（例如經填寫介面），刷新季度填寫表。'
    });
    settledEntries.push({ isoDate: cell.isoDate, fieldKey: cell.fieldKey, value: cell.systemValue });
  });

  if (settledEntries.length > 0) writeFillSnapshotEntries_(quarterId, settledEntries);

  return plan;
}

/**
 * 用途：把一個值寫進 `BulletinWeeks` 指定主日、指定欄位的那一格。
 * Args:
 *   isoDate {string} 主日日期。
 *   fieldKey {string} 機器鍵。
 *   value {*} 新值。
 * Returns:
 *   {boolean} 找不到那一行回 `false`。
 * Raises:
 *   Error 如果 `fieldKey` 不是 `BulletinWeeks` 的機器鍵——寧可拋錯也不要
 *     靜靜寫進錯的欄。
 */
function writeBulletinWeekField_(isoDate, fieldKey, value) {
  var colIndex = COLUMNS.BULLETIN_WEEKS.keys.indexOf(fieldKey) + 1;
  if (colIndex <= 0) {
    throw new Error('writeBulletinWeekField_：「' + fieldKey + '」不是 BulletinWeeks 的機器鍵。');
  }

  var row = readBulletinWeekRowWithRowNo_(isoDate);
  if (!row) return false;

  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.BULLETIN_WEEKS);
  if (!sheet) return false;

  // ⚠️ 經 setCellValueTextSafe_()：ATT_* 十二欄設計上是文字（'12 人'、'—'），
  //    直接 setValue() 會被試算表轉成數字。見 docs/已知bug類型.md 事故二十八。
  setCellValueTextSafe_(sheet, COLUMNS.BULLETIN_WEEKS, row.__rowNo, fieldKey,
    sanitizeCellText_(value === null || value === undefined ? '' : value));
  return true;
}

/**
 * 用途：把同步結果排版成 `Diagnostics` 報告的內容行。
 *
 *   ⚠️ 區段標題一律用全形括號「【…】」，不可以用 `===` 開頭——見
 *   docs/已知bug類型.md 事故六。
 * Args:
 *   plan {Object} `syncFillGrid_()`／`computeFillSyncPlan_()` 的輸出。
 * Returns:
 *   {string[]}
 */
function buildFillSyncReportLines_(plan) {
  var lines = [];
  lines.push('【摘要】');
  lines.push('季度：' + plan.quarterId);
  lines.push('寫回 BulletinWeeks：' + plan.pushCount + ' 格　刷新格子表：' + plan.pullCount
    + ' 格　衝突：' + plan.conflictCount + ' 格　兩邊一致：' + plan.sameCount + ' 格');

  var byStatus = {};
  [FILL_SYNC_STATUS.CONFLICT, FILL_SYNC_STATUS.PUSH, FILL_SYNC_STATUS.PULL].forEach(function (s) {
    byStatus[s] = plan.cells.filter(function (c) { return c.status === s; });
  });

  var labels = {};
  labels[FILL_SYNC_STATUS.CONFLICT] = '衝突（兩邊都改過，一格都沒有被寫入）';
  labels[FILL_SYNC_STATUS.PUSH] = '寫回 BulletinWeeks（只有格子表改過）';
  labels[FILL_SYNC_STATUS.PULL] = '刷新格子表（只有系統改過）';

  Object.keys(byStatus).forEach(function (status) {
    var cells = byStatus[status];
    lines.push('');
    lines.push('【' + labels[status] + '（' + cells.length + ' 格）】');
    if (cells.length === 0) { lines.push('　（無）'); return; }
    cells.forEach(function (c) {
      if (status === FILL_SYNC_STATUS.CONFLICT) {
        lines.push('　' + c.isoDate + '　' + c.label
          + '　上次同步時＝' + (c.snapshotValue || '（空白）')
          + '　格子表＝' + (c.gridValue || '（空白）')
          + '　系統＝' + (c.systemValue || '（空白）'));
      } else {
        lines.push('　' + c.isoDate + '　' + c.label
          + '　' + (c.status === FILL_SYNC_STATUS.PUSH ? c.systemValue : c.gridValue) + ' → '
          + (c.status === FILL_SYNC_STATUS.PUSH ? c.gridValue : c.systemValue));
      }
    });
  });

  if (plan.conflictCount > 0) {
    lines.push('');
    lines.push('⚠️ 衝突的格子一格都沒有被改動，兩邊的值都保留。');
    lines.push('請用選單「處理填寫表衝突」逐項選擇要用哪一邊的值。');
  }

  return lines;
}

// =====================================================================
// 即時寫回：installable onEdit
// =====================================================================

/**
 * 用途：季度填寫表的 installable `onEdit` 觸發器處理函式。
 *
 *   ⚠️ **onEdit 拋錯是靜默的**——Apps Script 不會彈任何東西給使用者看，
 *   出事只會表現成「改了沒反應」。所以整個函式包一層 try/catch 並寫
 *   `ErrorLog`（`SOURCE='TRIGGER'`），沒有這一層就永遠不會知道出事。
 *
 *   ⚠️ **不可以在 onEdit 內做大量讀寫**——只處理被改的那幾格，其餘交給
 *   定時對帳。所以這裡刻意不跑完整的三方比對。
 * Args:
 *   e {Object} Apps Script 的編輯事件物件。
 * Returns:
 *   {void}
 */
function onFillGridEdit_(e) {
  try {
    if (!e || !e.range) return;

    var sheet = e.range.getSheet();
    var quarterId = quarterIdFromFillGridSheetName_(sheet.getName());
    // 1. 只處理季度填寫表的編輯，其餘直接 return。
    if (!quarterId) return;

    applyFillGridEdit_(sheet, e.range, quarterId);
  } catch (err) {
    try {
      appendErrorLog_({
        source: ERROR_LOG_SOURCE.TRIGGER,
        functionName: 'onFillGridEdit_',
        errorCode: (err && err.code) || 'ERROR',
        message: (err && err.message) ? err.message : String(err),
        detail: buildErrorDetail_(err)
      });
    } catch (logErr) {
      // 連寫 ErrorLog 都失敗就真的沒有辦法了——但至少不要讓例外再往上拋，
      // 免得 Apps Script 把整個觸發器停用。
    }
  }
}

/**
 * 用途：算出格子表某一行「真正」的主日日期。當這次編輯的範圍覆蓋到
 *   `_DATE` 欄本身時，不可以相信目前讀到的儲存格內容——那有可能是使用者
 *   剛打錯的值——改用這一行在格子表的**位置**對照職事表這一季的主日
 *   清單反推。
 *
 *   ⚠️ 這是 prompt8b 第 3 部分修的根因：舊寫法一律讀 `_DATE` 儲存格的
 *   現值，如果使用者剛剛編輯的就是那一格，讀到的是**打錯的值**，不但
 *   `AuditLog` 的 `ROW_KEY` 記錯，連「還原」本身都會把錯的值原封不動
 *   寫回去（因為「正確值」也是從同一個被污染的讀值算出來的）。
 * Args:
 *   sheet {Sheet} 格子表。
 *   rowNo {number} 行號。
 *   quarterId {string} 季度 ID。
 *   dateColTouched {boolean} 這次編輯的範圍有沒有覆蓋 `_DATE` 欄。
 *   getQuarterServiceDates {function(): Object[]} 惰性讀取職事表這一季
 *     主日清單的函式（只有真的需要時才呼叫，避免每次編輯都讀一整季）。
 * Returns:
 *   {string} 那一行的真正主日日期；完全推不出來時回空字串。
 */
function resolveFillGridRowTrueDate_(sheet, rowNo, quarterId, dateColTouched, getQuarterServiceDates) {
  var cellText = fillGridCellText_(sheet.getRange(rowNo, fillGridColumnIndex_('_DATE')).getValue()).trim();
  if (!dateColTouched) return cellText;

  var serviceDates = getQuarterServiceDates();
  var dataRowIndex = rowNo - FILL_GRID_FIRST_DATA_ROW_;
  var trueEntry = serviceDates[dataRowIndex];
  return trueEntry ? trueEntry.isoDate : cellText;
}

/**
 * 用途：處理格子表的一次編輯（可能是一格，也可能是多格貼上）。
 *
 *   逐格處理：
 *     - 唯讀欄（`_DATE`／`_WEEK`／`_SPECIAL`）→ **還原原值**並顯示浮動
 *       提示說明不可編輯。
 *     - 可編輯欄 → 寫回 `BulletinWeeks`、更新快照、記 `AuditLog`。
 * Args:
 *   sheet {Sheet} 格子表。
 *   range {Range} 被編輯的範圍。
 *   quarterId {string} 季度 ID。
 * Returns:
 *   {{applied:number, reverted:number}}
 */
function applyFillGridEdit_(sheet, range, quarterId) {
  var startRow = range.getRow();
  var startCol = range.getColumn();
  var numRows = range.getNumRows();
  var numCols = range.getNumColumns();

  var applied = 0;
  var reverted = 0;
  var snapshotEntries = [];

  // 只有這次編輯真的覆蓋到 `_DATE` 欄時，才需要用職事表主日清單反推真正
  // 日期——惰性讀取（`quarterServiceDatesCache` 只在第一次用到時才讀），
  // 避免每一次普通編輯都額外讀一整季的職事表。
  var dateColIndex = fillGridColumnIndex_('_DATE');
  var dateColTouched = dateColIndex >= startCol && dateColIndex < startCol + numCols;
  var quarterServiceDatesCache = null;
  var getQuarterServiceDates = function () {
    if (!quarterServiceDatesCache) quarterServiceDatesCache = listQuarterServiceDates_(quarterId);
    return quarterServiceDatesCache;
  };

  for (var r = 0; r < numRows; r++) {
    var rowNo = startRow + r;
    // 標題三行被改不關同步的事（`ensureFillGridSheet_()` 會在下次刷新時
    // 補回正確的標題）。
    if (rowNo < FILL_GRID_FIRST_DATA_ROW_) continue;

    var isoDate = resolveFillGridRowTrueDate_(sheet, rowNo, quarterId, dateColTouched, getQuarterServiceDates);
    if (!isoDate) continue;

    for (var c = 0; c < numCols; c++) {
      var colNo = startCol + c;
      var def = fillGridColumnDefAt_(colNo);
      if (!def) continue;

      var cell = sheet.getRange(rowNo, colNo);

      if (def.readOnly) {
        revertReadOnlyFillGridCell_(cell, def, isoDate, quarterId);
        reverted++;
        continue;
      }

      var newValue = fillGridCellText_(cell.getValue());
      var oldValue = fillGridCellText_((readBulletinWeekRowWithRowNo_(isoDate) || {})[def.key]);
      if (newValue === oldValue) continue;

      writeBulletinWeekField_(isoDate, def.key, newValue);
      appendAuditLog_({
        action: 'FILL_GRID_EDIT', sheetName: SHEETS.BULLETIN_WEEKS,
        rowKey: isoDate, field: def.key,
        oldValue: oldValue, newValue: newValue,
        notes: '在季度填寫表 ' + fillGridSheetName_(quarterId) + ' 直接編輯。'
      });
      snapshotEntries.push({ isoDate: isoDate, fieldKey: def.key, value: newValue });
      applied++;
    }
  }

  // 快照一次過寫（`writeFillSnapshotEntries_()` 會整張重寫，逐格叫會很慢）。
  if (snapshotEntries.length > 0) writeFillSnapshotEntries_(quarterId, snapshotEntries);

  return { applied: applied, reverted: reverted };
}

/**
 * 用途：把被改動的唯讀欄還原成正確的值，並用浮動提示說明不可編輯。
 *
 *   ⚠️ 為什麼要還原而不是靜靜接受：這三欄的內容來自職事表，改了**完全
 *   沒有效果**（下次刷新就會被蓋回去）。留住一個永遠不會生效的值，會讓
 *   幹事以為自己改到了東西。還原＋提示才講得清楚。
 *
 *   ⚠️ 改用 `toast()`（5 秒自動消失）而不是永久儲存格註解：舊寫法
 *   `setNote()` 就算之後把值改回正確，註解仍然永久留在格上，累積成一堆
 *   垃圾（見 prompt8b 實測現象）。`isoDate` 由呼叫方
 *   （`applyFillGridEdit_()`）保證是那一行**真正**的主日日期，不會是被
 *   污染的使用者輸入值。
 * Args:
 *   cell {Range} 被改動的那一格。
 *   def {Object} 欄位定義。
 *   isoDate {string} 那一行的主日日期。
 *   quarterId {string} 季度 ID。
 * Returns:
 *   {void}
 */
function revertReadOnlyFillGridCell_(cell, def, isoDate, quarterId) {
  var correct = '';
  if (def.key === '_DATE') {
    correct = isoDate;
  } else {
    var snapshot = readRosterSnapshot_(isoDate);
    if (def.key === '_WEEK') correct = fillGridCellText_(snapshot.weekOfMonth);
    else correct = fillGridCellText_(snapshot.special && snapshot.special.title);
  }

  cell.setValue(sanitizeCellText_(correct));
  SpreadsheetApp.getActiveSpreadsheet().toast(
    '「' + def.label + '」是唯讀欄，已還原原值。這三欄由職事表決定，要改請在職事表更正。',
    '唯讀欄位',
    5
  );

  appendAuditLog_({
    action: 'FILL_GRID_REVERT_READONLY', sheetName: fillGridSheetName_(quarterId),
    rowKey: isoDate, field: def.key,
    oldValue: '', newValue: correct,
    notes: '唯讀欄被編輯，已自動還原並顯示浮動提示。'
  });
}
