#!/usr/bin/env node
/**
 * tests/helpers/contentTabFake.js
 *
 * 內容表（獨立試算表）的**嚴格**假替身：一張分頁、一個試算表。tests/helpers/contentEnv.js、
 * tests/fieldoverride.test.js、tests/quarterops.test.js 與內容表 v2 的移轉測試共用這一份。
 *
 * ⚠️ 為甚麼要嚴格（docs/已知bug類型.md bug class 26、46、80）：
 *   以前三個測試檔各有一份「甚麼都收」的假分頁——`setValue()` 甚麼都不做、`getRange()` 超出
 *   欄數照樣回空白、`content: { 宣召: … }` 寫錯分頁名稱就當作空白分頁。內容表 v2 要把「宣召」
 *   「浸禮合堂」併入「崇拜程序」，那些寬鬆的地方正正會令移轉測試空跑變綠。所以這一份：
 *     - `getRange()` 超出分頁的欄數就拋錯（真的 Sheets 一樣拋「超出範圍」）；
 *     - 寫入照真的 Sheets 那樣自動轉型（沒有先設 `@` 的 '42,150' 會變成數字）；
 *     - `setName()` 之後 `getSheetByName()` 跟住新名字走，撞名拋錯；
 *     - 有 `hideSheet()`／`showSheet()`／`isSheetHidden()`、`protect()`、`setNote()` 記錄；
 *     - 可以注入「第 N 次寫入／改名時拋錯」，模擬移轉跑到一半失敗。
 */

'use strict';

const { writeCellLikeSheets } = require('./fakeSpreadsheet');

/** 真的 Google 試算表新分頁預設有幾多欄。 */
const DEFAULT_MAX_COLUMNS = 26;

/**
 * 用途：造一個「注入失敗」的計數器。同一個試算表的全部分頁共用一個。
 * Args:
 *   spec {{failOnSetValue:number=, failOnSetName:number=, failOnDeleteColumns:number=}=} 第幾次（1 起算）寫入格子／改名／
 *     刪欄時拋錯；
 *     省略就永遠不拋。寫入格子包括 `setValue()` 與 `setValues()`（每一次呼叫算一次）。
 * Returns:
 *   {{setValueCalls:number, setNameCalls:number, tick:function(string):void}}
 */
function makeContentFaults(spec) {
  const s = spec || {};
  const faults = {
    setValueCalls: 0,
    setNameCalls: 0,
    failOnSetValue: s.failOnSetValue || null,
    failOnSetName: s.failOnSetName || null,
    deleteColumnsCalls: 0,
    failOnDeleteColumns: s.failOnDeleteColumns || null,
    tick: function (kind) {
      if (kind === 'setValue') {
        faults.setValueCalls++;
        if (faults.failOnSetValue && faults.setValueCalls === faults.failOnSetValue) {
          throw new Error('假替身：注入的寫入失敗（第 ' + faults.setValueCalls + ' 次寫入）');
        }
      } else if (kind === 'deleteColumns') {
        faults.deleteColumnsCalls++;
        if (faults.failOnDeleteColumns && faults.deleteColumnsCalls === faults.failOnDeleteColumns) {
          throw new Error('假替身：注入的刪欄失敗（第 ' + faults.deleteColumnsCalls + ' 次刪欄）');
        }
      } else if (kind === 'setName') {
        faults.setNameCalls++;
        if (faults.failOnSetName && faults.setNameCalls === faults.failOnSetName) {
          throw new Error('假替身：注入的改名失敗（第 ' + faults.setNameCalls + ' 次改名）');
        }
      }
    }
  };
  return faults;
}

/**
 * 用途：造一張假的內容表分頁。`keys` 有內容時第 1 行是中文標題、第 2 行是機器鍵、資料由第 3 行開始；
 *   `keys` 是空陣列代表一張剛插入的空白分頁。
 * Args:
 *   keys {string[]} 第 2 行機器鍵。
 *   headers {string[]} 第 1 行中文標題。
 *   rows {Object[]} 資料列（以機器鍵為 key）；值原樣放入，不經自動轉型（當作「本來就在那裏」）。
 *   opts {{name:string=, maxColumns:number=, faults:Object=}=}
 * Returns:
 *   {Object} 假分頁。
 */
function makeContentTab(keys, headers, rows, opts) {
  const o = opts || {};
  const data = [];
  if ((keys || []).length > 0) {
    data.push(headers.slice());
    data.push(keys.slice());
  }
  (rows || []).forEach(function (row) {
    data.push(keys.map(function (k) { return row[k] === undefined ? '' : row[k]; }));
  });
  const faults = o.faults || makeContentFaults({});
  const numberFormats = {};   // 'r:c' → 格式
  const notes = {};           // 'r:c' → 註解
  const validations = {};     // 'r:c' → 驗證
  const escapedValues = new Set();
  let maxColumns = Math.max(o.maxColumns || DEFAULT_MAX_COLUMNS, (keys || []).length);
  let frozenRows = (keys || []).length > 0 ? 2 : 0;
  let frozenColumns = 0;
  let hidden = false;
  const protections = [];

  function isBlank(v) { return v === '' || v === null || v === undefined; }

  function checkBounds(r, c, numRows, numCols) {
    if (!(r >= 1) || !(c >= 1) || !(numRows >= 1) || !(numCols >= 1)) {
      throw new Error('假替身：getRange(' + [r, c, numRows, numCols].join(', ') + ') 的座標不合法。');
    }
    if (c + numCols - 1 > maxColumns) {
      throw new Error('假替身：範圍超出分頁「' + sheet.__name + '」的欄數（要到第 ' + (c + numCols - 1)
        + ' 欄，分頁只有 ' + maxColumns + ' 欄）。真的 Sheets 一樣會拋錯。');
    }
  }

  const sheet = {
    __name: o.name || '',
    __data: data,
    __numberFormats: numberFormats,
    __notes: notes,
    __validations: validations,
    __protections: protections,
    __escapedValues: escapedValues,
    __parent: null,
    getName: function () { return sheet.__name; },
    setName: function (name) {
      faults.tick('setName');
      if (sheet.__parent && sheet.__parent.getSheetByName(name) && sheet.__parent.getSheetByName(name) !== sheet) {
        throw new Error('假替身：已經有一張分頁叫「' + name + '」。');
      }
      sheet.__name = name;
      return sheet;
    },
    getLastRow: function () {
      for (let r = data.length; r >= 1; r--) {
        if ((data[r - 1] || []).some(function (v) { return !isBlank(v); })) return r;
      }
      return 0;
    },
    getLastColumn: function () {
      let max = 0;
      data.forEach(function (row) {
        for (let c = (row || []).length; c >= 1; c--) {
          if (!isBlank(row[c - 1])) { max = Math.max(max, c); break; }
        }
      });
      return max;
    },
    getMaxRows: function () { return Math.max(data.length, 1000); },
    getMaxColumns: function () { return maxColumns; },
    insertColumnsAfter: function (afterCol, howMany) { maxColumns += Number(howMany) || 0; return sheet; },
    // v3：整欄刪除（與真的 Sheets 一樣，右邊的欄向左移；格式、註解、驗證跟住欄走）。
    deleteColumns: function (start, howMany) {
      faults.tick('deleteColumns');
      const n = Number(howMany) || 0;
      if (!(start >= 1) || n < 1 || start + n - 1 > maxColumns) {
        throw new Error('假替身：deleteColumns(' + start + ', ' + howMany + ') 超出範圍（分頁只有 ' + maxColumns + ' 欄）。');
      }
      data.forEach(function (row) { if (row.length >= start) row.splice(start - 1, n); });
      [numberFormats, notes, validations].forEach(function (map) {
        const moved = {};
        Object.keys(map).forEach(function (k) {
          const parts = k.split(':');
          const c = Number(parts[1]);
          if (c < start) moved[k] = map[k];
          else if (c >= start + n) moved[parts[0] + ':' + (c - n)] = map[k];
        });
        Object.keys(map).forEach(function (k) { delete map[k]; });
        Object.assign(map, moved);
      });
      maxColumns -= n;
      return sheet;
    },
    getFrozenRows: function () { return frozenRows; },
    setFrozenRows: function (n) { frozenRows = n; return sheet; },
    getFrozenColumns: function () { return frozenColumns; },
    setFrozenColumns: function (n) { frozenColumns = n; return sheet; },
    setColumnWidth: function () { return sheet; },
    hideSheet: function () { hidden = true; return sheet; },
    showSheet: function () { hidden = false; return sheet; },
    isSheetHidden: function () { return hidden; },
    // 真正的 getProtections() 回 Protection 物件（有 getDescription 等），不是記錄本身（與 fillEnv.js 一樣）。
    getProtections: function () { return protections.map(function (record) { return record.handle; }); },
    protect: function () {
      const record = { description: '', warningOnly: false, removed: false };
      protections.push(record);
      const p = {
        setDescription: function (d) { record.description = d; return p; },
        getDescription: function () { return record.description; },
        setWarningOnly: function (b) { record.warningOnly = b === true; return p; },
        isWarningOnly: function () { return record.warningOnly; },
        getEditors: function () { return []; },
        removeEditors: function () { return p; },
        addEditors: function () { return p; },
        canEdit: function () { return true; },
        remove: function () {
          const i = protections.indexOf(record);
          if (i !== -1) protections.splice(i, 1);
        }
      };
      record.handle = p;
      return p;
    },
    getRange: function (r, c, numRows, numCols) {
      numRows = numRows || 1;
      numCols = numCols || 1;
      checkBounds(r, c, numRows, numCols);
      const range = {
        getValues: function () {
          const out = [];
          for (let i = 0; i < numRows; i++) {
            const rowArr = [];
            for (let j = 0; j < numCols; j++) {
              const src = data[r - 1 + i];
              rowArr.push(src && src[c - 1 + j] !== undefined ? src[c - 1 + j] : '');
            }
            out.push(rowArr);
          }
          return out;
        },
        setValues: function (values) {
          faults.tick('setValue');
          if (values.length !== numRows || values.some(function (v) { return v.length !== numCols; })) {
            throw new Error('假替身：setValues() 的大小與範圍不符（範圍 ' + numRows + '×' + numCols + '）。');
          }
          for (let i = 0; i < values.length; i++) {
            while (data.length <= r - 1 + i) data.push([]);
            for (let j = 0; j < values[i].length; j++) {
              data[r - 1 + i][c - 1 + j] = writeCellLikeSheets(values[i][j], r + i, c + j, numberFormats, escapedValues);
            }
          }
          return range;
        },
        getValue: function () { const s = data[r - 1]; return s && s[c - 1] !== undefined ? s[c - 1] : ''; },
        setValue: function (v) {
          faults.tick('setValue');
          while (data.length <= r - 1) data.push([]);
          data[r - 1][c - 1] = writeCellLikeSheets(v, r, c, numberFormats, escapedValues);
          return range;
        },
        clearContent: function () {
          for (let i = 0; i < numRows; i++) {
            const src = data[r - 1 + i];
            if (src) for (let j = 0; j < numCols; j++) src[c - 1 + j] = '';
          }
          return range;
        },
        setNumberFormat: function (f) {
          for (let i = 0; i < numRows; i++) for (let j = 0; j < numCols; j++) numberFormats[(r + i) + ':' + (c + j)] = f;
          return range;
        },
        getNumberFormat: function () { return numberFormats[r + ':' + c] || 'General'; },
        setDataValidation: function (v) {
          for (let i = 0; i < numRows; i++) for (let j = 0; j < numCols; j++) validations[(r + i) + ':' + (c + j)] = v;
          return range;
        },
        clearDataValidations: function () {
          for (let i = 0; i < numRows; i++) for (let j = 0; j < numCols; j++) delete validations[(r + i) + ':' + (c + j)];
          return range;
        },
        setNote: function (t) { notes[r + ':' + c] = t; return range; },
        getNote: function () { return notes[r + ':' + c] || ''; },
        setWrap: function () { return range; },
        setFontWeight: function () { return range; },
        setBackground: function () { return range; },
        setFontColor: function () { return range; },
        setFontSize: function () { return range; },
        setHorizontalAlignment: function () { return range; },
        setVerticalAlignment: function () { return range; },
        merge: function () { return range; }
      };
      return range;
    }
  };
  return sheet;
}

/**
 * 用途：造一個假的內容表試算表。分頁按名字找（改名之後跟住新名字），支援插入、刪除、排序。
 * Args:
 *   spec {{id:string, url:string, tabs:Object[], faults:Object=}}
 *     `tabs` 是 `makeContentTab()` 造的分頁（次序就是分頁次序）；`faults` 是插入新分頁時用的計數器。
 * Returns:
 *   {Object} 假試算表；`__tabNames()` 回現時的分頁名稱次序。
 */
function makeContentSpreadsheet(spec) {
  let sheets = (spec.tabs || []).slice();
  let activeSheet = sheets[0] || null;
  const faults = spec.faults || makeContentFaults({});

  const ss = {
    getId: function () { return spec.id; },
    getUrl: function () { return spec.url; },
    getName: function () { return spec.name || '內容表'; },
    getSheetByName: function (name) {
      return sheets.filter(function (s) { return s.getName() === name; })[0] || null;
    },
    getSheets: function () { return sheets.slice(); },
    insertSheet: function (name) {
      if (ss.getSheetByName(name)) throw new Error('假替身：已經有一張分頁叫「' + name + '」。');
      const s = makeContentTab([], [], [], { name: name, faults: faults });
      s.__parent = ss;
      sheets.push(s);
      return s;
    },
    deleteSheet: function (sheet) {
      if (sheets.length <= 1) throw new Error('假替身：不可以刪走最後一張分頁。');
      sheets = sheets.filter(function (s) { return s !== sheet; });
    },
    setActiveSheet: function (s) { activeSheet = s; return s; },
    moveActiveSheet: function (pos) {
      const idx = sheets.indexOf(activeSheet);
      if (idx === -1) return;
      sheets.splice(idx, 1);
      sheets.splice(Math.max(0, pos - 1), 0, activeSheet);
    },
    __tabNames: function () { return sheets.map(function (s) { return s.getName(); }); }
  };
  sheets.forEach(function (s) { s.__parent = ss; });
  return ss;
}

module.exports = {
  DEFAULT_MAX_COLUMNS: DEFAULT_MAX_COLUMNS,
  makeContentFaults: makeContentFaults,
  makeContentTab: makeContentTab,
  makeContentSpreadsheet: makeContentSpreadsheet
};
