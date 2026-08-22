#!/usr/bin/env node
/**
 * tests/contentimport.test.js
 *
 * 內容表第二階段（R-011／R-012）的回歸測試：單向匯入與 UI 唯讀化。
 *
 * 最核心的幾條：
 *   - **「連續到」展開**（1–4）：一條連登四週的報告只輸入一次。
 *   - **安全規則**（9、10、11）：內容表某一張整張空白 → 那一張完全不動；
 *     確認之前一格都不會寫。這兩條擋住「有人不小心清空一張表就把整季
 *     內容清光」。
 *   - **冪等**（15）：連續跑兩次，第二次 0 改動。
 *   - **後端硬擋**（21）：只擋前端等於沒有擋。
 *
 * 執行方式：node tests/contentimport.test.js
 * 離開碼：0＝全部通過　1＝有測試失敗
 */

'use strict';

const assert = require('assert');
const { loadAllSrcFilesInOrder } = require('./helpers/loadGas');
const { makeFakeSheet, makeFakeSpreadsheet } = require('./helpers/fakeSpreadsheet');
const { assertWrittenChinese, findColloquial } = require('./helpers/writtenChinese');

const FAKE_ROSTER_ID = 'FAKE_ROSTER_ID_FOR_IMPORT_TESTS';
const FAKE_FOLDER_ID = 'FAKE_CONTENT_FOLDER';
const FAKE_CONTENT_FILE_ID = 'FAKE_CONTENT_FILE';
const QUARTER_ID = '2027T4';
const SERVICE_DATES = ['2027-10-03', '2027-10-10', '2027-10-17', '2027-10-24', '2027-10-31'];

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
// 假替身
// =====================================================================

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

/** 取某一張表 ACTIVE=TRUE 的行，按主日與次序排。 */
function activeRows(env, sheetName) {
  return env.sandbox.readSheet(sheetName)
    .filter(function (r) { return r.ACTIVE === true; })
    .sort(function (a, b) {
      const da = env.sandbox.formatIsoDate_(a.SERVICE_DATE);
      const db = env.sandbox.formatIsoDate_(b.SERVICE_DATE);
      if (da !== db) return da < db ? -1 : 1;
      return Number(a.SEQ_NO || 0) - Number(b.SEQ_NO || 0);
    });
}

// =====================================================================
// 1-4. 「連續到」展開
// =====================================================================

test('1. 「連續到」展開成四個主日', function () {
  const env = makeEnv({});
  const result = env.sandbox.expandRepeatUntilRows_([
    { __rowNo: 3, SERVICE_DATE: '2027-10-03', REPEAT_UNTIL: '2027-10-24', SEQ_NO: '10', TEXT: '連登四週' }
  ], SERVICE_DATES);

  assertArrayEqual(result.rows.map(function (r) { return r.__isoDate; }),
    ['2027-10-03', '2027-10-10', '2027-10-17', '2027-10-24']);
  assertArrayEqual(result.warnings, []);
  // 展開出來的行，SEQ_NO 沿用原行的值。
  result.rows.forEach(function (r) { assert.strictEqual(r.SEQ_NO, '10'); });
});

test('2. REPEAT_UNTIL 留空 → 只出現一次', function () {
  const env = makeEnv({});
  const result = env.sandbox.expandRepeatUntilRows_([
    { __rowNo: 3, SERVICE_DATE: '2027-10-10', REPEAT_UNTIL: '', SEQ_NO: '10', TEXT: '一次' }
  ], SERVICE_DATES);
  assertArrayEqual(result.rows.map(function (r) { return r.__isoDate; }), ['2027-10-10']);
  assertArrayEqual(result.warnings, []);
});

test('3. REPEAT_UNTIL 早過 SERVICE_DATE → 只出現一次，而且有警告', function () {
  const env = makeEnv({});
  const result = env.sandbox.expandRepeatUntilRows_([
    { __rowNo: 5, SERVICE_DATE: '2027-10-17', REPEAT_UNTIL: '2027-10-03', SEQ_NO: '10', TEXT: 'x' }
  ], SERVICE_DATES);
  assertArrayEqual(result.rows.map(function (r) { return r.__isoDate; }), ['2027-10-17']);
  assert.strictEqual(result.warnings.length, 1);
  assert.ok(result.warnings[0].indexOf('早過') !== -1, result.warnings[0]);
});

test('4. REPEAT_UNTIL 不是該季主日 → 取該季內最後一個不遲於它的主日，而且有警告', function () {
  const env = makeEnv({});
  const result = env.sandbox.expandRepeatUntilRows_([
    { __rowNo: 7, SERVICE_DATE: '2027-10-03', REPEAT_UNTIL: '2027-10-20', SEQ_NO: '10', TEXT: 'x' }
  ], SERVICE_DATES);
  // 2027-10-20 不是主日；不遲於它的最後一個主日是 2027-10-17。
  assertArrayEqual(result.rows.map(function (r) { return r.__isoDate; }),
    ['2027-10-03', '2027-10-10', '2027-10-17']);
  assert.strictEqual(result.warnings.length, 1);
  assert.ok(result.warnings[0].indexOf('2027-10-17') !== -1, result.warnings[0]);
});

test('4b. 「連續到」不跨季：超出該季最後一個主日 → 只展開到該季最後一個', function () {
  const env = makeEnv({});
  const result = env.sandbox.expandRepeatUntilRows_([
    { __rowNo: 3, SERVICE_DATE: '2027-10-24', REPEAT_UNTIL: '2027-12-25', SEQ_NO: '10', TEXT: 'x' }
  ], SERVICE_DATES);
  assertArrayEqual(result.rows.map(function (r) { return r.__isoDate; }), ['2027-10-24', '2027-10-31']);
});

// =====================================================================
// 5-6. 崇拜人數的對應
// =====================================================================

test('5. 崇拜人數：崇拜日期 + 7 天對應正確', function () {
  const env = makeEnv({});
  assert.strictEqual(env.sandbox.attendanceDateToServiceDate_('2027-09-26', SERVICE_DATES), '2027-10-03');
  assert.strictEqual(env.sandbox.attendanceDateToServiceDate_('2027-10-24', SERVICE_DATES), '2027-10-31');
});

test('6. 崇拜人數：找不到對應主日 → 略過，而且報告列出', function () {
  const env = makeEnv({
    content: { 崇拜人數: [{ SERVICE_DATE: '2027-12-01', ATT_ENG_WORSHIP: '50', ACTIVE: 'TRUE' }] }
  });
  const result = env.sandbox.previewContentImport_(QUARTER_ID, {});
  assert.strictEqual(result.ok, true, JSON.stringify(result));
  assert.strictEqual(result.plan.updated, 0, '對不上就不應該改任何嘢');
  assert.ok(result.plan.warnings.some(function (w) { return w.indexOf('2027-12-01') !== -1; }),
    JSON.stringify(result.plan.warnings));
});

// =====================================================================
// 7-8. 差異與「刪除」
// =====================================================================

test('7. 差異：新增／修改／刪除／不變四個數字正確', function () {
  const env = makeEnv({
    announcements: [
      // 第 1 行內容一樣（不變）、第 2 行內容不同（修改）、第 3 行內容表沒有（刪除）
      { SERVICE_DATE: '2027-10-03', SEQ_NO: 10, TEXT: '甲', ACTIVE: true },
      { SERVICE_DATE: '2027-10-03', SEQ_NO: 20, TEXT: '舊的乙', ACTIVE: true },
      { SERVICE_DATE: '2027-10-03', SEQ_NO: 30, TEXT: '丙', ACTIVE: true }
    ],
    content: {
      家事報告: [
        { SERVICE_DATE: '2027-10-03', SEQ_NO: '10', TEXT: '甲', ACTIVE: 'TRUE' },
        { SERVICE_DATE: '2027-10-03', SEQ_NO: '20', TEXT: '新的乙', ACTIVE: 'TRUE' },
        { SERVICE_DATE: '2027-10-10', SEQ_NO: '10', TEXT: '下週新增', ACTIVE: 'TRUE' }
      ]
    }
  });

  const result = env.sandbox.previewContentImport_(QUARTER_ID, {});
  assert.strictEqual(result.plan.unchanged, 1, '甲沒有變');
  assert.strictEqual(result.plan.updated, 1, '乙的內容改了');
  assert.strictEqual(result.plan.removed, 1, '丙在內容表已經沒有');
  assert.strictEqual(result.plan.added, 1, '下週那一則是新增');
});

test('8. 「刪除」只把 ACTIVE 改 FALSE，行仍然在', function () {
  const env = makeEnv({
    announcements: [{ SERVICE_DATE: '2027-10-03', SEQ_NO: 10, TEXT: '要被停用的', ACTIVE: true }],
    content: { 家事報告: [{ SERVICE_DATE: '2027-10-10', SEQ_NO: '10', TEXT: '別週的', ACTIVE: 'TRUE' }] }
  });

  env.sandbox.applyContentImport_(QUARTER_ID, {});

  const rows = env.sandbox.readSheet('Announcements');
  const stale = rows.filter(function (r) { return r.TEXT === '要被停用的'; });
  assert.strictEqual(stale.length, 1, '整行仍然在');
  assert.strictEqual(stale[0].ACTIVE, false, '只是 ACTIVE 改成 FALSE');
});

// =====================================================================
// 9-11. 安全規則
// =====================================================================

test('9. 內容表某張表整張空白 → 該張完全不動，報告有說明', function () {
  const env = makeEnv({
    announcements: [{ SERVICE_DATE: '2027-10-03', SEQ_NO: 10, TEXT: '本來就有的', ACTIVE: true }],
    content: { 宣召: [{ SERVICE_DATE: '2027-10-03', CALL_REF: '詩篇 100:1', CALL_TEXT: '經文', ACTIVE: 'TRUE' }] }
  });

  const result = env.sandbox.previewContentImport_(QUARTER_ID, {});
  assert.ok(result.plan.skippedTabs.indexOf('家事報告') !== -1, JSON.stringify(result.plan.skippedTabs));
  assert.strictEqual(result.plan.removed, 0, '整張空白絕對不可以當成「全部刪除」');

  env.sandbox.applyContentImport_(QUARTER_ID, {});
  const rows = env.sandbox.readSheet('Announcements');
  assert.strictEqual(rows[0].ACTIVE, true, '本來就有的那一行一定要原封不動');

  const lines = env.sandbox.buildContentImportDialogLines_(result, {}).join('\n');
  assert.ok(lines.indexOf('家事報告：內容表沒有資料，本次不改動') !== -1, lines);
});

test('10. 內容表全部空白 → 週報一格都沒有改', function () {
  const env = makeEnv({
    announcements: [{ SERVICE_DATE: '2027-10-03', SEQ_NO: 10, TEXT: '甲', ACTIVE: true }],
    prayers: [{ SERVICE_DATE: '2027-10-03', SEQ_NO: 10, TEXT: '乙', ACTIVE: true }],
    content: {}
  });

  const before = JSON.stringify(env.sandbox.readSheet('Announcements'))
    + JSON.stringify(env.sandbox.readSheet('Prayers'))
    + JSON.stringify(env.sandbox.readSheet('BulletinWeeks'));

  const result = env.sandbox.applyContentImport_(QUARTER_ID, {});
  assert.strictEqual(result.plan.added + result.plan.updated + result.plan.removed, 0);
  assert.strictEqual(result.plan.skippedTabs.length, 6, '六張分頁全部整張空白');

  const after = JSON.stringify(env.sandbox.readSheet('Announcements'))
    + JSON.stringify(env.sandbox.readSheet('Prayers'))
    + JSON.stringify(env.sandbox.readSheet('BulletinWeeks'));
  assert.strictEqual(after, before, '一格都不可以改');
});

test('11. 確認之前沒有任何寫入（previewContentImport_ 是唯讀的）', function () {
  const env = makeEnv({
    content: {
      家事報告: [{ SERVICE_DATE: '2027-10-03', SEQ_NO: '10', TEXT: '新的一則', ACTIVE: 'TRUE' }],
      宣召: [{ SERVICE_DATE: '2027-10-03', CALL_REF: '詩篇', CALL_TEXT: '經文', ACTIVE: 'TRUE' }]
    }
  });

  const result = env.sandbox.previewContentImport_(QUARTER_ID, {});
  assert.ok(result.plan.added + result.plan.updated > 0, '應該算得出有改動');

  assert.strictEqual(env.sandbox.readSheet('Announcements').length, 0, '預覽不可以寫任何嘢');
  assert.strictEqual(env.sandbox.readSheet('BulletinWeeks')[0].CALL_REF, '');
  assert.strictEqual(env.sandbox.readSheet('AuditLog').length, 0);
  assert.strictEqual(env.sandbox.readSheet('ContentSheets')[0].LAST_IMPORTED_AT, null);
});

// =====================================================================
// 12-15. 寫入之後
// =====================================================================

test('12. 匯入後 AuditLog 有逐格記錄，來源 CONTENT_SHEET', function () {
  const env = makeEnv({
    content: { 宣召: [{ SERVICE_DATE: '2027-10-03', CALL_REF: '詩篇 100:1-2', CALL_TEXT: '普天下當向耶和華歡呼！', ACTIVE: 'TRUE' }] }
  });

  env.sandbox.applyContentImport_(QUARTER_ID, {});

  const audit = env.sandbox.readSheet('AuditLog')
    .filter(function (r) { return r.ACTION === 'CONTENT_SHEET_IMPORT'; });
  assert.strictEqual(audit.length, 2, '兩個欄位各一筆');
  const fields = audit.map(function (r) { return r.FIELD; }).sort();
  assertArrayEqual(fields, ['CALL_REF', 'CALL_TEXT']);
  audit.forEach(function (r) {
    assert.strictEqual(r.SHEET_NAME, 'BulletinWeeks');
    assert.strictEqual(r.ROW_KEY, '2027-10-03');
  });
});

test('13. 匯入後 LAST_IMPORTED_AT 有更新', function () {
  const env = makeEnv({
    content: { 宣召: [{ SERVICE_DATE: '2027-10-03', CALL_REF: 'x', CALL_TEXT: 'y', ACTIVE: 'TRUE' }] }
  });
  assert.strictEqual(env.sandbox.readSheet('ContentSheets')[0].LAST_IMPORTED_AT, null);

  env.sandbox.applyContentImport_(QUARTER_ID, {});
  const after = env.sandbox.readSheet('ContentSheets')[0].LAST_IMPORTED_AT;
  assert.strictEqual(Object.prototype.toString.call(after), '[object Date]', '實際：' + after);
});

test('14. 只匯入一個主日 → 其他主日不受影響', function () {
  const env = makeEnv({
    announcements: [
      { SERVICE_DATE: '2027-10-03', SEQ_NO: 10, TEXT: '第一週舊的', ACTIVE: true },
      { SERVICE_DATE: '2027-10-10', SEQ_NO: 10, TEXT: '第二週舊的', ACTIVE: true }
    ],
    content: {
      家事報告: [
        { SERVICE_DATE: '2027-10-03', SEQ_NO: '10', TEXT: '第一週新的', ACTIVE: 'TRUE' },
        { SERVICE_DATE: '2027-10-10', SEQ_NO: '10', TEXT: '第二週新的', ACTIVE: 'TRUE' }
      ]
    }
  });

  env.sandbox.applyContentImport_(QUARTER_ID, { isoDate: '2027-10-03' });

  const rows = activeRows(env, 'Announcements');
  assert.strictEqual(rows[0].TEXT, '第一週新的', '選中的主日要更新');
  assert.strictEqual(rows[1].TEXT, '第二週舊的', '其他主日一格都不可以動');
});

test('14b. 只匯入一個主日：由上一週「連續到」過來的報告一樣會出現', function () {
  // ⚠️ 「連續到」一定要用**整季**的主日展開，之後才篩出要匯入的那一個主日。
  // 如果只用單一主日去展開，一條由 10-03 連登到 10-24 的報告，在匯入 10-17
  // 那一次就會完全消失。
  const env = makeEnv({
    content: {
      家事報告: [{ SERVICE_DATE: '2027-10-03', REPEAT_UNTIL: '2027-10-24', SEQ_NO: '10', TEXT: '連登四週', ACTIVE: 'TRUE' }]
    }
  });

  env.sandbox.applyContentImport_(QUARTER_ID, { isoDate: '2027-10-17' });

  const rows = activeRows(env, 'Announcements');
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(env.sandbox.formatIsoDate_(rows[0].SERVICE_DATE), '2027-10-17');
  assert.strictEqual(rows[0].TEXT, '連登四週');
});

test('15. 整季匯入冪等：連續跑兩次，第二次 0 改動', function () {
  const env = makeEnv({
    content: {
      家事報告: [
        { SERVICE_DATE: '2027-10-03', REPEAT_UNTIL: '2027-10-17', SEQ_NO: '10', TEXT: '連登三週', ACTIVE: 'TRUE' },
        { SERVICE_DATE: '2027-10-03', SEQ_NO: '20', TEXT: '只此一次', ACTIVE: 'TRUE' }
      ],
      代禱事項: [{ SERVICE_DATE: '2027-10-10', SEQ_NO: '10', TEXT: '代禱', ACTIVE: 'TRUE' }],
      團契聚會: [{ SERVICE_DATE: '2027-10-03', SEQ_NO: '10', NAME: '彼得團', DATE_TEXT: '28/11 星期日', TIME_TEXT: '4:30pm', CONTENT: '查經', ACTIVE: 'TRUE' }],
      財政報告: [{ SERVICE_DATE: '2027-10-03', SEQ_NO: '10', ROW_LABEL: '奉獻', COL1: '$6.42', COL2: '--', COL3: '1', COL4: '2', ACTIVE: 'TRUE' }],
      崇拜人數: [{ SERVICE_DATE: '2027-09-26', ATT_ENG_WORSHIP: '57', ATT_CANE_WORSHIP: '前:5 / 後:120', ACTIVE: 'TRUE' }],
      宣召: [{ SERVICE_DATE: '2027-10-03', CALL_REF: '詩篇 100:1-2', CALL_TEXT: '經文', ACTIVE: 'TRUE' }]
    }
  });

  const first = env.sandbox.applyContentImport_(QUARTER_ID, {});
  assert.ok(first.plan.added + first.plan.updated > 0, '第一次一定有改動');

  const second = env.sandbox.previewContentImport_(QUARTER_ID, {});
  assert.strictEqual(second.plan.added, 0);
  assert.strictEqual(second.plan.updated, 0);
  assert.strictEqual(second.plan.removed, 0);
  assert.strictEqual(second.plan.details.length, 0, '第二次不可以有任何明細：'
    + JSON.stringify(second.plan.details.slice(0, 3)));
});

// =====================================================================
// 16-20. 個別欄位的規則
// =====================================================================

test('16. 內容表檔案不存在 → 明確錯誤訊息，不拋原始例外', function () {
  const env = makeEnv({ contentFileMissing: true });
  let result;
  assert.doesNotThrow(function () { result = env.sandbox.previewContentImport_(QUARTER_ID, {}); });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'FILE_MISSING');
  assert.ok(result.message.indexOf('ContentSheets') !== -1, '要指出是哪一行：' + result.message);
  assert.ok(result.message.indexOf(QUARTER_ID) !== -1);
  assert.strictEqual(result.message.indexOf(FAKE_CONTENT_FILE_ID), -1, '訊息不應該有完整檔案 ID');
});

test('16b. 該季未建立內容表 → 明確錯誤，叫人先建立', function () {
  const env = makeEnv({ contentSheets: [] });
  const result = env.sandbox.previewContentImport_(QUARTER_ID, {});
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'NO_CONTENT_SHEET');
  assert.ok(result.message.indexOf('建立本季內容表') !== -1, result.message);
});

test('17. 財政：TITLE_OVERRIDE 有值不會寫進 Finance（那張表沒有這一欄），四個數字欄照樣對應', function () {
  const env = makeEnv({
    content: {
      財政報告: [{
        SERVICE_DATE: '2027-10-03', SEQ_NO: '10', TITLE_OVERRIDE: '特殊海外奉獻及慈惠基金財政報告',
        ROW_LABEL: '奉獻', COL1: '$6.42', COL2: '$3,491.40', COL3: '', COL4: '', ACTIVE: 'TRUE'
      }]
    }
  });

  env.sandbox.applyContentImport_(QUARTER_ID, {});

  const rows = activeRows(env, 'Finance');
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].ROW_LABEL, '奉獻');
  assert.strictEqual(rows[0].COL_SPECIAL_OVERSEAS, '$6.42', 'COL1 對應 COL_SPECIAL_OVERSEAS');
  assert.strictEqual(rows[0].COL_HARDSHIP, '$3,491.40', 'COL2 對應 COL_HARDSHIP');
  assert.strictEqual(rows[0].COL3, '', '第二種財政表只填頭兩欄，其餘要留空');
  assert.strictEqual(rows[0].COL4, '');
});

test('17b. 財政：TITLE_OVERRIDE 留空 → 不會影響 FINANCE_TITLE（仍然由 Config 樣式產生）', function () {
  const env = makeEnv({
    content: {
      財政報告: [{ SERVICE_DATE: '2027-10-03', SEQ_NO: '10', TITLE_OVERRIDE: '', ROW_LABEL: '奉獻', COL1: '1', ACTIVE: 'TRUE' }]
    }
  });
  env.sandbox.applyContentImport_(QUARTER_ID, {});

  // FINANCE_TITLE 是渲染時由 Config 樣式加「上一個月」算出來的，匯入不會碰它。
  const context = env.sandbox.buildRenderContext_({ isoDate: '2027-10-03' }, {});
  assert.strictEqual(context.values.FINANCE_TITLE, '聖道堂綜合收支財務報告-2027年 9月份');
});

test('18. 團契：日期與時間維持原樣文字，不會變成日期物件', function () {
  const env = makeEnv({
    content: {
      團契聚會: [{
        SERVICE_DATE: '2027-10-03', SEQ_NO: '10', NAME: '彼得團',
        DATE_TEXT: '28/11 星期日', TIME_TEXT: '4:30pm', CONTENT: '講道分享', ACTIVE: 'TRUE'
      }]
    }
  });
  env.sandbox.applyContentImport_(QUARTER_ID, {});

  const row = activeRows(env, 'Fellowships')[0];
  assert.strictEqual(row.MEETING_DATE, '28/11 星期日');
  assert.strictEqual(typeof row.MEETING_DATE, 'string', '不可以變成 Date');
  assert.strictEqual(row.MEETING_TIME, '4:30pm');
  assert.strictEqual(typeof row.MEETING_TIME, 'string');
});

test('19. 人數十二格維持原樣文字，-- 與「前:5 / 後:120」不變', function () {
  const env = makeEnv({
    content: {
      崇拜人數: [{
        SERVICE_DATE: '2027-09-26',
        ATT_ENG_WORSHIP: '57', ATT_CANE_WORSHIP: '前:5 / 後:120',
        ATT_CANN_WORSHIP: '--', ATT_MAN_WORSHIP: '43',
        ACTIVE: 'TRUE'
      }]
    }
  });
  env.sandbox.applyContentImport_(QUARTER_ID, {});

  const week = env.sandbox.readSheet('BulletinWeeks')
    .filter(function (r) { return env.sandbox.formatIsoDate_(r.SERVICE_DATE) === '2027-10-03'; })[0];
  assert.strictEqual(week.ATT_ENG_WORSHIP, '57');
  assert.strictEqual(week.ATT_CANE_WORSHIP, '前:5 / 後:120', '原樣保存，不可以被轉成數字');
  assert.strictEqual(week.ATT_CANN_WORSHIP, '--');
  assert.strictEqual(typeof week.ATT_ENG_WORSHIP, 'string');
});

test('20. 宣召兩欄寫入 BulletinWeeks', function () {
  const env = makeEnv({
    content: {
      宣召: [{ SERVICE_DATE: '2027-10-10', CALL_REF: '詩篇 100:1-2', CALL_TEXT: '普天下當向耶和華歡呼！', ACTIVE: 'TRUE' }]
    }
  });
  env.sandbox.applyContentImport_(QUARTER_ID, {});

  const week = env.sandbox.readSheet('BulletinWeeks')
    .filter(function (r) { return env.sandbox.formatIsoDate_(r.SERVICE_DATE) === '2027-10-10'; })[0];
  assert.strictEqual(week.CALL_REF, '詩篇 100:1-2');
  assert.strictEqual(week.CALL_TEXT, '普天下當向耶和華歡呼！');
});

// =====================================================================
// 21-24. 後端硬擋、共用入口、真正入口、報告上限
// =====================================================================

test('21. apiSaveWeek() 收到七個唯讀區塊的欄位 → 回傳錯誤，沒有寫入', function () {
  const env = makeEnv({});
  const payload = {
    isoDate: '2027-10-03', lastSavedAt: null,
    week: { SERMON_TITLE: '想順手改埋', ATT_ENG_WORSHIP: '99', CALL_REF: '想改宣召' },
    announcements: [{ seqNo: null, TEXT: '想由介面新增' }]
  };

  const resp = env.sandbox.apiSaveWeek(payload);
  assert.strictEqual(resp.ok, false, JSON.stringify(resp));
  assert.strictEqual(resp.error.code, 'CONTENT_SHEET_READONLY');
  ['ATT_ENG_WORSHIP', 'CALL_REF', 'announcements'].forEach(function (k) {
    assert.ok(resp.error.message.indexOf(k) !== -1, '訊息要列出是哪幾個欄位：' + resp.error.message);
  });

  assert.strictEqual(env.sandbox.readSheet('BulletinWeeks')[0].SERMON_TITLE, '',
    '拒絕之後連其他欄位都不可以寫進去');
  assert.strictEqual(env.sandbox.readSheet('Announcements').length, 0);
});

test('21b. 七個唯讀區塊的欄位清單由 contentImportTargets_() 衍生，不是另抄一份', function () {
  const env = makeEnv({});
  const owned = env.sandbox.contentSheetOwnedWeekKeys_();
  const attKeys = env.sandbox.COLUMNS.BULLETIN_WEEKS.keys.filter(function (k) { return /^ATT_/.test(k); });

  attKeys.forEach(function (k) { assert.ok(owned.indexOf(k) !== -1, k + ' 應該被接管'); });
  assert.ok(owned.indexOf('CALL_REF') !== -1);
  assert.ok(owned.indexOf('CALL_TEXT') !== -1);
  assert.ok(owned.indexOf('ATTENDANCE_DATE') !== -1);
  assert.strictEqual(owned.indexOf('SERMON_TITLE'), -1, '講題仍然可以在介面編輯');

  assertArrayEqual(env.sandbox.contentSheetOwnedListTypes_().slice().sort(),
    ['announcements', 'fellowships', 'finance', 'prayers']);
});

test('22. 選單入口與 Web App 按鈕呼叫同一個函式', function () {
  const env = makeEnv({
    content: { 宣召: [{ SERVICE_DATE: '2027-10-03', CALL_REF: 'a', CALL_TEXT: 'b', ACTIVE: 'TRUE' }] }
  });

  // 反向鎖：把共用的 previewContentImport_ 換成一個假實作，兩個入口都要
  // 跟着變——只要其中一個自己另寫一套，這條測試就會失敗。
  let calls = 0;
  const original = env.sandbox.previewContentImport_;
  env.sandbox.previewContentImport_ = function (quarterId, options) {
    calls++;
    return original(quarterId, options);
  };

  env.sandbox.menuImportFromContentSheet_();
  assert.ok(calls > 0, '選單入口要經過 previewContentImport_');

  const before = calls;
  env.sandbox.apiPreviewContentImport('2027-10-03');
  assert.ok(calls > before, 'Web App 入口一樣要經過同一個函式');
});

test('23. 由真正入口跑一次整季匯入，不拋錯，而且真的寫入', function () {
  const env = makeEnv({
    content: {
      家事報告: [{ SERVICE_DATE: '2027-10-03', SEQ_NO: '10', TEXT: '第一則', ACTIVE: 'TRUE' }],
      宣召: [{ SERVICE_DATE: '2027-10-03', CALL_REF: '詩篇', CALL_TEXT: '經文', ACTIVE: 'TRUE' }]
    }
  });

  assert.doesNotThrow(function () { env.sandbox.menuImportFromContentSheet_(); });

  assert.strictEqual(activeRows(env, 'Announcements').length, 1);
  assert.strictEqual(env.sandbox.readSheet('BulletinWeeks')[0].CALL_REF, '詩篇');
  assert.strictEqual(env.sandbox.readSheet('ErrorLog').length, 0);

  const titles = env.uiAlerts.map(function (a) { return a.title; });
  assert.ok(titles.indexOf('匯入完成') !== -1, JSON.stringify(titles));
});

test('23b. 選單：使用者在確認對話框選「否」→ 一格都不會寫', function () {
  const env = makeEnv({
    uiConfirm: 'NO',
    content: { 家事報告: [{ SERVICE_DATE: '2027-10-03', SEQ_NO: '10', TEXT: '第一則', ACTIVE: 'TRUE' }] }
  });

  env.sandbox.menuImportFromContentSheet_();
  assert.strictEqual(env.sandbox.readSheet('Announcements').length, 0, '確認之前一格都不可以寫');
  assert.strictEqual(env.sandbox.readSheet('ContentSheets')[0].LAST_IMPORTED_AT, null);
});

test('23c. 匯入包在 LockService 內，而且一定會釋放', function () {
  const env = makeEnv({
    content: { 宣召: [{ SERVICE_DATE: '2027-10-03', CALL_REF: 'a', CALL_TEXT: 'b', ACTIVE: 'TRUE' }] }
  });
  env.sandbox.applyContentImport_(QUARTER_ID, {});
  assert.strictEqual(env.locks.tried, 1);
  assert.strictEqual(env.locks.released, 1, '拿了鎖一定要放返');
});

test('23d. 拿不到鎖 → 明確錯誤，不會半途寫入', function () {
  const env = makeEnv({
    lockFails: true,
    content: { 宣召: [{ SERVICE_DATE: '2027-10-03', CALL_REF: 'a', CALL_TEXT: 'b', ACTIVE: 'TRUE' }] }
  });
  assert.throws(function () { env.sandbox.applyContentImport_(QUARTER_ID, {}); },
    function (err) { return err.code === 'LOCK_TIMEOUT'; });
  assert.strictEqual(env.sandbox.readSheet('BulletinWeeks')[0].CALL_REF, '');
});

test('24. Diagnostics 的匯入預覽不超過 DIAGNOSTICS_MAX_ROWS', function () {
  // 造大量差異：五個主日 × 每個主日 30 則家事報告。
  const rows = [];
  SERVICE_DATES.forEach(function (iso) {
    for (let i = 1; i <= 30; i++) {
      rows.push({ SERVICE_DATE: iso, SEQ_NO: String(i * 10), TEXT: iso + ' 第 ' + i + ' 則', ACTIVE: 'TRUE' });
    }
  });

  const env = makeEnv({ config: { DIAGNOSTICS_MAX_ROWS: '40' }, content: { 家事報告: rows } });
  const preview = env.sandbox.previewContentImport_(QUARTER_ID, {});
  assert.ok(preview.plan.details.length > 40, '應該造出遠多於上限的明細');

  env.sandbox.writeDiagnosticsReport_('內容表匯入預覽', env.sandbox.buildContentImportReportLines_(preview));
  const diagnostics = env.sandbox.readSheet('Diagnostics');
  assert.ok(diagnostics.length <= 40, '實際：' + diagnostics.length);
});

test('24b. 對話框只列前 20 行明細，其餘註明已寫入 Diagnostics', function () {
  const rows = [];
  for (let i = 1; i <= 40; i++) {
    rows.push({ SERVICE_DATE: '2027-10-03', SEQ_NO: String(i * 10), TEXT: '第 ' + i + ' 則', ACTIVE: 'TRUE' });
  }
  const env = makeEnv({ content: { 家事報告: rows } });
  const preview = env.sandbox.previewContentImport_(QUARTER_ID, {});
  const lines = env.sandbox.buildContentImportDialogLines_(preview, {});

  const detailLines = lines.filter(function (l) { return l.indexOf('　新增　') !== -1; });
  assert.strictEqual(detailLines.length, 20, '對話框只可以列 20 行，實際：' + detailLines.length);
  assert.ok(lines.join('\n').indexOf('已寫入 Diagnostics') !== -1);
});

// =====================================================================
// 25. 使用者可見文字一律書面語
// =====================================================================

test('25. _說明 全份沒有口語字', function () {
  const env = makeEnv({});
  const lines = env.sandbox.buildContentSheetInstructionLines_({
    quarterId: QUARTER_ID, serviceDates: SERVICE_DATES,
    owners: { 家事報告: '幹事', 代禱事項: '堂委' },
    deadlineNote: '請於該主日之前的星期三下午 5 時前填妥',
    adminContact: '幹事', seededSample: true
  });
  assertWrittenChinese(assert, '_說明 分頁', lines);
});

test('25b. 內容表六張分頁的說明、標題、A1 註解一律書面語', function () {
  const env = makeEnv({});
  const texts = [];
  env.sandbox.contentSheetTabDefs_().forEach(function (def) {
    texts.push(def.tabName);
    texts.push(def.note);
    def.headers.forEach(function (h) { texts.push(h); });
    texts.push(env.sandbox.buildContentSheetTabNote_(def, { 家事報告: '幹事' }, '截止日期'));
  });
  assertWrittenChinese(assert, '內容表分頁文字', texts);
});

test('25c. 邀請信與各對話框文字一律書面語', function () {
  const env = makeEnv({
    content: { 家事報告: [{ SERVICE_DATE: '2027-10-03', SEQ_NO: '10', TEXT: 'x', ACTIVE: 'TRUE' }] }
  });
  const texts = [];

  texts.push(env.sandbox.buildContentSheetInviteHtml_({
    quarterId: QUARTER_ID, fileUrl: 'https://x', serviceDates: SERVICE_DATES,
    owners: { 家事報告: '幹事' }, deadlineNote: '截止', churchName: '教會'
  }));

  texts.push(env.sandbox.checkContentSheetFolderConfigured_('').message);
  texts.push(env.sandbox.previewContentImport_('2099T9', {}).message);
  texts.push(env.sandbox.buildContentSheetResultLines_({
    quarterId: QUARTER_ID, created: false, serviceDateCount: 5,
    tabsCreated: ['家事報告'], fileUrl: 'u', seededSample: false,
    sharingApplied: false, sharingError: ''
  }).join('\n'));
  texts.push(env.sandbox.buildContentSheetResultLines_({
    quarterId: QUARTER_ID, created: true, serviceDateCount: 5,
    tabsCreated: ['家事報告'], fileUrl: 'u', seededSample: true,
    sharingApplied: true, sharingError: ''
  }).join('\n'));

  const preview = env.sandbox.previewContentImport_(QUARTER_ID, {});
  texts.push(env.sandbox.buildContentImportDialogLines_(preview, { dryRun: true, applied: false }).join('\n'));
  texts.push(env.sandbox.buildContentImportReportLines_(preview).join('\n'));

  assertWrittenChinese(assert, '邀請信與對話框', texts);
});

test('25d. 後端拒絕儲存的錯誤訊息一律書面語', function () {
  const env = makeEnv({});
  const resp = env.sandbox.apiSaveWeek({
    isoDate: '2027-10-03', lastSavedAt: null, week: { ATT_ENG_WORSHIP: '9' }
  });
  assertWrittenChinese(assert, 'CONTENT_SHEET_READONLY 訊息', resp.error.message);
});

test('25e. 這個檢查本身有效（反向鎖：口語字真的捉得到）', function () {
  const hits = findColloquial('呢個檔案係畀堂委輸入嘅');
  assert.ok(hits.length >= 4, '應該捉到「呢」「係」「畀」「嘅」，實際：' + JSON.stringify(hits.map(function (h) { return h.char; })));
  assert.strictEqual(findColloquial('這個檔案供堂委輸入。').length, 0, '正常書面語不可以被誤判');
  assert.strictEqual(findColloquial('兩者的關係密切').length, 0, '「關係」是正常書面詞，不可以被當成口語');
});

// =====================================================================

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
