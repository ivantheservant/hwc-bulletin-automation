/**
 * SelfCheck.gs
 *
 * prompt9 第 4 部分：「完成度自我檢測」——Ivan 判斷「系統是否可以交付」
 * 的唯一依據。逐項自動檢測設定／資料／功能／紀錄四大類，每項輸出
 * 🟢／🟡／🔴 加一句說明，寫入 `Diagnostics`，並用對話框顯示三個數字。
 *
 * **🔴 的定義**：會令系統無法正常運作的項目（例如職事表沒設定、範本
 * 檔案讀不到）。**🟡**：可以運作但未完備（例如工作表保護未設定、
 * 尚有待填欄位）。
 *
 * ⚠️ 唯讀：本檔案全部檢查一律不寫入任何資料，只讀取現況——這份報告本身
 * 就是要給 Ivan 一個「現在系統長什麼樣」的忠實快照，不應該在檢查的
 * 過程中順手改動了什麼。
 */

'use strict';

var SELF_CHECK_STATUS_ = Object.freeze({ GREEN: '🟢', YELLOW: '🟡', RED: '🔴' });

/**
 * 用途：組出一個檢測項目。小工具，純粹減少重複打字。
 * Args:
 *   label {string} 項目名稱。
 *   status {string} `SELF_CHECK_STATUS_` 其中一個值。
 *   message {string} 一句說明。
 *   detail {string[]=} 選填，寫入 `Diagnostics` 的明細行（例如尊稱未設定
 *     名單、待填欄位明細）——只在報告內容出現，不影響對話框顯示的三個
 *     數字。省略時等於沒有明細。
 * Returns:
 *   {{label:string, status:string, message:string, detail:string[]}}
 */
function selfCheckItem_(label, status, message, detail) {
  return { label: label, status: status, message: message, detail: detail || [] };
}

/**
 * 用途：「WEBAPP_ALLOWED_EMAILS 有沒有包含部署者」那一項的判斷。**純函式。**
 *
 *   ⚠️ 報 🟡 不是 🔴：部署者**一律放行**，所以現況是可以用的，不是壞了。
 *   但清單建議加入，以免將來換人時有人以為「名單就是全部有權限的人」。
 * Args:
 *   allowedEmails {string[]} `WEBAPP_ALLOWED_EMAILS` 解析後的清單。
 *   deployerEmail {string} 部署者的電郵。
 *   statuses {Object} `SELF_CHECK_STATUS_`。
 * Returns:
 *   {[string, string, string]} `selfCheckItem_()` 的三個參數。
 */
function buildDeployerInAllowlistItem_(allowedEmails, deployerEmail, statuses) {
  var label = '填寫介面授權名單';
  var deployer = String(deployerEmail || '').trim().toLowerCase();
  var list = (allowedEmails || [])
    .map(function (e) { return String(e || '').trim().toLowerCase(); })
    .filter(function (e) { return e.length > 0; });

  if (!deployer) {
    return [label, statuses.YELLOW,
      '查不到部署者的電郵，所以比不到。⚠️ 「比不到」不等於「沒問題」。'];
  }
  if (list.length === 0) {
    return [label, statuses.YELLOW,
      'WEBAPP_ALLOWED_EMAILS 是空的——目前只有部署者（' + deployer + '）用得到填寫介面。'
        + '要讓同工使用，請把他們的電郵加進去（逗號分隔）。'];
  }
  if (list.indexOf(deployer) === -1) {
    return [label, statuses.YELLOW,
      'WEBAPP_ALLOWED_EMAILS 目前有 ' + list.length + ' 個電郵，但**不包含部署者**（'
        + deployer + '）。'
        + '部署者仍然可以使用（系統一律放行），但清單建議加入，以免將來換人時混亂'
        + '——看名單的人會以為那就是全部有權限的人。'];
  }
  return [label, statuses.GREEN,
    'WEBAPP_ALLOWED_EMAILS 有 ' + list.length + ' 個電郵，包含部署者（' + deployer + '）。'];
}

/**
 * 用途：「檢測季度」這一項的中文說明短語，依 `resolveWorkingQuarter_()`
 *   實際用了哪一層而不同。
 * Args:
 *   source {string} `resolveWorkingQuarter_()` 回傳的 `source`。
 * Returns:
 *   {string}
 */
function selfCheckQuarterSourcePhrase_(source) {
  var phrases = {
    NEXT_SEND_SUNDAY: '由下一個要寄的主日推算',
    ROSTER_TEST_DATE: '職事表沒有下一個主日的資料，改用設定值 ROSTER_TEST_DATE 推算',
    CONFIG_OVERRIDE: '設定值 WORKING_QUARTER_ID 指定',
    BULLETIN_WEEKS_LATEST: '前三層都推算失敗，改用 BulletinWeeks 現有資料推算'
  };
  return phrases[source] || source;
}

/**
 * 用途：「檢測季度」這一項檢測——把 `resolveWorkingQuarter_()` 的結果
 *   排版成一句人看得懂的說明。**不可以靜靜退回而不講用了哪一層**（見
 *   `docs/已知bug類型.md` 第 27 條的同一類問題：靜靜退回沒有錯誤訊息）。
 * Args:
 *   quarterResolution {Object} `resolveWorkingQuarter_()` 的回傳值。
 * Returns:
 *   {{label:string, status:string, message:string, detail:string[]}}
 */
function selfCheckQuarterItem_(quarterResolution) {
  var S = SELF_CHECK_STATUS_;
  var qr = quarterResolution;

  if (!qr.ok) {
    return selfCheckItem_('檢測季度', S.YELLOW, '四層推算全部失敗，見下方明細。', qr.notes);
  }

  var message = '本季 ' + qr.quarterId + '（' + selfCheckQuarterSourcePhrase_(qr.source) + '）';
  if (qr.source === 'CONFIG_OVERRIDE' && qr.notes.some(function (n) { return n.indexOf('找不到') !== -1; })) {
    message += '　⚠️ 設定值指定的季度在職事表找不到，請確認 WORKING_QUARTER_ID 是否打錯。';
  }
  return selfCheckItem_('檢測季度', S.GREEN, message, qr.notes);
}

// =====================================================================
// 設定類
// =====================================================================

/**
 * 用途：設定類的全部檢測項目。
 * Args: （無）
 * Returns:
 *   {{label:string, status:string, message:string}[]}
 */
function selfCheckConfigItems_() {
  var items = [];
  var S = SELF_CHECK_STATUS_;

  // ---- ROSTER_SPREADSHEET_ID ----
  var rosterId = getConfig(CONFIG_KEYS.ROSTER_SPREADSHEET_ID, '');
  if (!rosterId) {
    items.push(selfCheckItem_('職事表試算表 ID', S.RED, '尚未設定 ROSTER_SPREADSHEET_ID。'));
  } else {
    try {
      readRosterSnapshot_(getConfig(CONFIG_KEYS.ROSTER_TEST_DATE, '2027-10-03'));
      items.push(selfCheckItem_('職事表試算表 ID', S.GREEN, '已設定且讀得到。'));
    } catch (err) {
      items.push(selfCheckItem_('職事表試算表 ID', S.RED, '已設定但讀取失敗：' + ((err && err.message) ? err.message : String(err))));
    }
  }

  // ---- 三個 TEMPLATE_FILE_ID_* ----
  var templateChecks = [
    { key: CONFIG_KEYS.TEMPLATE_FILE_ID_NORMAL, label: '平常主日 Word 範本', critical: true },
    { key: CONFIG_KEYS.TEMPLATE_FILE_ID_COMBINED_BAPTISM, label: '浸禮三堂聯合崇拜 Word 範本', critical: false },
    { key: CONFIG_KEYS.TEMPLATE_FILE_ID_ANNIVERSARY, label: '堂慶三堂聯合崇拜 Word 範本', critical: false }
  ];
  templateChecks.forEach(function (t) {
    var fileId = getConfig(t.key, '');
    if (!fileId) {
      items.push(selfCheckItem_(t.label, t.critical ? S.RED : S.YELLOW, '尚未設定 ' + t.key + '。'));
      return;
    }
    try {
      readTemplateBlob_(fileId);
      items.push(selfCheckItem_(t.label, S.GREEN, '已設定、檔案存在、MIME 正確。'));
    } catch (err) {
      items.push(selfCheckItem_(t.label, S.RED, '已設定但讀取失敗：' + ((err && err.message) ? err.message : String(err))));
    }
  });

  // ---- BULLETIN_OUTPUT_FOLDER_ID ----
  var folderId = getConfig(CONFIG_KEYS.BULLETIN_OUTPUT_FOLDER_ID, '');
  var folderCheck = checkOutputFolderAccessible_(folderId);
  items.push(selfCheckItem_('週報輸出資料夾', folderCheck.ok ? S.GREEN : (folderId ? S.RED : S.YELLOW), folderCheck.message));

  // ---- Recipients 各組別人數、DRY_RUN ----
  var recipientsByGroup = {};
  readSheet(SHEETS.RECIPIENTS).forEach(function (r) {
    if (r.ACTIVE !== true) return;
    var g = String(r.GROUP_NAME || '（未分組）');
    recipientsByGroup[g] = (recipientsByGroup[g] || 0) + 1;
  });
  var groupSummary = Object.keys(recipientsByGroup).sort().map(function (g) {
    return g + '：' + recipientsByGroup[g] + ' 人';
  }).join('　');
  var recipientStatus = evaluateRecipientCoverage_(recipientsByGroup);
  items.push(selfCheckItem_(
    'Recipients 收件人',
    recipientStatus.status,
    recipientStatus.message + (groupSummary ? ('　目前：' + groupSummary) : '')
  ));

  var dryRun = getConfig(CONFIG_KEYS.DRY_RUN, 'TRUE');
  items.push(selfCheckItem_('DRY_RUN 目前值', S.GREEN, dryRun));

  // ---- WEBAPP_ALLOWED_EMAILS 有沒有包含部署者 ----
  //
  //    ⚠️ 這一項報 🟡 不是 🔴：部署者**一律放行**（見 isEmailAuthorized_()），
  //    所以現況是可以用的，不是壞了。但清單建議加入，以免將來換人時
  //    有人以為「名單就是全部有權限的人」而查半日。
  //
  //    這一項的來由：實際發生過名單只有兩個同工、部署者本人不在裏面，
  //    於是自己開不到自己部署的 Web App。
  var allowedEmails = getConfigTextList_(CONFIG_KEYS.WEBAPP_ALLOWED_EMAILS, '');
  var deployerEmail = getEffectiveEmail_();
  items.push(selfCheckItem_.apply(null, buildDeployerInAllowlistItem_(allowedEmails, deployerEmail, S)));

  // ---- 工作表結構 ----
  var schema = checkSheetSchema_();
  items.push(selfCheckItem_(
    '工作表結構（Config 鍵數與程式碼期望值一致）',
    schema.ok ? S.GREEN : S.RED,
    schema.ok ? '一致。' : buildSchemaShortSummary_(schema)
  ));

  return items;
}

// =====================================================================
// 資料類
// =====================================================================

/**
 * 用途：算出「本季待填欄位總數」的**逐主日彙總**——每個有待填欄位的
 *   主日一筆，不是每個欄位一行。**這是修正報告被明細擠爆的核心**（見
 *   `docs/已知bug類型.md`「報告被自己的明細擠爆」）：完整的逐欄位明細
 *   移去選單「本季待填清單」（`buildQuarterMissingFieldsReportLines_()`），
 *   自我檢測報告只印精簡摘要。
 * Args:
 *   serviceDates {{isoDate:string}[]} `listQuarterServiceDates_()` 的輸出。
 * Returns:
 *   {{perDate:{isoDate:string, count:number, line:string}[], totalMissing:number}}
 *     `perDate` 只含「有待填」的主日，依 `serviceDates` 原本次序；
 *     `line` 括號內最多列 3 個欄位中文名，超過 3 個加「等」。
 */
function selfCheckMissingSummaryByDate_(serviceDates) {
  var perDate = [];
  var totalMissing = 0;

  (serviceDates || []).forEach(function (sd) {
    try {
      var missing = buildBulletinModel_(sd.isoDate).missing || [];
      if (missing.length === 0) return;
      totalMissing += missing.length;
      var topLabels = missing.slice(0, 3).map(function (m) { return m.label; });
      var suffix = missing.length > 3 ? ' 等' : '';
      perDate.push({
        isoDate: sd.isoDate,
        count: missing.length,
        line: sd.isoDate + '　' + missing.length + ' 項待填（' + topLabels.join('、') + suffix + '）'
      });
    } catch (perDateErr) {
      // 單一主日算不出來不應該讓整個自我檢測失敗，忽略即可——
      // 那個主日本身的問題會在其他檢測項目或演練報告裡看得到。
    }
  });

  return { perDate: perDate, totalMissing: totalMissing };
}

/**
 * 用途：把 `selfCheckMissingSummaryByDate_()` 的逐主日彙總行，截到
 *   Config `SELFCHECK_MISSING_DETAIL_ROWS`（預設 20）以內，超過的部分
 *   以「尚有 N 項未列出」帶過——`N` 是被截掉那些主日的**待填欄位總數**
 *   （不是被截掉的主日數，「項」跟本項目訊息「N 項（共 M 個主日）」
 *   用同一個單位一致），並指路到選單「本季待填清單」查完整明細。
 * Args:
 *   perDate {{isoDate:string, count:number, line:string}[]}
 *     `selfCheckMissingSummaryByDate_()` 回傳的 `perDate`。
 * Returns:
 *   {string[]} 明細行；被截斷時最後一行是提示句。
 */
function selfCheckCapMissingSummary_(perDate) {
  var maxRows = normalizeInt_(getConfig(CONFIG_KEYS.SELFCHECK_MISSING_DETAIL_ROWS, '20'));
  if (!maxRows || maxRows < 1) maxRows = 20;

  if (perDate.length <= maxRows) {
    return perDate.map(function (d) { return d.line; });
  }

  var shown = perDate.slice(0, maxRows);
  var hidden = perDate.slice(maxRows);
  var hiddenFieldsCount = hidden.reduce(function (sum, d) { return sum + d.count; }, 0);

  return shown.map(function (d) { return d.line; })
    .concat(['尚有 ' + hiddenFieldsCount + ' 項未列出，請用選單「本季待填清單」查看完整明細。']);
}

/**
 * 用途：資料類的全部檢測項目。
 *
 *   ⚠️ 「尊稱未設定人數」與「待填欄位總數」一律用同一個
 *   `quarterResolution.quarterId`——不可以任何一項自己再猜一次季度，
 *   否則兩項可能各自報不同季的數字，見 `docs/已知bug類型.md` 第 3 類。
 * Args:
 *   quarterResolution {Object} `resolveWorkingQuarter_()` 的回傳值，由
 *     `runSelfCheck_()` 只算一次、向下傳給本函式。
 * Returns:
 *   {{label:string, status:string, message:string, detail:string[]}[]}
 */
function selfCheckDataItems_(quarterResolution) {
  var items = [];
  var S = SELF_CHECK_STATUS_;

  var weekRows = readSheet(SHEETS.BULLETIN_WEEKS);
  var quarterIds = {};
  weekRows.forEach(function (r) { if (r.QUARTER_ID) quarterIds[r.QUARTER_ID] = true; });
  items.push(selfCheckItem_(
    'BulletinWeeks 資料量',
    weekRows.length > 0 ? S.GREEN : S.YELLOW,
    Object.keys(quarterIds).length + ' 季、' + weekRows.length + ' 個主日。'
  ));

  var currentQuarterId = quarterResolution.ok ? quarterResolution.quarterId : null;

  if (currentQuarterId) {
    var personDisplayRows = readSheet(SHEETS.PERSON_DISPLAY);
    try {
      // ⚠️ listRosterQuarterAssignedPersons_() 要的是一個「屬於這一季的
      // 主日日期」，不是季度 ID 本身——沿用 listRosterServiceDatesForQuarter_()
      // 取這一季隨便一個（第一個）主日，不重寫「日期查季度」那一套邏輯，
      // 也不會因為用了跟「待填欄位總數」不同的日期而算出不同的季度。
      var quarterDates = listRosterServiceDatesForQuarter_(currentQuarterId);
      if (quarterDates.length === 0) {
        throw new Error('職事表 ServiceDates 找不到季度「' + currentQuarterId + '」的任何主日。');
      }
      var quarterInfo = listRosterQuarterAssignedPersons_(quarterDates[0]);
      var missingHonorific = buildHonorificMissingList_(quarterInfo.persons, personDisplayRows);
      items.push(selfCheckItem_(
        'PersonDisplay 尊稱未設定人數',
        missingHonorific.length === 0 ? S.GREEN : S.YELLOW,
        missingHonorific.length + ' 人（本季共 ' + quarterInfo.persons.length + ' 人有事奉）。',
        missingHonorific.map(function (p) { return p.personId + '　' + (p.nameTC || '（無姓名）'); })
      ));
    } catch (err) {
      items.push(selfCheckItem_('PersonDisplay 尊稱未設定人數', S.YELLOW, '無法計算：' + ((err && err.message) ? err.message : String(err))));
    }

    try {
      // 主日清單只准經這一支拿（見 src/ServiceDates.gs 檔頭）。
      var quarterDates = resolveQuarterServiceDateEntries_(currentQuarterId);
      var serviceDates = quarterDates.entries;
      var missingSummary = selfCheckMissingSummaryByDate_(serviceDates);
      items.push(selfCheckItem_(
        '本季（' + currentQuarterId + '）待填欄位總數',
        missingSummary.totalMissing === 0 ? S.GREEN : S.YELLOW,
        missingSummary.totalMissing + ' 項（共 ' + serviceDates.length + ' 個主日）。'
          // 主日清單不是來自職事表就一定要講明，否則「共 N 個主日」看起來
          // 像職事表已經有這一季。見 src/ServiceDates.gs。
          + (serviceDateSourceNote_(quarterDates) ? ('　' + serviceDateSourceNote_(quarterDates)) : ''),
        selfCheckCapMissingSummary_(missingSummary.perDate)
      ));
    } catch (err) {
      items.push(selfCheckItem_('本季待填欄位總數', S.YELLOW, '無法計算：' + ((err && err.message) ? err.message : String(err))));
    }
  } else {
    items.push(selfCheckItem_('PersonDisplay 尊稱未設定人數', S.YELLOW, '未能決定季度，見『檢測季度』一項。'));
    items.push(selfCheckItem_('本季待填欄位總數', S.YELLOW, '未能決定季度，見『檢測季度』一項。'));
  }

  [
    { sheetId: 'FELLOWSHIPS', label: 'Fellowships（團契）' },
    { sheetId: 'ANNOUNCEMENTS', label: 'Announcements（家事報告）' },
    { sheetId: 'PRAYERS', label: 'Prayers（代禱事項）' }
  ].forEach(function (s) {
    var rows = readSheet(SHEETS[s.sheetId]);
    items.push(selfCheckItem_(s.label + ' 有無資料', rows.length > 0 ? S.GREEN : S.YELLOW, rows.length + ' 行。'));
  });

  return items;
}

// =====================================================================
// 功能類
// =====================================================================

/**
 * 用途：功能類的全部檢測項目。
 * Args: （無）
 * Returns:
 *   {{label:string, status:string, message:string}[]}
 */
/**
 * 用途：列出仍然有職事表缺口的季度（R-036）。
 *
 *   ⚠️ 一律是 🟡，不是 🔴：職事表未到是**正常狀態**，不是錯誤。但它也
 *   絕對不是「沒事」——那幾期的事奉欄位是空的，印出來會少一塊。
 * Args: （無）
 * Returns:
 *   {Object} `selfCheckItem_()` 的結果。
 */
function selfCheckRosterGapItem_() {
  var S = SELF_CHECK_STATUS_;
  var gaps;
  try {
    gaps = listQuartersWithRosterGaps_();
  } catch (err) {
    return selfCheckItem_('職事表缺口', S.YELLOW,
      '算不到：' + ((err && err.message) ? err.message : String(err)));
  }

  if (gaps.length === 0) {
    return selfCheckItem_('職事表缺口', S.GREEN, '每一季的事奉資料都齊備。');
  }

  var detail = gaps.map(function (entry) {
    var quarterId = entry.quarterId;
    return quarterId + '：共 ' + entry.total + ' 個主日，其中 '
      + entry.notFound + ' 個整季找不到、' + entry.partial + ' 個部分找不到';
  });
  return selfCheckItem_('職事表缺口', S.YELLOW,
    '有 ' + gaps.length + ' 個季度的事奉資料未齊（那幾期的事奉欄位留空）。'
      + '職事表補齊之後，撳選單「從職事表補抓」。',
    detail);
}

/**
 * 用途：判斷 `Recipients` 的組別覆蓋率夠不夠成為 🟢。
 *
 *   ⚠️ 只有 ADMIN 一組**不是**綠燈。「發佈與寄出」的收件對象勾選
 *   （R-004）表面上做好了，實際上寄出去只會到幹事自己一個人手上，
 *   而且**不會有任何錯誤訊息**——寄成功、`SendLog` 綠色、封數 1。
 *   這一種「靜靜地做了一件不是使用者要的事」正是自我檢測要抓的。
 *   見需求登記 R-029。
 * Args:
 *   byGroup {Object<string,number>} 組別 → 有效收件人數。
 * Returns:
 *   {{status:string, message:string, missingGroups:string[]}}
 */
function evaluateRecipientCoverage_(byGroup) {
  var S = SELF_CHECK_STATUS_;
  var groups = byGroup || {};
  var names = Object.keys(groups);

  if (names.length === 0) {
    return {
      status: S.YELLOW,
      missingGroups: [RECIPIENT_GROUP.CC, RECIPIENT_GROUP.DB, RECIPIENT_GROUP.IT],
      message: 'Recipients 工作表沒有任何有效的收件人。'
    };
  }

  // 週報真正要寄給的三組。ADMIN／TEST／WORSHIP 是另一回事，不計入。
  var required = [RECIPIENT_GROUP.CC, RECIPIENT_GROUP.DB, RECIPIENT_GROUP.IT];
  var missing = required.filter(function (g) { return !groups[g]; });

  if (missing.length === 0) {
    return { status: S.GREEN, missingGroups: [], message: '三組收件人齊備。' };
  }

  return {
    status: S.YELLOW,
    missingGroups: missing,
    message: '仍欠 ' + missing.join('、') + ' 這 ' + missing.length + ' 組收件人（需求登記 R-029）。'
      + '現在寄出去只會到已填那幾組手上，而且不會有任何錯誤訊息。'
  };
}

/**
 * 用途：仍是「未開始」或「進行中」的需求編號與標題。
 *
 *   ⚠️ 這一份刻意**寫死在程式碼裡**，與 docs/需求登記.md 人手同步。
 *   Apps Script 讀不到 repo 的 Markdown 檔案，而「自我檢測報告要列出
 *   未完成的需求」這件事的價值，在於幹事按一下就見到——不是在於它
 *   自動從哪裡讀出來。
 *
 *   ⚠️ 兩邊分岔的方向如果是「這裡漏了一條」，後果是自我檢測報「全部
 *   完成」而其實未完成。所以每次改需求狀態，兩個地方都要改。
 * Args: （無）
 * Returns:
 *   {{id:string, title:string, state:string}[]}
 */
function unfinishedRequirements_() {
  return [
    { id: 'R-016', state: '未開始', title: '三個範本交堂委會試印確認版面' },
    { id: 'R-017', state: '未開始', title: '2026-12-04 職事表上線後，用真數據做全季演練' },
    { id: 'R-018', state: '未開始', title: '移交幹事角色帳戶' },
    { id: 'R-020', state: '未開始', title: '內容過多自動加頁、過少處理留白' },
    { id: 'R-027', state: '進行中', title: '自測機四層——第 2、3 層尚未在真環境跑過' },
    { id: 'R-028', state: '未開始', title: '星期一觸發器真環境驗證' },
    { id: 'R-029', state: '未開始', title: 'Recipients 填齊 CC、DB、IT 三組收件人' }
  ];
}

/**
 * 用途：把未完成需求排成一個自我檢測項目。
 *
 *   ⚠️ 一律是 🟡，不是 🟢 也不是 🔴：有未完成的需求是**正常狀態**，
 *   不是錯誤；但它也絕對不是「全部搞掂」。用綠色會令人以為做完了。
 * Args: （無）
 * Returns:
 *   {Object} `selfCheckItem_()` 的結果。
 */
function selfCheckUnfinishedRequirementsItem_() {
  var S = SELF_CHECK_STATUS_;
  var list = unfinishedRequirements_();
  if (list.length === 0) {
    return selfCheckItem_('未完成的需求', S.GREEN, '需求登記上沒有未開始或進行中的項目。');
  }
  var detail = list.map(function (r) {
    // ⚠️ 先取出成獨立變數再串接：夾在引號之間的屬性存取，如果屬性名
    //    啱好是一個真實的 gTLD，會被 tools/scan-staged-secrets.js 誤判
    //    成網域，見事故六。
    var reqId = r.id;
    var reqTitle = r.title;
    return reqId + '（' + r.state + '）：' + reqTitle;
  });
  return selfCheckItem_(
    '未完成的需求',
    S.YELLOW,
    '需求登記上仍有 ' + list.length + ' 條未完成（詳見 docs/需求登記.md）。',
    detail
  );
}

function selfCheckFeatureItems_() {
  var items = [];
  var S = SELF_CHECK_STATUS_;

  var handlers = {};
  ScriptApp.getProjectTriggers().forEach(function (t) {
    var h = t.getHandlerFunction();
    handlers[h] = (handlers[h] || 0) + 1;
  });

  var sendInstalled = Boolean(handlers['weeklyBulletinSendTrigger_']);
  items.push(selfCheckItem_('觸發器：自動寄送', sendInstalled ? S.GREEN : S.YELLOW, sendInstalled ? '已安裝。' : '尚未安裝，需要人手撳選單安裝。'));

  var fillEditInstalled = Boolean(handlers['onFillGridEdit_']);
  items.push(selfCheckItem_('觸發器：填寫表同步', fillEditInstalled ? S.GREEN : S.YELLOW, fillEditInstalled ? '已安裝。' : '尚未安裝。'));

  var reconcileInstalled = Boolean(handlers['fillReconcileTrigger_']);
  items.push(selfCheckItem_('觸發器：填寫表對帳', reconcileInstalled ? S.GREEN : S.YELLOW, reconcileInstalled ? '已安裝。' : '尚未安裝。'));

  // ⚠️「下一季提示」（autoCreateNextQuarterFillGrids_）不是獨立的觸發器，
  // 是每週自動寄送流程 weeklyBulletinSendTrigger_ 順手做的一部分，
  // 見 src/Trigger.gs／src/FillAdmin.gs——所以這裡的安裝狀態跟「自動
  // 寄送」共用同一個判斷依據，不是另外裝一個。
  items.push(selfCheckItem_(
    '觸發器：下一季提示（隨自動寄送觸發器一起執行）',
    sendInstalled ? S.GREEN : S.YELLOW,
    sendInstalled ? '會隨每週自動寄送一起檢查。' : '自動寄送觸發器未安裝，這個功能也不會執行。'
  ));

  var webAppUrl = getConfig(CONFIG_KEYS.WEBAPP_URL, '');
  items.push(selfCheckItem_('Web App 部署', webAppUrl ? S.GREEN : S.YELLOW, webAppUrl ? '已部署（' + webAppUrl + '）。' : 'WEBAPP_URL 是空的，尚未填入部署後的網址。'));

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var protectedCount = protectedSheetNames_().filter(function (name) {
    var sheet = ss.getSheetByName(name);
    return sheet && sheet.getProtections(SpreadsheetApp.ProtectionType.SHEET).length > 0;
  }).length;
  var totalProtectable = protectedSheetNames_().length;
  items.push(selfCheckItem_(
    '工作表保護',
    protectedCount === totalProtectable ? S.GREEN : S.YELLOW,
    protectedCount + '／' + totalProtectable + ' 張已設定保護。'
  ));

  var placeholderReport = inspectTemplatePlaceholders_();
  placeholderReport.templates.forEach(function (t) {
    if (!t.configured) return; // 範本未設定已經在設定類報過，這裡不重複。
    if (t.error) {
      items.push(selfCheckItem_('範本佔位符對帳：' + t.label, S.RED, '讀取失敗：' + t.error));
      return;
    }
    var unknownCount = t.unknownValues.length + t.unknownLists.length;
    items.push(selfCheckItem_(
      '範本佔位符對帳：' + t.label,
      unknownCount === 0 ? S.GREEN : S.RED,
      unknownCount === 0
        ? '範本用到的佔位符系統全部都有提供。'
        : '範本用到但系統不提供：' + t.unknownValues.concat(t.unknownLists).join('、')
    ));
  });

  return items;
}

// =====================================================================
// 發佈及匯出類（prompt-pre-usertest 新增，放在既有項目之後）
// =====================================================================

/**
 * 用途：發佈及匯出（R-001 至 R-009）相關的檢測項目。**放在既有項目之
 *   後**——這一輪是後補的，不要打亂原有設定／資料／功能／紀錄四大類
 *   的次序，讓已經習慣舊報告版面的人看得出「這幾項是新加的」。
 * Args:
 *   quarterResolution {Object} `resolveWorkingQuarter_()` 的回傳值——
 *     跟其餘檢測項目共用同一次推算結果，不可以自己再猜一次季度
 *     （見本檔案檔頭與 docs/已知bug類型.md 第 3 類）。
 * Returns:
 *   {{label:string, status:string, message:string, detail:string[]}[]}
 */
function selfCheckPublishItems_(quarterResolution) {
  var items = [];
  var S = SELF_CHECK_STATUS_;
  var config = publishConfig_();

  // ---- Drive 進階服務是否可用 ----
  var driveProbe = probeDriveAdvancedService_();
  items.push(selfCheckItem_(
    'Drive 進階服務（發佈用）',
    driveProbe.ok ? S.GREEN : S.YELLOW,
    driveProbe.ok
      ? '可用。'
      : '尚未啟用或無法呼叫：' + driveProbe.message
        + '　請在 Apps Script 編輯器的「服務」加入 Drive API（版本 v2）。'
  ));

  // ---- 三個資料夾 Config 是否已填 ----
  [
    { key: CONFIG_KEYS.PUBLISHED_PDF_FOLDER_ID, label: 'master 發佈檔案資料夾' },
    { key: CONFIG_KEYS.PUBLISHED_ARCHIVE_FOLDER_ID, label: '發佈存檔資料夾' },
    { key: CONFIG_KEYS.CONTENT_SHEET_FOLDER_ID, label: '內容表資料夾' }
  ].forEach(function (f) {
    var value = String(getConfig(f.key, '') || '').trim();
    items.push(selfCheckItem_(
      'Config：' + f.label,
      value ? S.GREEN : S.YELLOW,
      value ? '已填。' : '尚未設定 ' + f.key + '。'
    ));
  });

  // ---- master 發佈檔案已建立且開得到 ----
  if (!config.masterFileId) {
    items.push(selfCheckItem_('master 發佈檔案', S.YELLOW, '尚未建立，請撳選單「建立 master 發佈檔案」。'));
  } else {
    var probe = probeMasterPdfFile_(config.masterFileId);
    if (probe.exists) {
      items.push(selfCheckItem_('master 發佈檔案', S.GREEN, '已建立且開得到（' + probe.fileName + '）。'));
    } else if (probe.serviceUnavailable) {
      items.push(selfCheckItem_('master 發佈檔案', S.YELLOW, 'Drive 進階服務未啟用，暫時無法確認（見上一項）。'));
    } else {
      items.push(selfCheckItem_('master 發佈檔案', S.YELLOW,
        'Config 已有檔案 ID 但目前開不到，可能已被刪除或搬移，請確認。'));
    }
  }

  // ---- ⚠️ 正式 master 不可以等於沙盒 master（事故四十三）----
  //
  //    這一條刻意報 🔴 不是 🟡：兩者相同的話，自測機每一次發佈都會覆寫
  //    教會網站那條連結指向的 PDF，而且完全沒有錯誤訊息。那不是「有機會
  //    出事」，是「正式輸出已經指向錯的地方」。
  var distinct = checkMasterFileIdsDistinct_();
  if (distinct.ok === false) {
    items.push(selfCheckItem_('正式與沙盒 master 檔案', S.RED, distinct.message));
  } else if (distinct.ok === null) {
    items.push(selfCheckItem_('正式與沙盒 master 檔案', S.YELLOW, distinct.message));
  } else {
    items.push(selfCheckItem_('正式與沙盒 master 檔案', S.GREEN, distinct.message));
  }

  // ---- ⚠️ Config 的 master 檔案 ID 對得上 PublishLog 最新一行正式紀錄 ----
  //
  //    系統本來就有足夠資料自己發現「Config 那一格被換走了」，只是從來
  //    沒有人比對過。這一項就是那個比對。
  var matchesLog = checkPublishedMasterMatchesLog_();
  if (matchesLog.ok === false) {
    items.push(selfCheckItem_('master 檔案 ID 對得上發佈紀錄', S.RED, matchesLog.message));
  } else if (matchesLog.ok === null) {
    items.push(selfCheckItem_('master 檔案 ID 對得上發佈紀錄', S.YELLOW, matchesLog.message));
  } else {
    items.push(selfCheckItem_('master 檔案 ID 對得上發佈紀錄', S.GREEN, matchesLog.message));
  }

  // ---- 本季內容表是否已建立、最後匯入時間 ----
  var currentQuarterId = quarterResolution.ok ? quarterResolution.quarterId : null;
  if (!currentQuarterId) {
    items.push(selfCheckItem_('本季內容表', S.YELLOW, '未能決定季度，見『檢測季度』一項。'));
  } else {
    var contentRow = null;
    try {
      contentRow = findContentSheetRow_(currentQuarterId);
    } catch (err) {
      contentRow = null;
    }
    if (!contentRow) {
      items.push(selfCheckItem_('本季（' + currentQuarterId + '）內容表', S.YELLOW, '尚未建立。'));
    } else {
      var lastImported = (contentRow.LAST_IMPORTED_AT instanceof Date)
        ? Utilities.formatDate(contentRow.LAST_IMPORTED_AT, config.timezone, 'yyyy-MM-dd HH:mm')
        : '尚未匯入過';
      items.push(selfCheckItem_('本季（' + currentQuarterId + '）內容表', S.GREEN, '已建立。最後匯入：' + lastImported + '。'));
    }
  }

  // ---- 最近一次發佈的主日與版本 ----
  var publishRows = [];
  try {
    publishRows = readSheet(SHEETS.PUBLISH_LOG);
  } catch (err) {
    publishRows = [];
  }
  var latestPublish = latestPublishLogRow_(publishRows);
  items.push(selfCheckItem_(
    '最近一次發佈',
    latestPublish ? S.GREEN : S.YELLOW,
    latestPublish
      ? publishRowIsoDate_(latestPublish) + '（第 ' + Number(latestPublish.VERSION_NO || 0) + ' 版）。'
      : '尚未發佈過任何一期。'
  ));

  return items;
}

// =====================================================================
// 不變量（第 1 層）
// =====================================================================

/**
 * 用途：跑一次全部不變量，收成**一個**檢測大項。
 *
 *   ⚠️ 刻意只收成一項、而不是十項：不變量本身已經有自己的完整報告
 *   （`menuRunInvariants_()` 寫入 Diagnostics 的「不變量檢查」），
 *   在自我檢測這邊再攤開十行，只會把原本那份報告擠爆——那正是
 *   docs/已知bug類型.md 事故二十一。這裡要的是一盞燈加一句摘要，
 *   明細放在 `detail`（受既有的兩段式行數預算管制）。
 *
 *   ⚠️ 任何一條不變量**不成立**就報 🔴；「驗證不到」只在摘要講一句，
 *   不當成失敗——擋住流程的應該是「證明錯了」，不是「證明不到」。
 * Args: （無）
 * Returns:
 *   {{label:string, status:string, message:string, detail:string[]}[]}
 */
function selfCheckInvariantItems_() {
  var S = SELF_CHECK_STATUS_;
  try {
    var summary = runAllInvariants_();
    var status = summary.failedCount > 0 ? S.RED : (summary.unknownCount > 0 ? S.YELLOW : S.GREEN);
    return [selfCheckItem_(
      '不變量檢查（' + summary.results.length + ' 條）',
      status,
      buildInvariantShortSummary_(summary),
      summary.results
        .filter(function (r) { return r.ok !== true; })
        .map(function (r) {
          // ⚠️ 刻意先把編號取出來另存一個變數，不要在同一行內把這個屬性
          // 存取夾在兩個引號中間——那樣寫會被 tools/scan-staged-secrets.js
          // 的網域偵測誤判成網域（這個屬性名剛好撞正一個真實頂層網域）。
          // 這是 docs/已知bug類型.md 事故六提到的同一類問題，不應該為了
          // 遷就命名而放寬掃描器。
          var invariantId = r.id;
          var mark = r.ok === false ? '🔴 ' : '⚪ ';
          return mark + invariantId + '　預期：' + r.expected
            + '　實際：' + r.actual + '　證據：' + r.evidence;
        })
    )];
  } catch (err) {
    return [selfCheckItem_('不變量檢查', S.YELLOW,
      '無法執行：' + ((err && err.message) ? err.message : String(err)))];
  }
}

// =====================================================================
// 紀錄類
// =====================================================================

/**
 * 用途：紀錄類的全部檢測項目。
 * Args: （無）
 * Returns:
 *   {{label:string, status:string, message:string}[]}
 */
function selfCheckLogItems_() {
  var items = [];
  var S = SELF_CHECK_STATUS_;

  var sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  var recentErrors = readSheet(SHEETS.ERROR_LOG).filter(function (r) {
    return r.TIMESTAMP instanceof Date && r.TIMESTAMP >= sevenDaysAgo;
  });
  items.push(selfCheckItem_(
    'ErrorLog 最近 7 日錯誤數',
    recentErrors.length > 0 ? S.YELLOW : S.GREEN,
    recentErrors.length + ' 筆。'
  ));

  var sendLogRows = readSheet(SHEETS.SEND_LOG);
  if (sendLogRows.length === 0) {
    items.push(selfCheckItem_('SendLog 最近一次寄送', S.YELLOW, '從未寄送過（或試寄過）。'));
  } else {
    var latest = sendLogRows.reduce(function (best, r) {
      if (!(r.TIMESTAMP instanceof Date)) return best;
      if (!best || r.TIMESTAMP > best.TIMESTAMP) return r;
      return best;
    }, null);
    items.push(selfCheckItem_(
      'SendLog 最近一次寄送',
      S.GREEN,
      latest ? (formatDateForBatchReport_(latest.TIMESTAMP) + '　狀態：' + latest.STATUS + '　試行：' + latest.DRY_RUN) : '（找不到有效時間戳記的記錄）'
    ));
  }

  items.push(selfCheckItem_('AuditLog 行數', S.GREEN, readSheet(SHEETS.AUDIT_LOG).length + ' 行。'));

  return items;
}

// =====================================================================
// 總入口
// =====================================================================

/**
 * 用途：「完成度自我檢測」的真正入口。跑完設定／資料／功能／紀錄四大類
 *   全部檢測項目，寫入 `Diagnostics`（報告名稱「完成度自我檢測」）。
 *   **唯讀**，不寫入任何資料。
 *
 *   ⚠️ `resolveWorkingQuarter_()`（`src/QuarterResolve.gs`）**只叫一次**，
 *   結果向下傳給 `selfCheckDataItems_()`——不可以任何一個檢測項自己
 *   再猜一次季度，見 `docs/已知bug類型.md` 第 3 類。
 * Args: （無）
 * Returns:
 *   {{items:Object[], greenCount:number, yellowCount:number, redCount:number,
 *     quarterResolution:Object}}
 */
function runSelfCheck_() {
  var quarterResolution = resolveWorkingQuarter_();

  var items = []
    .concat(selfCheckConfigItems_())
    .concat([selfCheckQuarterItem_(quarterResolution)])
    .concat(selfCheckDataItems_(quarterResolution))
    .concat(selfCheckFeatureItems_())
    .concat(selfCheckLogItems_())
    // prompt-pre-usertest：發佈及匯出相關檢測，放在既有項目之後。
    .concat(selfCheckPublishItems_(quarterResolution))
    // 自測機那一輪：不變量收成一個大項。
    .concat(selfCheckInvariantItems_())
    // 第一輪自測之後：未完成的需求排在最後——看報告的人最後見到的
    // 應該是「還有什麼未做」，不是一堆綠燈。
    .concat([selfCheckRosterGapItem_()])
    .concat([selfCheckUnfinishedRequirementsItem_()]);

  var S = SELF_CHECK_STATUS_;
  var greenCount = items.filter(function (i) { return i.status === S.GREEN; }).length;
  var yellowCount = items.filter(function (i) { return i.status === S.YELLOW; }).length;
  var redCount = items.filter(function (i) { return i.status === S.RED; }).length;

  var summary = {
    items: items, greenCount: greenCount, yellowCount: yellowCount, redCount: redCount,
    quarterResolution: quarterResolution
  };
  writeDiagnosticsReport_('完成度自我檢測', buildSelfCheckReportLines_(summary));
  return summary;
}

/**
 * 用途：算出這一輪報告實際要用的行數上限——`SELFCHECK_MAX_ROWS` 與
 *   `DIAGNOSTICS_MAX_ROWS` 兩者取較小值（防止使用者把前者填得比後者
 *   還大，變相繞過 `Diagnostics` 本身的上限）。
 * Args: （無）
 * Returns:
 *   {{maxRows:number, clampNote:string}} `clampNote` 只在真的發生取小值
 *   時才有內容，否則是空字串。
 */
function selfCheckResolveMaxRows_() {
  var configured = normalizeInt_(getConfig(CONFIG_KEYS.SELFCHECK_MAX_ROWS, '140'));
  if (!configured || configured < 1) configured = 140;
  var diagnosticsMax = normalizeInt_(getConfig(CONFIG_KEYS.DIAGNOSTICS_MAX_ROWS, '380'));
  if (!diagnosticsMax || diagnosticsMax < 1) diagnosticsMax = 380;

  if (configured > diagnosticsMax) {
    return {
      maxRows: diagnosticsMax,
      clampNote: '⚠️ SELFCHECK_MAX_ROWS（' + configured + '）大於 DIAGNOSTICS_MAX_ROWS（'
        + diagnosticsMax + '），已改用較小值 ' + diagnosticsMax + '。'
    };
  }
  return { maxRows: configured, clampNote: '' };
}

/**
 * 用途：一個檢測項目的明細（`item.detail`）因為報告行數上限放不下、
 *   必須截斷時，最後一行提示句要用的文字——「本季待填欄位總數」那一項
 *   用「主日」講清楚單位（明細本身就是逐主日彙總行，見
 *   `selfCheckMissingSummaryByDate_()`），其餘項目用通用措辭。
 * Args:
 *   itemLabel {string} 檢測項目的 `label`。
 *   hiddenCount {number} 被截掉的行數。
 * Returns:
 *   {string}
 */
function selfCheckDetailTruncationTrailer_(itemLabel, hiddenCount) {
  if (itemLabel.indexOf('待填欄位總數') !== -1) {
    return '尚有 ' + hiddenCount + ' 個主日未列出。';
  }
  return '（尚有 ' + hiddenCount + ' 行未顯示，報告行數已達上限。）';
}

/**
 * 用途：把 `runSelfCheck_()` 的結果排版成 `Diagnostics` 報告的內容行。
 *
 *   ⚠️ 區段標題一律用全形括號「【…】」，不可以用 `===` 開頭——見
 *   docs/已知bug類型.md 事故六。
 *
 *   ⚠️ **兩段式：逐項結果優先，明細其次**（見
 *   `docs/已知bug類型.md`「報告被自己的明細擠爆」）。先把每一個檢測
 *   項目的結論行（不含 `detail`）全部組好，這一段**保證完整寫入**；
 *   剩餘的行數額度（`SELFCHECK_MAX_ROWS` 與 `DIAGNOSTICS_MAX_ROWS`
 *   取較小值，扣掉結論段用掉的行數）才拿來依序寫各項目的 `detail`，
 *   放不下就在那個項目的明細最後補一行「尚有 N 個未列出」然後整份
 *   報告到此為止——不可以讓後面的檢測項目（觸發器、範本對帳、
 *   ErrorLog／SendLog／AuditLog）因為前面某一項明細太長而被擠出報告。
 * Args:
 *   summary {Object} `runSelfCheck_()` 的回傳值。
 * Returns:
 *   {string[]}
 */
function buildSelfCheckReportLines_(summary) {
  var qr = summary.quarterResolution;
  var rows = selfCheckResolveMaxRows_();

  // ---- 第一段：逐項結果（保證全部寫入，不含明細）----
  var header = [];
  header.push('檢測季度：' + (qr.ok ? qr.quarterId : '（未能決定）') + '　來源：' + (qr.ok ? qr.sourceLabel : '四層全部失敗'));
  if (rows.clampNote) header.push(rows.clampNote);
  header.push('');
  header.push('【總覽】');
  header.push('🟢 ' + summary.greenCount + ' 項　🟡 ' + summary.yellowCount + ' 項　🔴 ' + summary.redCount + ' 項');
  header.push('');
  header.push('【逐項結果】');
  summary.items.forEach(function (item) {
    header.push(item.status + '　' + item.label + '　' + item.message);
  });

  // ---- 第二段：明細，用剩餘額度依序寫，放不下就截斷並停止 ----
  var remaining = rows.maxRows - header.length;
  var detailLines = [];

  for (var i = 0; i < summary.items.length && remaining > 0; i++) {
    var item = summary.items[i];
    var det = item.detail || [];
    if (det.length === 0) continue;

    if (det.length <= remaining) {
      det.forEach(function (d) { detailLines.push('　　' + d); });
      remaining -= det.length;
    } else {
      var shown = det.slice(0, Math.max(0, remaining - 1));
      shown.forEach(function (d) { detailLines.push('　　' + d); });
      detailLines.push('　　' + selfCheckDetailTruncationTrailer_(item.label, det.length - shown.length));
      remaining = 0;
    }
  }

  return header.concat(detailLines);
}

// =====================================================================
// 本季待填清單（完整明細，不受 SELFCHECK_MISSING_DETAIL_ROWS 限制）
// =====================================================================

/**
 * 用途：組出「本季待填清單」報告的內容行——**完整**逐欄位明細（每個
 *   欄位一行），供「完成度自我檢測」報告的精簡彙總被截斷時，Ivan 另外
 *   撳這個選單查完整清單。自己先截斷到 `DIAGNOSTICS_MAX_ROWS`，不倚賴
 *   `writeDiagnosticsReport_()` 的通用截斷訊息——理由同
 *   `buildRosterQuarterReportLines_()`（`src/RosterDiagnostics.gs`）：
 *   這裡要準確講「尚有幾多項」，不是幾多行。
 * Args:
 *   quarterId {string} 季度 ID。
 *   sourceLabel {string} 這個季度 ID 的來源說明（人手輸入或
 *     `resolveWorkingQuarter_()` 的 `sourceLabel`），純粹是報告第一行
 *     的說明文字，不影響查詢邏輯。
 * Returns:
 *   {string[]}
 * Raises:
 *   Error 如果 `ROSTER_SPREADSHEET_ID` 未設定，或職事表讀取失敗（見
 *     `listQuarterServiceDates_()`）。
 */
function buildQuarterMissingFieldsReportLines_(quarterId, sourceLabel) {
  // 主日清單只准經這一支拿（見 src/ServiceDates.gs 檔頭）。
  var dateResolution = resolveQuarterServiceDateEntries_(quarterId);
  var serviceDates = dateResolution.entries;

  var lines = ['本季待填清單：' + quarterId + '　季度來源：' + sourceLabel];
  // ⚠️ 「季度來源」與「主日清單來源」是兩件事：前者答「為什麼是這一季」，
  //    後者答「這一季的主日由哪裏來」。兩者都要講，不可以混為一談。
  lines.push('主日清單來源：' + dateResolution.sourceLabel + '　共 ' + serviceDates.length + ' 個主日');
  if (dateResolution.message) lines.push(dateResolution.message);
  lines.push('');
  var itemLines = [];
  serviceDates.forEach(function (sd) {
    try {
      (buildBulletinModel_(sd.isoDate).missing || []).forEach(function (m) {
        itemLines.push(sd.isoDate + '　' + m.label + '（' + m.field + '）');
      });
    } catch (perDateErr) {
      itemLines.push(sd.isoDate + '　（無法計算：' + ((perDateErr && perDateErr.message) ? perDateErr.message : String(perDateErr)) + '）');
    }
  });

  if (itemLines.length === 0) {
    lines.push('（本季沒有待填欄位。）');
    return lines;
  }

  var maxRows = normalizeInt_(getConfig(CONFIG_KEYS.DIAGNOSTICS_MAX_ROWS, '380'));
  if (!maxRows || maxRows < 1) maxRows = 380;
  var budget = maxRows - lines.length;

  if (itemLines.length <= budget) {
    return lines.concat(itemLines);
  }

  var shown = itemLines.slice(0, Math.max(0, budget - 1));
  return lines.concat(shown).concat(['尚有 ' + (itemLines.length - shown.length) + ' 項未列出。']);
}

/**
 * 用途：選單項目「本季待填清單」的處理函式。問一個季度 ID（預設值取
 *   `resolveWorkingQuarter_()`），輸出該季**完整**待填欄位明細到
 *   `Diagnostics`（報告名稱「本季待填清單」）。**唯讀**。
 * Args: （無）
 * Returns:
 *   {void}
 */
function menuShowQuarterMissingFieldsList_() {
  var ui = SpreadsheetApp.getUi();
  try {
    var quarterResolution = resolveWorkingQuarter_();
    var defaultQuarterId = quarterResolution.ok ? quarterResolution.quarterId : '';
    var resp = ui.prompt(
      '本季待填清單',
      '請輸入季度 ID' + (defaultQuarterId ? '（例如 ' + defaultQuarterId + '）' : '（例如 2027T4）') + '：',
      ui.ButtonSet.OK_CANCEL
    );
    if (resp.getSelectedButton() !== ui.Button.OK) return;

    var typed = resp.getResponseText().trim();
    var quarterId = typed || defaultQuarterId;
    if (!quarterId) {
      ui.alert('請輸入季度 ID。');
      return;
    }

    var sourceLabel = (!typed && quarterResolution.ok) ? quarterResolution.sourceLabel : '人手輸入';
    var lines = buildQuarterMissingFieldsReportLines_(quarterId, sourceLabel);
    writeDiagnosticsReport_('本季待填清單', lines);
    ui.alert('本季待填清單', '季度：' + quarterId + '\n\n完整清單已寫入 Diagnostics 工作表。', ui.ButtonSet.OK);
  } catch (err) {
    logMenuError_('menuShowQuarterMissingFieldsList_', err);
    ui.alert('本季待填清單失敗', enrichAuthError_(err), ui.ButtonSet.OK);
  }
}

// =====================================================================
// 檢查授權範圍
// =====================================================================

/**
 * 用途：「檢查授權範圍」要逐一試探的服務清單與探測方式。寫成函式
 *   延遲求值，不依賴 `.gs` 檔案載入次序（見 docs/已知bug類型.md 事故一）。
 *
 *   ⚠️ 每一個探測都要**最輕量、不產生副作用**——這是「有沒有權限」的
 *   試探，不是功能測試，不可以順手寫入或刪除任何東西。`DriveApp` 不可以
 *   在這個檔案直接呼叫（`tools/lint-readonly-roster.js` 規則 3 只准
 *   `src/DocxIo.gs`、`src/ContentSheetIo.gs`、`src/PublishIo.gs` 出現），
 *   所以透過 `probeDriveAccess_()` 間接呼叫。
 *
 *   ⚠️ 這一行 `probeDriveAccess_()` 正是規則 3 為甚麼比對 `Drive.Files`
 *   而不是單一個 `Drive` 的原因：後者會把這個識別碼一併誤判成
 *   「有人在這裡用 Drive 進階服務」。
 * Args: （無）
 * Returns:
 *   {{item:string, probe:function():void}[]}
 */
function authorizationScopeProbes_() {
  return [
    { item: 'SpreadsheetApp（試算表）', probe: function () { SpreadsheetApp.getActiveSpreadsheet().getName(); } },
    { item: 'DriveApp（雲端硬碟）', probe: function () { probeDriveAccess_(); } },
    { item: 'MailApp（寄信配額查詢）', probe: function () { MailApp.getRemainingDailyQuota(); } },
    { item: 'ScriptApp（觸發器清單）', probe: function () { ScriptApp.getProjectTriggers(); } },
    { item: 'Session（目前使用者）', probe: function () { Session.getActiveUser().getEmail(); } }
  ];
}

/**
 * 用途：「檢查授權範圍」的真正入口。逐一試探性呼叫
 *   `authorizationScopeProbes_()` 列出的服務，回報哪些可用、哪些授權
 *   不足。**唯讀**。
 * Args: （無）
 * Returns:
 *   {{item:string, ok:boolean, message:string}[]}
 */
function checkAuthorizationScopes_() {
  return authorizationScopeProbes_().map(function (p) {
    try {
      p.probe();
      return { item: p.item, ok: true, message: '可用。' };
    } catch (err) {
      return { item: p.item, ok: false, message: enrichAuthError_(err) };
    }
  });
}

/**
 * 用途：把 `checkAuthorizationScopes_()` 的結果排版成 `Diagnostics`
 *   報告的內容行。
 *
 *   ⚠️ 區段標題一律用全形括號「【…】」，不可以用 `===` 開頭——見
 *   docs/已知bug類型.md 事故六。
 * Args:
 *   results {{item:string, ok:boolean, message:string}[]}
 *     `checkAuthorizationScopes_()` 的回傳值。
 * Returns:
 *   {string[]}
 */
function buildAuthorizationScopeReportLines_(results) {
  var lines = [];
  var failedCount = results.filter(function (r) { return !r.ok; }).length;
  lines.push('共 ' + results.length + ' 項，' + (failedCount === 0 ? '全部可用。' : failedCount + ' 項未授權或呼叫失敗。'));
  lines.push('');
  lines.push('【逐項結果】');
  results.forEach(function (r) {
    lines.push((r.ok ? '✓ 可用' : '✗ 未授權') + '　' + r.item + '　' + r.message);
  });
  return lines;
}

// =====================================================================
// 選單處理函式
// =====================================================================

/**
 * 用途：選單項目「完成度自我檢測」的處理函式。
 * Args: （無）
 * Returns:
 *   {void}
 */
function menuRunSelfCheck_() {
  var ui = SpreadsheetApp.getUi();
  try {
    var summary = runSelfCheck_();
    ui.alert(
      '完成度自我檢測',
      '🟢 ' + summary.greenCount + ' 項　🟡 ' + summary.yellowCount + ' 項　🔴 ' + summary.redCount + ' 項\n\n'
      + '完整清單已寫入 Diagnostics 工作表。',
      ui.ButtonSet.OK
    );
  } catch (err) {
    logMenuError_('menuRunSelfCheck_', err);
    ui.alert('完成度自我檢測失敗', enrichAuthError_(err), ui.ButtonSet.OK);
  }
}

/**
 * 用途：選單項目「檢查授權範圍」的處理函式。**唯讀**。
 * Args: （無）
 * Returns:
 *   {void}
 */
function menuCheckAuthorizationScopes_() {
  var ui = SpreadsheetApp.getUi();
  try {
    var results = checkAuthorizationScopes_();
    writeDiagnosticsReport_('檢查授權範圍', buildAuthorizationScopeReportLines_(results));

    var failed = results.filter(function (r) { return !r.ok; });
    if (failed.length === 0) {
      ui.alert('檢查授權範圍', '全部 ' + results.length + ' 項服務都可以正常呼叫，授權範圍沒有問題。', ui.ButtonSet.OK);
      return;
    }

    var lines = ['以下 ' + failed.length + ' 項未授權或呼叫失敗：', ''];
    failed.forEach(function (r) { lines.push('　' + r.item + '：' + r.message); });
    lines.push('');
    lines.push('完整結果已寫入 Diagnostics 工作表。');
    ui.alert('檢查授權範圍', lines.join('\n'), ui.ButtonSet.OK);
  } catch (err) {
    logMenuError_('menuCheckAuthorizationScopes_', err);
    ui.alert('檢查授權範圍失敗', enrichAuthError_(err), ui.ButtonSet.OK);
  }
}
