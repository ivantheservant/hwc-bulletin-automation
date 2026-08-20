#!/usr/bin/env node
/**
 * tests/loadorder.test.js
 *
 * 針對「跨檔案的頂層初始化式依賴 .gs 檔案載入次序」這個 bug class 的
 * 回歸測試（見 docs/已知bug類型.md）。涵蓋兩道防線：
 *   1. tools/lint-load-order.js 這個靜態檢查工具本身——對現時的 src/
 *      要回傳 0 項違規，而且對一段刻意違規的假原始碼要真的捉得到。
 *   2. tests/helpers/loadGas.js 的 loadAllSrcFilesInOrder()——按 Apps
 *      Script 實際次序（檔名字母序）把全部 src/*.gs 載入同一個 context
 *      之後，跨檔案的常數（POSTURE／CONDITION_TYPE／APP_NAME）與函式
 *      （seedProgramTemplatesRows_()）要真的可以正常運作。
 *
 * 執行方式：node tests/loadorder.test.js
 * 離開碼：0＝全部通過　1＝有測試失敗
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { lint } = require('../tools/lint-load-order.js');
const { loadAllSrcFilesInOrder } = require('./helpers/loadGas');

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

/** 建一個暫存目錄，寫入假的 .gs 檔案，回傳目錄路徑；用完要自己刪。 */
function makeFixtureDir(files) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-load-order-fixture-'));
  Object.keys(files).forEach(function (name) {
    fs.writeFileSync(path.join(tmpDir, name), files[name]);
  });
  return tmpDir;
}

// =====================================================================
// 1. tools/lint-load-order.js 本身
// =====================================================================

test('lint() 對現時的 src/ 回傳 0 項違規', function () {
  const result = lint();
  assert.deepStrictEqual(
    result.violations, [],
    '目前的 src/ 不應該有跨檔案載入次序問題，實際捉到：' + JSON.stringify(result.violations, null, 2)
  );
  assert.ok(result.files.length >= 7, 'src/ 應該至少有 7 個 .gs 檔案');
});

test('lint() 會捉到刻意違規的假原始碼（AFile 排在 ZFile 之前，卻引用 ZFile 的常數）', function () {
  const tmpDir = makeFixtureDir({
    'AFile.gs': [
      "'use strict';",
      'var BAD_REF_ = [',
      '  foo(OTHER_CONST.STAND, 1)',
      '];',
      'function foo(a, b) { return { a: a, b: b }; }',
      ''
    ].join('\n'),
    'ZFile.gs': [
      "'use strict';",
      "var OTHER_CONST = Object.freeze({ STAND: '眾 立' });",
      ''
    ].join('\n')
  });
  try {
    const result = lint(tmpDir);
    assert.strictEqual(result.violations.length, 1, '應該剛好捉到一項違規');
    assert.strictEqual(result.violations[0].file, 'AFile.gs');
    assert.strictEqual(result.violations[0].line, 3);
    assert.strictEqual(result.violations[0].identifier, 'OTHER_CONST');
    assert.strictEqual(result.violations[0].declaredInFile, 'ZFile.gs');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('lint() 不會誤判：同一個識別碼如果宣告在同一個檔案（由上而下）是允許的', function () {
  const tmpDir = makeFixtureDir({
    'AFile.gs': [
      "'use strict';",
      "var LOCAL_CONST_ = Object.freeze({ X: 'x' });",
      'var USES_IT_ = [',
      '  LOCAL_CONST_.X',
      '];',
      ''
    ].join('\n')
  });
  try {
    const result = lint(tmpDir);
    assert.deepStrictEqual(result.violations, []);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('lint() 確認：把違規的頂層 var 改成延遲求值函式之後，不會再報錯', function () {
  const tmpDir = makeFixtureDir({
    'AFile.gs': [
      "'use strict';",
      'function badRef_() {',
      '  return [',
      '    foo(OTHER_CONST.STAND, 1)',
      '  ];',
      '}',
      'function foo(a, b) { return { a: a, b: b }; }',
      ''
    ].join('\n'),
    'ZFile.gs': [
      "'use strict';",
      "var OTHER_CONST = Object.freeze({ STAND: '眾 立' });",
      ''
    ].join('\n')
  });
  try {
    const result = lint(tmpDir);
    assert.deepStrictEqual(
      result.violations, [],
      '改成函式延遲求值之後不應該再有違規：' + JSON.stringify(result.violations, null, 2)
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// =====================================================================
// 2. 按真實次序整個載入一次
// =====================================================================

test('按字母序載入全部 src/*.gs 之後，跨檔案常數與函式都正常運作（第一輪事故的直接回歸測試）', function () {
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

  assert.ok(sandbox.POSTURE, 'POSTURE 應該有值，不是 undefined');
  assert.strictEqual(typeof sandbox.POSTURE.STAND, 'string');
  assert.ok(sandbox.POSTURE.STAND.length > 0);

  assert.ok(sandbox.CONDITION_TYPE, 'CONDITION_TYPE 應該有值，不是 undefined');
  assert.strictEqual(sandbox.CONDITION_TYPE.ALWAYS, 'ALWAYS');

  assert.ok(sandbox.APP_NAME, 'APP_NAME 應該有值，不是 undefined');
  assert.strictEqual(typeof sandbox.APP_NAME, 'string');

  assert.strictEqual(typeof sandbox.seedProgramTemplatesRows_, 'function');
  const rows = sandbox.seedProgramTemplatesRows_();
  assert.strictEqual(rows.length, 45, 'seedProgramTemplatesRows_() 應該回傳 45 行（15+17+13）');

  assert.strictEqual(typeof sandbox.onOpen, 'function', 'onOpen 一定要能被定義出來，這正是原本的事故（載入失敗）會壞掉的地方');
});

// =====================================================================

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
