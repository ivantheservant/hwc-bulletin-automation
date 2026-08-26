#!/usr/bin/env node
/**
 * tests/previewpage.test.js
 *
 * R-033（草稿預覽網頁）、R-032（內容過多的提示），以及「部署者永遠不可以
 * 被鎖在系統外面」那一項安全修正的回歸測試。
 *
 * ⚠️ 第 1 組那幾條鎖住的是一件真的發生過的事：`WEBAPP_ALLOWED_EMAILS`
 * 只有兩個同工的電郵，**部署者本人不在裏面**，於是自己開不到自己部署的
 * Web App。一個權限系統不可以把唯一有能力修好它的人擋在門外。
 *
 * 執行方式：node tests/previewpage.test.js
 * 離開碼：0＝全部通過　1＝有測試失敗
 */

'use strict';

const assert = require('assert');
const vm = require('vm');
const { loadAllSrcFilesInOrder } = require('./helpers/loadGas');
const { makeFakeSheet, makeFakeSpreadsheet } = require('./helpers/fakeSpreadsheet');

const FAKE_ROSTER_ID = 'FAKE_ROSTER_ID_FOR_PREVIEW_TEST';
const FAKE_WEBAPP_URL = 'https://script.google.com/macros/s/FAKE_DEPLOYMENT_ID_0001/exec';
const DEPLOYER = 'deployer@example.org';
const ALLOWED_ONE = 'clerk@example.org';
const OUTSIDER = 'stranger@example.org';

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

function baseStubs(callerEmail) {
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
      newBlob: function (content) { return { getBytes: function () { return []; }, __content: content }; }
    },
    Session: {
      getScriptTimeZone: function () { return 'Pacific/Auckland'; },
      getActiveUser: function () { return { getEmail: function () { return callerEmail; } }; },
      getEffectiveUser: function () { return { getEmail: function () { return DEPLOYER; } }; }
    },
    CacheService: {},
    HtmlService: {
      createHtmlOutput: function (html) {
        const out = {
          __html: html,
          setTitle: function () { return out; },
          addMetaTag: function () { return out; },
          getContent: function () { return html; }
        };
        return out;
      }
    },
    ScriptApp: {
      getService: function () { return { getUrl: function () { return ''; } }; }
    },
    MailApp: {
      sendEmail: function () { throw new Error('這一組測試一律 DRY_RUN，不應該真的寄'); }
    },
    LockService: {
      getScriptLock: function () {
        return { tryLock: function () { return true; }, releaseLock: function () {} };
      }
    }
  };
}

const boot = loadAllSrcFilesInOrder(baseStubs(DEPLOYER));

/**
 * 造一個**讀得到但沒有這一季**的假職事表。
 *
 * ⚠️ 一定要讀得到：讀不到是「Drive 出事」，`buildBulletinModel_()` 會拋錯，
 * 預覽頁只會出一版錯誤訊息——那驗不到這一組要驗的東西。這裏要的是
 * 「讀得到、但這一季沒有資料」，也就是 R-036 那條路。
 */
function makeRosterSheets() {
  function sheet(defKey, rows) {
    const keys = Object.keys(boot.ROSTER_TABLE_DEFS_[defKey].columns);
    return makeFakeSheet(keys, keys, rows);
  }
  return {
    RosterAssignments: sheet('ASSIGNMENTS', []),
    RosterVersions: sheet('VERSIONS', []),
    Quarters: sheet('QUARTERS', []),
    ServiceDates: sheet('SERVICE_DATES', []),
    SpecialSundays: sheet('SPECIAL_SUNDAYS', []),
    NameMapping: sheet('NAME_MAPPING', []),
    Posts: sheet('POSTS', [])
  };
}

function makeEnv(options) {
  const o = options || {};
  const callerEmail = o.callerEmail === undefined ? DEPLOYER : o.callerEmail;

  const cfg = {};
  boot.DEFAULTS.forEach(function (d) { cfg[d.key] = d.value; });
  cfg.ROSTER_SPREADSHEET_ID = FAKE_ROSTER_ID;
  cfg.PREVIEW_WEBAPP_URL = FAKE_WEBAPP_URL;
  cfg.DRY_RUN = 'TRUE';
  Object.assign(cfg, o.config || {});

  const sheets = {};
  Object.keys(boot.SHEETS).forEach(function (id) {
    const def = boot.COLUMNS[id];
    sheets[boot.SHEETS[id]] = makeFakeSheet(def.headers, def.keys, []);
  });
  sheets.Config = makeFakeSheet(boot.COLUMNS.CONFIG.headers, boot.COLUMNS.CONFIG.keys,
    Object.keys(cfg).map(function (k) { return { KEY: k, VALUE: cfg[k], NOTE: '', EDITABLE: true }; }));
  sheets.EmailTemplates = makeFakeSheet(boot.COLUMNS.EMAIL_TEMPLATES.headers,
    boot.COLUMNS.EMAIL_TEMPLATES.keys, o.emailTemplates || boot.seedEmailTemplatesRows_());
  sheets.Recipients = makeFakeSheet(boot.COLUMNS.RECIPIENTS.headers,
    boot.COLUMNS.RECIPIENTS.keys, o.recipients || []);
  Object.keys(sheets).forEach(function (name) { sheets[name].setName(name); });

  const rosterSheets = makeRosterSheets();
  Object.keys(rosterSheets).forEach(function (name) { rosterSheets[name].setName(name); });

  const sandbox = loadAllSrcFilesInOrder(Object.assign({}, baseStubs(callerEmail), {
    SpreadsheetApp: {
      getActiveSpreadsheet: function () { return makeFakeSpreadsheet(sheets); },
      openById: function (id) {
        if (id !== FAKE_ROSTER_ID) throw new Error('未預期的 openById：' + id);
        return makeFakeSpreadsheet(rosterSheets);
      },
      ProtectionType: { SHEET: 'SHEET' },
      getUi: function () { throw new Error('這一組測試不應該用到 UI'); }
    }
  }));

  vm.runInContext('function __mkDate(y, m, d, hh, mi, ss) { return new Date(y, m, d, hh, mi, ss); }', sandbox);

  // BulletinWeeks 的行要在 sandbox 造好之後寫（Date 跨 realm 過不到正規化）。
  (o.weekRowSpecs || []).forEach(function (spec) {
    const p = spec.isoDate.split('-').map(Number);
    sandbox.writeSheet(sandbox.SHEETS.BULLETIN_WEEKS, [Object.assign({
      SERVICE_DATE: sandbox.__mkDate(p[0], p[1] - 1, p[2], 0, 0, 0),
      QUARTER_ID: spec.quarterId || '2030T1',
      WEEK_OF_MONTH: 1,
      STATUS: 'DRAFT'
    }, spec.fields || {})]);
  });

  return { sandbox: sandbox, sheets: sheets };
}

// =====================================================================
// 第 1 組：部署者永遠不可以被鎖在系統外面
// =====================================================================

console.log('\n第 1 組：部署者不可以被鎖在系統外面');

test('部署者不在 WEBAPP_ALLOWED_EMAILS → 仍然可以使用', function () {
  // ⚠️ 這正是真的發生過那一次：名單只有兩個同工，部署者本人不在裏面。
  const env = makeEnv({});
  assert.strictEqual(
    env.sandbox.isEmailAuthorized_(DEPLOYER, [ALLOWED_ONE, 'other@example.org'], DEPLOYER),
    true,
    '部署者一律放行，不論名單有沒有他');
});

test('名單內的其他電郵 → 可以使用', function () {
  const env = makeEnv({});
  assert.strictEqual(
    env.sandbox.isEmailAuthorized_(ALLOWED_ONE, [ALLOWED_ONE], DEPLOYER), true);
});

test('名單外又不是部署者 → 被擋', function () {
  const env = makeEnv({});
  assert.strictEqual(
    env.sandbox.isEmailAuthorized_(OUTSIDER, [ALLOWED_ONE], DEPLOYER), false);
});

test('名單空白時只有部署者通過（舊行為不變）', function () {
  const env = makeEnv({});
  assert.strictEqual(env.sandbox.isEmailAuthorized_(DEPLOYER, [], DEPLOYER), true);
  assert.strictEqual(env.sandbox.isEmailAuthorized_(OUTSIDER, [], DEPLOYER), false);
});

test('查不到呼叫者電郵 → 一律擋（不可以因為查不到就放行）', function () {
  const env = makeEnv({});
  assert.strictEqual(env.sandbox.isEmailAuthorized_('', [ALLOWED_ONE], DEPLOYER), false);
  assert.strictEqual(env.sandbox.isEmailAuthorized_('', [], DEPLOYER), false);
});

test('大小寫不同一樣認得出（部署者與名單兩邊都要）', function () {
  const env = makeEnv({});
  assert.strictEqual(
    env.sandbox.isEmailAuthorized_('DEPLOYER@Example.org', [], DEPLOYER), true);
  assert.strictEqual(
    env.sandbox.isEmailAuthorized_('CLERK@Example.org', [ALLOWED_ONE], DEPLOYER), true);
});

test('「沒有使用權限」那一頁要印出目前登入的電郵', function () {
  // ⚠️ 最常見的原因根本不是權限，是瀏覽器登入了另一個 Google 帳戶。
  //    印出電郵，多數情況一眼就看得出。
  const env = makeEnv({ callerEmail: OUTSIDER });
  const lines = env.sandbox.buildNoAccessLines_();
  const text = Array.prototype.slice.call(lines).join('\n');
  assert.ok(text.indexOf(OUTSIDER) !== -1, '要印出登入的電郵：' + text);
  assert.ok(text.indexOf('切換帳戶') !== -1, '要提示可以切換帳戶：' + text);
});

test('查不到電郵時那一頁也不可以留白', function () {
  const env = makeEnv({ callerEmail: '' });
  const text = Array.prototype.slice.call(env.sandbox.buildNoAccessLines_()).join('\n');
  assert.ok(text.indexOf('查不到') !== -1, '要明講查不到，不是留一個空白：' + text);
});

test('自我檢測：名單不含部署者 → 🟡，而且講明「仍然可以使用」', function () {
  // ⚠️ 一定要黃不是紅：部署者一律放行，現況是可以用的，不是壞了。
  //    報紅等於叫人去修一件沒有壞的事。
  const env = makeEnv({});
  const S = env.sandbox.SELF_CHECK_STATUS_;
  const item = env.sandbox.buildDeployerInAllowlistItem_([ALLOWED_ONE], DEPLOYER, S);
  assert.strictEqual(item[1], S.YELLOW);
  assert.ok(item[2].indexOf('仍然可以使用') !== -1, item[2]);
  assert.ok(item[2].indexOf(DEPLOYER) !== -1, '要講出部署者是誰：' + item[2]);
});

test('自我檢測：名單包含部署者 → 🟢', function () {
  const env = makeEnv({});
  const S = env.sandbox.SELF_CHECK_STATUS_;
  const item = env.sandbox.buildDeployerInAllowlistItem_([ALLOWED_ONE, DEPLOYER], DEPLOYER, S);
  assert.strictEqual(item[1], S.GREEN);
});

test('自我檢測：名單空白 → 🟡，講明只有部署者用得到', function () {
  const env = makeEnv({});
  const S = env.sandbox.SELF_CHECK_STATUS_;
  const item = env.sandbox.buildDeployerInAllowlistItem_([], DEPLOYER, S);
  assert.strictEqual(item[1], S.YELLOW);
  assert.ok(item[2].indexOf('只有部署者') !== -1, item[2]);
});

test('自我檢測：查不到部署者電郵 → 🟡「比不到」，不是靜靜報綠', function () {
  const env = makeEnv({});
  const S = env.sandbox.SELF_CHECK_STATUS_;
  const item = env.sandbox.buildDeployerInAllowlistItem_([ALLOWED_ONE], '', S);
  assert.strictEqual(item[1], S.YELLOW);
  assert.ok(item[2].indexOf('比不到') !== -1, item[2]);
});

// =====================================================================
// 第 2 組：預覽頁本身
// =====================================================================

console.log('\n第 2 組：預覽網頁');

function previewEnv(extra) {
  return makeEnv(Object.assign({
    weekRowSpecs: [
      { isoDate: '2030-01-06', fields: { SERMON_TITLE: '測試講題', PAGE_TITLE: '崇拜程序' } }
    ]
  }, extra || {}));
}

test('預覽頁完全唯讀：沒有 form、沒有 google.script.run、沒有 input', function () {
  // ⚠️ 這一條是「授權可以放寬到網域內任何人」的前提。前提一破，
  //    整個授權決定就要重新想。
  const env = previewEnv();
  const page = env.sandbox.buildPreviewPage_('2030-01-06');
  const html = String(page.html);
  ['<form', 'google.script.run', '<input', '<button', '<textarea'].forEach(function (bad) {
    assert.strictEqual(html.indexOf(bad), -1, '預覽頁不可以有 ' + bad);
  });
});

test('未填的欄位顯示「（未填）」，不是留空白', function () {
  const env = previewEnv();
  const html = String(env.sandbox.buildPreviewPage_('2030-01-06').html);
  assert.ok(html.indexOf('（未填）') !== -1, '預覽的用途就是讓人看到有什麼未填');
});

test('頂部有提示語，而且取自 Config', function () {
  const custom = '這是自訂的提示語，用來驗證真的讀了 Config。';
  const env = previewEnv({ config: { PREVIEW_NOTICE: custom } });
  const html = String(env.sandbox.buildPreviewPage_('2030-01-06').html);
  assert.ok(html.indexOf(custom) !== -1, '提示語要取自 Config：' + html.slice(0, 300));
  // 而且要在最前面（h1 之前）。
  assert.ok(html.indexOf(custom) < html.indexOf('<h1'), '提示語要排在最前，不可以埋在下面');
});

test('帶日期 → 顯示的就是那一個主日', function () {
  const env = previewEnv();
  const page = env.sandbox.buildPreviewPage_('2030-01-06');
  assert.strictEqual(page.isoDate, '2030-01-06');
  assert.ok(String(page.html).indexOf('2030-01-06') !== -1);
});

test('日期格式不合法 → 當成沒有傳，走「下一個主日」那條路', function () {
  const env = previewEnv();
  const page = env.sandbox.buildPreviewPage_('亂寫');
  // 這個環境算不算得到下一個主日不重要，重點是不可以把「亂寫」當成日期。
  assert.notStrictEqual(page.isoDate, '亂寫');
});

test('九個區塊照週報次序，一個都不可以少（空的照出，內容寫「（未填）」）', function () {
  // ⚠️ 空的清單不顯示那個區塊的話，看的人分不出「這一期沒有代禱」與
  //    「這一段還未填」。
  const env = previewEnv();
  const html = String(env.sandbox.buildPreviewPage_('2030-01-06').html);
  // ⚠️ 人數表與下週事奉那兩個標題**取自 Config**（DEFAULT_ATTENDANCE_HEADING／
  //    DEFAULT_NEXT_WEEK_HEADING），所以這裏用預設值本身，不是自己另改一個
  //    短名——寫死一個不同的名，等於測試與實際顯示的東西對不上。
  const wanted = ['崇拜程序', '本週事奉', '上週主日崇拜人數', '下週主日崇拜聚會事奉肢體',
    '獻花', '家事報告', '代禱事項', '本週團契聚會', '財政報告'];
  let cursor = -1;
  wanted.forEach(function (title) {
    const at = html.indexOf('>' + title);
    assert.ok(at !== -1, '缺少區塊：' + title);
    assert.ok(at > cursor, '區塊次序不對，「' + title + '」排錯位置');
    cursor = at;
  });
});

test('頁尾三樣都要有：最後更新、最後匯入、發佈狀態', function () {
  const env = previewEnv();
  const html = String(env.sandbox.buildPreviewPage_('2030-01-06').html);
  ['資料最後更新', '內容表最後匯入', '發佈狀態'].forEach(function (label) {
    assert.ok(html.indexOf(label) !== -1, '頁尾缺少：' + label);
  });
});

test('previewCell_：空值變「（未填）」，有值就跳脫', function () {
  const env = makeEnv({});
  assert.ok(env.sandbox.previewCell_('').indexOf('（未填）') !== -1);
  assert.ok(env.sandbox.previewCell_('   ').indexOf('（未填）') !== -1);
  assert.ok(env.sandbox.previewCell_(null).indexOf('（未填）') !== -1);
  assert.strictEqual(env.sandbox.previewCell_('平安'), '平安');
  assert.strictEqual(env.sandbox.previewCell_('<script>'), '&lt;script&gt;');
});

test('授權：PREVIEW_REQUIRE_ALLOWLIST=FALSE（預設）→ 名單外的人都開得到', function () {
  const env = makeEnv({ callerEmail: OUTSIDER, config: { WEBAPP_ALLOWED_EMAILS: ALLOWED_ONE } });
  assert.strictEqual(env.sandbox.isPreviewCallerAuthorized_(), true,
    '預覽頁唯讀，預設不受名單限制');
});

test('授權：PREVIEW_REQUIRE_ALLOWLIST=TRUE → 受名單限制', function () {
  const env = makeEnv({
    callerEmail: OUTSIDER,
    config: { PREVIEW_REQUIRE_ALLOWLIST: 'TRUE', WEBAPP_ALLOWED_EMAILS: ALLOWED_ONE }
  });
  assert.strictEqual(env.sandbox.isPreviewCallerAuthorized_(), false);
});

test('授權：PREVIEW_REQUIRE_ALLOWLIST=TRUE 時，部署者一樣放行', function () {
  const env = makeEnv({
    callerEmail: DEPLOYER,
    config: { PREVIEW_REQUIRE_ALLOWLIST: 'TRUE', WEBAPP_ALLOWED_EMAILS: ALLOWED_ONE }
  });
  assert.strictEqual(env.sandbox.isPreviewCallerAuthorized_(), true);
});

test('連結固定不變：不帶日期就是 ?page=preview，帶日期才多一個參數', function () {
  const env = makeEnv({});
  assert.strictEqual(env.sandbox.buildPreviewUrl_(), FAKE_WEBAPP_URL + '?page=preview');
  assert.strictEqual(env.sandbox.buildPreviewUrl_('2030-01-06'),
    FAKE_WEBAPP_URL + '?page=preview&date=2030-01-06');
  assert.strictEqual(env.sandbox.buildPreviewUrl_('亂寫'), FAKE_WEBAPP_URL + '?page=preview',
    '日期不合法就當成沒有傳，不可以把亂碼放進網址');
});

test('取不到網址 → 回空字串（呼叫方要自己處理，不可以當成有連結）', function () {
  const env = makeEnv({ config: { PREVIEW_WEBAPP_URL: '' } });
  assert.strictEqual(env.sandbox.buildPreviewUrl_(), '');
});

test('doGet 的路由：?page=preview 走預覽，其餘走填寫介面', function () {
  const env = makeEnv({});
  assert.strictEqual(env.sandbox.webAppRequestedPage_({ parameter: { page: 'preview' } }), 'preview');
  assert.strictEqual(env.sandbox.webAppRequestedPage_({ parameter: { page: 'PREVIEW' } }), 'preview',
    '大小寫不同一樣認得出');
  assert.strictEqual(env.sandbox.webAppRequestedPage_({ parameter: {} }), '');
  assert.strictEqual(env.sandbox.webAppRequestedPage_(null), '');
});

// =====================================================================
// 第 3 組：星期一寄出草稿預覽
// =====================================================================

console.log('\n第 3 組：星期一寄出草稿預覽');

function mailEnv(extra) {
  return makeEnv(Object.assign({
    recipients: [
      { GROUP_NAME: 'CC', NAME: '甲', EMAIL: 'cc1@example.org', ACTIVE: true },
      { GROUP_NAME: 'DB', NAME: '乙', EMAIL: 'db1@example.org', ACTIVE: true },
      { GROUP_NAME: 'OTHER', NAME: '丙', EMAIL: 'other@example.org', ACTIVE: true }
    ],
    weekRowSpecs: [{ isoDate: '2030-01-06' }]
  }, extra || {}));
}

test('DRY_RUN=TRUE → 不會真寄，但照樣寫 SendLog（STATUS=PREVIEW）', function () {
  // ⚠️ 只在真寄時才寫 SendLog 的話，DRY_RUN 之下就完全看不出「本來會寄給誰」，
  //    等於試行模式什麼都驗不到。MailApp.sendEmail 在這一組會拋錯，
  //    所以「沒有拋錯」本身就證明了沒有真寄。
  const env = mailEnv();
  const result = env.sandbox.sendPreviewNotice_('2030-01-06');

  assert.strictEqual(result.sent, true, result.message);
  assert.strictEqual(result.dryRun, true);
  assert.strictEqual(result.recipientCount, 2, '只有 CC 與 DB 兩組，OTHER 不算');

  const rows = env.sandbox.readSheet(env.sandbox.SHEETS.SEND_LOG);
  assert.strictEqual(rows.length, 2);
  rows.forEach(function (r) {
    assert.strictEqual(String(r.STATUS), 'PREVIEW');
    assert.strictEqual(r.DRY_RUN, true);
  });
});

test('信的內文含那條預覽連結', function () {
  const env = mailEnv();
  env.sandbox.sendPreviewNotice_('2030-01-06');
  const rows = env.sandbox.readSheet(env.sandbox.SHEETS.SEND_LOG);
  assert.ok(String(rows[0].BODY_PREVIEW).indexOf('page=preview') !== -1,
    '寄一封沒有連結的信等於白寄：' + rows[0].BODY_PREVIEW);
});

test('信的內文講明「版面與正式印刷版不同」與「連結固定不變」', function () {
  const env = mailEnv();
  env.sandbox.sendPreviewNotice_('2030-01-06');
  const body = String(env.sandbox.readSheet(env.sandbox.SHEETS.SEND_LOG)[0].BODY_PREVIEW);
  assert.ok(body.indexOf('版面與正式印刷版不同') !== -1, body);
  assert.ok(body.indexOf('固定不變') !== -1, body);
});

test('PREVIEW_ENABLED=FALSE → 不寄，SendLog 一筆都沒有多', function () {
  const env = mailEnv({ config: { PREVIEW_ENABLED: 'FALSE' } });
  const result = env.sandbox.sendPreviewNotice_('2030-01-06');
  assert.strictEqual(result.sent, false);
  assert.strictEqual(result.reason, 'DISABLED');
  assert.strictEqual(env.sandbox.readSheet(env.sandbox.SHEETS.SEND_LOG).length, 0);
});

test('取不到網址 → 不寄，而且講明原因（不是靜靜寄一封沒有連結的信）', function () {
  const env = mailEnv({ config: { PREVIEW_WEBAPP_URL: '' } });
  const result = env.sandbox.sendPreviewNotice_('2030-01-06');
  assert.strictEqual(result.sent, false);
  assert.strictEqual(result.reason, 'NO_URL');
  assert.ok(result.message.indexOf('PREVIEW_WEBAPP_URL') !== -1, result.message);
});

test('沒有收件人 → 不寄，reason 講得出是哪一個原因', function () {
  const env = mailEnv({ recipients: [] });
  const result = env.sandbox.sendPreviewNotice_('2030-01-06');
  assert.strictEqual(result.sent, false);
  assert.strictEqual(result.reason, 'NO_RECIPIENTS');
});

test('職事表未有資料 → 照樣寄，而且信中有待定提示', function () {
  // ⚠️ R-036 的整個用意：未到時候不是錯誤。事奉未定更加要看得到。
  const env = mailEnv();
  const result = env.sandbox.sendPreviewNotice_('2030-01-06');
  assert.strictEqual(result.sent, true, '職事表未有資料一樣要寄');
  const body = String(env.sandbox.readSheet(env.sandbox.SHEETS.SEND_LOG)[0].BODY_PREVIEW);
  assert.ok(body.indexOf('事奉資料尚未確定') !== -1, '要有待定提示：' + body);
});

// =====================================================================
// 第 4 組：R-032 重複段落偵測
// =====================================================================

console.log('\n第 4 組：重複段落偵測');

function para(text) { return '<w:p><w:r><w:t>' + text + '</w:t></w:r></w:p>'; }

const LONG_A = '為斯里蘭卡短宣隊代禱，求主保守隊員身心靈健壯，行程順利平安。';
const LONG_B = '請為本週三晚上的祈禱會代禱，求主感動更多弟兄姊妹一同參與聚會。';
const LONG_C = '本主日崇拜後設有愛筵，歡迎各位弟兄姊妹留步一同用餐與團契。';

test('0 段重複 → 回空陣列', function () {
  const env = makeEnv({});
  const xml = '<w:body>' + para(LONG_A) + para(LONG_B) + para(LONG_C) + '</w:body>';
  assert.strictEqual(env.sandbox.docxScanDuplicateParagraphs_(xml, 25).length, 0);
});

test('1 段重複 → 列出那一段與次數', function () {
  const env = makeEnv({});
  const xml = '<w:body>' + para(LONG_A) + para(LONG_B) + para(LONG_A) + '</w:body>';
  const found = env.sandbox.docxScanDuplicateParagraphs_(xml, 25);
  assert.strictEqual(found.length, 1);
  assert.strictEqual(found[0].text, LONG_A);
  assert.strictEqual(found[0].count, 2);
});

test('3 段重複 → 三段都列出，而且依次數由多到少', function () {
  const env = makeEnv({});
  const xml = '<w:body>'
    + para(LONG_A) + para(LONG_A) + para(LONG_A)
    + para(LONG_B) + para(LONG_B)
    + para(LONG_C) + para(LONG_C)
    + '</w:body>';
  const found = env.sandbox.docxScanDuplicateParagraphs_(xml, 25);
  assert.strictEqual(found.length, 3);
  assert.strictEqual(found[0].count, 3, '出現最多次那一段要排最前：' + JSON.stringify(found));
});

test('⚠️ 文字方塊（AlternateContent）內的正常重複不算', function () {
  // ⚠️ Word 為了向下相容，同一個文字方塊會有 Choice 與 Fallback 兩份
  //    **內容一模一樣**的副本。不挖走的話，每一個文字方塊的每一段都會
  //    「出現兩次」——滿屏假警報，真正的複製漏刪反而被淹沒。
  const env = makeEnv({});
  const xml = '<w:body>'
    + '<mc:AlternateContent>'
    + '<mc:Choice>' + para(LONG_A) + '</mc:Choice>'
    + '<mc:Fallback>' + para(LONG_A) + '</mc:Fallback>'
    + '</mc:AlternateContent>'
    + para(LONG_B)
    + '</w:body>';
  assert.strictEqual(env.sandbox.docxScanDuplicateParagraphs_(xml, 25).length, 0,
    '文字方塊的重複是 OOXML 的正常結構，不是問題');
});

test('文字方塊之外的真重複，仍然抓得到（證明上一條不是靠關掉整個功能）', function () {
  const env = makeEnv({});
  const xml = '<w:body>'
    + '<mc:AlternateContent><mc:Choice>' + para(LONG_A) + '</mc:Choice>'
    + '<mc:Fallback>' + para(LONG_A) + '</mc:Fallback></mc:AlternateContent>'
    + para(LONG_B) + para(LONG_B)
    + '</w:body>';
  const found = env.sandbox.docxScanDuplicateParagraphs_(xml, 25);
  assert.strictEqual(found.length, 1);
  assert.strictEqual(found[0].text, LONG_B);
});

test('巢狀文字方塊也挖得乾淨（非貪婪正規式會在這裏出事）', function () {
  const env = makeEnv({});
  const xml = '<w:body>'
    + '<mc:AlternateContent><mc:Choice>'
    + '<mc:AlternateContent><mc:Choice>' + para(LONG_A) + '</mc:Choice></mc:AlternateContent>'
    + para(LONG_A)
    + '</mc:Choice></mc:AlternateContent>'
    + para(LONG_B)
    + '</w:body>';
  assert.strictEqual(env.sandbox.docxScanDuplicateParagraphs_(xml, 25).length, 0);
});

test('短過門檻的段落重複不算（「請代禱。」出現三次都不報）', function () {
  const env = makeEnv({});
  const xml = '<w:body>' + para('請代禱。') + para('請代禱。') + para('請代禱。') + '</w:body>';
  assert.strictEqual(env.sandbox.docxScanDuplicateParagraphs_(xml, 25).length, 0);
});

test('門檻可以調低，調低之後短句就算數（證明門檻真的有作用）', function () {
  const env = makeEnv({});
  const xml = '<w:body>' + para('請代禱。') + para('請代禱。') + '</w:body>';
  assert.strictEqual(env.sandbox.docxScanDuplicateParagraphs_(xml, 3).length, 1);
});

test('同一句被 Word 拆成幾個 w:t 也對得上（比對前壓掉空白）', function () {
  const env = makeEnv({});
  const split = '<w:p><w:r><w:t>為斯里蘭卡短宣隊代禱，</w:t></w:r>'
    + '<w:r><w:t>求主保守隊員身心靈健壯，行程順利平安。</w:t></w:r></w:p>';
  const xml = '<w:body>' + split + para(LONG_A) + '</w:body>';
  const found = env.sandbox.docxScanDuplicateParagraphs_(xml, 25);
  assert.strictEqual(found.length, 1, '拆成幾個 w:t 的同一句要對得上');
  assert.strictEqual(found[0].count, 2);
});

test('buildDuplicateParagraphLines_：0 段回空陣列、有段就印內容不是只印數目', function () {
  const env = makeEnv({});
  assert.strictEqual(env.sandbox.buildDuplicateParagraphLines_([]).length, 0);

  const lines = Array.prototype.slice.call(
    env.sandbox.buildDuplicateParagraphLines_([{ text: LONG_A, count: 2 }]));
  const text = lines.join('\n');
  assert.ok(text.indexOf('偵測到 1 段') !== -1, text);
  assert.ok(text.indexOf(LONG_A.slice(0, 20)) !== -1, '要印出那一段的內容：' + text);
  assert.ok(text.indexOf('不會阻止產生') !== -1, '要講明只是提示：' + text);
});

// =====================================================================
// 第 5 組：R-032 內容份量估算
// =====================================================================

console.log('\n第 5 組：內容份量估算');

test('字數計算穩定：同一份輸入兩次結果相同', function () {
  const env = makeEnv({});
  const xml = '<w:body>' + para(LONG_A) + para(LONG_B) + '</w:body>';
  const a = env.sandbox.estimateDocxContentSize_([xml], 5600);
  const b = env.sandbox.estimateDocxContentSize_([xml], 5600);
  assert.strictEqual(a.chars, b.chars);
  assert.strictEqual(a.chars, (LONG_A + LONG_B).replace(/\s+/g, '').length);
});

test('文字方塊不會被數兩次', function () {
  const env = makeEnv({});
  const withBox = '<w:body><mc:AlternateContent><mc:Choice>' + para(LONG_A)
    + '</mc:Choice><mc:Fallback>' + para(LONG_A) + '</mc:Fallback></mc:AlternateContent></w:body>';
  assert.strictEqual(env.sandbox.estimateDocxContentSize_([withBox], 5600).chars, 0,
    '文字方塊整段挖走，所以是 0——不挖的話會數兩次而且不穩定');
});

test('未超過門檻 → overThreshold=false，訊息沒有「可能會排到第 5 頁」', function () {
  const env = makeEnv({});
  const size = env.sandbox.estimateDocxContentSize_(['<w:body>' + para(LONG_A) + '</w:body>'], 5600);
  assert.strictEqual(size.overThreshold, false);
  const text = Array.prototype.slice.call(env.sandbox.buildContentSizeLines_(size)).join('\n');
  assert.strictEqual(text.indexOf('可能會排到第 5 頁'), -1, text);
  assert.ok(text.indexOf('估算') !== -1, '一定要標明是估算：' + text);
});

test('超過門檻 → overThreshold=true，訊息有提示而且叫人用 Word 確認', function () {
  const env = makeEnv({});
  const size = env.sandbox.estimateDocxContentSize_(['<w:body>' + para(LONG_A) + '</w:body>'], 5);
  assert.strictEqual(size.overThreshold, true);
  const text = Array.prototype.slice.call(env.sandbox.buildContentSizeLines_(size)).join('\n');
  assert.ok(text.indexOf('可能會排到第 5 頁') !== -1, text);
  assert.ok(text.indexOf('估算') !== -1, '一定要標明是估算：' + text);
  assert.ok(text.indexOf('Word') !== -1, '要叫人用 Word 確認：' + text);
});

test('門檻不合法 → 退回 5600，不會變成 0（0 會令每一次都提示）', function () {
  const env = makeEnv({});
  assert.strictEqual(env.sandbox.estimateDocxContentSize_([], 0).warnChars, 5600);
  assert.strictEqual(env.sandbox.estimateDocxContentSize_([], -1).warnChars, 5600);
  assert.strictEqual(env.sandbox.estimateDocxContentSize_([], '亂寫').warnChars, 5600);
});

test('formatThousands_：加千位逗號', function () {
  const env = makeEnv({});
  assert.strictEqual(env.sandbox.formatThousands_(5600), '5,600');
  assert.strictEqual(env.sandbox.formatThousands_(123), '123');
  assert.strictEqual(env.sandbox.formatThousands_(1234567), '1,234,567');
});

test('assertDocxOutput_ 的空結果有 duplicateParagraphs 欄位（形狀要一致）', function () {
  // ⚠️ 呼叫方不應該要逐個欄位防禦。空結果與正常結果的形狀一定要一樣。
  const env = makeEnv({});
  const empty = env.sandbox.assertDocxOutputEmptyResult_('');
  assert.ok(Array.isArray(empty.duplicateParagraphs) || empty.duplicateParagraphs.length === 0,
    'duplicateParagraphs 一定要在，而且是陣列');
});

// =====================================================================

console.log('\n通過 ' + pass + ' 項，失敗 ' + fail + ' 項。');
process.exit(fail === 0 ? 0 : 1);
