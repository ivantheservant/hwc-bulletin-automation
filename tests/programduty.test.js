#!/usr/bin/env node
/**
 * tests/programduty.test.js
 *
 * 2026-11-03（Ivan 轉述職事表那邊核對 09-27）：程序表的「聖餐」跟職事表「聖餐襄禮」有沒有人，
 *   不要週報自己判斷。新條件 `IF_DUTY:<PostID>|<後備條件>`（src/ProgramTable.gs）：
 *   - 那個崗位這一週有人 → 出現（例如某個第三主日另外有聖餐）；
 *   - 職事表講明「不設」（RuleFlags）→ 不出現（09-27 不是每月第一個主日）；
 *   - 未排定、職事表沒有這一日 → 按後備條件（聖餐＝WEEK_IN:1，浸禮合堂＝ALWAYS）。
 *
 *   ⚠️ bug class 5：除純函式之外，由真正入口 `buildBulletinModel_()` 叫一次（假職事表）。
 *
 * 執行方式：node tests/programduty.test.js
 * 離開碼：0＝全部通過　1＝有測試失敗
 */

'use strict';

const assert = require('assert');
const { makeFillEnv, QUARTER_ID } = require('./helpers/fillEnv');

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

const WEEK1 = '2027-11-07';
const WEEK4 = '2027-11-28';

const POSTS = [
  { PostID: 'PREACHER', PostName_TC: '講員', SlotCount: 1, Frequency: 'WEEKLY', AutoGenerate: false, DisplayOrder: 20, Active: true, EmptyDisplay: 'PENDING' },
  { PostID: 'COMMUNION', PostName_TC: '聖餐襄禮', SlotCount: 2, Frequency: 'FIRST_SUNDAY', AutoGenerate: true, DisplayOrder: 120, Active: true, EmptyDisplay: 'PENDING' }
];

function assignment(iso, postId, slot, name, ruleFlags) {
  return {
    QuarterID: QUARTER_ID, VersionNo: 3, ServiceDate: iso, PostID: postId, SlotIndex: slot,
    PersonID: '', PersonNameSnapshot: name || '', AssignSource: 'AUTO', Locked: false, RuleFlags: ruleFlags || ''
  };
}

function programNames(assignments, iso) {
  const env = makeFillEnv({
    withGrid: false,
    rosterPosts: POSTS,
    rosterAssignments: [assignment(WEEK1, 'PREACHER', 1, '黃牧師'), assignment(WEEK4, 'PREACHER', 1, '何牧師')].concat(assignments),
    weekRows: [
      { SERVICE_DATE: WEEK1, QUARTER_ID: QUARTER_ID, WEEK_OF_MONTH: 1, STATUS: 'DRAFT' },
      { SERVICE_DATE: WEEK4, QUARTER_ID: QUARTER_ID, WEEK_OF_MONTH: 4, STATUS: 'DRAFT' }
    ]
  });
  const model = env.sandbox.buildBulletinModel_(iso);
  return Array.from(model.program || []).map(function (r) { return String(r.itemName); });
}

function slots(states) {
  return { COMMUNION: states.map(function (s, i) { return { postId: 'COMMUNION', slotIndex: i + 1, state: s }; }) };
}

// =====================================================================
console.log('\n純函式：IF_DUTY:');
// =====================================================================

const sb = makeFillEnv({ withGrid: false, rosterPosts: POSTS, rosterAssignments: [] }).sandbox;
const ROW = { TEMPLATE_ID: 'TPL_NORMAL', SEQ_NO: 100, ITEM_NAME: '聖餐' };

function evalCond(cond, ctx) {
  return sb.evaluateProgramCondition_(cond, Object.assign({ week: {}, weekOfMonth: 1, row: ROW, slotsByPost: null }, ctx || {}));
}

test('有人 → 出現（即使不是第一個主日）', function () {
  assert.strictEqual(evalCond('IF_DUTY:COMMUNION|WEEK_IN:1', { weekOfMonth: 3, slotsByPost: slots(['ASSIGNED', 'PENDING']) }), true);
});

test('職事表「不設」→ 不出現（即使是第一個主日）', function () {
  assert.strictEqual(evalCond('IF_DUTY:COMMUNION|WEEK_IN:1', { weekOfMonth: 1, slotsByPost: slots(['NOT_APPLICABLE', 'NOT_APPLICABLE']) }), false);
});

test('未排定 → 按後備條件（第一個主日出現、第四個不出現）', function () {
  assert.strictEqual(evalCond('IF_DUTY:COMMUNION|WEEK_IN:1', { weekOfMonth: 1, slotsByPost: slots(['PENDING', 'PENDING']) }), true);
  assert.strictEqual(evalCond('IF_DUTY:COMMUNION|WEEK_IN:1', { weekOfMonth: 4, slotsByPost: slots(['PENDING']) }), false);
});

test('沒有快照／沒有這個崗位 → 按後備條件；沒有寫後備＝NEVER', function () {
  assert.strictEqual(evalCond('IF_DUTY:COMMUNION|WEEK_IN:1', { weekOfMonth: 1, slotsByPost: null }), true);
  assert.strictEqual(evalCond('IF_DUTY:COMMUNION|ALWAYS', { weekOfMonth: 4, slotsByPost: { PREACHER: [] } }), true);
  assert.strictEqual(evalCond('IF_DUTY:COMMUNION', { weekOfMonth: 1, slotsByPost: null }), false);
  assert.strictEqual(evalCond('IF_DUTY:COMMUNION', { slotsByPost: slots(['ASSIGNED']) }), true);
});

test('寫錯：PostID 空白、後備又是 IF_DUTY:、後備語法錯 → 拋錯並講明是哪一行', function () {
  assert.throws(function () { evalCond('IF_DUTY:|WEEK_IN:1'); }, /PostID/);
  assert.throws(function () { evalCond('IF_DUTY:COMMUNION|IF_DUTY:PREACHER'); }, /不可以再是 IF_DUTY/);
  assert.throws(function () { evalCond('IF_DUTY:COMMUNION|WEEKLY', { slotsByPost: slots(['PENDING']) }); }, /無法辨識/);
});

test('seed：四個範本的「聖餐」都跟職事表（平常、堂慶、合堂後備第一個主日；浸禮合堂後備 ALWAYS）', function () {
  const rows = Array.from(sb.seedProgramTemplatesRows_()).filter(function (r) { return r.ITEM_NAME === '聖餐'; });
  const byTpl = {};
  rows.forEach(function (r) { byTpl[r.TEMPLATE_ID] = r.CONDITION; });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(byTpl)), {
    TPL_NORMAL: 'IF_DUTY:COMMUNION|WEEK_IN:1',
    TPL_COMBINED_BAPTISM: 'IF_DUTY:COMMUNION|ALWAYS',
    TPL_ANNIVERSARY: 'IF_DUTY:COMMUNION|WEEK_IN:1',
    TPL_COMBINED: 'IF_DUTY:COMMUNION|WEEK_IN:1'
  });
});

// =====================================================================
console.log('\n真正入口：buildBulletinModel_()（假職事表）');
// =====================================================================

test('09-27 的情況：第四個主日，職事表聖餐襄禮「不設」→ 程序沒有聖餐', function () {
  const names = programNames([
    assignment(WEEK4, 'COMMUNION', 1, '', 'HARD_COMMUNION_FIRST_SUNDAY'),
    assignment(WEEK4, 'COMMUNION', 2, '', 'HARD_COMMUNION_FIRST_SUNDAY')
  ], WEEK4);
  assert.strictEqual(names.indexOf('聖餐'), -1, names.join('、'));
});

test('第四個主日職事表另外排了聖餐襄禮 → 程序有聖餐', function () {
  const names = programNames([assignment(WEEK4, 'COMMUNION', 1, '陳甲'), assignment(WEEK4, 'COMMUNION', 2, '李乙')], WEEK4);
  assert.ok(names.indexOf('聖餐') !== -1, names.join('、'));
});

test('第一個主日職事表講明「不設」→ 程序沒有聖餐', function () {
  const names = programNames([assignment(WEEK1, 'COMMUNION', 1, '', 'HARD_SPECIAL_SUNDAY_SKIP')], WEEK1);
  assert.strictEqual(names.indexOf('聖餐'), -1, names.join('、'));
});

test('第一個主日聖餐襄禮未排定 → 按後備（第一個主日）照樣有聖餐', function () {
  const names = programNames([], WEEK1);
  assert.ok(names.indexOf('聖餐') !== -1, names.join('、'));
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
