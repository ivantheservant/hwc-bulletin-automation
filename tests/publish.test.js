#!/usr/bin/env node
/**
 * tests/publish.test.js
 *
 * 發佈及匯出（R-001 至 R-009）的回歸測試。
 *
 * 最核心的幾條：
 *   - **檔案 ID 不變**（6）：R-001 整個承諾就是這一條。ID 一變，教會網站
 *     上那條連結就死了。
 *   - **失敗不寫 `PublishLog`**（9）：覆寫失敗卻記了一筆，頂部狀態列會
 *     長期顯示一個假象——「已發佈第 3 版」，而連結裏面還是第 2 版。
 *   - **未勾確認就一格都不寫**（16）：R-006／R-007 的把關在**後端**，
 *     只擋前端等於沒有擋。
 *   - **未填欄位只有一個真相來源**（10）：清單一定來自
 *     `buildBulletinModel_()`，不可以另寫一套判斷。
 *
 * 執行方式：node tests/publish.test.js
 * 離開碼：0＝全部通過　1＝有測試失敗
 */

'use strict';

const assert = require('assert');
const { loadAllSrcFilesInOrder } = require('./helpers/loadGas');
const { makeFakeSheet, makeFakeSpreadsheet } = require('./helpers/fakeSpreadsheet');
const { assertWrittenChinese } = require('./helpers/writtenChinese');

const FAKE_ROSTER_ID = 'FAKE_ROSTER_ID_FOR_PUBLISH_TESTS';
const MASTER_FOLDER_ID = 'FAKE_MASTER_FOLDER';
const ARCHIVE_FOLDER_ID = 'FAKE_ARCHIVE_FOLDER';
const MASTER_FILE_ID = 'FAKE_MASTER_FILE';
const QUARTER_ID = '2027T4';
const SERVICE_DATES = ['2027-10-03', '2027-10-10', '2027-10-17', '2027-10-24', '2027-10-31', '2027-11-07'];
const TARGET_DATE = '2027-11-07';

/** 一個最小、合法的 PDF 的 base64（頭四個位元組是 `%PDF`）。 */
const PDF_BASE64 = Buffer.from('%PDF-1.4\n1 0 obj\nendobj\n%%EOF\n', 'latin1').toString('base64');
/** 另一份內容**不同**的合法 PDF（重複發佈那一條要用兩份不同的檔案）。 */
const PDF_BASE64_V2 = Buffer.from(
  ['%PDF-1.4', '1 0 obj', '(second version)', 'endobj', '%%EOF', ''].join('\n'), 'latin1'
).toString('base64');
/** 一個**不是** PDF 的檔案（Word 檔的 ZIP 標記 `PK`）。 */
const NOT_PDF_BASE64 = Buffer.from('PKrest of a docx', 'latin1').toString('base64');

let pass = 0;
let fail = 0;

/**
 * 跨 vm realm 安全的深層比較。
 *
 * ⚠️ 不可以直接用 assert 的深層比較去比對 sandbox 回來的陣列／
 * 物件：它們的 `Array`／`Object` 建構子跟測試這一邊不是同一個，
 * deepStrictEqual 會判「結構相同但不是同一個原型」而失敗。轉成 JSON
 * 再比就沒有這個問題。
 */
function deepEq(actual, expected, message) {
  assert.strictEqual(JSON.stringify(actual), JSON.stringify(expected), message);
}

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

/**
 * 造一個假的 Blob。只實作本輪真的會用到的幾個方法。
 */
function makeFakeBlob(bytes, mimeType, name) {
  const blob = {
    __bytes: bytes.slice(),
    __mime: mimeType,
    __name: name,
    getBytes: function () { return blob.__bytes.slice(); },
    getName: function () { return blob.__name; },
    getContentType: function () { return blob.__mime; },
    setName: function (n) { blob.__name = n; return blob; },
    getAs: function (mime) { return makeFakeBlob([0x25, 0x50, 0x44, 0x46], mime, blob.__name); }
  };
  return blob;
}

function baseStubs(o) {
  const opts = o || {};
  const todayIso = opts.todayIso || '2027-11-01';

  return {
    Utilities: {
      /**
       * ⚠️ 「今日」是這一輪唯一沒有辦法從外面注入的東西——`publishConfig_()`
       * 那邊寫的是 `Utilities.formatDate(new Date(), …)`。這裏的做法是：
       * 傳進來的 Date 如果跟真正的現在只差幾秒（即呼叫端剛剛 `new Date()`），
       * 就當它是在問「今日是幾號」，回傳測試設定的日期；其餘一律照實
       * 格式化。這樣既不用改生產程式碼去遷就測試，也控制得到日期異常
       * 那三條（R-007）要用的「今日」。
       */
      formatDate: function (date, tz, pattern) {
        const isNow = Math.abs(Date.now() - date.getTime()) < 5000;
        if (isNow && String(pattern).indexOf('HH') === -1) return todayIso;

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
        // Apps Script 回的是 signed byte，這裏照樣模擬，確保
        // validateUploadedPdf_() 的 `& 0xFF` 真的有被測到。
        for (let i = 0; i < buf.length; i++) out.push(buf[i] > 127 ? buf[i] - 256 : buf[i]);
        return out;
      },
      base64Encode: function (bytes) {
        return Buffer.from((bytes || []).map(function (b) { return b < 0 ? b + 256 : b; })).toString('base64');
      },
      DigestAlgorithm: { MD5: 'MD5' },
      /**
       * ⚠️ 一定要有：`pdfFingerprint_()` 靠它認出「使用者選回了目前
       * 已發佈的那一份」。缺了它，指紋一律是空字串，那一道防線就會
       * **靜靜地永遠不生效**——測試全部照樣通過，正是最危險的那一種。
       */
      computeDigest: function (algorithm, value) {
        const bytes = Array.isArray(value)
          ? Buffer.from(value.map(function (b) { return b < 0 ? b + 256 : b; }))
          : Buffer.from(String(value), 'utf8');
        return Array.prototype.slice.call(require('crypto').createHash('md5').update(bytes).digest());
      },
      newBlob: function (content, mimeType, name) {
        let bytes;
        if (Array.isArray(content)) {
          bytes = content.slice();
        } else {
          bytes = Array.prototype.slice.call(Buffer.from(String(content), 'utf8'));
        }
        return makeFakeBlob(bytes, mimeType, name);
      }
    },
    Session: {
      getScriptTimeZone: function () { return 'Pacific/Auckland'; },
      getActiveUser: function () { return { getEmail: function () { return opts.actorEmail || 'tester@example.com'; } }; },
      getEffectiveUser: function () { return { getEmail: function () { return opts.actorEmail || 'tester@example.com'; } }; }
    },
    CacheService: {},
    HtmlService: {},
    PropertiesService: {
      getUserProperties: function () {
        return { getProperty: function () { return null; }, setProperty: function () {} };
      },
      // 指令碼層屬性是防重複發佈與佔位檔指紋的存放處。**同一個 options
      // 物件共用一份**，這樣同一個測試內連續兩次發佈才看得到第一次留下
      // 的時間戳記。
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
 *   todayIso           今日（控制日期異常那三條）。
 *   config             覆蓋 Config。
 *   publishLog         `PublishLog` 既有資料列。
 *   weekFields         `BulletinWeeks` 目標主日那一行要補填的欄位。
 *   recipients         `Recipients` 資料列。
 *   masterFileMissing  master 檔案「開不到」（模擬被刪）。
 *   overwriteError     `Drive.Files.update()` 要拋的錯誤訊息。
 *   archiveError       存檔副本要拋的錯誤訊息。
 */
function makeEnv(options) {
  const o = options || {};
  const boot = loadAllSrcFilesInOrder(baseStubs(o));

  const cfg = {};
  boot.DEFAULTS.forEach(function (d) { cfg[d.key] = d.value; });
  cfg.ROSTER_SPREADSHEET_ID = FAKE_ROSTER_ID;
  cfg.PUBLISHED_PDF_FOLDER_ID = MASTER_FOLDER_ID;
  cfg.PUBLISHED_ARCHIVE_FOLDER_ID = ARCHIVE_FOLDER_ID;
  cfg.PUBLISHED_PDF_FILE_ID = o.noMasterFile ? '' : MASTER_FILE_ID;
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

  ownSheets.BulletinWeeks = ownSheet('BULLETIN_WEEKS', SERVICE_DATES.map(function (iso, i) {
    const row = { SERVICE_DATE: iso, QUARTER_ID: QUARTER_ID, WEEK_OF_MONTH: (i % 4) + 1, STATUS: 'DRAFT' };
    if (iso === TARGET_DATE) Object.assign(row, o.weekFields || {});
    return row;
  }));

  ownSheets.PublishLog = ownSheet('PUBLISH_LOG', o.publishLog || []);
  ownSheets.Recipients = ownSheet('RECIPIENTS', o.recipients === undefined ? [
    { RECIPIENT_ID: 'R1', NAME: '堂委甲', EMAIL: 'cc1@example.com', GROUP_NAME: 'CC', ACTIVE: true },
    { RECIPIENT_ID: 'R2', NAME: '執事乙', EMAIL: 'db1@example.com', GROUP_NAME: 'DB', ACTIVE: true },
    { RECIPIENT_ID: 'R3', NAME: 'IT 丙', EMAIL: 'it1@example.com', GROUP_NAME: 'IT', ACTIVE: true }
  ] : o.recipients);
  ownSheets.EmailTemplates = ownSheet('EMAIL_TEMPLATES', boot.seedEmailTemplatesRows_());
  ownSheets.Announcements = ownSheet('ANNOUNCEMENTS', o.announcements || []);
  ownSheets.Prayers = ownSheet('PRAYERS', o.prayers || []);
  ownSheets.Fellowships = ownSheet('FELLOWSHIPS', o.fellowships || []);

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
  const drive = {
    files: {},
    createdFiles: [],
    updateCalls: [],
    sharingCalls: []
  };
  if (!o.noMasterFile && !o.masterFileMissing) {
    drive.files[MASTER_FILE_ID] = { fileId: MASTER_FILE_ID, name: '（尚未發佈）', folder: MASTER_FOLDER_ID };
  }

  let nextFileSeq = 0;
  function makeFileHandle(record) {
    return {
      getId: function () { return record.fileId; },
      getName: function () { return record.name; },
      getUrl: function () { return 'https://drive.google.com/file/d/' + record.fileId + '/view'; },
      getBlob: function () { return makeFakeBlob(record.bytes || [], 'application/pdf', record.name); },
      setName: function (n) { record.name = n; return this; },
      setSharing: function (access, permission) {
        drive.sharingCalls.push({ fileId: record.fileId, access: access, permission: permission });
        record.sharing = { access: access, permission: permission };
        return this;
      }
    };
  }

  function makeFolderHandle(folderId) {
    return {
      getId: function () { return folderId; },
      createFile: function (blob) {
        if (folderId === ARCHIVE_FOLDER_ID && o.archiveError) throw new Error(o.archiveError);
        nextFileSeq++;
        const record = {
          fileId: 'NEW_FILE_' + nextFileSeq, name: blob.getName(), folder: folderId,
          bytes: blob.getBytes()
        };
        drive.files[record.fileId] = record;
        drive.createdFiles.push(record);
        return makeFileHandle(record);
      }
    };
  }

  const FakeDriveApp = {
    Access: { ANYONE_WITH_LINK: 'ANYONE_WITH_LINK', DOMAIN: 'DOMAIN', PRIVATE: 'PRIVATE' },
    Permission: { VIEW: 'VIEW', EDIT: 'EDIT' },
    getFolderById: function (id) {
      if (id !== MASTER_FOLDER_ID && id !== ARCHIVE_FOLDER_ID) {
        throw new Error('No item with the given ID could be found: ' + id);
      }
      return makeFolderHandle(id);
    },
    getFileById: function (id) {
      if (!drive.files[id]) throw new Error('No item with the given ID could be found: ' + id);
      return makeFileHandle(drive.files[id]);
    }
  };

  // ⚠️ 這個替身刻意在**缺少 `supportsAllDrives`** 時拋 `File not found`
  // ——真正的 Drive 進階服務在 Shared Drive 上就是這樣回應的（見
  // docs/已知bug類型.md 事故二十四）。這樣寫，日後有人把那個參數拿走，
  // 測試就會表現成一模一樣的症狀，而不是靜靜通過。
  function assertSharedDriveOption(optionalArgs, method) {
    if (!optionalArgs || optionalArgs.supportsAllDrives !== true) {
      throw new Error('File not found（' + method + ' 缺少 supportsAllDrives）');
    }
  }

  const FakeDrive = {
    Files: {
      update: function (metadata, fileId, blob, optionalArgs) {
        assertSharedDriveOption(optionalArgs, 'Drive.Files.update');
        if (o.overwriteError) throw new Error(o.overwriteError);
        if (!drive.files[fileId]) throw new Error('File not found: ' + fileId);
        drive.updateCalls.push({
          fileId: fileId, title: metadata && metadata.title,
          byteCount: blob.getBytes().length,
          supportsAllDrives: optionalArgs.supportsAllDrives
        });
        drive.files[fileId].bytes = blob.getBytes();
        if (metadata && metadata.title) drive.files[fileId].name = metadata.title;
        // Drive v2 回傳的物件用 `id` 這個欄位。
        return { id: fileId };
      },
      get: function (fileId, optionalArgs) {
        assertSharedDriveOption(optionalArgs, 'Drive.Files.get');
        if (!drive.files[fileId]) throw new Error('File not found: ' + fileId);
        return { id: fileId, title: drive.files[fileId].name };
      },
      list: function (optionalArgs) {
        assertSharedDriveOption(optionalArgs, 'Drive.Files.list');
        return { items: [] };
      }
    }
  };

  const mails = [];
  const FakeMailApp = {
    sendEmail: function (payload) { mails.push(payload); },
    getRemainingDailyQuota: function () { return 100; }
  };

  const uiAlerts = [];
  const FakeSpreadsheetApp = {
    getActiveSpreadsheet: function () { return makeFakeSpreadsheet(ownSheets); },
    openById: function (id) {
      if (id === FAKE_ROSTER_ID) return makeFakeSpreadsheet(rosterSheets);
      throw new Error('openById: 找不到 ' + id);
    },
    newDataValidation: function () {
      const b = {
        requireValueInList: function () { return b; },
        setAllowInvalid: function () { return b; },
        build: function () { return {}; }
      };
      return b;
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
        alert: function (a, b) { uiAlerts.push({ title: a, body: b }); return 'OK'; },
        prompt: function () {
          return { getSelectedButton: function () { return 'OK'; }, getResponseText: function () { return ''; } };
        },
        showModalDialog: function () {},
        ButtonSet: { OK: 'OK', OK_CANCEL: 'OK_CANCEL', YES_NO: 'YES_NO' },
        Button: { OK: 'OK', CANCEL: 'CANCEL', YES: 'YES', NO: 'NO' }
      };
    }
  };

  const sandbox = loadAllSrcFilesInOrder(Object.assign({}, baseStubs(o), {
    SpreadsheetApp: FakeSpreadsheetApp,
    DriveApp: FakeDriveApp,
    Drive: FakeDrive,
    MailApp: FakeMailApp,
    LockService: {
      getScriptLock: function () {
        return { tryLock: function () { return true; }, releaseLock: function () {} };
      }
    },
    ScriptApp: { getProjectTriggers: function () { return []; } }
  }));

  return {
    sandbox: sandbox, sheets: ownSheets, drive: drive,
    mails: mails, uiAlerts: uiAlerts, config: cfg
  };
}

/** 一份「填得很齊」的 BulletinWeeks 欄位，用來造出 0 個未填欄位的情境。 */
function fullWeekFields(boot) {
  const fields = {
    CALL_TEXT: '你們要讚美耶和華', CALL_REF: '詩篇 150:1',
    SCRIPTURE_REF: '約翰福音 3:16', SERMON_TITLE: '神愛世人',
    RESPONSE_HYMN: '普天頌讚 123', FLOWER_THIS_WEEK: '王氏家庭'
  };
  boot.attendanceRowDefs_().forEach(function (def) {
    def.keys.forEach(function (key) { fields[key] = 100; });
  });
  return fields;
}

function readPublishLog(env) {
  return env.sandbox.readSheet(env.sandbox.SHEETS.PUBLISH_LOG);
}

function readSendLog(env) {
  return env.sandbox.readSheet(env.sandbox.SHEETS.SEND_LOG);
}

function readErrorLog(env) {
  return env.sandbox.readSheet(env.sandbox.SHEETS.ERROR_LOG);
}

/** 造一個「今日剛好就是目標主日的前一個星期日」的環境，日期完全正常。 */
function makeCleanEnv(extra) {
  const probe = loadAllSrcFilesInOrder(baseStubs({}));
  const o = Object.assign({
    // 今日 = 目標主日當日 → 下一個主日就是它本身，沒有 PAST_DATE 也沒有
    // NOT_NEXT_SUNDAY；上一次發佈是前一個主日 → 沒有 SKIPPED_SUNDAYS。
    todayIso: TARGET_DATE,
    weekFields: fullWeekFields(probe),
    announcements: [{ SERVICE_DATE: TARGET_DATE, SEQ_NO: 10, TEXT: '家事一', ACTIVE: true }],
    prayers: [{ SERVICE_DATE: TARGET_DATE, SEQ_NO: 10, TEXT: '代禱一', ACTIVE: true }],
    fellowships: [{
      SERVICE_DATE: TARGET_DATE, SEQ_NO: 10, FELLOWSHIP_NAME: '成人團契',
      MEETING_DATE: '2027-11-12', MEETING_TIME: '晚上七時', CONTENT: '查經', ACTIVE: true
    }],
    publishLog: [{
      SERVICE_DATE: '2027-10-31', VERSION_NO: 1, PUBLISHED_AT: '2027-10-30',
      PUBLISHED_BY: 'tester@example.com', ARCHIVE_FILE_ID: 'OLD', SENT: true,
      SENT_GROUPS: 'CC,DB', MISSING_COUNT: 0, FORCED: false, FORCED_REASON: ''
    }],
    // ⚠️ 這一組測試預設**關掉防重複**（`PUBLISH_DEDUP_SEC: '0'`）：它們
    // 要驗的是發佈本身的行為，而測試裏兩次呼叫之間相隔幾毫秒，一開著
    // 防重複就會全部變成「剛才已經發佈過」。防重複自己那幾條在
    // tests/publishfix.test.js 專門驗。
    config: { DRY_RUN: 'FALSE', PUBLISH_DEDUP_SEC: '0' }
  }, extra || {});
  return makeEnv(o);
}

// =====================================================================
// 1-3. 建立 master 發佈檔案
// =====================================================================

test('1. 建立 master 檔案：冪等，已經有而且開得到就不重建', function () {
  const env = makeEnv({});
  const result = env.sandbox.ensureMasterPublishFile_();

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.created, false, '已經有檔案就不可以重建');
  assert.strictEqual(result.fileId, MASTER_FILE_ID, '檔案 ID 要原樣沿用');
  assert.strictEqual(env.drive.createdFiles.length, 0, '一個新檔案都不應該建立');
});

test('2. 建立 master 檔案：權限是「知道連結的人可檢視」，不是可編輯', function () {
  const env = makeEnv({ noMasterFile: true });
  const result = env.sandbox.ensureMasterPublishFile_();

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.created, true);
  assert.strictEqual(env.drive.sharingCalls.length, 1);
  assert.strictEqual(env.drive.sharingCalls[0].access, 'ANYONE_WITH_LINK');
  assert.strictEqual(env.drive.sharingCalls[0].permission, 'VIEW');
});

test('3. 建立 master 檔案：ID 寫回 Config，三條連結都用同一個 ID', function () {
  const env = makeEnv({ noMasterFile: true });
  const result = env.sandbox.ensureMasterPublishFile_();

  const written = env.sandbox.getConfig(env.sandbox.CONFIG_KEYS.PUBLISHED_PDF_FILE_ID, '');
  assert.strictEqual(written, result.fileId, 'ID 一定要寫回 Config，否則下次又會再建立一個');

  assert.strictEqual(result.links.view, 'https://drive.google.com/file/d/' + result.fileId + '/view');
  assert.strictEqual(result.links.preview, 'https://drive.google.com/file/d/' + result.fileId + '/preview');
  assert.strictEqual(result.links.download,
    'https://drive.google.com/uc?export=download&id=' + result.fileId);
});

test('3b. 建立 master 檔案：Config 有 ID 但檔案開不到 → 拒絕，而且不會靜靜建立一個新的', function () {
  const env = makeEnv({ masterFileMissing: true });
  const result = env.sandbox.ensureMasterPublishFile_();

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'FILE_MISSING');
  assert.strictEqual(env.drive.createdFiles.length, 0, '重建會換掉連結，不可以自動做');
  assert.ok(result.message.indexOf('新的連結') !== -1, result.message);
});

// =====================================================================
// 4-5. 上載 PDF 的驗證
// =====================================================================

test('4. 上載非 PDF → 拒絕，而且訊息明確講出「不是 PDF」', function () {
  const env = makeCleanEnv();
  const result = env.sandbox.runPublishFlow_({
    isoDate: TARGET_DATE, doPublish: true, doSend: false,
    pdfBase64: NOT_PDF_BASE64, pdfName: '週報.pdf', confirmed: true
  });

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'NOT_PDF');
  assert.ok(result.message.indexOf('不是 PDF 檔案') !== -1, result.message);
  assert.ok(result.message.indexOf('副檔名') !== -1, '要講明副檔名不作準');
  assert.strictEqual(env.drive.updateCalls.length, 0, '驗證未過就一個 Drive 呼叫都不應該有');
  assert.strictEqual(readPublishLog(env).length, 1, 'PublishLog 維持原有那一行，不可以多一行');
});

test('5. 上載超過 PUBLISH_MAX_PDF_MB → 拒絕，訊息含實際大小與上限', function () {
  const env = makeCleanEnv({ config: { DRY_RUN: 'FALSE', PUBLISH_MAX_PDF_MB: '1' } });

  // 造一個 2 MB、開頭是 %PDF 的假檔案。
  const big = Buffer.alloc(2 * 1024 * 1024, 0x41);
  big.write('%PDF', 0, 'latin1');
  const result = env.sandbox.runPublishFlow_({
    isoDate: TARGET_DATE, doPublish: true, doSend: false,
    pdfBase64: big.toString('base64'), pdfName: '大.pdf', confirmed: true
  });

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'TOO_LARGE');
  assert.ok(result.message.indexOf('上限 1 MB') !== -1, result.message);
  assert.strictEqual(readPublishLog(env).length, 1, 'PublishLog 維持原有那一行，不可以多一行');
});

test('5b. validateUploadedPdf_：空檔案 → 拒絕（0 個位元組不是「小小的 PDF」）', function () {
  const env = makeEnv({});
  const result = env.sandbox.validateUploadedPdf_([], 10);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'EMPTY_FILE');
});

// =====================================================================
// 6-9. 執行發佈
// =====================================================================

test('6. 發佈：master 檔案 ID 前後不變（R-001 的核心承諾）', function () {
  const env = makeCleanEnv();
  const result = env.sandbox.runPublishFlow_({
    isoDate: TARGET_DATE, doPublish: true, doSend: false,
    pdfBase64: PDF_BASE64, pdfName: '週報.pdf', confirmed: true
  });

  assert.strictEqual(result.ok, true, result.message);
  assert.strictEqual(result.published.fileId, MASTER_FILE_ID);
  assert.strictEqual(env.drive.updateCalls.length, 1, '一定要原地覆寫，不可以刪除再上載');
  assert.strictEqual(env.drive.updateCalls[0].fileId, MASTER_FILE_ID);
  // 檔名同時在那一次 update 設回 Config 的名稱。
  assert.strictEqual(env.drive.updateCalls[0].title, '粵語堂週報（最新一期）.pdf');
  assert.strictEqual(env.drive.files[MASTER_FILE_ID].fileId, MASTER_FILE_ID, '檔案 ID 一個字元都不可以變');
});

test('7. 發佈：存檔副本命名正確，含日期與版本號', function () {
  const env = makeCleanEnv();
  env.sandbox.runPublishFlow_({
    isoDate: TARGET_DATE, doPublish: true, doSend: false,
    pdfBase64: PDF_BASE64, pdfName: '隨便.pdf', confirmed: true
  });

  const archived = env.drive.createdFiles.filter(function (f) { return f.folder === ARCHIVE_FOLDER_ID; });
  assert.strictEqual(archived.length, 1);
  assert.strictEqual(archived[0].name, TARGET_DATE + '_粵語堂週報_v1.pdf');
});

test('8. 同一主日發佈兩次 → VERSION_NO 由 1 變 2', function () {
  const env = makeCleanEnv();
  // ⚠️ 兩次刻意用**不同內容**的 PDF：改完再發佈一次才是真實情境，而且
  // 用同一份會被「你選的是目前已發佈的那一份」那一道防線擋住（那是對的）。
  const first = env.sandbox.runPublishFlow_({
    isoDate: TARGET_DATE, doPublish: true, doSend: false,
    pdfBase64: PDF_BASE64, pdfName: '週報.pdf', confirmed: true
  });
  const second = env.sandbox.runPublishFlow_({
    isoDate: TARGET_DATE, doPublish: true, doSend: false,
    pdfBase64: PDF_BASE64_V2, pdfName: '週報-修訂.pdf', confirmed: true
  });

  assert.strictEqual(first.published.versionNo, 1);
  assert.strictEqual(second.published.versionNo, 2);

  const rows = readPublishLog(env).filter(function (r) {
    return env.sandbox.publishRowIsoDate_(r) === TARGET_DATE;
  });
  deepEq(rows.map(function (r) { return r.VERSION_NO; }), [1, 2]);
  // 第二版的存檔副本檔名要跟著改。
  const archived = env.drive.createdFiles.filter(function (f) { return f.folder === ARCHIVE_FOLDER_ID; });
  deepEq(archived.map(function (f) { return f.name; }),
    [TARGET_DATE + '_粵語堂週報_v1.pdf', TARGET_DATE + '_粵語堂週報_v2.pdf']);
});

test('9. 覆寫失敗 → 寫 ErrorLog、不寫 PublishLog（沒有成功就不算發佈過）', function () {
  const env = makeCleanEnv({ overwriteError: 'Drive is not defined' });
  const before = readPublishLog(env).length;

  const result = env.sandbox.runPublishFlow_({
    isoDate: TARGET_DATE, doPublish: true, doSend: false,
    pdfBase64: PDF_BASE64, pdfName: '週報.pdf', confirmed: true
  });

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'ADVANCED_SERVICE_DISABLED');
  assert.ok(result.message.indexOf('Drive 進階服務尚未啟用') !== -1, result.message);
  assert.strictEqual(readPublishLog(env).length, before, 'PublishLog 一行都不可以多');

  const errors = readErrorLog(env);
  assert.strictEqual(errors.length, 1);
  assert.strictEqual(errors[0].ERROR_CODE, 'ADVANCED_SERVICE_DISABLED');
});

test('9b. 存檔副本失敗 → master 已經換了，所以照樣算發佈成功，但要講出來', function () {
  // ⚠️ 這一條刻意跟 9 相反：覆寫失敗＝沒有發佈過；存檔失敗＝已經發佈了，
  // 只是少了一份副本。兩者回「失敗」與「成功」是相反的，不可以混為一談。
  const env = makeCleanEnv({ archiveError: 'Access denied: archive folder' });
  const result = env.sandbox.runPublishFlow_({
    isoDate: TARGET_DATE, doPublish: true, doSend: false,
    pdfBase64: PDF_BASE64, pdfName: '週報.pdf', confirmed: true
  });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.published.archiveFileId, '');
  assert.ok(result.published.archiveError.length > 0);
  assert.strictEqual(readPublishLog(env).length, 2, '既有一行 ＋ 今次一行；發佈本身成功，一定要記低');
  assert.ok(result.lines.join('\n').indexOf('存檔副本未能寫入') !== -1, result.lines.join('\n'));
});

// =====================================================================
// 10-11. 未填欄位（R-006）
// =====================================================================

test('10. 未填欄位清單來自 buildBulletinModel_()，不是另一套判斷', function () {
  const env = makeEnv({ todayIso: TARGET_DATE });
  const model = env.sandbox.buildBulletinModel_(TARGET_DATE);
  const precheck = env.sandbox.buildPublishPrecheck_(TARGET_DATE);

  assert.strictEqual(precheck.missingCount, model.missing.length,
    '兩者只可以有一個真相來源；數目對不上就代表有人另寫了一套判斷');
  deepEq(
    precheck.missing.map(function (m) { return m.field; }),
    model.missing.map(function (m) { return m.field; })
  );
});

test('11. 未填欄位全部列出，不截斷、不寫「等 N 項」', function () {
  const env = makeEnv({ todayIso: TARGET_DATE });
  const precheck = env.sandbox.buildPublishPrecheck_(TARGET_DATE);
  const text = precheck.lines.join('\n');

  assert.ok(precheck.missingCount >= 10, '這個情境本來就應該有很多項未填：' + precheck.missingCount);
  assert.ok(text.indexOf('等 ') === -1, '不可以出現「等 N 項」這種截斷寫法');
  assert.ok(text.indexOf('…') === -1, '不可以用省略號截斷');

  // 每一項的中文標題都要出現在報告裏面。
  const grouped = env.sandbox.groupPublishMissing_(precheck.missing);
  const total = grouped.reduce(function (sum, g) { return sum + g.items.length; }, 0);
  assert.strictEqual(total, precheck.missingCount, '分組之後總數要跟原始清單一樣，一項都不可以掉');
});

test('11b. 未填欄位分組：人數、家事報告、代禱事項、事奉人選各自成組', function () {
  const env = makeEnv({});
  const grouped = env.sandbox.groupPublishMissing_([
    { field: 'SERMON_TITLE', label: '講題' },
    { field: 'ATT_ENG_WORSHIP', label: '英語堂崇拜' },
    { field: 'ANNOUNCEMENTS', label: '家事報告' },
    { field: 'PRAYERS', label: '代禱事項' },
    { field: 'POST:CHAIR', label: '主席' }
  ]);

  deepEq(grouped.map(function (g) { return g.label; }),
    ['程序', '人數', '家事報告', '代禱事項', '事奉人選']);
  deepEq(grouped[0].items, ['講題']);
  deepEq(grouped[2].items, ['0 條']);
});

// =====================================================================
// 12-15. 日期異常（R-007）
// =====================================================================

test('12. 日期異常：主日已經過去 → 出現對應訊息', function () {
  const env = makeEnv({});
  const issues = env.sandbox.detectPublishDateIssues_({
    isoDate: '2027-10-03', todayIso: '2027-10-20', lastPublishedIso: '2027-10-03'
  });
  const codes = issues.map(function (i) { return i.code; });

  assert.ok(codes.indexOf('PAST_DATE') !== -1, JSON.stringify(codes));
  const past = issues.filter(function (i) { return i.code === 'PAST_DATE'; })[0];
  assert.ok(past.message.indexOf('已經過去') !== -1, past.message);
});

test('13. 日期異常：不是下一個主日 → 訊息含正確的下一個主日', function () {
  const env = makeEnv({});
  // 2026-08-22 是星期六，下一個主日是 2026-08-23。
  const issues = env.sandbox.detectPublishDateIssues_({
    isoDate: '2027-11-07', todayIso: '2026-08-22', lastPublishedIso: ''
  });
  const notNext = issues.filter(function (i) { return i.code === 'NOT_NEXT_SUNDAY'; });

  assert.strictEqual(notNext.length, 1);
  assert.ok(notNext[0].message.indexOf('2026-08-23') !== -1, notNext[0].message);
});

test('13b. 今日就是那一個主日 → 不算「不是下一個主日」（那一天還沒有過去）', function () {
  const env = makeEnv({});
  const issues = env.sandbox.detectPublishDateIssues_({
    isoDate: '2027-11-07', todayIso: '2027-11-07', lastPublishedIso: '2027-10-31'
  });
  deepEq(issues, []);
});

test('14. 日期異常：跳過主日 → N 的數目正確（頭尾都計入）', function () {
  const env = makeEnv({});
  // 上一次發佈 2027-10-03；這一期 2027-11-07。
  // 未發佈的是 10-10、10-17、10-24、10-31 共 4 個。
  const issues = env.sandbox.detectPublishDateIssues_({
    isoDate: '2027-11-07', todayIso: '2027-11-07', lastPublishedIso: '2027-10-03'
  });
  const skipped = issues.filter(function (i) { return i.code === 'SKIPPED_SUNDAYS'; });

  assert.strictEqual(skipped.length, 1);
  assert.ok(skipped[0].message.indexOf('4 個主日未發佈') !== -1, skipped[0].message);
  assert.ok(skipped[0].message.indexOf('2027-10-10 至 2027-10-31') !== -1, skipped[0].message);
});

test('14b. 三種日期異常可以同時出現，各自一句', function () {
  const env = makeEnv({});
  const issues = env.sandbox.detectPublishDateIssues_({
    isoDate: '2027-10-24', todayIso: '2027-11-01', lastPublishedIso: '2027-10-03'
  });
  const codes = issues.map(function (i) { return i.code; }).sort();
  deepEq(codes, ['NOT_NEXT_SUNDAY', 'PAST_DATE', 'SKIPPED_SUNDAYS']);
});

test('15. 沒有任何問題 → needsConfirm 是 false，不出確認視窗', function () {
  const env = makeCleanEnv();
  const precheck = env.sandbox.buildPublishPrecheck_(TARGET_DATE);

  assert.strictEqual(precheck.missingCount, 0, '這個情境應該填得很齊：'
    + JSON.stringify(precheck.missing.map(function (m) { return m.field; })));
  deepEq(precheck.dateIssues, []);
  assert.strictEqual(precheck.needsConfirm, false);
  assert.strictEqual(precheck.forcedReason, '');
});

// =====================================================================
// 16-17. 強制發佈
// =====================================================================

test('16. 未勾確認方框 → 拒絕發佈，而且一格都沒有寫', function () {
  const env = makeEnv({ todayIso: '2027-11-01' });
  const result = env.sandbox.runPublishFlow_({
    isoDate: TARGET_DATE, doPublish: true, doSend: false,
    pdfBase64: PDF_BASE64, pdfName: '週報.pdf', confirmed: false
  });

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'NEEDS_CONFIRM');
  assert.ok(result.precheck.needsConfirm);
  assert.strictEqual(env.drive.updateCalls.length, 0, 'Drive 一次都不可以碰');
  assert.strictEqual(env.drive.createdFiles.length, 0);
  assert.strictEqual(readPublishLog(env).length, 0);
  assert.strictEqual(readSendLog(env).length, 0);
});

test('17. 勾了確認方框 → FORCED=TRUE，FORCED_REASON 有內容', function () {
  const env = makeEnv({ todayIso: '2027-11-01', config: { DRY_RUN: 'FALSE' } });
  const result = env.sandbox.runPublishFlow_({
    isoDate: TARGET_DATE, doPublish: true, doSend: false,
    pdfBase64: PDF_BASE64, pdfName: '週報.pdf', confirmed: true
  });

  assert.strictEqual(result.ok, true, result.message);
  const rows = readPublishLog(env);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].FORCED, true);
  assert.ok(String(rows[0].FORCED_REASON).length > 0, '強制發佈一定要留下當時的問題摘要');
  assert.ok(String(rows[0].FORCED_REASON).indexOf('未填欄位') !== -1, rows[0].FORCED_REASON);
  assert.ok(Number(rows[0].MISSING_COUNT) > 0);
});

// =====================================================================
// 18-23. 發佈與寄出各自獨立（R-003／R-004）
// =====================================================================

test('18. 只發佈不寄 → SendLog 沒有新增', function () {
  const env = makeCleanEnv();
  env.sandbox.runPublishFlow_({
    isoDate: TARGET_DATE, doPublish: true, doSend: false,
    pdfBase64: PDF_BASE64, pdfName: '週報.pdf', confirmed: true
  });

  assert.strictEqual(readPublishLog(env).length, 2, '既有一行 ＋ 今次一行');
  assert.strictEqual(readSendLog(env).length, 0, '沒有勾寄出，SendLog 一行都不可以有');
  assert.strictEqual(env.mails.length, 0);
});

test('19. 只寄不發佈 → PublishLog 沒有新增', function () {
  const env = makeCleanEnv();
  const before = readPublishLog(env).length;

  const result = env.sandbox.runPublishFlow_({
    isoDate: TARGET_DATE, doPublish: false, doSend: true,
    groups: ['CC', 'DB'], customEmails: '', confirmed: true
  });

  assert.strictEqual(result.ok, true, result.message);
  assert.strictEqual(readPublishLog(env).length, before, '只寄出不可以令版本號往上跳');
  assert.strictEqual(env.drive.updateCalls.length, 0, 'master 檔案一下都不可以碰');
  assert.strictEqual(readSendLog(env).length, 2);
});

test('20. 只寄不發佈、但從未發佈過 → 拒絕，訊息明確', function () {
  const env = makeCleanEnv({ publishLog: [] });
  const result = env.sandbox.runPublishFlow_({
    isoDate: TARGET_DATE, doPublish: false, doSend: true,
    groups: ['CC'], customEmails: '', confirmed: true
  });

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'NEVER_PUBLISHED');
  assert.ok(result.message.indexOf('請先發佈一次') !== -1, result.message);
  assert.strictEqual(readSendLog(env).length, 0);
});

test('21. 兩個都沒勾 → 提示，而且沒有任何動作', function () {
  const env = makeCleanEnv();
  const result = env.sandbox.runPublishFlow_({
    isoDate: TARGET_DATE, doPublish: false, doSend: false, confirmed: true
  });

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'NOTHING_SELECTED');
  assert.ok(result.message.indexOf('至少勾選') !== -1, result.message);
  assert.strictEqual(readPublishLog(env).length, 1, '既有那一行不變，也沒有新增');

  assert.strictEqual(readSendLog(env).length, 0);
  assert.strictEqual(env.drive.updateCalls.length, 0);
});

test('22. DRY_RUN=TRUE → SendLog 有記錄，但一封都沒有真的寄', function () {
  const env = makeCleanEnv({ config: { DRY_RUN: 'TRUE' } });
  const result = env.sandbox.runPublishFlow_({
    isoDate: TARGET_DATE, doPublish: false, doSend: true,
    groups: ['CC', 'DB'], customEmails: '', confirmed: true
  });

  assert.strictEqual(result.ok, true, result.message);
  assert.strictEqual(result.sent.dryRun, true);
  assert.strictEqual(env.mails.length, 0, '模擬模式下一封都不可以真的寄出去');

  const logs = readSendLog(env);
  assert.strictEqual(logs.length, 2, '模擬也一定要留紀錄，否則試行等於甚麼都看不見');
  logs.forEach(function (row) {
    assert.strictEqual(row.DRY_RUN, true);
    assert.strictEqual(row.STATUS, 'PUBLISH');
  });
});

test('23. 自訂電郵格式無效 → 逐個列出並拒絕整次寄出', function () {
  const env = makeCleanEnv();
  const result = env.sandbox.runPublishFlow_({
    isoDate: TARGET_DATE, doPublish: false, doSend: true,
    groups: ['CC'], customEmails: 'good@example.com, 冇@符號, another-bad', confirmed: true
  });

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'INVALID_EMAIL');
  assert.ok(result.message.indexOf('冇@符號') !== -1, result.message);
  assert.ok(result.message.indexOf('another-bad') !== -1, result.message);
  assert.strictEqual(readSendLog(env).length, 0, '有一個格式錯就整次取消，不可以寄一半');
  assert.strictEqual(env.mails.length, 0);
});

test('23b. 收件人 = 勾選組別的 Recipients ＋ 自訂電郵，重複的只算一次', function () {
  const env = makeCleanEnv();
  const resolved = env.sandbox.resolvePublishRecipients_(
    ['CC', 'IT', 'SELF'], 'cc1@example.com, extra@example.com', 'tester@example.com');

  assert.strictEqual(resolved.ok, true);
  const emails = resolved.recipients.map(function (r) { return r.email; }).sort();
  deepEq(emails,
    ['cc1@example.com', 'extra@example.com', 'it1@example.com', 'tester@example.com']);
});

// =====================================================================
// 24-25. 狀態列與真正入口
// =====================================================================

test('24. 頂部狀態列取 PublishLog 最新一行，不是最後一行', function () {
  const env = makeEnv({
    publishLog: [
      // 刻意把「最新的」放在中間：人手補寫舊記錄時就會長成這樣。
      {
        SERVICE_DATE: '2027-10-03', VERSION_NO: 1, PUBLISHED_AT: '2027-09-30',
        PUBLISHED_BY: 'ivan@example.com', SENT: true, MISSING_COUNT: 0, FORCED: false
      },
      {
        SERVICE_DATE: '2027-11-07', VERSION_NO: 3, PUBLISHED_AT: '2027-11-06',
        PUBLISHED_BY: 'ivan@example.com', SENT: true, MISSING_COUNT: 0, FORCED: false
      },
      {
        SERVICE_DATE: '2027-10-10', VERSION_NO: 1, PUBLISHED_AT: '2027-10-08',
        PUBLISHED_BY: 'ivan@example.com', SENT: false, MISSING_COUNT: 0, FORCED: false
      }
    ]
  });

  const status = env.sandbox.buildPublishStatusForWebApp_();
  assert.strictEqual(status.published, true);
  assert.strictEqual(status.isoDate, '2027-11-07');
  assert.strictEqual(status.versionNo, 3);
  assert.strictEqual(status.publishedBy, 'ivan', '狀態列只顯示 @ 之前那一截，不掛完整電郵');
  assert.ok(status.text.indexOf('目前已發佈：2027-11-07（第 3 版）') === 0, status.text);
  assert.strictEqual(status.links.view, 'https://drive.google.com/file/d/' + MASTER_FILE_ID + '/view');
});

test('24b. 從未發佈過／未建立 master 檔案 → 兩種狀態的文字不同', function () {
  const never = makeEnv({ publishLog: [] }).sandbox.buildPublishStatusForWebApp_();
  assert.strictEqual(never.text, '尚未發佈過任何一期');

  const noMaster = makeEnv({ noMasterFile: true, publishLog: [] }).sandbox.buildPublishStatusForWebApp_();
  assert.strictEqual(noMaster.text, '尚未建立 master 發佈檔案');
  assert.strictEqual(noMaster.hasMaster, false);
});

test('25. 由真正入口（apiRunPublish）跑一次完整發佈流程，不拋錯', function () {
  const env = makeCleanEnv();
  const resp = env.sandbox.apiRunPublish({
    isoDate: TARGET_DATE, doPublish: true, doSend: true,
    pdfBase64: PDF_BASE64, pdfName: '週報.pdf',
    groups: ['CC', 'DB'], customEmails: '', confirmed: true
  });

  assert.strictEqual(resp.ok, true, JSON.stringify(resp.error || {}));
  assert.strictEqual(resp.data.ok, true, resp.data.message);
  assert.strictEqual(resp.data.published.versionNo, 1);
  assert.strictEqual(resp.data.sent.recipientCount, 2);
  assert.strictEqual(env.mails.length, 2);

  // 兩張紀錄表都要有；PublishLog 那一行要記得寄了給哪些組別。
  const publishRows = readPublishLog(env);
  assert.strictEqual(publishRows.length, 2, '既有一行 ＋ 今次一行');
  const latest = env.sandbox.latestPublishLogRow_(publishRows);
  assert.strictEqual(latest.SENT, true);
  assert.strictEqual(latest.SENT_GROUPS, 'CC,DB');
  assert.strictEqual(readSendLog(env).length, 2);

  // 通知信一定要有那一條永遠不變的連結，與一句講明它不會變。
  assert.ok(env.mails[0].body.indexOf('/file/d/' + MASTER_FILE_ID + '/view') !== -1, env.mails[0].body);
  assert.ok(env.mails[0].body.indexOf('這條連結固定不變') !== -1, env.mails[0].body);
  assert.strictEqual(env.mails[0].attachments.length, 1, 'PUBLISH_ATTACH_PDF 預設 TRUE');
});

test('25b. 由真正入口跑一次「需要確認」的情況：回 NEEDS_CONFIRM，一格都沒寫', function () {
  const env = makeEnv({ todayIso: '2027-11-01' });
  const resp = env.sandbox.apiRunPublish({
    isoDate: TARGET_DATE, doPublish: true, doSend: false,
    pdfBase64: PDF_BASE64, pdfName: '週報.pdf', groups: [], customEmails: '', confirmed: false
  });

  assert.strictEqual(resp.ok, true, '這不是例外，是一個正常的「請先確認」回應');
  assert.strictEqual(resp.data.ok, false);
  assert.strictEqual(resp.data.reason, 'NEEDS_CONFIRM');
  assert.ok(resp.data.lines.length > 1);
  assert.strictEqual(readPublishLog(env).length, 0);
});

// =====================================================================
// 26-30. 其餘純函式與文案
// =====================================================================

test('26. PUBLISH_ATTACH_PDF=FALSE → 通知信不附 PDF，但連結照舊', function () {
  const env = makeCleanEnv({ config: { DRY_RUN: 'FALSE', PUBLISH_ATTACH_PDF: 'FALSE' } });
  const result = env.sandbox.runPublishFlow_({
    isoDate: TARGET_DATE, doPublish: true, doSend: true,
    pdfBase64: PDF_BASE64, pdfName: '週報.pdf', groups: ['CC'], customEmails: '', confirmed: true
  });

  assert.strictEqual(result.ok, true, result.message);
  assert.strictEqual(result.sent.attached, false);
  assert.strictEqual(env.mails[0].attachments, undefined);
  assert.ok(env.mails[0].body.indexOf('/file/d/' + MASTER_FILE_ID + '/view') !== -1);
});

test('27. buildMinimalPdfText_：退回版佔位 PDF 以 %PDF 開頭，而且 xref 位移對得上', function () {
  const env = makeEnv({});
  const text = env.sandbox.buildMinimalPdfText_(['Not published yet.']);

  assert.strictEqual(text.slice(0, 4), '%PDF');
  const startxref = Number(/startxref\s+(\d+)/.exec(text)[1]);
  assert.strictEqual(text.slice(startxref, startxref + 4), 'xref',
    'startxref 指到的位移一定要真的是 xref 表的開頭');
  assert.ok(text.indexOf('%%EOF') !== -1);
});

test('28. classifyPublishError_：三種常見失敗要分得出來', function () {
  const env = makeEnv({});
  const cases = [
    ['Drive is not defined', 'ADVANCED_SERVICE_DISABLED'],
    ['No item with the given ID could be found', 'FILE_MISSING'],
    ['Access denied: DriveApp', 'NO_PERMISSION'],
    ['Something else entirely', 'PUBLISH_FAILED']
  ];
  cases.forEach(function (pair) {
    const result = env.sandbox.classifyPublishError_(new Error(pair[0]));
    assert.strictEqual(result.code, pair[1], pair[0] + ' → ' + result.code);
    assert.ok(result.message.length > 0);
  });
});

test('29. nextPublishVersion_ 按主日各自計算，不是整張表的行數加一', function () {
  const env = makeEnv({});
  const rows = [
    { SERVICE_DATE: '2027-10-03', VERSION_NO: 1 },
    { SERVICE_DATE: '2027-10-03', VERSION_NO: 2 },
    { SERVICE_DATE: '2027-10-10', VERSION_NO: 1 }
  ];
  assert.strictEqual(env.sandbox.nextPublishVersion_(rows, '2027-10-03'), 3);
  assert.strictEqual(env.sandbox.nextPublishVersion_(rows, '2027-10-10'), 2);
  assert.strictEqual(env.sandbox.nextPublishVersion_(rows, '2027-11-07'), 1);
});

test('30. 使用者可見文字一律書面語繁體中文，不用口語廣東話', function () {
  const env = makeCleanEnv();
  const s = env.sandbox;

  const texts = [];
  texts.push(s.validateUploadedPdf_([], 10).message);
  texts.push(s.validateUploadedPdf_([0x50, 0x4b, 0x03, 0x04], 10).message);
  texts.push(s.runPublishFlow_({ isoDate: TARGET_DATE, doPublish: false, doSend: false }).message);
  texts.push(s.runPublishFlow_({ isoDate: TARGET_DATE, doPublish: true, doSend: false }).message);
  texts.push(s.classifyPublishError_(new Error('Drive is not defined')).message);
  texts.push(s.classifyPublishError_(new Error('No item with the given ID could be found')).message);
  texts.push(s.classifyPublishError_(new Error('Access denied')).message);
  texts.push(s.resolvePublishRecipients_(['CC'], 'bad-email', '').message);
  texts.push(s.buildPublishStatusText_({ hasMaster: false }));
  texts.push(s.buildPublishStatusText_({ hasMaster: true, published: false }));
  texts.push(s.publishGroupOptions_().map(function (g) { return g.label; }).join('　'));
  texts.push(s.buildPublishPrecheckLines_({ isoDate: TARGET_DATE, missingCount: 0, dateIssues: [] }).join('\n'));
  texts.push(s.detectPublishDateIssues_({
    isoDate: '2027-10-24', todayIso: '2027-11-01', lastPublishedIso: '2027-10-03'
  }).map(function (i) { return i.message; }).join('\n'));
  texts.push(s.buildMasterPublishFileLines_({
    created: true, sharingApplied: true, links: s.masterPdfLinks_(MASTER_FILE_ID)
  }).join('\n'));
  texts.push(s.buildPublishResultLines_({
    published: { versionNo: 1, links: s.masterPdfLinks_(MASTER_FILE_ID), archiveFileUrl: 'x', archiveFileName: 'y.pdf' },
    sent: { dryRun: true, recipientCount: 2, attached: true },
    precheck: { needsConfirm: true }
  }).join('\n'));
  texts.push(s.seedPublishNoticeRow_().SUBJECT + '\n' + s.seedPublishNoticeRow_().BODY);

  texts.forEach(function (text, i) {
    assertWrittenChinese(assert, '第 ' + (i + 1) + ' 段發佈文案', String(text || ''));
  });
});

// =====================================================================

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
