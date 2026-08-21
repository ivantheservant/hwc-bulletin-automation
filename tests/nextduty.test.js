#!/usr/bin/env node
/**
 * tests/nextduty.test.js
 *
 * 下週事奉編號佔位符 `NEXT_DUTY_01`..`NEXT_DUTY_NN` 的回歸測試。
 *
 * 背景：兩個合堂範本的下週事奉有 **12 行**（平常範本 11 行），所以要
 * 確認 `DUTY_PLACEHOLDER_MAX`（預設 20）的邏輯對 `NEXT_DUTY_12` 正常
 * 運作——**超出實際事奉行數的一律輸出空字串，不可以殘留 `{{`**。
 *
 * ⚠️ 為什麼「殘留 {{」是真的會發生的錯：`replaceSimplePlaceholders_()`
 * 對「有提供這個鍵、值是空字串」與「完全沒有提供這個鍵」的處理**不同**
 * ——後者會依 `TEMPLATE_MISSING_VALUE_MODE` 決定要不要原樣保留。所以
 * 1..max 每一個編號都一定要出現在 `values` 內，即使值是空字串。
 *
 * 執行方式：node tests/nextduty.test.js
 * 離開碼：0＝全部通過　1＝有測試失敗
 */

'use strict';

const assert = require('assert');
const { loadAllSrcFilesInOrder } = require('./helpers/loadGas');
const fx = require('./fixtures/docxXml');

const sandbox = loadAllSrcFilesInOrder({
  Utilities: { formatDate: function () { return '2027-11-07 09:00'; } },
  Session: { getScriptTimeZone: function () { return 'Pacific/Auckland'; } },
  SpreadsheetApp: {}, CacheService: {}, HtmlService: {}
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

/** 造 n 行下週事奉（每行 `{label, text}`，已套尊稱與合併規則）。 */
function dutyRows(n) {
  const rows = [];
  for (let i = 1; i <= n; i++) rows.push({ label: '崗位' + i, text: '人員' + i });
  return rows;
}

/** 造一個「下週事奉框」範本：NEXT_DUTY_01..NEXT_DUTY_12 各一段。 */
function nextDutyDocumentXml(count) {
  let inner = '';
  for (let i = 1; i <= count; i++) {
    inner += fx.para(fx.run('{{NEXT_DUTY_' + String(i).padStart(2, '0') + '}}'));
  }
  return fx.documentXml(inner);
}

function visibleText(xml) {
  const out = [];
  const pattern = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g;
  let m;
  while ((m = pattern.exec(xml)) !== null) out.push(m[1]);
  return out.join('｜');
}

// =====================================================================
// 10. 實際 12 行 → NEXT_DUTY_01..12 全部有值
// =====================================================================

test('10. 實際 12 行 → NEXT_DUTY_01..12 全部有值', function () {
  const context = buildRenderContext_({ isoDate: '2027-11-07', nextWeekDuty: dutyRows(12) }, {});
  for (let i = 1; i <= 12; i++) {
    const key = 'NEXT_DUTY_' + String(i).padStart(2, '0');
    assert.strictEqual(context.values[key], '崗位' + i + '：人員' + i, key + ' 應該有值');
  }
});

test('10b. 合堂範本用得到的 NEXT_DUTY_12 真的存在（平常範本只用到 11 行）', function () {
  const context = buildRenderContext_({ isoDate: '2027-11-07', nextWeekDuty: dutyRows(12) }, {});
  assert.ok(Object.prototype.hasOwnProperty.call(context.values, 'NEXT_DUTY_12'),
    'NEXT_DUTY_12 一定要在 values 內，否則合堂範本那一格會殘留 {{');
  assert.strictEqual(context.values.NEXT_DUTY_12, '崗位12：人員12');
});

test('10c. 12 行渲染進範本 → 12 段全部填好，不殘留 {{', function () {
  const context = buildRenderContext_({ isoDate: '2027-11-07', nextWeekDuty: dutyRows(12) }, {});
  const result = renderDocumentXml_(nextDutyDocumentXml(12), {
    values: context.values, lists: {}, missingValueMode: 'BLANK'
  });
  assert.strictEqual(result.xml.indexOf('{{'), -1, '成品不可以殘留任何 {{');
  const text = visibleText(result.xml);
  assert.ok(text.indexOf('崗位12：人員12') !== -1, '第 12 行要填得到：' + text);
});

// =====================================================================
// 11. 實際 9 行 → 10、11、12 為空字串，不殘留 {{
// =====================================================================

test('11. 實際 9 行 → NEXT_DUTY_10／11／12 為空字串（是鍵存在、值為空，不是缺鍵）', function () {
  const context = buildRenderContext_({ isoDate: '2027-11-07', nextWeekDuty: dutyRows(9) }, {});
  ['NEXT_DUTY_10', 'NEXT_DUTY_11', 'NEXT_DUTY_12'].forEach(function (key) {
    assert.ok(Object.prototype.hasOwnProperty.call(context.values, key), key + ' 一定要是 values 的一個鍵');
    assert.strictEqual(context.values[key], '', key + ' 應該是空字串');
  });
  assert.strictEqual(context.values.NEXT_DUTY_09, '崗位9：人員9', '第 9 行仍然要有值');
});

test('11b. 實際 9 行渲染進 12 段範本 → 不殘留 {{，多出來那三段是空白', function () {
  const context = buildRenderContext_({ isoDate: '2027-11-07', nextWeekDuty: dutyRows(9) }, {});
  const result = renderDocumentXml_(nextDutyDocumentXml(12), {
    values: context.values, lists: {}, missingValueMode: 'BLANK'
  });
  assert.strictEqual(result.xml.indexOf('{{'), -1, '成品不可以殘留任何 {{');
  assert.strictEqual(result.stats.missingKeys.length, 0, '不應該有任何「系統沒有提供」的鍵');
});

test('11c. TEMPLATE_MISSING_VALUE_MODE=KEEP 時同樣不殘留 {{（這是最容易出事的模式）', function () {
  // KEEP 模式下，「完全沒有提供的鍵」會被原樣保留。這個測試鎖死
  // 「1..max 每一個編號都有提供」這條承諾——沒有它，合堂範本第 12 行
  // 就會印出一個 {{NEXT_DUTY_12}} 在紙上。
  const context = buildRenderContext_({ isoDate: '2027-11-07', nextWeekDuty: dutyRows(9) }, {});
  const result = renderDocumentXml_(nextDutyDocumentXml(12), {
    values: context.values, lists: {}, missingValueMode: 'KEEP'
  });
  assert.strictEqual(result.xml.indexOf('{{'), -1, 'KEEP 模式下同樣不可以殘留：' + visibleText(result.xml));
});

test('11d. 完全沒有下週事奉（跨季、下一季未生成）→ 12 個編號全部空字串，不拋錯', function () {
  const context = buildRenderContext_({ isoDate: '2027-11-07', nextWeekDuty: [] }, {});
  for (let i = 1; i <= 12; i++) {
    assert.strictEqual(context.values['NEXT_DUTY_' + String(i).padStart(2, '0')], '');
  }
});

// =====================================================================
// 上限本身
// =====================================================================

test('上限 a. DUTY_PLACEHOLDER_MAX 預設 20 → NEXT_DUTY_01..20 全部存在', function () {
  const context = buildRenderContext_({ isoDate: '2027-11-07', nextWeekDuty: dutyRows(12) }, {});
  for (let i = 1; i <= 20; i++) {
    const key = 'NEXT_DUTY_' + String(i).padStart(2, '0');
    assert.ok(Object.prototype.hasOwnProperty.call(context.values, key), key + ' 應該存在');
  }
  assert.ok(!Object.prototype.hasOwnProperty.call(context.values, 'NEXT_DUTY_21'), '不應該多出 21');
});

test('上限 b. 上限可以由 Config 調大（不是寫死 20）', function () {
  const context = buildRenderContext_(
    { isoDate: '2027-11-07', nextWeekDuty: dutyRows(12) },
    { dutyPlaceholderMax: 24 }
  );
  assert.ok(Object.prototype.hasOwnProperty.call(context.values, 'NEXT_DUTY_24'));
  assert.strictEqual(context.values.NEXT_DUTY_24, '');
});

test('上限 c. 實際行數多過上限 → 只輸出到上限為止（不會靜靜多出佔位符）', function () {
  const context = buildRenderContext_(
    { isoDate: '2027-11-07', nextWeekDuty: dutyRows(30) },
    { dutyPlaceholderMax: 12 }
  );
  assert.strictEqual(context.values.NEXT_DUTY_12, '崗位12：人員12');
  assert.ok(!Object.prototype.hasOwnProperty.call(context.values, 'NEXT_DUTY_13'));
});

test('上限 d. buildNumberedDutyValues_ 本身：DUTY_ 與 NEXT_DUTY_ 兩個前綴行為一致', function () {
  const duty = buildNumberedDutyValues_('DUTY_', dutyRows(2), 12);
  const nextDuty = buildNumberedDutyValues_('NEXT_DUTY_', dutyRows(2), 12);
  assert.strictEqual(duty.DUTY_01, '崗位1：人員1');
  assert.strictEqual(nextDuty.NEXT_DUTY_01, '崗位1：人員1');
  assert.strictEqual(duty.DUTY_12, '');
  assert.strictEqual(nextDuty.NEXT_DUTY_12, '');
  assert.strictEqual(Object.keys(duty).length, 12);
  assert.strictEqual(Object.keys(nextDuty).length, 12);
});

// =====================================================================

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
