#!/usr/bin/env node
/**
 * tests/loadspeed.test.js
 *
 * 2026-11-03（Ivan：載入慢，現在就改善）：
 *   - apiBootstrap：開頁只叫一次伺服器（主日清單、發佈狀態、預設主日），內容表匯入不在這裏做；回應帶分段計時；
 *   - apiAutoImportWeek：畫面顯示之後在背景匯入；內容表（連上一季）與這一週最後儲存時間都沒有變就不打開內容表；
 *     有改動時用剛算好的預覽寫入（只打開內容表一次）；只可以看的用戶不寫；
 *   - Word 範本事奉格數按範本的修改時間記住，範本沒有改就不再下載。
 * 前端鎖按鈕的測試在 tests/writeaction.test.js（LS-UI-*）。
 *
 * 真正入口：apiBootstrap、apiAutoImportWeek、apiLoadWeek、apiSaveWeek。
 *
 * 執行方式：node tests/loadspeed.test.js
 */

'use strict';

const assert = require('assert');
const vm = require('vm');
const contentEnv = require('./helpers/contentEnv');

const QUARTER_ID = contentEnv.QUARTER_ID;
const DATES = contentEnv.SERVICE_DATES;
const D1 = DATES[0];

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
    console.log('    ' + (err && err.stack ? err.stack.split('\n').slice(0, 6).join('\n    ') : err));
  }
}
function plain(v) { return JSON.parse(JSON.stringify(v)); }

function weekOf(env, iso) {
  return env.sandbox.readSheet_('BulletinWeeks').filter(function (r) { return env.sandbox.formatIsoDate_(r.SERVICE_DATE) === iso; })[0];
}

/** 內容表有一條家事報告（D1）；記住打開內容表的次數；檔案修改時間由測試控制。 */
function makeSpeedEnv(extra) {
  const env = contentEnv.makeEnv(Object.assign({
    content: { 家事報告: [{ SERVICE_DATE: D1, SEQ_NO: '10', TEXT: '本週家事', ACTIVE: 'TRUE' }] }
  }, extra || {}));
  const sb = env.sandbox;
  const mtimes = { FAKE_CONTENT_FILE: Date.UTC(2027, 0, 1) };
  // ⚠️ 日期物件要在沙盒裏面造（src 用 instanceof Date 核對，外面造的 Date 是另一個 realm 的）。
  sb.DriveApp.getFileById = function (id) {
    return { getLastUpdated: function () { return mtimes[id] === undefined ? null : vm.runInContext('new Date(' + mtimes[id] + ')', sb); } };
  };
  const props = {};
  sb.PropertiesService = { getScriptProperties: function () {
    return { getProperty: function (k) { return props[k] === undefined ? null : props[k]; }, setProperty: function (k, v) { props[k] = String(v); },
      deleteProperty: function (k) { delete props[k]; } };
  } };
  const realOpen = sb.SpreadsheetApp.openById;
  const opened = { content: 0 };
  sb.SpreadsheetApp.openById = function (id) {
    if (id === 'FAKE_CONTENT_FILE') opened.content++;
    return realOpen.apply(this, arguments);
  };
  return { env: env, sb: sb, mtimes: mtimes, opened: opened, props: props };
}

function announcementsOf(env, iso) {
  return env.sandbox.readSheet_('Announcements').filter(function (a) {
    return env.sandbox.formatIsoDate_(a.SERVICE_DATE) === iso && String(a.ACTIVE).toUpperCase() !== 'FALSE';
  });
}

console.log('\n載入速度（真入口）');

test('LS-1 apiBootstrap：一次回主日清單、發佈狀態、預設主日；內容表不打開、不匯入（DEFERRED）；帶分段計時', function () {
  const t = makeSpeedEnv({ config: { WEBAPP_SIMULATED_TODAY: '2027-10-01' } });
  const resp = t.sb.apiBootstrap(false, {});
  assert.strictEqual(resp.ok, true, JSON.stringify(resp.error));
  const data = resp.data;
  assert.ok(Array.isArray(data.weeks.quarters) || data.weeks.defaultIsoDate, '主日清單');
  assert.strictEqual(data.weeks.defaultIsoDate, D1);
  assert.ok(data.week, '預設主日已經載入：' + JSON.stringify(data.weekError));
  assert.strictEqual(data.week.isoDate, D1);
  assert.strictEqual(data.week.autoImport.reason, 'DEFERRED');
  // 內容表狀態列（版面是不是最新）第一次要打開一次；之後按修改時間記住（見 LS-9）。
  assert.ok(t.opened.content <= 1, '開頁那一次不匯入：' + t.opened.content);
  assert.strictEqual(announcementsOf(t.env, D1).length, 0, '未匯入');
  assert.strictEqual(data.timings.name, 'apiBootstrap');
  const labels = data.timings.parts.map(function (p) { return p.label; });
  ['主日清單', '發佈狀態', '職事表與資料模型', '週報與清單', 'Word 範本格數', '內容表狀態'].forEach(function (l) {
    assert.ok(labels.indexOf(l) !== -1, '分段缺少：' + l + '（' + labels.join('、') + '）');
  });
  assert.ok(typeof data.timings.totalMs === 'number' && data.timings.totalMs >= 0);
  assert.ok(data.publish || data.publishError !== undefined, '發佈狀態（或者錯誤訊息）');
});

test('LS-2 apiAutoImportWeek：第一次打開內容表並匯入，回這一週的新資料；再叫一次（內容表、上一季、這一週都沒有變）→ UNCHANGED，不打開內容表', function () {
  const t = makeSpeedEnv();
  const first = t.sb.apiAutoImportWeek(D1);
  assert.strictEqual(first.ok, true, JSON.stringify(first.error));
  assert.ok(first.data.autoImport.changed > 0, JSON.stringify(first.data.autoImport));
  assert.ok(first.data.week, '有改動要回新資料');
  assert.ok(first.data.week.lists.announcements.some(function (a) { return a.TEXT === '本週家事'; }));
  // 匯入一次（寫入用剛算好的預覽，不再打開）＋內容表狀態列第一次一次。
  assert.strictEqual(t.opened.content, 2, '有改動：匯入只打開內容表一次');
  const second = t.sb.apiAutoImportWeek(D1);
  assert.strictEqual(second.data.autoImport.reason, 'UNCHANGED', JSON.stringify(second.data.autoImport));
  assert.strictEqual(second.data.week, null);
  assert.strictEqual(t.opened.content, 2, '沒有改動不打開內容表');
  const labels = second.data.timings.parts.map(function (p) { return p.label; });
  assert.ok(labels.indexOf('內容表修改時間') !== -1, labels.join('、'));
});

test('LS-3 內容表改了（修改時間變了）→ 照樣打開比較；這一週儲存過（最後儲存時間變了）→ 亦照樣比較', function () {
  const t = makeSpeedEnv();
  t.sb.apiAutoImportWeek(D1);
  t.sb.apiAutoImportWeek(D1);
  const base = t.opened.content;
  t.mtimes.FAKE_CONTENT_FILE += 60000;
  const afterEdit = t.sb.apiAutoImportWeek(D1);
  assert.strictEqual(afterEdit.data.autoImport.reason, '', JSON.stringify(afterEdit.data.autoImport));
  assert.strictEqual(t.opened.content, base + 1, '內容表改了要打開');
  assert.strictEqual(t.sb.apiAutoImportWeek(D1).data.autoImport.reason, 'UNCHANGED');
  // 這一週的最後儲存時間變了（儲存、重設、還原版本都會改）。
  t.sb.writeBulletinWeekField_(D1, 'LAST_SAVED_AT', vm.runInContext('new Date(Date.UTC(2027, 8, 30, 1, 2, 3))', t.sb));
  assert.strictEqual(t.sb.apiAutoImportWeek(D1).data.autoImport.reason, '');
  assert.strictEqual(t.opened.content, base + 2, '這一週改過要再比較');
});

test('LS-4 修改時間讀不到（Drive 出錯）→ 不可以略過，照樣打開內容表', function () {
  const t = makeSpeedEnv();
  t.sb.DriveApp.getFileById = function () { throw new Error('Drive 暫時出錯'); };
  t.sb.apiAutoImportWeek(D1);
  const base = t.opened.content;
  t.sb.apiAutoImportWeek(D1);
  assert.strictEqual(t.opened.content, base + 1, '每次都要打開內容表比較');
});

test('LS-5 持續狀況的提示（例如「崇拜人數」未有合堂三欄）在 UNCHANGED 時照樣講出來', function () {
  const t = makeSpeedEnv({ attendanceLayout: 'rowsLegacy' });
  const first = t.sb.apiAutoImportWeek(D1);
  assert.ok((first.data.autoImport.notices || []).some(function (n) { return n.indexOf('未有合堂三欄') !== -1; }), JSON.stringify(first.data.autoImport));
  const second = t.sb.apiAutoImportWeek(D1);
  assert.strictEqual(second.data.autoImport.reason, 'UNCHANGED');
  assert.ok((second.data.autoImport.notices || []).some(function (n) { return n.indexOf('未有合堂三欄') !== -1; }), '提示不可以靜靜消失');
});

test('LS-6 只可以看的用戶：apiAutoImportWeek 不寫（VIEW_ONLY）、不打開內容表；apiBootstrap 照樣可以用', function () {
  const t = makeSpeedEnv({ config: { WEBAPP_ALLOWED_EMAILS: 'editor@x.com', WEBAPP_VIEWER_EMAILS: 'viewer@x.com' } });
  t.sb.Session.getActiveUser = function () { return { getEmail: function () { return 'viewer@x.com'; } }; };
  const imp = t.sb.apiAutoImportWeek(D1);
  assert.strictEqual(imp.ok, true, JSON.stringify(imp.error));
  assert.strictEqual(imp.data.autoImport.reason, 'VIEW_ONLY');
  assert.strictEqual(t.opened.content, 0);
  assert.strictEqual(announcementsOf(t.env, D1).length, 0);
  const boot = t.sb.apiBootstrap(false, { autoCreate: true });
  assert.strictEqual(boot.ok, true, JSON.stringify(boot.error));
  assert.strictEqual(boot.data.week.autoImport.reason, 'VIEW_ONLY');
});

test('LS-7 apiLoadWeek 不傳 options＝舊做法（先匯入再載入）；傳 deferImport 就不匯入', function () {
  const t = makeSpeedEnv();
  const deferred = t.sb.apiLoadWeek(D1, { deferImport: true });
  assert.strictEqual(deferred.data.autoImport.reason, 'DEFERRED');
  assert.strictEqual(announcementsOf(t.env, D1).length, 0, 'deferImport 不匯入');
  const old = t.sb.apiLoadWeek(D1);
  assert.ok(old.data.autoImport.changed > 0, JSON.stringify(old.data.autoImport));
  assert.ok(old.data.timings && old.data.timings.parts.length > 0);
});

test('LS-8 Word 範本事奉格數：範本沒有改就用記下的格數（不再下載）；範本改了（修改時間變了）就重新讀', function () {
  const t = makeSpeedEnv();
  const sb = t.sb;
  t.mtimes.TPL_X = Date.UTC(2027, 0, 1);
  let downloads = 0;
  const slots = { page1: ['01', '02'], next: ['01'] };
  sb.readTemplateDutySlots_ = function () { downloads++; return slots; };
  assert.deepStrictEqual(plain(sb.readTemplateDutySlotsCached_('TPL_X')), plain(slots));
  assert.deepStrictEqual(plain(sb.readTemplateDutySlotsCached_('TPL_X')), plain(slots));
  assert.strictEqual(downloads, 1, '範本沒有改，不再下載');
  t.mtimes.TPL_X += 1000;
  sb.readTemplateDutySlotsCached_('TPL_X');
  assert.strictEqual(downloads, 2, '範本改了要重新讀');
  // 修改時間讀不到：每次都讀範本本身。
  sb.readTemplateDutySlotsCached_('TPL_UNKNOWN');
  sb.readTemplateDutySlotsCached_('TPL_UNKNOWN');
  assert.strictEqual(downloads, 4);
});

test('LS-9 內容表狀態列（版面是不是最新）：內容表沒有改過就不再打開；改了就重新檢查', function () {
  const t = makeSpeedEnv();
  t.sb.apiLoadWeek(D1, { deferImport: true });
  const base = t.opened.content;
  t.sb.apiLoadWeek(D1, { deferImport: true });
  assert.strictEqual(t.opened.content, base, '沒有改過不打開');
  t.mtimes.FAKE_CONTENT_FILE += 5000;
  t.sb.apiLoadWeek(D1, { deferImport: true });
  assert.strictEqual(t.opened.content, base + 1, '改了要重新檢查');
});

test('LS-10 獨立審查：預覽與寫入之間有人改了內容表 → 下一次不可以當作 UNCHANGED（記下的是預覽之前的指紋）', function () {
  const t = makeSpeedEnv();
  const sb = t.sb;
  const realWrite = sb.writeContentImportPlan_;
  let edited = false;
  sb.writeContentImportPlan_ = function () {
    realWrite.apply(this, arguments);
    if (edited) return;
    edited = true;
    const tab = t.env.contentTabs['家事報告'];
    tab.__data[2][tab.__data[1].indexOf('TEXT')] = '改過的家事';
    t.mtimes.FAKE_CONTENT_FILE += 60000;
  };
  assert.ok(sb.apiAutoImportWeek(D1).data.autoImport.changed > 0);
  const second = sb.apiAutoImportWeek(D1);
  assert.notStrictEqual(second.data.autoImport.reason, 'UNCHANGED', JSON.stringify(second.data.autoImport));
  assert.ok(announcementsOf(t.env, D1).some(function (a) { return a.TEXT === '改過的家事'; }), '改動要匯入');
});

test('LS-11 獨立審查：記錄三十分鐘之後過期（人手直接改週報試算表時，最多三十分鐘內再比較一次）', function () {
  const t = makeSpeedEnv();
  t.sb.apiAutoImportWeek(D1);
  assert.strictEqual(t.sb.apiAutoImportWeek(D1).data.autoImport.reason, 'UNCHANGED');
  Object.keys(t.props).forEach(function (k) {
    if (k.indexOf('CS_WEEK_IMPORT_') !== 0) return;
    const rec = JSON.parse(t.props[k]);
    rec.at -= 31 * 60 * 1000;
    t.props[k] = JSON.stringify(rec);
  });
  assert.strictEqual(t.sb.apiAutoImportWeek(D1).data.autoImport.reason, '', '過期之後照樣比較');
});

test('LS-12 獨立審查：Script.html、Style.html 一個「<?」都不可以有（include() 經樣板引擎，註解亦會被讀）', function () {
  const fs = require('fs');
  const path = require('path');
  ['Script.html', 'Style.html'].forEach(function (f) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', f), 'utf8');
    assert.strictEqual(src.indexOf('<?'), -1, f + ' 有「<?」');
  });
  const index = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'Index.html'), 'utf8');
  (index.match(/<!--[\s\S]*?-->/g) || []).forEach(function (c) { assert.strictEqual(c.indexOf('<?'), -1, '註解內有樣板標籤：' + c); });
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
