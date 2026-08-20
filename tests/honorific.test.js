#!/usr/bin/env node
/**
 * tests/honorific.test.js
 *
 * 第六b輪「PersonDisplay 骨架與尊稱自動套用」的回歸測試：
 *   - src/HonorificSetup.gs 的 buildPersonDisplaySkeletonPlan_()／
 *     buildHonorificLookupIndex_()／buildApplyHonorificPlan_()（純函式）
 *   - buildPersonDisplaySkeletonFromRoster_()／
 *     applyHonorificLookupToPersonDisplay_()（真正入口，假 SpreadsheetApp）
 *
 * 執行方式：node tests/honorific.test.js
 * 離開碼：0＝全部通過　1＝有測試失敗
 */

'use strict';

const assert = require('assert');
const { loadAllSrcFilesInOrder } = require('./helpers/loadGas');
const { makeFakeSheet, makeFakeSpreadsheet } = require('./helpers/fakeSpreadsheet');

const GAS_STUBS = {
  Utilities: { formatDate: function () { return ''; } },
  Session: {
    getScriptTimeZone: function () { return 'Pacific/Auckland'; },
    getActiveUser: function () { return { getEmail: function () { return 'tester@x.com'; } }; },
    getEffectiveUser: function () { return { getEmail: function () { return 'tester@x.com'; } }; }
  },
  SpreadsheetApp: {},
  CacheService: {},
  HtmlService: {}
};

const sandbox = loadAllSrcFilesInOrder(GAS_STUBS);
const {
  normalizeNameForMatch_, buildPersonDisplaySkeletonPlan_,
  buildHonorificLookupIndex_, buildApplyHonorificPlan_, buildHonorificMissingList_
} = sandbox;

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

function personDisplayRow(overrides) {
  return Object.assign({
    PERSON_ID: 'P9001', NAME_TC: '陳大文', HONORIFIC: '', DISPLAY_OVERRIDE: '',
    EFFECTIVE_FROM: null, EFFECTIVE_TO: null, ACTIVE: true, NOTES: ''
  }, overrides || {});
}

function lookupRow(overrides) {
  return Object.assign({ NAME_TC: '陳大文', HONORIFIC: '弟兄', OCCURRENCES: 1, NOTE: '' }, overrides || {});
}

// =====================================================================
// normalizeNameForMatch_
// =====================================================================

test('normalizeNameForMatch_：移除前後與中間的半形／全形空白', function () {
  assert.strictEqual(normalizeNameForMatch_('  陳大文 '), '陳大文');
  assert.strictEqual(normalizeNameForMatch_('陳　大文'), '陳大文');
  assert.strictEqual(normalizeNameForMatch_(' 陳　大　文 '), '陳大文');
});

// =====================================================================
// 1. 骨架建立冪等：跑兩次，第二次新增 0 行（純函式層）
// =====================================================================

test('buildPersonDisplaySkeletonPlan_：第一次執行，全部人新增', function () {
  const nameMapping = [
    { PersonID: 'P9001', NameTC: '陳大文', Active: true },
    { PersonID: 'P9002', NameTC: '李小明', Active: true }
  ];
  const plan = buildPersonDisplaySkeletonPlan_(nameMapping, []);
  assert.strictEqual(plan.addedCount, 2);
  assert.strictEqual(plan.skippedExistingCount, 0);
  assert.strictEqual(plan.blankHonorificCount, 2);
});

test('buildPersonDisplaySkeletonPlan_：第二次執行（既有資料已含全部人）→ 新增 0 行（冪等）', function () {
  const nameMapping = [
    { PersonID: 'P9001', NameTC: '陳大文', Active: true },
    { PersonID: 'P9002', NameTC: '李小明', Active: true }
  ];
  const existing = [
    personDisplayRow({ PERSON_ID: 'P9001', NAME_TC: '陳大文' }),
    personDisplayRow({ PERSON_ID: 'P9002', NAME_TC: '李小明' })
  ];
  const plan = buildPersonDisplaySkeletonPlan_(nameMapping, existing);
  assert.strictEqual(plan.addedCount, 0, '第二次不應該再新增任何一行');
  assert.strictEqual(plan.skippedExistingCount, 2);
});

test('buildPersonDisplaySkeletonPlan_：只讀 Active=TRUE 的人', function () {
  const nameMapping = [
    { PersonID: 'P9001', NameTC: '陳大文', Active: true },
    { PersonID: 'P9003', NameTC: '假丙', Active: false }
  ];
  const plan = buildPersonDisplaySkeletonPlan_(nameMapping, []);
  assert.strictEqual(plan.addedCount, 1);
  assert.strictEqual(plan.appends[0].PERSON_ID, 'P9001');
});

test('buildPersonDisplaySkeletonPlan_：既有的行連 NAME_TC 都不會被覆蓋（不在 appends 內）', function () {
  const nameMapping = [{ PersonID: 'P9001', NameTC: '陳大文（新快照）', Active: true }];
  const existing = [personDisplayRow({ PERSON_ID: 'P9001', NAME_TC: '陳大文（Ivan 已調整）' })];
  const plan = buildPersonDisplaySkeletonPlan_(nameMapping, existing);
  assert.strictEqual(plan.appends.length, 0);
});

// =====================================================================
// 2. 已有 HONORIFIC 的行不被覆蓋
// =====================================================================

test('buildApplyHonorificPlan_：HONORIFIC 已經有值 → 不覆蓋，計入 alreadySetCount', function () {
  const lookup = buildHonorificLookupIndex_([lookupRow({ NAME_TC: '陳大文', HONORIFIC: '姊妹' })]);
  const rows = [Object.assign(personDisplayRow({ NAME_TC: '陳大文', HONORIFIC: '弟兄' }), { __rowNo: 3 })];
  const plan = buildApplyHonorificPlan_(rows, lookup);

  assert.strictEqual(plan.updates.length, 0, '不應該有任何更新');
  assert.strictEqual(plan.alreadySetCount, 1);
});

// =====================================================================
// 3. 對照表姓名前後有空白／全形空格 → 仍然對得上
// =====================================================================

test('buildHonorificLookupIndex_ ＋ buildApplyHonorificPlan_：對照表姓名有全形／半形空格雜訊，仍然對得上', function () {
  const lookup = buildHonorificLookupIndex_([lookupRow({ NAME_TC: ' 陳　大文 ', HONORIFIC: '弟兄' })]);
  const rows = [Object.assign(personDisplayRow({ NAME_TC: '陳大文', HONORIFIC: '' }), { __rowNo: 3 })];
  const plan = buildApplyHonorificPlan_(rows, lookup);

  assert.strictEqual(plan.updates.length, 1);
  assert.strictEqual(plan.updates[0].honorific, '弟兄');
});

// =====================================================================
// 4. 對照表同一姓名兩個不同尊稱 → 不套用該姓名 + warning
// =====================================================================

test('buildHonorificLookupIndex_：同一姓名兩個不同尊稱 → 不進索引，記進 conflicts', function () {
  const result = buildHonorificLookupIndex_([
    lookupRow({ NAME_TC: '陳大文', HONORIFIC: '弟兄' }),
    lookupRow({ NAME_TC: '陳大文', HONORIFIC: '傳道' })
  ]);
  assert.strictEqual(Object.keys(result.index).length, 0, '不應該進索引');
  assert.strictEqual(result.conflicts.length, 1);
  assert.strictEqual(result.conflicts[0].name, '陳大文');
  assert.strictEqual(result.conflicts[0].honorifics.slice().sort().join('/'), ['傳道', '弟兄'].sort().join('/'));
});

test('buildHonorificLookupIndex_：同一姓名出現多次但尊稱相同 → 當一筆處理，正常進索引', function () {
  const result = buildHonorificLookupIndex_([
    lookupRow({ NAME_TC: '陳大文', HONORIFIC: '弟兄' }),
    lookupRow({ NAME_TC: '陳大文', HONORIFIC: '弟兄' })
  ]);
  assert.strictEqual(result.conflicts.length, 0);
  assert.strictEqual(result.index[normalizeNameForMatch_('陳大文')], '弟兄');
});

test('套用對照表時，衝突的姓名不會被套用（即使 PersonDisplay 那一格是空白）', function () {
  const lookup = buildHonorificLookupIndex_([
    lookupRow({ NAME_TC: '陳大文', HONORIFIC: '弟兄' }),
    lookupRow({ NAME_TC: '陳大文', HONORIFIC: '傳道' })
  ]);
  const rows = [Object.assign(personDisplayRow({ NAME_TC: '陳大文', HONORIFIC: '' }), { __rowNo: 3 })];
  const plan = buildApplyHonorificPlan_(rows, lookup);
  assert.strictEqual(plan.updates.length, 0);
  assert.strictEqual(plan.notMatched.length, 1, '衝突的姓名視同「對不上」，交由 Ivan 自己決定');
});

// =====================================================================
// 5. 對照表 HONORIFIC 空白 → 略過，不當錯誤
// =====================================================================

test('buildHonorificLookupIndex_：HONORIFIC 空白 → 略過，不進索引、不算 warning', function () {
  const result = buildHonorificLookupIndex_([lookupRow({ NAME_TC: '陳大文', HONORIFIC: '' })]);
  assert.strictEqual(Object.keys(result.index).length, 0);
  assert.strictEqual(result.conflicts.length, 0);
  assert.strictEqual(result.invalidWarnings.length, 0, '空白代表「未確認」，不是異常值，不應該有 warning');
});

// =====================================================================
// 6. 對照表 HONORIFIC 是無效值 → 略過 + warning，不拋錯
// =====================================================================

test('buildHonorificLookupIndex_：HONORIFIC 是無效值（例如「先生」）→ 略過該行 + warning，不拋錯', function () {
  let result;
  assert.doesNotThrow(function () {
    result = buildHonorificLookupIndex_([lookupRow({ NAME_TC: '陳大文', HONORIFIC: '先生' })]);
  });
  assert.strictEqual(Object.keys(result.index).length, 0);
  assert.strictEqual(result.invalidWarnings.length, 1);
  assert.strictEqual(result.invalidWarnings[0].name, '陳大文');
  assert.strictEqual(result.invalidWarnings[0].value, '先生');
});

test('buildHonorificLookupIndex_：合法值清單剛好是弟兄／姊妹／牧師／師母／傳道／宣教士六個', function () {
  const validRows = ['弟兄', '姊妹', '牧師', '師母', '傳道', '宣教士'].map(function (h, i) {
    return lookupRow({ NAME_TC: '人' + i, HONORIFIC: h });
  });
  const result = buildHonorificLookupIndex_(validRows);
  assert.strictEqual(result.invalidWarnings.length, 0);
  assert.strictEqual(Object.keys(result.index).length, 6);
});

// =====================================================================
// 7. PersonDisplay 有、對照表沒有 → 計入「對不上」，不拋錯
// =====================================================================

test('buildApplyHonorificPlan_：姓名不在對照表索引內 → 計入 notMatched，不拋錯', function () {
  const lookup = buildHonorificLookupIndex_([lookupRow({ NAME_TC: '李小明', HONORIFIC: '姊妹' })]);
  const rows = [Object.assign(personDisplayRow({ PERSON_ID: 'P9099', NAME_TC: '陳大文', HONORIFIC: '' }), { __rowNo: 3 })];

  let plan;
  assert.doesNotThrow(function () { plan = buildApplyHonorificPlan_(rows, lookup); });
  assert.strictEqual(plan.updates.length, 0);
  assert.strictEqual(plan.notMatched.length, 1);
  assert.strictEqual(plan.notMatched[0].personId, 'P9099');
});

// =====================================================================
// 8. 「李敏慧」與「李慧敏」→ 不會被當成同一人
// =====================================================================

test('字序不同的姓名（李敏慧／李慧敏）：不做模糊比對，各自獨立、不會互相對上', function () {
  const lookup = buildHonorificLookupIndex_([lookupRow({ NAME_TC: '李敏慧', HONORIFIC: '姊妹' })]);
  const rows = [Object.assign(personDisplayRow({ PERSON_ID: 'P9050', NAME_TC: '李慧敏', HONORIFIC: '' }), { __rowNo: 3 })];

  const plan = buildApplyHonorificPlan_(rows, lookup);
  assert.strictEqual(plan.updates.length, 0, '字序不同不可以被當成同一人');
  assert.strictEqual(plan.notMatched.length, 1);
  assert.strictEqual(plan.notMatched[0].name, '李慧敏');
});

// =====================================================================
// buildHonorificMissingList_
// =====================================================================

test('buildHonorificMissingList_：本季有事奉但 PersonDisplay 沒有這個人 → 算未設定', function () {
  const missing = buildHonorificMissingList_(
    [{ personId: 'P9001', nameTC: '陳大文' }],
    []
  );
  assert.strictEqual(missing.length, 1);
});

test('buildHonorificMissingList_：本季有事奉、PersonDisplay 有這個人但 HONORIFIC 空白 → 算未設定', function () {
  const missing = buildHonorificMissingList_(
    [{ personId: 'P9001', nameTC: '陳大文' }],
    [personDisplayRow({ PERSON_ID: 'P9001', HONORIFIC: '' })]
  );
  assert.strictEqual(missing.length, 1);
});

test('buildHonorificMissingList_：HONORIFIC 已經有值 → 不算未設定', function () {
  const missing = buildHonorificMissingList_(
    [{ personId: 'P9001', nameTC: '陳大文' }],
    [personDisplayRow({ PERSON_ID: 'P9001', HONORIFIC: '弟兄' })]
  );
  assert.strictEqual(missing.length, 0);
});

// =====================================================================
// 9／10. 真正入口：由真正入口（選單處理函式底層）叫下去，用假 SpreadsheetApp
// =====================================================================

function ownSheetFor(sandboxRef, sheetId, rows) {
  const def = sandboxRef.COLUMNS[sheetId];
  return makeFakeSheet(def.headers, def.keys, rows || []);
}

function rosterSheetFor(sandboxRef, defKey, rows) {
  const keys = Object.keys(sandboxRef.ROSTER_TABLE_DEFS_[defKey].columns);
  return makeFakeSheet(keys, keys, rows || []);
}

const FAKE_ROSTER_ID = 'FAKE_ROSTER_ID_FOR_HONORIFIC_TEST';

/**
 * 造一個完整的假環境：週報自己全部工作表 ＋ 職事表（只需要 NameMapping／
 * ServiceDates／Versions／Assignments 四張跟本輪相關的表就夠）。
 */
function makeEnv(o) {
  o = o || {};
  const freshSandbox = loadAllSrcFilesInOrder(GAS_STUBS);

  const configBase = {};
  freshSandbox.DEFAULTS.forEach(function (d) { configBase[d.key] = d.value; });
  configBase.ROSTER_SPREADSHEET_ID = FAKE_ROSTER_ID;

  const ownSheets = {};
  Object.keys(freshSandbox.SHEETS).forEach(function (sheetId) {
    ownSheets[freshSandbox.SHEETS[sheetId]] = ownSheetFor(freshSandbox, sheetId, []);
  });
  ownSheets.Config = ownSheetFor(freshSandbox, 'CONFIG', Object.keys(configBase).map(function (k) {
    return { KEY: k, VALUE: configBase[k], NOTE: '', EDITABLE: true };
  }));
  ownSheets.PersonDisplay = ownSheetFor(freshSandbox, 'PERSON_DISPLAY', o.personDisplayRows || []);
  ownSheets.HonorificLookup = ownSheetFor(freshSandbox, 'HONORIFIC_LOOKUP', o.lookupRows || []);

  const rosterSheets = {
    RosterAssignments: rosterSheetFor(freshSandbox, 'ASSIGNMENTS', o.assignmentRows || []),
    RosterVersions: rosterSheetFor(freshSandbox, 'VERSIONS', o.versionRows || [{ QuarterID: '2027T4', VersionNo: 1 }]),
    Quarters: rosterSheetFor(freshSandbox, 'QUARTERS', [{ QuarterID: '2027T4', Stage: 'OFFICIAL_SENT' }]),
    ServiceDates: rosterSheetFor(freshSandbox, 'SERVICE_DATES', o.serviceDateRows || [{
      ServiceDateID: 'SD1', QuarterID: '2027T4', ServiceDate: '2027-10-03', WeekIndex: 1,
      IsFirstSundayOfMonth: true, ServiceType: '主日崇拜', SpecialID: ''
    }]),
    SpecialSundays: rosterSheetFor(freshSandbox, 'SPECIAL_SUNDAYS', []),
    NameMapping: rosterSheetFor(freshSandbox, 'NAME_MAPPING', o.nameMappingRows || []),
    Posts: rosterSheetFor(freshSandbox, 'POSTS', [])
  };

  const FakeApp = {
    getActiveSpreadsheet: function () { return makeFakeSpreadsheet(ownSheets); },
    openById: function (id) {
      if (id !== FAKE_ROSTER_ID) throw new Error('openById: 未預期的 id ' + id);
      return makeFakeSpreadsheet(rosterSheets);
    }
  };

  return { sandbox: loadAllSrcFilesInOrder(Object.assign({}, GAS_STUBS, { SpreadsheetApp: FakeApp })) };
}

test('真正入口 buildPersonDisplaySkeletonFromRoster_()：第一次執行新增全部人，職事表沒有被寫入', function () {
  const env = makeEnv({
    nameMappingRows: [
      { PersonID: 'P9001', NameTC: '陳大文', Active: true },
      { PersonID: 'P9002', NameTC: '李小明', Active: true },
      { PersonID: 'P9003', NameTC: '假丙', Active: false }
    ]
  });

  const result = env.sandbox.buildPersonDisplaySkeletonFromRoster_();
  assert.strictEqual(result.added, 2, '只計 Active=TRUE 的人');
  assert.strictEqual(result.skippedExisting, 0);
  assert.strictEqual(result.blankHonorific, 2);

  const rows = env.sandbox.readSheet('PersonDisplay');
  assert.strictEqual(rows.length, 2);
  assert.ok(rows.some(function (r) { return r.PERSON_ID === 'P9001' && r.NAME_TC === '陳大文'; }));
});

test('1／9. 真正入口：跑兩次，第二次新增 0 行（冪等），第二次也不會產生新的 AuditLog PERSON_DISPLAY_SKELETON_ADD', function () {
  const env = makeEnv({
    nameMappingRows: [{ PersonID: 'P9001', NameTC: '陳大文', Active: true }]
  });

  const first = env.sandbox.buildPersonDisplaySkeletonFromRoster_();
  assert.strictEqual(first.added, 1);
  const auditAfterFirst = env.sandbox.readSheet('AuditLog')
    .filter(function (r) { return r.ACTION === 'PERSON_DISPLAY_SKELETON_ADD'; }).length;
  assert.strictEqual(auditAfterFirst, 1, '第一次應該恰好一筆 AuditLog（新增一行）');

  const second = env.sandbox.buildPersonDisplaySkeletonFromRoster_();
  assert.strictEqual(second.added, 0, '第二次執行不應該再新增行');

  const auditAfterSecond = env.sandbox.readSheet('AuditLog')
    .filter(function (r) { return r.ACTION === 'PERSON_DISPLAY_SKELETON_ADD'; }).length;
  assert.strictEqual(auditAfterSecond, 1, '第二次不應該再產生新的 AuditLog（真正入口的冪等）');
});

test('真正入口：整個骨架建立流程完全不會寫入職事表（假物件不支援寫入，有寫入就會拋錯）', function () {
  const env = makeEnv({ nameMappingRows: [{ PersonID: 'P9001', NameTC: '陳大文', Active: true }] });
  assert.doesNotThrow(function () { env.sandbox.buildPersonDisplaySkeletonFromRoster_(); });
});

test('2／9. 真正入口 applyHonorificLookupToPersonDisplay_()：已有值的行不被覆蓋，只有真正填入時才寫 AuditLog', function () {
  const env = makeEnv({
    personDisplayRows: [
      personDisplayRow({ PERSON_ID: 'P9001', NAME_TC: '陳大文', HONORIFIC: '' }),
      personDisplayRow({ PERSON_ID: 'P9002', NAME_TC: '李小明', HONORIFIC: '姊妹' }) // 已有值
    ],
    lookupRows: [
      lookupRow({ NAME_TC: '陳大文', HONORIFIC: '弟兄' }),
      lookupRow({ NAME_TC: '李小明', HONORIFIC: '傳道' }) // 就算對照表有值，已有值的行也不能被覆蓋
    ]
  });

  const result = env.sandbox.applyHonorificLookupToPersonDisplay_();
  assert.strictEqual(result.filled, 1);
  assert.strictEqual(result.alreadySet, 1);
  assert.strictEqual(result.notMatched, 0);
  assert.strictEqual(result.conflicts, 0);

  const rows = env.sandbox.readSheet('PersonDisplay');
  const chen = rows.filter(function (r) { return r.PERSON_ID === 'P9001'; })[0];
  const li = rows.filter(function (r) { return r.PERSON_ID === 'P9002'; })[0];
  assert.strictEqual(chen.HONORIFIC, '弟兄', '空白的被填入');
  assert.strictEqual(li.HONORIFIC, '姊妹', '已有值的沒有被覆蓋成「傳道」');

  const auditRows = env.sandbox.readSheet('AuditLog').filter(function (r) { return r.ACTION === 'HONORIFIC_FILL'; });
  assert.strictEqual(auditRows.length, 1, '只有真正填入的那一格才有 AuditLog');
  assert.strictEqual(auditRows[0].ROW_KEY, 'P9001');
});

test('真正入口 applyHonorificLookupToPersonDisplay_()：沒有任何一格需要填入時，AuditLog 完全不會新增', function () {
  const env = makeEnv({
    personDisplayRows: [personDisplayRow({ PERSON_ID: 'P9001', NAME_TC: '陳大文', HONORIFIC: '弟兄' })],
    lookupRows: [lookupRow({ NAME_TC: '陳大文', HONORIFIC: '姊妹' })]
  });
  const result = env.sandbox.applyHonorificLookupToPersonDisplay_();
  assert.strictEqual(result.filled, 0);
  assert.strictEqual(env.sandbox.readSheet('AuditLog').length, 0);
});

test('真正入口 applyHonorificLookupToPersonDisplay_()：完整結果寫入 Diagnostics，三段都在（已填入／對不上／衝突）', function () {
  const env = makeEnv({
    personDisplayRows: [
      personDisplayRow({ PERSON_ID: 'P9001', NAME_TC: '陳大文', HONORIFIC: '' }),
      personDisplayRow({ PERSON_ID: 'P9002', NAME_TC: '無對照的人', HONORIFIC: '' })
    ],
    lookupRows: [
      lookupRow({ NAME_TC: '陳大文', HONORIFIC: '弟兄' }),
      lookupRow({ NAME_TC: '衝突姓名', HONORIFIC: '弟兄' }),
      lookupRow({ NAME_TC: '衝突姓名', HONORIFIC: '傳道' })
    ]
  });
  env.sandbox.applyHonorificLookupToPersonDisplay_();

  const diag = env.sandbox.readSheet('Diagnostics');
  const text = diag.map(function (r) { return r.CONTENT; }).join('\n');
  assert.ok(text.indexOf('已填入') !== -1);
  assert.ok(text.indexOf('對不上') !== -1);
  assert.ok(text.indexOf('無對照的人') !== -1);
  assert.ok(text.indexOf('衝突姓名') !== -1);
});

test('真正入口 buildHonorificMissingReport_()：唯讀，不寫入 PersonDisplay／AuditLog，只寫 Diagnostics', function () {
  const env = makeEnv({
    personDisplayRows: [personDisplayRow({ PERSON_ID: 'P9001', NAME_TC: '陳大文', HONORIFIC: '' })],
    nameMappingRows: [{ PersonID: 'P9001', NameTC: '陳大文', Active: true }],
    assignmentRows: [{
      QuarterID: '2027T4', VersionNo: 1, ServiceDate: '2027-10-03', PostID: 'CHAIR',
      SlotIndex: 1, PersonID: 'P9001', PersonNameSnapshot: '陳大文', AssignSource: 'AUTO', Locked: false
    }]
  });

  const before = env.sandbox.readSheet('PersonDisplay');
  const result = env.sandbox.buildHonorificMissingReport_('2027-10-03');

  assert.strictEqual(result.quarterId, '2027T4');
  assert.strictEqual(result.missingCount, 1);
  assert.strictEqual(env.sandbox.readSheet('AuditLog').length, 0, '唯讀，不應該有 AuditLog');
  assert.strictEqual(JSON.stringify(env.sandbox.readSheet('PersonDisplay')), JSON.stringify(before), '不應該修改 PersonDisplay');

  const diag = env.sandbox.readSheet('Diagnostics');
  assert.ok(diag.length > 0);
});

test('真正入口 buildHonorificMissingReport_()：找不到該主日 → quarterId 為 null，不拋錯', function () {
  const env = makeEnv({});
  let result;
  assert.doesNotThrow(function () { result = env.sandbox.buildHonorificMissingReport_('1999-01-01'); });
  assert.strictEqual(result.quarterId, null);
});

// =====================================================================

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
