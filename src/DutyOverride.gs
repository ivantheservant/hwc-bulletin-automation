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
 *   D9（docs/待確認事項.md FF-17、FF-26）：前端只送**載入之後改過**的格（每格帶 `baseName`＝載入時的
 *   名字），或者幹事對衝突格按了「保留我的」的格（`keepOverride:true`）。**沒有送來的格一律不動**：
 *   不新增覆寫、不更新基準。以前前端每次儲存都送全部格，結果 (a) 仍然生效的覆寫的基準被更新成現在的
 *   職事表值，「衝突」靜靜消失；(b) 分頁開着期間職事表換了人，只改序樂儲存會新增一筆覆寫，把載入時的
 *   舊名字釘死。
 *
 *   逐格規則（只看送來的格）：
 *     - 名字（前後空白去掉）等於 `baseName`、又不是「保留我的」→ 這一格其實沒有改，略過（後端第二重防線，
 *       前端本來就不會送；`baseName` 沒有帶就當作有改）。
 *     - 新值與**職事表現值相同**，或者是空字串 → 不需要覆寫。既有的生效中覆寫改成 `ACTIVE=FALSE`；
 *       本來就沒有覆寫的話什麼都不做（**不會**產生一行「覆寫成跟職事表一樣」的無意義記錄）。
 *     - 新值與職事表現值不同 → 寫或更新一行覆寫。`ROSTER_VALUE_AT_OVERRIDE` 與
 *       `ROSTER_VERSION_AT_OVERRIDE` 重新記成現在的職事表值／版本——幹事這一刻真的改了（或者按了
 *       「保留我的」），是看著現在的職事表做決定的，衝突解除。
 *     - `keepOverride` 只認布林 `true`（字串 `"true"` 不算，當作沒有按）：名字不變，只把基準更新到現在
 *       的職事表，衝突解除（上一條的特例）。
 *     - `followRoster` 只認布林 `true`（幹事對有覆寫的格按了「還原」）：不論送來的名字、也不論職事表
 *       現值，一律停用那一格全部生效中的覆寫，不新增、不更新覆寫。名字不可以拿來代表這個意圖：「還原」
 *       在輸入框填的是載入時的職事表名字，分頁開着期間職事表換了人的話，那個名字與職事表現值不同，
 *       照一般規則會把舊名字釘成新覆寫（審查後修正 1）。`followRoster` 與 `keepOverride` 同時是 true
 *       （介面不會這樣送）時以 `followRoster` 為準。
 *
 *   另外每次都檢查這一週**全部**生效中的覆寫（沒有送來的格）：覆寫的名字已經等於職事表現值（職事表
 *   追上了覆寫），或者覆寫名字是空白（畫面本來就顯示職事表），就自動停用（`autoCaughtUp:true`），
 *   畫面上的名字不變。這就是 G16-9 的行為：以前靠「前端送來的名字等於職事表」觸發，現在不用送。
 *   職事表現值是空白（未排定、或讀不到）時不會自動停用，免得把覆寫當成「追上了」。
 * Args:
 *   input {{edits:Object[], existingRows:Object[], rosterNameByKey:Object,
 *          rosterVersion:(number|null)}}
 *     `edits` 每個元素是 `{postId, slotIndex, name, baseName, keepOverride, followRoster}`（後三個可省略）；
 *     `existingRows` 是 `readDutyOverrideRowsWithRowNo_()` 的輸出；`rosterNameByKey` 是
 *     「崗位#位次 → 職事表現值」。
 * Returns:
 *   {{updates:{rowNo:number, changes:{field:string,oldValue:*,newValue:*}[],
 *      postId:string, slotIndex:number}[],
 *     appends:Object[], deactivations:{rowNo:number, postId:string,
 *      slotIndex:number, oldValue:string, rosterName:string, autoCaughtUp:boolean}[]}}
 *     `appends` 的元素不含 `SERVICE_DATE`（由呼叫方補上）。`deactivations` 的
 *     `rosterName` 是職事表現值（G16：取消覆寫之後畫面上那一格會不會變，
 *     要拿它與 `oldValue` 比）；`autoCaughtUp` 為真代表不是幹事改的，是職事表追上了覆寫。
 * Raises:
 *   （無）
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
  var editedKeys = {};

  edits.forEach(function (edit) {
    var key = dutyOverrideKey_(edit.postId, edit.slotIndex);
    var slotIndex = (edit.slotIndex === null || edit.slotIndex === undefined) ? 1 : Number(edit.slotIndex);
    var newName = String(edit.name === null || edit.name === undefined ? '' : edit.name).trim();
    var keep = edit.keepOverride === true;
    var follow = edit.followRoster === true;
    var hasBase = typeof edit.baseName === 'string';
    if (!follow && !keep && hasBase && newName === edit.baseName.trim()) return;
    editedKeys[key] = true;

    var rosterName = String(rosterNameByKey[key] === undefined ? '' : rosterNameByKey[key]).trim();
    var existing = existingByKey[key];

    // 審查後修正 1：「還原」＝改回跟隨職事表。不看名字、不看職事表現值，那一格生效中的覆寫全部停用。
    if (follow) {
      (input.existingRows || []).forEach(function (row) {
        if (row.ACTIVE !== true || dutyOverrideKey_(row.POST_ID, row.SLOT_INDEX) !== key) return;
        deactivations.push({
          rowNo: row.__rowNo, postId: edit.postId, slotIndex: slotIndex,
          oldValue: String(row.OVERRIDE_NAME || ''), rosterName: rosterName, autoCaughtUp: false
        });
      });
      return;
    }

    var shouldOverride = newName !== '' && newName !== rosterName;

    if (!shouldOverride) {
      if (existing && existing.ACTIVE === true) {
        deactivations.push({
          rowNo: existing.__rowNo, postId: edit.postId, slotIndex: slotIndex,
          oldValue: String(existing.OVERRIDE_NAME || ''), rosterName: rosterName, autoCaughtUp: false
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

  // D9：沒有送來的格，只做「職事表追上了覆寫就停用」這一件事（見上面的說明）。
  (input.existingRows || []).forEach(function (row) {
    if (row.ACTIVE !== true) return;
    var key = dutyOverrideKey_(row.POST_ID, row.SLOT_INDEX);
    if (editedKeys[key]) return;
    var overrideName = String(row.OVERRIDE_NAME === null || row.OVERRIDE_NAME === undefined ? '' : row.OVERRIDE_NAME).trim();
    var rosterName = String(rosterNameByKey[key] === undefined ? '' : rosterNameByKey[key]).trim();
    var caughtUp = overrideName === '' || (rosterName !== '' && overrideName === rosterName);
    if (!caughtUp) return;
    var slotIndex = (row.SLOT_INDEX === null || row.SLOT_INDEX === undefined || row.SLOT_INDEX === '') ? 1 : Number(row.SLOT_INDEX);
    deactivations.push({
      rowNo: row.__rowNo, postId: String(row.POST_ID), slotIndex: slotIndex,
      oldValue: overrideName, rosterName: rosterName, autoCaughtUp: true
    });
  });

  return { updates: updates, appends: appends, deactivations: deactivations };
}

/**
 * 用途：第二批測試修正 G16／G28 複審：停用一筆事奉覆寫之後，畫面上那一格的名字會不會不變。
 *   純函式。停用之後那一格改回顯示職事表的名字；覆寫的名字本來就與現在的職事表相同（職事表
 *   追上了覆寫）才是不變。
 *
 *   ⚠️ 只有計畫帶 `rosterName`（`computeDutyOverridePlan_()` 算的，即儲存那一條路）才判斷得到；
 *   重設、還原、由職事表重新取數的計畫沒有 `rosterName`，一律當作會變（`false`）——寧可多算一次
 *   改動、令另一週多收一次 STALE，也不可以把真的改了名字講成沒有改。D9：覆寫名字本身是空白的例外
 *   （畫面本來就不受它影響），一律是不變。
 *   `applyDutyOverridePlan_()` 的 `displayUnchanged` 與 `dutyPlanChangesNames_()` 都經這一支，
 *   規則只有一份。
 * Args:
 *   deact {{oldValue:string, rosterName:(string|undefined)}} 停用計畫的一項。
 * Returns:
 *   {boolean} true＝畫面上的名字不變。
 * Raises:
 *   （無）
 */
function dutyDeactivationKeepsDisplay_(deact) {
  var d = deact || {};
  // D9：覆寫名字是空白的話，畫面本來就顯示職事表的名字（applyDutyOverridesToSlots_() 不理空白覆寫），
  // 停用之後一樣，不論計畫有沒有 rosterName。
  if (String(d.oldValue || '').trim() === '') return true;
  if (d.rosterName === undefined || d.rosterName === null) return false;
  return String(d.oldValue || '').trim() === String(d.rosterName).trim();
}

/**
 * 用途：把 `computeDutyOverridePlan_()` 算出來的計畫套用到 `DutyOverride`
 *   工作表，並逐格累積 `AuditLog` 條目（呼叫方負責真正寫入）。
 *
 *   ⚠️ **不刪行**：取消覆寫一律是把 `ACTIVE` 改成 `FALSE`，記錄永遠保留。
 *
 *   G16：取消覆寫的條目另帶 `displayUnchanged`（不寫入 `AuditLog`，只給
 *   `countSaveChanges_()` 用）：覆寫的名字本來就與現在的職事表相同，畫面上那一格
 *   不會變，儲存訊息不把它算成使用者改了的欄位。判斷經 `dutyDeactivationKeepsDisplay_()`
 *   （與 `dutyPlanChangesNames_()` 共用）；計畫沒有 `rosterName`（重設、還原）時一律是 `false`。
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
      // D9：自動停用（職事表追上了覆寫）與幹事自己取消，備註分開講，日後查得出是哪一種。
      notes: dutyDeactivationNote_(deact),
      displayUnchanged: dutyDeactivationKeepsDisplay_(deact)
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
 * 用途：D9：停用一筆事奉覆寫時 `AuditLog` 的備註。純函式。幹事自己取消、職事表追上了覆寫（自動停用）、
 *   覆寫名字本身是空白（自動停用），三種分開講，日後查得出是哪一種。
 * Args:
 *   deact {{oldValue:string, autoCaughtUp:(boolean|undefined)}} 停用計畫的一項。
 * Returns:
 *   {string}
 * Raises:
 *   （無）
 */
function dutyDeactivationNote_(deact) {
  var d = deact || {};
  var oldValue = String(d.oldValue || '').trim();
  if (d.autoCaughtUp === true && oldValue === '') {
    return '人手覆寫的名字是空白（畫面本來就顯示職事表的名字），儲存時自動停用。記錄保留，不刪行。';
  }
  if (d.autoCaughtUp === true) {
    return '職事表現在亦是「' + oldValue + '」，與人手覆寫相同，儲存時自動改回跟隨職事表。記錄保留，不刪行。';
  }
  return '取消人手覆寫（原值：' + String(d.oldValue || '') + '），改回跟隨職事表。記錄保留，不刪行。';
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
