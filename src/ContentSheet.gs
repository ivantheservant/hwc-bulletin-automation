/**
 * ContentSheet.gs
 *
 * 每季一個「內容表」——一個**獨立的試算表**，放在 Shared Drive，交給堂委
 * 與執事輸入七項內容（家事報告、代禱事項、團契聚會、財政報告、崇拜人數、
 * 宣召出處、宣召經文）。實作 R-010／R-013／R-014／R-015。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 分層
 * ─────────────────────────────────────────────────────────────────────
 *
 *   - 本檔案：**結構與純函式**——每張分頁有咩欄、下拉選單有咩選項、
 *     樣本資料長咩樣、邀請信點寫。完全不碰 `DriveApp`／`openById()`。
 *   - `src/ContentSheetIo.gs`：全部 Drive 與跨試算表 IO，鎖死喺嗰一個檔案
 *     （見 `tools/lint-readonly-roster.js` 規則 1／3／4）。
 *
 * ⚠️ 這一階段**只做內容表本身**，唔做匯入（R-011／R-012 下一輪先做）。
 * 週報試算表現有的 `Announcements`／`Prayers`／`Fellowships`／`Finance`／
 * `BulletinWeeks` 五張表，這一輪**一個欄都冇改**。
 */

'use strict';

/** 內容表每張分頁的標題行數：第 1 行中文、第 2 行機器鍵，資料由第 3 行開始。 */
var CONTENT_SHEET_HEADER_ROWS_ = 2;

/** 資料由第幾行開始。 */
var CONTENT_SHEET_FIRST_DATA_ROW_ = CONTENT_SHEET_HEADER_ROWS_ + 1;

/** 每張分頁預留幾多行空白（連下拉選單），唔係只做到有資料嗰幾行。 */
var CONTENT_SHEET_BLANK_ROWS_ = 200;

/** `_說明` 分頁的名稱（第一張）。 */
var CONTENT_SHEET_INSTRUCTIONS_TAB_ = '_說明';

/**
 * 用途：內容表六張資料分頁的完整定義——**這是唯一真相來源**。分頁次序、
 *   欄位、邊幾欄要下拉選主日、邊幾欄要強制純文字、邊幾欄要自動換行，
 *   全部喺呢度定；建立、刷新、日後匯入都由呢一份衍生。
 *
 *   寫成函式延遲求值，唔依賴 `.gs` 載入次序（見 docs/已知bug類型.md 事故一）。
 *
 *   欄位說明：
 *     - `dateColumns`　要套「該季主日」下拉選單嘅機器鍵。
 *     - `attendanceDates`　`true` 代表下拉要**額外加該季第一個主日減七天**
 *       （崇拜人數表填嘅係崇拜當日，唔係週報日期）。
 *     - `plainTextColumns`　要 `setNumberFormat('@')` 強制純文字嘅機器鍵。
 *     - `wrapColumns`　要自動換行 ＋ 指定欄寬嘅機器鍵。
 *     - `activeKey`　「有效」欄嘅機器鍵（會套 TRUE／FALSE 下拉）。
 *     - `note`　凍結區下面嗰句灰色說明（會再接上負責人與截止日期）。
 *
 *   ⚠️ 分頁名稱嗰個屬性刻意叫 `tabName` 而唔係更短嗰個名——嗰個較短嘅
 *   屬性名啱啱好又係一個真實嘅頂層網域，`tools/scan-staged-secrets.js`
 *   會把字串串接裡嘅「物件.該屬性」誤判成網域而擋住 commit。同一個理由
 *   見 `src/BulletinModel.gs` 嘅 `fellowshipName`。
 * Args: （無）
 * Returns:
 *   {{tabName:string, headers:string[], keys:string[], dateColumns:string[],
 *     attendanceDates:boolean, plainTextColumns:string[],
 *     wrapColumns:{key:string,width:number}[], activeKey:string,
 *     note:string}[]}
 */
function contentSheetTabDefs_() {
  return [
    {
      tabName: '家事報告',
      headers: ['主日日期', '次序', '內容', '連續到', '有效'],
      keys: ['SERVICE_DATE', 'SEQ_NO', 'TEXT', 'REPEAT_UNTIL', 'ACTIVE'],
      // ⚠️ REPEAT_UNTIL 一樣要下拉選主日：連登到邊一個主日為止。
      dateColumns: ['SERVICE_DATE', 'REPEAT_UNTIL'],
      attendanceDates: false,
      plainTextColumns: [],
      wrapColumns: [{ key: 'TEXT', width: 600 }],
      activeKey: 'ACTIVE',
      note: '一個主日可以有多行，用「次序」排先後（10、20、30 咁跳號，方便中間插入）。'
        + '「連續到」＝要連登幾個星期嗰啲報告只需要輸入一次：喺「主日日期」填第一次出現嗰個主日，'
        + '喺「連續到」揀最後一次出現嗰個主日。留空＝只出現喺「主日日期」嗰一週。'
    },
    {
      tabName: '代禱事項',
      headers: ['主日日期', '次序', '內容', '連續到', '有效'],
      keys: ['SERVICE_DATE', 'SEQ_NO', 'TEXT', 'REPEAT_UNTIL', 'ACTIVE'],
      dateColumns: ['SERVICE_DATE', 'REPEAT_UNTIL'],
      attendanceDates: false,
      plainTextColumns: [],
      wrapColumns: [{ key: 'TEXT', width: 600 }],
      activeKey: 'ACTIVE',
      note: '欄位同「家事報告」完全一樣，「連續到」用法都一樣。'
    },
    {
      tabName: '團契聚會',
      headers: ['主日日期', '次序', '團契', '日期', '時間', '週會內容', '有效'],
      keys: ['SERVICE_DATE', 'SEQ_NO', 'NAME', 'DATE_TEXT', 'TIME_TEXT', 'CONTENT', 'ACTIVE'],
      dateColumns: ['SERVICE_DATE'],
      attendanceDates: false,
      // ⚠️「日期」「時間」係**文字**，唔係日期／時間格式。實際週報寫成
      // 「28/11 星期日」「4:30pm」「10:00AM」，一畀試算表自動轉換就變咗
      // 真正嘅 Date／Time，印出嚟完全唔同樣。
      plainTextColumns: ['DATE_TEXT', 'TIME_TEXT'],
      wrapColumns: [{ key: 'CONTENT', width: 400 }],
      activeKey: 'ACTIVE',
      note: '「日期」「時間」兩欄係**純文字**，照你想印出嚟嘅樣打就得'
        + '（例如「28/11 星期日」、「4:30pm」、「10:00AM」），系統唔會自動轉格式。'
    },
    {
      tabName: '財政報告',
      headers: ['主日日期', '次序', '報告標題', '項目', '欄一', '欄二', '欄三', '欄四', '有效'],
      keys: ['SERVICE_DATE', 'SEQ_NO', 'TITLE_OVERRIDE', 'ROW_LABEL', 'COL1', 'COL2', 'COL3', 'COL4', 'ACTIVE'],
      dateColumns: ['SERVICE_DATE'],
      attendanceDates: false,
      // 五個數字欄全部純文字：實際內容有 `$6.42`、`$3,491.40`、`--`。
      plainTextColumns: ['COL1', 'COL2', 'COL3', 'COL4'],
      wrapColumns: [{ key: 'ROW_LABEL', width: 220 }],
      activeKey: 'ACTIVE',
      note: '「報告標題」可以留空——留空時系統會用預設嘅「綜合收支財務報告」標題。'
        + '實際週報有兩種財政表輪流出現：綜合收支（四個數字欄都填）與特殊海外奉獻及慈惠基金'
        + '（**只填「欄一」「欄二」**，其餘留空）。五個數字欄都係純文字，可以直接打 $6.42、--。'
    },
    {
      tabName: '崇拜人數',
      headers: [
        '崇拜日期',
        '英語堂崇拜', '粵語堂東區崇拜', '粵語堂北岸崇拜', '華語堂崇拜',
        '英語堂祈禱會', '粵語堂東區祈禱會', '粵語堂北岸祈禱會', '華語堂祈禱會',
        '英語堂兒童', '粵語堂東區兒童', '粵語堂北岸兒童', '華語堂兒童',
        '有效'
      ],
      // ⚠️ 機器鍵沿用週報系統現有嘅 ATT_* 十二個鍵，次序一致——下一輪匯入
      // 就唔使任何對照表（多一層對照就多一個會唔同步嘅地方）。
      keys: [
        'SERVICE_DATE',
        'ATT_ENG_WORSHIP', 'ATT_CANE_WORSHIP', 'ATT_CANN_WORSHIP', 'ATT_MAN_WORSHIP',
        'ATT_ENG_PRAYER', 'ATT_CANE_PRAYER', 'ATT_CANN_PRAYER', 'ATT_MAN_PRAYER',
        'ATT_ENG_CHILD', 'ATT_CANE_CHILD', 'ATT_CANN_CHILD', 'ATT_MAN_CHILD',
        'ACTIVE'
      ],
      dateColumns: ['SERVICE_DATE'],
      // ⚠️ 崇拜人數填嘅係**崇拜當日**，唔係週報日期。週報自己會搵「該主日
      // 減七天」嗰一行。所以下拉要額外加該季第一個主日之前七天嗰個日期，
      // 否則該季第一期嘅人數無處可填。
      attendanceDates: true,
      plainTextColumns: [
        'ATT_ENG_WORSHIP', 'ATT_CANE_WORSHIP', 'ATT_CANN_WORSHIP', 'ATT_MAN_WORSHIP',
        'ATT_ENG_PRAYER', 'ATT_CANE_PRAYER', 'ATT_CANN_PRAYER', 'ATT_MAN_PRAYER',
        'ATT_ENG_CHILD', 'ATT_CANE_CHILD', 'ATT_CANN_CHILD', 'ATT_MAN_CHILD'
      ],
      wrapColumns: [],
      activeKey: 'ACTIVE',
      note: '⚠️ 「崇拜日期」係**崇拜當日**，唔係週報嗰個主日——週報自己會搵返「該主日減七天」嗰一行。'
        + '所以下拉入面會多咗該季第一個主日之前嗰個星期日。十二格都係純文字，可以打「--」、「前:5 / 後:120」。'
    },
    {
      tabName: '宣召',
      headers: ['主日日期', '宣召出處', '宣召經文', '有效'],
      keys: ['SERVICE_DATE', 'CALL_REF', 'CALL_TEXT', 'ACTIVE'],
      dateColumns: ['SERVICE_DATE'],
      attendanceDates: false,
      plainTextColumns: [],
      wrapColumns: [{ key: 'CALL_TEXT', width: 600 }],
      activeKey: 'ACTIVE',
      note: '一個主日一行。「宣召出處」例如「詩篇 100:1-2」，「宣召經文」係成段經文。'
    }
  ];
}

/**
 * 用途：內容表全部分頁嘅名稱，**次序就係實際分頁次序**（`_說明` 排第一）。
 * Args: （無）
 * Returns:
 *   {string[]}
 */
function contentSheetTabNames_() {
  return [CONTENT_SHEET_INSTRUCTIONS_TAB_].concat(
    contentSheetTabDefs_().map(function (d) { return d.tabName; })
  );
}

/**
 * 用途：解析 Config `CONTENT_SHEET_OWNERS`（格式 `分頁名稱=負責人`，逗號
 *   分隔）。純函式。
 * Args:
 *   raw {string} 原始設定值。
 * Returns:
 *   {Object<string,string>} 分頁名稱 → 負責人。格式不符嘅項目一律略過
 *     （唔拋錯——呢個係人手填嘅設定，一個打錯字唔應該令成個建立流程失敗）。
 */
function parseContentSheetOwners_(raw) {
  var out = {};
  String(raw || '').split(/[,，]/).forEach(function (part) {
    var pair = part.split('=');
    if (pair.length !== 2) return;
    var tab = pair[0].trim();
    var owner = pair[1].trim();
    if (tab && owner) out[tab] = owner;
  });
  return out;
}

/**
 * 用途：算出「崇拜人數」分頁下拉選單要用嘅日期清單——該季全部主日，
 *   **再加該季第一個主日之前七天**嗰一日。純函式。
 *
 *   ⚠️ 冇最後嗰一項嘅話，該季**第一期**週報嘅上週人數無處可填：嗰期要
 *   填嘅係上一季最後一個主日嘅人數。
 * Args:
 *   serviceDates {string[]} 該季全部主日，yyyy-MM-dd，已排序。
 * Returns:
 *   {string[]} 由細到大排序；`serviceDates` 為空時回空陣列。
 */
function contentSheetAttendanceDateOptions_(serviceDates) {
  var dates = (serviceDates || []).slice();
  if (dates.length === 0) return [];
  var firstMinus7 = addDaysToIsoDate_(dates[0], -7);
  return [firstMinus7].concat(dates);
}

/**
 * 用途：組出一張分頁凍結區下面嗰句灰色說明——分頁自己嘅說明 ＋ 負責人
 *   ＋ 截止日期。純函式。
 * Args:
 *   tabDef {Object} `contentSheetTabDefs_()` 其中一項。
 *   owners {Object<string,string>} `parseContentSheetOwners_()` 嘅輸出。
 *   deadlineNote {string} Config `CONTENT_SHEET_DEADLINE_NOTE`。
 * Returns:
 *   {string}
 */
function buildContentSheetTabNote_(tabDef, owners, deadlineNote) {
  var owner = (owners || {})[tabDef.tabName];
  var parts = [];
  parts.push('負責：' + (owner || '（未指定，請喺 Config 補上 CONTENT_SHEET_OWNERS）'));
  if (deadlineNote) parts.push(deadlineNote);
  parts.push(tabDef.note);
  return parts.join('　｜　');
}

/**
 * 用途：組出 `_說明` 分頁嘅全部文字行。純函式。
 * Args:
 *   input {{quarterId:string, serviceDates:string[], owners:Object<string,string>,
 *          deadlineNote:string, adminContact:string, seededSample:boolean}}
 *     `adminContact` 係幹事聯絡方法（由 Config 讀，唔可以寫死）；
 *     `seededSample` 為 true 時會多印一段講明首個主日嗰啲係樣本。
 * Returns:
 *   {string[]} 一行一個元素。
 */
function buildContentSheetInstructionLines_(input) {
  var lines = [];
  lines.push('週報內容表　' + input.quarterId);
  lines.push('');
  lines.push('呢個檔案係畀堂委、執事同幹事輸入週報內容用嘅。填好之後，幹事會喺週報系統撳「從內容表匯入」。');
  lines.push('');

  lines.push('【每張分頁由邊個負責】');
  contentSheetTabDefs_().forEach(function (def) {
    var owner = (input.owners || {})[def.tabName];
    lines.push('　' + def.tabName + '：' + (owner || '（未指定）'));
  });
  lines.push('');

  lines.push('【截止日期】');
  lines.push('　' + (input.deadlineNote || '（未設定）'));
  lines.push('');

  lines.push('【三條規則，請務必遵守】');
  lines.push('　1. **不要刪行。** 唔要嗰行，請將最後一欄「有效」改做 FALSE，唔好整行刪走——');
  lines.push('　   刪咗行之後，系統對唔返之前匯入過乜嘢。');
  lines.push('　2. **不要改第 1、2 行。** 第 1 行係中文標題、第 2 行係系統用嘅機器鍵，');
  lines.push('　   改咗其中一格，成張表就匯入唔到。資料由第 3 行開始填。');
  lines.push('　3. **日期只可以用下拉選單揀。** 手打嘅日期系統認唔到，會被拒絕。');
  lines.push('');

  lines.push('【本季主日（共 ' + (input.serviceDates || []).length + ' 個）】');
  (input.serviceDates || []).forEach(function (d) { lines.push('　' + d); });
  lines.push('');

  if (input.seededSample) {
    lines.push('【關於首個主日嗰幾行】');
    lines.push('　首個主日嘅資料係**樣本**，用嚟示範格式同長度。');
    lines.push('　確認格式之後，請自行修改，或者把「有效」改為 FALSE。');
    lines.push('');
  }

  lines.push('【有問題搵邊個】');
  lines.push('　' + (input.adminContact || '（未設定，請喺週報系統 Config 填 CONTENT_SHEET_ADMIN_CONTACT）'));

  return lines;
}

/**
 * 用途：組出「建立內容表時預填嘅樣本資料」。純函式。
 *
 *   ⚠️ 樣本一律填喺**該季第一個主日**，而且「有效」全部 `TRUE`——樣本要
 *   真係睇得到先有示範作用。`_說明` 會註明嗰幾行係樣本。
 *
 *   ⚠️ 樣本內容係**通用嘅教會用語**，冇任何真實姓名、電郵、日期——本 repo
 *   會公開上 GitHub（見 Constants.gs 檔頭嘅硬規則）。
 * Args:
 *   serviceDates {string[]} 該季全部主日，yyyy-MM-dd，已排序。
 * Returns:
 *   {Object<string,Object[]>} 分頁名稱 → 資料列陣列（以機器鍵為 key）。
 *     `serviceDates` 為空時回空物件。
 */
function buildContentSheetSampleRows_(serviceDates) {
  var dates = (serviceDates || []).slice();
  if (dates.length === 0) return {};

  var first = dates[0];
  // 「連續到」示範連登四週：冇咁多個主日就用最後嗰個，唔好指去一個唔存在嘅日期。
  var fourth = dates.length >= 4 ? dates[3] : dates[dates.length - 1];
  var attendanceDate = addDaysToIsoDate_(first, -7);

  var rows = {};

  rows['家事報告'] = [
    {
      SERVICE_DATE: first, SEQ_NO: 10, ACTIVE: true, REPEAT_UNTIL: '',
      TEXT: '熱烈歡迎來賓，請留下姓名、通訊地址和電話以便聯絡。'
    },
    {
      SERVICE_DATE: first, SEQ_NO: 20, ACTIVE: true, REPEAT_UNTIL: '',
      TEXT: '關顧部於下主日舉辦愛筵，請大家到司事枱報名，今天截止報名，歡迎會眾踴躍參加，'
        + '在這家裡共享午餐，分享主愛。費用：自由奉獻。注意：請自備餐具！'
    },
    {
      SERVICE_DATE: first, SEQ_NO: 30, ACTIVE: true, REPEAT_UNTIL: fourth,
      TEXT: '主日學課程：《信徒關係建立：個人》。日期：主日早上9:15 – 10:15（共4堂）；'
        + '導師：林立文牧師；對象：所有信徒。'
    }
  ];

  rows['代禱事項'] = [
    {
      SERVICE_DATE: first, SEQ_NO: 10, ACTIVE: true, REPEAT_UNTIL: '',
      TEXT: '為各堂申請浸禮、入會、轉會及孩童奉獻禮的肢體禱告，求主堅固他們的信心，'
        + '使他們更明白這些屬靈禮儀的意義，甘心將自己及兒女獻上歸主。'
    },
    {
      SERVICE_DATE: first, SEQ_NO: 20, ACTIVE: true, REPEAT_UNTIL: '',
      TEXT: '為身心靈軟弱的肢體禱告，求主施恩醫治，賜下平安與力量。'
    }
  ];

  rows['崇拜人數'] = [{
    SERVICE_DATE: attendanceDate, ACTIVE: true,
    ATT_ENG_WORSHIP: '57', ATT_CANE_WORSHIP: '156', ATT_CANN_WORSHIP: '25', ATT_MAN_WORSHIP: '43',
    ATT_ENG_PRAYER: '--', ATT_CANE_PRAYER: '8', ATT_CANN_PRAYER: '5', ATT_MAN_PRAYER: '15',
    ATT_ENG_CHILD: '27', ATT_CANE_CHILD: '--', ATT_CANN_CHILD: '5', ATT_MAN_CHILD: '10'
  }];

  rows['宣召'] = [{
    SERVICE_DATE: first, ACTIVE: true,
    CALL_REF: '詩篇 100:1-2',
    CALL_TEXT: '普天下當向耶和華歡呼！你們當樂意事奉耶和華，當來向他歌唱！'
  }];

  rows['財政報告'] = [
    {
      SERVICE_DATE: first, SEQ_NO: 10, ACTIVE: true, TITLE_OVERRIDE: '',
      ROW_LABEL: '奉獻收入', COL1: '42,150', COL2: '380,220', COL3: '375,000', COL4: '500,000'
    },
    {
      SERVICE_DATE: first, SEQ_NO: 20, ACTIVE: true, TITLE_OVERRIDE: '',
      ROW_LABEL: '支出總額', COL1: '38,900', COL2: '352,110', COL3: '360,000', COL4: '480,000'
    }
  ];

  rows['團契聚會'] = [];

  return rows;
}

/**
 * 用途：把內容表檔名樣式（Config `CONTENT_SHEET_NAME_PATTERN`）內嘅
 *   `{{QUARTER_ID}}` 換成實際季度。純函式。
 * Args:
 *   pattern {string} 樣式字串。
 *   quarterId {string} 季度 ID。
 * Returns:
 *   {string} 樣式為空時退回 `週報內容_<季度>`，唔會回一個空檔名。
 */
function buildContentSheetFileName_(pattern, quarterId) {
  var raw = String(pattern || '').trim();
  if (!raw) raw = '週報內容_{{QUARTER_ID}}';
  return raw.split('{{QUARTER_ID}}').join(String(quarterId || ''));
}

// =====================================================================
// ContentSheets 登記表（喺週報試算表）
// =====================================================================

/**
 * 用途：喺 `ContentSheets` 揾指定季度嗰一行。
 * Args:
 *   quarterId {string} 季度 ID。
 * Returns:
 *   {?Object} 找到嘅資料列（`ACTIVE` 唔係 true 嗰啲一律當冇）；冇就回 `null`。
 */
function findContentSheetRow_(quarterId) {
  var target = String(quarterId || '').trim();
  if (!target) return null;
  var matches = readSheet(SHEETS.CONTENT_SHEETS).filter(function (r) {
    return String(r.QUARTER_ID || '').trim() === target && r.ACTIVE === true;
  });
  return matches.length > 0 ? matches[matches.length - 1] : null;
}

/**
 * 用途：喺 `ContentSheets` 新增一行（建立咗新內容表之後）。
 * Args:
 *   entry {{quarterId:string, fileId:string, fileUrl:string}}
 * Returns:
 *   {void}
 */
function appendContentSheetRow_(entry) {
  writeSheet(SHEETS.CONTENT_SHEETS, [{
    QUARTER_ID: sanitizeCellText_(entry.quarterId),
    FILE_ID: sanitizeCellText_(entry.fileId),
    FILE_URL: sanitizeCellText_(entry.fileUrl),
    CREATED_AT: new Date(),
    LAST_IMPORTED_AT: '',
    INVITE_SENT_AT: '',
    ACTIVE: true
  }]);
}

/**
 * 用途：更新 `ContentSheets` 指定季度嗰一行嘅其中一個日期欄。
 *
 *   ⚠️ 用 `getRange().setValue()` 逐格寫，唔係整張重寫——呢張表可能同時
 *   有幾季嘅記錄，整張重寫會有覆蓋別人嘅風險。
 * Args:
 *   quarterId {string} 季度 ID。
 *   fieldKey {string} 要更新嘅機器鍵（例如 `'INVITE_SENT_AT'`）。
 *   value {*} 新值。
 * Returns:
 *   {boolean} 有冇真係揾到嗰一行並寫入。
 */
function updateContentSheetField_(quarterId, fieldKey, value) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEETS.CONTENT_SHEETS);
  if (!sheet) return false;

  var def = COLUMNS.CONTENT_SHEETS;
  var quarterCol = def.keys.indexOf('QUARTER_ID') + 1;
  var targetCol = def.keys.indexOf(fieldKey) + 1;
  if (quarterCol <= 0 || targetCol <= 0) return false;

  var lastRow = sheet.getLastRow();
  if (lastRow < CONTENT_SHEET_FIRST_DATA_ROW_) return false;

  var target = String(quarterId || '').trim();
  var values = sheet.getRange(CONTENT_SHEET_FIRST_DATA_ROW_, quarterCol,
    lastRow - CONTENT_SHEET_HEADER_ROWS_, 1).getValues();

  for (var i = values.length - 1; i >= 0; i--) {
    if (String(values[i][0] || '').trim() === target) {
      sheet.getRange(CONTENT_SHEET_FIRST_DATA_ROW_ + i, targetCol).setValue(value);
      return true;
    }
  }
  return false;
}

// =====================================================================
// 邀請信
// =====================================================================

/**
 * 用途：組出「寄出內容表連結」邀請信嘅 HTML 內文。純函式。
 * Args:
 *   input {{quarterId:string, fileUrl:string, serviceDates:string[],
 *          owners:Object<string,string>, deadlineNote:string,
 *          churchName:string}}
 * Returns:
 *   {string} HTML。
 */
function buildContentSheetInviteHtml_(input) {
  function esc(s) { return escapeHtmlEmail_(String(s === null || s === undefined ? '' : s)); }

  var parts = [];
  parts.push('<p>各位主內肢體：</p>');
  parts.push('<p>平安！' + esc(input.quarterId) + ' 季度嘅週報內容表已經開好，'
    + '麻煩各位喺截止日期之前填妥自己負責嗰幾張分頁。</p>');

  parts.push('<p><a href="' + esc(input.fileUrl) + '" style="font-size:16px;font-weight:bold;">'
    + '➜ 開啟 ' + esc(input.quarterId) + ' 週報內容表</a></p>');

  parts.push('<h3 style="margin:1.2em 0 0.4em;">每張分頁由邊個負責</h3>');
  parts.push('<table style="border-collapse:collapse;"><tbody>');
  contentSheetTabDefs_().forEach(function (def) {
    var owner = (input.owners || {})[def.tabName] || '（未指定）';
    parts.push('<tr>'
      + '<td style="border:1px solid #ccc;padding:4px 10px;">' + esc(def.tabName) + '</td>'
      + '<td style="border:1px solid #ccc;padding:4px 10px;">' + esc(owner) + '</td>'
      + '</tr>');
  });
  parts.push('</tbody></table>');

  parts.push('<h3 style="margin:1.2em 0 0.4em;">截止日期</h3>');
  parts.push('<p>' + esc(input.deadlineNote || '（未設定）') + '</p>');

  parts.push('<h3 style="margin:1.2em 0 0.4em;">本季主日（共 '
    + (input.serviceDates || []).length + ' 個）</h3>');
  parts.push('<p style="font-family:monospace;">'
    + (input.serviceDates || []).map(esc).join('　') + '</p>');

  parts.push('<p style="color:#8c231c;font-weight:bold;margin-top:1.2em;">'
    + '⚠️ 兩件事一定要注意：唔好刪行（唔要嗰行請將「有效」改做 FALSE），'
    + '唔好改頭兩行（第 1 行中文標題、第 2 行機器鍵）。'
    + '日期請用下拉選單揀，手打嘅系統認唔到。</p>');

  parts.push('<p style="color:#666;font-size:13px;">詳細說明喺內容表第一張分頁「'
    + esc(CONTENT_SHEET_INSTRUCTIONS_TAB_) + '」。</p>');

  return parts.join('\n');
}
