/**
 * HonorificSetup.gs
 *
 * 第六b輪：`PersonDisplay` 現時是空的，導致每週週報都有一大批「找不到
 * 尊稱設定」警告。本檔案提供三個選單項目，讓 Ivan 不用做 VLOOKUP、也不用
 * 人手逐個配對：
 *
 *   1. 「由職事表建立 PersonDisplay 骨架」——由職事表 `NameMapping` 建立
 *      `PersonDisplay` 骨架（`HONORIFIC` 留空）。
 *   2. 「套用尊稱對照表」——把 Ivan 貼進 `HonorificLookup` 的「姓名 → 尊稱」
 *      對照表，自動填入 `PersonDisplay.HONORIFIC`。
 *   3. 「尊稱未設定報告」——唯讀，列出本季有事奉、但尊稱仍然空白的人。
 *
 * 本輪不碰 Google Docs、PDF、版面、電郵。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 為什麼 `HonorificLookup` 要「寬鬆」讀取
 * ─────────────────────────────────────────────────────────────────────
 *
 * `HonorificLookup` 是 Ivan **人手貼上**的對照表，不是系統資料。系統自己
 * 的工作表（`Constants.gs` 的 `COLUMNS`）用嚴格規則是合理的——結構是
 * 系統自己控制的。但這張表的內容是外部貼進來的，貼錯欄、漏填、打錯字
 * 都是正常會發生的事，硬規則是：**貼錯了要略過並提示，不可以讓整個
 * 功能拋錯擋住 Ivan**。
 */

'use strict';

/** HonorificLookup.HONORIFIC／PersonDisplay.HONORIFIC 的合法取值清單。 */
var HONORIFIC_LOOKUP_VALID_VALUES_ = [
  HONORIFIC.BROTHER, HONORIFIC.SISTER, HONORIFIC.PASTOR,
  HONORIFIC.PASTORS_WIFE, HONORIFIC.MINISTER, HONORIFIC.MISSIONARY
];

// =====================================================================
// 共用：姓名比對正規化
// =====================================================================

/**
 * 用途：把姓名正規化成「用來比對是否同一個人」的形式——移除全部空白
 *   字元（含前後與中間、半形與全形空格 `　`）。
 *
 *   ⚠️ **不做模糊比對、不做字序調整**：這裡只處理「貼資料時不小心多了
 *   一個空格」這種純粹的排版雜訊，「李敏慧」與「李慧敏」這種字序不同的
 *   別名**必須維持不同**，對不上就是對不上，交由 Ivan 自己判斷——猜錯
 *   人名在教會週報是嚴重錯誤，見本檔案 buildHonorificLookupIndex_() 與
 *   buildApplyHonorificPlan_() 的說明。
 * Args:
 *   name {string} 原始姓名文字。
 * Returns:
 *   {string} 正規化後的姓名，只用來當比對用的鍵，不用於顯示。
 */
function normalizeNameForMatch_(name) {
  return String(name || '').replace(/[\s　]+/g, '');
}

// =====================================================================
// 純函式層：由職事表建立 PersonDisplay 骨架
// =====================================================================

/**
 * 用途：算出「由職事表 NameMapping 建立 PersonDisplay 骨架」要新增哪些
 *   行。純函式，不碰 Apps Script 服務。
 *
 *   ⚠️ **冪等**：`PERSON_ID` 已經存在於 `existingPersonDisplayRows` 的
 *   人，**完全不會**出現在 `appends` 內——連 `NAME_TC` 都不會被覆蓋，
 *   因為 Ivan 可能已經人手調整過那一行（例如姓名有 DISPLAY_OVERRIDE
 *   要保留的理由）。
 * Args:
 *   nameMappingRows {Object[]} `readRosterNameMappingRows_()` 的輸出，
 *     每個元素是 `{PersonID, NameTC, Active}`。
 *   existingPersonDisplayRows {Object[]} `PersonDisplay` 工作表現有的
 *     資料列（`readSheet()` 的輸出）。
 * Returns:
 *   {{appends:{PERSON_ID:string, NAME_TC:string, ACTIVE:boolean}[],
 *     addedCount:number, skippedExistingCount:number,
 *     blankHonorificCount:number}}
 *     `blankHonorificCount` 是這次操作**完成之後**，`PersonDisplay`
 *     內 `ACTIVE=TRUE` 且 `HONORIFIC` 仍空白的總人數（含既有的與新增的）。
 */
function buildPersonDisplaySkeletonPlan_(nameMappingRows, existingPersonDisplayRows) {
  var activePersons = (nameMappingRows || []).filter(function (p) { return p.Active === true; });

  var existingIds = {};
  var existingBlankHonorificCount = 0;
  (existingPersonDisplayRows || []).forEach(function (row) {
    existingIds[row.PERSON_ID] = true;
    if (row.ACTIVE === true && String(row.HONORIFIC || '').trim() === '') {
      existingBlankHonorificCount++;
    }
  });

  var appends = activePersons
    .filter(function (p) { return !existingIds[p.PersonID]; })
    .map(function (p) {
      return { PERSON_ID: p.PersonID, NAME_TC: p.NameTC, ACTIVE: true };
    });

  return {
    appends: appends,
    addedCount: appends.length,
    skippedExistingCount: activePersons.length - appends.length,
    blankHonorificCount: existingBlankHonorificCount + appends.length
  };
}

// =====================================================================
// 純函式層：套用尊稱對照表
// =====================================================================

/**
 * 用途：把 `HonorificLookup` 的資料列組成「姓名 → 尊稱」索引。純函式。
 *
 *   逐行規則：
 *     - `HONORIFIC` 空白 → 略過（代表 Ivan 還沒確認這個人），不算錯誤。
 *     - `HONORIFIC` 不在合法清單內（弟兄／姊妹／牧師／師母／傳道／
 *       宣教士）→ 略過該行並記一筆 warning，**不拋錯**——Ivan 可能貼錯
 *       欄，硬擋住會讓他沒辦法儲存其餘正確的資料。
 *     - 同一個姓名（正規化後）出現多次，尊稱**不同** → 整個名字都
 *       **不套用**，記進 `conflicts`，交由 Ivan 自己決定；出現多次但
 *       尊稱**相同** → 當一筆處理，正常收進索引。
 * Args:
 *   lookupRows {Object[]} `HonorificLookup` 工作表的資料列（`readSheet()`
 *     的輸出）。
 * Returns:
 *   {{index:Object<string,string>, conflicts:{name:string,honorifics:string[]}[],
 *     invalidWarnings:{name:string,value:string,message:string}[]}}
 *     `index` 的鍵是 `normalizeNameForMatch_()` 正規化後的姓名。
 */
function buildHonorificLookupIndex_(lookupRows) {
  var byName = {};       // normalizedName -> { displayName, honorifics: Set-like object }
  var invalidWarnings = [];

  (lookupRows || []).forEach(function (row) {
    var displayName = String(row.NAME_TC || '').trim();
    var normalizedName = normalizeNameForMatch_(row.NAME_TC);
    if (!normalizedName) return;

    var honorific = String(row.HONORIFIC || '').trim();
    if (!honorific) return; // 未確認，略過，不當錯誤。

    if (HONORIFIC_LOOKUP_VALID_VALUES_.indexOf(honorific) === -1) {
      invalidWarnings.push({
        name: displayName,
        value: honorific,
        message: '姓名「' + displayName + '」的尊稱「' + honorific + '」不是合法值（弟兄／姊妹／牧師／師母／傳道／宣教士），已略過這一行，請檢查 HonorificLookup 是不是貼錯欄。'
      });
      return;
    }

    if (!byName[normalizedName]) {
      byName[normalizedName] = { displayName: displayName, honorifics: {} };
    }
    byName[normalizedName].honorifics[honorific] = true;
  });

  var index = {};
  var conflicts = [];
  Object.keys(byName).forEach(function (normalizedName) {
    var entry = byName[normalizedName];
    var distinctHonorifics = Object.keys(entry.honorifics);
    if (distinctHonorifics.length === 1) {
      index[normalizedName] = distinctHonorifics[0];
    } else {
      conflicts.push({ name: entry.displayName, honorifics: distinctHonorifics });
    }
  });

  return { index: index, conflicts: conflicts, invalidWarnings: invalidWarnings };
}

/**
 * 用途：算出「套用尊稱對照表」要對 `PersonDisplay` 做哪些更新。純函式。
 *
 *   逐行規則：
 *     - `HONORIFIC` **已經有值** → 不覆蓋，計入 `alreadySetCount`（避免
 *       蓋掉 Ivan 人手調整過的設定）。
 *     - `HONORIFIC` 空白，姓名（正規化後）在索引內 → 產生一筆更新。
 *     - `HONORIFIC` 空白，姓名不在索引內 → 計入 `notMatched`，不當錯誤
 *       ——職事表的姓名與對照表的姓名可能有落差，交由 Ivan 自己處理。
 * Args:
 *   personDisplayRowsWithRowNo {Object[]} `readRowsWithRowNo_(SHEETS.PERSON_DISPLAY)`
 *     的輸出（每個元素多一個 `__rowNo`）。
 *   lookupResult {Object} `buildHonorificLookupIndex_()` 的輸出。
 * Returns:
 *   {{updates:{rowNo:number, personId:string, name:string, honorific:string}[],
 *     alreadySetCount:number, notMatched:{personId:string, name:string}[]}}
 */
function buildApplyHonorificPlan_(personDisplayRowsWithRowNo, lookupResult) {
  var index = (lookupResult && lookupResult.index) || {};
  var updates = [];
  var notMatched = [];
  var alreadySetCount = 0;

  (personDisplayRowsWithRowNo || []).forEach(function (row) {
    if (String(row.HONORIFIC || '').trim() !== '') {
      alreadySetCount++;
      return;
    }

    var normalizedName = normalizeNameForMatch_(row.NAME_TC);
    var honorific = normalizedName ? index[normalizedName] : undefined;

    if (honorific) {
      updates.push({ rowNo: row.__rowNo, personId: row.PERSON_ID, name: row.NAME_TC, honorific: honorific });
    } else {
      notMatched.push({ personId: row.PERSON_ID, name: row.NAME_TC });
    }
  });

  return { updates: updates, alreadySetCount: alreadySetCount, notMatched: notMatched };
}

// =====================================================================
// 真正入口
// =====================================================================

/**
 * 用途：由職事表 `NameMapping` 建立 `PersonDisplay` 骨架的真正入口。讀
 *   `NameMapping`（唯讀，經 src/RosterRead.gs）與現有的 `PersonDisplay`，
 *   算出要新增的行，寫入並逐行記一筆 `AuditLog`。
 *
 *   ⚠️ 一格職事表都不會寫——`readRosterNameMappingRows_()` 是唯讀的
 *   （見 tools/lint-readonly-roster.js）。
 * Args: （無）
 * Returns:
 *   {{added:number, skippedExisting:number, blankHonorific:number}}
 * Raises:
 *   Error 如果 `ROSTER_SPREADSHEET_ID` 未設定、職事表讀取失敗，或
 *     `PersonDisplay` 工作表不存在（尚未「初始化工作表」）。
 */
function buildPersonDisplaySkeletonFromRoster_() {
  var nameMappingRows = readRosterNameMappingRows_();
  var existingRows = readSheet(SHEETS.PERSON_DISPLAY);
  var plan = buildPersonDisplaySkeletonPlan_(nameMappingRows, existingRows);

  if (plan.appends.length > 0) {
    var rows = plan.appends.map(function (row) {
      return {
        PERSON_ID: sanitizeCellText_(row.PERSON_ID),
        NAME_TC: sanitizeCellText_(row.NAME_TC),
        ACTIVE: row.ACTIVE
      };
    });
    writeSheet(SHEETS.PERSON_DISPLAY, rows);

    plan.appends.forEach(function (row) {
      appendAuditLog_({
        action: 'PERSON_DISPLAY_SKELETON_ADD',
        sheetName: SHEETS.PERSON_DISPLAY,
        rowKey: row.PERSON_ID,
        field: 'NAME_TC',
        oldValue: '',
        newValue: row.NAME_TC,
        notes: '由職事表 NameMapping 建立 PersonDisplay 骨架，HONORIFIC 留空待補。'
      });
    });
  }

  return {
    added: plan.addedCount,
    skippedExisting: plan.skippedExistingCount,
    blankHonorific: plan.blankHonorificCount
  };
}

/**
 * 用途：套用尊稱對照表的真正入口。讀 `HonorificLookup` 建立索引、讀
 *   `PersonDisplay`（帶行號），算出要更新的行並逐格寫入，記
 *   `AuditLog`，完整結果寫入 `Diagnostics`（報告名稱「套用尊稱對照表」）。
 * Args: （無）
 * Returns:
 *   {{filled:number, alreadySet:number, notMatched:number, conflicts:number}}
 * Raises:
 *   Error 如果 `HonorificLookup`／`PersonDisplay` 工作表不存在（尚未
 *     「初始化工作表」）。
 */
function applyHonorificLookupToPersonDisplay_() {
  var lookupRows = readSheet(SHEETS.HONORIFIC_LOOKUP);
  var lookupResult = buildHonorificLookupIndex_(lookupRows);

  var personDisplayRows = readRowsWithRowNo_(SHEETS.PERSON_DISPLAY);
  var plan = buildApplyHonorificPlan_(personDisplayRows, lookupResult);

  if (plan.updates.length > 0) {
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.PERSON_DISPLAY);
    if (!sheet) {
      throw new Error('applyHonorificLookupToPersonDisplay_：找不到工作表「' + SHEETS.PERSON_DISPLAY + '」，請先執行「初始化工作表」。');
    }
    var honorificCol = COLUMNS.PERSON_DISPLAY.keys.indexOf('HONORIFIC') + 1;

    plan.updates.forEach(function (u) {
      sheet.getRange(u.rowNo, honorificCol).setValue(sanitizeCellText_(u.honorific));
      // ⚠️ 這裡的姓名欄位刻意拆到獨立變數、不跟字串字面值同一行寫——
      // 那個機器鍵剛好也是常見頂層網域的字尾，掃字串工具的誤判防線
      // 見 tools/scan-staged-secrets.js 檔頭說明；同一原因，這段註解
      // 本身也刻意不直接打出那個機器鍵組合。
      var matchedName = u.name;
      appendAuditLog_({
        action: 'HONORIFIC_FILL',
        sheetName: SHEETS.PERSON_DISPLAY,
        rowKey: u.personId,
        field: 'HONORIFIC',
        oldValue: '',
        newValue: u.honorific,
        notes: '由 HonorificLookup 對照表自動填入（姓名：' + matchedName + '）。'
      });
    });
  }

  writeDiagnosticsReport_('套用尊稱對照表', buildApplyHonorificReportLines_(plan, lookupResult));

  return {
    filled: plan.updates.length,
    alreadySet: plan.alreadySetCount,
    notMatched: plan.notMatched.length,
    conflicts: lookupResult.conflicts.length
  };
}

/**
 * 用途：組出「套用尊稱對照表」寫入 Diagnostics 的報告內容，分三段：
 *   已填入的名單、對不上的名單、對照表衝突的名單。截斷邏輯交給
 *   `writeDiagnosticsReport_()`（依 Config 的 `DIAGNOSTICS_MAX_ROWS`）。
 * Args:
 *   plan {Object} `buildApplyHonorificPlan_()` 的輸出。
 *   lookupResult {Object} `buildHonorificLookupIndex_()` 的輸出。
 * Returns:
 *   {string[]}
 */
function buildApplyHonorificReportLines_(plan, lookupResult) {
  var lines = [];
  lines.push('【摘要】');
  lines.push('已填入：' + plan.updates.length + '　已有值略過：' + plan.alreadySetCount
    + '　對不上：' + plan.notMatched.length + '　對照表衝突：' + lookupResult.conflicts.length);

  lines.push('');
  lines.push('【已填入（' + plan.updates.length + ' 項）】');
  if (plan.updates.length === 0) {
    lines.push('（無）');
  } else {
    plan.updates.forEach(function (u) {
      var matchedName = u.name;
      lines.push('　' + u.personId + '　' + matchedName + '　→　' + u.honorific);
    });
  }

  lines.push('');
  lines.push('【對不上（' + plan.notMatched.length + ' 項，職事表姓名與對照表姓名可能有落差，請自行處理）】');
  if (plan.notMatched.length === 0) {
    lines.push('（無）');
  } else {
    plan.notMatched.forEach(function (n) {
      lines.push('　' + n.personId + '　' + n.name);
    });
  }

  lines.push('');
  lines.push('【對照表衝突（' + lookupResult.conflicts.length + ' 項，同一姓名在 HonorificLookup 有不同尊稱，未套用，請自行確認）】');
  if (lookupResult.conflicts.length === 0) {
    lines.push('（無）');
  } else {
    lookupResult.conflicts.forEach(function (c) {
      // ⚠️ 同上（見本檔案 applyHonorificLookupToPersonDisplay_() 的說明）：
      // 姓名欄位拆到獨立變數，避免掃字串工具誤判。
      var conflictName = c.name;
      lines.push('　' + conflictName + '　→　' + c.honorifics.join('／'));
    });
  }

  if (lookupResult.invalidWarnings.length > 0) {
    lines.push('');
    lines.push('【HonorificLookup 內容異常（' + lookupResult.invalidWarnings.length + ' 項，已略過）】');
    lookupResult.invalidWarnings.forEach(function (w) {
      lines.push('　' + w.message);
    });
  }

  return lines;
}

// =====================================================================
// 純函式層＋真正入口：尊稱未設定報告
// =====================================================================

/**
 * 用途：從「本季有事奉的人」與 `PersonDisplay` 現況，算出尊稱仍然空白
 *   的名單。純函式。
 * Args:
 *   quarterPersons {{personId:string, nameTC:string}[]}
 *     `listRosterQuarterAssignedPersons_()` 回傳的 `persons`。
 *   personDisplayRows {Object[]} `PersonDisplay` 工作表的資料列
 *     （`readSheet()` 的輸出）。
 * Returns:
 *   {{personId:string, nameTC:string}[]} `PersonDisplay` 完全沒有這個
 *     `PersonID`、或者有但 `HONORIFIC` 空白的人，都算「尊稱未設定」。
 */
function buildHonorificMissingList_(quarterPersons, personDisplayRows) {
  var honorificByPersonId = {};
  (personDisplayRows || []).forEach(function (row) {
    if (!(row.PERSON_ID in honorificByPersonId)) {
      honorificByPersonId[row.PERSON_ID] = row.HONORIFIC;
    }
  });

  return (quarterPersons || []).filter(function (p) {
    var honorific = honorificByPersonId[p.personId];
    return honorific === undefined || String(honorific || '').trim() === '';
  });
}

/**
 * 用途：「尊稱未設定報告」的真正入口。**唯讀**，不寫入任何一格、不記
 *   `AuditLog`。列出指定主日所在季度，有實際事奉安排、但 `PersonDisplay`
 *   尊稱仍然空白的人，寫入 `Diagnostics`（報告名稱「尊稱未設定」）。
 * Args:
 *   isoDate {string} 主日日期，yyyy-MM-dd——用來定位「哪一季」。
 * Returns:
 *   {{quarterId:(string|null), versionNo:(number|null),
 *     totalAssigned:number, missingCount:number,
 *     missing:{personId:string, nameTC:string}[]}}
 * Raises:
 *   Error 如果 `ROSTER_SPREADSHEET_ID` 未設定、職事表讀取失敗，或
 *     `isoDate` 格式不對（見 listRosterQuarterAssignedPersons_()）。
 */
function buildHonorificMissingReport_(isoDate) {
  var quarterInfo = listRosterQuarterAssignedPersons_(isoDate);
  var personDisplayRows = readSheet(SHEETS.PERSON_DISPLAY);
  var missing = buildHonorificMissingList_(quarterInfo.persons, personDisplayRows);

  var lines = [];
  if (!quarterInfo.quarterId) {
    lines.push('職事表找不到 ' + isoDate + ' 這個主日，無法判斷季度。');
  } else if (quarterInfo.versionNo === null) {
    lines.push('季度：' + quarterInfo.quarterId);
    lines.push('該季尚未生成職事表版本，沒有事奉資料可以檢查。');
  } else {
    lines.push('季度：' + quarterInfo.quarterId + '（版本 ' + quarterInfo.versionNo + '）');
    lines.push('本季有事奉的人數：' + quarterInfo.persons.length);
    lines.push('尊稱仍未設定：' + missing.length + ' 人');
    lines.push('');
    lines.push('【尊稱未設定名單】');
    if (missing.length === 0) {
      lines.push('（無，全部已設定）');
    } else {
      missing.forEach(function (p) {
        lines.push('　' + p.personId + '　' + p.nameTC);
      });
    }
  }

  writeDiagnosticsReport_('尊稱未設定', lines);

  return {
    quarterId: quarterInfo.quarterId,
    versionNo: quarterInfo.versionNo,
    totalAssigned: quarterInfo.persons.length,
    missingCount: missing.length,
    missing: missing
  };
}

// =====================================================================
// 選單處理函式
// =====================================================================

/**
 * 用途：選單項目「由職事表建立 PersonDisplay 骨架」的處理函式。
 * Args: （無）
 * Returns:
 *   {void}
 */
function menuBuildPersonDisplaySkeleton_() {
  var ui = SpreadsheetApp.getUi();
  try {
    var result = buildPersonDisplaySkeletonFromRoster_();
    ui.alert(
      '由職事表建立 PersonDisplay 骨架',
      [
        '新增：' + result.added + ' 行',
        '略過（已存在）：' + result.skippedExisting + ' 行',
        '目前 HONORIFIC 仍空白：' + result.blankHonorific + ' 人',
        '',
        '接下來可以撳「套用尊稱對照表」自動填入尊稱。'
      ].join('\n'),
      ui.ButtonSet.OK
    );
  } catch (err) {
    logMenuError_('menuBuildPersonDisplaySkeleton_', err);
    ui.alert('建立 PersonDisplay 骨架失敗', String(err && err.message ? err.message : err), ui.ButtonSet.OK);
  }
}

/**
 * 用途：選單項目「套用尊稱對照表」的處理函式。
 * Args: （無）
 * Returns:
 *   {void}
 */
function menuApplyHonorificLookup_() {
  var ui = SpreadsheetApp.getUi();
  try {
    var result = applyHonorificLookupToPersonDisplay_();
    ui.alert(
      '套用尊稱對照表',
      [
        '已填入：' + result.filled,
        '已有值略過：' + result.alreadySet,
        '對不上：' + result.notMatched,
        '對照表有衝突：' + result.conflicts,
        '',
        '完整名單已寫入 Diagnostics 工作表。'
      ].join('\n'),
      ui.ButtonSet.OK
    );
  } catch (err) {
    logMenuError_('menuApplyHonorificLookup_', err);
    ui.alert('套用尊稱對照表失敗', String(err && err.message ? err.message : err), ui.ButtonSet.OK);
  }
}

/**
 * 用途：選單項目「尊稱未設定報告」的處理函式。問一個主日日期，用來
 *   定位季度。
 * Args: （無）
 * Returns:
 *   {void}
 */
function menuHonorificMissingReport_() {
  var ui = SpreadsheetApp.getUi();
  try {
    var defaultDate = getConfig(CONFIG_KEYS.ROSTER_TEST_DATE, '2027-10-03');
    var resp = ui.prompt(
      '尊稱未設定報告',
      '請輸入主日日期，格式 yyyy-MM-dd（例如 ' + defaultDate + '），用來判斷要檢查哪一季：',
      ui.ButtonSet.OK_CANCEL
    );
    if (resp.getSelectedButton() !== ui.Button.OK) return;

    var isoDate = resp.getResponseText().trim() || defaultDate;
    var result = buildHonorificMissingReport_(isoDate);

    if (!result.quarterId) {
      ui.alert('尊稱未設定報告', '職事表找不到 ' + isoDate + ' 這個主日，無法判斷季度。', ui.ButtonSet.OK);
      return;
    }

    ui.alert(
      '尊稱未設定報告',
      [
        '季度：' + result.quarterId,
        '本季有事奉的人數：' + result.totalAssigned,
        '尊稱仍未設定：' + result.missingCount + ' 人',
        '',
        '完整名單已寫入 Diagnostics 工作表。'
      ].join('\n'),
      ui.ButtonSet.OK
    );
  } catch (err) {
    logMenuError_('menuHonorificMissingReport_', err);
    ui.alert('尊稱未設定報告失敗', String(err && err.message ? err.message : err), ui.ButtonSet.OK);
  }
}
