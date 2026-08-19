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
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REPO_ROOT = path.join(__dirname, '..', '..');

/**
 * 用途：依序把多個 .gs 檔案的原始碼載入同一個 vm context。
 * Args:
 *   relPaths {string[]} 相對於 repo 根目錄的 .gs 檔案路徑，依序載入
 *     （後面的檔案可以使用前面檔案定義的 var／function）。
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

module.exports = { loadGasFiles: loadGasFiles };
