#!/usr/bin/env node
/**
 * tests/dutyslots.test.js
 *
 * 2026-10-28：src/DutySlots.gs（事奉項目多過 Word 範本格數時的警告）與英文類型關鍵詞的預設值。
 *
 *   Ivan 10-28 的決定：
 *   - 第 3 項選「兩樣都做」：現在加警告；範本加格留待示範後一次過改。
 *   - 第 4 項選「Config 加英文關鍵詞」：配對分大小寫，英文大小寫各列一次。
 *
 *   ⚠️ bug class 5：除了純函式，每一處用到的地方都由真正入口叫一次——
 *   `apiLoadWeek`（填寫介面）、`generateBulletinDocx_`（產生 Word）、
 *   `inspectTemplatePlaceholders_`（檢查範本佔位符）、`buildBulletinModel_`（範本推斷）。
 *
 * 執行方式：node tests/dutyslots.test.js
 * 離開碼：0＝全部通過　1＝有測試失敗
 */

'use strict';

const assert = require('assert');
const { makeFillEnv, QUARTER_ID } = require('./helpers/fillEnv');
const { makeFakeDriveApp, makeFakeUtilities, buildFakeDocx } = require('./helpers/fakeDrive');
const fx = require('./fixtures/docxXml');

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

const D = '2027-11-07';
const D_NEXT = '2027-11-14';

const POSTS = [
  { PostID: 'PREACHER', PostName_TC: '講員', SlotCount: 1, Frequency: 'WEEKLY', AutoGenerate: false, DisplayOrder: 20, Active: true, EmptyDisplay: 'PENDING' },
  { PostID: 'WORSHIP', PostName_TC: '領詩', SlotCount: 1, Frequency: 'WEEKLY', AutoGenerate: true, DisplayOrder: 50, Active: true, EmptyDisplay: 'PENDING' },
  { PostID: 'PIANO', PostName_TC: '司琴', SlotCount: 1, Frequency: 'WEEKLY', AutoGenerate: true, DisplayOrder: 60, Active: true, EmptyDisplay: 'PENDING' }
];

function assignment(iso, postId, name) {
  return {
    QuarterID: QUARTER_ID, VersionNo: 3, ServiceDate: iso, PostID: postId, SlotIndex: 1,
    PersonID: '', PersonNameSnapshot: name, AssignSource: 'AUTO', Locked: false, RuleFlags: ''
  };
}

/** 一段只有指定佔位符的範本 XML，每個佔位符一段。 */
function templateXml(names) {
  return fx.documentXml(names.map(function (n) { return fx.para(fx.run('{{' + n + '}}')); }).join(''));
}

function dutyNames(prefix, count) {
  const out = [];
  for (let i = 1; i <= count; i++) out.push(prefix + (i < 10 ? '0' + i : String(i)));
  return out;
}

/**
 * 這一週：主席、講員、領詩、司琴（4 行）。下一個主日：主席、講員有名字，領詩、司琴空白
 * （Config DUTY_PRINT_EMPTY_ROWS 預設 FALSE＝不印），所以要印 2 行。
 */
function makeEnv(o) {
  const opts = o || {};
  const files = {};
  if (opts.templateXml) files.TPL_FILE = buildFakeDocx(opts.templateXml);
  const drive = makeFakeDriveApp({ files: files, folders: { OUT_FOLDER: {} } });
  const utilities = makeFakeUtilities();
  utilities.base64Encode = function (bytes) { return 'B64:' + String(bytes).length; };
  const env = makeFillEnv({
    withGrid: false,
    rosterPosts: POSTS,
    rosterAssignments: [
      assignment(D, 'PREACHER', '黃牧師'), assignment(D, 'WORSHIP', '李領詩'), assignment(D, 'PIANO', '張司琴'),
      assignment(D_NEXT, 'PREACHER', '何牧師')
    ],
    weekTitles: opts.weekTitles,
    weekRows: [
      { SERVICE_DATE: D, QUARTER_ID: QUARTER_ID, WEEK_OF_MONTH: 1, STATUS: 'DRAFT' },
      { SERVICE_DATE: D_NEXT, QUARTER_ID: QUARTER_ID, WEEK_OF_MONTH: 2, STATUS: 'DRAFT' }
    ],
    config: Object.assign({
      TEMPLATE_FILE_ID_NORMAL: opts.noTemplate ? '' : (opts.templateFileId || 'TPL_FILE'),
      BULLETIN_OUTPUT_FOLDER_ID: 'OUT_FOLDER'
    }, opts.config || {}),
    driveApp: drive.DriveApp,
    driveAdvanced: drive.Drive,
    utilitiesZip: utilities
  });
  return env;
}

/** 警告代碼（轉成本 realm 的陣列：sandbox 的陣列 deepStrictEqual 對不上原型）。 */
function codes(warnings) {
  return Array.from(warnings || []).map(function (w) { return String(w.code); });
}
function find(warnings, code) {
  return (warnings || []).filter(function (w) { return w.code === code; })[0];
}

// =====================================================================
console.log('\n純函式');
// =====================================================================

test('templateDutySlotsFromXml_：{{DUTY_nn}}、{{#IF:DUTY_nn}} 都算一格；NEXT_DUTY 分開數；清單寫法另外標明', function () {
  const sb = makeEnv({ noTemplate: true }).sandbox;
  const xml = sb.prepareXmlForPlaceholders_(templateXml(['DUTY_01', 'DUTY_02', '#IF:DUTY_03', 'DUTY_03', 'NEXT_DUTY_01', 'SERMON_TITLE'])).xml;
  const slots = JSON.parse(JSON.stringify(sb.templateDutySlotsFromXml_(xml)));
  assert.deepStrictEqual(slots, { page1: [1, 2, 3], page3: [1], page1List: false, page3List: false });

  const listXml = sb.prepareXmlForPlaceholders_(templateXml(['#EACH:DUTY', 'DUTY.LABEL', '#EACHP:NEXT_DUTY'])).xml;
  const listSlots = sb.templateDutySlotsFromXml_(listXml);
  assert.strictEqual(listSlots.page1List, true);
  assert.strictEqual(listSlots.page3List, true);
});

test('templateDutySlotsFromXml_：被 Word 拆成幾個 run 的佔位符，經 prepareXmlForPlaceholders_ 之後照樣數到', function () {
  const sb = makeEnv({ noTemplate: true }).sandbox;
  const raw = fx.documentXml(fx.para(fx.run('{{DUT') + fx.run('Y_0') + fx.run('7}}')));
  const slots = sb.templateDutySlotsFromXml_(sb.prepareXmlForPlaceholders_(raw).xml);
  assert.deepStrictEqual(Array.from(slots.page1), [7]);
});

test('findDroppedDutyRows_／formatDutySlotRange_：第 i 行印在第 i 格，沒有那一格就列出', function () {
  const sb = makeEnv({ noTemplate: true }).sandbox;
  const rows = [{ label: 'A', text: '甲' }, { label: 'B', text: '乙' }, { label: 'C', text: '丙' }];
  assert.deepStrictEqual(JSON.parse(JSON.stringify(sb.findDroppedDutyRows_([1, 2], rows))), [{ index: 3, label: 'C', text: '丙' }]);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(sb.findDroppedDutyRows_([1, 3], rows))), [{ index: 2, label: 'B', text: '乙' }]);
  assert.strictEqual(sb.findDroppedDutyRows_([1, 2, 3, 4], rows).length, 0);
  assert.strictEqual(sb.formatDutySlotRange_([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), '01–10');
  assert.strictEqual(sb.formatDutySlotRange_([1, 2, 3, 5, 11, 12]), '01–03、05、11–12');
  assert.strictEqual(sb.formatDutySlotRange_([]), '（沒有）');
});

test('buildDutySlotWarnings_：只數要印的行（沒有名字、Config 設定不印的行不算）；夠格就沒有警告', function () {
  const sb = makeEnv({ noTemplate: true }).sandbox;
  const model = {
    dutyPrintEmptyRows: false,
    nextIsoDate: D_NEXT,
    dutyBoxPage1: [{ label: '主席', text: '甲' }, { label: '翻譯', text: '' }, { label: '司琴', text: '乙' }],
    nextWeekDuty: [{ label: '主席', text: '丙' }]
  };
  // 兩格：要印的只有主席、司琴兩行 → 夠
  assert.strictEqual(sb.buildDutySlotWarnings_({ page1: [1, 2], page3: [1] }, model, '平常主日').length, 0);
  // 一格 → 司琴漏印
  const w = sb.buildDutySlotWarnings_({ page1: [1], page3: [1] }, model, '平常主日');
  assert.deepStrictEqual(codes(w), ['DUTY_SLOT_OVERFLOW']);
  assert.ok(w[0].message.indexOf('有 2 項要印') !== -1 && w[0].message.indexOf('只有 1 格（01）') !== -1, w[0].message);
  assert.ok(w[0].message.indexOf('司琴：乙') !== -1, w[0].message);
  assert.ok(w[0].message.indexOf('{{') === -1, '警告文字不可以有樣板標籤符號');
  // Config 設定照印空行 → 翻譯那一行也要印，兩格不夠
  const printAll = Object.assign({}, model, { dutyPrintEmptyRows: true });
  const w2 = sb.buildDutySlotWarnings_({ page1: [1, 2], page3: [1] }, printAll, '平常主日');
  assert.deepStrictEqual(codes(w2), ['DUTY_SLOT_OVERFLOW']);
  assert.ok(w2[0].message.indexOf('司琴：乙') !== -1, w2[0].message);
  // 清單寫法 → 不核對
  assert.strictEqual(sb.buildDutySlotWarnings_({ page1: [], page3: [], page1List: true, page3List: true }, model, 'X').length, 0);
});

test('buildDutySlotWarnings_：範本完全沒有那一區的格 → 講明全部不會印出（不可以當作沒事）', function () {
  const sb = makeEnv({ noTemplate: true }).sandbox;
  const model = { dutyPrintEmptyRows: false, nextIsoDate: D_NEXT, dutyBoxPage1: [{ label: '主席', text: '甲' }], nextWeekDuty: [{ label: '主席', text: '丙' }] };
  const w = sb.buildDutySlotWarnings_({ page1: [], page3: [1] }, model, '平常主日');
  assert.deepStrictEqual(codes(w), ['DUTY_SLOT_OVERFLOW']);
  assert.ok(w[0].message.indexOf('沒有這一區的格') !== -1 && w[0].message.indexOf('全部不會印出') !== -1, w[0].message);
});

// =====================================================================
console.log('\n真正入口');
// =====================================================================

test('apiLoadWeek（填寫介面）：範本第 1 頁只有 2 格、要印 4 項 → 警告列出領詩、司琴；第 3 頁夠格不報', function () {
  const env = makeEnv({ templateXml: templateXml(dutyNames('DUTY_', 2).concat(dutyNames('NEXT_DUTY_', 2))) });
  const resp = env.sandbox.apiLoadWeek(D);
  assert.strictEqual(resp.ok, true, JSON.stringify(resp.error));
  const w = find(resp.data.warnings, 'DUTY_SLOT_OVERFLOW');
  assert.ok(w, JSON.stringify(codes(resp.data.warnings)));
  assert.ok(w.message.indexOf('有 4 項要印') !== -1 && w.message.indexOf('只有 2 格（01–02）') !== -1, w.message);
  assert.ok(w.message.indexOf('領詩：李領詩') !== -1 && w.message.indexOf('司琴：張司琴') !== -1, w.message);
  assert.ok(w.message.indexOf('主席') === -1, '印得到的不列出：' + w.message);
  assert.ok(!find(resp.data.warnings, 'NEXT_DUTY_SLOT_OVERFLOW'), '下週只印 2 行（空白的兩行不印），2 格夠');
});

test('apiLoadWeek：第 3 頁只有 1 格、下週要印 2 項 → NEXT_DUTY_SLOT_OVERFLOW，講明是哪一個主日', function () {
  const env = makeEnv({ templateXml: templateXml(dutyNames('DUTY_', 4).concat(['NEXT_DUTY_01'])) });
  const resp = env.sandbox.apiLoadWeek(D);
  assert.strictEqual(resp.ok, true, JSON.stringify(resp.error));
  assert.ok(!find(resp.data.warnings, 'DUTY_SLOT_OVERFLOW'), '第 1 頁 4 格夠');
  const w = find(resp.data.warnings, 'NEXT_DUTY_SLOT_OVERFLOW');
  assert.ok(w, JSON.stringify(codes(resp.data.warnings)));
  assert.ok(w.message.indexOf(D_NEXT) !== -1 && w.message.indexOf('講員：何牧師') !== -1, w.message);
});

test('apiLoadWeek：範本讀不到 → DUTY_SLOT_CHECK_FAILED（不可以當作沒有漏印），載入照常成功', function () {
  const env = makeEnv({ templateFileId: 'NO_SUCH_FILE' });
  const resp = env.sandbox.apiLoadWeek(D);
  assert.strictEqual(resp.ok, true, JSON.stringify(resp.error));
  const w = find(resp.data.warnings, 'DUTY_SLOT_CHECK_FAILED');
  assert.ok(w && w.message.indexOf('未能核對') !== -1, JSON.stringify(resp.data.warnings));
});

test('apiLoadWeek：範本未設定 → 不核對、不報（產生 Word 時另有「未設定範本」）', function () {
  const env = makeEnv({ noTemplate: true });
  const resp = env.sandbox.apiLoadWeek(D);
  assert.strictEqual(resp.ok, true, JSON.stringify(resp.error));
  const slotCodes = codes(resp.data.warnings).filter(function (c) { return /SLOT/.test(c); });
  assert.deepStrictEqual(slotCodes, []);
});

test('generateBulletinDocx_（產生 Word）：用正在渲染的範本核對，警告與填寫介面同一句', function () {
  const env = makeEnv({ templateXml: templateXml(dutyNames('DUTY_', 3).concat(dutyNames('NEXT_DUTY_', 2))) });
  const result = env.sandbox.generateBulletinDocx_(D);
  assert.strictEqual(result.ok, true, JSON.stringify(result));
  const w = find(result.warnings, 'DUTY_SLOT_OVERFLOW');
  assert.ok(w && w.message.indexOf('司琴：張司琴') !== -1, JSON.stringify(codes(result.warnings)));
  const loaded = find(env.sandbox.apiLoadWeek(D).data.warnings, 'DUTY_SLOT_OVERFLOW');
  assert.strictEqual(loaded.message, w.message, '兩處同一套純函式，文字一定相同');
});

test('generateBulletinDocx_：格數夠 → 沒有事奉格警告', function () {
  const env = makeEnv({ templateXml: templateXml(dutyNames('DUTY_', 10).concat(dutyNames('NEXT_DUTY_', 11))) });
  const result = env.sandbox.generateBulletinDocx_(D);
  assert.strictEqual(result.ok, true, JSON.stringify(result));
  assert.deepStrictEqual(codes(result.warnings).filter(function (c) { return /SLOT/.test(c); }), []);
});

test('檢查範本佔位符（inspectTemplatePlaceholders_ → Diagnostics 行）：列出事奉框格數', function () {
  const env = makeEnv({ templateXml: templateXml(dutyNames('DUTY_', 10).concat(dutyNames('NEXT_DUTY_', 11))) });
  const report = env.sandbox.inspectTemplatePlaceholders_();
  const lines = env.sandbox.buildTemplateInspectionLines_(report).join('\n');
  assert.ok(lines.indexOf('事奉框格數：第 1 頁 10 格（01–10）；第 3 頁下週事奉 11 格（01–11）') !== -1, lines);
});

test('預覽本週週報資料（buildBulletinModelReportLines_ ＋ dutySlotCheckForModel_）：漏印的行標明，警告區段列出', function () {
  const env = makeEnv({ templateXml: templateXml(dutyNames('DUTY_', 3).concat(dutyNames('NEXT_DUTY_', 2))) });
  const sb = env.sandbox;
  const model = sb.buildBulletinModel_(D);
  const check = sb.dutySlotCheckForModel_(model);
  const text = sb.buildBulletinModelReportLines_(model, check).join('\n');
  assert.ok(/司琴：張司琴.*（範本沒有格，漏印）/.test(text), text);
  assert.ok(!/領詩：李領詩.*漏印/.test(text), '第 3 格印得到');
  assert.ok(text.indexOf('[DUTY_SLOT_OVERFLOW]') !== -1, text);
  assert.ok(text.indexOf('Word 範本：平常主日　事奉框格數：第 1 頁 3 格') !== -1, text);
  // 舊呼叫方（沒有 slotCheck）照舊
  assert.ok(sb.buildBulletinModelReportLines_(model).join('\n').indexOf('漏印') === -1);
});

// =====================================================================
console.log('\n英文類型關鍵詞（2026-10-28：Config 加英文）');
// =====================================================================

test('Config 預設值：浸禮／堂慶／合堂三組都有英文（大小寫各一）', function () {
  const sb = makeEnv({ noTemplate: true }).sandbox;
  const cfg = JSON.parse(JSON.stringify(sb.readProgramTemplateConfig_()));
  assert.deepStrictEqual(cfg.baptismKeywords, ['浸禮', 'Baptism', 'baptism']);
  assert.deepStrictEqual(cfg.anniversaryKeywords, ['堂慶', '週年', 'Anniversary', 'anniversary']);
  assert.deepStrictEqual(cfg.combinedKeywords, ['合堂', '聯合', 'Combined', 'combined']);
});

test('buildBulletinModel_（真正入口）：每週標題「Baptism Service」→ 浸禮合堂範本；「Anniversary Service」→ 堂慶；「Combined Service」→ 三堂聯合', function () {
  const cases = [
    ['Baptism Service', 'TPL_COMBINED_BAPTISM'],
    ['Combined Baptism Service', 'TPL_COMBINED_BAPTISM'],
    ['33rd Anniversary', 'TPL_ANNIVERSARY'],
    ['Combined Service', 'TPL_COMBINED'],
    ['combined service', 'TPL_COMBINED'],
    ['Mothers Day', 'TPL_NORMAL']
  ];
  cases.forEach(function (c) {
    const env = makeEnv({ noTemplate: true, weekTitles: { [D]: c[0] } });
    assert.strictEqual(env.sandbox.buildBulletinModel_(D).templateId, c[1], c[0]);
  });
});

test('Config 已存的舊值（只有中文）照舊生效：初始化工作表不會蓋掉，英文要在 Config 人手加', function () {
  const env = makeEnv({ noTemplate: true, weekTitles: { [D]: 'Baptism Service' }, config: { TEMPLATE_KEYWORDS_BAPTISM: '浸禮' } });
  assert.strictEqual(env.sandbox.buildBulletinModel_(D).templateId, 'TPL_NORMAL');
});

console.log('\n通過 ' + pass + ' 項，失敗 ' + fail + ' 項。');
process.exit(fail === 0 ? 0 : 1);
