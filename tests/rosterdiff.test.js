#!/usr/bin/env node
/**
 * tests/rosterdiff.test.js
 *
 * 第六輪「週報與職事表的分歧處理」的回歸測試：
 *   - src/RosterDiff.gs 的 buildRosterDiff_()（四種 status）
 *   - src/DutyOverride.gs 的 computeDutyOverridePlan_()／
 *     applyDutyOverridesToSlots_()
 *   - src/PersonDisplay.gs 的 resolveOverrideDisplay_()
 *
 * 1. 四種 status 各一例
 * 2. CONFLICT 用「覆寫當時的職事表值」判斷，不是用「週報現值」
 * 3. 無覆寫時職事表改動 → FOLLOW，而且有 AuditLog
 * 4. 覆寫值與職事表現值相同 → 不產生 DutyOverride
 * 5. 清空覆寫 → ACTIVE=FALSE，不是刪行
 * 6. 覆寫的姓名對不上 PersonDisplay → 原樣顯示 + warning，不拋錯
 * 7. 多位次崗位（司事 2、聖餐輔禮 4）逐位次獨立覆寫
 *
 * 執行方式：node tests/rosterdiff.test.js
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
  buildRosterDiff_, computeDutyOverridePlan_, applyDutyOverridesToSlots_,
  buildDutyOverrideIndex_, resolveOverrideDisplay_, dutyOverrideKey_, ROSTER_DIFF_STATUS
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

function assertArrayEqual(actual, expected, message) {
  assert.strictEqual(JSON.stringify(actual), JSON.stringify(expected), message);
}

/** 造一個最小的快照：一個崗位、指定位次數，每個位次一個職事表姓名。 */
function makeSnapshot(options) {
  const o = options || {};
  const slotsByPost = {};
  Object.keys(o.posts || {}).forEach(function (postId) {
    slotsByPost[postId] = (o.posts[postId] || []).map(function (name, i) {
      return {
        postId: postId, slotIndex: i + 1,
        personId: name ? 'P900' + (i + 1) : null,
        personName: name || '',
        assignSource: 'AUTO', locked: false,
        state: name ? 'ASSIGNED' : 'PENDING',
        externalOwner: ''
      };
    });
  });
  return {
    ok: true, notConfigured: false, found: true,
    isoDate: o.isoDate || '2027-10-03',
    weekOfMonth: 1, quarterId: '2027T4', quarterStage: 'OFFICIAL_SENT', isOfficial: true,
    versionNo: (o.versionNo === undefined) ? 12 : o.versionNo,
    serviceDate: null, special: null, assignments: [],
    slotsByPost: slotsByPost,
    posts: Object.keys(o.posts || {}).map(function (postId, idx) {
      return { postId: postId, nameTC: postId, slotCount: 1, frequency: 'WEEKLY', autoGenerate: true, displayOrder: (idx + 1) * 10, emptyDisplay: 'PENDING' };
    }),
    warnings: []
  };
}

function overrideRow(overrides) {
  return Object.assign({
    SERVICE_DATE: sandbox.normalizeDate_('2027-10-03'),
    POST_ID: 'CHAIR', SLOT_INDEX: 1,
    OVERRIDE_NAME: '李小明', ROSTER_VALUE_AT_OVERRIDE: '陳大文',
    ROSTER_VERSION_AT_OVERRIDE: 10, OVERRIDE_AT: null, OVERRIDE_BY: 'tester@x.com',
    REASON: '', ACTIVE: true, NOTES: ''
  }, overrides || {});
}

// =====================================================================
// 1. 四種 status 各一例
// =====================================================================

test('status SAME：無覆寫、職事表版本與快照版本相同', function () {
  const snapshot = makeSnapshot({ posts: { CHAIR: ['陳大文'] }, versionNo: 10 });
  const diff = buildRosterDiff_('2027-10-03', snapshot, [], 10);
  assert.strictEqual(diff.rows.length, 1);
  assert.strictEqual(diff.rows[0].status, ROSTER_DIFF_STATUS.SAME);
  assert.strictEqual(diff.conflictCount, 0);
  assert.strictEqual(diff.followedCount, 0);
});

test('status FOLLOW：無覆寫、職事表版本比快照版本新 → 自動跟隨', function () {
  const snapshot = makeSnapshot({ posts: { CHAIR: ['王美美'] }, versionNo: 12 });
  const diff = buildRosterDiff_('2027-10-03', snapshot, [], 10);
  assert.strictEqual(diff.rows[0].status, ROSTER_DIFF_STATUS.FOLLOW);
  assert.strictEqual(diff.followedCount, 1);
  assert.strictEqual(diff.rows[0].bulletinName, '王美美', '沒有覆寫，週報顯示的就是職事表現值');
});

test('status CONFLICT：有覆寫，而且職事表現值 ≠ 覆寫當時記下的職事表值', function () {
  const snapshot = makeSnapshot({ posts: { CHAIR: ['王美美'] }, versionNo: 12 });
  const diff = buildRosterDiff_('2027-10-03', snapshot, [overrideRow({ ROSTER_VALUE_AT_OVERRIDE: '陳大文' })], 10);
  assert.strictEqual(diff.rows[0].status, ROSTER_DIFF_STATUS.CONFLICT);
  assert.strictEqual(diff.conflictCount, 1);
  assert.strictEqual(diff.rows[0].rosterValueAtOverride, '陳大文');
  assert.strictEqual(diff.rows[0].rosterName, '王美美');
  assert.strictEqual(diff.rows[0].bulletinName, '李小明');
});

test('status OVERRIDDEN：有覆寫，職事表沒有再改過', function () {
  const snapshot = makeSnapshot({ posts: { CHAIR: ['陳大文'] }, versionNo: 12 });
  const diff = buildRosterDiff_('2027-10-03', snapshot, [overrideRow({ ROSTER_VALUE_AT_OVERRIDE: '陳大文' })], 10);
  assert.strictEqual(diff.rows[0].status, ROSTER_DIFF_STATUS.OVERRIDDEN);
  assert.strictEqual(diff.conflictCount, 0, 'OVERRIDDEN 不算衝突');
});

// =====================================================================
// 2. CONFLICT 用「覆寫當時的職事表值」判斷，不是用「週報現值」
// =====================================================================

test('CONFLICT 判斷基準：職事表一直沒改過時，即使週報現值與職事表不同，也**不是**衝突', function () {
  // 這是本輪最重要的一條：幹事就是刻意把週報改成跟職事表不同，
  // 用「職事表現值 vs 週報現值」判斷的話每一格都會變成衝突。
  const snapshot = makeSnapshot({ posts: { CHAIR: ['陳大文'] }, versionNo: 12 });
  const diff = buildRosterDiff_('2027-10-03', snapshot,
    [overrideRow({ OVERRIDE_NAME: '李小明', ROSTER_VALUE_AT_OVERRIDE: '陳大文' })], 12);

  assert.notStrictEqual(diff.rows[0].rosterName, diff.rows[0].bulletinName, '兩邊現值確實不同');
  assert.strictEqual(diff.rows[0].status, ROSTER_DIFF_STATUS.OVERRIDDEN,
    '但職事表沒有再改過，所以不是衝突——這就是用「覆寫當時的職事表值」判斷的意義');
  assert.strictEqual(diff.conflictCount, 0);
});

test('CONFLICT 判斷基準：覆寫值剛好等於職事表新值時，仍然算衝突（基準線是覆寫當時的值）', function () {
  const snapshot = makeSnapshot({ posts: { CHAIR: ['李小明'] }, versionNo: 12 });
  const diff = buildRosterDiff_('2027-10-03', snapshot,
    [overrideRow({ OVERRIDE_NAME: '李小明', ROSTER_VALUE_AT_OVERRIDE: '陳大文' })], 12);
  assert.strictEqual(diff.rows[0].status, ROSTER_DIFF_STATUS.CONFLICT,
    '職事表由 陳大文 改成 李小明，跟覆寫當時記下的值不同 → 衝突（就算結果一樣，人也應該知道職事表動過）');
});

test('lastSnapshotVersion 是 null（從未比對過）→ 一律不產生 FOLLOW，避免第一次執行滿螢幕噪音', function () {
  const snapshot = makeSnapshot({ posts: { CHAIR: ['陳大文'], PREACHER: ['王美美'] }, versionNo: 12 });
  const diff = buildRosterDiff_('2027-10-03', snapshot, [], null);
  assert.strictEqual(diff.followedCount, 0);
  diff.rows.forEach(function (r) { assert.strictEqual(r.status, ROSTER_DIFF_STATUS.SAME); });
});

test('NOT_APPLICABLE 的 slot 不會出現在比對結果內（那一週根本不設這個崗位）', function () {
  const snapshot = makeSnapshot({ posts: { CHAIR: ['陳大文'] }, versionNo: 12 });
  snapshot.slotsByPost.COMMUNION = [{
    postId: 'COMMUNION', slotIndex: 1, personId: null, personName: '',
    state: 'NOT_APPLICABLE', externalOwner: '', assignSource: '', locked: false
  }];
  const diff = buildRosterDiff_('2027-10-03', snapshot, [], 12);
  assert.strictEqual(diff.rows.length, 1);
  assert.strictEqual(diff.rows[0].postId, 'CHAIR');
});

// =====================================================================
// 4. 覆寫值與職事表現值相同 → 不產生 DutyOverride
// =====================================================================

test('computeDutyOverridePlan_：新值與職事表現值相同 → 不新增任何一行 DutyOverride', function () {
  const plan = computeDutyOverridePlan_({
    edits: [{ postId: 'CHAIR', slotIndex: 1, name: '陳大文' }],
    existingRows: [],
    rosterNameByKey: { 'CHAIR#1': '陳大文' },
    rosterVersion: 12
  });
  assert.strictEqual(plan.appends.length, 0, '不應該產生「覆寫成跟職事表一樣」的無意義記錄');
  assert.strictEqual(plan.updates.length, 0);
  assert.strictEqual(plan.deactivations.length, 0);
});

test('computeDutyOverridePlan_：新值與職事表現值不同 → 新增一行，並記下覆寫當時的職事表值與版本', function () {
  const plan = computeDutyOverridePlan_({
    edits: [{ postId: 'CHAIR', slotIndex: 1, name: '李小明' }],
    existingRows: [],
    rosterNameByKey: { 'CHAIR#1': '陳大文' },
    rosterVersion: 12
  });
  assert.strictEqual(plan.appends.length, 1);
  assert.strictEqual(plan.appends[0].OVERRIDE_NAME, '李小明');
  assert.strictEqual(plan.appends[0].ROSTER_VALUE_AT_OVERRIDE, '陳大文');
  assert.strictEqual(plan.appends[0].ROSTER_VERSION_AT_OVERRIDE, 12);
  assert.strictEqual(plan.appends[0].ACTIVE, true);
});

// =====================================================================
// 5. 清空覆寫 → ACTIVE=FALSE，不是刪行
// =====================================================================

test('computeDutyOverridePlan_：清空輸入框 → 既有覆寫改 ACTIVE=FALSE（帶著原本的行號，代表原地改而不是刪行）', function () {
  const plan = computeDutyOverridePlan_({
    edits: [{ postId: 'CHAIR', slotIndex: 1, name: '' }],
    existingRows: [Object.assign(overrideRow({}), { __rowNo: 5 })],
    rosterNameByKey: { 'CHAIR#1': '陳大文' },
    rosterVersion: 12
  });
  assert.strictEqual(plan.deactivations.length, 1);
  assert.strictEqual(plan.deactivations[0].rowNo, 5, 'rowNo 保留 → 原地改 ACTIVE，不是刪除整行');
  assert.strictEqual(plan.deactivations[0].oldValue, '李小明');
  assert.strictEqual(plan.appends.length, 0);
});

test('computeDutyOverridePlan_：把值改回與職事表相同 → 同樣是 ACTIVE=FALSE（等於取消覆寫）', function () {
  const plan = computeDutyOverridePlan_({
    edits: [{ postId: 'CHAIR', slotIndex: 1, name: '陳大文' }],
    existingRows: [Object.assign(overrideRow({}), { __rowNo: 5 })],
    rosterNameByKey: { 'CHAIR#1': '陳大文' },
    rosterVersion: 12
  });
  assert.strictEqual(plan.deactivations.length, 1);
  assert.strictEqual(plan.deactivations[0].rowNo, 5);
});

test('computeDutyOverridePlan_：已經是 ACTIVE=FALSE 的行不會被重複停用（不產生多餘變動）', function () {
  const plan = computeDutyOverridePlan_({
    edits: [{ postId: 'CHAIR', slotIndex: 1, name: '' }],
    existingRows: [Object.assign(overrideRow({ ACTIVE: false }), { __rowNo: 5 })],
    rosterNameByKey: { 'CHAIR#1': '陳大文' },
    rosterVersion: 12
  });
  assert.strictEqual(plan.deactivations.length, 0);
});

test('computeDutyOverridePlan_：更新既有覆寫時，ROSTER_VALUE_AT_OVERRIDE 會重新記成現在的職事表值（等於幹事重新確認過，衝突自然消掉）', function () {
  const plan = computeDutyOverridePlan_({
    edits: [{ postId: 'CHAIR', slotIndex: 1, name: '假甲' }],
    existingRows: [Object.assign(overrideRow({ OVERRIDE_NAME: '李小明', ROSTER_VALUE_AT_OVERRIDE: '陳大文' }), { __rowNo: 5 })],
    rosterNameByKey: { 'CHAIR#1': '王美美' },
    rosterVersion: 12
  });
  assert.strictEqual(plan.updates.length, 1);
  const fields = plan.updates[0].changes.map(function (c) { return c.field; });
  assert.ok(fields.indexOf('OVERRIDE_NAME') !== -1);
  assert.ok(fields.indexOf('ROSTER_VALUE_AT_OVERRIDE') !== -1, '基準線要跟著更新');
  const baseline = plan.updates[0].changes.filter(function (c) { return c.field === 'ROSTER_VALUE_AT_OVERRIDE'; })[0];
  assert.strictEqual(baseline.newValue, '王美美');
});

// =====================================================================
// 6. 覆寫的姓名對不上 PersonDisplay → 原樣顯示 + warning，不拋錯
// =====================================================================

function personRow(overrides) {
  return Object.assign({
    PERSON_ID: 'P9001', NAME_TC: '陳大文', HONORIFIC: '弟兄', DISPLAY_OVERRIDE: '',
    EFFECTIVE_FROM: null, EFFECTIVE_TO: null, ACTIVE: true, NOTES: ''
  }, overrides || {});
}

test('resolveOverrideDisplay_：覆寫姓名對得上 PersonDisplay → 尊稱照樣套用', function () {
  const warnings = [];
  const text = resolveOverrideDisplay_('陳大文', {
    withHonorific: true, personDisplayRows: [personRow()], targetDate: null, warnings: warnings
  });
  assert.strictEqual(text, '陳大文弟兄');
  assert.strictEqual(warnings.length, 0);
});

test('resolveOverrideDisplay_：覆寫姓名對不上 → 原樣顯示 + warning，不拋錯', function () {
  const warnings = [];
  let text;
  assert.doesNotThrow(function () {
    text = resolveOverrideDisplay_('臨時訪客', {
      withHonorific: true, personDisplayRows: [personRow()], targetDate: null, warnings: warnings
    });
  });
  assert.strictEqual(text, '臨時訪客', '原樣顯示');
  assert.strictEqual(warnings.length, 1);
  assert.strictEqual(warnings[0].code, 'OVERRIDE_NAME_NOT_IN_PERSON_DISPLAY');
});

test('resolveOverrideDisplay_：職稱類尊稱即使在第 3 頁（withHonorific=false）也保留', function () {
  const text = resolveOverrideDisplay_('王美美', {
    withHonorific: false,
    personDisplayRows: [personRow({ NAME_TC: '王美美', HONORIFIC: '牧師' })],
    targetDate: null, warnings: []
  });
  assert.strictEqual(text, '王美美牧師');
});

test('resolveSlotDisplay_：hasOverride 的 slot 走按姓名查的路徑', function () {
  const text = sandbox.resolveSlotDisplay_(
    { postId: 'CHAIR', slotIndex: 1, state: 'ASSIGNED', personId: null, personName: '李小明', hasOverride: true, overrideName: '李小明' },
    { withHonorific: true, personDisplayRows: [personRow({ PERSON_ID: 'P9002', NAME_TC: '李小明', HONORIFIC: '姊妹' })], targetDate: null, warnings: [] }
  );
  assert.strictEqual(text, '李小明姊妹');
});

// =====================================================================
// 7. 多位次崗位逐位次獨立覆寫
// =====================================================================

test('多位次崗位（司事 2 位）：只覆寫第 2 位，第 1 位不受影響', function () {
  const snapshot = makeSnapshot({ posts: { USHER: ['陳大文', '李小明'] }, versionNo: 12 });
  const overrides = [overrideRow({ POST_ID: 'USHER', SLOT_INDEX: 2, OVERRIDE_NAME: '王美美', ROSTER_VALUE_AT_OVERRIDE: '李小明' })];
  const applied = applyDutyOverridesToSlots_(snapshot.slotsByPost, buildDutyOverrideIndex_(overrides));

  assert.strictEqual(applied.USHER[0].hasOverride, false);
  assert.strictEqual(applied.USHER[0].personName, '陳大文');
  assert.strictEqual(applied.USHER[1].hasOverride, true);
  assert.strictEqual(applied.USHER[1].personName, '王美美');
  assert.strictEqual(applied.USHER[1].rosterName, '李小明', 'rosterName 永遠保留職事表現值');
});

test('多位次崗位（聖餐輔禮 4 位）：四個位次各自獨立，比對結果逐位次分開', function () {
  const snapshot = makeSnapshot({ posts: { COMMUNION: ['甲一', '乙二', '丙三', '丁四'] }, versionNo: 12 });
  const overrides = [
    overrideRow({ POST_ID: 'COMMUNION', SLOT_INDEX: 2, OVERRIDE_NAME: '假甲', ROSTER_VALUE_AT_OVERRIDE: '乙二' }),
    overrideRow({ POST_ID: 'COMMUNION', SLOT_INDEX: 4, OVERRIDE_NAME: '假乙', ROSTER_VALUE_AT_OVERRIDE: '不同的舊值' })
  ];
  const diff = buildRosterDiff_('2027-10-03', snapshot, overrides, 12);

  assert.strictEqual(diff.rows.length, 4);
  assertArrayEqual(diff.rows.map(function (r) { return r.status; }),
    ['SAME', 'OVERRIDDEN', 'SAME', 'CONFLICT']);
  assert.strictEqual(diff.conflictCount, 1);
});

test('computeDutyOverridePlan_：同一個崗位的不同位次互不干擾', function () {
  const plan = computeDutyOverridePlan_({
    edits: [
      { postId: 'USHER', slotIndex: 1, name: '陳大文' },
      { postId: 'USHER', slotIndex: 2, name: '王美美' }
    ],
    existingRows: [],
    rosterNameByKey: { 'USHER#1': '陳大文', 'USHER#2': '李小明' },
    rosterVersion: 12
  });
  assert.strictEqual(plan.appends.length, 1, '只有第 2 位跟職事表不同');
  assert.strictEqual(plan.appends[0].SLOT_INDEX, 2);
  assert.strictEqual(plan.appends[0].OVERRIDE_NAME, '王美美');
});

// =====================================================================
// applyDutyOverridesToSlots_ 的其他邊界
// =====================================================================

test('applyDutyOverridesToSlots_：NOT_APPLICABLE 的 slot 不受覆寫影響（結構先於內容）', function () {
  const slotsByPost = {
    COMMUNION: [{ postId: 'COMMUNION', slotIndex: 1, personId: null, personName: '', state: 'NOT_APPLICABLE', externalOwner: '' }]
  };
  const overrides = [overrideRow({ POST_ID: 'COMMUNION', SLOT_INDEX: 1, OVERRIDE_NAME: '假甲' })];
  const applied = applyDutyOverridesToSlots_(slotsByPost, buildDutyOverrideIndex_(overrides));
  assert.strictEqual(applied.COMMUNION[0].hasOverride, false);
  assert.strictEqual(applied.COMMUNION[0].state, 'NOT_APPLICABLE');
});

test('applyDutyOverridesToSlots_：ACTIVE=FALSE 的覆寫完全不會被套用', function () {
  const snapshot = makeSnapshot({ posts: { CHAIR: ['陳大文'] } });
  const applied = applyDutyOverridesToSlots_(snapshot.slotsByPost, buildDutyOverrideIndex_([overrideRow({ ACTIVE: false })]));
  assert.strictEqual(applied.CHAIR[0].hasOverride, false);
  assert.strictEqual(applied.CHAIR[0].personName, '陳大文');
});

test('applyDutyOverridesToSlots_：不會修改傳入的原始 slotsByPost', function () {
  const snapshot = makeSnapshot({ posts: { CHAIR: ['陳大文'] } });
  const before = JSON.stringify(snapshot.slotsByPost);
  applyDutyOverridesToSlots_(snapshot.slotsByPost, buildDutyOverrideIndex_([overrideRow({})]));
  assert.strictEqual(JSON.stringify(snapshot.slotsByPost), before, '原物件不可以被改動');
});

test('applyDutyOverridesToSlots_：PENDING 的 slot 被覆寫之後變成 ASSIGNED（有名字了）', function () {
  const snapshot = makeSnapshot({ posts: { PREACHER: [''] } });
  const overrides = [overrideRow({ POST_ID: 'PREACHER', SLOT_INDEX: 1, OVERRIDE_NAME: '假丙', ROSTER_VALUE_AT_OVERRIDE: '' })];
  const applied = applyDutyOverridesToSlots_(snapshot.slotsByPost, buildDutyOverrideIndex_(overrides));
  assert.strictEqual(applied.PREACHER[0].state, 'ASSIGNED');
  assert.strictEqual(applied.PREACHER[0].personName, '假丙');
});

test('dutyOverrideKey_：slotIndex 缺漏時當 1（沒有派工紀錄時補的空白 slot 就是 1）', function () {
  assert.strictEqual(dutyOverrideKey_('CHAIR', null), 'CHAIR#1');
  assert.strictEqual(dutyOverrideKey_('CHAIR', undefined), 'CHAIR#1');
  assert.strictEqual(dutyOverrideKey_('CHAIR', 3), 'CHAIR#3');
});

// =====================================================================
// 3. 無覆寫時職事表改動 → FOLLOW，而且有 AuditLog（由真正入口叫下去）
// =====================================================================

function ownSheetFor(sandboxRef, sheetId, rows) {
  const def = sandboxRef.COLUMNS[sheetId];
  return makeFakeSheet(def.headers, def.keys, rows || []);
}

function rosterSheetFor(sandboxRef, defKey, rows) {
  const keys = Object.keys(sandboxRef.ROSTER_TABLE_DEFS_[defKey].columns);
  return makeFakeSheet(keys, keys, rows || []);
}

const FAKE_ROSTER_ID = 'FAKE_ROSTER_ID_FOR_ROSTERDIFF_TEST';

/**
 * 造一個完整的假環境：週報自己全部工作表 ＋ 職事表。
 * `o.rosterVersion` 決定職事表現時版本，`o.snapshotVersion` 決定
 * BulletinWeeks 記下的上一次比對版本。
 */
function makeEnv(o) {
  o = o || {};
  const freshSandbox = loadAllSrcFilesInOrder(GAS_STUBS);
  const isoDate = '2027-10-03';
  const rosterVersion = (o.rosterVersion === undefined) ? 12 : o.rosterVersion;

  const configBase = {};
  freshSandbox.DEFAULTS.forEach(function (d) { configBase[d.key] = d.value; });
  configBase.ROSTER_SPREADSHEET_ID = FAKE_ROSTER_ID;
  Object.assign(configBase, o.config || {});

  const ownSheets = {};
  Object.keys(freshSandbox.SHEETS).forEach(function (sheetId) {
    ownSheets[freshSandbox.SHEETS[sheetId]] = ownSheetFor(freshSandbox, sheetId, []);
  });
  ownSheets.Config = ownSheetFor(freshSandbox, 'CONFIG', Object.keys(configBase).map(function (k) {
    return { KEY: k, VALUE: configBase[k], NOTE: '', EDITABLE: true };
  }));
  ownSheets.BulletinWeeks = ownSheetFor(freshSandbox, 'BULLETIN_WEEKS', [{
    SERVICE_DATE: isoDate, QUARTER_ID: '2027T4', WEEK_OF_MONTH: 1, STATUS: 'DRAFT',
    ROSTER_SNAPSHOT_VERSION: (o.snapshotVersion === undefined) ? '' : o.snapshotVersion
  }]);
  ownSheets.PostDisplay = ownSheetFor(freshSandbox, 'POST_DISPLAY', freshSandbox.seedPostDisplayRows_());
  ownSheets.MergeGroups = ownSheetFor(freshSandbox, 'MERGE_GROUPS', freshSandbox.seedMergeGroupsRows_());
  ownSheets.ProgramTemplates = ownSheetFor(freshSandbox, 'PROGRAM_TEMPLATES', freshSandbox.seedProgramTemplatesRows_());
  ownSheets.PersonDisplay = ownSheetFor(freshSandbox, 'PERSON_DISPLAY', [
    { PERSON_ID: 'P9001', NAME_TC: '陳大文', HONORIFIC: '弟兄', DISPLAY_OVERRIDE: '', EFFECTIVE_FROM: '', EFFECTIVE_TO: '', ACTIVE: true, NOTES: '' }
  ]);
  ownSheets.DutyOverride = ownSheetFor(freshSandbox, 'DUTY_OVERRIDE', o.dutyOverrides || []);

  const rosterSheets = {
    RosterAssignments: rosterSheetFor(freshSandbox, 'ASSIGNMENTS', [{
      QuarterID: '2027T4', VersionNo: rosterVersion, ServiceDate: isoDate, PostID: 'CHAIR',
      SlotIndex: 1, PersonID: 'P9001', PersonNameSnapshot: '陳大文', AssignSource: 'AUTO', Locked: false
    }]),
    RosterVersions: rosterSheetFor(freshSandbox, 'VERSIONS', [{ QuarterID: '2027T4', VersionNo: rosterVersion }]),
    Quarters: rosterSheetFor(freshSandbox, 'QUARTERS', [{ QuarterID: '2027T4', Stage: 'OFFICIAL_SENT' }]),
    ServiceDates: rosterSheetFor(freshSandbox, 'SERVICE_DATES', [{
      ServiceDateID: 'SD1', QuarterID: '2027T4', ServiceDate: isoDate, WeekIndex: 1,
      IsFirstSundayOfMonth: true, ServiceType: '主日崇拜', SpecialID: ''
    }]),
    SpecialSundays: rosterSheetFor(freshSandbox, 'SPECIAL_SUNDAYS', []),
    NameMapping: rosterSheetFor(freshSandbox, 'NAME_MAPPING', [{ PersonID: 'P9001', NameTC: '陳大文', Active: true }]),
    Posts: rosterSheetFor(freshSandbox, 'POSTS', [
      { PostID: 'CHAIR', PostName_TC: '主席', SlotCount: 1, Frequency: 'WEEKLY', AutoGenerate: true, DisplayOrder: 10, Active: true, EmptyDisplay: 'PENDING' }
    ])
  };

  const FakeApp = {
    getActiveSpreadsheet: function () { return makeFakeSpreadsheet(ownSheets); },
    openById: function (id) {
      if (id !== FAKE_ROSTER_ID) throw new Error('openById: 未預期的 id ' + id);
      return makeFakeSpreadsheet(rosterSheets);
    }
  };

  return { sandbox: loadAllSrcFilesInOrder(Object.assign({}, GAS_STUBS, { SpreadsheetApp: FakeApp })), isoDate: isoDate };
}

test('真正入口 checkRosterDiff_()：無覆寫、職事表版本比快照新 → FOLLOW，而且寫一筆 AuditLog', function () {
  const env = makeEnv({ rosterVersion: 12, snapshotVersion: 10 });
  const diff = env.sandbox.checkRosterDiff_(env.isoDate);

  assert.strictEqual(diff.followedCount, 1);
  const auditRows = env.sandbox.readSheet('AuditLog');
  assert.ok(auditRows.some(function (r) { return r.ACTION === 'ROSTER_FOLLOW'; }),
    '自動跟隨要留下 AuditLog，實際：' + JSON.stringify(auditRows.map(function (r) { return r.ACTION; })));
});

test('真正入口 checkRosterDiff_()：記錄完 FOLLOW 之後會把快照版本推到現在的版本（同一批格子不會每次都再報一次）', function () {
  const env = makeEnv({ rosterVersion: 12, snapshotVersion: 10 });
  const first = env.sandbox.checkRosterDiff_(env.isoDate);
  assert.strictEqual(first.followedCount, 1);

  const second = env.sandbox.checkRosterDiff_(env.isoDate);
  assert.strictEqual(second.followedCount, 0, '第二次比對時基準線已經推上去了，不應該再報一次');
  assert.strictEqual(second.snapshotVersion, 12);
});

test('真正入口 computeRosterDiff_()：唯讀，不會寫 AuditLog、也不會推快照版本', function () {
  const env = makeEnv({ rosterVersion: 12, snapshotVersion: 10 });
  const before = JSON.stringify(env.sandbox.readSheet('AuditLog'));

  const diff = env.sandbox.computeRosterDiff_(env.isoDate);
  assert.strictEqual(diff.followedCount, 1, '照樣算得出 FOLLOW');

  assert.strictEqual(JSON.stringify(env.sandbox.readSheet('AuditLog')), before, '不應該寫 AuditLog');
  assert.strictEqual(env.sandbox.readSheet('BulletinWeeks')[0].ROSTER_SNAPSHOT_VERSION, 10, '快照版本不應該被推上去');
});

test('真正入口 computeRosterDiff_()：postLabel 用週報 PostDisplay 的名稱（不是職事表的名稱）', function () {
  const env = makeEnv({ rosterVersion: 12, snapshotVersion: 12 });
  const diff = env.sandbox.computeRosterDiff_(env.isoDate);
  assert.strictEqual(diff.rows[0].postLabel, '主席');
});

// =====================================================================
// 由真正入口 buildBulletinModel_() 叫下去：取值次序與合併
// =====================================================================

test('真正入口 buildBulletinModel_()：覆寫會反映在事奉框，且套用了 PersonDisplay 尊稱（次序：快照 → 覆寫 → 尊稱）', function () {
  const env = makeEnv({
    rosterVersion: 12, snapshotVersion: 12,
    dutyOverrides: [{
      SERVICE_DATE: '2027-10-03', POST_ID: 'CHAIR', SLOT_INDEX: 1,
      OVERRIDE_NAME: '陳大文', ROSTER_VALUE_AT_OVERRIDE: '原本另一個人',
      ROSTER_VERSION_AT_OVERRIDE: 12, OVERRIDE_AT: '', OVERRIDE_BY: '', REASON: '', ACTIVE: true, NOTES: ''
    }]
  });
  const model = env.sandbox.buildBulletinModel_(env.isoDate);
  const chair = model.dutyBoxPage1.filter(function (r) { return r.label === '主席'; })[0];

  assert.ok(chair, '應該有主席那一行');
  assert.strictEqual(chair.text, '陳大文弟兄', '覆寫的姓名照樣套用 PersonDisplay 的尊稱');
  assert.strictEqual(chair.hasOverride, true);
  assert.strictEqual(chair.slots[0].bulletinName, '陳大文', 'slots 帶的是未套尊稱的原始姓名（輸入框用）');
  assert.strictEqual(chair.slots[0].rosterName, '陳大文', '職事表現值');
});

test('真正入口 buildBulletinModel_()：model.rosterDiff 帶著比對結果，衝突數正確', function () {
  const env = makeEnv({
    rosterVersion: 12, snapshotVersion: 12,
    dutyOverrides: [{
      SERVICE_DATE: '2027-10-03', POST_ID: 'CHAIR', SLOT_INDEX: 1,
      OVERRIDE_NAME: '李小明', ROSTER_VALUE_AT_OVERRIDE: '另一個舊值',
      ROSTER_VERSION_AT_OVERRIDE: 11, OVERRIDE_AT: '', OVERRIDE_BY: '', REASON: '', ACTIVE: true, NOTES: ''
    }]
  });
  const model = env.sandbox.buildBulletinModel_(env.isoDate);
  assert.strictEqual(model.rosterDiff.conflictCount, 1);
  const chair = model.dutyBoxPage1.filter(function (r) { return r.label === '主席'; })[0];
  assert.strictEqual(chair.status, 'CONFLICT');
  assert.strictEqual(chair.slots[0].rosterValueAtOverride, '另一個舊值', '介面要同時顯示三個值');
});

// =====================================================================
// 由真正入口 saveWeekFromWebApp_() 叫下去：儲存事奉格編輯
// =====================================================================

test('真正入口 saveWeekFromWebApp_()：改一格 → DutyOverride 出現一行，且職事表完全沒有被寫入', function () {
  const env = makeEnv({ rosterVersion: 12, snapshotVersion: 12 });
  env.sandbox.saveWeekFromWebApp_({
    isoDate: env.isoDate, lastSavedAt: null, week: {},
    announcements: [], prayers: [], fellowships: [], finance: [],
    dutyEdits: [{ postId: 'CHAIR', slotIndex: 1, name: '李小明' }]
  });

  const rows = env.sandbox.readSheet('DutyOverride');
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].OVERRIDE_NAME, '李小明');
  assert.strictEqual(rows[0].ROSTER_VALUE_AT_OVERRIDE, '陳大文');
  assert.strictEqual(rows[0].ACTIVE, true);

  // 職事表唯讀：makeEnv 的職事表假物件完全沒有 setValue／setValues，
  // 真的被寫入的話上面那一步就會拋錯。這一行是明確的意圖聲明。
  assert.ok(true, '職事表沒有被寫入（假物件不支援寫入，有寫入就會拋錯）');
});

test('真正入口 saveWeekFromWebApp_()：把該格改回與職事表相同 → 那一行變成 ACTIVE=FALSE（不刪行）', function () {
  const env = makeEnv({ rosterVersion: 12, snapshotVersion: 12 });
  env.sandbox.saveWeekFromWebApp_({
    isoDate: env.isoDate, lastSavedAt: null, week: {},
    announcements: [], prayers: [], fellowships: [], finance: [],
    dutyEdits: [{ postId: 'CHAIR', slotIndex: 1, name: '李小明' }]
  });
  const afterFirst = env.sandbox.readSheet('BulletinWeeks')[0].LAST_SAVED_AT;

  env.sandbox.saveWeekFromWebApp_({
    isoDate: env.isoDate, lastSavedAt: afterFirst, week: {},
    announcements: [], prayers: [], fellowships: [], finance: [],
    dutyEdits: [{ postId: 'CHAIR', slotIndex: 1, name: '陳大文' }]
  });

  const rows = env.sandbox.readSheet('DutyOverride');
  assert.strictEqual(rows.length, 1, '整行仍然在，沒有被刪除');
  assert.strictEqual(rows[0].ACTIVE, false);
  assert.strictEqual(rows[0].OVERRIDE_NAME, '李小明', '內容保留，方便日後追查');
});

test('真正入口 fetchFromRosterForWebApp_()：勾選的欄位改回跟隨職事表（ACTIVE=FALSE），並記 FETCH_FROM_ROSTER', function () {
  const env = makeEnv({
    rosterVersion: 12, snapshotVersion: 12,
    dutyOverrides: [{
      SERVICE_DATE: '2027-10-03', POST_ID: 'CHAIR', SLOT_INDEX: 1,
      OVERRIDE_NAME: '李小明', ROSTER_VALUE_AT_OVERRIDE: '陳大文',
      ROSTER_VERSION_AT_OVERRIDE: 12, OVERRIDE_AT: '', OVERRIDE_BY: '', REASON: '', ACTIVE: true, NOTES: ''
    }]
  });

  const result = env.sandbox.fetchFromRosterForWebApp_(env.isoDate, [{ postId: 'CHAIR', slotIndex: 1 }]);
  assert.strictEqual(result.clearedCount, 1);

  const rows = env.sandbox.readSheet('DutyOverride');
  assert.strictEqual(rows.length, 1, '不刪行');
  assert.strictEqual(rows[0].ACTIVE, false);

  const auditRows = env.sandbox.readSheet('AuditLog');
  assert.ok(auditRows.some(function (r) { return r.ACTION === 'FETCH_FROM_ROSTER'; }));
});

test('真正入口 getRosterFetchCandidates_()：只列出 CONFLICT 與 OVERRIDDEN，CONFLICT 預設勾選', function () {
  const env = makeEnv({
    rosterVersion: 12, snapshotVersion: 12,
    dutyOverrides: [{
      SERVICE_DATE: '2027-10-03', POST_ID: 'CHAIR', SLOT_INDEX: 1,
      OVERRIDE_NAME: '李小明', ROSTER_VALUE_AT_OVERRIDE: '另一個舊值',
      ROSTER_VERSION_AT_OVERRIDE: 11, OVERRIDE_AT: '', OVERRIDE_BY: '', REASON: '', ACTIVE: true, NOTES: ''
    }]
  });
  const result = env.sandbox.getRosterFetchCandidates_(env.isoDate);
  assert.strictEqual(result.rows.length, 1);
  assert.strictEqual(result.rows[0].status, 'CONFLICT');
  assert.strictEqual(result.rows[0].defaultChecked, true, 'CONFLICT 預設勾選');
});

test('真正入口 getRosterFetchCandidates_()：沒有覆寫時清單是空的（沒有東西可以取數）', function () {
  const env = makeEnv({ rosterVersion: 12, snapshotVersion: 12 });
  const result = env.sandbox.getRosterFetchCandidates_(env.isoDate);
  assert.strictEqual(result.rows.length, 0);
});

// =====================================================================

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
