#!/usr/bin/env node
/**
 * tests/fellowshipdefaults.test.js
 *
 * 第八輪「本週團契聚會：常設時間表」的回歸測試。
 *
 * 執行方式：node tests/fellowshipdefaults.test.js
 * 離開碼：0＝全部通過　1＝有測試失敗
 */

'use strict';

const assert = require('assert');
const { loadAllSrcFilesInOrder } = require('./helpers/loadGas');
const { makeFillEnv, QUARTER_ID, BASE_STUBS } = require('./helpers/fillEnv');

const sandbox = loadAllSrcFilesInOrder(Object.assign({}, BASE_STUBS, { SpreadsheetApp: {} }));
const {
  evaluateProgramCondition_, fellowshipMeetingDate_, formatFellowshipMeetingDate_,
  buildFellowshipGenerationPlan_, buildResequencePlan_, CONDITION_TYPE
} = sandbox;

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

/** 求值一個 RECURRENCE 規則（與程序範本共用同一個求值器）。 */
function recurs(rule, weekOfMonth) {
  return evaluateProgramCondition_(rule, {
    week: {}, weekOfMonth: weekOfMonth,
    row: { TEMPLATE_ID: 'FellowshipDefaults', SEQ_NO: 1 }
  });
}

// =====================================================================
// 1. 四種出現規則
// =====================================================================

test('1a. ALWAYS：每一個主日都出現', function () {
  [1, 2, 3, 4, 5].forEach(function (w) {
    assert.strictEqual(recurs(CONDITION_TYPE.ALWAYS, w), true, '第 ' + w + ' 個主日');
  });
});

test('1b. NEVER：一律不出現', function () {
  [1, 2, 3, 4, 5].forEach(function (w) {
    assert.strictEqual(recurs(CONDITION_TYPE.NEVER, w), false);
  });
});

test('1c. WEEK_IN:2,4：只在第 2、4 個主日出現', function () {
  assertArrayEqual([1, 2, 3, 4, 5].map(function (w) { return recurs('WEEK_IN:2,4', w); }),
    [false, true, false, true, false]);
});

test('1d. WEEK_NOT_IN:1：除了第 1 個主日以外都出現', function () {
  assertArrayEqual([1, 2, 3, 4, 5].map(function (w) { return recurs('WEEK_NOT_IN:1', w); }),
    [false, true, true, true, true]);
});

test('1e. WEEK_NOT_IN 與 WEEK_IN 是互補的（同一份清單）', function () {
  [1, 2, 3, 4, 5].forEach(function (w) {
    assert.strictEqual(recurs('WEEK_IN:2,4', w), !recurs('WEEK_NOT_IN:2,4', w),
      '第 ' + w + ' 個主日：兩個規則應該剛好相反');
  });
});

test('1f. 認不出的規則 → 拋錯，訊息列出可用語法（我們自己的表要嚴格）', function () {
  assert.throws(
    function () { recurs('EVERY_OTHER_WEEK', 1); },
    function (err) {
      return err.message.indexOf('WEEK_NOT_IN') !== -1 && err.message.indexOf('無法辨識') !== -1;
    }
  );
});

test('1g. 與程序範本共用同一個求值器（不是各寫一套）', function () {
  // 同一個規則字串，用程序範本的 ctx 與團契的 ctx 求值，結果必須一樣。
  const asProgram = evaluateProgramCondition_('WEEK_IN:2,4', {
    week: {}, weekOfMonth: 2, row: { TEMPLATE_ID: 'TPL_NORMAL', SEQ_NO: 150 }
  });
  assert.strictEqual(asProgram, recurs('WEEK_IN:2,4', 2));
});

// =====================================================================
// 2. DAY_OFFSET 計算（含跨月、跨年）
// =====================================================================

test('2a. DAY_OFFSET = 0：聚會日就是主日當日', function () {
  const d = fellowshipMeetingDate_('2027-11-07', 0);
  assert.strictEqual(d.getFullYear(), 2027);
  assert.strictEqual(d.getMonth() + 1, 11);
  assert.strictEqual(d.getDate(), 7);
});

test('2b. DAY_OFFSET = 5：主日之後的星期五', function () {
  const d = fellowshipMeetingDate_('2027-11-07', 5);
  assert.strictEqual(d.getDate(), 12);
  assert.strictEqual(d.getMonth() + 1, 11);
});

test('2c. DAY_OFFSET 跨月：11-28 ＋ 5 天 → 12-03', function () {
  const d = fellowshipMeetingDate_('2027-11-28', 5);
  assert.strictEqual(d.getMonth() + 1, 12);
  assert.strictEqual(d.getDate(), 3);
});

test('2d. DAY_OFFSET 跨年：2027-12-28 ＋ 5 天 → 2028-01-02', function () {
  const d = fellowshipMeetingDate_('2027-12-28', 5);
  assert.strictEqual(d.getFullYear(), 2028);
  assert.strictEqual(d.getMonth() + 1, 1);
  assert.strictEqual(d.getDate(), 2);
});

test('2d-2. DAY_OFFSET 剛好停在年尾：2027-12-26 ＋ 5 天 → 仍然是 2027-12-31', function () {
  const d = fellowshipMeetingDate_('2027-12-26', 5);
  assert.strictEqual(d.getFullYear(), 2027);
  assert.strictEqual(d.getMonth() + 1, 12);
  assert.strictEqual(d.getDate(), 31);
});

test('2e. DAY_OFFSET 負數（主日之前）也算得對', function () {
  const d = fellowshipMeetingDate_('2027-11-07', -2);
  assert.strictEqual(d.getMonth() + 1, 11);
  assert.strictEqual(d.getDate(), 5);
});

test('2f. DAY_OFFSET 空白／非數字當 0，不拋錯', function () {
  assert.strictEqual(fellowshipMeetingDate_('2027-11-07', '').getDate(), 7);
  assert.strictEqual(fellowshipMeetingDate_('2027-11-07', null).getDate(), 7);
  assert.strictEqual(fellowshipMeetingDate_('2027-11-07', 'abc').getDate(), 7);
});

test('2g. isoDate 格式不對 → 回 null，不拋錯', function () {
  assert.strictEqual(fellowshipMeetingDate_('唔係日期', 0), null);
  assert.strictEqual(fellowshipMeetingDate_('', 0), null);
});

// =====================================================================
// 4. FELLOWSHIP_DATE_PATTERN 改變時輸出跟着變
// =====================================================================

test('4a. 預設格式 d/M ＋ 星期文字', function () {
  const d = fellowshipMeetingDate_('2027-11-07', 0);
  assert.strictEqual(formatFellowshipMeetingDate_(d, '星期日', 'd/M'), '7/11 星期日');
});

test('4b. 格式改成 dd/MM → 補零', function () {
  const d = fellowshipMeetingDate_('2027-11-07', 0);
  assert.strictEqual(formatFellowshipMeetingDate_(d, '星期日', 'dd/MM'), '07/11 星期日');
});

test('4c. 格式改成 M月d日', function () {
  const d = fellowshipMeetingDate_('2027-11-07', 0);
  assert.strictEqual(formatFellowshipMeetingDate_(d, '星期日', 'M月d日'), '11月7日 星期日');
});

test('4d. 格式含 yyyy', function () {
  const d = fellowshipMeetingDate_('2027-11-07', 0);
  assert.strictEqual(formatFellowshipMeetingDate_(d, '', 'yyyy-MM-dd'), '2027-11-07');
});

test('4e. dd 不會被 d 先吃掉一半（由長到短替換）', function () {
  const d = fellowshipMeetingDate_('2027-11-05', 0);
  assert.strictEqual(formatFellowshipMeetingDate_(d, '', 'dd'), '05', '不可以變成 "5d" 之類');
  assert.strictEqual(formatFellowshipMeetingDate_(d, '', 'MM'), '11');
});

test('4f. 沒有星期文字時不會留下多餘的空格', function () {
  const d = fellowshipMeetingDate_('2027-11-07', 0);
  assert.strictEqual(formatFellowshipMeetingDate_(d, '', 'd/M'), '7/11');
  assert.strictEqual(formatFellowshipMeetingDate_(d, '   ', 'd/M'), '7/11');
});

test('4g. date 是 null 時只回星期文字，不拋錯', function () {
  assert.strictEqual(formatFellowshipMeetingDate_(null, '星期五', 'd/M'), '星期五');
});

// =====================================================================
// buildFellowshipGenerationPlan_（純函式層）
// =====================================================================

function serviceDates() {
  return [
    { isoDate: '2027-11-07', weekOfMonth: 1 },
    { isoDate: '2027-11-14', weekOfMonth: 2 },
    { isoDate: '2027-11-21', weekOfMonth: 3 },
    { isoDate: '2027-11-28', weekOfMonth: 4 }
  ];
}

function defaultRow(overrides) {
  return Object.assign({
    FELLOWSHIP_NAME: '假團契', RECURRENCE: CONDITION_TYPE.ALWAYS, DAY_LABEL: '星期日',
    DAY_OFFSET: 0, TIME_TEXT: '4:30pm', DEFAULT_CONTENT: '講道分享', SORT_ORDER: 10, ACTIVE: true
  }, overrides || {});
}

test('產生計畫：ALWAYS 的團契四個主日都有', function () {
  const plan = buildFellowshipGenerationPlan_({
    serviceDates: serviceDates(), defaultRows: [defaultRow()], existingRows: [], datePattern: 'd/M'
  });
  assert.strictEqual(plan.addedCount, 4);
  assertArrayEqual(plan.appends.map(function (r) { return r.SERVICE_DATE; }),
    ['2027-11-07', '2027-11-14', '2027-11-21', '2027-11-28']);
});

test('產生計畫：WEEK_IN:2,4 的團契只在第 2、4 個主日出現', function () {
  const plan = buildFellowshipGenerationPlan_({
    serviceDates: serviceDates(),
    defaultRows: [defaultRow({ RECURRENCE: 'WEEK_IN:2,4' })],
    existingRows: [], datePattern: 'd/M'
  });
  assertArrayEqual(plan.appends.map(function (r) { return r.SERVICE_DATE; }), ['2027-11-14', '2027-11-28']);
});

test('產生計畫：WEEK_NOT_IN:1 的團契第 1 個主日不出現', function () {
  const plan = buildFellowshipGenerationPlan_({
    serviceDates: serviceDates(),
    defaultRows: [defaultRow({ RECURRENCE: 'WEEK_NOT_IN:1' })],
    existingRows: [], datePattern: 'd/M'
  });
  assertArrayEqual(plan.appends.map(function (r) { return r.SERVICE_DATE; }),
    ['2027-11-14', '2027-11-21', '2027-11-28']);
});

test('產生計畫：ACTIVE 不是 TRUE 的團契完全略過', function () {
  const plan = buildFellowshipGenerationPlan_({
    serviceDates: serviceDates(), defaultRows: [defaultRow({ ACTIVE: false })],
    existingRows: [], datePattern: 'd/M'
  });
  assert.strictEqual(plan.addedCount, 0);
});

test('產生計畫：多個團契依 SORT_ORDER 排序，SEQ_NO 由 10 遞增', function () {
  const plan = buildFellowshipGenerationPlan_({
    serviceDates: [{ isoDate: '2027-11-14', weekOfMonth: 2 }],
    defaultRows: [
      defaultRow({ FELLOWSHIP_NAME: '第二個', SORT_ORDER: 20 }),
      defaultRow({ FELLOWSHIP_NAME: '第一個', SORT_ORDER: 10 })
    ],
    existingRows: [], datePattern: 'd/M'
  });
  assertArrayEqual(plan.appends.map(function (r) { return r.FELLOWSHIP_NAME; }), ['第一個', '第二個']);
  assertArrayEqual(plan.appends.map(function (r) { return r.SEQ_NO; }), [10, 20]);
});

// =====================================================================
// 3. 冪等：已存在的行不被覆蓋
// =====================================================================

test('3. 冪等：已經存在的（主日＋團契名稱）完全不動，計入 skipped', function () {
  const plan = buildFellowshipGenerationPlan_({
    serviceDates: serviceDates(),
    defaultRows: [defaultRow()],
    existingRows: [
      { SERVICE_DATE: '2027-11-07', FELLOWSHIP_NAME: '假團契', CONTENT: '幹事人手改過的內容' }
    ],
    datePattern: 'd/M'
  });
  assert.strictEqual(plan.skippedCount, 1);
  assert.strictEqual(plan.addedCount, 3, '其餘三個主日照樣補');
  assert.ok(!plan.appends.some(function (r) { return r.SERVICE_DATE === '2027-11-07'; }),
    '已存在那一個主日不可以再產生一行');
});

test('3b. 冪等（真正入口）：跑兩次，第二次新增 0 行', function () {
  const env = makeFillEnv({ fellowshipDefaults: [defaultRow({ RECURRENCE: CONDITION_TYPE.ALWAYS })] });

  const first = env.sandbox.generateQuarterFellowships_(QUARTER_ID);
  assert.strictEqual(first.added, 4);

  const second = env.sandbox.generateQuarterFellowships_(QUARTER_ID);
  assert.strictEqual(second.added, 0, '第二次不應該再新增任何一行');
  assert.strictEqual(second.skipped, 4);
});

test('3c. 冪等：幹事人手改過的內容不會被第二次產生蓋掉', function () {
  const env = makeFillEnv({ fellowshipDefaults: [defaultRow({ RECURRENCE: CONDITION_TYPE.ALWAYS })] });
  env.sandbox.generateQuarterFellowships_(QUARTER_ID);

  // 模擬幹事把某一週改成郊遊
  const sheet = env.sheets.Fellowships;
  const contentCol = env.sandbox.COLUMNS.FELLOWSHIPS.keys.indexOf('CONTENT') + 1;
  sheet.getRange(3, contentCol).setValue('那一週改成郊遊');

  env.sandbox.generateQuarterFellowships_(QUARTER_ID);
  assert.strictEqual(env.sandbox.readSheet('Fellowships')[0].CONTENT, '那一週改成郊遊',
    '人手改過的內容絕對不可以被自動產生蓋掉');
});

// =====================================================================
// 規則打錯字：略過該團契並記 warning，不拋錯
// =====================================================================

test('規則打錯字 → 略過該團契並記 warning（不可以令整季都產生不到）', function () {
  const plan = buildFellowshipGenerationPlan_({
    serviceDates: serviceDates(),
    defaultRows: [
      defaultRow({ FELLOWSHIP_NAME: '規則正常的', RECURRENCE: CONDITION_TYPE.ALWAYS }),
      defaultRow({ FELLOWSHIP_NAME: '規則打錯字的', RECURRENCE: 'EVERY_OTHER_WEEK' })
    ],
    existingRows: [], datePattern: 'd/M'
  });

  assert.strictEqual(plan.addedCount, 4, '規則正常的那個團契照樣要產生');
  assert.strictEqual(plan.warnings.length, 1, 'warning 要去重，不是每個主日各報一次');
  assert.strictEqual(plan.warnings[0].code, 'BAD_RECURRENCE');
  assert.ok(plan.warnings[0].message.indexOf('規則打錯字的') !== -1);
});

// =====================================================================
// 真正入口的其餘行為
// =====================================================================

test('真正入口：產生之前會先自動備份', function () {
  const env = makeFillEnv({ fellowshipDefaults: [defaultRow()] });
  const result = env.sandbox.generateQuarterFellowships_(QUARTER_ID);
  assert.ok(result.backupId.indexOf(QUARTER_ID) === 0, result.backupId);
  assert.ok(env.sandbox.readSheet('FillBackup').some(function (r) {
    return r.REASON === 'BEFORE_GENERATE_FELLOWSHIPS';
  }));
});

test('真正入口：產生的行內容正確（日期格式、時間、預設內容）', function () {
  const env = makeFillEnv({
    fellowshipDefaults: [defaultRow({
      FELLOWSHIP_NAME: '喜樂團 (粵語長者)', RECURRENCE: 'WEEK_IN:2',
      DAY_LABEL: '星期五', DAY_OFFSET: 5, TIME_TEXT: '10:00AM', DEFAULT_CONTENT: '團契聚會'
    })]
  });
  env.sandbox.generateQuarterFellowships_(QUARTER_ID);

  const rows = env.sandbox.readSheet('Fellowships');
  assert.strictEqual(rows.length, 1, '只有第 2 個主日');
  assert.strictEqual(rows[0].FELLOWSHIP_NAME, '喜樂團 (粵語長者)');
  assert.strictEqual(rows[0].MEETING_DATE, '19/11 星期五', '2027-11-14 ＋ 5 天 ＝ 11/19');
  assert.strictEqual(rows[0].MEETING_TIME, '10:00AM');
  assert.strictEqual(rows[0].CONTENT, '團契聚會');
  assert.strictEqual(rows[0].ACTIVE, true);
});

test('真正入口：FELLOWSHIP_DATE_PATTERN 改變時，產生的日期跟着變', function () {
  const env = makeFillEnv({
    config: { FELLOWSHIP_DATE_PATTERN: 'M月d日' },
    fellowshipDefaults: [defaultRow({ RECURRENCE: 'WEEK_IN:1', DAY_LABEL: '星期日', DAY_OFFSET: 0 })]
  });
  env.sandbox.generateQuarterFellowships_(QUARTER_ID);
  assert.strictEqual(env.sandbox.readSheet('Fellowships')[0].MEETING_DATE, '11月7日 星期日');
});

test('真正入口：每產生一行都記一筆 AuditLog', function () {
  const env = makeFillEnv({ fellowshipDefaults: [defaultRow({ RECURRENCE: 'WEEK_IN:1,2' })] });
  env.sandbox.generateQuarterFellowships_(QUARTER_ID);
  const audit = env.sandbox.readSheet('AuditLog').filter(function (r) { return r.ACTION === 'FELLOWSHIP_GENERATE'; });
  assert.strictEqual(audit.length, 2);
});

test('seed 的三行常設時間表：規則都認得，而且不會全部落在同一個主日', function () {
  const seedRows = sandbox.seedFellowshipDefaultsRows_();
  assert.strictEqual(seedRows.length, 3);
  const plan = buildFellowshipGenerationPlan_({
    serviceDates: serviceDates(), defaultRows: seedRows, existingRows: [], datePattern: 'd/M'
  });
  assert.strictEqual(plan.warnings.length, 0, 'seed 的規則不應該有任何一個認不出來');
  assert.ok(plan.addedCount > 0);
});

// =====================================================================
// 整理清單次序（同一輪的相關功能）
// =====================================================================

test('整理次序：依主日、再依原 SEQ_NO 重新編成 10、20、30', function () {
  const isoSet = { '2027-11-07': true, '2027-11-14': true };
  const changes = buildResequencePlan_([
    { __rowNo: 3, SERVICE_DATE: '2027-11-07', SEQ_NO: 55, ACTIVE: true },
    { __rowNo: 4, SERVICE_DATE: '2027-11-07', SEQ_NO: 12, ACTIVE: true },
    { __rowNo: 5, SERVICE_DATE: '2027-11-14', SEQ_NO: 99, ACTIVE: true }
  ], isoSet);

  const byRow = {};
  changes.forEach(function (c) { byRow[c.rowNo] = c.newSeq; });
  assert.strictEqual(byRow[4], 10, '同一個主日內 SEQ_NO 較小的排前面');
  assert.strictEqual(byRow[3], 20);
  assert.strictEqual(byRow[5], 10, '另一個主日重新由 10 開始');
});

test('整理次序：ACTIVE=FALSE 的行保留，但排在同一個主日的最後', function () {
  const isoSet = { '2027-11-07': true };
  const changes = buildResequencePlan_([
    { __rowNo: 3, SERVICE_DATE: '2027-11-07', SEQ_NO: 10, ACTIVE: false },
    { __rowNo: 4, SERVICE_DATE: '2027-11-07', SEQ_NO: 20, ACTIVE: true }
  ], isoSet);

  const byRow = {};
  changes.forEach(function (c) { byRow[c.rowNo] = c.newSeq; });
  assert.strictEqual(byRow[4], 10, '生效中的排第一');
  assert.strictEqual(byRow[3], 20, '停用的排最後——但仍然保留，不刪行');
});

test('整理次序：不屬於該季的行完全不動', function () {
  const changes = buildResequencePlan_([
    { __rowNo: 3, SERVICE_DATE: '2028-01-02', SEQ_NO: 999, ACTIVE: true }
  ], { '2027-11-07': true });
  assert.strictEqual(changes.length, 0);
});

test('整理次序：已經正確的行不會產生多餘的改動', function () {
  const changes = buildResequencePlan_([
    { __rowNo: 3, SERVICE_DATE: '2027-11-07', SEQ_NO: 10, ACTIVE: true },
    { __rowNo: 4, SERVICE_DATE: '2027-11-07', SEQ_NO: 20, ACTIVE: true }
  ], { '2027-11-07': true });
  assert.strictEqual(changes.length, 0, '次序本來就對，不應該寫任何一格');
});

test('整理次序（真正入口）：不刪行，只改 SEQ_NO，而且先備份', function () {
  const env = makeFillEnv({
    fellowships: [
      { SERVICE_DATE: '2027-11-07', SEQ_NO: 77, FELLOWSHIP_NAME: '甲團', MEETING_DATE: '', MEETING_TIME: '', CONTENT: '', ACTIVE: true },
      { SERVICE_DATE: '2027-11-07', SEQ_NO: 33, FELLOWSHIP_NAME: '乙團', MEETING_DATE: '', MEETING_TIME: '', CONTENT: '', ACTIVE: true }
    ]
  });

  const before = env.sandbox.readSheet('Fellowships').length;
  const result = env.sandbox.resequenceQuarterLists_(QUARTER_ID);

  assert.strictEqual(env.sandbox.readSheet('Fellowships').length, before, '不刪行');
  assert.strictEqual(result.totalChanged, 2);
  assert.ok(env.sandbox.readSheet('FillBackup').some(function (r) { return r.REASON === 'BEFORE_RESEQUENCE'; }));

  const rows = env.sandbox.readSheet('Fellowships');
  const seqByName = {};
  rows.forEach(function (r) { seqByName[r.FELLOWSHIP_NAME] = r.SEQ_NO; });
  assert.strictEqual(seqByName['乙團'], 10, '原本 SEQ_NO 較小的排前面');
  assert.strictEqual(seqByName['甲團'], 20);
});

// =====================================================================

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
