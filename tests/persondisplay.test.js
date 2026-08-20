#!/usr/bin/env node
/**
 * tests/persondisplay.test.js
 *
 * src/PersonDisplay.gs 的回歸測試：姓名／尊稱／顯示覆寫／生效日期，
 * 以及 slot 四種狀態的顯示文字。全部走純函式層，不需要 SpreadsheetApp。
 *
 * 執行方式：node tests/persondisplay.test.js
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

const {
  resolvePersonDisplay_, resolveSlotDisplay_, isTitleHonorific_,
  findPersonDisplayRow_, ROSTER_SLOT_STATE_
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

/** 用 sandbox 自己的 normalizeDate_ 造 Date，避免 vm 的跨 realm instanceof 坑。 */
function d(iso) {
  return sandbox.normalizeDate_(iso);
}

function personRow(overrides) {
  return Object.assign({
    PERSON_ID: 'P9001', NAME_TC: '陳大文', HONORIFIC: '弟兄', DISPLAY_OVERRIDE: '',
    EFFECTIVE_FROM: null, EFFECTIVE_TO: null, ACTIVE: true, NOTES: ''
  }, overrides || {});
}

function opts(overrides) {
  return Object.assign({
    withHonorific: true,
    personDisplayRows: [],
    targetDate: d('2027-10-03'),
    warnings: []
  }, overrides || {});
}

// =====================================================================
// isTitleHonorific_
// =====================================================================

test('isTitleHonorific_：牧師／師母／傳道／宣教士是職稱類', function () {
  ['牧師', '師母', '傳道', '宣教士'].forEach(function (h) {
    assert.strictEqual(isTitleHonorific_(h), true, h + ' 應該是職稱類');
  });
});

test('isTitleHonorific_：弟兄／姊妹／空白不是職稱類', function () {
  ['弟兄', '姊妹', '', null, undefined, '  '].forEach(function (h) {
    assert.strictEqual(isTitleHonorific_(h), false, JSON.stringify(h) + ' 不應該是職稱類');
  });
});

// =====================================================================
// 有／無 PersonDisplay 行
// =====================================================================

test('有 PersonDisplay 行、withHonorific=true → 姓名後接尊稱', function () {
  var o = opts({ personDisplayRows: [personRow()] });
  assert.strictEqual(resolvePersonDisplay_('P9001', '陳大文', o), '陳大文弟兄');
  assert.strictEqual(o.warnings.length, 0);
});

test('有 PersonDisplay 行、withHonorific=false → 只有姓名（弟兄姊妹被省略）', function () {
  var o = opts({ withHonorific: false, personDisplayRows: [personRow()] });
  assert.strictEqual(resolvePersonDisplay_('P9001', '陳大文', o), '陳大文');
});

test('找不到 PersonDisplay 行 → 用原名，並記一筆 NO_PERSON_DISPLAY 警告（不可以靜靜當成沒有尊稱）', function () {
  var o = opts({ personDisplayRows: [] });
  assert.strictEqual(resolvePersonDisplay_('P9002', '李小明', o), '李小明');
  assert.strictEqual(o.warnings.length, 1);
  assert.strictEqual(o.warnings[0].code, 'NO_PERSON_DISPLAY');
  assert.strictEqual(o.warnings[0].personId, 'P9002');
  assert.strictEqual(o.warnings[0].name, '李小明');
});

test('PersonDisplay 行存在但 ACTIVE=FALSE → 視為找不到，記警告', function () {
  var o = opts({ personDisplayRows: [personRow({ ACTIVE: false })] });
  assert.strictEqual(resolvePersonDisplay_('P9001', '陳大文', o), '陳大文');
  assert.strictEqual(o.warnings.length, 1);
  assert.strictEqual(o.warnings[0].code, 'NO_PERSON_DISPLAY');
});

test('personId 是空字串（例如佔位符 slot）→ 用原名，且不記警告', function () {
  var o = opts({ personDisplayRows: [] });
  assert.strictEqual(resolvePersonDisplay_('', '待確認', o), '待確認');
  assert.strictEqual(o.warnings.length, 0, '沒有 PersonID 本來就查不到，不應該報「缺尊稱設定」');
});

test('有 PersonDisplay 行但 HONORIFIC 留空 → 只有姓名，不記警告', function () {
  var o = opts({ personDisplayRows: [personRow({ HONORIFIC: '' })] });
  assert.strictEqual(resolvePersonDisplay_('P9001', '陳大文', o), '陳大文');
  assert.strictEqual(o.warnings.length, 0);
});

// =====================================================================
// DISPLAY_OVERRIDE
// =====================================================================

test('DISPLAY_OVERRIDE 有值 → 直接用它，不加任何尊稱（withHonorific=true 也一樣）', function () {
  var o = opts({ personDisplayRows: [personRow({ DISPLAY_OVERRIDE: '陳大文夫婦' })] });
  assert.strictEqual(resolvePersonDisplay_('P9001', '陳大文', o), '陳大文夫婦');
});

test('DISPLAY_OVERRIDE 覆寫連職稱類尊稱都不加', function () {
  var o = opts({ personDisplayRows: [personRow({ HONORIFIC: '牧師', DISPLAY_OVERRIDE: '主任牧師' })] });
  assert.strictEqual(resolvePersonDisplay_('P9001', '陳大文', o), '主任牧師');
});

// =====================================================================
// EFFECTIVE_FROM / EFFECTIVE_TO 邊界
// =====================================================================

test('EFFECTIVE_FROM／TO 兩欄留空 → 不限，任何日期都生效', function () {
  var o = opts({ targetDate: d('2020-01-01'), personDisplayRows: [personRow()] });
  assert.strictEqual(resolvePersonDisplay_('P9001', '陳大文', o), '陳大文弟兄');
});

test('目標日期剛好等於 EFFECTIVE_FROM → 生效（邊界含入）', function () {
  var o = opts({ targetDate: d('2027-10-03'), personDisplayRows: [personRow({ EFFECTIVE_FROM: d('2027-10-03') })] });
  assert.strictEqual(resolvePersonDisplay_('P9001', '陳大文', o), '陳大文弟兄');
});

test('目標日期剛好等於 EFFECTIVE_TO → 生效（邊界含入）', function () {
  var o = opts({ targetDate: d('2027-10-03'), personDisplayRows: [personRow({ EFFECTIVE_TO: d('2027-10-03') })] });
  assert.strictEqual(resolvePersonDisplay_('P9001', '陳大文', o), '陳大文弟兄');
});

test('目標日期早於 EFFECTIVE_FROM → 不生效，記警告', function () {
  var o = opts({ targetDate: d('2027-10-02'), personDisplayRows: [personRow({ EFFECTIVE_FROM: d('2027-10-03') })] });
  assert.strictEqual(resolvePersonDisplay_('P9001', '陳大文', o), '陳大文');
  assert.strictEqual(o.warnings.length, 1);
});

test('目標日期晚於 EFFECTIVE_TO → 不生效，記警告', function () {
  var o = opts({ targetDate: d('2027-10-04'), personDisplayRows: [personRow({ EFFECTIVE_TO: d('2027-10-03') })] });
  assert.strictEqual(resolvePersonDisplay_('P9001', '陳大文', o), '陳大文');
  assert.strictEqual(o.warnings.length, 1);
});

test('同一個 PersonID 有兩行、只有一行在生效期內 → 取生效那一行', function () {
  var o = opts({
    targetDate: d('2027-10-03'),
    personDisplayRows: [
      personRow({ HONORIFIC: '弟兄', EFFECTIVE_TO: d('2027-09-30') }),
      personRow({ HONORIFIC: '傳道', EFFECTIVE_FROM: d('2027-10-01') })
    ]
  });
  assert.strictEqual(resolvePersonDisplay_('P9001', '陳大文', o), '陳大文傳道');
});

test('findPersonDisplayRow_：targetDate 為 null 時完全不做生效日期篩選', function () {
  var row = findPersonDisplayRow_('P9001', [personRow({ EFFECTIVE_FROM: d('2099-01-01') })], null);
  assert.ok(row, 'targetDate 為 null 時應該照樣找得到');
});

// =====================================================================
// 職稱類尊稱兩頁都保留
// =====================================================================

['牧師', '師母', '傳道', '宣教士'].forEach(function (title) {
  test('職稱類尊稱「' + title + '」在 withHonorific=false（第 3 頁）也照樣顯示', function () {
    var o = opts({ withHonorific: false, personDisplayRows: [personRow({ HONORIFIC: title })] });
    assert.strictEqual(resolvePersonDisplay_('P9001', '王美美', o), '王美美' + title);
  });

  test('職稱類尊稱「' + title + '」在 withHonorific=true（第 1 頁）當然也顯示', function () {
    var o = opts({ withHonorific: true, personDisplayRows: [personRow({ HONORIFIC: title })] });
    assert.strictEqual(resolvePersonDisplay_('P9001', '王美美', o), '王美美' + title);
  });
});

['弟兄', '姊妹'].forEach(function (general) {
  test('一般敬稱「' + general + '」受 withHonorific 控制：true 顯示、false 省略', function () {
    var withOn = opts({ withHonorific: true, personDisplayRows: [personRow({ HONORIFIC: general })] });
    var withOff = opts({ withHonorific: false, personDisplayRows: [personRow({ HONORIFIC: general })] });
    assert.strictEqual(resolvePersonDisplay_('P9001', '陳大文', withOn), '陳大文' + general);
    assert.strictEqual(resolvePersonDisplay_('P9001', '陳大文', withOff), '陳大文');
  });
});

// =====================================================================
// resolveSlotDisplay_
// =====================================================================

test('resolveSlotDisplay_：NOT_APPLICABLE 回 null（代表整行不出現，不是顯示「—」）', function () {
  var slot = { postId: 'COMMUNION', state: ROSTER_SLOT_STATE_.NOT_APPLICABLE, personId: null, personName: '' };
  assert.strictEqual(resolveSlotDisplay_(slot, opts()), null);
});

test('resolveSlotDisplay_：EXTERNAL 回負責單位名稱', function () {
  var slot = { postId: 'WORSHIP', state: ROSTER_SLOT_STATE_.EXTERNAL, externalOwner: '英語堂敬拜隊' };
  assert.strictEqual(resolveSlotDisplay_(slot, opts()), '英語堂敬拜隊');
});

test('resolveSlotDisplay_：PENDING 回空字串', function () {
  var slot = { postId: 'PREACHER', state: ROSTER_SLOT_STATE_.PENDING, personId: null, personName: '' };
  assert.strictEqual(resolveSlotDisplay_(slot, opts()), '');
});

test('resolveSlotDisplay_：ASSIGNED 走 resolvePersonDisplay_', function () {
  var slot = { postId: 'CHAIR', state: ROSTER_SLOT_STATE_.ASSIGNED, personId: 'P9001', personName: '陳大文' };
  var o = opts({ personDisplayRows: [personRow()] });
  assert.strictEqual(resolveSlotDisplay_(slot, o), '陳大文弟兄');
});

// =====================================================================

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
