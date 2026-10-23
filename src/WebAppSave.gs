/**
 * WebAppSave.gs
 *
 * 週報填寫介面的儲存邏輯：樂觀鎖、`Announcements`／`Prayers`／
 * `Fellowships`／`Finance` 四張「可增刪清單」的 upsert（不刪行，改
 * `ACTIVE=FALSE`）、`BulletinWeeks` 可編輯欄位的逐格比對，以及逐格
 * `AuditLog`。
 *
 * 分三層，跟本專案既有模組（`RosterRead.gs`／`BulletinModel.gs`）同一個
 * 樣式：
 *   1. 純函式層　`buildSaveOperations_(input)`
 *      完全不碰 Apps Script 服務，輸入是「目前工作表狀態＋前端 payload」，
 *      輸出「要做的異動計畫」（樂觀鎖不符時直接拋錯，一個格都不算）。
 *      方便在 Node 用假資料直接測試。
 *   2. 真正入口　`saveWeekFromWebApp_(payload)`
 *      唯一會碰 `SpreadsheetApp` 的地方：讀現有資料、呼叫純函式層算出
 *      異動計畫、把計畫套用到工作表、寫 `AuditLog`。
 *   3. 一批小型 IO／純函式輔助函式（讀帶行號的資料列、逐格寫入、值轉
 *      文字……）。
 *
 * ⚠️ **只寫週報自己的試算表**——`SHEETS` 內的六張表（`BulletinWeeks`／
 * `Announcements`／`Prayers`／`Fellowships`／`Finance`／`AuditLog`），
 * 不會出現 `openById(`，`tools/lint-readonly-roster.js` 對職事表唯讀的
 * 承諾繼續成立。
 *
 * ─────────────────────────────────────────────────────────────────────
 * `apiSaveWeek()` 的 payload 形狀
 * ─────────────────────────────────────────────────────────────────────
 *
 * ```
 * {
 *   isoDate: 'yyyy-MM-dd',
 *   lastSavedAt: (Date|string|null),   // apiLoadWeek() 回傳的原值，原樣送回
 *   baseWeek: {...},                   // 必填。下面 week 內每個欄位「載入時」的值；沒有就是舊版前端，
 *                                      // 整次拒絕（CLIENT_OUTDATED）
 *   week: {                            // 只放使用者真的改過的欄位（沒出現＝沒有改），
 *                                      // 可選的鍵見 webAppWeekFieldKeys_()
 *     PAGE_TITLE, PROGRAM_TEMPLATE_ID, PRELUDE, CALL_TEXT, CALL_REF,
 *     RECITATION_OVERRIDE, HYMN_PRAISE, CHOIR_LABEL, CHOIR_TITLE,
 *     SCRIPTURE_REF, SERMON_TITLE, RESPONSE_HYMN,
 *     ATTENDANCE_HEADING, ATTENDANCE_DATE,
 *     ATT_ENG_WORSHIP, ATT_CANE_WORSHIP, ATT_CANN_WORSHIP, ATT_MAN_WORSHIP,
 *     ATT_ENG_PRAYER, ATT_CANE_PRAYER, ATT_CANN_PRAYER, ATT_MAN_PRAYER,
 *     ATT_ENG_CHILD, ATT_CANE_CHILD, ATT_CANN_CHILD, ATT_MAN_CHILD,
 *     FLOWER_THIS_WEEK, FLOWER_NEXT_WEEK, NEXT_WEEK_HEADING, PRAYER_BLOCK_HEADING
 *   },
 *   announcements: [{ seqNo:(number|null), TEXT:string }, ...],
 *   prayers:       [{ seqNo:(number|null), TEXT:string }, ...],
 *   fellowships:   [{ seqNo:(number|null), FELLOWSHIP_NAME, MEETING_DATE, MEETING_TIME, CONTENT }, ...],
 *   finance:       [{ seqNo:(number|null), ROW_LABEL, COL_SPECIAL_OVERSEAS, COL_HARDSHIP }, ...],
 *   payloadVersion: 2,                 // D9：見 SAVE_PAYLOAD_VERSION_；帶事奉格而版本不對＝舊版前端，整次拒絕
 *   dutyEdits:     [{ postId:string, slotIndex:number, name:string,
 *                     baseName:string, keepOverride:(true|undefined) }, ...],   // 第六輪；D9 只送改過的格
 *   nextWeekDutyEdits: [ 同上 ]        // R-040：下週事奉，寫下一個主日
 * }
 * ```
 *
 * D9：`dutyEdits`／`nextWeekDutyEdits` **只放載入之後改過的格**（未套尊稱的原始姓名，`baseName` 是
 * 載入時的名字），以及幹事對衝突格按了「保留我的」的格（`keepOverride:true`）。沒有送來的格一律不動。
 * 與職事表現值相同、或者是空字串的格子**不會**產生 `DutyOverride` 記錄；職事表已經追上的覆寫每次儲存
 * 都會自動停用。見 `src/DutyOverride.gs` 的 `computeDutyOverridePlan_()`。
 * D9 之前前端每次都送全部格（docs/待確認事項.md FF-17、FF-26），那種舊分頁由 `payloadVersion` 擋住。
 *
 * 四個清單陣列代表「儲存後這一週應該有的完整清單、按顯示次序排列」：
 * `seqNo` 對得上工作表現有的行就是修改，對不上（或沒有這個欄位）就是
 * 新增；工作表上有、payload 沒有的 `seqNo`，會被改成 `ACTIVE=FALSE`
 * （不刪行）。儲存成功後，全部行的 `SEQ_NO` 會依 payload 次序重新編號
 * 成 10、20、30……
 */

'use strict';

// =====================================================================
// 欄位定義——集中一處，`WebApp.gs`（讀）與本檔案（存）共用
// =====================================================================

/**
 * 用途：填寫介面允許人手編輯的 `BulletinWeeks` 機器鍵清單（對應
 *   prompt「2.3 可編輯區塊」甲～戊的欄位，戊只含標題，清單內容另外走
 *   `webAppListDefs_()`）。系統欄位（`SERVICE_DATE`／`STATUS`／
 *   `ROSTER_VERSION_USED`／`DOC_ID`／`PDF_ID`／`LAST_GENERATED_AT`／
 *   `SENT_AT`／`LAST_SAVED_AT`／`NOTES` 等）刻意不在這裡，填寫介面不會
 *   碰這些欄位。
 * Args: （無）
 * Returns:
 *   {string[]}
 */
function webAppWeekFieldKeys_() {
  return [
    'PAGE_TITLE', 'PROGRAM_TEMPLATE_ID', 'PRELUDE', 'CALL_TEXT', 'CALL_REF', 'RECITATION_OVERRIDE',
    'HYMN_PRAISE', 'CHOIR_LABEL', 'CHOIR_TITLE', 'SCRIPTURE_REF', 'SERMON_TITLE', 'RESPONSE_HYMN',
    'ATTENDANCE_HEADING', 'ATTENDANCE_DATE',
    'ATT_ENG_WORSHIP', 'ATT_CANE_WORSHIP', 'ATT_CANN_WORSHIP', 'ATT_MAN_WORSHIP',
    'ATT_ENG_PRAYER', 'ATT_CANE_PRAYER', 'ATT_CANN_PRAYER', 'ATT_MAN_PRAYER',
    'ATT_ENG_CHILD', 'ATT_CANE_CHILD', 'ATT_CANN_CHILD', 'ATT_MAN_CHILD',
    'FLOWER_THIS_WEEK', 'FLOWER_NEXT_WEEK', 'NEXT_WEEK_HEADING',
    'PRAYER_BLOCK_HEADING'
    // 浸禮合堂副框六欄接在後面。
    //
    // ⚠️ 六欄**一律在這份清單內**，即使那一週不是浸禮合堂——介面只是把
    // 面板隱藏起來（`readOnly.isBaptismSunday` 為 false），欄位仍然會被
    // 讀出來、原樣送回、原樣存回去。**隱藏不等於刪除**：如果把六欄從這份
    // 清單剔走，非浸禮主日儲存一次就會把既有的浸禮資料洗掉（例如幹事把
    // 某一週的範本由浸禮改回平常再改返），而且完全沒有提示。
  ].concat(baptismBoxFieldKeys_());
}

/**
 * 用途：填寫介面上每個 `BulletinWeeks` 欄位的中文名稱，`FIELD_CONFLICT` 的
 *   錯誤訊息要用。使用者看不懂機器鍵，訊息講「PRELUDE」等於沒有講。
 *
 *   名稱的來源只有三處，不另抄第二份：
 *     - 宣召出處／宣召經文／人數統計日期／十二個人數欄：重用
 *       `Constants.gs` 的 `CONTENT_SHEET_READONLY_LABELS`；
 *     - 浸禮合堂副框六欄：重用 `baptismBoxFieldDefs_()` 的 `label`；
 *     - 其餘欄位：下面這張短表（與 `src/ui/Index.html` 的標籤一致）。
 *
 *   ⚠️ 改了介面標籤要同步改這裡；`tests/webappsave.test.js` 有測試確保
 *   `webAppWeekFieldKeys_()` 每一個鍵都有名稱，而且與上面兩個單一來源一致。
 * Args: （無）
 * Returns:
 *   {Object<string,string>} 機器鍵 → 中文名稱。
 */
function webAppWeekFieldLabels_() {
  var labels = {
    PAGE_TITLE: '程序表大標題', PROGRAM_TEMPLATE_ID: '程序範本', PRELUDE: '序樂',
    RECITATION_OVERRIDE: '誦讀（覆寫）',
    HYMN_PRAISE: '詩歌頌讚', CHOIR_LABEL: '詩班項目名稱', CHOIR_TITLE: '詩班曲名',
    SCRIPTURE_REF: '讀經經文', SERMON_TITLE: '證道講題', RESPONSE_HYMN: '回應詩歌',
    ATTENDANCE_HEADING: '人數表標題',
    FLOWER_THIS_WEEK: '本週獻花', FLOWER_NEXT_WEEK: '下週獻花', NEXT_WEEK_HEADING: '下週事奉標題',
    PRAYER_BLOCK_HEADING: '代禱區塊標題'
  };
  CONTENT_SHEET_READONLY_FIELDS.WEEK.forEach(function (key) {
    labels[key] = CONTENT_SHEET_READONLY_LABELS[key] || key;
  });
  baptismBoxFieldDefs_().forEach(function (def) {
    labels[def.key] = def.label;
  });
  return labels;
}

/**
 * 用途：四張「可增刪清單」工作表的定義：工作表名稱與可編輯欄位。
 * Args: （無）
 * Returns:
 *   {Object<string,{sheetName:string, fieldKeys:string[]}>} key 是
 *     payload／回應內用的清單名稱（`announcements`／`prayers`／
 *     `fellowships`／`finance`）。
 */
function webAppListDefs_() {
  return {
    announcements: { sheetName: SHEETS.ANNOUNCEMENTS, fieldKeys: ['TEXT'] },
    prayers: { sheetName: SHEETS.PRAYERS, fieldKeys: ['TEXT'] },
    fellowships: { sheetName: SHEETS.FELLOWSHIPS, fieldKeys: ['FELLOWSHIP_NAME', 'MEETING_DATE', 'MEETING_TIME', 'CONTENT'] },
    finance: { sheetName: SHEETS.FINANCE, fieldKeys: ['ROW_LABEL', 'COL_SPECIAL_OVERSEAS', 'COL_HARDSHIP'] }
  };
}

// =====================================================================
// 純函式層
// =====================================================================

/**
 * 用途：判斷兩個「應該相等」的值是不是真的相等。`Date` 物件用時間戳記
 *   比較（避免 `String(Date)` 的時區／格式差異造成誤判「有改動」）；
 *   其餘一律轉字串比較，`null`／`undefined`／`''` 視為同一個「空」。
 * Args:
 *   a {*}　b {*}
 * Returns:
 *   {boolean}
 */
function fieldsEqual_(a, b) {
  var aIsDate = a instanceof Date;
  var bIsDate = b instanceof Date;
  if (aIsDate || bIsDate) {
    var ta = aIsDate ? a.getTime() : NaN;
    var tb = bIsDate ? b.getTime() : NaN;
    if (Number.isNaN(ta) && Number.isNaN(tb)) return true;
    return ta === tb;
  }
  var na = (a === null || a === undefined) ? '' : a;
  var nb = (b === null || b === undefined) ? '' : b;
  return String(na) === String(nb);
}

/**
 * 用途：比對「現有資料」與「新值」，只留下真的有變的欄位。**這是
 *   AuditLog「逐格記錄、沒改動的不寫」承諾的核心**：呼叫方只要把這個
 *   函式的輸出直接拿去寫 AuditLog，就不會有多餘記錄。
 * Args:
 *   existingObj {Object} 現有資料（缺少的鍵視為 `undefined`）。
 *   newValuesObj {Object} 新值。
 *   fieldKeys {string[]} 要比對的機器鍵清單。
 * Returns:
 *   {{field:string, oldValue:*, newValue:*}[]}
 */
function computeFieldDiff_(existingObj, newValuesObj, fieldKeys) {
  var changes = [];
  (fieldKeys || []).forEach(function (key) {
    var oldValue = existingObj ? existingObj[key] : undefined;
    var newValue = newValuesObj ? newValuesObj[key] : undefined;
    if (!fieldsEqual_(oldValue, newValue)) {
      changes.push({ field: key, oldValue: oldValue, newValue: newValue });
    }
  });
  return changes;
}

/**
 * 用途：把兩位數字補成兩位字串（`5` → `'05'`），`formatSaveTokenDate_()`
 *   的小工具。
 * Args:
 *   n {number}
 * Returns:
 *   {string}
 */
function pad2ForSaveToken_(n) {
  return (n < 10 ? '0' : '') + n;
}

/**
 * 用途：把一個 `Date` 物件格式化成 `yyyy-MM-dd HH:mm:ss`，`canonicalSaveToken_()`
 *   專用。
 *
 *   ⚠️ 刻意用 `Date` 物件自己的 `getFullYear()`／`getHours()` 等**區域時間**
 *   讀值，不呼叫 `Utilities.formatDate()`——這樣這個函式完全不碰 Apps
 *   Script 服務，可以在 Node 直接測試，不需要任何 GAS stub。這樣做是
 *   安全的：Apps Script 專案本身的執行時區（`appsscript.json` 的
 *   `timeZone`）本來就設定成跟 Config 的 `SYS_TIMEZONE` 一致
 *   （`Pacific/Auckland`），所以 `Date` 物件的區域時間讀值本來就等於用
 *   `SYS_TIMEZONE` 格式化的結果；`BulletinModel.gs` 的
 *   `formatDatePatternSimple_()` 也是同一個做法。
 * Args:
 *   date {Date}
 * Returns:
 *   {string}
 */
function formatSaveTokenDate_(date) {
  return date.getFullYear() + '-' + pad2ForSaveToken_(date.getMonth() + 1) + '-' + pad2ForSaveToken_(date.getDate())
    + ' ' + pad2ForSaveToken_(date.getHours()) + ':' + pad2ForSaveToken_(date.getMinutes()) + ':' + pad2ForSaveToken_(date.getSeconds());
}

/**
 * 用途：把任何一個「代表最後儲存時間」的值，正規化成單一個標準字串
 *   （canonical save token）。**`apiLoadWeek()` 給前端的 `lastSavedAt`，
 *   跟 `apiSaveWeek()` 比對樂觀鎖時，都只准經過這一個函式**，不可以
 *   各自再發明一套「這算不算空」的判斷。
 *
 *   ⚠️ 事故：修這個函式之前，「從未儲存」這個狀態有**兩種表示法**——
 *   `loadWeekForWebApp_()` 給前端的是 `weekRow.LAST_SAVED_AT || null`
 *   （`null`），`saveWeekFromWebApp_()` 直接讀工作表算出來的樂觀鎖判斷
 *   走的是另一套邏輯——兩條路徑「同一個狀態」用了不同的值／比較方式，
 *   稍有落差就會被判定不相符，導致**第一次儲存永遠被誤判成 STALE**，
 *   而且錯誤訊息還說「有人改過」，其實從來沒有人存過。詳見
 *   docs/已知bug類型.md 事故七。修法是兩條路徑都只透過這一個函式取得
 *   要比較的值，「同一個狀態只有一種表示法」。
 * Args:
 *   value {*} `Date` 物件、可以被 `new Date()` 解析成合法日期的字串、
 *     代表時間戳記的數字（epoch 毫秒；Sheets 有時會把時間戳當成序列值
 *     讀出來，一律當數字處理），或代表「從未儲存」的空值
 *     （`null`／`undefined`／空字串／只有空白的字串）。
 * Returns:
 *   {string} 空值一律回 `''`（代表「從未儲存」，兩條路徑都用這個值，
 *     `'' === ''` 才會相符，第一次儲存才存得進去）；`Date`／可解析成
 *     日期的字串／數字一律格式化成 `yyyy-MM-dd HH:mm:ss`；其餘（解析
 *     不出日期的字串）回 `trim()` 之後的原值，不拋錯。
 */
function canonicalSaveToken_(value) {
  if (value === null || value === undefined) return '';

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? '' : formatSaveTokenDate_(value);
  }

  if (typeof value === 'number') {
    var fromNumber = new Date(value);
    return Number.isNaN(fromNumber.getTime()) ? '' : formatSaveTokenDate_(fromNumber);
  }

  if (typeof value === 'string') {
    var trimmed = value.trim();
    if (trimmed === '') return '';
    var parsed = new Date(trimmed);
    if (!Number.isNaN(parsed.getTime())) return formatSaveTokenDate_(parsed);
    return trimmed;
  }

  return String(value).trim();
}

/**
 * 用途：樂觀鎖檢查——`apiLoadWeek()` 給前端的 `lastSavedAt`，要跟目前
 *   工作表現有的 `LAST_SAVED_AT` 一致才允許儲存。兩者都是「空」（例如
 *   這一週從來沒有被填寫介面存過）也算相符，允許第一次儲存。兩個值都
 *   經 `canonicalSaveToken_()` 正規化之後才比較——見該函式 docstring
 *   說明的事故。
 * Args:
 *   currentLastSavedAt {*} 目前工作表現有的 `BulletinWeeks.LAST_SAVED_AT`。
 *   payloadLastSavedAt {*} `apiSaveWeek()` payload 帶回來的 `lastSavedAt`。
 * Returns:
 *   {boolean}
 */
function checkOptimisticLock_(currentLastSavedAt, payloadLastSavedAt) {
  return canonicalSaveToken_(currentLastSavedAt) === canonicalSaveToken_(payloadLastSavedAt);
}

/**
 * 用途：算出一張「可增刪清單」表的 upsert 計畫：新增、修改（含重新編號）、
 *   停用（`ACTIVE=FALSE`，不刪行）。完全不碰 Apps Script 服務。
 *
 *   規則：
 *     - `payloadItems` 依**次序**重新編號成 10、20、30……
 *     - `payloadItems[i].seqNo` 對得上 `existingRows` 現有的 `SEQ_NO`
 *       → 視為修改那一行（逐欄比對，只記真的有變的欄位；`SEQ_NO`／
 *       `ACTIVE` 有變也算一項變動）。
 *     - 對不上（`seqNo` 是 `null`／`undefined`，或工作表沒有這個
 *       `SEQ_NO`）→ 視為新增一行。
 *     - `existingRows` 內沒有被任何 `payloadItems` 認領、而且目前
 *       `ACTIVE===true` 的行 → 停用（改 `ACTIVE=FALSE`），**不刪行**。
 *       已經是 `ACTIVE=FALSE` 的行不會重複停用（不產生多餘變動）。
 * Args:
 *   existingRows {Object[]} 該主日現有的資料列，每個元素要有 `__rowNo`
 *     （工作表實際行號）、`SEQ_NO`、`ACTIVE`，以及 `fieldKeys` 內的欄位。
 *   payloadItems {Object[]} 前端送回的清單，依顯示次序排列，每個元素
 *     可以有 `seqNo`（原本的 `SEQ_NO`，新增的行留空／`null`）與
 *     `fieldKeys` 內的欄位。
 *   fieldKeys {string[]} 這張表的可編輯欄位（不含 `SERVICE_DATE`／
 *     `SEQ_NO`／`ACTIVE`）。
 * Returns:
 *   {{updates:{rowNo:number, seqNoOld:number, seqNoNew:number, changes:Object[]}[],
 *     appends:Object[], deactivations:{rowNo:number, seqNoOld:number}[]}}
 *     `appends` 內每個元素是要新增的一整行資料（不含 `SERVICE_DATE`，
 *     由呼叫方補上）。
 */
function computeListUpsertPlan_(existingRows, payloadItems, fieldKeys) {
  var existingBySeqNo = {};
  (existingRows || []).forEach(function (row) { existingBySeqNo[row.SEQ_NO] = row; });

  var claimedSeqNos = {};
  var updates = [];
  var appends = [];

  (payloadItems || []).forEach(function (item, idx) {
    var newSeqNo = (idx + 1) * 10;
    var hasSeqNo = item.seqNo !== null && item.seqNo !== undefined;
    var existing = hasSeqNo ? existingBySeqNo[item.seqNo] : null;

    if (existing) {
      claimedSeqNos[existing.SEQ_NO] = true;
      var changes = [];
      if (!fieldsEqual_(existing.SEQ_NO, newSeqNo)) {
        changes.push({ field: 'SEQ_NO', oldValue: existing.SEQ_NO, newValue: newSeqNo });
      }
      if (existing.ACTIVE !== true) {
        changes.push({ field: 'ACTIVE', oldValue: existing.ACTIVE, newValue: true });
      }
      (fieldKeys || []).forEach(function (key) {
        if (!fieldsEqual_(existing[key], item[key])) {
          changes.push({ field: key, oldValue: existing[key], newValue: item[key] });
        }
      });
      updates.push({ rowNo: existing.__rowNo, seqNoOld: existing.SEQ_NO, seqNoNew: newSeqNo, changes: changes });
    } else {
      var row = { SEQ_NO: newSeqNo };
      (fieldKeys || []).forEach(function (key) {
        var v = item[key];
        row[key] = (v === null || v === undefined) ? '' : v;
      });
      appends.push(row);
    }
  });

  var deactivations = [];
  (existingRows || []).forEach(function (row) {
    if (claimedSeqNos[row.SEQ_NO]) return;
    if (row.ACTIVE === true) {
      deactivations.push({ rowNo: row.__rowNo, seqNoOld: row.SEQ_NO });
    }
  });

  return { updates: updates, appends: appends, deactivations: deactivations };
}

/**
 * 用途：判斷一個值是不是「有出現」的欄位值——`payload.week` 與
 *   `payload.baseWeek` 只放使用者真的改過的欄位，沒有出現的鍵代表「這次
 *   沒有改」，不是「改成空白」。
 * Args:
 *   obj {?Object}　key {string}
 * Returns:
 *   {boolean}
 */
function weekPayloadHasKey_(obj, key) {
  return !!obj && Object.prototype.hasOwnProperty.call(obj, key);
}

/**
 * 用途：替「由程式叫儲存入口」的呼叫方（自測機、亂行測試）算出 `baseWeek`：
 *   `week` 內每個欄位在**載入時**的值，取自 `loadWeekForWebApp_()` 回傳的
 *   `week`。填寫介面自己的前端有同樣的邏輯（`diffWeekFields()`）。
 *
 *   載入結果裡沒有這個鍵時當作空白，與 `fieldsEqual_()` 把空值視為同一個
 *   「空」一致。
 * Args:
 *   loadedWeek {?Object} `loadWeekForWebApp_(isoDate).week`。
 *   patchWeek {Object} 準備送去儲存的 `week`。
 * Returns:
 *   {Object} 鍵與 `patchWeek` 完全相同。
 */
function baseWeekFor_(loadedWeek, patchWeek) {
  var base = {};
  Object.keys(patchWeek || {}).forEach(function (key) {
    var v = loadedWeek ? loadedWeek[key] : undefined;
    base[key] = (v === null || v === undefined) ? '' : v;
  });
  return base;
}

/**
 * D9：填寫介面儲存 payload 的格式版本。前端（src/ui/Script.html 的 SAVE_PAYLOAD_VERSION）送同一個數字，
 * tests/dutychanged.test.js 核對兩邊一致。
 *   1（未有這個欄位）：事奉框每次送全部格（FF-17、FF-26 的根因）。
 *   2：事奉框只送載入之後改過的格，每格帶 `baseName`；衝突格可以帶 `keepOverride:true`。
 * 日後 payload 的意思再改，要加一，並在 `isOutdatedDutyPayload_()` 一類的檢查擋住舊版。
 */
var SAVE_PAYLOAD_VERSION_ = 2;

/**
 * 用途：D9：payload 是不是 D9 之前的前端送來的事奉格（每次送全部格）。純函式。
 *
 *   只在 payload 真的帶事奉格（`dutyEdits` 或 `nextWeekDutyEdits` 有內容）時才要求版本：兩版只有事奉格的
 *   意思不同，沒有事奉格的 payload 兩版完全一樣，照舊放行（自測機、亂行機、程式叫的儲存都不帶事奉格）。
 *   舊版前端只要畫面上有事奉框就一定會送全部格，所以擋得到。
 * Args:
 *   payload {Object} 儲存 payload。
 * Returns:
 *   {boolean} true＝要拒絕（CLIENT_OUTDATED）。
 * Raises:
 *   （無）
 */
function isOutdatedDutyPayload_(payload) {
  var p = payload || {};
  var hasDutyCells = (Array.isArray(p.dutyEdits) && p.dutyEdits.length > 0)
    || (Array.isArray(p.nextWeekDutyEdits) && p.nextWeekDutyEdits.length > 0);
  return hasDutyCells && p.payloadVersion !== SAVE_PAYLOAD_VERSION_;
}

/**
 * 用途：判斷 payload 有沒有帶 `baseWeek`。`null`／陣列／字串／數字一律當作
 *   沒有——缺失不可以被當成「沒有任何欄位改動」而放行。`saveWeekFromWebApp_()`
 *   與 `buildSaveOperations_()` 共用這一個判斷，不各寫一套。
 * Args:
 *   baseWeek {*} 。
 * Returns:
 *   {boolean}
 */
function hasBaseWeek_(baseWeek) {
  return !!baseWeek && typeof baseWeek === 'object' && !Array.isArray(baseWeek);
}

/**
 * 用途：整份儲存請求的純函式層。先做 `baseWeek` 與樂觀鎖檢查（不符直接拋
 *   錯，一個格都不會算進後面的計畫），再用**三方比較**算出週欄位的異動與
 *   四張清單的 upsert 計畫。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 為甚麼是三方比較（docs/已知bug類型.md 事故四十八）
 * ─────────────────────────────────────────────────────────────────────
 *
 * 前端只送「使用者真的改過」的欄位（`payload.week`），另外送那些欄位
 * **載入時**的值（`payload.baseWeek`）。對每一個送來的欄位，有三個值：
 *
 *   | 工作表現值 | 結果 |
 *   |---|---|
 *   | = 送來的值 | 不用寫（別處已經是這個值） |
 *   | = baseWeek 的值 | 照寫（載入之後沒有人動過這一格） |
 *   | 兩者都不等 | 別人在載入之後改過同一格 ⇒ **整次拒絕**（`FIELD_CONFLICT`） |
 *
 * 只比「表單值 vs 工作表現值」的兩方比較分不出「使用者改過」與「表單上
 * 是舊值」，舊分頁一儲存就會把觸發器、匯入剛寫入的值蓋回舊值。
 *
 * ⚠️ 有任何一格衝突，**一格都不寫**——拋錯發生在套用計畫之前。
 * Args:
 *   input {{currentWeek:(Object|null), payload:Object, existingLists:Object}}
 *     `currentWeek` 是目前 `BulletinWeeks` 該主日那一行（帶 `__rowNo`），
 *     沒有該行時傳 `null`；`payload` 見檔頭的 payload 形狀說明，其中
 *     `payload.week` 與 `payload.baseWeek` 必須是**已經正規化過**的值
 *     （`DATE` 型別欄位已經是 `Date` 或 `null`，見
 *     `normalizeWeekPayloadForCompare_()`）；`existingLists` 是四個清單
 *     目前的資料列。
 * Returns:
 *   {{weekChanges:Object[], listPlans:Object<string,Object>}}
 *     `weekChanges` 每個元素 `{field, oldValue, newValue}`，只含真的要寫的欄位。
 * Raises:
 *   Error（`code:'CLIENT_OUTDATED'`）如果 payload 沒有 `baseWeek`（舊版
 *     前端，仍然送整張表單）——不可以退回舊的整張寫入。
 *   Error（`code:'STALE'`）如果樂觀鎖不符。訊息**同時包含兩個時間**
 *     （工作表上目前的最後儲存時間、payload 帶來的載入時版本時間）。
 *   Error（`code:'FIELD_CONFLICT'`）如果有欄位在使用者載入之後已被別處
 *     改過；`err.conflictFields` 是機器鍵清單。
 */
function buildSaveOperations_(input) {
  var payload = input.payload || {};
  var currentWeek = input.currentWeek || null;

  // ⚠️ 沒有 baseWeek ＝ 舊版前端（未重新載入的分頁）。`null`／陣列／非物件
  // 一律當作沒有——缺失不可以被當成「沒有任何欄位改動」而放行。
  // D9：帶事奉格而 payloadVersion 不是 SAVE_PAYLOAD_VERSION_，亦是舊版前端（仍然送全部格）。
  if (!hasBaseWeek_(payload.baseWeek) || isOutdatedDutyPayload_(payload)) {
    var outdated = new Error('介面版本已更新，請重新載入這一頁再儲存。');
    outdated.code = 'CLIENT_OUTDATED';
    throw outdated;
  }

  var currentToken = canonicalSaveToken_(currentWeek ? currentWeek.LAST_SAVED_AT : null);
  var payloadToken = canonicalSaveToken_(payload.lastSavedAt);

  if (currentToken !== payloadToken) {
    var err = new Error(
      '這一週的資料在你載入之後被改過（工作表上的最後儲存時間是 '
      + (currentToken || '（尚未儲存）') + '，你載入時是 ' + (payloadToken || '（尚未儲存）')
      + '）。請重新載入後再儲存，以免覆蓋別人的修改。'
    );
    err.code = 'STALE';
    throw err;
  }

  var week = payload.week || {};
  var baseWeek = payload.baseWeek;
  var current = currentWeek || {};
  var weekChanges = [];
  var conflictFields = [];

  // 只看 payload 內有出現的欄位；沒有出現的欄位一律不碰。
  webAppEditableWeekFieldKeys_().forEach(function (key) {
    if (!weekPayloadHasKey_(week, key)) return;
    var currentValue = current[key];
    var sentValue = week[key];
    if (fieldsEqual_(currentValue, sentValue)) return;
    if (fieldsEqual_(currentValue, baseWeek[key])) {
      weekChanges.push({ field: key, oldValue: currentValue, newValue: sentValue });
      return;
    }
    conflictFields.push(key);
  });

  if (conflictFields.length > 0) {
    var labels = webAppWeekFieldLabels_();
    var names = conflictFields.map(function (key) { return labels[key] || key; });
    var conflict = new Error(
      '以下欄位在你載入之後已經被改過（可能是季度填寫表、內容表匯入或另一個分頁）：'
      + names.join('、') + '。請重新載入再改，以免蓋走別人的修改。'
    );
    conflict.code = 'FIELD_CONFLICT';
    conflict.conflictFields = conflictFields;
    throw conflict;
  }

  // ⚠️ R-011 起，四張清單（家事報告／代禱事項／團契聚會／財政報告）**全部
  // 改由內容表輸入**，填寫介面一行都不會再送。所以這裡**完全不處理清單**，
  // 一律回空計畫。
  //
  // 這一點不是「順手清理」，是安全要求：`computeListUpsertPlan_()` 對
  // 「payload 沒有這個清單」與「payload 明確送一個空陣列」的處理是一樣的
  // ——兩者都會把現有全部行改成 `ACTIVE=FALSE`。前端改成唯讀之後不再送，
  // 如果這裡照舊用 `payload[type] || []`，第一次儲存就會把整週的家事報告
  // 與代禱事項靜靜清光。清單的唯一寫入路徑，從此只有
  // `src/ContentImport.gs`。
  return { weekChanges: weekChanges, listPlans: {} };
}

/**
 * 用途：把前端送來的 `payload.week`（或 `payload.baseWeek`）正規化成可以
 *   拿去跟工作表現有值比較的形狀——`BulletinWeeks` 型別是 `DATE` 的欄位
 *   （目前只有 `ATTENDANCE_DATE`）轉成 `Date`／`null`，其餘欄位的
 *   `null`／`undefined` 轉成 `''`。
 *
 *   ⚠️ **只處理 payload 內有出現的鍵**。前端現時只送使用者改過的欄位，
 *   沒有出現的鍵代表「沒有改」；若像舊版一樣把缺少的鍵補成 `''`，一個
 *   只改了獻花的 payload 就會把其餘欄位全部清空。
 *   `createWeekRow_()`（防呆補行）讀 `normalizedWeek[key]` 時，未出現的
 *   鍵本來就是 `undefined`，它自己把 `undefined` 當空白，不受影響。
 *
 *   分離出這個函式，是因為前端經 `google.script.run` 傳回來的日期通常是
 *   `yyyy-MM-dd` 文字，而工作表讀出來的是 `Date` 物件——`fieldsEqual_()`
 *   對 `Date` 有專門的比較邏輯，兩邊型別要先對齊才比得出「真的有沒有變」。
 * Args:
 *   rawWeek {?Object} `payload.week` 或 `payload.baseWeek`。
 * Returns:
 *   {Object} 只含 `webAppWeekFieldKeys_()` 列出、而且 `rawWeek` 內有出現的欄位。
 * Raises:
 *   Error 如果 `ATTENDANCE_DATE` 有值但不是合法的 `yyyy-MM-dd`（`normalizeDate_()`
 *     原樣拋出）。
 */
function normalizeWeekPayloadForCompare_(rawWeek) {
  var week = rawWeek || {};
  var result = {};
  var keys = COLUMNS.BULLETIN_WEEKS.keys;
  var types = COLUMNS.BULLETIN_WEEKS.types;

  webAppWeekFieldKeys_().forEach(function (key) {
    if (!weekPayloadHasKey_(week, key)) return;
    var idx = keys.indexOf(key);
    var type = idx === -1 ? 'TEXT' : types[idx];
    var raw = week[key];
    if (type === 'DATE') {
      result[key] = raw ? normalizeDate_(raw) : null;
    } else {
      result[key] = (raw === null || raw === undefined) ? '' : raw;
    }
  });
  return result;
}

// =====================================================================
// 內容表接管的七個區塊：後端硬擋
// =====================================================================

/**
 * 用途：內容表接管之後、填寫介面**不可以再寫入**的 `BulletinWeeks` 欄位。
 *
 *   由 `contentImportTargets_()`（`src/ContentImport.gs`）衍生，不另抄
 *   一份——多一份就多一個會不同步的地方。
 * Args: （無）
 * Returns:
 *   {string[]} `BulletinWeeks` 的機器鍵。
 */
function contentSheetOwnedWeekKeys_() {
  return CONTENT_SHEET_READONLY_FIELDS.WEEK.slice();
}

/**
 * 用途：由 `contentImportTargets_()` **推算**出來的唯讀欄位，只用來與
 *   `CONTENT_SHEET_READONLY_FIELDS.WEEK` 對數。
 *
 *   ⚠️ 這一支**不是**給正式流程用的。正式流程一律用
 *   `contentSheetOwnedWeekKeys_()`（單一真相來源）。這一支存在的唯一
 *   理由，是讓測試抓得到「有人新增了匯入目標卻忘記更新唯讀清單」。
 * Args: （無）
 * Returns:
 *   {string[]}
 */
function contentSheetOwnedWeekKeysDerived_() {
  var keys = [];
  contentImportTargets_().forEach(function (def) {
    if (def.targetSheet !== SHEETS.BULLETIN_WEEKS) return;
    // ⚠️ 第三種模式（`overridable`）的分頁**不算唯讀**：內容表是來源，
    //    但介面照樣改得到。把它們算進唯讀清單的話，幹事一按儲存就會被
    //    整次拒絕，而拒絕訊息會講「這一欄由內容表接管」——完全誤導。
    if (def.overridable === true) return;
    Object.keys(def.fieldMap).forEach(function (sourceKey) {
      var targetKey = def.fieldMap[sourceKey];
      if (keys.indexOf(targetKey) === -1) keys.push(targetKey);
    });
  });
  // 人數統計日期跟著十二個人數欄一起由內容表決定，不再由介面填。
  if (keys.indexOf('ATTENDANCE_DATE') === -1) keys.push('ATTENDANCE_DATE');
  return keys;
}

/**
 * 用途：內容表接管之後、填寫介面**不可以再送**的清單名稱。
 * Args: （無）
 * Returns:
 *   {string[]} `webAppListDefs_()` 的 key（`announcements` 等）。
 */
function contentSheetOwnedListTypes_() {
  return CONTENT_SHEET_READONLY_FIELDS.LISTS.slice();
}

/**
 * 用途：由 `contentImportTargets_()` 推算出來的唯讀清單名稱，同樣只用來
 *   與 `CONTENT_SHEET_READONLY_FIELDS.LISTS` 對數，見
 *   `contentSheetOwnedWeekKeysDerived_()` 的說明。
 * Args: （無）
 * Returns:
 *   {string[]}
 */
function contentSheetOwnedListTypesDerived_() {
  var defs = webAppListDefs_();
  var owned = [];
  contentImportTargets_().forEach(function (def) {
    if (def.kind !== 'LIST') return;
    Object.keys(defs).forEach(function (type) {
      if (defs[type].sheetName === def.targetSheet && owned.indexOf(type) === -1) owned.push(type);
    });
  });
  return owned;
}

/**
 * 用途：把一個唯讀欄位／清單的機器鍵，換成給人看的名稱。
 * Args:
 *   key {string} 機器鍵或清單名稱。
 * Returns:
 *   {string} 查不到就原樣回機器鍵——講一個機器鍵，好過不講。
 */
function contentSheetReadOnlyLabel_(key) {
  var label = CONTENT_SHEET_READONLY_LABELS[key];
  return label ? (label + '（' + key + '）') : key;
}

/**
 * 用途：擋住「填寫介面試圖寫入內容表接管的七個區塊」。
 *
 *   ⚠️ **前端不送、後端也要擋**——只擋前端等於沒有擋：任何人打開瀏覽器
 *   主控台就可以直接呼叫 `apiSaveWeek()`，而且日後前端改版漏了一個欄位，
 *   靜靜寫進去之後下一次匯入才會被蓋回去，中間那段時間幹事會以為自己
 *   改到了。所以這裡拋錯，不是靜靜忽略。
 * Args:
 *   payload {Object} `apiSaveWeek()` 收到的 payload。
 * Returns:
 *   {void}
 * Raises:
 *   Error（`code = 'CONTENT_SHEET_READONLY'`）只要 payload 帶了任何一個
 *     被接管的欄位或清單。
 */
/**
 * 用途：填寫介面**仍然可以編輯**的 `BulletinWeeks` 欄位——就是
 *   `webAppWeekFieldKeys_()` 扣除內容表接管的那幾個。
 *
 *   ⚠️ 兩份清單分工要分清楚：
 *     - `webAppWeekFieldKeys_()`　**讀取**用。七個唯讀區塊仍然要送去前端
 *       **顯示**，所以那幾個欄位照樣要在載入清單內。
 *     - 本函式　**寫入**用。差異計算與儲存一律只看這一份。
 *   把兩者混為一談，就會出現「介面顯示得到、但一儲存就被當成改動寫回去」。
 * Args: （無）
 * Returns:
 *   {string[]}
 */
function webAppEditableWeekFieldKeys_() {
  var owned = contentSheetOwnedWeekKeys_();
  // ⚠️ R-043／R-045：第三種模式那十欄**照樣寫入 `BulletinWeeks`**，
  //    同時另外記一筆 `FieldOverride`——與 `DutyOverride` 完全同一個做法。
  //
  //    一度試過「只寫 FieldOverride、不寫 BulletinWeeks」，結果係錯的：
  //    季度填寫表（`FillGrid`）同樣改得到呢十欄，而佢寫嘅係 `BulletinWeeks`。
  //    兩個介面寫兩個唔同地方，等於同一格有兩個真相來源——正正係
  //    docs/已知bug類型.md 事故三。
  //
  //    ⚠️ 「覆寫前嘅來源值」記喺 `FieldOverride.SOURCE_VALUE_AT_OVERRIDE`，
  //    唔係靠 `BulletinWeeks` 現值推——現值已經係覆寫值，拿佢去比就永遠
  //    相等。呢一點同 `DutyOverride.ROSTER_VALUE_AT_OVERRIDE` 一模一樣。
  return webAppWeekFieldKeys_().filter(function (key) { return owned.indexOf(key) === -1; });
}

function findSubmittedReadOnlyFields_(payload) {
  var week = (payload && payload.week) || {};

  // ⚠️ 判斷準則是「**有沒有真的帶內容**」，不是「有沒有這個 key」。
  // 舊版前端（使用者瀏覽器有快取）會送 `announcements: []`、
  // `ATT_ENG_WORSHIP: ''` 這類空值；那些空值寫不到任何東西（清單根本
  // 不再處理，見 `buildSaveOperations_()`），為此整個儲存失敗只會令幹事
  // 連其他欄位都改不到。真正要擋的是「帶著實際內容想寫入」。
  var offending = contentSheetOwnedWeekKeys_().filter(function (key) {
    var v = week[key];
    return v !== undefined && v !== null && String(v).trim() !== '';
  });

  // ⚠️ 清單要**兩種形狀都檢查**：正式 payload 放在頂層
  // （`payload.announcements`），但呼叫方有機會寫成 `payload.lists.announcements`
  // ——第一輪自測 S09 就是這樣送的，於是這道檢查完全沒有觸發，S09 綠燈
  // 報告「拒絕成功」，其實兩邊都沒有看過那個清單。只認一種形狀的檢查，
  // 遇到另一種形狀時不會報錯，只會**靜靜地什麼都不做**。
  var nested = (payload && payload.lists) || {};
  contentSheetOwnedListTypes_().forEach(function (type) {
    var top = payload ? payload[type] : undefined;
    var inner = nested[type];
    var hasItems = (Array.isArray(top) && top.length > 0)
      || (Array.isArray(inner) && inner.length > 0);
    if (hasItems && offending.indexOf(type) === -1) offending.push(type);
  });

  return offending;
}

function assertContentSheetFieldsNotSubmitted_(payload) {
  var offending = findSubmittedReadOnlyFields_(payload);
  if (offending.length === 0) return;

  var names = offending.map(function (key) { return contentSheetReadOnlyLabel_(key); });
  var err = new Error(
    '家事報告、代禱事項、本週團契聚會、月度財政報告、上週崇拜人數、宣召出處、宣召經文，'
    + '這七項內容已改由內容表輸入，填寫介面不可以再儲存它們。'
    + '整次儲存已經取消，一格都沒有寫入。'
    + '請到內容表修改，然後按「重新匯入」。'
    + '（收到的唯讀欄位共 ' + offending.length + ' 項：' + names.join('、') + '）'
  );
  err.code = 'CONTENT_SHEET_READONLY';
  err.readOnlyFields = offending;
  throw err;
}

// =====================================================================
// 真正入口
// =====================================================================

/**
 * 用途：`apiSaveWeek()` 的真正入口。讀現有工作表狀態、呼叫純函式層算出
 *   異動計畫、把計畫套用到 `BulletinWeeks`／四張清單／`AuditLog`。
 *
 *   樂觀鎖不符、欄位衝突或前端版本過舊時（`buildSaveOperations_()` 拋錯）
 *   **不會執行任何寫入**——拋錯發生在讀完現有狀態、套用計畫之前。
 *
 *   欄位、事奉覆寫、下週事奉覆寫、第三種欄位覆寫**全部沒有改動**時，
 *   不寫 `LAST_SAVED_AT`，回傳原本的 token（見 F2：沒有改動的儲存若也更新
 *   token，另一個分頁就會被無辜地判成 STALE）。
 * Args:
 *   payload {Object} 見本檔案檔頭的 payload 形狀說明。
 * Returns:
 *   {{lastSavedAt:string, changedFieldCount:number, sideRecordCount:number,
 *     message:{type:string,text:string}}}
 *     `lastSavedAt` 是 `canonicalSaveToken_()` 正規化過的字串（不是
 *     `Date`）——前端拿到什麼就原樣存起來、下次儲存原樣送回即可，不需要
 *     自己再處理任何日期／時區轉換。`changedFieldCount` 是使用者這次改了
 *     幾個欄位（週報欄位、事奉框與下週事奉的每一格各算一個），
 *     `sideRecordCount` 是另外更新了幾筆附帶記錄（欄位覆寫、事奉框覆寫的
 *     基準值）；兩個數字都由這次實際寫入 `AuditLog` 的條目數出來（同一個
 *     真相來源：`auditEntries`，分類見 `countSaveChanges_()`）。G16 之前
 *     `changedFieldCount` 等於 `auditEntries.length`，把覆寫記錄也算成欄位。
 *     `message` 是 `buildSaveResultMessage_()` 算好的文案，前端直接顯示，
 *     不再自己砌字串（前端沒有 Node 測試，文案分支放在這裡才測得到）。
 *
 *   第二批測試修正 G23：由讀取工作表、比對樂觀鎖，到寫入 `LAST_SAVED_AT` 與
 *   `AuditLog`，全部在指令碼鎖（`LockService.getScriptLock()`）之內做
 *   （`saveWeekFromWebAppLocked_()`）。以前樂觀鎖檢查與寫入 `LAST_SAVED_AT` 之間沒有鎖：
 *   儲存遇到連線錯誤之後即時再按（FF-13 容許），而第一次仍在伺服器上跑的話，第二次讀到的
 *   `LAST_SAVED_AT` 仍是舊值，兩次都通過，AuditLog、版本記錄、DutyOverride 的新行都會重複。
 *   有鎖之後，第二次要等第一次寫完 `LAST_SAVED_AT` 才讀，於是回 STALE。
 * Raises:
 *   Error 如果 `payload.isoDate` 缺漏或格式不對；Error（`code:'STALE'`）
 *     如果樂觀鎖不符；Error（`code:'FIELD_CONFLICT'`）如果有欄位在載入之後
 *     已被別處改過；Error（`code:'CLIENT_OUTDATED'`）如果 payload 沒有
 *     `baseWeek`；Error（`code:'LOCK_TIMEOUT'`）如果 `SAVE_LOCK_WAIT_MS_` 之內
 *     拿不到指令碼鎖。這四種情況都**不會執行任何寫入**。
 */
function saveWeekFromWebApp_(payload) {
  if (!payload || !payload.isoDate) {
    throw new Error('saveWeekFromWebApp_：payload.isoDate 是必填欄位。');
  }
  var isoDate = payload.isoDate;
  var targetDate = normalizeDate_(isoDate);
  if (!targetDate) {
    throw new Error('saveWeekFromWebApp_：isoDate 必須是 yyyy-MM-dd 格式，收到：' + JSON.stringify(isoDate));
  }

  // ⚠️ 一定要排在**任何讀取與寫入之前**：內容表接管的七個區塊一旦出現在
  // payload，整個儲存直接拒絕，一格都不寫。見
  // `assertContentSheetFieldsNotSubmitted_()`。
  assertContentSheetFieldsNotSubmitted_(payload);

  // G23：讀取、比對、寫入全部在鎖之內。等候時間與內容表匯入、講員表格的 30 秒一致。
  // D12：經 withScriptLock_()（src/ScriptLock.gs）——同一次執行之內已經拿着鎖就不再拿、不提早放，
  // 不依賴 getScriptLock() 可不可以重入（FF-23）。
  return withScriptLock_('apiSaveWeek', SAVE_LOCK_WAIT_MS_, function () {
    return saveWeekFromWebAppLocked_(payload, isoDate, targetDate);
  }, function () {
    throw buildLockTimeoutError_(SAVE_LOCK_WAIT_MS_, '你的改動仍在畫面上，請稍等再按「儲存」。');
  });
}

/**
 * 第二批測試修正 G23：儲存等指令碼鎖最多等幾多毫秒（與 applyContentImport_()、onSpeakerFormSubmit_() 相同）。
 * D13：還原、重設、由職事表重新取數亦用這個時間。
 */
var SAVE_LOCK_WAIT_MS_ = 30000;

/**
 * 用途：第二批測試修正 G23：`saveWeekFromWebApp_()` 拿到指令碼鎖之後的那一段——讀現有
 *   工作表狀態、比對樂觀鎖、套用計畫、寫 `LAST_SAVED_AT` 與 `AuditLog`。抽成獨立函式只為了
 *   令 `try/finally` 只包住要鎖的那一段。只可以由 `saveWeekFromWebApp_()` 呼叫。
 * Args:
 *   payload {Object} 見本檔案檔頭的 payload 形狀說明（已經驗過 isoDate 與唯讀欄位）。
 *   isoDate {string} 主日日期，yyyy-MM-dd。
 *   targetDate {Date} 同一個主日的 `Date`。
 * Returns:
 *   {Object} 同 `saveWeekFromWebApp_()`。
 * Raises:
 *   Error 同 `saveWeekFromWebApp_()`（STALE、FIELD_CONFLICT、CLIENT_OUTDATED 都在任何寫入
 *     之前拋出）。
 */
function saveWeekFromWebAppLocked_(payload, isoDate, targetDate) {
  var normalizedWeek = normalizeWeekPayloadForCompare_(payload.week);
  var normalizedBaseWeek = normalizeWeekPayloadForCompare_(payload.baseWeek);

  var weekRowInfo = readBulletinWeekRowWithRowNo_(isoDate);
  var listDefs = webAppListDefs_();
  var existingLists = {};
  Object.keys(listDefs).forEach(function (type) {
    existingLists[type] = readListRowsWithRowNo_(listDefs[type].sheetName, isoDate);
  });

  var ops = buildSaveOperations_({
    currentWeek: weekRowInfo,
    // `baseWeek` 沒有出現（舊版前端）時要保持 `undefined`，讓
    // `buildSaveOperations_()` 拒絕；不可以在這裡補成空物件而被當成有。
    payload: Object.assign({}, payload, {
      week: normalizedWeek,
      baseWeek: hasBaseWeek_(payload.baseWeek) ? normalizedBaseWeek : undefined
    }),
    existingLists: existingLists
  });

  // ⚠️ 第二批階段 2：版本記錄。所有寫入之前先把三種覆寫的計畫算好，
  //    只有「這一次真的會改到該主日」才存一個版本（沒有任何改動的儲存不產生
  //    版本，與不更新 `LAST_SAVED_AT` 同一個道理）。計畫算好之後直接交給下面
  //    的套用步驟，不重算一次——算兩次就有「版本說會改、實際沒改」的機會。
  var nextDate = addDays_(targetDate, 7);
  var nextIsoDate = formatIsoDate_(nextDate);
  var dutyPlan = planDutyEditsFromPayload_(isoDate, payload.dutyEdits);
  var nextDutyPlan = planDutyEditsFromPayload_(nextIsoDate, payload.nextWeekDutyEdits);
  // 這一週還沒有資料行時（防呆補行），欄位覆寫要等補行之後才算，維持原本的做法。
  var fieldOverridePlan = weekRowInfo
    ? planFieldOverridesFromPayload_(isoDate, normalizedWeek, weekRowInfo)
    : undefined;

  var snapshotWarnings = [];
  var thisWeekWillChange = ops.weekChanges.length > 0
    || dutyOverridePlanHasChanges_(dutyPlan) || fieldOverridePlanHasChanges_(fieldOverridePlan);
  if (weekRowInfo && thisWeekWillChange) {
    var thisSnapshot = trySnapshotWeek_(isoDate, 'WEBAPP_SAVE');
    if (thisSnapshot.warning) snapshotWarnings.push(thisSnapshot.warning);
  }
  // 「下週事奉」改的是下一個主日那一筆覆寫，所以下一個主日也要有自己的版本。
  if (dutyOverridePlanHasChanges_(nextDutyPlan)) {
    var nextSnapshot = trySnapshotWeek_(nextIsoDate, 'WEBAPP_SAVE');
    if (nextSnapshot.warning) snapshotWarnings.push(nextSnapshot.warning);
  }

  var auditEntries = [];

  if (weekRowInfo) {
    applyWeekFieldChanges_(weekRowInfo.__rowNo, ops.weekChanges, isoDate, auditEntries);
  } else {
    createWeekRow_(targetDate, normalizedWeek, isoDate, auditEntries);
    weekRowInfo = readBulletinWeekRowWithRowNo_(isoDate);
  }

  // 四張清單改由內容表接管之後，`ops.listPlans` 一定是空的（見
  // `buildSaveOperations_()`）。這裡保留迴圈只是為了不讓「日後有人把清單
  // 加回來」時忘記套用計畫——現在它一格都不會寫。
  Object.keys(ops.listPlans).forEach(function (type) {
    applyListPlan_(listDefs[type].sheetName, targetDate, isoDate, type, ops.listPlans[type], auditEntries);
  });

  // 第六輪：事奉框的人手覆寫。刻意放在最後，而且獨立於上面的欄位／清單
  // 儲存——覆寫寫的是另一張表（`DutyOverride`），跟 `BulletinWeeks` 的
  // 樂觀鎖是同一次操作的一部分（所以在同一個 payload 內），但邏輯上是
  // 完全分開的一件事。
  applyDutyEditsFromPayload_(isoDate, targetDate, payload.dutyEdits, auditEntries, dutyPlan);

  // ⚠️ R-040：下週事奉的覆寫寫的是**下一個主日**那一筆記錄，不是這一週的。
  //
  //    `DutyOverride` 的鍵本來就是「主日＋崗位＋位次」，所以資料結構完全
  //    不用改——**而正因為不用改，才最容易寫錯**：如果誤用這一週的
  //    `SERVICE_DATE`，兩個畫面（這一週的「下週事奉」與下一週的「本週
  //    事奉」）各存一筆，外表完全正常，只是永遠對不上。
  //    tests/fieldoverride.test.js 有一條雙向測試專門盯住它。
  //    ⚠️ 日期**只算一次**再兩邊共用。分開算兩次的話，兩個參數可以講兩件
  //    事：第一個決定「讀邊一日的既有覆寫」，第二個決定「寫落去嗰格係邊一日」
  //    ——兩者不一致就會出現「讀 A 日、寫 B 日」，每儲存一次多一筆記錄，
  //    而外表完全正常。
  applyDutyEditsFromPayload_(nextIsoDate, nextDate,
    payload.nextWeekDutyEdits, auditEntries, nextDutyPlan);

  // ⚠️ R-043／R-045：第三種模式的欄位覆寫。與事奉覆寫同一個道理——
  //    寫的是另一張表（`FieldOverride`），但屬於同一次儲存。
  //    ⚠️ 一定要傳**寫入之前**那一行（`weekRowInfo`）。這一步排在
  //    `applyWeekFieldChanges_()` 之後，工作表那一格已經係新值——用佢做
  //    來源值就永遠相等，一筆覆寫都唔會寫得出。
  applyFieldOverridesFromPayload_(isoDate, targetDate, normalizedWeek,
    weekRowInfo || {}, auditEntries, fieldOverridePlan);

  // ⚠️ F2：完全沒有改動就不更新 `LAST_SAVED_AT`。`auditEntries` 是欄位、
  //    兩種事奉覆寫、第三種欄位覆寫共用的累積陣列，「有沒有改動」與
  //    訊息裡的數字用同一個來源（`auditEntries`）。
  //    G16：「有沒有改動」看全部條目（附帶記錄亦是寫入）；訊息裡的數字只數
  //    使用者改了的欄位，附帶記錄另外數（見 `countSaveChanges_()`）。
  var hasChanges = auditEntries.length > 0;
  var counts = countSaveChanges_(auditEntries);
  var savedToken = canonicalSaveToken_(weekRowInfo ? weekRowInfo.LAST_SAVED_AT : null);
  if (hasChanges) {
    var newTimestamp = new Date();
    writeWeekCell_(weekRowInfo.__rowNo, 'LAST_SAVED_AT', newTimestamp);
    savedToken = canonicalSaveToken_(newTimestamp);
    // G28 補充：事奉框的名字改了，顯示那些名字的另一週（本週事奉的上一週「下週事奉」、
    // 下週事奉那一週的「本週事奉」）亦要更新，否則那一週較早載入的分頁儲存會蓋回去。
    // 複審 3：這一週剛剛已經寫了，不再寫；W-7、W+7 共用一次讀取。
    var dutyDates = [];
    if (dutyPlanChangesNames_(dutyPlan)) dutyDates.push(isoDate);
    if (dutyPlanChangesNames_(nextDutyPlan)) dutyDates.push(nextIsoDate);
    touchWeeksLastSavedAt_(weeksShowingDuty_(dutyDates, [isoDate]), newTimestamp);
  }

  auditEntries.forEach(function (entry) { appendAuditLog_(entry); });

  // ⚠️ 第八輪：儲存之後一定要更新 `FillSnapshot`。
  //
  // 沒有這一步的話，下一次季度填寫表同步會看到「系統的值與快照不同」，
  // 而如果幹事同時在格子表改過另一樣東西，就會被誤判成**兩邊都改過**
  // ＝衝突——明明只是這裡儲存過一次。
  //
  // **這一點最容易漏**（填寫介面與格子表是兩個看似無關的功能），
  // tests/fillgrid.test.js 有一個測試專門盯住它。
  refreshFillSnapshotAfterSave_(isoDate, ops.weekChanges);

  return {
    lastSavedAt: savedToken,
    changedFieldCount: counts.fieldCount,
    sideRecordCount: counts.sideRecordCount,
    // 版本記錄存不到時，訊息要講出來（這次改動不能用「還原」找回），
    // 但儲存本身照樣成功。
    message: appendSnapshotWarnings_(
      buildSaveResultMessage_(counts.fieldCount, counts.sideRecordCount), snapshotWarnings)
  };
}

/**
 * 用途：G16：把一次儲存累積的 `AuditLog` 條目分成「使用者改了的欄位」與
 *   「附帶記錄」，數出完成訊息要用的兩個數字。純函式。
 *
 *   逐個動作代碼的判斷（新增動作代碼時要在這裏判斷一次，
 *   tests/webappmessages.test.js 的 G16-6 會把儲存路徑內每一個動作代碼列出來核對）：
 *     WEBAPP_SAVE_WEEK：週報欄位的一格，算一個欄位；
 *     WEBAPP_SAVE_ANNOUNCEMENTS 等四張清單：清單的一格，算一個欄位（R-011 之後
 *       儲存不再寫清單，保留只為了日後加回來時不會漏數）；
 *     DUTY_OVERRIDE_SET：事奉框（或下週事奉）的一格。同一格可以有幾筆條目
 *       （名字、覆寫時的職事表值、版本、ACTIVE），只算一個欄位；只有
 *       `ROSTER_VALUE_AT_OVERRIDE`／`ROSTER_VERSION_AT_OVERRIDE` 改了而名字沒有改，
 *       是把覆寫的對照基準更新到現在的職事表（D9 之後只在幹事對衝突格按「保留我的」時發生），
 *       畫面上的名字不變，算附帶記錄；
 *     DUTY_OVERRIDE_CLEAR：取消覆寫，畫面上那一格改回職事表的名字，算一個欄位；
 *       覆寫的名字本來就與現在的職事表相同（`displayUnchanged:true`）的話畫面不變，
 *       算附帶記錄；
 *     FIELD_OVERRIDE_SET／FIELD_OVERRIDE_CLEAR：內容表欄位的覆寫記錄。那一格本身
 *       已經由 WEBAPP_SAVE_WEEK 算了一次，算附帶記錄；
 *     其他（未知的動作代碼）：當作一個欄位。寧可多數一個，也不可以把真的寫入講成
 *       「沒有偵測到任何改動」。
 *   同一格的附帶記錄不另外再數（例如同一格事奉框名字與版本一齊改，只算一個欄位）。
 * Args:
 *   auditEntries {Object[]} 儲存時累積、準備寫入 `AuditLog` 的條目
 *     （`action`、`sheetName`、`rowKey`、`field`，事奉框取消覆寫另有
 *     `displayUnchanged`）。缺少或 `null` 當空陣列。
 * Returns:
 *   {{fieldCount:number, sideRecordCount:number}} `fieldCount` 是使用者改了幾個
 *     欄位；`sideRecordCount` 是另外更新了幾筆附帶記錄（同一筆覆寫記錄的幾個
 *     條目只算一筆）。
 * Raises:
 *   （無）
 */
function countSaveChanges_(auditEntries) {
  var fieldKeys = {};
  var sideKeys = {};
  (auditEntries || []).forEach(function (entry) {
    var e = entry || {};
    var action = String(e.action || '');
    var recordKey = String(e.sheetName || '') + '|' + String(e.rowKey || '');
    var isField;
    var key = recordKey;
    if (action === 'FIELD_OVERRIDE_SET' || action === 'FIELD_OVERRIDE_CLEAR') {
      isField = false;
    } else if (action === 'DUTY_OVERRIDE_SET') {
      isField = e.field === 'OVERRIDE_NAME' || e.field === 'ACTIVE';
    } else if (action === 'DUTY_OVERRIDE_CLEAR') {
      isField = e.displayUnchanged !== true;
    } else {
      isField = true;
      key = recordKey + '|' + String(e.field || '');
    }
    if (isField) fieldKeys[key] = true;
    else sideKeys[key] = true;
  });
  var sideRecordCount = Object.keys(sideKeys).filter(function (k) { return !fieldKeys[k]; }).length;
  return { fieldCount: Object.keys(fieldKeys).length, sideRecordCount: sideRecordCount };
}

/**
 * 用途：填寫介面儲存之後，把改動過的欄位同步到季度填寫表——**同時**
 *   刷新格子表那一格與 `FillSnapshot`，讓兩邊立即重新一致。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ⚠️ 為什麼一定要「格子表與快照一齊更新」，不可以只更新快照
 * ─────────────────────────────────────────────────────────────────────
 *
 * `FillSnapshot` 的語意是**「兩邊上一次一致時的值」**。只把快照推到系統
 * 的新值、而格子表仍然停在舊值的話，這個語意就被破壞了——下一次三方
 * 比對會看到「格子表 ≠ 快照」，於是把**根本沒有人改過的舊值**判定成
 * 「格子表改過」，然後 `PUSH` 回去，把填寫介面剛剛存好的內容蓋掉。
 *
 * 正確做法是**令兩邊真的重新一致**：把新值同時寫進格子表與快照。
 *
 * ⚠️ 但如果格子表那一格**本身有未同步的改動**（格子表現值 ≠ 快照），
 * 就**一格都不動**——那是真正的「兩邊都改過」，要留給下一次同步報成
 * 衝突由人決定，不可以在這裡靜靜蓋掉幹事在格子表打的字。
 *
 * ⚠️ 整個函式包 try/catch：同步失敗**不可以**令使用者的儲存失敗——
 * 資料已經寫進 `BulletinWeeks` 了，那才是唯一真相。最壞的後果只是下次
 * 同步多報一格衝突，由人手處理一下就好。失敗會記一筆 `ErrorLog`。
 * Args:
 *   isoDate {string} 主日日期，yyyy-MM-dd。
 *   weekChanges {{field:string, newValue:*}[]} 這次真的改動過的欄位。
 * Returns:
 *   {void}
 */
function refreshFillSnapshotAfterSave_(isoDate, weekChanges) {
  var changes = weekChanges || [];
  if (changes.length === 0) return;

  try {
    var quarterId = lookupQuarterIdForIsoDate_(isoDate);
    if (!quarterId) return;

    var gridSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(fillGridSheetName_(quarterId));
    // 格子表還未建立：沒有東西要同步，快照也沒有意義（建立格子表時會
    // 由現況重新寫一次快照）。
    if (!gridSheet) return;

    var gridRow = readFillGridRows_(quarterId)
      .filter(function (r) { return r.isoDate === isoDate; })[0];
    if (!gridRow) return;

    var snapshotIndex = buildFillSnapshotIndex_(readFillSnapshotRows_(), quarterId);

    // 只處理真的屬於格子表的欄位——填寫介面可以改的欄位比格子表多
    // （例如清單類），那些不在 `FillSnapshot` 的管轄範圍內。
    var gridKeys = {};
    fillGridEditableKeys_().forEach(function (k) { gridKeys[k] = true; });

    var entries = [];
    changes.forEach(function (change) {
      if (!gridKeys[change.field]) return;

      var key = fillSnapshotKey_(isoDate, change.field);
      var snapshotValue = Object.prototype.hasOwnProperty.call(snapshotIndex, key) ? snapshotIndex[key] : null;
      var gridValue = fillGridCellText_(gridRow.values[change.field]);

      // 格子表那一格有未同步的改動 ⇒ 真正的「兩邊都改過」，留給同步
      // 報成衝突，這裡一格都不動。
      if (snapshotValue !== null && gridValue !== snapshotValue) return;

      var newValue = fillGridCellText_(change.newValue);
      var col = fillGridColumnIndex_(change.field);
      if (col > 0) gridSheet.getRange(gridRow.rowNo, col).setValue(sanitizeCellText_(newValue));
      entries.push({ isoDate: isoDate, fieldKey: change.field, value: newValue });
    });

    if (entries.length > 0) writeFillSnapshotEntries_(quarterId, entries);
  } catch (err) {
    appendErrorLog_({
      source: ERROR_LOG_SOURCE.SERVER,
      functionName: 'refreshFillSnapshotAfterSave_',
      errorCode: (err && err.code) || 'ERROR',
      message: (err && err.message) ? err.message : String(err),
      detail: buildErrorDetail_(err, { argsSummary: 'isoDate=' + isoDate })
    });
  }
}

/**
 * 用途：組出「儲存完成」要顯示給使用者的訊息。純函式，依
 *   `changedFieldCount` 決定文案與訊息類型——分開放在這裡（而不是讓
 *   前端自己砌字串）的理由：前端沒有 Node 測試，文案分支放在 `.gs`
 *   才測得到，也才能保證「有改動」跟「沒有改動」用的是完全不同的一句話
 *   （兩者共用同一句訊息，會讓使用者以為系統壞了）。
 *
 *   G16：欄位數是 0 而附帶記錄不是 0（例如只是取消一筆已經與內容表一致的覆寫，
 *   或者把事奉框覆寫的對照基準更新到現在的職事表），工作表其實有寫入、最後儲存
 *   時間亦已更新，不可以講「沒有偵測到任何改動」，改講欄位內容沒有改變、更新了
 *   幾筆覆寫記錄。
 * Args:
 *   changedFieldCount {?number} 使用者這次改了幾個欄位（`countSaveChanges_()` 的
 *     `fieldCount`）；缺少或 `null`／`undefined` 一律當 `0` 處理，不拋錯。
 *   sideRecordCount {?number=} 另外更新了幾筆附帶記錄（`countSaveChanges_()` 的
 *     `sideRecordCount`）；缺少或 `null`／`undefined` 當 `0`。
 * Returns:
 *   {{type:('success'|'info'), text:string}} `changedFieldCount > 0` →
 *     `type:'success'`「已儲存，更新了 N 個欄位。」；欄位數是 0 而附帶記錄
 *     不是 0 → `type:'success'`「已儲存。欄位內容沒有改變，只更新了 N 筆
 *     覆寫記錄……」；兩者都是 0 → `type:'info'`。
 * Raises:
 *   （無）
 */
function buildSaveResultMessage_(changedFieldCount, sideRecordCount) {
  var n = (changedFieldCount === null || changedFieldCount === undefined) ? 0 : changedFieldCount;
  var side = (sideRecordCount === null || sideRecordCount === undefined) ? 0 : sideRecordCount;
  if (n > 0) {
    return { type: 'success', text: '已儲存，更新了 ' + n + ' 個欄位。' };
  }
  if (side > 0) {
    return {
      type: 'success',
      text: '已儲存。欄位內容沒有改變，只更新了 ' + side + ' 筆覆寫記錄'
        + '（例如取消已經與內容表或職事表相同的覆寫，或記下覆寫對照的職事表現值）。'
    };
  }
  return { type: 'info', text: '沒有偵測到任何改動，工作表沒有變更。' };
}

// =====================================================================
// IO 輔助——讀帶行號的資料列、逐格寫入
// =====================================================================

/**
 * 用途：跟 `SheetUtils.gs` 的 `readSheet()` 幾乎一樣，差別是**每個元素多
 *   一個 `__rowNo`**（工作表實際行號，從 3 開始）——`readSheet()` 刻意
 *   不回傳行號（它的呼叫方通常只需要內容），但儲存邏輯需要行號才能對
 *   指定儲存格做 `setValue()`，所以另外寫一個。
 * Args:
 *   sheetName {string} 工作表名稱。
 * Returns:
 *   {Object[]} 每個元素在 `readSheet()` 原有的欄位之上多一個 `__rowNo`。
 * Raises:
 *   Error 如果工作表不存在。
 */
function readRowsWithRowNo_(sheetName) {
  var sheetId = SHEET_ID_BY_NAME[sheetName];
  if (!sheetId) {
    throw new Error('readRowsWithRowNo_：未知的工作表名稱「' + sheetName + '」。');
  }
  var def = COLUMNS[sheetId];

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    throw new Error('readRowsWithRowNo_：找不到工作表「' + sheetName + '」，請先執行「初始化工作表」。');
  }

  var lastRow = sheet.getLastRow();
  if (lastRow < 3) return [];

  var colCount = def.keys.length;
  var values = sheet.getRange(3, 1, lastRow - 2, colCount).getValues();
  var results = [];

  for (var r = 0; r < values.length; r++) {
    var row = values[r];
    var isBlank = row.every(function (cell) { return cell === '' || cell === null; });
    if (isBlank) continue;

    var obj = { __rowNo: r + 3 };
    for (var c = 0; c < def.keys.length; c++) {
      var key = def.keys[c];
      var context = { sheet: sheetName, key: key, row: r + 3 };
      obj[key] = normalizeByType_(def.types[c], row[c], context);
    }
    results.push(obj);
  }

  return results;
}

/**
 * 用途：第二批測試修正 G28 補充：某幾個主日的事奉框覆寫改了之後，畫面上顯示這些事奉的主日：
 *   每一個主日 D 本身（「本週事奉」）與前一個主日 D-7（「下週事奉」，R-040）。純函式（日期計算
 *   除外）。結果要交給 `touchWeeksLastSavedAt_()` 更新 `LAST_SAVED_AT`。
 *
 *   ⚠️ 為甚麼要兩個：事奉框是兩方比較（送來的名字對職事表），不是三方比較。D9 之前前端每次儲存都把
 *   兩個框的全部格送上來（docs/待確認事項.md FF-17），任何一個顯示這些名字、在改動之前載入的分頁，
 *   儲存時就會把舊名字送回來、蓋走改動。D9 之後只送改過的格，沒有改那一格就不會蓋走；但那個分頁如果
 *   改了同一格，仍然是照它載入時看到的畫面做決定，所以照舊更新它的 `LAST_SAVED_AT`，令它收到 STALE、
 *   重新載入再改（沒有為簡化而拿走，見 D9 的說明）。
 * Args:
 *   dutyIsoDates {string[]} 覆寫改了的主日，yyyy-MM-dd。
 *   excludedIsoDates {string[]=} 不用列出的主日（例如呼叫方剛剛已經寫了的那一週）。
 * Returns:
 *   {string[]} 沒有重複的主日，yyyy-MM-dd。
 * Raises:
 *   （無）日期格式不對的那一項略過。
 */
function weeksShowingDuty_(dutyIsoDates, excludedIsoDates) {
  var excluded = excludedIsoDates || [];
  var out = [];
  function add(iso) {
    if (!iso || excluded.indexOf(iso) !== -1 || out.indexOf(iso) !== -1) return;
    out.push(iso);
  }
  (dutyIsoDates || []).forEach(function (iso) {
    var d = null;
    try {
      d = normalizeDate_(iso);
    } catch (err) {
      d = null;
    }
    if (!d) return;
    add(iso);
    add(formatIsoDate_(addDays_(d, -7)));
  });
  return out;
}

/**
 * 用途：第二批測試修正 G28 補充：一份事奉框覆寫計畫會不會改到畫面上的名字。純函式。
 *   新增覆寫、停用覆寫、改名字或重新啟用算；只把覆寫對照的職事表值／版本更新到現在
 *   （FF-17 那一種）不算——畫面上的名字不變，另一週的分頁送回來的名字亦一樣，不會蓋走甚麼。
 *   複審修正：停用一筆覆寫而名字本來就與現在的職事表相同（職事表追上了覆寫），畫面亦不變，
 *   不算；判斷與 G16 的 `displayUnchanged` 共用 `dutyDeactivationKeepsDisplay_()`。計畫沒有
 *   `rosterName`（重設、還原）照舊當作有改變。
 * Args:
 *   plan {?Object} `computeDutyOverridePlan_()` 形狀的計畫；`null`／`undefined` 當沒有。
 * Returns:
 *   {boolean}
 * Raises:
 *   （無）
 */
function dutyPlanChangesNames_(plan) {
  if (!plan) return false;
  if ((plan.appends || []).length > 0) return true;
  if ((plan.deactivations || []).some(function (d) { return !dutyDeactivationKeepsDisplay_(d); })) return true;
  return (plan.updates || []).some(function (u) {
    return (u.changes || []).some(function (c) { return c.field === 'OVERRIDE_NAME' || c.field === 'ACTIVE'; });
  });
}

/**
 * 用途：第二批測試修正 G28：把幾個主日的 `LAST_SAVED_AT` 改成指定時間（填寫介面的樂觀鎖
 *   以它為準）。改了會經填寫介面送回來的資料（事奉框覆寫）而又不經那一週儲存的寫入路徑，
 *   要叫這一支，否則較早載入的分頁儲存時會把那些改動蓋回去。不記 `AuditLog`（同 `writeWeekCell_()`）。
 *   複審 3：幾個主日共用一次讀取 `BulletinWeeks`；清單是空的就不讀。
 * Args:
 *   isoDates {string[]} 主日日期，yyyy-MM-dd。
 *   stamp {Date} 新的時間。
 * Returns:
 *   {number} 實際寫了幾個主日（`BulletinWeeks` 沒有那一行就略過）。
 * Raises:
 *   Error 如果 `BulletinWeeks` 工作表不存在。
 */
function touchWeeksLastSavedAt_(isoDates, stamp) {
  var wanted = isoDates || [];
  if (wanted.length === 0) return 0;
  var rows = readRowsWithRowNo_(SHEETS.BULLETIN_WEEKS);
  var written = 0;
  wanted.forEach(function (iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
    if (!m) return;
    var row = rows.filter(function (r) {
      return rosterDateMatchesYMD_(r.SERVICE_DATE, Number(m[1]), Number(m[2]), Number(m[3]));
    })[0];
    if (!row) return;
    writeWeekCell_(row.__rowNo, 'LAST_SAVED_AT', stamp);
    written++;
  });
  return written;
}

/**
 * 用途：讀 `BulletinWeeks` 指定主日的那一行（帶行號）。
 * Args:
 *   isoDate {string} 主日日期，yyyy-MM-dd。
 * Returns:
 *   {?Object} 找不到回 `null`。
 */
function readBulletinWeekRowWithRowNo_(isoDate) {
  var rows = readRowsWithRowNo_(SHEETS.BULLETIN_WEEKS);
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(isoDate || ''));
  if (!m) return null;
  var y = Number(m[1]);
  var mo = Number(m[2]);
  var d = Number(m[3]);
  var found = rows.filter(function (r) { return rosterDateMatchesYMD_(r.SERVICE_DATE, y, mo, d); });
  return found.length > 0 ? found[0] : null;
}

/**
 * 用途：讀一張「可增刪清單」工作表指定主日的全部資料列（帶行號，不篩
 *   `ACTIVE`——停用的行也要讀出來，才有辦法判斷「這個 `SEQ_NO` 已經
 *   停用過，不用再停用一次」）。
 * Args:
 *   sheetName {string} 工作表名稱。
 *   isoDate {string} 主日日期，yyyy-MM-dd。
 * Returns:
 *   {Object[]}
 */
function readListRowsWithRowNo_(sheetName, isoDate) {
  var rows = readRowsWithRowNo_(sheetName);
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(isoDate || ''));
  if (!m) return [];
  var y = Number(m[1]);
  var mo = Number(m[2]);
  var d = Number(m[3]);
  return rows.filter(function (r) { return rosterDateMatchesYMD_(r.SERVICE_DATE, y, mo, d); });
}

/**
 * 用途：把一個值轉成適合寫進 `AuditLog`（`OLD_VALUE`／`NEW_VALUE` 都是
 *   `TEXT` 型別）的文字。
 * Args:
 *   v {*}
 * Returns:
 *   {string} `Date` 轉成 `yyyy-MM-dd`；`null`／`undefined` 轉成 `''`；
 *     其餘用 `String()`。
 */
function auditValueToText_(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return formatIsoDate_(v);
  return String(v);
}

/**
 * 用途：把 `BulletinWeeks` 週欄位的異動逐格寫入工作表，並在
 *   `auditEntriesOut` 累積對應的 `AuditLog` 條目（呼叫方負責真正寫入）。
 * Args:
 *   rowNo {number} `BulletinWeeks` 該主日那一行的實際行號。
 *   changes {Object[]} `computeFieldDiff_()` 的輸出。
 *   isoDate {string} 主日日期，`AuditLog.ROW_KEY` 用。
 *   auditEntriesOut {Object[]} 累積用的陣列，這個函式會往裡面 push。
 *   action {string=} AuditLog 的動作代碼；省略就是 `WEBAPP_SAVE_WEEK`。
 *     還原與重設共用這一支寫入，各自用自己的代碼（`WEEK_RESTORE`／`WEEK_RESET`）。
 * Returns:
 *   {void}
 */
function applyWeekFieldChanges_(rowNo, changes, isoDate, auditEntriesOut, action) {
  if (!changes || changes.length === 0) return;
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.BULLETIN_WEEKS);
  var keys = COLUMNS.BULLETIN_WEEKS.keys;

  changes.forEach(function (c) {
    if (keys.indexOf(c.field) < 0) return;
    // ⚠️ 經 setCellValueTextSafe_()：ATT_* 十二欄設計上是文字，直接寫會被
    //    試算表轉成數字。見 docs/已知bug類型.md 事故二十八。
    setCellValueTextSafe_(sheet, COLUMNS.BULLETIN_WEEKS, rowNo, c.field,
      c.newValue === null || c.newValue === undefined ? '' : c.newValue);
    auditEntriesOut.push({
      action: action || 'WEBAPP_SAVE_WEEK', sheetName: SHEETS.BULLETIN_WEEKS, rowKey: isoDate,
      field: c.field, oldValue: auditValueToText_(c.oldValue), newValue: auditValueToText_(c.newValue)
    });
  });
}

/**
 * 用途：`BulletinWeeks` 完全沒有這個主日那一行時，補一行新的——正常
 *   狀況下應該先用選單「建立本季空白週報」建好骨架，這裡是防呆，不讓
 *   儲存動作因為缺一行骨架就整個失敗。
 * Args:
 *   targetDate {Date} 主日日期。
 *   normalizedWeek {Object} `normalizeWeekPayloadForCompare_()` 的輸出。
 *   isoDate {string} 主日日期，yyyy-MM-dd，`AuditLog.ROW_KEY` 用。
 *   auditEntriesOut {Object[]} 累積用的陣列。
 * Returns:
 *   {void}
 */
function createWeekRow_(targetDate, normalizedWeek, isoDate, auditEntriesOut) {
  var row = { SERVICE_DATE: targetDate, STATUS: BULLETIN_WEEK_STATUS.DRAFT };

  webAppWeekFieldKeys_().forEach(function (key) {
    var v = normalizedWeek[key];
    row[key] = (v === null || v === undefined) ? '' : v;
    if (v !== null && v !== undefined && String(v) !== '') {
      auditEntriesOut.push({
        action: 'WEBAPP_SAVE_WEEK', sheetName: SHEETS.BULLETIN_WEEKS, rowKey: isoDate,
        field: key, oldValue: '', newValue: auditValueToText_(v)
      });
    }
  });

  writeSheet(SHEETS.BULLETIN_WEEKS, [row]);
}

/**
 * 用途：把 `LAST_SAVED_AT` 寫入 `BulletinWeeks` 指定行。刻意**不**記
 *   `AuditLog`——這一格每次儲存都會變，逐次記錄只會淹沒真正有意義的
 *   欄位異動。
 * Args:
 *   rowNo {number} 行號。
 *   fieldKey {string} `BulletinWeeks` 機器鍵。
 *   value {*} 新值。
 * Returns:
 *   {void}
 */
function writeWeekCell_(rowNo, fieldKey, value) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.BULLETIN_WEEKS);
  // ⚠️ 經 setCellValueTextSafe_()，見 docs/已知bug類型.md 事故二十八。
  setCellValueTextSafe_(sheet, COLUMNS.BULLETIN_WEEKS, rowNo, fieldKey, value);
}

/**
 * 用途：把一張「可增刪清單」工作表的 upsert 計畫套用到工作表：逐格更新
 *   修改的行、把停用的行 `ACTIVE` 改成 `FALSE`、附加新增的行；同步在
 *   `auditEntriesOut` 累積對應的 `AuditLog` 條目。
 * Args:
 *   sheetName {string} 工作表名稱。
 *   targetDate {Date} 主日日期（新增行要用）。
 *   isoDate {string} 主日日期，yyyy-MM-dd（`AuditLog.ROW_KEY` 用）。
 *   listType {string} 清單名稱（例如 `'announcements'`），只用來組
 *     `AuditLog.ACTION`。
 *   plan {Object} `computeListUpsertPlan_()` 的輸出。
 *   auditEntriesOut {Object[]} 累積用的陣列。
 * Returns:
 *   {void}
 */
function applyListPlan_(sheetName, targetDate, isoDate, listType, plan, auditEntriesOut) {
  if (!plan) return;
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
  var def = COLUMNS[SHEET_ID_BY_NAME[sheetName]];
  var action = 'WEBAPP_SAVE_' + listType.toUpperCase();

  plan.updates.forEach(function (u) {
    u.changes.forEach(function (c) {
      if (def.keys.indexOf(c.field) < 0) return;
      // ⚠️ 經 setCellValueTextSafe_()：Finance 的 COL_*、Fellowships 的
      //    MEETING_DATE／MEETING_TIME 設計上是文字。見事故二十八。
      setCellValueTextSafe_(sheet, def, u.rowNo, c.field,
        c.newValue === null || c.newValue === undefined ? '' : c.newValue);
      auditEntriesOut.push({
        action: action, sheetName: sheetName, rowKey: isoDate + '#' + u.seqNoOld,
        field: c.field, oldValue: auditValueToText_(c.oldValue), newValue: auditValueToText_(c.newValue)
      });
    });
  });

  plan.deactivations.forEach(function (deact) {
    sheet.getRange(deact.rowNo, def.keys.indexOf('ACTIVE') + 1).setValue(false);
    auditEntriesOut.push({
      action: action, sheetName: sheetName, rowKey: isoDate + '#' + deact.seqNoOld,
      field: 'ACTIVE', oldValue: 'TRUE', newValue: 'FALSE'
    });
  });

  if (plan.appends.length > 0) {
    var rows = plan.appends.map(function (row) {
      var full = { SERVICE_DATE: targetDate, ACTIVE: true };
      Object.keys(row).forEach(function (k) { full[k] = row[k]; });
      return full;
    });
    writeSheet(sheetName, rows);

    plan.appends.forEach(function (row) {
      Object.keys(row).forEach(function (field) {
        if (field === 'SEQ_NO') return;
        var v = row[field];
        if (v === null || v === undefined || String(v) === '') return;
        auditEntriesOut.push({
          action: action, sheetName: sheetName, rowKey: isoDate + '#' + row.SEQ_NO,
          field: field, oldValue: '', newValue: auditValueToText_(v)
        });
      });
    });
  }
}

/**
 * 用途：把 payload 內第三種模式那幾欄的值，套用到 `FieldOverride`。
 *
 *   ⚠️ **比較的對象是「內容表帶入的值」，不是「工作表現值」。**
 *   工作表現值本身可能已經是一個覆寫值——拿它去比，改一次之後就永遠
 *   算「沒有改動」，覆寫記錄再也不會更新。
 *
 *   內容表帶入的值 = 覆寫**之前**的 `BulletinWeeks` 那一格，也就是
 *   `readSheet()` 讀出來、**未經** `applyFieldOverrides_()` 那一份。
 * Args:
 *   isoDate {string} 主日日期。
 *   targetDate {Date} 主日日期。
 *   normalizedWeek {Object} 這一次儲存要寫入的欄位值。
 *   weekBeforeSave {Object} **寫入之前**的 `BulletinWeeks` 那一行。
 *   auditEntriesOut {Object[]} 累積用的陣列。
 *   plan {?Object=} 已經由 `planFieldOverridesFromPayload_()` 算好的計畫；
 *     省略（`undefined`）就在這裏算；`null` 代表沒有東西要寫。
 * Returns:
 *   {void}
 */
function applyFieldOverridesFromPayload_(isoDate, targetDate, normalizedWeek, weekBeforeSave, auditEntriesOut, plan) {
  var effective = plan === undefined
    ? planFieldOverridesFromPayload_(isoDate, normalizedWeek, weekBeforeSave)
    : plan;
  if (!effective) return;
  applyFieldOverridePlan_(effective, targetDate, isoDate, getCallerEmail_(), auditEntriesOut);
}

/**
 * 用途：算出 payload 內第三種模式那幾欄要對 `FieldOverride` 做什麼（唯讀，
 *   不寫任何一格）。規則與注意事項見 `applyFieldOverridesFromPayload_()` 上面
 *   那一大段說明——計算與套用分開，是為了讓儲存可以在寫入之前就知道「這一次
 *   會不會動到這個主日」（版本記錄）。
 * Args:
 *   isoDate {string} 主日日期。
 *   normalizedWeek {Object} 這一次儲存要寫入的欄位值。
 *   weekBeforeSave {Object} 寫入之前的 `BulletinWeeks` 那一行。
 * Returns:
 *   {?Object} `computeFieldOverridePlan_()` 的輸出；payload 完全沒有帶第三種
 *     模式的欄位時回 `null`。
 */
function planFieldOverridesFromPayload_(isoDate, normalizedWeek, weekBeforeSave) {
  var draft = {};
  var touched = false;
  CONTENT_SHEET_OVERRIDABLE_FIELDS.forEach(function (key) {
    if (!(key in (normalizedWeek || {}))) return;
    draft[key] = normalizedWeek[key];
    touched = true;
  });
  if (!touched) return null;

  // ⚠️ 「來源值」＝內容表帶入嗰個值，**唔係** BulletinWeeks 現值。
  //    現值有機會已經係上一次嘅覆寫值（介面同格子表都會寫落去），
  //    拿佢去比就永遠相等，覆寫記錄從此唔會再更新。
  //
  //    所以：有覆寫就用 `SOURCE_VALUE_AT_OVERRIDE`（覆寫嗰陣記低嘅來源值），
  //    冇覆寫先用現值。同 `DutyOverride` 用 `ROSTER_VALUE_AT_OVERRIDE`
  //    完全一樣。
  var overrideIndex = readFieldOverrideIndexForDate_(isoDate);
  var before = weekBeforeSave || {};
  var sourceValues = {};
  CONTENT_SHEET_OVERRIDABLE_FIELDS.forEach(function (key) {
    var existing = overrideIndex[fieldOverrideKey_(isoDate, key)];
    sourceValues[key] = existing ? existing.SOURCE_VALUE_AT_OVERRIDE : before[key];
  });

  return computeFieldOverridePlan_(draft, sourceValues, overrideIndex, isoDate);
}

/**
 * 用途：把 payload 內的事奉框編輯（`dutyEdits`）套用到 `DutyOverride`
 *   工作表。真正的規則在 `src/DutyOverride.gs` 的
 *   `computeDutyOverridePlan_()`（純函式）與 `applyDutyOverridePlan_()`
 *   （IO），這裡只負責把「現在的職事表值」與「現有的覆寫行」讀出來
 *   餵給它們。
 *
 *   ⚠️ **只寫週報自己的 `DutyOverride` 工作表，一格職事表都不會寫**——
 *   `readRosterSnapshot_()` 是唯讀的（見 src/RosterRead.gs 與
 *   tools/lint-readonly-roster.js）。
 *
 *   `dutyEdits` 缺漏或是空陣列代表「這次沒有改任何一格」，不是「全部被清空」：沒有送來的格一律不動，
 *   只會自動停用職事表已經追上的覆寫（D9，見 `computeDutyOverridePlan_()`）。
 * Args:
 *   isoDate {string} 主日日期，yyyy-MM-dd。
 *   targetDate {Date} 同一個主日日期的 `Date` 形式（新增行要用）。
 *   dutyEdits {Object[]} 見本檔案檔頭的 payload 形狀說明。
 *   auditEntriesOut {Object[]} 累積 `AuditLog` 條目用的陣列。
 *   plan {?Object=} 已經由 `planDutyEditsFromPayload_()` 算好的計畫；省略
 *     （`undefined`）就在這裏算；`null` 代表沒有東西要寫。
 * Returns:
 *   {void}
 * Raises:
 *   Error 如果 `DutyOverride` 工作表不存在（`applyDutyOverridePlan_()`
 *     原樣拋出——有東西要寫卻沒有表可以寫，是必須講出來的結構問題）。
 */
function applyDutyEditsFromPayload_(isoDate, targetDate, dutyEdits, auditEntriesOut, plan) {
  var effective = plan === undefined ? planDutyEditsFromPayload_(isoDate, dutyEdits) : plan;
  if (!effective) return;
  applyDutyOverridePlan_(effective, targetDate, isoDate, getCallerEmail_(), auditEntriesOut);
}

/**
 * 用途：算出一批事奉框編輯要對 `DutyOverride` 做什麼（唯讀，不寫任何一格）。
 *   計算與套用分開，是為了讓儲存可以在寫入之前就知道「這一次會不會動到這個
 *   主日」（版本記錄）。
 *
 *   D9：`dutyEdits` 是空的也照樣檢查這一週生效中的覆寫（職事表追上了就自動停用）；這一週連一筆生效中的
 *   覆寫都沒有、又沒有改任何一格，就不讀職事表，回 `null`。先用不拋錯的 `readDutyOverrideRows_()` 看
 *   有沒有生效中的覆寫：沒有改任何一格時，`DutyOverride` 工作表不存在不應令儲存失敗（與以前一樣）。
 * Args:
 *   isoDate {string} 主日日期，yyyy-MM-dd。
 *   dutyEdits {Object[]} 見本檔案檔頭的 payload 形狀說明。
 * Returns:
 *   {?Object} `computeDutyOverridePlan_()` 的輸出；沒有任何東西要看時回 `null`
 *     （缺漏或空陣列不可以當成「全部被清空」）。
 * Raises:
 *   Error 有改格（或有生效中的覆寫）而 `DutyOverride` 工作表不存在（`readRowsWithRowNo_()` 原樣拋出）。
 */
function planDutyEditsFromPayload_(isoDate, dutyEdits) {
  if (!isoDate) return null;
  var edits = Array.isArray(dutyEdits) ? dutyEdits : [];
  if (edits.length === 0) {
    var anyActive = readDutyOverrideRows_(isoDate).some(function (r) { return r.ACTIVE === true; });
    if (!anyActive) return null;
  }

  var snapshot = readRosterSnapshot_(isoDate);
  return computeDutyOverridePlan_({
    edits: edits,
    existingRows: readDutyOverrideRowsWithRowNo_(isoDate),
    rosterNameByKey: buildRosterNameByKey_(snapshot.slotsByPost),
    rosterVersion: snapshot.versionNo
  });
}
