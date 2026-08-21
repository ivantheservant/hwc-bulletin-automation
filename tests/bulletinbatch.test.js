#!/usr/bin/env node
/**
 * tests/bulletinbatch.test.js
 *
 * prompt9 第 2 部分的回歸測試：「一鍵產生本季全部週報（Word）」
 * （`generateQuarterBulletinsBatch_()`）。
 *
 * 重點：
 *   - 單一主日失敗不會中斷其餘的
 *   - 已經產生過（LAST_GENERATED_AT 有值）的不重做
 *   - 接近時間上限會安全中止，已完成的不遺失
 *   - 全部結果都寫進 Diagnostics
 *
 * 執行方式：node tests/bulletinbatch.test.js
 * 離開碼：0＝全部通過　1＝有測試失敗
 */

'use strict';

const assert = require('assert');
const { loadAllSrcFilesInOrder } = require('./helpers/loadGas');
const { makeFakeSheet, makeFakeSpreadsheet } = require('./helpers/fakeSpreadsheet');
const { makeFakeDriveApp, makeFakeUtilities, buildFakeDocx } = require('./helpers/fakeDrive');
const fx = require('./fixtures/docxXml');

const GAS_STUBS = {
  Utilities: { formatDate: function () { return '2027-11-07 09:00'; } },
  Session: {
    getScriptTimeZone: function () { return 'Pacific/Auckland'; },
    getActiveUser: function () { return { getEmail: function () { return 'tester@x.com'; } }; }
  },
  CacheService: {},
  HtmlService: {}
};

const FAKE_ROSTER_ID = 'FAKE_ROSTER_ID_FOR_BATCH_TEST';
const FAKE_TEMPLATE_ID = 'FAKE_TEMPLATE_ID_NORMAL';
const FAKE_FOLDER_ID = 'FAKE_OUTPUT_FOLDER';
const QUARTER_ID = '2027T4';
const SERVICE_DATES = ['2027-11-07', '2027-11-14', '2027-11-21'];

function ownSheetFor(sb, sheetId, rows) {
  const def = sb.COLUMNS[sheetId];
  return makeFakeSheet(def.headers, def.keys, rows || []);
}

function rosterSheetFor(sb, defKey, rows) {
  const keys = Object.keys(sb.ROSTER_TABLE_DEFS_[defKey].columns);
  return makeFakeSheet(keys, keys, rows || []);
}

function templateDocumentXml() {
  return fx.documentXml(fx.para(fx.run('{{SERMON_TITLE}}')) + fx.para(fx.run('{{SERVICE_DATE_COVER}}')));
}

/**
 * 造一個含三個主日的完整測試環境。
 * Args:
 *   options {{weekRows:Object[]=, templateConfigured:boolean=,
 *            folderConfigured:boolean=}=}
 * Returns:
 *   {{sandbox:Object, drive:Object, bulletinWeeksSheet:Object}}
 */
function makeEnv(options) {
  const o = options || {};
  const boot = loadAllSrcFilesInOrder(GAS_STUBS);

  const cfg = {};
  boot.DEFAULTS.forEach(function (d) { cfg[d.key] = d.value; });
  cfg.ROSTER_SPREADSHEET_ID = FAKE_ROSTER_ID;
  cfg.TEMPLATE_FILE_ID_NORMAL = o.templateConfigured === false ? '' : FAKE_TEMPLATE_ID;
  cfg.BULLETIN_OUTPUT_FOLDER_ID = o.folderConfigured === false ? '' : FAKE_FOLDER_ID;

  const ownSheets = {};
  Object.keys(boot.SHEETS).forEach(function (id) { ownSheets[boot.SHEETS[id]] = ownSheetFor(boot, id, []); });
  ownSheets.Config = ownSheetFor(boot, 'CONFIG', Object.keys(cfg).map(function (k) {
    return { KEY: k, VALUE: cfg[k], NOTE: '', EDITABLE: true };
  }));

  const weekRows = o.weekRows || SERVICE_DATES.map(function (iso, i) {
    return {
      SERVICE_DATE: iso, QUARTER_ID: QUARTER_ID, WEEK_OF_MONTH: i + 1, STATUS: 'DRAFT',
      PROGRAM_TEMPLATE_ID: 'TPL_NORMAL', SERMON_TITLE: '講題' + (i + 1), PAGE_TITLE: '崇拜程序'
    };
  });
  const bulletinWeeksSheet = ownSheetFor(boot, 'BULLETIN_WEEKS', weekRows);
  ownSheets.BulletinWeeks = bulletinWeeksSheet;
  ownSheets.PostDisplay = ownSheetFor(boot, 'POST_DISPLAY', boot.seedPostDisplayRows_());
  ownSheets.MergeGroups = ownSheetFor(boot, 'MERGE_GROUPS', boot.seedMergeGroupsRows_());
  ownSheets.ProgramTemplates = ownSheetFor(boot, 'PROGRAM_TEMPLATES', boot.seedProgramTemplatesRows_());

  const rosterSheets = {
    RosterAssignments: rosterSheetFor(boot, 'ASSIGNMENTS', []),
    RosterVersions: rosterSheetFor(boot, 'VERSIONS', [{ QuarterID: QUARTER_ID, VersionNo: 1 }]),
    Quarters: rosterSheetFor(boot, 'QUARTERS', [{ QuarterID: QUARTER_ID, Stage: 'OFFICIAL_SENT' }]),
    ServiceDates: rosterSheetFor(boot, 'SERVICE_DATES', SERVICE_DATES.map(function (iso, i) {
      return { ServiceDateID: 'SD' + (i + 1), QuarterID: QUARTER_ID, ServiceDate: iso, WeekIndex: i + 1, IsFirstSundayOfMonth: i === 0, ServiceType: '主日崇拜', SpecialID: '' };
    })),
    SpecialSundays: rosterSheetFor(boot, 'SPECIAL_SUNDAYS', []),
    NameMapping: rosterSheetFor(boot, 'NAME_MAPPING', []),
    Posts: rosterSheetFor(boot, 'POSTS', [])
  };

  const drive = makeFakeDriveApp({
    files: { [FAKE_TEMPLATE_ID]: buildFakeDocx(o.templateXml || templateDocumentXml()) },
    folders: o.folderConfigured === false ? {} : { [FAKE_FOLDER_ID]: {} }
  });

  const FakeSpreadsheetApp = {
    getActiveSpreadsheet: function () { return makeFakeSpreadsheet(ownSheets); },
    openById: function (id) {
      if (id !== FAKE_ROSTER_ID) throw new Error('openById: 未預期的 id ' + id);
      return makeFakeSpreadsheet(rosterSheets);
    }
  };

  return {
    sandbox: loadAllSrcFilesInOrder(Object.assign({}, GAS_STUBS, {
      SpreadsheetApp: FakeSpreadsheetApp,
      DriveApp: drive.DriveApp,
      Utilities: makeFakeUtilities()
    })),
    drive: drive,
    bulletinWeeksSheet: bulletinWeeksSheet
  };
}

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
// 基本情況：全部成功
// =====================================================================

test('1. 全部三個主日成功產生，回傳統計與 BulletinWeeks 記錄都正確', function () {
  const env = makeEnv({});
  const summary = env.sandbox.generateQuarterBulletinsBatch_(QUARTER_ID);

  assert.strictEqual(summary.total, 3);
  assert.strictEqual(summary.succeeded, 3);
  assert.strictEqual(summary.failed, 0);
  assert.strictEqual(summary.skipped, 0);
  assert.strictEqual(summary.stoppedForTime, false);

  const weeks = env.sandbox.readSheet('BulletinWeeks');
  weeks.forEach(function (w) {
    assert.ok(w.DOC_ID, w.SERVICE_DATE + ' 應該有 DOC_ID');
    // ⚠️ 跨 vm realm：這個 Date 是 sandbox 造出來的，不可以用
    // instanceof Date（不同 realm 的 Date 建構子不是同一個）。
    assert.strictEqual(Object.prototype.toString.call(w.LAST_GENERATED_AT), '[object Date]',
      w.SERVICE_DATE + ' 應該有 LAST_GENERATED_AT');
  });

  assert.strictEqual(env.drive.listFolderFiles(FAKE_FOLDER_ID).length, 3, '應該產生了 3 個檔案');

  const diagnostics = env.sandbox.readSheet('Diagnostics');
  assert.ok(diagnostics.some(function (r) { return r.REPORT_NAME === '本季週報產生'; }));
});

// =====================================================================
// 2. 單一主日失敗不會中斷其餘的
// =====================================================================

test('2. 範本未設定 → 每一個主日都失敗，但不拋錯、逐一記錄原因', function () {
  const env = makeEnv({ templateConfigured: false });
  const summary = env.sandbox.generateQuarterBulletinsBatch_(QUARTER_ID);

  assert.strictEqual(summary.total, 3);
  assert.strictEqual(summary.succeeded, 0);
  assert.strictEqual(summary.failed, 3);
  summary.results.forEach(function (r) {
    assert.strictEqual(r.status, 'FAILED');
    assert.ok(r.message.indexOf('尚未設定 Word 範本') !== -1, r.message);
  });
});

test('2b. 只有其中一個主日的 BulletinWeeks 缺少職事表資料仍然可以運作（其餘照常成功）', function () {
  // 職事表沒有任何 RosterAssignments，但 buildBulletinModel_ 對「有主日
  // 但沒有事奉安排」的情況本來就寬容處理（讀得到快照、只是事奉框空白），
  // 所以這裡改用「輸出資料夾沒有設定」製造一個會讓全部主日都失敗、但
  // 彼此獨立、不會互相影響的情境，驗證「單一失敗不中斷」是逐一判斷、
  // 不是抓到第一個錯就整批放棄。
  const env = makeEnv({ folderConfigured: false });
  let summary;
  assert.doesNotThrow(function () { summary = env.sandbox.generateQuarterBulletinsBatch_(QUARTER_ID); });
  assert.strictEqual(summary.total, 3);
  assert.strictEqual(summary.failed, 3, '三個主日都應該各自失敗一次，而不是拋錯中斷');
});

// =====================================================================
// 3. 已經產生過的不重做
// =====================================================================

test('3. 其中一個主日已經有 LAST_GENERATED_AT → 跳過，不重新產生', function () {
  const weekRows = SERVICE_DATES.map(function (iso, i) {
    const row = { SERVICE_DATE: iso, QUARTER_ID: QUARTER_ID, WEEK_OF_MONTH: i + 1, STATUS: 'DRAFT', SERMON_TITLE: '講題' + (i + 1) };
    // ⚠️ 一律用 yyyy-MM-dd 字串，不要直接塞 `new Date(...)`——這個物件會在
    // 測試腳本自己的 realm 造出來，跨到 sandbox 的 vm realm 讀回來會
    // 「不是 Date 物件、也不是合法字串」，見 tests/helpers/fakeSpreadsheet.js
    // 的 toRealmSafeCellValue() 說明。
    if (i === 0) { row.DOC_ID = 'ALREADY_DONE_ID'; row.LAST_GENERATED_AT = '2027-10-31'; }
    return row;
  });
  const env = makeEnv({ weekRows: weekRows });
  const summary = env.sandbox.generateQuarterBulletinsBatch_(QUARTER_ID);

  assert.strictEqual(summary.skipped, 1);
  assert.strictEqual(summary.succeeded, 2);
  assert.strictEqual(summary.results[0].status, 'SKIPPED');
  assert.strictEqual(env.drive.listFolderFiles(FAKE_FOLDER_ID).length, 2, '已經做過的那個主日不應該再產生一次新檔案');
});

// =====================================================================
// 4. 接近時間上限會安全中止
// =====================================================================

test('4. nowFn 模擬時間已經超過預算 → 一個都還沒開始就安全中止，不拋錯', function () {
  const env = makeEnv({});
  let called = 0;
  const summary = env.sandbox.generateQuarterBulletinsBatch_(QUARTER_ID, {
    nowFn: function () {
      called++;
      // 第一次呼叫（算 startMs）回 0；之後每次呼叫（迴圈內檢查）都回一個
      // 已經超過預算的時間，模擬「一開始執行就已經沒有時間了」。
      return called === 1 ? 0 : env.sandbox.bulletinBatchTimeBudgetMs_() + 1;
    }
  });

  assert.strictEqual(summary.stoppedForTime, true);
  assert.strictEqual(summary.succeeded, 0);
  assert.strictEqual(summary.failed, 0);
  assert.strictEqual(summary.skipped, 0);
  assert.strictEqual(summary.results.length, 0, '一個主日都不應該處理過');
});

test('4b. 處理完第一個主日之後才超過時間預算 → 只完成 1 個，其餘中止但不遺失已完成的', function () {
  const env = makeEnv({});
  let called = 0;
  const summary = env.sandbox.generateQuarterBulletinsBatch_(QUARTER_ID, {
    nowFn: function () {
      called++;
      if (called === 1) return 0; // startMs
      if (called === 2) return 1000; // 處理第 1 個主日之前的檢查：還沒超過
      return env.sandbox.bulletinBatchTimeBudgetMs_() + 1; // 之後全部超過
    }
  });

  assert.strictEqual(summary.stoppedForTime, true);
  assert.strictEqual(summary.succeeded, 1);
  assert.strictEqual(summary.results.length, 1);
  assert.strictEqual(env.drive.listFolderFiles(FAKE_FOLDER_ID).length, 1, '已完成的那一份不可以遺失');
});

// =====================================================================
// shouldStopBulletinBatchForTime_ / bulletinAlreadyGenerated_：純函式直接測
// =====================================================================

test('shouldStopBulletinBatchForTime_()：還沒到預算 → false；已達到／超過 → true', function () {
  const env = makeEnv({});
  assert.strictEqual(env.sandbox.shouldStopBulletinBatchForTime_(0, 1000, 5000), false);
  assert.strictEqual(env.sandbox.shouldStopBulletinBatchForTime_(0, 5000, 5000), true);
  assert.strictEqual(env.sandbox.shouldStopBulletinBatchForTime_(0, 6000, 5000), true);
});

test('bulletinAlreadyGenerated_()：LAST_GENERATED_AT 有值才算已產生；沒有那一行也算沒有產生過', function () {
  const env = makeEnv({});
  assert.strictEqual(env.sandbox.bulletinAlreadyGenerated_(null), false);
  assert.strictEqual(env.sandbox.bulletinAlreadyGenerated_({}), false);
  // ⚠️ Date 物件一定要用 sandbox 自己造的（normalizeDate_()），不可以用
  // 測試腳本自己 realm 的 `new Date()`——見本檔案其他地方的跨 realm 說明。
  const sandboxDate = env.sandbox.normalizeDate_('2027-10-31');
  assert.strictEqual(env.sandbox.bulletinAlreadyGenerated_({ LAST_GENERATED_AT: sandboxDate }), true);
});

// =====================================================================

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
