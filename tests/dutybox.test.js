#!/usr/bin/env node
/**
 * tests/dutybox.test.js
 *
 * src/DutyBox.gs 的回歸測試：合併組規則、多 slot 合併成一格、四種 slot
 * 狀態對版面的影響、第 1 頁與第 3 頁的差異。全部走純函式層
 * （buildDutyBoxRows_），不需要 SpreadsheetApp。
 *
 * 執行方式：node tests/dutybox.test.js
 * 離開碼：0＝全部通過　1＝有測試失敗
 */

'use strict';

const assert = require('assert');
const { loadAllSrcFilesInOrder } = require('./helpers/loadGas');

const sandbox = loadAllSrcFilesInOrder({
  Utilities: { formatDate: function () { return ''; } },
  Session: {
    getScriptTimeZone: function () { return 'Pacific/Auckland'; },
    getActiveUser: function () { return { getEmail: function () { return ''; } }; }
  },
  SpreadsheetApp: {},
  CacheService: {}
});

const { buildDutyBoxRows_, buildRosterSlotIndex_, ROSTER_SLOT_STATE_ } = sandbox;

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

function d(iso) { return sandbox.normalizeDate_(iso); }

/**
 * ⚠️ 不能用 assert.deepStrictEqual 比較「sandbox 內建構的陣列」與「這個
 * 測試檔案的陣列字面值」：兩者的 Array.prototype 來自不同 vm realm，
 * deepStrictEqual 連原型鏈都比，內容一樣也會判定不相等
 * （同 tests/rostersnapshot.test.js 的說明）。
 */
function assertArrayEqual(actual, expected, message) {
  assert.strictEqual(JSON.stringify(actual), JSON.stringify(expected), message);
}

/** 直接用 Bootstrap.gs seed 的 16 個崗位定義，確保測試跟真實資料一致。 */
function seededPostDisplayRows() {
  return sandbox.seedPostDisplayRows_();
}

/** 直接用 Bootstrap.gs seed 的兩個合併組定義。 */
function seededMergeGroupRows() {
  return sandbox.seedMergeGroupsRows_();
}

/**
 * 造一個最小可用的職事表快照。`posts` 用 postId → {frequency, slotCount}
 * 描述，`assignments` 用 [{postId, slotIndex, personId, personName}] 描述。
 */
function makeSnapshot(overrides) {
  var o = overrides || {};
  var posts = o.posts || {};
  var snapshot = {
    isoDate: o.isoDate || '2027-10-03',
    weekOfMonth: o.weekOfMonth === undefined ? 1 : o.weekOfMonth,
    special: o.special === undefined ? null : o.special,
    posts: Object.keys(posts).map(function (postId, idx) {
      return {
        postId: postId,
        nameTC: posts[postId].nameTC || postId,
        slotCount: posts[postId].slotCount || 1,
        frequency: posts[postId].frequency || 'WEEKLY',
        autoGenerate: true,
        displayOrder: (idx + 1) * 10,
        emptyDisplay: 'PENDING'
      };
    }),
    assignments: (o.assignments || []).map(function (a) {
      return {
        postId: a.postId,
        slotIndex: a.slotIndex === undefined ? 1 : a.slotIndex,
        personId: a.personId === undefined ? null : a.personId,
        personName: a.personName === undefined ? '' : a.personName,
        assignSource: 'AUTO',
        locked: false
      };
    })
  };
  snapshot.slotsByPost = buildRosterSlotIndex_(snapshot, o.communionWeeks || [1]);
  return snapshot;
}

/** PersonDisplay 資料列：personId → 姓名（一律不設尊稱，讓測試專注在合併規則）。 */
function personDisplayRowsFor(personIds) {
  return personIds.map(function (id) {
    return {
      PERSON_ID: id, NAME_TC: '', HONORIFIC: '', DISPLAY_OVERRIDE: '',
      EFFECTIVE_FROM: null, EFFECTIVE_TO: null, ACTIVE: true, NOTES: ''
    };
  });
}

function build(snapshot, page, extra) {
  var e = extra || {};
  return buildDutyBoxRows_({
    snapshot: snapshot,
    page: page,
    postDisplayRows: e.postDisplayRows || seededPostDisplayRows(),
    mergeGroupRows: e.mergeGroupRows || seededMergeGroupRows(),
    personDisplayRows: e.personDisplayRows || [],
    withHonorific: e.withHonorific === true,
    targetDate: e.targetDate || d(snapshot.isoDate),
    warnings: e.warnings || []
  });
}

function rowFor(rows, label) {
  return rows.filter(function (r) { return r.label === label; })[0] || null;
}

// =====================================================================
// MG_CHAIR_ANNOUNCE：只在同一人時合併
// =====================================================================

test('MG_CHAIR_ANNOUNCE 同一人 → 合併成「主席及報告」一行', function () {
  var snapshot = makeSnapshot({
    posts: { CHAIR: {}, ANNOUNCE: {} },
    assignments: [
      { postId: 'CHAIR', personId: 'P9001', personName: '陳大文' },
      { postId: 'ANNOUNCE', personId: 'P9001', personName: '陳大文' }
    ]
  });
  var rows = build(snapshot, 1);
  var merged = rowFor(rows, '主席及報告');
  assert.ok(merged, '應該有「主席及報告」一行');
  assert.strictEqual(merged.text, '陳大文');
  assertArrayEqual(merged.postIds.slice().sort(), ['ANNOUNCE', 'CHAIR']);
  assert.strictEqual(rowFor(rows, '主席'), null, '合併之後不應該再有獨立的「主席」行');
  assert.strictEqual(rowFor(rows, '報告'), null, '合併之後不應該再有獨立的「報告」行');
});

test('MG_CHAIR_ANNOUNCE 不同人 → 不合併，各自一行', function () {
  var snapshot = makeSnapshot({
    posts: { CHAIR: {}, ANNOUNCE: {} },
    assignments: [
      { postId: 'CHAIR', personId: 'P9001', personName: '陳大文' },
      { postId: 'ANNOUNCE', personId: 'P9002', personName: '李小明' }
    ]
  });
  var rows = build(snapshot, 1);
  assert.strictEqual(rowFor(rows, '主席及報告'), null, '不同人時不應該合併');
  assert.strictEqual(rowFor(rows, '主席').text, '陳大文');
  assert.strictEqual(rowFor(rows, '報告').text, '李小明');
});

test('MG_CHAIR_ANNOUNCE 一人已排、另一人未排 → 不合併（不可以顯示成「主席及報告：甲」）', function () {
  var snapshot = makeSnapshot({
    posts: { CHAIR: {}, ANNOUNCE: {} },
    assignments: [
      { postId: 'CHAIR', personId: 'P9001', personName: '陳大文' },
      { postId: 'ANNOUNCE', personId: null, personName: '' }
    ]
  });
  var rows = build(snapshot, 1);
  assert.strictEqual(rowFor(rows, '主席及報告'), null);
  assert.strictEqual(rowFor(rows, '主席').text, '陳大文');
  assert.strictEqual(rowFor(rows, '報告').text, '');
  assert.strictEqual(rowFor(rows, '報告').isPending, true);
});

test('MG_CHAIR_ANNOUNCE 第 3 頁不設合併組 → 一定各自一行，就算同一人', function () {
  var snapshot = makeSnapshot({
    posts: { CHAIR: {}, ANNOUNCE: {} },
    assignments: [
      { postId: 'CHAIR', personId: 'P9001', personName: '陳大文' },
      { postId: 'ANNOUNCE', personId: 'P9001', personName: '陳大文' }
    ]
  });
  var rows = build(snapshot, 3);
  assert.strictEqual(rowFor(rows, '主席及報告'), null);
  assert.strictEqual(rowFor(rows, '主席').text, '陳大文');
  assert.strictEqual(rowFor(rows, '報告').text, '陳大文');
});

// =====================================================================
// MG_AV：永遠合併
// =====================================================================

test('MG_AV 兩個不同人 → 合併一行、兩個名', function () {
  var snapshot = makeSnapshot({
    posts: { SOUND: {}, PPT: {} },
    assignments: [
      { postId: 'SOUND', personId: 'P9001', personName: '陳大文' },
      { postId: 'PPT', personId: 'P9002', personName: '李小明' }
    ]
  });
  var rows = build(snapshot, 1);
  var av = rowFor(rows, '影音');
  assert.ok(av, '應該有「影音」一行');
  assert.strictEqual(av.text, '陳大文 李小明');
  assert.strictEqual(rows.filter(function (r) { return r.label === '影音'; }).length, 1, '「影音」只應該出現一行');
});

test('MG_AV 同一人同時擔任 SOUND 與 PPT → 合併一行、只出現一個名', function () {
  var snapshot = makeSnapshot({
    posts: { SOUND: {}, PPT: {} },
    assignments: [
      { postId: 'SOUND', personId: 'P9001', personName: '陳大文' },
      { postId: 'PPT', personId: 'P9001', personName: '陳大文' }
    ]
  });
  var rows = build(snapshot, 1);
  assert.strictEqual(rowFor(rows, '影音').text, '陳大文');
});

test('MG_AV 依組內 PAGEn_ORDER 排序：第 1 頁 SOUND(90) 先於 PPT(91)，第 3 頁 SOUND(80) 先於 PPT(81)', function () {
  var snapshot = makeSnapshot({
    posts: { SOUND: {}, PPT: {} },
    assignments: [
      { postId: 'PPT', personId: 'P9002', personName: '李小明' },
      { postId: 'SOUND', personId: 'P9001', personName: '陳大文' }
    ]
  });
  assert.strictEqual(rowFor(build(snapshot, 1), '影音').text, '陳大文 李小明');
  assert.strictEqual(rowFor(build(snapshot, 3), '影音').text, '陳大文 李小明');
});

// =====================================================================
// 同一崗位多個 slot 合併成一格
// =====================================================================

test('司事 2 人 → 一行，名字用空格分隔，按 slotIndex 排序', function () {
  var snapshot = makeSnapshot({
    posts: { USHER: { slotCount: 2 } },
    assignments: [
      { postId: 'USHER', slotIndex: 2, personId: 'P9002', personName: '李小明' },
      { postId: 'USHER', slotIndex: 1, personId: 'P9001', personName: '陳大文' }
    ]
  });
  var rows = build(snapshot, 1);
  assert.strictEqual(rowFor(rows, '司事').text, '陳大文 李小明');
});

test('聖餐輔禮 4 人 → 一行、四個名字用空格分隔', function () {
  var snapshot = makeSnapshot({
    weekOfMonth: 1,
    posts: { COMMUNION: { frequency: 'FIRST_SUNDAY', slotCount: 4 } },
    assignments: [
      { postId: 'COMMUNION', slotIndex: 1, personId: 'P9001', personName: '甲' },
      { postId: 'COMMUNION', slotIndex: 2, personId: 'P9002', personName: '乙' },
      { postId: 'COMMUNION', slotIndex: 3, personId: 'P9003', personName: '丙' },
      { postId: 'COMMUNION', slotIndex: 4, personId: 'P9004', personName: '丁' }
    ]
  });
  var rows = build(snapshot, 1);
  assert.strictEqual(rowFor(rows, '聖餐輔禮').text, '甲 乙 丙 丁');
});

// =====================================================================
// NOT_APPLICABLE：整行不出現
// =====================================================================

test('首主日以外，聖餐輔禮 NOT_APPLICABLE → 該行完全不出現（不是顯示「—」或空白）', function () {
  var snapshot = makeSnapshot({
    weekOfMonth: 2,
    communionWeeks: [1],
    posts: { COMMUNION: { frequency: 'FIRST_SUNDAY', slotCount: 4 }, CHAIR: {} },
    assignments: [{ postId: 'CHAIR', personId: 'P9001', personName: '陳大文' }]
  });
  var rows = build(snapshot, 1);
  assert.strictEqual(rowFor(rows, '聖餐輔禮'), null, '非首主日時聖餐輔禮那一行要整行消失');
  assert.ok(rowFor(rows, '主席'), '其餘崗位照常出現');
});

test('首主日時，聖餐輔禮照常出現（就算未排人也只是 PENDING）', function () {
  var snapshot = makeSnapshot({
    weekOfMonth: 1,
    communionWeeks: [1],
    posts: { COMMUNION: { frequency: 'FIRST_SUNDAY', slotCount: 4 } },
    assignments: []
  });
  var rows = build(snapshot, 1);
  var row = rowFor(rows, '聖餐輔禮');
  assert.ok(row, '首主日應該有聖餐輔禮這一行');
  assert.strictEqual(row.text, '');
  assert.strictEqual(row.isPending, true);
});

test('COMMUNION_WEEKS 改成 [2] → 第 2 個主日才出現聖餐輔禮（證明沒有寫死「首主日」）', function () {
  var week1 = makeSnapshot({
    weekOfMonth: 1, communionWeeks: [2],
    posts: { COMMUNION: { frequency: 'FIRST_SUNDAY' } }, assignments: []
  });
  var week2 = makeSnapshot({
    weekOfMonth: 2, communionWeeks: [2],
    posts: { COMMUNION: { frequency: 'FIRST_SUNDAY' } }, assignments: []
  });
  assert.strictEqual(rowFor(build(week1, 1), '聖餐輔禮'), null);
  assert.ok(rowFor(build(week2, 1), '聖餐輔禮'));
});

test('整個合併組都 NOT_APPLICABLE → 該組那一行不出現', function () {
  var snapshot = makeSnapshot({
    weekOfMonth: 2,
    special: { skipPostIds: ['SOUND', 'PPT'], externalOwner: '', title: '', type: '' },
    posts: { SOUND: {}, PPT: {}, CHAIR: {} },
    assignments: [{ postId: 'CHAIR', personId: 'P9001', personName: '陳大文' }]
  });
  var rows = build(snapshot, 1);
  assert.strictEqual(rowFor(rows, '影音'), null);
  assert.ok(rowFor(rows, '主席'));
});

test('合併組內部分崗位 NOT_APPLICABLE → 只略過該崗位，其餘照合併', function () {
  var snapshot = makeSnapshot({
    special: { skipPostIds: ['PPT'], externalOwner: '', title: '', type: '' },
    posts: { SOUND: {}, PPT: {} },
    assignments: [
      { postId: 'SOUND', personId: 'P9001', personName: '陳大文' },
      { postId: 'PPT', personId: 'P9002', personName: '李小明' }
    ]
  });
  var rows = build(snapshot, 1);
  var av = rowFor(rows, '影音');
  assert.ok(av, '「影音」那一行仍然要在');
  assert.strictEqual(av.text, '陳大文', 'PPT 被跳過，只剩音響那個人');
  assertArrayEqual(av.postIds, ['SOUND']);
});

// =====================================================================
// EXTERNAL
// =====================================================================

test('skipPostIds 含 WORSHIP 且有 externalOwner → 顯示「英語堂敬拜隊」', function () {
  var snapshot = makeSnapshot({
    special: { skipPostIds: ['WORSHIP'], externalOwner: '英語堂敬拜隊', title: '', type: '' },
    posts: { WORSHIP: {} },
    assignments: [{ postId: 'WORSHIP', personId: null, personName: '' }]
  });
  var rows = build(snapshot, 1);
  var row = rowFor(rows, '領詩');
  assert.ok(row);
  assert.strictEqual(row.text, '英語堂敬拜隊');
  assertArrayEqual(row.states, [ROSTER_SLOT_STATE_.EXTERNAL]);
  assert.strictEqual(row.isPending, false, '外判崗位不算待填');
});

test('skipPostIds 含 WORSHIP 但 externalOwner 空白 → NOT_APPLICABLE，該行不出現', function () {
  var snapshot = makeSnapshot({
    special: { skipPostIds: ['WORSHIP'], externalOwner: '', title: '', type: '' },
    posts: { WORSHIP: {}, CHAIR: {} },
    assignments: [{ postId: 'CHAIR', personId: 'P9001', personName: '陳大文' }]
  });
  assert.strictEqual(rowFor(build(snapshot, 1), '領詩'), null);
});

test('外判優先於已排定：崗位在 skipPostIds 且有 externalOwner，就算職事表留了人名也顯示負責單位', function () {
  var snapshot = makeSnapshot({
    special: { skipPostIds: ['WORSHIP'], externalOwner: '英語堂敬拜隊', title: '', type: '' },
    posts: { WORSHIP: {} },
    assignments: [{ postId: 'WORSHIP', personId: 'P9001', personName: '陳大文' }]
  });
  assert.strictEqual(rowFor(build(snapshot, 1), '領詩').text, '英語堂敬拜隊');
});

// =====================================================================
// 第 1 頁與第 3 頁的差異
// =====================================================================

test('第 1 頁不出現交通指揮／司數／獻花', function () {
  var snapshot = makeSnapshot({
    posts: { TRAFFIC: {}, COUNT: {}, FLOWER: {}, CHAIR: {} },
    assignments: [
      { postId: 'TRAFFIC', personId: 'P9001', personName: '甲' },
      { postId: 'COUNT', personId: 'P9002', personName: '乙' },
      { postId: 'FLOWER', personId: 'P9003', personName: '丙' },
      { postId: 'CHAIR', personId: 'P9004', personName: '丁' }
    ]
  });
  var rows = build(snapshot, 1);
  assert.strictEqual(rowFor(rows, '交通指揮'), null);
  assert.strictEqual(rowFor(rows, '司數'), null);
  assert.strictEqual(rowFor(rows, '獻花'), null);
  assert.ok(rowFor(rows, '主席'));
});

test('第 3 頁出現交通指揮／司數，仍然不出現獻花', function () {
  var snapshot = makeSnapshot({
    posts: { TRAFFIC: {}, COUNT: {}, FLOWER: {} },
    assignments: [
      { postId: 'TRAFFIC', personId: 'P9001', personName: '甲' },
      { postId: 'COUNT', personId: 'P9002', personName: '乙' },
      { postId: 'FLOWER', personId: 'P9003', personName: '丙' }
    ]
  });
  var rows = build(snapshot, 3);
  assert.ok(rowFor(rows, '交通指揮'), '第 3 頁要有交通指揮');
  assert.ok(rowFor(rows, '司數'), '第 3 頁要有司數');
  assert.strictEqual(rowFor(rows, '獻花'), null, '獻花兩頁都不在事奉框內（由 FLOWER_THIS_WEEK 另行處理）');
});

test('輸出次序依該頁的 PAGEn_ORDER：第 3 頁司事(70) 在當值堂委(120) 之前', function () {
  var snapshot = makeSnapshot({
    posts: { USHER: {}, DEACON: {} },
    assignments: [
      { postId: 'DEACON', personId: 'P9002', personName: '乙' },
      { postId: 'USHER', personId: 'P9001', personName: '甲' }
    ]
  });
  var labels = build(snapshot, 3).map(function (r) { return r.label; });
  assert.ok(labels.indexOf('司事') < labels.indexOf('當值堂委'), '實際次序：' + labels.join('→'));
});

// =====================================================================
// 其他
// =====================================================================

test('崗位完全沒有派工紀錄 → 仍然出現一行，狀態 PENDING、內容空白', function () {
  var snapshot = makeSnapshot({ posts: { PREACHER: {} }, assignments: [] });
  var row = rowFor(build(snapshot, 1), '講員');
  assert.ok(row, '崗位存在但未排人，那一行仍然要在（讓人知道要去填）');
  assert.strictEqual(row.text, '');
  assertArrayEqual(row.states, [ROSTER_SLOT_STATE_.PENDING]);
  assert.strictEqual(row.isPending, true);
});

test('MergeGroups 找不到定義 → 記 MERGE_GROUP_NOT_FOUND 警告，並退回各自一行', function () {
  var snapshot = makeSnapshot({
    posts: { SOUND: {}, PPT: {} },
    assignments: [
      { postId: 'SOUND', personId: 'P9001', personName: '甲' },
      { postId: 'PPT', personId: 'P9002', personName: '乙' }
    ]
  });
  var warnings = [];
  var rows = build(snapshot, 1, { mergeGroupRows: [], warnings: warnings });
  assert.ok(warnings.some(function (w) { return w.code === 'MERGE_GROUP_NOT_FOUND'; }));
  assert.strictEqual(rows.filter(function (r) { return r.label === '影音'; }).length, 2,
    '退回各自一行時，兩個崗位的 PAGE1_NAME 都是「影音」，所以會有兩行');
});

test('page 不是 1 或 3 → 拋錯', function () {
  var snapshot = makeSnapshot({ posts: { CHAIR: {} }, assignments: [] });
  assert.throws(function () { build(snapshot, 2); });
});

// =====================================================================

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
