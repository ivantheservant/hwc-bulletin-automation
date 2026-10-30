#!/usr/bin/env node
/**
 * tests/contentsheet.test.js
 *
 * 內容表第一階段（R-010／R-013／R-014／R-015）的回歸測試。
 *
 * 內容表係**另一個試算表**，所以呢度要一個比其餘測試豐富好多嘅假替身：
 * 除咗讀寫格仔，仲要支援 `SpreadsheetApp.create()`／`openById()`、
 * `DriveApp` 建檔搬檔設權限、資料驗證下拉、儲存格格式與註解。
 *
 * ⚠️ 最重要嗰幾條係**冪等**（第 3、4、5 條）：重建會令堂委已經填好嘅嘢
 * 全部不見，所以「已經有就唔好再建立」係硬規則，唔係優化。
 *
 * 執行方式：node tests/contentsheet.test.js
 * 離開碼：0＝全部通過　1＝有測試失敗
 */

'use strict';

const assert = require('assert');
const { loadAllSrcFilesInOrder } = require('./helpers/loadGas');
const { makeFakeSheet, makeFakeSpreadsheet } = require('./helpers/fakeSpreadsheet');

const FAKE_ROSTER_ID = 'FAKE_ROSTER_ID_FOR_CONTENT_SHEET_TESTS';
const FAKE_FOLDER_ID = 'FAKE_CONTENT_FOLDER';
const QUARTER_ID = '2027T4';
const SERVICE_DATES = ['2027-11-07', '2027-11-14', '2027-11-21', '2027-11-28', '2027-12-05'];

let pass = 0;
let fail = 0;

function test(name, fn) {
  try {
    fn();
    pass++;
    console.log('  ✓ ' + name);
  } catch (err) {
    fail++;
    console.log('  ✗ ' + name);
    console.log('    ' + err.message);
  }
}

function assertArrayEqual(actual, expected, message) {
  assert.strictEqual(JSON.stringify(actual), JSON.stringify(expected), message);
}

// =====================================================================
// 假替身：一個「另一個試算表」要用到嘅全部 Sheets API
// =====================================================================

/**
 * 造一張功能齊備嘅假分頁：除咗值，仲要記低格式、下拉、註解、欄寬、
 * 換行——測試就係要驗證呢啲嘢有冇真係套落去。
 */
function makeRichSheet(name) {
  const data = [];
  const numberFormats = {};   // 'r,c' → format
  const validations = {};     // 'r,c' → validation
  const notes = {};           // 'r,c' → note
  const wraps = {};           // 'r,c' → boolean
  const columnWidths = {};
  let frozenRows = 0;
  let frozenColumns = 0;
  const hiddenColumns = {};
  // 內容表 v2 Commit 1：真的新分頁有 26 欄，超出就拋錯；可以隱藏、可以保護（移轉要用）。
  let maxColumns = 26;
  let hidden = false;
  const protections = [];

  function ensureCell(r, c) {
    while (data.length < r) data.push([]);
    const row = data[r - 1];
    while (row.length < c) row.push('');
  }

  const sheet = {
    __name: name,
    __data: data,
    __numberFormats: numberFormats,
    __validations: validations,
    __notes: notes,
    __wraps: wraps,
    __columnWidths: columnWidths,
    getName: function () { return sheet.__name; },
    setName: function (n) { sheet.__name = n; return sheet; },
    getLastRow: function () {
      for (let r = data.length; r >= 1; r--) {
        const row = data[r - 1] || [];
        if (row.some(function (v) { return v !== '' && v !== null && v !== undefined; })) return r;
      }
      return 0;
    },
    getLastColumn: function () {
      let max = 0;
      data.forEach(function (row) {
        for (let c = row.length; c >= 1; c--) {
          if (row[c - 1] !== '' && row[c - 1] !== null && row[c - 1] !== undefined) { max = Math.max(max, c); break; }
        }
      });
      return max;
    },
    getMaxRows: function () { return Math.max(data.length, 1000); },
    getMaxColumns: function () { return maxColumns; },
    insertColumnsAfter: function (afterCol, howMany) { maxColumns += Number(howMany) || 0; return sheet; },
    getFrozenRows: function () { return frozenRows; },
    setFrozenRows: function (n) { frozenRows = n; return sheet; },
    getFrozenColumns: function () { return frozenColumns; },
    setFrozenColumns: function (n) { frozenColumns = n; return sheet; },
    // 2026-10-30：崇拜人數日子橫放，機器鍵欄（B）隱藏。
    hideColumns: function (col, n) { for (let i = 0; i < (n || 1); i++) hiddenColumns[col + i] = true; return sheet; },
    isColumnHiddenByUser: function (col) { return hiddenColumns[col] === true; },
    setColumnWidth: function (col, width) { columnWidths[col] = width; return sheet; },
    getColumnWidth: function (col) { return columnWidths[col] || 100; },
    hideSheet: function () { hidden = true; return sheet; },
    showSheet: function () { hidden = false; return sheet; },
    isSheetHidden: function () { return hidden; },
    __protections: protections,
    // v4（2026-10-30）：getProtections() 回 Protection 物件（與真的一樣），記錄在 __protections。
    getProtections: function () { return protections.map(function (record) { return record.handle; }); },
    protect: function () {
      const record = { description: '', warningOnly: false, unprotected: [], domainEdit: true };
      protections.push(record);
      const p = {
        setDescription: function (d) { record.description = d; return p; },
        getDescription: function () { return record.description; },
        setWarningOnly: function (b) { record.warningOnly = b === true; return p; },
        isWarningOnly: function () { return record.warningOnly; },
        getEditors: function () { return []; },
        removeEditors: function () { return p; },
        addEditors: function () { return p; },
        addEditor: function () { return p; },
        canDomainEdit: function () { return record.domainEdit; },
        setDomainEdit: function (b) { record.domainEdit = b === true; return p; },
        setUnprotectedRanges: function (ranges) { record.unprotected = (ranges || []).slice(); return p; },
        canEdit: function () { return true; },
        remove: function () { const i = protections.indexOf(record); if (i !== -1) protections.splice(i, 1); }
      };
      record.handle = p;
      return p;
    },
    getRange: function (r, c, numRows, numCols) {
      numRows = numRows || 1;
      numCols = numCols || 1;
      if (c + numCols - 1 > maxColumns) {
        throw new Error('假替身：範圍超出分頁「' + sheet.__name + '」的欄數（要到第 ' + (c + numCols - 1)
          + ' 欄，分頁只有 ' + maxColumns + ' 欄）。');
      }
      const range = {
        getRow: function () { return r; },
        getColumn: function () { return c; },
        getNumRows: function () { return numRows; },
        getNumColumns: function () { return numCols; },
        // v4：按一欄排序（每晚排序用排名欄）。
        sort: function (spec) {
          const col = typeof spec === 'number' ? spec : spec.column;
          const idx = [];
          for (let i = 0; i < numRows; i++) idx.push(i);
          const keyOf = function (i) { const src = data[r - 1 + i]; return src ? src[col - 1] : ''; };
          idx.sort(function (a, b) {
            const ka = keyOf(a); const kb = keyOf(b);
            if (ka === kb) return a - b;
            if (ka === '' || ka === undefined) return 1;
            if (kb === '' || kb === undefined) return -1;
            return ka < kb ? -1 : 1;
          });
          const rows = idx.map(function (i) { return (data[r - 1 + i] || []).slice(); });
          rows.forEach(function (rowArr, i) {
            ensureCell(r + i, c + numCols - 1);
            for (let j = 0; j < numCols; j++) data[r - 1 + i][c - 1 + j] = rowArr[c - 1 + j] === undefined ? '' : rowArr[c - 1 + j];
          });
          return range;
        },
        getValues: function () {
          const out = [];
          for (let i = 0; i < numRows; i++) {
            const row = [];
            for (let j = 0; j < numCols; j++) {
              const src = data[r - 1 + i];
              row.push(src && src[c - 1 + j] !== undefined ? src[c - 1 + j] : '');
            }
            out.push(row);
          }
          return out;
        },
        setValues: function (values) {
          for (let i = 0; i < values.length; i++) {
            for (let j = 0; j < values[i].length; j++) {
              ensureCell(r + i, c + j);
              data[r + i - 1][c + j - 1] = values[i][j];
            }
          }
          return range;
        },
        getValue: function () {
          const src = data[r - 1];
          return src && src[c - 1] !== undefined ? src[c - 1] : '';
        },
        setValue: function (v) { ensureCell(r, c); data[r - 1][c - 1] = v; return range; },
        clearContent: function () {
          for (let i = 0; i < numRows; i++) {
            const src = data[r - 1 + i];
            if (src) for (let j = 0; j < numCols; j++) src[c - 1 + j] = '';
          }
          return range;
        },
        setNumberFormat: function (f) {
          for (let i = 0; i < numRows; i++) for (let j = 0; j < numCols; j++) numberFormats[(r + i) + ',' + (c + j)] = f;
          return range;
        },
        setDataValidation: function (v) {
          for (let i = 0; i < numRows; i++) for (let j = 0; j < numCols; j++) validations[(r + i) + ',' + (c + j)] = v;
          return range;
        },
        clearDataValidations: function () {
          for (let i = 0; i < numRows; i++) for (let j = 0; j < numCols; j++) delete validations[(r + i) + ',' + (c + j)];
          return range;
        },
        setNote: function (t) { notes[r + ',' + c] = t; return range; },
        getNote: function () { return notes[r + ',' + c] || ''; },
        setWrap: function (b) {
          for (let i = 0; i < numRows; i++) for (let j = 0; j < numCols; j++) wraps[(r + i) + ',' + (c + j)] = b;
          return range;
        },
        setFontWeight: function () { return range; },
        setBackground: function () { return range; },
        setFontColor: function () { return range; },
        setFontSize: function () { return range; },
        merge: function () { return range; }
      };
      return range;
    }
  };
  return sheet;
}

/** 造一個假嘅「內容表」試算表（支援插入／刪除／排序分頁）。 */
function makeFakeContentSpreadsheet(id, url) {
  let sheets = [makeRichSheet('Sheet1')]; // 模擬 Google 建立時嗰張預設空白分頁
  let activeSheet = sheets[0];

  const ss = {
    __sheets: sheets,
    getId: function () { return id; },
    getUrl: function () { return url; },
    getName: function () { return '內容表'; },
    getSheetByName: function (name) {
      return sheets.filter(function (s) { return s.getName() === name; })[0] || null;
    },
    getSheets: function () { return sheets.slice(); },
    insertSheet: function (name) {
      const s = makeRichSheet(name);
      sheets.push(s);
      return s;
    },
    deleteSheet: function (sheet) {
      if (sheets.length <= 1) throw new Error('不可以刪走最後一張分頁');
      sheets = sheets.filter(function (s) { return s !== sheet; });
      ss.__sheets = sheets;
    },
    setActiveSheet: function (s) { activeSheet = s; return s; },
    moveActiveSheet: function (pos) {
      const idx = sheets.indexOf(activeSheet);
      if (idx === -1) return;
      sheets.splice(idx, 1);
      sheets.splice(Math.max(0, pos - 1), 0, activeSheet);
      ss.__sheets = sheets;
    },
    __tabNames: function () { return sheets.map(function (s) { return s.getName(); }); }
  };
  return ss;
}

/**
 * 造一個完整測試環境。
 * options：
 *   config          覆寫 Config
 *   weekRows        BulletinWeeks 資料（預設本季五個主日）
 *   serviceDates    職事表本季主日
 *   recipients      Recipients 資料
 *   contentSheets   ContentSheets 現有資料
 *   folderMissing   true → DriveApp.getFolderById 拋錯
 *   todayIso        「今日」（自動提前寄那幾條要用）
 */
function makeEnv(options) {
  const o = options || {};
  const todayIso = o.todayIso || '2027-11-01';
  const boot = loadAllSrcFilesInOrder(baseStubs(todayIso));

  const cfg = {};
  boot.DEFAULTS.forEach(function (d) { cfg[d.key] = d.value; });
  cfg.ROSTER_SPREADSHEET_ID = FAKE_ROSTER_ID;
  cfg.CONTENT_SHEET_FOLDER_ID = FAKE_FOLDER_ID;
  cfg.CONTENT_SHEET_ADMIN_CONTACT = '幹事（測試用聯絡方法）';
  // ⚠️ 網域喺 DEFAULTS 係空字串（唔可以寫死真實網域），所以測試自己填一個
  // 假嘅——測試要驗證嘅係「有填就設 DOMAIN 權限」。
  cfg.CONTENT_SHEET_DOMAIN = 'example.invalid';
  Object.assign(cfg, o.config || {});

  function ownSheet(sheetId, rows) {
    const def = boot.COLUMNS[sheetId];
    return makeFakeSheet(def.headers, def.keys, rows || []);
  }

  const serviceDates = o.serviceDates || SERVICE_DATES;

  const ownSheets = {};
  Object.keys(boot.SHEETS).forEach(function (id) { ownSheets[boot.SHEETS[id]] = ownSheet(id, []); });
  ownSheets.Config = ownSheet('CONFIG', Object.keys(cfg).map(function (k) {
    return { KEY: k, VALUE: cfg[k], NOTE: '', EDITABLE: true };
  }));
  ownSheets.BulletinWeeks = ownSheet('BULLETIN_WEEKS', o.weekRows || serviceDates.map(function (iso, i) {
    return { SERVICE_DATE: iso, QUARTER_ID: QUARTER_ID, WEEK_OF_MONTH: (i % 4) + 1, STATUS: 'DRAFT' };
  }));
  ownSheets.ContentSheets = ownSheet('CONTENT_SHEETS', o.contentSheets || []);
  ownSheets.Recipients = ownSheet('RECIPIENTS', o.recipients || [
    { RECIPIENT_ID: 'R1', NAME: '假甲', EMAIL: 'cc@x.com', GROUP_NAME: 'CC', ACTIVE: true, EFFECTIVE_FROM: '', EFFECTIVE_TO: '', NOTES: '' },
    { RECIPIENT_ID: 'R2', NAME: '假乙', EMAIL: 'db@x.com', GROUP_NAME: 'DB', ACTIVE: true, EFFECTIVE_FROM: '', EFFECTIVE_TO: '', NOTES: '' }
  ]);

  function rosterSheet(defKey, rows) {
    const keys = Object.keys(boot.ROSTER_TABLE_DEFS_[defKey].columns).concat(Object.keys(boot.ROSTER_TABLE_DEFS_[defKey].optionalColumns || {}));
    return makeFakeSheet(keys, keys, rows || []);
  }

  const rosterSheets = {
    RosterAssignments: rosterSheet('ASSIGNMENTS', []),
    RosterVersions: rosterSheet('VERSIONS', [{ QuarterID: QUARTER_ID, VersionNo: 1 }]),
    Quarters: rosterSheet('QUARTERS', [{ QuarterID: QUARTER_ID, Stage: 'OFFICIAL_SENT' }]),
    ServiceDates: rosterSheet('SERVICE_DATES', serviceDates.map(function (iso, i) {
      return {
        ServiceDateID: 'SD' + (i + 1), QuarterID: QUARTER_ID, ServiceDate: iso,
        WeekIndex: i + 1, IsFirstSundayOfMonth: i === 0, ServiceType: '主日崇拜', SpecialID: ''
      };
    })),
    NameMapping: rosterSheet('NAME_MAPPING', []),
    Posts: rosterSheet('POSTS', [])
  };

  // ---- 內容表（另一個試算表）----
  const createdSpreadsheets = {};
  let createdCount = 0;
  const driveFiles = {};

  const FakeDriveApp = {
    Access: { DOMAIN: 'DOMAIN', ANYONE_WITH_LINK: 'ANYONE_WITH_LINK' },
    Permission: { EDIT: 'EDIT', VIEW: 'VIEW' },
    getFileById: function (fileId) {
      if (!driveFiles[fileId]) driveFiles[fileId] = { movedTo: null, sharing: null };
      const rec = driveFiles[fileId];
      return {
        moveTo: function (folder) { rec.movedTo = folder.__id; return this; },
        setSharing: function (access, permission) { rec.sharing = { access: access, permission: permission }; return this; },
        getId: function () { return fileId; }
      };
    },
    getFolderById: function (folderId) {
      if (o.folderMissing) throw new Error('假的：揾唔到資料夾 ' + folderId);
      return { __id: folderId, getId: function () { return folderId; } };
    }
  };

  const mail = { calls: [], sendEmail: function (m) { mail.calls.push(m); }, getRemainingDailyQuota: function () { return 1000; } };

  const uiPrompts = [];
  const uiAlerts = [];

  const FakeSpreadsheetApp = {
    getActiveSpreadsheet: function () { return makeFakeSpreadsheet(ownSheets); },
    openById: function (id) {
      if (id === FAKE_ROSTER_ID) return makeFakeSpreadsheet(rosterSheets);
      if (createdSpreadsheets[id]) return createdSpreadsheets[id];
      throw new Error('openById: 揾唔到 ' + id);
    },
    create: function (name) {
      createdCount++;
      const id = 'CONTENT_FILE_' + createdCount;
      const ss = makeFakeContentSpreadsheet(id, 'https://docs.google.com/spreadsheets/d/' + id + '/edit');
      ss.__name = name;
      ss.getName = function () { return name; };
      createdSpreadsheets[id] = ss;
      return ss;
    },
    newDataValidation: function () {
      const builder = {
        __values: null, __allowInvalid: true,
        requireValueInList: function (values) { builder.__values = values.slice(); return builder; },
        setAllowInvalid: function (b) { builder.__allowInvalid = b; return builder; },
        build: function () {
          return {
            __values: builder.__values,
            __allowInvalid: builder.__allowInvalid,
            getCriteriaValues: function () { return [builder.__values]; }
          };
        }
      };
      return builder;
    },
    ProtectionType: { SHEET: 'SHEET' },
    getUi: function () {
      return {
        createMenu: function () {
          const menu = {
            addItem: function () { return menu; }, addSeparator: function () { return menu; },
            addSubMenu: function () { return menu; }, addToUi: function () { return menu; }
          };
          return menu;
        },
        // 內容表 v2：「建立本季內容表」選單先預覽再問「是／否」；預設答「是」（o.uiConfirm 可以改）。
        alert: function (a, b, buttons) {
          uiAlerts.push({ title: a, body: b });
          return buttons === 'YES_NO' ? (o.uiConfirm === undefined ? 'YES' : o.uiConfirm) : 'OK';
        },
        prompt: function (title) {
          uiPrompts.push(title);
          return {
            getSelectedButton: function () { return o.uiButton === undefined ? 'OK' : o.uiButton; },
            getResponseText: function () { return o.uiText === undefined ? QUARTER_ID : o.uiText; }
          };
        },
        showModalDialog: function () {},
        ButtonSet: { OK: 'OK', OK_CANCEL: 'OK_CANCEL', YES_NO: 'YES_NO' },
        Button: { OK: 'OK', CANCEL: 'CANCEL', YES: 'YES', NO: 'NO' }
      };
    }
  };

  const sandbox = loadAllSrcFilesInOrder(Object.assign({}, baseStubs(todayIso), {
    SpreadsheetApp: FakeSpreadsheetApp,
    DriveApp: FakeDriveApp,
    MailApp: mail,
    ScriptApp: { getProjectTriggers: function () { return []; } }
  }));

  return {
    sandbox: sandbox, sheets: ownSheets, mail: mail,
    createdSpreadsheets: createdSpreadsheets, driveFiles: driveFiles,
    uiAlerts: uiAlerts, uiPrompts: uiPrompts,
    contentSpreadsheet: function () {
      const ids = Object.keys(createdSpreadsheets);
      return ids.length > 0 ? createdSpreadsheets[ids[ids.length - 1]] : null;
    }
  };
}

function baseStubs(todayIso) {
  return {
    Utilities: {
      formatDate: function (date, tz, pattern) {
        // 「今日」固定成測試指定嗰日，令自動提前寄嗰幾條測得準。
        if (String(pattern) === 'yyyy-MM-dd') return todayIso;
        const y = date.getFullYear();
        const mo = String(date.getMonth() + 1).padStart(2, '0');
        const d = String(date.getDate()).padStart(2, '0');
        return `${y}-${mo}-${d}`;
      }
    },
    Session: {
      getScriptTimeZone: function () { return 'Pacific/Auckland'; },
      getActiveUser: function () { return { getEmail: function () { return 'tester@x.com'; } }; },
      getEffectiveUser: function () { return { getEmail: function () { return 'tester@x.com'; } }; }
    },
    CacheService: {}, HtmlService: {}
  };
}

/** 由假分頁讀返第 r 行、第 c 欄（1 起算）。 */
function cell(sheet, r, c) {
  const row = sheet.__data[r - 1];
  return row && row[c - 1] !== undefined ? row[c - 1] : '';
}

/** 讀第 r 行頭 n 欄。 */
function row(sheet, r, n) {
  const out = [];
  for (let c = 1; c <= n; c++) out.push(cell(sheet, r, c));
  return out;
}

/**
 * 判斷一個值係咪 Date。
 *
 * ⚠️ **唔可以用 `instanceof Date`**：值係喺 vm sandbox 嗰個 realm 造出嚟，
 * 同測試自己嗰個 realm 唔係同一個 `Date` 建構子，`instanceof` 一定 false
 * （見 tests/helpers/fakeSpreadsheet.js 檔頭嘅說明）。
 */
function isDate(v) {
  return Object.prototype.toString.call(v) === '[object Date]';
}

/**
 * 清走「同一次執行內」嘅快取，模擬 Apps Script 下一次執行。
 *
 * ⚠️ 職事表資料喺同一次執行內係 memoize 嘅（`fetchRosterTablesCached_()`），
 * 真實情況下兩次撳選單係兩次獨立執行，所以測試「季度多咗一個主日」嗰陣
 * 一定要清返快取，否則第二次讀返嘅仍然係舊資料。
 */
function nextExecution(env) {
  env.sandbox.ROSTER_TABLES_CACHE_ = null;
  env.sandbox.ROSTER_TABLES_CACHE_KEY_ = null;
  env.sandbox.clearConfigCache_();
}

// =====================================================================
// 1-2. 建立：分頁齊備、標題正確
// =====================================================================

test('1. 建立：六張表加 _說明 都在，次序正確（內容表 v2）', function () {
  const env = makeEnv({});
  const result = env.sandbox.buildOrRefreshContentSheet_(QUARTER_ID);
  assert.strictEqual(result.ok, true, JSON.stringify(result));
  assert.strictEqual(result.created, true);

  assertArrayEqual(
    env.contentSpreadsheet().__tabNames(),
    // 內容表 v2（決定 7）：「宣召」「浸禮合堂」併入「崇拜程序」，崇拜程序排第一。
    ['_說明', '崇拜程序', '家事報告', '代禱事項', '團契聚會', '財政報告', '崇拜人數'],
    '分頁次序要同 contentSheetTabNames_() 一致，而且預設嗰張 Sheet1 要被清走'
  );
});

test('2. 建立：每張表第 1、2 行正確，資料由第 3 行開始', function () {
  const env = makeEnv({ config: { CONTENT_SHEET_SEED_SAMPLE: 'FALSE' } });
  env.sandbox.buildOrRefreshContentSheet_(QUARTER_ID);
  const ss = env.contentSpreadsheet();

  env.sandbox.contentSheetTabDefs_().forEach(function (def) {
    const sheet = ss.getSheetByName(def.tabName);
    assert.ok(sheet, def.tabName + ' 應該存在');
    if (def.transposed === true) {
      // 2026-10-30（Ivan）：「崇拜人數」日子橫放：A 欄中文標題、B 欄機器鍵（隱藏）、第 1 行 C 起＝每一個崇拜日期。
      const tkeys = env.sandbox.transposedContentKeys_(def);
      const theaders = env.sandbox.transposedContentHeaders_(def);
      assert.strictEqual(tkeys.indexOf('ACTIVE'), -1, '橫放的分頁沒有「有效」');
      assertArrayEqual(Array.from(sheet.__data.slice(0, tkeys.length).map(function (r) { return r[0]; })), theaders, def.tabName + ' 第 A 欄');
      assertArrayEqual(Array.from(sheet.__data.slice(0, tkeys.length).map(function (r) { return r[1]; })), tkeys, def.tabName + ' 第 B 欄');
      assert.strictEqual(sheet.getFrozenRows(), 1, def.tabName + ' 應該凍結第 1 行');
      assert.strictEqual(sheet.getFrozenColumns(), 2, def.tabName + ' 應該凍結 A、B 欄');
      assert.strictEqual(sheet.isColumnHiddenByUser(2), true, def.tabName + ' 機器鍵欄要隱藏');
      assert.strictEqual(sheet.getLastColumn(), 2 + SERVICE_DATES.length, def.tabName + ' 每個主日一欄');
      return;
    }
    assertArrayEqual(row(sheet, 1, def.headers.length), def.headers, def.tabName + ' 第 1 行');
    assertArrayEqual(row(sheet, 2, def.keys.length), def.keys, def.tabName + ' 第 2 行');
    assert.strictEqual(sheet.getFrozenRows(), 2, def.tabName + ' 應該凍結頭兩行');
    // 內容表 v2：「崇拜程序」每個主日預先開好一行（由週報帶入現有的值），其餘冇樣本就冇資料。
    // 內容表 v4（2026-10-30）：「崇拜人數」亦一個日期一行預先開好（崇拜日期＝每個主日減七天）。
    const expectedLastRow = def.oneRowPerDate === true ? 2 + SERVICE_DATES.length : 2;
    assert.strictEqual(sheet.getLastRow(), expectedLastRow, def.tabName + ' 第 3 行起的資料行數');
  });
});

test('M11（內容表 v2）新建：「崇拜程序」每個主日一行、值由週報帶入、備註留空；沒有宣召／浸禮合堂分頁；冇宣召樣本', function () {
  const env = makeEnv({
    config: { CONTENT_SHEET_SEED_SAMPLE: 'TRUE' },
    weekRows: SERVICE_DATES.map(function (iso, i) {
      return { SERVICE_DATE: iso, QUARTER_ID: QUARTER_ID, WEEK_OF_MONTH: i + 1, STATUS: 'DRAFT', PRELUDE: '預設序樂', SERMON_TITLE: i === 0 ? '第一週講題' : '' };
    })
  });
  const result = env.sandbox.buildOrRefreshContentSheet_(QUARTER_ID);
  assert.strictEqual(result.ok, true, JSON.stringify(result));
  const ss = env.contentSpreadsheet();
  assert.strictEqual(ss.getSheetByName('宣召'), null);
  assert.strictEqual(ss.getSheetByName('浸禮合堂'), null);
  const def = env.sandbox.contentSheetWorshipTabDef_();
  const sheet = ss.getSheetByName('崇拜程序');
  assert.strictEqual(sheet.getLastRow(), 2 + SERVICE_DATES.length);
  SERVICE_DATES.forEach(function (iso, i) {
    const r = 3 + i;
    assert.strictEqual(cell(sheet, r, 1), iso, '第 ' + r + ' 行的主日');
    assert.strictEqual(cell(sheet, r, def.keys.indexOf('NOTES') + 1), '', '新建內容表不寫「系統移轉建立」');
  });
  // 內容表 v4（2026-10-30）：序樂、宣召不在內容表（改在填寫介面填）。
  assert.strictEqual(def.keys.indexOf('PRELUDE'), -1);
  assert.strictEqual(def.keys.indexOf('CALL_REF'), -1);
  assert.strictEqual(cell(sheet, 3, def.keys.indexOf('SERMON_TITLE') + 1), '第一週講題');
  assert.ok(sheet.__protections.some(function (p) { return p.description.indexOf('日期欄與標題鎖住') !== -1 && p.warningOnly === false; }),
    '日期欄鎖住、不可以插入行');
  const text = env.sandbox.buildContentSheetResultLines_(result).join('\n');
  assert.ok(text.indexOf('「崇拜程序」已一個主日一行預先開好（' + SERVICE_DATES.length + ' 行）') !== -1, text);
});

// =====================================================================
// 3-5. 冪等
// =====================================================================

test('3. 冪等：跑第二次唔重建，只補欄位，回報「已更新，未重建」', function () {
  const env = makeEnv({});
  const first = env.sandbox.buildOrRefreshContentSheet_(QUARTER_ID);
  assert.strictEqual(first.created, true);

  const second = env.sandbox.buildOrRefreshContentSheet_(QUARTER_ID);
  assert.strictEqual(second.ok, true, JSON.stringify(second));
  assert.strictEqual(second.created, false, '第二次一定唔可以重建');
  assert.strictEqual(second.fileId, first.fileId, '要沿用同一個檔案');
  assert.strictEqual(Object.keys(env.createdSpreadsheets).length, 1, '只可以建立過一次');

  const lines = env.sandbox.buildContentSheetResultLines_(second);
  assert.ok(lines.join('\n').indexOf('已更新，未重建') !== -1, lines.join('\n'));
});

test('4. 冪等：第二次跑之後，人手輸入嘅資料一格都冇變', function () {
  const env = makeEnv({ config: { CONTENT_SHEET_SEED_SAMPLE: 'FALSE' } });
  env.sandbox.buildOrRefreshContentSheet_(QUARTER_ID);

  const sheet = env.contentSpreadsheet().getSheetByName('家事報告');
  // 內容表 v4：主日日期、連續到、有效、次序、內容。
  sheet.getRange(3, 1, 1, 5).setValues([['2027-11-14', '', 'TRUE', 10, '堂委親手打嘅報告']]);
  const before = JSON.stringify(row(sheet, 3, 5));

  env.sandbox.buildOrRefreshContentSheet_(QUARTER_ID);

  assert.strictEqual(JSON.stringify(row(sheet, 3, 5)), before,
    '刷新之後人手嘅資料一定要原封不動——重做會令堂委填好嘅嘢不見');
});

test('5. 季度多咗一個主日 → 下拉選單跟住更新，舊資料唔郁', function () {
  const env = makeEnv({ config: { CONTENT_SHEET_SEED_SAMPLE: 'FALSE' } });
  env.sandbox.buildOrRefreshContentSheet_(QUARTER_ID);

  // 內容表 v2：「宣召」分頁已併入「崇拜程序」，改用「家事報告」驗同一件事。
  const sheet = env.contentSpreadsheet().getSheetByName('家事報告');
  sheet.getRange(3, 1, 1, 5).setValues([['2027-11-07', '', 'TRUE', 10, '測試報告']]);

  // 職事表加多一個主日。
  const roster = env.sandbox.SpreadsheetApp.openById(FAKE_ROSTER_ID).getSheetByName('ServiceDates');
  roster.getRange(3 + SERVICE_DATES.length, 1, 1, 7)
    .setValues([['SD99', QUARTER_ID, '2027-12-12', 6, false, '主日崇拜', '']]);

  nextExecution(env); // 真實情況下，第二次撳選單係另一次執行
  env.sandbox.buildOrRefreshContentSheet_(QUARTER_ID);

  const validation = sheet.__validations['3,1'];
  assert.ok(validation, '主日日期欄應該有下拉');
  assert.ok(validation.__values.indexOf('2027-12-12') !== -1,
    '新增嘅主日要出現喺下拉：' + JSON.stringify(validation.__values));
  assertArrayEqual(row(sheet, 3, 5), ['2027-11-07', '', 'TRUE', 10, '測試報告'], '舊資料唔可以郁');
  // 新增嘅主日喺「崇拜程序」亦預先開好一行（其他主日嘅行一格都唔郁）。
  const worship = env.contentSpreadsheet().getSheetByName('崇拜程序');
  assert.strictEqual(worship.getLastRow(), 2 + SERVICE_DATES.length + 1);
  assert.strictEqual(cell(worship, 2 + SERVICE_DATES.length + 1, 1), '2027-12-12');
});

// =====================================================================
// 6-8. 下拉與格式
// =====================================================================

test('6. 崇拜人數預先開好的日期包含「第一個主日減七天」（2026-10-30：日子橫放，第 1 行 C 起，鎖住，不再有下拉）', function () {
  const env = makeEnv({});
  env.sandbox.buildOrRefreshContentSheet_(QUARTER_ID);
  const sheet = env.contentSpreadsheet().getSheetByName('崇拜人數');
  assert.strictEqual(sheet.__validations['1,3'], undefined, '日期由系統填好並鎖住，不用下拉');
  const dates = sheet.__data[0].slice(2).map(function (v) { return String(v || ''); }).filter(Boolean);
  assert.strictEqual(dates[0], '2027-10-31',
    '第一個主日 2027-11-07 減七天＝2027-10-31，否則該季第一期嘅人數無處可填');
  assert.strictEqual(dates.length, SERVICE_DATES.length);
  // 同工只可以改 C2 起的人數格（日期、標題、機器鍵鎖住）。
  const lock = sheet.__protections.filter(function (p) { return p.description === env.sandbox.CONTENT_SHEET_V4_LOCK_DESCRIPTION_; });
  assert.strictEqual(lock.length, 1, '整張分頁要保護');
  const free = lock[0].unprotected.map(function (r) { return [r.getRow(), r.getColumn(), r.getNumRows(), r.getNumColumns()]; });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(free)), [[2, 3, 12, SERVICE_DATES.length]], '只可以改 C2 起十二行 × 每個日期欄');
});

test('7. 「日期」「時間」「五個數字欄」「十二個人數格」嘅儲存格格式係純文字', function () {
  const env = makeEnv({});
  env.sandbox.buildOrRefreshContentSheet_(QUARTER_ID);
  const ss = env.contentSpreadsheet();

  const fellowship = ss.getSheetByName('團契聚會');
  const fKeys = env.sandbox.contentSheetTabDefs_().filter(function (d) { return d.tabName === '團契聚會'; })[0].keys;
  ['DATE_TEXT', 'TIME_TEXT'].forEach(function (k) {
    const col = fKeys.indexOf(k) + 1;
    assert.strictEqual(fellowship.__numberFormats['3,' + col], '@', k + ' 一定要純文字（4:30pm 唔可以變時間）');
  });

  const finance = ss.getSheetByName('財政報告');
  const finKeys = env.sandbox.contentSheetTabDefs_().filter(function (d) { return d.tabName === '財政報告'; })[0].keys;
  ['COL1', 'COL2', 'COL3', 'COL4'].forEach(function (k) {
    const col = finKeys.indexOf(k) + 1;
    assert.strictEqual(finance.__numberFormats['3,' + col], '@', k + ' 一定要純文字（$3,491.40、-- 都要原樣）');
  });

  // 2026-10-30：崇拜人數日子橫放——每一個人數格（第 2 至 13 行 × 每個日期欄）都是純文字。
  const attendance = ss.getSheetByName('崇拜人數');
  const attDef = env.sandbox.contentSheetTabDefs_().filter(function (d) { return d.tabName === '崇拜人數'; })[0];
  const attKeys = env.sandbox.transposedContentKeys_(attDef);
  const attRows = attKeys.filter(function (k) { return /^ATT_/.test(k); });
  assert.strictEqual(attRows.length, 12);
  attRows.forEach(function (k) {
    const r = attKeys.indexOf(k) + 1;
    [3, 2 + SERVICE_DATES.length].forEach(function (c) {
      assert.strictEqual(attendance.__numberFormats[r + ',' + c], '@', k + ' 第 ' + c + ' 欄一定要純文字');
    });
  });
});

test('8. 下拉選單拒絕清單以外嘅日期（setAllowInvalid(false)）', function () {
  const env = makeEnv({});
  env.sandbox.buildOrRefreshContentSheet_(QUARTER_ID);
  const sheet = env.contentSpreadsheet().getSheetByName('家事報告');

  assert.strictEqual(sheet.__validations['3,1'].__allowInvalid, false,
    '主日日期手打錯一個字就成行匯入唔到，所以要硬擋');
  // 「連續到」一樣要下拉（內容表 v4：第 B 欄）。
  assert.ok(sheet.__validations['3,2'], '「連續到」欄一樣要有下拉');
  assert.strictEqual(sheet.__validations['3,2'].__allowInvalid, false);
});

test('8b. 「有效」欄有 TRUE／FALSE 下拉', function () {
  const env = makeEnv({});
  env.sandbox.buildOrRefreshContentSheet_(QUARTER_ID);
  // 內容表 v4：「崇拜程序」冇「有效」；改用「家事報告」（「有效」係第 C 欄）。
  const sheet = env.contentSpreadsheet().getSheetByName('家事報告');
  const validation = sheet.__validations['3,3'];
  assert.ok(validation);
  assertArrayEqual(validation.__values, ['TRUE', 'FALSE']);
});

test('8c. 每張表預留 200 行下拉，唔係只做到有資料嗰幾行', function () {
  const env = makeEnv({});
  env.sandbox.buildOrRefreshContentSheet_(QUARTER_ID);
  const sheet = env.contentSpreadsheet().getSheetByName('家事報告');
  assert.ok(sheet.__validations['202,1'], '第 202 行（第 200 行資料）一樣要有下拉');
  assert.ok(!sheet.__validations['203,1'], '唔應該去到第 203 行');
});

// =====================================================================
// 9-12. 設定、樣本、權限
// =====================================================================

test('9. CONTENT_SHEET_FOLDER_ID 空白 → 明確錯誤訊息，唔拋原始例外', function () {
  const env = makeEnv({ config: { CONTENT_SHEET_FOLDER_ID: '' } });
  let result;
  assert.doesNotThrow(function () { result = env.sandbox.buildOrRefreshContentSheet_(QUARTER_ID); });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'NO_FOLDER_ID');
  assert.ok(result.message.indexOf('CONTENT_SHEET_FOLDER_ID') !== -1,
    '要講明缺咗邊個設定鍵：' + result.message);
  assert.strictEqual(Object.keys(env.createdSpreadsheets).length, 0, '唔應該建立任何檔案');
});

test('10. CONTENT_SHEET_SEED_SAMPLE=FALSE → 唔填樣本', function () {
  const env = makeEnv({ config: { CONTENT_SHEET_SEED_SAMPLE: 'FALSE' } });
  const result = env.sandbox.buildOrRefreshContentSheet_(QUARTER_ID);
  assert.strictEqual(result.seededSample, false);
  assert.strictEqual(env.contentSpreadsheet().getSheetByName('家事報告').getLastRow(), 2);
});

test('11. 樣本嘅「連續到」指向該季第四個主日', function () {
  const env = makeEnv({});
  const result = env.sandbox.buildOrRefreshContentSheet_(QUARTER_ID);
  assert.strictEqual(result.seededSample, true);

  const sheet = env.contentSpreadsheet().getSheetByName('家事報告');
  assert.strictEqual(sheet.getLastRow(), 5, '三行樣本，由第 3 行開始');
  // 內容表 v4：「連續到」第 B 欄、「有效」第 C 欄。
  assert.strictEqual(cell(sheet, 5, 2), SERVICE_DATES[3], '第三行示範連登四週');
  assert.strictEqual(cell(sheet, 3, 2), '', '頭兩行冇「連續到」');
  assert.strictEqual(cell(sheet, 3, 3), true, '樣本嘅「有效」要係 TRUE');
});

test('11b. 樣本：崇拜人數填喺第一個主日減七天、財政都有；內容表 v2 起冇宣召樣本', function () {
  const env = makeEnv({});
  env.sandbox.buildOrRefreshContentSheet_(QUARTER_ID);
  const ss = env.contentSpreadsheet();

  // 2026-10-30：崇拜人數日子橫放，每個崇拜日期一欄預先開好（C1＝第一個主日減七天），唔再寫樣本數字。
  assert.strictEqual(cell(ss.getSheetByName('崇拜人數'), 1, 3), '2027-10-31');
  assert.strictEqual(cell(ss.getSheetByName('崇拜人數'), 2, 3), '');
  assert.strictEqual(ss.getSheetByName('宣召'), null, '內容表 v2：冇「宣召」分頁');
  assert.strictEqual(env.sandbox.contentSheetWorshipTabDef_().keys.indexOf('CALL_REF'), -1, '內容表 v4：宣召改在介面填');
  assert.strictEqual(ss.getSheetByName('財政報告').getLastRow(), 4, '兩行財政樣本');
  assert.strictEqual(ss.getSheetByName('代禱事項').getLastRow(), 4, '兩行代禱樣本');
});

test('11c. 樣本只喺新建立嗰陣寫；刷新唔會再加多一次', function () {
  const env = makeEnv({});
  env.sandbox.buildOrRefreshContentSheet_(QUARTER_ID);
  const sheet = env.contentSpreadsheet().getSheetByName('家事報告');
  const before = sheet.getLastRow();

  env.sandbox.buildOrRefreshContentSheet_(QUARTER_ID);
  assert.strictEqual(sheet.getLastRow(), before, '刷新唔可以再加一次樣本');
});

function fakeDriveAdvanced(env, opts) {
  const o = opts || {};
  const calls = { created: [] };
  env.sandbox.Drive = {
    Permissions: {
      list: function (fileId, params) {
        if (o.listFails) throw new Error('假的：讀不到權限');
        if (!params.pageToken) return { permissions: [{ emailAddress: 'already@x.com', role: 'writer', type: 'user' }], nextPageToken: 'P2' };
        return { permissions: [{ emailAddress: 'org@x.com', role: 'organizer', type: 'user' }] };
      },
      create: function (resource, fileId, params) {
        if (o.createFails) throw new Error('假的：加不到');
        calls.created.push({ email: resource.emailAddress, role: resource.role, notify: params.sendNotificationEmail, allDrives: params.supportsAllDrives });
      }
    }
  };
  return calls;
}

test('12. 分享權限係網域（唔係任何人）；2026-10-30 起預設 VIEW：先逐個加編輯者（不寄通知信、逐頁讀現有權限），全部成功先改網域只可以看', function () {
  const env = makeEnv({ recipients: [
    { GROUP_NAME: 'CC', EMAIL: 'a@x.com', NAME: '甲', ACTIVE: true },
    { GROUP_NAME: 'DB', EMAIL: 'already@x.com', NAME: '乙', ACTIVE: true },
    { GROUP_NAME: 'ADMIN', EMAIL: 'org@x.com', NAME: '丙', ACTIVE: true }
  ] });
  const calls = fakeDriveAdvanced(env);
  const result = env.sandbox.buildOrRefreshContentSheet_(QUARTER_ID);
  const rec = env.driveFiles[result.fileId];

  assert.ok(rec, '應該對嗰個檔案設過權限');
  assert.strictEqual(rec.sharing.access, 'DOMAIN', '一定要係 DOMAIN，唔可以係 ANYONE_WITH_LINK');
  assert.strictEqual(rec.sharing.permission, 'VIEW');
  assert.deepStrictEqual(calls.created.map(function (c) { return c.email; }), ['a@x.com'], '已經是編輯者／管理員（第二頁）的不再加');
  assert.strictEqual(calls.created[0].notify, false);
  assert.strictEqual(calls.created[0].allDrives, true);
  assert.strictEqual(rec.movedTo, FAKE_FOLDER_ID, '要搬入指定資料夾');
  assert.strictEqual(result.sharingApplied, true);
  const lines = env.sandbox.buildContentSheetResultLines_(result).join('\n');
  assert.ok(lines.indexOf('教會網域內只可以看') !== -1, lines);
});

test('12d. 獨立審查第 5 項：加不到編輯者 → 網域保持任何人都可以修改，講出來（不可以先改成只可以看）', function () {
  const env = makeEnv({ recipients: [{ GROUP_NAME: 'CC', EMAIL: 'a@x.com', NAME: '甲', ACTIVE: true }] });
  fakeDriveAdvanced(env, { createFails: true });
  const result = env.sandbox.buildOrRefreshContentSheet_(QUARTER_ID);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(env.driveFiles[result.fileId].sharing.permission, 'EDIT');
  const lines = env.sandbox.buildContentSheetResultLines_(result).join('\n');
  assert.ok(lines.indexOf('暫時保持「網域內任何人都可以修改」') !== -1, lines);
  assert.ok(lines.indexOf('加編輯者 a@x.com') !== -1, lines);
});

test('12a. 權限計畫（純函式 planContentSheetSharing_）：VIEW＋組別電郵；沒有編輯者就保持 EDIT 並講出來；EDIT；財政報告組別', function () {
  const sb = makeEnv({}).sandbox;
  const today = sb.normalizeDate_('2027-10-01');
  const rows = [
    { GROUP_NAME: 'CC', EMAIL: 'a@x.com', NAME: '甲', ACTIVE: true },
    { GROUP_NAME: 'DB', EMAIL: 'B@x.com', NAME: '乙', ACTIVE: true },
    { GROUP_NAME: 'DB', EMAIL: 'c@x.com', NAME: '丙', ACTIVE: false },
    { GROUP_NAME: 'CC', EMAIL: 'b@x.com', NAME: '乙', ACTIVE: true }
  ];
  const cfg = { access: 'VIEW', accessRaw: 'VIEW', editorGroups: ['CC', 'DB'], financeGroups: ['DB'] };
  const p = sb.planContentSheetSharing_({ config: cfg, recipientRows: rows, today: today });
  assert.strictEqual(p.access, 'VIEW');
  assert.deepStrictEqual(Array.from(p.editors).sort(), ['a@x.com', 'b@x.com']);
  assert.deepStrictEqual(Array.from(p.financeEditors), ['b@x.com']);
  assert.strictEqual(p.financeLocked, true);
  const none = sb.planContentSheetSharing_({ config: cfg, recipientRows: [], today: today });
  assert.strictEqual(none.access, 'EDIT', '沒有編輯者不可以改成只可以看');
  assert.ok(none.warnings.join('').indexOf('一個有效的電郵都沒有') !== -1);
  const edit = sb.planContentSheetSharing_({ config: Object.assign({}, cfg, { access: 'EDIT', accessRaw: 'EDIT', financeGroups: [] }), recipientRows: rows, today: today });
  assert.strictEqual(edit.access, 'EDIT');
  assert.strictEqual(edit.financeLocked, false);
  const bad = sb.planContentSheetSharing_({ config: Object.assign({}, cfg, { accessRaw: 'READ' }), recipientRows: rows, today: today });
  assert.ok(bad.warnings.join('').indexOf('只可以填 VIEW 或 EDIT') !== -1);
});

test('12b. CONTENT_SHEET_DOMAIN 未填 → 照樣建立得到，但唔設分享權限而且對話框有提醒', function () {
  // ⚠️ 網域喺 DEFAULTS 一定係空字串（唔可以喺公開 repo 寫死真實網域），
  // 所以「未填」係開箱即用嘅預設狀態，一定要處理得好。
  const env = makeEnv({ config: { CONTENT_SHEET_DOMAIN: '' } });
  const result = env.sandbox.buildOrRefreshContentSheet_(QUARTER_ID);

  assert.strictEqual(result.ok, true, JSON.stringify(result));
  assert.strictEqual(result.sharingApplied, false);
  assert.strictEqual(env.driveFiles[result.fileId].sharing, null, '未填網域就唔應該亂設權限');
  assert.strictEqual(env.driveFiles[result.fileId].movedTo, FAKE_FOLDER_ID, '搬入資料夾照做');

  const lines = env.sandbox.buildContentSheetResultLines_(result).join('\n');
  assert.ok(lines.indexOf('CONTENT_SHEET_DOMAIN') !== -1, '要提醒人手設權限：' + lines);
});

test('12c. 分享失敗唔會令成個建立流程失敗（避免留低孤兒檔案）', function () {
  const env = makeEnv({});
  // 令 setSharing 拋錯。
  const original = env.sandbox.DriveApp.getFileById;
  env.sandbox.DriveApp.getFileById = function (fileId) {
    const file = original(fileId);
    file.setSharing = function () { throw new Error('假的：冇權限改分享設定'); };
    return file;
  };

  const result = env.sandbox.buildOrRefreshContentSheet_(QUARTER_ID);
  assert.strictEqual(result.ok, true, '檔案已經建立好，唔可以因為權限設唔到就當成失敗');
  assert.strictEqual(result.sharingApplied, false);
  assert.ok(result.sharingError.length > 0);
  assert.strictEqual(env.sandbox.readSheet_('ContentSheets').length, 1, '照樣要登記，否則會變孤兒檔案');
});

test('13. ContentSheets 有新增一行，FILE_URL 可用', function () {
  const env = makeEnv({});
  const result = env.sandbox.buildOrRefreshContentSheet_(QUARTER_ID);

  const rows = env.sandbox.readSheet_('ContentSheets');
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].QUARTER_ID, QUARTER_ID);
  assert.strictEqual(rows[0].FILE_ID, result.fileId);
  assert.ok(String(rows[0].FILE_URL).indexOf('https://') === 0, '連結要開得到：' + rows[0].FILE_URL);
  assert.strictEqual(rows[0].ACTIVE, true);
  assert.ok(isDate(rows[0].CREATED_AT), '建立時間要記低，實際：' + rows[0].CREATED_AT);
});

test('13b. 建立會寫一筆 AuditLog，而且唔會記低完整檔案 ID', function () {
  const env = makeEnv({});
  const result = env.sandbox.buildOrRefreshContentSheet_(QUARTER_ID);
  const audit = env.sandbox.readSheet_('AuditLog').filter(function (r) { return r.ACTION === 'CONTENT_SHEET_CREATE'; });
  assert.strictEqual(audit.length, 1);
  assert.strictEqual(audit[0].NEW_VALUE.indexOf(result.fileId), -1, '完整檔案 ID 唔應該散落喺 AuditLog');
});

// =====================================================================
// 14-16. 寄出連結
// =====================================================================

test('14. 寄連結：未建立 → 提示先建立，唔寄', function () {
  const env = makeEnv({});
  const result = env.sandbox.sendContentSheetInvite_(QUARTER_ID);
  assert.strictEqual(result.sent, false);
  assert.strictEqual(result.reason, 'NO_CONTENT_SHEET');
  assert.ok(result.message.indexOf('建立本季內容表') !== -1, result.message);
  assert.strictEqual(env.mail.calls.length, 0);
  assert.strictEqual(env.sandbox.readSheet_('SendLog').length, 0);
});

test('15. 寄連結：DRY_RUN=TRUE → SendLog 有記錄、冇真係寄', function () {
  const env = makeEnv({ config: { DRY_RUN: 'TRUE' } });
  env.sandbox.buildOrRefreshContentSheet_(QUARTER_ID);

  const result = env.sandbox.sendContentSheetInvite_(QUARTER_ID);
  assert.strictEqual(result.sent, true);
  assert.strictEqual(result.dryRun, true);
  assert.strictEqual(result.recipientCount, 2);
  assert.strictEqual(env.mail.calls.length, 0, 'DRY_RUN 一封都唔可以真係寄');

  const log = env.sandbox.readSheet_('SendLog');
  assert.strictEqual(log.length, 2);
  log.forEach(function (r) {
    assert.strictEqual(r.STATUS, 'CONTENT_SHEET_INVITE');
    assert.strictEqual(r.DRY_RUN, true);
  });
});

test('15b. 寄連結：DRY_RUN=FALSE → 真係寄，信入面有連結同三條規則', function () {
  const env = makeEnv({ config: { DRY_RUN: 'FALSE' } });
  const built = env.sandbox.buildOrRefreshContentSheet_(QUARTER_ID);

  const result = env.sandbox.sendContentSheetInvite_(QUARTER_ID);
  assert.strictEqual(result.sent, true);
  assert.strictEqual(env.mail.calls.length, 2);

  const html = env.mail.calls[0].htmlBody;
  assert.ok(html.indexOf(built.fileUrl) !== -1, '信入面要有內容表連結');
  assert.ok(html.indexOf('請勿刪除任何一行') !== -1, '要有「請勿刪除任何一行」的提醒');
  assert.ok(html.indexOf('2027-11-07') !== -1, '要列出本季主日');
  assert.ok(html.indexOf('幹事') !== -1, '要列出每張表由邊個負責');
});

test('16. 寄連結：更新 INVITE_SENT_AT', function () {
  const env = makeEnv({});
  env.sandbox.buildOrRefreshContentSheet_(QUARTER_ID);
  assert.strictEqual(env.sandbox.readSheet_('ContentSheets')[0].INVITE_SENT_AT, null);

  env.sandbox.sendContentSheetInvite_(QUARTER_ID);
  const after = env.sandbox.readSheet_('ContentSheets')[0];
  assert.ok(isDate(after.INVITE_SENT_AT), '寄完要更新 INVITE_SENT_AT，實際：' + after.INVITE_SENT_AT);
});

test('16b. 寄連結：Recipients 冇對應組別 → 唔寄，講明原因', function () {
  const env = makeEnv({ recipients: [] });
  env.sandbox.buildOrRefreshContentSheet_(QUARTER_ID);
  const result = env.sandbox.sendContentSheetInvite_(QUARTER_ID);
  assert.strictEqual(result.sent, false);
  assert.strictEqual(result.reason, 'NO_RECIPIENTS');
});

// =====================================================================
// 17-18. 自動提前寄
// =====================================================================

test('17. 自動提前寄：同一季只寄一次', function () {
  // 今日 2027-11-01，第一個主日 2027-11-07，相差 6 日 < 21 → 喺通知期內。
  const env = makeEnv({ todayIso: '2027-11-01', config: { DRY_RUN: 'FALSE' } });

  const first = env.sandbox.autoCreateContentSheetsForUpcomingQuarters_();
  assertArrayEqual(first.invited, [QUARTER_ID]);
  assertArrayEqual(first.created, [QUARTER_ID]);

  const second = env.sandbox.autoCreateContentSheetsForUpcomingQuarters_();
  assertArrayEqual(second.invited, [], '第二次唔可以再寄');
  assertArrayEqual(second.skipped, [QUARTER_ID]);
  assert.strictEqual(env.mail.calls.length, 2, '兩位收件人，總共只可以寄過一次');
});

test('17b. 自動提前寄：DRY_RUN 唔會消耗指紋（試行之後仍然寄得返）', function () {
  const env = makeEnv({ todayIso: '2027-11-01', config: { DRY_RUN: 'TRUE' } });
  env.sandbox.autoCreateContentSheetsForUpcomingQuarters_();

  const fingerprints = env.sandbox.readSheet_('ConflictNoticeLog');
  assert.strictEqual(fingerprints.length, 0, '試行唔可以記指紋——指紋係狀態');

  const second = env.sandbox.autoCreateContentSheetsForUpcomingQuarters_();
  assertArrayEqual(second.invited, [QUARTER_ID], '試行過之後，真正寄嗰次仍然要寄得出');
});

test('18. 自動提前寄：距離超過 LEAD_DAYS → 唔寄', function () {
  // 今日 2027-09-01，第一個主日 2027-11-07，相差 67 日 > 21。
  const env = makeEnv({ todayIso: '2027-09-01' });
  const result = env.sandbox.autoCreateContentSheetsForUpcomingQuarters_();
  assertArrayEqual(result.invited, []);
  assertArrayEqual(result.created, []);
  assertArrayEqual(result.skipped, [QUARTER_ID]);
  assert.strictEqual(Object.keys(env.createdSpreadsheets).length, 0, '未到期就唔應該建立');
});

test('18b. isWithinContentSheetLeadWindow_：邊界與已經開始咗嘅季度', function () {
  const env = makeEnv({});
  const fn = env.sandbox.isWithinContentSheetLeadWindow_;
  assert.strictEqual(fn('2027-10-17', '2027-11-07', 21), true, '啱啱 21 日 → 要寄');
  assert.strictEqual(fn('2027-10-16', '2027-11-07', 21), false, '22 日 → 未到');
  assert.strictEqual(fn('2027-11-20', '2027-11-07', 21), true, '已經開始咗嘅季度更加要即刻寄');
  assert.strictEqual(fn('唔係日期', '2027-11-07', 21), false);
});

test('18c. 自動提前寄：未設定資料夾 → 靜靜唔做，唔會喺背景不停拋錯', function () {
  const env = makeEnv({ todayIso: '2027-11-01', config: { CONTENT_SHEET_FOLDER_ID: '' } });
  let result;
  assert.doesNotThrow(function () { result = env.sandbox.autoCreateContentSheetsForUpcomingQuarters_(); });
  assertArrayEqual(result.invited, []);
});

// =====================================================================
// 19-20. 真正入口與「唔可以碰舊表」
// =====================================================================

test('19. 由真正入口（選單函式）跑一次建立同一次寄出，唔拋錯', function () {
  const env = makeEnv({ uiText: QUARTER_ID });
  assert.doesNotThrow(function () { env.sandbox.menuCreateContentSheet_(); });
  assert.doesNotThrow(function () { env.sandbox.menuSendContentSheetInvite_(); });

  assert.strictEqual(Object.keys(env.createdSpreadsheets).length, 1);
  assert.strictEqual(env.sandbox.readSheet_('SendLog').length, 2);
  assert.strictEqual(env.sandbox.readSheet_('ErrorLog').length, 0, '唔應該有任何錯誤記錄');

  const titles = env.uiAlerts.map(function (a) { return a.title; });
  assert.ok(titles.indexOf('已建立內容表') !== -1, JSON.stringify(titles));
});

test('19b. 選單：使用者撳取消 → 乜都唔做', function () {
  const env = makeEnv({ uiButton: 'CANCEL' });
  env.sandbox.menuCreateContentSheet_();
  assert.strictEqual(Object.keys(env.createdSpreadsheets).length, 0);
});

test('20. 週報試算表嘅五張舊表完全冇被改動', function () {
  const env = makeEnv({});
  const watched = ['Announcements', 'Prayers', 'Fellowships', 'Finance', 'BulletinWeeks'];
  const before = {};
  watched.forEach(function (name) { before[name] = JSON.stringify(env.sheets[name].__data || env.sandbox.readSheet_(name)); });

  env.sandbox.buildOrRefreshContentSheet_(QUARTER_ID);
  env.sandbox.sendContentSheetInvite_(QUARTER_ID);
  env.sandbox.buildOrRefreshContentSheet_(QUARTER_ID);

  watched.forEach(function (name) {
    assert.strictEqual(
      JSON.stringify(env.sheets[name].__data || env.sandbox.readSheet_(name)), before[name],
      name + ' 呢一輪一格都唔應該郁——匯入係下一輪先做'
    );
  });
});

test('20b. 五張舊表嘅欄位定義完全冇改（結構層面）', function () {
  const env = makeEnv({});
  const cols = env.sandbox.COLUMNS;
  assert.strictEqual(cols.ANNOUNCEMENTS.keys.length, 4);
  assert.strictEqual(cols.PRAYERS.keys.length, 4);
  assert.strictEqual(cols.FELLOWSHIPS.keys.length, 7);
  assert.strictEqual(cols.FINANCE.keys.length, 12, 'Finance 2026-10-30 最後加報告標題、附註、銀行結餘');
  assert.strictEqual(cols.BULLETIN_WEEKS.keys.length, 58, 'BulletinWeeks 欄數（浸禮六欄 ＋ R-036 的 ROSTER_STATUS ＋ R-035 ＋ v3 兩欄 ＋ 2026-10-30 崇拜類別）');
});

// =====================================================================
// 補充：純函式層
// =====================================================================

test('補充 a. parseContentSheetOwners_：正常解析，格式唔啱嘅項目略過唔拋錯', function () {
  const env = makeEnv({});
  const owners = env.sandbox.parseContentSheetOwners_('家事報告=幹事,代禱事項=堂委,亂七八糟,財政報告=執事');
  assert.strictEqual(owners['家事報告'], '幹事');
  assert.strictEqual(owners['財政報告'], '執事');
  assert.strictEqual(Object.keys(owners).length, 3);
});

test('補充 b. buildContentSheetFileName_：套用樣式；樣式空白時唔會回一個空檔名', function () {
  const env = makeEnv({});
  assert.strictEqual(env.sandbox.buildContentSheetFileName_('週報內容_{{QUARTER_ID}}', '2027T4'), '週報內容_2027T4');
  assert.strictEqual(env.sandbox.buildContentSheetFileName_('', '2027T4'), '週報內容_2027T4');
});

test('補充 c. _說明 分頁列出負責人、截止日期、三條規則、聯絡方法、本季主日', function () {
  const env = makeEnv({});
  env.sandbox.buildOrRefreshContentSheet_(QUARTER_ID);
  const sheet = env.contentSpreadsheet().getSheetByName('_說明');
  const text = sheet.__data.map(function (r) { return r[0]; }).join('\n');

  assert.ok(text.indexOf('家事報告：幹事') !== -1, '要列出每張表由邊個負責');
  assert.ok(text.indexOf('星期三') !== -1, '要有截止日期');
  assert.ok(text.indexOf('請勿刪除任何一行') !== -1);
  assert.ok(text.indexOf('請勿修改第 1、2 行') !== -1);
  assert.ok(text.indexOf('下拉選單') !== -1);
  assert.ok(text.indexOf('幹事（測試用聯絡方法）') !== -1, '聯絡方法要由 Config 讀，唔可以寫死');
  assert.ok(text.indexOf('樣本') !== -1, '有預填樣本時要註明');
  assert.ok(text.indexOf('2027-11-07') !== -1, '要列出本季主日');
});

test('補充 d. 每張表 A1 有一句說明，寫明邊個負責同幾時要填好', function () {
  const env = makeEnv({});
  env.sandbox.buildOrRefreshContentSheet_(QUARTER_ID);
  const note = env.contentSpreadsheet().getSheetByName('家事報告').getRange(1, 1).getNote();
  assert.ok(note.indexOf('負責：幹事') !== -1, note);
  assert.ok(note.indexOf('星期三') !== -1, note);
  assert.ok(note.indexOf('連續到') !== -1, '家事報告嗰句要解釋「連續到」點用');
});

test('補充 e. 內容表登記嘅檔案開唔到 → 明確講出嚟，唔會靜靜建立多一個', function () {
  const env = makeEnv({
    contentSheets: [{
      QUARTER_ID: QUARTER_ID, FILE_ID: 'GONE_FILE_ID', FILE_URL: 'https://x',
      CREATED_AT: '2027-10-01', LAST_IMPORTED_AT: '', INVITE_SENT_AT: '', ACTIVE: true
    }]
  });
  const result = env.sandbox.buildOrRefreshContentSheet_(QUARTER_ID);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'FILE_MISSING');
  assert.strictEqual(Object.keys(env.createdSpreadsheets).length, 0,
    '開唔到就要問人，唔可以靜靜建立多一個（會分裂成兩份資料）');
  assert.strictEqual(result.message.indexOf('GONE_FILE_ID'), -1, '訊息唔應該有完整檔案 ID');
});

test('補充 f. 職事表冇嗰一季 → 明確錯誤，唔會建立空白內容表', function () {
  const env = makeEnv({});
  const result = env.sandbox.buildOrRefreshContentSheet_('2099T9');
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'NO_SERVICE_DATES');
  assert.strictEqual(Object.keys(env.createdSpreadsheets).length, 0);
});

test('補充 g. 「連續到」係家事報告同代禱事項獨有；其餘四張冇', function () {
  const env = makeEnv({});
  const defs = env.sandbox.contentSheetTabDefs_();
  defs.forEach(function (d) {
    const hasRepeat = d.keys.indexOf('REPEAT_UNTIL') !== -1;
    const expected = (d.tabName === '家事報告' || d.tabName === '代禱事項');
    assert.strictEqual(hasRepeat, expected, d.tabName + ' 嘅「連續到」應該係 ' + expected);
  });
});

test('補充 h. 崇拜人數嘅十二個機器鍵同週報系統現有嘅 ATT_* 完全一致、次序一樣', function () {
  const env = makeEnv({});
  const def = env.sandbox.contentSheetTabDefs_().filter(function (d) { return d.tabName === '崇拜人數'; })[0];
  const contentAtt = def.keys.filter(function (k) { return /^ATT_/.test(k); });
  const weekAtt = env.sandbox.COLUMNS.BULLETIN_WEEKS.keys.filter(function (k) { return /^ATT_/.test(k); });
  assertArrayEqual(contentAtt, weekAtt, '兩邊次序一致，下一輪匯入先至唔使任何對照表');
});

// =====================================================================

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
