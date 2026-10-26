/**
 * ModelOverlay.gs
 *
 * v3（2026-10-26 Ivan 測試結果 A，第 14、16 項）：不寫工作表、只「疊」一層資料在上面去砌週報資料模型。
 *
 *   - 草稿：填寫介面未儲存的修改（下載 Word 時選「包括未儲存修改的版本」）。
 *   - 版本預覽：某個版本還原之後的樣子（版本記錄「預覽」）。
 *
 * 兩者都經同一支 `buildBulletinModel_(isoDate, options)`，再經同一支渲染（Word）或預覽頁——
 * 不另寫一條組裝或渲染的路（bug class 3）。
 *
 * ⚠️ 只疊填寫介面**可以編輯**的欄位（`webAppEditableWeekFieldKeys_()`）。內容表的內容（講題、經文、
 *    家事報告……）與四張清單一律用現在的——與「還原」一樣（還原不動它們），所以版本預覽看到的就是
 *    還原之後會得到的樣子。
 * ⚠️ 一律不寫工作表（`noWrite:true`）：不寫回推斷出來的程序範本，不存 Word 到雲端硬碟。
 */

'use strict';

/**
 * 用途：把一份欄位值疊在 `BulletinWeeks` 那一行上面。純函式。
 *   只收可編輯欄位；`DATE` 型別的欄位如果是 `yyyy-MM-dd` 文字（版本記錄存的是文字）就換回 `Date`。
 * Args:
 *   week {Object} `BulletinWeeks` 那一行（可以是 `{}`）。
 *   values {Object} 要疊上去的值（機器鍵 → 值）。
 * Returns:
 *   {Object} 新物件；不改傳入的物件。
 * Raises:
 *   （無）
 */
function overlayEditableWeekValues_(week, values) {
  var out = Object.assign({}, week || {});
  var v = values || {};
  var cols = COLUMNS.BULLETIN_WEEKS;
  webAppEditableWeekFieldKeys_().forEach(function (key) {
    if (!Object.prototype.hasOwnProperty.call(v, key)) return;
    var value = v[key];
    var type = cols.types[cols.keys.indexOf(key)];
    if (type === 'DATE' && typeof value === 'string') {
      value = value.trim() ? (normalizeDate_(value.trim()) || value) : null;
    }
    out[key] = value === undefined ? '' : value;
  });
  return out;
}

/**
 * 用途：把一份事奉覆寫計畫（`computeDutyOverridePlan_()` 的輸出）套在記憶體內的 `DutyOverride` 行上，
 *   得出「儲存之後會是怎樣」。純函式。與真正儲存用同一份計畫，所以草稿與儲存之後一樣。
 * Args:
 *   rows {Object[]} 這一個主日的 `DutyOverride` 行（帶 `__rowNo`）。
 *   plan {?{updates:Object[], appends:Object[], deactivations:Object[]}}
 *   targetDate {Date} 主日日期（新增的行用）。
 * Returns:
 *   {Object[]} 新陣列（複本）。
 * Raises:
 *   （無）
 */
function applyDutyPlanToRows_(rows, plan, targetDate) {
  var out = (rows || []).map(function (r) { return Object.assign({}, r); });
  if (!plan) return out;
  var byRowNo = {};
  out.forEach(function (r) { if (r.__rowNo) byRowNo[r.__rowNo] = r; });
  (plan.deactivations || []).forEach(function (d) {
    if (byRowNo[d.rowNo]) byRowNo[d.rowNo].ACTIVE = false;
  });
  (plan.updates || []).forEach(function (u) {
    var row = byRowNo[u.rowNo];
    if (!row) return;
    (u.changes || []).forEach(function (c) { row[c.field] = c.newValue; });
  });
  (plan.appends || []).forEach(function (a) {
    out.push(Object.assign({ SERVICE_DATE: targetDate }, a, { ACTIVE: true }));
  });
  return out;
}

/**
 * 用途：草稿用的事奉覆寫：工作表上的覆寫，加上填寫介面未儲存的事奉格修改。唯讀（只讀職事表與
 *   `DutyOverride`，不寫任何東西）。
 * Args:
 *   isoDate {string} 主日日期。
 *   edits {Object[]} 與儲存 payload 的 `dutyEdits` 同一個形狀。
 * Returns:
 *   {Object[]} 這一個主日的 `DutyOverride` 行（草稿）。
 * Raises:
 *   Error `DutyOverride` 工作表讀不到而又有改格（與儲存相同）。
 */
function draftDutyOverrideRows_(isoDate, edits) {
  var rows;
  try {
    rows = readDutyOverrideRowsWithRowNo_(isoDate);
  } catch (err) {
    rows = [];
  }
  if (!Array.isArray(edits) || edits.length === 0) return rows;
  return applyDutyPlanToRows_(rows, planDutyEditsFromPayload_(isoDate, edits), normalizeDate_(isoDate));
}

/**
 * 用途：「包括未儲存修改」的草稿要用的模型選項。
 * Args:
 *   isoDate {string} 主日日期。
 *   draft {{week:Object=, dutyEdits:Object[]=, nextWeekDutyEdits:Object[]=}} 與儲存 payload 同一個形狀
 *     （只取這三樣；清單以內容表為準，不收）。
 * Returns:
 *   {{weekOverlay:Object, dutyOverrideRows:Object[], nextDutyOverrideRows:(Object[]|undefined), noWrite:boolean}}
 * Raises:
 *   Error 草稿帶了內容表接管的欄位（與儲存同一道檢查），或者程序增刪格式不對。
 */
function buildDraftModelOptions_(isoDate, draft) {
  var d = draft || {};
  assertContentSheetFieldsNotSubmitted_({ week: d.week || {} });
  assertWeekArrangementFieldsValid_({ week: d.week || {} });
  var nextIsoDate = formatIsoDate_(addDays_(normalizeDate_(isoDate), 7));
  return {
    weekOverlay: d.week || {},
    dutyOverrideRows: draftDutyOverrideRows_(isoDate, d.dutyEdits),
    nextDutyOverrideRows: Array.isArray(d.nextWeekDutyEdits) && d.nextWeekDutyEdits.length > 0
      ? draftDutyOverrideRows_(nextIsoDate, d.nextWeekDutyEdits) : undefined,
    noWrite: true
  };
}

/**
 * 用途：版本預覽要用的模型選項：那個版本的可編輯欄位與事奉框覆寫。下一個主日的事奉照用現在的
 *   （版本只記這一個主日）。
 * Args:
 *   isoDate {string} 主日日期。
 *   snapshotId {string} 版本編號。
 * Returns:
 *   {{options:Object, group:Object}} `options` 交給 `buildBulletinModel_()`；`group` 給標題用。
 * Raises:
 *   Error（`code:'SNAPSHOT_NOT_FOUND'`）找不到那個版本。
 */
function buildSnapshotModelOptions_(isoDate, snapshotId) {
  var loaded = loadWeekSnapshot_(isoDate, snapshotId);
  var targetDate = normalizeDate_(isoDate);
  var dutyRows = (loaded.payload.dutyOverrides || []).map(function (r) {
    return Object.assign({}, r, { SERVICE_DATE: targetDate, ACTIVE: true });
  });
  return {
    group: loaded.group,
    options: { weekOverlay: loaded.payload.week || {}, dutyOverrideRows: dutyRows, noWrite: true }
  };
}
