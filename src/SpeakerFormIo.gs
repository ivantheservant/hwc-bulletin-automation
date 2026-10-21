/**
 * SpeakerFormIo.gs
 *
 * 講員表格（Google Form）的全部 `FormApp` 呼叫。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ⚠️ 本檔案是全 src/ 唯一准許出現 `FormApp` 的地方
 * ─────────────────────────────────────────────────────────────────────
 *
 *   `tools/lint-readonly-roster.js` 的規則 5 把 `FormApp` 鎖死在本檔案，理由與
 *   `DriveApp`／`openById(` 完全相同：`FormApp.openById()` 可以開啟任何一份
 *   表單，包括職事表系統自己的表單。能力只集中在一個檔案，「有沒有人用表單
 *   繞過職事表唯讀邊界」就永遠只需要審這一個檔案。配合規則 4，本檔案一個
 *   格都不准出現 `ROSTER_SPREADSHEET_ID`——拿不到職事表的設定鍵，就沒有辦法自己
 *   找到職事表的任何東西。
 *
 *   本檔案也不用 `DriveApp`：把表單搬進 Shared Drive 資料夾走
 *   `DriveShared.gs` 的 `driveMoveFileToFolder_()`。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 這裏只做「開表單、改表單、裝觸發器」，不含業務判斷
 * ─────────────────────────────────────────────────────────────────────
 *
 *   題目寫什麼、日期選項有哪些、答案怎樣處理，全部在 `src/SpeakerForm.gs`。
 *
 * ⚠️ 表單一律設成只限教會帳戶（同網域）登入才可以填、自動收集已驗證的
 * 電郵、不公開答案摘要。這是已定的決定，不是可以調整的選項。
 */

'use strict';

/** 表單提交觸發器的處理函式名稱。裝觸發器與數觸發器共用這一個，不各寫一份字串。 */
var SPEAKER_FORM_TRIGGER_HANDLER_ = 'onSpeakerFormSubmit_';

/**
 * 用途：試探性確認目前的授權範圍包含 Google 表單（forms）。供「檢查授權範圍」
 *   使用——部署新版本後第一次，需要重新授權 forms 範圍。
 * Args: （無）
 * Returns:
 *   {void}
 * Raises:
 *   Error 如果 forms 範圍沒有授權——原樣往上拋，呼叫方會判定這一項「未授權」。
 */
function probeFormsAccess_() {
  FormApp.getActiveForm();
}

/**
 * 用途：建立講員表格（表單檔案），套用已定的安全設定，加入四個必填題與一個
 *   選填題，但不搬資料夾、不裝觸發器（那兩步由呼叫方接著做，失敗時才好
 *   分開說明）。
 * Args:
 *   spec {{title:string, description:string, confirmation:string,
 *     questions:{date:string, speaker:string, scripture:string, title:string, notes:string},
 *     dateChoices:string[]}}
 *     `dateChoices` 至少要有一個（Google 表單的下拉不可以沒有選項）。
 * Returns:
 *   {{formId:string, publishedUrl:string, editUrl:string}}
 * Raises:
 *   Error 如果沒有任何日期選項，或 `FormApp` 沒有授權（缺 forms 範圍）。
 */
function createSpeakerFormFile_(spec) {
  if (!spec.dateChoices || spec.dateChoices.length === 0) {
    throw new Error('createSpeakerFormFile_：沒有任何日期選項，Google 表單的下拉不可以沒有選項。');
  }

  var form = FormApp.create(spec.title);
  form.setDescription(spec.description);
  form.setConfirmationMessage(spec.confirmation);

  // ---- 已定的安全設定：只限教會帳戶、收集已驗證電郵、不公開答案 ----
  form.setRequireLogin(true);
  form.setEmailCollectionType(FormApp.EmailCollectionType.VERIFIED);
  form.setLimitOneResponsePerUser(false);
  form.setPublishingSummary(false);
  form.setShowLinkToRespondAgain(false);
  form.setAllowResponseEdits(false);

  form.addListItem().setTitle(spec.questions.date).setChoiceValues(spec.dateChoices).setRequired(true);
  form.addTextItem().setTitle(spec.questions.speaker).setRequired(true);
  form.addTextItem().setTitle(spec.questions.scripture).setRequired(true);
  form.addTextItem().setTitle(spec.questions.title).setRequired(true);
  form.addParagraphTextItem().setTitle(spec.questions.notes).setRequired(false);

  return { formId: form.getId(), publishedUrl: form.getPublishedUrl(), editUrl: form.getEditUrl() };
}

/**
 * 用途：把「主日日期」下拉的選項換成新的一批。
 * Args:
 *   formId {string} 表單檔案 ID。
 *   dateQuestionTitle {string} 「主日日期」那一題的題目字眼。
 *   choices {string[]} 新的選項（至少一個）。
 * Returns:
 *   {{ok:boolean, reason:string}} 找不到那一題時 `ok:false`、`reason` 是
 *     `'NO_DATE_QUESTION'`。
 * Raises:
 *   Error 如果沒有任何選項，或開不到表單。
 */
function updateSpeakerFormDateChoices_(formId, dateQuestionTitle, choices) {
  if (!choices || choices.length === 0) {
    throw new Error('updateSpeakerFormDateChoices_：沒有任何日期選項，Google 表單的下拉不可以沒有選項。');
  }
  var form = FormApp.openById(formId);
  var wanted = String(dateQuestionTitle || '').trim();
  var items = form.getItems(FormApp.ItemType.LIST).filter(function (item) {
    return String(item.getTitle() || '').trim() === wanted;
  });
  if (items.length === 0) return { ok: false, reason: 'NO_DATE_QUESTION' };
  items[0].asListItem().setChoiceValues(choices);
  return { ok: true, reason: '' };
}

/**
 * 用途：檢查現有的講員表格有沒有按已定的決定設定好。唯讀。
 *   給「上線前檢查」和「完成度自我檢測」用。
 * Args:
 *   formId {string} 表單檔案 ID。
 * Returns:
 *   {{reachable:boolean, error:string, requireLogin:?boolean, emailVerified:?boolean,
 *     publishedUrl:string, editUrl:string, dateChoiceCount:?number}}
 *     開不到（被刪、沒有權限、forms 範圍未授權）時 `reachable:false` 並帶原因；
 *     查不出的設定是 `null`，不當成 `false`。
 */
function inspectSpeakerFormFile_(formId) {
  var form;
  try {
    form = FormApp.openById(formId);
  } catch (err) {
    return {
      reachable: false, error: (err && err.message) ? err.message : String(err),
      requireLogin: null, emailVerified: null, publishedUrl: '', editUrl: '', dateChoiceCount: null
    };
  }

  function attempt(fn) {
    try { return fn(); } catch (err) { return null; }
  }

  var emailType = attempt(function () { return form.getEmailCollectionType(); });
  var dateChoiceCount = attempt(function () {
    var lists = form.getItems(FormApp.ItemType.LIST);
    return lists.length === 0 ? 0 : lists[0].asListItem().getChoices().length;
  });
  return {
    reachable: true, error: '',
    requireLogin: attempt(function () { return form.requiresLogin(); }),
    emailVerified: emailType === null ? null : emailType === FormApp.EmailCollectionType.VERIFIED,
    publishedUrl: attempt(function () { return form.getPublishedUrl(); }) || '',
    editUrl: attempt(function () { return form.getEditUrl(); }) || '',
    dateChoiceCount: dateChoiceCount
  };
}

/**
 * 用途：數目前專案內有幾個講員表格的表單提交觸發器。
 * Args: （無）
 * Returns:
 *   {?number} 讀不到觸發器清單（未授權）回 `null`，不當成 0。
 */
function countSpeakerFormTriggers_() {
  try {
    return ScriptApp.getProjectTriggers().filter(function (trigger) {
      return trigger.getHandlerFunction() === SPEAKER_FORM_TRIGGER_HANDLER_;
    }).length;
  } catch (err) {
    return null;
  }
}

/**
 * 用途：為講員表格安裝一個表單提交觸發器（處理函式 `onSpeakerFormSubmit_`）。
 *   已經有的就不重複安裝——重複安裝會令同一份答案被處理兩次。
 * Args:
 *   formId {string} 表單檔案 ID。
 * Returns:
 *   {{installed:boolean, existingCount:number}} `installed:false` 代表原本已經
 *     有觸發器，這次沒有再裝。
 * Raises:
 *   Error 如果讀不到觸發器清單（未授權）或安裝失敗。
 */
function installSpeakerFormTrigger_(formId) {
  var existing = countSpeakerFormTriggers_();
  if (existing === null) {
    throw new Error('installSpeakerFormTrigger_：讀不到觸發器清單（可能未授權），為免重複安裝，這次沒有安裝。');
  }
  if (existing > 0) return { installed: false, existingCount: existing };

  ScriptApp.newTrigger(SPEAKER_FORM_TRIGGER_HANDLER_)
    .forForm(FormApp.openById(formId))
    .onFormSubmit()
    .create();
  return { installed: true, existingCount: 0 };
}
