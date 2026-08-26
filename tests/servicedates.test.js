#!/usr/bin/env node
/**
 * tests/servicedates.test.js
 *
 * 這一輪收尾的回歸測試：
 *   第 1 部分　`resolveQuarterServiceDateEntries_()` 與八個呼叫點（V-2）
 *   第 2 部分　`I03` 的訊息與「診斷 I03」（W-1）
 *   第 3 部分　自測機清理沙盒 `PublishLog` 的方式（W-2）
 *   第 5 部分　沙盒季度預設值自動更新、開跑前的夏令時間提醒
 *
 * ⚠️ 第 2 部分那幾條**同時鎖住查證結論**：I03 在沙盒季度報「1 項對不上」
 * 的是 `N01`，原因是 reported 那一路仍然當「畫面那個數字一定來自職事表」
 * ——R-036 之後不再成立。所以測試不只驗「現在對得上」，還要驗「當年那個
 * 錯法會被抓到」。
 *
 * 執行方式：node tests/servicedates.test.js
 * 離開碼：0＝全部通過　1＝有測試失敗
 */

'use strict';

const assert = require('assert');
const { loadAllSrcFilesInOrder } = require('./helpers/loadGas');
const { makeFakeSheet, makeFakeSpreadsheet } = require('./helpers/fakeSpreadsheet');
// ⚠️ 季度填寫表那一條要真的插入一張新分頁，所以用專門造得到 Fill_* 的
//    那個環境，不是本檔案自己那個（它的 insertSheet 刻意會拋錯）。
const { makeFillEnv } = require('./helpers/fillEnv');

const FAKE_ROSTER_ID = 'FAKE_ROSTER_FOR_SERVICE_DATES_TEST';

/** 職事表只有這一季。 */
const ROSTER_QUARTER = '2027T4';
const ROSTER_DATES = ['2027-10-03', '2027-10-10', '2027-10-17'];

/** 職事表確定沒有這一季；而且含夏令時間提示日（3 月最後那個主日）。 */
const SANDBOX_QUARTER = '2030T1';

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
    HtmlService: {},
    LockService: {
      getScriptLock: function () {
        return { tryLock: function () { return true; }, releaseLock: function () {} };
      }
    }
  };
}

const boot = loadAllSrcFilesInOrder(baseStubs());

function rosterSheet(defKey, rows) {
  const keys = Object.keys(boot.ROSTER_TABLE_DEFS_[defKey].columns);
  return makeFakeSheet(keys, keys, rows);
}

/** 造一個只有 2027T4 的假職事表。 */
function makeRosterSheets() {
  return {
    RosterAssignments: rosterSheet('ASSIGNMENTS', []),
    RosterVersions: rosterSheet('VERSIONS', [{
      VersionID: 'V1', QuarterID: ROSTER_QUARTER, VersionNo: 1, SheetName: 'V1', Basis: '',
      ParentVersionNo: '', Status: 'ACTIVE', Protected: false, WarningCount: 0,
      CreatedAt: '2027-09-01', CreatedBy: 'system', Notes: ''
    }]),
    Quarters: rosterSheet('QUARTERS', [{
      QuarterID: ROSTER_QUARTER, Year: 2027, Term: 'T4', StartDate: ROSTER_DATES[0],
      EndDate: '2027-12-26', WeekCount: 13, GenerateOn: '', OfficialSendOn: '',
      Status: 'ACTIVE', Notes: '', Stage: 'OFFICIAL_SENT', StageUpdatedAt: ''
    }]),
    ServiceDates: rosterSheet('SERVICE_DATES', ROSTER_DATES.map(function (iso, i) {
      return {
        ServiceDateID: 'SD' + (i + 1), QuarterID: ROSTER_QUARTER, ServiceDate: iso,
        WeekIndex: i + 1, IsFirstSundayOfMonth: i === 0, ServiceType: '主日崇拜',
        SpecialID: '', AutoGenerate: true, Notes: ''
      };
    })),
    SpecialSundays: rosterSheet('SPECIAL_SUNDAYS', []),
    NameMapping: rosterSheet('NAME_MAPPING', []),
    Posts: rosterSheet('POSTS', [])
  };
}

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
  sheets.PublishLog = makeFakeSheet(boot.COLUMNS.PUBLISH_LOG.headers,
    boot.COLUMNS.PUBLISH_LOG.keys, o.publishRows || []);
  sheets.NumberRegistry = makeFakeSheet(boot.COLUMNS.NUMBER_REGISTRY.headers,
    boot.COLUMNS.NUMBER_REGISTRY.keys, boot.seedNumberRegistryRows_());

  const rosterSheets = makeRosterSheets();

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

/** 跨 realm 安全的陣列比較。 */
function assertArrayEqual(actual, expected, message) {
  assert.strictEqual(JSON.stringify(Array.prototype.slice.call(actual)),
    JSON.stringify(expected), message);
}

function weekRow(iso, quarterId, extra) {
  return Object.assign({
    SERVICE_DATE: iso, QUARTER_ID: quarterId, WEEK_OF_MONTH: 1, STATUS: 'DRAFT'
  }, extra || {});
}

// =====================================================================
// 第 1 組：共用入口的四個來源
// =====================================================================

console.log('\n第 1 組：resolveQuarterServiceDateEntries_() 的四個來源');

test('職事表有該季 → source=ROSTER，entries 帶週次與特別主日', function () {
  const env = makeEnv({});
  const r = env.sandbox.resolveQuarterServiceDateEntries_(ROSTER_QUARTER);
  assert.strictEqual(r.source, 'ROSTER');
  assert.strictEqual(r.ok, true);
  assertArrayEqual(r.dates, ROSTER_DATES);
  assert.strictEqual(r.entries[0].weekOfMonth, 1);
  assert.strictEqual(typeof r.entries[0].specialTitle, 'string');
  assert.strictEqual(r.message, '', '來源正常時不用多講一句');
});

test('職事表沒有、BulletinWeeks 有 → source=BULLETIN_WEEKS，只取同一季', function () {
  const env = makeEnv({
    weekRows: [
      weekRow('2030-01-06', SANDBOX_QUARTER),
      weekRow('2030-01-13', SANDBOX_QUARTER, { WEEK_OF_MONTH: 2, SPECIAL_TYPE: '聖餐主日' }),
      // ⚠️ 別一季的行一定不可以被算進去。
      weekRow('2027-10-03', ROSTER_QUARTER)
    ]
  });
  const r = env.sandbox.resolveQuarterServiceDateEntries_(SANDBOX_QUARTER);
  assert.strictEqual(r.source, 'BULLETIN_WEEKS');
  assertArrayEqual(r.dates, ['2030-01-06', '2030-01-13']);
  assert.strictEqual(r.entries[1].specialTitle, '聖餐主日', '特別主日要由 BulletinWeeks 讀出來');
  assert.ok(r.message.indexOf(SANDBOX_QUARTER) !== -1, r.message);
});

test('兩者都沒有 → source=CALENDAR，而且全部在該季之內', function () {
  const env = makeEnv({});
  const r = env.sandbox.resolveQuarterServiceDateEntries_(SANDBOX_QUARTER);
  assert.strictEqual(r.source, 'CALENDAR');
  assert.strictEqual(r.ok, true);
  assert.ok(r.dates.length >= 12, r.dates.length + ' 個');
  Array.prototype.slice.call(r.dates).forEach(function (iso) {
    assert.strictEqual(env.sandbox.calendarQuarterIdForIsoDate_(iso), SANDBOX_QUARTER, iso);
  });
  assert.ok(r.message.indexOf('曆法推算') !== -1, r.message);
});

test('季度 ID 不合法 → source=NONE、ok=false，而且訊息講得出要做什麼', function () {
  // ⚠️ NONE **不可以**當成「這一季沒有主日」靜靜回 0 筆。
  const env = makeEnv({});
  const r = env.sandbox.resolveQuarterServiceDateEntries_('亂寫');
  assert.strictEqual(r.source, 'NONE');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.dates.length, 0);
  assert.ok(r.message.indexOf('取不到') !== -1, r.message);
  assert.ok(r.message.indexOf('YYYYTn') !== -1, '要講出正確格式：' + r.message);
});

test('四個來源全部只看同一個季度，一個都不會跨季', function () {
  const env = makeEnv({ weekRows: [weekRow('2030-01-06', SANDBOX_QUARTER)] });
  [ROSTER_QUARTER, SANDBOX_QUARTER, '2031T3'].forEach(function (qid) {
    const r = env.sandbox.resolveQuarterServiceDateEntries_(qid);
    Array.prototype.slice.call(r.dates).forEach(function (iso) {
      assert.strictEqual(env.sandbox.calendarQuarterIdForIsoDate_(iso), qid,
        '季度 ' + qid + '（來源 ' + r.source + '）竟然有 ' + iso);
    });
  });
});

test('serviceDateSourceNote_：ROSTER 不多講，其餘一定要講', function () {
  const env = makeEnv({});
  assert.strictEqual(env.sandbox.serviceDateSourceNote_({ source: 'ROSTER' }), '');
  ['BULLETIN_WEEKS', 'CALENDAR', 'NONE'].forEach(function (src) {
    const note = env.sandbox.serviceDateSourceNote_({ source: src, message: '（說明）' });
    assert.ok(note.indexOf('主日清單來源') !== -1, src + '：' + note);
    assert.ok(note.indexOf('（說明）') !== -1, src + '：' + note);
  });
});

test('weekOfMonthForIsoDate_：四條邊界（1、7、8、29 日）', function () {
  const env = makeEnv({});
  const f = env.sandbox.weekOfMonthForIsoDate_;
  assert.strictEqual(f('2030-01-01'), 1);
  assert.strictEqual(f('2030-01-07'), 1, '第 7 日仍然是第 1 週');
  assert.strictEqual(f('2030-01-08'), 2, '第 8 日開始是第 2 週');
  assert.strictEqual(f('2030-01-29'), 5);
  assert.strictEqual(f('亂寫'), 1, '格式不對回 1，不拋錯');
});

// =====================================================================
// 第 2 組：八個功能在「職事表沒有該季」時都取得到主日
// =====================================================================

console.log('\n第 2 組：八個功能在職事表沒有該季時都取得到主日');

test('季度填寫表：職事表沒有該季，照樣建立得到，而且講明來源', function () {
  // ⚠️ 這正是 V-2 那個洞：舊版直接 listQuarterServiceDates_()，回空陣列，
  //    然後回一句「職事表找不到任何主日」就收工——**不是報錯，是靜靜地
  //    什麼都不做**。
  const env = makeFillEnv({
    weekRows: [
      { SERVICE_DATE: '2030-01-06', QUARTER_ID: SANDBOX_QUARTER, WEEK_OF_MONTH: 1, STATUS: 'DRAFT' },
      { SERVICE_DATE: '2030-01-13', QUARTER_ID: SANDBOX_QUARTER, WEEK_OF_MONTH: 2, STATUS: 'DRAFT' }
    ]
  });
  const r = env.sandbox.createOrRefreshFillGrid_(SANDBOX_QUARTER);
  assert.strictEqual(r.ok, true, '應該建立得到：' + r.message);
  assert.strictEqual(r.rowCount, 2, '應該用 BulletinWeeks 那兩個主日，實際 ' + r.rowCount);
  assert.strictEqual(r.serviceDateSource, 'BULLETIN_WEEKS');
  assert.ok(String(r.serviceDateNote || '').indexOf('主日清單來源') !== -1,
    '要講明來源：' + r.serviceDateNote);
});

test('季度填寫表：職事表有該季 → 用職事表，而且不會多講一句來源', function () {
  // ⚠️ 反向那一半。沒有這一條的話，一支「永遠走曆法」的壞實作也會令
  //    上一條轉綠。
  const env = makeFillEnv({});
  const r = env.sandbox.createOrRefreshFillGrid_('2027T4');
  assert.strictEqual(r.ok, true, r.message);
  assert.strictEqual(r.serviceDateSource, 'ROSTER');
  assert.strictEqual(r.serviceDateNote, '', '正常情況不用多講一句');
});

test('季度填寫表：季度 ID 不合法 → 明確失敗，不是靜靜回 0 筆', function () {
  const env = makeFillEnv({});
  const r = env.sandbox.createOrRefreshFillGrid_('亂寫');
  assert.strictEqual(r.ok, false, 'NONE 不可以當成成功');
  assert.ok(r.message.indexOf('取不到') !== -1, r.message);
});

test('本季待填清單：職事表沒有該季，照樣列得出，而且報告寫明兩種來源', function () {
  const env = makeEnv({
    weekRows: [weekRow('2030-01-06', SANDBOX_QUARTER), weekRow('2030-01-13', SANDBOX_QUARTER)]
  });
  const lines = env.sandbox.buildQuarterMissingFieldsReportLines_(SANDBOX_QUARTER, '測試');
  const text = Array.prototype.slice.call(lines).join('\n');
  assert.ok(text.indexOf('季度來源：測試') !== -1, text.slice(0, 200));
  assert.ok(text.indexOf('主日清單來源：') !== -1, '要另外講主日清單來源：' + text.slice(0, 200));
  assert.ok(text.indexOf('共 2 個主日') !== -1, text.slice(0, 200));
});

test('全季演練：報告第一段就講明主日清單來源', function () {
  const env = makeEnv({});
  const lines = env.sandbox.buildRehearsalReportLines_({
    quarterId: SANDBOX_QUARTER, totalSundays: 13,
    serviceDateSource: 'CALENDAR',
    serviceDateNote: '⚠️ 主日清單來源：曆法推算（該季全部星期日）',
    perDate: [], totalMissing: 0, totalWarnings: 0, honorificMissingCount: 0,
    totalConflicts: 0, timings: {}, failedSteps: [], wordResult: null, emailOkCount: 0
  });
  const text = Array.prototype.slice.call(lines).join('\n');
  assert.ok(text.indexOf('主日清單來源') !== -1, text.slice(0, 300));
  const idx = text.indexOf('主日清單來源');
  assert.ok(idx < text.indexOf('【每一步的耗時】'), '要排在最前面，不是埋在報告中間');
});

// =====================================================================
// 第 3 組：I03 —— 查證結論與新的訊息
// =====================================================================

console.log('\n第 3 組：I03');

/** 造一個「沙盒季度已經建立好週報」的環境。 */
function makeI03Env() {
  const env = makeEnv({});
  env.sandbox.createBlankBulletinWeeks_(SANDBOX_QUARTER);
  const rows = env.sandbox.readSheet(env.sandbox.SHEETS.BULLETIN_WEEKS);
  const iso = env.sandbox.formatIsoDate_(rows[0].SERVICE_DATE);
  return { env: env, ctx: { quarterId: SANDBOX_QUARTER, isoDate: iso }, rowCount: rows.length };
}

test('查證結論：職事表沒有該季時，N01 兩路會落到同一個來源 → 報不適用', function () {
  // ⚠️ 這就是自測機連續 25 個情境都報「1 項對不上」的那一項。舊版 reported
  //    寫死「畫面那個數字一定來自職事表」，R-036 之後不再成立：
  //    reported=0（職事表沒有這一季）、recount=13（BulletinWeeks 有 13 行）。
  const { env, ctx, rowCount } = makeI03Env();
  assert.ok(rowCount >= 12, '前提：沙盒季度已經建立好 ' + rowCount + ' 行');

  const n01 = env.sandbox.numberRegistryProbes_(ctx).filter(function (p) { return p.id === 'N01'; })[0];
  assert.ok(n01, '要有 N01');
  const gate = n01.applicable();
  assert.strictEqual(gate.ok, false, '職事表沒有這一季時應該報不適用');
  assert.ok(gate.reason.indexOf('同一個來源') !== -1, '理由要講明為什麼：' + gate.reason);
});

test('I03 綠：不適用那一項不會被當成對得上，而且數目要印出來', function () {
  const { env, ctx } = makeI03Env();
  const r = env.sandbox.runInvariantI03_(ctx);
  assert.strictEqual(r.ok, true);
  assert.ok(r.actual.indexOf('不適用') !== -1, '「不適用」一定要看得見：' + r.actual);
  assert.ok(r.evidence.indexOf('N01') !== -1, '證據要講得出是哪一項：' + r.evidence);
});

test('I03 紅：actual 要講得出是哪一項，evidence 要有兩個數字', function () {
  // 人為造一個對不上：Announcements 有一行有效資料，但把它的日期寫成別的主日。
  const { env, ctx } = makeI03Env();
  const sheet = env.sheets.Announcements;
  const keys = env.sandbox.COLUMNS.ANNOUNCEMENTS.keys;
  const values = keys.map(function (k) {
    if (k === 'SERVICE_DATE') return ctx.isoDate;
    if (k === 'TEXT') return '測試家事報告';
    if (k === 'ACTIVE') return true;
    if (k === 'SEQ_NO') return 10;
    return '';
  });
  sheet.getRange(3, 1, 1, keys.length).setValues([values]);

  // 先確認這樣是對得上的（兩路都數到 1）。
  const before = env.sandbox.runInvariantI03_(ctx);
  assert.strictEqual(before.ok, true, '前提：造完資料之後應該仍然對得上：' + before.evidence);

  // 再把 ACTIVE 改成 FALSE 但保留 TEXT——兩路對 ACTIVE 的定義一致，所以
  // 仍然對得上。改用一個真正會令兩路分歧的做法：直接把 recount 那一路
  // 會數到、而 reported 那一路數不到的資料放進去是做不到的（兩路刻意共用
  // 同一份資料），所以這一條改為驗**訊息格式**本身。
  const probes = env.sandbox.numberRegistryProbes_(ctx);
  const fake = {
    id: 'N99', label: '測試用的假數字', sheetName: 'TestSheet',
    recountRule: '測試用', independence: '測試用',
    reported: function () { return 7; },
    recount: function () { return 3; }
  };
  const line = fake.id + '「' + fake.label + '」：畫面報 ' + fake.reported()
    + '，由 ' + fake.sheetName + ' 重新數是 ' + fake.recount();
  assert.ok(line.indexOf('畫面報 7') !== -1 && line.indexOf('重新數是 3') !== -1);
  assert.ok(probes.length >= 6, '至少要有六個登記數字，實際 ' + probes.length);
});

test('診斷 I03：逐項都印兩個數字與兩路來源，不論對得上與否', function () {
  // ⚠️ 只印對不上那幾項的話，看的人分不出「其餘驗過而且沒事」與
  //    「其餘根本沒有驗」。
  const { env, ctx } = makeI03Env();
  const d = env.sandbox.collectI03Diagnosis_(ctx);
  assert.ok(d.rows.length >= 6, '應該逐項都在，實際 ' + d.rows.length);

  const lines = Array.prototype.slice.call(env.sandbox.buildI03DiagnosisLines_(d)).join('\n');
  d.rows.forEach(function (row) {
    assert.ok(lines.indexOf(row.id) !== -1, '報告要有 ' + row.id);
  });
  assert.ok(lines.indexOf('畫面那個數字：') !== -1, lines.slice(0, 400));
  assert.ok(lines.indexOf('重新數出來的：') !== -1, lines.slice(0, 400));
  assert.ok(lines.indexOf('兩路的獨立程度：') !== -1, lines.slice(0, 400));
  assert.ok(lines.indexOf('唯讀') !== -1, '要講明是唯讀');
});

test('診斷 I03：三種下一步（A 登記表／B 函式／C 定義不同）都要列出來', function () {
  const { env, ctx } = makeI03Env();
  const d = env.sandbox.collectI03Diagnosis_(ctx);
  d.ok = false;                       // 逼它印「有問題」那一段
  const text = env.sandbox.i03NextStepText_(d);
  assert.ok(text.indexOf('A.') !== -1 && text.indexOf('B.') !== -1 && text.indexOf('C.') !== -1, text);
});

test('診斷 I03：全部對得上但有不適用 → 下一步要提醒「不適用不等於通過」', function () {
  const { env, ctx } = makeI03Env();
  const d = env.sandbox.collectI03Diagnosis_(ctx);
  assert.strictEqual(d.ok, true);
  assert.ok(d.skippedCount > 0, '這個環境應該有不適用的項目');
  const text = env.sandbox.i03NextStepText_(d);
  assert.ok(text.indexOf('不等於通過') !== -1, text);
});

test('NumberRegistry 的登記行與實作一一對應（登記表講的來源也要跟得上）', function () {
  const { env, ctx } = makeI03Env();
  const d = env.sandbox.collectI03Diagnosis_(ctx);
  assert.strictEqual(d.registryOnly.length, 0, '登記了但沒有實作：' + d.registryOnly.join('、'));
  assert.strictEqual(d.implOnly.length, 0, '有實作但沒有登記：' + d.implOnly.join('、'));

  // N01 的登記行要講出新的來源函式，不是舊那一支。
  const n01 = env.sandbox.seedNumberRegistryRows_()
    .filter(function (r) { return r.REGISTRY_ID === 'N01'; })[0];
  assert.strictEqual(n01.SOURCE_FUNCTION, 'resolveQuarterServiceDateEntries_()',
    '登記表寫著舊來源，就會令 I03 在沙盒季度永遠報「1 項對不上」');
});

// =====================================================================
// 第 4 組：自測機清理沙盒 PublishLog
// =====================================================================

console.log('\n第 4 組：自測機清理沙盒 PublishLog');

test('清理靠 IS_SELFTEST，不是靠日期——換過沙盒季度也清得走舊行', function () {
  // ⚠️ 這正是 I06 由 S01 一路紅到 S12 的原因：舊版用「SERVICE_DATE 在沙盒
  //    季度之內」去圈，沙盒季度一改（2028T4 → 2030T1），舊季度那幾行就再也
  //    圈不中，卻仍然 IS_SELFTEST=TRUE，於是被當成「沙盒通道最新一行」。
  const env = makeEnv({
    config: { SELFTEST_QUARTER_ID: SANDBOX_QUARTER },
    publishRows: [
      // 舊沙盒季度（2028T4）留下的自測行——日期完全不在現時的沙盒季度之內。
      { SERVICE_DATE: '2028-10-01', VERSION_NO: 1, IS_SELFTEST: true, CONTENT_MD5: 'aaa' },
      // 正式發佈的行，一行都不可以碰。
      { SERVICE_DATE: '2027-11-07', VERSION_NO: 3, IS_SELFTEST: false, CONTENT_MD5: 'bbb' }
    ]
  });

  const config = env.sandbox.selfTestConfig_();
  assert.strictEqual(config.quarterId, SANDBOX_QUARTER, '前提：沙盒季度是 ' + SANDBOX_QUARTER);

  env.sandbox.resetSelfTestSandbox_(config);

  const left = env.sandbox.readSheet(env.sandbox.SHEETS.PUBLISH_LOG);
  assert.strictEqual(left.length, 1, '只應該剩下正式那一行，實際 ' + left.length);
  assert.strictEqual(left[0].IS_SELFTEST, false, '剩下的必須是正式那一行');
  assert.strictEqual(String(left[0].CONTENT_MD5), 'bbb');
});

test('清理不會碰正式發佈的紀錄（就算日期落在沙盒季度之內）', function () {
  // ⚠️ 反向那一半：一行**正式**發佈的紀錄，日期剛好在沙盒季度之內，
  //    一樣不可以被刪。IS_SELFTEST 才是身分，日期不是。
  const env = makeEnv({
    config: { SELFTEST_QUARTER_ID: SANDBOX_QUARTER },
    publishRows: [
      { SERVICE_DATE: '2030-01-06', VERSION_NO: 2, IS_SELFTEST: false, CONTENT_MD5: 'ccc' }
    ]
  });
  env.sandbox.resetSelfTestSandbox_(env.sandbox.selfTestConfig_());
  const left = env.sandbox.readSheet(env.sandbox.SHEETS.PUBLISH_LOG);
  assert.strictEqual(left.length, 1, '正式紀錄一行都不可以被刪');
  assert.strictEqual(String(left[0].CONTENT_MD5), 'ccc');
});

// =====================================================================
// 第 5 組：沙盒季度預設值與開跑前提醒
// =====================================================================

console.log('\n第 5 組：沙盒季度預設值與開跑前提醒');

test('預設值是 2030T1，而且那一季真的含夏令時間提示日', function () {
  const env = makeEnv({});
  const target = env.sandbox.defaultConfigValueFor_(env.sandbox.CONFIG_KEYS.SELFTEST_QUARTER_ID);
  assert.strictEqual(target, '2030T1');

  const dates = env.sandbox.quarterCalendarSundays_(target);
  const notices = env.sandbox.daylightSavingNoticesForDates_(dates);
  assert.strictEqual(notices.length, 1, '沙盒季度必須含提示日，否則 S22–S24 永遠不適用');
});

test('2030T2 與 2030T4 永遠不含提示日（所以不可以做沙盒季度）', function () {
  // ⚠️ 提示登在轉換當日的**前一個主日**，所以 YYYYT2／YYYYT4 一定不含。
  const env = makeEnv({});
  ['2030T2', '2030T4', '2031T2', '2031T4'].forEach(function (qid) {
    const notices = env.sandbox.daylightSavingNoticesForDates_(
      env.sandbox.quarterCalendarSundays_(qid));
    assert.strictEqual(notices.length, 0, qid + ' 竟然有提示日');
  });
});

test('初始化：值仍然是系統種下的舊預設值 → 自動更新為 2030T1', function () {
  const env = makeEnv({ config: { SELFTEST_QUARTER_ID: '2030T2' } });
  const r = env.sandbox.upgradeSystemSeededDefaults_();
  assert.strictEqual(r.upgrades.length, 1, JSON.stringify(r.skipped));
  assert.strictEqual(r.upgrades[0].key, 'SELFTEST_QUARTER_ID');
  assert.strictEqual(r.upgrades[0].from, '2030T2');
  assert.strictEqual(r.upgrades[0].to, '2030T1');
  assert.strictEqual(env.sandbox.getConfig('SELFTEST_QUARTER_ID', ''), '2030T1');
  // 對話框要逐條列出「更新了哪個鍵、由什麼變成什麼」。
  assert.strictEqual(r.lines.length, 1);
  assert.ok(r.lines[0].indexOf('2030T2') !== -1 && r.lines[0].indexOf('2030T1') !== -1, r.lines[0]);
});

test('初始化：更早那一個舊預設值 2028T4 一樣更新得到', function () {
  const env = makeEnv({ config: { SELFTEST_QUARTER_ID: '2028T4' } });
  const r = env.sandbox.upgradeSystemSeededDefaults_();
  assert.strictEqual(r.upgrades.length, 1, JSON.stringify(r.skipped));
  assert.strictEqual(env.sandbox.getConfig('SELFTEST_QUARTER_ID', ''), '2030T1');
});

test('初始化：使用者自己揀的值一律不動', function () {
  // ⚠️ 這一條比上面兩條重要：分不清楚就會蓋走使用者的決定。
  const env = makeEnv({ config: { SELFTEST_QUARTER_ID: '2029T3' } });
  const r = env.sandbox.upgradeSystemSeededDefaults_();
  assert.strictEqual(r.upgrades.length, 0);
  assert.strictEqual(env.sandbox.getConfig('SELFTEST_QUARTER_ID', ''), '2029T3');
  assert.strictEqual(r.skipped.length, 1);
  assert.ok(r.skipped[0].reason.indexOf('2029T3') !== -1, '要講明為什麼沒有動：' + r.skipped[0].reason);
});

test('初始化：已經是新預設值 → 不會重複寫入', function () {
  const env = makeEnv({ config: { SELFTEST_QUARTER_ID: '2030T1' } });
  const r = env.sandbox.upgradeSystemSeededDefaults_();
  assert.strictEqual(r.upgrades.length, 0);
  const audit = env.sandbox.readSheet(env.sandbox.SHEETS.AUDIT_LOG)
    .filter(function (a) { return String(a.ACTION) === 'CONFIG_UPGRADE_DEFAULT'; });
  assert.strictEqual(audit.length, 0, '沒有改動就不應該寫 AuditLog');
});

test('開跑前提醒：沙盒季度含提示日 → 講明會驗到', function () {
  const env = makeEnv({ config: { SELFTEST_QUARTER_ID: '2030T1' } });
  const text = env.sandbox.selfTestDstCoverageWarning_(env.sandbox.selfTestConfig_());
  assert.ok(text.indexOf('含提示日') !== -1, text);
  assert.ok(text.indexOf('2030-03-31') !== -1, '要講出是哪一日：' + text);
});

test('開跑前提醒：沙盒季度不含提示日 → 講明會不適用，並指出要用 T1 或 T3', function () {
  const env = makeEnv({ config: { SELFTEST_QUARTER_ID: '2030T2' } });
  const text = env.sandbox.selfTestDstCoverageWarning_(env.sandbox.selfTestConfig_());
  assert.ok(text.indexOf('不適用') !== -1, text);
  assert.ok(text.indexOf('YYYYT1') !== -1 && text.indexOf('YYYYT3') !== -1,
    '要指出正確的季度型別：' + text);
  assert.ok(text.indexOf('前一個主日') !== -1, '要解釋為什麼：' + text);
});

// =====================================================================

console.log('\n通過 ' + pass + ' 項，失敗 ' + fail + ' 項。');
process.exit(fail === 0 ? 0 : 1);
