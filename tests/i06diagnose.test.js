#!/usr/bin/env node
/**
 * tests/i06diagnose.test.js
 *
 * 第三輪自測 第 2 部分：「診斷 I06」與「重新對齊 I06」。
 *
 * ⚠️ 這一輪的紀律是「**先拿證據，看清楚才改**」。所以這個檔案首先驗的是
 * 診斷報告本身：七項**逐項都要有一行**，取不到的一項要明確寫「取不到，
 * 原因是⋯⋯」——一項靜靜不見了，看報告的人會以為那一項沒有問題。
 *
 * 執行方式：node tests/i06diagnose.test.js
 * 離開碼：0＝全部通過　1＝有測試失敗
 */

'use strict';

const assert = require('assert');
const crypto = require('crypto');
const { loadAllSrcFilesInOrder } = require('./helpers/loadGas');
const { makeFakeSheet, makeFakeSpreadsheet } = require('./helpers/fakeSpreadsheet');
const { assertWrittenChinese } = require('./helpers/writtenChinese');

const TARGET_DATE = '2027-11-07';
const MASTER_ID = 'MASTER_FILE_1';
const ARCHIVE_ID = 'ARCHIVE_FILE_1';

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

function md5Fingerprint(bytes) {
  return bytes.length + ':' + crypto.createHash('md5').update(Buffer.from(bytes)).digest('hex');
}

function baseStubs(o) {
  return {
    Logger: { log: function () {} },
    Utilities: {
      formatDate: function (d) { return d.toISOString().slice(0, 10); },
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
        if (!o.__scriptProps) o.__scriptProps = Object.assign({}, o.scriptProps || {});
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
  cfg.PUBLISHED_PDF_FILE_ID = o.noMaster ? '' : MASTER_ID;
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

  const sandbox = loadAllSrcFilesInOrder(Object.assign({}, baseStubs(o), {
    SpreadsheetApp: {
      getActiveSpreadsheet: function () { return makeFakeSpreadsheet(sheets); },
      getUi: function () {
        return {
          alert: function () { return 'OK'; },
          ButtonSet: { OK: 'OK', YES_NO: 'YES_NO' },
          Button: { OK: 'OK', YES: 'YES', NO: 'NO' }
        };
      }
    },
    DriveApp: {
      getFileById: function (id) {
        const files = o.driveFiles || {};
        if (!Object.prototype.hasOwnProperty.call(files, id)) {
          throw new Error('No item with the given ID could be found: ' + id);
        }
        const bytes = files[id];
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
    }
  }));

  return { sandbox: sandbox, sheets: sheets, boot: boot, scriptProps: o.__scriptProps };
}

function publishRow(overrides) {
  return Object.assign({
    SERVICE_DATE: TARGET_DATE, VERSION_NO: 2, PUBLISHED_AT: '2027-11-06',
    PUBLISHED_BY: 'ivan@example.com', ARCHIVE_FILE_ID: ARCHIVE_ID, SENT: true,
    SENT_GROUPS: 'CC,DB', MISSING_COUNT: 0, FORCED: false, FORCED_REASON: '',
    MASTER_FILE_ID: MASTER_ID, IS_SELFTEST: false
  }, overrides || {});
}

/** 一個「七項齊全」的環境。 */
function fullEnv(extra) {
  const masterBytes = (extra && extra.masterBytes) || [0x25, 0x50, 0x44, 0x46, 0x01];
  const rowBytes = (extra && extra.rowBytes) || masterBytes;
  const fp = md5Fingerprint(rowBytes).split(':');
  return makeEnv(Object.assign({
    driveFiles: {
      [MASTER_ID]: masterBytes,
      [ARCHIVE_ID]: [0x25, 0x50, 0x44, 0x46, 0x09]
    },
    publishLog: [publishRow({ CONTENT_BYTES: Number(fp[0]), CONTENT_MD5: fp[1] })],
    revisionLister: null
  }, (extra && extra.env) || {}));
}

/** 一個假的版本記錄列舉器（真的 Drive.Revisions 在測試環境沒有）。 */
function fakeRevisions(items) {
  return function () {
    return { ok: true, revisions: items, total: items.length, message: '' };
  };
}

// =====================================================================
// 1-7. 七項輸出
// =====================================================================

test('七項全部有標題，一項都不可以少', function () {
  const env = fullEnv();
  const d = env.sandbox.collectI06Diagnosis_({
    revisionLister: fakeRevisions([{ id: 'r2', modifiedDate: '2027-11-06T10:00:00Z', fileSize: 5, modifiedBy: 'ivan' }])
  });
  const text = env.sandbox.buildI06DiagnosisLines_(d).join('\n');

  ['【1. PublishLog 最新一行（非自測）】',
    '【2. 該行的 master 檔案 ID vs Config 現值】',
    '【3. 該行的存檔副本】',
    '【4. master 檔案目前的實況】',
    '【5. Drive 版本記錄】',
    '【6. I06 實際比對的兩樣東西】',
    '【7. 差在哪裏】'].forEach(function (heading) {
    assert.ok(text.indexOf(heading) !== -1, '缺少：' + heading + '\n' + text);
  });
});

test('1. 最新一行的**全部**欄位值都印出來（一欄都不可以漏）', function () {
  const env = fullEnv();
  const d = env.sandbox.collectI06Diagnosis_({ revisionLister: fakeRevisions([]) });
  const text = env.sandbox.buildI06DiagnosisLines_(d).join('\n');

  env.sandbox.COLUMNS.PUBLISH_LOG.keys.forEach(function (key) {
    assert.ok(text.indexOf(key + '：') !== -1, '沒有印出欄位 ' + key + '\n' + text);
  });
});

test('2. 該行 MASTER_FILE_ID 與 Config 相同 → 講「相同」；不同 → 講「不同」並指路', function () {
  const same = fullEnv();
  const sameText = same.sandbox.buildI06DiagnosisLines_(
    same.sandbox.collectI06Diagnosis_({ revisionLister: fakeRevisions([]) })).join('\n');
  assert.ok(sameText.indexOf('兩者相同') !== -1, sameText);

  const diff = makeEnv({
    driveFiles: { OTHER_MASTER: [0x25, 0x50, 0x44, 0x46], [ARCHIVE_ID]: [0x25] },
    publishLog: [publishRow({ MASTER_FILE_ID: 'OTHER_MASTER' })]
  });
  const diffText = diff.sandbox.buildI06DiagnosisLines_(
    diff.sandbox.collectI06Diagnosis_({ revisionLister: fakeRevisions([]) })).join('\n');
  assert.ok(diffText.indexOf('兩者**不同**') !== -1, diffText);
  assert.ok(diffText.indexOf('應該用該行那一個') !== -1, diffText);
});

test('3. 存檔副本：拿得到就報位元組數與指紋', function () {
  const env = fullEnv();
  const d = env.sandbox.collectI06Diagnosis_({ revisionLister: fakeRevisions([]) });
  assert.strictEqual(d.archive.ok, true);
  assert.strictEqual(d.archive.bytes, 5);
  assert.ok(d.archive.fingerprint.length > 0);
});

// ⚠️ 取不到的一項要**明確寫出原因**，不可以整項消失。
test('3b. 存檔副本開不到 → 寫「取不到，原因是⋯⋯」，那一項照樣出現', function () {
  const env = makeEnv({
    driveFiles: { [MASTER_ID]: [0x25, 0x50, 0x44, 0x46] },
    publishLog: [publishRow({ ARCHIVE_FILE_ID: 'MISSING_ARCHIVE' })]
  });
  const text = env.sandbox.buildI06DiagnosisLines_(
    env.sandbox.collectI06Diagnosis_({ revisionLister: fakeRevisions([]) })).join('\n');
  assert.ok(text.indexOf('【3. 該行的存檔副本】') !== -1, text);
  assert.ok(text.indexOf('取不到，原因是') !== -1, text);
});

test('3c. 該行根本沒有 ARCHIVE_FILE_ID → 一樣講明原因', function () {
  const env = makeEnv({
    driveFiles: { [MASTER_ID]: [0x25, 0x50, 0x44, 0x46] },
    publishLog: [publishRow({ ARCHIVE_FILE_ID: '' })]
  });
  const text = env.sandbox.buildI06DiagnosisLines_(
    env.sandbox.collectI06Diagnosis_({ revisionLister: fakeRevisions([]) })).join('\n');
  assert.ok(text.indexOf('沒有 ARCHIVE_FILE_ID') !== -1, text);
});

test('4. master 檔案：位元組數、指紋、最後修改時間、擁有者、MIME 全部有', function () {
  const env = fullEnv();
  const text = env.sandbox.buildI06DiagnosisLines_(
    env.sandbox.collectI06Diagnosis_({ revisionLister: fakeRevisions([]) })).join('\n');
  assert.ok(text.indexOf('最後修改時間：') !== -1, text);
  assert.ok(text.indexOf('擁有者：') !== -1, text);
  assert.ok(text.indexOf('MIME：') !== -1, text);
});

// ⚠️ 「讀不到版本記錄」與「真的一個版本都沒有」是兩件事，要分得開。
test('5. 版本記錄讀不到 → 寫原因；真的 0 個 → 明講「真的一個版本都沒有」', function () {
  const env = fullEnv();

  const unavailable = env.sandbox.buildI06DiagnosisLines_(
    env.sandbox.collectI06Diagnosis_({
      revisionLister: function () {
        return { ok: false, revisions: [], total: 0, message: 'Drive 進階服務未啟用' };
      }
    })).join('\n');
  assert.ok(unavailable.indexOf('取不到，原因是：Drive 進階服務未啟用') !== -1, unavailable);

  const zero = env.sandbox.buildI06DiagnosisLines_(
    env.sandbox.collectI06Diagnosis_({ revisionLister: fakeRevisions([]) })).join('\n');
  assert.ok(zero.indexOf('真的一個版本都沒有（不是讀不到）') !== -1, zero);
});

test('5b. 有版本記錄 → 逐個印出時間與大小', function () {
  const env = fullEnv();
  const text = env.sandbox.buildI06DiagnosisLines_(
    env.sandbox.collectI06Diagnosis_({
      revisionLister: fakeRevisions([
        { id: 'r2', modifiedDate: '2027-11-08T02:00:00Z', fileSize: 7, modifiedBy: 'someone' },
        { id: 'r1', modifiedDate: '2027-11-06T10:00:00Z', fileSize: 5, modifiedBy: 'ivan' }
      ])
    })).join('\n');
  assert.ok(text.indexOf('共 2 個版本') !== -1, text);
  assert.ok(text.indexOf('2027-11-08T02:00:00Z') !== -1, text);
  assert.ok(text.indexOf('7 位元組') !== -1, text);
});

// ⚠️ 第 6 項是這份報告的核心：兩邊的**來源名稱**要明確寫出來，
//    不是只印兩個值。第三輪之前那句「1 條通道對不上（正式）」看完之後
//    仍然不知道兩邊分別取自哪裏。
test('6. 兩邊的來源名稱明確寫出來（不是只印兩個值）', function () {
  const env = fullEnv();
  const d = env.sandbox.collectI06Diagnosis_({ revisionLister: fakeRevisions([]) });
  const text = env.sandbox.buildI06DiagnosisLines_(d).join('\n');

  assert.ok(text.indexOf('左邊：') !== -1 && text.indexOf('右邊：') !== -1, text);
  assert.ok(d.comparison.leftName.indexOf('Script Property') !== -1, d.comparison.leftName);
  assert.ok(d.comparison.rightName.indexOf('Drive 檔案') !== -1, d.comparison.rightName);
  assert.ok(text.indexOf('PublishLog 那一行講的是：') !== -1, text);
});

test('7. 大小不同 → 講「大小不同」並算出差幾多位元組', function () {
  const env = fullEnv({
    rowBytes: [0x25, 0x50, 0x44, 0x46, 0x01],
    masterBytes: [0x25, 0x50, 0x44, 0x46, 0x01, 0xAA, 0xBB]
  });
  const d = env.sandbox.collectI06Diagnosis_({
    revisionLister: fakeRevisions([]),
    fingerprintReader: function () {
      return {
        isoDate: TARGET_DATE, versionNo: 2,
        fingerprint: md5Fingerprint([0x25, 0x50, 0x44, 0x46, 0x01]), masterFileId: MASTER_ID
      };
    }
  });
  assert.strictEqual(d.difference.kind, 'CONTENT_MISMATCH');
  assert.ok(d.difference.summary.indexOf('大小不同') !== -1, d.difference.summary);
  assert.ok(d.difference.detail.indexOf('差 2 位元組') !== -1, d.difference.detail);
});

test('7b. 大小相同但 MD5 不同 → 講「大小相同」，不會亂講大小差', function () {
  const env = fullEnv({ masterBytes: [0x25, 0x50, 0x44, 0x46, 0x02] });
  const d = env.sandbox.collectI06Diagnosis_({
    revisionLister: fakeRevisions([]),
    fingerprintReader: function () {
      return {
        isoDate: TARGET_DATE, versionNo: 2,
        fingerprint: md5Fingerprint([0x25, 0x50, 0x44, 0x46, 0x01]), masterFileId: MASTER_ID
      };
    }
  });
  assert.strictEqual(d.difference.kind, 'CONTENT_MISMATCH');
  assert.ok(d.difference.summary.indexOf('大小相同') !== -1, d.difference.summary);
});

// ⚠️ 這一條就是第三輪那個假紅的診斷結果：指紋記錄講的是另一次發佈。
test('7c. 指紋記錄講的是另一次發佈 → kind 是 VERSION_MISMATCH，並講明那份指紋不屬於這一行', function () {
  const env = fullEnv();
  const d = env.sandbox.collectI06Diagnosis_({
    revisionLister: fakeRevisions([]),
    fingerprintReader: function () {
      return { isoDate: '2028-10-01', versionNo: 4, fingerprint: 'SANDBOX_FP', masterFileId: '' };
    }
  });
  assert.strictEqual(d.difference.kind, 'VERSION_MISMATCH');
  assert.ok(d.difference.detail.indexOf('不屬於這一行') !== -1, d.difference.detail);
  assert.ok(d.difference.detail.indexOf('得出的「不一致」是假的') !== -1, d.difference.detail);
});

test('7d. 其中一邊取不到 → kind 是 UNAVAILABLE，明講「不等於內容不對」', function () {
  const env = fullEnv();
  const d = env.sandbox.collectI06Diagnosis_({
    revisionLister: fakeRevisions([]),
    fingerprintReader: function () { return null; }
  });
  assert.strictEqual(d.difference.kind, 'UNAVAILABLE');
  assert.ok(d.difference.detail.indexOf('不等於「內容不對」') !== -1, d.difference.detail);
});

// =====================================================================
// 報告的收尾
// =====================================================================

// ⚠️ 看完一堆數字仍然不知道下一步，等於沒有診斷過——這正是第三輪要修的。
test('報告最後一定有「接著做什麼」，而且按結果講不同的話', function () {
  const same = fullEnv();
  const sameText = same.sandbox.buildI06DiagnosisLines_(
    same.sandbox.collectI06Diagnosis_({
      revisionLister: fakeRevisions([]),
      fingerprintReader: function () {
        return {
          isoDate: TARGET_DATE, versionNo: 2,
          fingerprint: md5Fingerprint([0x25, 0x50, 0x44, 0x46, 0x01]), masterFileId: MASTER_ID
        };
      }
    })).join('\n');
  assert.ok(sameText.indexOf('【接著做什麼】') !== -1, sameText);
  assert.ok(sameText.indexOf('應該是綠的') !== -1, sameText);

  const changed = fullEnv({ masterBytes: [0x25, 0x50, 0x44, 0x46, 0x01, 0xAA] });
  const changedText = changed.sandbox.buildI06DiagnosisLines_(
    changed.sandbox.collectI06Diagnosis_({
      revisionLister: fakeRevisions([]),
      fingerprintReader: function () {
        return {
          isoDate: TARGET_DATE, versionNo: 2,
          fingerprint: md5Fingerprint([0x25, 0x50, 0x44, 0x46, 0x01]), masterFileId: MASTER_ID
        };
      }
    })).join('\n');
  assert.ok(changedText.indexOf('重新對齊 I06') !== -1, changedText);
});

test('報告每一行都不會以 = + - @ 開頭（事故六）', function () {
  const env = fullEnv();
  const lines = env.sandbox.buildI06DiagnosisLines_(
    env.sandbox.collectI06Diagnosis_({ revisionLister: fakeRevisions([]) }));
  lines.forEach(function (line) {
    if (line === '') return;
    assert.ok('=+-@'.indexOf(line.charAt(0)) === -1, '這一行會被當成公式：' + line);
  });
});

test('報告是書面語繁體中文', function () {
  const env = fullEnv();
  const lines = env.sandbox.buildI06DiagnosisLines_(
    env.sandbox.collectI06Diagnosis_({ revisionLister: fakeRevisions([]) }));
  assertWrittenChinese(assert, 'I06 診斷報告', lines);
});

test('沒有任何非自測發佈紀錄 → 講明「應該回不適用，不是對不上」', function () {
  const env = makeEnv({ driveFiles: {}, publishLog: [] });
  const d = env.sandbox.collectI06Diagnosis_({ revisionLister: fakeRevisions([]) });
  const text = env.sandbox.buildI06DiagnosisLines_(d).join('\n');
  assert.ok(text.indexOf('不適用') !== -1, text);
  assert.ok(text.indexOf('那是 I06 的 bug') !== -1, '要講明如果 I06 報「對不上」就是它的 bug：' + text);
});

// =====================================================================
// 重新對齊
// =====================================================================

test('重新對齊：把 master 目前的指紋寫回該行的 CONTENT_BYTES／CONTENT_MD5', function () {
  const masterBytes = [0x25, 0x50, 0x44, 0x46, 0x01, 0xAA];
  const env = makeEnv({
    driveFiles: { [MASTER_ID]: masterBytes, [ARCHIVE_ID]: [0x25] },
    publishLog: [publishRow({ CONTENT_BYTES: 5, CONTENT_MD5: 'oldmd5' })]
  });

  const result = env.sandbox.realignI06Fingerprint_({});
  assert.strictEqual(result.ok, true, result.message);
  assert.strictEqual(result.fingerprint, md5Fingerprint(masterBytes));

  const row = env.sandbox.readSheet(env.sandbox.SHEETS.PUBLISH_LOG)[0];
  assert.strictEqual(Number(row.CONTENT_BYTES), masterBytes.length);
  assert.strictEqual(String(row.CONTENT_MD5), md5Fingerprint(masterBytes).split(':')[1]);
});

// ⚠️ 對齊之後 I06 要真的變綠——否則這個動作等於騙人。
test('重新對齊之後，I06 的正式通道由紅變綠', function () {
  const masterBytes = [0x25, 0x50, 0x44, 0x46, 0x01, 0xAA];
  const env = makeEnv({
    driveFiles: { [MASTER_ID]: masterBytes, [ARCHIVE_ID]: [0x25] },
    publishLog: [publishRow({ CONTENT_BYTES: 5, CONTENT_MD5: 'oldmd5' })]
  });

  assert.strictEqual(env.sandbox.runInvariantI06_().ok, false, '對齊之前應該是紅的');
  env.sandbox.realignI06Fingerprint_({});
  assert.strictEqual(env.sandbox.runInvariantI06_().ok, true, '對齊之後應該是綠的');
});

test('重新對齊：**不會碰 Drive 檔案**，只改 PublishLog 兩格', function () {
  const masterBytes = [0x25, 0x50, 0x44, 0x46, 0x01, 0xAA];
  const env = makeEnv({
    driveFiles: { [MASTER_ID]: masterBytes, [ARCHIVE_ID]: [0x25] },
    publishLog: [publishRow({ CONTENT_BYTES: 5, CONTENT_MD5: 'oldmd5' })]
  });

  const before = env.sandbox.readSheet(env.sandbox.SHEETS.PUBLISH_LOG)[0];
  env.sandbox.realignI06Fingerprint_({});
  const after = env.sandbox.readSheet(env.sandbox.SHEETS.PUBLISH_LOG)[0];

  // Drive 那一份位元組完全沒有變。
  assert.strictEqual(JSON.stringify(masterBytes), JSON.stringify([0x25, 0x50, 0x44, 0x46, 0x01, 0xAA]));
  // 其他欄位一格都沒有動。
  ['SERVICE_DATE', 'VERSION_NO', 'PUBLISHED_BY', 'ARCHIVE_FILE_ID', 'MASTER_FILE_ID', 'IS_SELFTEST']
    .forEach(function (key) {
      assert.strictEqual(String(after[key]), String(before[key]), key + ' 不應該被改');
    });
});

test('重新對齊：讀不到 master → 回 ok:false 並講明「讀不到不等於沒問題」', function () {
  const env = makeEnv({
    driveFiles: {},
    publishLog: [publishRow()]
  });
  const result = env.sandbox.realignI06Fingerprint_({});
  assert.strictEqual(result.ok, false);
  assert.ok(result.message.indexOf('讀不到') !== -1, result.message);
  assert.ok(result.message.indexOf('不等於「沒問題」') !== -1, result.message);
});

test('重新對齊：沒有非自測紀錄 → 回 ok:false，不會亂寫', function () {
  const env = makeEnv({ driveFiles: { [MASTER_ID]: [0x25] }, publishLog: [] });
  const result = env.sandbox.realignI06Fingerprint_({});
  assert.strictEqual(result.ok, false);
  assert.ok(result.message.indexOf('沒有東西可以對齊') !== -1, result.message);
});

test('重新對齊：只動最新那一行，舊行不受影響', function () {
  const masterBytes = [0x25, 0x50, 0x44, 0x46, 0x01, 0xAA];
  const env = makeEnv({
    driveFiles: { [MASTER_ID]: masterBytes, [ARCHIVE_ID]: [0x25] },
    publishLog: [
      publishRow({ VERSION_NO: 1, PUBLISHED_AT: '2027-11-01', CONTENT_BYTES: 3, CONTENT_MD5: 'first' }),
      publishRow({ VERSION_NO: 2, PUBLISHED_AT: '2027-11-06', CONTENT_BYTES: 5, CONTENT_MD5: 'second' })
    ]
  });

  env.sandbox.realignI06Fingerprint_({});
  const rows = env.sandbox.readSheet(env.sandbox.SHEETS.PUBLISH_LOG);
  assert.strictEqual(String(rows[0].CONTENT_MD5), 'first', '舊行不可以被動');
  assert.strictEqual(String(rows[1].CONTENT_MD5), md5Fingerprint(masterBytes).split(':')[1]);
});

console.log('');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
