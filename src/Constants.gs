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

/**
 * `SendLog.BODY_PREVIEW` 最多存幾多個字元。
 *
 * ⚠️ 一定要**有**上限：整封 HTML 內文動輒幾萬字元，一格塞爆會令
 * `SendLog` 難以閱讀，而這一欄的用途只是「在不真寄的情況下核對格式」，
 * 前 2000 字元已經涵蓋主旨之後的稱呼、開頭段落與第一批內容。
 */
var SEND_LOG_BODY_PREVIEW_CHARS = 2000;

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
  HONORIFIC_LOOKUP: 'HonorificLookup',
  POST_DISPLAY: 'PostDisplay',
  MERGE_GROUPS: 'MergeGroups',
  PROGRAM_TEMPLATES: 'ProgramTemplates',
  RECIPIENTS: 'Recipients',
  EMAIL_TEMPLATES: 'EmailTemplates',
  DIAGNOSTICS: 'Diagnostics',
  AUDIT_LOG: 'AuditLog',
  SEND_LOG: 'SendLog',
  ERROR_LOG: 'ErrorLog',
  DUTY_OVERRIDE: 'DutyOverride',
  CONFLICT_NOTICE_LOG: 'ConflictNoticeLog',
  FELLOWSHIP_DEFAULTS: 'FellowshipDefaults',
  FILL_SNAPSHOT: 'FillSnapshot',
  FILL_BACKUP: 'FillBackup',
  CONTENT_SHEETS: 'ContentSheets',
  PUBLISH_LOG: 'PublishLog',
  // ---- 自測機（R-027）----
  NUMBER_REGISTRY: 'NumberRegistry',
  SELF_TEST_STATE: 'SelfTestState',
  SELF_TEST_REPORT: 'SelfTestReport',
  MONKEY_LOG: 'MonkeyLog',
  MONKEY_STATE: 'MonkeyState'
});

/**
 * 季度集中填寫表的工作表名稱前綴。實際名稱是 `Fill_<QuarterID>`
 * （例如 `Fill_2027T4`），一季一張，所以不可能列在 `SHEETS` 內。
 *
 * ⚠️ `onFillGridEdit_()` 靠這個前綴判斷「這次編輯關不關我事」，
 * 改動它等於改動觸發器的行為，一定要同步更新 docs/季度填寫表使用說明.md。
 */
var FILL_GRID_SHEET_PREFIX = 'Fill_';

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
      '最後產生時間', '寄出時間', '最後儲存時間', '備註',
      // ⚠️ 第六輪新增的兩欄刻意加在**最後面**（`NOTES` 之後），不是插在
      // 中間——`ensureSheet_()` 只會重寫第 1、2 行標題，不會搬動第 3 行
      // 起的資料。在中間插欄的話，既有資料的欄位位置會整排錯開，原本
      // 「備註」那一格會被當成新欄位讀出來。加在最後面是唯一不會動到
      // 既有資料的做法。
      '快照職事表版本', '快照時間',
      // prompt9 §1.6 之後新增：財務報告註腳／結餘（同樣加在最後面，
      // 理由跟上面第六輪那兩欄一樣）。
      '財務報告註腳', '財務報告結餘',
      // 浸禮合堂副框六欄（同樣加在最後面，理由同上）。前三欄是**單人**
      // 欄位（要經 PersonDisplay 尊稱機制），後三欄是**多人**欄位
      // （空格分隔、原樣輸出，不加尊稱、不排序）——分別見
      // src/BaptismBox.gs 的 baptismBoxFieldDefs_()。
      '浸禮主禮', '入會禮主禮', '孩童奉獻禮主禮',
      '受浸肢體', '入會肢體', '奉獻孩童',
      // R-036：職事表未有該季資料時仍然建立得到週報，用這一欄記住那一行的
      // 事奉資料是不是齊全。同樣加在**最尾**，理由見上面第六輪那一段。
      '職事表狀態'
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
      'LAST_GENERATED_AT', 'SENT_AT', 'LAST_SAVED_AT', 'NOTES',
      'ROSTER_SNAPSHOT_VERSION', 'ROSTER_SNAPSHOT_AT',
      'FINANCE_NOTE', 'FINANCE_BALANCE',
      'BAPTISM_OFFICIANT', 'MEMBERSHIP_OFFICIANT', 'CHILD_DEDICATION_OFFICIANT',
      'BAPTISM_MEMBERS', 'MEMBERSHIP_MEMBERS', 'CHILD_DEDICATION_CHILDREN',
      'ROSTER_STATUS'
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
      'DATE', 'DATE', 'DATE', 'TEXT',
      'INT', 'DATE',
      'TEXT', 'TEXT',
      'TEXT', 'TEXT', 'TEXT',
      'TEXT', 'TEXT', 'TEXT',
      'TEXT'
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
    headers: ['主日日期', '次序', '項目', '特殊海外奉獻', '慈惠', '欄三', '欄四', '欄五', '有效'],
    // ⚠️ prompt9 §1.6 新增 COL3／COL4／COL5：範本用到 FINANCE 清單的
    // LABEL、COL1、COL2、COL3、COL4 五個渲染欄位，其中 COL1／COL2 對應
    // 既有的 COL_SPECIAL_OVERSEAS／COL_HARDSHIP（沿用舊機器鍵，舊資料
    // 不受影響），COL3／COL4 對應這裡新增的 COL3／COL4。COL5 是保留欄，
    // 目前沒有對應的渲染佔位符——見 docs/待確認事項.md 的說明。
    keys: ['SERVICE_DATE', 'SEQ_NO', 'ROW_LABEL', 'COL_SPECIAL_OVERSEAS', 'COL_HARDSHIP', 'COL3', 'COL4', 'COL5', 'ACTIVE'],
    types: ['DATE', 'INT', 'TEXT', 'TEXT', 'TEXT', 'TEXT', 'TEXT', 'TEXT', 'BOOLEAN'],
    // 第一輪自測修正：金額欄設計上是**文字**，樣本值如 '42,150'、'1,234.50'。
    // 沒有這道防線，Google Sheets 會把 '42,150' 自動轉成數字 42150，
    // 於是每次匯入都覺得「值不同」而重寫一次，永遠不會冪等，週報也會
    // 印出沒有千分位的金額。見 docs/已知bug類型.md 事故二十八。
    textFormatColumns: ['COL_SPECIAL_OVERSEAS', 'COL_HARDSHIP', 'COL3', 'COL4', 'COL5']
  },

  PERSON_DISPLAY: {
    headers: ['PersonID', '姓名', '尊稱', '顯示覆寫', '生效日', '失效日', '有效', '備註'],
    keys: ['PERSON_ID', 'NAME_TC', 'HONORIFIC', 'DISPLAY_OVERRIDE', 'EFFECTIVE_FROM', 'EFFECTIVE_TO', 'ACTIVE', 'NOTES'],
    types: ['TEXT', 'TEXT', 'TEXT', 'TEXT', 'DATE', 'DATE', 'BOOLEAN', 'TEXT']
  },

  // 第六b輪新增：Ivan 人手貼上的「姓名 → 尊稱」對照表，不是系統資料——
  // 由 seed 零行（initializeAllSheets() 只建立標題兩行），讀取時要寬鬆
  // （見 src/HonorificSetup.gs 的說明）。
  HONORIFIC_LOOKUP: {
    headers: ['姓名', '尊稱', '出現次數', '備註'],
    keys: ['NAME_TC', 'HONORIFIC', 'OCCURRENCES', 'NOTE'],
    types: ['TEXT', 'TEXT', 'INT', 'TEXT']
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

  // ⚠️ `BODY_PREVIEW` 是自測機那一輪補的：`DRY_RUN=TRUE` 之下如果只記
  // 收件人而不記內容，就沒有辦法在不真寄的情況下檢查電郵格式——那正是
  // 試行模式最主要的用途。內文取前 `SEND_LOG_BODY_PREVIEW_CHARS` 個字元。
  // ⚠️ 新欄位一律加在**最後**（`ensureSheet_()` 只重寫第 1、2 行，
  // 插在中間會令既有資料整排錯位）。
  // ⚠️ 第四輪加最尾那一欄 BATCH_ID：同一次寄出寫入的每一行共用一個編號。
  //    沒有它的話，不變量 I04 唯有用**時間視窗**（90 秒）去圈「一批」——
  //    而連續兩次寄出（亂行機幾秒就一步）會被併成一批，行數變成兩倍，
  //    I04 報一個假的「預覽講的與實際做的不同」。見 docs/已知bug類型.md
  //    事故三十九。
  SEND_LOG: {
    headers: ['時間', '主日日期', '收件人', '主旨', '狀態', '是否試行', '職事表版本', '錯誤', '內文摘要', '批次編號'],
    keys: ['TIMESTAMP', 'SERVICE_DATE', 'RECIPIENT_EMAIL', 'SUBJECT', 'STATUS', 'DRY_RUN', 'ROSTER_VERSION_USED', 'ERROR', 'BODY_PREVIEW', 'BATCH_ID'],
    types: ['DATE', 'DATE', 'TEXT', 'TEXT', 'TEXT', 'BOOLEAN', 'TEXT', 'TEXT', 'TEXT', 'TEXT'],
    textFormatColumns: ['BATCH_ID']
  },

  // 第四b輪新增：把例外「看得見、留得低」——伺服器／前端／選單三種來源
  // 的錯誤統一寫進這裡，見 src/ErrorLog.gs。DETAIL 一律不可以存電郵或
  // 完整個人資料，只存堆疊頭幾行與程式碼自己組的參數摘要（見
  // docs/已知bug類型.md 事故七）。
  ERROR_LOG: {
    headers: ['時間', '使用者', '來源', '函式', '錯誤代碼', '錯誤訊息', '詳情'],
    keys: ['TIMESTAMP', 'ACTOR', 'SOURCE', 'FUNCTION_NAME', 'ERROR_CODE', 'MESSAGE', 'DETAIL'],
    types: ['DATE', 'TEXT', 'TEXT', 'TEXT', 'TEXT', 'TEXT', 'TEXT']
  },

  // 第六輪新增：幹事在週報直接改事奉名單時的人手覆寫記錄。
  //
  // ⚠️ `OVERRIDE_NAME` 是**顯示用的姓名文字**，不是 PersonID——幹事可能
  // 填一個職事表根本沒有的人（例如臨時幫忙的訪客）。
  // ⚠️ `ROSTER_VALUE_AT_OVERRIDE` 是**覆寫當時**職事表那一格的值，衝突
  // 判斷完全靠它（見 src/RosterDiff.gs 的說明）。
  // ⚠️ **不刪行**：取消覆寫是把 `ACTIVE` 改成 FALSE。
  DUTY_OVERRIDE: {
    headers: [
      '主日日期', '崗位', '位次', '覆寫姓名', '覆寫時的職事表值',
      '覆寫時的職事表版本', '覆寫時間', '覆寫者', '原因', '有效', '備註'
    ],
    keys: [
      'SERVICE_DATE', 'POST_ID', 'SLOT_INDEX', 'OVERRIDE_NAME', 'ROSTER_VALUE_AT_OVERRIDE',
      'ROSTER_VERSION_AT_OVERRIDE', 'OVERRIDE_AT', 'OVERRIDE_BY', 'REASON', 'ACTIVE', 'NOTES'
    ],
    types: [
      'DATE', 'TEXT', 'INT', 'TEXT', 'TEXT',
      'INT', 'DATE', 'TEXT', 'TEXT', 'BOOLEAN', 'TEXT'
    ]
  },

  // 第六輪新增：已經寄過衝突提醒的「指紋」記錄，用來防止同一個衝突
  // 每星期重複轟炸收件人。指紋變了（職事表又改過）才會再寄一次。
  CONFLICT_NOTICE_LOG: {
    headers: ['時間', '主日日期', '崗位', '位次', '指紋', '職事表現值', '備註'],
    keys: ['TIMESTAMP', 'SERVICE_DATE', 'POST_ID', 'SLOT_INDEX', 'FINGERPRINT', 'ROSTER_VALUE', 'NOTES'],
    types: ['DATE', 'DATE', 'TEXT', 'INT', 'TEXT', 'TEXT', 'TEXT']
  },

  // 第八輪新增：本週團契聚會的「常設時間表」。由它自動產生整季的
  // `Fellowships` 資料列，幹事只需要改例外。
  FELLOWSHIP_DEFAULTS: {
    headers: ['團契名稱', '出現規則', '星期文字', '日期偏移', '時間', '預設週會內容', '排序', '有效'],
    keys: ['FELLOWSHIP_NAME', 'RECURRENCE', 'DAY_LABEL', 'DAY_OFFSET', 'TIME_TEXT', 'DEFAULT_CONTENT', 'SORT_ORDER', 'ACTIVE'],
    types: ['TEXT', 'TEXT', 'TEXT', 'INT', 'TEXT', 'TEXT', 'INT', 'BOOLEAN'],
    // TIME_TEXT 是 `4:30pm`／`10:00AM` 這種寫法，一定要強制純文字，
    // 否則 Sheets 會把它轉成時間值，再讀出來就變成一個 Date。
    textFormatColumns: ['TIME_TEXT']
  },

  // 第八輪新增：季度填寫表與 BulletinWeeks 之間做**三方比對**用的快照。
  //
  // ⚠️ 這張表就是「不可以用兩方比較判斷衝突」那條規則的實體。格子表現值
  // 與 BulletinWeeks 現值不同是**正常的**（其中一邊改過），一定要有
  // 「上次同步時兩邊都是什麼」這個第三方基準，才分得出「只有一邊改過」
  // 與「兩邊都改過」。跟 `DutyOverride.ROSTER_VALUE_AT_OVERRIDE` 是同一
  // 個道理，見 src/RosterDiff.gs 與 src/FillSync.gs 的說明。
  FILL_SNAPSHOT: {
    headers: ['季度', '主日日期', '欄位', '值', '快照時間'],
    keys: ['QUARTER_ID', 'SERVICE_DATE', 'FIELD_KEY', 'VALUE', 'SNAPSHOT_AT'],
    types: ['TEXT', 'DATE', 'TEXT', 'TEXT', 'DATE'],
    // VALUE 存的是使用者填的原文（可能是 `--`、`前:5 / 後:120`、
    // `2027-11-07` 這種會被 Sheets 誤判的字串），一律強制純文字。
    textFormatColumns: ['VALUE']
  },

  // 第八輪新增：季度資料的版本備份，可以還原。
  //
  // ⚠️ `PAYLOAD_JSON` 單格上限 50000 字元，超過就分拆成多行
  // （`BACKUP_ID` 相同、`PART_NO` 遞增），還原時按 `PART_NO` 串回來。
  // Google Sheets 單格硬上限是 50000 字元，超過會**靜靜截斷**，
  // 那樣備份就變成一份還原不到的假記錄——比沒有備份更危險。
  FILL_BACKUP: {
    headers: ['備份編號', '分段', '季度', '建立時間', '建立者', '觸發原因', '內容', '行數'],
    keys: ['BACKUP_ID', 'PART_NO', 'QUARTER_ID', 'CREATED_AT', 'CREATED_BY', 'REASON', 'PAYLOAD_JSON', 'ROW_COUNT'],
    types: ['TEXT', 'INT', 'TEXT', 'DATE', 'TEXT', 'TEXT', 'TEXT', 'INT'],
    textFormatColumns: ['PAYLOAD_JSON']
  },

  // R-013：每季一個「內容表」（獨立試算表，放 Shared Drive）的登記表。
  // ⚠️ 這張表只記**指向哪一個檔案**，內容本身住在那個檔案裡面，不在這裡。
  CONTENT_SHEETS: {
    headers: ['季度', '檔案 ID', '連結', '建立時間', '最後匯入時間', '邀請寄出時間', '有效'],
    keys: ['QUARTER_ID', 'FILE_ID', 'FILE_URL', 'CREATED_AT', 'LAST_IMPORTED_AT', 'INVITE_SENT_AT', 'ACTIVE'],
    types: ['TEXT', 'TEXT', 'TEXT', 'DATE', 'DATE', 'DATE', 'BOOLEAN']
  },

  // R-009：每次發佈記一行。同一個主日再發佈，`VERSION_NO` 加一。
  // ⚠️ 第二輪自測新增最後兩欄 MASTER_FILE_ID／IS_SELFTEST（一律加在**最尾**，
  //    ensureSheet_() 只會重寫第 1、2 行）。沒有這兩欄的話，發佈記錄講不出
  //    「這一次覆寫了哪一個檔案」，於是不變量 I06 唯有假設「最新一行 ＝ 正式
  //    master」——自測機發佈完沙盒 master 之後，那個假設即刻不成立，I06 由此
  //    永遠失敗，並把 S13 之後每一個情境一齊染紅。見 docs/已知bug類型.md
  //    事故三十一。
  //
  // ⚠️ 第三輪再加 CONTENT_BYTES／CONTENT_MD5：發佈當時的指紋**直接記在
  //    這一行上**，不再依賴一份共用的 Script Property。共用那一份會被
  //    下一次發佈（包括沙盒發佈）蓋走，於是 I06 拿到一份不屬於這一行的
  //    指紋，報出一個假的「內容對不上」。見事故三十三。
  PUBLISH_LOG: {
    headers: [
      '主日日期', '版本', '發佈時間', '發佈人', '存檔檔案 ID',
      '是否有寄出', '收件組別', '未填欄位數', '是否強制發佈', '強制原因',
      'master 檔案 ID', '是否自測', '內容位元組數', '內容 MD5'
    ],
    keys: [
      'SERVICE_DATE', 'VERSION_NO', 'PUBLISHED_AT', 'PUBLISHED_BY', 'ARCHIVE_FILE_ID',
      'SENT', 'SENT_GROUPS', 'MISSING_COUNT', 'FORCED', 'FORCED_REASON',
      'MASTER_FILE_ID', 'IS_SELFTEST', 'CONTENT_BYTES', 'CONTENT_MD5'
    ],
    types: [
      'DATE', 'INT', 'DATE', 'TEXT', 'TEXT',
      'BOOLEAN', 'TEXT', 'INT', 'BOOLEAN', 'TEXT',
      'TEXT', 'BOOLEAN', 'INT', 'TEXT'
    ]
  },

  // ---- 自測機（R-027）以下四張 ----

  // I03 的登記表：**每一個會在畫面顯示的數字都要在這裡登記一行**，寫明
  // 它來自哪一支函式、對應哪一張工作表的什麼條件。`runInvariantI03_()`
  // 會逐行按登記**用另一條路徑**重新數一次，對不上就紅。
  //
  // ⚠️ 這張表是「宣告」，真正兩條計算路徑寫在 `numberRegistryProbes_()`
  // （src/Invariants.gs）。兩邊的 `REGISTRY_ID` 必須一一對應——登記了
  // 但沒有實作、或者實作了但沒有登記，I03 都會報紅。
  NUMBER_REGISTRY: {
    headers: ['登記編號', '顯示位置', '產生數字的函式', '對應工作表', '重新數的條件', '有效', '備註'],
    keys: ['REGISTRY_ID', 'DISPLAY_LOCATION', 'SOURCE_FUNCTION', 'SHEET_NAME', 'RECOUNT_RULE', 'ACTIVE', 'NOTES'],
    types: ['TEXT', 'TEXT', 'TEXT', 'TEXT', 'TEXT', 'BOOLEAN', 'TEXT']
  },

  // 自測機的續跑狀態。Apps Script 有執行時間上限，所以每個情境跑完就
  // 記一行，〔繼續跑自測〕由上次停低處接住。
  SELF_TEST_STATE: {
    headers: ['執行編號', '情境編號', '狀態', '開始時間', '結束時間', '訊息'],
    keys: ['RUN_ID', 'SCENARIO_ID', 'STATUS', 'STARTED_AT', 'FINISHED_AT', 'MESSAGE'],
    types: ['TEXT', 'TEXT', 'TEXT', 'DATE', 'DATE', 'TEXT']
  },

  // 自測機的報告。**每一條紅色都要拿得出實際的值**，所以預期／實際／
  // 證據三欄分開存，不是塞成一句話。
  SELF_TEST_REPORT: {
    headers: ['執行編號', '情境編號', '情境名稱', '結果', '預期', '實際', '證據', '耗時（毫秒）', '時間'],
    keys: ['RUN_ID', 'SCENARIO_ID', 'SCENARIO_NAME', 'RESULT', 'EXPECTED', 'ACTUAL', 'EVIDENCE', 'ELAPSED_MS', 'TIMESTAMP'],
    types: ['TEXT', 'TEXT', 'TEXT', 'TEXT', 'TEXT', 'TEXT', 'TEXT', 'INT', 'DATE']
  },

  // 亂行機每一步一行。**最重要的一欄是 `PATH_SO_FAR`**——「走到這裏的
  // 完整步驟」，沒有它紅了也重現不到。
  MONKEY_LOG: {
    headers: ['執行編號', '亂數種子', '第幾步', '可選動作', '揀了甚麼', '結果', '不變量狀態', '走到這裏的完整步驟', '時間'],
    keys: ['RUN_ID', 'SEED', 'STEP_NO', 'AVAILABLE_ACTIONS', 'CHOSEN_ACTION', 'RESULT', 'INVARIANT_STATUS', 'PATH_SO_FAR', 'TIMESTAMP'],
    types: ['TEXT', 'TEXT', 'INT', 'TEXT', 'TEXT', 'TEXT', 'TEXT', 'TEXT', 'DATE']
  },

  // ⚠️ 亂行機的續跑狀態。沒有這一張表，〔繼續亂行〕只會開新一輪：
  //    新的 RUN_ID、新的種子、STEP_NO 由 1 數起，目標步數永遠跑不滿。
  //    見 docs/已知bug類型.md 事故三十四。
  //
  // ⚠️ `RNG_STATE` 是**續跑的關鍵**：亂數產生器走到哪一步的內部狀態。
  //    只存種子不夠——由種子重新開始，等於重播頭 N 步，不是接住走。
  MONKEY_STATE: {
    headers: ['執行編號', '亂數種子', '目標步數', '已走步數', '亂數狀態', '狀態',
      '開始時間', '更新時間', '備註', '走過的路'],
    keys: ['RUN_ID', 'SEED', 'TARGET_STEPS', 'STEPS_DONE', 'RNG_STATE', 'STATUS',
      'STARTED_AT', 'UPDATED_AT', 'NOTES', 'PATH_SO_FAR'],
    types: ['TEXT', 'TEXT', 'INT', 'INT', 'TEXT', 'TEXT', 'DATE', 'DATE', 'TEXT', 'TEXT'],
    // 種子與亂數狀態是 32 位元整數，會超出試算表的顯示精度而被改寫成
    // 科學記數法——一律當文字存，見 docs/已知bug類型.md 事故二十八。
    // ⚠️ PATH_SO_FAR 用「步數:動作」的精簡格式（`1:CREATE_WEEKS,2:EDIT_FIELDS`），
    //    帶冒號與數字，不設純文字格式的話會被試算表當成時間（事故二十八）。
    textFormatColumns: ['SEED', 'RNG_STATE', 'PATH_SO_FAR']
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
  SEND_GROUPS: 'SEND_GROUPS',
  SEND_INCLUDE_MISSING_LIST: 'SEND_INCLUDE_MISSING_LIST',
  SEND_BLOCK_IF_SCHEMA_OUTDATED: 'SEND_BLOCK_IF_SCHEMA_OUTDATED',
  EMAIL_TEMPLATE_ID: 'EMAIL_TEMPLATE_ID',
  // ---- 第六輪新增：週報與職事表的分歧處理 ----
  CONFLICT_NOTICE_GROUPS: 'CONFLICT_NOTICE_GROUPS',
  // ---- 第七輪新增：Word（OOXML）範本渲染 ----
  TEMPLATE_FILE_ID_NORMAL: 'TEMPLATE_FILE_ID_NORMAL',
  TEMPLATE_FILE_ID_COMBINED_BAPTISM: 'TEMPLATE_FILE_ID_COMBINED_BAPTISM',
  TEMPLATE_FILE_ID_ANNIVERSARY: 'TEMPLATE_FILE_ID_ANNIVERSARY',
  TEMPLATE_MISSING_VALUE_MODE: 'TEMPLATE_MISSING_VALUE_MODE',
  OUTPUT_FILE_NAME_PATTERN: 'OUTPUT_FILE_NAME_PATTERN',
  RENDER_BLOCK_IF_MISSING_FIELDS: 'RENDER_BLOCK_IF_MISSING_FIELDS',
  // ---- 第八輪新增：季度集中填寫表、雙向同步、版本備份、填寫邀請 ----
  FILL_BACKUP_KEEP: 'FILL_BACKUP_KEEP',
  FILL_INVITE_GROUPS: 'FILL_INVITE_GROUPS',
  FILL_CONFLICT_GROUPS: 'FILL_CONFLICT_GROUPS',
  FILL_RESPONSIBILITY_NOTE: 'FILL_RESPONSIBILITY_NOTE',
  FELLOWSHIP_DATE_PATTERN: 'FELLOWSHIP_DATE_PATTERN',
  PROTECTION_EDITOR_EMAILS: 'PROTECTION_EDITOR_EMAILS',
  FILL_RECONCILE_HOURS: 'FILL_RECONCILE_HOURS',
  FILL_AUTO_CREATE_NEXT_QUARTER: 'FILL_AUTO_CREATE_NEXT_QUARTER',
  // ---- prompt9 新增：編號事奉佔位符上限 ----
  DUTY_PLACEHOLDER_MAX: 'DUTY_PLACEHOLDER_MAX',
  // ---- prompt9 §1.6 補漏：FINANCE_TITLE 的組字樣式 ----
  FINANCE_TITLE_PATTERN: 'FINANCE_TITLE_PATTERN',
  // ---- 財政表首欄期別標籤（與 FINANCE_TITLE 用同一個月份來源）----
  FINANCE_PERIOD_LABEL_PATTERN: 'FINANCE_PERIOD_LABEL_PATTERN',
  // ---- 完成度自我檢測季度推算補漏：手動指定「本季」 ----
  WORKING_QUARTER_ID: 'WORKING_QUARTER_ID',
  // ---- 完成度自我檢測報告行數上限補漏：結論優先於明細 ----
  SELFCHECK_MAX_ROWS: 'SELFCHECK_MAX_ROWS',
  SELFCHECK_MISSING_DETAIL_ROWS: 'SELFCHECK_MISSING_DETAIL_ROWS',
  // ---- R-010／R-013／R-014／R-015：每季一個獨立的「內容表」試算表 ----
  CONTENT_SHEET_FOLDER_ID: 'CONTENT_SHEET_FOLDER_ID',
  CONTENT_SHEET_NAME_PATTERN: 'CONTENT_SHEET_NAME_PATTERN',
  CONTENT_SHEET_DOMAIN: 'CONTENT_SHEET_DOMAIN',
  CONTENT_SHEET_INVITE_GROUPS: 'CONTENT_SHEET_INVITE_GROUPS',
  CONTENT_SHEET_INVITE_LEAD_DAYS: 'CONTENT_SHEET_INVITE_LEAD_DAYS',
  CONTENT_SHEET_OWNERS: 'CONTENT_SHEET_OWNERS',
  CONTENT_SHEET_DEADLINE_NOTE: 'CONTENT_SHEET_DEADLINE_NOTE',
  CONTENT_SHEET_SEED_SAMPLE: 'CONTENT_SHEET_SEED_SAMPLE',
  // prompt 第 2 部分要求 `_說明` 分頁印「幹事聯絡方法（取自 Config，不要
  // 寫死）」，但第 4 部分嗰張新鍵表冇列到——所以另外加呢一個。
  // 見 docs/待確認事項.md J-2。
  CONTENT_SHEET_ADMIN_CONTACT: 'CONTENT_SHEET_ADMIN_CONTACT',
  // ---- R-001 至 R-009：發佈及匯出 ----
  PUBLISHED_PDF_FILE_ID: 'PUBLISHED_PDF_FILE_ID',
  PUBLISHED_PDF_FOLDER_ID: 'PUBLISHED_PDF_FOLDER_ID',
  PUBLISHED_PDF_NAME: 'PUBLISHED_PDF_NAME',
  PUBLISHED_ARCHIVE_FOLDER_ID: 'PUBLISHED_ARCHIVE_FOLDER_ID',
  PUBLISH_SEND_GROUPS: 'PUBLISH_SEND_GROUPS',
  PUBLISH_ATTACH_PDF: 'PUBLISH_ATTACH_PDF',
  PUBLISH_MAX_PDF_MB: 'PUBLISH_MAX_PDF_MB',
  // ---- 發佈修正那一輪新增 ----
  PUBLISH_DEDUP_SEC: 'PUBLISH_DEDUP_SEC',
  WEBAPP_CALL_TIMEOUT_SEC: 'WEBAPP_CALL_TIMEOUT_SEC',
  // ---- 使用者測試模式的保險 ----
  TEST_MODE_BANNER: 'TEST_MODE_BANNER',
  // ---- 自測機（R-027）----
  SELFTEST_QUARTER_ID: 'SELFTEST_QUARTER_ID',
  SELFTEST_ROSTER_QUARTER_ID: 'SELFTEST_ROSTER_QUARTER_ID',
  SELFTEST_MASTER_PDF_FILE_ID: 'SELFTEST_MASTER_PDF_FILE_ID',
  SELFTEST_TIME_BUDGET_SEC: 'SELFTEST_TIME_BUDGET_SEC',
  MONKEY_NO_PROGRESS_LIMIT: 'MONKEY_NO_PROGRESS_LIMIT',
  // R-036
  SEND_WHEN_ROSTER_MISSING: 'SEND_WHEN_ROSTER_MISSING',
  BULLETIN_ROSTER_PENDING_NOTE: 'BULLETIN_ROSTER_PENDING_NOTE',
  // R-030
  DST_AUTO_INSERT: 'DST_AUTO_INSERT',
  DST_ANNOUNCEMENT_SEQ: 'DST_ANNOUNCEMENT_SEQ',
  DST_START_ANNOUNCEMENT: 'DST_START_ANNOUNCEMENT',
  DST_END_ANNOUNCEMENT: 'DST_END_ANNOUNCEMENT'
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
  { key: CONFIG_KEYS.SEND_GROUPS, value: 'CC,DB,ADMIN', note: '要寄給哪幾個 Recipients.GROUP_NAME（逗號分隔）' },
  { key: CONFIG_KEYS.SEND_INCLUDE_MISSING_LIST, value: 'TRUE', note: '郵件內是否附上「本週待填欄位」清單' },
  { key: CONFIG_KEYS.SEND_BLOCK_IF_SCHEMA_OUTDATED, value: 'TRUE', note: '工作表結構落後時拒絕寄送' },
  { key: CONFIG_KEYS.EMAIL_TEMPLATE_ID, value: 'TPL_WEEKLY_BULLETIN', note: '用哪一個 EmailTemplates 範本' },
  // ---- 第六輪新增：週報與職事表的分歧處理 ----
  { key: CONFIG_KEYS.CONFLICT_NOTICE_GROUPS, value: 'ADMIN', note: '職事表分歧提醒信要寄給哪幾個 Recipients.GROUP_NAME（逗號分隔）' },
  // ---- 第七輪新增：Word（OOXML）範本渲染 ----
  { key: CONFIG_KEYS.TEMPLATE_FILE_ID_NORMAL, value: '', note: '平常主日 Word 範本（.docx）的雲端硬碟檔案 ID' },
  { key: CONFIG_KEYS.TEMPLATE_FILE_ID_COMBINED_BAPTISM, value: '', note: '浸禮三堂聯合崇拜 Word 範本的雲端硬碟檔案 ID' },
  { key: CONFIG_KEYS.TEMPLATE_FILE_ID_ANNIVERSARY, value: '', note: '堂慶三堂聯合崇拜 Word 範本的雲端硬碟檔案 ID' },
  { key: CONFIG_KEYS.TEMPLATE_MISSING_VALUE_MODE, value: 'BLANK', note: '範本佔位符找不到值時：BLANK 換成空字串／KEEP 原樣保留／ERROR 拋錯' },
  { key: CONFIG_KEYS.OUTPUT_FILE_NAME_PATTERN, value: '{{SERVICE_DATE}}_粵語堂週報.docx', note: '產生的 Word 檔名樣式，可用 {{SERVICE_DATE}} 佔位符' },
  { key: CONFIG_KEYS.RENDER_BLOCK_IF_MISSING_FIELDS, value: 'FALSE', note: '有待填欄位時是否拒絕產生 Word 週報' },
  // ---- 第八輪新增：季度集中填寫表、雙向同步、版本備份、填寫邀請 ----
  { key: CONFIG_KEYS.FILL_BACKUP_KEEP, value: '20', note: 'FillBackup 每一季保留幾多個備份，超過就刪最舊的' },
  { key: CONFIG_KEYS.FILL_INVITE_GROUPS, value: 'ADMIN,CC,DB,IT,WORSHIP', note: '季度填寫邀請要寄給哪幾個 Recipients.GROUP_NAME（逗號分隔）' },
  { key: CONFIG_KEYS.FILL_CONFLICT_GROUPS, value: 'ADMIN', note: '填寫表同步衝突提醒要寄給哪幾個 Recipients.GROUP_NAME（逗號分隔）' },
  {
    key: CONFIG_KEYS.FILL_RESPONSIBILITY_NOTE,
    value: '詩歌由領詩填寫；講題與經文由幹事填寫；家事報告與代禱事項由幹事整理',
    note: '填寫邀請信內說明「哪些欄位由誰負責」的那一句'
  },
  { key: CONFIG_KEYS.FELLOWSHIP_DATE_PATTERN, value: 'd/M', note: '由常設時間表產生團契聚會日期時的格式（會再接上空格與星期文字）' },
  { key: CONFIG_KEYS.PROTECTION_EDITOR_EMAILS, value: '', note: '即使在受保護的工作表也可以編輯的電郵（逗號分隔）；留空代表只有擁有者' },
  { key: CONFIG_KEYS.FILL_RECONCILE_HOURS, value: '6', note: '填寫表定時對帳觸發器每隔幾多小時跑一次' },
  { key: CONFIG_KEYS.FILL_AUTO_CREATE_NEXT_QUARTER, value: 'TRUE', note: '每週寄送流程發現職事表有未建立填寫表的季度時，是否自動建立並寄出填寫邀請' },
  { key: CONFIG_KEYS.DUTY_PLACEHOLDER_MAX, value: '20', note: 'DUTY_01..NN／NEXT_DUTY_01..NN 編號事奉佔位符的上限；超出實際事奉行數的一律輸出空字串' },
  {
    key: CONFIG_KEYS.FINANCE_TITLE_PATTERN,
    value: '聖道堂綜合收支財務報告-{{YEAR}}年 {{MONTH}}月份',
    note: '{{FINANCE_TITLE}} 佔位符的組字樣式；{{YEAR}}／{{MONTH}} 換成該主日「上一個月」的年份與月份（財務報告照慣例滯後一個月）'
  },
  {
    key: CONFIG_KEYS.FINANCE_PERIOD_LABEL_PATTERN,
    value: '{{MONTH}}月份',
    note: '財政表首欄期別標籤樣式；{{YEAR}}／{{MONTH}} 換成該主日「上一個月」的年月，與 FINANCE_TITLE_PATTERN 用同一組數值（同一個 financeReportPreviousMonth_()）'
  },
  {
    key: CONFIG_KEYS.WORKING_QUARTER_ID,
    value: '',
    note: '手動指定系統預設使用的季度（例如 2027T4）。留空則自動推算：先試下一個要寄的主日，失敗則用 ROSTER_TEST_DATE，見 resolveWorkingQuarter_()'
  },
  { key: CONFIG_KEYS.SELFCHECK_MAX_ROWS, value: '140', note: '完成度自我檢測報告最多寫入 Diagnostics 幾多行；大於 DIAGNOSTICS_MAX_ROWS 時取兩者較小值' },
  { key: CONFIG_KEYS.SELFCHECK_MISSING_DETAIL_ROWS, value: '20', note: '完成度自我檢測「本季待填欄位總數」逐主日彙總明細最多列幾多行，其餘以「尚有 N 項」帶過；完整明細見選單「本季待填清單」' },
  // ---- 內容表（R-010／R-013／R-014／R-015）----
  { key: CONFIG_KEYS.CONTENT_SHEET_FOLDER_ID, value: '', note: '⚠️ 必填：內容表要建立在哪一個 Shared Drive 資料夾（資料夾 ID）。留空時「建立本季內容表」會停下來並講明要填哪一個鍵' },
  { key: CONFIG_KEYS.CONTENT_SHEET_NAME_PATTERN, value: '週報內容_{{QUARTER_ID}}', note: '內容表的檔名樣式；{{QUARTER_ID}} 換成季度 ID' },
  // ⚠️ 網域**一律 seed 成空字串**，不可以寫死教會的真實網域——本檔案開頭
  // 的硬規則（不可出現真實 ID／電郵／姓名）同樣涵蓋網域，`tools/scan-staged-secrets.js`
  // 亦會直接擋住 commit。留空時 createContentSpreadsheet_() 不設分享權限，
  // 由人手處理，並在對話框講明。見 docs/待確認事項.md J-8。
  { key: CONFIG_KEYS.CONTENT_SHEET_DOMAIN, value: '', note: '⚠️ 必填：內容表分享給哪一個網域（網域內任何人可編輯），例如教會的 Google Workspace 網域。留空時不會自動設定分享權限，要人手設。一律不設成「任何知道連結的人」' },
  { key: CONFIG_KEYS.CONTENT_SHEET_INVITE_GROUPS, value: 'CC,DB,ADMIN,IT', note: '「寄出內容表連結」要寄給哪幾個 Recipients.GROUP_NAME' },
  { key: CONFIG_KEYS.CONTENT_SHEET_INVITE_LEAD_DAYS, value: '21', note: '距離新一季第一個主日少於幾多日，就自動建立內容表並寄出邀請（同一季只寄一次）' },
  {
    key: CONFIG_KEYS.CONTENT_SHEET_OWNERS,
    value: '家事報告=幹事,代禱事項=堂委,團契聚會=堂委,財政報告=執事,崇拜人數=幹事,宣召=幹事',
    note: '內容表每一張分頁由誰負責，格式「分頁名稱=負責人」，逗號分隔。會印在內容表的 _說明 分頁與邀請信內'
  },
  { key: CONFIG_KEYS.CONTENT_SHEET_DEADLINE_NOTE, value: '請於該主日之前的星期三下午 5 時前填妥', note: '內容表的截止日期說明，印在 _說明 分頁與邀請信內' },
  { key: CONFIG_KEYS.CONTENT_SHEET_SEED_SAMPLE, value: 'TRUE', note: '建立內容表時，是否在該季第一個主日預填樣本資料（示範格式與長度）' },
  { key: CONFIG_KEYS.CONTENT_SHEET_ADMIN_CONTACT, value: '', note: '內容表 _說明 分頁印出來的「有問題搵邊個」聯絡方法（例如幹事的電郵或電話）。⚠️ 一律由這裡填，不可以寫死在原始碼' },
  // ---- 發佈及匯出（R-001 至 R-009）----
  { key: CONFIG_KEYS.PUBLISHED_PDF_FILE_ID, value: '', note: 'master 發佈檔案（固定連結那一個 PDF）的檔案 ID。⚠️ 由選單「建立 master 發佈檔案」自動填，不需要人手填' },
  { key: CONFIG_KEYS.PUBLISHED_PDF_FOLDER_ID, value: '', note: '⚠️ 必填：master 發佈檔案要建立在哪一個資料夾（資料夾 ID）' },
  { key: CONFIG_KEYS.PUBLISHED_PDF_NAME, value: '粵語堂週報（最新一期）.pdf', note: 'master 發佈檔案的檔名。每次發佈都會設回這個名（檔案 ID 不變，所以連結不變）' },
  { key: CONFIG_KEYS.PUBLISHED_ARCHIVE_FOLDER_ID, value: '', note: '⚠️ 必填：每次發佈存一份帶日期與版本號的副本到哪一個資料夾（資料夾 ID）' },
  { key: CONFIG_KEYS.PUBLISH_SEND_GROUPS, value: 'CC,DB,ADMIN', note: '「發佈及匯出」內收件組別的預設勾選（逗號分隔的 Recipients.GROUP_NAME）' },
  { key: CONFIG_KEYS.PUBLISH_ATTACH_PDF, value: 'TRUE', note: '發佈通知郵件要不要把 PDF 一併附上（FALSE 就只放連結）' },
  { key: CONFIG_KEYS.PUBLISH_MAX_PDF_MB, value: '10', note: '上載的 PDF 檔案大小上限（MB），超過會被拒絕' },
  { key: CONFIG_KEYS.PUBLISH_DEDUP_SEC, value: '30', note: '同一個主日在幾多秒內重複發佈會被視為「撳多了一次」，直接回報上一次的版本號，不再產生新版本' },
  { key: CONFIG_KEYS.WEBAPP_CALL_TIMEOUT_SEC, value: '120', note: '填寫介面等候伺服器回應的上限（秒）；超過就顯示逾時訊息，不會一直轉圈' },
  { key: CONFIG_KEYS.TEST_MODE_BANNER, value: '', note: '填寫介面頂部要顯示的藍色提示文字（例如「這是測試系統，資料可以隨便改」）；留空就不顯示這一條橫幅' },
  { key: CONFIG_KEYS.SELFTEST_QUARTER_ID, value: '2030T1', note: '⚠️ 自測機的沙盒季度：自測機**只准寫這一季**。要同時滿足兩個條件：(1) 職事表沒有這一季的資料（順便測「職事表無資料」那條路）；(2) 含夏令時間轉換提示日，S22–S24 才驗得到寫入。提示登在改動當日的**前一個主日**，所以實際上要用 YYYYT1（4 月那一次，提示日在 3 月底）或者 YYYYT3（9 月那一次）——YYYYT2 與 YYYYT4 永遠不會含提示日。改成一個有真實資料的季度＝自測機會寫壞真資料' },
  { key: CONFIG_KEYS.SELFTEST_ROSTER_QUARTER_ID, value: '2027T4', note: '自測機需要真實職事表資料時讀哪一季。**只讀不寫**' },
  { key: CONFIG_KEYS.SELFTEST_MASTER_PDF_FILE_ID, value: '', note: '自測機專用的沙盒 master 發佈檔案 ID（自測機不會碰正式那一個）。留空時自測機會略過發佈相關情境並講明原因' },
  { key: CONFIG_KEYS.SELFTEST_TIME_BUDGET_SEC, value: '240', note: '自測機／亂行機每一次執行的時間預算（秒）。接近上限就乾淨停低並寫明「跑到哪一步、還有幾多個未跑」，Apps Script 本身的上限是 360 秒' },
  { key: CONFIG_KEYS.MONKEY_NO_PROGRESS_LIMIT, value: '5', note: '亂行機連續幾多步狀態完全沒有變就當成原地打轉、停手（防打轉閘）' },
  { key: CONFIG_KEYS.SEND_WHEN_ROSTER_MISSING, value: 'TRUE', note: 'R-036：職事表未有該主日資料時，仍然照樣寄出（信中會加一句「事奉資料尚未確定」）。改成 FALSE 就回復舊行為：不寄，並記一筆 ErrorLog' },
  { key: CONFIG_KEYS.BULLETIN_ROSTER_PENDING_NOTE, value: '本期事奉資料尚未確定，稍後另行通知。', note: 'R-036：職事表未有資料而仍然寄出時，加在信中的一句' },
  { key: CONFIG_KEYS.DST_AUTO_INSERT, value: 'TRUE', note: 'R-030：建立／刷新內容表時，自動加入夏令時間轉換提示（登在轉換當日的前一個主日那一期）' },
  { key: CONFIG_KEYS.DST_ANNOUNCEMENT_SEQ, value: '5', note: 'R-030：夏令時間提示在家事報告的次序（數字細者排前）' },
  { key: CONFIG_KEYS.DST_START_ANNOUNCEMENT, value: 'Daylight Saving將開始：今年Daylight Saving於下主日({{CHANGE_DATE}})開始，請於{{SATURDAY}}星期六晚上將時鐘撥前一小時。', note: 'R-030：夏令時間**開始**的提示範本。{{CHANGE_DATE}}＝轉換當日，{{SATURDAY}}＝之前那個星期六' },
  { key: CONFIG_KEYS.DST_END_ANNOUNCEMENT, value: '今年Daylight Saving於下主日({{CHANGE_DATE}}) 完結，請大家於本週六晚將時間回撥一小時。', note: 'R-030：夏令時間**完結**的提示範本。同樣支援 {{CHANGE_DATE}} 與 {{SATURDAY}}' }
]);

// =====================================================================
// 各種列舉
// =====================================================================

/** BulletinWeeks.STATUS 允許的取值。 */
/**
 * `BulletinWeeks.ROSTER_STATUS` 的取值（R-036）。
 *
 * ⚠️ 「職事表未有該季資料」**不是錯誤**，只是「未到」。舊版會令
 * 「建立本季週報」整個中止，於是幹事在職事表準備好之前完全開始不到——
 * 而週報有大量與事奉無關的欄位（講題、詩歌、家事報告）本來就填得。
 *
 * ⚠️ 三個值要分得清：
 *   `OK`　　　　該主日的事奉資料在職事表找得到；
 *   `NOT_FOUND`　整季在職事表都找不到（連主日清單都是曆法推算出來的）；
 *   `PARTIAL`　　該季有部分主日找得到，這一個找不到。
 * 把後兩者混為一談的話，「補抓」之後就講不出還差幾多。
 */
var ROSTER_STATUS = Object.freeze({
  OK: 'OK',
  NOT_FOUND: 'NOT_FOUND',
  PARTIAL: 'PARTIAL'
});

/**
 * 內容表資料列的**來源**（R-030）。
 *
 * ⚠️ 有了它，系統才分得出「這一行是我自己加的」與「這一行是人手加的」。
 * 分不出的話，刷新內容表就只有兩種做法：全部覆寫（蓋走人手輸入）或者
 * 全部不覆寫（範本改了也更新不到）——兩種都不對。
 */
var CONTENT_ROW_SOURCE = Object.freeze({
  MANUAL: 'MANUAL',
  SYSTEM_DST: 'SYSTEM_DST'
});

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

/**
 * Recipients.GROUP_NAME 允許的取值。
 *
 * `IT` 與 `WORSHIP`（領詩）是第八輪新增的——季度填寫表的邀請要寄給
 * 領詩（填整季詩歌）與 IT，所以要有對應的組別。
 */
var RECIPIENT_GROUP = Object.freeze({
  CC: 'CC',
  DB: 'DB',
  ADMIN: 'ADMIN',
  TEST: 'TEST',
  IT: 'IT',
  WORSHIP: 'WORSHIP'
});

/**
 * `FillBackup.REASON` 允許的取值——每一個都對應一個會自動備份的動作。
 * 見 src/FillBackup.gs 的說明。
 */
var FILL_BACKUP_REASON = Object.freeze({
  BEFORE_CREATE_GRID: 'BEFORE_CREATE_GRID',
  BEFORE_RESEQUENCE: 'BEFORE_RESEQUENCE',
  BEFORE_FETCH_FROM_ROSTER: 'BEFORE_FETCH_FROM_ROSTER',
  BEFORE_GENERATE_FELLOWSHIPS: 'BEFORE_GENERATE_FELLOWSHIPS',
  BEFORE_RESTORE: 'BEFORE_RESTORE',
  MANUAL: 'MANUAL'
});

/**
 * 季度填寫表三方比對的四種結果。
 *
 * | 值 | 條件 | 處理 |
 * |---|---|---|
 * | `SAME` | 兩邊都跟快照一樣 | 不做任何事 |
 * | `PUSH` | 只有格子表改過 | 寫回 `BulletinWeeks` |
 * | `PULL` | 只有 `BulletinWeeks` 改過（例如經 Web App） | 刷新格子表 |
 * | `CONFLICT` | **兩邊都改過** | 列出兩個值由使用者選，**不自動蓋任何一邊** |
 */
var FILL_SYNC_STATUS = Object.freeze({
  SAME: 'SAME',
  PUSH: 'PUSH',
  PULL: 'PULL',
  CONFLICT: 'CONFLICT'
});

/**
 * ProgramTemplates.CONTENT_SOURCE 的前綴／固定值。
 * `FIELD:` 與 `WEEK_IN:`／`IF_FIELD:`（見 CONDITION_TYPE）都是前綴，
 * 實際值要接上對應的機器鍵或數字，例如 'FIELD:PRELUDE'。
 */
/**
 * 內容表接管之後、**填寫介面與季度填寫表都不可以再寫入**的欄位。
 * 這是唯一一份真相來源，前端（`src/ui/Script.html`）與後端全部從這裡取。
 *
 * ⚠️ 第一輪自測 S09 揭出的問題：唯讀規則在三個地方各自寫過一次——
 * 前端一個寫死的陣列、後端一支由 `contentImportTargets_()` 衍生的函式、
 * 季度填寫表又完全沒有。三份不同步，等於沒有規則。
 *
 * ⚠️ 「唯讀」的意思是**不可以寫**，不是「不用讀」。這些欄位仍然要讀出來
 * 顯示給人看（見 `webAppWeekFieldKeys_()`），只是儲存時一律不接受。
 *
 * ⚠️ `WEEK` 這一份必須與 `contentImportTargets_()` 推得出來的完全一致，
 * 否則就是「匯入會寫、但介面又准人改」或者反過來。`tests/readonly.test.js`
 * 有一條測試在守這件事——日後新增匯入目標時，那條測試會紅。
 */
var CONTENT_SHEET_READONLY_FIELDS = Object.freeze({
  // BulletinWeeks 的機器鍵。
  WEEK: Object.freeze([
    'CALL_REF', 'CALL_TEXT',
    'ATT_ENG_WORSHIP', 'ATT_CANE_WORSHIP', 'ATT_CANN_WORSHIP', 'ATT_MAN_WORSHIP',
    'ATT_ENG_PRAYER', 'ATT_CANE_PRAYER', 'ATT_CANN_PRAYER', 'ATT_MAN_PRAYER',
    'ATT_ENG_CHILD', 'ATT_CANE_CHILD', 'ATT_CANN_CHILD', 'ATT_MAN_CHILD',
    // 人數統計日期跟著十二個人數欄一起由內容表決定。
    'ATTENDANCE_DATE'
  ]),
  // `webAppListDefs_()` 的 key。
  LISTS: Object.freeze(['announcements', 'prayers', 'fellowships', 'finance'])
});

/**
 * 唯讀欄位給人看的名稱。拒絕訊息要講得出「是哪一欄」，機器鍵對幹事
 * 來說沒有意義。沒有列出的鍵會原樣顯示機器鍵（總好過不講）。
 */
var CONTENT_SHEET_READONLY_LABELS = Object.freeze({
  CALL_REF: '宣召出處',
  CALL_TEXT: '宣召經文',
  ATTENDANCE_DATE: '人數統計日期',
  ATT_ENG_WORSHIP: '英語堂崇拜人數',
  ATT_CANE_WORSHIP: '粵語堂主堂崇拜人數',
  ATT_CANN_WORSHIP: '粵語堂北岸崇拜人數',
  ATT_MAN_WORSHIP: '華語堂崇拜人數',
  ATT_ENG_PRAYER: '英語堂祈禱會人數',
  ATT_CANE_PRAYER: '粵語堂主堂祈禱會人數',
  ATT_CANN_PRAYER: '粵語堂北岸祈禱會人數',
  ATT_MAN_PRAYER: '華語堂祈禱會人數',
  ATT_ENG_CHILD: '英語堂兒童人數',
  ATT_CANE_CHILD: '粵語堂主堂兒童人數',
  ATT_CANN_CHILD: '粵語堂北岸兒童人數',
  ATT_MAN_CHILD: '華語堂兒童人數',
  announcements: '家事報告',
  prayers: '代禱事項',
  fellowships: '本週團契聚會',
  finance: '月度財政報告'
});

var CONTENT_SOURCE_PREFIX = Object.freeze({
  FIELD: 'FIELD:',
  AUTO_RECITATION: 'AUTO:RECITATION',
  STATIC: 'STATIC',
  BLANK: 'BLANK'
});

/**
 * `ProgramTemplates.CONDITION` 與 `FellowshipDefaults.RECURRENCE` 共用的
 * 前綴／固定值。
 *
 * ⚠️ 兩張表刻意共用**同一個求值器**（`evaluateProgramCondition_()`），
 * 不是各自寫一套——「第 2、4 個主日」這種規則在兩處的意思必須完全一樣，
 * 各寫一套遲早會分岔。`WEEK_NOT_IN:` 是第八輪為團契常設時間表加的，
 * 程序範本同樣用得到。
 */
var CONDITION_TYPE = Object.freeze({
  ALWAYS: 'ALWAYS',
  WEEK_IN_PREFIX: 'WEEK_IN:',
  WEEK_NOT_IN_PREFIX: 'WEEK_NOT_IN:',
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

/**
 * 週報與職事表比對的四種狀態（見 src/RosterDiff.gs）。
 *
 * | 值 | 條件 | 處理 |
 * |---|---|---|
 * | `SAME` | 兩邊相同 | 不顯示、不提醒 |
 * | `FOLLOW` | 無覆寫、職事表版本比上一次比對時新 | **自動跟隨**，記一筆 AuditLog，不用問幹事 |
 * | `CONFLICT` | 有覆寫，而且職事表現值 ≠ 覆寫當時記下的職事表值 | **提醒**：職事表在覆寫之後又改過 |
 * | `OVERRIDDEN` | 有覆寫，職事表沒有再改過 | 只在比對表顯示，不算衝突 |
 */
var ROSTER_DIFF_STATUS = Object.freeze({
  SAME: 'SAME',
  FOLLOW: 'FOLLOW',
  CONFLICT: 'CONFLICT',
  OVERRIDDEN: 'OVERRIDDEN'
});

// 注意：本檔案刻意不含 Node.js `module.exports`。tests/ 內的 Node 回歸測試
// 用 tests/helpers/loadGas.js 把多個 .gs 檔案載入同一個 vm context，模擬
// Apps Script「全部檔案共用一個全域命名空間」的真實行為；如果只用
// `require()` 個別載入，SheetUtils.gs 等檔案內對 COLUMN_TYPES／SHEETS 的
// 跨檔參照會因為 Node 各模組各自獨立作用域而失敗。
