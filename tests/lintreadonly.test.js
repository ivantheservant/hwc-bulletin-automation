#!/usr/bin/env node
/**
 * tests/lintreadonly.test.js
 *
 * tools/lint-readonly-roster.js 本身的回歸測試：對現時的 src/ 要回傳 0，
 * 對刻意違規的假原始碼要真的捉得到，而且不能因為 Array.prototype.sort()
 * 跟 Range.prototype.sort() 同名就誤判。
 *
 * 執行方式：node tests/lintreadonly.test.js
 * 離開碼：0＝全部通過　1＝有測試失敗
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { lint } = require('../tools/lint-readonly-roster.js');

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

function makeFixtureDir(files) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-readonly-fixture-'));
  Object.keys(files).forEach(function (name) {
    fs.writeFileSync(path.join(tmpDir, name), files[name]);
  });
  return tmpDir;
}

function withFixture(files, fn) {
  const tmpDir = makeFixtureDir(files);
  try {
    fn(tmpDir);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// =====================================================================
// 對現時的 src/ 回傳 0
// =====================================================================

test('lint() 對現時的 src/ 回傳 0 項違規', function () {
  const result = lint();
  assert.deepStrictEqual(
    result.violations, [],
    '目前的 src/ 不應該有職事表唯讀邊界違規，實際捉到：' + JSON.stringify(result.violations, null, 2)
  );
  assert.ok(result.files.indexOf('RosterRead.gs') !== -1, 'src/ 應該有 RosterRead.gs');
});

// =====================================================================
// 規則 1：openById( 只准出現在 RosterRead.gs
// =====================================================================

test('lint() 會捉到 RosterRead.gs 以外出現 openById(', function () {
  withFixture({
    'Other.gs': "'use strict';\nfunction bad_() {\n  return SpreadsheetApp.openById('x');\n}\n"
  }, function (tmpDir) {
    const result = lint(tmpDir);
    const hit = result.violations.filter(function (v) { return v.rule === 'OPEN_BY_ID_OUTSIDE_ALLOWED_FILES'; });
    assert.strictEqual(hit.length, 1);
    assert.strictEqual(hit[0].file, 'Other.gs');
    assert.strictEqual(hit[0].line, 3);
  });
});

test('lint() 不會誤判 RosterRead.gs 自己用 openById(', function () {
  withFixture({
    'RosterRead.gs': "'use strict';\nfunction ok_() {\n  return SpreadsheetApp.openById('x');\n}\n"
  }, function (tmpDir) {
    const result = lint(tmpDir);
    const hit = result.violations.filter(function (v) { return v.rule === 'OPEN_BY_ID_OUTSIDE_ALLOWED_FILES'; });
    assert.deepStrictEqual(hit, []);
  });
});

test('lint() 不會被註解／字串裡提到 openById( 誤導', function () {
  withFixture({
    'Other.gs': [
      "'use strict';",
      '// 這個函式絕對不會呼叫 openById( ——純粹在註解裡提一下。',
      "var NOTE_ = '請不要用 openById( 開別的試算表';",
      'function ok_() { return 1; }',
      ''
    ].join('\n')
  }, function (tmpDir) {
    const result = lint(tmpDir);
    assert.deepStrictEqual(result.violations, []);
  });
});

// =====================================================================
// 規則 2：RosterRead.gs 內不准出現寫入類方法
// =====================================================================

test('lint() 會捉到 RosterRead.gs 內出現明確的寫入方法（setValues）', function () {
  withFixture({
    'RosterRead.gs': [
      "'use strict';",
      'function bad_(sheet) {',
      "  sheet.getRange(1,1).setValues([['x']]);",
      '}',
      ''
    ].join('\n')
  }, function (tmpDir) {
    const result = lint(tmpDir);
    const hit = result.violations.filter(function (v) { return v.rule === 'WRITE_METHOD_IN_ROSTER_READ' && v.message.indexOf('setValues') !== -1; });
    assert.strictEqual(hit.length, 1);
    assert.strictEqual(hit[0].line, 3);
  });
});

test('lint() 不會把 Array.prototype.sort()（比較函式當參數）當成違規', function () {
  withFixture({
    'RosterRead.gs': [
      "'use strict';",
      'function ok_(arr) {',
      '  return arr.slice().sort(function (a, b) { return a - b; });',
      '}',
      'function ok2_(arr) {',
      '  return arr.sort((a, b) => a - b);',
      '}',
      ''
    ].join('\n')
  }, function (tmpDir) {
    const result = lint(tmpDir);
    const hit = result.violations.filter(function (v) { return v.message.indexOf("'sort('") !== -1 || v.message.indexOf('「sort(」') !== -1; });
    assert.deepStrictEqual(hit, [], 'Array.prototype.sort() 不應該被當成違規：' + JSON.stringify(result.violations, null, 2));
  });
});

test('lint() 會捉到看起來像 Range.prototype.sort() 的呼叫（參數不是比較函式）', function () {
  withFixture({
    'RosterRead.gs': [
      "'use strict';",
      'function bad_(range) {',
      '  range.sort(1);',
      '}',
      'function bad2_(range) {',
      '  range.sort([{ column: 2, ascending: true }]);',
      '}',
      ''
    ].join('\n')
  }, function (tmpDir) {
    const result = lint(tmpDir);
    const hit = result.violations.filter(function (v) { return v.rule === 'WRITE_METHOD_IN_ROSTER_READ' && v.message.indexOf('「sort(」') !== -1; });
    assert.strictEqual(hit.length, 2, JSON.stringify(result.violations, null, 2));
  });
});

test('lint() 只在 RosterRead.gs 檢查寫入方法，其他檔案不受這條規則限制', function () {
  withFixture({
    'Other.gs': "'use strict';\nfunction ok_(sheet) {\n  sheet.getRange(1,1).setValue('x');\n}\n"
  }, function (tmpDir) {
    const result = lint(tmpDir);
    const hit = result.violations.filter(function (v) { return v.rule === 'WRITE_METHOD_IN_ROSTER_READ'; });
    assert.deepStrictEqual(hit, []);
  });
});

// =====================================================================
// 規則 3：DriveApp 只准出現在 DocxIo.gs（第七輪起）
// =====================================================================

test('lint() 會捉到 DocxIo.gs 以外的檔案出現 DriveApp', function () {
  withFixture({
    'Other.gs': "'use strict';\nfunction bad_() {\n  return DriveApp.getFileById('x');\n}\n"
  }, function (tmpDir) {
    const result = lint(tmpDir);
    const hit = result.violations.filter(function (v) { return v.rule === 'DRIVE_APP_OUTSIDE_ALLOWED_FILES'; });
    assert.strictEqual(hit.length, 1);
    assert.strictEqual(hit[0].file, 'Other.gs');
    assert.strictEqual(hit[0].line, 3);
  });
});

test('lint() 不會誤判 DocxIo.gs 自己用 DriveApp（第七輪起的唯一例外）', function () {
  withFixture({
    'DocxIo.gs': "'use strict';\nfunction ok_() {\n  return DriveApp.getFileById('x').getBlob();\n}\n"
  }, function (tmpDir) {
    const result = lint(tmpDir);
    const hit = result.violations.filter(function (v) { return v.rule === 'DRIVE_APP_OUTSIDE_ALLOWED_FILES'; });
    assert.deepStrictEqual(hit, []);
  });
});

test('lint() 仍然會捉到 DocxIo.gs 內出現 openById(（規則 1 對它一樣生效）', function () {
  withFixture({
    'DocxIo.gs': "'use strict';\nfunction bad_() {\n  return SpreadsheetApp.openById('x');\n}\n"
  }, function (tmpDir) {
    const result = lint(tmpDir);
    const hit = result.violations.filter(function (v) { return v.rule === 'OPEN_BY_ID_OUTSIDE_ALLOWED_FILES'; });
    assert.strictEqual(hit.length, 1);
    assert.strictEqual(hit[0].file, 'DocxIo.gs');
  });
});

// =====================================================================
// 規則 4：DocxIo.gs 拿不到職事表 ID
// =====================================================================

test('lint() 會捉到 DocxIo.gs 內引用 ROSTER_SPREADSHEET_ID', function () {
  withFixture({
    'DocxIo.gs': [
      "'use strict';",
      'function bad_() {',
      '  var id = getConfig(CONFIG_KEYS.ROSTER_SPREADSHEET_ID, String(1));',
      '  return DriveApp.getFileById(id);',
      '}',
      ''
    ].join('\n')
  }, function (tmpDir) {
    const result = lint(tmpDir);
    const hit = result.violations.filter(function (v) { return v.rule === 'ROSTER_ID_IN_PRIVILEGED_FILE'; });
    assert.strictEqual(hit.length, 1, JSON.stringify(result.violations, null, 2));
    assert.strictEqual(hit[0].line, 3);
  });
});

test('lint() 只在高權限檔案檢查職事表 ID，其他檔案照舊可以引用它', function () {
  withFixture({
    'RosterRead.gs': "'use strict';\nfunction ok_() {\n  return getConfig(CONFIG_KEYS.ROSTER_SPREADSHEET_ID, String(1));\n}\n"
  }, function (tmpDir) {
    const result = lint(tmpDir);
    const hit = result.violations.filter(function (v) { return v.rule === 'ROSTER_ID_IN_PRIVILEGED_FILE'; });
    assert.deepStrictEqual(hit, []);
  });
});

// =====================================================================
// 內容表那一輪：ContentSheetIo.gs 是第二個高權限檔案
// =====================================================================

test('lint() 不會誤判 ContentSheetIo.gs 自己用 openById(（內容表是另一個試算表）', function () {
  withFixture({
    'ContentSheetIo.gs': "'use strict';\nfunction ok_() {\n  return SpreadsheetApp.openById('x');\n}\n"
  }, function (tmpDir) {
    const result = lint(tmpDir);
    assert.deepStrictEqual(result.violations, [], JSON.stringify(result.violations, null, 2));
  });
});

test('lint() 不會誤判 ContentSheetIo.gs 自己用 DriveApp（要建立檔案、設分享權限）', function () {
  withFixture({
    'ContentSheetIo.gs': "'use strict';\nfunction ok_() {\n  return DriveApp.getFolderById('x');\n}\n"
  }, function (tmpDir) {
    const result = lint(tmpDir);
    assert.deepStrictEqual(result.violations, [], JSON.stringify(result.violations, null, 2));
  });
});

test('lint() 會捉到 ContentSheetIo.gs 內引用 ROSTER_SPREADSHEET_ID（它同樣拿不到職事表）', function () {
  // ⚠️ 這條是放寬規則 1／3 之後**唯一**的補償防線：ContentSheetIo.gs 同時
  // 拿得到 DriveApp 與 openById()，兩者都開得到任何檔案。靜態上證明不到
  // 某個執行期變數不是職事表 ID，但證明得到「這個檔案從來拿不到那個設定鍵」。
  withFixture({
    'ContentSheetIo.gs': [
      "'use strict';",
      'function bad_() {',
      '  var id = getConfig(CONFIG_KEYS.ROSTER_SPREADSHEET_ID, String(1));',
      '  return SpreadsheetApp.openById(id);',
      '}',
      ''
    ].join('\n')
  }, function (tmpDir) {
    const result = lint(tmpDir);
    const hit = result.violations.filter(function (v) { return v.rule === 'ROSTER_ID_IN_PRIVILEGED_FILE'; });
    assert.strictEqual(hit.length, 1, JSON.stringify(result.violations, null, 2));
    assert.strictEqual(hit[0].file, 'ContentSheetIo.gs');
  });
});

test('lint() 其他檔案仍然不准用 DriveApp／openById(（放寬只限指定那兩個檔案）', function () {
  withFixture({
    'ContentSheetAdmin.gs': "'use strict';\nfunction bad_() {\n  return DriveApp.getFolderById(SpreadsheetApp.openById('x'));\n}\n"
  }, function (tmpDir) {
    const result = lint(tmpDir);
    const rules = result.violations.map(function (v) { return v.rule; }).sort();
    assert.deepStrictEqual(rules, ['DRIVE_APP_OUTSIDE_ALLOWED_FILES', 'OPEN_BY_ID_OUTSIDE_ALLOWED_FILES']);
  });
});

// =====================================================================

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
