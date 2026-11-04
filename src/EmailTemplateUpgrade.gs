/**
 * src/EmailTemplateUpgrade.gs
 *
 * 2026-11-04（Ivan 電郵範本意見）：EmailTemplates 四個範本改了（稱呼按組別、主旨去教會名加版本號、內文去教會名）。
 *   「初始化工作表」只補**沒有的**範本，已有的一格都不動；所以這裏另外把**仍然是系統舊預設值**的主旨、內文更新為新預設值。
 *
 *   ⚠️ 邊界（同 upgradeSystemSeededDefaults_()，docs/已知bug類型.md 事故四十三）：
 *     1. 只動四個系統範本（PREVIEW_NOTICE、SEND_NOTICE、TPL_WEEKLY_BULLETIN、PUBLISH_NOTICE）。
 *     2. 只在現值**完全等於**某一個系統舊預設值時才動（換行統一之後比較）；人手改過的一格都不動。
 *     3. 每一次更新都寫 AuditLog，初始化完成的對話框逐條列出。
 */

'use strict';

/** 2026-11-04 之前系統種下的舊預設值（由舊版 seedEmailTemplatesRows_() 取出，一字不改）。 */
var SUPERSEDED_EMAIL_TEMPLATE_SEEDS_ = {
  "PUBLISH_NOTICE": {
    "SUBJECT": "{{ChurchName}}{{CongregationName}}週報已發佈 — {{ServiceDate}}",
    "BODY": "各位主內肢體：\n\n平安！\n\n{{ServiceDate}} 主日的{{ChurchName}}{{CongregationName}}週報已經發佈，可以在以下連結閱讀：\n\n{{MasterLink}}\n\n這條連結固定不變，之後每星期打開都是最新一期，可以直接加入書籤。\n\n如發現資料有任何錯漏，請回覆此郵件告知，以便盡快更正。\n\n謝謝！\n\n{{CongregationName}}週報系統　敬上"
  },
  "SEND_NOTICE": {
    "SUBJECT": "{{ChurchName}}{{CongregationName}}週報 — {{ServiceDate}}",
    "BODY": "各位主內肢體：\n\n平安！\n\n{{ServiceDate}} 主日的{{ChurchName}}{{CongregationName}}週報，預覽連結如下（只供核對內容，版面與印刷版不同）：\n\n{{PreviewUrl}}\n\n本季內容表（家事報告、代禱事項、崇拜程序等內容在這裏填）：\n\n{{ContentSheetUrl}}\n\n{{MasterLinkLine}}\n\n{{AttachmentLine}}\n\n如發現資料有任何錯漏，請回覆此郵件告知，以便盡快更正。\n\n謝謝！\n\n{{CongregationName}}週報系統　敬上"
  },
  "PREVIEW_NOTICE": {
    "SUBJECT": "{{ChurchName}}{{CongregationName}}週報草稿預覽 — {{ServiceDate}}",
    "BODY": "各位主內肢體：\n\n平安！\n\n下一個主日（{{ServiceDate}}）的週報草稿預覽已經可以查看：\n\n{{PreviewUrl}}\n\n本季內容表（家事報告、代禱事項、崇拜程序等內容在這裏填）：\n\n{{ContentSheetUrl}}\n\n⚠️ 這是草稿預覽，版面與正式印刷版不同，只供核對內容。如發現資料有錯漏，請回覆此郵件。\n\n這條連結固定不變，之後每星期打開都是最新一期，可以直接收藏。\n\n{{RosterPendingNote}}\n\n謝謝！\n\n{{CongregationName}}週報系統　敬上"
  },
  "TPL_WEEKLY_BULLETIN": {
    "SUBJECT": "{{ChurchName}}{{CongregationName}}週報 — {{ServiceDate}}",
    "BODY": "各位主內肢體：\n\n平安！\n\n隨函附上 {{ServiceDate}} 主日的{{ChurchName}}{{CongregationName}}週報，敬請查收。\n\n如發現資料有任何錯漏，請回覆此郵件告知，以便盡快更正。\n\n謝謝！\n\n{{CongregationName}}週報系統　敬上"
  }
};

/**
 * 用途：某一個範本某一格的系統舊預設值（連舊版寫死「粵語堂」、舊版草稿預覽信沒有內容表那一段的寫法）。純函式。
 * Args:
 *   templateId {string}　field {string} `SUBJECT` 或 `BODY`。
 * Returns:
 *   {string[]} 已統一換行。
 */
function supersededEmailTemplateValues_(templateId, field) {
  var seed = SUPERSEDED_EMAIL_TEMPLATE_SEEDS_[templateId];
  if (!seed || typeof seed[field] !== 'string') return [];
  var base = normalizeTemplateNewlines_(seed[field]);
  var out = [base, base.replace(/\{\{CongregationName\}\}/g, '粵語堂')];
  if (templateId === 'PREVIEW_NOTICE' && field === 'BODY') {
    var paragraph = '本季內容表（家事報告、代禱事項、崇拜程序等內容在這裏填）：\n\n{{ContentSheetUrl}}\n\n';
    out = out.concat(out.map(function (v) { return v.replace(paragraph, ''); }));
  }
  return out.filter(function (v, i, arr) { return arr.indexOf(v) === i; });
}

/**
 * 用途：換行統一為 `\n`。純函式。
 * Args: s {*}
 * Returns: {string}
 */
function normalizeTemplateNewlines_(s) {
  return String(s === null || s === undefined ? '' : s).replace(/\r\n/g, '\n');
}

/**
 * 用途：把 EmailTemplates 仍然是系統舊預設值的主旨、內文更新為現在的預設值（見檔頭）。「初始化工作表」叫。
 * Args: （無）
 * Returns:
 *   {{upgrades:{templateId:string, field:string}[], lines:string[]}}
 */
function upgradeSystemSeededEmailTemplates_() {
  var upgrades = [];
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.EMAIL_TEMPLATES);
  var def = COLUMNS[SHEET_ID_BY_NAME[SHEETS.EMAIL_TEMPLATES]];
  if (!sheet || !def) return { upgrades: upgrades, lines: [] };
  var targets = {};
  seedEmailTemplatesRows_().forEach(function (r) { targets[r.TEMPLATE_ID] = r; });
  readRowsWithRowNo_(SHEETS.EMAIL_TEMPLATES).forEach(function (row) {
    var id = String(row.TEMPLATE_ID || '').trim();
    var target = targets[id];
    if (!target || !SUPERSEDED_EMAIL_TEMPLATE_SEEDS_[id]) return;
    ['SUBJECT', 'BODY'].forEach(function (field) {
      var current = normalizeTemplateNewlines_(row[field]);
      var next = normalizeTemplateNewlines_(target[field]);
      if (current === next) return;
      if (supersededEmailTemplateValues_(id, field).indexOf(current) === -1) return;
      setCellValueTextSafe_(sheet, def, row.__rowNo, field, next);
      appendAuditLog_({
        action: 'EMAIL_TEMPLATE_UPGRADE_DEFAULT', sheetName: SHEETS.EMAIL_TEMPLATES, rowKey: id, field: field,
        oldValue: current, newValue: next,
        notes: '系統種下的電郵範本預設值已更新（2026-11-04：稱呼按組別、主旨去教會名加版本號）。人手改過的不會被碰。'
      });
      upgrades.push({ templateId: id, field: field });
    });
  });
  return {
    upgrades: upgrades,
    lines: upgrades.map(function (u) { return '　' + u.templateId + '：' + (u.field === 'SUBJECT' ? '主旨' : '內文') + '更新為新預設'; })
  };
}
