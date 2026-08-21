/**
 * BulletinModel.gs
 *
 * 週報資料模型的總組裝：`buildBulletinModel_(isoDate)` 輸入一個主日日期，
 * 輸出一份**完整的週報資料模型**——事奉框、程序表、下週事奉、人數表、
 * 家事報告、代禱、財政、團契、待填欄位清單全部算好，隨時可以交給下一輪
 * 的版面渲染。
 *
 * 本檔案完全不碰 Google Docs、PDF、電郵、觸發器。
 *
 * 分兩層：
 *   - `buildBulletinModel_(isoDate)`　真正入口，讀全部工作表與 Config。
 *   - `assembleBulletinModel_(input)`　純函式，全部資料由呼叫方傳進來，
 *     不碰 Apps Script 服務，方便在 Node 直接測試。
 */

'use strict';

/**
 * 用途：人數表三個橫列的定義（列標題 ＋ 對應的四個 `BulletinWeeks` 機器鍵，
 *   依英語堂／粵語堂主堂／粵語堂北岸／華語堂的次序）。寫成函式而不是頂層
 *   常數，是為了不依賴 `.gs` 檔案載入次序（見 docs/已知bug類型.md 事故一）。
 * Args: （無）
 * Returns:
 *   {{label:string, keys:string[]}[]}
 */
function attendanceRowDefs_() {
  return [
    { label: '崇拜', keys: ['ATT_ENG_WORSHIP', 'ATT_CANE_WORSHIP', 'ATT_CANN_WORSHIP', 'ATT_MAN_WORSHIP'] },
    { label: '祈禱會', keys: ['ATT_ENG_PRAYER', 'ATT_CANE_PRAYER', 'ATT_CANN_PRAYER', 'ATT_MAN_PRAYER'] },
    { label: '兒童', keys: ['ATT_ENG_CHILD', 'ATT_CANE_CHILD', 'ATT_CANN_CHILD', 'ATT_MAN_CHILD'] }
  ];
}

/**
 * 用途：週報資料模型的真正入口。讀 Config 與全部相關工作表（本週與下週的
 *   職事表快照、`BulletinWeeks`、家事報告、代禱、團契、財政、事奉框相關
 *   三張表、程序範本），再交給純函式層組裝。
 *
 *   副作用：如果 `BulletinWeeks.PROGRAM_TEMPLATE_ID` 原本留空、而這次
 *   推斷出了範本，會把推斷結果寫回工作表並記一筆 `AuditLog`
 *   （見 persistInferredTemplateId_()）。
 * Args:
 *   isoDate {string} 主日日期，yyyy-MM-dd 格式。
 * Returns:
 *   {Object} 週報資料模型，形狀見 assembleBulletinModel_()。
 *     `ROSTER_SPREADSHEET_ID` 未設定時回 `{ ok:false, notConfigured:true, ... }`。
 * Raises:
 *   Error 如果 isoDate 格式不對、職事表讀取失敗、或程序範本內有認不出的
 *     `CONDITION`／`CONTENT_SOURCE`。
 */
function buildBulletinModel_(isoDate) {
  var targetDate = normalizeDate_(isoDate);
  if (!targetDate) {
    throw new Error('buildBulletinModel_：isoDate 必須是 yyyy-MM-dd 格式，收到：' + JSON.stringify(isoDate));
  }

  var snapshot = readRosterSnapshot_(isoDate);
  if (snapshot.notConfigured) {
    return emptyBulletinModel_(isoDate, { ok: false, notConfigured: true, warnings: snapshot.warnings.slice() });
  }

  var nextIsoDate = formatIsoDate_(addDays_(targetDate, 7));
  var warnings = [];

  // 下週事奉要讀**下一個主日**的職事表快照。下一個主日不在職事表內
  // （例如跨季而下一季未生成）不可以拋錯——那是很正常的狀況，週報照樣
  // 要生得出來，只是下週事奉那一欄空著。
  var nextSnapshot = null;
  try {
    nextSnapshot = readRosterSnapshot_(nextIsoDate);
  } catch (err) {
    warnings.push({
      code: 'NEXT_WEEK_SNAPSHOT_FAILED',
      message: '讀取下一個主日（' + nextIsoDate + '）的職事表快照失敗：'
        + (err && err.message ? err.message : String(err)) + '　下週事奉會留白。'
    });
  }

  var weekRows = readSheet(SHEETS.BULLETIN_WEEKS);
  var week = findBulletinWeekRow_(weekRows, isoDate);
  if (!week) {
    warnings.push({
      code: 'BULLETIN_WEEK_ROW_NOT_FOUND',
      message: 'BulletinWeeks 工作表沒有 ' + isoDate + ' 這一行，全部人手填寫的欄位都當成空白處理。'
        + '可以用選單「建立本季空白週報」先建好整季的空白行。'
    });
    week = {};
  }

  var program = buildProgramTable_(week, snapshot);
  if (program.inferred && weekRows.length > 0 && Object.keys(week).length > 0) {
    persistInferredTemplateId_(isoDate, program.templateId, warnings);
  }

  // ⚠️ 取值次序固定：**職事表快照 → 套用 DutyOverride → 套用 PersonDisplay
  // 尊稱**，不可以調轉（見 src/DutyOverride.gs 的核心原則）。合併組
  // （主席及報告、影音）在 buildDutyBox_() 內部才合併，也就是在覆寫
  // 套用**之後**——這一點是靠這裡先換掉 slotsByPost 才成立的。
  var overrides = readDutyOverrideRows_(isoDate);
  var diff = buildRosterDiff_(isoDate, snapshot, overrides,
    (week.ROSTER_SNAPSHOT_VERSION === undefined) ? null : week.ROSTER_SNAPSHOT_VERSION);
  var diffByKey = {};
  diff.rows.forEach(function (r) { diffByKey[dutyOverrideKey_(r.postId, r.slotIndex)] = r; });

  snapshot.slotsByPost = applyDutyOverridesToSlots_(snapshot.slotsByPost, buildDutyOverrideIndex_(overrides));

  var dutyBoxPage1 = buildDutyBox_(snapshot, 1, warnings, diffByKey);
  var nextWeekDuty = [];
  if (nextSnapshot && nextSnapshot.found) {
    // 下週事奉用的是**下一個主日**的職事表快照，所以要套下一個主日自己
    // 的覆寫，不是這一週的。
    var nextOverrides = readDutyOverrideRows_(nextIsoDate);
    nextSnapshot.slotsByPost = applyDutyOverridesToSlots_(
      nextSnapshot.slotsByPost, buildDutyOverrideIndex_(nextOverrides)
    );
    nextWeekDuty = buildDutyBox_(nextSnapshot, 3, warnings, {});
  } else if (nextSnapshot) {
    warnings.push({
      code: 'NEXT_WEEK_NOT_IN_ROSTER',
      message: '下一個主日（' + nextIsoDate + '）不在職事表內（可能是跨季而下一季尚未生成），'
        + '下週事奉留白。'
    });
  }

  return assembleBulletinModel_({
    isoDate: isoDate,
    targetDate: targetDate,
    snapshot: snapshot,
    nextSnapshot: nextSnapshot,
    week: week,
    templateId: program.templateId,
    program: program.rows,
    recitation: program.recitation,
    dutyBoxPage1: dutyBoxPage1,
    nextWeekDuty: nextWeekDuty,
    rosterDiff: diff,
    announcementRows: readSheet(SHEETS.ANNOUNCEMENTS),
    prayerRows: readSheet(SHEETS.PRAYERS),
    fellowshipRows: readSheet(SHEETS.FELLOWSHIPS),
    financeRows: readSheet(SHEETS.FINANCE),
    // 浸禮副框的**單人**欄位要套尊稱，走的是跟事奉框人手覆寫姓名完全
    // 同一條路徑（resolveOverrideDisplay_ 按姓名查 PersonDisplay），所以
    // 尊稱開關也沿用第 1 頁那一個——副框就在第 1 頁。
    baptismOptions: {
      personDisplayRows: readSheet(SHEETS.PERSON_DISPLAY),
      withHonorific: normalizeBoolean_(getConfig(CONFIG_KEYS.HONORIFIC_ON_PAGE1, 'TRUE')) === true,
      targetDate: targetDate
    },
    config: {
      dateFormatCover: getConfig(CONFIG_KEYS.DATE_FORMAT_COVER, 'yyyy 年 MM 月 dd 日'),
      dateFormatInline: getConfig(CONFIG_KEYS.DATE_FORMAT_INLINE, 'dd/MM/yyyy'),
      defaultPageTitle: getConfig(CONFIG_KEYS.DEFAULT_PAGE_TITLE, '崇拜程序'),
      defaultAttendanceHeading: getConfig(CONFIG_KEYS.DEFAULT_ATTENDANCE_HEADING, '上週主日崇拜人數'),
      defaultNextWeekHeading: getConfig(CONFIG_KEYS.DEFAULT_NEXT_WEEK_HEADING, '下週主日崇拜聚會事奉肢體'),
      defaultPrayerBlockHeading: getConfig(CONFIG_KEYS.DEFAULT_PRAYER_BLOCK_HEADING, '代禱事項'),
      preludeDefault: getConfig(CONFIG_KEYS.PRELUDE_DEFAULT, ''),
      cantoneseSubColumnLabel: getConfig(CONFIG_KEYS.CANTONESE_SUBCOLUMN_LABEL, '主堂')
    },
    // 正式路徑用 Apps Script 的 Utilities.formatDate()，才能完整支援 Config
    // 內任何 Java SimpleDateFormat 樣式；純函式層測試會改用內建的簡化版。
    formatDate: function (date, pattern) {
      return Utilities.formatDate(date, Session.getScriptTimeZone(), pattern);
    },
    warnings: warnings
  });
}

/**
 * 用途：組出一個形狀完整的空白週報資料模型，讓「未設定／找不到」這類
 *   情況也有一致的物件形狀，呼叫方不用逐層防呆。
 * Args:
 *   isoDate {string} 主日日期。
 *   overrides {Object} 要覆寫的欄位。
 * Returns:
 *   {Object}
 */
function emptyBulletinModel_(isoDate, overrides) {
  var base = {
    ok: true,
    notConfigured: false,
    found: false,
    isoDate: isoDate,
    weekOfMonth: null,
    quarterId: null,
    rosterVersionUsed: null,
    rosterIsOfficial: false,
    special: null,
    templateId: null,
    header: {
      pageTitle: '', coverDate: '', attendanceHeading: '', attendanceDate: '',
      nextWeekHeading: '', nextWeekDate: ''
    },
    dutyBoxPage1: [],
    program: [],
    // 第七輪新增：誦讀內容（Word 範本的 {{RECITATION}} 佔位符要用；
    // 誦讀那一格不一定在程序表內，所以另外單獨帶一份）。
    recitation: '',
    // 第七輪新增：`BulletinWeeks` 該主日那一行的原始欄位值。
    //
    // ⚠️ 為什麼要把原始行也放進模型：Word 範本有大量佔位符
    // （{{SERMON_TITLE}}、{{HYMN_PRAISE}}、12 個人數欄……）要的就是那一格
    // **未經加工**的值。模型其他部分（header／attendance／program）是
    // 已經排版過的結果，取不回原值。與其在 BulletinRender.gs 再讀一次
    // 工作表（那樣就會有兩個真相、而且多一次 IO），不如由模型一次帶出來。
    weekFields: {},
    // 浸禮合堂副框六欄的**顯示文字**（單人欄位已套尊稱、多人欄位原樣）。
    // 六個鍵一定齊全，沒有值的是空字串——見 src/BaptismBox.gs。
    baptism: {},
    // 這一週是不是浸禮合堂——填寫介面靠這個旗標決定要不要顯示副框六欄。
    // 判斷依據是 `templateId`（由 resolveProgramTemplateId_() 算出來的
    // 單一真相），不是在別處再比對一次特別主日的關鍵詞。
    isBaptismSunday: false,
    attendance: { columns: [], rows: [] },
    nextWeekDuty: [],
    // 第六輪新增：週報與職事表的比對結果（見 src/RosterDiff.gs）。
    rosterDiff: { isoDate: isoDate, rosterVersion: null, snapshotVersion: null, rows: [], conflictCount: 0, followedCount: 0 },
    flowers: { thisWeek: '', nextWeek: '' },
    announcements: [],
    prayerBlock: { heading: '', items: [] },
    finance: [],
    fellowships: [],
    missing: [],
    warnings: []
  };
  return Object.assign(base, overrides || {});
}

/**
 * 用途：週報資料模型的純函式層。把已經讀好的各張工作表資料組成最後的
 *   模型物件，包括日期換算、標題預設值、人數表、各清單的篩選排序，
 *   以及待填清單。完全不碰 Apps Script 服務。
 * Args:
 *   input {Object} 見 buildBulletinModel_() 組出來的物件。`formatDate`
 *     是一個 `(Date, pattern) => string` 的函式；沒有提供時退回內建的
 *     簡化實作 formatDatePatternSimple_()。
 * Returns:
 *   {Object} 週報資料模型，形狀見本檔案開頭與 docs/週報資料模型.md。
 */
function assembleBulletinModel_(input) {
  var week = input.week || {};
  var snapshot = input.snapshot;
  var config = input.config || {};
  var warnings = (input.warnings || []).slice();
  var formatDate = input.formatDate || formatDatePatternSimple_;

  var attendanceDate = addDays_(input.targetDate, -7);
  var nextWeekDate = addDays_(input.targetDate, 7);

  var model = emptyBulletinModel_(input.isoDate, {
    ok: true,
    notConfigured: false,
    found: Boolean(snapshot && snapshot.found),
    weekOfMonth: snapshot ? snapshot.weekOfMonth : null,
    quarterId: snapshot ? snapshot.quarterId : null,
    rosterVersionUsed: snapshot ? snapshot.versionNo : null,
    rosterIsOfficial: Boolean(snapshot && snapshot.isOfficial),
    special: snapshot ? snapshot.special : null,
    templateId: input.templateId || null,
    dutyBoxPage1: input.dutyBoxPage1 || [],
    program: input.program || [],
    recitation: input.recitation || '',
    weekFields: week,
    nextWeekDuty: input.nextWeekDuty || [],
    rosterDiff: input.rosterDiff || {
      isoDate: input.isoDate, rosterVersion: null, snapshotVersion: null,
      rows: [], conflictCount: 0, followedCount: 0
    },
    warnings: warnings
  });

  model.header = {
    pageTitle: pickWithDefault_(week.PAGE_TITLE, config.defaultPageTitle),
    coverDate: formatDate(input.targetDate, config.dateFormatCover || 'yyyy-MM-dd'),
    attendanceHeading: pickWithDefault_(week.ATTENDANCE_HEADING, config.defaultAttendanceHeading),
    // 人數統計日期預設是主日日期減 7 天（上週）；BulletinWeeks 有明確填
    // ATTENDANCE_DATE 就以它為準（例如某週補登更早之前的數字）。
    attendanceDate: formatDate(
      week.ATTENDANCE_DATE instanceof Date ? week.ATTENDANCE_DATE : attendanceDate,
      config.dateFormatInline || 'dd/MM/yyyy'
    ),
    nextWeekHeading: pickWithDefault_(week.NEXT_WEEK_HEADING, config.defaultNextWeekHeading),
    nextWeekDate: formatDate(nextWeekDate, config.dateFormatInline || 'dd/MM/yyyy')
  };

  model.attendance = buildAttendanceTable_(week, config.cantoneseSubColumnLabel || '主堂');

  // 浸禮合堂副框六欄。單人欄位的尊稱要用 `PersonDisplay`，那是 IO 層讀好
  // 之後透過 `input.baptismOptions` 傳進來的（純函式層不自己讀工作表）。
  //
  // ⚠️ `warnings` 一定要覆寫成本函式**自己那一份**（上面 `.slice()` 出來的
  // 複本），不可以沿用 `input.baptismOptions.warnings`——查不到姓名的
  // warning 會被推進呼叫方那個原始陣列，而模型帶出去的是複本，結果
  // warning 靜靜不見（缺失被當成正常值靜靜過，見 docs/已知bug類型.md 第 2 類）。
  model.isBaptismSunday = isBaptismTemplateId_(model.templateId);
  model.baptism = buildBaptismBoxFields_(
    week,
    Object.assign({}, input.baptismOptions || {}, { warnings: warnings })
  );

  model.flowers = {
    thisWeek: String(week.FLOWER_THIS_WEEK || ''),
    nextWeek: String(week.FLOWER_NEXT_WEEK || '')
  };

  model.announcements = filterDatedRows_(input.announcementRows, input.targetDate)
    .map(function (r) { return { seqNo: r.SEQ_NO, text: String(r.TEXT || '') }; });

  model.prayerBlock = {
    heading: pickWithDefault_(week.PRAYER_BLOCK_HEADING, config.defaultPrayerBlockHeading),
    items: filterDatedRows_(input.prayerRows, input.targetDate)
      .map(function (r) { return { seqNo: r.SEQ_NO, text: String(r.TEXT || '') }; })
  };

  model.finance = filterDatedRows_(input.financeRows, input.targetDate)
    .map(function (r) {
      return {
        seqNo: r.SEQ_NO,
        rowLabel: String(r.ROW_LABEL || ''),
        specialOverseas: String(r.COL_SPECIAL_OVERSEAS || ''),
        hardship: String(r.COL_HARDSHIP || ''),
        // prompt9 §1.6 新增：COL3／COL4 對應範本的 {{FINANCE.COL3}}／
        // {{FINANCE.COL4}}。COL5 目前沒有對應的渲染欄位，見
        // docs/待確認事項.md 的說明，這裡不帶出來。
        col3: String(r.COL3 || ''),
        col4: String(r.COL4 || '')
      };
    });

  model.fellowships = filterDatedRows_(input.fellowshipRows, input.targetDate)
    .map(function (r) {
      return {
        seqNo: r.SEQ_NO,
        // 叫 fellowshipName 而不是更短的那個名：一來模型內有好幾種
        // 「名稱」，明確一點比較好讀；二來那個較短的屬性名剛好也是一個
        // 真實的頂層網域，tools/scan-staged-secrets.js 會把字串串接裡的
        // 「物件.該屬性」誤判成網域而擋住 commit。那個關卡寧可誤報也不
        // 放過，不應該為了遷就命名而放寬，改名反而是對的。
        // （這裡特登唔舉完整例子——寫出完整形狀會被掃描器自己捉到。）
        fellowshipName: String(r.FELLOWSHIP_NAME || ''),
        meetingDate: String(r.MEETING_DATE || ''),
        meetingTime: String(r.MEETING_TIME || ''),
        content: String(r.CONTENT || '')
      };
    });

  model.missing = buildMissingList_({
    week: week,
    dutyBoxPage1: model.dutyBoxPage1,
    announcementCount: model.announcements.length,
    prayerCount: model.prayerBlock.items.length,
    fellowshipCount: model.fellowships.length
  });

  return model;
}

/**
 * 用途：組出人數表。三個橫列（崇拜／祈禱會／兒童）× 四個直欄（英語堂／
 *   粵語堂主堂／粵語堂北岸／華語堂），**全部當文字**——樣本內出現過
 *   `--` 與 `前:5 / 後:120` 這類值，不是數字。
 * Args:
 *   week {Object} `BulletinWeeks` 資料列。
 *   cantoneseSubLabel {string} Config `CANTONESE_SUBCOLUMN_LABEL`（主堂）。
 * Returns:
 *   {{columns:string[], rows:{label:string, values:string[]}[]}}
 */
function buildAttendanceTable_(week, cantoneseSubLabel) {
  var columns = ['英語堂', '粵語堂' + cantoneseSubLabel, '粵語堂北岸', '華語堂'];
  var rows = attendanceRowDefs_().map(function (def) {
    return {
      label: def.label,
      values: def.keys.map(function (key) {
        var v = week[key];
        return String(v === null || v === undefined ? '' : v);
      })
    };
  });
  return { columns: columns, rows: rows };
}

/**
 * 用途：從 `Announcements`／`Prayers`／`Fellowships`／`Finance` 這類
 *   「一個主日多行」的工作表，篩出指定主日、`ACTIVE=TRUE` 的行，
 *   按 `SEQ_NO` 排序。
 * Args:
 *   rows {Object[]} 工作表資料列。
 *   targetDate {Date} 主日日期。
 * Returns:
 *   {Object[]}
 */
function filterDatedRows_(rows, targetDate) {
  if (!(targetDate instanceof Date)) return [];
  var y = targetDate.getFullYear();
  var mo = targetDate.getMonth() + 1;
  var d = targetDate.getDate();

  return (rows || [])
    .filter(function (r) {
      return r.ACTIVE === true && rosterDateMatchesYMD_(r.SERVICE_DATE, y, mo, d);
    })
    .slice()
    .sort(function (a, b) { return (a.SEQ_NO || 0) - (b.SEQ_NO || 0); });
}

/**
 * 用途：掃出「本週待填欄位」清單。每一項寫明機器鍵、中文標題與原因，
 *   讓幹事知道要去哪裡補什麼。
 *
 *   ⚠️ `PRELUDE` 留空**不算缺**——68 期樣本的序樂全部相同，留空時直接用
 *   Config 的 `PRELUDE_DEFAULT` 補上即可，不需要每週叫人填一次。
 * Args:
 *   input {{week:Object, dutyBoxPage1:Object[], announcementCount:number,
 *          prayerCount:number, fellowshipCount:number}}
 * Returns:
 *   {{field:string, label:string, reason:string}[]}
 */
function buildMissingList_(input) {
  var week = input.week || {};
  var missing = [];

  function isBlank(key) {
    var v = week[key];
    return String(v === null || v === undefined ? '' : v).trim() === '';
  }
  function labelOf(key) {
    var idx = COLUMNS.BULLETIN_WEEKS.keys.indexOf(key);
    return idx === -1 ? key : COLUMNS.BULLETIN_WEEKS.headers[idx];
  }
  function add(field, label, reason) {
    missing.push({ field: field, label: label, reason: reason });
  }

  // 宣召：經文與出處兩者皆空才算缺（只有出處是合法的，見 2026-04-05 樣本）。
  if (isBlank('CALL_TEXT') && isBlank('CALL_REF')) {
    add('CALL_TEXT', labelOf('CALL_TEXT') + '／' + labelOf('CALL_REF'), '宣召經文與出處兩者皆未填。');
  }

  ['SCRIPTURE_REF', 'SERMON_TITLE', 'RESPONSE_HYMN', 'FLOWER_THIS_WEEK'].forEach(function (key) {
    if (isBlank(key)) add(key, labelOf(key), '尚未填寫。');
  });

  attendanceRowDefs_().forEach(function (def) {
    def.keys.forEach(function (key) {
      if (isBlank(key)) add(key, labelOf(key), '人數尚未填寫。');
    });
  });

  if (input.announcementCount === 0) {
    add('ANNOUNCEMENTS', '家事報告', 'Announcements 工作表本週沒有任何有效的行。');
  }
  if (input.prayerCount === 0) {
    add('PRAYERS', '代禱事項', 'Prayers 工作表本週沒有任何有效的行。');
  }
  if (input.fellowshipCount === 0) {
    add('FELLOWSHIPS', '團契聚會', 'Fellowships 工作表本週沒有任何有效的行。');
  }

  (input.dutyBoxPage1 || []).forEach(function (row) {
    if (!row.isPending) return;
    add('POST:' + row.postIds.join('+'), row.label, '職事表尚未排定人選。');
  });

  return missing;
}

/**
 * 用途：`BulletinWeeks` 的值有填就用它，留空就用 Config 的預設值。
 * Args:
 *   value {*} 工作表的值。
 *   defaultValue {*} Config 的預設值。
 * Returns:
 *   {string}
 */
function pickWithDefault_(value, defaultValue) {
  var v = String(value === null || value === undefined ? '' : value).trim();
  if (v) return v;
  return String(defaultValue === null || defaultValue === undefined ? '' : defaultValue);
}

/**
 * 用途：在 `BulletinWeeks` 資料列中找出指定主日的那一行。
 * Args:
 *   rows {Object[]} `BulletinWeeks` 的資料列。
 *   isoDate {string} 主日日期 yyyy-MM-dd。
 * Returns:
 *   {?Object} 找不到回 `null`。
 */
function findBulletinWeekRow_(rows, isoDate) {
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(isoDate || ''));
  if (!m) return null;
  var y = Number(m[1]);
  var mo = Number(m[2]);
  var d = Number(m[3]);

  var found = (rows || []).filter(function (r) {
    return rosterDateMatchesYMD_(r.SERVICE_DATE, y, mo, d);
  });
  return found.length > 0 ? found[0] : null;
}

/**
 * 用途：把一個 Date 加減指定天數，回傳新的 Date（不修改原物件）。
 * Args:
 *   date {Date} 原日期。
 *   days {number} 要加的天數，可以是負數。
 * Returns:
 *   {Date}
 */
function addDays_(date, days) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

/**
 * 用途：日期格式化的**簡化**實作，只支援 `yyyy`／`yy`／`MM`／`M`／`dd`／`d`
 *   六個樣式符號，其餘字元原樣輸出。
 *
 *   ⚠️ 這只是純函式層（Node 測試）的退路。正式路徑一律由
 *   buildBulletinModel_() 傳入以 `Utilities.formatDate()` 為底的函式，
 *   才能完整支援 Config 內任何 Java SimpleDateFormat 樣式。
 *   已知限制：樣式字串內如果有**字面上的** `d` 或 `M`（例如英文月份縮寫）
 *   會被誤當成樣式符號——本專案兩個預設值（`yyyy 年 MM 月 dd 日`、
 *   `dd/MM/yyyy`）都沒有這個問題。
 * Args:
 *   date {Date}
 *   pattern {string}
 * Returns:
 *   {string}
 */
function formatDatePatternSimple_(date, pattern) {
  var y = date.getFullYear();
  var mo = date.getMonth() + 1;
  var d = date.getDate();
  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  return String(pattern || '').replace(/yyyy|yy|MM|M|dd|d/g, function (token) {
    switch (token) {
      case 'yyyy': return String(y);
      case 'yy': return String(y).slice(-2);
      case 'MM': return pad2(mo);
      case 'M': return String(mo);
      case 'dd': return pad2(d);
      case 'd': return String(d);
      default: return token;
    }
  });
}

/**
 * 用途：把推斷出來的程序範本 ID 寫回 `BulletinWeeks`，並記一筆 `AuditLog`。
 *   只在該行原本留空時呼叫——已經有值代表人手指定過，一律不覆蓋。
 *
 *   寫入失敗（例如工作表被保護）不拋錯：範本已經推斷出來、模型照樣建得成，
 *   寫不回去只是下次要再推斷一次，不值得讓整個預覽失敗。改為記一筆警告。
 * Args:
 *   isoDate {string} 主日日期 yyyy-MM-dd。
 *   templateId {string} 推斷出來的範本 ID。
 *   warnings {Object[]} 累積警告用的陣列。
 * Returns:
 *   {boolean} 有沒有成功寫入。
 */
function persistInferredTemplateId_(isoDate, templateId, warnings) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ensureSheet_(ss, 'BULLETIN_WEEKS');
    var def = COLUMNS.BULLETIN_WEEKS;
    var dateCol = def.keys.indexOf('SERVICE_DATE') + 1;
    var templateCol = def.keys.indexOf('PROGRAM_TEMPLATE_ID') + 1;

    var lastRow = sheet.getLastRow();
    if (lastRow < 3) return false;

    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
    var y = Number(m[1]);
    var mo = Number(m[2]);
    var d = Number(m[3]);

    var dates = sheet.getRange(3, dateCol, lastRow - 2, 1).getValues();
    for (var i = 0; i < dates.length; i++) {
      // ⚠️ 這裡讀的是**原始**儲存格值，不是 readSheet() 正規化過的結果，
      // 所以日期欄可能是 Date 物件、也可能是 yyyy-MM-dd 文字（儲存格被
      // 設成純文字格式時就是這樣）。只認 Date 會讓「找不到那一行」靜靜
      // 發生、範本永遠寫不回去而沒有人知道，所以一律先正規化再比對。
      // 能走到這一步代表 readSheet() 已經成功讀過同一張表，即每一格
      // 不是 Date 就是合法的 yyyy-MM-dd（否則 readSheet() 早就拋錯了），
      // 所以這裡的 catch 只會吃到空白格。
      var cellDate = null;
      try {
        cellDate = normalizeDate_(dates[i][0]);
      } catch (parseErr) {
        cellDate = null;
      }
      if (!rosterDateMatchesYMD_(cellDate, y, mo, d)) continue;

      var rowNo = i + 3;
      sheet.getRange(rowNo, templateCol).setValue(templateId);
      appendAuditLog_({
        action: 'INFER_PROGRAM_TEMPLATE',
        sheetName: SHEETS.BULLETIN_WEEKS,
        rowKey: isoDate,
        field: 'PROGRAM_TEMPLATE_ID',
        oldValue: '',
        newValue: templateId,
        notes: '原本留空，依特別主日標題／類型自動推斷。'
      });
      return true;
    }
    return false;
  } catch (err) {
    warnings.push({
      code: 'TEMPLATE_WRITEBACK_FAILED',
      message: '推斷出程序範本「' + templateId + '」，但寫回 BulletinWeeks 失敗：'
        + (err && err.message ? err.message : String(err)) + '　模型本身不受影響。'
    });
    return false;
  }
}
