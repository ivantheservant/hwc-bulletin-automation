#!/usr/bin/env node
/**
 * tests/textformat.test.js
 *
 * 第一輪自測修正 Part 2：設計上是文字的欄位，不可以被 Google Sheets
 * 自作主張轉成數字或日期（docs/已知bug類型.md 事故二十八）。
 *
 * 最核心的兩條：
 *   - **第 0 組是「證明測試造得出紅色」**：先驗證假工作表真的會像 Sheets
 *     那樣把 '42,150' 轉成 42150。如果假替身不會轉，下面所有「先設格式再
 *     寫值」的測試都會無論修不修都綠——等於沒有測（事故二十二）。
 *   - **冪等**：寫入端修好之後，同一個值寫兩次讀回來仍然是同一個文字。
 *
 * 執行方式：node tests/textformat.test.js
 * 離開碼：0＝全部通過　1＝有測試失敗
 */

'use strict';

const assert = require('assert');
const { makeFakeSheet } = require('./helpers/fakeSpreadsheet');
const { makeFillEnv } = require('./helpers/fillEnv');
const { assertWrittenChinese } = require('./helpers/writtenChinese');

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

function deepEq(actual, expected, message) {
  assert.strictEqual(JSON.stringify(actual), JSON.stringify(expected), message);
}

// =====================================================================
// 0. 先證明假替身真的會轉型——否則下面全部測試都是假綠
// =====================================================================

test('0a. 假工作表真的會像 Sheets 那樣把 "42,150" 轉成數字（測試造得出紅色）', function () {
  const sheet = makeFakeSheet(['甲'], ['A'], [{ A: '' }]);
  sheet.getRange(3, 1).setValue('42,150');
  assert.strictEqual(sheet.getRange(3, 1).getValue(), 42150,
    '假替身如果不會轉型，這個檔案裡面全部測試都會無論修不修都綠');
});

test('0b. 先設 setNumberFormat("@") 之後再寫，同一個值就守得住', function () {
  const sheet = makeFakeSheet(['甲'], ['A'], [{ A: '' }]);
  sheet.getRange(3, 1).setNumberFormat('@');
  sheet.getRange(3, 1).setValue('42,150');
  assert.strictEqual(sheet.getRange(3, 1).getValue(), '42,150');
});

test('0c. 次序反轉（先寫值後設格式）救不回——證明「先設格式」不是可有可無', function () {
  const sheet = makeFakeSheet(['甲'], ['A'], [{ A: '' }]);
  sheet.getRange(3, 1).setValue('42,150');
  sheet.getRange(3, 1).setNumberFormat('@');
  assert.strictEqual(sheet.getRange(3, 1).getValue(), 42150,
    '寫完才設格式已經太遲，千分位逗號早就沒有了');
});

test('0d. 前導單引號（sanitizeCellText_ 的跳脫）本身就等於純文字，不會被轉', function () {
  const sheet = makeFakeSheet(['甲'], ['A'], [{ A: '' }]);
  sheet.getRange(3, 1).setValue("'-5");
  assert.strictEqual(sheet.getRange(3, 1).getValue(), '-5');
});

// =====================================================================
// 1. Constants：設計上是文字的欄位有沒有登記
// =====================================================================

test('1a. Finance 五個金額欄全部登記在 textFormatColumns（第一輪紅的根因）', function () {
  const env = makeFillEnv({});
  const def = env.sandbox.COLUMNS.FINANCE;
  assert.ok(def.textFormatColumns, 'Finance 之前完全沒有這一項，所以 42,150 變了 42150');
  deepEq(def.textFormatColumns.slice().sort(),
    ['COL3', 'COL4', 'COL5', 'COL_HARDSHIP', 'COL_SPECIAL_OVERSEAS'].sort());
});

test('1b. BulletinWeeks 十二個 ATT_* 欄全部登記', function () {
  const env = makeFillEnv({});
  const def = env.sandbox.COLUMNS.BULLETIN_WEEKS;
  const attKeys = def.keys.filter(function (k) { return k.indexOf('ATT_') === 0; });
  assert.strictEqual(attKeys.length, 12);
  attKeys.forEach(function (key) {
    assert.ok(def.textFormatColumns.indexOf(key) !== -1, key + ' 沒有登記成純文字欄');
  });
});

test('1c. Fellowships 的日期／時間兩欄登記（樣本值 "10/5 星期日"、"4:30pm"）', function () {
  const env = makeFillEnv({});
  deepEq(env.sandbox.COLUMNS.FELLOWSHIPS.textFormatColumns, ['MEETING_DATE', 'MEETING_TIME']);
});

test('1d. 每一個 textFormatColumns 列出的鍵，真的存在於該表的 keys', function () {
  const env = makeFillEnv({});
  Object.keys(env.sandbox.COLUMNS).forEach(function (sheetId) {
    const def = env.sandbox.COLUMNS[sheetId];
    (def.textFormatColumns || []).forEach(function (key) {
      assert.ok(def.keys.indexOf(key) !== -1,
        sheetId + ' 的 textFormatColumns 有一個不存在的鍵：' + key);
    });
  });
});

// =====================================================================
// 2. 寫入端：先設格式再寫值
// =====================================================================

test('2a. setCellValueTextSafe_：純文字欄守得住 "42,150"', function () {
  const env = makeFillEnv({});
  const sheet = env.sheets.Finance;
  const def = env.sandbox.COLUMNS.FINANCE;
  const col = def.keys.indexOf('COL_SPECIAL_OVERSEAS') + 1;
  sheet.getRange(3, 1, 1, def.keys.length).setValues([def.keys.map(function () { return ''; })]);
  env.sandbox.setCellValueTextSafe_(sheet, def, 3, 'COL_SPECIAL_OVERSEAS', '42,150');
  assert.strictEqual(sheet.getRange(3, col).getValue(), '42,150');
});

test('2b. setCellValueTextSafe_：不是純文字欄就不會多設格式（SEQ_NO 照樣是數字）', function () {
  const env = makeFillEnv({});
  const sheet = env.sheets.Finance;
  const def = env.sandbox.COLUMNS.FINANCE;
  const col = def.keys.indexOf('SEQ_NO') + 1;
  sheet.getRange(3, 1, 1, def.keys.length).setValues([def.keys.map(function () { return ''; })]);
  env.sandbox.setCellValueTextSafe_(sheet, def, 3, 'SEQ_NO', 10);
  assert.strictEqual(sheet.getRange(3, col).getValue(), 10);
  assert.strictEqual(sheet.__numberFormats['3:' + col], undefined,
    'SEQ_NO 不是文字欄，不應該被設成 "@"');
});

test('2c. setCellValueTextSafe_：不認識的機器鍵回 false，不會靜靜寫錯欄', function () {
  const env = makeFillEnv({});
  assert.strictEqual(
    env.sandbox.setCellValueTextSafe_(env.sheets.Finance, env.sandbox.COLUMNS.FINANCE, 3, '不存在', 'x'),
    false);
});

test('2d. writeSheet 附加新行：純文字欄守得住（附加是匯入最常走的路）', function () {
  const env = makeFillEnv({});
  env.sandbox.writeSheet(env.sandbox.SHEETS.FINANCE, [{
    SERVICE_DATE: '2027-10-03', SEQ_NO: 10, ROW_LABEL: '奉獻',
    COL_SPECIAL_OVERSEAS: '42,150', COL_HARDSHIP: '1,234.50',
    COL3: '007', COL4: '--', COL5: '', ACTIVE: true
  }]);
  const rows = env.sandbox.readSheet(env.sandbox.SHEETS.FINANCE);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].COL_SPECIAL_OVERSEAS, '42,150');
  assert.strictEqual(rows[0].COL_HARDSHIP, '1,234.50');
  assert.strictEqual(rows[0].COL3, '007', '前導零一樣會被轉走，一樣要守');
});

test('2e. writeSheet：SEQ_NO 這類真數字欄不受影響，仍然是數字', function () {
  const env = makeFillEnv({});
  env.sandbox.writeSheet(env.sandbox.SHEETS.FINANCE, [{
    SERVICE_DATE: '2027-10-03', SEQ_NO: 20, ROW_LABEL: '慈惠', ACTIVE: true
  }]);
  const rows = env.sandbox.readSheet(env.sandbox.SHEETS.FINANCE);
  assert.strictEqual(rows[0].SEQ_NO, 20);
});

test('2f. writeBulletinWeekField_：ATT_* 守得住 "前:5 / 後:120" 與純數字 "57"', function () {
  const env = makeFillEnv({});
  const iso = env.serviceDates[0];
  env.sandbox.writeBulletinWeekField_(iso, 'ATT_CANE_WORSHIP', '前:5 / 後:120');
  env.sandbox.writeBulletinWeekField_(iso, 'ATT_ENG_WORSHIP', '57');
  const week = env.sandbox.readBulletinWeekRowWithRowNo_(iso);
  assert.strictEqual(week.ATT_CANE_WORSHIP, '前:5 / 後:120');
  assert.strictEqual(week.ATT_ENG_WORSHIP, '57', '純數字的人數一樣要留成文字');
});

test('2g. 同一格寫兩次，第二次讀回來與第一次一模一樣（冪等的最小證明）', function () {
  const env = makeFillEnv({});
  const iso = env.serviceDates[0];
  env.sandbox.writeBulletinWeekField_(iso, 'ATT_MAN_WORSHIP', '42,150');
  const first = env.sandbox.readBulletinWeekRowWithRowNo_(iso).ATT_MAN_WORSHIP;
  env.sandbox.writeBulletinWeekField_(iso, 'ATT_MAN_WORSHIP', '42,150');
  const second = env.sandbox.readBulletinWeekRowWithRowNo_(iso).ATT_MAN_WORSHIP;
  assert.strictEqual(first, '42,150');
  assert.strictEqual(second, first);
});

test('2h. applyTextFormatToRange_ 回報設過多少欄；沒有 textFormatColumns 的表回 0', function () {
  const env = makeFillEnv({});
  assert.strictEqual(
    env.sandbox.applyTextFormatToRange_(env.sheets.Finance, env.sandbox.COLUMNS.FINANCE, 3, 5), 5);
  assert.strictEqual(
    env.sandbox.applyTextFormatToRange_(env.sheets.Announcements, env.sandbox.COLUMNS.ANNOUNCEMENTS, 3, 5), 0);
  assert.strictEqual(
    env.sandbox.applyTextFormatToRange_(env.sheets.Finance, env.sandbox.COLUMNS.FINANCE, 3, 0), 0,
    '0 行不需要設格式');
});

// =====================================================================
// 3. 比對：兩邊都經同一支正規化函式
// =====================================================================

test('3a. normalizeContentCompareValue_：空值一律變空字串', function () {
  const env = makeFillEnv({});
  const norm = env.sandbox.normalizeContentCompareValue_;
  assert.strictEqual(norm(null), '');
  assert.strictEqual(norm(undefined), '');
  assert.strictEqual(norm(''), '');
});

test('3b. normalizeContentCompareValue_：Date 轉 yyyy-MM-dd，不是 "Mon Oct 04 2027 …"', function () {
  const env = makeFillEnv({});
  const value = env.sandbox.normalizeContentCompareValue_(new Date(2027, 9, 4));
  assert.strictEqual(value, '2027-10-04',
    'String(dateObject) 永遠不會等於內容表的 "2027-10-04"，那一欄就會每次都判定有改動');
});

test('3c. normalizeContentCompareValue_ 刻意不把 42150 當成等於 "42,150"', function () {
  const env = makeFillEnv({});
  assert.strictEqual(
    env.sandbox.contentValuesEqual_(42150, '42,150'), false,
    '當成相等的話，匯入就永遠不會把正確的文字寫回去，週報會一直印「42150」');
});

test('3d. contentValuesEqual_：兩邊都經同一支——數字 10 與字串 " 10 " 相等', function () {
  const env = makeFillEnv({});
  assert.strictEqual(env.sandbox.contentValuesEqual_(10, ' 10 '), true);
});

// =====================================================================
// 4. 一次性修復
// =====================================================================

function seedBrokenFinanceRow(env, values) {
  const sheet = env.sheets.Finance;
  const def = env.sandbox.COLUMNS.FINANCE;
  // 造出「已經寫壞了」的舊資料：不設格式直接寫，模擬修正之前的系統。
  sheet.getRange(3, 1, 1, def.keys.length).setValues([def.keys.map(function (key) {
    if (values[key] !== undefined) return values[key];
    if (key === 'ACTIVE') return true;
    return '';
  })]);
  return { sheet: sheet, def: def };
}

test('4a. planTextFormatRepairForColumn_：數字要修，字串與空白不用動', function () {
  const env = makeFillEnv({});
  const plan = env.sandbox.planTextFormatRepairForColumn_(
    [[42150], ['42,150'], [''], [null], [1234.5]], 3);
  deepEq(plan.map(function (p) { return [p.rowNo, p.newValue]; }),
    [[3, '42150'], [7, '1234.5']]);
});

test('4b. planTextFormatRepairForColumn_：被轉成日期的格也要修', function () {
  const env = makeFillEnv({});
  const plan = env.sandbox.planTextFormatRepairForColumn_([[new Date(2027, 9, 5)]], 3);
  assert.strictEqual(plan.length, 1);
  assert.strictEqual(plan[0].newValue, '2027-10-05');
});

test('4c. repairTextColumnsStoredAsNumbers_：真的改回文字，並報得出格數', function () {
  const env = makeFillEnv({});
  seedBrokenFinanceRow(env, {
    SERVICE_DATE: '2027-10-03', SEQ_NO: 10, ROW_LABEL: '奉獻',
    COL_SPECIAL_OVERSEAS: 42150, COL_HARDSHIP: 3200
  });
  const before = env.sandbox.readSheet(env.sandbox.SHEETS.FINANCE)[0];
  assert.strictEqual(before.COL_SPECIAL_OVERSEAS, '42150', '前置條件：舊資料的確已經被轉走');

  const summary = env.sandbox.repairTextColumnsStoredAsNumbers_({ dryRun: false });
  assert.strictEqual(summary.ok, true);
  assert.ok(summary.repaired >= 2, '至少修得到那兩格：' + summary.repaired);

  const after = env.sandbox.readSheet(env.sandbox.SHEETS.FINANCE)[0];
  assert.strictEqual(after.COL_SPECIAL_OVERSEAS, '42150');
  assert.strictEqual(typeof after.COL_SPECIAL_OVERSEAS, 'string', '修完之後型別要是文字');
  assert.strictEqual(after.SEQ_NO, 10, 'SEQ_NO 不是文字欄，不可以被改');
});

test('4d. repairTextColumnsStoredAsNumbers_：dryRun 只點算，一格都不寫', function () {
  const env = makeFillEnv({});
  const seeded = seedBrokenFinanceRow(env, {
    SERVICE_DATE: '2027-10-03', COL_SPECIAL_OVERSEAS: 42150
  });
  const col = seeded.def.keys.indexOf('COL_SPECIAL_OVERSEAS') + 1;
  const summary = env.sandbox.repairTextColumnsStoredAsNumbers_({ dryRun: true });
  assert.ok(summary.repaired >= 1);
  assert.strictEqual(summary.dryRun, true);
  assert.strictEqual(seeded.sheet.getRange(3, col).getValue(), 42150, 'dryRun 不可以改動任何一格');
});

test('4e. repairTextColumnsStoredAsNumbers_：沒有壞資料時回 0，不會為了好看而亂改', function () {
  const env = makeFillEnv({});
  const summary = env.sandbox.repairTextColumnsStoredAsNumbers_({ dryRun: false });
  assert.strictEqual(summary.repaired, 0);
  assert.ok(summary.scannedColumns > 0, '要真的掃描過欄位，不是完全沒有做事');
});

test('4f. 修完之後再寫同一個值，不會再被轉走（修復與寫入端要一齊生效）', function () {
  const env = makeFillEnv({});
  const seeded = seedBrokenFinanceRow(env, {
    SERVICE_DATE: '2027-10-03', COL_SPECIAL_OVERSEAS: 42150
  });
  env.sandbox.repairTextColumnsStoredAsNumbers_({ dryRun: false });
  env.sandbox.setCellValueTextSafe_(seeded.sheet, seeded.def, 3, 'COL_SPECIAL_OVERSEAS', '42,150');
  const after = env.sandbox.readSheet(env.sandbox.SHEETS.FINANCE)[0];
  assert.strictEqual(after.COL_SPECIAL_OVERSEAS, '42,150');
});

test('4g. 修復報告講明「還原不到顯示格式」，不會令人以為修完就等於資料正確', function () {
  const env = makeFillEnv({});
  const lines = env.sandbox.buildTextFormatRepairReportLines_(
    env.sandbox.repairTextColumnsStoredAsNumbers_({ dryRun: true }));
  const text = lines.join('\n');
  assert.ok(text.indexOf('不能還原原本的顯示格式') !== -1, text);
  assert.ok(text.indexOf('從內容表匯入') !== -1, '要講清楚下一步做什麼');
});

test('4h. 修復報告每一行都不會以 = + - @ 開頭（事故六）', function () {
  const env = makeFillEnv({});
  seedBrokenFinanceRow(env, { SERVICE_DATE: '2027-10-03', COL_SPECIAL_OVERSEAS: 42150 });
  const lines = env.sandbox.buildTextFormatRepairReportLines_(
    env.sandbox.repairTextColumnsStoredAsNumbers_({ dryRun: true }));
  lines.forEach(function (line) {
    if (line === '') return;
    assert.ok('=+-@'.indexOf(line.charAt(0)) === -1, '這一行會被當成公式：' + line);
  });
});

test('4i. 修復報告是書面語繁體中文', function () {
  const env = makeFillEnv({});
  const lines = env.sandbox.buildTextFormatRepairReportLines_(
    env.sandbox.repairTextColumnsStoredAsNumbers_({ dryRun: true }));
  assertWrittenChinese(assert, '修復被轉成數字的文字欄位', lines);
});

console.log('');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
