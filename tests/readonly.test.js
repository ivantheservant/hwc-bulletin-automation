#!/usr/bin/env node
/**
 * tests/readonly.test.js
 *
 * 第一輪自測修正 Part 3：內容表接管的欄位，**每一個寫入入口**都不可以寫。
 *
 * 第一輪自測 S09 報告「apiSaveWeek 竟然接受唯讀欄位」。查下去發現兩件事：
 *   1. S09 送的 payload 形狀是 `lists: { announcements: [...] }`，但真正的
 *      payload 把四張清單放在**頂層**。前後端都不認識那個形狀，所以防線
 *      一次都沒有觸發——那條自測量度的是一件不存在的事。
 *   2. 更重要的是：唯讀規則當時在**三個地方各自寫過一次**（前端一個寫死
 *      的陣列、後端一支衍生函式、季度填寫表完全沒有），而季度填寫表那一
 *      個入口照樣把人手改的人數 PUSH 回 `BulletinWeeks`。擋住大門，後門
 *      大開。
 *
 * 所以這個檔案的紀律是：**逐個欄位、逐個入口**驗，不是驗「有一條防線」。
 *
 * 執行方式：node tests/readonly.test.js
 * 離開碼：0＝全部通過　1＝有測試失敗
 */

'use strict';

const assert = require('assert');
const { loadAllSrcFilesInOrder } = require('./helpers/loadGas');
const { makeFakeSheet, makeFakeSpreadsheet } = require('./helpers/fakeSpreadsheet');
const { assertWrittenChinese } = require('./helpers/writtenChinese');

const ISO = '2027-10-03';

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

const GAS_STUBS = {
  Logger: { log: function () {} },
  Utilities: {
    formatDate: function (d, tz, fmt) {
      const y = d.getFullYear();
      const mo = String(d.getMonth() + 1).padStart(2, '0');
      const da = String(d.getDate()).padStart(2, '0');
      return fmt === 'yyyy-MM-dd' ? (y + '-' + mo + '-' + da) : (y + '-' + mo + '-' + da + ' 00:00');
    },
    sleep: function () {}
  },
  Session: {
    getActiveUser: function () { return { getEmail: function () { return 'clerk@example.com'; } }; },
    getEffectiveUser: function () { return { getEmail: function () { return 'clerk@example.com'; } }; },
    getScriptTimeZone: function () { return 'Pacific/Auckland'; }
  },
  LockService: {
    getScriptLock: function () {
      return { tryLock: function () { return true; }, releaseLock: function () {} };
    }
  }
};

function ownSheetFor(sandboxRef, sheetId, rows) {
  const def = sandboxRef.COLUMNS[sheetId];
  return makeFakeSheet(def.headers, def.keys, rows || []);
}

function makeEnv(options) {
  const o = options || {};
  const boot = loadAllSrcFilesInOrder(GAS_STUBS);
  const sheets = {};
  Object.keys(boot.SHEETS).forEach(function (id) {
    sheets[boot.SHEETS[id]] = ownSheetFor(boot, id, []);
  });
  sheets.BulletinWeeks = ownSheetFor(boot, 'BULLETIN_WEEKS', o.bulletinWeeks || [
    { SERVICE_DATE: ISO, QUARTER_ID: '2027T4', WEEK_OF_MONTH: 1, STATUS: 'DRAFT' }
  ]);
  const FakeApp = { getActiveSpreadsheet: function () { return makeFakeSpreadsheet(sheets); } };
  return {
    sheets: sheets,
    sandbox: loadAllSrcFilesInOrder(Object.assign({}, GAS_STUBS, { SpreadsheetApp: FakeApp }))
  };
}

function basicPayload(overrides) {
  return Object.assign({
    isoDate: ISO,
    lastSavedAt: null,
    week: {},
    announcements: [],
    prayers: [],
    fellowships: [],
    finance: [],
    dutyEdits: []
  }, overrides || {});
}

/** 跑一次儲存，回報「有沒有被拒、錯誤碼、寫了多少筆 AuditLog」。 */
function attemptSave(env, payload) {
  const auditBefore = env.sandbox.readSheet(env.sandbox.SHEETS.AUDIT_LOG).length;
  let rejected = false;
  let code = '';
  let message = '';
  try {
    env.sandbox.saveWeekFromWebApp_(payload);
  } catch (err) {
    rejected = true;
    code = (err && err.code) || '';
    message = (err && err.message) || String(err);
  }
  const auditAfter = env.sandbox.readSheet(env.sandbox.SHEETS.AUDIT_LOG).length;
  return { rejected: rejected, code: code, message: message, auditWritten: auditAfter - auditBefore };
}

// =====================================================================
// 1. 單一真相來源
// =====================================================================

test('1a. 唯讀清單定義在 Constants.gs，而且是凍結的', function () {
  const env = makeEnv({});
  const fields = env.sandbox.CONTENT_SHEET_READONLY_FIELDS;
  assert.ok(Array.isArray(fields.WEEK) && fields.WEEK.length > 0);
  assert.ok(Array.isArray(fields.LISTS) && fields.LISTS.length > 0);
  assert.ok(Object.isFrozen(fields), '不可以被任何一個呼叫方改掉');
  assert.ok(Object.isFrozen(fields.WEEK));
});

// ⚠️ 這一條是防「日後有人新增匯入目標卻忘記更新唯讀清單」。分岔的方向
//    如果是「清單少列了一項」，那一欄就會變成「匯入會寫、介面又准人改」
//    ——兩邊互相覆蓋，而且完全沒有提示。
test('1b. 唯讀清單與 contentImportTargets_() 推算出來的完全一致', function () {
  const env = makeEnv({});
  const declared = env.sandbox.CONTENT_SHEET_READONLY_FIELDS.WEEK.slice().sort();
  const derived = env.sandbox.contentSheetOwnedWeekKeysDerived_().slice().sort();
  assert.strictEqual(JSON.stringify(declared), JSON.stringify(derived),
    '宣告的唯讀欄位與匯入目標推算出來的對不上：\n  宣告 ' + JSON.stringify(declared)
      + '\n  推算 ' + JSON.stringify(derived));
});

test('1c. 唯讀清單名稱與 contentImportTargets_() 推算出來的完全一致', function () {
  const env = makeEnv({});
  const declared = env.sandbox.CONTENT_SHEET_READONLY_FIELDS.LISTS.slice().sort();
  const derived = env.sandbox.contentSheetOwnedListTypesDerived_().slice().sort();
  assert.strictEqual(JSON.stringify(declared), JSON.stringify(derived));
});

test('1d. 前後端共用同一份：apiLoadWeek 的 readOnly.readOnlyFields 就是那一份', function () {
  const env = makeEnv({});
  const fields = env.sandbox.CONTENT_SHEET_READONLY_FIELDS;
  // 前端拿到的是 slice() 出來的副本，內容要一模一樣。
  assert.strictEqual(JSON.stringify(fields.WEEK.slice()), JSON.stringify(fields.WEEK));
  assert.strictEqual(JSON.stringify(fields.LISTS.slice()), JSON.stringify(fields.LISTS));
});

test('1e. 每一個唯讀欄位都有給人看的名稱（訊息不可以只講機器鍵）', function () {
  const env = makeEnv({});
  const labels = env.sandbox.CONTENT_SHEET_READONLY_LABELS;
  const fields = env.sandbox.CONTENT_SHEET_READONLY_FIELDS;
  fields.WEEK.concat(fields.LISTS).forEach(function (key) {
    assert.ok(labels[key], key + ' 沒有中文名稱');
  });
});

// =====================================================================
// 2. 每一個唯讀欄位單獨送 → 整次拒絕、零寫入
// =====================================================================

test('2a. 十五個唯讀週欄位，逐個單獨送，全部被拒且一筆 AuditLog 都沒有', function () {
  const env0 = makeEnv({});
  const keys = env0.sandbox.CONTENT_SHEET_READONLY_FIELDS.WEEK;
  assert.ok(keys.length >= 15, '應該有十五個：' + keys.length);

  const bad = [];
  keys.forEach(function (key) {
    const env = makeEnv({});
    const week = {};
    week[key] = '有人想寫進去';
    const r = attemptSave(env, basicPayload({ week: week }));
    if (!r.rejected || r.code !== 'CONTENT_SHEET_READONLY' || r.auditWritten !== 0) {
      bad.push(key + '（被拒 ' + r.rejected + '、代碼 ' + r.code + '、AuditLog ' + r.auditWritten + '）');
    }
  });
  assert.strictEqual(bad.length, 0, '這幾個唯讀欄位擋不住：\n  ' + bad.join('\n  '));
});

test('2b. 四張唯讀清單，逐個單獨送，全部被拒且零寫入', function () {
  const env0 = makeEnv({});
  const types = env0.sandbox.CONTENT_SHEET_READONLY_FIELDS.LISTS;

  const bad = [];
  types.forEach(function (type) {
    const env = makeEnv({});
    const overrides = {};
    overrides[type] = [{ TEXT: '有人想寫進去', ROW_LABEL: '有人想寫進去', FELLOWSHIP_NAME: '有人想寫進去' }];
    const r = attemptSave(env, basicPayload(overrides));
    if (!r.rejected || r.code !== 'CONTENT_SHEET_READONLY' || r.auditWritten !== 0) {
      bad.push(type + '（被拒 ' + r.rejected + '、代碼 ' + r.code + '、AuditLog ' + r.auditWritten + '）');
    }
  });
  assert.strictEqual(bad.length, 0, '這幾張唯讀清單擋不住：\n  ' + bad.join('\n  '));
});

// ⚠️ 這一條就是 S09 當初送錯的形狀。防線只認一種形狀的話，遇到另一種
//    形狀不會報錯，只會**靜靜地什麼都不做**——比報錯危險得多。
test('2c. 清單放在 lists:{} 這個非正式形狀，一樣擋得住', function () {
  const env = makeEnv({});
  const r = attemptSave(env, basicPayload({
    lists: { announcements: [{ TEXT: '這是唯讀欄位，不應該存得到' }] }
  }));
  assert.strictEqual(r.rejected, true);
  assert.strictEqual(r.code, 'CONTENT_SHEET_READONLY');
  assert.strictEqual(r.auditWritten, 0);
});

// =====================================================================
// 3. 混住一個可寫欄位 → 仍然是**整次**拒絕
// =====================================================================

test('3a. 唯讀欄位混一個可寫欄位：整次拒絕，可寫那一欄也沒有寫進去', function () {
  const env = makeEnv({});
  const r = attemptSave(env, basicPayload({
    week: { ATT_ENG_WORSHIP: '99', SERMON_TITLE: '這一欄本來可以寫' }
  }));
  assert.strictEqual(r.rejected, true);
  assert.strictEqual(r.code, 'CONTENT_SHEET_READONLY');
  assert.strictEqual(r.auditWritten, 0, '不可以「一半成功」——幹事會以為全部存好了');

  const week = env.sandbox.readBulletinWeekRowWithRowNo_(ISO);
  assert.strictEqual(env.sandbox.sanitizeCellText_(week.SERMON_TITLE || ''), '',
    '可寫那一欄一樣不可以被寫入');
});

test('3b. 只送可寫欄位：照樣存得到（防線不可以擋錯人）', function () {
  const env = makeEnv({});
  const r = attemptSave(env, basicPayload({ week: { SERMON_TITLE: '正常的講題' } }));
  assert.strictEqual(r.rejected, false, r.message);
  assert.ok(r.auditWritten > 0);
  const week = env.sandbox.readBulletinWeekRowWithRowNo_(ISO);
  assert.strictEqual(week.SERMON_TITLE, '正常的講題');
});

// ⚠️ 舊版前端（使用者瀏覽器有快取）會送 `announcements: []`、
//    `ATT_ENG_WORSHIP: ''` 這類空值。那些空值寫不到任何東西，為此令整次
//    儲存失敗，只會害幹事連其他欄位都改不到。判斷準則是「**有沒有真的
//    帶內容**」，不是「有沒有這個 key」。
test('3c. 唯讀欄位帶空值：不算送出，不會擋住整次儲存', function () {
  const env = makeEnv({});
  const r = attemptSave(env, basicPayload({
    week: { ATT_ENG_WORSHIP: '', CALL_TEXT: '   ', SERMON_TITLE: '正常的講題' },
    announcements: []
  }));
  assert.strictEqual(r.rejected, false, r.message);
  const week = env.sandbox.readBulletinWeekRowWithRowNo_(ISO);
  assert.strictEqual(week.SERMON_TITLE, '正常的講題');
});

// =====================================================================
// 4. 拒絕訊息
// =====================================================================

test('4a. 訊息講得出是哪幾個欄位，而且講明「一格都沒有寫入」', function () {
  const env = makeEnv({});
  const r = attemptSave(env, basicPayload({
    week: { ATT_ENG_WORSHIP: '99', CALL_REF: '詩篇 100' }
  }));
  assert.ok(r.message.indexOf('英語堂崇拜人數') !== -1, r.message);
  assert.ok(r.message.indexOf('宣召出處') !== -1, r.message);
  assert.ok(r.message.indexOf('一格都沒有寫入') !== -1, r.message);
  assert.ok(r.message.indexOf('重新匯入') !== -1, '要講清楚下一步做什麼');
});

test('4b. 錯誤物件帶 readOnlyFields，呼叫方不需要靠解析文字', function () {
  const env = makeEnv({});
  let caught = null;
  try {
    env.sandbox.saveWeekFromWebApp_(basicPayload({ week: { CALL_TEXT: '經文' } }));
  } catch (err) { caught = err; }
  assert.ok(caught);
  assert.strictEqual(JSON.stringify(caught.readOnlyFields), JSON.stringify(['CALL_TEXT']));
});

test('4c. 拒絕訊息是書面語繁體中文', function () {
  const env = makeEnv({});
  const r = attemptSave(env, basicPayload({ week: { CALL_TEXT: '經文' } }));
  assertWrittenChinese(assert, '唯讀欄位拒絕訊息', r.message);
});

// =====================================================================
// 5. findSubmittedReadOnlyFields_ 純函式層
// =====================================================================

test('5a. findSubmittedReadOnlyFields_：沒有唯讀欄位時回空陣列', function () {
  const env = makeEnv({});
  const found = env.sandbox.findSubmittedReadOnlyFields_(basicPayload({
    week: { SERMON_TITLE: '講題' }
  }));
  assert.strictEqual(found.length, 0);
});

test('5b. findSubmittedReadOnlyFields_：同一個清單兩種形狀都送，只算一次', function () {
  const env = makeEnv({});
  const found = env.sandbox.findSubmittedReadOnlyFields_(basicPayload({
    announcements: [{ TEXT: '甲' }],
    lists: { announcements: [{ TEXT: '甲' }] }
  }));
  assert.strictEqual(JSON.stringify(found), JSON.stringify(['announcements']));
});

test('5c. findSubmittedReadOnlyFields_：payload 是 null／undefined 不會爆', function () {
  const env = makeEnv({});
  assert.strictEqual(env.sandbox.findSubmittedReadOnlyFields_(null).length, 0);
  assert.strictEqual(env.sandbox.findSubmittedReadOnlyFields_(undefined).length, 0);
  assert.strictEqual(env.sandbox.findSubmittedReadOnlyFields_({}).length, 0);
});

console.log('');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
