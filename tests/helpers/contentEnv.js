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
const { makeContentFaults, makeContentTab: makeStrictContentTab, makeContentSpreadsheet } = require('./contentTabFake');
const { legacyContentTabDefsV1 } = require('../fixtures/legacyContentSheetV1');
const { legacyContentTabDefsV2 } = require('../fixtures/legacyContentSheetV2');
const { legacyContentTabDefsV3 } = require('../fixtures/legacyContentSheetV3');

const FAKE_ROSTER_ID = 'FAKE_ROSTER_ID_FOR_IMPORT_TESTS';
const FAKE_FOLDER_ID = 'FAKE_CONTENT_FOLDER';
const FAKE_CONTENT_FILE_ID = 'FAKE_CONTENT_FILE';
const QUARTER_ID = '2027T4';
const SERVICE_DATES = ['2027-10-03', '2027-10-10', '2027-10-17', '2027-10-24', '2027-10-31'];

/**
 * 造一張假的內容表分頁（兩行標題，資料由第 3 行開始）。
 *
 * 內容表 v2 Commit 1：改用 tests/helpers/contentTabFake.js 的嚴格替身（超出欄數拋錯、寫入會自動轉型、
 * 改名跟住走、可以隱藏與保護）。保留這個名字與參數，舊測試照舊叫得到。
 */
function makeContentTab(keys, headers, rows, opts) {
  return makeStrictContentTab(keys, headers, rows, opts);
}

/**
 * 2026-10-30：造一張日子橫放的分頁：A 欄中文標題、B 欄機器鍵、C 欄起每一筆一欄（「有效」不放）。
 * `rows` 與舊版一樣以機器鍵為 key（每一筆＝一個崇拜日期）。
 */
function makeTransposedTab(def, rows, opts) {
  const tkeys = def.keys.filter(function (k) { return k !== 'ACTIVE'; });
  const theaders = def.headers.filter(function (h, i) { return def.keys[i] !== 'ACTIVE'; });
  const tab = makeContentTab([], [], [], opts);
  const matrix = tkeys.map(function (k, i) {
    return [theaders[i], k].concat((rows || []).map(function (r) { return r[k] === undefined ? '' : r[k]; }));
  });
  // 真的內容表由 applyTransposedContentTabLayout_() 設成純文字；這裏一樣，否則「1,024」會被轉成數字。
  const range = tab.getRange(1, 1, tkeys.length, 2 + (rows || []).length);
  range.setNumberFormat('@');
  range.setValues(matrix);
  return tab;
}

/**
 * 造一個測試環境。
 * options.content：分頁名稱 → 資料列陣列（以內容表機器鍵為 key）。
 *   沒有列出的分頁＝整張空白。⚠️ 寫了一個這個版面沒有的分頁名稱就拋錯——以前會靜靜當成
 *   空白分頁，內容表 v2 把「宣召」併入「崇拜程序」之後，`content: { 宣召: … }` 這類舊測試就會
 *   空跑變綠（bug class 39、40）。
 * options.contentLayout：'current'（預設，由 src 的 contentSheetTabDefs_() 造）、'v1'
 *   （由 tests/fixtures/legacyContentSheetV1.js 凍結的舊版定義造，移轉測試用）或 'v2'
 *   （「崇拜程序」用 tests/fixtures/legacyContentSheetV2.js 凍結的 v2 定義，v3 移轉測試用）或 'v3'
 *   （tests/fixtures/legacyContentSheetV3.js 凍結的 v3 定義，v4 整理測試用）。
 * options.omitTabs：這幾張分頁不建立（模擬舊內容表未有那一張）。
 * options.extraTabs：另外加的分頁 `[{tabName, keys, headers, rows}]`（例如已改名的舊分頁）。
 * options.maxColumns：每張分頁的欄數（數字，或者「分頁名稱 → 欄數」）；預設 26，與真的新分頁一樣。
 * options.contentFaults：`{failOnSetValue, failOnSetName, failOnDeleteColumns}`，第 N 次寫入格子／改名／刪欄時拋錯。
 * options.attendanceLayout：'rows'＝「崇拜人數」用舊的一個日期一行（測試轉換用）；預設日子橫放。
 * options.otherContentSheets：2026-10-30（「連續到」跨季）另外幾份內容表
 *   `[{quarterId, fileId, content:{分頁: 行}, missing:boolean=, layout:'current'|'v3'=}]`，會登記在 ContentSheets
 *   （ACTIVE=TRUE）；`missing:true`＝登記了但開不到。
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
  ownSheets.ContentSheets = ownSheet('CONTENT_SHEETS', (o.contentSheets === undefined ? [{
    QUARTER_ID: QUARTER_ID, FILE_ID: FAKE_CONTENT_FILE_ID,
    FILE_URL: 'https://docs.google.com/spreadsheets/d/' + FAKE_CONTENT_FILE_ID + '/edit',
    CREATED_AT: '2027-09-01', LAST_IMPORTED_AT: '', INVITE_SENT_AT: '', ACTIVE: true
  }] : o.contentSheets).concat((o.otherContentSheets || []).map(function (c) {
    return {
      QUARTER_ID: c.quarterId, FILE_ID: c.fileId, FILE_URL: 'https://docs.google.com/spreadsheets/d/' + c.fileId + '/edit',
      CREATED_AT: '2027-06-01', LAST_IMPORTED_AT: '', INVITE_SENT_AT: '', ACTIVE: true
    };
  })));

  function rosterSheet(defKey, rows) {
    const keys = Object.keys(boot.ROSTER_TABLE_DEFS_[defKey].columns).concat(Object.keys(boot.ROSTER_TABLE_DEFS_[defKey].optionalColumns || {}));
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
    NameMapping: rosterSheet('NAME_MAPPING', []),
    Posts: rosterSheet('POSTS', [])
  };

  // ---- 內容表 ----
  const layoutDefs = o.contentLayout === 'v1' ? legacyContentTabDefsV1()
    : (o.contentLayout === 'v2' ? legacyContentTabDefsV2(boot.contentSheetTabDefs_())
      : (o.contentLayout === 'v3' ? legacyContentTabDefsV3(boot.contentSheetTabDefs_()) : boot.contentSheetTabDefs_()));
  const knownNames = layoutDefs.map(function (d) { return d.tabName; })
    .concat((o.extraTabs || []).map(function (t) { return t.tabName; }));
  Object.keys(o.content || {}).forEach(function (name) {
    if (knownNames.indexOf(name) === -1) {
      throw new Error('contentEnv：這個版面沒有「' + name + '」這一張分頁（版面：'
        + (o.contentLayout || 'current') + '，有的分頁：' + knownNames.join('、') + '）。');
    }
  });
  const contentFaults = makeContentFaults(o.contentFaults || {});
  function maxColumnsFor(name) {
    if (typeof o.maxColumns === 'number') return o.maxColumns;
    if (o.maxColumns && typeof o.maxColumns[name] === 'number') return o.maxColumns[name];
    return undefined;
  }
  const contentTabs = {};
  const tabList = [];
  layoutDefs.concat(o.extraTabs || []).forEach(function (def) {
    if ((o.omitTabs || []).indexOf(def.tabName) !== -1) return;
    const rows = (o.content || {})[def.tabName] || def.rows || [];
    // 2026-10-30：現行版面的「崇拜人數」是日子橫放（src/ContentSheetTransposed.gs）；`attendanceLayout:'rows'`
    //    或者舊版面（v1／v2／v3）＝舊的一個日期一行。
    const transposed = def.transposed === true && !o.contentLayout && o.attendanceLayout !== 'rows';
    const tab = transposed
      ? makeTransposedTab(def, rows, { name: def.tabName, faults: contentFaults, maxColumns: maxColumnsFor(def.tabName) })
      : makeContentTab(def.keys, def.headers, rows,
        { name: def.tabName, faults: contentFaults, maxColumns: maxColumnsFor(def.tabName) });
    contentTabs[def.tabName] = tab;
    tabList.push(tab);
  });

  const contentSpreadsheet = makeContentSpreadsheet({
    id: FAKE_CONTENT_FILE_ID,
    url: 'https://docs.google.com/spreadsheets/d/' + FAKE_CONTENT_FILE_ID + '/edit',
    tabs: tabList,
    faults: contentFaults
  });
  const realInsert = contentSpreadsheet.insertSheet;
  // 插入的新分頁亦放進 contentTabs（用插入時的名字），測試讀得到。
  // 2026-10-30（內容表 v4）：`keepOriginalTabRefs:true`＝原有的分頁物件保留在 contentTabs（即使之後改了名、
  //    同名建了新分頁）。v2／v3 移轉的測試要看的是移轉之後、轉成 v4 之前的「崇拜程序」（v4 把它改名保留）。
  contentSpreadsheet.insertSheet = function (name) {
    const s = realInsert(name);
    if (!(o.keepOriginalTabRefs === true && contentTabs[name])) contentTabs[name] = s;
    return s;
  };

  const otherSpreadsheets = {};
  // 2026-10-30：另外幾份內容表的「崇拜人數」一律是舊的一個日期一行（上一季未必按過「更新本季內容表…」）。
  (o.otherContentSheets || []).forEach(function (c) {
    if (c.missing) return;
    const defs = c.layout === 'v3' ? legacyContentTabDefsV3(boot.contentSheetTabDefs_()) : boot.contentSheetTabDefs_();
    const tabs = defs.map(function (def) {
      return makeContentTab(def.keys, def.headers, (c.content || {})[def.tabName] || [], { name: def.tabName });
    });
    otherSpreadsheets[c.fileId] = makeContentSpreadsheet({
      id: c.fileId, url: 'https://docs.google.com/spreadsheets/d/' + c.fileId + '/edit', tabs: tabs
    });
  });

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
      if (otherSpreadsheets[id]) return otherSpreadsheets[id];
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

  return {
    sandbox: sandbox, sheets: ownSheets, locks: locks, uiAlerts: uiAlerts, contentTabs: contentTabs,
    contentSpreadsheet: contentSpreadsheet, contentFaults: contentFaults, otherSpreadsheets: otherSpreadsheets
  };
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
  makeTransposedTab: makeTransposedTab,
  baseStubs: baseStubs,
  FAKE_ROSTER_ID: FAKE_ROSTER_ID,
  FAKE_FOLDER_ID: FAKE_FOLDER_ID,
  FAKE_CONTENT_FILE_ID: FAKE_CONTENT_FILE_ID,
  QUARTER_ID: QUARTER_ID,
  SERVICE_DATES: SERVICE_DATES
};
