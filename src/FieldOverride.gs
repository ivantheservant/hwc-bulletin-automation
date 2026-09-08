/**
 * FieldOverride.gs
 *
 * **第三種欄位模式**（R-043／R-045）：**內容表為來源，介面可覆寫**。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 三種模式，分清楚
 * ─────────────────────────────────────────────────────────────────────
 *
 *   | 模式 | 例子 | 介面 | 清單 |
 *   |---|---|---|---|
 *   | 介面填 | 講題、序樂 | 可編輯 | （其餘全部） |
 *   | 內容表接管 | 宣召、十二個人數欄 | **唯讀** | `CONTENT_SHEET_READONLY_FIELDS.WEEK` |
 *   | **內容表為來源，可覆寫** | 讀經經文、證道講題、回應詩歌、詩班曲名、浸禮六欄 | 可編輯 | `CONTENT_SHEET_OVERRIDABLE_FIELDS` |
 *
 * ─────────────────────────────────────────────────────────────────────
 * 核心原則（照抄 src/DutyOverride.gs，一條都沒有改）
 * ─────────────────────────────────────────────────────────────────────
 *
 * 1. 覆寫**只存週報**，不寫任何外部系統。
 * 2. **沒有覆寫的欄位，每次匯入自動跟隨內容表最新值。**
 * 3. **有覆寫的欄位，匯入不會蓋過去**，只在差異報告標 `CONFLICT`。
 * 4. 一切分歧**只提醒，不自動修正任何一邊**。
 * 5. 放棄覆寫是把 `ACTIVE` 改 `FALSE`，**不刪行**，記錄保留。
 *
 * ⚠️ 取值次序**固定**：`BulletinWeeks` 現值 ← 內容表匯入 → 套用
 * `FieldOverride`。不可以調轉，而且**只可以有一個地方**決定最終值——
 * 那一個地方就是 `applyFieldOverrides_()`。匯入那邊套一次、載入那邊又
 * 套一次的話，兩處遲早會不一致，而不一致那一刻沒有人會發現
 * （見 docs/已知bug類型.md 事故三）。
 */

'use strict';

/**
 * 用途：把 `SERVICE_DATE` 那一格轉成 `yyyy-MM-dd`。**純函式。**
 *
 *   ⚠️ 要同時食得落 `Date` 與字串：`readSheet()` 多數回 `Date`，但工作表
 *   那一格如果被人手打成文字就會係字串。`formatIsoDate_()` 只食 `Date`，
 *   直接餵字串會拋 `d.getFullYear is not a function`——而拋喺呢度就等於
 *   整個載入死掉。
 *
 *   ⚠️ 認唔到就回**空字串**，唔係今日：一個睇落合理但其實係假嘅日期，
 *   會令覆寫套落錯嘅主日。
 * Args:
 *   value {*}
 * Returns:
 *   {string} 認唔到回空字串。
 */
function fieldOverrideIsoOf_(value) {
  if (Object.prototype.toString.call(value) === '[object Date]') return formatIsoDate_(value);
  var text = String(value === null || value === undefined ? '' : value).trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : '';
}

/**
 * 用途：組出「主日＋欄位鍵」的唯一鍵。**純函式。**
 *
 *   ⚠️ 與 `dutyOverrideKey_()` 刻意不同形狀（那邊是 `CHAIR#1`）：兩張表
 *   的鍵不可以長得一樣，否則有人一眼看落去會以為兩者可以互換。
 * Args:
 *   isoDate {string} 主日日期，yyyy-MM-dd。
 *   fieldKey {string} `BulletinWeeks` 的機器鍵。
 * Returns:
 *   {string} 例如 `'2027-10-03|SERMON_TITLE'`。
 */
function fieldOverrideKey_(isoDate, fieldKey) {
  return String(isoDate || '') + '|' + String(fieldKey || '');
}

/**
 * 用途：把 `FieldOverride` 資料列組成索引，**只收 `ACTIVE=TRUE` 的行**。
 *   **純函式。**
 * Args:
 *   overrideRows {Object[]} `FieldOverride` 的全部資料列。
 * Returns:
 *   {Object<string,Object>} 同一個鍵有多行時保留**第一行**。
 */
function buildFieldOverrideIndex_(overrideRows) {
  var index = {};
  (overrideRows || []).forEach(function (row) {
    if (row.ACTIVE !== true) return;
    var key = fieldOverrideKey_(fieldOverrideIsoOf_(row.SERVICE_DATE), row.FIELD_KEY);
    if (!(key in index)) index[key] = row;
  });
  return index;
}

/**
 * 用途：**唯一的取值出口**——把覆寫套到一個主日的欄位值上。**純函式。**
 *
 *   ⚠️ 系統之內**只可以有這一支**決定第三種模式欄位的最終值。
 *   加第二個地方套一次，就等於加了第二個真相來源。
 * Args:
 *   weekValues {Object} `BulletinWeeks` 那一行（已經經過內容表匯入）。
 *   isoDate {string} 主日日期。
 *   overrideIndex {Object} `buildFieldOverrideIndex_()` 的輸出。
 * Returns:
 *   {Object} 一個**新物件**（不改動傳進來那個），第三種模式的欄位已經
 *     套用覆寫值。沒有覆寫的欄位原樣保留。
 */
function applyFieldOverrides_(weekValues, isoDate, overrideIndex) {
  var out = {};
  Object.keys(weekValues || {}).forEach(function (k) { out[k] = weekValues[k]; });

  var index = overrideIndex || {};
  CONTENT_SHEET_OVERRIDABLE_FIELDS.forEach(function (fieldKey) {
    var row = index[fieldOverrideKey_(isoDate, fieldKey)];
    if (!row) return;
    out[fieldKey] = row.OVERRIDE_VALUE;
  });
  return out;
}

/**
 * 用途：讀出某一個主日**生效中**的覆寫索引。
 *
 *   ⚠️ 工作表不存在（未跑過「初始化工作表」）時回**空索引**，與
 *   `readDutyOverrideRows_()` 一致——顯示與產生週報那條路不可以因為
 *   一張新表未建立而整條死掉。
 *
 *   ⚠️ **匯入那條路刻意不用這一支**（見 `previewContentImport_()` 直接
 *   `readSheet(SHEETS.FIELD_OVERRIDE)`）：讀不到覆寫而照樣匯入，等於把
 *   幹事改過的值靜靜蓋走。讀的路可以容忍，**寫的路一定要拋錯**。
 * Args:
 *   isoDate {string} 主日日期。
 * Returns:
 *   {Object<string,Object>}
 */
function readFieldOverrideIndexForDate_(isoDate) {
  var iso = String(isoDate || '').trim();
  var all;
  try {
    // ⚠️ 帶 `__rowNo`：停用一筆覆寫時要改返原本那一行，冇行號就寫錯地方。
    all = readRowsWithRowNo_(SHEETS.FIELD_OVERRIDE);
  } catch (err) {
    return {};
  }
  return buildFieldOverrideIndex_(all.filter(function (r) {
    return fieldOverrideIsoOf_(r.SERVICE_DATE) === iso;
  }));
}

/**
 * 用途：算出「要寫哪幾筆覆寫」。**純函式**，方便直接測。
 *
 *   ⚠️ 三種情況要分清楚：
 *     - 新值與內容表現值**相同** → 不需要覆寫；本來有覆寫的要**停用**
 *       （否則那一格會從此不再跟隨內容表，而幹事以為它會）；
 *     - 新值與內容表現值**不同** → upsert 一筆覆寫；
 *     - 本來就沒有覆寫、而且沒有改動 → 什麼都不做。
 * Args:
 *   draftValues {Object} 介面送上來的欄位值（機器鍵 → 值）。
 *   sourceValues {Object} 內容表帶入的現值（機器鍵 → 值）。
 *   overrideIndex {Object} 目前生效的覆寫索引。
 *   isoDate {string} 主日日期。
 * Returns:
 *   {{upserts:Object[], deactivations:Object[], unchanged:number}}
 *     `upserts` 每個元素 `{fieldKey, overrideValue, sourceValue}`；
 *     `deactivations` 每個元素 `{fieldKey, row}`。
 */
function computeFieldOverridePlan_(draftValues, sourceValues, overrideIndex, isoDate) {
  var plan = { upserts: [], deactivations: [], unchanged: 0 };
  var index = overrideIndex || {};
  var draft = draftValues || {};
  var source = sourceValues || {};

  CONTENT_SHEET_OVERRIDABLE_FIELDS.forEach(function (fieldKey) {
    if (!(fieldKey in draft)) return;

    var newValue = fieldOverrideNormalize_(draft[fieldKey]);
    var sourceValue = fieldOverrideNormalize_(source[fieldKey]);
    var existing = index[fieldOverrideKey_(isoDate, fieldKey)];

    if (newValue === sourceValue) {
      // 改返同內容表一樣 → 放棄覆寫，重新跟隨內容表。
      if (existing) plan.deactivations.push({ fieldKey: fieldKey, row: existing });
      else plan.unchanged++;
      return;
    }

    if (existing && fieldOverrideNormalize_(existing.OVERRIDE_VALUE) === newValue) {
      plan.unchanged++;
      return;
    }

    plan.upserts.push({ fieldKey: fieldKey, overrideValue: newValue, sourceValue: sourceValue });
  });

  return plan;
}

/**
 * 用途：比對用的正規化——`null`／`undefined` 當空字串，兩端空白剪走。
 *   **純函式。**
 *
 *   ⚠️ **不做任何其他轉換**：不轉大小寫、不轉全半形、不把數字轉型。
 *   幹事打的每一個字都是要印出來的，「看起來一樣」不等於一樣。
 * Args:
 *   value {*}
 * Returns:
 *   {string}
 */
function fieldOverrideNormalize_(value) {
  return String(value === null || value === undefined ? '' : value).trim();
}

/**
 * 用途：把一批覆寫寫入 `FieldOverride`（upsert，**不刪行**）。
 *
 *   ⚠️ 寫法照抄 `applyDutyOverridePlan_()`：逐格 `setValue()` 改既有行、
 *   新行才 `writeSheet()`。稽核記錄由呼叫方統一寫出去（累積在
 *   `auditEntriesOut`），與事奉覆寫同一條路。
 * Args:
 *   plan {Object} `computeFieldOverridePlan_()` 的輸出。
 *   targetDate {Date} 主日日期（新增行要用）。
 *   isoDate {string} 主日日期 yyyy-MM-dd。
 *   actorEmail {string} 覆寫者電郵。
 *   auditEntriesOut {Object[]} 累積用的陣列。
 * Returns:
 *   {{upserted:number, deactivated:number}}
 */
function applyFieldOverridePlan_(plan, targetDate, isoDate, actorEmail, auditEntriesOut) {
  if (!plan) return { upserted: 0, deactivated: 0 };
  var upserts = plan.upserts || [];
  var deactivations = plan.deactivations || [];
  if (upserts.length === 0 && deactivations.length === 0) return { upserted: 0, deactivated: 0 };

  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.FIELD_OVERRIDE);
  if (!sheet) {
    throw new Error('applyFieldOverridePlan_：找不到工作表「' + SHEETS.FIELD_OVERRIDE
      + '」，請先執行「初始化工作表」。');
  }
  var def = COLUMNS.FIELD_OVERRIDE;
  var now = new Date();
  var audit = auditEntriesOut || [];

  // 既有行的索引：同一個主日＋欄位鍵只可以有一行（包括已停用那些——
  // 停用之後再覆寫，應該改返原本那一行，不是再開一行）。
  //
  // ⚠️ 一定要用 `readRowsWithRowNo_()`，**不可以**用 `readSheet()`：
  //    後者不帶 `__rowNo`，`setCell()` 就會寫去 `undefined` 那一行——
  //    而假替身與真 Apps Script 的報錯完全不同樣，很難查。
  var existingByKey = {};
  readRowsWithRowNo_(SHEETS.FIELD_OVERRIDE).forEach(function (r) {
    if (fieldOverrideIsoOf_(r.SERVICE_DATE) !== isoDate) return;
    var k = String(r.FIELD_KEY || '');
    if (!(k in existingByKey)) existingByKey[k] = r;
  });

  function setCell(rowNo, fieldKey, value) {
    var colIndex = def.keys.indexOf(fieldKey) + 1;
    if (colIndex <= 0) return;
    sheet.getRange(rowNo, colIndex).setValue(value === null || value === undefined ? '' : value);
  }

  var appends = [];
  upserts.forEach(function (u) {
    var existing = existingByKey[u.fieldKey];
    if (existing) {
      setCell(existing.__rowNo, 'OVERRIDE_VALUE', sanitizeCellText_(u.overrideValue));
      setCell(existing.__rowNo, 'SOURCE_VALUE_AT_OVERRIDE', sanitizeCellText_(u.sourceValue));
      setCell(existing.__rowNo, 'OVERRIDE_AT', now);
      setCell(existing.__rowNo, 'OVERRIDE_BY', sanitizeCellText_(actorEmail));
      setCell(existing.__rowNo, 'ACTIVE', true);
    } else {
      appends.push({
        SERVICE_DATE: targetDate,
        FIELD_KEY: u.fieldKey,
        OVERRIDE_VALUE: sanitizeCellText_(u.overrideValue),
        SOURCE_VALUE_AT_OVERRIDE: sanitizeCellText_(u.sourceValue),
        OVERRIDE_AT: now,
        OVERRIDE_BY: sanitizeCellText_(actorEmail),
        REASON: '',
        ACTIVE: true,
        NOTES: '由填寫介面覆寫；內容表匯入不會蓋過這一格。'
      });
    }
    audit.push({
      action: 'FIELD_OVERRIDE_SET', sheetName: SHEETS.FIELD_OVERRIDE,
      rowKey: isoDate + '#' + u.fieldKey, field: u.fieldKey,
      oldValue: u.sourceValue, newValue: u.overrideValue,
      notes: '覆寫當時內容表的值是「' + (u.sourceValue || '（空白）') + '」；'
        + '此後匯入不會蓋過這一格。'
    });
  });

  // ⚠️ 放棄覆寫**不刪行**，只改 ACTIVE。記錄要留——日後查「這一格點解
  //    同內容表唔同」的時候，一行已停用的覆寫講得出曾經發生過什麼。
  deactivations.forEach(function (d) {
    setCell(d.row.__rowNo, 'ACTIVE', false);
    audit.push({
      action: 'FIELD_OVERRIDE_CLEAR', sheetName: SHEETS.FIELD_OVERRIDE,
      rowKey: isoDate + '#' + d.fieldKey, field: 'ACTIVE',
      oldValue: 'TRUE', newValue: 'FALSE',
      notes: '取消覆寫（原值：' + String(d.row.OVERRIDE_VALUE || '（空白）')
        + '），改回跟隨內容表。記錄保留，不刪行。'
    });
  });

  if (appends.length > 0) writeSheet(SHEETS.FIELD_OVERRIDE, appends);
  return { upserted: upserts.length, deactivated: deactivations.length };
}
