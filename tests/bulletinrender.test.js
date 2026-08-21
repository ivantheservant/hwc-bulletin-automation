#!/usr/bin/env node
/**
 * tests/bulletinrender.test.js
 *
 * src/BulletinRender.gs（資料模型 → 佔位符）的回歸測試，以及由真正入口
 * （`generateBulletinDocx_()`）叫下去的案例——後者用假的 `DriveApp`／
 * `Utilities` 替身，不需要真的 .docx 檔案。
 *
 * 執行方式：node tests/bulletinrender.test.js
 * 離開碼：0＝全部通過　1＝有測試失敗
 */

'use strict';

const assert = require('assert');
const { loadAllSrcFilesInOrder } = require('./helpers/loadGas');
const { makeFakeSheet, makeFakeSpreadsheet } = require('./helpers/fakeSpreadsheet');
const { makeFakeDriveApp, makeFakeUtilities, buildFakeDocx } = require('./helpers/fakeDrive');
const fx = require('./fixtures/docxXml');

const GAS_STUBS = {
  Utilities: { formatDate: function () { return '2027-11-07 09:00'; } },
  Session: {
    getScriptTimeZone: function () { return 'Pacific/Auckland'; },
    getActiveUser: function () { return { getEmail: function () { return 'tester@x.com'; } }; }
  },
  SpreadsheetApp: {},
  CacheService: {},
  HtmlService: {}
};

const sandbox = loadAllSrcFilesInOrder(GAS_STUBS);
const {
  buildRenderContext_, buildCallCombined_, buildRenderLists_,
  supportedValuePlaceholderNames_, supportedListPlaceholders_,
  buildOutputFileName_, programFullWidthFlagKey_, interleavedListsConfig_,
  financeReportPreviousMonth_, buildFinanceTitle_,
  inspectTemplatePlaceholders_, buildTemplateInspectionLines_
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

/** 由 1 補到兩位數，供組出 DUTY_01..NN／NEXT_DUTY_01..NN 用。 */
function numberedKeys_(prefix, max) {
  const out = [];
  for (let i = 1; i <= max; i++) {
    const s = String(i);
    out.push(prefix + (s.length < 2 ? '0' + s : s));
  }
  return out;
}

/** prompt7 §5.1 列明的全部單值佔位符，加上 prompt9 §1.2 新增的編號事奉佔位符。 */
const REQUIRED_VALUE_KEYS = [
  // 封面與標題
  'SERVICE_DATE_COVER', 'PAGE_TITLE', 'SPECIAL_TYPE',
  // 崇拜程序（非表格部分）
  'PRELUDE', 'CALL_TEXT', 'CALL_REF', 'CALL_COMBINED', 'RECITATION',
  'HYMN_PRAISE', 'CHOIR_LABEL', 'CHOIR_TITLE', 'SCRIPTURE_REF',
  'SERMON_TITLE', 'RESPONSE_HYMN',
  // 人數表
  'ATTENDANCE_HEADING', 'ATTENDANCE_DATE',
  'ATT_ENG_WORSHIP', 'ATT_CANE_WORSHIP', 'ATT_CANN_WORSHIP', 'ATT_MAN_WORSHIP',
  'ATT_ENG_PRAYER', 'ATT_CANE_PRAYER', 'ATT_CANN_PRAYER', 'ATT_MAN_PRAYER',
  'ATT_ENG_CHILD', 'ATT_CANE_CHILD', 'ATT_CANN_CHILD', 'ATT_MAN_CHILD',
  'CANTONESE_SUBCOLUMN_LABEL',
  // 事奉與獻花
  'NEXT_WEEK_HEADING', 'NEXT_WEEK_DATE', 'FLOWER_THIS_WEEK', 'FLOWER_NEXT_WEEK',
  // 其他
  'PRAYER_BLOCK_HEADING', 'WEEKLY_BIBLE_READING', 'CHURCH_NAME',
  'ROSTER_VERSION', 'GENERATED_AT',
  // 財務報告（prompt9 §1.6 補漏）
  'FINANCE_TITLE', 'FINANCE_NOTE', 'FINANCE_BALANCE'
].concat(numberedKeys_('DUTY_', 20)).concat(numberedKeys_('NEXT_DUTY_', 20));

function sampleModel(overrides) {
  return Object.assign({
    isoDate: '2027-11-07',
    special: null,
    templateId: 'TPL_NORMAL',
    rosterVersionUsed: 12,
    recitation: '主禱文',
    header: {
      pageTitle: '崇拜程序', coverDate: '2027 年 11 月 07 日',
      attendanceHeading: '上週主日崇拜人數', attendanceDate: '31/10/2027',
      nextWeekHeading: '下週主日崇拜聚會事奉肢體', nextWeekDate: '14/11/2027'
    },
    weekFields: {
      PRELUDE: '安靜', CALL_TEXT: '你們要讚美耶和華', CALL_REF: '詩篇 150:1',
      HYMN_PRAISE: '奇異恩典', CHOIR_LABEL: '詩班', CHOIR_TITLE: '主愛長闊高深',
      SCRIPTURE_REF: '羅馬書 3:21-26', SERMON_TITLE: '因信稱義', RESPONSE_HYMN: '我心靈得安寧',
      WEEKLY_BIBLE_READING: '',
      ATT_ENG_WORSHIP: '120', ATT_CANE_WORSHIP: '85', ATT_CANN_WORSHIP: '--', ATT_MAN_WORSHIP: '40',
      ATT_ENG_PRAYER: '15', ATT_CANE_PRAYER: '20', ATT_CANN_PRAYER: '--', ATT_MAN_PRAYER: '8',
      ATT_ENG_CHILD: '30', ATT_CANE_CHILD: '12', ATT_CANN_CHILD: '--', ATT_MAN_CHILD: '5',
      FINANCE_NOTE: '結餘已扣除下月預算', FINANCE_BALANCE: '$12,345.67'
    },
    program: [
      { itemName: '序樂', content: '安靜', posture: '眾 立', fullWidth: false },
      { itemName: '家事報告', content: '', posture: '眾 坐', fullWidth: false },
      { itemName: '祈禱會', content: '', posture: '', fullWidth: true }
    ],
    dutyBoxPage1: [{ label: '主席', text: '陳大文弟兄' }, { label: '司事', text: '李小明姊妹' }],
    nextWeekDuty: [{ label: '主席', text: '王美美' }],
    flowers: { thisWeek: '假甲', nextWeek: '假乙' },
    announcements: [{ seqNo: 10, text: '第一則' }, { seqNo: 20, text: '第二則' }],
    prayerBlock: { heading: '代禱事項', items: [{ seqNo: 10, text: '為宣教士禱告' }] },
    fellowships: [{ fellowshipName: '彼得團', meetingDate: '7/11 星期日', meetingTime: '4:30pm', content: '講道分享' }],
    finance: [{ rowLabel: '奉獻', specialOverseas: '100', hardship: '200', col3: '300', col4: '400' }],
    missing: [],
    warnings: []
  }, overrides || {});
}

// =====================================================================
// 1. buildRenderContext_() 的 values 覆蓋 §5.1 全部鍵
// =====================================================================

test('1. buildRenderContext_()：§5.1 列明的全部單值佔位符都有提供', function () {
  const context = buildRenderContext_(sampleModel(), { churchName: '聖道堂', generatedAt: '2027-11-07 09:00' });
  const missing = REQUIRED_VALUE_KEYS.filter(function (k) {
    return !Object.prototype.hasOwnProperty.call(context.values, k);
  });
  assertArrayEqual(missing, [], '這些 prompt7 §5.1 要求的佔位符沒有提供');
});

test('1b. buildRenderContext_()：沒有多出 §5.1 以外的單值佔位符（除了 SERVICE_DATE）', function () {
  const context = buildRenderContext_(sampleModel(), {});
  // SERVICE_DATE 是檔名樣式 OUTPUT_FILE_NAME_PATTERN 要用的，順帶也給範本用。
  const allowed = REQUIRED_VALUE_KEYS.concat(['SERVICE_DATE']);
  const extra = Object.keys(context.values).filter(function (k) { return allowed.indexOf(k) === -1; });
  assertArrayEqual(extra, [], '多出來的佔位符要先寫進 docs/佔位符對照表.md 才可以加');
});

test('1c. buildRenderContext_()：值取自資料模型的正確位置', function () {
  const context = buildRenderContext_(sampleModel(), { churchName: '聖道堂', cantoneseSubColumnLabel: '主堂', generatedAt: 'T' });
  assert.strictEqual(context.values.SERMON_TITLE, '因信稱義');
  assert.strictEqual(context.values.SERVICE_DATE_COVER, '2027 年 11 月 07 日');
  assert.strictEqual(context.values.PAGE_TITLE, '崇拜程序');
  assert.strictEqual(context.values.ATTENDANCE_DATE, '31/10/2027');
  assert.strictEqual(context.values.ATT_CANN_WORSHIP, '--', '人數欄的 -- 要原樣保留');
  assert.strictEqual(context.values.FLOWER_THIS_WEEK, '假甲');
  assert.strictEqual(context.values.PRAYER_BLOCK_HEADING, '代禱事項');
  assert.strictEqual(context.values.RECITATION, '主禱文');
  assert.strictEqual(context.values.ROSTER_VERSION, '12');
  assert.strictEqual(context.values.CHURCH_NAME, '聖道堂');
  assert.strictEqual(context.values.CANTONESE_SUBCOLUMN_LABEL, '主堂');
  assert.strictEqual(context.values.FINANCE_NOTE, '結餘已扣除下月預算');
  assert.strictEqual(context.values.FINANCE_BALANCE, '$12,345.67');
  assert.strictEqual(context.values.FINANCE_TITLE, '聖道堂綜合收支財務報告-2027年 10月份',
    '主日是 2027-11-07，財務報告照慣例滯後一個月，應該印上一個月（10 月）');
});

test('1d. buildRenderContext_()：全部值都是字串（範本替換只接受字串）', function () {
  const context = buildRenderContext_(sampleModel(), {});
  Object.keys(context.values).forEach(function (k) {
    assert.strictEqual(typeof context.values[k], 'string', k + ' 應該是字串，實際是 ' + typeof context.values[k]);
  });
});

test('1e. buildRenderContext_()：空模型不會拋錯，全部值是空字串', function () {
  let context;
  assert.doesNotThrow(function () { context = buildRenderContext_({}, {}); });
  REQUIRED_VALUE_KEYS.forEach(function (k) {
    assert.strictEqual(context.values[k], '', k + ' 在空模型下應該是空字串');
  });
});

test('1f. buildRenderContext_()：SPECIAL_TYPE 取自特別主日標題', function () {
  const context = buildRenderContext_(sampleModel({ special: { title: '浸禮主日', type: 'BAPTISM' } }), {});
  assert.strictEqual(context.values.SPECIAL_TYPE, '浸禮主日');
});

// =====================================================================
// 2. PROGRAM 清單的 IS_FULL_WIDTH 旗標
// =====================================================================

test('2. PROGRAM 清單的 IS_FULL_WIDTH 旗標正確（祈禱會為 true）', function () {
  const lists = buildRenderLists_(sampleModel());
  const flag = programFullWidthFlagKey_();
  assertArrayEqual(lists.PROGRAM.map(function (r) { return r[flag]; }), [false, false, true]);
  assert.strictEqual(lists.PROGRAM[2].CONTENT, '', '全寬列的內容欄');
});

test('2b. PROGRAM 清單保留原本的次序（交錯的次序不可以被打亂）', function () {
  const lists = buildRenderLists_(sampleModel());
  assertArrayEqual(lists.PROGRAM.map(function (r) { return r.ITEM; }), ['序樂', '家事報告', '祈禱會']);
});

test('2c. 全寬列的 POSTURE 是空的（資料模型已經清空，這裡照抄）', function () {
  const lists = buildRenderLists_(sampleModel());
  assert.strictEqual(lists.PROGRAM[2].POSTURE, '');
});

test('2d. interleavedListsConfig_()：PROGRAM 走交錯展開，旗標欄位名稱一致', function () {
  const config = interleavedListsConfig_();
  assert.strictEqual(config.PROGRAM, programFullWidthFlagKey_());
  assert.strictEqual(Object.keys(config).length, 1, '目前只有程序表需要交錯展開');
});

test('2e. buildRenderLists_()：七個清單全部提供，欄位名稱符合 §5.2', function () {
  const lists = buildRenderLists_(sampleModel());
  assertArrayEqual(Object.keys(lists).sort(),
    ['ANNOUNCEMENT', 'DUTY', 'FELLOWSHIP', 'FINANCE', 'NEXT_DUTY', 'PRAYER', 'PROGRAM']);
  assertArrayEqual(Object.keys(lists.DUTY[0]).sort(), ['LABEL', 'NAMES']);
  assertArrayEqual(Object.keys(lists.ANNOUNCEMENT[0]).sort(), ['NO', 'TEXT']);
  assertArrayEqual(Object.keys(lists.FELLOWSHIP[0]).sort(), ['CONTENT', 'DATE', 'NAME', 'TIME']);
  assertArrayEqual(Object.keys(lists.FINANCE[0]).sort(), ['COL1', 'COL2', 'COL3', 'COL4', 'LABEL']);
});

test('2f. buildRenderLists_()：ANNOUNCEMENT／PRAYER 的 NO 由 1 開始重新編號（不是用 SEQ_NO）', function () {
  const lists = buildRenderLists_(sampleModel());
  assertArrayEqual(lists.ANNOUNCEMENT.map(function (r) { return r.NO; }), ['1', '2'],
    'SEQ_NO 是 10／20，但印在週報上要是 1／2');
  assertArrayEqual(lists.PRAYER.map(function (r) { return r.NO; }), ['1']);
});

test('2g. buildRenderLists_()：DUTY／NEXT_DUTY 取事奉框已經算好的顯示文字（含尊稱）', function () {
  const lists = buildRenderLists_(sampleModel());
  assert.strictEqual(lists.DUTY[0].NAMES, '陳大文弟兄');
  assert.strictEqual(lists.NEXT_DUTY[0].NAMES, '王美美');
});

// =====================================================================
// 3. 空清單
// =====================================================================

test('3. 空的 ANNOUNCEMENT／PRAYER／FELLOWSHIP／FINANCE 清單 → 空陣列，不拋錯', function () {
  const lists = buildRenderLists_(sampleModel({
    announcements: [], prayerBlock: { heading: '代禱事項', items: [] },
    fellowships: [], finance: []
  }));
  assert.strictEqual(lists.ANNOUNCEMENT.length, 0);
  assert.strictEqual(lists.PRAYER.length, 0);
  assert.strictEqual(lists.FELLOWSHIP.length, 0);
  assert.strictEqual(lists.FINANCE.length, 0);
});

test('3b. 完全沒有這些欄位的模型 → 全部清單是空陣列', function () {
  const lists = buildRenderLists_({});
  Object.keys(lists).forEach(function (k) {
    assertArrayEqual(lists[k], [], k + ' 應該是空陣列');
  });
});

// =====================================================================
// 4. CALL_COMBINED 三種情況
// =====================================================================

test('4. CALL_COMBINED：兩者皆有 → 依格式合成', function () {
  assert.strictEqual(buildCallCombined_('你們要讚美耶和華', '詩篇 150:1'), '你們要讚美耶和華（詩篇 150:1）');
});

test('4b. CALL_COMBINED：只有出處 → 只顯示出處，不留下孤零零的括號', function () {
  assert.strictEqual(buildCallCombined_('', '詩篇 150:1'), '詩篇 150:1');
  assert.strictEqual(buildCallCombined_('   ', '詩篇 150:1'), '詩篇 150:1');
});

test('4c. CALL_COMBINED：只有經文 → 只顯示經文', function () {
  assert.strictEqual(buildCallCombined_('你們要讚美耶和華', ''), '你們要讚美耶和華');
});

test('4d. CALL_COMBINED：兩者皆空 → 空字串', function () {
  assert.strictEqual(buildCallCombined_('', ''), '');
  assert.strictEqual(buildCallCombined_(null, undefined), '');
});

test('4e. CALL_COMBINED：格式可以由 Config 改（不是寫死全形括號）', function () {
  assert.strictEqual(
    buildCallCombined_('經文', '出處', '{{CALL_REF}}：{{CALL_TEXT}}'),
    '出處：經文'
  );
});

// =====================================================================
// 佔位符對帳清單
// =====================================================================

test('supportedValuePlaceholderNames_()：跟 buildRenderContext_() 的鍵完全一致（單一真相）', function () {
  const names = supportedValuePlaceholderNames_();
  const contextKeys = Object.keys(buildRenderContext_(sampleModel(), {})).length;
  assertArrayEqual(names, Object.keys(buildRenderContext_({}, {}).values).sort());
  assert.ok(contextKeys > 0);
});

test('supportedListPlaceholders_()：七個清單，欄位名稱與 buildRenderLists_() 一致', function () {
  const supported = supportedListPlaceholders_();
  const lists = buildRenderLists_(sampleModel());
  assert.strictEqual(supported.length, 7);
  supported.forEach(function (entry) {
    assert.ok(lists[entry.list], '清單 ' + entry.list + ' 應該存在於 buildRenderLists_() 的輸出');
    if (lists[entry.list].length === 0) return;
    const actualFields = Object.keys(lists[entry.list][0])
      .filter(function (f) { return f !== programFullWidthFlagKey_(); }).sort();
    assertArrayEqual(actualFields, entry.fields.slice().sort(), entry.list + ' 的欄位不一致');
  });
});

// =====================================================================
// buildOutputFileName_
// =====================================================================

test('buildOutputFileName_：{{SERVICE_DATE}} 被換成主日日期', function () {
  assert.strictEqual(
    buildOutputFileName_('2027-11-07', '{{SERVICE_DATE}}_粵語堂週報.docx'),
    '2027-11-07_粵語堂週報.docx'
  );
});

test('buildOutputFileName_：樣式漏了副檔名時自動補上 .docx', function () {
  assert.strictEqual(buildOutputFileName_('2027-11-07', '{{SERVICE_DATE}}_週報'), '2027-11-07_週報.docx');
});

test('buildOutputFileName_：樣式是空的時候仍然產生得出檔名', function () {
  assert.strictEqual(buildOutputFileName_('2027-11-07', ''), '2027-11-07.docx');
});

// =====================================================================
// 5. 由真正入口叫下去（假的 Drive／Utilities 替身）
// =====================================================================

const FAKE_ROSTER_ID = 'FAKE_ROSTER_ID_FOR_RENDER_TEST';
const FAKE_TEMPLATE_ID = 'FAKE_TEMPLATE_ID_NORMAL';
const FAKE_FOLDER_ID = 'FAKE_OUTPUT_FOLDER';

function ownSheetFor(sb, sheetId, rows) {
  const def = sb.COLUMNS[sheetId];
  return makeFakeSheet(def.headers, def.keys, rows || []);
}

function rosterSheetFor(sb, defKey, rows) {
  const keys = Object.keys(sb.ROSTER_TABLE_DEFS_[defKey].columns);
  return makeFakeSheet(keys, keys, rows || []);
}

/**
 * 造一個貼近真實的程序表範本。
 *
 * ⚠️ 全寬列範本放的是 `{{PROGRAM.ITEM}}`，不是 `{{PROGRAM.CONTENT}}`——
 * 全寬列（例如「祈禱會」）真正要印的字是**項目名稱**，內容欄通常是空的
 * （seed 的 TPL_NORMAL 裡「祈禱會」的 CONTENT_SOURCE 就是 `BLANK`）。
 * 這一點在 docs/佔位符對照表.md 有寫明，做範本的人要照住放。
 */
function realisticProgramTable() {
  return fx.table([
    fx.row([
      fx.cell(fx.para(fx.run('{{#EACH:PROGRAM}}{{PROGRAM.ITEM}}'))),
      fx.cell(fx.para(fx.run('{{PROGRAM.CONTENT}}'))),
      fx.cell(fx.para(fx.run('{{PROGRAM.POSTURE}}')))
    ]),
    fx.row([fx.cell(fx.para(fx.run('{{#EACH:PROGRAM_FW}}{{PROGRAM.ITEM}}{{PROGRAM.CONTENT}}')))])
  ]);
}

/** 造一份「範本 .docx」的 XML——封面佔位符 ＋ 程序表 ＋ 家事報告表。 */
function templateDocumentXml() {
  return fx.documentXml(
    fx.splitPlaceholderParagraph(['{{', 'SERMON', '_TITLE}}'])
    + fx.para(fx.run('{{SERVICE_DATE_COVER}}'))
    + fx.para(fx.run('{{CHURCH_NAME}}'))
    + realisticProgramTable()
    + fx.table([fx.row([
      fx.cell(fx.para(fx.run('{{#EACH:ANNOUNCEMENT}}{{ANNOUNCEMENT.NO}}'))),
      fx.cell(fx.para(fx.run('{{ANNOUNCEMENT.TEXT}}')))
    ])])
    + fx.table([fx.row([fx.cell(fx.para(fx.run('{{#EACH:DUTY}}{{DUTY.LABEL}}'))), fx.cell(fx.para(fx.run('{{DUTY.NAMES}}')))])])
  );
}

function makeEnv(o) {
  o = o || {};
  const isoDate = o.isoDate || '2027-11-07';
  const boot = loadAllSrcFilesInOrder(GAS_STUBS);

  const cfg = {};
  boot.DEFAULTS.forEach(function (d) { cfg[d.key] = d.value; });
  cfg.ROSTER_SPREADSHEET_ID = FAKE_ROSTER_ID;
  cfg.TEMPLATE_FILE_ID_NORMAL = o.templateConfigured === false ? '' : FAKE_TEMPLATE_ID;
  cfg.BULLETIN_OUTPUT_FOLDER_ID = FAKE_FOLDER_ID;
  Object.assign(cfg, o.config || {});

  const ownSheets = {};
  Object.keys(boot.SHEETS).forEach(function (id) { ownSheets[boot.SHEETS[id]] = ownSheetFor(boot, id, []); });
  ownSheets.Config = ownSheetFor(boot, 'CONFIG', Object.keys(cfg).map(function (k) {
    return { KEY: k, VALUE: cfg[k], NOTE: '', EDITABLE: true };
  }));
  ownSheets.BulletinWeeks = ownSheetFor(boot, 'BULLETIN_WEEKS', [{
    SERVICE_DATE: isoDate, QUARTER_ID: '2027T4', WEEK_OF_MONTH: 1, STATUS: 'DRAFT',
    PROGRAM_TEMPLATE_ID: 'TPL_NORMAL', SERMON_TITLE: '因信稱義', PAGE_TITLE: '崇拜程序'
  }]);
  ownSheets.PostDisplay = ownSheetFor(boot, 'POST_DISPLAY', boot.seedPostDisplayRows_());
  ownSheets.MergeGroups = ownSheetFor(boot, 'MERGE_GROUPS', boot.seedMergeGroupsRows_());
  ownSheets.ProgramTemplates = ownSheetFor(boot, 'PROGRAM_TEMPLATES', boot.seedProgramTemplatesRows_());
  ownSheets.Announcements = ownSheetFor(boot, 'ANNOUNCEMENTS', [
    { SERVICE_DATE: isoDate, SEQ_NO: 10, TEXT: '第一則家事報告', ACTIVE: true },
    { SERVICE_DATE: isoDate, SEQ_NO: 20, TEXT: '第二則家事報告', ACTIVE: true }
  ]);
  ownSheets.PersonDisplay = ownSheetFor(boot, 'PERSON_DISPLAY', [
    { PERSON_ID: 'P9001', NAME_TC: '陳大文', HONORIFIC: '弟兄', DISPLAY_OVERRIDE: '', EFFECTIVE_FROM: '', EFFECTIVE_TO: '', ACTIVE: true, NOTES: '' }
  ]);

  const rosterSheets = {
    RosterAssignments: rosterSheetFor(boot, 'ASSIGNMENTS', [
      { QuarterID: '2027T4', VersionNo: 3, ServiceDate: isoDate, PostID: 'CHAIR', SlotIndex: 1, PersonID: 'P9001', PersonNameSnapshot: '陳大文', AssignSource: 'AUTO', Locked: false }
    ]),
    RosterVersions: rosterSheetFor(boot, 'VERSIONS', [{ QuarterID: '2027T4', VersionNo: 3 }]),
    Quarters: rosterSheetFor(boot, 'QUARTERS', [{ QuarterID: '2027T4', Stage: 'OFFICIAL_SENT' }]),
    ServiceDates: rosterSheetFor(boot, 'SERVICE_DATES', [
      { ServiceDateID: 'SD1', QuarterID: '2027T4', ServiceDate: isoDate, WeekIndex: 1, IsFirstSundayOfMonth: isoDate === '2027-11-07', ServiceType: '主日崇拜', SpecialID: '' }
    ]),
    SpecialSundays: rosterSheetFor(boot, 'SPECIAL_SUNDAYS', []),
    NameMapping: rosterSheetFor(boot, 'NAME_MAPPING', [{ PersonID: 'P9001', NameTC: '陳大文', Active: true }]),
    Posts: rosterSheetFor(boot, 'POSTS', [
      { PostID: 'CHAIR', PostName_TC: '主席', SlotCount: 1, Frequency: 'WEEKLY', AutoGenerate: true, DisplayOrder: 10, Active: true, EmptyDisplay: 'PENDING' }
    ])
  };

  const drive = makeFakeDriveApp({
    files: { [FAKE_TEMPLATE_ID]: buildFakeDocx(o.templateXml || templateDocumentXml()) },
    folders: { [FAKE_FOLDER_ID]: {} }
  });

  const FakeSpreadsheetApp = {
    getActiveSpreadsheet: function () { return makeFakeSpreadsheet(ownSheets); },
    openById: function (id) {
      if (id !== FAKE_ROSTER_ID) throw new Error('openById: 未預期的 id ' + id);
      return makeFakeSpreadsheet(rosterSheets);
    }
  };

  return {
    sandbox: loadAllSrcFilesInOrder(Object.assign({}, GAS_STUBS, {
      SpreadsheetApp: FakeSpreadsheetApp,
      DriveApp: drive.DriveApp,
      Utilities: makeFakeUtilities()
    })),
    drive: drive
  };
}

/**
 * 由假的 .docx blob 取回 word/document.xml 的文字內容。
 * ⚠️ 壓縮之後 `__entries` 裝的是**blob 物件**（不是 {name, blob} 包裝），
 * 所以要用 getName() 而不是 .name。
 */
function documentXmlOf(blob) {
  const hit = blob.__entries.filter(function (e) { return e.getName() === 'word/document.xml'; });
  assert.strictEqual(hit.length, 1, '壓縮結果應該剛好有一個 word/document.xml');
  return hit[0].__text;
}

function visibleText(xml) {
  const out = [];
  const pattern = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g;
  let m;
  while ((m = pattern.exec(xml)) !== null) out.push(m[1]);
  return out.join('').split('&#123;').join('{').split('&#125;').join('}').split('&amp;').join('&');
}

test('5. 真正入口 generateBulletinDocx_()：產生成功，佔位符全部被填', function () {
  const env = makeEnv({});
  const result = env.sandbox.generateBulletinDocx_('2027-11-07');

  assert.strictEqual(result.ok, true, JSON.stringify(result));
  const xml = documentXmlOf(result.blob);
  assert.strictEqual(xml.indexOf('{{'), -1, '成品不可以殘留任何佔位符：' + xml.slice(0, 300));

  const text = visibleText(xml);
  assert.ok(text.indexOf('因信稱義') !== -1, '講題要被填進去（而且是被拆散的 run，證明合併有生效）');
  assert.ok(text.indexOf('第一則家事報告') !== -1 && text.indexOf('第二則家事報告') !== -1, '家事報告兩則都要展開');
  assert.ok(text.indexOf('陳大文弟兄') !== -1, '事奉名單要含尊稱');
});

test('5b. 真正入口：範本 ID 未設定 → notConfigured，訊息明確講「尚未設定 Word 範本」', function () {
  const env = makeEnv({ templateConfigured: false });
  const result = env.sandbox.generateBulletinDocx_('2027-11-07');

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.notConfigured, true);
  assert.strictEqual(result.reason, 'NO_TEMPLATE');
  assert.ok(result.message.indexOf('尚未設定 Word 範本') !== -1, result.message);
  assert.ok(result.message.indexOf('TEMPLATE_FILE_ID_NORMAL') !== -1, '要講明是哪一個設定鍵：' + result.message);
});

test('5c. 真正入口：程序表交錯展開（祈禱會是全寬列，排在家事報告之後）', function () {
  // ⚠️ 一定要用第 2 或第 4 個主日：seed 的 TPL_NORMAL 內，「祈禱會」那一行
  // 的 CONDITION 是 WEEK_IN:2,4，第 1 個主日根本不會出現這個全寬列。
  // 2027-11-14 是 11 月第 2 個主日。
  const env = makeEnv({ isoDate: '2027-11-14' });
  const result = env.sandbox.generateBulletinDocx_('2027-11-14');
  assert.strictEqual(result.ok, true, JSON.stringify(result));

  const text = visibleText(documentXmlOf(result.blob));
  const announceIndex = text.indexOf('家事報告');
  const prayerMeetingIndex = text.indexOf('祈禱會');
  assert.ok(announceIndex !== -1, '應該有家事報告那一行：' + text);
  assert.ok(prayerMeetingIndex !== -1, '第 2 個主日應該有祈禱會（全寬列）：' + text);
  assert.ok(prayerMeetingIndex > announceIndex, '祈禱會（全寬列）必須排在家事報告之後——這就是交錯展開的重點');

  // 全寬列真的走了全寬列範本：整份文件應該有一個只得一個儲存格的列。
  assert.ok(result.stats.expandedRows > 0);
});

test('5d. 真正入口：統計數字有回報（替換數、展開列數）', function () {
  const env = makeEnv({});
  const result = env.sandbox.generateBulletinDocx_('2027-11-07');
  assert.ok(result.stats.replacedCount > 0);
  assert.ok(result.stats.expandedRows > 0);
  assert.strictEqual(result.stats.lists.ANNOUNCEMENT, 2);
  assert.strictEqual(result.stats.lists.DUTY, 1);
});

test('5e. 真正入口 saveBulletinDocx_()：寫入輸出資料夾，回傳檔名與連結', function () {
  const env = makeEnv({});
  const result = env.sandbox.saveBulletinDocx_('2027-11-07');

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.file.fileName, '2027-11-07_粵語堂週報.docx');
  assert.ok(result.file.url.length > 0);
  assert.strictEqual(env.drive.listFolderFiles(FAKE_FOLDER_ID).length, 1);
});

test('5f. 真正入口：RENDER_BLOCK_IF_MISSING_FIELDS=TRUE 且有待填欄位 → 拒絕產生', function () {
  const env = makeEnv({ config: { RENDER_BLOCK_IF_MISSING_FIELDS: 'TRUE' } });
  const result = env.sandbox.generateBulletinDocx_('2027-11-07');
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'MISSING_FIELDS');
  assert.ok(result.message.indexOf('待填欄位') !== -1);
});

test('5g. 真正入口：TEMPLATE_MISSING_VALUE_MODE=KEEP 時，沒有提供的佔位符原樣保留', function () {
  const templateXml = fx.documentXml(fx.para(fx.run('{{NOT_A_REAL_PLACEHOLDER}}')));
  const env = makeEnv({ templateXml: templateXml, config: { TEMPLATE_MISSING_VALUE_MODE: 'KEEP' } });
  const result = env.sandbox.generateBulletinDocx_('2027-11-07');
  assert.strictEqual(result.ok, true);
  assert.ok(documentXmlOf(result.blob).indexOf('{{NOT_A_REAL_PLACEHOLDER}}') !== -1);
  assertArrayEqual(result.stats.missingKeys, ['NOT_A_REAL_PLACEHOLDER']);
});

test('5h. 真正入口 inspectTemplatePlaceholders_()：對帳出「範本用到但系統不提供」', function () {
  const templateXml = fx.documentXml(
    fx.para(fx.run('{{SERMON_TITLE}}')) + fx.para(fx.run('{{TYPO_PLACEHOLDER}}'))
  );
  const env = makeEnv({ templateXml: templateXml });
  const report = env.sandbox.inspectTemplatePlaceholders_();
  const normal = report.templates.filter(function (t) { return t.configKey === 'TEMPLATE_FILE_ID_NORMAL'; })[0];

  assert.strictEqual(normal.configured, true);
  assert.ok(normal.unknownValues.indexOf('TYPO_PLACEHOLDER') !== -1, '打錯字的佔位符要被抓出來');
  assert.ok(normal.usedValues.indexOf('SERMON_TITLE') !== -1);
  assert.ok(normal.unusedValues.indexOf('PAGE_TITLE') !== -1, '系統提供但範本沒有用到的也要列出來');
});

test('5i. 真正入口 inspectTemplatePlaceholders_()：未設定的範本回 configured=false，不拋錯', function () {
  const env = makeEnv({ templateConfigured: false });
  let report;
  assert.doesNotThrow(function () { report = env.sandbox.inspectTemplatePlaceholders_(); });
  report.templates.forEach(function (t) { assert.strictEqual(t.configured, false); });
  assert.ok(report.supportedValues.length > 0, '就算沒有範本，也要列得出系統提供哪些佔位符');
});

test('5j. 真正入口 inspectTemplatePlaceholders_()：偵測範本內被切斷的佔位符', function () {
  const templateXml = fx.documentXml(fx.para(
    fx.run('{{') + '<w:bookmarkStart w:id="1" w:name="x"/>' + fx.run('SERMON_TITLE}}')
  ));
  const env = makeEnv({ templateXml: templateXml });
  const report = env.sandbox.inspectTemplatePlaceholders_();
  const normal = report.templates.filter(function (t) { return t.configKey === 'TEMPLATE_FILE_ID_NORMAL'; })[0];
  assert.strictEqual(normal.broken.length, 1);
});

test('5k. renderBulletinAttachment_()：範本有設定時真的產生 .docx blob', function () {
  const env = makeEnv({});
  const model = env.sandbox.buildBulletinModel_('2027-11-07');
  const attachment = env.sandbox.renderBulletinAttachment_(model);
  assert.strictEqual(attachment.ok, true, JSON.stringify(attachment));
  assert.strictEqual(attachment.fileName, '2027-11-07_粵語堂週報.docx');
});

test('5l. renderBulletinAttachment_()：範本未設定時維持 NO_TEMPLATE（現有行為不變）', function () {
  const env = makeEnv({ templateConfigured: false });
  const model = env.sandbox.buildBulletinModel_('2027-11-07');
  const attachment = env.sandbox.renderBulletinAttachment_(model);
  assert.strictEqual(attachment.ok, false);
  assert.strictEqual(attachment.reason, 'NO_TEMPLATE');
});

test('5m. renderBulletinAttachment_()：產生過程出錯不會拋出去（郵件照樣寄得成）', function () {
  const env = makeEnv({ config: { TEMPLATE_FILE_ID_NORMAL: 'NONEXISTENT_FILE_ID' } });
  const model = env.sandbox.buildBulletinModel_('2027-11-07');
  let attachment;
  assert.doesNotThrow(function () { attachment = env.sandbox.renderBulletinAttachment_(model); });
  assert.strictEqual(attachment.ok, false);
  assert.strictEqual(attachment.reason, 'RENDER_FAILED');
});

test('5n. 真正入口：職事表未設定 → 明確講是職事表未設定，不是「沒有資料」', function () {
  const env = makeEnv({ config: { ROSTER_SPREADSHEET_ID: '' } });
  const result = env.sandbox.generateBulletinDocx_('2027-11-07');
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'ROSTER_NOT_CONFIGURED');
  assert.ok(result.message.indexOf('ROSTER_SPREADSHEET_ID') !== -1);
});

// =====================================================================
// 6. 財務報告佔位符：financeReportPreviousMonth_() / buildFinanceTitle_()
// =====================================================================

test('6. financeReportPreviousMonth_()：一般情況，上一個月同一年', function () {
  assertArrayEqual(financeReportPreviousMonth_('2027-11-07'), { year: 2027, month: 10 });
});

test('6b. financeReportPreviousMonth_()：跨年——1 月的上一個月是去年 12 月', function () {
  assertArrayEqual(financeReportPreviousMonth_('2027-01-03'), { year: 2026, month: 12 });
});

test('6c. financeReportPreviousMonth_()：格式不對回 null，不拋錯', function () {
  assert.strictEqual(financeReportPreviousMonth_(''), null);
  assert.strictEqual(financeReportPreviousMonth_(undefined), null);
  assert.strictEqual(financeReportPreviousMonth_('不是日期'), null);
});

test('6d. buildFinanceTitle_()：套用 Config 預設樣式，一般情況', function () {
  assert.strictEqual(
    buildFinanceTitle_('聖道堂綜合收支財務報告-{{YEAR}}年 {{MONTH}}月份', '2027-11-07'),
    '聖道堂綜合收支財務報告-2027年 10月份'
  );
});

test('6e. buildFinanceTitle_()：跨年情況套進樣式', function () {
  assert.strictEqual(
    buildFinanceTitle_('聖道堂綜合收支財務報告-{{YEAR}}年 {{MONTH}}月份', '2027-01-03'),
    '聖道堂綜合收支財務報告-2026年 12月份'
  );
});

test('6f. buildFinanceTitle_()：isoDate 格式不對 → 空字串，不拋錯', function () {
  assert.strictEqual(buildFinanceTitle_('聖道堂綜合收支財務報告-{{YEAR}}年 {{MONTH}}月份', ''), '');
});

// =====================================================================
// 7. #EACHP:（段落層清單標記）對帳——事故十九
// =====================================================================

test('7. inspectTemplatePlaceholders_()：#EACHP:ANNOUNCEMENT 對帳為「有提供」，不是缺失', function () {
  const templateXml = fx.documentXml(fx.para(fx.run('{{#EACHP:ANNOUNCEMENT}}{{ANNOUNCEMENT.TEXT}}')));
  const env = makeEnv({ templateXml: templateXml });
  const report = env.sandbox.inspectTemplatePlaceholders_();
  const normal = report.templates.filter(function (t) { return t.configKey === 'TEMPLATE_FILE_ID_NORMAL'; })[0];

  assert.ok(normal.usedLists.indexOf('ANNOUNCEMENT') !== -1, 'ANNOUNCEMENT 要被認出是範本用到的清單');
  assert.strictEqual(normal.unknownLists.indexOf('ANNOUNCEMENT'), -1, '不可以被誤報成系統不提供的清單');
});

test('7b. findPlaceholders_()：#EACHP: 分類為 EACHP，不是 SIMPLE（事故十九的根因）', function () {
  const list = sandbox.findPlaceholders_(fx.documentXml(fx.para(fx.run('{{#EACHP:ANNOUNCEMENT}}'))));
  assertArrayEqual(list, [{ name: 'ANNOUNCEMENT', type: 'EACHP', raw: '{{#EACHP:ANNOUNCEMENT}}' }]);
});

// =====================================================================
// 8. DUTY／NEXT_DUTY「系統提供但範本沒有用到」要標成正常
// =====================================================================

test('8. buildTemplateInspectionLines_()：DUTY／NEXT_DUTY 標成「（正常，範本改用編號佔位符）」', function () {
  const templateXml = fx.documentXml(fx.para(fx.run('{{SERMON_TITLE}}')));
  const env = makeEnv({ templateXml: templateXml });
  const report = env.sandbox.inspectTemplatePlaceholders_();
  const lines = env.sandbox.buildTemplateInspectionLines_(report);
  const text = lines.join('\n');

  assert.ok(text.indexOf('DUTY（正常，範本改用編號佔位符）') !== -1, text);
  assert.ok(text.indexOf('NEXT_DUTY（正常，範本改用編號佔位符）') !== -1, text);
});

test('8b. buildTemplateInspectionLines_()：非 DUTY／NEXT_DUTY 的沒用到清單不會被加註', function () {
  const templateXml = fx.documentXml(fx.para(fx.run('{{SERMON_TITLE}}')));
  const env = makeEnv({ templateXml: templateXml });
  const report = env.sandbox.inspectTemplatePlaceholders_();
  const lines = env.sandbox.buildTemplateInspectionLines_(report);
  const text = lines.join('\n');

  assert.ok(text.indexOf('PROGRAM（正常') === -1, 'PROGRAM 沒用到不是「正常」，不應該被加註：' + text);
  assert.ok(text.indexOf('　系統提供、但範本沒有用到的清單') !== -1);
});

// =====================================================================

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
