/**
 * src/SpecialService.gs
 *
 * 特別崇拜（非主日，例如受苦節、除夕感恩崇拜；2026-10-30 Ivan 示範之後的要求）。
 *
 *   - 填寫介面按「建立特別崇拜…」：揀日期（不可以是主日）、填名稱。系統在 BulletinWeeks 加一行，
 *     `SERVICE_KIND`＝`SPECIAL`，`SPECIAL_TYPE`＝名稱，程序範本預設 Config `SPECIAL_SERVICE_TEMPLATE_DEFAULT`
 *     （TPL_NORMAL，介面可以改）。季度按日期本身（那一季要已經有主日的週報）。
 *   - 沒有職事表資料：事奉人員按主日的崗位清單在介面填（空行不印，Config `DUTY_PRINT_EMPTY_ROWS`）。
 *   - 讀經經文、證道講題、回應詩歌在介面填（平常主日這三欄只在內容表填）。
 *   - 家事報告、代禱事項、團契、財政報告、上週崇拜人數跟**上一個主日**（「內容來源主日」）：資料模型直接讀
 *     那一個主日的，不複製（上一個主日的內容表改了，特別崇拜的週報跟住改）。清單次序與拿走：這一行自己
 *     沒有安排就用上一個主日的。
 *   - 第 3 頁下週事奉＝下一個主日的職事表。
 *   - 不會自動寄出；內容表匯入、自動同步、職事表補資料、季度核對一律不理這一行。發佈只限當週。
 *   - 取消（2026-10-30 Ivan）：在那一期按「取消這個特別崇拜…」。**不刪行**：`SERVICE_KIND` 改為
 *     `SPECIAL_CANCELLED`；主日下拉不再顯示，載入、預覽、Word 一律講明已取消。內容保留：同一日再按
 *     「建立特別崇拜…」就恢復那一行（名稱用新填的）。已發佈或已寄出的不可以取消。
 *
 * 判斷一行是不是特別崇拜只有一處：`isSpecialServiceRow_()`（包括已取消的，所以平常主日的流程一律
 * 不理它）；是不是已取消只有一處：`isCancelledSpecialServiceRow_()`（bug class 3）。
 */

'use strict';

/** `BulletinWeeks.SERVICE_KIND` 的值：特別崇拜。留空＝平常的主日。 */
var SERVICE_KIND_SPECIAL_ = 'SPECIAL';

/** `BulletinWeeks.SERVICE_KIND` 的值：已取消的特別崇拜（不刪行；同一日再建立就恢復）。 */
var SERVICE_KIND_SPECIAL_CANCELLED_ = 'SPECIAL_CANCELLED';

/** 名稱最多幾個字（封面、程序表標題用；太長會撐爆版面）。 */
var SPECIAL_SERVICE_TITLE_MAX_ = 40;

/**
 * 用途：這一行 BulletinWeeks 是不是特別崇拜。純函式。
 * Args:
 *   row {?Object}
 * Returns:
 *   {boolean}
 */
function isSpecialServiceRow_(row) {
  var kind = serviceKindOf_(row);
  return kind === SERVICE_KIND_SPECIAL_ || kind === SERVICE_KIND_SPECIAL_CANCELLED_;
}

/**
 * 用途：這一行是不是**已取消**的特別崇拜。純函式。
 * Args:
 *   row {?Object}
 * Returns:
 *   {boolean}
 */
function isCancelledSpecialServiceRow_(row) {
  return serviceKindOf_(row) === SERVICE_KIND_SPECIAL_CANCELLED_;
}

/**
 * 用途：讀出 `SERVICE_KIND`（去頭尾空白、轉大寫）。純函式。
 * Args:
 *   row {?Object}
 * Returns:
 *   {string} 沒有這一行或這一欄回空字串。
 */
function serviceKindOf_(row) {
  if (!row) return '';
  var v = row.SERVICE_KIND;
  return String(v === null || v === undefined ? '' : v).trim().toUpperCase();
}

/**
 * 用途：寫入類動作（儲存、還原、重設、由職事表取數）之前核對這一期沒有被取消。IO 層。
 *   獨立審查 2026-10-30 第 6 項：另一個分頁仍然開着已取消的特別崇拜，按儲存不可以寫入那一行。
 * Args:
 *   isoDate {string}
 * Returns:
 *   {void}
 * Raises:
 *   Error（`code:'SPECIAL_SERVICE_CANCELLED'`）那一期已經取消。
 */
function assertWeekNotCancelled_(isoDate) {
  var row = findBulletinWeekRow_(readSheet_(SHEETS.BULLETIN_WEEKS), String(isoDate || '').trim());
  if (isCancelledSpecialServiceRow_(row)) throw cancelledSpecialServiceError_(String(isoDate || '').trim(), row);
}

/**
 * 用途：已取消的特別崇拜被載入（填寫介面、預覽、Word）時拋出的錯誤。純函式。
 * Args:
 *   isoDate {string}　row {Object} 那一行 BulletinWeeks。
 * Returns:
 *   {Error} `code:'SPECIAL_SERVICE_CANCELLED'`。
 */
function cancelledSpecialServiceError_(isoDate, row) {
  var err = new Error(isoDate + ' 的特別崇拜「' + String((row && row.SPECIAL_TYPE) || '') + '」已經取消。'
    + '要恢復的話，在填寫介面按「建立特別崇拜…」，選同一日再建立（之前填過的內容會保留）。');
  err.code = 'SPECIAL_SERVICE_CANCELLED';
  return err;
}

/**
 * 用途：某一日之前的那一個主日（不包括當日）。純函式。
 * Args:
 *   isoDate {string} yyyy-MM-dd。
 * Returns:
 *   {string} 格式不對回空字串。
 */
function previousSundayBeforeIso_(isoDate) {
  var time = isoDateToTime_(isoDate);
  if (time === null) return '';
  var d = new Date(time);
  var back = d.getDay() === 0 ? 7 : d.getDay();
  return formatIsoDate_(new Date(d.getFullYear(), d.getMonth(), d.getDate() - back));
}

/**
 * 用途：某一日之後的那一個主日（不包括當日）。純函式。
 * Args:
 *   isoDate {string} yyyy-MM-dd。
 * Returns:
 *   {string} 格式不對回空字串。
 */
function nextSundayAfterIso_(isoDate) {
  var time = isoDateToTime_(isoDate);
  if (time === null) return '';
  var d = new Date(time);
  return formatIsoDate_(new Date(d.getFullYear(), d.getMonth(), d.getDate() + (7 - d.getDay())));
}

/**
 * 用途：特別崇拜的「內容來源主日」（家事報告等跟這一個主日）。平常的主日回自己。純函式。
 * Args:
 *   weekRow {?Object} BulletinWeeks 那一行。
 *   isoDate {string}
 * Returns:
 *   {string}
 */
function contentSourceIsoForWeek_(weekRow, isoDate) {
  return isSpecialServiceRow_(weekRow) ? previousSundayBeforeIso_(isoDate) : String(isoDate || '');
}

/**
 * 用途：特別崇拜在填寫介面填、平常只在內容表填的欄（讀經經文、證道講題、回應詩歌）。由「崇拜程序」分頁定義
 *   衍生，不另抄。純函式。
 * Args: （無）
 * Returns:
 *   {string[]}
 */
function specialServiceUiWorshipKeys_() {
  return contentSheetWorshipTabDef_().keys.filter(function (k) { return k !== 'SERVICE_DATE' && k !== 'NOTES'; });
}

/**
 * 用途：這一日的週報是不是特別崇拜（讀 BulletinWeeks）。唯讀。
 * Args:
 *   isoDate {string}
 * Returns:
 *   {boolean} 沒有那一行回 false。
 * Raises:
 *   Error 讀工作表失敗時原樣拋出。
 */
function isSpecialServiceIsoDate_(isoDate) {
  return isSpecialServiceRow_(findBulletinWeekRow_(readSheet_(SHEETS.BULLETIN_WEEKS), isoDate));
}

/**
 * 用途：特別崇拜用的職事表快照：週次條件（聖餐、祈禱會週）一律不成立；職事表沒有這一日的話，按職事表的崗位清單
 *   （Posts，每個崗位 SlotCount 格）開空白格，給幹事在「本週事奉」逐格填（沒有名字的格不印，Config
 *   `DUTY_PRINT_EMPTY_ROWS`）。以前快照沒有任何一格，「本週事奉」顯示「沒有事奉資料」，事奉人員填不到
 *   （2026-10-30 瀏覽器自測）。純函式，不改傳入的快照。
 * Args:
 *   snapshot {Object} `readRosterSnapshot_()` 的回傳值。
 *   rosterOptions {{communionWeeks:number[], notApplicableRuleFlags:string[]}} `readRosterSnapshotOptions_()`。
 * Returns:
 *   {Object} 新的快照。
 */
function specialServiceRosterSnapshot_(snapshot, rosterOptions) {
  var o = rosterOptions || {};
  var out = Object.assign({}, snapshot, { weekOfMonth: null });
  if (out.found) return out;
  out.assignments = [];
  (out.posts || []).forEach(function (p) {
    var n = Math.max(1, Math.floor(Number(p.slotCount) || 1));
    for (var i = 1; i <= n; i++) {
      out.assignments.push({ postId: p.postId, slotIndex: i, personId: null, personName: '', assignSource: '',
        locked: false, ruleFlags: [] });
    }
  });
  out.slotsByPost = buildRosterSlotIndex_(out, o.communionWeeks || [], o.notApplicableRuleFlags || []);
  return out;
}

/**
 * 用途：讀一個日期的職事表快照；那一日是特別崇拜就套 `specialServiceRosterSnapshot_()`。資料模型、程序表即時預覽、
 *   事奉儲存、職事表比對都經這裏，免得各自判斷一次（bug class 3）。唯讀。
 * Args:
 *   isoDate {string}
 *   weekRow {?Object=} 這一日的 BulletinWeeks 行；省略就讀一次。
 * Returns:
 *   {Object}
 * Raises:
 *   Error 讀取失敗時原樣拋出。
 */
function readRosterSnapshotForWeek_(isoDate, weekRow) {
  var snapshot = readRosterSnapshot_(isoDate);
  var row = weekRow === undefined ? findBulletinWeekRow_(readSheet_(SHEETS.BULLETIN_WEEKS), isoDate) : weekRow;
  if (!isSpecialServiceRow_(row) || snapshot.notConfigured) return snapshot;
  return specialServiceRosterSnapshot_(snapshot, readRosterSnapshotOptions_());
}

/**
 * 用途：BulletinWeeks 的行剔走特別崇拜（季度的主日清單、自動同步、職事表補資料、季度核對用）。純函式。
 * Args:
 *   rows {Object[]}
 * Returns:
 *   {Object[]}
 */
function regularWeekRows_(rows) {
  return (rows || []).filter(function (r) { return !isSpecialServiceRow_(r); });
}

/**
 * 用途：算出「建立特別崇拜」會做甚麼（預覽與執行共用，bug class 120）。純函式。
 * Args:
 *   input {{isoDate:string, title:string, weekRows:Object[], templateId:string, defaults:Object}}
 *     `defaults` 是 `readBlankWeekSettings_().defaults`；`templateId` 是 Config `SPECIAL_SERVICE_TEMPLATE_DEFAULT`。
 * Returns:
 *   {{ok:boolean, reason:string, message:string, isoDate:string, title:string, sourceIso:string,
 *     nextSundayIso:string, quarterId:string, row:?Object, lines:string[]}}
 * Raises:
 *   （無）
 */
function planSpecialServiceCreate_(input) {
  var o = input || {};
  var iso = String(o.isoDate || '').trim();
  var title = String(o.title || '').replace(/\s+/g, ' ').trim();
  var out = { ok: false, reason: '', message: '', isoDate: iso, title: title, sourceIso: '', nextSundayIso: '',
    quarterId: '', row: null, lines: [] };
  function fail(reason, message) { out.reason = reason; out.message = message; return out; }

  var parsed = null;
  try { parsed = isIsoDateShape_(iso) ? normalizeDate_(iso) : null; } catch (err) { parsed = null; }
  if (!parsed || formatIsoDate_(parsed) !== iso) return fail('BAD_DATE', '日期要用 YYYY-MM-DD，例如 2027-03-26。');
  if (new Date(isoDateToTime_(iso)).getDay() === 0) {
    return fail('IS_SUNDAY', iso + ' 是主日。主日的週報由職事表與「建立本季週報」建立；特別崇拜只用於主日以外的日子。');
  }
  if (!title) return fail('NO_TITLE', '請填特別崇拜的名稱，例如「受苦節崇拜」。');
  if (title.length > SPECIAL_SERVICE_TITLE_MAX_) {
    return fail('TITLE_TOO_LONG', '名稱最多 ' + SPECIAL_SERVICE_TITLE_MAX_ + ' 個字（現在 ' + title.length + ' 個）。');
  }
  var rows = o.weekRows || [];
  var existing = findBulletinWeekRow_(rows, iso);
  // 2026-10-30：已取消的特別崇拜＝恢復那一行（不另外加一行，同一日只可以有一行）。
  var restoring = isCancelledSpecialServiceRow_(existing);
  if (existing && !restoring) return fail('EXISTS', iso + ' 已經有一期週報，不會再建立。');
  var sourceIso = previousSundayBeforeIso_(iso);
  var source = findBulletinWeekRow_(rows, sourceIso);
  if (!source) {
    return fail('NO_SOURCE_SUNDAY', '上一個主日（' + sourceIso + '）未有週報。特別崇拜的家事報告、代禱事項等跟上一個主日，'
      + '請先建立那一季的週報。');
  }
  if (isSpecialServiceRow_(source)) return fail('NO_SOURCE_SUNDAY', '上一個主日（' + sourceIso + '）的資料不正確（標記成特別崇拜）。');
  if (source.ARCHIVED === true) return fail('SOURCE_ARCHIVED', '上一個主日（' + sourceIso + '）的季度已經封存，不可以再建立特別崇拜。');

  // 季度按日期本身（與 Invariant I11 同一條規則）；那一季一定要已經有主日的週報——否則季度層面的流程
  //    （自動建立季度、建立本季週報）會把「只有一行特別崇拜」的季度當成已經建立。
  var quarterId = calendarQuarterIdForIsoDate_(iso) || '';
  var quarterHasSundays = rows.some(function (r) {
    return !isSpecialServiceRow_(r) && String(r.QUARTER_ID || '').trim() === quarterId;
  });
  if (!quarterHasSundays) {
    return fail('QUARTER_NOT_CREATED', iso + ' 屬於季度「' + quarterId + '」，但這一季未有主日的週報。請先建立這一季的週報，'
      + '再建立特別崇拜。');
  }

  var defaults = o.defaults || {};
  var templateId = String(o.templateId || '').trim();
  out.ok = true;
  out.sourceIso = sourceIso;
  out.nextSundayIso = nextSundayAfterIso_(iso);
  out.quarterId = quarterId;
  out.restore = restoring;
  if (restoring) {
    // 恢復只改這三格，其餘（事奉、讀經經文、程序等）保留取消之前的內容。
    out.row = { SERVICE_KIND: SERVICE_KIND_SPECIAL_, SPECIAL_TYPE: title, PAGE_TITLE: title };
    out.lines = [
      '恢復：' + iso + ' 之前建立過的特別崇拜「' + String(existing.SPECIAL_TYPE || '') + '」已經取消，這一次會恢復那一期。',
      '名稱：' + title + '（程序表大標題亦改用這個名稱，之後可以改）',
      '之前填過的事奉人員、讀經經文、講題與程序會保留。',
      '家事報告、代禱事項、團契、財政報告、上週崇拜人數：跟上一個主日（' + sourceIso + '）的內容表。',
      '第 3 頁下週事奉：下一個主日（' + out.nextSundayIso + '）的職事表。',
      '不會自動寄出；發佈只限當週。'
    ];
    return out;
  }
  out.row = {
    SERVICE_DATE: normalizeDate_(iso),
    QUARTER_ID: out.quarterId,
    WEEK_OF_MONTH: '',
    SPECIAL_TYPE: title,
    PAGE_TITLE: title,
    PROGRAM_TEMPLATE_ID: templateId,
    PRELUDE: defaults.prelude || '',
    ATTENDANCE_HEADING: defaults.attendanceHeading || '',
    NEXT_WEEK_HEADING: defaults.nextWeekHeading || '',
    PRAYER_BLOCK_HEADING: defaults.prayerBlockHeading || '',
    STATUS: BULLETIN_WEEK_STATUS.DRAFT,
    ROSTER_STATUS: '',
    SERVICE_KIND: SERVICE_KIND_SPECIAL_
  };
  out.lines = [
    '日期：' + iso + '（' + ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'][new Date(isoDateToTime_(iso)).getDay()] + '）',
    '名稱：' + title + '（程序表大標題亦用這個名稱，之後可以改）',
    '程序範本：' + (templateId || '（自動）') + '（之後可以在程序範本下拉改）',
    '季度：' + out.quarterId,
    '家事報告、代禱事項、團契、財政報告、上週崇拜人數：跟上一個主日（' + sourceIso + '）的內容表。',
    '事奉人員：職事表沒有這一日，請在「本週事奉」逐格填（沒有名字的崗位不印）。',
    '讀經經文、證道講題、回應詩歌：在這裏填（平常主日在內容表填）。',
    '第 3 頁下週事奉：下一個主日（' + out.nextSundayIso + '）的職事表。',
    '不會自動寄出；發佈只限當週。'
  ];
  return out;
}

/**
 * 用途：預覽「建立特別崇拜」。唯讀。
 * Args:
 *   isoDate {string}　title {string}
 * Returns:
 *   {Object} 同 `planSpecialServiceCreate_()`，不含 `row`。
 * Raises:
 *   Error 讀工作表失敗時原樣拋出。
 */
function previewSpecialServiceCreate_(isoDate, title) {
  var plan = planSpecialServiceCreate_(specialServicePlanInput_(isoDate, title));
  return Object.assign({}, plan, { row: null });
}

/**
 * 用途：讀出 `planSpecialServiceCreate_()` 要用的東西。唯讀。
 * Args:
 *   isoDate {string}　title {string}
 * Returns:
 *   {Object}
 */
function specialServicePlanInput_(isoDate, title) {
  return {
    isoDate: isoDate, title: title,
    weekRows: readSheet_(SHEETS.BULLETIN_WEEKS),
    templateId: getConfig_(CONFIG_KEYS.SPECIAL_SERVICE_TEMPLATE_DEFAULT, 'TPL_NORMAL'),
    defaults: readBlankWeekSettings_().defaults
  };
}

/**
 * 用途：建立特別崇拜（加一行 BulletinWeeks）。在指令碼鎖之內重新算一次計畫（與預覽同一支）。
 * Args:
 *   isoDate {string}　title {string}
 * Returns:
 *   {Object} 同 `planSpecialServiceCreate_()`（不含 `row`），另有 `created:boolean`。
 * Raises:
 *   Error（`code:'LOCK_TIMEOUT'`）拿不到鎖；寫入失敗原樣拋出。
 */
function createSpecialService_(isoDate, title) {
  return withScriptLock_('createSpecialService_', SAVE_LOCK_WAIT_MS_, function () {
    var plan = planSpecialServiceCreate_(specialServicePlanInput_(isoDate, title));
    if (!plan.ok) return Object.assign({}, plan, { row: null, created: false });
    if (plan.restore) {
      writeSpecialServiceRowCells_(plan.isoDate, plan.row, 'RESTORE_SPECIAL_SERVICE',
        '恢復已取消的特別崇拜「' + plan.title + '」（季度 ' + plan.quarterId + '）。');
      touchWeeksLastSavedAt_([plan.isoDate], new Date());
      return Object.assign({}, plan, { row: null, created: true });
    }
    writeSheet_(SHEETS.BULLETIN_WEEKS, [plan.row]);
    appendAuditLog_({
      action: 'CREATE_SPECIAL_SERVICE', sheetName: SHEETS.BULLETIN_WEEKS, rowKey: plan.isoDate,
      newValue: plan.title,
      notes: '建立特別崇拜「' + plan.title + '」（季度 ' + plan.quarterId + '；家事報告等跟 ' + plan.sourceIso
        + '；程序範本 ' + (plan.row.PROGRAM_TEMPLATE_ID || '自動') + '）。'
    });
    return Object.assign({}, plan, { row: null, created: true });
  }, function () {
    throw buildLockTimeoutError_(SAVE_LOCK_WAIT_MS_, '請稍等再按一次「建立特別崇拜」。');
  });
}

// =====================================================================
// 取消特別崇拜（2026-10-30 Ivan：先選那一期，再按「取消這個特別崇拜…」；不刪行）
// =====================================================================

/**
 * 用途：算出「取消特別崇拜」會做甚麼（預覽與執行共用）。純函式。
 * Args:
 *   input {{isoDate:string, weekRows:Object[], publishIndex:Object<string,number>}}
 *     `publishIndex` 是 `weekSelectorPublishIndex_()`（主日 → 已發佈的版本號）。
 * Returns:
 *   {{ok:boolean, reason:string, message:string, isoDate:string, title:string, sourceIso:string,
 *     lines:string[]}}
 *   `reason`：`BAD_DATE`／`NOT_FOUND`／`NOT_SPECIAL`／`ALREADY_CANCELLED`／`PUBLISHED`／`SENT`。
 * Raises:
 *   （無）
 */
function planSpecialServiceCancel_(input) {
  var o = input || {};
  var iso = String(o.isoDate || '').trim();
  var out = { ok: false, reason: '', message: '', isoDate: iso, title: '', sourceIso: '', lines: [] };
  function fail(reason, message) { out.reason = reason; out.message = message; return out; }

  if (!isIsoDateShape_(iso)) return fail('BAD_DATE', '日期要用 YYYY-MM-DD，例如 2027-03-26。');
  var row = findBulletinWeekRow_(o.weekRows || [], iso);
  if (!row) return fail('NOT_FOUND', iso + ' 沒有週報，沒有東西要取消。');
  if (!isSpecialServiceRow_(row)) {
    return fail('NOT_SPECIAL', iso + ' 是主日的週報，不可以取消；只有用「建立特別崇拜…」開的那一期才可以取消。');
  }
  out.title = String(row.SPECIAL_TYPE || '');
  if (isCancelledSpecialServiceRow_(row)) return fail('ALREADY_CANCELLED', '特別崇拜「' + out.title + '」（' + iso + '）已經取消。');
  var publishIndex = o.publishIndex || {};
  if (Object.prototype.hasOwnProperty.call(publishIndex, iso)) {
    return fail('PUBLISHED', '特別崇拜「' + out.title + '」（' + iso + '）已經發佈到 master 連結，不可以取消。'
      + '如果崇拜真的取消，請發佈另一期覆蓋 master 連結，並通知會眾。');
  }
  if (String(row.STATUS || '').trim() === BULLETIN_WEEK_STATUS.SENT) {
    return fail('SENT', '特別崇拜「' + out.title + '」（' + iso + '）已經寄出，不可以取消。');
  }
  out.ok = true;
  out.sourceIso = previousSundayBeforeIso_(iso);
  out.lines = [
    '取消特別崇拜「' + out.title + '」（' + iso + '）。',
    '週報那一行不會刪除，只會標記為已取消；主日下拉不再顯示這一期，預覽連結亦會顯示已取消。',
    '之前填過的內容會保留：要恢復的話，按「建立特別崇拜…」，選同一日再建立。',
    '取消之後會打開上一個主日（' + out.sourceIso + '）。'
  ];
  return out;
}

/**
 * 用途：讀出 `planSpecialServiceCancel_()` 要用的東西。唯讀。
 * Args:
 *   isoDate {string}
 * Returns:
 *   {Object}
 */
function specialServiceCancelInput_(isoDate) {
  return {
    isoDate: isoDate,
    weekRows: readSheet_(SHEETS.BULLETIN_WEEKS),
    publishIndex: weekSelectorPublishIndex_(readSheet_(SHEETS.PUBLISH_LOG))
  };
}

/**
 * 用途：預覽「取消特別崇拜」。唯讀。
 * Args:
 *   isoDate {string}
 * Returns:
 *   {Object} 同 `planSpecialServiceCancel_()`。
 */
function previewSpecialServiceCancel_(isoDate) {
  return planSpecialServiceCancel_(specialServiceCancelInput_(isoDate));
}

/**
 * 用途：取消特別崇拜：`SERVICE_KIND` 改為 `SPECIAL_CANCELLED`（不刪行）。在指令碼鎖之內重新算一次計畫。
 * Args:
 *   isoDate {string}
 * Returns:
 *   {Object} 同 `planSpecialServiceCancel_()`，另有 `cancelled:boolean`。
 * Raises:
 *   Error（`code:'LOCK_TIMEOUT'`）拿不到鎖；找不到那一行（計畫之後被改）或寫入失敗原樣拋出。
 */
function cancelSpecialService_(isoDate) {
  return withScriptLock_('cancelSpecialService_', SAVE_LOCK_WAIT_MS_, function () {
    var plan = planSpecialServiceCancel_(specialServiceCancelInput_(isoDate));
    if (!plan.ok) return Object.assign({}, plan, { cancelled: false });
    writeSpecialServiceRowCells_(plan.isoDate, { SERVICE_KIND: SERVICE_KIND_SPECIAL_CANCELLED_ }, 'CANCEL_SPECIAL_SERVICE',
      '取消特別崇拜「' + plan.title + '」（不刪行；同一日再建立會恢復）。');
    // 獨立審查第 6 項：更新最後儲存時間——另一個分頁仍然開着這一期的話，儲存會被樂觀鎖擋下。
    touchWeeksLastSavedAt_([plan.isoDate], new Date());
    return Object.assign({}, plan, { cancelled: true });
  }, function () {
    throw buildLockTimeoutError_(SAVE_LOCK_WAIT_MS_, '請稍等再按一次「取消這個特別崇拜」。');
  });
}

/**
 * 用途：改特別崇拜那一行的幾格，逐格記 AuditLog。只在指令碼鎖之內叫。IO 層。
 * Args:
 *   isoDate {string}　values {Object<string,*>} 機器鍵 → 新值。
 *   action {string} AuditLog 的 ACTION。　notes {string}
 * Returns:
 *   {void}
 * Raises:
 *   Error 找不到那一行或那一欄（例如未「初始化工作表」）——寧可失敗也不要靜靜只寫一半。
 */
function writeSpecialServiceRowCells_(isoDate, values, action, notes) {
  var rows = readRowsWithRowNo_(SHEETS.BULLETIN_WEEKS);
  var row = findBulletinWeekRow_(rows, isoDate);
  if (!row) throw new Error('找不到 ' + isoDate + ' 的週報（BulletinWeeks），一格都沒有寫。');
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.BULLETIN_WEEKS);
  var def = COLUMNS[SHEET_ID_BY_NAME[SHEETS.BULLETIN_WEEKS]];
  Object.keys(values).forEach(function (key) {
    if (def.keys.indexOf(key) === -1) throw new Error('BulletinWeeks 沒有「' + key + '」這一欄，請先按「初始化工作表」。');
  });
  Object.keys(values).forEach(function (key) {
    var oldValue = row[key];
    setCellValueTextSafe_(sheet, def, row.__rowNo, key, sanitizeCellText_(values[key]));
    appendAuditLog_({
      action: action, sheetName: SHEETS.BULLETIN_WEEKS, rowKey: isoDate, field: key,
      oldValue: oldValue === null || oldValue === undefined ? '' : String(oldValue), newValue: String(values[key]),
      notes: notes
    });
  });
}
