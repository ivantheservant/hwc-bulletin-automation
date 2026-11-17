#!/usr/bin/env node
/**
 * tests/helpers/legacyContentImportWrite.js
 *
 * R-060（2026-11-17）：「改動之前」的內容表匯入寫入做法，原封不動留作對照基準（只改了函式名稱加 `legacy` 前綴）。
 * 一格一格寫：每格改動呼叫 `writeBulletinWeekField_()`（每次重新讀整張 BulletinWeeks 找行、寫一格），
 * 每格再呼叫 `appendAuditLog_()`（每筆寫入一次）；版本在所有寫入之前一次存好。
 *
 * 用途：tests/contentimportbatch.test.js 在第二個沙盒把 `writeContentImportPlan_` 換成這一份，
 * 同一批輸入、同一個真正入口各跑一次，逐行比較工作表內容與 AuditLog——比對的基準是「舊程式真的做出來的結果」，
 * 不是我們對舊程式的記憶。也用來量度改動之前的讀寫呼叫次數。
 *
 * ⚠️ 不可以「順手整理」這份程式碼；它的價值就是與改動之前一模一樣。
 */

'use strict';

const vm = require('vm');

const LEGACY_SOURCE = `
function legacyReleaseFieldOverrides_(releases) {
  if (!releases || releases.length === 0) return;
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.FIELD_OVERRIDE);
  if (!sheet) {
    throw new Error('releaseFieldOverrides_：找不到工作表「' + SHEETS.FIELD_OVERRIDE
      + '」，請先執行「初始化工作表」。');
  }
  var activeCol = COLUMNS.FIELD_OVERRIDE.keys.indexOf('ACTIVE') + 1;
  releases.forEach(function (r) {
    sheet.getRange(r.row.__rowNo, activeCol).setValue(false);
    appendAuditLog_({
      action: 'FIELD_OVERRIDE_RELEASE',
      sheetName: SHEETS.FIELD_OVERRIDE,
      rowKey: r.isoDate + '#' + r.field,
      field: 'ACTIVE',
      oldValue: 'TRUE',
      newValue: 'FALSE',
      notes: '內容表現在的值已經與覆寫值一致（「' + String(r.overrideValue || '（空白）')
        + '」），改回跟隨內容表。記錄保留，不刪行。'
    });
  });
}

function legacyWriteContentImportPlan_(plan, options) {
  var opts = options || {};
  // 舊做法：applyContentImport_() 在寫入之前，一次替全部會被改到的主日存版本。
  var snapshotWarnings = opts.snapshotReason
    ? snapshotWeeksBeforeWrite_(contentImportAffectedDates_(plan), opts.snapshotReason) : [];

  var ss = SpreadsheetApp.getActiveSpreadsheet();

  Object.keys(plan.listPlans).forEach(function (sheetName) {
    var listPlan = plan.listPlans[sheetName];
    var sheet = ss.getSheetByName(sheetName);
    if (!sheet) return;

    var def = COLUMNS[SHEET_ID_BY_NAME[sheetName]];
    var activeCol = def.keys.indexOf('ACTIVE') + 1;

    listPlan.updates.forEach(function (update) {
      update.changes.forEach(function (change) {
        if (def.keys.indexOf(change.field) < 0) return;
        setCellValueTextSafe_(sheet, def, update.rowNo, change.field,
          change.field === 'ACTIVE' ? change.newValue : sanitizeCellText_(change.newValue));
        appendContentImportAudit_(sheetName, update.isoDate, change);
      });
    });

    listPlan.deactivations.forEach(function (row) {
      if (activeCol <= 0) return;
      sheet.getRange(row.rowNo, activeCol).setValue(false);
      appendContentImportAudit_(sheetName, row.isoDate,
        { field: 'ACTIVE', oldValue: 'TRUE', newValue: 'FALSE' });
    });

    if (listPlan.appends.length > 0) {
      var rows = listPlan.appends.map(function (row) {
        var out = {};
        def.keys.forEach(function (key) {
          if (key === 'SERVICE_DATE') { out[key] = normalizeDate_(row.SERVICE_DATE); return; }
          if (key === 'ACTIVE') { out[key] = true; return; }
          if (key === 'SEQ_NO') { out[key] = row.SEQ_NO; return; }
          out[key] = (row[key] === undefined || row[key] === null) ? '' : sanitizeCellText_(row[key]);
        });
        return out;
      });
      writeSheet_(sheetName, rows);
      listPlan.appends.forEach(function (row) {
        appendContentImportAudit_(sheetName, row.SERVICE_DATE,
          { field: '（整行）', oldValue: '', newValue: '新增一行' });
      });
    }
  });

  plan.weekUpdates.forEach(function (update) {
    update.changes.forEach(function (change) {
      writeBulletinWeekField_(update.isoDate, change.field, change.newValue);
      appendContentImportAudit_(SHEETS.BULLETIN_WEEKS, update.isoDate, change);
    });
  });

  legacyReleaseFieldOverrides_(plan.releases || []);
  return { datesTotal: 0, datesDone: 0, partial: false, snapshotWarnings: snapshotWarnings };
}
`;

/**
 * 用途：把「舊的」寫入做法裝進沙盒，並且讓 `writeContentImportPlan_` 改為它（真正入口 `applyContentImport_()` 照舊叫）。
 * Args:
 *   sandbox {vm.Context} `loadAllSrcFilesInOrder()` 的結果。
 * Returns:
 *   {void}
 */
function installLegacyContentImportWrite(sandbox) {
  vm.runInContext(LEGACY_SOURCE, sandbox, { filename: 'legacyContentImportWrite.js' });
  sandbox.writeContentImportPlan_ = sandbox.legacyWriteContentImportPlan_;
}

module.exports = { installLegacyContentImportWrite: installLegacyContentImportWrite, LEGACY_SOURCE: LEGACY_SOURCE };
