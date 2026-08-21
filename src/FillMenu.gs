/**
 * FillMenu.gs
 *
 * 季度填寫表相關的**選單處理函式**與觸發器安裝，以及「處理填寫表衝突」
 * 的 `HtmlService` 對話框。
 *
 * ⚠️ 每個 `menuXxx_()` 的 catch 分支都要呼叫 `logMenuError_()`
 * （`src/ErrorLog.gs`）寫一筆 `ErrorLog`（`SOURCE='MENU'`），再顯示
 * `ui.alert()`——不能只顯示對話框、不留記錄，見 docs/已知bug類型.md 事故七。
 */

'use strict';

/**
 * 用途：問使用者一個季度 ID，共用的小工具。
 * Args:
 *   ui {Ui} `SpreadsheetApp.getUi()`。
 *   title {string} 對話框標題。
 * Returns:
 *   {?string} 使用者取消時回 `null`。
 */
function promptForQuarterId_(ui, title) {
  var existing = listExistingFillGridQuarters_();
  var hint = existing.length > 0 ? '\n\n目前已建立的季度：' + existing.join('、') : '';
  var resp = ui.prompt(title, '請輸入季度 ID（例如 2027T4）：' + hint, ui.ButtonSet.OK_CANCEL);
  if (resp.getSelectedButton() !== ui.Button.OK) return null;
  var quarterId = resp.getResponseText().trim();
  return quarterId || null;
}

/**
 * 用途：選單項目「建立／刷新季度填寫表」的處理函式。
 * Args: （無）
 * Returns:
 *   {void}
 */
function menuCreateOrRefreshFillGrid_() {
  var ui = SpreadsheetApp.getUi();
  try {
    var quarterId = promptForQuarterId_(ui, '建立／刷新季度填寫表');
    if (!quarterId) return;

    var result = createOrRefreshFillGrid_(quarterId);
    if (!result.ok) {
      ui.alert('未能建立季度填寫表', result.message, ui.ButtonSet.OK);
      return;
    }

    var lines = [
      (result.created ? '已建立' : '已刷新') + '工作表：' + result.sheetName,
      '主日數：' + result.rowCount,
      '還原點：' + result.backupId
    ];

    if (result.sync) {
      lines.push('');
      lines.push('同步結果：寫回系統 ' + result.sync.pushCount + ' 格、刷新格子表 '
        + result.sync.pullCount + ' 格、衝突 ' + result.sync.conflictCount + ' 格');
      if (result.sync.conflictCount > 0) {
        lines.push('');
        lines.push('⚠️ 有 ' + result.sync.conflictCount + ' 格兩邊都改過，系統沒有改動任何一邊。');
        lines.push('請用選單「處理填寫表衝突」逐項確認。');
      }
    }

    ui.alert('季度填寫表', lines.join('\n'), ui.ButtonSet.OK);
  } catch (err) {
    logMenuError_('menuCreateOrRefreshFillGrid_', err);
    ui.alert('建立季度填寫表失敗', String(err && err.message ? err.message : err), ui.ButtonSet.OK);
  }
}

/**
 * 用途：選單項目「立即同步季度填寫表」的處理函式。
 * Args: （無）
 * Returns:
 *   {void}
 */
function menuSyncFillGrid_() {
  var ui = SpreadsheetApp.getUi();
  try {
    var quarterId = promptForQuarterId_(ui, '立即同步季度填寫表');
    if (!quarterId) return;

    var plan = syncFillGrid_(quarterId);
    writeDiagnosticsReport_('季度填寫表同步', buildFillSyncReportLines_(plan));

    var lines = [
      '季度：' + quarterId,
      '寫回 BulletinWeeks：' + plan.pushCount + ' 格',
      '刷新格子表：' + plan.pullCount + ' 格',
      '衝突：' + plan.conflictCount + ' 格',
      '兩邊一致：' + plan.sameCount + ' 格'
    ];
    if (plan.conflictCount > 0) {
      lines.push('');
      lines.push('⚠️ 衝突的格子一格都沒有被改動，兩邊的值都保留。');
      lines.push('請用選單「處理填寫表衝突」逐項確認。');
    }
    lines.push('');
    lines.push('完整內容已寫入 Diagnostics 工作表。');

    ui.alert('同步完成', lines.join('\n'), ui.ButtonSet.OK);
  } catch (err) {
    logMenuError_('menuSyncFillGrid_', err);
    ui.alert('同步失敗', String(err && err.message ? err.message : err), ui.ButtonSet.OK);
  }
}

// =====================================================================
// 處理填寫表衝突（HtmlService 對話框）
// =====================================================================

/**
 * 用途：選單項目「處理填寫表衝突」的處理函式。開一個對話框逐項列出
 *   衝突，每項三選一。
 * Args: （無）
 * Returns:
 *   {void}
 */
function menuResolveFillConflicts_() {
  var ui = SpreadsheetApp.getUi();
  try {
    var quarterId = promptForQuarterId_(ui, '處理填寫表衝突');
    if (!quarterId) return;

    var plan = computeFillSyncPlan_(quarterId);
    var conflicts = plan.cells.filter(function (c) { return c.status === FILL_SYNC_STATUS.CONFLICT; });

    if (conflicts.length === 0) {
      ui.alert('處理填寫表衝突', '季度 ' + quarterId + ' 目前沒有任何衝突。', ui.ButtonSet.OK);
      return;
    }

    var template = HtmlService.createTemplateFromFile('ui/FillConflict');
    template.quarterId = quarterId;
    template.conflictsJson = JSON.stringify(conflicts);
    ui.showModalDialog(
      template.evaluate().setWidth(900).setHeight(600),
      '處理填寫表衝突（' + quarterId + '，共 ' + conflicts.length + ' 格）'
    );
  } catch (err) {
    logMenuError_('menuResolveFillConflicts_', err);
    ui.alert('處理填寫表衝突失敗', String(err && err.message ? err.message : err), ui.ButtonSet.OK);
  }
}

/**
 * 用途：選單項目「檢查格子表外觀」的處理函式。**唯讀**——只讀取實際
 *   套用的條件格式、凍結行欄、殘留註解、數字格式，寫入 `Diagnostics`，
 *   不改動格子表任何一格。
 * Args: （無）
 * Returns:
 *   {void}
 */
function menuCheckFillGridAppearance_() {
  var ui = SpreadsheetApp.getUi();
  try {
    var quarterId = promptForQuarterId_(ui, '檢查格子表外觀');
    if (!quarterId) return;

    var facts = inspectFillGridAppearance_(quarterId);
    writeDiagnosticsReport_('格子表外觀檢查', buildFillAppearanceReportLines_(facts));

    ui.alert(
      '檢查格子表外觀',
      '已把「' + facts.sheetName + '」的條件格式與格式設定寫入 Diagnostics 工作表。',
      ui.ButtonSet.OK
    );
  } catch (err) {
    logMenuError_('menuCheckFillGridAppearance_', err);
    ui.alert('檢查格子表外觀失敗', String(err && err.message ? err.message : err), ui.ButtonSet.OK);
  }
}

/**
 * 用途：衝突對話框呼叫的伺服器端函式——把使用者的選擇寫入。
 *
 *   ⚠️ 「暫不處理」（`SKIP`）的格**完全不動**，快照也不更新，所以下一次
 *   比對仍然會報成衝突。這是刻意的：使用者明確表示「稍後再算」，系統
 *   不可以自作主張把它變成不再提醒。
 * Args:
 *   quarterId {string} 季度 ID。
 *   decisions {{isoDate:string, fieldKey:string, choice:string}[]}
 *     `choice` 是 `'GRID'`（用格子表的值）／`'SYSTEM'`（用系統的值）／
 *     `'SKIP'`（暫不處理）。
 * Returns:
 *   {{ok:boolean, appliedGrid:number, appliedSystem:number, skipped:number,
 *     decisionsReceived:number, matchedConflicts:number, unmatched:number,
 *     message:string}}
 */
function apiResolveFillConflicts(quarterId, decisions) {
  return withApiResult_(function () {
    return resolveFillConflicts_(normalizeQuarterId_(quarterId), decisions);
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
    ui.alert('備份失敗', String(err && err.message ? err.message : err), ui.ButtonSet.OK);
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
    ui.alert('還原失敗', String(err && err.message ? err.message : err), ui.ButtonSet.OK);
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
    ui.alert('整理清單次序失敗', String(err && err.message ? err.message : err), ui.ButtonSet.OK);
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
    ui.alert('產生團契聚會失敗', String(err && err.message ? err.message : err), ui.ButtonSet.OK);
  }
}

// =====================================================================
// 邀請、保護、未建立季度
// =====================================================================

/**
 * 用途：選單項目「寄出季度填寫邀請」的處理函式。
 * Args: （無）
 * Returns:
 *   {void}
 */
function menuSendFillInvite_() {
  var ui = SpreadsheetApp.getUi();
  try {
    var quarterId = promptForQuarterId_(ui, '寄出季度填寫邀請');
    if (!quarterId) return;

    var result = sendFillInvite_(quarterId);
    if (!result.sent) {
      ui.alert('未能寄出填寫邀請', result.message || ('原因代碼：' + result.reason), ui.ButtonSet.OK);
      return;
    }

    ui.alert(
      '填寫邀請',
      [
        '季度：' + quarterId,
        '收件人：' + result.recipientCount + ' 位',
        result.dryRun
          ? '⚠️ DRY_RUN 目前是 TRUE，**沒有真的寄出**，只在 SendLog 留了記錄。'
          : '已真正寄出。'
      ].join('\n'),
      ui.ButtonSet.OK
    );
  } catch (err) {
    logMenuError_('menuSendFillInvite_', err);
    ui.alert('寄出填寫邀請失敗', String(err && err.message ? err.message : err), ui.ButtonSet.OK);
  }
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
    ui.alert('設定工作表保護失敗', String(err && err.message ? err.message : err), ui.ButtonSet.OK);
  }
}

/**
 * 用途：選單項目「檢查未建立的季度」的處理函式。唯讀。
 * Args: （無）
 * Returns:
 *   {void}
 */
function menuCheckMissingQuarters_() {
  var ui = SpreadsheetApp.getUi();
  try {
    var missing = findQuartersWithoutFillGrid_();
    var existing = listExistingFillGridQuarters_();

    ui.alert(
      '檢查未建立的季度',
      [
        '已建立填寫表的季度（' + existing.length + '）：' + (existing.join('、') || '（無）'),
        '',
        '尚未建立的季度（' + missing.length + '）：' + (missing.join('、') || '（無）'),
        '',
        missing.length > 0
          ? '可以用「建立／刷新季度填寫表」逐一建立；每週寄送流程也會自動建立並寄出邀請'
            + '（受 Config 的 FILL_AUTO_CREATE_NEXT_QUARTER 與 DRY_RUN 控制）。'
          : '全部季度都已經有填寫表。'
      ].join('\n'),
      ui.ButtonSet.OK
    );
  } catch (err) {
    logMenuError_('menuCheckMissingQuarters_', err);
    ui.alert('檢查未建立的季度失敗', String(err && err.message ? err.message : err), ui.ButtonSet.OK);
  }
}

// =====================================================================
// 觸發器安裝／移除
// =====================================================================

/**
 * 用途：選單項目「安裝填寫表同步觸發器」的處理函式。
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
      '安裝填寫表同步觸發器',
      [
        '已安裝。之後在 Fill_* 工作表的編輯會即時寫回 BulletinWeeks。',
        removed > 0 ? '（安裝前先移除了 ' + removed + ' 個舊觸發器，避免重複觸發。）' : '',
        '',
        '⚠️ onEdit 觸發器出錯是靜默的，所以系統會把錯誤寫進 ErrorLog（SOURCE=TRIGGER）。',
        '如果覺得同步沒有生效，先看那張表。'
      ].filter(function (l) { return l; }).join('\n'),
      ui.ButtonSet.OK
    );
  } catch (err) {
    logMenuError_('menuInstallFillEditTrigger_', err);
    ui.alert('安裝觸發器失敗', String(err && err.message ? err.message : err), ui.ButtonSet.OK);
  }
}

/**
 * 用途：選單項目「移除填寫表同步觸發器」的處理函式。
 * Args: （無）
 * Returns:
 *   {void}
 */
function menuRemoveFillEditTrigger_() {
  var ui = SpreadsheetApp.getUi();
  try {
    var removed = removeTriggersByHandler_(FILL_EDIT_TRIGGER_HANDLER_);
    ui.alert('移除填寫表同步觸發器', '已移除 ' + removed + ' 個觸發器。', ui.ButtonSet.OK);
  } catch (err) {
    logMenuError_('menuRemoveFillEditTrigger_', err);
    ui.alert('移除觸發器失敗', String(err && err.message ? err.message : err), ui.ButtonSet.OK);
  }
}

/**
 * 用途：選單項目「安裝填寫表對帳觸發器」的處理函式。每隔
 *   Config `FILL_RECONCILE_HOURS` 小時跑一次。
 * Args: （無）
 * Returns:
 *   {void}
 */
function menuInstallFillReconcileTrigger_() {
  var ui = SpreadsheetApp.getUi();
  try {
    var hours = normalizeInt_(getConfig(CONFIG_KEYS.FILL_RECONCILE_HOURS, '6'));
    if (!hours || hours < 1) hours = 6;

    var removed = removeTriggersByHandler_(FILL_RECONCILE_TRIGGER_HANDLER_);
    ScriptApp.newTrigger(FILL_RECONCILE_TRIGGER_HANDLER_).timeBased().everyHours(hours).create();

    ui.alert(
      '安裝填寫表對帳觸發器',
      [
        '已安裝，每 ' + hours + ' 小時跑一次三方對帳。',
        removed > 0 ? '（安裝前先移除了 ' + removed + ' 個舊觸發器。）' : '',
        '',
        '對帳是安全網：即時同步觸發器萬一漏了某次編輯，對帳會補上。',
        '有衝突時會寫 Diagnostics 並寄提醒（受 DRY_RUN 保護）。'
      ].filter(function (l) { return l; }).join('\n'),
      ui.ButtonSet.OK
    );
  } catch (err) {
    logMenuError_('menuInstallFillReconcileTrigger_', err);
    ui.alert('安裝對帳觸發器失敗', String(err && err.message ? err.message : err), ui.ButtonSet.OK);
  }
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
    ui.alert('移除對帳觸發器失敗', String(err && err.message ? err.message : err), ui.ButtonSet.OK);
  }
}
