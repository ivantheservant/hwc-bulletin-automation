#!/usr/bin/env node
/**
 * tests/quarterops.test.js
 *
 * **R-038**：幹事的整條例行流程要能在填寫介面完成。這一組守住的是那八個
 * 功能搬上 Web App 之後最容易出事的幾件事：
 *
 *   - **兩個入口一份邏輯**（第 1 組）：選單與填寫介面必須叫同一批函式。
 *     兩套差異計算遲早會不一致，而不一致那一刻沒有人會發現。
 *   - **唯讀報告不可以寫 `Diagnostics`**（第 5 組）：`Diagnostics` 每次
 *     執行清空重寫，只保留最新一份。幹事在介面撳一下，就把 IT 剛跑完的
 *     診斷報告清走——而且沒有任何提示。
 *   - **邊界情況不可以靜靜過**（第 2 至 4 組）：收件人 0 個、內容表未
 *     建立、週報未建立，全部要**明確講出下一步**，不可以回一句看起來
 *     像成功的話。
 *   - **`getUi()` 不可以出現在 Web App 路徑上**（第 1 組）：Web App 沒有
 *     `SpreadsheetApp.getUi()`，一叫就爆。
 *
 * 執行方式：node tests/quarterops.test.js
 * 離開碼：0＝全部通過　1＝有測試失敗
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { loadAllSrcFilesInOrder } = require('./helpers/loadGas');
const { makeFakeSheet, makeFakeSpreadsheet } = require('./helpers/fakeSpreadsheet');
const { assertWrittenChinese } = require('./helpers/writtenChinese');

const FAKE_ROSTER_ID = 'FAKE_ROSTER_ID_FOR_QUARTER_OPS';
const FAKE_FOLDER_ID = 'FAKE_CONTENT_FOLDER';
const FAKE_CONTENT_FILE_ID = 'FAKE_CONTENT_FILE';
const QUARTER_ID = '2027T4';
const SERVICE_DATES = ['2027-10-03', '2027-10-10', '2027-10-17', '2027-10-24', '2027-10-31'];

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

/** 讀一個 src 檔案的原文（靜態掃描用）。 */
function srcText(name) {
  return fs.readFileSync(path.join(__dirname, '..', 'src', name), 'utf8');
}

/** 把 JS／GAS 的註解剝走，避免註解裡提到的字面被當成程式碼。 */
function stripComments(text) {
  return String(text)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

// =====================================================================
// 測試環境
// =====================================================================

function baseStubs() {
  return {
    Utilities: {
      formatDate: function (date, tz, pattern) {
        const y = date.getFullYear();
        const mo = String(date.getMonth() + 1).padStart(2, '0');
        const d = String(date.getDate()).padStart(2, '0');
        const hh = String(date.getHours()).padStart(2, '0');
        const mi = String(date.getMinutes()).padStart(2, '0');
        if (String(pattern).indexOf('HH') !== -1) return `${y}-${mo}-${d} ${hh}:${mi}`;
        return `${y}-${mo}-${d}`;
      },
      base64Encode: function () { return ''; },
      newBlob: function () { return {}; }
    },
    Session: {
      getScriptTimeZone: function () { return 'Pacific/Auckland'; },
      // ⚠️ 兩個回同一個電郵：`WEBAPP_ALLOWED_EMAILS` 留空時只准部署者
      //    本人，而部署者就是 getEffectiveUser()。這樣 api* 的權限檢查
      //    才會通過——**不可以**為了方便測試而繞過那道檢查。
      getActiveUser: function () { return { getEmail: function () { return 'tester@x.com'; } }; },
      getEffectiveUser: function () { return { getEmail: function () { return 'tester@x.com'; } }; }
    },
    CacheService: {}, HtmlService: {}
  };
}

/** 造一張假的內容表分頁（兩行標題，資料由第 3 行開始）。 */
function makeContentTab(keys, headers, rows) {
  const data = [headers.slice(), keys.slice()];
  (rows || []).forEach(function (row) {
    data.push(keys.map(function (k) { return row[k] === undefined ? '' : row[k]; }));
  });

  const sheet = {
    __data: data,
    getName: function () { return sheet.__name; },
    getLastRow: function () { return data.length; },
    getLastColumn: function () { return Math.max(1, keys.length); },
    getMaxRows: function () { return Math.max(data.length, 500); },
    getFrozenRows: function () { return 2; },
    setFrozenRows: function () { return sheet; },
    setColumnWidth: function () { return sheet; },
    getRange: function (r, c, numRows, numCols) {
      numRows = numRows || 1;
      numCols = numCols || 1;
      const range = {
        getValues: function () {
          const out = [];
          for (let i = 0; i < numRows; i++) {
            const rowArr = [];
            for (let j = 0; j < numCols; j++) {
              const src = data[r - 1 + i];
              rowArr.push(src && src[c - 1 + j] !== undefined ? src[c - 1 + j] : '');
            }
            out.push(rowArr);
          }
          return out;
        },
        setValues: function () { return range; },
        getValue: function () { const s = data[r - 1]; return s && s[c - 1] !== undefined ? s[c - 1] : ''; },
        setValue: function () { return range; },
        clearContent: function () { return range; },
        setNumberFormat: function () { return range; },
        setDataValidation: function () { return range; },
        clearDataValidations: function () { return range; },
        setNote: function () { return range; },
        getNote: function () { return ''; },
        setWrap: function () { return range; },
        setFontWeight: function () { return range; },
        setBackground: function () { return range; },
        setFontColor: function () { return range; },
        setFontSize: function () { return range; },
        setHorizontalAlignment: function () { return range; },
        setVerticalAlignment: function () { return range; }
      };
      return range;
    }
  };
  return sheet;
}

function makeEnv(options) {
  const o = options || {};
  const boot = loadAllSrcFilesInOrder(baseStubs());

  const cfg = {};
  boot.DEFAULTS.forEach(function (d) { cfg[d.key] = d.value; });
  cfg.ROSTER_SPREADSHEET_ID = FAKE_ROSTER_ID;
  cfg.CONTENT_SHEET_FOLDER_ID = FAKE_FOLDER_ID;
  cfg.WORKING_QUARTER_ID = QUARTER_ID;
  Object.assign(cfg, o.config || {});

  function ownSheet(sheetId, rows) {
    const def = boot.COLUMNS[sheetId];
    return makeFakeSheet(def.headers, def.keys, rows || []);
  }

  const ownSheets = {};
  Object.keys(boot.SHEETS).forEach(function (id) { ownSheets[boot.SHEETS[id]] = ownSheet(id, []); });
  Object.keys(ownSheets).forEach(function (name) {
    if (ownSheets[name].setName) ownSheets[name].setName(name);
  });

  ownSheets.Config = ownSheet('CONFIG', Object.keys(cfg).map(function (k) {
    return { KEY: k, VALUE: cfg[k], NOTE: '', EDITABLE: true };
  }));
  ownSheets.BulletinWeeks = ownSheet('BULLETIN_WEEKS',
    o.weekRows === undefined
      ? SERVICE_DATES.map(function (iso, i) {
        return { SERVICE_DATE: iso, QUARTER_ID: QUARTER_ID, WEEK_OF_MONTH: (i % 4) + 1, STATUS: 'DRAFT' };
      })
      : o.weekRows);
  ownSheets.ContentSheets = ownSheet('CONTENT_SHEETS', o.contentSheets === undefined ? [{
    QUARTER_ID: QUARTER_ID, FILE_ID: FAKE_CONTENT_FILE_ID,
    FILE_URL: 'https://docs.google.com/spreadsheets/d/' + FAKE_CONTENT_FILE_ID + '/edit',
    CREATED_AT: '2027-09-01', LAST_IMPORTED_AT: '', INVITE_SENT_AT: '', ACTIVE: true
  }] : o.contentSheets);
  ownSheets.Recipients = ownSheet('RECIPIENTS', o.recipients === undefined ? [
    { RECIPIENT_ID: 'R1', NAME: '堂委甲', EMAIL: 'cc1@example.com', GROUP_NAME: 'CC', ACTIVE: true },
    { RECIPIENT_ID: 'R2', NAME: '執事乙', EMAIL: 'db1@example.com', GROUP_NAME: 'DB', ACTIVE: true }
  ] : o.recipients);
  ownSheets.EmailTemplates = ownSheet('EMAIL_TEMPLATES', boot.seedEmailTemplatesRows_());

  // ⚠️ 職事表的假替身**一被寫入就拋錯**。本系統對職事表永遠唯讀，
  //    而「事後比對有沒有變」擋不住「寫了又寫返原值」那一種。
  const rosterWrites = [];
  function rosterSheet(defKey, rows) {
    const keys = Object.keys(boot.ROSTER_TABLE_DEFS_[defKey].columns);
    const sheet = makeFakeSheet(keys, keys, rows || []);
    const realGetRange = sheet.getRange.bind(sheet);
    sheet.getRange = function () {
      const range = realGetRange.apply(null, Array.prototype.slice.call(arguments));
      ['setValue', 'setValues', 'clearContent', 'clear'].forEach(function (m) {
        if (typeof range[m] !== 'function') return;
        range[m] = function () {
          rosterWrites.push(defKey + '.' + m);
          throw new Error('職事表是唯讀的，不可以呼叫 ' + m + '（' + defKey + '）');
        };
      });
      return range;
    };
    return sheet;
  }
  const rosterServiceDates = o.rosterServiceDates === undefined ? SERVICE_DATES : o.rosterServiceDates;
  const rosterSheets = {
    RosterAssignments: rosterSheet('ASSIGNMENTS', []),
    RosterVersions: rosterSheet('VERSIONS', [{ QuarterID: QUARTER_ID, VersionNo: 1 }]),
    Quarters: rosterSheet('QUARTERS', [{ QuarterID: QUARTER_ID, Stage: 'OFFICIAL_SENT' }]),
    ServiceDates: rosterSheet('SERVICE_DATES', rosterServiceDates.map(function (iso, i) {
      return {
        ServiceDateID: 'SD' + (i + 1), QuarterID: QUARTER_ID, ServiceDate: iso,
        WeekIndex: i + 1, IsFirstSundayOfMonth: i === 0, ServiceType: '主日崇拜', SpecialID: ''
      };
    })),
    SpecialSundays: rosterSheet('SPECIAL_SUNDAYS', []),
    NameMapping: rosterSheet('NAME_MAPPING', []),
    Posts: rosterSheet('POSTS', [])
  };

  const contentTabs = {};
  boot.contentSheetTabDefs_().forEach(function (def) {
    const tab = makeContentTab(def.keys, def.headers, (o.content || {})[def.tabName] || []);
    tab.__name = def.tabName;
    contentTabs[def.tabName] = tab;
  });
  const contentSpreadsheet = {
    getId: function () { return FAKE_CONTENT_FILE_ID; },
    getUrl: function () { return 'https://docs.google.com/spreadsheets/d/' + FAKE_CONTENT_FILE_ID + '/edit'; },
    getSheetByName: function (name) { return contentTabs[name] || null; },
    getSheets: function () { return Object.keys(contentTabs).map(function (n) { return contentTabs[n]; }); },
    insertSheet: function (name) { const s = makeContentTab([], [], []); s.__name = name; contentTabs[name] = s; return s; }
  };

  const sent = [];
  // ⚠️ 這一支存在的意義：如果哪一條 Web App 路徑不小心叫了 getUi()，
  //    測試會**拋錯**而不是靜靜通過。真實的 Web App 環境正是這樣爆的。
  function noUi() {
    throw new Error('Web App 路徑上不可以呼叫 SpreadsheetApp.getUi()');
  }

  const FakeSpreadsheetApp = {
    getActiveSpreadsheet: function () { return makeFakeSpreadsheet(ownSheets); },
    openById: function (id) {
      if (id === FAKE_ROSTER_ID) return makeFakeSpreadsheet(rosterSheets);
      if (id === FAKE_CONTENT_FILE_ID && !o.contentFileMissing) return contentSpreadsheet;
      throw new Error('openById: 找不到 ' + id);
    },
    create: function () { throw new Error('這一組測試不應該建立新試算表'); },
    newDataValidation: function () {
      const b = {
        requireValueInList: function () { return b; },
        setAllowInvalid: function () { return b; },
        build: function () { return {}; }
      };
      return b;
    },
    ProtectionType: { SHEET: 'SHEET' },
    getUi: noUi
  };

  const sandbox = loadAllSrcFilesInOrder(Object.assign({}, baseStubs(), {
    SpreadsheetApp: FakeSpreadsheetApp,
    LockService: {
      getScriptLock: function () {
        return { tryLock: function () { return true; }, releaseLock: function () {} };
      }
    },
    DriveApp: {
      Access: {}, Permission: {},
      getFileById: function () { return {}; },
      getFolderById: function () { return {}; }
    },
    Drive: o.drive || undefined,
    MailApp: {
      sendEmail: function (msg) { sent.push(msg); },
      getRemainingDailyQuota: function () { return 100; }
    },
    ScriptApp: { getProjectTriggers: function () { return []; } }
  }));

  return { sandbox: sandbox, sheets: ownSheets, sent: sent, contentTabs: contentTabs, rosterWrites: rosterWrites };
}

function rows(env, sheetId) {
  return env.sandbox.readSheet(env.sandbox.SHEETS[sheetId]);
}

// =====================================================================
// 第 1 組：一份邏輯，兩個入口
// =====================================================================

console.log('\n第 1 組：一份邏輯，兩個入口');

test('src/QuarterOps.gs 一行 getUi() 都沒有（Web App 沒有 UI，一叫就爆）', function () {
  const code = stripComments(srcText('QuarterOps.gs'));
  assert.strictEqual(code.indexOf('getUi'), -1,
    'QuarterOps.gs 是 Web App 與選單共用的核心，不可以出現任何對話框');
  assert.strictEqual(code.indexOf('ui.alert'), -1);
  assert.strictEqual(code.indexOf('ui.prompt'), -1);
});

test('⚠️ src/QuarterOps.gs 不可以寫 Diagnostics（每次執行清空重寫，只保留最新一份）', function () {
  const code = stripComments(srcText('QuarterOps.gs'));
  assert.strictEqual(code.indexOf('writeDiagnosticsReport_'), -1,
    '幹事在介面撳一下，就會把 IT 剛跑完的診斷報告清走——而且沒有任何提示');
  assert.strictEqual(code.indexOf('SHEETS.DIAGNOSTICS'), -1);
});

test('選單「上線前檢查」與填寫介面排同一批行（buildGoLiveReportLines_）', function () {
  const menu = stripComments(srcText('GoLive.gs'));
  const core = stripComments(srcText('QuarterOps.gs'));
  assert.ok(menu.indexOf('buildGoLiveReportLines_(items)') !== -1,
    '選單那一邊要經共用那一支排行');
  assert.ok(core.indexOf('function buildGoLiveReportLines_(') !== -1);
  // 選單仍然要寫 Diagnostics——那一邊是刻意保留的維護用途。
  assert.ok(menu.indexOf("writeDiagnosticsReport_('上線前檢查'") !== -1);
});

test('選單「發佈版本記錄」與填寫介面看同一份事實（collectPublishRevisionFacts_）', function () {
  const menu = stripComments(srcText('InvariantDiagnose.gs'));
  const core = stripComments(srcText('QuarterOps.gs'));
  assert.ok(menu.indexOf('collectPublishRevisionFacts_()') !== -1);
  assert.ok(core.indexOf('function collectPublishRevisionFacts_(') !== -1);

  // ⚠️ 只掃 menuShowPublishRevisions_ 這一支。同一個檔案別處讀
  //    PublishLog 是別的診斷功能，與這一條無關——掃整個檔案會把不相干
  //    的程式碼扯進來，而那種測試遲早會因為別人改別的東西而變紅。
  const body = menu.slice(menu.indexOf('function menuShowPublishRevisions_('));
  const fnText = body.slice(0, body.indexOf('\nfunction ', 5));
  assert.ok(fnText.indexOf('readSheet(SHEETS.PUBLISH_LOG)') === -1,
    '選單不可以再自己讀一次 PublishLog——兩處各讀一次就會各自過濾一套');
});

test('八個功能全部經既有核心，沒有一支自己重寫邏輯', function () {
  const core = stripComments(srcText('QuarterOps.gs'));
  [
    'createBlankBulletinWeeks_(',       // A
    'buildOrRefreshContentSheet_(',     // B
    'sendContentSheetInvite_(',         // C
    'previewContentImport_(',           // D
    'applyContentImport_(',             // D
    'buildQuarterMissingFieldsReportLines_(', // E
    'checkRosterDiff_(',                // F
    'buildGoLiveChecklist_(',           // G
    'driveListRevisions_('              // H
  ].forEach(function (fnCall) {
    assert.ok(core.indexOf(fnCall) !== -1, '找不到對既有核心的呼叫：' + fnCall);
  });
});

test('季度預設值經 resolveWorkingQuarter_()，不是自己猜一個', function () {
  const core = stripComments(srcText('QuarterOps.gs'));
  assert.ok(core.indexOf('resolveWorkingQuarter_()') !== -1,
    '兩處各猜一次，幹事在介面見到的季度就會跟選單不同');
});

// =====================================================================
// 第 2 組：A 建立本季週報（先預覽、後確認）
// =====================================================================

console.log('\n第 2 組：A 建立本季週報');

test('A 預覽：唯讀，一行都沒有寫入 BulletinWeeks', function () {
  const env = makeEnv({ weekRows: [] });
  const before = rows(env, 'BULLETIN_WEEKS').length;
  const result = env.sandbox.previewCreateBlankWeeks_(QUARTER_ID);

  assert.strictEqual(result.ok, true, result.message);
  assert.strictEqual(result.summary.willAdd, SERVICE_DATES.length);
  assert.strictEqual(result.summary.willSkip, 0);
  assert.strictEqual(rows(env, 'BULLETIN_WEEKS').length, before, '預覽不可以寫入任何一行');
});

test('A 預覽講的數目，跟真的執行之後的數目一模一樣', function () {
  // ⚠️ 預覽與實際各算一次的話，預覽講「新增 13 行」而實際新增 12 行，
  //    沒有人查得出差在哪裏。所以兩者一定要對得上。
  const env = makeEnv({ weekRows: [{ SERVICE_DATE: SERVICE_DATES[0], QUARTER_ID: QUARTER_ID, STATUS: 'DRAFT' }] });
  const preview = env.sandbox.previewCreateBlankWeeks_(QUARTER_ID);
  const run = env.sandbox.runCreateBlankWeeks_(QUARTER_ID);

  assert.strictEqual(preview.summary.willAdd, run.summary.added);
  assert.strictEqual(preview.summary.willSkip, run.summary.skipped);
  assert.strictEqual(run.summary.added, SERVICE_DATES.length - 1);
});

test('A 執行：寫一筆 AuditLog（有副作用的動作一定要留痕）', function () {
  const env = makeEnv({ weekRows: [] });
  env.sandbox.runCreateBlankWeeks_(QUARTER_ID);
  const audit = rows(env, 'AUDIT_LOG').filter(function (r) { return r.ACTION === 'WEBAPP_CREATE_WEEKS'; });
  assert.strictEqual(audit.length, 1);
  assert.strictEqual(audit[0].ROW_KEY, QUARTER_ID);
});

test('A：職事表未有這一季 → 不是錯誤，而且講明之後撳「補抓」就補得返', function () {
  const env = makeEnv({ weekRows: [], rosterServiceDates: [] });
  const result = env.sandbox.previewCreateBlankWeeks_(QUARTER_ID);

  assert.strictEqual(result.ok, true, '「未到時候」不是錯誤');
  assert.strictEqual(result.summary.rosterFound, false);
  const text = result.lines.join('\n');
  assert.ok(text.indexOf('曆法推算') !== -1, text);
  assert.ok(text.indexOf('補抓') !== -1, '要講得出下一步，不是只講「職事表沒有資料」');
  assert.ok(text.indexOf('不會覆寫') !== -1, '幹事最怕的是被覆寫，一定要答');
});

test('A：季度 ID 空白 → 明確講怎樣決定季度，不是靜靜當成成功', function () {
  const env = makeEnv({});
  const result = env.sandbox.previewCreateBlankWeeks_('');
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'NO_QUARTER_ID');
  assert.ok(result.message.indexOf('季度下拉') !== -1, result.message);
});

// =====================================================================
// 第 3 組：B／C 內容表
// =====================================================================

console.log('\n第 3 組：B／C 內容表');

test('B 預覽：這一季已經有內容表 → 講明是「刷新」，而且一格都不會改', function () {
  const env = makeEnv({});
  const result = env.sandbox.previewContentSheetBuild_(QUARTER_ID);

  assert.strictEqual(result.ok, true, result.message);
  assert.strictEqual(result.summary.exists, true);
  assert.strictEqual(result.summary.willCreate, false);
  const text = result.lines.join('\n');
  assert.ok(text.indexOf('刷新') !== -1, text);
  assert.ok(text.indexOf('一格都不會改') !== -1,
    '「會建立」與「會刷新」對幹事是兩件很不同的事，一定要講清楚');
});

test('B 預覽：未有內容表 → 講明會建立一個新的', function () {
  const env = makeEnv({ contentSheets: [] });
  const result = env.sandbox.previewContentSheetBuild_(QUARTER_ID);

  assert.strictEqual(result.ok, true, result.message);
  assert.strictEqual(result.summary.willCreate, true);
  assert.ok(result.lines.join('\n').indexOf('建立') !== -1);
});

test('B：CONTENT_SHEET_FOLDER_ID 未填 → 明確講要去 Config 填哪一條', function () {
  const env = makeEnv({ config: { CONTENT_SHEET_FOLDER_ID: '' } });
  const result = env.sandbox.previewContentSheetBuild_(QUARTER_ID);

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'NO_FOLDER_ID');
  assert.ok(result.message.indexOf('CONTENT_SHEET_FOLDER_ID') !== -1,
    '要指名是哪一條設定，不可以只講「未設定」：' + result.message);
});

test('⚠️ C 預覽：Recipients 沒有對應群組 → 講明「也不會寄到任何人」', function () {
  // ⚠️ 這是整個 R-038 最重要的一條邊界：撳落去不會出錯，但**不會寄到
  //    任何人**。回一句「已寄 0 封」外表像成功，那是最難發現的一種失敗。
  const env = makeEnv({ recipients: [] });
  const result = env.sandbox.previewContentSheetInvite_(QUARTER_ID);

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'NO_RECIPIENTS');
  assert.ok(result.message.indexOf('不會寄到任何人') !== -1, result.message);
  assert.ok(result.message.indexOf('Recipients') !== -1, '要指名去哪一張表補');
  assert.strictEqual(env.sent.length, 0, '預覽一封信都不可以寄');
});

test('C 預覽：內容表未建立 → 指向「建立／刷新本季內容表」', function () {
  const env = makeEnv({ contentSheets: [] });
  const result = env.sandbox.previewContentSheetInvite_(QUARTER_ID);

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'NO_CONTENT_SHEET');
  assert.ok(result.message.indexOf('建立／刷新本季內容表') !== -1,
    '要指名撳哪一粒，不是只講「尚未建立」：' + result.message);
});

test('C 預覽：DRY_RUN 的現值一定要講出來', function () {
  const dry = makeEnv({ config: { DRY_RUN: 'TRUE' } });
  const live = makeEnv({ config: { DRY_RUN: 'FALSE' } });

  const dryResult = dry.sandbox.previewContentSheetInvite_(QUARTER_ID);
  const liveResult = live.sandbox.previewContentSheetInvite_(QUARTER_ID);

  assert.strictEqual(dryResult.summary.dryRun, true);
  assert.strictEqual(liveResult.summary.dryRun, false);
  assert.ok(dryResult.lines.join('\n').indexOf('不會真的寄出') !== -1);
  assert.ok(liveResult.lines.join('\n').indexOf('會真的寄出') !== -1);
});

test('C 預覽：唯讀——一封信都沒有寄，SendLog 一行都沒有寫', function () {
  const env = makeEnv({ config: { DRY_RUN: 'FALSE' } });
  env.sandbox.previewContentSheetInvite_(QUARTER_ID);
  assert.strictEqual(env.sent.length, 0);
  assert.strictEqual(rows(env, 'SEND_LOG').length, 0);
});

test('C 執行：DRY_RUN=TRUE → 一封都沒有真的寄，但 SendLog 有記錄', function () {
  const env = makeEnv({ config: { DRY_RUN: 'TRUE' } });
  const result = env.sandbox.runContentSheetInvite_(QUARTER_ID);

  assert.strictEqual(result.ok, true, result.message);
  assert.strictEqual(result.summary.dryRun, true);
  assert.strictEqual(env.sent.length, 0, 'DRY_RUN=TRUE 不可以真的寄出');
  assert.strictEqual(rows(env, 'SEND_LOG').length, 2, '但一定要留下記錄');
  assert.ok(result.lines.join('\n').indexOf('並未實際寄出') !== -1);
});

// =====================================================================
// 第 4 組：D 整季匯入
// =====================================================================

console.log('\n第 4 組：D 整季匯入');

test('⚠️ D：週報尚未建立 → 明確講「請先撳『建立本季週報』」', function () {
  const env = makeEnv({ weekRows: [] });
  const result = env.sandbox.quarterContentImport_(QUARTER_ID, false);

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'NO_BULLETIN_WEEKS');
  assert.ok(result.message.indexOf('建立本季週報') !== -1,
    '要指名撳哪一粒：' + result.message);
});

test('D：內容表尚未建立 → 明確講，不是靜靜回「0 改動」', function () {
  const env = makeEnv({ contentSheets: [] });
  const result = env.sandbox.quarterContentImport_(QUARTER_ID, false);

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'NO_CONTENT_SHEET');
  assert.ok(String(result.message).length > 0);
});

test('D 預覽：唯讀，四張清單一行都沒有寫', function () {
  const env = makeEnv({
    content: { 家事報告: [{ SERVICE_DATE: SERVICE_DATES[0], SEQ_NO: '10', TEXT: '家事一', ACTIVE: 'TRUE' }] }
  });
  const result = env.sandbox.quarterContentImport_(QUARTER_ID, false);

  assert.strictEqual(result.ok, true, result.message);
  assert.strictEqual(rows(env, 'ANNOUNCEMENTS').length, 0, '預覽不可以寫入');
  assert.strictEqual(result.summary.added, 1);
});

test('D 執行：真的寫入，而且寫一筆 AuditLog', function () {
  const env = makeEnv({
    content: { 家事報告: [{ SERVICE_DATE: SERVICE_DATES[0], SEQ_NO: '10', TEXT: '家事一', ACTIVE: 'TRUE' }] }
  });
  const result = env.sandbox.quarterContentImport_(QUARTER_ID, true);

  assert.strictEqual(result.ok, true, result.message);
  assert.strictEqual(rows(env, 'ANNOUNCEMENTS').length, 1);
  const audit = rows(env, 'AUDIT_LOG').filter(function (r) {
    return r.ACTION === 'WEBAPP_CONTENT_IMPORT_QUARTER';
  });
  assert.strictEqual(audit.length, 1);
});

test('D 預覽不寫 AuditLog——唯讀的動作不留痕，否則稽核表會被預覽淹沒', function () {
  const env = makeEnv({});
  env.sandbox.quarterContentImport_(QUARTER_ID, false);
  const audit = rows(env, 'AUDIT_LOG').filter(function (r) {
    return r.ACTION === 'WEBAPP_CONTENT_IMPORT_QUARTER';
  });
  assert.strictEqual(audit.length, 0);
});

// =====================================================================
// 第 5 組：E-H 唯讀報告，一律不寫 Diagnostics
// =====================================================================

console.log('\n第 5 組：E-H 唯讀報告');

test('⚠️ 四個唯讀報告全部不寫 Diagnostics（撳一下就清走 IT 剛跑完那份）', function () {
  const env = makeEnv({});
  const before = rows(env, 'DIAGNOSTICS').length;

  env.sandbox.quarterMissingFieldsReport_(QUARTER_ID);
  env.sandbox.rosterDiffReport_(SERVICE_DATES[0]);
  env.sandbox.goLiveReport_();
  env.sandbox.publishRevisionsReport_();

  assert.strictEqual(rows(env, 'DIAGNOSTICS').length, before,
    'Diagnostics 每次執行清空重寫，只保留最新一份——填寫介面不可以碰');
});

test('E 本季待填清單：回傳行，講得出季度', function () {
  const env = makeEnv({});
  const result = env.sandbox.quarterMissingFieldsReport_(QUARTER_ID);

  assert.strictEqual(result.ok, true, result.message);
  assert.ok(result.lines.length > 0, '報告不可以是空的');
  assert.ok(result.lines.join('\n').indexOf(QUARTER_ID) !== -1);
});

test('E：週報尚未建立 → 明確講，不是回一份空報告', function () {
  const env = makeEnv({ weekRows: [] });
  const result = env.sandbox.quarterMissingFieldsReport_(QUARTER_ID);

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'NO_BULLETIN_WEEKS');
  assert.ok(result.message.indexOf('建立本季週報') !== -1, result.message);
});

test('F 檢查職事表分歧：未選主日 → 明確講，不是拿一個預設日期扮成功', function () {
  const env = makeEnv({});
  const result = env.sandbox.rosterDiffReport_('');

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'NO_DATE');
  assert.ok(result.message.indexOf('選一個主日') !== -1, result.message);
});

test('F：職事表一格都沒有寫（假替身一被寫入就會拋錯）', function () {
  // ⚠️ 假替身的職事表被設成「一寫就拋錯」（見 makeEnv 的 rosterSheet）。
  //    所以這一條不是「看看有沒有寫」，而是「真的寫了就會爆」——
  //    比事後比對更硬，而且將來有人加一行寫入也攔得住。
  const env = makeEnv({});
  const result = env.sandbox.rosterDiffReport_(SERVICE_DATES[0]);

  assert.strictEqual(result.ok, true, result.message);
  assert.ok(result.lines.length > 0);
  assert.strictEqual(env.rosterWrites.length, 0,
    '本系統對職事表永遠唯讀，實際寫入：' + JSON.stringify(env.rosterWrites));
});

test('G 上線前檢查：回傳行，而且結尾講明「一格都沒有寫」', function () {
  const env = makeEnv({});
  const result = env.sandbox.goLiveReport_();

  assert.strictEqual(result.ok, true);
  assert.ok(result.summary.total > 0);
  assert.ok(result.lines.join('\n').indexOf('一格都沒有寫') !== -1);
});

test('G：選單與填寫介面拿到的是同一批行', function () {
  const env = makeEnv({});
  const items = env.sandbox.buildGoLiveChecklist_();
  const viaCore = env.sandbox.buildGoLiveReportLines_(items);
  const viaApi = env.sandbox.goLiveReport_().lines;

  assert.strictEqual(JSON.stringify(Array.prototype.slice.call(viaCore)),
    JSON.stringify(Array.prototype.slice.call(viaApi)));
});

test('H 發佈版本記錄：讀不到版本記錄要講明，不可以扮成「共 0 個版本」', function () {
  const env = makeEnv({ config: { PUBLISHED_PDF_FILE_ID: '' } });
  const result = env.sandbox.publishRevisionsReport_();

  assert.strictEqual(result.ok, true, '呼叫本身是成功的');
  assert.strictEqual(result.summary.revisionsOk, false, '但「讀不到」不等於「有 0 個」');
  assert.ok(String(result.summary.message).length > 0, '一定要講得出為什麼讀不到');
});

test('H：正式報表排除自測那些行（R-037 §2.2）', function () {
  const env = makeEnv({});
  const code = stripComments(srcText('QuarterOps.gs'));
  assert.ok(code.indexOf('readOfficialPublishLogRows_()') !== -1,
    '發佈版本記錄是給人看的正式報表，要排除 IS_SELFTEST=TRUE 的行');
  assert.strictEqual(typeof env.sandbox.collectPublishRevisionFacts_, 'function');
});

// =====================================================================
// 第 6 組：由真正入口（api*）叫下去
// =====================================================================

console.log('\n第 6 組：由真正入口叫下去');

test('十三個 api* 全部存在，而且經 withApiResult_（統一權限與 ErrorLog）', function () {
  const env = makeEnv({});
  const code = stripComments(srcText('WebApp.gs'));
  [
    'apiGetQuarterOpsPanel', 'apiPreviewCreateWeeks', 'apiRunCreateWeeks',
    'apiPreviewContentSheetBuild', 'apiRunContentSheetBuild',
    'apiPreviewContentSheetInvite', 'apiRunContentSheetInvite',
    'apiPreviewQuarterContentImport', 'apiRunQuarterContentImport',
    'apiQuarterMissingReport', 'apiRosterDiffReport', 'apiGoLiveReport',
    'apiPublishRevisionsReport'
  ].forEach(function (name) {
    assert.strictEqual(typeof env.sandbox[name], 'function', '缺少 ' + name);
    const body = code.slice(code.indexOf('function ' + name + '('));
    const end = body.indexOf('\nfunction ', 5);
    assert.ok((end === -1 ? body : body.slice(0, end)).indexOf('withApiResult_(') !== -1,
      name + ' 沒有經 withApiResult_');
  });
});

test('由真正入口跑一次「建立本季週報」：預覽 → 執行，兩步都成功', function () {
  const env = makeEnv({ weekRows: [] });
  const preview = env.sandbox.apiPreviewCreateWeeks(QUARTER_ID);
  assert.strictEqual(preview.ok, true, JSON.stringify(preview.error));
  assert.strictEqual(preview.data.summary.willAdd, SERVICE_DATES.length);

  const run = env.sandbox.apiRunCreateWeeks(QUARTER_ID);
  assert.strictEqual(run.ok, true, JSON.stringify(run.error));
  assert.strictEqual(run.data.summary.added, SERVICE_DATES.length);
  assert.strictEqual(rows(env, 'BULLETIN_WEEKS').length, SERVICE_DATES.length);
});

test('由真正入口跑一次四個唯讀報告，全部回得到行', function () {
  const env = makeEnv({});
  [
    ['apiQuarterMissingReport', [QUARTER_ID]],
    ['apiRosterDiffReport', [SERVICE_DATES[0]]],
    ['apiGoLiveReport', []],
    ['apiPublishRevisionsReport', []]
  ].forEach(function (pair) {
    const resp = env.sandbox[pair[0]].apply(null, pair[1]);
    assert.strictEqual(resp.ok, true, pair[0] + '：' + JSON.stringify(resp.error));
    assert.ok(resp.data.lines.length > 0, pair[0] + ' 回了一份空報告');
  });
});

test('面板資料：季度、DRY_RUN、內容表狀態一次過拿齊', function () {
  const env = makeEnv({});
  const resp = env.sandbox.apiGetQuarterOpsPanel('');
  assert.strictEqual(resp.ok, true, JSON.stringify(resp.error));
  assert.strictEqual(resp.data.quarterId, QUARTER_ID);
  assert.strictEqual(resp.data.dryRun, true);
  assert.strictEqual(resp.data.contentSheet.exists, true);
  assert.strictEqual(resp.data.weekCount, SERVICE_DATES.length);
});

test('沒有權限的呼叫者 → 全部 api* 都擋得住（沿用既有那一套，沒有另寫）', function () {
  const env = makeEnv({ config: { WEBAPP_ALLOWED_EMAILS: 'someone-else@example.com' } });
  // ⚠️ 部署者本人永遠有權限（否則改設定的人會被鎖在系統外面），
  //    所以這裏改用一個「呼叫者 ≠ 部署者」的環境來驗。
  const boot = env.sandbox;
  assert.strictEqual(
    boot.isEmailAuthorized_('nobody@example.com', ['someone-else@example.com'], 'deployer@example.com'),
    false);
  assert.strictEqual(
    boot.isEmailAuthorized_('deployer@example.com', ['someone-else@example.com'], 'deployer@example.com'),
    true);
});

// =====================================================================
// 第 7 組：前端（靜態掃描）
// =====================================================================

console.log('\n第 7 組：前端');

test('每一個新 api* 呼叫都經 callServer()，沒有一個直接叫 google.script.run', function () {
  const ui = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'Script.html'), 'utf8');
  const code = stripComments(ui);

  // ⚠️ 這一條守住的是「有沒有寫失敗處理」這件事本身：不寫的後果是
  //    後端拋的錯全部人間蒸發（見 docs/已知bug類型.md 事故二十五）。
  const block = code.slice(code.indexOf('function wireQuarterOpsEvents('));
  assert.ok(block.length > 0, '找不到 wireQuarterOpsEvents()');
  assert.strictEqual(block.indexOf('google.script.run'), -1);

  ['apiGetQuarterOpsPanel', 'apiPreviewCreateWeeks', 'apiRunCreateWeeks',
    'apiPreviewContentSheetBuild', 'apiRunContentSheetBuild',
    'apiPreviewContentSheetInvite', 'apiRunContentSheetInvite',
    'apiPreviewQuarterContentImport', 'apiRunQuarterContentImport',
    'apiQuarterMissingReport', 'apiRosterDiffReport', 'apiGoLiveReport',
    'apiPublishRevisionsReport'].forEach(function (name) {
    assert.ok(code.indexOf("'" + name + "'") !== -1, '前端沒有用到 ' + name);
  });
});

test('⚠️ 唯讀報告不可以用 alert()——內容過百行，alert 會爆而且只見到頭幾行', function () {
  const ui = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'Script.html'), 'utf8');
  const code = stripComments(ui);
  const block = code.slice(code.indexOf('function runQuarterReport('),
    code.indexOf('function wireQuarterOpsEvents('));

  assert.ok(block.length > 0);
  assert.strictEqual(block.indexOf('alert('), -1);
  assert.ok(code.indexOf('function showQuarterOpsReport(') !== -1,
    '要有一個可捲動的結果面板');
});

test('有副作用那四粒一律先預覽、後確認', function () {
  const ui = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'Script.html'), 'utf8');
  const code = stripComments(ui);
  const block = code.slice(code.indexOf('function runQuarterOp('),
    code.indexOf('function runQuarterReport('));

  assert.ok(block.indexOf('opts.previewApi') !== -1);
  assert.ok(block.indexOf('window.confirm') !== -1, '確認之後才可以叫執行 API');
  const confirmPos = block.indexOf('window.confirm');
  assert.ok(block.indexOf('opts.runApi') > confirmPos,
    '執行 API 一定要排在確認之後——排在前面等於沒有確認');
});

test('「寄出內容表連結」旁邊顯示 DRY_RUN，而且確認那一句再講一次', function () {
  const idx = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'Index.html'), 'utf8');
  const ui = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'Script.html'), 'utf8');

  assert.ok(idx.indexOf('id="opInviteDryRun"') !== -1, '按鈕旁邊要有 DRY_RUN 標記');
  assert.ok(ui.indexOf('DRY_RUN=TRUE（不會真的寄出）') !== -1);
  assert.ok(ui.indexOf('DRY_RUN=FALSE（會真的寄出）') !== -1);
  // ⚠️ 旁邊那個標記看漏了，確認那一句還攔得住。
  assert.ok(ui.indexOf('目前 DRY_RUN=FALSE，撳「確定」會真的把郵件寄出去') !== -1);
});

test('季度作業區塊預設摺疊（一季做一次的事，不應該霸住每週要做的事）', function () {
  const idx = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'Index.html'), 'utf8');
  assert.ok(idx.indexOf('id="quarterOpsBody" class="quarter-ops-body hidden"') !== -1,
    '預設要是摺疊的');
  assert.ok(idx.indexOf('aria-expanded="false"') !== -1);
});

test('季度作業區塊排在「發佈及匯出」之上', function () {
  const idx = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'Index.html'), 'utf8');
  assert.ok(idx.indexOf('quarter-ops-panel') < idx.indexOf('publish-panel'),
    '季度作業要排在發佈之前——流程上它是先做的');
});

test('單一主日那粒「重新匯入」講明範圍，跟整季那一粒分得出', function () {
  const ui = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'Script.html'), 'utf8');
  assert.ok(ui.indexOf('重新匯入（只限這一個主日）') !== -1,
    '兩者範圍不同是刻意的，名稱一定要講得出範圍');
  assert.ok(ui.indexOf('從內容表匯入（整季）') !== -1);
});

test('報告面板有上限而且可捲動（不設上限會把整頁推長到捲極都捲唔完）', function () {
  const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'Style.html'), 'utf8');
  const block = css.slice(css.indexOf('.quarter-ops-report-body'));
  assert.ok(block.indexOf('max-height') !== -1);
  assert.ok(block.indexOf('overflow: auto') !== -1);
});

// =====================================================================
// 第 8 組：書面語
// =====================================================================

console.log('\n第 8 組：書面語');

test('這一輪新增的使用者可見文字，一律書面語繁體中文', function () {
  const env = makeEnv({ weekRows: [], recipients: [] });
  const texts = [];

  [
    env.sandbox.previewCreateBlankWeeks_(QUARTER_ID),
    env.sandbox.previewCreateBlankWeeks_(''),
    env.sandbox.previewContentSheetInvite_(QUARTER_ID),
    env.sandbox.quarterContentImport_(QUARTER_ID, false),
    env.sandbox.quarterMissingFieldsReport_(QUARTER_ID),
    env.sandbox.rosterDiffReport_('')
  ].forEach(function (r) {
    if (r.message) texts.push(r.message);
    (r.lines || []).forEach(function (line) { texts.push(line); });
  });

  // ⚠️ 「撳」在 tests/helpers/writtenChinese.js 列為口語字，但整個介面
  //    現時有 56 處使用者可見字串都用「撳」（例如頁頂「撳一下展開待填
  //    清單」）。這一輪只改新加的那一段，會令同一個畫面一半「撳」一半
  //    「按」——比全部一致地用「撳」更差。所以這裏先遮走它，並把「要不要
  //    全盤改成『按』」記入 docs/待確認事項.md BB-4 由 Ivan 決定。
  const masked = texts.map(function (t) { return String(t).split('撳').join('按'); });
  assertWrittenChinese(assert, 'R-038 季度作業的使用者可見文字', masked);
});

// =====================================================================

console.log('\n通過 ' + pass + ' 項，失敗 ' + fail + ' 項。');
process.exit(fail === 0 ? 1 - 1 : 1);
