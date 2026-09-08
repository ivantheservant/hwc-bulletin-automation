#!/usr/bin/env node
/**
 * tests/fieldoverride.test.js
 *
 * **R-039 至 R-047 ＋ D 系列**的回歸測試。核心是**第三種欄位模式**
 * （內容表為來源、介面可覆寫），規則照抄 `src/DutyOverride.gs` 那五條。
 *
 * 最要緊的幾條：
 *
 *   - **§4.0 首次刷新回填**（第 1 組）：做錯會**清空真實資料**。九個欄位
 *     由「介面填」改成「內容表為來源」，而新分頁一建立就是空的——不回填
 *     的話，第一次整季匯入就把那九欄全部變成空白。
 *   - **覆寫不被蓋**（第 2 組）：內容表改值 → 匯入 → 有覆寫那格不變，
 *     差異報告出現 CONFLICT。
 *   - **下週事奉雙向**（第 4 組）：同一格在兩個畫面出現，必須寫同一筆
 *     記錄。鍵本來就帶主日日期，**正因為不用改結構才最容易寫錯**。
 *   - **D-7**：職事表齊晒時，「仍有 N 格空白」不可以把平常主日本來就該
 *     空白的 `SPECIAL_TYPE` 算進去。
 *
 * 執行方式：node tests/fieldoverride.test.js
 * 離開碼：0＝全部通過　1＝有測試失敗
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { loadAllSrcFilesInOrder } = require('./helpers/loadGas');
const { makeFakeSheet, makeFakeSpreadsheet } = require('./helpers/fakeSpreadsheet');

const FAKE_ROSTER_ID = 'FAKE_ROSTER_ID_FOR_FIELD_OVERRIDE';
const FAKE_FOLDER_ID = 'FAKE_CONTENT_FOLDER';
const FAKE_CONTENT_FILE_ID = 'FAKE_CONTENT_FILE';
const QUARTER_ID = '2027T4';
const SERVICE_DATES = ['2027-10-03', '2027-10-10', '2027-10-17', '2027-10-24', '2027-10-31'];
const D1 = SERVICE_DATES[0];
const D2 = SERVICE_DATES[1];

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

function srcText(name) {
  return fs.readFileSync(path.join(__dirname, '..', 'src', name), 'utf8');
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
    getLastColumn: function () { return Math.max(1, keys.length); },
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
        setValues: function (vals) {
          // ⚠️ 要真的寫落去：§4.0 的回填測試靠讀返出嚟先驗得到。
          (vals || []).forEach(function (rowVals, i) {
            const target = r - 1 + i;
            if (!data[target]) data[target] = [];
            rowVals.forEach(function (v, j) { data[target][c - 1 + j] = v; });
          });
          return range;
        },
        getValue: function () { const s = data[r - 1]; return s && s[c - 1] !== undefined ? s[c - 1] : ''; },
        setValue: function (v) {
          if (!data[r - 1]) data[r - 1] = [];
          data[r - 1][c - 1] = v;
          return range;
        },
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
        setFontSize: function () { return range; },
        setHorizontalAlignment: function () { return range; },
        setVerticalAlignment: function () { return range; }
      };
      return range;
    }
  };
  return sheet;
}

function makeEnv(options) {
  const o = options || {};
  const boot = loadAllSrcFilesInOrder(baseStubs());

  const cfg = {};
  boot.DEFAULTS.forEach(function (d) { cfg[d.key] = d.value; });
  cfg.ROSTER_SPREADSHEET_ID = FAKE_ROSTER_ID;
  cfg.CONTENT_SHEET_FOLDER_ID = FAKE_FOLDER_ID;
  cfg.WORKING_QUARTER_ID = QUARTER_ID;
  Object.assign(cfg, o.config || {});

  function ownSheet(sheetId, rows) {
    const def = boot.COLUMNS[sheetId];
    return makeFakeSheet(def.headers, def.keys, rows || []);
  }

  const ownSheets = {};
  Object.keys(boot.SHEETS).forEach(function (id) { ownSheets[boot.SHEETS[id]] = ownSheet(id, []); });
  Object.keys(ownSheets).forEach(function (name) {
    if (ownSheets[name].setName) ownSheets[name].setName(name);
  });

  ownSheets.Config = ownSheet('CONFIG', Object.keys(cfg).map(function (k) {
    return { KEY: k, VALUE: cfg[k], NOTE: '', EDITABLE: true };
  }));
  ownSheets.BulletinWeeks = ownSheet('BULLETIN_WEEKS',
    o.weekRows === undefined
      ? SERVICE_DATES.map(function (iso, i) {
        return { SERVICE_DATE: iso, QUARTER_ID: QUARTER_ID, WEEK_OF_MONTH: (i % 4) + 1, STATUS: 'DRAFT' };
      })
      : o.weekRows);
  ownSheets.FieldOverride = ownSheet('FIELD_OVERRIDE', o.fieldOverride || []);
  ownSheets.DutyOverride = ownSheet('DUTY_OVERRIDE', o.dutyOverride || []);
  ownSheets.ContentSheets = ownSheet('CONTENT_SHEETS', [{
    QUARTER_ID: QUARTER_ID, FILE_ID: FAKE_CONTENT_FILE_ID,
    FILE_URL: 'https://docs.google.com/spreadsheets/d/' + FAKE_CONTENT_FILE_ID + '/edit',
    CREATED_AT: '2027-09-01', LAST_IMPORTED_AT: '', INVITE_SENT_AT: '', ACTIVE: true
  }]);
  ownSheets.EmailTemplates = ownSheet('EMAIL_TEMPLATES', boot.seedEmailTemplatesRows_());
  ownSheets.PersonDisplay = ownSheet('PERSON_DISPLAY', []);
  ownSheets.PostDisplay = ownSheet('POST_DISPLAY', boot.seedPostDisplayRows_ ? boot.seedPostDisplayRows_() : []);

  function rosterSheet(defKey, rows) {
    const keys = Object.keys(boot.ROSTER_TABLE_DEFS_[defKey].columns);
    return makeFakeSheet(keys, keys, rows || []);
  }
  const rosterSheets = {
    RosterAssignments: rosterSheet('ASSIGNMENTS', o.assignments || []),
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
    Posts: rosterSheet('POSTS', o.posts || [])
  };

  const contentTabs = {};
  boot.contentSheetTabDefs_().forEach(function (def) {
    const tab = makeContentTab(def.keys, def.headers, (o.content || {})[def.tabName] || []);
    tab.__name = def.tabName;
    // §4.0 的測試要模擬「這一張分頁根本未建立」。
    if ((o.missingTabs || []).indexOf(def.tabName) === -1) contentTabs[def.tabName] = tab;
  });
  const contentSpreadsheet = {
    getId: function () { return FAKE_CONTENT_FILE_ID; },
    getUrl: function () { return 'https://docs.google.com/spreadsheets/d/' + FAKE_CONTENT_FILE_ID + '/edit'; },
    getSheetByName: function (name) { return contentTabs[name] || null; },
    getSheets: function () { return Object.keys(contentTabs).map(function (n) { return contentTabs[n]; }); },
    setActiveSheet: function () {},
    moveActiveSheet: function () {},
    insertSheet: function (name) {
      const def = boot.contentSheetTabDefs_().filter(function (d) { return d.tabName === name; })[0];
      const t = makeContentTab(def ? def.keys : [], def ? def.headers : [], []);
      t.__name = name;
      contentTabs[name] = t;
      return t;
    }
  };

  const FakeSpreadsheetApp = {
    getActiveSpreadsheet: function () { return makeFakeSpreadsheet(ownSheets); },
    openById: function (id) {
      if (id === FAKE_ROSTER_ID) return makeFakeSpreadsheet(rosterSheets);
      if (id === FAKE_CONTENT_FILE_ID) return contentSpreadsheet;
      throw new Error('openById: 找不到 ' + id);
    },
    create: function () { throw new Error('這一組測試不應該建立新試算表'); },
    newDataValidation: function () {
      const b = {
        requireValueInList: function () { return b; },
        setAllowInvalid: function () { return b; },
        build: function () { return {}; }
      };
      return b;
    },
    ProtectionType: { SHEET: 'SHEET' },
    getUi: function () { throw new Error('這一組測試不應該用到 getUi()'); }
  };

  const sandbox = loadAllSrcFilesInOrder(Object.assign({}, baseStubs(), {
    SpreadsheetApp: FakeSpreadsheetApp,
    LockService: {
      getScriptLock: function () {
        return { tryLock: function () { return true; }, releaseLock: function () {} };
      }
    },
    DriveApp: { Access: {}, Permission: {}, getFileById: function () { return {}; }, getFolderById: function () { return {}; } },
    MailApp: { sendEmail: function () {}, getRemainingDailyQuota: function () { return 100; } },
    ScriptApp: { getProjectTriggers: function () { return []; } }
  }));

  return { sandbox: sandbox, sheets: ownSheets, contentTabs: contentTabs };
}

function rows(env, sheetId) {
  return env.sandbox.readSheet(env.sandbox.SHEETS[sheetId]);
}

/** 讀某一張內容表分頁的資料列（第 3 行起）。 */
function tabRows(env, tabName) {
  const def = env.sandbox.contentSheetTabDefs_().filter(function (d) { return d.tabName === tabName; })[0];
  const tab = env.contentTabs[tabName];
  if (!tab) return [];
  return env.sandbox.parseContentTabRows_(tab.__data.slice(2), def.keys);
}

// =====================================================================
// 第 1 組：§4.0 首次刷新必須回填（做錯會清空真實資料）
// =====================================================================

console.log('\n第 1 組：§4.0 首次刷新回填');

test('⚠️ 新分頁首次建立 → 由 BulletinWeeks 逐行回填現有值', function () {
  const env = makeEnv({
    missingTabs: ['崇拜程序', '浸禮合堂'],
    weekRows: [
      {
        SERVICE_DATE: D1, QUARTER_ID: QUARTER_ID, STATUS: 'DRAFT',
        SERMON_TITLE: '要有愛', RESPONSE_HYMN: '活出愛', CHOIR_TITLE: '愛中有主',
        SCRIPTURE_REF: '約翰福音 3:16'
      },
      { SERVICE_DATE: D2, QUARTER_ID: QUARTER_ID, STATUS: 'DRAFT' }
    ]
  });

  const result = env.sandbox.buildOrRefreshContentSheet_(QUARTER_ID);
  assert.strictEqual(result.ok, true, JSON.stringify(result));

  const filled = tabRows(env, '崇拜程序');
  assert.strictEqual(filled.length, 1, '只有真的有值那一個主日才寫一行');
  assert.strictEqual(filled[0].SERMON_TITLE, '要有愛');
  assert.strictEqual(filled[0].RESPONSE_HYMN, '活出愛');
  assert.strictEqual(filled[0].CHOIR_TITLE, '愛中有主');
  assert.strictEqual(filled[0].SCRIPTURE_REF, '約翰福音 3:16');
});

test('⚠️ 回填之後整季匯入 → 九欄一格不變（這一條就是 §4.0 的目的）', function () {
  const env = makeEnv({
    missingTabs: ['崇拜程序', '浸禮合堂'],
    weekRows: [
      {
        SERVICE_DATE: D1, QUARTER_ID: QUARTER_ID, STATUS: 'DRAFT',
        SERMON_TITLE: '要有愛', RESPONSE_HYMN: '活出愛'
      }
    ]
  });
  env.sandbox.buildOrRefreshContentSheet_(QUARTER_ID);

  const applied = env.sandbox.applyContentImport_(QUARTER_ID, {});
  assert.strictEqual(applied.ok, true, JSON.stringify(applied));

  const week = rows(env, 'BULLETIN_WEEKS')[0];
  assert.strictEqual(week.SERMON_TITLE, '要有愛', '不回填的話這裏會變成空白');
  assert.strictEqual(week.RESPONSE_HYMN, '活出愛');
});

test('已經有資料的分頁 → 一格都不覆蓋', function () {
  const env = makeEnv({
    content: { 崇拜程序: [{ SERVICE_DATE: D1, SERMON_TITLE: '同工填的', ACTIVE: 'TRUE' }] },
    weekRows: [{ SERVICE_DATE: D1, QUARTER_ID: QUARTER_ID, SERMON_TITLE: '週報舊值' }]
  });
  env.sandbox.buildOrRefreshContentSheet_(QUARTER_ID);

  const after = tabRows(env, '崇拜程序');
  assert.strictEqual(after.length, 1);
  assert.strictEqual(after[0].SERMON_TITLE, '同工填的',
    '⚠️ 覆蓋就等於用週報舊值蓋走同工剛剛填的東西');
});

test('回填會寫 AuditLog，而且講得出回填了幾多行', function () {
  const env = makeEnv({
    missingTabs: ['崇拜程序'],
    weekRows: [{ SERVICE_DATE: D1, QUARTER_ID: QUARTER_ID, SERMON_TITLE: '要有愛' }]
  });
  env.sandbox.buildOrRefreshContentSheet_(QUARTER_ID);
  const audit = rows(env, 'AUDIT_LOG').filter(function (r) {
    return r.ACTION === 'CONTENT_SHEET_BACKFILL';
  });
  assert.strictEqual(audit.length, 1);
  assert.strictEqual(audit[0].NEW_VALUE, '1');
});

test('預覽講的回填行數，跟實際回填的一樣', function () {
  // ⚠️ 預覽同實際各算一次的話，預覽講 8 行、實際 7 行，冇人查得出。
  const env = makeEnv({
    missingTabs: ['崇拜程序', '浸禮合堂'],
    weekRows: [
      { SERVICE_DATE: D1, QUARTER_ID: QUARTER_ID, SERMON_TITLE: '要有愛' },
      { SERVICE_DATE: D2, QUARTER_ID: QUARTER_ID, RESPONSE_HYMN: '活出愛' }
    ]
  });
  const preview = env.sandbox.previewContentSheetBuild_(QUARTER_ID);
  const previewRows = (preview.summary.backfillTabs || [])
    .filter(function (b) { return b.tabName === '崇拜程序'; })[0];
  assert.ok(previewRows, '預覽要講得出會回填');

  const result = env.sandbox.buildOrRefreshContentSheet_(QUARTER_ID);
  const actual = (result.backfilledTabs || [])
    .filter(function (b) { return b.tabName === '崇拜程序'; })[0];
  assert.strictEqual(previewRows.rows, actual.rows,
    '預覽 ' + previewRows.rows + ' 行、實際 ' + actual.rows + ' 行');
});

// =====================================================================
// 第 2 組：覆寫不被蓋、放棄覆寫
// =====================================================================

console.log('\n第 2 組：覆寫不被蓋');

test('⚠️ 內容表改值 → 匯入 → 有覆寫那格值不變，報告出現 CONFLICT', function () {
  const env = makeEnv({
    content: { 崇拜程序: [{ SERVICE_DATE: D1, SERMON_TITLE: '內容表新值', ACTIVE: 'TRUE' }] },
    weekRows: [{ SERVICE_DATE: D1, QUARTER_ID: QUARTER_ID, SERMON_TITLE: '幹事覆寫值' }],
    fieldOverride: [{
      SERVICE_DATE: D1, FIELD_KEY: 'SERMON_TITLE', OVERRIDE_VALUE: '幹事覆寫值',
      SOURCE_VALUE_AT_OVERRIDE: '內容表舊值', OVERRIDE_AT: '2027-09-01',
      OVERRIDE_BY: 'tester@x.com', REASON: '', ACTIVE: true, NOTES: ''
    }]
  });

  const applied = env.sandbox.applyContentImport_(QUARTER_ID, {});
  assert.strictEqual(applied.ok, true, JSON.stringify(applied));

  assert.strictEqual(rows(env, 'BULLETIN_WEEKS')[0].SERMON_TITLE, '幹事覆寫值',
    '有覆寫就不可以被蓋過去');

  const conflicts = applied.plan.conflicts || [];
  assert.strictEqual(conflicts.length, 1, '要報一筆 CONFLICT');
  assert.strictEqual(conflicts[0].field, 'SERMON_TITLE');
  assert.strictEqual(conflicts[0].sourceValue, '內容表新值');
});

test('⚠️ 沒有覆寫的欄位 → 照樣跟隨內容表最新值（規則 2）', function () {
  const env = makeEnv({
    content: { 崇拜程序: [{ SERVICE_DATE: D1, SERMON_TITLE: '內容表新值', ACTIVE: 'TRUE' }] },
    weekRows: [{ SERVICE_DATE: D1, QUARTER_ID: QUARTER_ID, SERMON_TITLE: '舊值' }]
  });
  env.sandbox.applyContentImport_(QUARTER_ID, {});
  assert.strictEqual(rows(env, 'BULLETIN_WEEKS')[0].SERMON_TITLE, '內容表新值');
});

test('放棄覆寫（ACTIVE=FALSE）→ 再匯入就跟隨內容表', function () {
  const env = makeEnv({
    content: { 崇拜程序: [{ SERVICE_DATE: D1, SERMON_TITLE: '內容表新值', ACTIVE: 'TRUE' }] },
    weekRows: [{ SERVICE_DATE: D1, QUARTER_ID: QUARTER_ID, SERMON_TITLE: '幹事覆寫值' }],
    fieldOverride: [{
      SERVICE_DATE: D1, FIELD_KEY: 'SERMON_TITLE', OVERRIDE_VALUE: '幹事覆寫值',
      SOURCE_VALUE_AT_OVERRIDE: '內容表舊值', OVERRIDE_AT: '2027-09-01',
      OVERRIDE_BY: 'tester@x.com', REASON: '', ACTIVE: false, NOTES: ''
    }]
  });
  const applied = env.sandbox.applyContentImport_(QUARTER_ID, {});
  assert.strictEqual(rows(env, 'BULLETIN_WEEKS')[0].SERMON_TITLE, '內容表新值');
  assert.strictEqual((applied.plan.conflicts || []).length, 0,
    '已停用的覆寫不可以再攔匯入');
});

test('computeFieldOverridePlan_：改成與來源相同 → 停用覆寫，不是留住', function () {
  // ⚠️ 留住的話，那一格會從此不再跟隨內容表，而幹事以為它會。
  const env = makeEnv({});
  const index = env.sandbox.buildFieldOverrideIndex_([{
    SERVICE_DATE: D1, FIELD_KEY: 'SERMON_TITLE', OVERRIDE_VALUE: '覆寫值',
    SOURCE_VALUE_AT_OVERRIDE: '來源值', ACTIVE: true
  }]);
  const plan = env.sandbox.computeFieldOverridePlan_(
    { SERMON_TITLE: '來源值' }, { SERMON_TITLE: '來源值' }, index, D1);

  assert.strictEqual(plan.upserts.length, 0);
  assert.strictEqual(plan.deactivations.length, 1);
  assert.strictEqual(plan.deactivations[0].fieldKey, 'SERMON_TITLE');
});

test('applyFieldOverrides_：純函式，不改動傳進來那個物件', function () {
  const env = makeEnv({});
  const week = { SERMON_TITLE: '原值', PRELUDE: '序樂' };
  const index = env.sandbox.buildFieldOverrideIndex_([{
    SERVICE_DATE: D1, FIELD_KEY: 'SERMON_TITLE', OVERRIDE_VALUE: '覆寫值', ACTIVE: true
  }]);
  const out = env.sandbox.applyFieldOverrides_(week, D1, index);

  assert.strictEqual(out.SERMON_TITLE, '覆寫值');
  assert.strictEqual(out.PRELUDE, '序樂', '沒有覆寫的欄位原樣保留');
  assert.strictEqual(week.SERMON_TITLE, '原值', '不可以改動傳進來那一個');
});

test('⚠️ 只可以有一個地方套用覆寫（靜態掃描）', function () {
  // ⚠️ 加第二個地方套一次，就等於加了第二個真相來源（事故三）。
  const files = fs.readdirSync(path.join(__dirname, '..', 'src'))
    .filter(function (n) { return n.endsWith('.gs'); });
  const callers = [];
  files.forEach(function (name) {
    const code = srcText(name)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    const n = (code.match(/applyFieldOverrides_\(/g) || []).length;
    // FieldOverride.gs 自己那一個是定義，不算呼叫。
    const defined = name === 'FieldOverride.gs' ? 1 : 0;
    if (n - defined > 0) callers.push(name + '×' + (n - defined));
  });
  assert.strictEqual(JSON.stringify(callers), JSON.stringify(['BulletinModel.gs×1']),
    '實際呼叫處：' + JSON.stringify(callers));
});

// =====================================================================
// 第 3 組：三種模式的分工
// =====================================================================

console.log('\n第 3 組：三種模式的分工');

test('第三種模式的欄位**不是**唯讀（介面照樣改得到）', function () {
  const env = makeEnv({});
  const readonly = env.sandbox.CONTENT_SHEET_READONLY_FIELDS.WEEK;
  env.sandbox.CONTENT_SHEET_OVERRIDABLE_FIELDS.forEach(function (k) {
    assert.strictEqual(readonly.indexOf(k), -1, k + ' 不可以進唯讀清單');
  });
});

test('送出第三種模式的欄位 → 不會被當成唯讀而整次拒絕', function () {
  const env = makeEnv({});
  const offending = env.sandbox.findSubmittedReadOnlyFields_({
    week: { SERMON_TITLE: '因信稱義', BAPTISM_OFFICIANT: '甲' }
  });
  assert.strictEqual(JSON.stringify(offending.week || offending), '[]',
    '實際：' + JSON.stringify(offending));
});

// =====================================================================
// 第 4 組：R-040 下週事奉雙向
// =====================================================================

console.log('\n第 4 組：R-040 下週事奉雙向');

test('⚠️ A 主日改「下週事奉」→ 寫的是 B 主日那一筆記錄', function () {
  // ⚠️ 鍵本來就帶主日日期，所以資料結構不用改——**正因為不用改，
  //    才最容易誤用這一週的日期**，兩個畫面各存一筆，外表完全正常。
  const env = makeEnv({});
  env.sandbox.saveWeekFromWebApp_({
    isoDate: D1, lastSavedAt: null, week: {},
    nextWeekDutyEdits: [{ postId: 'CHAIR', slotIndex: 1, name: '陳大文' }]
  });

  const saved = rows(env, 'DUTY_OVERRIDE');
  assert.strictEqual(saved.length, 1, '應該只有一筆');
  assert.strictEqual(env.sandbox.formatIsoDate_(saved[0].SERVICE_DATE), D2,
    '⚠️ 一定要寫下一個主日（' + D2 + '），實際寫了 '
      + env.sandbox.formatIsoDate_(saved[0].SERVICE_DATE));
  assert.strictEqual(saved[0].OVERRIDE_NAME, '陳大文');
});

test('⚠️ 反向：B 主日改「本週事奉」→ 同一筆記錄（不是新開一筆）', function () {
  const env = makeEnv({});
  env.sandbox.saveWeekFromWebApp_({
    isoDate: D1, lastSavedAt: null, week: {},
    nextWeekDutyEdits: [{ postId: 'CHAIR', slotIndex: 1, name: '陳大文' }]
  });
  const afterFirst = rows(env, 'DUTY_OVERRIDE').length;

  const week2 = rows(env, 'BULLETIN_WEEKS').filter(function (r) {
    return env.sandbox.formatIsoDate_(r.SERVICE_DATE) === D2;
  })[0];
  env.sandbox.saveWeekFromWebApp_({
    isoDate: D2, lastSavedAt: env.sandbox.canonicalSaveToken_(week2.LAST_SAVED_AT), week: {},
    dutyEdits: [{ postId: 'CHAIR', slotIndex: 1, name: '李小明' }]
  });

  const saved = rows(env, 'DUTY_OVERRIDE');
  assert.strictEqual(saved.length, afterFirst,
    '⚠️ 兩個畫面改同一格，只可以有一筆記錄，實際 ' + saved.length + ' 筆');
  assert.strictEqual(saved[0].OVERRIDE_NAME, '李小明', '第二次改要蓋過第一次');
});

test('⚠️ R-040：讀與寫用同一個日期（連續兩次儲存只可以有一筆記錄）', function () {
  // ⚠️ `applyDutyEditsFromPayload_()` 兩個參數：第一個決定「讀邊一日的
  //    既有覆寫」，第二個決定「寫落去嗰格係邊一日」。兩者不一致的話，
  //    每儲存一次就多一筆記錄——而外表完全正常，只是永遠對不上。
  const env = makeEnv({});
  env.sandbox.saveWeekFromWebApp_({
    isoDate: D1, lastSavedAt: null, week: {},
    nextWeekDutyEdits: [{ postId: 'CHAIR', slotIndex: 1, name: '第一次' }]
  });
  const week1 = rows(env, 'BULLETIN_WEEKS').filter(function (r) {
    return env.sandbox.formatIsoDate_(r.SERVICE_DATE) === D1;
  })[0];
  env.sandbox.saveWeekFromWebApp_({
    isoDate: D1, lastSavedAt: env.sandbox.canonicalSaveToken_(week1.LAST_SAVED_AT), week: {},
    nextWeekDutyEdits: [{ postId: 'CHAIR', slotIndex: 1, name: '第二次' }]
  });

  const saved = rows(env, 'DUTY_OVERRIDE');
  assert.strictEqual(saved.length, 1,
    '⚠️ 兩次儲存同一格只可以有一筆，實際 ' + saved.length + ' 筆：'
      + JSON.stringify(saved.map(function (r) {
        return env.sandbox.formatIsoDate_(r.SERVICE_DATE) + '=' + r.OVERRIDE_NAME;
      })));
  assert.strictEqual(saved[0].OVERRIDE_NAME, '第二次');
  assert.strictEqual(env.sandbox.formatIsoDate_(saved[0].SERVICE_DATE), D2);
});

test('R-040：下一季未建立 → 有提示，而且不可以編輯', function () {
  const env = makeEnv({});
  const notice = env.sandbox.buildNextWeekDutyNotice_({
    nextWeekDuty: [], nextIsoDate: '2028-01-02'
  });
  assert.ok(notice.indexOf('2028-01-02') !== -1, notice);
  assert.ok(notice.indexOf('下一季') !== -1, '要講得出成因');
  assert.ok(notice.indexOf('週報照樣產生得到') !== -1,
    '⚠️ 這是很正常的狀況，不是錯誤——文案不可以嚇親幹事');
  assert.strictEqual(env.sandbox.buildNextWeekDutyNotice_({ nextWeekDuty: [{}] }), '',
    '可以編輯時不顯示提示');
});

// =====================================================================
// 第 5 組：D 系列
// =====================================================================

console.log('\n第 5 組：D 系列');

test('⚠️ D-7：職事表有齊資料 → 「本應空白」不算入「仍有 N 格空白」', function () {
  const env = makeEnv({});
  const msg = env.sandbox.buildRosterBackfillMessage_({
    quarterId: QUARTER_ID, filled: 26, stillBlank: 0, expectedBlank: 12,
    statusBefore: { OK: 13 }, statusAfter: { OK: 13 }, rosterFound: true
  });
  assert.ok(msg.indexOf('沒有任何一格因為職事表缺資料而填不到') !== -1, msg);
  assert.ok(msg.indexOf('12 格**本來就應該空白**') !== -1, msg);
  assert.ok(msg.indexOf('不算缺資料') !== -1, msg);
});

test('⚠️ D-7：由真正入口跑一次補抓 → 平常主日的 SPECIAL_TYPE 算「本應空白」', function () {
  // ⚠️ 上一條只驗訊息排版。這一條由 `backfillRosterForQuarter_()` 真的跑
  //    一次，驗**數的那一段**：職事表齊晒（五個平常主日、沒有特別主日），
  //    SPECIAL_TYPE 五格全部應該歸「本應空白」，一格都不算缺。
  const env = makeEnv({
    weekRows: SERVICE_DATES.map(function (iso) {
      return { SERVICE_DATE: iso, QUARTER_ID: QUARTER_ID, STATUS: 'DRAFT' };
    })
  });
  const result = env.sandbox.backfillRosterForQuarter_(QUARTER_ID);

  assert.strictEqual(result.ok, true, JSON.stringify(result));
  assert.strictEqual(result.stillBlank, 0,
    '⚠️ 職事表有齊資料就一格都不應該算缺，實際 ' + result.stillBlank);
  assert.strictEqual(result.expectedBlank, SERVICE_DATES.length,
    '五個平常主日的 SPECIAL_TYPE 全部本應空白，實際 ' + result.expectedBlank);
  assert.ok(result.message.indexOf('本來就應該空白') !== -1, result.message);
});

test('⚠️ D-2：季度找得到但個別主日未指派 → 措辭與「整季找不到」不同', function () {
  const env = makeEnv({});
  const found = env.sandbox.buildRosterBackfillMessage_({
    quarterId: QUARTER_ID, filled: 3, stillBlank: 5, expectedBlank: 0,
    statusBefore: {}, statusAfter: {}, rosterFound: true
  });
  const notFound = env.sandbox.buildRosterBackfillMessage_({
    quarterId: QUARTER_ID, filled: 0, stillBlank: 39, expectedBlank: 0,
    statusBefore: {}, statusAfter: {}, rosterFound: false
  });

  assert.ok(found.indexOf('季度本身在職事表找得到') !== -1, found);
  assert.ok(found.indexOf('職事表仍然未有季度') === -1,
    '⚠️ 兩件事不可以用同一句：季度找得到就不可以講「整季未有資料」');
  assert.ok(notFound.indexOf('職事表仍然未有季度') !== -1, notFound);
});

test('⚠️ D-8：合併組要顯示得出原始崗位（兩行不可以一模一樣）', function () {
  const env = makeEnv({});
  const labels = { SOUND: '影音', PPT: '影音', PREACHER: '講員' };
  const byRoster = { SOUND: '音響', PPT: 'PPT', PREACHER: '講員' };

  assert.strictEqual(env.sandbox.rosterDiffPostLabel_('SOUND', labels, byRoster), '影音（音響）');
  assert.strictEqual(env.sandbox.rosterDiffPostLabel_('PPT', labels, byRoster), '影音（PPT）');
  // 沒有撞名就原樣——每一行都加括號只會令行變長而沒有多講任何東西。
  assert.strictEqual(env.sandbox.rosterDiffPostLabel_('PREACHER', labels, byRoster), '講員');
});

test('⚠️ D-4：「有效」留空要逐行列出，不可以靜靜當成 TRUE', function () {
  const env = makeEnv({
    content: {
      崇拜程序: [
        { SERVICE_DATE: D1, SERMON_TITLE: '有填 ACTIVE', ACTIVE: 'TRUE' },
        { SERVICE_DATE: D2, SERMON_TITLE: '冇填 ACTIVE' }
      ]
    }
  });
  const preview = env.sandbox.previewContentImport_(QUARTER_ID, {});
  const blanks = preview.plan.blankActiveRows || [];
  assert.strictEqual(blanks.length, 1, '實際：' + JSON.stringify(blanks));
  assert.strictEqual(blanks[0].tabName, '崇拜程序');

  const lines = env.sandbox.buildContentImportDialogLines_(preview, { dryRun: true, applied: false });
  const text = lines.join('\n');
  assert.ok(text.indexOf('「有效」是空白的') !== -1, text);
  assert.ok(text.indexOf('當成 TRUE') !== -1, '要講明本次會匯入');
});

test('D-10：待填清單分兩段，獻花與翻譯歸第二段', function () {
  const env = makeEnv({});
  const missing = env.sandbox.buildMissingList_({
    week: {},
    dutyBoxPage1: [
      { isPending: true, postIds: ['TRANSLATOR'], label: '翻譯' },
      { isPending: true, postIds: ['PREACHER'], label: '講員' }
    ],
    announcementCount: 1, prayerCount: 1, fellowshipCount: 1
  });
  const split = env.sandbox.splitMissingList_(missing);

  const optionalLabels = split.optional.map(function (m) { return m.label; });
  assert.ok(optionalLabels.indexOf('翻譯') !== -1, '翻譯要歸第二段：' + JSON.stringify(optionalLabels));
  assert.ok(optionalLabels.indexOf('本週獻花') !== -1, JSON.stringify(optionalLabels));

  const requiredLabels = split.required.map(function (m) { return m.label; });
  assert.ok(requiredLabels.indexOf('講員') !== -1, '講員一定要填');
  assert.ok(requiredLabels.indexOf('證道講題') !== -1);
  assert.ok(split.requiredCount < missing.length, '徽章的數字要細過總數');
});

test('D-10：合併組只要有一個是必填，整格就算必填', function () {
  const env = makeEnv({});
  const missing = env.sandbox.buildMissingList_({
    week: { SCRIPTURE_REF: 'x', SERMON_TITLE: 'x', RESPONSE_HYMN: 'x', FLOWER_THIS_WEEK: 'x' },
    dutyBoxPage1: [{ isPending: true, postIds: ['TRANSLATOR', 'PREACHER'], label: '合併' }],
    announcementCount: 1, prayerCount: 1, fellowshipCount: 1
  });
  const split = env.sandbox.splitMissingList_(missing);
  assert.strictEqual(split.optional.length, 0, '寧可多提醒一次');
});

test('D-11：警告徽章可撳，而且有 title', function () {
  const idx = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'Index.html'), 'utf8');
  const block = idx.slice(idx.indexOf('id="statWarnings"'), idx.indexOf('id="statWarnings"') + 200);
  assert.ok(block.indexOf('stat-clickable') !== -1, '要與「待填」「衝突」看齊');
  assert.ok(block.indexOf('title=') !== -1);
  assert.ok(idx.indexOf('id="warningsPanel"') !== -1, '要有一個展開的清單');
});

test('D-9：儲存成功之後會刷新主日下拉的標籤', function () {
  const ui = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'Script.html'), 'utf8');
  const block = ui.slice(ui.indexOf('function onSaveSuccess('), ui.indexOf('function refreshWeekSelectorLabels('));
  assert.ok(block.indexOf('refreshWeekSelectorLabels()') !== -1,
    '⚠️ 同一個狀態只可以有一個來源：徽章更新了而下拉沒有，幹事會信下拉');
  assert.ok(ui.indexOf("callServer('apiListWeeks'") !== -1);
});

// =====================================================================
// 第 6 組：R-044／R-046／R-047
// =====================================================================

console.log('\n第 6 組：R-044／R-046／R-047');

test('R-046：介面與格子表叫「讀經經文」，Word 印出來的「讀經」一字不變', function () {
  const constants = srcText('Constants.gs');
  const fillGrid = srcText('FillGrid.gs');
  const bootstrap = srcText('Bootstrap.gs');

  assert.ok(constants.indexOf("'讀經經文', '證道講題'") !== -1, 'BulletinWeeks 標題要改');
  assert.ok(fillGrid.indexOf("'SCRIPTURE_REF', '讀經經文'") !== -1, '格子表標題要改');
  assert.ok(bootstrap.indexOf("postDisplayRow_('SCRIPTURE', '讀經（事奉）'") !== -1,
    '事奉框那個是**人**，要改成「讀經（事奉）」');

  // ⚠️ 這一條最要緊：ProgramTemplates 的 ITEM_NAME 是 Word 印出來的字。
  assert.ok(bootstrap.indexOf("programRow_('TPL_NORMAL', 70, '讀經', 'FIELD:SCRIPTURE_REF'") !== -1,
    'Word 範本輸出那個「讀經」一字都不可以改');
});

test('R-047：播種資料不再有「熱烈歡迎來賓」那一句', function () {
  // ⚠️ 真正成因是**系統自己幫幹事填咗**。只在 _說明 寫「不要再填」沒有用。
  const env = makeEnv({});
  const sample = env.sandbox.buildContentSheetSampleRows_(SERVICE_DATES);
  const texts = (sample['家事報告'] || []).map(function (r) { return r.TEXT; });
  texts.forEach(function (t) {
    assert.strictEqual(String(t).indexOf('熱烈歡迎來賓'), -1,
      '播種資料仍然有那一句：' + t);
  });
});

test('R-047：_說明 明文寫住那一句不要填', function () {
  const env = makeEnv({});
  const lines = env.sandbox.buildContentSheetInstructionLines_({
    quarterId: QUARTER_ID, serviceDates: SERVICE_DATES, owners: {},
    deadlineNote: '', adminContact: 'it@example.com', seededSample: true
  });
  const text = lines.join('\n');
  assert.ok(text.indexOf('熱烈歡迎來賓') !== -1, text);
  assert.ok(text.indexOf('不要再填') !== -1, text);
});

test('R-047：重複段落偵測會忽略開頭的編號前綴', function () {
  const env = makeEnv({});
  const strip = env.sandbox.stripLeadingItemNumber_;
  assert.strictEqual(strip('1. 熱烈歡迎來賓'), '熱烈歡迎來賓');
  assert.strictEqual(strip('（3）測試'), '測試');
  assert.strictEqual(strip('一、測試'), '測試');
  // ⚠️ 只剝開頭那一個，剝到盡的話「1. 2027 年財政報告」會變成「年財政報告」。
  assert.strictEqual(strip('1. 2027 年財政報告'), '2027 年財政報告');
  // 整段只有一個編號 → 原樣回傳，不可以變空白。
  assert.strictEqual(strip('1.'), '1.');
});

test('R-041：自動值由後端算，而且是「不覆寫會用哪一個」', function () {
  const env = makeEnv({});
  const model = env.sandbox.buildBulletinModel_(D1);
  // 2027-10-03 是 10 月 → 9-12 組 → 主禱文。
  assert.ok(String(model.recitationAuto).length > 0, '要算得出自動值');

  const ui = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'Script.html'), 'utf8');
  assert.ok(ui.indexOf('readOnly.recitationAuto') !== -1, '前端要用後端算好那個');
  assert.ok(ui.indexOf('RECITATION_MONTH_GROUPS') === -1,
    '⚠️ 前端不可以自己重寫一次月份分組——Config 改得到，會靜靜地錯');
});

test('R-042：職事表有獻花 → 帶入；週報已填 → 一格不動', function () {
  const env = makeEnv({});
  const withRoster = env.sandbox.applyFlowerFromRoster_(
    { FLOWER_THIS_WEEK: '' },
    { found: true, slotsByPost: { FLOWER: [{ rosterName: '王氏家庭' }] } },
    null);
  assert.strictEqual(withRoster.FLOWER_THIS_WEEK, '王氏家庭');

  const alreadyFilled = env.sandbox.applyFlowerFromRoster_(
    { FLOWER_THIS_WEEK: '人手填的' },
    { found: true, slotsByPost: { FLOWER: [{ rosterName: '王氏家庭' }] } },
    null);
  assert.strictEqual(alreadyFilled.FLOWER_THIS_WEEK, '人手填的',
    '⚠️ 人手輸入即覆寫，職事表不可以蓋過去');
});

test('R-042：下週獻花用**下一個主日**的快照', function () {
  const env = makeEnv({});
  const out = env.sandbox.applyFlowerFromRoster_(
    {},
    { found: true, slotsByPost: { FLOWER: [{ rosterName: '本週家庭' }] } },
    { found: true, slotsByPost: { FLOWER: [{ rosterName: '下週家庭' }] } });
  assert.strictEqual(out.FLOWER_THIS_WEEK, '本週家庭');
  assert.strictEqual(out.FLOWER_NEXT_WEEK, '下週家庭');
});

test('R-042：用 DutyOverride，不是 FieldOverride（它本質是崗位）', function () {
  const overridable = makeEnv({}).sandbox.CONTENT_SHEET_OVERRIDABLE_FIELDS;
  assert.strictEqual(overridable.indexOf('FLOWER_THIS_WEEK'), -1);
  assert.strictEqual(overridable.indexOf('FLOWER_NEXT_WEEK'), -1);
});

// =====================================================================
// 第 7 組：R-045 浸禮分頁
// =====================================================================

console.log('\n第 7 組：R-045 浸禮分頁');

test('⚠️ 非浸禮主日六欄全空 → 不報錯、不報警告', function () {
  const env = makeEnv({
    content: {
      浸禮合堂: [{ SERVICE_DATE: D1, BAPTISM_OFFICIANT: '張牧師', ACTIVE: 'TRUE' }]
    }
  });
  const preview = env.sandbox.previewContentImport_(QUARTER_ID, {});
  assert.strictEqual(preview.ok, true, JSON.stringify(preview));

  const baptismWarnings = (preview.plan.warnings || []).filter(function (w) {
    return String(w).indexOf('浸禮') !== -1;
  });
  assert.strictEqual(JSON.stringify(baptismWarnings), '[]',
    '整季只有一個主日是浸禮合堂，其餘全空是正常的：' + JSON.stringify(baptismWarnings));
});

test('多人欄位一格多位、空格分隔，匯入原樣保存', function () {
  const env = makeEnv({
    content: {
      浸禮合堂: [{ SERVICE_DATE: D1, BAPTISM_MEMBERS: '陳大文 李小明 王美華', ACTIVE: 'TRUE' }]
    }
  });
  env.sandbox.applyContentImport_(QUARTER_ID, {});
  assert.strictEqual(rows(env, 'BULLETIN_WEEKS')[0].BAPTISM_MEMBERS, '陳大文 李小明 王美華',
    '不加尊稱、不重新排序、不拆開再組回去');
});

test('浸禮分頁六欄與 baptismBoxFieldDefs_() 一致', function () {
  const env = makeEnv({});
  const tab = env.sandbox.contentSheetTabDefs_()
    .filter(function (d) { return d.tabName === '浸禮合堂'; })[0];
  const valueKeys = tab.keys.filter(function (k) {
    return k !== 'SERVICE_DATE' && k !== 'ACTIVE' && k !== 'NOTES';
  });
  assert.strictEqual(JSON.stringify(valueKeys),
    JSON.stringify(Array.prototype.slice.call(env.sandbox.baptismBoxFieldKeys_())),
    '六欄的單一真相來源是 baptismBoxFieldDefs_()');
});

// =====================================================================

console.log('\n通過 ' + pass + ' 項，失敗 ' + fail + ' 項。');
process.exit(fail === 0 ? 0 : 1);
