#!/usr/bin/env node
/**
 * tests/configcache.test.js
 *
 * src/ConfigService.gs 移除跨執行快取層之後的回歸測試（見
 * docs/已知bug類型.md 事故三）：
 *   1. getConfig() 在同一次執行內只讀 Config 工作表一次（記憶體快取有效）。
 *   2. 原始碼內不再出現任何跨執行快取服務的呼叫。
 *
 * 執行方式：node tests/configcache.test.js
 * 離開碼：0＝全部通過　1＝有測試失敗
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { loadAllSrcFilesInOrder } = require('./helpers/loadGas');
const { makeFakeSheet, makeFakeSpreadsheet } = require('./helpers/fakeSpreadsheet');

const GAS_STUBS = {
  Utilities: { formatDate: function () { return ''; } },
  Session: {
    getScriptTimeZone: function () { return 'Pacific/Auckland'; },
    getActiveUser: function () { return { getEmail: function () { return ''; } }; }
  }
};

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
// 1. getConfig() 在同一次執行內只讀 Config 工作表一次
// =====================================================================

test('getConfig()：同一次執行內只會真正讀一次 Config 工作表（記憶體快取有效）', function () {
  const sandbox = loadAllSrcFilesInOrder(GAS_STUBS);
  const configSheet = makeFakeSheet(
    sandbox.COLUMNS.CONFIG.headers, sandbox.COLUMNS.CONFIG.keys,
    [{ KEY: 'DRY_RUN', VALUE: 'TRUE', NOTE: '', EDITABLE: true }]
  );

  let getRangeCallCount = 0;
  const originalGetRange = configSheet.getRange;
  configSheet.getRange = function () {
    getRangeCallCount++;
    return originalGetRange.apply(configSheet, arguments);
  };

  const FakeApp = {
    getActiveSpreadsheet: function () { return makeFakeSpreadsheet({ Config: configSheet }); }
  };
  const s = loadAllSrcFilesInOrder(Object.assign({}, GAS_STUBS, { SpreadsheetApp: FakeApp }));

  assert.strictEqual(s.getConfig('DRY_RUN'), 'TRUE');
  const countAfterFirst = getRangeCallCount;
  assert.ok(countAfterFirst > 0, '第一次呼叫應該真的讀了 Config 工作表');

  s.getConfig('DRY_RUN');
  s.getConfig('SOME_OTHER_KEY', 'fallback');
  s.getConfig('DRY_RUN');
  assert.strictEqual(
    getRangeCallCount, countAfterFirst,
    '同一次執行內，第二次以後呼叫 getConfig() 不應該再讀 Config 工作表（次數：' + getRangeCallCount + '，第一次之後應該保持 ' + countAfterFirst + '）'
  );
});

test('clearConfigCache_()：清快取之後，下一次 getConfig() 會重新讀一次工作表', function () {
  const sandbox = loadAllSrcFilesInOrder(GAS_STUBS);
  const configSheet = makeFakeSheet(
    sandbox.COLUMNS.CONFIG.headers, sandbox.COLUMNS.CONFIG.keys,
    [{ KEY: 'DRY_RUN', VALUE: 'TRUE', NOTE: '', EDITABLE: true }]
  );
  let getRangeCallCount = 0;
  const originalGetRange = configSheet.getRange;
  configSheet.getRange = function () {
    getRangeCallCount++;
    return originalGetRange.apply(configSheet, arguments);
  };
  const FakeApp = {
    getActiveSpreadsheet: function () { return makeFakeSpreadsheet({ Config: configSheet }); }
  };
  const s = loadAllSrcFilesInOrder(Object.assign({}, GAS_STUBS, { SpreadsheetApp: FakeApp }));

  s.getConfig('DRY_RUN');
  const countAfterFirst = getRangeCallCount;
  s.getConfig('DRY_RUN');
  assert.strictEqual(getRangeCallCount, countAfterFirst, '清快取之前不應該重讀');

  s.clearConfigCache_();
  s.getConfig('DRY_RUN');
  assert.ok(getRangeCallCount > countAfterFirst, 'clearConfigCache_() 之後應該重新讀一次工作表');
});

// =====================================================================
// 2. 原始碼內不再出現任何跨執行快取服務的呼叫
// =====================================================================

test('src/*.gs 內不再出現 CacheService（跨執行、人手編輯的 Config 不可以有這種快取）', function () {
  const srcDir = path.join(__dirname, '..', 'src');
  const files = fs.readdirSync(srcDir).filter(function (f) { return f.endsWith('.gs'); });
  const hits = [];

  files.forEach(function (fileName) {
    const content = fs.readFileSync(path.join(srcDir, fileName), 'utf8');
    if (/CacheService/.test(content)) {
      hits.push(fileName);
    }
  });

  assert.deepStrictEqual(hits, [], 'src/ 不應該再出現 CacheService，但在以下檔案找到：' + hits.join('、'));
});

// =====================================================================

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
