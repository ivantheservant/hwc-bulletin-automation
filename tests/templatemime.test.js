#!/usr/bin/env node
/**
 * tests/templatemime.test.js
 *
 * prompt9 §1.5 的回歸測試：`readTemplateBlob_()` 讀取範本前先檢查 MIME
 * 類型——最常見的事故來源是 Google Drive 把上載的 `.docx` 自動轉換成
 * Google 文件格式，或者 Ivan 不小心貼了 Google 文件本身的檔案 ID。
 * 兩種情況 `getBlob()` 都不會拋錯，一定要靠明確的 MIME 檢查才攔得住，
 * 否則後面 `Utilities.unzip()` 只會丟一個看不懂原因的「不是合法 zip」。
 *
 * 執行方式：node tests/templatemime.test.js
 * 離開碼：0＝全部通過　1＝有測試失敗
 */

'use strict';

const assert = require('assert');
const { loadAllSrcFilesInOrder } = require('./helpers/loadGas');
const { makeFakeBlob, makeFakeUtilities, makeFakeDriveApp, buildFakeDocx } = require('./helpers/fakeDrive');
const fx = require('./fixtures/docxXml');

const FAKE_TEMPLATE_ID = 'TEMPLATE_FILE_ABC123';
const SAMPLE_XML = fx.documentXml(fx.para(fx.run('{{SERMON_TITLE}}')));

const BASE_STUBS = {
  Session: { getScriptTimeZone: function () { return 'Pacific/Auckland'; } }
};

function makeEnv(files) {
  const drive = makeFakeDriveApp({ files: files });
  const utilities = makeFakeUtilities();
  return loadAllSrcFilesInOrder(Object.assign({}, BASE_STUBS, {
    DriveApp: drive.DriveApp,
    Utilities: utilities,
    SpreadsheetApp: {},
    CacheService: {}
  }));
}

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
// 13. Google 文件 MIME → 拋出含指引的錯誤
// =====================================================================

test('13a. 範本被 Google Drive 轉換成 Google 文件（MIME 是 application/vnd.google-apps.document）→ 明確拋錯', function () {
  const blob = makeFakeBlob('這不是真的 .docx 內容', 'template', 'application/vnd.google-apps.document');
  const sandbox = makeEnv({ [FAKE_TEMPLATE_ID]: blob });

  assert.throws(function () {
    sandbox.readTemplateBlob_(FAKE_TEMPLATE_ID);
  }, function (err) {
    assert.ok(err.message.indexOf('不是 Word 檔') !== -1, '訊息要講明不是 Word 檔：' + err.message);
    assert.ok(err.message.indexOf('application/vnd.google-apps.document') !== -1, '要講出實際的 MIME：' + err.message);
    assert.ok(err.message.indexOf('將上載的檔案轉換為 Google 文件編輯器格式') !== -1, '要指引怎樣關閉自動轉換');
    assert.ok(err.message.indexOf('重新上載原本的 .docx') !== -1, '要指引重新上載');
    return true;
  });
});

test('13b. 任何非 Word MIME（例如 PDF）一樣要拋錯，不是只認 Google 文件一種', function () {
  const blob = makeFakeBlob('%PDF-1.4', 'template.pdf', 'application/pdf');
  const sandbox = makeEnv({ [FAKE_TEMPLATE_ID]: blob });

  assert.throws(function () {
    sandbox.readTemplateBlob_(FAKE_TEMPLATE_ID);
  }, function (err) {
    return err.message.indexOf('application/pdf') !== -1 && err.message.indexOf('不是 Word 檔') !== -1;
  });
});

test('13c. renderDocxFromTemplate_() 也會被 MIME 檢查擋住（透過 readTemplateBlob_ 這一層）', function () {
  const blob = makeFakeBlob('FAKE', 'template', 'application/vnd.google-apps.document');
  const sandbox = makeEnv({ [FAKE_TEMPLATE_ID]: blob });

  assert.throws(function () {
    sandbox.renderDocxFromTemplate_(FAKE_TEMPLATE_ID, 'out.docx', function (xml) { return xml; });
  }, /不是 Word 檔/);
});

// =====================================================================
// 14. 正確 MIME → 通過
// =====================================================================

test('14a. MIME 正確（application/vnd.openxmlformats-officedocument.wordprocessingml.document）→ 讀取成功，不拋錯', function () {
  const docx = buildFakeDocx(SAMPLE_XML);
  const sandbox = makeEnv({ [FAKE_TEMPLATE_ID]: docx });

  const blob = sandbox.readTemplateBlob_(FAKE_TEMPLATE_ID);
  assert.strictEqual(blob.getContentType(), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
});

test('14b. MIME 正確時，renderDocxFromTemplate_() 完整流程照常運作', function () {
  const docx = buildFakeDocx(SAMPLE_XML);
  const sandbox = makeEnv({ [FAKE_TEMPLATE_ID]: docx });

  const result = sandbox.renderDocxFromTemplate_(FAKE_TEMPLATE_ID, 'out.docx', function (xml) { return xml; });
  assert.ok(result.blob);
  assert.strictEqual(result.documentEntryName, 'word/document.xml');
});

// =====================================================================

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
