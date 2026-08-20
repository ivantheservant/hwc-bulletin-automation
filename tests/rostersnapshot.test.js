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
const { makeFakeSheet, makeFakeSpreadsheet } = require('./helpers/fakeSpreadsheet');

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

// makeFakeSheet／makeFakeSpreadsheet 搬到 tests/helpers/fakeSpreadsheet.js
// 了——tests/configcache.test.js 也需要一模一樣的假 Sheet／Spreadsheet，
// 抽出來共用，避免兩個測試檔案各自維護一份容易長歪的實作。

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
// Prompt2b：白名單欄位＋寬鬆解析（職事表事故二的回歸測試）
// =====================================================================

test('Prompt2b-1：Posts.AllowConsecutive 是 "ALLOW"（職事表的列舉值）不會造成任何錯誤，因為根本不在白名單內', function () {
  var postsKeys = Object.keys(sandbox.ROSTER_TABLE_DEFS_.POSTS.columns);
  var extraKeys = postsKeys.concat(['AllowConsecutive']);
  var rosterSheets = makeRosterSheets();
  rosterSheets.Posts = makeFakeSheet(extraKeys, extraKeys, [
    Object.assign(
      {
        PostID: 'CHAIR', PostName_TC: '主席', SlotCount: 1, Frequency: 'WEEKLY',
        AutoGenerate: true, DisplayOrder: 10, Active: true, EmptyDisplay: 'PENDING'
      },
      { AllowConsecutive: 'ALLOW' } // 職事表的真實取值：ALLOW／BLOCK／WARN，不是 boolean
    )
  ]);
  var FakeApp = {
    getActiveSpreadsheet: function () { return makeFakeSpreadsheet({ Config: makeConfigSheet(fullConfigRows(FAKE_ROSTER_ID)) }); },
    openById: function (id) { return makeFakeSpreadsheet(rosterSheets); }
  };
  var s = loadAllSrcFilesInOrder(Object.assign({}, GAS_STUBS, { SpreadsheetApp: FakeApp }));
  var snap = s.readRosterSnapshot_('2027-10-03');
  assert.strictEqual(snap.ok, true, 'AllowConsecutive=ALLOW 不應該讓整個讀取失敗');
  assert.strictEqual(snap.posts.length, 1);
  assert.strictEqual(snap.posts[0].postId, 'CHAIR');
});

test('Prompt2b-2：職事表多出一個未知欄位 SomeNewColumn → 讀取成功，沒有任何 warning', function () {
  var postsKeys = Object.keys(sandbox.ROSTER_TABLE_DEFS_.POSTS.columns);
  var extraKeys = postsKeys.concat(['SomeNewColumn']);
  var rosterSheets = makeRosterSheets();
  rosterSheets.Posts = makeFakeSheet(extraKeys, extraKeys, [
    Object.assign(
      {
        PostID: 'CHAIR', PostName_TC: '主席', SlotCount: 1, Frequency: 'WEEKLY',
        AutoGenerate: true, DisplayOrder: 10, Active: true, EmptyDisplay: 'PENDING'
      },
      { SomeNewColumn: '職事表日後新加的欄位' }
    )
  ]);
  var FakeApp = {
    getActiveSpreadsheet: function () { return makeFakeSpreadsheet({ Config: makeConfigSheet(fullConfigRows(FAKE_ROSTER_ID)) }); },
    openById: function (id) { return makeFakeSpreadsheet(rosterSheets); }
  };
  var s = loadAllSrcFilesInOrder(Object.assign({}, GAS_STUBS, { SpreadsheetApp: FakeApp }));
  var snap = s.readRosterSnapshot_('2027-10-03');
  assert.strictEqual(snap.ok, true);
  assert.strictEqual(snap.posts.length, 1);
  assert.ok(warningCodes(snap).indexOf('ROSTER_VALUE_UNPARSEABLE') === -1, '多出來的欄位不應該產生任何警告');
});

test('Prompt2b-3：白名單欄位缺失（Posts 沒有 PostID）→ 拋錯，訊息列出缺少的欄名', function () {
  var postsKeys = Object.keys(sandbox.ROSTER_TABLE_DEFS_.POSTS.columns).filter(function (k) { return k !== 'PostID'; });
  var rosterSheets = makeRosterSheets();
  rosterSheets.Posts = makeFakeSheet(postsKeys, postsKeys, [
    { PostName_TC: '主席', SlotCount: 1, Frequency: 'WEEKLY', AutoGenerate: true, DisplayOrder: 10, Active: true, EmptyDisplay: 'PENDING' }
  ]);
  var FakeApp = {
    getActiveSpreadsheet: function () { return makeFakeSpreadsheet({ Config: makeConfigSheet(fullConfigRows(FAKE_ROSTER_ID)) }); },
    openById: function (id) { return makeFakeSpreadsheet(rosterSheets); }
  };
  var s = loadAllSrcFilesInOrder(Object.assign({}, GAS_STUBS, { SpreadsheetApp: FakeApp }));
  assert.throws(function () { s.readRosterSnapshot_('2027-10-03'); }, function (err) {
    return err.message.indexOf('PostID') !== -1;
  });
});

test('Prompt2b-4：寬鬆布林 rosterIsTrueValue_ 跟職事表語意完全一致，永不拋錯', function () {
  var rosterIsTrueValue_ = sandbox.rosterIsTrueValue_;
  [true, 'TRUE', 'true', ' TRUE '].forEach(function (v) {
    assert.strictEqual(rosterIsTrueValue_(v), true, 'expected true for ' + JSON.stringify(v));
  });
  [false, 'FALSE', '', null, undefined, '是', '1', 'Y', 'ALLOW'].forEach(function (v) {
    assert.strictEqual(rosterIsTrueValue_(v), false, 'expected false for ' + JSON.stringify(v));
  });
});

test('Prompt2b-5：SlotIndex 是 "abc" → null 且有 warning，不拋錯', function () {
  var warnings = [];
  var result = sandbox.rosterToIntLenient_('abc', { sheet: 'Posts', key: 'SlotIndex', row: 5 }, warnings);
  assert.strictEqual(result, null);
  assert.strictEqual(warnings.length, 1);
  assert.strictEqual(warnings[0].code, 'ROSTER_VALUE_UNPARSEABLE');
});

test('Prompt2b-6：ServiceDate 無法解析 → 回 null 並記 warning，不拋錯；該列在比對日期時自動被略過', function () {
  var warnings = [];
  var result = sandbox.rosterToDateLenient_('不是日期', { sheet: 'ServiceDates', key: 'ServiceDate', row: 5 }, warnings);
  assert.strictEqual(result, null);
  assert.strictEqual(warnings.length, 1);
  assert.strictEqual(warnings[0].code, 'ROSTER_VALUE_UNPARSEABLE');

  // ServiceDate 解析失敗後會是 null，buildRosterSnapshot_ 應該當成「配不到日期」處理，不拋錯。
  var tables = makeTables({ serviceDates: [serviceDateRow({ ServiceDate: null })] });
  var snap = buildRosterSnapshot_(tables, '2027-10-03');
  assert.strictEqual(snap.found, false);
  assert.ok(warningCodes(snap).indexOf('SERVICE_DATE_NOT_FOUND') !== -1);
});

test('Prompt2b-7：SpecialSundays.Active 空白 → 該列視為 inactive（與職事表行為一致），不當成「找不到」', function () {
  var tables = makeTables({
    serviceDates: [serviceDateRow({ SpecialID: 'SP1' })],
    quarters: [quarterRow()],
    versions: [versionRow()],
    specialSundays: [specialSundayRow({ Active: false })] // 空白經 rosterIsTrueValue_ 正規化後就是 false
  });
  var snap = buildRosterSnapshot_(tables, '2027-10-03');
  assert.strictEqual(snap.special, null, 'inactive 的特別主日不生效');
});

// =====================================================================
// Prompt3：特別主日按日期比對（事故四）
// =====================================================================

test('Prompt3-1：SpecialID 空白但日期對得上 → 照樣找得到特別主日', function () {
  var tables = makeTables({
    // ⚠️ ServiceDates.SpecialID 是空的——實際資料就是這樣，職事表從來不用它。
    serviceDates: [serviceDateRow({ SpecialID: '' })],
    quarters: [quarterRow()],
    versions: [versionRow()],
    specialSundays: [specialSundayRow({ SpecialID: 'SP1', ServiceDate: d('2027-10-03'), Title: '十月主日（浸禮）' })]
  });
  var snap = buildRosterSnapshot_(tables, '2027-10-03');
  assert.ok(snap.special, '應該按日期查到，不可以因為 SpecialID 空白就當成沒有特別主日');
  assert.strictEqual(snap.special.title, '十月主日（浸禮）');
  assert.strictEqual(snap.special.specialId, 'SP1');
});

test('Prompt3-2：日期對不上 → 沒有特別主日', function () {
  var tables = makeTables({
    serviceDates: [serviceDateRow({ ServiceDate: d('2027-10-10'), SpecialID: '' })],
    quarters: [quarterRow()],
    versions: [versionRow()],
    specialSundays: [specialSundayRow({ ServiceDate: d('2027-10-03') })]
  });
  var snap = buildRosterSnapshot_(tables, '2027-10-10');
  assert.strictEqual(snap.special, null);
});

test('Prompt3-3：special.title 取值照抄職事表——Title 有值用 Title，否則用 Type', function () {
  function titleFor(overrides) {
    var tables = makeTables({
      serviceDates: [serviceDateRow({ SpecialID: '' })],
      quarters: [quarterRow()],
      versions: [versionRow()],
      specialSundays: [specialSundayRow(overrides)]
    });
    var snap = buildRosterSnapshot_(tables, '2027-10-03');
    return snap.special ? snap.special.title : null;
  }
  assert.strictEqual(titleFor({ Title: '十月主日（浸禮）', Type: 'BAPTISM' }), '十月主日（浸禮）');
  assert.strictEqual(titleFor({ Title: '', Type: 'BAPTISM' }), 'BAPTISM', 'Title 空白時退回 Type');
});

test('Prompt3-4：SpecialID 有值但與按日期查到的不一致 → 記 SPECIAL_SUNDAY_ID_MISMATCH，仍以日期為準', function () {
  var tables = makeTables({
    serviceDates: [serviceDateRow({ SpecialID: 'SP_OLD' })],
    quarters: [quarterRow()],
    versions: [versionRow()],
    specialSundays: [specialSundayRow({ SpecialID: 'SP_NEW', Title: '按日期查到的' })]
  });
  var snap = buildRosterSnapshot_(tables, '2027-10-03');
  assert.strictEqual(snap.special.specialId, 'SP_NEW', '一律以日期為準');
  assert.ok(warningCodes(snap).indexOf('SPECIAL_SUNDAY_ID_MISMATCH') !== -1);
});

test('Prompt3-5：SpecialID 與按日期查到的一致 → 沒有 mismatch 警告', function () {
  var tables = makeTables({
    serviceDates: [serviceDateRow({ SpecialID: 'SP1' })],
    quarters: [quarterRow()],
    versions: [versionRow()],
    specialSundays: [specialSundayRow({ SpecialID: 'SP1' })]
  });
  var snap = buildRosterSnapshot_(tables, '2027-10-03');
  assert.ok(warningCodes(snap).indexOf('SPECIAL_SUNDAY_ID_MISMATCH') === -1);
});

test('Prompt3-6：日期索引只收同一季度的資料列', function () {
  var tables = makeTables({
    serviceDates: [serviceDateRow({ QuarterID: '2027T4', SpecialID: '' })],
    quarters: [quarterRow({ QuarterID: '2027T4' })],
    versions: [versionRow({ QuarterID: '2027T4' })],
    specialSundays: [specialSundayRow({ QuarterID: '2027T3', Title: '別季的' })]
  });
  var snap = buildRosterSnapshot_(tables, '2027-10-03');
  assert.strictEqual(snap.special, null, '別季的特別主日不應該被套用');
});

// =====================================================================
// Prompt3：四種 slot 狀態的判斷與優先級（事故五）
// =====================================================================

test('Prompt3-state：ASSIGNED——有人名', function () {
  assert.strictEqual(sandbox.resolveRosterSlotState_({
    postId: 'CHAIR', personName: '陳大文', frequency: 'WEEKLY',
    weekOfMonth: 1, communionWeeks: [1], skipPostIds: [], externalOwner: ''
  }), 'ASSIGNED');
});

test('Prompt3-state：PENDING——有 slot 但沒有人名', function () {
  assert.strictEqual(sandbox.resolveRosterSlotState_({
    postId: 'PREACHER', personName: '', frequency: 'WEEKLY',
    weekOfMonth: 1, communionWeeks: [1], skipPostIds: [], externalOwner: ''
  }), 'PENDING');
});

test('Prompt3-state：NOT_APPLICABLE——FIRST_SUNDAY 崗位而本週不是聖餐週', function () {
  assert.strictEqual(sandbox.resolveRosterSlotState_({
    postId: 'COMMUNION', personName: '', frequency: 'FIRST_SUNDAY',
    weekOfMonth: 2, communionWeeks: [1], skipPostIds: [], externalOwner: ''
  }), 'NOT_APPLICABLE');
});

test('Prompt3-state：FIRST_SUNDAY 崗位在聖餐週 → 不是 NOT_APPLICABLE', function () {
  assert.strictEqual(sandbox.resolveRosterSlotState_({
    postId: 'COMMUNION', personName: '甲', frequency: 'FIRST_SUNDAY',
    weekOfMonth: 1, communionWeeks: [1], skipPostIds: [], externalOwner: ''
  }), 'ASSIGNED');
});

test('Prompt3-state：NOT_APPLICABLE——在 skipPostIds 內而 externalOwner 為空', function () {
  assert.strictEqual(sandbox.resolveRosterSlotState_({
    postId: 'USHER', personName: '甲', frequency: 'WEEKLY',
    weekOfMonth: 1, communionWeeks: [1], skipPostIds: ['USHER'], externalOwner: ''
  }), 'NOT_APPLICABLE');
});

test('Prompt3-state：EXTERNAL——在 skipPostIds 內而 externalOwner 有值', function () {
  assert.strictEqual(sandbox.resolveRosterSlotState_({
    postId: 'WORSHIP', personName: '', frequency: 'WEEKLY',
    weekOfMonth: 1, communionWeeks: [1], skipPostIds: ['WORSHIP'], externalOwner: '英語堂敬拜隊'
  }), 'EXTERNAL');
});

test('Prompt3-state 優先級：結構性不適用勝過 EXTERNAL', function () {
  assert.strictEqual(sandbox.resolveRosterSlotState_({
    postId: 'COMMUNION', personName: '甲', frequency: 'FIRST_SUNDAY',
    weekOfMonth: 2, communionWeeks: [1], skipPostIds: ['COMMUNION'], externalOwner: '英語堂'
  }), 'NOT_APPLICABLE', '這一週根本不設這個崗位，就算有外判單位也不應該顯示');
});

test('Prompt3-state 優先級：EXTERNAL 勝過 ASSIGNED', function () {
  assert.strictEqual(sandbox.resolveRosterSlotState_({
    postId: 'WORSHIP', personName: '陳大文', frequency: 'WEEKLY',
    weekOfMonth: 1, communionWeeks: [1], skipPostIds: ['WORSHIP'], externalOwner: '英語堂敬拜隊'
  }), 'EXTERNAL', '外判崗位就算職事表留了人名，顯示的仍然是負責單位');
});

test('Prompt3-state 優先級：ASSIGNED 勝過 PENDING（有人名就不算待填）', function () {
  assert.strictEqual(sandbox.resolveRosterSlotState_({
    postId: 'CHAIR', personName: '陳大文', frequency: 'WEEKLY',
    weekOfMonth: 1, communionWeeks: [1], skipPostIds: [], externalOwner: ''
  }), 'ASSIGNED');
});

test('Prompt3-slots：完全沒有派工紀錄的崗位也會有一個 slot（分得清「不適用」與「待填」）', function () {
  var snapshot = {
    isoDate: '2027-10-10', weekOfMonth: 2, special: null,
    posts: [
      { postId: 'PREACHER', frequency: 'WEEKLY' },
      { postId: 'COMMUNION', frequency: 'FIRST_SUNDAY' }
    ],
    assignments: []
  };
  var slots = sandbox.buildRosterSlotIndex_(snapshot, [1]);
  assert.strictEqual(slots.PREACHER.length, 1);
  assert.strictEqual(slots.PREACHER[0].state, 'PENDING', '崗位存在、等人填');
  assert.strictEqual(slots.COMMUNION.length, 1);
  assert.strictEqual(slots.COMMUNION[0].state, 'NOT_APPLICABLE', '這一週根本不設這個崗位');
});

test('Prompt3-slots：EXTERNAL 的 slot 會帶上 externalOwner，其餘 slot 是空字串', function () {
  var snapshot = {
    isoDate: '2027-10-03', weekOfMonth: 1,
    special: { skipPostIds: ['WORSHIP'], externalOwner: '英語堂敬拜隊' },
    posts: [{ postId: 'WORSHIP', frequency: 'WEEKLY' }, { postId: 'CHAIR', frequency: 'WEEKLY' }],
    assignments: [{ postId: 'CHAIR', slotIndex: 1, personId: 'P9001', personName: '陳大文', assignSource: '', locked: false }]
  };
  var slots = sandbox.buildRosterSlotIndex_(snapshot, [1]);
  assert.strictEqual(slots.WORSHIP[0].externalOwner, '英語堂敬拜隊');
  assert.strictEqual(slots.CHAIR[0].externalOwner, '');
});

test('Prompt3-slots：readRosterSnapshot_ 出來的快照有 slotsByPost，且 assignments 一併帶 state', function () {
  var tables = makeTables({
    serviceDates: [serviceDateRow()],
    quarters: [quarterRow()],
    versions: [versionRow()],
    assignments: [assignmentRow({ PostID: 'CHAIR', PersonID: 'P9001', PersonNameSnapshot: '陳大文' })],
    nameMapping: [nameMappingRow()],
    posts: [postRow({ PostID: 'CHAIR' })]
  });
  var snap = buildRosterSnapshot_(tables, '2027-10-03', { communionWeeks: [1] });
  assert.ok(snap.slotsByPost, '快照應該有 slotsByPost');
  assert.strictEqual(snap.slotsByPost.CHAIR[0].state, 'ASSIGNED');
  assert.strictEqual(snap.slotsByPost.CHAIR[0].personName, '陳大文');
});

test('Prompt3-slots：communionWeeks 由呼叫方傳入（沒有寫死首主日）', function () {
  var tables = makeTables({
    serviceDates: [serviceDateRow({ ServiceDate: d('2027-10-10') })],
    quarters: [quarterRow()],
    versions: [versionRow()],
    posts: [postRow({ PostID: 'COMMUNION', Frequency: 'FIRST_SUNDAY' })]
  });
  var withWeek1 = buildRosterSnapshot_(tables, '2027-10-10', { communionWeeks: [1] });
  assert.strictEqual(withWeek1.slotsByPost.COMMUNION[0].state, 'NOT_APPLICABLE');

  var withWeek2 = buildRosterSnapshot_(tables, '2027-10-10', { communionWeeks: [2] });
  assert.strictEqual(withWeek2.slotsByPost.COMMUNION[0].state, 'PENDING',
    'COMMUNION_WEEKS 設成 [2] 之後，第 2 個主日就適用了');
});

// =====================================================================

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
