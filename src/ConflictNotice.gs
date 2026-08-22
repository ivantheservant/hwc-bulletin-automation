/**
 * ConflictNotice.gs
 *
 * 職事表分歧的提醒電郵：偵測到 `CONFLICT`（幹事覆寫之後職事表又改過）
 * 時，寄一封提醒信給 `Recipients` 內指定組別的人。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 核心原則（第六輪，每個相關檔案都要複述一次）
 * ─────────────────────────────────────────────────────────────────────
 *
 * 1. **週報永不寫職事表。** 本檔案一格職事表都不寫。
 * 2. 幹事在週報改的事奉名單只存在週報。
 * 3. 沒有人手覆寫的崗位，自動跟隨職事表最新版。
 * 4. 有人手覆寫的崗位，職事表改動不會自動蓋過去，只會被標示為衝突。
 * 5. 一切分歧**只提醒，不自動修正任何一邊**——所以這封信的用途只有
 *    一個：把「兩邊不一致」這件事講出來，讓人自己決定。信裡因此一定
 *    要有那一句「本系統不會改動職事表。如果週報的版本才是正確的，
 *    請自行到職事表更正。」
 *
 * ─────────────────────────────────────────────────────────────────────
 * ⚠️ 指紋機制：同一個衝突不重複寄
 * ─────────────────────────────────────────────────────────────────────
 *
 * 這封信會在每星期的自動寄送流程跑一次。如果沒有防重複機制，同一個
 * 衝突每星期都會寄一次，收件人很快就會把它當成噪音、不再細看——
 * 那樣提醒信就完全失去意義了。
 *
 * 所以每一項衝突算一個**指紋**（主日＋崗位＋位次＋**職事表現值**），
 * 寄過就記進 `ConflictNoticeLog`；已經記錄過的指紋不再寄。職事表**再改
 * 一次**（現值變了 → 指紋變了）才會再寄一次，因為那是新的資訊。
 */

'use strict';

/**
 * 用途：算出一項衝突的指紋。純函式。
 *
 *   刻意用**職事表現值**而不是週報現值：指紋要回答的問題是「職事表這一
 *   格現在是什麼，我通知過沒有」。週報現值是幹事自己改的，不代表新資訊。
 * Args:
 *   isoDate {string} 主日日期，yyyy-MM-dd。
 *   postId {string} 崗位 ID。
 *   slotIndex {*} 位次。
 *   rosterName {string} 職事表**現時**的值。
 * Returns:
 *   {string}
 */
function buildConflictFingerprint_(isoDate, postId, slotIndex, rosterName) {
  return [isoDate, postId, String(slotIndex), String(rosterName || '')].join('#');
}

/**
 * 用途：從比對結果挑出「是衝突、而且**還沒有通知過**」的項目。純函式。
 * Args:
 *   diffRows {Object[]} `buildRosterDiff_()` 的 `rows`。
 *   notifiedFingerprints {string[]} `ConflictNoticeLog` 已經記錄過的指紋。
 *   isoDate {string} 主日日期，yyyy-MM-dd。
 * Returns:
 *   {Object[]} 每個元素是原本的 diff row，另加 `fingerprint`。
 */
function filterUnnotifiedConflicts_(diffRows, notifiedFingerprints, isoDate) {
  var seen = {};
  (notifiedFingerprints || []).forEach(function (fp) { seen[fp] = true; });

  return (diffRows || [])
    .filter(function (r) { return r.status === ROSTER_DIFF_STATUS.CONFLICT; })
    .map(function (r) {
      return Object.assign({}, r, {
        fingerprint: buildConflictFingerprint_(isoDate, r.postId, r.slotIndex, r.rosterName)
      });
    })
    .filter(function (r) { return !seen[r.fingerprint]; });
}

/**
 * 用途：組出提醒信的 HTML 正文。純函式，不碰 Apps Script 服務。
 * Args:
 *   isoDate {string} 主日日期，yyyy-MM-dd。
 *   rows {Object[]} `filterUnnotifiedConflicts_()` 的輸出。
 *   options {{churchName:string=}} 選填。
 * Returns:
 *   {string}
 */
function buildConflictNoticeHtml_(isoDate, rows, options) {
  var opts = options || {};
  var esc = escapeHtmlEmail_;

  function cell(tag, text) {
    return '<' + tag + ' style="border:1px solid #ccc;padding:4px 8px;text-align:left;vertical-align:top;">' + esc(text) + '</' + tag + '>';
  }

  var bodyRows = (rows || []).map(function (r) {
    return '<tr>'
      + cell('td', r.postLabel + ' #' + r.slotIndex)
      + cell('td', r.rosterValueAtOverride || '（空白）')
      + cell('td', r.rosterName || '（空白）')
      + cell('td', r.bulletinName || '（空白）')
      + '</tr>';
  }).join('');

  return [
    '<h2 style="margin:0 0 0.6em;">職事表分歧提醒 — ' + esc(isoDate) + '</h2>',
    '<p>' + esc(opts.churchName || '') + '週報系統偵測到以下事奉崗位，在幹事於週報人手修改**之後**，職事表又再改過：</p>',
    '<table style="border-collapse:collapse;width:100%;margin-bottom:1em;">',
    '<thead><tr>'
    + cell('th', '崗位／位次')
    + cell('th', '你覆寫時職事表是')
    + cell('th', '職事表現在是')
    + cell('th', '週報現在顯示')
    + '</tr></thead>',
    '<tbody>' + bodyRows + '</tbody></table>',
    '<p style="background:#fdeceb;color:#8c231c;padding:0.8em 1em;border-radius:4px;">',
    '<strong>本系統不會改動職事表。如果週報的版本才是正確的，請自行到職事表更正。</strong>',
    '</p>',
    '<p style="color:#666;font-size:13px;">',
    '如果職事表的版本才是正確的，可以在週報填寫介面撳「由職事表重新取數」，逐項勾選要改回職事表值的欄位。',
    '</p>'
  ].join('\n');
}

/**
 * 用途：組出提醒信的純文字備援正文（`MailApp` 的 `body`）。純函式。
 * Args:
 *   isoDate {string} 主日日期，yyyy-MM-dd。
 *   rows {Object[]} `filterUnnotifiedConflicts_()` 的輸出。
 *   options {{churchName:string=}} 選填。
 * Returns:
 *   {string}
 */
function buildConflictNoticePlainText_(isoDate, rows, options) {
  var opts = options || {};
  var lines = [];
  lines.push('職事表分歧提醒 — ' + isoDate);
  lines.push('');
  lines.push((opts.churchName || '') + '週報系統偵測到以下事奉崗位，在幹事於週報人手修改之後，職事表又再改過：');
  lines.push('');
  (rows || []).forEach(function (r) {
    lines.push('　' + r.postLabel + ' #' + r.slotIndex);
    lines.push('　　你覆寫時職事表是：' + (r.rosterValueAtOverride || '（空白）'));
    lines.push('　　職事表現在是：' + (r.rosterName || '（空白）'));
    lines.push('　　週報現在顯示：' + (r.bulletinName || '（空白）'));
    lines.push('');
  });
  lines.push('本系統不會改動職事表。如果週報的版本才是正確的，請自行到職事表更正。');
  lines.push('');
  lines.push('如果職事表的版本才是正確的，可以在週報填寫介面撳「由職事表重新取數」，逐項勾選要改回職事表值的欄位。');
  return lines.join('\n');
}

/**
 * 用途：讀出 `ConflictNoticeLog` 內已經通知過的全部指紋。工作表不存在時
 *   回空陣列而不是拋錯——這是第六輪才新增的表，還沒撳「初始化工作表」
 *   時，最壞情況只是多寄一封提醒信，不應該讓整個流程失敗。
 * Args: （無）
 * Returns:
 *   {string[]}
 */
function readNotifiedFingerprints_() {
  try {
    return readSheet(SHEETS.CONFLICT_NOTICE_LOG).map(function (r) { return String(r.FINGERPRINT || ''); });
  } catch (err) {
    return [];
  }
}

/**
 * 用途：偵測職事表分歧，有**未通知過的**衝突時寄一封提醒信。
 *
 *   流程：
 *     1. `computeRosterDiff_()`（唯讀，刻意不用 `checkRosterDiff_()`——
 *        寄信不應該順手消耗掉 `FOLLOW` 狀態）。
 *     2. `conflictCount === 0` → 不寄，回 `{ sent:false, reason:'NO_CONFLICT' }`。
 *     3. 全部衝突的指紋都通知過 → 不寄，回
 *        `{ sent:false, reason:'ALREADY_NOTIFIED' }`。
 *     4. 收件人是 `Recipients` 中 `GROUP_NAME` 屬於 Config
 *        `CONFLICT_NOTICE_GROUPS`（預設 `ADMIN`）的人；一個都沒有 →
 *        不寄，回 `{ sent:false, reason:'NO_RECIPIENTS' }`。
 *     5. `DRY_RUN=TRUE` → **完全不呼叫 `MailApp`**，但照樣寫 `SendLog`。
 *     6. 只有**非** `DRY_RUN` 時才把指紋寫進 `ConflictNoticeLog`。
 *
 *   ⚠️ 為什麼 `DRY_RUN` 不記指紋：`SendLog` 是**記錄**（寫了不影響
 *   將來的行為），指紋卻是**狀態**（寫了之後這個衝突就永遠不再寄）。
 *   試行模式如果把指紋記下來，第一封真正的提醒信就會被靜靜略過——
 *   那正是試行模式最不應該造成的後果。所以記錄照寫，狀態不動。
 * Args:
 *   isoDate {string} 主日日期，yyyy-MM-dd。
 * Returns:
 *   {{sent:boolean, reason:(string|undefined), dryRun:boolean,
 *     conflictCount:number, notifiedCount:number, recipientCount:number}}
 * Raises:
 *   Error 如果 `isoDate` 格式不對，或職事表讀取失敗
 *     （`computeRosterDiff_()` 原樣拋出）。
 */
function sendConflictNoticeIfNeeded_(isoDate) {
  var diff = computeRosterDiff_(isoDate);
  var dryRun = normalizeBoolean_(getConfig(CONFIG_KEYS.DRY_RUN, 'TRUE')) === true;

  if (diff.conflictCount === 0) {
    return { sent: false, reason: 'NO_CONFLICT', dryRun: dryRun, conflictCount: 0, notifiedCount: 0, recipientCount: 0 };
  }

  var fresh = filterUnnotifiedConflicts_(diff.rows, readNotifiedFingerprints_(), isoDate);
  if (fresh.length === 0) {
    return {
      sent: false, reason: 'ALREADY_NOTIFIED', dryRun: dryRun,
      conflictCount: diff.conflictCount, notifiedCount: 0, recipientCount: 0
    };
  }

  var allowedGroups = getConfigTextList_(CONFIG_KEYS.CONFLICT_NOTICE_GROUPS, 'ADMIN');
  var recipientsResult = buildRecipientList_(readSheet(SHEETS.RECIPIENTS), allowedGroups, normalizeDate_(isoDate));
  if (recipientsResult.recipients.length === 0) {
    return {
      sent: false, reason: 'NO_RECIPIENTS', dryRun: dryRun,
      conflictCount: diff.conflictCount, notifiedCount: 0, recipientCount: 0
    };
  }

  var churchName = getConfig(CONFIG_KEYS.CHURCH_NAME, '');
  var subject = churchName + '週報：職事表分歧提醒（' + isoDate + '，' + fresh.length + ' 項）';
  var htmlBody = buildConflictNoticeHtml_(isoDate, fresh, { churchName: churchName });
  var plainBody = buildConflictNoticePlainText_(isoDate, fresh, { churchName: churchName });

  var sendLogRows = [];
  recipientsResult.recipients.forEach(function (recipient) {
    var status = 'CONFLICT_NOTICE';
    var errorMessage = '';

    if (!dryRun) {
      try {
        MailApp.sendEmail({ to: recipient.email, subject: subject, body: plainBody, htmlBody: htmlBody });
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
      ROSTER_VERSION_USED: sanitizeCellText_(diff.rosterVersion === null ? '（尚未生成）' : String(diff.rosterVersion)),
      ERROR: sanitizeCellText_(errorMessage),
      BODY_PREVIEW: buildSendLogBodyPreview_(plainBody)
    });
  });

  writeSheet(SHEETS.SEND_LOG, sendLogRows);

  if (!dryRun) {
    recordNotifiedFingerprints_(isoDate, fresh);
  }

  return {
    sent: true, dryRun: dryRun, conflictCount: diff.conflictCount,
    notifiedCount: fresh.length, recipientCount: recipientsResult.recipients.length
  };
}

/**
 * 用途：把這一次通知過的衝突指紋寫進 `ConflictNoticeLog`。只會新增，
 *   不會刪除或覆寫。
 * Args:
 *   isoDate {string} 主日日期，yyyy-MM-dd。
 *   rows {Object[]} `filterUnnotifiedConflicts_()` 的輸出（帶 `fingerprint`）。
 * Returns:
 *   {number} 寫入的行數。
 */
function recordNotifiedFingerprints_(isoDate, rows) {
  if (!rows || rows.length === 0) return 0;
  var now = new Date();
  var targetDate = normalizeDate_(isoDate);

  writeSheet(SHEETS.CONFLICT_NOTICE_LOG, rows.map(function (r) {
    return {
      TIMESTAMP: now,
      SERVICE_DATE: targetDate,
      POST_ID: sanitizeCellText_(r.postId),
      SLOT_INDEX: r.slotIndex,
      FINGERPRINT: sanitizeCellText_(r.fingerprint),
      ROSTER_VALUE: sanitizeCellText_(r.rosterName),
      NOTES: '已寄出分歧提醒；職事表再改一次（指紋變了）才會再寄。'
    };
  }));
  return rows.length;
}
