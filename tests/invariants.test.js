#!/usr/bin/env node
/**
 * tests/invariants.test.js
 *
 * 第 1 層（`src/Invariants.gs`）與第 4 層（`src/OutputAssert.gs`）的回歸測試。
 *
 * ⚠️ 這一組測試自己也是「人手砌 fixture」那一類——它驗的是**不變量本身
 * 的邏輯對不對**（給它一個已知壞的狀態，它會不會紅），不是驗「系統跑
 * 出來的狀態對不對」。後者是第 2 層自測機的職責，只有在真的 Apps
 * Script 環境跑得出來。兩者互補，缺一不可：
 *
 *   - 沒有這一組：不變量自己寫錯了（永遠回綠），沒有人發現。
 *   - 沒有第 2 層：不變量寫得對，但沒有人拿真實狀態餵給它。
 *
 * 所以這裡刻意**每一條不變量都要有一個「應該紅」的案例**——只驗「正常
 * 情況下是綠」的話，一支永遠回 true 的函式也會全部通過。
 *
 * 執行方式：node tests/invariants.test.js
 * 離開碼：0＝全部通過　1＝有測試失敗
 */

'use strict';

const assert = require('assert');
const crypto = require('crypto');
const { loadAllSrcFilesInOrder } = require('./helpers/loadGas');
const { makeFakeSheet, makeFakeSpreadsheet } = require('./helpers/fakeSpreadsheet');
const { makeFakeDriveApp, makeFakeUtilities, buildFakeDocx } = require('./helpers/fakeDrive');
const { assertWrittenChinese } = require('./helpers/writtenChinese');
const fx = require('./fixtures/docxXml');

const FAKE_ROSTER_ID = 'FAKE_ROSTER_FOR_INVARIANTS';
const QUARTER_ID = '2027T4';
const SERVICE_DATES = ['2027-11-07', '2027-11-14', '2027-11-21', '2027-11-28'];
const TARGET_DATE = '2027-11-07';

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

/** 跨 vm realm 安全的深層比較（見 tests/publish.test.js 同一個註解）。 */
function deepEq(actual, expected, message) {
  assert.strictEqual(JSON.stringify(actual), JSON.stringify(expected), message);
}

/** 由一組結果陣列取某一條不變量。 */
function pick(summary, id) {
  return summary.results.filter(function (r) { return r.id === id; })[0];
}

// =====================================================================
// 假環境
// =====================================================================

function baseStubs(o) {
  const opts = o || {};
  return {
    Utilities: Object.assign({
      formatDate: function (date, tz, pattern) {
        const y = date.getFullYear();
        const mo = String(date.getMonth() + 1).padStart(2, '0');
        const d = String(date.getDate()).padStart(2, '0');
        const hh = String(date.getHours()).padStart(2, '0');
        const mi = String(date.getMinutes()).padStart(2, '0');
        if (String(pattern).indexOf('HH') !== -1) return `${y}-${mo}-${d} ${hh}:${mi}`;
        return `${y}-${mo}-${d}`;
      },
      DigestAlgorithm: { MD5: 'MD5' },
      computeDigest: function (algorithm, value) {
        const bytes = Array.isArray(value)
          ? Buffer.from(value.map(function (b) { return b < 0 ? b + 256 : b; }))
          : Buffer.from(String(value), 'utf8');
        return Array.prototype.slice.call(crypto.createHash('md5').update(bytes).digest());
      },
      base64Decode: function (text) {
        const buf = Buffer.from(String(text), 'base64');
        const out = [];
        for (let i = 0; i < buf.length; i++) out.push(buf[i] > 127 ? buf[i] - 256 : buf[i]);
        return out;
      }
    }, opts.utilitiesExtra || {}),
    Session: {
      getScriptTimeZone: function () { return 'Pacific/Auckland'; },
      getActiveUser: function () { return { getEmail: function () { return 'tester@example.com'; } }; }
    },
    CacheService: {},
    HtmlService: {},
    PropertiesService: {
      getUserProperties: function () {
        return { getProperty: function () { return null; }, setProperty: function () {} };
      },
      getScriptProperties: function () {
        if (!opts.__scriptProps) opts.__scriptProps = {};
        const store = opts.__scriptProps;
        return {
          getProperty: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
          setProperty: function (k, v) { store[k] = String(v); return this; }
        };
      }
    }
  };
}

/**
 * 造一個測試環境。
 * options：
 *   config              覆蓋 Config。
 *   weekRows            BulletinWeeks 資料列（預設四個主日各一行）。
 *   announcements/prayers/fellowships/recipients/publishLog/sendLog/contentSheets
 *   numberRegistry      NumberRegistry 資料列（預設用 seed）。
 *   diagnostics         Diagnostics 資料列。
 *   scriptProps         預先放進 ScriptProperties 的值。
 *   masterBytes         master 檔案目前的內容位元組。
 *   docxFiles           { fileId: documentXml } 造出假的產出 .docx。
 *   revisionCount       Drive.Revisions 回報的版本數；null＝讀不到。
 */
function makeEnv(options) {
  const o = options || {};
  if (o.scriptProps) o.__scriptProps = Object.assign({}, o.scriptProps);
  const boot = loadAllSrcFilesInOrder(baseStubs(o));

  const cfg = {};
  boot.DEFAULTS.forEach(function (d) { cfg[d.key] = d.value; });
  cfg.ROSTER_SPREADSHEET_ID = FAKE_ROSTER_ID;
  Object.assign(cfg, o.config || {});

  function ownSheet(sheetId, rows) {
    const def = boot.COLUMNS[sheetId];
    return makeFakeSheet(def.headers, def.keys, rows || []);
  }

  const sheets = {};
  Object.keys(boot.SHEETS).forEach(function (id) { sheets[boot.SHEETS[id]] = ownSheet(id, []); });
  sheets.Config = ownSheet('CONFIG', Object.keys(cfg).map(function (k) {
    return { KEY: k, VALUE: cfg[k], NOTE: '', EDITABLE: true };
  }));
  sheets.BulletinWeeks = ownSheet('BULLETIN_WEEKS', o.weekRows === undefined
    ? SERVICE_DATES.map(function (iso, i) {
      return { SERVICE_DATE: iso, QUARTER_ID: QUARTER_ID, WEEK_OF_MONTH: i + 1, STATUS: 'DRAFT' };
    })
    : o.weekRows);
  sheets.Announcements = ownSheet('ANNOUNCEMENTS', o.announcements || []);
  sheets.Prayers = ownSheet('PRAYERS', o.prayers || []);
  sheets.Fellowships = ownSheet('FELLOWSHIPS', o.fellowships || []);
  sheets.Recipients = ownSheet('RECIPIENTS', o.recipients || []);
  sheets.PublishLog = ownSheet('PUBLISH_LOG', o.publishLog || []);
  sheets.SendLog = ownSheet('SEND_LOG', o.sendLog || []);
  sheets.ContentSheets = ownSheet('CONTENT_SHEETS', o.contentSheets || []);
  sheets.Diagnostics = ownSheet('DIAGNOSTICS', o.diagnostics || []);
  sheets.NumberRegistry = ownSheet('NUMBER_REGISTRY',
    o.numberRegistry === undefined ? boot.seedNumberRegistryRows_() : o.numberRegistry);

  function rosterSheet(defKey, rows) {
    const keys = Object.keys(boot.ROSTER_TABLE_DEFS_[defKey].columns);
    return makeFakeSheet(keys, keys, rows || []);
  }
  const rosterSheets = {
    RosterAssignments: rosterSheet('ASSIGNMENTS', []),
    RosterVersions: rosterSheet('VERSIONS', [{ QuarterID: QUARTER_ID, VersionNo: 1 }]),
    Quarters: rosterSheet('QUARTERS', [{ QuarterID: QUARTER_ID, Stage: 'OFFICIAL_SENT' }]),
    ServiceDates: rosterSheet('SERVICE_DATES', (o.rosterServiceDates === undefined ? SERVICE_DATES : o.rosterServiceDates)
      .map(function (iso, i) {
        return {
          ServiceDateID: 'SD' + (i + 1), QuarterID: QUARTER_ID, ServiceDate: iso,
          WeekIndex: i + 1, IsFirstSundayOfMonth: i === 0, ServiceType: '主日崇拜', SpecialID: ''
        };
      })),
    SpecialSundays: rosterSheet('SPECIAL_SUNDAYS', []),
    NameMapping: rosterSheet('NAME_MAPPING', []),
    Posts: rosterSheet('POSTS', [])
  };

  // ---- 假 Drive：產出 .docx ＋ master PDF ＋ 版本記錄 ----
  const files = {};
  Object.keys(o.docxFiles || {}).forEach(function (fileId) {
    files[fileId] = buildFakeDocx(o.docxFiles[fileId]);
  });
  const drive = makeFakeDriveApp({ files: files, folders: {} });

  const masterFileId = cfg.PUBLISHED_PDF_FILE_ID;
  // 第二輪自測：I06 要分「正式」與「沙盒」兩條通道，所以假 Drive 也要
  // 服務得到沙盒那一個 master 檔案。
  const sandboxMasterFileId = cfg.SELFTEST_MASTER_PDF_FILE_ID;
  function fakePdfFile(id, bytes) {
    return {
      getId: function () { return id; },
      getName: function () { return 'master.pdf'; },
      getBlob: function () { return { getBytes: function () { return bytes.slice(); } }; }
    };
  }
  const FakeDriveApp = Object.assign({}, drive.DriveApp, {
    getFileById: function (id) {
      if (masterFileId && id === masterFileId) {
        if (!o.masterBytes) throw new Error('No item with the given ID could be found: ' + id);
        return fakePdfFile(id, o.masterBytes);
      }
      if (sandboxMasterFileId && id === sandboxMasterFileId) {
        if (!o.sandboxMasterBytes) throw new Error('No item with the given ID could be found: ' + id);
        return fakePdfFile(id, o.sandboxMasterBytes);
      }
      // 任意額外的 PDF 檔案（例如「Config 已經改指另一個，但舊記錄仍然
      // 指住舊那一個」這種情況）。
      if (o.extraPdfFiles && Object.prototype.hasOwnProperty.call(o.extraPdfFiles, id)) {
        return fakePdfFile(id, o.extraPdfFiles[id]);
      }
      return drive.DriveApp.getFileById(id);
    }
  });

  const FakeDrive = Object.assign({}, drive.Drive, {
    Revisions: {
      list: function () {
        if (o.revisionCount === null || o.revisionCount === undefined) {
          throw new Error('Drive.Revisions 不可用');
        }
        // ⚠️ **v3 的形狀**：結果在 `revisions`，不是 v2 的 `items`。
        //    這個假替身本來模仿 v2，與 src/ 那一邊一齊錯——見事故三十七。
        const list = [];
        for (let i = 0; i < o.revisionCount; i++) {
          list.push({ id: 'rev' + i, modifiedTime: '2027-11-0' + (i % 9) + 'T00:00:00Z', size: 100 + i });
        }
        return { revisions: list };
      }
    }
  });

  const sandbox = loadAllSrcFilesInOrder(Object.assign({}, baseStubs(o),
    { Utilities: Object.assign({}, baseStubs(o).Utilities, makeFakeUtilities()) },
    {
      SpreadsheetApp: {
        getActiveSpreadsheet: function () { return makeFakeSpreadsheet(sheets); },
        openById: function (id) {
          if (id !== FAKE_ROSTER_ID) throw new Error('openById: 未預期的 id ' + id);
          return makeFakeSpreadsheet(rosterSheets);
        },
        ProtectionType: { SHEET: 'SHEET' },
        getUi: function () {
          return {
            createMenu: function () {
              const m = {
                addItem: function () { return m; }, addSeparator: function () { return m; },
                addSubMenu: function () { return m; }, addToUi: function () { return m; }
              };
              return m;
            },
            alert: function () { return 'OK'; },
            ButtonSet: { OK: 'OK' }, Button: { OK: 'OK' }
          };
        }
      },
      DriveApp: FakeDriveApp,
      Drive: FakeDrive
    }));

  return { sandbox: sandbox, sheets: sheets, boot: boot };
}

// =====================================================================
// I01
// =====================================================================

test('I01 綠：全部工作表結構齊備', function () {
  const env = makeEnv({});
  const r = env.sandbox.runInvariantI01_();
  assert.strictEqual(r.ok, true, r.evidence);
});

test('I01 紅：某一張表的機器鍵被改壞 → 報紅，而且證據講得出是哪一張表', function () {
  const env = makeEnv({});
  // 把 Announcements 第 2 行的第一個機器鍵改壞——模仿有人手動改動過結構。
  env.sheets.Announcements.getRange(2, 1).setValue('WRONG_KEY');

  const r = env.sandbox.runInvariantI01_();
  assert.strictEqual(r.ok, false);
  assert.ok(r.evidence.indexOf('Announcements') !== -1, r.evidence);
  assert.ok(r.evidence.indexOf('初始化工作表') !== -1, '要指路怎樣修：' + r.evidence);
});

// =====================================================================
// I02
// =====================================================================

test('I02 綠：BulletinWeeks 沒有重複的（季度＋主日）', function () {
  const env = makeEnv({});
  const r = env.sandbox.runInvariantI02_();
  assert.strictEqual(r.ok, true, r.evidence);
});

test('I02 紅：同一個（季度＋主日）出現兩行 → 報紅，證據講得出是哪一組、哪兩行', function () {
  const env = makeEnv({
    weekRows: [
      { SERVICE_DATE: '2027-11-07', QUARTER_ID: QUARTER_ID, WEEK_OF_MONTH: 1, STATUS: 'DRAFT' },
      { SERVICE_DATE: '2027-11-14', QUARTER_ID: QUARTER_ID, WEEK_OF_MONTH: 2, STATUS: 'DRAFT' },
      { SERVICE_DATE: '2027-11-07', QUARTER_ID: QUARTER_ID, WEEK_OF_MONTH: 1, STATUS: 'DRAFT' }
    ]
  });
  const r = env.sandbox.runInvariantI02_();
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.actual, '1 個重複');
  assert.ok(r.evidence.indexOf('2027-11-07') !== -1, r.evidence);
  assert.ok(/第 \d+ 行與第 \d+ 行/.test(r.evidence), '要講得出是哪兩行：' + r.evidence);
});

// =====================================================================
// I03（這一組的核心）
// =====================================================================

test('I03 綠：兩條路數出同一個數', function () {
  const env = makeEnv({
    announcements: [
      { SERVICE_DATE: TARGET_DATE, SEQ_NO: 10, TEXT: '家事一', ACTIVE: true },
      { SERVICE_DATE: TARGET_DATE, SEQ_NO: 20, TEXT: '家事二', ACTIVE: true },
      { SERVICE_DATE: TARGET_DATE, SEQ_NO: 30, TEXT: '已停用', ACTIVE: false }
    ]
  });
  const r = env.sandbox.runInvariantI03_({ isoDate: TARGET_DATE, quarterId: QUARTER_ID });
  assert.strictEqual(r.ok, true, r.evidence);
  assert.ok(r.evidence.indexOf('N02=2') !== -1, 'ACTIVE=FALSE 那一行不應該算：' + r.evidence);
});

test('I03 紅：登記了但沒有實作 → 報紅（登記了卻沒有檢查，等於沒有登記）', function () {
  const env = makeEnv({
    numberRegistry: [{
      REGISTRY_ID: 'N99', DISPLAY_LOCATION: '某處', SOURCE_FUNCTION: 'foo_()',
      SHEET_NAME: 'BulletinWeeks', RECOUNT_RULE: '數一數', ACTIVE: true, NOTES: ''
    }]
  });
  const r = env.sandbox.runInvariantI03_({ isoDate: TARGET_DATE, quarterId: QUARTER_ID });
  assert.strictEqual(r.ok, false);
  assert.ok(r.evidence.indexOf('N99') !== -1, r.evidence);
  assert.ok(r.evidence.indexOf('登記了但沒有實作') !== -1, r.evidence);
});

test('I03 紅：有實作但沒有登記 → 報紅（加了新數字卻忘了登記，I03 不可以靜靜放過）', function () {
  const env = makeEnv({ numberRegistry: [] });
  const r = env.sandbox.runInvariantI03_({ isoDate: TARGET_DATE, quarterId: QUARTER_ID });
  assert.strictEqual(r.ok, false);
  assert.ok(r.evidence.indexOf('有實作但沒有在 NumberRegistry 登記') !== -1, r.evidence);
  assert.ok(r.evidence.indexOf('N01') !== -1, r.evidence);
});

test('I03 紅：兩條路數出不同的數 → 報紅，證據拿得出兩個實際值', function () {
  // ⚠️ 這一條是整組測試最重要的一個案例：它模擬「畫面報 3、工作表其實
  // 只有 1」那一種事故。造法是令 reported 與 recount 看到不同的資料——
  // 把 SERVICE_DATE 存成一個 pickWebAppListItems_ 認得、但字串比對認不
  // 得的形態（Date 物件 vs 字串）在假試算表造不出來，所以改為直接驗
  // 「數字不同時會不會紅」這條邏輯本身：用一個 quarterId 令 N01 兩邊
  // 必然不同（職事表有 4 個主日，BulletinWeeks 只有 2 行）。
  const env = makeEnv({
    weekRows: [
      { SERVICE_DATE: '2027-11-07', QUARTER_ID: QUARTER_ID, WEEK_OF_MONTH: 1, STATUS: 'DRAFT' },
      { SERVICE_DATE: '2027-11-14', QUARTER_ID: QUARTER_ID, WEEK_OF_MONTH: 2, STATUS: 'DRAFT' }
    ]
  });
  const r = env.sandbox.runInvariantI03_({ isoDate: TARGET_DATE, quarterId: QUARTER_ID });
  assert.strictEqual(r.ok, false);
  assert.ok(r.evidence.indexOf('畫面報 4') !== -1, r.evidence);
  assert.ok(r.evidence.indexOf('重新數是 2') !== -1, r.evidence);
  assert.ok(r.evidence.indexOf('重新數的條件') !== -1, '要講得出重新數的規則：' + r.evidence);
});

test('I03 ⚪：決定不到要驗哪一個主日 → 驗證不到，不是綠', function () {
  const env = makeEnv({});
  const r = env.sandbox.runInvariantI03_({ isoDate: '', quarterId: '' });
  assert.strictEqual(r.ok, null, '「驗不到」不可以當成「沒問題」');
  assert.strictEqual(r.result, 'UNKNOWN');
});

test('I03：登記表與實作的 REGISTRY_ID 一一對應（seed 與 probes 不可以走樣）', function () {
  const env = makeEnv({});
  const seeded = env.boot.seedNumberRegistryRows_().map(function (r) { return r.REGISTRY_ID; }).sort();
  const implemented = env.sandbox.numberRegistryProbes_({ isoDate: TARGET_DATE, quarterId: QUARTER_ID })
    .map(function (p) { return p.id; }).sort();
  deepEq(seeded, implemented, 'NumberRegistry 的 seed 與 numberRegistryProbes_() 必須一一對應');
});

// =====================================================================
// I04／I05
// =====================================================================

test('I04 綠：最近一批 SendLog 的封數 === 重新預覽的收件人數', function () {
  const env = makeEnv({
    recipients: [
      { RECIPIENT_ID: 'R1', NAME: '甲', EMAIL: 'a@example.com', GROUP_NAME: 'CC', ACTIVE: true },
      { RECIPIENT_ID: 'R2', NAME: '乙', EMAIL: 'b@example.com', GROUP_NAME: 'DB', ACTIVE: true }
    ],
    sendLog: [
      { TIMESTAMP: '2027-11-01', RECIPIENT_EMAIL: 'a@example.com', SUBJECT: 'x', STATUS: 'SENT', DRY_RUN: true },
      { TIMESTAMP: '2027-11-01', RECIPIENT_EMAIL: 'b@example.com', SUBJECT: 'x', STATUS: 'SENT', DRY_RUN: true }
    ]
  });
  const r = env.sandbox.runInvariantI04_();
  assert.strictEqual(r.ok, true, r.evidence);
});

test('I04 紅：預覽 1 人但 SendLog 有 2 封 → 報紅，兩個實際值都印出來', function () {
  const env = makeEnv({
    recipients: [
      { RECIPIENT_ID: 'R1', NAME: '甲', EMAIL: 'a@example.com', GROUP_NAME: 'CC', ACTIVE: true }
    ],
    sendLog: [
      { TIMESTAMP: '2027-11-01', RECIPIENT_EMAIL: 'a@example.com', SUBJECT: 'x', STATUS: 'SENT', DRY_RUN: true },
      { TIMESTAMP: '2027-11-01', RECIPIENT_EMAIL: 'b@example.com', SUBJECT: 'x', STATUS: 'SENT', DRY_RUN: true }
    ]
  });
  const r = env.sandbox.runInvariantI04_();
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.expected, '1 封');
  assert.strictEqual(r.actual, '2 封');
});

test('I04 ⚪：從未寄出過 → 驗證不到，證據講明「不是沒問題，是未驗過」', function () {
  const env = makeEnv({ sendLog: [] });
  const r = env.sandbox.runInvariantI04_();
  assert.strictEqual(r.ok, null);
  assert.ok(r.evidence.indexOf('未驗過') !== -1, r.evidence);
});

test('I05 綠：DRY_RUN=TRUE 而且最近一批全部是試行記錄', function () {
  const env = makeEnv({
    config: { DRY_RUN: 'TRUE' },
    sendLog: [{ TIMESTAMP: '2027-11-01', RECIPIENT_EMAIL: 'a@example.com', SUBJECT: 'x', STATUS: 'SENT', DRY_RUN: true }]
  });
  const r = env.sandbox.runInvariantI05_();
  assert.strictEqual(r.ok, true, r.evidence);
});

test('I05 紅：DRY_RUN=TRUE 但有真實寄出紀錄 → 報紅（整套系統最重要的一條保險）', function () {
  const env = makeEnv({
    config: { DRY_RUN: 'TRUE' },
    sendLog: [{ TIMESTAMP: '2027-11-01', RECIPIENT_EMAIL: 'a@example.com', SUBJECT: 'x', STATUS: 'SENT', DRY_RUN: false }]
  });
  const r = env.sandbox.runInvariantI05_();
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.actual, '1 筆真實寄出');
  assert.ok(r.evidence.indexOf('收不回來') !== -1, '要講明後果：' + r.evidence);
});

test('I05 ⚪：DRY_RUN=FALSE → 這一刻驗不到，不是綠', function () {
  const env = makeEnv({ config: { DRY_RUN: 'FALSE' } });
  const r = env.sandbox.runInvariantI05_();
  assert.strictEqual(r.ok, null);
  assert.ok(r.evidence.indexOf('驗不到') !== -1, r.evidence);
});

function publishRow(overrides) {
  return Object.assign({
    SERVICE_DATE: TARGET_DATE, VERSION_NO: 1, PUBLISHED_AT: '2027-11-06',
    // ⚠️ 預設**沒有** ARCHIVE_FILE_ID：I06 第 2 步會退回存檔副本，留一個
    //    讀不到的 ID 在這裡會令每一條測試都走那條退回路徑。要驗那條路徑
    //    的測試自己傳 ARCHIVE_FILE_ID。
    PUBLISHED_BY: 'x@example.com', ARCHIVE_FILE_ID: '', SENT: false,
    SENT_GROUPS: '', MISSING_COUNT: 0, FORCED: false, FORCED_REASON: '',
    MASTER_FILE_ID: 'MASTER1', IS_SELFTEST: false
  }, overrides || {});
}

/** 一行帶住 CONTENT_BYTES／CONTENT_MD5 的發佈紀錄（第三輪起的正路）。 */
function publishRowWithMd5(bytes, overrides) {
  const fp = md5Fingerprint(bytes).split(':');
  return publishRow(Object.assign({
    CONTENT_BYTES: Number(fp[0]), CONTENT_MD5: fp[1]
  }, overrides || {}));
}

// =====================================================================
// I06
// =====================================================================

function md5Fingerprint(bytes) {
  return bytes.length + ':' + crypto.createHash('md5').update(Buffer.from(bytes)).digest('hex');
}

// ⚠️ 第三輪起，指紋**直接記在 PublishLog 那一行上**（CONTENT_BYTES／
//    CONTENT_MD5）。共用那一份 Script Property 會被下一次發佈蓋走——
//    包括自測機發佈沙盒 master——於是 I06 拿到一份不屬於這一行的指紋。
//    見 docs/已知bug類型.md 事故三十三。
test('I06 綠：master 目前內容與該行記錄的 CONTENT_MD5 相同', function () {
  const bytes = [0x25, 0x50, 0x44, 0x46, 0x01];
  const env = makeEnv({
    config: { PUBLISHED_PDF_FILE_ID: 'MASTER1' },
    masterBytes: bytes,
    publishLog: [publishRowWithMd5(bytes, { VERSION_NO: 2 })]
  });
  const r = env.sandbox.runInvariantI06_();
  assert.strictEqual(r.ok, true, r.evidence);
  assert.ok(r.evidence.indexOf('這一行的 CONTENT_MD5') !== -1,
    '要講明指紋來自該行自己：' + r.evidence);
});

test('I06 紅：master 內容在最後一次發佈之後被換過 → 報紅，而且講得出成因', function () {
  const published = [0x25, 0x50, 0x44, 0x46, 0x01];
  const env = makeEnv({
    config: { PUBLISHED_PDF_FILE_ID: 'MASTER1' },
    // 目前內容比發佈當時多了幾個位元組——即是被換過。
    masterBytes: [0x25, 0x50, 0x44, 0x46, 0x01, 0xAA, 0xBB],
    publishLog: [publishRowWithMd5(published, { VERSION_NO: 2 })]
  });
  const r = env.sandbox.runInvariantI06_();
  assert.strictEqual(r.ok, false, r.evidence);
  assert.ok(r.evidence.indexOf('被換過') !== -1, r.evidence);
  // ⚠️ 第三輪的要求：不成立時要講**成因**，不是只講「對不上」。
  assert.ok(r.evidence.indexOf('大小不同') !== -1, '要講得出差在哪裏：' + r.evidence);
  assert.ok(r.evidence.indexOf('手動上載') !== -1, '要講得出常見成因：' + r.evidence);
  assert.ok(r.evidence.indexOf('診斷 I06') !== -1, '要講得出下一步：' + r.evidence);
});

test('I06 紅：大小相同但 MD5 不同 → 成因講「大小相同」，不會亂講大小差', function () {
  const published = [0x25, 0x50, 0x44, 0x46, 0x01];
  const env = makeEnv({
    config: { PUBLISHED_PDF_FILE_ID: 'MASTER1' },
    masterBytes: [0x25, 0x50, 0x44, 0x46, 0x02],
    publishLog: [publishRowWithMd5(published, { VERSION_NO: 2 })]
  });
  const r = env.sandbox.runInvariantI06_();
  assert.strictEqual(r.ok, false, r.evidence);
  assert.ok(r.evidence.indexOf('大小相同') !== -1, r.evidence);
});

// ⚠️ 這一條在第四輪**整條換掉**：Script Property 那條路已經移除（實測
//    結果是它「沒有記錄」，而 I06 把「取不到」當成「對不上」）。
//    現在驗的是 prompt 第 1 部分第 2 步：CONTENT_MD5 空、存檔副本在 →
//    用存檔副本的指紋比，而且要講明指紋來自存檔副本。
//    見 docs/已知bug類型.md 事故三十六。
test('I06 綠：CONTENT_MD5 空但存檔副本在 → 用存檔副本比對，並講明來源', function () {
  const bytes = [0x25, 0x50, 0x44, 0x46, 0x33];
  const env = makeEnv({
    config: { PUBLISHED_PDF_FILE_ID: 'MASTER1' },
    masterBytes: bytes,
    extraPdfFiles: { ARCHIVE_1: bytes },
    publishLog: [publishRow({ VERSION_NO: 3, ARCHIVE_FILE_ID: 'ARCHIVE_1' })]
  });
  const r = env.sandbox.runInvariantI06_();
  assert.strictEqual(r.ok, true, r.evidence);
  assert.ok(r.evidence.indexOf('存檔副本') !== -1,
    '一定要講明指紋來自存檔副本，不可以扮成發佈當時記下的值：' + r.evidence);
});

test('I06 紅：存檔副本與 master 目前內容不同 → 報紅（退回路徑一樣驗得到）', function () {
  const env = makeEnv({
    config: { PUBLISHED_PDF_FILE_ID: 'MASTER1' },
    masterBytes: [0x25, 0x50, 0x44, 0x46, 0x33, 0xAA],
    extraPdfFiles: { ARCHIVE_1: [0x25, 0x50, 0x44, 0x46, 0x33] },
    publishLog: [publishRow({ VERSION_NO: 3, ARCHIVE_FILE_ID: 'ARCHIVE_1' })]
  });
  const r = env.sandbox.runInvariantI06_();
  assert.strictEqual(r.ok, false, r.evidence);
  assert.ok(r.evidence.indexOf('被換過') !== -1, r.evidence);
});

// ⚠️ 兩者都取不到 → 「驗證不到」，而且要講明**是哪一邊**取不到。
//    這正是實測撞到那個假紅：CONTENT_MD5 空、Script Property 沒有記錄，
//    而 I06 報成「對不上」。
test('I06 ⚪：CONTENT_MD5 空、又沒有存檔副本 → 驗證不到，講明哪一邊取不到', function () {
  const env = makeEnv({
    config: { PUBLISHED_PDF_FILE_ID: 'MASTER1' },
    masterBytes: [0x25, 0x50, 0x44, 0x46],
    publishLog: [publishRow({ VERSION_NO: 3 })]
  });
  const r = env.sandbox.runInvariantI06_();
  assert.strictEqual(r.ok, null, r.evidence);
  assert.ok(r.evidence.indexOf('驗證不到（不是對不上）') !== -1, r.evidence);
  assert.ok(r.evidence.indexOf('沒有 ARCHIVE_FILE_ID') !== -1,
    '要講明是哪一邊取不到：' + r.evidence);
  assert.ok(r.evidence.indexOf('自己好返') !== -1, r.evidence);
});

test('I06 ⚪：存檔副本讀不到 → 驗證不到，並講明是存檔副本讀不到', function () {
  const env = makeEnv({
    config: { PUBLISHED_PDF_FILE_ID: 'MASTER1' },
    masterBytes: [0x25, 0x50, 0x44, 0x46],
    publishLog: [publishRow({ VERSION_NO: 3, ARCHIVE_FILE_ID: 'MISSING_ARCHIVE' })]
  });
  const r = env.sandbox.runInvariantI06_();
  assert.strictEqual(r.ok, null, r.evidence);
  assert.ok(r.evidence.indexOf('存檔副本') !== -1 && r.evidence.indexOf('讀不到') !== -1, r.evidence);
});

// ⚠️ 靜態檢查：I06 那一支完全不可以再讀 Script Property。
test('I06 完全不讀 Script Property（靜態檢查）', function () {
  const src = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'src', 'Invariants.gs'), 'utf8');
  ['PUBLISH_LAST_OUTPUT', 'readPublishOutputFingerprint_', 'PropertiesService']
    .forEach(function (banned) {
      assert.ok(src.indexOf(banned) === -1,
        'Invariants.gs 不可以再出現 ' + banned + '（見事故三十六）');
    });
});

test('I06 ⚪：master 檔案讀不到 → 驗證不到，不是紅也不是綠', function () {
  const env = makeEnv({
    config: { PUBLISHED_PDF_FILE_ID: 'MASTER1' },
    // masterBytes 不提供 → getFileById 會拋錯
    publishLog: [publishRowWithMd5([0x25, 0x50, 0x44, 0x46], { VERSION_NO: 1 })]
  });
  const r = env.sandbox.runInvariantI06_();
  assert.strictEqual(r.ok, null);
  assert.ok(r.evidence.indexOf('「讀不到」不等於「沒問題」') !== -1,
    '要講明「讀不到」不等於「沒問題」：' + r.evidence);
});

test('I06 ⚪：舊資料（沒有 CONTENT_MD5、共用記錄也認不出）→ 驗證不到，講明會自己好返', function () {
  const env = makeEnv({
    config: { PUBLISHED_PDF_FILE_ID: 'MASTER1' },
    masterBytes: [0x25, 0x50, 0x44, 0x46],
    publishLog: [publishRow({ VERSION_NO: 1 })],
    scriptProps: {
      // 加欄之前那一份共用記錄：**沒有 masterFileId**，認不出屬於哪一個檔案。
      PUBLISH_LAST_OUTPUT: JSON.stringify({
        isoDate: '2028-10-01', versionNo: 4, fingerprint: 'SANDBOX_FP'
      })
    }
  });
  const r = env.sandbox.runInvariantI06_();
  assert.strictEqual(r.ok, null,
    '認不出屬於哪一個檔案的舊記錄，不可以當成正式那一邊的——那正是第三輪那個假紅：'
    + r.evidence);
  assert.ok(r.evidence.indexOf('自己好返') !== -1, r.evidence);
});

// =====================================================================
// I06 分通道（第二輪自測）
// =====================================================================

const SANDBOX_MASTER = 'SANDBOX_MASTER_ID';

// ⚠️ 這一條就是第二輪那 5 個假紅的正面迴歸測試。自測機發佈完沙盒 master
//    之後，PublishLog 最新一行是沙盒那一行——舊版 I06 拿它去對**正式**
//    master 的內容，必然對不上，於是 S13 之後每一個情境一齊變紅。
test('I06 綠：自測發佈之後，正式那一邊仍然成立', function () {
  const prodBytes = [0x25, 0x50, 0x44, 0x46, 0x01];
  const sandboxBytes = [0x25, 0x50, 0x44, 0x46, 0x02];
  const env = makeEnv({
    config: { PUBLISHED_PDF_FILE_ID: 'MASTER1', SELFTEST_MASTER_PDF_FILE_ID: SANDBOX_MASTER },
    masterBytes: prodBytes,
    sandboxMasterBytes: sandboxBytes,
    publishLog: [
      publishRowWithMd5(prodBytes, { VERSION_NO: 3 }),
      // 自測那一行**在後面**（時間較新）——舊版就是被它騙到的。
      publishRowWithMd5(sandboxBytes, {
        VERSION_NO: 7, PUBLISHED_AT: '2027-11-07',
        MASTER_FILE_ID: SANDBOX_MASTER, IS_SELFTEST: true
      })
    ]
  });

  const r = env.sandbox.runInvariantI06_();
  assert.strictEqual(r.ok, true, r.evidence);
  assert.ok(r.evidence.indexOf('正式') !== -1, r.evidence);
  assert.ok(r.evidence.indexOf('沙盒') !== -1, r.evidence);
  assert.ok(r.evidence.indexOf('第 3 版') !== -1, '正式那一邊要對第 3 版：' + r.evidence);
  assert.ok(r.evidence.indexOf('第 7 版') !== -1, '沙盒那一邊要對第 7 版：' + r.evidence);
});

test('I06 ⚪：沙盒未設定 → 那一條通道回報「不適用」，不是失敗', function () {
  const prodBytes = [0x25, 0x50, 0x44, 0x46, 0x01];
  const env = makeEnv({
    config: { PUBLISHED_PDF_FILE_ID: 'MASTER1', SELFTEST_MASTER_PDF_FILE_ID: '' },
    masterBytes: prodBytes,
    publishLog: [publishRowWithMd5(prodBytes, { VERSION_NO: 3 })]
  });

  const r = env.sandbox.runInvariantI06_();
  assert.strictEqual(r.ok, true, r.evidence);
  assert.ok(r.evidence.indexOf('不適用') !== -1, '沙盒那一條要講明不適用：' + r.evidence);
});

// ⚠️ Config 是「現在指住邊個」，發佈記錄是「當時寫咗邊個」——兩者不是同一
//    件事，而且會不同。這一條用一個**與 Config 不同**的 MASTER_FILE_ID，
//    證明 I06 真的看那一行自己記低的檔案。
test('I06：用該行的 MASTER_FILE_ID 決定比對對象，不靠 Config 猜', function () {
  // ⚠️ 真實情境：master 檔案換過一個（Config 已經改指 MASTER1），但
  //    PublishLog 那一行記低的是**當時**那一個 OLD_MASTER。
  //    Config 是「現在指住邊個」，發佈記錄是「當時寫咗邊個」——兩者
  //    不是同一件事。靠 Config 猜的話，會去對一個從來沒有發佈過那一版
  //    的檔案，然後報一個假的結果。
  const oldBytes = [0x25, 0x50, 0x44, 0x46, 0x09];
  const env = makeEnv({
    config: { PUBLISHED_PDF_FILE_ID: 'MASTER1', SELFTEST_MASTER_PDF_FILE_ID: SANDBOX_MASTER },
    masterBytes: [0x25, 0x50, 0x44, 0x46, 0x01],
    extraPdfFiles: { OLD_MASTER: oldBytes },
    publishLog: [publishRowWithMd5(oldBytes, { VERSION_NO: 5, MASTER_FILE_ID: 'OLD_MASTER' })]
  });

  const r = env.sandbox.runInvariantI06_();
  assert.strictEqual(r.ok, true,
    '應該去對 OLD_MASTER 的內容；靠 Config 猜就會去對 MASTER1，'
    + '那裡沒有第 5 版的指紋記錄，於是報「驗證不到」：' + r.evidence);
  assert.ok(r.evidence.indexOf('記錄：') !== -1,
    '要講明檔案 ID 來自該行的記錄，不是 Config：' + r.evidence);
});

test('I06 紅：沙盒那一邊被人手改過 → 報紅，而且指名是沙盒那一條通道', function () {
  const prodBytes = [0x25, 0x50, 0x44, 0x46, 0x01];
  const env = makeEnv({
    config: { PUBLISHED_PDF_FILE_ID: 'MASTER1', SELFTEST_MASTER_PDF_FILE_ID: SANDBOX_MASTER },
    masterBytes: prodBytes,
    sandboxMasterBytes: [0x25, 0x50, 0x44, 0x46, 0xAA],
    publishLog: [
      publishRowWithMd5(prodBytes, { VERSION_NO: 3 }),
      publishRowWithMd5([0x25, 0x50, 0x44, 0x46, 0xBB], {
        VERSION_NO: 7, MASTER_FILE_ID: SANDBOX_MASTER, IS_SELFTEST: true
      })
    ]
  });

  const r = env.sandbox.runInvariantI06_();
  assert.strictEqual(r.ok, false, r.evidence);
  assert.ok(r.actual.indexOf('沙盒') !== -1, '要指名是哪一條通道：' + r.actual);
  assert.ok(r.evidence.indexOf('被換過') !== -1, r.evidence);
});

// ⚠️ 兩條通道都驗不到 ≠ 沒問題。三個狀態，不是兩個。
test('I06 ⚪：兩條通道都未發佈過 → 回「驗證不到」，不是綠', function () {
  const env = makeEnv({
    config: { PUBLISHED_PDF_FILE_ID: 'MASTER1', SELFTEST_MASTER_PDF_FILE_ID: SANDBOX_MASTER },
    masterBytes: [0x25, 0x50, 0x44, 0x46],
    publishLog: [publishRow({ VERSION_NO: 1 })]
    // 沒有任何 PUBLISH_LAST_OUTPUT::* 記錄
  });
  const r = env.sandbox.runInvariantI06_();
  assert.strictEqual(r.ok, null, JSON.stringify(r));
});

// =====================================================================
// 每一條不變量的環境聲明（第二輪自測）
// =====================================================================

// ⚠️ 這一組是靜態檢查。一條不變量若引用任何「正式環境專用」的設定，在
//    沙盒執行時就會必然失敗，並把本來通過的情境一併染紅（I06 就是這樣
//    拖紅了 5 個情境）。所以每一條都要**明確聲明**它對哪一個環境成立。
//    「沒有寫」不可以當成 ANY——漏寫與「檢視過、確認是 ANY」在程式碼裡
//    看起來一模一樣。見 docs/已知bug類型.md 事故三十一。
test('每一條不變量都有明確的環境聲明，而且是合法的值', function () {
  const env = makeEnv({});
  const defs = env.sandbox.invariantDefinitions_({ quarterId: '2027T4' }, {});
  const allowed = Object.keys(env.sandbox.INVARIANT_ENVIRONMENT_)
    .map(function (k) { return env.sandbox.INVARIANT_ENVIRONMENT_[k]; });

  // 2026-08-26 由 10 變 11：新增 I11（事奉資料的來源季度 === 該主日所屬的
  // 季度），見 docs/已知bug類型.md 事故四十一。
  assert.strictEqual(defs.length, 11);
  const bad = [];
  defs.forEach(function (d) {
    const checkId = d.id;
    if (typeof d.environment !== 'string' || allowed.indexOf(d.environment) === -1) {
      bad.push(checkId + ' 的 environment 缺少或不合法：' + JSON.stringify(d.environment));
    }
  });
  assert.strictEqual(bad.length, 0, bad.join('\n  '));
});

test('每一條不變量的環境聲明都有一句理由（只寫一個值等於沒有檢視過）', function () {
  const env = makeEnv({});
  const defs = env.sandbox.invariantDefinitions_({ quarterId: '2027T4' }, {});
  const bad = [];
  defs.forEach(function (d) {
    const checkId = d.id;
    if (typeof d.environmentNote !== 'string' || d.environmentNote.trim().length < 10) {
      bad.push(checkId + ' 沒有寫明為什麼是 ' + d.environment);
    }
  });
  assert.strictEqual(bad.length, 0, bad.join('\n  '));
});

test('I06 是唯一一條要分通道的；其餘十條都是 ANY', function () {
  const env = makeEnv({});
  const defs = env.sandbox.invariantDefinitions_({ quarterId: '2027T4' }, {});
  const perChannel = defs
    .filter(function (d) { return d.environment === env.sandbox.INVARIANT_ENVIRONMENT_.PER_CHANNEL; })
    .map(function (d) { return d.id; });
  deepEq(perChannel, ['I06']);

  const anyCount = defs.filter(function (d) {
    return d.environment === env.sandbox.INVARIANT_ENVIRONMENT_.ANY;
  }).length;
  // 2026-08-26 由 9 變 10：新增 I11。它驗的是「事奉資料不可以來自別一季」，
  // 在正式與沙盒兩個環境都必須成立，所以是 ANY。
  assert.strictEqual(anyCount, 10,
    '逐條檢視的結果見 docs/待確認事項.md Q-2；改動之後兩邊都要更新');
});

// ⚠️ 這一條防的是「日後有人加一條引用正式環境設定的不變量，卻聲明成 ANY」。
//    抓不到意圖，但抓得到「聲明了 PRODUCTION_ONLY 卻沒有處理沙盒」這種明顯
//    的自相矛盾。
test('聲明成 PRODUCTION_ONLY 的不變量，一條都不可以留在全域集合內', function () {
  const env = makeEnv({});
  const defs = env.sandbox.invariantDefinitions_({ quarterId: '2027T4' }, {});
  const productionOnly = defs
    .filter(function (d) { return d.environment === env.sandbox.INVARIANT_ENVIRONMENT_.PRODUCTION_ONLY; })
    .map(function (d) { return d.id; });
  const ran = env.sandbox.runAllInvariants_().results.map(function (r) { return r.id; });
  productionOnly.forEach(function (checkId) {
    assert.ok(ran.indexOf(checkId) === -1,
      checkId + ' 聲明只在正式環境成立，就不可以每個情境都跑一次——'
      + '它會在沙盒必然失敗並染紅不相干的情境');
  });
});

test('I07 綠：產出沒有殘留佔位符', function () {
  const env = makeEnv({
    docxFiles: { DOC1: fx.documentXml(fx.para(fx.run('全部都換好了'))) },
    weekRows: [{
      SERVICE_DATE: TARGET_DATE, QUARTER_ID: QUARTER_ID, WEEK_OF_MONTH: 1, STATUS: 'DRAFT',
      DOC_ID: 'DOC1', LAST_GENERATED_AT: '2027-11-06'
    }]
  });
  const r = env.sandbox.runInvariantI07_();
  assert.strictEqual(r.ok, true, r.evidence);
});

test('I07 紅：產出仍然有 {{ }} → 報紅，證據列出實際殘留的佔位符', function () {
  const env = makeEnv({
    docxFiles: { DOC1: fx.documentXml(fx.para(fx.run('講員：{{PREACHER}} 與 {{#EACHP:ANNOUNCEMENT}}'))) },
    weekRows: [{
      SERVICE_DATE: TARGET_DATE, QUARTER_ID: QUARTER_ID, WEEK_OF_MONTH: 1, STATUS: 'DRAFT',
      DOC_ID: 'DOC1', LAST_GENERATED_AT: '2027-11-06'
    }]
  });
  const r = env.sandbox.runInvariantI07_();
  assert.strictEqual(r.ok, false);
  assert.ok(r.evidence.indexOf('PREACHER') !== -1, r.evidence);
  assert.ok(r.evidence.indexOf('印在紙上') !== -1, '要講明後果：' + r.evidence);
});

test('I07 ⚪：從未產生過任何 Word 檔 → 驗證不到', function () {
  const env = makeEnv({});
  const r = env.sandbox.runInvariantI07_();
  assert.strictEqual(r.ok, null);
});

// =====================================================================
// I09
// =====================================================================

test('I09 綠：Diagnostics 行數在上限之內', function () {
  const env = makeEnv({ diagnostics: [{ REPORT_NAME: 'x', ROW_NO: 1, CONTENT: 'y', GENERATED_AT: '2027-11-01' }] });
  const r = env.sandbox.runInvariantI09_();
  assert.strictEqual(r.ok, true, r.evidence);
});

test('I09 紅：Diagnostics 超過 DIAGNOSTICS_MAX_ROWS → 報紅', function () {
  const rows = [];
  for (let i = 0; i < 12; i++) {
    rows.push({ REPORT_NAME: 'x', ROW_NO: i, CONTENT: 'y', GENERATED_AT: '2027-11-01' });
  }
  const env = makeEnv({ config: { DIAGNOSTICS_MAX_ROWS: '10' }, diagnostics: rows });
  const r = env.sandbox.runInvariantI09_();
  assert.strictEqual(r.ok, false);
  assert.ok(r.evidence.indexOf('12') !== -1 && r.evidence.indexOf('10') !== -1, r.evidence);
});

// =====================================================================
// I10
// =====================================================================

test('I10 綠：職事表版本記錄行數與基準相同', function () {
  const env = makeEnv({ revisionCount: 7 });
  const r = env.sandbox.runInvariantI10_(7);
  assert.strictEqual(r.ok, true, r.evidence);
  assert.ok(r.evidence.indexOf('零寫入') !== -1, r.evidence);
});

test('I10 紅：職事表版本記錄多了 → 報紅，講得出多了幾多個', function () {
  const env = makeEnv({ revisionCount: 9 });
  const r = env.sandbox.runInvariantI10_(7);
  assert.strictEqual(r.ok, false);
  assert.ok(r.evidence.indexOf('多了 2 個') !== -1, r.evidence);
});

test('I10 ⚪：讀不到版本記錄 → 驗證不到，並提示人手確認', function () {
  const env = makeEnv({ revisionCount: null });
  const r = env.sandbox.runInvariantI10_(7);
  assert.strictEqual(r.ok, null);
  assert.ok(r.evidence.indexOf('人手開啟職事表') !== -1, r.evidence);
});

test('I10 ⚪：沒有提供基準 → 只回報目前數目，不當成綠', function () {
  const env = makeEnv({ revisionCount: 7 });
  const r = env.sandbox.runInvariantI10_(null);
  assert.strictEqual(r.ok, null);
});

// =====================================================================
// runAllInvariants_ 與報告
// =====================================================================

test('runAllInvariants_：十條無副作用的全部跑到，一條爆了不會令其餘跑不到', function () {
  const env = makeEnv({});
  const summary = env.sandbox.runAllInvariants_();
  // 2026-08-26 由 9 變 10：新增 I11（無副作用），見事故四十一。
  assert.strictEqual(summary.results.length, 10);
  deepEq(summary.results.map(function (r) { return r.id; }),
    ['I01', 'I02', 'I03', 'I04', 'I05', 'I06', 'I07', 'I09', 'I10', 'I11']);
});

// ⚠️ 這一條是第一輪自測的教訓：I08「匯入之後再匯入一次改動必為 0」不是
//    恆真的不變量，它只在「啱啱匯入完」那一刻成立，而且它要靠一次匯入
//    先決條件才驗得到。把它放進 runAllInvariants_()，等於令 S08、S10、
//    S11、S12、S16、S17 六個不相干的情境一齊紅。見事故二十七。
test('runAllInvariants_ 裡面一條 sideEffect:true 的檢查都沒有', function () {
  const env = makeEnv({});
  const defs = env.sandbox.invariantDefinitions_({ quarterId: '2027T4' }, {});
  const ran = env.sandbox.runAllInvariants_().results.map(function (r) { return r.id; });
  const sideEffectIds = defs
    .filter(function (d) { return d.sideEffect === true; })
    .map(function (d) { return d.id; });
  assert.ok(sideEffectIds.length > 0, '應該至少有一條有副作用的檢查（I08）');
  sideEffectIds.forEach(function (checkId) {
    assert.ok(ran.indexOf(checkId) === -1,
      checkId + ' 有副作用，不可以出現在 runAllInvariants_() 裡面');
  });
});

test('每一條檢查都要明明白白寫出 sideEffect 是 true 定 false', function () {
  const env = makeEnv({});
  const defs = env.sandbox.invariantDefinitions_({ quarterId: '2027T4' }, {});
  // 2026-08-26 由 10 變 11：新增 I11。
  assert.strictEqual(defs.length, 11);
  defs.forEach(function (d) {
    const checkId = d.id;
    assert.strictEqual(typeof d.sideEffect, 'boolean',
      checkId + ' 沒有明寫 sideEffect，不可以靠「無寫就當無副作用」');
  });
});

test('runStatefulChecks_ 只跑有副作用那幾條，而且真的跑得到', function () {
  const env = makeEnv({});
  const summary = env.sandbox.runStatefulChecks_({ quarterId: '2027T4' });
  deepEq(summary.results.map(function (r) { return r.id; }), ['I08']);
});

test('runAllInvariants_：allOk 只看 FAILED，UNKNOWN 不會令它變 false', function () {
  const env = makeEnv({});
  const summary = env.sandbox.runAllInvariants_();
  assert.ok(summary.unknownCount > 0, '這個環境本來就有幾條驗證不到');
  assert.strictEqual(summary.failedCount, 0, JSON.stringify(summary.failed));
  assert.strictEqual(summary.allOk, true, '「驗證不到」不應該擋住流程');
});

test('runAllInvariants_：有一條 FAILED 時 allOk 是 false，failed 拿得出那一條', function () {
  const env = makeEnv({ numberRegistry: [] }); // I03 必紅
  const summary = env.sandbox.runAllInvariants_();
  assert.strictEqual(summary.allOk, false);
  assert.strictEqual(summary.failed.length, 1);
  assert.strictEqual(summary.failed[0].id, 'I03');
});

test('buildInvariantReportLines_：紅色的一定連預期／實際／證據三樣一齊印', function () {
  const env = makeEnv({ numberRegistry: [] });
  const summary = env.sandbox.runAllInvariants_();
  const lines = env.sandbox.buildInvariantReportLines_(summary);
  const text = lines.join('\n');

  assert.ok(text.indexOf('🔴') !== -1);
  assert.ok(text.indexOf('預期：') !== -1);
  assert.ok(text.indexOf('實際：') !== -1);
  assert.ok(text.indexOf('證據：') !== -1);
});

test('buildInvariantShortSummary_：使用者可見文字是書面語繁體中文', function () {
  const env = makeEnv({ numberRegistry: [] });
  const summary = env.sandbox.runAllInvariants_();
  assertWrittenChinese(assert, '不變量摘要', env.sandbox.buildInvariantShortSummary_(summary));
  assertWrittenChinese(assert, '不變量報告', env.sandbox.buildInvariantReportLines_(summary).join('\n'));
});

test('不變量全部唯讀：跑完之後每一張工作表的行數都沒有變', function () {
  // ⚠️ 「照鏡」不可以「執屋」。一邊檢查一邊順手改動，就再也分不清
  // 「本來就對」與「被檢查程序改到對」。
  const env = makeEnv({
    announcements: [{ SERVICE_DATE: TARGET_DATE, SEQ_NO: 10, TEXT: 'x', ACTIVE: true }],
    sendLog: [{ TIMESTAMP: '2027-11-01', RECIPIENT_EMAIL: 'a@example.com', SUBJECT: 'x', STATUS: 'SENT', DRY_RUN: true }]
  });

  const before = {};
  Object.keys(env.sheets).forEach(function (name) { before[name] = env.sheets[name].getLastRow(); });

  env.sandbox.runAllInvariants_();

  Object.keys(env.sheets).forEach(function (name) {
    assert.strictEqual(env.sheets[name].getLastRow(), before[name],
      '工作表「' + name + '」的行數被不變量檢查改動了');
  });
});

// =====================================================================
// 第 4 層：OutputAssert
// =====================================================================

test('assertDocxOutput_ 綠：乾淨的產出——殘留 0、異體字 0、拿得到位元組數', function () {
  const env = makeEnv({ docxFiles: { DOC1: fx.documentXml(fx.para(fx.run('乾淨的內容'))) } });
  const a = env.sandbox.assertDocxOutput_('DOC1');

  assert.strictEqual(a.ok, true, a.message);
  assert.strictEqual(a.residualPlaceholders, 0);
  assert.strictEqual(a.variantChars, 0);
  assert.ok(a.scannedParts >= 1);
});

test('assertDocxOutput_：讀不到檔案 → ok:false，而且不會印出完整檔案 ID', function () {
  const env = makeEnv({});
  const a = env.sandbox.assertDocxOutput_('NOT_A_REAL_FILE_ID_1234567890');
  assert.strictEqual(a.ok, false);
  assert.ok(a.message.indexOf('NOT_A_REAL_FILE_ID_1234567890') === -1,
    '完整檔案 ID 不可以流進訊息：' + a.message);
});

test('assertDocxOutput_：抓得到殘留佔位符，並列出樣本', function () {
  const env = makeEnv({
    docxFiles: { DOC1: fx.documentXml(fx.para(fx.run('{{SERMON_TITLE}} 與 {{PREACHER}}'))) }
  });
  const a = env.sandbox.assertDocxOutput_('DOC1');
  assert.strictEqual(a.residualPlaceholders, 2);
  assert.ok(a.residualSamples.length >= 1, JSON.stringify(a.residualSamples));
});

test('assertDocxOutput_：抓得到異體字（⾧ U+2FA7、㇐ U+31D0）', function () {
  const c1 = String.fromCodePoint(0x2FA7);
  const c2 = String.fromCodePoint(0x31D0);
  const env = makeEnv({
    docxFiles: { DOC1: fx.documentXml(fx.para(fx.run('粵語' + c1 + '者，除第' + c2 + '週外'))) }
  });
  const a = env.sandbox.assertDocxOutput_('DOC1');
  assert.strictEqual(a.variantChars, 2);
  assert.strictEqual(a.variantSamples.length, 2);
});

test('assertDocxOutput_：抓得到「只有標題沒有資料」的表格', function () {
  const emptyTable = fx.table([fx.row([fx.cell(fx.para(fx.run('家事報告')))])]);
  const fullTable = fx.table([
    fx.row([fx.cell(fx.para(fx.run('標題')))]),
    fx.row([fx.cell(fx.para(fx.run('第一條')))])
  ]);
  const env = makeEnv({ docxFiles: { DOC1: fx.documentXml(emptyTable + fullTable) } });

  const a = env.sandbox.assertDocxOutput_('DOC1');
  assert.strictEqual(a.emptyTables.length, 1, JSON.stringify(a.emptyTables));
  assert.strictEqual(a.emptyTables[0].headerText, '家事報告');
});

test('assertDocxOutput_：抓得到「有標籤無值」的孤兒行', function () {
  const env = makeEnv({
    docxFiles: {
      DOC1: fx.documentXml(
        fx.para(fx.run('講員：'))
        + fx.para(fx.run('講題：神愛世人'))
        + fx.para(fx.run('以下是本週的三項重要事工安排，請各位留意：'))
      )
    }
  });
  const a = env.sandbox.assertDocxOutput_('DOC1');
  deepEq(a.orphanLabels, ['講員：'],
    '只有短標籤才算孤兒；「講題：神愛世人」有值、長句子是正文，兩者都不可以誤報');
});

test('assertDocxOutput_：頁數線索取自 sectPr 與分頁符；完全取不到時回 null 而不是 0', function () {
  const env = makeEnv({ docxFiles: { DOC1: fx.documentXml(fx.para(fx.run('x'))) } });
  const a = env.sandbox.assertDocxOutput_('DOC1');
  assert.strictEqual(a.pageCountHint, 1, 'fixture 有一個 sectPr');

  assert.strictEqual(env.sandbox.docxPageCountHint_(0, 0), null,
    '取不到就要回 null，不可以回 0 假裝自己知道');
  assert.strictEqual(env.sandbox.docxPageCountHint_(1, 3), 4);
});

test('assertPdfOutput_ 綠：檔頭是 %PDF、拿得到位元組數與指紋', function () {
  const env = makeEnv({});
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Page >>\nendobj\n%%EOF\n', 'latin1');
  const bytes = Array.prototype.slice.call(pdf);
  const a = env.sandbox.assertPdfOutput_({ getBytes: function () { return bytes; } });

  assert.strictEqual(a.ok, true, a.message);
  assert.strictEqual(a.hasPdfHeader, true);
  assert.strictEqual(a.pageCount, 1);
  assert.ok(a.fingerprint.length > 0);
});

test('assertPdfOutput_ 紅：不是 PDF → ok:false，訊息講明副檔名不作準', function () {
  const env = makeEnv({});
  const bytes = Array.prototype.slice.call(Buffer.from('PKzip', 'latin1'));
  const a = env.sandbox.assertPdfOutput_({ getBytes: function () { return bytes; } });

  assert.strictEqual(a.ok, false);
  assert.strictEqual(a.hasPdfHeader, false);
  assert.ok(a.message.indexOf('副檔名') !== -1, a.message);
});

test('assertPdfOutput_ 紅：0 個位元組 → ok:false', function () {
  const env = makeEnv({});
  const a = env.sandbox.assertPdfOutput_({ getBytes: function () { return []; } });
  assert.strictEqual(a.ok, false);
  assert.ok(a.message.indexOf('0 個位元組') !== -1, a.message);
});

test('pdfCountPages_：數不到頁數時回 null，不回 0（0 會被下游當成空檔案）', function () {
  const env = makeEnv({});
  const noMarkers = Array.prototype.slice.call(Buffer.from('%PDF-1.4\n（頁物件被壓縮了）\n%%EOF', 'latin1'));
  assert.strictEqual(env.sandbox.pdfCountPages_(noMarkers), null);

  const twoPages = Array.prototype.slice.call(
    Buffer.from('%PDF\n/Type /Pages\n/Type /Page\n/Type/Page\n', 'latin1'));
  assert.strictEqual(env.sandbox.pdfCountPages_(twoPages), 2, '/Type /Pages 是目錄節點，不算一頁');
});

test('buildDocxAssertionLines_：驗不到時講明「驗不到不等於沒問題」', function () {
  const env = makeEnv({});
  const lines = env.sandbox.buildDocxAssertionLines_({ ok: false, message: '讀不到' });
  const text = lines.join('\n');
  assert.ok(text.indexOf('不等於') !== -1, text);
  assertWrittenChinese(assert, '產出斷言（驗不到）', text);
});

test('buildDocxAssertionLines_：正常結果印出每一項的實際值，書面語繁體中文', function () {
  const env = makeEnv({ docxFiles: { DOC1: fx.documentXml(fx.para(fx.run('x'))) } });
  const lines = env.sandbox.buildDocxAssertionLines_(env.sandbox.assertDocxOutput_('DOC1'));
  const text = lines.join('\n');

  assert.ok(text.indexOf('殘留佔位符：0') !== -1, text);
  assert.ok(text.indexOf('異體字：0') !== -1, text);
  assertWrittenChinese(assert, '產出斷言報告', text);
});

// =====================================================================
// SendLog.BODY_PREVIEW
// =====================================================================

test('buildSendLogBodyPreview_：去掉 HTML 標籤、壓平空白', function () {
  const env = makeEnv({});
  const preview = env.sandbox.buildSendLogBodyPreview_('<p>各位主內肢體：</p>\n\n  <div>平安！</div>');
  assert.strictEqual(preview, '各位主內肢體： 平安！');
});

test('buildSendLogBodyPreview_：超過上限時截斷，而且**講明**被截斷了', function () {
  const env = makeEnv({});
  const long = 'a'.repeat(3000);
  const preview = env.sandbox.buildSendLogBodyPreview_(long);

  assert.ok(preview.length < 3000);
  assert.ok(preview.indexOf('只存前') !== -1, '靜靜截走的話，看的人分不出「內文就是這麼短」與「後面還有」');
});

test('buildSendLogBodyPreview_：空值回空字串，不回 "undefined"', function () {
  const env = makeEnv({});
  assert.strictEqual(env.sandbox.buildSendLogBodyPreview_(null), '');
  assert.strictEqual(env.sandbox.buildSendLogBodyPreview_(undefined), '');
  assert.strictEqual(env.sandbox.buildSendLogBodyPreview_(''), '');
});

test('buildSendLogBodyPreview_：以 = 開頭的內文會被公式跳脫（sanitizeCellText_）', function () {
  const env = makeEnv({});
  assert.strictEqual(env.sandbox.buildSendLogBodyPreview_('=SUM(A1:A2)'), "'=SUM(A1:A2)");
});

test('SendLog 新欄位一律加在最後（BODY_PREVIEW、BATCH_ID）', function () {
  const env = makeEnv({});
  const keys = env.sandbox.COLUMNS.SEND_LOG.keys;
  // 第三輪加 BODY_PREVIEW，第四輪加 BATCH_ID——次序不可以調轉，
  // 插在中間會令既有資料整排錯位。
  assert.strictEqual(keys[keys.length - 2], 'BODY_PREVIEW');
  assert.strictEqual(keys[keys.length - 1], 'BATCH_ID');
  assert.strictEqual(keys.length, env.sandbox.COLUMNS.SEND_LOG.headers.length);
  assert.strictEqual(keys.length, env.sandbox.COLUMNS.SEND_LOG.types.length);
});

// =====================================================================

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
