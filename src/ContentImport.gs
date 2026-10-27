/**
 * ContentImport.gs
 *
 * 由每季「內容表」把七項內容匯入週報試算表（R-011／R-012）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 最重要的原則：內容表是唯一編輯來源，匯入是**單向**的
 * ─────────────────────────────────────────────────────────────────────
 *
 *   內容表 → 週報試算表。**週報這邊永遠不回寫內容表。**
 *   `Announcements`／`Prayers`／`Fellowships`／`Finance`／`BulletinWeeks`
 *   的相關欄位，從這一輪起變成「匯入後的快照」，不再是編輯來源。
 *
 *   所以 Web App 那七個區塊改為唯讀（見 `src/WebApp.gs` 與
 *   `src/WebAppSave.gs` 的 `assertContentSheetFieldsNotSubmitted_()`）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 三條安全規則（每一條都是「靜靜清光資料」的防線）
 * ─────────────────────────────────────────────────────────────────────
 *
 *   1. **內容表某一張分頁整張空白 → 那一張完全不動。** 不可以當成
 *      「全部刪除」——有人不小心清空一張分頁，就會靜靜把整季內容清光。
 *      報告會明確寫「家事報告：內容表沒有資料，本次不改動」。
 *   2. **「刪除」一律 `ACTIVE=FALSE`，不刪行。** 刪了行就對不回之前
 *      匯入過什麼。
 *   3. **一定要先看差異才寫。** `previewContentImport_()` 與
 *      `applyContentImport_()` 用同一個 `computeContentImportPlan_()`，
 *      預覽看到什麼，寫入就是什麼。
 *
 * ⚠️ 匯入**不受 `DRY_RUN` 限制**：`DRY_RUN` 管的是「會不會寄信給人」，
 * 匯入只是把資料由一張表搬到另一張表，沒有對外副作用。但對話框仍然會
 * 註明目前是否模擬模式，免得幹事誤會。
 */

'use strict';

/** `AuditLog` 內代表「這一格是由內容表匯入寫進來的」的動作名稱。 */
var CONTENT_IMPORT_AUDIT_ACTION_ = 'CONTENT_SHEET_IMPORT';

/** 匯入預覽對話框最多列幾多行明細；其餘寫入 `Diagnostics`。 */
var CONTENT_IMPORT_PREVIEW_ROWS_ = 20;

/**
 * 用途：內容表分頁 → 週報試算表的對應定義。**唯一真相來源**：差異計算、
 *   寫入、報告全部由這一份衍生。
 *
 *   `kind` 三種：
 *     - `'LIST'`　　對應一張「一個主日多行」的清單表（`Announcements` 等）。
 *     - `'WEEK'`　　對應 `BulletinWeeks` 同一行的幾個欄位（宣召）。
 *     - `'WEEK_ATTENDANCE'`　同 `'WEEK'`，但**主日要由崇拜日期加七天算出來**。
 *
 *   寫成函式延遲求值，不依賴 `.gs` 載入次序（見 docs/已知bug類型.md 事故一）。
 * Args: （無）
 * Returns:
 *   {{tabName:string, kind:string, targetSheet:string,
 *     fieldMap:Object<string,string>, repeatUntil:boolean}[]}
 *     `fieldMap` 是「內容表機器鍵 → 目標表機器鍵」；同名的照樣要列出來，
 *     免得日後有人以為「同名就自動對應」而漏掉一個。
 */
function contentImportTargets_() {
  return [
    {
      tabName: '家事報告', kind: 'LIST', targetSheet: SHEETS.ANNOUNCEMENTS,
      fieldMap: { TEXT: 'TEXT' }, repeatUntil: true
    },
    {
      tabName: '代禱事項', kind: 'LIST', targetSheet: SHEETS.PRAYERS,
      fieldMap: { TEXT: 'TEXT' }, repeatUntil: true
    },
    {
      tabName: '團契聚會', kind: 'LIST', targetSheet: SHEETS.FELLOWSHIPS,
      fieldMap: {
        NAME: 'FELLOWSHIP_NAME', DATE_TEXT: 'MEETING_DATE',
        TIME_TEXT: 'MEETING_TIME', CONTENT: 'CONTENT'
      },
      repeatUntil: false
    },
    {
      tabName: '財政報告', kind: 'LIST', targetSheet: SHEETS.FINANCE,
      // ⚠️ COL1／COL2 對應既有的 COL_SPECIAL_OVERSEAS／COL_HARDSHIP
      // （沿用舊機器鍵，舊資料不受影響），COL3／COL4 才是同名的。
      fieldMap: {
        ROW_LABEL: 'ROW_LABEL',
        COL1: 'COL_SPECIAL_OVERSEAS', COL2: 'COL_HARDSHIP',
        COL3: 'COL3', COL4: 'COL4'
      },
      repeatUntil: false
    },
    {
      tabName: '崇拜人數', kind: 'WEEK_ATTENDANCE', targetSheet: SHEETS.BULLETIN_WEEKS,
      fieldMap: attendanceImportFieldMap_(), repeatUntil: false
    },
    // v3（2026-10-26）：「崇拜程序」九欄只可以在內容表填（CONTENT_SHEET_READONLY_FIELDS.WEEK），
    //    所以不再是第三種模式：匯入一律以內容表為準（不再看 FieldOverride，舊覆寫由「更新本季內容表」停用）。
    //    `overridable` 的機制保留在 computeContentImportPlan_()（CONTENT_SHEET_OVERRIDABLE_FIELDS 是空的）。
    //    對應表由分頁定義衍生（見 worshipImportFieldMap_()），不另抄一份。
    {
      tabName: '崇拜程序', kind: 'WEEK', targetSheet: SHEETS.BULLETIN_WEEKS,
      fieldMap: worshipImportFieldMap_(), repeatUntil: false
    }
  ];
}

/**
 * 用途：內容表 v2「崇拜程序」的對應表：分頁定義的機器鍵扣除主日日期、有效、備註，兩邊機器鍵
 *   完全同名。由 `contentSheetWorshipTabDef_()` 衍生——欄位只在分頁定義加一處。
 *   「備註」是內容表內部備忘，不匯入（決定 5）。
 * Args: （無）
 * Returns:
 *   {Object<string,string>} 內容表機器鍵 → `BulletinWeeks` 機器鍵。
 * Raises:
 *   （無）
 */
function worshipImportFieldMap_() {
  var map = {};
  contentSheetWorshipTabDef_().keys.forEach(function (key) {
    if (key === 'SERVICE_DATE' || key === 'ACTIVE' || key === 'NOTES') return;
    map[key] = key;
  });
  return map;
}

/**
 * 用途：崇拜人數十二欄的對應表——兩邊機器鍵完全同名，所以直接由
 *   `BulletinWeeks` 的 `ATT_*` 衍生，不另外抄一份（多一份就多一個會
 *   不同步的地方）。
 * Args: （無）
 * Returns:
 *   {Object<string,string>} 內容表機器鍵 → `BulletinWeeks` 機器鍵。
 */
function attendanceImportFieldMap_() {
  var map = {};
  COLUMNS.BULLETIN_WEEKS.keys.forEach(function (key) {
    if (/^ATT_/.test(key)) map[key] = key;
  });
  return map;
}

// =====================================================================
// 純函式層：讀內容表 → 目標狀態
// =====================================================================

/**
 * 用途：把內容表某一張分頁的原始格值，轉成一批以機器鍵為 key 的資料列。
 *   純函式。
 *
 *   ⚠️ 整行皆空白的一律略過（同 `readSheet()` 的規則一致）；
 *   `ACTIVE` **留空當作 `TRUE`**——內容表那 200 行預留空白行刻意沒有
 *   預先填 `TRUE`（填了就會變成 200 行幽靈資料，見 docs/待確認事項.md J-4）。
 * Args:
 *   values {Array[]} 由第 3 行開始的原始格值（二維陣列）。
 *   keys {string[]} 該分頁的機器鍵（決定欄次序）。
 * Returns:
 *   {Object[]} 每個元素以機器鍵為 key，另有 `__rowNo`（內容表上的行號，
 *     供警告訊息指出是哪一行）與 `__typeIssues`（被試算表轉成日期／時間的欄，
 *     機器鍵清單；那幾格的值一律是空字串，匯入要略過，見 `buildContentImportTargets_()`）。
 */
function parseContentTabRows_(values, keys) {
  var out = [];
  (values || []).forEach(function (row, i) {
    var isBlank = row.every(function (cell) { return cell === '' || cell === null || cell === undefined; });
    if (isBlank) return;

    var obj = { __rowNo: i + CONTENT_SHEET_FIRST_DATA_ROW_, __typeIssues: [] };
    keys.forEach(function (key, c) {
      var v = row[c];
      // 內容表 v2（bug class 4）：內容表全部欄位都是文字（日期亦是 yyyy-MM-dd 文字，由下拉選）。
      //    讀到 Date 物件代表那一格被試算表自動轉成日期／時間（例如「3:16」變成時間），
      //    String(Date) 會變成「Sat Dec 30 1899 …」寫進週報。記下來，由匯入略過並警告。
      if (Object.prototype.toString.call(v) === '[object Date]') {
        obj.__typeIssues.push(key);
        obj[key] = '';
        return;
      }
      obj[key] = (v === null || v === undefined) ? '' : String(v).trim();
    });

    // 留空當作 TRUE；只有明確寫 FALSE 才算停用。
    //
    // ⚠️ D-4：留空當成 TRUE 是刻意的（那 200 行預留空白行如果當成 FALSE，
    //    幹事每加一行都要記得打 TRUE），但**不可以靜靜當成 TRUE**——
    //    「我以為我停用咗」同「我根本冇填」在畫面上一模一樣。所以額外記低
    //    `__activeBlank`，由差異報告逐行列出，交返畀幹事決定。
    var active = String(obj.ACTIVE || '').trim().toUpperCase();
    obj.__active = active !== 'FALSE';
    obj.__activeBlank = active === '';
    out.push(obj);
  });
  return out;
}

/**
 * 用途：把「連續到」（`REPEAT_UNTIL`）展開成逐個主日一行。純函式。
 *
 *   一行「主日日期 = 2027-10-03、連續到 = 2027-10-24」，展開成
 *   2027-10-03、10-10、10-17、10-24 共四個主日各一行。
 *
 *   四條規則：
 *     - **只展開到該季的主日，不跨季**（`serviceDates` 本身就只有該季）。
 *     - `REPEAT_UNTIL` 留空 → 只出現一次。
 *     - `REPEAT_UNTIL` **早過** `SERVICE_DATE` → 當作只出現一次，記警告。
 *     - `REPEAT_UNTIL` **不是該季主日** → 取該季內**不遲於它**的最後一個
 *       主日，記警告。
 *     - 展開出來的行，`SEQ_NO` 沿用原行的值。
 * Args:
 *   rows {Object[]} `parseContentTabRows_()` 的輸出（同一張分頁）。
 *   serviceDates {string[]} 該季全部主日，yyyy-MM-dd，已由細到大排序。
 * Returns:
 *   {{rows:Object[], warnings:string[]}} `rows` 每個元素多一個
 *     `__isoDate`（展開之後這一行屬於哪一個主日）。
 */
function expandRepeatUntilRows_(rows, serviceDates) {
  var dates = (serviceDates || []).slice();
  var expanded = [];
  var warnings = [];

  (rows || []).forEach(function (row) {
    var startIso = String(row.SERVICE_DATE || '').trim();
    var startIndex = dates.indexOf(startIso);
    if (startIndex === -1) {
      warnings.push('第 ' + row.__rowNo + ' 行的「主日日期」' + (startIso || '（空白）')
        + ' 不是本季的主日，整行略過。');
      return;
    }

    var untilIso = String(row.REPEAT_UNTIL || '').trim();
    var endIndex = startIndex;

    if (untilIso) {
      var exact = dates.indexOf(untilIso);
      if (exact !== -1) {
        endIndex = exact;
        if (endIndex < startIndex) {
          warnings.push('第 ' + row.__rowNo + ' 行的「連續到」' + untilIso
            + ' 早過「主日日期」' + startIso + '，當作只出現一次。');
          endIndex = startIndex;
        }
      } else {
        // 不是本季主日：取本季內不遲於它的最後一個主日。
        var fallback = -1;
        for (var i = 0; i < dates.length; i++) {
          if (dates[i] <= untilIso) fallback = i;
        }
        if (fallback < startIndex) {
          warnings.push('第 ' + row.__rowNo + ' 行的「連續到」' + untilIso
            + ' 不是本季的主日，而且本季沒有不遲於它的主日，當作只出現一次。');
          endIndex = startIndex;
        } else {
          endIndex = fallback;
          warnings.push('第 ' + row.__rowNo + ' 行的「連續到」' + untilIso
            + ' 不是本季的主日，已改用本季內不遲於它的最後一個主日 ' + dates[endIndex] + '。');
        }
      }
    }

    for (var d = startIndex; d <= endIndex; d++) {
      expanded.push(Object.assign({}, row, { __isoDate: dates[d] }));
    }
  });

  return { rows: expanded, warnings: warnings };
}

/**
 * 用途：把「崇拜人數」那一張分頁的崇拜日期，換算成對應的週報主日
 *   （**崇拜日期 + 7 天**）。純函式。
 *
 *   ⚠️ 內容表填的是崇拜當日，週報印的是「上週崇拜人數」，所以差七天。
 *   算出來的主日不在該季 → 回 `null`，呼叫方要略過並在報告列出，
 *   不可以靜靜丟掉。
 * Args:
 *   attendanceIso {string} 崇拜日期，yyyy-MM-dd。
 *   serviceDates {string[]} 該季全部主日。
 * Returns:
 *   {?string} 對應的主日；對不上回 `null`。
 */
function attendanceDateToServiceDate_(attendanceIso, serviceDates) {
  var iso = String(attendanceIso || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  var target = addDaysToIsoDate_(iso, 7);
  return (serviceDates || []).indexOf(target) === -1 ? null : target;
}

/**
 * 用途：把整個內容表的資料，轉成「每張目標表、每個主日應該長成點」的
 *   目標狀態。純函式。
 * Args:
 *   contentData {Object<string,Object[]>} 分頁名稱 → `parseContentTabRows_()`
 *     的輸出。**沒有出現在這個物件內、或者陣列為空的分頁，代表內容表那一
 *     張整張空白**，呼叫方要完全跳過（安全規則 1）。
 *   serviceDates {string[]} 該季全部主日。
 * Returns:
 *   {{targets:Object, warnings:string[], skippedTabs:string[], blankActiveRows:Object[],
 *     skipListDates:Object<string,Object<string,boolean>>}}
 *     `targets` 形狀：`{ '<分頁名稱>': { '<主日>': [資料列…] } }`；
 *     `skippedTabs` 是「整張空白、本次不改動」的分頁名稱；`skipListDates` 是清單類分頁內
 *     有格被試算表轉成日期／時間、這一次不比對的主日（分頁名稱 → 主日 → true）。
 */
function buildContentImportTargets_(contentData, serviceDates) {
  var targets = {};
  var warnings = [];
  var skippedTabs = [];
  var blankActiveRows = [];
  var skipListDates = {};

  contentImportTargets_().forEach(function (def) {
    var rows = (contentData || {})[def.tabName] || [];

    // ---- 安全規則 1：整張空白就完全不動 ----
    if (rows.length === 0) {
      skippedTabs.push(def.tabName);
      return;
    }

    // ⚠️ D-4：「有效」留空當成 TRUE，但要逐行講出來。留空與明確寫 TRUE
    //    在畫面上一模一樣，而兩者的意思可以完全相反（「我以為我停用咗」）。
    rows.forEach(function (r) {
      if (r.__activeBlank !== true) return;
      blankActiveRows.push({ tabName: def.tabName, rowNo: r.__rowNo, isoDate: String(r.SERVICE_DATE || '') });
    });

    // ---- 內容表 v2（bug class 4）：被試算表轉成日期／時間的格 ----
    //    逐格講出來。清單類分頁：主日／連續到／有效被轉了就不知道這一行屬於哪幾個主日，
    //    整張這一次不匯入（否則那幾個主日既有的行會被當成「已刪除」而停用）；其餘欄被轉了，
    //    這一行涉及的主日這一次不匯入。週欄位類分頁：主日／有效被轉了就略過這一行；其餘欄
    //    只略過那一格（`computeContentImportPlan_()`），週報保留原值。
    var typeIssues = classifyContentTypeIssues_(def, rows);
    typeIssues.warnings.forEach(function (w) { warnings.push(w); });
    if (typeIssues.skipWholeTab) return;

    var activeRows = rows.filter(function (r) { return r.__active; });
    var byDate = {};

    if (def.kind === 'WEEK_ATTENDANCE') {
      activeRows.forEach(function (row) {
        if (typeIssues.skipRowNos[row.__rowNo]) return;
        var iso = attendanceDateToServiceDate_(row.SERVICE_DATE, serviceDates);
        if (!iso) {
          warnings.push('崇拜人數第 ' + row.__rowNo + ' 行的崇拜日期 '
            + (row.SERVICE_DATE || '（空白）') + ' 加七天之後不是本季的主日，本行略過。');
          return;
        }
        byDate[iso] = [row];
      });
    } else if (def.kind === 'WEEK') {
      activeRows.forEach(function (row) {
        if (typeIssues.skipRowNos[row.__rowNo]) return;
        var iso = String(row.SERVICE_DATE || '').trim();
        if ((serviceDates || []).indexOf(iso) === -1) {
          warnings.push(def.tabName + '第 ' + row.__rowNo + ' 行的主日日期 '
            + (iso || '（空白）') + ' 不是本季的主日，本行略過。');
        }
      });
      // 同一個主日以**最後一行生效中**的資料為準。內容表 v2 的移轉寫入亦用同一支
      // lastActiveRowByDate_() 找目標行，兩邊看的是同一行。
      var lastByDate = lastActiveRowByDate_(activeRows.filter(function (row) {
        return !typeIssues.skipRowNos[row.__rowNo];
      }));
      Object.keys(lastByDate).forEach(function (iso) {
        if ((serviceDates || []).indexOf(iso) === -1) return;
        byDate[iso] = [lastByDate[iso]];
      });
    } else {
      var expandedResult = def.repeatUntil
        ? expandRepeatUntilRows_(activeRows, serviceDates)
        : expandRepeatUntilRows_(activeRows.map(function (r) {
          return Object.assign({}, r, { REPEAT_UNTIL: '' });
        }), serviceDates);

      expandedResult.warnings.forEach(function (w) { warnings.push(def.tabName + '：' + w); });

      expandedResult.rows.forEach(function (row) {
        if (!byDate[row.__isoDate]) byDate[row.__isoDate] = [];
        byDate[row.__isoDate].push(row);
        if (typeIssues.skipRowNos[row.__rowNo]) {
          if (!skipListDates[def.tabName]) skipListDates[def.tabName] = {};
          skipListDates[def.tabName][row.__isoDate] = true;
        }
      });

      // 同一個主日內按「次序」排先後；次序相同就按內容表上的行號。
      Object.keys(byDate).forEach(function (iso) {
        byDate[iso].sort(function (a, b) {
          var sa = Number(a.SEQ_NO);
          var sb = Number(b.SEQ_NO);
          if (Number.isFinite(sa) && Number.isFinite(sb) && sa !== sb) return sa - sb;
          return a.__rowNo - b.__rowNo;
        });
      });
    }

    targets[def.tabName] = byDate;
  });

  return {
    targets: targets, warnings: warnings, skippedTabs: skippedTabs,
    blankActiveRows: blankActiveRows, skipListDates: skipListDates
  };
}

/**
 * 用途：「一個主日一行」的分頁（崇拜程序等）每個主日以哪一行為準：**最後一行生效中**的資料
 *   （按內容表上的行號）。匯入（`buildContentImportTargets_()`）與內容表 v2 移轉
 *   （`planContentSheetV2Migration_()`）共用這一支，兩邊一定看同一行。純函式。
 * Args:
 *   rows {Object[]} `parseContentTabRows_()` 的輸出（可以已經篩過）；`__active` 不是 true 的行不算。
 * Returns:
 *   {Object<string,Object>} 主日（yyyy-MM-dd，去頭尾空白）→ 那一行。主日空白的行不算。
 * Raises:
 *   （無）
 */
function lastActiveRowByDate_(rows) {
  var out = {};
  (rows || []).slice().sort(function (a, b) { return a.__rowNo - b.__rowNo; }).forEach(function (row) {
    if (row.__active !== true) return;
    var iso = String(row.SERVICE_DATE || '').trim();
    if (!iso) return;
    out[iso] = row;
  });
  return out;
}

/** 內容表 v2：決定「一行屬於哪幾個主日、有沒有效」的欄。被轉成日期／時間就不知道這一行的範圍。 */
var CONTENT_IMPORT_STRUCTURAL_KEYS_ = ['SERVICE_DATE', 'REPEAT_UNTIL', 'ACTIVE', 'SEQ_NO'];

/**
 * 用途：內容表 v2：整理一張分頁內被試算表轉成日期／時間的格（`parseContentTabRows_()` 的
 *   `__typeIssues`），決定這一次怎樣略過，並逐格寫警告。純函式。只理會會匯入的欄與決定範圍的欄，
 *   其他欄（例如「備註」「來源」）本來就不匯入，不出警告。
 * Args:
 *   def {Object} `contentImportTargets_()` 其中一項。
 *   rows {Object[]} 這張分頁 `parseContentTabRows_()` 的輸出。
 * Returns:
 *   {{skipWholeTab:boolean, skipRowNos:Object<number,boolean>, warnings:string[]}}
 *     週欄位類：`skipRowNos` 只放範圍欄出事的行（其餘欄由 `computeContentImportPlan_()` 逐格略過）；
 *     清單類：`skipRowNos` 放任何一格出事的行（那一行涉及的主日整個不匯入）。
 * Raises:
 *   （無）
 */
function classifyContentTypeIssues_(def, rows) {
  var out = { skipWholeTab: false, skipRowNos: {}, warnings: [] };
  var isList = def.kind === 'LIST';
  (rows || []).forEach(function (row) {
    (row.__typeIssues || []).forEach(function (key) {
      var structural = CONTENT_IMPORT_STRUCTURAL_KEYS_.indexOf(key) !== -1;
      if (!structural && !Object.prototype.hasOwnProperty.call(def.fieldMap, key)) return;
      var consequence;
      if (isList && (key === 'SERVICE_DATE' || key === 'REPEAT_UNTIL' || key === 'ACTIVE')) {
        out.skipWholeTab = true;
        consequence = '不知道這一行屬於哪幾個主日，整張「' + def.tabName + '」這一次不匯入（週報保留原有的內容）';
      } else if (isList) {
        out.skipRowNos[row.__rowNo] = true;
        consequence = '這一行涉及的主日，「' + def.tabName + '」這一次不匯入（週報保留原有的內容）';
      } else if (structural) {
        out.skipRowNos[row.__rowNo] = true;
        consequence = '這一行這一次略過';
      } else {
        consequence = '這一格這一次不匯入（週報保留原值）';
      }
      out.warnings.push('「' + def.tabName + '」第 ' + row.__rowNo + ' 行「' + contentTabColumnLabel_(def.tabName, key)
        + '」被試算表轉成日期／時間，' + consequence + '。請把那一格的格式改回純文字（格式 ▸ 數字 ▸ 純文字），再重新輸入。');
    });
  });
  return out;
}

/**
 * 用途：內容表某張分頁某一欄的中文標題（第 1 行），由 `contentSheetTabDefs_()` 衍生。純函式。
 * Args:
 *   tabName {string} 分頁名稱。
 *   key {string} 機器鍵。
 * Returns:
 *   {string} 找不到就回機器鍵本身。
 * Raises:
 *   （無）
 */
function contentTabColumnLabel_(tabName, key) {
  var tabDef = contentSheetTabDefs_().filter(function (d) { return d.tabName === tabName; })[0];
  if (!tabDef) return key;
  var index = tabDef.keys.indexOf(key);
  return index === -1 ? key : (tabDef.headers[index] || key);
}

// =====================================================================
// 純函式層：目標狀態 vs 現況 → 差異計畫
// =====================================================================

/**
 * 用途：把兩個值當成「同一個值」來比較——`null`／`undefined`／空字串
 *   視為同一個空，其餘轉字串比較。
 *
 *   ⚠️ 刻意不重用 `fieldsEqual_()`（`src/WebAppSave.gs`）的 `Date` 分支：
 *   內容表的值一律是字串，而目標表的 `SEQ_NO` 是數字，兩邊都不會是 `Date`。
 * Args:
 *   a {*}　b {*}
 * Returns:
 *   {boolean}
 */
function contentValuesEqual_(a, b) {
  return normalizeContentCompareValue_(a) === normalizeContentCompareValue_(b);
}

/**
 * 用途：把一個值正規化成**用來比對**的字串。差異比對兩邊都要經這一支，
 *   不可以一邊原值一邊格式化值。
 *
 *   ⚠️ 這裡**刻意不**把數字 42150 當成等於文字 '42,150'。兩者確實不同：
 *   前者是試算表自作主張轉換後的錯值，週報會印成「42150」。把它們當成
 *   相等，等於叫匯入永遠不要修好它。正確做法是照樣報成差異、由匯入把
 *   正確的文字寫回去（寫入端已經先設 '@' 格式，不會再被轉走）。
 *   見 docs/已知bug類型.md 事故二十八。
 *
 *   ⚠️ `Date` 一定要轉成 `yyyy-MM-dd`：`String(dateObject)` 會得出
 *   'Mon Oct 04 2027 …'，永遠不會等於內容表的 '2027-10-04'，那一欄就會
 *   每次匯入都被判定為有改動。
 * Args:
 *   value {*}
 * Returns:
 *   {string}
 */
function normalizeContentCompareValue_(value) {
  if (value === null || value === undefined) return '';
  if (Object.prototype.toString.call(value) === '[object Date]') {
    // ⚠️ 用 formatIsoDate_() 而不是 normalizeDate_()：後者回的是 Date 物件，
    //    拿去同字串 === 比永遠不相等。
    return formatIsoDate_(value);
  }
  return String(value).trim();
}

/**
 * 用途：算出一張**清單表**（`Announcements` 等）在某一個主日的差異。純函式。
 *
 *   ⚠️ 用「位置對位置」而不是「`SEQ_NO` 對 `SEQ_NO`」：內容表那邊的次序
 *   才是真相，位置對位置才能保證跑第二次是 0 改動（冪等）。多出來的現有
 *   行一律 `ACTIVE=FALSE`，不刪行。
 * Args:
 *   existingRows {Object[]} 該主日現有的資料列（帶 `__rowNo`），已按
 *     `SEQ_NO` 排序。
 *   targetRows {Object[]} 該主日的目標資料列（內容表那邊，已排序）。
 *   def {Object} `contentImportTargets_()` 其中一項。
 *   isoDate {string} 主日。
 * Returns:
 *   {{updates:Object[], appends:Object[], deactivations:Object[], details:Object[],
 *     unchanged:number}}
 */
function diffContentListForDate_(existingRows, targetRows, def, isoDate) {
  var updates = [];
  var appends = [];
  var deactivations = [];
  var details = [];
  var unchanged = 0;

  var sourceKeys = Object.keys(def.fieldMap);
  var max = Math.max(existingRows.length, targetRows.length);

  for (var i = 0; i < max; i++) {
    var existing = existingRows[i];
    var target = targetRows[i];
    var seqNo = (i + 1) * 10;

    if (existing && target) {
      var changes = [];
      if (!contentValuesEqual_(existing.SEQ_NO, seqNo)) {
        changes.push({ field: 'SEQ_NO', oldValue: existing.SEQ_NO, newValue: seqNo });
      }
      if (existing.ACTIVE !== true) {
        changes.push({ field: 'ACTIVE', oldValue: existing.ACTIVE, newValue: true });
      }
      sourceKeys.forEach(function (sourceKey) {
        var targetKey = def.fieldMap[sourceKey];
        if (!contentValuesEqual_(existing[targetKey], target[sourceKey])) {
          changes.push({ field: targetKey, oldValue: existing[targetKey], newValue: target[sourceKey] });
        }
      });

      if (changes.length === 0) {
        unchanged++;
      } else {
        updates.push({ rowNo: existing.__rowNo, isoDate: isoDate, changes: changes });
        changes.forEach(function (c) {
          details.push({
            action: 'UPDATE', sheet: def.targetSheet, isoDate: isoDate,
            field: c.field, oldValue: c.oldValue, newValue: c.newValue
          });
        });
      }
    } else if (target) {
      var row = { SERVICE_DATE: isoDate, SEQ_NO: seqNo, ACTIVE: true };
      sourceKeys.forEach(function (sourceKey) { row[def.fieldMap[sourceKey]] = target[sourceKey]; });
      appends.push(row);
      details.push({
        action: 'ADD', sheet: def.targetSheet, isoDate: isoDate,
        field: '（整行）', oldValue: '', newValue: summariseContentRow_(row, def)
      });
    } else if (existing.ACTIVE === true) {
      deactivations.push({ rowNo: existing.__rowNo, isoDate: isoDate });
      details.push({
        action: 'REMOVE', sheet: def.targetSheet, isoDate: isoDate,
        field: 'ACTIVE', oldValue: 'TRUE', newValue: 'FALSE'
      });
    } else {
      unchanged++;
    }
  }

  return { updates: updates, appends: appends, deactivations: deactivations, details: details, unchanged: unchanged };
}

/**
 * 用途：把一行資料濃縮成一句可讀的摘要，供差異明細顯示「新增了什麼」。
 * Args:
 *   row {Object} 目標表的資料列。
 *   def {Object} `contentImportTargets_()` 其中一項。
 * Returns:
 *   {string} 最多 60 字。
 */
function summariseContentRow_(row, def) {
  var parts = Object.keys(def.fieldMap).map(function (sourceKey) {
    var v = row[def.fieldMap[sourceKey]];
    return (v === null || v === undefined) ? '' : String(v);
  }).filter(function (v) { return v !== ''; });
  var text = parts.join('｜');
  return text.length > 60 ? text.slice(0, 60) + '…' : text;
}

/**
 * 用途：算出整個匯入的差異計畫。**預覽與實際寫入用同一個函式**——
 *   看到什麼就會寫什麼。純函式。
 * Args:
 *   input {{targets:Object, skippedTabs:string[], warnings:string[],
 *          existingLists:Object<string,Object[]>, existingWeeks:Object[],
 *          serviceDates:string[], tabNames:(string[]|null)=, skipListDates:Object=}}
 *     `tabNames` 有值就只處理那幾張分頁（見 `previewContentImport_()`）。
 *     `skipListDates` 見 `buildContentImportTargets_()`。
 *     `serviceDates` 是這次匯入的範圍（整季或單一主日）；清單類與週欄位類
 *     的分頁都只處理範圍內的主日。
 *     `existingLists` 是「目標表名稱 → 該表全部資料列（帶 `__rowNo`）」；
 *     `existingWeeks` 是 `BulletinWeeks` 全部資料列（帶 `__rowNo`）。
 *
 *   F5：對每一個**啟用中**的第三種欄位覆寫，若內容表**現在**的值等於覆寫值，
 *   該覆寫要解除（`plan.releases`）。判斷的是「內容表現值 = 覆寫值」，
 *   **不是**「覆寫值 = 覆寫當時的來源值」：前者才反映幹事此刻想要的狀態
 *   ——覆寫當時的來源值可能是空白（先在介面填過、後來才有內容表），或者
 *   內容表其後改過；用舊的來源值去比，幹事改回內容表的值也永遠解除不了，
 *   之後內容表再改，匯入一律報「你自己改過」而不更新。
 * Returns:
 *   {{added:number, updated:number, removed:number, unchanged:number,
 *     details:Object[], warnings:string[], skippedTabs:string[],
 *     listPlans:Object, weekUpdates:Object[], conflicts:Object[],
 *     releases:{isoDate:string, field:string, overrideValue:*, row:Object}[],
 *     blankActiveRows:Object[]}}
 */
function computeContentImportPlan_(input) {
  var plan = {
    added: 0, updated: 0, removed: 0, unchanged: 0,
    details: [], warnings: (input.warnings || []).slice(),
    skippedTabs: (input.skippedTabs || []).slice(),
    listPlans: {}, weekUpdates: [],
    // R-043／R-045：有覆寫、所以這一次匯入**刻意不蓋過去**的欄位。
    // ⚠️ 不算入 added／updated／removed／unchanged 任何一個——它是第五種
    //    結果：「內容表有新值，但你自己改過，所以冇動你」。
    conflicts: [],
    // F5：內容表現值已經等於覆寫值、所以要解除的覆寫（`ACTIVE` 改 FALSE，不刪行）。
    releases: [],
    // D-4：「有效」留空的行。留空當成 TRUE 是刻意的，但一定要講出來。
    blankActiveRows: (input.blankActiveRows || []).slice()
  };

  var weekByDate = {};
  (input.existingWeeks || []).forEach(function (w) {
    weekByDate[formatIsoDate_(w.SERVICE_DATE)] = w;
  });

  // BulletinWeeks 同一個主日可能同時被「崇拜人數」與「宣召」改到，
  // 所以先累積成「一個主日一批改動」，最後才算「修改了幾多行」。
  var weekChangesByDate = {};

  contentImportTargets_().forEach(function (def) {
    // 分頁篩選（與下面的主日篩選同一個做法）：不在 `input.tabNames` 內的分頁一格都不動。
    if (input.tabNames && input.tabNames.indexOf(def.tabName) === -1) return;

    var byDate = (input.targets || {})[def.tabName];
    if (!byDate) return; // 整張空白，已經在 skippedTabs 內

    if (def.kind === 'LIST') {
      var existingAll = (input.existingLists || {})[def.targetSheet] || [];
      var listPlan = { updates: [], appends: [], deactivations: [] };

      (input.serviceDates || []).forEach(function (iso) {
        // ⚠️ **範圍內每一個主日都要比對**，包括內容表完全沒有提到的那些
        // ——那代表「那一週沒有任何一則」，所以既有的行要停用。
        //
        // 「有人不小心清空」那個風險，已經由**分頁層**的空白保護擋住了
        // （整張空白就整張跳過，見 `buildContentImportTargets_()`）。如果
        // 這裡再按主日跳過，就會變成「一週的最後一則永遠刪不走」——堂委
        // 把那一則由內容表刪掉，週報上仍然照印。
        // 內容表 v2：這個主日有格被試算表轉成日期／時間（`classifyContentTypeIssues_()`），
        //    這一次整個主日不比對——既有的行一格不動，警告已經在 plan.warnings。
        if (((input.skipListDates || {})[def.tabName] || {})[iso]) return;

        var existingForDate = existingAll
          .filter(function (r) { return formatIsoDate_(r.SERVICE_DATE) === iso; })
          .sort(function (a, b) { return Number(a.SEQ_NO || 0) - Number(b.SEQ_NO || 0); });

        var result = diffContentListForDate_(existingForDate, byDate[iso] || [], def, iso);
        listPlan.updates = listPlan.updates.concat(result.updates);
        listPlan.appends = listPlan.appends.concat(result.appends);
        listPlan.deactivations = listPlan.deactivations.concat(result.deactivations);
        plan.details = plan.details.concat(result.details);
        plan.added += result.appends.length;
        plan.updated += result.updates.length;
        plan.removed += result.deactivations.length;
        plan.unchanged += result.unchanged;
      });

      plan.listPlans[def.targetSheet] = listPlan;
      return;
    }

    // WEEK 與 WEEK_ATTENDANCE：改 BulletinWeeks 同一行的幾個欄位。
    Object.keys(byDate).forEach(function (iso) {
      // ⚠️ 範圍篩選：`byDate` 是整季的內容，只匯入單一主日時（`serviceDates`
      //    只有那一個）其他主日一格都不可以動。清單類的分頁早已按
      //    `serviceDates` 逐日處理，這裏漏了篩選，結果「只匯入選定的一個
      //    主日」會把其他主日的講題、人數、宣召也一併更新。
      //    篩選要排在「找不到那一行」的警告之前，範圍外的主日不應該出警告。
      if ((input.serviceDates || []).indexOf(iso) === -1) return;

      var week = weekByDate[iso];
      if (!week) {
        plan.warnings.push(def.tabName + '：週報試算表未有 ' + iso
          + ' 這一個主日，本次略過。可以先用選單「建立本季空白週報」建好骨架。');
        return;
      }
      var sourceRow = byDate[iso][0];
      Object.keys(def.fieldMap).forEach(function (sourceKey) {
        // 內容表 v2：這一格被試算表轉成日期／時間，這一次不匯入（不寫、不解除覆寫、不報衝突），
        //    週報保留原值；警告已經在 plan.warnings。
        if ((sourceRow.__typeIssues || []).indexOf(sourceKey) !== -1) return;
        var targetKey = def.fieldMap[sourceKey];
        var newValue = sourceRow[sourceKey];

        // ⚠️ F5：解除覆寫的判斷一定要排在下面「週報現值＝內容表值就 return」
        //    **之前**——幹事改回內容表的值之後，兩邊正正相等，那一行 return
        //    之後就永遠碰不到覆寫行。範圍已由上面的主日篩選限定。
        var ov = null;
        if (def.overridable === true) {
          ov = (input.fieldOverrideIndex || {})[fieldOverrideKey_(iso, targetKey)] || null;
          if (ov && contentValuesEqual_(ov.OVERRIDE_VALUE, newValue)) {
            plan.releases.push({ isoDate: iso, field: targetKey, overrideValue: ov.OVERRIDE_VALUE, row: ov });
            plan.details.push({
              action: 'RELEASE', sheet: SHEETS.FIELD_OVERRIDE, isoDate: iso,
              field: targetKey, oldValue: ov.OVERRIDE_VALUE, newValue: newValue
            });
            // 已經解除，這一格從此跟隨內容表，下面不可以再當成「你自己改過」。
            ov = null;
          }
        }

        if (contentValuesEqual_(week[targetKey], newValue)) return;

        // ⚠️ 第三種模式的核心那一條：**有覆寫就不蓋過去，只提醒。**
        //    這裏 return 之前一定要記一筆 conflict——靜靜不改而不講，
        //    幹事會以為內容表那個新值已經入咗週報。
        if (def.overridable === true) {
          if (ov) {
            plan.conflicts.push({
              isoDate: iso, field: targetKey,
              overrideValue: ov.OVERRIDE_VALUE,
              sourceValue: newValue,
              sourceValueAtOverride: ov.SOURCE_VALUE_AT_OVERRIDE
            });
            plan.details.push({
              action: 'CONFLICT', sheet: SHEETS.BULLETIN_WEEKS, isoDate: iso,
              field: targetKey, oldValue: ov.OVERRIDE_VALUE, newValue: newValue
            });
            return;
          }
        }

        if (!weekChangesByDate[iso]) weekChangesByDate[iso] = { rowNo: week.__rowNo, isoDate: iso, changes: [] };
        weekChangesByDate[iso].changes.push({ field: targetKey, oldValue: week[targetKey], newValue: newValue });
        plan.details.push({
          action: 'UPDATE', sheet: SHEETS.BULLETIN_WEEKS, isoDate: iso,
          field: targetKey, oldValue: week[targetKey], newValue: newValue
        });
      });
    });
  });

  Object.keys(weekChangesByDate).sort().forEach(function (iso) {
    plan.weekUpdates.push(weekChangesByDate[iso]);
    plan.updated++;
  });

  return plan;
}

// =====================================================================
// 真正入口
// =====================================================================

/**
 * 用途：內容表 v2：核對一張分頁第 2 行（機器鍵）與定義是否相符。純函式。
 * Args:
 *   expectedKeys {string[]} 定義的機器鍵（欄次序）。
 *   actualKeys {string[]} 第 2 行頭幾欄（`readContentTabHeaderKeys_()`，長度與 `expectedKeys` 相同）。
 * Returns:
 *   {{status:string, missing:number, column:number, expected:string, actual:string}}
 *     `status`：`'OK'`／`'OUTDATED'`（第 2 行是定義的前綴，後面幾欄還未加）／`'HEADER_CHANGED'`
 *     （其他不符：欄被改名、插入、刪除或移動）。`OUTDATED` 時 `missing` 是缺幾欄；
 *     `HEADER_CHANGED` 時 `column`（1 起算）、`expected`、`actual` 指出第一個不符的位置。
 * Raises:
 *   （無）
 */
function compareContentTabHeaderKeys_(expectedKeys, actualKeys) {
  var actual = actualKeys || [];
  var firstBlank = -1;
  for (var i = 0; i < expectedKeys.length; i++) {
    var got = String(actual[i] === undefined ? '' : actual[i]);
    if (got === expectedKeys[i]) {
      if (firstBlank !== -1) {
        return { status: 'HEADER_CHANGED', missing: 0, column: firstBlank + 1, expected: expectedKeys[firstBlank], actual: '' };
      }
      continue;
    }
    if (got === '') {
      if (firstBlank === -1) firstBlank = i;
      continue;
    }
    return { status: 'HEADER_CHANGED', missing: 0, column: i + 1, expected: expectedKeys[i], actual: got };
  }
  if (firstBlank === -1) return { status: 'OK', missing: 0, column: 0, expected: '', actual: '' };
  return { status: 'OUTDATED', missing: expectedKeys.length - firstBlank, column: firstBlank + 1, expected: expectedKeys[firstBlank], actual: '' };
}

/**
 * 用途：內容表 v2（bug class 50）：匯入按欄位位置讀，所以讀資料之前逐張核對第 2 行。不符就
 *   整次拒絕，一格都不寫——否則加了新欄而未移轉的內容表會在新欄位置讀到空白，清空週報的序樂、
 *   宣召等欄；被人插入或移動過欄的內容表會把甲欄的值寫進乙欄。分頁不存在照舊當作整張空白
 *   （不在這裏拒絕）。所有匯入入口（選單、單週、整季、重設、自測）都經 `previewContentImport_()`。
 * Args:
 *   spreadsheet {Spreadsheet} 已經開啟的內容表。
 * Returns:
 *   {{ok:boolean, reason:string, message:string, tabs:{tabName:string, status:string}[]}}
 *     `reason`：`''`／`'CONTENT_SHEET_OUTDATED'`／`'CONTENT_SHEET_HEADER_CHANGED'`
 *     （兩種同時有的話報 `HEADER_CHANGED`，那一種要人手處理）。
 * Raises:
 *   Error 讀取分頁失敗時原樣拋出。
 */
function checkContentSheetSchema_(spreadsheet) {
  var tabs = [];
  var outdated = [];
  var changed = [];
  // 內容表 v2：未改名的舊分頁（宣召、浸禮合堂）仍然在 → 未移轉。匯入只讀新定義的分頁，舊分頁
  //    上的資料不會被讀到；移轉（建立／刷新本季內容表）會把它搬入「崇拜程序」並改名。
  var pendingLegacy = legacyMergedTabDefs_().filter(function (def) {
    return Boolean(spreadsheet.getSheetByName(def.tabName));
  }).map(function (def) { return def.tabName; });
  var worshipTabName = contentSheetWorshipTabDef_().tabName;
  var v2Keys = contentSheetWorshipKeysV2_();
  contentSheetTabDefs_().forEach(function (tabDef) {
    var sheet = spreadsheet.getSheetByName(tabDef.tabName);
    if (!sheet) return;
    var verdict = compareContentTabHeaderKeys_(tabDef.keys, readContentTabHeaderKeys_(sheet, tabDef.keys.length));
    // v3：v2 的「崇拜程序」（第 12 欄是浸禮主禮）不是「被人改過」，是未更新——當作 OUTDATED，
    //    講明要拿走浸禮六欄並加「詩班項目名稱」。
    if (verdict.status === 'HEADER_CHANGED' && tabDef.tabName === worshipTabName) {
      var longHeader = readContentTabHeaderKeys_(sheet, v2Keys.length);
      if (v2Keys.every(function (k, i) { return longHeader[i] === k; })) {
        verdict = { status: 'OUTDATED', missing: 1, column: 12, expected: 'CHOIR_LABEL', actual: '', v2: true };
      }
    }
    tabs.push({ tabName: tabDef.tabName, status: verdict.status });
    if (verdict.status === 'OUTDATED') outdated.push({ tabDef: tabDef, verdict: verdict });
    if (verdict.status === 'HEADER_CHANGED') changed.push({ tabDef: tabDef, verdict: verdict });
  });

  if (changed.length > 0) {
    return {
      ok: false, reason: 'CONTENT_SHEET_HEADER_CHANGED', tabs: tabs,
      message: changed.map(function (c) {
        return '內容表「' + c.tabDef.tabName + '」第 2 行（機器鍵）第 ' + c.verdict.column + ' 欄應該是「'
          + c.verdict.expected + '」，現在是「' + (c.verdict.actual || '（空白）') + '」。';
      }).join('') + '匯入按欄位位置讀，第 2 行不符就會讀錯欄，所以這次整次拒絕，一格都沒有寫。'
        + '請把第 2 行改回原樣；如果曾經插入、刪除或移動欄，請先復原（檔案 ▸ 版本記錄），再匯入。'
    };
  }
  if (outdated.length > 0 || pendingLegacy.length > 0) {
    var reasons = outdated.map(function (o) {
      if (o.verdict.v2) return '「' + o.tabDef.tabName + '」仍然有浸禮六欄，未加「詩班項目名稱」';
      return '「' + o.tabDef.tabName + '」少了 ' + o.verdict.missing + ' 欄';
    }).concat(pendingLegacy.map(function (name) {
      return '仍然有舊的「' + name + '」分頁（內容要搬入「崇拜程序」）';
    }));
    return {
      ok: false, reason: 'CONTENT_SHEET_OUTDATED', tabs: tabs,
      message: '本季內容表比系統舊（' + reasons.join('、') + '），這次匯入整次拒絕，一格都沒有寫。'
        + '請先在填寫介面按內容表狀態列的「更新本季內容表…」（或者試算表選單的「建立本季內容表」），再匯入。'
    };
  }
  return { ok: true, reason: '', message: '', tabs: tabs };
}

/**
 * 用途：內容表 v2：按季度找到內容表並核對第 2 行（「重設這一週」寫入之前用）。唯讀。
 * Args:
 *   quarterId {string} 季度 ID。
 * Returns:
 *   {{ok:boolean, reason:string, message:string}} 本季沒有內容表、或者內容表開不到，回 `ok:true`
 *     ——那兩種情況由匯入本身講出來（與以前一樣），這裏只擋「第 2 行不符」。
 * Raises:
 *   Error 讀 ContentSheets 或分頁失敗時原樣拋出。
 */
function checkQuarterContentSheetSchema_(quarterId) {
  var row = findContentSheetRow_(String(quarterId || '').trim());
  if (!row) return { ok: true, reason: '', message: '' };
  var spreadsheet = openContentSpreadsheet_(row.FILE_ID);
  if (!spreadsheet) return { ok: true, reason: '', message: '' };
  var schema = checkContentSheetSchema_(spreadsheet);
  return { ok: schema.ok, reason: schema.reason, message: schema.message };
}

/**
 * 用途：讀出內容表全部分頁的原始資料。
 * Args:
 *   spreadsheet {Spreadsheet} 已經開啟的內容表。
 * Returns:
 *   {Object<string,Object[]>} 分頁名稱 → `parseContentTabRows_()` 的輸出。
 *     分頁不存在、或者只有標題兩行，一律回空陣列（＝那一張整張空白）。
 */
function readContentSheetTabs_(spreadsheet) {
  var out = {};
  contentSheetTabDefs_().forEach(function (tabDef) {
    var sheet = spreadsheet.getSheetByName(tabDef.tabName);
    if (!sheet) { out[tabDef.tabName] = []; return; }

    var lastRow = sheet.getLastRow();
    if (lastRow < CONTENT_SHEET_FIRST_DATA_ROW_) { out[tabDef.tabName] = []; return; }

    var values = sheet.getRange(
      CONTENT_SHEET_FIRST_DATA_ROW_, 1,
      lastRow - CONTENT_SHEET_HEADER_ROWS_, tabDef.keys.length
    ).getValues();
    out[tabDef.tabName] = parseContentTabRows_(values, tabDef.keys);
  });
  return out;
}

/**
 * 用途：算出指定季度（或者單一主日）的匯入差異計畫。**唯讀，不寫任何嘢。**
 *   選單與 Web App 兩個入口都經過這裡（不可以各寫一套）。
 * Args:
 *   quarterId {string} 季度 ID。
 *   options {{isoDate:string=, tabNames:string[]=}=} 有 `isoDate` 就只匯入那一個
 *     主日，省略代表整季；有 `tabNames` 就只匯入那幾張分頁（講員表格答案只匯入
 *     「崇拜程序」，與主日篩選同一個做法），省略代表全部分頁。
 * Returns:
 *   {{ok:boolean, quarterId:string, scope:string, plan:(Object|undefined),
 *     fileUrl:(string|undefined), reason:(string|undefined),
 *     message:(string|undefined)}}
 *     `ok:false` 時一定有 `reason` 與一句人看得懂的 `message`。
 */
function previewContentImport_(quarterId, options) {
  var opts = options || {};
  var qid = String(quarterId || '').trim();
  if (!qid) {
    return { ok: false, quarterId: qid, scope: 'QUARTER', reason: 'NO_QUARTER_ID', message: '季度 ID 不可以是空的。' };
  }

  var row = findContentSheetRow_(qid);
  if (!row) {
    return {
      ok: false, quarterId: qid, scope: 'QUARTER', reason: 'NO_CONTENT_SHEET',
      message: '季度「' + qid + '」尚未建立內容表。職事表已經有這一季的話，系統會自動建立（每日一次，或者重新開啟填寫介面）；'
        + '亦可以在試算表選單「內容表 ▸ 建立本季內容表」立即建立。'
    };
  }

  var spreadsheet = openContentSpreadsheet_(row.FILE_ID);
  if (!spreadsheet) {
    return {
      ok: false, quarterId: qid, scope: 'QUARTER', reason: 'FILE_MISSING',
      message: '季度「' + qid + '」的內容表現在無法開啟（檔案 ID 開頭 '
        + maskContentFileId_(row.FILE_ID) + '）——可能已被刪除、移到沒有權限的位置，或者 ID 不正確。'
        + '請在週報試算表的 ContentSheets 工作表找到季度「' + qid + '」那一行，'
        + '確認檔案 ID 是否正確；如果那個檔案已經不存在，請將該行的「有效」改為 FALSE，'
        + '然後重新建立一次內容表。'
    };
  }

  // ⚠️ 不可以只讀職事表。R-036 之後，職事表未有該季資料一樣建立得到週報，
  //    而舊版這一行是 `listQuarterServiceDates_()`（只讀職事表），於是那些
  //    季度的匯入永遠是「新增 0、修改 0、刪除 0、不變 0」——**不是報錯，
  //    是靜靜地什麼都不做**，比報錯難發現得多。
  //    退回的只是「用哪一份主日清單」，三個來源全部只看同一個季度，
  //    一個都不會跨季。見 docs/已知bug類型.md 事故四十一。
  var dateResolution = resolveQuarterServiceDateEntries_(qid);
  var allServiceDates = dateResolution.dates;

  if (allServiceDates.length === 0) {
    return {
      ok: false, quarterId: qid, scope: 'QUARTER', reason: 'NO_SERVICE_DATES',
      message: '季度「' + qid + '」找不到任何主日：' + dateResolution.message
        + '　請先按選單「建立本季空白週報」。'
    };
  }
  var scope = opts.isoDate ? 'ONE_WEEK' : 'QUARTER';
  var serviceDates = allServiceDates;

  if (opts.isoDate) {
    if (allServiceDates.indexOf(opts.isoDate) === -1) {
      return {
        ok: false, quarterId: qid, scope: scope, reason: 'DATE_NOT_IN_QUARTER',
        message: '主日 ' + opts.isoDate + ' 不屬於季度「' + qid + '」，無法只匯入這一個主日。'
      };
    }
    serviceDates = [opts.isoDate];
  }

  // 內容表 v2：讀資料之前先核對第 2 行，不符就整次拒絕（見 checkContentSheetSchema_()）。
  var schema = checkContentSheetSchema_(spreadsheet);
  if (!schema.ok) {
    return { ok: false, quarterId: qid, scope: scope, reason: schema.reason, message: schema.message };
  }

  var contentData = readContentSheetTabs_(spreadsheet);
  // ⚠️ 「連續到」一定要用**整季**的主日展開，之後才篩出要匯入的那一個
  // 主日——否則只匯入單一主日時，一條由上一週連登過來的報告會消失。
  var built = buildContentImportTargets_(contentData, allServiceDates);
  // 分頁篩選：沒有被選中的分頁連「整張空白」的提示也不要出（它們根本不在這次範圍內）。
  var tabNames = Array.isArray(opts.tabNames) ? opts.tabNames : null;
  if (tabNames) {
    built.skippedTabs = built.skippedTabs.filter(function (name) { return tabNames.indexOf(name) !== -1; });
  }

  var existingLists = {};
  contentImportTargets_().forEach(function (def) {
    if (def.kind !== 'LIST') return;
    if (existingLists[def.targetSheet]) return;
    existingLists[def.targetSheet] = readRowsWithRowNo_(def.targetSheet);
  });

  var plan = computeContentImportPlan_({
    targets: built.targets,
    skippedTabs: built.skippedTabs,
    warnings: built.warnings,
    blankActiveRows: built.blankActiveRows,
    skipListDates: built.skipListDates,
    existingLists: existingLists,
    existingWeeks: readRowsWithRowNo_(SHEETS.BULLETIN_WEEKS),
    serviceDates: serviceDates,
    tabNames: tabNames,
    // R-043／R-045：第三種模式要知道邊幾格已經被人手覆寫。
    // ⚠️ 讀**整季**的覆寫，不是只讀 serviceDates 那幾個——單一主日匯入時
    //    serviceDates 只有一個，但索引的鍵本來就帶主日，多讀不會影響判斷，
    //    少讀就會漏。
    fieldOverrideIndex: buildFieldOverrideIndex_(readRowsWithRowNo_(SHEETS.FIELD_OVERRIDE))
  });

  // ⚠️ 主日清單由哪裏來一定要講出來。用了退而求其次的來源而不講，
  //    下一個人看到數字對不上會查錯方向。
  return {
    ok: true, quarterId: qid, scope: scope, plan: plan,
    fileUrl: String(row.FILE_URL || ''),
    serviceDateSource: dateResolution.source,
    serviceDateNote: dateResolution.message
  };
}

/**
 * 用途：真的把差異寫入週報試算表。**一定要先跑過
 *   `previewContentImport_()`**——本函式自己再跑一次，確保「看到的」與
 *   「寫入的」是同一份計畫。
 *
 *   ⚠️ 整個寫入包在 `LockService` 內：`Fill_*` 的同步觸發器同樣會寫
 *   `BulletinWeeks`，兩者撞在一起會互相覆蓋。
 *
 *   寫入之前，每個真的會被改到的主日各存一個版本（`WeekSnapshots`，
 *   原因 `CONTENT_IMPORT_WEEK`／`CONTENT_IMPORT_QUARTER`）。存不到不阻止匯入，
 *   但會在結果的 `snapshotWarnings` 講出來。
 * Args:
 *   quarterId {string} 季度 ID。
 *   options {{isoDate:string=, skipSnapshot:boolean=}=} 同 `previewContentImport_()`；
 *     `skipSnapshot` 為真代表呼叫方已經自己存過版本（「重設這一週」），不再重複存。
 * Returns:
 *   {{ok:boolean, quarterId:string, scope:string, plan:(Object|undefined),
 *     fileUrl:(string|undefined), reason:(string|undefined), message:(string|undefined),
 *     snapshotWarnings:(string[]|undefined)}}
 * Raises:
 *   Error 如果拿不到鎖（30 秒內）——寧可失敗也不要與同步觸發器同時寫。
 */
function applyContentImport_(quarterId, options) {
  var preview = previewContentImport_(quarterId, options);
  if (!preview.ok) return preview;
  var skipSnapshot = Boolean(options && options.skipSnapshot === true);

  // D12：經 withScriptLock_()。講員表格答案與重設（D13）拿着鎖再叫這裏，是巢狀呼叫：直接寫，
  // 不再等鎖、不提早放鎖（以前不知道 getScriptLock() 可不可以重入，見 FF-23）。
  return withScriptLock_('applyContentImport_', 30000, function () {
    // ⚠️ 版本一定要在寫入之前存。
    preview.snapshotWarnings = skipSnapshot ? [] : snapshotWeeksBeforeWrite_(
      contentImportAffectedDates_(preview.plan),
      preview.scope === 'ONE_WEEK' ? 'CONTENT_IMPORT_WEEK' : 'CONTENT_IMPORT_QUARTER'
    );
    writeContentImportPlan_(preview.plan);
    updateContentSheetField_(preview.quarterId, 'LAST_IMPORTED_AT', new Date());
    return preview;
  }, function () {
    var lockErr = new Error('applyContentImport_：30 秒內拿不到指令碼鎖，'
      + '可能有另一個匯入或者填寫表同步正在執行。請稍後再試一次。');
    lockErr.code = 'LOCK_TIMEOUT';
    throw lockErr;
  });
}

/**
 * 用途：找出一份匯入計畫會動到哪幾個主日的週報（填寫欄位或覆寫）。純函式。
 *   只動到清單類分頁（家事報告等）的主日不算——那些以內容表為準，不在版本裏面。
 * Args:
 *   plan {Object} `computeContentImportPlan_()` 的輸出。
 * Returns:
 *   {string[]} 主日日期，由舊到新，沒有重複。
 */
function contentImportAffectedDates_(plan) {
  var dates = {};
  ((plan && plan.weekUpdates) || []).forEach(function (update) {
    if (update.changes && update.changes.length > 0) dates[String(update.isoDate)] = true;
  });
  ((plan && plan.releases) || []).forEach(function (release) {
    dates[String(release.isoDate)] = true;
  });
  return Object.keys(dates).sort();
}

/**
 * 用途：把差異計畫寫入週報試算表，並逐格記 `AuditLog`。
 *
 *   ⚠️ 「刪除」一律 `ACTIVE=FALSE`，**不刪行**。
 * Args:
 *   plan {Object} `computeContentImportPlan_()` 的輸出。
 * Returns:
 *   {void}
 */
function writeContentImportPlan_(plan) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  // ---- 清單表 ----
  Object.keys(plan.listPlans).forEach(function (sheetName) {
    var listPlan = plan.listPlans[sheetName];
    var sheet = ss.getSheetByName(sheetName);
    if (!sheet) return;

    var def = COLUMNS[SHEET_ID_BY_NAME[sheetName]];
    var activeCol = def.keys.indexOf('ACTIVE') + 1;

    listPlan.updates.forEach(function (update) {
      update.changes.forEach(function (change) {
        if (def.keys.indexOf(change.field) < 0) return;
        // ⚠️ 經 setCellValueTextSafe_()：設計上是文字的欄位要先設 '@' 再寫，
        //    否則 '42,150' 會變成數字 42150。見 docs/已知bug類型.md 事故二十八。
        setCellValueTextSafe_(sheet, def, update.rowNo, change.field,
          change.field === 'ACTIVE' ? change.newValue : sanitizeCellText_(change.newValue));
        appendContentImportAudit_(sheetName, update.isoDate, change);
      });
    });

    listPlan.deactivations.forEach(function (row) {
      if (activeCol <= 0) return;
      sheet.getRange(row.rowNo, activeCol).setValue(false);
      appendContentImportAudit_(sheetName, row.isoDate,
        { field: 'ACTIVE', oldValue: 'TRUE', newValue: 'FALSE' });
    });

    if (listPlan.appends.length > 0) {
      var rows = listPlan.appends.map(function (row) {
        var out = {};
        def.keys.forEach(function (key) {
          if (key === 'SERVICE_DATE') { out[key] = normalizeDate_(row.SERVICE_DATE); return; }
          if (key === 'ACTIVE') { out[key] = true; return; }
          if (key === 'SEQ_NO') { out[key] = row.SEQ_NO; return; }
          out[key] = (row[key] === undefined || row[key] === null) ? '' : sanitizeCellText_(row[key]);
        });
        return out;
      });
      writeSheet(sheetName, rows);
      listPlan.appends.forEach(function (row) {
        appendContentImportAudit_(sheetName, row.SERVICE_DATE,
          { field: '（整行）', oldValue: '', newValue: '新增一行' });
      });
    }
  });

  // ---- BulletinWeeks ----
  plan.weekUpdates.forEach(function (update) {
    update.changes.forEach(function (change) {
      writeBulletinWeekField_(update.isoDate, change.field, change.newValue);
      appendContentImportAudit_(SHEETS.BULLETIN_WEEKS, update.isoDate, change);
    });
  });

  // ---- F5：解除已經與內容表一致的覆寫 ----
  releaseFieldOverrides_(plan.releases || []);
}

/**
 * 用途：把一批「已經與內容表一致」的 `FieldOverride` 解除：`ACTIVE` 改
 *   `FALSE`（**不刪行**，記錄保留），逐筆記 `AuditLog` 的
 *   `FIELD_OVERRIDE_RELEASE`。
 * Args:
 *   releases {{isoDate:string, field:string, overrideValue:*, row:Object}[]}
 *     `computeContentImportPlan_()` 的 `plan.releases`；`row.__rowNo` 是
 *     `FieldOverride` 工作表的實際行號。
 * Returns:
 *   {void}
 * Raises:
 *   Error 如果有東西要解除、但 `FieldOverride` 工作表不存在——有東西要寫
 *     卻沒有表可以寫，是必須講出來的結構問題。
 */
function releaseFieldOverrides_(releases) {
  if (!releases || releases.length === 0) return;
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.FIELD_OVERRIDE);
  if (!sheet) {
    throw new Error('releaseFieldOverrides_：找不到工作表「' + SHEETS.FIELD_OVERRIDE
      + '」，請先執行「初始化工作表」。');
  }
  var activeCol = COLUMNS.FIELD_OVERRIDE.keys.indexOf('ACTIVE') + 1;
  releases.forEach(function (r) {
    sheet.getRange(r.row.__rowNo, activeCol).setValue(false);
    appendAuditLog_({
      action: 'FIELD_OVERRIDE_RELEASE',
      sheetName: SHEETS.FIELD_OVERRIDE,
      rowKey: r.isoDate + '#' + r.field,
      field: 'ACTIVE',
      oldValue: 'TRUE',
      newValue: 'FALSE',
      notes: '內容表現在的值已經與覆寫值一致（「' + String(r.overrideValue || '（空白）')
        + '」），改回跟隨內容表。記錄保留，不刪行。'
    });
  });
}

/**
 * 用途：為匯入寫的每一格記一筆 `AuditLog`，來源標明是內容表。
 * Args:
 *   sheetName {string} 目標工作表名稱。
 *   isoDate {*} 主日（會轉成字串）。
 *   change {{field:string, oldValue:*, newValue:*}}
 * Returns:
 *   {void}
 */
function appendContentImportAudit_(sheetName, isoDate, change) {
  appendAuditLog_({
    action: CONTENT_IMPORT_AUDIT_ACTION_,
    sheetName: sheetName,
    rowKey: String(isoDate === null || isoDate === undefined ? '' : isoDate),
    field: change.field,
    oldValue: String(change.oldValue === null || change.oldValue === undefined ? '' : change.oldValue),
    newValue: String(change.newValue === null || change.newValue === undefined ? '' : change.newValue),
    notes: '由內容表匯入。'
  });
}

// =====================================================================
// 報告
// =====================================================================

/**
 * 用途：把匯入計畫排版成對話框要顯示的內容行——四個數字、前 20 行明細、
 *   整張空白的分頁說明、警告。
 * Args:
 *   result {Object} `previewContentImport_()` 的回傳值（`ok:true`）。
 *   options {{dryRun:boolean=, applied:boolean=}=} `applied` 為 true 代表
 *     已經寫入（措辭由「將會」改成「已經」）。
 * Returns:
 *   {string[]}
 */
function buildContentImportDialogLines_(result, options) {
  var opts = options || {};
  var plan = result.plan;
  var verb = opts.applied ? '已' : '將會';
  var lines = [];

  lines.push('季度：' + result.quarterId
    + (result.scope === 'ONE_WEEK' ? '（只匯入選定的一個主日）' : '（整季）'));
  lines.push('');
  lines.push(verb + '新增 ' + plan.added + ' 行　'
    + verb + '修改 ' + plan.updated + ' 行　'
    + verb + '刪除 ' + plan.removed + ' 行　不變 ' + plan.unchanged + ' 行');
  lines.push('（「刪除」是把「有效」改為 FALSE，不會真的刪走任何一行。）');

  // ⚠️ R-043／R-045：覆寫過的欄位排喺**最前**（緊接住四個數字），
  //    因為它答的是「內容表明明改咗，點解週報冇變」——那是幹事最容易
  //    誤會成 bug 的一種結果。排喺明細下面就會被淹沒。
  if ((plan.conflicts || []).length > 0) {
    lines.push('');
    lines.push('✋ 有 ' + plan.conflicts.length + ' 格你自己改過，所以這一次沒有蓋過去：');
    plan.conflicts.slice(0, 10).forEach(function (c) {
      lines.push('　' + c.isoDate + '　' + contentFieldLabel_(c.field)
        + '：你填的是「' + (c.overrideValue || '（空白）')
        + '」，內容表現在是「' + (c.sourceValue || '（空白）') + '」');
    });
    if (plan.conflicts.length > 10) {
      lines.push('　（其餘 ' + (plan.conflicts.length - 10) + ' 格見完整明細。）');
    }
    lines.push('　想改回跟隨內容表，把填寫介面那一格改成與內容表相同即可。');
  }

  // F5：覆寫的值已經與內容表一致，這一次匯入把它解除。
  if ((plan.releases || []).length > 0) {
    lines.push('');
    lines.push('ℹ️ 有 ' + plan.releases.length + ' 格你之前改過的值，現在已經與內容表一致，'
      + (opts.applied ? '已從此改回跟隨內容表。' : '將會從此改回跟隨內容表。'));
  }

  // ⚠️ D-4：留空的「有效」不可以靜靜當成 TRUE。
  if ((plan.blankActiveRows || []).length > 0) {
    lines.push('');
    lines.push('ℹ️ 有 ' + plan.blankActiveRows.length + ' 行的「有效」是空白的，'
      + '本次當成 TRUE（會匯入）：');
    plan.blankActiveRows.slice(0, 10).forEach(function (b) {
      lines.push('　' + b.tabName + ' 第 ' + b.rowNo + ' 行'
        + (b.isoDate ? ('（' + b.isoDate + '）') : ''));
    });
    if (plan.blankActiveRows.length > 10) {
      lines.push('　（其餘 ' + (plan.blankActiveRows.length - 10) + ' 行見完整明細。）');
    }
    lines.push('　如果其中有些其實想停用，請在內容表那一格填 FALSE，然後再匯入一次。');
  }

  if (plan.skippedTabs.length > 0) {
    lines.push('');
    plan.skippedTabs.forEach(function (tabName) {
      lines.push(tabName + '：內容表沒有資料，本次不改動。');
    });
  }

  if (plan.warnings.length > 0) {
    lines.push('');
    lines.push('⚠️ 提示 ' + plan.warnings.length + ' 項：');
    plan.warnings.slice(0, 5).forEach(function (w) { lines.push('　' + w); });
    if (plan.warnings.length > 5) {
      lines.push('　（其餘 ' + (plan.warnings.length - 5) + ' 項已寫入 Diagnostics。）');
    }
  }

  if (plan.details.length > 0) {
    lines.push('');
    lines.push('明細（前 ' + Math.min(CONTENT_IMPORT_PREVIEW_ROWS_, plan.details.length) + ' 行）：');
    plan.details.slice(0, CONTENT_IMPORT_PREVIEW_ROWS_).forEach(function (d) {
      lines.push('　' + formatContentImportDetail_(d));
    });
    if (plan.details.length > CONTENT_IMPORT_PREVIEW_ROWS_) {
      lines.push('　（共 ' + plan.details.length + ' 行，全份已寫入 Diagnostics 工作表。）');
    }
  }

  if ((result.snapshotWarnings || []).length > 0) {
    lines.push('');
    result.snapshotWarnings.forEach(function (w) { lines.push('⚠️ ' + w); });
  }

  if (opts.dryRun) {
    lines.push('');
    lines.push('註：目前 DRY_RUN 是 TRUE（模擬模式），但匯入不受它限制——'
      + '匯入只是把資料由內容表搬到週報，不會寄出任何郵件。');
  }

  return lines;
}

/**
 * 用途：把一項差異明細排版成一行。
 * Args:
 *   detail {{action:string, sheet:string, isoDate:string, field:string,
 *           oldValue:*, newValue:*}}
 * Returns:
 *   {string}
 */
function formatContentImportDetail_(detail) {
  // ⚠️ CONFLICT 的箭嘴方向要**倒轉**：其餘三種是「舊 → 新」，
  //    CONFLICT 是「內容表想改成新值，但你填的舊值贏咗」。用同一個
  //    箭嘴方向會令人以為值已經改咗。
  var actionText = {
    ADD: '新增', UPDATE: '修改', REMOVE: '停用', CONFLICT: '沒有蓋過', RELEASE: '解除覆寫'
  }[detail.action] || detail.action;
  var oldText = truncateForReport_(detail.oldValue);
  var newText = truncateForReport_(detail.newValue);
  var oldShown = (oldText === '' ? '（空白）' : oldText);
  var newShown = (newText === '' ? '（空白）' : newText);

  if (detail.action === 'CONFLICT') {
    return actionText + '　' + detail.sheet + '　' + detail.isoDate + '　'
      + contentFieldLabel_(detail.field)
      + '　保留你填的「' + oldShown + '」（內容表現在是「' + newShown + '」）';
  }
  return actionText + '　' + detail.sheet + '　' + detail.isoDate + '　' + detail.field
    + '　' + oldShown + ' → ' + newShown;
}

/**
 * 用途：把 `BulletinWeeks` 機器鍵換成中文標題。**純函式。**
 *
 *   ⚠️ 找不到就原樣回機器鍵——講一個機器碼，好過不講。
 * Args:
 *   fieldKey {string}
 * Returns:
 *   {string}
 */
function contentFieldLabel_(fieldKey) {
  var idx = COLUMNS.BULLETIN_WEEKS.keys.indexOf(String(fieldKey || ''));
  return idx === -1 ? String(fieldKey || '') : COLUMNS.BULLETIN_WEEKS.headers[idx];
}

/**
 * 用途：把一個值縮短成適合放進報告一行的長度。
 * Args:
 *   value {*}
 * Returns:
 *   {string} 最多 40 字。
 */
function truncateForReport_(value) {
  var text = String(value === null || value === undefined ? '' : value).replace(/\s+/g, ' ').trim();
  return text.length > 40 ? text.slice(0, 40) + '…' : text;
}

/**
 * 用途：把完整的匯入差異寫成 `Diagnostics` 報告的內容行。
 *
 *   ⚠️ 區段標題一律用全形括號「【…】」，不可以用 `===` 開頭——見
 *   docs/已知bug類型.md 事故六。行數上限交給 `writeDiagnosticsReport_()`
 *   既有的 `DIAGNOSTICS_MAX_ROWS` 截斷機制統一處理。
 * Args:
 *   result {Object} `previewContentImport_()` 的回傳值（`ok:true`）。
 * Returns:
 *   {string[]}
 */
function buildContentImportReportLines_(result) {
  var plan = result.plan;
  var lines = [];

  lines.push('季度：' + result.quarterId + '　範圍：'
    + (result.scope === 'ONE_WEEK' ? '單一主日' : '整季'));
  lines.push('');
  lines.push('【摘要】');
  lines.push('新增 ' + plan.added + ' 行　修改 ' + plan.updated + ' 行　刪除 '
    + plan.removed + ' 行　不變 ' + plan.unchanged + ' 行');

  if (plan.skippedTabs.length > 0) {
    lines.push('');
    lines.push('【內容表沒有資料、本次不改動的分頁】');
    plan.skippedTabs.forEach(function (tabName) { lines.push('　' + tabName); });
  }

  if (plan.warnings.length > 0) {
    lines.push('');
    lines.push('【提示（' + plan.warnings.length + ' 項）】');
    plan.warnings.forEach(function (w) { lines.push('　' + w); });
  }

  lines.push('');
  lines.push('【逐行明細（' + plan.details.length + ' 行）】');
  plan.details.forEach(function (d) { lines.push('　' + formatContentImportDetail_(d)); });

  return lines;
}

/**
 * 用途：2026-10-28（Ivan 測試結果 B）：**自動**把內容表的最新內容匯入這一個主日。填寫介面每次載入一週
 *   （包括儲存之後重新載入）與星期一自動寄送之前都叫這一支，幹事不用再按「重新匯入」。
 *
 *   ⚠️ 與「重新匯入」按鈕、選單匯入同一組函式（`previewContentImport_()`／`applyContentImport_()`，
 *   bug class 3）。只在真的有改動時才寫（寫入之前照樣存版本，逐格 AuditLog）；沒有改動一格都不寫。
 *   本季未有內容表、內容表比系統舊、找不到季度——一律不寫、不拋錯，交回一句說明（載入週報不可以因為
 *   內容表出問題而整頁失敗）。已封存的主日不動。
 * Args:
 *   isoDate {string} 主日日期，yyyy-MM-dd。
 *   source {string} 誰叫的（AuditLog 備註用），例如 `'WEBAPP_LOAD'`、`'TRIGGER'`。
 * Returns:
 *   {{ran:boolean, changed:number, reason:string, message:string}}
 *     `ran`＝有試過匯入（找得到季度與內容表）；`changed`＝寫了幾項（新增＋修改＋刪除＋解除覆寫）；
 *     `reason` 為空字串＝正常，否則是 `previewContentImport_()` 的原因代碼或 `ERROR`／`ARCHIVED`。
 * Raises:
 *   （無）任何錯誤都轉成 `reason:'ERROR'` 並記 ErrorLog。
 */
function autoImportContentForWeek_(isoDate, source) {
  var iso = String(isoDate || '').trim();
  try {
    var quarterId = lookupQuarterIdForIsoDate_(iso);
    if (!quarterId) return { ran: false, changed: 0, reason: 'NO_QUARTER', message: '' };
    if (!findContentSheetRow_(quarterId)) return { ran: false, changed: 0, reason: 'NO_CONTENT_SHEET', message: '' };
    var weekRow = findBulletinWeekRow_(readSheet(SHEETS.BULLETIN_WEEKS), iso);
    if (weekRow && weekRow.ARCHIVED === true) return { ran: false, changed: 0, reason: 'ARCHIVED', message: '' };

    var preview = previewContentImport_(quarterId, { isoDate: iso });
    if (!preview.ok) return { ran: true, changed: 0, reason: preview.reason || 'PREVIEW_FAILED', message: preview.message || '' };
    var plan = preview.plan || {};
    var changeCount = Number(plan.added || 0) + Number(plan.updated || 0) + Number(plan.removed || 0)
      + ((plan.releases || []).length);
    if (changeCount === 0) return { ran: true, changed: 0, reason: '', message: '' };

    var applied = applyContentImport_(quarterId, { isoDate: iso });
    if (!applied.ok) return { ran: true, changed: 0, reason: applied.reason || 'APPLY_FAILED', message: applied.message || '' };
    appendAuditLog_({
      action: 'CONTENT_AUTO_IMPORT_WEEK', sheetName: SHEETS.CONTENT_SHEETS, rowKey: iso,
      newValue: '+' + applied.plan.added + ' ~' + applied.plan.updated + ' -' + applied.plan.removed,
      notes: '自動由內容表匯入 ' + iso + '（季度 ' + quarterId + '，' + String(source || '') + '）。'
    });
    return { ran: true, changed: changeCount, reason: '', message: '' };
  } catch (err) {
    appendErrorLog_({
      source: source === 'TRIGGER' ? ERROR_LOG_SOURCE.TRIGGER : ERROR_LOG_SOURCE.SERVER,
      functionName: 'autoImportContentForWeek_',
      errorCode: (err && err.code) || 'ERROR',
      message: '自動由內容表匯入 ' + iso + ' 失敗：' + ((err && err.message) ? err.message : String(err)),
      detail: buildErrorDetail_(err, { argsSummary: 'isoDate=' + iso + ' source=' + source })
    });
    return { ran: true, changed: 0, reason: 'ERROR', message: (err && err.message) ? err.message : String(err) };
  }
}
