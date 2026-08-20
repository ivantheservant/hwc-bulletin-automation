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
  return {
    getLastRow: function () { return data.length; },
    getLastColumn: function () { return keys.length; },
    getMaxRows: function () { return Math.max(data.length, 1000); },
    getFrozenRows: function () { return frozenRows; },
    setFrozenRows: function (n) { frozenRows = n; },
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
              data[rowIdx][c - 1 + j] = values[i][j];
            }
          }
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

module.exports = { makeFakeSheet: makeFakeSheet, makeFakeSpreadsheet: makeFakeSpreadsheet };
