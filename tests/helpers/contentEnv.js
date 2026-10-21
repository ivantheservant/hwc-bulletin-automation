#!/usr/bin/env node
/**
 * tests/helpers/contentEnv.js
 *
 * 有內容表（獨立試算表）的完整測試環境。原本寫在 tests/contentimport.test.js 裏面，
 * 階段 2 的「重設這一週」測試也要用，所以抽成共用工具。內容與原本一模一樣，
 * 只是搬了位置、加了匯出。
 */

'use strict';

const { loadAllSrcFilesInOrder } = require('./loadGas');
const { makeFakeSheet, makeFakeSpreadsheet } = require('./fakeSpreadsheet');

const FAKE_ROSTER_ID = 'FAKE_ROSTER_ID_FOR_IMPORT_TESTS';
const FAKE_FOLDER_ID = 'FAKE_CONTENT_FOLDER';
const FAKE_CONTENT_FILE_ID = 'FAKE_CONTENT_FILE';
const QUARTER_ID = '2027T4';
const SERVICE_DATES = ['2027-10-03', '2027-10-10', '2027-10-17', '2027-10-24', '2027-10-31'];

/** 造一張假的內容表分頁（兩行標題，資料由第 3 行開始）。 */
function makeContentTab(keys, headers, rows) {
  const data = [headers.slice(), keys.slice()];
  (rows || []).forEach(function (row) {
    data.push(keys.map(function (k) { return row[k] === undefined ? '' : row[k]; }));
  });

  const sheet = {
    __data: data,
    getName: function () { return sheet.__name; },
    getLastRow: function () { return data.length; },
    getLastColumn: function () { return keys.length; },
    getMaxRows: function () { return Math.max(data.length, 500); },
    getFrozenRows: function () { return 2; },
    setFrozenRows: function () { return sheet; },
    setColumnWidth: function () { return sheet; },
    getRange: function (r, c, numRows, numCols) {
      numRows = numRows || 1;
      numCols = numCols || 1;
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
        setValues: function () { return range; },
        getValue: function () { const s = data[r - 1]; return s && s[c - 1] !== undefined ? s[c - 1] : ''; },
        setValue: function () { return range; },
        clearContent: function () { return range; },
        setNumberFormat: function () { return range; },
        setDataValidation: function () { return range; },
        clearDataValidations: function () { return range; },
        setNote: function () { return range; },
        getNote: function () { return ''; },
        setWrap: function () { return range; },
        setFontWeight: function () { return range; },
        setBackground: function () { return range; },
        setFontColor: function () { return range; },
        setFontSize: function () { return range; }
      };
      return range;
    }
  };
  return sheet;
}

/**
 * 造一個測試環境。
 * options.content：分頁名稱 → 資料列陣列（以內容表機器鍵為 key）。
 *   沒有列出的分頁＝整張空白。
 */
function makeEnv(options) {
  const o = options || {};
  const boot = loadAllSrcFilesInOrder(baseStubs());

  const cfg = {};
  boot.DEFAULTS.forEach(function (d) { cfg[d.key] = d.value; });
  cfg.ROSTER_SPREADSHEET_ID = FAKE_ROSTER_ID;
  cfg.CONTENT_SHEET_FOLDER_ID = FAKE_FOLDER_ID;
  Object.assign(cfg, o.config || {});

  function ownSheet(sheetId, rows) {
    const def = boot.COLUMNS[sheetId];
    return makeFakeSheet(def.headers, def.keys, rows || []);
  }

  const ownSheets = {};
  Object.keys(boot.SHEETS).forEach(function (id) { ownSheets[boot.SHEETS[id]] = ownSheet(id, []); });
  ownSheets.Config = ownSheet('CONFIG', Object.keys(cfg).map(function (k) {
    return { KEY: k, VALUE: cfg[k], NOTE: '', EDITABLE: true };
  }));
  ownSheets.BulletinWeeks = ownSheet('BULLETIN_WEEKS', o.weekRows || SERVICE_DATES.map(function (iso, i) {
    return { SERVICE_DATE: iso, QUARTER_ID: QUARTER_ID, WEEK_OF_MONTH: (i % 4) + 1, STATUS: 'DRAFT' };
  }));
  ownSheets.Announcements = ownSheet('ANNOUNCEMENTS', o.announcements || []);
  ownSheets.Prayers = ownSheet('PRAYERS', o.prayers || []);
  ownSheets.Fellowships = ownSheet('FELLOWSHIPS', o.fellowships || []);
  ownSheets.Finance = ownSheet('FINANCE', o.finance || []);
  ownSheets.ContentSheets = ownSheet('CONTENT_SHEETS', o.contentSheets === undefined ? [{
    QUARTER_ID: QUARTER_ID, FILE_ID: FAKE_CONTENT_FILE_ID,
    FILE_URL: 'https://docs.google.com/spreadsheets/d/' + FAKE_CONTENT_FILE_ID + '/edit',
    CREATED_AT: '2027-09-01', LAST_IMPORTED_AT: '', INVITE_SENT_AT: '', ACTIVE: true
  }] : o.contentSheets);

  function rosterSheet(defKey, rows) {
    const keys = Object.keys(boot.ROSTER_TABLE_DEFS_[defKey].columns);
    return makeFakeSheet(keys, keys, rows || []);
  }

  const rosterSheets = {
    RosterAssignments: rosterSheet('ASSIGNMENTS', []),
    RosterVersions: rosterSheet('VERSIONS', [{ QuarterID: QUARTER_ID, VersionNo: 1 }]),
    Quarters: rosterSheet('QUARTERS', [{ QuarterID: QUARTER_ID, Stage: 'OFFICIAL_SENT' }]),
    ServiceDates: rosterSheet('SERVICE_DATES', SERVICE_DATES.map(function (iso, i) {
      return {
        ServiceDateID: 'SD' + (i + 1), QuarterID: QUARTER_ID, ServiceDate: iso,
        WeekIndex: i + 1, IsFirstSundayOfMonth: i === 0, ServiceType: '主日崇拜', SpecialID: ''
      };
    })),
    SpecialSundays: rosterSheet('SPECIAL_SUNDAYS', []),
    NameMapping: rosterSheet('NAME_MAPPING', []),
    Posts: rosterSheet('POSTS', [])
  };

  // ---- 內容表 ----
  const contentTabs = {};
  boot.contentSheetTabDefs_().forEach(function (def) {
    const rows = (o.content || {})[def.tabName] || [];
    const tab = makeContentTab(def.keys, def.headers, rows);
    tab.__name = def.tabName;
    contentTabs[def.tabName] = tab;
  });

  const contentSpreadsheet = {
    getId: function () { return FAKE_CONTENT_FILE_ID; },
    getUrl: function () { return 'https://docs.google.com/spreadsheets/d/' + FAKE_CONTENT_FILE_ID + '/edit'; },
    getSheetByName: function (name) { return contentTabs[name] || null; },
    getSheets: function () { return Object.keys(contentTabs).map(function (n) { return contentTabs[n]; }); },
    insertSheet: function (name) { const s = makeContentTab([], [], []); s.__name = name; contentTabs[name] = s; return s; }
  };

  const locks = { tried: 0, released: 0, fail: Boolean(o.lockFails) };
  const FakeLockService = {
    getScriptLock: function () {
      return {
        tryLock: function () { locks.tried++; return !locks.fail; },
        releaseLock: function () { locks.released++; }
      };
    }
  };

  const uiAlerts = [];
  const FakeSpreadsheetApp = {
    getActiveSpreadsheet: function () { return makeFakeSpreadsheet(ownSheets); },
    openById: function (id) {
      if (id === FAKE_ROSTER_ID) return makeFakeSpreadsheet(rosterSheets);
      if (id === FAKE_CONTENT_FILE_ID && !o.contentFileMissing) return contentSpreadsheet;
      throw new Error('openById: 找不到 ' + id);
    },
    create: function () { throw new Error('這一輪不應該建立新試算表'); },
    newDataValidation: function () {
      const b = {
        requireValueInList: function () { return b; },
        setAllowInvalid: function () { return b; },
        build: function () { return {}; }
      };
      return b;
    },
    ProtectionType: { SHEET: 'SHEET' },
    getUi: function () {
      return {
        createMenu: function () {
          const m = { addItem: function () { return m; }, addSeparator: function () { return m; }, addSubMenu: function () { return m; }, addToUi: function () { return m; } };
          return m;
        },
        alert: function (a, b) { uiAlerts.push({ title: a, body: b }); return o.uiConfirm === undefined ? 'YES' : o.uiConfirm; },
        prompt: function () {
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

  const sandbox = loadAllSrcFilesInOrder(Object.assign({}, baseStubs(), {
    SpreadsheetApp: FakeSpreadsheetApp,
    LockService: FakeLockService,
    DriveApp: { Access: {}, Permission: {}, getFileById: function () { return {}; }, getFolderById: function () { return {}; } },
    MailApp: { sendEmail: function () {}, getRemainingDailyQuota: function () { return 100; } },
    ScriptApp: { getProjectTriggers: function () { return []; } }
  }));

  return { sandbox: sandbox, sheets: ownSheets, locks: locks, uiAlerts: uiAlerts, contentTabs: contentTabs };
}

function baseStubs() {
  return {
    Utilities: {
      formatDate: function (date, tz, pattern) {
        const y = date.getFullYear();
        const mo = String(date.getMonth() + 1).padStart(2, '0');
        const d = String(date.getDate()).padStart(2, '0');
        const hh = String(date.getHours()).padStart(2, '0');
        const mi = String(date.getMinutes()).padStart(2, '0');
        if (String(pattern).indexOf('HH') !== -1) return `${y}-${mo}-${d} ${hh}:${mi}`;
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

module.exports = {
  makeEnv: makeEnv,
  makeContentTab: makeContentTab,
  baseStubs: baseStubs,
  FAKE_ROSTER_ID: FAKE_ROSTER_ID,
  FAKE_FOLDER_ID: FAKE_FOLDER_ID,
  FAKE_CONTENT_FILE_ID: FAKE_CONTENT_FILE_ID,
  QUARTER_ID: QUARTER_ID,
  SERVICE_DATES: SERVICE_DATES
};
