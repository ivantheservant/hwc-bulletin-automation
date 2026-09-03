/**
 * GoLive.gs
 *
 * R-037 §2.1：**上線前檢查**——一次過答一條問題：
 * 「**今日可不可以真的上線？**」
 *
 * ⚠️ 這一組刻意與「完成度自我檢測」分開，因為兩者答的是不同的問題：
 *
 *   | 檢查 | 答的問題 |
 *   |---|---|
 *   | 完成度自我檢測 | 系統設定齊不齊、資料填得夠不夠 |
 *   | 上線前檢查 | 今日可不可以真的開機給會眾用 |
 *
 * 同一個系統可以「設定齊全」但「未可以上線」——例如仍然是測試模式、
 * 預覽網址未填、星期一觸發器裝了兩個。兩條問題混在一齊，就會出現
 * 「全綠但仍然唔敢開」。
 *
 * ⚠️ 全程**唯讀**：只讀 Config、工作表、觸發器清單，一格都不會寫。
 */

'use strict';

// =====================================================================
// 上線前檢查（R-037 §2.1）
// =====================================================================

/**
 * 用途：一次過跑完「上線前檢查」那八項，逐項回 🟢／🟡／🔴。
 *
 *   ⚠️ 這一組與「完成度自我檢測」的其餘項目分開，因為它們答的是**另一條
 *   問題**：不是「系統設定齊不齊」，而是「**今日可不可以真的上線**」。
 *   同一個系統可以「設定齊全」但「未可以上線」（例如仍然是測試模式、
 *   預覽網址未填）。兩條問題混在一齊，就會出現「全綠但仍然唔敢開」。
 *
 *   ⚠️ `DRY_RUN=TRUE` 報 🟡 而不是 🔴：測試模式本身沒有壞，只是**未上線**。
 *   反過來 `FALSE` 報 🟢 亦不代表「應該」是 FALSE——這一項只答「而家係邊個
 *   模式」，決定權在人。
 * Args: （無）
 * Returns:
 *   {{label:string, status:string, message:string}[]}
 */
function buildGoLiveChecklist_() {
  var S = SELF_CHECK_STATUS_;
  var items = [];

  // ---- 1. Recipients 齊備 CC、DB、IT ----
  var byGroup = {};
  try {
    readSheet(SHEETS.RECIPIENTS).forEach(function (r) {
      if (r.ACTIVE !== true) return;
      var g = String(r.GROUP_NAME || '').trim().toUpperCase();
      if (g) byGroup[g] = (byGroup[g] || 0) + 1;
    });
  } catch (err) {
    byGroup = {};
  }
  var wantedGroups = ['CC', 'DB', 'IT'];
  var missingGroups = wantedGroups.filter(function (g) { return !byGroup[g]; });
  items.push({
    label: '上線前：Recipients 齊備 CC／DB／IT',
    status: missingGroups.length === 0 ? S.GREEN : S.YELLOW,
    message: missingGroups.length === 0
      ? ('三組都有人：' + wantedGroups.map(function (g) { return g + ' ' + byGroup[g] + ' 人'; }).join('、') + '。')
      : ('缺少 ' + missingGroups.join('、') + ' 組（R-029）。目前：'
        + (Object.keys(byGroup).length > 0
          ? Object.keys(byGroup).sort().map(function (g) { return g + ' ' + byGroup[g] + ' 人'; }).join('、')
          : '一組都沒有'))
  });

  // ---- 2. DRY_RUN 現值 ----
  var dryRun = normalizeBoolean_(getConfig(CONFIG_KEYS.DRY_RUN, 'TRUE')) === true;
  items.push({
    label: '上線前：寄送模式',
    status: dryRun ? S.YELLOW : S.GREEN,
    message: dryRun
      ? '⚠️ 測試模式（DRY_RUN=TRUE）：**不會真的寄出任何郵件**，只會寫 SendLog。'
        + '正式上線之前要記得改成 FALSE。'
      : '正式模式（DRY_RUN=FALSE）：郵件會真的寄出。'
  });

  // ---- 3. PREVIEW_WEBAPP_URL 已填 ----
  var previewUrl = String(getConfig(CONFIG_KEYS.PREVIEW_WEBAPP_URL, '') || '').trim();
  items.push({
    label: '上線前：草稿預覽網址',
    status: previewUrl ? S.GREEN : S.YELLOW,
    message: previewUrl
      ? '已填。星期一寄出的預覽連結會用這一條。'
      : '⚠️ Config 的 ' + CONFIG_KEYS.PREVIEW_WEBAPP_URL + ' 未填。'
        + '系統會退回用 ScriptApp 自己取，但**那一支在觸發器情境下有機會取不到**'
        + '（而星期一寄信正正是觸發器情境），取不到就不會寄預覽信。'
        + '請在「部署 ▸ 管理部署作業」複製網頁應用程式網址填進去。'
  });

  // ---- 4. 星期一觸發器只安裝了一個 ----
  var triggerCount = null;
  try {
    triggerCount = ScriptApp.getProjectTriggers().filter(function (t) {
      return t.getHandlerFunction() === 'weeklyBulletinSendTrigger_';
    }).length;
  } catch (err) {
    triggerCount = null;
  }
  if (triggerCount === null) {
    items.push({
      label: '上線前：星期一觸發器',
      status: S.YELLOW,
      message: '讀不到觸發器清單（可能未授權）。⚠️ 「讀不到」不等於「沒問題」。'
    });
  } else if (triggerCount === 1) {
    items.push({ label: '上線前：星期一觸發器', status: S.GREEN, message: '剛好安裝了 1 個。' });
  } else if (triggerCount === 0) {
    items.push({
      label: '上線前：星期一觸發器', status: S.YELLOW,
      message: '一個都沒有安裝——星期一不會自動寄週報。請撳選單「安裝自動寄送觸發器」。'
    });
  } else {
    items.push({
      label: '上線前：星期一觸發器', status: S.RED,
      message: '⚠️ 安裝了 ' + triggerCount + ' 個！每一個都會各自跑一次，'
        + '即是同一期週報會寄 ' + triggerCount + ' 次給全教會。'
        + '請撳選單「移除自動寄送觸發器」再撳一次「安裝自動寄送觸發器」。'
    });
  }

  // ---- 5. 正式 master ≠ 沙盒 master ----
  //    ⚠️ 與 I12／自我檢測共用同一支 checkMasterFileIdsDistinct_()，
  //    不在這裏再寫一次判斷——寫兩次遲早會分岔。
  var distinct = checkMasterFileIdsDistinct_();
  items.push({
    label: '上線前：正式與沙盒 master 檔案',
    status: distinct.ok === false ? S.RED : (distinct.ok === null ? S.YELLOW : S.GREEN),
    message: distinct.message
  });

  // ---- 6. ErrorLog 最近 7 日的錯誤數 ----
  var recentErrors = countRecentErrorLogRows_(7);
  items.push({
    label: '上線前：最近 7 日的錯誤',
    status: recentErrors.count > 0 ? S.YELLOW : S.GREEN,
    message: recentErrors.count > 0
      ? ('⚠️ ErrorLog 最近 7 日有 ' + recentErrors.count + ' 筆錯誤，最新一筆：'
        + recentErrors.latestSummary + '　上線之前請逐筆看一次。')
      : '最近 7 日沒有錯誤紀錄。'
  });

  // ---- 7. 工作表保護張數 ----
  var protection = countProtectedSheets_();
  items.push({
    label: '上線前：工作表保護',
    status: protection.ok === null ? S.YELLOW
      : (protection.protected >= protection.wanted ? S.GREEN : S.YELLOW),
    message: protection.message
  });

  // ---- 8. 沙盒季度不在使用者可見範圍 ----
  items.push(buildSandboxVisibilityItem_(S));

  return items;
}

/**
 * 用途：數 `ErrorLog` 最近 N 日有幾多筆。
 * Args:
 *   days {number} 最近幾多日。
 * Returns:
 *   {{count:number, latestSummary:string}}
 */
function countRecentErrorLogRows_(days) {
  var n = Number(days);
  if (!isFinite(n) || n < 1) n = 7;
  var cutoffMs = new Date().getTime() - (n * 24 * 60 * 60 * 1000);

  var rows = [];
  try {
    rows = readSheet(SHEETS.ERROR_LOG);
  } catch (err) {
    return { count: 0, latestSummary: '（讀不到 ErrorLog）' };
  }

  var recent = rows.filter(function (r) {
    var at = r.TIMESTAMP;
    if (Object.prototype.toString.call(at) !== '[object Date]') return false;
    return at.getTime() >= cutoffMs;
  });
  if (recent.length === 0) return { count: 0, latestSummary: '' };

  var latest = recent[recent.length - 1];
  return {
    count: recent.length,
    latestSummary: String(latest.ERROR_CODE || '') + '　'
      + String(latest.MESSAGE || '').slice(0, 60)
  };
}

/**
 * 用途：數目前有幾多張工作表真的設了保護。
 *
 *   ⚠️ 讀不到保護設定時回 `ok:null`（驗證不到），**不是回 0**：
 *   「讀不到」與「一張都沒有保護」是兩件完全不同的事。
 * Args: （無）
 * Returns:
 *   {{ok:(boolean|null), protected:number, wanted:number, message:string}}
 */
function countProtectedSheets_() {
  var wantedNames = protectedSheetNames_();
  var wanted = wantedNames.length;

  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var done = 0;
    var missing = [];
    wantedNames.forEach(function (name) {
      var sheet = ss.getSheetByName(name);
      if (!sheet) { missing.push(name + '（沒有這一張）'); return; }
      var protections = sheet.getProtections(SpreadsheetApp.ProtectionType.SHEET) || [];
      if (protections.length > 0) done++;
      else missing.push(name);
    });

    return {
      ok: done >= wanted,
      protected: done,
      wanted: wanted,
      message: done >= wanted
        ? ('應該受保護的 ' + wanted + ' 張全部已設定保護。')
        : ('⚠️ ' + done + '／' + wanted + ' 張已設定保護，未設定的：'
          + missing.slice(0, 8).join('、')
          + (missing.length > 8 ? ('　（另有 ' + (missing.length - 8) + ' 張）') : '')
          + '　請撳選單「設定工作表保護」。')
    };
  } catch (err) {
    return {
      ok: null, protected: 0, wanted: wanted,
      message: '讀不到工作表保護設定（' + ((err && err.message) ? err.message : String(err))
        + '）。⚠️ 「讀不到」不等於「一張都沒有保護」。'
    };
  }
}

/**
 * 用途：「沙盒季度不在使用者可見範圍」那一項。
 *
 *   ⚠️ 報 🔴 不是 🟡：沙盒季度出現在幹事的季度下拉，等於叫人去填一批
 *   自測機隨時會清走的假資料。那不是「有機會混亂」，是「一定會做白工」。
 * Args:
 *   statuses {Object} `SELF_CHECK_STATUS_`。
 * Returns:
 *   {{label:string, status:string, message:string}}
 */
function buildSandboxVisibilityItem_(statuses) {
  var label = '上線前：沙盒季度不在使用者可見範圍';
  var sandbox = String(getConfig(CONFIG_KEYS.SELFTEST_QUARTER_ID, '') || '').trim();

  if (!sandbox) {
    return {
      label: label, status: statuses.YELLOW,
      message: 'Config 的 ' + CONFIG_KEYS.SELFTEST_QUARTER_ID + ' 是空的，所以比不到。'
        + '⚠️ 「比不到」不等於「沒問題」。'
    };
  }

  var rows = [];
  try {
    rows = readSheet(SHEETS.BULLETIN_WEEKS);
  } catch (err) {
    return {
      label: label, status: statuses.YELLOW,
      message: '讀不到 ' + SHEETS.BULLETIN_WEEKS + '，所以比不到。'
    };
  }

  // ⚠️ 用**使用者真正看到的那一支**去驗，不是自己再寫一次篩選——
  //    自己寫一次的話，驗的是「我以為的規則」，不是「畫面實際的行為」。
  var quarterIds = rows.map(function (r) { return String(r.QUARTER_ID || '').trim(); });
  var flags = quarterArchivedFlags_(rows);
  var visibleAll = visibleQuarterList_(quarterIds, flags, true, sandbox);
  var leaked = visibleAll.filter(function (q) { return q.quarterId === sandbox; });

  if (leaked.length > 0) {
    return {
      label: label, status: statuses.RED,
      message: '⚠️ 沙盒季度「' + sandbox + '」竟然出現在使用者的季度下拉。'
        + '那一季的資料自測機隨時會清走——幹事在那裏填任何東西都是做白工。'
        + '請檢查 visibleQuarterList_()（src/Retention.gs）。'
    };
  }
  return {
    label: label, status: statuses.GREEN,
    message: '沙盒季度「' + sandbox + '」不會出現在使用者的季度下拉（勾了「顯示已封存」都不會）。'
  };
}

/**
 * 用途：選單「上線前檢查（唯讀）」。
 * Returns:
 *   {void}
 */
function menuRunGoLiveCheck_() {
  var ui = SpreadsheetApp.getUi();
  try {
    var items = buildGoLiveChecklist_();
    var S = SELF_CHECK_STATUS_;
    var red = items.filter(function (i) { return i.status === S.RED; });
    var yellow = items.filter(function (i) { return i.status === S.YELLOW; });

    // ⚠️ 排行那一段抽咗去 buildGoLiveReportLines_()（src/QuarterOps.gs）：
    //    填寫介面要回傳同一批行。兩邊各排一次的話，兩份報告會慢慢長成
    //    不同樣子，而看的人以為自己看的是同一份。
    //    ⚠️ 寫 Diagnostics 只有選單這一邊做——Diagnostics 每次清空重寫，
    //    填寫介面撳一下就會把 IT 剛跑完的診斷報告清走。
    writeDiagnosticsReport_('上線前檢查', buildGoLiveReportLines_(items));

    ui.alert('上線前檢查',
      '🔴 ' + red.length + ' 項、🟡 ' + yellow.length + ' 項、🟢 '
        + (items.length - red.length - yellow.length) + ' 項。\n\n'
        + (red.length > 0
          ? ('必須先處理：\n' + red.map(function (i) { return '　' + i.label; }).join('\n') + '\n\n')
          : '')
        + '完整報告已寫入 Diagnostics 工作表。\n'
        + '⚠️ 這一次檢查全部都是唯讀，一格都沒有寫。',
      ui.ButtonSet.OK);
  } catch (err) {
    logMenuError_('menuRunGoLiveCheck_', err);
    ui.alert('上線前檢查失敗', enrichAuthError_(err), ui.ButtonSet.OK);
  }
}
