/**
 * Constants.gs
 *
 * 全系統共用的宣告式常數：工作表名稱、欄位定義、設定鍵、Config 預設值、
 * 各種列舉，以及固定的 seed 資料（PostDisplay／MergeGroups／ProgramTemplates／
 * EmailTemplates）。本檔案不呼叫任何 SpreadsheetApp／Utilities 等 Apps Script
 * 服務，純粹是資料宣告，方便在 Node 測試內直接載入。
 *
 * 硬規則：本檔案不可以出現任何真實 ID、電郵、姓名。ID／電郵類的 Config
 * 預設值一律是空字串。
 */

'use strict';

// =====================================================================
// 系統基本資訊
// =====================================================================

/** 選單與「關於本系統」對話框使用的系統名稱。 */
var APP_NAME = '週報系統';

/** 「關於本系統」對話框顯示的版本字串。 */
var APP_VERSION = '0.1.0（第一輪：地基）';

/** 本 repo 的網址（公開）。 */
var REPO_URL = 'https://github.com/ivantheservant/hwc-bulletin-automation';

/** 姊妹專案（粵語堂職事表系統）的網址（公開）。 */
var ROSTER_REPO_URL = 'https://github.com/ivantheservant/hwc-roster-automation';

// =====================================================================
// 欄位型別列舉——readSheet() 依此決定用哪一個 normalize*_() 函式
// =====================================================================

var COLUMN_TYPES = Object.freeze({
  TEXT: 'TEXT',
  DATE: 'DATE',
  BOOLEAN: 'BOOLEAN',
  INT: 'INT'
});

// =====================================================================
// SHEETS：工作表 key → 工作表名稱（分頁標籤文字）
// 順序即為 initializeAllSheets() 建立分頁的順序。
// =====================================================================

var SHEETS = Object.freeze({
  README: '_README',
  CONFIG: 'Config',
  BULLETIN_WEEKS: 'BulletinWeeks',
  ANNOUNCEMENTS: 'Announcements',
  PRAYERS: 'Prayers',
  FELLOWSHIPS: 'Fellowships',
  FINANCE: 'Finance',
  PERSON_DISPLAY: 'PersonDisplay',
  POST_DISPLAY: 'PostDisplay',
  MERGE_GROUPS: 'MergeGroups',
  PROGRAM_TEMPLATES: 'ProgramTemplates',
  RECIPIENTS: 'Recipients',
  EMAIL_TEMPLATES: 'EmailTemplates',
  DIAGNOSTICS: 'Diagnostics',
  AUDIT_LOG: 'AuditLog',
  SEND_LOG: 'SendLog',
  ERROR_LOG: 'ErrorLog'
});

// =====================================================================
// COLUMNS：工作表 key → { headers, keys, types, textFormatColumns? }
//
// headers／keys／types 三個陣列長度必須一致（tests/constants.test.js 會檢查）：
//   headers[i] = 第 1 行中文標題　keys[i] = 第 2 行機器鍵　types[i] = 正規化型別
//
// textFormatColumns（選填）：需要強制設成純文字格式（setNumberFormat('@')）
// 的機器鍵陣列——用來防止 Google Sheets 把「06-02」「--」這類值自動轉成
// 日期或數字。
// =====================================================================

var COLUMNS = Object.freeze({

  README: {
    headers: ['說明'],
    keys: ['TEXT'],
    types: ['TEXT']
  },

  CONFIG: {
    headers: ['設定鍵', '值', '說明', '可否人手修改'],
    keys: ['KEY', 'VALUE', 'NOTE', 'EDITABLE'],
    types: ['TEXT', 'TEXT', 'TEXT', 'BOOLEAN']
  },

  BULLETIN_WEEKS: {
    headers: [
      '主日日期', '季度', '當月第幾個主日', '特別主日類型', '程序表大標題',
      '程序範本', '序樂', '宣召經文', '宣召出處', '誦讀（覆寫）',
      '詩歌頌讚', '詩班項目名稱', '詩班曲名', '讀經', '證道講題',
      '回應詩歌', '人數表標題', '人數統計日期',
      '英語堂崇拜', '粵語堂主堂崇拜', '粵語堂北岸崇拜', '華語堂崇拜',
      '英語堂祈禱會', '粵語堂主堂祈禱會', '粵語堂北岸祈禱會', '華語堂祈禱會',
      '英語堂兒童', '粵語堂主堂兒童', '粵語堂北岸兒童', '華語堂兒童',
      '下週事奉標題', '本週獻花', '下週獻花', '代禱區塊標題', '本週讀經',
      '狀態', '使用的職事表版本', '產生的 Docs ID', '產生的 PDF ID',
      '最後產生時間', '寄出時間', '最後儲存時間', '備註'
    ],
    keys: [
      'SERVICE_DATE', 'QUARTER_ID', 'WEEK_OF_MONTH', 'SPECIAL_TYPE', 'PAGE_TITLE',
      'PROGRAM_TEMPLATE_ID', 'PRELUDE', 'CALL_TEXT', 'CALL_REF', 'RECITATION_OVERRIDE',
      'HYMN_PRAISE', 'CHOIR_LABEL', 'CHOIR_TITLE', 'SCRIPTURE_REF', 'SERMON_TITLE',
      'RESPONSE_HYMN', 'ATTENDANCE_HEADING', 'ATTENDANCE_DATE',
      'ATT_ENG_WORSHIP', 'ATT_CANE_WORSHIP', 'ATT_CANN_WORSHIP', 'ATT_MAN_WORSHIP',
      'ATT_ENG_PRAYER', 'ATT_CANE_PRAYER', 'ATT_CANN_PRAYER', 'ATT_MAN_PRAYER',
      'ATT_ENG_CHILD', 'ATT_CANE_CHILD', 'ATT_CANN_CHILD', 'ATT_MAN_CHILD',
      'NEXT_WEEK_HEADING', 'FLOWER_THIS_WEEK', 'FLOWER_NEXT_WEEK', 'PRAYER_BLOCK_HEADING', 'WEEKLY_BIBLE_READING',
      'STATUS', 'ROSTER_VERSION_USED', 'DOC_ID', 'PDF_ID',
      'LAST_GENERATED_AT', 'SENT_AT', 'LAST_SAVED_AT', 'NOTES'
    ],
    types: [
      'DATE', 'TEXT', 'INT', 'TEXT', 'TEXT',
      'TEXT', 'TEXT', 'TEXT', 'TEXT', 'TEXT',
      'TEXT', 'TEXT', 'TEXT', 'TEXT', 'TEXT',
      'TEXT', 'TEXT', 'DATE',
      // ⚠️ 以下十二個人數欄一律 TEXT：樣本出現過 '--'、'前:5 / 後:120' 這類非純數字值。
      'TEXT', 'TEXT', 'TEXT', 'TEXT',
      'TEXT', 'TEXT', 'TEXT', 'TEXT',
      'TEXT', 'TEXT', 'TEXT', 'TEXT',
      'TEXT', 'TEXT', 'TEXT', 'TEXT', 'TEXT',
      'TEXT', 'TEXT', 'TEXT', 'TEXT',
      'DATE', 'DATE', 'DATE', 'TEXT'
    ],
    textFormatColumns: [
      'ATT_ENG_WORSHIP', 'ATT_CANE_WORSHIP', 'ATT_CANN_WORSHIP', 'ATT_MAN_WORSHIP',
      'ATT_ENG_PRAYER', 'ATT_CANE_PRAYER', 'ATT_CANN_PRAYER', 'ATT_MAN_PRAYER',
      'ATT_ENG_CHILD', 'ATT_CANE_CHILD', 'ATT_CANN_CHILD', 'ATT_MAN_CHILD'
    ]
  },

  ANNOUNCEMENTS: {
    headers: ['主日日期', '次序', '內容', '有效'],
    keys: ['SERVICE_DATE', 'SEQ_NO', 'TEXT', 'ACTIVE'],
    types: ['DATE', 'INT', 'TEXT', 'BOOLEAN']
  },

  PRAYERS: {
    headers: ['主日日期', '次序', '內容', '有效'],
    keys: ['SERVICE_DATE', 'SEQ_NO', 'TEXT', 'ACTIVE'],
    types: ['DATE', 'INT', 'TEXT', 'BOOLEAN']
  },

  FELLOWSHIPS: {
    headers: ['主日日期', '次序', '團契', '日期', '時間', '週會內容', '有效'],
    keys: ['SERVICE_DATE', 'SEQ_NO', 'FELLOWSHIP_NAME', 'MEETING_DATE', 'MEETING_TIME', 'CONTENT', 'ACTIVE'],
    // ⚠️ MEETING_DATE／MEETING_TIME 是文字，不是 DATE：樣本值如 '10/5 星期日'、'4:30pm'。
    types: ['DATE', 'INT', 'TEXT', 'TEXT', 'TEXT', 'TEXT', 'BOOLEAN'],
    // 第四輪新增：填寫介面允許人手直接輸入 '10/5' 這類單純數字形狀的日期，
    // 沒有這個保護，Google Sheets 會自動把它轉成真正的 Date——強制純文字格式。
    textFormatColumns: ['MEETING_DATE', 'MEETING_TIME']
  },

  FINANCE: {
    headers: ['主日日期', '次序', '項目', '特殊海外奉獻', '慈惠', '有效'],
    keys: ['SERVICE_DATE', 'SEQ_NO', 'ROW_LABEL', 'COL_SPECIAL_OVERSEAS', 'COL_HARDSHIP', 'ACTIVE'],
    types: ['DATE', 'INT', 'TEXT', 'TEXT', 'TEXT', 'BOOLEAN']
  },

  PERSON_DISPLAY: {
    headers: ['PersonID', '姓名', '尊稱', '顯示覆寫', '生效日', '失效日', '有效', '備註'],
    keys: ['PERSON_ID', 'NAME_TC', 'HONORIFIC', 'DISPLAY_OVERRIDE', 'EFFECTIVE_FROM', 'EFFECTIVE_TO', 'ACTIVE', 'NOTES'],
    types: ['TEXT', 'TEXT', 'TEXT', 'TEXT', 'DATE', 'DATE', 'BOOLEAN', 'TEXT']
  },

  POST_DISPLAY: {
    headers: [
      'PostID', '第 1 頁名稱', '第 1 頁次序', '第 1 頁顯示', '第 1 頁合併組',
      '第 3 頁名稱', '第 3 頁次序', '第 3 頁顯示', '第 3 頁合併組', '有效', '備註'
    ],
    keys: [
      'POST_ID', 'PAGE1_NAME', 'PAGE1_ORDER', 'SHOW_ON_PAGE1', 'PAGE1_MERGE_GROUP',
      'PAGE3_NAME', 'PAGE3_ORDER', 'SHOW_ON_PAGE3', 'PAGE3_MERGE_GROUP', 'ACTIVE', 'NOTES'
    ],
    types: ['TEXT', 'TEXT', 'INT', 'BOOLEAN', 'TEXT', 'TEXT', 'INT', 'BOOLEAN', 'TEXT', 'BOOLEAN', 'TEXT']
  },

  MERGE_GROUPS: {
    headers: ['合併組 ID', '顯示名稱', '連接符', '只在同一人時合併', '有效', '備註'],
    keys: ['GROUP_ID', 'DISPLAY_NAME', 'JOIN_SEPARATOR', 'MERGE_ONLY_IF_SAME_PERSON', 'ACTIVE', 'NOTES'],
    types: ['TEXT', 'TEXT', 'TEXT', 'BOOLEAN', 'BOOLEAN', 'TEXT']
  },

  PROGRAM_TEMPLATES: {
    headers: ['範本 ID', '次序', '程序項目', '內容來源', '內容值', '立坐', '整行', '出現條件', '有效', '備註'],
    keys: ['TEMPLATE_ID', 'SEQ_NO', 'ITEM_NAME', 'CONTENT_SOURCE', 'CONTENT_VALUE', 'POSTURE', 'FULL_WIDTH', 'CONDITION', 'ACTIVE', 'NOTES'],
    types: ['TEXT', 'INT', 'TEXT', 'TEXT', 'TEXT', 'TEXT', 'BOOLEAN', 'TEXT', 'BOOLEAN', 'TEXT']
  },

  RECIPIENTS: {
    headers: ['收件人 ID', '姓名', '電郵', '組別', '有效', '生效日', '失效日', '備註'],
    keys: ['RECIPIENT_ID', 'NAME', 'EMAIL', 'GROUP_NAME', 'ACTIVE', 'EFFECTIVE_FROM', 'EFFECTIVE_TO', 'NOTES'],
    types: ['TEXT', 'TEXT', 'TEXT', 'TEXT', 'BOOLEAN', 'DATE', 'DATE', 'TEXT']
  },

  EMAIL_TEMPLATES: {
    headers: ['範本 ID', '主旨', '內文', '有效', '備註'],
    keys: ['TEMPLATE_ID', 'SUBJECT', 'BODY', 'ACTIVE', 'NOTES'],
    types: ['TEXT', 'TEXT', 'TEXT', 'BOOLEAN', 'TEXT']
  },

  DIAGNOSTICS: {
    headers: ['報告名稱', '行號', '內容', '產生時間'],
    keys: ['REPORT_NAME', 'ROW_NO', 'CONTENT', 'GENERATED_AT'],
    types: ['TEXT', 'INT', 'TEXT', 'DATE']
  },

  AUDIT_LOG: {
    headers: ['時間', '執行者', '動作', '工作表', '資料鍵', '欄位', '舊值', '新值', '備註'],
    keys: ['TIMESTAMP', 'ACTOR', 'ACTION', 'SHEET_NAME', 'ROW_KEY', 'FIELD', 'OLD_VALUE', 'NEW_VALUE', 'NOTES'],
    types: ['DATE', 'TEXT', 'TEXT', 'TEXT', 'TEXT', 'TEXT', 'TEXT', 'TEXT', 'TEXT']
  },

  SEND_LOG: {
    headers: ['時間', '主日日期', '收件人', '主旨', '狀態', '是否試行', '職事表版本', '錯誤'],
    keys: ['TIMESTAMP', 'SERVICE_DATE', 'RECIPIENT_EMAIL', 'SUBJECT', 'STATUS', 'DRY_RUN', 'ROSTER_VERSION_USED', 'ERROR'],
    types: ['DATE', 'DATE', 'TEXT', 'TEXT', 'TEXT', 'BOOLEAN', 'TEXT', 'TEXT']
  },

  // 第四b輪新增：把例外「看得見、留得低」——伺服器／前端／選單三種來源
  // 的錯誤統一寫進這裡，見 src/ErrorLog.gs。DETAIL 一律不可以存電郵或
  // 完整個人資料，只存堆疊頭幾行與程式碼自己組的參數摘要（見
  // docs/已知bug類型.md 事故七）。
  ERROR_LOG: {
    headers: ['時間', '使用者', '來源', '函式', '錯誤代碼', '錯誤訊息', '詳情'],
    keys: ['TIMESTAMP', 'ACTOR', 'SOURCE', 'FUNCTION_NAME', 'ERROR_CODE', 'MESSAGE', 'DETAIL'],
    types: ['DATE', 'TEXT', 'TEXT', 'TEXT', 'TEXT', 'TEXT', 'TEXT']
  }

});

/** SHEETS 的反查表：工作表名稱 → SHEETS／COLUMNS 用的 key。 */
var SHEET_ID_BY_NAME = Object.freeze(
  Object.keys(SHEETS).reduce(function (acc, id) {
    acc[SHEETS[id]] = id;
    return acc;
  }, {})
);

// =====================================================================
// CONFIG_KEYS：Config 工作表 KEY 欄允許使用的鍵名
// =====================================================================

var CONFIG_KEYS = Object.freeze({
  ROSTER_SPREADSHEET_ID: 'ROSTER_SPREADSHEET_ID',
  ROSTER_SHEET_ASSIGNMENTS: 'ROSTER_SHEET_ASSIGNMENTS',
  ROSTER_SHEET_VERSIONS: 'ROSTER_SHEET_VERSIONS',
  ROSTER_SHEET_QUARTERS: 'ROSTER_SHEET_QUARTERS',
  ROSTER_SHEET_SERVICE_DATES: 'ROSTER_SHEET_SERVICE_DATES',
  ROSTER_SHEET_SPECIAL_SUNDAYS: 'ROSTER_SHEET_SPECIAL_SUNDAYS',
  ROSTER_SHEET_NAME_MAPPING: 'ROSTER_SHEET_NAME_MAPPING',
  ROSTER_SHEET_POSTS: 'ROSTER_SHEET_POSTS',
  ROSTER_TEST_DATE: 'ROSTER_TEST_DATE',
  SYS_TIMEZONE: 'SYS_TIMEZONE',
  DRY_RUN: 'DRY_RUN',
  SEND_WEEKDAY: 'SEND_WEEKDAY',
  SEND_HOUR: 'SEND_HOUR',
  BULLETIN_OUTPUT_FOLDER_ID: 'BULLETIN_OUTPUT_FOLDER_ID',
  DOC_TEMPLATE_ID_NORMAL: 'DOC_TEMPLATE_ID_NORMAL',
  DOC_TEMPLATE_ID_COMBINED: 'DOC_TEMPLATE_ID_COMBINED',
  MAX_PAGES: 'MAX_PAGES',
  RECITATION_JAN_APR: 'RECITATION_JAN_APR',
  RECITATION_MAY_AUG: 'RECITATION_MAY_AUG',
  RECITATION_SEP_DEC: 'RECITATION_SEP_DEC',
  PRAYER_MEETING_WEEKS: 'PRAYER_MEETING_WEEKS',
  COMMUNION_WEEKS: 'COMMUNION_WEEKS',
  SHOW_WEEKLY_BIBLE_READING: 'SHOW_WEEKLY_BIBLE_READING',
  DATE_FORMAT_COVER: 'DATE_FORMAT_COVER',
  DATE_FORMAT_INLINE: 'DATE_FORMAT_INLINE',
  HONORIFIC_ON_PAGE1: 'HONORIFIC_ON_PAGE1',
  HONORIFIC_ON_PAGE3: 'HONORIFIC_ON_PAGE3',
  PRELUDE_DEFAULT: 'PRELUDE_DEFAULT',
  CANTONESE_SUBCOLUMN_LABEL: 'CANTONESE_SUBCOLUMN_LABEL',
  DIAGNOSTICS_MAX_ROWS: 'DIAGNOSTICS_MAX_ROWS',
  // ---- 第三輪新增：週報資料模型組裝用的規則設定 ----
  // 每一個都是「本來很容易寫死在程式碼裡的規則」，一律經 Config 才可以
  // 由 Ivan 自行調整而不用改程式（見 prompt3.md「不要做的事」）。
  TEMPLATE_KEYWORDS_BAPTISM: 'TEMPLATE_KEYWORDS_BAPTISM',
  TEMPLATE_KEYWORDS_ANNIVERSARY: 'TEMPLATE_KEYWORDS_ANNIVERSARY',
  TEMPLATE_DEFAULT: 'TEMPLATE_DEFAULT',
  RECITATION_MONTH_GROUPS: 'RECITATION_MONTH_GROUPS',
  CALL_TO_WORSHIP_FORMAT: 'CALL_TO_WORSHIP_FORMAT',
  DEFAULT_PAGE_TITLE: 'DEFAULT_PAGE_TITLE',
  DEFAULT_ATTENDANCE_HEADING: 'DEFAULT_ATTENDANCE_HEADING',
  DEFAULT_NEXT_WEEK_HEADING: 'DEFAULT_NEXT_WEEK_HEADING',
  DEFAULT_PRAYER_BLOCK_HEADING: 'DEFAULT_PRAYER_BLOCK_HEADING',
  // ---- 第四輪新增：填寫介面（Web App）的開關、權限與代禱標題建議清單 ----
  WEBAPP_ENABLED: 'WEBAPP_ENABLED',
  WEBAPP_ALLOWED_EMAILS: 'WEBAPP_ALLOWED_EMAILS',
  WEBAPP_URL: 'WEBAPP_URL',
  PRAYER_BLOCK_HEADING_OPTIONS: 'PRAYER_BLOCK_HEADING_OPTIONS',
  // ---- 第五輪新增：電郵與自動寄送 ----
  CHURCH_NAME: 'CHURCH_NAME',
  SEND_MINUTE: 'SEND_MINUTE',
  SEND_TARGET_OFFSET_DAYS: 'SEND_TARGET_OFFSET_DAYS',
  SEND_GROUPS: 'SEND_GROUPS',
  SEND_INCLUDE_MISSING_LIST: 'SEND_INCLUDE_MISSING_LIST',
  SEND_BLOCK_IF_SCHEMA_OUTDATED: 'SEND_BLOCK_IF_SCHEMA_OUTDATED',
  EMAIL_TEMPLATE_ID: 'EMAIL_TEMPLATE_ID'
});

// =====================================================================
// DEFAULTS：Config 預設值。seedConfigDefaults_() 只在該 KEY 不存在時新增。
//
// ⚠️ 硬規則：ID／電郵類欄位一律 seed 成空字串，由 Ivan 自己在試算表填。
// =====================================================================

var DEFAULTS = Object.freeze([
  { key: CONFIG_KEYS.ROSTER_SPREADSHEET_ID, value: '', note: '職事表試算表 ID，由 Ivan 填' },
  { key: CONFIG_KEYS.ROSTER_SHEET_ASSIGNMENTS, value: 'RosterAssignments', note: '職事表內「事奉分配」工作表的名稱' },
  { key: CONFIG_KEYS.ROSTER_SHEET_VERSIONS, value: 'RosterVersions', note: '職事表內「版本」工作表的名稱' },
  { key: CONFIG_KEYS.ROSTER_SHEET_QUARTERS, value: 'Quarters', note: '職事表內「季度」工作表的名稱' },
  { key: CONFIG_KEYS.ROSTER_SHEET_SERVICE_DATES, value: 'ServiceDates', note: '職事表內「主日日期」工作表的名稱' },
  { key: CONFIG_KEYS.ROSTER_SHEET_SPECIAL_SUNDAYS, value: 'SpecialSundays', note: '職事表內「特別主日」工作表的名稱' },
  { key: CONFIG_KEYS.ROSTER_SHEET_NAME_MAPPING, value: 'NameMapping', note: '職事表內「姓名對照」工作表的名稱' },
  { key: CONFIG_KEYS.ROSTER_SHEET_POSTS, value: 'Posts', note: '職事表內「崗位」工作表的名稱' },
  { key: CONFIG_KEYS.ROSTER_TEST_DATE, value: '2027-10-03', note: '「測試讀取職事表」選單預設的測試日期（yyyy-MM-dd）' },
  { key: CONFIG_KEYS.SYS_TIMEZONE, value: 'Pacific/Auckland', note: '系統時區，用於日期／時間格式化' },
  { key: CONFIG_KEYS.DRY_RUN, value: 'TRUE', note: '試行模式；TRUE 時所有寄送動作只記錄不會真的寄出' },
  { key: CONFIG_KEYS.SEND_WEEKDAY, value: 'MONDAY', note: '自動寄送週報的星期幾（英文全大寫，例如 MONDAY）' },
  { key: CONFIG_KEYS.SEND_HOUR, value: '8', note: '自動寄送週報的小時（24 小時制，0-23）' },
  { key: CONFIG_KEYS.BULLETIN_OUTPUT_FOLDER_ID, value: '', note: 'PDF 存放資料夾' },
  { key: CONFIG_KEYS.DOC_TEMPLATE_ID_NORMAL, value: '', note: 'Google Docs 範本，未有' },
  { key: CONFIG_KEYS.DOC_TEMPLATE_ID_COMBINED, value: '', note: '三堂聯合崇拜（浸禮／堂慶）用的 Google Docs 範本，未有' },
  { key: CONFIG_KEYS.MAX_PAGES, value: '5', note: '超過即報錯不生成' },
  { key: CONFIG_KEYS.RECITATION_JAN_APR, value: '使徒信經', note: '1-4 月主日誦讀的預設內容' },
  { key: CONFIG_KEYS.RECITATION_MAY_AUG, value: '十誡', note: '5-8 月主日誦讀的預設內容' },
  { key: CONFIG_KEYS.RECITATION_SEP_DEC, value: '主禱文', note: '9-12 月主日誦讀的預設內容' },
  { key: CONFIG_KEYS.PRAYER_MEETING_WEEKS, value: '2,4', note: '「祈禱會」行只在每月第幾個主日出現' },
  { key: CONFIG_KEYS.COMMUNION_WEEKS, value: '1', note: '聖餐在每月第幾個主日' },
  { key: CONFIG_KEYS.SHOW_WEEKLY_BIBLE_READING, value: 'FALSE', note: '本週讀經自 2025-12-14 之後已停用' },
  { key: CONFIG_KEYS.DATE_FORMAT_COVER, value: 'yyyy 年 MM 月 dd 日', note: '封面日期' },
  { key: CONFIG_KEYS.DATE_FORMAT_INLINE, value: 'dd/MM/yyyy', note: '人數表與下週事奉標題括號內的日期' },
  { key: CONFIG_KEYS.HONORIFIC_ON_PAGE1, value: 'TRUE', note: '第 1 頁事奉框加「弟兄／姊妹」' },
  { key: CONFIG_KEYS.HONORIFIC_ON_PAGE3, value: 'FALSE', note: '第 3 頁下週事奉不加' },
  { key: CONFIG_KEYS.PRELUDE_DEFAULT, value: '主在聖殿中 (生命聖詩 522)', note: '68 期樣本全部相同' },
  { key: CONFIG_KEYS.CANTONESE_SUBCOLUMN_LABEL, value: '主堂', note: '人數表粵語堂子欄標題' },
  { key: CONFIG_KEYS.DIAGNOSTICS_MAX_ROWS, value: '380', note: 'Diagnostics 工作表的資料行數上限，超過會被截斷' },
  { key: CONFIG_KEYS.TEMPLATE_KEYWORDS_BAPTISM, value: '浸禮', note: '特別主日標題／類型含這些關鍵詞就用浸禮合堂範本（逗號分隔）' },
  { key: CONFIG_KEYS.TEMPLATE_KEYWORDS_ANNIVERSARY, value: '堂慶,週年', note: '特別主日標題／類型含這些關鍵詞就用堂慶合堂範本（逗號分隔）' },
  { key: CONFIG_KEYS.TEMPLATE_DEFAULT, value: 'TPL_NORMAL', note: '推斷不到特別範本時使用的預設程序範本 ID' },
  {
    key: CONFIG_KEYS.RECITATION_MONTH_GROUPS,
    value: '1-4:RECITATION_JAN_APR,5-8:RECITATION_MAY_AUG,9-12:RECITATION_SEP_DEC',
    note: '誦讀內容的月份分組：「起月-迄月:Config鍵」，逗號分隔'
  },
  { key: CONFIG_KEYS.CALL_TO_WORSHIP_FORMAT, value: '{{text}}（{{ref}}）', note: '宣召內容的組合格式，佔位符為 {{text}} 與 {{ref}}' },
  { key: CONFIG_KEYS.DEFAULT_PAGE_TITLE, value: '崇拜程序', note: 'BulletinWeeks 的程序表大標題留空時的預設值' },
  { key: CONFIG_KEYS.DEFAULT_ATTENDANCE_HEADING, value: '上週主日崇拜人數', note: 'BulletinWeeks 的人數表標題留空時的預設值' },
  { key: CONFIG_KEYS.DEFAULT_NEXT_WEEK_HEADING, value: '下週主日崇拜聚會事奉肢體', note: 'BulletinWeeks 的下週事奉標題留空時的預設值' },
  { key: CONFIG_KEYS.DEFAULT_PRAYER_BLOCK_HEADING, value: '代禱事項', note: 'BulletinWeeks 的代禱區塊標題留空時的預設值' },
  { key: CONFIG_KEYS.WEBAPP_ENABLED, value: 'TRUE', note: '填寫介面總開關；FALSE 時 doGet 只回一頁說明，不渲染介面' },
  { key: CONFIG_KEYS.WEBAPP_ALLOWED_EMAILS, value: '', note: '可以使用填寫介面的電郵，逗號分隔；留空時只有部署者本人可用' },
  { key: CONFIG_KEYS.WEBAPP_URL, value: '', note: '填寫介面部署後的網址，由 Ivan 自行填入，選單「開啟填寫介面」會用到' },
  { key: CONFIG_KEYS.PRAYER_BLOCK_HEADING_OPTIONS, value: '代禱事項,宣教消息,宣教代禱消息,宣教代禱事項', note: '代禱區塊標題欄位的建議值清單（逗號分隔）' },
  // ---- 第五輪新增：電郵與自動寄送 ----
  { key: CONFIG_KEYS.CHURCH_NAME, value: '基督教中國佈道會奧克蘭聖道堂', note: '電郵範本 {{ChurchName}} 用；EmailTemplates 內文一直用這個佔位符但先前沒有對應設定，會渲染成空字串' },
  { key: CONFIG_KEYS.SEND_MINUTE, value: '0', note: '自動寄送的分鐘（0–59），配合 SEND_WEEKDAY／SEND_HOUR；⚠️ 僅供顯示規劃用，Apps Script 的時間觸發器實際上不能指定分鐘' },
  { key: CONFIG_KEYS.SEND_TARGET_OFFSET_DAYS, value: '6', note: '由觸發日推算「要寄哪一個主日」的天數；星期一寄下個主日就是 6' },
  { key: CONFIG_KEYS.SEND_GROUPS, value: 'CC,DB,ADMIN', note: '要寄給哪幾個 Recipients.GROUP_NAME（逗號分隔）' },
  { key: CONFIG_KEYS.SEND_INCLUDE_MISSING_LIST, value: 'TRUE', note: '郵件內是否附上「本週待填欄位」清單' },
  { key: CONFIG_KEYS.SEND_BLOCK_IF_SCHEMA_OUTDATED, value: 'TRUE', note: '工作表結構落後時拒絕寄送' },
  { key: CONFIG_KEYS.EMAIL_TEMPLATE_ID, value: 'TPL_WEEKLY_BULLETIN', note: '用哪一個 EmailTemplates 範本' }
]);

// =====================================================================
// 各種列舉
// =====================================================================

/** BulletinWeeks.STATUS 允許的取值。 */
var BULLETIN_WEEK_STATUS = Object.freeze({
  DRAFT: 'DRAFT',
  READY: 'READY',
  SENT: 'SENT'
});

/** PersonDisplay.HONORIFIC 允許的取值。 */
var HONORIFIC = Object.freeze({
  BROTHER: '弟兄',
  SISTER: '姊妹',
  PASTOR: '牧師',
  PASTORS_WIFE: '師母',
  MINISTER: '傳道',
  MISSIONARY: '宣教士',
  NONE: ''
});

/** Recipients.GROUP_NAME 允許的取值。 */
var RECIPIENT_GROUP = Object.freeze({
  CC: 'CC',
  DB: 'DB',
  ADMIN: 'ADMIN',
  TEST: 'TEST'
});

/**
 * ProgramTemplates.CONTENT_SOURCE 的前綴／固定值。
 * `FIELD:` 與 `WEEK_IN:`／`IF_FIELD:`（見 CONDITION_TYPE）都是前綴，
 * 實際值要接上對應的機器鍵或數字，例如 'FIELD:PRELUDE'。
 */
var CONTENT_SOURCE_PREFIX = Object.freeze({
  FIELD: 'FIELD:',
  AUTO_RECITATION: 'AUTO:RECITATION',
  STATIC: 'STATIC',
  BLANK: 'BLANK'
});

/** ProgramTemplates.CONDITION 的前綴／固定值。 */
var CONDITION_TYPE = Object.freeze({
  ALWAYS: 'ALWAYS',
  WEEK_IN_PREFIX: 'WEEK_IN:',
  IF_FIELD_PREFIX: 'IF_FIELD:',
  NEVER: 'NEVER'
});

/** ProgramTemplates.POSTURE 允許的取值。 */
var POSTURE = Object.freeze({
  STAND: '眾 立',
  SIT: '眾 坐',
  NONE: ''
});

/** ErrorLog.SOURCE 允許的取值。 */
var ERROR_LOG_SOURCE = Object.freeze({
  SERVER: 'SERVER',
  CLIENT: 'CLIENT',
  MENU: 'MENU',
  TRIGGER: 'TRIGGER'
});

// 注意：本檔案刻意不含 Node.js `module.exports`。tests/ 內的 Node 回歸測試
// 用 tests/helpers/loadGas.js 把多個 .gs 檔案載入同一個 vm context，模擬
// Apps Script「全部檔案共用一個全域命名空間」的真實行為；如果只用
// `require()` 個別載入，SheetUtils.gs 等檔案內對 COLUMN_TYPES／SHEETS 的
// 跨檔參照會因為 Node 各模組各自獨立作用域而失敗。
