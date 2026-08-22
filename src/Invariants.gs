/**
 * Invariants.gs
 *
 * 第 1 層：**不變量**——「任何時候都必須成立」的斷言。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 為甚麼要有這一層
 * ─────────────────────────────────────────────────────────────────────
 *
 *   這個專案至今找到的每一個 bug 都是同一個模式：**測試全綠，一實測就中**。
 *   共通根因是「測試的證據來源是人手砌出來的狀態，不是系統真的跑出來的
 *   狀態」。
 *
 *   不變量的角色跟單元測試**完全不同**：單元測試問「這一支函式對不對」，
 *   不變量問「**系統現在這個狀態**自己對不對得住自己」。它不需要知道
 *   系統是怎樣走到這個狀態的，所以它抓得到「沒有人想過要這樣撳」造出來
 *   的狀態——而那正是單元測試的盲區。
 *
 *   ⚠️ 所以每一條不變量都必須**由現況重新算一次**，不可以引用系統自己
 *   報過的數字。「我替換了 40 個佔位符」不是證據，「產出物裡面還有沒有
 *   `{{`」才是證據（見 docs/已知bug類型.md 事故二十二）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 三個狀態，不是兩個
 * ─────────────────────────────────────────────────────────────────────
 *
 *   每一條不變量回 `ok: true`／`false`／**`null`**：
 *
 *     - `true`　　查過，成立。
 *     - `false`　查過，**不成立**——這是紅燈。
 *     - `null`　　**驗證不到**（服務未啟用、檔案讀不到、前置條件未滿足）。
 *
 *   ⚠️ `null` 絕對不可以當成 `true`。「驗證不到」跟「驗證過、沒問題」是
 *   兩件不同的事，混為一談就等於自己騙自己——這是這個專案犯過的錯
 *   （見 `scanDocxResidualPlaceholders_()` 用 `-1` 而不是 `0` 的理由）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ⚠️ 唯讀
 * ─────────────────────────────────────────────────────────────────────
 *
 *   本檔案全部函式一律**不寫入任何資料**。不變量是「照鏡」，不是「執屋」。
 *   一邊檢查一邊順手改動，就再也分不清「本來就對」與「被檢查程序改到對」。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ⚠️ 不是每一條檢查都是「不變量」
 * ─────────────────────────────────────────────────────────────────────
 *
 *   不變量的定義是「**任何時候**都必須成立」。有一類檢查只在**特定時刻**
 *   成立——例如「再匯入一次應為 0 改動」（I08）只在剛剛匯入完那一刻成立，
 *   有人去內容表改一格之後它就不成立，而那是完全合法的狀態。
 *
 *   這一類檢查標 `sideEffect: true`，**不會**被 `runAllInvariants_()` 跑到，
 *   要靠 `runStatefulChecks_()` 在明確需要的情境呼叫。
 *
 *   把它們混進不變量的代價很具體：自測機每個情境跑完都叫一次
 *   `runAllInvariants_()`，一條紅了整個情境就轉紅——第一輪 18 個情境
 *   11 紅，其中 8 個就是被 I08 拖著一齊紅的，那 8 個本身的斷言全部符合
 *   （見 docs/已知bug類型.md 事故二十七）。
 */

'use strict';

/** 不變量的三種結果。`UNKNOWN` 是「驗證不到」，不是「沒問題」。 */
var INVARIANT_RESULT_ = Object.freeze({ OK: 'OK', FAILED: 'FAILED', UNKNOWN: 'UNKNOWN' });

/**
 * 用途：組出一條不變量的結果。小工具，減少重複打字。
 * Args:
 *   id {string} 不變量編號（`I01`…`I10`）。
 *   label {string} 一句中文說明。
 *   ok {?boolean} `true`／`false`／`null`（驗證不到）。
 *   expected {*} 預期值。
 *   actual {*} 實際值。
 *   evidence {string} 證據——**要拿得出實際的值**，不可以只寫「失敗」。
 * Returns:
 *   {{id:string, label:string, ok:?boolean, result:string,
 *     expected:string, actual:string, evidence:string}}
 */
function invariantResult_(id, label, ok, expected, actual, evidence) {
  var result = INVARIANT_RESULT_.UNKNOWN;
  if (ok === true) result = INVARIANT_RESULT_.OK;
  else if (ok === false) result = INVARIANT_RESULT_.FAILED;

  return {
    id: id,
    label: label,
    ok: (ok === true || ok === false) ? ok : null,
    result: result,
    expected: String(expected === undefined || expected === null ? '' : expected),
    actual: String(actual === undefined || actual === null ? '' : actual),
    evidence: String(evidence || '')
  };
}

/**
 * 用途：把一個會拋錯的檢查包成「驗證不到」，而不是讓整組不變量掛掉。
 *
 *   ⚠️ 一條不變量自己爆咗，**不可以**令其餘九條跑唔到——嗰樣嘢本身就係
 *   一種「假綠燈」（見唔到＝以為冇事）。
 * Args:
 *   id {string} 不變量編號。
 *   label {string} 說明。
 *   fn {function(): Object} 實際的檢查，回傳 `invariantResult_()`。
 * Returns:
 *   {Object}
 */
function runInvariantSafely_(id, label, fn) {
  try {
    return fn();
  } catch (err) {
    var message = (err && err.message) ? err.message : String(err);
    return invariantResult_(id, label, null, '（能夠完成檢查）', '檢查途中拋出例外',
      '例外訊息：' + message);
  }
}

// =====================================================================
// I01：工作表結構
// =====================================================================

/**
 * 用途：I01——每一張表 `COLUMNS` 定義的機器鍵，工作表第 2 行全部有。
 *   即係 `tools/lint-schema-drift` 的**執行期版本**：lint 只看得到程式碼，
 *   看不到 Ivan 那一份真實試算表現在長甚麼樣。
 * Args: （無）
 * Returns:
 *   {Object} 見 `invariantResult_()`。
 */
function runInvariantI01_() {
  var label = 'I01　工作表結構：COLUMNS 定義的機器鍵，工作表第 2 行全部有';
  return runInvariantSafely_('I01', label, function () {
    var schema = checkSheetSchema_();
    if (schema.ok) {
      return invariantResult_('I01', label, true, '0 項落差', '0 項落差',
        '已檢查 ' + Object.keys(SHEETS).length + ' 張工作表與 ' + Object.keys(CONFIG_KEYS).length + ' 個設定鍵。');
    }

    var parts = [];
    if (schema.missingSheets.length > 0) parts.push('缺少工作表：' + schema.missingSheets.join('、'));
    schema.missingColumns.forEach(function (c) {
      parts.push(c.sheet + ' 欄位不符：' + c.keys.join('、'));
    });
    if (schema.missingConfigKeys.length > 0) parts.push('Config 缺少設定鍵：' + schema.missingConfigKeys.join('、'));

    return invariantResult_('I01', label, false, '0 項落差', parts.length + ' 項落差',
      parts.join('；') + '　修法：執行選單的「初始化工作表」。');
  });
}

// =====================================================================
// I02：BulletinWeeks 的 (季度, 主日日期) 唯一
// =====================================================================

/**
 * 用途：I02——`BulletinWeeks` 的 (季度, 主日日期) 唯一。
 *
 *   ⚠️ 重複那一行是**沉默的災難**：`findBulletinWeekRow_()` 只會拿到其中
 *   一行，於是「填寫介面存的」與「產生週報讀的」有機會是不同的兩行，
 *   而兩邊都不會報錯。
 * Args: （無）
 * Returns:
 *   {Object}
 */
function runInvariantI02_() {
  var label = 'I02　BulletinWeeks 的（季度＋主日日期）唯一';
  return runInvariantSafely_('I02', label, function () {
    var rows = readSheet(SHEETS.BULLETIN_WEEKS);
    var seen = {};
    var duplicates = [];

    rows.forEach(function (r, index) {
      var iso = (Object.prototype.toString.call(r.SERVICE_DATE) === '[object Date]')
        ? formatIsoDate_(r.SERVICE_DATE)
        : String(r.SERVICE_DATE || '').trim();
      var key = String(r.QUARTER_ID || '').trim() + '|' + iso;
      if (!iso) return; // 空白行不算重複，交由其他檢查處理

      // ⚠️ 一定要用 `hasOwnProperty`，不可以寫 `if (seen[key])`：第一行的
      // index 是 **0**，而 `0` 是 falsy——那樣寫的話，「第一行被重複」這一
      // 種情況會靜靜地驗不出來。（這個 bug 真的寫過一次，由
      // tests/invariants.test.js 的「應該紅」案例抓到。）
      if (Object.prototype.hasOwnProperty.call(seen, key)) {
        duplicates.push(key + '（第 ' + (seen[key] + 3) + ' 行與第 ' + (index + 3) + ' 行）');
      } else {
        seen[key] = index;
      }
    });

    if (duplicates.length === 0) {
      return invariantResult_('I02', label, true, '0 個重複', '0 個重複',
        '已檢查 ' + rows.length + ' 行。');
    }
    return invariantResult_('I02', label, false, '0 個重複', duplicates.length + ' 個重複',
      '重複的（季度｜主日）：' + duplicates.join('；'));
  });
}

// =====================================================================
// I03：畫面顯示的每一個數字，都可以由工作表重新數出同一個數
// =====================================================================

/**
 * 用途：I03 的登記表——**每一個會在畫面顯示的數字**，在這裡登記一條，
 *   同時提供**兩條互不相干的計算路徑**：
 *
 *     - `reported(ctx)`：系統實際用來產生那個數字的路徑（畫面看到的就是它）。
 *     - `recount(ctx)`：**另一條**路徑，直接由工作表重新數。
 *
 *   ⚠️ 這一條不變量是這一組的核心。已經出現過兩次「報告說 0，實際有 3」
 *   （見 docs/已知bug類型.md 事故二十二）。要令這件事變成機器抓得到的
 *   東西，唯一辦法就是**同一個數字算兩次、用兩條不同的路**。
 *
 *   ⚠️ `recount` 絕對不可以呼叫 `reported` 用的那一支函式。呼叫了的話，
 *   兩邊會一齊錯、一齊報「沒事」——那正是事故二十二的形狀。
 *
 *   ⚠️ 有幾條（`N05`）的 `recount` **共用同一套規則定義**、只是不共用
 *   資料路徑，`independence` 欄位會寫明。它們抓得到「讀錯了行／讀錯了
 *   日期／讀錯了季度」這一類 plumbing 錯誤，抓不到「規則本身想錯了」。
 *   誠實寫出來，好過扮成完全獨立。
 * Args:
 *   ctx {{isoDate:string, quarterId:string}} 要驗哪一個主日／季度。
 * Returns:
 *   {{id:string, label:string, sheetName:string, recountRule:string,
 *     independence:string, reported:function, recount:function}[]}
 */
function numberRegistryProbes_(ctx) {
  var isoDate = String((ctx || {}).isoDate || '');
  var quarterId = String((ctx || {}).quarterId || '');

  return [
    {
      id: 'N01',
      label: '本季主日數（「建立本季空白週報」對話框、季度填寫表標題）',
      sheetName: SHEETS.BULLETIN_WEEKS,
      recountRule: '數 BulletinWeeks 內 QUARTER_ID = 本季 的行數',
      independence: '完全獨立：reported 走職事表 ServiceDates，recount 走本試算表 BulletinWeeks',
      reported: function () { return listRosterServiceDatesForQuarter_(quarterId).length; },
      recount: function () {
        return readSheet(SHEETS.BULLETIN_WEEKS).filter(function (r) {
          return String(r.QUARTER_ID || '').trim() === quarterId;
        }).length;
      }
    },
    {
      id: 'N02',
      label: '家事報告條數（填寫介面唯讀區塊、匯入報告）',
      sheetName: SHEETS.ANNOUNCEMENTS,
      recountRule: '數 Announcements 內 SERVICE_DATE = 本主日 且 ACTIVE = TRUE 的行數',
      independence: '完全獨立：reported 走 pickWebAppListItems_（日期比對走 rosterDateMatchesYMD_），recount 走字串日期比對',
      reported: function () {
        return pickWebAppListItems_(readSheet(SHEETS.ANNOUNCEMENTS), isoDate, ['TEXT']).length;
      },
      recount: function () { return invariantCountActiveRowsForDate_(SHEETS.ANNOUNCEMENTS, isoDate); }
    },
    {
      id: 'N03',
      label: '代禱事項條數（填寫介面唯讀區塊、匯入報告）',
      sheetName: SHEETS.PRAYERS,
      recountRule: '數 Prayers 內 SERVICE_DATE = 本主日 且 ACTIVE = TRUE 的行數',
      independence: '完全獨立（同 N02）',
      reported: function () {
        return pickWebAppListItems_(readSheet(SHEETS.PRAYERS), isoDate, ['TEXT']).length;
      },
      recount: function () { return invariantCountActiveRowsForDate_(SHEETS.PRAYERS, isoDate); }
    },
    {
      id: 'N04',
      label: '團契聚會條數（填寫介面唯讀區塊、匯入報告）',
      sheetName: SHEETS.FELLOWSHIPS,
      recountRule: '數 Fellowships 內 SERVICE_DATE = 本主日 且 ACTIVE = TRUE 的行數',
      independence: '完全獨立（同 N02）',
      reported: function () {
        return pickWebAppListItems_(readSheet(SHEETS.FELLOWSHIPS), isoDate,
          ['FELLOWSHIP_NAME', 'MEETING_DATE', 'MEETING_TIME', 'CONTENT']).length;
      },
      recount: function () { return invariantCountActiveRowsForDate_(SHEETS.FELLOWSHIPS, isoDate); }
    },
    {
      id: 'N05',
      label: '收件人數（寄出前的預覽、「已寄出 N 個收件人」）',
      sheetName: SHEETS.RECIPIENTS,
      recountRule: '數 Recipients 內 ACTIVE = TRUE 且 GROUP_NAME 屬於 SEND_GROUPS 的行數（電郵格式合法、去重）',
      independence: '部分獨立：共用「合法電郵」與「去重」兩條規則定義，但不共用 buildRecipientList_ 的篩選流程',
      reported: function () {
        return buildRecipientList_(readSheet(SHEETS.RECIPIENTS),
          getConfigTextList_(CONFIG_KEYS.SEND_GROUPS, 'CC,DB,ADMIN'), null).recipients.length;
      },
      recount: function () {
        var groups = getConfigTextList_(CONFIG_KEYS.SEND_GROUPS, 'CC,DB,ADMIN');
        var seen = {};
        var count = 0;
        readSheet(SHEETS.RECIPIENTS).forEach(function (r) {
          if (r.ACTIVE !== true) return;
          if (groups.indexOf(r.GROUP_NAME) === -1) return;
          var email = String(r.EMAIL || '').trim().toLowerCase();
          if (!isValidEmailShape_(email) || seen[email]) return;
          seen[email] = true;
          count++;
        });
        return count;
      }
    },
    {
      id: 'N06',
      label: '目前已發佈的版本號（填寫介面頂部狀態列）',
      sheetName: SHEETS.PUBLISH_LOG,
      recountRule: '取 PublishLog 內該主日的最大 VERSION_NO',
      independence: '完全獨立：reported 走 latestPublishLogRow_（按 PUBLISHED_AT 排序），recount 走「該主日的最大版本號」',
      reported: function () {
        var latest = latestPublishLogRow_(readSheet(SHEETS.PUBLISH_LOG));
        return latest ? Number(latest.VERSION_NO || 0) : 0;
      },
      recount: function () {
        var rows = readSheet(SHEETS.PUBLISH_LOG);
        var latest = latestPublishLogRow_(rows);
        if (!latest) return 0;
        var targetIso = publishRowIsoDate_(latest);
        var max = 0;
        rows.forEach(function (r) {
          if (publishRowIsoDate_(r) !== targetIso) return;
          var v = Number(r.VERSION_NO || 0);
          if (v > max) max = v;
        });
        return max;
      }
    }
  ];
}

/**
 * 用途：數某一張「一個主日多行」的工作表，在指定主日有幾多行有效資料。
 *   **刻意用最笨的方法**（把日期正規化成 `yyyy-MM-dd` 字串再比對），
 *   跟 `pickWebAppListItems_()` 的 `rosterDateMatchesYMD_()` 是兩條不同
 *   的路——I03 要的就是這個「不同」。
 * Args:
 *   sheetName {string} 工作表名稱。
 *   isoDate {string} 主日日期，yyyy-MM-dd。
 * Returns:
 *   {number}
 */
function invariantCountActiveRowsForDate_(sheetName, isoDate) {
  var target = String(isoDate || '').trim();
  if (!target) return 0;

  return readSheet(sheetName).filter(function (r) {
    if (r.ACTIVE !== true) return false;
    var v = r.SERVICE_DATE;
    var iso = (Object.prototype.toString.call(v) === '[object Date]')
      ? formatIsoDate_(v)
      : String(v || '').trim();
    return iso === target;
  }).length;
}

/**
 * 用途：I03——逐條登記的數字，用兩條路各算一次，對不上就紅。
 *
 *   同時檢查**登記表與實作有沒有對齊**：`NumberRegistry` 有一行但
 *   `numberRegistryProbes_()` 沒有對應實作（或者相反），一樣報紅——
 *   否則有人加了一個新數字、登記了、但忘了寫檢查，I03 會靜靜地放過。
 * Args:
 *   ctx {{isoDate:string, quarterId:string}=} 選填，預設用
 *     `resolveWorkingQuarter_()` 與該季第一個主日。
 * Returns:
 *   {Object}
 */
function runInvariantI03_(ctx) {
  var label = 'I03　畫面顯示的每一個數字，都可以由工作表重新數出同一個數';
  return runInvariantSafely_('I03', label, function () {
    var context = ctx || invariantDefaultContext_();
    if (!context.isoDate || !context.quarterId) {
      return invariantResult_('I03', label, null, '有一個主日可以驗', '未能決定要驗哪一個主日',
        '季度：' + (context.quarterId || '（未能決定）') + '　主日：' + (context.isoDate || '（未能決定）')
          + '　I03 需要一個具體主日才數得到清單類的數字。');
    }

    var probes = numberRegistryProbes_(context);
    var probeById = {};
    probes.forEach(function (p) { probeById[p.id] = p; });

    // ---- 登記表與實作有沒有對齊 ----
    var registryRows = readSheet(SHEETS.NUMBER_REGISTRY).filter(function (r) { return r.ACTIVE === true; });
    var registeredIds = registryRows.map(function (r) { return String(r.REGISTRY_ID || '').trim(); });
    var missingImpl = registeredIds.filter(function (id) { return id && !probeById[id]; });
    var missingRegistration = probes.map(function (p) { return p.id; })
      .filter(function (id) { return registeredIds.indexOf(id) === -1; });

    // ---- 逐條兩路對數 ----
    var mismatches = [];
    var checked = [];
    probes.forEach(function (probe) {
      var reported;
      var recounted;
      try {
        reported = probe.reported();
      } catch (err) {
        mismatches.push(probe.id + '「' + probe.label + '」：產生數字那一路拋錯——'
          + ((err && err.message) ? err.message : String(err)));
        return;
      }
      try {
        recounted = probe.recount();
      } catch (err2) {
        mismatches.push(probe.id + '「' + probe.label + '」：重新數那一路拋錯——'
          + ((err2 && err2.message) ? err2.message : String(err2)));
        return;
      }

      checked.push(probe.id + '=' + reported);
      if (Number(reported) !== Number(recounted)) {
        mismatches.push(probe.id + '「' + probe.label + '」：畫面報 ' + reported
          + '，由 ' + probe.sheetName + ' 重新數是 ' + recounted
          + '（重新數的條件：' + probe.recountRule + '）');
      }
    });

    var problems = mismatches.slice();
    if (missingImpl.length > 0) {
      problems.push('NumberRegistry 登記了但沒有實作：' + missingImpl.join('、')
        + '（登記了卻沒有檢查，等於沒有登記）');
    }
    if (missingRegistration.length > 0) {
      problems.push('有實作但沒有在 NumberRegistry 登記：' + missingRegistration.join('、')
        + '（請執行「初始化工作表」補回登記行）');
    }

    var scope = '季度 ' + context.quarterId + '、主日 ' + context.isoDate;
    if (problems.length === 0) {
      return invariantResult_('I03', label, true, '全部對得上', '全部對得上',
        scope + '；已對 ' + probes.length + ' 個數字：' + checked.join('　'));
    }
    return invariantResult_('I03', label, false, '全部對得上', problems.length + ' 項對不上',
      scope + '；' + problems.join('｜'));
  });
}

/**
 * 用途：不變量的預設檢查範圍——用 `resolveWorkingQuarter_()` 決定季度，
 *   再取該季**在 `BulletinWeeks` 內第一個**主日。
 *
 *   ⚠️ 刻意用 `resolveWorkingQuarter_()`，不自己再猜一次季度：全專案
 *   「本季是哪一季」只有一個真相來源（見 docs/已知bug類型.md 事故二十）。
 * Args: （無）
 * Returns:
 *   {{isoDate:string, quarterId:string}} 決定不到就兩個都是空字串。
 */
function invariantDefaultContext_() {
  var empty = { isoDate: '', quarterId: '' };
  try {
    var resolution = resolveWorkingQuarter_();
    if (!resolution.ok) return empty;

    var quarterId = resolution.quarterId;
    var isoDates = readSheet(SHEETS.BULLETIN_WEEKS)
      .filter(function (r) { return String(r.QUARTER_ID || '').trim() === quarterId; })
      .map(function (r) {
        return (Object.prototype.toString.call(r.SERVICE_DATE) === '[object Date]')
          ? formatIsoDate_(r.SERVICE_DATE) : String(r.SERVICE_DATE || '').trim();
      })
      .filter(Boolean)
      .sort();

    return { isoDate: isoDates.length > 0 ? isoDates[0] : '', quarterId: quarterId };
  } catch (err) {
    return empty;
  }
}

// =====================================================================
// I04／I05：寄出
// =====================================================================

/**
 * 用途：I04——寄出前 preview 的收件人數 === 實際寄出（或 `DRY_RUN` 記錄）
 *   的封數。
 *
 *   ⚠️ 只看**最近一批**：`SendLog` 是累積的，整張表的行數跟任何一次
 *   preview 都對不上。「一批」的定義是同一個 `TIMESTAMP` 分鐘、同一個
 *   `STATUS` 的連續行——寄出是一次過寫入的（`writeSheet()` 一次
 *   `setValues()`），所以同一批的時間戳記一定極接近。
 * Args:
 *   options {{sinceMs:number=}=} 選填，只看這個時間之後的 `SendLog` 行；
 *     不提供就取最後一批。
 * Returns:
 *   {Object}
 */
function runInvariantI04_(options) {
  var label = 'I04　寄出前預覽的收件人數 === 實際寄出（或試行記錄）的封數';
  return runInvariantSafely_('I04', label, function () {
    var opts = options || {};
    var rows = readSheet(SHEETS.SEND_LOG);
    if (rows.length === 0) {
      return invariantResult_('I04', label, null, '有一批寄出記錄可以對', '尚未寄出過（含試行）',
        'SendLog 一行都沒有，沒有東西可以對——這不是「沒問題」，是「未驗過」。');
    }

    var batch = invariantLatestSendLogBatch_(rows, opts.sinceMs);
    if (batch.length === 0) {
      return invariantResult_('I04', label, null, '有一批寄出記錄可以對', '指定時間之後沒有寄出記錄',
        '指定的起點之後 SendLog 沒有新增任何行。');
    }

    // 「預覽會寄給幾多人」用跟寄出流程同一支 buildRecipientList_ 算——
    // ⚠️ 這裡刻意共用：I04 要驗的是「預覽講的跟實際做的是不是同一件事」，
    // 不是「收件人篩選規則對不對」（那是 I03 的 N05）。
    var groups = invariantSendGroupsForStatus_(batch[0].STATUS);
    var previewCount = buildRecipientList_(readSheet(SHEETS.RECIPIENTS), groups, null).recipients.length;
    var loggedCount = batch.length;

    var evidence = '最近一批：狀態 ' + batch[0].STATUS + '、' + loggedCount + ' 行；'
      + '用同一組收件組別（' + groups.join('、') + '）重新預覽是 ' + previewCount + ' 人。';

    if (previewCount === loggedCount) {
      return invariantResult_('I04', label, true, previewCount + ' 封', loggedCount + ' 封', evidence);
    }
    return invariantResult_('I04', label, false, previewCount + ' 封', loggedCount + ' 封',
      evidence + '　⚠️ 兩者對不上代表「預覽講的」與「實際做的」不是同一件事。'
        + '（注意：如果 Recipients 在那一次寄出之後改動過，這一條會出現預期之內的落差。）');
  });
}

/**
 * 用途：取 `SendLog` 最近一批（同一次寄出寫入的那幾行）。
 *
 *   判斷方式：由最後一行往前推，時間戳記相差在 `INVARIANT_SEND_BATCH_MS_`
 *   之內、而且 `STATUS` 相同的，算同一批。
 * Args:
 *   rows {Object[]} `readSheet(SHEETS.SEND_LOG)` 的輸出。
 *   sinceMs {number=} 選填，只取這個時間之後的行。
 * Returns:
 *   {Object[]} 由舊到新。
 */
function invariantLatestSendLogBatch_(rows, sinceMs) {
  var withTime = (rows || []).filter(function (r) {
    if (Object.prototype.toString.call(r.TIMESTAMP) !== '[object Date]') return false;
    if (sinceMs && r.TIMESTAMP.getTime() < Number(sinceMs)) return false;
    return true;
  });
  if (withTime.length === 0) return [];

  var sorted = withTime.slice().sort(function (a, b) { return a.TIMESTAMP.getTime() - b.TIMESTAMP.getTime(); });
  var last = sorted[sorted.length - 1];
  var batch = [];

  for (var i = sorted.length - 1; i >= 0; i--) {
    var row = sorted[i];
    if (String(row.STATUS) !== String(last.STATUS)) break;
    if (last.TIMESTAMP.getTime() - row.TIMESTAMP.getTime() > INVARIANT_SEND_BATCH_MS_) break;
    batch.unshift(row);
  }
  return batch;
}

/**
 * 同一次寄出寫入的幾行，時間戳記最多相差幾多毫秒。
 *
 * ⚠️ 一次 `writeSheet()` 是一次 `setValues()`，全部行同一刻寫入，理論上
 * 時間戳記完全相同；放寬到 90 秒是為了容納「逐個 `MailApp.sendEmail()`
 * 期間 `new Date()` 各自求值」那段落差（收件人多的時候真的會跨秒）。
 */
var INVARIANT_SEND_BATCH_MS_ = 90000;

/**
 * 用途：由 `SendLog.STATUS` 反查那一次寄出用的是哪一組收件組別。
 *
 *   ⚠️ 不同的寄出流程用不同的 Config 鍵（週報用 `SEND_GROUPS`、發佈通知
 *   用 `PUBLISH_SEND_GROUPS`、內容表邀請用 `CONTENT_SHEET_INVITE_GROUPS`），
 *   用錯一個，I04 就會報一個假的落差。
 * Args:
 *   status {*} `SendLog.STATUS`。
 * Returns:
 *   {string[]}
 */
function invariantSendGroupsForStatus_(status) {
  var text = String(status || '');
  if (text === 'PUBLISH') return getConfigTextList_(CONFIG_KEYS.PUBLISH_SEND_GROUPS, 'CC,DB,ADMIN');
  if (text === 'CONTENT_SHEET_INVITE') return getConfigTextList_(CONFIG_KEYS.CONTENT_SHEET_INVITE_GROUPS, 'CC,DB,ADMIN,IT');
  if (text === 'FILL_INVITE') return getConfigTextList_(CONFIG_KEYS.FILL_INVITE_GROUPS, 'CC,DB,ADMIN,IT,WORSHIP');
  return getConfigTextList_(CONFIG_KEYS.SEND_GROUPS, 'CC,DB,ADMIN');
}

/**
 * 用途：I05——`DRY_RUN=TRUE` 時，`SendLog` 不可以有任何真實寄出紀錄。
 *
 *   ⚠️ 這一條是整套系統最重要的一條保險：試行模式底下真的寄了出去，
 *   收件人是全教會，而且**收回不來**。
 *
 *   判斷方式：現在 `DRY_RUN=TRUE` 的話，**這一次執行期間**新增的
 *   `SendLog` 行必須全部 `DRY_RUN=TRUE`。歷史上曾經關過試行模式而留下的
 *   真實寄出紀錄是合法的，所以要有 `sinceMs` 才驗得準——不提供時只驗
 *   最近一批，並在證據講明範圍。
 * Args:
 *   options {{sinceMs:number=}=} 選填。
 * Returns:
 *   {Object}
 */
function runInvariantI05_(options) {
  var label = 'I05　DRY_RUN=TRUE 時，SendLog 不可以有任何真實寄出紀錄';
  return runInvariantSafely_('I05', label, function () {
    var opts = options || {};
    var dryRun = normalizeBoolean_(getConfig(CONFIG_KEYS.DRY_RUN, 'TRUE')) === true;
    if (!dryRun) {
      return invariantResult_('I05', label, null, 'DRY_RUN=TRUE 時才驗得到', 'DRY_RUN 目前是 FALSE',
        '現在是真實寄送模式，這一條不適用——不是「沒問題」，是「這一刻驗不到」。');
    }

    var rows = readSheet(SHEETS.SEND_LOG);
    var scoped = opts.sinceMs
      ? rows.filter(function (r) {
        return Object.prototype.toString.call(r.TIMESTAMP) === '[object Date]'
          && r.TIMESTAMP.getTime() >= Number(opts.sinceMs);
      })
      : invariantLatestSendLogBatch_(rows);

    var scopeText = opts.sinceMs ? '本次執行期間新增的 ' + scoped.length + ' 行' : '最近一批 ' + scoped.length + ' 行';
    if (scoped.length === 0) {
      return invariantResult_('I05', label, true, '0 筆真實寄出', '0 筆真實寄出',
        scopeText + '——沒有新增任何寄出記錄。');
    }

    var real = scoped.filter(function (r) { return r.DRY_RUN !== true; });
    if (real.length === 0) {
      return invariantResult_('I05', label, true, '0 筆真實寄出', '0 筆真實寄出',
        scopeText + '全部都是試行記錄（DRY_RUN=TRUE）。');
    }

    return invariantResult_('I05', label, false, '0 筆真實寄出', real.length + ' 筆真實寄出',
      scopeText + '之中有 ' + real.length + ' 行的「是否試行」不是 TRUE，'
        + '狀態：' + real.map(function (r) { return String(r.STATUS); }).join('、')
        + '　⚠️ 試行模式底下真的寄了出去，收不回來。');
  });
}

// =====================================================================
// I06：PublishLog 最新一行 vs master 檔案目前內容
// =====================================================================

/**
 * 用途：I06——`PublishLog` 最新一行的版本，對得上 master 檔案目前內容
 *   的 MD5。
 *
 *   ⚠️ 這一條抓的是「頂部狀態列說已發佈第 3 版，但連結裡面其實還是第 2
 *   版」——一個沒有人查得出的假象（見 docs/已知bug類型.md 事故二十三）。
 * Args: （無）
 * Returns:
 *   {Object}
 */
function runInvariantI06_() {
  var label = 'I06　PublishLog 最新一行的版本，對得上 master 檔案目前的內容';
  return runInvariantSafely_('I06', label, function () {
    var latest = latestPublishLogRow_(readSheet(SHEETS.PUBLISH_LOG));
    if (!latest) {
      return invariantResult_('I06', label, null, '有發佈記錄可以對', '尚未發佈過任何一期',
        'PublishLog 一行都沒有，沒有東西可以對。');
    }

    var expectedIso = publishRowIsoDate_(latest);
    var expectedVersion = Number(latest.VERSION_NO || 0);
    var recorded = readPublishOutputFingerprint_();
    if (!recorded) {
      return invariantResult_('I06', label, null,
        expectedIso + ' 第 ' + expectedVersion + ' 版', '沒有留下「發佈了哪一份內容」的記錄',
        '這一次發佈是在加入 I06 之前做的（或者記錄寫入失敗）。下一次發佈之後這一條就驗得到。');
    }

    if (recorded.isoDate !== expectedIso || recorded.versionNo !== expectedVersion) {
      return invariantResult_('I06', label, false,
        expectedIso + ' 第 ' + expectedVersion + ' 版',
        recorded.isoDate + ' 第 ' + recorded.versionNo + ' 版',
        'PublishLog 最新一行與「最後一次真的寫進 master 的內容」對不上——'
          + '代表有一次發佈寫了記錄但沒有換到內容，或者相反。');
    }

    if (!recorded.fingerprint) {
      return invariantResult_('I06', label, null, expectedIso + ' 第 ' + expectedVersion + ' 版',
        '發佈當時算不到內容指紋', '發佈當時 Utilities.computeDigest 不可用，所以沒有指紋可以比。');
    }

    var config = publishConfig_();
    if (!config.masterFileId) {
      return invariantResult_('I06', label, null, expectedIso + ' 第 ' + expectedVersion + ' 版',
        'Config 未設定 master 檔案 ID', '尚未建立 master 發佈檔案。');
    }

    var currentBytes = readMasterPdfBytes_(config.masterFileId);
    if (currentBytes === null) {
      return invariantResult_('I06', label, null, recorded.fingerprint, '讀不到 master 檔案目前的內容',
        'master 檔案開不到（可能被刪、被搬、或者權限不足）——「讀不到」不等於「沒問題」。');
    }

    var currentFingerprint = pdfFingerprint_(currentBytes);
    if (!currentFingerprint) {
      return invariantResult_('I06', label, null, recorded.fingerprint, '算不到目前內容的指紋',
        'Utilities.computeDigest 不可用。');
    }

    if (currentFingerprint === recorded.fingerprint) {
      return invariantResult_('I06', label, true, recorded.fingerprint, currentFingerprint,
        expectedIso + ' 第 ' + expectedVersion + ' 版；master 目前內容與發佈當時完全相同。');
    }
    return invariantResult_('I06', label, false, recorded.fingerprint, currentFingerprint,
      '⚠️ master 檔案的內容在最後一次發佈之後被換過（有人手動覆寫、或者有一次發佈沒有記錄）。'
        + '頂部狀態列說的版本，跟連結裡面實際那一份，已經不是同一份。');
  });
}

// =====================================================================
// I07：產出的 .docx 殘留佔位符必為 0
// =====================================================================

/**
 * 用途：I07——最近一次產生的 `.docx` 殘留佔位符必為 0。
 *
 *   ⚠️ **重新讀取產出物本身**來驗，不用「我替換了幾多個」倒推——後者
 *   永遠抓不到「我根本沒有處理過那一批」（事故二十二）。
 * Args:
 *   options {{fileId:string=}=} 選填，指定要驗哪一個檔案；不提供時取
 *     `BulletinWeeks` 內最後一次產生的那一個。
 * Returns:
 *   {Object}
 */
function runInvariantI07_(options) {
  var label = 'I07　產出的 Word 檔殘留佔位符必為 0';
  return runInvariantSafely_('I07', label, function () {
    var opts = options || {};
    var fileId = String(opts.fileId || '').trim();

    if (!fileId) {
      var candidates = readSheet(SHEETS.BULLETIN_WEEKS)
        .filter(function (r) {
          return String(r.DOC_ID || '').trim()
            && Object.prototype.toString.call(r.LAST_GENERATED_AT) === '[object Date]';
        })
        .sort(function (a, b) { return a.LAST_GENERATED_AT.getTime() - b.LAST_GENERATED_AT.getTime(); });
      if (candidates.length === 0) {
        return invariantResult_('I07', label, null, '有一個產出檔案可以驗', '尚未產生過任何 Word 檔',
          'BulletinWeeks 沒有任何一行有 DOC_ID 與產生時間。');
      }
      fileId = String(candidates[candidates.length - 1].DOC_ID).trim();
    }

    var assertion = assertDocxOutput_(fileId);
    if (!assertion.ok) {
      return invariantResult_('I07', label, null, '0 個殘留佔位符', '讀不到產出檔案',
        assertion.message);
    }

    if (assertion.residualPlaceholders === 0) {
      return invariantResult_('I07', label, true, '0 個殘留佔位符', '0 個殘留佔位符',
        '檔案 ' + maskFileId_(fileId) + '（' + assertion.bytes + ' 位元組）'
          + '已重新解壓並掃描 ' + assertion.scannedParts + ' 個 XML 部件。');
    }

    return invariantResult_('I07', label, false, '0 個殘留佔位符',
      assertion.residualPlaceholders + ' 個殘留佔位符',
      '檔案 ' + maskFileId_(fileId) + '；殘留的：' + assertion.residualSamples.join('、')
        + '　⚠️ 這些會原樣印在紙上。');
  });
}

// =====================================================================
// I08：內容表匯入的冪等性
// =====================================================================

/**
 * 用途：I08——內容表匯入之後立即再匯入一次，改動必為 0。
 *
 *   ⚠️ 用 `previewContentImport_()`（**唯讀**）來驗，不是真的再匯入一次。
 *   不變量不可以改動任何資料（見本檔案檔頭）。
 * Args:
 *   options {{quarterId:string=}=} 選填。
 * Returns:
 *   {Object}
 */
function runInvariantI08_(options) {
  var label = 'I08　內容表匯入後立即再匯入一次，改動必為 0（冪等）';
  return runInvariantSafely_('I08', label, function () {
    var opts = options || {};
    var quarterId = String(opts.quarterId || '').trim();
    if (!quarterId) {
      var resolution = resolveWorkingQuarter_();
      quarterId = resolution.ok ? resolution.quarterId : '';
    }
    if (!quarterId) {
      return invariantResult_('I08', label, null, '0 項改動', '未能決定季度',
        'resolveWorkingQuarter_() 四層全部推算不到季度。');
    }

    var row = findContentSheetRow_(quarterId);
    if (!row) {
      return invariantResult_('I08', label, null, '0 項改動', '該季尚未建立內容表',
        '季度 ' + quarterId + ' 在 ContentSheets 沒有登記，沒有東西可以驗。');
    }

    var lastImported = row.LAST_IMPORTED_AT;
    if (Object.prototype.toString.call(lastImported) !== '[object Date]') {
      return invariantResult_('I08', label, null, '0 項改動', '該季從未匯入過',
        '季度 ' + quarterId + ' 的內容表從未匯入過——「未匯入」不等於「匯入是冪等的」。');
    }

    var preview = previewContentImport_(quarterId);
    if (!preview.ok) {
      return invariantResult_('I08', label, null, '0 項改動', '預覽失敗',
        preview.message || ('原因代碼：' + preview.reason));
    }

    var plan = preview.plan;
    var changes = Number(plan.added) + Number(plan.updated) + Number(plan.removed);
    var detail = '新增 ' + plan.added + '、修改 ' + plan.updated + '、刪除 ' + plan.removed
      + '、不變 ' + plan.unchanged;

    if (changes === 0) {
      return invariantResult_('I08', label, true, '0 項改動', '0 項改動',
        '季度 ' + quarterId + '（最後匯入：' + formatIsoDate_(lastImported) + '）；' + detail);
    }
    return invariantResult_('I08', label, false, '0 項改動', changes + ' 項改動',
      '季度 ' + quarterId + '；' + detail
        + '　⚠️ 匯入之後再匯入應該完全沒有改動；有改動代表匯入沒有真的寫進去、'
        + '或者寫入的值與內容表的值格式不同（例如日期被轉成 Date）。'
        + '（注意：如果內容表在最後一次匯入之後有人改過，這一條會出現預期之內的落差。）');
  });
}

// =====================================================================
// I09：報告行數上限
// =====================================================================

/**
 * 用途：I09——`Diagnostics` 行數不超過 `DIAGNOSTICS_MAX_ROWS`，
 *   自我檢測報告不超過 `SELFCHECK_MAX_ROWS`。
 *
 *   ⚠️ 這一條抓的是「報告被自己的明細擠爆」那一類事故（事故二十一）：
 *   結論被擠出報告之後，看的人只會見到一份「好像跑完了」的明細。
 * Args: （無）
 * Returns:
 *   {Object}
 */
function runInvariantI09_() {
  var label = 'I09　Diagnostics 行數不超過上限，自我檢測報告不超過自己的上限';
  return runInvariantSafely_('I09', label, function () {
    var diagnosticsMax = normalizeInt_(getConfig(CONFIG_KEYS.DIAGNOSTICS_MAX_ROWS, '380'));
    if (!diagnosticsMax || diagnosticsMax < 1) diagnosticsMax = 380;

    var rows = readSheet(SHEETS.DIAGNOSTICS);
    var selfCheckRows = rows.filter(function (r) { return String(r.REPORT_NAME || '') === '完成度自我檢測'; });
    var selfCheckMax = selfCheckResolveMaxRows_().maxRows;

    var problems = [];
    if (rows.length > diagnosticsMax) {
      problems.push('Diagnostics 共 ' + rows.length + ' 行，超過 DIAGNOSTICS_MAX_ROWS（' + diagnosticsMax + '）');
    }
    if (selfCheckRows.length > selfCheckMax) {
      problems.push('自我檢測報告共 ' + selfCheckRows.length + ' 行，超過上限（' + selfCheckMax + '）');
    }

    var evidence = 'Diagnostics ' + rows.length + '／' + diagnosticsMax + ' 行；'
      + '自我檢測報告 ' + selfCheckRows.length + '／' + selfCheckMax + ' 行。';

    if (problems.length === 0) {
      return invariantResult_('I09', label, true, '兩者都在上限之內', '兩者都在上限之內', evidence);
    }
    return invariantResult_('I09', label, false, '兩者都在上限之內', problems.length + ' 項超出',
      evidence + '　' + problems.join('；'));
  });
}

// =====================================================================
// I10：職事表零寫入
// =====================================================================

/**
 * 用途：I10——職事表試算表的版本記錄行數，與自測開始時相同。
 *
 *   ⚠️ 這是整個專案最重要的一條紀律的**最終確認**：對職事表一律唯讀。
 *   靜態 lint（`tools/lint-readonly-roster.js`）證明「程式碼裡沒有寫入
 *   方法」，這一條證明「實際上真的一個版本都沒有多」——兩者的證據等級
 *   完全不同。
 * Args:
 *   baselineCount {?number} 自測開始時的版本記錄行數；`null` 代表沒有
 *     基準，只回報目前數目。
 * Returns:
 *   {Object}
 */
function runInvariantI10_(baselineCount) {
  var label = 'I10　職事表試算表的版本記錄行數，與自測開始時相同（零寫入）';
  return runInvariantSafely_('I10', label, function () {
    var rosterId = getConfig(CONFIG_KEYS.ROSTER_SPREADSHEET_ID, '');
    if (!rosterId) {
      return invariantResult_('I10', label, null, '與開始時相同', '職事表未設定',
        'Config 的 ROSTER_SPREADSHEET_ID 是空的。');
    }

    var current = driveCountRevisions_(rosterId);
    if (current === null) {
      return invariantResult_('I10', label, null, '與開始時相同', '讀不到版本記錄',
        '讀不到職事表的版本記錄（Drive 進階服務未啟用、權限不足，或者該檔案不支援）。'
          + '⚠️ 「讀不到」不等於「沒有被寫過」——請人手開啟職事表 ▸ 檔案 ▸ 版本記錄確認。');
    }

    if (baselineCount === null || baselineCount === undefined) {
      return invariantResult_('I10', label, null, '（沒有基準）', current + ' 個版本',
        '這一次沒有記下開始時的基準，所以只回報目前數目。自測機會在開跑前記下基準。');
    }

    if (Number(current) === Number(baselineCount)) {
      return invariantResult_('I10', label, true, baselineCount + ' 個版本', current + ' 個版本',
        '職事表版本記錄一個都沒有多——本次執行對職事表零寫入。');
    }
    return invariantResult_('I10', label, false, baselineCount + ' 個版本', current + ' 個版本',
      '⚠️ 職事表的版本記錄多了 ' + (Number(current) - Number(baselineCount)) + ' 個。'
        + '本專案對職事表一律唯讀，多一個版本就代表有地方寫了進去。'
        + '（注意：如果同一時間有人在職事表打字，也會多版本——請先確認再當成 bug。）');
  });
}

// =====================================================================
// 一次過跑全部
// =====================================================================

/**
 * 用途：全部檢查的登記表——**每一條都明確標明有沒有副作用**。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ⚠️ `sideEffect` 是甚麼意思
 * ─────────────────────────────────────────────────────────────────────
 *
 *   `sideEffect: true` 代表「這一條檢查會改動狀態，**或者它驗證的對象
 *   本身是一個有副作用的操作**」。這種檢查**不是不變量**，理由有兩重：
 *
 *   1. **它不是「任何時候都成立」的。** 不變量的定義就是「任何時候都
 *      必須成立」；I08（再匯入一次應為 0 改動）只在**剛剛匯入完**那一刻
 *      成立——有人去內容表改一格之後它就不成立，而那是完全合法的狀態。
 *      把一個「只在特定時刻成立」的斷言當成不變量，等於在每一個不相干
 *      的地方都問一條沒有意義的問題。
 *
 *   2. **它會拖著不相干的情境一齊紅。** 自測機每個情境跑完都叫一次
 *      `runAllInvariants_()`，一條紅了整個情境就轉紅。I08 一旦紅，
 *      「產生 Word」「儲存一格」「發佈」「寄出」全部一齊紅——而它們
 *      本身的斷言明明全部符合。第一輪 18 個情境 11 紅，其中 8 個就是
 *      這樣來的（見 docs/已知bug類型.md 事故二十七）。
 *
 *   所以：`runAllInvariants_()` **只准跑 `sideEffect: false` 的**，
 *   有副作用的那些由 `runStatefulChecks_()` 在明確需要的情境呼叫。
 *
 * Args:
 *   ctx {{isoDate:string, quarterId:string}} 檢查範圍。
 *   opts {{sinceMs:number=, docxFileId:string=, rosterRevisionBaseline:number=}=}
 * Returns:
 *   {{id:string, sideEffect:boolean, run:function(): Object}[]}
 */
function invariantDefinitions_(ctx, opts) {
  var o = opts || {};
  return [
    { id: 'I01', sideEffect: false, run: function () { return runInvariantI01_(); } },
    { id: 'I02', sideEffect: false, run: function () { return runInvariantI02_(); } },
    { id: 'I03', sideEffect: false, run: function () { return runInvariantI03_(ctx); } },
    { id: 'I04', sideEffect: false, run: function () { return runInvariantI04_({ sinceMs: o.sinceMs }); } },
    { id: 'I05', sideEffect: false, run: function () { return runInvariantI05_({ sinceMs: o.sinceMs }); } },
    { id: 'I06', sideEffect: false, run: function () { return runInvariantI06_(); } },
    { id: 'I07', sideEffect: false, run: function () { return runInvariantI07_({ fileId: o.docxFileId }); } },
    // ⚠️ I08 是**唯一**一條 sideEffect: true。它驗的是「匯入」這個有副作用
    // 的操作，而且只在剛剛匯入完那一刻成立——見本函式檔頭的兩重理由。
    { id: 'I08', sideEffect: true, run: function () { return runInvariantI08_({ quarterId: ctx.quarterId }); } },
    { id: 'I09', sideEffect: false, run: function () { return runInvariantI09_(); } },
    {
      id: 'I10', sideEffect: false,
      run: function () {
        return runInvariantI10_(o.rosterRevisionBaseline === undefined ? null : o.rosterRevisionBaseline);
      }
    }
  ];
}

/**
 * 用途：把一批檢查結果收成摘要。**純函式。**
 * Args:
 *   results {Object[]} 每個都是 `invariantResult_()` 的輸出。
 * Returns:
 *   {{results:Object[], okCount:number, failedCount:number,
 *     unknownCount:number, allOk:boolean, failed:Object[]}}
 */
function summariseInvariantResults_(results) {
  var list = results || [];
  var failed = list.filter(function (r) { return r.ok === false; });
  return {
    results: list,
    okCount: list.filter(function (r) { return r.ok === true; }).length,
    failedCount: failed.length,
    unknownCount: list.filter(function (r) { return r.ok === null; }).length,
    allOk: failed.length === 0,
    failed: failed
  };
}

/**
 * 用途：跑全部**沒有副作用**的不變量。**唯讀。**
 *
 *   第 2 層每個情境跑完叫一次、第 3 層每一步跑完叫一次、「完成度自我
 *   檢測」也叫一次——同一組斷言在三個地方重用，不需要三套。
 *
 *   ⚠️ **有副作用的檢查一律不在這裡**（見 `invariantDefinitions_()` 的
 *   說明）。要跑那些，叫 `runStatefulChecks_()`。
 * Args:
 *   options {{isoDate:string=, quarterId:string=, sinceMs:number=,
 *            docxFileId:string=, rosterRevisionBaseline:number=}=}
 *     全部選填。不提供時各條不變量自己決定合理的預設範圍。
 * Returns:
 *   {{results:Object[], okCount:number, failedCount:number,
 *     unknownCount:number, allOk:boolean, failed:Object[]}}
 *     `allOk` 只有在**沒有任何一條 FAILED** 時才是 `true`；
 *     ⚠️ `UNKNOWN` 不會令 `allOk` 變 false，但一定會出現在報告內——
 *     「驗證不到」要看得見，但不應該當成失敗擋住流程。
 */
function runAllInvariants_(options) {
  var opts = options || {};
  var ctx = (opts.isoDate || opts.quarterId)
    ? { isoDate: String(opts.isoDate || ''), quarterId: String(opts.quarterId || '') }
    : invariantDefaultContext_();

  var results = invariantDefinitions_(ctx, opts)
    .filter(function (d) { return d.sideEffect !== true; })
    .map(function (d) { return d.run(); });

  return summariseInvariantResults_(results);
}

/**
 * 用途：跑**有副作用**的檢查。只在明確需要的情境呼叫（目前只有匯入
 *   相關的 S05／S06／S07）。
 *
 *   ⚠️ 這一支**不可以**放進 `runAllInvariants_()`，也不可以在亂行機
 *   每一步之後叫——理由見 `invariantDefinitions_()` 的說明。
 * Args:
 *   options {{isoDate:string=, quarterId:string=}=}
 * Returns:
 *   {{results:Object[], okCount:number, failedCount:number,
 *     unknownCount:number, allOk:boolean, failed:Object[]}}
 */
function runStatefulChecks_(options) {
  var opts = options || {};
  var ctx = (opts.isoDate || opts.quarterId)
    ? { isoDate: String(opts.isoDate || ''), quarterId: String(opts.quarterId || '') }
    : invariantDefaultContext_();

  var results = invariantDefinitions_(ctx, opts)
    .filter(function (d) { return d.sideEffect === true; })
    .map(function (d) { return d.run(); });

  return summariseInvariantResults_(results);
}

/**
 * 用途：把 `runAllInvariants_()` 的結果排版成報告內容行。**純函式。**
 *
 *   ⚠️ 紅色的一律**連預期、實際、證據三樣一齊印**——只印「I06 失敗」
 *   等於沒有印，看的人還是要自己去查。
 * Args:
 *   summary {Object} `runAllInvariants_()` 的回傳值。
 * Returns:
 *   {string[]}
 */
function buildInvariantReportLines_(summary) {
  var lines = [];
  lines.push('不變量：' + summary.results.length + ' 條　✅ ' + summary.okCount
    + '　🔴 ' + summary.failedCount + '　⚪ 驗證不到 ' + summary.unknownCount);
  lines.push('');

  summary.results.forEach(function (r) {
    var mark = r.ok === true ? '✅' : (r.ok === false ? '🔴' : '⚪');
    lines.push(mark + '　' + r.label);
    if (r.ok === true) {
      lines.push('　　' + r.evidence);
      return;
    }
    lines.push('　　預期：' + r.expected);
    lines.push('　　實際：' + r.actual);
    lines.push('　　證據：' + r.evidence);
  });

  return lines;
}

/**
 * 用途：把 `runAllInvariants_()` 的結果縮成一句摘要，供對話框與「完成度
 *   自我檢測」的單行說明使用。**純函式。**
 * Args:
 *   summary {Object} `runAllInvariants_()` 的回傳值。
 * Returns:
 *   {string}
 */
function buildInvariantShortSummary_(summary) {
  if (summary.failedCount === 0) {
    var tail = summary.unknownCount > 0 ? ('，另有 ' + summary.unknownCount + ' 條驗證不到') : '';
    return summary.okCount + ' 條通過' + tail + '。';
  }
  return summary.failedCount + ' 條不成立：'
    + summary.failed.map(function (r) { return r.id + '（實際 ' + r.actual + '）'; }).join('、')
    + '　完整證據見 Diagnostics 的「不變量檢查」報告。';
}

/**
 * 用途：選單項目「跑一次不變量檢查」的處理函式。**唯讀。**
 * Args: （無）
 * Returns:
 *   {void}
 */
function menuRunInvariants_() {
  var ui = SpreadsheetApp.getUi();
  try {
    var summary = runAllInvariants_();
    writeDiagnosticsReport_('不變量檢查', buildInvariantReportLines_(summary));
    ui.alert('不變量檢查',
      buildInvariantShortSummary_(summary) + '\n\n完整結果已寫入 Diagnostics 工作表。',
      ui.ButtonSet.OK);
  } catch (err) {
    logMenuError_('menuRunInvariants_', err);
    ui.alert('不變量檢查失敗', enrichAuthError_(err), ui.ButtonSet.OK);
  }
}
