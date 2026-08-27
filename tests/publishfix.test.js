#!/usr/bin/env node
/**
 * tests/publishfix.test.js
 *
 * 「發佈卡住、Shared Drive 404、按鈕可重複撳、上載檔案容易揀錯」那一輪
 * 修正的回歸測試。
 *
 * 這一組測試守住的，全部都是**症狀看起來完全不像原因**的那幾種 bug：
 *
 *   - **Shared Drive 404**（1–5）：檔案明明在、權限明明對，Drive 卻回
 *     「File not found」。原因只是少了一個參數。
 *   - **揀錯檔案**（6、7）：把剛下載回來的那一份再上載，等於用舊內容
 *     覆寫自己，而且外表完全看不出分別。
 *   - **重複發佈**（9、10、11）：使用者見不到反應就會再撳一次。
 *   - **前端沒有失敗處理**（12–14）：後端拋的錯全部人間蒸發。
 *
 * 執行方式：node tests/publishfix.test.js
 * 離開碼：0＝全部通過　1＝有測試失敗
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { loadAllSrcFilesInOrder } = require('./helpers/loadGas');
const { makeFakeSheet, makeFakeSpreadsheet } = require('./helpers/fakeSpreadsheet');
const { assertWrittenChinese } = require('./helpers/writtenChinese');

const driveLint = require('../tools/lint-drive-shared');

const FAKE_ROSTER_ID = 'FAKE_ROSTER_ID_FOR_PUBLISH_FIX';
const MASTER_FOLDER_ID = 'FAKE_MASTER_FOLDER';
const ARCHIVE_FOLDER_ID = 'FAKE_ARCHIVE_FOLDER';
const MASTER_FILE_ID = 'FAKE_MASTER_FILE';
const QUARTER_ID = '2027T4';
const SERVICE_DATES = ['2027-10-03', '2027-10-10', '2027-10-17', '2027-10-24', '2027-10-31', '2027-11-07'];
const TARGET_DATE = '2027-11-07';

function pdfBase64(body) {
  return Buffer.from('%PDF-1.4\n' + body + '\n%%EOF\n', 'latin1').toString('base64');
}
const PDF_A = pdfBase64('1 0 obj (version A) endobj');
const PDF_B = pdfBase64('1 0 obj (version B) endobj');
const PLACEHOLDER_BYTES = [0x25, 0x50, 0x44, 0x46]; // buildPlaceholderPdfBlob_() 的假替身會產生這四個位元組
const PLACEHOLDER_BASE64 = Buffer.from(PLACEHOLDER_BYTES).toString('base64');

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
// 假替身
// =====================================================================

function makeFakeBlob(bytes, mimeType, name) {
  const blob = {
    __bytes: bytes.slice(),
    getBytes: function () { return blob.__bytes.slice(); },
    getName: function () { return name; },
    getContentType: function () { return mimeType; },
    setName: function (n) { name = n; return blob; },
    getAs: function (mime) { return makeFakeBlob(PLACEHOLDER_BYTES, mime, name); }
  };
  return blob;
}

function baseStubs(o) {
  const opts = o || {};
  if (!opts.__scriptProps) opts.__scriptProps = {};

  return {
    Utilities: {
      formatDate: function (date, tz, pattern) {
        const isNow = Math.abs(Date.now() - date.getTime()) < 5000;
        if (isNow && String(pattern).indexOf('HH') === -1) return opts.todayIso || TARGET_DATE;
        const y = date.getFullYear();
        const mo = String(date.getMonth() + 1).padStart(2, '0');
        const d = String(date.getDate()).padStart(2, '0');
        const hh = String(date.getHours()).padStart(2, '0');
        const mi = String(date.getMinutes()).padStart(2, '0');
        if (String(pattern).indexOf('HH') !== -1) return `${y}-${mo}-${d} ${hh}:${mi}`;
        return `${y}-${mo}-${d}`;
      },
      base64Decode: function (text) {
        const buf = Buffer.from(String(text), 'base64');
        const out = [];
        for (let i = 0; i < buf.length; i++) out.push(buf[i] > 127 ? buf[i] - 256 : buf[i]);
        return out;
      },
      base64Encode: function (bytes) {
        return Buffer.from((bytes || []).map(function (b) { return b < 0 ? b + 256 : b; })).toString('base64');
      },
      DigestAlgorithm: { MD5: 'MD5' },
      computeDigest: function (algorithm, value) {
        const bytes = Array.isArray(value)
          ? Buffer.from(value.map(function (b) { return b < 0 ? b + 256 : b; }))
          : Buffer.from(String(value), 'utf8');
        return Array.prototype.slice.call(crypto.createHash('md5').update(bytes).digest());
      },
      newBlob: function (content, mimeType, name) {
        const bytes = Array.isArray(content)
          ? content.slice()
          : Array.prototype.slice.call(Buffer.from(String(content), 'utf8'));
        return makeFakeBlob(bytes, mimeType, name);
      }
    },
    Session: {
      getScriptTimeZone: function () { return 'Pacific/Auckland'; },
      getActiveUser: function () { return { getEmail: function () { return 'tester@example.com'; } }; },
      getEffectiveUser: function () { return { getEmail: function () { return 'tester@example.com'; } }; }
    },
    CacheService: {},
    HtmlService: {},
    PropertiesService: {
      getUserProperties: function () {
        return { getProperty: function () { return null; }, setProperty: function () {} };
      },
      getScriptProperties: function () {
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
 *   sharedDriveStrict  true（預設）＝ Drive 替身在缺少 supportsAllDrives 時
 *                      像真的 Shared Drive 那樣回「File not found」。
 *   drive404           true ＝ 不論參數對不對，一律回 404（模擬檔案真的
 *                      被刪、或者權限出問題）。
 *   lockBusy           true ＝ 指令碼鎖拿不到。
 *   masterBytes        master 檔案目前的內容（位元組陣列）。
 *   scriptProps        預先放進 ScriptProperties 的值。
 */
function makeEnv(options) {
  const o = options || {};
  if (o.scriptProps) o.__scriptProps = Object.assign({}, o.scriptProps);
  const boot = loadAllSrcFilesInOrder(baseStubs(o));

  const cfg = {};
  boot.DEFAULTS.forEach(function (d) { cfg[d.key] = d.value; });
  cfg.ROSTER_SPREADSHEET_ID = FAKE_ROSTER_ID;
  cfg.PUBLISHED_PDF_FOLDER_ID = MASTER_FOLDER_ID;
  cfg.PUBLISHED_ARCHIVE_FOLDER_ID = ARCHIVE_FOLDER_ID;
  cfg.PUBLISHED_PDF_FILE_ID = o.noMasterFile ? '' : MASTER_FILE_ID;
  cfg.DRY_RUN = 'FALSE';
  Object.assign(cfg, o.config || {});

  function ownSheet(sheetId, rows) {
    const def = boot.COLUMNS[sheetId];
    return makeFakeSheet(def.headers, def.keys, rows || []);
  }

  const ownSheets = {};
  Object.keys(boot.SHEETS).forEach(function (id) { ownSheets[boot.SHEETS[id]] = ownSheet(id, []); });
  ownSheets.Config = ownSheet('CONFIG', Object.keys(cfg).map(function (k) {
    return { KEY: k, VALUE: cfg[k], NOTE: '', EDITABLE: true };
  }));

  // 這一組測試不驗發佈前檢查，所以把目標主日填得很齊、日期也剛好正常。
  const weekFields = {
    CALL_TEXT: '你們要讚美耶和華', CALL_REF: '詩篇 150:1',
    SCRIPTURE_REF: '約翰福音 3:16', SERMON_TITLE: '神愛世人',
    RESPONSE_HYMN: '普天頌讚 123', FLOWER_THIS_WEEK: '王氏家庭'
  };
  boot.attendanceRowDefs_().forEach(function (def) {
    def.keys.forEach(function (key) { weekFields[key] = 100; });
  });

  ownSheets.BulletinWeeks = ownSheet('BULLETIN_WEEKS', SERVICE_DATES.map(function (iso, i) {
    const row = { SERVICE_DATE: iso, QUARTER_ID: QUARTER_ID, WEEK_OF_MONTH: (i % 4) + 1, STATUS: 'DRAFT' };
    if (iso === TARGET_DATE) Object.assign(row, weekFields);
    return row;
  }));
  ownSheets.Announcements = ownSheet('ANNOUNCEMENTS', [{ SERVICE_DATE: TARGET_DATE, SEQ_NO: 10, TEXT: '家事一', ACTIVE: true }]);
  ownSheets.Prayers = ownSheet('PRAYERS', [{ SERVICE_DATE: TARGET_DATE, SEQ_NO: 10, TEXT: '代禱一', ACTIVE: true }]);
  ownSheets.Fellowships = ownSheet('FELLOWSHIPS', [{
    SERVICE_DATE: TARGET_DATE, SEQ_NO: 10, FELLOWSHIP_NAME: '成人團契',
    MEETING_DATE: '2027-11-12', MEETING_TIME: '晚上七時', CONTENT: '查經', ACTIVE: true
  }]);
  ownSheets.PublishLog = ownSheet('PUBLISH_LOG', o.publishLog === undefined ? [{
    SERVICE_DATE: '2027-10-31', VERSION_NO: 1, PUBLISHED_AT: '2027-10-30',
    PUBLISHED_BY: 'tester@example.com', ARCHIVE_FILE_ID: 'OLD', SENT: false,
    SENT_GROUPS: '', MISSING_COUNT: 0, FORCED: false, FORCED_REASON: ''
  }] : o.publishLog);
  ownSheets.Recipients = ownSheet('RECIPIENTS', [
    { RECIPIENT_ID: 'R1', NAME: '堂委甲', EMAIL: 'cc1@example.com', GROUP_NAME: 'CC', ACTIVE: true }
  ]);
  ownSheets.EmailTemplates = ownSheet('EMAIL_TEMPLATES', boot.seedEmailTemplatesRows_());

  function rosterSheet(defKey, rows) {
    const keys = Object.keys(boot.ROSTER_TABLE_DEFS_[defKey].columns);
    return makeFakeSheet(keys, keys, rows || []);
  }
  const rosterSheets = {
    RosterAssignments: rosterSheet('ASSIGNMENTS', []),
    RosterVersions: rosterSheet('VERSIONS', [{ QuarterID: QUARTER_ID, VersionNo: 1 }]),
    Quarters: rosterSheet('QUARTERS', [{ QuarterID: QUARTER_ID, Stage: 'OFFICIAL_SENT' }]),
    ServiceDates: rosterSheet('SERVICE_DATES', SERVICE_DATES.map(function (iso, i) {
      return {
        ServiceDateID: 'SD' + (i + 1), QuarterID: QUARTER_ID, ServiceDate: iso,
        WeekIndex: i + 1, IsFirstSundayOfMonth: i === 0, ServiceType: '主日崇拜', SpecialID: ''
      };
    })),
    SpecialSundays: rosterSheet('SPECIAL_SUNDAYS', []),
    NameMapping: rosterSheet('NAME_MAPPING', []),
    Posts: rosterSheet('POSTS', [])
  };

  // ---- 假 Drive ----
  const drive = { files: {}, createdFiles: [], calls: [] };
  if (!o.noMasterFile) {
    drive.files[MASTER_FILE_ID] = {
      fileId: MASTER_FILE_ID, name: '（尚未發佈）',
      bytes: o.masterBytes ? o.masterBytes.slice() : []
    };
  }

  /**
   * ⚠️ 這裏就是整輪修正的重點：**真正的 Drive 進階服務在 Shared Drive 上，
   * 缺少 `supportsAllDrives` 時會回一句「File not found」**——檔案明明在。
   * 替身照樣模擬這個行為，日後有人把那個參數拿走，測試就會表現成一模
   * 一樣的症狀，而不是靜靜通過。
   */
  function guard(optionalArgs, method) {
    drive.calls.push({ method: method, options: optionalArgs || null });
    if (o.drive404) throw new Error('File not found: ' + MASTER_FILE_ID);
    if (o.sharedDriveStrict === false) return;
    if (!optionalArgs || optionalArgs.supportsAllDrives !== true) {
      throw new Error('File not found: ' + MASTER_FILE_ID);
    }
  }

  const FakeDrive = {
    Files: {
      update: function (metadata, fileId, blob, optionalArgs) {
        guard(optionalArgs, 'update');
        if (!drive.files[fileId]) throw new Error('File not found: ' + fileId);
        drive.files[fileId].bytes = blob.getBytes();
        // ⚠️ v3 用 `name`，不是 v2 的 `title`（事故三十七）。
        if (metadata && metadata.title) {
          throw new Error('Drive.Files.update：用了 v2 的 title，v3 應該用 name');
        }
        if (metadata && metadata.name) drive.files[fileId].name = metadata.name;
        return { id: fileId };
      },
      get: function (fileId, optionalArgs) {
        guard(optionalArgs, 'get');
        if (!drive.files[fileId]) throw new Error('File not found: ' + fileId);
        return { id: fileId, name: drive.files[fileId].name };
      },
      list: function (optionalArgs) {
        guard(optionalArgs, 'list');
        return { items: [] };
      }
    }
  };

  let seq = 0;
  function fileHandle(record) {
    return {
      getId: function () { return record.fileId; },
      getName: function () { return record.name; },
      getUrl: function () { return 'https://drive.google.com/file/d/' + record.fileId + '/view'; },
      getBlob: function () { return makeFakeBlob(record.bytes || [], 'application/pdf', record.name); },
      setName: function (n) { record.name = n; return this; },
      setSharing: function () { return this; }
    };
  }

  const FakeDriveApp = {
    Access: { ANYONE_WITH_LINK: 'ANYONE_WITH_LINK' },
    Permission: { VIEW: 'VIEW' },
    getFolderById: function (id) {
      return {
        getId: function () { return id; },
        createFile: function (blob) {
          seq++;
          const record = { fileId: 'NEW_' + seq, name: blob.getName(), folder: id, bytes: blob.getBytes() };
          drive.files[record.fileId] = record;
          drive.createdFiles.push(record);
          return fileHandle(record);
        }
      };
    },
    getFileById: function (id) {
      if (!drive.files[id]) throw new Error('No item with the given ID could be found: ' + id);
      return fileHandle(drive.files[id]);
    }
  };

  const locks = { tried: 0 };
  const FakeLockService = {
    getScriptLock: function () {
      return {
        tryLock: function () { locks.tried++; return o.lockBusy !== true; },
        releaseLock: function () {}
      };
    }
  };

  const mails = [];
  const sandbox = loadAllSrcFilesInOrder(Object.assign({}, baseStubs(o), {
    SpreadsheetApp: {
      getActiveSpreadsheet: function () { return makeFakeSpreadsheet(ownSheets); },
      openById: function (id) {
        if (id === FAKE_ROSTER_ID) return makeFakeSpreadsheet(rosterSheets);
        throw new Error('openById: 找不到 ' + id);
      },
      newDataValidation: function () {
        const b = { requireValueInList: function () { return b; }, setAllowInvalid: function () { return b; }, build: function () { return {}; } };
        return b;
      },
      ProtectionType: { SHEET: 'SHEET' },
      getUi: function () {
        return {
          createMenu: function () {
            const m = { addItem: function () { return m; }, addSeparator: function () { return m; }, addSubMenu: function () { return m; }, addToUi: function () { return m; } };
            return m;
          },
          alert: function () { return 'OK'; },
          prompt: function () { return { getSelectedButton: function () { return 'OK'; }, getResponseText: function () { return ''; } }; },
          showModalDialog: function () {},
          ButtonSet: { OK: 'OK', OK_CANCEL: 'OK_CANCEL', YES_NO: 'YES_NO' },
          Button: { OK: 'OK', CANCEL: 'CANCEL', YES: 'YES', NO: 'NO' }
        };
      }
    },
    DriveApp: FakeDriveApp,
    Drive: FakeDrive,
    LockService: FakeLockService,
    MailApp: { sendEmail: function (p) { mails.push(p); }, getRemainingDailyQuota: function () { return 100; } },
    ScriptApp: { getProjectTriggers: function () { return []; } }
  }));

  return {
    sandbox: sandbox, sheets: ownSheets, drive: drive, locks: locks,
    mails: mails, scriptProps: o.__scriptProps
  };
}

function publishOnce(env, base64, extra) {
  return env.sandbox.runPublishFlow_(Object.assign({
    isoDate: TARGET_DATE, doPublish: true, doSend: false,
    pdfBase64: base64, pdfName: '週報.pdf', confirmed: true
  }, extra || {}));
}

function readPublishLog(env) {
  return env.sandbox.readSheet(env.sandbox.SHEETS.PUBLISH_LOG);
}

function readErrorLog(env) {
  return env.sandbox.readSheet(env.sandbox.SHEETS.ERROR_LOG);
}

/** 在一個暫存目錄裡放幾個假的 .gs，跑 lint-drive-shared 的 lint()。 */
function withDriveFixture(files, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drivelint-'));
  try {
    Object.keys(files).forEach(function (name) {
      fs.writeFileSync(path.join(dir, name), files[name], 'utf8');
    });
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// =====================================================================
// 1-5. Shared Drive：supportsAllDrives
// =====================================================================

test('1. driveUpdateFileContent_() 一定帶 supportsAllDrives: true', function () {
  const env = makeEnv({});
  const blob = env.sandbox.Utilities === undefined ? null : null;
  env.sandbox.driveUpdateFileContent_(MASTER_FILE_ID,
    { getBytes: function () { return [1, 2, 3]; }, getName: function () { return 'x.pdf'; } }, 'x.pdf');

  const updates = env.drive.calls.filter(function (c) { return c.method === 'update'; });
  assert.strictEqual(updates.length, 1);
  assert.strictEqual(updates[0].options.supportsAllDrives, true,
    '缺了這個參數，Shared Drive 上會回一句假的「File not found」');
});

test('1b. driveCountFilesByNameInFolder_() 同時帶 supportsAllDrives 與 includeItemsFromAllDrives', function () {
  const env = makeEnv({});
  env.sandbox.driveCountFilesByNameInFolder_(MASTER_FOLDER_ID, 'a.docx');

  const lists = env.drive.calls.filter(function (c) { return c.method === 'list'; });
  assert.strictEqual(lists.length, 1);
  assert.strictEqual(lists[0].options.supportsAllDrives, true);
  assert.strictEqual(lists[0].options.includeItemsFromAllDrives, true,
    '列檔案的呼叫兩個選項缺一不可：一個是「我處理得到」，一個是「請包含進來」');
});

test('2. lint-drive-shared：缺少 supportsAllDrives 的寫法會被捉到', function () {
  withDriveFixture({
    'Bad.gs': "'use strict';\nfunction bad_(id, blob) {\n  return Drive.Files.update({}, id, blob);\n}\n"
  }, function (dir) {
    const hits = driveLint.lint(dir).violations;
    assert.strictEqual(hits.length, 1);
    assert.strictEqual(hits[0].rule, 'DRIVE_CALL_WITHOUT_SHARED_DRIVE_SUPPORT');
    assert.ok(hits[0].message.indexOf('File not found') !== -1, hits[0].message);
  });
});

test('3. lint-drive-shared：正確寫法（直接寫參數／經共用包裝）都回 0', function () {
  withDriveFixture({
    'Direct.gs': "'use strict';\nfunction ok1_(id, blob) {\n  return Drive.Files.update({}, id, blob, { supportsAllDrives: true });\n}\n",
    'Wrapped.gs': "'use strict';\nfunction ok2_(id, blob) {\n  return Drive.Files.update({}, id, blob, driveSharedOptions_());\n}\n"
  }, function (dir) {
    assert.strictEqual(JSON.stringify(driveLint.lint(dir).violations), '[]');
  });

  // 現時的 src/ 也一定要是 0。
  assert.strictEqual(JSON.stringify(driveLint.lint().violations), '[]',
    '目前的 src/ 不應該有缺少 supportsAllDrives 的 Drive 呼叫');
});

test('3b. lint-drive-shared：共用包裝自己漏掉那個參數，一樣要被捉到', function () {
  // ⚠️ 這一條堵住規則 1 開的那個洞：容許用包裝代替字面上的參數，前提是
  // 包裝自己一定有。包裝一旦漏掉，全部呼叫點都會靜靜失去 Shared Drive 支援。
  withDriveFixture({
    'DriveShared.gs': "'use strict';\nfunction driveSharedOptions_(extra) {\n  return { fields: 'items(id)' };\n}\n"
  }, function (dir) {
    const hits = driveLint.lint(dir).violations;
    assert.strictEqual(hits.length, 1);
    assert.strictEqual(hits[0].rule, 'SHARED_DRIVE_WRAPPER_MISSING_OPTION');
  });
});

test('4. Drive 回 404 → 寫 ErrorLog，而且訊息是人看得懂的，不是原始例外字串', function () {
  const env = makeEnv({ drive404: true });
  const result = publishOnce(env, PDF_A);

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'FILE_MISSING');
  assert.ok(result.message.indexOf('找不到那一個檔案') !== -1, result.message);
  assert.ok(result.message.indexOf('重新建立會產生新的連結') !== -1,
    '要講明重建的代價，否則使用者會以為重建是無害的');

  const errors = readErrorLog(env);
  assert.strictEqual(errors.length, 1);
  assert.strictEqual(errors[0].ERROR_CODE, 'FILE_MISSING');
});

test('5. Drive 回 404 → 不寫 PublishLog（沒有成功就不算發佈過）', function () {
  const env = makeEnv({ drive404: true });
  const before = readPublishLog(env).length;
  publishOnce(env, PDF_A);
  assert.strictEqual(readPublishLog(env).length, before);
});

test('5b. 沒有帶 supportsAllDrives 的話，症狀就是 404——替身照樣模擬得出來', function () {
  // 這一條不是驗生產程式碼，是驗**測試替身本身有沒有能力捉到那個 bug**。
  // 替身如果對缺參數毫無反應，前面那幾條測試就全部是假的保障。
  const env = makeEnv({});
  let threw = '';
  try {
    env.sandbox.Drive.Files.update({}, MASTER_FILE_ID,
      { getBytes: function () { return []; }, getName: function () { return 'x'; } });
  } catch (err) {
    threw = err.message;
  }
  assert.ok(threw.indexOf('File not found') !== -1, '替身要像真的 Shared Drive 那樣回 404，實際：' + threw);
});

// =====================================================================
// 6-8. 揀錯檔案
// =====================================================================

test('6. 上載的 PDF 與 master 目前內容相同 → 拒絕，訊息講明是「目前已發佈的那一份」', function () {
  const env = makeEnv({ masterBytes: Array.prototype.slice.call(Buffer.from(PDF_A, 'base64')) });
  const result = publishOnce(env, PDF_A);

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'UPLOAD_IS_CURRENT_MASTER');
  assert.ok(result.message.indexOf('目前已發佈的那一份') !== -1, result.message);
  assert.strictEqual(readPublishLog(env).length, 1, '拒絕就一行都不可以多');
});

test('7. 上載的是佔位檔 → 拒絕，訊息講明「不是週報」', function () {
  const env = makeEnv({
    // 建立 master 時記下來的佔位檔指紋。
    scriptProps: { PUBLISH_PLACEHOLDER_FINGERPRINT: '4:' + crypto.createHash('md5').update(Buffer.from(PLACEHOLDER_BYTES)).digest('hex') }
  });
  const result = publishOnce(env, PLACEHOLDER_BASE64);

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'UPLOAD_IS_PLACEHOLDER');
  assert.ok(result.message.indexOf('佔位檔') !== -1, result.message);
  assert.ok(result.message.indexOf('尚未發佈') !== -1, result.message);
});

test('7b. 從未發佈過、而上載的內容剛好等於 master 目前內容 → 也算佔位檔', function () {
  // 沒有發佈過的話，master 裏面放住的就是佔位檔本身；就算指紋沒有記下來
  // （例如 master 是這一輪之前建立的），也要認得出。
  const env = makeEnv({
    publishLog: [],
    masterBytes: PLACEHOLDER_BYTES.slice()
  });
  const result = publishOnce(env, PLACEHOLDER_BASE64);
  assert.strictEqual(result.reason, 'UPLOAD_IS_PLACEHOLDER');
});

test('7c. classifyUploadedPdfSource_：指紋讀不到（空字串）一律放行，不可以當成「不相同」', function () {
  const env = makeEnv({});
  const s = env.sandbox;
  assert.strictEqual(s.classifyUploadedPdfSource_('', 'a', 'b', true).ok, true);
  assert.strictEqual(s.classifyUploadedPdfSource_('x', '', '', true).ok, true,
    '讀不到 master 目前內容只代表「這一次比對不到」，不應該連發佈都做不到');
});

test('8. 上載一份新的 PDF → 成功，VERSION_NO 加一', function () {
  const env = makeEnv({ masterBytes: Array.prototype.slice.call(Buffer.from(PDF_A, 'base64')) });
  const result = publishOnce(env, PDF_B);

  assert.strictEqual(result.ok, true, result.message);
  assert.strictEqual(result.published.versionNo, 1, '這個主日還沒有發佈過，所以是第 1 版');
  assert.strictEqual(readPublishLog(env).length, 2);
  // master 的內容真的換成了新那一份。
  assert.strictEqual(
    Buffer.from(env.drive.files[MASTER_FILE_ID].bytes.map(function (b) { return b < 0 ? b + 256 : b; })).toString('base64'),
    PDF_B);
});

// =====================================================================
// 9-11. 防重複與鎖
// =====================================================================

test('9. PUBLISH_DEDUP_SEC 之內重複發佈同一主日 → 回「剛才已經發佈過」，版本號不變', function () {
  const env = makeEnv({ config: { PUBLISH_DEDUP_SEC: '30' } });

  const first = publishOnce(env, PDF_A);
  assert.strictEqual(first.ok, true, first.message);
  assert.strictEqual(first.published.versionNo, 1);

  const second = publishOnce(env, PDF_B);
  assert.strictEqual(second.ok, true, '這不是錯誤，是「你剛才已經做過了」');
  assert.strictEqual(second.duplicate, true);
  assert.strictEqual(second.published.versionNo, 1, '版本號不可以跳');
  assert.ok(second.lines.join('\n').indexOf('剛才已經發佈過') !== -1, second.lines.join('\n'));
  assert.strictEqual(readPublishLog(env).length, 2, '既有一行 ＋ 第一次那一行；第二次不可以再加');
});

// ⚠️ 第二輪自測：S14「即刻再發佈同一份，沒有被擋住」報紅。
//    先拿證據，不要先改防重複（prompt 第 2.1 節）。
//
//    上面第 9 條就是證據：同一個主日、視窗之內、**連內容都不同**，
//    第二次照樣被擋住、版本號不變。防重複沒有壞。
//
//    S14 紅的原因是**測試依賴時間**：每個情境耗時 14 至 23 秒，而
//    PUBLISH_DEDUP_SEC 只有 30 秒——由 S13 發佈完、跑完十條不變量、
//    再到 S14 發佈，隨時已經超出視窗。所以改的是測試，不是防重複。
//    見 docs/待確認事項.md Q-3。
test('9b. 防重複沒有壞的直接證據：同一主日、視窗之內，連續兩次都擋得住', function () {
  const env = makeEnv({ config: { PUBLISH_DEDUP_SEC: '30' } });

  const first = publishOnce(env, PDF_A);
  assert.strictEqual(first.duplicate, undefined, '第一次不可以被擋');
  assert.strictEqual(first.published.versionNo, 1);

  // 連續兩次再發佈，兩次之間不做任何其他事——這正是新版 S14 的做法。
  //
  // ⚠️ 第二、三次刻意用**另一份內容**：再上載同一份 A 的話，會先被
  //    「你選的是目前已發佈的那一份」那一道防線擋住（checkUploadedPdfIsNew_
  //    排在防重複之前），於是根本行不到防重複那一步——被擋住的原因就
  //    分不清是哪一道防線。要驗防重複，就一定要令另外那一道防線放行。
  const second = publishOnce(env, PDF_B);
  const third = publishOnce(env, PDF_B);

  assert.strictEqual(second.duplicate, true);
  assert.strictEqual(third.duplicate, true);
  assert.strictEqual(second.published.versionNo, 1);
  assert.strictEqual(third.published.versionNo, 1);
  assert.strictEqual(readPublishLog(env).length, 2,
    '既有一行 ＋ 第一次那一行；第二、三次一行都不可以再加');
});

// ⚠️ 這一條記錄的是**現行行為**，不是「應該如此」的定論：防重複只看
//    時間，不看內容——同一個主日、視窗之內、就算內容真的改過，一樣會
//    被擋。好處是撳多一次一定擋得住；壞處是幹事見到錯字、即刻改完再
//    發佈，會被靜靜當成「撳多了一次」，那個修正**不會**上到網站。
//
//    prompt 第 2.3 節提過「同一主日、不同內容、視窗之內應該不擋」，但
//    那一節的前提是「證據顯示防重複真的失效」——證據顯示它沒有失效，
//    所以這一輪不改行為，只把這個取捨寫成測試與 docs/待確認事項.md Q-4，
//    交 Ivan 決定。
test('9c. 現行行為：同一主日、視窗之內、內容不同，一樣會被擋（取捨已記錄）', function () {
  const env = makeEnv({ config: { PUBLISH_DEDUP_SEC: '30' } });
  publishOnce(env, PDF_A);
  const second = publishOnce(env, PDF_B);
  assert.strictEqual(second.duplicate, true,
    '如果哪一日改成「內容不同就不擋」，這一條會紅——那時要一併更新 Q-4');
  assert.strictEqual(second.published.versionNo, 1);
});

// =====================================================================
// 9d-9h. PublishLog 兩個新欄位（第二輪自測）
// =====================================================================

test('9d. PublishLog 四個新欄位全部加在最尾（次序不可以插在中間）', function () {
  const env = makeEnv({});
  const keys = env.sandbox.COLUMNS.PUBLISH_LOG.keys;
  // 第二輪加 MASTER_FILE_ID／IS_SELFTEST，第三輪再加 CONTENT_BYTES／CONTENT_MD5。
  assert.strictEqual(keys[keys.length - 4], 'MASTER_FILE_ID');
  assert.strictEqual(keys[keys.length - 3], 'IS_SELFTEST');
  assert.strictEqual(keys[keys.length - 2], 'CONTENT_BYTES');
  assert.strictEqual(keys[keys.length - 1], 'CONTENT_MD5');
  assert.strictEqual(keys.length, env.sandbox.COLUMNS.PUBLISH_LOG.headers.length);
  assert.strictEqual(keys.length, env.sandbox.COLUMNS.PUBLISH_LOG.types.length);
});

test('9e. 正式發佈：MASTER_FILE_ID 記低實際覆寫的檔案，IS_SELFTEST 是 FALSE', function () {
  const env = makeEnv({ config: { PUBLISH_DEDUP_SEC: '0' } });
  publishOnce(env, PDF_A);
  const row = readPublishLog(env).filter(function (r) {
    return env.sandbox.publishRowIsoDate_(r) === TARGET_DATE;
  })[0];
  assert.strictEqual(row.MASTER_FILE_ID, MASTER_FILE_ID);
  assert.strictEqual(row.IS_SELFTEST, false);
});

// ⚠️ IS_SELFTEST 刻意由「覆寫的檔案 === SELFTEST_MASTER_PDF_FILE_ID」推出來，
//    不是靠呼叫方傳旗標。旗標會有人忘記傳，而忘記傳的後果是自測發佈被記成
//    正式發佈——那正是第二輪要修的東西。
test('9f. 覆寫的是沙盒 master → IS_SELFTEST 自動變 TRUE，不需要呼叫方傳旗標', function () {
  const env = makeEnv({
    config: { PUBLISH_DEDUP_SEC: '0', SELFTEST_MASTER_PDF_FILE_ID: MASTER_FILE_ID }
  });
  publishOnce(env, PDF_A);
  const row = readPublishLog(env).filter(function (r) {
    return env.sandbox.publishRowIsoDate_(r) === TARGET_DATE;
  })[0];
  assert.strictEqual(row.IS_SELFTEST, true);
  assert.strictEqual(row.MASTER_FILE_ID, MASTER_FILE_ID);
});

test('9g. isSelfTestMasterFileId_：沙盒未設定時一律 false（空字串不等於任何檔案）', function () {
  const env = makeEnv({ config: { SELFTEST_MASTER_PDF_FILE_ID: '' } });
  assert.strictEqual(env.sandbox.isSelfTestMasterFileId_(''), false);
  assert.strictEqual(env.sandbox.isSelfTestMasterFileId_(MASTER_FILE_ID), false);
});

// ⚠️ 第四輪：Script Property 那條路**整條移除**。實測結果是它「沒有記錄」，
//    而 I06 把「取不到」當成「對不上」。Script Property 會被清、會遺失，
//    而且是全 script 共用的一個袋——不可以做真相來源。
//    見 docs/已知bug類型.md 事故三十六。
test('9h. 發佈指紋只記在 PublishLog 那一行上，完全不碰 Script Property', function () {
  const env = makeEnv({ config: { PUBLISH_DEDUP_SEC: '0' } });
  publishOnce(env, PDF_A);

  const row = readPublishLog(env).filter(function (r) {
    return env.sandbox.publishRowIsoDate_(r) === TARGET_DATE;
  })[0];
  assert.ok(Number(row.CONTENT_BYTES) > 0, '發佈成功一定要寫 CONTENT_BYTES');
  assert.ok(String(row.CONTENT_MD5).length > 0, '發佈成功一定要寫 CONTENT_MD5');

  const props = env.scriptProps || {};
  const leftovers = Object.keys(props).filter(function (k) {
    return k.indexOf('PUBLISH_LAST_OUTPUT') !== -1;
  });
  assert.strictEqual(leftovers.length, 0,
    '不可以再寫任何 PUBLISH_LAST_OUTPUT 的 Script Property：' + leftovers.join('、'));
});

// ⚠️ 靜態檢查：整個 src/ 不可以再出現那幾個函式名或那個鍵。只驗行為的話，
//    有人日後再加回去也抓不到。
test('9h-2. 全 repo 已經沒有 Script Property 指紋那條路（靜態檢查）', function () {
  const fsMod = require('fs');
  const pathMod = require('path');
  const srcDir = pathMod.join(__dirname, '..', 'src');
  const banned = ['PUBLISH_LAST_OUTPUT', 'recordPublishOutputFingerprint_',
    'readPublishOutputFingerprint_', 'publishOutputFingerprintKey_',
    'parsePublishOutputFingerprint_'];
  const offenders = [];

  fsMod.readdirSync(srcDir).filter(function (n) { return String(n).slice(-3) === '.gs'; })
    .forEach(function (fileName) {
      const text = fsMod.readFileSync(pathMod.join(srcDir, fileName), 'utf8');
      text.split(String.fromCharCode(10)).forEach(function (line, i) {
        // 註解（解釋為甚麼移除）不算。
        const trimmed = line.replace(/^[ 	]+/, '');
        if (trimmed.slice(0, 2) === '//' || trimmed.slice(0, 1) === '*') return;
        banned.forEach(function (name) {
          if (line.indexOf(name) !== -1) offenders.push(fileName + ':' + (i + 1) + '　' + line.trim());
        });
      });
    });

  assert.strictEqual(offenders.length, 0,
    'Script Property 那條路已經移除，不可以再出現：' + offenders.join('；'));
});

// ⚠️ 這一條是 prompt 第 1 部分第 2 步：CONTENT_MD5 空、存檔副本在 →
//    用存檔副本的指紋比。實測那一次兩邊完全一樣，所以會直接通過。
test('9i. CONTENT_MD5 空但存檔副本在 → 用存檔副本的指紋，講明來源', function () {
  const env = makeEnv({ config: { PUBLISH_DEDUP_SEC: '0' } });
  publishOnce(env, PDF_A);

  // 把那一行的 CONTENT_MD5／CONTENT_BYTES 清空，模擬加欄之前的舊資料。
  const sheet = env.sheets.PublishLog;
  const def = env.sandbox.COLUMNS.PUBLISH_LOG;
  const rows = readPublishLog(env);
  const rowNo = rows.length + 2;
  sheet.getRange(rowNo, def.keys.indexOf('CONTENT_BYTES') + 1).setValue('');
  sheet.getRange(rowNo, def.keys.indexOf('CONTENT_MD5') + 1).setValue('');

  const cleared = readPublishLog(env)[rows.length - 1];
  assert.strictEqual(env.sandbox.publishRowFingerprint_(cleared), '', '前置條件：兩欄要真的空了');

  const expected = env.sandbox.resolvePublishExpectedFingerprint_(cleared);
  assert.ok(expected.fingerprint.length > 0, '應該退回存檔副本：' + expected.reason);
  assert.ok(expected.sourceLabel.indexOf('存檔副本') !== -1,
    '一定要講明指紋來自存檔副本，不可以扮成發佈當時記下的值：' + expected.sourceLabel);
});

test('9i-2. CONTENT_MD5 空、又沒有 ARCHIVE_FILE_ID → 取不到，並講明哪一邊取不到', function () {
  const env = makeEnv({});
  const expected = env.sandbox.resolvePublishExpectedFingerprint_({
    SERVICE_DATE: TARGET_DATE, VERSION_NO: 1, ARCHIVE_FILE_ID: ''
  });
  assert.strictEqual(expected.fingerprint, '');
  assert.ok(expected.reason.indexOf('沒有 ARCHIVE_FILE_ID') !== -1, expected.reason);
  assert.ok(expected.reason.indexOf('自己好返') !== -1, '要講明下一次發佈就會好返：' + expected.reason);
});

test('9i-3. 存檔副本讀不到 → 取不到，並講明是存檔副本那一邊讀不到', function () {
  const env = makeEnv({});
  const expected = env.sandbox.resolvePublishExpectedFingerprint_({
    SERVICE_DATE: TARGET_DATE, VERSION_NO: 1, ARCHIVE_FILE_ID: 'MISSING_ARCHIVE'
  });
  assert.strictEqual(expected.fingerprint, '');
  assert.ok(expected.reason.indexOf('存檔副本') !== -1, expected.reason);
  assert.ok(expected.reason.indexOf('讀不到') !== -1, expected.reason);
});

test('9i-4. CONTENT_MD5 有值 → 優先用它，不會去讀存檔副本', function () {
  const env = makeEnv({});
  const expected = env.sandbox.resolvePublishExpectedFingerprint_({
    SERVICE_DATE: TARGET_DATE, VERSION_NO: 1, ARCHIVE_FILE_ID: 'MISSING_ARCHIVE',
    CONTENT_BYTES: 123, CONTENT_MD5: 'abc123'
  });
  assert.strictEqual(expected.fingerprint, '123:abc123');
  assert.strictEqual(expected.sourceLabel, '這一行的 CONTENT_MD5');
});

// =====================================================================
// 9j-9m. PublishLog 歷史資料補寫
// =====================================================================

function publishLogRow(overrides) {
  return Object.assign({
    SERVICE_DATE: '2027-10-31', VERSION_NO: 1, PUBLISHED_AT: '2027-10-30',
    PUBLISHED_BY: 'tester@example.com', ARCHIVE_FILE_ID: 'OLD', SENT: true,
    SENT_GROUPS: 'CC,DB', MISSING_COUNT: 0, FORCED: false, FORCED_REASON: ''
  }, overrides || {});
}

test('9j. 補寫歷史資料：MASTER_FILE_ID 填正式那個、IS_SELFTEST 填 FALSE', function () {
  const env = makeEnv({ publishLog: [publishLogRow(), publishLogRow({ VERSION_NO: 2 })] });

  const result = env.sandbox.backfillPublishLogMasterFileId_();
  assert.strictEqual(result.filled, 2);
  assert.strictEqual(result.skipped, 0);

  const rows = readPublishLog(env);
  rows.forEach(function (r) {
    assert.strictEqual(r.MASTER_FILE_ID, MASTER_FILE_ID);
    assert.strictEqual(r.IS_SELFTEST, false);
  });
});

// ⚠️ 重跑「初始化工作表」是常事。第二次跑不可以把真正的自測紀錄改成 FALSE。
test('9k. 補寫只補空白的格，已經有值的一行都不動（可以重複跑）', function () {
  const env = makeEnv({
    publishLog: [
      publishLogRow({ MASTER_FILE_ID: 'SANDBOX_MASTER', IS_SELFTEST: true }),
      publishLogRow({ VERSION_NO: 2 })
    ]
  });

  const result = env.sandbox.backfillPublishLogMasterFileId_();
  assert.strictEqual(result.filled, 1, '只有第二行需要補');

  const rows = readPublishLog(env);
  assert.strictEqual(rows[0].MASTER_FILE_ID, 'SANDBOX_MASTER', '已經有值的不可以被改');
  assert.strictEqual(rows[0].IS_SELFTEST, true);
  assert.strictEqual(rows[1].MASTER_FILE_ID, MASTER_FILE_ID);
  assert.strictEqual(rows[1].IS_SELFTEST, false);

  // 再跑一次：一行都不應該再補。
  assert.strictEqual(env.sandbox.backfillPublishLogMasterFileId_().filled, 0);
});

// ⚠️ 填一個空字串當成「已補寫」，等於把「不知道」記成「知道，是空的」。
test('9l. PUBLISHED_PDF_FILE_ID 是空的 → MASTER_FILE_ID 留空並報「補寫不到」', function () {
  const env = makeEnv({ noMasterFile: true, publishLog: [publishLogRow()] });

  const result = env.sandbox.backfillPublishLogMasterFileId_();
  assert.strictEqual(result.filled, 0);
  assert.strictEqual(result.skipped, 1);
  assert.ok(result.skipReason.indexOf('PUBLISHED_PDF_FILE_ID') !== -1, result.skipReason);

  const row = readPublishLog(env)[0];
  assert.strictEqual(String(row.MASTER_FILE_ID || ''), '');
  assert.strictEqual(row.IS_SELFTEST, false, 'IS_SELFTEST 是確定的，照樣要補');
});

test('9m. PublishLog 一行都沒有 → 補寫回 0，不會拋錯', function () {
  const env = makeEnv({ publishLog: [] });
  const result = env.sandbox.backfillPublishLogMasterFileId_();
  assert.strictEqual(result.filled, 0);
  assert.strictEqual(result.skipped, 0);
});

test('10. 超過 PUBLISH_DEDUP_SEC → 正常產生新版本', function () {
  const env = makeEnv({ config: { PUBLISH_DEDUP_SEC: '30' } });
  publishOnce(env, PDF_A);

  // 把時間戳記改成 10 分鐘之前，等於「已經過了防重複的時間窗」。
  const key = 'PUBLISH_LAST|' + TARGET_DATE;
  const stamp = JSON.parse(env.scriptProps[key]);
  env.scriptProps[key] = JSON.stringify({ at: stamp.at - 600000, versionNo: stamp.versionNo });

  const second = publishOnce(env, PDF_B);
  assert.strictEqual(second.ok, true, second.message);
  assert.strictEqual(second.duplicate, undefined);
  assert.strictEqual(second.published.versionNo, 2);
});

test('10b. findRecentPublishStamp_：時鐘倒退（負數）不算重複，寧可多一版也不要永遠拒絕', function () {
  const env = makeEnv({});
  const future = JSON.stringify({ at: 2000000, versionNo: 3 });
  assert.strictEqual(env.sandbox.findRecentPublishStamp_(future, 1000000, 30), null);
  assert.strictEqual(env.sandbox.findRecentPublishStamp_('壞掉的 JSON', 1000000, 30), null);
  assert.strictEqual(env.sandbox.findRecentPublishStamp_('', 1000000, 30), null);
});

// =====================================================================
// 10c-10f. 版本號要喺**同一類**嘅行入面數
//
// ⚠️ 呢四條係一個實測失敗打返轉頭嘅：自測機 S14c 報「沒有被擋、版本號 1」。
//    表面症狀似防重複——「發咗兩次、版本冇加」——但其實完全唔關防重複事：
//    R-037 §2.2 加咗「正式報表排除自測」之後，`executePublish_()` 順手
//    都用埋嗰支濾走自測行嘅函式嚟數版本號，於是自測發佈永遠數到 0 行，
//    每一次都算第 1 版。見 docs/已知bug類型.md 事故四十六。
// =====================================================================

test('10c. 自測發佈連續兩次（已過防重複視窗）→ 版本號要由 1 變 2，不是永遠 1', function () {
  const env = makeEnv({
    config: { PUBLISH_DEDUP_SEC: '30', SELFTEST_MASTER_PDF_FILE_ID: MASTER_FILE_ID }
  });
  const first = publishOnce(env, PDF_A);
  assert.strictEqual(first.ok, true, first.message);
  assert.strictEqual(first.published.versionNo, 1);

  // 明確把防重複的判斷基準撥出視窗之外，不靠真實時間流逝。
  const key = 'PUBLISH_LAST|' + TARGET_DATE;
  const stamp = JSON.parse(env.scriptProps[key]);
  env.scriptProps[key] = JSON.stringify({ at: stamp.at - 600000, versionNo: stamp.versionNo });

  const second = publishOnce(env, PDF_B);
  assert.strictEqual(second.duplicate, undefined, '已經出咗視窗，唔應該當成重複撳');
  assert.strictEqual(second.ok, true, second.message);
  assert.strictEqual(second.published.versionNo, 2, '自測發佈嘅版本號一樣要加');

  const rows = readPublishLog(env).filter(function (r) {
    return env.sandbox.publishRowIsoDate_(r) === TARGET_DATE;
  });
  // ⚠️ 用 JSON.stringify 比對：`rows` 來自 vm sandbox，陣列的原型跟這一邊
  //    的 Array 不同，deepStrictEqual 會因為原型不符而失敗。
  const versions = JSON.stringify(rows.map(function (r) { return Number(r.VERSION_NO); }));
  assert.strictEqual(versions, '[1,2]',
    '同一個主日唔可以有兩行相同版本號，實際：' + versions);
});

test('10d. 正式發佈的版本號不受自測那些行影響（R-037 §2.2 的原意保住）', function () {
  const env = makeEnv({
    config: { PUBLISH_DEDUP_SEC: '0' },
    publishLog: [{
      SERVICE_DATE: TARGET_DATE, VERSION_NO: 7, PUBLISHED_AT: '2027-11-06',
      PUBLISHED_BY: 'selftest@example.com', ARCHIVE_FILE_ID: 'SELFTEST',
      SENT: false, SENT_GROUPS: '', MISSING_COUNT: 0, FORCED: false,
      FORCED_REASON: '', IS_SELFTEST: true
    }]
  });
  const result = publishOnce(env, PDF_A);
  assert.strictEqual(result.ok, true, result.message);
  assert.strictEqual(result.published.versionNo, 1,
    '自測跑咗七版，唔應該令正式發佈由第 8 版開始');

  const row = readPublishLog(env).filter(function (r) {
    return env.sandbox.publishRowIsoDate_(r) === TARGET_DATE && r.IS_SELFTEST !== true;
  })[0];
  assert.strictEqual(Number(row.VERSION_NO), 1);
});

test('10e. publishLogRowsOfKind_：空白／取不到的 IS_SELFTEST 當成正式', function () {
  const env = makeEnv({});
  const rows = [
    { VERSION_NO: 1, IS_SELFTEST: true },
    { VERSION_NO: 2, IS_SELFTEST: false },
    { VERSION_NO: 3, IS_SELFTEST: '' },
    { VERSION_NO: 4, IS_SELFTEST: null },
    { VERSION_NO: 5 }
  ];
  const selfTest = env.sandbox.publishLogRowsOfKind_(rows, true)
    .map(function (r) { return r.VERSION_NO; });
  const official = env.sandbox.publishLogRowsOfKind_(rows, false)
    .map(function (r) { return r.VERSION_NO; });

  assert.deepStrictEqual(Array.prototype.slice.call(selfTest), [1]);
  // ⚠️ 空白／null／冇欄位全部歸「正式」，同 readOfficialPublishLogRows_() 一致。
  //    兩支分類唔一致嘅話，同一行會一時算正式一時算自測。
  assert.deepStrictEqual(Array.prototype.slice.call(official), [2, 3, 4, 5]);
  assert.deepStrictEqual(Array.prototype.slice.call(env.sandbox.publishLogRowsOfKind_(null, true)), []);
});

test('10f. 版本號與 IS_SELFTEST 由同一個判斷得出，不是各自判斷一次', function () {
  const text = fs.readFileSync(path.join(__dirname, '..', 'src', 'Publish.gs'), 'utf8');
  const body = text.slice(text.indexOf('function executePublish_('));
  const end = body.indexOf('\nfunction ', 10);
  const fn = end === -1 ? body : body.slice(0, end);

  const decl = (fn.match(/var isSelfTestRun = isSelfTestMasterFileId_\(/g) || []).length;
  assert.strictEqual(decl, 1, 'executePublish_ 應該只判斷一次「這一次是不是自測」');
  assert.ok(fn.indexOf('IS_SELFTEST: isSelfTestRun,') !== -1,
    '寫入 PublishLog 那一欄要用同一個變數，否則標籤與版本號可以對不上');
  assert.ok(fn.indexOf('publishLogRowsOfKind_(readSheet(SHEETS.PUBLISH_LOG), isSelfTestRun)') !== -1,
    '版本號要在同一類的行裏面數');
  assert.ok(fn.indexOf('nextPublishVersion_(readOfficialPublishLogRows_()') === -1,
    '版本號不可以用「正式報表」那一支——那正是事故四十六的成因');
});

test('11. LockService 被佔用 → 明確訊息，而且一格都沒有寫', function () {
  const env = makeEnv({ lockBusy: true });
  const before = readPublishLog(env).length;
  const result = publishOnce(env, PDF_A);

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'LOCK_BUSY');
  assert.ok(result.message.indexOf('拿不到指令碼鎖') !== -1, result.message);
  assert.ok(result.message.indexOf('不要重複按') !== -1, '要順帶提醒不要再撳，否則使用者的下一步就是再撳一次');
  assert.strictEqual(readPublishLog(env).length, before);
  assert.strictEqual(env.drive.calls.filter(function (c) { return c.method === 'update'; }).length, 0);
});

// =====================================================================
// 12-14. 前端一定要有失敗處理（靜態掃描 src/ui/）
// =====================================================================

/** 把 JS 的註解剝走，避免註解裡提到的字面被當成程式碼。 */
function stripJsComments(text) {
  return String(text)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

function uiFiles() {
  const dir = path.join(__dirname, '..', 'src', 'ui');
  return fs.readdirSync(dir)
    .filter(function (f) { return f.endsWith('.html'); })
    .map(function (f) { return { name: f, text: fs.readFileSync(path.join(dir, f), 'utf8') }; });
}

test('12. src/ui 內每一個 google.script.run 都只出現在 callServer() 裏面', function () {
  // ⚠️ 這一條守住的是「有沒有寫失敗處理」這件事本身。`withFailureHandler`
  // 是可以不寫的，而不寫的後果是後端拋的錯全部人間蒸發——使用者只見到
  // 轉圈結束、甚麼都沒有發生。集中在一個地方，就只有一處會寫漏。
  uiFiles().forEach(function (file) {
    const code = stripJsComments(file.text);
    const occurrences = code.split('google.script.run').length - 1;
    if (occurrences === 0) return; // 這個檔案根本不呼叫伺服器

    assert.ok(code.indexOf('function callServer(') !== -1,
      file.name + ' 有伺服器呼叫，就一定要有 callServer()');
    assert.strictEqual(occurrences, 1,
      file.name + ' 內 google.script.run 出現了 ' + occurrences + ' 次；'
        + '只可以有一次，而且要在 callServer() 裏面');
    assert.ok(code.indexOf('function callServer(') < code.indexOf('google.script.run'),
      file.name + ' 那一次 google.script.run 要在 callServer() 之內');
  });
});

test('12b. callServer() 一定同時有 withSuccessHandler 與 withFailureHandler', function () {
  uiFiles().forEach(function (file) {
    const code = stripJsComments(file.text);
    if (code.indexOf('google.script.run') === -1) return;
    assert.ok(code.indexOf('.withSuccessHandler(') !== -1, file.name);
    assert.ok(code.indexOf('.withFailureHandler(') !== -1,
      file.name + ' 缺少 withFailureHandler——後端拋錯時使用者會甚麼都看不到');
  });
});

test('13. callServer() 失敗時會解除忙碌狀態，而且顯示得到錯誤', function () {
  const code = stripJsComments(uiFiles().filter(function (f) { return f.name === 'Script.html'; })[0].text);

  // 三條路徑（成功、失敗、逾時）都經過同一個 settle()，所以只可能解除一次。
  assert.ok(code.indexOf('function settle(') !== -1, 'callServer() 要有 settle() 統一解除忙碌狀態');
  assert.ok(code.indexOf('if (settled) return;') !== -1, '逾時之後才回來的回應要被擋掉');
  assert.ok(code.indexOf('release();') !== -1);
  assert.ok(code.indexOf('opts.onError') !== -1 && code.indexOf("showMessage('error', message)") !== -1,
    '沒有自訂處理時要顯示紅色訊息');
  // 確認視窗是 modal，錯誤一定要顯示在視窗之內。
  assert.ok(code.indexOf('function showPublishConfirmError(') !== -1);
});

test('14. callServer() 有逾時，而且逾時訊息指得出去哪裏查', function () {
  const code = stripJsComments(uiFiles().filter(function (f) { return f.name === 'Script.html'; })[0].text);

  assert.ok(code.indexOf('setTimeout(') !== -1, 'google.script.run 本身沒有逾時，一定要自己加');
  assert.ok(code.indexOf('function serverCallTimeoutMs(') !== -1);
  assert.ok(code.indexOf('data-call-timeout-sec') !== -1, '逾時秒數要由 Config 帶進來，不可以寫死');
  assert.ok(code.indexOf('秒內沒有回應') !== -1);
  assert.ok(code.indexOf('ErrorLog') !== -1 && code.indexOf('執行項目') !== -1,
    '逾時訊息要講明去哪裏查');

  // FillConflict.html 是另一個獨立文件，同樣要有逾時。
  const dialog = stripJsComments(uiFiles().filter(function (f) { return f.name === 'FillConflict.html'; })[0].text);
  assert.ok(dialog.indexOf('setTimeout(') !== -1, '對話框那一個也要有逾時');
});

test('14b. 撳「執行」之後兩顆按鈕都會停用並改文字，成功或失敗都還原', function () {
  const code = stripJsComments(uiFiles().filter(function (f) { return f.name === 'Script.html'; })[0].text);

  assert.ok(code.indexOf('function setPublishButtonsBusy(') !== -1);
  assert.ok(code.indexOf('setPublishButtonsBusy(true,') !== -1, '撳下去要立刻停用');
  assert.ok((code.split('setPublishButtonsBusy(false)').length - 1) >= 2,
    '成功與失敗兩條路徑都要還原，否則按鈕會永遠停在「發佈中…」');
});

test('14c. 「開啟目前已發佈的 PDF」已經移出發佈區塊，在狀態列以單一連結「開啟 PDF」呈現', function () {
  // ⚠️ 這一條在 prompt-pre-usertest.md 那一輪被進一步簡化：狀態列裏
  // 原本同時放了 publishStatusLink（「開啟」）與 openPublishedPdfBtn
  // （「開啟目前已發佈的 PDF」）兩顆按鈕，視覺上文字疊在一起變成
  // 「開啟開啟目前已發佈的 PDF」。現在只保留**一顆**，文字是「開啟 PDF」。
  const index = uiFiles().filter(function (f) { return f.name === 'Index.html'; })[0].text;
  const script = uiFiles().filter(function (f) { return f.name === 'Script.html'; })[0].text;

  assert.ok(index.indexOf('downloadPublishedPdfBtn') === -1, '舊那一顆要拿走');
  assert.ok(index.indexOf('id="openPublishedPdfBtn"') === -1, '這一顆已經併入 publishStatusLink，不應該還存在');

  // 狀態列裏只有一個 <a>，而且文字是「開啟 PDF」。
  const statusBarStart = index.indexOf('id="publishStatusBar"');
  const statusBarEnd = index.indexOf('</div>', statusBarStart);
  const statusBarHtml = index.slice(statusBarStart, statusBarEnd);
  const anchorCount = (statusBarHtml.match(/<a\b/g) || []).length;
  assert.strictEqual(anchorCount, 1, '狀態列裏只可以有一個連結，避免文字重疊看起來像重複');
  assert.ok(statusBarHtml.indexOf('>開啟 PDF<') !== -1, statusBarHtml);

  // 它要在狀態列裏面，不在發佈區塊。
  const panelStart = index.indexOf('class="panel publish-panel"');
  const linkAt = index.indexOf('id="publishStatusLink"');
  assert.ok(statusBarStart < linkAt && linkAt < panelStart,
    '這一顆要在狀態列之內、發佈區塊之前——放在「選 PDF」旁邊正是揀錯檔案的成因');
  // 三步驟寫成編號清單。
  assert.ok(index.indexOf('class="publish-steps"') !== -1);
  assert.ok(script.indexOf("s.links.view") !== -1);
});

test('11b. 進階服務未啟用 → 訊息叫人去啟用，不是叫人重新建立檔案', function () {
  // ⚠️ 「查不到」與「不存在」是兩件事，處理方法相反：一個要去編輯器撳
  // 一次，一個要重新建立——而重新建立會**換掉那條印在教會網站上的連結**。
  // 講錯一句，人就會去做一件不應該做的事。
  const env = makeEnv({});
  delete env.sandbox.Drive;

  const result = env.sandbox.ensureMasterPublishFile_();
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'ADVANCED_SERVICE_DISABLED');
  assert.ok(result.message.indexOf('尚未啟用') !== -1, result.message);
  assert.ok(result.message.indexOf('不要**清空') !== -1 || result.message.indexOf('不要') !== -1,
    '要明確叫人先不要清空 Config 那一格');
  assert.ok(result.message.indexOf('重新建立') === -1,
    '這一種情況不可以叫人重新建立——那會換掉連結');
});

// =====================================================================
// 15. 由真正入口跑一次
// =====================================================================

test('15. 由真正入口（apiRunPublish）跑一次完整發佈，不拋錯', function () {
  const env = makeEnv({ config: { PUBLISH_DEDUP_SEC: '30' } });
  const resp = env.sandbox.apiRunPublish({
    isoDate: TARGET_DATE, doPublish: true, doSend: true,
    pdfBase64: PDF_A, pdfName: '週報.pdf',
    groups: ['CC'], customEmails: '', confirmed: true
  });

  assert.strictEqual(resp.ok, true, JSON.stringify(resp.error || {}));
  assert.strictEqual(resp.data.ok, true, resp.data.message);
  assert.strictEqual(resp.data.published.versionNo, 1);
  assert.strictEqual(env.mails.length, 1);
  assert.strictEqual(readErrorLog(env).length, 0, '順利跑完就不應該有任何 ErrorLog');

  // 每一個 Drive 呼叫都帶了 Shared Drive 參數。
  env.drive.calls.forEach(function (c) {
    assert.strictEqual(c.options.supportsAllDrives, true, c.method + ' 缺少 supportsAllDrives');
  });

  // 再撳一次（模擬使用者見不到反應多撳一下）→ 不會產生第 2 版。
  const again = env.sandbox.apiRunPublish({
    isoDate: TARGET_DATE, doPublish: true, doSend: true,
    pdfBase64: PDF_B, pdfName: '週報.pdf',
    groups: ['CC'], customEmails: '', confirmed: true
  });
  assert.strictEqual(again.data.duplicate, true);
  assert.strictEqual(env.mails.length, 1, '重複那一次連信都不可以再寄一封');
});

test('16. 這一輪新增的使用者可見文字，一律書面語繁體中文', function () {
  const env = makeEnv({});
  const s = env.sandbox;
  const texts = [];

  texts.push(s.classifyUploadedPdfSource_('x', 'x', '', true).message);
  texts.push(s.classifyUploadedPdfSource_('x', '', 'x', true).message);
  texts.push(makeEnv({ lockBusy: true }).sandbox.runPublishFlow_({
    isoDate: TARGET_DATE, doPublish: true, doSend: false,
    pdfBase64: PDF_A, pdfName: 'x.pdf', confirmed: true
  }).message);
  const dupEnv = makeEnv({ config: { PUBLISH_DEDUP_SEC: '30' } });
  publishOnce(dupEnv, PDF_A);
  texts.push(publishOnce(dupEnv, PDF_B).lines.join('\n'));

  texts.forEach(function (text, i) {
    assertWrittenChinese(assert, '第 ' + (i + 1) + ' 段修正文案', String(text || ''));
  });

  // 介面文案（三步驟、按鈕、逾時訊息）也一起驗。
  const index = uiFiles().filter(function (f) { return f.name === 'Index.html'; })[0].text;
  const steps = /<ol class="publish-steps">([\s\S]*?)<\/ol>/.exec(index);
  assertWrittenChinese(assert, '發佈三步驟', steps[1].replace(/<[^>]+>/g, ' '));
});

// =====================================================================

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
