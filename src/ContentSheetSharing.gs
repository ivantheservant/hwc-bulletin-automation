/**
 * src/ContentSheetSharing.gs
 *
 * 2026-10-30（Ivan）：內容表權限——網域內只可以看，指定組別才可以修改；「財政報告」分頁另外只限指定組別。
 *
 *   - Config `CONTENT_SHEET_LINK_ACCESS`：`VIEW`（預設）＝教會網域的連結只可以看；`EDIT`＝網域內任何人都可以修改（舊做法）。
 *   - Config `CONTENT_SHEET_EDITOR_GROUPS`：可以修改的 Recipients 組別（只計 ACTIVE、在生效日期之內、電郵格式正確）。
 *     `VIEW` 時逐個加為編輯者（不寄通知信）。**一個有效電郵都沒有就不改成只可以看**（否則沒有人可以填），講出來。
 *   - Config `CONTENT_SHEET_FINANCE_EDITOR_GROUPS`：「財政報告」分頁的保護（只限這幾組＋系統帳戶）；留空＝不另外限制。
 *   - 只**加**編輯者，不移除：共用雲端硬碟的成員按共用雲端硬碟的角色仍然可以修改；有人離開組別，要人手在
 *     「共用」移除（結果會列出名單以外仍然是編輯者的人）。
 *   - 在「建立／更新本季內容表」時套用（src/ContentSheetAdmin.gs），預覽亦列出會做甚麼。
 */

'use strict';

/** 「財政報告」分頁保護的說明（用來認出是本系統加的那一個保護）。 */
var CONTENT_SHEET_FINANCE_LOCK_DESCRIPTION_ = '週報系統：「財政報告」只限指定組別修改（Config CONTENT_SHEET_FINANCE_EDITOR_GROUPS）';

/**
 * 用途：讀內容表權限的 Config。
 * Args: （無）
 * Returns:
 *   {{access:string, accessRaw:string, editorGroups:string[], financeGroups:string[]}}
 */
function readContentSheetSharingConfig_() {
  var raw = String(getConfig(CONFIG_KEYS.CONTENT_SHEET_LINK_ACCESS, 'VIEW') || '').trim().toUpperCase();
  return {
    access: raw === 'EDIT' ? 'EDIT' : 'VIEW',
    accessRaw: raw,
    editorGroups: getConfigTextList_(CONFIG_KEYS.CONTENT_SHEET_EDITOR_GROUPS, 'CC,DB,ADMIN,IT,WORSHIP'),
    financeGroups: getConfigTextList_(CONFIG_KEYS.CONTENT_SHEET_FINANCE_EDITOR_GROUPS, 'DB,ADMIN,IT')
  };
}

/**
 * 用途：算出內容表權限要怎樣設（預覽與套用共用）。純函式。
 * Args:
 *   input {{config:Object, recipientRows:Object[], today:Date}}
 * Returns:
 *   {{access:string, editors:string[], financeEditors:string[], financeLocked:boolean, warnings:string[], lines:string[]}}
 *   `access` 是最後真正要設的（`VIEW` 但沒有編輯者時保持 `EDIT`）。
 * Raises:
 *   （無）
 */
function planContentSheetSharing_(input) {
  var o = input || {};
  var config = o.config || { access: 'VIEW', editorGroups: [], financeGroups: [] };
  var out = { access: config.access, editors: [], financeEditors: [], financeLocked: false, warnings: [], lines: [] };
  function emails(groups) {
    if (!groups || groups.length === 0) return [];
    var list = buildRecipientList_(o.recipientRows || [], groups, o.today || new Date()).recipients || [];
    var seen = {};
    return list.map(function (r) { return String(r.email || '').trim().toLowerCase(); })
      .filter(function (e) { if (!e || seen[e]) return false; seen[e] = true; return true; });
  }
  if (config.accessRaw && config.accessRaw !== 'VIEW' && config.accessRaw !== 'EDIT') {
    out.warnings.push('Config 的 CONTENT_SHEET_LINK_ACCESS 是「' + config.accessRaw + '」，只可以填 VIEW 或 EDIT，現在當作 VIEW。');
  }
  out.editors = emails(config.editorGroups);
  if (out.access === 'VIEW' && out.editors.length === 0) {
    out.access = 'EDIT';
    out.warnings.push('可以修改的組別（' + (config.editorGroups || []).join('、') + '）在 Recipients 一個有效的電郵都沒有，'
      + '所以內容表仍然是網域內任何人都可以修改（否則沒有人可以填）。請先在 Recipients 補回電郵，再按一次「更新本季內容表」。');
  }
  out.financeEditors = emails(config.financeGroups);
  out.financeLocked = (config.financeGroups || []).length > 0;
  if (out.financeLocked && out.financeEditors.length === 0) {
    out.warnings.push('「財政報告」可以修改的組別（' + config.financeGroups.join('、') + '）在 Recipients 一個有效的電郵都沒有，'
      + '保護之後只有週報系統的帳戶可以修改。');
  }
  out.lines.push(out.access === 'VIEW'
    ? '內容表權限：教會網域內只可以看；可以修改的是 ' + (config.editorGroups || []).join('、') + ' 組（' + out.editors.length + ' 人）。'
    : '內容表權限：教會網域內任何人都可以修改。');
  out.lines.push(out.financeLocked
    ? '「財政報告」分頁：只限 ' + config.financeGroups.join('、') + ' 組（' + out.financeEditors.length + ' 人）修改。'
    : '「財政報告」分頁：不另外限制。');
  return out;
}

/**
 * 用途：讀出 `planContentSheetSharing_()` 要用的東西並算計畫。唯讀。
 * Args: （無）
 * Returns:
 *   {Object} 同 `planContentSheetSharing_()`。
 */
function previewContentSheetSharing_() {
  return planContentSheetSharing_({
    config: readContentSheetSharingConfig_(),
    recipientRows: readSheet(SHEETS.RECIPIENTS),
    today: new Date()
  });
}

/**
 * 用途：把權限計畫套用到一份內容表。IO 層；每一步失敗都記下來，不拋錯（內容表已經建好，權限可以人手補）。
 * Args:
 *   fileId {string}　spreadsheet {Spreadsheet}　plan {Object} `planContentSheetSharing_()` 的結果。
 *   domain {string} Config `CONTENT_SHEET_DOMAIN`；空白＝不設網域連結權限（只講出來）。
 * Returns:
 *   {{ok:boolean, added:string[], errors:string[], lines:string[]}}
 */
function applyContentSheetSharing_(fileId, spreadsheet, plan, domain) {
  var out = { ok: true, added: [], errors: [], lines: [] };
  function failed(step, err) {
    out.ok = false;
    out.errors.push(step + '：' + ((err && err.message) ? err.message : String(err)));
  }
  // Drive 的讀寫集中在 src/ContentSheetIo.gs（lint：雲端硬碟的服務只准在那幾個 IO 檔案）。
  var domainSet = String(domain || '').trim() !== '';
  if (domainSet) {
    try {
      setContentSheetDomainAccess_(fileId, plan.access);
    } catch (err) {
      failed('設定網域連結權限', err);
    }
  }

  if (plan.access === 'VIEW') {
    var current = {};
    try {
      current = listContentSheetUserRoles_(fileId);
    } catch (err) {
      failed('讀取現有編輯者', err);
    }
    plan.editors.forEach(function (email) {
      var role = current[email];
      if (role === 'writer' || role === 'fileOrganizer' || role === 'organizer' || role === 'owner') return;
      try {
        addContentSheetEditorQuietly_(fileId, email);
        out.added.push(email);
      } catch (err) {
        failed('加編輯者 ' + email, err);
      }
    });
  }

  try {
    applyContentSheetFinanceLock_(spreadsheet, plan);
  } catch (err) {
    failed('「財政報告」分頁保護', err);
  }

  out.lines = plan.lines.slice();
  if (!domainSet) {
    out.lines.push('⚠️ 未設定 ' + CONFIG_KEYS.CONTENT_SHEET_DOMAIN + '，網域連結權限沒有自動設定，請人手在「共用」設定。');
  }
  if (out.added.length > 0) out.lines.push('已加編輯者（不寄通知信）：' + out.added.length + ' 人。');
  plan.warnings.forEach(function (w) { out.lines.push('⚠️ ' + w); });
  out.errors.forEach(function (e) { out.lines.push('⚠️ 權限設定失敗：' + e + '　請人手在「共用」設定。'); });
  return out;
}

/**
 * 用途：「財政報告」分頁的保護（只限指定組別＋系統帳戶）。沒有組別就拿走本系統加的保護。IO 層。
 * Args:
 *   spreadsheet {Spreadsheet}　plan {Object}
 * Returns:
 *   {void}
 * Raises:
 *   Error 找不到分頁以外的試算表錯誤原樣拋出（呼叫方記下）。
 */
function applyContentSheetFinanceLock_(spreadsheet, plan) {
  var sheet = spreadsheet && spreadsheet.getSheetByName('財政報告');
  if (!sheet) return;
  var mine = sheet.getProtections(SpreadsheetApp.ProtectionType.SHEET).filter(function (p) {
    return p.getDescription() === CONTENT_SHEET_FINANCE_LOCK_DESCRIPTION_;
  });
  if (!plan.financeLocked) {
    mine.forEach(function (p) { p.remove(); });
    return;
  }
  var protection = mine[0] || sheet.protect().setDescription(CONTENT_SHEET_FINANCE_LOCK_DESCRIPTION_);
  protection.setWarningOnly(false);
  var me = Session.getEffectiveUser();
  protection.addEditor(me);
  var allowed = {};
  plan.financeEditors.forEach(function (e) { allowed[e] = true; });
  allowed[String(me.getEmail() || '').toLowerCase()] = true;
  var remove = protection.getEditors().filter(function (u) { return !allowed[String(u.getEmail() || '').toLowerCase()]; });
  if (remove.length > 0) protection.removeEditors(remove);
  if (protection.canDomainEdit()) protection.setDomainEdit(false);
  if (plan.financeEditors.length > 0) protection.addEditors(plan.financeEditors);
}
