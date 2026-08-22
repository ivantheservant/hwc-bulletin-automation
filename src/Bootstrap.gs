/**
 * Bootstrap.gs
 *
 * 週報系統的初始化入口：initializeAllSheets() 建立 SHEETS 定義的全部工作表與標題、
 * 補回 Config 預設值，並 seed PostDisplay／MergeGroups／ProgramTemplates／
 * EmailTemplates 的固定資料。整個檔案冪等：重複執行不會清空既有資料，
 * 也不會重覆新增 seed 資料。
 *
 * 本檔案不寫任何與 Google Docs、PDF、寄送電郵、觸發器有關的程式碼；
 * 也不讀取職事表試算表。
 */

'use strict';

/**
 * 用途：整個週報系統的初始化入口。建立全部工作表與標題（冪等，不清空
 *   既有資料），補回 Config 預設值與各張表的固定 seed 資料，並把本次執行
 *   摘要寫入 Diagnostics。由選單「初始化工作表」呼叫，也可以在 Script
 *   Editor 直接執行。
 * Args: （無）
 * Returns:
 *   {{sheetsEnsured:number, configKeysAdded:number, seedRowsAdded:Object<string,number>}}
 *     本次執行的摘要。
 * Raises:
 *   Error 如果任何一步失敗（例如試算表被鎖定），錯誤會原樣往上拋，由呼叫方
 *     （menuInitializeAllSheets_()）決定如何呈現給使用者。
 */
function initializeAllSheets() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheetIds = Object.keys(SHEETS);

  sheetIds.forEach(function (id) {
    ensureSheet_(ss, id);
  });

  writeReadmeContent_(ss);

  var deprecatedCleanup = cleanupDeprecatedConfigKeys_();
  var configKeysAdded = seedConfigDefaults_();
  var seedRowsAdded = {
    POST_DISPLAY: seedPostDisplay_(),
    MERGE_GROUPS: seedMergeGroups_(),
    PROGRAM_TEMPLATES: seedProgramTemplates_(),
    EMAIL_TEMPLATES: seedEmailTemplates_(),
    FELLOWSHIP_DEFAULTS: seedFellowshipDefaults_()
  };

  var summary = {
    sheetsEnsured: sheetIds.length,
    configKeysAdded: configKeysAdded,
    configKeysRemoved: deprecatedCleanup.removed,
    deprecatedConfigWarnings: deprecatedCleanup.warnings,
    seedRowsAdded: seedRowsAdded
  };

  writeInitializeDiagnosticsReport_(summary);
  appendAuditLog_({
    action: 'INITIALIZE_ALL_SHEETS',
    notes: JSON.stringify(summary)
  });

  return summary;
}

/**
 * 用途：一次性清走已廢棄且沒有值的 Config 設定鍵。本專案第一次刪
 *   Config 鍵——目前只有 `DOC_TEMPLATE_ID_NORMAL`／`DOC_TEMPLATE_ID_COMBINED`
 *   兩個（第一輪為「Google Docs 範本 → PDF」而設，第七輪已改用
 *   `TEMPLATE_FILE_ID_*`，程式碼已無任何引用）。
 *
 *   ⚠️ 只有值為空字串才會刪：如果 Ivan 已經在這兩格填了值，代表這是有
 *   意義的資料，靜靜刪掉等於丟掉使用者的設定（見 docs/已知bug類型.md：
 *   刪 Config 鍵之前一定要確認沒有值）。值不為空時保留該行，回傳一則
 *   警告文字交由呼叫方寫進 Diagnostics 提醒人手確認。
 *
 *   刻意寫死鍵名字串，不透過 `CONFIG_KEYS`——這兩個鍵已經從
 *   `CONFIG_KEYS` 移除，這裡是它們在程式碼裡最後一次出現，純粹是為了
 *   清理已經寫入試算表的舊資料。
 * Args: （無）
 * Returns:
 *   {{removed:string[], warnings:string[]}} `removed` 是實際被刪除的設定
 *     鍵；`warnings` 是值不為空、因此保留但需要人手確認的提示文字。
 */
function cleanupDeprecatedConfigKeys_() {
  var DEPRECATED_KEYS = ['DOC_TEMPLATE_ID_NORMAL', 'DOC_TEMPLATE_ID_COMBINED'];

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ensureSheet_(ss, 'CONFIG');
  var lastRow = sheet.getLastRow();
  var removed = [];
  var warnings = [];

  if (lastRow < 3) return { removed: removed, warnings: warnings };

  var values = sheet.getRange(3, 1, lastRow - 2, 2).getValues();
  var rowsToDelete = [];

  values.forEach(function (row, idx) {
    var key = coerceConfigRawValue_(row[0]);
    if (DEPRECATED_KEYS.indexOf(key) === -1) return;

    var value = coerceConfigRawValue_(row[1]);
    var rowNo = idx + 3;

    if (value === '') {
      rowsToDelete.push(rowNo);
      removed.push(key);
      appendAuditLog_({
        action: 'CONFIG_KEY_REMOVE', sheetName: SHEETS.CONFIG,
        rowKey: key, field: 'KEY',
        oldValue: key, newValue: '',
        notes: '一次性清理：已廢棄的設定鍵，值為空，自動刪除。'
      });
    } else {
      warnings.push('設定鍵「' + key + '」已廢棄但仍有值（' + value + '），請人手確認後刪除。');
    }
  });

  // 由大到小刪，避免刪除之後行號往前移動，影響尚未處理的行號。
  rowsToDelete.sort(function (a, b) { return b - a; }).forEach(function (rowNo) {
    sheet.deleteRow(rowNo);
  });

  if (rowsToDelete.length > 0) clearConfigCache_();

  return { removed: removed, warnings: warnings };
}

/**
 * 用途：如果 _README 工作表還沒有任何內容，寫入說明每張工作表用途的文字。
 *   已經有內容就不覆寫——可能是 Ivan 自己補充過的版本，符合「已存在的
 *   工作表只驗證／補回標題，不清空資料」的冪等原則。
 * Args:
 *   ss {Spreadsheet} 目標試算表。
 * Returns:
 *   {number} 本次新增的行數（0 代表已經有內容，略過）。
 */
function writeReadmeContent_(ss) {
  var sheet = ss.getSheetByName(SHEETS.README);
  if (sheet.getLastRow() >= 3) return 0;

  var rows = readmeContentLines_().map(function (line) { return { TEXT: line }; });
  writeSheet(SHEETS.README, rows);
  return rows.length;
}

/**
 * 用途：_README 工作表的內容，逐行對應一個資料列。書面語繁體中文。寫成
 *   函式而不是頂層 var，是因為 Apps Script 按檔名字母序執行每個 .gs 的
 *   頂層陳述式——頂層 var 的內容在「被賦值那一刻」就固定下來，如果賦值式
 *   引用了另一個檔案宣告的識別碼，而那個檔案排在後面，讀到的就是
 *   undefined。函式主體只在被呼叫時才求值，那時全部檔案都已經載入完畢，
 *   所以一律用這個手法（詳見 docs/已知bug類型.md 的「跨檔案載入次序」）。
 *   這個函式本身沒有跨檔案參照，但為了跟其餘 seed 函式一致、也防止日後
 *   有人加內容時不小心引用到別的檔案，同樣採用延遲求值。
 * Args: （無）
 * Returns:
 *   {string[]} _README 的內容，一個陣列元素對應一行。
 */
function readmeContentLines_() {
  return [
  '本工作表列出「週報系統」內每一張工作表的用途，以及各表主要由人手填寫、還是由系統寫入。',
  '所有工作表的第 1 行是中文標題、第 2 行是程式使用的機器鍵，資料由第 3 行開始；請勿刪除或更改前兩行。',
  'Config：全系統參數設定，全部由人手填寫／修改。ID、電郵等敏感欄位預設留空，需要 Ivan 自行填入。',
  'BulletinWeeks：一個主日一行，記錄該週週報的全部內容欄位，以人手填寫為主；STATUS／DOC_ID／PDF_ID／LAST_GENERATED_AT／SENT_AT 等欄位由系統寫入。',
  'Announcements：家事報告內容，一個主日可以有多行（用次序排列），人手填寫。',
  'Prayers：代禱事項或宣教消息，一個主日可以有多行，人手填寫。',
  'Fellowships：本週團契聚會資訊，一個主日可以有多行，人手填寫。',
  'Finance：月度財政報告項目，人手填寫。',
  'PersonDisplay：會友姓名的尊稱與顯示覆寫規則。可以透過「由職事表建立 PersonDisplay 骨架」「套用尊稱對照表」選單自動建立與填入，也可以人手調整。',
  'HonorificLookup：Ivan 人手貼上的「姓名 → 尊稱」對照表，配合「套用尊稱對照表」選單使用，系統不會自動填入任何一行。',
  'FellowshipDefaults：團契聚會的常設時間表，配合「由常設時間表產生本季團契」選單使用；系統已預先填入三行，人手可調整。',
  'FillSnapshot：季度填寫表與 BulletinWeeks 做三方比對用的快照，系統寫，人手唯讀（不要人手改動，會令同步判斷出錯）。',
  'FillBackup：季度資料的版本備份，可以用「還原到某個備份」還原；保留數目見 Config 的 FILL_BACKUP_KEEP。',
  'Fill_<季度>：季度集中填寫表（例如 Fill_2027T4），一季一張，一行一個主日、一欄一個欄位；前三欄唯讀，其餘可填。用法見 docs/季度填寫表使用說明.md。',
  'PostDisplay：崗位在週報第 1、3 頁的顯示名稱、次序與合併規則，系統已預先填入 16 個崗位，日後如有調整由人手修改。',
  'MergeGroups：PostDisplay 使用的合併組定義（例如「主席及報告」「影音」），系統已預先填入，人手可調整連接符等設定。',
  'ProgramTemplates：崇拜程序範本，系統已預先填入平常主日／浸禮聯合崇拜／堂慶聯合崇拜三個範本，人手可視需要增補其他範本。',
  'Recipients：週報收件人名單（堂委 CC、執事 DB、幹事 ADMIN、IT、領詩 WORSHIP），系統不會自動填入任何一行，需要 Ivan 自行填寫。',
  'EmailTemplates：寄送週報用的電郵範本，系統已預先填入兩個預設範本（每週寄送、發佈通知），人手可修改文字內容。',
  'Diagnostics：系統唯讀診斷報告存放處，每次執行會清空重寫，只保留最新一次的內容，行數上限見 Config 的 DIAGNOSTICS_MAX_ROWS。',
  'AuditLog：系統對試算表所做的每一次寫入異動記錄，逐格記錄，只會新增、不會刪除或覆寫。',
  'SendLog：每一次寄送週報的記錄（含 DRY_RUN 試行的記錄），只會新增、不會刪除或覆寫。',
  'PublishLog：每一次發佈的記錄（主日、第幾版、發佈人、存檔副本、是否強制發佈），全部由系統寫入；人手改一行只會令版本號與實際發佈對不上。',
  '本系統對「粵語堂職事表」試算表一律唯讀，不會寫入任何一格；職事表的連線設定同樣在 Config 內填寫。'
  ];
}

/**
 * 用途：把本次 initializeAllSheets() 的執行摘要，連同 readSheet() 累積的
 *   型別警告（例如某個文字欄位被 Sheets 誤判成日期），寫入 Diagnostics。
 * Args:
 *   summary {Object} initializeAllSheets() 組出的摘要物件。
 * Returns:
 *   {void}
 */
function writeInitializeDiagnosticsReport_(summary) {
  var lines = [];
  lines.push('執行時間：' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss'));
  lines.push('已建立／確認工作表數：' + summary.sheetsEnsured);
  lines.push('Config 新增設定鍵：' + summary.configKeysAdded);
  if (summary.configKeysRemoved && summary.configKeysRemoved.length > 0) {
    lines.push('Config 一次性清理刪除的廢棄設定鍵：' + summary.configKeysRemoved.join('、'));
  }
  if (summary.deprecatedConfigWarnings && summary.deprecatedConfigWarnings.length > 0) {
    lines.push('');
    lines.push('廢棄設定鍵仍有值，需要人手確認（' + summary.deprecatedConfigWarnings.length + ' 筆）：');
    summary.deprecatedConfigWarnings.forEach(function (w) { lines.push('－' + w); });
  }
  Object.keys(summary.seedRowsAdded).forEach(function (id) {
    lines.push(SHEETS[id] + ' 新增行數：' + summary.seedRowsAdded[id]);
  });

  var warnings = getSheetUtilsTypeWarnings_();
  if (warnings.length > 0) {
    lines.push('');
    lines.push('型別警告（' + warnings.length + ' 筆，通常代表某個文字欄位被 Sheets 誤判成日期）：');
    warnings.forEach(function (w) {
      lines.push('－［' + w.sheet + '］第 ' + w.row + ' 行、欄位「' + w.key + '」：' + w.message);
    });
    clearSheetUtilsTypeWarnings_();
  }

  writeDiagnosticsReport_('初始化工作表', lines);
}

// =====================================================================
// Seed：把固定資料補進尚未有該資料的工作表（比對唯一鍵，只新增缺少的）
// =====================================================================

/**
 * 用途：把 seedPostDisplayRows_() 回傳的資料內尚未存在的 POST_ID 補進
 *   PostDisplay 工作表。
 * Args: （無）
 * Returns:
 *   {number} 新增的行數。
 */
function seedPostDisplay_() {
  return seedMissingRows_(SHEETS.POST_DISPLAY, 'POST_ID', seedPostDisplayRows_());
}

/**
 * 用途：把 seedMergeGroupsRows_() 回傳的資料內尚未存在的 GROUP_ID 補進
 *   MergeGroups 工作表。
 * Args: （無）
 * Returns:
 *   {number} 新增的行數。
 */
function seedMergeGroups_() {
  return seedMissingRows_(SHEETS.MERGE_GROUPS, 'GROUP_ID', seedMergeGroupsRows_());
}

/**
 * 用途：把 seedProgramTemplatesRows_() 回傳的資料內尚未存在的
 *   （TEMPLATE_ID, SEQ_NO）組合補進 ProgramTemplates 工作表。用複合鍵是
 *   因為同一個 TEMPLATE_ID 底下有多行（每個程序項目一行）。
 * Args: （無）
 * Returns:
 *   {number} 新增的行數。
 */
function seedProgramTemplates_() {
  return seedMissingRows_(SHEETS.PROGRAM_TEMPLATES, ['TEMPLATE_ID', 'SEQ_NO'], seedProgramTemplatesRows_());
}

/**
 * 用途：把 seedEmailTemplatesRows_() 回傳的資料內尚未存在的 TEMPLATE_ID
 *   補進 EmailTemplates 工作表。
 * Args: （無）
 * Returns:
 *   {number} 新增的行數。
 */
function seedEmailTemplates_() {
  return seedMissingRows_(SHEETS.EMAIL_TEMPLATES, 'TEMPLATE_ID', seedEmailTemplatesRows_());
}

/**
 * 用途：把 seedFellowshipDefaultsRows_() 回傳的資料內尚未存在的
 *   FELLOWSHIP_NAME 補進 FellowshipDefaults 工作表。
 * Args: （無）
 * Returns:
 *   {number} 新增的行數。
 */
function seedFellowshipDefaults_() {
  return seedMissingRows_(SHEETS.FELLOWSHIP_DEFAULTS, 'FELLOWSHIP_NAME', seedFellowshipDefaultsRows_());
}

/**
 * 用途：通用的「補齊缺少的 seed 行」邏輯。用一個或多個機器鍵組成唯一識別，
 *   只新增工作表目前沒有的組合；已存在的一律不覆蓋、不重覆新增，確保
 *   initializeAllSheets() 可以重複執行而不會產生重複資料。
 * Args:
 *   sheetName {string} 工作表名稱。
 *   uniqueKey {(string|string[])} 用來判斷「是否已存在」的機器鍵，可以是
 *     單一鍵或複合鍵（陣列）。
 *   seedRows {Object[]} 完整的 seed 資料（以機器鍵為 key 的物件陣列）。
 * Returns:
 *   {number} 實際新增的行數。
 */
function seedMissingRows_(sheetName, uniqueKey, seedRows) {
  var keyFields = Array.isArray(uniqueKey) ? uniqueKey : [uniqueKey];
  var existing = readSheet(sheetName);

  var existingCompositeKeys = {};
  existing.forEach(function (row) {
    existingCompositeKeys[buildCompositeKey_(row, keyFields)] = true;
  });

  var missing = seedRows.filter(function (row) {
    return !existingCompositeKeys[buildCompositeKey_(row, keyFields)];
  });
  if (missing.length === 0) return 0;

  writeSheet(sheetName, missing);
  return missing.length;
}

/**
 * 用途：把一個資料列的指定欄位組成一個字串鍵，供 seedMissingRows_() 判斷
 *   「是否已存在」用。
 * Args:
 *   row {Object} 以機器鍵為 key 的資料列。
 *   keyFields {string[]} 要組合的機器鍵，依序組合。
 * Returns:
 *   {string} 組合後的鍵，欄位之間用直線字元分隔。本專案的機器鍵與 SEQ_NO
 *     一律不含直線字元，不會與分隔符衝突。
 */
function buildCompositeKey_(row, keyFields) {
  return keyFields.map(function (f) { return String(row[f]); }).join('|');
}

// =====================================================================
// Seed 資料的建構小工具——純粹減少重複打字，不含業務邏輯。
// =====================================================================

/**
 * 用途：組出一行 PostDisplay 的 seed 資料。
 * Args:
 *   postId {string} POST_ID（對應職事表 Posts 的崗位 ID）。
 *   page1Name {string} 第 1 頁顯示名稱。
 *   page1Order {number} 第 1 頁次序。
 *   page1Show {boolean} 第 1 頁是否顯示。
 *   page1Merge {string} 第 1 頁合併組 ID，沒有就傳 ''。
 *   page3Name {string} 第 3 頁顯示名稱。
 *   page3Order {number} 第 3 頁次序。
 *   page3Show {boolean} 第 3 頁是否顯示。
 *   page3Merge {string} 第 3 頁合併組 ID，沒有就傳 ''。
 *   notes {string=} 備註，選填。
 * Returns:
 *   {Object} 以 PostDisplay 機器鍵為 key 的資料列，ACTIVE 固定 true。
 */
function postDisplayRow_(postId, page1Name, page1Order, page1Show, page1Merge, page3Name, page3Order, page3Show, page3Merge, notes) {
  return {
    POST_ID: postId,
    PAGE1_NAME: page1Name,
    PAGE1_ORDER: page1Order,
    SHOW_ON_PAGE1: page1Show,
    PAGE1_MERGE_GROUP: page1Merge || '',
    PAGE3_NAME: page3Name,
    PAGE3_ORDER: page3Order,
    SHOW_ON_PAGE3: page3Show,
    PAGE3_MERGE_GROUP: page3Merge || '',
    ACTIVE: true,
    NOTES: notes || ''
  };
}

/**
 * 用途：組出一行 ProgramTemplates 的 seed 資料。CONTENT_VALUE 這一輪固定
 *   是空字串（三個 seed 範本都沒有用到 STATIC 內容來源）。
 * Args:
 *   templateId {string} TEMPLATE_ID。
 *   seq {number} SEQ_NO。
 *   itemName {string} 程序項目名稱。
 *   contentSource {string} CONTENT_SOURCE 取值。
 *   posture {string} POSTURE 取值（POSTURE 列舉之一）。
 *   fullWidth {boolean} 是否整行。
 *   condition {string} CONDITION 取值。
 *   notes {string=} 備註，選填。
 * Returns:
 *   {Object} 以 ProgramTemplates 機器鍵為 key 的資料列，ACTIVE 固定 true。
 */
function programRow_(templateId, seq, itemName, contentSource, posture, fullWidth, condition, notes) {
  return {
    TEMPLATE_ID: templateId,
    SEQ_NO: seq,
    ITEM_NAME: itemName,
    CONTENT_SOURCE: contentSource,
    CONTENT_VALUE: '',
    POSTURE: posture,
    FULL_WIDTH: fullWidth,
    CONDITION: condition,
    ACTIVE: true,
    NOTES: notes || ''
  };
}

// =====================================================================
// Seed 資料本體
// =====================================================================

/**
 * 用途：PostDisplay 的 16 個固定崗位（見 docs/工作表結構.md）。寫成函式
 *   延遲求值——理由見 readmeContentLines_() 的說明。這裡呼叫的
 *   postDisplayRow_() 是本檔案自己的函式，不是跨檔案參照，但統一用函式
 *   包起來比較不容易在日後修改時不小心引入跨檔案的頂層參照。
 * Args: （無）
 * Returns:
 *   {Object[]} PostDisplay 的 seed 資料列。
 */
function seedPostDisplayRows_() {
  return [
  postDisplayRow_('CHAIR', '主席', 10, true, 'MG_CHAIR_ANNOUNCE', '主席', 10, true, '',
    '第 1 頁與 ANNOUNCE 合併顯示為「主席及報告」（同一人擔任兩個崗位時才合併）；第 3 頁不合併，各自顯示。'),
  postDisplayRow_('ANNOUNCE', '報告', 20, true, 'MG_CHAIR_ANNOUNCE', '報告', 20, true, '',
    '第 1 頁與 CHAIR 合併顯示為「主席及報告」（同一人擔任兩個崗位時才合併）；第 3 頁不合併，各自顯示。'),
  postDisplayRow_('PREACHER', '講員', 30, true, '', '講員', 30, true, ''),
  postDisplayRow_('SCRIPTURE', '讀經', 40, true, '', '讀經', 40, true, ''),
  postDisplayRow_('WORSHIP', '領詩', 50, true, '', '領詩', 50, true, ''),
  postDisplayRow_('PIANO', '司琴', 60, true, '', '司琴', 60, true, ''),
  postDisplayRow_('DEACON', '當值堂委', 70, true, '', '當值堂委', 120, true, ''),
  postDisplayRow_('VIDEO', '錄影', 80, true, '', '錄影', 90, true, ''),
  postDisplayRow_('SOUND', '影音', 90, true, 'MG_AV', '影音', 80, true, 'MG_AV',
    '與 PPT 合併顯示為「影音」一格（不要求同一人）。'),
  postDisplayRow_('PPT', '影音', 91, true, 'MG_AV', '影音', 81, true, 'MG_AV',
    '與 SOUND 合併顯示為「影音」一格（不要求同一人）。'),
  postDisplayRow_('USHER', '司事', 100, true, '', '司事', 70, true, ''),
  postDisplayRow_('TRANSLATOR', '翻譯', 110, true, '', '翻譯', 110, true, ''),
  postDisplayRow_('COMMUNION', '聖餐輔禮', 120, true, '', '聖餐輔禮', 130, true, '',
    '職事表的崗位名稱是「聖餐襄禮」，週報一律顯示為「聖餐輔禮」。'),
  postDisplayRow_('TRAFFIC', '交通指揮', 130, false, '', '交通指揮', 100, true, ''),
  postDisplayRow_('COUNT', '司數', 140, false, '', '司數', 105, true, ''),
  postDisplayRow_('FLOWER', '獻花', 150, false, '', '獻花', 140, false, '',
    '第 1、3 頁事奉框皆不顯示；由 BulletinWeeks 的 FLOWER_THIS_WEEK／FLOWER_NEXT_WEEK 在第 3 頁另起一行處理。')
  ];
}

/**
 * 用途：MergeGroups 的 2 個固定合併組。寫成函式延遲求值——理由見
 *   readmeContentLines_() 的說明。
 * Args: （無）
 * Returns:
 *   {Object[]} MergeGroups 的 seed 資料列。
 */
function seedMergeGroupsRows_() {
  return [
    { GROUP_ID: 'MG_CHAIR_ANNOUNCE', DISPLAY_NAME: '主席及報告', JOIN_SEPARATOR: ' ', MERGE_ONLY_IF_SAME_PERSON: true, ACTIVE: true, NOTES: '' },
    { GROUP_ID: 'MG_AV', DISPLAY_NAME: '影音', JOIN_SEPARATOR: ' ', MERGE_ONLY_IF_SAME_PERSON: false, ACTIVE: true, NOTES: '' }
  ];
}

/**
 * 用途：ProgramTemplates 的 3 個固定範本：
 *   TPL_NORMAL（平常主日，同時涵蓋聖餐主日與祈禱會週）
 *   TPL_COMBINED_BAPTISM（浸禮三堂聯合崇拜，待核對，欠 2025-10-05 樣本）
 *   TPL_ANNIVERSARY（堂慶三堂聯合崇拜，基於 TPL_NORMAL 調整）
 *
 *   寫成函式延遲求值是**必要**的，不只是風格一致：這裡面用到
 *   `POSTURE.STAND`／`CONDITION_TYPE.ALWAYS` 等 Constants.gs 宣告的常數。
 *   Apps Script 按檔名字母序（Bootstrap 排在 Constants 前面）執行頂層
 *   陳述式，如果這裡仍然是頂層 var，執行到這裡的時候 POSTURE 還是
 *   undefined，讀 `.STAND` 會直接拋 TypeError，導致整個專案載入失敗、
 *   onOpen() 完全沒有機會執行（本檔案就是這個 bug 的事故現場，
 *   詳見 docs/已知bug類型.md）。
 * Args: （無）
 * Returns:
 *   {Object[]} ProgramTemplates 的 seed 資料列，共 45 行。
 */
function seedProgramTemplatesRows_() {
  return [
  // ---- TPL_NORMAL ----
  programRow_('TPL_NORMAL', 10, '序樂', 'FIELD:PRELUDE', POSTURE.STAND, false, CONDITION_TYPE.ALWAYS),
  programRow_('TPL_NORMAL', 20, '宣召', 'FIELD:CALL_TEXT', POSTURE.STAND, false, CONDITION_TYPE.ALWAYS),
  programRow_('TPL_NORMAL', 30, '祈禱', 'BLANK', POSTURE.STAND, false, CONDITION_TYPE.ALWAYS),
  programRow_('TPL_NORMAL', 40, '誦讀', 'AUTO:RECITATION', POSTURE.STAND, false, CONDITION_TYPE.ALWAYS),
  programRow_('TPL_NORMAL', 50, '詩歌頌讚', 'FIELD:HYMN_PRAISE', POSTURE.SIT, false, CONDITION_TYPE.ALWAYS),
  programRow_('TPL_NORMAL', 60, '詩班頌唱', 'FIELD:CHOIR_TITLE', POSTURE.SIT, false, 'IF_FIELD:CHOIR_TITLE'),
  programRow_('TPL_NORMAL', 70, '讀經', 'FIELD:SCRIPTURE_REF', POSTURE.SIT, false, CONDITION_TYPE.ALWAYS),
  programRow_('TPL_NORMAL', 80, '證道', 'FIELD:SERMON_TITLE', POSTURE.SIT, false, CONDITION_TYPE.ALWAYS),
  programRow_('TPL_NORMAL', 90, '回應詩歌', 'FIELD:RESPONSE_HYMN', POSTURE.SIT, false, CONDITION_TYPE.ALWAYS),
  programRow_('TPL_NORMAL', 100, '聖餐', 'BLANK', POSTURE.SIT, false, 'WEEK_IN:1'),
  programRow_('TPL_NORMAL', 110, '三一頌', 'BLANK', POSTURE.STAND, false, CONDITION_TYPE.ALWAYS),
  programRow_('TPL_NORMAL', 120, '祝福', 'BLANK', POSTURE.STAND, false, CONDITION_TYPE.ALWAYS),
  programRow_('TPL_NORMAL', 130, '阿們頌', 'BLANK', POSTURE.STAND, false, CONDITION_TYPE.ALWAYS),
  programRow_('TPL_NORMAL', 140, '家事報告', 'BLANK', POSTURE.SIT, false, CONDITION_TYPE.ALWAYS),
  programRow_('TPL_NORMAL', 150, '祈禱會', 'BLANK', POSTURE.NONE, true, 'WEEK_IN:2,4'),

  // ---- TPL_COMBINED_BAPTISM（⚠️ 待核對，欠 2025-10-05 樣本，見 docs/待補資料.md B1）----
  programRow_('TPL_COMBINED_BAPTISM', 10, '序樂', 'FIELD:PRELUDE', POSTURE.STAND, false, CONDITION_TYPE.ALWAYS,
    '待核對：整個 TPL_COMBINED_BAPTISM 範本欠 2025-10-05 實際樣本，見 docs/待補資料.md B1。'),
  programRow_('TPL_COMBINED_BAPTISM', 20, '宣召', 'FIELD:CALL_TEXT', POSTURE.STAND, false, CONDITION_TYPE.ALWAYS),
  programRow_('TPL_COMBINED_BAPTISM', 30, '祈禱', 'BLANK', POSTURE.STAND, false, CONDITION_TYPE.ALWAYS),
  programRow_('TPL_COMBINED_BAPTISM', 40, '詩歌頌讚', 'FIELD:HYMN_PRAISE', POSTURE.SIT, false, CONDITION_TYPE.ALWAYS),
  programRow_('TPL_COMBINED_BAPTISM', 50, '讀經', 'FIELD:SCRIPTURE_REF', POSTURE.SIT, false, CONDITION_TYPE.ALWAYS),
  programRow_('TPL_COMBINED_BAPTISM', 60, '證道', 'FIELD:SERMON_TITLE', POSTURE.SIT, false, CONDITION_TYPE.ALWAYS),
  programRow_('TPL_COMBINED_BAPTISM', 70, '見證', 'BLANK', POSTURE.SIT, false, CONDITION_TYPE.ALWAYS),
  programRow_('TPL_COMBINED_BAPTISM', 80, '浸禮', 'BLANK', POSTURE.SIT, false, CONDITION_TYPE.ALWAYS),
  programRow_('TPL_COMBINED_BAPTISM', 90, '入會禮', 'BLANK', POSTURE.SIT, false, CONDITION_TYPE.ALWAYS),
  programRow_('TPL_COMBINED_BAPTISM', 100, '孩童奉獻禮', 'BLANK', POSTURE.SIT, false, CONDITION_TYPE.NEVER,
    'CONDITION 設為 NEVER：保留崗位，目前不會出現。如某次浸禮主日確實安排孩童奉獻禮，把這一行的 CONDITION 改為 ALWAYS 即可啟用，不需要新增整行。'),
  programRow_('TPL_COMBINED_BAPTISM', 110, '詩班頌唱', 'FIELD:CHOIR_TITLE', POSTURE.SIT, false, 'IF_FIELD:CHOIR_TITLE'),
  programRow_('TPL_COMBINED_BAPTISM', 120, '聖餐', 'BLANK', POSTURE.SIT, false, CONDITION_TYPE.ALWAYS),
  programRow_('TPL_COMBINED_BAPTISM', 130, '祝福', 'BLANK', POSTURE.STAND, false, CONDITION_TYPE.ALWAYS),
  programRow_('TPL_COMBINED_BAPTISM', 140, '阿們頌', 'BLANK', POSTURE.STAND, false, CONDITION_TYPE.ALWAYS),
  programRow_('TPL_COMBINED_BAPTISM', 150, '贈禮', 'BLANK', POSTURE.SIT, false, CONDITION_TYPE.ALWAYS),
  programRow_('TPL_COMBINED_BAPTISM', 160, '家事報告', 'BLANK', POSTURE.SIT, false, CONDITION_TYPE.ALWAYS),
  programRow_('TPL_COMBINED_BAPTISM', 170, '拍照', 'BLANK', POSTURE.NONE, true, CONDITION_TYPE.ALWAYS),

  // ---- TPL_ANNIVERSARY（基於 TPL_NORMAL：刪去「誦讀」與「祈禱會」，「詩班頌唱」條件改為 ALWAYS）----
  programRow_('TPL_ANNIVERSARY', 10, '序樂', 'FIELD:PRELUDE', POSTURE.STAND, false, CONDITION_TYPE.ALWAYS,
    '本範本基於 TPL_NORMAL：刪去「誦讀」與「祈禱會」兩行，並把「詩班頌唱」的出現條件從 IF_FIELD:CHOIR_TITLE 改為 ALWAYS。'),
  programRow_('TPL_ANNIVERSARY', 20, '宣召', 'FIELD:CALL_TEXT', POSTURE.STAND, false, CONDITION_TYPE.ALWAYS),
  programRow_('TPL_ANNIVERSARY', 30, '祈禱', 'BLANK', POSTURE.STAND, false, CONDITION_TYPE.ALWAYS),
  programRow_('TPL_ANNIVERSARY', 50, '詩歌頌讚', 'FIELD:HYMN_PRAISE', POSTURE.SIT, false, CONDITION_TYPE.ALWAYS),
  programRow_('TPL_ANNIVERSARY', 60, '詩班頌唱', 'FIELD:CHOIR_TITLE', POSTURE.SIT, false, CONDITION_TYPE.ALWAYS),
  programRow_('TPL_ANNIVERSARY', 70, '讀經', 'FIELD:SCRIPTURE_REF', POSTURE.SIT, false, CONDITION_TYPE.ALWAYS),
  programRow_('TPL_ANNIVERSARY', 80, '證道', 'FIELD:SERMON_TITLE', POSTURE.SIT, false, CONDITION_TYPE.ALWAYS),
  programRow_('TPL_ANNIVERSARY', 90, '回應詩歌', 'FIELD:RESPONSE_HYMN', POSTURE.SIT, false, CONDITION_TYPE.ALWAYS),
  programRow_('TPL_ANNIVERSARY', 100, '聖餐', 'BLANK', POSTURE.SIT, false, 'WEEK_IN:1'),
  programRow_('TPL_ANNIVERSARY', 110, '三一頌', 'BLANK', POSTURE.STAND, false, CONDITION_TYPE.ALWAYS),
  programRow_('TPL_ANNIVERSARY', 120, '祝福', 'BLANK', POSTURE.STAND, false, CONDITION_TYPE.ALWAYS),
  programRow_('TPL_ANNIVERSARY', 130, '阿們頌', 'BLANK', POSTURE.STAND, false, CONDITION_TYPE.ALWAYS),
  programRow_('TPL_ANNIVERSARY', 140, '家事報告', 'BLANK', POSTURE.SIT, false, CONDITION_TYPE.ALWAYS)
  ];
}

/**
 * 用途：EmailTemplates 的 2 個固定範本，內文用書面語繁體中文與佔位符撰寫。
 *   寫成函式延遲求值——理由見 readmeContentLines_() 的說明。
 * Args: （無）
 * Returns:
 *   {Object[]} EmailTemplates 的 seed 資料列。
 */
function seedEmailTemplatesRows_() {
  return [
    seedPublishNoticeRow_(),
    {
      TEMPLATE_ID: 'TPL_WEEKLY_BULLETIN',
      SUBJECT: '{{ChurchName}}粵語堂週報 — {{ServiceDate}}',
      BODY: [
        '各位主內肢體：',
        '',
        '平安！',
        '',
        '隨函附上 {{ServiceDate}} 主日的{{ChurchName}}粵語堂週報，敬請查收。',
        '',
        '如發現資料有任何錯漏，請回覆此郵件告知，以便盡快更正。',
        '',
        '謝謝！',
        '',
        '粵語堂週報系統　敬上'
      ].join('\n'),
      ACTIVE: true,
      NOTES: ''
    }
  ];
}

/**
 * 用途：發佈通知（R-001）那一個 EmailTemplates 範本。
 *
 *   ⚠️ 抽成獨立函式、而不是寫在 `seedEmailTemplatesRows_()` 的陣列裏面，
 *   是因為 `findPublishEmailTemplate_()`（src/Publish.gs）在工作表找不到
 *   這個範本時，要用同一份內容作為退回值。兩處各寫一份的話，人手改了
 *   工作表那一行、之後範本又被停用，退回的內容就會跟先前寄出去的不一樣，
 *   而且沒有人會發現。
 *
 *   內文刻意寫明「這條連結固定不變」——會眾只要把它加入書籤，之後每個
 *   星期打開都是最新一期，不需要每週再寄一次新連結。
 * Args: （無）
 * Returns:
 *   {Object} EmailTemplates 的一行。
 */
function seedPublishNoticeRow_() {
  return {
    TEMPLATE_ID: PUBLISH_TEMPLATE_ID_,
    SUBJECT: '{{ChurchName}}粵語堂週報已發佈 — {{ServiceDate}}',
    BODY: [
      '各位主內肢體：',
      '',
      '平安！',
      '',
      '{{ServiceDate}} 主日的{{ChurchName}}粵語堂週報已經發佈，可以在以下連結閱讀：',
      '',
      '{{MasterLink}}',
      '',
      '這條連結固定不變，之後每星期打開都是最新一期，可以直接加入書籤。',
      '',
      '如發現資料有任何錯漏，請回覆此郵件告知，以便盡快更正。',
      '',
      '謝謝！',
      '',
      '粵語堂週報系統　敬上'
    ].join('\n'),
    ACTIVE: true,
    NOTES: '發佈通知（R-001）。{{MasterLink}} 是永遠不變的 master 連結，由系統代入。'
  };
}

/**
 * 用途：`FellowshipDefaults` 的 3 行常設時間表 seed 資料，取自實際樣本。
 *   寫成函式延遲求值——這裡用到 `CONDITION_TYPE`（Constants.gs 宣告），
 *   而 Bootstrap.gs 按檔名字母序排在 Constants.gs **前面**，寫成頂層
 *   常數會讀到 `undefined`（見 readmeContentLines_() 與
 *   docs/已知bug類型.md 事故一）。
 *
 *   ⚠️ 這三行是**起點，不是定案**——Ivan 之後自行調整。系統只會補缺行，
 *   不會覆蓋已存在的行，所以改完之後再撳「初始化工作表」也不會被蓋掉。
 * Args: （無）
 * Returns:
 *   {Object[]} FellowshipDefaults 的 seed 資料列。
 */
function seedFellowshipDefaultsRows_() {
  return [
    {
      FELLOWSHIP_NAME: '彼得團 (北岸 Albany Community Hub)',
      // 每個主日都有，第一個主日除外
      RECURRENCE: CONDITION_TYPE.WEEK_NOT_IN_PREFIX + '1',
      DAY_LABEL: '星期日',
      DAY_OFFSET: 0,
      TIME_TEXT: '4:30pm',
      DEFAULT_CONTENT: '講道分享',
      SORT_ORDER: 10,
      ACTIVE: true
    },
    {
      FELLOWSHIP_NAME: '以諾團 (歡迎子女在 18 歲以下的成人參加)',
      RECURRENCE: CONDITION_TYPE.WEEK_IN_PREFIX + '2',
      DAY_LABEL: '星期日',
      DAY_OFFSET: 0,
      TIME_TEXT: '1:45PM',
      DEFAULT_CONTENT: '查經',
      SORT_ORDER: 20,
      ACTIVE: true
    },
    {
      FELLOWSHIP_NAME: '喜樂團 (粵語長者)',
      RECURRENCE: CONDITION_TYPE.WEEK_IN_PREFIX + '2,4',
      // 聚會日是主日之後的星期五，所以偏移 5 天
      DAY_LABEL: '星期五',
      DAY_OFFSET: 5,
      TIME_TEXT: '10:00AM',
      DEFAULT_CONTENT: '團契聚會',
      SORT_ORDER: 30,
      ACTIVE: true
    }
  ];
}
