/**
 * ScriptLock.gs
 *
 * D12：全專案唯一拿指令碼鎖（`LockService.getScriptLock()`）的地方。儲存、內容表匯入、講員表格答案、
 * 發佈，以及 D13 加上的還原、重設、由職事表重新取數，一律經 `withScriptLock_()`。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 為甚麼要自己記「這一次執行已經拿着鎖」
 * ─────────────────────────────────────────────────────────────────────
 *
 * 有些拿鎖的函式會叫另一個拿鎖的函式：講員表格答案（`onSpeakerFormSubmit_()`）→
 * `applySpeakerFormAnswer_()` → `applyContentImport_()`；重設（D13 之後拿鎖）→ `applyContentImport_()`。
 * 同一次執行之內第二次 `getScriptLock().tryLock()` 會即時成功（可重入）還是等到逾時（不可重入），
 * 一直未有核實（docs/待確認事項.md FF-23）；可重入的話，內層放鎖會不會連外層也放了，亦未核實。
 * 兩種都會出事：不可重入＝內層等滿 30 秒再失敗；內層放鎖連外層也放＝外層餘下的寫入沒有鎖保護。
 *
 * 所以不依賴 Apps Script 在這一點上的行為：本檔案用一個執行期的計數 `SCRIPT_LOCK_DEPTH_` 記住
 * 「這一次執行已經拿着鎖、疊了幾層」。最外層才真的 `tryLock()`，並在 finally 經 `flushAndReleaseLock_()`
 * 放鎖；巢狀呼叫直接執行，不再拿鎖、不提早放鎖。
 *
 * ⚠️ 專案規則不准全域狀態，這是刻意的例外，理由：
 *   1. 它描述的正正是「這一次執行」的狀態——Apps Script 每一次執行（一次 `google.script.run`、一次
 *      觸發器、一次選單）都由頭載入全部 `.gs`，模組層變數每次都是全新的，執行一結束它就跟住消失，
 *      不會跨執行殘留（與 `CONFIG_CACHE_` 同一個道理，不是事故三十六那種會遺失的真相來源）；
 *   2. 鎖本身就是執行期的東西，不可以記在工作表或 Script Property（那些會跨執行殘留，執行被硬中斷
 *      時會留下一個「以為仍然拿着鎖」的假狀態）；
 *   3. 用參數一層層傳「已經拿着鎖」要改一整條呼叫鏈（講員表格、重設、匯入、選單……），漏傳一處
 *      就回到 FF-23 的問題；而計數只有這一個檔案讀寫，範圍最小。
 * 只准本檔案讀寫 `SCRIPT_LOCK_DEPTH_`；tests/writeaction.test.js 的 D12 核對其他 `src` 檔案一處都沒有用到它。
 * 見 docs/已知bug類型.md bug class 144。
 */

'use strict';

/** D12：這一次執行之內 `withScriptLock_()` 疊了幾層（0＝未拿鎖）。只准本檔案讀寫，理由見檔頭。 */
var SCRIPT_LOCK_DEPTH_ = 0;

/**
 * 用途：在指令碼鎖之內執行 `fn`。這一次執行未拿着鎖就 `tryLock(waitMs)`，拿不到就交給 `onBusy`
 *   （一格都未寫）；拿到就執行 `fn`，finally 經 `flushAndReleaseLock_()` 放鎖。這一次執行已經拿着鎖
 *   （巢狀呼叫）就直接執行 `fn`：不再等鎖、不放鎖，由最外層放。
 * Args:
 *   label {string} 呼叫方的名稱（例如 `'apiSaveWeek'`），只用於拿不到鎖時預設的錯誤訊息。
 *   waitMs {number} 最多等幾多毫秒。
 *   fn {function():*} 要在鎖之內做的事。
 *   onBusy {function():*=} 拿不到鎖時做的事：它回傳的值原樣回傳（例如發佈的 `LOCK_BUSY` 結果），
 *     或者由它拋錯。省略就拋 `LOCK_TIMEOUT`（訊息見 `buildLockTimeoutError_()`）。
 * Returns:
 *   {*} `fn()` 的回傳值；拿不到鎖時是 `onBusy()` 的回傳值。
 * Raises:
 *   `fn()` 拋出的錯誤原樣拋出（鎖照放）；拿不到鎖而沒有 `onBusy` 時拋 Error（`code:'LOCK_TIMEOUT'`）；
 *   `onBusy()` 拋出的錯誤原樣拋出。
 */
function withScriptLock_(label, waitMs, fn, onBusy) {
  if (SCRIPT_LOCK_DEPTH_ > 0) {
    SCRIPT_LOCK_DEPTH_++;
    try {
      return fn();
    } finally {
      SCRIPT_LOCK_DEPTH_--;
    }
  }

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(waitMs)) {
    if (typeof onBusy === 'function') return onBusy();
    var err = buildLockTimeoutError_(waitMs, '請稍等再試一次。');
    err.message = String(label || '') + '：' + err.message;
    throw err;
  }

  SCRIPT_LOCK_DEPTH_ = 1;
  try {
    return fn();
  } finally {
    // 先把計數歸零再放鎖：就算放鎖本身拋錯，這一次執行之後的呼叫亦不會以為仍然拿着鎖。
    SCRIPT_LOCK_DEPTH_ = 0;
    flushAndReleaseLock_(lock);
  }
}

/**
 * 用途：D12：這一次執行是不是已經拿着指令碼鎖（給測試與說明用；寫入路徑不需要問，直接叫
 *   `withScriptLock_()` 即可）。
 * Args: （無）
 * Returns:
 *   {boolean}
 * Raises:
 *   （無）
 */
function scriptLockHeldInThisExecution_() {
  return SCRIPT_LOCK_DEPTH_ > 0;
}

/**
 * 用途：D12／D13：拿不到指令碼鎖時給填寫介面的一句（儲存、還原、重設、由職事表重新取數共用開頭）。
 *   純函式。
 * Args:
 *   waitMs {number} 等了幾多毫秒。
 *   retryHint {string} 最後一句，講下一步（例如「你的改動仍在畫面上，請稍等再按「儲存」。」）。
 * Returns:
 *   {Error} `code` 是 `'LOCK_TIMEOUT'`；未拋出，由呼叫方決定拋不拋。
 * Raises:
 *   （無）
 */
function buildLockTimeoutError_(waitMs, retryHint) {
  var err = new Error('另一個寫入動作（例如另一次儲存、匯入或發佈）正在執行中，'
    + Math.round(Number(waitMs) / 1000) + ' 秒內等不到，所以這一次一格都沒有寫。' + String(retryHint || ''));
  err.code = 'LOCK_TIMEOUT';
  return err;
}
