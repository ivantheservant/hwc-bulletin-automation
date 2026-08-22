/**
 * BulletinRender.gs
 *
 * 把 `buildBulletinModel_()` 的週報資料模型，轉成 Word 範本要用的
 * **佔位符表**（單值 ＋ 清單），再串起 `src/DocxTemplate.gs`（純 XML）
 * 與 `src/DocxIo.gs`（Drive IO），產生 `.docx`。
 *
 * 三層分工：
 *   - `buildRenderContext_(model)`　**純函式**，資料模型 → 佔位符表。
 *     不碰任何 Google 服務，方便在 Node 直接測試。
 *   - `generateBulletinDocx_(isoDate)`　真正入口，讀 Config、讀模型、
 *     呼叫 IO 層產生 blob。
 *   - `menuGenerateBulletinDocx_()` 等　選單處理函式。
 *
 * ⚠️ 完整的佔位符清單（含來源欄位與範例值）見
 * docs/佔位符對照表.md；那份文件是寫給**不懂程式的人照住在 Word 加
 * 佔位符**用的，改動本檔案的佔位符名稱時一定要同步更新它。
 */

'use strict';

/**
 * 用途：`PROGRAM` 清單中代表「這是全寬列」的欄位名稱。
 *
 *   ⚠️ 崇拜程序表的一般列與全寬列在原表中是**交錯**出現的（「祈禱會」
 *   排在「家事報告」之後），所以一定要用「一個清單 ＋ 一個旗標」，
 *   不可以拆成兩個清單各自展開——詳見
 *   `src/DocxTemplate.gs` 的 `expandInterleavedRows_()`。
 * Args: （無）
 * Returns:
 *   {string}
 */
function programFullWidthFlagKey_() {
  return 'IS_FULL_WIDTH';
}

/**
 * 用途：`renderDocumentXml_()` 的 `interleavedLists` 參數——列出哪些清單
 *   要走交錯展開。寫成函式而不是頂層常數，是為了不依賴 `.gs` 載入次序
 *   （見 docs/已知bug類型.md 事故一）。
 * Args: （無）
 * Returns:
 *   {Object<string,string>} 清單名稱 → 全寬旗標欄位名。
 */
function interleavedListsConfig_() {
  var config = {};
  config.PROGRAM = programFullWidthFlagKey_();
  return config;
}

/**
 * 用途：把任意值轉成佔位符要用的字串——`null`／`undefined` 一律空字串。
 * Args:
 *   value {*}
 * Returns:
 *   {string}
 */
function renderValueText_(value) {
  return String(value === null || value === undefined ? '' : value);
}

/**
 * 用途：把數字補成至少 `digits` 位，前面補 `0`（例如 `padDutyNumber_(3, 2)`
 *   → `'03'`）。
 * Args:
 *   n {number} 1 起算的序號。
 *   digits {number} 最少位數。
 * Returns:
 *   {string}
 */
function padDutyNumber_(n, digits) {
  var s = String(n);
  while (s.length < digits) s = '0' + s;
  return s;
}

/**
 * 用途：組出「編號事奉佔位符」——`DUTY_01`..`DUTY_NN`／
 *   `NEXT_DUTY_01`..`NEXT_DUTY_NN`（prompt9 §1.2）。範本用的是固定位置的
 *   事奉框（不是像 `{{#EACH:DUTY}}` 那樣的重複列），所以每個崗位要有
 *   自己獨立的佔位符名稱。
 *
 *   ⚠️ **超出實際事奉行數的編號一律輸出空字串**，絕對不可以在成品 Word
 *   留下 `{{DUTY_11}}` 這種原樣未替換的文字——`replaceSimplePlaceholders_()`
 *   對「有提供這個鍵、值是空字串」與「完全沒有提供這個鍵」的處理不同
 *   （後者會依 `TEMPLATE_MISSING_VALUE_MODE` 決定要不要保留原樣），所以
 *   這裡一定要**把 1 到 max 每一個編號都當成鍵寫進 `values`**，即使值是
 *   空字串。
 * Args:
 *   prefix {string} `'DUTY_'` 或 `'NEXT_DUTY_'`。
 *   rows {Object[]} `dutyBoxPage1`／`nextWeekDuty`，每筆 `{label, text}`
 *     （已經套用尊稱與合併規則）。
 *   max {number} 上限（Config `DUTY_PLACEHOLDER_MAX`）。
 * Returns:
 *   {Object<string,string>} 佔位符名稱 → `'崗位名稱：姓名'` 整串，或空字串。
 */
function buildNumberedDutyValues_(prefix, rows, max) {
  var list = rows || [];
  var limit = Math.max(0, Number(max) || 0);
  var digits = Math.max(2, String(limit).length);
  var out = {};

  for (var i = 1; i <= limit; i++) {
    var key = prefix + padDutyNumber_(i, digits);
    var row = list[i - 1];
    out[key] = row ? (renderValueText_(row.label) + '：' + renderValueText_(row.text)) : '';
  }
  return out;
}

/** `{{FINANCE_TITLE}}` 沒有另外設定 `financeTitlePattern` 時的預設樣式。 */
var FINANCE_TITLE_PATTERN_DEFAULT_ = '聖道堂綜合收支財務報告-{{YEAR}}年 {{MONTH}}月份';

/**
 * 用途：算出「這個主日的財務報告要顯示的月份」——固定是**上一個月**
 *   （財務報告照慣例滯後一個月結算），並處理年份跨年（1 月的上一個月
 *   是去年 12 月）。純函式。
 * Args:
 *   isoDate {string} 主日日期，yyyy-MM-dd。
 * Returns:
 *   {?{year:number, month:number}} `month` 不補零（`1` 不是 `'01'`）；
 *     `isoDate` 格式不對時回 `null`。
 */
function financeReportPreviousMonth_(isoDate) {
  var m = /^(\d{4})-(\d{2})-\d{2}$/.exec(String(isoDate || ''));
  if (!m) return null;

  var year = Number(m[1]);
  var month = Number(m[2]) - 1;
  if (month < 1) {
    month = 12;
    year -= 1;
  }
  return { year: year, month: month };
}

/** `{{FINANCE_PERIOD_LABEL}}` 沒有另外設定樣式時的預設值（財政表首欄期別標籤）。 */
var FINANCE_PERIOD_LABEL_PATTERN_DEFAULT_ = '{{MONTH}}月份';

/**
 * 用途：把一個「財務報告樣式字串」內的 `{{YEAR}}`／`{{MONTH}}` 換成
 *   `financeReportPreviousMonth_()` 算出來的年份與月份。純函式。
 *
 *   ⚠️ **`{{FINANCE_TITLE}}` 與 `{{FINANCE_PERIOD_LABEL}}` 一律經過這一個
 *   函式**，所以兩者的月份永遠一致。兩邊各自算一次月份就是同一個狀態有
 *   兩個真相來源（docs/已知bug類型.md 第 3 類）——那樣的話標題印「10月份」
 *   而首欄印「11月份」這種錯，要到印出來才會發現。
 * Args:
 *   pattern {string} 原始樣式字串（例如
 *     `'聖道堂綜合收支財務報告-{{YEAR}}年 {{MONTH}}月份'` 或 `'{{MONTH}}月份'`）。
 *   isoDate {string} 主日日期，yyyy-MM-dd，用來算「上一個月」。
 * Returns:
 *   {string} `isoDate` 格式不對（例如空模型）時回空字串。
 */
function applyFinanceMonthPattern_(pattern, isoDate) {
  var prev = financeReportPreviousMonth_(isoDate);
  if (!prev) return '';
  return String(pattern || '')
    .split('{{YEAR}}').join(String(prev.year))
    .split('{{MONTH}}').join(String(prev.month));
}

/**
 * 用途：組出 `{{FINANCE_TITLE}}` 佔位符的值。純函式。
 * Args:
 *   pattern {string} Config `FINANCE_TITLE_PATTERN` 的原始樣式字串。
 *   isoDate {string} 主日日期，yyyy-MM-dd，用來算「上一個月」。
 * Returns:
 *   {string} `isoDate` 格式不對（例如空模型）時回空字串。
 */
function buildFinanceTitle_(pattern, isoDate) {
  return applyFinanceMonthPattern_(pattern, isoDate);
}

/**
 * 用途：組出 `{{FINANCE_PERIOD_LABEL}}` 佔位符的值——財政表首欄的期別
 *   標籤（原本在範本內硬寫「11月份」，即是不論哪一期都印同一個月）。
 *   純函式。
 * Args:
 *   pattern {string} Config `FINANCE_PERIOD_LABEL_PATTERN` 的原始樣式字串。
 *   isoDate {string} 主日日期，yyyy-MM-dd，用來算「上一個月」。
 * Returns:
 *   {string} `isoDate` 格式不對（例如空模型）時回空字串。
 */
function buildFinancePeriodLabel_(pattern, isoDate) {
  return applyFinanceMonthPattern_(pattern, isoDate);
}

/**
 * 用途：把資料模型轉成 Word 範本要用的佔位符表。**純函式**。
 *
 *   完整的佔位符清單見 docs/佔位符對照表.md。這裡刻意把全部鍵都**明確
 *   列出來**（而不是用迴圈由 `BulletinWeeks` 機器鍵自動生成），原因有二：
 *     1. 範本用到的名稱是對外承諾，不可以因為工作表加了一欄就靜靜多出
 *        一個佔位符、或者改欄名就靜靜消失。
 *     2. 「系統提供哪些佔位符」要能被
 *        `inspectTemplatePlaceholders_()` 拿來跟範本實際用到的對帳。
 * Args:
 *   model {Object} `buildBulletinModel_()` 的輸出。
 *   options {{churchName:string=, generatedAt:string=,
 *            cantoneseSubColumnLabel:string=}=} 選填。
 *     資料模型本身沒有這幾樣東西（它們來自 Config 或產生當下的時間），
 *     所以由呼叫方傳進來，純函式層不自己讀 Config。
 * Returns:
 *   {{values:Object<string,string>, lists:Object<string,Object[]>}}
 */
function buildRenderContext_(model, options) {
  var m = model || {};
  var opts = options || {};
  var header = m.header || {};
  var attendance = m.attendance || { columns: [], rows: [] };
  var flowers = m.flowers || {};
  var prayerBlock = m.prayerBlock || { heading: '', items: [] };
  var week = m.weekFields || {};

  var values = {};

  // ---- 封面與標題 ----
  values.SERVICE_DATE_COVER = renderValueText_(header.coverDate);
  values.SERVICE_DATE = renderValueText_(m.isoDate);
  values.PAGE_TITLE = renderValueText_(header.pageTitle);
  values.SPECIAL_TYPE = renderValueText_(m.special && m.special.title);

  // ---- 崇拜程序（非表格部分）----
  values.PRELUDE = renderValueText_(week.PRELUDE);
  values.CALL_TEXT = renderValueText_(week.CALL_TEXT);
  values.CALL_REF = renderValueText_(week.CALL_REF);
  values.CALL_COMBINED = buildCallCombined_(week.CALL_TEXT, week.CALL_REF, opts.callFormat);
  values.RECITATION = renderValueText_(m.recitation);
  values.HYMN_PRAISE = renderValueText_(week.HYMN_PRAISE);
  values.CHOIR_LABEL = renderValueText_(week.CHOIR_LABEL);
  values.CHOIR_TITLE = renderValueText_(week.CHOIR_TITLE);
  values.SCRIPTURE_REF = renderValueText_(week.SCRIPTURE_REF);
  values.SERMON_TITLE = renderValueText_(week.SERMON_TITLE);
  values.RESPONSE_HYMN = renderValueText_(week.RESPONSE_HYMN);

  // ---- 人數表 ----
  values.ATTENDANCE_HEADING = renderValueText_(header.attendanceHeading);
  values.ATTENDANCE_DATE = renderValueText_(header.attendanceDate);
  attendanceValueKeys_().forEach(function (key) {
    values[key] = renderValueText_(week[key]);
  });
  values.CANTONESE_SUBCOLUMN_LABEL = renderValueText_(opts.cantoneseSubColumnLabel);

  // ---- 事奉與獻花 ----
  values.NEXT_WEEK_HEADING = renderValueText_(header.nextWeekHeading);
  values.NEXT_WEEK_DATE = renderValueText_(header.nextWeekDate);
  values.FLOWER_THIS_WEEK = renderValueText_(flowers.thisWeek);
  values.FLOWER_NEXT_WEEK = renderValueText_(flowers.nextWeek);

  // ---- 其他 ----
  values.PRAYER_BLOCK_HEADING = renderValueText_(prayerBlock.heading);
  values.WEEKLY_BIBLE_READING = renderValueText_(week.WEEKLY_BIBLE_READING);
  values.CHURCH_NAME = renderValueText_(opts.churchName);
  values.ROSTER_VERSION = renderValueText_(m.rosterVersionUsed);
  values.GENERATED_AT = renderValueText_(opts.generatedAt);

  // ---- 財務報告（prompt9 §1.6 補漏）----
  // ⚠️ financeTitlePattern 沒提供時用跟 Config FINANCE_TITLE_PATTERN 一致
  // 的預設值——理由同上面 dutyPlaceholderMax：純函式層不讀 Config，真正
  // 入口（generateBulletinDocx_()）會把 Config 的實際值傳進 opts。
  var financeTitlePattern = opts.financeTitlePattern === undefined
    ? FINANCE_TITLE_PATTERN_DEFAULT_
    : opts.financeTitlePattern;
  values.FINANCE_TITLE = buildFinanceTitle_(financeTitlePattern, m.isoDate);
  values.FINANCE_NOTE = renderValueText_(week.FINANCE_NOTE);
  values.FINANCE_BALANCE = renderValueText_(week.FINANCE_BALANCE);

  // 財政表首欄的期別標籤。**與 FINANCE_TITLE 共用同一個月份來源**
  // （applyFinanceMonthPattern_ → financeReportPreviousMonth_），兩者
  // 不可能算出不同的月份。
  var financePeriodPattern = opts.financePeriodLabelPattern === undefined
    ? FINANCE_PERIOD_LABEL_PATTERN_DEFAULT_
    : opts.financePeriodLabelPattern;
  values.FINANCE_PERIOD_LABEL = buildFinancePeriodLabel_(financePeriodPattern, m.isoDate);

  // ---- 浸禮合堂副框六欄 ----
  // 顯示文字（單人欄位的尊稱）已經由 buildBaptismBoxFields_() 在資料模型
  // 層算好（那一層才讀得到 PersonDisplay），這裡只負責搬進佔位符表。
  // ⚠️ 六個鍵一定要齊全（沒有值的是空字串）：副框的留空規則靠
  // `isTruthyForTemplate_()` 判斷，缺鍵與空字串的處理完全不同。
  var baptism = m.baptism || {};
  baptismBoxFieldKeys_().forEach(function (key) {
    values[key] = renderValueText_(baptism[key]);
  });

  // ---- 編號事奉佔位符（prompt9 §1.2）----
  // ⚠️ 沒有提供 dutyPlaceholderMax 時用 20（跟 Config DUTY_PLACEHOLDER_MAX
  // 的預設值一致）——這裡刻意用寫死的預設值而不是讀 Config，因為本函式
  // 是純函式層，不可以碰 Apps Script 服務；真正入口
  // （generateBulletinDocx_()）會把 Config 的實際值傳進 opts。
  var dutyMax = opts.dutyPlaceholderMax === undefined ? 20 : Number(opts.dutyPlaceholderMax);
  Object.assign(values, buildNumberedDutyValues_('DUTY_', m.dutyBoxPage1, dutyMax));
  Object.assign(values, buildNumberedDutyValues_('NEXT_DUTY_', m.nextWeekDuty, dutyMax));

  return { values: values, lists: buildRenderLists_(m) };
}

/**
 * 用途：人數表 12 個人數欄的機器鍵，依英語堂／粵語堂主堂／粵語堂北岸／
 *   華語堂 × 崇拜／祈禱會／兒童 排列。寫成函式延遲求值（載入次序）。
 * Args: （無）
 * Returns:
 *   {string[]}
 */
function attendanceValueKeys_() {
  return [
    'ATT_ENG_WORSHIP', 'ATT_CANE_WORSHIP', 'ATT_CANN_WORSHIP', 'ATT_MAN_WORSHIP',
    'ATT_ENG_PRAYER', 'ATT_CANE_PRAYER', 'ATT_CANN_PRAYER', 'ATT_MAN_PRAYER',
    'ATT_ENG_CHILD', 'ATT_CANE_CHILD', 'ATT_CANN_CHILD', 'ATT_MAN_CHILD'
  ];
}

/**
 * 用途：把宣召經文與出處合成一句（`CALL_COMBINED` 佔位符）。純函式。
 *
 *   三種情況：
 *     - 兩者皆有 → 依 `format` 組合，預設 `經文（出處）`
 *     - 只有其中一個 → 直接用那一個，**不會留下孤零零的括號**
 *     - 兩者皆空 → 空字串
 * Args:
 *   callText {*} 宣召經文。
 *   callRef {*} 宣召出處。
 *   format {string=} 組合樣式，用 `{{CALL_TEXT}}` 與 `{{CALL_REF}}` 兩個
 *     佔位符；省略時用 `'{{CALL_TEXT}}（{{CALL_REF}}）'`。
 * Returns:
 *   {string}
 */
function buildCallCombined_(callText, callRef, format) {
  var text = renderValueText_(callText).trim();
  var ref = renderValueText_(callRef).trim();

  if (!text && !ref) return '';
  if (text && !ref) return text;
  if (!text && ref) return ref;

  var pattern = format || '{{CALL_TEXT}}（{{CALL_REF}}）';
  return pattern.split('{{CALL_TEXT}}').join(text).split('{{CALL_REF}}').join(ref);
}

/**
 * 用途：把資料模型的各個清單轉成範本要用的清單佔位符資料。純函式。
 *
 *   欄位名稱一律大寫、只含 `A-Z0-9_`，跟單值佔位符同一套規約。
 * Args:
 *   model {Object} `buildBulletinModel_()` 的輸出。
 * Returns:
 *   {Object<string,Object[]>} 清單名稱 → 資料列陣列。
 */
function buildRenderLists_(model) {
  var m = model || {};
  var flagKey = programFullWidthFlagKey_();

  var program = (m.program || []).map(function (row) {
    var item = {
      ITEM: renderValueText_(row.itemName),
      CONTENT: renderValueText_(row.content),
      POSTURE: renderValueText_(row.posture)
    };
    item[flagKey] = Boolean(row.fullWidth);
    return item;
  });

  var duty = (m.dutyBoxPage1 || []).map(function (row) {
    return { LABEL: renderValueText_(row.label), NAMES: renderValueText_(row.text) };
  });

  var nextDuty = (m.nextWeekDuty || []).map(function (row) {
    return { LABEL: renderValueText_(row.label), NAMES: renderValueText_(row.text) };
  });

  var announcement = (m.announcements || []).map(function (row, i) {
    return { NO: String(i + 1), TEXT: renderValueText_(row.text) };
  });

  var prayer = ((m.prayerBlock && m.prayerBlock.items) || []).map(function (row, i) {
    return { NO: String(i + 1), TEXT: renderValueText_(row.text) };
  });

  var fellowship = (m.fellowships || []).map(function (row) {
    return {
      NAME: renderValueText_(row.fellowshipName),
      DATE: renderValueText_(row.meetingDate),
      TIME: renderValueText_(row.meetingTime),
      CONTENT: renderValueText_(row.content)
    };
  });

  var finance = (m.finance || []).map(function (row) {
    return {
      LABEL: renderValueText_(row.rowLabel),
      COL1: renderValueText_(row.specialOverseas),
      COL2: renderValueText_(row.hardship),
      COL3: renderValueText_(row.col3),
      COL4: renderValueText_(row.col4)
    };
  });

  return {
    PROGRAM: program,
    DUTY: duty,
    NEXT_DUTY: nextDuty,
    ANNOUNCEMENT: announcement,
    PRAYER: prayer,
    FELLOWSHIP: fellowship,
    FINANCE: finance
  };
}

/**
 * 用途：列出系統提供的**全部**單值佔位符名稱，供
 *   `inspectTemplatePlaceholders_()` 跟範本實際用到的對帳。
 *
 *   做法是用一個空白模型跑一次 `buildRenderContext_()`，直接讀它的鍵——
 *   這樣「系統提供哪些佔位符」永遠只有**一個真相**（`buildRenderContext_()`
 *   本身），不會出現「對照清單忘記更新」這種必然會發生的落差。
 * Args: （無）
 * Returns:
 *   {string[]} 依字母序排序。
 */
function supportedValuePlaceholderNames_() {
  var context = buildRenderContext_({}, {});
  return Object.keys(context.values).sort();
}

/**
 * 用途：列出系統提供的全部清單佔位符與它們的欄位，供對帳用。
 * Args: （無）
 * Returns:
 *   {{list:string, fields:string[]}[]} 依清單名稱字母序排序。
 */
function supportedListPlaceholders_() {
  var flagKey = programFullWidthFlagKey_();
  var fieldsByList = {
    PROGRAM: ['ITEM', 'CONTENT', 'POSTURE'],
    DUTY: ['LABEL', 'NAMES'],
    NEXT_DUTY: ['LABEL', 'NAMES'],
    ANNOUNCEMENT: ['NO', 'TEXT'],
    PRAYER: ['NO', 'TEXT'],
    FELLOWSHIP: ['NAME', 'DATE', 'TIME', 'CONTENT'],
    FINANCE: ['LABEL', 'COL1', 'COL2', 'COL3', 'COL4']
  };
  // 旗標欄位不是給範本用的（它只決定選哪一個列範本），所以不列出來。
  void flagKey;

  return Object.keys(fieldsByList).sort().map(function (list) {
    return { list: list, fields: fieldsByList[list] };
  });
}

// =====================================================================
// 真正入口
// =====================================================================

/**
 * 用途：依這一週的程序範本，決定要用哪一個 Word 範本檔案 ID。
 * Args:
 *   templateId {?string} `model.templateId`（`TPL_NORMAL` 等）。
 * Returns:
 *   {{configKey:string, fileId:string, label:string}} `fileId` 是空字串
 *     代表那個範本還沒有設定。
 */
function resolveWordTemplate_(templateId) {
  if (isBaptismTemplateId_(templateId)) {
    return {
      configKey: CONFIG_KEYS.TEMPLATE_FILE_ID_COMBINED_BAPTISM,
      fileId: getConfig(CONFIG_KEYS.TEMPLATE_FILE_ID_COMBINED_BAPTISM, ''),
      label: '浸禮三堂聯合崇拜'
    };
  }
  if (templateId === PROGRAM_TEMPLATE_ID_ANNIVERSARY_) {
    return {
      configKey: CONFIG_KEYS.TEMPLATE_FILE_ID_ANNIVERSARY,
      fileId: getConfig(CONFIG_KEYS.TEMPLATE_FILE_ID_ANNIVERSARY, ''),
      label: '堂慶三堂聯合崇拜'
    };
  }
  return {
    configKey: CONFIG_KEYS.TEMPLATE_FILE_ID_NORMAL,
    fileId: getConfig(CONFIG_KEYS.TEMPLATE_FILE_ID_NORMAL, ''),
    label: '平常主日'
  };
}

/**
 * 用途：組出輸出檔名，把 Config `OUTPUT_FILE_NAME_PATTERN` 內的
 *   `{{SERVICE_DATE}}` 換成主日日期。
 * Args:
 *   isoDate {string} 主日日期，yyyy-MM-dd。
 *   pattern {string=} 檔名樣式；省略時讀 Config。
 * Returns:
 *   {string} 保證以 `.docx` 結尾（樣式漏了副檔名時自動補上）。
 */
function buildOutputFileName_(isoDate, pattern) {
  var raw = pattern === undefined
    ? getConfig(CONFIG_KEYS.OUTPUT_FILE_NAME_PATTERN, '{{SERVICE_DATE}}_粵語堂週報.docx')
    : pattern;
  var name = String(raw || '').split('{{SERVICE_DATE}}').join(String(isoDate || ''));
  if (!name) name = String(isoDate || 'bulletin') + '.docx';
  if (name.slice(-5).toLowerCase() !== '.docx') name += '.docx';
  return name;
}

/**
 * 用途：組出「尚未設定 Word 範本」的統一結果物件。
 *
 *   ⚠️ 這個訊息一定要明確講「**尚未設定 Word 範本，請在 Config 填入
 *   範本檔案 ID**」，不可以當成「沒有資料」或者回一個空白對話框——
 *   兩者的處理方式完全不同（一個要去填設定，一個要去填內容），
 *   混在一起會讓幹事完全不知道下一步要做什麼。這是 prompt7 §6 的硬要求。
 * Args:
 *   template {Object} `resolveWordTemplate_()` 的輸出。
 * Returns:
 *   {{ok:boolean, notConfigured:boolean, reason:string, message:string,
 *     templateLabel:string, configKey:string}}
 */
function wordTemplateNotConfiguredResult_(template) {
  return {
    ok: false,
    notConfigured: true,
    reason: 'NO_TEMPLATE',
    templateLabel: template.label,
    configKey: template.configKey,
    message: '尚未設定 Word 範本，請在 Config 填入範本檔案 ID。'
      + '這一週用的是「' + template.label + '」範本，對應的設定鍵是「' + template.configKey + '」。'
      + '（把範本 .docx 上載到雲端硬碟，開啟它，網址中間那一段就是檔案 ID。）'
  };
}

/**
 * 用途：產生一份週報 `.docx`（只產生 blob，不寫檔）。真正入口。
 *
 *   流程：讀資料模型 → 決定用哪個範本 → 組佔位符表 → 讀範本檔、
 *   換掉 `word/document.xml`、壓回去。
 * Args:
 *   isoDate {string} 主日日期，yyyy-MM-dd。
 * Returns:
 *   {{ok:boolean, blob:(Blob|undefined), fileName:(string|undefined),
 *     stats:(Object|undefined), warnings:(Object[]|undefined),
 *     notConfigured:(boolean|undefined), reason:(string|undefined),
 *     message:(string|undefined), templateLabel:(string|undefined)}}
 *     範本 ID 未設定 → `{ok:false, notConfigured:true, reason:'NO_TEMPLATE'}`；
 *     `RENDER_BLOCK_IF_MISSING_FIELDS=TRUE` 而且有待填欄位 →
 *     `{ok:false, reason:'MISSING_FIELDS'}`。
 * Raises:
 *   Error 如果 `isoDate` 格式不對、職事表讀取失敗、範本檔讀不到，或
 *     `TEMPLATE_MISSING_VALUE_MODE=ERROR` 而且有佔位符找不到值。
 */
function generateBulletinDocx_(isoDate) {
  var model = buildBulletinModel_(isoDate);

  if (model.notConfigured) {
    return {
      ok: false, notConfigured: true, reason: 'ROSTER_NOT_CONFIGURED',
      message: '尚未設定職事表試算表 ID，無法取得事奉名單。請先在 Config 填入 ROSTER_SPREADSHEET_ID。'
    };
  }

  var template = resolveWordTemplate_(model.templateId);
  if (!template.fileId) {
    return wordTemplateNotConfiguredResult_(template);
  }

  var blockIfMissing = normalizeBoolean_(getConfig(CONFIG_KEYS.RENDER_BLOCK_IF_MISSING_FIELDS, 'FALSE')) === true;
  if (blockIfMissing && model.missing && model.missing.length > 0) {
    return {
      ok: false, reason: 'MISSING_FIELDS',
      missingCount: model.missing.length,
      message: '這一週還有 ' + model.missing.length + ' 個待填欄位，而 Config 的 '
        + CONFIG_KEYS.RENDER_BLOCK_IF_MISSING_FIELDS + ' 設成了 TRUE，所以拒絕產生。'
        + '請先在填寫介面補齊，或者把那個設定改成 FALSE。'
    };
  }

  var context = buildRenderContext_(model, {
    churchName: getConfig(CONFIG_KEYS.CHURCH_NAME, ''),
    cantoneseSubColumnLabel: getConfig(CONFIG_KEYS.CANTONESE_SUBCOLUMN_LABEL, '主堂'),
    callFormat: getConfig(CONFIG_KEYS.CALL_TO_WORSHIP_FORMAT, '{{CALL_TEXT}}（{{CALL_REF}}）'),
    generatedAt: Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm'),
    dutyPlaceholderMax: normalizeInt_(getConfig(CONFIG_KEYS.DUTY_PLACEHOLDER_MAX, '20')),
    financeTitlePattern: getConfig(CONFIG_KEYS.FINANCE_TITLE_PATTERN, FINANCE_TITLE_PATTERN_DEFAULT_),
    financePeriodLabelPattern: getConfig(CONFIG_KEYS.FINANCE_PERIOD_LABEL_PATTERN, FINANCE_PERIOD_LABEL_PATTERN_DEFAULT_)
  });

  var fileName = buildOutputFileName_(isoDate);
  var renderStats = null;
  var renderWarnings = [];

  var rendered = renderDocxFromTemplate_(template.fileId, fileName, function (xml) {
    var result = renderDocumentXml_(xml, {
      values: context.values,
      lists: context.lists,
      interleavedLists: interleavedListsConfig_(),
      // 浸禮副框的留空規則。平常主日／堂慶範本沒有這個副框，
      // applyOptionalLabelledCellRows_() 找不到佔位符就原樣回傳，
      // 所以三個範本可以共用同一份設定。
      optionalCellRows: baptismBoxRowGroups_(),
      missingValueMode: getConfig(CONFIG_KEYS.TEMPLATE_MISSING_VALUE_MODE, 'BLANK')
    });
    renderStats = result.stats;
    renderWarnings = result.warnings;
    return result.xml;
  });

  // ---- 產出驗證：回頭實掃真正的產出，不是信上面那幾個數字 ----
  // ⚠️ 這一步刻意排在渲染之後、回傳之前，而且**不共用渲染的任何假設**
  // （重新解壓 blob）。理由見 scanDocxResidualPlaceholders_() 的說明。
  var residual = scanDocxResidualPlaceholders_(rendered.blob);
  if (residual.count !== 0) {
    var residualMessage = buildResidualPlaceholderMessage_(fileName, template.label, residual);
    renderWarnings = renderWarnings.concat([{ code: 'RESIDUAL_PLACEHOLDER', message: residualMessage }]);
    // 殘留代表「印出來的紙上真的有 {{」——一定要留低痕跡，不可以只在
    // 對話框講一次就算（對話框關掉就冇咗，見 docs/已知bug類型.md 第 13 條）。
    appendErrorLog_({
      source: ERROR_LOG_SOURCE.MENU,
      functionName: 'generateBulletinDocx_',
      errorCode: 'RESIDUAL_PLACEHOLDER',
      message: residualMessage,
      detail: JSON.stringify({ isoDate: isoDate, fileName: fileName, residual: residual })
    });
  }

  // ---- 異體字正規化：記錄替換了多少次（保險，見 normalizeVariantCharacters_）----
  // ⚠️ 只在真的有替換過才寫——範本改好之後這個數字會變 0，不應該每次都
  // 洗一次 Diagnostics（那張表是「最新一次報告」快照，見 src/Diagnostics.gs）。
  if (renderStats && renderStats.variantCharsReplaced > 0) {
    writeDiagnosticsReport_('異體字正規化', buildVariantCharsReportLines_(isoDate, fileName, renderStats.variantCharsBreakdown));
  }

  return {
    ok: true,
    blob: rendered.blob,
    fileName: fileName,
    templateLabel: template.label,
    stats: renderStats,
    residual: residual,
    warnings: renderWarnings.concat(model.warnings || []),
    modelMissingCount: (model.missing || []).length
  };
}

/**
 * 用途：組出「異體字正規化」Diagnostics 報告的內容行。**純函式。**
 * Args:
 *   isoDate {string} 主日日期，yyyy-MM-dd。
 *   fileName {string} 產生的檔名。
 *   breakdown {Object<string,number>} `normalizeVariantCharacters_()` 的
 *     \`breakdown\`——key 是正確的那個字，value 是替換次數。
 * Returns:
 *   {string[]}
 */
function buildVariantCharsReportLines_(isoDate, fileName, breakdown) {
  var lines = [
    '主日：' + isoDate + '　檔案：' + fileName,
    '',
    '範本原稿有兩個字用了錯誤的 Unicode 異體字（視覺上看不出分別，但複製、',
    '搜尋、朗讀軟件會出問題），本次產生時已經自動修正：'
  ];
  Object.keys(breakdown).forEach(function (correctChar) {
    lines.push('　「' + correctChar + '」：' + breakdown[correctChar] + ' 次');
  });
  lines.push('');
  lines.push('這是輸出前的保險，不是永久修法——請在 Word 範本原稿用「尋找及取代」');
  lines.push('修正，詳見 docs/待確認事項.md 這一輪的記錄。');
  return lines;
}

/**
 * 用途：把 `scanDocxResidualPlaceholders_()` 的結果排版成一句人看得懂的
 *   警告訊息，對話框與 `ErrorLog` 共用同一句（只有一個真相來源）。
 * Args:
 *   fileName {string} 產生的檔名。
 *   templateLabel {string} 用了哪一個範本（平常主日／浸禮／堂慶）。
 *   residual {{count:number, samples:string[], parts:string[], error:string=}}
 *     `scanDocxResidualPlaceholders_()` 的輸出。
 * Returns:
 *   {string}
 */
function buildResidualPlaceholderMessage_(fileName, templateLabel, residual) {
  if (residual.count < 0) {
    return '⚠️ 無法驗證產出（' + fileName + '）有沒有殘留佔位符：'
      + (residual.error || '未知原因')
      + '　請人手開一次那份 Word 確認紙上沒有 {{ 開頭的文字。';
  }

  var head = residual.samples.slice(0, 3);
  return '⚠️ 產出（' + fileName + '，' + templateLabel + '範本）仍然殘留 '
    + residual.count + ' 個佔位符，會原封不動印在紙上。'
    + '頭 ' + head.length + ' 個：' + head.join('　')
    + '　所在部件：' + residual.parts.join('、')
    + '　多數成因：範本那一段被 Word 切成多個格式不同的 run，或者佔位符名稱打錯字。'
    + '修法：在 Word 把那一段整段刪掉重新打一次，再撳「檢查範本佔位符」確認。';
}

/**
 * 用途：產生週報 `.docx` 並存到 Config `BULLETIN_OUTPUT_FOLDER_ID` 指定的
 *   輸出資料夾。供選單「產生本週週報（Word）」使用。
 * Args:
 *   isoDate {string} 主日日期，yyyy-MM-dd。
 * Returns:
 *   {Object} `generateBulletinDocx_()` 的輸出，成功時另加
 *     `file: {fileId, fileName, url}`。
 * Raises:
 *   Error 同 `generateBulletinDocx_()`，另加輸出資料夾開不到的情況。
 */
function saveBulletinDocx_(isoDate) {
  var result = generateBulletinDocx_(isoDate);
  if (!result.ok) return result;

  var written = writeOutputFile_(
    result.blob,
    getConfig(CONFIG_KEYS.BULLETIN_OUTPUT_FOLDER_ID, ''),
    result.fileName
  );

  return Object.assign({}, result, { file: written });
}

/**
 * 用途：讀三個 Word 範本，盤點每個範本用到的佔位符，並跟系統提供的
 *   佔位符對帳。**唯讀**，不寫任何檔案。
 *
 *   ⚠️ 範本到手之後**第一件要做的事**就是跑這個——它會直接告訴 Ivan
 *   兩張最重要的清單：
 *     - 範本用到、但系統不提供 → 範本上那個佔位符永遠不會被填
 *     - 系統提供、但範本沒有用到 → 那份資料不會出現在成品上
 *   兩者都是「印出來才發現」的錯，先對帳可以完全避免。
 * Args: （無）
 * Returns:
 *   {{templates:Object[], supportedValues:string[], supportedLists:Object[]}}
 *     `templates` 每個元素是
 *     `{label, configKey, configured, error, placeholders, usedValues,
 *       usedLists, broken, unknownValues, unusedValues}`。
 */
function inspectTemplatePlaceholders_() {
  var supportedValues = supportedValuePlaceholderNames_();
  var supportedLists = supportedListPlaceholders_();
  var supportedListNames = supportedLists.map(function (l) { return l.list; });

  var targets = [
    { label: '平常主日', configKey: CONFIG_KEYS.TEMPLATE_FILE_ID_NORMAL },
    { label: '浸禮三堂聯合崇拜', configKey: CONFIG_KEYS.TEMPLATE_FILE_ID_COMBINED_BAPTISM },
    { label: '堂慶三堂聯合崇拜', configKey: CONFIG_KEYS.TEMPLATE_FILE_ID_ANNIVERSARY }
  ];

  var templates = targets.map(function (target) {
    var fileId = getConfig(target.configKey, '');
    var entry = {
      label: target.label, configKey: target.configKey, configured: Boolean(fileId),
      error: '', placeholders: [], usedValues: [], usedLists: [], broken: [],
      unknownValues: [], unusedValues: [], unknownLists: [], unusedLists: []
    };
    if (!fileId) return entry;

    try {
      var entries = unzipDocx_(readTemplateBlob_(fileId));
      var index = findDocumentEntryIndex_(entries);
      if (index === -1) {
        entry.error = '範本內找不到 word/document.xml，可能不是一個 .docx 檔案。';
        return entry;
      }

      // ⚠️ 一定要用**跟渲染完全同一個** prepareXmlForPlaceholders_() 才盤點：
      // 被 Word 拆散的佔位符（尤其是拆成格式不同的多個 run 那一種）不整理
      // 就會漏報，而且對帳與渲染一旦各用一套假設，就會出現「對帳報沒問題、
      // 渲染卻填不到」——那正是這個系統最難查的一類錯。
      var xml = prepareXmlForPlaceholders_(entries[index].blob.getDataAsString('UTF-8')).xml;
      entry.placeholders = findPlaceholders_(xml);
      entry.broken = findBrokenPlaceholders_(xml);

      entry.usedValues = entry.placeholders
        .filter(function (p) { return p.type === 'SIMPLE'; })
        .map(function (p) { return p.name; });
      // ⚠️ #EACHP:（段落層清單）跟 #EACH:（列層清單）用同一套對帳——
      // 兩者都是「這個清單名稱系統有沒有提供」，範本用哪一種展開方式
      // 純粹是排版選擇，不應該影響對帳結果。
      entry.usedLists = entry.placeholders
        .filter(function (p) { return p.type === 'EACH' || p.type === 'EACHP'; })
        .map(function (p) { return p.name.replace(/_FW$/, ''); })
        .filter(function (name, i, arr) { return arr.indexOf(name) === i; });

      entry.unknownValues = entry.usedValues.filter(function (n) { return supportedValues.indexOf(n) === -1; });
      entry.unusedValues = supportedValues.filter(function (n) { return entry.usedValues.indexOf(n) === -1; });
      entry.unknownLists = entry.usedLists.filter(function (n) { return supportedListNames.indexOf(n) === -1; });
      entry.unusedLists = supportedListNames.filter(function (n) { return entry.usedLists.indexOf(n) === -1; });
    } catch (err) {
      entry.error = (err && err.message) ? err.message : String(err);
    }

    return entry;
  });

  return { templates: templates, supportedValues: supportedValues, supportedLists: supportedLists };
}

/**
 * 用途：清單名稱系統有提供、但**預期範本不會用到**的清單——不是缺漏，
 *   是設計上就改用其他寫法。目前只有 `DUTY`／`NEXT_DUTY`：prompt9 §1.2
 *   新增了編號單值佔位符 `DUTY_01`..`DUTY_NN`／`NEXT_DUTY_01`..`NN`
 *   （固定位置的事奉框），範本改用那一組之後，`{{#EACH:DUTY}}`／
 *   `{{#EACH:NEXT_DUTY}}` 這兩個清單標記自然不會再出現。寫成函式延遲
 *   求值，理由同其餘 seed／設定小工具（見 docs/已知bug類型.md 事故一）。
 * Args: （無）
 * Returns:
 *   {string[]}
 */
function expectedUnusedListNames_() {
  return ['DUTY', 'NEXT_DUTY'];
}

/**
 * 用途：把「系統提供、但範本沒有用到的清單」報告行裡，`expectedUnusedListNames_()`
 *   列出的清單標成「這是正常的，不是缺漏」，避免每次看報告都要重新
 *   判斷一次「這個是不是真的問題」。
 * Args:
 *   name {string} 清單名稱。
 * Returns:
 *   {string}
 */
function annotateExpectedUnusedList_(name) {
  if (expectedUnusedListNames_().indexOf(name) === -1) return name;
  return name + '（正常，範本改用編號佔位符）';
}

/**
 * 用途：把 `inspectTemplatePlaceholders_()` 的結果排版成 `Diagnostics`
 *   報告的內容行。
 *
 *   ⚠️ 區段標題一律用全形括號「【…】」，不可以用 `===` 開頭——見
 *   docs/已知bug類型.md 事故六。
 * Args:
 *   report {Object} `inspectTemplatePlaceholders_()` 的輸出。
 * Returns:
 *   {string[]}
 */
function buildTemplateInspectionLines_(report) {
  var lines = [];

  lines.push('【系統提供的單值佔位符（' + report.supportedValues.length + ' 個）】');
  lines.push(report.supportedValues.map(function (n) { return '{{' + n + '}}'; }).join('　'));
  lines.push('');
  lines.push('【系統提供的清單佔位符】');
  report.supportedLists.forEach(function (l) {
    lines.push('　{{#EACH:' + l.list + '}}　欄位：'
      + l.fields.map(function (f) { return '{{' + l.list + '.' + f + '}}'; }).join('　'));
  });

  report.templates.forEach(function (t) {
    lines.push('');
    lines.push('【範本：' + t.label + '（' + t.configKey + '）】');

    if (!t.configured) {
      lines.push('　尚未設定 Word 範本，請在 Config 填入範本檔案 ID。');
      return;
    }
    if (t.error) {
      lines.push('　讀取失敗：' + t.error);
      return;
    }

    lines.push('　用到的單值佔位符（' + t.usedValues.length + '）：' + (t.usedValues.join('　') || '（無）'));
    lines.push('　用到的清單（' + t.usedLists.length + '）：' + (t.usedLists.join('　') || '（無）'));

    lines.push('　⚠️ 範本用到、但系統不提供（' + t.unknownValues.length + '）：'
      + (t.unknownValues.join('　') || '（無）'));
    lines.push('　⚠️ 範本用到、但系統不提供的清單（' + t.unknownLists.length + '）：'
      + (t.unknownLists.join('　') || '（無）'));
    lines.push('　系統提供、但範本沒有用到（' + t.unusedValues.length + '）：'
      + (t.unusedValues.join('　') || '（無）'));
    lines.push('　系統提供、但範本沒有用到的清單（' + t.unusedLists.length + '）：'
      + (t.unusedLists.map(annotateExpectedUnusedList_).join('　') || '（無）'));

    if (t.broken.length > 0) {
      lines.push('　⚠️ 疑似被切斷的佔位符（' + t.broken.length + '）——這些永遠不會被替換，會原樣印出來：');
      t.broken.forEach(function (b) {
        lines.push('　　第 ' + (b.paragraphIndex + 1) + ' 段（' + b.kind + '）：' + b.text);
      });
      lines.push('　　修法：在 Word 把那個佔位符整段刪掉重新打一次，見 docs/Word範本製作指引.md。');
    } else {
      lines.push('　疑似被切斷的佔位符：（無）');
    }
  });

  return lines;
}

// =====================================================================
// 選單處理函式
// =====================================================================

/**
 * 用途：選單項目「產生本週週報（Word）」的處理函式。
 * Args: （無）
 * Returns:
 *   {void}
 */
function menuGenerateBulletinDocx_() {
  var ui = SpreadsheetApp.getUi();
  try {
    var defaultDate = getConfig(CONFIG_KEYS.ROSTER_TEST_DATE, '2027-10-03');
    var resp = ui.prompt(
      '產生本週週報（Word）',
      '請輸入主日日期，格式 yyyy-MM-dd（例如 ' + defaultDate + '）：',
      ui.ButtonSet.OK_CANCEL
    );
    if (resp.getSelectedButton() !== ui.Button.OK) return;

    var isoDate = resp.getResponseText().trim() || defaultDate;
    var result = saveBulletinDocx_(isoDate);

    if (!result.ok) {
      ui.alert('未能產生週報', result.message || ('原因代碼：' + result.reason), ui.ButtonSet.OK);
      return;
    }

    var lines = buildGenerateResultDialogLines_(isoDate, result);
    var residual = result.residual || { count: 0 };
    // 產出真的有殘留時，連對話框標題都要講明——標題是唯一一定看得到的
    // 部分，內文有機會被使用者一眼掃過去。
    var title = residual.count === 0 ? '已產生週報（Word）' : '⚠️ 已產生週報，但產出有問題';
    ui.alert(title, lines.join('\n'), ui.ButtonSet.OK);
  } catch (err) {
    logMenuError_('menuGenerateBulletinDocx_', err);
    ui.alert('產生週報失敗', enrichAuthError_(err), ui.ButtonSet.OK);
  }
}

/**
 * 用途：組出「已產生週報（Word）」對話框的內容行。抽成純函式，方便
 *   測試直接驗證「殘留佔位符」那一行真的有出現、數字真的對。
 *
 *   ⚠️ 「殘留佔位符」那一行刻意排在**最前面**（在其餘統計之上）：其餘
 *   數字全部是渲染過程自己算的，只有這一個是回頭實掃產出得出來的，也
 *   只有它能證明紙上到底有沒有 `{{`。見
 *   `scanDocxResidualPlaceholders_()` 與 docs/已知bug類型.md。
 * Args:
 *   isoDate {string} 主日日期。
 *   result {Object} `saveBulletinDocx_()` 的回傳值。
 * Returns:
 *   {string[]}
 */
function buildGenerateResultDialogLines_(isoDate, result) {
  var stats = result.stats || {};
  var residual = result.residual || { count: 0, samples: [], parts: [] };
  var lines = [
    '主日日期：' + isoDate,
    '使用的範本：' + result.templateLabel,
    ''
  ];

  if (residual.count < 0) {
    lines.push('殘留佔位符：⚠️ 驗證不到（' + (residual.error || '未知原因') + '）');
    lines.push('　請人手開一次那份 Word，確認紙上沒有 {{ 開頭的文字。');
    lines.push('');
  } else if (residual.count > 0) {
    lines.push('殘留佔位符：' + residual.count + ' 個　⚠️⚠️ 這些會原封不動印在紙上');
    residual.samples.slice(0, 3).forEach(function (s) { lines.push('　　' + s); });
    lines.push('　修法：在 Word 把那一段整段刪掉、一口氣重新打一次，');
    lines.push('　再撳「檢查範本佔位符」確認。詳情已寫入 ErrorLog。');
    lines.push('');
  } else {
    lines.push('殘留佔位符：0 個（已回頭掃描產出檔案確認）');
    lines.push('');
  }

  lines.push('替換的佔位符：' + (stats.replacedCount || 0) + ' 個');
  lines.push('展開的列：' + (stats.expandedRows || 0) + ' 列');
  lines.push('刪除的條件列／段落：' + (stats.removedRows || 0) + ' 列、' + (stats.removedParagraphs || 0) + ' 段');
  if ((stats.collapsedParagraphs || 0) > 0) {
    lines.push('整段壓平的段落：' + stats.collapsedParagraphs + ' 段'
      + '（範本那幾段的佔位符被 Word 切成格式不同的多個 run，已自動救回）');
  }
  lines.push('找不到值的佔位符：' + ((stats.missingKeys || []).length) + ' 個'
    + ((stats.missingKeys || []).length > 0 ? '（' + stats.missingKeys.join('、') + '）' : ''));
  lines.push('疑似被切斷的佔位符：' + ((stats.broken || []).length) + ' 個'
    + ((stats.broken || []).length > 0 ? '　⚠️ 這些會原樣印出來，請檢查範本' : ''));
  lines.push('待填欄位：' + (result.modelMissingCount || 0) + ' 個');
  lines.push('');
  lines.push('檔案：' + result.file.fileName);
  lines.push(result.file.url);

  return lines;
}

/**
 * 用途：選單項目「檢查範本佔位符」的處理函式。唯讀，結果寫入
 *   `Diagnostics`。
 * Args: （無）
 * Returns:
 *   {void}
 */
function menuInspectTemplatePlaceholders_() {
  var ui = SpreadsheetApp.getUi();
  try {
    var report = inspectTemplatePlaceholders_();
    writeDiagnosticsReport_('範本佔位符檢查', buildTemplateInspectionLines_(report));

    var configuredCount = report.templates.filter(function (t) { return t.configured; }).length;
    if (configuredCount === 0) {
      ui.alert(
        '檢查範本佔位符',
        '尚未設定 Word 範本，請在 Config 填入範本檔案 ID。\n\n'
        + '三個設定鍵：\n'
        + report.templates.map(function (t) { return '　' + t.configKey + '（' + t.label + '）'; }).join('\n')
        + '\n\n（把範本 .docx 上載到雲端硬碟，開啟它，網址中間那一段就是檔案 ID。）\n\n'
        + '系統目前提供 ' + report.supportedValues.length + ' 個單值佔位符與 '
        + report.supportedLists.length + ' 個清單，完整清單已經寫入 Diagnostics 工作表。',
        ui.ButtonSet.OK
      );
      return;
    }

    var summary = report.templates.map(function (t) {
      if (!t.configured) return '　' + t.label + '：尚未設定範本檔案 ID';
      if (t.error) return '　' + t.label + '：讀取失敗（' + t.error + '）';
      return '　' + t.label + '：用到 ' + t.usedValues.length + ' 個單值、' + t.usedLists.length + ' 個清單；'
        + '範本用到但系統不提供 ' + t.unknownValues.length + ' 個；疑似被切斷 ' + t.broken.length + ' 個';
    });

    ui.alert(
      '檢查範本佔位符',
      summary.join('\n') + '\n\n完整對帳結果已寫入 Diagnostics 工作表。',
      ui.ButtonSet.OK
    );
  } catch (err) {
    logMenuError_('menuInspectTemplatePlaceholders_', err);
    ui.alert('檢查範本佔位符失敗', enrichAuthError_(err), ui.ButtonSet.OK);
  }
}
