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
  var publishLogBackfill = backfillPublishLogMasterFileId_();
  var publishLogMd5Backfill = backfillPublishLogContentFingerprint_();
  var configKeysAdded = seedConfigDefaults_();
  // ⚠️ 一定要排在 seedConfigDefaults_() 之後：那一支只會補**沒有的**鍵，
  //    已經存在的一律不動，所以舊值要在這裏另外處理。
  var configUpgrades = upgradeSystemSeededDefaults_();
  var seedRowsAdded = {
    POST_DISPLAY: seedPostDisplay_(),
    MERGE_GROUPS: seedMergeGroups_(),
    PROGRAM_TEMPLATES: seedProgramTemplates_(),
    EMAIL_TEMPLATES: seedEmailTemplates_(),
    FELLOWSHIP_DEFAULTS: seedFellowshipDefaults_(),
    NUMBER_REGISTRY: seedNumberRegistry_()
  };

  var summary = {
    sheetsEnsured: sheetIds.length,
    configKeysAdded: configKeysAdded,
    configKeysRemoved: deprecatedCleanup.removed,
    deprecatedConfigWarnings: deprecatedCleanup.warnings,
    publishLogBackfill: publishLogBackfill,
    publishLogMd5Backfill: publishLogMd5Backfill,
    configUpgrades: configUpgrades,
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
 * 用途：把**系統自己種下的**過時預設值更新為現時的預設值。
 *
 *   ⚠️ **這一支是唯一一個會在初始化時改寫既有 Config 值的地方，所以它的
 *   邊界要寫得死死的**（docs/已知bug類型.md 事故四十三）：
 *
 *     1. **只准動白名單上的鍵**（`CONFIG_UPGRADABLE_DEFAULTS_`）。白名單以外
 *        的鍵，不論值是什麼，一格都不會碰。
 *     2. 白名單上的鍵，也**只有在現值仍然等於某一個「系統種過的舊預設值」**
 *        時才動。使用者自己揀的值一律不動——就算他刻意改回其中一個舊值也
 *        不動不了，因為分不出「使用者刻意選了它」與「系統當年種下它」。
 *        這個取捨是刻意的：寧可少更新一次，也不可以蓋走使用者的決定。
 *     3. 現值是**空白**的話一樣不動：空白代表使用者刻意清走，或者
 *        `seedConfigDefaults_()` 未跑過，兩種都不是「過時的舊預設值」。
 *     4. 每一次更新都寫 `AuditLog`，而且初始化完成的對話框會**逐條列出**
 *        「更新了哪個鍵、由什麼變成什麼」。
 *
 *   ⚠️ 為什麼要這麼小心：`Config` 一格被改就足以令正式輸出指向錯的地方，
 *   而外表完全看不出分別。`PUBLISHED_PDF_FILE_ID` 被換成沙盒檔案那一次，
 *   教會網站那條連結差一點就被沙盒 PDF 洗掉——所以「初始化會自動更新
 *   設定值」這種機制，範圍必須小到可以一眼數得完。
 * Args: （無）
 * Returns:
 *   {{upgrades:{key:string, from:string, to:string}[], skipped:Object[],
 *     lines:string[]}}
 *     `lines` 是給對話框／報告用的逐條說明；沒有任何更新時是空陣列。
 */
function upgradeSystemSeededDefaults_() {
  var upgrades = [];
  var skipped = [];

  CONFIG_UPGRADABLE_DEFAULTS_.forEach(function (rule) {
    var key = rule.key;
    var target = defaultConfigValueFor_(key);
    var current = String(getConfig(key, '') || '').trim();

    if (!target) {
      skipped.push({ key: key, current: current, reason: 'DEFAULTS 沒有這一個鍵的預設值。' });
      return;
    }
    if (current === target) return;                       // 已經是新值，不用做什麼
    if (!current) {
      skipped.push({
        key: key, current: current,
        reason: '現值是空白——空白代表刻意清走或者未種過，不是「過時的舊預設值」，所以不動。'
      });
      return;
    }
    if (rule.supersededValues.indexOf(current) === -1) {
      skipped.push({
        key: key, current: current,
        reason: '現值「' + current + '」不是系統種下的舊預設值（很可能是你自己改的），所以不動。'
      });
      return;
    }

    setConfig(key, target, '初始化工作表：更新系統種下的過時預設值');
    appendAuditLog_({
      action: 'CONFIG_UPGRADE_DEFAULT', sheetName: SHEETS.CONFIG,
      rowKey: key, field: 'VALUE', oldValue: current, newValue: target,
      notes: '系統自己種下的預設值已過時（' + rule.reason + '），自動更新。'
        + '⚠️ 只動白名單上的鍵，而且只在現值仍然等於舊預設值時才動；'
        + '使用者自己改過的值一律不會被碰。'
    });
    upgrades.push({ key: key, from: current, to: target });
  });

  return {
    upgrades: upgrades,
    skipped: skipped,
    lines: upgrades.map(function (u) {
      return '　' + u.key + '：「' + u.from + '」→「' + u.to + '」';
    })
  };
}


/**
 * 用途：由 `DEFAULTS` 取一個設定鍵的預設值。**純函式。**
 * Args:
 *   key {string} 設定鍵。
 * Returns:
 *   {string} 找不到回空字串。
 */
function defaultConfigValueFor_(key) {
  var found = DEFAULTS.filter(function (d) { return d.key === key; })[0];
  return found ? String(found.value) : '';
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
  // ⚠️ SEND_TARGET_OFFSET_DAYS（第一輪自測後廢棄）：它算的不是「下一個
  //    主日」，而是「假設今日是星期一的話下一個主日」——星期六跑會得出
  //    星期五。現在由 resolveNextSendSundayIso_() 直接數星期幾，這個鍵
  //    再沒有任何程式碼引用。見 docs/已知bug類型.md 事故三十。
  //    留一個沒有人讀的設定鍵在表上，比刪掉更危險：有人改了它，以為
  //    改到寄送日期，其實什麼都沒有發生。
  var DEPRECATED_KEYS = ['DOC_TEMPLATE_ID_NORMAL', 'DOC_TEMPLATE_ID_COMBINED',
    'SEND_TARGET_OFFSET_DAYS'];

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
  'NumberRegistry：不變量 I03 的登記表——每一個會在畫面顯示的數字登記一行，寫明它來自哪一支函式、對應哪一張表的什麼條件；自測機會按登記用另一條路徑重新數一次。系統已預先填入，人手可加備註。',
  'SelfTestState：自測機跑到哪一個情境的續跑狀態，系統寫，人手唯讀。',
  'SelfTestReport：自測機每一次執行的逐項結果（預期／實際／證據三欄分開），系統寫，人手唯讀。',
  'MonkeyLog：亂行機每一步的記錄，最重要的一欄是「走到這裏的完整步驟」——紅了要靠它重現，系統寫，人手唯讀。',
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
  var backfill = summary.publishLogBackfill;
  if (backfill && backfill.filled > 0) {
    lines.push('PublishLog 補寫歷史資料：' + backfill.filled + ' 行'
      + '（MASTER_FILE_ID 填 ' + (backfill.masterFileId ? maskFileId_(backfill.masterFileId) : '（空）')
      + '、IS_SELFTEST 填 FALSE）');
  }
  if (backfill && backfill.skipped > 0) {
    lines.push('PublishLog 有 ' + backfill.skipped + ' 行補寫不到（'
      + backfill.skipReason + '）——「補寫不到」不等於「沒問題」，請人手確認。');
  }

  var md5Backfill = summary.publishLogMd5Backfill;
  if (md5Backfill && md5Backfill.filled > 0) {
    lines.push('PublishLog 補寫內容指紋：' + md5Backfill.filled + ' 行'
      + '（⚠️ 指紋來自**存檔副本**，不是發佈當時直接記下的值）');
  }
  if (md5Backfill && md5Backfill.skipped > 0) {
    lines.push('PublishLog 有 ' + md5Backfill.skipped + ' 行補寫不到內容指紋'
      + '——「補寫不到」不等於「沒問題」，那幾行的 I06 會報「驗證不到」：');
    md5Backfill.skipReasons.forEach(function (reason) { lines.push('　－' + reason); });
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

/**
 * 用途：一次性補寫 `PublishLog` 兩個新欄位的歷史資料。
 *
 *   第二輪自測新增 `MASTER_FILE_ID`／`IS_SELFTEST` 兩欄。加欄之前的每一行
 *   都是**正式**發佈（自測機那時還未發佈過任何東西），所以：
 *     - `MASTER_FILE_ID` 填 `PUBLISHED_PDF_FILE_ID` 的現值；
 *     - `IS_SELFTEST` 填 `FALSE`。
 *
 *   ⚠️ **只補空白的格**。已經有值的行一律不動——重跑「初始化工作表」是
 *   常事，第二次跑不可以把真正的自測紀錄改成 `FALSE`。
 *
 *   ⚠️ `PUBLISHED_PDF_FILE_ID` 是空的時候（未建立 master 檔案）：
 *   `IS_SELFTEST` 照樣補 `FALSE`（那是確定的），但 `MASTER_FILE_ID`
 *   留空並在報告講明補寫不到——填一個空字串當成「已補寫」，等於把
 *   「不知道」記成「知道，是空的」。
 * Args: （無）
 * Returns:
 *   {{filled:number, skipped:number, masterFileId:string, skipReason:string}}
 */
function backfillPublishLogMasterFileId_() {
  var out = { filled: 0, skipped: 0, masterFileId: '', skipReason: '' };

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEETS.PUBLISH_LOG);
  if (!sheet) return out;

  var lastRow = sheet.getLastRow();
  if (lastRow < 3) return out;

  var def = COLUMNS.PUBLISH_LOG;
  var masterCol = def.keys.indexOf('MASTER_FILE_ID') + 1;
  var selfTestCol = def.keys.indexOf('IS_SELFTEST') + 1;
  if (masterCol <= 0 || selfTestCol <= 0) return out;

  var masterFileId = String(getConfig(CONFIG_KEYS.PUBLISHED_PDF_FILE_ID, '') || '').trim();
  out.masterFileId = masterFileId;

  var numRows = lastRow - 2;
  var masterValues = sheet.getRange(3, masterCol, numRows, 1).getValues();
  var selfTestValues = sheet.getRange(3, selfTestCol, numRows, 1).getValues();

  for (var i = 0; i < numRows; i++) {
    var rowNo = i + 3;
    var hasMaster = String(masterValues[i][0] || '').trim() !== '';
    var hasSelfTest = selfTestValues[i][0] !== '' && selfTestValues[i][0] !== null
      && selfTestValues[i][0] !== undefined;
    if (hasMaster && hasSelfTest) continue;

    if (!hasSelfTest) {
      sheet.getRange(rowNo, selfTestCol, 1, 1).setValue(false);
    }
    if (!hasMaster) {
      if (!masterFileId) {
        out.skipped++;
        continue;
      }
      setCellValueTextSafe_(sheet, def, rowNo, 'MASTER_FILE_ID', sanitizeCellText_(masterFileId));
    }
    out.filled++;
  }

  if (out.skipped > 0) {
    out.skipReason = 'Config 的 ' + CONFIG_KEYS.PUBLISHED_PDF_FILE_ID
      + ' 是空的，推不出這些歷史紀錄當時覆寫了哪一個檔案';
  }

  if (out.filled > 0 || out.skipped > 0) {
    appendAuditLog_({
      action: 'PUBLISH_LOG_BACKFILL', sheetName: SHEETS.PUBLISH_LOG,
      rowKey: '（整表）', field: 'MASTER_FILE_ID',
      oldValue: '', newValue: masterFileId ? maskFileId_(masterFileId) : '（空）',
      notes: '一次性補寫：加欄之前的發佈全部是正式發佈，IS_SELFTEST 填 FALSE。'
        + '補寫 ' + out.filled + ' 行，補寫不到 ' + out.skipped + ' 行。'
    });
  }

  return out;
}


/**
 * 用途：一次性補寫 `PublishLog` 的 `CONTENT_BYTES`／`CONTENT_MD5`——用該行
 *   `ARCHIVE_FILE_ID` 那一份**存檔副本**的實際指紋。
 *
 *   ⚠️ 這是一個**有前提的推斷**，前提要講出來：存檔副本是發佈那一刻由
 *   同一個 blob 存出來的，所以理論上與 master 相同。實測那一次兩邊的指紋
 *   完全一樣（`2007999:6e3f92…`）。
 *
 *   但它畢竟是**另一個檔案**。所以：
 *     - `NOTES` 與 `AuditLog` 都會註明「來自存檔副本」，不會扮成發佈當時
 *       直接記下的值；
 *     - 讀不到存檔副本的一律**留空**並報「補寫不到」——填一個猜出來的值，
 *       等於把「不知道」記成「知道」。
 *
 *   ⚠️ **只補空白的格**。已經有值的一律不動：重跑「初始化工作表」是常事，
 *   第二次跑不可以把真正的發佈指紋改成存檔副本的指紋。
 * Args: （無）
 * Returns:
 *   {{filled:number, skipped:number, skipReasons:string[]}}
 */
function backfillPublishLogContentFingerprint_() {
  var out = { filled: 0, skipped: 0, skipReasons: [] };

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEETS.PUBLISH_LOG);
  if (!sheet) return out;

  var rows = readSheet(SHEETS.PUBLISH_LOG);
  if (rows.length === 0) return out;

  var def = COLUMNS.PUBLISH_LOG;
  if (def.keys.indexOf('CONTENT_MD5') === -1) return out;

  rows.forEach(function (row, index) {
    if (publishRowFingerprint_(row)) return; // 已經有值，不動

    var rowNo = index + 3;
    var archiveFileId = String(row.ARCHIVE_FILE_ID || '').trim();
    var stamp = publishRowIsoDate_(row) + ' 第 ' + Number(row.VERSION_NO || 0) + ' 版';

    if (!archiveFileId) {
      out.skipped++;
      out.skipReasons.push(stamp + '：沒有 ARCHIVE_FILE_ID，推不出當時的內容指紋');
      return;
    }

    var bytes = readMasterPdfBytes_(archiveFileId);
    if (bytes === null) {
      out.skipped++;
      out.skipReasons.push(stamp + '：存檔副本（' + maskFileId_(archiveFileId) + '）讀不到');
      return;
    }

    var fingerprint = pdfFingerprint_(bytes);
    var parts = splitPdfFingerprint_(fingerprint);
    if (!parts.md5) {
      out.skipped++;
      out.skipReasons.push(stamp + '：存檔副本讀得到但算不到指紋');
      return;
    }

    setCellValueTextSafe_(sheet, def, rowNo, 'CONTENT_BYTES', parts.bytes);
    setCellValueTextSafe_(sheet, def, rowNo, 'CONTENT_MD5', sanitizeCellText_(parts.md5));
    out.filled++;

    appendAuditLog_({
      action: 'PUBLISH_LOG_BACKFILL_MD5', sheetName: SHEETS.PUBLISH_LOG,
      rowKey: publishRowIsoDate_(row), field: 'CONTENT_MD5',
      oldValue: '', newValue: fingerprint,
      notes: '一次性補寫：指紋**來自存檔副本**（' + maskFileId_(archiveFileId)
        + '），不是發佈當時直接記下的值。'
    });
  });

  return out;
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
      TEMPLATE_ID: 'PREVIEW_NOTICE',
      SUBJECT: '{{ChurchName}}粵語堂週報草稿預覽 — {{ServiceDate}}',
      BODY: [
        '各位主內肢體：',
        '',
        '平安！',
        '',
        '下一個主日（{{ServiceDate}}）的週報草稿預覽已經可以查看：',
        '',
        '{{PreviewUrl}}',
        '',
        '⚠️ 這是草稿預覽，版面與正式印刷版不同，只供核對內容。'
          + '如發現資料有錯漏，請回覆此郵件。',
        '',
        '這條連結固定不變，之後每星期打開都是最新一期，可以直接收藏。',
        '',
        '{{RosterPendingNote}}',
        '',
        '謝謝！',
        '',
        '粵語堂週報系統　敬上'
      ].join('\n'),
      ACTIVE: true,
      NOTES: 'R-033：星期一自動寄出的草稿預覽連結。'
        + '⚠️ {{PreviewUrl}} 是那條**固定不變**的連結（不帶日期＝永遠顯示下一個主日）；'
        + '{{RosterPendingNote}} 只在職事表未有該季資料時才有內容，其餘時候是空字串。'
    },
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
 * 用途：把 `seedNumberRegistryRows_()` 內尚未存在的 `REGISTRY_ID` 補進
 *   `NumberRegistry` 工作表。
 * Args: （無）
 * Returns:
 *   {number} 新增的行數。
 */
function seedNumberRegistry_() {
  return seedMissingRows_(SHEETS.NUMBER_REGISTRY, 'REGISTRY_ID', seedNumberRegistryRows_());
}

/**
 * 用途：`NumberRegistry` 的 seed 資料——**每一個會在畫面顯示的數字**
 *   登記一行，寫明它來自哪一支函式、對應哪一張工作表的什麼條件。
 *
 *   ⚠️ 這張表是不變量 I03 的「宣告」，真正兩條計算路徑寫在
 *   `numberRegistryProbes_()`（src/Invariants.gs）。兩邊的 `REGISTRY_ID`
 *   必須一一對應——**登記了但沒有實作、或者實作了但沒有登記，I03 都會
 *   報紅**。加新數字的時候兩邊都要動。
 *
 *   ⚠️ 「重新數的條件」那一欄是寫給人看的，不是程式讀的——程式讀的是
 *   `numberRegistryProbes_()` 內的 `recount`。兩者講的必須是同一件事，
 *   但沒有辦法靠程式保證；這是刻意的取捨：讓 Ivan 打開工作表就看得懂
 *   「這個數字應該怎樣數」，比多一層機器可讀的規則語言實際。
 *
 *   寫成函式延遲求值——理由見 `readmeContentLines_()` 的說明。
 * Args: （無）
 * Returns:
 *   {Object[]} NumberRegistry 的 seed 資料列。
 */
function seedNumberRegistryRows_() {
  return [
    {
      REGISTRY_ID: 'N01',
      DISPLAY_LOCATION: '「建立本季空白週報」對話框、季度填寫表標題',
      // ⚠️ 2026-08-27 由 listRosterServiceDatesForQuarter_() 改成這一支。
      //    R-036 之後，畫面那個數字不再一定來自職事表——職事表未有該季時
      //    改由曆法／BulletinWeeks 來。登記表寫著舊來源，就會令 I03 在沙盒
      //    季度永遠報「1 項對不上」。見 docs/待確認事項.md W-1。
      SOURCE_FUNCTION: 'resolveQuarterServiceDateEntries_()',
      SHEET_NAME: SHEETS.BULLETIN_WEEKS,
      RECOUNT_RULE: '數 BulletinWeeks 內 QUARTER_ID = 本季 的行數',
      ACTIVE: true,
      NOTES: '完全獨立**但只在職事表有這一季的時候**：那時 reported 走職事表 ServiceDates、'
        + 'recount 走本試算表。職事表未有這一季時兩路會變成同一個來源，一律報「不適用」'
        + '——自己對自己一定對得上，報綠等於講大話。'
    },
    {
      REGISTRY_ID: 'N02',
      DISPLAY_LOCATION: '填寫介面「家事報告」唯讀區塊、匯入報告',
      SOURCE_FUNCTION: 'pickWebAppListItems_(Announcements)',
      SHEET_NAME: SHEETS.ANNOUNCEMENTS,
      RECOUNT_RULE: '數 Announcements 內 SERVICE_DATE = 本主日 且 ACTIVE = TRUE 的行數',
      ACTIVE: true,
      NOTES: '完全獨立：兩邊的日期比對方式不同（一邊 rosterDateMatchesYMD_，一邊字串比對）'
    },
    {
      REGISTRY_ID: 'N03',
      DISPLAY_LOCATION: '填寫介面「代禱事項」唯讀區塊、匯入報告',
      SOURCE_FUNCTION: 'pickWebAppListItems_(Prayers)',
      SHEET_NAME: SHEETS.PRAYERS,
      RECOUNT_RULE: '數 Prayers 內 SERVICE_DATE = 本主日 且 ACTIVE = TRUE 的行數',
      ACTIVE: true,
      NOTES: '完全獨立（同 N02）'
    },
    {
      REGISTRY_ID: 'N04',
      DISPLAY_LOCATION: '填寫介面「團契聚會」唯讀區塊、匯入報告',
      SOURCE_FUNCTION: 'pickWebAppListItems_(Fellowships)',
      SHEET_NAME: SHEETS.FELLOWSHIPS,
      RECOUNT_RULE: '數 Fellowships 內 SERVICE_DATE = 本主日 且 ACTIVE = TRUE 的行數',
      ACTIVE: true,
      NOTES: '完全獨立（同 N02）'
    },
    {
      REGISTRY_ID: 'N05',
      DISPLAY_LOCATION: '寄出前的預覽、「已寄出 N 個收件人」',
      SOURCE_FUNCTION: 'buildRecipientList_()',
      SHEET_NAME: SHEETS.RECIPIENTS,
      RECOUNT_RULE: '數 Recipients 內 ACTIVE = TRUE 且 GROUP_NAME 屬於 SEND_GROUPS、電郵格式合法、去重之後的行數',
      ACTIVE: true,
      NOTES: '部分獨立：共用「合法電郵」與「去重」兩條規則，不共用篩選流程'
    },
    {
      REGISTRY_ID: 'N06',
      DISPLAY_LOCATION: '填寫介面頂部狀態列「目前已發佈：…（第 N 版）」',
      SOURCE_FUNCTION: 'latestPublishLogRow_().VERSION_NO',
      SHEET_NAME: SHEETS.PUBLISH_LOG,
      RECOUNT_RULE: '取 PublishLog 內該主日的最大 VERSION_NO',
      ACTIVE: true,
      NOTES: '完全獨立：一邊按 PUBLISHED_AT 排序取最新，一邊取該主日最大版本號'
    },
    {
      REGISTRY_ID: 'N07',
      DISPLAY_LOCATION: '「產生本週週報（Word）」對話框「偵測到 N 段文字出現兩次或以上」',
      SOURCE_FUNCTION: 'assertDocxBlob_().duplicateParagraphs.length',
      SHEET_NAME: '（產出的 .docx，不是工作表）',
      RECOUNT_RULE: '重新解壓成品，挖走文字方塊（mc:AlternateContent）之後逐段數，'
        + '長度 >= DUPLICATE_PARAGRAPH_MIN_CHARS 而且出現 >= 2 次的段落數目',
      ACTIVE: true,
      NOTES: 'R-032。⚠️ 這個數字的來源不是工作表，是**產出檔案本身**——'
        + '所以 I03 那一條兩路對數只能兩邊都掃同一份 blob，獨立性比其餘幾個低。'
        + '真正的獨立性來自「一路是渲染時算的、一路是回頭實掃成品」，'
        + '而這一項本來就只有實掃那一路，沒有渲染時的對應數字。'
        + '登記在這裏是為了讓它出現在報告與登記表上，不是為了兩路對數。'
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
