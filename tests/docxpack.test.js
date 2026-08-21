#!/usr/bin/env node
/**
 * tests/docxpack.test.js
 *
 * prompt9 §1.4 的回歸測試：`Utilities.zip()` 打包時 `[Content_Types].xml`
 * 必須是第一個 entry，其餘 entry 維持原本次序，一個都不可以少、不可以多。
 *
 * 執行方式：node tests/docxpack.test.js
 * 離開碼：0＝全部通過　1＝有測試失敗
 */

'use strict';

const assert = require('assert');
const { loadAllSrcFilesInOrder } = require('./helpers/loadGas');
const { makeFakeUtilities, makeFakeDriveApp, buildFakeDocx } = require('./helpers/fakeDrive');
const fx = require('./fixtures/docxXml');

const FAKE_TEMPLATE_ID = 'TEMPLATE_FILE_ABC123';
const SAMPLE_XML = fx.documentXml(fx.para(fx.run('{{SERMON_TITLE}}')));

const BASE_STUBS = {
  Session: { getScriptTimeZone: function () { return 'Pacific/Auckland'; } }
};

function makeEnv(docxOptions) {
  const docx = buildFakeDocx(SAMPLE_XML, docxOptions || {});
  const drive = makeFakeDriveApp({ files: { [FAKE_TEMPLATE_ID]: docx } });
  const utilities = makeFakeUtilities();
  const sandbox = loadAllSrcFilesInOrder(Object.assign({}, BASE_STUBS, {
    DriveApp: drive.DriveApp,
    Utilities: utilities,
    SpreadsheetApp: {},
    CacheService: {}
  }));
  return { sandbox: sandbox };
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
// 10. [Content_Types].xml 是第一個 entry
// =====================================================================

test('10a. Content_Types 原本就在第一個位置 → 壓縮之後仍然是第一個', function () {
  const env = makeEnv({ contentTypesIndex: 0 });
  const result = env.sandbox.renderDocxFromTemplate_(FAKE_TEMPLATE_ID, 'out.docx', function (xml) { return xml; });
  assert.strictEqual(result.blob.__entries[0].getName(), '[Content_Types].xml');
});

test('10b. Content_Types 原本在中間位置（模擬 unzip() 次序不保證）→ 壓縮之後被搬到第一個', function () {
  const env = makeEnv({ contentTypesIndex: 3 });
  const result = env.sandbox.renderDocxFromTemplate_(FAKE_TEMPLATE_ID, 'out.docx', function (xml) { return xml; });
  assert.strictEqual(result.blob.__entries[0].getName(), '[Content_Types].xml');
});

test('10c. Content_Types 原本在最後一個位置 → 壓縮之後被搬到第一個', function () {
  const env = makeEnv({ contentTypesIndex: 999 }); // splice 會夾到陣列真正的長度，等同「最後」
  const result = env.sandbox.renderDocxFromTemplate_(FAKE_TEMPLATE_ID, 'out.docx', function (xml) { return xml; });
  assert.strictEqual(result.blob.__entries[0].getName(), '[Content_Types].xml');
});

// =====================================================================
// 11. entry 數目與原檔一致
// =====================================================================

test('11. 搬動 Content_Types 之後，entry 數目跟原本完全一樣，一個不少一個不多', function () {
  const env = makeEnv({ contentTypesIndex: 3 });
  const docx = env.sandbox.readTemplateBlob_(FAKE_TEMPLATE_ID);
  const originalEntries = env.sandbox.unzipDocx_(docx);
  const originalNames = originalEntries.map(function (e) { return e.name; }).slice().sort();

  const result = env.sandbox.renderDocxFromTemplate_(FAKE_TEMPLATE_ID, 'out.docx', function (xml) { return xml; });
  const afterNames = result.blob.__entries.map(function (e) { return e.getName(); }).slice().sort();

  assert.strictEqual(afterNames.length, originalNames.length);
  assert.strictEqual(JSON.stringify(afterNames), JSON.stringify(originalNames), '應該是同一批 entry，只是次序不同');
});

// =====================================================================
// 12. 只有 word/document.xml 被改動；其餘 entry（含次序）原封不動
// =====================================================================

test('12. 除了 Content_Types 被搬到最前面之外，其餘 entry 的相對次序保持原本 unzip() 的次序', function () {
  const env = makeEnv({ contentTypesIndex: 3 });
  const docx = env.sandbox.readTemplateBlob_(FAKE_TEMPLATE_ID);
  const originalNames = env.sandbox.unzipDocx_(docx).map(function (e) { return e.name; });
  const originalWithoutContentTypes = originalNames.filter(function (n) { return n !== '[Content_Types].xml'; });

  const result = env.sandbox.renderDocxFromTemplate_(FAKE_TEMPLATE_ID, 'out.docx', function (xml) { return xml; });
  const afterNames = result.blob.__entries.map(function (e) { return e.getName(); });

  assert.strictEqual(afterNames[0], '[Content_Types].xml');
  assert.strictEqual(JSON.stringify(afterNames.slice(1)), JSON.stringify(originalWithoutContentTypes),
    '除了 Content_Types 被搬到最前面，其餘 entry 的相對次序不可以變');
});

test('12b. 只有 word/document.xml 這個 entry 的內容被換掉，其餘 blob 是原物件', function () {
  const env = makeEnv({ contentTypesIndex: 2 });
  const docx = env.sandbox.readTemplateBlob_(FAKE_TEMPLATE_ID);
  const originalEntries = env.sandbox.unzipDocx_(docx);
  const originalStylesBlob = originalEntries.filter(function (e) { return e.name === 'word/styles.xml'; })[0].blob;

  const result = env.sandbox.renderDocxFromTemplate_(FAKE_TEMPLATE_ID, 'out.docx', function () { return '<CHANGED/>'; });
  const afterStyles = result.blob.__entries.filter(function (e) { return e.getName() === 'word/styles.xml'; })[0];

  assert.strictEqual(afterStyles, originalStylesBlob, 'word/styles.xml 應該是原物件，完全沒有被動過');
});

// =====================================================================
// moveContentTypesEntryFirst_()：純函式層直接測
// =====================================================================

test('moveContentTypesEntryFirst_()：已經在第一個時原樣回傳（不做無謂搬動）', function () {
  const env = makeEnv({});
  const entries = [
    { name: '[Content_Types].xml', blob: {} },
    { name: 'word/document.xml', blob: {} },
    { name: 'word/styles.xml', blob: {} }
  ];
  const ordered = env.sandbox.moveContentTypesEntryFirst_(entries);
  assert.strictEqual(JSON.stringify(ordered.map(function (e) { return e.name; })),
    JSON.stringify(['[Content_Types].xml', 'word/document.xml', 'word/styles.xml']));
});

test('moveContentTypesEntryFirst_()：不修改傳入的原陣列', function () {
  const env = makeEnv({});
  const entries = [
    { name: 'word/document.xml', blob: {} },
    { name: '[Content_Types].xml', blob: {} }
  ];
  const before = JSON.stringify(entries.map(function (e) { return e.name; }));
  env.sandbox.moveContentTypesEntryFirst_(entries);
  assert.strictEqual(JSON.stringify(entries.map(function (e) { return e.name; })), before, '原陣列不可以被修改');
});

// =====================================================================

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
