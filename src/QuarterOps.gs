/**
 * QuarterOps.gs
 *
 * **R-038**：幹事的整條例行流程要能在填寫介面（Web App）完成，不需要
 * 轉去試算表選單。這個檔案是那八個功能的**共用核心**。
 *
 * 硬規則（每一條都有測試釘住，見 tests/quarterops.test.js）：
 *
 *   1. **一份邏輯，兩個入口。** 這裏每一支都只是「叫既有的核心函式，
 *      再把結果整理成可以直接顯示的行」。選單與 Web App 都經這裏。
 *      同一個狀態兩個真相來源，遲早會不一致，而不一致那一刻沒有人會
 *      發現（見 docs/已知bug類型.md 事故三）。
 *
 *   2. **這個檔案一行 `SpreadsheetApp.getUi()` 都不可以有。** Web App
 *      沒有 UI，一叫就爆。對話框一律換成回傳值。
 *
 *   3. **唯讀報告不可以寫 `Diagnostics`。** `Diagnostics` 每次執行清空
 *      重寫，只保留最新一份。幹事在介面撳一下「上線前檢查」，就會把 IT
 *      剛跑完的診斷報告清走——而且沒有任何提示。所以這裏只**回傳**行，
 *      要不要寫入由呼叫方決定（選單那一邊才寫）。
 *
 *   4. **有副作用的動作一律先預覽、後確認。** 每一個 `previewXxx_()`
 *      都是唯讀的，跟對應的 `runXxx_()` 走同一組底層函式，所以預覽講的
 *      跟實際做的一定同一件事。
 *
 * ⚠️ 這個檔案不直接讀寫職事表，也不碰 `PUBLISHED_PDF_FILE_ID`。
 */

'use strict';

// =====================================================================
// 共用：季度預設值與回傳形狀
// =====================================================================

/**
 * 用途：Web App 的「季度作業」區塊預設要處理哪一季。
 *
 *   ⚠️ 與選單完全一樣，經 `resolveWorkingQuarter_()`——四層退回、
 *   每一層講得出為什麼。**不可以**在這裏自己猜一個季度：兩處各猜一次，
 *   幹事在介面見到的季度就會跟選單不同。
 * Args: （無）
 * Returns:
 *   {{ok:boolean, quarterId:string, sourceLabel:string, notes:string[]}}
 */
function quarterOpsDefaultQuarter_() {
  var r = resolveWorkingQuarter_();
  return {
    ok: r.ok === true,
    quarterId: r.ok ? r.quarterId : '',
    sourceLabel: r.ok ? r.sourceLabel : '',
    notes: (r.notes || []).slice()
  };
}

/**
 * 用途：把「季度 ID 是空的」這一種情況整理成統一的失敗回傳。**純函式。**
 * Args:
 *   quarterId {string}
 *   title {string} 這一個作業的名稱，會寫進訊息。
 * Returns:
 *   {?Object} 沒有問題就回 `null`。
 */
function quarterOpsMissingQuarterResult_(quarterId, title) {
  if (String(quarterId || '').trim()) return null;
  return {
    ok: false, quarterId: '', title: title, reason: 'NO_QUARTER_ID', lines: [],
    message: '未能決定要處理哪一個季度。請在上方季度下拉先選一季，'
      + '或者在 Config 填入 ' + CONFIG_KEYS.WORKING_QUARTER_ID + '。'
  };
}

/**
 * 用途：把一個時間戳記排成幹事看得懂的一句。**純函式（讀 Config 時區）。**
 *
 *   ⚠️ 讀不到就回空字串，**不可以回「1970-01-01」或者今日**——
 *   一個看起來合理但其實是假的日期，比一個空白難查得多。
 * Args:
 *   value {*} 通常是 Date；其他型別一律當成「沒有記錄」。
 * Returns:
 *   {string} 空字串代表沒有記錄。
 */
function quarterOpsFormatStamp_(value) {
  if (Object.prototype.toString.call(value) !== '[object Date]') return '';
  return Utilities.formatDate(
    value, getConfig(CONFIG_KEYS.SYS_TIMEZONE, 'Pacific/Auckland'), 'yyyy-MM-dd HH:mm');
}

/**
 * 用途：某一季在 `BulletinWeeks` 有多少行。**唯讀。**
 * Args:
 *   quarterId {string}
 * Returns:
 *   {number}
 */
function countBulletinWeeksInQuarter_(quarterId) {
  var qid = String(quarterId || '').trim();
  return readSheet(SHEETS.BULLETIN_WEEKS).filter(function (r) {
    return String(r.QUARTER_ID || '').trim() === qid;
  }).length;
}

// =====================================================================
// A. 建立本季週報
// =====================================================================

/**
 * 用途：**A 的預覽**——這一季會新增幾多行、略過幾多行。**唯讀，一格不寫。**
 *
 *   ⚠️ 用的是跟 `createBlankBulletinWeeks_()` 完全一樣的兩支：
 *   `resolveQuarterServiceDates_()` 拿主日清單、`findBulletinWeekRow_()`
 *   判斷已經存在。預覽與實際各算一次的話，預覽講「新增 13 行」而實際
 *   新增 12 行，沒有人查得出差在哪裏。
 * Args:
 *   quarterId {string}
 * Returns:
 *   {{ok:boolean, quarterId:string, title:string, summary:Object,
 *     lines:string[], reason:(string|undefined), message:(string|undefined)}}
 */
function previewCreateBlankWeeks_(quarterId) {
  var title = '建立本季週報';
  var guard = quarterOpsMissingQuarterResult_(quarterId, title);
  if (guard) return guard;

  var qid = String(quarterId).trim();
  var resolution = resolveQuarterServiceDates_(qid);
  var dates = resolution.dates || [];
  // ⚠️ 這一支回的是 `source`（`ROSTER`／`CALENDAR`），不是布林值。
  //    `createBlankBulletinWeeks_()` 也是由同一句推出 `rosterFound`——
  //    兩處用同一條式，預覽與實際才講得出同一句話。
  var rosterFound = resolution.source === 'ROSTER';

  if (dates.length === 0) {
    return {
      ok: false, quarterId: qid, title: title, reason: 'NO_SERVICE_DATES', lines: [],
      message: '季度「' + qid + '」推算不到任何主日：' + (resolution.message || '（沒有說明）')
        + '　請先確認季度 ID 沒有打錯。'
    };
  }

  var existingRows = readSheet(SHEETS.BULLETIN_WEEKS);
  var willAdd = [];
  var willSkip = [];
  dates.forEach(function (isoDate) {
    if (findBulletinWeekRow_(existingRows, isoDate)) willSkip.push(isoDate);
    else willAdd.push(isoDate);
  });

  var lines = [
    '季度：' + qid,
    '本季主日：' + dates.length + ' 個（來源：' + (rosterFound ? '職事表' : '曆法推算') + '）',
    '會新增：' + willAdd.length + ' 行',
    '會略過（已經存在，一格都不會改）：' + willSkip.length + ' 行'
  ];
  if (!rosterFound) {
    // ⚠️ 這是「未到時候」，不是錯誤——文案要跟填寫介面那條黃色橫幅一致。
    lines.push('');
    lines.push('職事表暫時未有這一季的資料，事奉欄位會先留空。'
      + '職事表出咗之後，撳「補抓空白的事奉欄位」就會補回，不會覆寫你填過的東西。');
  }
  if (willAdd.length === 0) {
    lines.push('');
    lines.push('本季每一個主日都已經有週報，撳落去不會有任何改動。');
  } else {
    lines.push('');
    lines.push('將會新增：' + willAdd.slice(0, 20).join('、')
      + (willAdd.length > 20 ? ('　⋯⋯另有 ' + (willAdd.length - 20) + ' 個') : ''));
  }

  return {
    ok: true, quarterId: qid, title: title, lines: lines,
    summary: {
      totalDates: dates.length, willAdd: willAdd.length, willSkip: willSkip.length,
      rosterFound: rosterFound
    }
  };
}

/**
 * 用途：**A 的執行**。呼叫既有的 `createBlankBulletinWeeks_()`，不另寫一套。
 * Args:
 *   quarterId {string}
 * Returns:
 *   {{ok:boolean, quarterId:string, title:string, summary:Object, lines:string[]}}
 */
function runCreateBlankWeeks_(quarterId) {
  var title = '建立本季週報';
  var guard = quarterOpsMissingQuarterResult_(quarterId, title);
  if (guard) return guard;

  var qid = String(quarterId).trim();
  var result = createBlankBulletinWeeks_(qid);

  appendAuditLog_({
    action: 'WEBAPP_CREATE_WEEKS',
    sheetName: SHEETS.BULLETIN_WEEKS,
    rowKey: qid,
    newValue: String(result.added),
    notes: '由填寫介面「季度作業」建立本季週報；新增 ' + result.added
      + ' 行、略過 ' + result.skipped + ' 行。'
  });

  return {
    ok: true, quarterId: qid, title: title,
    summary: {
      totalDates: result.totalDates, added: result.added, skipped: result.skipped,
      rosterFound: result.rosterFound === true
    },
    lines: [
      '季度：' + qid,
      '本季主日：' + result.totalDates + ' 個（來源：' + (result.rosterFound ? '職事表' : '曆法推算') + '）',
      '已新增：' + result.added + ' 行',
      '略過（已經存在）：' + result.skipped + ' 行',
      '',
      result.message || ''
    ]
  };
}

// =====================================================================
// B. 建立／刷新本季內容表
// =====================================================================

/**
 * 用途：**B 的預覽**——會建立一個新的內容表，還是刷新現有那一個。
 *   **唯讀，一格不寫、一個檔案都不建。**
 *
 *   ⚠️ 「會建立」與「會刷新」對幹事是兩件很不同的事：後者的意思是
 *   「同工已經填落去的東西一格都不會動」。不講清楚的話，撳之前那一刻
 *   沒有人知道自己在做哪一件。
 * Args:
 *   quarterId {string}
 * Returns:
 *   {Object}
 */
function previewContentSheetBuild_(quarterId) {
  var title = '建立／刷新本季內容表';
  var guard = quarterOpsMissingQuarterResult_(quarterId, title);
  if (guard) return guard;

  var qid = String(quarterId).trim();
  var config = contentSheetConfig_();
  var folderCheck = checkContentSheetFolderConfigured_(config.folderId);
  if (!folderCheck.ok) {
    return {
      ok: false, quarterId: qid, title: title, reason: 'NO_FOLDER_ID',
      lines: [], message: folderCheck.message
    };
  }

  var dateResolution = resolveQuarterServiceDateEntries_(qid);
  var serviceDates = dateResolution.dates || [];
  if (serviceDates.length === 0) {
    return {
      ok: false, quarterId: qid, title: title, reason: 'NO_SERVICE_DATES', lines: [],
      message: '季度「' + qid + '」找不到任何主日：' + (dateResolution.message || '（沒有說明）')
        + '　請先撳「建立本季週報」。'
    };
  }

  var existing = findContentSheetRow_(qid);
  var lines = ['季度：' + qid, '本季主日：' + serviceDates.length + ' 個'];

  if (existing) {
    lines.push('');
    lines.push('這一季**已經有**內容表，所以是「刷新」，不是重建。');
    lines.push('會刷新：欄位、日期下拉選單、版面。');
    lines.push('⚠️ 同工已經填落去的資料**一格都不會改**。');
    lines.push('現有連結：' + String(existing.FILE_URL || '（沒有記錄）'));
  } else {
    lines.push('');
    lines.push('這一季**未有**內容表，會在雲端硬碟建立一個新的試算表。');
    lines.push('建立之後會把連結記入 ContentSheets，並自動設定分享權限'
      + (config.domain ? ('（' + config.domain + ' 網域內可編輯）')
        : ('（⚠️ 未設定 ' + CONFIG_KEYS.CONTENT_SHEET_DOMAIN + '，要人手分享）')));
  }

  return {
    ok: true, quarterId: qid, title: title, lines: lines,
    summary: {
      exists: Boolean(existing), willCreate: !existing,
      serviceDateCount: serviceDates.length,
      fileUrl: existing ? String(existing.FILE_URL || '') : ''
    }
  };
}

/**
 * 用途：**B 的執行**。呼叫既有的 `buildOrRefreshContentSheet_()`。
 * Args:
 *   quarterId {string}
 * Returns:
 *   {Object} 成功時 `summary.fileUrl` 是可以直接開的連結。
 */
function runContentSheetBuild_(quarterId) {
  var title = '建立／刷新本季內容表';
  var guard = quarterOpsMissingQuarterResult_(quarterId, title);
  if (guard) return guard;

  var qid = String(quarterId).trim();
  var result = buildOrRefreshContentSheet_(qid);
  if (!result.ok) {
    return {
      ok: false, quarterId: qid, title: title,
      reason: result.reason, lines: [], message: result.message
    };
  }

  appendAuditLog_({
    action: 'WEBAPP_CONTENT_SHEET_BUILD',
    sheetName: SHEETS.CONTENT_SHEETS,
    rowKey: qid,
    newValue: result.created ? 'CREATED' : 'REFRESHED',
    notes: '由填寫介面「季度作業」' + (result.created ? '建立' : '刷新') + '內容表。'
  });

  return {
    ok: true, quarterId: qid, title: title,
    lines: buildContentSheetResultLines_(result),
    summary: {
      created: result.created === true,
      serviceDateCount: result.serviceDateCount,
      fileUrl: String(result.fileUrl || ''),
      sharingApplied: result.sharingApplied === true,
      sharingError: String(result.sharingError || '')
    }
  };
}

// =====================================================================
// C. 寄出內容表連結
// =====================================================================

/**
 * 用途：**C 的預覽**——會寄給幾多人、是不是試行。**唯讀，一封信都不寄。**
 *
 *   ⚠️ 收件人 0 個要**明明白白講「勾了也不會寄到任何人」**，不可以等
 *   寄完之後回一句「已寄 0 封」——後者外表像成功。
 *   見 docs/已知bug類型.md（缺失被當成正常值靜靜過）。
 * Args:
 *   quarterId {string}
 * Returns:
 *   {Object}
 */
function previewContentSheetInvite_(quarterId) {
  var title = '寄出內容表連結';
  var guard = quarterOpsMissingQuarterResult_(quarterId, title);
  if (guard) return guard;

  var qid = String(quarterId).trim();
  var dryRun = normalizeBoolean_(getConfig(CONFIG_KEYS.DRY_RUN, 'TRUE')) === true;
  var config = contentSheetConfig_();

  var row = findContentSheetRow_(qid);
  if (!row) {
    return {
      ok: false, quarterId: qid, title: title, reason: 'NO_CONTENT_SHEET', lines: [],
      message: '季度「' + qid + '」尚未建立內容表，沒有連結可以寄。'
        + '請先撳「建立／刷新本季內容表」。'
    };
  }

  var recipientsResult = buildRecipientList_(readSheet(SHEETS.RECIPIENTS), config.inviteGroups, null);
  var recipients = recipientsResult.recipients || [];

  var lines = [
    '季度：' + qid,
    '收件群組：' + config.inviteGroups.join('、'),
    '收件人數：' + recipients.length,
    '是否試行（DRY_RUN）：' + (dryRun ? 'TRUE——不會真的寄出任何郵件' : 'FALSE——會真的寄出'),
    '連結：' + String(row.FILE_URL || '（沒有記錄）')
  ];

  if (recipients.length === 0) {
    // ⚠️ 這一句是整個預覽最重要的一句：撳落去不會出錯，但**不會寄到任何人**。
    return {
      ok: false, quarterId: qid, title: title, reason: 'NO_RECIPIENTS', lines: lines,
      message: 'Recipients 找不到屬於 ' + config.inviteGroups.join('／')
        + ' 的有效收件人——即是話，就算撳落去，**也不會寄到任何人**。'
        + '請先在 Recipients 工作表加入收件人，並確認「有效」是 TRUE。'
    };
  }

  if (row.INVITE_SENT_AT) {
    lines.push('');
    lines.push('⚠️ 這一季之前已經寄過（' + quarterOpsFormatStamp_(row.INVITE_SENT_AT)
      + '）。再寄一次會再寄多一封給同一批人。');
  }
  lines.push('');
  lines.push('收件人：' + recipients.slice(0, 20).map(function (r) { return r.email; }).join('、')
    + (recipients.length > 20 ? ('　⋯⋯另有 ' + (recipients.length - 20) + ' 位') : ''));

  return {
    ok: true, quarterId: qid, title: title, lines: lines,
    summary: {
      recipientCount: recipients.length, dryRun: dryRun,
      alreadySent: Boolean(row.INVITE_SENT_AT), fileUrl: String(row.FILE_URL || '')
    }
  };
}

/**
 * 用途：**C 的執行**。呼叫既有的 `sendContentSheetInvite_()`。
 * Args:
 *   quarterId {string}
 * Returns:
 *   {Object}
 */
function runContentSheetInvite_(quarterId) {
  var title = '寄出內容表連結';
  var guard = quarterOpsMissingQuarterResult_(quarterId, title);
  if (guard) return guard;

  var qid = String(quarterId).trim();
  var result = sendContentSheetInvite_(qid);
  if (!result.sent) {
    return {
      ok: false, quarterId: qid, title: title,
      reason: result.reason, lines: [], message: result.message
    };
  }

  appendAuditLog_({
    action: 'WEBAPP_CONTENT_SHEET_INVITE',
    sheetName: SHEETS.CONTENT_SHEETS,
    rowKey: qid,
    newValue: String(result.recipientCount),
    notes: '由填寫介面「季度作業」寄出內容表連結；DRY_RUN=' + (result.dryRun ? 'TRUE' : 'FALSE') + '。'
  });

  return {
    ok: true, quarterId: qid, title: title,
    summary: { recipientCount: result.recipientCount, dryRun: result.dryRun === true },
    lines: [
      '季度：' + qid,
      '收件人數：' + result.recipientCount,
      '是否試行（DRY_RUN）：'
        + (result.dryRun ? '是——並未實際寄出任何郵件，只寫了 SendLog' : '否——已經真的寄出'),
      '',
      '逐封的結果見 SendLog 工作表。'
    ]
  };
}

// =====================================================================
// D. 從內容表匯入（整季）
// =====================================================================

/**
 * 用途：D 的共用實作。`apply=false` 只預覽、`apply=true` 真的寫入。
 *
 *   ⚠️ 走的是跟選單、跟「單一主日重新匯入」**完全同一組**函式
 *   （`previewContentImport_()` ／ `applyContentImport_()`）。分別只在
 *   `options` 有沒有 `isoDate`：有就一個主日，冇就整季。
 * Args:
 *   quarterId {string}
 *   apply {boolean}
 * Returns:
 *   {Object}
 */
function quarterContentImport_(quarterId, apply) {
  var title = '從內容表匯入（整季）';
  var guard = quarterOpsMissingQuarterResult_(quarterId, title);
  if (guard) return guard;

  var qid = String(quarterId).trim();

  // ⚠️ 週報未建立就匯入，底層會回「找不到主日」——那一句講不出下一步。
  //    這裏先擋一次，並且**指名**要撳哪一粒。
  if (countBulletinWeeksInQuarter_(qid) === 0) {
    return {
      ok: false, quarterId: qid, title: title, reason: 'NO_BULLETIN_WEEKS', lines: [],
      message: '季度「' + qid + '」的週報尚未建立，沒有地方可以匯入。'
        + '請先撳「建立本季週報」，然後再匯入。'
    };
  }

  var result = apply
    ? applyContentImport_(qid, {})
    : previewContentImport_(qid, {});

  if (!result.ok) {
    return {
      ok: false, quarterId: qid, title: title,
      reason: result.reason, lines: [], message: result.message
    };
  }

  if (apply) {
    appendAuditLog_({
      action: 'WEBAPP_CONTENT_IMPORT_QUARTER',
      sheetName: SHEETS.CONTENT_SHEETS,
      rowKey: qid,
      newValue: '+' + result.plan.added + ' ~' + result.plan.updated + ' -' + result.plan.removed,
      notes: '由填寫介面「季度作業」整季匯入。'
    });
  }

  var dryRun = normalizeBoolean_(getConfig(CONFIG_KEYS.DRY_RUN, 'TRUE')) === true;
  return {
    ok: true, quarterId: qid, title: title,
    lines: buildContentImportDialogLines_(result, { dryRun: dryRun, applied: Boolean(apply) }),
    summary: {
      added: result.plan.added, updated: result.plan.updated,
      removed: result.plan.removed, unchanged: result.plan.unchanged
    }
  };
}

// =====================================================================
// E-H. 唯讀報告
//
// ⚠️ 四支全部**只回傳行，不寫 Diagnostics**。理由見檔頭第 3 條。
// =====================================================================

/**
 * 用途：**E**——本季待填清單。**唯讀。**
 * Args:
 *   quarterId {string}
 * Returns:
 *   {{ok:boolean, title:string, lines:string[], ...}}
 */
function quarterMissingFieldsReport_(quarterId) {
  var title = '本季待填清單';
  var guard = quarterOpsMissingQuarterResult_(quarterId, title);
  if (guard) return guard;

  var qid = String(quarterId).trim();
  if (countBulletinWeeksInQuarter_(qid) === 0) {
    return {
      ok: false, quarterId: qid, title: title, reason: 'NO_BULLETIN_WEEKS', lines: [],
      message: '季度「' + qid + '」的週報尚未建立，沒有東西可以檢查。請先撳「建立本季週報」。'
    };
  }

  return {
    ok: true, quarterId: qid, title: title,
    lines: buildQuarterMissingFieldsReportLines_(qid, '填寫介面'),
    summary: {}
  };
}

/**
 * 用途：**F**——檢查職事表分歧。**唯讀。**
 *
 *   ⚠️ 本系統一格都不會寫職事表。這一支只是把兩邊的值排出來比。
 * Args:
 *   isoDate {string} 主日日期，yyyy-MM-dd。
 * Returns:
 *   {Object}
 */
function rosterDiffReport_(isoDate) {
  var title = '檢查職事表分歧';
  var iso = String(isoDate || '').trim();
  if (!iso) {
    return {
      ok: false, title: title, reason: 'NO_DATE', lines: [],
      message: '未選擇主日。請先在上方選一個主日，然後再撳一次。'
    };
  }

  var diff = checkRosterDiff_(iso);
  return {
    ok: true, isoDate: iso, title: title,
    lines: buildRosterDiffReportLines_(diff),
    summary: {
      rosterVersion: diff.rosterVersion,
      conflictCount: diff.conflictCount,
      followedCount: diff.followedCount
    }
  };
}

/**
 * 用途：把上線前檢查的結果排成可以直接顯示的行。**純函式。**
 *
 *   ⚠️ 抽出來的原因：選單那一邊要把同一批行寫入 `Diagnostics`，
 *   Web App 那一邊要回傳同一批行。兩邊各排一次的話，兩份報告會慢慢
 *   長成不同樣子，而看的人以為自己看的是同一份。
 * Args:
 *   items {Object[]} `buildGoLiveChecklist_()` 的回傳值。
 * Returns:
 *   {string[]}
 */
function buildGoLiveReportLines_(items) {
  var S = SELF_CHECK_STATUS_;
  var list = items || [];
  var red = list.filter(function (i) { return i.status === S.RED; });
  var yellow = list.filter(function (i) { return i.status === S.YELLOW; });

  var lines = ['上線前檢查（唯讀）', ''];
  list.forEach(function (i) {
    lines.push(i.status + '　' + i.label);
    lines.push('　　' + i.message);
  });
  lines.push('');
  lines.push('🔴 ' + red.length + ' 項、🟡 ' + yellow.length + ' 項、🟢 '
    + (list.length - red.length - yellow.length) + ' 項。');
  lines.push('⚠️ 這一次檢查全部都是唯讀，一格都沒有寫。');
  return lines;
}

/**
 * 用途：**G**——上線前檢查。**唯讀。**
 * Args: （無）
 * Returns:
 *   {Object}
 */
function goLiveReport_() {
  var items = buildGoLiveChecklist_();
  var S = SELF_CHECK_STATUS_;
  var red = items.filter(function (i) { return i.status === S.RED; }).length;
  var yellow = items.filter(function (i) { return i.status === S.YELLOW; }).length;

  return {
    ok: true, title: '上線前檢查', lines: buildGoLiveReportLines_(items),
    summary: { total: items.length, red: red, yellow: yellow, green: items.length - red - yellow }
  };
}

/**
 * 用途：收集「發佈版本記錄」要用的全部事實。**唯讀，只讀不寫。**
 *
 *   ⚠️ 抽出來的原因同 `buildGoLiveReportLines_()`：選單與 Web App 要看
 *   同一份事實。
 * Args: （無）
 * Returns:
 *   {{fileId:string, fileName:string, revisions:Object, publishRows:Object[]}}
 */
function collectPublishRevisionFacts_() {
  var fileId = String(getConfig(CONFIG_KEYS.PUBLISHED_PDF_FILE_ID, '') || '').trim();
  var facts = fileId ? readDriveFileFacts_(fileId) : { ok: false, fileName: '', message: '' };
  var revisions = fileId
    ? driveListRevisions_(fileId, 20)
    : { ok: false, revisions: [], total: 0, message: '尚未設定 master 發佈檔案。' };

  return {
    fileId: fileId,
    fileName: facts.ok ? facts.fileName : '',
    revisions: revisions,
    // ⚠️ 正式報表排除自測那些行（R-037 §2.2）。
    publishRows: readOfficialPublishLogRows_().slice(-10)
  };
}

/**
 * 用途：**H**——發佈版本記錄。**唯讀，master 檔案的內容一個位元都不會碰。**
 * Args: （無）
 * Returns:
 *   {Object}
 */
function publishRevisionsReport_() {
  var f = collectPublishRevisionFacts_();
  return {
    ok: true, title: '發佈版本記錄',
    lines: buildPublishRevisionLines_(f),
    summary: {
      fileId: f.fileId,
      total: f.revisions.ok ? f.revisions.total : 0,
      revisionsOk: f.revisions.ok === true,
      message: String(f.revisions.message || '')
    }
  };
}

// =====================================================================
// Web App「季度作業」區塊的一次過資料
// =====================================================================

/**
 * 用途：「季度作業」區塊開啟時要知道的東西：預設季度、`DRY_RUN` 現值、
 *   內容表有沒有建立。**唯讀。**
 *
 *   ⚠️ `DRY_RUN` 一定要顯示喺「寄出內容表連結」旁邊。幹事撳完見到
 *   「已寄 12 封」而其實一封都冇寄出，是這個系統最容易踩的一種誤會。
 * Args:
 *   quarterId {string} 前端目前選住的季度；空白就用 `resolveWorkingQuarter_()`。
 * Returns:
 *   {Object}
 */
function quarterOpsPanelData_(quarterId) {
  var typed = String(quarterId || '').trim();
  var fallback = quarterOpsDefaultQuarter_();
  var qid = typed || fallback.quarterId;

  var contentSheetRow = qid ? findContentSheetRow_(qid) : null;
  var config = contentSheetConfig_();

  return {
    quarterId: qid,
    quarterSource: typed ? '（目前選住的季度）' : fallback.sourceLabel,
    dryRun: normalizeBoolean_(getConfig(CONFIG_KEYS.DRY_RUN, 'TRUE')) === true,
    weekCount: qid ? countBulletinWeeksInQuarter_(qid) : 0,
    contentSheet: {
      exists: Boolean(contentSheetRow),
      fileUrl: contentSheetRow ? String(contentSheetRow.FILE_URL || '') : '',
      inviteSentAt: (contentSheetRow && contentSheetRow.INVITE_SENT_AT)
        ? quarterOpsFormatStamp_(contentSheetRow.INVITE_SENT_AT) : '',
      lastImportedAt: (contentSheetRow && contentSheetRow.LAST_IMPORTED_AT)
        ? quarterOpsFormatStamp_(contentSheetRow.LAST_IMPORTED_AT) : ''
    },
    folderConfigured: checkContentSheetFolderConfigured_(config.folderId).ok === true
  };
}
