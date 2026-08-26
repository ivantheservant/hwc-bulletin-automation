#!/usr/bin/env node
/**
 * tests/rosterquarterleak.test.js
 *
 * 「建立季度時抓了別季的事奉資料」那一輪查證與修正的回歸測試
 * （docs/已知bug類型.md 事故四十一）。
 *
 * ⚠️ 這一組的來由值得記住：**原本的懷疑是錯的。**
 *
 * 自測機報「職事表沒有 2030T2，卻有 26 格事奉資料」，最大嫌疑是讀職事表
 * 時退回了 `ROSTER_TEST_DATE`（2027-11-07 → 2027T4），把 2027 年的名單填進
 * 2030 年。查證的做法是造一個**只有 2027T4** 的假職事表，然後真的叫
 * `createBlankBulletinWeeks_('2030T2')`，逐格看寫了什麼。
 *
 * 結果：一格 2027 年的資料都沒有漏過來。那 26 格是 13 行 × 兩欄
 * （`WEEK_OF_MONTH` 由日期算、`PROGRAM_TEMPLATE_ID` 退回 Config 預設值），
 * 兩欄都不讀職事表。真正的缺陷是**斷言用錯了欄位清單**，加上
 * `countRosterStatuses_()` 把空白當成 `OK`。
 *
 * 所以這一組同時鎖住兩件事：
 *   1. 真的沒有跨季（第 1 組）——這是查證結論，要有測試守住；
 *   2. 幾個令人誤判的地方已經修好（第 2、3 組）。
 *
 * 執行方式：node tests/rosterquarterleak.test.js
 * 離開碼：0＝全部通過　1＝有測試失敗
 */

'use strict';

const assert = require('assert');
const { loadAllSrcFilesInOrder } = require('./helpers/loadGas');
const { makeFakeSheet, makeFakeSpreadsheet } = require('./helpers/fakeSpreadsheet');

const FAKE_ROSTER_ID = 'FAKE_ROSTER_FOR_QUARTER_LEAK_TEST';

/** 職事表只有這一季；沙盒要建立的是完全另一年的季度。 */
const ROSTER_QUARTER = '2027T4';
const ROSTER_DATE = '2027-10-03';
const ROSTER_PERSON = '陳大文';
const ROSTER_SPECIAL_TITLE = '聖餐主日';

/** 職事表確定沒有這一季。 */
const TARGET_QUARTER = '2030T2';

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

function baseStubs() {
  return {
    Utilities: {
      formatDate: function (date, tz, pattern) {
        const y = date.getFullYear();
        const mo = String(date.getMonth() + 1).padStart(2, '0');
        const d = String(date.getDate()).padStart(2, '0');
        const hh = String(date.getHours()).padStart(2, '0');
        const mi = String(date.getMinutes()).padStart(2, '0');
        if (String(pattern) === 'dd/MM/yyyy') return `${d}/${mo}/${y}`;
        if (String(pattern).indexOf('HH') !== -1) return `${y}-${mo}-${d} ${hh}:${mi}`;
        return `${y}-${mo}-${d}`;
      }
    },
    Session: {
      getScriptTimeZone: function () { return 'Pacific/Auckland'; },
      getActiveUser: function () { return { getEmail: function () { return 'tester@example.com'; } }; }
    },
    CacheService: {},
    HtmlService: {}
  };
}

const boot = loadAllSrcFilesInOrder(baseStubs());

/** 用 ROSTER_TABLE_DEFS_ 的機器鍵組出一張假的職事表分頁。 */
function rosterSheet(defKey, rows) {
  const keys = Object.keys(boot.ROSTER_TABLE_DEFS_[defKey].columns);
  return makeFakeSheet(keys, keys, rows);
}

/**
 * 造一個「只有 2027T4」的假職事表。刻意連特別主日與人名都放進去——
 * 一旦有任何一格跨季漏過來，測試就看得見那個具體的值。
 */
function makeRosterSheets(extraServiceDate) {
  const serviceDateRows = [{
    ServiceDateID: 'SD1', QuarterID: ROSTER_QUARTER, ServiceDate: ROSTER_DATE, WeekIndex: 1,
    IsFirstSundayOfMonth: true, ServiceType: '主日崇拜', SpecialID: 'SP1',
    AutoGenerate: true, Notes: ''
  }];
  if (extraServiceDate) {
    serviceDateRows.push({
      ServiceDateID: 'SD-EXTRA', QuarterID: extraServiceDate.quarterId,
      ServiceDate: extraServiceDate.iso, WeekIndex: 1,
      IsFirstSundayOfMonth: true, ServiceType: '主日崇拜', SpecialID: '',
      AutoGenerate: true, Notes: ''
    });
  }
  return {
    RosterAssignments: rosterSheet('ASSIGNMENTS', [{
      AssignmentID: 'A1', QuarterID: ROSTER_QUARTER, VersionNo: 1, ServiceDateID: 'SD1',
      ServiceDate: ROSTER_DATE, PostID: 'CHAIR', SlotIndex: 1, PersonID: 'P1',
      PersonNameSnapshot: ROSTER_PERSON, AssignSource: 'AUTO', RuleFlags: '', Locked: false,
      UpdatedAt: '2027-09-01', UpdatedBy: 'system'
    }]),
    RosterVersions: rosterSheet('VERSIONS', [{
      VersionID: 'V1', QuarterID: ROSTER_QUARTER, VersionNo: 1, SheetName: 'V1', Basis: '',
      ParentVersionNo: '', Status: 'ACTIVE', Protected: false, WarningCount: 0,
      CreatedAt: '2027-09-01', CreatedBy: 'system', Notes: ''
    }]),
    Quarters: rosterSheet('QUARTERS', [{
      QuarterID: ROSTER_QUARTER, Year: 2027, Term: 'T4', StartDate: ROSTER_DATE,
      EndDate: '2027-12-26', WeekCount: 13, GenerateOn: '2027-09-01',
      OfficialSendOn: '2027-09-15', Status: 'ACTIVE', Notes: '',
      Stage: 'OFFICIAL_SENT', StageUpdatedAt: '2027-09-15'
    }]),
    ServiceDates: rosterSheet('SERVICE_DATES', serviceDateRows),
    // ⚠️ 特別主日按**日期**比對（見 buildSpecialSundayDateIndex_() 與
    //    docs/已知bug類型.md 事故四），所以一定要有 ServiceDate 與 Active。
    SpecialSundays: rosterSheet('SPECIAL_SUNDAYS', [{
      SpecialID: 'SP1', QuarterID: ROSTER_QUARTER, ServiceDate: ROSTER_DATE,
      Type: '聖餐', Title: ROSTER_SPECIAL_TITLE, SkipPostIDs: '', LockPostIDs: '',
      ExternalOwner: '', CommunionOverride: '', TranslationRequired: false, Active: true
    }]),
    NameMapping: rosterSheet('NAME_MAPPING', [{ PersonID: 'P1', NameTC: ROSTER_PERSON, Active: true }]),
    Posts: rosterSheet('POSTS', [{
      PostID: 'CHAIR', PostNameTC: '主席', SlotCount: 1, DisplayOrder: 1, Active: true,
      Category: '', Notes: ''
    }])
  };
}

/**
 * 造一個環境：週報試算表是空的，職事表只有 2027T4。
 * `weekRows` 可以預先放幾行 `BulletinWeeks`。
 */
function makeEnv(options) {
  const o = options || {};

  const cfg = {};
  boot.DEFAULTS.forEach(function (d) { cfg[d.key] = d.value; });
  cfg.ROSTER_SPREADSHEET_ID = FAKE_ROSTER_ID;
  Object.assign(cfg, o.config || {});

  const sheets = {};
  Object.keys(boot.SHEETS).forEach(function (id) {
    const def = boot.COLUMNS[id];
    sheets[boot.SHEETS[id]] = makeFakeSheet(def.headers, def.keys, []);
  });
  sheets.Config = makeFakeSheet(boot.COLUMNS.CONFIG.headers, boot.COLUMNS.CONFIG.keys,
    Object.keys(cfg).map(function (k) { return { KEY: k, VALUE: cfg[k], NOTE: '', EDITABLE: true }; }));
  sheets.BulletinWeeks = makeFakeSheet(boot.COLUMNS.BULLETIN_WEEKS.headers,
    boot.COLUMNS.BULLETIN_WEEKS.keys, o.weekRows || []);

  const rosterSheets = makeRosterSheets(o.rosterExtraServiceDate);

  const sandbox = loadAllSrcFilesInOrder(Object.assign({}, baseStubs(), {
    SpreadsheetApp: {
      getActiveSpreadsheet: function () { return makeFakeSpreadsheet(sheets); },
      openById: function (id) {
        if (id !== FAKE_ROSTER_ID) throw new Error('未預期的 openById：' + id);
        return makeFakeSpreadsheet(rosterSheets);
      },
      ProtectionType: { SHEET: 'SHEET' },
      getUi: function () { throw new Error('這一組測試不應該用到 UI'); }
    }
  }));

  return { sandbox: sandbox, sheets: sheets };
}

/** 讀回某一季的資料列。 */
function quarterRows(env, quarterId) {
  return env.sandbox.readSheet(env.sandbox.SHEETS.BULLETIN_WEEKS).filter(function (r) {
    return String(r.QUARTER_ID || '').trim() === quarterId;
  });
}

// =====================================================================
// 第 1 組：職事表沒有該季 → 一格別季的資料都不可以有
// =====================================================================

console.log('\n第 1 組：職事表沒有該季資料時建立週報');

test('建立之後，只可能來自職事表的格全部空白', function () {
  const env = makeEnv({});
  env.sandbox.createBlankBulletinWeeks_(TARGET_QUARTER);

  const rows = quarterRows(env, TARGET_QUARTER);
  assert.ok(rows.length >= 12, '應該照樣建立整季，實際 ' + rows.length + ' 行');

  const onlyKeys = env.sandbox.rosterOnlyWeekFieldKeys_();
  const dirty = [];
  rows.forEach(function (row) {
    onlyKeys.forEach(function (key) {
      if (!env.sandbox.isBlankWeekCell_(row[key])) {
        dirty.push(key + '=' + JSON.stringify(row[key]));
      }
    });
  });
  assert.strictEqual(dirty.length, 0, '不應該有值：' + dirty.join('、'));
});

test('一格 2027 年的資料都沒有漏過來（連特別主日標題與人名都掃一次）', function () {
  // ⚠️ 這一條就是當初那個懷疑的正面查證。整行字串化之後直接找那兩個
  //    只可能來自 2027T4 的字串——比逐欄比對更難漏。
  const env = makeEnv({});
  env.sandbox.createBlankBulletinWeeks_(TARGET_QUARTER);

  const leaked = [];
  quarterRows(env, TARGET_QUARTER).forEach(function (row) {
    const dump = JSON.stringify(row);
    if (dump.indexOf(ROSTER_PERSON) !== -1) leaked.push('人名 ' + ROSTER_PERSON);
    if (dump.indexOf(ROSTER_SPECIAL_TITLE) !== -1) leaked.push('特別主日 ' + ROSTER_SPECIAL_TITLE);
    if (dump.indexOf(ROSTER_QUARTER) !== -1) leaked.push('季度 ' + ROSTER_QUARTER);
  });
  assert.strictEqual(leaked.length, 0, '漏了別季的資料過來：' + leaked.join('、'));
});

test('ROSTER_STATUS 在**建立那一刻**就是 NOT_FOUND，不用等補抓', function () {
  const env = makeEnv({});
  const result = env.sandbox.createBlankBulletinWeeks_(TARGET_QUARTER);

  const rows = quarterRows(env, TARGET_QUARTER);
  const notFound = rows.filter(function (r) {
    return String(r.ROSTER_STATUS || '') === env.sandbox.ROSTER_STATUS.NOT_FOUND;
  });
  assert.strictEqual(notFound.length, rows.length,
    rows.length + ' 行之中只有 ' + notFound.length + ' 行是 NOT_FOUND');
  assert.strictEqual(result.rosterFound, false);
});

test('QUARTER_ID 一律是呼叫方指定那一季，不是職事表講的那一季', function () {
  const env = makeEnv({});
  env.sandbox.createBlankBulletinWeeks_(TARGET_QUARTER);

  const all = env.sandbox.readSheet(env.sandbox.SHEETS.BULLETIN_WEEKS);
  all.forEach(function (row) {
    assert.strictEqual(String(row.QUARTER_ID), TARGET_QUARTER,
      '有一行的季度是 ' + row.QUARTER_ID);
  });
});

test('職事表把一個 2030 年的主日登記在 2027T4 之下 → QUARTER_ID 仍然是呼叫方那一季', function () {
  // ⚠️ 這一條驗的是那個**真的到得到**的跨季路徑，也是原本那個懷疑唯一
  //    成立得到的形態：
  //      listRosterServiceDatesForQuarter_('2030T2') → 空（職事表沒有這一季）
  //      → 走曆法推算，逐個日期叫 readRosterSnapshot_()
  //      → 2030-04-07 竟然**找得到**（被登記在 2027T4 之下）
  //      → 舊版寫 `QUARTER_ID: snapshot.quarterId || quarterId`，
  //        於是把一行 2030 年的週報寫進 2027T4，畫面上完全看不出來。
  //
  //    職事表資料不一致不是我們控制得到的事，但「用職事表講的季度覆蓋
  //    呼叫方指定的季度」是我們控制得到的。
  const env = makeEnv({ rosterExtraServiceDate: { iso: '2030-04-07', quarterId: ROSTER_QUARTER } });
  env.sandbox.createBlankBulletinWeeks_(TARGET_QUARTER);

  const all = env.sandbox.readSheet(env.sandbox.SHEETS.BULLETIN_WEEKS);
  const strays = all.filter(function (r) { return String(r.QUARTER_ID) !== TARGET_QUARTER; });
  assert.strictEqual(strays.length, 0,
    '有 ' + strays.length + ' 行被寫進了別一季：'
      + strays.map(function (r) { return r.QUARTER_ID; }).join('、'));
});

test('I11 紅：職事表講的季度與這一行的季度對不上 → 報不成立', function () {
  // 承上：就算 QUARTER_ID 寫對了，職事表本身把這一天登記在別一季仍然是
  // 一件要講出來的事——它代表兩邊對「這一天屬於哪一季」的看法不一致。
  const env = makeEnv({ rosterExtraServiceDate: { iso: '2030-04-07', quarterId: ROSTER_QUARTER } });
  env.sandbox.createBlankBulletinWeeks_(TARGET_QUARTER);

  const r = env.sandbox.runInvariantI11_({ quarterId: TARGET_QUARTER });
  assert.strictEqual(r.ok, false, '應該報不成立');
  assert.ok(r.evidence.indexOf('2030-04-07') !== -1, r.evidence);
  assert.ok(r.evidence.indexOf(ROSTER_QUARTER) !== -1, r.evidence);
});

test('職事表有該季時照樣讀得到（證明上面幾條不是因為根本沒讀職事表）', function () {
  // ⚠️ 沒有這一條的話，一支「永遠什麼都不讀」的壞實作會令上面全部轉綠。
  const env = makeEnv({});
  const result = env.sandbox.createBlankBulletinWeeks_(ROSTER_QUARTER);

  assert.strictEqual(result.rosterFound, true, '職事表有 ' + ROSTER_QUARTER + ' 才對');
  const rows = quarterRows(env, ROSTER_QUARTER);
  assert.strictEqual(rows.length, 1, '職事表只登了一個主日，所以只建立一行');
  assert.strictEqual(String(rows[0].SPECIAL_TYPE), ROSTER_SPECIAL_TITLE,
    '特別主日標題應該由職事表讀到');
  assert.strictEqual(String(rows[0].ROSTER_STATUS), env.sandbox.ROSTER_STATUS.OK);
});

// =====================================================================
// 第 2 組：對話框的數字
// =====================================================================

console.log('\n第 2 組：對話框的「已建立 N 個主日」');

test('第一次建立：N 等於實際新增的行數', function () {
  const env = makeEnv({});
  const result = env.sandbox.createBlankBulletinWeeks_(TARGET_QUARTER);
  const actual = quarterRows(env, TARGET_QUARTER).length;

  assert.strictEqual(result.added, actual, 'added 與實際行數對不上');
  assert.ok(result.message.indexOf('已建立 ' + actual + ' 個主日') !== -1,
    '訊息應該講出 ' + actual + '，實際：' + result.message);
});

test('全部主日本來就存在：不可以印「已建立 0 個主日」', function () {
  // ⚠️ 這正是當初被誤讀成 bug 的那一句。工作表上明明有 13 行，訊息卻寫
  //    「已建立 0 個主日」——「0」與「本來就有」是兩件事。
  const env = makeEnv({});
  env.sandbox.createBlankBulletinWeeks_(TARGET_QUARTER);
  const first = quarterRows(env, TARGET_QUARTER).length;

  const again = env.sandbox.createBlankBulletinWeeks_(TARGET_QUARTER);
  assert.strictEqual(again.added, 0, '第二次不應該再新增');
  assert.strictEqual(again.skipped, first, '應該全部略過');
  assert.strictEqual(again.message.indexOf('已建立 0 個主日'), -1,
    '不可以印「已建立 0 個主日」，實際：' + again.message);
  assert.ok(again.message.indexOf('本來就已經建立好') !== -1,
    '要講明是「本來就有」，實際：' + again.message);
  assert.ok(again.message.indexOf(String(first)) !== -1,
    '要講出實際行數 ' + first + '，實際：' + again.message);
});

test('狀態分佈數的是整季在表上的行，不是這一次新增的那幾行', function () {
  const env = makeEnv({});
  env.sandbox.createBlankBulletinWeeks_(TARGET_QUARTER);
  const total = quarterRows(env, TARGET_QUARTER).length;

  const again = env.sandbox.createBlankBulletinWeeks_(TARGET_QUARTER);
  const counts = again.rosterStatusCounts;
  assert.strictEqual(counts.NOT_FOUND, total,
    '第二次（新增 0 行）時狀態分佈仍然要數到整季 ' + total + ' 行，實際 '
      + JSON.stringify(counts));
});

// =====================================================================
// 第 3 組：空白的 ROSTER_STATUS 不可以當成 OK
// =====================================================================

console.log('\n第 3 組：空白的職事表狀態');

test('countRosterStatuses_：空白算「未算過」，不算 OK', function () {
  const env = makeEnv({});
  const counts = env.sandbox.countRosterStatuses_([
    { ROSTER_STATUS: '' }, {}, { ROSTER_STATUS: '   ' },
    { ROSTER_STATUS: 'OK' }
  ]);
  assert.strictEqual(counts.UNKNOWN, 3, '三行空白都應該算「未算過」');
  assert.strictEqual(counts.OK, 1, '只有明明白白寫著 OK 那一行才算 OK');
});

test('describeRosterStatusCounts_：有「未算過」就一定要印出來', function () {
  const env = makeEnv({});
  const withUnknown = env.sandbox.describeRosterStatusCounts_({ OK: 1, UNKNOWN: 2 });
  assert.ok(withUnknown.indexOf('未算過 2') !== -1, withUnknown);

  const withoutUnknown = env.sandbox.describeRosterStatusCounts_({ OK: 1, UNKNOWN: 0 });
  assert.strictEqual(withoutUnknown.indexOf('未算過'), -1,
    '沒有「未算過」時不應該多印一段：' + withoutUnknown);
});

test('狀態空白的季度會被列入「有缺口」，不會被當成一切正常', function () {
  const env = makeEnv({
    weekRows: [
      { SERVICE_DATE: '2030-04-07', QUARTER_ID: TARGET_QUARTER, WEEK_OF_MONTH: 1, STATUS: 'DRAFT' },
      { SERVICE_DATE: '2030-04-14', QUARTER_ID: TARGET_QUARTER, WEEK_OF_MONTH: 2, STATUS: 'DRAFT' }
    ]
  });
  const gaps = env.sandbox.listQuartersWithRosterGaps_();
  assert.strictEqual(gaps.length, 1, '狀態空白的季度應該被列出來');
  assert.strictEqual(gaps[0].quarterId, TARGET_QUARTER);
  assert.strictEqual(gaps[0].unknown, 2);
});

test('狀態空白時，填寫介面頂部的橫幅照樣要出', function () {
  const env = makeEnv({
    weekRows: [
      { SERVICE_DATE: '2030-04-07', QUARTER_ID: TARGET_QUARTER, WEEK_OF_MONTH: 1, STATUS: 'DRAFT' }
    ]
  });
  const banner = env.sandbox.rosterGapBannerForQuarter_(TARGET_QUARTER);
  assert.strictEqual(banner.show, true, '空白狀態一樣要出橫幅');
  assert.strictEqual(banner.unknown, 1);
  assert.ok(banner.text.indexOf('未查證過') !== -1, banner.text);
});

test('全部 OK 時橫幅不出（證明上一條不是因為橫幅永遠都出）', function () {
  const env = makeEnv({
    weekRows: [
      {
        SERVICE_DATE: '2030-04-07', QUARTER_ID: TARGET_QUARTER, WEEK_OF_MONTH: 1,
        STATUS: 'DRAFT', ROSTER_STATUS: 'OK'
      }
    ]
  });
  assert.strictEqual(env.sandbox.rosterGapBannerForQuarter_(TARGET_QUARTER).show, false);
});

// =====================================================================
// 第 4 組：不變量 I11
// =====================================================================

console.log('\n第 4 組：不變量 I11（來源季度）');

test('I11 綠：職事表沒有該季，而且一格別季的資料都沒有', function () {
  const env = makeEnv({});
  env.sandbox.createBlankBulletinWeeks_(TARGET_QUARTER);

  const r = env.sandbox.runInvariantI11_({ quarterId: TARGET_QUARTER });
  assert.strictEqual(r.ok, true, r.expected + ' / ' + r.actual + ' / ' + r.evidence);
});

test('I11 紅：人為把別季的特別主日標題填進去 → 報不成立', function () {
  const env = makeEnv({});
  env.sandbox.createBlankBulletinWeeks_(TARGET_QUARTER);

  // 職事表根本沒有 2030-04-07，這一格的值只可能來自別處。
  env.sandbox.updateSheetCellByKey_ = undefined;   // 確保不是靠某支順手的工具
  const sheet = env.sheets.BulletinWeeks;
  const keys = env.sandbox.COLUMNS.BULLETIN_WEEKS.keys;
  const col = keys.indexOf('SPECIAL_TYPE') + 1;
  sheet.getRange(3, col, 1, 1).setValue(ROSTER_SPECIAL_TITLE);

  const r = env.sandbox.runInvariantI11_({ quarterId: TARGET_QUARTER });
  assert.strictEqual(r.ok, false, '應該報不成立');
  assert.ok(r.evidence.indexOf(ROSTER_SPECIAL_TITLE) !== -1,
    '證據要講出那個具體的值：' + r.evidence);
});

test('I11 紅：職事表沒有這一天，狀態卻寫著 OK → 報不成立', function () {
  const env = makeEnv({});
  env.sandbox.createBlankBulletinWeeks_(TARGET_QUARTER);

  const sheet = env.sheets.BulletinWeeks;
  const keys = env.sandbox.COLUMNS.BULLETIN_WEEKS.keys;
  const col = keys.indexOf('ROSTER_STATUS') + 1;
  sheet.getRange(3, col, 1, 1).setValue('OK');

  const r = env.sandbox.runInvariantI11_({ quarterId: TARGET_QUARTER });
  assert.strictEqual(r.ok, false, '應該報不成立');
  assert.ok(r.evidence.indexOf('OK') !== -1, r.evidence);
});

test('I11 紅：QUARTER_ID 與日期本身算出來的季度對不上 → 報不成立', function () {
  const env = makeEnv({
    weekRows: [
      // 日期在 2030 年 4 月（＝2030T2），季度卻寫 2030T4。
      {
        SERVICE_DATE: '2030-04-07', QUARTER_ID: '2030T4', WEEK_OF_MONTH: 1,
        STATUS: 'DRAFT', ROSTER_STATUS: 'NOT_FOUND'
      }
    ]
  });
  const r = env.sandbox.runInvariantI11_({ quarterId: '2030T4' });
  assert.strictEqual(r.ok, false, '應該報不成立');
  assert.ok(r.evidence.indexOf('2030T2') !== -1, '要講出正確答案：' + r.evidence);
});

test('I11 驗證不到時回 null，不是回 true', function () {
  // ⚠️ 「驗證不到」與「驗過而且沒事」是兩件事，見 docs/已知bug類型.md。
  const env = makeEnv({ config: { ROSTER_SPREADSHEET_ID: '' } });
  const r = env.sandbox.runInvariantI11_({ quarterId: TARGET_QUARTER });
  assert.strictEqual(r.ok, null);
});

test('calendarQuarterIdForIsoDate_：四個季度各一條，格式不對回 null', function () {
  const env = makeEnv({});
  const f = env.sandbox.calendarQuarterIdForIsoDate_;
  assert.strictEqual(f('2030-01-06'), '2030T1');
  assert.strictEqual(f('2030-04-07'), '2030T2');
  assert.strictEqual(f('2030-07-07'), '2030T3');
  assert.strictEqual(f('2030-10-06'), '2030T4');
  assert.strictEqual(f('2030-03-31'), '2030T1', '3 月 31 日仍然是 T1');
  assert.strictEqual(f('亂寫'), null);
  assert.strictEqual(f(''), null);
});

// =====================================================================
// 第 5 組：主日清單的退回，只可以換來源，不可以換季度
// =====================================================================

console.log('\n第 5 組：主日清單的退回');

test('職事表有該季 → 用職事表', function () {
  const env = makeEnv({});
  const r = env.sandbox.resolveQuarterServiceDateEntries_(ROSTER_QUARTER);
  assert.strictEqual(r.source, 'ROSTER');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(r.dates)), [ROSTER_DATE]);
});

test('職事表沒有該季、但 BulletinWeeks 有 → 用 BulletinWeeks 同一季那幾行', function () {
  // ⚠️ 這正是 R-036 之後「建立得到週報卻匯入不到」那個洞：舊版這一步只讀
  //    職事表，於是那些季度的匯入永遠是「新增 0、修改 0、刪除 0、不變 0」。
  const env = makeEnv({
    weekRows: [
      { SERVICE_DATE: '2030-04-07', QUARTER_ID: TARGET_QUARTER, WEEK_OF_MONTH: 1, STATUS: 'DRAFT' },
      { SERVICE_DATE: '2030-04-14', QUARTER_ID: TARGET_QUARTER, WEEK_OF_MONTH: 2, STATUS: 'DRAFT' },
      // ⚠️ 別一季的行，一定不可以被算進去。
      { SERVICE_DATE: '2027-10-03', QUARTER_ID: ROSTER_QUARTER, WEEK_OF_MONTH: 1, STATUS: 'DRAFT' }
    ]
  });
  const r = env.sandbox.resolveQuarterServiceDateEntries_(TARGET_QUARTER);
  assert.strictEqual(r.source, 'BULLETIN_WEEKS');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(r.dates)), ['2030-04-07', '2030-04-14'],
    '只可以有同一季那兩個主日');
  assert.ok(r.message.indexOf(TARGET_QUARTER) !== -1, r.message);
});

test('兩者都沒有 → 曆法推算，而且全部在該季之內', function () {
  const env = makeEnv({});
  const r = env.sandbox.resolveQuarterServiceDateEntries_(TARGET_QUARTER);
  assert.strictEqual(r.source, 'CALENDAR');
  assert.ok(r.dates.length >= 12, r.dates.length + ' 個');
  Array.prototype.slice.call(r.dates).forEach(function (iso) {
    assert.strictEqual(env.sandbox.calendarQuarterIdForIsoDate_(iso), TARGET_QUARTER, iso);
  });
});

test('四個來源全部只看同一個季度，一個都不會跨季', function () {
  // 三種情況分別跑一次，逐個日期用曆法回推季度——退回的是「用哪一份清單」，
  // 不是「用哪一季」。
  const env = makeEnv({
    weekRows: [
      { SERVICE_DATE: '2030-04-07', QUARTER_ID: TARGET_QUARTER, WEEK_OF_MONTH: 1, STATUS: 'DRAFT' }
    ]
  });
  [ROSTER_QUARTER, TARGET_QUARTER, '2031T3'].forEach(function (qid) {
    const r = env.sandbox.resolveQuarterServiceDateEntries_(qid);
    Array.prototype.slice.call(r.dates).forEach(function (iso) {
      assert.strictEqual(env.sandbox.calendarQuarterIdForIsoDate_(iso), qid,
        '季度 ' + qid + '（來源 ' + r.source + '）竟然有 ' + iso);
    });
  });
});

// =====================================================================

console.log('\n通過 ' + pass + ' 項，失敗 ' + fail + ' 項。');
process.exit(fail === 0 ? 0 : 1);
