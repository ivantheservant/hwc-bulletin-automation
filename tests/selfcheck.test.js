#!/usr/bin/env node
/**
 * tests/selfcheck.test.js
 *
 * prompt9 第 4 部分的回歸測試：「完成度自我檢測」（`runSelfCheck_()`）。
 *
 * 17. 各種缺失情況下 🔴／🟡 的判定
 * 18. 全部齊備 → 0 個 🔴
 *
 * 執行方式：node tests/selfcheck.test.js
 * 離開碼：0＝全部通過　1＝有測試失敗
 */

'use strict';

const assert = require('assert');
const { makeFillEnv, QUARTER_ID } = require('./helpers/fillEnv');
const { makeFakeDriveApp, makeFakeUtilities, buildFakeDocx } = require('./helpers/fakeDrive');
const { loadAllSrcFilesInOrder } = require('./helpers/loadGas');
const { makeFakeSheet, makeFakeSpreadsheet } = require('./helpers/fakeSpreadsheet');
const fx = require('./fixtures/docxXml');

const FAKE_TEMPLATE_NORMAL = 'FAKE_TEMPLATE_NORMAL';
const FAKE_TEMPLATE_BAPTISM = 'FAKE_TEMPLATE_BAPTISM';
const FAKE_TEMPLATE_ANNIVERSARY = 'FAKE_TEMPLATE_ANNIVERSARY';
const FAKE_FOLDER_ID = 'FAKE_OUTPUT_FOLDER';

/** 一個沒有任何自訂佔位符的乾淨範本——保證「範本用到但系統不提供」是 0。 */
function blankTemplateXml() {
  return fx.documentXml(fx.para(fx.run('固定內容，沒有任何佔位符')));
}

function makeEnv(options) {
  const o = options || {};

  const files = {};
  if (o.templates !== false) {
    files[FAKE_TEMPLATE_NORMAL] = buildFakeDocx(blankTemplateXml());
    if (o.baptismConfigured !== false) files[FAKE_TEMPLATE_BAPTISM] = buildFakeDocx(blankTemplateXml());
    if (o.anniversaryConfigured !== false) files[FAKE_TEMPLATE_ANNIVERSARY] = buildFakeDocx(blankTemplateXml());
  }

  const drive = makeFakeDriveApp({
    files: files,
    folders: o.folderExists === false ? {} : { [FAKE_FOLDER_ID]: {} },
    rootAccessError: o.rootAccessError
  });

  const config = Object.assign({
    TEMPLATE_FILE_ID_NORMAL: (o.templates === false || o.normalConfigured === false) ? '' : FAKE_TEMPLATE_NORMAL,
    TEMPLATE_FILE_ID_COMBINED_BAPTISM: (o.templates === false || o.baptismConfigured === false) ? '' : FAKE_TEMPLATE_BAPTISM,
    TEMPLATE_FILE_ID_ANNIVERSARY: (o.templates === false || o.anniversaryConfigured === false) ? '' : FAKE_TEMPLATE_ANNIVERSARY,
    BULLETIN_OUTPUT_FOLDER_ID: o.folderConfigured === false ? '' : FAKE_FOLDER_ID,
    WEBAPP_URL: o.webAppConfigured === false ? '' : 'https://script.google.com/macros/s/FAKE/exec'
  }, o.config || {});

  const env = makeFillEnv(Object.assign({ withGrid: false, config: config }, o.fillEnvOptions || {}, {
    driveApp: drive.DriveApp,
    // prompt-pre-usertest：「Drive 進階服務是否可用」那一項要能測到
    // 「不可用」的情況——不傳 driveAdvanced 給 fillEnv，Drive 就不存在，
    // probeDriveAdvancedService_() 會拋 ReferenceError 並回 ok:false。
    driveAdvanced: o.driveAdvancedUnavailable ? undefined : drive.Drive,
    utilitiesZip: makeFakeUtilities()
  }));

  return Object.assign({ drive: drive }, env);
}

function findItem(summary, labelSubstring) {
  return summary.items.filter(function (i) { return i.label.indexOf(labelSubstring) !== -1; });
}

/**
 * ⚠️ 「master 發佈檔案」是「master 發佈檔案資料夾」的字首，substring 比對
 * 會誤中後者；用**精確相等**才分得開兩個標籤幾乎一樣的項目。
 */
function findExactItem(summary, label) {
  return summary.items.filter(function (i) { return i.label === label; })[0];
}

const MANY_GAS_STUBS = {
  Utilities: { formatDate: function () { return '2027-11-07 09:00'; } },
  Session: {
    getScriptTimeZone: function () { return 'Pacific/Auckland'; },
    getActiveUser: function () { return { getEmail: function () { return 'tester@x.com'; } }; }
  },
  CacheService: {},
  HtmlService: {}
};

const MANY_ROSTER_ID = 'FAKE_ROSTER_ID_FOR_MANY_MISSING_TESTS';
const MANY_QUARTER_ID = 'QMANY';

/** isoDate 加 days 天（純字串運算，避免任何 Date 物件跨 vm realm）。 */
function addDaysIsoStr(isoDate, days) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const dt = new Date(y, m - 1, d + days);
  const yy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const dd = String(dt.getDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

/**
 * 用途：造一個「一整季全部主日都幾乎空白」的完成度自我檢測測試環境——
 *   專門測「明細把報告擠爆」這一類情境，跟 `makeEnv()`（fillEnv 固定
 *   四個主日）分開，因為這裡需要自由控制主日數目才逼得出幾百項待填。
 *   不設定任何 Word 範本（維持 Config 預設空字串），所以不需要
 *   DriveApp／Utilities.zip 這些額外替身。
 * Args:
 *   options {{sundayCount:number=, config:Object=}=} `sundayCount`
 *     預設 30；每個主日固定產生 20 項待填（1 個宣召組合＋4 個單值＋
 *     12 個人數欄＋3 個空清單，算式見 `docs/待確認事項.md` 這一輪的
 *     說明），方便測試用乘法算出精確的預期總數。
 * Returns:
 *   {{sandbox:Object, quarterId:string, sundayCount:number,
 *     missingPerSunday:number}}
 */
function makeManySundaysEnv(options) {
  const o = options || {};
  const sundayCount = o.sundayCount === undefined ? 30 : o.sundayCount;
  const boot = loadAllSrcFilesInOrder(MANY_GAS_STUBS);

  const cfg = {};
  boot.DEFAULTS.forEach(function (d) { cfg[d.key] = d.value; });
  cfg.ROSTER_SPREADSHEET_ID = MANY_ROSTER_ID;
  Object.assign(cfg, o.config || {});

  function ownSheet(sheetId, rows) {
    const def = boot.COLUMNS[sheetId];
    return makeFakeSheet(def.headers, def.keys, rows || []);
  }

  const dates = [];
  let cursor = '2027-01-03'; // 隨便挑一個星期日起點
  for (let i = 0; i < sundayCount; i++) {
    dates.push(cursor);
    cursor = addDaysIsoStr(cursor, 7);
  }

  const weekRows = dates.map(function (iso, i) {
    return { SERVICE_DATE: iso, QUARTER_ID: MANY_QUARTER_ID, WEEK_OF_MONTH: (i % 4) + 1, STATUS: 'DRAFT' };
  });

  const ownSheets = {};
  Object.keys(boot.SHEETS).forEach(function (id) { ownSheets[boot.SHEETS[id]] = ownSheet(id, []); });
  ownSheets.Config = ownSheet('CONFIG', Object.keys(cfg).map(function (k) {
    return { KEY: k, VALUE: cfg[k], NOTE: '', EDITABLE: true };
  }));
  ownSheets.BulletinWeeks = ownSheet('BULLETIN_WEEKS', weekRows);

  function rosterSheet(defKey, rows) {
    const keys = Object.keys(boot.ROSTER_TABLE_DEFS_[defKey].columns);
    return makeFakeSheet(keys, keys, rows || []);
  }

  const rosterSheets = {
    RosterAssignments: rosterSheet('ASSIGNMENTS', []),
    RosterVersions: rosterSheet('VERSIONS', [{ QuarterID: MANY_QUARTER_ID, VersionNo: 1 }]),
    Quarters: rosterSheet('QUARTERS', [{ QuarterID: MANY_QUARTER_ID, Stage: 'OFFICIAL_SENT' }]),
    ServiceDates: rosterSheet('SERVICE_DATES', dates.map(function (iso, i) {
      return {
        ServiceDateID: 'SD' + (i + 1), QuarterID: MANY_QUARTER_ID, ServiceDate: iso,
        WeekIndex: i + 1, IsFirstSundayOfMonth: i === 0, ServiceType: '主日崇拜', SpecialID: ''
      };
    })),
    SpecialSundays: rosterSheet('SPECIAL_SUNDAYS', []),
    NameMapping: rosterSheet('NAME_MAPPING', []),
    Posts: rosterSheet('POSTS', []) // 沒有崗位 → dutyBoxPage1 不會產生待排定項目，方便精確算數
  };

  const FakeSpreadsheetApp = {
    getActiveSpreadsheet: function () { return makeFakeSpreadsheet(ownSheets); },
    openById: function (id) {
      if (id !== MANY_ROSTER_ID) throw new Error('openById: 未預期的 id ' + id);
      return makeFakeSpreadsheet(rosterSheets);
    },
    ProtectionType: { SHEET: 'SHEET' },
    getUi: function () {
      return {
        createMenu: function () {
          const menu = {
            addItem: function () { return menu; },
            addSeparator: function () { return menu; },
            addSubMenu: function () { return menu; },
            addToUi: function () { return menu; }
          };
          return menu;
        },
        alert: function () { return 'OK'; },
        prompt: function () {
          return {
            getSelectedButton: function () { return o.uiPromptButton === undefined ? 'OK' : o.uiPromptButton; },
            getResponseText: function () { return o.uiPromptText === undefined ? '' : o.uiPromptText; }
          };
        },
        showModalDialog: function () {},
        ButtonSet: { OK: 'OK', OK_CANCEL: 'OK_CANCEL', YES_NO: 'YES_NO' },
        Button: { OK: 'OK', CANCEL: 'CANCEL', YES: 'YES', NO: 'NO' }
      };
    }
  };

  const FakeScriptApp = { getProjectTriggers: function () { return []; } };

  const sandbox = loadAllSrcFilesInOrder(Object.assign({}, MANY_GAS_STUBS, {
    SpreadsheetApp: FakeSpreadsheetApp,
    ScriptApp: FakeScriptApp
  }));

  return { sandbox: sandbox, quarterId: MANY_QUARTER_ID, sundayCount: sundayCount, missingPerSunday: 20 };
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
// 17. 各種缺失情況下 🔴／🟡 的判定
// =====================================================================

test('17a. 職事表 ID 未設定 → 該項目是 🔴', function () {
  const env = makeEnv({ config: { ROSTER_SPREADSHEET_ID: '' } });
  const summary = env.sandbox.runSelfCheck_();
  const item = findItem(summary, '職事表試算表 ID')[0];
  assert.strictEqual(item.status, '🔴');
});

test('17b. 平常主日範本未設定 → 🔴；浸禮／堂慶範本未設定 → 🟡（不是核心功能）', function () {
  const env = makeEnv({ normalConfigured: false, baptismConfigured: false });
  const summary = env.sandbox.runSelfCheck_();
  assert.strictEqual(findItem(summary, '平常主日 Word 範本')[0].status, '🔴');
  assert.strictEqual(findItem(summary, '浸禮三堂聯合崇拜 Word 範本')[0].status, '🟡');
});

test('17c. 範本 ID 設定了但檔案讀不到（MIME 不對／檔案不存在）→ 🔴', function () {
  const env = makeEnv({ config: { TEMPLATE_FILE_ID_NORMAL: 'NONEXISTENT_ID' } });
  const summary = env.sandbox.runSelfCheck_();
  const item = findItem(summary, '平常主日 Word 範本')[0];
  assert.strictEqual(item.status, '🔴');
  assert.ok(item.message.indexOf('讀取失敗') !== -1);
});

test('17d. 輸出資料夾未設定 → 🟡；設定了但資料夾不存在 → 🔴', function () {
  const notConfigured = makeEnv({ folderConfigured: false });
  assert.strictEqual(findItem(notConfigured.sandbox.runSelfCheck_(), '週報輸出資料夾')[0].status, '🟡');

  const notExist = makeEnv({ folderExists: false });
  assert.strictEqual(findItem(notExist.sandbox.runSelfCheck_(), '週報輸出資料夾')[0].status, '🔴');
});

test('17e. Recipients 完全沒有有效收件人 → 🟡', function () {
  const env = makeEnv({ fillEnvOptions: { recipients: [] } });
  const summary = env.sandbox.runSelfCheck_();
  assert.strictEqual(findItem(summary, 'Recipients 收件人')[0].status, '🟡');
});

// ⚠️ 這一條在第一輪自測之後**改變了預期**（🟢 → 🟡），理由要寫清楚：
//    只有 ADMIN 一組收件人的話，「發佈與寄出」的收件對象勾選（R-004）
//    表面上做好了，實際上寄出去只會到幹事自己一個人手上——而且**不會有
//    任何錯誤訊息**：寄成功、SendLog 綠色、封數 1。用綠燈報這個狀態，
//    等於幫一件「靜靜地做了一件不是使用者要的事」蓋章。見需求登記 R-029。
test('17e-2. Recipients 只有 ADMIN／WORSHIP，欠 CC／DB／IT → 🟡，而且講得出欠哪幾組', function () {
  const env = makeEnv({});
  const summary = env.sandbox.runSelfCheck_();
  const item = findItem(summary, 'Recipients 收件人')[0];
  assert.strictEqual(item.status, '🟡');
  assert.ok(item.message.indexOf('CC') !== -1, item.message);
  assert.ok(item.message.indexOf('DB') !== -1, item.message);
  assert.ok(item.message.indexOf('IT') !== -1, item.message);
  assert.ok(item.message.indexOf('R-029') !== -1, '要指得出是哪一條需求：' + item.message);
  assert.ok(item.message.indexOf('ADMIN') !== -1, '目前有的組別照樣要列出來');
});

test('17e-3. CC／DB／IT 三組齊備 → 🟢', function () {
  const env = makeEnv({ fillEnvOptions: { recipients: [
      { RECIPIENT_ID: 'R1', NAME: '甲', EMAIL: 'cc@x.com', GROUP_NAME: 'CC', ACTIVE: true, EFFECTIVE_FROM: '', EFFECTIVE_TO: '', NOTES: '' },
      { RECIPIENT_ID: 'R2', NAME: '乙', EMAIL: 'db@x.com', GROUP_NAME: 'DB', ACTIVE: true, EFFECTIVE_FROM: '', EFFECTIVE_TO: '', NOTES: '' },
      { RECIPIENT_ID: 'R3', NAME: '丙', EMAIL: 'it@x.com', GROUP_NAME: 'IT', ACTIVE: true, EFFECTIVE_FROM: '', EFFECTIVE_TO: '', NOTES: '' }
  ] } });
  const summary = env.sandbox.runSelfCheck_();
  assert.strictEqual(findItem(summary, 'Recipients 收件人')[0].status, '🟢');
});

// =====================================================================
// 17g. 未完成的需求（第一輪自測之後新增）
// =====================================================================

test('17g-1. 自我檢測報告列出仍未完成的需求編號與標題', function () {
  const env = makeEnv({});
  const summary = env.sandbox.runSelfCheck_();
  const item = findItem(summary, '未完成的需求')[0];
  assert.ok(item, '報告要有「未完成的需求」這一項');
  const text = (item.detail || []).join('\n');
  ['R-016', 'R-017', 'R-018', 'R-020', 'R-027', 'R-028', 'R-029'].forEach(function (reqId) {
    assert.ok(text.indexOf(reqId) !== -1, reqId + ' 沒有列出：' + text);
  });
  assert.ok(text.indexOf('Recipients') !== -1, '要列得出標題，不只是編號：' + text);
});

// ⚠️ 有未完成的需求是**正常狀態**，不是錯誤——但它也絕對不是「全部搞掂」。
//    用綠色會令人以為做完了。
test('17g-2. 有未完成需求時是 🟡，不是 🟢 也不是 🔴', function () {
  const env = makeEnv({});
  const summary = env.sandbox.runSelfCheck_();
  assert.strictEqual(findItem(summary, '未完成的需求')[0].status, '🟡');
});

test('17g-3. 每一條未完成需求都有編號、狀態、標題三樣', function () {
  const env = makeEnv({});
  const list = env.sandbox.unfinishedRequirements_();
  assert.ok(list.length > 0);
  list.forEach(function (r) {
    const reqId = r.id;
    assert.ok(/^R-\d{3}$/.test(reqId), '編號格式不對：' + reqId);
    assert.ok(['未開始', '進行中'].indexOf(r.state) !== -1, reqId + ' 的狀態不對：' + r.state);
    assert.ok(r.title && r.title.length > 0, reqId + ' 沒有標題');
  });
});

// ⚠️ 這一條守住「程式碼那一份」與 docs/需求登記.md 分岔。分岔的方向如果
//    是「程式碼漏了一條」，後果是自我檢測報「全部完成」而其實未完成。
test('17g-4. 程式碼裡面那一份與 docs/需求登記.md 對得上', function () {
  const fsMod = require('fs');
  const pathMod = require('path');
  const env = makeEnv({});
  const doc = fsMod.readFileSync(
    pathMod.join(__dirname, '..', 'docs', '需求登記.md'), 'utf8');

  // 由 Markdown 表格抽出「編號 | 需求 | 狀態」三欄。
  const docUnfinished = [];
  doc.split('\n').forEach(function (line) {
    const m = /^\|\s*(R-\d{3})\s*\|(.*)\|\s*([^|]+?)\s*\|\s*$/.exec(line);
    if (!m) return;
    const state = m[3].trim();
    if (state.indexOf('未開始') !== -1 || state.indexOf('進行中') !== -1
        || state.indexOf('部分完成') !== -1) {
      docUnfinished.push(m[1]);
    }
  });

  const codeIds = env.sandbox.unfinishedRequirements_().map(function (r) { return r.id; });
  const missingInCode = docUnfinished.filter(function (id) { return codeIds.indexOf(id) === -1; });
  const extraInCode = codeIds.filter(function (id) { return docUnfinished.indexOf(id) === -1; });

  assert.strictEqual(missingInCode.length, 0,
    '需求登記上未完成、但 unfinishedRequirements_() 漏了：' + missingInCode.join('、'));
  assert.strictEqual(extraInCode.length, 0,
    'unfinishedRequirements_() 有、但需求登記上已經完成：' + extraInCode.join('、'));
});

test('17f. WEBAPP_URL 是空的 → Web App 部署那一項是 🟡', function () {
  const env = makeEnv({ webAppConfigured: false });
  const summary = env.sandbox.runSelfCheck_();
  assert.strictEqual(findItem(summary, 'Web App 部署')[0].status, '🟡');
});

test('17g. 沒有安裝任何觸發器 → 三個觸發器項目都是 🟡', function () {
  const env = makeEnv({});
  const summary = env.sandbox.runSelfCheck_();
  assert.strictEqual(findItem(summary, '觸發器：自動寄送')[0].status, '🟡');
  assert.strictEqual(findItem(summary, '觸發器：填寫表同步')[0].status, '🟡');
  assert.strictEqual(findItem(summary, '觸發器：填寫表對帳')[0].status, '🟡');
  assert.strictEqual(findItem(summary, '下一季提示')[0].status, '🟡');
});

test('17h. 沒有設定任何工作表保護 → 🟡', function () {
  const env = makeEnv({});
  const summary = env.sandbox.runSelfCheck_();
  assert.strictEqual(findItem(summary, '工作表保護')[0].status, '🟡');
});

test('17i. ErrorLog 最近 7 日有錯誤 → 🟡；沒有 → 🟢', function () {
  const withError = makeEnv({});
  withError.sandbox.appendErrorLog_({ source: 'MENU', functionName: 'x', errorCode: 'E', message: '測試錯誤' });
  const summaryWithError = withError.sandbox.runSelfCheck_();
  assert.strictEqual(findItem(summaryWithError, 'ErrorLog 最近 7 日錯誤數')[0].status, '🟡');

  const clean = makeEnv({});
  const summaryClean = clean.sandbox.runSelfCheck_();
  assert.strictEqual(findItem(summaryClean, 'ErrorLog 最近 7 日錯誤數')[0].status, '🟢');
});

test('17j. 從未寄送過（SendLog 是空的）→ 🟡', function () {
  const env = makeEnv({});
  const summary = env.sandbox.runSelfCheck_();
  assert.strictEqual(findItem(summary, 'SendLog 最近一次寄送')[0].status, '🟡');
});

test('17k. 範本用到系統不提供的佔位符 → 該範本的佔位符對帳項目是 🔴', function () {
  const badTemplateXml = fx.documentXml(fx.para(fx.run('{{TYPO_PLACEHOLDER}}')));
  const drive = makeFakeDriveApp({
    files: { [FAKE_TEMPLATE_NORMAL]: buildFakeDocx(badTemplateXml) },
    folders: { [FAKE_FOLDER_ID]: {} }
  });
  const env = makeFillEnv({
    withGrid: false,
    config: { TEMPLATE_FILE_ID_NORMAL: FAKE_TEMPLATE_NORMAL, BULLETIN_OUTPUT_FOLDER_ID: FAKE_FOLDER_ID },
    driveApp: drive.DriveApp,
    driveAdvanced: drive.Drive,
    utilitiesZip: makeFakeUtilities()
  });
  const summary = env.sandbox.runSelfCheck_();
  const item = findItem(summary, '範本佔位符對帳：平常主日')[0];
  assert.strictEqual(item.status, '🔴');
  assert.ok(item.message.indexOf('TYPO_PLACEHOLDER') !== -1);
});

// =====================================================================
// 18. 全部齊備 → 0 個 🔴
// =====================================================================

test('18. 全部齊備（設定齊全、範本乾淨、資料夾存在、觸發器已裝、保護已設）→ 0 個 🔴', function () {
  const env = makeEnv({});

  // 模擬三個觸發器都已經安裝——直接寫進 fillEnv 暴露的 triggers.installed，
  // 不呼叫真正的安裝函式：Trigger.gs 的 installWeeklySendTrigger_() 需要
  // ScriptApp.WeekDay 這個列舉，fillEnv 的假 ScriptApp 沒有實作它（那是
  // 另一個測試檔案的職責），這裡只需要「已安裝」這個事實本身。
  ['weeklyBulletinSendTrigger_', 'onFillGridEdit_', 'fillReconcileTrigger_'].forEach(function (handler) {
    env.triggers.installed.push({ getHandlerFunction: function () { return handler; } });
  });

  // 設定工作表保護。
  env.sandbox.applySheetProtection_();

  const summary = env.sandbox.runSelfCheck_();
  const redItems = summary.items.filter(function (i) { return i.status === '🔴'; });
  assert.strictEqual(redItems.length, 0, '不應該有任何 🔴：' + JSON.stringify(redItems));
});

test('17l. 「檢測季度」項一定存在，且職事表與 BulletinWeeks 都是 fillEnv 預設的 2027T4 時是 🟢', function () {
  const env = makeEnv({});
  const summary = env.sandbox.runSelfCheck_();
  const item = findItem(summary, '檢測季度')[0];
  assert.ok(item, '「檢測季度」這一項應該一定存在');
  assert.strictEqual(item.status, '🟢');
  assert.ok(item.message.indexOf('2027T4') !== -1, item.message);
});

// =====================================================================
// 19. 完成度自我檢測報告的行數上限（prompt-fix-diagnostics-rows.md）
// =====================================================================

test('19a. 造 500 項待填（25 個主日 × 20 項）→ 報告總行數 ≤ SELFCHECK_MAX_ROWS', function () {
  const env = makeManySundaysEnv({ sundayCount: 25 });
  env.sandbox.runSelfCheck_();
  const rows = env.sandbox.readSheet('Diagnostics').filter(function (r) { return r.REPORT_NAME === '完成度自我檢測'; });
  assert.ok(rows.length <= 140, '應該不超過 SELFCHECK_MAX_ROWS 預設值 140，實際：' + rows.length);
});

test('19b. 同上情況下，最後三項紀錄類檢測（ErrorLog／SendLog／AuditLog）仍然存在於報告內', function () {
  const env = makeManySundaysEnv({ sundayCount: 25 });
  env.sandbox.runSelfCheck_();
  const content = env.sandbox.readSheet('Diagnostics')
    .filter(function (r) { return r.REPORT_NAME === '完成度自我檢測'; })
    .map(function (r) { return r.CONTENT; }).join('\n');

  assert.ok(content.indexOf('ErrorLog 最近 7 日錯誤數') !== -1, '應該看得到 ErrorLog 項目，沒有被明細擠掉：\n' + content);
  assert.ok(content.indexOf('SendLog 最近一次寄送') !== -1, '應該看得到 SendLog 項目：\n' + content);
  assert.ok(content.indexOf('AuditLog 行數') !== -1, '應該看得到 AuditLog 項目：\n' + content);
});

test('19c. 明細行數（不含截斷提示行）≤ SELFCHECK_MISSING_DETAIL_ROWS', function () {
  const env = makeManySundaysEnv({ sundayCount: 25 });
  const summary = env.sandbox.runSelfCheck_();
  const item = findItem(summary, '待填欄位總數')[0];
  const summaryLines = item.detail.filter(function (d) { return d.indexOf('尚有') === -1; });
  assert.ok(summaryLines.length <= 20, '應該不超過 SELFCHECK_MISSING_DETAIL_ROWS 預設值 20，實際：' + summaryLines.length);
});

test('19d. 「尚有 N 項未列出」的 N 數值正確（25 個主日，20 個顯示，5 個隱藏 × 20 項＝100）', function () {
  const env = makeManySundaysEnv({ sundayCount: 25 });
  const summary = env.sandbox.runSelfCheck_();
  const item = findItem(summary, '待填欄位總數')[0];
  const last = item.detail[item.detail.length - 1];
  assert.strictEqual(last, '尚有 100 項未列出，請用選單「本季待填清單」查看完整明細。');
});

test('19e. selfCheckMissingSummaryByDate_()／selfCheckCapMissingSummary_()：沒有任何主日待填 → 沒有明細段、沒有截斷提示', function () {
  const env = makeManySundaysEnv({ sundayCount: 1 });
  const summaryResult = env.sandbox.selfCheckMissingSummaryByDate_([]);
  assert.strictEqual(summaryResult.totalMissing, 0);
  assert.strictEqual(summaryResult.perDate.length, 0);

  const capped = env.sandbox.selfCheckCapMissingSummary_([]);
  assert.strictEqual(capped.length, 0);

  const item = env.sandbox.selfCheckItem_(
    '本季（Q）待填欄位總數',
    summaryResult.totalMissing === 0 ? env.sandbox.SELF_CHECK_STATUS_.GREEN : env.sandbox.SELF_CHECK_STATUS_.YELLOW,
    summaryResult.totalMissing + ' 項（共 0 個主日）。',
    capped
  );
  assert.strictEqual(item.status, '🟢');
  assert.strictEqual(item.detail.length, 0);
});

test('19f. selfCheckCapMissingSummary_()：待填 5 項（1 個主日，遠低於上限）→ 全部列出、沒有截斷提示', function () {
  const env = makeManySundaysEnv({ sundayCount: 1 });
  const perDate = [{ isoDate: '2027-01-03', count: 5, line: '2027-01-03　5 項待填（讀經、證道講題、回應詩歌 等）' }];
  const result = env.sandbox.selfCheckCapMissingSummary_(perDate);
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0], perDate[0].line);
  assert.ok(result.every(function (l) { return l.indexOf('尚有') === -1; }), '不應該有截斷提示：' + JSON.stringify(result));
});

test('19g. 每主日彙總行的括號內最多 3 個欄位名（一個全空白的主日有 20 項待填）', function () {
  const env = makeManySundaysEnv({ sundayCount: 1 });
  const summary = env.sandbox.runSelfCheck_();
  const item = findItem(summary, '待填欄位總數')[0];
  const line = item.detail[0];
  assert.ok(line.indexOf('20 項待填') !== -1, line);

  const match = /（(.+)）$/.exec(line);
  assert.ok(match, '應該有括號內容：' + line);
  const names = match[1].replace(/\s*等$/, '').split('、');
  assert.strictEqual(names.length, 3, '括號內最多只能有 3 個欄位名：' + line);
  assert.ok(match[1].indexOf('等') !== -1, '超過 3 個欄位時要加「等」：' + line);
});

test('19h. SELFCHECK_MAX_ROWS 填大過 DIAGNOSTICS_MAX_ROWS → 取較小值並有註明', function () {
  const env = makeManySundaysEnv({
    sundayCount: 1,
    config: { SELFCHECK_MAX_ROWS: '1000', DIAGNOSTICS_MAX_ROWS: '50' }
  });
  env.sandbox.runSelfCheck_();
  const rows = env.sandbox.readSheet('Diagnostics').filter(function (r) { return r.REPORT_NAME === '完成度自我檢測'; });
  const content = rows.map(function (r) { return r.CONTENT; }).join('\n');

  assert.ok(rows.length <= 50, '應該取較小值 50 為上限，實際：' + rows.length);
  assert.ok(content.indexOf('已改用較小值 50') !== -1, '應該在報告內註明已經取了較小值：\n' + content);
});

test('19i. 由真正入口（選單函式 menuShowQuarterMissingFieldsList_）跑「本季待填清單」→ 報告產生、遵守 DIAGNOSTICS_MAX_ROWS', function () {
  const env = makeManySundaysEnv({ sundayCount: 25, uiPromptButton: 'OK', uiPromptText: '' });
  assert.doesNotThrow(function () { env.sandbox.menuShowQuarterMissingFieldsList_(); });

  const rows = env.sandbox.readSheet('Diagnostics').filter(function (r) { return r.REPORT_NAME === '本季待填清單'; });
  assert.ok(rows.length > 0, '應該真的寫入了報告');
  assert.ok(rows.length <= 380, '應該遵守 DIAGNOSTICS_MAX_ROWS 預設值 380，實際：' + rows.length);

  const last = rows[rows.length - 1].CONTENT;
  assert.strictEqual(last, '尚有 123 項未列出。', '500 項待填、budget 378（380 － 2 行標題），顯示 377、隱藏 123：' + last);
  assert.strictEqual(rows.length, 380);
});

test('19j. 燈色判定不受這次改動的行數上限設定影響（同一組資料，不同 SELFCHECK_MAX_ROWS，🟢🟡🔴 數目一致）', function () {
  const envSmallBudget = makeManySundaysEnv({ sundayCount: 25, config: { SELFCHECK_MAX_ROWS: '10' } });
  const envBigBudget = makeManySundaysEnv({ sundayCount: 25, config: { SELFCHECK_MAX_ROWS: '10000' } });

  const summarySmall = envSmallBudget.sandbox.runSelfCheck_();
  const summaryBig = envBigBudget.sandbox.runSelfCheck_();

  assert.strictEqual(summarySmall.greenCount, summaryBig.greenCount);
  assert.strictEqual(summarySmall.yellowCount, summaryBig.yellowCount);
  assert.strictEqual(summarySmall.redCount, summaryBig.redCount);

  // 待填欄位總數那一項本身的燈色（不是只有總數）也不可以被行數上限改變。
  const itemSmall = findItem(summarySmall, '待填欄位總數')[0];
  const itemBig = findItem(summaryBig, '待填欄位總數')[0];
  assert.strictEqual(itemSmall.status, itemBig.status);
  assert.strictEqual(itemSmall.message, itemBig.message, '結論（message）不應該因為行數上限而改變，只有 detail 會被截斷');
});

// =====================================================================
// checkAuthorizationScopes_()：檢查授權範圍
// =====================================================================

test('checkAuthorizationScopes_：全部服務都叫得動 → 5 項全部 ok:true', function () {
  const env = makeEnv({});
  const results = env.sandbox.checkAuthorizationScopes_();
  assert.strictEqual(results.length, 5);
  results.forEach(function (r) {
    assert.strictEqual(r.ok, true, r.item + '：' + r.message);
  });
});

test('checkAuthorizationScopes_：DriveApp 授權不足 → 那一項 ok:false，訊息帶授權指引，其餘服務不受影響', function () {
  const authErr = new Error('You do not have permission to call DriveApp.getFileById.');
  const env = makeEnv({ rootAccessError: authErr });
  const results = env.sandbox.checkAuthorizationScopes_();

  const driveItem = results.filter(function (r) { return r.item.indexOf('DriveApp') !== -1; })[0];
  assert.strictEqual(driveItem.ok, false);
  assert.ok(driveItem.message.indexOf('授權範圍問題') !== -1, driveItem.message);

  const others = results.filter(function (r) { return r.item.indexOf('DriveApp') === -1; });
  others.forEach(function (r) { assert.strictEqual(r.ok, true, r.item + '：' + r.message); });
});

test('buildAuthorizationScopeReportLines_：全部可用時的摘要行；有失敗時列出失敗數與逐項結果', function () {
  const env = makeEnv({});
  const okLines = env.sandbox.buildAuthorizationScopeReportLines_([
    { item: 'A', ok: true, message: '可用。' }
  ]);
  assert.ok(okLines[0].indexOf('全部可用') !== -1, okLines[0]);

  const mixedLines = env.sandbox.buildAuthorizationScopeReportLines_([
    { item: 'A', ok: true, message: '可用。' },
    { item: 'B', ok: false, message: '授權範圍問題，去 Apps Script 編輯器重新授權。' }
  ]);
  assert.ok(mixedLines[0].indexOf('1 項未授權') !== -1, mixedLines[0]);
  assert.ok(mixedLines.some(function (l) { return l.indexOf('✗ 未授權') !== -1 && l.indexOf('B') !== -1; }));
});

test('menuCheckAuthorizationScopes_：把結果寫進 Diagnostics（報告名稱「檢查授權範圍」）', function () {
  const authErr = new Error('Authorization is required to perform that action.');
  const env = makeEnv({ rootAccessError: authErr });
  env.sandbox.menuCheckAuthorizationScopes_();

  const diagnostics = env.sandbox.readSheet('Diagnostics');
  const rows = diagnostics.filter(function (r) { return r.REPORT_NAME === '檢查授權範圍'; });
  assert.ok(rows.length > 0);
  assert.ok(rows.some(function (r) { return r.CONTENT.indexOf('DriveApp') !== -1; }));
});

// =====================================================================
// 20. prompt-pre-usertest：發佈及匯出相關的檢測項目
// =====================================================================

test('20a. 三個資料夾 Config 未填 → 對應項目各自報 🟡 並指明是哪一個設定鍵', function () {
  const env = makeEnv({ config: {
    PUBLISHED_PDF_FOLDER_ID: '', PUBLISHED_ARCHIVE_FOLDER_ID: '', CONTENT_SHEET_FOLDER_ID: ''
  } });
  const summary = env.sandbox.runSelfCheck_();

  [
    ['master 發佈檔案資料夾', 'PUBLISHED_PDF_FOLDER_ID'],
    ['發佈存檔資料夾', 'PUBLISHED_ARCHIVE_FOLDER_ID'],
    ['內容表資料夾', 'CONTENT_SHEET_FOLDER_ID']
  ].forEach(function (pair) {
    const item = findItem(summary, pair[0])[0];
    assert.ok(item, '找不到「' + pair[0] + '」這一項');
    assert.strictEqual(item.status, '🟡');
    assert.ok(item.message.indexOf(pair[1]) !== -1, item.message);
  });
});

test('20b. 三個資料夾 Config 都已填 → 對應項目報 🟢', function () {
  const env = makeEnv({ config: {
    PUBLISHED_PDF_FOLDER_ID: 'FOLDER_A', PUBLISHED_ARCHIVE_FOLDER_ID: 'FOLDER_B', CONTENT_SHEET_FOLDER_ID: 'FOLDER_C'
  } });
  const summary = env.sandbox.runSelfCheck_();

  ['master 發佈檔案資料夾', '發佈存檔資料夾', '內容表資料夾'].forEach(function (label) {
    assert.strictEqual(findItem(summary, label)[0].status, '🟢', label);
  });
});

test('20c. Drive 進階服務不可用 → 報 🟡，訊息說明要啟用，不拋錯', function () {
  const env = makeEnv({ driveAdvancedUnavailable: true });
  const summary = env.sandbox.runSelfCheck_(); // 不拋錯本身就是這一條的重點
  const item = findItem(summary, 'Drive 進階服務')[0];

  assert.ok(item);
  assert.strictEqual(item.status, '🟡');
  assert.ok(item.message.indexOf('啟用') !== -1, item.message);
});

test('20d. Drive 進階服務可用 → 報 🟢', function () {
  const env = makeEnv({});
  const summary = env.sandbox.runSelfCheck_();
  assert.strictEqual(findItem(summary, 'Drive 進階服務')[0].status, '🟢');
});

test('20e. master 發佈檔案：Config 未設定 ID → 🟡，提示去撳選單建立', function () {
  const env = makeEnv({ config: { PUBLISHED_PDF_FILE_ID: '' } });
  const summary = env.sandbox.runSelfCheck_();
  const item = findExactItem(summary, 'master 發佈檔案');
  assert.ok(item, 'label 相同的兩個項目要用精確比對，不要用 findItem() 的字首誤中');
  assert.strictEqual(item.status, '🟡');
  assert.ok(item.message.indexOf('建立 master 發佈檔案') !== -1, item.message);
});

test('20f. master 發佈檔案：已設定 ID 且開得到 → 🟢', function () {
  const env = makeEnv({ config: { PUBLISHED_PDF_FILE_ID: FAKE_TEMPLATE_NORMAL } });
  // 借用已經在假 Drive 裏的一個檔案 ID，模擬「開得到」。
  const summary = env.sandbox.runSelfCheck_();
  assert.strictEqual(findExactItem(summary, 'master 發佈檔案').status, '🟢');
});

test('20g. master 發佈檔案：已設定 ID 但開不到 → 🟡（不是 🔴——不是核心功能）', function () {
  const env = makeEnv({ config: { PUBLISHED_PDF_FILE_ID: 'NOT_A_REAL_FILE' } });
  const summary = env.sandbox.runSelfCheck_();
  assert.strictEqual(findExactItem(summary, 'master 發佈檔案').status, '🟡');
});

test('20h. 本季內容表：尚未建立 → 🟡', function () {
  const env = makeEnv({});
  const summary = env.sandbox.runSelfCheck_();
  const item = findExactItem(summary, '本季（' + QUARTER_ID + '）內容表');
  assert.ok(item, '找不到「本季內容表」這一項；標籤裏帶了季度 ID，跟「內容表資料夾」是兩個不同項目');
  assert.strictEqual(item.status, '🟡');
  assert.ok(item.message.indexOf('尚未建立') !== -1, item.message);
});

test('20i. 本季內容表：已建立且有最後匯入時間 → 🟢，顯示該時間（走 Utilities.formatDate）', function () {
  // ⚠️ makeEnv() 的 utilitiesZip（tests/helpers/fakeDrive.js 的
  // makeFakeUtilities()）把 formatDate 換成一個固定回傳
  // '2027-11-07 09:00' 的替身，不論傳入哪一個 Date——所以這裏斷言的是
  // 「有沒有真的呼叫 formatDate 並把結果放進訊息」，不是斷言某個具體
  // 日期字串本身。
  const env = makeEnv({});
  env.sandbox.writeSheet(env.sandbox.SHEETS.CONTENT_SHEETS, [{
    QUARTER_ID: QUARTER_ID, FILE_ID: 'CS1', FILE_URL: 'https://example.invalid/cs1',
    CREATED_AT: '2027-09-01', LAST_IMPORTED_AT: '2027-10-05', INVITE_SENT_AT: '', ACTIVE: true
  }]);
  const summary = env.sandbox.runSelfCheck_();
  const item = findExactItem(summary, '本季（' + QUARTER_ID + '）內容表');
  assert.strictEqual(item.status, '🟢');
  assert.ok(item.message.indexOf('2027-11-07 09:00') !== -1, item.message);
});

test('20j. 本季內容表：已建立但從未匯入過 → 🟢，講明「尚未匯入過」', function () {
  const env = makeEnv({});
  env.sandbox.writeSheet(env.sandbox.SHEETS.CONTENT_SHEETS, [{
    QUARTER_ID: QUARTER_ID, FILE_ID: 'CS1', FILE_URL: 'https://example.invalid/cs1',
    CREATED_AT: '2027-09-01', LAST_IMPORTED_AT: '', INVITE_SENT_AT: '', ACTIVE: true
  }]);
  const summary = env.sandbox.runSelfCheck_();
  const item = findExactItem(summary, '本季（' + QUARTER_ID + '）內容表');
  assert.ok(item.message.indexOf('尚未匯入過') !== -1, item.message);
});

test('20k. 最近一次發佈：從未發佈過 → 🟡', function () {
  const env = makeEnv({});
  const summary = env.sandbox.runSelfCheck_();
  const item = findItem(summary, '最近一次發佈')[0];
  assert.ok(item);
  assert.strictEqual(item.status, '🟡');
  assert.ok(item.message.indexOf('尚未發佈') !== -1, item.message);
});

test('20l. 最近一次發佈：有記錄 → 🟢，顯示主日與版本號', function () {
  const env = makeEnv({});
  env.sandbox.writeSheet(env.sandbox.SHEETS.PUBLISH_LOG, [{
    SERVICE_DATE: '2027-11-07', VERSION_NO: 2, PUBLISHED_AT: '2027-11-06',
    PUBLISHED_BY: 'tester@x.com', ARCHIVE_FILE_ID: 'A1', SENT: true,
    SENT_GROUPS: 'CC', MISSING_COUNT: 0, FORCED: false, FORCED_REASON: ''
  }]);
  const summary = env.sandbox.runSelfCheck_();
  const item = findItem(summary, '最近一次發佈')[0];
  assert.strictEqual(item.status, '🟢');
  assert.ok(item.message.indexOf('2027-11-07') !== -1, item.message);
  assert.ok(item.message.indexOf('第 2 版') !== -1, item.message);
});

test('20m. 新增的六類檢測項目全部出現在報告內，且總行數不超過 SELFCHECK_MAX_ROWS', function () {
  const env = makeEnv({});
  const summary = env.sandbox.runSelfCheck_();

  ['Drive 進階服務', 'master 發佈檔案資料夾', '發佈存檔資料夾', '內容表資料夾',
    'master 發佈檔案', '內容表', '最近一次發佈'
  ].forEach(function (label) {
    assert.ok(findItem(summary, label).length > 0, '找不到「' + label + '」這一項');
  });

  const maxRows = Number(env.sandbox.getConfig(env.sandbox.CONFIG_KEYS.SELFCHECK_MAX_ROWS, '140'));
  const lines = env.sandbox.buildSelfCheckReportLines_(summary);
  assert.ok(lines.length <= maxRows, '報告行數 ' + lines.length + ' 超過上限 ' + maxRows);
});

test('20n. 新增項目排在既有項目之後（不打亂原有四大類的次序）', function () {
  const env = makeEnv({});
  const summary = env.sandbox.runSelfCheck_();
  const labels = summary.items.map(function (i) { return i.label; });

  const lastOldIndex = labels.indexOf('AuditLog 行數'); // 紀錄類最後一項
  const firstNewIndex = labels.findIndex(function (l) { return l.indexOf('Drive 進階服務') !== -1; });
  assert.ok(lastOldIndex !== -1 && firstNewIndex !== -1);
  assert.ok(lastOldIndex < firstNewIndex, '新項目應該排在既有項目（含紀錄類）之後');
});

// =====================================================================

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
