/**
 * ProgramTable.gs
 *
 * 崇拜程序表：挑選程序範本，再逐行求值 `CONDITION`（這一行出不出現）與
 * `CONTENT_SOURCE`（內容欄填什麼），組成最後要印的程序表。
 *
 * 分兩層：
 *   - `buildProgramTable_(week, snapshot)`　真正入口，讀工作表與 Config。
 *   - `buildProgramTableRows_(input)`　　　純函式，全部資料由呼叫方傳進來。
 *
 * ⚠️ `ProgramTemplates` 是**我們自己的**工作表，所以這裡的求值一律**嚴格**：
 * 認不出的 `CONDITION`、指向不存在欄位的 `FIELD:` 全部直接拋錯。這跟
 * `RosterRead.gs` 對職事表的寬鬆解析剛好相反，兩者的理由見
 * docs/職事表唯讀介面.md「為什麼對職事表用寬鬆解析」。
 */

'use strict';

/**
 * 推斷程序範本時，兩個「特別範本」的 ID。
 *
 * ⚠️ 這兩個值不是規則，是 `Bootstrap.gs` seed 出來的那三個範本的 ID
 * （`SEED_PROGRAM_TEMPLATES_` 用的也是同樣的字面值），所以放在程式碼。
 * 真正屬於規則、會被人改的是「什麼關鍵詞算浸禮／堂慶」與「推斷不到時
 * 用哪一個範本」——那三項一律在 Config
 * （`TEMPLATE_KEYWORDS_BAPTISM`／`TEMPLATE_KEYWORDS_ANNIVERSARY`／
 * `TEMPLATE_DEFAULT`）。
 */
var PROGRAM_TEMPLATE_ID_BAPTISM_ = 'TPL_COMBINED_BAPTISM';
var PROGRAM_TEMPLATE_ID_ANNIVERSARY_ = 'TPL_ANNIVERSARY';

/** 「宣召」那一行的內容來源。認到這個值就改用 CALL_TEXT＋CALL_REF 合成。 */
var PROGRAM_CALL_TO_WORSHIP_SOURCE_ = 'FIELD:CALL_TEXT';

/**
 * 用途：程序表的真正入口。讀 `ProgramTemplates` 工作表與相關 Config，
 *   推斷（或沿用）範本 ID，再交給純函式層逐行求值。
 * Args:
 *   week {Object} `BulletinWeeks` 該主日的資料列；沒有該行時傳 `{}`。
 *   snapshot {Object} readRosterSnapshot_() 的回傳值（要用 `special` 推斷範本、
 *     用 `weekOfMonth` 求值 `WEEK_IN:`）。
 * Returns:
 *   {{templateId:string, inferred:boolean, rows:Object[]}}
 *     `inferred` 為 true 代表 `BulletinWeeks.PROGRAM_TEMPLATE_ID` 原本留空、
 *     這次是推斷出來的（呼叫方可以據此決定要不要寫回工作表）。
 * Raises:
 *   Error 如果範本內有認不出的 `CONDITION`／`CONTENT_SOURCE`，或
 *     `FIELD:` 指向不存在的 `BulletinWeeks` 欄位。
 */
function buildProgramTable_(week, snapshot) {
  var templateConfig = {
    baptismKeywords: getConfigTextList_(CONFIG_KEYS.TEMPLATE_KEYWORDS_BAPTISM, '浸禮'),
    anniversaryKeywords: getConfigTextList_(CONFIG_KEYS.TEMPLATE_KEYWORDS_ANNIVERSARY, '堂慶,週年'),
    templateDefault: getConfig(CONFIG_KEYS.TEMPLATE_DEFAULT, 'TPL_NORMAL')
  };
  var resolved = resolveProgramTemplateId_(week, snapshot, templateConfig);

  var recitationGroups = parseRecitationMonthGroups_(
    getConfig(CONFIG_KEYS.RECITATION_MONTH_GROUPS, '1-4:RECITATION_JAN_APR,5-8:RECITATION_MAY_AUG,9-12:RECITATION_SEP_DEC')
  );
  // 分組指向哪些 Config 鍵完全由設定決定，所以逐一讀出來傳進純函式層，
  // 而不是在純函式層寫死 RECITATION_JAN_APR 這類鍵名。
  var recitationValues = {};
  recitationGroups.forEach(function (g) {
    recitationValues[g.configKey] = getConfig(g.configKey, '');
  });

  var rows = buildProgramTableRows_({
    week: week || {},
    snapshot: snapshot,
    templateRows: readSheet(SHEETS.PROGRAM_TEMPLATES),
    templateId: resolved.templateId,
    recitationGroups: recitationGroups,
    recitationValues: recitationValues,
    callFormat: getConfig(CONFIG_KEYS.CALL_TO_WORSHIP_FORMAT, '{{text}}（{{ref}}）')
  });

  return {
    templateId: resolved.templateId,
    inferred: resolved.inferred,
    rows: rows,
    // 第七輪新增：誦讀內容另外單獨算一次給資料模型用。
    // 程序表本身是靠 `AUTO:RECITATION` 這個 CONTENT_SOURCE 在逐行求值時
    // 算出來的，但 Word 範本有一個獨立的 `{{RECITATION}}` 佔位符（誦讀那
    // 一格不一定在程序表內），所以要在這裡再算一次交出去。兩條路徑呼叫
    // 的是**同一個** resolveRecitationContent_()，不會出現兩套規則。
    recitation: resolveRecitationContent_(
      week || {},
      snapshot ? snapshot.isoDate : '',
      recitationGroups,
      recitationValues,
      '誦讀（資料模型）'
    )
  };
}

/**
 * 用途：決定這一週用哪一個程序範本。
 *
 *   `BulletinWeeks.PROGRAM_TEMPLATE_ID` 有值就直接用（人手指定優先）；
 *   留空時按特別主日的標題／類型推斷：含浸禮關鍵詞 → 浸禮合堂範本，
 *   含堂慶關鍵詞 → 堂慶合堂範本，其餘（含沒有特別主日）→ Config 的
 *   `TEMPLATE_DEFAULT`。
 * Args:
 *   week {Object} `BulletinWeeks` 該主日的資料列。
 *   snapshot {Object} 職事表快照（只用 `special.title` 與 `special.type`）。
 *   templateConfig {{baptismKeywords:string[], anniversaryKeywords:string[],
 *                   templateDefault:string}} 由 Config 讀出來的判斷依據。
 * Returns:
 *   {{templateId:string, inferred:boolean}}
 */
function resolveProgramTemplateId_(week, snapshot, templateConfig) {
  var explicit = String((week && week.PROGRAM_TEMPLATE_ID) || '').trim();
  if (explicit) return { templateId: explicit, inferred: false };

  var special = snapshot && snapshot.special;
  var haystack = special ? (String(special.title || '') + ' ' + String(special.type || '')) : '';

  if (containsAnyKeyword_(haystack, templateConfig.baptismKeywords)) {
    return { templateId: PROGRAM_TEMPLATE_ID_BAPTISM_, inferred: true };
  }
  if (containsAnyKeyword_(haystack, templateConfig.anniversaryKeywords)) {
    return { templateId: PROGRAM_TEMPLATE_ID_ANNIVERSARY_, inferred: true };
  }
  return { templateId: templateConfig.templateDefault, inferred: true };
}

/**
 * 用途：判斷一段文字有沒有包含清單內任何一個關鍵詞。
 * Args:
 *   haystack {string} 要檢查的文字。
 *   keywords {string[]} 關鍵詞清單（來自 Config）。
 * Returns:
 *   {boolean} 清單為空時一律回 false。
 */
function containsAnyKeyword_(haystack, keywords) {
  var text = String(haystack || '');
  if (!text) return false;
  return (keywords || []).some(function (kw) {
    return kw && text.indexOf(kw) !== -1;
  });
}

/**
 * 用途：把 Config `RECITATION_MONTH_GROUPS` 解析成月份分組。格式是
 *   「起月-迄月:Config鍵」用逗號分隔，例如
 *   `1-4:RECITATION_JAN_APR,5-8:RECITATION_MAY_AUG,9-12:RECITATION_SEP_DEC`。
 *
 *   ⚠️ 存在的理由：1–4／5–8／9–12 這個分組是**教會自己的安排**，隨時會改
 *   （例如改成每季一換）。寫死在程式碼裡就代表每次改都要改程式，所以
 *   一律經 Config。
 * Args:
 *   raw {string} Config 的原始值。
 * Returns:
 *   {{from:number, to:number, configKey:string}[]} 依原本次序。
 * Raises:
 *   Error 如果任何一項格式不對、月份不是 1–12 的整數、或起月大於迄月——
 *     這是我們自己的 Config，要嚴格；靜靜略過會變成某幾個月查不到誦讀
 *     內容而沒有人知道原因。
 */
function parseRecitationMonthGroups_(raw) {
  var parts = String(raw === null || raw === undefined ? '' : raw)
    .split(/[,，]/)
    .map(function (s) { return s.trim(); })
    .filter(function (s) { return s.length > 0; });

  return parts.map(function (part) {
    var m = /^(\d{1,2})\s*-\s*(\d{1,2})\s*:\s*(.+)$/.exec(part);
    if (!m) {
      throw new Error(
        'parseRecitationMonthGroups_：無法解析「' + part + '」。'
        + '正確格式是「起月-迄月:Config鍵」，例如 1-4:RECITATION_JAN_APR。完整值：' + JSON.stringify(raw)
      );
    }
    var from = Number(m[1]);
    var to = Number(m[2]);
    var configKey = m[3].trim();
    if (from < 1 || from > 12 || to < 1 || to > 12 || from > to) {
      throw new Error(
        'parseRecitationMonthGroups_：「' + part + '」的月份範圍不合理（起月與迄月都要在 1–12 之內，'
        + '而且起月不可以大於迄月）。完整值：' + JSON.stringify(raw)
      );
    }
    if (!configKey) {
      throw new Error('parseRecitationMonthGroups_：「' + part + '」沒有指定 Config 鍵。');
    }
    return { from: from, to: to, configKey: configKey };
  });
}

/**
 * 用途：程序表的純函式層。挑出指定範本的啟用資料列，按 `SEQ_NO` 排序，
 *   逐行求值 `CONDITION` 與 `CONTENT_SOURCE`，輸出最後要印的程序表。
 * Args:
 *   input {{week:Object, snapshot:Object, templateRows:Object[],
 *          templateId:string, recitationGroups:Object[],
 *          recitationValues:Object<string,string>, callFormat:string}}
 * Returns:
 *   {{seqNo:number, itemName:string, content:string, posture:string,
 *     fullWidth:boolean, sourceRow:Object}[]}
 *     `fullWidth` 為 true 的行，`posture` 一律清空——樣本內「祈禱會」
 *     「拍照」這類整行項目都沒有立坐標記。
 * Raises:
 *   Error 如果認不出 `CONDITION`／`CONTENT_SOURCE`，或 `FIELD:`／`IF_FIELD:`
 *     指向不存在的 `BulletinWeeks` 欄位。
 */
function buildProgramTableRows_(input) {
  var week = input.week || {};
  var weekOfMonth = input.snapshot ? input.snapshot.weekOfMonth : null;
  var isoDate = input.snapshot ? input.snapshot.isoDate : '';

  var rows = (input.templateRows || [])
    .filter(function (r) { return r.TEMPLATE_ID === input.templateId && r.ACTIVE === true; })
    .slice()
    .sort(function (a, b) { return (a.SEQ_NO || 0) - (b.SEQ_NO || 0); });

  var result = [];
  rows.forEach(function (row) {
    if (!evaluateProgramCondition_(row.CONDITION, { week: week, weekOfMonth: weekOfMonth, row: row })) return;

    var content = evaluateProgramContent_(row.CONTENT_SOURCE, {
      week: week,
      row: row,
      isoDate: isoDate,
      recitationGroups: input.recitationGroups || [],
      recitationValues: input.recitationValues || {},
      callFormat: input.callFormat || '{{text}}（{{ref}}）'
    });

    var fullWidth = row.FULL_WIDTH === true;
    result.push({
      seqNo: row.SEQ_NO,
      itemName: String(row.ITEM_NAME || ''),
      content: content,
      posture: fullWidth ? '' : String(row.POSTURE || ''),
      fullWidth: fullWidth,
      sourceRow: row
    });
  });

  return result;
}

/**
 * 用途：求值一行的 `CONDITION`，決定這一行出不出現。
 *
 *   | 語法 | 意思 |
 *   |---|---|
 *   | `ALWAYS` | 一定出現 |
 *   | `NEVER` | 一定不出現 |
 *   | `WEEK_IN:2,4` | 只在 `weekOfMonth` 屬於清單時出現 |
 *   | `WEEK_NOT_IN:1` | 只在 `weekOfMonth` **不**屬於清單時出現 |
 *   | `IF_FIELD:CHOIR_TITLE` | 只在 `BulletinWeeks` 該欄有值（非空白）時出現 |
 *
 *   ⚠️ 第八輪起，`FellowshipDefaults.RECURRENCE`（團契常設時間表的出現
 *   規則）**共用這一個求值器**，不是另外寫一套——「第 2、4 個主日」這種
 *   規則在兩處的意思必須完全一樣，各寫一套遲早會分岔。所以 `ctx.row`
 *   可能是程序範本的一行，也可能是團契常設時間表的一行，
 *   `programRowLocation_()` 兩種都要講得出位置。
 * Args:
 *   condition {string} `ProgramTemplates.CONDITION` 的值。
 *   ctx {{week:Object, weekOfMonth:?number, row:Object}}
 * Returns:
 *   {boolean}
 * Raises:
 *   Error 如果認不出這個 `CONDITION`，或 `IF_FIELD:` 指向不存在的欄位。
 *     訊息會指明是哪個 `TEMPLATE_ID` 第幾行、值是什麼。
 */
function evaluateProgramCondition_(condition, ctx) {
  var raw = String(condition === null || condition === undefined ? '' : condition).trim();
  var where = programRowLocation_(ctx.row);

  if (raw === CONDITION_TYPE.ALWAYS) return true;
  if (raw === CONDITION_TYPE.NEVER) return false;

  // ⚠️ 一定要先比 WEEK_NOT_IN:，再比 WEEK_IN:——`'WEEK_NOT_IN:1'` 的開頭
  // 不是 `'WEEK_IN:'`，所以其實不會互相配錯，但把長的排前面是防止日後
  // 有人改動時不小心引入前綴包含的問題。
  if (raw.indexOf(CONDITION_TYPE.WEEK_NOT_IN_PREFIX) === 0) {
    var notInRaw = raw.slice(CONDITION_TYPE.WEEK_NOT_IN_PREFIX.length);
    var excludedWeeks = parseConfigIntList_(notInRaw, where + ' 的 CONDITION');
    return excludedWeeks.indexOf(ctx.weekOfMonth) === -1;
  }

  if (raw.indexOf(CONDITION_TYPE.WEEK_IN_PREFIX) === 0) {
    var listRaw = raw.slice(CONDITION_TYPE.WEEK_IN_PREFIX.length);
    var weeks = parseConfigIntList_(listRaw, where + ' 的 CONDITION');
    return weeks.indexOf(ctx.weekOfMonth) !== -1;
  }

  if (raw.indexOf(CONDITION_TYPE.IF_FIELD_PREFIX) === 0) {
    var fieldKey = raw.slice(CONDITION_TYPE.IF_FIELD_PREFIX.length).trim();
    assertBulletinWeeksField_(fieldKey, where, 'IF_FIELD');
    return String(ctx.week[fieldKey] === null || ctx.week[fieldKey] === undefined ? '' : ctx.week[fieldKey]).trim() !== '';
  }

  throw new Error(
    '程序範本 ' + where + ' 的 CONDITION「' + raw + '」無法辨識。'
    + '可用語法：ALWAYS、NEVER、WEEK_IN:<逗號分隔週次>、WEEK_NOT_IN:<逗號分隔週次>、IF_FIELD:<BulletinWeeks 機器鍵>。'
  );
}

/**
 * 用途：求值一行的 `CONTENT_SOURCE`，算出內容欄要填什麼。
 *
 *   | 語法 | 意思 |
 *   |---|---|
 *   | `BLANK` | 內容欄留空 |
 *   | `STATIC` | 用 `CONTENT_VALUE` 原文 |
 *   | `FIELD:SERMON_TITLE` | 取 `BulletinWeeks` 該欄的值 |
 *   | `AUTO:RECITATION` | 依覆寫欄或月份分組決定（見 resolveRecitationContent_()） |
 *
 *   `FIELD:CALL_TEXT`（宣召）有特別處理：內容是 `CALL_TEXT` 與 `CALL_REF`
 *   依 Config `CALL_TO_WORSHIP_FORMAT` 合成的，見 formatCallToWorship_()。
 * Args:
 *   contentSource {string} `ProgramTemplates.CONTENT_SOURCE` 的值。
 *   ctx {{week:Object, row:Object, isoDate:string, recitationGroups:Object[],
 *        recitationValues:Object, callFormat:string}}
 * Returns:
 *   {string}
 * Raises:
 *   Error 如果認不出這個 `CONTENT_SOURCE`，或 `FIELD:` 指向不存在的欄位。
 */
function evaluateProgramContent_(contentSource, ctx) {
  var raw = String(contentSource === null || contentSource === undefined ? '' : contentSource).trim();
  var where = programRowLocation_(ctx.row);

  if (raw === CONTENT_SOURCE_PREFIX.BLANK) return '';
  if (raw === CONTENT_SOURCE_PREFIX.STATIC) return String(ctx.row.CONTENT_VALUE || '');
  if (raw === CONTENT_SOURCE_PREFIX.AUTO_RECITATION) {
    return resolveRecitationContent_(ctx.week, ctx.isoDate, ctx.recitationGroups, ctx.recitationValues, where);
  }

  if (raw === PROGRAM_CALL_TO_WORSHIP_SOURCE_) {
    return formatCallToWorship_(ctx.week.CALL_TEXT, ctx.week.CALL_REF, ctx.callFormat);
  }

  if (raw.indexOf(CONTENT_SOURCE_PREFIX.FIELD) === 0) {
    var fieldKey = raw.slice(CONTENT_SOURCE_PREFIX.FIELD.length).trim();
    assertBulletinWeeksField_(fieldKey, where, 'FIELD');
    var value = ctx.week[fieldKey];
    return String(value === null || value === undefined ? '' : value);
  }

  throw new Error(
    '程序範本 ' + where + ' 的 CONTENT_SOURCE「' + raw + '」無法辨識。'
    + '可用語法：BLANK、STATIC、FIELD:<BulletinWeeks 機器鍵>、AUTO:RECITATION。'
  );
}

/**
 * 用途：算出「誦讀」那一行的內容。
 *
 *   1. `BulletinWeeks.RECITATION_OVERRIDE` 有值 → 直接用它（人手覆寫優先）。
 *   2. 否則按主日日期的**月份**查月份分組，取該組指定的 Config 鍵的值。
 * Args:
 *   week {Object} `BulletinWeeks` 資料列。
 *   isoDate {string} 主日日期 yyyy-MM-dd。
 *   groups {{from:number,to:number,configKey:string}[]} 月份分組。
 *   values {Object<string,string>} Config 鍵 → 值。
 *   where {string} 出錯訊息用的位置描述。
 * Returns:
 *   {string} 查不到對應分組時回空字串（內容留空，不拋錯——誦讀內容漏填
 *     不應該讓整份週報生不出來）。
 */
function resolveRecitationContent_(week, isoDate, groups, values, where) {
  var override = String((week && week.RECITATION_OVERRIDE) || '').trim();
  if (override) return override;

  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(isoDate || ''));
  if (!m) return '';
  var month = Number(m[2]);

  var group = (groups || []).filter(function (g) { return month >= g.from && month <= g.to; })[0];
  if (!group) return '';

  var value = values ? values[group.configKey] : '';
  return String(value === null || value === undefined ? '' : value);
}

/**
 * 用途：把宣召經文與出處合成一行內容。
 *
 *   三種情況（2026-04-05 浸禮合堂就是第二種，只有出處沒有全文）：
 *     - 兩者皆有 → 依格式合成，例如「…（詩篇 100:1-2）」
 *     - 只有出處 → 只顯示「（出處）」——把格式內的 `{{text}}` 換成空字串
 *       自然就是這個結果
 *     - 只有經文 → 只顯示經文（不要留下一對空括號）
 *     - 兩者皆空 → 回空字串（呼叫方會把它列入待填清單）
 * Args:
 *   text {*} `BulletinWeeks.CALL_TEXT`。
 *   ref {*} `BulletinWeeks.CALL_REF`。
 *   format {string} Config `CALL_TO_WORSHIP_FORMAT`，佔位符 `{{text}}`／`{{ref}}`。
 * Returns:
 *   {string}
 */
function formatCallToWorship_(text, ref, format) {
  var t = String(text === null || text === undefined ? '' : text).trim();
  var r = String(ref === null || ref === undefined ? '' : ref).trim();

  if (!t && !r) return '';
  if (t && !r) return t;

  return String(format || '{{text}}（{{ref}}）')
    .split('{{text}}').join(t)
    .split('{{ref}}').join(r);
}

/**
 * 用途：確認一個機器鍵真的存在於 `BulletinWeeks` 的欄位定義內。
 *
 *   ⚠️ 這是我們自己的工作表，所以**嚴格**：打錯欄名一定是我們自己的
 *   bug，靜靜回空字串會變成「程序表某一行永遠是空的、但沒有人知道為什麼」。
 * Args:
 *   fieldKey {string} 要檢查的機器鍵。
 *   where {string} 出錯訊息用的位置描述。
 *   syntaxName {string} `FIELD` 或 `IF_FIELD`，只用於訊息。
 * Returns:
 *   {void}
 * Raises:
 *   Error 如果該機器鍵不在 `COLUMNS.BULLETIN_WEEKS.keys` 內，訊息會列出
 *     全部可用欄名。
 */
function assertBulletinWeeksField_(fieldKey, where, syntaxName) {
  var keys = COLUMNS.BULLETIN_WEEKS.keys;
  if (keys.indexOf(fieldKey) !== -1) return;
  throw new Error(
    '程序範本 ' + where + ' 的 ' + syntaxName + ':「' + fieldKey + '」指向 BulletinWeeks 不存在的欄位。'
    + '可用欄名：' + keys.join('、')
  );
}

/**
 * 用途：組出「哪個範本第幾行」的位置描述，供錯誤訊息使用。
 * Args:
 *   row {Object} `ProgramTemplates` 的一行。
 * Returns:
 *   {string}
 */
function programRowLocation_(row) {
  if (!row) return '（未知位置）';
  return '「' + String(row.TEMPLATE_ID || '（未知範本）') + '」第 ' + String(row.SEQ_NO) + ' 項（'
    + String(row.ITEM_NAME || '') + '）';
}
