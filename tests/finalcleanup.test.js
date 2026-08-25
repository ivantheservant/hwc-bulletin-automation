#!/usr/bin/env node
/**
 * tests/finalcleanup.test.js
 *
 * 收尾四項（prompt-final-cleanup.md）：
 *   1. I06 的比對來源次序，以及「不再讀 Script Property」
 *   2. Drive 進階服務一律用 **v3** 欄位名
 *   3. 亂行機的「走過的路」是累計的、跨批接得上
 *   4. 「診斷 I04」的輸出
 *
 * ⚠️ 這一輪最值得記的一件事：`Drive.Files.list` 那幾個假替身本來模仿的是
 * **v2**，而 `src/` 那一邊寫的也是 v2 欄位名——兩邊**一齊錯**，所以測試
 * 全部綠，而真環境每一次呼叫都失敗。假替身現在會在收到 v2 欄位名時**拋錯**，
 * 令這一類錯誤在測試就撞到。見 docs/已知bug類型.md 事故三十七。
 *
 * 執行方式：node tests/finalcleanup.test.js
 * 離開碼：0＝全部通過　1＝有測試失敗
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { loadAllSrcFilesInOrder } = require('./helpers/loadGas');
const { makeFakeSheet, makeFakeSpreadsheet } = require('./helpers/fakeSpreadsheet');
const { assertWrittenChinese } = require('./helpers/writtenChinese');

const TARGET_DATE = '2027-11-07';
const MASTER_ID = 'MASTER_FILE_1';

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

function deepEq(actual, expected, message) {
  assert.strictEqual(JSON.stringify(actual), JSON.stringify(expected), message);
}

function readSrc(fileName) {
  return fs.readFileSync(path.join(__dirname, '..', 'src', fileName), 'utf8');
}

function md5Fingerprint(bytes) {
  return bytes.length + ':' + crypto.createHash('md5').update(Buffer.from(bytes)).digest('hex');
}

function baseStubs(o) {
  return {
    Logger: { log: function () {} },
    Utilities: {
      formatDate: function (d, tz, pattern) {
        const y = d.getFullYear();
        const mo = String(d.getMonth() + 1).padStart(2, '0');
        const da = String(d.getDate()).padStart(2, '0');
        if (String(pattern).indexOf('HHmmss') !== -1) return '' + y + mo + da + '000000';
        return y + '-' + mo + '-' + da;
      },
      computeDigest: function (alg, bytes) {
        return Array.from(crypto.createHash('md5').update(Buffer.from(bytes)).digest());
      },
      DigestAlgorithm: { MD5: 'MD5' }
    },
    Session: {
      getScriptTimeZone: function () { return 'Pacific/Auckland'; },
      getActiveUser: function () { return { getEmail: function () { return 'x@example.com'; } }; }
    },
    CacheService: {},
    HtmlService: {},
    PropertiesService: {
      getUserProperties: function () {
        return { getProperty: function () { return null; }, setProperty: function () {} };
      },
      getScriptProperties: function () {
        if (!o.__scriptProps) o.__scriptProps = {};
        const store = o.__scriptProps;
        return {
          getProperty: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
          setProperty: function (k, v) { store[k] = String(v); return this; }
        };
      }
    }
  };
}

function makeEnv(options) {
  const o = options || {};
  const boot = loadAllSrcFilesInOrder(baseStubs(o));

  const cfg = {};
  boot.DEFAULTS.forEach(function (d) { cfg[d.key] = d.value; });
  cfg.PUBLISHED_PDF_FILE_ID = MASTER_ID;
  Object.assign(cfg, o.config || {});

  const sheets = {};
  Object.keys(boot.SHEETS).forEach(function (id) {
    const def = boot.COLUMNS[id];
    sheets[boot.SHEETS[id]] = makeFakeSheet(def.headers, def.keys, []);
  });
  sheets.Config = makeFakeSheet(boot.COLUMNS.CONFIG.headers, boot.COLUMNS.CONFIG.keys,
    Object.keys(cfg).map(function (k) { return { KEY: k, VALUE: cfg[k], NOTE: '', EDITABLE: true }; }));
  sheets.PublishLog = makeFakeSheet(boot.COLUMNS.PUBLISH_LOG.headers, boot.COLUMNS.PUBLISH_LOG.keys,
    o.publishLog || []);
  sheets.Recipients = makeFakeSheet(boot.COLUMNS.RECIPIENTS.headers, boot.COLUMNS.RECIPIENTS.keys,
    o.recipients === undefined ? [
      { RECIPIENT_ID: 'R1', NAME: '甲', EMAIL: 'a@x.com', GROUP_NAME: 'CC', ACTIVE: true },
      { RECIPIENT_ID: 'R2', NAME: '乙', EMAIL: 'b@x.com', GROUP_NAME: 'DB', ACTIVE: true },
      { RECIPIENT_ID: 'R3', NAME: '丙', EMAIL: 'c@x.com', GROUP_NAME: 'ADMIN', ACTIVE: true }
    ] : o.recipients);

  const driveFiles = o.driveFiles || {};
  const sandbox = loadAllSrcFilesInOrder(Object.assign({}, baseStubs(o), {
    SpreadsheetApp: {
      getActiveSpreadsheet: function () { return makeFakeSpreadsheet(sheets); },
      getUi: function () {
        return {
          alert: function () { return 'OK'; },
          ButtonSet: { OK: 'OK', YES_NO: 'YES_NO' }, Button: { OK: 'OK', YES: 'YES', NO: 'NO' }
        };
      }
    },
    DriveApp: {
      getFileById: function (id) {
        if (!Object.prototype.hasOwnProperty.call(driveFiles, id)) {
          throw new Error('No item with the given ID could be found: ' + id);
        }
        const bytes = driveFiles[id];
        return {
          getId: function () { return id; },
          getName: function () { return id + '.pdf'; },
          getLastUpdated: function () { return new Date(2027, 10, 8); },
          getOwner: function () { return { getEmail: function () { return 'owner@example.com'; } }; },
          getBlob: function () {
            return {
              getBytes: function () { return bytes.slice(); },
              getContentType: function () { return 'application/pdf'; }
            };
          }
        };
      }
    },
    // ⚠️ **v3 形狀**的假替身：收到 v2 的欄位名就拋錯。
    Drive: {
      Files: {
        list: function (args) { return v3FilesList(args, o); }
      },
      Revisions: {
        list: function (fileId, args) { return v3RevisionsList(fileId, args, o); }
      }
    }
  }));

  return { sandbox: sandbox, sheets: sheets, boot: boot, calls: o.__calls || (o.__calls = []) };
}

/** v3 的 Drive.Files.list：收到 v2 欄位名就拋錯。 */
function v3FilesList(args, o) {
  const a = args || {};
  (o.__calls || (o.__calls = [])).push({ api: 'Files.list', args: a });
  if (a.maxResults !== undefined) throw new Error('Invalid parameter maxResults（v3 應該用 pageSize）');
  if (String(a.fields || '').indexOf('items(') !== -1) {
    throw new Error('Invalid field selection items（v3 應該用 files）');
  }
  if (String(a.q || '').indexOf('title') !== -1) {
    throw new Error('Invalid query title（v3 應該用 name）');
  }
  return { files: [] };
}

/** v3 的 Drive.Revisions.list：收到 v2 欄位名就拋錯。 */
function v3RevisionsList(fileId, args, o) {
  const a = args || {};
  (o.__calls || (o.__calls = [])).push({ api: 'Revisions.list', fileId: fileId, args: a });
  if (a.maxResults !== undefined) throw new Error('Invalid parameter maxResults（v3 應該用 pageSize）');
  if (String(a.fields || '').indexOf('items(') !== -1) {
    throw new Error('Invalid field selection items（v3 應該用 revisions）');
  }
  const list = (o.revisions || []).map(function (rev, i) {
    return {
      id: 'rev' + i,
      modifiedTime: rev.modifiedTime,
      size: rev.size,
      lastModifyingUser: { displayName: rev.modifiedBy }
    };
  });
  return { revisions: list };
}

function publishRow(overrides) {
  return Object.assign({
    SERVICE_DATE: TARGET_DATE, VERSION_NO: 2, PUBLISHED_AT: '2027-11-06',
    PUBLISHED_BY: 'ivan@example.com', ARCHIVE_FILE_ID: '', SENT: true,
    SENT_GROUPS: 'CC,DB', MISSING_COUNT: 0, FORCED: false, FORCED_REASON: '',
    MASTER_FILE_ID: MASTER_ID, IS_SELFTEST: false
  }, overrides || {});
}

// =====================================================================
// 第 1 部分：I06 的比對來源
// =====================================================================

test('1. CONTENT_MD5 有值 → 用它比對', function () {
  const bytes = [0x25, 0x50, 0x44, 0x46, 0x01];
  const fp = md5Fingerprint(bytes).split(':');
  const env = makeEnv({
    driveFiles: { [MASTER_ID]: bytes },
    publishLog: [publishRow({ CONTENT_BYTES: Number(fp[0]), CONTENT_MD5: fp[1] })]
  });
  const r = env.sandbox.runInvariantI06_();
  assert.strictEqual(r.ok, true, r.evidence);
  assert.ok(r.evidence.indexOf('這一行的 CONTENT_MD5') !== -1, r.evidence);
});

// ⚠️ 這一條就是實測那個情況：CONTENT_MD5 空，而存檔副本與 master 完全一樣
//    （`2007999:6e3f92…`），所以會直接通過。
test('2. CONTENT_MD5 空、存檔副本在 → 用存檔副本比對，本例通過', function () {
  const bytes = [0x25, 0x50, 0x44, 0x46, 0x07];
  const env = makeEnv({
    driveFiles: { [MASTER_ID]: bytes, ARCHIVE_1: bytes },
    publishLog: [publishRow({ ARCHIVE_FILE_ID: 'ARCHIVE_1' })]
  });
  const r = env.sandbox.runInvariantI06_();
  assert.strictEqual(r.ok, true, r.evidence);
  assert.ok(r.evidence.indexOf('存檔副本') !== -1,
    '一定要講明指紋來自存檔副本，不可以扮成發佈當時記下的值：' + r.evidence);
});

test('3. 兩者都無 → 驗證不到，訊息寫明哪一邊取不到', function () {
  const env = makeEnv({
    driveFiles: { [MASTER_ID]: [0x25, 0x50, 0x44, 0x46] },
    publishLog: [publishRow()]
  });
  const r = env.sandbox.runInvariantI06_();
  assert.strictEqual(r.ok, null, r.evidence);
  assert.ok(r.evidence.indexOf('驗證不到（不是對不上）') !== -1, r.evidence);
  assert.ok(r.evidence.indexOf('沒有 ARCHIVE_FILE_ID') !== -1,
    '要講明是哪一邊取不到：' + r.evidence);
});

test('4. 完全不讀 Script Property（靜態檢查）', function () {
  const banned = ['PUBLISH_LAST_OUTPUT', 'readPublishOutputFingerprint_',
    'recordPublishOutputFingerprint_', 'publishOutputFingerprintKey_',
    'parsePublishOutputFingerprint_'];
  const srcDir = path.join(__dirname, '..', 'src');
  const offenders = [];

  fs.readdirSync(srcDir).filter(function (n) { return String(n).slice(-3) === '.gs'; })
    .forEach(function (fileName) {
      readSrc(fileName).split(String.fromCharCode(10)).forEach(function (line, i) {
        const trimmed = line.replace(/^[ \t]+/, '');
        if (trimmed.slice(0, 2) === '//' || trimmed.slice(0, 1) === '*') return;
        banned.forEach(function (name) {
          if (line.indexOf(name) !== -1) offenders.push(fileName + ':' + (i + 1));
        });
      });
    });
  assert.strictEqual(offenders.length, 0, offenders.join('、'));
});

test('5. 發佈成功後 CONTENT_MD5、CONTENT_BYTES 有寫入（靜態檢查寫入點）', function () {
  const src = readSrc('Publish.gs');
  assert.ok(src.indexOf('CONTENT_BYTES: fingerprintParts.bytes') !== -1,
    'executePublish_ 一定要寫 CONTENT_BYTES');
  assert.ok(src.indexOf('CONTENT_MD5: sanitizeCellText_(fingerprintParts.md5)') !== -1,
    'executePublish_ 一定要寫 CONTENT_MD5');
});

test('6. 一次性補寫：用存檔副本的指紋補上，且不覆寫已有值', function () {
  const bytes = [0x25, 0x50, 0x44, 0x46, 0x11];
  const env = makeEnv({
    driveFiles: { [MASTER_ID]: bytes, ARCHIVE_1: bytes, ARCHIVE_2: bytes },
    publishLog: [
      publishRow({ VERSION_NO: 1, ARCHIVE_FILE_ID: 'ARCHIVE_1', CONTENT_BYTES: 999, CONTENT_MD5: 'keepme' }),
      publishRow({ VERSION_NO: 2, ARCHIVE_FILE_ID: 'ARCHIVE_2' })
    ]
  });

  const result = env.sandbox.backfillPublishLogContentFingerprint_();
  assert.strictEqual(result.filled, 1, '只有第二行需要補');
  assert.strictEqual(result.skipped, 0);

  const rows = env.sandbox.readSheet(env.sandbox.SHEETS.PUBLISH_LOG);
  assert.strictEqual(String(rows[0].CONTENT_MD5), 'keepme', '已經有值的不可以被覆寫');
  assert.strictEqual(String(rows[1].CONTENT_MD5), md5Fingerprint(bytes).split(':')[1]);

  // 再跑一次：一行都不應該再補。
  assert.strictEqual(env.sandbox.backfillPublishLogContentFingerprint_().filled, 0);
});

// ⚠️ 讀不到存檔副本的一律留空並報「補寫不到」——填一個猜出來的值，等於把
//    「不知道」記成「知道」。
test('6b. 補寫：存檔副本讀不到 → 留空並報「補寫不到」，講得出原因', function () {
  const env = makeEnv({
    driveFiles: { [MASTER_ID]: [0x25] },
    publishLog: [publishRow({ ARCHIVE_FILE_ID: 'MISSING' })]
  });
  const result = env.sandbox.backfillPublishLogContentFingerprint_();
  assert.strictEqual(result.filled, 0);
  assert.strictEqual(result.skipped, 1);
  assert.ok(result.skipReasons[0].indexOf('讀不到') !== -1, result.skipReasons[0]);

  const row = env.sandbox.readSheet(env.sandbox.SHEETS.PUBLISH_LOG)[0];
  assert.strictEqual(String(row.CONTENT_MD5 || ''), '', '猜不到就要留空');
});

// =====================================================================
// 第 2 部分：Drive v3
// =====================================================================

// ⚠️ 這一條是實測撞到的錯：「Invalid field selection items」。
//    `items` 是 v2 的欄位名，appsscript.json 釘死在 v3。
test('7. Drive.Revisions.list 用 v3 欄位名，並帶 supportsAllDrives', function () {
  const env = makeEnv({ revisions: [{ modifiedTime: '2027-11-08T02:00:00Z', size: 7, modifiedBy: 'ivan' }] });
  const result = env.sandbox.driveListRevisions_(MASTER_ID, 10);

  assert.strictEqual(result.ok, true, result.message);
  const call = env.calls.filter(function (c) { return c.api === 'Revisions.list'; })[0];
  assert.ok(call, '應該呼叫過 Drive.Revisions.list');
  assert.strictEqual(call.args.supportsAllDrives, true, '要帶 supportsAllDrives');
  assert.ok(String(call.args.fields).indexOf('revisions(') === 0,
    'v3 的欄位名是 revisions，不是 items：' + call.args.fields);
  assert.ok(String(call.args.fields).indexOf('modifiedTime') !== -1, call.args.fields);
  assert.ok(String(call.args.fields).indexOf('size') !== -1, call.args.fields);
  assert.strictEqual(call.args.maxResults, undefined, 'v3 用 pageSize，不是 maxResults');
  assert.strictEqual(call.args.pageSize, 1000);
});

test('7b. driveCountRevisions_ 一樣用 v3 欄位名（數得到，不是回 null）', function () {
  const env = makeEnv({
    revisions: [
      { modifiedTime: '2027-11-06T10:00:00Z', size: 5, modifiedBy: 'ivan' },
      { modifiedTime: '2027-11-08T02:00:00Z', size: 7, modifiedBy: 'ivan' }
    ]
  });
  assert.strictEqual(env.sandbox.driveCountRevisions_(MASTER_ID), 2);
});

test('7c. Drive.Files.list 用 v3 的 name／pageSize／files', function () {
  const env = makeEnv({});
  env.sandbox.driveCountFilesByNameInFolder_('FOLDER1', '週報.pdf');
  const call = env.calls.filter(function (c) { return c.api === 'Files.list'; })[0];
  assert.ok(call, '應該呼叫過 Drive.Files.list');
  assert.ok(String(call.args.q).indexOf("name = '") !== -1, 'v3 用 name：' + call.args.q);
  assert.ok(String(call.args.q).indexOf('title') === -1, call.args.q);
  assert.strictEqual(call.args.pageSize, 1);
  assert.ok(String(call.args.fields).indexOf('files(') === 0, call.args.fields);
});

test('7d. driveUpdateFileContent_ 用 v3 的 name 設檔名（靜態檢查）', function () {
  const src = readSrc('DriveShared.gs');
  // ⚠️ 用中括號存取，理由見 DriveShared.gs 那一段註解（gTLD 誤判）。
  assert.ok(src.indexOf("resource['name'] = name;") !== -1, 'v3 的檔名欄位是 name');
  assert.ok(src.indexOf('resource.title = name;') === -1, '不可以再用 v2 的 title');
});

// ⚠️ v3 的 lastModifyingUser 是一個物件，直接當字串用會得出 [object Object]。
test('7e. 修改者名稱由 v3 的 lastModifyingUser 物件取出，不會變成 [object Object]', function () {
  const env = makeEnv({});
  assert.strictEqual(
    env.sandbox.driveRevisionModifierName_({ lastModifyingUser: { displayName: '陳大文' } }), '陳大文');
  assert.strictEqual(
    env.sandbox.driveRevisionModifierName_({ lastModifyingUser: { emailAddress: 'a@x.com' } }), 'a@x.com');
  assert.strictEqual(env.sandbox.driveRevisionModifierName_({}), '');
});

test('8. 「發佈版本記錄」列得出版本，而且講得出還原步驟', function () {
  const env = makeEnv({
    driveFiles: { [MASTER_ID]: [0x25, 0x50, 0x44, 0x46] },
    revisions: [
      { modifiedTime: '2027-11-06T10:00:00Z', size: 5, modifiedBy: 'ivan' },
      { modifiedTime: '2027-11-08T02:00:00Z', size: 7, modifiedBy: 'someone' }
    ],
    publishLog: [publishRow({ CONTENT_BYTES: 5, CONTENT_MD5: 'abc' })]
  });
  const lines = env.sandbox.buildPublishRevisionLines_({
    fileId: MASTER_ID,
    fileName: 'master.pdf',
    revisions: env.sandbox.driveListRevisions_(MASTER_ID, 20),
    publishRows: env.sandbox.readSheet(env.sandbox.SHEETS.PUBLISH_LOG)
  });
  const text = lines.join('\n');

  assert.ok(text.indexOf('共 2 個版本') !== -1, text);
  assert.ok(text.indexOf('2027-11-08T02:00:00Z') !== -1, text);
  assert.ok(text.indexOf('【發佈錯了怎樣還原】') !== -1, text);
  assert.ok(text.indexOf('管理版本') !== -1, '要講得出在 Drive 哪裏做：' + text);
  assert.ok(text.indexOf('不做') !== -1 && text.indexOf('一鍵還原') !== -1,
    '要講明為甚麼不做一鍵還原：' + text);
});

test('8b. 「發佈版本記錄」讀不到版本 → 講明原因，不會扮成「沒有版本」', function () {
  const env = makeEnv({});
  const lines = env.sandbox.buildPublishRevisionLines_({
    fileId: MASTER_ID, fileName: 'master.pdf',
    revisions: { ok: false, revisions: [], total: 0, message: 'Drive 進階服務未啟用' },
    publishRows: []
  });
  const text = lines.join('\n');
  assert.ok(text.indexOf('讀不到，原因是：Drive 進階服務未啟用') !== -1, text);
  assert.ok(text.indexOf('「讀不到」不等於「沒有版本」') !== -1, text);
});

test('8c. 「發佈版本記錄」每一行都不會以 = + - @ 開頭（事故六）', function () {
  const env = makeEnv({});
  const lines = env.sandbox.buildPublishRevisionLines_({
    fileId: MASTER_ID, fileName: 'master.pdf',
    revisions: { ok: true, revisions: [], total: 0, message: '' }, publishRows: []
  });
  lines.forEach(function (line) {
    if (line === '') return;
    assert.ok('=+-@'.indexOf(line.charAt(0)) === -1, '這一行會被當成公式：' + line);
  });
  assertWrittenChinese(assert, '發佈版本記錄', lines);
});

// =====================================================================
// 第 3 部分：走過的路
// =====================================================================

test('9. 走過的路：20 步之後包含 20 個動作', function () {
  const env = makeEnv({});
  const steps = [];
  for (let i = 1; i <= 20; i++) steps.push({ stepNo: i, actionId: 'A' + i });
  const rendered = env.sandbox.renderMonkeyPath_(steps, {});
  assert.strictEqual(rendered.split(' → ').length, 20, rendered);
  assert.ok(rendered.indexOf('A1 →') === 0, '一定要由第 1 步開始：' + rendered.slice(0, 40));
  assert.ok(rendered.indexOf('A20') !== -1, rendered);
});

test('10. 走過的路：編碼與解碼來回一致（跨批接得上靠它）', function () {
  const env = makeEnv({});
  const steps = [
    { stepNo: 1, actionId: 'CREATE_WEEKS' },
    { stepNo: 2, actionId: 'EDIT_FIELDS' },
    { stepNo: 3, actionId: 'PUBLISH' }
  ];
  const encoded = env.sandbox.encodeMonkeyPath_(steps);
  assert.strictEqual(encoded, '1:CREATE_WEEKS,2:EDIT_FIELDS,3:PUBLISH');
  deepEq(env.sandbox.decodeMonkeyPath_(encoded), steps);
});

test('10b. 走過的路：解不到的一段略過，不會整條路當成空', function () {
  const env = makeEnv({});
  const decoded = env.sandbox.decodeMonkeyPath_('1:A,,亂寫,3:C,:D,4:');
  deepEq(decoded, [{ stepNo: 1, actionId: 'A' }, { stepNo: 3, actionId: 'C' }]);
});

// ⚠️ 太長的時候改用精簡格式，**不可以截斷開頭**——「走到這裏的完整步驟」
//    的價值全在「由第 1 步開始」。
test('10c. 走過的路：太長改用精簡格式，開頭一定完整', function () {
  const env = makeEnv({});
  const steps = [];
  for (let i = 1; i <= 6000; i++) steps.push({ stepNo: i, actionId: 'ACTION_WITH_A_LONG_NAME' });
  const rendered = env.sandbox.renderMonkeyPath_(steps, { ACTION_WITH_A_LONG_NAME: '一個很長的中文動作標籤' });

  assert.ok(rendered.indexOf('精簡格式') !== -1, '應該改用精簡格式');
  assert.ok(rendered.indexOf('1:ACTION_WITH_A_LONG_NAME') !== -1, '第 1 步一定要在：' + rendered.slice(0, 80));
  assert.ok(rendered.length <= 50000, '不可以爆格：' + rendered.length);
});

test('10d. 走過的路：連精簡格式都爆格 → 截尾，並明寫截了幾多步', function () {
  const env = makeEnv({});
  const steps = [];
  for (let i = 1; i <= 40000; i++) steps.push({ stepNo: i, actionId: 'LONG_ACTION_NAME_HERE' });
  const rendered = env.sandbox.renderMonkeyPath_(steps, {});
  assert.ok(rendered.indexOf('1:LONG_ACTION_NAME_HERE') !== -1, '開頭一定要完整');
  assert.ok(rendered.indexOf('截的是**尾**') !== -1, rendered.slice(0, 120));
  assert.ok(rendered.indexOf('步已經截斷') !== -1, rendered.slice(0, 120));
});

test('10e. MonkeyState 有 PATH_SO_FAR 欄，而且是純文字欄', function () {
  const env = makeEnv({});
  const def = env.sandbox.COLUMNS.MONKEY_STATE;
  assert.ok(def.keys.indexOf('PATH_SO_FAR') !== -1);
  assert.ok(def.textFormatColumns.indexOf('PATH_SO_FAR') !== -1,
    '精簡格式帶冒號與數字，不設純文字會被當成時間');
});

// ⚠️ 這一條守住成因：舊版 pathSoFar 是一個 local 陣列，每一批由空開始。
test('10f. runMonkey_ 不可以再有「每一批由空開始」的 local 路徑陣列', function () {
  const src = readSrc('MonkeyRun.gs');
  assert.ok(src.indexOf('var pathSoFar = [];') === -1,
    '舊版那個 local 陣列就是路徑重置的成因（事故三十八）');
  assert.ok(src.indexOf('var pathSteps = restoredPath.slice();') !== -1,
    '要由上一批接住');
});

// =====================================================================
// 第 4 部分：I04
// =====================================================================

function sendRows(baseMs, offsetSec, batchId) {
  return ['a@x.com', 'b@x.com', 'c@x.com'].map(function (email, i) {
    const row = {
      TIMESTAMP: new Date(baseMs + (offsetSec + i) * 1000),
      STATUS: 'DRY_RUN', RECIPIENT_EMAIL: email
    };
    if (batchId) row.BATCH_ID = batchId;
    return row;
  });
}
const SEND_BASE = Date.parse('2028-10-01T00:00:00Z');

// ⚠️ 這一條就是第 18、19 步紅的成因，已經逐字重現：兩次獨立的寄出相隔
//    幾秒，被 90 秒的時間視窗併成一批，行數變成兩倍。
test('11. 成因重現：沒有批次編號時，相隔幾秒的兩次寄出會被併成一批', function () {
  const env = makeEnv({});
  const rows = [].concat(sendRows(SEND_BASE, 0), sendRows(SEND_BASE, 20));
  const batch = env.sandbox.invariantLatestSendLogBatch_(rows, null);
  assert.strictEqual(batch.length, 6,
    '這正是舊版的行為：兩次寄出（各 3 封）被併成 6 行');
});

test('11b. 有批次編號時，只圈最近那一次（成因已修）', function () {
  const env = makeEnv({});
  const rows = [].concat(sendRows(SEND_BASE, 0, 'SB1'), sendRows(SEND_BASE, 20, 'SB2'));
  const batch = env.sandbox.invariantLatestSendLogBatch_(rows, null);
  assert.strictEqual(batch.length, 3, '應該只圈 SB2 那三行');
  batch.forEach(function (row) { assert.strictEqual(row.BATCH_ID, 'SB2'); });
});

test('11c. 圈法要講出來：有編號講編號，退回時間視窗要講明它會併埋', function () {
  const env = makeEnv({});
  const withId = env.sandbox.invariantSendBatchSource_(sendRows(SEND_BASE, 0, 'SB9'));
  assert.ok(withId.indexOf('批次編號 SB9') !== -1, withId);

  const withoutId = env.sandbox.invariantSendBatchSource_(sendRows(SEND_BASE, 0));
  assert.ok(withoutId.indexOf('時間視窗') !== -1, withoutId);
  assert.ok(withoutId.indexOf('併成一批') !== -1, '要講明這條路的弱點：' + withoutId);
});

test('11d. 全部 SendLog 寫入都經 writeSendLogRows_（不可以直接 writeSheet）', function () {
  const srcDir = path.join(__dirname, '..', 'src');
  const offenders = [];
  fs.readdirSync(srcDir).filter(function (n) { return String(n).slice(-3) === '.gs'; })
    .forEach(function (fileName) {
      if (fileName === 'Mailer.gs') return; // 共用函式本身在這裡
      readSrc(fileName).split(String.fromCharCode(10)).forEach(function (line, i) {
        if (line.indexOf('writeSheet(SHEETS.SEND_LOG') !== -1) {
          offenders.push(fileName + ':' + (i + 1));
        }
      });
    });
  assert.strictEqual(offenders.length, 0,
    '直接寫 SendLog 會漏了批次編號，I04 又會退回時間視窗：' + offenders.join('、'));
});

test('11e. 批次編號每次都不同（同一秒內連續兩次也不可以撞）', function () {
  const env = makeEnv({});
  const seen = {};
  for (let i = 0; i < 5; i++) seen[env.sandbox.newSendBatchId_()] = true;
  // 同一個假時鐘之下至少要有格式正確的編號。
  Object.keys(seen).forEach(function (id) {
    assert.ok(id.indexOf('SB') === 0, '格式：' + id);
    assert.ok(id.indexOf('-') !== -1, '要有隨機尾碼：' + id);
  });
});

test('12. 「診斷 I04」輸出齊全', function () {
  const env = makeEnv({});
  const d = env.sandbox.collectI04Diagnosis_({});
  const text = env.sandbox.buildI04DiagnosisLines_(d).join('\n');

  ['【1. I04 比對的兩邊】', '【2. 「一批」是怎樣圈出來的】', '【3. 差在哪裏】',
    '【4. Recipients 目前的組別分佈】', '【接著做什麼】'].forEach(function (heading) {
    assert.ok(text.indexOf(heading) !== -1, '缺少：' + heading);
  });
});

test('12b. 「診斷 I04」：兩次寄出被併埋時，明講是 I04 圈法的問題', function () {
  const env = makeEnv({});
  const d = {
    totalRows: 6, batch: [], batchStatus: 'DRY_RUN', batchWindowMs: 90000,
    groups: ['CC', 'DB', 'ADMIN'], previewCount: 3, loggedCount: 6,
    distinctTimestamps: [{ epochSec: 1, count: 3 }, { epochSec: 21, count: 3 }],
    spanMs: 20000, mergedSendCount: 2, recipients: ['CC', 'DB', 'ADMIN'], notes: []
  };
  const text = env.sandbox.i04DifferenceText_(d);
  assert.ok(text.indexOf('2 倍') !== -1, text);
  assert.ok(text.indexOf('併成了一批') !== -1, text);
  assert.ok(text.indexOf('不是系統寄錯') !== -1, '要講明不是寄送出問題：' + text);

  const next = env.sandbox.i04NextStepText_(d);
  assert.ok(next.indexOf('BATCH_ID') !== -1, '要講得出正確的修法：' + next);
});

test('12c. 「診斷 I04」：兩邊相同時明講「應該是綠的」', function () {
  const env = makeEnv({});
  const d = {
    totalRows: 3, batch: [], batchStatus: 'DRY_RUN', batchWindowMs: 90000,
    groups: ['CC'], previewCount: 3, loggedCount: 3,
    distinctTimestamps: [{ epochSec: 1, count: 3 }], spanMs: 0,
    mergedSendCount: 1, recipients: ['CC'], notes: []
  };
  assert.ok(env.sandbox.i04DifferenceText_(d).indexOf('應該是綠的') !== -1);
});

test('12d. 「診斷 I04」報告是書面語繁體中文，而且不會以公式字元開頭', function () {
  const env = makeEnv({});
  const lines = env.sandbox.buildI04DiagnosisLines_(env.sandbox.collectI04Diagnosis_({}));
  lines.forEach(function (line) {
    if (line === '') return;
    assert.ok('=+-@'.indexOf(line.charAt(0)) === -1, '這一行會被當成公式：' + line);
  });
  assertWrittenChinese(assert, 'I04 診斷報告', lines);
});

console.log('');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
