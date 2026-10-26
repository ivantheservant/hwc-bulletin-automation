#!/usr/bin/env node
/**
 * tests/v3features.test.js
 *
 * v3（2026-10-26 Ivan 測試結果 A）新功能的回歸測試：
 *   - 第 11 項：每一週的程序增刪（PROGRAM_EDITS）——純函式、經真正入口儲存之後資料模型與預覽頁、填寫介面那一段；
 *   - 第 13 項：丁戊己清單的次序與拿走（LIST_ARRANGEMENT）——同上；
 *   - 第 8 項：三堂聯合崇拜範本 TPL_COMBINED（推斷、範本列、Word 範本借用）；
 *   - 第 16 項：下載 Word「包括未儲存修改的版本（草稿）」——只下載、一格都不寫；
 *   - 第 14 項：版本預覽（?snapshot=）、還原之後另存 AFTER_RESTORE 版本；
 *   - 第 1 項：職事表有新季度時自動建立週報（每日／開啟填寫介面）；
 *   - 第 6、7 項：你填的名字與職事表不同的崗位、「查看／修改職事表」網址；
 *   - 第 2 項：發佈時窗（只限該週）在填寫介面那一段；
 *   - 第 9 項：季末最後一個主日的「下週事奉」讀得到下一季的職事表。
 *
 * 後端一律經真正入口（saveWeekFromWebApp_、loadWeekForWebApp_、apiDownloadBulletinDocx、renderPreviewResponse_、
 * restoreWeekSnapshotFromWebApp_、runAutoCreateQuarters_、apiListWeeks）；前端用 BEGIN／END 標記把 Script.html
 * 的真正程式碼抽出來，在假 DOM 上執行。
 *
 * 執行方式：node tests/v3features.test.js
 * 離開碼：0＝全部通過　1＝有測試失敗
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { makeFillEnv, QUARTER_ID } = require('./helpers/fillEnv');
const { makeWordEnv, TEMPLATE_ID, OUTPUT_FOLDER } = require('./helpers/wordEnv');
const { buildFakeDocx } = require('./helpers/fakeDrive');
const fx = require('./fixtures/docxXml');
const { assertWrittenChinese } = require('./helpers/writtenChinese');

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

function readSrc(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');
}

function plain(v) { return JSON.parse(JSON.stringify(v)); }

const D = '2027-11-07';
const D_NEXT = '2027-11-14';
const FAKE_ROSTER_ID = 'FAKE_ROSTER_ID_FOR_FILL_TESTS';

const PREVIEW_URL = 'https://script.google.com/macros/s/FAKE/exec';

/** 記下 HtmlService.createHtmlOutput() 的內容（預覽頁的真正入口 renderPreviewResponse_() 用它）。 */
const FAKE_HTML_SERVICE = {
  createHtmlOutput: function (html) {
    return { __html: html, setTitle: function () { return this; }, addMetaTag: function () { return this; } };
  },
  createTemplateFromFile: function () {
    return { evaluate: function () { return { setWidth: function () { return this; }, setHeight: function () { return this; } }; } };
  }
};

function weekRowInput(iso, extra) {
  return Object.assign({ SERVICE_DATE: iso, QUARTER_ID: QUARTER_ID, WEEK_OF_MONTH: 1, STATUS: 'DRAFT' }, extra || {});
}

function makeEnv(options) {
  const o = options || {};
  return makeFillEnv(Object.assign({
    withGrid: false,
    weekRows: o.weekRows || [weekRowInput(D, o.week), weekRowInput(D_NEXT, o.nextWeek)],
    config: Object.assign({ PREVIEW_WEBAPP_URL: PREVIEW_URL }, o.config || {}),
    announcements: o.announcements,
    specialSundays: o.specialSundays,
    extraStubs: Object.assign({ HtmlService: FAKE_HTML_SERVICE }, o.extraStubs || {})
  }, o.fill || {}));
}

function rowOf(env, iso) {
  return env.sandbox.readSheet('BulletinWeeks').filter(function (r) {
    return env.sandbox.formatIsoDate_(r.SERVICE_DATE) === iso;
  })[0];
}

/** 照新版前端那樣儲存：week 只放改了的欄位。 */
function save(env, iso, patch, extra) {
  const sb = env.sandbox;
  const loaded = sb.loadWeekForWebApp_(iso);
  return sb.saveWeekFromWebApp_(Object.assign({
    isoDate: iso, lastSavedAt: loaded.lastSavedAt, payloadVersion: 2, week: patch,
    baseWeek: sb.baseWeekFor_(loaded.week, patch)
  }, extra || {}));
}

function previewHtml(env, params) {
  return env.sandbox.renderPreviewResponse_({ parameter: params }).__html;
}

function auditCount(env) { return env.sandbox.readSheet('AuditLog').length; }

const THREE_ANNOUNCEMENTS = [
  { SERVICE_DATE: D, SEQ_NO: 1, TEXT: '甲', ACTIVE: true },
  { SERVICE_DATE: D, SEQ_NO: 2, TEXT: '乙', ACTIVE: true },
  { SERVICE_DATE: D, SEQ_NO: 3, TEXT: '丙', ACTIVE: true }
];

// =====================================================================
// 1. 程序增刪（純函式）
// =====================================================================

console.log('\n程序增刪：純函式');

function tplRows(names) {
  return names.map(function (n, i) { return { seqNo: i + 1, itemName: n, content: '', posture: '眾 坐', fullWidth: false, sourceRow: { ITEM_NAME: n } }; });
}

test('parseProgramEdits_：空白＝沒有增刪；格式不對標 invalid；項目名稱或 id 空白的「加一項」略過；立坐不在選項內改回「眾 坐」', function () {
  const sb = makeEnv().sandbox;
  assert.deepStrictEqual(plain(sb.parseProgramEdits_('')), { hidden: [], added: [], invalid: false });
  assert.strictEqual(sb.parseProgramEdits_('{壞').invalid, true);
  assert.strictEqual(sb.parseProgramEdits_('[1,2]').invalid, true);
  const parsed = plain(sb.parseProgramEdits_(JSON.stringify({
    v: 1, hidden: ['拍照#1', ''],
    added: [{ id: 'a1', after: '序樂#1', itemName: ' 特別分享 ', content: ' 王 ', posture: '亂寫' },
      { id: '', after: '序樂#1', itemName: '沒有 id' }, { id: 'a3', itemName: '  ' }]
  })));
  assert.deepStrictEqual(parsed.hidden, ['拍照#1']);
  assert.deepStrictEqual(parsed.added, [{ id: 'a1', after: '序樂#1', itemName: '特別分享', content: '王', posture: '眾 坐' }]);
});

test('applyProgramEdits_：拿走的不印、display 仍在（removed）；加的插在指定那一行之後；同一位置加兩項按加的次序；加在加的行之後亦排得對', function () {
  const sb = makeEnv().sandbox;
  const rows = tplRows(['序樂', '宣召', '拍照', '祝福']);
  const out = plain(sb.applyProgramEdits_(rows, JSON.stringify({
    v: 1, hidden: ['拍照#1'],
    added: [
      { id: 'a1', after: '宣召#1', itemName: '甲', posture: '眾 立' },
      { id: 'a2', after: '宣召#1', itemName: '乙' },
      { id: 'a3', after: 'add:a1', itemName: '甲之後' },
      { id: 'a4', after: '__END__', itemName: '最後' }
    ]
  })));
  assert.deepStrictEqual(out.rows.map(function (r) { return r.itemName; }), ['序樂', '宣召', '甲', '甲之後', '乙', '祝福', '最後']);
  assert.deepStrictEqual(out.display.map(function (r) { return r.itemName + (r.removed ? '（拿走）' : ''); }),
    ['序樂', '宣召', '甲', '甲之後', '乙', '拍照（拿走）', '祝福', '最後']);
  assert.strictEqual(out.rows[2].posture, '眾 立');
  assert.strictEqual(out.rows[2].added, true);
  assert.deepStrictEqual(out.warnings, []);
  assert.strictEqual(out.display[0].key, '序樂#1');
  assert.strictEqual(out.display[2].addedId, 'a1');
});

test('applyProgramEdits_：同名兩行分得開（#1、#2）；錨點已經不在範本 → 放最後並出警告；格式不對 → 照範本印並出警告', function () {
  const sb = makeEnv().sandbox;
  const rows = tplRows(['詩歌', '讀經', '詩歌']);
  assert.deepStrictEqual(plain(sb.programRowKeys_(rows)), ['詩歌#1', '讀經#1', '詩歌#2']);
  const out = plain(sb.applyProgramEdits_(rows, JSON.stringify({ hidden: ['詩歌#2'], added: [{ id: 'x', after: '拍照#1', itemName: '分享' }] })));
  assert.deepStrictEqual(out.rows.map(function (r) { return r.itemName; }), ['詩歌', '讀經', '分享']);
  assert.deepStrictEqual(out.warnings.map(function (w) { return w.code; }), ['PROGRAM_ADD_ANCHOR_MISSING']);
  const bad = plain(sb.applyProgramEdits_(rows, '{壞'));
  assert.deepStrictEqual(bad.rows.map(function (r) { return r.itemName; }), ['詩歌', '讀經', '詩歌']);
  assert.deepStrictEqual(bad.warnings.map(function (w) { return w.code; }), ['PROGRAM_EDITS_INVALID']);
  assertWrittenChinese(assert, '程序增刪警告', out.warnings.concat(bad.warnings).map(function (w) { return w.message; }));
});

test('applyProgramEdits_（獨立審查）：「加在最後」的一項之後再「加在它之後」→ 排在它之後，不會出「找不到位置」', function () {
  const sb = makeEnv().sandbox;
  const out = plain(sb.applyProgramEdits_(tplRows(['序樂', '家事報告']), JSON.stringify({ hidden: [], added: [
    { id: 'a1', after: '__END__', itemName: '特別分享' },
    { id: 'a2', after: '__END__', itemName: '拍照' },
    { id: 'a3', after: 'add:a1', itemName: '回應' }
  ] })));
  assert.deepStrictEqual(out.rows.map(function (r) { return r.itemName; }), ['序樂', '家事報告', '特別分享', '回應', '拍照']);
  assert.deepStrictEqual(out.warnings, []);
});

test('describeProgramEdits_／describeListArrangement_：版本記錄看差異用的一句', function () {
  const sb = makeEnv().sandbox;
  assert.strictEqual(sb.describeProgramEdits_(''), '');
  assert.strictEqual(sb.describeProgramEdits_(JSON.stringify({ hidden: ['拍照#1'], added: [{ id: 'a', after: '__END__', itemName: '分享', content: '王' }] })),
    '拿走：拍照；加入：分享（王）');
  assert.strictEqual(sb.describeProgramEdits_('{壞'), '（格式不對）');
  assert.strictEqual(sb.describeListArrangement_(JSON.stringify({ announcements: [{ k: 'k1', h: true }, { k: 'k2', h: false }] })),
    '家事報告：自訂次序，拿走 1 則');
});

// =====================================================================
// 2. 清單次序與拿走（純函式）
// =====================================================================

console.log('\n清單次序與拿走：純函式');

test('arrangeListItems_：按安排排；同內容兩則鍵分開（#2）；安排內沒有的（新加或內容改過）排最後而且不拿走', function () {
  const sb = makeEnv().sandbox;
  const items = [{ TEXT: '甲' }, { TEXT: '乙' }, { TEXT: '甲' }, { TEXT: '新' }];
  const kA = sb.listItemContentKey_('announcements', { TEXT: '甲' });
  const kB = sb.listItemContentKey_('announcements', { TEXT: '乙' });
  assert.ok(/^k[0-9a-f]{8}$/.test(kA), kA);
  assert.notStrictEqual(kA, kB);
  const out = plain(sb.arrangeListItems_('announcements', items, [
    { k: kB, h: false }, { k: kA + '#2', h: true }, { k: kA, h: false }, { k: 'k00000000', h: true }
  ]));
  assert.deepStrictEqual(out.map(function (o) { return o.item.TEXT + (o.hidden ? '×' : '') + '@' + o.sourceIndex; }),
    ['乙@1', '甲×@2', '甲@0', '新@3']);
  // 團契用四欄做鍵，內容一改鍵就變。
  const f1 = sb.listItemContentKey_('fellowships', { FELLOWSHIP_NAME: '青年', MEETING_DATE: '11/8', MEETING_TIME: '7pm', CONTENT: '查經' });
  const f2 = sb.listItemContentKey_('fellowships', { FELLOWSHIP_NAME: '青年', MEETING_DATE: '11/8', MEETING_TIME: '7pm', CONTENT: '遊戲' });
  assert.notStrictEqual(f1, f2);
});

test('parseListArrangement_／findInvalidWeekArrangementFields_：只收三張清單；壞 JSON、陣列、太長一律當作不合格', function () {
  const sb = makeEnv().sandbox;
  const parsed = plain(sb.parseListArrangement_(JSON.stringify({ v: 1, announcements: [{ k: 'k1', h: 1 }, { k: '' }], finance: [{ k: 'x' }] })));
  assert.deepStrictEqual(parsed, { lists: { announcements: [{ k: 'k1', h: true }] }, invalid: false });
  assert.deepStrictEqual(plain(sb.findInvalidWeekArrangementFields_({ PROGRAM_EDITS: '', LIST_ARRANGEMENT: '{}' })), []);
  assert.deepStrictEqual(plain(sb.findInvalidWeekArrangementFields_({ PROGRAM_EDITS: '{壞', LIST_ARRANGEMENT: '[]' })), ['PROGRAM_EDITS', 'LIST_ARRANGEMENT']);
  const long = JSON.stringify({ hidden: ['x'.repeat(sb.WEEK_ARRANGEMENT_MAX_CHARS_)] });
  assert.deepStrictEqual(plain(sb.findInvalidWeekArrangementFields_({ PROGRAM_EDITS: long })), ['PROGRAM_EDITS']);
});

// =====================================================================
// 3. 經真正入口：儲存 → 載入、資料模型、預覽頁
// =====================================================================

console.log('\n經真正入口：程序增刪與清單安排');

test('程序增刪經「儲存」寫入：載入時程序表有拿走（removed）與加的行；資料模型與預覽頁只印要印的；AuditLog 有一筆', function () {
  const env = makeEnv();
  const edits = JSON.stringify({ v: 1, hidden: ['三一頌#1'], added: [{ id: 'a1', after: '宣召#1', itemName: '特別分享', content: '王弟兄', posture: '眾 坐' }] });
  const result = save(env, D, { PROGRAM_EDITS: edits });
  assert.strictEqual(result.message.type, 'success', JSON.stringify(result.message));
  assert.strictEqual(rowOf(env, D).PROGRAM_EDITS, edits);

  const loaded = plain(env.sandbox.loadWeekForWebApp_(D));
  const display = loaded.readOnly.programDisplay;
  const names = display.map(function (r) { return r.itemName + (r.removed ? '（拿走）' : '') + (r.added ? '（加）' : ''); });
  assert.deepStrictEqual(names.slice(0, 3), ['序樂', '宣召', '特別分享（加）']);
  assert.ok(names.indexOf('三一頌（拿走）') !== -1, names.join('、'));
  assert.deepStrictEqual(loaded.readOnly.programPostureOptions, ['眾 坐', '眾 立', '']);

  const model = env.sandbox.buildBulletinModel_(D);
  const printed = model.program.map(function (r) { return r.itemName; });
  assert.strictEqual(printed[2], '特別分享');
  assert.strictEqual(printed.indexOf('三一頌'), -1, '拿走的不印');

  const html = previewHtml(env, { date: D });
  assert.ok(html.indexOf('特別分享') !== -1 && html.indexOf('王弟兄') !== -1);
  assert.strictEqual(html.indexOf('三一頌'), -1, '預覽頁與 Word 同一份資料模型');
  assert.ok(env.sandbox.readSheet('AuditLog').some(function (r) { return r.FIELD === 'PROGRAM_EDITS'; }));
});

test('程序增刪格式不對：儲存整次拒絕（INVALID_ARRANGEMENT），一格都沒有寫；工作表那一格本身壞了 → 照範本印並出警告', function () {
  const env = makeEnv();
  env.sandbox.loadWeekForWebApp_(D); // 第一次載入會寫回推斷的程序範本（與這裏無關），先做
  const before = auditCount(env);
  let err = null;
  try { save(env, D, { PROGRAM_EDITS: '{壞', PAGE_TITLE: '不應該寫入' }); } catch (e) { err = e; }
  assert.ok(err, '應該拒絕');
  assert.strictEqual(err.code, 'INVALID_ARRANGEMENT');
  assert.strictEqual(String(rowOf(env, D).PAGE_TITLE || ''), '');
  assert.strictEqual(auditCount(env), before);
  assertWrittenChinese(assert, '程序增刪拒絕', [err.message]);

  env.sandbox.writeBulletinWeekField_(D, 'PROGRAM_EDITS', '{壞');
  const model = env.sandbox.buildBulletinModel_(D);
  assert.ok(model.warnings.some(function (w) { return w.code === 'PROGRAM_EDITS_INVALID'; }));
  assert.ok(model.program.some(function (r) { return r.itemName === '三一頌'; }), '照範本印');
});

test('清單安排經「儲存」寫入：資料模型與預覽頁按新次序、拿走的不印；載入時拿走的仍然列出（hidden）；內容表改了內容 → 那一則回到最後而且照樣印', function () {
  const env = makeEnv({ announcements: THREE_ANNOUNCEMENTS.slice() });
  const lists = plain(env.sandbox.loadWeekForWebApp_(D)).lists.announcements;
  const keyOf = {};
  lists.forEach(function (it) { keyOf[it.TEXT] = it.arrangeKey; });
  const arrangement = JSON.stringify({ v: 1, announcements: [{ k: keyOf['丙'], h: false }, { k: keyOf['甲'], h: true }, { k: keyOf['乙'], h: false }] });
  save(env, D, { LIST_ARRANGEMENT: arrangement });

  const model = env.sandbox.buildBulletinModel_(D);
  assert.deepStrictEqual(plain(model.announcements.map(function (a) { return a.text; })), ['丙', '乙']);
  const html = previewHtml(env, { date: D });
  assert.ok(html.indexOf('丙') < html.indexOf('乙'));
  const ui = plain(env.sandbox.loadWeekForWebApp_(D)).lists.announcements;
  assert.deepStrictEqual(ui.map(function (it) { return it.TEXT + (it.hidden ? '×' : ''); }), ['丙', '甲×', '乙']);

  // 內容表把「甲」改成「甲（更正）」：鍵變了，拿走不再生效——寧可多印一則，不可以靜靜拿走改過的內容。
  const sheet = env.sheets.Announcements;
  const textCol = env.sandbox.COLUMNS.ANNOUNCEMENTS.keys.indexOf('TEXT') + 1;
  sheet.getRange(3, textCol).setValue('甲（更正）');
  const after = env.sandbox.buildBulletinModel_(D);
  assert.deepStrictEqual(plain(after.announcements.map(function (a) { return a.text; })), ['丙', '乙', '甲（更正）']);
});

test('清單安排格式不對（工作表那一格壞了）→ 照原本次序印並出警告', function () {
  const env = makeEnv({ announcements: THREE_ANNOUNCEMENTS.slice() });
  env.sandbox.writeBulletinWeekField_(D, 'LIST_ARRANGEMENT', '{壞');
  const model = env.sandbox.buildBulletinModel_(D);
  assert.deepStrictEqual(plain(model.announcements.map(function (a) { return a.text; })), ['甲', '乙', '丙']);
  assert.ok(model.warnings.some(function (w) { return w.code === 'LIST_ARRANGEMENT_INVALID'; }));
});

test('看差異（獨立審查）：版本裏沒有的欄（v3 之前存的版本沒有程序增刪）不列出——與還原一樣不會改它', function () {
  const sb = makeEnv().sandbox;
  const rows = plain(sb.diffWeekSnapshotState_({ week: { PAGE_TITLE: '舊' }, dutyOverrides: [], fieldOverrides: [] },
    { weekRow: { PAGE_TITLE: '新', PROGRAM_EDITS: JSON.stringify({ hidden: ['拍照#1'], added: [] }) }, dutyRows: [], fieldRows: [] }, []));
  assert.deepStrictEqual(rows.map(function (r) { return r.label; }), ['程序表大標題']);
  const plan = plain(sb.planWeekSnapshotRestore_({ week: { PAGE_TITLE: '舊' }, dutyOverrides: [], fieldOverrides: [] },
    { weekRow: { PAGE_TITLE: '新', PROGRAM_EDITS: '{"hidden":["拍照#1"]}' }, dutyRowsAll: [], fieldRowsAll: [] }));
  assert.deepStrictEqual(plan.fieldChanges.map(function (c) { return c.field; }), ['PAGE_TITLE'], '看差異列出的就是還原會改的');
});

test('版本記錄看差異：兩欄 JSON 顯示成一句人看得明的話，不是原始 JSON', function () {
  const env = makeEnv();
  save(env, D, { PROGRAM_EDITS: JSON.stringify({ v: 1, hidden: ['三一頌#1'], added: [] }) });
  const versions = env.sandbox.listWeekSnapshotsForWebApp_(D).versions;
  const diff = plain(env.sandbox.diffWeekSnapshotForWebApp_(D, versions[0].snapshotId));
  const row = diff.rows.filter(function (r) { return r.label === '程序增刪（這一週）'; })[0];
  assert.ok(row, JSON.stringify(diff.rows));
  assert.strictEqual(row.snapshotValue, '');
  assert.strictEqual(row.currentValue, '拿走：三一頌');
});

// =====================================================================
// 4. 三堂聯合崇拜 TPL_COMBINED
// =====================================================================

console.log('\n三堂聯合崇拜範本 TPL_COMBINED');

test('範本推斷：「合堂」「聯合」→ TPL_COMBINED；浸禮、堂慶仍然優先；Config 可以改關鍵詞', function () {
  const sb = makeEnv().sandbox;
  const cfg = plain(sb.readProgramTemplateConfig_());
  assert.deepStrictEqual(cfg.combinedKeywords, ['合堂', '聯合']);
  const pick = function (title) { return sb.resolveProgramTemplateId_({}, { special: { title: title, type: '' } }, cfg).templateId; };
  assert.strictEqual(pick('宣教月合堂'), 'TPL_COMBINED');
  assert.strictEqual(pick('三堂聯合崇拜'), 'TPL_COMBINED');
  assert.strictEqual(pick('浸禮合堂'), 'TPL_COMBINED_BAPTISM');
  assert.strictEqual(pick('32週年堂慶聯合崇拜'), 'TPL_ANNIVERSARY');
  assert.strictEqual(pick('母親節'), 'TPL_NORMAL');
  const custom = Object.assign({}, cfg, { combinedKeywords: ['宣教月'] });
  assert.strictEqual(sb.resolveProgramTemplateId_({}, { special: { title: '宣教月主日' } }, custom).templateId, 'TPL_COMBINED');
});

test('初始化工作表的範本列：TPL_COMBINED 13 行，家事報告在最後；真正入口：特別主日「宣教月合堂」→ 用 TPL_COMBINED 並寫回', function () {
  const env = makeEnv({
    specialSundays: [{
      SpecialID: 'SP9', QuarterID: QUARTER_ID, ServiceDate: D, Type: 'COMBINED', Title: '宣教月合堂',
      SkipPostIDs: '', LockPostIDs: '', ExternalOwner: '', CommunionOverride: '', TranslationRequired: false, Active: true
    }]
  });
  const seeds = env.sandbox.seedProgramTemplatesRows_().filter(function (r) { return r.TEMPLATE_ID === 'TPL_COMBINED'; });
  assert.strictEqual(seeds.length, 13);
  assert.strictEqual(seeds[seeds.length - 1].ITEM_NAME, '家事報告');
  const model = env.sandbox.buildBulletinModel_(D);
  assert.strictEqual(model.templateId, 'TPL_COMBINED');
  assert.strictEqual(rowOf(env, D).PROGRAM_TEMPLATE_ID, 'TPL_COMBINED', '推斷結果寫回（與浸禮、堂慶同一做法）');
  assert.ok(model.program.length > 0);
  assert.ok(env.sandbox.loadWeekForWebApp_(D).options.programTemplateIds.indexOf('TPL_COMBINED') !== -1, '下拉有這一個範本');
});

test('Word 範本：TPL_COMBINED 有自己的檔案就用自己的；未填就借用堂慶三堂聯合崇拜那一個，並講明', function () {
  const own = makeEnv({ config: { TEMPLATE_FILE_ID_COMBINED: 'OWN', TEMPLATE_FILE_ID_ANNIVERSARY: 'ANNIV' } }).sandbox.resolveWordTemplate_('TPL_COMBINED');
  assert.strictEqual(own.fileId, 'OWN');
  const borrowed = makeEnv({ config: { TEMPLATE_FILE_ID_ANNIVERSARY: 'ANNIV' } }).sandbox.resolveWordTemplate_('TPL_COMBINED');
  assert.strictEqual(borrowed.fileId, 'ANNIV');
  assert.ok(borrowed.label.indexOf('借用') !== -1, borrowed.label);
  assertWrittenChinese(assert, 'Word 範本名稱', [own.label, borrowed.label]);
});

// =====================================================================
// 5. 下載 Word 草稿（包括未儲存修改）
// =====================================================================

console.log('\n下載 Word：已儲存的版本與草稿');

function makeDraftWordEnv() {
  const env = makeWordEnv({
    driveOptions: {
      files: { [TEMPLATE_ID]: buildFakeDocx(fx.documentXml(fx.para(fx.run('{{PAGE_TITLE}}')))) },
      folders: { [OUTPUT_FOLDER]: {} }
    }
  });
  const captured = [];
  const original = env.sandbox.generateBulletinDocx_;
  env.sandbox.generateBulletinDocx_ = function () {
    const result = original.apply(this, arguments);
    captured.push(result);
    return result;
  };
  return { env: env, captured: captured };
}

function documentXmlOf(result) {
  const entry = result.blob.__entries.filter(function (b) { return b.getName() === 'word/document.xml'; })[0];
  return entry.getDataAsString();
}

test('草稿（真正入口 apiDownloadBulletinDocx）：Word 用畫面上未儲存的大標題；檔名加「（草稿）」；週報、雲端硬碟、版本記錄一格都不寫', function () {
  const t = makeDraftWordEnv();
  const sb = t.env.sandbox;
  const auditBefore = sb.readSheet('AuditLog').length;
  const resp = sb.apiDownloadBulletinDocx(D, { draft: { week: { PAGE_TITLE: '草稿大標題' }, dutyEdits: [], nextWeekDutyEdits: [] } });
  assert.strictEqual(resp.ok, true, JSON.stringify(resp.error));
  assert.strictEqual(resp.data.draft, true);
  assert.ok(/（草稿）\.docx$/.test(resp.data.fileName), resp.data.fileName);
  assert.strictEqual(resp.data.wordFile, null, '草稿不存雲端硬碟');
  assert.ok(documentXmlOf(t.captured[0]).indexOf('草稿大標題') !== -1, 'Word 內容用草稿');

  const row = sb.readSheet('BulletinWeeks')[0];
  assert.strictEqual(String(row.PAGE_TITLE || ''), '', '週報那一格沒有改');
  assert.strictEqual(String(row.DOC_ID || ''), '', '沒有記 Word 檔');
  assert.strictEqual(t.env.drive.listFolderFiles(OUTPUT_FOLDER).length, 0, '雲端硬碟沒有新檔案');
  assert.strictEqual(sb.listWeekSnapshotsForWebApp_(D).versions.length, 0, '沒有存版本');
  assert.strictEqual(sb.readSheet('AuditLog').length, auditBefore, '沒有 AuditLog');
});

test('草稿的事奉格：用未儲存的名字（與儲存同一份計畫），DutyOverride 一行都沒有寫', function () {
  const t = makeDraftWordEnv();
  const sb = t.env.sandbox;
  const models = [];
  const original = sb.buildBulletinModel_;
  sb.buildBulletinModel_ = function () { const m = original.apply(this, arguments); models.push(m); return m; };
  const resp = sb.apiDownloadBulletinDocx(D, { draft: { week: {}, dutyEdits: [{ postId: 'CHAIR', slotIndex: 1, name: '草稿主席', baseName: '陳大文' }] } });
  sb.buildBulletinModel_ = original;
  assert.strictEqual(resp.ok, true, JSON.stringify(resp.error));
  const chair = models[0].dutyBoxPage1.filter(function (r) { return r.postId === 'CHAIR' || r.label === '主席'; })[0];
  assert.ok(chair && String(chair.text).indexOf('草稿主席') !== -1, JSON.stringify(models[0].dutyBoxPage1));
  assert.strictEqual(sb.readSheet('DutyOverride').length, 0);
});

test('草稿帶了只在內容表輸入的欄位 → 與儲存同一道檢查，拒絕；之後照常下載已儲存的版本會存雲端硬碟並記 Word 檔', function () {
  const t = makeDraftWordEnv();
  const sb = t.env.sandbox;
  const refused = sb.apiDownloadBulletinDocx(D, { draft: { week: { SERMON_TITLE: '不可以' } } });
  assert.strictEqual(refused.ok, false);
  assert.strictEqual(refused.error.code, 'CONTENT_SHEET_READONLY');
  const saved = sb.apiDownloadBulletinDocx(D);
  assert.strictEqual(saved.ok, true, JSON.stringify(saved.error));
  assert.strictEqual(saved.data.draft, false);
  assert.ok(String(sb.readSheet('BulletinWeeks')[0].DOC_ID || '') !== '', '已儲存的版本照舊記 Word 檔');
});

// =====================================================================
// 6. 版本預覽與還原之後的版本
// =====================================================================

console.log('\n版本預覽（?snapshot=）與 AFTER_RESTORE');

test('版本預覽（真正入口 renderPreviewResponse_）：顯示那個版本的大標題與事奉框，頁頂講明是唯讀的還原預覽；現在的預覽照舊；一格都沒有寫', function () {
  const env = makeEnv();
  save(env, D, { PAGE_TITLE: '第一版標題' }, { dutyEdits: [{ postId: 'CHAIR', slotIndex: 1, name: '王某', baseName: '陳大文' }] });
  save(env, D, { PAGE_TITLE: '第二版標題' }, { dutyEdits: [{ postId: 'CHAIR', slotIndex: 1, name: '李某', baseName: '王某' }] });
  const versions = env.sandbox.listWeekSnapshotsForWebApp_(D).versions;
  const firstSaved = versions[0]; // 第二次儲存之前：第一版標題、王某
  const audit = auditCount(env);

  const html = previewHtml(env, { date: D, snapshot: firstSaved.snapshotId });
  assert.ok(html.indexOf('第一版標題') !== -1, '版本的大標題');
  assert.ok(html.indexOf('王某') !== -1, '版本的事奉框');
  assert.strictEqual(html.indexOf('第二版標題'), -1);
  assert.ok(html.indexOf('還原之後的樣子（唯讀）') !== -1);
  assert.strictEqual(auditCount(env), audit, '預覽不寫 AuditLog');
  assert.strictEqual(rowOf(env, D).PAGE_TITLE, '第二版標題');

  const now = previewHtml(env, { date: D });
  assert.ok(now.indexOf('第二版標題') !== -1 && now.indexOf('還原之後的樣子') === -1);

  const url = env.sandbox.buildPreviewUrl_(D, firstSaved.snapshotId);
  assert.ok(url.indexOf(PREVIEW_URL) === 0 && url.indexOf('&snapshot=' + encodeURIComponent(firstSaved.snapshotId)) !== -1, url);
});

test('版本預覽：版本編號不屬於這一個主日（或者不存在）→ 錯誤頁，不顯示別一週的資料', function () {
  const env = makeEnv();
  save(env, D_NEXT, { PAGE_TITLE: '下一週的標題' });
  save(env, D_NEXT, { PAGE_TITLE: '下一週第二版' });
  const other = env.sandbox.listWeekSnapshotsForWebApp_(D_NEXT).versions[0];
  const html = previewHtml(env, { date: D, snapshot: other.snapshotId });
  assert.ok(html.indexOf('組不出這一個主日的資料') !== -1, html.slice(0, 400));
  assert.strictEqual(html.indexOf('下一週的標題'), -1);
  assert.ok(previewHtml(env, { date: D, snapshot: '不存在' }).indexOf('組不出這一個主日的資料') !== -1);
});

test('還原（真正入口）：先存 BEFORE_RESTORE，還原之後另存 AFTER_RESTORE（內容是還原之後的樣子），原本那個版本不變', function () {
  const env = makeEnv();
  save(env, D, { PAGE_TITLE: 'A' });
  save(env, D, { PAGE_TITLE: 'B' });
  const sb = env.sandbox;
  const target = sb.listWeekSnapshotsForWebApp_(D).versions[0]; // 第二次儲存之前：A
  const targetPayloadBefore = JSON.stringify(sb.loadWeekSnapshot_(D, target.snapshotId).payload);
  const result = sb.restoreWeekSnapshotFromWebApp_({ isoDate: D, snapshotId: target.snapshotId });
  assert.strictEqual(result.message.type, 'success', JSON.stringify(result.message));
  assert.ok(result.message.text.indexOf('還原之後亦另存了一個版本，原本那個版本不變') !== -1, result.message.text);
  const versions = sb.listWeekSnapshotsForWebApp_(D).versions;
  assert.deepStrictEqual(plain(versions.slice(0, 2).map(function (v) { return v.reason; })), ['AFTER_RESTORE', 'BEFORE_RESTORE']);
  assert.strictEqual(versions[0].reasonLabel, '還原之後');
  assert.strictEqual(sb.loadWeekSnapshot_(D, versions[0].snapshotId).payload.week.PAGE_TITLE, 'A');
  assert.strictEqual(sb.loadWeekSnapshot_(D, versions[1].snapshotId).payload.week.PAGE_TITLE, 'B');
  assert.strictEqual(JSON.stringify(sb.loadWeekSnapshot_(D, target.snapshotId).payload), targetPayloadBefore, '原本那個版本不變');
});

// =====================================================================
// 7. 自動建立季度
// =====================================================================

console.log('\n職事表有新季度時自動建立');

test('planAutoCreateQuarters_（純函式）：未有版本、已完結、沙盒季度不建；只建缺少的；由早到遲', function () {
  const sb = makeEnv().sandbox;
  const plan = plain(sb.planAutoCreateQuarters_({
    rosterQuarters: [
      { quarterId: '2031T2', versionCount: 1, firstIso: '2031-04-06', lastIso: '2031-06-29' },
      { quarterId: '2031T1', versionCount: 2, firstIso: '2031-01-05', lastIso: '2031-03-30' },
      { quarterId: '2031T3', versionCount: 0, firstIso: '2031-07-06', lastIso: '2031-09-28' },
      { quarterId: '2026T1', versionCount: 3, firstIso: '2026-01-04', lastIso: '2026-03-29' },
      { quarterId: '2030T1', versionCount: 1, firstIso: '2030-01-06', lastIso: '2030-03-31' },
      { quarterId: '2031T4', versionCount: 1, firstIso: '2031-10-05', lastIso: '2031-12-28' }
    ],
    weekQuarterIds: { '2031T2': true, '2031T4': true },
    contentSheetQuarterIds: { '2031T4': true },
    todayIso: '2026-10-26',
    excludedQuarterIds: ['2030T1']
  }));
  assert.deepStrictEqual(plan.map(function (p) { return p.quarterId + ':' + p.createWeeks + '/' + p.createContentSheet; }),
    ['2031T1:true/true', '2031T2:false/true']);
});

function addRosterQuarter(env, quarterId, isoDates, versionNo) {
  const sb = env.sandbox;
  const roster = sb.SpreadsheetApp.openById(FAKE_ROSTER_ID);
  function append(sheetName, obj) {
    const sh = roster.getSheetByName(sheetName);
    const keys = sh.getRange(2, 1, 1, sh.getLastColumn()).getValues()[0];
    sh.getRange(sh.getLastRow() + 1, 1, 1, keys.length).setValues([keys.map(function (k) { return obj[k] === undefined ? '' : obj[k]; })]);
  }
  isoDates.forEach(function (iso, i) {
    append('ServiceDates', { ServiceDateID: quarterId + '-' + i, QuarterID: quarterId, ServiceDate: iso, WeekIndex: i + 1,
      IsFirstSundayOfMonth: i === 0, ServiceType: '主日崇拜', SpecialID: '' });
  });
  if (versionNo) append('RosterVersions', { QuarterID: quarterId, VersionNo: versionNo });
  sb.ROSTER_TABLES_CACHE_ = null;
}

test('runAutoCreateQuarters_（真正入口）：職事表多了一季（有版本）→ 自動建週報、記 AuditLog；內容表建不到就記 ErrorLog、其餘照做；再跑一次不重複建', function () {
  const env = makeEnv({ config: { SELFTEST_QUARTER_ID: '2030T1', AUTO_CREATE_QUARTERS_LEAD_DAYS: '0' } });
  addRosterQuarter(env, '2031T1', ['2031-01-05', '2031-01-12'], 1);
  addRosterQuarter(env, '2031T2', ['2031-04-06'], 0);         // 未有版本：不建
  addRosterQuarter(env, '2030T1', ['2030-01-06'], 1);         // 沙盒季度：不建
  const sb = env.sandbox;
  const result = plain(sb.runAutoCreateQuarters_({ source: 'TRIGGER' }));
  assert.strictEqual(result.enabled, true);
  const created = result.created.filter(function (c) { return c.quarterId === '2031T1'; })[0];
  assert.ok(created, JSON.stringify(result));
  assert.strictEqual(created.weeksAdded, 2);
  assert.strictEqual(result.created.filter(function (c) { return c.quarterId === '2031T2' || c.quarterId === '2030T1'; }).length, 0);
  const rows = sb.readSheet('BulletinWeeks').filter(function (r) { return r.QUARTER_ID === '2031T1'; });
  assert.strictEqual(rows.length, 2);
  assert.ok(sb.readSheet('AuditLog').some(function (r) { return r.ACTION === 'AUTO_CREATE_WEEKS' && r.ROW_KEY === '2031T1'; }));
  // 這個測試環境沒有內容表資料夾：內容表建不到 → 記入 skipped 與 ErrorLog，週報照建。
  assert.ok(result.skipped.some(function (s) { return s.quarterId === '2031T1'; }), JSON.stringify(result.skipped));
  assert.ok(sb.readSheet('ErrorLog').some(function (r) { return r.ERROR_CODE === 'AUTO_CREATE_CONTENT_SHEET_FAILED'; }));
  assert.ok(result.message.indexOf('2031T1 的週報（2 個主日）') !== -1, result.message);
  assertWrittenChinese(assert, '自動建立訊息', [result.message]);

  const again = plain(sb.runAutoCreateQuarters_({ source: 'TRIGGER' }));
  assert.strictEqual(again.created.filter(function (c) { return c.quarterId === '2031T1'; }).length, 0, '週報已經有，不再建');
  assert.strictEqual(sb.readSheet('BulletinWeeks').filter(function (r) { return r.QUARTER_ID === '2031T1'; }).length, 2);
});

test('runAutoCreateQuarters_：Config AUTO_CREATE_QUARTERS=FALSE → 整個停用，一行都不建；maxQuarters=1 → 其餘留待下一次並講出來', function () {
  const off = makeEnv({ config: { AUTO_CREATE_QUARTERS: 'FALSE' } });
  addRosterQuarter(off, '2031T1', ['2031-01-05'], 1);
  const r = plain(off.sandbox.runAutoCreateQuarters_({}));
  assert.strictEqual(r.enabled, false);
  assert.strictEqual(off.sandbox.readSheet('BulletinWeeks').filter(function (x) { return x.QUARTER_ID === '2031T1'; }).length, 0);

  const env = makeEnv({ config: { AUTO_CREATE_QUARTERS_LEAD_DAYS: '0' } });
  addRosterQuarter(env, '2031T1', ['2031-01-05'], 1);
  addRosterQuarter(env, '2031T2', ['2031-04-06'], 1);
  const limited = plain(env.sandbox.runAutoCreateQuarters_({ maxQuarters: 1, source: 'WEBAPP' }));
  assert.ok(limited.pending >= 1, JSON.stringify(limited));
  assert.ok(limited.message.indexOf('季會在稍後自動建立') !== -1, limited.message);
});

test('上線前檢查（唯讀）多一項「自動建立季度」：列出現在會建立哪幾季、建立甚麼，與真正建立同一份計畫；一格都不寫；停用時講明', function () {
  const env = makeEnv({ config: { AUTO_CREATE_QUARTERS_LEAD_DAYS: '0' } });
  addRosterQuarter(env, '2031T1', ['2031-01-05', '2031-01-12'], 1);
  const sb = env.sandbox;
  const rowsBefore = sb.readSheet('BulletinWeeks').length;
  const item = plain(sb.buildGoLiveChecklist_()).filter(function (i) { return i.label === '上線前：自動建立季度'; })[0];
  assert.ok(item, '要有這一項');
  assert.strictEqual(item.status, sb.SELF_CHECK_STATUS_.YELLOW);
  assert.ok(item.message.indexOf('2031T1（2031-01-05 至 2031-01-12，週報與內容表）') !== -1, item.message);
  assert.strictEqual(sb.readSheet('BulletinWeeks').length, rowsBefore, '唯讀');
  assertWrittenChinese(assert, '上線前檢查：自動建立季度', [item.message]);
  // 與真正建立同一份計畫：建立之後，這一項不再列出 2031T1 的週報。
  sb.runAutoCreateQuarters_({});
  const after = plain(sb.buildGoLiveChecklist_()).filter(function (i) { return i.label === '上線前：自動建立季度'; })[0];
  assert.strictEqual(after.message.indexOf('2031T1（2031-01-05 至 2031-01-12，週報與內容表）'), -1, after.message);

  const off = makeEnv({ config: { AUTO_CREATE_QUARTERS: 'FALSE' } });
  const offItem = plain(off.sandbox.buildGoLiveChecklist_()).filter(function (i) { return i.label === '上線前：自動建立季度'; })[0];
  assert.ok(offItem.message.indexOf('AUTO_CREATE_QUARTERS 是 FALSE') !== -1, offItem.message);
});

test('上線前檢查：「模擬今日」填了就 🟡 並講明正式使用前要清空；未填 🟢', function () {
  const pick = function (env) { return plain(env.sandbox.buildGoLiveChecklist_()).filter(function (i) { return i.label === '上線前：模擬今日（測試設定）'; })[0]; };
  const on = makeEnv({ config: { WEBAPP_SIMULATED_TODAY: '2028-04-05' } });
  const item = pick(on);
  assert.strictEqual(item.status, on.sandbox.SELF_CHECK_STATUS_.YELLOW);
  assert.ok(item.message.indexOf('2028-04-05') !== -1 && item.message.indexOf('正式使用前要清空') !== -1, item.message);
  const off = makeEnv();
  assert.strictEqual(pick(off).status, off.sandbox.SELF_CHECK_STATUS_.GREEN);
  assertWrittenChinese(assert, '模擬今日', [item.message, pick(off).message]);
});

test('自動建立只限第一個主日在 AUTO_CREATE_QUARTERS_LEAD_DAYS 日之內（預設 90）：職事表內遠期的測試季度不建；上線前檢查講明範圍', function () {
  const sb = makeEnv().sandbox;
  const quarters = [
    { quarterId: 'NEAR', versionCount: 1, firstIso: '2026-12-06', lastIso: '2027-02-28' },
    { quarterId: 'FAR', versionCount: 1, firstIso: '2027-06-06', lastIso: '2027-08-29' }
  ];
  const plan = function (lead) {
    return plain(sb.planAutoCreateQuarters_({ rosterQuarters: quarters, todayIso: '2026-10-26', leadDays: lead })).map(function (p) { return p.quarterId; });
  };
  assert.deepStrictEqual(plan(90), ['NEAR']);
  assert.deepStrictEqual(plan(0), ['NEAR', 'FAR'], '0＝不限');
  assert.strictEqual(sb.autoCreateLeadDays_(), 90, 'Config 預設 90');
  assert.strictEqual(makeEnv({ config: { AUTO_CREATE_QUARTERS_LEAD_DAYS: '亂寫' } }).sandbox.autoCreateLeadDays_(), 90, '不合法就用 90，不會變成不限');

  const env = makeEnv();
  addRosterQuarter(env, '2031T1', ['2031-01-05'], 1);
  const r = plain(env.sandbox.runAutoCreateQuarters_({}));
  assert.strictEqual(r.created.filter(function (c) { return c.quarterId === '2031T1'; }).length, 0, '遠期季度不建');
  const item = plain(env.sandbox.buildGoLiveChecklist_()).filter(function (i) { return i.label === '上線前：自動建立季度'; })[0];
  assert.ok(item.message.indexOf('90 日之內') !== -1, item.message);
});

test('開啟填寫介面（真入口 autoCreateQuartersForWebApp_）：Config AUTO_CREATE_QUARTERS 是 FALSE 時不出橫幅、一格都不寫（v3 重測：以前每次開頁都出「沒有自動建立」）', function () {
  const store = {};
  const props = { getProperty: function (k) { return store[k] === undefined ? null : store[k]; }, setProperty: function (k, v) { store[k] = String(v); }, deleteProperty: function (k) { delete store[k]; } };
  const env = makeEnv({ config: { AUTO_CREATE_QUARTERS: 'FALSE', AUTO_CREATE_QUARTERS_LEAD_DAYS: '0' },
    extraStubs: { PropertiesService: { getScriptProperties: function () { return props; }, getUserProperties: function () { return props; } } } });
  addRosterQuarter(env, '2031T1', ['2031-01-05'], 1);
  const sb = env.sandbox;
  const rowsBefore = sb.readSheet('BulletinWeeks').length;
  assert.strictEqual(sb.autoCreateQuartersForWebApp_(), '');
  assert.strictEqual(sb.readSheet('BulletinWeeks').length, rowsBefore, '停用就不建');
  // 開啟之後同一條入口照常講結果（這個環境內容表建不到，所以講「未能自動建立」）——即是只有停用時才靜默。
  const on = makeEnv({ config: { AUTO_CREATE_QUARTERS_LEAD_DAYS: '0' },
    extraStubs: { PropertiesService: { getScriptProperties: function () { const s2 = {}; return { getProperty: function (k) { return s2[k] === undefined ? null : s2[k]; }, setProperty: function (k, v) { s2[k] = String(v); }, deleteProperty: function (k) { delete s2[k]; } }; } } } });
  addRosterQuarter(on, '2031T1', ['2031-01-05'], 1);
  const msg = on.sandbox.autoCreateQuartersForWebApp_();
  assert.ok(msg.indexOf('2027T4') !== -1, '開啟時照常講：' + msg);
});

test('開啟填寫介面：先記下「已檢查」才做（兩個分頁同時打開只做一次；做的途中出錯亦不會每次開頁都重試）；週報建立經指令碼鎖', function () {
  const store = {};
  const props = { getProperty: function (k) { return store[k] === undefined ? null : store[k]; }, setProperty: function (k, v) { store[k] = String(v); }, deleteProperty: function (k) { delete store[k]; } };
  const env = makeEnv({ config: { AUTO_CREATE_QUARTERS_LEAD_DAYS: '0' },
    extraStubs: { PropertiesService: { getScriptProperties: function () { return props; }, getUserProperties: function () { return props; } } } });
  const sb = env.sandbox;
  let reads = 0;
  sb.runAutoCreateQuarters_ = function () { reads++; throw new Error('職事表讀不到'); };
  sb.autoCreateQuartersForWebApp_();
  sb.autoCreateQuartersForWebApp_();
  assert.strictEqual(reads, 1, '出錯之後十分鐘內不再試');
  const code = readSrc('src/QuarterAutoCreate.gs');
  const body = code.slice(code.indexOf('function autoCreateQuartersForWebApp_('), code.indexOf('function dailyQuarterAutoCreateTrigger_('));
  assert.ok(body.indexOf('writeTimedScriptProperty_(') < body.indexOf('runAutoCreateQuarters_('), '先記下才做');
  const run = code.slice(code.indexOf('function runAutoCreateQuarters_('), code.indexOf('function buildAutoCreateQuartersPlanNow_('));
  assert.ok(/withScriptLock_\([^)]*function \(\) \{\s*return createBlankBulletinWeeks_\(/.test(run), '建週報經指令碼鎖');
});

test('開啟填寫介面：某一季內容表自動建立失敗過，一日內不再試那一季的內容表（每日觸發器照試），亦不擋住排在後面的季度', function () {
  const store = {};
  const props = { getProperty: function (k) { return store[k] === undefined ? null : store[k]; }, setProperty: function (k, v) { store[k] = String(v); }, deleteProperty: function (k) { delete store[k]; } };
  const env = makeEnv({ config: { AUTO_CREATE_QUARTERS_LEAD_DAYS: '0' },
    extraStubs: { PropertiesService: { getScriptProperties: function () { return props; }, getUserProperties: function () { return props; } } } });
  const sb = env.sandbox;
  addRosterQuarter(env, '2031T1', ['2031-01-05'], 1);
  // 第一次（每日觸發器）：2027T4 與 2031T1 的內容表都建不到（這個環境沒有資料夾）→ 記下失敗。
  sb.runAutoCreateQuarters_({ source: 'TRIGGER' });
  assert.ok(store[sb.autoCreateSheetFailedKey_(QUARTER_ID)], '記下 2027T4 內容表失敗');
  const errorsBefore = sb.readSheet('ErrorLog').length;
  // 開頁：兩季都只欠內容表、一日內失敗過 → 整季略過，不再試、不再寫 ErrorLog。
  const webapp = plain(sb.runAutoCreateQuarters_({ maxQuarters: 1, source: 'WEBAPP' }));
  assert.strictEqual(webapp.skipped.length, 0, JSON.stringify(webapp));
  assert.strictEqual(sb.readSheet('ErrorLog').length, errorsBefore);
  // 每日觸發器照試。
  const daily = plain(sb.runAutoCreateQuarters_({ source: 'TRIGGER' }));
  assert.ok(daily.skipped.length >= 1, JSON.stringify(daily));
});

test('開啟填寫介面（真正入口 apiListWeeks，autoCreate）：自動建立並在頂部講一句；十分鐘內不再檢查；出錯不令載入失敗', function () {
  const store = {};
  const props = { getProperty: function (k) { return store[k] === undefined ? null : store[k]; }, setProperty: function (k, v) { store[k] = String(v); }, deleteProperty: function (k) { delete store[k]; } };
  const env = makeEnv({ config: { AUTO_CREATE_QUARTERS_LEAD_DAYS: '0' },
    extraStubs: { PropertiesService: { getScriptProperties: function () { return props; }, getUserProperties: function () { return props; } } } });
  addRosterQuarter(env, '2031T1', ['2031-01-05'], 1);
  addRosterQuarter(env, '2031T2', ['2031-04-06'], 1);
  const sb = env.sandbox;
  // 2027T4 當作已經有內容表（只看新的季度）。
  sb.writeSheet('ContentSheets', [{ QUARTER_ID: QUARTER_ID, FILE_ID: 'CS1', FILE_URL: 'https://docs.google.com/spreadsheets/d/CS1/edit', ACTIVE: true }]);
  let runs = 0;
  const original = sb.runAutoCreateQuarters_;
  sb.runAutoCreateQuarters_ = function () { runs++; return original.apply(this, arguments); };
  const first = sb.apiListWeeks(false, { autoCreate: true });
  assert.strictEqual(first.ok, true, JSON.stringify(first.error));
  assert.ok(first.data.autoCreateNotice.indexOf('系統已自動建立 2031T1 的週報') !== -1, first.data.autoCreateNotice);
  assert.ok(first.data.autoCreateNotice.indexOf('另有 1 季會在稍後自動建立') !== -1, '每次開頁最多一季，其餘講明');
  assert.strictEqual(sb.readSheet('BulletinWeeks').filter(function (r) { return r.QUARTER_ID === '2031T2'; }).length, 0);
  // 即使仍有未建立的季度，十分鐘內亦不再檢查（每一次開頁都讀職事表、重試失敗的內容表會令開頁變慢、ErrorLog 洗版）。
  const second = sb.apiListWeeks(false, { autoCreate: true });
  assert.strictEqual(second.data.autoCreateNotice, '');
  assert.strictEqual(runs, 1, '十分鐘內不再讀職事表');
  const plainLoad = sb.apiListWeeks(false);
  assert.strictEqual(plainLoad.data.autoCreateNotice, '', '只有第一次載入才檢查');

  sb.runAutoCreateQuarters_ = function () { throw new Error('職事表讀不到'); };
  Object.keys(store).forEach(function (k) { delete store[k]; });
  const broken = sb.apiListWeeks(false, { autoCreate: true });
  assert.strictEqual(broken.ok, true, '自動建立出錯不可以令載入失敗');
  assert.strictEqual(broken.data.autoCreateNotice, '');
  assert.ok(sb.readSheet('ErrorLog').some(function (r) { return String(r.MESSAGE).indexOf('職事表讀不到') !== -1; }));
});

// =====================================================================
// 8. 事奉框：與職事表不同的崗位、查看／修改職事表、跨季的下週事奉
// =====================================================================

console.log('\n事奉框');

test('載入（真正入口）：你填的名字與職事表不同 → dutyDiffs 列出崗位、兩個名字；改回職事表的名字就不列', function () {
  const env = makeEnv();
  save(env, D, {}, { dutyEdits: [{ postId: 'CHAIR', slotIndex: 1, name: '王某', baseName: '陳大文' }] });
  const diffs = plain(env.sandbox.loadWeekForWebApp_(D).dutyDiffs);
  assert.strictEqual(diffs.length, 1, JSON.stringify(diffs));
  assert.strictEqual(diffs[0].postLabel, '主席');
  assert.strictEqual(diffs[0].bulletinName, '王某');
  assert.strictEqual(diffs[0].rosterName, '陳大文');
  assert.strictEqual(diffs[0].conflict, false);
  save(env, D, {}, { dutyEdits: [{ postId: 'CHAIR', slotIndex: 1, name: '陳大文', baseName: '王某' }] });
  assert.deepStrictEqual(plain(env.sandbox.loadWeekForWebApp_(D).dutyDiffs), []);
});

test('buildDutyDiffNotices_（純函式）：職事表未排定（空白）的崗位不列；沒有覆寫的不列', function () {
  const sb = makeEnv().sandbox;
  const out = plain(sb.buildDutyDiffNotices_({ rows: [
    { postId: 'A', slotIndex: 1, postLabel: '甲', bulletinName: '王', rosterName: '', hasOverride: true, status: 'OVERRIDDEN' },
    { postId: 'B', slotIndex: 1, postLabel: '乙', bulletinName: '王', rosterName: '李', hasOverride: false, status: 'SAME' },
    { postId: 'C', slotIndex: 2, postLabel: '丙', bulletinName: '王', rosterName: '李', hasOverride: true, status: 'CONFLICT' }
  ] }));
  assert.deepStrictEqual(out, [{ postId: 'C', slotIndex: 2, postLabel: '丙', bulletinName: '王', rosterName: '李', conflict: true }]);
});

test('「查看／修改職事表」網址：只收 https:// 開頭；未填或其他一律不顯示（經載入的真正入口）', function () {
  assert.strictEqual(makeEnv().sandbox.loadWeekForWebApp_(D).rosterWebAppUrl, '');
  assert.strictEqual(makeEnv({ config: { ROSTER_WEBAPP_URL: 'https://script.google.com/macros/s/R/exec' } }).sandbox.loadWeekForWebApp_(D).rosterWebAppUrl,
    'https://script.google.com/macros/s/R/exec');
  assert.strictEqual(makeEnv({ config: { ROSTER_WEBAPP_URL: 'javascript:alert(1)' } }).sandbox.loadWeekForWebApp_(D).rosterWebAppUrl, '');
  assert.strictEqual(makeEnv({ config: { ROSTER_WEBAPP_URL: 'http://x.example' } }).sandbox.loadWeekForWebApp_(D).rosterWebAppUrl, '');
});

test('第 9 項：季末最後一個主日的「下週事奉」讀得到下一季的職事表（下一季已有資料的話），而且可以填', function () {
  const last = '2027-11-28';
  const nextIso = '2027-12-05';
  const env = makeEnv({ weekRows: [weekRowInput(last)] });
  const before = plain(env.sandbox.loadWeekForWebApp_(last)).readOnly;
  assert.strictEqual(before.nextWeekEditable, false, '下一季未有職事表：改不到，並有提示');
  assert.ok(before.nextWeekNotice.indexOf(nextIso) !== -1, before.nextWeekNotice);

  addRosterQuarter(env, '2028T1', [nextIso], 1);
  const roster = env.sandbox.SpreadsheetApp.openById(FAKE_ROSTER_ID);
  const sh = roster.getSheetByName('RosterAssignments');
  const keys = sh.getRange(2, 1, 1, sh.getLastColumn()).getValues()[0];
  const obj = { QuarterID: '2028T1', VersionNo: 1, ServiceDate: nextIso, PostID: 'CHAIR', SlotIndex: 1, PersonID: 'P9001', PersonNameSnapshot: '陳大文', AssignSource: 'AUTO', Locked: false };
  sh.getRange(sh.getLastRow() + 1, 1, 1, keys.length).setValues([keys.map(function (k) { return obj[k] === undefined ? '' : obj[k]; })]);
  env.sandbox.ROSTER_TABLES_CACHE_ = null;

  const after = plain(env.sandbox.loadWeekForWebApp_(last)).readOnly;
  assert.strictEqual(after.nextWeekIsoDate, nextIso);
  assert.strictEqual(after.nextWeekEditable, true);
  const chair = after.nextWeekDuty.filter(function (r) { return r.label === '主席'; })[0];
  assert.ok(chair && String(chair.text).indexOf('陳大文') !== -1, JSON.stringify(after.nextWeekDuty));
});

// =====================================================================
// 9. 發佈時窗（純函式）
// =====================================================================

console.log('\n發佈時窗');

test('buildPublishWindowStatus_／webAppTodayIso_：星期一至主日是該週；模擬今日有效才用，格式不對講明', function () {
  const sb = makeEnv({ config: { WEBAPP_SIMULATED_TODAY: '2028-04-05' } }).sandbox;
  const today = plain(sb.webAppTodayIso_());
  assert.deepStrictEqual(today, { todayIso: '2028-04-05', simulated: true, simulatedRaw: '2028-04-05' });
  const inWindow = plain(sb.buildPublishWindowStatus_('2028-04-09', today));
  assert.strictEqual(inWindow.isCurrentWeek, true);
  assert.strictEqual(inWindow.fromIso, '2028-04-03');
  assert.strictEqual(inWindow.notice, '');
  const other = plain(sb.buildPublishWindowStatus_('2028-04-16', today));
  assert.strictEqual(other.isCurrentWeek, false);
  assert.ok(other.notice.indexOf('2028-04-09') !== -1 && other.notice.indexOf('2028-04-16') !== -1, other.notice);
  assertWrittenChinese(assert, '時窗說明', [other.notice]);
  // 主日當日仍然是該週；翌日（星期一）已經是下一週。
  assert.strictEqual(sb.isWithinPublishWindow_('2028-04-09', '2028-04-09'), true);
  assert.strictEqual(sb.isWithinPublishWindow_('2028-04-09', '2028-04-10'), false);

  const bad = makeEnv({ config: { WEBAPP_SIMULATED_TODAY: '下星期' } }).sandbox;
  const badToday = plain(bad.webAppTodayIso_());
  assert.strictEqual(badToday.simulated, false);
  assert.strictEqual(plain(bad.buildPublishWindowStatus_(D, badToday)).simulatedInvalid, true);
});

// =====================================================================
// 10. 前端（Script.html 真正的程式碼，假 DOM）
// =====================================================================

console.log('\n前端');

function makeDom() {
  const elements = {};
  function makeEl(tag, className) {
    const node = {
      tag: tag, className: className || '', children: [], textContent: '', value: '', disabled: false, attrs: {},
      listeners: {}, style: {},
      appendChild: function (child) { node.children.push(child); child.parentNode = node; return child; },
      insertBefore: function (child, ref) {
        const i = ref ? node.children.indexOf(ref) : -1;
        if (i === -1) node.children.push(child); else node.children.splice(i, 0, child);
        return child;
      },
      setAttribute: function (k, v) { node.attrs[k] = String(v); },
      getAttribute: function (k) { return Object.prototype.hasOwnProperty.call(node.attrs, k) ? node.attrs[k] : null; },
      removeAttribute: function (k) { delete node.attrs[k]; },
      hasAttribute: function (k) { return Object.prototype.hasOwnProperty.call(node.attrs, k); },
      addEventListener: function (type, fn) { (node.listeners[type] = node.listeners[type] || []).push(fn); },
      fire: function (type, ev) { (node.listeners[type] || []).forEach(function (fn) { fn(ev || { preventDefault: function () {}, target: node }); }); },
      focus: function () {}
    };
    const classes = new Set(String(className || '').split(' ').filter(Boolean));
    node.classList = {
      add: function (c) { classes.add(c); },
      remove: function (c) { classes.delete(c); },
      contains: function (c) { return classes.has(c); },
      toggle: function (c, force) { const on = force === undefined ? !classes.has(c) : Boolean(force); if (on) classes.add(c); else classes.delete(c); return on; }
    };
    Object.defineProperty(node, 'firstChild', { get: function () { return node.children[0] || null; } });
    Object.defineProperty(node, 'innerHTML', {
      set: function (v) { if (v !== '') throw new Error('不可以用 innerHTML 塞內容'); node.children = []; },
      get: function () { return ''; }
    });
    return node;
  }
  const document = {
    getElementById: function (id) {
      if (!elements[id]) { elements[id] = makeEl('div'); elements[id].id = id; }
      return elements[id];
    },
    createTextNode: function (t) { const n = makeEl('#text'); n.textContent = t; return n; }
  };
  return { document: document, makeEl: makeEl, elements: elements };
}

function region(js, name) {
  const start = js.indexOf('// BEGIN ' + name);
  const end = js.indexOf('// END ' + name);
  assert.ok(start !== -1 && end !== -1, 'Script.html 內找不到 ' + name + ' 區段標記');
  return js.slice(start, end);
}

function between(js, from, to) {
  const start = js.indexOf(from);
  const end = js.indexOf(to, start);
  assert.ok(start !== -1 && end !== -1, 'Script.html 內找不到 ' + from + ' 至 ' + to);
  return js.slice(start, end);
}

function findAll(node, predicate, out) {
  const acc = out || [];
  if (predicate(node)) acc.push(node);
  (node.children || []).forEach(function (c) { findAll(c, predicate, acc); });
  return acc;
}

function buttonsOf(node) { return findAll(node, function (n) { return n.tag === 'button'; }); }
function clickButton(node, text) {
  const btn = buttonsOf(node).filter(function (b) { return b.textContent === text; })[0];
  assert.ok(btn, '找不到按鈕「' + text + '」；有：' + buttonsOf(node).map(function (b) { return b.textContent; }).join('、'));
  btn.fire('click');
}

function loadUi(parts, extraCtx) {
  const js = readSrc('src/ui/Script.html');
  const dom = makeDom();
  const counts = { preview: 0, unsaved: 0 };
  const ctx = Object.assign({
    console: console, document: dom.document, Date: Date, Math: Math, JSON: JSON,
    el: function (tag, className) { return dom.makeEl(tag, className); },
    schedulePreviewRefresh: function () { counts.preview++; },
    refreshUnsavedIndicator: function () { counts.unsaved++; },
    state: { lists: {} }
  }, extraCtx || {});
  vm.createContext(ctx);
  vm.runInContext(parts.map(function (p) { return typeof p === 'string' ? region(js, p) : between(js, p[0], p[1]); }).join('\n'), ctx);
  // els.X 等於 document.getElementById('X')（假 DOM 第一次問到才建立）。
  const els = new Proxy({}, { get: function (t, id) { return dom.document.getElementById(String(id)); } });
  return { ctx: ctx, dom: dom, els: els, counts: counts };
}

const SMALL_BUTTON = ['function makeSmallButton(', 'function moveListItem('];

test('程序表（program-edits）：×＝拿走、還原＝取消拿走；＋＝在那一行之後加一項；寫的 JSON 經伺服器 applyProgramEdits_() 得出同一個結果', function () {
  const ui = loadUi(['program-edits', SMALL_BUTTON]);
  const sb = makeEnv().sandbox;
  const rows = tplRows(['序樂', '拍照', '祝福']);
  const show = function () {
    const applied = plain(sb.applyProgramEdits_(rows, ui.els.programEditsInput.value));
    ui.ctx.renderProgramPreview(applied.display);
    return applied;
  };
  show();
  const body = ui.els.programPreviewBody;
  assert.strictEqual(body.children.length, 4, '三行＋最後那一行「在最後加一項」');
  clickButton(body.children[1], '×');
  assert.deepStrictEqual(JSON.parse(ui.els.programEditsInput.value), { v: 1, hidden: ['拍照#1'], added: [] });
  assert.ok(ui.counts.preview >= 1 && ui.counts.unsaved >= 1, '改了就即時重算預覽、更新未儲存提示');
  let applied = show();
  assert.deepStrictEqual(applied.rows.map(function (r) { return r.itemName; }), ['序樂', '祝福']);
  assert.ok(body.children[1].classList.contains('is-removed'));
  clickButton(body.children[1], '還原');
  assert.strictEqual(ui.els.programEditsInput.value, '', '沒有增刪就清空那一格');

  show();
  clickButton(body.children[0], '＋');
  assert.strictEqual(ui.els.programAddForm.classList.contains('hidden'), false);
  assert.strictEqual(ui.els.programAddAfterLabel.textContent, '加在「序樂」之後：');
  ui.els.programAddName.value = '';
  ui.ctx.confirmProgramAdd();
  assert.ok(ui.els.programAddAfterLabel.textContent.indexOf('請先填項目名稱') === 0, '名稱空白不加');
  ui.els.programAddName.value = '特別分享';
  ui.els.programAddContent.value = '王弟兄';
  ui.els.programAddPosture.value = '眾 立';
  ui.ctx.confirmProgramAdd();
  assert.strictEqual(ui.els.programAddForm.classList.contains('hidden'), true);
  const edits = JSON.parse(ui.els.programEditsInput.value);
  assert.strictEqual(edits.added.length, 1);
  assert.deepStrictEqual({ after: edits.added[0].after, itemName: edits.added[0].itemName, content: edits.added[0].content, posture: edits.added[0].posture },
    { after: '序樂#1', itemName: '特別分享', content: '王弟兄', posture: '眾 立' });
  applied = show();
  assert.deepStrictEqual(applied.rows.map(function (r) { return r.itemName; }), ['序樂', '特別分享', '拍照', '祝福']);
});

test('程序表：拿走一個「加的行」時，加在它之後的另一項改為加在它原本的位置之後（不會變成找不到位置）；「在最後加一項」', function () {
  const ui = loadUi(['program-edits', SMALL_BUTTON]);
  const sb = makeEnv().sandbox;
  const rows = tplRows(['序樂', '祝福']);
  ui.els.programEditsInput.value = JSON.stringify({ v: 1, hidden: [], added: [
    { id: 'a1', after: '序樂#1', itemName: '甲', content: '', posture: '眾 坐' },
    { id: 'a2', after: 'add:a1', itemName: '乙', content: '', posture: '眾 坐' }
  ] });
  ui.ctx.renderProgramPreview(plain(sb.applyProgramEdits_(rows, ui.els.programEditsInput.value)).display);
  clickButton(ui.els.programPreviewBody.children[1], '×'); // 「甲」那一行
  const edits = JSON.parse(ui.els.programEditsInput.value);
  assert.deepStrictEqual(edits.added.map(function (a) { return a.id + '→' + a.after; }), ['a2→序樂#1']);
  const applied = plain(sb.applyProgramEdits_(rows, ui.els.programEditsInput.value));
  assert.deepStrictEqual(applied.rows.map(function (r) { return r.itemName; }), ['序樂', '乙', '祝福']);
  assert.deepStrictEqual(applied.warnings, []);

  ui.ctx.renderProgramPreview(applied.display);
  const body = ui.els.programPreviewBody;
  clickButton(body.children[body.children.length - 1], '＋ 在最後加一項');
  assert.strictEqual(ui.els.programAddAfterLabel.textContent, '加在程序表最後：');
  ui.els.programAddName.value = '散會';
  ui.ctx.confirmProgramAdd();
  assert.strictEqual(JSON.parse(ui.els.programEditsInput.value).added[1].after, '__END__');
});

function loadListUi(items) {
  const ui = loadUi([['var LIST_DEFS = {', 'var previewTimer'], 'list-arrange', SMALL_BUTTON, ['function buildReadOnlyListRow(', 'function buildListRow(']]);
  vm.runInContext('state.lists.announcements = ' + JSON.stringify(items) + ';', ui.ctx);
  return ui;
}

test('清單（list-arrange）：↑↓ 與拖放改次序、×＝拿走（刪除線）、還原；改回原本的樣子就清空那一格；寫的 JSON 經伺服器 arrangeListItems_() 得出同一個次序', function () {
  const env = makeEnv({ announcements: THREE_ANNOUNCEMENTS.slice() });
  const items = plain(env.sandbox.loadWeekForWebApp_(D)).lists.announcements;
  const ui = loadListUi(items);
  ui.ctx.renderList('announcements');
  const box = ui.els.announcementsList;
  assert.strictEqual(box.children.length, 3);
  assert.strictEqual(buttonsOf(box.children[0]).filter(function (b) { return b.textContent === '↑'; })[0].disabled, true);
  assert.strictEqual(buttonsOf(box.children[2]).filter(function (b) { return b.textContent === '↓'; })[0].disabled, true);
  // 內容不可以在這裏改：一個輸入框都沒有。
  assert.strictEqual(findAll(box, function (n) { return n.tag === 'input' || n.tag === 'textarea'; }).length, 0);

  clickButton(box.children[0], '↓');                       // 乙 甲 丙
  box.children[2].fire('dragstart', { dataTransfer: { setData: function () {} }, preventDefault: function () {} });
  box.children[0].fire('drop', { preventDefault: function () {} });   // 丙 乙 甲
  clickButton(box.children[2], '×');                        // 甲 拿走
  assert.ok(box.children[2].classList.contains('is-hidden-item'));
  const value = ui.els.listArrangementInput.value;
  const parsed = JSON.parse(value);
  assert.deepStrictEqual(Object.keys(parsed).sort(), ['announcements', 'v']);
  const server = plain(env.sandbox.arrangeListItems_('announcements', THREE_ANNOUNCEMENTS.map(function (a) { return { TEXT: a.TEXT }; }), parsed.announcements));
  assert.deepStrictEqual(server.map(function (o) { return o.item.TEXT + (o.hidden ? '×' : ''); }), ['丙', '乙', '甲×']);

  clickButton(box.children[2], '還原');
  clickButton(box.children[0], '↓');                       // 乙 丙 甲
  clickButton(box.children[1], '↓');                       // 乙 甲 丙
  clickButton(box.children[0], '↓');                       // 甲 乙 丙
  assert.strictEqual(ui.els.listArrangementInput.value, '', '回到原本次序、沒有拿走 → 清空');
  assert.ok(ui.counts.unsaved >= 1);
});

test('發佈時窗（publish-window）：不在該週 → 發佈、寄出、執行一律停用並講明；在該週 → 可以用；模擬今日講明', function () {
  const ui = loadUi(['publish-window']);
  ui.ctx.renderPublishWindow({ isCurrentWeek: false, notice: '現在可以發佈的是 2028-04-09 那一期。', simulated: true, todayIso: '2028-04-05' });
  ['doPublishCheck', 'doSendCheck', 'publishRunBtn'].forEach(function (id) { assert.strictEqual(ui.els[id].disabled, true, id); });
  assert.strictEqual(ui.els.publishStatusBar.classList.contains('hidden'), true, '「目前已發佈」只在該週顯示');
  assert.ok(ui.els.publishWindowNotice.textContent.indexOf('2028-04-09') !== -1);
  assert.ok(ui.els.publishWindowNotice.textContent.indexOf('測試設定：系統現在當今日是 2028-04-05') !== -1);
  assert.strictEqual(ui.ctx.isPublishWindowOpen(), false);

  ui.ctx.renderPublishWindow({ isCurrentWeek: true, notice: '' });
  ['doPublishCheck', 'doSendCheck', 'publishRunBtn'].forEach(function (id) { assert.strictEqual(ui.els[id].disabled, false, id); });
  assert.strictEqual(ui.els.publishWindowNotice.classList.contains('hidden'), true);
  assert.strictEqual(ui.ctx.isPublishWindowOpen(), true);
  ui.ctx.renderPublishWindow(null);
  assert.strictEqual(ui.ctx.isPublishWindowOpen(), false, '沒有資料當作不在時窗（寧可擋住）');
});

test('Index.html：程序表與三張清單的隱藏欄位跟隨「儲存」送出（data-field）；每一個輸入區塊都有一粒「儲存」', function () {
  const html = readSrc('src/ui/Index.html');
  assert.ok(/id="programEditsInput"[^>]*data-field="PROGRAM_EDITS"|data-field="PROGRAM_EDITS"[^>]*id="programEditsInput"/.test(html));
  assert.ok(/id="listArrangementInput"[^>]*data-field="LIST_ARRANGEMENT"|data-field="LIST_ARRANGEMENT"[^>]*id="listArrangementInput"/.test(html));
  assert.ok((html.match(/data-save-button/g) || []).length >= 4, '每一個輸入區塊一粒');
});

// =====================================================================
// v3 重測（2026-10-27）：模擬今日亦用於自動建立季度與打開時落在哪一週；試寄星期一草稿預覽信
// =====================================================================

console.log('\nv3 重測：模擬今日與試寄草稿預覽信');

test('自動建立（真入口 runAutoCreateQuarters_）：Config 模擬今日填了就按那一日計——測試季度可以自動建立，真正今日以為太遠的季度亦一樣；未填就照真正的今日', function () {
  const sim = makeEnv({ config: { WEBAPP_SIMULATED_TODAY: '2031-01-01' } });
  addRosterQuarter(sim, '2031T1', ['2031-01-05', '2031-01-12'], 1);
  const r = plain(sim.sandbox.runAutoCreateQuarters_({}));
  const made = r.created.filter(function (c) { return c.quarterId === '2031T1'; })[0];
  assert.ok(made && made.weeksAdded === 2, JSON.stringify(r));
  assert.strictEqual(r.created.filter(function (c) { return c.quarterId === QUARTER_ID; }).length, 0, '模擬今日之前已完結的季度不建');
  const item = plain(sim.sandbox.buildGoLiveChecklist_()).filter(function (i) { return i.label === '上線前：自動建立季度'; })[0];
  assert.ok(item.message.indexOf('WEBAPP_SIMULATED_TODAY「2031-01-01」當今日計') !== -1, item.message);

  const real = makeEnv();
  addRosterQuarter(real, '2031T1', ['2031-01-05', '2031-01-12'], 1);
  const r2 = plain(real.sandbox.runAutoCreateQuarters_({}));
  assert.strictEqual(r2.created.filter(function (c) { return c.quarterId === '2031T1'; }).length, 0, '未填模擬今日：照真正的今日，遠期季度不建');
});

test('打開填寫介面（真入口 listWeeksForWebApp_）：模擬今日填了就落在模擬那一週；未填照舊落在真正今日之後第一個未發佈的主日', function () {
  const sim = makeEnv({ config: { WEBAPP_SIMULATED_TODAY: '2027-11-10' } });
  assert.strictEqual(plain(sim.sandbox.listWeeksForWebApp_(false)).defaultIsoDate, D_NEXT);
  const real = makeEnv();
  assert.strictEqual(plain(real.sandbox.listWeeksForWebApp_(false)).defaultIsoDate, D);
});

test('選單「試寄星期一草稿預覽信」（真入口 menuTestSendPreviewNotice_）：留空用模擬今日之後的主日；經星期一同一條 sendPreviewNotice_，DRY_RUN 只寫 SendLog，信內有預覽連結', function () {
  const seed = plain(makeEnv().sandbox.seedEmailTemplatesRows_());
  const alerts = [];
  const env = makeEnv({
    config: { WEBAPP_SIMULATED_TODAY: '2027-11-10', DRY_RUN: 'TRUE' },
    fill: {
      emailTemplates: seed,
      ui: {
        prompt: function () { return { getSelectedButton: function () { return 'OK'; }, getResponseText: function () { return ''; } }; },
        alert: function () { alerts.push(Array.prototype.slice.call(arguments).join('\n')); return 'OK'; }
      }
    }
  });
  env.sandbox.menuTestSendPreviewNotice_();
  const rows = env.sandbox.readSheet('SendLog').filter(function (r) { return r.STATUS === 'PREVIEW'; });
  assert.ok(rows.length >= 1, '寫了 SendLog：' + JSON.stringify(alerts));
  assert.strictEqual(env.sandbox.formatIsoDate_(rows[0].SERVICE_DATE), D_NEXT);
  assert.strictEqual(rows[0].DRY_RUN, true);
  assert.ok(String(rows[0].BODY_PREVIEW).indexOf(PREVIEW_URL) !== -1, rows[0].BODY_PREVIEW);
  assert.strictEqual(env.mail.calls.length, 0, 'DRY_RUN 不寄');
  assert.ok(alerts.length === 1 && alerts[0].indexOf('主日日期：' + D_NEXT) !== -1 && alerts[0].indexOf('是（沒有真的寄出任何郵件）') !== -1, JSON.stringify(alerts));
  assertWrittenChinese(assert, '試寄草稿預覽信', alerts);

  // 日期格式不對：講明，不寄。
  const bad = [];
  const env2 = makeEnv({ fill: { emailTemplates: seed, ui: {
    prompt: function () { return { getSelectedButton: function () { return 'OK'; }, getResponseText: function () { return '下星期'; } }; },
    alert: function (t) { bad.push(String(t)); return 'OK'; } } } });
  env2.sandbox.menuTestSendPreviewNotice_();
  assert.ok(bad.length === 1 && bad[0].indexOf('日期格式不對') !== -1, JSON.stringify(bad));
  assert.strictEqual(env2.sandbox.readSheet('SendLog').length, 0);
});

console.log('\n通過 ' + pass + ' 項，失敗 ' + fail + ' 項。');
process.exit(fail === 0 ? 0 : 1);
