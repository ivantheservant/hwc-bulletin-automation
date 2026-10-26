/**
 * WeekArrangement.gs
 *
 * v3（2026-10-26 Ivan 測試結果 A，第 11、13 項）：每一週在填寫介面的兩種「版面安排」——
 *
 *   1. 程序增刪（`BulletinWeeks.PROGRAM_EDITS`）：這一週拿走範本某幾項（例如「拍照」）、加幾項
 *      （例如「特別分享」）。
 *   2. 丁戊己三張清單的次序與刪除（`BulletinWeeks.LIST_ARRANGEMENT`）：拖動改次序、按「×」在這一週拿走。
 *      清單的**內容**仍然只在內容表改；這裏只記次序與拿走了哪幾則。
 *
 * 兩者都是 JSON，存在 `BulletinWeeks` 那一週的一格，與其他週欄位一樣經「儲存」寫入（三方比較、
 * 逐格 AuditLog、版本記錄、還原、重設全部照用）。
 *
 * ⚠️ 套用只有一處：程序經 `applyProgramEdits_()`、清單經 `arrangeListItems_()`。資料模型（Word、預覽、
 * 電郵）與填寫介面都由這兩支來，不可以前端自己排一次（bug class 3）。
 *
 * ⚠️ 內容表改了內容（例如家事報告改了一個字），那一則的鍵會變，之前的次序與「拿走」對它不再生效——
 * 它會排回最後，而且照樣印出。寧可多印一則，也不可以把一則改過的內容靜靜拿走。
 */

'use strict';

/** 兩欄 JSON 的長度上限（字元）。一格最多 5 萬字，留足餘地；超過代表資料出錯。 */
var WEEK_ARRANGEMENT_MAX_CHARS_ = 20000;

/** 程序表「加一項」的立坐選項（與 POSTURE 列舉相同）。 */
function programAddPostureOptions_() {
  return [POSTURE.SIT, POSTURE.STAND, POSTURE.NONE];
}

// =====================================================================
// 程序增刪
// =====================================================================

/**
 * 用途：解析 `PROGRAM_EDITS`。純函式。格式不對一律當作「沒有增刪」，並標 `invalid`（由呼叫方決定要不要講）。
 * Args:
 *   raw {*} 工作表那一格（空白＝沒有增刪）。
 * Returns:
 *   {{hidden:string[], added:{id:string, after:string, itemName:string, content:string, posture:string}[],
 *     invalid:boolean}}
 * Raises:
 *   （無）
 */
function parseProgramEdits_(raw) {
  var empty = { hidden: [], added: [], invalid: false };
  var text = String(raw === null || raw === undefined ? '' : raw).trim();
  if (!text) return empty;
  var obj;
  try {
    obj = JSON.parse(text);
  } catch (err) {
    return { hidden: [], added: [], invalid: true };
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { hidden: [], added: [], invalid: true };
  var postures = programAddPostureOptions_();
  var hidden = (Array.isArray(obj.hidden) ? obj.hidden : []).map(function (k) { return String(k || ''); })
    .filter(function (k) { return k !== ''; });
  var added = (Array.isArray(obj.added) ? obj.added : []).filter(function (a) {
    return a && typeof a === 'object' && String(a.itemName || '').trim() !== '' && String(a.id || '').trim() !== '';
  }).map(function (a) {
    var posture = String(a.posture === undefined ? POSTURE.SIT : a.posture);
    return {
      id: String(a.id).trim(),
      after: String(a.after || ''),
      itemName: String(a.itemName).trim(),
      content: String(a.content || '').trim(),
      posture: postures.indexOf(posture) !== -1 ? posture : POSTURE.SIT
    };
  });
  return { hidden: hidden, added: added, invalid: false };
}

/**
 * 用途：程序表每一行（來自範本）的鍵：範本的項目名稱（不是詩班項目名稱覆寫之後那個）＋第幾次出現。
 *   用名稱而不是 `SEQ_NO`：同一週把範本由平常改成合堂，「拍照」「家事報告」這些仍然認得出。純函式。
 * Args:
 *   rows {Object[]} `buildProgramTableRows_()` 的輸出（帶 `sourceRow`）。
 * Returns:
 *   {string[]} 與 `rows` 一一對應，例如 `'拍照#1'`。
 * Raises:
 *   （無）
 */
function programRowKeys_(rows) {
  var seen = {};
  return (rows || []).map(function (r) {
    var name = String(((r && r.sourceRow) || {}).ITEM_NAME || (r && r.itemName) || '').trim();
    seen[name] = (seen[name] || 0) + 1;
    return name + '#' + seen[name];
  });
}

/**
 * 用途：把這一週的程序增刪套到程序表上。純函式。
 * Args:
 *   rows {Object[]} `buildProgramTableRows_()` 的輸出（範本求值之後）。
 *   rawEdits {*} `BulletinWeeks.PROGRAM_EDITS`。
 * Returns:
 *   {{rows:Object[], display:Object[], warnings:Object[]}}
 *     `rows`：要印的程序（拿走的不在內，加的已插入）——資料模型、Word、預覽、電郵用這一份；
 *     `display`：填寫介面用，拿走的仍然在（`removed:true`），每一行帶 `key`（範本行）或 `addedId`（加的行）。
 *     找不到插入位置的「加一項」放在最後，並在 `warnings` 講一句。
 * Raises:
 *   （無）
 */
function applyProgramEdits_(rows, rawEdits) {
  var edits = parseProgramEdits_(rawEdits);
  var keys = programRowKeys_(rows);
  var warnings = [];
  if (edits.invalid) {
    warnings.push({ code: 'PROGRAM_EDITS_INVALID', message: '這一週的程序增刪記錄讀不到（格式不對），程序表照範本印。請在填寫介面重新做一次增刪再儲存。' });
  }
  var hiddenSet = {};
  edits.hidden.forEach(function (k) { hiddenSet[k] = true; });

  var display = [];
  (rows || []).forEach(function (r, i) {
    display.push(Object.assign({}, r, { key: keys[i], removed: hiddenSet[keys[i]] === true, added: false, addedId: '' }));
  });

  // 加的行：插在指定那一行之後（可以是範本行 `名稱#n`，或者另一個加的行 `add:<id>`）；`'__END__'`＝最後。
  // 同一個位置加了幾項，按加的次序排。插入一項之後，下一項如果指向同一個位置，要排在它之後。
  // ⚠️ 「加在最後」的行即時放到最後（不是全部處理完才放）：之後另一項可以「加在它之後」（獨立審查）。
  edits.added.forEach(function (a) {
    var addedRow = {
      seqNo: null, itemName: a.itemName, content: a.content,
      posture: a.posture, fullWidth: false, sourceRow: null,
      key: '', removed: false, added: true, addedId: a.id, after: a.after
    };
    if (a.after === '__END__') { display.push(addedRow); return; }
    var anchorIndex = -1;
    for (var i = 0; i < display.length; i++) {
      var d = display[i];
      if ((d.added && ('add:' + d.addedId) === a.after) || (!d.added && d.key === a.after)) { anchorIndex = i; break; }
    }
    if (anchorIndex === -1) {
      warnings.push({
        code: 'PROGRAM_ADD_ANCHOR_MISSING',
        message: '程序表加的「' + a.itemName + '」原本排在一項現在已經不在範本內的項目之後，現在放在最後，請在填寫介面核對。'
      });
      display.push(addedRow);
      return;
    }
    // 跳過已經插在同一個位置之後的行（它們亦是指向同一個 anchor，或者指向那些行）。
    var insertAt = anchorIndex + 1;
    while (insertAt < display.length && display[insertAt].added
      && (display[insertAt].after === a.after || chainPointsInto_(display, insertAt, anchorIndex))) {
      insertAt++;
    }
    display.splice(insertAt, 0, addedRow);
  });

  var finalRows = display.filter(function (d) { return d.removed !== true; }).map(function (d) {
    return {
      seqNo: d.seqNo, itemName: d.itemName, content: d.content, posture: d.posture,
      fullWidth: d.fullWidth === true, sourceRow: d.sourceRow || null, added: d.added === true
    };
  });
  return { rows: finalRows, display: display, warnings: warnings };
}

/**
 * 用途：`applyProgramEdits_()` 的小工具：第 `index` 行（一個加的行）是不是經一條「加在加的行之後」的
 *   鏈指回第 `anchorIndex` 行。純函式。
 * Args:
 *   display {Object[]} 目前的顯示行。
 *   index {number} 要看的那一行。
 *   anchorIndex {number} 錨點那一行。
 * Returns:
 *   {boolean}
 * Raises:
 *   （無）
 */
function chainPointsInto_(display, index, anchorIndex) {
  var guard = 0;
  var cur = display[index];
  while (cur && cur.added && guard < 50) {
    guard++;
    var target = -1;
    for (var i = 0; i < display.length; i++) {
      var d = display[i];
      if ((d.added && ('add:' + d.addedId) === cur.after) || (!d.added && d.key === cur.after)) { target = i; break; }
    }
    if (target === anchorIndex) return true;
    if (target === -1) return false;
    cur = display[target];
  }
  return false;
}

/**
 * 用途：給人看的程序增刪摘要（版本記錄「看差異」用）。純函式。
 * Args:
 *   rawEdits {*} `PROGRAM_EDITS`。
 * Returns:
 *   {string} 沒有增刪回空字串。
 * Raises:
 *   （無）
 */
function describeProgramEdits_(rawEdits) {
  var edits = parseProgramEdits_(rawEdits);
  if (edits.invalid) return '（格式不對）';
  var parts = [];
  if (edits.hidden.length > 0) {
    parts.push('拿走：' + edits.hidden.map(function (k) { return k.replace(/#1$/, ''); }).join('、'));
  }
  if (edits.added.length > 0) {
    parts.push('加入：' + edits.added.map(function (a) { return a.itemName + (a.content ? '（' + a.content + '）' : ''); }).join('、'));
  }
  return parts.join('；');
}

// =====================================================================
// 丁戊己三張清單的次序與刪除
// =====================================================================

/** 有次序與刪除的三張清單（`webAppListDefs_()` 的鍵）。財政報告不在內。 */
function arrangeableListTypes_() {
  return ['announcements', 'prayers', 'fellowships'];
}

/**
 * 用途：一則清單項目的內容鍵：內容的 FNV-1a 雜湊（8 位十六進位）。內容一改，鍵就變。純函式。
 * Args:
 *   type {string} `announcements`／`prayers`／`fellowships`。
 *   item {Object} 清單項目（`TEXT`，或者團契的四欄；機器鍵用週報那一邊的）。
 * Returns:
 *   {string} 例如 `'k3f2a9c01'`。
 * Raises:
 *   （無）
 */
function listItemContentKey_(type, item) {
  var it = item || {};
  var text = type === 'fellowships'
    ? [it.FELLOWSHIP_NAME, it.MEETING_DATE, it.MEETING_TIME, it.CONTENT].map(function (v) {
      return String(v === null || v === undefined ? '' : v).trim();
    }).join('\u0001')
    : String(it.TEXT === null || it.TEXT === undefined ? '' : it.TEXT).trim();
  var h = 0x811c9dc5;
  for (var i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return 'k' + ('0000000' + (h >>> 0).toString(16)).slice(-8);
}

/**
 * 用途：解析 `LIST_ARRANGEMENT`。純函式。格式不對當作沒有安排，並標 `invalid`。
 * Args:
 *   raw {*}
 * Returns:
 *   {{lists:Object<string,{k:string, h:boolean}[]>, invalid:boolean}} 只有三張清單的鍵；沒有安排的清單不在內。
 * Raises:
 *   （無）
 */
function parseListArrangement_(raw) {
  var text = String(raw === null || raw === undefined ? '' : raw).trim();
  if (!text) return { lists: {}, invalid: false };
  var obj;
  try {
    obj = JSON.parse(text);
  } catch (err) {
    return { lists: {}, invalid: true };
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { lists: {}, invalid: true };
  var lists = {};
  arrangeableListTypes_().forEach(function (type) {
    if (!Array.isArray(obj[type])) return;
    lists[type] = obj[type].filter(function (e) { return e && typeof e === 'object' && String(e.k || '') !== ''; })
      .map(function (e) { return { k: String(e.k), h: e.h === true || e.h === 1 }; });
  });
  return { lists: lists, invalid: false };
}

/**
 * 用途：按這一週的安排排列一張清單。純函式。
 *   安排內有的鍵按安排的次序排（同一個鍵有幾則就逐則對應，第二則的鍵加「#2」）；安排內沒有的
 *   （新加的、內容改過的）按原本次序排在最後，一律不拿走。
 * Args:
 *   type {string} 清單種類。
 *   items {Object[]} 按 `SEQ_NO` 排好的清單項目。
 *   entries {?{k:string, h:boolean}[]} 這張清單的安排；沒有就照原本次序。
 * Returns:
 *   {{item:Object, key:string, hidden:boolean, sourceIndex:number}[]} 顯示次序。
 * Raises:
 *   （無）
 */
function arrangeListItems_(type, items, entries) {
  var seen = {};
  var keyed = (items || []).map(function (item, i) {
    var base = listItemContentKey_(type, item);
    seen[base] = (seen[base] || 0) + 1;
    return { item: item, key: seen[base] > 1 ? base + '#' + seen[base] : base, sourceIndex: i, used: false };
  });
  var byKey = {};
  keyed.forEach(function (k) { byKey[k.key] = k; });
  var out = [];
  (entries || []).forEach(function (e) {
    var hit = byKey[e.k];
    if (!hit || hit.used) return;
    hit.used = true;
    out.push({ item: hit.item, key: hit.key, hidden: e.h === true, sourceIndex: hit.sourceIndex });
  });
  keyed.forEach(function (k) {
    if (k.used) return;
    out.push({ item: k.item, key: k.key, hidden: false, sourceIndex: k.sourceIndex });
  });
  return out;
}

/**
 * 用途：給人看的清單安排摘要（版本記錄「看差異」用）。純函式。
 * Args:
 *   raw {*} `LIST_ARRANGEMENT`。
 * Returns:
 *   {string} 沒有安排回空字串。
 * Raises:
 *   （無）
 */
function describeListArrangement_(raw) {
  var parsed = parseListArrangement_(raw);
  if (parsed.invalid) return '（格式不對）';
  var names = { announcements: '家事報告', prayers: '代禱事項', fellowships: '團契聚會' };
  return arrangeableListTypes_().filter(function (t) { return parsed.lists[t]; }).map(function (t) {
    var hidden = parsed.lists[t].filter(function (e) { return e.h; }).length;
    return names[t] + '：自訂次序' + (hidden > 0 ? '，拿走 ' + hidden + ' 則' : '');
  }).join('；');
}

/**
 * 用途：儲存之前核對兩欄 JSON（介面送來的）：空白或者合法的 JSON 物件、長度不超過上限。純函式。
 * Args:
 *   week {Object} 儲存 payload 的 `week`。
 * Returns:
 *   {string[]} 不合格的欄位機器鍵；全部合格回空陣列。
 * Raises:
 *   （無）
 */
function findInvalidWeekArrangementFields_(week) {
  var w = week || {};
  return ['PROGRAM_EDITS', 'LIST_ARRANGEMENT'].filter(function (key) {
    if (!Object.prototype.hasOwnProperty.call(w, key)) return false;
    var text = String(w[key] === null || w[key] === undefined ? '' : w[key]).trim();
    if (!text) return false;
    if (text.length > WEEK_ARRANGEMENT_MAX_CHARS_) return true;
    return key === 'PROGRAM_EDITS' ? parseProgramEdits_(text).invalid : parseListArrangement_(text).invalid;
  });
}
