/**
 * src/FinanceReports.gs
 *
 * 財政報告（2026-10-30 Ivan 示範之後：「財政報告：全部修正」）。純函式層。
 *
 * 實際週報有兩款財政表，可以同一期一齊出現（例如 2026-06-14）：
 *
 *   | 款式 | 表頭 | 數字欄 | 表下 |
 *   |---|---|---|---|
 *   | 綜合收支（`MAIN`） | 「5月份實際數字｜截至本月實際數字｜截至本月預算｜全年預算」 | 欄一至欄四 | 附註（收入明細）、銀行結餘一句 |
 *   | 特殊海外奉獻及慈惠基金（`SPECIAL`） | 「特殊海外奉獻｜慈惠」 | 欄一、欄二 | 附註（銀行結餘是表內一行） |
 *
 * 內容表「財政報告」一行一個表項。**分組**：按次序，填了「報告標題」的一行開始一個新的報告，之後「報告標題」
 * 留空的行屬於同一個報告；第一個有標題的行之前的行自成一個報告。**款式**：報告標題含 Config
 * `FINANCE_SPECIAL_KEYWORDS` 任何一個詞 ⇒ `SPECIAL`；有標題而不含 ⇒ `MAIN`；沒有標題 ⇒ 有任何一行填了欄三或
 * 欄四就是 `MAIN`，否則 `SPECIAL`。沒有標題就用 Config 的標題樣式（`FINANCE_TITLE_PATTERN`／
 * `FINANCE_SPECIAL_TITLE_PATTERN`，月份＝該主日的上一個月）。附註、銀行結餘：同一個報告各行有填的按次序合併。
 *
 * 範本每款只有一個表，所以同一款有兩個報告時只印第一個，並出警告（不可以靜靜丟走，bug class 2）。
 * 特殊海外奉獻及慈惠基金的報告某一行填了欄三或欄四 ⇒ 警告（那兩欄不會印）。
 *
 * 表頭文字一律由 Config（`FINANCE_MAIN_COLUMN_LABELS`／`FINANCE_SPECIAL_COLUMN_LABELS`）決定：Word 範本用
 * `{{FINANCE_MAIN_HEAD1}}`…，草稿預覽頁與電郵用同一份，只有一個真相（bug class 3）。
 */

'use strict';

/** `FINANCE_SPECIAL_TITLE_PATTERN` 的預設值（Config 讀不到時的後備，與 DEFAULTS 一致）。 */
var FINANCE_SPECIAL_TITLE_PATTERN_DEFAULT_ = '特殊海外奉獻及慈惠基金{{YEAR}}年{{MONTH}}月份財政報告';

/** `FINANCE_SPECIAL_KEYWORDS` 的預設值。 */
var FINANCE_SPECIAL_KEYWORDS_DEFAULT_ = '特殊海外,慈惠';

/** `FINANCE_MAIN_COLUMN_LABELS` 的預設值（`{{PERIOD}}` 換成期別標籤，例如「5月份」）。 */
var FINANCE_MAIN_COLUMN_LABELS_DEFAULT_ = '{{PERIOD}}實際數字,截至本月實際數字,截至本月預算,全年預算';

/** `FINANCE_SPECIAL_COLUMN_LABELS` 的預設值。 */
var FINANCE_SPECIAL_COLUMN_LABELS_DEFAULT_ = '特殊海外奉獻,慈惠';

/**
 * 用途：逗號分隔的 Config 文字拆成清單（去頭尾空白、去空項）。純函式。
 * Args:
 *   raw {*}
 * Returns:
 *   {string[]}
 */
function splitFinanceConfigList_(raw) {
  return String(raw === null || raw === undefined ? '' : raw).split(',')
    .map(function (s) { return s.trim(); })
    .filter(function (s) { return s !== ''; });
}

/**
 * 用途：一個值算不算「有填」（去空白之後不是空字串）。純函式。
 * Args:
 *   v {*}
 * Returns:
 *   {boolean}
 */
function financeFilled_(v) {
  return String(v === null || v === undefined ? '' : v).trim() !== '';
}

/**
 * 用途：兩款表的表頭文字（數字欄，不含「項目」欄）。純函式。
 * Args:
 *   options {{mainLabels:string=, specialLabels:string=, periodLabel:string=}}
 *     `mainLabels`／`specialLabels` 是 Config 原文；`periodLabel` 是期別標籤（例如「5月份」）。
 * Returns:
 *   {{main:string[], special:string[]}} `main` 一律四項、`special` 一律兩項（Config 少了就補空字串，多了就截走）。
 */
function financeColumnLabels_(options) {
  var o = options || {};
  function fixed(raw, fallback, n) {
    var list = splitFinanceConfigList_(raw === undefined ? fallback : raw);
    var out = [];
    for (var i = 0; i < n; i++) out.push(list[i] === undefined ? '' : list[i]);
    return out;
  }
  var period = String(o.periodLabel || '');
  return {
    main: fixed(o.mainLabels, FINANCE_MAIN_COLUMN_LABELS_DEFAULT_, 4).map(function (s) {
      return s.split('{{PERIOD}}').join(period);
    }),
    special: fixed(o.specialLabels, FINANCE_SPECIAL_COLUMN_LABELS_DEFAULT_, 2)
  };
}

/**
 * 用途：把一期的財政表項（`model.finance`，已按次序排好）分成「綜合收支」與「特殊海外奉獻及慈惠基金」兩個報告。
 *   純函式。規則見檔頭。
 * Args:
 *   rows {{rowLabel:string, specialOverseas:string, hardship:string, col3:string, col4:string,
 *     title:string=, note:string=, balance:string=}[]} `model.finance`。
 *   options {{isoDate:string, mainTitlePattern:string=, specialTitlePattern:string=, specialKeywords:string=}}
 * Returns:
 *   {{main:?Object, special:?Object, warnings:{code:string, message:string}[]}}
 *     報告：`{kind:'MAIN'|'SPECIAL', title:string, titleFromPattern:boolean,
 *     rows:{label:string, col1:string, col2:string, col3:string, col4:string}[], note:string, balance:string}`。
 *     沒有那一款就是 `null`。
 * Raises:
 *   （無）
 */
function buildFinanceReports_(rows, options) {
  var o = options || {};
  var keywords = splitFinanceConfigList_(o.specialKeywords === undefined ? FINANCE_SPECIAL_KEYWORDS_DEFAULT_ : o.specialKeywords);
  var mainPattern = o.mainTitlePattern === undefined ? FINANCE_TITLE_PATTERN_DEFAULT_ : o.mainTitlePattern;
  var specialPattern = o.specialTitlePattern === undefined ? FINANCE_SPECIAL_TITLE_PATTERN_DEFAULT_ : o.specialTitlePattern;
  var out = { main: null, special: null, warnings: [] };

  // ---- 分組：填了「報告標題」的一行開始一個新的報告 ----
  var groups = [];
  var current = null;
  (rows || []).forEach(function (r) {
    var title = String(r.title === null || r.title === undefined ? '' : r.title).trim();
    if (!current || (title !== '' && (current.title !== '' || current.rows.length > 0))) {
      current = { title: '', rows: [], notes: [], balances: [] };
      groups.push(current);
    }
    if (title !== '' && current.title === '') current.title = title;
    current.rows.push(r);
    if (financeFilled_(r.note)) current.notes.push(String(r.note).trim());
    if (financeFilled_(r.balance)) current.balances.push(String(r.balance).trim());
  });

  groups.forEach(function (g) {
    var fourColumn = g.rows.some(function (r) { return financeFilled_(r.col3) || financeFilled_(r.col4); });
    var kind;
    if (g.title !== '') kind = containsAnyKeyword_(g.title, keywords) ? 'SPECIAL' : 'MAIN';
    else kind = fourColumn ? 'MAIN' : 'SPECIAL';
    var title = g.title !== '' ? g.title
      : applyFinanceMonthPattern_(kind === 'MAIN' ? mainPattern : specialPattern, o.isoDate);
    var report = {
      kind: kind, title: title, titleFromPattern: g.title === '',
      rows: g.rows.map(function (r) {
        return {
          label: String(r.rowLabel || ''), col1: String(r.specialOverseas || ''), col2: String(r.hardship || ''),
          col3: String(r.col3 || ''), col4: String(r.col4 || '')
        };
      }),
      note: g.notes.join('\n'), balance: g.balances.join('\n')
    };
    var slot = kind === 'MAIN' ? 'main' : 'special';
    if (out[slot]) {
      out.warnings.push({
        code: 'FINANCE_EXTRA_REPORT',
        message: '財政報告：這一期有兩個' + (kind === 'MAIN' ? '「綜合收支」' : '「特殊海外奉獻及慈惠基金」')
          + '報告（「' + out[slot].title + '」與「' + title + '」），週報每款只有一個表，只會印第一個。'
          + '如果第二個其實是另一款，請在內容表「財政報告」那個報告第一行的「報告標題」寫清楚。'
      });
      return;
    }
    out[slot] = report;
    if (kind === 'SPECIAL') {
      var extra = g.rows.filter(function (r) { return financeFilled_(r.col3) || financeFilled_(r.col4); });
      if (extra.length > 0) {
        out.warnings.push({
          code: 'FINANCE_SPECIAL_EXTRA_COLUMNS',
          message: '財政報告「' + title + '」是特殊海外奉獻及慈惠基金的款式，只印欄一、欄二；有 ' + extra.length
            + ' 行填了欄三或欄四（「' + extra.map(function (r) { return String(r.rowLabel || '（沒有項目）'); }).join('」「')
            + '」），那兩欄不會印。如果這是綜合收支報告，請改「報告標題」（不要含「' + keywords.join('」「') + '」）。'
        });
      }
    } else if (g.title === '' && g.rows.some(function (r) { return !financeFilled_(r.col3) && !financeFilled_(r.col4); })) {
      out.warnings.push({
        code: 'FINANCE_MIXED_COLUMNS',
        message: '財政報告「' + title + '」有些行填了欄三、欄四，有些行只填了欄一、欄二。如果後面那幾行是另一個報告'
          + '（特殊海外奉獻及慈惠基金），請在那個報告第一行填「報告標題」；否則請把空白的格填上（例如 0）。'
      });
    }
  });
  return out;
}
