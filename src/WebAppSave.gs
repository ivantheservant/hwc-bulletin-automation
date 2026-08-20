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
 *   week: {                            // BulletinWeeks 可編輯欄位，見 webAppWeekFieldKeys_()
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
 *   finance:       [{ seqNo:(number|null), ROW_LABEL, COL_SPECIAL_OVERSEAS, COL_HARDSHIP }, ...]
 * }
 * ```
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
  ];
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
 * 用途：整份儲存請求的純函式層。先做樂觀鎖檢查（不符直接拋錯，一個格
 *   都不會算進後面的計畫），再算出週欄位的異動與四張清單的 upsert 計畫。
 * Args:
 *   input {{currentWeek:(Object|null), payload:Object, existingLists:Object}}
 *     `currentWeek` 是目前 `BulletinWeeks` 該主日那一行（帶 `__rowNo`），
 *     沒有該行時傳 `null`；`payload` 見檔頭的 payload 形狀說明，其中
 *     `payload.week` 必須是**已經正規化過**的值（`DATE` 型別欄位已經是
 *     `Date` 或 `null`，見 `normalizeWeekPayloadForCompare_()`）；
 *     `existingLists` 是四個清單目前的資料列（`{announcements, prayers,
 *     fellowships, finance}`，每個元素帶 `__rowNo`）。
 * Returns:
 *   {{weekChanges:Object[], listPlans:Object<string,Object>}}
 * Raises:
 *   Error（`code:'STALE'`）如果樂觀鎖不符。訊息**同時包含兩個時間**
 *     （工作表上目前的最後儲存時間、payload 帶來的載入時版本時間），
 *     不再只講一句「有人改過」卻不講是什麼時候——真正 STALE 時，這兩個
 *     時間點對使用者判斷「要不要覆蓋」是必要資訊。
 */
function buildSaveOperations_(input) {
  var payload = input.payload || {};
  var currentWeek = input.currentWeek || null;

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

  var weekChanges = computeFieldDiff_(currentWeek || {}, payload.week || {}, webAppWeekFieldKeys_());

  var listDefs = webAppListDefs_();
  var listPlans = {};
  Object.keys(listDefs).forEach(function (type) {
    listPlans[type] = computeListUpsertPlan_(
      (input.existingLists && input.existingLists[type]) || [],
      payload[type] || [],
      listDefs[type].fieldKeys
    );
  });

  return { weekChanges: weekChanges, listPlans: listPlans };
}

/**
 * 用途：把前端送來的 `payload.week` 正規化成可以拿去跟工作表現有值比較
 *   的形狀——`BulletinWeeks` 型別是 `DATE` 的欄位（目前只有
 *   `ATTENDANCE_DATE`）轉成 `Date`／`null`，其餘欄位缺少的一律補成 `''`。
 *   分離出這個函式，是因為前端經 `google.script.run` 傳回來的日期通常是
 *   `yyyy-MM-dd` 文字，而工作表讀出來的是 `Date` 物件——`fieldsEqual_()`
 *   對 `Date` 有專門的比較邏輯，兩邊型別要先對齊才比得出「真的有沒有變」。
 * Args:
 *   rawWeek {Object} `payload.week`。
 * Returns:
 *   {Object} 只含 `webAppWeekFieldKeys_()` 列出的欄位。
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
// 真正入口
// =====================================================================

/**
 * 用途：`apiSaveWeek()` 的真正入口。讀現有工作表狀態、呼叫純函式層算出
 *   異動計畫、把計畫套用到 `BulletinWeeks`／四張清單／`AuditLog`。
 *
 *   樂觀鎖不符時（`buildSaveOperations_()` 拋錯）**不會執行任何寫入**——
 *   拋錯發生在讀完現有狀態、套用計畫之前。
 * Args:
 *   payload {Object} 見本檔案檔頭的 payload 形狀說明。
 * Returns:
 *   {{lastSavedAt:string, changedFieldCount:number}} `lastSavedAt` 是
 *     `canonicalSaveToken_()` 正規化過的字串（不是 `Date`）——前端拿到
 *     什麼就原樣存起來、下次儲存原樣送回即可，不需要自己再處理任何
 *     日期／時區轉換。`changedFieldCount` 保證等於這次實際寫入
 *     `AuditLog` 的筆數（同一個真相來源：兩者都是 `auditEntries.length`）。
 * Raises:
 *   Error 如果 `payload.isoDate` 缺漏或格式不對；Error（`code:'STALE'`）
 *     如果樂觀鎖不符，此時**不會執行任何寫入**。
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

  var normalizedWeek = normalizeWeekPayloadForCompare_(payload.week);

  var weekRowInfo = readBulletinWeekRowWithRowNo_(isoDate);
  var listDefs = webAppListDefs_();
  var existingLists = {};
  Object.keys(listDefs).forEach(function (type) {
    existingLists[type] = readListRowsWithRowNo_(listDefs[type].sheetName, isoDate);
  });

  var ops = buildSaveOperations_({
    currentWeek: weekRowInfo,
    payload: Object.assign({}, payload, { week: normalizedWeek }),
    existingLists: existingLists
  });

  var auditEntries = [];

  if (weekRowInfo) {
    applyWeekFieldChanges_(weekRowInfo.__rowNo, ops.weekChanges, isoDate, auditEntries);
  } else {
    createWeekRow_(targetDate, normalizedWeek, isoDate, auditEntries);
    weekRowInfo = readBulletinWeekRowWithRowNo_(isoDate);
  }

  Object.keys(listDefs).forEach(function (type) {
    applyListPlan_(listDefs[type].sheetName, targetDate, isoDate, type, ops.listPlans[type], auditEntries);
  });

  var newTimestamp = new Date();
  writeWeekCell_(weekRowInfo.__rowNo, 'LAST_SAVED_AT', newTimestamp);

  auditEntries.forEach(function (entry) { appendAuditLog_(entry); });

  return { lastSavedAt: canonicalSaveToken_(newTimestamp), changedFieldCount: auditEntries.length };
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
 * Returns:
 *   {void}
 */
function applyWeekFieldChanges_(rowNo, changes, isoDate, auditEntriesOut) {
  if (!changes || changes.length === 0) return;
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.BULLETIN_WEEKS);
  var keys = COLUMNS.BULLETIN_WEEKS.keys;

  changes.forEach(function (c) {
    var colIndex = keys.indexOf(c.field) + 1;
    if (colIndex <= 0) return;
    sheet.getRange(rowNo, colIndex).setValue(c.newValue === null || c.newValue === undefined ? '' : c.newValue);
    auditEntriesOut.push({
      action: 'WEBAPP_SAVE_WEEK', sheetName: SHEETS.BULLETIN_WEEKS, rowKey: isoDate,
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
  var colIndex = COLUMNS.BULLETIN_WEEKS.keys.indexOf(fieldKey) + 1;
  sheet.getRange(rowNo, colIndex).setValue(value);
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
      var colIndex = def.keys.indexOf(c.field) + 1;
      if (colIndex <= 0) return;
      sheet.getRange(u.rowNo, colIndex).setValue(c.newValue === null || c.newValue === undefined ? '' : c.newValue);
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
