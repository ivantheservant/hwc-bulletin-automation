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
    {
      tabName: '宣召', kind: 'WEEK', targetSheet: SHEETS.BULLETIN_WEEKS,
      fieldMap: { CALL_REF: 'CALL_REF', CALL_TEXT: 'CALL_TEXT' }, repeatUntil: false
    }
  ];
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
 *     供警告訊息指出是哪一行）。
 */
function parseContentTabRows_(values, keys) {
  var out = [];
  (values || []).forEach(function (row, i) {
    var isBlank = row.every(function (cell) { return cell === '' || cell === null || cell === undefined; });
    if (isBlank) return;

    var obj = { __rowNo: i + CONTENT_SHEET_FIRST_DATA_ROW_ };
    keys.forEach(function (key, c) {
      var v = row[c];
      obj[key] = (v === null || v === undefined) ? '' : String(v).trim();
    });

    // 留空當作 TRUE；只有明確寫 FALSE 才算停用。
    var active = String(obj.ACTIVE || '').trim().toUpperCase();
    obj.__active = active !== 'FALSE';
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
 *   {{targets:Object, warnings:string[], skippedTabs:string[]}}
 *     `targets` 形狀：`{ '<分頁名稱>': { '<主日>': [資料列…] } }`；
 *     `skippedTabs` 是「整張空白、本次不改動」的分頁名稱。
 */
function buildContentImportTargets_(contentData, serviceDates) {
  var targets = {};
  var warnings = [];
  var skippedTabs = [];

  contentImportTargets_().forEach(function (def) {
    var rows = (contentData || {})[def.tabName] || [];

    // ---- 安全規則 1：整張空白就完全不動 ----
    if (rows.length === 0) {
      skippedTabs.push(def.tabName);
      return;
    }

    var activeRows = rows.filter(function (r) { return r.__active; });
    var byDate = {};

    if (def.kind === 'WEEK_ATTENDANCE') {
      activeRows.forEach(function (row) {
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
        var iso = String(row.SERVICE_DATE || '').trim();
        if ((serviceDates || []).indexOf(iso) === -1) {
          warnings.push(def.tabName + '第 ' + row.__rowNo + ' 行的主日日期 '
            + (iso || '（空白）') + ' 不是本季的主日，本行略過。');
          return;
        }
        byDate[iso] = [row];
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

  return { targets: targets, warnings: warnings, skippedTabs: skippedTabs };
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
 *          serviceDates:string[]}}
 *     `existingLists` 是「目標表名稱 → 該表全部資料列（帶 `__rowNo`）」；
 *     `existingWeeks` 是 `BulletinWeeks` 全部資料列（帶 `__rowNo`）。
 * Returns:
 *   {{added:number, updated:number, removed:number, unchanged:number,
 *     details:Object[], warnings:string[], skippedTabs:string[],
 *     listPlans:Object, weekUpdates:Object[]}}
 */
function computeContentImportPlan_(input) {
  var plan = {
    added: 0, updated: 0, removed: 0, unchanged: 0,
    details: [], warnings: (input.warnings || []).slice(),
    skippedTabs: (input.skippedTabs || []).slice(),
    listPlans: {}, weekUpdates: []
  };

  var weekByDate = {};
  (input.existingWeeks || []).forEach(function (w) {
    weekByDate[formatIsoDate_(w.SERVICE_DATE)] = w;
  });

  // BulletinWeeks 同一個主日可能同時被「崇拜人數」與「宣召」改到，
  // 所以先累積成「一個主日一批改動」，最後才算「修改了幾多行」。
  var weekChangesByDate = {};

  contentImportTargets_().forEach(function (def) {
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
      var week = weekByDate[iso];
      if (!week) {
        plan.warnings.push(def.tabName + '：BulletinWeeks 沒有 ' + iso
          + ' 這一行，本次略過。可以先用選單「建立本季空白週報」建好骨架。');
        return;
      }
      var sourceRow = byDate[iso][0];
      Object.keys(def.fieldMap).forEach(function (sourceKey) {
        var targetKey = def.fieldMap[sourceKey];
        var newValue = sourceRow[sourceKey];
        if (contentValuesEqual_(week[targetKey], newValue)) return;

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
 *   options {{isoDate:string=}=} 有 `isoDate` 就只匯入那一個主日；
 *     省略代表整季。
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
      message: '季度「' + qid + '」尚未建立內容表。請先按選單「內容表 ▸ 建立本季內容表」。'
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
  var dateResolution = resolveQuarterServiceDatesWithFallback_(qid);
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

  var contentData = readContentSheetTabs_(spreadsheet);
  // ⚠️ 「連續到」一定要用**整季**的主日展開，之後才篩出要匯入的那一個
  // 主日——否則只匯入單一主日時，一條由上一週連登過來的報告會消失。
  var built = buildContentImportTargets_(contentData, allServiceDates);

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
    existingLists: existingLists,
    existingWeeks: readRowsWithRowNo_(SHEETS.BULLETIN_WEEKS),
    serviceDates: serviceDates
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
 * Args:
 *   quarterId {string} 季度 ID。
 *   options {{isoDate:string=}=} 同 `previewContentImport_()`。
 * Returns:
 *   {{ok:boolean, quarterId:string, scope:string, plan:(Object|undefined),
 *     fileUrl:(string|undefined), reason:(string|undefined), message:(string|undefined)}}
 * Raises:
 *   Error 如果拿不到鎖（30 秒內）——寧可失敗也不要與同步觸發器同時寫。
 */
function applyContentImport_(quarterId, options) {
  var preview = previewContentImport_(quarterId, options);
  if (!preview.ok) return preview;

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    var lockErr = new Error('applyContentImport_：30 秒內拿不到指令碼鎖，'
      + '可能有另一個匯入或者填寫表同步正在執行。請稍後再試一次。');
    lockErr.code = 'LOCK_TIMEOUT';
    throw lockErr;
  }

  try {
    writeContentImportPlan_(preview.plan);
    updateContentSheetField_(preview.quarterId, 'LAST_IMPORTED_AT', new Date());
  } finally {
    lock.releaseLock();
  }

  return preview;
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
  var actionText = { ADD: '新增', UPDATE: '修改', REMOVE: '停用' }[detail.action] || detail.action;
  var oldText = truncateForReport_(detail.oldValue);
  var newText = truncateForReport_(detail.newValue);
  return actionText + '　' + detail.sheet + '　' + detail.isoDate + '　' + detail.field
    + '　' + (oldText === '' ? '（空白）' : oldText) + ' → ' + (newText === '' ? '（空白）' : newText);
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
