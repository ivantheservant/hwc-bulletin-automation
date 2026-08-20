#!/usr/bin/env node
/**
 * tests/programtable.test.js
 *
 * src/ProgramTable.gs 的回歸測試：範本推斷、CONDITION 求值、CONTENT_SOURCE
 * 求值、誦讀月份分組、宣召合成。全部走純函式層，不需要 SpreadsheetApp。
 *
 * 執行方式：node tests/programtable.test.js
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
  buildProgramTableRows_, resolveProgramTemplateId_, parseRecitationMonthGroups_,
  formatCallToWorship_, evaluateProgramCondition_, evaluateProgramContent_
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

/** 直接用 Bootstrap.gs seed 的 45 行程序範本，確保測試跟真實資料一致。 */
function seededTemplateRows() {
  return sandbox.seedProgramTemplatesRows_();
}

const DEFAULT_RECITATION_GROUPS_RAW =
  '1-4:RECITATION_JAN_APR,5-8:RECITATION_MAY_AUG,9-12:RECITATION_SEP_DEC';

const DEFAULT_RECITATION_VALUES = {
  RECITATION_JAN_APR: '使徒信經',
  RECITATION_MAY_AUG: '十誡',
  RECITATION_SEP_DEC: '主禱文'
};

const DEFAULT_TEMPLATE_CONFIG = {
  baptismKeywords: ['浸禮'],
  anniversaryKeywords: ['堂慶', '週年'],
  templateDefault: 'TPL_NORMAL'
};

function build(overrides) {
  var o = overrides || {};
  return buildProgramTableRows_({
    week: o.week || {},
    snapshot: o.snapshot || { isoDate: '2027-10-03', weekOfMonth: 1, special: null },
    templateRows: o.templateRows || seededTemplateRows(),
    templateId: o.templateId || 'TPL_NORMAL',
    recitationGroups: o.recitationGroups || parseRecitationMonthGroups_(DEFAULT_RECITATION_GROUPS_RAW),
    recitationValues: o.recitationValues || DEFAULT_RECITATION_VALUES,
    callFormat: o.callFormat || '{{text}}（{{ref}}）'
  });
}

function itemNames(rows) {
  return rows.map(function (r) { return r.itemName; });
}

function rowFor(rows, itemName) {
  return rows.filter(function (r) { return r.itemName === itemName; })[0] || null;
}

function templateRow(overrides) {
  return Object.assign({
    TEMPLATE_ID: 'TPL_TEST', SEQ_NO: 10, ITEM_NAME: '測試項目',
    CONTENT_SOURCE: 'BLANK', CONTENT_VALUE: '', POSTURE: '', FULL_WIDTH: false,
    CONDITION: 'ALWAYS', ACTIVE: true, NOTES: ''
  }, overrides || {});
}

// =====================================================================
// WEEK_IN
// =====================================================================

[1, 2, 3, 4, 5].forEach(function (weekOfMonth) {
  var shouldAppear = weekOfMonth === 2 || weekOfMonth === 4;
  test('WEEK_IN:2,4：weekOfMonth=' + weekOfMonth + ' → 祈禱會' + (shouldAppear ? '出現' : '不出現'), function () {
    var rows = build({ snapshot: { isoDate: '2027-10-03', weekOfMonth: weekOfMonth, special: null } });
    assert.strictEqual(rowFor(rows, '祈禱會') !== null, shouldAppear);
  });
});

[1, 2, 3, 4, 5].forEach(function (weekOfMonth) {
  var shouldAppear = weekOfMonth === 1;
  test('WEEK_IN:1：weekOfMonth=' + weekOfMonth + ' → 聖餐' + (shouldAppear ? '出現' : '不出現'), function () {
    var rows = build({ snapshot: { isoDate: '2027-10-03', weekOfMonth: weekOfMonth, special: null } });
    assert.strictEqual(rowFor(rows, '聖餐') !== null, shouldAppear);
  });
});

// =====================================================================
// IF_FIELD
// =====================================================================

test('IF_FIELD:CHOIR_TITLE 有值 → 詩班頌唱出現，內容就是該欄的值', function () {
  var rows = build({ week: { CHOIR_TITLE: '主是我萬有' } });
  var row = rowFor(rows, '詩班頌唱');
  assert.ok(row, '有詩班曲名時應該出現');
  assert.strictEqual(row.content, '主是我萬有');
});

test('IF_FIELD:CHOIR_TITLE 空白 → 詩班頌唱不出現', function () {
  assert.strictEqual(rowFor(build({ week: { CHOIR_TITLE: '' } }), '詩班頌唱'), null);
  assert.strictEqual(rowFor(build({ week: {} }), '詩班頌唱'), null);
});

test('IF_FIELD:CHOIR_TITLE 只有空白字元 → 視為空白，不出現', function () {
  assert.strictEqual(rowFor(build({ week: { CHOIR_TITLE: '   ' } }), '詩班頌唱'), null);
});

// =====================================================================
// AUTO:RECITATION
// =====================================================================

const RECITATION_CASES = [
  ['2027-01-03', '使徒信經'], ['2027-04-04', '使徒信經'],
  ['2027-05-02', '十誡'], ['2027-08-01', '十誡'],
  ['2027-09-05', '主禱文'], ['2027-12-05', '主禱文']
];

RECITATION_CASES.forEach(function (c) {
  test('AUTO:RECITATION：' + c[0] + ' → ' + c[1], function () {
    var rows = build({ snapshot: { isoDate: c[0], weekOfMonth: 1, special: null } });
    assert.strictEqual(rowFor(rows, '誦讀').content, c[1]);
  });
});

test('AUTO:RECITATION：RECITATION_OVERRIDE 有值 → 覆寫月份分組的結果', function () {
  var rows = build({
    week: { RECITATION_OVERRIDE: '尼西亞信經' },
    snapshot: { isoDate: '2027-01-03', weekOfMonth: 1, special: null }
  });
  assert.strictEqual(rowFor(rows, '誦讀').content, '尼西亞信經');
});

test('RECITATION_MONTH_GROUPS 改成別的分組 → 結果跟着變（證明分組沒有寫死）', function () {
  // 改成上半年／下半年兩組，1 月應該由「使徒信經」變成「主禱文」。
  var groups = parseRecitationMonthGroups_('1-6:RECITATION_SEP_DEC,7-12:RECITATION_JAN_APR');
  var rows = build({
    snapshot: { isoDate: '2027-01-03', weekOfMonth: 1, special: null },
    recitationGroups: groups
  });
  assert.strictEqual(rowFor(rows, '誦讀').content, '主禱文');

  var rows2 = build({
    snapshot: { isoDate: '2027-08-01', weekOfMonth: 1, special: null },
    recitationGroups: groups
  });
  assert.strictEqual(rowFor(rows2, '誦讀').content, '使徒信經');
});

test('RECITATION_MONTH_GROUPS 沒有涵蓋到的月份 → 內容留空，不拋錯', function () {
  var groups = parseRecitationMonthGroups_('1-4:RECITATION_JAN_APR');
  var rows = build({
    snapshot: { isoDate: '2027-09-05', weekOfMonth: 1, special: null },
    recitationGroups: groups
  });
  assert.strictEqual(rowFor(rows, '誦讀').content, '');
});

test('parseRecitationMonthGroups_：正常解析', function () {
  var groups = parseRecitationMonthGroups_(DEFAULT_RECITATION_GROUPS_RAW);
  assert.strictEqual(groups.length, 3);
  assert.strictEqual(groups[0].from, 1);
  assert.strictEqual(groups[0].to, 4);
  assert.strictEqual(groups[0].configKey, 'RECITATION_JAN_APR');
});

test('parseRecitationMonthGroups_：格式不對／月份不合理 → 拋錯', function () {
  assert.throws(function () { parseRecitationMonthGroups_('1-4'); }, /無法解析/);
  assert.throws(function () { parseRecitationMonthGroups_('RECITATION_JAN_APR'); }, /無法解析/);
  assert.throws(function () { parseRecitationMonthGroups_('0-4:X'); }, /月份範圍不合理/);
  assert.throws(function () { parseRecitationMonthGroups_('1-13:X'); }, /月份範圍不合理/);
  assert.throws(function () { parseRecitationMonthGroups_('8-5:X'); }, /月份範圍不合理/);
});

test('parseRecitationMonthGroups_：空字串回空陣列', function () {
  assert.strictEqual(parseRecitationMonthGroups_('').length, 0);
});

// =====================================================================
// 宣召
// =====================================================================

test('宣召：經文與出處兩者皆有 → 依格式合成', function () {
  var rows = build({ week: { CALL_TEXT: '你們要稱謝耶和華', CALL_REF: '詩篇 100:4' } });
  assert.strictEqual(rowFor(rows, '宣召').content, '你們要稱謝耶和華（詩篇 100:4）');
});

test('宣召：只有出處（2026-04-05 浸禮合堂的情況）→ 只顯示「（出處）」', function () {
  var rows = build({ week: { CALL_TEXT: '', CALL_REF: '詩篇 100:4' } });
  assert.strictEqual(rowFor(rows, '宣召').content, '（詩篇 100:4）');
});

test('宣召：只有經文 → 只顯示經文，不留一對空括號', function () {
  var rows = build({ week: { CALL_TEXT: '你們要稱謝耶和華', CALL_REF: '' } });
  assert.strictEqual(rowFor(rows, '宣召').content, '你們要稱謝耶和華');
});

test('宣召：兩者皆空 → 內容留空', function () {
  var rows = build({ week: { CALL_TEXT: '', CALL_REF: '' } });
  assert.strictEqual(rowFor(rows, '宣召').content, '');
});

test('CALL_TO_WORSHIP_FORMAT 換成別的格式 → 結果跟着變（證明格式沒有寫死）', function () {
  var rows = build({
    week: { CALL_TEXT: '你們要稱謝耶和華', CALL_REF: '詩篇 100:4' },
    callFormat: '{{ref}}：{{text}}'
  });
  assert.strictEqual(rowFor(rows, '宣召').content, '詩篇 100:4：你們要稱謝耶和華');
});

test('formatCallToWorship_：直接測四種組合', function () {
  var f = '{{text}}（{{ref}}）';
  assert.strictEqual(formatCallToWorship_('甲', '乙', f), '甲（乙）');
  assert.strictEqual(formatCallToWorship_('', '乙', f), '（乙）');
  assert.strictEqual(formatCallToWorship_('甲', '', f), '甲');
  assert.strictEqual(formatCallToWorship_('', '', f), '');
  assert.strictEqual(formatCallToWorship_(null, undefined, f), '');
});

// =====================================================================
// 拋錯：認不出的 CONDITION、不存在的 FIELD
// =====================================================================

test('無法辨識的 CONDITION → 拋錯，訊息含範本 ID 與行號', function () {
  var rows = [templateRow({ TEMPLATE_ID: 'TPL_TEST', SEQ_NO: 20, ITEM_NAME: '奇怪項目', CONDITION: 'SOMETIMES' })];
  assert.throws(
    function () { build({ templateRows: rows, templateId: 'TPL_TEST' }); },
    function (err) {
      return err.message.indexOf('TPL_TEST') !== -1
        && err.message.indexOf('20') !== -1
        && err.message.indexOf('SOMETIMES') !== -1;
    }
  );
});

test('FIELD: 指向不存在的欄位 → 拋錯，訊息列出可用欄名', function () {
  var rows = [templateRow({ TEMPLATE_ID: 'TPL_TEST', CONTENT_SOURCE: 'FIELD:NOT_A_REAL_COLUMN' })];
  assert.throws(
    function () { build({ templateRows: rows, templateId: 'TPL_TEST' }); },
    function (err) {
      return err.message.indexOf('NOT_A_REAL_COLUMN') !== -1
        && err.message.indexOf('SERMON_TITLE') !== -1;
    }
  );
});

test('IF_FIELD: 指向不存在的欄位 → 同樣拋錯（我們自己的工作表要嚴格）', function () {
  var rows = [templateRow({ TEMPLATE_ID: 'TPL_TEST', CONDITION: 'IF_FIELD:NOT_A_REAL_COLUMN' })];
  assert.throws(
    function () { build({ templateRows: rows, templateId: 'TPL_TEST' }); },
    /NOT_A_REAL_COLUMN/
  );
});

test('無法辨識的 CONTENT_SOURCE → 拋錯', function () {
  var rows = [templateRow({ TEMPLATE_ID: 'TPL_TEST', CONTENT_SOURCE: 'MAGIC' })];
  assert.throws(function () { build({ templateRows: rows, templateId: 'TPL_TEST' }); }, /MAGIC/);
});

test('CONDITION 為 NEVER → 該行不出現', function () {
  var rows = build({ templateRows: [templateRow({ CONDITION: 'NEVER' })], templateId: 'TPL_TEST' });
  assert.strictEqual(rows.length, 0);
});

test('CONTENT_SOURCE 為 STATIC → 用 CONTENT_VALUE 原文', function () {
  var rows = build({
    templateRows: [templateRow({ CONTENT_SOURCE: 'STATIC', CONTENT_VALUE: '固定內容' })],
    templateId: 'TPL_TEST'
  });
  assert.strictEqual(rows[0].content, '固定內容');
});

// =====================================================================
// 範本推斷
// =====================================================================

test('範本推斷：special.title 含「浸禮」→ TPL_COMBINED_BAPTISM', function () {
  var snapshot = { special: { title: '十月主日（浸禮）', type: 'BAPTISM' } };
  var r = resolveProgramTemplateId_({}, snapshot, DEFAULT_TEMPLATE_CONFIG);
  assert.strictEqual(r.templateId, 'TPL_COMBINED_BAPTISM');
  assert.strictEqual(r.inferred, true);
});

test('範本推斷：special.title 含「堂慶」→ TPL_ANNIVERSARY', function () {
  var snapshot = { special: { title: '三十週年堂慶感恩崇拜', type: '' } };
  assert.strictEqual(resolveProgramTemplateId_({}, snapshot, DEFAULT_TEMPLATE_CONFIG).templateId, 'TPL_ANNIVERSARY');
});

test('範本推斷：special.type 也會被檢查，不只 title', function () {
  var snapshot = { special: { title: '', type: '浸禮聯合崇拜' } };
  assert.strictEqual(resolveProgramTemplateId_({}, snapshot, DEFAULT_TEMPLATE_CONFIG).templateId, 'TPL_COMBINED_BAPTISM');
});

test('範本推斷：沒有特別主日 → TEMPLATE_DEFAULT', function () {
  var r = resolveProgramTemplateId_({}, { special: null }, DEFAULT_TEMPLATE_CONFIG);
  assert.strictEqual(r.templateId, 'TPL_NORMAL');
  assert.strictEqual(r.inferred, true);
});

test('範本推斷：有特別主日但不含任何關鍵詞 → TEMPLATE_DEFAULT', function () {
  var snapshot = { special: { title: '差傳年會主日', type: 'MISSION' } };
  assert.strictEqual(resolveProgramTemplateId_({}, snapshot, DEFAULT_TEMPLATE_CONFIG).templateId, 'TPL_NORMAL');
});

test('範本推斷：BulletinWeeks 已指定 PROGRAM_TEMPLATE_ID → 直接用它，inferred=false', function () {
  var snapshot = { special: { title: '十月主日（浸禮）', type: 'BAPTISM' } };
  var r = resolveProgramTemplateId_({ PROGRAM_TEMPLATE_ID: 'TPL_NORMAL' }, snapshot, DEFAULT_TEMPLATE_CONFIG);
  assert.strictEqual(r.templateId, 'TPL_NORMAL', '人手指定優先於推斷');
  assert.strictEqual(r.inferred, false);
});

test('範本推斷：關鍵詞換掉之後結果跟着變（證明關鍵詞沒有寫死）', function () {
  var snapshot = { special: { title: '洗禮主日', type: '' } };
  assert.strictEqual(
    resolveProgramTemplateId_({}, snapshot, DEFAULT_TEMPLATE_CONFIG).templateId, 'TPL_NORMAL',
    '預設關鍵詞是「浸禮」，「洗禮」不應該中'
  );
  assert.strictEqual(
    resolveProgramTemplateId_({}, snapshot, {
      baptismKeywords: ['洗禮'], anniversaryKeywords: [], templateDefault: 'TPL_NORMAL'
    }).templateId, 'TPL_COMBINED_BAPTISM'
  );
});

test('範本推斷：TEMPLATE_DEFAULT 換掉之後結果跟着變', function () {
  var r = resolveProgramTemplateId_({}, { special: null }, {
    baptismKeywords: ['浸禮'], anniversaryKeywords: ['堂慶'], templateDefault: 'TPL_SOMETHING_ELSE'
  });
  assert.strictEqual(r.templateId, 'TPL_SOMETHING_ELSE');
});

// =====================================================================
// 整體輸出
// =====================================================================

test('TPL_NORMAL 首主日：有聖餐、無祈禱會，且次序依 SEQ_NO', function () {
  var rows = build({ snapshot: { isoDate: '2027-11-07', weekOfMonth: 1, special: null } });
  var names = itemNames(rows);
  assert.ok(names.indexOf('聖餐') !== -1, '首主日要有聖餐');
  assert.strictEqual(names.indexOf('祈禱會'), -1, '首主日沒有祈禱會');
  var seqNos = rows.map(function (r) { return r.seqNo; });
  var sorted = seqNos.slice().sort(function (a, b) { return a - b; });
  assert.strictEqual(JSON.stringify(seqNos), JSON.stringify(sorted), '應該依 SEQ_NO 排序');
});

test('TPL_NORMAL 第 2 個主日：無聖餐、有祈禱會', function () {
  var names = itemNames(build({ snapshot: { isoDate: '2027-10-10', weekOfMonth: 2, special: null } }));
  assert.strictEqual(names.indexOf('聖餐'), -1);
  assert.ok(names.indexOf('祈禱會') !== -1);
});

test('fullWidth=true 的行，posture 一律清空（樣本內祈禱會／拍照都沒有立坐標記）', function () {
  var rows = build({ snapshot: { isoDate: '2027-10-10', weekOfMonth: 2, special: null } });
  var prayerMeeting = rowFor(rows, '祈禱會');
  assert.ok(prayerMeeting);
  assert.strictEqual(prayerMeeting.fullWidth, true);
  assert.strictEqual(prayerMeeting.posture, '');
});

test('fullWidth=false 的行保留 posture', function () {
  var rows = build({ snapshot: { isoDate: '2027-11-07', weekOfMonth: 1, special: null } });
  assert.strictEqual(rowFor(rows, '序樂').posture, '眾 立');
  assert.strictEqual(rowFor(rows, '讀經').posture, '眾 坐');
});

test('ACTIVE=FALSE 的範本行不會出現', function () {
  var rows = build({
    templateRows: [
      templateRow({ SEQ_NO: 10, ITEM_NAME: '啟用項目', ACTIVE: true }),
      templateRow({ SEQ_NO: 20, ITEM_NAME: '停用項目', ACTIVE: false })
    ],
    templateId: 'TPL_TEST'
  });
  assert.strictEqual(JSON.stringify(itemNames(rows)), JSON.stringify(['啟用項目']));
});

test('只取指定 TEMPLATE_ID 的行，其他範本的行不會混進來', function () {
  var rows = build({ templateId: 'TPL_ANNIVERSARY', snapshot: { isoDate: '2027-11-07', weekOfMonth: 1, special: null } });
  var names = itemNames(rows);
  assert.strictEqual(names.indexOf('誦讀'), -1, 'TPL_ANNIVERSARY 刻意刪去了誦讀');
  assert.strictEqual(names.indexOf('祈禱會'), -1, 'TPL_ANNIVERSARY 刻意刪去了祈禱會');
  assert.ok(names.indexOf('三一頌') !== -1);
});

test('TPL_ANNIVERSARY 的詩班頌唱條件是 ALWAYS：CHOIR_TITLE 空白也照樣出現', function () {
  var rows = build({
    templateId: 'TPL_ANNIVERSARY',
    week: {},
    snapshot: { isoDate: '2027-11-07', weekOfMonth: 1, special: null }
  });
  assert.ok(rowFor(rows, '詩班頌唱'), 'TPL_ANNIVERSARY 的詩班頌唱不受 CHOIR_TITLE 影響');
});

test('TPL_COMBINED_BAPTISM 的孩童奉獻禮條件是 NEVER → 不出現', function () {
  var rows = build({
    templateId: 'TPL_COMBINED_BAPTISM',
    snapshot: { isoDate: '2027-10-03', weekOfMonth: 1, special: null }
  });
  assert.strictEqual(rowFor(rows, '孩童奉獻禮'), null);
  assert.ok(rowFor(rows, '浸禮'), '浸禮那一行應該在');
});

test('evaluateProgramCondition_／evaluateProgramContent_ 可以單獨呼叫（供其他模組重用）', function () {
  var row = templateRow({ CONDITION: 'WEEK_IN:2,4' });
  assert.strictEqual(evaluateProgramCondition_('WEEK_IN:2,4', { week: {}, weekOfMonth: 2, row: row }), true);
  assert.strictEqual(evaluateProgramCondition_('WEEK_IN:2,4', { week: {}, weekOfMonth: 3, row: row }), false);
  assert.strictEqual(
    evaluateProgramContent_('FIELD:SERMON_TITLE', { week: { SERMON_TITLE: '講題' }, row: row }),
    '講題'
  );
});

// =====================================================================

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
