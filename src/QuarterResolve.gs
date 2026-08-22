/**
 * QuarterResolve.gs
 *
 * 「本季」季度 ID 推算的**單一真相來源**。
 *
 * 背景：職事表沒有 2026 年的資料時，原本「完成度自我檢測」用「下一個要寄
 * 的主日」推算季度會失敗，而且「PersonDisplay 尊稱未設定人數」與「本季
 * 待填欄位總數」兩項各自又重新推算一次（`docs/已知bug類型.md` 第 3 類：
 * 同一個狀態有兩個真相來源）。本檔案把整套推算收歸 `resolveWorkingQuarter_()`
 * 一處，所有需要「本季是哪一季」的地方一律呼叫這一個函式，不可以自己
 * 另外猜。
 *
 * ⚠️ 唯讀：本檔案全部函式只讀取（`getConfig`／`readSheet`／職事表快照），
 * 不寫入任何資料。
 */

'use strict';

/**
 * 用途：`resolveWorkingQuarter_()` 各層推算次序的識別碼，供呼叫方判斷
 *   `source` 欄位、供報告文字對照 `sourceLabel`。寫成函式延遲求值，理由
 *   同其餘 seed／設定小工具（見 docs/已知bug類型.md 事故一）。
 * Args: （無）
 * Returns:
 *   {Object<string,string>} `source` 值 → 中文說明。
 */
function quarterResolveSourceLabels_() {
  return {
    CONFIG_OVERRIDE: '設定值 WORKING_QUARTER_ID 指定',
    NEXT_SEND_SUNDAY: '下一個要寄的主日推算',
    ROSTER_TEST_DATE: '設定值 ROSTER_TEST_DATE 推算',
    BULLETIN_WEEKS_LATEST: 'BulletinWeeks 現有資料推算'
  };
}

/**
 * 用途：嚴格檢查一個字串是不是 `yyyy-MM-dd` 形狀（純格式檢查，不驗證
 *   月份／日數是否真的存在，例如 `2027-13-40` 這裡會判定合法——留給
 *   下游「這個日期在職事表找不找得到」自然過濾）。
 * Args:
 *   raw {*} 任意值。
 * Returns:
 *   {boolean}
 */
function isIsoDateShape_(raw) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(raw || '').trim());
}

/**
 * 用途：把一個工作表讀出來的日期欄位值換算成毫秒時間戳，供「哪個季度
 *   最接近今日」排序用。**純函式**。
 *
 *   ⚠️ `readSheet()` 依欄位型別把 DATE 欄轉成 `Date` 物件，但寬鬆解析
 *   失敗（或測試直接塞字串）時可能仍然是字串——兩種都要處理（見
 *   `docs/已知bug類型.md` 第 4 類）。
 * Args:
 *   v {*} `readSheet()` 某一格 DATE 欄的值。
 * Returns:
 *   {?number} 換算不出來（`null`／`undefined`／格式不符）回 `null`。
 */
function dateCellToTime_(v) {
  if (v instanceof Date) {
    if (isNaN(v.getTime())) return null;
    return v.getTime();
  }
  if (typeof v === 'string') {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v.trim());
    if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
  }
  return null;
}

/**
 * 用途：把一個 `yyyy-MM-dd` 字串換算成毫秒時間戳。**純函式**。
 * Args:
 *   isoDate {string} yyyy-MM-dd。
 * Returns:
 *   {?number} 格式不符回 `null`。
 */
function isoDateToTime_(isoDate) {
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(isoDate || '').trim());
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
}

/**
 * 用途：`resolveWorkingQuarter_()` 第 4 層（`BULLETIN_WEEKS_LATEST`）的
 *   純函式核心——在 `BulletinWeeks` 現有資料裡，找「主日數目最多、且
 *   最接近今日」的季度。**純函式**，方便單獨測試排序規則。
 * Args:
 *   rows {Object[]} `readSheet(SHEETS.BULLETIN_WEEKS)` 的輸出，每個元素
 *     至少要有 `QUARTER_ID`／`SERVICE_DATE`。
 *   todayIso {string} 今天的日期，yyyy-MM-dd，用來算「最接近」。
 * Returns:
 *   {{quarterId:string, count:number}} 找不到任何季度時 `quarterId` 是
 *     空字串、`count` 是 `0`。
 */
function pickLatestBulletinWeeksQuarter_(rows, todayIso) {
  var todayTime = isoDateToTime_(todayIso);
  var byQuarter = {};

  (rows || []).forEach(function (r) {
    var qid = String((r && r.QUARTER_ID) || '').trim();
    if (!qid) return;
    if (!byQuarter[qid]) byQuarter[qid] = { count: 0, minDiff: Infinity };
    byQuarter[qid].count++;

    var t = dateCellToTime_(r.SERVICE_DATE);
    if (t !== null && todayTime !== null) {
      var diff = Math.abs(t - todayTime);
      if (diff < byQuarter[qid].minDiff) byQuarter[qid].minDiff = diff;
    }
  });

  var ids = Object.keys(byQuarter);
  if (ids.length === 0) return { quarterId: '', count: 0 };

  ids.sort(function (a, b) {
    if (byQuarter[b].count !== byQuarter[a].count) return byQuarter[b].count - byQuarter[a].count;
    return byQuarter[a].minDiff - byQuarter[b].minDiff;
  });

  var best = ids[0];
  return { quarterId: best, count: byQuarter[best].count };
}

/**
 * 用途：按一個主日日期，向職事表反查「這個日期屬於哪一季」——**沿用**
 *   `readRosterSnapshot_()`（`src/RosterRead.gs`）既有的日期查季度邏輯，
 *   不重寫。任何錯誤（職事表未設定、讀取失敗、日期在職事表找不到）
 *   一律轉成 `{ok:false, reason}`，不拋出去。
 * Args:
 *   isoDate {string} 主日日期，yyyy-MM-dd。
 * Returns:
 *   {{ok:boolean, quarterId:string, reason:string}} `ok=false` 時
 *     `quarterId` 是空字串，`reason` 是中文說明。
 */
function tryResolveQuarterForIsoDate_(isoDate) {
  try {
    var snapshot = readRosterSnapshot_(isoDate);
    if (snapshot.notConfigured) {
      return { ok: false, quarterId: '', reason: '職事表試算表尚未設定（ROSTER_SPREADSHEET_ID 是空的）。' };
    }
    if (!snapshot.found || !snapshot.quarterId) {
      return { ok: false, quarterId: '', reason: '在職事表 ServiceDates 找不到這個日期。' };
    }
    return { ok: true, quarterId: snapshot.quarterId, reason: '' };
  } catch (err) {
    return { ok: false, quarterId: '', reason: '職事表讀取失敗：' + ((err && err.message) ? err.message : String(err)) };
  }
}

/**
 * 用途：檢查一個季度 ID 是不是真的在職事表 `ServiceDates` 有資料——
 *   **沿用** `listRosterServiceDatesForQuarter_()`，不重寫查表邏輯。
 *   職事表未設定／讀取失敗一律當成「存在與否無法確認」，回 `false`
 *   並附上原因，不拋錯（呼叫方決定要不要仍然採用）。
 * Args:
 *   quarterId {string} 季度 ID。
 * Returns:
 *   {{exists:boolean, reason:string}} `exists=true` 時 `reason` 是空字串。
 */
function checkQuarterExistsInRoster_(quarterId) {
  try {
    var dates = listRosterServiceDatesForQuarter_(quarterId);
    if (dates.length === 0) return { exists: false, reason: '在職事表找不到任何屬於這一季的主日。' };
    return { exists: true, reason: '' };
  } catch (err) {
    return { exists: false, reason: '職事表讀取失敗，無法確認：' + ((err && err.message) ? err.message : String(err)) };
  }
}

/**
 * 用途：「本季」季度 ID 推算的**單一真相來源**、真正入口。按次序試四層，
 *   任何一層需要的資料讀不到／推算失敗都不拋錯，改記一句中文 note 並
 *   繼續退到下一層；全部呼叫方（完成度自我檢測、各選單預設值）一律
 *   呼叫這一個函式，不可以自己另外推算一次。
 *
 *   四層推算次序：
 *     1. `CONFIG_OVERRIDE`——Config `WORKING_QUARTER_ID` 有值就直接採用，
 *        即使該季在職事表找不到也採用（但會記警告 note）。
 *     2. `NEXT_SEND_SUNDAY`——由「下一個要寄的主日」反查職事表；反查
 *        失敗（職事表沒有這一季的資料）就退到下一層。
 *        ⚠️ 「下一個要寄的主日」的定義只有一份，在
 *        `resolveNextSendSundayIso_()`（src/SendSchedule.gs）——這一層
 *        經 `guessNextBulletinSendIso_()` 叫落去，**不可以**自己另外
 *        算一次，見 docs/已知bug類型.md 事故三十。
 *     3. `ROSTER_TEST_DATE`——由 Config `ROSTER_TEST_DATE` 反查職事表。
 *        `getConfig()` 已經把 Config 儲存格的 `Date` 物件正規化成
 *        `yyyy-MM-dd` 字串（見 `src/ConfigService.gs` 的
 *        `coerceConfigRawValue_()`），這裡只需要再擋一次「人手打的文字
 *        不是 yyyy-MM-dd 形狀」（例如 `7/11/2027`）。
 *     4. `BULLETIN_WEEKS_LATEST`——最後防線：`BulletinWeeks` 現有資料裡
 *        主日數最多、且最接近今日的季度（`pickLatestBulletinWeeksQuarter_()`）。
 *     全部失敗 → `ok:false`，`notes` 附上四層各自的失敗原因。
 * Args: （無）
 * Returns:
 *   {{ok:boolean, quarterId:string, source:string, sourceLabel:string,
 *     basisDate:(Date|null), notes:string[]}} `ok=false` 時
 *     `quarterId`／`source`／`sourceLabel` 是空字串、`basisDate` 是
 *     `null`。`notes` 逐句中文，記錄每一層試過什麼、為何不成功／成功。
 * Raises:
 *   （不拋出例外——這是本函式的硬性要求，任何一層出錯都轉成 note。）
 */
function resolveWorkingQuarter_() {
  var notes = [];
  var labels = quarterResolveSourceLabels_();

  function done(source, quarterId, basisIso) {
    return {
      ok: true, quarterId: quarterId, source: source, sourceLabel: labels[source],
      basisDate: basisIso ? new Date(isoDateToTime_(basisIso)) : null, notes: notes
    };
  }

  // ---- 第 1 層：CONFIG_OVERRIDE ----
  var override = String(getConfig(CONFIG_KEYS.WORKING_QUARTER_ID, '') || '').trim();
  if (override) {
    var existCheck = checkQuarterExistsInRoster_(override);
    if (!existCheck.exists) {
      notes.push('設定值 WORKING_QUARTER_ID 指定的季度「' + override + '」在職事表找不到（' + existCheck.reason + '），仍然採用設定值。');
    } else {
      notes.push('設定值 WORKING_QUARTER_ID 指定季度「' + override + '」，職事表確認存在。');
    }
    return done('CONFIG_OVERRIDE', override, null);
  }
  notes.push('設定值 WORKING_QUARTER_ID 是空的，略過這一層。');

  // ---- 第 2 層：NEXT_SEND_SUNDAY ----
  var nextIso = guessNextBulletinSendIso_();
  if (nextIso) {
    var r2 = tryResolveQuarterForIsoDate_(nextIso);
    if (r2.ok) {
      notes.push('下一個要寄的主日（' + nextIso + '）在職事表找到季度「' + r2.quarterId + '」。');
      return done('NEXT_SEND_SUNDAY', r2.quarterId, nextIso);
    }
    notes.push('下一個要寄的主日（' + nextIso + '）推算失敗：' + r2.reason);
  } else {
    notes.push('無法猜出下一個要寄的主日（Config SYS_TIMEZONE 可能有誤），略過這一層。');
  }

  // ---- 第 3 層：ROSTER_TEST_DATE ----
  var testDateRaw = String(getConfig(CONFIG_KEYS.ROSTER_TEST_DATE, '') || '').trim();
  if (!testDateRaw) {
    notes.push('設定值 ROSTER_TEST_DATE 是空的，略過這一層。');
  } else if (!isIsoDateShape_(testDateRaw)) {
    notes.push('設定值 ROSTER_TEST_DATE（' + testDateRaw + '）格式不符，需要 yyyy-MM-dd，略過這一層。');
  } else {
    var r3 = tryResolveQuarterForIsoDate_(testDateRaw);
    if (r3.ok) {
      notes.push('改用設定值 ROSTER_TEST_DATE（' + testDateRaw + '），在職事表找到季度「' + r3.quarterId + '」。');
      return done('ROSTER_TEST_DATE', r3.quarterId, testDateRaw);
    }
    notes.push('設定值 ROSTER_TEST_DATE（' + testDateRaw + '）推算失敗：' + r3.reason);
  }

  // ---- 第 4 層：BULLETIN_WEEKS_LATEST ----
  var timezone = getConfig(CONFIG_KEYS.SYS_TIMEZONE, 'Pacific/Auckland');
  var todayIso = Utilities.formatDate(new Date(), timezone, 'yyyy-MM-dd');
  var latest = pickLatestBulletinWeeksQuarter_(readSheet(SHEETS.BULLETIN_WEEKS), todayIso);
  if (latest.quarterId) {
    notes.push('改用 BulletinWeeks 現有資料，主日數最多且最接近今日的季度是「' + latest.quarterId + '」（' + latest.count + ' 個主日）。');
    return done('BULLETIN_WEEKS_LATEST', latest.quarterId, null);
  }
  notes.push('BulletinWeeks 沒有任何有季度 ID 的資料，四層全部失敗。');

  return { ok: false, quarterId: '', source: '', sourceLabel: '', basisDate: null, notes: notes };
}
