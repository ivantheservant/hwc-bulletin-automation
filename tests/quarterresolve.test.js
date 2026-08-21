#!/usr/bin/env node
/**
 * tests/quarterresolve.test.js
 *
 * `resolveWorkingQuarter_()`（`src/QuarterResolve.gs`）的回歸測試——「本季」
 * 季度 ID 推算的單一真相來源，四層退回機制（CONFIG_OVERRIDE →
 * NEXT_SEND_SUNDAY → ROSTER_TEST_DATE → BULLETIN_WEEKS_LATEST），以及
 * `runSelfCheck_()` 接上這個函式之後的行為。
 *
 * 執行方式：node tests/quarterresolve.test.js
 * 離開碼：0＝全部通過　1＝有測試失敗
 */

'use strict';

const assert = require('assert');
const { loadAllSrcFilesInOrder } = require('./helpers/loadGas');
const { makeFakeSheet, makeFakeSpreadsheet } = require('./helpers/fakeSpreadsheet');
const { makeFillEnv } = require('./helpers/fillEnv');

const GAS_STUBS = {
  Utilities: {
    formatDate: function (date, tz, pattern) {
      const y = date.getFullYear();
      const mo = String(date.getMonth() + 1).padStart(2, '0');
      const d = String(date.getDate()).padStart(2, '0');
      if (String(pattern).indexOf('HH') !== -1) return `${y}-${mo}-${d} 00:00`;
      return `${y}-${mo}-${d}`;
    }
  },
  Session: {
    getScriptTimeZone: function () { return 'Pacific/Auckland'; },
    getActiveUser: function () { return { getEmail: function () { return 'tester@x.com'; } }; }
  },
  SpreadsheetApp: {},
  CacheService: {},
  HtmlService: {}
};

const FAKE_ROSTER_ID = 'FAKE_ROSTER_ID_FOR_QUARTER_TESTS';

/** 今天的日期，yyyy-MM-dd（本機時區，純字串——不可以把 Date 物件跨 realm 傳）。 */
function todayIsoLocal() {
  const d = new Date();
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${mo}-${day}`;
}

/** isoDate 加 days 天（純字串運算，避免任何 Date 物件跨 realm）。 */
function addDaysIso(isoDate, days) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const dt = new Date(y, m - 1, d + days);
  const yy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const dd = String(dt.getDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

/**
 * 用途：造一個只關心「季度推算」的測試環境——職事表可以放多個季度的
 *   ServiceDates，`BulletinWeeks` 可以獨立控制，不需要範本／收件人等
 *   跟自我檢測其餘項目有關的假資料。
 * Args:
 *   options {{config:Object=, quarters:Object[]=, weekRows:Object[]=}=}
 *     `quarters` 每個元素是 `{quarterId, dates}`，`dates` 是 ISO 字串陣列，
 *     會展開成 ServiceDates／Versions／Quarters／Assignments 的最小資料。
 * Returns:
 *   {{sandbox:Object}}
 */
function makeQuarterEnv(options) {
  const o = options || {};
  const boot = loadAllSrcFilesInOrder(GAS_STUBS);

  const cfg = {};
  boot.DEFAULTS.forEach(function (d) { cfg[d.key] = d.value; });
  cfg.ROSTER_SPREADSHEET_ID = FAKE_ROSTER_ID;
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
  ownSheets.BulletinWeeks = ownSheet('BULLETIN_WEEKS', o.weekRows || []);

  const quarters = o.quarters || [];
  const serviceDateRows = [];
  const versionRows = [];
  const quarterRows = [];
  const assignmentRows = [];
  quarters.forEach(function (q) {
    quarterRows.push({ QuarterID: q.quarterId, Stage: 'OFFICIAL_SENT' });
    versionRows.push({ QuarterID: q.quarterId, VersionNo: 1 });
    (q.dates || []).forEach(function (iso, i) {
      serviceDateRows.push({
        ServiceDateID: q.quarterId + '_SD' + (i + 1), QuarterID: q.quarterId, ServiceDate: iso,
        WeekIndex: i + 1, IsFirstSundayOfMonth: i === 0, ServiceType: '主日崇拜', SpecialID: ''
      });
      assignmentRows.push({
        QuarterID: q.quarterId, VersionNo: 1, ServiceDate: iso, PostID: 'CHAIR',
        SlotIndex: 1, PersonID: 'P9001', PersonNameSnapshot: '陳大文', AssignSource: 'AUTO', Locked: false
      });
    });
  });

  function rosterSheet(defKey, rows) {
    const keys = Object.keys(boot.ROSTER_TABLE_DEFS_[defKey].columns);
    return makeFakeSheet(keys, keys, rows || []);
  }

  const rosterSheets = {
    RosterAssignments: rosterSheet('ASSIGNMENTS', assignmentRows),
    RosterVersions: rosterSheet('VERSIONS', versionRows),
    Quarters: rosterSheet('QUARTERS', quarterRows),
    ServiceDates: rosterSheet('SERVICE_DATES', serviceDateRows),
    SpecialSundays: rosterSheet('SPECIAL_SUNDAYS', []),
    NameMapping: rosterSheet('NAME_MAPPING', [{ PersonID: 'P9001', NameTC: '陳大文', Active: true }]),
    Posts: rosterSheet('POSTS', [
      { PostID: 'CHAIR', PostName_TC: '主席', SlotCount: 1, Frequency: 'WEEKLY', AutoGenerate: true, DisplayOrder: 10, Active: true, EmptyDisplay: 'PENDING' }
    ])
  };

  const FakeSpreadsheetApp = {
    getActiveSpreadsheet: function () { return makeFakeSpreadsheet(ownSheets); },
    openById: function (id) {
      if (o.rosterNotConfigured) throw new Error('openById: 不應該在職事表未設定時被呼叫');
      if (id !== FAKE_ROSTER_ID) throw new Error('openById: 未預期的 id ' + id);
      return makeFakeSpreadsheet(rosterSheets);
    }
  };

  const sandbox = loadAllSrcFilesInOrder(Object.assign({}, GAS_STUBS, { SpreadsheetApp: FakeSpreadsheetApp }));
  return { sandbox: sandbox };
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

// =====================================================================
// 1-9：resolveWorkingQuarter_() 四層退回機制
// =====================================================================

test('1. 職事表有下一個要寄的主日 → source === NEXT_SEND_SUNDAY', function () {
  const today = todayIsoLocal();
  const nextIso = addDaysIso(today, 6); // SEND_TARGET_OFFSET_DAYS 預設 6
  const env = makeQuarterEnv({
    quarters: [{ quarterId: 'Q_NEXT', dates: [nextIso] }]
  });
  const result = env.sandbox.resolveWorkingQuarter_();
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.source, 'NEXT_SEND_SUNDAY');
  assert.strictEqual(result.quarterId, 'Q_NEXT');
});

test('2. 職事表沒有今年資料（模擬 2026 現況）→ 退回 ROSTER_TEST_DATE，ok===true', function () {
  const today = todayIsoLocal();
  const nextIso = addDaysIso(today, 6);
  const env = makeQuarterEnv({
    config: { ROSTER_TEST_DATE: '2027-10-03' },
    // 職事表只有 ROSTER_TEST_DATE 那個季度，「下一個要寄的主日」那個
    // 日期（今天 + 6 天）故意不放進去，模擬「職事表沒有今年資料」。
    quarters: [{ quarterId: 'Q_TEST', dates: ['2027-10-03'] }]
  });
  assert.notStrictEqual(nextIso, '2027-10-03', '這個測試假設今天 + 6 天不是剛好 2027-10-03');
  const result = env.sandbox.resolveWorkingQuarter_();
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.source, 'ROSTER_TEST_DATE');
  assert.strictEqual(result.quarterId, 'Q_TEST');
});

test('3. ROSTER_TEST_DATE 為 Date 物件 → coerceConfigRawValue_ 正確轉成 yyyy-MM-dd（getConfig() 的既有保證）', function () {
  // resolveWorkingQuarter_() 透過 getConfig() 讀 ROSTER_TEST_DATE，而
  // getConfig() 已經保證 Config 儲存格的 Date 物件會被 coerceConfigRawValue_()
  // 正規化成 yyyy-MM-dd 字串（src/ConfigService.gs）——resolveWorkingQuarter_()
  // 本身不需要、也不應該再處理一次 Date 物件。這裡直接驗證那個既有保證，
  // 而不是把測試檔案自己 new 出來的 Date 物件（屬於外層 Node realm）硬塞進
  // 假工作表——那樣會撞上 vm context 之間 instanceof Date 不成立的問題
  // （見 docs/待確認事項.md 這一輪的說明）。
  const env = makeQuarterEnv({});
  const dateInSandboxRealm = env.sandbox.normalizeDate_('2027-11-07');
  const coerced = env.sandbox.coerceConfigRawValue_(dateInSandboxRealm);
  assert.strictEqual(coerced, '2027-11-07');
});

test('4. ROSTER_TEST_DATE 為字串 2027-11-07 → 正常解析', function () {
  const today = todayIsoLocal();
  const nextIso = addDaysIso(today, 6);
  const env = makeQuarterEnv({
    config: { ROSTER_TEST_DATE: '2027-11-07' },
    quarters: [{ quarterId: 'Q_STR', dates: ['2027-11-07'] }]
  });
  assert.notStrictEqual(nextIso, '2027-11-07');
  const result = env.sandbox.resolveWorkingQuarter_();
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.source, 'ROSTER_TEST_DATE');
  assert.strictEqual(result.quarterId, 'Q_STR');
});

test('5. ROSTER_TEST_DATE 為 7/11/2027（格式不符）→ 記 note 說明，退到下一層，不拋錯', function () {
  const today = todayIsoLocal();
  const nextIso = addDaysIso(today, 6);
  const env = makeQuarterEnv({
    config: { ROSTER_TEST_DATE: '7/11/2027' },
    quarters: [], // 職事表沒有任何季度，逼第 2、3 層都失敗
    weekRows: [
      { SERVICE_DATE: '2027-12-05', QUARTER_ID: 'Q_FALLBACK', WEEK_OF_MONTH: 1, STATUS: 'DRAFT' }
    ]
  });
  assert.notStrictEqual(nextIso, '7/11/2027');
  let result;
  assert.doesNotThrow(function () { result = env.sandbox.resolveWorkingQuarter_(); });
  assert.ok(result.notes.some(function (n) { return n.indexOf('格式不符') !== -1; }), JSON.stringify(result.notes));
  assert.strictEqual(result.ok, true, '格式錯誤那一層失敗之後，應該繼續退到第 4 層');
  assert.strictEqual(result.source, 'BULLETIN_WEEKS_LATEST');
  assert.strictEqual(result.quarterId, 'Q_FALLBACK');
});

test('6. ROSTER_TEST_DATE 為空 → 退到 BULLETIN_WEEKS_LATEST', function () {
  const env = makeQuarterEnv({
    config: { ROSTER_TEST_DATE: '' },
    quarters: [],
    weekRows: [
      { SERVICE_DATE: '2027-12-05', QUARTER_ID: 'Q_LATEST', WEEK_OF_MONTH: 1, STATUS: 'DRAFT' },
      { SERVICE_DATE: '2027-12-12', QUARTER_ID: 'Q_LATEST', WEEK_OF_MONTH: 2, STATUS: 'DRAFT' }
    ]
  });
  const result = env.sandbox.resolveWorkingQuarter_();
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.source, 'BULLETIN_WEEKS_LATEST');
  assert.strictEqual(result.quarterId, 'Q_LATEST');
  assert.ok(result.notes.some(function (n) { return n.indexOf('設定值 ROSTER_TEST_DATE 是空的') !== -1; }));
});

test('7. 四層全部失敗 → ok===false、notes.length>=4，不拋錯', function () {
  const env = makeQuarterEnv({
    config: { ROSTER_SPREADSHEET_ID: '', ROSTER_TEST_DATE: '' },
    quarters: [],
    weekRows: []
  });
  let result;
  assert.doesNotThrow(function () { result = env.sandbox.resolveWorkingQuarter_(); });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.quarterId, '');
  assert.ok(result.notes.length >= 4, JSON.stringify(result.notes));
});

test('8. WORKING_QUARTER_ID 有值 → 直接採用，不執行其餘層', function () {
  const today = todayIsoLocal();
  const env = makeQuarterEnv({
    config: { WORKING_QUARTER_ID: 'Q_OVERRIDE' },
    quarters: [
      { quarterId: 'Q_OVERRIDE', dates: ['2027-06-06'] },
      { quarterId: 'Q_NEXT', dates: [addDaysIso(today, 6)] } // 如果第 2 層有跑，會錯誤地選中這個
    ]
  });
  const result = env.sandbox.resolveWorkingQuarter_();
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.source, 'CONFIG_OVERRIDE');
  assert.strictEqual(result.quarterId, 'Q_OVERRIDE');
  assert.strictEqual(result.notes.length, 1, '只應該有第 1 層自己那一句 note，證明沒有執行後面幾層：' + JSON.stringify(result.notes));
});

test('9. WORKING_QUARTER_ID 指定的季度不存在 → 仍然採用，但 notes 有警告句', function () {
  const env = makeQuarterEnv({
    config: { WORKING_QUARTER_ID: 'Q_GHOST' },
    quarters: []
  });
  const result = env.sandbox.resolveWorkingQuarter_();
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.source, 'CONFIG_OVERRIDE');
  assert.strictEqual(result.quarterId, 'Q_GHOST');
  assert.ok(result.notes.some(function (n) { return n.indexOf('找不到') !== -1; }), JSON.stringify(result.notes));
});

// =====================================================================
// 10-12：由真正入口（runSelfCheck_()）跑一次
// =====================================================================

test('10. 由真正入口 runSelfCheck_() 跑一次，四層全部失敗時「尊稱未設定」「待填欄位總數」兩項為 🟡，不拋錯', function () {
  const env = makeFillEnv({
    withGrid: false,
    weekRows: [],
    config: { ROSTER_SPREADSHEET_ID: '', ROSTER_TEST_DATE: '', WORKING_QUARTER_ID: '' }
  });
  let summary;
  assert.doesNotThrow(function () { summary = env.sandbox.runSelfCheck_(); });

  const honorific = summary.items.filter(function (i) { return i.label.indexOf('尊稱未設定') !== -1; })[0];
  const missingFields = summary.items.filter(function (i) { return i.label.indexOf('待填欄位總數') !== -1; })[0];
  const quarterItem = summary.items.filter(function (i) { return i.label === '檢測季度'; })[0];

  assert.strictEqual(quarterItem.status, '🟡');
  assert.strictEqual(honorific.status, '🟡');
  assert.ok(honorific.message.indexOf('檢測季度') !== -1, honorific.message);
  assert.strictEqual(missingFields.status, '🟡');
  assert.ok(missingFields.message.indexOf('檢測季度') !== -1, missingFields.message);
});

test('11. 由真正入口跑一次，「尊稱未設定」與「待填欄位總數」用的是同一個 quarterId', function () {
  const env = makeFillEnv({}); // 預設 fixture：職事表與 BulletinWeeks 都是 2027T4
  const summary = env.sandbox.runSelfCheck_();

  const quarterItem = summary.items.filter(function (i) { return i.label === '檢測季度'; })[0];
  const missingFields = summary.items.filter(function (i) { return i.label.indexOf('待填欄位總數') !== -1; })[0];

  assert.ok(quarterItem.message.indexOf('2027T4') !== -1, quarterItem.message);
  assert.ok(missingFields.label.indexOf('2027T4') !== -1, missingFields.label);
});

test('12. 自我檢測報告寫入 Diagnostics 的行數不超過 DIAGNOSTICS_MAX_ROWS', function () {
  // fillEnv 預設的四個主日（2027T4）在 BulletinWeeks 裡幾乎每一欄都是
  // 空的，會產生大量「待填欄位」明細行；把 DIAGNOSTICS_MAX_ROWS 調得很低，
  // 驗證 writeDiagnosticsReport_() 既有的截斷機制仍然套用在這些新增的
  // 明細行上——不會因為多印了明細就讓整份報告超過上限。
  const env = makeFillEnv({ withGrid: false, config: { DIAGNOSTICS_MAX_ROWS: '10' } });

  assert.doesNotThrow(function () { env.sandbox.runSelfCheck_(); });
  const diagnosticsRows = env.sandbox.readSheet('Diagnostics');
  assert.ok(diagnosticsRows.length <= 10, '應該不超過 DIAGNOSTICS_MAX_ROWS（10），實際：' + diagnosticsRows.length);
});

// =====================================================================
// 補充：pickLatestBulletinWeeksQuarter_() 排序規則（純函式）
// =====================================================================

test('補充 a. pickLatestBulletinWeeksQuarter_()：主日數最多的季度優先', function () {
  const env = makeQuarterEnv({});
  const rows = [
    { QUARTER_ID: 'A', SERVICE_DATE: '2027-01-01' },
    { QUARTER_ID: 'B', SERVICE_DATE: '2027-01-01' },
    { QUARTER_ID: 'B', SERVICE_DATE: '2027-01-08' }
  ];
  const result = env.sandbox.pickLatestBulletinWeeksQuarter_(rows, '2027-01-01');
  assert.strictEqual(result.quarterId, 'B');
  assert.strictEqual(result.count, 2);
});

test('補充 b. pickLatestBulletinWeeksQuarter_()：主日數相同時，最接近今日的季度優先', function () {
  const env = makeQuarterEnv({});
  const rows = [
    { QUARTER_ID: 'FAR', SERVICE_DATE: '2020-01-01' },
    { QUARTER_ID: 'NEAR', SERVICE_DATE: '2027-01-02' }
  ];
  const result = env.sandbox.pickLatestBulletinWeeksQuarter_(rows, '2027-01-01');
  assert.strictEqual(result.quarterId, 'NEAR');
});

test('補充 c. pickLatestBulletinWeeksQuarter_()：沒有任何季度 → 空字串、0', function () {
  const env = makeQuarterEnv({});
  const result = env.sandbox.pickLatestBulletinWeeksQuarter_([], '2027-01-01');
  assert.strictEqual(result.quarterId, '');
  assert.strictEqual(result.count, 0);
});

// =====================================================================

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
