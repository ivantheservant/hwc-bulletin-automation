#!/usr/bin/env node
/**
 * tests/numbered.test.js
 *
 * prompt9 §1.2 的回歸測試：`DUTY_01`..`DUTY_NN`／`NEXT_DUTY_01`..
 * `NEXT_DUTY_NN` 編號事奉佔位符。
 *
 * 最重要的一條：**超出實際事奉行數的編號一律輸出空字串**，而且要真的
 * 跑一次 `renderDocumentXml_()` 證明產出的 XML 內不會殘留任何 `{{` 字樣
 * ——只檢查 `buildRenderContext_()` 的回傳值不夠，因為就算值提供了，
 * 範本渲染那一層如果哪裡漏接一樣會原樣印出來。
 *
 * 執行方式：node tests/numbered.test.js
 * 離開碼：0＝全部通過　1＝有測試失敗
 */

'use strict';

const assert = require('assert');
const { loadAllSrcFilesInOrder } = require('./helpers/loadGas');

const sandbox = loadAllSrcFilesInOrder({
  Utilities: { formatDate: function () { return ''; } },
  Session: { getScriptTimeZone: function () { return 'Pacific/Auckland'; } },
  SpreadsheetApp: {},
  CacheService: {}
});
const { buildRenderContext_, buildNumberedDutyValues_, renderDocumentXml_ } = sandbox;

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

// ⚠️ 跨 vm realm 的陣列不可以用 assert.deepStrictEqual 比較（結構一樣也
// 會被判定不相等，見 docs/已知bug類型.md）——一律改用 JSON.stringify 比對。
function assertArrayEqual(actual, expected, message) {
  assert.strictEqual(JSON.stringify(actual), JSON.stringify(expected), message);
}

function sampleModel(dutyRows, nextDutyRows) {
  return {
    isoDate: '2027-11-07',
    header: {},
    weekFields: {},
    dutyBoxPage1: dutyRows || [],
    nextWeekDuty: nextDutyRows || [],
    program: [],
    flowers: {},
    prayerBlock: { heading: '', items: [] }
  };
}

// =====================================================================
// 8. DUTY_01..DUTY_20 全部產生，超出行數的為空字串
// =====================================================================

test('8a. buildNumberedDutyValues_()：3 行資料、上限 5 → DUTY_01..03 有值，04..05 是空字串', function () {
  const rows = [{ label: '主席', text: '陳大文弟兄' }, { label: '司事', text: '李小明姊妹' }, { label: '領詩', text: '王美美' }];
  const values = buildNumberedDutyValues_('DUTY_', rows, 5);
  assert.strictEqual(Object.keys(values).length, 5);
  assert.strictEqual(values.DUTY_01, '主席：陳大文弟兄');
  assert.strictEqual(values.DUTY_02, '司事：李小明姊妹');
  assert.strictEqual(values.DUTY_03, '領詩：王美美');
  assert.strictEqual(values.DUTY_04, '');
  assert.strictEqual(values.DUTY_05, '');
});

test('8b. buildRenderContext_()：DUTY_01..DUTY_20（預設上限 20）全部是 values 的鍵，超出的行是空字串', function () {
  const model = sampleModel([{ label: '主席', text: '陳大文弟兄' }]);
  const context = buildRenderContext_(model, {});
  for (let i = 1; i <= 20; i++) {
    const key = 'DUTY_' + (i < 10 ? '0' + i : i);
    assert.ok(Object.prototype.hasOwnProperty.call(context.values, key), '缺少 ' + key);
  }
  assert.strictEqual(context.values.DUTY_01, '主席：陳大文弟兄');
  assert.strictEqual(context.values.DUTY_02, '');
  assert.strictEqual(context.values.DUTY_20, '');
});

test('8c. buildRenderContext_()：NEXT_DUTY_01..NEXT_DUTY_20 同樣提供，取自 nextWeekDuty', function () {
  const model = sampleModel([], [{ label: '主席', text: '王美美' }]);
  const context = buildRenderContext_(model, {});
  assert.strictEqual(context.values.NEXT_DUTY_01, '主席：王美美');
  assert.strictEqual(context.values.NEXT_DUTY_02, '');
  assert.ok(Object.prototype.hasOwnProperty.call(context.values, 'NEXT_DUTY_20'));
});

test('8d. buildRenderContext_()：dutyPlaceholderMax 選項可以改上限（例如 Config 設成 5）', function () {
  const model = sampleModel([{ label: '主席', text: 'A' }]);
  const context = buildRenderContext_(model, { dutyPlaceholderMax: 5 });
  assert.ok(Object.prototype.hasOwnProperty.call(context.values, 'DUTY_05'));
  assert.ok(!Object.prototype.hasOwnProperty.call(context.values, 'DUTY_06'), '上限改成 5 之後不應該再有 DUTY_06');
});

// =====================================================================
// 9. 產出的 XML 內不會殘留任何 {{ 字樣
// =====================================================================

test('9. renderDocumentXml_()：DUTY_01..DUTY_05（上限 5，只有 2 筆資料）渲染之後不殘留任何 {{ 字樣', function () {
  const model = sampleModel([
    { label: '主席', text: '陳大文弟兄' },
    { label: '司事', text: '李小明姊妹' }
  ]);
  const context = buildRenderContext_(model, { dutyPlaceholderMax: 5 });

  const xml = '<w:document><w:body>'
    + '<w:p><w:r><w:t>{{DUTY_01}}</w:t></w:r></w:p>'
    + '<w:p><w:r><w:t>{{DUTY_02}}</w:t></w:r></w:p>'
    + '<w:p><w:r><w:t>{{DUTY_03}}</w:t></w:r></w:p>'
    + '<w:p><w:r><w:t>{{DUTY_04}}</w:t></w:r></w:p>'
    + '<w:p><w:r><w:t>{{DUTY_05}}</w:t></w:r></w:p>'
    + '</w:body></w:document>';

  const result = renderDocumentXml_(xml, { values: context.values, lists: {} });
  assert.strictEqual(result.xml.indexOf('{{'), -1, '渲染之後不可以殘留任何 {{ 字樣：' + result.xml);
  assert.ok(result.xml.indexOf('陳大文弟兄') !== -1);
  assert.ok(result.xml.indexOf('李小明姊妹') !== -1);
  assertArrayEqual(result.stats.missingKeys, [], 'DUTY_03..05 一定要當成「有提供、值是空字串」，不是「找不到值」');
});

// =====================================================================

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
