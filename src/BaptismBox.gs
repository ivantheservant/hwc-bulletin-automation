/**
 * BaptismBox.gs
 *
 * 浸禮合堂範本第 1 頁「副框」六個欄位的**單一真相來源**：欄位定義、
 * 顯示文字計算、以及副框在 Word 上的列分組。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 兩種欄位，處理方式完全不同
 * ─────────────────────────────────────────────────────────────────────
 *
 *   **單人欄位**（浸禮主禮／入會禮主禮／孩童奉獻禮主禮）：一位主禮，
 *   要經 `PersonDisplay` 尊稱機制處理，與事奉框一致——走的是
 *   `resolveOverrideDisplay_()`（按**姓名**查 `PersonDisplay`），因為這
 *   六欄是幹事在 `BulletinWeeks` 人手打姓名，不是職事表的 PersonID。
 *
 *   **多人欄位**（受浸肢體／入會肢體／奉獻孩童）：一格內多位，空格分隔，
 *   **原樣輸出**——不加尊稱、不排序、不拆開再組回去。受浸肢體多數是慕道
 *   友或新朋友，`PersonDisplay` 根本沒有他們；奉獻孩童更加不會有尊稱。
 *   自作聰明去逐個查表加尊稱，只會把「陳大文 李小明」變成一堆查不到的
 *   警告，而且改動了幹事親手排好的次序。
 *
 * ⚠️ 本檔案是**純函式層**：不呼叫任何 Apps Script 服務，
 * `personDisplayRows`／`withHonorific`／`targetDate` 一律由呼叫方
 * （`buildBulletinModel_()`）讀好傳進來，方便在 Node 直接測試。
 */

'use strict';

/**
 * 用途：浸禮副框六個欄位的完整定義——機器鍵、中文標題、單人／多人。
 *   **這是六欄的單一真相來源**：`BulletinWeeks` 欄位、填寫介面、季度
 *   填寫表、Word 佔位符全部由這一份衍生，不可以在別處另抄一份名單。
 *
 *   寫成函式延遲求值，不依賴 `.gs` 載入次序（見 docs/已知bug類型.md 事故一）。
 * Args: （無）
 * Returns:
 *   {{key:string, label:string, multi:boolean}[]}
 *     `multi` 為 true 代表多人欄位（原樣輸出）；false 代表單人欄位
 *     （要套尊稱）。次序即為填寫介面與季度填寫表的顯示次序。
 */
function baptismBoxFieldDefs_() {
  return [
    { key: 'BAPTISM_OFFICIANT', label: '浸禮主禮', multi: false },
    { key: 'MEMBERSHIP_OFFICIANT', label: '入會禮主禮', multi: false },
    { key: 'CHILD_DEDICATION_OFFICIANT', label: '孩童奉獻禮主禮', multi: false },
    { key: 'BAPTISM_MEMBERS', label: '受浸肢體', multi: true },
    { key: 'MEMBERSHIP_MEMBERS', label: '入會肢體', multi: true },
    { key: 'CHILD_DEDICATION_CHILDREN', label: '奉獻孩童', multi: true }
  ];
}

/**
 * 用途：浸禮副框六個欄位的機器鍵清單（次序同 `baptismBoxFieldDefs_()`）。
 * Args: （無）
 * Returns:
 *   {string[]}
 */
function baptismBoxFieldKeys_() {
  return baptismBoxFieldDefs_().map(function (d) { return d.key; });
}

/**
 * 用途：浸禮副框在 Word 範本上的**列分組**——副框是一個 3 列 × 2 欄的
 *   表格，每一列兩格，每格是「標籤：佔位符」：
 *
 *   ```
 *   浸禮：{{BAPTISM_OFFICIANT}}              入會禮：{{MEMBERSHIP_OFFICIANT}}
 *   受浸肢體：{{BAPTISM_MEMBERS}}            入會肢體：{{MEMBERSHIP_MEMBERS}}
 *   孩童奉獻禮：{{CHILD_DEDICATION_OFFICIANT}}  奉獻孩童：{{CHILD_DEDICATION_CHILDREN}}
 *   ```
 *
 *   這份分組交給 `applyOptionalLabelledCellRows_()`（`src/DocxTemplate.gs`）
 *   決定留空時要刪哪一列：**同一列兩個欄位皆空就刪整列**（標籤不可以
 *   孤零零留在紙上），**六個全空就刪整個表格**。
 *
 *   ⚠️ 這裡的分組是**版面事實**（範本上哪兩個佔位符同一列），不是業務
 *   規則，所以跟 `baptismBoxFieldDefs_()` 的次序不同是正常的——那一份是
 *   「先三個主禮、後三個名單」的填寫次序，這一份是「浸禮／入會禮／孩童
 *   奉獻禮」三個典禮各佔一列的排版次序。
 * Args: （無）
 * Returns:
 *   {string[][]} 每個元素是一列，內含該列兩格的機器鍵。
 */
function baptismBoxRowGroups_() {
  return [
    ['BAPTISM_OFFICIANT', 'MEMBERSHIP_OFFICIANT'],
    ['BAPTISM_MEMBERS', 'MEMBERSHIP_MEMBERS'],
    ['CHILD_DEDICATION_OFFICIANT', 'CHILD_DEDICATION_CHILDREN']
  ];
}

/**
 * 用途：把浸禮副框六欄的**原始值**算成週報上要印的顯示文字。純函式。
 *
 *   單人欄位走 `resolveOverrideDisplay_()`（`src/PersonDisplay.gs`）——
 *   與事奉框人手覆寫的姓名走**完全同一條路徑**，所以尊稱規則只有一套：
 *   `DISPLAY_OVERRIDE` 優先、職稱類尊稱一律保留、一般敬稱受
 *   `withHonorific` 控制、查不到的姓名原樣顯示並記一筆 warning。
 *
 *   多人欄位只做 `trim()`，其餘原樣輸出——理由見檔頭。
 * Args:
 *   week {Object} `BulletinWeeks` 該主日的資料列；沒有該行時傳 `{}`。
 *   options {{withHonorific:boolean, personDisplayRows:Object[],
 *            targetDate:(Date|null), warnings:(Object[]|undefined)}=}
 *     同 `resolveOverrideDisplay_()` 的 options；省略時等於「不套尊稱、
 *     沒有 PersonDisplay 資料」，六欄一律原樣輸出。
 * Returns:
 *   {Object<string,string>} 機器鍵 → 顯示文字。六個鍵**一定齊全**，
 *     沒有值的是空字串——副框的留空規則靠「這一格是不是空字串」判斷，
 *     缺鍵與空字串必須分得清楚。
 */
function buildBaptismBoxFields_(week, options) {
  var row = week || {};
  var opts = options || {};
  var out = {};

  baptismBoxFieldDefs_().forEach(function (def) {
    var raw = String(row[def.key] === null || row[def.key] === undefined ? '' : row[def.key]).trim();
    if (!raw) {
      out[def.key] = '';
      return;
    }
    out[def.key] = def.multi ? raw : resolveOverrideDisplay_(raw, opts);
  });

  return out;
}
