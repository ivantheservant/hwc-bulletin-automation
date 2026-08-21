/**
 * FillGrid.gs
 *
 * 季度集中填寫表 `Fill_<QuarterID>`：欄位定義、版面、建立與刷新。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 最重要的設計原則：唯一真相 ＋ 投影
 * ─────────────────────────────────────────────────────────────────────
 *
 * **`BulletinWeeks` 仍然是唯一真相。** 季度填寫表只是它的**投影**，
 * 方便領詩一次過填完整季詩歌、幹事一次過填完整季講題。
 *
 * 兩邊都可以編輯，靠 `FillSnapshot` 做**三方**差異比對——比對邏輯在
 * `src/FillSync.gs`，本檔案只負責「這張表長什麼樣、有哪些欄」。
 *
 * ⚠️ **不可以用「格子表現值 vs BulletinWeeks 現值」判斷衝突**：兩者不同
 * 是**正常的**（其中一邊改過），必須與快照三方比較才分得出「只有一邊
 * 改過」與「兩邊都改過」。這跟 `src/RosterDiff.gs` 用
 * `ROSTER_VALUE_AT_OVERRIDE`（而不是「職事表現值 vs 週報現值」）判斷
 * 衝突是**完全同一個道理**，見那個檔案的說明與
 * docs/已知bug類型.md 事故十一。
 */

'use strict';

/** 格子表的標題佔三行：第 1 行群組、第 2 行中文、第 3 行機器鍵。 */
var FILL_GRID_HEADER_ROWS_ = 3;

/** 資料由第 4 行開始。 */
var FILL_GRID_FIRST_DATA_ROW_ = FILL_GRID_HEADER_ROWS_ + 1;

/**
 * 用途：格子表最前面三個**唯讀**欄的機器鍵。
 *
 *   ⚠️ 這三欄的內容來自職事表（主日日期、當月第幾個主日、特別主日），
 *   不是人手填的資料，改了也不會有任何效果——所以 `onFillGridEdit_()`
 *   偵測到有人改就**還原原值並加註解**，而不是靜靜接受一個永遠不會生效
 *   的編輯。
 * Args: （無）
 * Returns:
 *   {string[]}
 */
function fillGridReadOnlyKeys_() {
  return ['_DATE', '_WEEK', '_SPECIAL'];
}

/**
 * 用途：季度填寫表的完整欄位定義（依群組、依顯示次序）。
 *
 *   `key` 是機器鍵：底線開頭的三個是唯讀的衍生欄，其餘一律是
 *   `BulletinWeeks` 的機器鍵（**同名**，所以同步時不需要任何對照表——
 *   多一層對照就多一個會不同步的地方）。
 *
 *   寫成函式延遲求值，不依賴 `.gs` 載入次序（見 docs/已知bug類型.md 事故一）。
 * Args: （無）
 * Returns:
 *   {{group:string, key:string, label:string, readOnly:boolean,
 *     plainText:boolean, options:(string|undefined)}[]}
 *     `plainText` 為 true 的欄要 `setNumberFormat('@')`；
 *     `options` 是資料驗證下拉的來源代碼（見 `fillGridValidationOptions_()`）。
 */
function fillGridColumnDefs_() {
  var defs = [];

  function add(group, key, label, extra) {
    defs.push(Object.assign({
      group: group, key: key, label: label,
      readOnly: false, plainText: false
    }, extra || {}));
  }

  // ---- 基本（唯讀，來自職事表）----
  add('基本', '_DATE', '主日日期', { readOnly: true });
  add('基本', '_WEEK', '當月第幾主日', { readOnly: true });
  add('基本', '_SPECIAL', '特別主日', { readOnly: true });

  // ---- 崇拜程序 ----
  add('崇拜程序', 'PAGE_TITLE', '程序表大標題');
  add('崇拜程序', 'PROGRAM_TEMPLATE_ID', '程序範本', { options: 'PROGRAM_TEMPLATE_ID' });
  add('崇拜程序', 'PRELUDE', '序樂');
  add('崇拜程序', 'CALL_TEXT', '宣召經文');
  add('崇拜程序', 'CALL_REF', '宣召出處');
  add('崇拜程序', 'RECITATION_OVERRIDE', '誦讀（覆寫）', { options: 'RECITATION' });
  add('崇拜程序', 'HYMN_PRAISE', '詩歌頌讚');
  add('崇拜程序', 'CHOIR_LABEL', '詩班項目名稱');
  add('崇拜程序', 'CHOIR_TITLE', '詩班曲名');
  add('崇拜程序', 'SCRIPTURE_REF', '讀經');
  add('崇拜程序', 'SERMON_TITLE', '證道講題');
  add('崇拜程序', 'RESPONSE_HYMN', '回應詩歌');

  // ---- 上週人數 ----
  add('上週人數', 'ATTENDANCE_HEADING', '人數表標題');
  // ⚠️ ATTENDANCE_DATE 一定要純文字：樣本出現過人手填 `2027-11-07`，
  // 讓 Sheets 自動轉成 Date 的話，讀回來就變成 Date 物件而不是字串，
  // 同步比對會永遠判定「有改動」。
  add('上週人數', 'ATTENDANCE_DATE', '人數統計日期', { plainText: true });
  [
    ['ATT_ENG_WORSHIP', '英語堂崇拜'], ['ATT_CANE_WORSHIP', '粵語堂主堂崇拜'],
    ['ATT_CANN_WORSHIP', '粵語堂北岸崇拜'], ['ATT_MAN_WORSHIP', '華語堂崇拜'],
    ['ATT_ENG_PRAYER', '英語堂祈禱會'], ['ATT_CANE_PRAYER', '粵語堂主堂祈禱會'],
    ['ATT_CANN_PRAYER', '粵語堂北岸祈禱會'], ['ATT_MAN_PRAYER', '華語堂祈禱會'],
    ['ATT_ENG_CHILD', '英語堂兒童'], ['ATT_CANE_CHILD', '粵語堂主堂兒童'],
    ['ATT_CANN_CHILD', '粵語堂北岸兒童'], ['ATT_MAN_CHILD', '華語堂兒童']
  ].forEach(function (pair) {
    // ⚠️ 12 個人數欄一律純文字：樣本出現過 `--` 與 `前:5 / 後:120`。
    add('上週人數', pair[0], pair[1], { plainText: true });
  });

  // ---- 事奉與獻花 ----
  add('事奉與獻花', 'NEXT_WEEK_HEADING', '下週事奉標題');
  add('事奉與獻花', 'FLOWER_THIS_WEEK', '本週獻花');
  add('事奉與獻花', 'FLOWER_NEXT_WEEK', '下週獻花');

  // ---- 其他 ----
  add('其他', 'PRAYER_BLOCK_HEADING', '代禱標題');
  add('其他', 'WEEKLY_BIBLE_READING', '本週讀經');
  add('其他', 'NOTES', '備註');

  return defs;
}

/**
 * 用途：格子表**可以同步回 `BulletinWeeks`** 的欄位機器鍵（也就是扣除
 *   三個唯讀衍生欄）。
 * Args: （無）
 * Returns:
 *   {string[]}
 */
function fillGridEditableKeys_() {
  return fillGridColumnDefs_()
    .filter(function (d) { return !d.readOnly; })
    .map(function (d) { return d.key; });
}

/**
 * 用途：由機器鍵找出它在格子表的第幾欄（1 起算）。
 * Args:
 *   key {string} 機器鍵。
 * Returns:
 *   {number} 欄號；找不到回 `-1`。
 */
function fillGridColumnIndex_(key) {
  var defs = fillGridColumnDefs_();
  for (var i = 0; i < defs.length; i++) {
    if (defs[i].key === key) return i + 1;
  }
  return -1;
}

/**
 * 用途：由欄號找出對應的欄位定義。
 * Args:
 *   columnIndex {number} 欄號（1 起算）。
 * Returns:
 *   {?Object} 超出範圍回 `null`。
 */
function fillGridColumnDefAt_(columnIndex) {
  var defs = fillGridColumnDefs_();
  if (columnIndex < 1 || columnIndex > defs.length) return null;
  return defs[columnIndex - 1];
}

/**
 * 用途：組出季度填寫表的工作表名稱。
 * Args:
 *   quarterId {string} 季度 ID，例如 `'2027T4'`。
 * Returns:
 *   {string} 例如 `'Fill_2027T4'`。
 */
function fillGridSheetName_(quarterId) {
  return FILL_GRID_SHEET_PREFIX + String(quarterId || '').trim();
}

/**
 * 用途：由工作表名稱反推季度 ID。
 * Args:
 *   sheetName {string} 工作表名稱。
 * Returns:
 *   {?string} 不是季度填寫表就回 `null`。
 */
function quarterIdFromFillGridSheetName_(sheetName) {
  var name = String(sheetName || '');
  if (name.indexOf(FILL_GRID_SHEET_PREFIX) !== 0) return null;
  var quarterId = name.slice(FILL_GRID_SHEET_PREFIX.length);
  return quarterId ? quarterId : null;
}

/**
 * 用途：判斷一個工作表名稱是不是季度填寫表。`onFillGridEdit_()` 用它
 *   在最前面就篩走不相干的編輯。
 * Args:
 *   sheetName {string} 工作表名稱。
 * Returns:
 *   {boolean}
 */
function isFillGridSheetName_(sheetName) {
  return quarterIdFromFillGridSheetName_(sheetName) !== null;
}

/**
 * 用途：正規化並驗證由前端（`google.script.run`）收到的季度 ID。凡是
 *   client-facing 的 API 一律要用這個函式處理輸入，不可以把收到的值
 *   原樣當成乾淨的季度 ID 使用。
 *
 *   ⚠️ 這是實測事故的直接修法：`ui/FillConflict.html` 曾經用
 *   `JSON.stringify(quarterId)` 產生一段 JS 字面值常數，卻透過**會轉義**
 *   的 HtmlService 輸出標籤印出，導致雙引號被當成一般字元跳脫，
 *   `QUARTER_ID` 變成連引號一起的字串（例如 `"2027T4"` 而不是
 *   `2027T4`）。那次是樣板標籤用錯，這裡是**第二層防線**——就算未來
 *   又有類似的編碼疏失，或者使用者不知怎樣把帶引號／空白的值傳進來，
 *   伺服器端也要能剝掉這些雜訊，剝完仍然不合法格式就要直接拒絕，
 *   不可以讓它靜靜地在下游查無資料。
 * Args:
 *   raw {*} 原始輸入值。
 * Returns:
 *   {string} 正規化後的季度 ID（例如 `'2027T4'`）。
 * Raises:
 *   Error（`code: 'INVALID_QUARTER_ID'`）如果去除引號與空白之後仍然不符合
 *     「四位年份 + T + 一位數字」的格式。
 */
function normalizeQuarterId_(raw) {
  var s = String(raw === null || raw === undefined ? '' : raw).trim();

  // 剝掉最多一層包住整個字串的成對單／雙引號（例如樣板轉義出錯時
  // 出現的 `"2027T4"`、`'2027T4'`）。
  if (s.length >= 2) {
    var first = s.charAt(0);
    var last = s.charAt(s.length - 1);
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      s = s.slice(1, -1).trim();
    }
  }

  if (!/^\d{4}T\d$/.test(s)) {
    var err = new Error(
      'normalizeQuarterId_：季度 ID 格式不正確（應該是「四位年份T一位數字」，例如 2027T4），實際收到「'
      + String(raw === null || raw === undefined ? '' : raw) + '」。'
    );
    err.code = 'INVALID_QUARTER_ID';
    throw err;
  }

  return s;
}

// =====================================================================
// 純函式層：由職事表與 BulletinWeeks 組出格子表應有的內容
// =====================================================================

/**
 * 用途：把值正規化成格子表要顯示的**字串**。純函式。
 *
 *   ⚠️ 一律轉字串：格子表與 `BulletinWeeks` 的比對全部在字串層做，
 *   混住 Date／number／boolean 比對會出現「明明一樣卻判定有改動」。
 *   `Date` 用 `yyyy-MM-dd`（跟 `normalizeDate_()` 接受的格式一致，
 *   寫回去的時候不會出事）。
 * Args:
 *   value {*} 任意值。
 * Returns:
 *   {string}
 */
function fillGridCellText_(value) {
  if (value === null || value === undefined) return '';
  if (Object.prototype.toString.call(value) === '[object Date]') {
    var y = value.getFullYear();
    var mo = String(value.getMonth() + 1);
    var d = String(value.getDate());
    if (mo.length < 2) mo = '0' + mo;
    if (d.length < 2) d = '0' + d;
    return y + '-' + mo + '-' + d;
  }
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  return String(value);
}

/**
 * 用途：組出季度填寫表**應有的**每一行資料。純函式。
 * Args:
 *   input {{serviceDates:{isoDate:string, weekOfMonth:number,
 *            specialTitle:string}[], weekRowsByIso:Object<string,Object>}}
 *     `serviceDates` 是該季全部主日（依日期排序）；`weekRowsByIso` 是
 *     `BulletinWeeks` 該季的資料列，以 yyyy-MM-dd 為鍵。
 * Returns:
 *   {{isoDate:string, values:Object<string,string>}[]}
 *     `values` 的鍵是格子表的機器鍵，值一律是字串。
 */
function buildFillGridRows_(input) {
  var weekRows = input.weekRowsByIso || {};
  var defs = fillGridColumnDefs_();

  return (input.serviceDates || []).map(function (sd) {
    var week = weekRows[sd.isoDate] || {};
    var values = {};

    defs.forEach(function (def) {
      if (def.key === '_DATE') { values._DATE = sd.isoDate; return; }
      if (def.key === '_WEEK') { values._WEEK = fillGridCellText_(sd.weekOfMonth); return; }
      if (def.key === '_SPECIAL') { values._SPECIAL = fillGridCellText_(sd.specialTitle); return; }
      values[def.key] = fillGridCellText_(week[def.key]);
    });

    return { isoDate: sd.isoDate, values: values };
  });
}

/**
 * 用途：組出格子表三行標題的二維陣列。純函式。
 *
 *   第 1 行是欄位群組（同一群組的連續欄之後會被合併儲存格），
 *   第 2 行是中文欄標題，第 3 行是機器鍵。
 * Args: （無）
 * Returns:
 *   {{headerRows:string[][], groupSpans:{group:string, start:number,
 *     length:number}[]}} `groupSpans` 的 `start` 是 1 起算的欄號。
 */
function buildFillGridHeaderRows_() {
  var defs = fillGridColumnDefs_();
  var groupRow = defs.map(function (d) { return d.group; });
  var labelRow = defs.map(function (d) { return d.label; });
  var keyRow = defs.map(function (d) { return d.key; });

  var groupSpans = [];
  defs.forEach(function (def, i) {
    var last = groupSpans[groupSpans.length - 1];
    if (last && last.group === def.group) { last.length++; return; }
    groupSpans.push({ group: def.group, start: i + 1, length: 1 });
  });

  return { headerRows: [groupRow, labelRow, keyRow], groupSpans: groupSpans };
}

// =====================================================================
// 資料驗證下拉的選項
// =====================================================================

/**
 * 用途：讀出兩個下拉欄的選項——`PROGRAM_TEMPLATE_ID` 取自
 *   `ProgramTemplates` 的 `TEMPLATE_ID`（去重），`RECITATION_OVERRIDE`
 *   取自 Config 的三個誦讀鍵。
 *
 *   ⚠️ 選項一律**由資料算出來**，不寫死——範本增減、誦讀內容改動都不用
 *   改程式。
 * Args: （無）
 * Returns:
 *   {Object<string,string[]>} 選項代碼 → 選項陣列。
 */
function fillGridValidationOptions_() {
  var templateIds = [];
  try {
    readSheet(SHEETS.PROGRAM_TEMPLATES).forEach(function (r) {
      if (r.ACTIVE !== true) return;
      var id = String(r.TEMPLATE_ID || '').trim();
      if (id && templateIds.indexOf(id) === -1) templateIds.push(id);
    });
  } catch (err) {
    templateIds = [];
  }

  var recitations = [];
  parseRecitationMonthGroups_(
    getConfig(CONFIG_KEYS.RECITATION_MONTH_GROUPS, '1-4:RECITATION_JAN_APR,5-8:RECITATION_MAY_AUG,9-12:RECITATION_SEP_DEC')
  ).forEach(function (g) {
    var value = String(getConfig(g.configKey, '') || '').trim();
    if (value && recitations.indexOf(value) === -1) recitations.push(value);
  });

  return { PROGRAM_TEMPLATE_ID: templateIds, RECITATION: recitations };
}

// =====================================================================
// 真正入口：建立／刷新格子表
// =====================================================================

/**
 * 用途：列出指定季度的全部主日，連同當月第幾個主日與特別主日標題。
 *   資料一律來自職事表（**唯讀**）。
 * Args:
 *   quarterId {string} 季度 ID。
 * Returns:
 *   {{isoDate:string, weekOfMonth:number, specialTitle:string}[]}
 *     依日期由小到大排序。
 * Raises:
 *   Error 如果 `ROSTER_SPREADSHEET_ID` 未設定或職事表讀取失敗。
 */
function listQuarterServiceDates_(quarterId) {
  return listRosterServiceDatesForQuarter_(quarterId).map(function (isoDate) {
    var snapshot = readRosterSnapshot_(isoDate);
    return {
      isoDate: isoDate,
      weekOfMonth: snapshot.weekOfMonth,
      specialTitle: (snapshot.special && snapshot.special.title) ? snapshot.special.title : ''
    };
  });
}

/**
 * 用途：確保季度填寫表存在，並把三行標題、凍結、格式、資料驗證設定好。
 *   **冪等**：已存在的表只會補回標題與格式，不會清空資料。
 * Args:
 *   quarterId {string} 季度 ID。
 * Returns:
 *   {{sheet:Sheet, created:boolean}}
 */
function ensureFillGridSheet_(quarterId) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var name = fillGridSheetName_(quarterId);
  var sheet = ss.getSheetByName(name);
  var created = false;

  if (!sheet) {
    sheet = ss.insertSheet(name);
    created = true;
  }

  var defs = fillGridColumnDefs_();
  var header = buildFillGridHeaderRows_();

  sheet.getRange(1, 1, FILL_GRID_HEADER_ROWS_, defs.length).setValues(header.headerRows);
  sheet.getRange(1, 1, FILL_GRID_HEADER_ROWS_, defs.length).setFontWeight('bold');
  sheet.getRange(1, 1, 1, defs.length).setBackground('#d9d9d9');
  sheet.getRange(2, 1, 1, defs.length).setBackground('#efefef');
  // 第 3 行是機器鍵，人手不需要看，設成淺灰小字。
  sheet.getRange(3, 1, 1, defs.length).setBackground('#f6f6f6').setFontSize(8);

  if (sheet.getFrozenRows() < FILL_GRID_HEADER_ROWS_) sheet.setFrozenRows(FILL_GRID_HEADER_ROWS_);
  if (sheet.getFrozenColumns() < 3) sheet.setFrozenColumns(3);

  // 純文字欄（12 個人數欄與人數統計日期）——一定要在寫入資料之前設好，
  // 否則 `--` 與 `2027-11-07` 會先被 Sheets 轉型。
  var maxRows = Math.max(sheet.getMaxRows() - FILL_GRID_HEADER_ROWS_, 1);
  defs.forEach(function (def, i) {
    if (!def.plainText) return;
    sheet.getRange(FILL_GRID_FIRST_DATA_ROW_, i + 1, maxRows, 1).setNumberFormat('@');
  });

  // 唯讀三欄舊版會留永久儲存格註解（prompt8b 之前的寫法），現在改用浮動
  // toast，每次刷新都清乾淨，避免之前累積的註解永遠留在格上。
  var lastDataRow = sheet.getLastRow();
  if (lastDataRow >= FILL_GRID_FIRST_DATA_ROW_) {
    var dataRowCount = lastDataRow - FILL_GRID_FIRST_DATA_ROW_ + 1;
    fillGridReadOnlyKeys_().forEach(function (key) {
      var col = fillGridColumnIndex_(key);
      if (col <= 0) return;
      sheet.getRange(FILL_GRID_FIRST_DATA_ROW_, col, dataRowCount, 1).clearNote();
    });
  }

  return { sheet: sheet, created: created };
}

/**
 * 用途：把資料驗證下拉套用到 `PROGRAM_TEMPLATE_ID` 與 `RECITATION_OVERRIDE`
 *   兩欄。
 *
 *   ⚠️ 一律用 `setAllowInvalid(true)`：下拉只是**方便**，不是限制。
 *   例如某一週要用一個新加的範本、或者誦讀內容臨時不同，硬擋住只會逼
 *   幹事去別處改。
 * Args:
 *   sheet {Sheet} 格子表。
 *   rowCount {number} 資料列數。
 * Returns:
 *   {void}
 */
function applyFillGridValidation_(sheet, rowCount) {
  if (rowCount < 1) return;
  var options = fillGridValidationOptions_();

  fillGridColumnDefs_().forEach(function (def, i) {
    if (!def.options) return;
    var values = options[def.options] || [];
    var range = sheet.getRange(FILL_GRID_FIRST_DATA_ROW_, i + 1, rowCount, 1);
    if (values.length === 0) {
      range.clearDataValidations();
      return;
    }
    range.setDataValidation(
      SpreadsheetApp.newDataValidation().requireValueInList(values, true).setAllowInvalid(true).build()
    );
  });
}

/**
 * 用途：套用條件格式——已填的格子淺綠底、特別主日那一行整行淺黃底。
 *
 *   ⚠️ 用**條件格式**（規則）而不是每次重寫背景色：規則只需要設定一次，
 *   之後幹事一邊打字一邊即時變色；每次同步重寫格式的話，不但慢（一季
 *   13 行 × 30 欄 ＝ 390 格），而且會在幹事正在編輯的時候把格式蓋掉。
 * Args:
 *   sheet {Sheet} 格子表。
 *   rowCount {number} 資料列數。
 * Returns:
 *   {void}
 */
function applyFillGridConditionalFormat_(sheet, rowCount) {
  if (rowCount < 1) return;
  var defs = fillGridColumnDefs_();
  var editableStart = fillGridReadOnlyKeys_().length + 1;
  var editableCount = defs.length - fillGridReadOnlyKeys_().length;
  if (editableCount < 1) return;

  var dataRange = sheet.getRange(FILL_GRID_FIRST_DATA_ROW_, editableStart, rowCount, editableCount);
  var wholeRow = sheet.getRange(FILL_GRID_FIRST_DATA_ROW_, 1, rowCount, defs.length);
  var specialColumnLetter = columnIndexToLetter_(fillGridColumnIndex_('_SPECIAL'));

  var rules = [
    // 特別主日那一行整行淺黃底。放在最前面，優先於「已填」的綠底。
    SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied('=$' + specialColumnLetter + String(FILL_GRID_FIRST_DATA_ROW_) + '<>""')
      .setBackground('#fff2cc')
      .setRanges([wholeRow])
      .build(),
    // 已填的格子淺綠底
    SpreadsheetApp.newConditionalFormatRule()
      .whenCellNotEmpty()
      .setBackground('#e6f4ea')
      .setRanges([dataRange])
      .build()
  ];

  sheet.setConditionalFormatRules(rules);
}

/**
 * 用途：把欄號轉成 A1 表示法的欄字母（1 → A、27 → AA）。條件格式的公式
 *   要用。
 * Args:
 *   index {number} 欄號，1 起算。
 * Returns:
 *   {string}
 */
function columnIndexToLetter_(index) {
  var n = Number(index);
  var letters = '';
  while (n > 0) {
    var rem = (n - 1) % 26;
    letters = String.fromCharCode(65 + rem) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

/**
 * 用途：把整批資料列寫進格子表（三個唯讀欄與全部可編輯欄）。
 * Args:
 *   sheet {Sheet} 格子表。
 *   rows {{isoDate:string, values:Object}[]} `buildFillGridRows_()` 的輸出。
 * Returns:
 *   {void}
 */
function writeFillGridRows_(sheet, rows) {
  if (!rows || rows.length === 0) return;
  var defs = fillGridColumnDefs_();

  var values = rows.map(function (row) {
    return defs.map(function (def) {
      var v = row.values[def.key];
      return sanitizeCellText_(v === undefined || v === null ? '' : v);
    });
  });

  sheet.getRange(FILL_GRID_FIRST_DATA_ROW_, 1, values.length, defs.length).setValues(values);
}

/**
 * 用途：讀出格子表目前的內容。
 * Args:
 *   quarterId {string} 季度 ID。
 * Returns:
 *   {{isoDate:string, rowNo:number, values:Object<string,string>}[]}
 *     工作表不存在或沒有資料時回空陣列。
 */
function readFillGridRows_(quarterId) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(fillGridSheetName_(quarterId));
  if (!sheet) return [];

  var lastRow = sheet.getLastRow();
  if (lastRow < FILL_GRID_FIRST_DATA_ROW_) return [];

  var defs = fillGridColumnDefs_();
  var raw = sheet.getRange(FILL_GRID_FIRST_DATA_ROW_, 1, lastRow - FILL_GRID_HEADER_ROWS_, defs.length).getValues();

  var out = [];
  raw.forEach(function (rowValues, i) {
    var isoDate = fillGridCellText_(rowValues[0]).trim();
    if (!isoDate) return;
    var values = {};
    defs.forEach(function (def, c) { values[def.key] = fillGridCellText_(rowValues[c]); });
    out.push({ isoDate: isoDate, rowNo: FILL_GRID_FIRST_DATA_ROW_ + i, values: values });
  });

  return out;
}

// =====================================================================
// 格子表外觀檢查（唯讀，prompt8b 第 5 部分）
// =====================================================================

/**
 * 用途：讀取季度填寫表**實際套用**的條件格式規則、凍結行欄、唯讀欄殘留
 *   註解數、人數欄數字格式，作為「檢查格子表外觀」選單的事實來源。
 *
 *   ⚠️ 純粹讀取，不寫入任何一格——第八輪的條件格式（特別主日整行淺黃、
 *   已填格子淺綠）從未在真實 Sheets 驗證過，這個函式讓 Ivan 不用肉眼估，
 *   看報告就知道對不對。
 * Args:
 *   quarterId {string} 季度 ID。
 * Returns:
 *   {Object} 見函式內回傳物件的欄位，交給 `buildFillAppearanceReportLines_()`
 *     格式化成報告文字。
 * Raises:
 *   Error 如果該季度的格子表還沒有建立。
 */
function inspectFillGridAppearance_(quarterId) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheetName = fillGridSheetName_(quarterId);
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    throw new Error('inspectFillGridAppearance_：找不到工作表「' + sheetName + '」，請先用「建立／刷新季度填寫表」建立。');
  }

  var conditionalFormatRules = sheet.getConditionalFormatRules().map(function (rule) {
    var ranges = rule.getRanges().map(function (r) { return r.getA1Notation(); });
    var condition = rule.getBooleanCondition();
    if (!condition) {
      return { ranges: ranges, criteriaType: '（非布林條件，未支援解析）', criteriaValues: [], background: '' };
    }
    return {
      ranges: ranges,
      criteriaType: String(condition.getCriteriaType()),
      criteriaValues: (condition.getCriteriaValues() || []).map(function (v) { return String(v); }),
      background: condition.getBackground() || ''
    };
  });

  var lastDataRow = sheet.getLastRow();
  var readOnlyNoteCounts = {};
  fillGridReadOnlyKeys_().forEach(function (key) {
    var col = fillGridColumnIndex_(key);
    readOnlyNoteCounts[key] = 0;
    if (col <= 0 || lastDataRow < FILL_GRID_FIRST_DATA_ROW_) return;
    var rowCount = lastDataRow - FILL_GRID_FIRST_DATA_ROW_ + 1;
    var notes = sheet.getRange(FILL_GRID_FIRST_DATA_ROW_, col, rowCount, 1).getNotes();
    notes.forEach(function (row) {
      if (row[0]) readOnlyNoteCounts[key]++;
    });
  });

  // 只看 12 個人數欄，`ATTENDANCE_DATE` 雖然也是純文字欄但不屬於「12 個
  // 人數欄」，prompt8b 只要求檢查這 12 欄。
  var attendanceColumnFormats = fillGridColumnDefs_()
    .filter(function (def) { return def.plainText && def.key !== 'ATTENDANCE_DATE'; })
    .map(function (def) {
      var col = fillGridColumnIndex_(def.key);
      var format = (col > 0 && lastDataRow >= FILL_GRID_FIRST_DATA_ROW_)
        ? sheet.getRange(FILL_GRID_FIRST_DATA_ROW_, col).getNumberFormat() : '';
      return { key: def.key, label: def.label, numberFormat: format, isPlainText: format === '@' };
    });

  return {
    quarterId: quarterId,
    sheetName: sheetName,
    frozenRows: sheet.getFrozenRows(),
    frozenColumns: sheet.getFrozenColumns(),
    conditionalFormatRules: conditionalFormatRules,
    readOnlyNoteCounts: readOnlyNoteCounts,
    attendanceColumnFormats: attendanceColumnFormats
  };
}

/**
 * 用途：把 `inspectFillGridAppearance_()` 讀到的事實格式化成
 *   `Diagnostics` 報告的文字行。獨立成純函式，方便不經過真實 Sheets API
 *   也測得到格式化規則。
 * Args:
 *   facts {Object} `inspectFillGridAppearance_()` 的回傳值。
 * Returns:
 *   {string[]} 逐行的報告文字。
 */
function buildFillAppearanceReportLines_(facts) {
  var lines = [];
  lines.push('季度：' + facts.quarterId + '（' + facts.sheetName + '）');
  lines.push('');

  lines.push('「凍結行／欄」');
  lines.push('凍結行數：' + facts.frozenRows + '　凍結欄數：' + facts.frozenColumns);
  lines.push('');

  lines.push('「條件格式規則」（共 ' + facts.conditionalFormatRules.length + ' 條）');
  if (facts.conditionalFormatRules.length === 0) {
    lines.push('（沒有任何條件格式規則——如果預期應該有特別主日整行淺黃、已填格子淺綠，這裡是空的就代表沒套用成功。）');
  } else {
    facts.conditionalFormatRules.forEach(function (rule, i) {
      lines.push((i + 1) + '. 範圍：' + rule.ranges.join('、'));
      lines.push('　條件類型：' + rule.criteriaType);
      if (rule.criteriaValues.length > 0) lines.push('　條件公式／參數：' + rule.criteriaValues.join('、'));
      lines.push('　背景色：' + (rule.background || '（未設定）'));
    });
  }
  lines.push('');

  lines.push('「唯讀欄殘留註解」');
  fillGridReadOnlyKeys_().forEach(function (key) {
    lines.push(key + '：' + facts.readOnlyNoteCounts[key] + ' 個');
  });
  lines.push('');

  lines.push('「人數欄數字格式（應為純文字 @）」');
  facts.attendanceColumnFormats.forEach(function (col) {
    lines.push(col.label + '（' + col.key + '）：' + (col.numberFormat || '（空白）') + (col.isPlainText ? '　✓' : '　⚠️ 不是純文字'));
  });

  return lines;
}
