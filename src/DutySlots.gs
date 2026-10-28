/**
 * src/DutySlots.gs
 *
 * 2026-10-28（Ivan 選「兩樣都做」的第一半）：事奉項目多過 Word 範本格數時的警告。
 *
 *   Word 範本的事奉框（第 1 頁）與下週事奉（第 3 頁）是固定位置的格子，每一格是一個
 *   編號佔位符（`DUTY_01`..／`NEXT_DUTY_01`..，見 BulletinRender.gs 的
 *   `buildNumberedDutyValues_()`）。要印的項目多過範本的格數時，多出來的那幾項
 *   **完全不會印出**，以前亦沒有任何警告（bug class 2：缺失被當成正常值靜靜過）。
 *   例如聖餐主日加翻譯有 11 項，平常主日範本只有 10 格。
 *
 *   這裏只負責「找出哪幾項不會印出、組出警告」，不改任何印法。三個地方用同一套純函式：
 *   - 填寫介面載入（`loadWeekForWebApp_()`）→ 頂部「警告 N 項」；
 *   - 產生 Word（`generateBulletinDocx_()`）→ 用正在渲染的那一份範本 XML 核對；
 *   - 選單「預覽本週週報資料」與「檢查範本佔位符」→ Diagnostics。
 *
 *   ⚠️ 「要印的項目」一律經 `dutyRowsForPrint_()`（Config `DUTY_PRINT_EMPTY_ROWS`），
 *   與 Word 實際印的同一批行；不可以另外數一次（bug class 3）。
 *   ⚠️ 範本的格數一律由範本本身的佔位符數出來，不另設 Config（另設就是第二個真相來源）。
 */

/**
 * 用途：由（已經過 `prepareXmlForPlaceholders_()` 的）範本 XML 數出事奉框與下週事奉的格。純函式。
 *   `{{DUTY_nn}}`、`{{#IF:DUTY_nn}}`、`{{#IFP:DUTY_nn}}` 都算第 nn 格。
 *   範本如果用清單寫法（`{{#EACH:DUTY}}`／`{{#EACHP:DUTY}}`），那一區沒有固定格數，不會漏印。
 * Args:
 *   preparedXml {string} `prepareXmlForPlaceholders_(xml).xml`。
 * Returns:
 *   {{page1:number[], page3:number[], page1List:boolean, page3List:boolean}}
 *     `page1`／`page3` 是格的編號（由 1 起），由小到大、不重複。
 * Raises:
 *   （無）
 */
function templateDutySlotsFromXml_(preparedXml) {
  var page1 = {};
  var page3 = {};
  var page1List = false;
  var page3List = false;

  findPlaceholders_(preparedXml).forEach(function (p) {
    if (p.type === 'EACH' || p.type === 'EACHP') {
      var listName = String(p.name || '').replace(/_FW$/, '');
      if (listName === 'DUTY') page1List = true;
      if (listName === 'NEXT_DUTY') page3List = true;
      return;
    }
    if (p.type !== 'SIMPLE' && p.type !== 'IF' && p.type !== 'IFP') return;
    var m = /^(NEXT_)?DUTY_(\d+)$/.exec(String(p.name || ''));
    if (!m) return;
    var n = Number(m[2]);
    if (!(n >= 1)) return;
    if (m[1]) page3[n] = true; else page1[n] = true;
  });

  function sortedKeys(obj) {
    return Object.keys(obj).map(Number).sort(function (a, b) { return a - b; });
  }
  return { page1: sortedKeys(page1), page3: sortedKeys(page3), page1List: page1List, page3List: page3List };
}

/**
 * 用途：找出「要印、但範本沒有對應的格」的事奉行。純函式。
 *   第 i 行（由 1 起）印在第 i 格；範本沒有第 i 格，那一行就不會印出。
 * Args:
 *   slotIndexes {number[]} 範本有的格（`templateDutySlotsFromXml_()` 的 `page1`／`page3`）。
 *   printedRows {Object[]} `dutyRowsForPrint_()` 的輸出，每筆 `{label, text}`。
 * Returns:
 *   {{index:number, label:string, text:string}[]} 依原本次序。
 * Raises:
 *   （無）
 */
function findDroppedDutyRows_(slotIndexes, printedRows) {
  var slots = {};
  (slotIndexes || []).forEach(function (n) { slots[n] = true; });
  var dropped = [];
  (printedRows || []).forEach(function (row, i) {
    if (slots[i + 1]) return;
    dropped.push({
      index: i + 1,
      label: String((row && row.label) === null || (row && row.label) === undefined ? '' : row.label),
      text: String((row && row.text) === null || (row && row.text) === undefined ? '' : row.text)
    });
  });
  return dropped;
}

/**
 * 用途：把格的編號寫成「01–10」「01–09、11」這種短寫。純函式。
 * Args:
 *   indexes {number[]} 由小到大。
 * Returns:
 *   {string} 沒有格時回「（沒有）」。
 */
function formatDutySlotRange_(indexes) {
  var list = indexes || [];
  if (list.length === 0) return '（沒有）';
  var parts = [];
  var start = list[0];
  var prev = list[0];
  function pad(n) { return n < 10 ? '0' + n : String(n); }
  function flush() { parts.push(start === prev ? pad(start) : pad(start) + '–' + pad(prev)); }
  for (var i = 1; i < list.length; i++) {
    if (list[i] === prev + 1) { prev = list[i]; continue; }
    flush();
    start = list[i];
    prev = list[i];
  }
  flush();
  return parts.join('、');
}

/**
 * 用途：一區（第 1 頁或第 3 頁）的漏印警告。純函式。
 * Args:
 *   code {string} 警告代碼。
 *   areaLabel {string} 例如「第 1 頁事奉框」。
 *   slotIndexes {number[]} 範本有的格。
 *   printedRows {Object[]} 要印的行。
 *   templateLabel {string} Word 範本的名稱（`resolveWordTemplate_().label`）。
 * Returns:
 *   {?{code:string, message:string, dropped:Object[]}} 沒有漏印時回 `null`。
 */
function buildOneDutySlotWarning_(code, areaLabel, slotIndexes, printedRows, templateLabel) {
  var dropped = findDroppedDutyRows_(slotIndexes, printedRows);
  if (dropped.length === 0) return null;

  var items = dropped.map(function (d) {
    return d.label + (d.text ? '：' + d.text : '');
  }).join('、');
  var slotCount = (slotIndexes || []).length;
  var head = slotCount === 0
    ? areaLabel + '：Word 範本「' + templateLabel + '」沒有這一區的格，' + printedRows.length + ' 項全部不會印出：'
    : areaLabel + '有 ' + printedRows.length + ' 項要印，但 Word 範本「' + templateLabel + '」只有 '
      + slotCount + ' 格（' + formatDutySlotRange_(slotIndexes) + '），以下 ' + dropped.length + ' 項不會印出：';
  return {
    code: code,
    message: head + items + '。要在 Word 範本加格，或在職事表合併崗位。',
    dropped: dropped
  };
}

/**
 * 用途：這一週事奉框與下週事奉的漏印警告。純函式（範本格數由呼叫方傳入）。
 * Args:
 *   slots {Object} `templateDutySlotsFromXml_()` 的輸出。
 *   model {Object} `buildBulletinModel_()` 的輸出（用 `dutyBoxPage1`、`nextWeekDuty`、
 *     `dutyPrintEmptyRows`、`nextIsoDate`）。
 *   templateLabel {string} Word 範本的名稱。
 * Returns:
 *   {{code:string, message:string, dropped:Object[]}[]} 沒有漏印時是空陣列。
 */
function buildDutySlotWarnings_(slots, model, templateLabel) {
  var s = slots || {};
  var m = model || {};
  var printEmpty = m.dutyPrintEmptyRows === true;
  var out = [];

  if (s.page1List !== true) {
    var w1 = buildOneDutySlotWarning_('DUTY_SLOT_OVERFLOW', '第 1 頁事奉框', s.page1 || [],
      dutyRowsForPrint_(m.dutyBoxPage1, printEmpty), templateLabel);
    if (w1) out.push(w1);
  }
  if (s.page3List !== true) {
    var area3 = '第 3 頁下週事奉' + (m.nextIsoDate ? '（' + m.nextIsoDate + '）' : '');
    var w3 = buildOneDutySlotWarning_('NEXT_DUTY_SLOT_OVERFLOW', area3, s.page3 || [],
      dutyRowsForPrint_(m.nextWeekDuty, printEmpty), templateLabel);
    if (w3) out.push(w3);
  }
  return out;
}

/**
 * 用途：由雲端硬碟讀範本，數出事奉格。IO 層。
 *   ⚠️ 刻意不快取：本專案不用 Apps Script 的跨執行快取服務（tests/configcache.test.js），範本用「上載新版本」換過之後
 *   要即時反映。代價是填寫介面載入時多讀一次範本（約 300KB 的 document.xml）。
 * Args:
 *   fileId {string} Word 範本的檔案 ID。
 * Returns:
 *   {Object} `templateDutySlotsFromXml_()` 的輸出。
 * Raises:
 *   Error 範本讀不到、不是 Word 檔，或裏面沒有 word/document.xml。
 */
function readTemplateDutySlots_(fileId) {
  var entries = unzipDocx_(readTemplateBlob_(fileId));
  var index = findDocumentEntryIndex_(entries);
  if (index === -1) {
    throw new Error('範本內找不到 word/document.xml，可能不是一個 .docx 檔案。');
  }
  return templateDutySlotsFromXml_(
    prepareXmlForPlaceholders_(entries[index].blob.getDataAsString('UTF-8')).xml
  );
}

/**
 * 用途：按這一週用的 Word 範本核對事奉格。IO 層（讀範本）。填寫介面載入與「預覽本週週報資料」用；
 *   產生 Word 不經這一支（那裏已經有範本 XML，直接用 `templateDutySlotsFromXml_()`）。
 *
 *   ⚠️ 核對不到（範本讀不到）**不可以當作沒有漏印**：回一項 `DUTY_SLOT_CHECK_FAILED` 警告。
 *   範本未設定就不核對——那個情況產生 Word 時會另外報「未設定範本」。
 * Args:
 *   model {Object} `buildBulletinModel_()` 的輸出。
 * Returns:
 *   {{templateLabel:string, slots:?Object, error:string, warnings:Object[]}}
 */
function dutySlotCheckForModel_(model) {
  var template = resolveWordTemplate_(model && model.templateId);
  if (!template.fileId) {
    return { templateLabel: template.label, slots: null, error: '', warnings: [] };
  }
  try {
    var slots = readTemplateDutySlots_(template.fileId);
    return {
      templateLabel: template.label,
      slots: slots,
      error: '',
      warnings: buildDutySlotWarnings_(slots, model, template.label)
    };
  } catch (err) {
    var msg = (err && err.message) ? err.message : String(err);
    return {
      templateLabel: template.label,
      slots: null,
      error: msg,
      warnings: [{
        code: 'DUTY_SLOT_CHECK_FAILED',
        message: '未能核對 Word 範本「' + template.label + '」的事奉格數，事奉項目有沒有漏印未知：' + msg
      }]
    };
  }
}

/**
 * 用途：「檢查範本佔位符」與「預覽本週週報資料」報告的格數那一行。純函式。
 * Args:
 *   slots {Object} `templateDutySlotsFromXml_()` 的輸出。
 * Returns:
 *   {string} 例如「事奉框格數：第 1 頁 10 格（01–10）；第 3 頁下週事奉 11 格（01–11）」。
 */
function buildDutySlotCountLine_(slots) {
  var s = slots || {};
  function part(label, list, isList) {
    if (isList) return label + '用清單（沒有固定格數）';
    return label + ' ' + (list || []).length + ' 格（' + formatDutySlotRange_(list) + '）';
  }
  return '事奉框格數：' + part('第 1 頁', s.page1, s.page1List === true)
    + '；' + part('第 3 頁下週事奉', s.page3, s.page3List === true);
}

/**
 * 用途：報告逐行標記用——印出來的第 `printedIndex` 行（由 1 起）在範本有沒有格。純函式。
 * Args:
 *   slots {?Object} `templateDutySlotsFromXml_()` 的輸出；`null`＝未能核對。
 *   page {string} `'page1'` 或 `'page3'`。
 *   printedIndex {number} 由 1 起；0 或以下代表那一行本來就不印。
 * Returns:
 *   {boolean} `true`＝這一行要印但範本沒有格（會漏印）。未能核對時一律 `false`（另有警告）。
 */
function isDutyRowWithoutSlot_(slots, page, printedIndex) {
  if (!slots || !(printedIndex >= 1)) return false;
  if (slots[page + 'List'] === true) return false;
  return (slots[page] || []).indexOf(printedIndex) === -1;
}
