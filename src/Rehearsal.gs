/**
 * Rehearsal.gs
 *
 * prompt9 第 3 部分：「全季流程演練」——一鍵跑完整條流程（讀職事表快照 →
 * 建立／刷新季度填寫表 → 產生團契 → 組裝週報資料模型 → 產生一份 Word →
 * 組裝電郵內容 → 檢查職事表分歧 → 統計待填欄位），把每一步的結果與耗時
 * 寫成一份報告，讓 Ivan 一次過看到整季「如果現在真的跑會怎樣」。
 *
 * ⚠️ **唯讀為主**：
 *   - 「檢查職事表分歧」這一步刻意用 `computeRosterDiff_()`（純讀取），
 *     不是選單「檢查職事表分歧」用的 `checkRosterDiff_()`——後者會把
 *     「自動跟隨」寫進 `AuditLog`、推進 `BulletinWeeks` 的快照版本，
 *     整季跑一次等於把全季的快照版本都推進去，演練這種可以重複執行的
 *     工具不應該有這種一次性的副作用。
 *   - 「組裝電郵內容」只組字串（`buildBulletinEmailHtml_()`／
 *     `buildBulletinEmailPlainText_()`），完全不呼叫 `MailApp`、不寫
 *     `SendLog`——比「強制 DRY_RUN」更乾淨：連寄送那條程式路徑都沒有
 *     碰到，不會有「假使某處漏了判斷 DRY_RUN」的風險。
 *   - 「建立／刷新季度填寫表」「由常設時間表產生團契」**不是**唯讀
 *     （前者可能寫回同步結果，後者會新增團契資料列），但兩者本來就是
 *     幹事每季真的要做的事、而且都是冪等／只增不改——跟真正操作完全
 *     一樣，這正是「演練」要驗證的東西。
 *   - 「產生 Word」只產生**第一個**主日，避免 13 份 Word 拖慢整個演練；
 *     產生的檔案是真檔案，會留在 `BULLETIN_OUTPUT_FOLDER_ID`，報告會
 *     明確提示「需要人手清理」。
 *   - 全程不寫職事表一個位元。
 */

'use strict';

/**
 * 用途：包一層計時與例外處理——執行 `fn`，記下耗時（毫秒），例外不會
 *   往外拋，改記進 `failedSteps`。這是整個演練「單一步驟失敗不影響其餘
 *   步驟」的核心機制。
 * Args:
 *   name {string} 這一步的名稱（會出現在報告與失敗清單）。
 *   fn {function(): *} 要執行的函式。
 *   timings {Object<string,number>} 累積耗時的物件，會被修改。
 *   failedSteps {{step:string, message:string}[]} 累積失敗步驟的陣列，
 *     會被修改。
 * Returns:
 *   {{ok:boolean, value:*}} `ok:false` 時 `value` 是 `undefined`。
 */
function runRehearsalStep_(name, fn, timings, failedSteps) {
  var t0 = new Date().getTime();
  try {
    var value = fn();
    timings[name] = new Date().getTime() - t0;
    return { ok: true, value: value };
  } catch (err) {
    timings[name] = new Date().getTime() - t0;
    failedSteps.push({ step: name, message: (err && err.message) ? err.message : String(err) });
    return { ok: false, value: undefined };
  }
}

/**
 * 用途：「全季流程演練」的真正入口。
 * Args:
 *   quarterId {string} 季度 ID，例如 `'2027T4'`。
 * Returns:
 *   {Object} 見 `buildRehearsalReportLines_()` 用到的欄位；主要供
 *   `menuRunQuarterRehearsal_()` 與測試使用。
 */
function runQuarterRehearsal_(quarterId) {
  var timings = {};
  var failedSteps = [];

  // ---- 1. 讀職事表快照（該季每個主日）----
  var serviceDatesStep = runRehearsalStep_('1. 讀職事表快照', function () {
    return listQuarterServiceDates_(quarterId);
  }, timings, failedSteps);
  var serviceDates = serviceDatesStep.ok ? serviceDatesStep.value : [];

  // ---- 2. 建立／刷新季度填寫表 ----
  runRehearsalStep_('2. 建立／刷新季度填寫表', function () {
    return createOrRefreshFillGrid_(quarterId);
  }, timings, failedSteps);

  // ---- 3. 由常設時間表產生團契 ----
  runRehearsalStep_('3. 由常設時間表產生團契', function () {
    return generateQuarterFellowships_(quarterId);
  }, timings, failedSteps);

  // ---- 4. 為每個主日組裝 buildBulletinModel_() ----
  var models = {};
  runRehearsalStep_('4. 組裝週報資料模型（全季）', function () {
    serviceDates.forEach(function (sd) {
      try {
        models[sd.isoDate] = buildBulletinModel_(sd.isoDate);
      } catch (err) {
        models[sd.isoDate] = null;
        failedSteps.push({
          step: '4. 組裝週報資料模型：' + sd.isoDate,
          message: (err && err.message) ? err.message : String(err)
        });
      }
    });
  }, timings, failedSteps);

  // ---- 5. 產生 Word（只產生第一個主日的，避免太慢）----
  var wordResult = null;
  var firstIsoDate = serviceDates.length > 0 ? serviceDates[0].isoDate : null;
  if (firstIsoDate) {
    var wordStep = runRehearsalStep_('5. 產生 Word（僅第一個主日：' + firstIsoDate + '）', function () {
      var result = saveBulletinDocx_(firstIsoDate);
      if (!result.ok) throw new Error(result.message || ('原因代碼：' + result.reason));
      return result;
    }, timings, failedSteps);
    wordResult = wordStep.ok ? wordStep.value : null;
  }

  // ---- 6. 組裝電郵內容（不寄）----
  var emailOkCount = 0;
  runRehearsalStep_('6. 組裝電郵內容（全季，不寄）', function () {
    serviceDates.forEach(function (sd) {
      var model = models[sd.isoDate];
      if (!model) return; // 第 4 步已經記過失敗，這裡不重複記
      try {
        buildBulletinEmailHtml_(model, {});
        buildBulletinEmailPlainText_(model, {});
        emailOkCount++;
      } catch (err) {
        failedSteps.push({
          step: '6. 組裝電郵內容：' + sd.isoDate,
          message: (err && err.message) ? err.message : String(err)
        });
      }
    });
  }, timings, failedSteps);

  // ---- 7. 檢查職事表分歧（唯讀，不寫 AuditLog、不推進快照版本）----
  var diffs = {};
  runRehearsalStep_('7. 檢查職事表分歧（全季，唯讀）', function () {
    serviceDates.forEach(function (sd) {
      try {
        diffs[sd.isoDate] = computeRosterDiff_(sd.isoDate);
      } catch (err) {
        diffs[sd.isoDate] = null;
        failedSteps.push({
          step: '7. 檢查職事表分歧：' + sd.isoDate,
          message: (err && err.message) ? err.message : String(err)
        });
      }
    });
  }, timings, failedSteps);

  // ---- 8. 統計待填欄位（含尊稱未設定人數）----
  var honorificMissingCount = 0;
  runRehearsalStep_('8. 統計待填欄位／尊稱未設定人數', function () {
    if (!firstIsoDate) return;
    var quarterInfo = listRosterQuarterAssignedPersons_(firstIsoDate);
    var personDisplayRows = readSheet(SHEETS.PERSON_DISPLAY);
    honorificMissingCount = buildHonorificMissingList_(quarterInfo.persons, personDisplayRows).length;
  }, timings, failedSteps);

  var perDate = serviceDates.map(function (sd) {
    var model = models[sd.isoDate];
    var diff = diffs[sd.isoDate];
    if (!model) {
      return { isoDate: sd.isoDate, ok: false };
    }
    return {
      isoDate: sd.isoDate,
      ok: true,
      weekOfMonth: model.weekOfMonth,
      specialTitle: model.special ? model.special.title : '',
      templateId: model.templateId || '',
      programRows: (model.program || []).length,
      dutyRows: (model.dutyBoxPage1 || []).length,
      missingCount: (model.missing || []).length,
      warningCount: (model.warnings || []).length,
      conflictCount: diff ? diff.conflictCount : null
    };
  });

  var totals = perDate.reduce(function (acc, row) {
    if (!row.ok) return acc;
    acc.missing += row.missingCount;
    acc.warnings += row.warningCount;
    acc.conflicts += (row.conflictCount || 0);
    return acc;
  }, { missing: 0, warnings: 0, conflicts: 0 });

  var summary = {
    quarterId: quarterId,
    totalSundays: serviceDates.length,
    perDate: perDate,
    totalMissing: totals.missing,
    totalWarnings: totals.warnings,
    honorificMissingCount: honorificMissingCount,
    totalConflicts: totals.conflicts,
    timings: timings,
    failedSteps: failedSteps,
    wordResult: wordResult,
    emailOkCount: emailOkCount
  };

  writeDiagnosticsReport_('全季流程演練', buildRehearsalReportLines_(summary));
  return summary;
}

/**
 * 用途：把 `runQuarterRehearsal_()` 的結果排版成 `Diagnostics` 報告的
 *   內容行。
 *
 *   ⚠️ 區段標題一律用全形括號「【…】」，不可以用 `===` 開頭——見
 *   docs/已知bug類型.md 事故六。**失敗的步驟一定要獨立列出來**，不可以
 *   讓報告看起來「全部順利」卻其實有幾步是壞的。
 * Args:
 *   summary {Object} `runQuarterRehearsal_()` 的回傳值。
 * Returns:
 *   {string[]}
 */
function buildRehearsalReportLines_(summary) {
  var lines = [];

  lines.push('季度：' + summary.quarterId + '　共 ' + summary.totalSundays + ' 個主日');
  lines.push('');

  lines.push('【每一步的耗時】');
  Object.keys(summary.timings).forEach(function (name) {
    lines.push('　' + name + '：' + summary.timings[name] + ' 毫秒');
  });
  lines.push('');

  if (summary.failedSteps.length > 0) {
    lines.push('【⚠️ 失敗的步驟（' + summary.failedSteps.length + ' 個）】');
    summary.failedSteps.forEach(function (f) {
      lines.push('　' + f.step + '：' + f.message);
    });
  } else {
    lines.push('【失敗的步驟】（無，全部順利）');
  }
  lines.push('');

  lines.push('【全季彙總】');
  lines.push('總待填欄位：' + summary.totalMissing + '　總警告數：' + summary.totalWarnings
    + '　尊稱未設定人數：' + summary.honorificMissingCount + '　職事表分歧衝突數：' + summary.totalConflicts);
  lines.push('');

  lines.push('【每個主日】');
  summary.perDate.forEach(function (row) {
    if (!row.ok) {
      lines.push('　' + row.isoDate + '：⚠️ 資料模型組裝失敗，詳見上方失敗步驟。');
      return;
    }
    lines.push('　' + row.isoDate
      + '　第 ' + row.weekOfMonth + ' 個主日'
      + '　特別主日：' + (row.specialTitle || '（無）')
      + '　範本：' + (row.templateId || '（無）')
      + '　程序表 ' + row.programRows + ' 行'
      + '　事奉框 ' + row.dutyRows + ' 行'
      + '　待填 ' + row.missingCount + ' 項'
      + '　警告 ' + row.warningCount + ' 個'
      + '　分歧衝突 ' + (row.conflictCount === null ? '（未檢查）' : row.conflictCount + ' 項'));
  });
  lines.push('');

  lines.push('【產生的 Word 檔】');
  if (summary.wordResult && summary.wordResult.file) {
    lines.push('　' + summary.wordResult.file.fileName + '（' + summary.wordResult.file.url + '）');
    lines.push('　⚠️ 這是演練產生的真實檔案，需要人手清理，不會自動刪除。');
  } else {
    lines.push('　（沒有成功產生，見上方失敗步驟）');
  }
  lines.push('');

  lines.push('【組裝電郵內容】');
  lines.push('成功組裝 ' + summary.emailOkCount + '／' + summary.totalSundays + ' 個主日的郵件內容（全程沒有呼叫寄信服務，不會寄出任何郵件）。');

  return lines;
}

// =====================================================================
// 選單處理函式
// =====================================================================

/**
 * 用途：選單項目「全季流程演練」的處理函式。
 * Args: （無）
 * Returns:
 *   {void}
 */
function menuRunQuarterRehearsal_() {
  var ui = SpreadsheetApp.getUi();
  try {
    var resp = ui.prompt(
      '全季流程演練',
      '請輸入季度 ID（例如 2027T4）：',
      ui.ButtonSet.OK_CANCEL
    );
    if (resp.getSelectedButton() !== ui.Button.OK) return;

    var quarterId = resp.getResponseText().trim();
    if (!quarterId) {
      ui.alert('全季流程演練', '季度 ID 不可以是空的。', ui.ButtonSet.OK);
      return;
    }

    var summary = runQuarterRehearsal_(quarterId);
    var lines = [
      '季度：' + summary.quarterId + '　共 ' + summary.totalSundays + ' 個主日',
      '總待填 ' + summary.totalMissing + '　總警告 ' + summary.totalWarnings
        + '　尊稱未設定 ' + summary.honorificMissingCount + ' 人　分歧衝突 ' + summary.totalConflicts + ' 項',
      ''
    ];
    if (summary.failedSteps.length > 0) {
      lines.push('⚠️ 有 ' + summary.failedSteps.length + ' 個步驟失敗，詳見 Diagnostics 工作表。');
    } else {
      lines.push('全部步驟順利完成。');
    }
    lines.push('');
    lines.push('完整報告已寫入 Diagnostics 工作表。');
    if (summary.wordResult && summary.wordResult.file) {
      lines.push('⚠️ 演練產生了一份真實的 Word 檔（' + summary.wordResult.file.fileName + '），需要人手清理。');
    }

    ui.alert('全季流程演練', lines.join('\n'), ui.ButtonSet.OK);
  } catch (err) {
    logMenuError_('menuRunQuarterRehearsal_', err);
    ui.alert('全季流程演練失敗', enrichAuthError_(err), ui.ButtonSet.OK);
  }
}
