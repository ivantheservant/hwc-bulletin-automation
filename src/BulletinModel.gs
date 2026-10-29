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
 *   2026-10-27（Ivan 選 B）：`BulletinWeeks.PROGRAM_TEMPLATE_ID` 留空＝程序範本跟每週標題自動推斷，
 *   **不再把推斷結果寫回工作表**——寫回去之後那一格就有值，下次會被當成人手揀過，每週標題再改
 *   （包括改回空白）範本就不會跟。見 resolveProgramTemplateId_()。
 * Args:
 *   isoDate {string} 主日日期，yyyy-MM-dd 格式。
 *   options {{weekOverlay:Object=, dutyOverrideRows:Object[]=, nextDutyOverrideRows:Object[]=,
 *     noWrite:boolean=}=} v3：只在「未儲存的草稿」與「某個版本的預覽」用（見 src/ModelOverlay.gs）。
 *     `weekOverlay`：疊在 `BulletinWeeks` 那一行上面的欄位值（只收填寫介面可編輯的欄位）；
 *     `dutyOverrideRows`／`nextDutyOverrideRows`：代替工作表上這一週／下一個主日的 `DutyOverride`；
 *     `noWrite`：草稿與預覽用，保證不寫工作表（2026-10-27 起本函式本身已經不寫程序範本，這個旗標
 *     保留給呼叫方表明意圖）。省略＝一般路徑。
 * Returns:
 *   {Object} 週報資料模型，形狀見 assembleBulletinModel_()。
 *     `ROSTER_SPREADSHEET_ID` 未設定時回 `{ ok:false, notConfigured:true, ... }`。
 * Raises:
 *   Error 如果 isoDate 格式不對、職事表讀取失敗、或程序範本內有認不出的
 *     `CONDITION`／`CONTENT_SOURCE`。
 */
function buildBulletinModel_(isoDate, options) {
  var opts = options || {};
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
      message: '週報試算表未有 ' + isoDate + ' 這一個主日，全部人手填寫的欄位都當成空白處理。'
        + '可以用選單「建立本季空白週報」先建好整季的空白行。'
    });
    week = {};
  }
  if (opts.weekOverlay) week = overlayEditableWeekValues_(week, opts.weekOverlay);

  // ⚠️ R-043／R-045：第三種模式（內容表為來源、介面可覆寫）的取值次序，
  //    **固定**是「BulletinWeeks 現值 ← 內容表匯入 → 套用 FieldOverride」。
  //    這一行就是那個「→ 套用 FieldOverride」，而且是**系統之內唯一**
  //    套用的地方——加第二個地方套一次，就等於加了第二個真相來源
  //    （見 src/FieldOverride.gs 檔頭與 docs/已知bug類型.md 事故三）。
  //
  //    ⚠️ 排喺 buildProgramTable_() **之前**：程序表要用 SCRIPTURE_REF、
  //    CHOIR_TITLE 這幾欄，用未套覆寫的值就會印錯。
  week = applyFieldOverrides_(week, isoDate, readFieldOverrideIndexForDate_(isoDate));

  // 內容表 v2（決定 11）：序樂空白時印 Config PRELUDE_DEFAULT。序樂改由內容表「崇拜程序」匯入之後，
  //    內容表那一格空白就會把週報的序樂清空（以前預設值只在「建立本季空白週報」寫一次）。這裏只改
  //    週報資料模型（印出來的值），不寫工作表；填寫介面讀的是工作表，照樣顯示空白。
  week = applyPreludeDefault_(week, getConfig(CONFIG_KEYS.PRELUDE_DEFAULT, ''));

  // ⚠️ R-042：獻花兩欄接上職事表的 `FLOWER` 崗位。
  //
  //    `FLOWER` **一直都有讀入職事表快照**（所以分歧報告見到「獻花 #1」），
  //    但 `PersonDisplay` 那一行的 `SHOW_ON_PAGE1`／`SHOW_ON_PAGE3` 兩個都
  //    是 `false`——**事奉框根本沒有畫出獻花那一格**，那是刻意的設計。
  //    Word 範本用的是 `FLOWER_THIS_WEEK`／`FLOWER_NEXT_WEEK` 這兩個週欄位，
  //    而它們一直是純人手欄位，跟已讀入的快照完全沒有接通。
  //
  //    ⚠️ 「下週獻花」對應的是**下一個主日**，與 R-040 同一條規則。
  week = applyFlowerFromRoster_(week, snapshot, nextSnapshot);
  // 填寫介面獻花欄位旁邊的提示要顯示「職事表的名字」，與上面帶入用同一個
  // rosterFlowerName_()，不是另外再算一次（階段 1）。
  var flowerRoster = {
    thisWeek: rosterFlowerName_(snapshot),
    nextWeek: rosterFlowerName_(nextSnapshot)
  };

  var program = buildProgramTable_(week, snapshot);
  (program.editWarnings || []).forEach(function (w) { warnings.push(w); });

  // ⚠️ 取值次序固定：**職事表快照 → 套用 DutyOverride → 套用 PersonDisplay
  // 尊稱**，不可以調轉（見 src/DutyOverride.gs 的核心原則）。合併組
  // （主席及報告、影音）在 buildDutyBox_() 內部才合併，也就是在覆寫
  // 套用**之後**——這一點是靠這裡先換掉 slotsByPost 才成立的。
  var overrides = opts.dutyOverrideRows ? opts.dutyOverrideRows : readDutyOverrideRows_(isoDate);
  var diff = buildRosterDiff_(isoDate, snapshot, overrides,
    (week.ROSTER_SNAPSHOT_VERSION === undefined) ? null : week.ROSTER_SNAPSHOT_VERSION);
  var diffByKey = {};
  diff.rows.forEach(function (r) { diffByKey[dutyOverrideKey_(r.postId, r.slotIndex)] = r; });

  snapshot.slotsByPost = applyDutyOverridesToSlots_(snapshot.slotsByPost, buildDutyOverrideIndex_(overrides));

  // 內容表 v2：講員表格已停用，不再拿表格答案核對事奉框的講員（以前的 SPEAKER_FORM_MISMATCH 警告）。
  //    SpeakerFormSubmissions 的舊答案保留，但停用之後仍然出警告只會令幹事去核對一份已經不用的表格。

  var dutyBoxPage1 = buildDutyBox_(snapshot, 1, warnings, diffByKey);
  var nextWeekDuty = [];
  if (nextSnapshot && nextSnapshot.found) {
    // 下週事奉用的是**下一個主日**的職事表快照，所以要套下一個主日自己
    // 的覆寫，不是這一週的。
    var nextOverrides = opts.nextDutyOverrideRows ? opts.nextDutyOverrideRows : readDutyOverrideRows_(nextIsoDate);
    // D9：下週事奉框亦要看得到衝突（職事表在覆寫之後又改過），幹事才可以在這一框按「保留我的」。
    //    用下一個主日自己的覆寫比對下一個主日的職事表；快照版本傳 null＝不產生 FOLLOW。這一份只給介面
    //    顯示每一格的狀態，不計入這一週的衝突數（rosterDiff 仍然只是這一週的），版面亦不看狀態。
    var nextDiff = buildRosterDiff_(nextIsoDate, nextSnapshot, nextOverrides, null);
    var nextDiffByKey = {};
    nextDiff.rows.forEach(function (r) { nextDiffByKey[dutyOverrideKey_(r.postId, r.slotIndex)] = r; });
    nextSnapshot.slotsByPost = applyDutyOverridesToSlots_(
      nextSnapshot.slotsByPost, buildDutyOverrideIndex_(nextOverrides)
    );
    nextWeekDuty = buildDutyBox_(nextSnapshot, 3, warnings, nextDiffByKey);
  } else if (nextSnapshot) {
    warnings.push({
      code: 'NEXT_WEEK_NOT_IN_ROSTER',
      message: '下一個主日（' + nextIsoDate + '）不在職事表內（可能是跨季而下一季尚未生成），'
        + '下週事奉留白。'
    });
  }

  return assembleBulletinModel_({
    isoDate: isoDate,
    flowerRoster: flowerRoster,
    // R-040：下週事奉那一格寫的是**下一個主日**那一筆 DutyOverride，
    // 所以前端要知道它是哪一日。同一個推算只應該有一處。
    nextIsoDate: nextIsoDate,
    targetDate: targetDate,
    snapshot: snapshot,
    nextSnapshot: nextSnapshot,
    week: week,
    templateId: program.templateId,
    templateAuto: program.templateAuto,
    program: program.rows,
    programDisplay: program.displayRows || [],
    recitation: program.recitation,
    // R-041：誦讀下拉旁邊要顯示的「目前自動值」。
    recitationAuto: program.recitationAuto,
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
      cantoneseSubColumnLabel: getConfig(CONFIG_KEYS.CANTONESE_SUBCOLUMN_LABEL, '主堂'),
      dutyPrintEmptyRows: normalizeBoolean_(getConfig(CONFIG_KEYS.DUTY_PRINT_EMPTY_ROWS, 'FALSE')) === true,
      // 2026-10-30：財政報告（src/FinanceReports.gs）。
      financeTitlePattern: getConfig(CONFIG_KEYS.FINANCE_TITLE_PATTERN, FINANCE_TITLE_PATTERN_DEFAULT_),
      financePeriodLabelPattern: getConfig(CONFIG_KEYS.FINANCE_PERIOD_LABEL_PATTERN, FINANCE_PERIOD_LABEL_PATTERN_DEFAULT_),
      financeSpecialTitlePattern: getConfig(CONFIG_KEYS.FINANCE_SPECIAL_TITLE_PATTERN, FINANCE_SPECIAL_TITLE_PATTERN_DEFAULT_),
      financeSpecialKeywords: getConfig(CONFIG_KEYS.FINANCE_SPECIAL_KEYWORDS, FINANCE_SPECIAL_KEYWORDS_DEFAULT_),
      financeMainColumnLabels: getConfig(CONFIG_KEYS.FINANCE_MAIN_COLUMN_LABELS, FINANCE_MAIN_COLUMN_LABELS_DEFAULT_),
      financeSpecialColumnLabels: getConfig(CONFIG_KEYS.FINANCE_SPECIAL_COLUMN_LABELS, FINANCE_SPECIAL_COLUMN_LABELS_DEFAULT_)
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
    // 2026-10-27：程序範本的**自動值**（假設沒有人手揀，按每週標題會用哪一個）。填寫介面的提示用。
    templateAuto: '',
    header: {
      pageTitle: '', coverDate: '', attendanceHeading: '', attendanceDate: '',
      nextWeekHeading: '', nextWeekDate: ''
    },
    dutyBoxPage1: [],
    // 2026-10-27：Config DUTY_PRINT_EMPTY_ROWS——沒有名字的崗位行印不印（預設 false＝不印）。
    //    Word、草稿預覽頁、電郵內文一律經 dutyRowsForPrint_(model.dutyBoxPage1／nextWeekDuty, 這個值)
    //    取要印的行；填寫介面與待填清單用全部行。⚠️ 存旗標而不是存「印出來的兩份清單」：手砌的
    //    模型（測試、自測）沒有那兩份就會靜靜甚麼都不印；旗標缺了只是退回預設。
    dutyPrintEmptyRows: false,
    program: [],
    programDisplay: [],
    // 第七輪新增：誦讀內容（Word 範本的 {{RECITATION}} 佔位符要用；
    // 誦讀那一格不一定在程序表內，所以另外單獨帶一份）。
    recitation: '',
    recitationAuto: '',
    nextIsoDate: '',
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
    flowerRoster: { thisWeek: '', nextWeek: '' },
    announcements: [],
    prayerBlock: { heading: '', items: [] },
    finance: [],
    // 2026-10-30：兩款財政報告（src/FinanceReports.gs）。沒有那一款就是 null。
    financeReports: { main: null, special: null, periodLabel: '', columnLabels: { main: ['', '', '', ''], special: ['', ''] } },
    fellowships: [],
    missing: [],
    warnings: []
  };
  return Object.assign(base, overrides || {});
}

/**
 * 用途：內容表 v2（決定 11）：序樂空白時改用預設序樂。純函式，不改傳入的物件。
 * Args:
 *   week {Object} 週報那一行（已套用欄位覆寫）。
 *   preludeDefault {string} Config `PRELUDE_DEFAULT`。
 * Returns:
 *   {Object} 序樂有值、預設值空白、或者這一週根本沒有那一行（沒有 `PRELUDE` 這一欄）時原樣回傳；
 *     否則回一份 `PRELUDE` 換成預設值的副本。
 * Raises:
 *   （無）
 */
function applyPreludeDefault_(week, preludeDefault) {
  var w = week || {};
  if (!Object.prototype.hasOwnProperty.call(w, 'PRELUDE')) return w;
  var current = String(w.PRELUDE === null || w.PRELUDE === undefined ? '' : w.PRELUDE).trim();
  var fallback = String(preludeDefault === null || preludeDefault === undefined ? '' : preludeDefault).trim();
  if (current !== '' || fallback === '') return w;
  return Object.assign({}, w, { PRELUDE: fallback });
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
    templateAuto: input.templateAuto || '',
    dutyBoxPage1: input.dutyBoxPage1 || [],
    program: input.program || [],
    programDisplay: input.programDisplay || input.program || [],
    recitation: input.recitation || '',
    recitationAuto: input.recitationAuto || '',
    nextIsoDate: input.nextIsoDate || '',
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

  // 印出來的事奉框：沒有名字的崗位行印不印由 Config 決定（預設不印），規則只在 dutyRowsForPrint_()。
  model.dutyPrintEmptyRows = config.dutyPrintEmptyRows === true;

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
  model.flowerRoster = {
    thisWeek: String((input.flowerRoster || {}).thisWeek || ''),
    nextWeek: String((input.flowerRoster || {}).nextWeek || '')
  };

  // v3（Ivan 測試結果 A 第 13 項）：丁戊己三張清單按這一週在填寫介面排的次序印，按了「×」的那幾則不印。
  //    次序與刪除只在這裏套用一次（見 src/WeekArrangement.gs）；內容仍然只來自內容表。
  var arrangement = parseListArrangement_(week.LIST_ARRANGEMENT);
  if (arrangement.invalid) {
    warnings.push({
      code: 'LIST_ARRANGEMENT_INVALID',
      message: '這一週的清單次序與刪除記錄讀不到（格式不對），家事報告、代禱事項、團契聚會照內容表的次序全部印出。'
        + '請在填寫介面重新排一次再儲存。'
    });
  }
  function arrangedRows(type, rows) {
    return arrangeListItems_(type, filterDatedRows_(rows, input.targetDate), arrangement.lists[type])
      .filter(function (a) { return a.hidden !== true; })
      .map(function (a) { return a.item; });
  }

  model.announcements = arrangedRows('announcements', input.announcementRows)
    .map(function (r) { return { seqNo: r.SEQ_NO, text: String(r.TEXT || '') }; });

  model.prayerBlock = {
    heading: pickWithDefault_(week.PRAYER_BLOCK_HEADING, config.defaultPrayerBlockHeading),
    items: arrangedRows('prayers', input.prayerRows)
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
        col4: String(r.COL4 || ''),
        // 2026-10-30：報告標題、附註、銀行結餘（內容表「財政報告」，每個報告填在其中一行）。
        title: String(r.REPORT_TITLE || ''),
        note: String(r.REPORT_NOTE || ''),
        balance: String(r.REPORT_BALANCE || '')
      };
    });

  // 2026-10-30（Ivan：財政報告全部修正）：分成「綜合收支」「特殊海外奉獻及慈惠基金」兩個報告（src/FinanceReports.gs）。
  //    Word、草稿預覽頁、電郵、診斷都讀這一份，標題與表頭不另外再算。
  var financeSplit = buildFinanceReports_(model.finance, {
    isoDate: input.isoDate,
    mainTitlePattern: config.financeTitlePattern,
    specialTitlePattern: config.financeSpecialTitlePattern,
    specialKeywords: config.financeSpecialKeywords
  });
  var financePeriodLabel = buildFinancePeriodLabel_(
    config.financePeriodLabelPattern === undefined ? FINANCE_PERIOD_LABEL_PATTERN_DEFAULT_ : config.financePeriodLabelPattern,
    input.isoDate);
  model.financeReports = {
    main: financeSplit.main,
    special: financeSplit.special,
    periodLabel: financePeriodLabel,
    columnLabels: financeColumnLabels_({
      mainLabels: config.financeMainColumnLabels, specialLabels: config.financeSpecialColumnLabels,
      periodLabel: financePeriodLabel
    })
  };
  financeSplit.warnings.forEach(function (w) { warnings.push(w); });

  model.fellowships = arrangedRows('fellowships', input.fellowshipRows)
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
  // ⚠️ D-10：`optional` 就是「通常空白，有就填」那一段。
  //
  //    獻花、翻譯這一類**正常就是空白**的欄位，本來永遠清不掉待填——
  //    幹事每一週都見到「待填 3 項」，然後每一週都確認一次「哦，果然又是
  //    那三項」。一個永遠不會變零的數字，等於沒有數字。
  //
  //    ⚠️ 刻意**不是**「隱藏」：它們仍然逐項列出來，只是不計入頂部徽章
  //    那個數字。「正常空白」與「漏填」本來就不是二元的——真的漏填了
  //    獻花也有可能，所以看得見比數得準重要。
  function add(field, label, reason, optional, contentTab) {
    missing.push({
      field: field, label: label, reason: reason, optional: optional === true,
      // 內容表 v2：這一欄在內容表哪一張分頁填（沒有就是空字串）。本季待填清單每行附同一句提示。
      contentTab: contentTab || ''
    });
  }

  // 宣召：經文與出處兩者皆空才算缺（只有出處是合法的，見 2026-04-05 樣本）。
  // 內容表 v2：宣召、讀經經文、證道講題、回應詩歌都在內容表「崇拜程序」填，待填說明講明去哪裏填。
  if (isBlank('CALL_TEXT') && isBlank('CALL_REF')) {
    var callTab = contentSheetTabForWeekField_('CALL_TEXT');
    add('CALL_TEXT', labelOf('CALL_TEXT') + '／' + labelOf('CALL_REF'),
      '宣召經文與出處兩者皆未填。' + contentSheetFillHint_(callTab), false, callTab);
  }

  ['SCRIPTURE_REF', 'SERMON_TITLE', 'RESPONSE_HYMN', 'FLOWER_THIS_WEEK'].forEach(function (key) {
    if (!isBlank(key)) return;
    var optional = optionalMissingFieldKeys_().indexOf(key) !== -1;
    var tab = optional ? '' : contentSheetTabForWeekField_(key);
    add(key, labelOf(key), optional ? '通常空白，有就填。' : (tab ? contentSheetFillHint_(tab) : '尚未填寫。'), optional, tab);
  });

  attendanceRowDefs_().forEach(function (def) {
    def.keys.forEach(function (key) {
      if (isBlank(key)) add(key, labelOf(key), '人數尚未填寫。');
    });
  });

  // 第二批測試修正 G6／G12：待填說明是給幹事看的，用內容表的分頁名稱，不用
  // 工作表英文名（Announcements／Prayers／Fellowships）；分頁名稱讀
  // `contentImportTargets_()`（內容表分頁 → 週報工作表的唯一對應），不在這裏另寫一份。
  if (input.announcementCount === 0) {
    add('ANNOUNCEMENTS', '家事報告', emptyContentListReason_(SHEETS.ANNOUNCEMENTS));
  }
  if (input.prayerCount === 0) {
    add('PRAYERS', '代禱事項', emptyContentListReason_(SHEETS.PRAYERS));
  }
  if (input.fellowshipCount === 0) {
    add('FELLOWSHIPS', '團契聚會', emptyContentListReason_(SHEETS.FELLOWSHIPS));
  }

  (input.dutyBoxPage1 || []).forEach(function (row) {
    if (!row.isPending) return;
    var optionalPosts = optionalMissingPostIds_();
    // 合併組（例如影音＝SOUND＋PPT）只要**全部**成員都是「通常空白」
    // 才算選填。其中一個是必填就整格必填——寧可多提醒一次。
    var optional = (row.postIds || []).length > 0
      && row.postIds.every(function (p) { return optionalPosts.indexOf(p) !== -1; });
    add('POST:' + row.postIds.join('+'), row.label,
      optional ? '通常空白，有就填。' : '職事表尚未排定人選。', optional);
  });

  return missing;
}

/**
 * 用途：**「通常空白，有就填」的週欄位。單一真相來源**（D-10）。
 *
 *   ⚠️ 寫成函式延遲求值，不依賴 `.gs` 載入次序（事故一）。
 * Args: （無）
 * Returns:
 *   {string[]}
 */
function optionalMissingFieldKeys_() {
  // 獻花：實際週報大部分主日都沒有獻花。
  return ['FLOWER_THIS_WEEK'];
}

/**
 * 用途：**「通常空白，有就填」的崗位。單一真相來源**（D-10）。
 * Args: （無）
 * Returns:
 *   {string[]}
 */
function optionalMissingPostIds_() {
  // 翻譯：只有需要傳譯那幾期才有；獻花：崗位本身不在事奉框顯示，
  // 列在這裏是為了合併組判斷完整。
  return ['TRANSLATOR', 'FLOWER'];
}

/**
 * 用途：把待填清單分成「一定要填」與「通常空白，有就填」兩段。
 *   **純函式。**
 *
 *   ⚠️ 頂部徽章的數字**只數第一段**。第二段仍然回傳，介面照樣列出來，
 *   只是不計入數字——見 `buildMissingList_()` 的 `add()` 說明。
 * Args:
 *   missing {Object[]} `buildMissingList_()` 的輸出。
 * Returns:
 *   {{required:Object[], optional:Object[], requiredCount:number}}
 */
function splitMissingList_(missing) {
  var required = [];
  var optional = [];
  (missing || []).forEach(function (m) {
    if (m && m.optional === true) optional.push(m);
    else required.push(m);
  });
  return { required: required, optional: optional, requiredCount: required.length };
}

/**
 * 用途：F6——「待填 N 項」這個數字的**唯一出口**。頂部徽章、主日下拉標籤、
 *   預覽報告、Word 產生報告、發佈前檢查、自我檢測……全部經過這一支，
 *   不可以各自再數一次 `missing.length`（那樣會把「通常空白」也數進去，
 *   同一週在不同畫面出現不同數字）。**純函式。**
 * Args:
 *   missing {Object[]} `buildMissingList_()` 的輸出。
 * Returns:
 *   {{requiredCount:number, optionalCount:number, optionalSuffix:string}}
 *     `requiredCount` 只數「一定要填」；`optionalCount` 是「通常空白，有就填」
 *     的項數；`optionalSuffix` 是現成的附註 `（另有 M 項通常空白）`，
 *     沒有通常空白的項目時是空字串。
 */
function missingCountSummary_(missing) {
  var split = splitMissingList_(missing);
  var optionalCount = split.optional.length;
  return {
    requiredCount: split.requiredCount,
    optionalCount: optionalCount,
    optionalSuffix: optionalCount > 0 ? ('（另有 ' + optionalCount + ' 項通常空白）') : ''
  };
}

/**
 * 用途：內容表 v2：`BulletinWeeks` 某一欄由內容表哪一張分頁（一個主日一行那一類）匯入。由
 *   `contentImportTargets_()` 衍生，不另抄一份。純函式（讀常數）。
 * Args:
 *   key {string} `BulletinWeeks` 機器鍵。
 * Returns:
 *   {string} 分頁名稱；不是由內容表匯入的欄回空字串。
 * Raises:
 *   （無）
 */
function contentSheetTabForWeekField_(key) {
  var hit = contentImportTargets_().filter(function (t) {
    if (t.targetSheet !== SHEETS.BULLETIN_WEEKS || t.kind !== 'WEEK') return false;
    return Object.keys(t.fieldMap).some(function (sourceKey) { return t.fieldMap[sourceKey] === key; });
  })[0];
  return hit ? hit.tabName : '';
}

/**
 * 用途：內容表 v2：「請在內容表『X』填寫。」那一句（待填面板與本季待填清單共用）。純函式。
 * Args:
 *   tabName {string} 內容表分頁名稱；空字串回空字串。
 * Returns:
 *   {string}
 * Raises:
 *   （無）
 */
function contentSheetFillHint_(tabName) {
  return tabName ? ('請在內容表「' + tabName + '」填寫。') : '';
}

/**
 * 用途：某一張清單表（`Announcements` 等）這一週沒有任何有效的行時，待填說明的
 *   字眼「內容表「家事報告」分頁這一週沒有任何有效的行。」。第二批測試修正 G12：
 *   分頁名稱讀 `contentImportTargets_()`（內容表分頁 → 週報工作表的唯一對應），
 *   內容表分頁改名時字眼跟着變，不會一處改了、一處仍是舊名。
 * Args:
 *   sheetName {string} 週報試算表的清單表名稱（`SHEETS.ANNOUNCEMENTS` 等）。
 * Returns:
 *   {string} 對應不到內容表分頁時，退回寫明工作表名稱（不會變成空白，也不會
 *     寫一個不存在的分頁名）。
 * Raises:
 *   （無）
 */
function emptyContentListReason_(sheetName) {
  var target = contentImportTargets_().filter(function (t) {
    return t.kind === 'LIST' && t.targetSheet === sheetName;
  })[0];
  if (target && target.tabName) {
    return '內容表「' + target.tabName + '」分頁這一週沒有任何有效的行。';
  }
  return '「' + sheetName + '」工作表這一週沒有任何有效的行。';
}

/**
 * 用途：判斷一項待填是不是「上週崇拜人數」12 格的其中一格。純函式。
 *
 *   第二批測試修正 G7：寄出前檢查（`groupPublishMissing_()`）與本季待填清單
 *   （`buildQuarterMissingFieldsReportLines_()`）都把人數合併成一行，「哪些算
 *   人數」只在這裏判斷一次，不各寫一套。
 * Args:
 *   item {?{field:string}} `buildMissingList_()` 輸出的一項。
 * Returns:
 *   {boolean}
 * Raises:
 *   （無）
 */
function isAttendanceMissingItem_(item) {
  return String((item || {}).field || '').indexOf('ATT_') === 0;
}

/**
 * 用途：人數合併成一行時的字眼「N 格未填（上週崇拜人數由內容表輸入）」。
 *   純函式。寄出前檢查與本季待填清單共用，字眼只有一處。
 * Args:
 *   count {number} 未填的人數格數。
 * Returns:
 *   {string}
 * Raises:
 *   （無）
 */
function attendanceMissingSummaryText_(count) {
  return Number(count || 0) + ' 格未填（上週崇拜人數由內容表輸入）';
}

/**
 * 用途：把一段待填清單裏的人數各格合併成一項「人數：N 格未填（上週崇拜人數由內容表
 *   輸入）」，其餘項目原樣、次序不變；合併那一項放在第一格人數原本的位置。純函式。
 *
 *   第二批測試修正 G14：填寫介面頂部「待填」面板（單一主日）原本逐格列出 12 格人數，
 *   與寄出前檢查、本季待填清單（G7）不一致。判斷與字眼用 isAttendanceMissingItem_()
 *   與 attendanceMissingSummaryText_()，與 G7 同一組函式。這裏只合併「顯示用」的
 *   清單；待填項數（徽章、主日下拉、寄出前檢查的數字）照舊按格數計，呼叫方用原本
 *   的清單數，不可以拿這裏的長度去數。
 * Args:
 *   items {Object[]} buildMissingList_() 輸出的其中一段（例如 splitMissingList_() 的
 *     required 或 optional），每項 {field, label, reason, optional}。
 * Returns:
 *   {Object[]} 新陣列。人數那一項是 {field:'ATT_*', label:'人數', reason, optional,
 *     cellCount}，cellCount 是它代表的格數；沒有人數項目時內容與輸入相同。
 * Raises:
 *   （無）
 */
function mergeAttendanceMissingItems_(items) {
  var out = [];
  var attendanceIndex = -1;
  var attendanceCount = 0;
  var attendanceOptional = false;
  (items || []).forEach(function (item) {
    if (!isAttendanceMissingItem_(item)) {
      out.push(item);
      return;
    }
    if (attendanceIndex === -1) {
      attendanceIndex = out.length;
      attendanceOptional = (item || {}).optional === true;
      out.push(null);
    }
    attendanceCount++;
  });
  if (attendanceIndex !== -1) {
    out[attendanceIndex] = {
      field: 'ATT_*',
      label: '人數',
      reason: attendanceMissingSummaryText_(attendanceCount),
      optional: attendanceOptional,
      cellCount: attendanceCount
    };
  }
  return out;
}

/**
 * 用途：取出一個主日職事表快照內 `FLOWER` 崗位的名字。純函式。
 *   `applyFlowerFromRoster_()`（帶入獻花）與填寫介面獻花欄位旁邊的提示
 *   （`model.flowerRoster`）共用這一個——兩邊各算一次就是兩個真相來源。
 *   一個崗位可以有多位（例如兩家人一齊獻花），用頓號串起來，次序照
 *   職事表，不重新排序。
 * Args:
 *   snap {?Object} 某個主日的職事表快照；可以是 `null` 或 `found` 為假。
 * Returns:
 *   {string} 名字；快照缺失、沒有 `FLOWER` 崗位或名字全為空白時回空字串。
 */
function rosterFlowerName_(snap) {
  if (!snap || !snap.found) return '';
  var slots = (snap.slotsByPost || {}).FLOWER || [];
  var names = slots.map(function (slot) {
    var name = (slot.rosterName === undefined || slot.rosterName === null)
      ? slot.personName : slot.rosterName;
    return String(name || '').trim();
  }).filter(function (n) { return n !== ''; });
  return names.join('、');
}

/**
 * 用途：**R-042**——把職事表 `FLOWER` 崗位的值帶入獻花兩個週欄位。
 *   **純函式。**
 *
 *   規則三條，與其他覆寫機制一致：
 *     1. 週報那一格**有值** → 那就是人手填的（或者上一次帶入之後改過），
 *        一格都不動；
 *     2. 週報那一格空白、職事表有值 → 帶入；
 *     3. 兩邊都空白 → 維持空白。
 *
 *   ⚠️ 第 1 條就是「人手輸入即覆寫」：這裏**不會**用職事表蓋走已填的值。
 *   要跟隨職事表就把那一格清空，下一次載入自然帶入。
 *
 *   ⚠️ 帶入的是職事表的名字（`rosterFlowerName_()`）。獻花崗位不在
 *   事奉框內（`PostDisplay` 兩頁都不顯示），所以沒有地方可以對它寫
 *   `DutyOverride`；要改人就直接改獻花那一格——那就是第 1 條。
 * Args:
 *   week {Object} `BulletinWeeks` 那一行。
 *   snapshot {Object} 這一個主日的職事表快照。
 *   nextSnapshot {?Object} 下一個主日的職事表快照；沒有就傳 `null`。
 * Returns:
 *   {Object} 一個**新物件**，不改動傳進來那個。
 */
function applyFlowerFromRoster_(week, snapshot, nextSnapshot) {
  var out = {};
  Object.keys(week || {}).forEach(function (k) { out[k] = week[k]; });

  function fill(key, snap) {
    var current = String(out[key] === null || out[key] === undefined ? '' : out[key]).trim();
    if (current !== '') return;              // ⚠️ 人手填過的一格都不動
    var name = rosterFlowerName_(snap);
    if (name) out[key] = name;
  }

  fill('FLOWER_THIS_WEEK', snapshot);
  fill('FLOWER_NEXT_WEEK', nextSnapshot);
  return out;
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

