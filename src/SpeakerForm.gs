/**
 * SpeakerForm.gs
 *
 * 講員表格（Google Form）：讓講員自己填證道講題與讀經經文，答案直接寫進週報。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 三個已定的決定（見 docs/需求登記_第二批.md）
 * ─────────────────────────────────────────────────────────────────────
 *
 *   1. 只限教會帳戶填寫：表單設成同網域登入才可以填，自動收集已驗證電郵。
 *   2. 答案直接寫進週報：不經幹事匯入。寫入的方式只有兩條，而且都重用既有
 *      函式，不另寫一套寫入邏輯：
 *        - 該季已有內容表 → 把「讀經經文」「證道講題」寫進內容表「崇拜程序」
 *          分頁該主日那一行，再用既有的匯入只匯入該主日、只限那一張分頁；
 *        - 該季未有內容表 → 直接寫 `BulletinWeeks` 那兩格（日後建立內容表時
 *          由既有的回填帶入）。
 *   3. 表格上的「講員」只作核對：不改事奉框，也不改職事表。講員與事奉框
 *      不同時，週報的警告區出 `SPEAKER_FORM_MISMATCH`，由人決定。
 *
 * ⚠️ 那一格有生效中的人手覆寫（`FieldOverride`）→ 不蓋過，結果記
 *    `BLOCKED_BY_OVERRIDE` 並通知管理員（與內容表匯入的「你自己改過」同一個規則）。
 *
 * ⚠️ 所有 `FormApp` 呼叫集中在 `src/SpeakerFormIo.gs`；本檔案不碰 `FormApp`、
 *    `DriveApp`，也不拿職事表的設定鍵。
 */

'use strict';

// =====================================================================
// 純函式層
// =====================================================================

/**
 * 用途：讀出五個題目的字眼（Config）。答案靠這些字眼對應題目。
 * Args: （無）
 * Returns:
 *   {{date:string, speaker:string, scripture:string, title:string, notes:string}}
 */
function speakerFormQuestionTitles_() {
  function read(key, fallback) {
    return String(getConfig(key, fallback) || '').trim() || fallback;
  }
  return {
    date: read(CONFIG_KEYS.SPEAKER_FORM_Q_DATE, '主日日期'),
    speaker: read(CONFIG_KEYS.SPEAKER_FORM_Q_SPEAKER, '講員'),
    scripture: read(CONFIG_KEYS.SPEAKER_FORM_Q_SCRIPTURE, '讀經經文'),
    title: read(CONFIG_KEYS.SPEAKER_FORM_Q_TITLE, '證道講題'),
    notes: read(CONFIG_KEYS.SPEAKER_FORM_Q_NOTES, '備註')
  };
}

/**
 * 用途：把處理結果代碼換成中文名稱。純函式。
 * Args:
 *   code {string} `SPEAKER_FORM_RESULTS` 的鍵。
 * Returns:
 *   {string} 查不到就原樣回代碼。
 */
function speakerFormResultLabel_(code) {
  var key = String(code === null || code === undefined ? '' : code);
  return Object.prototype.hasOwnProperty.call(SPEAKER_FORM_RESULTS, key) ? SPEAKER_FORM_RESULTS[key] : key;
}

/**
 * 用途：把樣式字串內的 `{{KEY}}` 換成對應的值，沒有提供的 KEY 原樣保留。
 *   純函式。
 * Args:
 *   pattern {string} 樣式。
 *   vars {Object<string,string>} KEY → 值。
 * Returns:
 *   {string}
 */
function fillSpeakerFormPattern_(pattern, vars) {
  return String(pattern === null || pattern === undefined ? '' : pattern).replace(/\{\{([A-Z_]+)\}\}/g, function (whole, key) {
    return Object.prototype.hasOwnProperty.call(vars || {}, key) ? String(vars[key]) : whole;
  });
}

/**
 * 用途：算出「主日日期」下拉要列出的選項。純函式。
 *   `BulletinWeeks` 內未封存、由今日起（含今日）最近的 N 個主日；有特別主日
 *   的附上名稱（樣式見 Config `SPEAKER_FORM_DATE_SPECIAL_PATTERN`）。
 * Args:
 *   weekRows {Object[]} `BulletinWeeks` 的資料列。
 *   todayIso {string} 今日，yyyy-MM-dd。
 *   weeksAhead {*} 最多列幾個主日；不是正整數就用 16。
 *   pattern {string} 有特別主日時的字眼樣式。
 * Returns:
 *   {{isoDate:string, label:string}[]} 由近到遠。
 */
function buildSpeakerFormDateOptions_(weekRows, todayIso, weeksAhead, pattern) {
  var limit = Number(weeksAhead);
  if (!Number.isFinite(limit) || limit < 1) limit = 16;

  var seen = {};
  var rows = [];
  (weekRows || []).forEach(function (row) {
    if (row.ARCHIVED === true) return;
    var iso = fieldOverrideIsoOf_(row.SERVICE_DATE);
    if (!iso || iso < todayIso || seen[iso]) return;
    seen[iso] = true;
    rows.push({ isoDate: iso, special: String(row.SPECIAL_TYPE || '').trim() });
  });
  rows.sort(function (a, b) { return a.isoDate < b.isoDate ? -1 : (a.isoDate > b.isoDate ? 1 : 0); });

  return rows.slice(0, Math.floor(limit)).map(function (row) {
    return {
      isoDate: row.isoDate,
      label: row.special ? fillSpeakerFormPattern_(pattern, { DATE: row.isoDate, SPECIAL: row.special }) : row.isoDate
    };
  });
}

/**
 * 用途：由「主日日期」那一題的答案文字認出日期（取開頭的 yyyy-MM-dd，後面的
 *   特別主日名稱不理）。純函式。
 * Args:
 *   text {string} 答案文字，例如 `2028-05-28（瀏覽器測試合堂）`。
 * Returns:
 *   {string} 認不出（或日期不存在）回空字串。
 */
function parseSpeakerFormDateChoice_(text) {
  var m = /^\s*(\d{4}-\d{2}-\d{2})/.exec(String(text === null || text === undefined ? '' : text));
  if (!m) return '';
  try {
    return normalizeDate_(m[1]) ? m[1] : '';
  } catch (err) {
    return '';
  }
}

/**
 * 用途：把講員名字正規化成可以比較的形式：去掉尊稱（長的先去）、去掉所有空白
 *   （包括全形空白），英文字母轉小寫。純函式。
 * Args:
 *   name {*} 名字。
 *   honorifics {string[]} 要去掉的尊稱清單（Config `SPEAKER_NAME_HONORIFICS`）。
 * Returns:
 *   {string}
 */
function normalizeSpeakerName_(name, honorifics) {
  var text = String(name === null || name === undefined ? '' : name);
  (honorifics || []).slice().sort(function (a, b) { return b.length - a.length; }).forEach(function (word) {
    if (word) text = text.split(word).join('');
  });
  return text.replace(/[\s　]+/g, '').toLowerCase();
}

/**
 * 用途：由職事表快照（已套用事奉框覆寫）的 `slotsByPost` 取出事奉框的講員。
 *   純函式。
 * Args:
 *   slotsByPost {Object<string,Object[]>} 快照的 `slotsByPost`。
 * Returns:
 *   {string} 多位用頓號串起來；沒有就是空字串。
 */
function speakerNameFromSlots_(slotsByPost) {
  var slots = ((slotsByPost || {}).PREACHER) || [];
  return slots.map(function (slot) { return String(slot.personName || '').trim(); })
    .filter(function (name) { return name !== ''; }).join('、');
}

/**
 * 用途：在答案記錄內找出某個主日最新的一份（有效的、不是處理出錯的）。
 *   純函式。
 * Args:
 *   rows {Object[]} `SpeakerFormSubmissions` 的資料列。
 *   isoDate {string} 主日日期。
 * Returns:
 *   {?Object} 找不到回 `null`。提交時間相同就以工作表上較後面的一行為準。
 */
function pickLatestSpeakerAnswer_(rows, isoDate) {
  var best = null;
  var bestTime = -Infinity;
  (rows || []).forEach(function (row) {
    if (row.ACTIVE === false || row.RESULT === 'ERROR') return;
    if (fieldOverrideIsoOf_(row.SERVICE_DATE) !== isoDate) return;
    var time = dateCellToTime_(row.TIMESTAMP);
    var ms = time === null ? -1 : time;
    // `>=`：提交時間相同就以工作表上較後面的一行為準。
    if (best === null || ms >= bestTime) {
      best = row;
      bestTime = ms;
    }
  });
  return best;
}

/**
 * 用途：講員核對：表格填的講員與事奉框的講員不同時，給出警告。純函式。
 *   名字先正規化（去尊稱、去空白），正規化之後相同才不出警告。
 * Args:
 *   formSpeaker {string} 表格填的講員。
 *   rosterSpeaker {string} 事奉框的講員（職事表值套用覆寫之後）。
 *   honorifics {string[]} 尊稱清單。
 * Returns:
 *   {?{code:string, message:string}} 一樣回 `null`。
 */
function buildSpeakerMismatchWarning_(formSpeaker, rosterSpeaker, honorifics) {
  if (normalizeSpeakerName_(formSpeaker, honorifics) === normalizeSpeakerName_(rosterSpeaker, honorifics)) return null;
  var roster = String(rosterSpeaker || '').trim();
  return {
    code: 'SPEAKER_FORM_MISMATCH',
    message: '講員表格填的講員是「' + String(formSpeaker || '').trim() + '」，事奉框是「' + (roster || '（空白）')
      + '」。如果真的換了講員，請在事奉框改「講員」；職事表要另外更正。'
  };
}

/**
 * 用途：週報資料模型用的講員核對：讀答案記錄、找該主日最新一份、與事奉框
 *   講員比較。讀不到答案記錄（工作表未建立）不當成錯誤——那只代表還沒有
 *   人用過講員表格，不應該令週報生不出來。
 * Args:
 *   isoDate {string} 主日日期。
 *   slotsByPost {Object} 已套用事奉框覆寫的快照 `slotsByPost`。
 * Returns:
 *   {?{code:string, message:string}} 沒有答案或一致回 `null`。
 */
function speakerMismatchWarningForModel_(isoDate, slotsByPost) {
  var rows;
  try {
    rows = readSheet(SHEETS.SPEAKER_FORM_SUBMISSIONS);
  } catch (err) {
    return null;
  }
  var latest = pickLatestSpeakerAnswer_(rows, isoDate);
  if (!latest) return null;
  return buildSpeakerMismatchWarning_(
    latest.SPEAKER_NAME, speakerNameFromSlots_(slotsByPost),
    getConfigTextList_(CONFIG_KEYS.SPEAKER_NAME_HONORIFICS, '')
  );
}

/**
 * 用途：由表單提交事件取出一份答案。不拋「找不到題目」的錯——找不到的題目
 *   記進 `missingQuestions`，由呼叫方照樣把這份答案記下來（結果 `ERROR`），
 *   不可以讓一份答案因為題目字眼對不上就憑空消失。
 * Args:
 *   event {Object} 表單提交事件，要有 `response`。
 *   titles {Object} `speakerFormQuestionTitles_()`。
 * Returns:
 *   {{email:string, timestamp:*, dateText:string, isoDate:string, speaker:string,
 *     scripture:string, title:string, notes:string, missingQuestions:string[]}}
 * Raises:
 *   Error 如果事件沒有 `response`（不是表單提交事件）。
 */
function extractSpeakerFormAnswers_(event, titles) {
  var response = event && event.response;
  if (!response) {
    throw new Error('extractSpeakerFormAnswers_：事件沒有 response，不是表單提交事件。');
  }

  var byTitle = {};
  response.getItemResponses().forEach(function (itemResponse) {
    var title = String(itemResponse.getItem().getTitle() || '').trim();
    var value = itemResponse.getResponse();
    if (Array.isArray(value)) value = value.join('、');
    byTitle[title] = String(value === null || value === undefined ? '' : value).trim();
  });

  var missing = [];
  function pick(key, required) {
    var title = titles[key];
    if (Object.prototype.hasOwnProperty.call(byTitle, title)) return byTitle[title];
    if (required) missing.push(title);
    return '';
  }

  var dateText = pick('date', true);
  var answer = {
    email: String(response.getRespondentEmail() || '').trim(),
    timestamp: response.getTimestamp(),
    dateText: dateText,
    isoDate: parseSpeakerFormDateChoice_(dateText),
    speaker: pick('speaker', true),
    scripture: pick('scripture', true),
    title: pick('title', true),
    notes: pick('notes', false),
    missingQuestions: missing
  };
  return answer;
}

/**
 * 用途：篩出某個主日的發佈記錄（不含自測發佈）。純函式。
 *   版本記錄列表與講員表格通知共用，「這個主日有沒有發佈過」只有一個定義。
 * Args:
 *   rows {Object[]} `PublishLog` 的資料列。
 *   isoDate {string} 主日日期。
 * Returns:
 *   {Object[]}
 */
function filterPublishedRowsForDate_(rows, isoDate) {
  return (rows || []).filter(function (row) {
    return row.IS_SELFTEST !== true && fieldOverrideIsoOf_(row.SERVICE_DATE) === isoDate;
  });
}

/**
 * 用途：組出通知信的主旨、純文字與 HTML 內文。純函式。
 * Args:
 *   input {{churchName:string, subjectPattern:string, answer:Object, resultCode:string,
 *     resultDetail:string, special:string, mismatchText:string, published:boolean,
 *     webAppUrl:string}}
 * Returns:
 *   {{subject:string, plain:string, html:string}}
 */
function buildSpeakerFormNotice_(input) {
  var a = input.answer;
  var resultLabel = speakerFormResultLabel_(input.resultCode);
  var subject = fillSpeakerFormPattern_(input.subjectPattern, {
    CHURCH: input.churchName, SERVICE_DATE: a.isoDate || a.dateText || '（日期不明）', RESULT: resultLabel
  });

  var lines = [
    ['主日', (a.isoDate || a.dateText || '（日期不明）') + (input.special ? '（' + input.special + '）' : '')],
    ['答題者', a.email || '（查不到電郵）'],
    ['講員', a.speaker],
    ['讀經經文', a.scripture],
    ['證道講題', a.title],
    ['備註', a.notes || '（沒有）'],
    ['寫入結果', resultLabel + (input.resultDetail ? '：' + input.resultDetail : '')],
    ['講員核對', input.mismatchText]
  ];
  var extra = [];
  if (input.published) extra.push('這一期已經發佈，表格的改動不會自動更新已發佈的 PDF。');
  extra.push('填寫介面：' + (input.webAppUrl || '（Config 的 WEBAPP_URL 尚未填寫）'));

  var plain = lines.map(function (pair) { return pair[0] + '：' + pair[1]; }).concat(extra).join('\n');
  var html = '<div style="font-family:sans-serif;line-height:1.7;">'
    + lines.map(function (pair) { return '<p><b>' + escapeHtml_(pair[0]) + '</b>：' + escapeHtml_(pair[1]) + '</p>'; }).join('')
    + extra.map(function (line) { return '<p>' + escapeHtml_(line) + '</p>'; }).join('')
    + '</div>';
  return { subject: subject, plain: plain, html: html };
}

/**
 * 用途：講員表格現況的檢查結果轉成一個檢測項目（狀態＋說明）。純函式。
 *   「上線前檢查」與「完成度自我檢測」共用，判斷只有一處。
 *
 *   紅燈＝一定會出問題（開不到、沒有限教會帳戶、觸發器不是剛好一個、資料夾不在
 *   Shared Drive）；黃燈＝還沒建立，或者查不到（⚠️ 「查不到」不等於「沒問題」）。
 * Args:
 *   state {{created:boolean, folderId:string, folderIsSharedDrive:?boolean,
 *     triggerCount:?number, form:?Object}} `inspectSpeakerFormState_()` 的輸出。
 *   statuses {Object} `SELF_CHECK_STATUS_`。
 * Returns:
 *   {{status:string, message:string}}
 */
function buildSpeakerFormCheckItem_(state, statuses) {
  if (!state.created) {
    return {
      status: statuses.YELLOW,
      message: '尚未建立講員表格。要讓講員自己填證道講題與經文，請在填寫介面「講員表格」區塊按「建立講員表格」。'
    };
  }

  var problems = [];
  var unknown = [];
  var form = state.form;
  if (!form || form.reachable !== true) {
    problems.push('表格開不到（' + ((form && form.error) || '原因不明') + '）。可能被刪除、沒有權限，或者部署後還沒有重新授權 forms 範圍');
  } else {
    if (form.requireLogin === false) problems.push('表格沒有限制只有教會帳戶可以填');
    else if (form.requireLogin === null) unknown.push('查不到表格有沒有限制只有教會帳戶可以填');
    if (form.emailVerified === false) problems.push('表格沒有收集已驗證的電郵');
    else if (form.emailVerified === null) unknown.push('查不到表格有沒有收集已驗證的電郵');
  }

  if (state.triggerCount === null) unknown.push('讀不到觸發器清單');
  else if (state.triggerCount === 0) problems.push('沒有表單提交觸發器，答案不會寫進週報');
  else if (state.triggerCount > 1) problems.push('有 ' + state.triggerCount + ' 個表單提交觸發器，同一份答案會被處理 ' + state.triggerCount + ' 次');

  if (!state.folderId) problems.push('沒有設定表格資料夾（SPEAKER_FORM_FOLDER_ID 與 CONTENT_SHEET_FOLDER_ID 都是空的）');
  else if (state.folderIsSharedDrive === false) problems.push('表格資料夾不在 Shared Drive 內');
  else if (state.folderIsSharedDrive === null) unknown.push('查不到表格資料夾是不是在 Shared Drive 內');

  if (problems.length > 0) {
    return { status: statuses.RED, message: '⚠️ ' + problems.join('；') + '。' };
  }
  if (unknown.length > 0) {
    return { status: statuses.YELLOW, message: unknown.join('；') + '。⚠️ 「查不到」不等於「沒問題」。' };
  }
  return {
    status: statuses.GREEN,
    message: '已建立，只限教會帳戶填寫、收集已驗證電郵，表單提交觸發器剛好 1 個，表格資料夾在 Shared Drive 內。'
  };
}

// =====================================================================
// 設定與現況
// =====================================================================

/**
 * 用途：講員表格要放進哪一個資料夾：Config `SPEAKER_FORM_FOLDER_ID`，留空就用
 *   內容表的資料夾 `CONTENT_SHEET_FOLDER_ID`。
 * Args: （無）
 * Returns:
 *   {string} 兩個都空白回空字串。
 */
function resolveSpeakerFormFolderId_() {
  var own = String(getConfig(CONFIG_KEYS.SPEAKER_FORM_FOLDER_ID, '') || '').trim();
  if (own) return own;
  return String(getConfig(CONFIG_KEYS.CONTENT_SHEET_FOLDER_ID, '') || '').trim();
}

/**
 * 用途：今日的日期（yyyy-MM-dd，按 Config `SYS_TIMEZONE`）。
 * Args: （無）
 * Returns:
 *   {string}
 */
function speakerFormTodayIso_() {
  return Utilities.formatDate(new Date(), getConfig(CONFIG_KEYS.SYS_TIMEZONE, 'Pacific/Auckland'), 'yyyy-MM-dd');
}

/**
 * 用途：算出「主日日期」下拉現在應該有哪些選項（讀 `BulletinWeeks` 與 Config）。
 * Args: （無）
 * Returns:
 *   {{isoDate:string, label:string}[]}
 */
function currentSpeakerFormDateOptions_() {
  return buildSpeakerFormDateOptions_(
    readSheet(SHEETS.BULLETIN_WEEKS), speakerFormTodayIso_(),
    getConfig(CONFIG_KEYS.SPEAKER_FORM_WEEKS_AHEAD, '16'),
    getConfig(CONFIG_KEYS.SPEAKER_FORM_DATE_SPECIAL_PATTERN, '{{DATE}}（{{SPECIAL}}）')
  );
}

/**
 * 用途：收集講員表格現況（Config、表單設定、觸發器、資料夾），給檢測用。
 *   唯讀。 任何一項查不到都用 `null` 表示，不當成「正常」。
 * Args: （無）
 * Returns:
 *   {{created:boolean, formId:string, folderId:string, folderIsSharedDrive:?boolean,
 *     triggerCount:?number, form:?Object}}
 */
function inspectSpeakerFormState_() {
  var formId = String(getConfig(CONFIG_KEYS.SPEAKER_FORM_ID, '') || '').trim();
  var folderId = resolveSpeakerFormFolderId_();
  return {
    created: formId !== '',
    formId: formId,
    folderId: folderId,
    folderIsSharedDrive: folderId ? driveIsInSharedDrive_(folderId) : null,
    triggerCount: countSpeakerFormTriggers_(),
    form: formId ? inspectSpeakerFormFile_(formId) : null
  };
}

/**
 * 用途：填寫介面「講員表格」區塊要顯示的現況。唯讀，而且不用 `FormApp`
 *   （所以 forms 範圍還沒授權時這一區塊也看得到）。
 * Args: （無）
 * Returns:
 *   {{created:boolean, url:string, editUrl:string, triggerCount:?number,
 *     triggerOk:boolean, folderConfigured:boolean, weeksAhead:number}}
 */
function speakerFormStatusForWebApp_() {
  var formId = String(getConfig(CONFIG_KEYS.SPEAKER_FORM_ID, '') || '').trim();
  var triggerCount = countSpeakerFormTriggers_();
  var weeksAhead = normalizeInt_(getConfig(CONFIG_KEYS.SPEAKER_FORM_WEEKS_AHEAD, '16'));
  return {
    created: formId !== '',
    url: String(getConfig(CONFIG_KEYS.SPEAKER_FORM_URL, '') || '').trim(),
    editUrl: formId ? ('https://docs.google.com/forms/d/' + formId + '/edit') : '',
    triggerCount: triggerCount,
    triggerOk: triggerCount === 1,
    folderConfigured: resolveSpeakerFormFolderId_() !== '',
    weeksAhead: (weeksAhead && weeksAhead > 0) ? weeksAhead : 16
  };
}

// =====================================================================
// 建立表格與刷新日期選項
// =====================================================================

/**
 * 用途：建立講員表格（一個長期使用的表格，不是每季一個）：檢查資料夾 →
 *   建立表單（只限教會帳戶）→ 搬進 Shared Drive 資料夾 → 把 ID 與連結寫進
 *   Config → 安裝一個表單提交觸發器。
 *
 *   已經建立過的不會再建第二個（講員收藏的連結不可以換）。搬資料夾或裝
 *   觸發器失敗時，表單已經建立，所以 ID 與連結照樣寫進 Config（免得人手再按
 *   一次建出第二個），失敗原因放進 `warnings` 讓人手補做。
 * Args: （無）
 * Returns:
 *   {{ok:boolean, reason:string, message:string, url:string, editUrl:string,
 *     triggerInstalled:boolean, warnings:string[]}}
 *     `ok:false` 時一定有 `reason`（`ALREADY_EXISTS`／`NO_FOLDER`／`NOT_SHARED_DRIVE`／
 *     `CANNOT_VERIFY_FOLDER`／`NO_DATES`）與一句人看得懂的 `message`。
 * Raises:
 *   Error 如果 `FormApp` 建立表單失敗（多數是 forms 範圍未授權）。
 */
function createSpeakerFormForWebApp_() {
  function fail(reason, message) {
    return { ok: false, reason: reason, message: message, url: '', editUrl: '', triggerInstalled: false, warnings: [] };
  }

  if (String(getConfig(CONFIG_KEYS.SPEAKER_FORM_ID, '') || '').trim()) {
    return fail('ALREADY_EXISTS', '講員表格已經建立過了。講員收藏的是固定連結，所以不會再建第二個。'
      + '要改日期選項請按「刷新日期選項」。');
  }

  var folderId = resolveSpeakerFormFolderId_();
  if (!folderId) {
    return fail('NO_FOLDER', '尚未設定講員表格要放在哪一個資料夾。請在 Config 填 ' + CONFIG_KEYS.SPEAKER_FORM_FOLDER_ID
      + '（Shared Drive 內某個資料夾的 ID），或者先設定內容表的資料夾 ' + CONFIG_KEYS.CONTENT_SHEET_FOLDER_ID + '，然後再按一次。');
  }
  var shared = driveIsInSharedDrive_(folderId);
  if (shared === null) {
    return fail('CANNOT_VERIFY_FOLDER', '查不到資料夾是不是在 Shared Drive 內（Drive 進階服務未啟用或沒有權限），為免建出放錯地方的表格，這次沒有建立。');
  }
  if (shared === false) {
    return fail('NOT_SHARED_DRIVE', '講員表格的資料夾必須在 Shared Drive 內，但 Config 指向的資料夾不是。請改填 Shared Drive 內的資料夾 ID。');
  }

  var options = currentSpeakerFormDateOptions_();
  if (options.length === 0) {
    return fail('NO_DATES', '目前沒有可以選的主日（週報工作表內沒有從今日起、未封存的主日）。請先用「建立本季週報」建好整季的空白週報，再建立講員表格。');
  }

  var titles = speakerFormQuestionTitles_();
  var created = createSpeakerFormFile_({
    title: String(getConfig(CONFIG_KEYS.SPEAKER_FORM_TITLE, '') || '').trim() || '主日講員資料',
    description: String(getConfig(CONFIG_KEYS.SPEAKER_FORM_DESCRIPTION, '') || ''),
    confirmation: String(getConfig(CONFIG_KEYS.SPEAKER_FORM_CONFIRMATION, '') || ''),
    questions: titles,
    dateChoices: options.map(function (o) { return o.label; })
  });

  // 先記下 ID 與連結：表單已經存在，後面任何一步失敗都不可以令人再建一個。
  setConfig(CONFIG_KEYS.SPEAKER_FORM_ID, created.formId, 'createSpeakerFormForWebApp_');
  setConfig(CONFIG_KEYS.SPEAKER_FORM_URL, created.publishedUrl, 'createSpeakerFormForWebApp_');

  var warnings = [];
  try {
    driveMoveFileToFolder_(created.formId, folderId);
  } catch (moveErr) {
    warnings.push('表格已經建立，但搬進資料夾失敗：' + ((moveErr && moveErr.message) ? moveErr.message : String(moveErr))
      + '。請人手把表格搬進 Shared Drive 的資料夾。');
  }

  var triggerInstalled = false;
  try {
    triggerInstalled = installSpeakerFormTrigger_(created.formId).installed;
  } catch (triggerErr) {
    warnings.push('表格已經建立，但安裝表單提交觸發器失敗：'
      + ((triggerErr && triggerErr.message) ? triggerErr.message : String(triggerErr))
      + '。沒有觸發器，講員的答案不會寫進週報。');
  }

  appendAuditLog_({
    action: 'SPEAKER_FORM_CREATE', sheetName: SHEETS.CONFIG, rowKey: CONFIG_KEYS.SPEAKER_FORM_ID,
    field: 'VALUE', oldValue: '', newValue: created.formId,
    notes: '建立講員表格；日期選項 ' + options.length + ' 個；觸發器' + (triggerInstalled ? '已安裝' : '沒有安裝')
      + '；警告 ' + warnings.length + ' 項。'
  });

  return {
    ok: true, reason: '', message: '已建立講員表格，日期選項 ' + options.length + ' 個。',
    url: created.publishedUrl, editUrl: created.editUrl,
    triggerInstalled: triggerInstalled, warnings: warnings
  };
}

/**
 * 用途：把講員表格的「主日日期」下拉換成最新的一批（未封存、由今日起的 N 個主日）。
 * Args: （無）
 * Returns:
 *   {{ok:boolean, reason:string, message:string, count:number}}
 *     `ok:false` 的 `reason`：`NOT_CREATED`、`NO_DATES`、`NO_DATE_QUESTION`。
 * Raises:
 *   Error 如果開不到表單（被刪、未授權）。
 */
function refreshSpeakerFormDatesForWebApp_() {
  var formId = String(getConfig(CONFIG_KEYS.SPEAKER_FORM_ID, '') || '').trim();
  if (!formId) {
    return { ok: false, reason: 'NOT_CREATED', message: '還沒有建立講員表格。', count: 0 };
  }
  var options = currentSpeakerFormDateOptions_();
  if (options.length === 0) {
    return { ok: false, reason: 'NO_DATES', message: '目前沒有可以選的主日，沒有改動表格的日期選項。', count: 0 };
  }
  var result = updateSpeakerFormDateChoices_(formId, speakerFormQuestionTitles_().date,
    options.map(function (o) { return o.label; }));
  if (!result.ok) {
    return {
      ok: false, reason: result.reason, count: 0,
      message: '表格上找不到「' + speakerFormQuestionTitles_().date + '」這一題，沒有改動。請檢查 Config 的題目字眼是否與表格一致。'
    };
  }
  return { ok: true, reason: '', message: '日期選項已更新，共 ' + options.length + ' 個主日。', count: options.length };
}

/**
 * 用途：自動刷新日期選項（「建立本季週報」完成後與星期一觸發器內）。
 *   不拋錯：講員表格還沒建立就什麼都不做；刷新失敗只記 `ErrorLog`，不可以令
 *   外面真正的工作（建立週報、寄週報）失敗。
 * Args:
 *   source {string} 誰叫的（函式名），只記進 `ErrorLog`。
 * Returns:
 *   {{skipped:boolean, ok:boolean, message:string}} 還沒建立表格是 `skipped:true`。
 */
function refreshSpeakerFormDatesQuietly_(source) {
  try {
    if (!String(getConfig(CONFIG_KEYS.SPEAKER_FORM_ID, '') || '').trim()) {
      return { skipped: true, ok: true, message: '' };
    }
    var result = refreshSpeakerFormDatesForWebApp_();
    if (!result.ok) {
      appendErrorLog_({
        source: ERROR_LOG_SOURCE.SERVER, functionName: source, errorCode: 'SPEAKER_FORM_REFRESH_' + result.reason,
        message: '自動刷新講員表格的日期選項沒有成功：' + result.message
      });
    }
    return { skipped: false, ok: result.ok, message: result.message };
  } catch (err) {
    var message = (err && err.message) ? err.message : String(err);
    try {
      appendErrorLog_({
        source: ERROR_LOG_SOURCE.SERVER, functionName: source, errorCode: 'SPEAKER_FORM_REFRESH_FAILED',
        message: '自動刷新講員表格的日期選項失敗：' + message
      });
    } catch (logErr) {
      // 連 ErrorLog 都寫不到時，不可以再令呼叫方失敗。
    }
    return { skipped: false, ok: false, message: message };
  }
}

// =====================================================================
// 處理一份答案（真正入口）
// =====================================================================

/**
 * 用途：講員表格的表單提交觸發器處理函式。真正入口。
 *   用 `LockService` 鎖住整個處理過程（兩份答案同時到達不會互相踩）。
 * Args:
 *   e {Object} 表單提交事件（`e.response` 是 `FormResponse`）。
 * Returns:
 *   {{result:string, detail:string, isoDate:string, published:boolean}}
 * Raises:
 *   Error 拿不到鎖（30 秒內）——寧可失敗留下紀錄，也不要不加鎖就寫。
 */
function onSpeakerFormSubmit_(e) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    var lockErr = new Error('onSpeakerFormSubmit_：30 秒內拿不到指令碼鎖，這份講員表格答案沒有處理。');
    lockErr.code = 'LOCK_TIMEOUT';
    appendErrorLog_({
      source: ERROR_LOG_SOURCE.TRIGGER, functionName: 'onSpeakerFormSubmit_',
      errorCode: 'LOCK_TIMEOUT', message: lockErr.message
    });
    throw lockErr;
  }
  try {
    return handleSpeakerFormSubmission_(e, speakerFormTodayIso_());
  } finally {
    // 第二批測試修正 G23 補充：放鎖之前先 flush（見 flushAndReleaseLock_()）。
    flushAndReleaseLock_(lock);
  }
}

/**
 * 用途：處理一份講員表格答案：寫進週報（或決定不寫）、記進
 *   `SpeakerFormSubmissions`、寫 `AuditLog`、通知管理員。
 *
 *   每一份答案都一定會被記下來：處理過程出錯也記一行（結果 `ERROR`）並通知，
 *   不可以讓一份答案憑空消失。
 * Args:
 *   e {Object} 表單提交事件。
 *   todayIso {string} 今日，yyyy-MM-dd（主日已不已過去的基準）。
 * Returns:
 *   {{result:string, detail:string, isoDate:string, published:boolean}}
 */
function handleSpeakerFormSubmission_(e, todayIso) {
  var answer = extractSpeakerFormAnswers_(e, speakerFormQuestionTitles_());

  var outcome;
  try {
    outcome = applySpeakerFormAnswer_(answer, todayIso);
  } catch (err) {
    var message = (err && err.message) ? err.message : String(err);
    appendErrorLog_({
      source: ERROR_LOG_SOURCE.TRIGGER, functionName: 'handleSpeakerFormSubmission_',
      errorCode: (err && err.code) || 'SPEAKER_FORM_ERROR',
      message: '處理講員表格答案失敗（主日 ' + (answer.isoDate || '日期不明') + '）：' + message
    });
    outcome = { result: 'ERROR', detail: message, published: false, special: '' };
  }

  writeSheet(SHEETS.SPEAKER_FORM_SUBMISSIONS, [{
    TIMESTAMP: answer.timestamp instanceof Date ? answer.timestamp : new Date(),
    SERVICE_DATE: answer.isoDate ? normalizeDate_(answer.isoDate) : '',
    RESPONDENT_EMAIL: sanitizeCellText_(answer.email),
    SPEAKER_NAME: sanitizeCellText_(answer.speaker),
    SCRIPTURE_REF: sanitizeCellText_(answer.scripture),
    SERMON_TITLE: sanitizeCellText_(answer.title),
    NOTES: sanitizeCellText_(answer.notes),
    RESULT: outcome.result,
    DETAIL: sanitizeCellText_(outcome.detail),
    ACTIVE: true
  }]);

  appendAuditLog_({
    actor: answer.email || '（查不到電郵）',
    action: 'SPEAKER_FORM_SUBMIT', sheetName: SHEETS.SPEAKER_FORM_SUBMISSIONS,
    rowKey: answer.isoDate || answer.dateText || '（日期不明）', field: 'RESULT',
    oldValue: '', newValue: outcome.result, notes: outcome.detail
  });

  try {
    notifySpeakerFormAnswer_(answer, outcome);
  } catch (noticeErr) {
    appendErrorLog_({
      source: ERROR_LOG_SOURCE.TRIGGER, functionName: 'notifySpeakerFormAnswer_',
      errorCode: 'SPEAKER_FORM_NOTICE_FAILED',
      message: '講員表格答案已經處理，但通知信失敗：' + ((noticeErr && noticeErr.message) ? noticeErr.message : String(noticeErr))
    });
  }

  return { result: outcome.result, detail: outcome.detail, isoDate: answer.isoDate, published: outcome.published };
}

/**
 * 用途：把答案裏的兩項內容（讀經經文、證道講題）寫進週報——見檔頭「三個已定的
 *   決定」。回傳處理結果，不記 `SpeakerFormSubmissions`／`AuditLog`（那是呼叫方的事）。
 * Args:
 *   answer {Object} `extractSpeakerFormAnswers_()` 的輸出。
 *   todayIso {string} 今日，yyyy-MM-dd。
 * Returns:
 *   {{result:string, detail:string, published:boolean, special:string}}
 * Raises:
 *   Error 讀寫工作表、內容表時出錯——由 `handleSpeakerFormSubmission_()` 接住並記成 `ERROR`。
 */
function applySpeakerFormAnswer_(answer, todayIso) {
  if (answer.missingQuestions.length > 0) {
    return {
      result: 'ERROR', published: false, special: '',
      detail: '表單上找不到這些題目：' + answer.missingQuestions.join('、')
        + '。多數是 Config 的題目字眼與表格不一致（建立表格之後在表格上改了題目）。'
    };
  }
  if (!answer.isoDate) {
    return { result: 'ERROR', published: false, special: '', detail: '認不出主日日期：「' + answer.dateText + '」。' };
  }

  var isoDate = answer.isoDate;
  if (isoDate < todayIso) {
    return { result: 'SKIPPED_PAST', published: false, special: '', detail: '主日 ' + isoDate + ' 已經過去（今日是 ' + todayIso + '），沒有寫進週報。' };
  }

  var weekRow = findBulletinWeekRow_(readSheet(SHEETS.BULLETIN_WEEKS), isoDate);
  if (!weekRow) {
    return { result: 'NO_WEEK', published: false, special: '', detail: 'BulletinWeeks 沒有 ' + isoDate + ' 這一行。請先用「建立本季週報」建好。' };
  }

  var special = String(weekRow.SPECIAL_TYPE || '').trim();
  var published = filterPublishedRowsForDate_(readSheet(SHEETS.PUBLISH_LOG), isoDate).length > 0;
  var quarterId = String(weekRow.QUARTER_ID || '').trim();

  var fields = [
    { key: 'SCRIPTURE_REF', label: '讀經經文', value: answer.scripture },
    { key: 'SERMON_TITLE', label: '證道講題', value: answer.title }
  ];
  var overrideIndex = readFieldOverrideIndexForDate_(isoDate);
  var blocked = fields.filter(function (f) { return Boolean(overrideIndex[fieldOverrideKey_(isoDate, f.key)]); });
  var writable = fields.filter(function (f) { return blocked.indexOf(f) === -1; });

  // 來源：該季已有內容表就以內容表為準，否則是 BulletinWeeks 本身。
  var contentRow = quarterId ? findContentSheetRow_(quarterId) : null;
  var tabName = speakerFormContentTabName_();
  var spreadsheet = null;
  var currentValues = {};
  var tabDef = null;
  if (contentRow) {
    spreadsheet = openContentSpreadsheet_(contentRow.FILE_ID);
    if (!spreadsheet) {
      throw new Error('本季（' + quarterId + '）的內容表現在開不到（檔案 ID 開頭 ' + maskContentFileId_(contentRow.FILE_ID)
        + '）。為免寫進一個會被內容表蓋走的地方，這份答案沒有寫入。');
    }
    tabDef = contentSheetTabDefs_().filter(function (d) { return d.tabName === tabName; })[0];
    var rows = (readContentSheetTabs_(spreadsheet)[tabName] || []).filter(function (r) {
      return r.__active === true && String(r.SERVICE_DATE || '').trim() === isoDate;
    });
    var latestRow = rows.length > 0 ? rows[rows.length - 1] : {};
    writable.forEach(function (f) { currentValues[f.key] = latestRow[f.key]; });
  } else {
    writable.forEach(function (f) { currentValues[f.key] = weekRow[f.key]; });
  }
  var changes = writable.filter(function (f) { return !contentValuesEqual_(currentValues[f.key], f.value); });
  var blockedText = blocked.map(function (f) { return f.label; }).join('、');

  if (changes.length === 0) {
    if (blocked.length > 0) {
      return {
        result: 'BLOCKED_BY_OVERRIDE', published: published, special: special,
        detail: blockedText + '有人手覆寫（在填寫介面改過），沒有蓋過。'
      };
    }
    return { result: 'UNCHANGED', published: published, special: special, detail: '答案與' + (contentRow ? '內容表' : '週報') + '現在的內容一樣。' };
  }

  // ⚠️ 版本一定要在寫入之前存。存不到不阻止寫入（這是講員自己填的答案，擋住它
  //    比少一個版本更糟），但會在結果裏講出來。
  var snapshot = trySnapshotWeek_(isoDate, 'SPEAKER_FORM', { actor: answer.email });
  var snapshotNote = snapshot.warning ? ('　' + snapshot.warning) : '';

  var writtenText = changes.map(function (f) { return f.label; }).join('、');
  var detail;
  if (contentRow) {
    var values = {};
    changes.forEach(function (f) { values[f.key] = f.value; });
    var upsert = upsertContentWeekValues_(spreadsheet, tabName, tabDef.keys, isoDate, values);
    if (!upsert.ok) {
      throw new Error('內容表沒有「' + tabName + '」分頁，沒有寫入。請先在填寫介面「季度作業」刷新本季內容表。');
    }
    var imported = applyContentImport_(quarterId, { isoDate: isoDate, tabNames: [tabName], skipSnapshot: true });
    if (!imported.ok) {
      throw new Error('答案已寫進內容表的「' + tabName + '」分頁，但由內容表匯入週報失敗：'
        + (imported.message || imported.reason || '原因不明'));
    }
    detail = writtenText + '已寫進內容表「' + tabName + '」分頁第 ' + upsert.rowNo + ' 行'
      + (upsert.created ? '（新增一行）' : '') + '，並已匯入週報。';
    var after = findBulletinWeekRow_(readSheet(SHEETS.BULLETIN_WEEKS), isoDate) || {};
    refreshFillSnapshotAfterSave_(isoDate, changes.map(function (f) { return { field: f.key, newValue: after[f.key] }; }));
  } else {
    changes.forEach(function (f) {
      writeBulletinWeekField_(isoDate, f.key, f.value);
      appendAuditLog_({
        actor: answer.email || '（查不到電郵）',
        action: 'SPEAKER_FORM_WRITE', sheetName: SHEETS.BULLETIN_WEEKS, rowKey: isoDate, field: f.key,
        oldValue: auditValueToText_(weekRow[f.key]), newValue: f.value,
        notes: '講員表格答案直接寫入（本季還沒有內容表，日後建立內容表時會由週報帶入）。'
      });
    });
    refreshFillSnapshotAfterSave_(isoDate, changes.map(function (f) { return { field: f.key, newValue: f.value }; }));
    detail = writtenText + '已直接寫進週報（本季還沒有內容表）。';
  }

  if (blocked.length > 0) {
    return {
      result: 'BLOCKED_BY_OVERRIDE', published: published, special: special,
      detail: detail + blockedText + '有人手覆寫（在填寫介面改過），沒有蓋過。' + snapshotNote
    };
  }
  return { result: 'APPLIED', published: published, special: special, detail: detail + snapshotNote };
}

/**
 * 用途：答案要寫進內容表的哪一張分頁（名稱）。
 *   寫成函式而不是頂層常數：本專案不容許跨檔案的頂層初始化式
 *   （`tools/lint-load-order.js`）。
 * Args: （無）
 * Returns:
 *   {string}
 */
function speakerFormContentTabName_() {
  return '崇拜程序';
}

/**
 * 用途：把答案通知管理員（`SPEAKER_FORM_NOTIFY_GROUPS` 組別）。遵守
 *   `DRY_RUN`：`TRUE` 時完全不呼叫 `MailApp`，但照樣寫 `SendLog`。
 *   組別內沒有任何收件人時不寄，也不報錯（只是沒有人要通知）。
 * Args:
 *   answer {Object} `extractSpeakerFormAnswers_()` 的輸出。
 *   outcome {{result:string, detail:string, published:boolean, special:string}}
 * Returns:
 *   {{sent:boolean, reason:string, dryRun:boolean, recipientCount:number}}
 */
function notifySpeakerFormAnswer_(answer, outcome) {
  var dryRun = normalizeBoolean_(getConfig(CONFIG_KEYS.DRY_RUN, 'TRUE')) === true;
  var groups = getConfigTextList_(CONFIG_KEYS.SPEAKER_FORM_NOTIFY_GROUPS, 'ADMIN');
  var recipients = buildRecipientList_(readSheet(SHEETS.RECIPIENTS), groups, new Date()).recipients;
  if (recipients.length === 0) {
    return { sent: false, reason: 'NO_RECIPIENTS', dryRun: dryRun, recipientCount: 0 };
  }

  // 講員核對：用寫入之後的事奉框講員比較（與週報警告同一個函式）。
  var mismatchText = '（沒有主日日期，無法核對）';
  if (answer.isoDate) {
    var snapshot = readRosterSnapshot_(answer.isoDate);
    if (!snapshot.found) {
      mismatchText = '（職事表沒有這個主日的資料，無法核對）';
    } else {
      var slots = applyDutyOverridesToSlots_(snapshot.slotsByPost,
        buildDutyOverrideIndex_(readDutyOverrideRows_(answer.isoDate)));
      var warning = buildSpeakerMismatchWarning_(answer.speaker, speakerNameFromSlots_(slots),
        getConfigTextList_(CONFIG_KEYS.SPEAKER_NAME_HONORIFICS, ''));
      mismatchText = warning ? ('⚠️ ' + warning.message) : '與事奉框的講員一致。';
    }
  }

  var notice = buildSpeakerFormNotice_({
    churchName: getConfig(CONFIG_KEYS.CHURCH_NAME, ''),
    subjectPattern: getConfig(CONFIG_KEYS.SPEAKER_FORM_NOTIFY_SUBJECT, ''),
    answer: answer, resultCode: outcome.result, resultDetail: outcome.detail,
    special: outcome.special, mismatchText: mismatchText, published: outcome.published,
    webAppUrl: String(getConfig(CONFIG_KEYS.WEBAPP_URL, '') || '').trim()
  });

  var sendLogRows = [];
  recipients.forEach(function (recipient) {
    var status = 'SPEAKER_FORM_NOTICE';
    var errorMessage = '';
    if (!dryRun) {
      try {
        MailApp.sendEmail({ to: recipient.email, subject: notice.subject, body: notice.plain, htmlBody: notice.html });
      } catch (mailErr) {
        status = 'FAILED';
        errorMessage = (mailErr && mailErr.message) ? mailErr.message : String(mailErr);
      }
    }
    sendLogRows.push({
      TIMESTAMP: new Date(),
      SERVICE_DATE: answer.isoDate ? normalizeDate_(answer.isoDate) : '',
      RECIPIENT_EMAIL: sanitizeCellText_(recipient.email),
      SUBJECT: sanitizeCellText_(notice.subject),
      STATUS: status,
      DRY_RUN: dryRun,
      ROSTER_VERSION_USED: '',
      ERROR: sanitizeCellText_(errorMessage),
      BODY_PREVIEW: buildSendLogBodyPreview_(notice.plain)
    });
  });
  writeSendLogRows_(sendLogRows);

  return { sent: true, reason: '', dryRun: dryRun, recipientCount: recipients.length };
}
