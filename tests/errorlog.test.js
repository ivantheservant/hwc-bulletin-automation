#!/usr/bin/env node
/**
 * tests/errorlog.test.js
 *
 * src/ErrorLog.gs 與 src/WebApp.gs 的 withApiResult_() 回歸測試：把例外
 * 「看得見、留得低」（見 docs/已知bug類型.md 事故七第 2 部分）。
 *
 * 1. withApiResult_() 失敗時寫一筆 ErrorLog，成功時不寫
 * 2. ErrorLog 寫入經過 sanitizeCellText_()
 * 3. 寫 ErrorLog 失敗時，原本的錯誤仍然照樣回傳給呼叫端
 *
 * 執行方式：node tests/errorlog.test.js
 * 離開碼：0＝全部通過　1＝有測試失敗
 */

'use strict';

const assert = require('assert');
const { loadAllSrcFilesInOrder } = require('./helpers/loadGas');
const { makeFakeSheet, makeFakeSpreadsheet } = require('./helpers/fakeSpreadsheet');

const CALLER_EMAIL = 'tester@x.com';

const GAS_STUBS = {
  Utilities: { formatDate: function () { return ''; } },
  Session: {
    getScriptTimeZone: function () { return 'Pacific/Auckland'; },
    getActiveUser: function () { return { getEmail: function () { return CALLER_EMAIL; } }; },
    getEffectiveUser: function () { return { getEmail: function () { return CALLER_EMAIL; } }; }
  },
  SpreadsheetApp: {},
  CacheService: {},
  HtmlService: {}
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

function ownSheetFor(sandboxRef, sheetId, rows) {
  const def = sandboxRef.COLUMNS[sheetId];
  return makeFakeSheet(def.headers, def.keys, rows || []);
}

/**
 * 造一個帶 ErrorLog（除非 `omitErrorLog`）與 Config（`WEBAPP_ALLOWED_EMAILS`
 * 空白，靠 effectiveEmail 通過權限檢查）的假環境。
 */
function makeEnv(options) {
  const o = options || {};
  const freshSandbox = loadAllSrcFilesInOrder(GAS_STUBS);
  const configRows = freshSandbox.DEFAULTS.map(function (d) {
    return { KEY: d.key, VALUE: d.value, NOTE: '', EDITABLE: true };
  });

  const sheets = {
    Config: makeFakeSheet(freshSandbox.COLUMNS.CONFIG.headers, freshSandbox.COLUMNS.CONFIG.keys, configRows)
  };
  if (!o.omitErrorLog) {
    sheets.ErrorLog = ownSheetFor(freshSandbox, 'ERROR_LOG', []);
  }

  const FakeApp = { getActiveSpreadsheet: function () { return makeFakeSpreadsheet(sheets); } };
  const sandbox = loadAllSrcFilesInOrder(Object.assign({}, GAS_STUBS, { SpreadsheetApp: FakeApp }));
  // ⚠️ 一併帶出假工作表：真實 Sheets 會把 sanitizeCellText_() 加的前導
  // 單引號當成格式標記吃掉，所以「有沒有跳脫過」要看
  // `__escapedValues`，不可以靠讀回來的值判斷。見
  // tests/helpers/fakeSpreadsheet.js 的 applyTextFormatMarker()。
  sandbox.__sheets = sheets;
  return sandbox;
}

/** 斷言某個值寫入指定工作表時真的經過了 sanitizeCellText_()。 */
function assertWasEscaped(env, sheetName, value) {
  assert.ok(
    env.__sheets[sheetName].__escapedValues.has(value),
    '「' + value + '」寫入 ' + sheetName + ' 時應該經過 sanitizeCellText_()'
  );
}

// =====================================================================
// 1. withApiResult_() 失敗時寫一筆 ErrorLog，成功時不寫
// =====================================================================

test('withApiResult_：fn() 拋錯 → ErrorLog 多一筆記錄，且回傳 {ok:false, error}', function () {
  var sb = makeEnv();
  var before = sb.readSheet('ErrorLog').length;

  var resp = sb.withApiResult_(function () {
    var err = new Error('故意拋出的錯誤');
    err.code = 'BOOM';
    throw err;
  }, { functionName: 'testFn' });

  assert.strictEqual(resp.ok, false);
  assert.strictEqual(resp.error.code, 'BOOM');
  assert.strictEqual(resp.error.message, '故意拋出的錯誤');

  var rows = sb.readSheet('ErrorLog');
  assert.strictEqual(rows.length, before + 1);
  assert.strictEqual(rows[before].SOURCE, 'SERVER');
  assert.strictEqual(rows[before].FUNCTION_NAME, 'testFn');
  assert.strictEqual(rows[before].ERROR_CODE, 'BOOM');
  assert.strictEqual(rows[before].MESSAGE, '故意拋出的錯誤');
});

test('withApiResult_：fn() 成功 → ErrorLog 不會多一筆記錄', function () {
  var sb = makeEnv();
  var before = sb.readSheet('ErrorLog').length;

  var resp = sb.withApiResult_(function () { return { hello: 'world' }; }, { functionName: 'testFn' });

  assert.strictEqual(resp.ok, true);
  assert.strictEqual(sb.readSheet('ErrorLog').length, before, '成功時不應該寫入 ErrorLog');
});

test('withApiResult_：呼叫者沒有權限時也算「失敗」，一樣要記一筆 ErrorLog', function () {
  var unauthorizedStubs = Object.assign({}, GAS_STUBS, {
    Session: {
      getScriptTimeZone: function () { return 'Pacific/Auckland'; },
      getActiveUser: function () { return { getEmail: function () { return 'nobody@x.com'; } }; },
      getEffectiveUser: function () { return { getEmail: function () { return CALLER_EMAIL; } }; }
    }
  });
  var freshSandbox = loadAllSrcFilesInOrder(unauthorizedStubs);
  var configRows = freshSandbox.DEFAULTS.map(function (d) { return { KEY: d.key, VALUE: d.value, NOTE: '', EDITABLE: true }; });
  var sheets = {
    Config: makeFakeSheet(freshSandbox.COLUMNS.CONFIG.headers, freshSandbox.COLUMNS.CONFIG.keys, configRows),
    ErrorLog: ownSheetFor(freshSandbox, 'ERROR_LOG', [])
  };
  var sb = loadAllSrcFilesInOrder(Object.assign({}, unauthorizedStubs, {
    SpreadsheetApp: { getActiveSpreadsheet: function () { return makeFakeSpreadsheet(sheets); } }
  }));

  var resp = sb.withApiResult_(function () { return 'should not reach here'; }, { functionName: 'testFn' });
  assert.strictEqual(resp.ok, false);
  assert.strictEqual(resp.error.code, 'FORBIDDEN');
  assert.strictEqual(sb.readSheet('ErrorLog').length, 1);
  assert.strictEqual(sb.readSheet('ErrorLog')[0].ERROR_CODE, 'FORBIDDEN');
});

// =====================================================================
// 2. ErrorLog 寫入經過 sanitizeCellText_()
// =====================================================================

test('appendErrorLog_：MESSAGE／DETAIL 以 = 開頭 → 寫入時有前導單引號（不會被 Sheets 當成公式）', function () {
  var sb = makeEnv();
  sb.appendErrorLog_({
    source: sb.ERROR_LOG_SOURCE.SERVER,
    functionName: 'testFn',
    errorCode: 'ERR',
    message: '=1+1 這不是公式',
    detail: '=HYPERLINK("http://example.invalid")'
  });

  var rows = sb.readSheet('ErrorLog');
  var row = rows[rows.length - 1];
  assert.strictEqual(row.MESSAGE, '=1+1 這不是公式');
  assert.strictEqual(row.DETAIL, '=HYPERLINK("http://example.invalid")');
  assertWasEscaped(sb, 'ErrorLog', '=1+1 這不是公式');
  assertWasEscaped(sb, 'ErrorLog', '=HYPERLINK("http://example.invalid")');
});

test('appendErrorLog_：ACTOR 沒有提供時用 Session.getActiveUser()，一樣經過 sanitizeCellText_', function () {
  var actorStubs = Object.assign({}, GAS_STUBS, {
    Session: {
      getScriptTimeZone: function () { return 'Pacific/Auckland'; },
      getActiveUser: function () { return { getEmail: function () { return '=actor@x.com'; } }; },
      getEffectiveUser: function () { return { getEmail: function () { return CALLER_EMAIL; } }; }
    }
  });
  var freshSandbox = loadAllSrcFilesInOrder(actorStubs);
  var sheets = { ErrorLog: ownSheetFor(freshSandbox, 'ERROR_LOG', []) };
  var sb = loadAllSrcFilesInOrder(Object.assign({}, actorStubs, {
    SpreadsheetApp: { getActiveSpreadsheet: function () { return makeFakeSpreadsheet(sheets); } }
  }));
  sb.__sheets = sheets;

  sb.appendErrorLog_({ source: sb.ERROR_LOG_SOURCE.MENU, functionName: 'f', errorCode: 'E', message: 'm' });
  var row = sb.readSheet('ErrorLog')[0];
  assert.strictEqual(row.ACTOR, '=actor@x.com');
  assertWasEscaped(sb, 'ErrorLog', '=actor@x.com');
});

// =====================================================================
// 3. 寫 ErrorLog 失敗時，原本的錯誤仍然照樣回傳給呼叫端
// =====================================================================

test('appendErrorLog_：ErrorLog 工作表不存在時回 false，不拋錯', function () {
  var sb = makeEnv({ omitErrorLog: true });
  var result = sb.appendErrorLog_({ source: sb.ERROR_LOG_SOURCE.SERVER, functionName: 'f', errorCode: 'E', message: 'm' });
  assert.strictEqual(result, false);
});

test('真正入口：ErrorLog 工作表不存在時，withApiResult_() 仍然正確回傳原本的錯誤，不會被「寫 ErrorLog 失敗」蓋掉或整個拋出', function () {
  var sb = makeEnv({ omitErrorLog: true });

  var resp = sb.withApiResult_(function () {
    var err = new Error('這個錯誤要平安送到呼叫端');
    err.code = 'ORIGINAL_ERROR';
    throw err;
  }, { functionName: 'testFn' });

  assert.strictEqual(resp.ok, false);
  assert.strictEqual(resp.error.code, 'ORIGINAL_ERROR');
  assert.strictEqual(resp.error.message, '這個錯誤要平安送到呼叫端');
});

// =====================================================================
// 4. enrichAuthError_()：授權範圍不足的錯誤要加一句指引
// =====================================================================

test('enrichAuthError_：含 permission 字樣的錯誤（實測遇到的 DriveApp 授權訊息）→ 加一句指引', function () {
  var sb = makeEnv();
  var err = new Error(
    'You do not have permission to call DriveApp.getFileById. Required permissions: '
    + '(https://www.googleapis.com/auth/drive.readonly || https://www.googleapis.com/auth/drive)'
  );
  var message = sb.enrichAuthError_(err);

  assert.ok(message.indexOf('You do not have permission to call DriveApp.getFileById') !== -1,
    '原本的錯誤訊息要保留：' + message);
  assert.ok(message.indexOf('授權範圍問題') !== -1, '要加授權範圍的指引：' + message);
  assert.ok(message.indexOf('Apps Script 編輯器') !== -1, '要講清楚去哪裡重新授權：' + message);
  assert.ok(message.indexOf('重新部署網頁應用程式') !== -1, '要提到部署 Web App 這條路：' + message);
});

test('enrichAuthError_：一般錯誤（不含 permission／authorization 字樣）→ 原樣回傳，不會多加任何字', function () {
  var sb = makeEnv();
  var err = new Error('BulletinWeeks 找不到 2027-11-07 這一行');
  var message = sb.enrichAuthError_(err);

  assert.strictEqual(message, 'BulletinWeeks 找不到 2027-11-07 這一行', '一般錯誤不應該被加上授權指引');
});

test('enrichAuthError_：不分大小寫比對（"Authorization required" 這類寫法也要抓到）', function () {
  var sb = makeEnv();
  var message = sb.enrichAuthError_(new Error('Authorization required to perform that action.'));
  assert.ok(message.indexOf('授權範圍問題') !== -1, message);
});

test('enrichAuthError_：err 不是 Error 物件（例如純字串）也不會拋錯', function () {
  var sb = makeEnv();
  assert.doesNotThrow(function () {
    var message = sb.enrichAuthError_('you do not have permission to do that');
    assert.ok(message.indexOf('授權範圍問題') !== -1, message);
  });
});

test('withApiResult_：拋出授權範圍錯誤時，回傳給前端的 error.message 也帶有指引', function () {
  var sb = makeEnv();
  var resp = sb.withApiResult_(function () {
    throw new Error('You do not have permission to call DriveApp.getFileById.');
  }, { functionName: 'testFn' });

  assert.strictEqual(resp.ok, false);
  assert.ok(resp.error.message.indexOf('授權範圍問題') !== -1, resp.error.message);
});

// =====================================================================

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
