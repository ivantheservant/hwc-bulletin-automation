#!/usr/bin/env node
/**
 * tests/helpers/fillEnv.js
 *
 * 第八輪（季度填寫表）共用的測試環境建構工具。
 *
 * 造一個完整的假試算表：週報自己全部工作表（含 `Fill_<QuarterID>`
 * 格子表）＋ 職事表，再加假的 `MailApp`／`ScriptApp`／`HtmlService`。
 *
 * ⚠️ 格子表不在 `SHEETS` 內（一季一張，名稱是動態的），所以要另外用
 * `makeFillGridSheet()` 造。
 */

'use strict';

const { loadAllSrcFilesInOrder } = require('./loadGas');
const { makeFakeSheet, makeFakeSpreadsheet, toRealmSafeCellValue, applyTextFormatMarker } = require('./fakeSpreadsheet');

const FAKE_ROSTER_ID = 'FAKE_ROSTER_ID_FOR_FILL_TESTS';

/** 一季的主日（2027T4 的 11 月，四個主日，足夠測試又不會太慢）。 */
const QUARTER_ID = '2027T4';
const SERVICE_DATES = ['2027-11-07', '2027-11-14', '2027-11-21', '2027-11-28'];

const BASE_STUBS = {
  Session: {
    getScriptTimeZone: function () { return 'Pacific/Auckland'; },
    getActiveUser: function () { return { getEmail: function () { return 'tester@x.com'; } }; },
    getEffectiveUser: function () { return { getEmail: function () { return 'tester@x.com'; } }; }
  },
  Utilities: {
    formatDate: function (date, tz, pattern) {
      // 只實作測試需要的兩個樣式。
      const y = date.getFullYear();
      const mo = String(date.getMonth() + 1).padStart(2, '0');
      const d = String(date.getDate()).padStart(2, '0');
      const hh = String(date.getHours()).padStart(2, '0');
      const mi = String(date.getMinutes()).padStart(2, '0');
      const ss = String(date.getSeconds()).padStart(2, '0');
      if (String(pattern).indexOf('HHmmss') !== -1) return `${y}${mo}${d}T${hh}${mi}${ss}`;
      return `${y}-${mo}-${d}`;
    }
  },
  CacheService: {},
  HtmlService: {
    createTemplateFromFile: function () {
      return { evaluate: function () { return { setWidth: function () { return this; }, setHeight: function () { return this; } }; } };
    }
  }
};

/**
 * 用途：造一張假的季度填寫表。
 *
 *   格子表的結構跟 `SHEETS` 內的表不同：**三行標題**（群組／中文／機器鍵），
 *   資料由第 4 行開始，所以不可以用 `makeFakeSheet()`（那個是兩行標題）。
 * Args:
 *   sandbox {Object} 已經載入的 sandbox（要用 `fillGridColumnDefs_()`）。
 *   rows {Object[]} 每個元素是「機器鍵 → 值」的物件。
 * Returns:
 *   {Object} 假 Sheet，另有 `__data` 方便測試直接看內容。
 */
function makeFillGridSheet(sandbox, rows) {
  const defs = sandbox.fillGridColumnDefs_();
  const header = sandbox.buildFillGridHeaderRows_();
  const data = header.headerRows.map(function (r) { return r.slice(); });
  const escapedValues = new Set();

  (rows || []).forEach(function (row) {
    data.push(defs.map(function (d) { return row[d.key] === undefined ? '' : row[d.key]; }));
  });

  const notes = {};
  const validations = {};
  let conditionalRules = [];
  let frozenRows = 0;
  let frozenColumns = 0;

  const sheet = {
    __data: data,
    __escapedValues: escapedValues,
    __notes: notes,
    __validations: validations,
    getName: function () { return sheet.__name; },
    getSheetId: function () { return 12345; },
    getLastRow: function () { return data.length; },
    getLastColumn: function () { return defs.length; },
    getMaxRows: function () { return Math.max(data.length, 100); },
    getFrozenRows: function () { return frozenRows; },
    setFrozenRows: function (n) { frozenRows = n; return sheet; },
    getFrozenColumns: function () { return frozenColumns; },
    setFrozenColumns: function (n) { frozenColumns = n; return sheet; },
    setConditionalFormatRules: function (rules) { conditionalRules = rules; return sheet; },
    getConditionalFormatRules: function () { return conditionalRules; },
    getProtections: function () { return []; },
    protect: function () {
      return {
        setDescription: function () { return this; },
        removeEditors: function () { return this; },
        addEditors: function () { return this; },
        getEditors: function () { return []; }
      };
    },
    getRange: function (r, c, numRows, numCols) {
      numRows = numRows || 1;
      numCols = numCols || 1;
      return {
        getRow: function () { return r; },
        getColumn: function () { return c; },
        getNumRows: function () { return numRows; },
        getNumColumns: function () { return numCols; },
        getSheet: function () { return sheet; },
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
          for (let i = 0; i < values.length; i++) {
            const rowIdx = r - 1 + i;
            while (data.length <= rowIdx) data.push([]);
            for (let j = 0; j < values[i].length; j++) data[rowIdx][c - 1 + j] = applyTextFormatMarker(toRealmSafeCellValue(values[i][j]), escapedValues);
          }
          return this;
        },
        getValue: function () {
          const src = data[r - 1];
          return src && src[c - 1] !== undefined ? src[c - 1] : '';
        },
        setValue: function (v) {
          while (data.length <= r - 1) data.push([]);
          data[r - 1][c - 1] = applyTextFormatMarker(toRealmSafeCellValue(v), escapedValues);
          return this;
        },
        setNote: function (text) { notes[r + ',' + c] = text; return this; },
        getNote: function () { return notes[r + ',' + c] || ''; },
        // 真正的 GAS `Range.clearNote()`／`getNotes()` 作用在範圍**每一格**，
        // 不是只有左上角那一格——prompt8b「清走唯讀欄所有既有註解」用的是
        // 多行範圍（`getRange(startRow, col, rowCount, 1)`），假物件一定要
        // 照真實語意才測得出來。
        clearNote: function () {
          for (let i = 0; i < numRows; i++) {
            for (let j = 0; j < numCols; j++) delete notes[(r + i) + ',' + (c + j)];
          }
          return this;
        },
        getNotes: function () {
          const out = [];
          for (let i = 0; i < numRows; i++) {
            const rowArr = [];
            for (let j = 0; j < numCols; j++) rowArr.push(notes[(r + i) + ',' + (c + j)] || '');
            out.push(rowArr);
          }
          return out;
        },
        setDataValidation: function (v) { validations[c] = v; return this; },
        clearDataValidations: function () { delete validations[c]; return this; },
        clearContent: function () {
          for (let i = 0; i < numRows; i++) {
            const src = data[r - 1 + i];
            if (src) for (let j = 0; j < numCols; j++) src[c - 1 + j] = '';
          }
          return this;
        },
        setFontWeight: function () { return this; },
        setBackground: function () { return this; },
        setFontSize: function () { return this; },
        setNumberFormat: function () { return this; },
        merge: function () { return this; }
      };
    }
  };

  return sheet;
}

/**
 * 用途：造一個完整的第八輪測試環境。
 * Args:
 *   options {{weekRows:Object[]=, gridRows:Object[]=, snapshotRows:Object[]=,
 *            config:Object=, recipients:Object[]=, fellowships:Object[]=,
 *            fellowshipDefaults:Object[]=, backupRows:Object[]=,
 *            announcements:Object[]=, withGrid:boolean=}=}
 *     `withGrid` 預設 true；設成 false 代表格子表還未建立。
 * Returns:
 *   {{sandbox:Object, sheets:Object, mail:Object, triggers:Object,
 *     quarterId:string, serviceDates:string[]}}
 */
function makeFillEnv(options) {
  const o = options || {};
  const boot = loadAllSrcFilesInOrder(BASE_STUBS);

  const cfg = {};
  boot.DEFAULTS.forEach(function (d) { cfg[d.key] = d.value; });
  cfg.ROSTER_SPREADSHEET_ID = FAKE_ROSTER_ID;
  Object.assign(cfg, o.config || {});

  function ownSheet(sheetId, rows) {
    const def = boot.COLUMNS[sheetId];
    return makeFakeSheet(def.headers, def.keys, rows || []);
  }

  const sheets = {};
  Object.keys(boot.SHEETS).forEach(function (id) { sheets[boot.SHEETS[id]] = ownSheet(id, []); });

  sheets.Config = ownSheet('CONFIG', Object.keys(cfg).map(function (k) {
    return { KEY: k, VALUE: cfg[k], NOTE: '', EDITABLE: true };
  }));

  const weekRows = o.weekRows || SERVICE_DATES.map(function (iso, i) {
    return { SERVICE_DATE: iso, QUARTER_ID: QUARTER_ID, WEEK_OF_MONTH: i + 1, STATUS: 'DRAFT' };
  });
  sheets.BulletinWeeks = ownSheet('BULLETIN_WEEKS', weekRows);

  sheets.ProgramTemplates = ownSheet('PROGRAM_TEMPLATES', boot.seedProgramTemplatesRows_());
  // ⚠️ NumberRegistry 一定要 seed：一個真的跑過「初始化工作表」的試算表
  // 必定有這幾行，而不變量 I03 會檢查「有實作但沒有登記」——不 seed 的話
  // 每一個用這個環境的測試都會撞到一個**假的**紅燈。
  sheets.NumberRegistry = ownSheet('NUMBER_REGISTRY', boot.seedNumberRegistryRows_());
  sheets.PostDisplay = ownSheet('POST_DISPLAY', boot.seedPostDisplayRows_());
  sheets.MergeGroups = ownSheet('MERGE_GROUPS', boot.seedMergeGroupsRows_());
  sheets.FellowshipDefaults = ownSheet('FELLOWSHIP_DEFAULTS', o.fellowshipDefaults || boot.seedFellowshipDefaultsRows_());
  sheets.FillSnapshot = ownSheet('FILL_SNAPSHOT', o.snapshotRows || []);
  sheets.FillBackup = ownSheet('FILL_BACKUP', o.backupRows || []);
  sheets.Fellowships = ownSheet('FELLOWSHIPS', o.fellowships || []);
  sheets.Announcements = ownSheet('ANNOUNCEMENTS', o.announcements || []);
  sheets.Recipients = ownSheet('RECIPIENTS', o.recipients || [
    { RECIPIENT_ID: 'R1', NAME: '假甲', EMAIL: 'admin@x.com', GROUP_NAME: 'ADMIN', ACTIVE: true, EFFECTIVE_FROM: '', EFFECTIVE_TO: '', NOTES: '' },
    { RECIPIENT_ID: 'R2', NAME: '假乙', EMAIL: 'worship@x.com', GROUP_NAME: 'WORSHIP', ACTIVE: true, EFFECTIVE_FROM: '', EFFECTIVE_TO: '', NOTES: '' }
  ]);

  // 格子表要用 sandbox 的欄位定義才造得出來，所以先載一次 boot。
  if (o.withGrid !== false) {
    const gridRows = o.gridRows || SERVICE_DATES.map(function (iso, i) {
      return { _DATE: iso, _WEEK: String(i + 1), _SPECIAL: '' };
    });
    const gridSheet = makeFillGridSheet(boot, gridRows);
    gridSheet.__name = boot.FILL_GRID_SHEET_PREFIX + QUARTER_ID;
    sheets[gridSheet.__name] = gridSheet;
  }

  function rosterSheet(defKey, rows) {
    const keys = Object.keys(boot.ROSTER_TABLE_DEFS_[defKey].columns);
    return makeFakeSheet(keys, keys, rows || []);
  }

  const rosterSheets = {
    RosterAssignments: rosterSheet('ASSIGNMENTS', SERVICE_DATES.map(function (iso) {
      return {
        QuarterID: QUARTER_ID, VersionNo: 3, ServiceDate: iso, PostID: 'CHAIR',
        SlotIndex: 1, PersonID: 'P9001', PersonNameSnapshot: '陳大文', AssignSource: 'AUTO', Locked: false
      };
    })),
    RosterVersions: rosterSheet('VERSIONS', [{ QuarterID: QUARTER_ID, VersionNo: 3 }]),
    Quarters: rosterSheet('QUARTERS', [{ QuarterID: QUARTER_ID, Stage: 'OFFICIAL_SENT' }]),
    ServiceDates: rosterSheet('SERVICE_DATES', SERVICE_DATES.map(function (iso, i) {
      return {
        ServiceDateID: 'SD' + (i + 1), QuarterID: QUARTER_ID, ServiceDate: iso, WeekIndex: i + 1,
        IsFirstSundayOfMonth: i === 0, ServiceType: '主日崇拜', SpecialID: ''
      };
    })),
    SpecialSundays: rosterSheet('SPECIAL_SUNDAYS', o.specialSundays || []),
    NameMapping: rosterSheet('NAME_MAPPING', [{ PersonID: 'P9001', NameTC: '陳大文', Active: true }]),
    Posts: rosterSheet('POSTS', [
      { PostID: 'CHAIR', PostName_TC: '主席', SlotCount: 1, Frequency: 'WEEKLY', AutoGenerate: true, DisplayOrder: 10, Active: true, EmptyDisplay: 'PENDING' }
    ])
  };

  const insertedSheets = [];
  const toasts = [];
  const spreadsheet = {
    __toasts: toasts,
    toast: function (message, title, timeoutSeconds) { toasts.push({ message: message, title: title, timeoutSeconds: timeoutSeconds }); },
    getUrl: function () { return 'https://docs.google.com/spreadsheets/d/FAKE/edit'; },
    getName: function () { return 'FAKE_SPREADSHEET'; },
    getSheetByName: function (name) { return sheets[name] || null; },
    getSheets: function () {
      return Object.keys(sheets).map(function (name) {
        const s = sheets[name];
        if (!s.getName) s.getName = function () { return name; };
        if (!s.__name) s.__name = name;
        return s;
      });
    },
    insertSheet: function (name) {
      const s = makeFillGridSheet(boot, []);
      s.__name = name;
      sheets[name] = s;
      insertedSheets.push(name);
      return s;
    }
  };

  const FakeSpreadsheetApp = {
    getActiveSpreadsheet: function () { return spreadsheet; },
    openById: function (id) {
      if (id !== FAKE_ROSTER_ID) throw new Error('openById: 未預期的 id ' + id);
      return makeFakeSpreadsheet(rosterSheets);
    },
    getUi: function () {
      return {
        createMenu: function () {
          const menu = {
            addItem: function () { return menu; },
            addSeparator: function () { return menu; },
            addSubMenu: function () { return menu; },
            addToUi: function () { return menu; }
          };
          return menu;
        },
        alert: function () { return 'OK'; },
        prompt: function () { return { getSelectedButton: function () { return 'CANCEL'; }, getResponseText: function () { return ''; } }; },
        showModalDialog: function () {},
        ButtonSet: { OK: 'OK', OK_CANCEL: 'OK_CANCEL', YES_NO: 'YES_NO' },
        Button: { OK: 'OK', CANCEL: 'CANCEL', YES: 'YES', NO: 'NO' }
      };
    },
    newDataValidation: function () {
      const builder = {
        __values: null, __allowInvalid: true,
        requireValueInList: function (values) { builder.__values = values; return builder; },
        setAllowInvalid: function (b) { builder.__allowInvalid = b; return builder; },
        build: function () { return { getCriteriaValues: function () { return [builder.__values]; }, __allowInvalid: builder.__allowInvalid }; }
      };
      return builder;
    },
    newConditionalFormatRule: function () {
      const builder = {
        __spec: {},
        whenFormulaSatisfied: function (f) { builder.__spec.formula = f; return builder; },
        whenCellNotEmpty: function () { builder.__spec.notEmpty = true; return builder; },
        setBackground: function (c) { builder.__spec.background = c; return builder; },
        setRanges: function (r) { builder.__spec.ranges = r; return builder; },
        build: function () { return builder.__spec; }
      };
      return builder;
    },
    ProtectionType: { SHEET: 'SHEET' }
  };

  const mail = { calls: [], sendEmail: function (m) { mail.calls.push(m); }, getRemainingDailyQuota: function () { return 1000; } };

  const triggers = { installed: [], deleted: [] };
  const FakeScriptApp = {
    getProjectTriggers: function () { return triggers.installed.slice(); },
    deleteTrigger: function (t) {
      triggers.deleted.push(t);
      const i = triggers.installed.indexOf(t);
      if (i !== -1) triggers.installed.splice(i, 1);
    },
    newTrigger: function (handler) {
      const built = { getHandlerFunction: function () { return handler; } };
      const builder = {
        forSpreadsheet: function () { return builder; },
        onEdit: function () { return builder; },
        timeBased: function () { return builder; },
        everyHours: function () { return builder; },
        create: function () { triggers.installed.push(built); return built; }
      };
      return builder;
    }
  };

  // prompt9：全季演練需要在同一個環境內同時具備格子表能力（本檔案的
  // FakeSpreadsheetApp）與 Word 產生能力（DriveApp／Utilities.zip／unzip），
  // 所以額外開放 `options.driveApp`／`options.utilitiesZip` 讓呼叫方注入
  // ——兩者預設不提供，不影響既有只測格子表的測試。`utilitiesZip` 只補
  // `zip`／`unzip`／`newBlob` 三個方法，**不覆蓋**本檔案 `BASE_STUBS.Utilities`
  // 真正實作日期格式化的 `formatDate`（假的 Word 附件 zip 用途跟真正的
  // 日期格式化完全獨立，不應該讓其中一個蓋掉另一個）。
  const utilitiesForSandbox = o.utilitiesZip
    ? Object.assign({}, BASE_STUBS.Utilities, o.utilitiesZip)
    : BASE_STUBS.Utilities;

  const sandbox = loadAllSrcFilesInOrder(Object.assign({}, BASE_STUBS, {
    SpreadsheetApp: FakeSpreadsheetApp,
    MailApp: mail,
    ScriptApp: FakeScriptApp,
    Utilities: utilitiesForSandbox
  }, o.driveApp ? { DriveApp: o.driveApp } : {},
  // Drive 進階服務（Shared Drive 的 supportsAllDrives 那一套）跟 DriveApp
  // 一起注入——`uniqueOutputFileName_()` 兩者都要用得到。
  o.driveAdvanced ? { Drive: o.driveAdvanced } : {}));

  return {
    sandbox: sandbox, sheets: sheets, mail: mail, triggers: triggers,
    insertedSheets: insertedSheets, toasts: toasts,
    quarterId: QUARTER_ID, serviceDates: SERVICE_DATES
  };
}

module.exports = {
  makeFillEnv: makeFillEnv,
  makeFillGridSheet: makeFillGridSheet,
  QUARTER_ID: QUARTER_ID,
  SERVICE_DATES: SERVICE_DATES,
  BASE_STUBS: BASE_STUBS
};
