#!/usr/bin/env node
/**
 * tests/emailtemplate.test.js
 *
 * src/BulletinEmail.gs 的 renderEmailTemplate_() 回歸測試。
 *
 * 1. 全部佔位符正確替換
 * 2. 未知佔位符原樣保留且有 warning
 * 3. {{ChurchName}} 取自 Config，未設定時有 warning
 *
 * 執行方式：node tests/emailtemplate.test.js
 * 離開碼：0＝全部通過　1＝有測試失敗
 */

'use strict';

const assert = require('assert');
const { loadAllSrcFilesInOrder } = require('./helpers/loadGas');
const { makeFakeSheet, makeFakeSpreadsheet } = require('./helpers/fakeSpreadsheet');

const GAS_STUBS = {
  Utilities: { formatDate: function () { return ''; } },
  Session: {
    getScriptTimeZone: function () { return 'Pacific/Auckland'; },
    getActiveUser: function () { return { getEmail: function () { return ''; } }; }
  },
  SpreadsheetApp: {},
  CacheService: {}
};

const sandbox = loadAllSrcFilesInOrder(GAS_STUBS);
const { renderEmailTemplate_ } = sandbox;

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
// 1. 全部佔位符正確替換
// =====================================================================

test('renderEmailTemplate_：全部已知佔位符都正確替換', function () {
  const tpl = '{{ChurchName}}週報 — {{ServiceDate}}（{{SpecialType}}）待填 {{MissingCount}} 項，版本 {{RosterVersion}}';
  const warnings = [];
  const result = renderEmailTemplate_(tpl, {
    ChurchName: '某某堂', ServiceDate: '2027-10-03', SpecialType: '浸禮主日',
    MissingCount: '3', RosterVersion: '10'
  }, warnings);
  assert.strictEqual(result, '某某堂週報 — 2027-10-03（浸禮主日）待填 3 項，版本 10');
  assert.strictEqual(warnings.length, 0);
});

test('renderEmailTemplate_：同一個佔位符出現多次都會被替換', function () {
  const result = renderEmailTemplate_('{{ServiceDate}} 到 {{ServiceDate}}', { ServiceDate: '2027-10-03' }, []);
  assert.strictEqual(result, '2027-10-03 到 2027-10-03');
});

test('renderEmailTemplate_：值是 null／undefined 時換成空字串，不是字面上的 "null"', function () {
  const result = renderEmailTemplate_('特別主日：{{SpecialType}}', { SpecialType: null }, []);
  assert.strictEqual(result, '特別主日：');
});

// =====================================================================
// 2. 未知佔位符原樣保留且有 warning
// =====================================================================

test('renderEmailTemplate_：未知佔位符原樣保留，不會變成空字串', function () {
  const warnings = [];
  const result = renderEmailTemplate_('{{ChurchName}} {{ChurhName}}', { ChurchName: '某某堂' }, warnings);
  assert.strictEqual(result, '某某堂 {{ChurhName}}', '打錯字的佔位符要原樣保留，才看得出來打錯字');
  assert.strictEqual(warnings.length, 1);
  assert.strictEqual(warnings[0].code, 'UNKNOWN_PLACEHOLDER');
  assert.ok(warnings[0].message.indexOf('ChurhName') !== -1);
});

test('renderEmailTemplate_：vars 內有值但範本沒有用到 → 不是錯誤（不會多出 warning）', function () {
  const warnings = [];
  renderEmailTemplate_('{{ServiceDate}}', { ServiceDate: '2027-10-03', RosterVersion: '10', MissingCount: '0' }, warnings);
  assert.strictEqual(warnings.length, 0);
});

test('renderEmailTemplate_：沒有提供 warningsOut 也不會拋錯（選填）', function () {
  assert.doesNotThrow(function () {
    renderEmailTemplate_('{{UnknownKey}}', {});
  });
});

// =====================================================================
// 3. {{ChurchName}} 取自 Config，未設定時有 warning
// =====================================================================

function makeEnv(configOverrides) {
  const freshSandbox = loadAllSrcFilesInOrder(GAS_STUBS);
  const base = freshSandbox.DEFAULTS.map(function (d) { return { KEY: d.key, VALUE: d.value, NOTE: '', EDITABLE: true }; });
  const overridden = base.map(function (row) {
    if (configOverrides && Object.prototype.hasOwnProperty.call(configOverrides, row.KEY)) {
      return Object.assign({}, row, { VALUE: configOverrides[row.KEY] });
    }
    return row;
  });
  const sheets = { Config: makeFakeSheet(freshSandbox.COLUMNS.CONFIG.headers, freshSandbox.COLUMNS.CONFIG.keys, overridden) };
  const FakeApp = { getActiveSpreadsheet: function () { return makeFakeSpreadsheet(sheets); } };
  return loadAllSrcFilesInOrder(Object.assign({}, GAS_STUBS, { SpreadsheetApp: FakeApp }));
}

test('真正入口：CHURCH_NAME 的 DEFAULTS 已經是非空字串（本輪修補的必要設定）', function () {
  const sb = makeEnv();
  assert.notStrictEqual(sb.getConfig(sb.CONFIG_KEYS.CHURCH_NAME, ''), '', 'CHURCH_NAME 不應該還是空字串');
});

test('{{ChurchName}} 取自 Config：設定值會正確替換進範本', function () {
  const sb = makeEnv();
  const churchName = sb.getConfig(sb.CONFIG_KEYS.CHURCH_NAME, '');
  const result = sb.renderEmailTemplate_('{{ChurchName}}週報', { ChurchName: churchName }, []);
  assert.strictEqual(result, churchName + '週報');
});

test('{{ChurchName}} 未設定（Config 值是空字串）時，渲染結果是空字串，且**不會**因為值是空字串而誤判成未知佔位符', function () {
  const sb = makeEnv({ CHURCH_NAME: '' });
  const churchName = sb.getConfig(sb.CONFIG_KEYS.CHURCH_NAME, '');
  assert.strictEqual(churchName, '');
  const warnings = [];
  const result = sb.renderEmailTemplate_('{{ChurchName}}週報', { ChurchName: churchName }, warnings);
  assert.strictEqual(result, '週報', '未設定時渲染成空字串（這是舊事故：一直沒有對應設定值）');
  assert.strictEqual(warnings.length, 0, 'ChurchName 是已知佔位符，值為空不算未知佔位符');
});

test('checkChurchNameConfigured_：CHURCH_NAME 未設定（空字串／只有空白）時回一筆 warning，讓「忘記填」講出來', function () {
  const sb = makeEnv();
  const warning = sb.checkChurchNameConfigured_('');
  assert.ok(warning, '應該回一筆 warning 物件');
  assert.strictEqual(warning.code, 'CHURCH_NAME_NOT_CONFIGURED');

  const warningForWhitespace = sb.checkChurchNameConfigured_('   ');
  assert.ok(warningForWhitespace, '只有空白字元也算未設定');
});

test('checkChurchNameConfigured_：CHURCH_NAME 有值時回 null（沒有 warning）', function () {
  const sb = makeEnv();
  assert.strictEqual(sb.checkChurchNameConfigured_('某某堂'), null);
});

// =====================================================================

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
