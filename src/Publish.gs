/**
 * Publish.gs
 *
 * 發佈及匯出（R-001 至 R-009）嘅業務邏輯：版本號、發佈前檢查、執行發佈、
 * 寄出通知、頂部狀態列。
 *
 * 分層：全部 Drive IO 喺 `src/PublishIo.gs`（嗰個檔案受 lint 特別管制），
 * 呢度只負責邏輯、讀寫本試算表、同 Config。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 核心設計：條連結點解永遠唔變
 * ─────────────────────────────────────────────────────────────────────
 *
 *   master 連結 = Shared Drive 入面**一個固定嘅 PDF 檔案**，權限「知道
 *   連結的人可檢視」。每次發佈**原地覆寫佢嘅內容**，檔案 ID 唔變，所以
 *   條連結永遠唔變，可以印上教會網站。
 *
 *   PDF 由幹事喺 Word 另存——Apps Script 轉唔到忠於版面嘅 PDF（週報用咗
 *   18 款字型、文字方塊同 A5 版面，轉 Google 文件會走樣）。呢一步刻意
 *   保留人手，順便多一道覆核：發佈出去嘅嘢一定有人親眼睇過。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ⚠️ 未填欄位只有一個真相來源
 * ─────────────────────────────────────────────────────────────────────
 *
 *   發佈前檢查嗰個「未填欄位」清單，一律由 `buildBulletinModel_()` 嘅
 *   `missing` 嚟——**唔可以喺呢度另寫一套判斷**。同一個狀態兩個真相來源，
 *   遲早會出現「填寫介面話填齊咗、發佈前檢查話仲差三項」呢種冇得解釋
 *   嘅情況（見 docs/已知bug類型.md 事故二十二嘅同一類問題）。
 */

'use strict';

/** 存檔副本檔名嘅格式。`{{SERVICE_DATE}}` 同 `{{VERSION_NO}}` 會被代入。 */
var PUBLISH_ARCHIVE_NAME_PATTERN_ = '{{SERVICE_DATE}}_粵語堂週報_v{{VERSION_NO}}.pdf';

/** `EmailTemplates` 入面發佈通知嗰個範本嘅鍵。 */
var PUBLISH_TEMPLATE_ID_ = 'PUBLISH_NOTICE';

/** `SendLog.STATUS` 入面代表「發佈通知」嗰個值。 */
var PUBLISH_SEND_STATUS_ = 'PUBLISH';

/** 「我自己」呢個收件選項嘅鍵。刻意唔係 `Recipients` 嘅組別名。 */
var PUBLISH_GROUP_SELF_ = 'SELF';

/**
 * ScriptProperties 內「某個主日最後一次成功發佈」嘅鍵前綴。
 *
 * ⚠️ 刻意**唔用 `PublishLog.PUBLISHED_AT`** 做防重複判斷：Sheets 讀返
 * 出嚟嘅日期會經過型別正規化，秒級精度唔可靠；而防重複要比嘅係「幾秒
 * 之內」。ScriptProperties 存一個純毫秒數，兩邊都冇歧義。
 */
var PUBLISH_LAST_KEY_PREFIX_ = 'PUBLISH_LAST|';

/** ScriptProperties 內「建立 master 時嗰個佔位 PDF」嘅指紋。 */
var PUBLISH_PLACEHOLDER_FINGERPRINT_KEY_ = 'PUBLISH_PLACEHOLDER_FINGERPRINT';

/** 攞指令碼鎖最多等幾多毫秒。 */
var PUBLISH_LOCK_WAIT_MS_ = 20000;

// =====================================================================
// Config
// =====================================================================

/**
 * 用途：一次過讀齊發佈要用嘅全部 Config。集中一處，方便測試，亦避免
 *   逐個函式各自讀（讀漏一個好難查）。
 * Args: （無）
 * Returns:
 *   {{masterFileId:string, masterFolderId:string, masterFileName:string,
 *     archiveFolderId:string, sendGroups:string[], attachPdf:boolean,
 *     maxPdfMb:number, dedupSec:number, timezone:string, dryRun:boolean,
 *     churchName:string}}
 */
function publishConfig_() {
  var maxMb = normalizeInt_(getConfig(CONFIG_KEYS.PUBLISH_MAX_PDF_MB, '10'));
  var dedupSec = normalizeInt_(getConfig(CONFIG_KEYS.PUBLISH_DEDUP_SEC, '30'));
  return {
    masterFileId: String(getConfig(CONFIG_KEYS.PUBLISHED_PDF_FILE_ID, '') || '').trim(),
    masterFolderId: String(getConfig(CONFIG_KEYS.PUBLISHED_PDF_FOLDER_ID, '') || '').trim(),
    masterFileName: getConfig(CONFIG_KEYS.PUBLISHED_PDF_NAME, '粵語堂週報（最新一期）.pdf'),
    archiveFolderId: String(getConfig(CONFIG_KEYS.PUBLISHED_ARCHIVE_FOLDER_ID, '') || '').trim(),
    sendGroups: getConfigTextList_(CONFIG_KEYS.PUBLISH_SEND_GROUPS, 'CC,DB,ADMIN'),
    attachPdf: normalizeBoolean_(getConfig(CONFIG_KEYS.PUBLISH_ATTACH_PDF, 'TRUE')) === true,
    maxPdfMb: (maxMb === null || maxMb <= 0) ? 10 : maxMb,
    dedupSec: (dedupSec === null || dedupSec < 0) ? 30 : dedupSec,
    timezone: getConfig(CONFIG_KEYS.SYS_TIMEZONE, 'Pacific/Auckland'),
    dryRun: normalizeBoolean_(getConfig(CONFIG_KEYS.DRY_RUN, 'TRUE')) === true,
    churchName: getConfig(CONFIG_KEYS.CHURCH_NAME, '')
  };
}

/**
 * 用途：由 master 檔案 ID 砌出三條連結。**純函式。**
 *
 *   三條各有用途：`view` 畀會眾撳、`preview` 畀網站直接嵌入 iframe、
 *   `download` 畀想存落電話嗰啲人。三條全部指住同一個檔案 ID。
 * Args:
 *   fileId {string} master 檔案 ID。
 * Returns:
 *   {{view:string, preview:string, download:string}} `fileId` 係空就三條
 *     都係空字串（顯示一條開唔到嘅連結，比唔顯示更差）。
 */
function masterPdfLinks_(fileId) {
  var id = String(fileId || '').trim();
  if (!id) return { view: '', preview: '', download: '' };
  return {
    view: 'https://drive.google.com/file/d/' + id + '/view',
    preview: 'https://drive.google.com/file/d/' + id + '/preview',
    download: 'https://drive.google.com/uc?export=download&id=' + id
  };
}

/**
 * 用途：砌存檔副本嘅檔名。**純函式。**
 * Args:
 *   isoDate {string} 主日日期，yyyy-MM-dd。
 *   versionNo {number} 版本號。
 * Returns:
 *   {string} 例如 `2027-11-07_粵語堂週報_v3.pdf`。
 */
function buildArchiveFileName_(isoDate, versionNo) {
  return PUBLISH_ARCHIVE_NAME_PATTERN_
    .replace('{{SERVICE_DATE}}', String(isoDate || ''))
    .replace('{{VERSION_NO}}', String(versionNo || 1));
}

// =====================================================================
// 上載 PDF 嘅驗證
// =====================================================================

/**
 * 用途：驗證上載嘅檔案真係一個 PDF、而且冇超過大小上限。**純函式。**
 *
 *   ⚠️ **唔可以用副檔名判斷**：檔名純粹係使用者打嘅字，改個 `.pdf` 就
 *   呃得過。真正嘅判斷係頭四個位元組 `%PDF`（0x25 0x50 0x44 0x46）——
 *   PDF 規格要求每個檔案都以呢四個字元開頭。
 *
 *   ⚠️ Apps Script `Utilities.base64Decode()` 回嘅係 **signed byte**
 *   （-128..127）。`%PDF` 四個字元嘅碼位全部細過 128，所以直接比數字
 *   係安全嘅；但如果日後要驗其他 magic bytes，記得先 `& 0xFF`。
 * Args:
 *   bytes {number[]} 解碼之後嘅位元組陣列。
 *   maxMb {number} 大小上限（MB），Config `PUBLISH_MAX_PDF_MB`。
 * Returns:
 *   {{ok:boolean, reason:string, message:string, sizeMb:number}}
 *     `ok:true` 時 `reason`／`message` 係空字串。
 */
function validateUploadedPdf_(bytes, maxMb) {
  var list = bytes || [];
  var sizeMb = Math.round((list.length / (1024 * 1024)) * 100) / 100;
  var limit = Number(maxMb) > 0 ? Number(maxMb) : 10;

  if (list.length === 0) {
    return {
      ok: false, reason: 'EMPTY_FILE', sizeMb: 0,
      message: '上載的檔案是空的（0 個位元組），無法發佈。請確認在 Word 另存 PDF 時沒有出錯，然後重新選擇檔案。'
    };
  }

  var magic = [0x25, 0x50, 0x44, 0x46]; // %PDF
  var isPdf = list.length >= 4 && magic.every(function (expected, i) {
    return (Number(list[i]) & 0xFF) === expected;
  });
  if (!isPdf) {
    return {
      ok: false, reason: 'NOT_PDF', sizeMb: sizeMb,
      message: '這不是 PDF 檔案。系統檢查了檔案開頭的內容，發現它並不是以 PDF 的標記開始'
        + '（副檔名叫甚麼並不作準）。請在 Word 用「另存新檔」並選擇「PDF」格式，然後重新選擇那一個檔案。'
    };
  }

  if (sizeMb > limit) {
    return {
      ok: false, reason: 'TOO_LARGE', sizeMb: sizeMb,
      message: '這個 PDF 有 ' + sizeMb + ' MB，超過了上限 ' + limit + ' MB，因此拒絕發佈。'
        + '請在 Word 另存 PDF 時選擇較低的圖片解析度，或者在 Config 的 '
        + CONFIG_KEYS.PUBLISH_MAX_PDF_MB + ' 調高上限。'
    };
  }

  return { ok: true, reason: '', message: '', sizeMb: sizeMb };
}

// =====================================================================
// PublishLog：版本號與最新一行
// =====================================================================

/**
 * 用途：把 `PublishLog` 一行嘅 `SERVICE_DATE` 正規化成 yyyy-MM-dd。
 *   **純函式。**
 * Args:
 *   row {Object} `PublishLog` 一行。
 * Returns:
 *   {string} 讀唔到回空字串。
 */
function publishRowIsoDate_(row) {
  var v = (row || {}).SERVICE_DATE;
  if (Object.prototype.toString.call(v) === '[object Date]') return formatIsoDate_(v);
  return String(v || '').trim();
}

/**
 * 用途：算出某一個主日下一次發佈應該係第幾版。**純函式。**
 *
 *   同一個主日再發佈就加一；同一個主日從來未發佈過就係第 1 版。
 *   ⚠️ 刻意**唔用「行數 + 1」**：`PublishLog` 混住唔同主日嘅記錄，
 *   版本號係「呢個主日嘅第幾版」，唔係「整張表嘅第幾行」。
 * Args:
 *   rows {Object[]} `readSheet(SHEETS.PUBLISH_LOG)` 嘅輸出。
 *   isoDate {string} 主日日期，yyyy-MM-dd。
 * Returns:
 *   {number} 由 1 起。
 */
function nextPublishVersion_(rows, isoDate) {
  var target = String(isoDate || '').trim();
  var max = 0;
  (rows || []).forEach(function (row) {
    if (publishRowIsoDate_(row) !== target) return;
    var v = Number(row.VERSION_NO || 0);
    if (v > max) max = v;
  });
  return max + 1;
}

/**
 * 用途：揾出 `PublishLog` 最新一行（頂部狀態列 R-008 要用）。**純函式。**
 *
 *   排序準則係 `PUBLISHED_AT`；讀唔到時間就當佢最舊。同一個時間就取
 *   後面嗰行——後寫入嘅係新啲。
 *
 *   ⚠️ 唔可以淨係取最後一行：人手插咗一行、或者補寫舊記錄，最後一行
 *   就唔係最新嗰次發佈，頂部狀態列會長期顯示錯嘅版本。
 * Args:
 *   rows {Object[]} `readSheet(SHEETS.PUBLISH_LOG)` 嘅輸出。
 * Returns:
 *   {?Object} 冇任何記錄回 `null`。
 */
function latestPublishLogRow_(rows) {
  var best = null;
  var bestTime = null;

  (rows || []).forEach(function (row) {
    var at = row.PUBLISHED_AT;
    var time = (Object.prototype.toString.call(at) === '[object Date]') ? at.getTime() : null;
    if (best === null) { best = row; bestTime = time; return; }

    // 有時間嘅一定贏冇時間嘅；兩個都有時間就比大細（相同取後者）。
    if (time === null) return;
    if (bestTime === null || time >= bestTime) { best = row; bestTime = time; }
  });

  return best;
}

// =====================================================================
// 發佈前檢查：未填欄位（R-006）
// =====================================================================

/**
 * 用途：把 `buildBulletinModel_().missing` 分門別類，方便喺確認視窗
 *   一組一行咁列出。**純函式。**
 *
 *   ⚠️ 呢度**只做分組同排版**，一項都唔會自己判斷「有冇填」——判斷
 *   一律喺 `buildMissingList_()`（見檔頭嘅說明）。
 * Args:
 *   missing {Object[]} `model.missing`，每項 `{field, label, reason}`。
 * Returns:
 *   {{label:string, items:string[]}[]} 只回有內容嗰啲組，次序固定。
 */
function groupPublishMissing_(missing) {
  var groups = [
    { label: '程序', items: [] },
    { label: '人數', items: [] },
    { label: '家事報告', items: [] },
    { label: '代禱事項', items: [] },
    { label: '團契聚會', items: [] },
    { label: '事奉人選', items: [] }
  ];
  var byLabel = {};
  groups.forEach(function (g) { byLabel[g.label] = g; });

  (missing || []).forEach(function (item) {
    var field = String((item || {}).field || '');
    var label = String((item || {}).label || field);
    if (field.indexOf('POST:') === 0) { byLabel['事奉人選'].items.push(label); return; }
    if (field.indexOf('ATT_') === 0) { byLabel['人數'].items.push(label); return; }
    if (field === 'ANNOUNCEMENTS') { byLabel['家事報告'].items.push('0 條'); return; }
    if (field === 'PRAYERS') { byLabel['代禱事項'].items.push('0 條'); return; }
    if (field === 'FELLOWSHIPS') { byLabel['團契聚會'].items.push('0 條'); return; }
    byLabel['程序'].items.push(label);
  });

  return groups.filter(function (g) { return g.items.length > 0; });
}

// =====================================================================
// 發佈前檢查：日期異常（R-007）
// =====================================================================

/**
 * 用途：數兩個主日之間（**包含頭尾**）一共有幾多個主日。**純函式。**
 *
 *   ⚠️ 用曆法推算（每 7 日一個主日），**唔係**數 `BulletinWeeks` 有幾多
 *   行：未建立骨架嘅季度一行都冇，用行數會數出 0，變成「冇跳過主日」
 *   ——正正就係最應該出警告嗰種情況。
 * Args:
 *   startIso {string} 起點主日，yyyy-MM-dd。
 *   endIso {string} 終點主日，yyyy-MM-dd。
 * Returns:
 *   {number} `startIso` 遲過 `endIso`、或者任何一個解析唔到，回 0。
 */
function countSundaysInclusive_(startIso, endIso) {
  var start = isoDateToTime_(startIso);
  var end = isoDateToTime_(endIso);
  if (start === null || end === null || start > end) return 0;
  return Math.floor(Math.round((end - start) / (24 * 60 * 60 * 1000)) / 7) + 1;
}

/**
 * 用途：揾出「今日之後第一個主日」。**純函式。**
 *
 *   今日就係主日就回今日——嗰日仲未過去，仲發佈得切。
 * Args:
 *   todayIso {string} 今日，yyyy-MM-dd。
 * Returns:
 *   {string} yyyy-MM-dd；解析唔到回空字串。
 */
function nextSundayOnOrAfter_(todayIso) {
  var time = isoDateToTime_(todayIso);
  if (time === null) return '';
  var d = new Date(time);
  var addDays = (7 - d.getDay()) % 7;
  return formatIsoDate_(new Date(d.getFullYear(), d.getMonth(), d.getDate() + addDays));
}

/**
 * 用途：三種日期異常嘅判斷（R-007）。**純函式。**
 *
 *   三種可以同時出現，各自一句：
 *     1. `PAST_DATE`　　　　主日日期早過今日。
 *     2. `NOT_NEXT_SUNDAY`　唔係下一個主日。
 *     3. `SKIPPED_SUNDAYS`　上一次發佈之後有主日未發佈。
 *
 *   ⚠️ 三種都**唔會阻止發佈**，只係要求幹事親手勾一格確認。補發舊一期、
 *   預先發佈下下個星期，都係真實會發生嘅事，硬擋只會逼人繞路。
 *
 *   ⚠️ `SKIPPED_SUNDAYS` 個範圍係**頭尾都包**：由「上一次發佈嗰期之後
 *   一個主日」數到「今次呢期之前一個主日」，中間每一個主日都真係冇
 *   發佈過，所以兩頭都要計入。
 * Args:
 *   input {{isoDate:string, todayIso:string, lastPublishedIso:string}}
 *     `lastPublishedIso` 係 `PublishLog` 最新一行嘅主日；從未發佈過就傳
 *     空字串。
 * Returns:
 *   {{code:string, message:string}[]} 冇異常回空陣列。
 */
function detectPublishDateIssues_(input) {
  var o = input || {};
  var isoDate = String(o.isoDate || '').trim();
  var todayIso = String(o.todayIso || '').trim();
  var lastIso = String(o.lastPublishedIso || '').trim();
  var issues = [];

  var targetTime = isoDateToTime_(isoDate);
  var todayTime = isoDateToTime_(todayIso);
  if (targetTime === null || todayTime === null) return issues;

  if (targetTime < todayTime) {
    issues.push({ code: 'PAST_DATE', message: '這一期的主日已經過去（' + isoDate + '，今日是 ' + todayIso + '）。' });
  }

  var nextSunday = nextSundayOnOrAfter_(todayIso);
  if (nextSunday && nextSunday !== isoDate) {
    issues.push({ code: 'NOT_NEXT_SUNDAY', message: '這一期不是下一個主日（下一個是 ' + nextSunday + '）。' });
  }

  // 由「上一次發佈那一期的下一個主日」數到「這一期的前一個主日」。
  // 從未發佈過就由下一個主日數起——嗰陣「跳過」嘅意思係「由下星期起
  // 一路到這一期之前，全部都冇發佈過」。
  var startIso = lastIso ? addDaysToIsoDate_(lastIso, 7) : nextSunday;
  var endIso = addDaysToIsoDate_(isoDate, -7);
  var skipped = countSundaysInclusive_(startIso, endIso);
  if (skipped > 0) {
    issues.push({
      code: 'SKIPPED_SUNDAYS',
      message: startIso + ' 至 ' + endIso + ' 之間有 ' + skipped + ' 個主日未發佈。'
    });
  }

  return issues;
}

/**
 * 用途：把發佈前檢查嘅結果，濃縮成一句寫入 `PublishLog.FORCED_REASON`
 *   嘅摘要。**純函式。**
 * Args:
 *   precheck {{missingCount:number, dateIssues:Object[]}}
 * Returns:
 *   {string} 冇問題回空字串。
 */
function buildForcedReasonSummary_(precheck) {
  var o = precheck || {};
  var parts = [];
  if (Number(o.missingCount || 0) > 0) parts.push('未填欄位 ' + o.missingCount + ' 項');
  (o.dateIssues || []).forEach(function (issue) { parts.push(issue.message); });
  return parts.join('；');
}

/**
 * 用途：把發佈前檢查排版成確認視窗嘅內容行。**純函式。**
 *
 *   ⚠️ 未填欄位**全部列出，不截斷、不寫「等 N 項」**（R-006 明文要求）。
 *   截斷嘅話，被截走嗰幾項就係最容易漏嘅嗰幾項。
 * Args:
 *   precheck {Object} `buildPublishPrecheck_()` 嘅回傳值。
 * Returns:
 *   {string[]}
 */
function buildPublishPrecheckLines_(precheck) {
  var o = precheck || {};
  var lines = ['發佈前檢查：' + String(o.isoDate || '')];

  if (Number(o.missingCount || 0) > 0) {
    lines.push('');
    lines.push('未填欄位（' + o.missingCount + ' 項）');
    groupPublishMissing_(o.missing).forEach(function (group) {
      lines.push('　' + group.label + '：' + group.items.join('、'));
    });
  }

  if ((o.dateIssues || []).length > 0) {
    lines.push('');
    lines.push('日期提醒');
    o.dateIssues.forEach(function (issue) { lines.push('　⚠ ' + issue.message); });
  }

  if (lines.length === 1) lines.push('沒有發現任何問題。');
  return lines;
}

/**
 * 用途：發佈前檢查嘅**真正入口**：未填欄位（重用 `buildBulletinModel_()`）
 *   加三種日期異常。
 * Args:
 *   isoDate {string} 主日日期，yyyy-MM-dd。
 * Returns:
 *   {{isoDate:string, missing:Object[], missingCount:number,
 *     dateIssues:Object[], needsConfirm:boolean, forcedReason:string,
 *     lines:string[]}}
 * Raises:
 *   Error 如果 `isoDate` 格式不對或者職事表讀取失敗（原樣拋出）。
 */
function buildPublishPrecheck_(isoDate) {
  var config = publishConfig_();
  var model = buildBulletinModel_(isoDate);
  var missing = (model && model.missing) ? model.missing : [];

  var todayIso = Utilities.formatDate(new Date(), config.timezone, 'yyyy-MM-dd');
  var latest = latestPublishLogRow_(readSheet(SHEETS.PUBLISH_LOG));
  var dateIssues = detectPublishDateIssues_({
    isoDate: isoDate,
    todayIso: todayIso,
    lastPublishedIso: latest ? publishRowIsoDate_(latest) : ''
  });

  var precheck = {
    isoDate: isoDate,
    missing: missing,
    missingCount: missing.length,
    dateIssues: dateIssues,
    needsConfirm: (missing.length > 0 || dateIssues.length > 0)
  };
  precheck.forcedReason = buildForcedReasonSummary_(precheck);
  precheck.lines = buildPublishPrecheckLines_(precheck);
  return precheck;
}

// =====================================================================
// 錯誤分類
// =====================================================================

/**
 * 用途：把發佈途中攔到嘅例外，分類成一句幹事睇得明、而且講得出「係邊
 *   一種」嘅訊息。**純函式。**
 *
 *   三種最常見嘅失敗，處理方式完全唔同，所以一定要分得出：
 *     - 進階服務未啟用　→ 要去 Apps Script 編輯器撳一次。
 *     - 檔案被刪／搬走　→ 要重新建立 master 檔案。
 *     - 冇權限　　　　　→ 要叫 Shared Drive 管理員加權限。
 * Args:
 *   err {*} 攔到嘅例外。
 * Returns:
 *   {{code:string, message:string}}
 */
function classifyPublishError_(err) {
  var raw = (err && err.message) ? String(err.message) : String(err);
  var lower = raw.toLowerCase();

  if (lower.indexOf('drive is not defined') !== -1
    || (lower.indexOf('referenceerror') !== -1 && lower.indexOf('drive') !== -1)) {
    return {
      code: 'ADVANCED_SERVICE_DISABLED',
      message: '覆寫 master 檔案失敗：Drive 進階服務尚未啟用。請在 Apps Script 編輯器左邊的'
        + '「服務」按 ＋，加入「Drive API」（識別碼保持 Drive），儲存後再試一次。'
        + '原始訊息：' + raw
    };
  }
  if (lower.indexOf('not found') !== -1 || raw.indexOf('找不到') !== -1 || lower.indexOf('no item with') !== -1) {
    return {
      code: 'FILE_MISSING',
      message: '覆寫 master 檔案失敗：找不到那一個檔案，可能已被刪除或移到沒有權限的位置。'
        + '請先用選單「建立 master 發佈檔案」重新建立（⚠️ 重新建立會產生新的連結，'
        + '教會網站上的舊連結需要一併更新）。原始訊息：' + raw
    };
  }
  if (lower.indexOf('permission') !== -1 || lower.indexOf('access denied') !== -1
    || lower.indexOf('forbidden') !== -1 || raw.indexOf('權限') !== -1) {
    return {
      code: 'NO_PERMISSION',
      message: '覆寫 master 檔案失敗：沒有寫入該檔案的權限。請確認執行這個系統的帳戶，'
        + '對存放 master 檔案的 Shared Drive 有「內容管理員」或以上的權限。原始訊息：' + raw
    };
  }
  return { code: 'PUBLISH_FAILED', message: '覆寫 master 檔案失敗：' + raw };
}

// =====================================================================
// 收件人
// =====================================================================

/**
 * 用途：「發佈及匯出」區塊入面收件組別嗰幾格嘅定義。**純函式。**
 *
 *   ⚠️ `SELF` 唔係 `Recipients` 嘅組別，係「寄一份畀正在操作嘅人自己」，
 *   所以要另外處理，唔可以當成普通組別掉落 `buildRecipientList_()`。
 * Args: （無）
 * Returns:
 *   {{key:string, label:string}[]}
 */
function publishGroupOptions_() {
  return [
    { key: 'IT', label: 'IT' },
    { key: 'CC', label: 'CC 堂委' },
    { key: 'DB', label: 'DB 執事' },
    { key: 'ADMIN', label: '幹事' },
    { key: PUBLISH_GROUP_SELF_, label: '我自己' }
  ];
}

/**
 * 用途：解析「自訂電郵」欄（逗號分隔）。**純函式。**
 *
 *   ⚠️ 格式無效嘅**逐個列出**，而且**拒絕整次寄出**——唔可以靜靜跳過。
 *   靜靜跳過等於「以為寄咗畀嗰個人，其實冇」，呢種錯冇人會發現。
 * Args:
 *   text {string} 使用者輸入嘅字串。
 * Returns:
 *   {{emails:string[], invalid:string[]}}
 */
function parsePublishCustomEmails_(text) {
  var emails = [];
  var invalid = [];
  var seen = {};

  String(text || '').split(/[,，;；\s]+/).forEach(function (part) {
    var email = String(part || '').trim();
    if (!email) return;
    if (!isValidEmailShape_(email)) { invalid.push(email); return; }
    var key = email.toLowerCase();
    if (seen[key]) return;
    seen[key] = true;
    emails.push(email);
  });

  return { emails: emails, invalid: invalid };
}

/**
 * 用途：由勾選嘅組別 ＋ 自訂電郵，砌出今次發佈通知嘅收件人清單。
 * Args:
 *   groups {string[]} 勾選嘅組別鍵（可以含 `SELF`）。
 *   customText {string} 自訂電郵欄嘅原文。
 *   selfEmail {string} 操作者自己嘅電郵（`SELF` 用）。
 * Returns:
 *   {{ok:boolean, recipients:{email:string,name:string,groupName:string}[],
 *     invalid:string[], warnings:Object[], reason:(string|undefined),
 *     message:(string|undefined)}}
 */
function resolvePublishRecipients_(groups, customText, selfEmail) {
  var selected = (groups || []).map(function (g) { return String(g || '').trim(); }).filter(Boolean);
  var custom = parsePublishCustomEmails_(customText);

  if (custom.invalid.length > 0) {
    return {
      ok: false, recipients: [], invalid: custom.invalid, warnings: [],
      reason: 'INVALID_EMAIL',
      message: '自訂電郵欄有 ' + custom.invalid.length + ' 個地址格式不正確，因此整次寄出已經取消（'
        + custom.invalid.join('、') + '）。請改正之後再按一次執行。'
    };
  }

  var sheetGroups = selected.filter(function (g) { return g !== PUBLISH_GROUP_SELF_; });
  var listed = buildRecipientList_(readSheet(SHEETS.RECIPIENTS), sheetGroups, null);

  var recipients = listed.recipients.slice();
  var seen = {};
  recipients.forEach(function (r) { seen[String(r.email).toLowerCase()] = true; });

  function push(email, name, groupName) {
    var key = String(email || '').toLowerCase();
    if (!key || seen[key]) return;
    seen[key] = true;
    recipients.push({ email: email, name: name, groupName: groupName });
  }

  if (selected.indexOf(PUBLISH_GROUP_SELF_) !== -1) {
    var me = String(selfEmail || '').trim();
    if (isValidEmailShape_(me)) push(me, '', PUBLISH_GROUP_SELF_);
  }
  custom.emails.forEach(function (email) { push(email, '', 'CUSTOM'); });

  if (recipients.length === 0) {
    return {
      ok: false, recipients: [], invalid: [], warnings: listed.warnings,
      reason: 'NO_RECIPIENTS',
      message: '一個收件人都找不到。勾選的組別是 ' + (selected.join('、') || '（沒有勾選）')
        + '，而 Recipients 工作表內沒有屬於這些組別、ACTIVE=TRUE 而且電郵格式正確的資料列。'
    };
  }

  return { ok: true, recipients: recipients, invalid: [], warnings: listed.warnings };
}

// =====================================================================
// 揀錯檔案嘅防線（上載內容指紋）
// =====================================================================

/**
 * 用途：把一串位元組轉成一個「長度＋MD5」嘅指紋字串。
 *
 *   ⚠️ **兩樣都要**：淨係比長度，兩份唔同內容但同樣大細嘅 PDF 會撞；
 *   淨係比 MD5，睇 log 嗰陣完全睇唔出兩個指紋差幾遠。長度放前面，
 *   人眼一睇就知係咪同一個數量級。
 * Args:
 *   bytes {number[]} 位元組陣列。
 * Returns:
 *   {string} 例如 `102400:9e107d9d372bb682`；算唔到（服務唔得、空陣列）
 *     回空字串。**空字串代表「比對唔到」，唔可以當成「唔相同」。**
 */
function pdfFingerprint_(bytes) {
  var list = bytes || [];
  if (list.length === 0) return '';
  try {
    var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, list);
    var hex = digest.map(function (b) {
      var v = (Number(b) + 256) % 256;
      return (v < 16 ? '0' : '') + v.toString(16);
    }).join('');
    return list.length + ':' + hex;
  } catch (err) {
    return '';
  }
}

/**
 * 用途：判斷使用者上載嘅 PDF 係咪「揀錯咗檔案」。**純函式。**
 *
 *   實際發生過嘅事：幹事撳咗「下載目前已發佈的 PDF」，然後喺選檔案嗰陣
 *   揀返同一個檔案上載——等於**用舊內容覆寫自己**，而且系統會照樣回報
 *   「已發佈第 N 版」，冇任何人會發現嗰一期根本冇更新過。
 *
 *   ⚠️ 指紋係空字串一律當「比對唔到」，**唔可以當成「唔相同」**——
 *   比對唔到就放行（比對只係一道額外防線，唔應該因為讀唔到 master
 *   內容就連發佈都做唔到）。
 * Args:
 *   uploadFingerprint {string} 上載內容嘅指紋。
 *   masterFingerprint {string} master 檔案**目前**內容嘅指紋；讀唔到傳空字串。
 *   placeholderFingerprint {string} 建立 master 嗰陣個佔位 PDF 嘅指紋；
 *     未記錄過傳空字串。
 *   hasPublished {boolean} 呢個系統有冇發佈過任何一期。
 * Returns:
 *   {{ok:boolean, reason:string, message:string}}
 */
function classifyUploadedPdfSource_(uploadFingerprint, masterFingerprint, placeholderFingerprint, hasPublished) {
  var upload = String(uploadFingerprint || '');
  var master = String(masterFingerprint || '');
  var placeholder = String(placeholderFingerprint || '');

  var placeholderMessage = '你選的是佔位檔，不是週報。那一份是建立 master 發佈檔案時放進去的一頁'
    + '「本週週報尚未發佈」。請先按「下載 Word」，用 Word 開啟核對，另存為 PDF，再選那一個檔案。';

  if (!upload) return { ok: true, reason: '', message: '' };

  if (placeholder && upload === placeholder) {
    return { ok: false, reason: 'UPLOAD_IS_PLACEHOLDER', message: placeholderMessage };
  }

  if (master && upload === master) {
    // master 仲未發佈過任何一期 → 佢裏面放住嘅就係佔位檔本身。
    if (!hasPublished) {
      return { ok: false, reason: 'UPLOAD_IS_PLACEHOLDER', message: placeholderMessage };
    }
    return {
      ok: false, reason: 'UPLOAD_IS_CURRENT_MASTER',
      message: '你選的是目前已發佈的那一份，請選用 Word 另存的新 PDF。'
        + '（系統比對過檔案內容，與 master 連結裏面現在那一份一模一樣——'
        + '如果就這樣發佈，等於用舊內容覆寫自己，而且外表看不出分別。）'
    };
  }

  return { ok: true, reason: '', message: '' };
}

/**
 * 用途：上載 PDF 嘅「揀錯檔案」檢查（IO 層）。
 * Args:
 *   bytes {number[]} 上載內容。
 *   config {Object} `publishConfig_()` 嘅回傳值。
 *   hasPublished {boolean} `PublishLog` 有冇任何一行。
 * Returns:
 *   {{ok:boolean, reason:string, message:string}}
 */
function checkUploadedPdfIsNew_(bytes, config, hasPublished) {
  return classifyUploadedPdfSource_(
    pdfFingerprint_(bytes),
    pdfFingerprint_(readMasterPdfBytes_(config.masterFileId)),
    readPublishScriptProperty_(PUBLISH_PLACEHOLDER_FINGERPRINT_KEY_),
    hasPublished === true
  );
}

// =====================================================================
// 防重複發佈（ScriptProperties）
// =====================================================================

/**
 * 用途：讀一個 ScriptProperties 值。讀唔到回空字串，**唔拋錯**。
 * Args:
 *   key {string} 鍵名。
 * Returns:
 *   {string}
 */
function readPublishScriptProperty_(key) {
  try {
    return String(PropertiesService.getScriptProperties().getProperty(key) || '');
  } catch (err) {
    return '';
  }
}

/**
 * 用途：寫一個 ScriptProperties 值。寫唔到回 `false`，**唔拋錯**。
 * Args:
 *   key {string} 鍵名。
 *   value {string} 值。
 * Returns:
 *   {boolean}
 */
function writePublishScriptProperty_(key, value) {
  try {
    PropertiesService.getScriptProperties().setProperty(key, String(value));
    return true;
  } catch (err) {
    return false;
  }
}

/**
 * 用途：記低「呢個主日啱啱成功發佈咗第 N 版」，供防重複用。
 * Args:
 *   isoDate {string} 主日日期。
 *   versionNo {number} 版本號。
 *   nowMs {number} 現在嘅毫秒數。
 * Returns:
 *   {boolean} 有冇寫得入。
 */
function recordPublishStamp_(isoDate, versionNo, nowMs) {
  return writePublishScriptProperty_(
    PUBLISH_LAST_KEY_PREFIX_ + String(isoDate || ''),
    JSON.stringify({ at: Number(nowMs), versionNo: Number(versionNo) })
  );
}

/**
 * 用途：判斷「呢一次撳，係咪同一個主日喺 N 秒內撳多咗一次」。**純函式。**
 *
 *   ⚠️ 呢個唔係取代 `LockService`，而係補佢嘅漏：鎖擋得住「同時」，
 *   擋唔住「一個做完、第二個緊接住入嚟」——而使用者見唔到反應撳多一次，
 *   兩次之間隔咗成個第一次嘅執行時間，鎖早就放返出嚟。
 * Args:
 *   stampJson {string} `recordPublishStamp_()` 存落去嗰個 JSON；冇就傳空字串。
 *   nowMs {number} 現在嘅毫秒數。
 *   dedupSec {number} Config `PUBLISH_DEDUP_SEC`。
 * Returns:
 *   {?{versionNo:number, secondsAgo:number}} 唔算重複回 `null`。
 */
function findRecentPublishStamp_(stampJson, nowMs, dedupSec) {
  var seconds = Number(dedupSec);
  if (!stampJson || !(seconds > 0)) return null;

  var parsed;
  try {
    parsed = JSON.parse(stampJson);
  } catch (err) {
    return null;
  }
  if (!parsed || typeof parsed.at !== 'number') return null;

  var elapsedMs = Number(nowMs) - parsed.at;
  // 負數（時鐘倒退、指紋來自未來）一律當唔算重複——寧可多發佈一版，
  // 都好過因為一個對唔上嘅時間戳記，永遠拒絕發佈。
  if (elapsedMs < 0 || elapsedMs > seconds * 1000) return null;

  return { versionNo: Number(parsed.versionNo || 0), secondsAgo: Math.round(elapsedMs / 1000) };
}

// =====================================================================
// 執行發佈（第 6 部分）
// =====================================================================

/**
 * 用途：真正執行一次發佈——覆寫 master 檔案、存檔副本、寫 `PublishLog`。
 *   **真正入口**（由 `runPublishFlow_()` 呼叫）。
 *
 *   ⚠️ **覆寫失敗就唔可以寫 `PublishLog`**：冇成功就唔算發佈過。寫咗
 *   嘅話，頂部狀態列會話「已發佈第 3 版」，但條連結入面仲係第 2 版——
 *   一個冇人查得出嘅假象。失敗一律寫 `ErrorLog`。
 * Args:
 *   isoDate {string} 主日日期，yyyy-MM-dd。
 *   blob {Blob} 已驗證過嘅 PDF。
 *   options {{forced:boolean, forcedReason:string, missingCount:number,
 *             sent:boolean, sentGroups:string}}
 * Returns:
 *   {{ok:boolean, versionNo:number, fileId:string, links:Object,
 *     archiveFileId:string, archiveFileUrl:string, archiveFileName:string,
 *     archiveError:string, reason:(string|undefined), message:(string|undefined)}}
 */
function executePublish_(isoDate, blob, options) {
  var o = options || {};
  var config = publishConfig_();

  if (!config.masterFileId) {
    return {
      ok: false, reason: 'NO_MASTER_FILE',
      message: '尚未建立 master 發佈檔案。請先在選單「週報系統 → 建立 master 發佈檔案」按一次，'
        + '建立之後那一條連結就永遠不變，可以放上教會網站。'
    };
  }
  if (!config.archiveFolderId) {
    return {
      ok: false, reason: 'NO_ARCHIVE_FOLDER',
      message: '尚未設定存檔資料夾。請在 Config 工作表填入 ' + CONFIG_KEYS.PUBLISHED_ARCHIVE_FOLDER_ID
        + '（Shared Drive 內某個資料夾的 ID），然後再按一次執行。'
    };
  }

  var versionNo = nextPublishVersion_(readSheet(SHEETS.PUBLISH_LOG), isoDate);

  // ---- 1. 覆寫 master（檔案 ID 不變）----
  try {
    overwriteMasterPdf_(config.masterFileId, blob, config.masterFileName);
  } catch (err) {
    var classified = classifyPublishError_(err);
    appendErrorLog_({
      source: ERROR_LOG_SOURCE.SERVER,
      functionName: 'executePublish_',
      errorCode: classified.code,
      message: classified.message,
      detail: buildErrorDetail_(err, { argsSummary: 'isoDate=' + isoDate + ' version=' + versionNo })
    });
    return { ok: false, reason: classified.code, message: classified.message };
  }

  // ---- 2. 存檔副本 ----
  // ⚠️ 存檔失敗**唔可以**當成整次發佈失敗：master 已經換咗，會眾撳條
  // 連結睇到嘅已經係新一期。呢個時候回「發佈失敗」係講大話。改為照樣
  // 記低發佈，另外回一句「存檔副本存唔到」畀幹事人手補。
  var archive = { fileId: '', fileUrl: '' };
  var archiveError = '';
  var archiveFileName = buildArchiveFileName_(isoDate, versionNo);
  try {
    archive = saveArchivePdfCopy_(blob, archiveFileName, config.archiveFolderId);
  } catch (err2) {
    archiveError = (err2 && err2.message) ? err2.message : String(err2);
    appendErrorLog_({
      source: ERROR_LOG_SOURCE.SERVER,
      functionName: 'executePublish_',
      errorCode: 'ARCHIVE_COPY_FAILED',
      message: '存檔副本寫入失敗（master 已經成功覆寫）：' + archiveError,
      detail: buildErrorDetail_(err2, { argsSummary: 'isoDate=' + isoDate + ' version=' + versionNo })
    });
  }

  // ---- 3. 寫 PublishLog ----
  var actor = publishCurrentUserEmail_();

  writeSheet(SHEETS.PUBLISH_LOG, [{
    SERVICE_DATE: normalizeDate_(isoDate),
    VERSION_NO: versionNo,
    PUBLISHED_AT: new Date(),
    PUBLISHED_BY: sanitizeCellText_(actor || '（未知使用者）'),
    ARCHIVE_FILE_ID: sanitizeCellText_(archive.fileId),
    SENT: o.sent === true,
    SENT_GROUPS: sanitizeCellText_(o.sentGroups || ''),
    MISSING_COUNT: Number(o.missingCount || 0),
    FORCED: o.forced === true,
    FORCED_REASON: sanitizeCellText_(o.forcedReason || '')
  }]);

  appendAuditLog_({
    action: 'PUBLISH_BULLETIN',
    sheetName: SHEETS.PUBLISH_LOG, rowKey: isoDate,
    field: 'VERSION_NO', oldValue: String(versionNo - 1), newValue: String(versionNo),
    notes: '已覆寫 master 發佈檔案；存檔副本：' + (archive.fileId ? archiveFileName : '（未能存檔）')
  });

  // ⚠️ 記低「呢個主日啱啱發佈咗第 N 版」，供防重複用。寫唔入去唔可以
  // 令成次發佈失敗——master 已經換咗，防重複只係一個方便，唔係正確性。
  recordPublishStamp_(isoDate, versionNo, new Date().getTime());

  return {
    ok: true,
    versionNo: versionNo,
    fileId: config.masterFileId,
    links: masterPdfLinks_(config.masterFileId),
    archiveFileId: archive.fileId,
    archiveFileUrl: archive.fileUrl,
    archiveFileName: archiveFileName,
    archiveError: archiveError
  };
}

/**
 * 用途：攞正在操作嘅人嘅電郵；攞唔到回空字串，**唔拋錯**。
 * Args: （無）
 * Returns:
 *   {string}
 */
function publishCurrentUserEmail_() {
  try {
    return Session.getActiveUser().getEmail() || '';
  } catch (err) {
    return '';
  }
}

// =====================================================================
// 寄出（第 7 部分）
// =====================================================================

/**
 * 用途：寄出發佈通知。**真正入口**（由 `runPublishFlow_()` 呼叫）。
 *
 *   受 `DRY_RUN` 保護，寫 `SendLog`（`STATUS='PUBLISH'`）。
 * Args:
 *   isoDate {string} 主日日期，yyyy-MM-dd。
 *   options {{groups:string[], customEmails:string, blob:(Blob|null)}}
 *     `blob` 係今次上載嘅 PDF；只寄唔發佈時係 `null`，嗰陣就算 Config
 *     叫附上 PDF 都冇嘢可以附（信入面照樣有 master 連結）。
 * Returns:
 *   {{ok:boolean, dryRun:boolean, recipientCount:number, groups:string[],
 *     attached:boolean, reason:(string|undefined), message:(string|undefined)}}
 */
function sendPublishNotice_(isoDate, options) {
  var o = options || {};
  var config = publishConfig_();

  if (!config.masterFileId) {
    return {
      ok: false, dryRun: config.dryRun, recipientCount: 0, groups: [], attached: false,
      reason: 'NO_MASTER_FILE',
      message: '尚未建立 master 發佈檔案，通知信裏面沒有連結可以放。請先用選單「建立 master 發佈檔案」建立一次。'
    };
  }

  var resolved = resolvePublishRecipients_(o.groups, o.customEmails, publishCurrentUserEmail_());
  if (!resolved.ok) {
    return {
      ok: false, dryRun: config.dryRun, recipientCount: 0, groups: o.groups || [], attached: false,
      reason: resolved.reason, message: resolved.message
    };
  }

  var links = masterPdfLinks_(config.masterFileId);
  var template = findPublishEmailTemplate_();
  var vars = {
    ChurchName: config.churchName,
    ServiceDate: isoDate,
    MasterLink: links.view
  };
  var subject = renderEmailTemplate_(template.subject, vars, []);
  var body = renderEmailTemplate_(template.body, vars, []);

  var attachments = [];
  if (config.attachPdf && o.blob) attachments.push(o.blob);

  var sendLogRows = [];
  resolved.recipients.forEach(function (recipient) {
    var status = PUBLISH_SEND_STATUS_;
    var errorMessage = '';

    if (!config.dryRun) {
      try {
        var payload = { to: recipient.email, subject: subject, body: body };
        if (attachments.length > 0) payload.attachments = attachments;
        MailApp.sendEmail(payload);
      } catch (mailErr) {
        status = 'FAILED';
        errorMessage = (mailErr && mailErr.message) ? mailErr.message : String(mailErr);
      }
    }

    sendLogRows.push({
      TIMESTAMP: new Date(),
      SERVICE_DATE: normalizeDate_(isoDate),
      RECIPIENT_EMAIL: sanitizeCellText_(recipient.email),
      SUBJECT: sanitizeCellText_(subject),
      STATUS: status,
      DRY_RUN: config.dryRun,
      ROSTER_VERSION_USED: '',
      ERROR: sanitizeCellText_(errorMessage)
    });
  });

  writeSheet(SHEETS.SEND_LOG, sendLogRows);

  return {
    ok: true,
    dryRun: config.dryRun,
    recipientCount: resolved.recipients.length,
    groups: (o.groups || []).slice(),
    attached: attachments.length > 0
  };
}

/**
 * 用途：由 `EmailTemplates` 揾出發佈通知範本；揾唔到就用內建預設。
 *
 *   ⚠️ 揾唔到**唔可以拋錯**：範本行被人手改成 `ACTIVE=FALSE`、或者
 *   初始化未行過，都唔應該令「已經覆寫好 master」之後嗰封信寄唔出。
 * Args: （無）
 * Returns:
 *   {{subject:string, body:string, fromSheet:boolean}}
 */
function findPublishEmailTemplate_() {
  var fallback = seedPublishNoticeRow_();
  var rows = readSheet(SHEETS.EMAIL_TEMPLATES) || [];
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    if (String(row.TEMPLATE_ID || '').trim() !== PUBLISH_TEMPLATE_ID_) continue;
    if (row.ACTIVE !== true) continue;
    return {
      subject: String(row.SUBJECT || fallback.SUBJECT),
      body: String(row.BODY || fallback.BODY),
      fromSheet: true
    };
  }
  return { subject: fallback.SUBJECT, body: fallback.BODY, fromSheet: false };
}

// =====================================================================
// 「執行」按鈕背後嘅完整流程
// =====================================================================

/**
 * 用途：Web App「發佈及匯出」區塊撳「執行」之後嘅完整流程。**真正入口。**
 *
 *   兩個勾選各自獨立（R-003）：只發佈、只寄出、兩個都做，三種都可以。
 *
 *   ⚠️ 發佈前檢查（R-006／R-007）對**兩種動作都適用**：只寄出一樣係把
 *   一期未填齊嘅週報送出去，同樣要幹事親眼確認過。
 *
 *   ⚠️ 「一格都未寫」呢件事好重要：`reason:'NEEDS_CONFIRM'` 係喺任何
 *   Drive 寫入、任何工作表寫入**之前**回嘅。前端出完確認視窗之後會帶住
 *   `confirmed:true` 再叫一次，嗰陣先至真係做嘢。
 * Args:
 *   payload {{isoDate:string, doPublish:boolean, doSend:boolean,
 *             pdfBase64:string, pdfName:string, groups:string[],
 *             customEmails:string, confirmed:boolean}}
 * Returns:
 *   {{ok:boolean, reason:(string|undefined), message:(string|undefined),
 *     precheck:(Object|undefined), published:(Object|undefined),
 *     sent:(Object|undefined), lines:string[]}}
 */
function runPublishFlow_(payload) {
  var p = payload || {};
  var isoDate = String(p.isoDate || '').trim();
  var doPublish = p.doPublish === true;
  var doSend = p.doSend === true;

  if (!isoDate) {
    return { ok: false, reason: 'NO_DATE', message: '未選擇主日，無法執行。', lines: [] };
  }
  if (!doPublish && !doSend) {
    return {
      ok: false, reason: 'NOTHING_SELECTED', lines: [],
      message: '請至少勾選「發佈到 master 連結」或「寄出」其中一項，然後再按執行。'
    };
  }

  // ---- 上載嘅 PDF：先驗證，未過關就一格都唔好寫 ----
  var blob = null;
  var pdfSizeMb = 0;
  if (doPublish) {
    if (!p.pdfBase64) {
      return {
        ok: false, reason: 'NO_PDF', lines: [],
        message: '勾選了「發佈到 master 連結」，但尚未選擇 PDF 檔案。請先按「下載 Word」，'
          + '用 Word 開啟核對，另存為 PDF，然後在這裏選擇那一個 PDF。'
      };
    }
    var config = publishConfig_();
    var bytes;
    try {
      bytes = Utilities.base64Decode(String(p.pdfBase64));
    } catch (decodeErr) {
      return {
        ok: false, reason: 'BAD_UPLOAD', lines: [],
        message: '上載的檔案內容無法解讀，可能在傳送途中出錯。請重新選擇一次那個 PDF。'
      };
    }
    var check = validateUploadedPdf_(bytes, config.maxPdfMb);
    if (!check.ok) return { ok: false, reason: check.reason, message: check.message, lines: [] };

    // ⚠️ 「揀錯檔案」嘅防線（第 4 部分）。排喺呢度係刻意嘅：仲未動過
    // 任何嘢，可以乾淨咁拒絕。
    var source = checkUploadedPdfIsNew_(bytes, config, readSheet(SHEETS.PUBLISH_LOG).length > 0);
    if (!source.ok) return { ok: false, reason: source.reason, message: source.message, lines: [] };

    pdfSizeMb = check.sizeMb;
    blob = Utilities.newBlob(bytes, 'application/pdf', String(p.pdfName || config.masterFileName));
  }

  // ---- 只寄唔發佈：從未發佈過就拒絕 ----
  if (doSend && !doPublish) {
    var latest = latestPublishLogRow_(readSheet(SHEETS.PUBLISH_LOG));
    if (!latest) {
      return {
        ok: false, reason: 'NEVER_PUBLISHED', lines: [],
        message: '從未發佈過任何一期，因此沒有已發佈的內容可以通知。請先發佈一次'
          + '（勾選「發佈到 master 連結」並選擇 PDF），之後就可以只寄出不發佈。'
      };
    }
  }

  // ---- 發佈前檢查（R-006／R-007）----
  var precheck = buildPublishPrecheck_(isoDate);

  // ⚠️ 使用者測試模式的保險（prompt-pre-usertest 第 3 部分）：`DRY_RUN`
  // 只影響「寄出」，發佈本身一樣會真的覆寫 master 連結。測試期間這一點
  // 很容易被誤會成「反正是測試系統，撳什麼都是假的」，所以**不論有沒有
  // 未填欄位／日期異常**，只要真的要發佈而且目前是 DRY_RUN，都要在確認
  // 視窗加這一句、而且一樣要勾方框才能繼續。
  //
  // ⚠️ 這一句刻意**不計入** `precheck.forcedReason`／`FORCED`——那兩個
  // 記的是 R-006／R-007 那種「資料本身有問題」的強制發佈，跟「這是測試
  // 環境」是兩件不相關的事，混在一起會令 `PublishLog.FORCED_REASON`
  // 失真（日後回頭查會以為那一次發佈資料不齊全，其實只是提醒過一句）。
  precheck.dryRunPublishNotice = (doPublish === true && config.dryRun === true);
  if (precheck.dryRunPublishNotice) {
    precheck.lines = precheck.lines.concat([
      '',
      '⚠ 測試模式（DRY_RUN=TRUE）只影響「寄出」——發佈會真的覆寫網站上那條 master 連結，不是模擬。'
    ]);
  }

  var needsConfirmDialog = precheck.needsConfirm || precheck.dryRunPublishNotice;
  if (needsConfirmDialog && p.confirmed !== true) {
    return {
      ok: false, reason: 'NEEDS_CONFIRM', precheck: precheck, lines: precheck.lines,
      message: '發佈前檢查發現需要確認的事項，請閱讀後勾選確認方框。'
    };
  }

  var sentGroups = (p.groups || []).join(',');
  var result = { ok: true, lines: [], precheck: precheck };

  // ---- 由這裏開始會真的寫東西，所以要拿鎖（第 3 部分）----
  //
  // ⚠️ 鎖擋住「兩個請求同時進來」；下面那個防重複時間戳記擋住「一個
  // 做完、使用者見不到反應又撳一次」。兩者缺一不可——只有鎖的話，第二
  // 次會在第一次放鎖之後乖乖地再發佈一版。
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(PUBLISH_LOCK_WAIT_MS_)) {
    return {
      ok: false, reason: 'LOCK_BUSY', lines: [],
      message: '另一個發佈或匯入正在執行中，' + Math.round(PUBLISH_LOCK_WAIT_MS_ / 1000)
        + ' 秒內都拿不到指令碼鎖，因此這一次沒有做任何事。請稍等片刻再按一次執行。'
        + '（如果剛才已經按過一次「執行」，請先等它完成，不要重複按。）'
    };
  }

  try {
    return runPublishFlowLocked_(p, {
      isoDate: isoDate, doPublish: doPublish, doSend: doSend,
      blob: blob, pdfSizeMb: pdfSizeMb, sentGroups: sentGroups,
      precheck: precheck, result: result
    });
  } finally {
    lock.releaseLock();
  }
}

/**
 * 用途：`runPublishFlow_()` 拿到鎖之後嘅那一段——防重複、發佈、寄出。
 *
 *   ⚠️ 抽成獨立函式純粹係為咗令 `try/finally` 只包住「真正會寫嘢」嗰段，
 *   而唔使喺十幾個 `return` 分支各自記得放鎖。
 * Args:
 *   payload {Object} 原本嘅 payload（要用 `groups`／`customEmails`）。
 *   ctx {{isoDate:string, doPublish:boolean, doSend:boolean, blob:(Blob|null),
 *        pdfSizeMb:number, sentGroups:string, precheck:Object, result:Object}}
 * Returns:
 *   {Object} 同 `runPublishFlow_()`。
 */
function runPublishFlowLocked_(payload, ctx) {
  var p = payload || {};
  var isoDate = ctx.isoDate;
  var doPublish = ctx.doPublish;
  var doSend = ctx.doSend;
  var precheck = ctx.precheck;
  var result = ctx.result;
  var config = publishConfig_();

  // ---- 防重複：同一個主日剛剛已經成功發佈過 ----
  if (doPublish) {
    var recent = findRecentPublishStamp_(
      readPublishScriptProperty_(PUBLISH_LAST_KEY_PREFIX_ + isoDate),
      new Date().getTime(),
      config.dedupSec
    );
    if (recent) {
      return {
        ok: true, duplicate: true, precheck: precheck,
        published: {
          versionNo: recent.versionNo,
          fileId: config.masterFileId,
          links: masterPdfLinks_(config.masterFileId)
        },
        lines: [
          '剛才已經發佈過（第 ' + recent.versionNo + ' 版），因此這一次沒有再產生新版本。',
          '（' + recent.secondsAgo + ' 秒之前發佈的。如果你是因為看不到反應而多按了一次，'
            + '那一次其實已經成功了。）',
          'master 連結（永遠不變）：' + masterPdfLinks_(config.masterFileId).view
        ]
      };
    }
  }

  // ---- 發佈 ----
  if (doPublish) {
    var published = executePublish_(isoDate, ctx.blob, {
      forced: precheck.needsConfirm === true,
      forcedReason: precheck.forcedReason,
      missingCount: precheck.missingCount,
      sent: doSend,
      sentGroups: doSend ? ctx.sentGroups : ''
    });
    if (!published.ok) {
      return { ok: false, reason: published.reason, message: published.message, lines: [] };
    }
    published.pdfSizeMb = ctx.pdfSizeMb;
    result.published = published;
  }

  // ---- 寄出 ----
  if (doSend) {
    var sent = sendPublishNotice_(isoDate, {
      groups: p.groups || [],
      customEmails: p.customEmails || '',
      blob: ctx.blob
    });
    if (!sent.ok) {
      // ⚠️ 發佈已經成功嘅話，唔可以因為寄唔出就話成件事失敗——master
      // 真係換咗，會眾撳條連結已經睇到新一期。改為回 `ok:true` 加一句
      // 寄出失敗嘅說明，唔好講一句同事實相反嘅話。
      if (result.published) {
        result.sendError = sent.message;
      } else {
        return { ok: false, reason: sent.reason, message: sent.message, lines: [] };
      }
    } else {
      result.sent = sent;
    }
  }

  result.lines = buildPublishResultLines_(result);
  return result;
}

/**
 * 用途：把 `runPublishFlow_()` 成功之後嘅結果排版成對話框內容行。
 *   **純函式。**
 * Args:
 *   result {Object} `runPublishFlow_()` 嘅回傳值（`ok:true`）。
 * Returns:
 *   {string[]}
 */
function buildPublishResultLines_(result) {
  var o = result || {};
  var lines = [];

  if (o.published) {
    lines.push('已發佈：第 ' + o.published.versionNo + ' 版');
    lines.push('master 連結（永遠不變）：' + o.published.links.view);
    if (o.published.archiveFileUrl) {
      lines.push('存檔副本：' + o.published.archiveFileName);
    } else if (o.published.archiveError) {
      lines.push('⚠️ 存檔副本未能寫入：' + o.published.archiveError
        + '　master 檔案已經成功覆寫，請人手補存一份。');
    }
  }

  if (o.sent) {
    lines.push(o.sent.dryRun
      ? '⚠️ 模擬模式開啟中：已記錄 ' + o.sent.recipientCount + ' 個收件人，但沒有真的寄出。'
      : '已寄出：' + o.sent.recipientCount + ' 個收件人。');
    if (o.sent.attached) lines.push('通知信已附上這一次的 PDF。');
  } else if (o.sendError) {
    lines.push('⚠️ 寄出失敗：' + o.sendError);
  }

  if (o.precheck && o.precheck.needsConfirm) {
    lines.push('');
    lines.push('（本次是在確認「仍然要發佈」之後執行的，已記入 PublishLog。）');
  }

  return lines;
}

// =====================================================================
// 頂部狀態列（R-008）
// =====================================================================

/**
 * 用途：組出頂部狀態列（R-008）要用嘅資料。**真正入口。**
 * Args: （無）
 * Returns:
 *   {{hasMaster:boolean, published:boolean, isoDate:string, versionNo:number,
 *     publishedAt:string, publishedBy:string, links:Object, text:string}}
 */
function buildPublishStatusForWebApp_() {
  var config = publishConfig_();
  var links = masterPdfLinks_(config.masterFileId);
  var rows = [];
  try {
    rows = readSheet(SHEETS.PUBLISH_LOG);
  } catch (err) {
    // 狀態列只係一行提示，讀唔到唔應該令整個介面載入唔到。
    rows = [];
  }

  var latest = latestPublishLogRow_(rows);
  var publishedAt = '';
  if (latest && Object.prototype.toString.call(latest.PUBLISHED_AT) === '[object Date]') {
    publishedAt = Utilities.formatDate(latest.PUBLISHED_AT, config.timezone, 'yyyy-MM-dd HH:mm');
  }

  var recipientRows = [];
  try {
    recipientRows = readSheet(SHEETS.RECIPIENTS);
  } catch (err) {
    recipientRows = [];
  }

  var status = {
    hasMaster: Boolean(config.masterFileId),
    published: Boolean(latest),
    isoDate: latest ? publishRowIsoDate_(latest) : '',
    versionNo: latest ? Number(latest.VERSION_NO || 0) : 0,
    publishedAt: publishedAt,
    publishedBy: latest ? resolvePublishActorDisplayName_(latest.PUBLISHED_BY, recipientRows) : '',
    links: links
  };
  status.text = buildPublishStatusText_(status);
  return status;
}

/**
 * 用途：把發佈人嘅電郵縮成一個顯示用嘅名（`@` 前面嗰截）。**純函式。**
 *
 *   ⚠️ 介面上唔應該長期掛住一個完整電郵地址——呢個畫面會投影出嚟示範、
 *   會截圖貼落求助訊息。前面嗰截已經夠分得出係邊個。呢個係
 *   `resolvePublishActorDisplayName_()` 揾唔到 `Recipients` 顯示名稱時嘅
 *   退回，唔係頂部狀態列直接用嘅函式（見下面嗰個）。
 * Args:
 *   value {*} `PublishLog.PUBLISHED_BY`（一個電郵地址）。
 * Returns:
 *   {string}
 */
function publishActorLabel_(value) {
  var text = String(value || '').trim();
  if (!text) return '';
  var at = text.indexOf('@');
  return at > 0 ? text.slice(0, at) : text;
}

/**
 * 用途：頂部狀態列「由 XXX 發佈」嗰個名——優先用 `Recipients` 嘅顯示
 *   名稱，查唔到先退回電郵 `@` 前半部。**純函式。**
 *
 *   ⚠️ `PublishLog.PUBLISHED_BY` 存嘅係
 *   `Session.getActiveUser().getEmail()`，即係 Google 帳戶電郵——喺
 *   Workspace 網域入面通常係 `ivantheservant@…` 呢種帳戶名，唔一定係
 *   會友慣用嘅稱呼。`Recipients` 嗰個「姓名」欄先至係人手填嘅、真正
 *   想畀人睇到嘅顯示名稱，所以優先用佢。
 * Args:
 *   email {*} `PublishLog.PUBLISHED_BY`。
 *   recipientRows {Object[]} `readSheet(SHEETS.RECIPIENTS)` 嘅輸出。
 * Returns:
 *   {string} 兩者都揾唔到（例如 email 本身係空）就回空字串。
 */
function resolvePublishActorDisplayName_(email, recipientRows) {
  var target = String(email || '').trim().toLowerCase();
  if (!target) return '';

  var match = (recipientRows || []).filter(function (r) {
    return String(r.EMAIL || '').trim().toLowerCase() === target;
  })[0];
  if (match) {
    var name = String(match.NAME || '').trim();
    if (name) return name;
  }

  return publishActorLabel_(email);
}

/**
 * 用途：砌頂部狀態列嗰一行字。**純函式。**
 * Args:
 *   status {Object} `buildPublishStatusForWebApp_()` 嘅回傳值（未有 `text`）。
 * Returns:
 *   {string}
 */
function buildPublishStatusText_(status) {
  var o = status || {};
  if (!o.hasMaster) return '尚未建立 master 發佈檔案';
  if (!o.published) return '尚未發佈過任何一期';

  var parts = ['目前已發佈：' + o.isoDate + '（第 ' + o.versionNo + ' 版）'];
  if (o.publishedAt) {
    parts.push(o.publishedAt + (o.publishedBy ? ' 由 ' + o.publishedBy + ' 發佈' : ' 發佈'));
  }
  return parts.join('　');
}

// =====================================================================
// 選單：建立 master 發佈檔案（一次過）
// =====================================================================

/**
 * 用途：建立 master 發佈檔案。**冪等**：Config 已經有 ID 而且檔案仲開得到
 *   就**唔重建**，直接回三條連結。**真正入口。**
 *
 *   ⚠️ 重建 = 換咗檔案 ID = 換咗條連結，而條連結已經印咗上教會網站。
 *   所以「已經有就唔好再建立」係硬規則，唔係優化。
 * Args: （無）
 * Returns:
 *   {{ok:boolean, created:boolean, fileId:string, links:Object,
 *     sharingApplied:boolean, sharingError:string,
 *     reason:(string|undefined), message:(string|undefined)}}
 */
function ensureMasterPublishFile_() {
  var config = publishConfig_();

  if (config.masterFileId) {
    var probe = probeMasterPdfFile_(config.masterFileId);
    if (probe.exists) {
      return {
        ok: true, created: false, fileId: config.masterFileId,
        links: masterPdfLinks_(config.masterFileId),
        sharingApplied: true, sharingError: ''
      };
    }
    // ⚠️ 「查唔到」同「唔存在」要分開講：前者叫人去編輯器啟用服務，
    // 後者叫人重新建立——而重新建立會換咗條連結。講錯一句，人就會去
    // 做一件唔應該做嘅事。
    if (probe.serviceUnavailable) {
      return {
        ok: false, created: false, fileId: config.masterFileId,
        links: masterPdfLinks_(config.masterFileId),
        sharingApplied: false, sharingError: '', reason: 'ADVANCED_SERVICE_DISABLED',
        message: 'Drive 進階服務尚未啟用，因此無法確認 master 發佈檔案的狀況。'
          + '請在 Apps Script 編輯器左邊的「服務」按 ＋，加入「Drive API」'
          + '（識別碼保持 Drive、版本選 v2），儲存後再按一次。'
          + '⚠️ 在這之前**不要**清空 Config 那一格——檔案很可能好端端在，只是查不到。'
      };
    }

    return {
      ok: false, created: false, fileId: config.masterFileId,
      links: masterPdfLinks_(config.masterFileId),
      sharingApplied: false, sharingError: '', reason: 'FILE_MISSING',
      message: 'Config 的 ' + CONFIG_KEYS.PUBLISHED_PDF_FILE_ID + ' 已經有值，但那個檔案現在開不到'
        + '（可能已被刪除、移到沒有權限的位置，或者 ID 不正確）。'
        + '⚠️ 如果確定要重新建立，請先把那一格清空再按一次——但重新建立會產生新的連結，'
        + '教會網站上的舊連結需要一併更新。'
    };
  }

  if (!config.masterFolderId) {
    return {
      ok: false, created: false, fileId: '', links: masterPdfLinks_(''),
      sharingApplied: false, sharingError: '', reason: 'NO_FOLDER_ID',
      message: '尚未設定 master 發佈檔案要建立在哪一個資料夾。請在 Config 工作表填入 '
        + CONFIG_KEYS.PUBLISHED_PDF_FOLDER_ID
        + '（Shared Drive 內某個資料夾的 ID——在瀏覽器開啟該資料夾，網址 /folders/ 後面那一串就是），'
        + '然後再按一次。'
    };
  }

  var placeholderBlob = buildPlaceholderPdfBlob_(PUBLISH_PLACEHOLDER_TITLE_);
  var created = createMasterPdfFile_(config.masterFileName, config.masterFolderId, placeholderBlob);

  // ⚠️ 記低佔位檔嘅指紋：日後有人把它當成週報上載（實際發生過——先撳
  // 「開啟目前已發佈的 PDF」，再把同一個檔案選回來），就認得出並拒絕。
  writePublishScriptProperty_(
    PUBLISH_PLACEHOLDER_FINGERPRINT_KEY_,
    pdfFingerprint_(placeholderBlob.getBytes())
  );

  setConfig(CONFIG_KEYS.PUBLISHED_PDF_FILE_ID, created.fileId);
  appendAuditLog_({
    action: 'CREATE_MASTER_PUBLISH_FILE',
    sheetName: SHEETS.CONFIG, rowKey: CONFIG_KEYS.PUBLISHED_PDF_FILE_ID,
    field: 'VALUE', oldValue: '', newValue: maskPublishFileId_(created.fileId),
    notes: '已建立 master 發佈檔案；之後每次發佈都覆寫這一個檔案，檔案 ID 與連結不會再改變。'
  });

  return {
    ok: true, created: true, fileId: created.fileId,
    links: masterPdfLinks_(created.fileId),
    sharingApplied: created.sharingApplied, sharingError: created.sharingError
  };
}

/**
 * 用途：把檔案 ID 遮罩成「開頭幾個字元 ＋ …」，供 `AuditLog` 用。
 *   做法同 `maskContentFileId_()` 一致（嗰個專門畀內容表用，唔借用）。
 * Args:
 *   fileId {*} 檔案 ID。
 * Returns:
 *   {string}
 */
function maskPublishFileId_(fileId) {
  var id = String(fileId || '');
  if (!id) return '（空）';
  return id.slice(0, 6) + '…（共 ' + id.length + ' 字）';
}

/**
 * 用途：組出「建立 master 發佈檔案」對話框嘅內容行。**純函式。**
 * Args:
 *   result {Object} `ensureMasterPublishFile_()` 嘅回傳值（`ok:true`）。
 * Returns:
 *   {string[]}
 */
function buildMasterPublishFileLines_(result) {
  var o = result || {};
  var lines = [];

  lines.push(o.created ? '已建立 master 發佈檔案。' : 'master 發佈檔案已經存在，沒有重新建立。');
  if (o.created && !o.sharingApplied) {
    lines.push('⚠️ 未能自動設定分享權限' + (o.sharingError ? '（' + o.sharingError + '）' : '')
      + '。請人手把該檔案設為「知道連結的人可檢視」，否則會眾開不到。');
  } else if (o.created) {
    lines.push('分享權限：知道連結的人可檢視。');
  }

  lines.push('');
  lines.push('以下三條連結永遠不變，可以直接複製：');
  lines.push('檢視（一般會眾用）：' + o.links.view);
  lines.push('內嵌（放進網頁 iframe 用）：' + o.links.preview);
  lines.push('下載：' + o.links.download);
  lines.push('');
  lines.push('⚠️ 第一次發佈之前，請先在 Apps Script 編輯器啟用 Drive 進階服務（見幹事操作說明）。');
  return lines;
}

/**
 * 用途：選單項目「建立 master 發佈檔案」嘅處理函式。
 * Args: （無）
 * Returns:
 *   {void}
 */
function menuCreateMasterPublishFile_() {
  var ui = SpreadsheetApp.getUi();
  try {
    var result = ensureMasterPublishFile_();
    if (!result.ok) {
      ui.alert('未能建立 master 發佈檔案', result.message, ui.ButtonSet.OK);
      return;
    }
    ui.alert(
      result.created ? '已建立 master 發佈檔案' : 'master 發佈檔案已經存在',
      buildMasterPublishFileLines_(result).join('\n'),
      ui.ButtonSet.OK
    );
  } catch (err) {
    logMenuError_('menuCreateMasterPublishFile_', err);
    ui.alert('建立 master 發佈檔案失敗', enrichAuthError_(err), ui.ButtonSet.OK);
  }
}
