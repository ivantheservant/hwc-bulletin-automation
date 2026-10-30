#!/usr/bin/env node
/**
 * tests/rosterread82.test.js
 *
 * 2026-10-27：週報讀職事表資料，對照職事表第八十二輪說明（docs/週報系統讀取職事表資料說明.md）之後的修改。
 * 一律由真正入口叫下去（buildBulletinModel_／loadWeekForWebApp_／initializeAllSheets_），不直接叫內部函式：
 *
 *   1. 每週標題改讀 ServiceDates.Title；程序範本留空＝自動跟標題（標題改了、清空了都跟），人手揀過就不跟。
 *   2. 「不是人」的顯示字一律當空白：不印、不帶入獻花、不算「與職事表不同」，不記警告。
 *   3. 合堂那一週清空的格＝未排定；沒有名字的行印不印由 Config DUTY_PRINT_EMPTY_ROWS 決定（預設不印），
 *      Word、草稿預覽頁、電郵內文一致；填寫介面與待填清單照樣有那一行。
 *   4. 沒有 PersonID 的名字按名字找尊稱。
 *   5. 初始化工作表：系統以前寫入的程序範本清空一次（人手揀過的保留），只做一次。
 *
 * 執行方式：node tests/rosterread82.test.js
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

const D = '2027-11-14';        // 第 2 個主日（不是聖餐週）
const D_NEXT = '2027-11-21';

const POSTS = [
  { PostID: 'PREACHER', PostName_TC: '講員', SlotCount: 1, Frequency: 'WEEKLY', AutoGenerate: false, DisplayOrder: 20, Active: true, EmptyDisplay: 'PENDING' },
  { PostID: 'USHER', PostName_TC: '司事', SlotCount: 2, Frequency: 'WEEKLY', AutoGenerate: true, DisplayOrder: 30, Active: true, EmptyDisplay: 'PENDING' },
  { PostID: 'FLOWER', PostName_TC: '獻花', SlotCount: 1, Frequency: 'WEEKLY', AutoGenerate: false, DisplayOrder: 40, Active: true, EmptyDisplay: 'PENDING' },
  { PostID: 'WORSHIP', PostName_TC: '領詩', SlotCount: 1, Frequency: 'WEEKLY', AutoGenerate: true, DisplayOrder: 50, Active: true, EmptyDisplay: 'PENDING' }
];

function assignment(iso, postId, slot, personId, name, ruleFlags) {
  return {
    QuarterID: QUARTER_ID, VersionNo: 3, ServiceDate: iso, PostID: postId, SlotIndex: slot,
    PersonID: personId || '', PersonNameSnapshot: name || '', AssignSource: 'AUTO', Locked: false,
    RuleFlags: ruleFlags || ''
  };
}

/** 這一週：講員是「（待填）」、司事兩格在職事表清空了（合堂）、獻花是「待確認」、領詩這一週不設。 */
function combinedWeekAssignments() {
  return [
    assignment(D, 'PREACHER', 1, '', '（待填）', 'HARD_NO_AUTO_PREACHER'),
    assignment(D, 'USHER', 1, '', '', ''),
    assignment(D, 'USHER', 2, '', '', ''),
    assignment(D, 'FLOWER', 1, '', '待確認', ''),
    assignment(D, 'WORSHIP', 1, '', '特殊主日', 'HARD_SPECIAL_SUNDAY_SKIP'),
    // 下一個主日：外請講員（沒有 PersonID）、司事是臨時幫手（沒有 PersonID，但名字在 PersonDisplay）
    assignment(D_NEXT, 'PREACHER', 1, '', '黃外請牧師', ''),
    assignment(D_NEXT, 'USHER', 1, '', '臨時甲', '')
  ];
}

function makeEnv(o) {
  const opts = o || {};
  return makeFillEnv({
    withGrid: false,
    rosterPosts: POSTS,
    rosterAssignments: opts.assignments || combinedWeekAssignments(),
    weekTitles: opts.weekTitles,
    config: opts.config,
    weekRows: opts.weekRows,
    ui: opts.ui,
    extraStubs: opts.extraStubs
  });
}

function rowOf(env, iso) {
  return env.sandbox.readSheet_('BulletinWeeks').filter(function (r) {
    return env.sandbox.formatIsoDate_(env.sandbox.normalizeDate_(r.SERVICE_DATE)) === iso;
  })[0];
}

function labels(rows) { return (rows || []).map(function (r) { return r.label; }); }

// =====================================================================
// 1. 每週標題與程序範本
// =====================================================================

console.log('\n每週標題與程序範本（選項 B）');

test('每週標題「三堂聯合崇拜」→ 特別主日、TPL_COMBINED；BulletinWeeks 一格都不寫', function () {
  const env = makeEnv({ weekTitles: { [D]: '三堂聯合崇拜' } });
  const model = env.sandbox.buildBulletinModel_(D);
  assert.strictEqual(model.special.title, '三堂聯合崇拜');
  assert.strictEqual(model.templateId, 'TPL_COMBINED');
  assert.strictEqual(String(rowOf(env, D).PROGRAM_TEMPLATE_ID || ''), '');
  const loaded = env.sandbox.loadWeekForWebApp_(D);
  assert.strictEqual(loaded.readOnly.templateAuto, 'TPL_COMBINED', '填寫介面提示「目前自動值」');
  assert.strictEqual(loaded.options.programTemplateIds[0], '', '下拉第一項＝留空（自動）');
  assert.ok(loaded.options.programTemplateIds.indexOf('TPL_COMBINED') > 0);
});

test('同一行：標題改為浸禮 → 浸禮範本；標題改回空白 → 預設範本（沒有人手揀過就一直跟）', function () {
  const baptism = makeEnv({ weekTitles: { [D]: '浸禮主日' } }).sandbox.buildBulletinModel_(D);
  assert.strictEqual(baptism.templateId, 'TPL_COMBINED_BAPTISM');
  assert.strictEqual(baptism.isBaptismSunday, true);
  const cleared = makeEnv({ weekTitles: {} }).sandbox.buildBulletinModel_(D);
  assert.strictEqual(cleared.special, null);
  assert.strictEqual(cleared.templateId, 'TPL_NORMAL');
  assert.strictEqual(cleared.isBaptismSunday, false);
});

test('人手揀過（PROGRAM_TEMPLATE_ID 有值）→ 不跟標題；揀回留空（儲存 \'\'）→ 恢復跟標題', function () {
  const weekRows = [
    { SERVICE_DATE: '2027-11-07', QUARTER_ID: QUARTER_ID, WEEK_OF_MONTH: 1, STATUS: 'DRAFT' },
    { SERVICE_DATE: D, QUARTER_ID: QUARTER_ID, WEEK_OF_MONTH: 2, STATUS: 'DRAFT', PROGRAM_TEMPLATE_ID: 'TPL_NORMAL' },
    { SERVICE_DATE: D_NEXT, QUARTER_ID: QUARTER_ID, WEEK_OF_MONTH: 3, STATUS: 'DRAFT' }
  ];
  const env = makeEnv({ weekTitles: { [D]: '三堂聯合崇拜' }, weekRows: weekRows });
  const manual = env.sandbox.buildBulletinModel_(D);
  assert.strictEqual(manual.templateId, 'TPL_NORMAL');
  assert.strictEqual(manual.templateAuto, 'TPL_COMBINED');

  const loaded = env.sandbox.loadWeekForWebApp_(D);
  const patch = { PROGRAM_TEMPLATE_ID: '' };
  const saved = env.sandbox.saveWeekFromWebApp_({
    isoDate: D, lastSavedAt: loaded.lastSavedAt, payloadVersion: 2, week: patch,
    baseWeek: env.sandbox.baseWeekFor_(loaded.week, patch)
  });
  assert.notStrictEqual(saved && saved.message && saved.message.type, 'error', JSON.stringify(saved && saved.message));
  assert.strictEqual(String(rowOf(env, D).PROGRAM_TEMPLATE_ID || ''), '');
  assert.strictEqual(env.sandbox.buildBulletinModel_(D).templateId, 'TPL_COMBINED', '揀回留空之後跟標題');
});

// =====================================================================
// 2. 顯示字、合堂清空的格、印不印
// =====================================================================

console.log('\n顯示字當空白、合堂清空的格、空白行印不印');

test('「（待填）」「待確認」「特殊主日」不當人名；清空的格＝未排定；不記警告；獻花不帶入「待確認」', function () {
  const env = makeEnv({});
  const model = env.sandbox.buildBulletinModel_(D);
  const page1 = model.dutyBoxPage1;
  const preacher = page1.filter(function (r) { return r.label === '講員'; })[0];
  const usher = page1.filter(function (r) { return r.label === '司事'; })[0];
  assert.ok(preacher && usher, '填寫介面要見到講員、司事兩行：' + JSON.stringify(labels(page1)));
  assert.strictEqual(preacher.text, '');
  assert.strictEqual(preacher.isPending, true);
  assert.strictEqual(usher.text, '');
  assert.strictEqual(usher.isPending, true);
  assert.strictEqual(labels(page1).indexOf('領詩'), -1, 'RuleFlags HARD_SPECIAL_SUNDAY_SKIP＝這一週不設，整行不出現');
  assert.strictEqual(model.flowers.thisWeek, '', '獻花不可以帶入「待確認」');
  assert.strictEqual(model.flowerRoster.thisWeek, '');
  // 主席 P9001 在這個環境沒有 PersonDisplay 行（那一個 NO_PERSON_DISPLAY 是正常的），其餘一個都不可以有。
  const bad = model.warnings.filter(function (w) {
    return /PLACEHOLDER|PERSON_|NO_PERSON_DISPLAY|OVERRIDE_NAME/.test(String(w.code)) && w.personId !== 'P9001';
  });
  assert.strictEqual(bad.length, 0, JSON.stringify(bad));
  const missingPosts = model.missing.map(function (m) { return m.field; });
  assert.ok(missingPosts.indexOf('POST:PREACHER') !== -1, '未排定照樣列入待填清單：' + JSON.stringify(missingPosts));
  assert.ok(missingPosts.indexOf('POST:USHER') !== -1);
});

test('DUTY_PRINT_EMPTY_ROWS 預設 FALSE：Word、草稿預覽頁、電郵內文都不印沒有名字的行；填寫介面照樣有', function () {
  const env = makeEnv({});
  const sb = env.sandbox;
  const model = sb.buildBulletinModel_(D);
  assert.strictEqual(model.dutyPrintEmptyRows, false);

  const ctx = sb.buildRenderContext_(model, {});
  const dutyValues = Object.keys(ctx.values).filter(function (k) { return /^DUTY_\d+$/.test(k); })
    .map(function (k) { return ctx.values[k]; }).filter(function (v) { return v; });
  assert.ok(dutyValues.length > 0, '至少有主席那一行');
  assert.ok(dutyValues.every(function (v) { return !/^(講員|司事)：/.test(v); }), JSON.stringify(dutyValues));
  const listLabels = (ctx.lists.DUTY || []).map(function (r) { return r.LABEL; });
  assert.strictEqual(listLabels.indexOf('司事'), -1, JSON.stringify(listLabels));

  const preview = sb.buildPreviewData_(model, { notice: '' });
  const dutySection = preview.sections.filter(function (s) { return s.title === '本週事奉'; })[0];
  assert.ok(dutySection.rows.every(function (r) { return r[0] !== '司事' && r[0] !== '講員'; }), JSON.stringify(dutySection.rows));

  const html = sb.buildBulletinEmailHtml_(model, { includeMissingList: true });
  const text = sb.buildBulletinEmailPlainText_(model, { includeMissingList: true });
  assert.strictEqual(text.indexOf('司事：（待填）'), -1, '電郵內文與 Word 一致');
  assert.ok(text.indexOf('【尚未填寫的欄位】') !== -1 && /司事/.test(text.split('【尚未填寫的欄位】')[1]), '待填清單照樣列出');
  assert.strictEqual(/司事<\/td><td[^>]*>（待填）/.test(html), false);

  const loaded = sb.loadWeekForWebApp_(D);
  assert.ok(labels(loaded.readOnly.dutyBoxPage1).indexOf('司事') !== -1, '填寫介面一律顯示全部崗位');
});

test('真正入口：草稿預覽頁（buildPreviewPage_）與選單「預覽週報郵件內容」都不印沒有名字的司事行', function () {
  const dialogs = [];
  const env = makeEnv({
    ui: {
      prompt: function () { return { getSelectedButton: function () { return 'OK'; }, getResponseText: function () { return D; } }; },
      showModalDialog: function (output, title) { dialogs.push({ html: output.__html, title: title }); }
    },
    extraStubs: {
      HtmlService: {
        createHtmlOutput: function (html) {
          return { __html: String(html), setWidth: function () { return this; }, setHeight: function () { return this; },
            setTitle: function () { return this; }, addMetaTag: function () { return this; } };
        },
        createTemplateFromFile: function () { return { evaluate: function () { return { setWidth: function () { return this; }, setHeight: function () { return this; } }; } }; }
      }
    }
  });
  const page = env.sandbox.buildPreviewPage_(D, {});
  assert.strictEqual(page.ok, true);
  const thisWeek = page.html.split('本週事奉')[1].split('上週')[0];
  assert.strictEqual(thisWeek.indexOf('司事'), -1, '預覽頁本週事奉不印司事：' + thisWeek.slice(0, 400));
  assert.ok(thisWeek.indexOf('主席') !== -1, '有名字的照印');

  env.sandbox.menuPreviewBulletinEmail_();
  assert.strictEqual(dialogs.length, 1, '應該彈出郵件預覽');
  const mailThisWeek = dialogs[0].html.split('本週事奉')[1].split('上週')[0];
  assert.strictEqual(mailThisWeek.indexOf('司事'), -1, '郵件本週事奉不印司事');
});

test('DUTY_PRINT_EMPTY_ROWS=TRUE：照印崗位名、名字留空', function () {
  const env = makeEnv({ config: { DUTY_PRINT_EMPTY_ROWS: 'TRUE' } });
  const model = env.sandbox.buildBulletinModel_(D);
  assert.strictEqual(model.dutyPrintEmptyRows, true);
  const ctx = env.sandbox.buildRenderContext_(model, {});
  const dutyValues = Object.keys(ctx.values).filter(function (k) { return /^DUTY_\d+$/.test(k); })
    .map(function (k) { return ctx.values[k]; });
  assert.ok(dutyValues.indexOf('司事：') !== -1, JSON.stringify(dutyValues));
});

test('舊覆寫記下的職事表值是「（待填）」，職事表現在仍然是「（待填）」→ 不算衝突（不是「與職事表不同」）', function () {
  const env = makeEnv({});
  env.sandbox.writeSheet_('DutyOverride', [{
    SERVICE_DATE: env.sandbox.normalizeDate_(D), POST_ID: 'PREACHER', SLOT_INDEX: 1, OVERRIDE_NAME: '林牧師',
    ROSTER_VALUE_AT_OVERRIDE: '（待填）', ROSTER_VERSION_AT_OVERRIDE: 3, OVERRIDE_AT: new Date(), OVERRIDE_BY: 'x',
    REASON: '', ACTIVE: true, NOTES: ''
  }]);
  const model = env.sandbox.buildBulletinModel_(D);
  assert.strictEqual(model.rosterDiff.conflictCount, 0, JSON.stringify(model.rosterDiff.rows));
  const preacher = model.dutyBoxPage1.filter(function (r) { return r.label === '講員'; })[0];
  assert.strictEqual(preacher.text.indexOf('林牧師'), 0, '覆寫照印');
});

// =====================================================================
// 3. 沒有 PersonID 的名字
// =====================================================================

console.log('\n沒有 PersonID 的名字');

test('下週事奉：外請講員照印名字；臨時幫手名字在 PersonDisplay → 按名字套尊稱（第 3 頁不加弟兄姊妹、職稱照加）', function () {
  const env = makeEnv({});
  env.sandbox.writeSheet_('PersonDisplay', [
    { PERSON_ID: 'P-TEMP', NAME_TC: '臨時甲', HONORIFIC: '姊妹', DISPLAY_OVERRIDE: '', EFFECTIVE_FROM: '', EFFECTIVE_TO: '', ACTIVE: true, NOTES: '' },
    { PERSON_ID: 'P-EXT', NAME_TC: '黃外請', HONORIFIC: '牧師', DISPLAY_OVERRIDE: '', EFFECTIVE_FROM: '', EFFECTIVE_TO: '', ACTIVE: true, NOTES: '' }
  ]);
  const model = env.sandbox.buildBulletinModel_(D);
  const next = model.nextWeekDuty;
  const preacher = next.filter(function (r) { return r.label === '講員'; })[0];
  const usher = next.filter(function (r) { return r.label === '司事'; })[0];
  assert.strictEqual(preacher.text, '黃外請牧師', '名字已經連職稱，對不上 PersonDisplay 的「黃外請」就照印，不會變成「黃外請牧師牧師」');
  assert.strictEqual(usher.text, '臨時甲', '第 3 頁不加弟兄姊妹');
  const page1Model = makeEnv({
    assignments: [assignment(D, 'USHER', 1, '', '臨時甲', '')]
  });
  page1Model.sandbox.writeSheet_('PersonDisplay', [
    { PERSON_ID: 'P-TEMP', NAME_TC: '臨時甲', HONORIFIC: '姊妹', DISPLAY_OVERRIDE: '', EFFECTIVE_FROM: '', EFFECTIVE_TO: '', ACTIVE: true, NOTES: '' }
  ]);
  const page1 = page1Model.sandbox.buildBulletinModel_(D).dutyBoxPage1.filter(function (r) { return r.label === '司事'; })[0];
  assert.strictEqual(page1.text, '臨時甲姊妹', '第 1 頁按名字套尊稱');
});

// =====================================================================
// 4. 初始化工作表：程序範本一次性清理
// =====================================================================

console.log('\n初始化工作表：程序範本改為跟每週標題');

test('系統寫入的範本清空、人手揀過的保留；AuditLog 逐格記；只做一次', function () {
  const weekRows = [
    { SERVICE_DATE: '2027-11-07', QUARTER_ID: QUARTER_ID, WEEK_OF_MONTH: 1, STATUS: 'DRAFT', PROGRAM_TEMPLATE_ID: 'TPL_NORMAL' },
    { SERVICE_DATE: D, QUARTER_ID: QUARTER_ID, WEEK_OF_MONTH: 2, STATUS: 'DRAFT', PROGRAM_TEMPLATE_ID: 'TPL_COMBINED' },
    { SERVICE_DATE: D_NEXT, QUARTER_ID: QUARTER_ID, WEEK_OF_MONTH: 3, STATUS: 'DRAFT', PROGRAM_TEMPLATE_ID: 'TPL_ANNIVERSARY' },
    { SERVICE_DATE: '2027-11-28', QUARTER_ID: QUARTER_ID, WEEK_OF_MONTH: 4, STATUS: 'DRAFT', PROGRAM_TEMPLATE_ID: 'TPL_ANNIVERSARY' },
    // 已封存：不動
    { SERVICE_DATE: '2027-12-05', QUARTER_ID: '2027T4', WEEK_OF_MONTH: 1, STATUS: 'SENT', PROGRAM_TEMPLATE_ID: 'TPL_COMBINED', ARCHIVED: true }
  ];
  const env = makeEnv({ weekRows: weekRows, weekTitles: { [D]: '浸禮主日' } });
  env.sandbox.writeSheet_('AuditLog', [
    { TIMESTAMP: new Date(), ACTOR: 'x', ACTION: 'INFER_PROGRAM_TEMPLATE', SHEET_NAME: 'BulletinWeeks', ROW_KEY: D,
      FIELD: 'PROGRAM_TEMPLATE_ID', OLD_VALUE: '', NEW_VALUE: 'TPL_COMBINED', NOTES: '' },
    // 幹事在填寫介面揀了堂慶範本：保留
    { TIMESTAMP: new Date(), ACTOR: 'x', ACTION: 'WEBAPP_SAVE_WEEK', SHEET_NAME: 'BulletinWeeks', ROW_KEY: D_NEXT,
      FIELD: 'PROGRAM_TEMPLATE_ID', OLD_VALUE: 'TPL_NORMAL', NEW_VALUE: 'TPL_ANNIVERSARY', NOTES: '' },
    // 已停用的季度填寫表人手揀過：保留
    { TIMESTAMP: new Date(), ACTOR: 'x', ACTION: 'FILL_GRID_EDIT', SHEET_NAME: 'BulletinWeeks', ROW_KEY: '2027-11-28',
      FIELD: 'PROGRAM_TEMPLATE_ID', OLD_VALUE: '', NEW_VALUE: 'TPL_ANNIVERSARY', NOTES: '' },
    // 揀過之後又被系統改（例如重設）：以最後一次為準 → 清空
    { TIMESTAMP: new Date(), ACTOR: 'x', ACTION: 'WEBAPP_SAVE_WEEK', SHEET_NAME: 'BulletinWeeks', ROW_KEY: '2027-11-07',
      FIELD: 'PROGRAM_TEMPLATE_ID', OLD_VALUE: '', NEW_VALUE: 'TPL_COMBINED', NOTES: '' },
    { TIMESTAMP: new Date(), ACTOR: 'x', ACTION: 'WEEK_RESET', SHEET_NAME: 'BulletinWeeks', ROW_KEY: '2027-11-07',
      FIELD: 'PROGRAM_TEMPLATE_ID', OLD_VALUE: 'TPL_COMBINED', NEW_VALUE: 'TPL_NORMAL', NOTES: '' }
  ]);

  const summary = env.sandbox.initializeAllSheets_();
  assert.strictEqual(summary.programTemplateAuto.ran, true);
  assert.strictEqual(summary.programTemplateAuto.cleared, 2);
  assert.strictEqual(summary.programTemplateAuto.kept, 3, '填寫介面揀過、季度填寫表揀過、已封存');
  assert.strictEqual(rowOf(env, '2027-11-28').PROGRAM_TEMPLATE_ID, 'TPL_ANNIVERSARY', '季度填寫表揀過的保留');
  assert.strictEqual(rowOf(env, '2027-12-05').PROGRAM_TEMPLATE_ID, 'TPL_COMBINED', '已封存不動');
  // 清空之後實際用的範本有變的主日逐一列出；2027-11-07 清空前後都是 TPL_NORMAL，不列。
  const changed = summary.programTemplateAuto.changed.map(function (c) { return c.isoDate + ':' + c.from + '>' + c.to; });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(changed)), [D + ':TPL_COMBINED>TPL_COMBINED_BAPTISM']);
  assert.ok(summary.programTemplateAuto.lines.some(function (l) { return l.indexOf(D + '：TPL_COMBINED → TPL_COMBINED_BAPTISM') !== -1; }),
    JSON.stringify(summary.programTemplateAuto.lines));
  assert.strictEqual(String(rowOf(env, '2027-11-07').PROGRAM_TEMPLATE_ID || ''), '');
  assert.strictEqual(String(rowOf(env, D).PROGRAM_TEMPLATE_ID || ''), '');
  assert.strictEqual(rowOf(env, D_NEXT).PROGRAM_TEMPLATE_ID, 'TPL_ANNIVERSARY', '人手揀過的保留');
  assert.strictEqual(env.sandbox.buildBulletinModel_(D).templateId, 'TPL_COMBINED_BAPTISM', '清空之後跟標題');

  const audit = env.sandbox.readSheet_('AuditLog');
  const clears = audit.filter(function (a) { return a.ACTION === 'PROGRAM_TEMPLATE_AUTO_CLEAR'; });
  assert.strictEqual(clears.length, 2);
  assert.ok(clears.some(function (a) { return a.OLD_VALUE === 'TPL_COMBINED'; }), '舊值記在 AuditLog，可以照抄回去');
  assert.strictEqual(audit.filter(function (a) { return a.ACTION === 'PROGRAM_TEMPLATE_AUTO_MIGRATED'; }).length, 1);

  // 再按一次初始化：不再做（之後還原舊版本帶回來的範本 ID 不應該再被清走）
  env.sandbox.setCellValueTextSafe_(env.sheets.BulletinWeeks, env.sandbox.COLUMNS.BULLETIN_WEEKS, 4, 'PROGRAM_TEMPLATE_ID', 'TPL_NORMAL');
  const again = env.sandbox.initializeAllSheets_();
  assert.strictEqual(again.programTemplateAuto.ran, false);
  assert.strictEqual(rowOf(env, D).PROGRAM_TEMPLATE_ID, 'TPL_NORMAL', '第二次一格都不動');
});

test('初始化工作表：Config 舊鍵 ROSTER_SHEET_SPECIAL_SUNDAYS 有值 → 不自動刪，列出請人手確認', function () {
  const env = makeEnv({ config: { ROSTER_SHEET_SPECIAL_SUNDAYS: 'SpecialSundays' } });
  const summary = env.sandbox.initializeAllSheets_();
  assert.ok(summary.deprecatedConfigWarnings.some(function (w) { return w.indexOf('ROSTER_SHEET_SPECIAL_SUNDAYS') !== -1; }),
    JSON.stringify(summary.deprecatedConfigWarnings));
  assert.strictEqual(env.sandbox.getConfig_('ROSTER_SHEET_SPECIAL_SUNDAYS', ''), 'SpecialSundays', '有值就不刪');
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
