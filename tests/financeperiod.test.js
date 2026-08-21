#!/usr/bin/env node
/**
 * tests/financeperiod.test.js
 *
 * `{{FINANCE_PERIOD_LABEL}}`（財政表首欄期別標籤）的回歸測試。
 *
 * 這個佔位符原本在範本內硬寫「11月份」——即是不論哪一期都印同一個月。
 * 現已改為佔位符，由 Config `FINANCE_PERIOD_LABEL_PATTERN` 產生。
 *
 * ⚠️ 本檔案最重要的一個測試是「月份計算只有一個來源」：
 * `{{FINANCE_TITLE}}` 與 `{{FINANCE_PERIOD_LABEL}}` 一定要經過**同一個**
 * `financeReportPreviousMonth_()`。兩邊各自算一次就是同一個狀態有兩個
 * 真相來源（docs/已知bug類型.md 第 3 類），標題印「10月份」而首欄印
 * 「11月份」這種錯要到印出來才會發現。
 *
 * 執行方式：node tests/financeperiod.test.js
 * 離開碼：0＝全部通過　1＝有測試失敗
 */

'use strict';

const assert = require('assert');
const { loadAllSrcFilesInOrder } = require('./helpers/loadGas');

const GAS_STUBS = {
  Utilities: { formatDate: function () { return '2027-11-07 09:00'; } },
  Session: { getScriptTimeZone: function () { return 'Pacific/Auckland'; } },
  SpreadsheetApp: {}, CacheService: {}, HtmlService: {}
};

const sandbox = loadAllSrcFilesInOrder(GAS_STUBS);
const {
  buildFinancePeriodLabel_, buildFinanceTitle_, applyFinanceMonthPattern_,
  financeReportPreviousMonth_, buildRenderContext_,
  FINANCE_TITLE_PATTERN_DEFAULT_, FINANCE_PERIOD_LABEL_PATTERN_DEFAULT_
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

/** 取一次 buildRenderContext_() 的 values，只填 isoDate 與兩個樣式。 */
function valuesFor(isoDate, options) {
  return buildRenderContext_({ isoDate: isoDate }, options || {}).values;
}

// =====================================================================
// 7. FINANCE_PERIOD_LABEL 與 FINANCE_TITLE 的月份一致
// =====================================================================

test('7. 一般情況：兩者的月份一致（2027-11-07 的主日 → 10 月）', function () {
  const values = valuesFor('2027-11-07');
  assert.strictEqual(values.FINANCE_PERIOD_LABEL, '10月份');
  assert.ok(values.FINANCE_TITLE.indexOf('2027年 10月份') !== -1, values.FINANCE_TITLE);
});

test('7b. 跨年：1 月的主日 → 上年 12 月，兩者一致', function () {
  const values = valuesFor('2027-01-03');
  assert.strictEqual(values.FINANCE_PERIOD_LABEL, '12月份');
  assert.strictEqual(values.FINANCE_TITLE, '聖道堂綜合收支財務報告-2026年 12月份');
});

test('7c. 跨年：12 月的主日 → 同年 11 月（不會誤跨年）', function () {
  const values = valuesFor('2027-12-05');
  assert.strictEqual(values.FINANCE_PERIOD_LABEL, '11月份');
  assert.ok(values.FINANCE_TITLE.indexOf('2027年 11月份') !== -1, values.FINANCE_TITLE);
});

test('7d. 逐月掃一次全年：兩者的月份數字永遠一樣', function () {
  for (let month = 1; month <= 12; month++) {
    const iso = '2027-' + String(month).padStart(2, '0') + '-07';
    const values = valuesFor(iso, {
      financeTitlePattern: '{{YEAR}}/{{MONTH}}',
      financePeriodLabelPattern: '{{YEAR}}/{{MONTH}}'
    });
    assert.strictEqual(
      values.FINANCE_PERIOD_LABEL, values.FINANCE_TITLE,
      iso + ' 兩者應該完全一樣，實際：' + values.FINANCE_PERIOD_LABEL + ' vs ' + values.FINANCE_TITLE
    );
  }
});

test('7e. isoDate 格式不對（空模型）→ 兩者都是空字串，不拋錯', function () {
  const values = buildRenderContext_({}, {}).values;
  assert.strictEqual(values.FINANCE_PERIOD_LABEL, '');
  assert.strictEqual(values.FINANCE_TITLE, '');
});

// =====================================================================
// 8. 樣式可以由 Config 改
// =====================================================================

test('8. FINANCE_PERIOD_LABEL_PATTERN 改成別的樣式 → 輸出跟着變', function () {
  const values = valuesFor('2027-11-07', { financePeriodLabelPattern: '{{YEAR}} 年 {{MONTH}} 月結算' });
  assert.strictEqual(values.FINANCE_PERIOD_LABEL, '2027 年 10 月結算');
});

test('8b. 樣式內沒有任何符記 → 原樣輸出（例如硬寫一句固定文字）', function () {
  const values = valuesFor('2027-11-07', { financePeriodLabelPattern: '上月收支' });
  assert.strictEqual(values.FINANCE_PERIOD_LABEL, '上月收支');
});

test('8c. 同一個符記出現多次 → 每一個都會被換掉', function () {
  assert.strictEqual(buildFinancePeriodLabel_('{{MONTH}}／{{MONTH}}月', '2027-11-07'), '10／10月');
});

test('8d. 預設值：Config 沒有另外設定時用 {{MONTH}}月份', function () {
  assert.strictEqual(FINANCE_PERIOD_LABEL_PATTERN_DEFAULT_, '{{MONTH}}月份');
  assert.strictEqual(valuesFor('2027-11-07').FINANCE_PERIOD_LABEL, '10月份');
});

test('8e. 月份不補零（10 月是「10」，1 月是「1」不是「01」）', function () {
  assert.strictEqual(buildFinancePeriodLabel_('{{MONTH}}', '2027-03-07'), '2');
  assert.strictEqual(buildFinancePeriodLabel_('{{MONTH}}', '2027-11-07'), '10');
});

// =====================================================================
// 9. 月份計算只有一個來源
// =====================================================================

test('9. 兩個佔位符都經過同一個 applyFinanceMonthPattern_()', function () {
  // buildFinanceTitle_ 與 buildFinancePeriodLabel_ 只是 applyFinanceMonthPattern_
  // 的兩個具名入口——同一個樣式字串餵進三者，結果必須完全一樣。
  const pattern = '{{YEAR}}-{{MONTH}}';
  const iso = '2027-01-03';
  const viaShared = applyFinanceMonthPattern_(pattern, iso);
  assert.strictEqual(buildFinanceTitle_(pattern, iso), viaShared);
  assert.strictEqual(buildFinancePeriodLabel_(pattern, iso), viaShared);
  assert.strictEqual(viaShared, '2026-12');
});

test('9b. 換掉 financeReportPreviousMonth_ → 兩個佔位符**一齊**跟着變（證明只有一個來源）', function () {
  // 這是「單一真相來源」最直接的證明：把唯一那個月份計算函式換成一個
  // 明顯不同的假實作，如果哪一邊沒有跟着變，就代表它自己另外算了一次。
  const isolated = loadAllSrcFilesInOrder(GAS_STUBS);
  isolated.financeReportPreviousMonth_ = function () { return { year: 1999, month: 7 }; };

  const values = isolated.buildRenderContext_({ isoDate: '2027-11-07' }, {}).values;
  assert.strictEqual(values.FINANCE_PERIOD_LABEL, '7月份', 'FINANCE_PERIOD_LABEL 沒有跟着變');
  assert.ok(values.FINANCE_TITLE.indexOf('1999年 7月份') !== -1,
    'FINANCE_TITLE 沒有跟着變：' + values.FINANCE_TITLE);
});

test('9c. financeReportPreviousMonth_ 本身：跨年與一般情況', function () {
  assert.strictEqual(JSON.stringify(financeReportPreviousMonth_('2027-01-03')), JSON.stringify({ year: 2026, month: 12 }));
  assert.strictEqual(JSON.stringify(financeReportPreviousMonth_('2027-11-07')), JSON.stringify({ year: 2027, month: 10 }));
  assert.strictEqual(financeReportPreviousMonth_('唔係日期'), null);
});

test('9d. 兩個預設樣式都用同一組符記名（{{YEAR}}／{{MONTH}}）', function () {
  [FINANCE_TITLE_PATTERN_DEFAULT_, FINANCE_PERIOD_LABEL_PATTERN_DEFAULT_].forEach(function (p) {
    assert.ok(p.indexOf('{{MONTH}}') !== -1, p + ' 應該用得到 {{MONTH}}');
  });
  assert.ok(FINANCE_TITLE_PATTERN_DEFAULT_.indexOf('{{YEAR}}') !== -1);
});

// =====================================================================

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
