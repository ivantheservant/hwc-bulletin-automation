'use strict';

/**
 * 用途：替測試用的儲存 payload 補上 `baseWeek`。
 *
 *   F1 起，`saveWeekFromWebApp_()` 要求 payload 帶 `baseWeek`（`week` 內每個
 *   欄位「載入時」的值），沒有就以 `CLIENT_OUTDATED` 拒絕。多數測試是從
 *   空白工作表開始儲存，所以預設每個欄位載入時都是空白。工作表已有值、
 *   而測試想改那一格的，必須自己傳 `baseWeek`。
 * Args:
 *   payload {Object} 測試組好的 payload。
 * Returns:
 *   {Object} 同一個物件；已經有 `baseWeek`（包括明確傳 `undefined` 要測
 *     CLIENT_OUTDATED 的情況）就原樣不動。
 */
function withDefaultBaseWeek(payload) {
  if (Object.prototype.hasOwnProperty.call(payload, 'baseWeek')) return payload;
  payload.baseWeek = {};
  Object.keys(payload.week || {}).forEach(function (key) { payload.baseWeek[key] = ''; });
  return payload;
}

/** D9：填寫介面儲存 payload 的格式版本（與 src/WebAppSave.gs 的 SAVE_PAYLOAD_VERSION_ 相同）。 */
const SAVE_PAYLOAD_VERSION = 2;

/**
 * 用途：D9：照前端 `changedDutyEdits()` 的規則，由載入時的事奉框算出儲存要送的格——只送名字
 *   （去掉前後空白）與載入時不同的格，以及要「保留我的」的格；每格帶 `baseName`。
 *   給「由程式叫儲存入口」的測試用，免得測試又回到「送全部格」的舊做法（FF-17、FF-26）。
 * Args:
 *   loadedRows {Object[]} `loadWeekForWebApp_(iso).readOnly.dutyBoxPage1` 或 `.nextWeekDuty`。
 *   wanted {Object<string,(string|{name:string,keepOverride:boolean})>} 鍵 `postId#slotIndex`，
 *     值是畫面上的新名字，或 `{name, keepOverride}`。沒有列出的格當作沒有動。
 * Returns:
 *   {{postId:string, slotIndex:number, name:string, baseName:string, keepOverride:(boolean|undefined)}[]}
 * Raises:
 *   Error 如果 `wanted` 列了一格載入時沒有的格（測試寫錯）。
 */
function changedDutyCells(loadedRows, wanted) {
  const slots = {};
  (loadedRows || []).forEach(function (row) {
    (row.slots || []).forEach(function (slot) { slots[slot.postId + '#' + slot.slotIndex] = slot; });
  });
  const out = [];
  Object.keys(wanted || {}).forEach(function (key) {
    const slot = slots[key];
    if (!slot) throw new Error('changedDutyCells：載入時沒有 ' + key + ' 這一格');
    const w = typeof wanted[key] === 'string' ? { name: wanted[key] } : wanted[key];
    const now = String(w.name === undefined || w.name === null ? '' : w.name).trim();
    const base = String(slot.bulletinName || '').trim();
    const keep = w.keepOverride === true && now === base;
    if (now === base && !keep) return;
    const entry = { postId: slot.postId, slotIndex: slot.slotIndex, name: now, baseName: base };
    if (keep) entry.keepOverride = true;
    out.push(entry);
  });
  return out;
}

module.exports = { withDefaultBaseWeek, SAVE_PAYLOAD_VERSION, changedDutyCells };
