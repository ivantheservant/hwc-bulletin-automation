/**
 * src/FriendlyMessages.gs
 *
 * 2026-11-04（Ivan 測試結果 C）：填寫介面的警告、錯誤訊息對幹事太技術性（工作表名稱、PersonID、Config 鍵），
 *   他們亦不會打開週報系統試算表。這裏把訊息改寫成幹事看得明白、知道下一步做甚麼的句子；
 *   原本的技術內容保留在 `adminDetail`（填寫介面收起來，標「給管理員參考」），有需要時幹事可以抄給管理員。
 *
 *   ⚠️ 只改「顯示給人看的字」：代碼（`code`）不變，任何判斷、計數、待填清單都不看這裏的字。
 *   ⚠️ 認不出、又不像技術內容的訊息原樣顯示（不會因為未有對照就把警告吞掉——bug class 2）。
 */

'use strict';

/** 會令幹事看不明白的字眼：週報系統試算表的工作表名稱、職事表的工作表名稱。 */
var TECHNICAL_SHEET_WORDS_ = Object.freeze([
  'PersonDisplay', 'ProgramTemplates', 'BulletinWeeks', 'Recipients', 'EmailTemplates', 'AuditLog', 'ErrorLog',
  'SendLog', 'Diagnostics', 'NameMapping', 'ServiceDates', 'RosterAssignments', 'MergeGroups', 'PostDisplay',
  'Quarters', 'ContentSheets', 'PersonNameSnapshot', 'PersonID', 'PostID', 'ScriptProperties', 'Config'
]);

/** 已有人話寫法的錯誤碼（填寫介面頂部的紅色訊息）。 */
var FRIENDLY_ERROR_TEXT_ = Object.freeze({
  VIEW_ONLY: '你的帳戶只可以查看，不可以修改、儲存或發佈。如需要修改，請聯絡管理員。',
  FORBIDDEN: '你目前沒有權限使用本填寫介面。請聯絡管理員，把你的電郵加入填寫介面的名單。',
  WORD_NOT_STORED: '系統未設定存放 Word 的資料夾，所以未能預覽 Word。請通知管理員。',
  SCHEMA_OUTDATED: '系統剛更新，要先由管理員做一次「初始化」才可以繼續，這一次沒有寫入任何東西。請通知管理員；完成之後再做一次。',
  WORD_STORE_FAILED: 'Word 已產生，但存到雲端硬碟時出現問題，未能預覽。請稍後再試一次；如果仍然出現，請通知管理員。'
});

/**
 * 用途：訊息是否含技術字眼（工作表名稱、全大寫的代號、程式例外）。純函式。
 * Args: message {string}
 * Returns: {boolean}
 */
function looksTechnicalText_(message) {
  var msg = String(message || '');
  if (/選單「|試算表|Apps Script/.test(msg)) return true;
  if (/[A-Z][A-Z0-9]*_[A-Z0-9_]+/.test(msg)) return true;
  if (/(TypeError|ReferenceError|Exception|undefined|null is not|Cannot read|is not a function)/.test(msg)) return true;
  return TECHNICAL_SHEET_WORDS_.some(function (w) { return msg.indexOf(w) !== -1; });
}

/**
 * 用途：把訊息裏括號內的技術補充（例如「（Config 的 BULLETIN_OUTPUT_FOLDER_ID）」）刪去。純函式。
 * Args: message {string}
 * Returns: {string}
 */
function stripTechnicalParens_(message) {
  return String(message || '').replace(/（[^（）]*）/g, function (part) {
    return looksTechnicalText_(part) ? '' : part;
  });
}

/**
 * 用途：刪去叫人用週報系統試算表選單的句子（幹事不會打開那個試算表），並把「週報試算表」改為「週報系統」。純函式。
 * Args: message {string}
 * Returns: {{text:string, dropped:boolean}} `dropped`＝刪過句子。
 */
function stripSpreadsheetSentences_(message) {
  var dropped = false;
  var sentences = String(message || '').replace(/週報(系統)?試算表/g, '週報系統').split(/(?<=。)/);
  var kept = sentences.filter(function (part) {
    if (/選單|試算表|Apps Script/.test(part)) { dropped = true; return false; }
    return true;
  });
  return { text: kept.join('').trim(), dropped: dropped };
}

/**
 * 用途：沒有專門寫法的訊息 → 去掉技術字眼的版本（括號內的技術補充、叫人用試算表選單的句子）。純函式。
 * Args:
 *   message {string}　ending {string} 刪過東西時加在句尾的一句（已經講「管理員」就不加）。
 * Returns:
 *   {?string} 刪完仍然有技術字眼（或者甚麼都不剩）就回 `null`，由呼叫方改用通用的一句。
 */
function softenTechnicalText_(message, ending) {
  var stripped = stripSpreadsheetSentences_(stripTechnicalParens_(message));
  var text = stripped.text;
  if (!text || looksTechnicalText_(text)) return null;
  return text + (text.indexOf('管理員') === -1 ? ending : '');
}

/**
 * 用途：已知警告代碼 → 幹事看得明白的句子。純函式。
 * Args:
 *   w {{code:string, message:string, name:(string|undefined), dropped:(Object[]|undefined)}} 一項警告。
 * Returns:
 *   {?string} 沒有專門寫法時回 `null`。
 */
function friendlyWarningText_(w) {
  var code = String((w && w.code) || '');
  var name = String((w && w.name) || '').trim();
  var ask = '如有疑問，請把下面「給管理員參考」的內容告訴管理員。';
  var noHonorific = '未有設定稱呼，週報照樣印名字，沒有加「弟兄」「姊妹」等稱呼。';
  switch (code) {
    case 'OVERRIDE_NAME_NOT_IN_PERSON_DISPLAY':
      return '「' + (name || '這個名字') + '」' + noHonorific + '如果是本堂肢體，請通知管理員加上稱呼；臨時幫忙的訪客可以不理。';
    case 'NO_PERSON_DISPLAY':
      return '「' + (name || '職事表上一位事奉人員') + '」' + noHonorific + '請通知管理員加上稱呼。';
    case 'PERSON_NOT_FOUND_IN_NAME_MAPPING':
      return '職事表上有一位事奉人員的資料未齊，週報暫時用職事表寫的名字。如果名字不對，請通知管理員。';
    case 'NEXT_WEEK_NOT_IN_ROSTER':
      return '下一個主日在職事表未有資料（可能下一季的職事表未出），「下週事奉」暫時留白。職事表出了之後，按〔重新載入（讀最新）〕即可。';
    case 'NEXT_WEEK_SNAPSHOT_FAILED':
      return '讀取下一個主日的職事表時出現問題，「下週事奉」暫時留白。請稍後按〔重新載入（讀最新）〕。' + ask;
    case 'BULLETIN_WEEK_ROW_NOT_FOUND':
      return '這一個主日的週報未建立，暫時當作空白。請通知管理員建立這一季的週報。';
    case 'SERVICE_DATE_NOT_FOUND':
      return '職事表未有這一個主日，事奉名單暫時留白。職事表排好之後，按〔重新載入（讀最新）〕即可。';
    case 'QUARTER_NOT_FOUND':
    case 'NO_VERSION_GENERATED':
      return '這一季的職事表未出，事奉名單暫時留白。職事表出了之後，按〔重新載入（讀最新）〕即可。';
    case 'NOT_OFFICIAL':
      return '這一季的職事表仍未正式發出，事奉名單之後可能仍會改動；職事表一改，這裏會跟着更新。';
    case 'WEEK_OF_MONTH_MISMATCH':
      return '職事表標示的「每月第一個主日」與日期對不上，聖餐等項目可能不正確，請核對程序表。' + ask;
    case 'ROSTER_VALUE_UNPARSEABLE':
      return '職事表有一格資料的格式不對，那一格暫時略過。' + ask;
    case 'MERGE_GROUP_NOT_FOUND':
      return '事奉名單的合併設定有問題，有些崗位可能分開顯示。' + ask;
    case 'PROGRAM_TEMPLATE_EMPTY':
      return '這一期用的程序範本沒有任何項目，程序表會是空白。請在「程序範本」選另一個範本。' + ask;
    case 'COMBINED_KIND_UNKNOWN':
      return '職事表把這一週設為合堂，但系統未認得這一種合堂，程序範本暫時按一般規則自動選。請核對「程序範本」是否正確。' + ask;
    case 'DUTY_SLOT_CHECK_FAILED':
      return '未能核對 Word 範本的事奉格數。Word 照樣可以產生，請在 Word 核對事奉名單是否齊全。' + ask;
    case 'DUTY_SLOT_OVERFLOW':
    case 'NEXT_DUTY_SLOT_OVERFLOW':
      var dropped = ((w && w.dropped) || []).map(function (d) {
        return String((d && d.label) || '') + (d && d.text ? '：' + d.text : '');
      }).filter(function (s) { return s !== ''; });
      var raw = String((w && w.message) || '');
      var dateMatch = /\d{4}-\d{2}-\d{2}/.exec(raw);
      var countMatch = /有 (\d+) 項要印/.exec(raw);
      var slotMatch = /只有 (\d+) 格/.exec(raw);
      return (code === 'DUTY_SLOT_OVERFLOW' ? '第 1 頁「本週事奉」' : '第 3 頁「下週事奉」' + (dateMatch ? '（' + dateMatch[0] + '）' : ''))
        + (countMatch && slotMatch ? '有 ' + countMatch[1] + ' 項要印，但 Word 範本只有 ' + slotMatch[1] + ' 格，' : '的項目比 Word 範本的格多，')
        + (dropped.length ? '以下 ' + dropped.length + ' 項不會印出：' + dropped.join('、') + '。' : '有些項目不會印出。')
        + '請通知管理員在 Word 範本加格。';
    case 'YEAR_LOGO_NOT_APPLIED':
    case 'YEAR_LOGO_NOT_IMAGE':
    case 'YEAR_LOGO_NOT_IN_TEMPLATE':
    case 'YEAR_LOGO_UNREADABLE':
      return '年度標誌未能放入這一期週報；Word 照樣產生，用回範本原有的標誌。' + ask;
    case 'UNKNOWN_PLACEHOLDER':
    case 'RESIDUAL_PLACEHOLDER':
    case 'PLACEHOLDER_VALUE_MISSING':
    case 'BROKEN_PLACEHOLDER':
    case 'NO_NORMAL_ROW_TEMPLATE':
    case 'NO_FULL_WIDTH_ROW_TEMPLATE':
      return 'Word 範本有一處設定不完整，這一期的 Word 可能有一處空白，或者印出「{{…}}」。請在 Word 核對。' + ask;
    case 'WORD_NOT_STORED':
      return 'Word 已產生，但系統未設定存放 Word 的資料夾，雲端硬碟沒有留存最新版。請通知管理員。';
    case 'WORD_NOT_RECORDED':
      return 'Word 已存到雲端硬碟，但這一個主日的週報未建立，重新載入後看不到 Word 的連結。請通知管理員建立這一季的週報。';
    case 'WORD_STORE_FAILED':
      return 'Word 已產生，但存到雲端硬碟時出現問題，雲端硬碟上的最新版未更新。請稍後再試一次。' + ask;
    case 'BAD_RECURRENCE':
      var fellowship = /團契「([^」]*)」/.exec(String((w && w.message) || ''));
      return '團契「' + (fellowship ? fellowship[1] : '') + '」的聚會日子設定有問題，這一期暫時不列出這個團契。' + ask;
    case 'FOLLOW_RECORD_FAILED':
      return '與職事表的比對照常顯示，但記錄「自動跟隨」時出現問題。' + ask;
    case 'CHURCH_NAME_NOT_CONFIGURED':
      return '系統未設定教會全名，電郵內的教會名稱會是空白。請通知管理員。';
    default:
      return null;
  }
}

/**
 * 用途：一項警告 → 幹事看得明白的寫法（見檔頭）。純函式。
 *   有專門寫法就用；沒有但含技術字眼，就刪去括號內的技術補充，仍然有技術字眼就改成一句通用的話。
 * Args:
 *   w {Object} `{code, message}`。
 * Returns:
 *   {Object} 新物件；改寫過的 `message`＝新句子、`adminDetail`＝原本的訊息。沒有改寫就原物件。
 */
function toFriendlyWarning_(w) {
  if (!w || typeof w !== 'object') return w;
  var original = String(w.message || '');
  var friendly = friendlyWarningText_(w);
  if (!friendly && looksTechnicalText_(original)) {
    friendly = softenTechnicalText_(original, '如有需要，請通知管理員。')
      || '系統讀取資料時發現一處設定問題，週報照樣產生，但可能有一處內容不完整。請把下面「給管理員參考」的內容告訴管理員。';
  }
  if (!friendly) return w;
  return Object.assign({}, w, { message: friendly, adminDetail: original });
}

/**
 * 用途：一批警告逐項改寫（`toFriendlyWarning_`）。純函式。
 * Args: warnings {Object[]}
 * Returns: {Object[]} 新陣列。
 */
function toFriendlyWarnings_(warnings) {
  return (warnings || []).map(toFriendlyWarning_);
}

/**
 * 用途：API 錯誤 → 幹事看得明白的寫法。純函式。由 `withApiResult_()` 叫。
 * Args:
 *   code {string}　message {string} 原本的錯誤訊息。
 * Returns:
 *   {{message:string, adminDetail:string}} `adminDetail` 空字串＝沒有改寫。
 */
function friendlyApiError_(code, message) {
  var original = String(message || '');
  var known = FRIENDLY_ERROR_TEXT_[String(code || '')];
  if (known) return { message: known, adminDetail: original };
  if (original.indexOf('授權範圍問題') !== -1) {
    return { message: '系統需要管理員重新授權才可以完成這個動作。請通知管理員。', adminDetail: original };
  }
  if (!looksTechnicalText_(original)) return { message: original, adminDetail: '' };
  var softened = softenTechnicalText_(original, '如有需要，請通知管理員。');
  if (softened) return { message: softened, adminDetail: original };
  return {
    message: '系統未能完成這個動作。請稍後再試一次；如果仍然出現，請把下面「給管理員參考」的內容告訴管理員。',
    adminDetail: original
  };
}
