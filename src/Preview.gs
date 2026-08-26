/**
 * Preview.gs
 *
 * R-033：**草稿預覽網頁**——一版由 Web App 自己出的純 HTML，讓 CC、DB
 * 在星期一就看到「下一個主日目前為止有什麼內容」。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 三個刻意的設計決定
 * ─────────────────────────────────────────────────────────────────────
 *
 * 1. **只做 HTML，不做 PDF、不做 Word、不經 Drive、不做任何轉檔。**
 *    要看的是**內容**，不是版面。轉檔那條路要處理 Drive 配額、暫存檔清理、
 *    格式走樣，換來的只是一份「看起來像但其實不是」的成品——而正式成品
 *    本來就會發佈。所以刻意不做。
 *
 * 2. **連結固定不變**（`?page=preview`，不帶日期就是下一個主日）。
 *    與 master 連結同一個道理：貼一次進群組，之後每星期打開都是最新一期。
 *    每星期換一條連結，等於每星期都要有人記得去換。
 *
 * 3. **完全唯讀**。頁面沒有任何 `<form>`、沒有 `google.script.run`、
 *    沒有任何可以改資料的入口。正因為唯讀，授權才可以放寬到網域內任何人
 *    （Config `PREVIEW_REQUIRE_ALLOWLIST`，預設 `FALSE`）——它的用途正是
 *    讓一堆人核對內容，逐個加進 `WEBAPP_ALLOWED_EMAILS` 不切實際。
 *
 * ⚠️ 頁面最頂**必須**有提示（Config `PREVIEW_NOTICE`）：純 HTML 與排版後的
 * 成品長得完全不同，不講清楚，看的人會以為週報就是排成這個樣。
 *
 * ⚠️ 未填的欄位一律顯示灰色的「（未填）」，**不留空白**——預覽的用途就是
 * 讓人看到有什麼未填。留空白等於把「未填」偽裝成「沒有這一項」。
 */

'use strict';

/** 未填欄位的顯示文字。集中一處，免得各處各寫一個。 */
var PREVIEW_BLANK_TEXT_ = '（未填）';

/**
 * 用途：讀出預覽相關的 Config。
 * Args: （無）
 * Returns:
 *   {{enabled:boolean, requireAllowlist:boolean, notice:string,
 *     sendGroups:string[], webAppUrl:string, timezone:string}}
 */
function previewConfig_() {
  return {
    enabled: normalizeBoolean_(getConfig(CONFIG_KEYS.PREVIEW_ENABLED, 'TRUE')) === true,
    requireAllowlist: normalizeBoolean_(getConfig(CONFIG_KEYS.PREVIEW_REQUIRE_ALLOWLIST, 'FALSE')) === true,
    notice: getConfig(CONFIG_KEYS.PREVIEW_NOTICE,
      '這是草稿預覽，只供核對內容。版面與正式印刷版不同，一切以正式發佈的週報為準。'),
    sendGroups: getConfigTextList_(CONFIG_KEYS.PREVIEW_SEND_GROUPS, 'CC,DB,ADMIN'),
    webAppUrl: String(getConfig(CONFIG_KEYS.PREVIEW_WEBAPP_URL, '') || '').trim(),
    timezone: getConfig(CONFIG_KEYS.SYS_TIMEZONE, 'Pacific/Auckland')
  };
}

/**
 * 用途：組出預覽網頁的連結。
 *
 *   ⚠️ 優先用 Config 的 `PREVIEW_WEBAPP_URL`：`ScriptApp.getService().getUrl()`
 *   在**觸發器**情境下有機會取不到（回空字串或拋錯），而星期一寄信正正是
 *   觸發器情境。取不到就寄一封沒有連結的信，那封信等於白寄。
 * Args:
 *   isoDate {string=} 選填。指定主日；不傳就是「下一個主日」那條固定連結。
 * Returns:
 *   {string} 完全取不到網址時回空字串——呼叫方要自己處理，不可以當成有連結。
 */
function buildPreviewUrl_(isoDate) {
  var base = String(getConfig(CONFIG_KEYS.PREVIEW_WEBAPP_URL, '') || '').trim();
  if (!base) {
    try {
      base = String(ScriptApp.getService().getUrl() || '').trim();
    } catch (err) {
      base = '';
    }
  }
  if (!base) return '';

  var url = base + (base.indexOf('?') === -1 ? '?' : '&') + 'page=preview';
  var iso = String(isoDate || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) url += '&date=' + iso;
  return url;
}

/**
 * 用途：判斷這一次預覽請求有沒有權限。
 *
 *   ⚠️ 預設**不受** `WEBAPP_ALLOWED_EMAILS` 限制（`PREVIEW_REQUIRE_ALLOWLIST`
 *   預設 `FALSE`）。理由見檔頭第 3 點：頁面完全唯讀，而它的用途正是讓一堆人
 *   核對內容。
 * Args: （無）
 * Returns:
 *   {boolean}
 */
function isPreviewCallerAuthorized_() {
  if (!previewConfig_().requireAllowlist) return true;
  return isCallerAuthorized_();
}

/**
 * 用途：決定預覽要顯示哪一個主日。
 *
 *   ⚠️ 不帶日期就是「下一個主日」，而且用的是與星期一寄週報**同一支**
 *   `resolveNextSendSundayIso_()`——兩處各自算一次「下一個主日」，遲早會
 *   在某個星期給出不同答案，而那種不一致最難查。
 * Args:
 *   requestedIso {*} 網址帶來的 `date` 參數；不合法一律當成沒有傳。
 * Returns:
 *   {{isoDate:string, requested:boolean, message:string}}
 *     `isoDate` 空字串代表連下一個主日都算不到。
 */
function resolvePreviewIsoDate_(requestedIso) {
  var iso = String(requestedIso || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    return { isoDate: iso, requested: true, message: '' };
  }

  var schedule = resolveNextSendSundayIso_();
  if (schedule.ok) {
    return { isoDate: schedule.isoDate, requested: false, message: '' };
  }
  return {
    isoDate: '',
    requested: false,
    message: '算不到下一個主日：' + (schedule.reason || '原因不明')
      + '　請在網址加上 &date=YYYY-MM-DD 指定要看哪一個主日。'
  };
}

/**
 * 用途：把一個值變成可以直接放進 HTML 的文字；空值一律變成灰色的
 *   「（未填）」。**純函式。**
 *
 *   ⚠️ 空值**不可以**回空字串。預覽的用途就是讓人看到有什麼未填；
 *   留空白等於把「未填」偽裝成「沒有這一項」。
 * Args:
 *   value {*} 任意值。
 * Returns:
 *   {string} 已經跳脫過的 HTML 片段。
 */
function previewCell_(value) {
  var text = String(value === null || value === undefined ? '' : value).trim();
  if (!text) return '<span class="blank">' + escapeHtml_(PREVIEW_BLANK_TEXT_) + '</span>';
  return escapeHtml_(text);
}

/**
 * 用途：組出預覽網頁的完整 HTML。**純函式**（除了跳脫，什麼都不做）。
 *
 *   ⚠️ 刻意不用 `HtmlService.createTemplateFromFile()`：這一版是唯讀的
 *   靜態內容，用樣板反而要多一個檔案、多一層變數傳遞，而且樣板那邊很容易
 *   不小心加了 `google.script.run`（就不再是唯讀了）。整版由這一支砌出來，
 *   「頁面沒有任何寫入入口」這件事一眼看得完。
 * Args:
 *   data {Object} `buildPreviewData_()` 的輸出。
 * Returns:
 *   {string} 完整的 HTML。
 */
function renderPreviewHtml_(data) {
  var d = data || {};
  var html = [];

  html.push('<!DOCTYPE html><html lang="zh-Hant"><head><meta charset="utf-8">');
  html.push('<meta name="viewport" content="width=device-width, initial-scale=1">');
  html.push('<title>' + escapeHtml_(d.pageTitle || '週報草稿預覽') + '</title>');
  html.push('<style>' + previewCss_() + '</style>');
  html.push('</head><body>');

  // ---- 最頂那段提示：一定要在最前，而且要明顯 ----
  html.push('<div class="notice">' + escapeHtml_(d.notice || '') + '</div>');

  html.push('<h1>' + escapeHtml_(d.pageTitle || '週報草稿預覽') + '</h1>');
  html.push('<p class="meta">主日日期：<b>' + previewCell_(d.isoDate) + '</b>'
    + '　　使用的範本：' + previewCell_(d.templateLabel) + '</p>');

  if (d.errorMessage) {
    html.push('<p class="error">' + escapeHtml_(d.errorMessage) + '</p>');
    html.push('</body></html>');
    return html.join('');
  }

  if (d.rosterPendingNote) {
    html.push('<p class="pending">' + escapeHtml_(d.rosterPendingNote) + '</p>');
  }

  (d.sections || []).forEach(function (section) {
    html.push('<h2>' + escapeHtml_(section.title) + '</h2>');
    html.push(renderPreviewSection_(section));
  });

  html.push('<div class="footer">');
  (d.footerLines || []).forEach(function (line) {
    html.push('<div>' + escapeHtml_(line) + '</div>');
  });
  html.push('</div>');

  html.push('</body></html>');
  return html.join('');
}

/**
 * 用途：把一個區塊排成 HTML。**純函式。**
 * Args:
 *   section {{title:string, kind:string, columns:string[]=, rows:Array=,
 *     items:Array=}} 區塊定義。`kind` 是 `TABLE`／`LIST`／`PAIRS`。
 * Returns:
 *   {string}
 */
function renderPreviewSection_(section) {
  var s = section || {};
  var out = [];

  if (s.kind === 'LIST') {
    var items = s.items || [];
    if (items.length === 0) {
      return '<p class="blank">' + escapeHtml_(PREVIEW_BLANK_TEXT_) + '</p>';
    }
    out.push('<ol>');
    items.forEach(function (item) { out.push('<li>' + previewCell_(item) + '</li>'); });
    out.push('</ol>');
    return out.join('');
  }

  if (s.kind === 'PAIRS') {
    var pairs = s.rows || [];
    if (pairs.length === 0) {
      return '<p class="blank">' + escapeHtml_(PREVIEW_BLANK_TEXT_) + '</p>';
    }
    out.push('<table class="pairs">');
    pairs.forEach(function (pair) {
      out.push('<tr><th>' + escapeHtml_(pair[0]) + '</th><td>' + previewCell_(pair[1]) + '</td></tr>');
    });
    out.push('</table>');
    return out.join('');
  }

  // TABLE
  var rows = s.rows || [];
  if (rows.length === 0) {
    return '<p class="blank">' + escapeHtml_(PREVIEW_BLANK_TEXT_) + '</p>';
  }
  out.push('<table>');
  if (s.columns && s.columns.length > 0) {
    out.push('<tr>');
    s.columns.forEach(function (c) { out.push('<th>' + escapeHtml_(c) + '</th>'); });
    out.push('</tr>');
  }
  rows.forEach(function (row) {
    out.push('<tr>');
    (row || []).forEach(function (cell) { out.push('<td>' + previewCell_(cell) + '</td>'); });
    out.push('</tr>');
  });
  out.push('</table>');
  return out.join('');
}

/**
 * 用途：預覽網頁的樣式。刻意極簡——這一版的用途是核對內容，不是排版。
 * Args: （無）
 * Returns:
 *   {string}
 */
function previewCss_() {
  return [
    'body{font-family:"Noto Sans TC","Microsoft JhengHei",sans-serif;max-width:52em;',
    'margin:0 auto;padding:1em 1.2em 4em;line-height:1.7;color:#222;}',
    '.notice{background:#fff4d6;border:1px solid #e0be5e;border-radius:4px;',
    'padding:0.8em 1em;margin:0 0 1.2em;font-weight:bold;color:#6b4e00;}',
    'h1{font-size:1.5em;margin:0.6em 0 0.2em;}',
    'h2{font-size:1.1em;margin:1.6em 0 0.4em;padding-bottom:0.2em;border-bottom:2px solid #dde3ea;}',
    '.meta{color:#555;margin:0 0 1em;}',
    '.pending{background:#eef4ff;border-left:4px solid #4a7dd0;padding:0.6em 0.9em;color:#1e3f75;}',
    '.error{background:#fdeceb;border-left:4px solid #c0392b;padding:0.6em 0.9em;color:#8c231c;}',
    'table{border-collapse:collapse;width:100%;margin:0.2em 0 0.6em;}',
    'th,td{border:1px solid #dde3ea;padding:0.35em 0.6em;text-align:left;vertical-align:top;}',
    'th{background:#f4f7fa;font-weight:600;white-space:nowrap;}',
    'table.pairs th{width:11em;}',
    'ol{margin:0.2em 0 0.6em;padding-left:1.6em;}',
    'li{margin:0.15em 0;}',
    '.blank{color:#999;}',
    '.footer{margin-top:2.5em;padding-top:0.8em;border-top:1px solid #dde3ea;',
    'color:#666;font-size:0.9em;}'
  ].join('');
}

/**
 * 用途：把週報資料模型攤成預覽網頁要顯示的區塊。**純函式。**
 *
 *   ⚠️ 次序刻意照足週報本身：主日日期／範本 → 崇拜程序 → 本週事奉 →
 *   上週人數 → 下週事奉 → 獻花 → 家事報告 → 代禱 → 團契 → 財政。
 *   核對的人是拿住紙本或者印象在對，次序一亂就要重新找。
 *
 *   ⚠️ 空的清單**不可以**靜靜不顯示那個區塊——區塊照出，內容顯示
 *   「（未填）」。看不見「代禱事項」那一段，看的人分不出「這一期沒有代禱」
 *   與「這一段還未填」。
 * Args:
 *   model {Object} `buildBulletinModel_()` 的輸出。
 *   options {{notice:string, footerLines:string[]=,
 *     rosterPendingNote:string=}=} 選填。
 * Returns:
 *   {Object} 見 `renderPreviewHtml_()`。
 */
function buildPreviewData_(model, options) {
  var m = model || {};
  var o = options || {};
  var header = m.header || {};

  var sections = [];

  // ---- 崇拜程序 ----
  sections.push({
    title: '崇拜程序',
    kind: 'TABLE',
    columns: ['項目', '內容', '姿勢'],
    rows: (m.program || []).map(function (row) {
      return [row.itemName, row.content, row.posture];
    })
  });

  // ---- 本週事奉 ----
  sections.push({
    title: '本週事奉',
    kind: 'PAIRS',
    rows: (m.dutyBoxPage1 || []).map(function (row) { return [row.label, row.text]; })
  });

  // ---- 上週崇拜人數 ----
  var attendance = m.attendance || { columns: [], rows: [] };
  sections.push({
    title: (header.attendanceHeading || '上週崇拜人數')
      + '（' + (header.attendanceDate || '') + '）',
    kind: 'TABLE',
    columns: [''].concat(attendance.columns || []),
    rows: (attendance.rows || []).map(function (row) {
      return [row.label].concat(row.values || []);
    })
  });

  // ---- 下週事奉 ----
  sections.push({
    title: (header.nextWeekHeading || '下週事奉')
      + '（' + (header.nextWeekDate || '') + '）',
    kind: 'PAIRS',
    rows: (m.nextWeekDuty || []).map(function (row) { return [row.label, row.text]; })
  });

  // ---- 獻花 ----
  var flowers = m.flowers || {};
  sections.push({
    title: '獻花',
    kind: 'PAIRS',
    rows: [['本週', flowers.thisWeek], ['下週', flowers.nextWeek]]
  });

  // ---- 家事報告 ----
  sections.push({
    title: '家事報告',
    kind: 'LIST',
    items: (m.announcements || []).map(function (a) { return a.text; })
  });

  // ---- 代禱事項 ----
  var prayerBlock = m.prayerBlock || {};
  sections.push({
    title: prayerBlock.heading || '代禱事項',
    kind: 'LIST',
    items: (prayerBlock.items || []).map(function (p) { return p.text; })
  });

  // ---- 本週團契聚會 ----
  sections.push({
    title: '本週團契聚會',
    kind: 'TABLE',
    columns: ['團契', '日期', '時間', '內容'],
    rows: (m.fellowships || []).map(function (f) {
      return [f.fellowshipName, f.meetingDate, f.meetingTime, f.content];
    })
  });

  // ---- 財政報告 ----
  sections.push({
    title: '財政報告',
    kind: 'TABLE',
    columns: ['項目', '欄一', '欄二', '欄三', '欄四'],
    rows: (m.finance || []).map(function (r) {
      return [r.rowLabel, r.specialOverseas, r.hardship, r.col3, r.col4];
    })
  });

  return {
    pageTitle: (header.pageTitle || '崇拜程序') + '　草稿預覽',
    notice: o.notice || '',
    isoDate: m.isoDate || '',
    templateLabel: m.templateId || '',
    rosterPendingNote: o.rosterPendingNote || '',
    sections: sections,
    footerLines: o.footerLines || [],
    errorMessage: ''
  };
}

/**
 * 用途：組出預覽頁尾那幾行：資料最後更新時間、內容表最後匯入時間、
 *   目前是否已發佈。
 *
 *   ⚠️ 三樣都要講「幾時」，不只講「有沒有」。核對的人最想知道的是
 *   「我看到的是不是最新的」——沒有時間，那一句答不到。
 * Args:
 *   isoDate {string} 主日日期。
 *   model {Object} 週報資料模型。
 *   timezone {string} 時區。
 * Returns:
 *   {string[]}
 */
function buildPreviewFooterLines_(isoDate, model, timezone) {
  var lines = [];
  var tz = timezone || 'Pacific/Auckland';

  function fmt(value) {
    if (Object.prototype.toString.call(value) !== '[object Date]') return '';
    return Utilities.formatDate(value, tz, 'yyyy-MM-dd HH:mm');
  }

  var weekRow = findBulletinWeekRow_(readSheet(SHEETS.BULLETIN_WEEKS), isoDate) || {};
  var savedAt = fmt(weekRow.LAST_SAVED_AT);
  lines.push('資料最後更新：' + (savedAt || '（未有紀錄——這一期未經填寫介面儲存過）'));

  var importedAt = '';
  try {
    var contentRow = findContentSheetRow_((model || {}).quarterId || '');
    if (contentRow) importedAt = fmt(contentRow.LAST_IMPORTED_AT);
  } catch (err) {
    importedAt = '';
  }
  lines.push('內容表最後匯入：' + (importedAt || '（未匯入過，或者本季未建立內容表）'));

  var published = readSheet(SHEETS.PUBLISH_LOG).filter(function (r) {
    return r.IS_SELFTEST !== true && publishRowIsoDate_(r) === isoDate;
  });
  if (published.length === 0) {
    lines.push('發佈狀態：尚未發佈');
  } else {
    var maxVersion = 0;
    published.forEach(function (r) {
      var v = Number(r.VERSION_NO || 0);
      if (v > maxVersion) maxVersion = v;
    });
    lines.push('發佈狀態：已發佈（第 ' + maxVersion + ' 版）');
  }

  lines.push('這一頁是唯讀的草稿預覽，改資料請去填寫介面。');
  return lines;
}

/**
 * 用途：預覽網頁的**真正入口**：由主日日期組出整版 HTML。
 * Args:
 *   requestedIso {*} 網址帶來的 `date` 參數（可以是空的）。
 * Returns:
 *   {{html:string, isoDate:string, ok:boolean}}
 */
function buildPreviewPage_(requestedIso) {
  var config = previewConfig_();
  var resolved = resolvePreviewIsoDate_(requestedIso);

  if (!resolved.isoDate) {
    return {
      ok: false,
      isoDate: '',
      html: renderPreviewHtml_({
        pageTitle: '週報草稿預覽',
        notice: config.notice,
        isoDate: '',
        templateLabel: '',
        sections: [],
        footerLines: [],
        errorMessage: resolved.message
      })
    };
  }

  var model;
  try {
    model = buildBulletinModel_(resolved.isoDate);
  } catch (err) {
    return {
      ok: false,
      isoDate: resolved.isoDate,
      html: renderPreviewHtml_({
        pageTitle: '週報草稿預覽',
        notice: config.notice,
        isoDate: resolved.isoDate,
        templateLabel: '',
        sections: [],
        footerLines: [],
        errorMessage: '組不出這一個主日的資料：'
          + ((err && err.message) ? err.message : String(err))
      })
    };
  }

  // ⚠️ 職事表未有該季資料時**照樣顯示**，只是加一句說明——那正是 R-036
  //    的整個用意：未到時候不是錯誤。
  var pendingNote = '';
  if (model.found !== true) {
    pendingNote = getConfig(CONFIG_KEYS.BULLETIN_ROSTER_PENDING_NOTE,
      '本期事奉資料尚未確定，稍後另行通知。');
  }

  var data = buildPreviewData_(model, {
    notice: config.notice,
    rosterPendingNote: pendingNote,
    footerLines: buildPreviewFooterLines_(resolved.isoDate, model, config.timezone)
  });

  return { ok: true, isoDate: resolved.isoDate, html: renderPreviewHtml_(data) };
}

// =====================================================================
// 星期一寄出草稿預覽連結（R-033）
// =====================================================================

/**
 * 用途：把草稿預覽的連結寄給 `PREVIEW_SEND_GROUPS` 那幾組人。
 *
 *   ⚠️ 沿用**現有那一支**星期一觸發器（`weeklyBulletinSendTrigger_`），
 *   不另外安裝一個。多一個觸發器就多一個要記得安裝、記得移除、記得檢查
 *   有沒有重複的東西；而且兩個觸發器的執行時間不保證一致，「週報同預覽
 *   講的是不是同一個主日」會變成一條要查的問題。
 *
 *   ⚠️ 職事表未有該季資料時**照樣寄**，並在信中加一句
 *   `BULLETIN_ROSTER_PENDING_NOTE`。R-036 的整個用意就是「未到時候不是
 *   錯誤」——預覽正正是給人看「目前為止有什麼」，事奉未定更加要看得到。
 *
 *   ⚠️ 受 `DRY_RUN` 保護，而且**不論真寄與否都寫 `SendLog`**
 *   （`STATUS='PREVIEW'`）。只在真寄時才寫的話，`DRY_RUN` 之下就完全看不出
 *   「本來會寄給誰」，等於試行模式什麼都驗不到。
 * Args:
 *   isoDate {string} 下一個主日。
 * Returns:
 *   {{sent:boolean, reason:string, dryRun:boolean, recipientCount:number,
 *     previewUrl:string, message:string}}
 *     `sent:false` 有幾種原因，一律用 `reason` 分辨，不會拋錯——寄不到預覽
 *     不應該連累寄週報。
 */
function sendPreviewNotice_(isoDate) {
  var config = previewConfig_();
  var dryRun = normalizeBoolean_(getConfig(CONFIG_KEYS.DRY_RUN, 'TRUE')) === true;
  var out = {
    sent: false, reason: '', dryRun: dryRun, recipientCount: 0,
    previewUrl: '', message: ''
  };

  if (!config.enabled) {
    out.reason = 'DISABLED';
    out.message = 'Config 的 ' + CONFIG_KEYS.PREVIEW_ENABLED + ' 是 FALSE，沒有寄草稿預覽。';
    return out;
  }

  var previewUrl = buildPreviewUrl_();
  out.previewUrl = previewUrl;
  if (!previewUrl) {
    out.reason = 'NO_URL';
    out.message = '取不到 Web App 的網址，所以沒有寄——寄一封沒有連結的信等於白寄。'
      + '請在 Config 的 ' + CONFIG_KEYS.PREVIEW_WEBAPP_URL + ' 填入部署後的網頁應用程式網址。';
    return out;
  }

  var recipientsResult = buildRecipientList_(
    readSheet(SHEETS.RECIPIENTS), config.sendGroups, normalizeDate_(isoDate));
  if (recipientsResult.recipients.length === 0) {
    out.reason = 'NO_RECIPIENTS';
    out.message = 'Recipients 內沒有任何屬於 ' + config.sendGroups.join('、')
      + ' 而且有效的收件人，所以沒有寄。';
    return out;
  }

  var template = readSheet(SHEETS.EMAIL_TEMPLATES).filter(function (t) {
    return t.TEMPLATE_ID === PREVIEW_EMAIL_TEMPLATE_ID_ && t.ACTIVE === true;
  })[0];
  if (!template) {
    out.reason = 'TEMPLATE_NOT_FOUND';
    out.message = 'EmailTemplates 找不到啟用中的範本「' + PREVIEW_EMAIL_TEMPLATE_ID_
      + '」，所以沒有寄。請執行選單「初始化工作表」補回那一行。';
    return out;
  }

  // 職事表未有資料時要加的那一句。
  var pendingNote = '';
  try {
    var model = buildBulletinModel_(isoDate);
    if (model.found !== true) {
      pendingNote = getConfig(CONFIG_KEYS.BULLETIN_ROSTER_PENDING_NOTE,
        '本期事奉資料尚未確定，稍後另行通知。');
    }
  } catch (modelErr) {
    // 組不出模型不應該令預覽信寄不出——那封信的重點是那條連結。
    pendingNote = '';
  }

  var vars = {
    ChurchName: getConfig(CONFIG_KEYS.CHURCH_NAME, ''),
    ServiceDate: isoDate,
    PreviewUrl: previewUrl,
    RosterPendingNote: pendingNote
  };
  var subject = renderEmailTemplate_(String(template.SUBJECT || ''), vars, []);
  var plainBody = renderEmailTemplate_(String(template.BODY || ''), vars, []);

  var sendLogRows = [];
  recipientsResult.recipients.forEach(function (recipient) {
    var status = 'PREVIEW';
    var errorMessage = '';

    if (!dryRun) {
      try {
        MailApp.sendEmail({ to: recipient.email, subject: subject, body: plainBody });
      } catch (mailErr) {
        status = 'FAILED';
        errorMessage = (mailErr && mailErr.message) ? mailErr.message : String(mailErr);
      }
    }

    sendLogRows.push({
      TIMESTAMP: new Date(),
      SERVICE_DATE: normalizeDate_(isoDate),
      RECIPIENT_EMAIL: sanitizeCellText_(recipient.email),
      SUBJECT: sanitizeCellText_(subject),
      STATUS: status,
      DRY_RUN: dryRun,
      ROSTER_VERSION_USED: '',
      ERROR: sanitizeCellText_(errorMessage),
      BODY_PREVIEW: buildSendLogBodyPreview_(plainBody)
    });
  });

  writeSendLogRows_(sendLogRows);

  out.sent = true;
  out.reason = 'OK';
  out.recipientCount = recipientsResult.recipients.length;
  out.message = (dryRun ? '（試行）' : '') + '草稿預覽連結已寄給 '
    + recipientsResult.recipients.length + ' 個收件人。';
  return out;
}

/** 草稿預覽信用哪一個 `EmailTemplates` 範本。 */
var PREVIEW_EMAIL_TEMPLATE_ID_ = 'PREVIEW_NOTICE';
