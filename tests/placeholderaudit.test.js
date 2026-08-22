#!/usr/bin/env node
/**
 * tests/placeholderaudit.test.js
 *
 * 「檢查範本佔位符」對三個 Word 範本的對帳測試（`inspectTemplatePlaceholders_()`）。
 *
 * 三個範本的佔位符構成（Ivan 已改好並上載，本輪不改任何 `.docx`）：
 *   - `TPL_NORMAL`　　　　　　基準
 *   - `TPL_COMBINED_BAPTISM`　基準 ＋ 6 個浸禮副框 ＋ `NEXT_DUTY_12`
 *   - `TPL_ANNIVERSARY`　　　 基準 ＋ `NEXT_DUTY_12` － `DUTY_10`
 *
 * ⚠️ 本檔案**不讀真的 `.docx`**（那些檔案不在 repo 內，而且
 * `.gitignore` 擋住 `*.docx`）。做法是用假 Drive 造三個內容不同的假範本，
 * 內含跟真實範本同一組佔位符，再由真正入口 `inspectTemplatePlaceholders_()`
 * 對帳。真正要鎖死的是**系統有沒有提供那些佔位符**，那一點用假範本測得到。
 *
 * 執行方式：node tests/placeholderaudit.test.js
 * 離開碼：0＝全部通過　1＝有測試失敗
 */

'use strict';

const assert = require('assert');
const { makeFillEnv } = require('./helpers/fillEnv');
const { makeFakeDriveApp, makeFakeUtilities, buildFakeDocx } = require('./helpers/fakeDrive');
const { loadAllSrcFilesInOrder } = require('./helpers/loadGas');
const fx = require('./fixtures/docxXml');

const FAKE_TEMPLATE_NORMAL = 'FAKE_TPL_NORMAL';
const FAKE_TEMPLATE_BAPTISM = 'FAKE_TPL_COMBINED_BAPTISM';
const FAKE_TEMPLATE_ANNIVERSARY = 'FAKE_TPL_ANNIVERSARY';

/** 只用來查「系統提供哪些佔位符」的純 sandbox（不需要任何假工作表）。 */
const pureSandbox = loadAllSrcFilesInOrder({
  Utilities: { formatDate: function () { return '2027-11-07 09:00'; } },
  Session: { getScriptTimeZone: function () { return 'Pacific/Auckland'; } },
  SpreadsheetApp: {}, CacheService: {}, HtmlService: {}
});

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

/**
 * 這一輪之前「系統未必提供」的那幾個佔位符——prompt 逐個點名列出來的。
 * 這份清單刻意**寫死**在測試內，不是由系統自己的清單推導出來：由系統
 * 推導的話，系統漏了哪一個，測試就會跟着漏，等於冇測過。
 */
const NEWLY_REQUIRED_VALUE_KEYS = [
  // 三個範本共通
  'FINANCE_PERIOD_LABEL',
  'NEXT_DUTY_12',
  // 浸禮範本獨有
  'BAPTISM_OFFICIANT', 'BAPTISM_MEMBERS',
  'MEMBERSHIP_OFFICIANT', 'MEMBERSHIP_MEMBERS',
  'CHILD_DEDICATION_OFFICIANT', 'CHILD_DEDICATION_CHILDREN'
];

/** 浸禮副框六個機器鍵（由單一真相來源取，用來組範本內容）。 */
const BAPTISM_KEYS = pureSandbox.baptismBoxFieldKeys_();

/**
 * 用途：造一個假範本的 `word/document.xml`——把指定的單值佔位符各放一段，
 *   再把系統提供的七個清單各放一個列範本。
 * Args:
 *   valueKeys {string[]} 這個範本要用到的單值佔位符名稱。
 * Returns:
 *   {string}
 */
function templateXmlFor(valueKeys) {
  const paragraphs = valueKeys.map(function (k) { return fx.para(fx.run('{{' + k + '}}')); }).join('');

  const listTables = pureSandbox.supportedListPlaceholders_().map(function (entry) {
    const firstField = entry.fields[0];
    const rest = entry.fields.slice(1);
    return fx.table([fx.row(
      [fx.cell(fx.para(fx.run('{{#EACH:' + entry.list + '}}{{' + entry.list + '.' + firstField + '}}')))]
        .concat(rest.map(function (f) { return fx.cell(fx.para(fx.run('{{' + entry.list + '.' + f + '}}'))); }))
    )]);
  }).join('');

  return fx.documentXml(paragraphs + listTables);
}

/** 系統提供的全部單值佔位符（三個範本的「基準」由此扣減）。 */
function allSupportedValueKeys() {
  return pureSandbox.supportedValuePlaceholderNames_();
}

function without(keys, remove) {
  return keys.filter(function (k) { return remove.indexOf(k) === -1; });
}

/**
 * 用途：造一個三個範本都已設定的測試環境。
 * Args:
 *   overrides {{normalXml:string=, baptismXml:string=, anniversaryXml:string=}=}
 * Returns:
 *   {{sandbox:Object}}
 */
function makeAuditEnv(overrides) {
  const o = overrides || {};
  const baseKeys = allSupportedValueKeys();

  const normalXml = o.normalXml || templateXmlFor(
    // 平常範本：沒有浸禮副框，下週事奉只有 11 行（沒有 NEXT_DUTY_12）。
    without(baseKeys, BAPTISM_KEYS.concat(['NEXT_DUTY_12']))
  );
  const baptismXml = o.baptismXml || templateXmlFor(
    // 浸禮範本：六個副框欄位齊全，下週事奉 12 行。
    baseKeys
  );
  const anniversaryXml = o.anniversaryXml || templateXmlFor(
    // 堂慶範本：沒有浸禮副框、沒有 DUTY_10，下週事奉 12 行。
    without(baseKeys, BAPTISM_KEYS.concat(['DUTY_10']))
  );

  const drive = makeFakeDriveApp({
    files: {
      [FAKE_TEMPLATE_NORMAL]: buildFakeDocx(normalXml),
      [FAKE_TEMPLATE_BAPTISM]: buildFakeDocx(baptismXml),
      [FAKE_TEMPLATE_ANNIVERSARY]: buildFakeDocx(anniversaryXml)
    },
    folders: {}
  });

  return makeFillEnv({
    withGrid: false,
    config: {
      TEMPLATE_FILE_ID_NORMAL: FAKE_TEMPLATE_NORMAL,
      TEMPLATE_FILE_ID_COMBINED_BAPTISM: FAKE_TEMPLATE_BAPTISM,
      TEMPLATE_FILE_ID_ANNIVERSARY: FAKE_TEMPLATE_ANNIVERSARY
    },
    driveApp: drive.DriveApp,
    driveAdvanced: drive.Drive,
    utilitiesZip: makeFakeUtilities()
  });
}

function templateEntry(report, configKey) {
  return report.templates.filter(function (t) { return t.configKey === configKey; })[0];
}

// =====================================================================
// 12. 三個範本各自對帳，「範本用到但系統不提供」為 0
// =====================================================================

test('12. 三個範本各自對帳，「範本用到但系統不提供」全部為 0', function () {
  const env = makeAuditEnv();
  const report = env.sandbox.inspectTemplatePlaceholders_();

  report.templates.forEach(function (t) {
    assert.strictEqual(t.configured, true, t.label + ' 應該已設定');
    assert.strictEqual(t.error, '', t.label + ' 讀取失敗：' + t.error);
    assertArrayEqual(t.unknownValues, [], t.label + '：範本用到但系統不提供的單值佔位符');
    assertArrayEqual(t.unknownLists, [], t.label + '：範本用到但系統不提供的清單');
  });
});

test('12b. 三個範本各自一段，不會混在一起', function () {
  const env = makeAuditEnv();
  const report = env.sandbox.inspectTemplatePlaceholders_();

  assert.strictEqual(report.templates.length, 3);
  assertArrayEqual(
    report.templates.map(function (t) { return t.configKey; }),
    ['TEMPLATE_FILE_ID_NORMAL', 'TEMPLATE_FILE_ID_COMBINED_BAPTISM', 'TEMPLATE_FILE_ID_ANNIVERSARY']
  );

  // 三個範本的 label 各自不同，報告才分得開。
  const labels = report.templates.map(function (t) { return t.label; });
  assert.strictEqual(new Set(labels).size, 3, '三個範本的名稱不可以重複：' + labels.join('、'));
});

test('12c. 這一輪新增的 8 個佔位符，系統全部都有提供', function () {
  const supported = allSupportedValueKeys();
  const missing = NEWLY_REQUIRED_VALUE_KEYS.filter(function (k) { return supported.indexOf(k) === -1; });
  assertArrayEqual(missing, [], '這些佔位符範本用到，但系統沒有提供');
});

test('12d. 浸禮範本用到六個副框佔位符，而且對帳認得（不在 unknownValues 內）', function () {
  const env = makeAuditEnv();
  const report = env.sandbox.inspectTemplatePlaceholders_();
  const baptism = templateEntry(report, 'TEMPLATE_FILE_ID_COMBINED_BAPTISM');

  BAPTISM_KEYS.forEach(function (key) {
    assert.ok(baptism.usedValues.indexOf(key) !== -1, '浸禮範本應該用到 ' + key);
    assert.strictEqual(baptism.unknownValues.indexOf(key), -1, key + ' 不可以被報成「系統不提供」');
  });
});

test('12e. 平常／堂慶範本沒有用到六個副框佔位符 → 只出現在「系統提供但範本沒有用到」，不是錯', function () {
  const env = makeAuditEnv();
  const report = env.sandbox.inspectTemplatePlaceholders_();

  ['TEMPLATE_FILE_ID_NORMAL', 'TEMPLATE_FILE_ID_ANNIVERSARY'].forEach(function (configKey) {
    const entry = templateEntry(report, configKey);
    BAPTISM_KEYS.forEach(function (key) {
      assert.strictEqual(entry.usedValues.indexOf(key), -1, configKey + ' 不應該用到 ' + key);
      assert.ok(entry.unusedValues.indexOf(key) !== -1,
        key + ' 應該出現在 ' + configKey + ' 的「系統提供但範本沒有用到」');
      assert.strictEqual(entry.unknownValues.indexOf(key), -1, '沒有用到不算錯，不可以進 unknownValues');
    });
  });
});

test('12f. 平常範本沒有 NEXT_DUTY_12、堂慶範本沒有 DUTY_10 → 都只是「沒有用到」，不是錯', function () {
  const env = makeAuditEnv();
  const report = env.sandbox.inspectTemplatePlaceholders_();

  const normal = templateEntry(report, 'TEMPLATE_FILE_ID_NORMAL');
  assert.ok(normal.unusedValues.indexOf('NEXT_DUTY_12') !== -1, '平常範本只有 11 行下週事奉');
  assertArrayEqual(normal.unknownValues, []);

  const anniversary = templateEntry(report, 'TEMPLATE_FILE_ID_ANNIVERSARY');
  assert.ok(anniversary.usedValues.indexOf('NEXT_DUTY_12') !== -1, '堂慶範本有 12 行下週事奉');
  assert.ok(anniversary.unusedValues.indexOf('DUTY_10') !== -1, '堂慶範本少一行第 1 頁事奉');
  assertArrayEqual(anniversary.unknownValues, []);
});

test('12g. FINANCE_PERIOD_LABEL 三個範本都用到，三個都對得上', function () {
  const env = makeAuditEnv();
  const report = env.sandbox.inspectTemplatePlaceholders_();
  report.templates.forEach(function (t) {
    assert.ok(t.usedValues.indexOf('FINANCE_PERIOD_LABEL') !== -1, t.label + ' 應該用到 FINANCE_PERIOD_LABEL');
    assert.strictEqual(t.unknownValues.indexOf('FINANCE_PERIOD_LABEL'), -1);
  });
});

test('12h. 反向鎖：範本真的打錯字時，對帳一定要抓得出來（證明上面幾個測試不是空跑）', function () {
  const typoXml = fx.documentXml(
    fx.para(fx.run('{{SERMON_TITLE}}')) + fx.para(fx.run('{{BAPTISM_OFFICIENT}}'))
  );
  const env = makeAuditEnv({ baptismXml: typoXml });
  const report = env.sandbox.inspectTemplatePlaceholders_();
  const baptism = templateEntry(report, 'TEMPLATE_FILE_ID_COMBINED_BAPTISM');

  assert.ok(baptism.unknownValues.indexOf('BAPTISM_OFFICIENT') !== -1,
    '打錯字的佔位符一定要被抓出來：' + JSON.stringify(baptism.unknownValues));
});

test('12i. 七個清單三個範本都用得到，沒有一個被報成「系統不提供」', function () {
  const env = makeAuditEnv();
  const report = env.sandbox.inspectTemplatePlaceholders_();
  const listNames = pureSandbox.supportedListPlaceholders_().map(function (l) { return l.list; });

  report.templates.forEach(function (t) {
    listNames.forEach(function (name) {
      assert.ok(t.usedLists.indexOf(name) !== -1, t.label + ' 應該用到清單 ' + name);
    });
    assertArrayEqual(t.unknownLists, [], t.label + ' 不應該有認不出的清單');
  });
});

test('12j. 對帳報告排版：三個範本各自一個「【範本：…】」區段', function () {
  const env = makeAuditEnv();
  const report = env.sandbox.inspectTemplatePlaceholders_();
  const lines = env.sandbox.buildTemplateInspectionLines_(report);
  const headings = lines.filter(function (l) { return l.indexOf('【範本：') === 0; });
  assert.strictEqual(headings.length, 3, '三個範本要各自一段：' + JSON.stringify(headings));
});

// =====================================================================

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
