/**
 * BulletinEmail.gs
 *
 * 週報郵件的內容：附件介面、HTML／純文字正文、範本佔位符替換。
 * 全部函式除 `renderBulletinAttachment_()`（要讀 Config 決定要不要接
 * Google Docs 範本）之外，其餘都是**純函式**，不碰 Apps Script 服務，
 * 方便在 Node 直接測試。
 *
 * ⚠️ 本檔案完全不寫 `DocumentApp` 程式碼——三份週報 `.docx` 原檔還沒有
 * 提供，真正的「Google Docs 範本 → PDF」下一輪才做。`renderBulletinAttachment_()`
 * 是接上去的**唯一位置**：現在只判斷「有沒有範本 ID」，有的話固定回
 * `NOT_IMPLEMENTED`，下一輪只需要在那個分支裡面填實作，呼叫端
 * （`Mailer.gs`）完全不用改。
 */

'use strict';

/**
 * 用途：週報附件的介面。本輪只實作「未有範本」的分支——真正的
 *   Google Docs 範本渲染留給下一輪，這個函式就是接上去的唯一位置。
 * Args:
 *   model {Object} `buildBulletinModel_()` 的輸出，用 `model.templateId`
 *     判斷這一週是平常主日還是三堂聯合崇拜（浸禮／堂慶），藉此決定要看
 *     Config 的 `DOC_TEMPLATE_ID_NORMAL` 還是 `DOC_TEMPLATE_ID_COMBINED`。
 * Returns:
 *   {{ok:boolean, blob:(Blob|undefined), reason:(string|undefined)}}
 *     `ok:false` 時 `reason` 是 `'NO_TEMPLATE'`（對應的 Config 範本 ID
 *     留空）或 `'NOT_IMPLEMENTED'`（範本 ID 有填，但範本渲染功能本輪
 *     還沒做）。本輪 `ok` 永遠是 `false`，`blob` 永遠不會出現。
 */
function renderBulletinAttachment_(model) {
  var isCombined = model && (model.templateId === PROGRAM_TEMPLATE_ID_BAPTISM_ || model.templateId === PROGRAM_TEMPLATE_ID_ANNIVERSARY_);
  var configKey = isCombined ? CONFIG_KEYS.DOC_TEMPLATE_ID_COMBINED : CONFIG_KEYS.DOC_TEMPLATE_ID_NORMAL;
  var templateId = getConfig(configKey, '');

  if (!templateId) {
    return { ok: false, reason: 'NO_TEMPLATE' };
  }

  // 範本 ID 已經填了，但本輪完全不寫 DocumentApp 程式碼——下一輪要做的
  // 事就是把這裡換成真正的「複製範本 → 填佔位符 → 匯出 PDF」，並回傳
  // `{ ok: true, blob: pdfBlob }`。
  return { ok: false, reason: 'NOT_IMPLEMENTED' };
}

/**
 * 用途：把附件不可用的 `reason` 代碼轉成人看得懂的中文說明。
 * Args:
 *   reason {string} `renderBulletinAttachment_()` 的 `reason`。
 * Returns:
 *   {string}
 */
function attachmentReasonText_(reason) {
  if (reason === 'NO_TEMPLATE') return '尚未設定 Google Docs 範本';
  if (reason === 'NOT_IMPLEMENTED') return '範本渲染功能尚未實作';
  return reason || '原因不明';
}

/**
 * 用途：把文字轉成安全嵌入 HTML 的形式（跳脫 `& < > "` 四個字元）。
 *   跟 `WebApp.gs` 的 `escapeHtml_()` 是同一個邏輯，這裡另外命名一份是
 *   為了讓本檔案不依賴 `WebApp.gs`——郵件內容跟填寫介面是兩個獨立的
 *   輸出通道，各自的跳脫函式不應該互相依賴。
 * Args:
 *   text {*} 任意值，會先轉成字串。
 * Returns:
 *   {string}
 */
function escapeHtmlEmail_(text) {
  return String(text === null || text === undefined ? '' : text)
    .split('&').join('&amp;')
    .split('<').join('&lt;')
    .split('>').join('&gt;')
    .split('"').join('&quot;');
}

/**
 * 用途：把 `EmailTemplates` 的 `SUBJECT`／`BODY` 範本字串內的
 *   `{{placeholder}}` 換成對應的值。
 *
 *   ⚠️ 未知的佔位符**原樣保留**並記一筆 warning——不可以靜靜變成空
 *   字串，否則範本裡打錯字（例如 `{{ChurhName}}`）永遠不會被發現，
 *   只會表現成「郵件裡有一格莫名其妙空白」。`vars` 內有值但範本沒有
 *   用到，不是錯誤（範本本來就不一定用得到每一個提供的變數）。
 * Args:
 *   templateString {string} 範本原文。
 *   vars {Object<string,*>} 佔位符名稱（不含大括號）→ 值，值一律轉字串，
 *     `null`／`undefined` 轉成空字串。
 *   warningsOut {Object[]=} 選填，累積警告用的陣列，這個函式會往裡面 push。
 * Returns:
 *   {string}
 */
function renderEmailTemplate_(templateString, vars, warningsOut) {
  var text = String(templateString === null || templateString === undefined ? '' : templateString);
  var v = vars || {};
  return text.replace(/\{\{(\w+)\}\}/g, function (whole, key) {
    if (Object.prototype.hasOwnProperty.call(v, key)) {
      var value = v[key];
      return (value === null || value === undefined) ? '' : String(value);
    }
    if (warningsOut) {
      warningsOut.push({
        code: 'UNKNOWN_PLACEHOLDER',
        message: '範本內的佔位符「{{' + key + '}}」不在已知清單內，原樣保留，不會變成空字串；'
          + '已知清單：ChurchName、ServiceDate、SpecialType、MissingCount、RosterVersion。'
      });
    }
    return whole;
  });
}

/**
 * 用途：檢查 Config 的 `CHURCH_NAME` 是否已設定。`{{ChurchName}}` 這個
 *   佔位符曾經因為一直沒有對應的設定值而永遠渲染成空字串（見本檔案
 *   `renderEmailTemplate_()` 的說明；`Constants.gs` 已經補上預設值），
 *   這個函式讓「有人手動把它清空」這件事講出來，不要再次靜靜發生。
 * Args:
 *   churchName {string} Config `CHURCH_NAME` 目前的值。
 * Returns:
 *   {?{code:string,message:string}} 空白（含只有空白字元）時回一筆
 *     warning；有值回 `null`。
 */
function checkChurchNameConfigured_(churchName) {
  if (String(churchName === null || churchName === undefined ? '' : churchName).trim() !== '') return null;
  return {
    code: 'CHURCH_NAME_NOT_CONFIGURED',
    message: 'Config 的 CHURCH_NAME 是空的，郵件範本內的 {{ChurchName}} 會渲染成空字串。請在 Config 填入教會全名。'
  };
}

/**
 * 用途：組出週報郵件的 HTML 正文。**永遠輸出完整的週報內容**（不是只在
 *   附件不可用時才輸出）——這是本輪的核心設計：附件是「錦上添花」，
 *   正文本身隨時都要讓堂委看得到完整內容，日後範本做好、附件補上了，
 *   正文照樣完整輸出，只是多一個 PDF 附件。純函式，不碰 Apps Script 服務。
 * Args:
 *   model {Object} `buildBulletinModel_()` 的輸出。
 *   options {{attachment:Object=, includeMissingList:boolean=,
 *            introHtml:string=, generatedAtText:string=}}
 *     `attachment` 是 `renderBulletinAttachment_()` 的輸出，缺少時當
 *     `{ok:false, reason:'NO_TEMPLATE'}`；`includeMissingList` 預設
 *     `true`；`introHtml` 是 `EmailTemplates.BODY` 經 `renderEmailTemplate_()`
 *     渲染後轉成的 HTML，放在最前面當問候語，沒有提供就略過這一段；
 *     `generatedAtText` 是已經格式化好的產生時間字串（時區轉換要用
 *     `Utilities.formatDate()`，這個函式本身不碰 Apps Script 服務，
 *     所以由呼叫方先格式化好再傳進來）。
 * Returns:
 *   {string} 完整的 HTML 字串。
 */
function buildBulletinEmailHtml_(model, options) {
  var opts = options || {};
  var includeMissing = opts.includeMissingList !== false;
  var attachment = opts.attachment || { ok: false, reason: 'NO_TEMPLATE' };
  var header = model.header || {};
  var esc = escapeHtmlEmail_;
  var parts = [];

  function cell(tag, text) {
    return '<' + tag + ' style="border:1px solid #ccc;padding:4px 8px;text-align:left;vertical-align:top;">' + esc(text) + '</' + tag + '>';
  }
  function section(title, innerHtml) {
    parts.push('<h3 style="margin:1.2em 0 0.4em;">' + esc(title) + '</h3>' + innerHtml);
  }
  function table(rowsHtml, headHtml) {
    return '<table style="border-collapse:collapse;width:100%;margin-bottom:0.6em;">'
      + (headHtml ? '<thead><tr>' + headHtml + '</tr></thead>' : '')
      + '<tbody>' + rowsHtml + '</tbody></table>';
  }

  if (opts.introHtml) {
    parts.push('<div style="margin-bottom:1em;">' + opts.introHtml + '</div>');
  }

  // 1. 標題行
  var titleLine = esc(model.isoDate) + (model.special ? '　' + esc(model.special.title) : '');
  parts.push('<h2 style="margin:0 0 0.6em;">' + titleLine + '</h2>');

  // 2. 附件不可用的說明
  if (!attachment.ok) {
    parts.push(
      '<p style="background:#fff3cd;color:#7a5c00;padding:0.6em 1em;border-radius:4px;">'
      + '本週未附上 PDF（原因：' + esc(attachmentReasonText_(attachment.reason)) + '），'
      + '以下為週報內容全文，供各位先行審閱。</p>'
    );
  }

  // 3. 崇拜程序表
  var programRowsHtml = (model.program || []).map(function (r) {
    if (r.fullWidth) {
      return '<tr><td colspan="3" style="border:1px solid #ccc;padding:4px 8px;text-align:center;">'
        + esc(r.itemName) + (r.content ? '　' + esc(r.content) : '') + '</td></tr>';
    }
    return '<tr>' + cell('td', r.itemName) + cell('td', r.content) + cell('td', r.posture) + '</tr>';
  }).join('');
  section(header.pageTitle || '崇拜程序', table(programRowsHtml,
    cell('th', '項目') + cell('th', '內容') + cell('th', '立坐')));

  // 4. 本週事奉（第 1 頁的樣子）
  var dutyRowsHtml = (model.dutyBoxPage1 || []).map(function (r) {
    return '<tr>' + cell('td', r.label) + cell('td', r.text || '（待填）') + '</tr>';
  }).join('');
  section('本週事奉', table(dutyRowsHtml));

  // 5. 上週崇拜人數表
  var attendance = model.attendance || { columns: [], rows: [] };
  var attHeadHtml = cell('th', '') + attendance.columns.map(function (c) { return cell('th', c); }).join('');
  var attRowsHtml = attendance.rows.map(function (r) {
    return '<tr>' + cell('td', r.label) + r.values.map(function (v) { return cell('td', v); }).join('') + '</tr>';
  }).join('');
  section((header.attendanceHeading || '上週主日崇拜人數') + '（' + (header.attendanceDate || '') + '）',
    table(attRowsHtml, attHeadHtml));

  // 6. 下週事奉、本週／下週獻花
  var nextDutyRowsHtml = (model.nextWeekDuty || []).map(function (r) {
    return '<tr>' + cell('td', r.label) + cell('td', r.text || '（待填）') + '</tr>';
  }).join('');
  section((header.nextWeekHeading || '下週主日崇拜聚會事奉肢體') + '（' + (header.nextWeekDate || '') + '）',
    table(nextDutyRowsHtml));
  var flowers = model.flowers || { thisWeek: '', nextWeek: '' };
  parts.push('<p>本週獻花：' + esc(flowers.thisWeek) + '　下週獻花：' + esc(flowers.nextWeek) + '</p>');

  // 7. 家事報告、代禱區塊、本週團契聚會、財政報告（有內容才顯示）
  if (model.announcements && model.announcements.length > 0) {
    section('家事報告', '<ul>' + model.announcements.map(function (a) {
      return '<li>' + esc(a.text) + '</li>';
    }).join('') + '</ul>');
  }
  if (model.prayerBlock && model.prayerBlock.items && model.prayerBlock.items.length > 0) {
    section(model.prayerBlock.heading || '代禱事項', '<ul>' + model.prayerBlock.items.map(function (p) {
      return '<li>' + esc(p.text) + '</li>';
    }).join('') + '</ul>');
  }
  if (model.fellowships && model.fellowships.length > 0) {
    section('本週團契聚會', '<ul>' + model.fellowships.map(function (f) {
      return '<li>' + esc(f.fellowshipName) + '　' + esc(f.meetingDate) + ' ' + esc(f.meetingTime) + '　' + esc(f.content) + '</li>';
    }).join('') + '</ul>');
  }
  if (model.finance && model.finance.length > 0) {
    section('財政報告', '<ul>' + model.finance.map(function (f) {
      return '<li>' + esc(f.rowLabel) + '　特殊海外奉獻：' + esc(f.specialOverseas) + '　慈惠：' + esc(f.hardship) + '</li>';
    }).join('') + '</ul>');
  }

  // 8. 尚未填寫的欄位
  if (includeMissing && model.missing && model.missing.length > 0) {
    section('尚未填寫的欄位', '<ul>' + model.missing.map(function (m) {
      return '<li>' + esc(m.label) + '：' + esc(m.reason) + '</li>';
    }).join('') + '</ul>');
  }

  // 9. 頁尾
  var versionText = (model.rosterVersionUsed === null || model.rosterVersionUsed === undefined)
    ? '（尚未生成）' : String(model.rosterVersionUsed);
  parts.push(
    '<p style="color:#888;font-size:12px;margin-top:1.5em;">'
    + '職事表版本：' + esc(versionText)
    + '　是否已正式發出：' + (model.rosterIsOfficial ? '是' : '否')
    + '　產生時間：' + esc(opts.generatedAtText || '')
    + '</p>'
  );

  return parts.join('\n');
}

/**
 * 用途：組出週報郵件的純文字備援正文（`MailApp` 的 `body`，給不支援
 *   HTML 的郵件客戶端用）。內容可以比 HTML 版簡化，但**必須包含**主日
 *   日期與待填清單。純函式，不碰 Apps Script 服務。
 * Args:
 *   model {Object} `buildBulletinModel_()` 的輸出。
 *   options {{attachment:Object=, includeMissingList:boolean=}}
 *     同 `buildBulletinEmailHtml_()`。
 * Returns:
 *   {string}
 */
function buildBulletinEmailPlainText_(model, options) {
  var opts = options || {};
  var includeMissing = opts.includeMissingList !== false;
  var attachment = opts.attachment || { ok: false, reason: 'NO_TEMPLATE' };
  var lines = [];

  lines.push(model.isoDate + (model.special ? '　' + model.special.title : ''));
  lines.push('');

  if (!attachment.ok) {
    lines.push('本週未附上 PDF（原因：' + attachmentReasonText_(attachment.reason) + '），以下為週報內容全文，供各位先行審閱。');
    lines.push('');
  }

  lines.push('【崇拜程序】');
  (model.program || []).forEach(function (r) {
    lines.push('　' + r.itemName + (r.content ? '　' + r.content : '') + (r.posture ? '　' + r.posture : ''));
  });
  lines.push('');

  lines.push('【本週事奉】');
  (model.dutyBoxPage1 || []).forEach(function (r) {
    lines.push('　' + r.label + '：' + (r.text || '（待填）'));
  });
  lines.push('');

  lines.push('【下週事奉】');
  (model.nextWeekDuty || []).forEach(function (r) {
    lines.push('　' + r.label + '：' + (r.text || '（待填）'));
  });
  lines.push('');

  // 待填清單必須包含（見檔頭說明）。
  lines.push('【尚未填寫的欄位】');
  if (includeMissing && model.missing && model.missing.length > 0) {
    model.missing.forEach(function (m) { lines.push('　' + m.label + '：' + m.reason); });
  } else {
    lines.push('　（無）');
  }
  lines.push('');

  var versionText = (model.rosterVersionUsed === null || model.rosterVersionUsed === undefined)
    ? '（尚未生成）' : String(model.rosterVersionUsed);
  lines.push('職事表版本：' + versionText + '　是否已正式發出：' + (model.rosterIsOfficial ? '是' : '否'));

  return lines.join('\n');
}
