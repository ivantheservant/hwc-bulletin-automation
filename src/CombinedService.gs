/**
 * src/CombinedService.gs
 *
 * 2026-10-30：職事表合堂主日（職事表第八十五輪；說明文件第 5 節）。
 *
 *   - 職事表 `ServiceDates.CombinedKind`（種類代號；空白＝不是合堂）、`CombinedName`（名稱，可以空白）。
 *     由幹事在職事表「開季前準備 ▸ 合堂主日」設定。**週報只讀，一格都不寫。**舊試算表沒有這兩欄
 *     ＝全部不是合堂（不是錯誤）。
 *   - 程序範本（留空＝自動時）：合堂種類（Config `COMBINED_KIND_TEMPLATES`）＞ 每週標題關鍵詞 ＞ 平常範本。
 *     幹事在填寫介面人手選的範本永遠優先。種類代號不在 Config ＝ 警告講出來，改用每週標題判斷。
 *   - 標題（Ivan 2026-10-30 選「每週標題優先」）：職事表每週標題（`Title`）＞ 合堂名稱（`CombinedName`）＞
 *     種類名稱（Config `COMBINED_KIND_NAMES`）。結果放在 `snapshot.special.title`（沿用舊位置，封面、
 *     郵件標題、程序範本關鍵詞等下游不用改）。
 *   - 填寫介面〔設定合堂主日〕：新分頁打開職事表幹事介面（Config `ROSTER_WEBAPP_URL`）的
 *     `?view=combined&quarter=<QuarterID>`（職事表第八十七輪起支援）。
 */

'use strict';

/**
 * 用途：解析「代號=值」逗號分隔的清單（例如 `COMBINED=TPL_COMBINED,BAPTISM=TPL_COMBINED_BAPTISM`）。純函式。
 *   代號去頭尾空白、轉大寫；值去頭尾空白。格式不對的一項略過（Config 的說明寫明格式）。
 * Args:
 *   raw {*} Config 原始值。
 * Returns:
 *   {Object<string,string>}
 * Raises:
 *   （無）
 */
function parseCodeValueList_(raw) {
  var out = {};
  String(raw === null || raw === undefined ? '' : raw).split(/[,，]/).forEach(function (part) {
    var i = part.indexOf('=');
    if (i <= 0) return;
    var code = part.slice(0, i).trim().toUpperCase();
    var value = part.slice(i + 1).trim();
    if (code && value) out[code] = value;
  });
  return out;
}

/**
 * 用途：由職事表 `ServiceDates` 一行讀出合堂設定。純函式。
 * Args:
 *   serviceDateRow {?Object} `tables.serviceDates` 其中一行（`CombinedKind`／`CombinedName` 是選讀欄）。
 * Returns:
 *   {?{kind:string, name:string}} 不是合堂（種類代號空白，或者沒有這一欄）回 null。
 * Raises:
 *   （無）
 */
function buildRosterCombinedService_(serviceDateRow) {
  var row = serviceDateRow || {};
  var kind = String(row.CombinedKind === null || row.CombinedKind === undefined ? '' : row.CombinedKind).trim().toUpperCase();
  if (!kind) return null;
  var name = String(row.CombinedName === null || row.CombinedName === undefined ? '' : row.CombinedName).trim();
  return { kind: kind, name: name };
}

/**
 * 用途：合堂週的標題（每週標題空白時才用）：合堂名稱 ＞ 種類名稱 ＞「合堂」。純函式。
 * Args:
 *   combined {{kind:string, name:string}}　kindNames {Object<string,string>} `parseCodeValueList_()` 的結果。
 * Returns:
 *   {string}
 */
function combinedServiceTitle_(combined, kindNames) {
  if (!combined) return '';
  return combined.name || (kindNames || {})[combined.kind] || '合堂';
}

/**
 * 用途：〔設定合堂主日〕按鈕的網址：職事表幹事介面網址加 `view=combined&quarter=<季度>`。純函式。
 *   只接受 `https://` 開頭的網址；季度格式不對亦不顯示（一條開錯季度的連結比不顯示更差）。
 * Args:
 *   baseUrl {string} Config `ROSTER_WEBAPP_URL`。　quarterId {string} 職事表的 QuarterID（例如 2027T1）。
 * Returns:
 *   {string} 不顯示按鈕時回空字串。
 */
function buildRosterCombinedUrl_(baseUrl, quarterId) {
  return buildRosterViewUrl_(baseUrl, 'combined', quarterId);
}

/**
 * 用途：2026-10-31：職事表幹事介面某一個畫面的深連結（職事表說明第 10 節：`?view=<畫面>&quarter=<季度>`）。純函式。
 * Args:
 *   baseUrl {string} Config ROSTER_WEBAPP_URL（/exec 網址）。　view {string} `combined`／`choir`。　quarterId {string}
 * Returns:
 *   {string} 網址；網址不是 https、畫面不認得或季度格式不對＝空字串（不顯示按鈕）。
 */
function buildRosterViewUrl_(baseUrl, view, quarterId) {
  var base = String(baseUrl || '').trim();
  var q = String(quarterId || '').trim();
  var v = String(view || '').trim();
  if (['combined', 'choir'].indexOf(v) === -1) return '';
  if (!/^https:\/\//i.test(base) || !/^\d{4}T[1-4]$/.test(q)) return '';
  var hashIndex = base.indexOf('#');
  if (hashIndex !== -1) base = base.slice(0, hashIndex);
  return base + (base.indexOf('?') === -1 ? '?' : '&') + 'view=' + v + '&quarter=' + encodeURIComponent(q);
}

/**
 * 用途：讀合堂相關 Config。
 * Args: （無）
 * Returns:
 *   {{kindTemplates:Object<string,string>, kindNames:Object<string,string>}}
 */
function readCombinedServiceConfig_() {
  return {
    kindTemplates: parseCodeValueList_(getConfig_(CONFIG_KEYS.COMBINED_KIND_TEMPLATES,
      'COMBINED=TPL_COMBINED,BAPTISM=TPL_COMBINED_BAPTISM,ANNIVERSARY=TPL_ANNIVERSARY')),
    kindNames: parseCodeValueList_(getConfig_(CONFIG_KEYS.COMBINED_KIND_NAMES, 'COMBINED=合堂,BAPTISM=浸禮,ANNIVERSARY=堂慶'))
  };
}
