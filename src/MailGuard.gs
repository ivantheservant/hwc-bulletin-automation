/**
 * src/MailGuard.gs
 *
 * 2026-11-02（Ivan 第 8 項）：寄出電郵的白名單（Config `EMAIL_ALLOWLIST`）。
 *
 *   ⚠️ **全系統只有本檔案的 `sendEmailAllowlisted_()` 准許呼叫 `MailApp.sendEmail`**（`GmailApp` 一律不用）。
 *   由 tests/mailguard.test.js 靜態掃描鎖住：其他檔案出現就紅。
 *
 *   - 名單內的地址（不分大小寫、去頭尾空白）才寄；`to`／`cc`／`bcc` 逐個地址過濾；
 *   - 過濾之後 `to` 一個都不剩＝不寄（回 `sent:false`），呼叫方在 SendLog 記 `NOT_ALLOWED`、結果訊息講明；
 *   - 有地址被拿走：ErrorLog 記一筆（同一次執行、同一個函式、同一個主旨只記一次，其餘見 SendLog）；
 *   - Config 留空＝不限制；Config 沒有這個鍵（未按「初始化工作表」）＝預設名單 `emailAllowlistSeedValue_()`：本系統帳戶
 *     （`Session.getEffectiveUser()`，開發時是 Ivan 的帳戶）加同一個網域的 hwc 信箱。「初始化工作表」亦把這一份寫入 Config。
 *     ⚠️ 不寫死真實電郵（公開 repo，tools/scan-staged-secrets.js 會擋）；取不到帳戶就一封都不寄（寧可不寄，不可以不限制）。
 *   - `DRY_RUN` 仍然是總開關：試行時呼叫方根本不會叫到這裏。
 */

'use strict';

/** 預設名單內、與本系統帳戶同一個網域的角色信箱（只有 @ 前面那一段）。 */
var EMAIL_ALLOWLIST_ROLE_MAILBOXES_ = ['hwc'];

/** 取不到本系統帳戶時的預設名單：一個不會配對到任何地址的記號（＝一封都不寄）。 */
var EMAIL_ALLOWLIST_UNKNOWN_ = '（取不到本系統帳戶，請在 Config 填寫寄送名單）';

/**
 * 用途：寄送名單的預設值：本系統帳戶的電郵，加同一個網域的角色信箱（`EMAIL_ALLOWLIST_ROLE_MAILBOXES_`）。
 *   「初始化工作表」寫入 Config 時、以及 Config 未有這個鍵時用。
 * Args: （無）
 * Returns:
 *   {string} 逗號分隔；取不到帳戶就是 `EMAIL_ALLOWLIST_UNKNOWN_`（不會配對到任何地址）。
 */
function emailAllowlistSeedValue_() {
  var me = '';
  try {
    me = String(Session.getEffectiveUser().getEmail() || '').trim().toLowerCase();
  } catch (err) {
    me = '';
  }
  var at = me.indexOf('@');
  if (at <= 0) return EMAIL_ALLOWLIST_UNKNOWN_;
  var domain = me.slice(at + 1);
  var list = [me];
  EMAIL_ALLOWLIST_ROLE_MAILBOXES_.forEach(function (local) {
    var addr = local + '@' + domain;
    if (list.indexOf(addr) === -1) list.push(addr);
  });
  return list.join(',');
}

/** 同一次執行內已經記過 ErrorLog 的（函式＋主旨），見 `recordEmailNotAllowed_()`。 */
var EMAIL_ALLOWLIST_LOGGED_ = {};

/**
 * 用途：解析白名單（逗號、分號、空白、換行分隔）。純函式。
 * Args:
 *   raw {*} Config 原始值。
 * Returns:
 *   {?string[]} 小寫地址；空白（不限制）回 null。
 */
function parseEmailAllowlist_(raw) {
  var list = String(raw === null || raw === undefined ? '' : raw).split(/[,;，；\s]+/)
    .map(function (s) { return emailAddressOf_(s); })
    .filter(function (s) { return s !== ''; });
  return list.length > 0 ? list : null;
}

/**
 * 用途：由「名稱 <地址>」或者單純地址取出地址（小寫、去頭尾空白）。純函式。
 * Args:
 *   text {*}
 * Returns:
 *   {string}
 */
function emailAddressOf_(text) {
  var s = String(text === null || text === undefined ? '' : text).trim();
  var m = /<([^>]+)>/.exec(s);
  return (m ? m[1] : s).trim().toLowerCase();
}

/**
 * 用途：按白名單過濾一個收件欄（可以有多個地址，逗號分隔）。純函式。
 * Args:
 *   field {*} `to`／`cc`／`bcc` 原值。　allowlist {?string[]} `parseEmailAllowlist_()`；null＝不限制。
 * Returns:
 *   {{kept:string, dropped:string[]}} `kept` 是留下的地址（原樣，逗號分隔）；`dropped` 是拿走的地址（原樣）。
 */
function filterEmailField_(field, allowlist) {
  var parts = String(field === null || field === undefined ? '' : field).split(',')
    .map(function (s) { return s.trim(); }).filter(function (s) { return s !== ''; });
  if (!allowlist) return { kept: parts.join(','), dropped: [] };
  var kept = [];
  var dropped = [];
  parts.forEach(function (p) {
    if (allowlist.indexOf(emailAddressOf_(p)) !== -1) kept.push(p);
    else dropped.push(p);
  });
  return { kept: kept.join(','), dropped: dropped };
}

/**
 * 用途：讀 Config 的白名單；Config 未有這個鍵（未按「初始化工作表」）就用 `emailAllowlistSeedValue_()`。
 * Args: （無）
 * Returns:
 *   {?string[]} 見 `parseEmailAllowlist_()`。
 */
function readEmailAllowlist_() {
  var all = loadConfigCache_();
  var raw = Object.prototype.hasOwnProperty.call(all, CONFIG_KEYS.EMAIL_ALLOWLIST)
    ? all[CONFIG_KEYS.EMAIL_ALLOWLIST] : emailAllowlistSeedValue_();
  return parseEmailAllowlist_(raw);
}

/**
 * 用途：**全系統唯一寄電郵的地方。** 按 Config `EMAIL_ALLOWLIST` 過濾 `to`／`cc`／`bcc`，`to` 還有地址才寄。
 * Args:
 *   message {Object} `MailApp.sendEmail()` 的參數物件（`to`、`subject`、`body`、`htmlBody`、`attachments`……）。不會被改。
 *   functionName {string} 呼叫方函式名稱（ErrorLog 用）。
 * Returns:
 *   {{sent:boolean, dropped:string[], message:string}} `sent:false`＝一封都沒有寄（全部不在名單）；`dropped` 是拿走的地址；
 *     `message` 是給 SendLog／結果訊息用的一句（沒有拿走就是空字串）。
 * Raises:
 *   Error `MailApp.sendEmail()` 本身的錯誤原樣拋出（呼叫方照舊記 FAILED）。
 */
function sendEmailAllowlisted_(message, functionName) {
  var allowlist = readEmailAllowlist_();
  var out = Object.assign({}, message || {});
  var dropped = [];
  ['to', 'cc', 'bcc'].forEach(function (field) {
    if (out[field] === undefined) return;
    var r = filterEmailField_(out[field], allowlist);
    dropped = dropped.concat(r.dropped);
    if (r.kept) out[field] = r.kept; else delete out[field];
  });
  var note = dropped.length > 0 ? emailNotAllowedText_(dropped) : '';
  if (dropped.length > 0) recordEmailNotAllowed_(functionName, String(out.subject || ''), dropped);
  if (!out.to) return { sent: false, dropped: dropped, message: note };
  MailApp.sendEmail(out);
  return { sent: true, dropped: dropped, message: note };
}

/**
 * 用途：地址不在白名單時的一句（SendLog 的 ERROR 欄與結果訊息用）。純函式。
 * Args:
 *   dropped {string[]}
 * Returns:
 *   {string}
 */
function emailNotAllowedText_(dropped) {
  return '不在 Config EMAIL_ALLOWLIST 的寄送名單，沒有寄給：' + (dropped || []).join('、');
}

/**
 * 用途：結果訊息後面那一句「另有 N 個地址不在寄送名單」。純函式。
 * Args:
 *   count {number}
 * Returns:
 *   {string} 0 個就空字串。
 */
function emailAllowlistResultNote_(count) {
  var n = Number(count || 0);
  return n > 0 ? ('⚠️ 另有 ' + n + ' 個收件人不在 Config EMAIL_ALLOWLIST 的寄送名單，沒有寄出（見 SendLog）。') : '';
}

/**
 * 用途：把被白名單拿走的地址記入 ErrorLog（同一次執行、同一個函式、同一個主旨只記一次）。寫不到不影響寄送。
 * Args:
 *   functionName {string}　subject {string}　dropped {string[]}
 * Returns:
 *   {void}
 */
function recordEmailNotAllowed_(functionName, subject, dropped) {
  var key = String(functionName || '') + '|' + String(subject || '');
  if (EMAIL_ALLOWLIST_LOGGED_[key]) return;
  EMAIL_ALLOWLIST_LOGGED_[key] = true;
  try {
    appendErrorLog_({
      source: ERROR_LOG_SOURCE.SERVER, functionName: String(functionName || 'sendEmailAllowlisted_'),
      errorCode: 'EMAIL_NOT_IN_ALLOWLIST',
      message: '電郵「' + String(subject || '') + '」：' + emailNotAllowedText_(dropped)
        + '（同一封其餘收件人見 SendLog；要寄給他們請在 Config EMAIL_ALLOWLIST 加上，或者留空＝不限制）。'
    });
  } catch (err) {
    // 記不到不阻止寄送。
  }
}
