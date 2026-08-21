#!/usr/bin/env node
/**
 * tests/helpers/fakeSpreadsheet.js
 *
 * 共用的假 SpreadsheetApp／Sheet／Range 建構工具，供需要「由真正入口叫
 * 下去」的測試使用（tests/rostersnapshot.test.js、tests/configcache.test.js）。
 * 支援讀取（getValues）與 ensureSheet_() 會用到的少數幾個寫入方法
 * （setValues／setFontWeight／setBackground／setNumberFormat／
 * setFrozenRows），足夠讓 getConfig() 的 loadConfigCache_() 冷啟動路徑
 * （會先呼叫 ensureSheet_(ss,'CONFIG') 確保標題正確）正常運作。
 */

'use strict';

/**
 * 用途：把要「寫進」假工作表的值轉成**跨 vm realm 安全**的形式。
 *
 *   ⚠️ 為什麼需要這一步：測試常常用一個新的 sandbox 模擬「Apps Script 的
 *   下一次執行」，但假工作表的資料是跨 sandbox 共用的。如果直接把 A
 *   sandbox 造出來的 `Date` 物件存起來，B sandbox 讀到它時，
 *   `value instanceof Date` 會因為兩邊的 `Date` 建構子不是同一個而判定
 *   false——`normalizeDate_()` 於是拋「不是 Date 物件、也不是合法的
 *   yyyy-MM-dd 字串」，而值印出來明明就是一個日期，非常難查。
 *
 *   真正的 Sheets 沒有這個問題（只有一個 realm），所以這純粹是測試替身
 *   要補的落差。存成 `yyyy-MM-dd` 字串是安全的：`normalizeDate_()` 本來
 *   就同時接受 Date 與 `yyyy-MM-dd`，下游拿到的仍然是正規化過的 Date。
 * Args:
 *   value {*} 要寫入的值。
 * Returns:
 *   {*} Date 會被轉成 yyyy-MM-dd 字串，其餘原樣回傳。
 */
function toRealmSafeCellValue(value) {
  if (value && Object.prototype.toString.call(value) === '[object Date]') {
    var y = value.getFullYear();
    var mo = String(value.getMonth() + 1);
    var d = String(value.getDate());
    if (mo.length < 2) mo = '0' + mo;
    if (d.length < 2) d = '0' + d;
    return y + '-' + mo + '-' + d;
  }

  return value;
}

/**
 * 用途：模仿真實 Sheets 對「前導單引號」的處理。
 *
 *   ⚠️ 真的 Google Sheets 會把開頭那個 `'` 當成**格式標記**（意思是
 *   「這一格當純文字，不要當公式」）吃掉，`getValue()` 讀回來是**沒有**
 *   那個單引號的。
 *
 *   不模仿的話，`sanitizeCellText_()` 為了防公式注入而加的單引號會被假
 *   工作表當成內容存起來——使用者填的 `--` 讀回來變成 `'--`，而且每寫
 *   一次就多一個。第八輪的同步比對會因此永遠判定「有改動」，來回推個
 *   不停。那是假替身的落差，不是程式的 bug。
 *
 *   跳脫過的值會記進 `escapedValues`，讓「證明 sanitizeCellText_ 真的被
 *   呼叫了」這類測試仍然驗證得到——**驗證的是行為，不是儲存格式**。
 * Args:
 *   value {*} 要寫入的值。
 *   escapedValues {Set=} 選填，用來記錄「這個值曾經被跳脫過」。
 * Returns:
 *   {*} 字串前導單引號會被吃掉，其餘原樣回傳。
 */
function applyTextFormatMarker(value, escapedValues) {
  if (typeof value !== 'string' || value.charAt(0) !== "'") return value;
  var stripped = value.slice(1);
  if (escapedValues) escapedValues.add(stripped);
  return stripped;
}

/**
 * 用途：造一張假的 Sheet，內容用 headers／keys 兩行＋資料列組成。
 * Args:
 *   headers {string[]} 第 1 行（人看的標題，內容不影響任何驗證邏輯）。
 *   keys {string[]} 第 2 行機器鍵，決定資料列的欄位順序。
 *   rowObjects {Object[]} 資料列，以機器鍵為 key 的物件陣列。
 * Returns:
 *   {Object} 假 Sheet，實作 getLastRow／getLastColumn／getMaxRows／
 *     getFrozenRows／setFrozenRows／getRange()（含 getValues／setValues／
 *     setFontWeight／setBackground／setNumberFormat／clearContent）。
 */
function makeFakeSheet(headers, keys, rowObjects) {
  var data = [headers, keys].concat(rowObjects.map(function (obj) {
    return keys.map(function (k) { return obj[k] === undefined ? '' : obj[k]; });
  }));
  var frozenRows = 0;
  // 記住哪些值曾經被 sanitizeCellText_() 跳脫過（見 applyTextFormatMarker）。
  var escapedValues = new Set();
  // 第八輪的填寫邀請要組 `#gid=` 直達連結，所以假工作表也要有一個
  // sheetId。用內容長度湊一個穩定的假值就夠——測試只驗證「連結裡面
  // 真的有 #gid=」，不驗證那個數字本身。
  var fakeSheetId = 100000 + (headers.length * 1000) + keys.length;
  var sheetName = '';
  return {
    __escapedValues: escapedValues,
    getSheetId: function () { return fakeSheetId; },
    getName: function () { return sheetName; },
    setName: function (n) { sheetName = n; return this; },
    // 第八輪的「設定工作表保護」要用。假物件只需要記住「保護過幾多次」
    // 與「例外編輯者是誰」，真正的權限行為由 Google 負責，測不到也不用測。
    __protections: [],
    getProtections: function () { return this.__protections.slice(); },
    protect: function () {
      var self = this;
      var record = { description: '', editors: [] };
      self.__protections.push(record);
      return {
        setDescription: function (d) { record.description = d; return this; },
        getEditors: function () { return record.editors.slice(); },
        removeEditors: function () { record.editors = []; return this; },
        addEditors: function (list) { record.editors = record.editors.concat(list); return this; },
        canEdit: function () { return true; },
        remove: function () {
          var i = self.__protections.indexOf(record);
          if (i !== -1) self.__protections.splice(i, 1);
        }
      };
    },
    getLastRow: function () { return data.length; },
    getLastColumn: function () { return keys.length; },
    getMaxRows: function () { return Math.max(data.length, 1000); },
    getFrozenRows: function () { return frozenRows; },
    setFrozenRows: function (n) { frozenRows = n; },
    // prompt8b：一次性清理廢棄 Config 鍵需要真的刪掉一整行（1 起算）。
    deleteRow: function (rowNo) { data.splice(rowNo - 1, 1); },
    getRange: function (r, c, numRows, numCols) {
      numRows = numRows || 1;
      numCols = numCols || 1;
      return {
        getValues: function () {
          var out = [];
          for (var i = 0; i < numRows; i++) {
            var rowIdx = r - 1 + i;
            var rowArr = [];
            for (var j = 0; j < numCols; j++) {
              var colIdx = c - 1 + j;
              var srcRow = data[rowIdx];
              rowArr.push(srcRow && srcRow[colIdx] !== undefined ? srcRow[colIdx] : '');
            }
            out.push(rowArr);
          }
          return out;
        },
        setValues: function (values) {
          for (var i = 0; i < values.length; i++) {
            var rowIdx = r - 1 + i;
            while (data.length <= rowIdx) data.push([]);
            for (var j = 0; j < values[i].length; j++) {
              data[rowIdx][c - 1 + j] = applyTextFormatMarker(toRealmSafeCellValue(values[i][j]), escapedValues);
            }
          }
          return this;
        },
        // 真正的 Range 除了 getValues/setValues 也有單格的 getValue/setValue，
        // 而且 ConfigService.setConfig() 與 BulletinModel 的範本寫回都在用。
        // 假物件缺了它們的話，那些程式碼會在 try/catch 內悄悄失敗，測試表面
        // 上還是「通過」——所以這裡一併補齊。
        getValue: function () {
          var srcRow = data[r - 1];
          return srcRow && srcRow[c - 1] !== undefined ? srcRow[c - 1] : '';
        },
        setValue: function (value) {
          while (data.length <= r - 1) data.push([]);
          data[r - 1][c - 1] = applyTextFormatMarker(toRealmSafeCellValue(value), escapedValues);
          return this;
        },
        clearContent: function () {
          for (var i = 0; i < numRows; i++) {
            var rowIdx = r - 1 + i;
            if (data[rowIdx]) {
              for (var j = 0; j < numCols; j++) data[rowIdx][c - 1 + j] = '';
            }
          }
          return this;
        },
        setFontWeight: function () { return this; },
        setBackground: function () { return this; },
        setNumberFormat: function () { return this; }
      };
    }
  };
}

/**
 * 用途：造一個假的 Spreadsheet，只支援 getSheetByName（讀取用途足夠）。
 * Args:
 *   sheetsByName {Object<string,Object>} 工作表名稱 → makeFakeSheet() 的結果。
 * Returns:
 *   {Object}
 */
function makeFakeSpreadsheet(sheetsByName) {
  return {
    getSheetByName: function (name) { return sheetsByName[name] || null; },
    insertSheet: function (name) {
      throw new Error('makeFakeSpreadsheet：測試沒有預期會呼叫 insertSheet(' + name + ')。');
    }
  };
}

module.exports = {
  makeFakeSheet: makeFakeSheet,
  makeFakeSpreadsheet: makeFakeSpreadsheet,
  // 第八輪的季度填寫表要自己造一張三行標題的假工作表（見
  // tests/helpers/fillEnv.js），那邊的 setValue／setValues 一樣要經過
  // 這個正規化，否則會出現 Date 跨 realm 與前導單引號兩種假失敗。
  toRealmSafeCellValue: toRealmSafeCellValue,
  applyTextFormatMarker: applyTextFormatMarker
};
