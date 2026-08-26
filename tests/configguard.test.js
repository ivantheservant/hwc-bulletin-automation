#!/usr/bin/env node
/**
 * tests/configguard.test.js
 *
 * `Config` 的 `PUBLISHED_PDF_FILE_ID` 被換成沙盒檔案那一次的查因與防護
 * （docs/已知bug類型.md 事故四十三、docs/待確認事項.md X 節）。
 *
 * ⚠️ 這一組最重要的是**第 1 組**：它鎖住那個成因本身。
 * 舊做法是「暫時把沙盒 ID 寫入 Config 的 `PUBLISHED_PDF_FILE_ID`，跑完用
 * `finally` 還原」。`finally` 救不到 Apps Script 的**硬中斷**（六分鐘上限、
 * 撳停、配額用盡），於是沙盒 ID 就永遠留在正式那一格。
 *
 * Node 測試造不出「硬中斷」，所以第 1 組改為驗一件**同樣決定性**的事：
 * 跑完整條發佈流程之後，**Config 那一格由頭到尾一個字都沒有變**——
 * 連中途拋錯那一條路都一樣。沒有寫過，就沒有「還原不到」這回事。
 *
 * 執行方式：node tests/configguard.test.js
 * 離開碼：0＝全部通過　1＝有測試失敗
 */

'use strict';

const assert = require('assert');
const vm = require('vm');
const { loadAllSrcFilesInOrder } = require('./helpers/loadGas');
const { makeFakeSheet, makeFakeSpreadsheet } = require('./helpers/fakeSpreadsheet');

/** 兩個**假**檔案 ID。刻意用一望而知是假的字串，不放真實 ID 進 repo。 */
const FAKE_PUBLISHED_ID = 'FAKE_PUBLISHED_MASTER_FILE_ID_0001';
const FAKE_SELFTEST_ID = 'FAKE_SELFTEST_MASTER_FILE_ID_0002';
const FAKE_ROSTER_ID = 'FAKE_ROSTER_ID_FOR_CONFIG_GUARD';

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
      }
    },
    Session: {
      getScriptTimeZone: function () { return 'Pacific/Auckland'; },
      getActiveUser: function () { return { getEmail: function () { return 'tester@example.com'; } }; }
    },
    CacheService: {},
    HtmlService: {},
    LockService: {
      getScriptLock: function () {
        return { tryLock: function () { return true; }, releaseLock: function () {} };
      }
    },
    // ⚠️ runSelfCheck_ 會逐一試探這幾個服務叫不叫得動（「檢查授權範圍」
    //    那一項）。不 stub 的話整支會拋 ReferenceError，而那與這一組要驗的
    //    東西完全無關。
    ScriptApp: {
      getProjectTriggers: function () { return []; },
      newTrigger: function () { throw new Error('這一組測試不應該建立觸發器'); }
    },
    MailApp: { getRemainingDailyQuota: function () { return 100; } },
    DriveApp: { getRootFolder: function () { return { getName: function () { return 'root'; } }; } },
    Drive: null
  };
}

const boot = loadAllSrcFilesInOrder(baseStubs());

function makeEnv(options) {
  const o = options || {};

  const cfg = {};
  boot.DEFAULTS.forEach(function (d) { cfg[d.key] = d.value; });
  cfg.ROSTER_SPREADSHEET_ID = FAKE_ROSTER_ID;
  cfg.PUBLISHED_PDF_FILE_ID = FAKE_PUBLISHED_ID;
  cfg.SELFTEST_MASTER_PDF_FILE_ID = FAKE_SELFTEST_ID;
  Object.assign(cfg, o.config || {});

  const sheets = {};
  Object.keys(boot.SHEETS).forEach(function (id) {
    const def = boot.COLUMNS[id];
    sheets[boot.SHEETS[id]] = makeFakeSheet(def.headers, def.keys, []);
  });
  sheets.Config = makeFakeSheet(boot.COLUMNS.CONFIG.headers, boot.COLUMNS.CONFIG.keys,
    Object.keys(cfg).map(function (k) { return { KEY: k, VALUE: cfg[k], NOTE: '', EDITABLE: true }; }));

  // ⚠️ 假分頁一定要有名：onEdit 的派發靠 sheet.getName() 分辨是 Config
  //    還是 Fill_*，沒有名的話兩條路都行不到，測試會綠得毫無意義。
  Object.keys(sheets).forEach(function (name) { sheets[name].setName(name); });

  const sandbox = loadAllSrcFilesInOrder(Object.assign({}, baseStubs(), {
    SpreadsheetApp: {
      getActiveSpreadsheet: function () { return makeFakeSpreadsheet(sheets); },
      openById: function () { throw new Error('這一組測試不連職事表'); },
      ProtectionType: { SHEET: 'SHEET' },
      getUi: function () { throw new Error('這一組測試不應該用到 UI'); }
    }
  }));

  // ⚠️ 造測試資料用的 Date 一定要在 sandbox 那個 realm 裏造：vm context 有
  //    自己一套內建物件，在測試這一邊 new Date() 造的物件過不到
  //    readSheet() 的正規化。
  vm.runInContext('function __mkDate(y, m, d, hh, mi, ss) { return new Date(y, m, d, hh, mi, ss); }', sandbox);

  // PublishLog 一定要喺 sandbox 造好之後先寫，原因同上。
  (o.publishRowSpecs || []).forEach(function (spec) {
    const at = spec.at || [2027, 10, 7, 10, 0, 0];
    sandbox.writeSheet(sandbox.SHEETS.PUBLISH_LOG, [{
      SERVICE_DATE: spec.isoDate,
      VERSION_NO: 1,
      PUBLISHED_AT: sandbox.__mkDate(at[0], at[1], at[2], at[3], at[4], at[5]),
      PUBLISHED_BY: 'tester',
      MASTER_FILE_ID: spec.masterFileId,
      IS_SELFTEST: spec.isSelfTest === true
    }]);
  });

  return { sandbox: sandbox, sheets: sheets };
}

/**
 * 造一個 Apps Script `onEdit` 事件物件。
 *
 * ⚠️ 只造 `auditManualConfigEdit_()` 真正用到的那幾個方法。假替身要**貼住
 * 真 API 的形狀**：`getRow()`／`getColumn()` 是範圍左上角，
 * `getNumRows()`／`getNumColumns()` 是大小，`oldValue` 只在單一格時才有。
 */
function editEvent(sheet, row, col, numRows, numCols, oldValue) {
  var e = {
    range: {
      getSheet: function () { return sheet; },
      getRow: function () { return row; },
      getColumn: function () { return col; },
      getNumRows: function () { return numRows; },
      getNumColumns: function () { return numCols; }
    }
  };
  if (oldValue !== undefined) e.oldValue = oldValue;
  return e;
}

/** 直接由工作表讀那一格，不經 getConfig 的快取。 */
function readConfigCell(env, key) {
  const rows = env.sandbox.readSheet(env.sandbox.SHEETS.CONFIG);
  const found = rows.filter(function (r) { return String(r.KEY) === key; })[0];
  return found ? String(found.VALUE) : null;
}

function auditRows(env, action) {
  return env.sandbox.readSheet(env.sandbox.SHEETS.AUDIT_LOG)
    .filter(function (r) { return String(r.ACTION) === action; });
}

// =====================================================================
// 第 1 組：成因本身——自測機的發佈不可以碰 Config
// =====================================================================

console.log('\n第 1 組：自測機的發佈不可以碰 Config（成因）');

test('selfTestRunPublish_ 跑完，Config 那一格一個字都沒有變', function () {
  const env = makeEnv({});
  const before = readConfigCell(env, 'PUBLISHED_PDF_FILE_ID');
  assert.strictEqual(before, FAKE_PUBLISHED_ID, '前提：Config 是正式那一個');

  // runPublishFlow_ 在這個環境會因為沒有 PDF 而乾淨地拒絕——那正好，
  // 我們要驗的是「有沒有碰 Config」，不是發佈本身成不成功。
  env.sandbox.selfTestRunPublish_({ masterFileId: FAKE_SELFTEST_ID },
    { isoDate: '2030-01-06', doPublish: true, doSend: false });

  assert.strictEqual(readConfigCell(env, 'PUBLISHED_PDF_FILE_ID'), FAKE_PUBLISHED_ID,
    'Config 那一格不可以被碰過');
});

test('整條發佈流程期間，Config 工作表一次 setValue 都沒有發生', function () {
  // ⚠️ 這一條才是真正分得出新舊做法的那一條。
  //    舊做法（寫 Config ＋ finally 還原）跑完之後 Config 的**最終值**是
  //    對的，所以「跑完再比一次」根本驗不出分別——正常結束時它本來就會
  //    還原。真正的分別在於**中途有沒有寫過**：寫過，就有一個「寫完之後、
  //    還原之前」的窗口，執行在那一刻被硬中斷（六分鐘上限、撳停、配額）
  //    就會把沙盒 ID 永遠留在正式那一格。
  //
  //    Node 造不出硬中斷，但造得出「有沒有寫過」這個更強的斷言。
  const env = makeEnv({});
  const configSheet = env.sheets.Config;

  const writes = [];
  const realGetRange = configSheet.getRange;
  configSheet.getRange = function (r, c, nr, nc) {
    const range = realGetRange.call(configSheet, r, c, nr, nc);
    const realSetValue = range.setValue;
    range.setValue = function (v) {
      writes.push({ row: r, col: c, value: String(v) });
      return realSetValue.call(range, v);
    };
    const realSetValues = range.setValues;
    if (realSetValues) {
      range.setValues = function (v) {
        writes.push({ row: r, col: c, value: '（setValues）' });
        return realSetValues.call(range, v);
      };
    }
    return range;
  };

  env.sandbox.selfTestRunPublish_({ masterFileId: FAKE_SELFTEST_ID },
    { isoDate: '2030-01-06', doPublish: true, doSend: false });

  configSheet.getRange = realGetRange;

  assert.strictEqual(writes.length, 0,
    '發佈流程期間不可以寫 Config 一次，實際寫了：'
      + writes.map(function (w) { return 'r' + w.row + 'c' + w.col + '=' + w.value; }).join('、'));
});

test('中途拋錯，Config 那一格一樣沒有變（連 finally 都不需要）', function () {
  // ⚠️ 舊做法靠 finally 還原；這一條驗的是「根本沒有寫過」，所以連拋錯
  //    那一條路都不會留下痕跡。
  const env = makeEnv({});
  let threw = false;
  try {
    env.sandbox.selfTestRunPublish_({ masterFileId: FAKE_SELFTEST_ID }, null);
  } catch (err) {
    threw = true;
  }
  assert.strictEqual(readConfigCell(env, 'PUBLISHED_PDF_FILE_ID'), FAKE_PUBLISHED_ID,
    (threw ? '拋錯之後' : '沒有拋錯，但') + ' Config 那一格不可以被碰過');
});

test('覆寫期間，publishConfig_() 真的看到沙盒那一個（證明覆寫有生效）', function () {
  // ⚠️ 沒有這一條的話，一支「什麼都不做」的實作也會令上面兩條轉綠。
  const env = makeEnv({});
  assert.strictEqual(env.sandbox.publishConfig_().masterFileId, FAKE_PUBLISHED_ID,
    '未設覆寫時要讀 Config');

  env.sandbox.setPublishMasterFileIdOverride_(FAKE_SELFTEST_ID);
  assert.strictEqual(env.sandbox.publishConfig_().masterFileId, FAKE_SELFTEST_ID,
    '設了覆寫就要用覆寫那一個');
  assert.strictEqual(readConfigCell(env, 'PUBLISHED_PDF_FILE_ID'), FAKE_PUBLISHED_ID,
    '⚠️ 但 Config 那一格仍然一個字都沒有變');

  env.sandbox.setPublishMasterFileIdOverride_(null);
  assert.strictEqual(env.sandbox.publishConfig_().masterFileId, FAKE_PUBLISHED_ID,
    '清走覆寫之後要還原成讀 Config');
});

test('全 src 只剩「建立 master 發佈檔案」會寫 PUBLISHED_PDF_FILE_ID', function () {
  // ⚠️ 靜態檢查：這一格只准有一個寫入者。多一個就多一條會寫錯的路。
  const fs = require('fs');
  const path = require('path');
  const srcDir = path.join(__dirname, '..', 'src');
  const writers = [];
  fs.readdirSync(srcDir).filter(function (f) { return f.endsWith('.gs'); }).forEach(function (f) {
    const lines = fs.readFileSync(path.join(srcDir, f), 'utf8').split(/\r?\n/);
    lines.forEach(function (line, i) {
      if (line.indexOf('setConfig(CONFIG_KEYS.PUBLISHED_PDF_FILE_ID') !== -1) {
        writers.push(f + ':' + (i + 1));
      }
    });
  });
  assert.strictEqual(writers.length, 1,
    'PUBLISHED_PDF_FILE_ID 的寫入者應該只有一個，實際：' + writers.join('、'));
  assert.ok(writers[0].indexOf('Publish.gs') === 0, '唯一那個要在 Publish.gs：' + writers[0]);
});

// =====================================================================
// 第 2 組：Config 每一格改動都要記 AuditLog
// =====================================================================

console.log('\n第 2 組：Config 的改動要記帳');

test('setConfig 會記 AuditLog，而且標明來源', function () {
  const env = makeEnv({});
  env.sandbox.setConfig('CHURCH_NAME', '測試教會', '測試用的來源');

  const rows = auditRows(env, 'SET_CONFIG');
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(String(rows[0].ROW_KEY), 'CHURCH_NAME');
  assert.strictEqual(String(rows[0].NEW_VALUE), '測試教會');
  assert.ok(String(rows[0].NOTES).indexOf('測試用的來源') !== -1,
    '要標明來源：' + rows[0].NOTES);
});

test('setConfig 沒有傳來源 → 記「（未標明來源）」，不是靜靜留白', function () {
  const env = makeEnv({});
  env.sandbox.setConfig('CHURCH_NAME', '測試教會');
  const rows = auditRows(env, 'SET_CONFIG');
  assert.ok(String(rows[0].NOTES).indexOf('未標明來源') !== -1, rows[0].NOTES);
});

test('稽核在寫值之前先寫（硬中斷時寧可多一筆，也不要無跡可尋）', function () {
  // ⚠️ 用一個「寫值時會拋錯」的假分頁證明次序：稽核那一筆仍然在。
  const env = makeEnv({});
  const configSheet = env.sheets.Config;
  const realGetRange = configSheet.getRange;
  configSheet.getRange = function (r, c, nr, nc) {
    const range = realGetRange.call(configSheet, r, c, nr, nc);
    if (c === 2 && nr === undefined) {
      range.setValue = function () { throw new Error('假裝寫值時被中斷'); };
    }
    return range;
  };

  let threw = false;
  try {
    env.sandbox.setConfig('CHURCH_NAME', '寫唔入去的值', '測試：中斷');
  } catch (err) {
    threw = true;
  }
  configSheet.getRange = realGetRange;

  assert.strictEqual(threw, true, '前提：寫值真的拋了錯');
  const rows = auditRows(env, 'SET_CONFIG');
  assert.strictEqual(rows.length, 1, '稽核那一筆一定要已經寫好');
  assert.strictEqual(String(rows[0].NEW_VALUE), '寫唔入去的值');
});

test('人手在試算表改 Config 一格 → 記 CONFIG_MANUAL_EDIT，來源標明是人手', function () {
  // ⚠️ 這是最要緊的一條：setConfig() 會記帳，但在試算表介面直接打字改一格
  //    **不會經過它**。全系統最敏感的一張表，人手改動反而完全沒有紀錄。
  const env = makeEnv({});
  const configSheet = env.sheets.Config;

  // 找出 PUBLISHED_PDF_FILE_ID 在第幾行。
  const rows = env.sandbox.readSheet(env.sandbox.SHEETS.CONFIG);
  let rowNo = -1;
  rows.forEach(function (r, i) {
    if (String(r.KEY) === 'PUBLISHED_PDF_FILE_ID') rowNo = i + 3;
  });
  assert.ok(rowNo > 0, '找得到那一行');

  configSheet.getRange(rowNo, 2).setValue(FAKE_SELFTEST_ID);
  env.sandbox.onFillGridEdit_(editEvent(configSheet, rowNo, 2, 1, 1, FAKE_PUBLISHED_ID));

  const audits = auditRows(env, 'CONFIG_MANUAL_EDIT');
  assert.strictEqual(audits.length, 1, '應該記一筆');
  assert.strictEqual(String(audits[0].ROW_KEY), 'PUBLISHED_PDF_FILE_ID');
  assert.strictEqual(String(audits[0].OLD_VALUE), FAKE_PUBLISHED_ID, '舊值要記得住');
  assert.strictEqual(String(audits[0].NEW_VALUE), FAKE_SELFTEST_ID);
  assert.ok(String(audits[0].NOTES).indexOf('人手編輯') !== -1, audits[0].NOTES);
});

test('人手一次貼上多格 → 逐格記，而且舊值明確寫「不詳」不是亂猜', function () {
  const env = makeEnv({});
  const configSheet = env.sheets.Config;
  env.sandbox.onFillGridEdit_(editEvent(configSheet, 3, 2, 3, 1));

  const audits = auditRows(env, 'CONFIG_MANUAL_EDIT');
  assert.strictEqual(audits.length, 3, '三格就要三筆，實際 ' + audits.length);
  audits.forEach(function (a) {
    assert.ok(String(a.OLD_VALUE).indexOf('舊值不詳') !== -1,
      '多格編輯拿不到舊值，要明講「不詳」而不是留白或者亂猜：' + a.OLD_VALUE);
  });
});

test('改標題兩行、或者改「說明」那一欄 → 不記（與設定行為無關）', function () {
  const env = makeEnv({});
  const configSheet = env.sheets.Config;
  env.sandbox.onFillGridEdit_(editEvent(configSheet, 1, 1, 2, 4));   // 標題兩行
  env.sandbox.onFillGridEdit_(editEvent(configSheet, 3, 3, 1, 1));   // 說明欄
  assert.strictEqual(auditRows(env, 'CONFIG_MANUAL_EDIT').length, 0);
});

// =====================================================================
// 第 3 組：初始化永不覆寫白名單以外的值
// =====================================================================

console.log('\n第 3 組：初始化的白名單');

test('白名單目前只有一個鍵，而且是 SELFTEST_QUARTER_ID', function () {
  // ⚠️ 這個白名單要短到一眼數得完。每加一個鍵，就多開一道「系統會自己改
  //    你設定」的門，所以加的時候一定要連這一條測試一齊改，逼人停一停。
  const env = makeEnv({});
  const list = env.sandbox.CONFIG_UPGRADABLE_DEFAULTS_;
  assert.strictEqual(list.length, 1, '白名單長度變了就要重新想清楚');
  assert.strictEqual(list[0].key, 'SELFTEST_QUARTER_ID');
});

test('PUBLISHED_PDF_FILE_ID 不在白名單，跑一百次初始化都不會被動', function () {
  // ⚠️ 這一條直接對應這一輪的事故：初始化那個「自動更新系統種下的預設值」
  //    機制，絕對不可以誤中正式 master 那一格。
  const env = makeEnv({ config: { PUBLISHED_PDF_FILE_ID: FAKE_PUBLISHED_ID } });
  for (let i = 0; i < 100; i++) {
    env.sandbox.upgradeSystemSeededDefaults_();
  }
  assert.strictEqual(readConfigCell(env, 'PUBLISHED_PDF_FILE_ID'), FAKE_PUBLISHED_ID);
  assert.strictEqual(auditRows(env, 'CONFIG_UPGRADE_DEFAULT').length, 0,
    '一次都不應該更新過');
});

test('白名單以外的鍵，就算現值剛好等於某個舊預設值也不會被動', function () {
  // 反向那一半：白名單才是關鍵，不是「值像不像舊預設值」。
  const env = makeEnv({ config: { PUBLISHED_PDF_FILE_ID: '2030T2' } });
  env.sandbox.upgradeSystemSeededDefaults_();
  assert.strictEqual(readConfigCell(env, 'PUBLISHED_PDF_FILE_ID'), '2030T2');
});

test('白名單內的鍵更新時，AuditLog 有紀錄而且對話框列得出', function () {
  const env = makeEnv({ config: { SELFTEST_QUARTER_ID: '2030T2' } });
  const r = env.sandbox.upgradeSystemSeededDefaults_();

  assert.strictEqual(r.upgrades.length, 1);
  assert.strictEqual(r.lines.length, 1, '對話框要逐條列出');
  assert.ok(r.lines[0].indexOf('SELFTEST_QUARTER_ID') !== -1
    && r.lines[0].indexOf('2030T2') !== -1 && r.lines[0].indexOf('2030T1') !== -1,
  '要列出「哪個鍵、由什麼變成什麼」：' + r.lines[0]);

  assert.strictEqual(auditRows(env, 'CONFIG_UPGRADE_DEFAULT').length, 1);
  // setConfig 那一筆也要有，而且標明是初始化寫的。
  const setRows = auditRows(env, 'SET_CONFIG');
  assert.strictEqual(setRows.length, 1);
  assert.ok(String(setRows[0].NOTES).indexOf('初始化') !== -1, setRows[0].NOTES);
});

test('現值是空白 → 不當成「過時的舊預設值」，不動', function () {
  const env = makeEnv({ config: { SELFTEST_QUARTER_ID: '' } });
  const r = env.sandbox.upgradeSystemSeededDefaults_();
  assert.strictEqual(r.upgrades.length, 0);
  assert.strictEqual(r.skipped.length, 1);
  assert.ok(r.skipped[0].reason.indexOf('空白') !== -1, r.skipped[0].reason);
});

// =====================================================================
// 第 4 組：I12／I13 與自我檢測
// =====================================================================

console.log('\n第 4 組：I12／I13 與完成度自我檢測');

test('I12 紅：兩個 master ID 相同', function () {
  const env = makeEnv({ config: { PUBLISHED_PDF_FILE_ID: FAKE_SELFTEST_ID } });
  const r = env.sandbox.runInvariantI12_();
  assert.strictEqual(r.ok, false);
  assert.ok(r.evidence.indexOf('同一個檔案') !== -1, r.evidence);
  assert.ok(r.evidence.indexOf('教會網站') !== -1, '要講明後果：' + r.evidence);
  assert.ok(r.evidence.indexOf('建立 master 發佈檔案') !== -1, '要講明正確做法：' + r.evidence);
});

test('I12 綠：兩個 master ID 不同', function () {
  const env = makeEnv({});
  assert.strictEqual(env.sandbox.runInvariantI12_().ok, true);
});

test('I12 驗證不到：沙盒那一個未設定 → null，不是 true', function () {
  // ⚠️ 「比不到」與「比過而且沒事」是兩件事。
  const env = makeEnv({ config: { SELFTEST_MASTER_PDF_FILE_ID: '' } });
  assert.strictEqual(env.sandbox.runInvariantI12_().ok, null);
});

test('I13 紅：Config 與 PublishLog 最新一行正式紀錄對不上，而且列出兩個值', function () {
  const env = makeEnv({
    config: { PUBLISHED_PDF_FILE_ID: FAKE_SELFTEST_ID },
    publishRowSpecs: [{ isoDate: '2027-11-07', masterFileId: FAKE_PUBLISHED_ID }]
  });
  const r = env.sandbox.runInvariantI13_();
  assert.strictEqual(r.ok, false);
  // 兩個值都要出現（遮罩過的形式）。
  assert.ok(r.actual.indexOf('Config 是') !== -1 && r.actual.indexOf('PublishLog 是') !== -1, r.actual);
  assert.ok(r.evidence.indexOf('2027-11-07') !== -1, '要講出是哪一次發佈：' + r.evidence);
  assert.ok(r.evidence.indexOf('AuditLog') !== -1, '要指引去哪裏查：' + r.evidence);
});

test('I13 綠：兩者指向同一個檔案', function () {
  const env = makeEnv({
    publishRowSpecs: [{ isoDate: '2027-11-07', masterFileId: FAKE_PUBLISHED_ID }]
  });
  assert.strictEqual(env.sandbox.runInvariantI13_().ok, true);
});

test('I13 不適用：從未正式發佈過 → null，不是失敗', function () {
  const env = makeEnv({ publishRowSpecs: [] });
  const r = env.sandbox.runInvariantI13_();
  assert.strictEqual(r.ok, null);
  assert.ok(r.evidence.indexOf('不等於') !== -1, '要講明「驗證不到不等於沒問題」：' + r.evidence);
});

test('I13 只看非自測那些行（自測的行指向沙盒，混進去比就一定假警報）', function () {
  const env = makeEnv({
    publishRowSpecs: [
      { isoDate: '2027-11-07', masterFileId: FAKE_PUBLISHED_ID },
      // 自測那一行比較新，但一定不可以被當成「最新一行正式紀錄」。
      { isoDate: '2030-01-06', masterFileId: FAKE_SELFTEST_ID, isSelfTest: true, at: [2030, 0, 6, 10, 0, 0] }
    ]
  });
  const r = env.sandbox.runInvariantI13_();
  assert.strictEqual(r.ok, true, r.evidence);
  assert.ok(r.evidence.indexOf('2027-11-07') !== -1, '要對正式那一行：' + r.evidence);
});

test('自我檢測：兩個 ID 相同 → 報 🔴（不是 🟡）', function () {
  const env = makeEnv({ config: { PUBLISHED_PDF_FILE_ID: FAKE_SELFTEST_ID } });
  const check = env.sandbox.checkMasterFileIdsDistinct_();
  assert.strictEqual(check.ok, false);

  const summary = env.sandbox.runSelfCheck_();
  const item = summary.items.filter(function (i) {
    return String(i.label).indexOf('正式與沙盒 master 檔案') !== -1;
  })[0];
  assert.ok(item, '應該有這一項');
  assert.strictEqual(item.status, env.sandbox.SELF_CHECK_STATUS_.RED,
    '⚠️ 一定要紅：正式輸出已經指向錯的地方，不是「有機會出事」');
});

test('自我檢測：Config 與 PublishLog 對不上 → 報 🔴 而且列出兩個值', function () {
  const env = makeEnv({
    config: { PUBLISHED_PDF_FILE_ID: FAKE_SELFTEST_ID },
    publishRowSpecs: [{ isoDate: '2027-11-07', masterFileId: FAKE_PUBLISHED_ID }]
  });
  const summary = env.sandbox.runSelfCheck_();
  const item = summary.items.filter(function (i) {
    return String(i.label).indexOf('master 檔案 ID 對得上發佈紀錄') !== -1;
  })[0];
  assert.ok(item, '應該有這一項');
  assert.strictEqual(item.status, env.sandbox.SELF_CHECK_STATUS_.RED);
  assert.ok(item.message.indexOf('對不上') !== -1, item.message);
});

test('自我檢測：從未發佈過 → 報 🟡（驗證不到），不是 🔴', function () {
  const env = makeEnv({ publishRowSpecs: [] });
  const summary = env.sandbox.runSelfCheck_();
  const item = summary.items.filter(function (i) {
    return String(i.label).indexOf('master 檔案 ID 對得上發佈紀錄') !== -1;
  })[0];
  assert.ok(item, '應該有這一項');
  assert.strictEqual(item.status, env.sandbox.SELF_CHECK_STATUS_.YELLOW,
    '「未驗得到」不是「驗過而且有問題」');
});

test('自我檢測：一切正常 → 兩項都報 🟢（證明上面幾條不是永遠報紅）', function () {
  const env = makeEnv({
    publishRowSpecs: [{ isoDate: '2027-11-07', masterFileId: FAKE_PUBLISHED_ID }]
  });
  const summary = env.sandbox.runSelfCheck_();
  ['正式與沙盒 master 檔案', 'master 檔案 ID 對得上發佈紀錄'].forEach(function (label) {
    const item = summary.items.filter(function (i) {
      return String(i.label).indexOf(label) !== -1;
    })[0];
    assert.ok(item, '應該有「' + label + '」這一項');
    assert.strictEqual(item.status, env.sandbox.SELF_CHECK_STATUS_.GREEN, label + '：' + item.message);
  });
});

test('「建立 master 發佈檔案」寫 Config 時會記 AuditLog 並標明來源（靜態檢查）', function () {
  // ⚠️ 那一支要真的建立 Drive 檔案，Node 測不到；改為靜態確認那一行有傳來源。
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'Publish.gs'), 'utf8');
  assert.ok(src.indexOf("setConfig(CONFIG_KEYS.PUBLISHED_PDF_FILE_ID, created.fileId, '選單「建立 master 發佈檔案」')") !== -1,
    '那一行要傳來源，否則 AuditLog 會記「（未標明來源）」');
});

// =====================================================================

console.log('\n通過 ' + pass + ' 項，失敗 ' + fail + ' 項。');
process.exit(fail === 0 ? 0 : 1);
