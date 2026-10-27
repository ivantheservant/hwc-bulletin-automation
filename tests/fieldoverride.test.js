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
const { makeContentTab: makeStrictContentTab, makeContentSpreadsheet } = require('./helpers/contentTabFake');

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

/**
 * 造一張假的內容表分頁（兩行標題，資料由第 3 行開始）。
 *
 * 內容表 v2 Commit 1：改用 tests/helpers/contentTabFake.js 的嚴格替身。以前這裏的假分頁
 * 甚麼都收（超出欄數照樣回空白），會令移轉與匯入測試空跑變綠（bug class 80）。
 */
function makeContentTab(keys, headers, rows, opts) {
  return makeStrictContentTab(keys, headers, rows, opts);
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
    const keys = Object.keys(boot.ROSTER_TABLE_DEFS_[defKey].columns).concat(Object.keys(boot.ROSTER_TABLE_DEFS_[defKey].optionalColumns || {}));
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
    NameMapping: rosterSheet('NAME_MAPPING', []),
    Posts: rosterSheet('POSTS', o.posts || [])
  };

  // ⚠️ 內容表 v2 Commit 1：寫了一個版面沒有的分頁名稱就拋錯，不再靜靜當成空白分頁（bug class 39）。
  const layoutNames = boot.contentSheetTabDefs_().map(function (d) { return d.tabName; });
  Object.keys(o.content || {}).forEach(function (name) {
    if (layoutNames.indexOf(name) === -1) throw new Error('fieldoverride 測試：版面沒有「' + name + '」這一張分頁。');
  });
  const contentTabs = {};
  const tabList = [];
  boot.contentSheetTabDefs_().forEach(function (def) {
    // §4.0 的測試要模擬「這一張分頁根本未建立」。
    if ((o.missingTabs || []).indexOf(def.tabName) !== -1) return;
    const tab = makeContentTab(def.keys, def.headers, (o.content || {})[def.tabName] || [], { name: def.tabName });
    contentTabs[def.tabName] = tab;
    tabList.push(tab);
  });
  const contentSpreadsheet = makeContentSpreadsheet({
    id: FAKE_CONTENT_FILE_ID,
    url: 'https://docs.google.com/spreadsheets/d/' + FAKE_CONTENT_FILE_ID + '/edit',
    tabs: tabList
  });
  const realInsert = contentSpreadsheet.insertSheet;
  contentSpreadsheet.insertSheet = function (name) {
    const t = realInsert(name);
    contentTabs[name] = t;
    return t;
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

console.log('\n第 1 組：§4.0 首次刷新回填（內容表 v2 起由移轉 planner 做）');

// 內容表 v2：R-043 的 backfillContentTabFromWeeks_() 已由 src/ContentSheetMigrate.gs 的移轉 planner 取代——
// 「崇拜程序」未建立或者是舊版，都經同一個 planner 決定寫甚麼；而且每個主日都預先開好一行
// （所有欄由週報帶齊），不再只寫「有值的主日」。舊內容表要人手入口（migrate:true）才會移轉。
// 這一組驗的承諾不變：回填之後整季匯入，週報一格不變；已經有資料的格一格不覆蓋；預覽與實際一致。

/** 某張內容表分頁某個主日那一行（第 3 行起）。 */
function tabRowOf(env, tabName, iso) {
  return tabRows(env, tabName).filter(function (r) { return r.SERVICE_DATE === iso; })[0];
}

test('⚠️ 新分頁首次建立 → 每個主日一行，由 BulletinWeeks 帶入現有值', function () {
  const env = makeEnv({
    missingTabs: ['崇拜程序'],
    weekRows: [
      {
        SERVICE_DATE: D1, QUARTER_ID: QUARTER_ID, STATUS: 'DRAFT',
        SERMON_TITLE: '要有愛', RESPONSE_HYMN: '活出愛', CHOIR_TITLE: '愛中有主',
        SCRIPTURE_REF: '約翰福音 3:16', PRELUDE: '序樂一', CALL_REF: '詩篇 100'
      },
      { SERVICE_DATE: D2, QUARTER_ID: QUARTER_ID, STATUS: 'DRAFT' }
    ]
  });

  const refused = env.sandbox.buildOrRefreshContentSheet_(QUARTER_ID);
  assert.strictEqual(refused.ok, false, '舊內容表（未有崇拜程序）要人手入口才移轉');
  assert.strictEqual(refused.reason, 'NEEDS_MIGRATION');
  assert.strictEqual(env.contentTabs['崇拜程序'], undefined, '拒絕時一張分頁都不建');

  const result = env.sandbox.buildOrRefreshContentSheet_(QUARTER_ID, { migrate: true });
  assert.strictEqual(result.ok, true, JSON.stringify(result));

  const filled = tabRows(env, '崇拜程序');
  assert.strictEqual(filled.length, SERVICE_DATES.length, '每個主日一行');
  const d1 = tabRowOf(env, '崇拜程序', D1);
  assert.strictEqual(d1.SERMON_TITLE, '要有愛');
  assert.strictEqual(d1.RESPONSE_HYMN, '活出愛');
  assert.strictEqual(d1.CHOIR_TITLE, '愛中有主');
  assert.strictEqual(d1.SCRIPTURE_REF, '約翰福音 3:16');
  assert.strictEqual(d1.PRELUDE, '序樂一');
  assert.strictEqual(d1.CALL_REF, '詩篇 100');
  assert.strictEqual(tabRowOf(env, '崇拜程序', D2).SERMON_TITLE, '');
});

test('⚠️ 回填之後整季匯入 → 崇拜程序全部欄一格不變（這一條就是 §4.0 的目的）', function () {
  const env = makeEnv({
    missingTabs: ['崇拜程序'],
    weekRows: [
      {
        SERVICE_DATE: D1, QUARTER_ID: QUARTER_ID, STATUS: 'DRAFT',
        SERMON_TITLE: '要有愛', RESPONSE_HYMN: '活出愛', PRELUDE: '序樂一', BAPTISM_MEMBERS: '陳大文 李小明'
      }
    ]
  });
  env.sandbox.buildOrRefreshContentSheet_(QUARTER_ID, { migrate: true });

  const before = JSON.stringify(rows(env, 'BULLETIN_WEEKS'));
  const applied = env.sandbox.applyContentImport_(QUARTER_ID, {});
  assert.strictEqual(applied.ok, true, JSON.stringify(applied));
  assert.strictEqual(applied.plan.weekUpdates.length, 0, JSON.stringify(applied.plan.details.slice(0, 3)));
  assert.strictEqual(JSON.stringify(rows(env, 'BULLETIN_WEEKS')), before, '不回填的話這裏會變成空白');
});

test('已經有資料的格 → 一格都不覆蓋', function () {
  const env = makeEnv({
    content: { 崇拜程序: [{ SERVICE_DATE: D1, SERMON_TITLE: '同工填的', ACTIVE: 'TRUE' }] },
    weekRows: [{ SERVICE_DATE: D1, QUARTER_ID: QUARTER_ID, SERMON_TITLE: '週報舊值' }]
  });
  env.sandbox.buildOrRefreshContentSheet_(QUARTER_ID);

  assert.strictEqual(tabRowOf(env, '崇拜程序', D1).SERMON_TITLE, '同工填的',
    '⚠️ 覆蓋就等於用週報舊值蓋走同工剛剛填的東西');
  assert.strictEqual(tabRows(env, '崇拜程序').filter(function (r) { return r.SERVICE_DATE === D1; }).length, 1,
    '已經有一行的主日不會再多開一行');
});

test('回填會寫 AuditLog，而且講得出寫了幾多行', function () {
  const env = makeEnv({
    missingTabs: ['崇拜程序'],
    weekRows: [{ SERVICE_DATE: D1, QUARTER_ID: QUARTER_ID, SERMON_TITLE: '要有愛' }]
  });
  env.sandbox.buildOrRefreshContentSheet_(QUARTER_ID, { migrate: true });
  const audit = rows(env, 'AUDIT_LOG').filter(function (r) {
    return r.ACTION === 'CONTENT_SHEET_MIGRATE_V2' && r.FIELD === '崇拜程序';
  });
  assert.strictEqual(audit.length, 1);
  assert.ok(String(audit[0].NEW_VALUE).indexOf('行 +' + SERVICE_DATES.length) !== -1, audit[0].NEW_VALUE);
});

test('預覽講的行數與格數，跟實際寫的一樣', function () {
  // ⚠️ 預覽同實際各算一次的話，預覽講 8 行、實際 7 行，冇人查得出。
  const env = makeEnv({
    missingTabs: ['崇拜程序'],
    weekRows: [
      { SERVICE_DATE: D1, QUARTER_ID: QUARTER_ID, SERMON_TITLE: '要有愛' },
      { SERVICE_DATE: D2, QUARTER_ID: QUARTER_ID, RESPONSE_HYMN: '活出愛' }
    ]
  });
  const preview = env.sandbox.previewContentSheetBuild_(QUARTER_ID);
  assert.strictEqual(preview.ok, true, JSON.stringify(preview));
  assert.strictEqual(preview.summary.needsMigration, true);

  const result = env.sandbox.buildOrRefreshContentSheet_(QUARTER_ID, { migrate: true });
  assert.strictEqual(JSON.stringify(preview.summary.migration), JSON.stringify(result.migration.counts),
    '預覽 ' + JSON.stringify(preview.summary.migration) + '、實際 ' + JSON.stringify(result.migration.counts));
  assert.strictEqual(tabRows(env, '崇拜程序').length, result.migration.counts.appendedRows);
});

// =====================================================================
// 第 2 組：覆寫不被蓋、放棄覆寫
// =====================================================================

console.log('\n第 2 組：覆寫不被蓋');

test('⚠️ v3：內容表改值 → 匯入 → 內容表為準；舊的介面覆寫不再擋住匯入，亦不報 CONFLICT', function () {
  // v3（Ivan 測試結果 A 第 10 項）：講題等九欄只可以在內容表輸入，沒有「介面可覆寫」。舊的生效覆寫在
  //    「更新本季內容表」時已經停用（src/ContentSheetMigrateV3.gs）；萬一仍然有，亦不可以擋住內容表的值。
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
  assert.strictEqual(rows(env, 'BULLETIN_WEEKS')[0].SERMON_TITLE, '內容表新值', 'v3：內容表為準');
  assert.strictEqual((applied.plan.conflicts || []).length, 0, 'v3：不再有「你自己改過」的衝突');
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

test('computeFieldOverridePlan_：v3 沒有可覆寫欄位 → 甚麼都不做；機制本身（日後再有可覆寫欄位時）改成與來源相同 → 停用覆寫', function () {
  const env = makeEnv({});
  const index = env.sandbox.buildFieldOverrideIndex_([{
    SERVICE_DATE: D1, FIELD_KEY: 'SERMON_TITLE', OVERRIDE_VALUE: '覆寫值',
    SOURCE_VALUE_AT_OVERRIDE: '來源值', ACTIVE: true
  }]);
  const none = env.sandbox.computeFieldOverridePlan_(
    { SERMON_TITLE: '來源值' }, { SERMON_TITLE: '來源值' }, index, D1);
  assert.strictEqual(none.upserts.length + none.deactivations.length, 0, 'v3：沒有可覆寫欄位');

  // 機制保留：假設某一欄日後重新設為可覆寫，規則照舊（留住的話那一格從此不跟隨內容表）。
  env.sandbox.CONTENT_SHEET_OVERRIDABLE_FIELDS = ['SERMON_TITLE'];
  const plan = env.sandbox.computeFieldOverridePlan_(
    { SERMON_TITLE: '來源值' }, { SERMON_TITLE: '來源值' }, index, D1);
  assert.strictEqual(plan.upserts.length, 0);
  assert.strictEqual(plan.deactivations.length, 1);
  assert.strictEqual(plan.deactivations[0].fieldKey, 'SERMON_TITLE');
});

test('applyFieldOverrides_：純函式，不改動傳進來那個物件；v3 沒有可覆寫欄位 → 原樣', function () {
  const env = makeEnv({});
  const week = { SERMON_TITLE: '原值', PRELUDE: '序樂' };
  const index = env.sandbox.buildFieldOverrideIndex_([{
    SERVICE_DATE: D1, FIELD_KEY: 'SERMON_TITLE', OVERRIDE_VALUE: '覆寫值', ACTIVE: true
  }]);
  const v3 = env.sandbox.applyFieldOverrides_(week, D1, index);
  assert.strictEqual(v3.SERMON_TITLE, '原值', 'v3：舊覆寫不再套用');

  env.sandbox.CONTENT_SHEET_OVERRIDABLE_FIELDS = ['SERMON_TITLE'];
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

test('v3：送出講題 → 當成唯讀而整次拒絕；浸禮六欄照樣可以送', function () {
  const env = makeEnv({});
  const offending = env.sandbox.findSubmittedReadOnlyFields_({
    week: { SERMON_TITLE: '因信稱義', BAPTISM_OFFICIANT: '甲' }
  });
  assert.strictEqual(JSON.stringify(offending), JSON.stringify(['SERMON_TITLE']),
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
    isoDate: D1, lastSavedAt: null, week: {}, baseWeek: {},
    payloadVersion: 2, nextWeekDutyEdits: [{ postId: 'CHAIR', slotIndex: 1, name: '陳大文' }]
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
    isoDate: D1, lastSavedAt: null, week: {}, baseWeek: {},
    payloadVersion: 2, nextWeekDutyEdits: [{ postId: 'CHAIR', slotIndex: 1, name: '陳大文' }]
  });
  const afterFirst = rows(env, 'DUTY_OVERRIDE').length;

  const week2 = rows(env, 'BULLETIN_WEEKS').filter(function (r) {
    return env.sandbox.formatIsoDate_(r.SERVICE_DATE) === D2;
  })[0];
  env.sandbox.saveWeekFromWebApp_({
    isoDate: D2, lastSavedAt: env.sandbox.canonicalSaveToken_(week2.LAST_SAVED_AT), week: {}, baseWeek: {},
    payloadVersion: 2, dutyEdits: [{ postId: 'CHAIR', slotIndex: 1, name: '李小明' }]
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
    isoDate: D1, lastSavedAt: null, week: {}, baseWeek: {},
    payloadVersion: 2, nextWeekDutyEdits: [{ postId: 'CHAIR', slotIndex: 1, name: '第一次' }]
  });
  const week1 = rows(env, 'BULLETIN_WEEKS').filter(function (r) {
    return env.sandbox.formatIsoDate_(r.SERVICE_DATE) === D1;
  })[0];
  env.sandbox.saveWeekFromWebApp_({
    isoDate: D1, lastSavedAt: env.sandbox.canonicalSaveToken_(week1.LAST_SAVED_AT), week: {}, baseWeek: {},
    payloadVersion: 2, nextWeekDutyEdits: [{ postId: 'CHAIR', slotIndex: 1, name: '第二次' }]
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
  assert.ok(msg.indexOf('12 格本來就應該空白') !== -1, msg);
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
  // ⚠️ 事奉框維持「讀經」：PAGE1_NAME／PAGE3_NAME 直接印在 Word 第 1、3
  //    頁的事奉框，改成「讀經（事奉）」會令印刷版多出括號。
  assert.ok(bootstrap.indexOf("postDisplayRow_('SCRIPTURE', '讀經', 40, true, '', '讀經', 40, true, '')") !== -1,
    '事奉框維持「讀經」，歧義由介面欄位「讀經經文」解決');
  assert.strictEqual(bootstrap.indexOf("postDisplayRow_('SCRIPTURE', '讀經（事奉）'"), -1, '種子資料不可以再有「讀經（事奉）」');

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
      // 內容表 v2：浸禮六欄併入「崇拜程序」。
      崇拜程序: [{ SERVICE_DATE: D1, BAPTISM_OFFICIANT: '張牧師', ACTIVE: 'TRUE' }]
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

test('v3：浸禮六欄不在內容表——內容表「崇拜程序」帶了浸禮欄位亦不會匯入（只在填寫介面填）', function () {
  const env = makeEnv({
    content: {
      崇拜程序: [{ SERVICE_DATE: D1, BAPTISM_MEMBERS: '陳大文 李小明 王美華', ACTIVE: 'TRUE' }]
    },
    weekRows: [{ SERVICE_DATE: D1, QUARTER_ID: QUARTER_ID, BAPTISM_MEMBERS: '介面填的 名單' }]
  });
  env.sandbox.applyContentImport_(QUARTER_ID, {});
  assert.strictEqual(rows(env, 'BULLETIN_WEEKS')[0].BAPTISM_MEMBERS, '介面填的 名單',
    '浸禮六欄以填寫介面為準，匯入不可以動');
});

test('v3：「崇拜程序」沒有浸禮六欄；最後五欄是序樂、宣召出處、宣召經文、詩歌頌讚、詩班項目名稱', function () {
  const env = makeEnv({});
  const tab = env.sandbox.contentSheetTabDefs_()
    .filter(function (d) { return d.tabName === '崇拜程序'; })[0];
  Array.prototype.slice.call(env.sandbox.baptismBoxFieldKeys_()).forEach(function (k) {
    assert.strictEqual(tab.keys.indexOf(k), -1, k + ' 不可以在內容表');
  });
  assert.strictEqual(JSON.stringify(Array.prototype.slice.call(tab.keys, tab.keys.length - 5)),
    JSON.stringify(['PRELUDE', 'CALL_REF', 'CALL_TEXT', 'HYMN_PRAISE', 'CHOIR_LABEL']));
});

// =====================================================================
// 第 8 組：2028T2 瀏覽器測試修正（F1 匯入後的舊分頁、F5 改回同內容表一致）
// =====================================================================

console.log('\n第 8 組：F1／F5');

function overrideRow(iso, key, overrideValue, sourceAtOverride, active) {
  return {
    SERVICE_DATE: iso, FIELD_KEY: key, OVERRIDE_VALUE: overrideValue,
    SOURCE_VALUE_AT_OVERRIDE: sourceAtOverride, OVERRIDE_AT: '2027-09-01',
    OVERRIDE_BY: 'tester@x.com', REASON: '', ACTIVE: active !== false, NOTES: ''
  };
}

test('F1 匯入後：匯入前載入的分頁只改獻花儲存 → 證道講題保持匯入值，FieldOverride 沒有新行', function () {
  // 分頁載入時講題是「舊講題」；之後整季匯入把講題改成「匯入的新講題」。
  const env = makeEnv({
    content: { 崇拜程序: [{ SERVICE_DATE: D1, SERMON_TITLE: '匯入的新講題', ACTIVE: 'TRUE' }] },
    weekRows: [{ SERVICE_DATE: D1, QUARTER_ID: QUARTER_ID, SERMON_TITLE: '舊講題' }]
  });
  const loadedToken = env.sandbox.canonicalSaveToken_(rows(env, 'BULLETIN_WEEKS')[0].LAST_SAVED_AT);

  const applied = env.sandbox.applyContentImport_(QUARTER_ID, {});
  assert.strictEqual(applied.ok, true, JSON.stringify(applied));
  assert.strictEqual(rows(env, 'BULLETIN_WEEKS')[0].SERMON_TITLE, '匯入的新講題');

  // 匯入不更新 LAST_SAVED_AT，所以舊分頁的 token 仍然相符——整行 STALE 檢查擋不住。
  env.sandbox.saveWeekFromWebApp_({
    isoDate: D1, lastSavedAt: loadedToken,
    baseWeek: { FLOWER_THIS_WEEK: '' }, week: { FLOWER_THIS_WEEK: '玫瑰' }
  });

  assert.strictEqual(rows(env, 'BULLETIN_WEEKS')[0].SERMON_TITLE, '匯入的新講題',
    '⚠️ 舊講題不可以被寫回去');
  assert.strictEqual(rows(env, 'BULLETIN_WEEKS')[0].FLOWER_THIS_WEEK, '玫瑰');
  assert.strictEqual(rows(env, 'FIELD_OVERRIDE').length, 0,
    '⚠️ 不可以替舊講題開一筆覆寫，否則之後每次匯入都報「你自己改過」');

  // 之後內容表再改，匯入照常更新，沒有 ✋。
  env.contentTabs['崇拜程序'].__data[2][env.contentTabs['崇拜程序'].__data[1].indexOf('SERMON_TITLE')] = '內容表再改';
  const again = env.sandbox.applyContentImport_(QUARTER_ID, {});
  assert.strictEqual((again.plan.conflicts || []).length, 0);
  assert.strictEqual(rows(env, 'BULLETIN_WEEKS')[0].SERMON_TITLE, '內容表再改');
});

test('F1 匯入後：舊分頁真的改了講題 → v3 講題只可以在內容表改，整次拒絕（CONTENT_SHEET_READONLY）', function () {
  const env = makeEnv({
    content: { 崇拜程序: [{ SERVICE_DATE: D1, SERMON_TITLE: '匯入的新講題', ACTIVE: 'TRUE' }] },
    weekRows: [{ SERVICE_DATE: D1, QUARTER_ID: QUARTER_ID, SERMON_TITLE: '舊講題' }]
  });
  env.sandbox.applyContentImport_(QUARTER_ID, {});

  let thrown = null;
  try {
    env.sandbox.saveWeekFromWebApp_({
      isoDate: D1, lastSavedAt: '',
      baseWeek: { SERMON_TITLE: '舊講題' }, week: { SERMON_TITLE: '我在舊分頁改的' }
    });
  } catch (err) { thrown = err; }
  assert.ok(thrown && thrown.code === 'CONTENT_SHEET_READONLY', String(thrown));
  assert.ok(thrown.message.indexOf('證道講題') !== -1, thrown.message);
  assert.strictEqual(rows(env, 'BULLETIN_WEEKS')[0].SERMON_TITLE, '匯入的新講題');
  assert.strictEqual(rows(env, 'FIELD_OVERRIDE').length, 0);
});

test('⚠️ F5 v3：匯入不再處理介面覆寫（沒有可覆寫欄位）——舊覆寫不解除、不擋、不報；內容表的值照寫', function () {
  // v3：舊覆寫由「更新本季內容表」移轉時停用（tests/contentsheetv2.test.js 的 v3 移轉測試）。匯入本身不再碰 FieldOverride。
  const env = makeEnv({
    content: { 崇拜程序: [{ SERVICE_DATE: D1, SERMON_TITLE: '內容表的值', ACTIVE: 'TRUE' }] },
    weekRows: [{ SERVICE_DATE: D1, QUARTER_ID: QUARTER_ID, SERMON_TITLE: '幹事的值' }],
    fieldOverride: [overrideRow(D1, 'SERMON_TITLE', '幹事的值', '舊值')]
  });
  const preview = env.sandbox.previewContentImport_(QUARTER_ID, {});
  assert.strictEqual(preview.ok, true, JSON.stringify(preview));
  assert.strictEqual(preview.plan.releases.length, 0);
  const applied = env.sandbox.applyContentImport_(QUARTER_ID, {});
  assert.strictEqual(applied.plan.releases.length, 0);
  assert.strictEqual((applied.plan.conflicts || []).length, 0);
  assert.strictEqual(rows(env, 'BULLETIN_WEEKS')[0].SERMON_TITLE, '內容表的值');
  assert.strictEqual(rows(env, 'FIELD_OVERRIDE')[0].ACTIVE, true, '匯入不寫 FieldOverride');
  const text = env.sandbox.buildContentImportDialogLines_(applied, { applied: true }).join('\n');
  assert.strictEqual(text.indexOf('✋'), -1, text);
});

test('F5 預覽與套用走同一組計算：releases 數目一致', function () {
  const env = makeEnv({
    content: { 崇拜程序: [{ SERVICE_DATE: D1, SERMON_TITLE: '甲', ACTIVE: 'TRUE' }] },
    weekRows: [{ SERVICE_DATE: D1, QUARTER_ID: QUARTER_ID, SERMON_TITLE: '甲' }],
    fieldOverride: [overrideRow(D1, 'SERMON_TITLE', '甲', '')]
  });
  const preview = env.sandbox.previewContentImport_(QUARTER_ID, {});
  const applied = env.sandbox.applyContentImport_(QUARTER_ID, {});
  assert.strictEqual(preview.plan.releases.length, applied.plan.releases.length);
});

test('範圍：崇拜程序（第三種欄位）只匯入 D1 → D2 的講題不可以被改成內容表新值', function () {
  // 2026-10-21 補測時發現：單週匯入把其他主日沒有覆寫的週欄位也更新了。
  const env = makeEnv({
    content: {
      崇拜程序: [
        { SERVICE_DATE: D1, SERMON_TITLE: '甲新', ACTIVE: 'TRUE' },
        { SERVICE_DATE: D2, SERMON_TITLE: '乙新', ACTIVE: 'TRUE' }
      ]
    },
    weekRows: [
      { SERVICE_DATE: D1, QUARTER_ID: QUARTER_ID, SERMON_TITLE: '甲舊' },
      { SERVICE_DATE: D2, QUARTER_ID: QUARTER_ID, SERMON_TITLE: '乙舊' }
    ]
  });
  const applied = env.sandbox.applyContentImport_(QUARTER_ID, { isoDate: D1 });
  assert.strictEqual(applied.ok, true, JSON.stringify(applied));
  const titles = rows(env, 'BULLETIN_WEEKS').map(function (r) { return r.SERMON_TITLE; });
  assert.strictEqual(JSON.stringify(titles), JSON.stringify(['甲新', '乙舊']), '實際：' + JSON.stringify(titles));
});

// =====================================================================

console.log('\n通過 ' + pass + ' 項，失敗 ' + fail + ' 項。');
process.exit(fail === 0 ? 0 : 1);
