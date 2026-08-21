#!/usr/bin/env node
/**
 * tests/constants.test.js
 *
 * src/Constants.gs 的結構性回歸測試：檢查 SHEETS／COLUMNS／CONFIG_KEYS／
 * DEFAULTS 彼此一致——headers／keys／types 陣列長度一致、機器鍵沒有重複、
 * ID／電郵類的 Config 預設值一律是空字串（硬規則：不可以寫死真實值）。
 *
 * 執行方式：node tests/constants.test.js
 * 離開碼：0＝全部通過　1＝有測試失敗
 */

'use strict';

const assert = require('assert');
const { loadAllSrcFilesInOrder } = require('./helpers/loadGas');
const { makeFakeSheet, makeFakeSpreadsheet } = require('./helpers/fakeSpreadsheet');

// 一律按 Apps Script 實際的載入次序（檔名字母序）載入全部 src/*.gs，
// 不要自己手動只列 Constants.gs、自選次序——見 tests/helpers/loadGas.js
// 檔頭的事故說明：Constants.gs 排第 4，第一輪就是因為測試把它排到最前面
// 才漏掉了 Bootstrap.gs 提前引用 Constants.gs 常數的 bug。
const GAS_STUBS = {
  Utilities: { formatDate: function () { return ''; } },
  Session: {
    getScriptTimeZone: function () { return 'Pacific/Auckland'; },
    getActiveUser: function () { return { getEmail: function () { return ''; } }; }
  },
  SpreadsheetApp: {},
  CacheService: {}
};
const sandbox = loadAllSrcFilesInOrder(GAS_STUBS);
const { SHEETS, COLUMNS, SHEET_ID_BY_NAME, CONFIG_KEYS, DEFAULTS, COLUMN_TYPES } = sandbox;

let pass = 0;
let fail = 0;

function assertArrayEqual(actual, expected, message) {
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

const sheetIds = Object.keys(SHEETS);
const validTypes = Object.keys(COLUMN_TYPES).map(function (k) { return COLUMN_TYPES[k]; });

// =====================================================================
// SHEETS ⇄ COLUMNS 一致性
// =====================================================================

test('SHEETS 剛好定義 23 張工作表', function () {
  assert.strictEqual(sheetIds.length, 23);
});

test('每個 SHEETS 的 key 在 COLUMNS 都有對應定義，且沒有多餘的 COLUMNS key', function () {
  sheetIds.forEach(function (id) {
    assert.ok(COLUMNS[id], '缺少 COLUMNS.' + id);
  });
  Object.keys(COLUMNS).forEach(function (id) {
    assert.ok(SHEETS[id], 'COLUMNS.' + id + ' 沒有對應的 SHEETS 定義');
  });
});

test('工作表名稱（SHEETS 的值）彼此不重複', function () {
  const names = sheetIds.map(function (id) { return SHEETS[id]; });
  assert.strictEqual(new Set(names).size, names.length);
});

test('SHEET_ID_BY_NAME 是 SHEETS 的正確反查表', function () {
  assert.strictEqual(Object.keys(SHEET_ID_BY_NAME).length, sheetIds.length);
  sheetIds.forEach(function (id) {
    assert.strictEqual(SHEET_ID_BY_NAME[SHEETS[id]], id);
  });
});

// =====================================================================
// 每張工作表的 headers／keys／types 陣列長度一致（本檔案的核心測試）
// =====================================================================

test('每張工作表的 headers／keys／types 陣列長度一致', function () {
  sheetIds.forEach(function (id) {
    const def = COLUMNS[id];
    assert.strictEqual(
      def.headers.length, def.keys.length,
      SHEETS[id] + '：headers(' + def.headers.length + ') 與 keys(' + def.keys.length + ') 長度不一致'
    );
    assert.strictEqual(
      def.keys.length, def.types.length,
      SHEETS[id] + '：keys(' + def.keys.length + ') 與 types(' + def.types.length + ') 長度不一致'
    );
  });
});

test('每張工作表的機器鍵（keys）內部沒有重複', function () {
  sheetIds.forEach(function (id) {
    const keys = COLUMNS[id].keys;
    assert.strictEqual(new Set(keys).size, keys.length, SHEETS[id] + '：keys 有重複');
  });
});

test('每一個型別都在 COLUMN_TYPES 的允許值之內（防止手寫字串打錯字）', function () {
  sheetIds.forEach(function (id) {
    COLUMNS[id].types.forEach(function (t, i) {
      assert.ok(
        validTypes.indexOf(t) !== -1,
        SHEETS[id] + ' 第 ' + (i + 1) + ' 欄（' + COLUMNS[id].keys[i] + '）的型別「' + t + '」不是合法的 COLUMN_TYPES 值'
      );
    });
  });
});

test('textFormatColumns（如果有）指到的機器鍵必須真的存在於該表', function () {
  sheetIds.forEach(function (id) {
    const def = COLUMNS[id];
    (def.textFormatColumns || []).forEach(function (key) {
      assert.ok(def.keys.indexOf(key) !== -1, SHEETS[id] + ' 的 textFormatColumns 提到不存在的機器鍵「' + key + '」');
    });
  });
});

test('BulletinWeeks 的 12 個人數欄一律是 TEXT 型別，且都在 textFormatColumns 內', function () {
  const def = COLUMNS.BULLETIN_WEEKS;
  const attKeys = def.keys.filter(function (k) { return /^ATT_/.test(k); });
  assert.strictEqual(attKeys.length, 12, '人數欄應該剛好 12 個');
  attKeys.forEach(function (k) {
    const idx = def.keys.indexOf(k);
    assert.strictEqual(def.types[idx], 'TEXT', k + ' 必須是 TEXT 型別');
    assert.ok((def.textFormatColumns || []).indexOf(k) !== -1, k + ' 必須在 textFormatColumns 內（強制純文字格式）');
  });
});

test('Fellowships 的 MEETING_DATE／MEETING_TIME 是 TEXT 型別（不是 DATE）', function () {
  const def = COLUMNS.FELLOWSHIPS;
  ['MEETING_DATE', 'MEETING_TIME'].forEach(function (k) {
    const idx = def.keys.indexOf(k);
    assert.strictEqual(def.types[idx], 'TEXT');
  });
});

// =====================================================================
// CONFIG_KEYS ⇄ DEFAULTS 一致性
// =====================================================================

test('DEFAULTS 內每一個 key 都在 CONFIG_KEYS 有定義，且 DEFAULTS 內部沒有重複 key', function () {
  const configKeyValues = Object.keys(CONFIG_KEYS).map(function (k) { return CONFIG_KEYS[k]; });
  const seen = {};
  DEFAULTS.forEach(function (d) {
    assert.ok(configKeyValues.indexOf(d.key) !== -1, 'DEFAULTS 的 key「' + d.key + '」不在 CONFIG_KEYS 內');
    assert.ok(!seen[d.key], 'DEFAULTS 的 key「' + d.key + '」重複出現');
    seen[d.key] = true;
  });
});

test('CONFIG_KEYS 每一個值都有對應的 DEFAULTS 項目（不會有「有鍵沒預設值」的落單設定）', function () {
  const defaultKeys = {};
  DEFAULTS.forEach(function (d) { defaultKeys[d.key] = true; });
  Object.keys(CONFIG_KEYS).forEach(function (k) {
    assert.ok(defaultKeys[CONFIG_KEYS[k]], 'CONFIG_KEYS.' + k + ' 沒有對應的 DEFAULTS 項目');
  });
});

test('DEFAULTS 剛好 63 筆（prompt1 的 29 ＋ prompt2 的 1 ＋ prompt3 的 9 ＋ prompt4 的 4 ＋ prompt5 的 7 ＋ prompt6 的 1 ＋ prompt7 的 6 ＋ prompt8 的 8 － prompt8b 刪除的 2）', function () {
  assert.strictEqual(DEFAULTS.length, 63);
});

test('prompt8b：DOC_TEMPLATE_ID_NORMAL／DOC_TEMPLATE_ID_COMBINED 兩個廢棄鍵已從 CONFIG_KEYS 與 DEFAULTS 移除', function () {
  assert.strictEqual(CONFIG_KEYS.DOC_TEMPLATE_ID_NORMAL, undefined);
  assert.strictEqual(CONFIG_KEYS.DOC_TEMPLATE_ID_COMBINED, undefined);
  DEFAULTS.forEach(function (d) {
    assert.notStrictEqual(d.key, 'DOC_TEMPLATE_ID_NORMAL');
    assert.notStrictEqual(d.key, 'DOC_TEMPLATE_ID_COMBINED');
  });
});

// =====================================================================
// 硬規則：ID／電郵類欄位一律 seed 成空字串
// =====================================================================

test('ID 類的 DEFAULTS 一律 seed 成空字串，不可以寫死真實值', function () {
  const idLikeKeys = [
    CONFIG_KEYS.ROSTER_SPREADSHEET_ID,
    CONFIG_KEYS.BULLETIN_OUTPUT_FOLDER_ID,
    // 第七輪新增的三個 Word 範本檔案 ID，同樣受這條硬規則約束
    CONFIG_KEYS.TEMPLATE_FILE_ID_NORMAL,
    CONFIG_KEYS.TEMPLATE_FILE_ID_COMBINED_BAPTISM,
    CONFIG_KEYS.TEMPLATE_FILE_ID_ANNIVERSARY
  ];
  const byKey = {};
  DEFAULTS.forEach(function (d) { byKey[d.key] = d.value; });
  idLikeKeys.forEach(function (k) {
    assert.strictEqual(byKey[k], '', k + ' 的預設值必須是空字串');
  });
});

test('DEFAULTS 內沒有任何一個值看起來像真實的 Google 試算表／雲端硬碟 ID（長度 25 字以上的英數字混合字串）', function () {
  const idShapePattern = /^[A-Za-z0-9_-]{25,}$/;
  DEFAULTS.forEach(function (d) {
    assert.ok(
      !idShapePattern.test(d.value),
      'DEFAULTS 的 key「' + d.key + '」的值「' + d.value + '」形狀很像真實 ID，必須是空字串'
    );
  });
});

// =====================================================================
// prompt8b 第 4 部分：cleanupDeprecatedConfigKeys_() 的一次性清理邏輯
// =====================================================================

/**
 * 用途：造一個具備 Config／AuditLog 兩張假工作表的 SpreadsheetApp，供
 *   cleanupDeprecatedConfigKeys_() 測試使用（它會讀寫 Config、並透過
 *   appendAuditLog_() 寫 AuditLog）。
 * Args:
 *   configRows {Object[]} Config 工作表的初始資料列（KEY／VALUE／NOTE／EDITABLE）。
 * Returns:
 *   {{sandbox:Object, configSheet:Object, auditSheet:Object}}
 */
function makeCleanupTestEnv_(configRows) {
  const sandboxForColumns = loadAllSrcFilesInOrder(GAS_STUBS);
  const configSheet = makeFakeSheet(
    sandboxForColumns.COLUMNS.CONFIG.headers, sandboxForColumns.COLUMNS.CONFIG.keys, configRows
  );
  const auditSheet = makeFakeSheet(
    sandboxForColumns.COLUMNS.AUDIT_LOG.headers, sandboxForColumns.COLUMNS.AUDIT_LOG.keys, []
  );
  const FakeApp = {
    getActiveSpreadsheet: function () {
      return makeFakeSpreadsheet({ Config: configSheet, AuditLog: auditSheet });
    }
  };
  const s = loadAllSrcFilesInOrder(Object.assign({}, GAS_STUBS, { SpreadsheetApp: FakeApp }));
  return { sandbox: s, configSheet: configSheet, auditSheet: auditSheet };
}

/**
 * 用途：把假 AuditLog 工作表目前的全部資料列讀成物件陣列，方便斷言。
 * Args:
 *   auditSheet {Object} makeFakeSheet() 造出的假 AuditLog 工作表。
 *   keys {string[]} AuditLog 的機器鍵順序。
 * Returns:
 *   {Object[]}
 */
function readFakeAuditRows_(auditSheet, keys) {
  const lastRow = auditSheet.getLastRow();
  if (lastRow < 3) return [];
  const raw = auditSheet.getRange(3, 1, lastRow - 2, keys.length).getValues();
  return raw.map(function (row) {
    const obj = {};
    keys.forEach(function (k, i) { obj[k] = row[i]; });
    return obj;
  });
}

test('cleanupDeprecatedConfigKeys_()：值為空的廢棄鍵會被刪除，並寫一筆 CONFIG_KEY_REMOVE', function () {
  const env = makeCleanupTestEnv_([
    { KEY: 'DRY_RUN', VALUE: 'TRUE', NOTE: '', EDITABLE: true },
    { KEY: 'DOC_TEMPLATE_ID_NORMAL', VALUE: '', NOTE: '', EDITABLE: true },
    { KEY: 'DOC_TEMPLATE_ID_COMBINED', VALUE: '', NOTE: '', EDITABLE: true }
  ]);

  const result = env.sandbox.cleanupDeprecatedConfigKeys_();

  assertArrayEqual(result.removed.slice().sort(), ['DOC_TEMPLATE_ID_COMBINED', 'DOC_TEMPLATE_ID_NORMAL']);
  assertArrayEqual(result.warnings, []);

  // Config 工作表應該只剩下 DRY_RUN 這一行資料。
  const remainingKeys = env.configSheet.getRange(3, 1, env.configSheet.getLastRow() - 2, 1)
    .getValues().map(function (r) { return r[0]; });
  assertArrayEqual(remainingKeys, ['DRY_RUN']);

  const auditRows = readFakeAuditRows_(env.auditSheet, env.sandbox.COLUMNS.AUDIT_LOG.keys);
  const removeRows = auditRows.filter(function (r) { return r.ACTION === 'CONFIG_KEY_REMOVE'; });
  assert.strictEqual(removeRows.length, 2, '兩個廢棄鍵都應該各寫一筆 CONFIG_KEY_REMOVE');
});

test('cleanupDeprecatedConfigKeys_()：值不為空的廢棄鍵不會被刪除，改為回傳警告', function () {
  const env = makeCleanupTestEnv_([
    { KEY: 'DRY_RUN', VALUE: 'TRUE', NOTE: '', EDITABLE: true },
    { KEY: 'DOC_TEMPLATE_ID_NORMAL', VALUE: '1AbCsomeRealLookingId', NOTE: '', EDITABLE: true },
    { KEY: 'DOC_TEMPLATE_ID_COMBINED', VALUE: '', NOTE: '', EDITABLE: true }
  ]);

  const result = env.sandbox.cleanupDeprecatedConfigKeys_();

  assertArrayEqual(result.removed, ['DOC_TEMPLATE_ID_COMBINED']);
  assert.strictEqual(result.warnings.length, 1);
  assert.ok(result.warnings[0].indexOf('DOC_TEMPLATE_ID_NORMAL') !== -1);

  // 有值的那一行必須保留，不可以被靜靜丟掉。
  const remainingKeys = env.configSheet.getRange(3, 1, env.configSheet.getLastRow() - 2, 1)
    .getValues().map(function (r) { return r[0]; });
  assert.ok(remainingKeys.indexOf('DOC_TEMPLATE_ID_NORMAL') !== -1, '有值的廢棄鍵不可以被刪除');

  const auditRows = readFakeAuditRows_(env.auditSheet, env.sandbox.COLUMNS.AUDIT_LOG.keys);
  const removeRows = auditRows.filter(function (r) { return r.ACTION === 'CONFIG_KEY_REMOVE'; });
  assert.strictEqual(removeRows.length, 1, '只有真的被刪除的那一個鍵才會寫 CONFIG_KEY_REMOVE');
  assert.strictEqual(removeRows[0].ROW_KEY, 'DOC_TEMPLATE_ID_COMBINED');
});

// =====================================================================

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
