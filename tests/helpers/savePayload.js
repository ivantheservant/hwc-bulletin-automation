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

module.exports = { withDefaultBaseWeek };
