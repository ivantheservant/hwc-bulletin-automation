/**
 * SendNotice.gs
 *
 * v3（2026-10-26 Ivan 測試結果 A，第 5、18 項）：填寫介面「寄出」的通知信，以及星期一草稿預覽信要用的
 * 共用資料（預覽連結、本季內容表連結、master 連結那一行、附件那一行）。
 *
 *   - 「寄出」（不論有沒有同時發佈）一律寄這一個主日的預覽連結與本季內容表連結；master 連結現在就是
 *     這一期（這一次發佈了，或者之前已經發佈）才放 master 連結。不再要求先發佈過。
 *   - 可以選擇一併附上這個主日最新已儲存的 Word（`BulletinWeeks.DOC_ID`）。
 *
 * ⚠️ 範本在 `EmailTemplates` 的 `SEND_NOTICE`；工作表沒有那一行（未跑「初始化工作表」）就用內建那一份
 *    （與 `seedSendNoticeRow_()` 同一份，不另寫第二份）。
 */

'use strict';

/** 「寄出」通知信的範本 ID。 */
var SEND_NOTICE_TEMPLATE_ID_ = 'SEND_NOTICE';

/**
 * 用途：某個主日所屬季度的內容表網址（`ContentSheets` 登記的那一個）。讀不到就是空字串——這只是信內
 *   多一條連結，讀不到不可以令寄出失敗。
 * Args:
 *   isoDate {string} 主日日期。
 * Returns:
 *   {string}
 * Raises:
 *   （無）
 */
function contentSheetUrlForIsoDate_(isoDate) {
  try {
    var weekRow = findBulletinWeekRow_(readSheet(SHEETS.BULLETIN_WEEKS), isoDate);
    var qid = weekRow ? String(weekRow.QUARTER_ID || '').trim() : '';
    if (!qid) return '';
    var row = findContentSheetRow_(qid);
    var url = row ? String(row.FILE_URL || '').trim() : '';
    return /^https:\/\//i.test(url) ? url : '';
  } catch (err) {
    return '';
  }
}

/**
 * 用途：組出「寄出」通知信的佔位符值。純函式。
 * Args:
 *   input {{churchName:string, isoDate:string, previewUrl:string, contentSheetUrl:string,
 *     masterUrl:string, masterOnThisWeek:boolean, attachedPdf:boolean, attachedWord:boolean}}
 * Returns:
 *   {Object<string,string>} `ChurchName`、`ServiceDate`、`PreviewUrl`、`ContentSheetUrl`、`MasterLink`、
 *     `MasterLinkLine`、`AttachmentLine`。
 * Raises:
 *   （無）
 */
function buildSendNoticeVars_(input) {
  var o = input || {};
  var masterLine = (o.masterOnThisWeek && o.masterUrl)
    ? '這一期已經發佈，正式版（master 連結，固定不變）：' + o.masterUrl
    : '這一期尚未發佈到 master 連結；發佈之後會另行通知。';
  var attach = [];
  if (o.attachedPdf) attach.push('這一次發佈的 PDF');
  if (o.attachedWord) attach.push('最新已儲存的 Word 檔');
  return {
    ChurchName: String(o.churchName || ''),
    ServiceDate: String(o.isoDate || ''),
    PreviewUrl: String(o.previewUrl || '（取不到預覽連結）'),
    ContentSheetUrl: String(o.contentSheetUrl || '（本季未有內容表）'),
    MasterLink: (o.masterOnThisWeek && o.masterUrl) ? String(o.masterUrl) : '',
    MasterLinkLine: masterLine,
    AttachmentLine: attach.length > 0 ? '隨函附上：' + attach.join('、') + '。' : ''
  };
}

/**
 * 用途：由 `EmailTemplates` 找「寄出」通知範本；找不到（或停用）就用內建那一份。
 * Args: （無）
 * Returns:
 *   {{subject:string, body:string, fromSheet:boolean}}
 * Raises:
 *   （無）
 */
function findSendNoticeTemplate_() {
  var fallback = seedSendNoticeRow_();
  var rows = [];
  try { rows = readSheet(SHEETS.EMAIL_TEMPLATES) || []; } catch (err) { rows = []; }
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    if (String(row.TEMPLATE_ID || '').trim() !== SEND_NOTICE_TEMPLATE_ID_) continue;
    if (row.ACTIVE !== true) continue;
    return { subject: String(row.SUBJECT || fallback.SUBJECT), body: String(row.BODY || fallback.BODY), fromSheet: true };
  }
  return { subject: fallback.SUBJECT, body: fallback.BODY, fromSheet: false };
}

/**
 * 用途：這個主日最新已儲存的 Word（`BulletinWeeks.DOC_ID`）的 blob，寄出時附上用。
 * Args:
 *   isoDate {string} 主日日期。
 * Returns:
 *   {{ok:boolean, blob:?Blob, fileName:string, reason:string, message:string}}
 * Raises:
 *   （無）
 */
function readSavedWordForSend_(isoDate) {
  var weekRow = findBulletinWeekRow_(readSheet(SHEETS.BULLETIN_WEEKS), isoDate);
  var docId = weekRow ? String(weekRow.DOC_ID || '').trim() : '';
  if (!docId) {
    return {
      ok: false, blob: null, fileName: '', reason: 'NO_SAVED_WORD',
      message: '這個主日（' + isoDate + '）還沒有已儲存的 Word 檔，所以附不到。請先按「下載 Word」'
        + '（會同時存一份到雲端硬碟），或者取消「一併附上最新已儲存的 Word 檔」再寄。這一次一封都沒有寄。'
    };
  }
  var read = readOutputDocxById_(docId);
  if (!read.ok) {
    return { ok: false, blob: null, fileName: '', reason: 'SAVED_WORD_UNREADABLE', message: read.message + '　這一次一封都沒有寄。' };
  }
  return { ok: true, blob: read.blob, fileName: read.fileName, reason: '', message: '' };
}

/**
 * 用途：只寄出時，master 連結現在是不是這一期。讀不到（從未發佈、日期讀不到）一律當作「不是」——
 *   只是信內少一條連結，不可以令寄出失敗。
 * Args:
 *   masterFileId {string}
 *   isoDate {string}
 * Returns:
 *   {{onThisWeek:boolean, versionNo:(number|null)}}
 * Raises:
 *   （無）
 */
function masterIssueForSend_(masterFileId, isoDate) {
  if (!masterFileId) return { onThisWeek: false, versionNo: null };
  try {
    var issue = currentMasterPublishIssue_(masterFileId);
    if (issue && issue.isoDate === isoDate) return { onThisWeek: true, versionNo: issue.versionNo };
  } catch (err) { /* 讀不到就當作不是這一期 */ }
  return { onThisWeek: false, versionNo: null };
}
