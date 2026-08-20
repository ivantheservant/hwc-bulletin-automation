#!/usr/bin/env node
/**
 * tests/helpers/loadGas.js
 *
 * 把一個或多個 .gs 檔案的原始碼載入「同一個」Node vm context，模擬 Apps
 * Script「一個專案內全部檔案共用一個全域命名空間」的真實行為。
 *
 * 為什麼不直接用 require('../src/Xxx.gs')：
 *   Node 的 CommonJS 模組系統會把每個檔案包在自己的函式作用域裡，
 *   一個檔案內用 `var` 宣告的東西不會自動變成另一個檔案看得到的全域——
 *   但 Apps Script 的實際執行模型恰恰相反（全部檔案共用一個全域命名空間）。
 *   如果測試用 require() 個別載入 SheetUtils.gs，它內部對 Constants.gs
 *   的 COLUMN_TYPES／SHEETS 的參照會在呼叫時找不到定義。用 vm 把多個檔案
 *   跑在同一個 context 物件上，才是對真實執行模型的正確模擬。
 *
 * ⚠️ 為什麼一定要用 loadAllSrcFilesInOrder()、而不是自己手動列一個檔案清單
 * ─────────────────────────────────────────────────────────────────────
 *
 * 事故經過：第一輪 tests/sheetutils.test.js／tests/constants.test.js 用
 * `loadGasFiles(['src/Constants.gs', 'src/SheetUtils.gs'], ...)` 這種
 * 「自己揀順序」的載入方式，把 Constants.gs 排在最前面，兩個測試檔案
 * 全部通過。但 Apps Script 實際上是**按專案內的檔案次序**（Script Editor
 * 左邊清單的次序，也就是按檔名字母序）逐個執行每個 .gs 的頂層陳述式，
 * 實際次序是 AuditLog → Bootstrap → ConfigService → Constants →
 * Diagnostics → Menu → SheetUtils——Bootstrap.gs 排在 Constants.gs 之前。
 *
 * 當時 Bootstrap.gs 有一個頂層 `var SEED_PROGRAM_TEMPLATES_ = [...]`用到
 * `POSTURE.STAND`（POSTURE 是 Constants.gs 才宣告的），在真實次序下執行
 * 到 Bootstrap.gs 的時候 POSTURE 還是 undefined，讀 `.STAND` 直接拋
 * TypeError，導致整個專案載入失敗——`onOpen()` 完全沒有機會執行，選單
 * 永遠出不到。但因為兩個測試檔案「自己揀」的次序剛好避開了這個問題，
 * Node 測試全部通過，這個 bug 一直到 Ivan 手動在 Script Editor 執行
 * onOpen() 才被發現（詳見 docs/已知bug類型.md）。
 *
 * 教訓：測試載入 .gs 檔案的次序**必須**跟 Apps Script 的實際次序一致，
 * 不可以為了方便測試（例如把有依賴關係的檔案手動排到前面）而自選次序，
 * 那樣等於把真正的執行環境「修正」成一個不存在的假象。所以
 * `loadAllSrcFilesInOrder()` 一律按檔名字母序讀取 src/ 目錄的實際內容，
 * 不接受呼叫方指定順序；tests/*.test.js 需要載入多個 .gs 檔案時，一律
 * 呼叫這個函式，不要再手動列出 relPaths 清單。
 *
 * 對應的靜態防線是 tools/lint-load-order.js——那個工具在**寫程式碼的
 * 當下**用靜態分析攔住跨檔案的頂層初始化式順序問題；這裡是在**執行期**
 * 用真實次序把全部檔案跑一次，兩者互補。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REPO_ROOT = path.join(__dirname, '..', '..');
const SRC_DIR = path.join(REPO_ROOT, 'src');

/**
 * 用途：依呼叫方指定的次序，把多個 .gs 檔案的原始碼載入同一個 vm context。
 *   低階函式——一般測試請改用 loadAllSrcFilesInOrder()，只有在刻意要
 *   測試「次序錯誤會怎樣」這種情境（例如驗證 lint 工具本身）才需要直接
 *   指定次序。
 * Args:
 *   relPaths {string[]} 相對於 repo 根目錄的 .gs 檔案路徑，依序載入。
 *   extraGlobals {Object=} 選填，要在載入任何檔案「之前」就放進 context
 *     的假 GAS 全域物件（例如 Utilities、Session 的 stub）。
 * Returns:
 *   {vm.Context} 執行完畢的 context，可以直接用屬性存取取出裡面定義的
 *     function／var（例如 context.normalizeBoolean_）。
 * Raises:
 *   Error 如果任何一個檔案不存在，或內容有語法錯誤（vm 會原樣拋出）。
 */
function loadGasFiles(relPaths, extraGlobals) {
  const sandbox = Object.assign({ console: console }, extraGlobals || {});
  vm.createContext(sandbox);

  relPaths.forEach(function (relPath) {
    const filePath = path.join(REPO_ROOT, relPath);
    const code = fs.readFileSync(filePath, 'utf8');
    vm.runInContext(code, sandbox, { filename: filePath });
  });

  return sandbox;
}

/**
 * 用途：把 src/ 目錄下全部 .gs 檔案，按檔名字母序（與 Apps Script 實際
 *   載入次序一致）載入同一個 vm context。一般測試需要載入多個 .gs 檔案
 *   時的標準入口。
 * Args:
 *   extraGlobals {Object=} 選填，假 GAS 全域物件，同 loadGasFiles()。
 *   srcDir {string=} 選填，預設 repo 根目錄下的 src/。
 * Returns:
 *   {vm.Context} 同 loadGasFiles()。
 * Raises:
 *   Error 如果 src 目錄不存在，或任何檔案內容有語法錯誤。
 */
function loadAllSrcFilesInOrder(extraGlobals, srcDir) {
  srcDir = srcDir || SRC_DIR;
  const fileNames = fs.readdirSync(srcDir)
    .filter(function (f) { return f.endsWith('.gs'); })
    .sort();

  const relPaths = fileNames.map(function (f) {
    return path.relative(REPO_ROOT, path.join(srcDir, f));
  });

  return loadGasFiles(relPaths, extraGlobals);
}

module.exports = {
  loadGasFiles: loadGasFiles,
  loadAllSrcFilesInOrder: loadAllSrcFilesInOrder
};
