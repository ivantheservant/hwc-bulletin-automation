/**
 * RosterBackfill.gs
 *
 * R-036：職事表未有該季資料時，仍然建立得到週報；之後職事表準備好，
 * 再撳「補抓空白的事奉欄位」把空格補回去。
 *
 * ⚠️ 為什麼要這樣做（docs/已知bug類型.md 事故四十）：
 *   舊版「建立本季週報」在職事表找不到該季就整個中止。但週報有大量與
 *   事奉無關的欄位（講題、詩歌、家事報告、人數）本來就填得——把整件事
 *   卡死，等於因為一部分資料未到而令全部工作開始不到。
 *
 *   `ErrorLog` 有一筆 2026-08-24 的實際紀錄：星期一觸發器拋
 *   `ROSTER_NOT_FOUND` 然後停手，那一期完全沒有寄出。
 *
 * ⚠️ **職事表仍然是唯讀。** 這個檔案只改「讀不到的時候怎樣處理」，
 *   一格都不會寫進職事表。
 *
 * ⚠️ 補抓**只填空白格**，不覆寫人手已填的值。判斷準則是「那一格現在是不是
 *   空的」——不是「與快照不同就覆寫」。人手填過的東西，系統沒有資格改。
 */

'use strict';

/**
 * 用途：用曆法推算一個季度內全部星期日。**純函式。**
 *
 *   ⚠️ 這是「職事表未有該季資料」時唯一的主日來源。季度定義沿用本專案的
 *   慣例：`YYYYTn`，第 n 季 ＝ 第 (n-1)*3 至 (n-1)*3+2 個月（0 起算）。
 * Args:
 *   quarterId {string} `YYYYTn`。
 * Returns:
 *   {string[]} `yyyy-MM-dd`，由小到大；季度格式不對回空陣列（**不拋錯**——
 *     呼叫方要分得出「格式不對」與「真的沒有主日」，兩者都回空陣列時由
 *     呼叫方自己先驗格式）。
 */
function quarterCalendarSundays_(quarterId) {
  var m = /^(\d{4})T(\d)$/.exec(String(quarterId || '').trim());
  if (!m) return [];

  var year = Number(m[1]);
  var term = Number(m[2]);
  if (term < 1 || term > 4) return [];

  var startMonth = (term - 1) * 3;          // 0 起算
  var cursor = new Date(year, startMonth, 1);
  var endExclusive = new Date(year, startMonth + 3, 1);

  // 推到該季第一個星期日。
  cursor.setDate(cursor.getDate() + ((7 - cursor.getDay()) % 7));

  var dates = [];
  while (cursor.getTime() < endExclusive.getTime()) {
    dates.push(formatIsoDate_(cursor));
    cursor.setDate(cursor.getDate() + 7);
  }
  return dates;
}

/**
 * 用途：拿一個季度的主日清單，並講明**來源**。
 *
 *   ⚠️ 「來自職事表」與「曆法推算」是兩件事，一定要分得出：前者代表事奉
 *   資料有機會齊全，後者代表整季職事表都未有。回一個沒有來源標記的清單，
 *   下游就講不出 `ROSTER_STATUS` 應該是 `OK` 還是 `NOT_FOUND`。
 * Args:
 *   quarterId {string} `YYYYTn`。
 * Returns:
 *   {{dates:string[], source:string, rosterDates:string[], message:string}}
 *     `source` 是 `ROSTER`／`CALENDAR`。`rosterDates` 是職事表真的有的那幾個
 *     （`CALENDAR` 時是空陣列），供逐行判斷 `PARTIAL` 用。
 */
function resolveQuarterServiceDates_(quarterId) {
  var qid = String(quarterId || '').trim();
  var rosterDates = [];
  var message = '';

  try {
    rosterDates = listRosterServiceDatesForQuarter_(qid) || [];
  } catch (err) {
    rosterDates = [];
    message = '讀職事表時拋錯：' + ((err && err.message) ? err.message : String(err));
  }

  if (rosterDates.length > 0) {
    return { dates: rosterDates.slice(), source: 'ROSTER', rosterDates: rosterDates.slice(), message: message };
  }

  var calendar = quarterCalendarSundays_(qid);
  return {
    dates: calendar,
    source: 'CALENDAR',
    rosterDates: [],
    message: message || '職事表未有季度「' + qid + '」的資料，主日清單由曆法推算（該季全部星期日）。'
  };
}

/**
 * 用途：判斷某一個主日的 `ROSTER_STATUS`。**純函式。**
 * Args:
 *   isoDate {string} 主日。
 *   resolution {Object} `resolveQuarterServiceDates_()` 的輸出。
 * Returns:
 *   {string} `ROSTER_STATUS` 其中一個值。
 */
function rosterStatusForDate_(isoDate, resolution) {
  var r = resolution || { source: 'CALENDAR', rosterDates: [] };
  if (r.source !== 'ROSTER') return ROSTER_STATUS.NOT_FOUND;
  var list = r.rosterDates || [];
  return list.indexOf(String(isoDate)) !== -1 ? ROSTER_STATUS.OK : ROSTER_STATUS.PARTIAL;
}

/**
 * 用途：「補抓」會去填的欄位。**單一真相來源。**
 *
 *   ⚠️ 「補抓」只會碰這幾個欄位。講題、詩歌、人數這些是人手填的，
 *   補抓一格都不可以動——所以清單要寫得出來，不可以靠「除了那幾個以外
 *   全部都補」這種反向定義（日後加欄位就會靜靜補錯東西）。
 *
 *   ⚠️ **這不是「有值就代表讀過職事表」的清單。** 其中兩欄就算職事表
 *   完全沒有這一季都一定有值（`WEEK_OF_MONTH` 由日期算、
 *   `PROGRAM_TEMPLATE_ID` 退回 Config 預設值）。要證明「有沒有真的讀過
 *   職事表」，用 `rosterOnlyWeekFieldKeys_()`。
 * Args: （無）
 * Returns:
 *   {string[]}
 */
function rosterDerivedWeekFieldKeys_() {
  return ['WEEK_OF_MONTH', 'SPECIAL_TYPE', 'PROGRAM_TEMPLATE_ID'];
}

/**
 * 用途：`BulletinWeeks` 之中**只可能來自職事表**的欄位。
 *
 *   ⚠️ 為什麼要跟 `rosterDerivedWeekFieldKeys_()` 分開，是查證過才知道的
 *   （2026-08-26，見 docs/待確認事項.md V-1）：
 *
 *   `rosterDerivedWeekFieldKeys_()` 那三欄是「補抓會去填的欄位」，不等於
 *   「有值就代表讀過職事表」。實際上：
 *     - `WEEK_OF_MONTH` 由**日期本身**算出來（`Math.floor((日-1)/7)+1`），
 *       職事表有沒有這一季都一定有值；
 *     - `PROGRAM_TEMPLATE_ID` 找不到特別主日時退回 Config `TEMPLATE_DEFAULT`，
 *       所以也一定有值。
 *
 *   把那兩欄當成「事奉資料」，會得出「職事表沒有這一季，卻有 26 格事奉
 *   資料」這種**假警報**——真相是 13 行 × 那兩欄。要證明「有沒有讀過
 *   職事表」，只可以看這裏這一份。
 * Args: （無）
 * Returns:
 *   {string[]}
 */
function rosterOnlyWeekFieldKeys_() {
  return ['SPECIAL_TYPE'];
}

/**
 * 用途：由主日日期用**曆法**推算它屬於哪一個季度。**純函式。**
 *
 *   ⚠️ 這一支刻意不讀職事表、也不讀 `BulletinWeeks`：I11 要拿它去對
 *   `QUARTER_ID` 有沒有寫錯，驗證方與被驗方用同一個來源就會一齊錯、
 *   一齊報沒事（見 docs/已知bug類型.md 事故二十二）。
 * Args:
 *   isoDate {string} 主日日期，yyyy-MM-dd。
 * Returns:
 *   {?string} `YYYYTn`；日期格式不對回 `null`。
 */
function calendarQuarterIdForIsoDate_(isoDate) {
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(isoDate || '').trim());
  if (!m) return null;
  var month = Number(m[2]);
  if (month < 1 || month > 12) return null;
  return m[1] + 'T' + (Math.floor((month - 1) / 3) + 1);
}

/**
 * 用途：由職事表快照算出某一個主日**應該**有的那幾格值。
 * Args:
 *   isoDate {string} 主日。
 *   templateConfig {Object} `resolveProgramTemplateId_()` 用的設定。
 * Returns:
 *   {{ok:boolean, values:Object, message:string}}
 *     `ok:false` 代表職事表仍然找不到這一個主日。
 */
function rosterDerivedValuesForDate_(isoDate, templateConfig) {
  var snapshot;
  try {
    snapshot = readRosterSnapshot_(isoDate);
  } catch (err) {
    return {
      ok: false, values: {},
      message: '讀職事表時拋錯：' + ((err && err.message) ? err.message : String(err))
    };
  }

  if (!snapshot || snapshot.found !== true) {
    return { ok: false, values: {}, message: '職事表仍然找不到 ' + isoDate + ' 的資料。' };
  }

  var resolved = resolveProgramTemplateId_({}, snapshot, templateConfig);
  return {
    ok: true,
    values: {
      WEEK_OF_MONTH: snapshot.weekOfMonth,
      SPECIAL_TYPE: snapshot.special ? snapshot.special.title : '',
      PROGRAM_TEMPLATE_ID: resolved.templateId
    },
    message: ''
  };
}

/**
 * 用途：判斷一格是不是「空的」（補抓只填空格）。**純函式。**
 *
 *   ⚠️ `0` 不算空。`WEEK_OF_MONTH` 是數字，寫成 `if (!value)` 的話
 *   第 0 週（不存在，但日後改定義就會有）會被當成空格覆寫。
 * Args:
 *   value {*}
 * Returns:
 *   {boolean}
 */
function isBlankWeekCell_(value) {
  if (value === null || value === undefined) return true;
  if (typeof value === 'number') return false;
  return String(value).trim() === '';
}

/**
 * 用途：「補抓空白的事奉欄位」的**真正入口**：把該季 `BulletinWeeks` 內由職事表
 *   來的空格補回去，並更新 `ROSTER_STATUS`。
 *
 *   ⚠️ **只填空格**。人手已經填過的值一格都不會動——所以這一支可以隨時
 *   重跑，跑幾多次都不會蓋走任何東西。
 *
 *   ⚠️ 職事表仍然找不到的時候回 `ok:true` 加一句明確訊息，**不拋原始例外**
 *   ——「未到」不是錯誤，而且拋 Apps Script 的原始例外對幹事完全沒有用。
 * Args:
 *   quarterId {string} 季度 ID。
 * Returns:
 *   {{ok:boolean, quarterId:string, filled:number, stillBlank:number,
 *     rowsTouched:number, statusBefore:Object, statusAfter:Object,
 *     rosterFound:boolean, message:string}}
 *     `statusBefore`／`statusAfter` 是 `{OK:n, NOT_FOUND:n, PARTIAL:n}`。
 */
function backfillRosterForQuarter_(quarterId) {
  var qid = String(quarterId || '').trim();
  var empty = {
    ok: false, quarterId: qid, filled: 0, stillBlank: 0, rowsTouched: 0,
    statusBefore: {}, statusAfter: {}, rosterFound: false, message: ''
  };
  if (!qid) {
    empty.message = '季度 ID 不可以是空的。';
    return empty;
  }

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEETS.BULLETIN_WEEKS);
  if (!sheet) {
    empty.message = '找不到 ' + SHEETS.BULLETIN_WEEKS + ' 工作表，請先執行「初始化工作表」。';
    return empty;
  }

  var def = COLUMNS.BULLETIN_WEEKS;
  var allRows = readSheet(SHEETS.BULLETIN_WEEKS);
  var targets = [];
  allRows.forEach(function (row, index) {
    if (String(row.QUARTER_ID || '').trim() !== qid) return;
    targets.push({ row: row, rowNo: index + 3 });
  });

  if (targets.length === 0) {
    empty.ok = true;
    empty.message = '季度「' + qid + '」在 ' + SHEETS.BULLETIN_WEEKS
      + ' 一行都沒有，沒有東西可以補。請先撳「建立本季空白週報」。';
    return empty;
  }

  var resolution = resolveQuarterServiceDates_(qid);
  var templateConfig = {
    baptismKeywords: getConfigTextList_(CONFIG_KEYS.TEMPLATE_KEYWORDS_BAPTISM, '浸禮'),
    anniversaryKeywords: getConfigTextList_(CONFIG_KEYS.TEMPLATE_KEYWORDS_ANNIVERSARY, '堂慶,週年'),
    templateDefault: getConfig(CONFIG_KEYS.TEMPLATE_DEFAULT, 'TPL_NORMAL')
  };
  var fieldKeys = rosterDerivedWeekFieldKeys_();

  var statusBefore = countRosterStatuses_(targets.map(function (t) { return t.row; }));
  var filled = 0;
  var stillBlank = 0;
  var rowsTouched = 0;
  var auditNotes = [];

  targets.forEach(function (target) {
    var isoDate = formatIsoDate_(normalizeDate_(target.row.SERVICE_DATE) || new Date());
    var derived = rosterDerivedValuesForDate_(isoDate, templateConfig);
    var touched = false;

    fieldKeys.forEach(function (key) {
      var current = target.row[key];
      if (!isBlankWeekCell_(current)) return;      // ⚠️ 人手填過的一格都不動

      if (!derived.ok) { stillBlank++; return; }
      var value = derived.values[key];
      if (isBlankWeekCell_(value)) { stillBlank++; return; }

      setCellValueTextSafe_(sheet, def, target.rowNo, key,
        typeof value === 'number' ? value : sanitizeCellText_(value));
      filled++;
      touched = true;
    });

    var statusAfterRow = derived.ok
      ? ROSTER_STATUS.OK
      : rosterStatusForDate_(isoDate, resolution);
    if (String(target.row.ROSTER_STATUS || '') !== statusAfterRow) {
      setCellValueTextSafe_(sheet, def, target.rowNo, 'ROSTER_STATUS', statusAfterRow);
      touched = true;
    }

    if (touched) {
      rowsTouched++;
      auditNotes.push(isoDate + '→' + statusAfterRow);
    }
  });

  var afterRows = readSheet(SHEETS.BULLETIN_WEEKS).filter(function (r) {
    return String(r.QUARTER_ID || '').trim() === qid;
  });
  var statusAfter = countRosterStatuses_(afterRows);

  if (rowsTouched > 0) {
    appendAuditLog_({
      action: 'ROSTER_BACKFILL', sheetName: SHEETS.BULLETIN_WEEKS,
      rowKey: qid, field: 'ROSTER_STATUS',
      oldValue: describeRosterStatusCounts_(statusBefore),
      newValue: describeRosterStatusCounts_(statusAfter),
      notes: '補抓空白的事奉欄位：補了 ' + filled + ' 格，動了 ' + rowsTouched + ' 行。'
        + '⚠️ 只填空白格，人手填過的一格都沒有改。' + auditNotes.slice(0, 12).join('、')
    });
  }

  return {
    ok: true,
    quarterId: qid,
    filled: filled,
    stillBlank: stillBlank,
    rowsTouched: rowsTouched,
    statusBefore: statusBefore,
    statusAfter: statusAfter,
    rosterFound: resolution.source === 'ROSTER',
    message: buildRosterBackfillMessage_({
      quarterId: qid, filled: filled, stillBlank: stillBlank,
      statusBefore: statusBefore, statusAfter: statusAfter,
      rosterFound: resolution.source === 'ROSTER', resolutionMessage: resolution.message
    })
  };
}

/**
 * 用途：數一批 `BulletinWeeks` 行的 `ROSTER_STATUS` 分佈。**純函式。**
 *
 *   ⚠️ 沒有值的一律當成 `OK`——那是加欄之前的舊資料，而舊資料一定是在
 *   職事表有資料的前提下建立的。當成 `NOT_FOUND` 的話，升級之後全部舊季度
 *   都會無故亮起黃色橫幅。
 * Args:
 *   rows {Object[]}
 * Returns:
 *   {{OK:number, NOT_FOUND:number, PARTIAL:number}}
 */
function countRosterStatuses_(rows) {
  var counts = { OK: 0, NOT_FOUND: 0, PARTIAL: 0, UNKNOWN: 0 };
  (rows || []).forEach(function (row) {
    // ⚠️ 空白**不可以**當成 OK。空白的意思是「從來沒有算過」，不是
    //    「算過而且沒事」——把它當成 OK，就等於一行從未查證過的資料
    //    在報告上看起來與一行查證過沒事的資料一模一樣。
    //
    //    真的發生過：舊版這一行寫 `... || ROSTER_STATUS.OK`，於是自測機
    //    S19 對一批 ROSTER_STATUS 從未寫入的資料列報「OK 13」，看起來
    //    像職事表讀到了；補抓之後變成「NOT_FOUND 13」，又看起來像補抓
    //    弄壞了東西。兩個結論都是錯的。見 docs/已知bug類型.md 事故四十一。
    var value = String(row.ROSTER_STATUS || '').trim() || 'UNKNOWN';
    if (counts[value] === undefined) counts[value] = 0;
    counts[value]++;
  });
  return counts;
}

/**
 * 用途：把狀態分佈講成一句。**純函式。**
 * Args:
 *   counts {Object}
 * Returns:
 *   {string}
 */
function describeRosterStatusCounts_(counts) {
  var c = counts || {};
  var text = 'OK ' + (c.OK || 0) + '、PARTIAL ' + (c.PARTIAL || 0)
    + '、NOT_FOUND ' + (c.NOT_FOUND || 0);
  // ⚠️ 「未算過」有 0 個時就不出——但只要有一個，一定要看得見。
  //    把它藏起來等於重蹈「空白當成 OK」那個覆轍。
  if ((c.UNKNOWN || 0) > 0) text += '、未算過 ' + c.UNKNOWN;
  return text;
}

/**
 * 用途：補抓完之後給人看的一段話。**純函式。**
 *
 *   ⚠️ 一定要講齊三樣：補了幾多格、仍然有幾多格空白、`ROSTER_STATUS`
 *   由什麼變什麼。只講「完成」的話，幹事不知道還要不要再等職事表。
 * Args:
 *   input {{quarterId:string, filled:number, stillBlank:number,
 *           statusBefore:Object, statusAfter:Object, rosterFound:boolean,
 *           resolutionMessage:string}}
 * Returns:
 *   {string}
 */
function buildRosterBackfillMessage_(input) {
  var lines = [];
  if (!input.rosterFound) {
    lines.push('職事表仍然未有季度「' + input.quarterId + '」的資料。');
    lines.push('已經補了 ' + input.filled + ' 格，仍有 ' + input.stillBlank + ' 格空白。');
    lines.push('職事表準備好之後，再撳一次「補抓空白的事奉欄位」就可以。'
      + '（隨時可以重試，不限次數；人手填過的一格都不會被覆寫。）');
  } else {
    lines.push('已經由職事表補了 ' + input.filled + ' 格。');
    lines.push('仍有 ' + input.stillBlank + ' 格空白'
      + (input.stillBlank > 0 ? '（那幾個主日在職事表仍然找不到）。' : '。'));
  }
  lines.push('職事表狀態：' + describeRosterStatusCounts_(input.statusBefore)
    + '　→　' + describeRosterStatusCounts_(input.statusAfter));
  lines.push('⚠️ 補抓只填空白格，人手填過的值一格都沒有改。');
  return lines.join('\n');
}

/**
 * 用途：列出仍然不是 `OK` 的季度，供「完成度自我檢測」用。
 * Args: （無）
 * Returns:
 *   {{quarterId:string, notFound:number, partial:number, unknown:number,
 *     total:number}[]} 由季度 ID 排序；全部都是 `OK` 時回空陣列。
 *
 *   ⚠️ `ROSTER_STATUS` 空白的行算**缺口**，不算 OK：空白代表從來沒有
 *   算過，而「沒有算過」正正是要提出來叫人去補的情況。
 */
function listQuartersWithRosterGaps_() {
  var byQuarter = {};
  readSheet(SHEETS.BULLETIN_WEEKS).forEach(function (row) {
    var qid = String(row.QUARTER_ID || '').trim();
    if (!qid) return;
    if (!byQuarter[qid]) {
      byQuarter[qid] = { quarterId: qid, notFound: 0, partial: 0, unknown: 0, total: 0 };
    }
    byQuarter[qid].total++;
    var status = String(row.ROSTER_STATUS || '').trim();
    if (status === ROSTER_STATUS.NOT_FOUND) byQuarter[qid].notFound++;
    else if (status === ROSTER_STATUS.PARTIAL) byQuarter[qid].partial++;
    else if (status !== ROSTER_STATUS.OK) byQuarter[qid].unknown++;
  });

  return Object.keys(byQuarter).sort().map(function (qid) { return byQuarter[qid]; })
    .filter(function (entry) {
      return entry.notFound > 0 || entry.partial > 0 || entry.unknown > 0;
    });
}

/**
 * 用途：某一個季度要不要顯示 UI 頂部那條黃色橫幅，以及橫幅寫什麼。
 * Args:
 *   quarterId {string}
 * Returns:
 *   {{show:boolean, text:string, notFound:number, partial:number,
 *     unknown:number}}
 *
 *   ⚠️ `ROSTER_STATUS` 空白（從來沒有算過）一樣要出橫幅。舊版把空白
 *   當成 OK，於是一批從未查證過的資料列在畫面上看起來完全正常。
 */
function rosterGapBannerForQuarter_(quarterId) {
  var qid = String(quarterId || '').trim();
  var counts = countRosterStatuses_(readSheet(SHEETS.BULLETIN_WEEKS).filter(function (row) {
    return String(row.QUARTER_ID || '').trim() === qid;
  }));
  var notFound = counts.NOT_FOUND || 0;
  var partial = counts.PARTIAL || 0;
  var unknown = counts.UNKNOWN || 0;

  if (notFound === 0 && partial === 0 && unknown === 0) {
    return { show: false, text: '', notFound: 0, partial: 0, unknown: 0 };
  }
  if (notFound > 0 && partial === 0 && unknown === 0) {
    return {
      show: true, notFound: notFound, partial: partial, unknown: unknown,
      text: '本季職事表未有資料，事奉欄位全部留空。職事表建立好之後，撳「補抓空白的事奉欄位」。'
    };
  }
  if (unknown > 0 && notFound === 0 && partial === 0) {
    return {
      show: true, notFound: notFound, partial: partial, unknown: unknown,
      text: '本季有 ' + unknown + ' 個主日**未查證過**職事表狀態（多數是舊資料）。'
        + '撳「補抓空白的事奉欄位」就會逐個查證並更新。'
    };
  }
  return {
    show: true, notFound: notFound, partial: partial, unknown: unknown,
    text: '本季有 ' + (notFound + partial + unknown) + ' 個主日在職事表找不到資料或未查證過，'
      + '那幾期的事奉欄位留空。職事表補齊之後，撳「補抓空白的事奉欄位」。'
  };
}

/**
 * 用途：選單「補抓空白的事奉欄位（整季，不覆寫已填的）」。
 * Returns:
 *   {void}
 */
function menuBackfillRoster_() {
  var ui = SpreadsheetApp.getUi();
  try {
    var resolution = resolveWorkingQuarter_();
    var defaultQuarter = resolution.ok ? resolution.quarterId : '';
    var resp = ui.prompt('補抓空白的事奉欄位',
      '⚠️ **不會覆寫你填過的任何一格。** 這一支只把「現在是空白」的事奉欄位，\n'
        + '用職事表的資料補回去；有值的一律不動，所以隨時可以重試，撳幾多次都一樣。\n\n'
        + '範圍：整個季度（不是單一主日）。\n'
        + '⚠️ 職事表全程唯讀，一格都不會寫進去。\n\n'
        + '（想看某一個主日最新的職事表內容而不寫入，請用填寫介面的\n'
        + '　「重讀職事表（本主日，不覆寫）」。）\n\n'
        + '要補哪一個季度？（直接按確定＝' + (defaultQuarter || '（未能決定）') + '）',
      ui.ButtonSet.OK_CANCEL);
    if (resp.getSelectedButton() !== ui.Button.OK) return;

    var quarterId = resp.getResponseText().trim() || defaultQuarter;
    if (!quarterId) {
      ui.alert('補抓空白的事奉欄位', '未能決定季度，請直接輸入季度 ID（例如 2027T4）。', ui.ButtonSet.OK);
      return;
    }

    var result = backfillRosterForQuarter_(quarterId);
    writeDiagnosticsReport_('補抓空白的事奉欄位', buildRosterBackfillReportLines_(result));
    ui.alert(result.ok ? '補抓完成' : '補抓失敗', result.message, ui.ButtonSet.OK);
  } catch (err) {
    logMenuError_('menuBackfillRoster_', err);
    ui.alert('補抓空白的事奉欄位失敗', enrichAuthError_(err), ui.ButtonSet.OK);
  }
}

/**
 * 用途：把補抓結果排成 `Diagnostics` 報告的內容行。
 *
 *   ⚠️ 區段標題一律用全形括號「【…】」（見 docs/已知bug類型.md 事故六）。
 * Args:
 *   result {Object} `backfillRosterForQuarter_()` 的輸出。
 * Returns:
 *   {string[]}
 */
function buildRosterBackfillReportLines_(result) {
  var lines = [];
  lines.push('【摘要】');
  lines.push('季度：' + result.quarterId);
  lines.push('職事表' + (result.rosterFound ? '找得到這一季' : '**仍然未有**這一季的資料'));
  lines.push('補了 ' + result.filled + ' 格，仍有 ' + result.stillBlank + ' 格空白，動了 '
    + result.rowsTouched + ' 行。');
  lines.push('');
  lines.push('【職事表狀態】');
  lines.push('補抓前：' + describeRosterStatusCounts_(result.statusBefore));
  lines.push('補抓後：' + describeRosterStatusCounts_(result.statusAfter));
  lines.push('');
  lines.push('【要知道的事】');
  lines.push('補抓只填**空白格**。人手填過的值一格都不會被覆寫，所以這個動作');
  lines.push('隨時可以重試，跑幾多次都不會蓋走任何東西。');
  lines.push('職事表全程唯讀，一格都不會寫進去。');
  if (!result.rosterFound) {
    lines.push('');
    lines.push('職事表建立好那一季之後，再撳一次「補抓空白的事奉欄位」就可以。');
  }
  return lines;
}
