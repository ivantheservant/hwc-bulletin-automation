#!/usr/bin/env node
/**
 * tests/r036r030r034.test.js
 *
 * 三條需求的回歸測試：
 *   R-036　職事表沒有資料時仍可建立週報（`ROSTER_STATUS` 三個值）
 *   R-030　夏令時間家事報告自動加入（由日期算，不寫死日期表）
 *   R-034　主日選單改為兩層（季度 → 主日，帶狀態標記）
 *
 * ⚠️ 夏令時間那幾條**刻意逐年由 2027 試到 2032**。寫死一個日期表當然
 * 一定過，但那正是這一條要防的事：真正要驗的是「9 月最後一個主日、
 * 4 月第一個主日」這條規則本身，而規則的錯法（例如把「最後一個主日」
 * 寫成「第四個主日」）只有在某幾年才看得出來——2027 年 9 月有四個主日，
 * 2029 年有五個，只試一年會一齊錯、一齊報沒事（見 docs/已知bug類型.md
 * 事故二十二）。期望值由一支**與被驗邏輯無關**的算法算出來（直接數
 * getDay()），不是叫 sandbox 自己那一支。
 *
 * 執行方式：node tests/r036r030r034.test.js
 * 離開碼：0＝全部通過　1＝有測試失敗
 */

'use strict';

const assert = require('assert');
const vm = require('vm');
const { loadAllSrcFilesInOrder } = require('./helpers/loadGas');

const GAS_STUBS = {
  Utilities: {
    formatDate: function (date, tz, pattern) {
      const y = date.getFullYear();
      const mo = String(date.getMonth() + 1).padStart(2, '0');
      const d = String(date.getDate()).padStart(2, '0');
      if (String(pattern) === 'dd/MM/yyyy') return `${d}/${mo}/${y}`;
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
  HtmlService: {},
  PropertiesService: {}
};

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

/**
 * 跨 realm 安全的陣列比較：sandbox 裏 .map() 出來的陣列，其 prototype 屬於
 * 另一個 realm，assert.deepStrictEqual() 會因為 prototype 不同而失敗（跟內容
 * 對不對無關）。所以一律比字串化之後的結果。
 */
function assertArrayEqual(actual, expected, message) {
  assert.strictEqual(JSON.stringify(Array.prototype.slice.call(actual)), JSON.stringify(expected), message);
}

const sandbox = loadAllSrcFilesInOrder(GAS_STUBS);

// ⚠️ vm context 有自己一套內建物件：在測試這一邊 new Date() 造出來的物件，
// 在 sandbox 裏 instanceof Date 是 false，會被 buildWeekListEntries_() 當成
// 壞資料整行篩走（第一次寫這個測試時就是這樣，十條全紅）。所以造測試資料
// 用的 Date 一定要在 sandbox 那個 realm 裏造。
vm.runInContext('function __mkDate(y, m, d) { return new Date(y, m, d); }', sandbox);

// =====================================================================
// 獨立算法：期望值不可以由被驗的那一支算出來
// =====================================================================

/** 某年某月（1 起算）第 n 個星期日，yyyy-MM-dd。純數 getDay()。 */
function nthSundayIndependent(year, month1, n) {
  let found = 0;
  for (let d = 1; d <= 31; d++) {
    const dt = new Date(year, month1 - 1, d);
    if (dt.getMonth() !== month1 - 1) break;
    if (dt.getDay() === 0) {
      found++;
      if (found === n) return isoOf(dt);
    }
  }
  return null;
}

/** 某年某月（1 起算）最後一個星期日，yyyy-MM-dd。純數 getDay()。 */
function lastSundayIndependent(year, month1) {
  let last = null;
  for (let d = 1; d <= 31; d++) {
    const dt = new Date(year, month1 - 1, d);
    if (dt.getMonth() !== month1 - 1) break;
    if (dt.getDay() === 0) last = isoOf(dt);
  }
  return last;
}

function isoOf(dt) {
  const y = dt.getFullYear();
  const mo = String(dt.getMonth() + 1).padStart(2, '0');
  const d = String(dt.getDate()).padStart(2, '0');
  return `${y}-${mo}-${d}`;
}

/** 某個 yyyy-MM-dd 減 n 日。 */
function minusDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() - n);
  return isoOf(dt);
}

// =====================================================================
// 第 1 組：R-030 夏令時間的日期計算，逐年 2027–2032
// =====================================================================

console.log('\n第 1 組：夏令時間日期計算（2027–2032，逐年）');

const YEARS = [2027, 2028, 2029, 2030, 2031, 2032];

YEARS.forEach(function (year) {
  test(year + ' 年 9 月最後一個主日算得對', function () {
    assert.strictEqual(
      isoOf(sandbox.lastSundayOfMonth_(year, 8)),           // 月份 0 起算：8＝9 月；回的是 Date
      lastSundayIndependent(year, 9),
      year + ' 年 9 月最後一個主日'
    );
  });

  test(year + ' 年 4 月第一個主日算得對', function () {
    assert.strictEqual(
      isoOf(sandbox.nthSundayOfMonth_(year, 3, 1)),         // 3＝4 月；回的是 Date
      nthSundayIndependent(year, 4, 1),
      year + ' 年 4 月第一個主日'
    );
  });

  test(year + ' 年兩次轉換：開始／完結、提示日、星期六都對', function () {
    const changes = sandbox.daylightSavingChangesForYear_(year);
    assert.strictEqual(changes.length, 2, '一年應該有兩次轉換');

    const start = changes.filter(function (c) { return c.kind === 'START'; })[0];
    const end = changes.filter(function (c) { return c.kind === 'END'; })[0];
    assert.ok(start && end, 'START 與 END 各要有一次');

    assert.strictEqual(start.changeIso, lastSundayIndependent(year, 9), '開始日＝9 月最後一個主日');
    assert.strictEqual(end.changeIso, nthSundayIndependent(year, 4, 1), '完結日＝4 月第一個主日');

    // 提示登在改動當日的**前一個主日**，即改動日減 7 天。
    assert.strictEqual(start.noticeIso, minusDays(start.changeIso, 7), '開始的提示日');
    assert.strictEqual(end.noticeIso, minusDays(end.changeIso, 7), '完結的提示日');

    // 撥鐘那晚是改動日的前一晚。
    assert.strictEqual(start.saturdayIso, minusDays(start.changeIso, 1), '開始的星期六');
    assert.strictEqual(end.saturdayIso, minusDays(end.changeIso, 1), '完結的星期六');
  });
});

test('9 月最後一個主日不等於「第四個主日」（規則寫錯的話這一條會紅）', function () {
  // 2029 年 9 月有五個主日：寫成「第四個主日」會得出 9 月 23 日，
  // 正確答案是 9 月 30 日。這一條就是用來釘住這個錯法。
  const fourth = nthSundayIndependent(2029, 9, 4);
  const last = lastSundayIndependent(2029, 9);
  assert.notStrictEqual(fourth, last, '2029 年 9 月的第四個與最後一個主日應該不同（測試前提）');
  assert.strictEqual(isoOf(sandbox.lastSundayOfMonth_(2029, 8)), last);
});

// =====================================================================
// 第 2 組：R-030 跨年邊界
// =====================================================================

console.log('\n第 2 組：跨年邊界');

test('12 月建立的季度包含 1 月的主日時，兩年的轉換都掃得到', function () {
  // 2027T4 是 10–12 月，但如果一張清單同時有 12 月與翌年 1 月的主日，
  // 只掃第一個主日那一年就會漏掉翌年 4 月那一次。
  const dates = ['2027-12-26', '2028-01-02', '2028-01-09'];
  const notices = sandbox.daylightSavingNoticesForDates_(dates);
  // 這幾個日期本身都不是提示日，所以配對結果應該是空的……
  assert.strictEqual(notices.length, 0, '這三個主日都不是提示日');

  // ……但把 2028 年 4 月的提示日加進去就要配到，證明有掃到 2028 年。
  const end2028 = nthSundayIndependent(2028, 4, 1);
  const notice2028 = minusDays(end2028, 7);
  const withNotice = sandbox.daylightSavingNoticesForDates_(dates.concat([notice2028]));
  assert.strictEqual(withNotice.length, 1, '2028 年 4 月那一次要配到');
  assert.strictEqual(withNotice[0].kind, 'END');
  assert.strictEqual(withNotice[0].noticeIso, notice2028);
});

test('整季沒有夏令時間轉換時，一行都不加（S25 的單元版本）', function () {
  // 2028T1 的 1–3 月：紐西蘭的兩次轉換分別在 4 月與 9 月，這一季不應該有。
  // ⚠️ 不可以放 3 月 26 日——2028 年 4 月第一個主日是 4 月 2 日，提示日正好
  //    就是 3 月 26 日。第一次寫這一條時就是這樣自打嘴巴，測試紅了才發現。
  const dates = ['2028-01-02', '2028-02-06', '2028-03-05', '2028-03-19'];
  assert.strictEqual(sandbox.daylightSavingNoticesForDates_(dates).length, 0);
});

test('含 4 月第一個主日的季度會配到 END 那一次（S22 的單元版本）', function () {
  const end2028 = nthSundayIndependent(2028, 4, 1);
  const notice = minusDays(end2028, 7);
  const notices = sandbox.daylightSavingNoticesForDates_([notice, end2028]);
  assert.strictEqual(notices.length, 1);
  assert.strictEqual(notices[0].kind, 'END');
  assert.strictEqual(notices[0].changeIso, end2028);
});

// =====================================================================
// 第 3 組：R-030 只覆寫「系統寫的、未被人手改過」的行
// =====================================================================

console.log('\n第 3 組：夏令時間行的覆寫規則');

test('SOURCE=SYSTEM_DST 而且快照對得上 → 當作未被改過，可以覆寫', function () {
  const row = { SOURCE: 'SYSTEM_DST', TEXT: '原文', SOURCE_SNAPSHOT: '原文', ACTIVE: true };
  assert.strictEqual(sandbox.daylightSavingRowWasEdited_(row), false);
});

test('內容被人手改過（與快照不同）→ 之後不再覆寫', function () {
  const row = { SOURCE: 'SYSTEM_DST', TEXT: '幹事改過的文字', SOURCE_SNAPSHOT: '原文', ACTIVE: true };
  assert.strictEqual(sandbox.daylightSavingRowWasEdited_(row), true);
});

test('「有效」設成 FALSE → 當作人手決定不要，永遠不再覆寫', function () {
  const row = { SOURCE: 'SYSTEM_DST', TEXT: '原文', SOURCE_SNAPSHOT: '原文', ACTIVE: 'FALSE' };
  assert.strictEqual(sandbox.daylightSavingRowWasEdited_(row), true);
});

test('沒有快照的行（來歷不明）→ 保守當作被改過，不覆寫', function () {
  // 快照欄是這一次才加的，舊資料不會有。寧可不覆寫也不可以覆寫錯。
  const row = { SOURCE: 'SYSTEM_DST', TEXT: '原文', SOURCE_SNAPSHOT: '', ACTIVE: true };
  assert.strictEqual(sandbox.daylightSavingRowWasEdited_(row), true);
});

test('planDaylightSavingRows_：未有的要新增，可覆寫的更新，人手改過的不動', function () {
  const wanted = [
    { SERVICE_DATE: '2028-03-26', SEQ_NO: 5, TEXT: '新文字 A', SOURCE: 'SYSTEM_DST', SOURCE_SNAPSHOT: '新文字 A', ACTIVE: true }
  ];

  // (1) 完全沒有既有行 → 新增一行
  const planA = sandbox.planDaylightSavingRows_([], wanted);
  assert.strictEqual(planA.appends.length, 1, '應該新增一行');
  assert.strictEqual(planA.updates.length, 0);

  // (2) 有一行系統寫的、未改過 → 更新，不新增（否則會愈刷新愈多行）
  // 既有行的形狀跟 readContentTabRowsWithRowNo_() 一致：平面一層，行號在 __rowNo。
  const existingClean = [
    { __rowNo: 7, SERVICE_DATE: '2028-03-26', SEQ_NO: 5, TEXT: '舊文字', SOURCE: 'SYSTEM_DST', SOURCE_SNAPSHOT: '舊文字', ACTIVE: true }
  ];
  const planB = sandbox.planDaylightSavingRows_(existingClean, wanted);
  assert.strictEqual(planB.appends.length, 0, '不可以再新增一行');
  assert.strictEqual(planB.updates.length, 1, '應該更新那一行');
  assert.strictEqual(planB.updates[0].rowNo, 7);

  // (3) 有一行被人手改過 → 完全不動，也不可以另外新增一行覆蓋
  const existingEdited = [
    { __rowNo: 7, SERVICE_DATE: '2028-03-26', SEQ_NO: 5, TEXT: '幹事改過', SOURCE: 'SYSTEM_DST', SOURCE_SNAPSHOT: '舊文字', ACTIVE: true }
  ];
  const planC = sandbox.planDaylightSavingRows_(existingEdited, wanted);
  assert.strictEqual(planC.appends.length, 0, '被改過就不可以再新增一行（會變兩行）');
  assert.strictEqual(planC.updates.length, 0, '被改過就不可以更新');
  assert.strictEqual(planC.untouched.length, 1);
});

test('範本不可以含「(如圖)」——系統不處理圖片', function () {
  const defaults = sandbox.DEFAULTS.filter(function (d) {
    return d.key === sandbox.CONFIG_KEYS.DST_START_ANNOUNCEMENT
      || d.key === sandbox.CONFIG_KEYS.DST_END_ANNOUNCEMENT;
  });
  assert.strictEqual(defaults.length, 2, '兩個範本鍵都要有預設值');
  defaults.forEach(function (d) {
    assert.strictEqual(String(d.value).indexOf('如圖'), -1, d.key + ' 不可以含「如圖」');
  });
});

// =====================================================================
// 第 4 組：R-036 ROSTER_STATUS 三個值
// =====================================================================

console.log('\n第 4 組：ROSTER_STATUS 三個值');

test('整季職事表都沒有 → NOT_FOUND', function () {
  const resolution = { dates: ['2028-10-01'], source: 'CALENDAR', rosterDates: [] };
  assert.strictEqual(sandbox.rosterStatusForDate_('2028-10-01', resolution), sandbox.ROSTER_STATUS.NOT_FOUND);
});

test('職事表有這個主日 → OK', function () {
  const resolution = { dates: ['2028-10-01'], source: 'ROSTER', rosterDates: ['2028-10-01'] };
  assert.strictEqual(sandbox.rosterStatusForDate_('2028-10-01', resolution), sandbox.ROSTER_STATUS.OK);
});

test('職事表有這一季、但沒有這一個主日 → PARTIAL', function () {
  const resolution = { dates: ['2028-10-01', '2028-10-08'], source: 'ROSTER', rosterDates: ['2028-10-01'] };
  assert.strictEqual(sandbox.rosterStatusForDate_('2028-10-08', resolution), sandbox.ROSTER_STATUS.PARTIAL);
});

test('三個值只有這三個，而且 BulletinWeeks 真的有這一欄', function () {
  assert.deepStrictEqual(Object.keys(sandbox.ROSTER_STATUS).sort(), ['NOT_FOUND', 'OK', 'PARTIAL']);
  assert.ok(sandbox.COLUMNS.BULLETIN_WEEKS.keys.indexOf('ROSTER_STATUS') !== -1,
    'BulletinWeeks 要有 ROSTER_STATUS 這一欄');
});

test('補抓只填空白格：0 與 FALSE 不算空白', function () {
  // 人數填 0 是有意義的值，當成空白會被「補抓」蓋掉。
  assert.strictEqual(sandbox.isBlankWeekCell_(0), false, '數字 0 不是空白');
  assert.strictEqual(sandbox.isBlankWeekCell_(false), false, 'false 不是空白');
  assert.strictEqual(sandbox.isBlankWeekCell_(''), true);
  assert.strictEqual(sandbox.isBlankWeekCell_('   '), true);
  assert.strictEqual(sandbox.isBlankWeekCell_(null), true);
  assert.strictEqual(sandbox.isBlankWeekCell_(undefined), true);
});

test('季度曆法主日：2027T4 由 10 月第一個主日起，全部是星期日', function () {
  const dates = sandbox.quarterCalendarSundays_('2027T4');
  assert.ok(dates.length >= 12 && dates.length <= 14, '一季應該有 12–14 個主日，實際 ' + dates.length);
  assert.strictEqual(dates[0], nthSundayIndependent(2027, 10, 1));
  dates.forEach(function (iso) {
    const [y, m, d] = iso.split('-').map(Number);
    assert.strictEqual(new Date(y, m - 1, d).getDay(), 0, iso + ' 應該是星期日');
    assert.ok(m >= 10 && m <= 12, iso + ' 應該在 10–12 月之內');
  });
});

// =====================================================================
// 第 5 組：R-034 兩層選單
// =====================================================================

console.log('\n第 5 組：兩層主日選單');

/**
 * 造一列 BulletinWeeks 資料。
 *
 *   ⚠️ Date 一定要用 sandbox.__mkDate() 造，理由見上面那段註解。
 */
function weekRow(iso, quarterId, extra) {
  const [y, m, d] = iso.split('-').map(Number);
  const row = {
    SERVICE_DATE: sandbox.__mkDate(y, m - 1, d),
    QUARTER_ID: quarterId,
    WEEK_OF_MONTH: 1,
    STATUS: 'DRAFT',
    ROSTER_STATUS: 'OK'
  };
  return Object.assign(row, extra || {});
}

test('狀態標記三種各一條', function () {
  assert.strictEqual(sandbox.weekSelectorStatusLabel_(3, 12), '已發佈 第 3 版',
    '已發佈就顯示版本，未填項數不再提');
  assert.strictEqual(sandbox.weekSelectorStatusLabel_(null, 12), '待填 12 項');
  assert.strictEqual(sandbox.weekSelectorStatusLabel_(null, 0), '已齊');
});

test('已發佈優先於待填：發佈之後就算仍有未填欄位也顯示「已發佈」', function () {
  // 幹事問的是「邊幾期未搞掂」——已經發佈了的就是搞掂了。
  assert.strictEqual(sandbox.weekSelectorStatusLabel_(1, 99), '已發佈 第 1 版');
});

test('PublishLog 取最大版本號，而且自測那些行不算', function () {
  const index = sandbox.weekSelectorPublishIndex_([
    { SERVICE_DATE: '2027-11-07', VERSION_NO: 1, IS_SELFTEST: false },
    { SERVICE_DATE: '2027-11-07', VERSION_NO: 3, IS_SELFTEST: false },
    { SERVICE_DATE: '2027-11-07', VERSION_NO: 2, IS_SELFTEST: false },
    { SERVICE_DATE: '2027-11-14', VERSION_NO: 9, IS_SELFTEST: true }
  ]);
  assert.strictEqual(index['2027-11-07'], 3, '取最大版本號');
  assert.ok(!Object.prototype.hasOwnProperty.call(index, '2027-11-14'),
    '自測跑過不可以令正式主日變成「已發佈」');
});

test('沙盒季度永遠不出現在季度下拉', function () {
  const entries = sandbox.buildWeekListEntries_([
    weekRow('2027-11-07', '2027T4'),
    weekRow('2028-10-01', '2028T4')          // 沙盒季度
  ], '2027-11-01');

  const groups = sandbox.buildQuarterWeekGroups_(entries, '2028T4');
  const ids = groups.map(function (g) { return g.quarterId; });
  assertArrayEqual(ids, ['2027T4'], '沙盒季度 2028T4 不可以出現');
});

test('季度由新到舊、每季內主日由早到遲', function () {
  const entries = sandbox.buildWeekListEntries_([
    weekRow('2027-11-14', '2027T4'),
    weekRow('2027-11-07', '2027T4'),
    weekRow('2028-01-02', '2028T1'),
    weekRow('2027-07-04', '2027T3')
  ], '2027-11-01');

  const groups = sandbox.buildQuarterWeekGroups_(entries, '');
  assertArrayEqual(groups.map(function (g) { return g.quarterId; }),
    ['2028T1', '2027T4', '2027T3'], '季度由新到舊');
  assertArrayEqual(groups[1].weeks.map(function (w) { return w.isoDate; }),
    ['2027-11-07', '2027-11-14'], '季內由早到遲');
});

test('預設落在「下一個未發佈的主日」，不是清單第一項', function () {
  const rows = [
    weekRow('2027-11-07', '2027T4'),
    weekRow('2027-11-14', '2027T4'),
    weekRow('2027-11-21', '2027T4')
  ];
  const entries = sandbox.buildWeekListEntries_(rows, '2027-11-01', {
    publishIndex: { '2027-11-07': 1, '2027-11-14': 2 },   // 頭兩期已發佈
    missingIndex: {}
  });
  const groups = sandbox.buildQuarterWeekGroups_(entries, '');

  assert.strictEqual(sandbox.pickDefaultSelectorIsoDate_(groups, '2027-11-01'), '2027-11-21',
    '應該跳過已發佈那兩期');
  assert.notStrictEqual(sandbox.pickDefaultSelectorIsoDate_(groups, '2027-11-01'), '2027-11-07',
    '不可以是清單第一項');
});

test('全部主日都已發佈時，退回今天之後最早的一個', function () {
  const entries = sandbox.buildWeekListEntries_([
    weekRow('2027-11-07', '2027T4'),
    weekRow('2027-11-14', '2027T4')
  ], '2027-11-01', { publishIndex: { '2027-11-07': 1, '2027-11-14': 1 }, missingIndex: {} });
  const groups = sandbox.buildQuarterWeekGroups_(entries, '');
  assert.strictEqual(sandbox.pickDefaultSelectorIsoDate_(groups, '2027-11-01'), '2027-11-07');
});

test('全部主日都是過去時，退回最遲的一個', function () {
  const entries = sandbox.buildWeekListEntries_([
    weekRow('2027-11-07', '2027T4'),
    weekRow('2027-11-14', '2027T4')
  ], '2028-05-01');
  const groups = sandbox.buildQuarterWeekGroups_(entries, '');
  assert.strictEqual(sandbox.pickDefaultSelectorIsoDate_(groups, '2028-05-01'), '2027-11-14');
});

test('沒有任何主日時回 null，不會拋例外', function () {
  assert.strictEqual(sandbox.pickDefaultSelectorIsoDate_([], '2027-11-01'), null);
  assert.strictEqual(sandbox.pickDefaultSelectorIsoDate_(null, '2027-11-01'), null);
});

test('直接跳轉之後查得出季度（兩個下拉才對得準）', function () {
  const entries = sandbox.buildWeekListEntries_([
    weekRow('2027-11-07', '2027T4'),
    weekRow('2028-01-02', '2028T1')
  ], '2027-11-01');
  const groups = sandbox.buildQuarterWeekGroups_(entries, '');
  assert.strictEqual(sandbox.quarterIdOfIsoDateInGroups_(groups, '2028-01-02'), '2028T1');
  assert.strictEqual(sandbox.quarterIdOfIsoDateInGroups_(groups, '2099-01-01'), null,
    '查不到要回 null，不可以亂猜一個季度');
});

test('下拉每一項都帶狀態標記，而且舊的 label 欄位仍然在', function () {
  const entries = sandbox.buildWeekListEntries_([weekRow('2027-11-07', '2027T4')], '2027-11-01', {
    publishIndex: {},
    missingIndex: { '2027-11-07': 4 }
  });
  assert.strictEqual(entries[0].selectorLabel, '2027-11-07　待填 4 項');
  assert.strictEqual(entries[0].statusLabel, '待填 4 項');
  assert.ok(entries[0].label.indexOf('2027-11-07') === 0, '舊的 label 要保留（直接跳轉那條路徑仍然用它）');
  assert.strictEqual(entries[0].quarterId, '2027T4');
});

test('QUARTER_ID 空白的行歸到「未分季」，排最後，不會消失', function () {
  const entries = sandbox.buildWeekListEntries_([
    weekRow('2027-11-07', ''),
    weekRow('2027-11-14', '2027T4')
  ], '2027-11-01');
  const groups = sandbox.buildQuarterWeekGroups_(entries, '');
  assert.strictEqual(groups.length, 2);
  assert.strictEqual(groups[groups.length - 1].quarterId, '');
  assert.strictEqual(groups[groups.length - 1].label, '未分季');
});

// =====================================================================

console.log('\n通過 ' + pass + ' 項，失敗 ' + fail + ' 項。');
process.exit(fail === 0 ? 0 : 1);
