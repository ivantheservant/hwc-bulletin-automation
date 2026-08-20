/**
 * RosterDiff.gs
 *
 * 週報與職事表的分歧比對。分兩層：
 *   - `buildRosterDiff_(isoDate, snapshot, overrides, lastSnapshotVersion)`
 *     **純函式**，完全不碰 Apps Script 服務，方便在 Node 直接測試。
 *   - `computeRosterDiff_(isoDate)`／`checkRosterDiff_(isoDate)`
 *     真正入口，讀職事表快照、`DutyOverride`、`BulletinWeeks` 的快照版本。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 核心原則（第六輪，每個相關檔案都要複述一次）
 * ─────────────────────────────────────────────────────────────────────
 *
 * 1. **週報永不寫職事表。** 本檔案一格職事表都不寫，只讀。
 * 2. 幹事在週報改的事奉名單只存在週報。
 * 3. 沒有人手覆寫的崗位，自動跟隨職事表最新版。
 * 4. 有人手覆寫的崗位，職事表改動不會自動蓋過去，只會被標示為衝突。
 * 5. 一切分歧**只提醒，不自動修正任何一邊**。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ⚠️ 衝突的判斷基準：`ROSTER_VALUE_AT_OVERRIDE`，不是「週報現值」
 * ─────────────────────────────────────────────────────────────────────
 *
 * `CONFLICT` 的條件是「**職事表現值 ≠ 覆寫當時記下的職事表值**」，
 * **不是**「職事表現值 ≠ 週報現值」。後者永遠成立——幹事就是刻意把週報
 * 改成跟職事表不同，用它判斷的話**每一個覆寫過的格子都會變成衝突**，
 * 提醒信會變成純噪音，幹事很快就不會再看。
 *
 * 正確的語意是：「你覆寫的時候職事表是 A，你改成了 B；現在職事表變成
 * 了 C —— 職事表在你決定之後又改過，你可能想重新看一次。」職事表一直
 * 維持 A 的話，你的決定仍然成立，不需要打擾你。
 */

'use strict';

/**
 * 用途：比對職事表快照與週報的人手覆寫，逐格算出四種狀態之一。純函式。
 * Args:
 *   isoDate {string} 主日日期，yyyy-MM-dd。
 *   snapshot {Object} `readRosterSnapshot_()` 的回傳值。可以是套過
 *     `applyDutyOverridesToSlots_()` 的版本（會用 `slot.rosterName`），
 *     也可以是原始快照（會用 `slot.personName`）——兩種都取得到職事表
 *     本身的值。
 *   overrides {Object[]} 這一個主日的 `DutyOverride` 資料列（可以含
 *     `ACTIVE=FALSE` 的行，本函式只收生效中的）。
 *   lastSnapshotVersion {?number} `BulletinWeeks.ROSTER_SNAPSHOT_VERSION`
 *     ——上一次比對時記下的職事表版本。`null`／`undefined` 代表從來沒有
 *     比對過，這時**一律不產生 `FOLLOW`**（否則第一次執行會把每一格都
 *     報成「跟隨了改動」，全是噪音）。
 *   options {{postLabels:(Object<string,string>|undefined)}=} 選填。
 *     `postLabels` 是「崗位 ID → 週報顯示名稱」（通常來自 `PostDisplay`
 *     的 `PAGE1_NAME`）；沒有提供時退回職事表 `Posts` 的名稱，再退回
 *     崗位 ID 本身。
 * Returns:
 *   {{isoDate:string, rosterVersion:(number|null), snapshotVersion:(number|null),
 *     rows:{postId:string, slotIndex:number, postLabel:string,
 *           rosterName:string, bulletinName:string, hasOverride:boolean,
 *           rosterValueAtOverride:string, status:string}[],
 *     conflictCount:number, followedCount:number}}
 *     `rows` 依崗位在職事表 `Posts` 的顯示次序、同崗位內依位次排序。
 *     `state` 為 `NOT_APPLICABLE` 的 slot **不會出現**在 `rows` 內——
 *     那一週根本不設這個崗位，週報上整行都不會出現，沒有東西可以比對。
 */
function buildRosterDiff_(isoDate, snapshot, overrides, lastSnapshotVersion, options) {
  var opts = options || {};
  var postLabels = opts.postLabels || {};
  var overrideIndex = buildDutyOverrideIndex_(overrides);
  var slotsByPost = (snapshot && snapshot.slotsByPost) || {};
  var rosterVersion = (snapshot && snapshot.versionNo !== undefined) ? snapshot.versionNo : null;
  var snapshotVersion = (lastSnapshotVersion === undefined) ? null : lastSnapshotVersion;

  // 職事表版本比上一次比對時新，才有「自動跟隨」這回事；從來沒有比對過
  // （snapshotVersion 是 null）時一律當成沒有改動，見 Args 的說明。
  var rosterChangedSinceSnapshot = snapshotVersion !== null
    && rosterVersion !== null
    && rosterVersion !== snapshotVersion;

  var nameByPostId = {};
  ((snapshot && snapshot.posts) || []).forEach(function (p) { nameByPostId[p.postId] = p.nameTC; });

  var orderByPostId = {};
  ((snapshot && snapshot.posts) || []).forEach(function (p, idx) { orderByPostId[p.postId] = idx; });

  var rows = [];
  Object.keys(slotsByPost).forEach(function (postId) {
    (slotsByPost[postId] || []).forEach(function (slot) {
      if (slot.state === ROSTER_SLOT_STATE_.NOT_APPLICABLE) return;

      var rosterName = String(
        (slot.rosterName === undefined || slot.rosterName === null) ? (slot.personName || '') : slot.rosterName
      );
      var key = dutyOverrideKey_(postId, slot.slotIndex);
      var override = overrideIndex[key] || null;
      var hasOverride = Boolean(override && String(override.OVERRIDE_NAME || '').trim());
      var overrideName = hasOverride ? String(override.OVERRIDE_NAME).trim() : '';
      var rosterValueAtOverride = hasOverride ? String(override.ROSTER_VALUE_AT_OVERRIDE || '') : '';

      var status;
      if (hasOverride) {
        status = (rosterName !== rosterValueAtOverride)
          ? ROSTER_DIFF_STATUS.CONFLICT
          : ROSTER_DIFF_STATUS.OVERRIDDEN;
      } else {
        status = rosterChangedSinceSnapshot ? ROSTER_DIFF_STATUS.FOLLOW : ROSTER_DIFF_STATUS.SAME;
      }

      rows.push({
        postId: postId,
        slotIndex: (slot.slotIndex === null || slot.slotIndex === undefined) ? 1 : slot.slotIndex,
        postLabel: postLabels[postId] || nameByPostId[postId] || postId,
        rosterName: rosterName,
        bulletinName: hasOverride ? overrideName : rosterName,
        hasOverride: hasOverride,
        rosterValueAtOverride: rosterValueAtOverride,
        status: status
      });
    });
  });

  rows.sort(function (a, b) {
    var oa = orderByPostId[a.postId] === undefined ? 9999 : orderByPostId[a.postId];
    var ob = orderByPostId[b.postId] === undefined ? 9999 : orderByPostId[b.postId];
    if (oa !== ob) return oa - ob;
    if (a.postId !== b.postId) return a.postId < b.postId ? -1 : 1;
    return (a.slotIndex || 0) - (b.slotIndex || 0);
  });

  return {
    isoDate: isoDate,
    rosterVersion: rosterVersion,
    snapshotVersion: snapshotVersion,
    rows: rows,
    conflictCount: rows.filter(function (r) { return r.status === ROSTER_DIFF_STATUS.CONFLICT; }).length,
    followedCount: rows.filter(function (r) { return r.status === ROSTER_DIFF_STATUS.FOLLOW; }).length
  };
}

// =====================================================================
// 真正入口
// =====================================================================

/**
 * 用途：**唯讀**地算出一個主日的比對結果。不寫入任何一格——供
 *   `ConflictNotice.gs` 與「只想看看現況」的呼叫方使用。
 *
 *   ⚠️ 刻意跟 `checkRosterDiff_()` 分開：後者會把 `FOLLOW` 記進
 *   `AuditLog` 並更新 `ROSTER_SNAPSHOT_VERSION`（也就是「消耗掉」
 *   FOLLOW 狀態）。寄提醒信這種動作不應該有這個副作用——不然「寄了
 *   一封信」會順手改變下一次比對的結果。
 * Args:
 *   isoDate {string} 主日日期，yyyy-MM-dd。
 * Returns:
 *   {Object} `buildRosterDiff_()` 的回傳值。
 * Raises:
 *   Error 如果 `isoDate` 格式不對，或職事表讀取失敗
 *     （`readRosterSnapshot_()` 原樣拋出）。
 */
function computeRosterDiff_(isoDate) {
  var snapshot = readRosterSnapshot_(isoDate);
  var overrides = readDutyOverrideRows_(isoDate);
  var weekRow = findBulletinWeekRow_(readSheet(SHEETS.BULLETIN_WEEKS), isoDate) || {};
  var lastSnapshotVersion = (weekRow.ROSTER_SNAPSHOT_VERSION === undefined) ? null : weekRow.ROSTER_SNAPSHOT_VERSION;

  var postLabels = {};
  try {
    readSheet(SHEETS.POST_DISPLAY).forEach(function (r) {
      if (r.ACTIVE === true) postLabels[r.POST_ID] = r.PAGE1_NAME;
    });
  } catch (err) {
    // PostDisplay 讀不到就退回職事表的崗位名稱，不值得讓整個比對失敗。
    postLabels = {};
  }

  return buildRosterDiff_(isoDate, snapshot, overrides, lastSnapshotVersion, { postLabels: postLabels });
}

/**
 * 用途：算出比對結果，並**處理 `FOLLOW`**：把「沒有覆寫、職事表已經改過」
 *   這件事逐格記進 `AuditLog`，然後把 `BulletinWeeks` 的
 *   `ROSTER_SNAPSHOT_VERSION`／`ROSTER_SNAPSHOT_AT` 更新成現在的職事表
 *   版本與時間。
 *
 *   為什麼要更新快照版本：`FOLLOW` 的語意是「這些格子自動跟隨了職事表的
 *   新版本，不用問幹事」。記錄一次之後就已經跟上了，下一次比對不應該
 *   再把同一批格子報一次——所以要把基準線推到現在的版本。
 *
 *   寫入失敗（例如工作表被保護）不拋錯，只在回傳值的 `warnings` 記一筆：
 *   比對結果本身已經算出來了，記不記得下來不應該讓整個比對失敗。
 * Args:
 *   isoDate {string} 主日日期，yyyy-MM-dd。
 * Returns:
 *   {Object} `buildRosterDiff_()` 的回傳值，另加 `warnings` 陣列。
 * Raises:
 *   Error 同 `computeRosterDiff_()`。
 */
function checkRosterDiff_(isoDate) {
  var diff = computeRosterDiff_(isoDate);
  diff.warnings = [];

  if (diff.followedCount === 0 && diff.snapshotVersion === diff.rosterVersion) {
    return diff;
  }

  try {
    diff.rows.forEach(function (row) {
      if (row.status !== ROSTER_DIFF_STATUS.FOLLOW) return;
      appendAuditLog_({
        action: 'ROSTER_FOLLOW',
        sheetName: SHEETS.BULLETIN_WEEKS,
        rowKey: isoDate + '#' + row.postId + '#' + row.slotIndex,
        field: 'DUTY:' + row.postId,
        oldValue: '',
        newValue: row.rosterName,
        notes: '這個崗位沒有人手覆寫，自動跟隨職事表版本 '
          + (diff.snapshotVersion === null ? '（無）' : diff.snapshotVersion) + ' → ' + diff.rosterVersion + '。'
      });
    });

    writeRosterSnapshotVersion_(isoDate, diff.rosterVersion);
  } catch (err) {
    diff.warnings.push({
      code: 'FOLLOW_RECORD_FAILED',
      message: '比對結果算得出來，但把「自動跟隨」記進 AuditLog／更新快照版本時失敗：'
        + (err && err.message ? err.message : String(err)) + '　比對結果本身不受影響。'
    });
  }

  return diff;
}

/**
 * 用途：把 `BulletinWeeks` 指定主日那一行的 `ROSTER_SNAPSHOT_VERSION` 與
 *   `ROSTER_SNAPSHOT_AT` 更新成指定版本與現在時間。找不到那一行就靜靜
 *   略過（回 `false`）。
 * Args:
 *   isoDate {string} 主日日期，yyyy-MM-dd。
 *   rosterVersion {?number} 要記下的職事表版本。
 * Returns:
 *   {boolean} 是否找到並更新了那一行。
 */
function writeRosterSnapshotVersion_(isoDate, rosterVersion) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.BULLETIN_WEEKS);
  if (!sheet) return false;

  var def = COLUMNS.BULLETIN_WEEKS;
  var dateCol = def.keys.indexOf('SERVICE_DATE') + 1;
  var versionCol = def.keys.indexOf('ROSTER_SNAPSHOT_VERSION') + 1;
  var atCol = def.keys.indexOf('ROSTER_SNAPSHOT_AT') + 1;

  var lastRow = sheet.getLastRow();
  if (lastRow < 3) return false;

  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(isoDate || ''));
  if (!m) return false;
  var y = Number(m[1]);
  var mo = Number(m[2]);
  var d = Number(m[3]);

  var dates = sheet.getRange(3, dateCol, lastRow - 2, 1).getValues();
  for (var i = 0; i < dates.length; i++) {
    var cellDate = null;
    try {
      cellDate = normalizeDate_(dates[i][0]);
    } catch (parseErr) {
      cellDate = null;
    }
    if (!rosterDateMatchesYMD_(cellDate, y, mo, d)) continue;

    var rowNo = i + 3;
    sheet.getRange(rowNo, versionCol).setValue(rosterVersion === null || rosterVersion === undefined ? '' : rosterVersion);
    sheet.getRange(rowNo, atCol).setValue(new Date());
    return true;
  }
  return false;
}

/**
 * 用途：把比對結果排版成 `Diagnostics` 報告的內容行，供選單
 *   「檢查職事表分歧」使用。
 *
 *   ⚠️ 區段標題一律用全形括號「【…】」，不可以用 `===` 開頭——見
 *   docs/已知bug類型.md 事故六。
 * Args:
 *   diff {Object} `checkRosterDiff_()` 的回傳值。
 * Returns:
 *   {string[]}
 */
function buildRosterDiffReportLines_(diff) {
  var lines = [];

  lines.push('【基本資料】');
  lines.push('主日日期：' + diff.isoDate);
  lines.push('職事表現時版本：' + (diff.rosterVersion === null ? '（尚未生成）' : diff.rosterVersion));
  lines.push('上一次比對時的版本：' + (diff.snapshotVersion === null ? '（從未比對過）' : diff.snapshotVersion));
  lines.push('衝突項數：' + diff.conflictCount + '　自動跟隨項數：' + diff.followedCount);
  lines.push('');
  lines.push('⚠️ 本系統不會改動職事表。如果週報的版本才是正確的，請自行到職事表更正。');

  var byStatus = {};
  [ROSTER_DIFF_STATUS.CONFLICT, ROSTER_DIFF_STATUS.OVERRIDDEN, ROSTER_DIFF_STATUS.FOLLOW, ROSTER_DIFF_STATUS.SAME]
    .forEach(function (s) {
      byStatus[s] = diff.rows.filter(function (r) { return r.status === s; });
    });

  var labels = {};
  labels[ROSTER_DIFF_STATUS.CONFLICT] = '衝突（職事表在你覆寫之後又改過）';
  labels[ROSTER_DIFF_STATUS.OVERRIDDEN] = '已人手覆寫（職事表沒有再改過）';
  labels[ROSTER_DIFF_STATUS.FOLLOW] = '自動跟隨職事表最新版';
  labels[ROSTER_DIFF_STATUS.SAME] = '兩邊一致';

  Object.keys(byStatus).forEach(function (status) {
    var rows = byStatus[status];
    lines.push('');
    lines.push('【' + labels[status] + '（' + rows.length + ' 項）】');
    rows.forEach(function (r) {
      if (status === ROSTER_DIFF_STATUS.CONFLICT) {
        lines.push('　' + r.postLabel + ' #' + r.slotIndex
          + '　覆寫當時職事表＝' + (r.rosterValueAtOverride || '（空白）')
          + '　職事表現值＝' + (r.rosterName || '（空白）')
          + '　週報現值＝' + (r.bulletinName || '（空白）'));
      } else {
        lines.push('　' + r.postLabel + ' #' + r.slotIndex
          + '　職事表＝' + (r.rosterName || '（空白）')
          + '　週報＝' + (r.bulletinName || '（空白）'));
      }
    });
  });

  return lines;
}

/**
 * 用途：選單項目「檢查職事表分歧」的處理函式。問一個主日日期，呼叫
 *   `checkRosterDiff_()`，用對話框顯示摘要，完整比對寫入 `Diagnostics`。
 * Args: （無）
 * Returns:
 *   {void}
 */
function menuCheckRosterDiff_() {
  var ui = SpreadsheetApp.getUi();
  try {
    var defaultDate = getConfig(CONFIG_KEYS.ROSTER_TEST_DATE, '2027-10-03');
    var resp = ui.prompt(
      '檢查職事表分歧',
      '請輸入主日日期，格式 yyyy-MM-dd（例如 ' + defaultDate + '）：',
      ui.ButtonSet.OK_CANCEL
    );
    if (resp.getSelectedButton() !== ui.Button.OK) return;

    var isoDate = resp.getResponseText().trim() || defaultDate;
    var diff = checkRosterDiff_(isoDate);

    writeDiagnosticsReport_('職事表分歧比對', buildRosterDiffReportLines_(diff));

    ui.alert(
      '檢查職事表分歧',
      [
        '主日日期：' + isoDate,
        '職事表現時版本：' + (diff.rosterVersion === null ? '（尚未生成）' : diff.rosterVersion),
        '衝突項數：' + diff.conflictCount,
        '自動跟隨項數：' + diff.followedCount,
        '',
        '本系統不會改動職事表。如果週報的版本才是正確的，請自行到職事表更正。',
        '',
        '完整比對已寫入 Diagnostics 工作表。'
      ].join('\n'),
      ui.ButtonSet.OK
    );
  } catch (err) {
    logMenuError_('menuCheckRosterDiff_', err);
    ui.alert('檢查職事表分歧失敗', String(err && err.message ? err.message : err), ui.ButtonSet.OK);
  }
}
