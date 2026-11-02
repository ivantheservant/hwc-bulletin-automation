/**
 * src/LoadTiming.gs
 *
 * 2026-11-03（Ivan：載入慢，要分段計時）：填寫介面載入各段用了多少時間。只是量度，不影響任何結果：
 *   伺服器把每一段的毫秒數放在回應的 `timings`，填寫介面在頂部統計列旁邊顯示總時間（滑鼠停留看分段），
 *   並寫入瀏覽器主控台（`[LoadTiming]`）。
 */

'use strict';

/**
 * 用途：開始計時。IO 層（讀時鐘）。
 * Args:
 *   name {string} 這一次量度的名稱（例如「apiBootstrap」）。
 * Returns:
 *   {{mark:function(string):void, result:function():{name:string, totalMs:number, parts:{label:string, ms:number}[]}}}
 *     `mark(label)`：由上一次 mark（或者開始）到現在算一段。
 * Raises:
 *   （無）
 */
function createLoadTimer_(name) {
  var start = Date.now();
  var last = start;
  var parts = [];
  return {
    mark: function (label) {
      var now = Date.now();
      parts.push({ label: String(label || ''), ms: now - last });
      last = now;
    },
    // 2026-11-03：「其中」一項（已經算在某一段之內，不另計時間、不移動計時起點），例如「（其中讀職事表）」。
    note: function (label, ms) {
      parts.push({ label: String(label || ''), ms: Math.max(0, Number(ms) || 0), note: true });
    },
    result: function () {
      return { name: String(name || ''), totalMs: Date.now() - start, parts: parts.slice() };
    }
  };
}

/**
 * 用途：沒有傳入計時器時用的「甚麼都不做」版本，呼叫方不用到處判斷有沒有計時器。純函式。
 * Returns:
 *   {{mark:function(string):void, result:function():Object}}
 */
function noopLoadTimer_() {
  return { mark: function () {}, note: function () {}, result: function () { return { name: '', totalMs: 0, parts: [] }; } };
}
