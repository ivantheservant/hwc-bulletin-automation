/**
 * src/ConfigDiff.gs
 *
 * 2026-11-03（Ivan：多堂會／其他教會買斷之後方便日後支援和更新）：「設定差異檢查」——這一個部署的 Config 與程式
 * 預設值比較，寫入 Diagnostics（唯讀報告）：
 *   - 系統版本（APP_VERSION，見 docs/更新說明.md）、堂會（CONGREGATION_NAME）；
 *   - 缺少的設定（程式有、工作表未有 → 要按「初始化工作表」）；
 *   - 不認識的設定（工作表有、程式沒有 → 舊版遺留或打錯）；
 *   - 與預設值不同的設定；
 *   - 設定匯出（每行「鍵＝值」）：兩個部署各自跑一次，把這一段貼在一起比較，就知道兩邊設定的分別。
 *   電郵地址只顯示「已填 N 個」；檔案／資料夾 ID 只顯示頭 6 個字（不把完整 ID 交給別人）。
 */

'use strict';

/**
 * 用途：設定值顯示在報告時的遮蔽：電郵只講有幾個；ID 類只留頭 6 個字；過長的截短。純函式。
 * Args:
 *   key {string}　value {*}
 * Returns:
 *   {string}
 */
function maskConfigValueForReport_(key, value) {
  var v = String(value === null || value === undefined ? '' : value).trim();
  if (v === '') return '（空白）';
  if (/@/.test(v)) {
    var count = v.split(/[,，\s]+/).filter(function (x) { return /@/.test(x); }).length;
    return '（已填 ' + count + ' 個電郵）';
  }
  if (/(_ID|_FOLDER_ID|_FILE_ID|SPREADSHEET_ID)$/.test(String(key || '')) && /^[A-Za-z0-9_-]{15,}$/.test(v)) {
    return v.slice(0, 6) + '…（ID）';
  }
  v = v.replace(/\r?\n/g, '⏎');
  return v.length > 80 ? v.slice(0, 80) + '…' : v;
}

/**
 * 用途：設定差異報告的行。純函式。
 * Args:
 *   rows {{KEY:string, VALUE:*}[]} Config 工作表的資料列。
 *   defaults {{key:string, value:*}[]} `DEFAULTS`。
 *   meta {{version:string, congregation:string, generatedAt:string}}
 * Returns:
 *   {{lines:string[], missing:string[], unknown:string[], differs:string[]}}
 */
function buildConfigDiffReport_(rows, defaults, meta) {
  var m = meta || {};
  var byKey = {};
  (rows || []).forEach(function (r) {
    var k = String(r.KEY || '').trim();
    if (k) byKey[k] = r.VALUE;
  });
  var defaultByKey = {};
  (defaults || []).forEach(function (d) { defaultByKey[d.key] = d.value; });
  var missing = [];
  var differs = [];
  (defaults || []).forEach(function (d) {
    if (!Object.prototype.hasOwnProperty.call(byKey, d.key)) { missing.push(d.key); return; }
    var now = String(byKey[d.key] === null || byKey[d.key] === undefined ? '' : byKey[d.key]).trim();
    var def = String(d.value === null || d.value === undefined ? '' : d.value).trim();
    if (now !== def) differs.push(d.key);
  });
  var unknown = Object.keys(byKey).filter(function (k) { return !Object.prototype.hasOwnProperty.call(defaultByKey, k); }).sort();

  var lines = [];
  lines.push('系統版本：' + String(m.version || '') + '　堂會：' + String(m.congregation || '') + '　產生時間：' + String(m.generatedAt || ''));
  lines.push('（更新說明在 repo 的 docs/更新說明.md；版本相同、設定不同的兩個部署，行為只會因設定而不同。）');
  lines.push('');
  lines.push('【缺少的設定（' + missing.length + ' 個）】' + (missing.length ? '請按「週報系統 ▸ 初始化工作表」補上：' : '沒有'));
  missing.forEach(function (k) { lines.push('　' + k + '（預設：' + maskConfigValueForReport_(k, defaultByKey[k]) + '）'); });
  lines.push('');
  lines.push('【不認識的設定（' + unknown.length + ' 個）】' + (unknown.length ? '程式不會讀這幾個鍵（舊版遺留或者打錯字）：' : '沒有'));
  unknown.forEach(function (k) { lines.push('　' + k + '＝' + maskConfigValueForReport_(k, byKey[k])); });
  lines.push('');
  lines.push('【與預設值不同（' + differs.length + ' 個）】');
  differs.forEach(function (k) {
    lines.push('　' + k + '：現在「' + maskConfigValueForReport_(k, byKey[k]) + '」，預設「' + maskConfigValueForReport_(k, defaultByKey[k]) + '」');
  });
  lines.push('');
  lines.push('【設定匯出（兩個部署各自跑一次，把這一段放在一起比較）】');
  Object.keys(byKey).sort().forEach(function (k) { lines.push('　' + k + '＝' + maskConfigValueForReport_(k, byKey[k])); });
  return { lines: lines, missing: missing, unknown: unknown, differs: differs };
}

/**
 * 用途：選單「設定差異檢查（唯讀）」：寫入 Diagnostics，對話框講摘要。唯讀（只寫 Diagnostics）。
 * Returns:
 *   {void}
 */
function menuConfigDiffReport_() {
  var ui = SpreadsheetApp.getUi();
  try {
    var tz = getConfig_(CONFIG_KEYS.SYS_TIMEZONE, 'Pacific/Auckland');
    var report = buildConfigDiffReport_(readSheet_(SHEETS.CONFIG), DEFAULTS, {
      version: APP_VERSION, congregation: congregationName_(),
      generatedAt: Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd HH:mm')
    });
    writeDiagnosticsReport_('設定差異檢查', report.lines);
    ui.alert('設定差異檢查',
      '系統版本 ' + APP_VERSION + '，堂會「' + congregationName_() + '」。\n\n'
        + '缺少 ' + report.missing.length + ' 個、不認識 ' + report.unknown.length + ' 個、與預設值不同 ' + report.differs.length + ' 個。\n'
        + '完整報告（連設定匯出）已寫入 Diagnostics 工作表。這一次只是讀，一格設定都沒有改。',
      ui.ButtonSet.OK);
  } catch (err) {
    logMenuError_('menuConfigDiffReport_', err);
    ui.alert('設定差異檢查失敗', enrichAuthError_(err), ui.ButtonSet.OK);
  }
}
