/**
 * Recipients.gs
 *
 * 收件人解析：把 `Recipients` 工作表的資料列，篩成「這一個主日真正要
 * 寄給誰」的清單。分兩層：
 *   - `resolveRecipients_(isoDate)`　真正入口，讀 `Recipients` 與 Config
 *     的 `SEND_GROUPS`。
 *   - `buildRecipientList_(rows, allowedGroups, targetDate)`　純函式，
 *     全部資料由呼叫方傳進來，不碰 Apps Script 服務，方便在 Node 直接測試。
 *
 * 篩選規則（依序）：
 *   1. 只取 `ACTIVE=TRUE`。
 *   2. `GROUP_NAME` 必須在 Config `SEND_GROUPS` 之內。
 *   3. `EFFECTIVE_FROM`／`EFFECTIVE_TO` 要涵蓋目標日期（留空＝不限，
 *      邊界含入）。
 *   4. 電郵格式明顯不合法 → 排除，記一筆 warning，**不可以靜靜略過**。
 *   5. 同一個電郵出現多次 → 去重，保留第一個，記一筆 warning。
 *
 * 結果為空時回傳空陣列＋一個明確的 `reason`，呼叫端（`Mailer.gs`）要
 * 據此拋錯，不可以把「寄了 0 封」當成功。
 */

'use strict';

/**
 * 用途：`resolveRecipients_()` 的真正入口。讀 `Recipients` 工作表與
 *   Config 的 `SEND_GROUPS`，交給純函式層篩選。
 * Args:
 *   isoDate {string} 主日日期，yyyy-MM-dd。
 * Returns:
 *   {{recipients:{email:string,name:string,groupName:string}[],
 *     warnings:{code:string,message:string}[], reason:(string|null)}}
 *     見 `buildRecipientList_()`。
 * Raises:
 *   Error 如果 `isoDate` 不是合法的 yyyy-MM-dd（`normalizeDate_()` 原樣拋出）。
 */
function resolveRecipients_(isoDate) {
  var allowedGroups = getConfigTextList_(CONFIG_KEYS.SEND_GROUPS, 'CC,DB,ADMIN');
  var rows = readSheet(SHEETS.RECIPIENTS);
  var targetDate = normalizeDate_(isoDate);
  return buildRecipientList_(rows, allowedGroups, targetDate);
}

/**
 * 用途：收件人篩選的純函式層。完全不碰 Apps Script 服務。
 * Args:
 *   rows {Object[]} `readSheet(SHEETS.RECIPIENTS)` 的輸出。
 *   allowedGroups {string[]} Config `SEND_GROUPS` 解析後的組別清單。
 *   targetDate {Date} 目標主日日期，用來比對 `EFFECTIVE_FROM`／`EFFECTIVE_TO`。
 * Returns:
 *   {{recipients:{email:string,name:string,groupName:string}[],
 *     warnings:{code:string,message:string}[], reason:(string|null)}}
 *     `warnings` 的 `code` 是 `INVALID_EMAIL`／`DUPLICATE_EMAIL` 其中一個；
 *     `reason` 只在 `recipients` 是空陣列時才有值（否則是 `null`），供呼叫端
 *     組出「為什麼一個收件人都沒有」的錯誤訊息，而不是把「寄了 0 封」
 *     當成功。
 */
function buildRecipientList_(rows, allowedGroups, targetDate) {
  var warnings = [];
  var seenEmails = {};
  var recipients = [];

  (rows || []).forEach(function (r) {
    if (r.ACTIVE !== true) return;
    if ((allowedGroups || []).indexOf(r.GROUP_NAME) === -1) return;
    if (!isRecipientEffective_(r, targetDate)) return;

    var email = String(r.EMAIL || '').trim();
    if (!isValidEmailShape_(email)) {
      // ⚠️ 刻意先把姓名取出來另存一個變數，不要在同一行內把這個欄位
      // 存取直接寫在組字串的中間、兩側又各自出現別的引號——那樣寫會被
      // tools/scan-staged-secrets.js 的網域偵測誤判成網域（機器鍵剛好
      // 撞正一個真實頂層網域）。拆開成獨立一行，關卡才不會誤報，這是
      // docs/已知bug類型.md 事故六提到的同一類問題，不應該為了遷就
      // 命名而放寬掃描器。（這裡刻意不寫出完整的觸發樣式，寫出來一樣
      // 會被掃描器自己捉到。）
      var recipientLabel = r.NAME || r.RECIPIENT_ID || '（未知）';
      warnings.push({
        code: 'INVALID_EMAIL',
        message: '收件人「' + recipientLabel + '」的電郵格式不合法（'
          + JSON.stringify(email) + '），已排除，不會寄給這個地址。'
      });
      return;
    }

    var key = email.toLowerCase();
    if (seenEmails[key]) {
      warnings.push({
        code: 'DUPLICATE_EMAIL',
        message: '電郵「' + email + '」在 Recipients 出現多於一次，保留第一筆，其餘略過。'
      });
      return;
    }
    seenEmails[key] = true;

    recipients.push({ email: email, name: String(r.NAME || ''), groupName: r.GROUP_NAME });
  });

  var reason = null;
  if (recipients.length === 0) {
    reason = (rows || []).length === 0
      ? 'Recipients 工作表沒有任何資料列。'
      : '沒有任何符合條件（ACTIVE=TRUE、屬於 Config SEND_GROUPS、在生效期內、電郵格式合法）的收件人。';
  }

  return { recipients: recipients, warnings: warnings, reason: reason };
}

/**
 * 用途：判斷一筆收件人資料的生效期是否涵蓋目標日期，邊界含入。
 * Args:
 *   row {Object} `Recipients` 的一行。
 *   targetDate {?Date} 目標日期；不是合法 `Date` 時視為不限（回 `true`）。
 * Returns:
 *   {boolean}
 */
function isRecipientEffective_(row, targetDate) {
  if (!(targetDate instanceof Date)) return true;
  if (row.EFFECTIVE_FROM instanceof Date && targetDate.getTime() < row.EFFECTIVE_FROM.getTime()) return false;
  if (row.EFFECTIVE_TO instanceof Date && targetDate.getTime() > row.EFFECTIVE_TO.getTime()) return false;
  return true;
}

/**
 * 用途：極簡的電郵格式檢查——只用來排除明顯打錯字的值（空白、缺
 *   `@`、缺網域），不是完整的 RFC 5322 驗證。
 * Args:
 *   email {string}
 * Returns:
 *   {boolean}
 */
function isValidEmailShape_(email) {
  if (!email) return false;
  if (/\s/.test(email)) return false;
  var parts = email.split('@');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return false;
  if (parts[1].indexOf('.') === -1) return false;
  return true;
}
