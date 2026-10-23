/**
 * FillMenu.gs
 *
 * 季度填寫表相關的**選單處理函式**與觸發器安裝，以及「處理填寫表衝突」
 * 的 `HtmlService` 對話框。
 *
 * 內容表 v2：季度填寫表已停用。選單子項目改名「季度工具」，只留與填寫表無關的維護項目；
 * 已停用項目的處理函式保留名字、只顯示已停用（`showFillGridRetiredMenuAlert_()`），
 * `apiResolveFillConflicts` 一律回 `FILL_GRID_RETIRED`。
 *
 * ⚠️ 每個 `menuXxx_()` 的 catch 分支都要呼叫 `logMenuError_()`
 * （`src/ErrorLog.gs`）寫一筆 `ErrorLog`（`SOURCE='MENU'`），再顯示
 * `ui.alert()`——不能只顯示對話框、不留記錄，見 docs/已知bug類型.md 事故七。
 */

'use strict';

/**
 * 用途：問使用者一個季度 ID，共用的小工具。
 *
 *   內容表 v2：季度填寫表停用之後，提示改列週報試算表（`BulletinWeeks`）內有的季度，不再列
 *   `Fill_*` 分頁——留下來的「季度工具」（整理次序、團契、備份、還原）處理的都是週報資料。
 * Args:
 *   ui {Ui} `SpreadsheetApp.getUi()`。
 *   title {string} 對話框標題。
 * Returns:
 *   {?string} 使用者取消時回 `null`。
 * Raises:
 *   Error 讀 `BulletinWeeks` 失敗時原樣拋出（由選單處理函式接住並寫 `ErrorLog`）。
 */
function promptForQuarterId_(ui, title) {
  var existing = listBulletinWeekQuarterIds_();
  var hint = existing.length > 0 ? '\n\n週報試算表內的季度：' + existing.join('、') : '';
  var resp = ui.prompt(title, '請輸入季度 ID（例如 2027T4）：' + hint, ui.ButtonSet.OK_CANCEL);
  if (resp.getSelectedButton() !== ui.Button.OK) return null;
  var quarterId = resp.getResponseText().trim();
  return quarterId || null;
}

/**
 * 用途：列出 `BulletinWeeks` 內出現過的季度 ID（不重複、按名稱排序）。
 * Args: （無）
 * Returns:
 *   {string[]}
 * Raises:
 *   Error 讀 `BulletinWeeks` 失敗時原樣拋出。
 */
function listBulletinWeekQuarterIds_() {
  var seen = {};
  readSheet(SHEETS.BULLETIN_WEEKS).forEach(function (row) {
    var qid = String(row.QUARTER_ID || '').trim();
    if (qid) seen[qid] = true;
  });
  return Object.keys(seen).sort();
}

/**
 * 用途：內容表 v2：已停用的季度填寫表選單項目共用的處理——只顯示一句已停用，一格都不寫。
 *
 *   ⚠️ 為甚麼保留這些處理函式的名字，而不是刪走：部署之前已經開着的試算表，選單是開啟那一刻
 *   建好的，舊項目仍然在畫面上；按下去會按名字叫這裏。刪走的話會出「找不到指令碼函式」，
 *   保留舊內容的話等於後門（bug class 47）。所以名字保留、內容換成這一句。
 * Args:
 *   title {string} 原本那個選單項目的名稱（對話框標題用）。
 * Returns:
 *   {void}
 * Raises:
 *   （無）`getUi()` 失敗時寫 `ErrorLog`。
 */
function showFillGridRetiredMenuAlert_(title) {
  try {
    var ui = SpreadsheetApp.getUi();
    ui.alert(title, fillGridRetiredMessage_(), ui.ButtonSet.OK);
  } catch (err) {
    logMenuError_('showFillGridRetiredMenuAlert_', err);
  }
}

/**
 * 用途：內容表 v2：季度填寫表已停用。原本是選單項目「建立／刷新季度填寫表」的處理函式，現在只顯示已停用，
 *   一格都不寫（理由見 `showFillGridRetiredMenuAlert_()`）。
 * Args: （無）
 * Returns:
 *   {void}
 * Raises:
 *   （無）
 */
function menuCreateOrRefreshFillGrid_() {
  showFillGridRetiredMenuAlert_('建立／刷新季度填寫表');
}

/**
 * 用途：內容表 v2：季度填寫表已停用。原本是選單項目「立即同步季度填寫表」的處理函式，現在只顯示已停用，
 *   一格都不寫（理由見 `showFillGridRetiredMenuAlert_()`）。
 * Args: （無）
 * Returns:
 *   {void}
 * Raises:
 *   （無）
 */
function menuSyncFillGrid_() {
  showFillGridRetiredMenuAlert_('立即同步季度填寫表');
}

// =====================================================================
// 處理填寫表衝突（HtmlService 對話框）
// =====================================================================

/**
 * 用途：內容表 v2：季度填寫表已停用。原本是選單項目「處理填寫表衝突」的處理函式，現在只顯示已停用，
 *   一格都不寫（理由見 `showFillGridRetiredMenuAlert_()`）。
 * Args: （無）
 * Returns:
 *   {void}
 * Raises:
 *   （無）
 */
function menuResolveFillConflicts_() {
  showFillGridRetiredMenuAlert_('處理填寫表衝突');
}

/**
 * 用途：內容表 v2：季度填寫表已停用。原本是選單項目「檢查格子表外觀」的處理函式，現在只顯示已停用，
 *   一格都不寫（理由見 `showFillGridRetiredMenuAlert_()`）。
 * Args: （無）
 * Returns:
 *   {void}
 * Raises:
 *   （無）
 */
function menuCheckFillGridAppearance_() {
  showFillGridRetiredMenuAlert_('檢查格子表外觀');
}

/**
 * 用途：「處理填寫表衝突」對話框（`src/ui/FillConflict.html`）呼叫的伺服器端函式。
 *   內容表 v2 起季度填寫表已停用：一律回已停用，一格都不寫。`resolveFillConflicts_()`
 *   本身保留到日後清理死碼時才刪（計劃 Commit 10），但已經沒有任何入口。
 * Args:
 *   quarterId {string} 季度 ID（只用於 ErrorLog 的參數摘要）。
 *   decisions {Object[]} 對話框送來的選擇（不再理會）。
 * Returns:
 *   {{ok:boolean, error:{code:string, message:string}}} `ok` 一律是 `false`，
 *     `error.code` 是 `'FILL_GRID_RETIRED'`。
 * Raises:
 *   （無）錯誤由 `withApiResult_()` 轉成回傳值。
 */
function apiResolveFillConflicts(quarterId, decisions) {
  // 內容表 v2：季度填寫表已停用。這是不帶底線的公開函式，瀏覽器主控台叫得到（bug class 33、47），
  // 拿走選單項目不等於拿走入口，所以後端一律回已停用，一格都不寫。
  return withApiResult_(function () {
    var err = new Error(fillGridRetiredMessage_());
    err.code = 'FILL_GRID_RETIRED';
    throw err;
  }, { functionName: 'apiResolveFillConflicts', argsSummary: 'quarterId=' + quarterId });
}

/**
 * 用途：組出「處理填寫表衝突」對話框成功之後要顯示的結果文案。
 *
 *   ⚠️ 刻意放在 `.gs`（而不是讓 `ui/FillConflict.html` 自己砌字串）：
 *   前端沒有 Node 測試，文案分支放在這裡才測得到；也避免前端用
 *   `appliedGrid`／`appliedSystem` 是不是都是 `0` 來猜「是不是使用者
 *   全部選了暫不處理」——那個猜法在 `skipped` 也是 `0`（例如全部
 *   `unmatched`）的情況下一樣會誤判，見 docs/已知bug類型.md 事故十五。
 *   只有 `skipped > 0` 才可以說「使用者真的選了暫不處理」。
 * Args:
 *   result {{appliedGrid:number, appliedSystem:number, skipped:number}}
 *     `resolveFillConflicts_()` 算出來的套用結果。
 * Returns:
 *   {string} 給對話框顯示的一句話。
 */
function buildFillConflictResultMessage_(result) {
  if (result.skipped > 0 && result.appliedGrid === 0 && result.appliedSystem === 0) {
    return '你全部選了「暫不處理」，所以一格都沒有改動。';
  }
  return '已套用：填寫表 ' + result.appliedGrid + ' 格、系統 ' + result.appliedSystem
    + ' 格；暫不處理 ' + result.skipped + ' 格（下次同步仍然會問）。';
}

/**
 * 用途：`apiResolveFillConflicts()` 的實作層。
 *
 *   ⚠️ 無論結果如何（就算全部 `SKIP`、就算 `decisions` 是空陣列），一律
 *   寫一筆 `FILL_CONFLICT_RESOLVE_RUN` 總結記錄——這是 prompt8b 修的事故：
 *   舊寫法只在真的套用了 `GRID`／`SYSTEM` 時才寫 `AuditLog`，導致「使用者
 *   撳確定但送出的選擇仍然是 SKIP」這種情況完全沒有記錄，外表跟系統壞掉
 *   一模一樣。`unmatched`（送來的 decision 對不上任何目前的衝突格）是
 *   這筆總結記錄裡最重要的欄位：日後再遇到「撳了但沒反應」，看這個數字
 *   就知道是前後端鍵值對不上，而不是使用者選錯。
 *
 *   ⚠️ 但如果**送來的選擇全部都對不上**（`decisionsReceived > 0` 而
 *   `matchedConflicts === 0`），這已經不是「使用者選了暫不處理」——那是
 *   一次徹底的鍵值不符（例如季度 ID 傳壞了），繼續往下走只會安靜地
 *   什麼都不做。這種情況直接拋錯（`code: 'NO_MATCHING_CONFLICT'`），
 *   不寫任何東西（連總結記錄都不寫），讓 `withApiResult_()` 把它變成
 *   使用者看得到的明確錯誤訊息，而不是又一次「撳了沒反應」。
 * Args:
 *   quarterId {string} 季度 ID（呼叫方要先用 `normalizeQuarterId_()`
 *     處理過，這裡不再重複剝引號／驗證格式）。
 *   decisions {Object[]} 見 `apiResolveFillConflicts()`。
 * Returns:
 *   {{appliedGrid:number, appliedSystem:number, skipped:number,
 *     decisionsReceived:number, matchedConflicts:number, unmatched:number,
 *     message:string}}
 * Raises:
 *   Error（`code: 'NO_MATCHING_CONFLICT'`）如果送來至少一個選擇，卻一個
 *     都對不上目前的衝突清單。
 */
function resolveFillConflicts_(quarterId, decisions) {
  var plan = computeFillSyncPlan_(quarterId);
  var byKey = {};
  plan.cells.forEach(function (c) {
    if (c.status === FILL_SYNC_STATUS.CONFLICT) byKey[fillSnapshotKey_(c.isoDate, c.fieldKey)] = c;
  });

  var gridSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(fillGridSheetName_(quarterId));
  var snapshotEntries = [];
  var appliedGrid = 0;
  var appliedSystem = 0;
  var skipped = 0;
  var unmatched = 0;
  var decisionList = decisions || [];

  // 第二批階段 2：選用「填寫表的值」會寫回 `BulletinWeeks`，那些主日寫之前各存一個版本
  // （同一主日有時間限制）。選用系統的值只是刷新格子表，不動 `BulletinWeeks`。
  snapshotWeeksBeforeWrite_(
    decisionList.filter(function (d) {
      return d.choice === 'GRID' && byKey[fillSnapshotKey_(d.isoDate, d.fieldKey)];
    }).map(function (d) { return d.isoDate; }),
    'GRID_CONFLICT', { throttle: true }
  );

  decisionList.forEach(function (decision) {
    var cell = byKey[fillSnapshotKey_(decision.isoDate, decision.fieldKey)];
    if (!cell) {
      unmatched++;
      return;
    }

    if (decision.choice === 'GRID') {
      writeBulletinWeekField_(cell.isoDate, cell.fieldKey, cell.gridValue);
      appendAuditLog_({
        action: 'FILL_CONFLICT_RESOLVE', sheetName: SHEETS.BULLETIN_WEEKS,
        rowKey: cell.isoDate, field: cell.fieldKey,
        oldValue: cell.systemValue, newValue: cell.gridValue,
        notes: '人手處理填寫表衝突：選用填寫表的值。'
      });
      snapshotEntries.push({ isoDate: cell.isoDate, fieldKey: cell.fieldKey, value: cell.gridValue });
      appliedGrid++;
      return;
    }

    if (decision.choice === 'SYSTEM') {
      if (gridSheet) {
        var col = fillGridColumnIndex_(cell.fieldKey);
        if (col > 0) gridSheet.getRange(cell.rowNo, col).setValue(sanitizeCellText_(cell.systemValue));
      }
      appendAuditLog_({
        action: 'FILL_CONFLICT_RESOLVE', sheetName: fillGridSheetName_(quarterId),
        rowKey: cell.isoDate, field: cell.fieldKey,
        oldValue: cell.gridValue, newValue: cell.systemValue,
        notes: '人手處理填寫表衝突：選用系統的值。'
      });
      snapshotEntries.push({ isoDate: cell.isoDate, fieldKey: cell.fieldKey, value: cell.systemValue });
      appliedSystem++;
      return;
    }

    // SKIP：完全不動，快照也不更新，下次仍然會報成衝突。
    skipped++;
  });

  var matchedConflicts = appliedGrid + appliedSystem + skipped;

  if (decisionList.length > 0 && matchedConflicts === 0) {
    var noMatchErr = new Error(
      '送來 ' + decisionList.length + ' 個選擇，但在季度 ' + quarterId
      + ' 找不到對應的衝突，請重新開啟對話框再試。'
    );
    noMatchErr.code = 'NO_MATCHING_CONFLICT';
    throw noMatchErr;
  }

  if (snapshotEntries.length > 0) writeFillSnapshotEntries_(quarterId, snapshotEntries);

  appendAuditLog_({
    action: 'FILL_CONFLICT_RESOLVE_RUN',
    sheetName: fillGridSheetName_(quarterId),
    rowKey: quarterId,
    notes: JSON.stringify({
      decisionsReceived: decisionList.length,
      matchedConflicts: matchedConflicts,
      appliedGrid: appliedGrid,
      appliedSystem: appliedSystem,
      skipped: skipped,
      unmatched: unmatched
    })
  });

  return {
    appliedGrid: appliedGrid,
    appliedSystem: appliedSystem,
    skipped: skipped,
    decisionsReceived: decisionList.length,
    matchedConflicts: matchedConflicts,
    unmatched: unmatched,
    message: buildFillConflictResultMessage_({ appliedGrid: appliedGrid, appliedSystem: appliedSystem, skipped: skipped })
  };
}

// =====================================================================
// 備份與還原
// =====================================================================

/**
 * 用途：選單項目「立即備份本季」的處理函式。
 * Args: （無）
 * Returns:
 *   {void}
 */
function menuBackupQuarter_() {
  var ui = SpreadsheetApp.getUi();
  try {
    var quarterId = promptForQuarterId_(ui, '立即備份本季');
    if (!quarterId) return;

    var result = createFillBackup_(quarterId, FILL_BACKUP_REASON.MANUAL);
    ui.alert(
      '已備份',
      [
        '備份編號：' + result.backupId,
        '資料行數：' + result.rowCount,
        '分段數：' + result.partCount,
        result.prunedCount > 0 ? '（順帶刪走了 ' + result.prunedCount + ' 個最舊的備份）' : ''
      ].filter(function (l) { return l; }).join('\n'),
      ui.ButtonSet.OK
    );
  } catch (err) {
    logMenuError_('menuBackupQuarter_', err);
    ui.alert('備份失敗', enrichAuthError_(err), ui.ButtonSet.OK);
  }
}

/**
 * 用途：選單項目「還原到某個備份」的處理函式。
 *
 *   三步：列出備份供選擇 → **先顯示差異摘要** → 確認後才寫入
 *   （而且寫入之前會再備份一次）。
 * Args: （無）
 * Returns:
 *   {void}
 */
function menuRestoreQuarter_() {
  var ui = SpreadsheetApp.getUi();
  try {
    var quarterId = promptForQuarterId_(ui, '還原到某個備份');
    if (!quarterId) return;

    var backups = listFillBackups_(quarterId);
    if (backups.length === 0) {
      ui.alert('還原到某個備份', '季度 ' + quarterId + ' 還沒有任何備份。', ui.ButtonSet.OK);
      return;
    }

    var listLines = backups.map(function (b, i) {
      return (i + 1) + '. ' + b.backupId + '　' + b.reason + '　' + b.rowCount + ' 行';
    });
    var pickResp = ui.prompt(
      '還原到某個備份',
      '季度 ' + quarterId + ' 目前有 ' + backups.length + ' 個備份：\n\n'
      + listLines.join('\n') + '\n\n請輸入要還原的編號（1–' + backups.length + '）：',
      ui.ButtonSet.OK_CANCEL
    );
    if (pickResp.getSelectedButton() !== ui.Button.OK) return;

    var index = Number(pickResp.getResponseText().trim());
    if (!Number.isFinite(index) || index < 1 || index > backups.length) {
      ui.alert('還原到某個備份', '輸入的編號不在 1–' + backups.length + ' 之內，已取消。', ui.ButtonSet.OK);
      return;
    }
    var chosen = backups[index - 1];

    // ⚠️ 一定要先顯示差異摘要，確認之後才寫。
    var preview = previewFillRestore_(quarterId, chosen.backupId);
    if (!preview.ok) {
      ui.alert('還原到某個備份', preview.message, ui.ButtonSet.OK);
      return;
    }
    if (preview.changes.length === 0) {
      ui.alert('還原到某個備份', '這個備份與目前的資料完全相同，沒有任何需要還原的格子。', ui.ButtonSet.OK);
      return;
    }

    var confirm = ui.alert(
      '確認還原',
      [
        '備份：' + chosen.backupId + '（' + chosen.reason + '）',
        '',
        '會改動 ' + preview.changes.length + ' 格，影響 ' + preview.affectedDates.length + ' 個主日：',
        '　' + preview.affectedDates.join('、'),
        '',
        '涉及的欄位：',
        preview.fieldSummary.map(function (f) { return '　' + f.label + '（' + f.count + ' 格）'; }).join('\n'),
        '',
        '還原之前會自動再做一次備份，所以還原錯了也可以再還原回來。',
        '',
        '確定要還原嗎？'
      ].join('\n'),
      ui.ButtonSet.YES_NO
    );
    if (confirm !== ui.Button.YES) return;

    var result = restoreFillBackup_(quarterId, chosen.backupId);
    ui.alert(
      '已還原',
      '已還原 ' + result.restoredCount + ' 格。\n'
      + '還原前的現況已經備份成「' + result.safetyBackupId + '」，需要的話可以再還原回去。',
      ui.ButtonSet.OK
    );
  } catch (err) {
    logMenuError_('menuRestoreQuarter_', err);
    ui.alert('還原失敗', enrichAuthError_(err), ui.ButtonSet.OK);
  }
}

// =====================================================================
// 清單整理與常設團契
// =====================================================================

/**
 * 用途：選單項目「整理清單次序」的處理函式。
 * Args: （無）
 * Returns:
 *   {void}
 */
function menuResequenceLists_() {
  var ui = SpreadsheetApp.getUi();
  try {
    var quarterId = promptForQuarterId_(ui, '整理清單次序');
    if (!quarterId) return;

    var result = resequenceQuarterLists_(quarterId);
    var lines = Object.keys(result.changedBySheet).map(function (name) {
      return '　' + name + '：' + result.changedBySheet[name] + ' 行';
    });

    ui.alert(
      '整理清單次序',
      [
        '季度：' + quarterId,
        '重新編號的行數：' + result.totalChanged,
        ''
      ].concat(lines).concat([
        '',
        '（不刪行，只改次序編號。）',
        '還原點：' + result.backupId
      ]).join('\n'),
      ui.ButtonSet.OK
    );
  } catch (err) {
    logMenuError_('menuResequenceLists_', err);
    ui.alert('整理清單次序失敗', enrichAuthError_(err), ui.ButtonSet.OK);
  }
}

/**
 * 用途：選單項目「由常設時間表產生本季團契」的處理函式。
 * Args: （無）
 * Returns:
 *   {void}
 */
function menuGenerateFellowships_() {
  var ui = SpreadsheetApp.getUi();
  try {
    var quarterId = promptForQuarterId_(ui, '由常設時間表產生本季團契');
    if (!quarterId) return;

    var result = generateQuarterFellowships_(quarterId);
    var lines = [
      '季度：' + quarterId,
      '新增：' + result.added + ' 行',
      '略過（已存在）：' + result.skipped + ' 行',
      '還原點：' + result.backupId
    ];
    if (result.warnings.length > 0) {
      lines.push('');
      lines.push('⚠️ 警告：');
      result.warnings.forEach(function (w) { lines.push('　' + w.message); });
    }

    ui.alert('由常設時間表產生本季團契', lines.join('\n'), ui.ButtonSet.OK);
  } catch (err) {
    logMenuError_('menuGenerateFellowships_', err);
    ui.alert('產生團契聚會失敗', enrichAuthError_(err), ui.ButtonSet.OK);
  }
}

// =====================================================================
// 邀請、保護、未建立季度
// =====================================================================

/**
 * 用途：內容表 v2：季度填寫表已停用。原本是選單項目「寄出季度填寫邀請」的處理函式，現在只顯示已停用，
 *   一格都不寫（理由見 `showFillGridRetiredMenuAlert_()`）。
 * Args: （無）
 * Returns:
 *   {void}
 * Raises:
 *   （無）
 */
function menuSendFillInvite_() {
  showFillGridRetiredMenuAlert_('寄出季度填寫邀請');
}

/**
 * 用途：選單項目「設定工作表保護」的處理函式。
 * Args: （無）
 * Returns:
 *   {void}
 */
function menuApplySheetProtection_() {
  var ui = SpreadsheetApp.getUi();
  try {
    var result = applySheetProtection_();
    var lines = [
      '已保護 ' + result.protectedCount + ' 張工作表。',
      result.editors.length > 0
        ? '例外編輯者（' + result.editors.length + ' 位）仍然可以編輯。'
        : '目前只有擁有者可以編輯（Config 的 PROTECTION_EDITOR_EMAILS 是空的）。',
      '',
      'Fill_*、家事報告、代禱事項、團契、財政、常設團契、尊稱對照、PersonDisplay、',
      'Recipients 維持可編輯。'
    ];
    if (result.skipped.length > 0) {
      lines.push('');
      lines.push('略過（工作表不存在）：' + result.skipped.join('、'));
    }
    ui.alert('設定工作表保護', lines.join('\n'), ui.ButtonSet.OK);
  } catch (err) {
    logMenuError_('menuApplySheetProtection_', err);
    ui.alert('設定工作表保護失敗', enrichAuthError_(err), ui.ButtonSet.OK);
  }
}

/**
 * 用途：內容表 v2：季度填寫表已停用。原本是選單項目「檢查未建立的季度」的處理函式，現在只顯示已停用，
 *   一格都不寫（理由見 `showFillGridRetiredMenuAlert_()`）。
 * Args: （無）
 * Returns:
 *   {void}
 * Raises:
 *   （無）
 */
function menuCheckMissingQuarters_() {
  showFillGridRetiredMenuAlert_('檢查未建立的季度');
}

// =====================================================================
// 觸發器安裝／移除
// =====================================================================

/**
 * 用途：選單項目「安裝 Config 改動稽核觸發器」的處理函式（內容表 v2 之前叫「安裝填寫表同步
 *   觸發器」）。處理函式 `onFillGridEdit_` 的名字不改：已經安裝的觸發器按名字綁定。
 *
 *   ⚠️ 安裝前一律先刪同名觸發器——重複安裝會令同一次編輯觸發好幾次。
 * Args: （無）
 * Returns:
 *   {void}
 */
function menuInstallFillEditTrigger_() {
  var ui = SpreadsheetApp.getUi();
  try {
    var removed = removeTriggersByHandler_(FILL_EDIT_TRIGGER_HANDLER_);
    ScriptApp.newTrigger(FILL_EDIT_TRIGGER_HANDLER_)
      .forSpreadsheet(SpreadsheetApp.getActiveSpreadsheet())
      .onEdit()
      .create();

    ui.alert(
      '安裝 Config 改動稽核觸發器',
      [
        '已安裝。之後在試算表直接改 Config 的「設定鍵」或「值」，每一格都會記入 AuditLog（CONFIG_MANUAL_EDIT）。',
        removed > 0 ? '（安裝前先移除了 ' + removed + ' 個舊觸發器，避免重複觸發。）' : '',
        '',
        '季度填寫表已停用：在 Fill_* 分頁改動不會寫入週報。',
        '⚠️ onEdit 觸發器出錯是靜默的，所以系統會把錯誤寫進 ErrorLog（SOURCE=TRIGGER）。'
      ].filter(function (l) { return l; }).join('\n'),
      ui.ButtonSet.OK
    );
  } catch (err) {
    logMenuError_('menuInstallFillEditTrigger_', err);
    ui.alert('安裝觸發器失敗', enrichAuthError_(err), ui.ButtonSet.OK);
  }
}

/**
 * 用途：選單項目「移除 Config 改動稽核觸發器」的處理函式（內容表 v2 之前叫「移除填寫表同步
 *   觸發器」）。
 * Args: （無）
 * Returns:
 *   {void}
 */
function menuRemoveFillEditTrigger_() {
  var ui = SpreadsheetApp.getUi();
  try {
    var removed = removeTriggersByHandler_(FILL_EDIT_TRIGGER_HANDLER_);
    ui.alert('移除 Config 改動稽核觸發器', '已移除 ' + removed + ' 個觸發器。'
      + '\n\n⚠️ 移除之後，在試算表直接改 Config 不會再記入 AuditLog。', ui.ButtonSet.OK);
  } catch (err) {
    logMenuError_('menuRemoveFillEditTrigger_', err);
    ui.alert('移除觸發器失敗', enrichAuthError_(err), ui.ButtonSet.OK);
  }
}

/**
 * 用途：內容表 v2：季度填寫表已停用。原本是選單項目「安裝填寫表對帳觸發器」的處理函式，現在只顯示已停用，
 *   一格都不寫（理由見 `showFillGridRetiredMenuAlert_()`）。
 *   ⚠️ 不可以再安裝：對帳觸發器會把 Fill_ 的值寫回週報。
 * Args: （無）
 * Returns:
 *   {void}
 * Raises:
 *   （無）
 */
function menuInstallFillReconcileTrigger_() {
  showFillGridRetiredMenuAlert_('安裝填寫表對帳觸發器');
}

/**
 * 用途：選單項目「移除填寫表對帳觸發器」的處理函式。
 * Args: （無）
 * Returns:
 *   {void}
 */
function menuRemoveFillReconcileTrigger_() {
  var ui = SpreadsheetApp.getUi();
  try {
    var removed = removeTriggersByHandler_(FILL_RECONCILE_TRIGGER_HANDLER_);
    ui.alert('移除填寫表對帳觸發器', '已移除 ' + removed + ' 個觸發器。', ui.ButtonSet.OK);
  } catch (err) {
    logMenuError_('menuRemoveFillReconcileTrigger_', err);
    ui.alert('移除對帳觸發器失敗', enrichAuthError_(err), ui.ButtonSet.OK);
  }
}
