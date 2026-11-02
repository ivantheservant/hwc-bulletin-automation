#!/usr/bin/env node
/**
 * tests/rostercache.test.js
 *
 * 2026-11-03（Ivan：「沒有風險、不影響讀到最新改動」就做職事表快取；要有一粒「重新載入」確保讀到最新）：
 *   - 只有網頁載入（apiBootstrap、apiLoadWeek、apiAutoImportWeek）用快取；其餘（觸發器、產生 Word、寄出）一律直接讀職事表；
 *   - 職事表修改時間一樣、十分鐘之內才用快取；改過、讀不到修改時間、記錄壞了 → 照舊讀職事表；
 *   - `fresh:true`（「重新載入（讀最新）」「重新讀取職事表」）→ 不用快取，讀完把快取換成最新；
 *   - 同一次載入之內同一張工作表只讀一次（withReadSheetMemo_），結果與不用時完全一樣，寫入之後立即作廢。
 *
 * 真正入口：apiLoadWeek、apiBootstrap、apiAutoImportWeek。
 *
 * 執行方式：node tests/rostercache.test.js
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const contentEnv = require('./helpers/contentEnv');

const D1 = contentEnv.SERVICE_DATES[0];
const ROSTER_ID = contentEnv.FAKE_ROSTER_ID;

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

/** 一張只有 A 欄的假工作表（快取用）。 */
function makeCacheSheet() {
  const cells = [];
  let maxRows = 1000;
  const sheet = {
    cells: cells,
    hidden: false,
    hideSheet: function () { sheet.hidden = true; },
    getLastRow: function () { return cells.length; },
    getMaxRows: function () { return maxRows; },
    insertRowsAfter: function (after, n) { maxRows += n; },
    clearContents: function () { cells.length = 0; },
    getRange: function (r, c, n) {
      return {
        getValues: function () {
          const out = [];
          for (let i = 0; i < n; i++) out.push([cells[r - 1 + i] === undefined ? '' : cells[r - 1 + i]]);
          return out;
        },
        setValues: function (rows) { rows.forEach(function (row, i) { cells[r - 1 + i] = row[0]; }); },
        setNumberFormat: function () {}
      };
    }
  };
  return sheet;
}

/** 環境：記住打開職事表的次數；職事表修改時間由測試控制；快取工作表存在記憶體。 */
function makeCacheEnv() {
  const env = contentEnv.makeEnv({});
  const sb = env.sandbox;
  const mtimes = {};
  mtimes[ROSTER_ID] = Date.UTC(2027, 0, 1);
  mtimes[contentEnv.FAKE_CONTENT_FILE_ID] = Date.UTC(2027, 0, 1);
  const props = {};
  sb.PropertiesService = { getScriptProperties: function () {
    return { getProperty: function (k) { return props[k] === undefined ? null : props[k]; }, setProperty: function (k, v) { props[k] = String(v); },
      deleteProperty: function (k) { delete props[k]; } };
  } };
  sb.DriveApp.getFileById = function (id) {
    return { getLastUpdated: function () {
      if (mtimes[id] === 'THROW') throw new Error('Drive 暫時出錯');
      return mtimes[id] === undefined ? null : vm.runInContext('new Date(' + mtimes[id] + ')', sb);
    } };
  };
  const opened = { roster: 0 };
  const realOpen = sb.SpreadsheetApp.openById;
  sb.SpreadsheetApp.openById = function (id) {
    if (id === ROSTER_ID) opened.roster++;
    return realOpen.apply(this, arguments);
  };
  const cache = { sheet: null };
  const realActive = sb.SpreadsheetApp.getActiveSpreadsheet;
  sb.SpreadsheetApp.getActiveSpreadsheet = function () {
    const ss = realActive.apply(this, arguments);
    return new Proxy(ss, {
      get: function (target, prop) {
        if (prop === 'getSheetByName') {
          return function (name) { return name === sb.ROSTER_CACHE_SHEET_NAME_ ? cache.sheet : target.getSheetByName(name); };
        }
        if (prop === 'insertSheet') {
          return function (name) {
            if (name !== sb.ROSTER_CACHE_SHEET_NAME_) return target.insertSheet(name);
            cache.sheet = makeCacheSheet();
            return cache.sheet;
          };
        }
        const v = target[prop];
        return typeof v === 'function' ? v.bind(target) : v;
      }
    });
  };
  /** 模擬新的一次執行（Apps Script 每次呼叫都由零開始）。 */
  function newExecution() { sb.ROSTER_TABLES_CACHE_ = null; sb.ROSTER_TABLES_CACHE_KEY_ = null; }
  return { env: env, sb: sb, mtimes: mtimes, opened: opened, cache: cache, newExecution: newExecution };
}

function loadWeek(t, options) {
  t.newExecution();
  const resp = t.sb.apiLoadWeek(D1, Object.assign({ deferImport: true }, options || {}));
  assert.strictEqual(resp.ok, true, JSON.stringify(resp.error));
  const data = plain(resp.data);
  delete data.timings;
  return data;
}

console.log('\n職事表快取與同一次載入只讀一次（真入口）');

test('RC-1 文字化與還原：日期還原成（沙盒裏的）Date，其餘不變', function () {
  const t = makeCacheEnv();
  const original = vm.runInContext('({ tables: { A: [{ d: new Date(Date.UTC(2027,0,3)), n: 1, s: "x", b: true, z: null }] }, extra: [1, "2"] })', t.sb);
  const back = t.sb.parseRosterTables_(t.sb.serializeRosterTables_(original));
  assert.ok(back.tables.A[0].d instanceof vm.runInContext('Date', t.sb), '要是沙盒的 Date');
  assert.strictEqual(back.tables.A[0].d.getTime(), Date.UTC(2027, 0, 3));
  assert.deepStrictEqual(plain(back), plain(original));
});

test('RC-2 職事表沒有改過：第二次載入不打開職事表，內容與第一次完全一樣', function () {
  const t = makeCacheEnv();
  const first = loadWeek(t);
  assert.strictEqual(t.opened.roster, 1);
  assert.ok(t.cache.sheet && t.cache.sheet.cells.length >= 2, '存了快取');
  assert.strictEqual(t.cache.sheet.hidden, true, '快取工作表要隱藏');
  t.cache.sheet.cells.forEach(function (c) { assert.ok(/^R/.test(c), '每格以 R 開頭（不會被當成公式）'); });
  const second = loadWeek(t);
  assert.strictEqual(t.opened.roster, 1, '用了快取');
  assert.deepStrictEqual(second, first);
});

test('RC-3 職事表改過（修改時間變了）→ 重新打開職事表，並換上新的快取', function () {
  const t = makeCacheEnv();
  loadWeek(t);
  t.mtimes[ROSTER_ID] += 1000;
  loadWeek(t);
  assert.strictEqual(t.opened.roster, 2);
  loadWeek(t);
  assert.strictEqual(t.opened.roster, 2, '新的快取可以用');
});

test('RC-4 fresh:true（重新載入／重新讀取職事表）→ 一定打開職事表；之後普通載入用剛換的快取', function () {
  const t = makeCacheEnv();
  loadWeek(t);
  loadWeek(t, { fresh: true });
  assert.strictEqual(t.opened.roster, 2);
  t.newExecution();
  const r = t.sb.apiLoadWeek(D1, { fresh: true });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(t.opened.roster, 3, '「重新讀取職事表」（沒有 deferImport）亦一樣');
  loadWeek(t);
  assert.strictEqual(t.opened.roster, 3);
});

test('RC-5 存了超過十分鐘 → 不用', function () {
  const t = makeCacheEnv();
  loadWeek(t);
  const meta = JSON.parse(t.cache.sheet.cells[0].slice(1));
  meta.savedAt -= 11 * 60 * 1000;
  t.cache.sheet.cells[0] = 'R' + JSON.stringify(meta);
  loadWeek(t);
  assert.strictEqual(t.opened.roster, 2);
});

test('RC-6 快取壞了（少了一段、版本不同）→ 照舊讀職事表，不出錯', function () {
  const t = makeCacheEnv();
  loadWeek(t);
  t.cache.sheet.cells[1] = t.cache.sheet.cells[1].slice(0, 10);
  const a = loadWeek(t);
  assert.strictEqual(t.opened.roster, 2);
  const meta = JSON.parse(t.cache.sheet.cells[0].slice(1));
  meta.key = 'OLD|' + meta.key;
  t.cache.sheet.cells[0] = 'R' + JSON.stringify(meta);
  const b = loadWeek(t);
  assert.strictEqual(t.opened.roster, 3);
  assert.deepStrictEqual(b, a);
  t.cache.sheet.cells[0] = 'R{not json';
  loadWeek(t);
  assert.strictEqual(t.opened.roster, 4);
});

test('RC-7 讀不到職事表修改時間（沒有值、Drive 出錯）→ 每次都讀職事表，不存快取', function () {
  const t = makeCacheEnv();
  t.mtimes[ROSTER_ID] = 'THROW';
  loadWeek(t);
  loadWeek(t);
  assert.strictEqual(t.opened.roster, 2);
  assert.strictEqual(t.cache.sheet, null, '不存');
  delete t.mtimes[ROSTER_ID];
  loadWeek(t);
  assert.strictEqual(t.opened.roster, 3);
  assert.strictEqual(t.cache.sheet, null);
});

test('RC-8 網頁載入以外（預設 OFF）一律直接讀職事表，不讀、不存快取；載入完之後模式還原為 OFF', function () {
  const t = makeCacheEnv();
  loadWeek(t);
  assert.strictEqual(t.sb.ROSTER_CACHE_MODE_, 'OFF', 'api 之後還原');
  const before = t.cache.sheet.cells.slice();
  t.newExecution();
  t.sb.fetchRosterTablesCached_(ROSTER_ID, t.sb.buildRosterSheetNames_());
  assert.strictEqual(t.opened.roster, 2, 'OFF：打開職事表');
  assert.deepStrictEqual(t.cache.sheet.cells, before, 'OFF：不改快取');
  // 出錯亦要還原
  assert.throws(function () { t.sb.withRosterCacheMode_('USE', function () { throw new Error('x'); }); });
  assert.strictEqual(t.sb.ROSTER_CACHE_MODE_, 'OFF');
});

test('RC-9 apiBootstrap、apiAutoImportWeek 亦用快取；apiAutoImportWeek fresh:true 不理「沒有改過」的記錄', function () {
  const t = makeCacheEnv();
  t.newExecution();
  const b = t.sb.apiBootstrap(false, {});
  assert.strictEqual(b.ok, true, JSON.stringify(b.error));
  const afterBoot = t.opened.roster;
  loadWeek(t);
  assert.strictEqual(t.opened.roster, afterBoot, '開頁之後換週用快取');
  t.newExecution();
  t.sb.apiAutoImportWeek(D1);
  t.newExecution();
  const again = t.sb.apiAutoImportWeek(D1);
  assert.strictEqual(again.data.autoImport.reason, 'UNCHANGED', JSON.stringify(again.data.autoImport));
  t.newExecution();
  const fresh = t.sb.apiAutoImportWeek(D1, { fresh: true });
  assert.strictEqual(fresh.ok, true, JSON.stringify(fresh.error));
  assert.notStrictEqual(fresh.data.autoImport.reason, 'UNCHANGED', '讀最新要照樣核對內容表');
});

test('RC-10 同一次載入只讀一次：結果與不用時一樣；拿到的是拷貝；寫入之後、範圍之外一律讀最新', function () {
  const t = makeCacheEnv();
  const sb = t.sb;
  const direct = plain(sb.readSheet_('BulletinWeeks'));
  let count = 0;
  const realUncached = sb.readSheetUncached_;
  sb.readSheetUncached_ = function () { count++; return realUncached.apply(this, arguments); };
  sb.withReadSheetMemo_(function () {
    const a = sb.readSheet_('BulletinWeeks');
    assert.deepStrictEqual(plain(a), direct);
    a[0].NOTE_CHANGED_BY_CALLER = 'x';
    const b = sb.readSheet_('BulletinWeeks');
    assert.strictEqual(b[0].NOTE_CHANGED_BY_CALLER, undefined, '每次回一份新的拷貝');
    assert.strictEqual(count, 1, '只讀一次');
    // 範圍之內寫入 → 作廢
    sb.writeBulletinWeekField_(D1, 'LAST_SAVED_AT', vm.runInContext('new Date(Date.UTC(2027, 8, 30, 1, 2, 3))', sb));
    const c = sb.readSheet_('BulletinWeeks');
    assert.ok(count >= 2, '寫入之後重新讀');
    assert.deepStrictEqual(plain(c), plain(realUncached('BulletinWeeks', sb.SHEET_ID_BY_NAME.BulletinWeeks)), '寫入之後是新的內容');
    assert.notDeepStrictEqual(plain(c), direct, '確實改了');
    // 巢狀：不會提早清走
    sb.withReadSheetMemo_(function () { sb.readSheet_('BulletinWeeks'); });
    const n = count;
    sb.readSheet_('BulletinWeeks');
    assert.strictEqual(count, n, '巢狀之後仍然在範圍之內');
  });
  assert.strictEqual(sb.READ_SHEET_MEMO_, null, '範圍之外清走');
  const n2 = count;
  sb.readSheet_('BulletinWeeks');
  sb.readSheet_('BulletinWeeks');
  assert.strictEqual(count, n2 + 2, '範圍之外每次都讀');
});

test('RC-11 apiLoadWeek 的內容與直接叫 loadWeekForWebApp_（不用只讀一次、不用快取）完全一樣', function () {
  const t = makeCacheEnv();
  t.newExecution();
  const direct = plain(t.sb.loadWeekForWebApp_(D1));
  delete direct.timings;
  const viaApi = loadWeek(t);
  delete viaApi.autoImport;
  assert.deepStrictEqual(viaApi, direct);
  const viaCache = loadWeek(t);
  delete viaCache.autoImport;
  assert.deepStrictEqual(viaCache, direct);
});

test('RC-12 介面：有「重新載入（讀最新）」按鈕（送 fresh）；「重新讀取職事表」送 fresh；按「伺服器用時」看分段；處理中停用', function () {
  const root = path.join(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'src/ui/Index.html'), 'utf8');
  const js = fs.readFileSync(path.join(root, 'src/ui/Script.html'), 'utf8');
  assert.ok(/id="freshReloadBtn"[\s\S]*?重新載入（讀最新）/.test(html));
  assert.ok(/loadWeek\(iso, \{ fresh: true \}\)/.test(js));
  assert.ok(/\{ deferImport: true, fresh: true \}/.test(js));
  assert.ok(/'apiAutoImportWeek', fresh === true \? \[isoDate, \{ fresh: true \}\]/.test(js));
  assert.ok(/callServer\('apiLoadWeek', \[state\.isoDate, \{ fresh: true \}\], onRosterReloaded/.test(js));
  assert.ok(/'freshReloadBtn'/.test(js.slice(js.indexOf('function applyBusyState'), js.indexOf('function applyBusyState') + 4000)));
  assert.ok(/getElementById\('statLoadTime'\)\.addEventListener\('click'/.test(js));
});

test('RC-13 唯讀邊界：RosterCache.gs 沒有 openById、沒有 DriveApp、沒有職事表 ID', function () {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/RosterCache.gs'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.ok(!/openById/.test(src));
  assert.ok(!/DriveApp/.test(src));
  assert.ok(!/ROSTER_SPREADSHEET_ID/.test(src));
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
if (fail > 0) process.exit(1);
