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
 * 用途：某個主日所屬季度的內容表連結（`ContentSheets` 登記的那一個），連同信內要寫的那一句。
 *   讀不到不可以令寄出失敗（只是信內一條連結），但亦不可以講成「本季未有內容表」——讀不到要講讀不到，
 *   並寫 ErrorLog（bug class 2）。
 * Args:
 *   isoDate {string} 主日日期。
 * Returns:
 *   {{url:string, text:string, error:string}} `url` 只收 `https://`；`text` 是信內那一格要寫的字。
 * Raises:
 *   （無）
 */
function contentSheetLinkForIsoDate_(isoDate) {
  try {
    var weekRow = findBulletinWeekRow_(readSheet_(SHEETS.BULLETIN_WEEKS), isoDate);
    var qid = weekRow ? String(weekRow.QUARTER_ID || '').trim() : '';
    var row = qid ? findContentSheetRow_(qid) : null;
    var url = row ? String(row.FILE_URL || '').trim() : '';
    if (/^https:\/\//i.test(url)) return { url: url, text: url, error: '' };
    return { url: '', text: '（本季未有內容表）', error: '' };
  } catch (err) {
    var message = (err && err.message) ? err.message : String(err);
    appendErrorLog_({
      source: ERROR_LOG_SOURCE.SERVER, functionName: 'contentSheetLinkForIsoDate_', errorCode: 'CONTENT_SHEET_LINK_UNREADABLE',
      message: '讀不到 ' + isoDate + ' 那一季的內容表連結，通知信改寫「讀不到」：' + message
    });
    return { url: '', text: '（讀不到本季內容表的連結，請聯絡幹事）', error: message };
  }
}

/**
 * 用途：只要網址的版本（`contentSheetLinkForIsoDate_()` 的 `url`）。
 * Args:
 *   isoDate {string}
 * Returns:
 *   {string} 沒有或讀不到都是空字串。
 */
function contentSheetUrlForIsoDate_(isoDate) {
  return contentSheetLinkForIsoDate_(isoDate).url;
}

/**
 * 用途：組出「寄出」通知信的佔位符值。純函式。
 * Args:
 *   input {{churchName:string, isoDate:string, previewUrl:string, contentSheetUrl:string, contentSheetText:string=,
 *     masterUrl:string, masterOnThisWeek:boolean, attachedPdf:boolean, attachedWord:boolean}}
 *     `contentSheetText`：信內內容表那一格要寫的字（`contentSheetLinkForIsoDate_()`）；省略就用網址。
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
    ContentSheetUrl: String(o.contentSheetText || o.contentSheetUrl || '（本季未有內容表）'),
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
  try { rows = readSheet_(SHEETS.EMAIL_TEMPLATES) || []; } catch (err) { rows = []; }
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
  var weekRow = findBulletinWeekRow_(readSheet_(SHEETS.BULLETIN_WEEKS), isoDate);
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
 * 用途：要附上的「最新已儲存的 Word」是不是在這一週最後一次改動之前產生的。是的話回一句提醒（寄出前檢查
 *   視窗顯示，要勾方框才寄）；不是（或者未有已儲存的 Word，那一種另有 NO_SAVED_WORD）回空字串。
 *
 *   ⚠️ 不可以自動重新產生：雲端硬碟上那一份可能已經有人在 Word 內人手改過（見 docs/幹事操作說明.md
 *   「系統出問題時，怎樣人手接手」），重新產生會把人手改動蓋走。所以只提醒，由幹事決定。
 *
 *   「改動」＝這一週在 Word 產生之後有任何寫入：填寫介面儲存（`LAST_SAVED_AT`），或者任何會改週報的動作
 *   在寫入之前存的版本（匯入、還原、重設、由職事表重新取數、補抓、內容表更新等；`WORD_GENERATED` 不算）。
 *   職事表本身改了人不會留下記錄，這裏看不到——提醒句照講。
 * Args:
 *   isoDate {string} 主日日期。
 * Returns:
 *   {string}
 * Raises:
 *   （無）讀不到產生時間亦回一句提醒（不當作是最新）。
 */
function savedWordStalenessNotice_(isoDate) {
  var weekRow = findBulletinWeekRow_(readSheet_(SHEETS.BULLETIN_WEEKS), isoDate);
  if (!weekRow || !String(weekRow.DOC_ID || '').trim()) return '';
  var tz = getConfig_(CONFIG_KEYS.SYS_TIMEZONE, 'Pacific/Auckland');
  function stamp(d) { return Utilities.formatDate(d, tz, 'yyyy-MM-dd HH:mm'); }
  var generatedAt = weekRow.LAST_GENERATED_AT;
  if (!(generatedAt instanceof Date) || isNaN(generatedAt.getTime())) {
    return '⚠ 讀不到要附上的 Word 是幾時產生的，附上的未必是現在的內容。要附上現在的內容，請先按「下載 Word」'
      + '（已儲存的版本）再寄；仍然要附上這一份，勾選下面的方框。';
  }
  var latest = null;
  var savedAt = weekRow.LAST_SAVED_AT;
  if (savedAt instanceof Date && savedAt.getTime() > generatedAt.getTime()) {
    latest = { at: savedAt, label: weekSnapshotReasonLabel_('WEBAPP_SAVE') };
  }
  var groups = [];
  try { groups = groupWeekSnapshots_(readSheet_(SHEETS.WEEK_SNAPSHOTS), isoDate); } catch (err) { groups = []; }
  groups.forEach(function (g) {
    if (g.reason === 'WORD_GENERATED') return;
    var at = g.createdAt;
    if (!(at instanceof Date) || at.getTime() <= generatedAt.getTime()) return;
    if (!latest || at.getTime() > latest.at.getTime()) latest = { at: at, label: weekSnapshotReasonLabel_(g.reason) };
  });
  if (!latest) return '';
  return '⚠ 要附上的 Word 是 ' + stamp(generatedAt) + ' 產生的；之後這一週有改動（' + stamp(latest.at) + '，'
    + latest.label + '），附上的會是改動之前的內容。要附上現在的內容，請先按「下載 Word」（已儲存的版本）再寄；'
    + '仍然要附上這一份（例如你在 Word 內人手改過），勾選下面的方框。';
}

/**
 * 用途：只寄出時，master 連結現在是不是這一期。從未發佈過＝不是。
 *   ⚠️ `PublishLog` 最新一行的日期讀不到（`MASTER_ISSUE_UNKNOWN`）**不可以**當作「不是」——那會令一期
 *   已經發佈的通知信講「尚未發佈」（獨立審查，bug class 2）。回 `unknown:true`，由呼叫方拒絕寄出。
 * Args:
 *   masterFileId {string}
 *   isoDate {string}
 * Returns:
 *   {{onThisWeek:boolean, versionNo:(number|null), unknown:boolean, message:string}}
 * Raises:
 *   Error `MASTER_ISSUE_UNKNOWN` 以外的錯誤原樣拋出。
 */
function masterIssueForSend_(masterFileId, isoDate) {
  if (!masterFileId) return { onThisWeek: false, versionNo: null, unknown: false, message: '' };
  var issue;
  try {
    issue = currentMasterPublishIssue_(masterFileId);
  } catch (err) {
    if (err && err.code === 'MASTER_ISSUE_UNKNOWN') {
      return { onThisWeek: false, versionNo: null, unknown: true, message: err.message };
    }
    throw err;
  }
  if (issue && issue.isoDate === isoDate) return { onThisWeek: true, versionNo: issue.versionNo, unknown: false, message: '' };
  return { onThisWeek: false, versionNo: null, unknown: false, message: '' };
}
