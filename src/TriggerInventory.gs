/**
 * TriggerInventory.gs
 *
 * 內容表 v2：本專案觸發器的預期清單——「應該有哪幾個觸發器、各幾多個」只寫在這裏一處。
 *
 * 用的地方（三處同一個來源，bug class 12、117、143）：
 *   - 「完成度自我檢測」（`selfCheckFeatureItems_()`，src/SelfCheck.gs）；
 *   - 「上線前檢查」（`buildGoLiveChecklist_()`，src/GoLive.gs）第 4 項與「其他觸發器」一項；
 *   - 選單「查看觸發器狀態」（`menuShowTriggerStatus_()`，src/Trigger.gs）；
 *   另外「停用舊功能」（src/RetireLegacy.gs）用同一份清單決定要拆哪幾個，講員表格的檢測
 *   （`inspectSpeakerFormState_()`）亦由這裏取表單提交觸發器的數目。
 *
 * 預期（docs/待確認事項.md 內容表 v2 決定 1）：
 *   - `weeklyBulletinSendTrigger_`＝1（星期一自動寄送）；
 *   - `onFillGridEdit_`＝1：名字是季度填寫表年代留下的，但同一個 onEdit 觸發器兼做 Config 人手改動
 *     稽核（事故四十三，bug class 101），季度填寫表停用之後仍然要保留；
 *   - `fillReconcileTrigger_`＝0、`onSpeakerFormSubmit_`＝0：已停用，由「季度工具 ▸ 停用舊功能」拆走。
 *
 * 讀不到觸發器清單（未授權等）一律當「讀不到」（`actual:null`），不當成 0 個（bug class 41）。
 */

'use strict';

/**
 * 審查 F10：`ScriptApp.getProjectTriggers()` 只列目前帳戶自己安裝的觸發器。用另一個帳戶（例如日後的
 * 幹事帳戶）安裝的舊觸發器不會計入、亦不會被「停用舊功能」拆走，要用那個帳戶再看一次。
 */
var TRIGGER_OWNER_SCOPE_NOTE_ = '注意：這裏只計你這個帳戶自己安裝的觸發器。其他帳戶（例如幹事帳戶）安裝的，'
  + '要用那個帳戶登入再看一次。';

/**
 * 用途：本專案每一種觸發器的預期數目與說明。純函式；唯一真相來源。
 * Args: （無）
 * Returns:
 *   {{handler:string, label:string, expected:number, retired:boolean, missingHint:string,
 *     duplicateHint:string}[]} `duplicateHint` 內的 `{{N}}` 換成實際數目。
 * Raises:
 *   （無）
 */
function expectedProjectTriggers_() {
  return [
    {
      handler: 'weeklyBulletinSendTrigger_', label: '自動寄送', expected: 1, retired: false,
      missingHint: '星期一不會自動寄週報。請按選單「安裝自動寄送觸發器」。',
      duplicateHint: '每一個都會各自跑一次，即是同一期週報會寄 {{N}} 次給全教會。'
        + '請按選單「移除自動寄送觸發器」再按一次「安裝自動寄送觸發器」。'
    },
    {
      // v3（2026-10-26）：每日自動建立季度（與自動寄送一齊安裝、一齊移除）。
      handler: 'dailyQuarterAutoCreateTrigger_', label: '每日自動建立新季度及排好內容表', expected: 1, retired: false,
      missingHint: '職事表有新季度時不會每日自動建立（開啟填寫介面時仍然會檢查），內容表的家事報告、代禱事項、財政報告亦不會每日按日期排好。請按選單「安裝自動寄送觸發器」。',
      duplicateHint: '每一個都會各自跑一次（多跑不會重複建立，但浪費時間）。'
        + '請按選單「移除自動寄送觸發器」再按一次「安裝自動寄送觸發器」。'
    },
    {
      // 2026-10-30：內容表自動同步（與自動寄送一齊安裝、一齊移除）。Config 設 0 時預期 0 個。
      handler: 'contentAutoSyncTrigger_', label: '內容表自動同步',
      expected: parseContentAutoSyncMinutes_(getConfig_(CONFIG_KEYS.CONTENT_AUTO_SYNC_MINUTES, '30')).minutes > 0 ? 1 : 0,
      retired: false,
      missingHint: '內容表改了之後，要等幹事打開填寫介面或星期一才會匯入，預覽連結不會自動更新。請按選單「安裝自動寄送觸發器」。',
      duplicateHint: '每一個都會各自跑一次（多跑不會重複寫，但浪費時間）。'
        + '請按選單「移除自動寄送觸發器」再按一次「安裝自動寄送觸發器」。'
    },
    {
      handler: 'onFillGridEdit_', label: 'Config 人手改動稽核', expected: 1, retired: false,
      missingHint: '人手改 Config 不會記入 AuditLog。請按選單「' + QUARTER_TOOLS_MENU_LABEL_
        + ' ▸ 安裝 Config 改動稽核觸發器」。',
      duplicateHint: '同一次改動會記 {{N}} 次。請按選單「' + QUARTER_TOOLS_MENU_LABEL_
        + ' ▸ 安裝 Config 改動稽核觸發器」（安裝之前會先刪走同名的，裝完剛好 1 個）。'
    },
    {
      handler: 'fillReconcileTrigger_', label: '季度填寫表對帳（已停用）', expected: 0, retired: true,
      missingHint: '', duplicateHint: ''
    },
    {
      handler: 'onSpeakerFormSubmit_', label: '講員表格提交（已停用）', expected: 0, retired: true,
      missingHint: '', duplicateHint: ''
    }
  ];
}

/**
 * 用途：按預期清單判斷一種觸發器的狀態。純函式。
 * Args:
 *   def {Object} `expectedProjectTriggers_()` 其中一項。
 *   actual {?number} 實際數目；`null`＝讀不到觸發器清單。
 *   statuses {Object} `SELF_CHECK_STATUS_`。
 * Returns:
 *   {{status:string, message:string}}
 * Raises:
 *   （無）
 */
function judgeProjectTriggerCount_(def, actual, statuses) {
  if (actual === null || actual === undefined) {
    return { status: statuses.YELLOW, message: '讀不到觸發器清單（可能未授權）。⚠️ 「讀不到」不等於「沒問題」。' };
  }
  if (def.retired) {
    if (actual === 0) return { status: statuses.GREEN, message: '已停用，沒有安裝（正確）。' };
    return {
      status: statuses.YELLOW,
      message: '已停用，但仍然安裝了 ' + actual + ' 個（處理函式已經不會寫入任何一格，但應該拆走）。'
        + '請按選單「' + retireLegacyMenuPath_() + '」。'
    };
  }
  if (actual === def.expected) return { status: statuses.GREEN, message: '剛好安裝了 ' + actual + ' 個。' };
  if (actual === 0) return { status: statuses.YELLOW, message: '一個都沒有安裝——' + def.missingHint };
  return {
    status: statuses.RED,
    message: '⚠️ 安裝了 ' + actual + ' 個！' + String(def.duplicateHint).split('{{N}}').join(String(actual))
  };
}

/**
 * 用途：數本專案實際安裝了哪些觸發器，逐項對照預期清單。唯讀。
 * Args: （無）
 * Returns:
 *   {{ok:boolean, error:string, total:?number,
 *     items:{handler:string, label:string, expected:number, retired:boolean, actual:?number,
 *       status:string, message:string}[],
 *     unknown:{handler:string, count:number, eventType:string}[]}}
 *     讀不到清單時 `ok:false`、每一項 `actual:null`（🟡），`unknown` 是空陣列。
 * Raises:
 *   （無）讀不到觸發器清單的錯誤放在 `error`。
 */
function inspectProjectTriggers_() {
  var counts = null;
  var eventTypes = {};
  var total = null;
  var error = '';
  try {
    var triggers = ScriptApp.getProjectTriggers();
    counts = {};
    total = triggers.length;
    triggers.forEach(function (t) {
      var handler = t.getHandlerFunction();
      counts[handler] = (counts[handler] || 0) + 1;
      if (!eventTypes[handler]) {
        try {
          eventTypes[handler] = String(t.getEventType());
        } catch (eventErr) {
          eventTypes[handler] = '';
        }
      }
    });
  } catch (err) {
    counts = null;
    error = (err && err.message) ? err.message : String(err);
  }

  var expected = expectedProjectTriggers_();
  var known = {};
  var items = expected.map(function (def) {
    known[def.handler] = true;
    var actual = counts === null ? null : (counts[def.handler] || 0);
    var verdict = judgeProjectTriggerCount_(def, actual, SELF_CHECK_STATUS_);
    return {
      handler: def.handler, label: def.label, expected: def.expected, retired: def.retired,
      actual: actual, status: verdict.status, message: verdict.message
    };
  });

  var unknown = counts === null ? [] : Object.keys(counts).filter(function (h) { return !known[h]; }).sort()
    .map(function (h) { return { handler: h, count: counts[h], eventType: eventTypes[h] || '' }; });

  return { ok: counts !== null, error: error, total: total, items: items, unknown: unknown };
}

/**
 * 用途：清單以外的觸發器（不認識的處理函式）轉成一個檢測項目。純函式。
 * Args:
 *   report {Object} `inspectProjectTriggers_()` 的輸出。
 *   statuses {Object} `SELF_CHECK_STATUS_`。
 * Returns:
 *   {?{status:string, message:string}} 沒有不認識的觸發器時回 `null`。
 * Raises:
 *   （無）
 */
function buildUnknownTriggersVerdict_(report, statuses) {
  if (!report.unknown || report.unknown.length === 0) return null;
  return {
    status: statuses.YELLOW,
    message: '有不在預期清單內的觸發器：'
      + report.unknown.map(function (u) { return u.handler + '（' + u.count + ' 個）'; }).join('、')
      + '。如果不是你自己裝的，請在 Apps Script 編輯器「觸發條件」頁面查看後刪除。'
  };
}

/**
 * 用途：「查看觸發器狀態」對話框的內容：每一種觸發器一行，寫明預期與實際數目及狀態；
 *   清單以外的另列。純函式。
 * Args:
 *   report {Object} `inspectProjectTriggers_()` 的輸出。
 * Returns:
 *   {{title:string, lines:string[]}}
 * Raises:
 *   （無）
 */
function buildTriggerStatusLines_(report) {
  if (!report.ok) {
    return {
      title: '查看觸發器狀態',
      lines: ['讀不到觸發器清單：' + report.error, '⚠️ 「讀不到」不等於「沒問題」。']
    };
  }
  var lines = report.items.map(function (item) {
    return item.status + ' ' + item.label + '（' + item.handler + '）：預期 ' + item.expected
      + ' 個，實際 ' + item.actual + ' 個。' + item.message;
  });
  if (report.unknown.length > 0) {
    lines.push('');
    lines.push('不在預期清單內：');
    report.unknown.forEach(function (u) {
      lines.push('　' + u.handler + (u.eventType ? '（' + u.eventType + '）' : '') + '：' + u.count + ' 個');
    });
  }
  // 審查 F10：Apps Script 只列得出目前帳戶自己安裝的觸發器。
  lines.push('');
  lines.push(TRIGGER_OWNER_SCOPE_NOTE_);
  return { title: '查看觸發器狀態（共 ' + report.total + ' 個）', lines: lines };
}
