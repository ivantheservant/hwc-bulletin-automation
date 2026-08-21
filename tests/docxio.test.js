#!/usr/bin/env node
/**
 * tests/docxio.test.js
 *
 * src/DocxIo.gs（Drive IO 層）的回歸測試，用假的 `Utilities`／`DriveApp`
 * 替身（tests/helpers/fakeDrive.js），不需要真的 .docx 檔案。
 *
 * 本檔案最重要的斷言：**只有 word/document.xml 被改動，其餘 entry 一個
 * 位元都沒有變**——週報的版面（圖片、樣式、字型、A5 兩頁併印設定）全部
 * 靠那些檔案撐住。
 *
 * 執行方式：node tests/docxio.test.js
 * 離開碼：0＝全部通過　1＝有測試失敗
 */

'use strict';

const assert = require('assert');
const { loadAllSrcFilesInOrder } = require('./helpers/loadGas');
const { makeFakeSheet, makeFakeSpreadsheet } = require('./helpers/fakeSpreadsheet');
const { makeFakeDriveApp, makeFakeUtilities, buildFakeDocx, makeFakeBlob } = require('./helpers/fakeDrive');
const fx = require('./fixtures/docxXml');

const BASE_STUBS = {
  Session: {
    getScriptTimeZone: function () { return 'Pacific/Auckland'; },
    getActiveUser: function () { return { getEmail: function () { return 'tester@x.com'; } }; }
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

const FAKE_TEMPLATE_ID = 'TEMPLATE_FILE_ABC123';
const FAKE_FOLDER_ID = 'OUTPUT_FOLDER_XYZ';
const SAMPLE_XML = fx.documentXml(fx.para(fx.run('{{SERMON_TITLE}}')));

/**
 * 造一個只有 DocxIo 需要的環境：假 DriveApp ＋ 假 Utilities。
 * DocxIo.gs 的函式全部不讀 Config，所以不需要造工作表。
 */
function makeEnv(o) {
  o = o || {};
  const docx = buildFakeDocx(o.xml === undefined ? SAMPLE_XML : o.xml, {
    omitContentTypes: o.omitContentTypes,
    documentEntryName: o.documentEntryName
  });

  const files = {};
  files[FAKE_TEMPLATE_ID] = docx;
  Object.keys(o.extraFiles || {}).forEach(function (k) { files[k] = o.extraFiles[k]; });

  const folders = {};
  if (!o.omitFolder) folders[FAKE_FOLDER_ID] = {};

  const drive = makeFakeDriveApp({ files: files, folders: folders });
  const utilities = makeFakeUtilities({ failUnzip: o.failUnzip });

  return {
    sandbox: loadAllSrcFilesInOrder(Object.assign({}, BASE_STUBS, {
      DriveApp: drive.DriveApp,
      Utilities: utilities
    })),
    drive: drive,
    docx: docx
  };
}

/** 由壓縮結果取出「entry 名稱 → 內容」對照表。 */
function entryTextMap(zipBlob) {
  const map = {};
  zipBlob.__entries.forEach(function (e) { map[e.getName()] = e.__text; });
  return map;
}

// =====================================================================
// 1. 只有 word/document.xml 被改動，其餘 entry 位元不變
// =====================================================================

test('1. renderDocxFromTemplate_()：只有 word/document.xml 的內容被換掉', function () {
  const env = makeEnv({});
  const before = entryTextMap(env.docx);

  const result = env.sandbox.renderDocxFromTemplate_(FAKE_TEMPLATE_ID, 'out.docx', function () {
    return '<RENDERED/>';
  });

  const after = entryTextMap(result.blob);
  assert.strictEqual(after['word/document.xml'], '<RENDERED/>', 'document.xml 應該被換掉');

  Object.keys(before).forEach(function (name) {
    if (name === 'word/document.xml') return;
    assert.strictEqual(after[name], before[name], name + ' 不可以被改動——版面就是靠這些檔案撐住的');
  });
});

test('1b. renderDocxFromTemplate_()：entry 數目與名稱完全不變', function () {
  const env = makeEnv({});
  const beforeNames = env.docx.__entries.map(function (e) { return e.getName(); }).sort();

  const result = env.sandbox.renderDocxFromTemplate_(FAKE_TEMPLATE_ID, 'out.docx', function (xml) { return xml; });
  const afterNames = result.blob.__entries.map(function (e) { return e.getName(); }).sort();

  assert.strictEqual(JSON.stringify(afterNames), JSON.stringify(beforeNames));
  assert.strictEqual(result.entryCount, beforeNames.length);
});

test('1c. renderDocxFromTemplate_()：圖片與樣式的 blob 是原物件（連物件都沒有換過）', function () {
  const env = makeEnv({});
  const originalImage = env.docx.__entries.filter(function (e) { return e.getName() === 'word/media/image1.png'; })[0];

  const result = env.sandbox.renderDocxFromTemplate_(FAKE_TEMPLATE_ID, 'out.docx', function (xml) { return xml; });
  const afterImage = result.blob.__entries.filter(function (e) { return e.getName() === 'word/media/image1.png'; })[0];

  assert.strictEqual(afterImage, originalImage, '圖片應該原物放回，連新建一個 blob 都不應該');
});

test('1d. renderDocxFromTemplate_()：transformXml 收到的是原始的 document.xml', function () {
  const env = makeEnv({});
  let received = null;
  env.sandbox.renderDocxFromTemplate_(FAKE_TEMPLATE_ID, 'out.docx', function (xml) {
    received = xml;
    return xml;
  });
  assert.strictEqual(received, SAMPLE_XML);
});

test('1e. renderDocxFromTemplate_()：產生的 blob MIME 類型是 Word 而不是 zip', function () {
  const env = makeEnv({});
  const result = env.sandbox.renderDocxFromTemplate_(FAKE_TEMPLATE_ID, 'out.docx', function (xml) { return xml; });
  assert.strictEqual(
    result.blob.getContentType(),
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'MIME 是 application/zip 的話，收件人收到的附件會變成認不出的壓縮檔'
  );
  assert.strictEqual(result.blob.getName(), 'out.docx');
});

// =====================================================================
// 2. [Content_Types].xml 缺失時拋錯
// =====================================================================

test('2. zipDocx_()：缺少 [Content_Types].xml 時拋錯，訊息講明後果', function () {
  const env = makeEnv({});
  assert.throws(
    function () {
      env.sandbox.zipDocx_([{ name: 'word/document.xml', blob: makeFakeBlob('<x/>', 'word/document.xml') }], 'out.docx');
    },
    function (err) {
      return err.message.indexOf('[Content_Types].xml') !== -1 && err.message.indexOf('損毀') !== -1;
    }
  );
});

test('2b. renderDocxFromTemplate_()：範本本身缺 [Content_Types].xml → 壓縮那一步拋錯', function () {
  const env = makeEnv({ omitContentTypes: true });
  assert.throws(function () {
    env.sandbox.renderDocxFromTemplate_(FAKE_TEMPLATE_ID, 'out.docx', function (xml) { return xml; });
  }, /Content_Types/);
});

test('2c. zipDocx_()：有 [Content_Types].xml 就正常壓縮', function () {
  const env = makeEnv({});
  const blob = env.sandbox.zipDocx_([
    { name: '[Content_Types].xml', blob: makeFakeBlob('<Types/>', '[Content_Types].xml') },
    { name: 'word/document.xml', blob: makeFakeBlob('<x/>', 'word/document.xml') }
  ], 'out.docx');
  assert.strictEqual(blob.__entries.length, 2);
});

// =====================================================================
// 3. 讀檔／解壓的錯誤處理
// =====================================================================

test('3. readTemplateBlob_()：檔案 ID 是空的 → 拋錯，訊息叫人去 Config 填', function () {
  const env = makeEnv({});
  assert.throws(
    function () { env.sandbox.readTemplateBlob_(''); },
    function (err) { return err.message.indexOf('Config') !== -1; }
  );
});

test('3b. readTemplateBlob_()：檔案開不到 → 訊息只含 ID 前 8 個字元，不印完整 ID', function () {
  const env = makeEnv({});
  assert.throws(
    function () { env.sandbox.readTemplateBlob_('SECRET_FILE_ID_THAT_IS_LONG'); },
    function (err) {
      assert.ok(err.message.indexOf('SECRET_F…') !== -1, '應該只印前 8 個字元：' + err.message);
      assert.strictEqual(err.message.indexOf('SECRET_FILE_ID_THAT_IS_LONG'), -1,
        '⚠️ 完整檔案 ID 不可以出現在錯誤訊息（會流到 ErrorLog／公開 repo）');
      return true;
    }
  );
});

test('3c. unzipDocx_()：解壓失敗 → 訊息提示「確認是不是 .docx」', function () {
  const env = makeEnv({ failUnzip: true });
  assert.throws(
    function () { env.sandbox.unzipDocx_(env.docx); },
    function (err) { return err.message.indexOf('.docx') !== -1; }
  );
});

test('3d. renderDocxFromTemplate_()：zip 內找不到 document.xml → 拋錯並列出實際檔案清單', function () {
  const weird = makeFakeBlob('FAKE', 'weird.docx',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  weird.__entries = [
    makeFakeBlob('<Types/>', '[Content_Types].xml'),
    makeFakeBlob('<x/>', 'xl/workbook.xml')
  ];
  const env = makeEnv({ extraFiles: { WEIRD_FILE: weird } });
  assert.throws(
    function () { env.sandbox.renderDocxFromTemplate_('WEIRD_FILE', 'out.docx', function (x) { return x; }); },
    function (err) {
      return err.message.indexOf('word/document.xml') !== -1 && err.message.indexOf('xl/workbook.xml') !== -1;
    }
  );
});

// =====================================================================
// 3e-3i. unzip／zip 只認內容類型，跟檔案實際格式無關——來回都要人手轉換
// =====================================================================

test('3e. unzipDocx_()：呼叫 Utilities.unzip 之前，先把內容類型設成 application/zip', function () {
  const env = makeEnv({});
  // env.docx 的內容類型是 Word 的 MIME（模仿 DriveApp.getFileById().getBlob()
  // 真正讀出來的樣子），不是 application/zip；假的 Utilities.unzip 會
  // 嚴格檢查這一點（見 tests/helpers/fakeDrive.js），如果 unzipDocx_()
  // 沒有先轉換內容類型就直接呼叫，這裡就會拋出跟實測一模一樣的錯誤。
  assert.strictEqual(env.docx.getContentType(),
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document');

  let entries;
  assert.doesNotThrow(function () { entries = env.sandbox.unzipDocx_(env.docx); });
  assert.ok(entries.length > 0);
});

test('3f. unzipDocx_()：原本傳入的 blob 內容類型不會被改動（只改複製品）', function () {
  const env = makeEnv({});
  const originalContentType = env.docx.getContentType();

  env.sandbox.unzipDocx_(env.docx);

  assert.strictEqual(env.docx.getContentType(), originalContentType,
    '呼叫端手上的原始 blob 內容類型不可以被 unzipDocx_() 悄悄改掉');
});

test('3g. unzipDocx_()：直接把一個內容類型不是 application/zip 也不是 Word MIME 的 blob 硬塞給假 Utilities.unzip 會拋錯（證明假替身真的有在檢查）', function () {
  const env = makeEnv({});
  assert.throws(
    function () { env.sandbox.Utilities.unzip(makeFakeBlob('x', 'x', 'application/octet-stream')); },
    /application\/zip/
  );
});

test('3h. zipDocx_()：回傳的 blob 內容類型是 Word 的 MIME、檔名以 .docx 結尾', function () {
  const env = makeEnv({});
  const blob = env.sandbox.zipDocx_([
    { name: '[Content_Types].xml', blob: makeFakeBlob('<Types/>', '[Content_Types].xml') },
    { name: 'word/document.xml', blob: makeFakeBlob('<x/>', 'word/document.xml') }
  ], '2027-11-07_粵語堂週報.docx');

  assert.strictEqual(blob.getContentType(),
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  assert.strictEqual(blob.getName().slice(-5), '.docx');
  assert.strictEqual(blob.getName(), '2027-11-07_粵語堂週報.docx');
});

test('3i. renderDocxFromTemplate_()（完整流程）：最終產出的 blob 內容類型是 Word 的 MIME，不是 application/zip', function () {
  const env = makeEnv({});
  const result = env.sandbox.renderDocxFromTemplate_(FAKE_TEMPLATE_ID, 'out.docx', function (xml) { return xml; });
  assert.strictEqual(result.blob.getContentType(),
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
});

// =====================================================================
// findDocumentEntryIndex_：不可以寫死索引位置
// =====================================================================

test('findDocumentEntryIndex_：精確比對', function () {
  const env = makeEnv({});
  const entries = [{ name: 'a.xml' }, { name: 'word/document.xml' }, { name: 'b.xml' }];
  assert.strictEqual(env.sandbox.findDocumentEntryIndex_(entries), 1);
});

test('findDocumentEntryIndex_：大小寫不同也找得到（不同工具產生的 zip 行為不一樣）', function () {
  const env = makeEnv({});
  assert.strictEqual(env.sandbox.findDocumentEntryIndex_([{ name: 'Word/Document.XML' }]), 0);
});

test('findDocumentEntryIndex_：沒有資料夾前綴也找得到', function () {
  const env = makeEnv({});
  assert.strictEqual(env.sandbox.findDocumentEntryIndex_([{ name: 'x.xml' }, { name: 'document.xml' }]), 1);
});

test('findDocumentEntryIndex_：不會把 document2.xml 當成 document.xml', function () {
  const env = makeEnv({});
  assert.strictEqual(env.sandbox.findDocumentEntryIndex_([{ name: 'word/document2.xml' }]), -1);
});

test('findDocumentEntryIndex_：找不到時回 -1，不拋錯', function () {
  const env = makeEnv({});
  assert.strictEqual(env.sandbox.findDocumentEntryIndex_([{ name: 'a' }, { name: 'b' }]), -1);
  assert.strictEqual(env.sandbox.findDocumentEntryIndex_([]), -1);
});

test('renderDocxFromTemplate_()：entry 名稱不是標準寫法時，換回去仍然用原本的名稱', function () {
  const env = makeEnv({ documentEntryName: 'Word/Document.xml' });
  const result = env.sandbox.renderDocxFromTemplate_(FAKE_TEMPLATE_ID, 'out.docx', function () { return '<R/>'; });
  assert.strictEqual(result.documentEntryName, 'Word/Document.xml');
  const names = result.blob.__entries.map(function (e) { return e.getName(); });
  assert.ok(names.indexOf('Word/Document.xml') !== -1, '不可以順手改成標準名稱：' + names.join('、'));
});

// =====================================================================
// 4. 輸出同名檔案時新增序號而不是覆蓋
// =====================================================================

test('4. writeOutputFile_()：第一次寫入用原本的檔名', function () {
  const env = makeEnv({});
  const written = env.sandbox.writeOutputFile_(makeFakeBlob('X', 'x'), FAKE_FOLDER_ID, '2027-11-07_粵語堂週報.docx');
  assert.strictEqual(written.fileName, '2027-11-07_粵語堂週報.docx');
  assert.strictEqual(env.drive.listFolderFiles(FAKE_FOLDER_ID).length, 1);
});

test('4b. writeOutputFile_()：同名時加 (2)、(3)，舊檔案不被覆蓋', function () {
  const env = makeEnv({});
  const name = '2027-11-07_粵語堂週報.docx';

  const first = env.sandbox.writeOutputFile_(makeFakeBlob('第一版', 'x'), FAKE_FOLDER_ID, name);
  const second = env.sandbox.writeOutputFile_(makeFakeBlob('第二版', 'x'), FAKE_FOLDER_ID, name);
  const third = env.sandbox.writeOutputFile_(makeFakeBlob('第三版', 'x'), FAKE_FOLDER_ID, name);

  assert.strictEqual(first.fileName, '2027-11-07_粵語堂週報.docx');
  assert.strictEqual(second.fileName, '2027-11-07_粵語堂週報(2).docx');
  assert.strictEqual(third.fileName, '2027-11-07_粵語堂週報(3).docx');

  const files = env.drive.listFolderFiles(FAKE_FOLDER_ID);
  assert.strictEqual(files.length, 3, '三個檔案都要在——舊版不可以被覆蓋掉');
  assert.strictEqual(files[0].blob.__text, '第一版', '第一版的內容必須原封不動');
});

test('4c. writeOutputFile_()：序號加在副檔名之前，不是加在最後', function () {
  const env = makeEnv({});
  env.sandbox.writeOutputFile_(makeFakeBlob('A', 'x'), FAKE_FOLDER_ID, 'report.docx');
  const second = env.sandbox.writeOutputFile_(makeFakeBlob('B', 'x'), FAKE_FOLDER_ID, 'report.docx');
  assert.strictEqual(second.fileName, 'report(2).docx');
  assert.notStrictEqual(second.fileName, 'report.docx(2)');
});

test('4d. writeOutputFile_()：沒有副檔名的檔名一樣加得到序號', function () {
  const env = makeEnv({});
  env.sandbox.writeOutputFile_(makeFakeBlob('A', 'x'), FAKE_FOLDER_ID, 'noext');
  const second = env.sandbox.writeOutputFile_(makeFakeBlob('B', 'x'), FAKE_FOLDER_ID, 'noext');
  assert.strictEqual(second.fileName, 'noext(2)');
});

test('4e. writeOutputFile_()：資料夾 ID 是空的 → 拋錯，訊息叫人去 Config 填', function () {
  const env = makeEnv({});
  assert.throws(
    function () { env.sandbox.writeOutputFile_(makeFakeBlob('X', 'x'), '', 'a.docx'); },
    function (err) { return err.message.indexOf('BULLETIN_OUTPUT_FOLDER_ID') !== -1; }
  );
});

test('4f. writeOutputFile_()：資料夾開不到 → 訊息只含 ID 前 8 個字元', function () {
  const env = makeEnv({ omitFolder: true });
  assert.throws(
    function () { env.sandbox.writeOutputFile_(makeFakeBlob('X', 'x'), 'SECRET_FOLDER_ID_LONG', 'a.docx'); },
    function (err) {
      assert.ok(err.message.indexOf('SECRET_F…') !== -1, err.message);
      assert.strictEqual(err.message.indexOf('SECRET_FOLDER_ID_LONG'), -1, '完整資料夾 ID 不可以印出來');
      return true;
    }
  );
});

test('4g. writeOutputFile_()：回傳的 url 可以直接點開', function () {
  const env = makeEnv({});
  const written = env.sandbox.writeOutputFile_(makeFakeBlob('X', 'x'), FAKE_FOLDER_ID, 'a.docx');
  assert.ok(written.url.indexOf('http') === 0, written.url);
  assert.ok(written.fileId.length > 0);
});

// =====================================================================
// splitFileName_ / uniqueOutputFileName_ 的邊界
// =====================================================================

test('splitFileName_：正常檔名、無副檔名、以點開頭的檔名', function () {
  const env = makeEnv({});
  assert.strictEqual(JSON.stringify(env.sandbox.splitFileName_('a.docx')), JSON.stringify({ base: 'a', ext: '.docx' }));
  assert.strictEqual(JSON.stringify(env.sandbox.splitFileName_('noext')), JSON.stringify({ base: 'noext', ext: '' }));
  assert.strictEqual(JSON.stringify(env.sandbox.splitFileName_('.hidden')), JSON.stringify({ base: '.hidden', ext: '' }));
});

test('splitFileName_：多個點時只看最後一個', function () {
  const env = makeEnv({});
  assert.strictEqual(JSON.stringify(env.sandbox.splitFileName_('a.b.docx')), JSON.stringify({ base: 'a.b', ext: '.docx' }));
});

test('maskFileId_：空值回「（空白）」，長 ID 只留前 8 個字元', function () {
  const env = makeEnv({});
  assert.strictEqual(env.sandbox.maskFileId_(''), '（空白）');
  assert.strictEqual(env.sandbox.maskFileId_(null), '（空白）');
  assert.strictEqual(env.sandbox.maskFileId_('abcdefghijklmn'), 'abcdefgh…');
});

// =====================================================================
// 3(prompt). 範本 ID 未設定 → notConfigured
//
// 這一條屬於 BulletinRender.gs 的職責（DocxIo.gs 收到的一定已經是有值的
// ID），所以在這裡用「真正入口」的角度驗一次：Config 全空的環境下，
// generateBulletinDocx_() 一定要回 notConfigured 而不是拋錯或空白。
// =====================================================================

test('（跨層）範本 ID 未設定時 generateBulletinDocx_() 回 notConfigured，而且訊息明確', function () {
  const boot = loadAllSrcFilesInOrder(Object.assign({}, BASE_STUBS, { Utilities: makeFakeUtilities() }));

  const cfg = {};
  boot.DEFAULTS.forEach(function (d) { cfg[d.key] = d.value; });
  cfg.ROSTER_SPREADSHEET_ID = 'FAKE_ROSTER';

  const ownSheets = {};
  Object.keys(boot.SHEETS).forEach(function (id) {
    const def = boot.COLUMNS[id];
    ownSheets[boot.SHEETS[id]] = makeFakeSheet(def.headers, def.keys, []);
  });
  const configDef = boot.COLUMNS.CONFIG;
  ownSheets.Config = makeFakeSheet(configDef.headers, configDef.keys, Object.keys(cfg).map(function (k) {
    return { KEY: k, VALUE: cfg[k], NOTE: '', EDITABLE: true };
  }));

  const rosterKeys = function (defKey) { return Object.keys(boot.ROSTER_TABLE_DEFS_[defKey].columns); };
  const rosterSheets = {
    RosterAssignments: makeFakeSheet(rosterKeys('ASSIGNMENTS'), rosterKeys('ASSIGNMENTS'), []),
    RosterVersions: makeFakeSheet(rosterKeys('VERSIONS'), rosterKeys('VERSIONS'), [{ QuarterID: '2027T4', VersionNo: 1 }]),
    Quarters: makeFakeSheet(rosterKeys('QUARTERS'), rosterKeys('QUARTERS'), [{ QuarterID: '2027T4', Stage: 'OFFICIAL_SENT' }]),
    ServiceDates: makeFakeSheet(rosterKeys('SERVICE_DATES'), rosterKeys('SERVICE_DATES'), [{
      ServiceDateID: 'SD1', QuarterID: '2027T4', ServiceDate: '2027-11-07', WeekIndex: 1,
      IsFirstSundayOfMonth: true, ServiceType: '主日崇拜', SpecialID: ''
    }]),
    SpecialSundays: makeFakeSheet(rosterKeys('SPECIAL_SUNDAYS'), rosterKeys('SPECIAL_SUNDAYS'), []),
    NameMapping: makeFakeSheet(rosterKeys('NAME_MAPPING'), rosterKeys('NAME_MAPPING'), []),
    Posts: makeFakeSheet(rosterKeys('POSTS'), rosterKeys('POSTS'), [])
  };

  const FakeSpreadsheetApp = {
    getActiveSpreadsheet: function () { return makeFakeSpreadsheet(ownSheets); },
    openById: function () { return makeFakeSpreadsheet(rosterSheets); }
  };

  const drive = makeFakeDriveApp({ files: {}, folders: {} });
  const sb = loadAllSrcFilesInOrder(Object.assign({}, BASE_STUBS, {
    SpreadsheetApp: FakeSpreadsheetApp,
    DriveApp: drive.DriveApp,
    Utilities: makeFakeUtilities()
  }));

  const result = sb.generateBulletinDocx_('2027-11-07');
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.notConfigured, true);
  assert.ok(result.message.indexOf('尚未設定 Word 範本') !== -1,
    '⚠️ 一定要明確講「尚未設定 Word 範本」，不可以當成「沒有資料」：' + result.message);
});

// =====================================================================

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
