#!/usr/bin/env node
/**
 * tests/rostersnapshot.test.js
 *
 * src/RosterRead.gs 的回歸測試。涵蓋純函式層 buildRosterSnapshot_()（用假
 * tables 直接測試，不需要 SpreadsheetApp）、parseRosterIdList_()，以及
 * 至少一個由真正入口 readRosterSnapshot_() 叫下去的案例（用假
 * SpreadsheetApp 替身，涵蓋 notConfigured 與正常路徑，也驗證同一次執行
 * 內會 memoize）。
 *
 * 執行方式：node tests/rostersnapshot.test.js
 * 離開碼：0＝全部通過　1＝有測試失敗
 */

'use strict';

const assert = require('assert');
const { loadAllSrcFilesInOrder } = require('./helpers/loadGas');

const GAS_STUBS = {
  Utilities: {
    formatDate: function (date) {
      var y = date.getFullYear();
      var m = String(date.getMonth() + 1).padStart(2, '0');
      var d = String(date.getDate()).padStart(2, '0');
      return y + '-' + m + '-' + d;
    }
  },
  Session: {
    getScriptTimeZone: function () { return 'Pacific/Auckland'; },
    getActiveUser: function () { return { getEmail: function () { return ''; } }; }
  },
  SpreadsheetApp: {},
  CacheService: {}
};

const sandbox = loadAllSrcFilesInOrder(GAS_STUBS);
const { buildRosterSnapshot_, parseRosterIdList_ } = sandbox;

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

/** 用 sandbox 自己的 normalizeDate_ 造 Date，避免 vm 的跨 realm instanceof 坑。 */
function d(iso) {
  return sandbox.normalizeDate_(iso);
}

function warningCodes(snapshot) {
  return snapshot.warnings.map(function (w) { return w.code; });
}

/**
 * ⚠️ 不能用 assert.deepStrictEqual 直接比較「sandbox 內建構出來的陣列」
 * 跟「這個測試檔案自己用陣列字面值寫的期望值」：兩者的 Array.prototype
 * 來自不同 vm realm，deepStrictEqual 連原型鏈都比，內容完全一樣也會判定
 * 不相等（同 tests/sheetutils.test.js 的 Date 坑是同一類問題）。用
 * JSON.stringify 轉成字串比較可以繞開，陣列內容都是純資料，足夠可靠。
 */
function assertArrayEqual(actual, expected, message) {
  assert.strictEqual(JSON.stringify(actual), JSON.stringify(expected), message);
}

// =====================================================================
// tables／各表資料列的建構小工具——只填測試會用到的欄位，其餘用合理預設值。
// =====================================================================

function assignmentRow(overrides) {
  return Object.assign({
    AssignmentID: 'A1', QuarterID: '2027T4', VersionNo: 1, ServiceDateID: 'SD1',
    ServiceDate: d('2027-10-03'), PostID: 'CHAIR', SlotIndex: 1, PersonID: 'P9001',
    PersonNameSnapshot: '陳大文', AssignSource: 'AUTO', RuleFlags: '',
    Locked: false, UpdatedAt: null, UpdatedBy: ''
  }, overrides || {});
}

function versionRow(overrides) {
  return Object.assign({
    VersionID: 'V1', QuarterID: '2027T4', VersionNo: 1, SheetName: 'V1',
    Basis: '', ParentVersionNo: null, Status: 'ACTIVE', Protected: false,
    WarningCount: 0, CreatedAt: null, CreatedBy: '', Notes: ''
  }, overrides || {});
}

function quarterRow(overrides) {
  return Object.assign({
    QuarterID: '2027T4', Year: 2027, Term: 'T4', StartDate: null, EndDate: null,
    WeekCount: 13, GenerateOn: null, OfficialSendOn: null, Status: 'ACTIVE',
    Notes: '', Stage: 'OFFICIAL_SENT', StageUpdatedAt: null
  }, overrides || {});
}

function serviceDateRow(overrides) {
  return Object.assign({
    ServiceDateID: 'SD1', QuarterID: '2027T4', ServiceDate: d('2027-10-03'), WeekIndex: 1,
    IsFirstSundayOfMonth: true, ServiceType: '主日崇拜', SpecialID: '', AutoGenerate: true, Notes: ''
  }, overrides || {});
}

function specialSundayRow(overrides) {
  return Object.assign({
    SpecialID: 'SP1', QuarterID: '2027T4', ServiceDate: d('2027-10-03'), Type: 'BAPTISM',
    Title: '十月主日（浸禮）', SkipPostIDs: '', LockPostIDs: '', ExternalOwner: '',
    CommunionOverride: '', TranslationRequired: false, Active: true, Notes: ''
  }, overrides || {});
}

function nameMappingRow(overrides) {
  return Object.assign({ PersonID: 'P9001', NameTC: '陳大文', Active: true }, overrides || {});
}

function postRow(overrides) {
  return Object.assign({
    PostID: 'CHAIR', PostName_TC: '主席', PostName_EN: 'Chair', SlotCount: 1,
    DistinctWithinPost: false, Category: '', Frequency: 'WEEKLY', AutoGenerate: true,
    AllowConsecutive: true, MutexGroup: '', DisplayOrder: 10, Active: true, Notes: '',
    EmptyDisplay: 'PENDING', EarlyArrivalMinutes: 0, RequiredRoles: ''
  }, overrides || {});
}

function makeTables(overrides) {
  return Object.assign({
    assignments: [], versions: [], quarters: [], serviceDates: [],
    specialSundays: [], nameMapping: [], posts: []
  }, overrides || {});
}

// =====================================================================
// 1. weekOfMonth 計算
// =====================================================================

test('weekOfMonth：1／7／8／14／15／28／29／31 日', function () {
  var cases = [
    ['2027-01-01', 1], ['2027-01-07', 1], ['2027-01-08', 2], ['2027-01-14', 2],
    ['2027-01-15', 3], ['2027-01-28', 4], ['2027-01-29', 5], ['2027-01-31', 5]
  ];
  cases.forEach(function (c) {
    var snap = buildRosterSnapshot_(makeTables(), c[0]);
    assert.strictEqual(snap.weekOfMonth, c[1], c[0] + ' 應該是第 ' + c[1] + ' 週');
  });
});

// =====================================================================
// 2. IsFirstSundayOfMonth 交叉核對
// =====================================================================

test('IsFirstSundayOfMonth 與自己算的結果不一致時，有 warning 而且沒有被覆蓋', function () {
  var tables = makeTables({
    serviceDates: [serviceDateRow({ ServiceDate: d('2027-10-10'), IsFirstSundayOfMonth: true })]
  });
  var snap = buildRosterSnapshot_(tables, '2027-10-10');
  assert.strictEqual(snap.weekOfMonth, 2, '不可以被職事表的值覆蓋成 1');
  assert.ok(warningCodes(snap).indexOf('WEEK_OF_MONTH_MISMATCH') !== -1);
});

test('IsFirstSundayOfMonth 與自己算的結果一致時，沒有 mismatch warning', function () {
  var tables = makeTables({
    serviceDates: [serviceDateRow({ ServiceDate: d('2027-10-03'), IsFirstSundayOfMonth: true })]
  });
  var snap = buildRosterSnapshot_(tables, '2027-10-03');
  assert.ok(warningCodes(snap).indexOf('WEEK_OF_MONTH_MISMATCH') === -1);
});

// =====================================================================
// 3. 找不到日期
// =====================================================================

test('找不到日期 → found:false，ok 仍然是 true', function () {
  var snap = buildRosterSnapshot_(makeTables(), '2027-11-11');
  assert.strictEqual(snap.found, false);
  assert.strictEqual(snap.ok, true);
  assert.ok(warningCodes(snap).indexOf('SERVICE_DATE_NOT_FOUND') !== -1);
});

// =====================================================================
// 4. 該季無版本
// =====================================================================

test('該季在 RosterVersions 沒有任何版本 → versionNo:null、assignments 空、有 warning', function () {
  var tables = makeTables({
    serviceDates: [serviceDateRow()],
    quarters: [quarterRow()],
    versions: []
  });
  var snap = buildRosterSnapshot_(tables, '2027-10-03');
  assert.strictEqual(snap.versionNo, null);
  assertArrayEqual(snap.assignments, []);
  assert.ok(warningCodes(snap).indexOf('NO_VERSION_GENERATED') !== -1);
});

// =====================================================================
// 5. Stage 不是 OFFICIAL_SENT
// =====================================================================

test('Stage 不是 OFFICIAL_SENT → isOfficial:false 且有 warning', function () {
  var tables = makeTables({
    serviceDates: [serviceDateRow()],
    quarters: [quarterRow({ Stage: 'DRAFT' })],
    versions: [versionRow()]
  });
  var snap = buildRosterSnapshot_(tables, '2027-10-03');
  assert.strictEqual(snap.isOfficial, false);
  assert.strictEqual(snap.quarterStage, 'DRAFT');
  assert.ok(warningCodes(snap).indexOf('NOT_OFFICIAL') !== -1);
});

test('Stage 是 OFFICIAL_SENT → isOfficial:true 且沒有 NOT_OFFICIAL warning', function () {
  var tables = makeTables({
    serviceDates: [serviceDateRow()],
    quarters: [quarterRow({ Stage: 'OFFICIAL_SENT' })],
    versions: [versionRow()]
  });
  var snap = buildRosterSnapshot_(tables, '2027-10-03');
  assert.strictEqual(snap.isOfficial, true);
  assert.ok(warningCodes(snap).indexOf('NOT_OFFICIAL') === -1);
});

// =====================================================================
// 6. PersonID 找不到
// =====================================================================

test('PersonID 在 NameMapping 找不到 → 用 PersonNameSnapshot、有 warning', function () {
  var tables = makeTables({
    serviceDates: [serviceDateRow()],
    quarters: [quarterRow()],
    versions: [versionRow()],
    assignments: [assignmentRow({ PersonID: 'P9999', PersonNameSnapshot: '張三' })],
    nameMapping: []
  });
  var snap = buildRosterSnapshot_(tables, '2027-10-03');
  assert.strictEqual(snap.assignments.length, 1);
  assert.strictEqual(snap.assignments[0].personId, 'P9999');
  assert.strictEqual(snap.assignments[0].personName, '張三');
  assert.ok(warningCodes(snap).indexOf('PERSON_NOT_FOUND_IN_NAME_MAPPING') !== -1);
});

// =====================================================================
// 7. PersonNameSnapshot 是佔位符
// =====================================================================

['待確認', '—', '⚠ 未能安排'].forEach(function (placeholder) {
  test('PersonNameSnapshot 是「' + placeholder + '」→ personId 為 null、有分類 warning', function () {
    var tables = makeTables({
      serviceDates: [serviceDateRow()],
      quarters: [quarterRow()],
      versions: [versionRow()],
      assignments: [assignmentRow({ PersonID: '', PersonNameSnapshot: placeholder })],
      nameMapping: []
    });
    var snap = buildRosterSnapshot_(tables, '2027-10-03');
    assert.strictEqual(snap.assignments[0].personId, null);
    assert.strictEqual(snap.assignments[0].personName, placeholder);
    assert.ok(warningCodes(snap).indexOf('PERSON_PLACEHOLDER') !== -1);
  });
});

// =====================================================================
// 8. SkipPostIDs 解析
// =====================================================================

test('parseRosterIdList_：空字串、單一值、逗號分隔、含空白、含全形逗號', function () {
  assertArrayEqual(parseRosterIdList_(''), []);
  assertArrayEqual(parseRosterIdList_(null), []);
  assertArrayEqual(parseRosterIdList_(undefined), []);
  assertArrayEqual(parseRosterIdList_('USHER'), ['USHER']);
  assertArrayEqual(parseRosterIdList_('USHER,COUNT'), ['USHER', 'COUNT']);
  assertArrayEqual(parseRosterIdList_('USHER, COUNT ,  PIANO'), ['USHER', 'COUNT', 'PIANO']);
  assertArrayEqual(parseRosterIdList_('USHER，COUNT'), ['USHER', 'COUNT']);
});

test('special 物件的 skipPostIds／lockPostIds 真的有經過 parseRosterIdList_ 解析', function () {
  var tables = makeTables({
    serviceDates: [serviceDateRow({ SpecialID: 'SP1' })],
    quarters: [quarterRow()],
    versions: [versionRow()],
    specialSundays: [specialSundayRow({ SkipPostIDs: 'USHER，COUNT', LockPostIDs: ' PIANO ' })]
  });
  var snap = buildRosterSnapshot_(tables, '2027-10-03');
  assert.ok(snap.special);
  assertArrayEqual(snap.special.skipPostIds, ['USHER', 'COUNT']);
  assertArrayEqual(snap.special.lockPostIds, ['PIANO']);
});

// =====================================================================
// 9. 由真正入口 readRosterSnapshot_() 叫下去（假 SpreadsheetApp 替身）
// =====================================================================

/**
 * 用途：造一個唯讀為主、但也支援 ensureSheet_() 會用到的少數幾個寫入
 *   方法（setValues／setFontWeight／setBackground／setFrozenRows）的假
 *   Sheet。RosterRead.gs 本身完全不會呼叫這些方法（tools/lint-readonly-roster.js
 *   已經鎖死），但 getConfig() 內部的 loadConfigCache_() 每次都會先呼叫
 *   ensureSheet_(ss,'CONFIG') 確保標題正確，所以「own」試算表（`Config`
 *   工作表所在的那個）需要一個支援得到寫入呼叫的假 Sheet；職事表那邊
 *   （openById 開出來的假試算表）則完全不會被寫，純讀取也夠用。
 */
function makeFakeSheet(headers, keys, rowObjects) {
  var data = [headers, keys].concat(rowObjects.map(function (obj) {
    return keys.map(function (k) { return obj[k] === undefined ? '' : obj[k]; });
  }));
  var frozenRows = 0;
  return {
    getLastRow: function () { return data.length; },
    getLastColumn: function () { return keys.length; },
    getMaxRows: function () { return Math.max(data.length, 1000); },
    getFrozenRows: function () { return frozenRows; },
    setFrozenRows: function (n) { frozenRows = n; },
    getRange: function (r, c, numRows, numCols) {
      numRows = numRows || 1;
      numCols = numCols || 1;
      return {
        getValues: function () {
          var out = [];
          for (var i = 0; i < numRows; i++) {
            var rowIdx = r - 1 + i;
            var rowArr = [];
            for (var j = 0; j < numCols; j++) {
              var colIdx = c - 1 + j;
              var srcRow = data[rowIdx];
              rowArr.push(srcRow && srcRow[colIdx] !== undefined ? srcRow[colIdx] : '');
            }
            out.push(rowArr);
          }
          return out;
        },
        setValues: function (values) {
          for (var i = 0; i < values.length; i++) {
            var rowIdx = r - 1 + i;
            while (data.length <= rowIdx) data.push([]);
            for (var j = 0; j < values[i].length; j++) {
              data[rowIdx][c - 1 + j] = values[i][j];
            }
          }
          return this;
        },
        setFontWeight: function () { return this; },
        setBackground: function () { return this; },
        setNumberFormat: function () { return this; }
      };
    }
  };
}

function makeFakeSpreadsheet(sheetsByName) {
  return { getSheetByName: function (name) { return sheetsByName[name] || null; } };
}

/** 用 ROSTER_TABLE_DEFS_ 的機器鍵組出一張假的職事表工作表，不用手key 一次全部欄位名稱。 */
function makeRosterSheetFromDef(defKey, rowObjects) {
  var def = sandbox.ROSTER_TABLE_DEFS_[defKey];
  var keys = Object.keys(def.columns);
  return makeFakeSheet(keys, keys, rowObjects);
}

function makeConfigSheet(rows) {
  return makeFakeSheet(sandbox.COLUMNS.CONFIG.headers, sandbox.COLUMNS.CONFIG.keys, rows);
}

var FAKE_ROSTER_ID = 'FAKE_ROSTER_SPREADSHEET_ID_FOR_TEST_0001';

function fullConfigRows(rosterId) {
  return [
    { KEY: 'ROSTER_SPREADSHEET_ID', VALUE: rosterId, NOTE: '', EDITABLE: true },
    { KEY: 'ROSTER_SHEET_ASSIGNMENTS', VALUE: 'RosterAssignments', NOTE: '', EDITABLE: true },
    { KEY: 'ROSTER_SHEET_VERSIONS', VALUE: 'RosterVersions', NOTE: '', EDITABLE: true },
    { KEY: 'ROSTER_SHEET_QUARTERS', VALUE: 'Quarters', NOTE: '', EDITABLE: true },
    { KEY: 'ROSTER_SHEET_SERVICE_DATES', VALUE: 'ServiceDates', NOTE: '', EDITABLE: true },
    { KEY: 'ROSTER_SHEET_SPECIAL_SUNDAYS', VALUE: 'SpecialSundays', NOTE: '', EDITABLE: true },
    { KEY: 'ROSTER_SHEET_NAME_MAPPING', VALUE: 'NameMapping', NOTE: '', EDITABLE: true },
    { KEY: 'ROSTER_SHEET_POSTS', VALUE: 'Posts', NOTE: '', EDITABLE: true }
  ];
}

function makeRosterSheets() {
  return {
    RosterAssignments: makeRosterSheetFromDef('ASSIGNMENTS', [
      {
        AssignmentID: 'A1', QuarterID: '2027T4', VersionNo: 1, ServiceDateID: 'SD-2027-10-03',
        ServiceDate: '2027-10-03', PostID: 'CHAIR', SlotIndex: 1, PersonID: 'P9001',
        PersonNameSnapshot: '陳大文', AssignSource: 'AUTO', RuleFlags: '', Locked: false,
        UpdatedAt: '2027-09-01', UpdatedBy: 'system'
      }
    ]),
    RosterVersions: makeRosterSheetFromDef('VERSIONS', [
      {
        VersionID: 'V1', QuarterID: '2027T4', VersionNo: 1, SheetName: 'V1', Basis: '',
        ParentVersionNo: '', Status: 'ACTIVE', Protected: false, WarningCount: 0,
        CreatedAt: '2027-09-01', CreatedBy: 'system', Notes: ''
      }
    ]),
    Quarters: makeRosterSheetFromDef('QUARTERS', [
      {
        QuarterID: '2027T4', Year: 2027, Term: 'T4', StartDate: '2027-10-03', EndDate: '2027-12-26',
        WeekCount: 13, GenerateOn: '2027-09-01', OfficialSendOn: '2027-09-15', Status: 'ACTIVE',
        Notes: '', Stage: 'OFFICIAL_SENT', StageUpdatedAt: '2027-09-15'
      }
    ]),
    ServiceDates: makeRosterSheetFromDef('SERVICE_DATES', [
      {
        ServiceDateID: 'SD-2027-10-03', QuarterID: '2027T4', ServiceDate: '2027-10-03', WeekIndex: 1,
        IsFirstSundayOfMonth: true, ServiceType: '主日崇拜', SpecialID: '', AutoGenerate: true, Notes: ''
      }
    ]),
    SpecialSundays: makeRosterSheetFromDef('SPECIAL_SUNDAYS', []),
    NameMapping: makeRosterSheetFromDef('NAME_MAPPING', [
      { PersonID: 'P9001', NameTC: '陳大文', Active: true }
    ]),
    Posts: makeRosterSheetFromDef('POSTS', [
      {
        PostID: 'CHAIR', PostName_TC: '主席', PostName_EN: 'Chair', SlotCount: 1,
        DistinctWithinPost: false, Category: '', Frequency: 'WEEKLY', AutoGenerate: true,
        AllowConsecutive: true, MutexGroup: '', DisplayOrder: 10, Active: true, Notes: '',
        EmptyDisplay: 'PENDING', EarlyArrivalMinutes: 0, RequiredRoles: ''
      }
    ])
  };
}

test('readRosterSnapshot_()：ROSTER_SPREADSHEET_ID 未設定 → notConfigured，不會呼叫 openById', function () {
  var openByIdCalled = false;
  var FakeApp = {
    getActiveSpreadsheet: function () {
      return makeFakeSpreadsheet({ Config: makeConfigSheet(fullConfigRows('')) });
    },
    openById: function () { openByIdCalled = true; throw new Error('不應該被呼叫'); }
  };
  var s = loadAllSrcFilesInOrder(Object.assign({}, GAS_STUBS, { SpreadsheetApp: FakeApp }));
  var snap = s.readRosterSnapshot_('2027-10-03');
  assert.strictEqual(snap.notConfigured, true);
  assert.strictEqual(snap.ok, false);
  assert.strictEqual(openByIdCalled, false);
});

test('readRosterSnapshot_()：正常路徑（假 SpreadsheetApp），並且同一次執行內第二次呼叫不重新讀試算表', function () {
  var openByIdCallCount = 0;
  var rosterSheets = makeRosterSheets();
  var FakeApp = {
    getActiveSpreadsheet: function () {
      return makeFakeSpreadsheet({ Config: makeConfigSheet(fullConfigRows(FAKE_ROSTER_ID)) });
    },
    openById: function (id) {
      openByIdCallCount++;
      if (id !== FAKE_ROSTER_ID) throw new Error('openById: 未預期的 id ' + id);
      return makeFakeSpreadsheet(rosterSheets);
    }
  };
  var s = loadAllSrcFilesInOrder(Object.assign({}, GAS_STUBS, { SpreadsheetApp: FakeApp }));

  var snap = s.readRosterSnapshot_('2027-10-03');
  assert.strictEqual(snap.ok, true);
  assert.strictEqual(snap.notConfigured, false);
  assert.strictEqual(snap.found, true);
  assert.strictEqual(snap.quarterId, '2027T4');
  assert.strictEqual(snap.quarterStage, 'OFFICIAL_SENT');
  assert.strictEqual(snap.isOfficial, true);
  assert.strictEqual(snap.versionNo, 1);
  assert.strictEqual(snap.weekOfMonth, 1);
  assert.strictEqual(snap.assignments.length, 1);
  assert.strictEqual(snap.assignments[0].personName, '陳大文');
  assert.strictEqual(snap.posts.length, 1);
  assert.strictEqual(openByIdCallCount, 1);

  // 第二次呼叫（同一個 sandbox＝同一次「執行」）：不應該再呼叫 openById。
  var snap2 = s.readRosterSnapshot_('2027-10-03');
  assert.strictEqual(snap2.found, true);
  assert.strictEqual(openByIdCallCount, 1, 'memoize 應該讓第二次呼叫不用重新開試算表');
});

// =====================================================================
// 10. 只取該季最大 VersionNo 的派工紀錄
// =====================================================================

test('只取該季最大 VersionNo 的派工紀錄，較舊版本的資料不會混進來', function () {
  var tables = makeTables({
    serviceDates: [serviceDateRow()],
    quarters: [quarterRow()],
    versions: [versionRow({ VersionID: 'V1', VersionNo: 1 }), versionRow({ VersionID: 'V2', VersionNo: 2 })],
    assignments: [
      assignmentRow({ VersionNo: 1, PostID: 'CHAIR', PersonNameSnapshot: '舊版本人選', PersonID: '' }),
      assignmentRow({ VersionNo: 2, PostID: 'CHAIR', PersonNameSnapshot: '新版本人選', PersonID: '' })
    ],
    nameMapping: []
  });
  var snap = buildRosterSnapshot_(tables, '2027-10-03');
  assert.strictEqual(snap.versionNo, 2);
  assert.strictEqual(snap.assignments.length, 1);
  assert.strictEqual(snap.assignments[0].personName, '新版本人選');
});

// =====================================================================

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
