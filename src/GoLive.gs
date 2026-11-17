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
 * 用途：一次過跑完「上線前檢查」各項（現在十七項），逐項回 🟢／🟡／🔴。
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
    readSheet_(SHEETS.RECIPIENTS).forEach(function (r) {
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
  // 獨立審查 A-02：DRY_RUN 空白、寫錯、讀不到一律當試行（不寄），而且要報紅燈——不清楚的設定不可以報「正式模式」。
  var dryRunState = dryRunConfigState_();
  var dryRunUnclear = dryRunState.state === 'BLANK' || dryRunState.state === 'INVALID' || dryRunState.state === 'UNREADABLE';
  items.push({
    label: '上線前：寄送模式',
    status: dryRunUnclear ? S.RED : (dryRunState.dryRun ? S.YELLOW : S.GREEN),
    message: dryRunUnclear
      ? ('❌ Config 的 DRY_RUN '
        + (dryRunState.state === 'INVALID' ? '是「' + dryRunState.raw + '」，不是 TRUE 或 FALSE'
          : (dryRunState.state === 'UNREADABLE' ? '讀不到' : '是空白'))
        + '：系統一律當作測試模式，不會真的寄出任何郵件。請明確填 TRUE（測試）或 FALSE（正式）。')
      : (dryRunState.dryRun
        ? '⚠️ 測試模式（DRY_RUN=TRUE）：不會真的寄出任何郵件，只會寫 SendLog。'
          + '正式上線之前要記得改成 FALSE。'
        : '正式模式（DRY_RUN=FALSE）：郵件會真的寄出。')
  });

  // ---- 3. PREVIEW_WEBAPP_URL 已填 ----
  var previewUrl = String(getConfig_(CONFIG_KEYS.PREVIEW_WEBAPP_URL, '') || '').trim();
  items.push({
    label: '上線前：草稿預覽網址',
    status: previewUrl ? S.GREEN : S.YELLOW,
    message: previewUrl
      ? '已填。星期一寄出的預覽連結會用這一條。'
      : '⚠️ Config 的 ' + CONFIG_KEYS.PREVIEW_WEBAPP_URL + ' 未填。'
        + '系統會退回用 ScriptApp 自己取，但那一支在觸發器情境下有機會取不到'
        + '（而星期一寄信正正是觸發器情境），取不到就不會寄預覽信。'
        + '請在「部署 ▸ 管理部署作業」複製網頁應用程式網址填進去。'
  });

  // ---- 4. 星期一觸發器只安裝了一個；4b. 其他觸發器 ----
  //    ⚠️ 內容表 v2：判斷一律按 src/TriggerInventory.gs 的預期清單（與「完成度自我檢測」、
  //    「查看觸發器狀態」同一個來源），不在這裏再寫一次。
  var triggerReport = inspectProjectTriggers_();
  var weekly = triggerReport.items.filter(function (t) { return t.handler === 'weeklyBulletinSendTrigger_'; })[0];
  items.push({ label: '上線前：星期一觸發器', status: weekly.status, message: weekly.message });
  items.push(buildGoLiveOtherTriggersItem_(triggerReport, S));

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

  // ---- 9. 講員表格（內容表 v2 起已停用：檢的是提交觸發器 0 個、表格已停止收件）----
  //    ⚠️ 與「完成度自我檢測」共用同一支 buildSpeakerFormCheckItem_()，不在這裏
  //    再寫一次判斷。
  var speakerVerdict = buildSpeakerFormCheckItem_(inspectSpeakerFormState_(), S);
  items.push({ label: '上線前：講員表格', status: speakerVerdict.status, message: speakerVerdict.message });

  // ---- 10. 內容表版本（內容表 v2，審查 F8）：仍有主日未過的季度，內容表是否已經移轉成新版 ----
  //    ⚠️ 與「完成度自我檢測」共用同一支 inspectContentSheetVersions_()／buildContentSheetVersionItem_()。
  var versionVerdict = buildContentSheetVersionItem_(inspectContentSheetVersions_(), S);
  items.push({ label: '上線前：內容表版本', status: versionVerdict.status, message: versionVerdict.message });

  // ---- 11. v3：現在自動建立的話會建立哪幾季（與真正建立共用 buildAutoCreateQuartersPlanNow_()）----
  items.push(buildAutoCreateQuartersGoLiveItem_(S));

  // ---- 12. v3：測試用的「模擬今日」要在正式使用前清空（填了就只可以發佈／寄出模擬那一週）----
  var simulated = String(getConfig_(CONFIG_KEYS.WEBAPP_SIMULATED_TODAY, '') || '').trim();
  items.push({
    label: '上線前：模擬今日（測試設定）',
    // v3 重測（獨立審查）：紅色——模擬今日亦影響自動建立季度、預覽連結與打開時落在哪一週，忘記清空會靜靜出錯。
    status: simulated ? S.RED : S.GREEN,
    message: simulated
      ? '⚠️ Config 的 ' + CONFIG_KEYS.WEBAPP_SIMULATED_TODAY + ' 是「' + simulated + '」：填寫介面當今日是這一天——'
        + '只可以發佈、寄出那一週，打開時落在那一週，自動建立季度與預覽連結（不帶日期那一條）亦按這一日計（星期一自動寄送不受影響）。正式使用前一定要清空。'
      : '未填：填寫介面與自動建立季度用真正的今日。'
  });

  // ---- 13 至 16. R-058（2026-11-17）：寄送名單、測試名單、測試季度、時區一致 ----
  buildGoLiveSafetyItems_(S).forEach(function (item) { items.push(item); });

  return items;
}

/**
 * 用途：今日或以後仍然有主日的季度，逐季核對內容表第 2 行與舊分頁（與匯入同一支
 *   `checkQuarterContentSheetSchema_()`）。唯讀：只開內容表讀第 2 行，一格都不寫。
 * Args: （無）
 * Returns:
 *   {{ok:boolean, error:string, checked:string[],
 *     problems:{quarterId:string, reason:string}[]}}
 *     `ok:false`＝讀不到 BulletinWeeks（不知道要核對哪幾季）。某一季開不到內容表或讀失敗，記入
 *     `problems`（`reason:'UNREADABLE'`），不當成正常。
 * Raises:
 *   （無）
 */
function inspectContentSheetVersions_() {
  var out = { ok: true, error: '', checked: [], problems: [] };
  var lastDateByQuarter = {};
  var todayIso;
  try {
    var timezone = getConfig_(CONFIG_KEYS.SYS_TIMEZONE, 'Pacific/Auckland');
    todayIso = Utilities.formatDate(new Date(), timezone, 'yyyy-MM-dd');
    readSheet_(SHEETS.BULLETIN_WEEKS).forEach(function (w) {
      var q = String(w.QUARTER_ID || '').trim();
      var iso = fieldOverrideIsoOf_(w.SERVICE_DATE);
      if (!q || !iso) return;
      if (!lastDateByQuarter[q] || iso > lastDateByQuarter[q]) lastDateByQuarter[q] = iso;
    });
  } catch (err) {
    return { ok: false, error: '讀不到週報資料：' + ((err && err.message) ? err.message : String(err)), checked: [], problems: [] };
  }
  try {
    readSheet_(SHEETS.CONTENT_SHEETS);
  } catch (err) {
    // ContentSheets 工作表讀不到（例如未按「初始化工作表」）：不知道各季內容表在哪裏，不可以當成「開不到」逐季報。
    return { ok: false, error: '讀不到 ContentSheets 工作表：' + ((err && err.message) ? err.message : String(err)), checked: [], problems: [] };
  }
  Object.keys(lastDateByQuarter).sort().forEach(function (q) {
    if (lastDateByQuarter[q] < todayIso) return;
    out.checked.push(q);
    try {
      // 審查第二輪 1：ContentSheets 有登記、但檔案開不到（被刪、搬走、沒有權限）不可以當成正常。
      //    `checkQuarterContentSheetSchema_()` 遇到開不到會回 ok（那是匯入自己會講的情況），所以先在這裏分開。
      var row = findContentSheetRow_(q);
      if (!row) return;
      var spreadsheet = openContentSpreadsheet_(row.FILE_ID);
      if (!spreadsheet) {
        out.problems.push({ quarterId: q, reason: 'UNREADABLE' });
        return;
      }
      var check = checkContentSheetSchema_(spreadsheet);
      if (!check.ok) out.problems.push({ quarterId: q, reason: check.reason });
    } catch (err) {
      out.problems.push({ quarterId: q, reason: 'UNREADABLE' });
    }
  });
  return out;
}

/**
 * 用途：「內容表版本」一項的燈色與說明。純函式；上線前檢查與完成度自我檢測共用。
 * Args:
 *   state {Object} `inspectContentSheetVersions_()` 的輸出。
 *   S {Object} `SELF_CHECK_STATUS_`。
 * Returns:
 *   {{status:string, message:string}}
 * Raises:
 *   （無）
 */
function buildContentSheetVersionItem_(state, S) {
  if (!state.ok) {
    return { status: S.YELLOW, message: '核對不到（' + state.error + '）。⚠️ 「讀不到」不等於「沒問題」；請按一次「初始化工作表」再看。' };
  }
  if (state.checked.length === 0) {
    return { status: S.GREEN, message: '沒有仍未過完的季度，不用核對。' };
  }
  if (state.problems.length === 0) {
    return { status: S.GREEN, message: '已核對 ' + state.checked.join('、') + '：內容表都是新版（或者未建立）。' };
  }
  var pick = function (reason) {
    return state.problems.filter(function (p) { return p.reason === reason; }).map(function (p) { return p.quarterId; });
  };
  var outdated = pick('CONTENT_SHEET_OUTDATED');
  var changed = pick('CONTENT_SHEET_HEADER_CHANGED');
  var unreadable = pick('UNREADABLE');
  var which = function (list) { return list.join('、') + (list.length > 1 ? '（這幾季）' : '（這一季）'); };
  var parts = [];
  if (outdated.length > 0) {
    parts.push(which(outdated) + '的內容表是舊版，未移轉：從內容表匯入、「重設這一週」都會被整次拒絕。'
      + '請在填寫介面打開那一季任何一個主日，按內容表狀態列的「更新本季內容表…」，先看預覽再確定。');
  }
  if (changed.length > 0) {
    parts.push(which(changed) + '的內容表第 2 行（機器鍵）被改過：匯入會被整次拒絕。請把第 2 行改回原樣'
      + '（檔案 ▸ 版本記錄），再按一次「更新本季內容表…」（或者試算表選單「內容表 ▸ 建立本季內容表」）。');
  }
  if (unreadable.length > 0) {
    parts.push(which(unreadable) + '的內容表開不到（檔案可能被刪、搬走，或者這個帳戶沒有權限）：請在填寫介面'
      + '按內容表狀態列的「開啟內容表」核對；確定不要了，請 IT 處理 ContentSheets 那一行。');
  }
  return { status: S.YELLOW, message: '⚠️ ' + parts.join('　') };
}

/**
 * 用途：「上線前：其他觸發器」一項：星期一觸發器以外的預期清單（Config 人手改動稽核＝1、
 *   兩個已停用的＝0）加上清單以外的觸發器。取最差的狀態，逐項列出不是 🟢 的原因。純函式。
 * Args:
 *   report {Object} `inspectProjectTriggers_()` 的輸出。
 *   S {Object} `SELF_CHECK_STATUS_`。
 * Returns:
 *   {{label:string, status:string, message:string}}
 * Raises:
 *   （無）
 */
function buildGoLiveOtherTriggersItem_(report, S) {
  var others = report.items.filter(function (t) { return t.handler !== 'weeklyBulletinSendTrigger_'; });
  var verdicts = others.map(function (t) { return { label: t.label, status: t.status, message: t.message }; });
  var unknown = buildUnknownTriggersVerdict_(report, S);
  if (unknown) verdicts.push({ label: '不在預期清單內', status: unknown.status, message: unknown.message });

  var rank = {};
  rank[S.GREEN] = 0;
  rank[S.YELLOW] = 1;
  rank[S.RED] = 2;
  var worst = verdicts.reduce(function (acc, v) { return rank[v.status] > rank[acc] ? v.status : acc; }, S.GREEN);
  if (worst === S.GREEN) {
    return {
      label: '上線前：其他觸發器', status: S.GREEN,
      message: others.map(function (t) { return t.label + ' ' + t.actual + ' 個'; }).join('；') + '，全部與預期相符。'
    };
  }
  return {
    label: '上線前：其他觸發器', status: worst,
    message: verdicts.filter(function (v) { return v.status !== S.GREEN; })
      .map(function (v) { return v.label + '：' + v.message; }).join('　')
  };
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
    rows = readSheet_(SHEETS.ERROR_LOG);
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
          + '　請按選單「設定工作表保護」。')
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
  var label = '上線前：沙盒季度不在用戶可見範圍';
  var sandbox = String(getConfig_(CONFIG_KEYS.SELFTEST_QUARTER_ID, '') || '').trim();

  if (!sandbox) {
    return {
      label: label, status: statuses.YELLOW,
      message: 'Config 的 ' + CONFIG_KEYS.SELFTEST_QUARTER_ID + ' 是空的，所以比不到。'
        + '⚠️ 「比不到」不等於「沒問題」。'
    };
  }

  var rows = [];
  try {
    rows = readSheet_(SHEETS.BULLETIN_WEEKS);
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
      message: '⚠️ 沙盒季度「' + sandbox + '」竟然出現在用戶的季度下拉。'
        + '那一季的資料自測機隨時會清走——幹事在那裏填任何東西都是做白工。'
        + '請檢查 visibleQuarterList_()（src/Retention.gs）。'
    };
  }
  return {
    label: label, status: statuses.GREEN,
    message: '沙盒季度「' + sandbox + '」不會出現在用戶的季度下拉（勾了「顯示已封存」都不會）。'
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

// =====================================================================
// R-058（2026-11-17）：上線前檢查加四項——寄送名單、測試名單、測試季度、時區一致
// =====================================================================

/**
 * 用途：真正的今日（Config `SYS_TIMEZONE`；**不看**模擬今日），供「上線前檢查」與封存使用。
 * Args:
 *   todayIso {string=} 測試的注入點（yyyy-MM-dd）；正式流程不傳。
 * Returns:
 *   {{todayIso:string, reason:string}} 讀不到時 `todayIso` 是空字串、`reason` 講原因。
 * Raises:
 *   （無）
 */
function realTodayIso_(todayIso) {
  var injected = String(todayIso || '').trim();
  if (injected) return { todayIso: injected, reason: '' };
  try {
    return {
      todayIso: Utilities.formatDate(new Date(), getConfig_(CONFIG_KEYS.SYS_TIMEZONE, 'Pacific/Auckland'), 'yyyy-MM-dd'),
      reason: ''
    };
  } catch (err) {
    return { todayIso: '', reason: '讀不到今日日期（Config SYS_TIMEZONE 可能有誤）：' + ((err && err.message) ? err.message : String(err)) };
  }
}

/**
 * 用途：Recipients 內「今日生效而且電郵格式合法」的收件人電郵（不分大小寫去重，保留第一次出現的寫法）。
 * Args:
 *   todayIso {string} 判斷 `EFFECTIVE_FROM`／`EFFECTIVE_TO` 用。
 * Returns:
 *   {string[]}
 * Raises:
 *   Error 讀 Recipients 失敗時原樣拋出（呼叫方當作核對不到）。
 */
function effectiveRecipientEmails_(todayIso) {
  var today = /^\d{4}-\d{2}-\d{2}$/.test(String(todayIso || '')) ? normalizeDate_(todayIso) : null;
  var seen = {};
  var out = [];
  readSheet_(SHEETS.RECIPIENTS).forEach(function (r) {
    if (r.ACTIVE !== true) return;
    if (!isRecipientEffective_(r, today)) return;
    var email = String(r.EMAIL || '').trim();
    if (!isValidEmailShape_(email)) return;
    var key = email.toLowerCase();
    if (seen[key]) return;
    seen[key] = true;
    out.push(email);
  });
  return out;
}

/**
 * 用途：收集「寄送名單」與「測試名單」兩項要用的現況：寄送名單（`EMAIL_ALLOWLIST`，空白＝不限制）、`DRY_RUN`、
 *   今日生效的收件人電郵。唯讀。
 * Args:
 *   todayIso {string=} 測試的注入點。
 * Returns:
 *   {{ok:boolean, error:string, allowlist:?string[], dryRun:boolean, emails:string[], blocked:string[]}}
 *     `ok:false`＝讀不到 Recipients。`blocked` 是不在寄送名單內的收件人（名單空白時是空陣列）。
 * Raises:
 *   （無）
 */
function inspectEmailRecipientState_(todayIso) {
  var dryRun = isDryRun_();
  var emails;
  try {
    emails = effectiveRecipientEmails_(realTodayIso_(todayIso).todayIso);
  } catch (err) {
    return { ok: false, error: (err && err.message) ? err.message : String(err), allowlist: null, dryRun: dryRun, emails: [], blocked: [] };
  }
  var allowlist = readEmailAllowlist_();
  var blocked = allowlist
    ? emails.filter(function (e) { return allowlist.indexOf(emailAddressOf_(e)) === -1; })
    : [];
  return { ok: true, error: '', allowlist: allowlist, dryRun: dryRun, emails: emails, blocked: blocked };
}

/**
 * 用途：「寄送名單」一項的燈色與說明。純函式。
 *   寄送名單（`EMAIL_ALLOWLIST`）非空白時，算 Recipients 生效收件人有幾個不在名單：
 *   `DRY_RUN=FALSE` 而有人被擋＝🔴；`DRY_RUN=TRUE` 而有人被擋＝🟡（上線前要加上或清空）；其餘🟢。
 * Args:
 *   state {Object} `inspectEmailRecipientState_()` 的輸出。
 *   S {Object} `SELF_CHECK_STATUS_`。
 * Returns:
 *   {{label:string, status:string, message:string}}
 */
function buildEmailAllowlistGoLiveItem_(state, S) {
  var label = '上線前：寄送名單';
  if (!state.ok) {
    return { label: label, status: S.YELLOW, message: '核對不到（讀不到 Recipients：' + state.error + '）。⚠️ 「讀不到」不等於「沒問題」。' };
  }
  if (!state.allowlist) {
    return { label: label, status: S.GREEN, message: 'Config ' + CONFIG_KEYS.EMAIL_ALLOWLIST + ' 是空白＝不限制，所有生效的收件人（' + state.emails.length + ' 人）都會收到。' };
  }
  if (state.blocked.length === 0) {
    return { label: label, status: S.GREEN, message: '寄送名單有 ' + state.allowlist.length + ' 個地址；Recipients 生效的 ' + state.emails.length + ' 人全部在名單內。' };
  }
  var listed = state.blocked.slice(0, 5).join('、') + (state.blocked.length > 5 ? '　等 ' + state.blocked.length + ' 人' : '');
  if (state.dryRun) {
    return {
      label: label, status: S.YELLOW,
      message: '⚠️ Recipients 生效的 ' + state.emails.length + ' 人之中有 ' + state.blocked.length + ' 人不在寄送名單（' + listed
        + '）。現在是測試模式，不會真的寄；上線之前要把他們加進 Config ' + CONFIG_KEYS.EMAIL_ALLOWLIST + '，或者把它清空（＝不限制）。'
    };
  }
  return {
    label: label, status: S.RED,
    message: '⚠️ 正式模式（DRY_RUN=FALSE），但 Recipients 生效的 ' + state.emails.length + ' 人之中有 ' + state.blocked.length
      + ' 人不在寄送名單（' + listed + '）：他們不會收到任何郵件。請加進 Config ' + CONFIG_KEYS.EMAIL_ALLOWLIST + '，或者把它清空（＝不限制）。'
  };
}

/**
 * 用途：「測試名單」一項的燈色與說明。純函式。Recipients 生效行的電郵全部是同一個地址（或者一個生效的都沒有）
 *   ＝🟡「看來仍是測試名單」；其餘🟢。
 * Args:
 *   state {Object} `inspectEmailRecipientState_()` 的輸出。
 *   S {Object} `SELF_CHECK_STATUS_`。
 * Returns:
 *   {{label:string, status:string, message:string}}
 */
function buildTestRecipientsGoLiveItem_(state, S) {
  var label = '上線前：收件人是否仍是測試名單';
  if (!state.ok) {
    return { label: label, status: S.YELLOW, message: '核對不到（讀不到 Recipients：' + state.error + '）。' };
  }
  if (state.emails.length === 0) {
    return { label: label, status: S.YELLOW, message: '⚠️ Recipients 沒有任何今日生效而且電郵格式合法的收件人，上線之後沒有人會收到郵件。' };
  }
  var distinct = {};
  state.emails.forEach(function (e) { distinct[e.toLowerCase()] = true; });
  if (Object.keys(distinct).length === 1) {
    return {
      label: label, status: S.YELLOW,
      message: '⚠️ Recipients 生效的收件人全部是同一個地址（' + state.emails[0] + '），看來仍是測試名單。上線前要換成真名單。'
    };
  }
  return { label: label, status: S.GREEN, message: 'Recipients 生效的收件人有 ' + Object.keys(distinct).length + ' 個不同的地址。' };
}

/**
 * 用途：找出「看來是測試季度」的季度：未封存、第一個主日比真正的今日遲超過
 *   `AUTO_CREATE_QUARTERS_LEAD_DAYS`＋92 日（`0`＝不限，當作 92 日）、不是沙盒季度。唯讀。
 * Args:
 *   todayIso {string=} 測試的注入點。
 * Returns:
 *   {{ok:boolean, error:string, todayIso:string, thresholdDays:number, quarters:{quarterId:string, firstIso:string}[]}}
 * Raises:
 *   （無）
 */
function inspectTestQuarters_(todayIso) {
  var today = realTodayIso_(todayIso);
  if (!today.todayIso) return { ok: false, error: today.reason, todayIso: '', thresholdDays: 0, quarters: [] };
  var rows;
  try {
    rows = readSheet_(SHEETS.BULLETIN_WEEKS);
  } catch (err) {
    return { ok: false, error: (err && err.message) ? err.message : String(err), todayIso: today.todayIso, thresholdDays: 0, quarters: [] };
  }
  var thresholdDays = autoCreateLeadDays_() + 92;
  var limitIso = addDaysToIsoDate_(today.todayIso, thresholdDays);
  var sandbox = String(getConfig_(CONFIG_KEYS.SELFTEST_QUARTER_ID, '') || '').trim();
  var archivedFlags = quarterArchivedFlags_(rows);
  var firstByQuarter = {};
  rows.forEach(function (r) {
    var qid = String(r.QUARTER_ID || '').trim();
    var iso = fieldOverrideIsoOf_(r.SERVICE_DATE);
    if (!qid || !iso) return;
    if (!firstByQuarter[qid] || iso < firstByQuarter[qid]) firstByQuarter[qid] = iso;
  });
  var quarters = Object.keys(firstByQuarter).sort().filter(function (qid) {
    if (sandbox && qid === sandbox) return false;
    if (archivedFlags[qid] === true) return false;
    return firstByQuarter[qid] > limitIso;
  }).map(function (qid) { return { quarterId: qid, firstIso: firstByQuarter[qid] }; });
  return { ok: true, error: '', todayIso: today.todayIso, thresholdDays: thresholdDays, quarters: quarters };
}

/**
 * 用途：「測試季度」一項的燈色與說明。純函式。有測試季度＝🟡，列出並建議用選單「封存指定季度…」。
 * Args:
 *   state {Object} `inspectTestQuarters_()` 的輸出。
 *   S {Object} `SELF_CHECK_STATUS_`。
 * Returns:
 *   {{label:string, status:string, message:string}}
 */
function buildTestQuartersGoLiveItem_(state, S) {
  var label = '上線前：測試季度';
  if (!state.ok) {
    return { label: label, status: S.YELLOW, message: '核對不到（' + state.error + '）。' };
  }
  if (state.quarters.length === 0) {
    return { label: label, status: S.GREEN, message: '沒有看來是測試的未封存季度（第一個主日不比今日遲過 ' + state.thresholdDays + ' 日）。' };
  }
  return {
    label: label, status: S.YELLOW,
    message: '⚠️ 以下未封存的季度，第一個主日比今日（' + state.todayIso + '）遲過 ' + state.thresholdDays + ' 日，看來是測試用的：'
      + state.quarters.map(function (q) { return q.quarterId + '（' + q.firstIso + '）'; }).join('、')
      + '。不再用的話，請按選單「封存指定季度…」收起（一格資料都不會刪，隨時可以取消封存）。'
  };
}

/**
 * 用途：收集「時區一致」要用的三個時區：試算表、指令碼、Config `SYS_TIMEZONE`。唯讀。
 * Args: （無）
 * Returns:
 *   {{spreadsheet:string, script:string, config:string}} 讀不到的是空字串。
 * Raises:
 *   （無）
 */
function inspectTimezoneConsistency_() {
  var spreadsheet = '';
  var script = '';
  try {
    spreadsheet = String(SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone() || '').trim();
  } catch (err) {
    spreadsheet = '';
  }
  try {
    script = String(Session.getScriptTimeZone() || '').trim();
  } catch (err2) {
    script = '';
  }
  var config = '';
  try {
    config = String(getConfig_(CONFIG_KEYS.SYS_TIMEZONE, '') || '').trim();
  } catch (err3) {
    config = '';
  }
  return { spreadsheet: spreadsheet, script: script, config: config };
}

/**
 * 用途：「時區一致」一項的燈色與說明。純函式；「上線前檢查」與「完成度自我檢測」共用這一支，不寫兩次。
 *   三者有任何不同＝🔴：由工作表讀出來的日期是用指令碼時區轉換的，三者不同，日期會跳一日（bug class 3、4）。
 *   讀不到任何一個＝🟡（核對不到不等於一致）。
 * Args:
 *   state {Object} `inspectTimezoneConsistency_()` 的輸出。
 *   S {Object} `SELF_CHECK_STATUS_`。
 * Returns:
 *   {{status:string, message:string}}
 */
function buildTimezoneCheckItem_(state, S) {
  var names = [['試算表', state.spreadsheet], ['指令碼', state.script], ['Config ' + CONFIG_KEYS.SYS_TIMEZONE, state.config]];
  var unreadable = names.filter(function (n) { return !n[1]; }).map(function (n) { return n[0]; });
  var summary = names.map(function (n) { return n[0] + '：' + (n[1] || '（讀不到）'); }).join('；');
  var known = names.filter(function (n) { return n[1]; }).map(function (n) { return n[1]; });
  var distinct = known.filter(function (v, i) { return known.indexOf(v) === i; });
  if (distinct.length > 1) {
    return {
      status: S.RED,
      message: '⚠️ 三個時區不一致（' + summary + '）。由工作表讀出來的日期會用指令碼時區轉換，不一致的話主日日期可能跳一日，'
        + '星期一自動流程亦可能選錯主日。請把三處改成同一個時區（試算表：檔案 ▸ 設定；指令碼：專案設定；Config：'
        + CONFIG_KEYS.SYS_TIMEZONE + '）。'
    };
  }
  if (unreadable.length > 0) {
    return { status: S.YELLOW, message: '核對不到（' + summary + '）。⚠️ 「讀不到」不等於「一致」。' };
  }
  return { status: S.GREEN, message: '三處一致：' + distinct[0] + '。' };
}

/**
 * 用途：把 R-058 的四項上線前檢查（寄送名單、測試名單、測試季度、時區一致）收成一個陣列。
 * Args:
 *   S {Object} `SELF_CHECK_STATUS_`。
 * Returns:
 *   {{label:string, status:string, message:string}[]}
 */
function buildGoLiveSafetyItems_(S) {
  var recipientState = inspectEmailRecipientState_();
  var tz = buildTimezoneCheckItem_(inspectTimezoneConsistency_(), S);
  return [
    buildEmailAllowlistGoLiveItem_(recipientState, S),
    buildTestRecipientsGoLiveItem_(recipientState, S),
    buildTestQuartersGoLiveItem_(inspectTestQuarters_(), S),
    { label: '上線前：時區一致', status: tz.status, message: tz.message }
  ];
}
