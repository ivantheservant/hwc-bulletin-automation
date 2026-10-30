/**
 * RetireLegacy.gs
 *
 * 內容表 v2：「季度工具 ▸ 停用舊功能（季度填寫表、講員表格）」。部署之後由 Ivan 按一次。
 *
 * 做的事（docs/待確認事項.md 內容表 v2 決定 1、8、9、13）：
 *   1. 拆走兩個已停用的觸發器：`fillReconcileTrigger_`、`onSpeakerFormSubmit_`。
 *      `onFillGridEdit_` 不拆——它兼做 Config 人手改動稽核（事故四十三）。要拆哪幾個由
 *      `inspectProjectTriggers_()`（src/TriggerInventory.gs）決定，與各檢測同一份清單；
 *   2. 每一張 `Fill_*` 分頁：內容一格不改，只在 A1 加註解、隱藏、設系統保護。不刪；
 *   3. 講員表格關閉收件（`closeSpeakerFormResponses_()`），講員打開舊連結會見到 Config
 *      `SPEAKER_FORM_CLOSED_MESSAGE`。表格與舊答案不刪；
 *   4. Config 移轉（只做一次，之後已經是新值就不會再改）：
 *      - `FILL_INVITE_GROUPS` 有而 `CONTENT_SHEET_INVITE_GROUPS` 沒有的組別（例如領詩 WORSHIP）加入
 *        `CONTENT_SHEET_INVITE_GROUPS`——以前季度填寫邀請會寄給他們，停用之後改由內容表邀請通知；
 *      - `CONTENT_SHEET_OWNERS` 加上「崇拜程序=講員、領詩、幹事」（已有「崇拜程序=…」就不加），
 *        移走「宣召=…」「浸禮合堂=…」（這兩張分頁的內容併入崇拜程序）。
 *      現值是空白或沒有這個鍵就不動（空白代表刻意清走；沒有這個鍵時「初始化工作表」會種下新預設值）。
 *
 * 原則：
 *   - 預覽與執行共用 `planRetireLegacy_()`（bug class 120）；執行時在鎖之內重新計一次；
 *   - 冪等：已經做過的步驟不會再做，第二次執行是 0 項改動；
 *   - 每一步獨立：某一步失敗（例如表格開不到）記 ErrorLog、在結果列出，其餘步驟照做；
 *     再按一次只會補做未完成的步驟；
 *   - 每一步成功都寫一行 AuditLog `RETIRE_LEGACY_FEATURES`；
 *   - 只由選單觸發，先預覽、後「是／否」。不放入「初始化工作表」或任何自動流程（bug class 113）。
 */

'use strict';

/** 選單項目名稱（放在「季度工具」子選單內）。 */
var RETIRE_LEGACY_MENU_LABEL_ = '停用舊功能（季度填寫表、講員表格）';

/** 每一步成功時寫的 AuditLog 動作。 */
var RETIRE_LEGACY_AUDIT_ACTION_ = 'RETIRE_LEGACY_FEATURES';

/** 已停用的 Fill_ 分頁 A1 註解（決定 13）。已經以這一句開頭就當作已經加過。 */
var RETIRED_FILL_GRID_NOTE_ = '季度填寫表已停用（2026-10）。這張分頁只作記錄，改動不會寫入週報；'
  + '內容改在本季內容表與填寫介面填寫。';

/** Config 移轉：要加入 `CONTENT_SHEET_OWNERS` 的一項（決定 9）。 */
var RETIRE_LEGACY_OWNER_ADD_ = { tab: '崇拜程序', owner: '講員、領詩、幹事' };

/**
 * 用途：Config 移轉：要由 `CONTENT_SHEET_OWNERS` 移走的分頁（內容併入崇拜程序）。由內容表 v2 的
 *   `legacyMergedTabDefs_()` 衍生，分頁名稱只寫在那一處。
 * Args: （無）
 * Returns:
 *   {string[]}
 * Raises:
 *   （無）
 */
function retireLegacyOwnerRemoveTabs_() {
  return legacyMergedTabDefs_().map(function (def) { return def.tabName; });
}

/**
 * 用途：選單路徑全名（各處提示叫人去按的那一句）。
 * Args: （無）
 * Returns:
 *   {string} 例如「季度工具 ▸ 停用舊功能（季度填寫表、講員表格）」。
 * Raises:
 *   （無）
 */
function retireLegacyMenuPath_() {
  return QUARTER_TOOLS_MENU_LABEL_ + ' ▸ ' + RETIRE_LEGACY_MENU_LABEL_;
}

// =====================================================================
// 純函式：Config 移轉
// =====================================================================

/**
 * 用途：算出「內容表邀請組別」要加入哪幾個組別。純函式。
 * Args:
 *   inviteRaw {?string} `CONTENT_SHEET_INVITE_GROUPS` 現值；`null`＝Config 沒有這個鍵。
 *   fillInviteRaw {?string} `FILL_INVITE_GROUPS` 現值；`null`＝Config 沒有這個鍵。
 * Returns:
 *   {?{key:string, oldValue:string, newValue:string, summary:string}} 不用改時回 `null`。
 * Raises:
 *   （無）
 */
function planRetireInviteGroupsChange_(inviteRaw, fillInviteRaw) {
  if (inviteRaw === null || fillInviteRaw === null) return null;
  var current = String(inviteRaw).trim();
  if (!current) return null;
  var groups = parseConfigTextList_(current);
  var added = parseConfigTextList_(fillInviteRaw).filter(function (g, i, all) {
    return groups.indexOf(g) === -1 && all.indexOf(g) === i;
  });
  if (added.length === 0) return null;
  return {
    key: CONFIG_KEYS.CONTENT_SHEET_INVITE_GROUPS,
    oldValue: current,
    newValue: groups.concat(added).join(','),
    summary: '內容表邀請加上 ' + added.join('、') + '（以前季度填寫邀請會寄給他們）'
  };
}

/**
 * 用途：算出「內容表各分頁負責人」的新值：加上崇拜程序、移走宣召與浸禮合堂。純函式。
 *   其餘各項（包括格式不符的）原樣保留，次序不變；崇拜程序排第一（分頁次序，決定 7）。
 * Args:
 *   ownersRaw {?string} `CONTENT_SHEET_OWNERS` 現值；`null`＝Config 沒有這個鍵。
 * Returns:
 *   {?{key:string, oldValue:string, newValue:string, summary:string}} 不用改時回 `null`。
 * Raises:
 *   （無）
 */
function planRetireOwnersChange_(ownersRaw) {
  if (ownersRaw === null) return null;
  var current = String(ownersRaw).trim();
  if (!current) return null;

  var parts = current.split(/[,，]/).map(function (p) { return p.trim(); }).filter(function (p) { return p; });
  var tabOf = function (part) {
    var pair = part.split('=');
    return pair.length === 2 ? pair[0].trim() : '';
  };
  var removeTabs = retireLegacyOwnerRemoveTabs_();
  var removed = parts.filter(function (p) { return removeTabs.indexOf(tabOf(p)) !== -1; });
  var kept = parts.filter(function (p) { return removeTabs.indexOf(tabOf(p)) === -1; });
  var hasWorship = kept.some(function (p) { return tabOf(p) === RETIRE_LEGACY_OWNER_ADD_.tab; });
  if (removed.length === 0 && hasWorship) return null;

  var addedPart = RETIRE_LEGACY_OWNER_ADD_.tab + '=' + RETIRE_LEGACY_OWNER_ADD_.owner;
  var newParts = (hasWorship ? [] : [addedPart]).concat(kept);
  var pieces = [];
  if (!hasWorship) pieces.push('加上「' + addedPart + '」');
  if (removed.length > 0) pieces.push('移走' + removed.map(function (p) { return '「' + p + '」'; }).join(''));
  return {
    key: CONFIG_KEYS.CONTENT_SHEET_OWNERS,
    oldValue: current,
    newValue: newParts.join(','),
    summary: '內容表負責人' + pieces.join('；')
  };
}

// =====================================================================
// 計畫（唯讀）
// =====================================================================

/**
 * 用途：讀 Config 一個鍵的原始值；沒有這個鍵回 `null`（與「空白」分開）。
 * Args:
 *   key {string} 設定鍵。
 * Returns:
 *   {?string}
 * Raises:
 *   Error 讀 Config 失敗時原樣拋出。
 */
function readConfigOrNull_(key) {
  var value = getConfig_(key, null);
  return value === null || value === undefined ? null : String(value);
}

/**
 * 用途：之前「停用舊功能」已經成功移轉過的 Config 鍵（AuditLog `RETIRE_LEGACY_FEATURES`、工作表
 *   Config、欄位 VALUE）。純函式。
 * Args:
 *   auditRows {Object[]} `readSheet_(SHEETS.AUDIT_LOG)` 的輸出。
 * Returns:
 *   {Object<string,boolean>} 設定鍵 → true。
 * Raises:
 *   （無）
 */
function retireLegacyDoneConfigKeys_(auditRows) {
  var out = {};
  (auditRows || []).forEach(function (r) {
    if (String(r.ACTION || '') !== RETIRE_LEGACY_AUDIT_ACTION_) return;
    if (String(r.SHEET_NAME || '') !== SHEETS.CONFIG || String(r.FIELD || '') !== 'VALUE') return;
    var key = String(r.ROW_KEY || '').trim();
    if (key) out[key] = true;
  });
  return out;
}

/**
 * 用途：一張 `Fill_*` 分頁還要做哪幾件事（加註解、隱藏、設系統保護）。唯讀。
 * Args:
 *   sheet {Sheet} 分頁。
 * Returns:
 *   {{sheetName:string, needsNote:boolean, needsHide:boolean, needsProtect:boolean}}
 * Raises:
 *   Error 讀分頁狀態失敗時原樣拋出。
 */
function inspectRetiredFillSheet_(sheet) {
  var note = String(sheet.getRange(1, 1).getNote() || '');
  var description = systemSheetProtectionDescription_();
  var protectedBySystem = sheet.getProtections(SpreadsheetApp.ProtectionType.SHEET).some(function (p) {
    return typeof p.getDescription === 'function' && p.getDescription() === description;
  });
  return {
    sheetName: sheet.getName(),
    needsNote: note.indexOf(RETIRED_FILL_GRID_NOTE_) !== 0,
    needsHide: sheet.isSheetHidden() !== true,
    needsProtect: !protectedBySystem
  };
}

/**
 * 用途：算出「停用舊功能」要做的每一步。唯讀；預覽與執行共用。
 * Args: （無）
 * Returns:
 *   {{ok:boolean, message:string, triggers:{handler:string, label:string, count:number}[],
 *     fillSheets:Object[], speakerForm:?{formId:string, accepting:?boolean},
 *     configChanges:Object[], changeCount:number}}
 *     讀不到觸發器清單時 `ok:false`（不知道要拆甚麼就整次不做）。`speakerForm` 是 `null`
 *     代表不用關閉（從未建立，或者已經停止收件）。
 * Raises:
 *   Error 讀 Config 或試算表失敗時原樣拋出。
 */
function planRetireLegacy_() {
  var report = inspectProjectTriggers_();
  if (!report.ok) {
    return {
      ok: false, message: '讀不到觸發器清單（' + report.error + '），不知道要拆哪幾個，所以整次不做。這個動作一格都沒有寫。',
      triggers: [], fillSheets: [], speakerForm: null, configChanges: [], changeCount: 0
    };
  }
  var triggers = report.items.filter(function (i) { return i.retired && i.actual > 0; })
    .map(function (i) { return { handler: i.handler, label: i.label, count: i.actual }; });

  var fillSheets = SpreadsheetApp.getActiveSpreadsheet().getSheets().filter(function (sheet) {
    return String(sheet.getName()).indexOf(FILL_GRID_SHEET_PREFIX) === 0;
  }).map(inspectRetiredFillSheet_).filter(function (s) {
    return s.needsNote || s.needsHide || s.needsProtect;
  });

  var formId = String(getConfig_(CONFIG_KEYS.SPEAKER_FORM_ID, '') || '').trim();
  var speakerForm = null;
  if (formId) {
    var accepting = isSpeakerFormAcceptingResponses_(formId);
    if (accepting !== false) speakerForm = { formId: formId, accepting: accepting };
  }

  // 審查 F7：Config 移轉只做一次。AuditLog 已經有這一項（之前按過「停用舊功能」並成功）就不再做——
  //    否則幹事之後刻意從邀請組別拿走 WORSHIP，再因為別的原因按一次，又會被加回去。
  var doneConfigKeys = retireLegacyDoneConfigKeys_(readSheet_(SHEETS.AUDIT_LOG));
  var configChanges = [
    planRetireInviteGroupsChange_(readConfigOrNull_(CONFIG_KEYS.CONTENT_SHEET_INVITE_GROUPS),
      readConfigOrNull_(CONFIG_KEYS.FILL_INVITE_GROUPS)),
    planRetireOwnersChange_(readConfigOrNull_(CONFIG_KEYS.CONTENT_SHEET_OWNERS))
  ].filter(function (c) { return c && !doneConfigKeys[c.key]; });

  return {
    ok: true, message: '',
    triggers: triggers, fillSheets: fillSheets, speakerForm: speakerForm, configChanges: configChanges,
    changeCount: triggers.length + fillSheets.length + (speakerForm ? 1 : 0) + configChanges.length
  };
}

/**
 * 用途：預覽對話框的內容。純函式。
 * Args:
 *   plan {Object} `planRetireLegacy_()` 的輸出（`ok:true`）。
 * Returns:
 *   {string[]}
 * Raises:
 *   （無）
 */
function buildRetireLegacyPreviewLines_(plan) {
  if (plan.changeCount === 0) {
    return ['沒有需要停用的項目：兩個舊觸發器已經拆走、季度填寫表分頁已經隱藏並受保護、講員表格已經停止收件、Config 已經移轉。',
      '這個動作一格都沒有寫。'];
  }
  var lines = ['季度填寫表與講員表格已由「填寫介面＋內容表」取代。以下 ' + plan.changeCount + ' 項會停用：', ''];
  if (plan.triggers.length > 0) {
    lines.push('【觸發器】');
    plan.triggers.forEach(function (t) {
      lines.push('　拆走「' + t.label + '」（' + t.handler + '）' + t.count + ' 個');
    });
    lines.push('　（「自動寄送」與「Config 人手改動稽核」兩個觸發器不會動）');
  }
  if (plan.fillSheets.length > 0) {
    lines.push('【季度填寫表分頁】內容一格不改、不會刪除：');
    plan.fillSheets.forEach(function (s) {
      var steps = [];
      if (s.needsNote) steps.push('A1 加註解');
      if (s.needsHide) steps.push('隱藏');
      if (s.needsProtect) steps.push('設系統保護');
      lines.push('　' + s.sheetName + '：' + steps.join('、'));
    });
  }
  if (plan.speakerForm) {
    lines.push('【講員表格】停止收件（表格與舊答案不會刪除）。講員打開舊連結會看到：「' + speakerFormClosedMessage_() + '」');
    if (plan.speakerForm.accepting === null) {
      lines.push('　⚠️ 現時查不到表格狀態（表格開不到，或者部署後還沒有重新授權 forms 範圍）。按「是」會嘗試關閉，失敗會在結果列出。');
    }
  }
  if (plan.configChanges.length > 0) {
    lines.push('【Config】');
    plan.configChanges.forEach(function (c) {
      lines.push('　' + c.key + '：「' + c.oldValue + '」→「' + c.newValue + '」（' + c.summary + '）');
    });
    lines.push('　（Config 只會移轉一次：之後人手再改，再按這個選單亦不會改回。）');
  }
  lines.push('');
  lines.push('每一步都會寫入 AuditLog（' + RETIRE_LEGACY_AUDIT_ACTION_ + '）。可以重複執行：已經做過的步驟不會再做。');
  return lines;
}

// =====================================================================
// 執行
// =====================================================================

/**
 * 用途：在鎖之內重新計一次計畫，逐步執行。每一步獨立：失敗的記 ErrorLog、放進 `failed`，
 *   其餘照做。
 * Args: （無）
 * Returns:
 *   {{ok:boolean, message:string, done:string[], failed:{step:string, message:string}[]}}
 *     `ok`＝計畫讀得到而且每一步都成功。
 * Raises:
 *   Error 拿不到指令碼鎖（`LOCK_TIMEOUT`）；讀 Config 或試算表失敗時原樣拋出（一格都未寫）。
 */
function applyRetireLegacy_() {
  return withScriptLock_('applyRetireLegacy_', 30000, function () {
    var plan = planRetireLegacy_();
    if (!plan.ok) return { ok: false, message: plan.message, done: [], failed: [] };

    var done = [];
    var failed = [];
    var step = function (label, audit, fn) { runRetireLegacyStep_(label, audit, fn, done, failed); };

    plan.triggers.forEach(function (t) {
      step('拆走觸發器「' + t.label + '」（' + t.handler + '）' + t.count + ' 個',
        { rowKey: t.handler, field: 'TRIGGER', oldValue: String(t.count), newValue: '0' },
        function () { removeTriggersByHandler_(t.handler); });
    });

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var editors = plan.fillSheets.some(function (s) { return s.needsProtect; }) ? sheetProtectionEditors_() : [];
    plan.fillSheets.forEach(function (s) {
      var sheet = ss.getSheetByName(s.sheetName);
      var steps = [];
      if (s.needsNote) steps.push('A1 加註解');
      if (s.needsHide) steps.push('隱藏');
      if (s.needsProtect) steps.push('設系統保護');
      step('季度填寫表分頁 ' + s.sheetName + '：' + steps.join('、'),
        { sheetName: s.sheetName, field: 'FILL_GRID_RETIRED', newValue: steps.join('、') },
        function () {
          if (!sheet) throw new Error('找不到工作表 ' + s.sheetName + '。');
          if (s.needsNote) {
            var cell = sheet.getRange(1, 1);
            var oldNote = String(cell.getNote() || '');
            cell.setNote(RETIRED_FILL_GRID_NOTE_ + (oldNote ? '\n\n' + oldNote : ''));
          }
          if (s.needsHide) sheet.hideSheet();
          if (s.needsProtect) protectSheetForSystem_(sheet, editors);
        });
    });

    if (plan.speakerForm) {
      step('講員表格停止收件',
        { sheetName: '', rowKey: plan.speakerForm.formId, field: 'ACCEPTING_RESPONSES',
          oldValue: plan.speakerForm.accepting === null ? '（查不到）' : String(plan.speakerForm.accepting), newValue: 'false' },
        function () { closeSpeakerFormResponses_(plan.speakerForm.formId, speakerFormClosedMessage_()); });
    }

    plan.configChanges.forEach(function (c) {
      step('Config ' + c.key + '：' + c.summary,
        { sheetName: SHEETS.CONFIG, rowKey: c.key, field: 'VALUE', oldValue: c.oldValue, newValue: c.newValue },
        function () { setConfig_(c.key, c.newValue, '停用舊功能：' + c.summary); });
    });

    return { ok: failed.length === 0, message: '', done: done, failed: failed };
  });
}

/**
 * 用途：「停用舊功能」執行其中一步：成功寫一行 AuditLog（`RETIRE_LEGACY_FEATURES`）並記入 `done`；
 *   失敗記 ErrorLog 並記入 `failed`，不拋錯（每一步獨立，一步失敗不連累其餘）。
 * Args:
 *   label {string} 這一步的說明（AuditLog NOTES 與結果對話框共用）。
 *   audit {{sheetName:string=, rowKey:string=, field:string=, oldValue:string=, newValue:string=}}
 *     AuditLog 的欄位。
 *   fn {function():void} 真正的動作。
 *   done {string[]} 成功的步驟（會被加入）。
 *   failed {{step:string, message:string}[]} 失敗的步驟（會被加入）。
 * Returns:
 *   {void}
 * Raises:
 *   Error 寫 AuditLog 或 ErrorLog 本身失敗時原樣拋出（動作已經做了，不可以當作沒有做）。
 */
function runRetireLegacyStep_(label, audit, fn, done, failed) {
  try {
    fn();
  } catch (err) {
    var message = (err && err.message) ? err.message : String(err);
    failed.push({ step: label, message: message });
    appendErrorLog_({
      source: ERROR_LOG_SOURCE.MENU, functionName: 'applyRetireLegacy_',
      errorCode: 'RETIRE_LEGACY_STEP_FAILED', message: '停用舊功能：「' + label + '」失敗：' + message,
      detail: buildErrorDetail_(err)
    });
    return;
  }
  appendAuditLog_({
    action: RETIRE_LEGACY_AUDIT_ACTION_, sheetName: audit.sheetName || '', rowKey: audit.rowKey || '',
    field: audit.field || '', oldValue: audit.oldValue || '', newValue: audit.newValue || '', notes: label
  });
  done.push(label);
}

/**
 * 用途：結果對話框的內容。純函式。
 * Args:
 *   result {Object} `applyRetireLegacy_()` 的輸出。
 * Returns:
 *   {string[]}
 * Raises:
 *   （無）
 */
function buildRetireLegacyResultLines_(result) {
  if (result.message) return [result.message];
  var lines = [];
  if (result.done.length === 0 && result.failed.length === 0) {
    lines.push('沒有需要停用的項目（之前已經做過）。這個動作一格都沒有寫。');
    return lines;
  }
  if (result.done.length > 0) {
    lines.push('已完成 ' + result.done.length + ' 項：');
    result.done.forEach(function (d) { lines.push('　' + d); });
  }
  if (result.failed.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push('⚠️ 失敗 ' + result.failed.length + ' 項（已記入 ErrorLog）：');
    result.failed.forEach(function (f) { lines.push('　' + f.step + '：' + f.message); });
    lines.push('其餘已完成的步驟不受影響。處理好原因之後再按一次「' + retireLegacyMenuPath_() + '」，只會補做未完成的步驟。');
  }
  lines.push('');
  lines.push('之後可以按選單「查看觸發器狀態」核對：自動寄送 1 個、Config 人手改動稽核 1 個，其餘 0 個。');
  return lines;
}

/**
 * 用途：選單項目「季度工具 ▸ 停用舊功能（季度填寫表、講員表格）」的處理函式。先預覽，
 *   按「是」才執行。
 * Args: （無）
 * Returns:
 *   {void}
 * Raises:
 *   （無）失敗時寫 `ErrorLog` 並用對話框顯示。
 */
function menuRetireLegacyFeatures_() {
  var ui = SpreadsheetApp.getUi();
  var title = '停用舊功能';
  try {
    var plan = planRetireLegacy_();
    if (!plan.ok) {
      ui.alert(title, plan.message, ui.ButtonSet.OK);
      return;
    }
    var preview = buildRetireLegacyPreviewLines_(plan);
    if (plan.changeCount === 0) {
      ui.alert(title, preview.join('\n'), ui.ButtonSet.OK);
      return;
    }
    var answer = ui.alert(title, preview.join('\n') + '\n\n確定要停用嗎？', ui.ButtonSet.YES_NO);
    if (answer !== ui.Button.YES) {
      ui.alert(title, '已取消，一格都沒有寫。', ui.ButtonSet.OK);
      return;
    }
    var result = applyRetireLegacy_();
    ui.alert(title, buildRetireLegacyResultLines_(result).join('\n'), ui.ButtonSet.OK);
  } catch (err) {
    logMenuError_('menuRetireLegacyFeatures_', err);
    ui.alert(title + '失敗', enrichAuthError_(err), ui.ButtonSet.OK);
  }
}
