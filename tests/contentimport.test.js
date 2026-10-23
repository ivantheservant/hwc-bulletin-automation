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

// 內容表測試環境與常數抽到共用工具（階段 2 的測試也要用）。
const {
  makeEnv, makeContentTab, baseStubs,
  FAKE_ROSTER_ID, FAKE_FOLDER_ID, FAKE_CONTENT_FILE_ID, QUARTER_ID, SERVICE_DATES
} = require('./helpers/contentEnv');

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
  // R-043／R-045 之後係八張（多咗「崇拜程序」同「浸禮合堂」）。
  assert.strictEqual(result.plan.skippedTabs.length, 8, '八張分頁全部整張空白');

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

// ⚠️ 第一輪自測就是死在這一條上。當時 AuditLog 的證據是：
//      CONTENT_SHEET_IMPORT | Finance | 2027-10-03 | COL_SPECIAL_OVERSEAS
//      舊值 42150 | 新值 42,150
//    內容表存的是文字 '42,150'，寫進 Finance 時被 Sheets 轉成數字 42150，
//    於是每一次匯入都覺得「值不同」而重寫一次，永遠不會停。
//    測試用**真正寫得出這個症狀的值**（帶千分位逗號、帶前導零、純數字的
//    人數），而且跑足三次——只跑兩次的話，「第二次 0 但第三次又有」這種
//    來回震盪的 bug 抓不到。見 docs/已知bug類型.md 事故二十八。
test('15b. 帶千分位的金額連續匯入三次：第二、三次都必須是 0 項改動', function () {
  const env = makeEnv({
    content: {
      財政報告: [
        { SERVICE_DATE: '2027-10-03', SEQ_NO: '10', ROW_LABEL: '特殊海外奉獻',
          COL1: '42,150', COL2: '3,200.50', COL3: '007', COL4: '--', ACTIVE: 'TRUE' },
        { SERVICE_DATE: '2027-10-03', SEQ_NO: '20', ROW_LABEL: '慈惠',
          COL1: '1,000', COL2: '0', COL3: '', COL4: '', ACTIVE: 'TRUE' }
      ],
      團契聚會: [{ SERVICE_DATE: '2027-10-03', SEQ_NO: '10', NAME: '彼得團',
        DATE_TEXT: '10/5', TIME_TEXT: '4:30pm', CONTENT: '查經', ACTIVE: 'TRUE' }],
      崇拜人數: [{ SERVICE_DATE: '2027-10-03', ATT_ENG_WORSHIP: '57',
        ATT_CANE_WORSHIP: '1,024', ATT_CANN_WORSHIP: '前:5 / 後:120', ACTIVE: 'TRUE' }]
    }
  });

  const first = env.sandbox.applyContentImport_(QUARTER_ID, {});
  assert.ok(first.plan.added + first.plan.updated > 0, '第一次一定有改動');

  [2, 3].forEach(function (round) {
    const result = env.sandbox.applyContentImport_(QUARTER_ID, {});
    const plan = result.plan;
    assert.strictEqual(plan.added + plan.updated + plan.removed, 0,
      '第 ' + round + ' 次應該是 0 項改動，實際明細：'
        + JSON.stringify(plan.details.slice(0, 5)));
  });

  // 值本身要真的守得住，不是「差異算不出來」那種假冪等。
  const finance = activeRows(env, 'Finance');
  assert.strictEqual(finance[0].COL_SPECIAL_OVERSEAS, '42,150');
  assert.strictEqual(finance[0].COL_HARDSHIP, '3,200.50');
  assert.strictEqual(finance[0].COL3, '007', '前導零一樣會被 Sheets 轉走');
  // 崇拜人數的日期是**崇拜當日**，對應的週報主日是它 + 7 天。
  const week = env.sandbox.readBulletinWeekRowWithRowNo_('2027-10-10');
  assert.strictEqual(week.ATT_CANE_WORSHIP, '1,024');
  assert.strictEqual(week.ATT_ENG_WORSHIP, '57');
  const fellowship = activeRows(env, 'Fellowships')[0];
  assert.strictEqual(fellowship.MEETING_DATE, '10/5',
    '"10/5" 不設純文字格式的話會變成一個真正的日期');
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
  assert.ok(result.message.indexOf('「季度作業」區塊按「建立／刷新本季內容表」') !== -1, result.message);
  assert.strictEqual(result.message.indexOf('選單'), -1, '整季匯入現時在填寫介面進行，不再指向選單：' + result.message);
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

test('23c. 單週匯入（apiRunContentImport）寫一行 AuditLog 摘要；預覽不寫', function () {
  const env = makeEnv({
    content: { 宣召: [{ SERVICE_DATE: '2027-10-03', CALL_REF: '詩篇', CALL_TEXT: '經文', ACTIVE: 'TRUE' }] }
  });
  const summaries = function () {
    return env.sandbox.readSheet('AuditLog').filter(function (r) { return r.ACTION === 'WEBAPP_CONTENT_IMPORT_WEEK'; });
  };

  env.sandbox.apiPreviewContentImport('2027-10-03');
  assert.strictEqual(summaries().length, 0, '預覽是唯讀，不可以寫摘要');

  const resp = env.sandbox.apiRunContentImport('2027-10-03');
  assert.strictEqual(resp.ok, true);
  assert.strictEqual(resp.data.ok, true);
  const rows = summaries();
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].ROW_KEY, '2027-10-03');
  assert.ok(/^\+\d+ ~\d+ -\d+$/.test(rows[0].NEW_VALUE), rows[0].NEW_VALUE);
  assert.ok(rows[0].NOTES.indexOf('2027T4') !== -1, rows[0].NOTES);
  assertWrittenChinese(assert, 'AuditLog 摘要', rows[0].NOTES);
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
// 單週匯入的範圍：週欄位類分頁（宣召／崇拜人數／崇拜程序）也只動選定的主日
// =====================================================================

function weekOf(env, iso) {
  return env.sandbox.readSheet('BulletinWeeks')
    .filter(function (r) { return env.sandbox.formatIsoDate_(r.SERVICE_DATE) === iso; })[0];
}

test('範圍 1. 宣召：只匯入 10-03 → 10-10 的宣召一格都不可以動；整季匯入才兩週都更新', function () {
  const env = makeEnv({
    weekRows: [
      { SERVICE_DATE: '2027-10-03', QUARTER_ID: QUARTER_ID, CALL_REF: '舊出處甲', CALL_TEXT: '舊經文甲' },
      { SERVICE_DATE: '2027-10-10', QUARTER_ID: QUARTER_ID, CALL_REF: '舊出處乙', CALL_TEXT: '舊經文乙' }
    ],
    content: {
      宣召: [
        { SERVICE_DATE: '2027-10-03', CALL_REF: '新出處甲', CALL_TEXT: '新經文甲', ACTIVE: 'TRUE' },
        { SERVICE_DATE: '2027-10-10', CALL_REF: '新出處乙', CALL_TEXT: '新經文乙', ACTIVE: 'TRUE' }
      ]
    }
  });

  const applied = env.sandbox.applyContentImport_(QUARTER_ID, { isoDate: '2027-10-03' });
  assert.strictEqual(applied.ok, true, JSON.stringify(applied));
  assert.strictEqual(weekOf(env, '2027-10-03').CALL_REF, '新出處甲', '選中的主日要更新');
  assert.strictEqual(weekOf(env, '2027-10-03').CALL_TEXT, '新經文甲');
  assert.strictEqual(weekOf(env, '2027-10-10').CALL_REF, '舊出處乙', '⚠️ 其他主日一格都不可以動');
  assert.strictEqual(weekOf(env, '2027-10-10').CALL_TEXT, '舊經文乙');
  assert.strictEqual(applied.plan.weekUpdates.length, 1);
  assert.strictEqual(applied.plan.updated, 1, '「修改了幾行」只算選定的那一週');
  const audit = env.sandbox.readSheet('AuditLog').filter(function (r) { return r.ACTION === 'CONTENT_IMPORT' || r.SHEET_NAME === 'BulletinWeeks'; });
  audit.forEach(function (r) {
    assert.ok(String(r.ROW_KEY).indexOf('2027-10-10') === -1, '範圍外的主日不可以有 AuditLog：' + r.ROW_KEY);
  });

  const full = env.sandbox.applyContentImport_(QUARTER_ID, {});
  assert.strictEqual(full.plan.weekUpdates.length, 1, '整季匯入把剩下那一週也更新');
  assert.strictEqual(weekOf(env, '2027-10-10').CALL_REF, '新出處乙');
});

test('範圍 2. 崇拜人數：崇拜日期加七天對應的主日不在範圍內 → 不動', function () {
  const env = makeEnv({
    weekRows: [
      { SERVICE_DATE: '2027-10-03', QUARTER_ID: QUARTER_ID, ATT_ENG_WORSHIP: '1' },
      { SERVICE_DATE: '2027-10-10', QUARTER_ID: QUARTER_ID, ATT_ENG_WORSHIP: '2' }
    ],
    content: {
      // 崇拜日期 09-26 → 週報 10-03；崇拜日期 10-03 → 週報 10-10。
      崇拜人數: [
        { SERVICE_DATE: '2027-09-26', ATT_ENG_WORSHIP: '57', ACTIVE: 'TRUE' },
        { SERVICE_DATE: '2027-10-03', ATT_ENG_WORSHIP: '60', ACTIVE: 'TRUE' }
      ]
    }
  });

  env.sandbox.applyContentImport_(QUARTER_ID, { isoDate: '2027-10-10' });
  assert.strictEqual(String(weekOf(env, '2027-10-10').ATT_ENG_WORSHIP), '60', '選中的主日要更新');
  assert.strictEqual(String(weekOf(env, '2027-10-03').ATT_ENG_WORSHIP), '1', '⚠️ 其他主日的人數不可以動');
});

test('範圍 3. 範圍外的主日沒有 BulletinWeeks 那一行 → 不出「沒有這一行」的警告；範圍內才出', function () {
  const env = makeEnv({
    weekRows: [{ SERVICE_DATE: '2027-10-03', QUARTER_ID: QUARTER_ID }],
    content: {
      宣召: [
        { SERVICE_DATE: '2027-10-03', CALL_REF: '甲', CALL_TEXT: '甲', ACTIVE: 'TRUE' },
        { SERVICE_DATE: '2027-10-10', CALL_REF: '乙', CALL_TEXT: '乙', ACTIVE: 'TRUE' }
      ]
    }
  });
  const hasMissingRowWarning = function (plan) {
    // D4：給幹事看的字眼不用工作表英文名（「BulletinWeeks 沒有……」改為「週報試算表未有……」）。
    return plan.warnings.some(function (w) { return w.indexOf('週報試算表未有 2027-10-10 這一個主日') !== -1; });
  };

  const one = env.sandbox.previewContentImport_(QUARTER_ID, { isoDate: '2027-10-03' });
  assert.strictEqual(hasMissingRowWarning(one.plan), false, '10-10 不在這次範圍內，不應該為它警告');

  const quarter = env.sandbox.previewContentImport_(QUARTER_ID, {});
  assert.strictEqual(hasMissingRowWarning(quarter.plan), true, '整季匯入時 10-10 在範圍內，要警告');

  const inScope = env.sandbox.previewContentImport_(QUARTER_ID, { isoDate: '2027-10-10' });
  assert.strictEqual(hasMissingRowWarning(inScope.plan), true, '選中的主日沒有那一行，要警告');
});

test('範圍 4. 單週匯入：預覽與套用的數字一致，預覽不寫任何東西', function () {
  const env = makeEnv({
    weekRows: [
      { SERVICE_DATE: '2027-10-03', QUARTER_ID: QUARTER_ID, CALL_REF: '舊甲' },
      { SERVICE_DATE: '2027-10-10', QUARTER_ID: QUARTER_ID, CALL_REF: '舊乙' }
    ],
    content: {
      宣召: [
        { SERVICE_DATE: '2027-10-03', CALL_REF: '新甲', ACTIVE: 'TRUE' },
        { SERVICE_DATE: '2027-10-10', CALL_REF: '新乙', ACTIVE: 'TRUE' }
      ]
    }
  });
  const preview = env.sandbox.previewContentImport_(QUARTER_ID, { isoDate: '2027-10-03' });
  assert.strictEqual(weekOf(env, '2027-10-03').CALL_REF, '舊甲', '預覽不可以寫');
  assert.strictEqual(preview.plan.updated, 1);
  const applied = env.sandbox.applyContentImport_(QUARTER_ID, { isoDate: '2027-10-03' });
  assert.strictEqual(applied.plan.updated, preview.plan.updated);
  const lines = env.sandbox.buildContentImportDialogLines_(preview, { applied: false }).join('\n');
  assert.ok(lines.indexOf('只匯入選定的一個主日') !== -1);
  assert.ok(lines.indexOf('將會修改 1 行') !== -1, lines);
});

// =====================================================================

// =====================================================================
// 內容表 v2 Commit 5：匯入前核對第 2 行；被試算表轉成日期／時間的格略過
// =====================================================================

console.log('\n內容表 v2：第 2 行核對與日期格');

/** 把某張分頁第 2 行（機器鍵）的第 col 欄（1 起算）改成 value——模擬人手改過或舊版內容表。 */
function setHeaderKey(env, tabName, col, value) {
  env.contentTabs[tabName].__data[1][col - 1] = value;
}

/** 匯入會寫到的一切（比較「一格都沒有寫」）。 */
function importSnapshot(env) {
  const out = {};
  ['BulletinWeeks', 'Announcements', 'Prayers', 'Fellowships', 'Finance', 'AuditLog', 'FieldOverride', 'WeekSnapshots', 'ContentSheets']
    .forEach(function (n) { out[n] = JSON.stringify(env.sandbox.readSheet(n)); });
  return out;
}

function weekOf(env, iso) {
  return env.sandbox.readSheet('BulletinWeeks').filter(function (r) { return env.sandbox.formatIsoDate_(r.SERVICE_DATE) === iso; })[0];
}

const WORSHIP_CONTENT = {
  崇拜程序: [{ SERVICE_DATE: '2027-10-03', SCRIPTURE_REF: '約翰福音 3:16', SERMON_TITLE: '新講題', ACTIVE: 'TRUE' }],
  家事報告: [{ SERVICE_DATE: '2027-10-03', SEQ_NO: '10', TEXT: '新報告', ACTIVE: 'TRUE' }]
};

test('V5-1 compareContentTabHeaderKeys_：完全相同 OK；是前綴 OUTDATED（講缺幾欄）；改名、插欄、中間漏空 HEADER_CHANGED（講第幾欄）', function () {
  const sb = makeEnv({}).sandbox;
  const keys = ['A', 'B', 'C', 'D'];
  const r = function (actual) { return JSON.parse(JSON.stringify(sb.compareContentTabHeaderKeys_(keys, actual))); };
  assert.strictEqual(r(['A', 'B', 'C', 'D']).status, 'OK');
  assert.deepStrictEqual(r(['A', 'B', '', '']), { status: 'OUTDATED', missing: 2, column: 3, expected: 'C', actual: '' });
  assert.deepStrictEqual(r(['A', 'X', 'C', 'D']), { status: 'HEADER_CHANGED', missing: 0, column: 2, expected: 'B', actual: 'X' });
  assert.deepStrictEqual(r(['A', 'C', 'D', '']), { status: 'HEADER_CHANGED', missing: 0, column: 2, expected: 'B', actual: 'C' }, '刪了一欄');
  assert.deepStrictEqual(r(['A', '', 'C', 'D']), { status: 'HEADER_CHANGED', missing: 0, column: 2, expected: 'B', actual: '' }, '中間漏空不算前綴');
  assert.strictEqual(r(['', '', '', '']).status, 'OUTDATED', '整行空白＝第 2 行不見了，一樣拒絕');
});

test('V5-2 「崇拜程序」第 2 行是定義的前綴（舊版、未移轉）→ 單週、整季、選單、預覽四個入口全部整次拒絕，一格都不寫', function () {
  const env = makeEnv({ content: WORSHIP_CONTENT });
  const keys = env.sandbox.contentSheetTabDefs_().filter(function (d) { return d.tabName === '崇拜程序'; })[0].keys;
  setHeaderKey(env, '崇拜程序', keys.length, '');
  setHeaderKey(env, '崇拜程序', keys.length - 1, '');
  const before = importSnapshot(env);
  const contentBefore = JSON.stringify(env.contentTabs['崇拜程序'].__data);

  const week = env.sandbox.apiRunContentImport('2027-10-03');
  assert.strictEqual(week.ok, true, JSON.stringify(week));
  assert.strictEqual(week.data.ok, false);
  assert.strictEqual(week.data.reason, 'CONTENT_SHEET_OUTDATED');
  ['「崇拜程序」少了 2 欄', '整次拒絕，一格都沒有寫', '建立／刷新本季內容表'].forEach(function (piece) {
    assert.ok(week.data.message.indexOf(piece) !== -1, '缺少：' + piece + '\n' + week.data.message);
  });
  const quarter = env.sandbox.apiRunQuarterContentImport(QUARTER_ID);
  assert.strictEqual(quarter.data.ok, false);
  assert.strictEqual(quarter.data.reason, 'CONTENT_SHEET_OUTDATED');
  assert.strictEqual(env.sandbox.apiPreviewContentImport('2027-10-03').data.reason, 'CONTENT_SHEET_OUTDATED');
  env.sandbox.menuImportFromContentSheet_();
  const alert = env.uiAlerts[env.uiAlerts.length - 1];
  assert.strictEqual(alert.title, '未能匯入');
  assert.ok(alert.body.indexOf('建立／刷新本季內容表') !== -1, alert.body);

  assert.deepStrictEqual(importSnapshot(env), before);
  assert.strictEqual(JSON.stringify(env.contentTabs['崇拜程序'].__data), contentBefore, '內容表一格都不寫');
  assertWrittenChinese(assert, '第 2 行拒絕訊息', [week.data.message]);
});

test('V5-3 第 2 行被改過（兩欄對調）→ 整次拒絕，講明哪一張、第幾欄、應該是甚麼', function () {
  const env = makeEnv({ content: WORSHIP_CONTENT });
  setHeaderKey(env, '崇拜程序', 2, 'SERMON_TITLE');
  setHeaderKey(env, '崇拜程序', 3, 'SCRIPTURE_REF');
  const before = importSnapshot(env);
  const resp = env.sandbox.apiRunQuarterContentImport(QUARTER_ID);
  assert.strictEqual(resp.data.reason, 'CONTENT_SHEET_HEADER_CHANGED');
  assert.ok(resp.data.message.indexOf('「崇拜程序」第 2 行（機器鍵）第 2 欄應該是「SCRIPTURE_REF」，現在是「SERMON_TITLE」') !== -1, resp.data.message);
  assert.deepStrictEqual(importSnapshot(env), before);
  assert.strictEqual(weekOf(env, '2027-10-03').SERMON_TITLE, '', '對調了的欄不可以寫進另一欄');
  assertWrittenChinese(assert, '第 2 行被改過', [resp.data.message]);
});

test('V5-4 分頁不存在照舊當作整張空白（不因此拒絕）；第 2 行正確的照常匯入', function () {
  const env = makeEnv({ content: WORSHIP_CONTENT, omitTabs: ['財政報告'] });
  const resp = env.sandbox.apiRunQuarterContentImport(QUARTER_ID);
  assert.strictEqual(resp.data.ok, true, JSON.stringify(resp.data));
  assert.strictEqual(weekOf(env, '2027-10-03').SERMON_TITLE, '新講題');
});

test('V5-5 重設這一週（apiResetWeek）：內容表第 2 行不符 → 整次拒絕，一格都不寫、不存版本、覆寫不停用', function () {
  const env = makeEnv({
    weekRows: [{ SERVICE_DATE: '2027-10-03', QUARTER_ID: QUARTER_ID, SERMON_TITLE: '幹事改的', PRELUDE: '手填序樂' }],
    content: WORSHIP_CONTENT
  });
  env.sandbox.writeSheet('FieldOverride', [{
    SERVICE_DATE: env.sandbox.normalizeDate_('2027-10-03'), FIELD_KEY: 'SERMON_TITLE', OVERRIDE_VALUE: '幹事改的',
    SOURCE_VALUE_AT_OVERRIDE: '', OVERRIDE_AT: new Date(), OVERRIDE_BY: 'x', REASON: '', ACTIVE: true, NOTES: ''
  }]);
  setHeaderKey(env, '崇拜程序', 3, '');
  setHeaderKey(env, '崇拜程序', 4, '');
  setHeaderKey(env, '崇拜程序', 5, '');
  setHeaderKey(env, '崇拜程序', 6, '');
  setHeaderKey(env, '崇拜程序', 7, '');
  const before = importSnapshot(env);
  const resp = env.sandbox.apiResetWeek({ isoDate: '2027-10-03' });
  assert.strictEqual(resp.ok, false);
  assert.strictEqual(resp.error.code, 'CONTENT_SHEET_OUTDATED');
  assert.ok(resp.error.message.indexOf('重設亦整次取消，一格都沒有寫') !== -1, resp.error.message);
  assert.deepStrictEqual(importSnapshot(env), before, '週報、覆寫、版本一格都不可以動');
  assert.strictEqual(weekOf(env, '2027-10-03').PRELUDE, '手填序樂');
  assertWrittenChinese(assert, '重設拒絕訊息', [resp.error.message]);
});

test('V5-6 週欄位類：讀經經文被試算表轉成時間 → 那一格不匯入（週報保留原值），同一行其他欄照常匯入，警告講明', function () {
  const env = makeEnv({
    weekRows: [{ SERVICE_DATE: '2027-10-03', QUARTER_ID: QUARTER_ID, SCRIPTURE_REF: '原有經文', SERMON_TITLE: '舊講題' }],
    content: { 崇拜程序: [{ SERVICE_DATE: '2027-10-03', SCRIPTURE_REF: new Date(1899, 11, 30, 3, 16), SERMON_TITLE: '新講題', ACTIVE: 'TRUE' }] }
  });
  const result = env.sandbox.applyContentImport_(QUARTER_ID, {});
  assert.strictEqual(result.ok, true, JSON.stringify(result));
  const week = weekOf(env, '2027-10-03');
  assert.strictEqual(week.SCRIPTURE_REF, '原有經文', '不可以寫入 String(Date)，亦不可以清空');
  assert.strictEqual(week.SERMON_TITLE, '新講題');
  const warning = result.plan.warnings.filter(function (w) { return w.indexOf('被試算表轉成日期／時間') !== -1; });
  assert.strictEqual(warning.length, 1, JSON.stringify(result.plan.warnings));
  assert.ok(warning[0].indexOf('「崇拜程序」第 3 行「讀經經文」') !== -1 && warning[0].indexOf('週報保留原值') !== -1, warning[0]);
  assertWrittenChinese(assert, '日期格警告', warning);
  assert.ok(env.sandbox.readSheet('BulletinWeeks').every(function (r) { return String(r.SCRIPTURE_REF).indexOf('1899') === -1; }));
});

test('V5-7 清單類：團契「時間」被轉成時間 → 那一行涉及的主日不匯入（既有的行一格不動、不停用），其他主日照常', function () {
  const env = makeEnv({
    content: { 團契聚會: [
      { SERVICE_DATE: '2027-10-03', SEQ_NO: '10', NAME: '彼得團', DATE_TEXT: '3/10', TIME_TEXT: '4:30pm', CONTENT: '舊內容', ACTIVE: 'TRUE' },
      { SERVICE_DATE: '2027-10-10', SEQ_NO: '10', NAME: '約翰團', DATE_TEXT: '10/10', TIME_TEXT: '7:30pm', CONTENT: '舊內容乙', ACTIVE: 'TRUE' }
    ] }
  });
  env.sandbox.applyContentImport_(QUARTER_ID, {});
  const tab = env.contentTabs['團契聚會'].__data;
  tab[2][5] = '新內容';                              // 10-03 那一行的「週會內容」改了
  tab[2][4] = new Date(1899, 11, 30, 16, 30);        // 同一行的「時間」被轉成時間
  tab[3][5] = '新內容乙';                            // 10-10 照常
  const result = env.sandbox.applyContentImport_(QUARTER_ID, {});
  const rows = activeRows(env, 'Fellowships');
  const oct3 = rows.filter(function (r) { return env.sandbox.formatIsoDate_(r.SERVICE_DATE) === '2027-10-03'; });
  assert.strictEqual(oct3.length, 1, '10-03 的行仍然有效（沒有被當成已刪除）');
  assert.strictEqual(oct3[0].CONTENT, '舊內容');
  assert.strictEqual(oct3[0].MEETING_TIME, '4:30pm');
  assert.strictEqual(rows.filter(function (r) { return env.sandbox.formatIsoDate_(r.SERVICE_DATE) === '2027-10-10'; })[0].CONTENT, '新內容乙');
  assert.ok(result.plan.warnings.some(function (w) {
    return w.indexOf('「團契聚會」第 3 行「時間」被試算表轉成日期／時間') !== -1 && w.indexOf('這一行涉及的主日') !== -1;
  }), JSON.stringify(result.plan.warnings));
});

test('V5-8 清單類：「連續到」被轉成日期 → 不知道範圍，整張這一次不匯入（全部既有的行一格不動）', function () {
  const env = makeEnv({ content: { 家事報告: [
    { SERVICE_DATE: '2027-10-03', SEQ_NO: '10', TEXT: '甲', REPEAT_UNTIL: '2027-10-17', ACTIVE: 'TRUE' },
    { SERVICE_DATE: '2027-10-24', SEQ_NO: '10', TEXT: '乙', ACTIVE: 'TRUE' }
  ] } });
  env.sandbox.applyContentImport_(QUARTER_ID, {});
  const before = JSON.stringify(env.sandbox.readSheet('Announcements'));
  const tab = env.contentTabs['家事報告'].__data;
  tab[2][3] = new Date(2027, 9, 10);
  tab[3][2] = '乙改了';
  const result = env.sandbox.applyContentImport_(QUARTER_ID, {});
  assert.strictEqual(JSON.stringify(env.sandbox.readSheet('Announcements')), before);
  assert.ok(result.plan.warnings.some(function (w) { return w.indexOf('整張「家事報告」這一次不匯入') !== -1; }), JSON.stringify(result.plan.warnings));
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
