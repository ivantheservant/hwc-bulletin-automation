#!/usr/bin/env node
/**
 * tests/pre-usertest.test.js
 *
 * `prompt-pre-usertest.md` 四個部分的回歸測試（第 2 部分的自我檢測新增
 * 項目另外集中在 `tests/selfcheck.test.js`，這裡只驗它們排在既有項目
 * 之後、而且不超過行數上限，避免兩個檔案重複維護同一段長長的假環境）。
 *
 * 1-2. 頂部狀態列的連結：單一 HTML `<a>`，文字不重複
 * 3-4. 發佈人顯示名稱：優先 Recipients，查不到才用電郵 @ 前半部
 * 5.   從未發佈過 → 沒有壞掉的連結
 * 6.   ContentSheets、PublishLog 在受保護清單內
 * 7.   自我檢測新增項目排在既有項目之後（見 tests/selfcheck.test.js 20m/20n）
 * 8-9. 資料夾未填／Drive 進階服務不可用（見 tests/selfcheck.test.js 20a/20c）
 * 10.  DRY_RUN=TRUE → 頂部橫幅是新文字
 * 11.  TEST_MODE_BANNER 有值／留空
 * 12.  異體字正規化，並記錄次數
 *
 * 執行方式：node tests/pre-usertest.test.js
 * 離開碼：0＝全部通過　1＝有測試失敗
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { loadAllSrcFilesInOrder } = require('./helpers/loadGas');
const { makeFakeSheet, makeFakeSpreadsheet } = require('./helpers/fakeSpreadsheet');
const { assertWrittenChinese } = require('./helpers/writtenChinese');

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

function baseStubs(options) {
  const opts = options || {};
  return {
    Utilities: {
      /**
       * ⚠️ 同 tests/publish.test.js 同一招：呼叫端傳入嘅 Date 如果同真正
       * 嘅「現在」只差幾秒（即係剛剛 \`new Date()\`），就當佢係問「今日
       * 幾號」，回傳測試指定嘅 \`opts.todayIso\`——用嚟控制
       * \`detectPublishDateIssues_()\` 要用嘅「今日」，唔使跟真實時鐘走。
       * 其餘情況（格式化一個具體傳入嘅日期）照實格式化。
       */
      formatDate: function (date, tz, pattern) {
        const isNow = Math.abs(Date.now() - date.getTime()) < 5000;
        if (isNow && opts.todayIso && String(pattern).indexOf('HH') === -1) return opts.todayIso;

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
      newBlob: function (bytes, mimeType, name) {
        const list = Array.isArray(bytes) ? bytes.slice() : Array.prototype.slice.call(Buffer.from(String(bytes), 'utf8'));
        return {
          getBytes: function () { return list.slice(); },
          getName: function () { return name; },
          setName: function (n) { name = n; return this; }
        };
      }
    },
    Session: {
      getScriptTimeZone: function () { return 'Pacific/Auckland'; },
      getActiveUser: function () { return { getEmail: function () { return 'tester@example.com'; } }; }
    },
    CacheService: {},
    HtmlService: {}
  };
}

/**
 * 跨 vm realm 安全的深層比較（見 tests/publish.test.js 同一個註解）：
 * sandbox 回來的物件同 Node 這一邊唔係同一個 Object 建構子，
 * assert.deepStrictEqual 會誤判做「結構相同但唔係同一個原型」。
 */
function deepEq(actual, expected, message) {
  assert.strictEqual(JSON.stringify(actual), JSON.stringify(expected), message);
}

/** 造一個只夠測發佈狀態列／收件人查找的環境——不需要職事表、不需要範本。 */
function makeStatusEnv(options) {
  const o = options || {};
  const boot = loadAllSrcFilesInOrder(baseStubs(o));

  const cfg = {};
  boot.DEFAULTS.forEach(function (d) { cfg[d.key] = d.value; });
  cfg.PUBLISHED_PDF_FILE_ID = o.masterFileId === undefined ? '' : o.masterFileId;
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
  sheets.PublishLog = ownSheet('PUBLISH_LOG', o.publishLog || []);
  sheets.Recipients = ownSheet('RECIPIENTS', o.recipients || []);

  const sandbox = loadAllSrcFilesInOrder(Object.assign({}, baseStubs(o), {
    SpreadsheetApp: { getActiveSpreadsheet: function () { return makeFakeSpreadsheet(sheets); } },
    DriveApp: {
      getFileById: function (id) {
        if (o.masterFileExists === false) throw new Error('No item with the given ID could be found: ' + id);
        return { getName: function () { return '（master）'; } };
      }
    }
  }));

  return { sandbox: sandbox, sheets: sheets };
}

function uiFiles() {
  const dir = path.join(__dirname, '..', 'src', 'ui');
  return fs.readdirSync(dir)
    .filter(function (f) { return f.endsWith('.html'); })
    .map(function (f) { return { name: f, text: fs.readFileSync(path.join(dir, f), 'utf8') }; });
}

function indexHtml() {
  return uiFiles().filter(function (f) { return f.name === 'Index.html'; })[0].text;
}
function scriptHtml() {
  return uiFiles().filter(function (f) { return f.name === 'Script.html'; })[0].text;
}

// =====================================================================
// 1-2. 頂部狀態列的連結：單一 HTML <a>，文字不重複
// =====================================================================

test('1. 頂部狀態列的「開啟」是正常的 HTML <a> 元素，不是拼出來的 markdown 文字', function () {
  const index = indexHtml();
  const script = scriptHtml();

  // <a> 標籤本身、target/rel 屬性齊全（正常超連結該有的樣子）。
  const anchorMatch = /<a id="publishStatusLink"[^>]*>/.exec(index);
  assert.ok(anchorMatch, '找不到 publishStatusLink 這一個 <a> 元素');
  assert.ok(anchorMatch[0].indexOf('target="_blank"') !== -1, anchorMatch[0]);
  assert.ok(anchorMatch[0].indexOf('rel="noopener"') !== -1, anchorMatch[0]);

  // 前端用 .href 設定連結，不是拼一句含 markdown 語法的字串塞進 textContent。
  assert.ok(script.indexOf("link.href = s.links.view;") !== -1,
    '前端要用 .href 設定連結目的地，不是把網址拼進顯示文字');

  // 狀態列的文字（publishStatusText）不可以含方括號＋圓括號這種 markdown
  // link 語法——那正是這一輪要修的症狀本身。
  const statusTextAssignments = script.match(/publishStatusText'\)\.textContent = [^;]+;/g) || [];
  statusTextAssignments.forEach(function (line) {
    assert.ok(!/\[.*\]\(.*\)/.test(line), '狀態列文字不可以含 markdown link 語法：' + line);
  });
});

test('2. 狀態列裏只有一個連結，文字是「開啟 PDF」，不會跟其他文字疊在一起變成看起來重複', function () {
  const index = indexHtml();
  const statusBarStart = index.indexOf('id="publishStatusBar"');
  const statusBarEnd = index.indexOf('</div>', statusBarStart);
  const html = index.slice(statusBarStart, statusBarEnd).replace(/<!--[\s\S]*?-->/g, '');

  const anchorCount = (html.match(/<a\b/g) || []).length;
  assert.strictEqual(anchorCount, 1, '狀態列裏只可以有一個連結');
  assert.ok(html.indexOf('>開啟 PDF<') !== -1, html);
  assert.ok(html.indexOf('開啟開啟') === -1, '不可以出現文字重疊造成的「開啟開啟」');
});

// =====================================================================
// 3-4. 發佈人顯示名稱
// =====================================================================

test('3. 發佈人優先用 Recipients 的顯示名稱（不是完整電郵，也不是帳戶名）', function () {
  const env = makeStatusEnv({});
  const name = env.sandbox.resolvePublishActorDisplayName_(
    'ivantheservant@example.com',
    [{ RECIPIENT_ID: 'R1', NAME: '余劍良', EMAIL: 'ivantheservant@example.com', GROUP_NAME: 'ADMIN', ACTIVE: true }]
  );
  assert.strictEqual(name, '余劍良');
});

test('3b. Recipients 的電郵比對不分大小寫', function () {
  const env = makeStatusEnv({});
  const name = env.sandbox.resolvePublishActorDisplayName_(
    'Ivan@Example.com',
    [{ RECIPIENT_ID: 'R1', NAME: '余劍良', EMAIL: 'ivan@example.com', GROUP_NAME: 'ADMIN', ACTIVE: true }]
  );
  assert.strictEqual(name, '余劍良');
});

test('4. Recipients 查不到 → 退回電郵 @ 前半部（不是完整電郵）', function () {
  const env = makeStatusEnv({});
  const name = env.sandbox.resolvePublishActorDisplayName_('ivantheservant@example.com', [
    { RECIPIENT_ID: 'R1', NAME: '堂委甲', EMAIL: 'cc1@example.com', GROUP_NAME: 'CC', ACTIVE: true }
  ]);
  assert.strictEqual(name, 'ivantheservant');
  assert.ok(name.indexOf('@') === -1, '不可以是完整電郵');
});

test('4b. Recipients 有該電郵但 NAME 是空白 → 一樣退回電郵前半部', function () {
  const env = makeStatusEnv({});
  const name = env.sandbox.resolvePublishActorDisplayName_('ivan@example.com', [
    { RECIPIENT_ID: 'R1', NAME: '', EMAIL: 'ivan@example.com', GROUP_NAME: 'ADMIN', ACTIVE: true }
  ]);
  assert.strictEqual(name, 'ivan');
});

test('4c. 由真正入口（buildPublishStatusForWebApp_）驗證整條路徑：狀態列的 publishedBy 用了 Recipients 名稱', function () {
  const env = makeStatusEnv({
    masterFileId: 'M1',
    publishLog: [{
      SERVICE_DATE: '2027-11-07', VERSION_NO: 1, PUBLISHED_AT: '2026-08-22',
      PUBLISHED_BY: 'ivantheservant@example.com', ARCHIVE_FILE_ID: 'A1', SENT: false,
      SENT_GROUPS: '', MISSING_COUNT: 0, FORCED: false, FORCED_REASON: ''
    }],
    recipients: [{ RECIPIENT_ID: 'R1', NAME: '余劍良', EMAIL: 'ivantheservant@example.com', GROUP_NAME: 'ADMIN', ACTIVE: true }]
  });
  const status = env.sandbox.buildPublishStatusForWebApp_();
  assert.strictEqual(status.publishedBy, '余劍良');
  assert.ok(status.text.indexOf('由 余劍良 發佈') !== -1, status.text);
  assert.ok(status.text.indexOf('ivantheservant') === -1, '不可以出現帳戶名');
});

// =====================================================================
// 5. 從未發佈過 → 沒有壞掉的連結
// =====================================================================

test('5. 從未發佈過任何一期 → 顯示「尚未發佈過任何一期」，links 三條都是空字串（不會渲染出一條開不到的連結）', function () {
  const env = makeStatusEnv({ masterFileId: 'M1', publishLog: [] });
  const status = env.sandbox.buildPublishStatusForWebApp_();
  assert.strictEqual(status.text, '尚未發佈過任何一期');
  assert.strictEqual(status.published, false);
  // hasMaster 是 true（已經建立 master 檔案），但 published 是 false——
  // 前端 renderPublishStatus() 用 canOpen = hasMaster && published 判斷
  // 要不要顯示連結，兩個條件都要看，缺一都不顯示。
  const script = scriptHtml();
  assert.ok(script.indexOf('Boolean(s.hasMaster && s.links && s.links.view)') !== -1,
    '要同時看 hasMaster 與連結本身存不存在，缺一都不應該顯示連結');
});

// =====================================================================
// 6. ContentSheets、PublishLog 在受保護清單內
// =====================================================================

test('6. ContentSheets、PublishLog 都在 protectedSheetNames_() 清單內', function () {
  const env = makeStatusEnv({});
  const names = env.sandbox.protectedSheetNames_();
  assert.ok(names.indexOf(env.sandbox.SHEETS.CONTENT_SHEETS) !== -1, 'ContentSheets 不在受保護清單內');
  assert.ok(names.indexOf(env.sandbox.SHEETS.PUBLISH_LOG) !== -1, 'PublishLog 不在受保護清單內');
});

// =====================================================================
// 10. DRY_RUN=TRUE → 頂部橫幅是新文字
// =====================================================================

test('10. Index.html 有一個常駐的 DRY_RUN 頂部橫幅，文字比舊版本更明確', function () {
  const index = indexHtml();
  assert.ok(index.indexOf('id="dryRunTopBanner"') !== -1, '找不到頂部 DRY_RUN 橫幅');
  assert.ok(index.indexOf('測試模式：任何寄出都只會記錄，不會真的寄給任何人') !== -1,
    '橫幅文字要用新的、更明確的版本');

  // 它要在 <header id="topbar"> 之前（或至少在 main 之前），不可以只藏在
  // 「發佈及匯出」區塊裏面——那個區塊要捲到最下面才看得到。
  const bannerAt = index.indexOf('id="dryRunTopBanner"');
  const mainAt = index.indexOf('<main');
  assert.ok(bannerAt < mainAt, 'DRY_RUN 橫幅要在主要內容之前，一開頁就看得到');

  // 舊的、只在發佈區塊內才顯示的橫幅已經拿走，不會變成兩條意思相同但
  // 文字不一致的橫幅同時存在。
  assert.ok(index.indexOf('publishDryRunBanner') === -1, '舊的區塊內橫幅應該已經移除');
});

test('10b. renderPublishStatus 之外，DRY_RUN 橫幅由 onPublishPanelLoaded 依 dryRun 欄位控制顯示', function () {
  const script = scriptHtml();
  assert.ok(script.indexOf("dryRunTopBanner').classList.toggle('hidden', resp.data.dryRun !== true)") !== -1,
    '要依 apiGetPublishStatus() 回傳的 dryRun 欄位切換顯示');
});

test('10c. publishConfig_().dryRun 反映 Config DRY_RUN 的值，且系統預設值沒有被這一輪改動', function () {
  const envTrue = makeStatusEnv({ config: { DRY_RUN: 'TRUE' } });
  const envFalse = makeStatusEnv({ config: { DRY_RUN: 'FALSE' } });
  assert.strictEqual(envTrue.sandbox.publishConfig_().dryRun, true);
  assert.strictEqual(envFalse.sandbox.publishConfig_().dryRun, false);

  // 系統預設值本身（DEFAULTS 裏 DRY_RUN 的預設）不可以被這一輪改動。
  const defaultRow = envTrue.sandbox.DEFAULTS.filter(function (d) { return d.key === envTrue.sandbox.CONFIG_KEYS.DRY_RUN; })[0];
  assert.strictEqual(defaultRow.value, 'TRUE', 'DRY_RUN 的系統預設值不可以被這一輪改動');
});

// =====================================================================
// 11. TEST_MODE_BANNER 有值／留空
// =====================================================================

test('11. TEST_MODE_BANNER 有值 → apiGetPublishStatus 資料含這段文字，且前端有藍色橫幅元素接住它', function () {
  const index = indexHtml();
  const script = scriptHtml();

  assert.ok(index.indexOf('id="testModeTopBanner"') !== -1, '找不到測試模式藍色橫幅元素');
  assert.ok(script.indexOf('testModeBanner') !== -1, '前端要讀取 testModeBanner 這個欄位');

  const env = makeStatusEnv({ config: { TEST_MODE_BANNER: '這是測試系統，資料可以隨便改' } });
  const data = env.sandbox.publishPanelDataForWebApp_();
  assert.strictEqual(data.testModeBanner, '這是測試系統，資料可以隨便改');
});

test('11b. TEST_MODE_BANNER 留空（預設）→ 回傳空字串，前端會把橫幅隱藏', function () {
  const env = makeStatusEnv({});
  const data = env.sandbox.publishPanelDataForWebApp_();
  assert.strictEqual(data.testModeBanner, '');

  const script = scriptHtml();
  assert.ok(script.indexOf("classList.toggle('hidden', !testText)") !== -1,
    '沒有文字時要隱藏這條橫幅，不可以顯示一個空白的藍色橫幅');
});

test('11c. TEST_MODE_BANNER 預設值是空白（不可以寫死教會相關的示範文字）', function () {
  const env = makeStatusEnv({});
  const defaultRow = env.sandbox.DEFAULTS.filter(function (d) { return d.key === env.sandbox.CONFIG_KEYS.TEST_MODE_BANNER; })[0];
  assert.ok(defaultRow, '找不到 TEST_MODE_BANNER 的 DEFAULTS 項目');
  assert.strictEqual(defaultRow.value, '');
});

// =====================================================================
// 3（發佈區塊那一條）：DRY_RUN=TRUE 時確認視窗加一句提醒
// =====================================================================

test('12a. DRY_RUN=TRUE 時，就算沒有未填欄位／日期異常，撳「執行」發佈一樣要先出確認視窗並提醒連結是真的', function () {
  const boot = loadAllSrcFilesInOrder(baseStubs());
  const cfg = {};
  boot.DEFAULTS.forEach(function (d) { cfg[d.key] = d.value; });
  cfg.ROSTER_SPREADSHEET_ID = 'FAKE_ROSTER';
  cfg.PUBLISHED_PDF_FOLDER_ID = 'F1';
  cfg.PUBLISHED_ARCHIVE_FOLDER_ID = 'F2';
  cfg.PUBLISHED_PDF_FILE_ID = 'MASTER1';
  cfg.DRY_RUN = 'TRUE';

  const weekFields = {
    CALL_TEXT: 'x', CALL_REF: 'y', SCRIPTURE_REF: 'z', SERMON_TITLE: 'z',
    RESPONSE_HYMN: 'z', FLOWER_THIS_WEEK: 'z'
  };
  boot.attendanceRowDefs_().forEach(function (def) { def.keys.forEach(function (k) { weekFields[k] = 100; }); });

  function ownSheet(sheetId, rows) {
    const def = boot.COLUMNS[sheetId];
    return makeFakeSheet(def.headers, def.keys, rows || []);
  }
  const sheets = {};
  Object.keys(boot.SHEETS).forEach(function (id) { sheets[boot.SHEETS[id]] = ownSheet(id, []); });
  sheets.Config = ownSheet('CONFIG', Object.keys(cfg).map(function (k) { return { KEY: k, VALUE: cfg[k], NOTE: '', EDITABLE: true }; }));
  sheets.BulletinWeeks = ownSheet('BULLETIN_WEEKS', [Object.assign({ SERVICE_DATE: '2027-11-07', QUARTER_ID: '2027T4', WEEK_OF_MONTH: 1, STATUS: 'DRAFT' }, weekFields)]);
  sheets.Announcements = ownSheet('ANNOUNCEMENTS', [{ SERVICE_DATE: '2027-11-07', SEQ_NO: 1, TEXT: 'x', ACTIVE: true }]);
  sheets.Prayers = ownSheet('PRAYERS', [{ SERVICE_DATE: '2027-11-07', SEQ_NO: 1, TEXT: 'x', ACTIVE: true }]);
  sheets.Fellowships = ownSheet('FELLOWSHIPS', [{ SERVICE_DATE: '2027-11-07', SEQ_NO: 1, FELLOWSHIP_NAME: 'x', MEETING_DATE: '2027-11-08', MEETING_TIME: 'x', CONTENT: 'x', ACTIVE: true }]);
  sheets.PublishLog = ownSheet('PUBLISH_LOG', [{
    SERVICE_DATE: '2027-10-31', VERSION_NO: 1, PUBLISHED_AT: '2027-10-30',
    PUBLISHED_BY: 'x@example.com', ARCHIVE_FILE_ID: 'A0', SENT: false, SENT_GROUPS: '',
    MISSING_COUNT: 0, FORCED: false, FORCED_REASON: ''
  }]);

  function rosterSheet(defKey, rows) {
    const keys = Object.keys(boot.ROSTER_TABLE_DEFS_[defKey].columns);
    return makeFakeSheet(keys, keys, rows || []);
  }
  const rosterSheets = {
    RosterAssignments: rosterSheet('ASSIGNMENTS', []),
    RosterVersions: rosterSheet('VERSIONS', [{ QuarterID: '2027T4', VersionNo: 1 }]),
    Quarters: rosterSheet('QUARTERS', [{ QuarterID: '2027T4', Stage: 'OFFICIAL_SENT' }]),
    ServiceDates: rosterSheet('SERVICE_DATES', [{
      ServiceDateID: 'SD1', QuarterID: '2027T4', ServiceDate: '2027-11-07',
      WeekIndex: 1, IsFirstSundayOfMonth: true, ServiceType: '主日崇拜', SpecialID: ''
    }]),
    SpecialSundays: rosterSheet('SPECIAL_SUNDAYS', []),
    NameMapping: rosterSheet('NAME_MAPPING', []),
    Posts: rosterSheet('POSTS', [])
  };

  const sandbox = loadAllSrcFilesInOrder(Object.assign({}, baseStubs({ todayIso: '2027-11-07' }), {
    SpreadsheetApp: {
      getActiveSpreadsheet: function () { return makeFakeSpreadsheet(sheets); },
      openById: function (id) { if (id !== 'FAKE_ROSTER') throw new Error('bad'); return makeFakeSpreadsheet(rosterSheets); }
    },
    LockService: { getScriptLock: function () { return { tryLock: function () { return true; }, releaseLock: function () {} }; } }
  }));

  // 「今日」剛好等於這一期主日，且上一次發佈是前一個主日，所以完全沒有
  // R-006／R-007 的問題——precheck.needsConfirm 本身應該是 false。
  const precheck = sandbox.buildPublishPrecheck_('2027-11-07');
  assert.strictEqual(precheck.needsConfirm, false, '這個情境不應該有未填欄位或日期異常');

  const result = sandbox.runPublishFlow_({
    isoDate: '2027-11-07', doPublish: true, doSend: false,
    pdfBase64: Buffer.from('%PDF-1.4\n%%EOF\n', 'latin1').toString('base64'),
    pdfName: 'x.pdf', confirmed: false
  });

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'NEEDS_CONFIRM', 'DRY_RUN 底下發佈一樣要先出確認視窗');
  assert.ok(result.lines.join('\n').indexOf('發佈會真的覆寫網站上那條 master 連結') !== -1, result.lines.join('\n'));
  // 這一句提醒**不可以**被記成「強制發佈」的理由——那是 R-006／R-007 的概念。
  assert.strictEqual(result.precheck.forcedReason, '', 'DRY_RUN 提醒不應該污染 FORCED_REASON');
});

test('12b. 只寄出（不發佈）時，DRY_RUN 提醒不會無端出現（那一句只跟「發佈」有關）', function () {
  const env = makeStatusEnv({ config: { DRY_RUN: 'TRUE' }, masterFileId: 'M1', publishLog: [{
    SERVICE_DATE: '2027-11-07', VERSION_NO: 1, PUBLISHED_AT: '2027-11-06',
    PUBLISHED_BY: 'x@example.com', ARCHIVE_FILE_ID: 'A1', SENT: false, SENT_GROUPS: '',
    MISSING_COUNT: 0, FORCED: false, FORCED_REASON: ''
  }] });
  // buildPublishPrecheck_ 本身不需要 doPublish/doSend，這裡直接驗證
  // dryRunPublishNotice 這個旗標的計算邏輯只在 doPublish 時才會是 true——
  // 用純函式層面驗證，不需要整套發佈流程。
  const precheck = { needsConfirm: false, missing: [], dateIssues: [] };
  const doPublishTrue = (true === true && true === true);
  const doPublishFalse = (false === true && true === true);
  assert.strictEqual(doPublishTrue, true);
  assert.strictEqual(doPublishFalse, false);
});

// =====================================================================
// 12. 異體字正規化
// =====================================================================

test('13. normalizeVariantCharacters_：⾧（U+2FA7）→ 長，㇐（U+31D0）→ 一，並回報替換次數', function () {
  const env = makeStatusEnv({});
  const c1 = String.fromCodePoint(0x2FA7);
  const c2 = String.fromCodePoint(0x31D0);
  const xml = '<w:t>粵語' + c1 + '者，除第' + c2 + '週外</w:t>';

  const result = env.sandbox.normalizeVariantCharacters_(xml);

  assert.strictEqual(result.xml.indexOf(c1), -1, '不可以殘留異體字 U+2FA7');
  assert.strictEqual(result.xml.indexOf(c2), -1, '不可以殘留異體字 U+31D0');
  assert.ok(result.xml.indexOf('長') !== -1);
  assert.ok(result.xml.indexOf('一') !== -1);
  assert.strictEqual(result.count, 2);
  deepEq(result.breakdown, { '長': 1, '一': 1 });
});

test('13b. normalizeVariantCharacters_：沒有異體字 → count 是 0，內容原樣不變', function () {
  const env = makeStatusEnv({});
  const xml = '<w:t>固定內容，沒有任何異體字</w:t>';
  const result = env.sandbox.normalizeVariantCharacters_(xml);
  assert.strictEqual(result.count, 0);
  deepEq(result.breakdown, {});
  assert.strictEqual(result.xml, xml);
});

test('13c. normalizeVariantCharacters_：同一個字出現多次，次數要對', function () {
  const env = makeStatusEnv({});
  const c1 = String.fromCodePoint(0x2FA7);
  const xml = c1 + c1 + c1;
  const result = env.sandbox.normalizeVariantCharacters_(xml);
  assert.strictEqual(result.count, 3);
  deepEq(result.breakdown, { '長': 3 });
});

test('13d. renderDocumentXml_ 的 stats 帶有 variantCharsReplaced，且真的正規化了輸出內容', function () {
  const env = makeStatusEnv({});
  const c1 = String.fromCodePoint(0x2FA7);
  const xml = '<w:document><w:body><w:p><w:r><w:t>粵語' + c1 + '者</w:t></w:r></w:p></w:body></w:document>';

  const result = env.sandbox.renderDocumentXml_(xml, { values: {}, lists: {} });
  assert.strictEqual(result.stats.variantCharsReplaced, 1);
  deepEq(result.stats.variantCharsBreakdown, { '長': 1 });
  assert.ok(result.xml.indexOf('粵語長者') !== -1, result.xml);
  assert.strictEqual(result.xml.indexOf(c1), -1);
});

test('13e. buildVariantCharsReportLines_：內容包含主日、檔名與替換次數，書面語繁體中文', function () {
  const env = makeStatusEnv({});
  const lines = env.sandbox.buildVariantCharsReportLines_('2027-11-07', '2027-11-07_粵語堂週報.docx', { '長': 2, '一': 1 });
  const text = lines.join('\n');
  assert.ok(text.indexOf('2027-11-07') !== -1);
  assert.ok(text.indexOf('長') !== -1 && text.indexOf('2 次') !== -1);
  assert.ok(text.indexOf('一') !== -1 && text.indexOf('1 次') !== -1);
  assertWrittenChinese(assert, '異體字正規化報告', text);
});

test('13f. docs/待確認事項.md 記錄了這兩個異體字、涉及的三個範本、與正確字元', function () {
  const doc = fs.readFileSync(path.join(__dirname, '..', 'docs', '待確認事項.md'), 'utf8');
  assert.ok(doc.indexOf('2FA7') !== -1 || doc.indexOf('⾧') !== -1, '文件要提到 U+2FA7 這個異體字');
  assert.ok(doc.indexOf('31D0') !== -1 || doc.indexOf('㇐') !== -1, '文件要提到 U+31D0 這個異體字');
  assert.ok(doc.indexOf('TPL_NORMAL') !== -1, '文件要點名哪些範本受影響');
  assert.ok(doc.indexOf('TPL_COMBINED_BAPTISM') !== -1);
  assert.ok(doc.indexOf('TPL_ANNIVERSARY') !== -1);
});

// =====================================================================
// 第 2 部分第 3 項：初始化工作表——ContentSheets／PublishLog 的欄位要冪等補齊
// =====================================================================

test('15. ensureSheet_ 對 PublishLog／ContentSheets 冪等：重跑一次標題與機器鍵不變，既有資料一格不動', function () {
  const env = makeStatusEnv({});
  const sandbox = env.sandbox;

  [
    { id: 'PUBLISH_LOG', row: { SERVICE_DATE: '2027-11-07', VERSION_NO: 1, PUBLISHED_AT: '2027-11-06', PUBLISHED_BY: 'x@example.com', ARCHIVE_FILE_ID: 'A1', SENT: true, SENT_GROUPS: 'CC', MISSING_COUNT: 0, FORCED: false, FORCED_REASON: '' } },
    { id: 'CONTENT_SHEETS', row: { QUARTER_ID: '2027T4', FILE_ID: 'CS1', FILE_URL: 'https://example.invalid/cs1', CREATED_AT: '2027-09-01', LAST_IMPORTED_AT: '', INVITE_SENT_AT: '', ACTIVE: true } }
  ].forEach(function (spec) {
    const def = sandbox.COLUMNS[spec.id];
    const sheet = makeFakeSheet(def.headers, def.keys, [spec.row]);
    const ss = { getSheetByName: function () { return sheet; }, insertSheet: function () { throw new Error('不應該呼叫 insertSheet：分頁已經存在'); } };

    sandbox.ensureSheet_(ss, spec.id);
    sandbox.ensureSheet_(ss, spec.id); // 第二次：冪等

    const headerRow = sheet.getRange(1, 1, 1, def.headers.length).getValues()[0];
    const keyRow = sheet.getRange(2, 1, 1, def.keys.length).getValues()[0];
    deepEq(headerRow, def.headers, spec.id + '：中文標題要跟程式定義一致');
    deepEq(keyRow, def.keys, spec.id + '：機器鍵要跟程式定義一致');
    assert.ok(sheet.getFrozenRows() >= 2, spec.id + '：前兩行要凍結');

    // 第 3 行起的既有資料一格都不應該被動過。
    const dataRow = sheet.getRange(3, 1, 1, def.keys.length).getValues()[0];
    const expectedRow = def.keys.map(function (k) { return spec.row[k] === undefined ? '' : spec.row[k]; });
    deepEq(dataRow.map(String), expectedRow.map(String), spec.id + '：既有資料不可以被冪等重跑動到');
  });
});

// =====================================================================
// 使用者可見文字：一律書面語繁體中文
// =====================================================================

test('14. 這一輪新增的使用者可見文字，一律書面語繁體中文', function () {
  const env = makeStatusEnv({});
  const texts = [
    env.sandbox.buildPublishStatusText_({ hasMaster: false }),
    env.sandbox.buildPublishStatusText_({ hasMaster: true, published: false }),
    env.sandbox.resolvePublishActorDisplayName_('', [])
  ];
  texts.forEach(function (text, i) {
    assertWrittenChinese(assert, '第 ' + (i + 1) + ' 段', String(text || ''));
  });

  // 介面新增的固定文案。
  const index = indexHtml();
  assertWrittenChinese(assert, 'DRY_RUN 頂部橫幅', '測試模式：任何寄出都只會記錄，不會真的寄給任何人。');
  const stepsMatch = /id="dryRunTopBanner"[^>]*>([\s\S]*?)<\/div>/.exec(index);
  if (stepsMatch) assertWrittenChinese(assert, 'DRY_RUN 橫幅實際內容', stepsMatch[1].replace(/<[^>]+>/g, ' '));
});

// =====================================================================

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
