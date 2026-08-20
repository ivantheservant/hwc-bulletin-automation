/**
 * DutyOverride.gs
 *
 * 幹事在週報直接改事奉名單時的人手覆寫：讀取、套用到職事表快照、
 * 以及儲存（upsert，不刪行）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 核心原則（第六輪的整條規則，每個相關檔案都要複述一次）
 * ─────────────────────────────────────────────────────────────────────
 *
 * 1. **週報永不寫職事表。** 本檔案只寫週報自己的 `DutyOverride` 工作表，
 *    不會出現 `openById(`，`tools/lint-readonly-roster.js` 繼續生效。
 * 2. 幹事在週報改的事奉名單**只存在週報**。
 * 3. **沒有人手覆寫的崗位，自動跟隨職事表最新版**——因為那些格子的值
 *    本來就是每次直接從職事表快照讀出來的，沒有任何東西擋在中間。
 * 4. **有人手覆寫的崗位，職事表改動不會自動蓋過去**，只會被
 *    `src/RosterDiff.gs` 標示為 `CONFLICT`。
 * 5. 一切分歧**只提醒，不自動修正任何一邊**。
 *
 * ⚠️ 取值次序固定是「職事表快照 → 套用 DutyOverride → 套用 PersonDisplay
 * 尊稱」，**不可以調轉**：覆寫的是「這一格是誰」，尊稱是「這個人怎樣
 * 稱呼」，先決定人再決定稱呼。合併組（主席及報告、影音）同樣要在**套用
 * 覆寫之後**才合併，否則「主席被覆寫成另一個人」的情況下，合併判斷會
 * 用職事表的舊人名去比，得出錯誤的合併結果。
 */

'use strict';

/**
 * 用途：組出「崗位＋位次」的唯一鍵，供覆寫索引使用。
 * Args:
 *   postId {string} 崗位 ID。
 *   slotIndex {*} 位次；`null`／`undefined` 一律當 1（職事表沒有派工
 *     紀錄時，`buildRosterSlotIndex_()` 補的空白 slot 就是 slotIndex 1）。
 * Returns:
 *   {string} 例如 `'CHAIR#1'`。
 */
function dutyOverrideKey_(postId, slotIndex) {
  var idx = (slotIndex === null || slotIndex === undefined || slotIndex === '') ? 1 : Number(slotIndex);
  return String(postId) + '#' + idx;
}

/**
 * 用途：把 `DutyOverride` 資料列組成「崗位#位次 → 資料列」的索引，
 *   **只收 `ACTIVE=TRUE` 的行**。純函式。
 * Args:
 *   overrideRows {Object[]} `DutyOverride` 的資料列（已經篩過主日日期）。
 * Returns:
 *   {Object<string,Object>} 同一個鍵有多行時保留**第一行**（工作表由
 *     人手／程式 upsert 維護，重複本來就不應該出現）。
 */
function buildDutyOverrideIndex_(overrideRows) {
  var index = {};
  (overrideRows || []).forEach(function (row) {
    if (row.ACTIVE !== true) return;
    var key = dutyOverrideKey_(row.POST_ID, row.SLOT_INDEX);
    if (!(key in index)) index[key] = row;
  });
  return index;
}

/**
 * 用途：把人手覆寫套用到職事表快照的 `slotsByPost` 上，回傳一份**新的**
 *   索引（不修改傳入的物件）。純函式。
 *
 *   每個 slot 會多出三個欄位：
 *     `rosterName`　　職事表現時的值（**永遠保留**，供比對與介面顯示
 *                     「職事表：某某」用）
 *     `hasOverride`　 這一格有沒有生效中的人手覆寫
 *     `overrideName`　覆寫的姓名文字（沒有覆寫時是空字串）
 *
 *   有覆寫時 `personName` 換成覆寫值、`personId` 設為 `null`
 *   （`OVERRIDE_NAME` 是顯示用姓名，不是 PersonID——幹事可能填一個職事表
 *   根本沒有的人），`state` 改成 `ASSIGNED`。
 *
 *   ⚠️ **`NOT_APPLICABLE` 的 slot 不受覆寫影響**：那一週根本不設這個崗位
 *   是關於**版面結構**的判斷，覆寫是關於**那一格填什麼內容**，結構先於
 *   內容——這跟 `resolveRosterSlotState_()` 的優先級規則一致（見
 *   docs/已知bug類型.md 事故五）。實務上介面也不會顯示這些格子，所以
 *   正常操作不會產生這種覆寫；這裡是防呆。
 * Args:
 *   slotsByPost {Object<string,Object[]>} 職事表快照的 `slotsByPost`。
 *   overrideIndex {Object<string,Object>} `buildDutyOverrideIndex_()` 的輸出。
 * Returns:
 *   {Object<string,Object[]>} 新的索引，結構與輸入相同。
 */
function applyDutyOverridesToSlots_(slotsByPost, overrideIndex) {
  var index = overrideIndex || {};
  var result = {};

  Object.keys(slotsByPost || {}).forEach(function (postId) {
    result[postId] = (slotsByPost[postId] || []).map(function (slot) {
      var rosterName = String(slot.personName || '');
      var enriched = Object.assign({}, slot, {
        rosterName: rosterName,
        hasOverride: false,
        overrideName: ''
      });

      if (slot.state === ROSTER_SLOT_STATE_.NOT_APPLICABLE) return enriched;

      var override = index[dutyOverrideKey_(postId, slot.slotIndex)];
      if (!override) return enriched;

      var overrideName = String(override.OVERRIDE_NAME || '').trim();
      if (!overrideName) return enriched;

      enriched.hasOverride = true;
      enriched.overrideName = overrideName;
      enriched.personName = overrideName;
      enriched.personId = null;
      enriched.state = ROSTER_SLOT_STATE_.ASSIGNED;
      return enriched;
    });
  });

  return result;
}

// =====================================================================
// IO 層
// =====================================================================

/**
 * 用途：讀出 `DutyOverride` 工作表內指定主日的**全部**資料列（含
 *   `ACTIVE=FALSE` 的），並附上工作表實際行號 `__rowNo`——儲存邏輯要靠
 *   行號才能原地更新（而不是刪行重寫）。
 * Args:
 *   isoDate {string} 主日日期，yyyy-MM-dd。
 * Returns:
 *   {Object[]} 每個元素是 `DutyOverride` 的一行，另有 `__rowNo`。
 * Raises:
 *   Error 如果工作表不存在（`readRowsWithRowNo_()` 原樣拋出）。
 */
function readDutyOverrideRowsWithRowNo_(isoDate) {
  var rows = readRowsWithRowNo_(SHEETS.DUTY_OVERRIDE);
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(isoDate || ''));
  if (!m) return [];
  var y = Number(m[1]);
  var mo = Number(m[2]);
  var d = Number(m[3]);
  return rows.filter(function (r) { return rosterDateMatchesYMD_(r.SERVICE_DATE, y, mo, d); });
}

/**
 * 用途：讀出 `DutyOverride` 工作表內指定主日的資料列（不帶行號，給
 *   `buildBulletinModel_()`／`RosterDiff.gs` 這類只讀的呼叫方用）。
 *   工作表不存在時回空陣列而**不是拋錯**——`DutyOverride` 是第六輪才
 *   新增的表，如果 Ivan 還沒撳「初始化工作表」，週報應該照樣建得出來
 *   （只是沒有任何覆寫），不應該讓整份週報生不出來。
 * Args:
 *   isoDate {string} 主日日期，yyyy-MM-dd。
 * Returns:
 *   {Object[]}
 */
function readDutyOverrideRows_(isoDate) {
  var rows;
  try {
    rows = readSheet(SHEETS.DUTY_OVERRIDE);
  } catch (err) {
    return [];
  }
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(isoDate || ''));
  if (!m) return [];
  var y = Number(m[1]);
  var mo = Number(m[2]);
  var d = Number(m[3]);
  return rows.filter(function (r) { return rosterDateMatchesYMD_(r.SERVICE_DATE, y, mo, d); });
}

/**
 * 用途：算出一批事奉格編輯要對 `DutyOverride` 做什麼。純函式，不碰
 *   Apps Script 服務，方便在 Node 直接測試。
 *
 *   逐格規則：
 *     - 新值與**職事表現值相同** → 不需要覆寫。既有的生效中覆寫改成
 *       `ACTIVE=FALSE`；本來就沒有覆寫的話什麼都不做（**不會**產生
 *       一行「覆寫成跟職事表一樣」的無意義記錄）。
 *     - 新值是空字串 → 取消覆寫，同上（`ACTIVE=FALSE`，不刪行）。
 *     - 新值與職事表現值不同 → 寫或更新一行覆寫。`ROSTER_VALUE_AT_OVERRIDE`
 *       與 `ROSTER_VERSION_AT_OVERRIDE` 一律**重新記成現在的職事表值／
 *       版本**——幹事這一刻是看著現在的職事表做決定的，所以衝突判斷的
 *       基準線要跟著更新（副作用是這樣會把原本的 `CONFLICT` 消掉，
 *       那正是「幹事已經看過並重新確認」應有的效果）。
 * Args:
 *   input {{edits:Object[], existingRows:Object[], rosterNameByKey:Object,
 *          rosterVersion:(number|null)}}
 *     `edits` 每個元素是 `{postId, slotIndex, name}`；`existingRows` 是
 *     `readDutyOverrideRowsWithRowNo_()` 的輸出；`rosterNameByKey` 是
 *     「崗位#位次 → 職事表現值」。
 * Returns:
 *   {{updates:{rowNo:number, changes:{field:string,oldValue:*,newValue:*}[],
 *      postId:string, slotIndex:number}[],
 *     appends:Object[], deactivations:{rowNo:number, postId:string,
 *      slotIndex:number, oldValue:string}[]}}
 *     `appends` 的元素不含 `SERVICE_DATE`（由呼叫方補上）。
 */
function computeDutyOverridePlan_(input) {
  var edits = input.edits || [];
  var existingByKey = {};
  (input.existingRows || []).forEach(function (row) {
    var key = dutyOverrideKey_(row.POST_ID, row.SLOT_INDEX);
    if (!(key in existingByKey)) existingByKey[key] = row;
  });
  var rosterNameByKey = input.rosterNameByKey || {};

  var updates = [];
  var appends = [];
  var deactivations = [];

  edits.forEach(function (edit) {
    var key = dutyOverrideKey_(edit.postId, edit.slotIndex);
    var slotIndex = (edit.slotIndex === null || edit.slotIndex === undefined) ? 1 : Number(edit.slotIndex);
    var newName = String(edit.name === null || edit.name === undefined ? '' : edit.name).trim();
    var rosterName = String(rosterNameByKey[key] === undefined ? '' : rosterNameByKey[key]).trim();
    var existing = existingByKey[key];

    var shouldOverride = newName !== '' && newName !== rosterName;

    if (!shouldOverride) {
      if (existing && existing.ACTIVE === true) {
        deactivations.push({
          rowNo: existing.__rowNo, postId: edit.postId, slotIndex: slotIndex,
          oldValue: String(existing.OVERRIDE_NAME || '')
        });
      }
      return;
    }

    if (existing) {
      var changes = [];
      if (!fieldsEqual_(existing.OVERRIDE_NAME, newName)) {
        changes.push({ field: 'OVERRIDE_NAME', oldValue: existing.OVERRIDE_NAME, newValue: newName });
      }
      if (!fieldsEqual_(existing.ROSTER_VALUE_AT_OVERRIDE, rosterName)) {
        changes.push({ field: 'ROSTER_VALUE_AT_OVERRIDE', oldValue: existing.ROSTER_VALUE_AT_OVERRIDE, newValue: rosterName });
      }
      if (!fieldsEqual_(existing.ROSTER_VERSION_AT_OVERRIDE, input.rosterVersion)) {
        changes.push({ field: 'ROSTER_VERSION_AT_OVERRIDE', oldValue: existing.ROSTER_VERSION_AT_OVERRIDE, newValue: input.rosterVersion });
      }
      if (existing.ACTIVE !== true) {
        changes.push({ field: 'ACTIVE', oldValue: existing.ACTIVE, newValue: true });
      }
      if (changes.length > 0) {
        updates.push({ rowNo: existing.__rowNo, changes: changes, postId: edit.postId, slotIndex: slotIndex });
      }
      return;
    }

    appends.push({
      POST_ID: edit.postId,
      SLOT_INDEX: slotIndex,
      OVERRIDE_NAME: newName,
      ROSTER_VALUE_AT_OVERRIDE: rosterName,
      ROSTER_VERSION_AT_OVERRIDE: input.rosterVersion,
      REASON: String(edit.reason || ''),
      ACTIVE: true,
      NOTES: ''
    });
  });

  return { updates: updates, appends: appends, deactivations: deactivations };
}

/**
 * 用途：把 `computeDutyOverridePlan_()` 算出來的計畫套用到 `DutyOverride`
 *   工作表，並逐格累積 `AuditLog` 條目（呼叫方負責真正寫入）。
 *
 *   ⚠️ **不刪行**：取消覆寫一律是把 `ACTIVE` 改成 `FALSE`，記錄永遠保留。
 * Args:
 *   plan {Object} `computeDutyOverridePlan_()` 的輸出。
 *   targetDate {Date} 主日日期（新增行要用）。
 *   isoDate {string} 主日日期 yyyy-MM-dd（`AuditLog.ROW_KEY` 用）。
 *   actorEmail {string} 目前操作者的電郵，寫進 `OVERRIDE_BY`。
 *   auditEntriesOut {Object[]} 累積用的陣列。
 * Returns:
 *   {void}
 */
function applyDutyOverridePlan_(plan, targetDate, isoDate, actorEmail, auditEntriesOut) {
  if (!plan) return;
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.DUTY_OVERRIDE);
  if (!sheet) {
    throw new Error('applyDutyOverridePlan_：找不到工作表「' + SHEETS.DUTY_OVERRIDE + '」，請先執行「初始化工作表」。');
  }
  var def = COLUMNS.DUTY_OVERRIDE;
  var now = new Date();

  plan.updates.forEach(function (u) {
    u.changes.forEach(function (c) {
      var colIndex = def.keys.indexOf(c.field) + 1;
      if (colIndex <= 0) return;
      sheet.getRange(u.rowNo, colIndex).setValue(c.newValue === null || c.newValue === undefined ? '' : c.newValue);
      auditEntriesOut.push({
        action: 'DUTY_OVERRIDE_SET', sheetName: SHEETS.DUTY_OVERRIDE,
        rowKey: isoDate + '#' + u.postId + '#' + u.slotIndex,
        field: c.field, oldValue: auditValueToText_(c.oldValue), newValue: auditValueToText_(c.newValue)
      });
    });
    // 每次更新都重新蓋上「誰、什麼時候改的」，這兩格不記 AuditLog
    // （每次必變，逐次記錄只會淹沒真正有意義的欄位異動）。
    sheet.getRange(u.rowNo, def.keys.indexOf('OVERRIDE_AT') + 1).setValue(now);
    sheet.getRange(u.rowNo, def.keys.indexOf('OVERRIDE_BY') + 1).setValue(sanitizeCellText_(actorEmail));
  });

  plan.deactivations.forEach(function (deact) {
    sheet.getRange(deact.rowNo, def.keys.indexOf('ACTIVE') + 1).setValue(false);
    auditEntriesOut.push({
      action: 'DUTY_OVERRIDE_CLEAR', sheetName: SHEETS.DUTY_OVERRIDE,
      rowKey: isoDate + '#' + deact.postId + '#' + deact.slotIndex,
      field: 'ACTIVE', oldValue: 'TRUE', newValue: 'FALSE',
      notes: '取消人手覆寫（原值：' + deact.oldValue + '），改回跟隨職事表。記錄保留，不刪行。'
    });
  });

  if (plan.appends.length > 0) {
    var rows = plan.appends.map(function (row) {
      return Object.assign({}, row, {
        SERVICE_DATE: targetDate,
        OVERRIDE_AT: now,
        OVERRIDE_BY: sanitizeCellText_(actorEmail),
        OVERRIDE_NAME: sanitizeCellText_(row.OVERRIDE_NAME),
        ROSTER_VALUE_AT_OVERRIDE: sanitizeCellText_(row.ROSTER_VALUE_AT_OVERRIDE),
        REASON: sanitizeCellText_(row.REASON)
      });
    });
    writeSheet(SHEETS.DUTY_OVERRIDE, rows);

    plan.appends.forEach(function (row) {
      auditEntriesOut.push({
        action: 'DUTY_OVERRIDE_SET', sheetName: SHEETS.DUTY_OVERRIDE,
        rowKey: isoDate + '#' + row.POST_ID + '#' + row.SLOT_INDEX,
        field: 'OVERRIDE_NAME', oldValue: String(row.ROSTER_VALUE_AT_OVERRIDE || ''), newValue: String(row.OVERRIDE_NAME || ''),
        notes: '新增人手覆寫；覆寫當時職事表的值是「' + String(row.ROSTER_VALUE_AT_OVERRIDE || '（空白）') + '」。'
      });
    });
  }
}

/**
 * 用途：組出「崗位#位次 → 職事表現值」的對照表，供
 *   `computeDutyOverridePlan_()` 判斷「新值是不是跟職事表一樣」。純函式。
 *
 *   ⚠️ 用的是 `slot.rosterName`（如果已經套過
 *   `applyDutyOverridesToSlots_()`）或 `slot.personName`（未套過時），
 *   **不是覆寫後的顯示值**——這裡要的是職事表本身現在的值。
 * Args:
 *   slotsByPost {Object<string,Object[]>} 職事表快照的 `slotsByPost`。
 * Returns:
 *   {Object<string,string>}
 */
function buildRosterNameByKey_(slotsByPost) {
  var map = {};
  Object.keys(slotsByPost || {}).forEach(function (postId) {
    (slotsByPost[postId] || []).forEach(function (slot) {
      var name = (slot.rosterName === undefined || slot.rosterName === null) ? slot.personName : slot.rosterName;
      map[dutyOverrideKey_(postId, slot.slotIndex)] = String(name || '');
    });
  });
  return map;
}
